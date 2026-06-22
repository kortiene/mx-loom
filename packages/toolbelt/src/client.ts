/**
 * The unified mx-agent daemon client (T004) — the single typed entry point
 * "all callers use" across Boundary B.
 *
 * It holds either underlying transport behind the existing {@link MxTransport}
 * interface, **selects** between them (IPC primary, CLI fallback), and applies a
 * **conservative, idempotency-safe** retry/backoff policy. `MxClient` *is* an
 * `MxTransport`, so it is a drop-in for anything already typed against the seam,
 * and the M1 registry/binding layers build on it without re-plumbing.
 *
 * Failover safety invariant: the auto selector fails over IPC→CLI **only on
 * `not_running`** — the one code that provably means *no request was
 * dispatched* (the IPC client raises it from the connect phase, before any byte
 * is written). Every other code (`timeout`, `rpc`, `closed`, `connect_failed`,
 * `frame`, `protocol`) may mean the request reached the daemon or the daemon
 * gave a real answer, so re-issuing it on the CLI could double-execute a
 * mutating call or mask a genuine error. Until `idempotency_key` is plumbed
 * (M1) the client must not take that risk.
 *
 * Scope: still raw transport — `call()` resolves the daemon RPC `result`
 * directly. The model-facing result envelope (`{status, result, error, …}`),
 * the `mx_*` tools, and `audit_ref` are M1 (T101–T108), not here.
 */
import { existsSync } from 'node:fs';

import { CliClient } from './cli/client.js';
import { assertNoCredentialShapedArgs, redactSecrets } from './guards.js';
import { IpcClient } from './ipc/client.js';
import { resolveSocketPath } from './ipc/socket-path.js';
import type { DaemonStatus } from './ipc/types.js';
import { DEFAULT_RETRY_POLICY, withRetry } from './retry.js';
import type { RetryPolicy } from './retry.js';
import { TransportError } from './transport.js';
import type { CallOptions, MxTransport } from './transport.js';

/** Which transport(s) the unified client uses. */
export type TransportPreference =
  | 'auto' // default: prefer IPC, fall back to CLI when the socket is absent
  | 'ipc' // force the framed Unix-socket client; never spawn the CLI
  | 'cli'; // force the one-shot CLI; never open the socket

export interface MxClientOptions {
  /** Transport preference. Default: `'auto'`. */
  transport?: TransportPreference;
  /** Explicit daemon socket path (forwarded to the IPC client + the absent-socket fast-path probe). */
  socketPath?: string;
  /** mx-agent CLI bin override (forwarded to the CLI client; non-secret, e.g. tests' fixture). */
  cliBin?: string;
  /** Environment for socket/bin resolution + the CLI allowlist source. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Default per-call timeout in ms (forwarded to both transports). Default: 30_000. */
  defaultTimeoutMs?: number;
  /** Retry/backoff policy, or `false` to disable retries. Default: {@link DEFAULT_RETRY_POLICY}. */
  retry?: RetryPolicy | false;
  /**
   * Injected transport factories (testing seam). Default: construct the real
   * {@link IpcClient} / {@link CliClient}. Lets unit tests substitute fakes with
   * deterministic failure codes without a socket or a subprocess.
   */
  ipcFactory?: (options: MxClientOptions) => MxTransport;
  cliFactory?: (options: MxClientOptions) => MxTransport;
  /** Injected backoff timer (testing seam). Default: real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected jitter RNG (testing seam). Default: `Math.random`. */
  random?: () => number;
  /**
   * Redaction-safe diagnostics sink for selection/failover/retry. Receives
   * lines carrying ONLY the error code, transport name, socket path, CLI bin
   * name, and attempt number — never params, env values, or raw output.
   * Default: a no-op (retries are silent).
   */
  debug?: (line: string) => void;
}

function defaultIpcFactory(o: MxClientOptions): MxTransport {
  return new IpcClient({ socketPath: o.socketPath, env: o.env, defaultTimeoutMs: o.defaultTimeoutMs });
}

