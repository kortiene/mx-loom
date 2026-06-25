/**
 * Task-DAG projection for the task verbs (T301 / #30) — design §2 (the task-DAG
 * verbs) / §7 ("Task state": the durable shared plan) / §4.7 / §6 (the secret-free
 * output boundary).
 *
 * The **redaction/shaping + state-mapping heart** shared by `mx_create_task`,
 * `mx_update_task`, and `mx_list_tasks`. It maps the daemon's `com.mxagent.task.v1`
 * record onto the non-secret, model-facing {@link TaskNode} / {@link TaskEdge}
 * shapes the descriptors declare, and normalises the daemon's task-state vocabulary
 * onto a stable model-facing {@link TaskState} via {@link mapTaskState} (the issue's
 * "map states"). Pure: no I/O, **never throws** — every reader is total and degrades
 * a malformed value to "absent".
 *
 * **Allowlist-by-construction.** {@link projectTaskNode} only ever reads *named*
 * fields, so a field added to the task record upstream can never silently leak into
 * the model context (the `agent-projection.ts` / `workspace-projection.ts`
 * precedent). The task record carries no Matrix tokens, Ed25519 *private* keys,
 * provider keys, or `GH_TOKEN` (those stay daemon-held — Boundary A); projection is
 * still a strict subset, defense in depth on top of the daemon's own boundary.
 *
 * **The `action` is authored, never dispatched (T301 Non-Goal).** A task node may
 * carry a signed `action` (a named tool call or a guarded command). T301 authors it
 * into / reads it out of the DAG record only; running it through the full authorize
 * pipeline on dispatch is T303. The projector therefore *surfaces* the action shape
 * but never executes it, and the most dangerous surface — a credential-shaped value
 * inside `action.args` — is rejected at dispatch by the toolbelt guard
 * (`assertNoCredentialShapedArgs`), never here (the registry re-implements no guard).
 *
 * Wire-shape assumptions (the task-id field name, the exact task-state vocabulary,
 * the `action` sub-shape, and whether the record carries `created_at`/`updated_at`)
 * are **pending the two-daemon round-trip** (`MXL_CONFORMANCE_TWO_DAEMON=1`):
 * authored against the design's named shapes now, with tolerated synonyms + a safe
 * `unknown` fallback so a new daemon token degrades to `unknown` (never a fabricated
 * specific state), and pinned to the verified vocabulary at the round-trip.
 */
import type { AuditRef, ToolResult } from '../envelope.js';
import { errored, ok } from '../envelope.js';
import { asRecord, readString, readStringArray } from './agent-projection.js';
import { extractAuditRef, failureCode, failureResult, hasErrorSignal } from './invocation.js';

/**
 * The model-facing task **input** states a model may request (design §7 vocabulary:
 * `proposed→pending→assigned→executing→succeeded/failed`). This is the closed set
 * the `mx_create_task` / `mx_update_task` / `mx_list_tasks` descriptors expose in
 * their `state` enum. The single source of truth for that list lives here; the
 * descriptors inline the same literal (a drift test pins them equal).
 */
export const TASK_STATES = [
  'proposed',
  'pending',
  'assigned',
  'executing',
  'succeeded',
  'failed',
] as const;

/**
 * The model-facing task state set. The six daemon-vocabulary states a model can
 * request, **plus** the output-only `unknown` — the documented safe fallback
 * {@link mapTaskState} emits when the daemon reports a token outside the known
 * vocabulary (never a fabricated specific state; spec OQ #4). `unknown` is never an
 * *input* a model can set — only a *projection* of an unrecognised daemon token.
 */
export type TaskState = (typeof TASK_STATES)[number] | 'unknown';

/** The full output state set (the six input states + the safe `unknown` fallback),
 *  for the descriptors' `TaskNode.state` output enum. */
export const TASK_STATE_OUTPUTS: readonly TaskState[] = [...TASK_STATES, 'unknown'];

