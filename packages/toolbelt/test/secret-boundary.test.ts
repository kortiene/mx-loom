import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MxClient } from '../src/client.js';
import { CliClient } from '../src/cli/client.js';
import { safeSubprocessEnv } from '../src/cli/env.js';
import { methodToArgv } from '../src/cli/method-map.js';
import { REDACTION_PLACEHOLDER } from '../src/guards.js';
import { encodeFrame, FrameDecoder } from '../src/ipc/framing.js';
import { IpcClient } from '../src/ipc/client.js';
import type { DaemonStatus } from '../src/ipc/types.js';
import type { MxTransport } from '../src/transport.js';
import { SECRET_PATTERN } from './conformance/_harness.js';

// T008 acceptance criterion #2: "No allowlisted-secret env var appears in any
// tool payload (test asserts)." Boundary A is the runtime's tool-call ABI: the
// allowlisted secrets the rule names (`MATRIX_*`, `MX_AGENT_*`, provider keys,
// `GH_TOKEN`) must never cross it — not into the CLI child env, not onto argv,
// not into the stdin payload, and not into the IPC request frame.
//
// Representative allowlisted-secret env vars (SYNTHETIC values only — no real
// tokens, credentials, or secrets).
const SECRET_ENV: Record<string, string> = {
  MATRIX_ACCESS_TOKEN: 'syt_aFAKEmatrixaccesstoken00000',
  MATRIX_HOMESERVER: 'https://matrix.FAKE.test',
  MX_AGENT_SIGNING_KEY: 'FAKE-ed25519-private-signing-key-material',
  GH_TOKEN: 'ghp_FAKEgithubtoken0000000000',
  GITHUB_TOKEN: 'ghp_FAKEgithubtoken1111111111',
  ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEFAKEFAKEFAKEFAKE',
  OPENAI_API_KEY: 'sk-FAKEopenaikey1234567890ABCDEFGH',
  AWS_SECRET_ACCESS_KEY: 'FAKEawssecretaccesskeymaterial0000000000',
};
const SECRET_KEYS = Object.keys(SECRET_ENV);
const SECRET_VALUES = Object.values(SECRET_ENV);

/** Assert no synthetic secret value (and no secret-shaped pattern) is in `haystack`. */
function assertNoSecretIn(haystack: string): void {
  for (const value of SECRET_VALUES) {
    expect(haystack, `secret value leaked into payload (starts '${value.slice(0, 6)}…')`).not.toContain(value);
  }
  // Reuse the conformance vocabulary: not even a secret-shaped token may appear.
  expect(SECRET_PATTERN.test(haystack), `secret-shaped token matched SECRET_PATTERN in payload`).toBe(false);
}

// ---------------------------------------------------------------------------
// The env edge — safeSubprocessEnv (the allowlist source the CLI child inherits)
// ---------------------------------------------------------------------------

describe('AC#2 — safeSubprocessEnv drops every allowlisted-secret env var', () => {
  it('forwards no secret key or value when the parent env is full of secrets', () => {
    const env = safeSubprocessEnv({ source: { HOME: '/h', PATH: '/usr/bin', ...SECRET_ENV } });
    for (const key of SECRET_KEYS) expect(env).not.toHaveProperty(key);
    assertNoSecretIn(JSON.stringify(env));
    // Non-secret resolution vars still forwarded.
    expect(env).toEqual({ HOME: '/h', PATH: '/usr/bin' });
  });

  it('extraAllow cannot re-admit GH_TOKEN / *_API_KEY / *_TOKEN / *_SECRET / MATRIX_* / MX_AGENT_*', () => {
    const env = safeSubprocessEnv({
      source: {
        HOME: '/h',
        ...SECRET_ENV,
        CUSTOM_TOKEN: 'ghp_FAKEcustomtoken',
        CUSTOM_API_KEY: 'sk-FAKEcustomkey1234567890',
        APP_SECRET: 'FAKE-app-secret',
      },
      // A caller trying to widen the allowlist to known secrets must NOT succeed.
      extraAllow: [...SECRET_KEYS, 'CUSTOM_TOKEN', 'CUSTOM_API_KEY', 'APP_SECRET'],
    });
    expect(env).toEqual({ HOME: '/h' });
    assertNoSecretIn(JSON.stringify(env));
  });

  it('still forwards the non-secret MXL_AGENT_BIN override via extraAllow', () => {
    const env = safeSubprocessEnv({
      source: { HOME: '/h', MXL_AGENT_BIN: '/opt/mx-agent', GH_TOKEN: SECRET_ENV['GH_TOKEN'] },
      extraAllow: ['MXL_AGENT_BIN', 'GH_TOKEN'],
    });
    expect(env['MXL_AGENT_BIN']).toBe('/opt/mx-agent');
    expect(env).not.toHaveProperty('GH_TOKEN');
  });
});

