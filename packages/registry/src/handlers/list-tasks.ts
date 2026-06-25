/**
 * `mx_list_tasks` — read the durable shared plan as a list or a DAG (T301 / #30) —
 * design §2 (the task-DAG verbs) / §7 ("Task state"). The verb that lets cognition
 * **read** the `com.mxagent.task.v1` plan of record — and, crucially, see the
 * dependency structure that makes "list reflects the DAG" hold (the issue's AC).
 *
 * A `sync` **local read** composing `task.list` (the nodes) with, for
 * `view: 'graph'`, the dependency edges. The edges are **derived from each node's
 * `depends_on` / `blocks`** (the records already carry them — spec Risk #1) and
 * merged with any explicit `task.graph` reply; a `task.graph` fault never fails the
 * list, since the derived edges already reflect the DAG. Returns
 * `ok({ tasks, edges? }, EMPTY_AUDIT_REF)` — a local read has no Matrix round-trip,
 * so an all-null `audit_ref` (consistent with `mxFindAgents` / `mxWorkspaceStatus`).
 *
 * **Room is best-effort (a read, not a mutation).** Unlike create/update it does not
 * fail-fast on a missing room: `task.list` may default to the daemon's current
 * workspace, so the handler passes `deps.room` only when set (mirroring
 * `mxWorkspaceStatus`). The room still comes from the session, never model input.
 *
 * Never throws. Wire-shape assumptions (the `task.list` / `task.graph` param + reply
 * shapes, whether `task.list` already carries edges) are **pending the two-daemon
 * round-trip**; the method consts are localised below.
 */
import { ok, type ToolResult } from '../envelope.js';
import { asRecord } from './agent-projection.js';
import type { RoomScopedDeps } from './deps.js';
import { EMPTY_AUDIT_REF, faultToResult } from './handler-fault.js';
import {
  deriveEdges,
  mergeEdges,
  projectTaskNode,
  type TaskEdge,
  type TaskNode,
  type TaskState,
} from './task-projection.js';

/** Localised so the two-daemon round-trip corrects the wire in one place. */
const TASK_LIST_METHOD = 'task.list';
const TASK_GRAPH_METHOD = 'task.graph'; // edges, when view === 'graph'

/** Input of `mx_list_tasks` — optional filters + the view selector. */
export interface ListTasksInput {
  /** Optional state filter. */
  readonly state?: TaskState;
  /** Optional assignee agent_id filter. */
  readonly assignee?: string;
  /** `'graph'` (default) returns nodes + edges; `'list'` returns nodes only. */
  readonly view?: 'list' | 'graph';
}

/** The `mx_list_tasks` success payload. `edges` is present for `view: 'graph'`. */
export interface ListTasksResult {
  readonly tasks: TaskNode[];
  readonly edges?: TaskEdge[];
}

/** Extract the task rows from a `task.list` reply: a bare array, or wrapped under
 *  `tasks` / `nodes` / `items` (pinned at the round-trip). A non-array → `[]`. */
function readTaskRows(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const r = asRecord(raw);
  if (r === undefined) return [];
  for (const key of ['tasks', 'nodes', 'items'] as const) {
    if (Array.isArray(r[key])) return r[key] as unknown[];
  }
  return [];
}

/** Extract the explicit edge rows from a `task.graph` reply (`edges` / `links`, or a
 *  bare array). A non-array → `undefined` (no explicit edges to merge). */
function readEdgeRows(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw;
  const r = asRecord(raw);
  if (r === undefined) return undefined;
  if (Array.isArray(r.edges)) return r.edges;
  if (Array.isArray(r.links)) return r.links;
  return undefined;
}

/**
 * List the shared plan and return the normalized {@link ToolResult}. Never throws —
 * a `task.list` fault maps onto the closed T102 taxonomy; a `task.graph` fault is
 * tolerated (the derived edges still reflect the DAG).
 */
export async function mxListTasks(input: ListTasksInput, deps: RoomScopedDeps): Promise<ToolResult> {
  const view = input.view ?? 'graph';

  // Build the filter params; pass `room` only when set (best-effort — the daemon may
  // default to its current workspace). `room` from the session, never model input.
  const filters: Record<string, unknown> = {
    ...(deps.room !== undefined && deps.room !== '' ? { room: deps.room } : {}),
    ...(input.state !== undefined ? { state: input.state } : {}),
    ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
  };
  const listParams = Object.keys(filters).length > 0 ? filters : undefined;

  // 1. task.list — the primary read. A fault here is the verb's fault → a fault
  //    envelope (no round-trip → EMPTY_AUDIT_REF).
  let listResponse: unknown;
  try {
    listResponse = await deps.daemon.call(TASK_LIST_METHOD, listParams);
  } catch (err) {
    return faultToResult(err, EMPTY_AUDIT_REF);
  }
  const tasks: TaskNode[] = readTaskRows(listResponse).map(projectTaskNode);

  // 2. view: 'list' → nodes only.
  if (view === 'list') {
    return ok({ tasks } satisfies ListTasksResult, EMPTY_AUDIT_REF);
  }

  // 3. view: 'graph' → derive edges from the node records (so the DAG is reflected
  //    from `task.list` alone), then merge any explicit `task.graph` edges. A
  //    `task.graph` fault is tolerated — the derived edges still reflect the DAG.
  const derived = deriveEdges(tasks);
  let graphResponse: unknown;
  try {
    graphResponse = await deps.daemon.call(TASK_GRAPH_METHOD, listParams);
  } catch {
    graphResponse = undefined;
  }
  const edges: TaskEdge[] = mergeEdges(derived, readEdgeRows(graphResponse));

  return ok({ tasks, edges } satisfies ListTasksResult, EMPTY_AUDIT_REF);
}
