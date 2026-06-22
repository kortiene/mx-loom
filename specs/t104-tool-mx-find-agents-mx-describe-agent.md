# T104 · tool: `mx_find_agents` + `mx_describe_agent` (discovery handlers)

> GitHub issue #12 · `area/registry` `type/feature` `priority/P0` · Estimate **S** · Milestone **M1 — Delegation MVP** · Source `docs/backlog.md` (`T104`).
> Blocked-by #9 (T101 — canonical descriptor model, **landed**). Sits alongside the **landed** T102 (#10, envelope/taxonomy) and T103 (#11, the first handler + the injected daemon seam).

---

## Problem Statement

mx-loom's job is to render the mx-agent daemon's coordination RPCs as ordinary,
secret-free "tools" the model can call. The **discovery** pair — `mx_find_agents`
("who is in the workspace and what can they do?") and `mx_describe_agent`
("show me one agent and the exact tool schemas it publishes") — is the first
thing a planning runtime needs: you cannot delegate (`mx_delegate_tool`, T105)
until you can discover a target and read the `input_schema` of the tool you want
to invoke.

Today the repository has the *descriptors* for both verbs but **no behavior**:

- **`mx_find_agents` / `mx_describe_agent` descriptors exist** as frozen,
  validated metadata in `@mx-loom/registry`
  (`packages/registry/src/descriptors/find-agents.ts`,
  `.../describe-agent.ts`, authored by T101). They carry `name`, `description`,
  `input_schema`, `output_schema`, and `async_semantics: 'sync'` — and explicitly
  **no** daemon-RPC mapping and no result envelope (those are deferred to the
  handlers, by design).
- **The handler seam exists** (T103): `HandlerDeps`/`DaemonCall`
  (`packages/registry/src/handlers/deps.ts`) is the injected daemon-call surface
  the first handler (`mxAwaitResult`) established for T104–T108 to reuse, and the
  T102 envelope constructor helpers (`ok`/`running`/`awaitingApproval`/`denied`/
  `errored`) plus the closed error taxonomy (`mapDaemonError`/`mapTransportError`)
  are the only sanctioned way to build a conforming result.

What is missing is the thin glue: two `sync` read handlers that take the
descriptor's validated input, call the daemon's verified discovery RPCs
(`agent.list`, `agent.tools`), apply the model-requested filters, **project the
daemon's agent records onto a non-secret subset**, and return a T102 envelope.
Without them, neither binding (MCP T109, Claude shim T110) nor the golden
end-to-end test (T114) can surface discovery, and cognition has no way to learn
which agents exist or what tools they expose.

Two concrete gaps surfaced while reading the current code that this spec must
resolve (details in **Risks and Open Questions**):

1. **The `mx_find_agents` `output_schema` is `type: 'array'`, but the T102
   envelope `ok` branch requires `result: { type: 'object' }`.** A bare-array
   success payload would *fail* `validateEnvelope`. T104 must reconcile this —
   the recommendation below wraps the array in an object (`{ agents: [...] }`).
2. **`agent.show` is not in the verified v0.2.1 surface.** The `describe-agent`
   descriptor comment says "backed by `agent.show` + `agent.tools`", but
   `docs/mx-agent-surface-v0.2.1.md` only live-verified `agent.list` and
   `agent.tools`. T104 should default to the verified surface and treat
   `agent.show` as optional.

---

## Goals

- Implement two `sync` discovery handlers in `@mx-loom/registry`, reusing the
  T103 `HandlerDeps`/`DaemonCall` seam and the T102 envelope helpers — no new
  transport, no socket, no env access, zero added runtime dependency on the
  toolbelt (the `MxTransport` type is imported `type`-only).
- **`mx_find_agents`** — call the daemon `agent.list` once, apply the
  descriptor's filters (`capability`, `tool`, `liveness`) client-side with **AND**
  semantics (absent filters match all), project each surviving row onto a
  non-secret agent summary, and return `ok({ agents: AgentSummary[] }, audit_ref)`.
  - **AC 1 — "Filter by capability returns expected agents."**
- **`mx_describe_agent`** — resolve a single agent's record and its published
  `ToolSchema[]` (via `agent.tools`, plus `agent.list`/optional `agent.show` for
  the liveness/workspace/load metadata the schemas RPC does not carry), project,
  and return `ok({ agent, tools }, audit_ref)`.
  - **AC 2 — "`mx_describe_agent` returns the target's tool schemas."**
- Map every daemon/transport fault onto the closed T102 taxonomy through the
  existing mappers (e.g. an unknown `agent_id` → `not_found`; a transport fault →
  `internal`/`timeout`), returning the fault envelope — handlers **never throw**
  to the caller, mirroring `mxAwaitResult`.
