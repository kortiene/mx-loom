# T303 · Signed Task-Action Dispatch Alignment

> GitHub issue #32 · `area/policy` `area/registry` `type/feature` `priority/P1` · Estimate **M** · Milestone **M3 — Coordination depth** · Source: `docs/backlog.md` (`T303`).
> Blocked-by **#30 / T301** (the task-DAG verbs — landed) and composes with **#31 / T302** (`task.watch` resumption — landed). Unblocks **#33 / T304** (multi-agent plan with restart — the M3 exit).

## Problem Statement

T301 gave cognition the ability to **author** a durable, shared plan: `mx_create_task` writes a `com.mxagent.task.v1` node into the workspace DAG, and that node may carry a signed **`action`** — either a named-tool call (`kind: 'tool'`) or a guarded command (`kind: 'exec'`). Today that action is *authored, never run*: `packages/registry/src/handlers/create-task.ts` deliberately writes the action into the record and stops there, and `task-projection.ts` *surfaces* the action but never executes it. The design doc is explicit about this seam — design §2: "a node's signed `action` is **authored, not dispatched** (T303 dispatches)"; §7: "running it through the authorize pipeline on dispatch is T303".

The gap: there is **no path that takes an authored task action and actually runs it**, and — critically — no guarantee that when it *is* run, it goes through the same out-of-process authorize pipeline (signature → trust store → `policy.toml` → sandbox → human approval) that every direct `mx_delegate_tool` / `mx_run_command` call already traverses. Without that guarantee, two failure modes are possible:

1. **A bypass.** A task action could be treated as *pre-authorized* simply because it was authored into the DAG — letting a plan smuggle authority that a direct delegation would never get. That violates the governing rule (design §1: "cognition can only ever produce a signed *request*; it can never grant itself authority").
2. **A shape mismatch.** The authored `TaskAction` shape (`{ kind, tool, args }` / `{ kind, command, command_args, cwd }`) and the dispatch params (`call.start` / `exec.start`) could drift, so that an action that *looks* authorable cannot actually be dispatched, or dispatches with the wrong fields.

T303 closes both: it **aligns** the authored action shape with the delegation/exec dispatch surface, and provides the dispatch path so that **a task action runs through the full authorize pipeline on dispatch** (the single acceptance criterion). The action in the DAG is a *request shape*, not a grant; dispatching it re-runs authorize from scratch on the receiving daemon.

## Goals

- **G1 — Dispatch path.** Provide a way to take a task node's authored `action` and dispatch it, such that a `kind: 'tool'` action routes through `call.start` and a `kind: 'exec'` action routes through `exec.start` — i.e., through the **identical receiver-side authorize pipeline** that `mx_delegate_tool` (T105) and `mx_run_command` (T106) already use. (Acceptance criterion.)
- **G2 — Alignment (single source of truth).** Extract one pure mapper, `actionToDispatch(action, …)`, that maps a `TaskAction` onto the `call.start` / `exec.start` params, and have **both** the create-time authoring (so what is authored is exactly what will be dispatched) and the dispatch path consume it. No second, divergent copy of the mapping.
- **G3 — No self-granted authority.** Dispatch emits a *signed request* only; it performs no trust/policy/approval/sandbox check in-process. `policy_denied` / `untrusted_key` / `approval_denied` / `awaiting_approval` are outcomes it **maps** into the T102 envelope, never decisions it makes. Authoring an action ≠ authorizing it; dispatch re-runs the full pipeline (design §1, §5, §6).
- **G4 — Deferred + approval semantics reused, not reinvented.** A dispatched action that the receiver holds for approval surfaces as `status: awaiting_approval` + a `handle`; a running action surfaces as `running`; both resolve via `mx_await_result` (T103) — the model is never given an approval-mutation tool (design §4.3, §5).
- **G5 — Idempotent dispatch.** Dispatching the same task action twice (e.g., a retry, or a runtime that restarted mid-plan per T302/T304) must not double-execute. A task-stable `idempotency_key` ties the dispatch to the task so the daemon's replay protection dedupes (design §4.4).
- **G6 — Secret boundary preserved end-to-end.** `action.args` / `command_args` are the most dangerous surface (an arg is the likeliest place to inline a credential). They are guarded at **both** authoring (T301, already) and dispatch (this work) by the toolbelt `MxClient` (`assertNoCredentialShapedArgs` outbound + `redactSecrets` inbound). The registry re-implements no guard and keeps its zero **runtime** toolbelt dependency.
- **G7 — Audit correlation.** Every dispatch result carries `audit_ref` correlating the model's dispatch action ↔ the daemon's signed invocation ↔ (when relevant) the held approval — the existing T102 / T113 plumbing, unchanged.
- **G8 — Conformance staged honestly.** Whatever new wire shape this introduces (a single-task read, and/or a daemon-side dispatch RPC) is authored against the design's named shapes with **localized wire consts**, and pinned at the two-daemon round-trip (`MXL_CONFORMANCE_TWO_DAEMON=1`) — never asserted as verified before it is.

