# T205 · Pi binding — native tool registration (`@mx-loom/pi`)

| | |
|---|---|
| Issue | [`#27`](https://github.com/kortiene/mx-loom/issues/27) · T205 · `area/pi` `type/feature` `P0` · **M** · M2 |
| Milestone | M2 — Universal binding |
| Decision gate | [`docs/pi-tool-surface-capability.md`](../docs/pi-tool-surface-capability.md) (T204 / #26) — **native tool registration, not MCP** |
| Acceptance criterion (issue) | A Pi agent calls `mx_delegate_tool` and receives the result |
| Status of this doc | Planning spec only — no binding code is written by this task |

## Problem Statement

mx-loom renders the mx-agent daemon's coordination RPCs as ordinary "tools" in each
runtime's native tool-calling ABI, from **one** canonical descriptor set
(`CANONICAL_M1_TOOLS` in `@mx-loom/registry`). Two bindings already exist — the
generated MCP server (`@mx-loom/mcp`, T109) and the Claude Agent SDK in-process shim
(`@mx-loom/claude`, T110) — and ADK (T201/T202) and OpenCode (T203) consume the MCP
server directly.

**Pi cannot.** The T204 spike established that `@earendil-works/pi-coding-agent` ships
**no built-in MCP client** (no `--mcp` flag, no `mcpServers` config); MCP for Pi is
only ever an extension-mediated, build-it-yourself path. So mx-loom cannot point Pi at
`@mx-loom/mcp` the way ADK (`MCPToolset`) or OpenCode (`mcp` entry) do.

The gap: there is **no Pi binding** today. `packages/pi` does not exist. A Pi-based
agent therefore cannot discover mx-agent agents, delegate a named tool, run a guarded
command, await a deferred/approval-gated result, or share context — none of the
nine M1 verbs are reachable from Pi. T205 closes that gap by generating Pi
`ToolDefinition[]` from the canonical registry and routing execution through the same
registry handlers + `@mx-loom/toolbelt` daemon seam every other binding already uses.

## Goals

- Create a new leaf package **`@mx-loom/pi`** (`packages/pi`) that exposes the nine
  canonical `mx_*` verbs to a Pi agent via Pi's **native** tool-registration API
  (SDK `customTools` / `defineTool`; extension-time `pi.registerTool()`).
- **Generate** the Pi `ToolDefinition[]` from `CANONICAL_M1_TOOLS` — never
  hand-author per-tool. Adding a tenth canonical descriptor must surface in Pi with
  no per-tool edit.
- Adapt each descriptor's draft-07 `input_schema` into Pi's TypeBox `parameters`
  **fail-closed**, emitting `StringEnum` (not `Type.Union`/`Type.Literal`) for every
  `enum` string field so Pi runs on Google-provider models do not silently break.
- Route each `execute()` through the existing registry handlers via the secret-free
  toolbelt `MxClient`/`MxSession` seam, preserving the T102 envelope, the closed
  error taxonomy, the idempotency-key contract, and the audit-row schema unchanged.
- Serialize the T102 envelope into Pi's `AgentToolResult` (full envelope JSON in both
  `content` and `details`, since Pi has no MCP `structuredContent` channel), with
  prompt guidelines that tell the model to resolve a `handle` via `mx_await_result`.
- Apply the `withAudit` tap exactly once at the Pi result-return chokepoint.
- Preserve every security invariant: secret boundary, out-of-process enforcement on
  the receiving daemon, no authority-mutation surface, no model self-approval.
- Provide a daemon-free unit/integration test suite and a **gated** live e2e arm
  ("a Pi agent calls `mx_delegate_tool` and receives the result") that is the
  building block for the T206 portability matrix Pi arm.

## Non-Goals

- **No MCP inside Pi.** Do not mount or spawn `@mx-loom/mcp` (`mx-loom-mcp`) from the
  Pi binding, and do not build a generic Pi-side MCP client extension (T204 option 2)
  — explicitly out of scope; revisit only under the T204 revisit condition.
- **No change to the canonical contract.** No new tool descriptors, no envelope
  change, no error-taxonomy change, no daemon-RPC change, no toolbelt-transport
  change, no change to `@mx-loom/registry` / `@mx-loom/mcp` / `@mx-loom/claude`
  behavior.
- **No new authority surface.** No `trust.*` / `approval.decide` / `policy.*` /
  `auth.*` / `device.*` / `daemon.*` is ever registered as a Pi tool.
- **No task-DAG verbs** (`mx_create_task` / `mx_update_task` / `mx_list_tasks`) — M3.
- **No multi-tenant / RLS / cost work** — M5.
- **The cross-runtime portability matrix** (running the golden scenario under ADK +
  OpenCode + Pi together) is **T206**, not T205. T205 owns only the Pi binding and a
  standalone gated Pi e2e.
- **No streaming of tool output into the model loop** (v2+; design §9).

## Relevant Repository Context

Stack: TypeScript, pnpm workspaces, Node ≥20.19, vitest, Apache-2.0. **The repo is no
longer docs-only** — these workspace packages exist and are landed:

- `@mx-loom/registry` (`packages/registry`) — the canonical descriptor model
  (`ToolDescriptor`), `CANONICAL_M1_TOOLS` (the **9** M1 verbs), the T102 result
  envelope + constructor helpers (`ok`/`running`/`awaitingApproval`/`denied`/`errored`),
  the closed `ERROR_CODES` taxonomy + `mapTransportError`/`mapDaemonError`, the
  `newIdempotencyKey()` contract, the security invariants
  (`MODEL_FACING_ALLOWLIST`, `FORBIDDEN_AUTHORITY_*`, `isForbiddenAuthorityVerb`,
  `CREDENTIAL_KEY_RE`), the Ajv validation seam (`createAjvValidator`,
  `JSON_SCHEMA_DIALECT`), and **all nine handlers** (`mxFindAgents`,
  `mxDescribeAgent`, `mxDelegateTool`, `mxRunCommand`, `mxAwaitResult`,
  `mxShareContext`, `mxGetContext`, `mxCancel`, `mxWorkspaceStatus`) plus their `Deps`
  types (`HandlerDeps`, `RoomScopedDeps`, `DelegateDeps`, `DaemonCall`). Every handler
  shares the shape `(input, deps) => Promise<ToolResult>` and **never throws**.
- `@mx-loom/toolbelt` (`packages/toolbelt`) — the daemon transport seam:
  `createClient`/`MxClient`, `openSession`/`MxSession`/`MxSessionOptions`, the
  deny-by-default `safeSubprocessEnv` env allowlist (`src/cli/env.ts`), and the
  secret guards `assertNoCredentialShapedArgs` (outbound) + `redactSecrets` (inbound,
  `src/guards.ts`). This is the only component that holds the socket; it is the
  chokepoint that enforces "no secret crosses Boundary A."
- `@mx-loom/mcp` (`packages/mcp`) — the generated MCP server. Its `dispatch.ts`
  (`dispatchCall`, the name→handler `DISPATCH` table, `ToolArgs`), `context.ts`
  (`createBindingContext`, `BindingContext`, `CreateBindingContextOptions`), and
  `serialize.ts` (`serializeToolResult` → MCP `CallToolResult`) are the **patterns**
  T205 follows. `dispatch.ts` and `context.ts` are binding-neutral (they return a
  `ToolResult` and carry a secret-free `BindingContext`); only `serialize.ts` is
  MCP-specific.
- `@mx-loom/claude` (`packages/claude`) — the in-process Claude shim and the T111
  **fail-closed** JSON Schema → Zod converter (`src/json-schema-to-zod.ts`,
  `jsonSchemaToZodRawShape`, `JsonSchemaConversionError`). The model for T205's
  fail-closed JSON Schema → TypeBox converter. It also demonstrates the
  **peerDependency** SDK pattern (`@anthropic-ai/claude-agent-sdk` as a peer +
  devDependency) and the single-chokepoint `withAudit` tap (`src/tool-server.ts`).
- `@mx-loom/audit` (`packages/audit`) — `withAudit(sink, baseCtx)` → an `AuditTap`,
  `auditRowFrom(result, ctx)`, `AuditContext`, `NullAuditSink`/`InMemoryAuditSink`/
  `PostgresAuditSink`. The best-effort tap a binding applies once at its single
  result-return chokepoint.
- `@mx-loom/golden` (`packages/golden`) — the M1 golden gate + the home for gated
  binding e2e arms (ADK `MXL_ADK_*_E2E`, OpenCode `MXL_OPENCODE_MCP_E2E`, and the
  T204 Pi-capability smoke `test/t204-pi-capability.e2e.test.ts`). The Pi live arm
  lands here too.

**`packages/pi` does NOT exist yet** — creating it is the core of T205, and the
`@mx-loom/pi` package name + public surface below are **proposed**, not built.

T204 decision (load-bearing for T205): Pi has no built-in MCP client → native
registration. Pi's tool shape is `ToolDefinition<TParams extends TSchema>` —
`name`, `label`, `description`, optional prompt metadata
(`promptSnippet`/`promptGuidelines`), `parameters` (TypeBox `TSchema`), and
`execute(toolCallId, params, signal, onUpdate, ctx)` returning `AgentToolResult`.
Pi exports `defineTool()`, accepts `createAgentSession({ customTools: ToolDefinition[] })`,
and supports extension-time `pi.registerTool()`. `StringEnum` comes from
`@earendil-works/pi-ai`. Pi 0.74.2 was observed (`engines.node >=20.6.0`, bundled
`typebox@^1.1.24`); **re-confirm symbols/ranges at the pinned target version.**

Existing precedent for native consumption: `adw_sdlc/src/runners/runner-pi.ts`
already wraps Pi behind the mx-agency `AgentRunner` seam (import-free, because Pi's
npm `engines` floor is version-dependent). T205 should reuse that `AgentRunner` seam
rather than introduce a parallel Pi integration path (issue scope note).

## Proposed Implementation

Create `@mx-loom/pi` (`packages/pi`) as a thin, secret-free map from the canonical
registry to Pi's native tool type. Six small modules plus tests.

### 1. Schema adapter — JSON Schema → TypeBox (`src/json-schema-to-typebox.ts`)

Model it on the T111 Zod converter (`@mx-loom/claude`):

- Cover the **exact draft-07 subset** the nine canonical input schemas use: closed/open
  `object` (via `additionalProperties`), `string` (+ `enum`), `integer` (+ bounds),
  `array` (+ `items`), `boolean`, `number`, `required`/optional, `description`, and
  nested objects.
- **Enums → `StringEnum`** (imported from `@earendil-works/pi-ai`), never
  `Type.Union`/`Type.Literal`. `CANONICAL_M1_TOOLS` carries **seven** `enum` string
  fields that must each route through `StringEnum`:
  - `liveness: ['active','stale','offline']` — `mx_find_agents` (input + output),
    `mx_describe_agent`, `mx_workspace_status`;
  - `kind: ['file','diff','env']` — `mx_share_context`, `mx_get_context`;
  - `encoding: ['utf-8','base64']` — `mx_share_context`.
- **Fail-closed:** any unsupported construct (`oneOf`/`anyOf`/`allOf`/`not`,
  `$ref`/`$defs`, `if`, `patternProperties`, tuple `items`, union/`null`/unknown
  `type`, schema-valued `additionalProperties`, non-string `enum` member) throws a
  typed `PiSchemaConversionError(path, keyword)` at **build/startup** time — **never**
  degrades to a permissive `Type.Any()`. This mirrors T111's `JsonSchemaConversionError`.
- The dynamic inner `args` object of `mx_delegate_tool` (the target tool's own schema,
  fetched at call time) stays handler-validated by `mxDelegateTool` (T105); the Pi
  `parameters` for `mx_delegate_tool` describe only the **outer** delegation args
  (`agent`/`tool`/`args`/`wait_ms`/`idempotency_key`), exactly as the descriptor does.

**Runtime validation is not assumed from TypeBox.** Per T204, TypeBox `Unsafe()` only
*tags* a schema for serialization to the model — it is not confirmed to add runtime
validation in Pi's tool pipeline, and the other bindings get outer-arg validation
"for free" from their SDK (MCP validates against JSON Schema; Claude parses against
Zod). To match that guarantee, each `execute()` runs a **fail-closed Ajv preflight**
against the descriptor's `input_schema` (the registry's `createAjvValidator()` — the
same seam the loader and T105 use) **before** dispatch, returning
`errored('invalid_args', …)` on mismatch. So the TypeBox schema is the model-facing
shape; the Ajv preflight is the real gate. (Equivalence between the two is asserted by
the converter test suite — accept/reject parity per representative sample, every enum
field included.)