- Reconcile the `mx_find_agents` `output_schema` ↔ envelope conflict so both
  handler outputs validate against `ENVELOPE_SCHEMA`.
- Keep the contract **secret-free**: project out the public-but-noisy identifiers
  (`matrix_user_id`, `device_id`, `signing_key_id`, `signing_public_key`) so they
  never reach the model context, even though they are non-secret.
- Export `mxFindAgents` / `mxDescribeAgent` (+ their input types) from the handler
  barrel and the package root, and update the descriptor/README/backlog docs.

---

## Non-Goals

- **Trust mutation or any authority surface** (issue "Out of scope"). Discovery
  only *reads* agent/trust/liveness state; it never approves, revokes, or mutates
  trust, policy, or approvals. No `trust.*` / `approval.*` / `policy.*` RPC is
  touched.
- **New daemon RPCs or server-side filtering.** T104 consumes the *verified*
  v0.2.1 surface (`agent.list`, `agent.tools`) and filters client-side. Adding a
  server-side capability filter to the daemon is out of scope.
- **Delegation / guarded exec** (`mx_delegate_tool` T105, `mx_run_command` T106) —
  T104 only discovers; it does not invoke remote tools.
- **The deferred-result protocol.** Both verbs are `async_semantics: 'sync'`:
  they resolve to a terminal `ok`/`denied`/`error` envelope directly. No `handle`,
  no `wait_ms` poll loop, no `idempotency_key` (these are reads, not mutations).
- **Bindings** (MCP T109, Claude shim T110) and the **Postgres audit mirror**
  (T113) — T104 produces the envelopes those consume; it does not wire them.
- **`mx_workspace_status` / `mx_cancel`** (T108) and **`agent.register`/session
  lifecycle** (T005, already landed in the toolbelt) — not discovery verbs.
- **Live two-daemon conformance.** Discovery reads work against a single local
  daemon; the staged two-daemon fixture (`MXL_CONFORMANCE_TWO_DAEMON=1`) is for
  delegation (T105/T106), not T104.

---

## Relevant Repository Context

The stack is TypeScript (pnpm workspace, Node ≥ 20.19, vitest, Apache-2.0). The
repo is **no longer docs-only**: M0 (`@mx-loom/toolbelt`) and the first three M1
registry tasks (T101–T103) are landed. T104 extends the existing
`@mx-loom/registry` package; **no new package is created.**

### Packages that exist

- **`@mx-loom/toolbelt`** (`packages/toolbelt`) — Boundary B. The framed
  Unix-socket JSON-RPC client + `--json` CLI fallback behind `MxClient`
  (`createClient`), the `MxTransport` interface (`src/transport.ts`), the
  session model (`openSession`), and the T008 secret-boundary guard
  (`assertNoCredentialShapedArgs` + inbound `redactSecrets`, run on every
  `MxClient.call`). The closed transport error set is `TransportErrorCode`.
- **`@mx-loom/registry`** (`packages/registry`) — Boundary-A-facing contract +
  handler layer. Relevant existing modules:
  - `src/descriptor.ts` — `ToolDescriptor`, `defineDescriptor`, `TOOL_NAME_RE`,
    `JsonSchema`, `AsyncSemantics`.
  - `src/descriptors/find-agents.ts`, `src/descriptors/describe-agent.ts` — the
    **two descriptors T104 implements** (read these first; their `output_schema`
    is the shape the handlers must return).
  - `src/envelope.ts` — `ToolResult` + the constructor helpers `ok`/`running`/
    `awaitingApproval`/`denied`/`errored` (**the only sanctioned builder**;
    handlers conform by construction).
  - `src/envelope-schema.ts` — `ENVELOPE_SCHEMA` + `validateEnvelope`. **Note the
    `ok` branch constrains `result: { type: 'object' }`** (the array conflict).
  - `src/errors.ts` — the closed nine-code `ERROR_CODES`, the denial/fault
    partition, and `mapTransportError` / `mapDaemonError` (the single source of
    truth for fault → code; e.g. `unknown_agent` → `not_found`).
  - `src/handlers/deps.ts` — `DaemonCall` (`Pick<MxTransport, 'call'>`) and
    `HandlerDeps` (the injected daemon + clock seams). **T104 reuses this
    verbatim; the clock seams are unused by these sync reads.**
  - `src/handlers/invocation.ts` — T103's pure normalizer (the *pattern* T104
    mirrors: small total readers, no throw, build only via the helpers,
    `internal` fallback). Its `failureResult(code, audit_ref)` selecting
    `denied` vs `errored` by set membership is reusable.
  - `src/handlers/await-result.ts` — T103's `mxAwaitResult`; its `probe` /
    `faultToResult` show exactly how to wrap a `deps.daemon.call(...)` in
    try/catch and map a rejection onto a fault envelope. **T104 copies this
    fault-handling shape.**
  - `src/handlers/index.ts`, `src/index.ts` — the barrels T104 extends.
  - `src/security.ts` — the no-authority allowlist (`MODEL_FACING_ALLOWLIST`
    already lists both verbs) + the credential-shaped-key oracle.
