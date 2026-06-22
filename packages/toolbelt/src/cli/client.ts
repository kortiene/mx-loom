import { spawn } from 'node:child_process';

import { assertNoCredentialShapedArgs } from '../guards.js';
import { MAX_FRAME_BYTES } from '../ipc/framing.js';
import type { DaemonStatus, JsonRpcErrorBody } from '../ipc/types.js';
import { TransportError } from '../transport.js';
import type { CallOptions, MxTransport } from '../transport.js';
import { safeSubprocessEnv } from './env.js';
import { methodToArgv } from './method-map.js';

export interface CliClientOptions {
  /**
   * Path/name of the mx-agent CLI. Default: `MXL_AGENT_BIN` from {@link env}
   * (parent process only — never forwarded to the child), else `mx-agent` on
   * `PATH`. The constructor option always wins (tests inject a fixture script).
   *
   * Note: do NOT use `MX_AGENT_BIN` — the `MX_AGENT_` deny prefix would
   * (correctly) refuse to forward it; the mx-loom-namespaced `MXL_AGENT_BIN`
   * is the toolbelt's own non-secret override.
   */
  cliBin?: string;
  /** Environment used for bin resolution + as the allowlist source. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Default per-call timeout in ms. Default: 30_000 (matches `IpcClient`). */
  defaultTimeoutMs?: number;
  /** Optional extra NON-secret env keys the CLI legitimately needs (deny-prefixed keys dropped even here). */
  extraEnvAllow?: readonly string[];
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Extract a JSON-RPC-style `{error:{code:number, message:string}}` if present. */
function asRpcError(parsed: unknown): JsonRpcErrorBody | undefined {
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const err = (parsed as { error?: unknown }).error;
  if (err === null || typeof err !== 'object') return undefined;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (typeof code === 'number' && typeof message === 'string') return { code, message };
  return undefined;
}

/**
 * Unwrap the CLI `--json` payload to the RPC `result` so the resolved value
 * equals what `IpcClient.call()` resolves for the same method. Handles both a
 * bare `result` (object without a `result` field → returned as-is) and a
 * wrapper (`{…, result}` / `{jsonrpc, id, result}` → `.result`). The exact
 * framing is verified live before this lands in production use (open question #1).
 */
function unwrapResult(parsed: unknown): unknown {
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && 'result' in parsed) {
    return (parsed as { result: unknown }).result;
  }
  return parsed;
}

/**
 * Normalize a finished subprocess into either the RPC `result` or a thrown
 * `TransportError`, matching the IPC client's meaning code-for-code.
 */
function normalizeExit(
  method: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  stdout: string,
  stderr: string,
): unknown {
  const parsedOut = tryParseJson(stdout);
  // A daemon-level error can surface through the CLI on stdout or stderr; treat
  // it as `rpc` regardless of exit code, extracting message + numeric code
  // exactly as IpcClient.#dispatch does.
  const rpcErr = asRpcError(parsedOut) ?? asRpcError(tryParseJson(stderr));
  if (rpcErr) {
    throw new TransportError('rpc', `${rpcErr.message} (rpc code ${rpcErr.code})`, { cause: rpcErr });
  }
  if (code === 0) {
    if (parsedOut === undefined) {
      throw new TransportError('protocol', `mx-agent ${method} exited 0 but stdout was not valid JSON`);
    }
    return unwrapResult(parsedOut);
  }
  const reason = signal ? `signal ${signal}` : `exit code ${code}`;
  throw new TransportError('protocol', `mx-agent ${method} failed (${reason}) with no parseable JSON-RPC error`);
}

function spawnErrorToTransport(err: unknown, bin: string): TransportError {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    // Binary not found — this transport cannot reach the daemon, the same
    // meaning IPC gives an absent socket, so T004 treats both uniformly.
    return new TransportError('not_running', `mx-agent CLI not found ('${bin}')`, { cause: err });
  }
  return new TransportError('connect_failed', `failed to spawn mx-agent CLI ('${bin}'): ${(err as Error).message}`, { cause: err });
}

