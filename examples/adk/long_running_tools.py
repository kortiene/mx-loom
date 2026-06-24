"""ADK ``LongRunningFunctionTool`` approval shim for the mx-loom tool fabric (T202 / #24).

Google ADK has a native *long-running tool* protocol that is a near-perfect match
for mx-agent's deferred ``awaiting_approval`` flow: a tool call can return a
**pending ticket**, the agent keeps reasoning / does other work, and the host
**resumes** the same tool call when the external result is ready. T201
(``mcp_toolset_agent.py``) already mounts the generated ``mx-loom-mcp`` server as a
generic ``MCPToolset`` where ``running`` / ``awaiting_approval`` are ordinary
envelopes the model resolves later with ``mx_await_result(handle)``. This module
adds the ADK-*native* mode for the two deferred, approval-bearing verbs:

    mx_delegate_tool   -> ADK LongRunningFunctionTool (canonical name preserved)
    mx_run_command     -> ADK LongRunningFunctionTool (canonical name preserved)

Production path (unchanged seam — no daemon client, no secrets in Python)::

    ADK LongRunningFunctionTool
      -> this helper (closures)
        -> ADK MCPToolset / MCP tool call (mx_delegate_tool / mx_run_command / mx_await_result)
          -> mx-loom-mcp --stdio
            -> MxSession / MxClient
              -> receiving mx-agent daemon (trust / policy / sandbox / approval)

What the shim does and — just as importantly — does **not** do:

- It **observes** approval state and **resumes** results. It NEVER approves,
  decides, or mutates trust/policy. A pending ticket is a handle to observe the
  daemon's later result, not a capability. Approval happens out-of-band through the
  operator surfaces (e.g. ``scripts/conformance/decide-approval.sh`` in the gated
  e2e), and the receiving daemon re-runs authorize at release.
- The model-facing tool set stays the canonical ``mx_*`` verbs only — no
  ``approval.decide`` / ``trust.*`` / ``policy.*`` / ``auth.*`` / ``device.*`` /
  ``daemon.*``. The shim adds no credential-bearing arg or metadata.
- The secret boundary (Boundary A) is the T201 ``safe_mx_mcp_env()``: provider
  keys, ``MATRIX_*`` / ``MX_AGENT_*``, ``*_TOKEN`` / ``*_API_KEY`` / ``*_SECRET`` /
  ``*_ACCESS_KEY``, ``GH_TOKEN``, and the audit DSN never reach the MCP child.

ADK import-path note (READ THIS): ``google-adk`` is **not** a dependency of this
repo and its exact import paths / long-running API can drift between versions. As
in ``mcp_toolset_agent.py``, every ADK import is **deferred into a factory** so this
module — and its pure, ADK-free *core* (:class:`MxLongRunningCore`) — can be
imported and exercised (see the ``__main__`` smoke at the bottom) without
``google-adk`` installed. Verify the following against your pinned ADK version
before trusting the live path (see ``examples/adk/README.md`` -> "Native
long-running mode (T202)"):

  * ``from google.adk.tools import LongRunningFunctionTool`` (import path).
  * ``LongRunningFunctionTool(func=...)`` wraps a sync **or** async function and
    derives the tool *name* from ``func.__name__`` and the *declaration* from the
    signature + docstring (so the canonical names below are preserved).
  * A parameter named ``tool_context`` is **injected** by ADK and **excluded** from
    the model-facing declaration (this is how we read the function-call id without
    exposing it as a model arg).
  * The function's initial return value is surfaced to the model as the pending
    function response; the host resumes by injecting a ``FunctionResponse`` with the
    SAME call id (see :func:`build_resume_content`).
  * ``LlmAgent.tools`` accepts individual MCP tool objects returned from
    ``MCPToolset.get_tools(...)`` alongside ``LongRunningFunctionTool`` wrappers
    (this is how we replace just the two deferred verbs without duplicate names —
    see :func:`mx_long_running_tool_bundle`). If your version cannot, the documented
    fallback is an ``MCPToolset`` ``tool_filter`` excluding the two names.
"""

from __future__ import annotations

import inspect
import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

# Reuse the T201 recipe verbatim — same private MCPToolset, same deny-by-default
# child env. Do NOT re-implement the secret boundary here.
from mcp_toolset_agent import mx_mcp_toolset, mx_session_state, safe_mx_mcp_env

__all__ = [
    "LONG_RUNNING_TOOL_NAMES",
    "DEFAULT_RESOLVE_WAIT_MS",
    "EnvelopeError",
    "MxPendingTicket",
    "MxLongRunningCore",
    "MxLongRunningBundle",
    "extract_envelope",
    "compose_tool_names",
    "build_long_running_callables",
    "mx_long_running_tool_bundle",
    "build_agent_with_long_running",
    "build_resume_content",
    "safe_mx_mcp_env",
    "mx_session_state",
]

# ---------------------------------------------------------------------------
# Canonical contract constants (mirror @mx-loom/registry — kept in lockstep by a
# drift guard tests in packages/mcp/test/ and the gated live e2e in packages/golden/test/).
# ---------------------------------------------------------------------------

#: The two deferred, approval-bearing verbs this shim wraps as long-running. Their
#: model-facing names are preserved (the spec's canonical-name requirement).
LONG_RUNNING_TOOL_NAMES = ("mx_delegate_tool", "mx_run_command")

#: The canonical resolver verb (T103) used on the resume path. A *read* — it never
#: re-dispatches the original mutation and carries no idempotency key.
_AWAIT_RESULT_TOOL_NAME = "mx_await_result"

#: T102 status partition (mirrors @mx-loom/registry envelope.ToolStatus).
_TERMINAL_STATUSES = frozenset({"ok", "denied", "error"})
_PENDING_STATUSES = frozenset({"running", "awaiting_approval"})
_ALL_STATUSES = _TERMINAL_STATUSES | _PENDING_STATUSES

