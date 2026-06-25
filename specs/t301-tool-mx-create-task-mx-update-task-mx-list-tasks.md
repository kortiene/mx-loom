# T301 · Task DAG tools: `mx_create_task` / `mx_update_task` / `mx_list_tasks`

> GitHub issue #30 — `area/registry` `priority/P0` `type/feature` · Estimate **M** · Milestone **M3 — Coordination depth** · Source `docs/backlog.md` (`T301`). Blocked-by #10 (T102, the result envelope) — **landed**.

## Problem Statement

mx-loom's model-facing surface is, as of M2, the **9 delegation/observe verbs** (discover → delegate → coordinate → share → observe). What a model **cannot** yet do is author or read the **durable shared plan** — the task DAG.

The design draws a clean line (design §7): *ephemeral cognition state* (scratchpad, conversation, retrieved knowledge) stays runtime-private; *durable coordination state* (the plan of record) lives on the substrate as the signed `com.mxagent.task.v1` DAG — `proposed→pending→assigned→executing→succeeded/failed`, with `depends_on`/`blocks` edges and a signed `action`. This DAG is also the **crash-recovery boundary**: a runtime can die and a fresh one resumes the plan from durable task state (the M3 exit criterion, T302/T304).

Today there is **no way for cognition to write to that DAG**. The daemon exposes `task.create/update/list/graph` (flags confirmed against v0.2.1; see `docs/mx-agent-surface-v0.2.1.md`), but no mx-loom descriptor, handler, or binding entry surfaces them. T108 deliberately left a forward-compatible `tasks` slot empty in `mx_workspace_status` and recorded "the `tasks` dimension is deferred to M3/T301."

T301 closes that gap by adding the three model-facing task verbs — `mx_create_task`, `mx_update_task`, `mx_list_tasks` — so a planner can create a task with dependencies, list a DAG that reflects those dependencies, and transition a task's state. This is the **first deliverable of M3** and unblocks `task.watch` resumption (T302), signed task-action dispatch (T303), and the multi-agent-restart exit test (T304).

## Goals

- Add three canonical, transport-neutral, secret-free `mx_*` descriptors — `mx_create_task`, `mx_update_task`, `mx_list_tasks` — to `@mx-loom/registry`, validated by the existing fail-fast loader.
- Add three registry handlers mapping those verbs onto the daemon `task.create` / `task.update` / `task.list` (+ `task.graph`) RPCs through the **injected** `DaemonCall` seam (no new socket, no toolbelt runtime dependency).
- Support **dependency authoring**: `mx_create_task` accepts `depends_on` / `blocks`; the created node carries the edges, and `mx_list_tasks` returns a DAG (nodes **plus** edges) that reflects them — satisfying the acceptance criterion "create a task with deps; list reflects the DAG."
- Support **state transitions**: `mx_update_task` transitions a task to a target state, normalized through a stable, documented `TaskState` mapping over the daemon's `proposed→pending→assigned→executing→succeeded/failed` vocabulary.
- Produce a **T102 envelope by construction** for every result (created/updated → `ok(node, audit_ref)`; list → `ok({ tasks, edges }, EMPTY_AUDIT_REF)`; faults → the closed nine-code taxonomy), reusing the existing `ok`/`errored`/`faultToResult` helpers and the shared response readers.
- **Plumb idempotency** on the two mutating verbs (`mx_create_task` / `mx_update_task`) exactly as `mx_delegate_tool` / `mx_run_command` do (client-supplied `idempotency_key`, generated when omitted, reused verbatim on transport-level retry).
- Wire the three verbs into **every binding that routes by a dispatch table**: `@mx-loom/mcp` (`DISPATCH`) and `@mx-loom/pi` (`DISPATCH`). The Claude shim and the generated MCP `tools/list` pick the descriptors up automatically because they enumerate the registry.
- Preserve every security invariant: room from the session (never model input), reject credential-shaped args (especially authored task-action args), `audit_ref` on the signed mutations, never log a secret.

## Non-Goals

