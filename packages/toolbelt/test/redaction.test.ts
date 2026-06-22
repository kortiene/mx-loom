import { describe, expect, it, vi } from 'vitest';

import { MxClient } from '../src/client.js';
import { redactSecrets, REDACTION_PLACEHOLDER } from '../src/guards.js';
import type { DaemonStatus } from '../src/ipc/types.js';
import type { MxTransport } from '../src/transport.js';

// Inbound, defense-in-depth result redaction (T008): the symmetric counterpart
// of the outbound arg scrubber. It walks a daemon-returned result and replaces
// any KNOWN secret-shaped string value with REDACTION_PLACEHOLDER before the
// result returns toward the model context. High-precision (value-shape only),
// never mutates, returns a clone, and reports via a callback without the value.

describe('redactSecrets', () => {
  it('replaces a top-level token-shaped value with the placeholder', () => {
    expect(redactSecrets('ghp_aaaaaaaaaaaaaaaaaaaa')).toBe(REDACTION_PLACEHOLDER);
    expect(redactSecrets('sk-ant-api03-FAKEFAKEFAKE')).toBe(REDACTION_PLACEHOLDER);
  });

  it('replaces a token-shaped value nested in an object', () => {
    const result = redactSecrets({ ok: 'hello', leaked: 'ghp_aaaaaaaaaaaaaaaaaaaa' });
    expect(result).toEqual({ ok: 'hello', leaked: REDACTION_PLACEHOLDER });
  });

  it('replaces a token-shaped value inside an array element', () => {
    const result = redactSecrets({ items: ['fine', 'xoxb-FAKE-slack-token', 7] });
    expect(result).toEqual({ items: ['fine', REDACTION_PLACEHOLDER, 7] });
  });

  it('redacts deeply nested token-shaped values', () => {
    const result = redactSecrets({ a: { b: [{ c: 'syt_FAKE_matrix_token' }] } });
    expect(result).toEqual({ a: { b: [{ c: REDACTION_PLACEHOLDER }] } });
  });

  it('leaves a clean result structurally equal (no corruption of legitimate values)', () => {
    const clean = {
      agent_id: 'backend-01',
      // Public key material the daemon legitimately returns — NOT value-shaped,
      // and redaction never matches on key name, so these survive untouched.
      signing_key_id: 'mxagent-ed25519:FIXTUREKEYID',
      signing_public_key: 'Zml4dHVyZS1wdWJsaWMta2V5LWJhc2U2NA==',
      count: 3,
      nested: { note: 'token format is syt_<base64>', items: [1, 2, 3] },
    };
    expect(redactSecrets(clean)).toEqual(clean);
  });

  it('does NOT redact by key name — only by value shape', () => {
    // A field NAMED like a secret but carrying a non-secret value is preserved.
    const result = redactSecrets({ signing_key_id: 'mxagent-ed25519:ABC', api_key: 'public-handle-42' });
    expect(result).toEqual({ signing_key_id: 'mxagent-ed25519:ABC', api_key: 'public-handle-42' });
  });

  it('preserves a value that merely CONTAINS a token-shaped substring (anchored regex)', () => {
    const result = redactSecrets({ note: 'see ghp_example in the docs', msg: 'prefix is syt_' });
    expect(result).toEqual({ note: 'see ghp_example in the docs', msg: 'prefix is syt_' });
  });

  it('never mutates the input (returns a clone)', () => {
    const input = { leaked: 'ghp_aaaaaaaaaaaaaaaaaaaa', kept: 'ok', arr: ['xoxb-FAKE'] };
    const snapshot = structuredClone(input);
    const out = redactSecrets(input);
    expect(input).toEqual(snapshot); // input unchanged
    expect(out).not.toBe(input); // distinct object
  });

  it('reports each redaction via onRedact with the path but never the value', () => {
    const onRedact = vi.fn();
    const secret = 'ghp_MUST_NOT_REACH_THE_CALLBACK';
    redactSecrets({ outer: { inner: secret }, arr: ['ok', 'AKIAIOSFODNN7EXAMPLE'] }, onRedact);
    expect(onRedact).toHaveBeenCalledTimes(2);
    const paths = onRedact.mock.calls.map((c) => c[0] as string);
    expect(paths).toContain('$.outer.inner');
    expect(paths).toContain('$.arr[1]');
    for (const path of paths) {
      expect(path).not.toContain(secret);
      expect(path).not.toContain('AKIAIOSFODNN7EXAMPLE');
    }
  });

  it('does not call onRedact for a clean result', () => {
    const onRedact = vi.fn();
    redactSecrets({ a: 1, b: 'hello', c: [true, null] }, onRedact);
    expect(onRedact).not.toHaveBeenCalled();
  });

  it('passes primitives and null through unchanged', () => {
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(true)).toBe(true);
    expect(redactSecrets(null)).toBe(null);
    expect(redactSecrets(undefined)).toBe(undefined);
    expect(redactSecrets('plain string')).toBe('plain string');
  });

  it('redacts a token-shaped value at an array top level', () => {
    expect(redactSecrets(['ok', 'github_pat_FAKE', 'fine'])).toEqual([
      'ok',
      REDACTION_PLACEHOLDER,
      'fine',
    ]);
  });
});

