// The M1 handler layer (T103+). T103 ships the **first** handler — the
// `mx_await_result` deferred-result resolver — and the injected daemon-call seam
// (`DaemonCall`/`HandlerDeps`) that T104–T108 reuse. T104 adds the two **discovery**
// handlers (`mx_find_agents` / `mx_describe_agent`). Handlers call an *injected*
// daemon (a structural subset of the toolbelt's `MxTransport`, imported
// `type`-only), so the registry keeps its zero runtime toolbelt dependency.

// The injected daemon-call seam + clock seams (+ the room-scoped seam shared by
// the T105 delegation deps and the T106 guarded-exec deps).
export type { DaemonCall, HandlerDeps, RoomScopedDeps, DelegateDeps, ExecDeps } from './deps.js';

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

// The pure agent-record projectors (non-secret subset) + their model-facing types.
export { projectAgentSummary, projectAgentDetail, projectTools } from './agent-projection.js';
export type { AgentSummary, AgentDetail, PublishedTool, AgentLiveness } from './agent-projection.js';