## Non-Goals

- **A daemon-side task scheduler / auto-runner.** This work does not build (and does not assume) a daemon that watches the DAG and auto-dispatches `ready` tasks. Whether the daemon already does this is an open question (see Risks); the deliverable here is the *aligned dispatch path*, not a scheduler.
- **Plan execution / multi-agent orchestration end-to-end.** Driving a whole plan across ≥2 agents with a mid-plan restart is **T304** (the M3 exit test). T303 provides the per-action dispatch primitive T304 will compose.
- **New authority surface.** No `trust.*` / `approval.decide` / `policy.*` / `auth.*` / `device.*` / `daemon.*` tool. The forbidden-authority invariant (`security.ts`) is untouched; dispatch is a request-producing verb, not a governance verb.
- **Streaming task-action output into the model.** As with `mx_run_command` (design §9), live output streaming is out of scope; the model resolves a handle and reads the terminal result / a `tail_preview`.
- **Changing the authored `action` schema.** The flat `{ kind: 'tool' | 'exec', … }` discriminator shape (no `oneOf`/`anyOf`, per the Pi/Claude fail-closed converters) authored by T301 stays. T303 consumes it; it does not re-model it.
- **Task-state machine ownership.** The daemon owns task-state transitions (design §7). T303 may *request* a transition (e.g., to `executing`) but must not implement client-side transition legality.

## Relevant Repository Context

**Status: docs-first repo with a real, growing TypeScript workspace.** Unlike the very earliest tasks, the M1–M3 packages now exist. The stack is TypeScript (pnpm workspace, Node ≥20.19, vitest, Apache-2.0). The packages relevant to T303 **already exist**:

- **`@mx-loom/registry`** (`packages/registry`) — the canonical, transport-neutral, secret-free descriptor set + the T102 envelope + all 12 handlers. **This is the owning package for T303.** Key existing modules:
  - `src/descriptors/create-task.ts` — `MX_CREATE_TASK`, which authors the `action` (the flat `{ kind, tool, args, command, command_args, cwd }` shape, `kind` required, `additionalProperties: false`).
  - `src/handlers/create-task.ts` — `mxCreateTask`, with a **private** `buildActionParam(action)` that already maps a `TaskAction` onto the daemon's `task.create` action param (`kind: 'exec'` → `{ kind, command, args, cwd }`; `kind: 'tool'` → `{ kind, tool, args }`). **This is the mapping T303 must lift into a shared, reusable `actionToDispatch`** (G2).
  - `src/handlers/task-projection.ts` — `TaskAction` / `TaskNode` / `TaskEdge` types, `projectTaskNode` (allowlist-by-construction projector), `mapTaskState`, and `taskNodeResponseToResult`.
  - `src/handlers/delegate-tool.ts` — `mxDelegateTool`, the canonical `call.start` dispatch (resolve inner schema → validate args → dispatch → `callResponseToResult` → optional inline `wait_ms`). **The reference dispatch path for `kind: 'tool'`.**
  - `src/handlers/run-command.ts` — `mxRunCommand`, the canonical `exec.start` dispatch. **The reference dispatch path for `kind: 'exec'`.**
  - `src/handlers/invocation.ts` — `callResponseToResult` (verb-agnostic; normalizes a `CallResponse` *and* an `ExecResponse` *and* will normalize a dispatch response), `isTerminal`, `failureResult`, plus the shared readers `extractAuditRef` / `hasErrorSignal` / `failureCode`.
  - `src/handlers/deps.ts` — `HandlerDeps` / `RoomScopedDeps` / `DelegateDeps` / `ExecDeps` (the injected `DaemonCall` seam; the registry has **no runtime** toolbelt dep, importing `MxTransport` `type`-only).
  - `src/handlers/handler-fault.ts` — `EMPTY_AUDIT_REF`, `faultToResult`.
  - `src/security.ts` — `MODEL_FACING_ALLOWLIST` (currently the 12 verbs), `FORBIDDEN_AUTHORITY_*`, the secret-free-shape oracle. A new dispatch verb must be added here (G3 keeps the forbidden set untouched).
  - `src/descriptors/index.ts` — `CANONICAL_M1_TOOLS` (9), `CANONICAL_M3_TASK_TOOLS` (3), `CANONICAL_TOOLS` (the 12-verb superset every binding/loader defaults to).