// ---------------------------------------------------------------------------
// The CLI leg — child env + argv + stdin (real subprocess)
// ---------------------------------------------------------------------------

const FIXTURE_MJS = fileURLToPath(new URL('./fixtures/mock-mx-agent.mjs', import.meta.url));
const NODE_BIN = process.execPath;
const CALL_TIMEOUT_MS = 5_000;

describe('AC#2 — CliClient spawn carries no allowlisted-secret env var (real subprocess)', () => {
  let tmpDir: string;
  let CLI: string;
  /**
   * Polluted parent env: HOME/PATH (allowlisted) plus every representative
   * secret. A SYNTHETIC PATH keeps the child-env assertion hermetic — the
   * fixture wrapper execs absolute paths (`/bin/sh` → absolute node), so it
   * needs no real PATH, and a synthetic one cannot trip `SECRET_PATTERN`.
   */
  const pollutedEnv = (): NodeJS.ProcessEnv => ({
    HOME: '/home/fixture-test',
    PATH: '/usr/bin:/bin',
    ...SECRET_ENV,
  });

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mxl-secret-boundary-'));
    CLI = join(tmpDir, 'mock-mx-agent');
    writeFileSync(CLI, `#!/bin/sh\nexec '${NODE_BIN}' '${FIXTURE_MJS}' "$@"\n`);
    chmodSync(CLI, 0o755);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('the child process env contains no secret key or value', async () => {
    const client = new CliClient({ cliBin: CLI, env: pollutedEnv() });
    const childEnv = (await client.call('mock.dump.env', undefined, { timeoutMs: CALL_TIMEOUT_MS })) as Record<
      string,
      string
    >;
    for (const key of SECRET_KEYS) expect(childEnv).not.toHaveProperty(key);
    assertNoSecretIn(JSON.stringify(childEnv));
    // Non-secret resolution vars still reach the child.
    expect(childEnv).toHaveProperty('HOME', '/home/fixture-test');
    await client.close();
  });

  it('params ride stdin, never argv — no value lands on the world-readable command line', async () => {
    const client = new CliClient({ cliBin: CLI, env: pollutedEnv() });
    const argv = (await client.call(
      'mock.dump.argv',
      { agent_id: 'backend-01', room: '!r:srv' },
      { timeoutMs: CALL_TIMEOUT_MS },
    )) as string[];
    assertNoSecretIn(argv.join(' '));
    // The caller's params are on stdin, not argv.
    expect(argv).not.toContain('backend-01');
    await client.close();
  });

  it('the stdin payload echoes only the caller params (no env secret rides stdin)', async () => {
    const client = new CliClient({ cliBin: CLI, env: pollutedEnv() });
    const params = { agent_id: 'backend-01', capabilities: ['run_tests'] };
    // The fixture echoes its raw stdin back as stdout; CliClient parses+unwraps
    // it, so the resolved value is exactly the params it sent over stdin.
    const echoed = await client.call('mock.echo.stdin', params, { timeoutMs: CALL_TIMEOUT_MS });
    expect(echoed).toEqual(params);
    assertNoSecretIn(JSON.stringify(echoed));
    await client.close();
  });

  it('the outbound argv+stdin for a range of methods carries no env secret', () => {
    const calls: Array<[string, unknown]> = [
      ['agent.register', { kind: 'runtime', capabilities: [] }],
      ['agent.list', { room: '!room:server' }],
      ['call.start', { target: 'backend-01', tool: 'run_tests', args: { suite: 'unit' } }],
      ['daemon.status', undefined],
    ];
    for (const [method, params] of calls) {
      const plan = methodToArgv(method, params);
      assertNoSecretIn(plan.argv.join(' ') + (plan.stdin ?? ''));
    }
  });
});

