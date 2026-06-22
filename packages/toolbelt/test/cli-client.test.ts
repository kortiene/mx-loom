import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CliClient } from '../src/cli/client.js';
import { IpcClient } from '../src/ipc/client.js';
import { IpcError } from '../src/ipc/errors.js';
import type { MxTransport } from '../src/transport.js';
import { TransportError } from '../src/transport.js';

// Absolute paths — injected into the shell wrapper so it never needs PATH to
// find node, and the allowlisted-env tests can pass a stripped PATH safely.
const FIXTURE_MJS = fileURLToPath(new URL('./fixtures/mock-mx-agent.mjs', import.meta.url));
const NODE_BIN = process.execPath;

// Short timeout for all happy-path calls in tests.
const CALL_TIMEOUT_MS = 5_000;

// Compile-time AC 1 assertion: both transports satisfy MxTransport.
// These typed assignments fail to compile if either class diverges from the interface.
declare const _cliCheck: MxTransport;
declare const _ipcCheck: MxTransport;
function _typeAssert(): void {
  const _a: MxTransport = new CliClient();
  const _b: MxTransport = new IpcClient();
  void _a;
  void _b;
}
void _typeAssert; // suppress unused-function lint; the body is the compile-time check

let tmpDir: string;
/** Absolute path to the shell wrapper that spawns the fixture under any env. */
let CLI: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mxl-cli-test-'));
  CLI = join(tmpDir, 'mock-mx-agent');
  // The wrapper uses hardcoded absolute paths for node + fixture so it runs
  // correctly even when the child env has PATH stripped to the minimum.
  writeFileSync(CLI, `#!/bin/sh\nexec '${NODE_BIN}' '${FIXTURE_MJS}' "$@"\n`);
  chmodSync(CLI, 0o755);
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('CliClient', () => {
  describe('MxTransport interface (AC 1)', () => {
    it('exposes call(), status(), ping(), close() matching MxTransport', () => {
      const client = new CliClient({ cliBin: CLI });
      expect(typeof client.call).toBe('function');
      expect(typeof client.status).toBe('function');
      expect(typeof client.ping).toBe('function');
      expect(typeof client.close).toBe('function');
    });
  });

  describe('happy path', () => {
    it('status() returns a DaemonStatus-shaped result identical to IpcClient (AC 1)', async () => {
      const client = new CliClient({ cliBin: CLI });
      const result = await client.status({ timeoutMs: CALL_TIMEOUT_MS });
      // Verify all DaemonStatus fields are present and typed correctly
      expect(result).toMatchObject({
        running: expect.any(Boolean),
        pid: expect.any(Number),
        uptime_seconds: expect.any(Number),
        socket_path: expect.any(String),
        version: expect.any(String),
      });
    });

    it('ping() resolves with a value', async () => {
      const client = new CliClient({ cliBin: CLI });
      const result = await client.ping({ timeoutMs: CALL_TIMEOUT_MS });
      expect(result).toBeDefined();
    });

    it('call() unwraps {jsonrpc, id, result} wrapper to bare .result (AC 1)', async () => {
      const client = new CliClient({ cliBin: CLI });
      // The fixture for mock.wrapped returns {jsonrpc:"2.0",id:"1",result:{answer:42}}
      const result = await client.call('mock.wrapped', undefined, { timeoutMs: CALL_TIMEOUT_MS });
      expect(result).toEqual({ answer: 42 });
    });

    it('close() resolves without error (no-op — stateless transport)', async () => {
      const client = new CliClient({ cliBin: CLI });
      await expect(client.close()).resolves.toBeUndefined();
    });
  });

  describe('error normalization — same code set as IpcClient (AC 1)', () => {
    it('JSON-RPC error on stdout → TransportError("rpc")', async () => {
      const client = new CliClient({ cliBin: CLI });
      await expect(client.call('mock.rpc.error', undefined, { timeoutMs: CALL_TIMEOUT_MS })).rejects.toMatchObject({
        code: 'rpc',
      });
    });

    it('JSON-RPC error on stderr → TransportError("rpc")', async () => {
      const client = new CliClient({ cliBin: CLI });
      await expect(client.call('mock.stderr.error', undefined, { timeoutMs: CALL_TIMEOUT_MS })).rejects.toMatchObject({
        code: 'rpc',
      });
    });

    it('non-zero exit with non-JSON stdout → TransportError("protocol")', async () => {
      const client = new CliClient({ cliBin: CLI });
      await expect(client.call('mock.no.json', undefined, { timeoutMs: CALL_TIMEOUT_MS })).rejects.toMatchObject({
        code: 'protocol',
      });
    });

    it('exit-0 with empty stdout → TransportError("protocol")', async () => {
      const client = new CliClient({ cliBin: CLI });
      await expect(client.call('mock.empty.exit0', undefined, { timeoutMs: CALL_TIMEOUT_MS })).rejects.toMatchObject({
        code: 'protocol',
      });
    });

    it('timeout → TransportError("timeout")', async () => {
      const client = new CliClient({ cliBin: CLI });
      await expect(client.call('mock.hang', undefined, { timeoutMs: 200 })).rejects.toMatchObject({
        code: 'timeout',
      });
    }, 3_000);

    it('signal termination (SIGTERM) → TransportError("protocol")', async () => {
      const client = new CliClient({ cliBin: CLI });
      await expect(client.call('mock.signal', undefined, { timeoutMs: CALL_TIMEOUT_MS })).rejects.toMatchObject({
        code: 'protocol',
      });
    });

    it('missing binary (ENOENT) → TransportError("not_running")', async () => {
      const client = new CliClient({ cliBin: '/no/such/binary-mxl-test-enoent' });
      await expect(client.call('daemon.status', undefined, { timeoutMs: CALL_TIMEOUT_MS })).rejects.toMatchObject({
        code: 'not_running',
      });
    });

    it('all transport failures are instances of TransportError', async () => {
      const client = new CliClient({ cliBin: '/no/such/binary-mxl-test-instance' });
      const err = await client.call('daemon.status').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransportError);
    });
  });

  describe('credential arg rejection — pre-spawn, never reaches child', () => {
    // Use a nonexistent binary: if spawn were reached, the error code would be
    // 'not_running', not 'invalid_args'. Getting 'invalid_args' proves the check
    // fires before any subprocess is created.
    const DEAD_BIN = '/no/such/binary-mxl-test-cred';

    const keyCases: Array<[string, Record<string, unknown>]> = [
      ['token', { token: 'fake-token-value' }],
      ['secret', { secret: 'fake-secret' }],
      ['password', { password: 'fake-password' }],
      ['passwd', { passwd: 'fake-passwd' }],
      ['api_key', { api_key: 'fake-key-123' }],
      ['signing_key', { signing_key: 'fake-ed25519-signing-key' }],
      ['private_key', { private_key: '-----BEGIN FAKE KEY-----' }],
      ['matrix_ prefix', { matrix_homeserver: 'https://matrix.example.test' }],
    ];

    for (const [label, params] of keyCases) {
      it(`rejects credential-key '${label}' as TransportError("invalid_args")`, async () => {
        const client = new CliClient({ cliBin: DEAD_BIN });
        await expect(client.call('daemon.status', params)).rejects.toMatchObject({ code: 'invalid_args' });
      });
    }

    it('rejects GitHub PAT value (ghp_ prefix) as TransportError("invalid_args")', async () => {
      const client = new CliClient({ cliBin: DEAD_BIN });
      await expect(
        client.call('daemon.status', { name: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
      ).rejects.toMatchObject({ code: 'invalid_args' });
    });

    it('rejects Matrix access token value (syt_ prefix) as TransportError("invalid_args")', async () => {
      const client = new CliClient({ cliBin: DEAD_BIN });
      await expect(
        client.call('daemon.status', { name: 'syt_dGVzdA_faketoken_fakehex1234' }),
      ).rejects.toMatchObject({ code: 'invalid_args' });
    });

    it('rejects Slack bot token value (xoxb- prefix) as TransportError("invalid_args")', async () => {
      const client = new CliClient({ cliBin: DEAD_BIN });
      await expect(
        client.call('daemon.status', { name: 'xoxb-fake-slack-bot-token' }),
      ).rejects.toMatchObject({ code: 'invalid_args' });
    });

    it('rejects github_pat_ value as TransportError("invalid_args")', async () => {
      const client = new CliClient({ cliBin: DEAD_BIN });
      await expect(
        client.call('daemon.status', { value: 'github_pat_faketoken_1234567890' }),
      ).rejects.toMatchObject({ code: 'invalid_args' });
    });

    it('rejects nested credential-shaped key (deep object)', async () => {
      const client = new CliClient({ cliBin: DEAD_BIN });
      await expect(
        client.call('daemon.status', { config: { auth: { token: 'fake-nested-token' } } }),
      ).rejects.toMatchObject({ code: 'invalid_args' });
    });

    it('rejects credential-shaped value inside an array element', async () => {
      const client = new CliClient({ cliBin: DEAD_BIN });
      await expect(
        client.call('daemon.status', { values: ['syt_dGVzdA_fake_arrayvalue'] }),
      ).rejects.toMatchObject({ code: 'invalid_args' });
    });

    it('error message for credential key names the key but never the value', async () => {
      const client = new CliClient({ cliBin: DEAD_BIN });
      const err = await client
        .call('daemon.status', { token: 'very-secret-value-must-not-appear-in-message' })
        .catch((e: unknown) => e);
      expect((err as TransportError).message).not.toContain('very-secret-value-must-not-appear-in-message');
    });

    it('does not reject clean non-credential params', async () => {
      const client = new CliClient({ cliBin: CLI });
      const result = await client.call('daemon.status', undefined, { timeoutMs: CALL_TIMEOUT_MS });
      expect(result).toBeDefined();
    });
  });

  describe('AC 2 — subprocess env is deny-by-default (no MATRIX_* / MX_AGENT_* leak)', () => {
    it('does not forward MATRIX_* or MX_AGENT_* env vars to the child process', async () => {
      const sourceEnv: NodeJS.ProcessEnv = {
        HOME: '/home/fixture-test',
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        MATRIX_ACCESS_TOKEN: 'syt_fake_shouldnotreachthechild_abc123',
        MATRIX_HOMESERVER: 'https://matrix.example.test',
        MX_AGENT_SIGNING_KEY: 'fake-ed25519-key-material',
        MX_AGENT_SECRET: 'fake-agent-secret-value',
        UNLISTED_CUSTOM: 'should-also-be-dropped',
      };
      const client = new CliClient({ cliBin: CLI, env: sourceEnv });
      // The fixture outputs process.env as JSON — we can verify what the child saw.
      const childEnv = (await client.call('mock.dump.env', undefined, {
        timeoutMs: CALL_TIMEOUT_MS,
      })) as Record<string, string>;

      // AC 2: denied keys must be absent
      expect(childEnv).not.toHaveProperty('MATRIX_ACCESS_TOKEN');
      expect(childEnv).not.toHaveProperty('MATRIX_HOMESERVER');
      expect(childEnv).not.toHaveProperty('MX_AGENT_SIGNING_KEY');
      expect(childEnv).not.toHaveProperty('MX_AGENT_SECRET');
      expect(childEnv).not.toHaveProperty('UNLISTED_CUSTOM');
      // Allowlisted keys ARE forwarded
      expect(childEnv['HOME']).toBe('/home/fixture-test');
    });

    it('denied token values do not appear anywhere in the child env values', async () => {
      const secretValue = 'syt_FAKE_secret_token_must_not_appear_in_child';
      const sourceEnv: NodeJS.ProcessEnv = {
        HOME: '/home/fixture-test',
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        MATRIX_ACCESS_TOKEN: secretValue,
      };
      const client = new CliClient({ cliBin: CLI, env: sourceEnv });
      const childEnv = (await client.call('mock.dump.env', undefined, {
        timeoutMs: CALL_TIMEOUT_MS,
      })) as Record<string, string>;

      expect(Object.values(childEnv)).not.toContain(secretValue);
    });

    it('forwards extra non-denied keys requested via extraEnvAllow', async () => {
      const sourceEnv: NodeJS.ProcessEnv = {
        HOME: '/home/fixture-test',
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        TOOL_FLAG: 'enabled-for-child',
      };
      const client = new CliClient({ cliBin: CLI, env: sourceEnv, extraEnvAllow: ['TOOL_FLAG'] });
      const childEnv = (await client.call('mock.dump.env', undefined, {
        timeoutMs: CALL_TIMEOUT_MS,
      })) as Record<string, string>;
      expect(childEnv['TOOL_FLAG']).toBe('enabled-for-child');
    });

    it('still blocks MATRIX_* even when listed in extraEnvAllow (deny prefix is unconditional)', async () => {
      const sourceEnv: NodeJS.ProcessEnv = {
        HOME: '/home/fixture-test',
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        MATRIX_TOKEN: 'syt_FAKE_must_not_reach_child',
      };
      const client = new CliClient({ cliBin: CLI, env: sourceEnv, extraEnvAllow: ['MATRIX_TOKEN'] });
      const childEnv = (await client.call('mock.dump.env', undefined, {
        timeoutMs: CALL_TIMEOUT_MS,
      })) as Record<string, string>;
      expect(childEnv).not.toHaveProperty('MATRIX_TOKEN');
    });

    it('MXL_AGENT_BIN is not forwarded to the child (parent-only override, not in BASE_ENV_ALLOW)', async () => {
      const sourceEnv: NodeJS.ProcessEnv = {
        HOME: '/home/fixture-test',
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        MXL_AGENT_BIN: '/parent-only/mx-agent',
      };
      const client = new CliClient({ cliBin: CLI, env: sourceEnv });
      const childEnv = (await client.call('mock.dump.env', undefined, {
        timeoutMs: CALL_TIMEOUT_MS,
      })) as Record<string, string>;
      expect(childEnv).not.toHaveProperty('MXL_AGENT_BIN');
    });
  });

  describe('params → stdin (never on argv)', () => {
    it('sends structured params as JSON on stdin, which the child can parse', async () => {
      const params = { foo: 'bar', count: 42, nested: { active: true } };
      const client = new CliClient({ cliBin: CLI });
      // The fixture for mock.echo.stdin echoes its stdin back to stdout.
      const result = await client.call('mock.echo.stdin', params, { timeoutMs: CALL_TIMEOUT_MS });
      expect(result).toEqual(params);
    });

    it('param values are absent from the child process.argv (E2E never-on-argv proof)', async () => {
      // This closes the gap between the methodToArgv plan test and the real spawn:
      // we inspect the child's *actual* process.argv to prove that even after a
      // real fork + exec, structured param values never appear on the command line.
      // A misbehaving implementation that accidentally duplicated params on argv AND
      // stdin would be caught here but not by mock.echo.stdin alone.
      const sensitiveValue = 'SENSITIVE_ARG_MUST_NOT_APPEAR_IN_CHILD_ARGV';
      const params = { agent_id: sensitiveValue, room: '!room:mx.example.test', count: 99 };
      const client = new CliClient({ cliBin: CLI });
      const childArgv = (await client.call('mock.dump.argv', params, { timeoutMs: CALL_TIMEOUT_MS })) as string[];
      const argvStr = childArgv.join(' ');
      expect(argvStr).not.toContain(sensitiveValue);
      expect(argvStr).not.toContain('!room:mx.example.test');
      // Numeric 99 would naturally serialize — assert too
      // (only a string match; the value '99' is short so we match the full agent_id instead)
      expect(argvStr).not.toContain(sensitiveValue);
      // --input-json flag MUST be present (confirms stdin path was taken)
      expect(childArgv).toContain('--input-json');
      expect(childArgv).toContain('-');
    });
  });

  describe('cliBin resolution', () => {
    it('uses MXL_AGENT_BIN from env when no cliBin option', () => {
      const client = new CliClient({ env: { MXL_AGENT_BIN: '/custom/bin/mx-agent' } });
      expect(client.cliBin).toBe('/custom/bin/mx-agent');
    });

    it('constructor cliBin takes precedence over MXL_AGENT_BIN', () => {
      const client = new CliClient({
        cliBin: '/explicit/path/mx-agent',
        env: { MXL_AGENT_BIN: '/env-should-be-ignored/mx-agent' },
      });
      expect(client.cliBin).toBe('/explicit/path/mx-agent');
    });

    it('defaults to "mx-agent" when no cliBin and no MXL_AGENT_BIN', () => {
      const client = new CliClient({ env: { HOME: '/home/test' } });
      expect(client.cliBin).toBe('mx-agent');
    });
  });

  describe('unwrapResult edge cases', () => {
    it('{result: null} is unwrapped to null (null is a valid RPC result)', async () => {
      const client = new CliClient({ cliBin: CLI });
      const result = await client.call('mock.null.result', undefined, { timeoutMs: CALL_TIMEOUT_MS });
      expect(result).toBeNull();
    });

    it('bare array on stdout is returned as-is (no result field — not a wrapper)', async () => {
      const client = new CliClient({ cliBin: CLI });
      const result = await client.call('mock.array.result', undefined, { timeoutMs: CALL_TIMEOUT_MS });
      expect(result).toEqual([1, 2, 3]);
    });

    it('JSON-RPC error on stdout with non-zero exit still → TransportError("rpc")', async () => {
      const client = new CliClient({ cliBin: CLI });
      await expect(
        client.call('mock.rpc.error.nonzero', undefined, { timeoutMs: CALL_TIMEOUT_MS }),
      ).rejects.toMatchObject({ code: 'rpc' });
    });
  });

  describe('overflow guard — MAX_FRAME_BYTES limit', () => {
    it('oversized stdout → TransportError("protocol") with "oversized" in message', async () => {
      const client = new CliClient({ cliBin: CLI });
      const err = await client.call('mock.oversized', undefined, { timeoutMs: 15_000 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).code).toBe('protocol');
      expect((err as TransportError).message).toContain('oversized');
    }, 20_000);
  });

  describe('close() idempotency', () => {
    it('calling close() twice does not throw (no-op transport)', async () => {
      const client = new CliClient({ cliBin: CLI });
      await expect(client.close()).resolves.toBeUndefined();
      await expect(client.close()).resolves.toBeUndefined();
    });
  });

  describe('concurrent calls', () => {
    it('multiple simultaneous calls each spawn independently and all resolve', async () => {
      const client = new CliClient({ cliBin: CLI });
      const [r1, r2, r3] = await Promise.all([
        client.status({ timeoutMs: CALL_TIMEOUT_MS }),
        client.ping({ timeoutMs: CALL_TIMEOUT_MS }),
        client.status({ timeoutMs: CALL_TIMEOUT_MS }),
      ]);
      expect(r1).toMatchObject({ running: true });
      expect(r2).toBeDefined();
      expect(r3).toMatchObject({ running: true });
    });
  });

  describe('TransportError / IpcError shared taxonomy', () => {
    it('TransportError is the same class as IpcError (re-exported alias, no fork)', () => {
      expect(TransportError).toBe(IpcError);
    });

    it('TransportError instances carry name "IpcError" (inherited, not "TransportError")', () => {
      const err = new TransportError('timeout', 'test message');
      expect(err.name).toBe('IpcError');
      expect(err).toBeInstanceOf(IpcError);
    });

    it('the closed code set includes every code the CLI path can produce', () => {
      const cliCodes = ['not_running', 'connect_failed', 'timeout', 'protocol', 'rpc', 'invalid_args'] as const;
      for (const code of cliCodes) {
        const err = new TransportError(code, 'test');
        expect(err.code).toBe(code);
      }
    });
  });

  describe('credential arg rejection — additional token prefix variants', () => {
    const DEAD_BIN_EXTRA = '/no/such/binary-mxl-test-extra-cred';

    const extraValueCases: Array<[string, unknown]> = [
      ['gho_ (GitHub OAuth token)', { value: 'gho_fakeoauthtoken12345' }],
      ['ghu_ (GitHub user-to-server token)', { value: 'ghu_fakeusrtoken12345' }],
      ['ghs_ (GitHub server-to-server token)', { value: 'ghs_fakesrvtoken12345' }],
      ['ghr_ (GitHub runner token)', { value: 'ghr_fakerunnertoken12345' }],
      ['xoxp- (Slack user token)', { value: 'xoxp-fake-slack-user-token' }],
      ['xoxs- (Slack app-level token)', { value: 'xoxs-fake-slack-app-token' }],
      ['xoxa- (Slack legacy token)', { value: 'xoxa-fake-slack-legacy-token' }],
      ['xoxr- (Slack refresh token)', { value: 'xoxr-fake-slack-refresh-token' }],
    ];

    for (const [label, params] of extraValueCases) {
      it(`rejects ${label} value as TransportError("invalid_args")`, async () => {
        const client = new CliClient({ cliBin: DEAD_BIN_EXTRA });
        await expect(client.call('daemon.status', params)).rejects.toMatchObject({ code: 'invalid_args' });
      });
    }

    it('error message for credential-shaped value names the path, not the value itself', async () => {
      const client = new CliClient({ cliBin: DEAD_BIN_EXTRA });
      const sensitiveValue = 'gho_THIS_VALUE_MUST_NOT_APPEAR_IN_ERROR_MESSAGE';
      const err = await client.call('daemon.status', { name: sensitiveValue }).catch((e: unknown) => e);
      expect((err as TransportError).message).not.toContain(sensitiveValue);
      expect((err as TransportError).code).toBe('invalid_args');
    });
  });
});
