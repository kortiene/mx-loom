/**
 * Error taxonomy for the mx-agent daemon transports (Boundary B). One
 * `IpcError` with a closed `code` set so callers can branch programmatically
 * rather than parse messages. This is the *shared* transport taxonomy: the CLI
 * fallback (T003) re-exports it as `TransportError` / `TransportErrorCode` (see
 * `../transport.ts`) and maps its failures onto the same codes, so callers
 * branch identically regardless of transport.
 */
export type IpcErrorCode =
  | 'not_running' // socket absent (ENOENT) / CLI binary not found — transport can't reach the daemon
  | 'connect_failed' // transport present but unusable (socket connect/write error; CLI spawn EACCES, …)
  | 'timeout' // no response within the deadline
  | 'closed' // connection closed before a response arrived (IPC only)
  | 'frame' // malformed or oversized wire frame (IPC only)
  | 'protocol' // response was not a valid JSON-RPC 2.0 envelope / unparseable CLI output
  | 'rpc' // daemon returned a JSON-RPC error object
  | 'invalid_args'; // request rejected before dispatch (e.g. credential-shaped arg) — CLI pre-flight; IPC never emits it

export class IpcError extends Error {
  readonly code: IpcErrorCode;

  constructor(code: IpcErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'IpcError';
    this.code = code;
  }
}
