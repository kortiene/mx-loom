# T110 · binding: Claude Agent SDK in-process shim

> GitHub issue **#18** · `area/claude-binding` `type/feature` `P0` · Estimate **L** · Milestone **M1 — Delegation MVP**
> Source: `docs/backlog.md` (`T110`). Blocked-by **#11/T103** (deferred-result protocol — `mx_await_result`), **#13/T105** (the `mx_delegate_tool` handler), **#19/T111** (JSON Schema → Zod converter) — **all landed**. This is a planning/spec document only; it does **not** implement the feature.

## Problem Statement

mx-loom's locked design decision #1 is "both bindings in parallel": the one canonical, transport-neutral tool registry must feed **both** a generated **MCP server** (the universal binding — landed as `@mx-loom/mcp` / T109) **and** a **Claude Agent SDK native shim**, from day one (`docs/mx-agent-tool-fabric-design.md` §3, §8, locked decision 1). The Claude SDK is the **default mx-agency runner**, so its native binding is the one the golden end-to-end test (T114) and the rest of M1 are gated on.

A generic external MCP server already works for Claude (register `@mx-loom/mcp` as an external MCP server in `options.mcpServers`). But the design (§3, Claude bullet) calls out two things the SDK does *better* than generic MCP, and T110 is exactly those two things:

1. **In-process registration.** Define the nine `mx_*` tools with the SDK's `createSdkMcpServer()` + `tool()` (Zod schemas), so the toolbelt runs *inside* the agent process — no extra socket, no subprocess, no stdio framing. This is the "in-process shim."
2. **The cleanest HITL hook of the four runtimes.** Use the SDK's `canUseTool` callback to intercept `mx_*` calls and present human-in-the-loop approval — without the model ever seeing credentials — short-circuiting to the daemon's approval state, and **hiding the `mx_await_result` poll loop** so a delegated call looks synchronous to the model.

**The gap:** `@mx-loom/claude` today contains only the T111 JSON Schema → Zod converter (`jsonSchemaToZod` / `jsonSchemaToZodRawShape`). There is no module that (a) builds the nine `tool()` definitions from `CANONICAL_M1_TOOLS` and wraps them in a `createSdkMcpServer()` config, (b) routes each tool call to the matching registry handler and serializes the T102 envelope, (c) hides the poll loop for `running`/`awaiting_approval` deferred results, or (d) provides a `canUseTool` factory wired to the approval status. Until this lands, the Claude SDK can only reach the mesh through the *generic* MCP server (no native HITL, no hidden poll loop), and the golden test's Claude arm + the M1 exit criterion ("a Claude-SDK agent delegates … via **both** the MCP server and the Claude native shim") are blocked.

T110 closes that gap: an in-process Claude Agent SDK binding, secret-free, that leaves every authority decision out-of-process on the receiving mx-agent daemon.

## Goals

- **AC1 — delegate end-to-end:** a Claude-SDK agent configured with the shim can emit a `mx_delegate_tool` tool call and **receive the result** as a normalized T102 envelope — including transparently resolving a `running` deferred call (the poll loop is hidden; the model issues one tool call and gets the terminal result).
- **AC2 — HITL without secrets:** for an approval-gated (or otherwise risk-bearing) call, the `canUseTool` callback presents a human-in-the-loop decision rendering a **secret-free** summary (tool name, target agent, non-secret arg summary, risk) and never exposes Matrix tokens, signing keys, provider keys, or `GH_TOKEN`. A local deny short-circuits before dispatch; a local allow still leaves the receiving daemon as the real authority.
- **In-process, generated, never hand-authored:** the nine `tool()` definitions are produced by enumerating `CANONICAL_M1_TOOLS` and converting each `input_schema` via the T111 converter — adding a tenth descriptor (plus its handler) surfaces it with no per-tool edit.
- **Reuse, don't duplicate:** route through `@mx-loom/mcp`'s already-exported `dispatchCall` (the name → handler router), `BindingContext`/`createBindingContext` (the secret-free daemon/room/audit bundle), and `serializeToolResult` (`ToolResult` → MCP `CallToolResult`). The Claude shim adds only what is Claude-specific: the `tool()`/`createSdkMcpServer()` registration via Zod, the hidden poll loop, and the `canUseTool` HITL hook.
- **Envelope fidelity:** all five statuses (`ok` / `running` / `awaiting_approval` / `denied` / `error`), the closed `error.code` taxonomy, `handle`, `approval`, and `audit_ref` survive into the SDK MCP tool result intact and machine-readable (`structuredContent`).
- **Secret-free chokepoint:** the shim holds no secrets; every daemon call routes through the toolbelt `MxClient`/`MxSession` so the deny-by-default env allowlist, outbound credential-shaped-arg rejection, and inbound `redactSecrets` all stay in force, unmodified.
- **Audit chokepoint:** the shim's tool-result return point is the single place the T113 `withAudit` tap is applied once (best-effort, `NullAuditSink` by default), independent of the MCP server's own tap.

## Non-Goals

