import { describe, expect, it } from 'vitest';

import { assertNoCredentialShapedArgs, CREDENTIAL_KEY_RE, CREDENTIAL_VALUE_RE } from '../src/guards.js';
import { TransportError } from '../src/transport.js';

// The guard is hoisted out of the CLI client (T003) so the unified client (T004)
// can apply it on BOTH transports. These tests pin the shared behavior; the CLI
// client's own suite still exercises it end-to-end through a spawn.

describe('assertNoCredentialShapedArgs', () => {
  it('accepts clean params (no throw)', () => {
    expect(() => assertNoCredentialShapedArgs(undefined)).not.toThrow();
    expect(() => assertNoCredentialShapedArgs(null)).not.toThrow();
    expect(() => assertNoCredentialShapedArgs({ agent_id: 'backend-01', room: '!r:srv', count: 3 })).not.toThrow();
    expect(() => assertNoCredentialShapedArgs(['a', 'b', { nested: 'ok' }])).not.toThrow();
  });

  const keyCases: Array<[string, Record<string, unknown>]> = [
    ['token', { token: 'x' }],
    ['secret', { secret: 'x' }],
    ['password', { password: 'x' }],
    ['passwd', { passwd: 'x' }],
    ['api_key', { api_key: 'x' }],
    ['api-key', { 'api-key': 'x' }],
    ['signing_key', { signing_key: 'x' }],
    ['private_key', { private_key: 'x' }],
    ['matrix_ prefix', { matrix_homeserver: 'https://example.test' }],
  ];

  for (const [label, params] of keyCases) {
    it(`rejects credential-shaped key '${label}' as invalid_args`, () => {
      const err = (() => {
        try {
          assertNoCredentialShapedArgs(params);
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).code).toBe('invalid_args');
    });
  }

  const valueCases: Array<[string, unknown]> = [
    ['ghp_', { x: 'ghp_aaaaaaaaaaaaaaaaaaaa' }],
    ['gho_', { x: 'gho_aaaaaaaaaaaaaaaaaaaa' }],
    ['github_pat_', { x: 'github_pat_aaaaaaaa' }],
    ['syt_', { x: 'syt_dGVzdA_fake_hex' }],
    ['xoxb-', { x: 'xoxb-fake-token' }],
    ['nested array', { items: ['ok', 'xoxp-fake'] }],
    ['deep object', { a: { b: { c: 'ghs_deeptoken' } } }],
  ];

  for (const [label, params] of valueCases) {
    it(`rejects credential-shaped value (${label}) as invalid_args`, () => {
      expect(() => assertNoCredentialShapedArgs(params)).toThrow(TransportError);
      try {
        assertNoCredentialShapedArgs(params);
      } catch (e) {
        expect((e as TransportError).code).toBe('invalid_args');
      }
    });
  }

  it('error message names the key but never the secret value', () => {
    const secret = 'super-secret-value-must-not-appear';
    try {
      assertNoCredentialShapedArgs({ token: secret });
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as TransportError).message;
      expect(msg).toContain('token');
      expect(msg).not.toContain(secret);
    }
  });

  it('error message for a credential-shaped value names the path, not the value', () => {
    const secret = 'ghp_THIS_MUST_NOT_APPEAR_IN_MESSAGE';
    try {
      assertNoCredentialShapedArgs({ outer: { inner: secret } });
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as TransportError).message;
      expect(msg).toContain('$.outer.inner');
      expect(msg).not.toContain(secret);
    }
  });

  it('exposes the regexes used for the deny checks', () => {
    expect(CREDENTIAL_KEY_RE.test('api_key')).toBe(true);
    expect(CREDENTIAL_KEY_RE.test('agent_id')).toBe(false);
    expect(CREDENTIAL_VALUE_RE.test('ghp_abc')).toBe(true);
    expect(CREDENTIAL_VALUE_RE.test('hello')).toBe(false);
  });

  it('rejects credential-shaped keys regardless of case (i flag is active)', () => {
    expect(() => assertNoCredentialShapedArgs({ TOKEN: 'x' })).toThrow(TransportError);
    expect(() => assertNoCredentialShapedArgs({ Secret: 'x' })).toThrow(TransportError);
    expect(() => assertNoCredentialShapedArgs({ PASSWORD: 'x' })).toThrow(TransportError);
    expect(() => assertNoCredentialShapedArgs({ API_KEY: 'x' })).toThrow(TransportError);
  });

  it('rejects "apikey" without a separator (api[_-]?key matches zero separators)', () => {
    expect(() => assertNoCredentialShapedArgs({ apikey: 'x' })).toThrow(TransportError);
    const err = (() => {
      try { assertNoCredentialShapedArgs({ apikey: 'x' }); }
      catch (e) { return e; }
    })();
    expect((err as TransportError).code).toBe('invalid_args');
  });

  it('accepts primitive non-string values cleanly (number, boolean, null)', () => {
    expect(() => assertNoCredentialShapedArgs(42)).not.toThrow();
    expect(() => assertNoCredentialShapedArgs(true)).not.toThrow();
    expect(() => assertNoCredentialShapedArgs(false)).not.toThrow();
    expect(() => assertNoCredentialShapedArgs(null)).not.toThrow();
  });

  it('accepts empty containers (empty object, empty array) cleanly', () => {
    expect(() => assertNoCredentialShapedArgs({})).not.toThrow();
    expect(() => assertNoCredentialShapedArgs([])).not.toThrow();
  });

  it('rejects a credential-shaped key nested inside a sub-object', () => {
    expect(() => assertNoCredentialShapedArgs({ config: { matrix_token: 'x' } })).toThrow(TransportError);
    const err = (() => {
      try { assertNoCredentialShapedArgs({ outer: { inner: { api_key: 'x' } } }); }
      catch (e) { return e; }
    })();
    expect((err as TransportError).code).toBe('invalid_args');
    expect((err as TransportError).message).toContain('api_key');
  });

  it('rejects a credential-shaped key inside an array element (object nested in array)', () => {
    const secret = 'must-not-appear-in-message';
    const err = (() => {
      try { assertNoCredentialShapedArgs([{ token: secret }]); } catch (e) { return e; }
    })();
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).code).toBe('invalid_args');
    expect((err as TransportError).message).toContain('token');
    expect((err as TransportError).message).not.toContain(secret);
  });

  it('rejects a credential-shaped value at the top level (bare string param)', () => {
    const err = (() => {
      try { assertNoCredentialShapedArgs('ghp_toplevel_fake_token'); } catch (e) { return e; }
    })();
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).code).toBe('invalid_args');
    expect((err as TransportError).message).not.toContain('ghp_toplevel_fake_token');
  });

  it('accepts a near-miss value prefix gh_ (not in the deny pattern gh[posru]_)', () => {
    expect(() => assertNoCredentialShapedArgs({ name: 'gh_not_a_real_prefix' })).not.toThrow();
  });

  it('does not reject a string whose credential-shaped prefix appears mid-value (CREDENTIAL_VALUE_RE is anchored with ^)', () => {
    // The regex is /^(?:gh[posru]_|...)/ — it only matches values that START with
    // the prefix. A log line, doc string, or descriptive value that merely contains
    // a token-shaped substring is intentionally allowed through to avoid false
    // positives on non-secret strings.
    expect(() => assertNoCredentialShapedArgs({ note: 'see ghp_example in the docs' })).not.toThrow();
    expect(() => assertNoCredentialShapedArgs({ msg: 'token format is syt_<base64>' })).not.toThrow();
  });

  it('rejects credential-shaped keys without separators (signingkey, privatekey)', () => {
    expect(() => assertNoCredentialShapedArgs({ signingkey: 'x' })).toThrow(TransportError);
    expect(() => assertNoCredentialShapedArgs({ privatekey: 'x' })).toThrow(TransportError);
    const err = (() => {
      try { assertNoCredentialShapedArgs({ signingkey: 'x' }); } catch (e) { return e; }
    })();
    expect((err as TransportError).code).toBe('invalid_args');
  });
});
