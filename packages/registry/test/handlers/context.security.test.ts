/**
 * Security invariants for `mx_share_context` + `mx_get_context` (T107 / #15) —
 * design §1, §4.7, §6, §9 ("Don't give cognition any authority surface").
 *
 * `mx_share_context` is **the single most dangerous exfiltration surface** among
 * the M1 verbs: a model that wanted to leak a credential it somehow obtained would
 * reach for "share this content." The tests here pin the doubly-bounded secret
 * boundary and the no-authority invariants.
 *
 * Tests pin:
 * - Both verbs are in `MODEL_FACING_ALLOWLIST` and NOT forbidden authority verbs.
 * - The descriptor `input_schema` declares no credential-shaped property name.
 * - Neither input type has a `room` field (room is injected via deps).
 * - Only `share.file/diff/env` + `share.get` are ever dispatched — no
 *   approve/decide/trust/policy method is called.
 * - Credential-shaped `content`/`path` value → `invalid_args` (the REAL
 *   `assertNoCredentialShapedArgs` guard at the registry boundary, mirroring
 *   what `MxClient.call` runs pre-dispatch).
 * - Inbound redaction: a token-shaped value in `inline` is scrubbed to
 *   `«redacted»` by `redactSecrets` (the guard `MxClient.call` runs at its exit)
 *   before it reaches the model — the byte-identity ↔ redaction interaction is
 *   documented explicitly (T107 / Risks #4).
 * - `error.message` is always a fixed, secret-free phrase — never `content`,
 *   `path`, `context_id`, `inline` content, or a raw daemon payload.
 * - Result envelopes are deeply frozen and pass `redactSecrets` unchanged (no
 *   false-positive redaction of audit_ref ids or non-secret payloads).
 * - Both verbs are `sync` — they NEVER return `running` / `awaiting_approval`.
 *
 * Pure unit tests; injected DaemonCall — no daemon, no socket, no env.
 */
import { describe, expect, it } from 'vitest';

import { TransportError, assertNoCredentialShapedArgs, redactSecrets } from '@mx-loom/toolbelt';

