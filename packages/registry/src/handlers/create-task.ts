/**
 * `mx_create_task` — author a task into the durable shared plan (T301 / #30) —
 * design §2 (the task-DAG verbs) / §7 ("Task state": the durable, shared plan of
 * record). The first verb that lets cognition **write** to the `com.mxagent.task.v1`
 * DAG: create a task with dependencies and (optionally) a signed action.
 *
 * "Author a task node into the workspace DAG and turn the daemon's reply into the
 * normalized T102 envelope." A `sync` mutating handler — **three phases**: room
 * provenance → build the `task.create` params (mapping `title` / `depends_on` /
 * `blocks` / `assign` / `state` / `action` onto the daemon's flag shapes) + attach
 * idempotency → normalize the reply into `ok(TaskNode, audit_ref)`. It is `sync`: it
 * resolves directly to a terminal `ok` / `denied` / `error` and does **not** return
 * `running` / `awaiting_approval` (the deferred path belongs to a task's *action
 * dispatch*, T303, not to authoring the node).
 *
 * **Authority stays out-of-process.** The handler emits a *signed request* only; it
 * performs no trust/policy/approval check. Whether a task may be created or assigned
 * is decided by the receiving daemon; `policy_denied` / `untrusted_key` are outcomes
 * it *maps*, never decisions it makes (design §1, §6).
 *
 * **Secret boundary — the authored `action.args` is the most dangerous surface.** No
 * field carries a credential inbound or outbound. The concrete `deps.daemon.call` (an
 * `MxClient` in production) runs `assertNoCredentialShapedArgs` over keys **and**
 * values *before dispatch*, so a credential-shaped value baked into `action.args`
 * (e.g. `['-H','Authorization: Bearer ghp_…']`) is rejected as `invalid_args` and
 * **never persisted into the DAG**. The action is authored, never dispatched here
 * (T303 dispatches). The registry re-implements no guard (single source = the
 * toolbelt) and keeps its zero **runtime** toolbelt dependency (seam imported
 * `type`-only).
 *
 * Wire-shape assumptions (the `task.create` param names, the task-id field, the
 * task-state vocabulary, the `action` sub-shape, and `audit_ref` availability) are
 * **pending the two-daemon round-trip** (`MXL_CONFORMANCE_TWO_DAEMON=1`): authored
 * against the design's named shapes, with the method consts localised below so the
 * fixture corrects them in one place, and `internal`-safe fallbacks (`projectTaskNode`
 * never throws) so a new daemon code degrades to `internal`, never the wrong code.
 */
import { errored, type ToolResult } from '../envelope.js';
import { newIdempotencyKey } from '../idempotency.js';
import type { RoomScopedDeps } from './deps.js';
import { EMPTY_AUDIT_REF, faultToResult } from './handler-fault.js';
import { actionToDispatch, dispatchToCreateActionParam, isInvalidDispatch } from './task-action.js';
import { taskNodeResponseToResult, type TaskAction, type TaskState } from './task-projection.js';

/**
 * The daemon RPC + param names this handler consumes. Localised so the two-daemon
 * round-trip (or a pin bump) corrects the wire in one place — the `delegate-tool.ts`
 * / `share-context.ts` precedent.
 */
const TASK_CREATE_METHOD = 'task.create';

/** Input of `mx_create_task` — the descriptor's input schema (`title` required). */
export interface CreateTaskInput {
  /** The human/model-readable task title. */
  readonly title: string;
  /** Task ids this task depends on (incoming edges). */
  readonly depends_on?: readonly string[];
  /** Task ids this task blocks (outgoing edges). */
  readonly blocks?: readonly string[];
  /** An agent_id to assign the task to. */
  readonly assign?: string;
  /** The initial state (default `proposed`). */
  readonly state?: TaskState;
  /** The signed action the node carries — authored, NOT dispatched (T303). */
  readonly action?: TaskAction;
  /** Optional client-supplied idempotency key; generated once per invocation when omitted. */
  readonly idempotency_key?: string;
}

