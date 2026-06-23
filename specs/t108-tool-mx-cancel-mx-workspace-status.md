# T108 · `mx_cancel` + `mx_workspace_status` — invocation cancellation + workspace observation

> Issue #16 · `area/registry` · `type/feature` · `P1` · **S** · Milestone **M1 — Delegation MVP**
> Source: `docs/backlog.md` (`T108`). Blocked-by #10 (T102 — the result envelope + error taxonomy + idempotency), which has **landed**.

## Problem Statement

The M1 model-facing tool surface (design §2) names twelve verbs across *discover → delegate → coordinate → share → observe*. Seven P0 verbs are code-complete at the handler layer (T101–T107): discovery (`mx_find_agents`, `mx_describe_agent`), both delegation surfaces (`mx_delegate_tool`, `mx_run_command`), the deferred-result resolver (`mx_await_result`), and the context-share seam (`mx_share_context`, `mx_get_context`). Two **P1** verbs remain unimplemented, and both gaps are user-visible:

1. **No way to cancel an in-flight invocation.** Once a model delegates a long-running tool or guarded command and receives a deferred `handle`, there is no verb to stop it. A model that changes its mind — or recognises a delegation is wrong/runaway — can only wait for it to finish or time out. The design's model-facing table lists `mx_cancel` → `invocation.cancel`, but no descriptor or handler exists. There is also a concrete, already-flagged debt: `packages/registry/src/handlers/invocation.ts` deliberately omits the `cancelled` state from its invocation-state table with the note *"a cancelled invocation is T108 (`mx_cancel`) territory; here it degrades to the safe `internal` fallback until T108 pins its disposition."* So a `cancelled` invocation observed via `mx_await_result` today resolves to a misleading `internal` error.

2. **No way to observe the workspace.** A model joining a workspace cannot enumerate the registered agents, the project it is working in, or whether the room is encrypted — it can `mx_find_agents` (a flat agent list) but has no single "where am I / who is here / what project is this" verb. The design lists `mx_workspace_status` → `workspace.status` as that verb; no descriptor or handler exists.

This issue closes both gaps: it authors the two P1 descriptors, implements their handlers against the same injected daemon-call seam and T102 envelope contract every other handler uses, and resolves the `invocation.ts` cancelled-state TODO.

## Goals

