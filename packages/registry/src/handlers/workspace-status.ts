/**
 * `mx_workspace_status` — observe the workspace (T108 / #16) — design §2 (the
 * observe verb). "Where am I / who is here / what project is this" — the single
 * verb a model joining a workspace uses to enumerate the registered agents and the
 * project it is working in, complementing `mx_find_agents` (a flat, filtered agent
 * list) with room + project context.
 *
 * A `sync` **local read** composing two verified-surface RPCs: `workspace.status`
 * (room/project metadata) + `agent.list` (the registered MX agents). It mirrors how
 * T104 backed `mx_describe_agent` on `agent.list` + `agent.tools` because the
 * design-mapped `agent.show` was unverified — here `workspace.status` returns the
 * *Matrix room* view (`members[]`, not MX `AgentState`s), so "list registered
 * agents" requires composing `agent.list`.
 *
 * Returns `ok({ workspace, agents, project? }, EMPTY_AUDIT_REF)`. AC 2 — "lists
 * registered agents + project context". Reuses the T103 {@link RoomScopedDeps} seam,
 * builds only through the T102 helpers, and **never throws**.
 *
 * **Room is best-effort (unlike the mutating verbs).** A status *read* does not
 * fail-fast on a missing room: `workspace.status` may default to the daemon's
 * current workspace, so the handler passes `deps.room` only when set. The room still
 * comes from the session (`MxSession`), never model input (the input schema declares
 * no properties).
 *
 * **The agent list is the model-facing identity, not the Matrix members[].** The
 * verified `workspace.status` reply carries `members[{ user_id, … }]` — raw Matrix
 * user ids — which the projector (`workspace-projection.ts`) deliberately drops. The
 * `agents` array is the non-secret `AgentSummary` shape from `agent.list`, projected
 * via `projectAgentSummary` exactly as `mx_find_agents` does (T104). This is the
 * load-bearing redaction decision (see the security tests).
 *
 * **Local read ⇒ all-null `audit_ref`.** `workspace.status` + `agent.list` are local
 * daemon reads with no Matrix round-trip, so the result carries `EMPTY_AUDIT_REF`
 * (every id `null`, structurally present, never fabricated — consistent with T104).
 *
 * Wire-shape assumptions are pending the live check: `workspace.status` is
 * **verified** to *return* `room_id` / `name` / `canonical_alias` / `encrypted`, but
 * whether it *takes* a `room` argument or defaults to the daemon's current workspace
 * is unrecorded (spec Risk #3) — the handler passes `deps.room` when present and
 * tolerates its absence. The method names are localised below.
 */
import { ok, type ToolResult } from '../envelope.js';
import {
  projectAgentSummary,
  readListRow,
  type AgentListRow,
  type AgentSummary,
} from './agent-projection.js';
import type { RoomScopedDeps } from './deps.js';
import { EMPTY_AUDIT_REF, faultToResult } from './handler-fault.js';
import { deriveProject, projectWorkspaceMeta, type ProjectContext, type WorkspaceMeta } from './workspace-projection.js';

/** The verified v0.2.1 RPCs this handler composes. Localised so a pin bump corrects
 *  the wire in one place (the `find-agents.ts` / `describe-agent.ts` precedent). */
const WORKSPACE_STATUS_METHOD = 'workspace.status';
const AGENT_LIST_METHOD = 'agent.list';

/** Input of `mx_workspace_status` — no model-facing fields (the room is injected). */
export type WorkspaceStatusInput = Record<string, never>;

/** The `mx_workspace_status` success payload: non-secret room metadata + the
 *  registered agents + (optionally) the derived project context. */
export interface WorkspaceStatusResult {
  readonly workspace: WorkspaceMeta;
  readonly agents: AgentSummary[];
  readonly project?: ProjectContext;
}

/**
 * Report the workspace: room metadata + registered agents + project context.
 *
 * Algorithm:
 *  1. `workspace.status` (primary; passing `{ room }` only when `deps.room` is set).
 *     A fault here is the verb's fault → a fault envelope.
 *  2. `agent.list` (tolerated; a fault degrades to `agents: []` — "no agents" is not
 *     an error, mirroring `mx_describe_agent` tolerating an `agent.list` failure).
 *  3. Project the non-secret `workspace` metadata (dropping the Matrix `members[]`),
 *     project each agent row via `projectAgentSummary`, derive `project`, and return
 *     `ok({ workspace, agents, project? }, EMPTY_AUDIT_REF)`.
 */
export async function mxWorkspaceStatus(_input: WorkspaceStatusInput, deps: RoomScopedDeps): Promise<ToolResult> {
  // 1. workspace.status — the primary read. `room` from the session when present;
  //    omitted otherwise so the daemon may default to its current workspace.
  let status: unknown;
  try {
    const params = deps.room !== undefined && deps.room !== '' ? { room: deps.room } : undefined;
    status = await deps.daemon.call(WORKSPACE_STATUS_METHOD, params);
  } catch (err) {
    return faultToResult(err, EMPTY_AUDIT_REF);
  }

  // 2. agent.list — tolerated. A fault (or a non-array reply) degrades to no agents,
  //    never failing the whole status read.
  let listRows: unknown;
  try {
    listRows = await deps.daemon.call(AGENT_LIST_METHOD);
  } catch {
    listRows = undefined;
  }
  const rows: AgentListRow[] = Array.isArray(listRows)
    ? listRows.map(readListRow).filter((e): e is AgentListRow => e !== undefined)
    : [];

  // 3. Project (allowlist-by-construction) and assemble. `workspace.status` +
  //    `agent.list` are local reads → no Matrix round-trip → EMPTY_AUDIT_REF.
  const workspace: WorkspaceMeta = projectWorkspaceMeta(status);
  const agents: AgentSummary[] = rows.map((e) => projectAgentSummary(e.agent, e.liveness));
  const project: ProjectContext | undefined = deriveProject(status, rows);

  const result: WorkspaceStatusResult = {
    workspace,
    agents,
    ...(project !== undefined ? { project } : {}),
  };
  return ok(result, EMPTY_AUDIT_REF);
}
