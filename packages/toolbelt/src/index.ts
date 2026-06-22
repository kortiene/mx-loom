// IPC transport (T002) — the primary, framed Unix-socket JSON-RPC client.
export { IpcClient } from './ipc/client.js';
export type { IpcClientOptions } from './ipc/client.js';
export { IpcError } from './ipc/errors.js';
export type { IpcErrorCode } from './ipc/errors.js';
export { resolveSocketPath } from './ipc/socket-path.js';
export type { SocketPathOptions } from './ipc/socket-path.js';
export { encodeFrame, FrameDecoder, HEADER_BYTES, MAX_FRAME_BYTES } from './ipc/framing.js';
export type {
  DaemonStatus,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccess,
  JsonRpcFailure,
  JsonRpcErrorBody,
} from './ipc/types.js';

// Shared transport seam (T003 → T004): one interface + one error taxonomy
// across both transports.
export type { MxTransport, CallOptions } from './transport.js';
export { TransportError } from './transport.js';
export type { TransportErrorCode } from './transport.js';

// CLI fallback transport (T003) — one-shot `mx-agent … --json`.
export { CliClient } from './cli/client.js';
export type { CliClientOptions } from './cli/client.js';
export {
  safeSubprocessEnv,
  isDeniedEnvKey,
  BASE_ENV_ALLOW,
  ENV_DENY_PREFIXES,
  ENV_DENY_SUFFIXES,
  ENV_DENY_EXACT,
} from './cli/env.js';
export type { SafeSubprocessEnvOptions } from './cli/env.js';
export { methodToArgv } from './cli/method-map.js';
export type { ArgvPlan } from './cli/method-map.js';

// Unified client (T004) — IPC primary, CLI fallback, behind one MxTransport.
// `createClient()` is the single typed entry point all callers use.
export { MxClient, createClient } from './client.js';
export type { MxClientOptions, TransportPreference } from './client.js';
export { DEFAULT_RETRY_POLICY, withRetry, backoffDelay } from './retry.js';
export type { RetryPolicy, RetryDeps } from './retry.js';
// Shared secret-boundary guards (T008). `assertNoCredentialShapedArgs` is the
// hardened outbound arg scrubber (rejects credential-shaped args before dispatch
// on both transports); `redactSecrets` is the symmetric inbound, defense-in-depth
// result redaction applied on the MxClient.call seam.
export {
  assertNoCredentialShapedArgs,
  redactSecrets,
  REDACTION_PLACEHOLDER,
  CREDENTIAL_KEY_RE,
  CREDENTIAL_VALUE_RE,
} from './guards.js';

// Session model + agent registration (T005) — layered on MxClient.
// `openSession()` registers an agent, runs a liveness heartbeat, and threads a
// session-stable correlation_id onto every outbound call.
export { openSession, DEFAULT_HEARTBEAT_INTERVAL_MS } from './session.js';
export type { MxSession, MxSessionOptions, SessionState } from './session.js';
export { startHeartbeat } from './heartbeat.js';
export type { HeartbeatHandle, HeartbeatOptions, HeartbeatSchedule } from './heartbeat.js';
export { newCorrelationId, withCorrelationParam, CORRELATION_PARAM_KEY } from './correlation.js';
export type { AgentState, AgentListEntry, AgentLiveness } from './agent-state.js';
