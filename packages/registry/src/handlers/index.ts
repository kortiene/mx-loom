// The M1 handler layer (T103+). T103 ships the **first** handler — the
// `mx_await_result` deferred-result resolver — and the injected daemon-call seam
// (`DaemonCall`/`HandlerDeps`) that T104–T108 reuse. T104 adds the two **discovery**
// handlers (`mx_find_agents` / `mx_describe_agent`). Handlers call an *injected*
// daemon (a structural subset of the toolbelt's `MxTransport`, imported
// `type`-only), so the registry keeps its zero runtime toolbelt dependency.

// The injected daemon-call seam + clock seams (+ the room-scoped seam shared by
// the T105 delegation deps and the T106 guarded-exec deps; the T303 dispatch deps).
export type { DaemonCall, HandlerDeps, RoomScopedDeps, DelegateDeps, ExecDeps, DispatchDeps } from './deps.js';

// The pure invocation-state → envelope normalizers (useful to bindings + tests):
// `invocationToResult` for an `invocation.get` read (T103), `callResponseToResult`
// for an initial `call.start` reply (T105).
export { classifyInvocation, invocationToResult, callResponseToResult } from './invocation.js';
export type { InvocationDisposition } from './invocation.js';

// The `mx_await_result` resolver + its input type.
export { mxAwaitResult } from './await-result.js';
export type { AwaitResultInput } from './await-result.js';

// The discovery handlers (T104) + their input/projection types.
export { mxFindAgents } from './find-agents.js';
export type { FindAgentsInput } from './find-agents.js';
export { mxDescribeAgent } from './describe-agent.js';
export type { DescribeAgentInput, DescribeAgentResult } from './describe-agent.js';

// The delegation handler (T105): `mx_delegate_tool` (agent.tools → validate args →
// call.start → normalize the CallResponse), the first handler to produce populated
// audit_ref ids and to exercise the idempotency contract end-to-end.
export { mxDelegateTool } from './delegate-tool.js';
export type { DelegateToolInput } from './delegate-tool.js';

// The guarded-exec handler (T106): `mx_run_command` (room provenance → exec.start
// with idempotency → normalize the ExecResponse), the leaner sibling of T105 (no
// inner-schema fetch/validation). The guard is entirely receiver-side: the handler
// surfaces `policy_denied` cleanly, never enforces it.
export { mxRunCommand } from './run-command.js';
export type { RunCommandInput } from './run-command.js';

// The context-sharing handlers (T107): the publish/fetch seam for the substrate's
// shared-context channel. `mx_share_context` (room provenance → `share.file/diff/env`
// from `kind` → normalize to `ok({ context_id, sha256 }, audit_ref)`) and
// `mx_get_context` (room provenance → `share.get` → surface `{ context_id, kind?,
// sha256?, size_bytes?, inline?, media_mxc? }`). Both `sync`. The inline-vs-media
// (≤256 KiB) split + sha256 are substrate behavior the handlers *surface*, never
// reimplement — mx-loom never downloads Matrix media. Plus the shared flat-payload
// classifier they both normalize through.
export { mxShareContext } from './share-context.js';
export type { ShareContextInput } from './share-context.js';
export { mxGetContext } from './get-context.js';
export type { GetContextInput } from './get-context.js';
export { contextResponseToResult } from './context-response.js';

// The cancel + observe handlers (T108): `mx_cancel` (invocation.cancel → normalize
// the narrow reply to a terminal `ok({ handle, cancelled, state? }, audit_ref)`) and
// `mx_workspace_status` (workspace.status + agent.list → project the non-secret room
// metadata + AgentSummary[] + project context, dropping the Matrix members[]). Both
// `sync`. `mx_cancel` uses plain `HandlerDeps` (handle-only, like `mx_await_result`);
// `mx_workspace_status` uses `RoomScopedDeps` with the room best-effort.
export { mxCancel } from './cancel.js';
export type { CancelInput, CancelResult } from './cancel.js';
export { mxWorkspaceStatus } from './workspace-status.js';
export type { WorkspaceStatusInput, WorkspaceStatusResult } from './workspace-status.js';

// The task-DAG handlers (T301): `mx_create_task` (task.create → normalize to
// `ok(TaskNode, audit_ref)`), `mx_update_task` (task.update → transition state →
// `ok(TaskNode, audit_ref)`), and `mx_list_tasks` (task.list + derived/`task.graph`
// edges → `ok({ tasks, edges? }, EMPTY_AUDIT_REF)`). All three `sync`,
// `RoomScopedDeps` (the DAG is workspace-scoped; mutators fail-fast on a missing
// room, the read is best-effort). The two mutators author + read a node's signed
// `action` but never dispatch it (T303 dispatches).
export { mxCreateTask } from './create-task.js';
export type { CreateTaskInput } from './create-task.js';
export { mxUpdateTask } from './update-task.js';
export type { UpdateTaskInput } from './update-task.js';
export { mxListTasks } from './list-tasks.js';
export type { ListTasksInput, ListTasksResult } from './list-tasks.js';

// The task-action dispatch handler (T303): `mx_dispatch_task` resolves a node's
// authored action (task.list + id filter) and re-routes it through `mxDelegateTool`
// (kind=tool) / `mxRunCommand` (kind=exec) so it traverses the identical receiver-side
// authorize pipeline — authoring an action is never authorizing it. Plus the shared,
// pure action→dispatch mapper (`actionToDispatch`) that single-sources the alignment
// between what `mx_create_task` authors and what dispatch runs.
export { mxDispatchTask } from './dispatch-task.js';
export type { DispatchTaskInput } from './dispatch-task.js';
export { actionToDispatch, dispatchToCreateActionParam, isInvalidDispatch } from './task-action.js';
export type { ActionDispatch, InvalidActionDispatch } from './task-action.js';

// The pure agent-record projectors (non-secret subset) + their model-facing types.
export { projectAgentSummary, projectAgentDetail, projectTools } from './agent-projection.js';
export type { AgentSummary, AgentDetail, PublishedTool, AgentLiveness } from './agent-projection.js';

// The pure workspace/project projectors (non-secret subset) for `mx_workspace_status`.
export { projectWorkspaceMeta, deriveProject } from './workspace-projection.js';
export type { WorkspaceMeta, ProjectContext } from './workspace-projection.js';

// The pure task-DAG projectors + state mapping (the issue's "map states") + types.
export {
  projectTaskNode,
  projectTaskEdge,
  mapTaskState,
  deriveEdges,
  mergeEdges,
  taskNodeResponseToResult,
  TASK_STATES,
  TASK_STATE_OUTPUTS,
} from './task-projection.js';
export type { TaskNode, TaskEdge, TaskState, TaskAction } from './task-projection.js';
