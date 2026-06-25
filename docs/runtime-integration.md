# Runtime integration guide

**How to mount the mx-loom toolbelt in your agent runtime.** One verified,
copy-pasteable setup per runtime — **Google ADK, the Claude Agent SDK, Claude
Code / Desktop, OpenCode, Pi, and custom runners** — each cross-referenced to the
gated e2e arm that proves it works.

mx-loom is the thin, secret-free **adaptation** layer between your runtime's
tool-calling ABI (**Boundary A**) and the mx-agent daemon's Unix-socket JSON-RPC
(**Boundary B**). Your runtime owns cognition (the model loop, planning, memory);
the receiving mx-agent daemon owns coordination (signing, trust, `policy.toml`,
sandbox, approval). mx-loom only translates — it holds no secret, runs no model,
and enforces nothing. For the full architecture see
[`mx-agent-tool-fabric-design.md`](./mx-agent-tool-fabric-design.md) §1 and §3.

> **Build rule.** One canonical descriptor set → every binding. The thirteen `mx_*`
> verbs are **generated** from [`@mx-loom/registry`](../packages/registry); no
> binding is ever hand-authored per runtime. This guide is a **hub**: each section
> gives the single default recipe and links the per-runtime README as the
> canonical deep reference for troubleshooting, env-backstop nuances, and the
> alternate modes.

## Pick your runtime