// ---------------------------------------------------------------------------
// The IPC leg — the encoded request frame (raw bytes captured at the daemon)
// ---------------------------------------------------------------------------

describe('AC#2 — IpcClient request frame carries no allowlisted-secret env var', () => {
  let dir: string;
  let sock: string;
  let server: Server | undefined;
  let client: IpcClient | undefined;
  let received: Buffer[];

  /** A mock daemon that records every raw byte it receives and replies OK. */
  function captureDaemon(socketPath: string): Promise<Server> {
    return new Promise((resolve) => {
      const s = createServer((socket) => {
        const decoder = new FrameDecoder();
        socket.on('data', (chunk: Buffer) => {
          received.push(chunk);
          for (const frame of decoder.push(chunk)) {
            const req = JSON.parse(frame) as { id: string };
            socket.write(encodeFrame(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true } })));
          }
        });
        socket.on('error', () => {
          /* client close races — ignore */
        });
      });
      s.listen(socketPath, () => resolve(s));
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mxl-secret-boundary-ipc-'));
    sock = join(dir, 'd.sock');
    received = [];
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('no secret value appears in the encoded request frame across a range of calls', async () => {
    server = await captureDaemon(sock);
    // The secrets live in the (polluted) env; the IPC client builds its frame
    // from method+params ONLY, so none of them can ride the wire.
    client = new IpcClient({ socketPath: sock, env: { ...SECRET_ENV } });
    await client.call('agent.register', { kind: 'runtime', capabilities: [] });
    await client.call('agent.list', { room: '!room:server' });
    await client.call('call.start', { target: 'backend-01', tool: 'run_tests', args: { suite: 'unit' } });

    const wire = Buffer.concat(received).toString('utf8');
    assertNoSecretIn(wire);
  });
});

// ---------------------------------------------------------------------------
// Inbound redaction — CLI subprocess leaks a token → MxClient catches it
//
// The outbound tests above prove secrets can't ride from the caller *into* the
// subprocess. These tests prove the symmetric direction: if the daemon (here the
// fixture) misbehaves and returns a token-shaped value in its JSON result,
// MxClient.call's inbound redaction (T008) must replace it with
// REDACTION_PLACEHOLDER before it reaches the caller or any debug log line.
// ---------------------------------------------------------------------------