/**
 * An authored task action — the signed work a node carries (design §7's "signed
 * `action`"). A **closed** discriminated shape mirroring the delegation surface so
 * no free-form credential field exists. Authored here, **not** dispatched (T303).
 *
 * NB: modelled as a flat object with a `kind` discriminator (not a JSON Schema
 * `oneOf`) because the Pi (T205) and Claude (T111) schema converters fail **closed**
 * on `oneOf`/`anyOf` — a discriminated-union input schema would crash both bindings
 * at build time. The `kind` selects which fields are meaningful; the daemon (and
 * T303's dispatch) is the authority on the action's legality.
 */
export interface TaskAction {
  /** `tool` → a named tool call; `exec` → a guarded command. */
  readonly kind: 'tool' | 'exec';
  /** For `kind: 'tool'`: the named tool to invoke. */
  readonly tool?: string;
  /** For `kind: 'tool'`: the tool's JSON arguments (open object, validated by the daemon). */
  readonly args?: Record<string, unknown>;
  /** For `kind: 'exec'`: the allowlisted command. */
  readonly command?: string;
  /** For `kind: 'exec'`: the command arguments. */
  readonly command_args?: string[];
  /** For `kind: 'exec'`: the working directory. */
  readonly cwd?: string;
}

/**
 * The non-secret projection of one `com.mxagent.task.v1` record — the output of
 * `mx_create_task` / `mx_update_task` and an element of `mx_list_tasks.tasks`.
 */
export interface TaskNode {
  readonly task_id: string;
  readonly title: string;
  /** The model-facing state, normalised via {@link mapTaskState}. */
  readonly state: TaskState;
  /** The assigned `agent_id`, or `null` when unassigned (never fabricated). */
  readonly assignee: string | null;
  /** Ids of tasks this one depends on (incoming edges). */
  readonly depends_on: string[];
  /** Ids of tasks this one blocks (outgoing edges). */
  readonly blocks: string[];
  /** The authored (not dispatched) action, or `null` when the node carries none. */
  readonly action: TaskAction | null;
  /** When the daemon returns them. */
  readonly created_at?: string;
  readonly updated_at?: string;
}

/** A DAG edge for `mx_list_tasks` `view: 'graph'`. `kind` distinguishes a
 *  dependency edge (`from` depends on `to`) from a blocking edge (`from` blocks `to`). */
export interface TaskEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: 'depends_on' | 'blocks';
}

// ---------------------------------------------------------------------------
// State mapping — the daemon vocabulary → the stable model-facing TaskState.
// ---------------------------------------------------------------------------

/** Normalise a daemon state spelling to a lookup key (mirrors `invocation.ts` /
 *  `cancel.ts` / `errors.ts`: lowercased, non-alphanumerics collapsed to `_`,
 *  edges trimmed). */
