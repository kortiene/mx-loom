# T302 · `task.watch` resumption — reconstruct a cognitive session from durable task state after restart

> GitHub issue #31 — `area/toolbelt` `priority/P0` `type/feature` · Estimate **L** · Milestone **M3 — Coordination depth** · Source `docs/backlog.md` (`T302`).
> Blocked-by **#30 (T301** — the task-DAG verbs `mx_create_task` / `mx_update_task` / `mx_list_tasks`; **landed)** and **#5 (T005** — the session model + `agent.register`; **landed)**.
> Sibling/forward: unblocks **T304** (the M3-exit multi-agent restart test) and is the resumption half of **T303** (signed task-action dispatch).

## Problem Statement

The design draws the **crash-recovery boundary** at the task DAG (design §7, "Task state"): *ephemeral cognition state* (scratchpad, conversation, retrieved knowledge) stays runtime-private and is **lost** when a runtime dies; *durable coordination state* — the signed `com.mxagent.task.v1` plan of record (`proposed→pending→assigned→executing→succeeded/failed`, with `depends_on`/`blocks` and a signed `action`) — survives on the substrate. The promised property: **"a runtime can die and a new one resumes from task state."**

As of M3's first deliverable (T301), cognition can *author and read* that DAG through `mx_create_task` / `mx_update_task` / `mx_list_tasks`. The session model (T005) can register an agent, heartbeat liveness, and thread a stable `correlation_id`. But there is **no resumption path**: when a runtime process is killed and restarted, nothing in mx-loom

1. re-establishes the agent's session against the daemon (re-`agent.register`, same workspace, continuous correlation), nor
2. reconstructs the *plan view* the restarted cognition needs to pick up where the dead one left off (which tasks are done / in-flight / blocked, and what the DAG looks like), nor
3. subscribes to the **task stream** so a long-lived resumed session stays in sync with substrate task-state changes rather than re-polling blindly.

T302 closes that gap at the **toolbelt/session layer** (hence `area/toolbelt`, not `area/registry`). The acceptance criterion is narrow and concrete: **a killed-and-restarted runtime resumes the plan from task state.** The full *multi-agent* kill-mid-plan-and-resume gate is the M3-exit test **T304**; T302 delivers the resumption mechanism T304 exercises.

A load-bearing honesty point up front: **`task.watch` is not a verified v0.2.1 surface.** It appears in the design (`mx_await_result` maps to `invocation.get` / `task.watch`; the M3 row names "`task.watch` resumption (T302)") and the T103 handler doc anticipates it ("`task.watch` (push-based) replaces the poll backend in T302/M3 without changing this tool contract"), but it is **absent from `docs/mx-agent-surface-v0.2.1.md`** — neither verified (T001) nor even "flags confirmed." Only `task.create/update/list/graph` are flag-confirmed (round-trip staged). So T302 must satisfy its AC on the **already-landed poll surface (`task.list`)** and treat the `task.watch` push subscription as an **authored-against-design, gated-until-verified** enhancement — exactly the pattern every M1–M3 wire-shape decision in this repo already follows.

## Goals

