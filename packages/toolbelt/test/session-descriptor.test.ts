/**
 * Unit tests for SessionDescriptor — the non-secret resume handle (T302).
 * All tests are pure and daemon-free.
 *
 * Coverage:
 * - assertSessionDescriptor: valid/invalid shapes, schema-version fail-closed,
 *   field validation, allowlist-by-construction (extra fields stripped)
 * - Secret boundary: credential-shaped keys and values rejected as invalid_args;
 *   error messages never expose the secret value
 * - serializeSessionDescriptor / parseSessionDescriptor round-trip
 * - SESSION_DESCRIPTOR_VERSION constant
 */
import { describe, expect, it } from 'vitest';

import {
  SESSION_DESCRIPTOR_VERSION,
  assertSessionDescriptor,
  parseSessionDescriptor,
  serializeSessionDescriptor,
} from '../src/session-descriptor.js';
import { TransportError } from '../src/transport.js';
import type { SessionDescriptor } from '../src/session-descriptor.js';

// ---------------------------------------------------------------------------
// Shared fixture — synthetic ids, no real credentials or tokens
// ---------------------------------------------------------------------------

const VALID: SessionDescriptor = {
  v: 1,
  agent_id: 'agent-test-abc123',
  room: '!testroom:server',
  correlation_id: 'corr_test-correlation-id',
};

// ---------------------------------------------------------------------------
// assertSessionDescriptor — happy path
// ---------------------------------------------------------------------------