describe('AC#1/inbound — CliClient subprocess leaks a token → MxClient redacts it before caller', () => {
  let inboundDir: string;
  let inboundCLI: string;

  beforeAll(() => {
    inboundDir = mkdtempSync(join(tmpdir(), 'mxl-secret-boundary-inbound-'));
    inboundCLI = join(inboundDir, 'mock-mx-agent');
    writeFileSync(inboundCLI, `#!/bin/sh\nexec '${NODE_BIN}' '${FIXTURE_MJS}' "$@"\n`);
    chmodSync(inboundCLI, 0o755);
  });

  afterAll(() => {
    rmSync(inboundDir, { recursive: true, force: true });
  });

  it('a token-shaped value in the subprocess result is replaced with REDACTION_PLACEHOLDER', async () => {
    const debug: string[] = [];
    const mx = new MxClient({
      transport: 'cli',
      cliBin: inboundCLI,
      retry: false,
      debug: (line) => debug.push(line),
    });
    const result = (await mx.call('mock.leak.secret', undefined, { timeoutMs: CALL_TIMEOUT_MS })) as Record<
      string,
      unknown
    >;
    // The fixture returns { ok: true, leaked: 'ghp_FAKEleaked_by_daemon_bug_0000' }.
    // After inbound redaction the token is replaced; the clean field survives.
    expect(result['ok']).toBe(true);
    expect(result['leaked']).toBe(REDACTION_PLACEHOLDER);
    assertNoSecretIn(JSON.stringify(result));
    // The debug seam must fire, naming the method + path — never the value.
    const redactLines = debug.filter((l) => l.includes('redacted secret-shaped value'));
    expect(redactLines.some((l) => l.includes('mock.leak.secret') && l.includes('$.leaked'))).toBe(true);
    for (const line of debug) {
      expect(line).not.toContain('ghp_FAKEleaked_by_daemon_bug_0000');
      assertNoSecretIn(line);
    }
    await mx.close();
  });

  it('debug seam names the path at the redaction site, never the value', async () => {
    const debug: string[] = [];
    const mx = new MxClient({
      transport: 'cli',
      cliBin: inboundCLI,
      retry: false,
      debug: (line) => debug.push(line),
    });
    await mx.call('mock.leak.secret', undefined, { timeoutMs: CALL_TIMEOUT_MS });
    const redactLines = debug.filter((l) => l.includes('redacted secret-shaped value'));
    expect(redactLines).toHaveLength(1);
    // Path named, value never present.
    expect(redactLines[0]).toContain('$.leaked');
    expect(redactLines[0]).not.toContain('ghp_FAKEleaked_by_daemon_bug_0000');
    await mx.close();
  });
});

// ---------------------------------------------------------------------------
// Inbound redaction — IPC mock server leaks a token in the encoded frame
//
// Proves the same contract over the IPC transport: the real IpcClient decodes
// the frame, MxClient.call applies redactSecrets to the decoded result, and the
// caller never sees the token-shaped value — only REDACTION_PLACEHOLDER.
// ---------------------------------------------------------------------------