/**
 * One-shot `mx-agent … --json` CLI client — the ADR-11 *fallback* transport
 * (T003), a standalone sibling of `IpcClient`. Each `call()` spawns the
 * mx-agent binary, parses its `--json` stdout, and resolves the **same typed
 * result** the IPC client returns for the same method (AC 1), normalizing
 * failures onto the **same closed error set** (`TransportError`). The
 * subprocess runs under a deny-by-default env allowlist so no secret reaches
 * the child (AC 2 — see {@link safeSubprocessEnv}).
 *
 * Scope (T003): raw transport only. Transport selection / IPC→CLI failover is
 * T004; the result envelope and `mx_*` tools are M1.
 */
export class CliClient implements MxTransport {
  readonly #cliBin: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #defaultTimeoutMs: number;
  readonly #extraEnvAllow: readonly string[];

  constructor(options: CliClientOptions = {}) {
    this.#env = options.env ?? process.env;
    // `MXL_AGENT_BIN` is read from the PARENT env only and is never forwarded
    // to the child (it is not in BASE_ENV_ALLOW).
    this.#cliBin = options.cliBin ?? this.#env['MXL_AGENT_BIN'] ?? 'mx-agent';
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.#extraEnvAllow = options.extraEnvAllow ?? [];
  }

  /** The resolved mx-agent binary path/name this client will spawn. */
  get cliBin(): string {
    return this.#cliBin;
  }

  /** Invoke a daemon RPC method via the CLI and resolve with its `result`. */
  async call(method: string, params?: unknown, options: CallOptions = {}): Promise<unknown> {
    // 1. Reject credential-shaped args BEFORE anything becomes argv.
    assertNoCredentialShapedArgs(params);
    // 2. Map method → argv (+ optional stdin payload).
    const plan = methodToArgv(method, params);
    // 3. Deny-by-default scrubbed env (AC 2).
    const env = safeSubprocessEnv({ source: this.#env, extraAllow: this.#extraEnvAllow });
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    return await this.#spawn(method, plan.argv, plan.stdin, env, timeoutMs);
  }

  /** Convenience: `daemon.status`. */
  async status(options?: CallOptions): Promise<DaemonStatus> {
    return (await this.call('daemon.status', undefined, options)) as DaemonStatus;
  }

  /** Convenience: `daemon.ping`. */
  async ping(options?: CallOptions): Promise<unknown> {
    return await this.call('daemon.ping', undefined, options);
  }

  /**
   * No-op: each call is its own short-lived subprocess, so there is nothing
   * persistent to release. Present for `MxTransport` symmetry with `IpcClient`.
   */
  async close(): Promise<void> {
    /* nothing to release */
  }

  #spawn(
    method: string,
    argv: string[],
    stdin: string | undefined,
    env: Record<string, string>,
    timeoutMs: number,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.#cliBin, argv, {
          env,
          stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        reject(spawnErrorToTransport(err, this.#cliBin));
        return;
      }

      let settled = false;
      let overflow = false;
      let outLen = 0;
      let errLen = 0;
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        settle(() => reject(new TransportError('timeout', `mx-agent ${method} exceeded ${timeoutMs}ms`)));
      }, timeoutMs);
      timer.unref();

      // Bounded capture so a misbehaving CLI cannot exhaust memory.
      const capture = (chunks: Buffer[], len: number, chunk: Buffer): number => {
        const next = len + chunk.length;
        if (next > MAX_FRAME_BYTES) {
          overflow = true;
          child.kill('SIGKILL');
          return next;
        }
        chunks.push(chunk);
        return next;
      };
      child.stdout?.on('data', (chunk: Buffer) => {
        outLen = capture(outChunks, outLen, chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        errLen = capture(errChunks, errLen, chunk);
      });

      child.on('error', (err) => settle(() => reject(spawnErrorToTransport(err, this.#cliBin))));

      if (stdin !== undefined && child.stdin) {
        child.stdin.on('error', () => {
          /* ignore EPIPE if the child exits before reading stdin */
        });
        child.stdin.end(stdin);
      }

      child.on('close', (code, signal) => {
        settle(() => {
          if (overflow) {
            reject(new TransportError('protocol', `mx-agent ${method} produced oversized output`));
            return;
          }
          try {
            resolve(
              normalizeExit(
                method,
                code,
                signal,
                Buffer.concat(outChunks).toString('utf8'),
                Buffer.concat(errChunks).toString('utf8'),
              ),
            );
          } catch (err) {
            reject(err);
          }
        });
      });
    });
  }
}
