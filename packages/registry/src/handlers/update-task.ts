/**
 * `mx_update_task` — transition a task in the durable shared plan (T301 / #30) —
 * design §2 (the task-DAG verbs) / §7 ("Task state"). The verb that moves a task
 * through the DAG lifecycle (`proposed→pending→assigned→executing→succeeded/failed`),
 * re-assigns it, or adjusts its edges.
 *
 * "Forward the requested change to the daemon and turn its reply into the normalized
 * T102 envelope." A `sync` mutating handler — **two phases**: room provenance →
 * build the `task.update` params (`task_id` + the changed fields + idempotency) →
 * normalize the reply into `ok(TaskNode, audit_ref)`. The leaner sibling of
 * `mxCreateTask`.
 *
 * **The state transition is the daemon's job (the AC).** The handler forwards the
 * requested target `state` and surfaces the daemon's resulting node state; it
 * performs **no** client-side transition-legality check — an illegal transition is
 * the daemon's `invalid_args` / `policy_denied`, surfaced cleanly. Authority stays
 * out-of-process: the handler emits a signed request and maps the verdict, never
 * decides it (design §1, §6).
 *
 * Whether the daemon accepts edge edits (`depends_on` / `blocks`) on update vs
 * create-only is **pending the two-daemon round-trip**; the fields are forwarded and
 * the conformance fixture pins the behavior. `idempotency_key` is the §4.4 dedup
 * nonce, generated when omitted, reused verbatim on retry. Never throws.
 */
import { errored, type ToolResult } from '../envelope.js';
import { newIdempotencyKey } from '../idempotency.js';
import type { RoomScopedDeps } from './deps.js';
import { EMPTY_AUDIT_REF, faultToResult } from './handler-fault.js';
import { taskNodeResponseToResult, type TaskState } from './task-projection.js';

/** Localised so the two-daemon round-trip corrects the wire in one place. */
const TASK_UPDATE_METHOD = 'task.update';
/** The task-id param name (the CLI shows a positional id) — pinned at the round-trip. */
const TASK_ID_PARAM = 'task_id';

/** Input of `mx_update_task` — the descriptor's input schema (`task_id` required). */
export interface UpdateTaskInput {
  /** The id of the task to update. */
  readonly task_id: string;
  /** The target state to transition the task to. */
  readonly state?: TaskState;
  /** Re-assign the task to this agent_id. */
  readonly assign?: string;
  /** Replace the tasks this task depends on (if the daemon supports edge edits on update). */
  readonly depends_on?: readonly string[];
  /** Replace the tasks this task blocks (if the daemon supports edge edits on update). */
  readonly blocks?: readonly string[];
  /** Optional client-supplied idempotency key; generated once per invocation when omitted. */
  readonly idempotency_key?: string;
}

/**
 * Update a task in the workspace DAG and return its normalized {@link ToolResult}.
 * Never throws — every transport/daemon fault maps onto the closed T102 taxonomy.
 */
export async function mxUpdateTask(input: UpdateTaskInput, deps: RoomScopedDeps): Promise<ToolResult> {
  // Phase 1 — room provenance (the DAG is workspace-scoped). Fail fast on a missing
  // room rather than dispatch a room-less task write. Mirrors `mxCreateTask`.
  if (deps.room === undefined || deps.room === '') {
    return errored('internal', 'no workspace room configured for task', EMPTY_AUDIT_REF);
  }

  // Phase 2 — build the params; omit absent fields. `room` from the session, never
  // model input. The handler forwards the target `state` verbatim — the daemon owns
  // transition legality. Idempotency rides in `params` (stable across retries).
  const idempotency_key = input.idempotency_key ?? newIdempotencyKey();
  const params: Record<string, unknown> = {
    room: deps.room,
    [TASK_ID_PARAM]: input.task_id,
    ...(input.state !== undefined ? { state: input.state } : {}),
    ...(input.assign !== undefined ? { assign: input.assign } : {}),
    ...(input.depends_on !== undefined ? { depends_on: input.depends_on } : {}),
    ...(input.blocks !== undefined ? { blocks: input.blocks } : {}),
    idempotency_key,
  };

  let response: unknown;
  try {
    response = await deps.daemon.call(TASK_UPDATE_METHOD, params);
  } catch (err) {
    // unknown task → not_found; illegal transition / bad field → invalid_args;
    // refused mutation → policy_denied / untrusted_key; transport fault → mapped.
    return faultToResult(err, EMPTY_AUDIT_REF);
  }

  // Normalize the reply → `ok(TaskNode, audit_ref)` with the daemon's resulting
  // (mapped) state surfaced. A signed mutation → `audit_ref` populated from the reply.
  return taskNodeResponseToResult(response);
}
