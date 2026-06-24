# @mx-loom/mcp

The **generated MCP server** for the mx-loom tool fabric (`area/mcp`, **T109 / #17**).

It turns the canonical `@mx-loom/registry` descriptor set into a live **Model
Context Protocol** endpoint — the *universal binding* for MCP-capable target
runtimes (Claude / ADK / OpenCode / custom). **Pi is the exception:** T204
recorded that `@earendil-works/pi-coding-agent` has no built-in MCP client today,
so the Pi arm uses native tool registration (`ToolDefinition[]`) instead of
mounting this server; MCP for Pi is only a possible future extension-mediated
path. This package remains the MCP half of mx-loom's locked design decision #1
("both bindings in parallel"): one canonical, transport-neutral tool registry
feeds **both** this generated MCP server **and** native shims such as the Claude
Agent SDK binding (T110).

> **Generated, never hand-authored.** Tools come from *enumerating the registry*
> (`CANONICAL_M1_TOOLS`). Add a tenth descriptor (plus its handler) and it surfaces
> over MCP with **no edit** to this package's per-tool code.

## The secret boundary

The MCP server lives in the adaptation plane and is **secret-free by
construction**. It never holds or forwards Matrix tokens, Ed25519 signing keys,
provider keys, or `GH_TOKEN`. It reaches the daemon **only** through the toolbelt
`MxClient` / `MxSession`, so:

- the deny-by-default env allowlist stays in force;
- a credential-shaped outbound `args` key is rejected (`invalid_args`) **before**
  dispatch (`assertNoCredentialShapedArgs`);
- inbound daemon results are run through `redactSecrets`.

Every **enforcement** decision — trust (Ed25519 store), deny-by-default
`policy.toml`, sandbox, human approval gates — runs **out-of-process on the
receiving mx-agent daemon**. The connected runtime (cognition) can only produce a
signed request; this server cannot grant authority and exposes no surface to do
so. It surfaces **only** the nine model-facing verbs — `trust.*`,
`approval.decide`, `policy.*`, `auth.*`, `device.*`, `daemon.*` are structurally
unreachable. Approval reaches the model **only** as the `awaiting_approval` status.

## The nine tools

Generated from `CANONICAL_M1_TOOLS`, with each descriptor's draft-07 `input_schema`
passed through **verbatim** as the MCP `inputSchema`. The MCP `outputSchema` is the
shared T102 envelope schema (`ENVELOPE_SCHEMA`) — `structuredContent` carries the
full envelope, so that, not the descriptor's bare-result schema, is what a
conformant client validates against:

| Tool | Purpose | Async |
|---|---|---|
| `mx_find_agents` | Discover agents in the workspace | sync |
| `mx_describe_agent` | An agent's published tool schemas | sync |
| `mx_delegate_tool` | Invoke a named tool on a remote agent | deferred |
| `mx_run_command` | Guarded remote command (receiver-policed) | deferred |
| `mx_await_result` | Resolve a deferred `handle` to a terminal result | sync |
| `mx_share_context` | Publish a diff/file/env snapshot | sync |
| `mx_get_context` | Fetch shared context by id | sync |
| `mx_cancel` | Cancel an in-flight invocation | sync |
| `mx_workspace_status` | Registered agents + project context | sync |

## The result envelope over MCP

Every tool returns the normalized T102 envelope, serialized onto an MCP
`CallToolResult`:

- **`structuredContent`** ← the **full** envelope (`status`, `result`, `error`,
  `handle`, `approval`, `audit_ref`) — the machine-readable channel a modern client
  reacts to programmatically.
- **`content[0]`** ← a `text` JSON rendering of the same envelope, for clients
  that do not read `structuredContent`.
- **`isError`** ← `true` **only** for `status: "error"` (a genuine fault).
  `denied`, `awaiting_approval`, `running`, and `ok` are **not** `isError`: a
  `denied` is a *governance outcome* the model must read and replan around, and
  `awaiting_approval` / `running` are legitimate in-progress states. Flagging them
  as protocol errors would push runtimes to retry/abort instead of awaiting.

### `awaiting_approval` → `mx_await_result`

Generic MCP has no native long-running-tool protocol (that is ADK's
`LongRunningFunctionTool`, M2). A `deferred` tool that returns
`running` / `awaiting_approval` surfaces the `handle` (and, for approval, the
`approval` block) in `structuredContent`. The model keeps working and later
resolves it by calling the ordinary **`mx_await_result(handle)`** tool. This
server faithfully surfaces the handle; it does not hide the poll loop (that is the
per-runtime shim's job). Handlers honor an optional inline `wait_ms`, passed
through unchanged, and never block unboundedly.

## Usage

### stdio (local subprocess — ADK / OpenCode / Claude-external default)

```bash
mx-loom-mcp --stdio          # default transport
```

**Claude Code / Claude Desktop** (`mcpServers` entry):

```jsonc
{
  "mcpServers": {
    "mx-loom": { "command": "mx-loom-mcp", "args": ["--stdio"] }
  }
}
```

**OpenCode** (`opencode.json`, T203). OpenCode consumes this same server via the
`mcp` block — local stdio or remote HTTP. The **full, safe** recipe — the
scrubbed-launch secret boundary, the per-server `environment` allowlist, session
mapping, and the remote entry — lives in
[`examples/opencode`](../../examples/opencode/README.md). The minimal local shape:

```jsonc
{
  "mcp": {
    "mx-loom": {
      "type": "local",
      "command": ["mx-loom-mcp", "--stdio", "--room", "!workspace:server",
                  "--kind", "opencode", "--correlation-id", "opencode_<session-id>"]
    }
  }
}
```

and the remote shape (start `mx-loom-mcp --http` separately; localhost-only):

```jsonc
{
  "mcp": {
    "mx-loom": { "type": "remote", "url": "http://127.0.0.1:7800" }
  }
}
```

OpenCode's per-server `environment` field **adds** vars (it does not reset), so the
load-bearing secret control is launching OpenCode itself from a scrubbed
environment — see the example README. The acceptance e2e is
`packages/golden/test/opencode.mcp-entry.e2e.test.ts` (gated `MXL_OPENCODE_MCP_E2E=1`).

**Google ADK** (`MCPToolset`, Python — mounts this stdio server on an `LlmAgent`).
The **full, safe** recipe — deny-by-default child env, session/`ToolContext`
mapping, and the non-secret session flags below — lives in
[`examples/adk`](../../examples/adk/README.md) (T201). The minimal shape:

```python
from google.adk.agents import LlmAgent
from google.adk.tools.mcp_tool import MCPToolset, StdioServerParameters
from mcp_toolset_agent import safe_mx_mcp_env

# `env=` MUST be an explicit deny-by-default allowlist (no provider keys, no
# MATRIX_*/MX_AGENT_*, no *_TOKEN/_API_KEY/_SECRET/_ACCESS_KEY, no GH_TOKEN) —
# mirror packages/toolbelt/src/cli/env.ts. See examples/adk/mcp_toolset_agent.py
# (`safe_mx_mcp_env`). The room + correlation id are session config, never model
# tool args.
agent = LlmAgent(
    name="mx_adk_agent",
    model="<configured-by-host>",
    tools=[
        MCPToolset(
            connection_params=StdioServerParameters(
                command="mx-loom-mcp",
                args=["--stdio", "--room", "!workspace:server", "--kind", "adk",
                      "--correlation-id", "adk_<session_id>"],
                env=safe_mx_mcp_env(),  # explicit safe child env
            ),
        ),
    ],
)
```

Generic `MCPToolset` surfaces `running` / `awaiting_approval` as ordinary
envelopes resolved later with `mx_await_result(handle)`. For approval-aware
**native long-running** behavior, [`examples/adk`](../../examples/adk/README.md)
also ships the **T202** shim ([`long_running_tools.py`](../../examples/adk/long_running_tools.py)):
`mx_delegate_tool` / `mx_run_command` become ADK `LongRunningFunctionTool`s
(canonical names preserved) that return a **pending ticket** and resume on the
terminal result, while the other seven `mx_*` verbs stay ordinary MCP tools. It
routes initial dispatch + resume back through this same generated server, so the
secret boundary, session registration, redaction, and audit tap stay centralized;
the model is never given an approval-mutation tool.

#### Non-secret session flags (one process ⇒ one `MxSession`)

For robust ADK session mapping the `bin` accepts non-secret session metadata in
addition to `--room` / `--kind`:

| Flag | Maps to | Notes |
|---|---|---|
| `--correlation-id <id>` | `openSession({ correlationId })` | joins ADK session activity to audit rows |
| `--cwd <path>` | `openSession({ workspace: { cwd } })` | flat `agent.register` param (v0.2.1) |
| `--project-id <id>` | `openSession({ workspace: { project_id } })` | |
| `--git-commit <sha>` | `openSession({ workspace: { git_commit } })` | |
| `--max-invocations <n>` | `openSession({ maxInvocations })` | positive integer |

These are **session config**, not model tool args and not credentials. There is
no flag for Matrix credentials, signing/provider keys, `GH_TOKEN`, trust stores,
policy paths, or approval decisions — those never cross Boundary A and are
enforced out-of-process on the receiving daemon.

### remote (Streamable HTTP)

```bash
mx-loom-mcp --http --host 127.0.0.1 --port 7800
```

> **Localhost bind by default.** The remote transport binds to `127.0.0.1`. The
> server adds **no** authentication. Exposing the endpoint beyond localhost is
> explicit operator opt-in and **must** sit behind an authenticated reverse proxy.
> Even an unauthenticated reachable endpoint cannot escalate privilege — the daemon
> independently enforces trust/policy/approval per request and the server holds no
> secret — but an open endpoint would let an unauthorized caller *issue requests as
> this agent*, so the default-deny bind and a fronting proxy are mandatory before
> any non-local exposure.

### Audit (opt-in)

Off by default (`NullAuditSink`). Enable the Postgres queryable-index mirror
(T113) with `--audit` or `MXL_AUDIT_PG=1`; connection config comes from the
standard `DATABASE_URL` / `PG*` env and is never logged. The tap is best-effort:
a Postgres outage degrades the queryable index but never blocks a tool call.

```bash
MXL_AUDIT_PG=1 DATABASE_URL=postgres://… mx-loom-mcp --stdio
```

## Library surface

For T110 / T201 / T203 / T114 to embed or drive the server programmatically
(and for T205/Pi to use as reference code, not a runtime dependency):

```ts
import { createBindingContext, createMcpServer } from '@mx-loom/mcp';

const ctx = await createBindingContext({ sessionOptions: { room: '…' } });
const server = createMcpServer(ctx); // low-level SDK Server, ready to connect(transport)
```

Also exported: `buildToolList` (descriptors → MCP `Tool[]`), `serializeToolResult`
(`ToolResult` → `CallToolResult`), and `DISPATCH` / `dispatchCall` (name → handler).

## Conformance

The unit + in-memory round-trip suites (AC1 list, AC2 delegate round-trip, AC3
`awaiting_approval` surfacing) run with no daemon. The **live two-daemon MCP
conformance arm** — and the wire-shape assumptions it inherits (`call.start` param
names, `CallResponse` disposition vocabulary, `audit_ref` availability) — stage
behind `MXL_CONFORMANCE_TWO_DAEMON=1`, pinned at the round-trip. The full
golden end-to-end (approval-gated, both bindings) is **T114**.
