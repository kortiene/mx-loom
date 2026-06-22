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

// --- T008: hardened deny-list (allowlisted-secret shapes the rule names) ---

describe('assertNoCredentialShapedArgs — hardened deny-list (T008)', () => {
  const hardenedKeyCases: Array<[string, Record<string, unknown>]> = [
    ['mx_agent_ prefix', { mx_agent_signing_key: 'x' }],
    ['mx_agent_token', { mx_agent_token: 'x' }],
    ['GH_TOKEN (exact)', { GH_TOKEN: 'x' }],
    ['GITHUB_TOKEN (_token suffix)', { GITHUB_TOKEN: 'x' }],
    ['gh_token', { gh_token: 'x' }],
    ['access_token (_token suffix)', { access_token: 'x' }],
    ['auth_token (_token suffix)', { auth_token: 'x' }],
    ['refresh_token (_token suffix)', { refresh_token: 'x' }],
    ['bare token (whole key)', { token: 'x' }],
  ];

  for (const [label, params] of hardenedKeyCases) {
    it(`rejects credential-shaped key '${label}' as invalid_args`, () => {
      const err = (() => {
        try { assertNoCredentialShapedArgs(params); } catch (e) { return e; }
      })();
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).code).toBe('invalid_args');
    });
  }

  // The crux of the refinement (Risk #1): delegation forwards arbitrary inner-tool
  // args, many of which legitimately contain `token`. A boundaried `token` match
  // must accept these count-shaped keys while still rejecting the credential ones.
  // token_type, token_id, tokenize: start with "token" but neither the key NOR
  // the boundaried `(?:^|[_-])token$` form matches — correctly not credential-shaped.
  const falsePositiveAcceptKeys = [
    'max_tokens',
    'token_count',
    'num_tokens',
    'tokens_used',
    'token_type',
    'token_id',
    'tokenize',
  ];
  for (const key of falsePositiveAcceptKeys) {
    it(`accepts the non-credential pass-through key '${key}' (boundaried token match)`, () => {
      expect(() => assertNoCredentialShapedArgs({ [key]: 5 })).not.toThrow();
      expect(CREDENTIAL_KEY_RE.test(key)).toBe(false);
    });
  }

  const hardenedValueCases: Array<[string, unknown]> = [
    ['sk-ant- (Anthropic)', { x: 'sk-ant-api03-FAKEFAKEFAKEFAKE' }],
    ['sk- bounded (OpenAI)', { x: 'sk-abcdefghij1234567890ABCDEFGH' }],
    ['AKIA… (AWS access-key id)', { x: 'AKIAIOSFODNN7EXAMPLE' }],
    ['PEM private-key header', { x: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...' }],
    ['PEM (no algorithm)', { x: '-----BEGIN PRIVATE KEY-----\nMIIE...' }],
    ['nested AWS key in array', { items: ['ok', 'AKIAIOSFODNN7EXAMPLE'] }],
  ];

  for (const [label, params] of hardenedValueCases) {
    it(`rejects credential-shaped value (${label}) as invalid_args`, () => {
      const err = (() => {
        try { assertNoCredentialShapedArgs(params); } catch (e) { return e; }
      })();
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).code).toBe('invalid_args');
    });
  }

  // Value near-misses the anchored / bounded patterns must NOT catch.
  it('accepts a short sk- value (below the bounded length, not OpenAI-key shaped)', () => {
    expect(() => assertNoCredentialShapedArgs({ note: 'sk-foo' })).not.toThrow();
    expect(() => assertNoCredentialShapedArgs({ id: 'sk-12345' })).not.toThrow();
  });

  it('accepts an AKIA-prefixed value that is too short to be an access-key id', () => {
    expect(() => assertNoCredentialShapedArgs({ code: 'AKIASHORT' })).not.toThrow();
  });

  it('accepts a value that merely contains a PEM header mid-string (anchored ^)', () => {
    expect(() => assertNoCredentialShapedArgs({ doc: 'paste -----BEGIN PRIVATE KEY----- here' })).not.toThrow();
  });

  it('hardened-value rejection names the path, never the value', () => {
    const secret = 'sk-ant-MUST_NOT_APPEAR_IN_MESSAGE';
    try {
      assertNoCredentialShapedArgs({ outer: { provider_arg: secret } });
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as TransportError).message;
      expect(msg).toContain('$.outer.provider_arg');
      expect(msg).not.toContain(secret);
    }
  });

  it('hardened-key rejection names the key, never the value', () => {
    const secret = 'fake-gh-token-value-must-not-appear';
    try {
      assertNoCredentialShapedArgs({ GH_TOKEN: secret });
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as TransportError).message;
      expect(msg).toContain('GH_TOKEN');
      expect(msg).not.toContain(secret);
    }
  });

  // Pin the hardened patterns directly against the exported regex constants so
  // any future refactor that loosens them shows up as a test failure here.
  it('CREDENTIAL_KEY_RE directly matches the hardened key shapes the rule names', () => {
    expect(CREDENTIAL_KEY_RE.test('GITHUB_TOKEN')).toBe(true);
    expect(CREDENTIAL_KEY_RE.test('refresh_token')).toBe(true);
    expect(CREDENTIAL_KEY_RE.test('mx_agent_signing_key')).toBe(true);
    expect(CREDENTIAL_KEY_RE.test('GH_TOKEN')).toBe(true);
    // Boundaried: count-shaped keys must NOT match.
    expect(CREDENTIAL_KEY_RE.test('max_tokens')).toBe(false);
    expect(CREDENTIAL_KEY_RE.test('token_count')).toBe(false);
    expect(CREDENTIAL_KEY_RE.test('token_type')).toBe(false);
    expect(CREDENTIAL_KEY_RE.test('token_id')).toBe(false);
  });

  it('CREDENTIAL_VALUE_RE directly matches the hardened value prefixes the rule names', () => {
    expect(CREDENTIAL_VALUE_RE.test('sk-ant-api03-FAKEFAKEFAKEFAKE')).toBe(true);
    expect(CREDENTIAL_VALUE_RE.test('sk-abcdefghij1234567890ABCDEFGH')).toBe(true); // OpenAI bounded
    expect(CREDENTIAL_VALUE_RE.test('AKIAIOSFODNN7EXAMPLE')).toBe(true);
    expect(CREDENTIAL_VALUE_RE.test('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    expect(CREDENTIAL_VALUE_RE.test('-----BEGIN PRIVATE KEY-----')).toBe(true);
    // Near-misses must NOT match.
    expect(CREDENTIAL_VALUE_RE.test('sk-foo')).toBe(false);
    expect(CREDENTIAL_VALUE_RE.test('AKIASHORT')).toBe(false);
    expect(CREDENTIAL_VALUE_RE.test('not-a-real-key')).toBe(false);
  });
});
