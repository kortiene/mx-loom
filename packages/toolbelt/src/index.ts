export { IpcClient } from './ipc/client.js';
export type { IpcClientOptions, CallOptions } from './ipc/client.js';
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