- **Executing / dispatching a task's `action`.** A task node may carry a signed `action` (a tool call or guarded command). T301 only **authors and reads** that action into/out of the DAG record. Running it through the full authorize pipeline (sig → trust → policy → approval → sandbox) on dispatch is **T303** (signed task-action dispatch alignment).
- **`task.watch` / push-based resumption.** Subscribing to the task stream and reconstructing a cognitive session after a runtime restart is **T302** (and the restart test is T304). T301 ships only poll/read of the DAG via `mx_list_tasks`. The `mx_await_result` poll backend continues to use `invocation.get`; nothing here changes the T103 contract.
- **Populating `mx_workspace_status.tasks`.** The additive slot T108 reserved is *not* filled here (the AC does not require it, and a dedicated `mx_list_tasks` is the cleaner surface). Whether to also surface a task summary in `mx_workspace_status` is an Open Question, not a deliverable.
- **Approval-gating the task verbs themselves.** Creating/updating/listing the plan record is `sync` and not approval-gated in M3; the deferred `running` / `awaiting_approval` path belongs to a task's *action dispatch* (T303), not to authoring the node.
- **Any authority surface.** No `trust.*` / `approval.decide` / `policy.*` / `auth.*` / `device.*` / `daemon.*` is added or touched. Task verbs are plan-authoring verbs, not governance verbs.
- **A new transport or daemon-side schema change.** mx-loom consumes the existing `task.*` RPCs across Boundary B exactly as the daemon defines them; it never forks the daemon or re-implements task storage.

## Relevant Repository Context

**The repo is a TypeScript pnpm monorepo (Node ≥20.19, vitest, Apache-2.0).** As of M2 the relevant packages **exist and are implemented** — this is no longer docs-only:

- `@mx-loom/registry` (`packages/registry`) — the canonical descriptor model + the result envelope + the handler layer. **This is the owning package for T301** (`area/registry`). Key existing modules T301 mirrors:
  - `src/descriptor.ts` — `defineDescriptor()`, `ToolDescriptor`, `TOOL_NAME_RE`, `AsyncSemantics`.
  - `src/descriptors/*.ts` — one descriptor per verb; `src/descriptors/index.ts` assembles `CANONICAL_M1_TOOLS` (currently **9**).
  - `src/handlers/*.ts` — one handler per verb; `src/handlers/deps.ts` defines the injected `DaemonCall` / `HandlerDeps` / `RoomScopedDeps` seam; `src/handlers/invocation.ts` holds the shared, total response readers (`extractAuditRef`, `failureCode`, `failureResult`, `hasErrorSignal`, `stateToken`/`normaliseToken`); `src/handlers/handler-fault.ts` holds `EMPTY_AUDIT_REF` + `faultToResult`.
  - `src/envelope.ts` — `ok` / `running` / `awaitingApproval` / `denied` / `errored` constructors + `ToolResult` / `AuditRef`; `src/errors.ts` — the closed `ERROR_CODES` taxonomy and `DENIAL_CODES`/`FAULT_CODES` partition + `mapDaemonError` / `mapTransportError`.
  - `src/idempotency.ts` — `newIdempotencyKey()` (`idk_<uuid>`).
  - `src/security.ts` — `MODEL_FACING_ALLOWLIST`, `isForbiddenAuthorityVerb`, `findCredentialShapedProperty`, `CREDENTIAL_KEY_RE`; `src/registry.ts` — `loadRegistry()` fail-fast validation.
