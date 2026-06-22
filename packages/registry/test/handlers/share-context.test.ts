/**
 * `mxShareContext` handler — context publish (T107 / #15): room provenance,
 * `kind` → `share.*` routing, param forwarding/omission, normalization, denial
 * / fault mapping, `audit_ref` disposition, and robustness.
 *
 * Because the secret guard and policy enforcement are **receiver-side**, the
 * fake `share.*` daemon *simulates* each outcome (the handler performs no
 * threshold / media / sha256 computation):
 *
 * - Phase 1: absent/empty room → internal, no daemon calls made.
 * - Phase 2: kind routing — `kind:'file'` dispatches `share.file`, `kind:'diff'`
 *   → `share.diff`, `kind:'env'` → `share.env`.
 * - Phase 3: param forwarding — `path`/`content`/`encoding` forwarded verbatim;
 *   omitted when absent; `room` from deps, never model input; no undefined leaks.
 * - Phase 4: normalization — a flat `{ context_id, sha256, … }` success reply →
 *   `ok({ context_id, sha256 }, audit_ref)`, populated `audit_ref`.
 * - Denial/fault: `policy_denied` (rpc + resolved) → `denied('policy_denied')`;
 *   `untrusted_key` / `target_offline` / `timeout` → correct taxonomy codes.
 * - Robustness: malformed responses (scalar/array/null/empty) → safe internal,
 *   never a thrown error, every output validates ENVELOPE_SCHEMA.
 *
 * Pure unit tests; injected DaemonCall — no daemon, no socket, no env.
 */
import { describe, expect, it } from 'vitest';

import { TransportError } from '@mx-loom/toolbelt';