- **The external-MCP variant (T109 / #17).** Registering `@mx-loom/mcp` as an external MCP server in `options.mcpServers` is already done. T110 is the *in-process* shim only.
- **Other runtimes (M2).** No ADK `LongRunningFunctionTool` (T202), no OpenCode `opencode.json` `mcp` entry (T203), no Pi native-tool map (T204).
- **Authority/trust/policy/approval mutation tools.** The shim surfaces only the nine model-facing verbs; `trust.*`, `approval.decide`, `policy.*`, `auth.*`, `device.*`, `daemon.*` are structurally unreachable. `canUseTool` is a *local requester-side* gate that can only **refuse to dispatch** — it can never grant daemon authority; approval is re-validated against live policy on the receiving daemon at release.
- **Model self-approval.** `canUseTool` returning `allow` permits the request to be *signed and dispatched*; it does not approve the operation on the receiver. There is no model-facing approve/deny surface, ever.
- **Streaming tool output into the model.** Per design §9, deferred results resolve via the hidden `mx_await_result` loop and artifacts via `mx_get_context`; no `StreamChunk` plumbing.
- **Owning the agent loop / `query()` invocation.** The shim provides a `createSdkMcpServer` config and a `canUseTool` factory; the host application (the mx-agency runner) composes them into its own `query()` call. T110 does not run the model.
- **Live two-daemon conformance certification.** Wire-shape assumptions (`call.start` param names, `CallResponse` disposition vocabulary, `invocation.get`, `audit_ref` availability) remain pinned at the existing `MXL_CONFORMANCE_TWO_DAEMON=1` round-trip the handlers already stage; T110 inherits, does not re-pin, them. The full approval-gated golden end-to-end is **T114**.

## Relevant Repository Context

The stack is TypeScript (pnpm workspace, Node ≥20.19, vitest, Apache-2.0, ESM, `nodenext`, `verbatimModuleSyntax`, `strict` + `noUncheckedIndexedAccess`). The repo is **no longer docs-only** — six packages exist under `packages/*` (`pnpm-workspace.yaml` globs `packages/*` + `adw_sdlc`). The pieces T110 builds on are all landed:

- **`@mx-loom/claude`** (`packages/claude`) — the package T110 extends. Today it exports only the **T111** JSON Schema → Zod converter:
  - `jsonSchemaToZod(schema, opts?) => ZodType` and `jsonSchemaToZodRawShape(schema, opts?) => ZodRawShape` (the `tool()` form: `{ key → ZodType }`, non-`required` fields `.optional()`), `JsonSchemaConversionError(path, keyword)` (fail-closed), `SUPPORTED_JSON_SCHEMA_TYPES`, `ConvertOptions`.
  - Targets **Zod v4**, pinned to the SDK's `zod@^4.4.3` (already a dependency of this package). The converter covers exactly the draft-07 subset the nine canonical input schemas use and **throws** on anything else.
  - **Caveat T110 must honor (already documented in `packages/claude/README.md`):** a `ZodRawShape` passed to `tool()` is re-wrapped by the SDK as a *non-strict* `z.object`, so `additionalProperties: false` strictness is not enforced at the Claude layer for the shape form. This is acceptable — the toolbelt and daemon re-validate at dispatch — but it is the reason client-side strictness is defense-in-depth, not the boundary.

- **`@mx-loom/registry`** (`packages/registry`) — the canonical source. Exports `CANONICAL_M1_TOOLS: readonly ToolDescriptor[]` (the nine verbs + each individual const, deep-frozen), the T102 envelope (`ToolResult`, `ok`/`running`/`awaitingApproval`/`denied`/`errored`, `ENVELOPE_SCHEMA`/`validateEnvelope`, `ERROR_CODES`/`DENIAL_CODES`/`FAULT_CODES`, `mapTransportError`/`mapDaemonError`, `newIdempotencyKey`), the nine handlers (`(input, deps) => Promise<ToolResult>`, never throw, build envelopes only via the helpers), the `deps` subtypes (`HandlerDeps` / `RoomScopedDeps` / `DelegateDeps` / `ExecDeps`; the injected `DaemonCall = Pick<MxTransport, 'call'>`), the `mxAwaitResult` resolver (`{ handle, wait_ms? }` poll-with-timeout — a `wait_ms` *expiry* returns the still-pending envelope, **never** `errored('timeout')`), and the security surface (`MODEL_FACING_ALLOWLIST`, `FORBIDDEN_AUTHORITY_VERBS`, `isForbiddenAuthorityVerb`, `findCredentialShapedProperty`/`CREDENTIAL_KEY_RE`). Runtime dep: `ajv`. Dev-only dep on `@mx-loom/toolbelt`.

- **`@mx-loom/toolbelt`** (`packages/toolbelt`) — transport + session. `MxClient`/`createClient` (`MxTransport.call(method, params?, options?)`, IPC-primary + CLI fallback), `openSession`/`MxSession` (registers once via `agent.register`, runs a heartbeat, threads a session-stable `correlation_id`, exposes `call(...)`, `agentId`, `room?: string`, `correlationId`, `close()`), and the secret-boundary guards `assertNoCredentialShapedArgs` (outbound, pre-dispatch) + `redactSecrets` (inbound). **`MxClient`/`MxSession` are the concrete `DaemonCall`** the handlers expect.

- **`@mx-loom/mcp`** (`packages/mcp`) — **T109, landed.** A pure consumer of the registry that T110 reuses (it exports its internals explicitly "for T110 / T201 / T203 / T204 / T114 to embed or drive the server programmatically"):
  - `dispatchCall(name, args, ctx) => Promise<ToolResult>` — the central name → registry-handler router (the one thing the registry lacks), built once over the nine handlers, each fed its correct `deps` subtype; unknown name → `errored('not_found')`, never a throw; `room` always from the context, never model input.
  - `createBindingContext(opts) => Promise<BindingContext>` and the `BindingContext` type — the secret-free `{ daemon, room, correlationId, auditSink, close() }` bundle; opens an `MxSession` (preferred), or binds an injected session / bare `DaemonCall`; default `NullAuditSink`.
  - `serializeToolResult(result) => CallToolResult` — pure/total `ToolResult` → MCP `CallToolResult`: full envelope into `structuredContent`, JSON text into `content[0]`, **`isError` true iff `status === "error"`** (`denied`/`awaiting_approval`/`running`/`ok` are *not* `isError`).
  - **This is the load-bearing reuse:** the SDK's `createSdkMcpServer` is itself an *in-process MCP server*, so each `tool()` handler returns a **`CallToolResult`** — the exact shape `serializeToolResult` produces. The dispatch table and the envelope serializer are therefore shared verbatim; T110 does not re-implement them.

- **`@mx-loom/audit`** (`packages/audit`) — T113. `withAudit(sink, baseCtx, log?) => AuditTap` (best-effort, pass-through; `AuditTap = (result, { tool_name, call_id, idempotency_key? }) => Promise<ToolResult>`), the `AuditSink` adapters (`PostgresAuditSink`/`InMemoryAuditSink`/`NullAuditSink`), `logAuditFailure`. Reached transitively via `@mx-loom/mcp`'s `BindingContext.auditSink`.

**The Claude Agent SDK is resolvable.** `@anthropic-ai/claude-agent-sdk@0.3.183` is in `pnpm-lock.yaml` (it transitively pins `@modelcontextprotocol/sdk@1.29.0` and `zod@4.4.3` — the versions `@mx-loom/mcp` and `@mx-loom/claude` already use). The relevant SDK surface T110 consumes:
  - `createSdkMcpServer({ name, version?, tools }) => McpSdkServerConfigWithInstance` — the in-process MCP server config the host puts in `options.mcpServers[name]`.
  - `tool(name, description, inputSchema /* ZodRawShape */, handler) => SdkMcpToolDefinition` — the handler is `(args, extra) => Promise<CallToolResult>` (args already parsed against the Zod shape).
  - `canUseTool` (an `options.canUseTool` callback the *host* passes to `query()`): `(toolName, input, { signal, suggestions }) => Promise<PermissionResult>` where `PermissionResult` is `{ behavior: 'allow', updatedInput }` or `{ behavior: 'deny', message }`. In-process MCP tool names arrive namespaced as `mcp__<serverName>__<toolName>`.
  - *(Confirm the exact 0.3.183 type names/signatures against the installed `.d.ts` at implementation time — node_modules is not installed in this docs/source checkout. The above matches the 0.3.x line; treat any drift as a one-line localization, mirroring how the handlers localize daemon method names.)*

**What does not exist yet (decisions to confirm, not assume built):**
- **No in-process tool builder.** No module maps `CANONICAL_M1_TOOLS` → `tool()[]` → `createSdkMcpServer`.
- **No `canUseTool` factory.** No HITL hook wired to the approval status.
- **No hidden poll loop wrapper.** The handlers expose an inline `wait_ms`, but nothing yet drives the `running` → terminal resolution transparently on the Claude side.
- **No SDK dependency declared** in `packages/claude/package.json` (T111 needed only `zod`).

## Proposed Implementation

Extend **`@mx-loom/claude`** with the in-process shim, reusing `@mx-loom/mcp`'s router/context/serializer. Add four small modules; keep the T111 converter untouched.

### 1. The tool-server builder (`src/tool-server.ts`) — descriptors → `createSdkMcpServer`

`createMxToolServer(ctx: BindingContext, opts?): McpSdkServerConfigWithInstance` enumerates `CANONICAL_M1_TOOLS` and produces one `tool()` per descriptor, then wraps them in `createSdkMcpServer({ name, version, tools })`.

- **Input schema:** convert each descriptor's `input_schema` with `jsonSchemaToZodRawShape` (T111) — the `ZodRawShape` form `tool()` expects. Because the converter is **fail-closed**, a descriptor whose schema drifts outside the supported subset throws `JsonSchemaConversionError` at *build* time (a developer error, not a model-facing `error.code`) — surfacing the problem loudly instead of silently widening the gate.
- **Handler:** each tool's handler is a thin closure `(args) => Promise<CallToolResult>` that:
  1. routes via `dispatchCall(descriptor.name, args, ctx)` → a `ToolResult`;
  2. **hides the poll loop** (§3 below) for deferred verbs;
  3. applies the **`withAudit` tap once** here (the single result-return chokepoint, §4);
  4. returns `serializeToolResult(audited)`.
- **`mx_delegate_tool`'s dynamic inner `args`** stay an open object at the Claude layer (the converter renders the outer schema's `args` as `z.record(z.string(), z.unknown())`); the *inner*-tool validation against the target's published `ToolSchema.input_schema` remains the T105 handler's job — **not** converted to Zod here (T111 scope boundary).
- **Server name** defaults to a configurable constant (proposed `'mx'`, yielding namespaced tool names `mcp__mx__mx_delegate_tool`). Export a helper to compute the namespaced name so the host can populate `allowedTools` and so `canUseTool` (§2) matches reliably. *(The cosmetic double-`mx` — server `mx` + verb `mx_*` — is noted under Open Questions.)*

