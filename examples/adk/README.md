# Google ADK × mx-loom — `MCPToolset` integration (T201 / #23)

> Part of the [Runtime integration guide](../../docs/runtime-integration.md#google-adk) — the hub with one verified setup per runtime. This README is the canonical ADK deep reference.

Mount the generated **`mx-loom-mcp`** server on a Google ADK
[`LlmAgent`](https://google.github.io/adk-docs/) so the agent can discover and
call the canonical `mx_*` coordination tools over MCP:

```python
from mcp_toolset_agent import mx_mcp_toolset
from google.adk.agents import LlmAgent

agent = LlmAgent(
    name="mx_adk_agent",
    model="<your-model>",
    tools=[mx_mcp_toolset(room="!workspace:server")],
)
```

This is the **generic MCPToolset wiring** (issue #23 acceptance: *an ADK agent
lists and calls `mx_*` tools via MCP*). Here `running` / `awaiting_approval` are
surfaced as ordinary envelopes you resolve later by calling
`mx_await_result(handle)`.

For approval-aware **native long-running** behavior — ADK `LongRunningFunctionTool`
pending tickets that resume on approval — see
[Native long-running mode (T202)](#native-long-running-mode-t202) below
([`long_running_tools.py`](./long_running_tools.py)).

> The generic recipe lives in [`mcp_toolset_agent.py`](./mcp_toolset_agent.py); the
> long-running shim in [`long_running_tools.py`](./long_running_tools.py).

## Two ADK integration modes

| Mode | File | `mx_delegate_tool` / `mx_run_command` | `running` / `awaiting_approval` |
|---|---|---|---|
| **Generic MCPToolset (T201)** | `mcp_toolset_agent.py` | ordinary MCP tools | ordinary envelopes; resolve with `mx_await_result(handle)` |
| **Native long-running (T202)** | `long_running_tools.py` | ADK `LongRunningFunctionTool`s (canonical names preserved) | a **pending ticket**; the agent keeps working; the host resumes on result |

Both modes share one secret boundary (`safe_mx_mcp_env`), one session mapping, and
one generated `mx-loom-mcp` server. The model **never** receives a trust / policy /
approval-decision tool in either mode — approval is decided **out-of-band** by the
operator and re-validated by the receiving daemon at release.

## What you get

`mx_mcp_toolset(...)` returns an ADK `MCPToolset` connected to a local
`mx-loom-mcp --stdio` subprocess. Through it an ADK agent can:

- **list** the nine canonical tools — `mx_find_agents`, `mx_describe_agent`,
  `mx_delegate_tool`, `mx_run_command`, `mx_await_result`, `mx_share_context`,
  `mx_get_context`, `mx_cancel`, `mx_workspace_status` (and **only** those — no
  `trust.*` / `approval.decide` / `policy.*` / `auth.*` / `device.*` / `daemon.*`
  authority verb is reachable); and
- **call** any of them and receive the normalized **T102 result envelope**
  (`status`, `result`, `error`, `handle`, `approval`, `audit_ref`).

The tool schemas are generated from the canonical `@mx-loom/registry` descriptors
by `@mx-loom/mcp`. ADK never hand-authors or forks them.

## Setup

1. **Install / link `mx-loom-mcp` or provide a launcher.** ADK's
   `StdioServerParameters` spawns one executable `command`; that command must be
   resolvable on `PATH` or absolute.

   In this source workspace, prefer a tiny launcher that runs the source entry with
   `tsx` (the same pattern used by the gated e2e arm):

   ```bash
   cat > /tmp/mx-loom-mcp <<'SH'
   #!/usr/bin/env bash
   exec /absolute/path/to/mx-loom/packages/mcp/node_modules/.bin/tsx \
     /absolute/path/to/mx-loom/packages/mcp/src/cli.ts "$@"
   SH
   chmod 755 /tmp/mx-loom-mcp
   ```

   Then pass `command="/tmp/mx-loom-mcp"` to `mx_mcp_toolset(...)`, or put the
   launcher on `PATH` as `mx-loom-mcp`. A future linked/published standalone bin
   can be used directly once T602 packages the MCP server; do **not** point ADK at
   `packages/mcp/dist/cli.js` directly in this workspace, because workspace package
   exports currently target TypeScript source and plain Node cannot resolve the
   cross-package `./*.js` specifiers.

   Verify: `mx-loom-mcp --stdio` should start and log `connected over stdio` to
   **stderr** once a daemon is reachable (stdout is the MCP protocol channel).

2. **Install Google ADK** (Python). `google-adk` is **not** vendored here; pin the
   version you verify against:

   ```bash
   pip install -r requirements.txt   # or: pip install "google-adk==<pinned>"
   ```

   `mcp_toolset_agent.py` **defers** the ADK imports into its factory functions, so
   you can import the module and exercise `safe_mx_mcp_env(...)` even before ADK is
   installed. The dependency-free smoke is just:

   ```bash
   python examples/adk/mcp_toolset_agent.py
   ```

3. **Verify the ADK import paths against your version.** The example uses:

   ```python
   from google.adk.agents import LlmAgent
   from google.adk.tools.mcp_tool import MCPToolset, StdioServerParameters
   ```

   If your pinned ADK exposes different names, update the deferred imports in
   `mcp_toolset_agent.py` (and this README) to match.

## Session / `ToolContext` mapping

- **One ADK session/agent → one workspace room → one `mx-loom-mcp` process → one
  `MxSession` registration.** Build one toolset per workspace session; do not share
  one MCP process across unrelated rooms.
- The **room** and **correlation id** are *session config* supplied by the host,
  passed to `mx-loom-mcp` as `--room` / `--correlation-id`. They are **never** model
  tool arguments — the model never names a Matrix room.
- A stable `correlation_id` (e.g. `adk_<session_id>`) lets audit rows join ADK
  session activity to daemon invocations.
- ADK **`ToolContext`** may store only **non-secret** values (`mx_room`,
  `mx_correlation_id`, a last-seen deferred `handle` for UI/resume). It is **not**
  an authority store: never put credentials, approval decisions, trust mutations,
  or policy content in it. `mx_session_state(room, correlation_id)` returns the
  exact non-secret shape to stash.
- Optional non-secret workspace metadata (`--cwd`, `--project-id`, `--git-commit`)
  and a concurrency declaration (`--max-invocations`) may also be passed; they ride
  `agent.register`, not model args.

## The secret boundary (read this)

The MCP child is spawned with an **explicit deny-by-default environment** built by
`safe_mx_mcp_env()`. Its deny rules mirror, 1:1, the canonical TypeScript source of
truth in [`packages/toolbelt/src/cli/env.ts`](../../packages/toolbelt/src/cli/env.ts)
(`BASE_ENV_ALLOW` + `isDeniedEnvKey`):

- deny **prefixes** `MATRIX_`, `MX_AGENT_` (whole secret namespaces);
- deny **suffixes** `_TOKEN`, `_API_KEY`, `_SECRET`, `_ACCESS_KEY`;
- deny **exact** `GH_TOKEN`;
- allow only `HOME`, `PATH`, `XDG_RUNTIME_DIR`, `XDG_DATA_HOME`, `TMPDIR`, `LANG`,
  `LC_ALL`, `TERM`, plus the non-secret `MXL_AGENT_BIN` / `MXL_AUDIT_PG` toggles.

So provider keys (`GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`),
`GH_TOKEN`, `MATRIX_*`, `MX_AGENT_*`, and any `*_TOKEN` / `*_API_KEY` / `*_SECRET`
/ `*_ACCESS_KEY` **never** reach the `mx-loom-mcp` child. The ADK host keeps its
model/provider credentials in its own layer and must not forward them.

> The drift guard `packages/mcp/test/cli-options.test.ts` parses the Python deny
> tuples and asserts they equal the exported toolbelt constants — so a divergent
> Python list fails CI rather than silently weakening the boundary.

### `StdioServerParameters` env backstop (blocking secret-boundary decision)

`safe_mx_mcp_env()` only protects the boundary **if** your ADK version's stdio
spawn API actually applies a caller-supplied `env`. If the verified version ignores
or cannot set `env`, **pre-sanitize before spawn**:

1. wrap `mx-loom-mcp` in a tiny launcher that clears the env and re-exports only
   the allowlist, and set that launcher as `command`; **or**
2. guarantee the ADK host process itself holds no Boundary-A secret in its own
   environment at the moment it constructs the toolset.

Do **not** ship depending on an unverified ADK `env` feature.

### Audit DSN caveat

`MXL_AUDIT_PG=1` only *toggles* the Postgres audit mirror; the connection string is
read by `mx-loom-mcp` from `DATABASE_URL` / `PG*`, which can embed a password and is
therefore credential-shaped. `safe_mx_mcp_env()` **denies** it, so audit is **off
by default** for the ADK child (the tap degrades silently). A host that wants the
mirror must forward the DSN **deliberately** through a dedicated, never-logged path.

## Reading results

Every `tools/call` returns the full T102 envelope. Prefer ADK's
`structuredContent` when exposed; otherwise parse the JSON text content
`mx-loom-mcp` always emits.

- `status: "ok"` — success; `result` holds the payload, `audit_ref` is always
  present.
- `status: "denied"` — a **governance** outcome (not a protocol/tool exception):
  the model reads the denial and replans.
- `status: "running"` / `"awaiting_approval"` — **not** a failure. The envelope
  carries a `handle`; the agent keeps working and later calls
  `mx_await_result(handle)`. The [native long-running mode (T202)](#native-long-running-mode-t202)
  turns these into ADK pending tickets that resume automatically.
- `status: "error"` — a genuine fault; `error.code` is from the closed taxonomy
  (`policy_denied`, `untrusted_key`, `approval_denied`, `approval_expired`,
  `timeout`, `not_found`, `invalid_args`, `target_offline`, `internal`).

For mutating retries at the scenario level, supply an explicit `idempotency_key`.

## Native long-running mode (T202)

Google ADK has a native *long-running tool* protocol that matches mx-agent's
deferred approval flow almost exactly: a tool call can return a **pending ticket**,
the agent keeps reasoning / does other work, and the host **resumes** the same call
when the external result is ready. [`long_running_tools.py`](./long_running_tools.py)
wraps the two deferred, approval-bearing verbs as ADK `LongRunningFunctionTool`s
**preserving their canonical names**:

```python
import asyncio
from google.adk.agents import LlmAgent
from long_running_tools import mx_long_running_tool_bundle

async def main():
    bundle = await mx_long_running_tool_bundle(
        room="!workspace:server",
        correlation_id="adk_sess_1",
        command="mx-loom-mcp",  # resolvable on PATH (see Setup step 1)
    )
    try:
        agent = LlmAgent(name="mx_adk_agent", model="<your-model>", tools=bundle.tools)
        # ... drive the agent. When mx_delegate_tool / mx_run_command hit the
        # receiver's approval gate, they return a PENDING TICKET (not a blocking
        # call). The agent can call other mx_* tools meanwhile.
        #
        # The host resumes a held call once the operator decides out-of-band:
        for ticket in bundle.pending_tickets():
            terminal = await bundle.resolve_ticket(ticket.ticket_id, wait_ms=0)
            if terminal.get("status") in ("ok", "denied", "error"):
                resume = bundle.build_resume_content(ticket.ticket_id)  # ADK Content
                # ... inject `resume` into the next runner turn to complete the call.
    finally:
        await bundle.close()  # shuts down the private MCPToolset

asyncio.run(main())
```

Or use the convenience builder that returns `(agent, bundle)`:

```python
from long_running_tools import build_agent_with_long_running
agent, bundle = await build_agent_with_long_running("!workspace:server", "sess_1", model="<your-model>")
```

### How it works

- **Initial dispatch is a non-blocking probe.** The wrapper calls the underlying
  `mx_delegate_tool` / `mx_run_command` MCP tool with `wait_ms=0` (a model-supplied
  `wait_ms` can only *lower* the probe, never force a block that hides the approval
  gate). A terminal `ok` / `denied` / `error` envelope returns immediately as the
  final ADK result. A `running` / `awaiting_approval` envelope becomes a **pending
  ticket**.
- **The pending ticket is secret-free.** It carries the canonical deferred fields
  the model already sees over generic MCP — `status`, `handle`, `approval`
  (`request_id` / `risk` / `summary` / `expires_at` only), `audit_ref` — plus an
  ADK-local `ticket_id`. It is **not** a capability: the `handle` observes the
  daemon's later result; it grants no authority.
- **Resume only observes.** `resolve_ticket(ticket_id)` calls the canonical
  `mx_await_result(handle)` through the same safe MCP path. A still-pending budget
  expiry keeps the ticket pending (never a fabricated `timeout` — T103 semantics); a
  terminal result is cached so repeated resolves are **idempotent** and never
  re-dispatch the original mutation. `build_resume_content(ticket_id)` then builds
  the ADK `Content` (a `FunctionResponse` with the original call id) to complete the
  long-running call.
- **The agent can do other work while pending.** Tickets are keyed by ADK
  function-call id with no global singleton, so many calls can be held at once and
  read/observe verbs (`mx_find_agents`, `mx_workspace_status`, …) keep working.
- **No duplicate names.** The bundle starts one private `MCPToolset`, lists its
  tools, drops the generic `mx_delegate_tool` / `mx_run_command`, and adds the two
  native wrappers with the same names — so the agent sees exactly one of each and
  the other seven `mx_*` verbs unchanged.
- **Idempotency.** A caller-supplied `idempotency_key` is preserved; if omitted, one
  is generated **once per ADK function call** and reused on a retry of that same
  call. Resume is a read and carries no idempotency key.

### Approval stays out-of-band (read this)

The shim **never** approves, decides, or mutates trust/policy. A pending ticket is
an observation handle, not authorization. The operator approves/denies out-of-band
(in the gated e2e, via `scripts/conformance/decide-approval.sh`), and the receiving
daemon **re-runs the authorization pipeline against live trust/policy at release**.
The model is never given an approval-mutation tool and cannot self-approve.

### Verify the ADK long-running API against your version

Like the generic recipe, `long_running_tools.py` **defers** its ADK imports into the
factories, so the module — and its ADK-free core (`MxLongRunningCore`) — import and
run without `google-adk` (try `python long_running_tools.py` for the dependency-free
core smoke). Verify these against your pinned ADK/genai version:

```python
from google.adk.tools import LongRunningFunctionTool
from google.genai import types  # types.Content / Part / FunctionResponse (resume)
```

Confirm that `LongRunningFunctionTool(func=...)` derives the tool name from
`func.__name__` (so the canonical names are preserved), that a `tool_context`
parameter is ADK-injected and excluded from the model-facing declaration, and that
`LlmAgent.tools` accepts the individual MCP tool objects from
`MCPToolset.get_tools(...)` alongside the wrappers. If your version cannot mix
individual MCP tools, the documented fallback is an `MCPToolset` `tool_filter`
excluding `mx_delegate_tool` / `mx_run_command` next to the two native wrappers.

### Limitation

Pending tickets live in process memory for one ADK session; a host crash loses them
(durable `task.watch` resumption is M3 / T302). The single-session pending store is
sufficient for the M2 acceptance.

## Troubleshooting

- **`ENOENT` on spawn** — `mx-loom-mcp` is not resolvable; see *Setup* step 1.
- **Room-scoped tool fails fast** — you omitted `--room`; the room is session
  config, supplied by the host, not by the model.
- **Provider key visible to the child** — your ADK version did not apply `env`;
  use the env backstop above.
- **No `structuredContent`** — parse the JSON `text` content instead; the envelope
  is identical.
- **Treating `awaiting_approval` as an error** — it is a deferred state; resolve it
  with `mx_await_result(handle)`.

## Live two-daemon acceptance (gated)

The T201/#23 e2e acceptance arm lives in
[`packages/golden/test/adk.mcp-toolset.e2e.test.ts`](../../packages/golden/test/adk.mcp-toolset.e2e.test.ts).
It builds an ADK `LlmAgent` with this recipe's `MCPToolset`, lists the generated
`mx_*` tools, calls `mx_find_agents`, then delegates the fixture's allowlisted tool
via `mx_delegate_tool` through `mx-loom-mcp --stdio` and the live daemon pair.
No model/provider call is made.

The **T202 native long-running** acceptance arm lives in
[`packages/golden/test/adk.long-running.e2e.test.ts`](../../packages/golden/test/adk.long-running.e2e.test.ts).
It builds the T202 bundle, verifies `mx_delegate_tool` and `mx_run_command` are ADK
`LongRunningFunctionTool`s with canonical names and no duplicates, drives an
approval-gated delegation to a pending ticket, calls `mx_find_agents` while that
ticket is still held, approves out-of-band via `decide-approval.sh`, resumes to a
terminal `ok` envelope, then also covers the wrapped guarded-command approval path,
an operator-denied delegation (`approval_denied`), and a deny-by-default
`policy_denied` terminal that must surface directly without creating a pending
ticket. It is gated behind
`MXL_ADK_LONG_RUNNING_E2E=1` and the golden two-daemon policy fixture. Like the
T201 arm it skips cleanly by default and fails (rather than silently skipping)
when explicitly requested but Python / `google-adk` / a runnable `mx-loom-mcp` /
the fixture is missing.

By default both ADK arms spawn `mx-loom-mcp` via `tsx packages/mcp/src/cli.ts` (the
proven in-repo subprocess path); no `pnpm build` is required. Set
`MXL_ADK_MCP_COMMAND` to a globally linked / published `mx-loom-mcp` to drive the
real packaged bin instead.

```bash
# Setup: install ADK in a venv/interpreter (tsx ships with pnpm install).
python3 -m venv .venv-adk
. .venv-adk/bin/activate
python -m pip install -r examples/adk/requirements.txt

# Bring up daemon A+B with the golden policy (see scripts/conformance/README.md),
# then run only the generic T201 ADK MCPToolset arm.
MXL_ADK_MCP_E2E=1 \
MXL_ADK_PYTHON="$PWD/.venv-adk/bin/python" \
MXL_CONFORMANCE_TWO_DAEMON=1 \
MXL_CONFORMANCE_SOCKET=… \
MXL_CONFORMANCE_ROOM=… \
MXL_CONFORMANCE_TARGET_AGENT=… \
MXL_CONFORMANCE_TOOL=… \
  pnpm --filter @mx-loom/golden exec vitest run \
  --config vitest.e2e.config.ts test/adk.mcp-toolset.e2e.test.ts

# Run the T202 ADK LongRunningFunctionTool approval/resume arm. This requires the
# golden policy coordinates because it drives an approval-gated tool and command.
MXL_ADK_LONG_RUNNING_E2E=1 \
MXL_ADK_PYTHON="$PWD/.venv-adk/bin/python" \
MXL_CONFORMANCE_TWO_DAEMON=1 \
MXL_CONFORMANCE_GOLDEN_POLICY=1 \
MXL_CONFORMANCE_SOCKET=… \
MXL_CONFORMANCE_ROOM=… \
MXL_CONFORMANCE_TARGET_AGENT=… \
MXL_CONFORMANCE_TOOL=… \
MXL_CONFORMANCE_APPROVAL_TOOL=… \
MXL_CONFORMANCE_DENIED_TOOL=… \
MXL_CONFORMANCE_ALLOWED_COMMAND=… \
MXL_CONFORMANCE_ALLOW_CWD=… \
  pnpm --filter @mx-loom/golden exec vitest run \
  --config vitest.e2e.config.ts test/adk.long-running.e2e.test.ts

# Optional: exercise a real linked/published mx-loom-mcp bin instead of tsx+source.
export MXL_ADK_MCP_COMMAND=/absolute/path/to/mx-loom-mcp

# Cleanup.
unset MXL_ADK_MCP_E2E MXL_ADK_LONG_RUNNING_E2E MXL_ADK_PYTHON MXL_ADK_MCP_COMMAND
scripts/conformance/down.sh
```

If `MXL_ADK_MCP_E2E` / `MXL_ADK_LONG_RUNNING_E2E` are unset, the ADK arms skip
cleanly. If either is set but Python, `google-adk`, a runnable `mx-loom-mcp`
command, or the required daemon fixture is missing, it fails rather than reporting
a misleading green. T206 later extends this into the full M2 portability matrix.
