import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createClient, MxClient } from '../src/client.js';
import { resolveSocketPath } from '../src/ipc/socket-path.js';
import { TransportError } from '../src/transport.js';

// The fixture mx-agent stand-in (shared with the CLI client suite). A tiny shell
// wrapper makes it executable as `cliBin`; absolute paths so it runs even with a
// stripped PATH.
const FIXTURE_MJS = fileURLToPath(new URL('./fixtures/mock-mx-agent.mjs', import.meta.url));
const NODE_BIN = process.execPath;
const CALL_TIMEOUT_MS = 5_000;

let tmpDir: string;
let CLI: string; // executable wrapper around the fixture
let MISSING_SOCKET: string; // a path guaranteed not to exist

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mxl-mxclient-int-'));
  CLI = join(tmpDir, 'mock-mx-agent');
  writeFileSync(CLI, `#!/bin/sh\nexec '${NODE_BIN}' '${FIXTURE_MJS}' "$@"\n`);
  chmodSync(CLI, 0o755);
  MISSING_SOCKET = join(tmpDir, 'definitely-absent', 'daemon.sock');
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// --- Absent-socket → CLI failover (no live daemon needed) -----------------
// Points the socket at a nonexistent path and the CLI at the fixture, so the
// auto selector must fail over to the CLI. Proves AC 2 deterministically in CI.

describe('MxClient absent-socket → CLI failover (fixture)', () => {
  it("auto: status() resolves a DaemonStatus via the CLI leg when the socket is absent (AC 2)", async () => {
    const mx = createClient({ socketPath: MISSING_SOCKET, cliBin: CLI });
    const status = await mx.status({ timeoutMs: CALL_TIMEOUT_MS });
    expect(status).toMatchObject({
      running: expect.any(Boolean),
      pid: expect.any(Number),
      socket_path: expect.any(String),
      version: expect.any(String),
    });
    expect(mx.activeTransport).toBe('cli');
    await mx.close();
  });

  it('auto: call() unwraps the CLI --json wrapper to the bare RPC result', async () => {
    const mx = createClient({ socketPath: MISSING_SOCKET, cliBin: CLI });
    const result = await mx.call('mock.wrapped', undefined, { timeoutMs: CALL_TIMEOUT_MS });
    expect(result).toEqual({ answer: 42 });
    await mx.close();
  });

  it('auto: ping() resolves via the CLI leg when the socket is absent', async () => {
    const mx = createClient({ socketPath: MISSING_SOCKET, cliBin: CLI });
    const result = await mx.ping({ timeoutMs: CALL_TIMEOUT_MS });
    expect(result).toMatchObject({ pong: true });
    expect(mx.activeTransport).toBe('cli');
    await mx.close();
  });

  it('failover CLI leg runs under a deny-scrubbed env (no MATRIX_*/MX_AGENT_* reaches the child)', async () => {
    const pollutedEnv: NodeJS.ProcessEnv = {
      HOME: '/home/fixture-test',
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      MATRIX_ACCESS_TOKEN: 'syt_FAKE_must_not_reach_child_000000',
      MATRIX_HOMESERVER: 'https://matrix.FAKE.test',
      MX_AGENT_SIGNING_KEY: 'fake-ed25519-key-material-must-not-forward',
      GH_TOKEN: 'ghp_FAKE_must_not_reach_child',
      OPENAI_API_KEY: 'sk-FAKE-provider-key',
    };
    const mx = createClient({ socketPath: MISSING_SOCKET, cliBin: CLI, env: pollutedEnv });
    const childEnv = (await mx.call('mock.dump.env', undefined, { timeoutMs: CALL_TIMEOUT_MS })) as Record<string, string>;
    // Deny side: secret env vars must not cross Boundary A into the child process.
    expect(childEnv).not.toHaveProperty('MATRIX_ACCESS_TOKEN');
    expect(childEnv).not.toHaveProperty('MATRIX_HOMESERVER');
    expect(childEnv).not.toHaveProperty('MX_AGENT_SIGNING_KEY');
    expect(childEnv).not.toHaveProperty('GH_TOKEN');
    expect(childEnv).not.toHaveProperty('OPENAI_API_KEY');
    expect(Object.values(childEnv)).not.toContain('syt_FAKE_must_not_reach_child_000000');
    // Allow side: non-secret resolution vars that ARE in the allowlist must reach the child.
    expect(childEnv).toHaveProperty('HOME', '/home/fixture-test');
    expect(childEnv).toHaveProperty('PATH');
    await mx.close();
  });

  it('rejects a credential-shaped arg before the failover spawn (invalid_args)', async () => {
    const mx = createClient({ socketPath: MISSING_SOCKET, cliBin: CLI });
    await expect(mx.call('agent.register', { api_key: 'fake' })).rejects.toMatchObject({ code: 'invalid_args' });
    await mx.close();
  });

  it('both transports unreachable → one combined TransportError naming both paths', async () => {
    const mx = createClient({ socketPath: MISSING_SOCKET, cliBin: '/no/such/mx-agent-binary' });
    const err = await mx.status({ timeoutMs: CALL_TIMEOUT_MS }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).code).toBe('not_running');
    expect((err as TransportError).message).toContain(MISSING_SOCKET);
    expect((err as TransportError).message).toContain('/no/such/mx-agent-binary');
    await mx.close();
  });
});

