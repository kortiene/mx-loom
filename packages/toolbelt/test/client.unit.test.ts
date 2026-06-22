import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClient, MxClient } from '../src/client.js';
import type { MxClientOptions } from '../src/client.js';
import type { DaemonStatus } from '../src/ipc/types.js';
import { TransportError } from '../src/transport.js';
import type { CallOptions, MxTransport, TransportErrorCode } from '../src/transport.js';

// --- A scriptable fake transport ----------------------------------------
//
// Each behavior is consumed by one call(); the LAST behavior repeats for any
// further calls, so `fake({ result })` is "always succeed" and
// `fake({ err: 'not_running' })` is "always not_running". No socket, no
// subprocess — deterministic failure codes for selection/retry assertions.

type Behavior = { result: unknown } | { err: TransportErrorCode };

class FakeTransport implements MxTransport {
  callCount = 0;
  closeCount = 0;
  readonly seenParams: unknown[] = [];
  readonly #behaviors: Behavior[];

  constructor(...behaviors: Behavior[]) {
    this.#behaviors = behaviors.length > 0 ? behaviors : [{ result: undefined }];
  }

  async call(method: string, params?: unknown, _options?: CallOptions): Promise<unknown> {
    this.callCount++;
    this.seenParams.push(params);
    const idx = Math.min(this.callCount - 1, this.#behaviors.length - 1);
    const b = this.#behaviors[idx];
    if (b !== undefined && 'err' in b) throw new TransportError(b.err, `fake ${b.err} for ${method}`);
    return b !== undefined && 'result' in b ? b.result : undefined;
  }

  async status(options?: CallOptions): Promise<DaemonStatus> {
    return (await this.call('daemon.status', undefined, options)) as DaemonStatus;
  }

  async ping(options?: CallOptions): Promise<unknown> {
    return await this.call('daemon.ping', undefined, options);
  }

  async close(): Promise<void> {
    this.closeCount++;
  }
}

const STATUS: DaemonStatus = {
  running: true,
  pid: 4242,
  uptime_seconds: 10,
  socket_path: '/tmp/mx-agent/daemon.sock',
  version: '0.2.1',
};

describe('MxClient — transport selection (auto)', () => {
  let dir: string;
  let presentSocket: string; // a real (empty) file → existsSync true
  let absentSocket: string; // never created → existsSync false

  // Factory bookkeeping shared per-test.
  let ipc: FakeTransport;
  let cli: FakeTransport;
  let ipcConstructed: number;
  let cliConstructed: number;

  /** Build an MxClient wired to the two fakes, counting lazy construction. */
  function build(opts: Partial<MxClientOptions> & { socketPath: string }): MxClient {
    ipcConstructed = 0;
    cliConstructed = 0;
    return new MxClient({
      retry: false, // isolate selection from retry unless a test opts in
      ipcFactory: () => {
        ipcConstructed++;
        return ipc;
      },
      cliFactory: () => {
        cliConstructed++;
        return cli;
      },
      ...opts,
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mxl-mxclient-'));
    presentSocket = join(dir, 'present.sock');
    absentSocket = join(dir, 'absent.sock');
    writeFileSync(presentSocket, ''); // make existsSync(presentSocket) === true
    ipc = new FakeTransport({ result: STATUS });
    cli = new FakeTransport({ result: STATUS });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('socket present + healthy IPC → uses IPC, never constructs the CLI client', async () => {
    const mx = build({ socketPath: presentSocket });
    const result = await mx.status();
    expect(result).toEqual(STATUS);
    expect(ipc.callCount).toBe(1);
    expect(cliConstructed).toBe(0);
    expect(mx.activeTransport).toBe('ipc');
  });

  it('absent socket (fast-path) → goes straight to CLI; IPC never attempted (AC 2)', async () => {
    const mx = build({ socketPath: absentSocket });
    const result = await mx.status();
    expect(result).toEqual(STATUS);
    expect(cli.callCount).toBe(1);
    expect(ipcConstructed).toBe(0); // IPC client never even built
    expect(mx.activeTransport).toBe('cli');
  });

  it('socket present but IPC rejects not_running (stale socket) → fails over to CLI', async () => {
    ipc = new FakeTransport({ err: 'not_running' });
    cli = new FakeTransport({ result: STATUS });
    const mx = build({ socketPath: presentSocket });
    const result = await mx.status();
    expect(result).toEqual(STATUS);
    expect(ipc.callCount).toBe(1);
    expect(cli.callCount).toBe(1);
    expect(mx.activeTransport).toBe('cli');
  });

  it.each(['timeout', 'rpc', 'closed', 'connect_failed', 'frame', 'protocol'] as const)(
    'IPC rejects %s → does NOT fail over (safety invariant), error propagates',
    async (code) => {
      ipc = new FakeTransport({ err: code });
      cli = new FakeTransport({ result: STATUS });
      const mx = build({ socketPath: presentSocket });
      const err = await mx.status().catch((e: unknown) => e);
      expect((err as TransportError).code).toBe(code);
      expect(cliConstructed).toBe(0); // CLI must never be reached
    },
  );

  it('both transports not_running → single combined error naming both paths, no secrets', async () => {
    ipc = new FakeTransport({ err: 'not_running' });
    cli = new FakeTransport({ err: 'not_running' });
    const mx = build({ socketPath: presentSocket, cliBin: '/opt/mx-agent' });
    const err = await mx.status().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).code).toBe('not_running');
    const msg = (err as TransportError).message;
    expect(msg).toContain(presentSocket); // socket path named
    expect(msg).toContain('/opt/mx-agent'); // CLI bin named
  });

  it('absent socket + CLI not_running → combined error marks the socket absent', async () => {
    cli = new FakeTransport({ err: 'not_running' });
    const mx = build({ socketPath: absentSocket, cliBin: '/opt/mx-agent' });
    const err = await mx.status().catch((e: unknown) => e);
    expect((err as TransportError).code).toBe('not_running');
    expect(ipcConstructed).toBe(0);
    expect((err as TransportError).message).toContain('absent');
  });

  it('activeTransport reflects the answering transport; sticky selection skips re-probing', async () => {
    ipc = new FakeTransport({ result: STATUS }, { result: STATUS });
    const mx = build({ socketPath: presentSocket });
    await mx.status();
    expect(mx.activeTransport).toBe('ipc');
    // Remove the socket: a non-sticky client would re-probe and switch to CLI.
    rmSync(presentSocket, { force: true });
    await mx.status();
    expect(ipc.callCount).toBe(2); // reused IPC, did NOT re-probe to CLI
    expect(cliConstructed).toBe(0);
    expect(mx.activeTransport).toBe('ipc');
  });

  it('status() and ping() both go through selection', async () => {
    const mx = build({ socketPath: presentSocket });
    await mx.status();
    await mx.ping();
    expect(ipc.seenParams).toHaveLength(2);
    expect(ipc.callCount).toBe(2);
  });

  it('close() releases only the transport(s) that were constructed', async () => {
    const mx = build({ socketPath: presentSocket });
    await mx.status(); // constructs IPC only
    await mx.close();
    expect(ipc.closeCount).toBe(1);
    expect(cli.closeCount).toBe(0); // CLI never built → never closed
    expect(mx.activeTransport).toBeNull();
  });

  it('close() closes both IPC and CLI transports when failover happened', async () => {
    ipc = new FakeTransport({ err: 'not_running' });
    cli = new FakeTransport({ result: STATUS });
    const mx = build({ socketPath: presentSocket });
    await mx.status(); // IPC fails → failover to CLI; both transports constructed
    await mx.close();
    expect(ipc.closeCount).toBe(1); // IPC was constructed (even though it failed)
    expect(cli.closeCount).toBe(1); // CLI was constructed and answered
    expect(mx.activeTransport).toBeNull();
  });

  it('sticky active transport going not_running triggers a fresh re-selection', async () => {
    ipc = new FakeTransport({ result: STATUS }, { err: 'not_running' });
    cli = new FakeTransport({ result: STATUS });
    const mx = build({ socketPath: presentSocket });
    // First call: IPC answers → sticky on IPC
    await mx.status();
    expect(mx.activeTransport).toBe('ipc');
    // Remove the socket so #select() fast-paths to CLI without a third IPC attempt
    rmSync(presentSocket, { force: true });
    // Second call: sticky IPC returns not_running → re-selects; absent socket → CLI directly
    const result = await mx.status();
    expect(result).toEqual(STATUS);
    expect(mx.activeTransport).toBe('cli');
    expect(ipc.callCount).toBe(2); // sticky success + sticky not_running (no re-probe)
    expect(cli.callCount).toBe(1);
  });

  it('close() before any call is a safe no-op (activeTransport remains null, no transport closed)', async () => {
    const mx = build({ socketPath: presentSocket });
    await expect(mx.close()).resolves.toBeUndefined();
    expect(mx.activeTransport).toBeNull();
    expect(ipc.closeCount).toBe(0);
    expect(cli.closeCount).toBe(0);
  });

  it('close() called twice is safe — the second call is a no-op, transport close not invoked again', async () => {
    const mx = build({ socketPath: presentSocket });
    await mx.status(); // constructs IPC only
    await mx.close();
    expect(ipc.closeCount).toBe(1);
    await mx.close(); // transports are now null — should be a no-op
    expect(ipc.closeCount).toBe(1); // still 1, not incremented
    expect(mx.activeTransport).toBeNull();
  });

  it('IPC returns invalid_args → does NOT fail over (safety invariant, all non-not_running codes)', async () => {
    ipc = new FakeTransport({ err: 'invalid_args' });
    const mx = build({ socketPath: presentSocket });
    // Pass clean params so the hoisted guard does not fire first
    const err = await mx.call('some.method', { agent_id: 'clean-non-credential-arg' }).catch((e: unknown) => e);
    expect((err as TransportError).code).toBe('invalid_args');
    expect(cliConstructed).toBe(0); // CLI must never be reached
  });
});

describe('MxClient — forced transports', () => {
  let dir: string;
  let presentSocket: string;
  let ipc: FakeTransport;
  let cli: FakeTransport;
  let ipcConstructed: number;
  let cliConstructed: number;

  function build(opts: Partial<MxClientOptions>): MxClient {
    ipcConstructed = 0;
    cliConstructed = 0;
    return new MxClient({
      retry: false,
      ipcFactory: () => {
        ipcConstructed++;
        return ipc;
      },
      cliFactory: () => {
        cliConstructed++;
        return cli;
      },
      ...opts,
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mxl-mxclient-forced-'));
    presentSocket = join(dir, 'present.sock');
    writeFileSync(presentSocket, '');
    ipc = new FakeTransport({ result: STATUS });
    cli = new FakeTransport({ result: STATUS });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("transport:'ipc' never spawns the CLI even when IPC fails", async () => {
    ipc = new FakeTransport({ err: 'not_running' });
    const mx = build({ transport: 'ipc', socketPath: presentSocket });
    await expect(mx.status()).rejects.toMatchObject({ code: 'not_running' });
    expect(cliConstructed).toBe(0);
  });

  it("transport:'cli' never opens the socket", async () => {
    const mx = build({ transport: 'cli', socketPath: presentSocket });
    const result = await mx.status();
    expect(result).toEqual(STATUS);
    expect(ipcConstructed).toBe(0);
    expect(mx.activeTransport).toBe('cli');
  });
});

describe('MxClient — retry composes with failover', () => {
  let dir: string;
  let presentSocket: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mxl-mxclient-retry-'));
    presentSocket = join(dir, 'present.sock');
    writeFileSync(presentSocket, '');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('IPC connect_failed is retried, then a terminal not_running hands off to CLI', async () => {
    const ipc = new FakeTransport({ err: 'connect_failed' }, { err: 'connect_failed' }, { err: 'not_running' });
    const cli = new FakeTransport({ result: STATUS });
    const mx = new MxClient({
      socketPath: presentSocket,
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, factor: 2, jitter: false, retryableCodes: ['connect_failed'] },
      sleep: async () => {},
      ipcFactory: () => ipc,
      cliFactory: () => cli,
    });
    const result = await mx.status();
    expect(result).toEqual(STATUS);
    expect(ipc.callCount).toBe(3); // two retries + the terminal not_running
    expect(cli.callCount).toBe(1);
    expect(mx.activeTransport).toBe('cli');
  });

  it('retry:false → exactly one attempt per transport', async () => {
    const ipc = new FakeTransport({ err: 'connect_failed' });
    const cli = new FakeTransport({ result: STATUS });
    const mx = new MxClient({
      socketPath: presentSocket,
      retry: false,
      ipcFactory: () => ipc,
      cliFactory: () => cli,
    });
    // connect_failed does NOT trigger failover, so this rejects after one IPC try.
    await expect(mx.status()).rejects.toMatchObject({ code: 'connect_failed' });
    expect(ipc.callCount).toBe(1);
  });

  it('IPC connect_failed retried then succeeds → activeTransport is ipc and CLI is never constructed', async () => {
    let cliConstructed = 0;
    const ipc = new FakeTransport({ err: 'connect_failed' }, { result: STATUS });
    const mx = new MxClient({
      socketPath: presentSocket,
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, factor: 2, jitter: false, retryableCodes: ['connect_failed'] },
      sleep: async () => {},
      ipcFactory: () => ipc,
      cliFactory: () => { cliConstructed++; return new FakeTransport({ result: STATUS }); },
    });
    const result = await mx.status();
    expect(result).toEqual(STATUS);
    expect(ipc.callCount).toBe(2); // one connect_failed + one success
    expect(cliConstructed).toBe(0); // CLI never constructed — retry on IPC, not failover
    expect(mx.activeTransport).toBe('ipc');
  });
});

describe('MxClient — credential guard (both transports)', () => {
  let dir: string;
  let presentSocket: string;
  let absentSocket: string;
  let ipcConstructed: number;
  let cliConstructed: number;

  function build(opts: Partial<MxClientOptions> & { socketPath: string }): MxClient {
    ipcConstructed = 0;
    cliConstructed = 0;
    return new MxClient({
      retry: false,
      ipcFactory: () => {
        ipcConstructed++;
        return new FakeTransport({ result: STATUS });
      },
      cliFactory: () => {
        cliConstructed++;
        return new FakeTransport({ result: STATUS });
      },
      ...opts,
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mxl-mxclient-cred-'));
    presentSocket = join(dir, 'present.sock');
    absentSocket = join(dir, 'absent.sock');
    writeFileSync(presentSocket, '');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a credential-shaped arg on transport:'ipc' BEFORE dispatch (invalid_args)", async () => {
    const mx = build({ transport: 'ipc', socketPath: presentSocket });
    await expect(mx.call('agent.register', { api_key: 'x' })).rejects.toMatchObject({ code: 'invalid_args' });
    expect(ipcConstructed).toBe(0); // guard fired before the transport was even built
  });

  it("rejects a credential-shaped arg on transport:'cli' BEFORE dispatch (invalid_args)", async () => {
    const mx = build({ transport: 'cli', socketPath: absentSocket });
    await expect(mx.call('agent.register', { token: 'x' })).rejects.toMatchObject({ code: 'invalid_args' });
    expect(cliConstructed).toBe(0);
  });

  it('rejects a credential-shaped value (gh_ prefix) on the auto path', async () => {
    const mx = build({ socketPath: presentSocket });
    await expect(mx.call('agent.register', { name: 'ghp_aaaaaaaaaaaaaaaaaaaa' })).rejects.toMatchObject({
      code: 'invalid_args',
    });
  });

  it('the rejection message never contains the secret value', async () => {
    const secret = 'ghp_MUST_NOT_LEAK_INTO_MESSAGE';
    const mx = build({ socketPath: presentSocket });
    const err = await mx.call('agent.register', { name: secret }).catch((e: unknown) => e);
    expect((err as TransportError).message).not.toContain(secret);
  });
});

describe('MxClient — redaction-safe diagnostics', () => {
  let dir: string;
  let presentSocket: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mxl-mxclient-log-'));
    presentSocket = join(dir, 'present.sock');
    writeFileSync(presentSocket, '');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('selection/failover/retry logs carry no param values', async () => {
    const logs: string[] = [];
    const ipc = new FakeTransport({ err: 'connect_failed' }, { err: 'not_running' });
    const cli = new FakeTransport({ result: STATUS });
    const mx = new MxClient({
      socketPath: presentSocket,
      retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, factor: 2, jitter: false, retryableCodes: ['connect_failed'] },
      sleep: async () => {},
      debug: (line) => logs.push(line),
      ipcFactory: () => ipc,
      cliFactory: () => cli,
    });
    const sentinel = 'SENSITIVE_PARAM_VALUE_42';
    await mx.call('agent.register', { workspace: sentinel });
    expect(logs.length).toBeGreaterThan(0); // we actually logged retry + failover
    for (const line of logs) {
      expect(line).not.toContain(sentinel);
    }
    // The log lines mention only code / transport / attempt tokens.
    expect(logs.join('\n')).toMatch(/retry ipc connect_failed attempt 1/);
  });

  it('debug sink receives "socket absent" message on the absent-socket fast-path', async () => {
    const logs: string[] = [];
    let ipcConstructed = 0;
    const absentSocket = join(dir, 'absent.sock');
    const mx = new MxClient({
      socketPath: absentSocket,
      retry: false,
      debug: (line) => logs.push(line),
      ipcFactory: () => { ipcConstructed++; return new FakeTransport({ result: STATUS }); },
      cliFactory: () => new FakeTransport({ result: STATUS }),
    });
    await mx.status();
    expect(logs.some((l) => l.includes('absent'))).toBe(true);
    expect(ipcConstructed).toBe(0); // IPC never constructed on the fast-path
  });

  it('debug sink receives sticky re-selection message when the sticky transport goes not_running', async () => {
    const logs: string[] = [];
    const stickyIpc = new FakeTransport({ result: STATUS }, { err: 'not_running' });
    const stickyCliTransport = new FakeTransport({ result: STATUS });
    const mx = new MxClient({
      socketPath: presentSocket,
      retry: false,
      debug: (line) => logs.push(line),
      ipcFactory: () => stickyIpc,
      cliFactory: () => stickyCliTransport,
    });
    await mx.status(); // first call: IPC answers → sticky
    logs.length = 0; // clear logs from the first call
    await mx.status(); // second call: sticky IPC → not_running → re-selects
    expect(logs.some((l) => l.includes('sticky'))).toBe(true);
    expect(mx.activeTransport).toBe('cli');
  });
});

describe('createClient', () => {
  it('returns an MxClient with auto defaults', () => {
    const mx = createClient();
    expect(mx).toBeInstanceOf(MxClient);
    expect(mx.activeTransport).toBeNull();
  });

  // Compile-checked usage snippet so the public example cannot rot: the common
  // path is `createClient()` → `status()`, both typed against the public API.
  it('exposes the documented surface (compile-checked example)', () => {
    const example = async (): Promise<DaemonStatus> => {
      const mx = createClient();
      try {
        return await mx.status();
      } finally {
        await mx.close();
      }
    };
    expect(typeof example).toBe('function');
  });
});