| Runtime | Integration mechanism | Deep reference |
|---|---|---|
| **Google ADK** (Python) | `MCPToolset` over `mx-loom-mcp --stdio`; optional `LongRunningFunctionTool` | [`examples/adk/README.md`](../examples/adk/README.md) |
| **Claude Agent SDK** (TS) | in-process `createSdkMcpServer` + `tool()` + `canUseTool` | [`packages/claude/README.md`](../packages/claude/README.md) |
| **Claude Code / Desktop** | `mcpServers` entry → `mx-loom-mcp --stdio` | [`packages/mcp/README.md`](../packages/mcp/README.md) |
| **OpenCode** | `opencode.json` `mcp` entry (local stdio / remote HTTP) | [`examples/opencode/README.md`](../examples/opencode/README.md) |
| **Pi** | native tool registration (`@mx-loom/pi`, no MCP client) | [`packages/pi/README.md`](../packages/pi/README.md) |
| **Custom** | mount `mx-loom-mcp`, or link `@mx-loom/toolbelt` directly | [this guide](#custom-runners) |

Every MCP-mounting runtime (ADK, Claude Code/Desktop, OpenCode, custom) consumes
the **same** generated `mx-loom-mcp` server. Claude (in-process) and Pi (native
registration) link the library directly — same descriptors, same envelope, no
socket.

## The thirteen canonical verbs

Every runtime surfaces exactly these — and **only** these:

| Tool | Purpose | Async |
|---|---|---|
| `mx_find_agents` | Discover agents in the workspace | sync |
| `mx_describe_agent` | An agent's published tool schemas | sync |
| `mx_delegate_tool` | Invoke a named tool on a remote agent | deferred |
| `mx_run_command` | Guarded remote command (receiver-policed, off by default) | deferred |
| `mx_await_result` | Resolve a deferred `handle` to a terminal result | sync |
| `mx_share_context` | Publish a diff / file / env snapshot | sync |
| `mx_get_context` | Fetch shared context by id | sync |
| `mx_cancel` | Cancel an in-flight invocation | sync |
| `mx_workspace_status` | Registered agents + project context | sync |
| `mx_create_task` | Author a task (with deps + a signed action) into the shared plan (DAG) | sync |
| `mx_update_task` | Transition a task's state / re-assign / adjust edges | sync |
| `mx_list_tasks` | Read the shared plan as a DAG (nodes + edges) or a flat list | sync |
| `mx_dispatch_task` | Dispatch a task's authored signed action through the full authorize pipeline | deferred |

The last four are the **M3 task-DAG verbs** — the first three (T301) let cognition
author and read the durable shared plan (`com.mxagent.task.v1`); `mx_dispatch_task`
(**T303**) takes a node's authored signed `action` and **runs** it, re-routing a
`kind: 'tool'` action through `mx_delegate_tool` (`call.start`) and a `kind: 'exec'`
action through `mx_run_command` (`exec.start`) so it traverses the **identical**
receiver-side authorize pipeline. Authoring an action is never authorizing it:
dispatch re-runs sig → trust → policy → sandbox → approval on the receiver from
scratch. The exact `task.*` wire shapes are staged behind the two-daemon
conformance fixture.

**No** `trust.*` / `approval.decide` / `policy.*` / `auth.*` / `device.*` /
`daemon.*` verb is ever surfaced — they are **structurally unreachable**.
Cognition can produce only a *signed request*; it can never grant itself
authority. Approval reaches the model **only** as the `awaiting_approval` result
status, re-validated against live policy on the receiving daemon at release.

## Universal prerequisites

These hold for every runtime; the per-runtime sections do not repeat them.

1. **A reachable mx-agent daemon** (Boundary B), pinned to **`v0.2.1`** — see
   [`docs/mx-agent-pin.md`](./mx-agent-pin.md). mx-loom targets one known-good
   substrate version, not `main`.

2. **The `mx-loom-mcp` launcher** (for the MCP-mounting runtimes: ADK, Claude
   Code/Desktop, OpenCode, custom). Today's **verified** path is a tiny launcher
   that runs the source entry with `tsx` — the same path the gated e2e arms drive.
   The published standalone `mx-loom-mcp` bin is **future (T602, M6)**; do not
   assume it exists yet.

   <!-- Verified launcher pattern; source of truth: examples/adk/README.md + examples/opencode/README.md "Setup" step 1. -->
   ```bash
   cat > /usr/local/bin/mx-loom-mcp <<'SH'
   #!/usr/bin/env bash
   exec /absolute/path/to/mx-loom/packages/mcp/node_modules/.bin/tsx \
     /absolute/path/to/mx-loom/packages/mcp/src/cli.ts "$@"
   SH
   chmod 755 /usr/local/bin/mx-loom-mcp
   ```

   > **Do not** point a runtime at `packages/mcp/dist/cli.js` directly in this
   > source workspace: every `@mx-loom/*` package's `exports` targets TypeScript
   > source, so the built bin's cross-package `./*.js` specifiers do not resolve
   > under plain `node` until the standalone bin is published (T602). Verify the
   > launcher with `mx-loom-mcp --stdio`: it logs `connected over stdio` to
   > **stderr** once a daemon is reachable (stdout is the MCP protocol channel).

3. **The session-mapping rule.** **One runtime session ⇒ one `mx-loom-mcp`
   process / one `MxSession` ⇒ one workspace room.** Build one toolset/entry per
   workspace session; do not share one process across unrelated rooms (tenant
   scoping is M5). The **room** and **correlation id** are *session config*
   supplied by the host — passed as `--room` / `--correlation-id` — and are
   **never** model tool arguments. The model never names a Matrix room. A stable
   `correlation_id` (e.g. `adk_<session_id>`, `opencode_<session-id>`) joins your
   runtime's session activity to daemon audit rows. The full non-secret session
   flag set is documented under [the `mx-loom-mcp` CLI surface](#the-mx-loom-mcp-cli-surface).

## The secret boundary (read this)

This is the load-bearing cross-cutting rule. **Matrix tokens, Ed25519 signing
keys, provider keys, and `GH_TOKEN` never cross Boundary A** into the runtime
process, the model context, or any runner child. Runner children receive
retrieved **TEXT** only, never credentials.

- **The canonical source of truth** for the deny-by-default env allowlist is
  [`packages/toolbelt/src/cli/env.ts`](../packages/toolbelt/src/cli/env.ts)
  (`BASE_ENV_ALLOW` + `isDeniedEnvKey`): deny **prefixes** `MATRIX_`, `MX_AGENT_`;
  deny **suffixes** `_TOKEN`, `_API_KEY`, `_SECRET`, `_ACCESS_KEY`; deny **exact**
  `GH_TOKEN`; allow only `HOME`, `PATH`, `XDG_RUNTIME_DIR`, `XDG_DATA_HOME`,
  `TMPDIR`, `LANG`, `LC_ALL`, `TERM`, plus the non-secret `MXL_*` toggles.

- **Per-runtime nuance** (each section links the detail):
  - **ADK** spawns the child with an explicit `env=safe_mx_mcp_env()` that mirrors
    the toolbelt allowlist 1:1 (drift-guarded). If your ADK version ignores a
    caller-supplied `env`, pre-sanitize before spawn — see the ADK README's
    *`StdioServerParameters` env backstop*.
  - **OpenCode**'s per-server `environment` field only **adds** variables; it does
    **not** reset the inherited env. So the load-bearing control is **launching
    OpenCode itself from a scrubbed environment**.
  - **Claude in-process** and **Pi** start **no** child and read **no** env for
    daemon access. Every call rides the toolbelt `MxClient` / `MxSession`, so the
    guards stay in force unchanged.

- **Configs and launch flags carry only non-secret session config.** Never put a
  credential-shaped value in `opencode.json`, a launcher, a prompt, or a log. No
  tool field carries a credential inbound or outbound: a credential-shaped `args`
  key is rejected (`invalid_args`) **before** dispatch
  (`assertNoCredentialShapedArgs`), and inbound daemon values are run through
  `redactSecrets`.

- **Audit-DSN caveat.** `DATABASE_URL` / `PG*` is credential-shaped and therefore
  **denied by default**, so the Postgres audit mirror is **off** unless a host
  deliberately forwards the DSN through a dedicated, never-logged path.

- **Remote exposure** (OpenCode / custom over HTTP). `mx-loom-mcp --http` binds
  `127.0.0.1` and adds **no** authentication. Non-local exposure is explicit
  operator opt-in and **must** sit behind an authenticated reverse proxy: the
  daemon still independently enforces trust/policy/approval per request, but an
  open endpoint would let an unauthorized caller *issue requests as this agent*.
  Any proxy credential is an operational secret — never in committed config,
  prompts, tool args, or logs.

- **Out-of-process enforcement is authoritative.** Trust (Ed25519 store),
  deny-by-default `policy.toml`, sandbox, and human approval gates all run on the
  **receiving daemon**, not in the runtime. The toolbelt only translates; it
  cannot grant authority. There is **no** model-facing trust / policy / approval
  mutation tool — approval reaches the model **only** as the `awaiting_approval`
  result status. Every result carries `audit_ref`; never strip it.

---

## Google ADK

Mount the generated `mx-loom-mcp` server on an ADK
[`LlmAgent`](https://google.github.io/adk-docs/) as an `MCPToolset`. This is the
**default (generic) recipe** — `running` / `awaiting_approval` surface as ordinary
envelopes you resolve later with `mx_await_result(handle)`.

<!-- Verbatim from examples/adk/README.md (source of truth); driven by adk.mcp-toolset.e2e.test.ts. -->
```python
from mcp_toolset_agent import mx_mcp_toolset
from google.adk.agents import LlmAgent

agent = LlmAgent(
    name="mx_adk_agent",
    model="<your-model>",
    tools=[mx_mcp_toolset(room="!workspace:server")],
)
```

`mx_mcp_toolset(...)` returns an `MCPToolset` connected to a local
`mx-loom-mcp --stdio` subprocess spawned with the deny-by-default
`safe_mx_mcp_env()`. **What the model sees:** the thirteen `mx_*` tools and the T102
envelope — nothing else.

**Alternate mode — native long-running (T202).** For approval-aware delegation,
wrap `mx_delegate_tool` / `mx_run_command` as ADK `LongRunningFunctionTool`s
(canonical names preserved) so an approval gate returns a **pending ticket** the
host resumes on result. See
[`examples/adk/README.md` → *Native long-running mode (T202)*](../examples/adk/README.md#native-long-running-mode-t202)
([`long_running_tools.py`](../examples/adk/long_running_tools.py)).

**Verify it.** The generic recipe is driven by
[`packages/golden/test/adk.mcp-toolset.e2e.test.ts`](../packages/golden/test/adk.mcp-toolset.e2e.test.ts)
(`MXL_ADK_MCP_E2E=1` + the two-daemon golden fixture); the long-running mode by
[`packages/golden/test/adk.long-running.e2e.test.ts`](../packages/golden/test/adk.long-running.e2e.test.ts)
(`MXL_ADK_LONG_RUNNING_E2E=1` + `MXL_CONFORMANCE_GOLDEN_POLICY=1`). Both skip
cleanly without the fixture and fail (never silently skip) when demanded but
Python / `google-adk` / a runnable `mx-loom-mcp` is missing. The
[ADK README's *Live two-daemon acceptance*](../examples/adk/README.md#live-two-daemon-acceptance-gated)
section has the full env-flag invocation.

## Claude Agent SDK

The Claude Agent SDK is the mx-agency default runner, and `createSdkMcpServer` is
itself an in-process MCP server — so the toolbelt runs **inside** the agent
process with no socket, no subprocess, no launcher. This is the **default Claude
recipe**.

<!-- Verbatim from packages/claude/README.md (source of truth); exercised by the T114 golden Claude arm. -->
```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createBindingContext } from '@mx-loom/mcp';
import { createMxToolServer, createMxCanUseTool, mxToolName } from '@mx-loom/claude';

const ctx = await createBindingContext({ /* session / daemon / sessionOptions */ });
const mx = createMxToolServer(ctx);                 // in-process MCP server config
const canUseTool = createMxCanUseTool({             // the HITL hook
  onApprovalRequest: async (summary) => {
    // summary is secret-free: { tool, agent?, command?, args_summary, risk }
    return /* your operator UI / CLI */ 'allow';
  },
});

for await (const msg of query({
  prompt,
  options: {
    mcpServers: { mx },
    canUseTool,
    allowedTools: [mxToolName('mx_delegate_tool'), mxToolName('mx_await_result')],
  },
})) {
  /* … */
}

await ctx.close();
```

**What the model sees:** each verb namespaced as `mcp__mx__<verb>` — use
`mxToolName('mx_delegate_tool')` → `mcp__mx__mx_delegate_tool` for `allowedTools`.
The `mx_await_result` poll loop is **hidden**, so a delegated call looks
synchronous (one tool call → the terminal result). `canUseTool` is a
**requester-side local gate**: a local deny short-circuits before signing; a local
allow only permits the request to be signed — the receiving daemon still
independently enforces trust / policy / approval. `onApprovalRequest` is wired to
a human, never to the model.

**Alternate mode — external MCP.** Claude can also mount `mx-loom-mcp` as an
external server via `options.mcpServers` exactly like Claude Code below; the
in-process shim is preferred (cleanest HITL hook, no subprocess).

**Verify it.** Exercised by the M1 golden gate (T114) in `@mx-loom/golden` —
[`packages/golden/test/golden.claude.e2e.test.ts`](../packages/golden/test/golden.claude.e2e.test.ts)
drives the in-process shim through the S1–S8 scenario against the live two-daemon
golden fixture (`MXL_CONFORMANCE_TWO_DAEMON=1`; the scripted-cognition arm is the
gate, an opt-in real-model `query()` arm rides `MXL_GOLDEN_LIVE_MODEL=1` +
`ANTHROPIC_API_KEY`). Deep reference:
[`packages/claude/README.md`](../packages/claude/README.md).

## Claude Code / Desktop

Add a `mcpServers` entry pointing at `mx-loom-mcp --stdio`:

<!-- Verbatim from packages/mcp/README.md (source of truth). -->
```jsonc
{
  "mcpServers": {
    "mx-loom": { "command": "mx-loom-mcp", "args": ["--stdio"] }
  }
}
```

Append the non-secret session flags to `args` to map this client to a workspace
room (`"--room", "!workspace:server", "--correlation-id", "claude_<session-id>"`)
— see [the CLI surface](#the-mx-loom-mcp-cli-surface). **What the model sees:** the
thirteen `mx_*` tools and the T102 envelope; generic MCP has no native long-running
protocol, so `running` / `awaiting_approval` surface as ordinary results resolved
with `mx_await_result(handle)`.

**Verify it.** This is the same universal `mx-loom-mcp` server the cross-runtime
portability matrix proves
([`packages/golden/test/portability-matrix.e2e.test.ts`](../packages/golden/test/portability-matrix.e2e.test.ts),
`MXL_PORTABILITY_MATRIX=1`); the in-memory list + delegate round-trip is covered
daemon-free in `@mx-loom/mcp`. Deep reference:
[`packages/mcp/README.md`](../packages/mcp/README.md).

## OpenCode

Mount the generated server from `opencode.json` — local stdio (OpenCode spawns the
child) or remote HTTP (you run `mx-loom-mcp --http` separately). This **local
stdio** block is the default:

<!-- Byte-identical to examples/opencode/opencode.local.example.json (source of truth, pinned by packages/mcp/test/opencode-config.test.ts). -->
```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mx-loom": {
      "type": "local",
      "enabled": true,
      "command": [
        "mx-loom-mcp",
        "--stdio",
        "--room",
        "!workspace:server",
        "--kind",
        "opencode",
        "--correlation-id",
        "opencode_<session-id>"
      ],
      "environment": {
        "PATH": "{env:PATH}",
        "HOME": "{env:HOME}",
        "XDG_RUNTIME_DIR": "{env:XDG_RUNTIME_DIR}"
      }
    }
  }
}
```

**Remote variant** — start `mx-loom-mcp --http --host 127.0.0.1 --port 7800`
(carrying the same `--room` / `--kind` / `--correlation-id`), then point OpenCode
at the server **root** (no `/mcp` path segment):

<!-- Byte-identical to examples/opencode/opencode.remote.example.json (source of truth). -->
```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mx-loom": {
      "type": "remote",
      "enabled": true,
      "url": "http://127.0.0.1:7800"
    }
  }
}
```

> **Scrubbed launch is load-bearing.** OpenCode's `environment` field only *adds*
> variables — it does not reset the inherited env. Launch OpenCode (`opencode
> serve` / your launcher) from a deny-by-default environment that holds no
> provider key, no `MATRIX_*` / `MX_AGENT_*`, no `*_TOKEN` / `*_API_KEY` /
> `*_SECRET` / `*_ACCESS_KEY`, and no `GH_TOKEN`. See
> [`examples/opencode/README.md` → *The secret boundary*](../examples/opencode/README.md#the-secret-boundary-read-this).
> For non-local exposure see [the secret boundary](#the-secret-boundary-read-this)
> above — keep the `url` localhost behind an authenticated proxy.

**What the model sees:** OpenCode namespaces MCP tools by server name (e.g.
`mx-loom_mx_delegate_tool`); the underlying tool is still `mx_delegate_tool` and
the envelope is identical.

**Verify it.**
[`packages/golden/test/opencode.mcp-entry.e2e.test.ts`](../packages/golden/test/opencode.mcp-entry.e2e.test.ts)
(`MXL_OPENCODE_MCP_E2E=1`) renders this `opencode.json`, starts `opencode serve`
from a scrubbed env, and asserts the `mx-loom` server connects and surfaces
exactly the canonical `mx_*` tools (with an optional model-in-loop
`mx_delegate_tool` call behind `MXL_OPENCODE_MODEL`). The committed example files
are additionally pinned daemon-free by
[`packages/mcp/test/opencode-config.test.ts`](../packages/mcp/test/opencode-config.test.ts).

## Pi

Pi ships **no built-in MCP client** (the T204 decision —
[`docs/pi-tool-surface-capability.md`](./pi-tool-surface-capability.md)), so the Pi
binding registers the thirteen verbs through Pi's **native tool API** instead of
mounting `mx-loom-mcp`. The schemas are still generated from `@mx-loom/registry`;
enums become `StringEnum` (Google-provider-safe).

<!-- Verbatim from packages/pi/README.md (source of truth); driven by t205-pi-binding.e2e.test.ts. -->
```ts
import { Type } from 'typebox';                         // Pi's bundled TypeBox
import { StringEnum } from '@earendil-works/pi-ai';      // the Google-safe enum helper
import { createAgentSession } from '@earendil-works/pi-coding-agent';
import { createPiBindingContext, createPiToolDefinitions, mxToolNames } from '@mx-loom/pi';

// 1. Open the secret-free binding context (registers an MxSession; correlation +
//    liveness heartbeat). For tests, inject a session / bare DaemonCall instead.
const ctx = await createPiBindingContext({ /* sessionOptions, auditSink */ });

// 2. Generate the thirteen mx_* tools, injecting Pi's TypeBox builders.
const customTools = createPiToolDefinitions(ctx, { builders: { Type, StringEnum } });

// 3. Hand them to Pi, and (optionally) activate ONLY the mx-loom verbs.
const { session } = await createAgentSession({
  customTools,
  noTools: 'builtin',          // drop Pi's built-ins …
  tools: mxToolNames(),        // … and enable only the mx_* verbs
});
```

Pi takes the Pi SDK, TypeBox, and `@earendil-works/pi-ai` as **peer**
dependencies and the `Type` / `StringEnum` builders are **injected by you**
(resolved from Pi's own tree, so a single TypeBox runtime satisfies Pi's `[Kind]`
identity check). **What the model sees:** the thirteen verbs in `content`+`details`
(Pi has no MCP `structuredContent` channel); deferred results stay **model-driven**
— `promptGuidelines` tell the model to call `mx_await_result(handle)` (no hidden
poll loop).

**Verify it.**
[`packages/golden/test/t205-pi-binding.e2e.test.ts`](../packages/golden/test/t205-pi-binding.e2e.test.ts)
(`MXL_PI_BINDING_E2E=1` + the two-daemon golden fixture) drives a Pi agent calling
`mx_delegate_tool`; a 331-test daemon-free suite covers the rest. Deep reference:
[`packages/pi/README.md`](../packages/pi/README.md).

## Custom runners

Anything that can call a Unix socket and accept a JSON-Schema tool list gets the
tools for free. Two paths:

### Path 1 — your runner speaks MCP

Point it at `mx-loom-mcp --stdio` (or `--http` on localhost) **exactly like Claude
Code** above. The `tools/list` (each descriptor's draft-07 `input_schema` passed
through verbatim), the T102 envelope on every `CallToolResult`, and the thirteen verbs
are identical across every MCP-mounting runtime. Append the non-secret session
flags (`--room` / `--correlation-id` / …) to your spawn argv; never a credential.

```jsonc
// minimal MCP server entry — adapt to your runtime's config shape
{ "command": "mx-loom-mcp", "args": ["--stdio", "--room", "!workspace:server",
                                      "--correlation-id", "custom_<session-id>"] }
```

### Path 2 — your runner links the library

Depend on `@mx-loom/toolbelt` + `@mx-loom/registry`, open a session, enumerate the
canonical descriptors for your tool list, and dispatch each call through the
registry handlers. Use [`@mx-loom/mcp`](../packages/mcp)'s `dispatchCall` as the
reference pattern (it is exactly what every MCP-mounting runtime runs under the
hood):

```ts
import { CANONICAL_M1_TOOLS } from '@mx-loom/registry';
import { dispatchCall, createBindingContext, serializeToolResult } from '@mx-loom/mcp';

// 1. One session ⇒ one MxSession ⇒ one room (secret-free; the toolbelt guards stay in
//    force). createBindingContext opens the MxSession (toolbelt openSession) for you;
//    link @mx-loom/toolbelt directly if you want to own the session lifecycle.
const ctx = await createBindingContext({ sessionOptions: { room: '!workspace:server' } });

// 2. Your tool list = the canonical descriptors, rendered into your runtime's ABI.
for (const descriptor of CANONICAL_M1_TOOLS) {
  // descriptor.name (mx_*), descriptor.description, descriptor.input_schema (JSON Schema) → your tool type
}

// 3. Dispatch a model tool call by canonical name; receive the T102 envelope.
const result = await dispatchCall('mx_find_agents', { /* args */ }, ctx);
//   serializeToolResult(result) → an MCP CallToolResult, if you need that shape.

await ctx.close();
```

A custom runner **must** honor the same [seven-point common tool
contract](./mx-agent-tool-fabric-design.md#4-the-minimum-common-tool-contract)
(design §4) — above all the **deferred-result** semantics (resolve a
`running` / `awaiting_approval` `handle` via `mx_await_result`, never treat it as a
failure) and the **secret boundary** (no credential in any tool arg; the daemon
re-validates trust/policy/approval regardless of what your runner decides).

---

## The common tool contract

Stated once; every runtime section above defers to it.

### The result envelope

Every tool returns one normalized shape (T102):

```jsonc
{ "status": "ok" | "running" | "awaiting_approval" | "denied" | "error",
  "result": { /* success payload */ } | null,
  "error":  { "code": "<closed taxonomy>", "message": "no secrets" } | null,
  "handle": "inv_…" | null,              // present when running | awaiting_approval
  "approval": { "request_id": "…", "risk": "low|medium|high",
                "summary": "…", "expires_at": "…" } | null,
  "audit_ref": { "invocation_id": "…", "request_id": "…",
                 "room": "!…:server", "event_id": "$…" } }  // correlation, always present
```

- **`ok`** — success; `result` holds the payload, `audit_ref` is always present.
- **`denied`** — a **governance outcome**, *not* a protocol/tool exception: the
  model reads the denial and replans.
- **`running` / `awaiting_approval`** — **not** failures. The envelope carries a
  `handle`; the agent keeps working and resolves it later via
  `mx_await_result(handle)`. ADK (`LongRunningFunctionTool`) and Claude (hidden
  poll loop) can hide this; the rest surface the handle.
- **`error`** — a genuine fault; `error.code` is from the closed taxonomy below.

### The closed `error.code` taxonomy

Nine codes, partitioned by status:

| Status | Codes |
|---|---|
| `denied` (governance) | `policy_denied`, `untrusted_key`, `approval_denied`, `approval_expired` |
| `error` (fault) | `timeout`, `not_found`, `invalid_args`, `target_offline`, `internal` |

A runtime can react programmatically — e.g. `untrusted_key` → surface an
onboarding hint; `awaiting_approval` → keep planning. `timeout` is reserved for a
genuine transport/daemon fault; a `wait_ms` budget expiry on `mx_await_result`
returns the still-pending envelope (`error: null`), never a fabricated `timeout`.

### Deferred results — `mx_await_result`

Every runtime resolves a deferred `handle` the same way: `mx_await_result(handle,
wait_ms)`. `wait_ms` is a client-side poll-with-timeout — omitted/`0` is a single
non-blocking probe; `> 0` blocks up to a logical budget, returning early on the
first terminal state. The resolver only **observes**: `awaiting_approval` →
`ok` / `denied` resolves because the operator decided out-of-process and the daemon
re-ran the authorize pipeline at release. It issues no decision and exposes no
approve/deny surface.

### Idempotency

For safe mutating retries, supply an explicit `idempotency_key` to
`mx_delegate_tool` / `mx_run_command`; the daemon dedupes on it. It is a dedup
nonce, not a capability — idempotency never bypasses authorize.

### The `mx-loom-mcp` CLI surface

All flags are **non-secret session config** — never model tool args, never
credentials. There is no flag for Matrix credentials, signing/provider keys,
`GH_TOKEN`, trust stores, policy paths, or approval decisions.

| Flag | Meaning |
|---|---|
| `--stdio` | stdio transport (default) |
| `--http --host <h> --port <p>` | Streamable-HTTP transport (binds `127.0.0.1`, no auth) |
| `--room <id>` | workspace room to register into |
| `--kind <adk\|opencode\|…>` | agent kind label |
| `--correlation-id <id>` | session-stable id joining activity to audit rows |
| `--cwd <path>` / `--project-id <id>` / `--git-commit <sha>` | non-secret workspace metadata (rides `agent.register`) |
| `--max-invocations <n>` | concurrency declaration (positive integer) |
| `--audit` (or `MXL_AUDIT_PG=1`) | enable the best-effort Postgres audit mirror (DSN from `DATABASE_URL`/`PG*`, never logged) |

---

## Verifying your integration (#28 / T206)

"Verified against #28" means: **each copy-paste recipe above is the one its gated
e2e arm actually drives**, and this guide cites the arm so you can reproduce the
verification locally.

The same nine descriptors are proven to work cross-runtime by the **M2-exit
portability matrix**,
[`packages/golden/test/portability-matrix.e2e.test.ts`](../packages/golden/test/portability-matrix.e2e.test.ts)
(`MXL_PORTABILITY_MATRIX=1`) — one binding-agnostic step table run under Pi, ADK,
and OpenCode from a single canonical descriptor set. Each runtime also has a
standalone acceptance arm:

| Runtime | Gated e2e arm | Gate flag(s) |
|---|---|---|
| ADK (MCPToolset) | `packages/golden/test/adk.mcp-toolset.e2e.test.ts` | `MXL_ADK_MCP_E2E=1` + two-daemon fixture |
| ADK (long-running) | `packages/golden/test/adk.long-running.e2e.test.ts` | `MXL_ADK_LONG_RUNNING_E2E=1` + `MXL_CONFORMANCE_GOLDEN_POLICY=1` |
| Claude | `packages/golden/test/golden.claude.e2e.test.ts` (T114 golden gate) | `MXL_CONFORMANCE_TWO_DAEMON=1` |
| OpenCode | `packages/golden/test/opencode.mcp-entry.e2e.test.ts` | `MXL_OPENCODE_MCP_E2E=1` |
| Pi | `packages/golden/test/t205-pi-binding.e2e.test.ts` | `MXL_PI_BINDING_E2E=1` |
| Cross-runtime | `packages/golden/test/portability-matrix.e2e.test.ts` | `MXL_PORTABILITY_MATRIX=1` |

All arms **skip cleanly** without the fixture and **fail (never silently skip)**
in CI when demanded but the runtime / `mx-loom-mcp` / the two-daemon fixture is
missing. Bring up the two-daemon golden fixture per
[`scripts/conformance/README.md`](../scripts/conformance/README.md); each
per-runtime README's *Live two-daemon acceptance* section gives the full env-flag
invocation. A representative one-runtime check:

```bash
MXL_PORTABILITY_MATRIX=1 \
  pnpm --filter @mx-loom/golden exec vitest run \
  --config vitest.e2e.config.ts test/portability-matrix.e2e.test.ts
```

## Not yet available (do not assume)

The guide documents today's reality. These are **future**, not shipped:

- **A published standalone `mx-loom-mcp` bin** — T602 (M6). Today the `tsx`
  launcher above is the verified path.
- **Durable `task.watch` resumption** across a host crash — M3 (T302). Today
  deferred state lives in process memory for one session.
- **Streaming partial results**, **multi-tenant scoping**, billing/cost
  attribution — M5/M6 (design §9). One process maps to one room today.

## See also

- [Design — MX-Agent as the Coordination Fabric](./mx-agent-tool-fabric-design.md)
  (§1 boundaries, §3 per-runtime consumption, §4 the seven-point contract)
- [Implementation backlog](./backlog.md)
- [Pi tool-surface capability decision (T204)](./pi-tool-surface-capability.md)
- [mx-agent version pin (`v0.2.1`)](./mx-agent-pin.md)
- Per-runtime deep references: [ADK](../examples/adk/README.md) ·
  [Claude SDK](../packages/claude/README.md) · [MCP server](../packages/mcp/README.md) ·
  [OpenCode](../examples/opencode/README.md) · [Pi](../packages/pi/README.md)
- [Examples index](../examples/README.md)
</content>
</invoke>
