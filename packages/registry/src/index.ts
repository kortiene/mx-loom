// The canonical tool registry (T101 / #9) + the normalized result contract
// (T102 / #10). The descriptor set is the single, enumerable, validated,
// secret-free source of `mx_*` tools every binding (MCP T109, Claude shim T110),
// the JSON Schema → Zod converter (T111), and the discovery/delegation handlers
// (T104–T108) read from. T102 adds the one result **envelope** (`{status, result,
// error, handle, approval, audit_ref}`), the closed `error.code` taxonomy +
// fault→envelope mappers, and the client-supplied `idempotency_key` contract —
// the contract layer the handlers (T104–T108) build envelopes with. Still no
// behavior and no daemon calls here.

// The descriptor model.
export { TOOL_NAME_RE, defineDescriptor } from './descriptor.js';
export type { ToolDescriptor, JsonSchema, AsyncSemantics } from './descriptor.js';

// The registry loader/validator.
export { loadRegistry, DescriptorValidationError } from './registry.js';
export type { ToolRegistry } from './registry.js';

// The canonical descriptor sets (+ the individual descriptor consts). `CANONICAL_TOOLS`
// is the full 13-verb superset every binding/loader defaults to; `CANONICAL_M1_TOOLS`
// (9) and `CANONICAL_M3_TASK_TOOLS` (4) are documented subsets.
export {
  CANONICAL_TOOLS,
  CANONICAL_M1_TOOLS,
  CANONICAL_M3_TASK_TOOLS,
  MX_FIND_AGENTS,
  MX_DESCRIBE_AGENT,
  MX_DELEGATE_TOOL,
  MX_RUN_COMMAND,
  MX_AWAIT_RESULT,
  MX_SHARE_CONTEXT,
  MX_GET_CONTEXT,
  MX_CANCEL,
  MX_WORKSPACE_STATUS,
  MX_CREATE_TASK,
  MX_UPDATE_TASK,
  MX_LIST_TASKS,
  MX_DISPATCH_TASK,
} from './descriptors/index.js';

// The JSON Schema validation seam (Ajv-backed by default; injectable).
export { createAjvValidator, JSON_SCHEMA_DIALECT } from './validator.js';
export type { SchemaValidator, CompiledSchema } from './validator.js';

// Security invariants — the no-authority allowlist + the secret-free-shape oracle.
export {
  MODEL_FACING_ALLOWLIST,
  FORBIDDEN_AUTHORITY_PREFIXES,
  FORBIDDEN_AUTHORITY_VERBS,
  isForbiddenAuthorityVerb,
  CREDENTIAL_KEY_RE,
  collectSchemaPropertyNames,
  findCredentialShapedProperty,
} from './security.js';

// Immutability helper (used to freeze authored descriptors).
export { deepFreeze } from './freeze.js';

// ---------------------------------------------------------------------------
// The normalized result contract (T102 / #10) — design §4.2/§4.4/§4.5/§4.6.
// ---------------------------------------------------------------------------

// The result envelope — the single shape every tool returns — and its
// constructor helpers (the only sanctioned way to build a conforming envelope).
export { ok, running, awaitingApproval, denied, errored } from './envelope.js';
export type { ToolResult, ToolStatus, ToolError, ApprovalInfo, AuditRef } from './envelope.js';

// The closed `error.code` taxonomy, the denied/error status partition, the
// runtime guard, and the fault→envelope mappers.
export {
  ERROR_CODES,
  DENIAL_CODES,
  FAULT_CODES,
  isErrorCode,
  mapTransportError,
  mapDaemonError,
} from './errors.js';
export type { ErrorCode, DenialCode, FaultCode } from './errors.js';

// The draft-07 envelope schema + ready-to-use validator (AC 1).
export { ENVELOPE_SCHEMA, validateEnvelope } from './envelope-schema.js';

// Client-supplied idempotency (AC 3) — the generator + the key prefix.
export { newIdempotencyKey, IDEMPOTENCY_KEY_PREFIX } from './idempotency.js';

// ---------------------------------------------------------------------------
// The T103 (deferred-result) + T104 (discovery) handlers — design §4.3 / §2.
// ---------------------------------------------------------------------------

// The `mx_await_result` resolver (handle → terminal-or-still-pending envelope via
// `invocation.get` + `wait_ms` poll-with-timeout) and the pure invocation-state →
// envelope normalizers (`invocationToResult` for an `invocation.get` read,
// `callResponseToResult` for an initial `call.start` reply — T105). The daemon
// transport is injected through `HandlerDeps` (imported `type`-only), so the
// registry keeps its zero runtime toolbelt dep.
export { mxAwaitResult, classifyInvocation, invocationToResult, callResponseToResult } from './handlers/index.js';
export type { AwaitResultInput, HandlerDeps, DaemonCall, InvocationDisposition } from './handlers/index.js';

// The discovery handlers (T104): `mx_find_agents` (agent.list → filter → project)
// and `mx_describe_agent` (agent.tools + agent.list → project the ToolSchema[]).
// Both are `sync` local reads — they resolve to a terminal `ok`/`denied`/`error`
// envelope with an all-null `audit_ref` — plus the pure non-secret projectors.
export { mxFindAgents, mxDescribeAgent, projectAgentSummary, projectAgentDetail, projectTools } from './handlers/index.js';
export type {
  FindAgentsInput,
  DescribeAgentInput,
  DescribeAgentResult,
  AgentSummary,
  AgentDetail,
  PublishedTool,
  AgentLiveness,
} from './handlers/index.js';