describe('AC#1/inbound — IPC mock server leaks a token → MxClient redacts it before caller', () => {
  let ipcInboundDir: string;
  let ipcInboundSock: string;
  let ipcInboundServer: Server | undefined;
  let ipcInboundClient: MxClient | undefined;

  /** Mock daemon that replies with a result containing a caller-supplied value. */
  function leakyDaemon(socketPath: string, leakValue: string): Promise<Server> {
    return new Promise((resolve) => {
      const s = createServer((socket) => {
        const decoder = new FrameDecoder();
        socket.on('data', (chunk: Buffer) => {
          for (const frame of decoder.push(chunk)) {
            const req = JSON.parse(frame) as { id: string };
            socket.write(
              encodeFrame(
                JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true, leaked: leakValue } }),
              ),
            );
          }
        });
        socket.on('error', () => {
          /* client close races — ignore */
        });
      });
      s.listen(socketPath, () => resolve(s));
    });
  }

  beforeEach(() => {
    ipcInboundDir = mkdtempSync(join(tmpdir(), 'mxl-secret-boundary-ipc-inbound-'));
    ipcInboundSock = join(ipcInboundDir, 'd.sock');
  });

  afterEach(async () => {
    await ipcInboundClient?.close();
    ipcInboundClient = undefined;
    if (ipcInboundServer) {
      await new Promise<void>((resolve) => ipcInboundServer!.close(() => resolve()));
      ipcInboundServer = undefined;
    }
    rmSync(ipcInboundDir, { recursive: true, force: true });
  });

  it('a token-shaped value in the IPC frame result is replaced with REDACTION_PLACEHOLDER', async () => {
    const LEAK_VALUE = 'syt_FAKE_ipc_leaked_daemon_token_00000';
    ipcInboundServer = await leakyDaemon(ipcInboundSock, LEAK_VALUE);

    const debug: string[] = [];
    ipcInboundClient = new MxClient({
      transport: 'ipc',
      socketPath: ipcInboundSock,
      retry: false,
      debug: (line) => debug.push(line),
    });
    const result = (await ipcInboundClient.call('daemon.ping', undefined)) as Record<string, unknown>;
    expect(result['ok']).toBe(true);
    expect(result['leaked']).toBe(REDACTION_PLACEHOLDER);
    assertNoSecretIn(JSON.stringify(result));
    const redactLines = debug.filter((l) => l.includes('redacted secret-shaped value'));
    expect(redactLines.some((l) => l.includes('daemon.ping') && l.includes('$.leaked'))).toBe(true);
    for (const line of debug) {
      expect(line).not.toContain(LEAK_VALUE);
      assertNoSecretIn(line);
    }
    await ipcInboundClient.close();
    ipcInboundClient = undefined;
  });

  it('a clean IPC result passes through structurally unchanged with no redaction fired', async () => {
    ipcInboundServer = await leakyDaemon(ipcInboundSock, 'plain-non-secret-value');

    const debug: string[] = [];
    ipcInboundClient = new MxClient({
      transport: 'ipc',
      socketPath: ipcInboundSock,
      retry: false,
      debug: (line) => debug.push(line),
    });
    const result = (await ipcInboundClient.call('daemon.ping', undefined)) as Record<string, unknown>;
    expect(result['ok']).toBe(true);
    expect(result['leaked']).toBe('plain-non-secret-value');
    expect(debug.filter((l) => l.includes('redacted secret-shaped value'))).toHaveLength(0);
    await ipcInboundClient.close();
    ipcInboundClient = undefined;
  });

  it('a credential-shaped arg is rejected before the IPC frame is sent (invalid_args, no frame written)', async () => {
    // The outbound guard fires in MxClient.call before any bytes reach the socket.
    // This verifies the guard is transport-uniform: it applies to the IPC leg too,
    // not only the CLI leg (which secret-boundary covers via the spawn path).
    let frameSent = false;
    ipcInboundServer = await new Promise<Server>((resolve) => {
      const s = createServer((socket) => {
        socket.on('data', () => {
          frameSent = true; // would be set if any bytes reached the server
        });
        socket.on('error', () => {
          /* ignore */
        });
      });
      s.listen(ipcInboundSock, () => resolve(s));
    });

    ipcInboundClient = new MxClient({
      transport: 'ipc',
      socketPath: ipcInboundSock,
      retry: false,
    });
    await expect(ipcInboundClient.call('agent.register', { api_key: 'fake-key' })).rejects.toMatchObject({
      code: 'invalid_args',
    });
    // Give the event loop one tick so any in-flight data event would have fired.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(frameSent).toBe(false);
    await ipcInboundClient.close();
    ipcInboundClient = undefined;
  });
});

// ---------------------------------------------------------------------------
// AC#1 — outbound rejection, CLI transport leg (guard fires before factory/spawn)
//
// Symmetric to the IPC 'frameSent === false' test above. The outbound
// credential-shaped-arg guard in MxClient.call() must fire BEFORE the CLI
// transport factory is ever invoked — no subprocess is spawned on a dirty call.
// We verify this by injecting a spy factory and asserting its call count stays 0.
// ---------------------------------------------------------------------------