- **`@mx-loom/toolbelt` typed agent views** — `packages/toolbelt/src/agent-state.ts`
  declares `AgentState`, `AgentLiveness` (`'active' | 'stale' | 'offline'`), and
  `AgentListEntry` (`{ agent: AgentState, liveness }`). These are TypeScript types
  over **already-existing** daemon payloads (not a protocol change). T104 can
  import them `type`-only for shaping the `agent.list` response, keeping the
  registry's zero-runtime-toolbelt-dep streak.

### Verified daemon surface (from `docs/mx-agent-surface-v0.2.1.md`, T001)

| RPC | Status on v0.2.1 | Observed result shape |
|---|---|---|
| `agent.list` | ✅ live-verified | `[{ agent: AgentState, liveness: "active"\|"stale"\|"offline" }]` |
| `agent.tools` | ✅ live-verified | `{ agent_id, kind, status, capabilities[], tools[], schemas: [ToolSchema] }` |
| `agent.show` | ⚠️ **not in the verified table** | design §2 maps `mx_describe_agent` → `agent.show` + `agent.tools`, but the live spike did not confirm `agent.show` exists on v0.2.1 |

- **`AgentState`** (confirmed field-for-field): `{ agent_id, kind,
  matrix_user_id, device_id, signing_key_id, signing_public_key, status,
  capabilities[], tools[], workspace{cwd,project_id,git_commit},
  load{running_invocations,max_invocations}, last_seen_ts, state_rev }`. The
  `signing_public_key` is the **public** Ed25519 key (non-secret); the private
  key never leaves the daemon.
- **`ToolSchema`** (`com.mxagent.tool.v1`, confirmed): `{ name, version,
  description, input_schema (JSON Schema), output_schema (JSON Schema) }`.
  `agent.tools` returns these under the **`schemas`** field (alongside a separate
  `tools[]`). `input_schema` pass-through (for T105) is confirmed available.
- The surface doc explicitly records: "`agent.register` / `agent.list` /
  `agent.tools` are ready to back `mx_find_agents` / `mx_describe_agent` (T104)".

### Conventions established by T101–T103 (T104 must match)

- **Constructor-helpers-only** envelope construction; handlers never hand-build a
  `ToolResult` literal.
- **Pure, total normalizers**: no throw, no I/O, `internal` fallback for any
  unrecognised daemon shape; small defensive readers (`asRecord`/`readString`).
- **Injected daemon seam**: a handler depends only on `HandlerDeps`, never on a
  concrete client, a socket, or an env var.
- **`type`-only toolbelt imports** under `verbatimModuleSyntax`, so the registry
  keeps `@mx-loom/toolbelt` a devDependency (zero runtime dep).
- **Secret-free, fixed-vocabulary messages**; never echo a raw daemon payload
  into a model-facing string.
- **Localise wire assumptions** (method/param-name consts at the top of the
  handler) so the two-daemon round-trip's correction is a one-line change —
  exactly as `await-result.ts` does with `INVOCATION_GET_METHOD`.

---

## Proposed Implementation

Add two `sync` handlers to `@mx-loom/registry`, plus one small shared projection
module. All three are pure-except-for-the-injected-`deps.daemon.call`, never
throw to the caller, and build results only through the T102 helpers.

### File layout

```
packages/registry/src/handlers/
  agent-projection.ts   # NEW — pure: AgentState → non-secret AgentSummary / AgentDetail; ToolSchema projection
  find-agents.ts        # NEW — mxFindAgents(input, deps): agent.list → filter → project → ok({agents})
  describe-agent.ts     # NEW — mxDescribeAgent(input, deps): agent.tools (+agent.list) → project → ok({agent,tools})
  index.ts              # extend barrel
src/index.ts            # extend root barrel
src/descriptors/find-agents.ts   # EDIT — wrap output_schema array in { agents: [...] } object (see Data Model)
```

### Shared wire-assumption constants (top of each handler)

