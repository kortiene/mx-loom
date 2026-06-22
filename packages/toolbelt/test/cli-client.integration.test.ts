import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { CliClient } from '../src/cli/client.js';
import { IpcClient } from '../src/ipc/client.js';
import { resolveSocketPath } from '../src/ipc/socket-path.js';

// Gate: both the live daemon socket AND the mx-agent binary must be present.
// When either is absent the suite skips cleanly, mirroring client.integration.test.ts.
// Run with a live daemon: `mx-agent daemon start`
const socketPath = resolveSocketPath();
const socketExists = existsSync(socketPath);
// spawnSync sets .error when the binary cannot be spawned (ENOENT = not on PATH).
const cliProbe = spawnSync('mx-agent', ['--version'], { stdio: 'ignore' });
const cliAvailable = cliProbe.error === undefined;
const live = socketExists && cliAvailable;

const CALL_TIMEOUT_MS = 10_000;

describe.skipIf(!live)('CliClient against the live mx-agent daemon', () => {
  it('status() returns a valid DaemonStatus from the live daemon', async () => {
    const client = new CliClient();
    const status = await client.status({ timeoutMs: CALL_TIMEOUT_MS });
    // Verify every DaemonStatus field is present with the correct type.
    expect(status).toMatchObject({
      running: true,
      pid: expect.any(Number),
      uptime_seconds: expect.any(Number),
      socket_path: socketPath,
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
    });
  });

  it('ping() resolves without error', async () => {
    const client = new CliClient();
    await expect(client.ping({ timeoutMs: CALL_TIMEOUT_MS })).resolves.toBeDefined();
  });

  it('CliClient.status() and IpcClient.status() return the same DaemonStatus shape (AC 1 live proof)', async () => {
    // Both transports must resolve to the same typed result for the same method,
    // queried against the same running daemon. This is the cross-transport AC 1 assertion.
    const cli = new CliClient();
    const ipc = new IpcClient();
    try {
      const [cliStatus, ipcStatus] = await Promise.all([
        cli.status({ timeoutMs: CALL_TIMEOUT_MS }),
        ipc.status({ timeoutMs: CALL_TIMEOUT_MS }),
      ]);
      // Both carry the same core DaemonStatus fields (shape equivalence).
      const shapeExpect = {
        running: expect.any(Boolean),
        pid: expect.any(Number),
        uptime_seconds: expect.any(Number),
        socket_path: expect.any(String),
        version: expect.any(String),
      };
      expect(cliStatus).toMatchObject(shapeExpect);
      expect(ipcStatus).toMatchObject(shapeExpect);
      // Both describe the same live daemon instance.
      expect(cliStatus.running).toBe(true);
      expect(cliStatus.pid).toBe(ipcStatus.pid);
      expect(cliStatus.socket_path).toBe(ipcStatus.socket_path);
      expect(cliStatus.version).toBe(ipcStatus.version);
    } finally {
      await ipc.close();
    }
  });

  it('agent.list returns an array (multi-segment method-to-argv mapping works E2E)', async () => {
    // Exercises the full round-trip for a non-daemon.* method: methodToArgv maps
    // 'agent.list' → ['agent', 'list', '--json'], the real binary is spawned, and
    // the JSON stdout is normalized to the RPC result.
    const client = new CliClient();
    const result = await client.call('agent.list', undefined, { timeoutMs: CALL_TIMEOUT_MS });
    expect(Array.isArray(result)).toBe(true);
  });

  it('CLI invocation works with a deny-scrubbed env (AC 2 live proof: real binary needs no secrets)', async () => {
    // Inject credentials that CliClient must scrub before spawning.
    // Successful response proves the real mx-agent binary operates correctly
    // on the allowlisted env alone (HOME + XDG paths); no secrets required.
    const pollutedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      MATRIX_ACCESS_TOKEN: 'syt_FAKE_must_not_reach_child_000000',
      MATRIX_HOMESERVER: 'https://matrix.FAKE.test',
      MX_AGENT_SIGNING_KEY: 'fake-ed25519-key-material-must-not-forward',
      MX_AGENT_SECRET: 'fake-agent-secret-must-not-forward',
    };
    const client = new CliClient({ env: pollutedEnv });
    const status = await client.status({ timeoutMs: CALL_TIMEOUT_MS });
    expect(status.running).toBe(true);
  });
});