- **`mx_cancel`** — a `sync` mutating verb mapping to the daemon RPC `invocation.cancel`, taking a deferred `handle` (an `inv_…` invocation id) and returning a normalized T102 envelope confirming the cancellation. Cancelling a running handle transitions it to `cancelled` and the handler reports that outcome (**AC 1**).
- **`mx_workspace_status`** — a `sync` read verb composing `workspace.status` (room/project metadata) with `agent.list` (the registered MX agents, projected to the non-secret `AgentSummary` shape T104 already defines) and returning the registered agents + project context (**AC 2**).
- Resolve the deliberate `invocation.ts` TODO so a `cancelled` invocation observed via `mx_await_result` resolves to a clean terminal envelope rather than `internal`.
- Add both descriptors to the canonical registry so the generated MCP server (T109) and the Claude shim (T110) surface them automatically — **no per-tool binding code** (the design build rule).
- Preserve every invariant the prior handlers established: zero **runtime** dependency on `@mx-loom/toolbelt` (the daemon-call seam imported `type`-only); envelopes built **only** through the T102 constructor helpers (conform by construction); **never throw** (every transport/daemon fault maps onto the closed taxonomy via the shared `faultToResult`); secret-free I/O with non-secret projection; authority stays out-of-process (the handler emits a signed request and surfaces — never enforces — the receiver's verdict).

## Non-Goals

- **Task DAG tools (M3).** `mx_create_task` / `mx_update_task` / `mx_list_tasks` and the `task.create/update/list/graph` RPCs are explicitly out of scope (issue "Out of scope: Task DAG tools (M3)"; T301). `mx_workspace_status` therefore surfaces **agents + project**, and leaves a forward-compatible slot for a future `tasks` field but does **not** populate it. The design §2 gloss "who/what is in the workspace (agents, tasks, project)" includes tasks; in M1 the tasks dimension is deferred.
- **`task.watch` / durable resumption (M3 / T302).** Not touched.
- **Cancellation of tasks or plans.** `mx_cancel` cancels a single *invocation* handle, not a task or a multi-step plan.
- **Bindings (T109/T110) and the golden test (T114).** This issue authors descriptors + handlers only. The generators read the canonical registry; this spec ensures the two new descriptors are in it, but does not implement or modify the MCP/Claude generators.
- **Operator/authority surfaces.** No trust/policy/approval mutation. Cancellation is a request the receiving daemon authorizes out-of-process; it is not an authority grant.
- **A new Postgres audit row (T113).** `audit_ref` is surfaced on results as already specified; the mirror is T113.

## Relevant Repository Context

**Stack.** TypeScript, pnpm workspaces, Node ≥20.19, vitest, Apache-2.0. The repo is **no longer docs-only** (the boilerplate caveat in the task template is stale for this issue): `packages/registry` (`@mx-loom/registry`) and `packages/toolbelt` (`@mx-loom/toolbelt`) are real, populated packages. T101–T107 have landed with source + tests. T108 extends `@mx-loom/registry` exactly as T104–T107 did.

**Owning package.** `@mx-loom/registry` (`area/registry`). Two new descriptors under `src/descriptors/`, two new handlers under `src/handlers/`, plus a one-line resolution in `src/handlers/invocation.ts`.

**The patterns T108 must follow (already established, read before coding):**

- **Descriptors** (`src/descriptors/*.ts`) — authored via `defineDescriptor(...)` (deep-frozen), each schema tagged with `JSON_SCHEMA_DIALECT` (draft-07). Names must match `TOOL_NAME_RE` (`^mx_[a-z0-9]+(?:_[a-z0-9]+)*$`). `async_semantics: 'sync' | 'deferred'`. See `src/descriptors/await-result.ts` (a `sync` read), `src/descriptors/run-command.ts` (a `deferred` mutating verb), `src/descriptors/get-context.ts` (a `sync` read with an open `additionalProperties: true` output).
- **The canonical set** (`src/descriptors/index.ts`) — `CANONICAL_M1_TOOLS` is the frozen array `loadRegistry()` validates. It currently holds the **7 P0** verbs. The loader (`src/registry.ts`) runs five checks per descriptor: structural, JSON-Schema validity (Ajv), uniqueness, **no-authority allowlist**, and **secret-free input shape** (no credential-shaped property name).
- **The injected daemon-call seam** (`src/handlers/deps.ts`) — `HandlerDeps { daemon: DaemonCall; sleep?; now?; pollIntervalMs? }` where `DaemonCall = Pick<MxTransport, 'call'>` (imported `type`-only). `RoomScopedDeps extends HandlerDeps { room? }` for verbs that need the session workspace room (injected from `MxSession`, **never** model input). A handler opens no socket, reads no env var, imports no concrete client.
- **The envelope + helpers** (`src/envelope.ts`) — `ok` / `running` / `awaitingApproval` / `denied` / `errored` are the **only** sanctioned builders, so a handler conforms to `ENVELOPE_SCHEMA` by construction. The closed taxonomy + status partition lives in `src/errors.ts` (`ERROR_CODES`, `DENIAL_CODES`, `FAULT_CODES`, `mapTransportError`, `mapDaemonError`).
- **The shared fault path** (`src/handlers/handler-fault.ts`) — `faultToResult(err, audit_ref)` maps any `deps.daemon.call(...)` rejection onto the closed taxonomy (`rpc` → `mapDaemonError`; else `mapTransportError`; foreign → `internal`). `EMPTY_AUDIT_REF` is the all-null `audit_ref` for a local read with no Matrix round-trip.
- **The invocation normalizers** (`src/handlers/invocation.ts`) — `invocationToResult` (an `invocation.get` read) and `callResponseToResult` (a `call.start`/`exec.start` reply) classify a daemon response onto the envelope via a shared state-token table (`INVOCATION_STATE_KIND`), `failureCode`, `approvalOf`, and the exported readers `extractAuditRef` / `hasErrorSignal` / `failureCode` / `isTerminal`. **This module explicitly defers `cancelled` to T108.**
- **The non-secret projectors** (`src/handlers/agent-projection.ts`) — `projectAgentSummary(agent, liveness) → AgentSummary` (allowlist-by-construction; drops `matrix_user_id`, `device_id`, `signing_key_id`, `signing_public_key`, `state_rev`), `readListRow`, `readLiveness`, `readString`, `asRecord`, plus `AgentSummary` / `AgentDetail` types. **`mx_workspace_status` reuses `projectAgentSummary` verbatim** for its agent list.
- **Security invariants** (`src/security.ts`) — `MODEL_FACING_ALLOWLIST` **already lists** `mx_cancel` and `mx_workspace_status` (commented "P1 (T108) — known, but authored alongside their handlers"). Neither is a forbidden authority verb. `findCredentialShapedProperty` enforces secret-free input shapes at load.

**The verified daemon surface (`docs/mx-agent-surface-v0.2.1.md`, T001):**

- `workspace.status` is **verified live** → `{ room_id, canonical_alias, name, encrypted, joined_members, members[{ user_id, display_name, membership }] }`. This is the *Matrix room* view — it carries `members` (Matrix user IDs), **not** MX `AgentState` records, and has **no** `agents` / `tasks` / `project` fields. So "list registered agents" requires composing `agent.list` (verified) with `workspace.status` — directly mirroring how T104 backed `mx_describe_agent` on `agent.list` + `agent.tools` because the design-mapped `agent.show` was unverified.
- `invocation.*` (including `invocation.cancel`) is **"◻️ documented"** — present in design §2 but not exercised by the T001 spike (it needs an in-flight invocation, i.e. ≥2 agents/daemons). So `mx_cancel`'s wire shape (method name, param name, reply disposition) is authored against the design now and pinned at the two-daemon round-trip (`MXL_CONFORMANCE_TWO_DAEMON=1`), exactly like `call.start` / `exec.start` / `share.*` were.

## Proposed Implementation

Two handlers + two descriptors + one TODO resolution, all in `@mx-loom/registry`, reusing the existing seams.

### A. `mx_cancel` — cancel an in-flight invocation

**Descriptor** (`src/descriptors/cancel.ts` → `MX_CANCEL`):

- `async_semantics: 'sync'` — a cancellation request is acknowledged immediately; the verb returns a terminal envelope. It does not return `running`/`awaiting_approval` (cancellation is not approval-gated in M1) and does not compose `mx_await_result`.
- `input_schema`: `{ handle: string (required) }`, `additionalProperties: false`. `handle` is the `inv_…` id a prior `mx_delegate_tool` / `mx_run_command` / `mx_await_result` returned. **No `idempotency_key`** (see decision below).
- `output_schema`: `{ handle: string, cancelled: boolean, state?: string }`, `required: ['handle', 'cancelled']`, `additionalProperties: true` (tolerate daemon extras). `cancelled: true` means the invocation was running and is now cancelling/cancelled; `cancelled: false` with a `state` (e.g. `already_complete`) means there was nothing to cancel — still a successful, non-error outcome.

**Handler** (`src/handlers/cancel.ts` → `mxCancel(input, deps)`):

- Uses plain `HandlerDeps` (daemon-only), **mirroring `mx_await_result`** — which also operates on a handle via the `invocation.*` family and needs no room. The signed cancel event's room is derived daemon-side from the invocation record. (Decision flagged below in case the round-trip shows `invocation.cancel` needs an explicit `room`.)
- Localise the wire in module consts (the `await-result.ts` precedent): `const INVOCATION_CANCEL_METHOD = 'invocation.cancel'; const INVOCATION_ID_PARAM = 'invocation_id';`.
- Algorithm:
  1. Dispatch `deps.daemon.call(INVOCATION_CANCEL_METHOD, { [INVOCATION_ID_PARAM]: input.handle })`.
  2. On reject → `faultToResult(err, EMPTY_AUDIT_REF)`. An unknown handle maps to `not_found`; a cross-agent cancel the receiver refuses maps to `policy_denied` / `untrusted_key`; a transport fault maps per `mapTransportError`.
  3. On success → normalize to `ok({ handle, cancelled, state? }, extractAuditRef(response))`. Cancellation **emits a signed Matrix event** (it is a mutation, unlike the local discovery reads), so `audit_ref` is populated from the response (null inner ids when the daemon omits them — never fabricated). Use the exported `extractAuditRef` reader from `invocation.ts`; on a daemon error signal in a resolved (non-thrown) reply, route through `failureCode` → `failureResult` so the partition matches every other handler. A small dedicated normalizer (à la `context-response.ts`'s flat-payload classifier) is appropriate — cancel's reply is narrow (`{ cancelled?, state? }`), not a wrapped `CallResponse`.
- The handler performs **no** authority check: it emits a signed cancel and surfaces the receiver's verdict.

### B. `mx_workspace_status` — observe the workspace

**Descriptor** (`src/descriptors/workspace-status.ts` → `MX_WORKSPACE_STATUS`):

- `async_semantics: 'sync'` — a local read, terminal `ok`/`denied`/`error`.
- `input_schema`: `{}` — no model-facing input (no `properties`), `additionalProperties: false`. The room is injected from the session, never named by the model (design §1/§7).
- `output_schema`: an object with
  - `workspace`: `{ room_id?, name?, canonical_alias?, encrypted? }` — non-secret room metadata from `workspace.status`.
  - `agents`: `AgentSummary[]` — the registered MX agents from `agent.list`, projected via `projectAgentSummary` (the same non-secret shape `mx_find_agents` returns: `{ agent_id, kind?, capabilities[], liveness }`).
  - `project`: `{ project_id?, cwd?, git_commit? }` (optional) — derived project context.
  - `required: ['agents']`; `additionalProperties: true` so a future `tasks` field (M3) is additive, not breaking.

**Handler** (`src/handlers/workspace-status.ts` → `mxWorkspaceStatus(input, deps)`):

- Uses `RoomScopedDeps` but treats `room` as **optional/best-effort** (unlike the mutating verbs, a status read does not fail-fast on a missing room — `workspace.status` may default to the daemon's current workspace). Localise consts: `const WORKSPACE_STATUS_METHOD = 'workspace.status'; const AGENT_LIST_METHOD = 'agent.list';`.
- Algorithm:
  1. Dispatch `workspace.status` (passing `{ room: deps.room }` only when `deps.room` is set; otherwise no param). On reject → `faultToResult(err, EMPTY_AUDIT_REF)` (this is the primary read; its fault is the verb's fault).
  2. Dispatch `agent.list`. A fault here is **tolerated** → degrade to `agents: []` (mirrors `mx_describe_agent` tolerating an `agent.list` failure); "no agents" is not an error.
  3. Project: build the non-secret `workspace` metadata from the `workspace.status` reply (`room_id` / `name` / `canonical_alias` / `encrypted`, each read defensively, absent-tolerant), project each `agent.list` row via `readListRow` + `projectAgentSummary`, and derive `project` (see the secret-boundary note — prefer a dedicated `project_id`/workspace field if `workspace.status` carries one; otherwise the consistent `workspace{project_id, cwd, git_commit}` carried by the registered agents).
  4. Return `ok({ workspace, agents, ...(project ? { project } : {}) }, EMPTY_AUDIT_REF)` — `workspace.status` + `agent.list` are **local reads**, no Matrix round-trip, so `audit_ref` ids are all-null (consistent with T104).
- **Do not surface the raw Matrix `members[{ user_id }]` list** (see Security). The model-facing identities are the MX `agent_id`s, exactly as T104 chose.

A small `src/handlers/workspace-projection.ts` (pure, total readers, allowlist-by-construction) is the natural home for the `workspace`/`project` projector, reusing `asRecord` / `readString` from `agent-projection.ts`. Alternatively inline it in the handler if it stays small.

### C. Resolve the `invocation.ts` cancelled-state TODO

`INVOCATION_STATE_KIND` in `src/handlers/invocation.ts` deliberately omits `cancelled`. T108 resolves it by adding the `cancelled` family (`cancelled`, `canceled`, `aborted`) as a new terminal kind, so a `cancelled` invocation observed via `mx_await_result` resolves to a clean terminal envelope rather than the current `internal` fallback. The **envelope mapping** is the headline decision (see Risks / Open Questions): the recommendation is to add a tenth `error.code` `cancelled` (status `error`) — a deliberate, documented taxonomy **extension** owned by T108 — with a conservative fallback of mapping observed `cancelled` to a fixed `internal` message if the team prefers to keep the nine-code set frozen for M1. Note `mx_cancel`'s **own** result (`ok({ cancelled: true })`) already satisfies AC 1 without any taxonomy change; the TODO resolution only affects the *observe* path.

### D. Wiring

- `src/descriptors/index.ts` — import + re-export `MX_CANCEL`, `MX_WORKSPACE_STATUS`; append both to `CANONICAL_M1_TOOLS` (the canonical M1 set grows from 7 → 9). Update the file's header comment.
- `src/handlers/index.ts` — export `mxCancel` / `mxWorkspaceStatus` + their input/result types (and the projector if extracted).
- `src/index.ts` — barrel-export the two handlers + types + the two descriptor consts.
- `src/security.ts` — no change required (the allowlist already lists both); the security regression test will now find them in the loaded registry.

## Affected Files / Packages / Modules

**New:**
- `packages/registry/src/descriptors/cancel.ts` — `MX_CANCEL` descriptor.
- `packages/registry/src/descriptors/workspace-status.ts` — `MX_WORKSPACE_STATUS` descriptor.
- `packages/registry/src/handlers/cancel.ts` — `mxCancel` + `CancelInput`.
- `packages/registry/src/handlers/workspace-status.ts` — `mxWorkspaceStatus` + `WorkspaceStatusInput` / `WorkspaceStatusResult`.
- `packages/registry/src/handlers/workspace-projection.ts` *(optional)* — pure non-secret room/project projector.
- `packages/registry/test/handlers/cancel.test.ts`, `cancel.security.test.ts`.
- `packages/registry/test/handlers/workspace-status.test.ts`, `workspace-status.security.test.ts`.

**Modified:**
- `packages/registry/src/handlers/invocation.ts` — add the `cancelled` family to `INVOCATION_STATE_KIND` + its disposition; remove the "deferred to T108" note.
- `packages/registry/src/descriptors/index.ts` — exports + `CANONICAL_M1_TOOLS` (7 → 9).
- `packages/registry/src/handlers/index.ts`, `packages/registry/src/index.ts` — barrel exports.
- `packages/registry/src/errors.ts`, `packages/registry/src/envelope-schema.ts`, `packages/registry/src/handlers/invocation.ts` (`MESSAGE_FOR_CODE`) — **only if** the `cancelled` error-code extension (Option A) is chosen.
- `packages/registry/README.md` — document the two new verbs.
- `packages/registry/test/descriptors.test.ts`, `test/registry.test.ts`, `test/registry.smoke.test.ts`, `test/security-invariants.test.ts` — update the expected canonical-set count (7 → 9) and per-descriptor assertions.
- `packages/registry/test/handlers/invocation.test.ts` — assert the cancelled-state mapping.
- `docs/mx-agent-tool-fabric-design.md`, `docs/backlog.md`, `docs/mx-agent-surface-v0.2.1.md` — status/checkbox/notes (see Documentation Updates).

**Read for context (not modified):** `src/handlers/find-agents.ts`, `describe-agent.ts`, `run-command.ts`, `get-context.ts`, `share-context.ts`, `context-response.ts`, `handler-fault.ts`, `agent-projection.ts`, `deps.ts`, `envelope.ts`, `src/registry.ts`, `src/validator.ts`.

## API / Interface Changes

- **New model-facing tools** (public API): `mx_cancel` and `mx_workspace_status` descriptors added to `CANONICAL_M1_TOOLS`. Both are surfaced automatically by the generators (T109/T110) since those read the registry — no per-tool binding code.
- **New exported handlers:** `mxCancel`, `mxWorkspaceStatus`, and their input/result types, from `@mx-loom/registry`.
- **Daemon-RPC surface consumed (Boundary B):** `invocation.cancel` (new for the registry; "◻️ documented" — pinned at the two-daemon round-trip) and `workspace.status` (verified) + the already-used `agent.list`. No change to the daemon itself.
- **CLI:** none (the registry has no CLI; the toolbelt's CLI fallback already maps dotted methods generically).

## Data Model / Protocol Changes

- **Tool input/output schemas:** two new descriptors (shapes above). `mx_cancel` output `{ handle, cancelled, state? }`; `mx_workspace_status` output `{ workspace, agents, project? }`.
- **Result envelope:** unchanged shape. Both verbs return the standard `ToolResult` built only via the constructor helpers.
- **Error taxonomy:** **potentially extended** by one code, `cancelled` (fault-set, status `error`), *iff* Option A (recommended) is chosen for the observed-cancelled-invocation mapping. This is a deliberate, documented **extension** of the closed nine-code set (design §4.2 / T102), not a weakening — every existing code keeps its meaning and partition. If Option B (conservative) is chosen, the taxonomy is unchanged and observed `cancelled` maps to `internal` with a fixed message. **This is the decision to confirm.**
- **Idempotency-key:** none added. `mx_cancel` is naturally idempotent — cancelling is monotonic toward a terminal `cancelled` state, so a re-issued cancel is a safe no-op — mirroring T107's "content-addressing makes re-share idempotent; add no key" reasoning. (Flagged for confirmation: the design §4.4 rule "every mutating call carries an `idempotency_key`" could argue for adding one for uniformity; T102 only plumbed it onto `mx_delegate_tool` / `mx_run_command`.)
- **Audit-row:** none (T113). `audit_ref` is surfaced: populated for `mx_cancel` (a mutation/round-trip), all-null `EMPTY_AUDIT_REF` for `mx_workspace_status` (a local read), consistent with the existing handlers.
- **Serialization:** none.

## Security & Compliance Considerations

- **Secret boundary (Boundary A).** Neither verb carries credentials inbound or outbound. `mx_cancel`'s only input is a correlation `handle` (an `inv_…` id, not a secret). `mx_workspace_status` takes no model input. As with every handler, the concrete `MxClient` still runs `assertNoCredentialShapedArgs` (keys **and** values) on dispatch and `redactSecrets` on the inbound reply (T008) — defense in depth; the registry re-implements neither and keeps its zero **runtime** toolbelt dependency (seam imported `type`-only). Matrix tokens, Ed25519 signing keys, provider keys, and `GH_TOKEN` never cross into the registry, the model context, or runner children — they stay daemon-held.
- **`mx_workspace_status` projection is the load-bearing redaction decision.** The verified `workspace.status` reply carries `members[{ user_id, display_name, membership }]` — raw **Matrix user IDs**. T104 set the precedent of deliberately projecting Matrix/identity fields **out** of model-facing output (`mx_find_agents` drops `matrix_user_id`, `signing_key_id`, etc.). For consistency and minimum surface, `mx_workspace_status` **must not** surface the raw `members[].user_id` list; the model-facing identities are the MX `agent_id`s from `agent.list`. Recommendation: surface room metadata (`room_id`, `name`, `canonical_alias`, `encrypted`) + the projected agents + project context, and **omit** the Matrix `members[]` (optionally surface a non-identifying `joined_members` count). The projector is allowlist-by-construction (copies only named non-secret fields), so an upstream addition to the `workspace.status` shape can never silently leak. `room_id` is a coordination-plane identifier but is already present in `audit_ref.room` on other results and is read-only correlation context — surfacing it is acceptable; flagged for confirmation.
- **Out-of-process enforcement.** Cancellation authority lives on the **receiving** daemon: the Ed25519 trust store + deny-by-default `policy.toml` decide whether a cancel (potentially of another agent's invocation) is permitted. The handler emits a *signed request* and surfaces the verdict (`policy_denied` / `untrusted_key`) cleanly; it never decides. Cognition can only produce a signed cancel request; it can never grant itself the authority to cancel.
- **No authority/approval mutation.** Neither verb is on the forbidden list; neither exposes trust/policy/approval mutation. `mx_cancel` is not an approval and cannot release a held invocation; it can only request a stop. The model never receives a trust/policy/approval tool.
- **Audit correlation.** `mx_cancel` carries `audit_ref` from its signed cancel event (null ids when omitted, never fabricated); `mx_workspace_status` carries the all-null `EMPTY_AUDIT_REF` (local read). `error.message` is a fixed, secret-free phrase per code — the handlers echo no raw daemon payload, no `handle`, no `member`, and no `context` into messages.
- **Logging/redaction.** No secrets or tokens are logged or persisted. The cancelled-state mapping (Part C) builds messages from the code only, never from a daemon payload — consistent with `MESSAGE_FOR_CODE`.

## Testing Plan

All handler tests are **pure unit tests** with an injected `DaemonCall` fake — no daemon, no socket, no env (the `run-command.test.ts` / `find-agents.test.ts` precedent). Every produced envelope is asserted against `validateEnvelope` / `ENVELOPE_SCHEMA`, and every handler is asserted to **never throw**.

**`mx_cancel` (`test/handlers/cancel.test.ts`):**
- **AC 1** — a fake `invocation.cancel` resolving success → `ok({ handle, cancelled: true, state: 'cancelled' })`; `audit_ref` populated from the reply.
- Cancelling an already-terminal invocation → `ok({ handle, cancelled: false, state })` (a no-op success, not an error).
- Unknown handle → `not_found` (thrown `rpc`/`unknown_invocation` and resolved `{ ok: false }` variants both).
- Receiver refuses a cross-agent cancel → `policy_denied` / `untrusted_key`.
- Transport faults → `timeout` / `target_offline` / `internal` mapping.
- Malformed/empty reply → safe terminal (`internal`), never a misleading `ok`.
- (Optional end-to-end of AC 1) — `mx_cancel(handle)` then `mx_await_result(handle)` where the fake `invocation.get` now reports `cancelled` → the resolved observe-path envelope (per the chosen Option A/B mapping).

**`mx_workspace_status` (`test/handlers/workspace-status.test.ts`):**
- **AC 2** — `workspace.status` + `agent.list` fakes → `ok({ workspace, agents, project })` with `agents` projected to `AgentSummary[]` and the registered agents present.
- Empty workspace → `ok({ workspace, agents: [] })`.
- `agent.list` faults but `workspace.status` succeeds → degrades to `agents: []`, still `ok`.
- `workspace.status` faults → fault envelope (`not_found` / transport).
- `room` absent in deps → still dispatches `workspace.status` (best-effort) and succeeds.
- Malformed rows tolerated (no throw); `audit_ref` all-null.

**Security (`test/handlers/cancel.security.test.ts`, `workspace-status.security.test.ts`):**
- **No Matrix `member`/`user_id` leak** — feed a `workspace.status` reply with `members[{ user_id, … }]` and assert the projected result contains **no** `user_id` / Matrix identifiers anywhere (the headline redaction test).
- Credential-shaped values in any daemon reply are scrubbed by the real toolbelt guard at the registry boundary (the `run-command.security.test.ts` precedent using the concrete `MxClient`); error messages are secret-free; no-authority + immutability invariants hold.

**Invocation-normalizer (`test/handlers/invocation.test.ts`):**
- A `cancelled` / `canceled` / `aborted` state token → the chosen terminal disposition (Option A: `error` + code `cancelled`; Option B: `error` + `internal`). Pin the exact mapping once the round-trip verifies the real cancelled-state token.

**Registry/descriptor regressions:**
- `test/descriptors.test.ts`, `test/registry.test.ts`, `test/registry.smoke.test.ts` — the canonical set is now **9** tools; both new descriptors load, validate as JSON Schema, are unique, pass the no-authority + secret-free-shape checks, and `mx_*`-namespaced.
- `test/security-invariants.test.ts` — the loaded set is a subset of `MODEL_FACING_ALLOWLIST` (now exercising the previously-unused `mx_cancel` / `mx_workspace_status` entries).
- If Option A: `test/errors.test.ts` / `test/envelope-schema.test.ts` — the closed-set now includes `cancelled` in `FAULT_CODES` and the schema enum; the partition/exhaustiveness tests updated.

**Conformance (staged):**
- `mx_workspace_status` — `workspace.status` is **verified**, so a real conformance probe (single daemon) is feasible alongside the existing `surface.conformance.test.ts`; assert the projected shape against a live workspace.
- `mx_cancel` — `invocation.cancel` is "◻️ documented"; the cancel round-trip needs an in-flight invocation → staged behind `MXL_CONFORMANCE_TWO_DAEMON=1` (the same gate as `call.start` / `exec.start`). Author the probe; flip to green when the two-daemon fixture runs in CI.

**Documentation tests:** none beyond keeping the README example accurate.

## Documentation Updates

- **`docs/mx-agent-tool-fabric-design.md`** — update the status line (M1: T101–T108 landed). §8's MVP 7-tool list grows to the 9-tool M1 model-facing set (or note `mx_cancel` / `mx_workspace_status` as the P1 additions). **Reconcile the §10 roadmap discrepancy:** the Phase-3 row lists `mx_cancel` under M3, but the backlog schedules it (with `mx_workspace_status`) in **M1** via T108 — move/annotate `mx_cancel` to Phase 1 and keep the rest of the task tools (`mx_create/update/list_tasks`, `task.watch`) in Phase 3.
- **`docs/backlog.md`** — tick T108's two acceptance checkboxes; add a "Status: Landed" note in the T104–T107 style (resolved decisions: `sync` cancel, no idempotency key, `RoomScopedDeps`-best-effort for workspace status, Matrix-member projection, the cancelled-taxonomy decision); update the M1 header status line.
- **`docs/mx-agent-surface-v0.2.1.md`** — note that `workspace.status` (verified) now backs `mx_workspace_status` (composed with `agent.list`, with `members[].user_id` deliberately projected out), and that `invocation.cancel` backs `mx_cancel` pending the two-daemon round-trip (localised method/param consts).
- **`packages/registry/README.md`** — add the two verbs to the tool list with one-line descriptions and the envelope/audit notes.

## Risks and Open Questions

1. **(Headline) How does an *observed* cancelled invocation map onto the closed envelope?** The taxonomy is a closed 5 statuses / 9 codes (design §4.2, T102), and cancellation fits none cleanly (not `ok` — it didn't succeed; not a denial-set code; not naturally a fault-set code). **Recommendation: Option A** — extend with a tenth `error.code` `cancelled` (fault-set, status `error`): honest, programmatically distinct, a deliberate documented extension (not a weakening), touching `errors.ts`, `envelope-schema.ts`, `MESSAGE_FOR_CODE`, and the partition tests. **Option B** (conservative) — keep nine codes frozen for M1; map observed `cancelled` → `error`/`internal` with a fixed "the invocation was cancelled" message. **Option C** — defer the `invocation.ts` mapping entirely until the round-trip and ship only the two handlers. Note **AC 1 is satisfied by `mx_cancel`'s own `ok({ cancelled: true })` regardless** — this decision only affects the *observe* path. Needs confirmation.
2. **`invocation.cancel` wire shape is unverified ("◻️ documented").** Method name, param name (`invocation_id` vs `handle` vs `id`), reply disposition (does cancel ever return `awaiting_approval`? is the success reply flat `{ cancelled, state }` or a wrapped `CallResponse`?), and whether it needs an explicit `room`. Authored against the design with localised consts; pinned at `MXL_CONFORMANCE_TWO_DAEMON=1`. A wrong assumption degrades to `internal` (never the wrong code), never throws.
3. **`workspace.status` room-arg requirement is unrecorded.** `workspace.status` is verified to *return* `room_id`, but the T001 spike did not record whether it *takes* a `room` argument or defaults to the daemon's current workspace. The handler passes `deps.room` when present and tolerates its absence; confirm at a live check and tighten if required.
4. **Matrix-member surfacing.** Recommendation is to **drop** `members[].user_id` and surface only room metadata + MX agents (consistency with T104). Confirm whether any consumer needs a member count or display names; if so, surface a coarse non-identifying `joined_members` count only.
5. **`mx_cancel` idempotency.** Recommendation: no `idempotency_key` (natural idempotence). Confirm against the design §4.4 "every mutating call carries an idempotency_key" rule — if uniformity is preferred, add an optional `idempotency_key` mirroring `mx_run_command` (a dedup nonce, never a capability).
6. **Canonical set size (7 → 9).** Adding both descriptors to `CANONICAL_M1_TOOLS` means the generators (T109/T110) and the golden test (T114) will surface them. Confirm that is intended for M1 (the backlog and `MODEL_FACING_ALLOWLIST` both already include them, so this is expected) and update the count assertions in the registry tests.
7. **`mx_cancel` async semantics.** Modeled `sync`. If a future daemon gates a cancel behind approval (a held cancel), the descriptor would flip to `deferred` and the handler reuse `callResponseToResult` + an inline `wait_ms`. Unlikely for M1; flagged.

## Implementation Checklist

1. **Descriptor — `mx_cancel`.** Create `src/descriptors/cancel.ts` exporting `MX_CANCEL` via `defineDescriptor` (`sync`; input `{ handle (req) }` `additionalProperties:false`; output `{ handle, cancelled, state? }` required `[handle, cancelled]` `additionalProperties:true`; schemas tagged `JSON_SCHEMA_DIALECT`).
2. **Descriptor — `mx_workspace_status`.** Create `src/descriptors/workspace-status.ts` exporting `MX_WORKSPACE_STATUS` (`sync`; empty input `additionalProperties:false`; output `{ workspace, agents, project? }` required `[agents]` `additionalProperties:true`).
3. **Register.** In `src/descriptors/index.ts`, import + re-export both and append to `CANONICAL_M1_TOOLS` (7 → 9); update the header comment.
4. **Handler — `mxCancel`.** Create `src/handlers/cancel.ts`: plain `HandlerDeps`; localised `INVOCATION_CANCEL_METHOD` / `INVOCATION_ID_PARAM`; dispatch → on reject `faultToResult(err, EMPTY_AUDIT_REF)` → on success `ok({ handle, cancelled, state? }, extractAuditRef(response))` (route a resolved daemon-error signal through `failureCode`/`failureResult`). Never throws.
5. **Handler — `mxWorkspaceStatus`.** Create `src/handlers/workspace-status.ts`: `RoomScopedDeps` (room best-effort, no fail-fast); localised `WORKSPACE_STATUS_METHOD` / `AGENT_LIST_METHOD`; dispatch `workspace.status` (primary; fault → fault envelope) then `agent.list` (tolerated; fault → `agents: []`); project via a new `workspace-projection.ts` + reused `projectAgentSummary` / `readListRow`; return `ok({ workspace, agents, project? }, EMPTY_AUDIT_REF)`. **Omit Matrix `members[].user_id`.**
6. **Resolve the TODO.** In `src/handlers/invocation.ts`, add `cancelled` / `canceled` / `aborted` to `INVOCATION_STATE_KIND` with the chosen disposition (Option A: new `cancelled` code; Option B: `internal` fixed message); remove the "deferred to T108" note.
7. **Taxonomy (only if Option A).** Extend `ERROR_CODES` / `FAULT_CODES` (`errors.ts`), the `ENVELOPE_SCHEMA` enum (`envelope-schema.ts`), and `MESSAGE_FOR_CODE` (`invocation.ts`) with `cancelled`; update mappers + partition tests.
8. **Barrel exports.** `src/handlers/index.ts` and `src/index.ts` — export `mxCancel`, `mxWorkspaceStatus`, the projector, and the input/result types; export `MX_CANCEL` / `MX_WORKSPACE_STATUS`.
9. **Tests — handlers.** Add `test/handlers/cancel.test.ts`, `cancel.security.test.ts`, `workspace-status.test.ts`, `workspace-status.security.test.ts` per the Testing Plan (AC 1 / AC 2, fault mapping, no-throw, `validateEnvelope`, the no-`user_id`-leak assertion).
10. **Tests — regressions.** Update `test/descriptors.test.ts`, `test/registry.test.ts`, `test/registry.smoke.test.ts`, `test/security-invariants.test.ts` for the 9-tool set; add the cancelled-state case to `test/handlers/invocation.test.ts`.
11. **Conformance (staged).** Add a `workspace.status`-backed probe (single daemon, can run live) and an `invocation.cancel` probe staged behind `MXL_CONFORMANCE_TWO_DAEMON=1`.
12. **Docs.** Update `docs/mx-agent-tool-fabric-design.md` (§8 set, §10 roadmap reconciliation, status line), `docs/backlog.md` (T108 checkboxes + Status note), `docs/mx-agent-surface-v0.2.1.md` (the two methods), and `packages/registry/README.md`.
13. **Verify.** `pnpm --filter @mx-loom/registry test` green; `pnpm --filter @mx-loom/registry build` clean (no new runtime dep on the toolbelt; `type`-only imports erased); lint/format pass.