// --- redactSecrets wired into MxClient.call (the real seam) ---------------

describe('redactSecrets wired into MxClient.call (end-to-end seam)', () => {
  // A transport that returns a fixed result — stands in for a daemon (or a
  // daemon bug) surfacing a token-shaped value into a result the model reads.
  class StubTransport implements MxTransport {
    constructor(private readonly result: unknown) {}
    async call(): Promise<unknown> {
      return this.result;
    }
    async status(): Promise<DaemonStatus> {
      return this.result as DaemonStatus;
    }
    async ping(): Promise<unknown> {
      return this.result;
    }
    async close(): Promise<void> {
      /* nothing to release */
    }
  }

  function clientReturning(result: unknown, debug: string[]): MxClient {
    return new MxClient({
      transport: 'cli', // force the CLI leg so cliFactory is used
      retry: false,
      cliFactory: () => new StubTransport(result),
      debug: (line) => debug.push(line),
    });
  }

  it('redacts a token-shaped value the transport returns before it reaches the caller', async () => {
    const debug: string[] = [];
    const mx = clientReturning({ agent_id: 'a1', leaked: 'ghp_aaaaaaaaaaaaaaaaaaaa' }, debug);
    const result = await mx.call('agent.register', { kind: 'runtime' });
    expect(result).toEqual({ agent_id: 'a1', leaked: REDACTION_PLACEHOLDER });
    // The debug seam reports it fired, naming the method + path but never the value.
    const fired = debug.filter((l) => l.includes('redacted secret-shaped value'));
    expect(fired.some((l) => l.includes('agent.register') && l.includes('$.leaked'))).toBe(true);
    for (const line of debug) expect(line).not.toContain('ghp_aaaaaaaaaaaaaaaaaaaa');
    await mx.close();
  });

  it('leaves a clean transport result unchanged and reports no redaction', async () => {
    const debug: string[] = [];
    const clean = { agent_id: 'a1', signing_public_key: 'Zml4dHVyZS1wdWJsaWMta2V5' };
    const mx = clientReturning(clean, debug);
    const result = await mx.call('agent.register', { kind: 'runtime' });
    expect(result).toEqual(clean);
    expect(debug.filter((l) => l.includes('redacted secret-shaped value'))).toHaveLength(0);
    await mx.close();
  });

  it('redacts via the IPC transport leg — transport-uniform, same seam', async () => {
    // Confirm redaction runs at the single call() exit point that covers BOTH
    // transports, not just the CLI leg. Using ipcFactory to force the IPC path.
    const debug: string[] = [];
    const mx = new MxClient({
      transport: 'ipc',
      retry: false,
      ipcFactory: () => new StubTransport({ ok: true, leaked: 'ghp_FAKEipctoken000000000' }),
      debug: (line) => debug.push(line),
    });
    const result = await mx.call('daemon.ping', undefined);
    expect(result).toEqual({ ok: true, leaked: REDACTION_PLACEHOLDER });
    const fired = debug.filter((l) => l.includes('redacted secret-shaped value'));
    expect(fired.some((l) => l.includes('daemon.ping') && l.includes('$.leaked'))).toBe(true);
    for (const line of debug) expect(line).not.toContain('ghp_FAKEipctoken000000000');
    await mx.close();
  });
});