describe('assertSessionDescriptor — valid descriptors', () => {
  it('accepts a minimal valid descriptor without throwing', () => {
    expect(() => assertSessionDescriptor(VALID)).not.toThrow();
  });

  it('returns all required fields correctly typed', () => {
    const result = assertSessionDescriptor(VALID);
    expect(result.v).toBe(SESSION_DESCRIPTOR_VERSION);
    expect(result.agent_id).toBe(VALID.agent_id);
    expect(result.room).toBe(VALID.room);
    expect(result.correlation_id).toBe(VALID.correlation_id);
    expect(result.kind).toBeUndefined();
    expect(result.cursor).toBeUndefined();
  });

  it('accepts optional kind field', () => {
    const result = assertSessionDescriptor({ ...VALID, kind: 'test-runtime' });
    expect(result.kind).toBe('test-runtime');
  });

  it('accepts empty-string kind (not an error — but describe() omits it)', () => {
    // Empty-string kind is structurally valid; the session.describe() helper omits it.
    const result = assertSessionDescriptor({ ...VALID, kind: '' });
    expect(result.kind).toBe('');
  });

  it('accepts optional cursor with only state_rev', () => {
    const result = assertSessionDescriptor({ ...VALID, cursor: { state_rev: 42 } });
    expect(result.cursor?.state_rev).toBe(42);
    expect(result.cursor?.token).toBeUndefined();
  });

  // NOTE: cursor.token is blocked by the credential guard — the field name 'token'
  // matches CREDENTIAL_KEY_RE `(?:^|[_-])token$`. TaskCursor defines a token field
  // for a future opaque daemon continuation (spec OQ #6), but the guard conservatively
  // rejects any field named exactly 'token' in the descriptor until the round-trip
  // pins a non-credential-shaped name.
  it('rejects a cursor with a "token" key (credential-shaped key name blocks it)', () => {
    expect(() => assertSessionDescriptor({ ...VALID, cursor: { token: 'opaque' } })).toThrow(
      expect.objectContaining({ code: 'invalid_args' }),
    );
  });

  it('accepts cursor with state_rev = 0 (monotonic start)', () => {
    const result = assertSessionDescriptor({ ...VALID, cursor: { state_rev: 0 } });
    expect(result.cursor?.state_rev).toBe(0);
  });

  it('accepts an empty cursor object (no state_rev, no token)', () => {
    const result = assertSessionDescriptor({ ...VALID, cursor: {} });
    expect(result.cursor).toEqual({});
  });

  it('strips extra/unknown fields (allowlist-by-construction)', () => {
    const withExtra = { ...VALID, extra_field: 'should-vanish', nested: { x: 1 } };
    const result = assertSessionDescriptor(withExtra as unknown as SessionDescriptor);
    expect((result as unknown as Record<string, unknown>)['extra_field']).toBeUndefined();
    expect((result as unknown as Record<string, unknown>)['nested']).toBeUndefined();
  });

  it('assertSessionDescriptor is idempotent (double-validating is safe)', () => {
    const first = assertSessionDescriptor(VALID);
    const second = assertSessionDescriptor(first);
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// assertSessionDescriptor — schema validation failures
// ---------------------------------------------------------------------------

describe('assertSessionDescriptor — schema validation', () => {
  it('rejects null', () => {
    expect(() => assertSessionDescriptor(null)).toThrow(TransportError);
  });

  it('rejects a string', () => {
    expect(() => assertSessionDescriptor('not-an-object')).toThrow(TransportError);
  });

  it('rejects a number', () => {
    expect(() => assertSessionDescriptor(42)).toThrow(TransportError);
  });

  it('rejects an array', () => {
    expect(() => assertSessionDescriptor([1, 2, 3])).toThrow(TransportError);
  });

  it('rejects v: 2 (unsupported future version)', () => {
    expect(() => assertSessionDescriptor({ ...VALID, v: 2 })).toThrow(TransportError);
  });

  it('rejects v: 0 (unsupported past version)', () => {
    expect(() => assertSessionDescriptor({ ...VALID, v: 0 })).toThrow(TransportError);
  });

  it('rejects missing v field', () => {
    const { v: _v, ...noV } = VALID;
    expect(() => assertSessionDescriptor(noV)).toThrow(TransportError);
  });

  it('rejects empty agent_id', () => {
    expect(() => assertSessionDescriptor({ ...VALID, agent_id: '' })).toThrow(TransportError);
  });

  it('rejects non-string agent_id (number)', () => {
    expect(() => assertSessionDescriptor({ ...VALID, agent_id: 123 })).toThrow(TransportError);
  });

  it('rejects missing agent_id', () => {
    const { agent_id: _a, ...noId } = VALID;
    expect(() => assertSessionDescriptor(noId)).toThrow(TransportError);
  });

  it('rejects empty room', () => {
    expect(() => assertSessionDescriptor({ ...VALID, room: '' })).toThrow(TransportError);
  });

  it('rejects non-string room', () => {
    expect(() => assertSessionDescriptor({ ...VALID, room: { id: 'r' } })).toThrow(TransportError);
  });

  it('rejects missing room', () => {
    const { room: _r, ...noRoom } = VALID;
    expect(() => assertSessionDescriptor(noRoom)).toThrow(TransportError);
  });

  it('rejects empty correlation_id', () => {
    expect(() => assertSessionDescriptor({ ...VALID, correlation_id: '' })).toThrow(TransportError);
  });

  it('rejects missing correlation_id', () => {
    const { correlation_id: _c, ...noCorr } = VALID;
    expect(() => assertSessionDescriptor(noCorr)).toThrow(TransportError);
  });

  it('rejects non-string kind (number)', () => {
    expect(() => assertSessionDescriptor({ ...VALID, kind: 42 })).toThrow(TransportError);
  });

  it('rejects non-string kind (object)', () => {
    expect(() => assertSessionDescriptor({ ...VALID, kind: {} })).toThrow(TransportError);
  });

  it('rejects cursor.state_rev of string type', () => {
    expect(() => assertSessionDescriptor({ ...VALID, cursor: { state_rev: 'notanumber' } })).toThrow(TransportError);
  });

  it('rejects cursor.state_rev of Infinity', () => {
    expect(() => assertSessionDescriptor({ ...VALID, cursor: { state_rev: Infinity } })).toThrow(TransportError);
  });

  it('rejects cursor.state_rev of NaN', () => {
    expect(() => assertSessionDescriptor({ ...VALID, cursor: { state_rev: NaN } })).toThrow(TransportError);
  });

  it('rejects cursor.token of number type', () => {
    expect(() => assertSessionDescriptor({ ...VALID, cursor: { token: 999 } })).toThrow(TransportError);
  });

  it('rejects cursor as a string (not an object)', () => {
    expect(() => assertSessionDescriptor({ ...VALID, cursor: 'string-cursor' })).toThrow(TransportError);
  });

  it('rejects cursor as an array', () => {
    expect(() => assertSessionDescriptor({ ...VALID, cursor: [1, 2] })).toThrow(TransportError);
  });

  it('all validation errors use error code invalid_args', () => {
    const cases = [
      () => assertSessionDescriptor(null),
      () => assertSessionDescriptor({ ...VALID, v: 99 }),
      () => assertSessionDescriptor({ ...VALID, agent_id: '' }),
      () => assertSessionDescriptor({ ...VALID, room: '' }),
      () => assertSessionDescriptor({ ...VALID, cursor: 'bad' }),
    ];
    for (const fn of cases) {
      try {
        fn();
      } catch (e) {
        expect(e).toBeInstanceOf(TransportError);
        expect((e as TransportError).code).toBe('invalid_args');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// assertSessionDescriptor — secret boundary (Boundary A)
// ---------------------------------------------------------------------------

describe('assertSessionDescriptor — secret boundary', () => {
  // Credential-shaped key names that must be rejected
  const credentialKeys = [
    'token',
    'auth_token',
    'access_token',
    'mx_agent_token',
    'matrix_token',
    'api_key',
    'apikey',
    'signing_key',
    'signingkey',
    'private_key',
    'privatekey',
    'password',
    'passwd',
    'secret',
    'gh_token',
    'ghtoken',
  ];

  for (const key of credentialKeys) {
    it(`rejects a descriptor with credential-shaped key '${key}' as invalid_args`, () => {
      const bad = { ...VALID, [key]: 'some-value' };
      let caught: unknown;
      try { assertSessionDescriptor(bad as unknown as SessionDescriptor); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(TransportError);
      expect((caught as TransportError).code).toBe('invalid_args');
    });
  }

  // Credential-shaped values that must be rejected regardless of key name
  const credentialValues: Array<[string, string]> = [
    ['GitHub PAT ghp_', 'ghp_fakeGitHubToken1234567890abcdef'],
    ['GitHub OAuth gho_', 'gho_fakeOAuthToken1234567890abcdef'],
    ['GitHub Actions ghs_', 'ghs_fakeActionsToken123456'],
    ['GitHub PAT github_pat_', 'github_pat_fakepersonalaccesstoken'],
    ['Matrix syt_', 'syt_fakematrixtokenkJKHJKHjkh'],
    ['Slack xoxb-', 'xoxb-fake-slack-token-12345'],
    ['Anthropic sk-ant-', 'sk-ant-api03-fake-anthropic-key'],
    ['OpenAI sk-', 'sk-FakeOpenAIKey1234567890abcdefghij'],
    ['PEM private key', '-----BEGIN RSA PRIVATE KEY-----'],
    ['AWS AKIA', 'AKIAIOSFODNN7EXAMPLE123456'],
  ];

  for (const [label, value] of credentialValues) {
    it(`rejects a descriptor containing credential-shaped value (${label}) as invalid_args`, () => {
      const bad = { ...VALID, handle: value };
      let caught: unknown;
      try { assertSessionDescriptor(bad as unknown as SessionDescriptor); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(TransportError);
      expect((caught as TransportError).code).toBe('invalid_args');
    });
  }

  it('error message names the key/path — never the secret value itself', () => {
    const secretValue = 'sk-ant-api03-MUST_NOT_APPEAR_IN_MESSAGE_12345';
    let caught: TransportError | undefined;
    try {
      assertSessionDescriptor({ ...VALID, extra_handle: secretValue } as unknown as SessionDescriptor);
    } catch (e) {
      caught = e as TransportError;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).not.toContain(secretValue);
  });
});

// ---------------------------------------------------------------------------
// serializeSessionDescriptor / parseSessionDescriptor — round-trip
// ---------------------------------------------------------------------------

describe('serializeSessionDescriptor / parseSessionDescriptor — round-trip', () => {
  it('serializes a minimal descriptor to valid JSON', () => {
    const json = serializeSessionDescriptor(VALID);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('round-trips a minimal descriptor (serialize → parse → equal)', () => {
    const json = serializeSessionDescriptor(VALID);
    expect(parseSessionDescriptor(json)).toEqual(VALID);
  });

  it('round-trips a full descriptor with kind and cursor.state_rev', () => {
    const full: SessionDescriptor = {
      ...VALID,
      kind: 'test-runtime',
      cursor: { state_rev: 7 },
    };
    expect(parseSessionDescriptor(serializeSessionDescriptor(full))).toEqual(full);
  });

  it('serialize strips extra fields from the JSON output', () => {
    const withExtra = { ...VALID, extra: 'should-vanish' };
    const obj = JSON.parse(serializeSessionDescriptor(withExtra as SessionDescriptor)) as Record<string, unknown>;
    expect(obj['extra']).toBeUndefined();
    expect(obj['agent_id']).toBe(VALID.agent_id);
  });

  it('parseSessionDescriptor rejects a non-JSON string', () => {
    expect(() => parseSessionDescriptor('not json at all')).toThrow(
      expect.objectContaining({ code: 'invalid_args' }),
    );
  });

  it('parseSessionDescriptor rejects a JSON array', () => {
    expect(() => parseSessionDescriptor('[]')).toThrow(
      expect.objectContaining({ code: 'invalid_args' }),
    );
  });

  it('parseSessionDescriptor rejects a JSON number', () => {
    expect(() => parseSessionDescriptor('42')).toThrow(
      expect.objectContaining({ code: 'invalid_args' }),
    );
  });

  it('parseSessionDescriptor rejects a JSON null', () => {
    expect(() => parseSessionDescriptor('null')).toThrow(
      expect.objectContaining({ code: 'invalid_args' }),
    );
  });

  it('parseSessionDescriptor rejects a descriptor with an unsupported version', () => {
    const bad = JSON.stringify({ ...VALID, v: 99 });
    expect(() => parseSessionDescriptor(bad)).toThrow(
      expect.objectContaining({ code: 'invalid_args' }),
    );
  });

  it('parseSessionDescriptor rejects a descriptor with a credential-shaped key', () => {
    const bad = JSON.stringify({ ...VALID, auth_token: 'some-value' });
    expect(() => parseSessionDescriptor(bad)).toThrow(
      expect.objectContaining({ code: 'invalid_args' }),
    );
  });

  it('parseSessionDescriptor rejects a descriptor with a credential-shaped value', () => {
    const bad = JSON.stringify({ ...VALID, handle: 'syt_fakematrix_token' });
    expect(() => parseSessionDescriptor(bad)).toThrow(
      expect.objectContaining({ code: 'invalid_args' }),
    );
  });
});

// ---------------------------------------------------------------------------
// SESSION_DESCRIPTOR_VERSION
// ---------------------------------------------------------------------------

describe('SESSION_DESCRIPTOR_VERSION', () => {
  it('is the numeric literal 1', () => {
    expect(SESSION_DESCRIPTOR_VERSION).toBe(1);
  });
});