#: Mirrors @mx-loom/registry IDEMPOTENCY_KEY_PREFIX ("idk_"). A dedup nonce, NOT a
#: credential — confers no authority; the daemon re-runs authorize regardless.
_IDEMPOTENCY_KEY_PREFIX = "idk_"

#: The structurally-always-present, all-null audit ref (mirrors the registry's
#: EMPTY_AUDIT_REF) used when synthesizing a local fault envelope.
_EMPTY_AUDIT_REF: Dict[str, Any] = {
    "invocation_id": None,
    "request_id": None,
    "room": None,
    "event_id": None,
}

#: The four non-secret approval fields (mirrors @mx-loom/registry ApprovalInfo).
#: Pending metadata is projected through this allowlist so nothing else can ride
#: along into model-visible state.
_APPROVAL_FIELDS = ("request_id", "risk", "summary", "expires_at")

#: Default resume probe budget (ms). ``0`` = a single non-blocking probe so the
#: agent can keep doing other work; the host schedules re-polls on a bounded
#: cadence. A ``wait_ms`` expiry in ``mx_await_result`` returns the still-pending
#: envelope (never a fabricated ``timeout`` — T103 semantics), so this is safe to
#: raise for hosts that want a short blocking resolve.
DEFAULT_RESOLVE_WAIT_MS = 0


