"""Google ADK ``MCPToolset`` integration for the mx-loom tool fabric (T201 / #23).

A minimal, copy-pasteable recipe that mounts the generated ``mx-loom-mcp`` MCP
server on an ADK ``LlmAgent`` so the agent can discover and call the canonical
``mx_*`` coordination tools::

    LlmAgent(..., tools=[mx_mcp_toolset(room="!workspace:server")])

Scope (T201): generic ``MCPToolset`` wiring + the ADK session / ``ToolContext``
mapping. The approval-aware ``LongRunningFunctionTool`` resume is **T202**; this
recipe surfaces ``running`` / ``awaiting_approval`` as ordinary envelopes the model
resolves later with ``mx_await_result(handle)``.

Secret boundary (Boundary A): the MCP child is spawned with an **explicit
deny-by-default environment**. The deny rules below mirror, 1:1, the canonical
TypeScript source of truth in ``packages/toolbelt/src/cli/env.ts``
(``BASE_ENV_ALLOW`` + ``isDeniedEnvKey``). Keep them in lockstep — a divergent
Python list is a latent secret leak. ``packages/mcp/test/cli-options.test.ts``
pins this mirror against the exported toolbelt constants so drift fails CI.

ADK import-path note: ``google-adk`` is not a dependency of this repo and its
exact import paths can drift between versions. The ADK imports are therefore
**deferred into the factory functions** so this module (and ``safe_mx_mcp_env``)
can be imported and exercised without ``google-adk`` installed. Verify the import
paths against your pinned ADK version (see ``examples/adk/README.md``).
"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional

# ---------------------------------------------------------------------------
# Canonical secret-boundary mirror — keep in lockstep with
# packages/toolbelt/src/cli/env.ts (BASE_ENV_ALLOW + isDeniedEnvKey).
# ---------------------------------------------------------------------------

# Whole secret namespaces — denied even via an explicit ``extra`` (== ENV_DENY_PREFIXES).
_DENY_ENV_PREFIXES = ("MATRIX_", "MX_AGENT_")
# Credential name suffixes — denied even via an explicit ``extra`` (== ENV_DENY_SUFFIXES).
_DENY_ENV_SUFFIXES = ("_TOKEN", "_API_KEY", "_SECRET", "_ACCESS_KEY")
# Exact denies the rule names explicitly (== ENV_DENY_EXACT). ``GH_TOKEN`` is also
# covered by the ``_TOKEN`` suffix; listed so the deny set self-documents it.
_DENY_ENV_EXACT = frozenset({"GH_TOKEN"})

# Minimal base allowlist — only what ``mx-loom-mcp`` (and the toolbelt under it)
# needs to find its socket / on-disk daemon state and run (== BASE_ENV_ALLOW).
# Notably absent by design: every credential, plus USER / SHELL.
_BASE_ENV_ALLOW = (
    "HOME",
    "PATH",
    "XDG_RUNTIME_DIR",  # daemon socket resolution (Linux)
    "XDG_DATA_HOME",  # on-disk daemon state / CLI-fallback discovery
    "TMPDIR",  # daemon socket resolution (macOS)
    "LANG",
    "LC_ALL",
    "TERM",
)

# Extra NON-secret, mx-loom-namespaced toggles (the Python analogue of the
# toolbelt's ``extraAllow``). Each must itself pass the deny check — the parity
# test asserts that. The audit *DSN* is NOT here: ``DATABASE_URL`` / ``PG*`` are
# credential-shaped and are deliberately withheld (audit is off for the ADK child
# by default; a host that wants it must forward the DSN through a dedicated,
# never-logged path).
_EXTRA_ENV_ALLOW = (
    "MXL_AGENT_BIN",  # optional non-secret mx-agent binary override
    "MXL_AUDIT_PG",  # optional audit toggle (the DSN itself is handled separately)
)

# ADK-specific audit-store credential deny, layered on top of the canonical
# toolbelt rules above. These are *not* Boundary-A Matrix/provider/GitHub secrets,
# but they can contain database credentials and must not be admitted through
# ``extra`` by accident.
_AUDIT_DSN_DENY_EXACT = frozenset({"DATABASE_URL"})
_AUDIT_DSN_DENY_PREFIXES = ("PG",)


def _is_denied_env_key(key: str) -> bool:
    """Mirror toolbelt ``isDeniedEnvKey`` plus ADK audit-DSN denies."""
    upper = key.upper()
    if any(key.startswith(prefix) for prefix in _DENY_ENV_PREFIXES):
        return True
    if upper in _DENY_ENV_EXACT or upper in _AUDIT_DSN_DENY_EXACT:
        return True
    if any(upper.startswith(prefix) for prefix in _AUDIT_DSN_DENY_PREFIXES):
        return True
    return any(upper.endswith(suffix) for suffix in _DENY_ENV_SUFFIXES)


def safe_mx_mcp_env(extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """Build the deny-by-default child environment for ``mx-loom-mcp``.

    Deny-by-default: start empty and copy only allowlisted, non-denied keys that
    are present in the parent environment. An explicit ``extra`` mapping may add
    further NON-secret values; any secret-shaped ``extra`` key is refused (it can
    never re-admit a known secret into the child env), mirroring the toolbelt's
    ``safeSubprocessEnv`` semantics.
    """
    allow = tuple(k for k in (_BASE_ENV_ALLOW + _EXTRA_ENV_ALLOW) if not _is_denied_env_key(k))
    env: Dict[str, str] = {k: os.environ[k] for k in allow if k in os.environ}
    if extra:
        for key, value in extra.items():
            if _is_denied_env_key(key):
                raise ValueError(f"refusing to pass secret-shaped env var to mx-loom-mcp: {key}")
            env[key] = value
    return env


# ---------------------------------------------------------------------------
# ADK session / ToolContext mapping (non-secret, no authority)
# ---------------------------------------------------------------------------


def mx_session_state(room: str, correlation_id: str) -> Dict[str, str]:
    """The non-secret values a host may stash in ADK ``ToolContext`` state.

    One ADK session/agent maps to one workspace ``room`` and one stable
    ``correlation_id``. ``ToolContext`` is **not** an authority store: it may carry
    only non-secret room/correlation/handle metadata for host UI/resume continuity
    — never credentials, approval decisions, trust mutations, or policy content.
    The host reads this before constructing the toolset; it is not a model tool
    argument.
    """
    return {"mx_room": room, "mx_correlation_id": correlation_id}


def _mx_mcp_args(
    room: str,
    correlation_id: Optional[str] = None,
    cwd: Optional[str] = None,
    project_id: Optional[str] = None,
    git_commit: Optional[str] = None,
    max_invocations: Optional[int] = None,
) -> list[str]:
    """Build the ``mx-loom-mcp --stdio`` argv from non-secret session config."""
    args = ["--stdio", "--room", room, "--kind", "adk"]
    if correlation_id:
        args += ["--correlation-id", correlation_id]
    if cwd:
        args += ["--cwd", cwd]
    if project_id:
        args += ["--project-id", project_id]
    if git_commit:
        args += ["--git-commit", git_commit]
    if max_invocations is not None:
        if max_invocations <= 0:
            raise ValueError("max_invocations must be a positive integer")
        args += ["--max-invocations", str(max_invocations)]
    return args


def mx_mcp_toolset(
    room: str,
    correlation_id: Optional[str] = None,
    *,
    command: str = "mx-loom-mcp",
    cwd: Optional[str] = None,
    project_id: Optional[str] = None,
    git_commit: Optional[str] = None,
    max_invocations: Optional[int] = None,
    extra_env: Optional[Dict[str, str]] = None,
) -> Any:
    """Build an ADK ``MCPToolset`` over a local ``mx-loom-mcp --stdio`` subprocess.

    The ``command`` must be resolvable on ``PATH`` (a published/linked standalone
    ``mx-loom-mcp`` once available, or a tiny launcher that execs the workspace
    ``tsx packages/mcp/src/cli.ts`` entry) or the stdio spawn fails with ``ENOENT``.
    Do not point ADK at ``packages/mcp/dist/cli.js`` directly in this source
    workspace; package exports currently target TypeScript source, so plain Node
    cannot resolve the built file's cross-package ``./*.js`` specifiers.

    Secret boundary: ``env=safe_mx_mcp_env()`` passes an explicit safe child
    environment. This only protects the boundary if your ADK version's stdio spawn
    API actually applies a caller-supplied ``env``. If it does not, pre-sanitize
    before spawn (wrap ``mx-loom-mcp`` in a clear-and-re-export launcher, or ensure
    the ADK host process holds no Boundary-A secret when it builds the toolset).
    See ``examples/adk/README.md`` → "StdioServerParameters env backstop".
    """
    # Deferred import: verify these paths against your pinned google-adk version.
    from google.adk.tools.mcp_tool import MCPToolset, StdioServerParameters

    return MCPToolset(
        connection_params=StdioServerParameters(
            command=command,
            args=_mx_mcp_args(
                room=room,
                correlation_id=correlation_id,
                cwd=cwd,
                project_id=project_id,
                git_commit=git_commit,
                max_invocations=max_invocations,
            ),
            env=safe_mx_mcp_env(extra_env),
        ),
    )


def build_agent(room: str, session_id: str, *, model: str = "<configured-by-host>") -> Any:
    """Build an ``LlmAgent`` whose only tools are the canonical ``mx_*`` verbs.

    The host owns model/provider configuration; provider keys stay in the host
    layer and must never be forwarded to the MCP child (``safe_mx_mcp_env`` denies
    them). The room and correlation id are session config, not model tool args.
    """
    # Deferred import: verify this path against your pinned google-adk version.
    from google.adk.agents import LlmAgent

    return LlmAgent(
        name="mx_adk_agent",
        model=model,
        instruction=(
            "Use mx_* tools for MX-Agent coordination. "
            "If a tool returns status=running or status=awaiting_approval, continue "
            "useful work and later call mx_await_result with the handle. A denied "
            "result is a governance outcome to replan around, not a failure. "
            "Never ask for or include credentials in tool arguments."
        ),
        tools=[mx_mcp_toolset(room=room, correlation_id=f"adk_{session_id}")],
    )


if __name__ == "__main__":  # pragma: no cover - dependency-free smoke of the env helper
    # Exercisable without google-adk: prove the safe env never leaks a secret.
    os.environ.setdefault("PATH", "/usr/bin")
    fake_secrets = {
        "GH_TOKEN": "x",
        "MATRIX_ACCESS_TOKEN": "x",
        "MX_AGENT_SECRET": "x",
        "ANTHROPIC_API_KEY": "x",
        "OPENAI_API_KEY": "x",
        "AWS_SECRET_ACCESS_KEY": "x",
        "DATABASE_URL": "postgres://user:pw@host/db",
        "PGPASSWORD": "x",
        "PGHOST": "localhost",
    }
    for key, value in fake_secrets.items():
        os.environ[key] = value
    child_env = safe_mx_mcp_env()
    leaked = sorted(k for k in child_env if _is_denied_env_key(k))
    assert not leaked, f"secret-shaped keys leaked into the MCP child env: {leaked}"
    for denied_extra in ("DATABASE_URL", "PGPASSWORD", "PGHOST", "GH_TOKEN"):
        try:
            safe_mx_mcp_env({denied_extra: "x"})
        except ValueError:
            pass
        else:  # pragma: no cover - smoke assertion
            raise AssertionError(f"secret-shaped extra env key was admitted: {denied_extra}")
    print("safe_mx_mcp_env keys:", sorted(child_env))
    print("argv:", _mx_mcp_args(room="!example:server", correlation_id="adk_demo"))