### 2. The `canUseTool` HITL hook (`src/can-use-tool.ts`) — the approval surface (AC2)

`createMxCanUseTool(opts): CanUseTool` returns a callback the host passes to `query({ options: { canUseTool } })`. It is the **requester-side local operator gate** — distinct from, and strictly weaker than, the receiving daemon's authority:

- **Scope match.** It only acts on this shim's tools (`mcp__<serverName>__mx_*`). Any other tool name is delegated to an injected `fallback` callback (default: `{ behavior: 'allow', updatedInput: input }`) so the shim composes with a host that already has its own `canUseTool`. (Provide `wrapCanUseTool(existing, opts)` as the composition helper.)
- **Which calls prompt.** A binding-supplied predicate `shouldPrompt(toolName, input) => boolean` decides. **Default:** prompt for the risk-bearing verbs `mx_delegate_tool` and `mx_run_command` (the mutating/guarded surface); auto-allow the read/observe verbs (`mx_find_agents`, `mx_describe_agent`, `mx_await_result`, `mx_get_context`, `mx_workspace_status`, `mx_cancel`, `mx_share_context`). This is conservative and needs no daemon round-trip. *(Optional enhancement, behind an opt-in flag: a read-only daemon probe to learn whether the target call is approval-gated and present a more informed prompt — deferred unless a daemon read surface is confirmed; it must never become the authority.)*
- **The prompt is secret-free.** Build the HITL payload from a **non-secret projection** of the call: the verb, the target `agent`/`tool`, an arg summary passed through the registry's `findCredentialShapedProperty` (reject/omit any credential-shaped field), and a risk hint. Never render env, tokens, or raw args verbatim. The args are already secret-free by contract (`assertNoCredentialShapedArgs` rejects credential-shaped keys at dispatch), so the projection is defense-in-depth, not the boundary.
- **The decision.** Present the payload to an injected `onApprovalRequest(summary) => Promise<'allow' | 'deny'>` (the host's UI/CLI/operator surface). On `'deny'` → return `{ behavior: 'deny', message }` (a secret-free reason) and the tool never dispatches. On `'allow'` → return `{ behavior: 'allow', updatedInput: input }` (do not mutate args) and the tool runs — **but** the receiving daemon still independently enforces trust/policy/approval and may still return `awaiting_approval`/`policy_denied`. This preserves the governing rule: cognition produces a signed *request*; it never grants itself authority.
- **`AbortSignal`.** Honor the `options.signal` so a cancelled turn aborts a pending prompt.

### 3. Hiding the `mx_await_result` poll loop (`src/resolve.ts`)

The crux of AC1's "receive the result." Generic MCP (T109) *surfaces* the handle and lets the model re-call `mx_await_result`; the Claude shim *hides* that loop so a `mx_delegate_tool` call returns the terminal result in one shot.

- After `dispatchCall`, inspect the `ToolResult.status`:
  - **`ok` / `denied` / `error`** → terminal; return as-is.
  - **`running`** → resolve transparently: loop `mxAwaitResult({ handle, wait_ms }, { daemon: ctx.daemon })` against a bounded total budget (a configurable `resolveTimeoutMs`, default e.g. 60 s, realised as the resolver's own short-poll cadence) until terminal. If the budget elapses still-`running`, return the `running` envelope (the model can re-poll via the still-registered `mx_await_result` tool — the loop hid the *common* case, it never blocks unboundedly).
  - **`awaiting_approval`** → this is the daemon's *out-of-process* approval gate (the receiver holds the request). The shim does **not** silently spin forever. Default: return the `awaiting_approval` envelope (with `handle` + secret-free `approval`) so the model can fan out other work and resolve later — exactly the design §5 step 5'/8' Claude flow. *(A configurable `awaitApproval: true` mode polls up to `resolveTimeoutMs` for clients that prefer a blocking call; off by default to avoid blocking the turn on a human.)*
- The resolve wrapper is built on the existing `mxAwaitResult` (which already guarantees "a `wait_ms` expiry returns the pending envelope, never `errored('timeout')`") so the only new behavior is the *loop and the disposition policy*, not new transport semantics.
- Keep `mx_await_result` registered as one of the nine tools regardless — it is the escape hatch for handles from a prior turn or a still-pending approval.

### 4. The binding context, audit chokepoint, and exports (`src/index.ts`)

- **Reuse `createBindingContext` from `@mx-loom/mcp`.** The shim's `BindingContext` is the same secret-free `{ daemon, room, correlationId, auditSink, close() }` bundle. The host either passes an open `MxSession` (preferred — one `agent.register`, heartbeat, correlation), a bare `MxClient` + `room`, or lets the shim open a session. The room is **always** `ctx.room` (session), never model input.
- **Audit tap once.** Mirror `@mx-loom/mcp`'s server: build `const tap = withAudit(ctx.auditSink, ctx.correlationId ? { correlation_id: ctx.correlationId } : {})` once, and apply it in each tool handler at the single return point with `{ tool_name, call_id, idempotency_key? }` (`call_id` = the SDK `tool_use` id when available, else a uuid; `idempotency_key` read from the mutating verb's args if present). Best-effort: a sink failure is swallowed and never blocks the tool call. Default sink is `NullAuditSink` (audit off unless wired); the live-Postgres path is gated by `MXL_AUDIT_PG=1` and end-to-end asserted by T114.
- **Public exports:** `createMxToolServer`, `createMxCanUseTool`, `wrapCanUseTool`, the namespaced-name helper, plus their option/types — so the mx-agency runner can compose `options.mcpServers` and `options.canUseTool` itself. Keep the T111 exports.

### Putting it together (host usage sketch — documentation, not shim code)

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createBindingContext } from '@mx-loom/mcp';
import { createMxToolServer, createMxCanUseTool } from '@mx-loom/claude';