// The delegation handler (T105): `mx_delegate_tool` — the primary delegation verb
// (agent.tools → validate args vs the target's `input_schema` → call.start →
// normalize the CallResponse incl. `awaiting_approval`). The first handler to emit
// a populated `audit_ref` and to exercise the idempotency contract end-to-end. Its
// `DelegateDeps` add an injected JSON Schema `validator` + the session `room`.
export { mxDelegateTool } from './handlers/index.js';
export type { DelegateToolInput, DelegateDeps } from './handlers/index.js';

// The guarded-exec handler (T106): `mx_run_command` — the second delegation verb
// (room provenance → exec.start with idempotency → normalize the ExecResponse,
// reusing `callResponseToResult`). The leaner sibling of T105: no inner-schema
// fetch, no args validation. The guard (allow_commands / deny_args_regex /
// allow_cwd / sandbox / requires_approval) runs entirely out-of-process on the
// receiving daemon; the handler surfaces `policy_denied` cleanly, never enforces
// it. Its `ExecDeps` carry the session `room` (the room-scoped seam) and NO
// validator. A permitted command that exits non-zero is `status: ok` with
// `result.exit_code !== 0` (governance outcome, not the command's exit).
export { mxRunCommand } from './handlers/index.js';
export type { RunCommandInput, ExecDeps, RoomScopedDeps } from './handlers/index.js';

// The context-sharing handlers (T107): `mx_share_context` + `mx_get_context` — the
// publish/fetch seam for the substrate's cross-agent context channel (a diff, a
// file, an env snapshot one agent produces and another needs to read), mapping to
// the daemon `share.file/diff/env` (publish) and `share.get` (fetch). Both `sync`,
// both `RoomScopedDeps` (no validator). The inline (≤256 KiB) vs Matrix-media split,
// the content-addressing, and the authoritative sha256 over stored bytes are
// *substrate* behavior the handlers surface (via `context_id` / `sha256` / the
// `inline` vs `media_mxc` discriminator) and never reimplement — mx-loom holds no
// Matrix credentials and downloads no media (Boundary A). `mx_share_context` is the
// single most dangerous exfiltration surface and is doubly bounded: the concrete
// `MxClient.call` rejects credential-shaped `content`/`path` as `invalid_args`
// before dispatch. `contextResponseToResult` is the shared flat-payload classifier.
export { mxShareContext, mxGetContext, contextResponseToResult } from './handlers/index.js';
export type { ShareContextInput, GetContextInput } from './handlers/index.js';

// The cancel + observe handlers (T108): `mx_cancel` + `mx_workspace_status` — the
// two P1 verbs that complete the M1 model-facing surface (9 verbs). `mx_cancel`
// (invocation.cancel) lets a model stop an in-flight delegation/command by its
// deferred handle and returns `ok({ handle, cancelled, state? }, audit_ref)`; it
// emits a signed cancel and surfaces the receiver's verdict, never enforcing it.
// `mx_workspace_status` (workspace.status + agent.list) reports the registered
// agents + project context, deliberately projecting the Matrix `members[].user_id`
// list OUT (the model-facing identities are the MX agent_ids). Plus the pure
// non-secret workspace/project projectors.
export { mxCancel, mxWorkspaceStatus, projectWorkspaceMeta, deriveProject } from './handlers/index.js';
export type {
  CancelInput,
  CancelResult,
  WorkspaceStatusInput,
  WorkspaceStatusResult,
  WorkspaceMeta,
  ProjectContext,
} from './handlers/index.js';

// The task-DAG handlers (T301): `mx_create_task` + `mx_update_task` + `mx_list_tasks`
// — the M3 first deliverable letting cognition author and read the durable shared
// plan (the `com.mxagent.task.v1` DAG). Create/update map to `task.create`/`task.update`
// (signed mutations → `ok(TaskNode, audit_ref)`; the two mutators carry an
// `idempotency_key` and author — never dispatch (T303) — a node's signed `action`);
// list maps to `task.list` (+ derived/`task.graph` edges → `ok({ tasks, edges? },
// EMPTY_AUDIT_REF)`) so "list reflects the DAG". The state transition is the daemon's
// job; the handlers forward the target state and surface the daemon's mapped result.
// Plus the pure non-secret task projectors + the `mapTaskState` table (the issue's
// "map states") + the `TaskNode`/`TaskEdge`/`TaskState`/`TaskAction` types.
export { mxCreateTask, mxUpdateTask, mxListTasks } from './handlers/index.js';
export {
  projectTaskNode,
  projectTaskEdge,
  mapTaskState,
  deriveEdges,
  mergeEdges,
  taskNodeResponseToResult,
  TASK_STATES,
  TASK_STATE_OUTPUTS,
} from './handlers/index.js';
export type {
  CreateTaskInput,
  UpdateTaskInput,
  ListTasksInput,
  ListTasksResult,
  TaskNode,
  TaskEdge,
  TaskState,
  TaskAction,
} from './handlers/index.js';

// The task-action dispatch handler (T303): `mx_dispatch_task` — the M3 verb that
// takes a node's authored, signed `action` and runs it through the IDENTICAL
// receiver-side authorize pipeline as a direct delegation/exec (a `kind: 'tool'`
// action via `call.start`, a `kind: 'exec'` action via `exec.start`), so the AC ("a
// task action runs through the full authorize pipeline on dispatch") holds by
// construction. Authoring an action is never authorizing it: dispatch re-runs
// authorize from scratch on the receiver; the handler makes no trust/policy/approval
// decision. Plus the shared, pure `actionToDispatch` mapper — the single source of
// truth aligning what `mx_create_task` authors with what dispatch runs — and its
// `ActionDispatch` shape. The dispatch deps are the delegation deps (`DispatchDeps`).
export { mxDispatchTask, actionToDispatch, dispatchToCreateActionParam, isInvalidDispatch } from './handlers/index.js';
export type { DispatchTaskInput, ActionDispatch, InvalidActionDispatch, DispatchDeps } from './handlers/index.js';