function defaultCliFactory(o: MxClientOptions): MxTransport {
  // Forward only non-secret resolution inputs. The CLI client re-derives its
  // deny-by-default env allowlist internally — composing transports must not
  // widen the env surface (design §6 / T008).
  return new CliClient({ cliBin: o.cliBin, env: o.env, defaultTimeoutMs: o.defaultTimeoutMs });
}

function isNotRunning(err: unknown): err is TransportError {
  return err instanceof TransportError && err.code === 'not_running';
}

/**
 * Unified client: IPC primary, CLI fallback, behind one {@link MxTransport}.
 *
 * ```ts
 * const mx = createClient();        // transport: 'auto'
 * const status = await mx.status(); // round-trips daemon.status (IPC, or CLI if the socket is absent)
 * await mx.close();
 * ```
 */
export class MxClient implements MxTransport {
  readonly #options: MxClientOptions;
  readonly #preference: TransportPreference;
  readonly #retry: RetryPolicy | false;
  readonly #socketPath: string;
  readonly #cliBinLabel: string;
  readonly #ipcFactory: (o: MxClientOptions) => MxTransport;
  readonly #cliFactory: (o: MxClientOptions) => MxTransport;
  readonly #sleep: ((ms: number) => Promise<void>) | undefined;
  readonly #random: (() => number) | undefined;
  readonly #debug: (line: string) => void;

  #ipc: MxTransport | null = null;
  #cli: MxTransport | null = null;
  #active: 'ipc' | 'cli' | null = null;

  constructor(options: MxClientOptions = {}) {
    // Resolve defaults once; the resolved object is what the factories receive.
    this.#options = { ...options, defaultTimeoutMs: options.defaultTimeoutMs ?? 30_000 };
    this.#preference = options.transport ?? 'auto';
    this.#retry = options.retry === undefined ? DEFAULT_RETRY_POLICY : options.retry;
    this.#socketPath = resolveSocketPath({ socketPath: options.socketPath, env: options.env });
    // Non-secret CLI bin label for diagnostics / the combined-unreachable error,
    // resolved exactly as CliClient does (MXL_AGENT_BIN is parent-only, non-secret).
    this.#cliBinLabel = options.cliBin ?? (options.env ?? process.env)['MXL_AGENT_BIN'] ?? 'mx-agent';
    this.#ipcFactory = options.ipcFactory ?? defaultIpcFactory;
    this.#cliFactory = options.cliFactory ?? defaultCliFactory;
    this.#sleep = options.sleep;
    this.#random = options.random;
    this.#debug = options.debug ?? (() => {});
  }

  /** Which transport answered the most recent call (`'ipc' | 'cli' | null`). Observability only. */
  get activeTransport(): 'ipc' | 'cli' | null {
    return this.#active;
  }

  /** Invoke a daemon RPC method and resolve with its `result`. */
  async call(method: string, params?: unknown, options?: CallOptions): Promise<unknown> {
    // Outbound (existing): hoisted credential guard — runs BEFORE dispatch to
    // EITHER transport, so a credential-shaped arg is rejected uniformly (closes
    // the IPC-path gap).
    assertNoCredentialShapedArgs(params);

    let result: unknown;
    switch (this.#preference) {
      case 'ipc':
        result = await this.#attempt('ipc', method, params, options);
        break;
      case 'cli':
        result = await this.#attempt('cli', method, params, options);
        break;
      default:
        result = await this.#callAuto(method, params, options);
    }

    // Inbound (T008): defense-in-depth result redaction at the single call()
    // exit point — covers IPC, CLI, retry, and failover uniformly, exactly once
    // per logical call. The daemon owns secrets out-of-process and must never
    // return one; this is the backstop if a daemon bug ever surfaced a
    // token-shaped value into a result the model would read.
    return redactSecrets(result, (path) =>
      this.#debug(`redacted secret-shaped value in ${method} result at ${path}`),
    );
  }

