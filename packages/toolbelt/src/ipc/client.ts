import { connect, type Socket } from 'node:net';

import { IpcError } from './errors.js';
import { encodeFrame, FrameDecoder } from './framing.js';
import { resolveSocketPath } from './socket-path.js';
import type { DaemonStatus, JsonRpcResponse } from './types.js';

export interface IpcClientOptions {
  /** Explicit socket path; otherwise resolved from the environment. */
  socketPath?: string;
  /** Environment used for socket-path resolution. */
  env?: NodeJS.ProcessEnv;
  /** Default per-call timeout in ms. Default: 30_000. */
  defaultTimeoutMs?: number;
}

export interface CallOptions {
  /** Per-call timeout in ms, overriding the client default. */
  timeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer: NodeJS.Timeout;
}

let idCounter = 0;
function nextId(): string {
  idCounter = (idCounter + 1) >>> 0;
  return `mxl-${idCounter.toString(36)}`;
}

/**
 * Minimal framed JSON-RPC 2.0 client for the mx-agent daemon IPC socket
 * (Boundary B). One persistent connection multiplexes concurrent calls,
 * correlated by request id; the connection is established lazily on first call.
 *
 * Scope (T002): transport only — no tool registry, no CLI fallback (T003).
 */
export class IpcClient {
  readonly socketPath: string;
  readonly #defaultTimeoutMs: number;
  #socket: Socket | null = null;
  #connecting: Promise<Socket> | null = null;
  readonly #decoder = new FrameDecoder();
  readonly #pending = new Map<string, Pending>();

  constructor(options: IpcClientOptions = {}) {
    this.socketPath = resolveSocketPath(options);
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  }

  /** Invoke a daemon RPC method and resolve with its `result`. */
  async call(method: string, params?: unknown, options: CallOptions = {}): Promise<unknown> {
    const socket = await this.#connect();
    const id = nextId();
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;

    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new IpcError('timeout', `no response for ${method} (id ${id}) within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();

      this.#pending.set(id, { resolve, reject, timer });

      const body =
        params === undefined
          ? { jsonrpc: '2.0' as const, id, method }
          : { jsonrpc: '2.0' as const, id, method, params };
      socket.write(encodeFrame(JSON.stringify(body)), (err) => {
        if (err) {
          const entry = this.#pending.get(id);
          if (entry) {
            this.#pending.delete(id);
            clearTimeout(entry.timer);
          }
          reject(new IpcError('connect_failed', `write failed for ${method}: ${err.message}`, { cause: err }));
        }
      });
    });
  }

  /** Convenience: `daemon.status`. */
  async status(options?: CallOptions): Promise<DaemonStatus> {
    return (await this.call('daemon.status', undefined, options)) as DaemonStatus;
  }

  /** Convenience: `daemon.ping`. */
  async ping(options?: CallOptions): Promise<unknown> {
    return await this.call('daemon.ping', undefined, options);
  }

  /** Close the connection and reject any in-flight calls. */
  async close(): Promise<void> {
    this.#failAll(new IpcError('closed', 'client closed'));
    const socket = this.#socket;
    this.#socket = null;
    if (socket && !socket.destroyed) {
      await new Promise<void>((resolve) => socket.end(() => resolve()));
      socket.destroy();
    }
  }

  #connect(): Promise<Socket> {
    if (this.#socket && !this.#socket.destroyed) return Promise.resolve(this.#socket);
    if (this.#connecting) return this.#connecting;

    this.#connecting = new Promise<Socket>((resolve, reject) => {
      const socket = connect(this.socketPath);
      const onConnectError = (err: NodeJS.ErrnoException) => {
        this.#connecting = null;
        const code = err.code === 'ENOENT' || err.code === 'ECONNREFUSED' ? 'not_running' : 'connect_failed';
        reject(new IpcError(code, `cannot connect to daemon socket at ${this.socketPath}: ${err.message}`, { cause: err }));
      };
      socket.once('error', onConnectError);
      socket.once('connect', () => {
        socket.removeListener('error', onConnectError);
        socket.on('data', (chunk: Buffer) => this.#onData(chunk));
        socket.on('error', (err) => this.#failAll(new IpcError('connect_failed', `socket error: ${err.message}`, { cause: err })));
        socket.on('close', () => this.#onClose());
        this.#socket = socket;
        this.#connecting = null;
        resolve(socket);
      });
    });
    return this.#connecting;
  }

  #onData(chunk: Buffer): void {
    let frames: string[];
    try {
      frames = this.#decoder.push(chunk);
    } catch (err) {
      this.#failAll(err instanceof IpcError ? err : new IpcError('frame', 'frame decode failed', { cause: err }));
      this.#socket?.destroy();
      return;
    }
    for (const frame of frames) this.#dispatch(frame);
  }

  #dispatch(text: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(text) as JsonRpcResponse;
    } catch (err) {
      this.#failAll(new IpcError('protocol', `invalid JSON in response frame: ${(err as Error).message}`, { cause: err }));
      return;
    }
    const id = (msg as { id?: unknown }).id;
    if (typeof id !== 'string') return; // unknown / notification — nothing to correlate
    const entry = this.#pending.get(id);
    if (!entry) return;
    this.#pending.delete(id);
    clearTimeout(entry.timer);
    if ('error' in msg && msg.error) {
      entry.reject(new IpcError('rpc', `${msg.error.message} (rpc code ${msg.error.code})`, { cause: msg.error }));
    } else if ('result' in msg) {
      entry.resolve(msg.result);
    } else {
      entry.reject(new IpcError('protocol', `response for id ${id} had neither result nor error`));
    }
  }

  #onClose(): void {
    this.#socket = null;
    this.#failAll(new IpcError('closed', 'daemon connection closed'));
  }

  #failAll(err: IpcError): void {
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.#pending.clear();
  }
}
