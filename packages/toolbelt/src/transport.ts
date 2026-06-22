/**
 * Transport-neutral seam shared by the mx-agent daemon clients (Boundary B).
 *
 * ADR-11 mandates two transports: the framed Unix-socket JSON-RPC client
 * ({@link import('./ipc/client.js').IpcClient}, primary) and the one-shot
 * `mx-agent … --json` CLI ({@link import('./cli/client.js').CliClient},
 * fallback). Both satisfy {@link MxTransport} so T004 (transport selection) can
 * hold either behind a single type and fail over IPC→CLI without callers
 * branching on which transport produced a result.
 *
 * The error taxonomy is **shared, not forked**: `TransportError` /
 * `TransportErrorCode` are transport-neutral aliases of the existing
 * `IpcError` / `IpcErrorCode`, so a caller branches on one closed code set
 * regardless of transport. This is raw-transport level — methods resolve with
 * the daemon RPC `result` directly; the model-facing result envelope
 * (`{status, result, error, …}`) and its `error.code` set are M1 (T102), not
 * here.
 */
import type { DaemonStatus } from './ipc/types.js';

export { IpcError as TransportError } from './ipc/errors.js';
export type { IpcErrorCode as TransportErrorCode } from './ipc/errors.js';

/** Per-call options common to every transport. */
export interface CallOptions {
  /** Per-call timeout in ms, overriding the client default. */
  timeoutMs?: number;
}

/**
 * The common surface both daemon transports implement. `call()` resolves with
 * the daemon RPC `result` directly; failures reject with a `TransportError`
 * carrying a code from the shared closed set.
 */
export interface MxTransport {
  /** Invoke a daemon RPC method and resolve with its `result`. */
  call(method: string, params?: unknown, options?: CallOptions): Promise<unknown>;
  /** Convenience: `daemon.status`. */
  status(options?: CallOptions): Promise<DaemonStatus>;
  /** Convenience: `daemon.ping`. */
  ping(options?: CallOptions): Promise<unknown>;
  /** Release any transport resources held by the client. */
  close(): Promise<void>;
}