import {
  mxShareContext,
  validateEnvelope,
  type DaemonCall,
  type RoomScopedDeps,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const ROOM = '!workspace:homeserver';
const CONTEXT_ID = 'ctx_diff_01';
const SHA256 = 'a'.repeat(64);

const SHARE_SUCCESS_RESPONSE = {
  context_id: CONTEXT_ID,
  sha256: SHA256,
  invocation_id: 'inv_share_01',
  request_id: 'req_share_01',
  room: ROOM,
  event_id: '$evt_share_01',
};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeDeps(opts: {
  resp?: unknown;
  room?: string;
}): RoomScopedDeps & {
  readonly calls: Array<{ method: string; params: unknown }>;
  callCount(method: string): number;
} {
  const calls: Array<{ method: string; params: unknown }> = [];

  const daemon: DaemonCall = {
    call: async (method, params) => {
      calls.push({ method, params });
      const r = opts.resp;
      if (r instanceof Error) throw r;
      if (r === undefined) throw new Error(`Unexpected call: ${method}`);
      return r;
    },
  };

  return {
    daemon,
    room: 'room' in opts ? opts.room : ROOM,
    calls,
    callCount: (method: string) => calls.filter((c) => c.method === method).length,
  };
}

function te(code: string, message = 'error', cause?: unknown): TransportError {
  return new TransportError(code as 'rpc', message, cause !== undefined ? { cause } : undefined);
}

function rpcDaemonError(code: string): TransportError {
  return te('rpc', `rpc error: ${code}`, { error: { code } });
}

function expectValid(result: unknown): void {
  const valid = validateEnvelope(result);
  expect(valid, `envelope invalid: ${JSON.stringify((validateEnvelope as { errors?: unknown }).errors)}`).toBe(true);
}

const VALID_INPUT = { kind: 'diff' as const };

// ---------------------------------------------------------------------------
// Phase 1 — room provenance
// ---------------------------------------------------------------------------

describe('mxShareContext — Phase 1: room provenance', () => {
  it('absent room → internal, zero daemon calls', async () => {
    const d = makeDeps({ room: undefined, resp: SHARE_SUCCESS_RESPONSE });
    const result = await mxShareContext(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expect(d.calls).toHaveLength(0);
    expectValid(result);
  });

  it('empty string room → internal, zero daemon calls', async () => {
    const d = makeDeps({ room: '', resp: SHARE_SUCCESS_RESPONSE });
    const result = await mxShareContext(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expect(d.calls).toHaveLength(0);
    expectValid(result);
  });

  it('absent room never dispatches share.*', async () => {
    const d = makeDeps({ room: undefined, resp: SHARE_SUCCESS_RESPONSE });
    await mxShareContext(VALID_INPUT, d);
    expect(d.calls).toHaveLength(0);
  });

  it('absent room: audit_ref is all-null (no round-trip)', async () => {
    const d = makeDeps({ room: undefined, resp: SHARE_SUCCESS_RESPONSE });
    const result = await mxShareContext(VALID_INPUT, d);
    expect(result.audit_ref.invocation_id).toBeNull();
    expect(result.audit_ref.request_id).toBeNull();
    expect(result.audit_ref.room).toBeNull();
    expect(result.audit_ref.event_id).toBeNull();
  });

  it('room-provenance error.message is the fixed phrase (not model input)', async () => {
    const d = makeDeps({ room: undefined, resp: SHARE_SUCCESS_RESPONSE });
    const result = await mxShareContext(VALID_INPUT, d);
    expect(result.error?.message).toBe('no workspace room configured for share');
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — kind → RPC routing
// ---------------------------------------------------------------------------

describe('mxShareContext — Phase 2: kind → RPC routing', () => {
  it('kind "file" dispatches share.file', async () => {
    const d = makeDeps({ resp: SHARE_SUCCESS_RESPONSE });
    await mxShareContext({ kind: 'file' }, d);
    expect(d.calls[0]?.method).toBe('share.file');
  });

  it('kind "diff" dispatches share.diff', async () => {
    const d = makeDeps({ resp: SHARE_SUCCESS_RESPONSE });
    await mxShareContext({ kind: 'diff' }, d);
    expect(d.calls[0]?.method).toBe('share.diff');
  });

  it('kind "env" dispatches share.env', async () => {
    const d = makeDeps({ resp: SHARE_SUCCESS_RESPONSE });
    await mxShareContext({ kind: 'env' }, d);
    expect(d.calls[0]?.method).toBe('share.env');
  });

  it('exactly one daemon call is made per share', async () => {
    const d = makeDeps({ resp: SHARE_SUCCESS_RESPONSE });
    await mxShareContext({ kind: 'diff' }, d);
    expect(d.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — param forwarding / omission
// ---------------------------------------------------------------------------

describe('mxShareContext — Phase 3: param forwarding and omission', () => {
  it('room is forwarded from deps.room, not from input', async () => {
    const d = makeDeps({ resp: SHARE_SUCCESS_RESPONSE });
    await mxShareContext({ kind: 'diff' }, d);
    const p = d.calls[0]?.params as Record<string, unknown>;
    expect(p.room).toBe(ROOM);
  });

  it('path forwarded verbatim when present', async () => {
    const d = makeDeps({ resp: SHARE_SUCCESS_RESPONSE });
    await mxShareContext({ kind: 'file', path: 'src/main.ts' }, d);
    const p = d.calls[0]?.params as Record<string, unknown>;
    expect(p.path).toBe('src/main.ts');
  });

  it('path absent → omitted from params (key not present)', async () => {
    const d = makeDeps({ resp: SHARE_SUCCESS_RESPONSE });
    await mxShareContext({ kind: 'diff' }, d);
    const p = d.calls[0]?.params as Record<string, unknown>;
    expect('path' in p).toBe(false);
  });

  it('content forwarded verbatim when present', async () => {
    const d = makeDeps({ resp: SHARE_SUCCESS_RESPONSE });
    await mxShareContext({ kind: 'diff', content: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new' }, d);
    const p = d.calls[0]?.params as Record<string, unknown>;
    expect(p.content).toBe('--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new');
  });

  it('content absent → omitted from params (key not present)', async () => {
    const d = makeDeps({ resp: SHARE_SUCCESS_RESPONSE });
    await mxShareContext({ kind: 'diff' }, d);
    const p = d.calls[0]?.params as Record<string, unknown>;
    expect('content' in p).toBe(false);
  });

  it('encoding forwarded verbatim when present', async () => {
    const d = makeDeps({ resp: SHARE_SUCCESS_RESPONSE });
    await mxShareContext({ kind: 'file', encoding: 'base64' }, d);
    const p = d.calls[0]?.params as Record<string, unknown>;
    expect(p.encoding).toBe('base64');
  });

  it('encoding absent → omitted from params (key not present)', async () => {
    const d = makeDeps({ resp: SHARE_SUCCESS_RESPONSE });
    await mxShareContext({ kind: 'diff' }, d);
    const p = d.calls[0]?.params as Record<string, unknown>;
    expect('encoding' in p).toBe(false);
  });

  it('all optional params forwarded together', async () => {
    const d = makeDeps({ resp: SHARE_SUCCESS_RESPONSE });
    await mxShareContext({ kind: 'file', path: 'a.ts', content: 'data', encoding: 'utf-8' }, d);
    const p = d.calls[0]?.params as Record<string, unknown>;
    expect(p.room).toBe(ROOM);
    expect(p.path).toBe('a.ts');
    expect(p.content).toBe('data');
    expect(p.encoding).toBe('utf-8');
  });

  it('no params value is undefined', async () => {
    const d = makeDeps({ resp: SHARE_SUCCESS_RESPONSE });
    await mxShareContext({ kind: 'file', path: 'a.ts', content: 'x', encoding: 'utf-8' }, d);
    const p = d.calls[0]?.params as Record<string, unknown>;
    for (const value of Object.values(p)) {
      expect(value).not.toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 4 — normalization: flat success payload → ok({ context_id, sha256 })
// ---------------------------------------------------------------------------

describe('mxShareContext — Phase 4: normalization', () => {
  it('flat success reply → status: ok', async () => {
    const d = makeDeps({ resp: SHARE_SUCCESS_RESPONSE });
    const result = await mxShareContext(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    expect(result.error).toBeNull();
    expect(result.handle).toBeNull();
    expect(result.approval).toBeNull();
    expectValid(result);
  });

  it('result carries context_id verbatim', async () => {
    const d = makeDeps({ resp: SHARE_SUCCESS_RESPONSE });
    const result = await mxShareContext(VALID_INPUT, d);
    expect((result.result as Record<string, unknown>).context_id).toBe(CONTEXT_ID);
  });

  it('result carries sha256 verbatim', async () => {
    const d = makeDeps({ resp: SHARE_SUCCESS_RESPONSE });
    const result = await mxShareContext(VALID_INPUT, d);
    expect((result.result as Record<string, unknown>).sha256).toBe(SHA256);
  });

  it('audit_ref populated from the share response (publish is a Matrix round-trip)', async () => {
    const d = makeDeps({ resp: SHARE_SUCCESS_RESPONSE });
    const result = await mxShareContext(VALID_INPUT, d);
    expect(result.audit_ref.invocation_id).toBe('inv_share_01');
    expect(result.audit_ref.request_id).toBe('req_share_01');
    expect(result.audit_ref.room).toBe(ROOM);
    expect(result.audit_ref.event_id).toBe('$evt_share_01');
  });

  it('nested audit_ref block is extracted correctly', async () => {
    const resp = {
      context_id: CONTEXT_ID,
      sha256: SHA256,
      audit_ref: {
        invocation_id: 'inv_nested_01',
        request_id: 'req_nested_01',
        room: ROOM,
        event_id: '$evt_nested_01',
      },
    };
    const d = makeDeps({ resp });
    const result = await mxShareContext(VALID_INPUT, d);
    expect(result.audit_ref.invocation_id).toBe('inv_nested_01');
    expect(result.audit_ref.request_id).toBe('req_nested_01');
    expect(result.audit_ref.event_id).toBe('$evt_nested_01');
    expectValid(result);
  });

  it('success response missing sha256 → result has no sha256 (never fabricated)', async () => {
    const resp = { context_id: CONTEXT_ID, invocation_id: 'inv_nosha_01' };
    const d = makeDeps({ resp });
    const result = await mxShareContext(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    expect((result.result as Record<string, unknown>).sha256).toBeUndefined();
    expectValid(result);
  });

  it('extra fields in the response are NOT included in the projected result', async () => {
    const resp = {
      context_id: CONTEXT_ID,
      sha256: SHA256,
      extra_field: 'should-be-dropped',
      __raw: 'also-dropped',
    };
    const d = makeDeps({ resp });
    const result = await mxShareContext(VALID_INPUT, d);
    const r = result.result as Record<string, unknown>;
    expect(r.extra_field).toBeUndefined();
    expect(r.__raw).toBeUndefined();
    expect(Object.keys(r).sort()).toEqual(['context_id', 'sha256']);
    expectValid(result);
  });
});

// ---------------------------------------------------------------------------
// Denial / fault mapping
// ---------------------------------------------------------------------------

describe('mxShareContext — denial / fault mapping', () => {
  it('share.* rpc policy_denied → denied("policy_denied")', async () => {
    const d = makeDeps({ resp: rpcDaemonError('policy_denied') });
    const result = await mxShareContext(VALID_INPUT, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
    expectValid(result);
  });

  it('share.* resolves {ok:false, error:{code:"policy_denied"}} → denied("policy_denied")', async () => {
    const d = makeDeps({ resp: { ok: false, error: { code: 'policy_denied' } } });
    const result = await mxShareContext(VALID_INPUT, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
    expectValid(result);
  });

  it('share.* rpc untrusted_key → denied("untrusted_key")', async () => {
    const d = makeDeps({ resp: rpcDaemonError('untrusted_key') });
    const result = await mxShareContext(VALID_INPUT, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('untrusted_key');
    expectValid(result);
  });

  it('share.* rpc agent_offline → errored("target_offline")', async () => {
    const d = makeDeps({ resp: rpcDaemonError('agent_offline') });
    const result = await mxShareContext(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('target_offline');
    expectValid(result);
  });

  it('share.* transport timeout → errored("timeout")', async () => {
    const d = makeDeps({ resp: te('timeout', 'socket timed out') });
    const result = await mxShareContext(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('timeout');
    expectValid(result);
  });

  it('share.* transport not_running → errored("internal")', async () => {
    const d = makeDeps({ resp: te('not_running') });
    const result = await mxShareContext(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('share.* rpc invalid_args → errored("invalid_args")', async () => {
    const d = makeDeps({ resp: rpcDaemonError('invalid_args') });
    const result = await mxShareContext(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
    expectValid(result);
  });

  it('TransportError("invalid_args") from share.* → invalid_args envelope', async () => {
    const d = makeDeps({ resp: new TransportError('invalid_args', 'credential-shaped content rejected') });
    const result = await mxShareContext(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
    expectValid(result);
  });

  it('thrown rpc policy_denied: audit_ref is all-null (no round-trip = EMPTY_AUDIT_REF)', async () => {
    const d = makeDeps({ resp: rpcDaemonError('policy_denied') });
    const result = await mxShareContext(VALID_INPUT, d);
    expect(result.audit_ref.invocation_id).toBeNull();
    expect(result.audit_ref.request_id).toBeNull();
    expect(result.audit_ref.room).toBeNull();
    expect(result.audit_ref.event_id).toBeNull();
  });

  it('resolved {ok:false} with audit_ref fields → audit_ref populated (round-trip DID happen)', async () => {
    const resp = {
      ok: false,
      error: { code: 'policy_denied' },
      invocation_id: 'inv_pd_01',
      request_id: 'req_pd_01',
      room: ROOM,
      event_id: '$evt_pd_01',
    };
    const d = makeDeps({ resp });
    const result = await mxShareContext(VALID_INPUT, d);
    expect(result.status).toBe('denied');
    expect(result.audit_ref.invocation_id).toBe('inv_pd_01');
    expect(result.audit_ref.request_id).toBe('req_pd_01');
    expectValid(result);
  });

  it('policy_denied error.message is the fixed phrase (never echoes content or path)', async () => {
    const d = makeDeps({ resp: rpcDaemonError('policy_denied') });
    const result = await mxShareContext({ kind: 'diff', content: 'some diff content', path: 'secret/path.ts' }, d);
    expect(result.error?.message).toBe('denied by the receiver policy');
    expect(result.error?.message).not.toContain('diff');
    expect(result.error?.message).not.toContain('secret/path.ts');
  });
});

// ---------------------------------------------------------------------------
// Robustness — handler never throws, every output validates ENVELOPE_SCHEMA
// ---------------------------------------------------------------------------

describe('mxShareContext — robustness / never-throws', () => {
  it('malformed response (null) → internal, never throws', async () => {
    const d = makeDeps({ resp: null });
    const result = await mxShareContext(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('malformed response (scalar 42) → internal', async () => {
    const d = makeDeps({ resp: 42 });
    const result = await mxShareContext(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('malformed response (array) → internal', async () => {
    const d = makeDeps({ resp: [] });
    const result = await mxShareContext(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('malformed response (empty object) → internal (no context_id, no error signal)', async () => {
    const d = makeDeps({ resp: {} });
    const result = await mxShareContext(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('object with context_id but no sha256 → ok (sha256 optional in projection)', async () => {
    const d = makeDeps({ resp: { context_id: CONTEXT_ID } });
    const result = await mxShareContext(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    expectValid(result);
  });

  it('plain Error (non-TransportError) from share.* → internal', async () => {
    const d = makeDeps({ resp: new Error('unexpected') });
    const result = await mxShareContext(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('all code paths produce a valid ENVELOPE_SCHEMA output', async () => {
    const scenarios: Array<{ resp?: unknown; room?: string }> = [
      { resp: null },
      { resp: {} },
      { resp: SHARE_SUCCESS_RESPONSE },
      { resp: rpcDaemonError('policy_denied') },
      { resp: { ok: false, error: { code: 'policy_denied' } } },
      { resp: te('timeout') },
      { resp: rpcDaemonError('untrusted_key') },
      { resp: SHARE_SUCCESS_RESPONSE, room: '' },
    ];
    for (const s of scenarios) {
      const d = makeDeps(s);
      const result = await mxShareContext(VALID_INPUT, d);
      expectValid(result);
    }
  });
});

// ---------------------------------------------------------------------------
// AC 1 (share half): share a diff returns {context_id, sha256}
// ---------------------------------------------------------------------------

describe('mxShareContext — AC 1: share a diff returns context_id and sha256', () => {
  it('share.diff success → ok, result contains context_id and sha256', async () => {
    const d = makeDeps({ resp: SHARE_SUCCESS_RESPONSE });
    const result = await mxShareContext({ kind: 'diff', content: '--- a\n+++ b\n-old\n+new', path: 'src/foo.ts' }, d);
    expect(result.status).toBe('ok');
    const r = result.result as Record<string, unknown>;
    expect(typeof r.context_id).toBe('string');
    expect(typeof r.sha256).toBe('string');
    expectValid(result);
  });

  it('env share with content → share.env dispatched with content in params', async () => {
    const envContent = 'NODE_ENV=production\nDEBUG=false';
    const d = makeDeps({ resp: { context_id: 'ctx_env_01', sha256: 'b'.repeat(64) } });
    await mxShareContext({ kind: 'env', content: envContent }, d);
    const p = d.calls[0]?.params as Record<string, unknown>;
    expect(d.calls[0]?.method).toBe('share.env');
    expect(p.content).toBe(envContent);
  });
});

// ---------------------------------------------------------------------------
// Edge cases — empty-string optional params forwarded, not omitted
// The check is `!== undefined`; empty strings are valid and must be forwarded.
// ---------------------------------------------------------------------------

describe('mxShareContext — empty-string optional params forwarded verbatim', () => {
  it('content: "" (empty string) → forwarded as "" (not omitted)', async () => {
    const d = makeDeps({ resp: SHARE_SUCCESS_RESPONSE });
    await mxShareContext({ kind: 'diff', content: '' }, d);
    const p = d.calls[0]?.params as Record<string, unknown>;
    expect('content' in p).toBe(true);
    expect(p.content).toBe('');
  });

  it('path: "" (empty string) → forwarded as "" (not omitted)', async () => {
    const d = makeDeps({ resp: SHARE_SUCCESS_RESPONSE });
    await mxShareContext({ kind: 'file', path: '' }, d);
    const p = d.calls[0]?.params as Record<string, unknown>;
    expect('path' in p).toBe(true);
    expect(p.path).toBe('');
  });

  it('two independent calls produce two independent dispatch records', async () => {
    const d1 = makeDeps({ resp: { context_id: 'ctx_a', sha256: 'a'.repeat(64) } });
    const d2 = makeDeps({ resp: { context_id: 'ctx_b', sha256: 'b'.repeat(64) } });
    const [r1, r2] = await Promise.all([
      mxShareContext({ kind: 'diff', content: 'diff-a' }, d1),
      mxShareContext({ kind: 'diff', content: 'diff-b' }, d2),
    ]);
    expect((r1.result as Record<string, unknown>).context_id).toBe('ctx_a');
    expect((r2.result as Record<string, unknown>).context_id).toBe('ctx_b');
    expect(d1.calls).toHaveLength(1);
    expect(d2.calls).toHaveLength(1);
  });
});
