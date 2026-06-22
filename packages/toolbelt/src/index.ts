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
export { safeSubprocessEnv, BASE_ENV_ALLOW, ENV_DENY_PREFIXES } from './cli/env.js';
export type { SafeSubprocessEnvOptions } from './cli/env.js';
export { methodToArgv } from './cli/method-map.js';
export type { ArgvPlan } from './cli/method-map.js';