// --- Forced transport modes (real IpcClient + fixture CLI) ---------------
// These run without a live daemon. They drive the real IpcClient / real
// subprocess (not FakeTransport) to verify the forced-mode behaviour at the
// integration level, complementing the unit-level FakeTransport coverage.

describe('MxClient forced transports (integration)', () => {
  it("transport:'ipc' with absent socket → real IpcClient raises not_running, no CLI spawned", async () => {
    // The real IpcClient attempts to connect; ENOENT/ECONNREFUSED maps to
    // not_running.  Forced IPC never falls back to the CLI.
    const mx = new MxClient({ transport: 'ipc', socketPath: MISSING_SOCKET });
    const err = await mx.status({ timeoutMs: CALL_TIMEOUT_MS }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).code).toBe('not_running');
    await mx.close();
  });

  it("transport:'cli' forced mode resolves status() via the fixture without the socket check", async () => {
    // Forced CLI skips existsSync entirely and goes straight to spawn.
    const mx = new MxClient({ transport: 'cli', cliBin: CLI });
    const status = await mx.status({ timeoutMs: CALL_TIMEOUT_MS });
    expect(status).toMatchObject({
      running: expect.any(Boolean),
      pid: expect.any(Number),
      socket_path: expect.any(String),
      version: expect.any(String),
    });
    expect(mx.activeTransport).toBe('cli');
    await mx.close();
  });

  it('auto: sticky CLI selection — subsequent calls reuse the CLI transport without re-probing', async () => {
    // First call routes to CLI (absent socket).  Subsequent calls must stay
    // sticky on CLI, not re-run the existsSync check for each one.
    const mx = createClient({ socketPath: MISSING_SOCKET, cliBin: CLI });
    await mx.status({ timeoutMs: CALL_TIMEOUT_MS });
    expect(mx.activeTransport).toBe('cli');
    const pong = await mx.ping({ timeoutMs: CALL_TIMEOUT_MS });
    expect(pong).toMatchObject({ pong: true });
    expect(mx.activeTransport).toBe('cli');
    await mx.close();
  });

  it("transport:'cli' forced mode: call() unwraps the JSON-RPC wrapper envelope to .result", async () => {
    const mx = new MxClient({ transport: 'cli', cliBin: CLI });
    const result = await mx.call('mock.wrapped', undefined, { timeoutMs: CALL_TIMEOUT_MS });
    expect(result).toEqual({ answer: 42 });
    expect(mx.activeTransport).toBe('cli');
    await mx.close();
  });
});

// --- Live daemon round-trip (gated) ---------------------------------------
// Mirrors the existing integration suites: skips cleanly when no daemon/CLI is
// present, runs when one is up (`mx-agent daemon start`).

const socketPath = resolveSocketPath();
const socketExists = existsSync(socketPath);
const cliProbe = spawnSync('mx-agent', ['--version'], { stdio: 'ignore' });
const cliAvailable = cliProbe.error === undefined;

describe.skipIf(!socketExists)('MxClient against the live mx-agent daemon (auto → IPC)', () => {
  it('createClient().status() round-trips daemon.status → DaemonStatus over IPC', async () => {
    const mx = createClient();
    try {
      const status = await mx.status({ timeoutMs: 10_000 });
      expect(status.running).toBe(true);
      expect(status.socket_path).toBe(socketPath);
      expect(typeof status.version).toBe('string');
      expect(mx.activeTransport).toBe('ipc');
    } finally {
      await mx.close();
    }
  });
});

describe.skipIf(!(socketExists && cliAvailable))('MxClient cross-transport equivalence (live)', () => {
  it("forced 'ipc' and 'cli' resolve the same daemon.status shape", async () => {
    const viaIpc = new MxClient({ transport: 'ipc' });
    const viaCli = new MxClient({ transport: 'cli' });
    try {
      const [ipcStatus, cliStatus] = await Promise.all([
        viaIpc.status({ timeoutMs: 10_000 }),
        viaCli.status({ timeoutMs: 10_000 }),
      ]);
      expect(viaIpc.activeTransport).toBe('ipc');
      expect(viaCli.activeTransport).toBe('cli');
      expect(cliStatus.pid).toBe(ipcStatus.pid);
      expect(cliStatus.socket_path).toBe(ipcStatus.socket_path);
      expect(cliStatus.version).toBe(ipcStatus.version);
    } finally {
      await Promise.all([viaIpc.close(), viaCli.close()]);
    }
  });
});
