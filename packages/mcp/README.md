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

**OpenCode** (`opencode.json`):

```jsonc
{
  "mcp": {
    "mx-loom": { "type": "local", "command": ["mx-loom-mcp", "--stdio"] }
  }
}
```

**Google ADK** (`MCPToolset`, Python — mounts this stdio server on an `LlmAgent`):

```python
from google.adk.tools.mcp_tool import MCPToolset, StdioServerParameters

toolset = MCPToolset(
    connection_params=StdioServerParameters(command="mx-loom-mcp", args=["--stdio"]),
)
```

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