### 2. Dispatch + binding context (`src/dispatch.ts`, `src/context.ts`)

Reuse the **patterns** from `@mx-loom/mcp` (`dispatchCall`, the name→handler table,
`createBindingContext`/`BindingContext`). The router is binding-neutral: look up the
verb by name, build the handler's `deps` subtype from the `BindingContext`
(`HandlerDeps` / `RoomScopedDeps` / `DelegateDeps`), call it, get a `ToolResult`. The
session **`room`** always comes from the context (the `MxSession`), **never** from the
model's `params`. An unknown name resolves to `errored('not_found', …)`, never a throw.

> **Decision to confirm (see Open Questions #1):** whether to (a) **reimplement** this
> ~50-line dispatch + context locally in `@mx-loom/pi` (honoring T204's "`@mx-loom/mcp`
> is reference-only, not a runtime dep" — keeps the MCP SDK out of Pi's dep graph), or
> (b) **depend on `@mx-loom/mcp`** at runtime to import `dispatchCall` +
> `createBindingContext` (the T110 Claude precedent), writing only the Pi serializer.
> Recommended: **(a)** for T205 scope, guarded by a drift test pinning the Pi tool set
> against `CANONICAL_M1_TOOLS`; note **(c)** extract a binding-neutral
> `@mx-loom/binding-core` as the principled follow-up if a fourth consumer appears.

### 3. Envelope serializer (`src/serialize.ts`)

A pure, total `serializePiToolResult(result: ToolResult): AgentToolResult`:

- Place the **full envelope JSON** in `content[0].text` **and** in `details` (Pi has no
  `structuredContent` equivalent — both channels carry the same verbatim envelope:
  `status`, `result`, `error`, `handle`, `approval`, `audit_ref`).
- `denied` / `running` / `awaiting_approval` are **not** failures — they are outcomes
  the model reads and replans around (the same rule as the MCP serializer's
  `isError === (status === 'error')`). Map them to a *successful* `AgentToolResult` that
  carries the envelope; reserve any Pi "failed"/error result flag for genuine adapter
  bugs.
- The serializer copies **only** the envelope (already secret-free by the T102/T008
  contract) and never reaches outside it, so it can introduce no leak.

Confirm the exact `AgentToolResult` field shapes (`content` array element type, the
`details` type, any success/error flag) against Pi's `dist/index.d.ts` at the pinned
version.

### 4. Tool generation (`src/tools.ts`)

`createPiToolDefinitions(ctx, options?)` enumerates `CANONICAL_M1_TOOLS` → one
`ToolDefinition` per descriptor (via `defineTool` when available):

- `name` ← `descriptor.name` (the canonical `mx_*` name, preserved verbatim);
  `label`/`description` ← `descriptor.description`.
- `parameters` ← the TypeBox schema from the §1 converter (fail-closed at build).
- `promptSnippet` / `promptGuidelines` ← a generated, non-empty hint that **names the
  tool** and, for verbs with deferred semantics, tells the model to call
  `mx_await_result(handle)` when it gets `status: running` / `awaiting_approval`.
- `execute(toolCallId, params, signal, ...)` ← the closure: Ajv preflight (§1) →
  `dispatchCall(name, params, ctx)` (§2) → `withAudit` tap (§5) →
  `serializePiToolResult` (§3). Honor `signal` (`AbortSignal`) for cancellation. **Wrap
  the body in try/catch and convert any thrown adapter bug to
  `errored('internal', …)`** rather than letting it throw (a throw marks the Pi tool
  *failed* and may discard the envelope).

**Deferred results stay model-driven (baseline).** The handlers already make the
deferred protocol first-class: `mxDelegateTool` / `mxRunCommand` accept `wait_ms` and
compose `mx_await_result` inline (T105/T103), and `mx_await_result` is itself one of
the nine generated tools. So the Pi binding does **not** need its own hidden poll loop:
a `running` / `awaiting_approval` envelope surfaces with its `handle` and the prompt
guidance, and the model resolves it via `mx_await_result`. (An *opt-in* bounded inline
resolve — reusing the registry's `mxAwaitResult` and the `execute` `AbortSignal`,
mirroring Claude's `resolveDeferred` — is a documented enhancement, not the baseline.)

### 5. Audit tap

Apply `withAudit(ctx.auditSink, { correlation_id })` **once** at the `execute()`
result-return chokepoint, supplying `tool_name` (the descriptor name), `call_id`
(Pi's `toolCallId`), and `idempotency_key` (when the mutating verb's args carry one).
Best-effort: sink failures are swallowed and logged secret-free; a Postgres outage
never blocks a tool call. Default sink: `NullAuditSink` (audit off unless opted in).

### 6. Registration helpers + extension (`src/register.ts`, `src/index.ts`)

Public surface (per the T204 guidance — these names are proposed):

- `createPiBindingContext(options?)` — open/bind the secret-free `BindingContext`
  (open an `MxSession`, or bind an injected session / bare `DaemonCall` for tests),
  with an optional `AuditSink`.
- `createPiToolDefinitions(ctx, options?)` — the generated `ToolDefinition[]` (§4),
  ready for `createAgentSession({ customTools })`.
- `registerMxTools(pi, options?)` — extension-time helper that calls
  `pi.registerTool(t)` for each generated tool (callable during load **or** after
  startup; new tools appear in `pi.getAllTools()` without `/reload`).
- *Optional* `createMxPiExtension(options?)` / a default extension export — once Pi's
  package-loading semantics are verified at the pinned version.

Document **active-tool selection** (`--tools`, `--no-tools`, `--no-builtin-tools`,
`pi.getAllTools()`, `pi.setActiveTools()`): how to enable *only* the generated `mx_*`
tools, and that registration does not make a disabled tool callable.

### 7. Dependency wiring (`packages/pi/package.json`)

- Runtime deps: `@mx-loom/registry` (`workspace:*`), `@mx-loom/toolbelt`
  (`workspace:*`), `@mx-loom/audit` (`workspace:*`); `@mx-loom/mcp` **only** under
  Open-Question option (b).
- **peerDependencies** (host owns the single instance): `@earendil-works/pi-coding-agent`,
  the bundled TypeBox package (observed `typebox@^1.x` in Pi 0.74.2 — confirm exact
  package name + range at the pin), and `@earendil-works/pi-ai` (for `StringEnum`) —
  with matching devDependencies. **Import all Pi/TypeBox types `type`-only** so
  `@mx-loom/pi` type-checks even when the peer is absent (Pi's `engines` floor is
  version-dependent). Pin TypeBox to Pi's major to avoid a split TypeBox runtime.
- **No `bin`** — unlike `mx-loom-mcp`, the Pi binding is a library/extension consumed
  in-process by Pi; it spawns nothing.

## Affected Files / Packages / Modules

**New — `packages/pi/` (`@mx-loom/pi`):**
- `package.json`, `tsconfig.json`, `tsconfig.build.json`, `README.md`
- `src/index.ts` — public exports
- `src/json-schema-to-typebox.ts` — fail-closed converter + `PiSchemaConversionError`
- `src/serialize.ts` — `serializePiToolResult` (envelope → `AgentToolResult`)
- `src/tools.ts` — `createPiToolDefinitions` (descriptors → `ToolDefinition[]`)
- `src/context.ts` — `createPiBindingContext` / `BindingContext` (or re-export from `@mx-loom/mcp` under OQ option b)
- `src/dispatch.ts` — name→handler router (or re-export from `@mx-loom/mcp` under OQ option b)
- `src/register.ts` — `registerMxTools`, optional `createMxPiExtension`
- `src/names.ts` — tool-name helpers if needed
- `test/` — `tools.test.ts`, `json-schema-to-typebox.test.ts`, `serialize.test.ts`,
  `dispatch.test.ts`, `register.test.ts`, `secret-boundary.test.ts`, `audit.test.ts`

**New — gated e2e (in `@mx-loom/golden`):**
- `packages/golden/test/t205-pi-binding.e2e.test.ts` — the live "Pi agent calls
  `mx_delegate_tool`" arm (gated; building block for the T206 Pi arm).

**Read / referenced (not modified):**
- `packages/registry/src/index.ts`, `descriptors/`, `handlers/`, `security.ts`,
  `validator.ts`, `envelope.ts`, `errors.ts`
- `packages/mcp/src/dispatch.ts`, `context.ts`, `serialize.ts` (patterns)
- `packages/claude/src/json-schema-to-zod.ts`, `tool-server.ts`, `package.json` (patterns)
- `packages/toolbelt/src/cli/env.ts`, `guards.ts`, `session*` (the seam)
- `packages/audit/src/with-audit.ts`, `row.ts`
- `adw_sdlc/src/runners/runner-pi.ts` (the `AgentRunner` seam to reuse)

**Modified (docs / workspace):**
- `docs/mx-agent-tool-fabric-design.md` (§3 Pi bullet, §10 M2 row)
- `docs/backlog.md` (T205 status; design-doc status line)
- `docs/pi-tool-surface-capability.md` (mark the T205 consequence delivered)
- Workspace config if the package glob is not already `packages/*`
- *Optional* `examples/pi/` (mirroring `examples/adk/` and `examples/opencode/`)

## API / Interface Changes

**New public API** — the `@mx-loom/pi` package surface (proposed names):
`createPiBindingContext(options?)`, `createPiToolDefinitions(ctx, options?)`,
`registerMxTools(pi, options?)`, optional `createMxPiExtension(options?)`, the
converter (`jsonSchemaToTypeBox` + `PiSchemaConversionError`), and
`serializePiToolResult`. These are net-new and must be documented in the package
README and the design doc.

**No CLI surface** — no new `bin` (the binding is in-process; it does not spawn a
subprocess). **No new tool-descriptor surface** — the nine `mx_*` descriptors are
reused verbatim from `@mx-loom/registry`. **No daemon-RPC change.** **No change** to
`@mx-loom/registry` / `@mx-loom/mcp` / `@mx-loom/claude` public surfaces.

## Data Model / Protocol Changes

**None to the canonical contract.** The Pi binding preserves:
- the **T102 result envelope** (`status` ∈ `ok|running|awaiting_approval|denied|error`,
  `result`, `error.code` from the closed taxonomy, `handle`, `approval`, `audit_ref`
  always present);
- the **deferred-result protocol** (`running` / `awaiting_approval` → resolve via
  `mx_await_result`);
- the **idempotency-key** semantics (mutating verbs pass a caller key through and
  generate one when omitted, via the existing handlers / `newIdempotencyKey()`);
- the **audit-row schema** (`auditRowFrom` + `AuditRow`, unchanged).

The only new *serialization* is the binding-local rendering of the unchanged envelope
into Pi's `AgentToolResult` (`content` + `details`) — a Pi-side presentation, not a
contract change.

## Security & Compliance Considerations

- **Secret boundary (Boundary A) is preserved unmodified.** Every daemon call routes
  through `ctx.daemon` (an `MxSession`/`MxClient`) via `dispatchCall` → the registry
  handlers, so the toolbelt's deny-by-default env allowlist (`safeSubprocessEnv`), the
  outbound `assertNoCredentialShapedArgs` (rejects credential-shaped args as
  `invalid_args`), and the inbound `redactSecrets` all stay in force. Matrix tokens,
  Ed25519 signing keys, provider keys, and `GH_TOKEN` **never** cross into Pi, the
  model context, or any child process. The binding holds **no** secret, reads **no**
  env var for daemon access, and starts **no** child process.
- **Pi-specific hazard (T204):** Pi extensions run with **full system permissions**.
  The `@mx-loom/pi` extension/package must therefore stay small and auditable, must
  **not** call `pi.exec()` or spawn child processes for normal operation, and must
  reach mx-agent **only** through the toolbelt daemon client. If Pi needs provider auth
  for its own model calls, that is outside the mx-loom tool contract and must not be
  read, copied, logged, or forwarded by the binding.
- **Out-of-process enforcement is unchanged.** Trust (Ed25519 store), deny-by-default
  `policy.toml`, sandbox, and human approval gates all execute on the **receiving**
  mx-agent daemon. The Pi binding only renders signed *requests*; cognition can never
  grant itself authority.
- **No authority surface.** Register **only** the nine model-facing `mx_*` verbs.
  `trust.*` / `approval.decide` / `policy.*` / `auth.*` / `device.*` / `daemon.*` are
  structurally unreachable (the dispatch table is keyed off `CANONICAL_M1_TOOLS`; a
  test asserts the generated set ∩ `FORBIDDEN_AUTHORITY_VERBS` = ∅). Approval reaches
  the model **only** as `status: "awaiting_approval"`, re-validated against live policy
  at release; the model is never given an approval-mutation tool and cannot self-approve.
- **Secret-free contract.** No Pi tool field carries a credential inbound or outbound;
  the canonical input schemas are already secret-free by construction
  (`findCredentialShapedProperty` enforced at registry load), and credential-shaped
  args are rejected by the toolbelt guard before dispatch.
- **Audit correlation.** `audit_ref` is present on every result; the single `withAudit`
  tap writes one non-secret row per emission (no `result` payload, `error.message`, or
  `approval.summary` columns), joinable by `correlation_id` / `invocation_id`.
- **Logging / redaction.** Never log tokens, signing keys, provider keys, `GH_TOKEN`,
  raw args, or raw env. Audit-failure logs carry class + `dedup_key` only.

## Testing Plan

Daemon-free unit/integration suite (against a fake `DaemonCall`), plus a gated live arm.
Folds in the T204 "T205 verification checklist":

1. **Generated tool list:** generated names exactly equal `CANONICAL_M1_TOOLS`; every
   `promptSnippet`/`promptGuideline` is non-empty and names its tool; the set contains
   no authority verb (∩ `FORBIDDEN_AUTHORITY_VERBS` = ∅). Drift guard: adding a tenth
   descriptor surfaces with no per-tool edit.
2. **Schema adapter:** each canonical `input_schema` accepts/rejects the same
   representative valid+invalid samples as the registry Ajv seam (`createAjvValidator`);
   **all seven** descriptor string-enum fields serialize through `StringEnum` (not
   `Type.Union`/`Type.Literal`); every unsupported construct fails closed with
   `PiSchemaConversionError(path, keyword)` at build/startup (never `Type.Any()`).
3. **Execution + serialization:** fake daemon results for **all five** statuses
   (`ok`, `running`, `awaiting_approval`, `denied`, `error`) each return an
   `AgentToolResult` carrying the full envelope in **both** `content[0].text` and
   `details` — including `handle`, `approval`, the error `code`, and `audit_ref`. A
   thrown adapter bug is converted to `errored('internal', …)`, never propagated.
4. **Deferred protocol:** `running` / `awaiting_approval` carry a `handle`; the
   generated `mx_await_result` tool resolves a fake terminal state with **no**
   approval-mutation surface exposed.
5. **Idempotency:** `mx_delegate_tool` / `mx_run_command` pass a caller
   `idempotency_key` through and generate one when omitted (handler behavior preserved).
6. **Secret boundary / redaction:** credential-shaped args are rejected before dispatch
   (`invalid_args`); token-shaped fake daemon values are redacted in `content` **and**
   `details`; the room is taken from the session, never from `params`; logs are
   secret-free.
7. **Audit:** exactly **one** `withAudit` tap runs at the result-return chokepoint;
   sink failures are swallowed without changing the envelope; default `NullAuditSink`.
8. **SDK / extension integration:** generated `customTools` appear in a Pi
   `AgentSession`, and `registerMxTools(pi, …)` / `createMxPiExtension()` register
   dynamically without `/reload`, under the chosen active-tool allowlist. (Use the Pi
   SDK if the peer is installed; otherwise an ABI-shaped fake.)
9. **Version compatibility:** assert the Pi SDK symbols T205 uses
   (`ToolDefinition`, `AgentToolResult`, `defineTool`, `customTools`, `registerTool`,
   TypeBox, `StringEnum`) exist at the pinned target Pi version.
10. **Live portability / e2e (gated):** `packages/golden/test/t205-pi-binding.e2e.test.ts`
    — a real Pi agent calls `mx_delegate_tool` on a second registered agent across a
    room and receives the result (the issue's AC), via **native registration**. Gated
    behind `MXL_PI_BINDING_E2E=1` + `MXL_CONFORMANCE_TWO_DAEMON=1`
    (+ `MXL_CONFORMANCE_GOLDEN_POLICY=1`, + a model var for the model-in-loop arm).
    **Skip-clean** with no fixture; **fail-not-skip** in CI when the flag is set but the
    daemon/Pi/fixture is missing. Never assumed green without the fixture. This is the
    building block the T206 Pi arm consumes.

Run `pnpm -r typecheck` + `pnpm -r build` + the package test suite; keep the existing
suites green.

## Documentation Updates

- **`docs/mx-agent-tool-fabric-design.md`** — update the §3 Pi runtime bullet and the
  §10 M2 roadmap row to mark `@mx-loom/pi` (native registration) **landed** once
  implemented; add the package to the status header line. Do not imply unimplemented
  behavior (e.g. an inline poll loop) exists unless it ships.
- **`docs/backlog.md`** — flip the T205 acceptance checkbox per the live-gate caveat
  (mechanism landed; live green staged behind the two-daemon/Pi fixture), and add the
  T205 `Status:` paragraph in the house style; update the design-doc/backlog status
  lines.
- **`docs/pi-tool-surface-capability.md`** — mark the "Consequences for T205" /
  "T205 verification checklist" items as delivered, with cross-refs to the new package
  and tests.
- **`packages/pi/README.md`** — install (peer deps), the SDK `customTools` recipe, the
  extension `registerMxTools` / `createMxPiExtension` recipe, active-tool selection,
  the deferred-result/`mx_await_result` note, and the secret-boundary statement.
- **`docs/pi-tool-surface-capability.md` / `docs/mx-agent-pin.md`** — record the pinned
  Pi version and the re-confirmation of `engines`/TypeBox/`StringEnum` ranges.
- *Optional* `examples/pi/` mirroring `examples/adk/` + `examples/opencode/`.

## Risks and Open Questions

1. **`@mx-loom/mcp` runtime dependency vs reimplementation (central).** T204 says
   `@mx-loom/mcp` is "reference-only, not a runtime dep" for Pi, but the T110 Claude
   binding *does* depend on it at runtime for `dispatchCall`/`createBindingContext`.
   Depending on `@mx-loom/mcp` drags `@modelcontextprotocol/sdk` into Pi's dep graph
   even though Pi never speaks MCP. **Recommendation:** reimplement the small
   dispatch + context locally in `@mx-loom/pi` (honor T204; keep the dep graph clean),
   guarded by a drift test against `CANONICAL_M1_TOOLS`; note `@mx-loom/binding-core`
   extraction as the principled follow-up. **Confirm before building.**
2. **Pi SDK symbol/shape drift.** `ToolDefinition`, `AgentToolResult` (the `content`
   array element type, the `details` type, any success/error flag), `defineTool`,
   `customTools`, `registerTool`, `StringEnum`, and the TypeBox package name/range were
   observed at Pi `0.74.2` only. **Re-confirm every symbol against `dist/index.d.ts`
   at the pinned target version** before relying on it; the version-compatibility test
   (Testing Plan #9) is the guard.
3. **TypeBox runtime validation.** TypeBox `Unsafe()` only *tags* for serialization;
   Pi is not confirmed to validate `parameters` at runtime. The fail-closed Ajv
   preflight (§1) is the mitigation — without it, outer args could reach a handler
   unvalidated. Confirm whether Pi validates TypeBox so the preflight is not redundant
   (it is cheap and safe either way).
4. **`StringEnum` for Google providers.** A naive `enum → Type.Union` would pass the
   Ajv equivalence test yet silently break Pi runs on Google models. Equivalence tests
   must cover **every** enum field, and the T204 e2e already grounds a *real* registry
   enum value-set surviving `StringEnum` → live-Pi-TypeBox registration.
5. **Deferred-result UX.** The baseline is model-driven (`mx_await_result`); Pi has no
   ADK-style long-running protocol. Confirm whether an opt-in bounded inline resolve is
   wanted for M2 or deferred — the handlers already support `wait_ms` inline resolution.
6. **`peerDependency` vs `optionalDependency`.** T110 used a peer; `runner-pi.ts` stays
   import-free because Pi's `engines` floor is version-dependent. **Recommendation:**
   peer + `type`-only imports (type-checks without the peer). Confirm the floor at the
   pin (Pi 0.74.2 = `>=20.6.0`, satisfied by mx-loom's `>=20.19`).
7. **Pinning Pi.** Pi is an alpha-ish fast-moving SDK; consider recording the pinned Pi
   version in `docs/mx-agent-pin.md` / the capability doc and gating bumps on the T205
   tests + the version-compatibility assertion.
8. **Live-fixture provenance.** The Pi live arm needs the two-daemon golden fixture
   (homeserver / pinned-binary provenance) plus a Pi-runnable model — the same staging
   constraint as every M1/M2 live arm. Treat a daemon/Pi rejection as **red**, never
   green-by-assumption.

## Implementation Checklist

1. Confirm Open Question #1 (reimplement dispatch+context locally vs depend on
   `@mx-loom/mcp`) and #6 (peer vs optional dep). Re-confirm the pinned Pi version +
   the Pi/TypeBox/`StringEnum` symbol ranges (#2).
2. Scaffold `packages/pi` (`@mx-loom/pi`): `package.json` (peer deps `type`-only,
   no `bin`), `tsconfig*.json`, `README.md`; register it in the workspace if needed.
3. Implement `src/json-schema-to-typebox.ts` — fail-closed converter +
   `PiSchemaConversionError`; **enums → `StringEnum`**; cover the canonical subset only.
4. Implement `src/serialize.ts` — `serializePiToolResult` (envelope → `AgentToolResult`,
   full envelope in `content` + `details`; `denied`/`running`/`awaiting_approval` are
   not failures).
5. Implement `src/context.ts` + `src/dispatch.ts` (per OQ #1) — secret-free
   `BindingContext`; room from the session, never `params`; unknown name →
   `errored('not_found')`.
6. Implement `src/tools.ts` — `createPiToolDefinitions`: generate one `ToolDefinition`
   per descriptor with the converted `parameters`, generated prompt metadata, and the
   `execute` closure (Ajv preflight → `dispatchCall` → `withAudit` → serialize, all in
   try/catch → `errored('internal')`).
7. Implement `src/register.ts` — `registerMxTools(pi, …)` and optional
   `createMxPiExtension(…)`; document active-tool selection.
8. Wire the single `withAudit` tap at the `execute` chokepoint
   (`tool_name`/`call_id`=`toolCallId`/`idempotency_key`); default `NullAuditSink`.
9. Export the public surface from `src/index.ts`.
10. Add the daemon-free test suite (Testing Plan #1–#9) against a fake `DaemonCall`.
11. Add the gated live e2e `packages/golden/test/t205-pi-binding.e2e.test.ts`
    (Testing Plan #10) — skip-clean / fail-not-skip; the issue's AC.
12. `pnpm -r typecheck && pnpm -r build && pnpm --filter @mx-loom/pi test`; keep all
    existing suites green.
13. Update docs (design §3/§10, backlog T205 status, capability doc, package README,
    pin doc); optionally add `examples/pi/`.
14. Verify the no-authority, secret-boundary, and audit invariants hold end-to-end
    before marking the AC; never log secrets; never green-by-assumption on the live arm.