- **Session resumption (the AC core).** Add a toolbelt entry point — `resumeSession(descriptor, options)` (or `openSession({ resume })`) — that, given a **non-secret** session descriptor persisted by the prior process, re-establishes the agent's session: an **idempotent re-`agent.register`** (the verified upsert the T005 heartbeat already relies on), into the **same room**, reusing the **persisted `correlation_id`** so audit correlates pre/post-restart, and returns a live `MxSession`.
- **Plan reconstruction.** Read the durable task DAG for the resumed room via the existing `task.list` read and assemble a **`PlanSnapshot`** (the task nodes + derived edges + a resumption *cursor*) plus a **reconciliation classification** (done / in-flight / blocked / ready) that a restarted cognition consumes to decide what to do next — satisfying "resumes the plan from task state."
- **Task-stream subscription ("subscribe to the task stream").** Add a toolbelt `watchTasks(...)` / `TaskWatcher` primitive that subscribes to substrate task-state changes and emits projected, non-secret task deltas — with a **poll fallback** (bounded re-`task.list` on an interval and on stream gap) so the deliverable works **even when `task.watch` is unverified/unavailable**, and the `task.watch` push backend is a one-const swap once pinned.
- **Continuity without re-dispatch.** Resumption must **re-read** state and hand it to cognition; it must **never re-dispatch** a task's `action` (that is T303) and must not double-execute in-flight work. The cursor/`state_rev` carried in the descriptor lets the resumed session distinguish "already observed" from "new."
- **Preserve every contract.** No new secret crosses Boundary A: the persisted descriptor and the watch stream carry **only non-secret coordination handles** (`agent_id`, `room`, `correlation_id`, `kind`, a task cursor) and projected `TaskNode`s; the credential guard and inbound redaction stay in force on every call; `audit_ref` is surfaced where the daemon returns it; nothing is logged or persisted that is secret-shaped.
- **Keep the toolbelt registry-free.** The toolbelt is the base layer (`@mx-loom/registry` depends on it *type-only*). T302 must not introduce a runtime `toolbelt → registry` dependency; the model-facing `TaskNode` projection stays in the registry and continues to reach cognition through the landed `mx_list_tasks` verb (see Open Question #3 for the recommended split).

## Non-Goals

- **The multi-agent restart e2e gate.** "A plan executes across ≥2 agents; kill+restart a runtime mid-plan; verify resume" is **T304** (the M3 exit). T302 adds the resumption mechanism and a **staged** single-flow conformance arm; the cross-agent restart scenario is T304.
- **Dispatching / executing a task `action`.** Running an authored node action through the authorize pipeline (sig → trust → policy → approval → sandbox) is **T303**. T302 reads action *state*; it never executes one.
- **Recovering runtime-private memory.** Per design §7 and §9 ("Don't unify memory across runtimes"), the dead runtime's scratchpad / conversation / retrieved knowledge is **gone** and is **not** mx-loom's to restore. T302 restores the *coordination* plan; the restarted cognition re-derives its private memory by reading that plan. The spec must not imply private-memory recovery.
- **A new model-facing tool descriptor.** Resumption is **session lifecycle**, like `openSession` (T005) — not a model-callable `mx_*` authority verb. The model still *reads* the plan via the landed `mx_list_tasks`. (Whether to also surface a "resume summary" through `mx_workspace_status.tasks` is an Open Question, not a deliverable.)
- **Persisting the descriptor for the runtime.** *Where* the prior process writes its non-secret descriptor (disk, the mx-agency app store, an env handle) is the **host's** responsibility; mx-loom defines the descriptor shape, validates it is non-secret, and accepts it as input to `resumeSession`. (See OQ #5.)
- **Streaming live tool/exec output into the model.** Avoided in v1 (design §9). The watch stream carries **task-state deltas**, not `StreamChunk` output.
- **Any authority surface or daemon fork.** No `trust.*` / `approval.decide` / `policy.*` / `auth.*` / `device.*` / `daemon.*`. mx-loom consumes the existing task RPCs across Boundary B; it never re-implements task storage.

## Relevant Repository Context

**The repo is a TypeScript pnpm monorepo (Node ≥20.19, vitest, Apache-2.0).** It is **no longer docs-only**: M0–M2 and M3's T301 have landed. The packages T302 touches **exist and are implemented**.

**Owning package — `@mx-loom/toolbelt` (`packages/toolbelt`).** The base transport + session layer. Key existing modules T302 builds on:
- `src/session.ts` — `openSession()` / `MxSession` (T005). Registers via `agent.register` once, captures the returned `AgentState` (it already exposes `agentState` with `state_rev` / `last_seen_ts`, annotated *"for T302/T501"*), keeps liveness via an idempotent re-register heartbeat, threads a session-stable `correlationId`, and exposes `call(method, params, options)` as the single outbound chokepoint. The heartbeat's default tick is **already** an idempotent re-`agent.register` (`REGISTER_METHOD`) — the exact mechanism resumption re-uses. `MxSessionOptions` already accepts a pre-supplied `correlationId` and a `room`.
- `src/agent-state.ts` — `AgentState` (incl. `last_seen_ts`, `state_rev` — *"implies `agent.register` is an idempotent upsert"*) and `AgentLiveness`. These are typed views over existing daemon payloads, not a protocol change.
- `src/client.ts` / `src/transport.ts` — `MxClient` / `createClient` (T004): IPC-primary, CLI-fallback, `MxTransport.call`, the hoisted `assertNoCredentialShapedArgs` outbound guard + inbound `redactSecrets` (T008) on every call.
- `src/ipc/framing.ts` / `src/ipc/client.ts` — the framed JSON-RPC codec (4-byte big-endian length prefix + JSON, request/response **id correlation**, per-call timeouts). **Today this is strictly request/response** — there is no server-initiated-frame / notification path. A *true push* `task.watch` would need one; a *long-poll* `task.watch` (or the poll fallback) would not. See OQ #2.
- `src/correlation.ts`, `src/heartbeat.ts`, `src/retry.ts` — the correlation-id helpers, the cancellable heartbeat scheduler (a clean injected-`schedule` testing seam T302's watcher mirrors), and the retry/backoff with injected `sleep`/`random` (the determinism precedent).
- `src/index.ts` — the package's public exports (where new resumption/watch surface is exported).
- `src/cli/env.ts` — `safeSubprocessEnv` deny-by-default allowlist (the secret boundary on the CLI transport).

**`@mx-loom/registry` (`packages/registry`) — the durable read it composes with.** T301 landed:
- `src/handlers/list-tasks.ts` — `mxListTasks(input, deps)` over `task.list` (+ `task.graph` for `view:'graph'`), returning `ok({ tasks, edges }, EMPTY_AUDIT_REF)`. The localized wire consts `TASK_LIST_METHOD = 'task.list'`, `TASK_GRAPH_METHOD = 'task.graph'` live here.
- `src/handlers/task-projection.ts` — the pure, total, **never-throws** projectors `projectTaskNode`, `projectTaskEdge`, `deriveEdges`, `mergeEdges`, the `TaskNode` / `TaskEdge` / `TaskAction` / `TaskState` types, and the `mapTaskState` table (daemon vocabulary + synonyms → stable `TaskState`, with an output-only `unknown` safe fallback). **Allowlist-by-construction** — copies only named non-secret fields; the action's credential-shaped args are rejected at *dispatch* (T303 / the toolbelt guard), never here.
- `src/handlers/deps.ts` — the injected `DaemonCall` / `HandlerDeps` / `RoomScopedDeps` seam (a handler imports `MxTransport` **type-only**, keeping the registry's zero runtime toolbelt dependency).
- `src/envelope.ts` / `src/errors.ts` — the T102 `ToolResult` + the closed nine-code taxonomy + `ok`/`errored`/`faultToResult`.

**Verified daemon surface (`docs/mx-agent-surface-v0.2.1.md`).**
- `task.create/update/list/graph` — **"◻️ flags confirmed · round-trip staged"** (`task create --room --title [--tool --arg/--input-json --exec --depends-on --blocks --assign --state]`). The JSON-RPC param names, the **task-id field name**, the exact state vocabulary, the `task.graph` reply shape, and `audit_ref` availability are pending the two-daemon round-trip (`MXL_CONFORMANCE_TWO_DAEMON=1`).
- `agent.register` — **verified** (T001/T005); returns a full `AgentState` with a monotonic `state_rev` (an idempotent upsert).
- **`task.watch` — NOT listed.** Neither verified nor flag-confirmed. T302 must not assume it exists; build the AC on `task.list` and gate `task.watch` behind the conformance fixture. The runtime-integration guide (`docs/runtime-integration.md:583`) already flags *"Durable `task.watch` resumption across a host crash — M3 (T302). Today …"* as future.

**Conventions every toolbelt/handler module follows** (T302 must match):
- **Never throw across the public surface; map faults onto the closed taxonomy.** Handlers/normalizers are total; transport faults become `faultToResult(...)` / a builder, never a leaked `TransportError`.
- **Room from the session, never model input.** A Matrix room id is a coordination-plane detail; the model must never name one.
- **Wire shapes the round-trip hasn't pinned live live in localized `const`s** (the `delegate-tool.ts` / `cancel.ts` / `list-tasks.ts` precedent), so the conformance fixture corrects them in one place; a new/unknown daemon token degrades to a safe fallback (`unknown` state / `internal` code), never a fabricated specific value.
- **Gated-but-defaulted lifecycle decisions** carry a one-line swap (the T005 `heartbeatMethod` / `deregisterMethod` / `correlationParamMethods` precedent).
- **Injected clock/schedule seams** (`now`/`sleep`/`schedule`) keep timing deterministic under test.

## Proposed Implementation

T302 adds three cooperating pieces in `@mx-loom/toolbelt`, plus a small, non-secret durable read it composes with the landed `mx_list_tasks`. **No `packages/*/src` change is required outside the toolbelt for the AC** (the model continues to read the plan through the registry's `mx_list_tasks`); the registry/bindings gain only the staged conformance arm.

### 1. `SessionDescriptor` — the non-secret resume handle (`src/session-descriptor.ts`, new)

A small, **non-secret** record the prior process persists and hands back on restart. It is the *only* thing that crosses the restart boundary, and it is allowlist-by-construction:

```ts
export interface SessionDescriptor {
  /** The agent identity to resume against (daemon-assigned at first register). */
  readonly agent_id: string;
  /** The workspace/room the plan is scoped to — the resumption key (see OQ #4). */
  readonly room: string;
  /** Reused so audit correlates across the restart (design §7). */
  readonly correlation_id: string;
  /** Agent kind, replayed into re-register so the upsert is faithful. */
  readonly kind?: string;
  /** The last task-state cursor the prior process observed (state_rev / opaque token; OQ #6). */
  readonly cursor?: TaskCursor;
  /** Descriptor schema version, for forward-compat. */
  readonly v: 1;
}
```

- `serializeSessionDescriptor` / `parseSessionDescriptor` — JSON (de)serialization that **rejects any credential-shaped field** by routing the object through the toolbelt guard (`assertNoCredentialShapedArgs`) on both write and read, so a malformed/poisoned descriptor can never smuggle a token across the boundary. Parsing a descriptor with an unexpected `v` fails closed.
- The descriptor carries **no** Matrix token, Ed25519 key, device secret, provider key, or `GH_TOKEN` — those stay daemon-held. (The `AgentState` fields `signing_public_key` / `signing_key_id` are public; even so, the descriptor deliberately stores **only** `agent_id` — identity continuity is the daemon's job at re-register, not the descriptor's.)

### 2. `resumeSession()` — re-establish the session (`src/resume.ts`, new; small `session.ts` touch)

```ts
export async function resumeSession(
  descriptor: SessionDescriptor,
  options?: ResumeOptions,
): Promise<ResumedSession>;

export interface ResumedSession {
  readonly session: MxSession;   // re-registered, same room + correlation
  readonly plan: PlanSnapshot;   // the reconstructed durable plan view
  readonly resumed: boolean;     // true when an existing agent_id was matched (OQ #4)
}
```

Algorithm:
1. **Validate** the descriptor (non-secret guard, schema version).
2. **Re-register** by opening a session with the **persisted** `room`, `correlationId`, and `kind` — i.e. `openSession({ room, correlationId: descriptor.correlation_id, kind: descriptor.kind, ...clientOptions })`. Re-`agent.register` is the **idempotent upsert** (the heartbeat already relies on this); `state_rev` advances, no duplicate agent appears in `agent.list` (the idempotency property, design §7). Continuity of `agent_id` across restart is **best-effort and gated** (OQ #4): if the daemon re-issues the *same* id for the same `(room, kind, signing identity)`, `resumed: true`; otherwise the plan is recovered **room-keyed** and `resumed: false` is surfaced honestly.
3. **Reconstruct the plan** (piece #3 below) for `descriptor.room`, returning a `PlanSnapshot`.
4. Return the live `MxSession` + the snapshot. The restarted cognition then proceeds: it reads the snapshot, optionally re-lists via `mx_list_tasks`, and continues the plan.

A failed re-register rejects with the underlying `TransportError` and leaves **no** half-open session (the `openSession` "no zombie session" guarantee is inherited). `resumeSession` is otherwise total at the *plan* layer — a `task.list` fault yields an **empty-but-valid** `PlanSnapshot` carrying the fault code, never a throw, so a restarted runtime degrades to "no plan recovered" rather than crashing again.

### 3. Plan reconstruction — `PlanSnapshot` + reconciliation (`src/plan-snapshot.ts`, new)

A `PlanSnapshot` is the durable plan view a restarted cognition consumes:

```ts
export interface PlanSnapshot {
  readonly room: string;
  readonly tasks: ReadonlyArray<ResumedTask>;  // non-secret task view (OQ #3)
  readonly edges: ReadonlyArray<{ from: string; to: string; kind: 'depends_on' | 'blocks' }>;
  readonly reconciliation: PlanReconciliation;
  readonly cursor: TaskCursor;                 // advance/persist for the next restart
  readonly fault?: ErrorCode;                  // set iff the durable read faulted
}

export interface PlanReconciliation {
  readonly done: string[];        // succeeded/failed — terminal, nothing to do
  readonly inFlight: string[];    // executing/assigned — observe, DO NOT re-dispatch (T303)
  readonly ready: string[];       // pending with deps satisfied — candidates to act on
  readonly blocked: string[];     // pending with unmet depends_on
}
```

- The reconciliation is a **pure** classification over the snapshot's tasks + edges, computed from `TaskState` + `depends_on` satisfaction. It tells cognition *where the dead runtime left off* without prescribing action.
- The **non-re-dispatch invariant** lives here in documentation and in T304's assertion: `inFlight` tasks are **read**, not restarted. Delegated/exec work runs on the *remote/receiving* daemon and is durable on the substrate independent of the requester's liveness (OQ #7), so resumption observes its eventual terminal state; it never re-issues the signed action (that is T303, and any re-dispatch there reuses the original `idempotency_key` to dedupe).

**Where the projection lives (OQ #3, recommended split):** keep the model-facing `TaskNode` projection in the registry. The toolbelt's `ResumedTask` is a **thin, locally-owned, non-secret** shape (`task_id`, `state`, `assignee`, `depends_on`, `blocks`) read directly from the `task.list` reply by a small toolbelt normalizer — so the toolbelt stays **registry-free** (no runtime `toolbelt → registry` dependency, preserving the layering). The richer model-facing `TaskNode` view still reaches cognition through the landed `mx_list_tasks` verb when the model lists the plan. (Alternative considered: lift the projection into a new shared leaf package; rejected as over-engineering for one thin shape — flagged in Open Questions.)

### 4. `watchTasks()` / `TaskWatcher` — subscribe to the task stream (`src/task-watch.ts`, new)

```ts
export interface TaskWatcher {
  /** Async iterator (or callback) of non-secret task-state deltas since the cursor. */
  [Symbol.asyncIterator](): AsyncIterator<TaskDelta>;
  /** Current resumption cursor — persist into the SessionDescriptor. */
  readonly cursor: TaskCursor;
  stop(): void;
}

export function watchTasks(session: MxSession, options?: WatchOptions): TaskWatcher;
```

- **Backend, gated.** The default backend is the **poll fallback**: a bounded re-`task.list` on an interval (mirroring the T005 heartbeat scheduler + the T103 poll-interval clamp — floor to avoid busy-wait, cap to avoid hammering the daemon), diffing against the cursor/`state_rev` to emit only **new** deltas. When the `task.watch` push RPC is verified, it becomes the primary backend with the poll as the gap/recovery fallback — a one-const swap (`TASK_WATCH_METHOD`, localized) exactly like every staged wire shape in the repo.
- **Stream-gap recovery.** On a dropped/erroring stream, the watcher falls back to a **full re-`task.list` reconcile** and resumes from the cursor — no lost-update, idempotent re-delivery deduped by `state_rev`.
- **Secret-free deltas.** Each `TaskDelta` carries a projected, non-secret task view (the same allowlist-by-construction discipline as `ResumedTask`); the watch call rides `session.call` → `MxClient`, so the env allowlist + `assertNoCredentialShapedArgs` + `redactSecrets` stay in force unmodified.
- **Lifecycle.** `watchTasks` is **toolbelt lifecycle**, not a model tool — like the heartbeat, it runs under the session and is never surfaced as an `mx_*` verb. (It may keep the model's subsequent `mx_list_tasks` results fresher, but it adds no model-callable surface.)

### 5. Optional alignment: `task.watch` as the `mx_await_result` push backend

The T103 doc anticipates *"`task.watch` (push-based) replaces the poll backend in T302/M3 without changing this tool contract."* If — and only if — `task.watch` is verified, T302 may let `mx_await_result` consume the same watch transport as a push backend behind the existing `invocation.get` contract (no change to the `mx_await_result` tool surface, the envelope, or the `wait_ms` semantics). This is **optional and gated**; the AC does not require it, and it must not regress the landed T103 behavior (a `wait_ms` expiry still returns the pending envelope, never `errored('timeout')`).

## Affected Files / Packages / Modules

**`@mx-loom/toolbelt` (`packages/toolbelt`) — owner, net-new:**
- `src/session-descriptor.ts` *(new)* — `SessionDescriptor`, `TaskCursor`, serialize/parse with the non-secret guard.
- `src/resume.ts` *(new)* — `resumeSession`, `ResumeOptions`, `ResumedSession`.
- `src/plan-snapshot.ts` *(new)* — `PlanSnapshot`, `PlanReconciliation`, `ResumedTask`, the thin non-secret task normalizer + the pure reconciliation classifier.
- `src/task-watch.ts` *(new)* — `watchTasks`, `TaskWatcher`, `TaskDelta`, `WatchOptions`, localized `TASK_LIST_METHOD` / `TASK_WATCH_METHOD` consts, poll backend + push backend (gated) + gap recovery.
- `src/session.ts` *(touch)* — surface what resume needs (already exposes `agentState` with `state_rev`/`last_seen_ts`; possibly a small `resume`-aware option or a `describe(): SessionDescriptor` helper to mint a descriptor from a live session).
- `src/index.ts` *(touch)* — export the new public surface.
- *Possibly* `src/ipc/framing.ts` / `src/ipc/client.ts` / `src/transport.ts` *(touch, gated)* — **only if** the verified `task.watch` is a true server-push (server-initiated frames / notifications); a long-poll or the poll fallback needs **no** framing change. Decide at OQ #2.

**`@mx-loom/registry` (`packages/registry`) — read only / reference:**
- `src/handlers/list-tasks.ts`, `src/handlers/task-projection.ts` — reused as the model-facing read backend (unchanged); referenced for the wire-const spellings and the `TaskState` vocabulary the toolbelt normalizer must agree with.

**`@mx-loom/golden` (`packages/golden`) — staged conformance:**
- `test/*` *(new, gated)* — a staged single-flow `task.watch`/resume conformance arm behind `MXL_CONFORMANCE_TWO_DAEMON=1`. The **multi-agent** kill+restart gate is **T304** (it extends the golden harness), not T302.

**Docs:** `docs/mx-agent-surface-v0.2.1.md` (add a `task.watch` row + pin task-id/cursor once verified), `docs/mx-agent-tool-fabric-design.md` (§7 — resumption now implemented at the toolbelt layer; the §4.3 `task.watch` note), `docs/runtime-integration.md` (line ~583 future → present once landed), `docs/backlog.md` (T302 status).

## API / Interface Changes

**New public toolbelt API (documented):**
- `resumeSession(descriptor, options?) → Promise<ResumedSession>` — re-establish a session + reconstruct the plan.
- `watchTasks(session, options?) → TaskWatcher` — subscribe to the task stream (poll fallback default; `task.watch` push gated).
- Types: `SessionDescriptor`, `TaskCursor`, `ResumeOptions`, `ResumedSession`, `PlanSnapshot`, `PlanReconciliation`, `ResumedTask`, `TaskWatcher`, `TaskDelta`, `WatchOptions`.
- Likely a `MxSession.describe(): SessionDescriptor` helper to mint a non-secret descriptor from a live session (so the host can persist it before a planned shutdown).

**No model-facing tool-descriptor change.** No new `mx_*` verb; the canonical set stays at **12** (T301). The model reads the plan through the landed `mx_list_tasks`. Resumption and watching are **session lifecycle**, mirroring `openSession`/heartbeat (T005), not authority surface.

**Daemon-RPC surface consumed (not changed):** `agent.register` (verified), `task.list` (flag-confirmed), and — **gated/optional** — `task.watch` (unverified; localized const, behind `MXL_CONFORMANCE_TWO_DAEMON=1`). mx-loom defines no new daemon method and forks no daemon-side storage.

## Data Model / Protocol Changes

- **Result envelope (T102): unchanged.** Durable reads remain local-read shaped (`EMPTY_AUDIT_REF`); the re-register mutation surfaces `audit_ref` where the daemon returns it. No new status or error code — faults reuse the closed nine-code taxonomy (a `task.list` fault → `faultToResult`; `not_found` for an unknown room/task).
- **New non-secret serialization shapes** (toolbelt-owned, not on the model tool surface): `SessionDescriptor` (the persisted resume handle) and `TaskCursor` (an opaque/`state_rev`-based resumption token). Both are validated non-secret on (de)serialization.
- **`TaskDelta`** — a non-secret task-state-change event for the watch stream (projected task view + the new cursor). Carries no credentials by construction.
- **Idempotency:** resumption performs **no mutating dispatch**, so it needs no `idempotency_key`. Re-`agent.register` is naturally idempotent (an upsert keyed on identity; `state_rev` advances). The non-re-dispatch invariant means T302 cannot double-execute; any future re-dispatch (T303) reuses the original key.
- **Wire shapes pending the round-trip** (localized consts, gated `MXL_CONFORMANCE_TWO_DAEMON=1`): the `task.list` param/reply shape and **task-id field name** (shared with T301), the `task.watch` method/param name and whether it is **push vs long-poll**, the **cursor token** (an explicit `state_rev` / a `since` timestamp / an opaque continuation), and whether `task.list` already carries the `depends_on`/`blocks` needed for reconciliation (it does per T301's derivation). A new/unknown token degrades to the safe fallback, never a fabricated value.

## Security & Compliance Considerations

- **Secret boundary (Boundary A) — the load-bearing constraint.** The persisted `SessionDescriptor`, the `PlanSnapshot`, every `TaskDelta`, and `ResumedTask` carry **only non-secret coordination handles** (`agent_id`, `room`, `correlation_id`, `kind`, a task cursor) and projected task fields. **Matrix tokens, Ed25519 signing keys, device secrets, provider keys, and `GH_TOKEN` never appear** — they stay daemon-held and never cross into the runtime/model/persistence. (De)serialization routes the descriptor through the toolbelt's `assertNoCredentialShapedArgs` so a credential-shaped field is **rejected as `invalid_args`** on both write and read; the watch/list calls ride `MxClient`, so the deny-by-default env allowlist + outbound credential guard + inbound `redactSecrets` (T008) stay in force unmodified.
- **Out-of-process enforcement is unchanged.** Re-registration and reads only **observe** durable state; the receiving daemon still owns Ed25519 trust, the deny-by-default `policy.toml`, the sandbox, and human approval gates. Resumption grants the runtime **no** authority — cognition still only ever produces a signed request, and re-reading a plan cannot escalate. A resumed session is exactly as privileged as a fresh one: bounded by the union of the reachable agents' policies.
- **No re-dispatch of authored actions.** A node's signed `action` is **read, not executed** (T303 dispatches, re-validating against live policy at release). This prevents a restart from silently re-running a high-risk operation, and prevents an approval that was *denied/expired* before the crash from being smuggled through on resume — the daemon re-runs the authorize pipeline at any actual release, and T302 never releases.
- **The model is never given trust/policy/approval mutation tools.** T302 adds **no** model-facing surface at all; resumption is lifecycle. Approval still reaches the model only as the `awaiting_approval` *status* on a deferred result, re-validated at release — unchanged by T302.
- **`task.action.args` redaction defense-in-depth.** The reconciliation surfaces an action's *existence/state*, never executes it; a credential-shaped value inside `action.args` is rejected at dispatch (T303 / the toolbelt guard) and scrubbed by inbound `redactSecrets` — the projection copies only named non-secret fields (allowlist-by-construction).
- **Audit correlation.** Reusing the persisted `correlation_id` makes the audit trail **span the restart** (pre-crash and post-resume actions correlate on one id). `audit_ref` is surfaced on results where the daemon returns it. Substrate Matrix events remain the tamper-evident truth; the Postgres mirror (T113) indexes them.
- **Logging/redaction.** The redaction-safe `debug` sink discipline from `session.ts` extends to resume/watch: log **only** `agent_id`, `room`, `correlation_id`, lifecycle/watch state, an error `code`, the method name, and the cursor's *shape* — **never** params, `AgentState` key material, tokens, raw task payloads, or the descriptor's contents beyond non-secret ids. Never persist a secret to the descriptor file.
- **Split-brain / descriptor theft (flagged).** If two processes resume the same descriptor concurrently, two sessions register for one agent (operator concern, OQ #4). A leaked descriptor grants **no authority** (it carries no credential and the daemon re-validates every request), but it does reveal non-secret coordination metadata; treat the descriptor as non-secret-but-not-public and let the host store it with ordinary file permissions.

## Testing Plan

**Unit (daemon-free, `packages/toolbelt/test/`):**
- `resume.test.ts` — `resumeSession` re-registers via the idempotent upsert against a fake `MxClient`; reuses the persisted `correlation_id` and `room`; returns a live `MxSession`; a re-register fault rejects cleanly with no zombie session; `resumed` reflects agent-id continuity vs room-keyed recovery.
- `plan-snapshot.test.ts` — reconstruction from a fake `task.list` reply (bare array + wrapped shapes); the pure reconciliation classifier partitions done/in-flight/ready/blocked correctly over `depends_on` satisfaction; a `task.list` fault yields an empty-but-valid snapshot carrying the fault code (never throws).
- `session-descriptor.test.ts` — round-trip serialize/parse; **rejects credential-shaped fields** (a `*_token` / `sk-ant-` / PEM value in the descriptor → `invalid_args`); unknown `v` fails closed.
- `task-watch.test.ts` — the poll backend emits only **new** deltas (cursor/`state_rev` dedup) on an injected schedule; stream-gap recovery falls back to a full re-list and resumes from the cursor; `stop()` halts cleanly; never busy-waits (interval floor) and never hammers (interval cap); never throws to the consumer.

**Integration (single daemon, gated `MXL_CONFORMANCE=1`):**
- Open a session, author tasks with deps (`task.create`), simulate a kill (drop the session/process), `resumeSession(descriptor)` → assert the `PlanSnapshot` matches the durable DAG and the reconciliation is correct; assert a single (not duplicated) agent in `agent.list` after re-register.

**Conformance / e2e (two-daemon, gated `MXL_CONFORMANCE_TWO_DAEMON=1`):**
- A **staged** single-flow resume arm pinning the `task.list` resumption shape + (when verified) the `task.watch` method/param/push-vs-poll and the cursor token. **The multi-agent kill-mid-plan-and-resume gate is T304** (the M3 exit), which builds on this mechanism. Skip-clean without the fixture; **fail-not-skip** when demanded but the fixture/daemon is missing (the repo's standard).

**Secret-boundary / redaction:**
- Assert no token/key appears in the persisted descriptor, the `PlanSnapshot`, any `TaskDelta`, or any `debug` line; seed a credential-shaped task-`action.args` value and assert it is rejected at dispatch / redacted inbound and never surfaced by reconciliation.

**Idempotency / non-re-dispatch:**
- Resume does **not** call any `*.start` / dispatch RPC (assert via the fake client's call log); re-register is idempotent (no duplicate agent; `state_rev` advances).

**Documentation tests:** a drift guard (the `runtime-guide.test.ts` precedent) pinning the resume recipe in `docs/runtime-integration.md` against the exported toolbelt surface, so the doc cannot drift from the API.

## Documentation Updates

- **`docs/mx-agent-tool-fabric-design.md`** — §7 ("Sessions" / "Task state"): record that crash-recovery resumption is now implemented at the toolbelt layer (`resumeSession` + the task-stream subscription), reconstructing the *plan* (not private memory). §4.3: update the `mx_await_result` `task.watch` note to reflect the (gated) push-backend alignment if delivered. §2 table: the `mx_await_result | invocation.get / task.watch` mapping now has a concrete (gated) `task.watch` consumer.
- **`docs/mx-agent-surface-v0.2.1.md`** — add a `task.watch` row to the "round-trip pending" table (status: unverified / authored-against-design; pin method/param, push-vs-long-poll, and the cursor token once the fixture runs). Pin the shared **task-id field name** + the `task.list` resumption reply once verified.
- **`docs/runtime-integration.md`** — promote the "Durable `task.watch` resumption … M3 (T302). Today …" future note (line ~583) to a present "Resuming after a crash" recipe once landed; cross-link the gated arm flag.
- **`docs/backlog.md`** — T302 status line (mechanism landed; the multi-agent gate staged for T304; the `task.watch` push backend gated).
- **`docs/`** (sibling T305) — the cognition-vs-coordination state guide will reference this as the concrete "what survives a restart" example; T305 is its own issue, not T302.
- Package READMEs (`packages/toolbelt/README.md`) — document `resumeSession` / `watchTasks` and the non-secret descriptor contract.

## Risks and Open Questions

1. **`task.watch` is unverified on v0.2.1** (absent from the surface doc). **Decision (recommended):** satisfy the AC on the landed poll surface (`task.list`) and ship `task.watch` push as a gated, one-const enhancement; confirm whether `task.watch` exists at all, and whether it is **server-push** or **long-poll**. *Confirm before relying on it.*
2. **IPC framing for a true push.** The current codec is strictly request/response (id-correlated). A server-push `task.watch` needs a server-initiated-frame / notification path in `ipc/framing.ts` + `ipc/client.ts`; a long-poll or the poll fallback does **not**. **Decision:** default to the no-framing-change poll fallback; add push framing only if/when `task.watch` is verified as push. *Confirm the daemon's subscription model over the Unix socket.*
3. **Layering — keep the toolbelt registry-free.** The registry depends on the toolbelt *type-only*; a runtime `toolbelt → registry` dependency would invert the layering. **Recommended:** the toolbelt owns a thin non-secret `ResumedTask`/reconciliation shape and reads `task.list` directly; the richer model-facing `TaskNode` projection stays in the registry and reaches cognition via the landed `mx_list_tasks`. *Confirm this split vs. a new shared leaf package.*
4. **Agent-id continuity across restart.** Is `agent.register` idempotent to the **same `agent_id`** for the same `(room, kind, signing identity)`, or does it mint a fresh id each call? If fresh, "resume the same session" is best done **room-keyed** (the plan/DAG is room-scoped), with `agent_id` continuity surfaced as best-effort (`resumed` flag). *Confirm the re-register identity semantics on v0.2.1 (this is a T001-class daemon fact).*
5. **Who persists the descriptor, and where.** mx-loom defines + validates the non-secret `SessionDescriptor` and accepts it as input; **where** the prior process writes it (disk / the mx-agency app store / an env handle) is the host's responsibility. *Confirm the persistence contract with the mx-agency app layer (`app/src/sdk`).*
6. **Cursor semantics.** Is the resumption cursor an explicit `state_rev` (monotonic, as on `AgentState`), a `since` timestamp, or an opaque daemon continuation token? This governs delta dedup and gap recovery. *Confirm at the round-trip; localize the token type meanwhile.*
7. **In-flight reconciliation.** A task left `executing` when the runtime died: does the daemon keep the delegated/exec work running on the *receiving* daemon independent of the requester's liveness (so resume merely observes its terminal state), or is it abandoned? **Assumption:** durable on the substrate → observe, never re-dispatch. *Confirm; it shapes the `inFlight` reconciliation guidance.*
8. **Model surface.** Recommended: **no** new model-facing descriptor (resumption is lifecycle; the model reads via `mx_list_tasks`). Open alternative: surface a compact "resume summary" through `mx_workspace_status.tasks` (the additive slot T108 reserved). *Confirm none is required for T304.*
9. **Correlation reuse vs. fresh.** Recommended: reuse the persisted `correlation_id` for cross-restart audit continuity. *Confirm this is the desired audit behavior (vs. minting a fresh id linked to the old).* Note `correlationParamMethods` substrate propagation stays gated off (T005 default) until daemon support is verified.

## Implementation Checklist

1. **Confirm the daemon facts (OQ #1, #2, #4, #6, #7)** against a live/pinned v0.2.1 (or stage them): does `task.watch` exist (push vs long-poll)? is re-`agent.register` same-id idempotent? what is the cursor token? is `executing` work daemon-durable across requester restart? Localize every unverified spelling in a `const`.
2. **`SessionDescriptor`** (`src/session-descriptor.ts`): the non-secret shape + `serialize`/`parse` routed through `assertNoCredentialShapedArgs`; unknown-`v` fail-closed. Add `MxSession.describe()` to mint one from a live session.
3. **`PlanSnapshot` + reconciliation** (`src/plan-snapshot.ts`): the thin non-secret task normalizer over `task.list`, the pure done/in-flight/ready/blocked classifier (over `depends_on`), and the empty-but-valid fault snapshot. Never throws.
4. **`resumeSession`** (`src/resume.ts`): validate → re-register via `openSession({ room, correlationId, kind })` (idempotent upsert) → reconstruct the plan → return `{ session, plan, resumed }`; inherit the no-zombie-session guarantee; `resumed` reflects agent-id continuity.
5. **`watchTasks` / `TaskWatcher`** (`src/task-watch.ts`): the poll-fallback backend (injected schedule, clamped interval, cursor dedup), stream-gap full-relist recovery, secret-free `TaskDelta`s, `stop()`; the `task.watch` push backend behind the localized const + framing decision (OQ #2), default off until verified.
6. **(Gated) `mx_await_result` push alignment** (OQ/§5): only if `task.watch` is verified; behind the existing T103 contract, no envelope/tool-surface change, no regression of "expiry → pending, not `timeout`."
7. **Export** the new surface from `src/index.ts`; **do not** add any `mx_*` model-facing descriptor.
8. **Tests:** the unit suite (resume / snapshot / descriptor-secret-boundary / watch), the single-daemon integration arm, the **staged** two-daemon conformance arm (`MXL_CONFORMANCE_TWO_DAEMON=1`, skip-clean / fail-not-skip), the secret-boundary/redaction + non-re-dispatch + idempotency assertions, and the doc drift guard.
9. **Verify** `pnpm -r typecheck` + `pnpm --filter @mx-loom/toolbelt build` + `test` green; the registry/bindings remain unchanged (registry-free toolbelt preserved).
10. **Docs:** update design §7/§4.3, the surface doc `task.watch` row, the runtime-integration resume recipe, the backlog T302 status, and the toolbelt README. **Hand the multi-agent kill+restart gate to T304** (it consumes this mechanism); do not claim the M3 exit here.
11. **Do not weaken the contract:** no secret in the descriptor/snapshot/stream/logs; reject credential-shaped args; observe-only (no re-dispatch); no authority surface; room from the session, never model input.