```ts
const AGENT_LIST_METHOD = 'agent.list';
const AGENT_TOOLS_METHOD = 'agent.tools';
const AGENT_ID_PARAM = 'agent_id';
// Optional, behind a feature check — not in the verified v0.2.1 table:
// const AGENT_SHOW_METHOD = 'agent.show';
```

Localised so the two-daemon round-trip (or a future pin bump) corrects them in
one line, per the `await-result.ts` precedent.

### `agent-projection.ts` (pure, no I/O, never throws)

The redaction/shaping heart. Mirrors `invocation.ts`'s defensive-reader style.

- `interface AgentSummary { agent_id: string; kind?: string; capabilities: string[]; liveness: AgentLiveness }`
  — the `mx_find_agents` row shape (matches the descriptor's `items`).
- `interface AgentDetail` — the `mx_describe_agent` `agent` sub-object:
  `{ agent_id, kind?, status?, capabilities, liveness?, workspace?, load?, last_seen_ts? }`.
- `interface PublishedTool { name: string; version?; description?; input_schema?; output_schema? }`
  — the projection of one `ToolSchema`.
- `projectAgentSummary(agent: unknown, liveness: unknown): AgentSummary` and
  `projectAgentDetail(...)`: read only the **allowlisted** fields. **Never copy**
  `matrix_user_id`, `device_id`, `signing_key_id`, `signing_public_key`,
  `state_rev` into the output (defense in depth — keep the model context clean and
  free of any identifier the inbound redactor or a reviewer might flag).
- `projectTools(schemas: unknown): PublishedTool[]`: map the daemon's `schemas`
  array (the real `ToolSchema[]`) onto `PublishedTool[]`, passing the inner
  `input_schema`/`output_schema` through verbatim (the model needs them for T105).
- Helpers reused/copied from `invocation.ts`: `asRecord`, `readString`,
  `readStringArray`, `readLiveness` (validates against the enum; unknown →
  `'offline'` as the safe/fail-closed default, never fabricated as `active`).

This module is **allowlist-by-construction**: it only ever reads named fields, so
adding a field to `AgentState` upstream can never silently leak it.

### `find-agents.ts` — `mxFindAgents(input, deps)`

```ts
export interface FindAgentsInput {
  readonly capability?: string;
  readonly tool?: string;
  readonly liveness?: AgentLiveness;
}
export async function mxFindAgents(input: FindAgentsInput, deps: HandlerDeps): Promise<ToolResult>
```

Algorithm:

1. `try { rows = await deps.daemon.call(AGENT_LIST_METHOD); } catch (err) { return faultToResult(err); }`
   — a single `agent.list` (no params). Reuse the `await-result.ts`
   `faultToResult` shape (extract a transport/daemon code, route `rpc` through
   `mapDaemonError`, everything else through `mapTransportError`, build a
   fault envelope). Factor that shared fault path into a tiny `handler-fault.ts`
   helper (or duplicate the ~15 lines — reviewer's call; prefer factoring).
2. Normalise `rows` to an array of `{ agent, liveness }` via `asRecord`/array
   reads; a non-array / malformed response → `ok({ agents: [] })` (empty, not an
   error — "no agents matched" is a valid empty result) **only if** the call
   itself succeeded; a genuinely unparseable success degrades to
   `errored('internal', …)`.
3. Apply the filters with **AND** semantics, all client-side:
   - `liveness`: keep rows where `row.liveness === input.liveness`.
   - `capability`: keep rows where `agent.capabilities` includes `input.capability`.
   - `tool`: keep rows where the agent publishes a tool of that name. **See OQ #3
     for the N+1 concern** — prefer reading tool names from the list row's
     `agent.tools` field when it carries identifiers; otherwise resolve
     `agent.tools` only for the candidates that already passed
     capability+liveness (bounded fan-out), and `log`-free skip on a per-agent
     `agent.tools` fault (treat as "no match", do not fail the whole query).
   - Absent filter ⇒ that predicate is a tautology (matches all).
4. `project` each surviving row → `AgentSummary`.
5. `return ok({ agents }, EMPTY_AUDIT_REF)` — discovery is a **local** daemon read
   with no Matrix round-trip, so there is no invocation/request/room/event id;
   `audit_ref` is structurally present with **all-null** ids (never fabricated;
   consistent with T102/T103).

### `describe-agent.ts` — `mxDescribeAgent(input, deps)`

```ts
export interface DescribeAgentInput { readonly agent_id: string }
export async function mxDescribeAgent(input: DescribeAgentInput, deps: HandlerDeps): Promise<ToolResult>
```

Algorithm (verified-surface-first):

1. Resolve the published tools + base metadata in one verified call:
   `toolsResp = await deps.daemon.call(AGENT_TOOLS_METHOD, { [AGENT_ID_PARAM]: input.agent_id })`
   → `{ agent_id, kind, status, capabilities[], tools[], schemas: [ToolSchema] }`.
   Wrap in try/catch → `faultToResult` (an unknown agent surfaces as the daemon's
   `unknown_agent`/`not_found` → mapped to `not_found`).
2. Resolve the liveness/workspace/load metadata the schemas RPC omits:
   - **Default (verified surface):** `agent.list` once, find the row whose
     `agent.agent_id === input.agent_id`, take its `AgentState` + `liveness`.
   - **Optional:** if a future pin verifies `agent.show {agent_id}` exists and
     returns `AgentState`, prefer it (one targeted call). Gate behind the wire
     const; do **not** depend on it for v0.2.1 (OQ #2).
   - If neither yields the agent → `errored('not_found', …)` (or `denied`/`error`
     per the mapped code) — but if `agent.tools` already returned a record for the
     agent, the merge can proceed with `liveness` unknown (fail-safe `'offline'`).
3. `agent = projectAgentDetail(merged state, liveness)`;
   `tools = projectTools(toolsResp.schemas)`.
4. `return ok({ agent, tools }, EMPTY_AUDIT_REF)`.

`mx_describe_agent` output is already `type: 'object'` (`{ agent, tools }`) — it
needs **no** envelope reconciliation, unlike `mx_find_agents`.

### Envelope reconciliation for `mx_find_agents` (required)

The descriptor's `output_schema` is currently `type: 'array'`. The T102 envelope
`ok` branch requires `result: { type: 'object' }`, so a bare-array payload fails
`validateEnvelope`. **Wrap the array in an object** and update the descriptor:

`output_schema` becomes `{ type: 'object', properties: { agents: { type: 'array',
items: <the existing item schema> } }, required: ['agents'], additionalProperties: false }`.

This is the minimal, contract-preserving fix (every tool's success payload is an
object, matching design §4.2). The alternative — relaxing the envelope `ok`
branch to also allow arrays — *weakens* the T102 contract and is rejected.

### Barrels + exports

- `handlers/index.ts`: export `mxFindAgents`, `mxDescribeAgent`, and the input/
  projection types (`FindAgentsInput`, `DescribeAgentInput`, `AgentSummary`,
  `AgentDetail`, `PublishedTool`).
- `src/index.ts`: re-export them under the "deferred-result protocol / handlers"
  section, extending the comment to "T103 (deferred) + T104 (discovery) handlers".

---

## Affected Files / Packages / Modules

**Read:**
- `packages/registry/src/descriptors/find-agents.ts`, `.../describe-agent.ts` (the contract being implemented).
- `packages/registry/src/handlers/await-result.ts`, `.../invocation.ts`, `.../deps.ts` (the patterns to mirror).
- `packages/registry/src/envelope.ts`, `.../envelope-schema.ts`, `.../errors.ts` (helpers, schema, mappers).
- `packages/toolbelt/src/agent-state.ts` (`AgentState`/`AgentLiveness`/`AgentListEntry` types).
- `docs/mx-agent-surface-v0.2.1.md` (verified RPC shapes), `docs/mx-agent-tool-fabric-design.md` (§2/§4).

**Create:**
- `packages/registry/src/handlers/agent-projection.ts`
- `packages/registry/src/handlers/find-agents.ts`
- `packages/registry/src/handlers/describe-agent.ts`
- (optional) `packages/registry/src/handlers/handler-fault.ts` (the shared `faultToResult` extracted from `await-result.ts`).
- Tests: `packages/registry/test/handlers/find-agents.test.ts`,
  `.../describe-agent.test.ts`, `.../agent-projection.test.ts`,
  `.../discovery.security.test.ts` (secret-projection assertions).

**Modify:**
- `packages/registry/src/descriptors/find-agents.ts` (output_schema array → object wrap).
- `packages/registry/src/handlers/index.ts`, `packages/registry/src/index.ts` (barrels).
- `packages/registry/src/handlers/await-result.ts` (only if extracting the shared fault helper).
- `packages/registry/README.md` (handler surface), `docs/backlog.md` (T104 status), and a note in `docs/mx-agent-surface-v0.2.1.md` re `agent.show`.

---

## API / Interface Changes

- **New public functions (package root + handler barrel):**
  - `mxFindAgents(input: FindAgentsInput, deps: HandlerDeps): Promise<ToolResult>`
  - `mxDescribeAgent(input: DescribeAgentInput, deps: HandlerDeps): Promise<ToolResult>`
  - New exported types: `FindAgentsInput`, `DescribeAgentInput`, `AgentSummary`,
    `AgentDetail`, `PublishedTool` (and reuse `AgentLiveness` — re-export the type
    or define a local copy to avoid a runtime toolbelt dep; prefer a `type`-only
    re-export).
- **Tool-descriptor change:** `mx_find_agents.output_schema` changes from a
  top-level array to `{ agents: <array> }` (see Data Model). The `input_schema`,
  `name`, `description`, and `async_semantics` are unchanged.
  `mx_describe_agent` descriptor is unchanged (optionally tighten doc comment re
  `agent.show`).
- **Daemon-RPC surface consumed (no new methods authored):** `agent.list` (no
  params), `agent.tools` (`{ agent_id }`); optional `agent.show` (`{ agent_id }`)
  gated behind a verified-surface check, off by default for v0.2.1.
- **Result-envelope surface:** unchanged — both handlers return the existing
  `ToolResult` via `ok`/`errored`/`denied`. No new status, no new field.
- **CLI / daemon-RPC transport:** no change (`agent.list`/`agent.tools`/
  `agent.show` already map through the toolbelt's default `methodToArgv` rule and
  the IPC client).

## Data Model / Protocol Changes

- **`mx_find_agents` success-payload shape:** `{ agents: AgentSummary[] }`
  (was a bare `AgentSummary[]`), to satisfy the envelope `ok` branch
  (`result: { type: 'object' }`). This is the only descriptor schema change.
- **Projection shapes (new, model-facing):** `AgentSummary`
  (`{ agent_id, kind?, capabilities, liveness }`) and `AgentDetail`
  (`{ agent_id, kind?, status?, capabilities, liveness?, workspace?, load?,
  last_seen_ts? }`) — both a strict **non-secret subset** of the daemon
  `AgentState`. `PublishedTool` mirrors `ToolSchema` (`{ name, version?,
  description?, input_schema?, output_schema? }`).
- **`audit_ref` for local reads:** structurally present, **all ids `null`** —
  discovery is a local daemon read, not a signed Matrix round-trip, so there is no
  `invocation_id`/`request_id`/`room`/`event_id` to populate. Never fabricated
  (consistent with T102/T103). Define a shared `EMPTY_AUDIT_REF` const.
- **No change** to the error taxonomy, the envelope schema (the array→object wrap
  is in the *descriptor*, not the envelope), idempotency (reads carry no
  `idempotency_key`), audit-row format (T113), or serialization.

## Security & Compliance Considerations

- **Secret boundary (Boundary A).** Discovery only *reads* agent metadata, and the
  daemon's `AgentState` contains no Matrix tokens, Ed25519 signing **private**
  keys, provider keys, or `GH_TOKEN` — those stay daemon-held and never enter the
  RPC result. T104 nonetheless **projects** the output to a non-secret subset and
  deliberately **drops the public-but-noisy identifiers** (`matrix_user_id`,
  `device_id`, `signing_key_id`, `signing_public_key`, `state_rev`) so they never
  reach the model context. The descriptor authors flagged this intent
  ("intentionally omitted … so the canonical schema stays free of any
  credential-substring field name"); the handler enforces it. Projection is
  **allowlist-by-construction** — only named fields are copied, so a new upstream
  `AgentState` field cannot silently leak.
- **No secret crosses Boundary A.** The deny-by-default env allowlist and inbound
  `redactSecrets` already run on every `MxClient.call` (T008) on the *receiving*
  side of the seam; T104 adds projection as defense-in-depth on top.
- **Secret-free contract.** The inputs (`capability`, `tool`, `liveness`,
  `agent_id`) carry no credentials, and the `input_schema`s declare no
  credential-shaped property (the T101 loader already enforces this). The
  toolbelt's `assertNoCredentialShapedArgs` still runs at dispatch, so a
  credential-shaped arg injected by a misbehaving model is rejected as
  `invalid_args` before it reaches the daemon.
- **Out-of-process enforcement / no self-granted authority.** Discovery produces
  no signed request and no authority. Trust/policy/approval all remain on the
  receiving daemon; `mx_find_agents` surfaces *liveness*, never a trust decision,
  and the model is given **no** trust/policy/approval-mutation tool (the
  no-authority allowlist in `security.ts` already covers this — both verbs are in
  `MODEL_FACING_ALLOWLIST`, and neither is an authority verb).
- **Audit correlation.** Every result still carries `audit_ref` (all-null for
  these local reads). When the daemon later exposes correlation ids for read RPCs,
  populate them; until then they are honestly `null`, never fabricated.
- **Logging / redaction.** No handler logs its inputs or the raw daemon payload;
  `error.message` is a fixed, secret-free phrase per code (reuse `invocation.ts`'s
  `MESSAGE_FOR_CODE`). Ajv `validateEnvelope` errors report path-only, never
  values.

## Testing Plan

All unit tests use a one-line fake `deps.daemon.call` (the T103 precedent) — no
daemon, no socket. Vitest under `packages/registry/test/handlers/`.

- **`mx_find_agents` filters (AC 1):**
  - Capability filter returns exactly the agents advertising it; non-matching
    excluded; absent capability returns all.
  - Liveness filter (`active`/`stale`/`offline`) narrows correctly.
  - Tool filter returns only agents publishing the named tool.
  - Filters combine with **AND** (capability + liveness + tool together).
  - Empty match → `ok({ agents: [] })` (valid empty success, not an error).
  - Malformed/empty `agent.list` payload on a *successful* call → empty agents.
- **`mx_describe_agent` (AC 2):**
  - Returns `{ agent, tools }` where `tools` are the target's published
    `ToolSchema[]` (assert `input_schema`/`output_schema` pass through verbatim).
  - Unknown `agent_id` → `errored('not_found', …)` (or denial per mapped code).
  - Liveness/workspace/load merged from `agent.list` (or `agent.show` if enabled);
    missing liveness → fail-safe `'offline'`.
- **Projection / secret-boundary (`discovery.security.test.ts`):**
  - `matrix_user_id`, `device_id`, `signing_key_id`, `signing_public_key`,
    `state_rev` are **absent** from every projected output (find + describe).
  - A daemon payload with an extra unexpected field does not leak it (allowlist).
- **Envelope conformance:** `validateEnvelope(result)` is `true` for the success,
  empty, `not_found`, and transport-fault outputs of **both** handlers (this is
  the regression that catches the array→object reconciliation).
- **Fault mapping (mirror `await-result` tests):** a transport rejection →
  `internal`/`timeout` fault envelope (never a throw); a daemon `unknown_agent` /
  `not_found` → `not_found`; a `policy`-style code → `denied`/`policy_denied`.
- **Descriptor regression:** `loadRegistry()` still validates after the
  `mx_find_agents` `output_schema` change; the registry smoke + descriptor tests
  stay green.
- **Conformance (optional, single-daemon):** a Tier-1 live `agent.list` +
  `agent.tools` round-trip behind the existing `MXL_CONFORMANCE` gate, asserting a
  registered agent is discoverable and its schemas come back — no two-daemon
  fixture needed (discovery is local-read-only).
- **Documentation:** none beyond the doc updates below being present.

## Documentation Updates

- **`docs/backlog.md`** — mark T104 acceptance criteria checked and add a
  `**Status:**` line (mirroring T101–T103): handler home = `@mx-loom/registry`;
  the output_schema array→object reconciliation; `agent.show` defaulted off
  pending verification; resolved decisions + the two pending wire questions.
- **`packages/registry/README.md`** — add the discovery handlers to the exported
  surface and note they are `sync` local reads with all-null `audit_ref`.
- **`docs/mx-agent-surface-v0.2.1.md`** — add a note under "Surface present" that
  `agent.show` was **not** confirmed on v0.2.1, so `mx_describe_agent` is backed
  by `agent.list` + `agent.tools`; flip if a future pin verifies `agent.show`.
- **`docs/mx-agent-tool-fabric-design.md`** — optional: the §2 table maps
  `mx_describe_agent` → "`agent.show` + `agent.tools`"; add a parenthetical that
  the v0.2.1 implementation uses `agent.list` + `agent.tools` (verified surface),
  so the doc does not imply an unverified RPC is in use.
- Descriptor doc comments: update `find-agents.ts` (output is now
  `{ agents: [...] }`) and `describe-agent.ts` (backed by `agent.list` +
  `agent.tools`; `agent.show` optional).

## Risks and Open Questions

1. **`mx_find_agents` output_schema vs envelope `ok` branch (resolve in T104).**
   The descriptor declares `type: 'array'`; the envelope requires
   `result: { type: 'object' }`. **Recommendation:** wrap in `{ agents: [...] }`
   and update the descriptor. *Decision to confirm: object-wrap (recommended) vs
   relaxing the envelope schema (rejected — weakens the contract).*
2. **`agent.show` existence on v0.2.1 (Open).** Not in the verified surface table.
   **Recommendation:** back `mx_describe_agent` on `agent.list` + `agent.tools`
   (both verified); gate an `agent.show` fast-path behind the wire const, off by
   default. *Pin at the next live check.*
3. **Tool-name filter without an N+1 (Open).** `agent.list` rows carry
   `AgentState.tools: unknown[]`, but it is unverified whether that array carries
   tool *names* usable for the `tool` filter, or whether names only come from
   `agent.tools.schemas`. **Recommendation:** filter from the list row when it
   carries names; otherwise resolve `agent.tools` only for candidates that already
   passed capability+liveness (bounded fan-out), tolerating a per-agent
   `agent.tools` fault as "no match". *Confirm the `agent.list` row tool shape at
   the live check; if it is rich, drop the N+1 path entirely.*
4. **Client-side vs server-side filtering (Decided: client-side).** No verified
   server-side filter param exists on `agent.list`; filtering in the handler keeps
   T104 to the verified surface. If a daemon-side filter lands later, it is a
   transparent optimization behind the same tool contract.
5. **Projection vs full-`AgentState` pass-through (Decided: project).** The
   descriptors set `additionalProperties: true`, *permitting* a full pass-through,
   but T104 projects to a non-secret subset to keep the model context clean and
   drop noisy identifiers. *Confirm the projected field set with reviewers.*
6. **`liveness` default for a missing value (Decided: fail-closed `offline`).**
   An absent/unknown liveness projects as `'offline'` (never optimistically
   `active`). Symmetric with `invocation.ts`'s fail-safe `high` risk.
7. **Shared `faultToResult` extraction.** Whether to factor the
   `await-result.ts` transport/daemon fault path into a shared
   `handler-fault.ts` or duplicate ~15 lines. **Recommendation:** extract — three
   handlers (T103, two in T104) now need identical fault mapping. Low-risk
   refactor; covered by existing + new tests.
8. **`audit_ref` ids null for local reads.** Honest for v0.2.1 (no Matrix
   round-trip on a discovery read). If T113's audit mirror or a future daemon
   surfaces read-correlation ids, populate them then.

## Implementation Checklist

1. Re-read the two descriptors, `await-result.ts`, `invocation.ts`, `deps.ts`,
   `envelope.ts`, `envelope-schema.ts`, `errors.ts`, and the verified surface doc.
2. **Reconcile the descriptor:** edit `src/descriptors/find-agents.ts` so
   `output_schema` is `{ type: 'object', properties: { agents: { type: 'array',
   items: <existing item schema> } }, required: ['agents'], additionalProperties:
   false }`; update its doc comment.
3. Add `src/handlers/agent-projection.ts`: defensive readers + `projectAgentSummary`,
   `projectAgentDetail`, `projectTools`, the `AgentSummary`/`AgentDetail`/
   `PublishedTool` types, and `readLiveness` (fail-closed `offline`).
4. (Optional, recommended) Extract `src/handlers/handler-fault.ts` `faultToResult`
   from `await-result.ts`; refactor `await-result.ts` to use it (keep its tests green).
5. Add `src/handlers/find-agents.ts`: `mxFindAgents` — single `agent.list` call,
   AND-combined client-side filters, projection, `ok({ agents }, EMPTY_AUDIT_REF)`;
   wrap the call in try/catch → fault envelope; define `EMPTY_AUDIT_REF` (shared).
6. Add `src/handlers/describe-agent.ts`: `mxDescribeAgent` — `agent.tools` +
   `agent.list` merge (optional `agent.show` gated off), projection,
   `ok({ agent, tools }, EMPTY_AUDIT_REF)`; unknown agent → `not_found`.
7. Extend `src/handlers/index.ts` and `src/index.ts` barrels with the new
   functions/types.
8. Tests: `find-agents.test.ts` (filters incl. AC 1, AND, empty), `describe-agent.test.ts`
   (AC 2 schema pass-through, not_found), `agent-projection.test.ts`,
   `discovery.security.test.ts` (secret-field absence), plus `validateEnvelope`
   conformance and fault-mapping cases for both handlers.
9. Run `pnpm --filter @mx-loom/registry test` and `typecheck`; confirm the
   registry smoke/descriptor/loader suites still pass after the descriptor edit.
10. Update `docs/backlog.md` (T104 ACs + Status), `packages/registry/README.md`,
    `docs/mx-agent-surface-v0.2.1.md` (`agent.show` note), and optionally the
    design-doc §2 parenthetical.
11. (Optional) Add a single-daemon `agent.list`/`agent.tools` conformance check
    behind `MXL_CONFORMANCE`.
