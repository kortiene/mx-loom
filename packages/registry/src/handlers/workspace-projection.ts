/**
 * Non-secret workspace/project projection for `mx_workspace_status` (T108 / #16) —
 * design §2 (the observe verb) / §4.7 / §6 (the secret-free output boundary).
 *
 * The **redaction/shaping heart** of `mx_workspace_status`, the sibling of
 * `agent-projection.ts`. It maps the daemon's `workspace.status` reply (the *Matrix
 * room* view) onto the non-secret, model-facing {@link WorkspaceMeta} and derives a
 * {@link ProjectContext}. Pure: no I/O, **never throws** — every reader is total and
 * degrades a malformed value to "absent".
 *
 * **Allowlist-by-construction — the load-bearing redaction decision.** The verified
 * `workspace.status` reply carries `members[{ user_id, display_name, membership }]`
 * — raw **Matrix user ids**. T104 set the precedent of projecting Matrix/identity
 * fields **out** of model-facing output. {@link projectWorkspaceMeta} copies only
 * the named non-secret room fields (`room_id`, `name`, `canonical_alias`,
 * `encrypted`), so the `members[]` list — and any future identity field added
 * upstream — can never silently reach the model context. The model-facing
 * identities are the MX `agent_id`s from `agent.list` (projected separately via
 * `projectAgentSummary`), exactly as T104 chose.
 */
import { asRecord, readString, type AgentListRow } from './agent-projection.js';

/** Non-secret room metadata from `workspace.status` (the Matrix `members[]` list is
 *  deliberately omitted — see the module note). */
export interface WorkspaceMeta {
  readonly room_id?: string;
  readonly name?: string;
  readonly canonical_alias?: string;
  readonly encrypted?: boolean;
}

/** Derived project context — a dedicated `workspace.status` field if it carries one,
 *  else the consistent project the registered agents report. */
export interface ProjectContext {
  readonly project_id?: string;
  readonly cwd?: string;
  readonly git_commit?: string;
}

function readBoolean(x: unknown): boolean | undefined {
  return typeof x === 'boolean' ? x : undefined;
}

/**
 * Project a raw `workspace.status` reply onto the non-secret {@link WorkspaceMeta}.
 * Allowlist-by-construction: copies only the named room fields, dropping the raw
 * Matrix `members[]` / `user_id` list. A non-object / malformed reply yields `{}`.
 */
export function projectWorkspaceMeta(raw: unknown): WorkspaceMeta {
  const w = asRecord(raw) ?? {};
  const room_id = readString(w.room_id);
  const name = readString(w.name);
  const canonical_alias = readString(w.canonical_alias);
  const encrypted = readBoolean(w.encrypted);
  return {
    ...(room_id !== undefined ? { room_id } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(canonical_alias !== undefined ? { canonical_alias } : {}),
    ...(encrypted !== undefined ? { encrypted } : {}),
  };
}

/** Read a `{ project_id?, cwd?, git_commit? }` block (any of the three present). */
function readProjectFields(x: unknown): ProjectContext | undefined {
  const w = asRecord(x);
  if (w === undefined) return undefined;
  const project_id = readString(w.project_id);
  const cwd = readString(w.cwd);
  const git_commit = readString(w.git_commit);
  if (project_id === undefined && cwd === undefined && git_commit === undefined) return undefined;
  return {
    ...(project_id !== undefined ? { project_id } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(git_commit !== undefined ? { git_commit } : {}),
  };
}

/**
 * Derive the workspace's project context. Prefers a dedicated `project` (or
 * `workspace`) block on the `workspace.status` reply if it carries one; otherwise
 * falls back to the consistent `workspace { project_id, cwd, git_commit }` the
 * registered agents report (the first agent row that carries one). Returns
 * `undefined` when no source knows the project — the handler then omits the field.
 */
export function deriveProject(status: unknown, rows: readonly AgentListRow[]): ProjectContext | undefined {
  const s = asRecord(status);
  if (s !== undefined) {
    const fromStatus = readProjectFields(s.project) ?? readProjectFields(s.workspace);
    if (fromStatus !== undefined) return fromStatus;
  }
  for (const row of rows) {
    const fromAgent = readProjectFields(row.agent.workspace);
    if (fromAgent !== undefined) return fromAgent;
  }
  return undefined;
}