/**
 * Map an authored {@link TaskAction} onto the daemon's `task.create` action param.
 * A **thin adapter over the shared {@link actionToDispatch} mapper** (T303), so what
 * is authored into the DAG here is provably the same shape `mx_dispatch_task` will
 * later dispatch (the "alignment" — a drift test pins them equal; there is no second,
 * divergent copy of the mapping). A dispatchable action is authored via
 * {@link dispatchToCreateActionParam}; a not-yet-dispatchable action (no `tool` /
 * `command` yet) authors only its declared fields and lets the receiving daemon — the
 * authority on action legality — validate it (T303 re-checks at dispatch). Omits
 * absent fields so no `undefined` leaks into the params object.
 */
function buildActionParam(action: TaskAction): Record<string, unknown> {
  const dispatch = actionToDispatch(action);
  if (isInvalidDispatch(dispatch)) {
    return {
      kind: action.kind,
      ...(action.tool !== undefined ? { tool: action.tool } : {}),
      ...(action.args !== undefined ? { args: action.args } : {}),
      ...(action.command !== undefined ? { command: action.command } : {}),
      ...(action.command_args !== undefined ? { args: action.command_args } : {}),
      ...(action.cwd !== undefined ? { cwd: action.cwd } : {}),
    };
  }
  return dispatchToCreateActionParam(dispatch);
}

/**
 * Author a task into the workspace DAG and return its normalized {@link ToolResult}.
 * Never throws — every transport/daemon fault maps onto the closed T102 taxonomy
 * (`faultToResult`) or a builder.
 */
export async function mxCreateTask(input: CreateTaskInput, deps: RoomScopedDeps): Promise<ToolResult> {
  // Phase 1 — room provenance. The DAG is workspace-scoped; the model never names a
  // Matrix room (design §1/§7) — the binding injects it from the `MxSession`. Fail
  // fast rather than dispatch a room-less task write (no round-trip → EMPTY_AUDIT_REF).
  // Mirrors `mxShareContext` / `mxRunCommand` Phase 1.
  if (deps.room === undefined || deps.room === '') {
    return errored('internal', 'no workspace room configured for task', EMPTY_AUDIT_REF);
  }

  // Phase 2 — build the params; omit absent fields so no `undefined` leaks. `room`
  // from the session, never model input. `action` is authored here, NOT dispatched
  // (T303 dispatches). Attach idempotency: the key rides in `params`, so
  // `MxClient.withRetry`'s verbatim param reuse keeps it stable across transport
  // retries (T102 §4.4); the handler never regenerates it.
  const idempotency_key = input.idempotency_key ?? newIdempotencyKey();
  // Wire shape PINNED by the live v0.2.1 round-trip (was authored against assumed
  // names). The daemon's `CreateTaskOptions` (mx-agent-daemon task.rs) has NO serde
  // default on `description` / `assigned_to` / `depends_on` / `blocks`, so all four
  // are REQUIRED — omitting `description` returns `-32602 missing field description`.
  // Send them unconditionally; `description` has no model input (not in the
  // descriptor) → "". The daemon's field is `assigned_to` (NOT `assign`); the verb's
  // model-facing input stays `assign`. (The struct has no `deny_unknown_fields`, so
  // the trailing `idempotency_key` is accepted but currently IGNORED by the daemon —
  // task.create has no server-side dedup on v0.2.1.)
  const params: Record<string, unknown> = {
    room: deps.room,
    title: input.title,
    description: '',
    assigned_to: input.assign ?? '',
    depends_on: input.depends_on ?? [],
    blocks: input.blocks ?? [],
    ...(input.state !== undefined ? { state: input.state } : {}),
    ...(input.action !== undefined ? { action: buildActionParam(input.action) } : {}),
    idempotency_key,
  };

  let response: unknown;
  try {
    response = await deps.daemon.call(TASK_CREATE_METHOD, params);
  } catch (err) {
    // A daemon JSON-RPC error (policy_denied / untrusted_key / a credential-shaped
    // action arg → invalid_args) or a transport fault → the mapped envelope.
    return faultToResult(err, EMPTY_AUDIT_REF);
  }

  // Phase 3 — normalize the reply → `ok(TaskNode, audit_ref)`. A create IS a Matrix
  // round-trip (a signed `com.mxagent.task.v1` event), so `audit_ref` is populated
  // from the response (null inner ids when omitted, never fabricated). An explicit
  // daemon error in the reply body maps to the terminal denial/fault.
  return taskNodeResponseToResult(response);
}