const ctx = await createBindingContext({ /* session / daemon / sessionOptions */ });
const mx = createMxToolServer(ctx);              // in-process MCP server config
const canUseTool = createMxCanUseTool({          // the HITL hook
  onApprovalRequest: async (summary) => /* operator UI */ 'allow',
});

for await (const msg of query({
  prompt,
  options: { mcpServers: { mx }, canUseTool /*, allowedTools: ['mcp__mx__mx_delegate_tool', …] */ },
})) { /* … */ }

await ctx.close();
```

## Affected Files / Packages / Modules

**Extend `packages/claude` (`@mx-loom/claude`):**
- `package.json` — add deps: `@mx-loom/registry`, `@mx-loom/toolbelt`, `@mx-loom/mcp`, `@mx-loom/audit` (all `workspace:*`); add `@anthropic-ai/claude-agent-sdk` as a **peerDependency** (`^0.3.183`) + devDependency (tests); `@modelcontextprotocol/sdk` for the `CallToolResult` type (likely transitive via `@mx-loom/mcp`, declare if imported directly). Keep `zod@^4.4.3`. *(Move `@mx-loom/registry` from dev → runtime dep, since the shim now imports `CANONICAL_M1_TOOLS` at runtime.)*
- `src/tool-server.ts` — `createMxToolServer(ctx, opts?)`: descriptors → `tool()[]` → `createSdkMcpServer`, with the converter + dispatch + resolve + audit tap + serialize.
- `src/can-use-tool.ts` — `createMxCanUseTool(opts)` + `wrapCanUseTool(existing, opts)` (the HITL hook).
- `src/resolve.ts` — the hidden-poll-loop wrapper over `mxAwaitResult` + the deferred-status disposition policy.
- `src/names.ts` (or inline) — server name constant + namespaced-name helper (`mcp__<server>__<verb>`).
- `src/index.ts` — add the new exports; keep the T111 exports.
- `README.md` — add the in-process binding usage, the HITL/secret-boundary statement, the hidden-poll-loop note, the audit opt-in.
- `test/*` — see Testing Plan.

**Files to read (not modify):**
- `packages/mcp/src/{dispatch,context,serialize,server}.ts` — the router/context/serializer to reuse and the server's audit-tap wiring to mirror.
- `packages/registry/src/handlers/{deps,await-result,delegate-tool}.ts`, `src/{envelope,errors,security}.ts`, `src/descriptors/*` — handler signatures, the `wait_ms` resolver, the no-authority + secret-free oracles.
- `packages/claude/src/json-schema-to-zod.ts` + `README.md` — the converter contract and the `ZodRawShape` re-wrap caveat.
- `packages/toolbelt/src/{client,session,guards}.ts` — the concrete `DaemonCall`, the session shape, the secret guards.
- `packages/audit/src/with-audit.ts` — the `withAudit`/`AuditTap` contract.

**Files to update (docs):**
- `docs/mx-agent-tool-fabric-design.md` (§3, §8 status lines), `docs/backlog.md` (T110 status + M1 header).
- `pnpm-workspace.yaml` — already globs `packages/*`; no edit expected (verify).

## API / Interface Changes

- **New public package API (`@mx-loom/claude`), additive:**
  - `createMxToolServer(ctx: BindingContext, opts?: { name?: string; version?: string; resolveTimeoutMs?: number; awaitApproval?: boolean; auditTap?: AuditTap }) => McpSdkServerConfigWithInstance`.
  - `createMxCanUseTool(opts: { onApprovalRequest: (summary: ApprovalSummary) => Promise<'allow' | 'deny'>; shouldPrompt?: (toolName: string, input: Record<string, unknown>) => boolean; serverName?: string; fallback?: CanUseTool }) => CanUseTool`.
  - `wrapCanUseTool(existing: CanUseTool, opts) => CanUseTool` — compose with a host's existing hook.
  - `mxToolName(verb: string, serverName?: string) => string` — the `mcp__<server>__<verb>` helper.
  - Types: `ApprovalSummary` (the secret-free HITL payload), the option interfaces.
- **New peerDependency:** `@anthropic-ai/claude-agent-sdk@^0.3.183` (the host already installs it; peer avoids version skew). Declared dependency change: `@mx-loom/registry`/`@mx-loom/toolbelt`/`@mx-loom/mcp`/`@mx-loom/audit` as runtime workspace deps.
- **No change** to the registry descriptors, the T102 envelope, handler signatures, the daemon-RPC surface, the toolbelt transport, or `@mx-loom/mcp`'s exports. T110 is a pure consumer.
- **No CLI / `bin`.** Unlike the MCP server (`mx-loom-mcp` over stdio/HTTP), the in-process shim is a *library* embedded by the host runtime; there is no executable.

## Data Model / Protocol Changes

- **None to the contract.** No change to the T102 result-envelope shape, the closed nine-code error taxonomy, the descriptor model, the idempotency-key contract, or any audit-row column.
- **Reused serialization mapping** (`ToolResult` → MCP `CallToolResult`): the `@mx-loom/mcp` `serializeToolResult` invariant (full envelope in `structuredContent`, JSON in `content[0]`, `isError` iff `status === "error"`) applies unchanged — the SDK tool handler returns exactly that shape.
- **New (additive) non-secret HITL payload** (`ApprovalSummary`): `{ tool, agent?, command?, args_summary, risk }`, assembled only from non-secret fields, defined entirely in `@mx-loom/claude`. It is *not* a result envelope and never enters the closed error taxonomy.
- **Idempotency:** the shim passes a mutating verb's `idempotency_key` through verbatim (read from args); it neither generates nor strips keys (the handler defaults one when omitted). The same key is supplied to the audit tap's per-call context.

## Security & Compliance Considerations

- **Secret boundary (Boundary A) holds.** The in-process shim lives in the adaptation plane and is **secret-free by construction**: it never holds or forwards Matrix tokens, Ed25519 signing keys, provider keys, or `GH_TOKEN`. It reaches the daemon *only* through the toolbelt `MxClient`/`MxSession`, which enforce the deny-by-default env allowlist; the shim starts no child process and inherits no secret-bearing env. Running *in-process* with the model raises the bar: the shim must keep the model's reach to exactly the nine verbs and the secret-free envelope — it must never read an env var or expose the session/client object to the model.
- **No tool field carries a credential, inbound or outbound.** Every daemon call routes through `MxClient.call` → `assertNoCredentialShapedArgs` (a credential-shaped `args` key surfaces as `invalid_args` before dispatch) and `redactSecrets` (inbound). The registry's `findCredentialShapedProperty`/`CREDENTIAL_KEY_RE` remain the oracle. The `canUseTool` HITL summary and the serialized result copy **only** from the already-secret-free args/envelope — never env, tokens, or raw payloads.
- **Out-of-process enforcement is untouched.** Trust (Ed25519 store), deny-by-default `policy.toml`, sandbox, and human approval gates all run on the *receiving* daemon. The shim **maps** `policy_denied`/`untrusted_key`/`awaiting_approval`/`approval_denied`/`approval_expired`; it never decides them. **`canUseTool` is a requester-side gate that can only refuse to dispatch** (deny) — an `allow` does not grant authority; the receiver re-validates against live policy at release.
- **No authority tools surfaced.** The builder iterates `CANONICAL_M1_TOOLS` only; `trust.*`, `approval.decide`, `policy.*`, `auth.*`, `device.*`, `daemon.*` are structurally unreachable. A regression test asserts the registered tool set equals the nine model-facing verbs and intersects `FORBIDDEN_AUTHORITY_VERBS` at ∅. Approval reaches the model only as the `awaiting_approval` *status*.
- **The model never self-approves.** `canUseTool` is wired to a human/operator decision (`onApprovalRequest`), never to model output. There is no model-facing approve/deny verb. A local `allow` is dispatch permission, not authority.
- **Logging/redaction.** Log lifecycle/errors **secret-free**: never log args, env, tokens, or `result`/`error.message`/`approval.summary` payloads. Reuse `logAuditFailure`'s discipline (class + `dedup_key` only) for audit-tap failures; map transport/daemon faults via `mapTransportError`/`mapDaemonError`, never log raw.
- **Audit correlation.** Every returned result carries `audit_ref` (structurally always present; `null` inner ids when the daemon has not returned them — never fabricated). The `withAudit` tap mirrors a non-secret subset to the queryable index; a Postgres outage is swallowed and never blocks a tool call or weakens the substrate truth. The Claude shim's tap is **independent** of the MCP server's tap (each binding taps its own single chokepoint).

## Testing Plan

- **Unit — tool builder (`tool-server.test.ts`):** registers exactly nine `tool()` definitions whose names equal `CANONICAL_M1_TOOLS` names; each input schema is produced via the T111 converter (no per-tool hand-authoring); the registered set intersects `FORBIDDEN_AUTHORITY_VERBS` at ∅ (no-authority invariant). A descriptor with an unsupported schema construct throws `JsonSchemaConversionError` at build time (fail-closed).
- **Unit — tool handler dispatch (`handler.test.ts`):** with a **fake `DaemonCall`** (via `createBindingContext({ daemon })`), a `mx_delegate_tool` call routes through `dispatchCall` → `mxDelegateTool` → serialized `CallToolResult` (AC1, sync `ok` path); `structuredContent` is the full envelope; `isError` only for `status:"error"`. `room` comes from the context, never input.
- **Unit — hidden poll loop (`resolve.test.ts`):** a daemon reply of `running` then `ok` resolves transparently to the terminal `ok` in one tool call (poll loop hidden, AC1); a `running` that never settles within `resolveTimeoutMs` returns the `running` envelope (no unbounded block, no fabricated `timeout`); an `awaiting_approval` returns the `awaiting_approval` envelope by default (handle + secret-free approval), and resolves to `ok`/`denied` under `awaitApproval: true` after a simulated operator decision. Uses the deterministic `sleep`/`now` seams.
- **Unit — `canUseTool` HITL (`can-use-tool.test.ts`):** a risk-bearing `mx_delegate_tool` call triggers `onApprovalRequest` with a **secret-free** `ApprovalSummary` (assert no token/key/env substring; assert credential-shaped args are omitted/rejected); `'deny'` → `{ behavior: 'deny' }` and no dispatch; `'allow'` → `{ behavior: 'allow', updatedInput }` unchanged; read verbs auto-allow without prompting (default `shouldPrompt`); non-`mx_*` tool names delegate to `fallback`; the `AbortSignal` aborts a pending prompt (AC2).
- **Secret-boundary / redaction (`secret-boundary.test.ts`):** a credential-shaped `args` key for `mx_delegate_tool` surfaces as `invalid_args` (via the real guard on a concrete `MxClient` fake), never reaches the daemon, never appears in the HITL summary, the `CallToolResult`, or logs; a daemon reply containing a token-shaped string is redacted before serialization.
- **Audit tap (`audit.test.ts`):** with an `InMemoryAuditSink`, one tool call writes exactly one row with the right `tool_name`/`correlation_id`/`audit_ref` and the `idempotency_key` when supplied; a sink throw is swallowed and the tool result still returns; with `NullAuditSink` (default), no row, no error. (Mirror `@mx-loom/mcp`'s `audit.test.ts`.)
- **Integration — in-process SDK round-trip (`shim.integration.test.ts`):** build the `createSdkMcpServer` config + `canUseTool`, drive it through the SDK's in-process tool path against a fake daemon (or, if the SDK exposes a test/transport seam, a minimal `query()` harness with a mocked model emitting one `mx_delegate_tool` call); assert the tool runs, `canUseTool` fires for the risk-bearing verb, and the terminal envelope is returned (AC1 + AC2 together). If a full `query()` harness is impractical offline, assert against the `tool()` handler + `canUseTool` callback directly and document the gap, leaving the true model-in-the-loop assertion to T114.
- **Conformance / golden (staged):** the live, approval-gated, model-in-the-loop Claude arm of the golden end-to-end is **T114** (behind `MXL_CONFORMANCE_TWO_DAEMON=1`); T110 must not green a live-round-trip AC without a daemon. Treat a daemon rejection as red.
- **Documentation test:** the README's host-usage snippet is at least type-checked so it cannot rot.

## Documentation Updates

- **`packages/claude/README.md`:** add the in-process binding section — `createMxToolServer` / `createMxCanUseTool` usage, the host `query()` composition sketch, the secret-boundary statement, the HITL "local gate, not authority" clarification, the hidden-poll-loop behavior and `awaitApproval` toggle, the namespaced tool names, and the audit opt-in. Keep the T111 converter docs.
- **`docs/mx-agent-tool-fabric-design.md`:** update §3 (the "remaining generator is the Claude native shim (T110), still to come" note) and the §8 MVP "Both bindings from day one" bullet to record T110 landed. Keep the "generated, never hand-authored" rule intact.
- **`docs/backlog.md`:** flip T110 to a **Status: Landed** entry in the house style of T107/T108/T109/T111/T113 (what landed, resolved decisions, what is staged behind `MXL_CONFORMANCE_TWO_DAEMON=1` / `MXL_AUDIT_PG=1`); tick AC checkboxes only for what is actually proven (in-process dispatch + hidden poll loop + `canUseTool` HITL against a fake daemon), leaving the live model-in-the-loop golden arm to T114; update the M1 status header; note that with both bindings landed, **T114 is now fully wireable** (both arms) and M1 exit is in reach.
- **`docs/mx-agent-surface-v0.2.1.md`:** no change expected (no new daemon surface).

## Risks and Open Questions

1. **`canUseTool` ↔ daemon `awaiting_approval` semantics (the crux).** `canUseTool` fires **pre-dispatch**; the daemon's `awaiting_approval` is **post-dispatch**. They are two distinct gates (requester-side local confirmation vs receiver-side authority). This spec recommends treating them as composable: `canUseTool` is the local "should I even ask?" gate (default: prompt for `mx_delegate_tool`/`mx_run_command`), and the daemon's `awaiting_approval` is surfaced by the hidden-poll-loop policy. **Confirm** this two-gate model matches the intended operator UX, and that AC2 ("`canUseTool` presents HITL for an approval-gated call") is satisfied by the pre-dispatch local prompt (it is, and it is secret-free) rather than requiring `canUseTool` to literally reflect the daemon's held state.
2. **Reuse `@mx-loom/mcp` vs extract a shared core.** Recommendation: depend on `@mx-loom/mcp` for `dispatchCall`/`createBindingContext`/`serializeToolResult` (T109 exported them for exactly this). Alternative: extract a `@mx-loom/binding-core` to avoid the Claude package depending on the "MCP" package by name. Recommendation stands (the in-process shim *is* an in-process MCP server, so the dependency is honest); confirm the naming is acceptable.
3. **Deferred-status disposition default.** Recommendation: hide the loop for `running` (resolve to terminal within `resolveTimeoutMs`), but **return** `awaiting_approval` by default (don't block the turn on a human), with an opt-in `awaitApproval` blocking mode. Confirm the default — the design §5 Claude flow supports "surface it, model fans out, resolve later," but some embeddings may prefer a single blocking call.
4. **SDK dependency shape & version.** Recommendation: `@anthropic-ai/claude-agent-sdk` as a **peerDependency** (`^0.3.183`) + devDependency, so the host's SDK is the single instance and version drift is the host's to manage. Confirm; and verify the exact `createSdkMcpServer`/`tool`/`canUseTool`/`PermissionResult` type names against the installed `0.3.183` `.d.ts` at implementation time (node_modules is absent in this checkout).
5. **Testing the model-in-the-loop offline.** A full `query()` round-trip needs a model (or a model mock the SDK supports). The realistic plan: unit-test the `tool()` handler + `canUseTool` directly against a fake daemon for T110, and defer the true end-to-end (real model emits the tool call, real approval gate) to **T114**. Confirm this split is acceptable for the T110 ACs.
6. **Server name / tool namespacing.** Proposed server name `'mx'` → `mcp__mx__mx_delegate_tool` (cosmetic double-`mx`). Alternatives: `'mxloom'` / `'mx-loom'` (note: hyphens in MCP server names — confirm the SDK's namespacing tolerates them) → `mcp__mx-loom__mx_delegate_tool`. Confirm the chosen name; the host needs it for `allowedTools`.
7. **`ZodRawShape` non-strict re-wrap.** The T111 README documents that `tool()` re-wraps a raw shape as a *non-strict* `z.object`, so `additionalProperties: false` strictness is lost at the Claude layer. This is acceptable (daemon re-validates), but confirm we are content relying on the daemon/toolbelt for strictness rather than passing a `.strict()` `z.object` (the SDK's `tool()` signature pins which form is even accepted — verify against 0.3.183).
8. **Wire-shape assumptions inherited, not re-pinned.** `call.start` param names, `CallResponse`/`invocation.get` disposition vocabulary, and `audit_ref` field availability remain staged behind the handlers' `MXL_CONFORMANCE_TWO_DAEMON=1` round-trip. T110 must not green its live-round-trip ACs without a daemon.

## Implementation Checklist

1. **Wire dependencies.** In `packages/claude/package.json`: move `@mx-loom/registry` to a runtime dep; add `@mx-loom/toolbelt`/`@mx-loom/mcp`/`@mx-loom/audit` (`workspace:*`); add `@anthropic-ai/claude-agent-sdk` peer (`^0.3.183`) + devDep; add `@modelcontextprotocol/sdk` if imported directly. `pnpm install`; confirm the workspace resolves.
2. **`src/names.ts` — namespacing.** Server name constant (proposed `'mx'`) + `mxToolName(verb, serverName?)` → `mcp__<server>__<verb>`.
3. **`src/resolve.ts` — hidden poll loop.** Wrap `mxAwaitResult`: `running` → resolve to terminal within `resolveTimeoutMs`; `awaiting_approval` → surface by default (opt-in `awaitApproval` blocking mode); terminal → pass through. Use the deterministic `sleep`/`now` seams. Never fabricate `timeout`.
4. **`src/tool-server.ts` — builder.** Enumerate `CANONICAL_M1_TOOLS`; convert each `input_schema` via `jsonSchemaToZodRawShape`; build a `tool()` per verb whose handler = `dispatchCall` → resolve → `withAudit` tap once → `serializeToolResult`; wrap in `createSdkMcpServer`. No per-tool special-casing. Build-time `JsonSchemaConversionError` surfaces a drifted schema loudly.
5. **`src/can-use-tool.ts` — HITL.** `createMxCanUseTool` + `wrapCanUseTool`: scope-match `mcp__<server>__mx_*`; `shouldPrompt` default (prompt for `mx_delegate_tool`/`mx_run_command`); build a **secret-free** `ApprovalSummary` (via `findCredentialShapedProperty`); call `onApprovalRequest`; map to `{behavior:'allow', updatedInput}` / `{behavior:'deny', message}`; honor `AbortSignal`; delegate other tools to `fallback`.
6. **`src/index.ts` — exports.** Add `createMxToolServer`, `createMxCanUseTool`, `wrapCanUseTool`, `mxToolName`, and the option/`ApprovalSummary` types. Keep the T111 exports.
7. **Tests.** Builder (nine tools, generated, no-authority, fail-closed), handler dispatch (AC1 sync), hidden poll loop (running→ok, awaiting_approval disposition), `canUseTool` HITL (AC2, secret-free, deny/allow, fallback, abort), secret-boundary/redaction, audit tap (in-memory + null), and the in-process integration round-trip (or the documented handler+callback-direct substitute). Stage the live model-in-the-loop golden arm for T114.
8. **`README.md`.** In-process usage, host `query()` composition, secret-boundary + HITL "local gate, not authority" statement, hidden-poll-loop + `awaitApproval`, namespaced names, audit opt-in.
9. **Docs.** Update `docs/mx-agent-tool-fabric-design.md` (§3/§8 status) and `docs/backlog.md` (T110 → Landed, M1 header, T114 fully wireable). Tick only proven ACs; leave the live model-in-the-loop arm staged.
10. **Verify.** `pnpm -r typecheck` + `pnpm -r test` green; the no-authority and secret-boundary invariants asserted; confirm **no new runtime dependency leaked into `@mx-loom/registry`/`@mx-loom/toolbelt`** and that the shim holds no secret.