  /** Convenience: `daemon.status`. Inherits selection + retry via {@link call}. */
  async status(options?: CallOptions): Promise<DaemonStatus> {
    return (await this.call('daemon.status', undefined, options)) as DaemonStatus;
  }

  /** Convenience: `daemon.ping`. Inherits selection + retry via {@link call}. */
  async ping(options?: CallOptions): Promise<unknown> {
    return await this.call('daemon.ping', undefined, options);
  }

  /** Release whichever transport(s) were actually constructed — and only those. */
  async close(): Promise<void> {
    const closing: Promise<void>[] = [];
    if (this.#ipc) closing.push(this.#ipc.close());
    if (this.#cli) closing.push(this.#cli.close());
    this.#ipc = null;
    this.#cli = null;
    this.#active = null;
    await Promise.all(closing);
  }

  // --- selection ---------------------------------------------------------

  async #callAuto(method: string, params: unknown, options?: CallOptions): Promise<unknown> {
    // Sticky fast path: reuse the transport that last answered, re-selecting
    // only if it now returns `not_running`.
    if (this.#active !== null) {
      try {
        return await this.#attempt(this.#active, method, params, options);
      } catch (err) {
        if (!isNotRunning(err)) throw err;
        this.#debug(`sticky ${this.#active} → not_running; re-selecting`);
        this.#active = null;
        // fall through to a fresh selection
      }
    }
    return await this.#select(method, params, options);
  }

  async #select(method: string, params: unknown, options?: CallOptions): Promise<unknown> {
    let ipcErr: TransportError | undefined;

    // Fast-path absent-socket check: skip IPC entirely when the socket file is
    // absent (AC 2) and go straight to the CLI, avoiding a guaranteed-failing
    // connect.
    if (existsSync(this.#socketPath)) {
      try {
        return await this.#attempt('ipc', method, params, options);
      } catch (err) {
        // Safety invariant: fail over ONLY on `not_running`.
        if (!isNotRunning(err)) throw err;
        ipcErr = err;
        this.#debug(`ipc not_running → failover to cli`);
      }
    } else {
      this.#debug(`socket absent → cli (fast-path)`);
    }

    try {
      return await this.#attempt('cli', method, params, options);
    } catch (err) {
      if (isNotRunning(err)) throw this.#bothUnreachableError(err, ipcErr);
      throw err;
    }
  }

  async #attempt(which: 'ipc' | 'cli', method: string, params: unknown, options?: CallOptions): Promise<unknown> {
    const transport = which === 'ipc' ? this.#getIpc() : this.#getCli();
    const run = (): Promise<unknown> => transport.call(method, params, options);

    const result =
      this.#retry === false
        ? await run()
        : await withRetry(run, this.#retry, {
            sleep: this.#sleep,
            random: this.#random,
            onRetry: (code, attempt) => this.#debug(`retry ${which} ${code} attempt ${attempt}`),
          });

    this.#active = which;
    return result;
  }

  #getIpc(): MxTransport {
    if (!this.#ipc) this.#ipc = this.#ipcFactory(this.#options);
    return this.#ipc;
  }

  #getCli(): MxTransport {
    if (!this.#cli) this.#cli = this.#cliFactory(this.#options);
    return this.#cli;
  }

  /**
   * Build the single combined error when neither transport can reach the
   * daemon. Names both attempted paths (socket path + CLI bin) — never any arg
   * or env value — so it stays secret-free.
   */
  #bothUnreachableError(cliErr: TransportError, ipcErr?: TransportError): TransportError {
    const ipcPart = ipcErr ? `IPC socket '${this.#socketPath}' not running` : `IPC socket '${this.#socketPath}' absent`;
    return new TransportError(
      'not_running',
      `daemon unreachable: ${ipcPart} and mx-agent CLI '${this.#cliBinLabel}' not found`,
      { cause: cliErr },
    );
  }
}

/** Construct an {@link MxClient} with sensible defaults — the common case is `createClient()`. */
export function createClient(options?: MxClientOptions): MxClient {
  return new MxClient(options);
}