- `@mx-loom/mcp` (`packages/mcp`) — the generated MCP server. `src/dispatch.ts` holds the **hand-maintained** `DISPATCH` name→handler map (`dispatchCall`); `tools/list` enumerates the registry verbatim, so descriptors flow automatically but **a new handler needs a new `DISPATCH` entry**.
- `@mx-loom/claude` (`packages/claude`) — the Claude SDK in-process shim. `src/tool-server.ts` routes **every** registry descriptor through `@mx-loom/mcp`'s `dispatchCall`, so once the registry + MCP `DISPATCH` carry the task verbs, Claude surfaces them with **no Claude-side change**.
- `@mx-loom/pi` (`packages/pi`) — the Pi native binding. It has its **own** `src/dispatch.ts` `DISPATCH` map (no `@modelcontextprotocol/sdk` in Pi's graph), so it **also needs three new entries**.
- `@mx-loom/golden` (`packages/golden`) — the binding-agnostic S1–S8 scenario + the portability matrix. M3's multi-agent-restart gate (T304) extends it; T301 only adds the staged conformance arm.
- `packages/toolbelt` (`@mx-loom/toolbelt`) — the daemon transport + the authoritative secret guards (`assertNoCredentialShapedArgs`, `redactSecrets`, `safeSubprocessEnv`). The registry imports its `MxTransport` **type-only**, keeping zero runtime dependency.

**Verified daemon surface (`docs/mx-agent-surface-v0.2.1.md`).** `task.create/update/list/graph` are listed as **"◻️ flags confirmed · round-trip staged"**:

> `task create --room --title [--tool --arg/--input-json --exec --depends-on --blocks --assign --state]` — matches the DAG + signed-action model.

So the **CLI flag set is known** but the JSON-RPC param names, the task-id field name, the exact task-state vocabulary, the `task.graph` reply shape, and `audit_ref` availability are **pending the two-daemon round-trip** (`MXL_CONFORMANCE_TWO_DAEMON=1`). T301 authors against these named shapes with the method/param names localised in consts (the `delegate-tool.ts` / `share-context.ts` / `cancel.ts` precedent), so the conformance fixture corrects the wire in one place.

**Conventions every handler in this repo follows** (T301 must match):
- Handlers are **pure dispatch + normalize**, **never throw**; every transport/daemon fault maps onto the closed taxonomy via `faultToResult` or a builder.
- The **room comes from the session** (`RoomScopedDeps.room`, injected by the binding from `MxSession`), **never** from model input — a model must never name a Matrix room id.
- Envelopes are built **only** through the T102 constructor helpers (conform-by-construction).
- Method/param wire names are **localised consts** with a comment pinning them at the round-trip.
- Mutations populate `audit_ref` from the response (null inner ids when omitted, never fabricated); local reads use `EMPTY_AUDIT_REF`.
- Secret-free `error.message` (a fixed phrase per code, never an echoed daemon payload).

## Proposed Implementation

Three descriptors + three handlers in `@mx-loom/registry`, then dispatch wiring in `@mx-loom/mcp` and `@mx-loom/pi`. All three verbs are **`sync`** (authoring/reading the plan record resolves directly to a terminal `ok`/`denied`/`error`; the deferred path belongs to action *dispatch*, T303).

### 1. Descriptors (`packages/registry/src/descriptors/`)

Add `create-task.ts`, `update-task.ts`, `list-tasks.ts`, each via `defineDescriptor()`, schemas in `JSON_SCHEMA_DIALECT` (draft-07).

**`mx_create_task`** — `async_semantics: 'sync'`, mutating. Input (`additionalProperties: false`):
- `title` (string, **required**) — the human/model-readable task title.
- `depends_on` (string[]) — ids of tasks this one depends on (incoming edges).
- `blocks` (string[]) — ids of tasks this one blocks (outgoing edges; the inverse convenience the CLI exposes as `--blocks`).
- `assign` (string) — an `agent_id` to assign the task to (optional; assignment may also be deferred).
- `state` (string enum = the model-facing `TaskState` set, default `proposed`) — the initial state.
- `action` (object, optional) — the signed action the node carries, authored but **not dispatched** here (T303 dispatches). A **closed** discriminated shape mirroring the delegation surface so no free-form credential field exists:
  - `{ kind: 'tool', tool: string, args: object }` → maps to `--tool` + `--arg`/`--input-json`.
  - `{ kind: 'exec', command: string, args?: string[], cwd?: string }` → maps to `--exec`.
- `idempotency_key` (string, optional) — the §4.4 dedup nonce; generated when omitted.

Output: the created **`TaskNode`** (see Data Model). `additionalProperties: true` so a daemon-added field is non-breaking.

**`mx_update_task`** — `async_semantics: 'sync'`, mutating. Input (`additionalProperties: false`):
- `task_id` (string, **required**) — the task to update.
- `state` (string enum = `TaskState`) — the target state to transition to (the headline AC).
- `assign` (string) — re-assign to an `agent_id`.
- `depends_on` / `blocks` (string[]) — adjust edges (optional; whether the daemon supports edge edits on update is pinned at the round-trip — if not, these are dropped and documented).
- `idempotency_key` (string, optional).

Output: the updated `TaskNode`.

**`mx_list_tasks`** — `async_semantics: 'sync'`, read. Input (`additionalProperties: false`):
- `state` (string enum = `TaskState`) — optional filter.
- `assignee` (string) — optional `agent_id` filter.
- `view` (string enum `['list', 'graph']`, default `'graph'`) — `graph` returns nodes **and** edges (backed by `task.graph` when the edge set is not already on `task.list`); `list` returns nodes only. Default `graph` so "list reflects the DAG" holds out of the box.

Output: `{ tasks: TaskNode[], edges: TaskEdge[] }` (`edges` present for `view: 'graph'`).

No mutating descriptor declares a credential-shaped property; the loader's `findCredentialShapedProperty` enforces this at load. The `action` sub-schema uses only `tool`/`command`/`args`/`cwd` keys (none credential-shaped) — the dangerous surface is the **values** inside `action.args`, rejected at dispatch by the toolbelt guard (below), not the property names.

### 2. Handlers (`packages/registry/src/handlers/`)

Add `create-task.ts`, `update-task.ts`, `list-tasks.ts`. All three use `RoomScopedDeps` (the DAG is workspace-scoped). The two mutators **fail fast** (`errored('internal', 'no workspace room configured for task', EMPTY_AUDIT_REF)`) when `deps.room` is unset — mirroring `mxShareContext`/`mxRunCommand` Phase 1. `mx_list_tasks` treats room as **best-effort** (mirroring `mxWorkspaceStatus`): pass `{ room }` when present, tolerate absence so the daemon may default to its current workspace.

Localised wire consts (one place to correct at the round-trip):
```ts
const TASK_CREATE_METHOD = 'task.create';
const TASK_UPDATE_METHOD = 'task.update';
const TASK_LIST_METHOD   = 'task.list';
const TASK_GRAPH_METHOD  = 'task.graph';   // edges, when view === 'graph'
const TASK_ID_PARAM      = 'task_id';      // pinned at round-trip (CLI shows positional id)
```

**`mxCreateTask`** — Phase 1 room provenance → Phase 2 build params (`room` from session; `title`/`depends_on`/`blocks`/`assign`/`state`/`action` mapped to the `task create` flag shapes; omit absent fields so no `undefined` leaks) → attach `idempotency_key` (`input.idempotency_key ?? newIdempotencyKey()`) → `deps.daemon.call(TASK_CREATE_METHOD, params)` in a try/catch (`faultToResult` on throw) → Phase 3 normalize the reply into `ok(projectTaskNode(reply), extractAuditRef(reply))`. A `policy_denied`/`untrusted_key` on create maps cleanly through `faultToResult` / the failure classifier.

**`mxUpdateTask`** — same shape; params carry `task_id` + the changed fields + `idempotency_key`; reply → `ok(projectTaskNode(reply), audit_ref)`. The **state transition is the daemon's job**: the handler forwards the requested target `state` and surfaces the daemon's resulting node state; it performs no client-side transition-legality check (an illegal transition is the daemon's `invalid_args`/`policy_denied`, surfaced cleanly).

**`mxListTasks`** — best-effort room → `task.list` (+ `task.graph` when `view === 'graph'`, tolerated: a graph fault degrades to `edges: []`, never failing the list) → project each row through `projectTaskNode`, project edges through `projectTaskEdge` → `ok({ tasks, edges }, EMPTY_AUDIT_REF)` (a local read → no Matrix round-trip → empty audit ref, consistent with `mxFindAgents`/`mxWorkspaceStatus`).

**Shared task normalizers** — a new `packages/registry/src/handlers/task-projection.ts` (mirroring `agent-projection.ts` / `workspace-projection.ts`):
- `projectTaskNode(raw): TaskNode` — total, allowlist-by-construction projection of one daemon task record onto the non-secret `TaskNode` shape, with `state` run through `mapTaskState`.
- `projectTaskEdge(raw): TaskEdge | undefined`.
- `mapTaskState(rawToken): TaskState` — the **state mapping table** (the issue's "map states"), normalising the daemon vocabulary (`proposed`/`pending`/`assigned`/`executing`/`succeeded`/`failed`, plus tolerated synonyms `queued`/`running`/`done`/`error`/…) onto a stable model-facing `TaskState` set, with an explicit, safe fallback (`unknown` → a documented default, never a fabricated specific state). Reuse `normaliseToken` from `invocation.ts`.

### 3. Registry assembly + security allowlist

- `descriptors/index.ts`: export the three new descriptors. **Introduce `CANONICAL_TOOLS`** (the full enumerable set = the 9 M1 verbs + the 3 M3 task verbs) and keep `CANONICAL_M1_TOOLS` as a named subset for back-compat. `loadRegistry()`'s default param changes from `CANONICAL_M1_TOOLS` to `CANONICAL_TOOLS`. *(Decision to confirm — see Open Questions: appending to a const literally named `CANONICAL_M1_TOOLS` would be misleading; a clean `CANONICAL_TOOLS` superset is recommended.)*
- `handlers/index.ts`: barrel-export the three handlers + their input types + the `TaskNode`/`TaskEdge`/`TaskState` types + the projectors.
- `security.ts`: extend `MODEL_FACING_ALLOWLIST` with `mx_create_task`, `mx_update_task`, `mx_list_tasks` (now **12** verbs). The forbidden-authority check needs no change (task verbs are not governance verbs).

### 4. Binding dispatch wiring

- `packages/mcp/src/dispatch.ts`: add three `DISPATCH` entries (`roomScopedDeps(ctx)` for all three). Claude (`packages/claude/src/tool-server.ts`) routes via this `dispatchCall`, so it inherits them automatically.
- `packages/pi/src/dispatch.ts`: add the same three entries to Pi's independent `DISPATCH` map.
- The generated MCP `tools/list` and the Pi `ToolDefinition[]` enumerate the registry, so the descriptors surface to models with no further authoring.

## Affected Files / Packages / Modules

**Create (registry):**
- `packages/registry/src/descriptors/create-task.ts`, `update-task.ts`, `list-tasks.ts`
- `packages/registry/src/handlers/create-task.ts`, `update-task.ts`, `list-tasks.ts`
- `packages/registry/src/handlers/task-projection.ts` (`projectTaskNode`/`projectTaskEdge`/`mapTaskState` + `TaskNode`/`TaskEdge`/`TaskState`)
- `packages/registry/test/descriptors.task.test.ts`, `handlers/create-task.test.ts`, `handlers/update-task.test.ts`, `handlers/list-tasks.test.ts`, `handlers/task-projection.test.ts`, `handlers/tasks.security.test.ts`

**Modify (registry):**
- `packages/registry/src/descriptors/index.ts` — export descriptors; add `CANONICAL_TOOLS`.
- `packages/registry/src/handlers/index.ts` — barrel-export handlers/types/projectors.
- `packages/registry/src/registry.ts` — default to `CANONICAL_TOOLS`.
- `packages/registry/src/security.ts` — extend `MODEL_FACING_ALLOWLIST`.
- `packages/registry/test/security-invariants.test.ts`, `registry.test.ts`, `registry.smoke.test.ts` — update expected counts/allowlist.

**Modify (bindings):**
- `packages/mcp/src/dispatch.ts` — three `DISPATCH` entries.
- `packages/pi/src/dispatch.ts` — three `DISPATCH` entries.
- `packages/mcp/test/*` and `packages/pi/test/*` — any `tools/list` / tool-count assertions that pin the surfaced set (will now expect 12).

**Read for context (no change expected):**
- `packages/claude/src/tool-server.ts` (confirms automatic pickup), `packages/registry/src/handlers/workspace-status.ts` (the reserved `tasks` slot), `docs/mx-agent-surface-v0.2.1.md` (the `task.*` flag table).

**Conformance (staged):**
- `scripts/conformance/` + `packages/toolbelt/test/conformance/` (or `packages/golden/test/`) — a `task.*` round-trip arm gated behind `MXL_CONFORMANCE_TWO_DAEMON=1`, skip-clean locally, fail-not-skip in CI when demanded. (The full multi-agent-restart gate is T304.)

## API / Interface Changes

**New public model-facing tools (documented):** three descriptors — `mx_create_task`, `mx_update_task`, `mx_list_tasks` — surfaced through every binding (MCP `tools/list`, Claude in-process shim, Pi `ToolDefinition[]`). Each carries a namespaced name, a one-line description, an `input_schema`, an `output_schema`, and `async_semantics: 'sync'`.

**New registry exports:** `mxCreateTask` / `mxUpdateTask` / `mxListTasks` handlers; `CreateTaskInput` / `UpdateTaskInput` / `ListTasksInput`; `TaskNode` / `TaskEdge` / `TaskState`; `projectTaskNode` / `projectTaskEdge` / `mapTaskState`; the `CANONICAL_TOOLS` superset const + the new descriptor consts (`MX_CREATE_TASK` / `MX_UPDATE_TASK` / `MX_LIST_TASKS`).

**New daemon-RPC surface consumed** (not exposed to the model): `task.create` / `task.update` / `task.list` / `task.graph`. Method/param spellings are **localised consts pending the two-daemon round-trip** — authored against the verified CLI flag set.

**Binding dispatch tables** gain three entries each in `@mx-loom/mcp` and `@mx-loom/pi`. No CLI flag changes to `mx-loom-mcp` (the task verbs are session-scoped reads/writes, not new server config). No change to the `MxClient`/`MxTransport` interface, the toolbelt CLI, or `MxSession`.

## Data Model / Protocol Changes

**No change to the result envelope or the error taxonomy** — every task result is a standard T102 envelope built through the existing helpers, carrying only the closed nine-code error set.

**New tool input/output schemas** (descriptor-local, not envelope changes):

- **`TaskNode`** (output of create/update; element of `mx_list_tasks.tasks`) — the non-secret projection of a `com.mxagent.task.v1` record:
  ```jsonc
  {
    "task_id": "task_…",
    "title": "…",
    "state": "proposed|pending|assigned|executing|succeeded|failed",  // model-facing TaskState
    "assignee": "agent_…" | null,
    "depends_on": ["task_…"],
    "blocks": ["task_…"],
    "action": { "kind": "tool"|"exec", … } | null,   // authored shape, NOT dispatched here
    "created_at": "…", "updated_at": "…"              // when the daemon returns them
  }
  ```
- **`TaskEdge`** (element of `mx_list_tasks.edges` for `view: 'graph'`): `{ "from": "task_…", "to": "task_…", "kind": "depends_on" }`.
- **`TaskState`** — the stable model-facing state set + the `mapTaskState` table from the daemon vocabulary (`proposed→pending→assigned→executing→succeeded/failed`, with tolerated synonyms and a documented safe fallback).

**Idempotency:** `mx_create_task` / `mx_update_task` carry the optional `idempotency_key` field (the existing §4.4 contract); the read `mx_list_tasks` does not. Reused verbatim on transport-level retry so the daemon dedupes; the key is a nonce, not a capability.

**`audit_ref`:** create/update are signed mutations → `audit_ref` populated from the reply (null inner ids when the daemon omits them, never fabricated). `mx_list_tasks` is a local read → `EMPTY_AUDIT_REF`.

**No `audit-row` (`@mx-loom/audit`) schema change** — the existing `auditRowFrom` projection already accepts any `ToolResult` + binding context; the task verbs flow through the single `withAudit` chokepoint unchanged (the new `tool_name`s simply appear on the existing row shape).

**Wire-shape items pinned at the round-trip** (authored now, corrected in one place later): the `task.*` method/param names, the task-id field name, the task-state vocabulary, the `task.graph` reply shape (nodes+edges vs edges-only, and whether `task.list` already returns edges), whether `task.update` accepts edge edits, and `audit_ref` availability on task replies.

## Security & Compliance Considerations

- **No secret crosses Boundary A.** The task verbs carry no Matrix token, Ed25519 signing key, provider key, or `GH_TOKEN` inbound or outbound. The most dangerous new surface is an authored **task `action.args`** (e.g. a model trying to bake `['-H','Authorization: Bearer ghp_…']` into a task's exec action). The concrete `deps.daemon.call` (an `MxClient` in production) runs `assertNoCredentialShapedArgs` over **keys and values** before dispatch — a credential-shaped action arg is rejected as `invalid_args` and **never persisted into the DAG**. The registry re-implements neither guard (single source = the toolbelt) and keeps its zero runtime toolbelt dependency (the seam is injected, imported `type`-only). The descriptor schemas declare no credential-shaped property names (loader-enforced by `findCredentialShapedProperty`).
- **Out-of-process enforcement, unchanged.** The handler emits a *signed request* only; it performs **no** trust/policy/sandbox/approval check. Whether a task may be created/updated, assigned, or its action ultimately run is decided by the **receiving daemon** (Ed25519 trust store + deny-by-default `policy.toml` + sandbox + approval gate). `policy_denied` / `untrusted_key` are outcomes the handler **maps and surfaces cleanly**, never decisions it makes. Cognition can only produce a signed task request; it can never grant itself authority over the plan.
- **No authority/approval-mutation tool added.** Task verbs author the *plan*, not governance. The forbidden-authority allowlist is untouched; the no-authority loader check still passes. Approval still reaches the model only as an `awaiting_approval` envelope status — and only on the **action-dispatch** path (T303), re-validated against live policy at release, never on plan authoring.
- **Room provenance.** The workspace room is injected from `MxSession` (a coordination-plane detail), never named by the model. The mutating verbs fail fast on an absent room rather than dispatch a room-less task write.
- **Audit correlation.** Every create/update result carries `audit_ref` tying "model authored task X" ↔ "daemon signed `com.mxagent.task.v1` event Y", mirrored into the Postgres queryable index via the existing best-effort `withAudit` tap (`@mx-loom/audit`) — no new audit schema.
- **Logging/redaction.** `error.message` is the fixed, secret-free phrase per code (never an echoed daemon payload or task title). The handlers log nothing; `redactSecrets` on the inbound result is the toolbelt's value-shape defense-in-depth. Never log a task title, action args, or daemon payload at any level.

## Testing Plan

**Unit — descriptors (`descriptors.task.test.ts`):** the three descriptors load via `loadRegistry()` without throwing; names match `TOOL_NAME_RE`; `async_semantics === 'sync'`; `input_schema`/`output_schema` compile against draft-07; mutating descriptors declare `idempotency_key`, the read does not; no credential-shaped property name; `mx_list_tasks.input_schema.view` defaults to `graph`.

**Unit — handlers (daemon-free, injected fake `DaemonCall`):**
- *create:* a `task.create` reply → `ok(TaskNode, audit_ref)` with `depends_on`/`blocks` round-tripped; room missing → fail-fast `internal`; daemon `policy_denied`/`untrusted_key`/`invalid_args` → the mapped envelope; `idempotency_key` defaulted when omitted and forwarded verbatim; an authored `action` is forwarded but never dispatched (no `call.start`/`exec.start` issued).
- *update:* target `state` forwarded; reply node's mapped state surfaced; an illegal-transition daemon error surfaced cleanly; `task_id` required.
- *list:* `view: 'graph'` returns `{ tasks, edges }`; a `task.graph` fault degrades to `edges: []` while `tasks` still returns; `state`/`assignee` filters forwarded; room best-effort (omitted when unset); `EMPTY_AUDIT_REF`.
- *projection (`task-projection.test.ts`):* `mapTaskState` table covers every daemon token + synonyms + the safe fallback; `projectTaskNode` drops any non-allowlisted/secret-shaped field; total/never-throws on malformed input.

**Acceptance-criterion test (the issue's AC, daemon-free with a scripted fake daemon):** create a task with `depends_on` → `mx_list_tasks` returns a DAG whose `edges` reflect the dependency → `mx_update_task` transitions its `state` and the subsequent list shows the new state.

**Security (`tasks.security.test.ts`):** a credential-shaped `action.args` value is rejected `invalid_args` (asserted across the dispatch boundary, never persisted); no secret env var appears in any task payload; `error.message` carries no daemon payload; the three verbs are absent from the forbidden-authority set and present in `MODEL_FACING_ALLOWLIST`.

**Registry regression:** `security-invariants.test.ts` / `registry.test.ts` updated for the 12-verb set; the no-authority + secret-free invariants still hold over the superset.

**Binding tests:** MCP `tools/list` and Pi `ToolDefinition[]` surface 12 tools including the three task verbs; a `tools/call` to `mx_create_task` routes through `DISPATCH` to `mxCreateTask`; Claude's `tool-server` enumerates the three with no Claude-side change.

**Result-envelope / error-taxonomy / idempotency:** every task result validates against `ENVELOPE_SCHEMA`; faults map only to closed-set codes; a retried create with the same `idempotency_key` reuses the key verbatim.

**Conformance (staged, `MXL_CONFORMANCE_TWO_DAEMON=1`):** a live `task.create → task.list → task.update` round-trip against the pinned v0.2.1 daemon, pinning the localised method/param consts, the task-id field, the state vocabulary, the `task.graph` reply shape, and `audit_ref` availability. Skip-clean without the fixture, fail-not-skip in CI when demanded. (The multi-agent-restart e2e is T304, not T301.)

**Documentation test:** if the runtime-guide drift guard (`packages/mcp/test/runtime-guide.test.ts`) pins the verb list, update its expected set to 12.

## Documentation Updates

- **`docs/backlog.md`** — flip T301's status/AC to landed (and update the M-status header line as prior tasks did); note the `task.*` wire pins still staged behind the two-daemon fixture; cross-reference T302/T303/T304.
- **`docs/mx-agent-tool-fabric-design.md`** — §2 (the task-DAG row moves from "Phase 3 follows" to live), §7 (the task-state paragraph), §8/§10 (Phase 3 deliverable status). Note the verb set grows from 9 to 12 and that `mx_workspace_status`'s reserved `tasks` slot remains intentionally unpopulated (deferred — Open Questions).
- **`docs/mx-agent-surface-v0.2.1.md`** — once the round-trip runs, flip `task.create/update/list/graph` from "◻️ flags confirmed · round-trip staged" to verified and record the pinned method/param/state shapes.
- **`docs/runtime-integration.md`** — if it enumerates the model-facing verbs, add the three task verbs.
- **Help text / descriptions** — the descriptor `description` strings are the model-facing help; no separate CLI help.
- **(T305 owns the standalone cognition-vs-coordination state guide — not T301.)**

## Risks and Open Questions

1. **`task.graph` reply shape (load-bearing).** Does `task.graph` return nodes+edges, edges-only, or does `task.list` already include edges? The recommended `mx_list_tasks` default (`view: 'graph'` → `{ tasks, edges }`) assumes a separate edge source that degrades to `edges: []` on fault. Pin at the round-trip; if `task.list` already returns edges, `task.graph` becomes unnecessary and `view` collapses to a single backing call.
2. **Three model-facing verbs vs four daemon RPCs.** The design §2 table maps the three `mx_*` verbs to `task.create/update/list/graph` (4 RPCs). Folding `task.graph` into `mx_list_tasks` (rather than adding a 4th `mx_graph_tasks`) is the recommended reading of "list reflects the DAG" — **confirm** there's no desire for a distinct graph verb.
3. **`CANONICAL_M1_TOOLS` naming.** Appending task verbs to a const literally named `CANONICAL_M1_TOOLS` is misleading. Recommendation: introduce `CANONICAL_TOOLS` (full set) and keep `CANONICAL_M1_TOOLS` as a documented subset; point `loadRegistry()`'s default at `CANONICAL_TOOLS`. **Confirm** this doesn't break a consumer that imports `CANONICAL_M1_TOOLS` expecting *all* tools.
4. **Task-state vocabulary + transition legality.** The daemon's exact state tokens and whether it enforces transition legality are unverified. T301 forwards the requested target `state` and surfaces the daemon's resulting state (no client-side transition graph), so an illegal transition is the daemon's `invalid_args`/`policy_denied`. Pin the vocabulary and confirm the fallback at the round-trip; whether to map an unknown daemon state to a reserved `unknown` `TaskState` (vs widen the enum) is a decision.
5. **`task.update` edge edits.** Whether the daemon allows editing `depends_on`/`blocks` on update (vs create-only) is unverified. If unsupported, those input fields are dropped and documented rather than silently ignored.
6. **Authored `action` scope boundary.** T301 authors a task's `action` into the node but does **not** dispatch/authorize it (T303). Confirm the team wants action authoring in T301 at all — an alternative is title/deps/state only in T301, with `action` added in T303. The recommended path authors the closed `action` shape now (so the DAG node is complete) and leaves dispatch to T303.
7. **`mx_workspace_status.tasks` slot.** Whether to also surface a task summary in `mx_workspace_status` (filling the T108 slot) is deferred here. Recommendation: keep it a Non-Goal — a dedicated `mx_list_tasks` is the cleaner surface — and revisit only if a "one-call workspace snapshot" need emerges.
8. **Idempotency on update.** A retried `mx_update_task` with the same key is deduped by the daemon, but the *semantics* of replaying a state transition (idempotent toward the target state) depend on daemon behavior; verify at the round-trip.

## Implementation Checklist

1. **Descriptors.** Add `create-task.ts`, `update-task.ts`, `list-tasks.ts` under `packages/registry/src/descriptors/` via `defineDescriptor()` (draft-07 schemas, `async_semantics: 'sync'`, `idempotency_key` on the two mutators, the closed `action` sub-schema on create, `view` default `graph` on list). No credential-shaped property names.
2. **Task projection.** Add `packages/registry/src/handlers/task-projection.ts` — `TaskNode`/`TaskEdge`/`TaskState` types, `projectTaskNode`/`projectTaskEdge` (total, allowlist-by-construction), and `mapTaskState` (the daemon→model state table + safe fallback), reusing `normaliseToken`.
3. **Handlers.** Add `mxCreateTask` / `mxUpdateTask` / `mxListTasks` under `packages/registry/src/handlers/` — `RoomScopedDeps`; mutators fail-fast on missing room + attach idempotency + populate `audit_ref` via `extractAuditRef`; list best-effort room + `EMPTY_AUDIT_REF` + tolerated `task.graph`. Localise the `task.*` method/param consts. Never throw; `faultToResult` on every daemon/transport fault.
4. **Assemble + secure.** Export the descriptors in `descriptors/index.ts`; introduce `CANONICAL_TOOLS` (9 + 3) and repoint `loadRegistry()`'s default; barrel-export handlers/types/projectors in `handlers/index.ts`; extend `MODEL_FACING_ALLOWLIST` to 12.
5. **MCP wiring.** Add three `roomScopedDeps` entries to `packages/mcp/src/dispatch.ts` `DISPATCH`.
6. **Pi wiring.** Add the same three entries to `packages/pi/src/dispatch.ts` `DISPATCH`.
7. **Tests.** Add the descriptor, handler, projection, security, and AC tests listed above; update the registry/security regression counts (12) and any binding `tools/list`/tool-count assertions.
8. **Conformance (staged).** Add a `task.*` round-trip arm behind `MXL_CONFORMANCE_TWO_DAEMON=1` (skip-clean locally, fail-not-skip in CI), pinning the localised consts + state vocabulary + `audit_ref` availability.
9. **Docs.** Update `docs/backlog.md` (T301 status), `docs/mx-agent-tool-fabric-design.md` (§2/§7/§8/§10), `docs/mx-agent-surface-v0.2.1.md` (flip `task.*` once verified), and `docs/runtime-integration.md` + any verb-list drift guard (now 12).
10. **Verify.** `pnpm -r typecheck && pnpm -r test` green; the registry stays zero-runtime-toolbelt-dep; the no-authority + secret-free invariants hold over the 12-verb set; the three task verbs surface through MCP, Claude, and Pi from the one descriptor set.