function normaliseToken(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * The state mapping table (the issue's "map states"): the daemon's task-state
 * vocabulary (`proposed`/`pending`/`assigned`/`executing`/`succeeded`/`failed`) plus
 * tolerated synonyms → the stable model-facing {@link TaskState}. Authored against
 * the design's named states (§7); pinned to the verified v0.2.1 vocabulary at the
 * two-daemon round-trip. A token outside the table maps to `unknown` (the documented
 * safe fallback — never a fabricated specific state).
 */
const TASK_STATE_MAP: Readonly<Record<string, TaskState>> = {
  // proposed — newly authored, not yet acted on.
  proposed: 'proposed',
  new: 'proposed',
  created: 'proposed',
  draft: 'proposed',
  // pending — waiting to be scheduled / dependencies unmet.
  pending: 'pending',
  queued: 'pending',
  waiting: 'pending',
  blocked: 'pending',
  ready: 'pending',
  // assigned — claimed by an agent, not yet executing.
  assigned: 'assigned',
  claimed: 'assigned',
  accepted: 'assigned',
  scheduled: 'assigned',
  // executing — in flight.
  executing: 'executing',
  running: 'executing',
  in_progress: 'executing',
  inprogress: 'executing',
  active: 'executing',
  started: 'executing',
  in_flight: 'executing',
  inflight: 'executing',
  // succeeded — terminal success.
  succeeded: 'succeeded',
  success: 'succeeded',
  done: 'succeeded',
  complete: 'succeeded',
  completed: 'succeeded',
  finished: 'succeeded',
  resolved: 'succeeded',
  ok: 'succeeded',
  // failed — terminal failure.
  failed: 'failed',
  failure: 'failed',
  error: 'failed',
  errored: 'failed',
  faulted: 'failed',
  cancelled: 'failed',
  canceled: 'failed',
  aborted: 'failed',
};

/**
 * Normalise a raw daemon task-state token onto the model-facing {@link TaskState}.
 * Total; never throws. An absent or unrecognised token → `unknown` (the documented
 * safe fallback). Reuses the same token normalisation every other handler uses, so
 * `Executing` / `in-progress` / `IN_PROGRESS` all map to `executing` by construction.
 */
export function mapTaskState(raw: unknown): TaskState {
  const token = readString(raw);
  if (token === undefined) return 'unknown';
  return TASK_STATE_MAP[normaliseToken(token)] ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Projectors — allowlist-by-construction; copy ONLY named non-secret fields.
// ---------------------------------------------------------------------------

/** The task-id of a record: the named `task_id`, else a flat `id` (pinned at the
 *  round-trip), else `''` (never fabricated). */
function readTaskId(raw: Record<string, unknown>): string {
  return readString(raw.task_id) ?? readString(raw.id) ?? '';
}

/** Project a raw `action` block onto the non-secret {@link TaskAction}, or
 *  `undefined` when the record carries none / it is unrecognised. Allowlist-by-
 *  construction: reads only the named action fields. */
function projectAction(raw: unknown): TaskAction | undefined {
  const a = asRecord(raw);
  if (a === undefined) return undefined;
  const kind = readString(a.kind);
  if (kind !== 'tool' && kind !== 'exec') return undefined;
  const tool = readString(a.tool);
  const args = asRecord(a.args);
  const command = readString(a.command);
  // Tolerate either the input spelling (`command_args`) or the daemon's likely
  // `args` array for an exec action (pinned at the round-trip).
  const command_args = Array.isArray(a.command_args)
    ? readStringArray(a.command_args)
    : kind === 'exec' && Array.isArray(a.args)
      ? readStringArray(a.args)
      : undefined;
  const cwd = readString(a.cwd);
  return {
    kind,
    ...(tool !== undefined ? { tool } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(command_args !== undefined ? { command_args } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  };
}

/**
 * Project one daemon task record onto the non-secret {@link TaskNode}. Total; never
 * throws — a non-object / malformed record degrades to a node with empty id/title,
 * `unknown` state, and empty edge arrays (never throws, never leaks an unnamed field).
 * The record may arrive bare or wrapped (`{ task: {...} }`); both are read.
 */
export function projectTaskNode(raw: unknown): TaskNode {
  const outer = asRecord(raw);
  const r = (outer !== undefined ? asRecord(outer.task) : undefined) ?? outer ?? {};
  const assignee = readString(r.assignee) ?? readString(r.assigned_to) ?? readString(r.assign);
  const action = projectAction(r.action);
  const created_at = readString(r.created_at);
  const updated_at = readString(r.updated_at);
  return {
    task_id: readTaskId(r),
    title: readString(r.title) ?? '',
    state: mapTaskState(r.state ?? r.status ?? r.phase),
    assignee: assignee ?? null,
    depends_on: readStringArray(r.depends_on),
    blocks: readStringArray(r.blocks),
    action: action ?? null,
    ...(created_at !== undefined ? { created_at } : {}),
    ...(updated_at !== undefined ? { updated_at } : {}),
  };
}

/**
 * Project a raw edge record onto a {@link TaskEdge}, or `undefined` when it lacks a
 * usable `from`/`to`. `kind` defaults to `depends_on` (the DAG's primary edge) unless
 * the record explicitly says `blocks`.
 */
export function projectTaskEdge(raw: unknown): TaskEdge | undefined {
  const e = asRecord(raw);
  if (e === undefined) return undefined;
  const from = readString(e.from) ?? readString(e.source) ?? readString(e.task_id);
  const to = readString(e.to) ?? readString(e.target) ?? readString(e.depends_on);
  if (from === undefined || to === undefined || from === '' || to === '') return undefined;
  const kind = readString(e.kind) === 'blocks' ? 'blocks' : 'depends_on';
  return { from, to, kind };
}

/**
 * Derive the DAG edge set from the projected nodes' `depends_on` / `blocks` arrays,
 * deduplicated. This makes "list reflects the DAG" hold from `task.list` alone — the
 * node records already carry the edges (spec Risk #1: if `task.list` returns the
 * edge info, `task.graph` is unnecessary). A separate `task.graph` reply (when the
 * daemon offers one) is merged on top of this by the list handler.
 */
export function deriveEdges(nodes: readonly TaskNode[]): TaskEdge[] {
  const out: TaskEdge[] = [];
  const seen = new Set<string>();
  const push = (from: string, to: string, kind: TaskEdge['kind']): void => {
    if (from === '' || to === '') return;
    const key = `${kind} ${from} ${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ from, to, kind });
  };
  for (const node of nodes) {
    // `A depends_on B` ⇒ edge A → B (kind depends_on).
    for (const dep of node.depends_on) push(node.task_id, dep, 'depends_on');
    // `A blocks C` ⇒ edge A → C (kind blocks).
    for (const blocked of node.blocks) push(node.task_id, blocked, 'blocks');
  }
  return out;
}

/**
 * Merge explicit `task.graph` edges into a derived-edge set, deduplicated. Explicit
 * edges the daemon returns are projected via {@link projectTaskEdge}; a malformed or
 * absent graph reply contributes nothing (the derived edges already reflect the DAG).
 */
export function mergeEdges(derived: readonly TaskEdge[], rawEdges: unknown): TaskEdge[] {
  const out: TaskEdge[] = [...derived];
  const seen = new Set(out.map((e) => `${e.kind} ${e.from} ${e.to}`));
  if (!Array.isArray(rawEdges)) return out;
  for (const raw of rawEdges) {
    const edge = projectTaskEdge(raw);
    if (edge === undefined) continue;
    const key = `${edge.kind} ${edge.from} ${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out;
}

/**
 * Normalise a raw `task.create` / `task.update` reply onto a T102 {@link ToolResult}.
 *
 * Create/update are signed mutations → a `ok(TaskNode, audit_ref)` on success, with
 * `audit_ref` populated from the reply (null inner ids when the daemon omits them,
 * never fabricated). An explicit daemon error signal (`{ok:false}` / `{error}`, or a
 * denial/fault state label) maps through the **shared** classifier so the partition
 * matches every other handler (`policy_denied` → `denied`; `invalid_args` → `error`).
 *
 * Pure; never throws; builds the envelope only through the T102 helpers.
 */
export function taskNodeResponseToResult(raw: unknown): ToolResult {
  const obj = asRecord(raw);
  const audit_ref: AuditRef = extractAuditRef(obj);

  // Not an object (null / scalar / array) → cannot classify → safe terminal.
  if (obj === undefined) {
    return errored('internal', 'unrecognised task response', audit_ref);
  }

  // An explicit daemon error signal is a terminal failure, mapped through the shared
  // classifier (unknown task → `not_found`; refused mutation → `policy_denied` /
  // `untrusted_key`; illegal transition / bad field → `invalid_args`).
  if (hasErrorSignal(obj)) {
    return failureResult(failureCode(obj, taskStateToken(obj)), audit_ref);
  }

  return ok(projectTaskNode(obj), audit_ref);
}

/** The reply's state token, normalised for the shared `failureCode` classifier. */
function taskStateToken(obj: Record<string, unknown>): string | undefined {
  const raw = readString(obj.state) ?? readString(obj.status) ?? readString(obj.phase);
  return raw !== undefined ? normaliseToken(raw) : undefined;
}
