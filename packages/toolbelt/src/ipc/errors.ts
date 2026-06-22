/**
 * Error taxonomy for the mx-agent daemon IPC client (Boundary B). One
 * `IpcError` with a closed `code` set so callers can branch programmatically
 * rather than parse messages.
 */
export type IpcErrorCode =
  | 'not_running' // socket absent (ENOENT) — daemon not started
  | 'connect_failed' // socket present but connect/write/socket failed
  | 'timeout' // no response within the deadline
  | 'closed' // connection closed before a response arrived
  | 'frame' // malformed or oversized wire frame
  | 'protocol' // response was not a valid JSON-RPC 2.0 envelope
  | 'rpc'; // daemon returned a JSON-RPC error object

export class IpcError extends Error {
  readonly code: IpcErrorCode;

  constructor(code: IpcErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'IpcError';
    this.code = code;
  }
}