import {
  MX_GET_CONTEXT,
  MX_SHARE_CONTEXT,
  MODEL_FACING_ALLOWLIST,
  isForbiddenAuthorityVerb,
  mxGetContext,
  mxShareContext,
  validateEnvelope,
  type DaemonCall,
  type GetContextInput,
  type RoomScopedDeps,
  type ShareContextInput,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOM = '!workspace:homeserver';
const CONTEXT_ID = 'ctx_sec_01';
const SHA256 = 'a'.repeat(64);

/**
 * A fake daemon that mirrors the production `MxClient.call` secret boundary:
 * it runs the REAL `assertNoCredentialShapedArgs` over the params BEFORE
 * "dispatch" and `redactSecrets` over the result at its single exit point.
 * A credential-shaped value/key the handler forwards is rejected exactly as it
 * would be over a real transport, and a token-shaped daemon value is scrubbed
 * inbound — without a socket.
 */
function makeGuardedDeps(opts: {
  shareResp?: unknown;
  getResp?: unknown;
}): RoomScopedDeps & { methods: string[] } {
  const methods: string[] = [];

  const daemon: DaemonCall = {
    call: async (method, params) => {
      methods.push(method);
      assertNoCredentialShapedArgs(params); // throws TransportError('invalid_args')
      if (method.startsWith('share.') && method !== 'share.get') {
        const r = opts.shareResp ?? { context_id: CONTEXT_ID, sha256: SHA256 };
        if (r instanceof Error) throw r;
        return redactSecrets(r);
      }
      if (method === 'share.get') {
        const r = opts.getResp ?? {
          context_id: CONTEXT_ID, kind: 'diff', sha256: SHA256, size_bytes: 128,
          inline: '--- clean diff',
        };
        if (r instanceof Error) throw r;
        return redactSecrets(r);
      }
      throw new Error(`Security test: unexpected method "${method}"`);
    },
  };
  return { daemon, room: ROOM, methods };
}

/** A plain fake daemon (no guard) for non-credential assertions. */
function makeDeps(opts: {
  shareResp?: unknown;
  getResp?: unknown;
  onCall?: (method: string) => void;
}): RoomScopedDeps & { methods: string[] } {
  const methods: string[] = [];

  const daemon: DaemonCall = {
    call: async (method, _params) => {
      methods.push(method);
      opts.onCall?.(method);
      if (method.startsWith('share.') && method !== 'share.get') {
        const r = opts.shareResp ?? { context_id: CONTEXT_ID, sha256: SHA256 };
        if (r instanceof Error) throw r;
        return r;
      }
      if (method === 'share.get') {
        const r = opts.getResp ?? { context_id: CONTEXT_ID, sha256: SHA256, inline: 'clean' };
        if (r instanceof Error) throw r;
        return r;
      }
      throw new Error(`Security test: unexpected method "${method}"`);
    },
  };
  return { daemon, room: ROOM, methods };
}

const VALID_SHARE: ShareContextInput = { kind: 'diff', content: '--- a\n+++ b', path: 'src/main.ts' };
const VALID_GET: GetContextInput = { context_id: CONTEXT_ID };

function expectValid(result: unknown): void {
  expect(
    validateEnvelope(result),
    `envelope invalid: ${JSON.stringify((validateEnvelope as { errors?: unknown }).errors)}`,
  ).toBe(true);
}

// ---------------------------------------------------------------------------
// No-authority allowlist invariants
// ---------------------------------------------------------------------------

describe('mx_share_context / mx_get_context — no-authority allowlist invariants', () => {
  it('mx_share_context is in MODEL_FACING_ALLOWLIST', () => {
    expect(MODEL_FACING_ALLOWLIST).toContain('mx_share_context');
  });

  it('mx_get_context is in MODEL_FACING_ALLOWLIST', () => {
    expect(MODEL_FACING_ALLOWLIST).toContain('mx_get_context');
  });

  it('mx_share_context is NOT a forbidden authority verb', () => {
    expect(isForbiddenAuthorityVerb('mx_share_context')).toBe(false);
  });

  it('mx_get_context is NOT a forbidden authority verb', () => {
    expect(isForbiddenAuthorityVerb('mx_get_context')).toBe(false);
  });

  it('MX_SHARE_CONTEXT descriptor name is "mx_share_context"', () => {
    expect(MX_SHARE_CONTEXT.name).toBe('mx_share_context');
  });

  it('MX_GET_CONTEXT descriptor name is "mx_get_context"', () => {
    expect(MX_GET_CONTEXT.name).toBe('mx_get_context');
  });

  it('MX_SHARE_CONTEXT is not prefixed with a forbidden authority prefix', () => {
    const FORBIDDEN = ['trust.', 'policy.', 'auth.', 'device.', 'cross_signing.', 'recovery.', 'daemon.'];
    for (const prefix of FORBIDDEN) {
      expect(MX_SHARE_CONTEXT.name.startsWith(prefix)).toBe(false);
    }
  });

  it('MX_GET_CONTEXT is not prefixed with a forbidden authority prefix', () => {
    const FORBIDDEN = ['trust.', 'policy.', 'auth.', 'device.', 'cross_signing.', 'recovery.', 'daemon.'];
    for (const prefix of FORBIDDEN) {
      expect(MX_GET_CONTEXT.name.startsWith(prefix)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Secret-free input shape — no credential-shaped property names
// ---------------------------------------------------------------------------

describe('mx_share_context — ShareContextInput has no credential-shaped field', () => {
  it('input keys contain no "token"-suffix field', () => {
    for (const key of Object.keys(VALID_SHARE)) {
      expect(key.endsWith('token')).toBe(false);
      expect(key.endsWith('_token')).toBe(false);
    }
  });

  it('input has no secret/password/key/matrix_/mx_agent_/gh_token field', () => {
    const forbidden = /(?:secret|password|passwd|api[_-]?key|signing[_-]?key|private[_-]?key|matrix_|mx_agent_|gh[_-]?token)/i;
    for (const key of Object.keys(VALID_SHARE)) {
      expect(forbidden.test(key)).toBe(false);
    }
  });

  it('input has no approve/decide/grant/trust authority field', () => {
    const authority = ['approve', 'decide', 'grant', 'trust', 'cancel', 'reject'];
    for (const key of Object.keys(VALID_SHARE)) {
      expect(authority.includes(key)).toBe(false);
    }
  });

  it('input has no "room" field — room is injected via deps, not model input', () => {
    expect(Object.prototype.hasOwnProperty.call(VALID_SHARE, 'room')).toBe(false);
  });

  it('the descriptor input_schema declares no credential-shaped property', () => {
    const props = Object.keys(
      (MX_SHARE_CONTEXT.input_schema as { properties: Record<string, unknown> }).properties,
    );
    const forbidden = /(?:secret|password|passwd|api[_-]?key|signing[_-]?key|private[_-]?key|matrix_|mx_agent_|gh[_-]?token|(?:^|[_-])token$)/i;
    for (const p of props) {
      expect(forbidden.test(p)).toBe(false);
    }
  });
});

describe('mx_get_context — GetContextInput has no credential-shaped field', () => {
  it('input keys contain no credential-shaped suffix', () => {
    const forbidden = /(?:secret|password|passwd|api[_-]?key|signing[_-]?key|private[_-]?key|matrix_|mx_agent_|gh[_-]?token|(?:^|[_-])token$)/i;
    for (const key of Object.keys(VALID_GET)) {
      expect(forbidden.test(key)).toBe(false);
    }
  });

  it('input has no "room" field — room is injected via deps', () => {
    expect(Object.prototype.hasOwnProperty.call(VALID_GET, 'room')).toBe(false);
  });

  it('the descriptor input_schema declares no credential-shaped property', () => {
    const props = Object.keys(
      (MX_GET_CONTEXT.input_schema as { properties: Record<string, unknown> }).properties,
    );
    const forbidden = /(?:secret|password|passwd|api[_-]?key|signing[_-]?key|private[_-]?key|matrix_|mx_agent_|gh[_-]?token|(?:^|[_-])token$)/i;
    for (const p of props) {
      expect(forbidden.test(p)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Both verbs are sync — never return running / awaiting_approval
// ---------------------------------------------------------------------------

describe('mx_share_context / mx_get_context — sync contract (never deferred)', () => {
  it('mxShareContext never returns status: running', async () => {
    const d = makeDeps({});
    const result = await mxShareContext({ kind: 'diff' }, d);
    expect(result.status).not.toBe('running');
    expect(result.handle).toBeNull();
  });

  it('mxShareContext never returns status: awaiting_approval', async () => {
    const d = makeDeps({});
    const result = await mxShareContext({ kind: 'diff' }, d);
    expect(result.status).not.toBe('awaiting_approval');
    expect(result.approval).toBeNull();
  });

  it('mxGetContext never returns status: running', async () => {
    const d = makeDeps({});
    const result = await mxGetContext(VALID_GET, d);
    expect(result.status).not.toBe('running');
    expect(result.handle).toBeNull();
  });

  it('mxGetContext never returns status: awaiting_approval', async () => {
    const d = makeDeps({});
    const result = await mxGetContext(VALID_GET, d);
    expect(result.status).not.toBe('awaiting_approval');
    expect(result.approval).toBeNull();
  });

  it('MX_SHARE_CONTEXT descriptor async_semantics is "sync"', () => {
    expect(MX_SHARE_CONTEXT.async_semantics).toBe('sync');
  });

  it('MX_GET_CONTEXT descriptor async_semantics is "sync"', () => {
    expect(MX_GET_CONTEXT.async_semantics).toBe('sync');
  });
});

// ---------------------------------------------------------------------------
// RPC method discipline — only share.*/get methods dispatched
// ---------------------------------------------------------------------------

describe('mx_share_context — RPC method discipline', () => {
  it('only share.diff is called on a successful diff share', async () => {
    const d = makeDeps({});
    await mxShareContext({ kind: 'diff' }, d);
    expect(d.methods).toEqual(['share.diff']);
  });

  it('no approve, decide, cancel, trust, or policy method is ever dispatched', async () => {
    const FORBIDDEN_METHODS = [
      'approve', 'approval.decide', 'approval.approve', 'approval.reject',
      'trust.add', 'trust.remove', 'policy.update', 'policy.deny',
      'invocation.cancel', 'invocation.approve',
    ];
    const d = makeDeps({});
    await mxShareContext({ kind: 'diff' }, d);
    for (const m of d.methods) {
      expect(FORBIDDEN_METHODS.includes(m)).toBe(false);
    }
  });

  it('on room absence, share.* is never dispatched', async () => {
    const d = makeDeps({});
    await mxShareContext({ kind: 'diff' }, { ...d, room: undefined });
    expect(d.methods).toHaveLength(0);
  });
});

describe('mx_get_context — RPC method discipline', () => {
  it('only share.get is called on a successful fetch', async () => {
    const d = makeDeps({});
    await mxGetContext(VALID_GET, d);
    expect(d.methods).toEqual(['share.get']);
  });

  it('no approve, decide, cancel, trust, or policy method is ever dispatched', async () => {
    const FORBIDDEN_METHODS = [
      'approve', 'approval.decide', 'trust.add', 'policy.update',
      'invocation.cancel', 'invocation.approve',
    ];
    const d = makeDeps({});
    await mxGetContext(VALID_GET, d);
    for (const m of d.methods) {
      expect(FORBIDDEN_METHODS.includes(m)).toBe(false);
    }
  });

  it('on room absence, share.get is never dispatched', async () => {
    const d = makeDeps({});
    await mxGetContext(VALID_GET, { ...d, room: undefined });
    expect(d.methods).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Credential-shaped content/path → invalid_args (the REAL guard)
// This mirrors what MxClient.call runs via assertNoCredentialShapedArgs.
// ---------------------------------------------------------------------------

describe('mx_share_context — credential-shaped content/path surface as invalid_args', () => {
  it('a sk-ant-* token as content value is rejected → invalid_args', async () => {
    const d = makeGuardedDeps({});
    const result = await mxShareContext(
      { kind: 'diff', content: 'sk-ant-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      d,
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
    expectValid(result);
  });

  it('a ghp_ token as content value is rejected → invalid_args', async () => {
    const d = makeGuardedDeps({});
    const result = await mxShareContext(
      { kind: 'diff', content: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      d,
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
    expectValid(result);
  });

  it('a PEM private-key header as content is rejected → invalid_args', async () => {
    const d = makeGuardedDeps({});
    const result = await mxShareContext(
      { kind: 'file', content: '-----BEGIN OPENSSH PRIVATE KEY-----' },
      d,
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
    expectValid(result);
  });

  it('a Bearer token as path value is rejected → invalid_args', async () => {
    const d = makeGuardedDeps({});
    const result = await mxShareContext(
      { kind: 'file', path: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      d,
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
    expectValid(result);
  });

  it('TransportError("invalid_args") from share.* → invalid_args envelope', async () => {
    const d = makeDeps({
      shareResp: new TransportError('invalid_args', 'credential-shaped content rejected'),
    });
    const result = await mxShareContext({ kind: 'diff', content: 'clean content' }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
    expectValid(result);
  });

  it('invalid_args error.message is the fixed phrase — never the rejected content value', async () => {
    const d = makeGuardedDeps({});
    const result = await mxShareContext(
      { kind: 'diff', content: 'sk-ant-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      d,
    );
    expect(result.error?.message).toBe('the request was rejected as invalid');
    expect(JSON.stringify(result)).not.toContain('sk-ant-');
  });

  it('a clean diff content passes the guard and runs normally', async () => {
    const d = makeGuardedDeps({});
    const result = await mxShareContext(
      { kind: 'diff', content: '--- a.ts\n+++ b.ts\n@@ -1 +1 @@\n-old\n+new' },
      d,
    );
    expect(result.status).toBe('ok');
    expectValid(result);
  });
});

// ---------------------------------------------------------------------------
// Secret-free envelope output — error.message never echoes model input
// ---------------------------------------------------------------------------

describe('mx_share_context — secret-free envelope output', () => {
  it('error.message for a denial never echoes content, path, or kind', async () => {
    const d = makeDeps({
      shareResp: new TransportError('rpc', 'rpc err', { cause: { error: { code: 'policy_denied' } } }),
    });
    const result = await mxShareContext(
      { kind: 'diff', content: 'sensitive-content', path: 'secret/path.ts' },
      d,
    );
    expect(result.error?.message).toBe('denied by the receiver policy');
    expect(result.error?.message).not.toContain('sensitive-content');
    expect(result.error?.message).not.toContain('secret/path.ts');
    expect(result.error?.message).not.toContain('diff');
  });

  it('error.message for invalid_args never echoes the rejected content value', async () => {
    const d = makeGuardedDeps({});
    const result = await mxShareContext(
      { kind: 'env', content: 'sk-ant-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      d,
    );
    expect(result.error?.message).toBe('the request was rejected as invalid');
    expect(JSON.stringify(result)).not.toContain('sk-ant-');
  });
});

describe('mx_get_context — secret-free envelope output', () => {
  it('error.message for a not_found never echoes the context_id', async () => {
    const resp = new TransportError('rpc', 'rpc err', { cause: { error: { code: 'unknown_context' } } });
    const d = makeDeps({ getResp: resp });
    const result = await mxGetContext({ context_id: 'ctx_super_sensitive_id' }, d);
    expect(result.error?.message).toBe('no such invocation');
    expect(result.error?.message).not.toContain('ctx_super_sensitive_id');
  });

  it('error.message for a denial never echoes the context_id', async () => {
    const resp = new TransportError('rpc', 'rpc err', { cause: { error: { code: 'policy_denied' } } });
    const d = makeDeps({ getResp: resp });
    const result = await mxGetContext({ context_id: 'ctx_sensitive_id' }, d);
    expect(result.error?.message).toBe('denied by the receiver policy');
    expect(result.error?.message).not.toContain('ctx_sensitive_id');
  });
});

// ---------------------------------------------------------------------------
// Inbound redaction (the byte-identity ↔ redaction interaction — Risks #4)
//
// `MxClient.call` runs `redactSecrets` over the result before the handler sees
// it. A token-shaped value in returned `inline` content is therefore scrubbed
// to `«redacted»` before reaching the model.
//
// DOCUMENTED INTERACTION (T107 Risks #4): a fetched artifact containing a
// token-shaped substring is altered by inbound redaction, breaking byte-identity
// for that content. The handler does NOT recompute sha256 over the (possibly
// redacted) inline bytes precisely because a recompute would mismatch the
// daemon's pre-redaction digest and falsely report an integrity failure.
// The share-time credential guard (which rejects token-shaped content before
// it is stored through mx-loom) keeps the secret-free invariant without
// redaction needing to fire on fetch for realistic (secret-free) artifacts.
// ---------------------------------------------------------------------------

describe('mx_get_context — inbound redaction: token-shaped inline content is scrubbed', () => {
  it('a ghp_ token in inline content is scrubbed to «redacted» by redactSecrets', async () => {
    const d = makeGuardedDeps({
      getResp: {
        context_id: CONTEXT_ID,
        kind: 'diff',
        sha256: SHA256,
        size_bytes: 80,
        inline: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
    });
    const result = await mxGetContext(VALID_GET, d);
    const json = JSON.stringify(result);
    expect(json).not.toContain('ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(json).toContain('«redacted»');
    expectValid(result);
  });

  it('clean inline content (no token-shaped values) is passed through unchanged', async () => {
    const d = makeGuardedDeps({
      getResp: {
        context_id: CONTEXT_ID,
        kind: 'diff',
        sha256: SHA256,
        size_bytes: 32,
        inline: '--- a\n+++ b\n-old\n+new',
      },
    });
    const result = await mxGetContext(VALID_GET, d);
    expect(result.status).toBe('ok');
    const r = result.result as Record<string, unknown>;
    expect(r.inline).toBe('--- a\n+++ b\n-old\n+new');
    expectValid(result);
  });
});

// ---------------------------------------------------------------------------
// redactSecrets pass-through + immutability on resolved envelopes
// ---------------------------------------------------------------------------

describe('mx_share_context + mx_get_context — immutability and redactSecrets pass-through', () => {
  it('mxShareContext: ok envelope with non-secret result is unchanged after redactSecrets', async () => {
    const d = makeDeps({
      shareResp: {
        context_id: CONTEXT_ID,
        sha256: SHA256,
        invocation_id: 'inv_clean_01',
        request_id: 'req_clean_01',
        room: ROOM,
        event_id: '$evt_clean_01',
      },
    });
    const result = await mxShareContext({ kind: 'diff', content: 'clean diff' }, d);
    expect(result.status).toBe('ok');
    expect(redactSecrets(result)).toEqual(result);
  });

  it('mxGetContext: ok envelope with clean result is unchanged after redactSecrets', async () => {
    const d = makeDeps({
      getResp: {
        context_id: CONTEXT_ID,
        kind: 'diff',
        sha256: SHA256,
        size_bytes: 32,
        inline: 'clean diff content',
        invocation_id: 'inv_clean_get_01',
        request_id: 'req_clean_get_01',
        room: ROOM,
        event_id: '$evt_clean_get_01',
      },
    });
    const result = await mxGetContext(VALID_GET, d);
    expect(result.status).toBe('ok');
    expect(redactSecrets(result)).toEqual(result);
  });

  it('audit_ref ids are not redacted by redactSecrets', async () => {
    const d = makeDeps({
      shareResp: {
        context_id: CONTEXT_ID,
        sha256: SHA256,
        invocation_id: 'inv_audit_sec',
        request_id: 'req_audit_sec',
        room: '!room:test',
        event_id: '$evt_audit_sec',
      },
    });
    const result = await mxShareContext({ kind: 'diff' }, d);
    const redacted = redactSecrets(result) as typeof result;
    expect(redacted.audit_ref.invocation_id).toBe('inv_audit_sec');
    expect(redacted.audit_ref.request_id).toBe('req_audit_sec');
    expect(redacted.audit_ref.room).toBe('!room:test');
    expect(redacted.audit_ref.event_id).toBe('$evt_audit_sec');
  });

  it('mxShareContext ok envelope is deeply frozen', async () => {
    const d = makeDeps({});
    const result = await mxShareContext({ kind: 'diff' }, d);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.audit_ref)).toBe(true);
  });

  it('mxGetContext ok envelope is deeply frozen', async () => {
    const d = makeDeps({});
    const result = await mxGetContext(VALID_GET, d);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.audit_ref)).toBe(true);
  });

  it('mutation of a frozen mxShareContext envelope field throws in strict mode', async () => {
    const d = makeDeps({});
    const result = await mxShareContext({ kind: 'diff' }, d);
    expect(() => {
      (result as unknown as Record<string, unknown>).status = 'error';
    }).toThrow();
  });

  it('mutation of a frozen mxGetContext envelope field throws in strict mode', async () => {
    const d = makeDeps({});
    const result = await mxGetContext(VALID_GET, d);
    expect(() => {
      (result as unknown as Record<string, unknown>).status = 'error';
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Error taxonomy — every emitted error.code is in the closed set
// ---------------------------------------------------------------------------

describe('mx_share_context + mx_get_context — error taxonomy conformance', () => {
  const ERROR_CODES = new Set([
    'policy_denied', 'untrusted_key', 'approval_denied', 'approval_expired',
    'timeout', 'not_found', 'invalid_args', 'target_offline', 'internal',
  ]);

  it('every mxShareContext result code is in the closed ERROR_CODES set', async () => {
    const scenarios = [
      { resp: null },
      { resp: {} },
      { resp: { context_id: 'ctx_01', sha256: SHA256 } },
      { resp: new TransportError('rpc', 'err', { cause: { error: { code: 'policy_denied' } } }) },
      { resp: { ok: false, error: { code: 'untrusted_key' } } },
      { resp: new TransportError('timeout', 'timed out') },
      { resp: new TransportError('rpc', 'err', { cause: { error: { code: 'invalid_args' } } }) },
    ];
    for (const s of scenarios) {
      const d = makeDeps({ shareResp: s.resp });
      const result = await mxShareContext({ kind: 'diff' }, d);
      if (result.error !== null) {
        expect(ERROR_CODES.has(result.error.code)).toBe(true);
      }
      expectValid(result);
    }
  });

  it('every mxGetContext result code is in the closed ERROR_CODES set', async () => {
    const scenarios = [
      { resp: null },
      { resp: {} },
      { resp: { context_id: 'ctx_01', sha256: SHA256, inline: 'clean' } },
      { resp: new TransportError('rpc', 'err', { cause: { error: { code: 'unknown_context' } } }) },
      { resp: new TransportError('rpc', 'err', { cause: { error: { code: 'policy_denied' } } }) },
      { resp: new TransportError('timeout', 'timed out') },
    ];
    for (const s of scenarios) {
      const d = makeDeps({ getResp: s.resp });
      const result = await mxGetContext(VALID_GET, d);
      if (result.error !== null) {
        expect(ERROR_CODES.has(result.error.code)).toBe(true);
      }
      expectValid(result);
    }
  });
});
