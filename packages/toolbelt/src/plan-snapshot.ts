/**
 * `PlanSnapshot` — the durable plan view a restarted cognition resumes from (T302,
 * design §7 "Task state").
 *
 * When a runtime is killed and restarted, {@link import('./resume.js').resumeSession}
 * re-establishes the session and then reconstructs the *coordination* plan by reading
 * the durable task DAG for the resumed room (the landed `task.list` read) and
 * assembling it into a {@link PlanSnapshot}: the non-secret task nodes, the derived
 * edges, a resumption {@link TaskCursor}, and a **reconciliation classification**
 * (done / in-flight / ready / blocked) the restarted cognition consumes to decide
 * what to do next. That satisfies the acceptance criterion — "a killed-and-restarted
 * runtime resumes the plan from task state."
 *
 * **Registry-free by design (spec OQ #3).** The toolbelt is the base layer; the
 * `@mx-loom/registry` model-facing `TaskNode` projection depends on it *type-only*.
 * So this module owns a **thin, locally-owned, non-secret** {@link ResumedTask} shape
 * read directly from the `task.list` reply — it does **not** import the registry. The
 * richer model-facing projection still reaches cognition through the landed
 * `mx_list_tasks` verb; this is the lifecycle-layer view resumption needs. The state
 * vocabulary below mirrors the registry's `TASK_STATES` and must agree with it (a
 * drift test pins them; the round-trip pins both to the verified daemon vocabulary).
 *
 * **Allowlist-by-construction.** {@link projectResumedTask} copies only *named*
 * non-secret fields, so a field added upstream can never leak into the snapshot. The
 * task record's signed `action` is **read as state, never executed** — resumption
 * observes the plan and never re-dispatches a node's action (that is T303).
 *
 * Pure and **total: never throws.** A `task.list` fault yields an empty-but-valid
 * snapshot carrying the fault code, so a restarted runtime degrades to "no plan
 * recovered" rather than crashing again.
 */
import type { TaskCursor } from './session-descriptor.js';
import type { CallOptions, TransportErrorCode } from './transport.js';
import { TransportError } from './transport.js';

/** Localised so the two-daemon round-trip corrects the wire in one place (shared with
 *  the registry's `list-tasks.ts` spelling and `task-watch.ts`). */
export const TASK_LIST_METHOD = 'task.list';

/** The minimal call seam reconstruction rides on — satisfied by `MxSession.call` and
 *  `MxClient.call` alike (the toolbelt never re-implements the transport). */
export type DaemonCall = (method: string, params?: unknown, options?: CallOptions) => Promise<unknown>;

/**
 * The toolbelt-local task-state vocabulary — the six daemon-vocabulary states
 * (design §7: `proposed→pending→assigned→executing→succeeded/failed`) plus the
 * output-only `unknown` safe fallback for a token outside the known set (never a
 * fabricated specific state). Mirrors the registry's `TaskState`; kept local so the
 * toolbelt stays registry-free.
 */
export type ResumedTaskState =
  | 'proposed'
  | 'pending'
  | 'assigned'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'unknown';

/**
 * The thin, non-secret projection of one `com.mxagent.task.v1` record the resumed
 * session reconstructs the plan from. Exactly the coordination fields reconciliation
 * needs — no signed `action`, no daemon metadata, no credential-shaped field.
 */
export interface ResumedTask {
  readonly task_id: string;
  /** The normalised state — see {@link ResumedTaskState}. */
  readonly state: ResumedTaskState;
  /** The assigned `agent_id`, or `null` when unassigned (never fabricated). */
  readonly assignee: string | null;
  /** Ids of tasks this one depends on (incoming edges). */
  readonly depends_on: string[];
  /** Ids of tasks this one blocks (outgoing edges). */
  readonly blocks: string[];
}

/** A DAG edge derived from the nodes' `depends_on` / `blocks` arrays. */
export interface PlanEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: 'depends_on' | 'blocks';
}

/**
 * The reconciliation: a pure classification over the snapshot's tasks + edges telling
 * cognition *where the dead runtime left off* without prescribing action.
 */
export interface PlanReconciliation {
  /** `succeeded` / `failed` — terminal, nothing to do. */
  readonly done: string[];
  /** `executing` / `assigned` — observe, **DO NOT re-dispatch** (T303). */
  readonly inFlight: string[];
  /** Actionable with every dependency satisfied — candidates to act on. */
  readonly ready: string[];
  /** Actionable but with an unmet / failed dependency. */
  readonly blocked: string[];
}