describe('AC#1 — outbound rejection, CLI transport leg (guard fires before factory/spawn)', () => {
  /** Minimal stub returned by the spy factory — never actually called on rejection. */
  function stubTransport(): MxTransport {
    return {
      async call(): Promise<unknown> {
        return {};
      },
      async status(): Promise<DaemonStatus> {
        return {} as DaemonStatus;
      },
      async ping(): Promise<unknown> {
        return {};
      },
      async close(): Promise<void> {},
    };
  }

  it('a credential-shaped key rejects with invalid_args and the CLI factory is never invoked', async () => {
    let factoryCallCount = 0;
    const mx = new MxClient({
      transport: 'cli',
      retry: false,
      cliFactory: () => {
        factoryCallCount++;
        return stubTransport();
      },
    });
    await expect(mx.call('agent.register', { api_key: 'fake-key' })).rejects.toMatchObject({
      code: 'invalid_args',
    });
    // Guard fires in call() before any dispatch — factory must never be called.
    expect(factoryCallCount, 'CLI factory must not be invoked on a rejected call').toBe(0);
    await mx.close();
  });

  it('a credential-shaped value rejects with invalid_args and the CLI factory is never invoked', async () => {
    let factoryCallCount = 0;
    const mx = new MxClient({
      transport: 'cli',
      retry: false,
      cliFactory: () => {
        factoryCallCount++;
        return stubTransport();
      },
    });
    await expect(
      mx.call('run_tests', { suite: 'unit', provider_token: 'sk-ant-api03-FAKEFAKEFAKE' }),
    ).rejects.toMatchObject({ code: 'invalid_args' });
    expect(factoryCallCount).toBe(0);
    await mx.close();
  });

  it('rejection error names the path but never the secret value (CLI leg, end-to-end seam)', async () => {
    const secret = 'sk-ant-api03-THIS_MUST_NOT_APPEAR_IN_ERROR';
    const mx = new MxClient({
      transport: 'cli',
      retry: false,
      cliFactory: () => stubTransport(),
    });
    try {
      await mx.call('run_tests', { provider_key: secret });
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as { message: string }).message;
      expect(msg).not.toContain(secret);
      // Key name is safe to appear; value must not.
      expect(msg).toContain('provider_key');
    }
    await mx.close();
  });
});

// ---------------------------------------------------------------------------
// AC#1 — outbound rejection, auto transport (guard fires before transport selection)
//
// On the 'auto' path MxClient.call() runs the credential guard BEFORE it
// inspects the socket file or selects a transport. Both the IPC factory and
// the CLI factory must remain uncalled when a dirty arg is passed — regardless
// of whether a socket happens to exist on the test machine.
// ---------------------------------------------------------------------------

describe('AC#1 — outbound rejection, auto transport (guard fires before transport selection)', () => {
  it('a credential-shaped key rejects and neither IPC nor CLI factory is invoked', async () => {
    let ipcCount = 0;
    let cliCount = 0;
    const mx = new MxClient({
      transport: 'auto',
      retry: false,
      ipcFactory: () => {
        ipcCount++;
        return {
          async call(): Promise<unknown> { return {}; },
          async status(): Promise<DaemonStatus> { return {} as DaemonStatus; },
          async ping(): Promise<unknown> { return {}; },
          async close(): Promise<void> {},
        };
      },
      cliFactory: () => {
        cliCount++;
        return {
          async call(): Promise<unknown> { return {}; },
          async status(): Promise<DaemonStatus> { return {} as DaemonStatus; },
          async ping(): Promise<unknown> { return {}; },
          async close(): Promise<void> {},
        };
      },
    });
    await expect(
      mx.call('agent.register', { GH_TOKEN: 'ghp_FAKEtoken00000000000000' }),
    ).rejects.toMatchObject({ code: 'invalid_args' });
    // Guard in call() is pre-dispatch — neither transport must be constructed.
    expect(ipcCount, 'IPC factory must not be invoked').toBe(0);
    expect(cliCount, 'CLI factory must not be invoked').toBe(0);
    await mx.close();
  });

  it('a credential-shaped value (provider key) rejects and neither factory is invoked', async () => {
    let ipcCount = 0;
    let cliCount = 0;
    const mx = new MxClient({
      transport: 'auto',
      retry: false,
      ipcFactory: () => {
        ipcCount++;
        return {
          async call(): Promise<unknown> { return {}; },
          async status(): Promise<DaemonStatus> { return {} as DaemonStatus; },
          async ping(): Promise<unknown> { return {}; },
          async close(): Promise<void> {},
        };
      },
      cliFactory: () => {
        cliCount++;
        return {
          async call(): Promise<unknown> { return {}; },
          async status(): Promise<DaemonStatus> { return {} as DaemonStatus; },
          async ping(): Promise<unknown> { return {}; },
          async close(): Promise<void> {},
        };
      },
    });
    await expect(
      mx.call('delegate', { target: 'agent-b', args: { ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEFAKEFAKE' } }),
    ).rejects.toMatchObject({ code: 'invalid_args' });
    expect(ipcCount).toBe(0);
    expect(cliCount).toBe(0);
    await mx.close();
  });
});
