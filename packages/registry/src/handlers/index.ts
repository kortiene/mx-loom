// The M1 handler layer (T103+). T103 ships the **first** handler — the
// `mx_await_result` deferred-result resolver — and the injected daemon-call seam
// (`DaemonCall`/`HandlerDeps`) that T104–T108 reuse. T104 adds the two **discovery**
// handlers (`mx_find_agents` / `mx_describe_agent`). Handlers call an *injected*
// daemon (a structural subset of the toolbelt's `MxTransport`, imported
// `type`-only), so the registry keeps its zero runtime toolbelt dependency.

// The injected daemon-call seam + clock seams.
export type { DaemonCall, HandlerDeps } from './deps.js';

// The pure invocation-state → envelope normalizer (useful to bindings + tests).
export { classifyInvocation, invocationToResult } from './invocation.js';
export type { InvocationDisposition } from './invocation.js';

// The `mx_await_result` resolver + its input type.
export { mxAwaitResult } from './await-result.js';
export type { AwaitResultInput } from './await-result.js';

// The discovery handlers (T104) + their input/projection types.
export { mxFindAgents } from './find-agents.js';
export type { FindAgentsInput } from './find-agents.js';
export { mxDescribeAgent } from './describe-agent.js';
export type { DescribeAgentInput, DescribeAgentResult } from './describe-agent.js';

// The pure agent-record projectors (non-secret subset) + their model-facing types.
export { projectAgentSummary, projectAgentDetail, projectTools } from './agent-projection.js';
export type { AgentSummary, AgentDetail, PublishedTool, AgentLiveness } from './agent-projection.js';