/** The reconstructed durable plan view a restarted cognition consumes. */
export interface PlanSnapshot {
  readonly room: string;
  readonly tasks: ReadonlyArray<ResumedTask>;
  readonly edges: ReadonlyArray<PlanEdge>;
  readonly reconciliation: PlanReconciliation;
  /** Advance/persist into the next {@link import('./session-descriptor.js').SessionDescriptor}. */
  readonly cursor: TaskCursor;
  /**
   * Set **iff** the durable read faulted — the transport code of the `task.list`
   * fault. (Toolbelt-local: the registry's nine-code `ErrorCode` taxonomy is not
   * reachable here without inverting the layering; the transport code is the honest
   * type of what `task.list` actually produces, and a binding maps it via the
   * registry's `mapTransportError` when it surfaces the snapshot to the model.)
   */
  readonly fault?: TransportErrorCode;
}

// ---------------------------------------------------------------------------
// Total readers (registry-free copies of the agent-projection discipline).
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

// ---------------------------------------------------------------------------
// State mapping — daemon vocabulary → the stable ResumedTaskState.
// ---------------------------------------------------------------------------

function normaliseToken(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * The daemon task-state vocabulary + tolerated synonyms → the stable
 * {@link ResumedTaskState}. Mirrors the registry's `TASK_STATE_MAP`; authored against
 * the design's named states and pinned to the verified v0.2.1 vocabulary at the
 * round-trip. A token outside the table → `unknown` (the documented safe fallback).
 */
const TASK_STATE_MAP: Readonly<Record<string, ResumedTaskState>> = {
  proposed: 'proposed',
  new: 'proposed',
  created: 'proposed',
  draft: 'proposed',
  pending: 'pending',
  queued: 'pending',
  waiting: 'pending',
  blocked: 'pending',
  ready: 'pending',
  assigned: 'assigned',
  claimed: 'assigned',
  accepted: 'assigned',
  scheduled: 'assigned',
  executing: 'executing',
  running: 'executing',
  in_progress: 'executing',
  inprogress: 'executing',
  active: 'executing',
  started: 'executing',
  in_flight: 'executing',
  inflight: 'executing',
  succeeded: 'succeeded',
  success: 'succeeded',
  done: 'succeeded',
  complete: 'succeeded',
  completed: 'succeeded',
  finished: 'succeeded',
  resolved: 'succeeded',
  ok: 'succeeded',
  failed: 'failed',
  failure: 'failed',
  error: 'failed',
  errored: 'failed',
  faulted: 'failed',
  cancelled: 'failed',
  canceled: 'failed',
  aborted: 'failed',
};

/** Normalise a raw daemon task-state token onto the model-facing {@link ResumedTaskState}.
 *  Total; never throws. Absent / unrecognised → `unknown`. */
export function mapResumedTaskState(raw: unknown): ResumedTaskState {
  const token = readString(raw);
  if (token === undefined) return 'unknown';
  return TASK_STATE_MAP[normaliseToken(token)] ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Projection + cursor.
// ---------------------------------------------------------------------------

/** The task-id of a record: named `task_id`, else a flat `id`, else `''` (never
 *  fabricated). Matches the registry's `readTaskId`. */
function readTaskId(r: Record<string, unknown>): string {
  return readString(r['task_id']) ?? readString(r['id']) ?? '';
}

/**
 * Project one daemon task record (bare or wrapped under `{ task: {...} }`) onto the
 * thin, non-secret {@link ResumedTask}. Total; never throws — a malformed record
 * degrades to an empty id, `unknown` state, and empty edge arrays, never leaking an
 * unnamed field.
 */
export function projectResumedTask(raw: unknown): ResumedTask {
  const outer = asRecord(raw);
  const r = (outer !== undefined ? asRecord(outer['task']) : undefined) ?? outer ?? {};
  const assignee = readString(r['assignee']) ?? readString(r['assigned_to']) ?? readString(r['assign']);
  return {
    task_id: readTaskId(r),
    state: mapResumedTaskState(r['state'] ?? r['status'] ?? r['phase']),
    assignee: assignee ?? null,
    depends_on: readStringArray(r['depends_on']),
    blocks: readStringArray(r['blocks']),
  };
}

/** The monotonic revision of a task record, when present — the cursor high-water mark
 *  source (`state_rev`, else `rev` / `version`). Absent / non-numeric → `undefined`. */
export function readTaskRev(raw: unknown): number | undefined {
  const outer = asRecord(raw);
  const r = (outer !== undefined ? asRecord(outer['task']) : undefined) ?? outer;
  if (r === undefined) return undefined;
  for (const key of ['state_rev', 'rev', 'version'] as const) {
    const v = r[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** Extract the task rows from a `task.list` reply: a bare array, or wrapped under
 *  `tasks` / `nodes` / `items`. A non-array → `[]` (mirrors `list-tasks.ts`). */
export function readTaskRows(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const r = asRecord(raw);
  if (r === undefined) return [];
  for (const key of ['tasks', 'nodes', 'items'] as const) {
    if (Array.isArray(r[key])) return r[key] as unknown[];
  }
  return [];
}

/**
 * Advance a cursor against a fresh set of raw task rows: the new `state_rev` is the
 * max of the prior high-water mark and any row's revision (monotonic; never regresses).
 * An opaque `token` carried by the prior cursor is preserved when no newer rev is seen.
 */
export function advanceCursor(prev: TaskCursor | undefined, rows: readonly unknown[]): TaskCursor {
  let max = prev?.state_rev;
  for (const row of rows) {
    const rev = readTaskRev(row);
    if (rev !== undefined && (max === undefined || rev > max)) max = rev;
  }
  return {
    ...(max !== undefined ? { state_rev: max } : {}),
    ...(prev?.token !== undefined ? { token: prev.token } : {}),
  };
}

/** Derive the deduplicated DAG edge set from the projected nodes' `depends_on` /
 *  `blocks` arrays (mirrors the registry's `deriveEdges`). */
export function deriveEdges(tasks: readonly ResumedTask[]): PlanEdge[] {
  const out: PlanEdge[] = [];
  const seen = new Set<string>();
  const push = (from: string, to: string, kind: PlanEdge['kind']): void => {
    if (from === '' || to === '') return;
    const key = `${kind} ${from} ${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ from, to, kind });
  };
  for (const task of tasks) {
    for (const dep of task.depends_on) push(task.task_id, dep, 'depends_on');
    for (const blocked of task.blocks) push(task.task_id, blocked, 'blocks');
  }
  return out;
}

// State partitions for reconciliation.
const TERMINAL_STATES: ReadonlySet<ResumedTaskState> = new Set(['succeeded', 'failed']);
const IN_FLIGHT_STATES: ReadonlySet<ResumedTaskState> = new Set(['executing', 'assigned']);

/**
 * Classify the plan into done / in-flight / ready / blocked — a **pure** function over
 * the tasks' states and `depends_on` satisfaction. A dependency is *satisfied* only
 * when it has terminally **succeeded**; a failed, in-flight, pending, or missing
 * dependency leaves the dependent `blocked` (the conservative resumption choice —
 * never report a task ready when a prerequisite has not actually completed).
 *
 * The non-re-dispatch invariant lives here: `inFlight` tasks are **read**, not
 * restarted (their delegated/exec work is durable on the receiving daemon
 * independent of the requester's liveness — spec OQ #7).
 */
export function reconcile(tasks: readonly ResumedTask[]): PlanReconciliation {
  const succeeded = new Set<string>();
  for (const t of tasks) if (t.state === 'succeeded' && t.task_id !== '') succeeded.add(t.task_id);

  const done: string[] = [];
  const inFlight: string[] = [];
  const ready: string[] = [];
  const blocked: string[] = [];

  for (const t of tasks) {
    if (TERMINAL_STATES.has(t.state)) {
      done.push(t.task_id);
    } else if (IN_FLIGHT_STATES.has(t.state)) {
      inFlight.push(t.task_id);
    } else {
      // proposed / pending / unknown → actionable; ready iff every dep has succeeded.
      const depsSatisfied = t.depends_on.every((dep) => succeeded.has(dep));
      (depsSatisfied ? ready : blocked).push(t.task_id);
    }
  }
  return { done, inFlight, ready, blocked };
}

/** Assemble a {@link PlanSnapshot} from raw `task.list` rows and the prior cursor. Pure. */
export function buildPlanSnapshot(
  room: string,
  rows: readonly unknown[],
  prevCursor: TaskCursor | undefined,
): PlanSnapshot {
  const tasks = rows.map(projectResumedTask);
  return {
    room,
    tasks,
    edges: deriveEdges(tasks),
    reconciliation: reconcile(tasks),
    cursor: advanceCursor(prevCursor, rows),
  };
}

/** An empty-but-valid snapshot carrying a fault code — what a `task.list` fault yields. */
function faultSnapshot(room: string, prevCursor: TaskCursor | undefined, code: TransportErrorCode): PlanSnapshot {
  return {
    room,
    tasks: [],
    edges: [],
    reconciliation: { done: [], inFlight: [], ready: [], blocked: [] },
    cursor: prevCursor ?? {},
    fault: code,
  };
}

/**
 * Reconstruct the durable plan for `room` by reading `task.list` and assembling the
 * {@link PlanSnapshot}. **Never throws** — a `task.list` fault yields an
 * empty-but-valid snapshot carrying the fault code (a restarted runtime degrades to
 * "no plan recovered", never re-crashes). The room comes from the session, never model
 * input; it is passed only when set (best-effort, mirroring `mx_list_tasks`).
 */
export async function reconstructPlan(
  call: DaemonCall,
  room: string,
  prevCursor?: TaskCursor,
): Promise<PlanSnapshot> {
  const params = room !== '' ? { room } : undefined;
  let response: unknown;
  try {
    response = await call(TASK_LIST_METHOD, params);
  } catch (err) {
    const code: TransportErrorCode = err instanceof TransportError ? err.code : 'protocol';
    return faultSnapshot(room, prevCursor, code);
  }
  return buildPlanSnapshot(room, readTaskRows(response), prevCursor);
}