def _new_idempotency_key() -> str:
    """Generate ``idk_<uuid>`` — a stable per-ADK-function-call dedup nonce."""
    return f"{_IDEMPOTENCY_KEY_PREFIX}{uuid.uuid4()}"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Robust T102 envelope extraction from an ADK MCP tool result (mirrors the proven
# strategy in packages/golden/test/adk.mcp-toolset.e2e.test.ts): prefer
# structuredContent, fall back to JSON text content. Pure + ADK-free.
# ---------------------------------------------------------------------------


class EnvelopeError(RuntimeError):
    """Raised when a T102 envelope cannot be extracted from an MCP tool result.

    The message is fixed and **secret-free** — it never echoes the raw result
    (which is redacted by the toolbelt seam but must not be re-surfaced here).
    """


def _to_plain(value: Any) -> Any:
    """Best-effort, ADK-version-agnostic normalization to JSON-ish primitives."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): _to_plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_plain(v) for v in value]
    # pydantic v2 / v1 model shapes used by the MCP SDK result types.
    if hasattr(value, "model_dump"):
        try:
            return _to_plain(value.model_dump(mode="json"))
        except Exception:  # pragma: no cover - defensive
            pass
    if hasattr(value, "dict"):
        try:
            return _to_plain(value.dict())
        except Exception:  # pragma: no cover - defensive
            pass
    if hasattr(value, "__dict__"):
        return {str(k): _to_plain(v) for k, v in vars(value).items() if not str(k).startswith("_")}
    return str(value)


def _is_audit_ref_like(value: Any) -> bool:
    """Return ``True`` iff ``value`` has the non-secret T102 audit-ref shape."""
    if not isinstance(value, dict):
        return False
    for key in ("invocation_id", "request_id", "room", "event_id"):
        if key not in value:
            return False
        if value[key] is not None and not isinstance(value[key], str):
            return False
    return True


def _is_error_like(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("code"), str)
        and isinstance(value.get("message"), str)
    )


def _is_t102_envelope_like(value: Any) -> bool:
    """Lightweight, dependency-free T102 envelope validation.

    The authoritative schema lives in ``@mx-loom/registry``. Python examples should
    still fail closed on malformed MCP results, so this mirrors the required fields
    and status-specific nullability without adding a Python JSON-Schema dependency.
    """
    if not isinstance(value, dict):
        return False
    required = ("status", "result", "error", "handle", "approval", "audit_ref")
    if not all(key in value for key in required):
        return False
    if not _is_audit_ref_like(value.get("audit_ref")):
        return False

    status = value.get("status")
    if status == "ok":
        return (
            isinstance(value.get("result"), dict)
            and value.get("error") is None
            and value.get("handle") is None
            and value.get("approval") is None
        )
    if status == "running":
        return (
            value.get("result") is None
            and value.get("error") is None
            and isinstance(value.get("handle"), str)
            and value.get("approval") is None
        )
    if status == "awaiting_approval":
        return (
            value.get("result") is None
            and value.get("error") is None
            and isinstance(value.get("handle"), str)
            and isinstance(value.get("approval"), dict)
        )
    if status in {"denied", "error"}:
        return (
            value.get("result") is None
            and _is_error_like(value.get("error"))
            and value.get("handle") is None
            and value.get("approval") is None
        )
    return False


def extract_envelope(value: Any) -> Dict[str, Any]:
    """Extract and lightly validate the full T102 envelope from an ADK MCP result.

    Accepts the raw ADK/MCP result object, its ``structuredContent``, or a JSON
    ``text`` content block. The first candidate must have the required T102 fields
    and status-specific nullability; otherwise this fails closed with a secret-free
    :class:`EnvelopeError` rather than passing a malformed result to the model.
    """
    plain = _to_plain(value)
    candidates: List[Any] = [plain]

    if isinstance(plain, dict):
        for key in ("structuredContent", "structured_content", "structured_content_json"):
            if key in plain:
                candidates.append(plain[key])
        content = plain.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and isinstance(block.get("text"), str):
                    candidates.append(block["text"])
    if isinstance(plain, list):
        for block in plain:
            if isinstance(block, dict) and isinstance(block.get("text"), str):
                candidates.append(block["text"])

    for candidate in candidates:
        if isinstance(candidate, str):
            try:
                candidate = json.loads(candidate)
            except json.JSONDecodeError:
                continue
        if _is_t102_envelope_like(candidate):
            return candidate

    raise EnvelopeError("mx-loom: could not extract a valid T102 result envelope from the ADK tool result")


def _error_envelope(code: str, message: str, audit_ref: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Synthesize a secret-free, schema-shaped ``status:"error"`` envelope.

    Used when the shim itself fails locally (a malformed/handle-less deferred
    result, an unparsable envelope) so the model always receives a valid T102
    envelope rather than a crash. ``code`` must be a fault-set code
    (``internal`` / ``not_found`` / ``invalid_args`` / ``timeout`` /
    ``target_offline``).
    """
    return {
        "status": "error",
        "result": None,
        "error": {"code": code, "message": message},
        "handle": None,
        "approval": None,
        "audit_ref": audit_ref if audit_ref is not None else dict(_EMPTY_AUDIT_REF),
    }


def _secret_free_approval(approval: Any) -> Optional[Dict[str, Any]]:
    """Project an approval block through the four non-secret fields, or ``None``."""
    if not isinstance(approval, dict):
        return None
    projected = {k: approval[k] for k in _APPROVAL_FIELDS if k in approval}
    return projected or None


def _non_negative_int(value: Any, default: int = 0) -> int:
    """Coerce ``value`` to a non-negative integer, failing closed to ``default``."""
    try:
        return max(0, int(value))
    except (TypeError, ValueError, OverflowError):
        return default


def compose_tool_names(mcp_tool_names: List[str]) -> List[str]:
    """The final model-facing tool-name set for a long-running bundle.

    Drops the generic MCP ``mx_delegate_tool`` / ``mx_run_command`` and appends the
    two long-running wrapper names — so the agent sees **exactly one** of each
    (no duplicate names) and the remaining ``mx_*`` verbs unchanged. The bundle
    builder applies the identical selection to the real tool objects, so this pure
    helper is the single source of truth a drift test can pin.
    """
    passthrough = [n for n in mcp_tool_names if n not in LONG_RUNNING_TOOL_NAMES]
    return [*passthrough, *LONG_RUNNING_TOOL_NAMES]


# ---------------------------------------------------------------------------
# Pending-ticket model — non-secret host-side mapping from an ADK function call to
# the daemon handle + the initial pending envelope metadata.
# ---------------------------------------------------------------------------


@dataclass
class MxPendingTicket:
    """A non-secret mapping from an ADK function call to a daemon invocation handle.

    Stored host-side (and, when available, mirrored into ``ToolContext.state``) so a
    long-running call can be resumed. Carries NO credential and NO approval
    capability — ``handle`` observes the daemon's later result; it does not grant
    authority. ``terminal`` caches the resolved terminal envelope so repeated
    resolves are idempotent and never re-dispatch the original mutation.
    """

    ticket_id: str  # ADK function/tool call id, or a generated local id
    tool: str  # "mx_delegate_tool" | "mx_run_command"
    handle: str  # daemon invocation handle; NOT an approval capability
    status: str  # "running" | "awaiting_approval"
    approval: Optional[Dict[str, Any]]  # secret-free {request_id, risk, summary, expires_at}
    audit_ref: Dict[str, Any]
    idempotency_key: Optional[str]
    created_at: str
    correlation_id: Optional[str] = None
    terminal: Optional[Dict[str, Any]] = None  # cached terminal T102 envelope once resolved

    def pending_payload(self) -> Dict[str, Any]:
        """The secret-free dict ADK surfaces to the model as the pending ticket.

        Mirrors the canonical deferred envelope fields the model already sees over
        generic MCP (``status`` + ``handle`` + ``approval`` + ``audit_ref``), plus
        ADK-local routing hints (``pending`` / ``ticket_id``). The ``handle`` and
        ``idempotency_key`` are non-secret by the T102 contract.
        """
        return {
            "status": self.status,
            "pending": True,
            "ticket_id": self.ticket_id,
            "tool": self.tool,
            "handle": self.handle,
            "approval": self.approval,
            "audit_ref": self.audit_ref,
            "idempotency_key": self.idempotency_key,
            "correlation_id": self.correlation_id,
            "message": (
                "mx-loom: held by the receiving daemon (out-of-band human approval / running). "
                "The agent may do other work; the host resumes this call via mx_await_result(handle)."
            ),
        }


# ---------------------------------------------------------------------------
# Low-level MCP tool invocation (ADK-version-agnostic) — mirrors the multi-signature
# probing the golden e2e uses, so the production path matches the proven strategy.
# ---------------------------------------------------------------------------


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def _tool_name(tool: Any) -> str:
    for attr in ("name", "tool_name"):
        if hasattr(tool, attr):
            value = getattr(tool, attr)
            if isinstance(value, str):
                return value
    plain = _to_plain(tool)
    if isinstance(plain, dict):
        for key in ("name", "tool_name"):
            value = plain.get(key)
            if isinstance(value, str):
                return value
    raise RuntimeError(f"could not determine ADK tool name for {type(tool).__name__}")


async def _extract_tools(toolset: Any, tool_context: Any = None) -> List[Any]:
    """List the individual MCP tool objects from an ADK ``MCPToolset``."""
    attempts = [
        ("get_tools(readonly_context=None)", lambda: toolset.get_tools(readonly_context=tool_context)),
        ("get_tools()", lambda: toolset.get_tools()),
        ("get_tools(None)", lambda: toolset.get_tools(tool_context)),
    ]
    errors: List[str] = []
    for label, thunk in attempts:
        try:
            tools = await _maybe_await(thunk())
            if tools is None:
                errors.append(f"{label}: returned None")
                continue
            return list(tools)
        except TypeError as exc:
            errors.append(f"{label}: {exc}")
    raise RuntimeError("ADK MCPToolset did not expose a compatible get_tools API: " + " | ".join(errors))


async def _dispatch_via_mcp(tool: Any, args: Dict[str, Any], tool_context: Any) -> Any:
    """Invoke one MCP tool's run/call API, tolerating ADK signature drift."""
    attempts: List[Any] = []
    if hasattr(tool, "run_async"):
        attempts.extend([
            ("run_async(args=..., tool_context=ctx)", lambda: tool.run_async(args=args, tool_context=tool_context)),
            ("run_async(args=..., tool_context=None)", lambda: tool.run_async(args=args, tool_context=None)),
            ("run_async(positional)", lambda: tool.run_async(args, tool_context)),
        ])
    if hasattr(tool, "call_async"):
        attempts.append(("call_async(args)", lambda: tool.call_async(args)))
    if hasattr(tool, "execute_async"):
        attempts.append(("execute_async(args)", lambda: tool.execute_async(args)))
    if hasattr(tool, "execute"):
        attempts.append(("execute(args)", lambda: tool.execute(args)))

    errors: List[str] = []
    for label, thunk in attempts:
        try:
            return await _maybe_await(thunk())
        except TypeError as exc:
            # Keep trying signature variants. A non-TypeError is a genuine
            # tool/daemon failure and must propagate.
            errors.append(f"{label}: {exc}")
    raise RuntimeError("ADK tool did not expose a compatible call API: " + " | ".join(errors))


# ---------------------------------------------------------------------------
# The ADK-free core: initial dispatch -> ticket-or-terminal, and resume.
#
# Everything that does not need google-adk lives here so it is unit-testable with a
# fake MCP tool (see the __main__ smoke). The ADK builder below wraps two thin
# closures (with the canonical signatures) around this core.
# ---------------------------------------------------------------------------


class MxLongRunningCore:
    """Disposition policy + pending-ticket store for the ADK long-running shim.

    Holds the three MCP tool objects it routes through (``mx_delegate_tool``,
    ``mx_run_command``, ``mx_await_result``) and a per-session ticket store keyed by
    the ADK function-call id. No global singleton: many tickets can be pending in
    one session concurrently, so the agent can keep working while any one is held.
    """

    def __init__(
        self,
        *,
        delegate_tool: Any,
        run_tool: Any,
        await_tool: Any,
        correlation_id: Optional[str] = None,
        initial_wait_ms_cap: int = 0,
    ) -> None:
        self._delegate = delegate_tool
        self._run = run_tool
        self._await = await_tool
        self._correlation_id = correlation_id
        # The initial dispatch never blocks on a human: the probe wait is capped to
        # this (default 0). A model-supplied wait_ms can only LOWER the effective
        # probe, never force a long block that would hide the approval gate.
        self._cap = max(0, int(initial_wait_ms_cap))
        self.tickets: Dict[str, MxPendingTicket] = {}
        self._idem_by_call: Dict[str, str] = {}

    # -- id + idempotency -----------------------------------------------------

    def _resolve_ticket_id(self, tool_context: Any) -> str:
        if tool_context is not None:
            for attr in ("function_call_id", "tool_call_id"):
                value = getattr(tool_context, attr, None)
                if isinstance(value, str) and value:
                    return value
        # No stable ADK call id available: a fresh local id. Retries of the same
        # ADK call cannot then be de-duped at the shim layer (the daemon still
        # de-dupes on idempotency_key), which is the documented degraded mode.
        return f"mxlrt_{uuid.uuid4()}"

    def _resolve_idempotency(self, ticket_id: str, supplied: Optional[str]) -> str:
        if supplied:  # caller-supplied key is preserved verbatim...
            # ...and recorded so a later OMITTED retry of this same ADK call reuses
            # it (a stable per-function-call dedup nonce), not a fresh key.
            self._idem_by_call[ticket_id] = supplied
            return supplied
        existing = self._idem_by_call.get(ticket_id)
        if existing:  # reuse the key first used for THIS function call (retry-safe)
            return existing
        key = _new_idempotency_key()
        self._idem_by_call[ticket_id] = key
        return key

    def _probe_wait_ms(self, model_wait_ms: Any) -> int:
        requested = _non_negative_int(model_wait_ms, default=0)
        return min(requested, self._cap)

    # -- initial dispatch -----------------------------------------------------

    async def _dispatch_initial(
        self,
        tool_name: str,
        mcp_tool: Any,
        canonical_args: Dict[str, Any],
        supplied_idem: Optional[str],
        model_wait_ms: Any,
        tool_context: Any,
    ) -> Dict[str, Any]:
        ticket_id = self._resolve_ticket_id(tool_context)
        if supplied_idem is not None and not isinstance(supplied_idem, str):
            return _error_envelope("invalid_args", "mx-loom: idempotency_key must be a string when supplied")
        idem = self._resolve_idempotency(ticket_id, supplied_idem)

        args = dict(canonical_args)
        args["idempotency_key"] = idem
        args["wait_ms"] = self._probe_wait_ms(model_wait_ms)

        try:
            raw = await _dispatch_via_mcp(mcp_tool, args, tool_context)
            envelope = extract_envelope(raw)
        except EnvelopeError:
            return _error_envelope("internal", "mx-loom: could not parse the tool result envelope")

        status = envelope.get("status")

        # Terminal already (ok / denied / error): return as the final ADK result —
        # do NOT manufacture a pending ticket.
        if status in _TERMINAL_STATUSES:
            return envelope

        # Deferred (running / awaiting_approval): create a pending ticket.
        if status in _PENDING_STATUSES:
            handle = envelope.get("handle")
            if not isinstance(handle, str) or handle == "":
                return _error_envelope("internal", "mx-loom: deferred result missing a resolvable handle")
            ticket = MxPendingTicket(
                ticket_id=ticket_id,
                tool=tool_name,
                handle=handle,
                status=status,
                approval=_secret_free_approval(envelope.get("approval")),
                audit_ref=envelope.get("audit_ref") if isinstance(envelope.get("audit_ref"), dict) else dict(_EMPTY_AUDIT_REF),
                idempotency_key=idem,
                created_at=_utc_now_iso(),
                correlation_id=self._correlation_id,
            )
            self.tickets[ticket_id] = ticket
            self._stash_in_state(tool_context, ticket)
            return ticket.pending_payload()

        return _error_envelope("internal", "mx-loom: unrecognized result status from the daemon")

    @staticmethod
    def _stash_in_state(tool_context: Any, ticket: MxPendingTicket) -> None:
        """Best-effort: mirror the non-secret pending payload into ToolContext.state."""
        state = getattr(tool_context, "state", None)
        if state is None:
            return
        try:
            state[f"mx_pending_{ticket.ticket_id}"] = ticket.pending_payload()
        except Exception:  # pragma: no cover - ToolContext.state may be read-only
            pass

    async def dispatch_delegate(
        self,
        agent: str,
        tool: str,
        args: Optional[Dict[str, Any]],
        wait_ms: Any,
        idempotency_key: Optional[str],
        tool_context: Any,
    ) -> Dict[str, Any]:
        if not isinstance(agent, str) or not isinstance(tool, str) or not isinstance(args, dict):
            return _error_envelope(
                "invalid_args",
                "mx-loom: mx_delegate_tool requires string agent/tool and object args",
            )
        canonical = {"agent": agent, "tool": tool, "args": args}
        return await self._dispatch_initial(
            "mx_delegate_tool", self._delegate, canonical, idempotency_key, wait_ms, tool_context
        )

    async def dispatch_run_command(
        self,
        agent: str,
        command: str,
        args: Optional[List[str]],
        cwd: Optional[str],
        wait_ms: Any,
        idempotency_key: Optional[str],
        tool_context: Any,
    ) -> Dict[str, Any]:
        if not isinstance(agent, str) or not isinstance(command, str):
            return _error_envelope(
                "invalid_args",
                "mx-loom: mx_run_command requires string agent and command",
            )
        if args is not None:
            if not isinstance(args, (list, tuple)) or not all(isinstance(item, str) for item in args):
                return _error_envelope(
                    "invalid_args",
                    "mx-loom: mx_run_command args must be an array of strings when supplied",
                )
        if cwd is not None and not isinstance(cwd, str):
            return _error_envelope("invalid_args", "mx-loom: mx_run_command cwd must be a string when supplied")

        canonical: Dict[str, Any] = {"agent": agent, "command": command}
        if args:
            canonical["args"] = list(args)
        if cwd:
            canonical["cwd"] = cwd
        return await self._dispatch_initial(
            "mx_run_command", self._run, canonical, idempotency_key, wait_ms, tool_context
        )

    # -- resume ---------------------------------------------------------------

    def get_ticket(self, ticket_id: str) -> Optional[MxPendingTicket]:
        return self.tickets.get(ticket_id)

    def pending_tickets(self) -> List[MxPendingTicket]:
        """Tickets that have not yet resolved to a terminal envelope."""
        return [t for t in self.tickets.values() if t.terminal is None]

    async def resolve_ticket(
        self,
        ticket_id: str,
        wait_ms: int = DEFAULT_RESOLVE_WAIT_MS,
        tool_context: Any = None,
    ) -> Dict[str, Any]:
        """Observe the daemon result for a pending ticket via ``mx_await_result``.

        Idempotent: a completed ticket returns its cached terminal envelope without
        touching the daemon and never re-dispatches the original mutation. A
        still-pending budget expiry keeps the ticket pending (T103: not a timeout
        fault). The resolver only **reads** — it issues no approval and grants no
        authority.
        """
        ticket = self.tickets.get(ticket_id)
        if ticket is None:
            return _error_envelope("not_found", "mx-loom: no pending ticket for the given id")
        if ticket.terminal is not None:
            return ticket.terminal  # idempotent completion

        await_args = {"handle": ticket.handle, "wait_ms": _non_negative_int(wait_ms, default=0)}
        try:
            raw = await _dispatch_via_mcp(self._await, await_args, tool_context)
            envelope = extract_envelope(raw)
        except EnvelopeError:
            return _error_envelope("internal", "mx-loom: could not parse the await_result envelope")

        status = envelope.get("status")
        if status in _TERMINAL_STATUSES:
            ticket.terminal = envelope
            ticket.status = status if status in _PENDING_STATUSES else ticket.status
            self._stash_in_state(tool_context, ticket)
            return envelope
        if status in _PENDING_STATUSES:
            ticket.status = status
            refreshed = _secret_free_approval(envelope.get("approval"))
            if refreshed is not None:
                ticket.approval = refreshed
            return ticket.pending_payload()
        return _error_envelope("internal", "mx-loom: unrecognized await_result status from the daemon")


# ---------------------------------------------------------------------------
# The ADK bundle — one private MCPToolset, seven pass-through tools, and the two
# native long-running wrappers (canonical names preserved).
# ---------------------------------------------------------------------------


@dataclass
class MxLongRunningBundle:
    """The composed ADK MX tool bundle for native long-running mode.

    ``tools`` is the list to hand to ``LlmAgent(tools=...)``: the non-deferred
    ``mx_*`` MCP tools (pass-through) plus the two ``LongRunningFunctionTool``
    wrappers. ``core`` owns the pending-ticket store + resume policy. ``close()``
    shuts down the underlying MCPToolset (the wrappers close over its individual
    tools, so it must stay alive for the bundle's lifetime).
    """

    toolset: Any
    tools: List[Any]
    core: MxLongRunningCore
    tool_names: List[str] = field(default_factory=list)
    _closed: bool = False

    def get_ticket(self, ticket_id: str) -> Optional[MxPendingTicket]:
        return self.core.get_ticket(ticket_id)

    def pending_tickets(self) -> List[MxPendingTicket]:
        return self.core.pending_tickets()

    async def resolve_ticket(
        self, ticket_id: str, wait_ms: int = DEFAULT_RESOLVE_WAIT_MS, tool_context: Any = None
    ) -> Dict[str, Any]:
        return await self.core.resolve_ticket(ticket_id, wait_ms=wait_ms, tool_context=tool_context)

    def build_resume_content(self, ticket_id: str) -> Any:
        """Build the ADK resume ``Content`` for a RESOLVED ticket (terminal cached).

        Call :meth:`resolve_ticket` until it returns a terminal envelope first. The
        returned ``Content`` carries a ``FunctionResponse`` with the original call
        id so ADK resumes the same long-running tool call. Deferred import: verify
        ``google.genai.types`` against your pinned version.
        """
        ticket = self.core.get_ticket(ticket_id)
        if ticket is None:
            raise KeyError(f"no ticket for id {ticket_id!r}")
        if ticket.terminal is None:
            raise RuntimeError(
                f"ticket {ticket_id!r} is not resolved yet; call resolve_ticket(...) until it is terminal"
            )
        return build_resume_content(ticket_id, ticket.tool, ticket.terminal)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        await _close_toolset(self.toolset)


async def _close_toolset(toolset: Any) -> None:
    for name in ("close", "close_async", "shutdown"):
        if hasattr(toolset, name):
            await _maybe_await(getattr(toolset, name)())
            return


def build_resume_content(ticket_id: str, tool_name: str, terminal_envelope: Dict[str, Any]) -> Any:
    """Construct the ADK resume ``Content`` injecting the terminal function response.

    Deferred import of ``google.genai.types`` (verify against your pinned ADK/genai
    version). The ``id`` MUST equal the original function-call id so ADK matches the
    pending long-running call.
    """
    from google.genai import types  # deferred: verify import path against your version

    return types.Content(
        role="user",
        parts=[
            types.Part(
                function_response=types.FunctionResponse(
                    id=ticket_id,
                    name=tool_name,
                    response=terminal_envelope,
                )
            )
        ],
    )


async def mx_long_running_tool_bundle(
    room: str,
    correlation_id: Optional[str] = None,
    *,
    command: str = "mx-loom-mcp",
    cwd: Optional[str] = None,
    project_id: Optional[str] = None,
    git_commit: Optional[str] = None,
    max_invocations: Optional[int] = None,
    extra_env: Optional[Dict[str, str]] = None,
    initial_wait_ms_cap: int = 0,
) -> MxLongRunningBundle:
    """Build the ADK long-running MX tool bundle over one private ``mx-loom-mcp``.

    Starts a single deny-by-default ``MCPToolset`` (via the T201 ``mx_mcp_toolset``
    recipe), lists its tools, replaces only ``mx_delegate_tool`` / ``mx_run_command``
    with native ``LongRunningFunctionTool`` wrappers that preserve those canonical
    names, and keeps the other ``mx_*`` verbs as ordinary MCP tools. The wrappers
    route initial dispatch + resume back through this same toolset, so the secret
    boundary, session registration, redaction, and audit tap stay centralized.

    Deferred ADK import: verify ``LongRunningFunctionTool`` against your version.
    """
    from google.adk.tools import LongRunningFunctionTool  # deferred: verify import path

    toolset = mx_mcp_toolset(
        room=room,
        correlation_id=correlation_id,
        command=command,
        cwd=cwd,
        project_id=project_id,
        git_commit=git_commit,
        max_invocations=max_invocations,
        extra_env=extra_env,
    )

    mcp_tools = await _extract_tools(toolset, None)
    mcp_tool_names = [_tool_name(t) for t in mcp_tools]
    duplicate_names = sorted({name for name in mcp_tool_names if mcp_tool_names.count(name) > 1})
    if duplicate_names:
        await _close_toolset(toolset)
        raise RuntimeError(
            "mx-loom MCP server exposed duplicate tool names, so the long-running bundle cannot be built safely: "
            f"{duplicate_names}"
        )
    by_name = dict(zip(mcp_tool_names, mcp_tools))

    missing = [n for n in (*LONG_RUNNING_TOOL_NAMES, _AWAIT_RESULT_TOOL_NAME) if n not in by_name]
    if missing:
        await _close_toolset(toolset)
        raise RuntimeError(
            "mx-loom MCP server did not expose the tools required for the long-running shim: "
            f"{missing}; got {sorted(by_name)}"
        )

    core = MxLongRunningCore(
        delegate_tool=by_name["mx_delegate_tool"],
        run_tool=by_name["mx_run_command"],
        await_tool=by_name[_AWAIT_RESULT_TOOL_NAME],
        correlation_id=correlation_id,
        initial_wait_ms_cap=initial_wait_ms_cap,
    )

    # The two native wrappers carry the canonical names + signatures + docstrings
    # ADK derives the model-facing declaration from. `tool_context` is ADK-injected
    # and excluded from the declaration. Built ADK-free so a drift guard can inspect
    # their signatures without google-adk installed.
    mx_delegate_tool, mx_run_command = build_long_running_callables(core)
    long_delegate = LongRunningFunctionTool(func=mx_delegate_tool)
    long_run = LongRunningFunctionTool(func=mx_run_command)

    passthrough = [by_name[name] for name in mcp_tool_names if name not in LONG_RUNNING_TOOL_NAMES]
    tools = [*passthrough, long_delegate, long_run]
    tool_names = compose_tool_names(mcp_tool_names)

    return MxLongRunningBundle(toolset=toolset, tools=tools, core=core, tool_names=tool_names)


def build_long_running_callables(core: MxLongRunningCore) -> tuple[Any, Any]:
    """Build the two canonical long-running callables that close over ``core``.

    Returns ``(mx_delegate_tool, mx_run_command)``. Their **names**, **signatures**,
    and **docstrings** ARE the model-facing tool declaration ADK derives — so the
    canonical names + input fields are preserved here, not re-spelled. ``tool_context``
    is injected by ADK and excluded from the declaration; ``wait_ms`` /
    ``idempotency_key`` are optional. This is module-level (not nested in the ADK
    factory) so a schema **drift guard** can pass a fake/real core and inspect the
    signatures against ``MX_DELEGATE_TOOL`` / ``MX_RUN_COMMAND`` WITHOUT google-adk.
    """

    async def mx_delegate_tool(
        agent: str,
        tool: str,
        args: Dict[str, Any],
        wait_ms: int = 0,
        idempotency_key: str = "",
        tool_context: Any = None,
    ) -> Dict[str, Any]:
        """Invoke a named tool on a remote agent (the primary delegation verb).

        Long-running: an approval-gated or still-running call returns a pending
        ticket; the agent keeps working and the host resumes via the result. Returns
        the full T102 envelope on a terminal result.
        """
        return await core.dispatch_delegate(agent, tool, args, wait_ms, idempotency_key or None, tool_context)

    async def mx_run_command(
        agent: str,
        command: str,
        args: Optional[List[str]] = None,
        cwd: str = "",
        wait_ms: int = 0,
        idempotency_key: str = "",
        tool_context: Any = None,
    ) -> Dict[str, Any]:
        """Run an allowlisted command on a remote agent (gated by receiver policy).

        Long-running: a held / still-running command returns a pending ticket the
        host resumes on result. Returns the full T102 envelope on a terminal result.
        """
        return await core.dispatch_run_command(
            agent, command, args, cwd or None, wait_ms, idempotency_key or None, tool_context
        )

    return mx_delegate_tool, mx_run_command


async def build_agent_with_long_running(
    room: str,
    session_id: str,
    *,
    model: str = "<configured-by-host>",
    command: str = "mx-loom-mcp",
    **bundle_kwargs: Any,
) -> Any:
    """Convenience: an ``LlmAgent`` wired with the long-running bundle + the bundle.

    Returns ``(agent, bundle)``. The host owns model/provider config; provider keys
    stay in the host layer and never reach the MCP child (``safe_mx_mcp_env`` denies
    them). The room + correlation id are session config, never model tool args.
    """
    from google.adk.agents import LlmAgent  # deferred: verify import path

    bundle = await mx_long_running_tool_bundle(
        room=room,
        correlation_id=f"adk_{session_id}",
        command=command,
        **bundle_kwargs,
    )
    agent = LlmAgent(
        name="mx_adk_long_running_agent",
        model=model,
        instruction=(
            "Use mx_* tools for MX-Agent coordination. mx_delegate_tool and "
            "mx_run_command are long-running: an approval-gated or still-running call "
            "returns a pending ticket — continue other useful work; the host resumes "
            "the call when the result is ready. A denied result is a governance "
            "outcome to replan around, not a failure. Never ask for or include "
            "credentials in tool arguments; you cannot approve your own requests."
        ),
        tools=bundle.tools,
    )
    return agent, bundle


# ---------------------------------------------------------------------------
# Dependency-free smoke (no google-adk, no daemon, no network): exercises the
# ADK-free core with a fake MCP tool so the long-running disposition policy is
# verifiable here. Run: `python examples/adk/long_running_tools.py`.
# ---------------------------------------------------------------------------

if __name__ == "__main__":  # pragma: no cover - dependency-free smoke
    import asyncio

    def _envelope(status, **kw):
        env = {
            "status": status,
            "result": None,
            "error": None,
            "handle": None,
            "approval": None,
            "audit_ref": dict(_EMPTY_AUDIT_REF),
        }
        env.update(kw)
        return env

    class ScriptedTool:
        """A fake MCP tool: returns scripted envelopes (as structuredContent) per call."""

        def __init__(self, name, responses):
            self.name = name
            self._responses = list(responses)
            self.calls = []

        async def run_async(self, args=None, tool_context=None):
            self.calls.append(dict(args or {}))
            env = self._responses.pop(0) if self._responses else self._responses_last
            self._responses_last = env
            # Mimic an MCP CallToolResult: structuredContent + a JSON text block.
            return {
                "structuredContent": env,
                "content": [{"type": "text", "text": json.dumps(env)}],
                "isError": env["status"] == "error",
            }

    class FakeToolContext:
        def __init__(self, function_call_id):
            self.function_call_id = function_call_id
            self.state = {}

    async def main():
        populated_audit = {"invocation_id": "inv_1", "request_id": "req_1", "room": "!r:s", "event_id": "$e"}
        approval = {
            "request_id": "req_1",
            "risk": "high",
            "summary": "run approval tool",
            "expires_at": "2099-01-01T00:00:00Z",
            "leak": "SHOULD_BE_DROPPED",  # non-canonical field must NOT survive
        }

        # ---- 1) awaiting_approval -> pending ticket; resume still-pending -> ok.
        delegate = ScriptedTool(
            "mx_delegate_tool",
            [_envelope("awaiting_approval", handle="inv_1", approval=approval, audit_ref=populated_audit)],
        )
        run = ScriptedTool(
            "mx_run_command", [_envelope("denied", error={"code": "policy_denied", "message": "not allowlisted"})]
        )
        await_tool = ScriptedTool(
            "mx_await_result",
            [
                _envelope("awaiting_approval", handle="inv_1", approval=approval, audit_ref=populated_audit),
                _envelope("ok", result={"package": "ok"}, audit_ref=populated_audit),
            ],
        )
        core = MxLongRunningCore(delegate_tool=delegate, run_tool=run, await_tool=await_tool)

        ctx = FakeToolContext("call_A")
        pending = await core.dispatch_delegate("agent-b", "approval_tool", {}, 0, "", ctx)
        assert pending["pending"] is True, pending
        assert pending["status"] == "awaiting_approval", pending
        assert pending["handle"] == "inv_1", pending
        assert pending["ticket_id"] == "call_A", pending
        assert pending["approval"] == {
            "request_id": "req_1",
            "risk": "high",
            "summary": "run approval tool",
            "expires_at": "2099-01-01T00:00:00Z",
        }, pending["approval"]
        assert "SHOULD_BE_DROPPED" not in json.dumps(pending), "non-canonical approval field leaked"
        assert "mx_pending_call_A" in ctx.state, "pending payload not mirrored into ToolContext.state"

        # initial dispatch was a NON-BLOCKING probe (wait_ms capped to 0).
        assert delegate.calls[0]["wait_ms"] == 0, delegate.calls[0]
        # an idempotency key was generated for this call.
        first_key = delegate.calls[0]["idempotency_key"]
        assert first_key.startswith("idk_"), first_key

        # resume: still pending, then ok.
        still = await core.resolve_ticket("call_A", wait_ms=0, tool_context=ctx)
        assert still.get("pending") is True and still["status"] == "awaiting_approval", still
        terminal = await core.resolve_ticket("call_A", wait_ms=0, tool_context=ctx)
        assert terminal["status"] == "ok" and terminal["result"] == {"package": "ok"}, terminal
        # resume reads only — never an idempotency key on await_result.
        assert all("idempotency_key" not in c for c in await_tool.calls), await_tool.calls
        # idempotent completion: a repeat resolve returns the SAME terminal, no new daemon read.
        await_calls_before = len(await_tool.calls)
        again = await core.resolve_ticket("call_A", wait_ms=0, tool_context=ctx)
        assert again == terminal, "completed ticket not idempotent"
        assert len(await_tool.calls) == await_calls_before, "completed resolve re-hit the daemon"
        assert core.pending_tickets() == [], "resolved ticket still pending"

        # ---- 2) terminal initial dispatch -> no ticket.
        deny = await core.dispatch_run_command("agent-b", "curl", ["x"], None, 0, "", FakeToolContext("call_B"))
        assert deny["status"] == "denied", deny
        assert core.get_ticket("call_B") is None, "terminal initial dispatch created a ticket"

        # ---- 3) supplied idempotency key preserved; reuse on retry of same call.
        delegate2 = ScriptedTool(
            "mx_delegate_tool",
            [
                _envelope("running", handle="inv_2", audit_ref=populated_audit),
                _envelope("running", handle="inv_2", audit_ref=populated_audit),
            ],
        )
        core2 = MxLongRunningCore(delegate_tool=delegate2, run_tool=run, await_tool=await_tool)
        ctxC = FakeToolContext("call_C")
        await core2.dispatch_delegate("agent-b", "t", {}, 0, "idk_supplied", ctxC)
        await core2.dispatch_delegate("agent-b", "t", {}, 0, "", ctxC)  # retry, no key supplied
        assert delegate2.calls[0]["idempotency_key"] == "idk_supplied", delegate2.calls[0]
        assert delegate2.calls[1]["idempotency_key"] == "idk_supplied", "supplied key not reused on retry"

        # ---- 4) malformed deferred (missing handle) -> safe error, not a crash.
        delegate3 = ScriptedTool("mx_delegate_tool", [_envelope("running", handle="")])
        core3 = MxLongRunningCore(delegate_tool=delegate3, run_tool=run, await_tool=await_tool)
        bad = await core3.dispatch_delegate("agent-b", "t", {}, 0, "", FakeToolContext("call_D"))
        assert bad["status"] == "error" and bad["error"]["code"] == "internal", bad

        # ---- 5) resolve unknown ticket -> not_found.
        nf = await core3.resolve_ticket("nope", wait_ms=0)
        assert nf["status"] == "error" and nf["error"]["code"] == "not_found", nf

        # ---- 6) duplicate-name / no-authority composition.
        mcp_names = [
            "mx_find_agents", "mx_describe_agent", "mx_delegate_tool", "mx_run_command",
            "mx_await_result", "mx_share_context", "mx_get_context", "mx_cancel", "mx_workspace_status",
        ]
        composed = compose_tool_names(mcp_names)
        assert composed.count("mx_delegate_tool") == 1, composed
        assert composed.count("mx_run_command") == 1, composed
        assert "mx_find_agents" in composed and "mx_await_result" in composed, composed
        for forbidden in ("approval.decide", "trust.set", "policy.reload", "daemon.shutdown"):
            assert forbidden not in composed, f"authority verb exposed: {forbidden}"

        # ---- 7) concurrency: two independent pending tickets coexist.
        delegate4 = ScriptedTool(
            "mx_delegate_tool",
            [
                _envelope("awaiting_approval", handle="inv_X", approval=approval, audit_ref=populated_audit),
                _envelope("awaiting_approval", handle="inv_Y", approval=approval, audit_ref=populated_audit),
            ],
        )
        core4 = MxLongRunningCore(delegate_tool=delegate4, run_tool=run, await_tool=await_tool)
        await core4.dispatch_delegate("agent-b", "t", {}, 0, "", FakeToolContext("call_X"))
        await core4.dispatch_delegate("agent-b", "t", {}, 0, "", FakeToolContext("call_Y"))
        assert {t.ticket_id for t in core4.pending_tickets()} == {"call_X", "call_Y"}, core4.pending_tickets()
        assert core4.get_ticket("call_X").handle == "inv_X"
        assert core4.get_ticket("call_Y").handle == "inv_Y"

        print("long_running_tools.py core smoke: OK")

    asyncio.run(main())