- **`@mx-loom/mcp`** (`packages/mcp`) and **`@mx-loom/pi`** (`packages/pi`) — each has a `src/dispatch.ts` `DISPATCH` table keyed by descriptor `name`. A new verb adds one room-scoped entry to each (the T301 precedent: "the three `DISPATCH` tables gain three room-scoped entries each").
- **`@mx-loom/claude`** (`packages/claude`) — reuses `@mx-loom/mcp`'s `dispatchCall` verbatim, so it inherits a new verb automatically (plus the T111 JSON-Schema→Zod conversion of the new descriptor).
- **`@mx-loom/toolbelt`** (`packages/toolbelt`) — the `MxClient` (the concrete `DaemonCall`) enforcing the env allowlist + `assertNoCredentialShapedArgs` + `redactSecrets`; and (T302) `resumeSession()` / `watchTasks()` / `PlanSnapshot.reconcile()` that classify tasks as `done`/`inFlight`/`ready`/`blocked`. A resumed runtime's `ready` set is the natural input to a dispatch loop (T304 composes this; T303 provides the primitive).
- **`@mx-loom/golden`** (`packages/golden`) — the e2e harness; `packages/golden/test/t301-task-dag.e2e.test.ts` is the template for a `t303-*.e2e.test.ts` (§1 always-on descriptor surface, §2 fake stateful daemon, §3 gated live round-trip).

**Daemon surface (the substrate, pinned at `v0.2.1`, alpha).** Per `docs/mx-agent-surface-v0.2.1.md`: `call.start` and `exec.start` are **flags-confirmed, round-trip staged**; `task.create/update/list/graph` are **flags-confirmed, round-trip staged** (`task create --room --title [--tool --arg/--input-json --exec --depends-on --blocks --assign --state]` — note the CLI already accepts `--tool`/`--exec` on create, which is exactly the authored-action shape). **There is no documented `task.dispatch` / `task.run` / `task.get` method.** This is the central unknown T303 must navigate (see Risks O1/O2): the toolbelt cannot invent a daemon RPC, so the recommended approach below dispatches via the *verified* `call.start` / `exec.start` surface rather than depending on an unconfirmed task-action RPC.

## Proposed Implementation

**Recommended approach: a registry-side dispatch bridge that re-routes the authored action through the verified `call.start` / `exec.start` paths**, plus the shared `actionToDispatch` mapper that gives "alignment" its single source of truth. This satisfies the AC without depending on any unconfirmed daemon RPC, and reuses the entire receiver-side authorize pipeline for free.

### 1. Lift the action→dispatch mapping into one shared, pure function (G2 — the "alignment")

Extract `buildActionParam` out of `create-task.ts` into `task-projection.ts` (or a small new `src/handlers/task-action.ts`) as an exported, pure, total function:

```ts
/** The dispatch a TaskAction resolves to: a named-tool call.start or a guarded exec.start. */
export type ActionDispatch =
  | { readonly mode: 'tool'; readonly tool: string; readonly args: Record<string, unknown> }
  | { readonly mode: 'exec'; readonly command: string; readonly command_args: string[]; readonly cwd?: string };

/** Map an authored TaskAction onto the dispatch it should run as. Pure; total.
 *  Returns a typed error for an action that cannot be dispatched (missing tool/command). */
export function actionToDispatch(action: TaskAction): ActionDispatch | { readonly invalid: string };
```

- `create-task.ts`'s `buildActionParam` becomes a thin adapter over (or is replaced by) this, so **the shape authored into the DAG is provably the shape that will be dispatched**. A drift test pins them equal.
- The mapper is the literal embodiment of the issue scope ("Ensure `mx_create_task` actions map to a properly authorized exec/tool action"): one function owns "a `TaskAction` *is* a `call.start` or an `exec.start`".

### 2. Add the dispatch verb `mx_dispatch_task` (G1, G3, G4, G5)

A new model-facing descriptor + handler (growing the canonical set **12 → 13**). Recommended name `mx_dispatch_task`; alternatives noted in Risks.

**Descriptor** (`src/descriptors/dispatch-task.ts`, `async_semantics: 'deferred'`):

```jsonc
// input
{
  "task_id":   "string (required) — the DAG node whose authored action to dispatch",
  "wait_ms":   "integer ≥ 0 (optional) — inline-wait hint (the §4.3 / T103 poll budget)",
  "idempotency_key": "string (optional) — generated (task-derived) when omitted"
}
// output: the normalized T102 envelope (ok | running | awaiting_approval | denied | error)
```

**Handler** (`src/handlers/dispatch-task.ts`, `mxDispatchTask(input, deps: DispatchDeps)`), mirroring the `mxDelegateTool` phase structure:

1. **Room provenance.** Missing/empty `deps.room` → `errored('internal', 'no workspace room configured for task dispatch', EMPTY_AUDIT_REF)` (the established Phase-1 guard).
2. **Resolve the task node + its authored action.** Read the node by `task_id`. Preferred: a single-task read RPC if one is verified (`task.get` / `task.show`); **fallback (recommended for now): `task.list` + client-side filter by id** (the T104 `agent.list`+filter precedent, mirrored by T302's `reconstructPlan` already reading `task.list` rows). Project via `projectTaskNode`. If the node has no `action` → `failureResult('invalid_args', …)` ("task carries no action to dispatch"). If the node is already terminal (`succeeded`/`failed`) or in-flight (`executing`) → see O5 (recommended: refuse re-dispatch of a non-`ready` node with `invalid_args`, or make it idempotent — decision to confirm).
3. **Map the action → dispatch** via `actionToDispatch` (step 1). An `{ invalid }` result → `failureResult('invalid_args', …)`.
4. **Route through the existing authorize pipeline (the core):**
   - `mode: 'tool'` → call **`mxDelegateTool`** with `{ agent: <target>, tool, args, wait_ms, idempotency_key }` and `DelegateDeps`. The target agent is the node's `assignee` (the natural binding); if unassigned, surface `invalid_args` ("task is unassigned; cannot dispatch a tool action") unless an explicit target is provided (decision O4).
   - `mode: 'exec'` → call **`mxRunCommand`** with `{ command, args: command_args, cwd, wait_ms, idempotency_key }` and `ExecDeps`.
   - Reusing the two landed handlers — rather than re-emitting `call.start`/`exec.start` — means the **entire receiver-side authorize pipeline, the `awaiting_approval`/`running` normalization, the inline-`wait_ms` composition with `mx_await_result`, and the secret-boundary guard run unchanged**. This is what makes the AC true by construction: a dispatched action is, on the wire, indistinguishable from a direct delegation/exec, so it traverses the identical sig→trust→policy→sandbox→approval pipeline.
5. **(Optional, decision O3) request the `executing` transition.** After a successful dispatch, optionally `task.update { task_id, state: 'executing' }` so the DAG reflects that the action is in flight. Recommended: keep T303 minimal and let the daemon transition task state from the dispatched invocation, OR make the transition a best-effort follow-up that never changes the dispatch envelope. Pin at the round-trip.

**Idempotency (G5).** Derive a default `idempotency_key` from the task — e.g., `idk_task_<task_id>` (or `newIdempotencyKey()` seeded by `task_id`) — so two dispatches of the same task collapse on the daemon's replay protection. This is the load-bearing property for T304's restart scenario: a runtime that died after dispatching task A and resumes (T302) must be able to re-issue dispatch for A's `ready`/`inFlight` set without double-executing. The key rides in `params`, reused verbatim on transport retry (the `mxDelegateTool` precedent).

**`DispatchDeps`** = `RoomScopedDeps` + the `validator` (because `mode: 'tool'` delegates through `mxDelegateTool`, which wants a validator; it defaults to the lazy Ajv validator inside the handler). Effectively `DispatchDeps = DelegateDeps`.

### 3. Wire the new verb into the registry + bindings

- Export `MX_DISPATCH_TASK`, `mxDispatchTask`, `DispatchTaskInput`, `actionToDispatch`/`ActionDispatch` from `src/index.ts` and `src/handlers/index.ts`.
- Add `MX_DISPATCH_TASK` to `CANONICAL_M3_TASK_TOOLS` (→ 4) so `CANONICAL_TOOLS` grows to **13**, and add `'mx_dispatch_task'` to `MODEL_FACING_ALLOWLIST`.
- Add one `DISPATCH` entry to `packages/mcp/src/dispatch.ts` and `packages/pi/src/dispatch.ts` (`delegateDeps(ctx)`/`roomScopedDeps(ctx)` style — it needs room + the defaulted validator). `@mx-loom/claude` inherits it automatically via the shared `dispatchCall`; the Pi binding's TypeBox conversion and the Claude binding's Zod conversion both consume the new descriptor with no per-tool authoring (the generated-binding rule).
- Update the binding-surface drift tests that pin the canonical count (e.g., the golden §1 "12-verb" assertions become 13).

### 4. Why not (yet) a daemon-side dispatch RPC

If a verified `v0.2.1` daemon turns out to expose a first-class task-action dispatch RPC (e.g., `task.dispatch { task_id }` that the daemon runs through its own scheduler + authorize pipeline), the handler's step 4 becomes a single dispatch call to that method, and the registry-side re-routing is unnecessary. This is **O1** — the central decision to confirm at the round-trip. The recommended approach above is chosen because it depends only on the **already-flags-confirmed** `call.start` / `exec.start` surface and therefore can land and be unit-proven now, with the daemon-RPC variant as a localized swap if the round-trip reveals one. Either way the AC holds and the authorize pipeline stays receiver-side.

## Affected Files / Packages / Modules

**`@mx-loom/registry` (owning package):**
- `src/handlers/task-projection.ts` *(or new `src/handlers/task-action.ts`)* — add exported `ActionDispatch` + `actionToDispatch` (lift from `create-task.ts`).
- `src/handlers/create-task.ts` — replace the private `buildActionParam` with the shared mapper (alignment proof).
- `src/descriptors/dispatch-task.ts` *(new)* — `MX_DISPATCH_TASK`.
- `src/handlers/dispatch-task.ts` *(new)* — `mxDispatchTask`, `DispatchTaskInput`.
- `src/handlers/deps.ts` — add `DispatchDeps` (likely a `DelegateDeps` alias) if not reusing `DelegateDeps` directly.
- `src/descriptors/index.ts` — add `MX_DISPATCH_TASK` to `CANONICAL_M3_TASK_TOOLS` / re-export.
- `src/security.ts` — add `'mx_dispatch_task'` to `MODEL_FACING_ALLOWLIST` (forbidden set untouched).
- `src/handlers/index.ts`, `src/index.ts` — barrel exports.
- `test/descriptors.task.test.ts`, `test/handlers/dispatch-task.test.ts` *(new)*, `test/handlers/dispatch-task.security.test.ts` *(new)*, `test/handlers/task-action.test.ts` *(new)*, the security-invariants/allowlist drift test.

**`@mx-loom/mcp`:** `src/dispatch.ts` (one entry); tests pinning the surfaced set / count.
**`@mx-loom/pi`:** `src/dispatch.ts` (one entry), `src/names.ts` (`mxToolNames`); the TypeBox-conversion smoke suite picks up the new descriptor.
**`@mx-loom/claude`:** no source change (inherits `dispatchCall`); the Zod-conversion + surface tests update for the new descriptor.
**`@mx-loom/golden`:** `test/t303-signed-task-action-dispatch.e2e.test.ts` *(new)*; bump 12→13 count assertions where present.
**Docs:** `docs/mx-agent-tool-fabric-design.md` (§2 table row, §7 task-state paragraph, §10 roadmap M3 line), `docs/backlog.md` (T303 status), `docs/mx-agent-surface-v0.2.1.md` (dispatch / single-task-read row), `docs/runtime-integration.md` (verb table).

## API / Interface Changes

- **New model-facing tool descriptor `mx_dispatch_task`** (`async_semantics: 'deferred'`): input `{ task_id (required), wait_ms?, idempotency_key? }`; output is the standard T102 envelope. This is a new **public API** — document it in the design doc's verb table and the runtime-integration guide. The canonical set grows **12 → 13**; `CANONICAL_TOOLS`, `MODEL_FACING_ALLOWLIST`, and the per-binding `DISPATCH` tables update accordingly.
- **New exported pure helpers** `actionToDispatch` / `ActionDispatch` from `@mx-loom/registry` (used internally + by tests).
- **No CLI change** in mx-loom (the MCP `bin` surfaces the new tool generatively; no new flag).
- **No daemon-RPC surface change authored by mx-loom.** The handler consumes existing daemon methods (`call.start` / `exec.start`, plus a `task.list`/`task.get` read). If the round-trip reveals a daemon-side `task.dispatch`, that is a substrate method mx-loom *consumes*, not one it defines.

If the team prefers **not** to add a 13th model-facing verb (keeping the canonical set at 12), the alternative is to make dispatch a **toolbelt/binding-internal mechanism** consumed by T304's plan-execution loop rather than a model tool — see Risks O6. In that case there is **no new model-facing API**; the only public surface is the exported `actionToDispatch` mapper. This is a decision to confirm.

## Data Model / Protocol Changes

- **Envelope shape:** none. `mx_dispatch_task` returns the existing T102 envelope built only through the sanctioned helpers (`ok`/`running`/`awaitingApproval`/`denied`/`errored`). A deferred dispatch carries `handle` + (when held) `approval`; every result carries `audit_ref`.
- **Error taxonomy:** none added. The closed nine-code set is reused: `invalid_args` (no action / unassigned tool action / un-dispatchable action / unknown task), `not_found` (unknown `task_id` via the read), `policy_denied` / `untrusted_key` / `approval_denied` / `approval_expired` (receiver verdicts, mapped from the delegation/exec path), `timeout` / `target_offline` / `internal` (faults). No `cancelled`-style code; consistent with the frozen taxonomy decision (T108 OQ #1).
- **Idempotency-key:** a task-derived default key is the new convention for this verb (G5). It is a dedup nonce, never a capability — idempotency never bypasses authorize.
- **Audit-row:** none new. The dispatched invocation flows through `mx_delegate_tool` / `mx_run_command`, whose results already feed the T113 `auditRowFrom` projection unchanged; the dispatch correlates on the same `audit_ref` ids.
- **Authored `action` schema:** unchanged (the flat `kind`-discriminated object from T301). The `actionToDispatch` mapper reads it; it does not re-shape it.

## Security & Compliance Considerations

- **The secret boundary holds at dispatch, not just authoring.** `action.args` (tool) and `command_args` (exec) are the highest-risk fields — an arg is where a credential is most likely to be inlined. T301 already rejects a credential-shaped value at **authoring** (so it is never persisted into the DAG). T303 adds the **dispatch-time** guard for free: because dispatch routes through `mxDelegateTool` / `mxRunCommand` over the concrete `MxClient`, `assertNoCredentialShapedArgs` (keys **and** values) runs again before the wire, and `redactSecrets` scrubs token-shaped values inbound. Double-guarded. The registry re-implements neither guard (single source = the toolbelt) and keeps its zero **runtime** toolbelt dependency (the `DaemonCall` seam is injected, imported `type`-only).
- **Matrix tokens, Ed25519 signing keys, provider keys, and `GH_TOKEN` never cross Boundary A.** Dispatch produces a *signed request*; the daemon holds the signing key and signs the `CallRequest`/`ExecRequest` out-of-process. The toolbelt cannot sign and never sees a credential. The deny-by-default env allowlist (`safeSubprocessEnv`) is unchanged and unbypassed.
- **Out-of-process enforcement is the whole point of the AC.** The full authorize pipeline (Ed25519 trust store + deny-by-default `policy.toml` + sandbox + human approval gate) runs on the **receiving** daemon, exactly as for a direct delegation. T303 performs **no** trust/policy/approval/sandbox/`allow_commands`/`deny_args_regex`/`allow_cwd` check in-process. An authored action is a request shape, never a grant — dispatch re-runs authorize from scratch. A revoked key or a tightened policy between authoring and dispatch is honored at dispatch time (the "re-validated at release" property, design §5).
- **Cognition gets no authority surface.** No trust/policy/approval-mutation tool is added; `security.ts`'s forbidden-authority set is untouched and the no-authority regression test still passes (the new verb is a request-producer). Approval reaches the model only as the `awaiting_approval` status, re-validated against live policy at release (design §6 layer 5).
- **Approval gates are not hidden.** The initial dispatch is non-blocking by default (`wait_ms` omitted ⇒ a single probe), so a held action surfaces as `awaiting_approval` rather than silently blocking — a human approval gate is never concealed (the T202 `wait_ms=0` precedent).
- **Audit correlation.** Every dispatch result carries `audit_ref` (G7), tying "model dispatched task T" ↔ "daemon ran signed invocation X" ↔ "operator approved Z". Messages are the fixed, secret-free phrases; validation detail (which could echo arg values) is never placed in the envelope. Never log or persist secrets/tokens.
- **Idempotency is a nonce, not a capability.** The task-derived `idempotency_key` only dedupes replays; it never carries authority and never bypasses authorize.

## Testing Plan

**Unit (registry, daemon-free, fake `DaemonCall`):**
- `actionToDispatch`: `kind: 'tool'` → `{ mode: 'tool', tool, args }`; `kind: 'exec'` → `{ mode: 'exec', command, command_args, cwd? }`; missing `tool`/`command` → `{ invalid }`; total / never throws. **Drift test:** the params `create-task.ts` authors equal what `actionToDispatch` would dispatch (the alignment proof).
- `mxDispatchTask` happy paths: a `kind: 'tool'` node dispatches via the delegation path and returns the inner tool's `ok` result; a `kind: 'exec'` node dispatches via the exec path and returns `ok({ exit_code, … })`.
- Deferred / approval (G4): a receiver that holds → `status: awaiting_approval` + `handle` + projected `approval`; a `running` dispatch + positive `wait_ms` resolves via the composed `mx_await_result`; a `wait_ms` expiry returns the still-pending envelope (`error: null`), never `errored('timeout')`.
- Denials (G3): `policy_denied` / `untrusted_key` from the receiver map to `status: denied` with the right code; never a self-decision.
- Edge cases: unknown `task_id` → `not_found`; node with no action → `invalid_args`; `kind: 'tool'` on an unassigned node → `invalid_args` (or explicit-target behavior per O4); already-terminal/in-flight node → per O5.
- Idempotency (G5): the same `task_id` yields the same default `idempotency_key`; the key rides params verbatim across a transport retry (assert no regeneration).
- Robustness: every transport/daemon fault maps onto the closed taxonomy; the handler never throws.

**Security (registry):**
- A credential-shaped value baked into a node's `action.args` / `command_args` is rejected as `invalid_args` at dispatch via the **real** toolbelt guard at the registry boundary; the value appears in no envelope field; inbound `redactSecrets` scrubs token-shaped daemon values.
- No-authority invariants: `mx_dispatch_task ∈ MODEL_FACING_ALLOWLIST`, `∉` forbidden-authority set; the surfaced binding set never intersects `FORBIDDEN_AUTHORITY_VERBS`.

**Binding (MCP / Pi / Claude):**
- The new verb appears in `tools/list` with valid JSON Schema (verbatim pass-through); the canonical count is **13**; `tools/call` for `mx_dispatch_task` routes through `dispatchCall` → `mxDispatchTask` and serializes a conformant T102 `CallToolResult` (a held dispatch is a **non-error** structured result carrying `status`/`handle`/`approval`). Pi: the descriptor converts to TypeBox (`enum`→`StringEnum`) fail-closed; Claude: converts to Zod.

**End-to-end (`@mx-loom/golden`, `test/t303-*.e2e.test.ts`, mirroring T301's three tiers):**
- §1 always-on: descriptor surface (count 13, valid schema, not an authority verb).
- §2 always-on, fake stateful daemon: author a task with a `kind: 'tool'` action → `mx_dispatch_task` → the fake daemon records a `call.start` with the aligned params → `ok`; a `kind: 'exec'` action → an `exec.start`; a held action → `awaiting_approval` → resolve via `mx_await_result`. §2b secret boundary via the binding.
- §3 gated (`MXL_CONFORMANCE_TWO_DAEMON=1` + golden policy): **the literal AC** — author a task whose action is an approval-gated tool on a second agent; dispatch; assert the receiver runs the full authorize pipeline (held → out-of-band operator approve via `decide-approval.sh` → `ok`; and a deny path → `denied('approval_denied')`; and a `deny_args_regex` / deny-by-default path → `policy_denied`). Skip-clean without the fixture, fail-not-skip when demanded.

**Conformance / wire-shape (staged):** the single-task read (`task.get` vs `task.list`+filter), the optional `executing` transition, and any daemon-side `task.dispatch` are pinned behind `MXL_CONFORMANCE_TWO_DAEMON=1` with localized wire consts; a new daemon code degrades to `internal`, never the wrong code.

**Documentation tests:** the runtime-guide drift guard (`packages/mcp/test/runtime-guide.test.ts`) and any verb-table pin updated to include `mx_dispatch_task`.

## Documentation Updates

- **`docs/mx-agent-tool-fabric-design.md`:** update the §2 verb table (the `mx_create_task/...` row's "T303 dispatches" note → "dispatched via `mx_dispatch_task` (T303)", and add the new verb), the §7 "Task state" paragraph (the action is *authored* by T301 and *dispatched through the authorize pipeline* by T303), the §5 invocation-flow note (a dispatched task action traverses the identical pipeline), and the §10 roadmap M3 line (signed task-action dispatch — landed).
- **`docs/backlog.md`:** flip T303's status from open to a landed-status block (mirroring T301/T302's detail), check the AC box, and update the M3 critical-path narrative. Update the header status line.
- **`docs/mx-agent-surface-v0.2.1.md`:** add a row for the single-task read and (if discovered) `task.dispatch`; note that T303 consumes `call.start`/`exec.start` for dispatch and stages any new shape.
- **`docs/runtime-integration.md`:** add `mx_dispatch_task` to the verb table; one line on dispatching an authored plan action.
- **Help text:** none beyond the generated tool description (the MCP `bin` surfaces the new tool generatively).

## Risks and Open Questions

- **O1 — Is there a daemon-side task-action dispatch RPC?** *Central decision.* The `v0.2.1` surface doc documents no `task.dispatch`/`task.run`. The recommended approach dispatches via the verified `call.start`/`exec.start` paths, which is robust regardless. **Confirm at the round-trip** whether a first-class dispatch RPC exists; if so, swap the localized dispatch const. Either way the AC ("runs through the full authorize pipeline on dispatch") holds because both routes hit the receiver pipeline.
- **O2 — Single-task read.** Is there a `task.get`/`task.show`? If not, use `task.list` + client-side id filter (the T104 / T302 precedent). Localize the method const; pin at the round-trip.
- **O3 — Task-state transition on dispatch.** Does dispatch (a) leave state to the daemon (the dispatched invocation implies `executing`), (b) best-effort `task.update { state: 'executing' }` after dispatch, or (c) require the model to update state separately? Recommended: (a)/(b) without coupling to the dispatch envelope. Confirm.
- **O4 — Target for a `kind: 'tool'` action.** Use the node's `assignee` as the delegation target; if unassigned, `invalid_args` (recommended) or accept an explicit `agent` override on `mx_dispatch_task`. Confirm whether unassigned tool actions should be dispatchable at all.
- **O5 — Re-dispatch / state guard.** Should dispatch refuse a node that is already `executing`/`succeeded`/`failed` (`invalid_args`), or rely purely on idempotency to make re-dispatch safe? The crash-recovery scenario (T304) needs re-dispatch to be safe; recommended: idempotency-key dedupe + a soft `invalid_args` on a clearly-terminal node. Confirm.
- **O6 — Model-facing verb vs internal mechanism.** Should dispatch be a 13th **model tool** (`mx_dispatch_task`) or a **toolbelt/binding-internal** primitive that only T304's plan-execution loop calls (no new model API)? Recommended: the model-facing verb (composes cleanly with the existing deferred/approval semantics and lets cognition drive the plan); but if the team wants the model to author plans and the *coordination layer* to run them, the internal-mechanism variant keeps the canonical set at 12. **Decision to confirm before implementation** — it changes the public-API surface.
- **O7 — Verb naming.** `mx_dispatch_task` vs `mx_run_task` vs `mx_start_task`. Recommended `mx_dispatch_task` (matches the design's "dispatch" language and avoids collision with `mx_run_command`). Confirm.
- **O8 — Idempotency key derivation.** A task-stable key (`idk_task_<task_id>`) makes re-dispatch idempotent but means a *legitimately intended* re-run of the same task would also dedupe; if re-runs are a use case, key on `(task_id, attempt)`. Recommended: task-stable for M3 (re-runs are out of scope); revisit if needed.
- **O9 — Repo-is-alpha caveat.** All `task.*` and dispatch wire shapes are flags-confirmed-at-best; nothing here may be asserted as verified until the two-daemon fixture runs green. Author against the design's named shapes with localized consts and `internal`-safe fallbacks.

## Implementation Checklist

1. **Confirm the open decisions O1, O3, O4, O5, O6, O7** with the maintainer (especially O6 — model-facing verb vs internal mechanism — and O1 — daemon-side dispatch RPC), since they shape the public API. Default to the recommendations above if unanswered.
2. **Lift the action→dispatch mapping** into an exported, pure, total `actionToDispatch` + `ActionDispatch` (in `task-projection.ts` or new `task-action.ts`); refactor `create-task.ts`'s `buildActionParam` to consume it; add the drift test proving authored params == dispatch params.
3. **Author `MX_DISPATCH_TASK`** in `src/descriptors/dispatch-task.ts` (`async_semantics: 'deferred'`, input `{ task_id, wait_ms?, idempotency_key? }`, output = envelope; `additionalProperties: false`; no credential-shaped property names).
4. **Implement `mxDispatchTask`** in `src/handlers/dispatch-task.ts`: room provenance → resolve node + authored action (localized read const; `task.list`+filter fallback) → `actionToDispatch` → route to `mxDelegateTool` (`mode: 'tool'`, target = `assignee`) / `mxRunCommand` (`mode: 'exec'`) with a task-derived `idempotency_key` and the inline-`wait_ms` composition inherited from the callees → normalize → return. Never throw.
5. **Add `DispatchDeps`** (likely `= DelegateDeps`) to `deps.ts` if not reusing `DelegateDeps`.
6. **Register the verb:** add to `CANONICAL_M3_TASK_TOOLS` (→ `CANONICAL_TOOLS` = 13), `MODEL_FACING_ALLOWLIST`, and barrel-export `MX_DISPATCH_TASK` / `mxDispatchTask` / `DispatchTaskInput` / `actionToDispatch` / `ActionDispatch` from `handlers/index.ts` + `index.ts`.
7. **Wire the bindings:** one `DISPATCH` entry in `packages/mcp/src/dispatch.ts` and `packages/pi/src/dispatch.ts`; update `packages/pi/src/names.ts`; confirm `@mx-loom/claude` inherits it; bump any 12→13 count assertions.
8. **Tests:** the unit, security, binding, and golden e2e suites in the Testing Plan; ensure the no-authority + secret-boundary + alignment-drift tests are present and green; keep the live §3 arm skip-clean without the fixture, fail-not-skip when demanded.
9. **Run `pnpm -r typecheck && pnpm -r build && pnpm -r test`** (daemon-free suites green; gated conformance arms staged).
10. **Docs:** update `docs/mx-agent-tool-fabric-design.md` (§2/§5/§7/§10), `docs/backlog.md` (T303 status + AC box + header), `docs/mx-agent-surface-v0.2.1.md` (read + dispatch rows), `docs/runtime-integration.md` (verb table), and the runtime-guide drift guard.
11. **Self-review against the constraints:** no secret crosses Boundary A; no in-process trust/policy/approval check; no new authority tool; the authored action is re-validated by the receiver at dispatch; every result carries `audit_ref`; no unimplemented behavior is implied as done; all unverified wire shapes are localized and flagged as staged, not asserted verified.
