/**
 * `mxGetContext` handler — context fetch (T107 / #15): room provenance,
 * dispatch `share.get`, inline-vs-media path (AC 2 discriminator), `not_found`
 * on unknown `context_id`, `size_bytes` normalization, denial/fault mapping,
 * `audit_ref` disposition, and robustness.
 *
 * Key behaviors tested:
 *
 * - Phase 1: absent/empty room → internal, no daemon calls made.
 * - Phase 2: dispatches `share.get` with `context_id` + `room` from deps.
 * - Phase 3 — inline path (AC 1 fetch half): `inline` field surfaced; sha256
 *   passed through as the integrity anchor; handler never recomputes sha256
 *   (avoids the byte-identity ↔ inbound-redaction interaction).
 * - Phase 3 — media path (AC 2): `media_mxc` surfaced, `inline` absent; sha256
 *   surfaced. Handler never downloads media — surfaces the reference only.
 * - Unknown `context_id` → not_found (daemon aliases: unknown_context /
 *   no_such_context / context_not_found all map via DAEMON_CODE_TO_ERROR).
 * - size_bytes: integer ≥ 0 forwarded; non-integer / negative / string read as
 *   absent (never fabricated).
 * - Denial/fault mapping, missing room, robustness, envelope conformance.
 *
 * Pure unit tests; injected DaemonCall — no daemon, no socket, no env.
 */
import { describe, expect, it } from 'vitest';

import { TransportError } from '@mx-loom/toolbelt';

import {
  mxGetContext,
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

/** Inline path: small artifact returned as `inline` text. */
const INLINE_RESPONSE = {
  context_id: CONTEXT_ID,
  kind: 'diff',
  sha256: SHA256,
  size_bytes: 128,
  inline: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new',
  invocation_id: 'inv_get_01',
  request_id: 'req_get_01',
  room: ROOM,
  event_id: '$evt_get_01',
};

/** Media path: large artifact stored out-of-band; no `inline`. */
const MEDIA_RESPONSE = {
  context_id: CONTEXT_ID,
  kind: 'file',
  sha256: SHA256,
  size_bytes: 512 * 1024,
  media_mxc: 'mxc://homeserver/abcdefghij',
  invocation_id: 'inv_get_media_01',
  request_id: 'req_get_media_01',
  room: ROOM,
  event_id: '$evt_get_media_01',
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

const VALID_INPUT = { context_id: CONTEXT_ID };

// ---------------------------------------------------------------------------
// Phase 1 — room provenance
// ---------------------------------------------------------------------------

describe('mxGetContext — Phase 1: room provenance', () => {
  it('absent room → internal, zero daemon calls', async () => {
    const d = makeDeps({ room: undefined, resp: INLINE_RESPONSE });
    const result = await mxGetContext(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expect(d.calls).toHaveLength(0);
    expectValid(result);
  });

  it('empty string room → internal, zero daemon calls', async () => {
    const d = makeDeps({ room: '', resp: INLINE_RESPONSE });
    const result = await mxGetContext(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expect(d.calls).toHaveLength(0);
    expectValid(result);
  });

  it('absent room never dispatches share.get', async () => {
    const d = makeDeps({ room: undefined, resp: INLINE_RESPONSE });
    await mxGetContext(VALID_INPUT, d);
    expect(d.callCount('share.get')).toBe(0);
  });

  it('absent room: audit_ref is all-null (no round-trip)', async () => {
    const d = makeDeps({ room: undefined, resp: INLINE_RESPONSE });
    const result = await mxGetContext(VALID_INPUT, d);
    expect(result.audit_ref.invocation_id).toBeNull();
    expect(result.audit_ref.request_id).toBeNull();
    expect(result.audit_ref.room).toBeNull();
    expect(result.audit_ref.event_id).toBeNull();
  });

  it('room-provenance error.message is the fixed phrase', async () => {
    const d = makeDeps({ room: undefined, resp: INLINE_RESPONSE });
    const result = await mxGetContext(VALID_INPUT, d);
    expect(result.error?.message).toBe('no workspace room configured for get');
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — dispatch share.get
// ---------------------------------------------------------------------------

describe('mxGetContext — Phase 2: dispatch share.get', () => {
  it('dispatches share.get (exactly one call)', async () => {
    const d = makeDeps({ resp: INLINE_RESPONSE });
    await mxGetContext(VALID_INPUT, d);
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]?.method).toBe('share.get');
  });

  it('share.get params include context_id from input', async () => {
    const d = makeDeps({ resp: INLINE_RESPONSE });
    await mxGetContext({ context_id: 'ctx_specific_42' }, d);
    const p = d.calls[0]?.params as Record<string, unknown>;
    expect(p.context_id).toBe('ctx_specific_42');
  });

  it('share.get params include room from deps (never from model input)', async () => {
    const d = makeDeps({ resp: INLINE_RESPONSE });
    await mxGetContext(VALID_INPUT, d);
    const p = d.calls[0]?.params as Record<string, unknown>;
    expect(p.room).toBe(ROOM);
  });

  it('no params value is undefined', async () => {
    const d = makeDeps({ resp: INLINE_RESPONSE });
    await mxGetContext(VALID_INPUT, d);
    const p = d.calls[0]?.params as Record<string, unknown>;
    for (const value of Object.values(p)) {
      expect(value).not.toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// AC 1 (fetch half) — inline artifact surfaced byte-for-byte
// ---------------------------------------------------------------------------

describe('mxGetContext — AC 1: inline artifact fetch', () => {
  it('inline response → status: ok', async () => {
    const d = makeDeps({ resp: INLINE_RESPONSE });
    const result = await mxGetContext(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    expect(result.error).toBeNull();
    expectValid(result);
  });

  it('context_id passed through from the response', async () => {
    const d = makeDeps({ resp: INLINE_RESPONSE });
    const result = await mxGetContext(VALID_INPUT, d);
    const r = result.result as Record<string, unknown>;
    expect(r.context_id).toBe(CONTEXT_ID);
  });

  it('kind passed through from the response', async () => {
    const d = makeDeps({ resp: INLINE_RESPONSE });
    const result = await mxGetContext(VALID_INPUT, d);
    expect((result.result as Record<string, unknown>).kind).toBe('diff');
  });

  it('sha256 passed through as the integrity anchor (never recomputed)', async () => {
    const d = makeDeps({ resp: INLINE_RESPONSE });
    const result = await mxGetContext(VALID_INPUT, d);
    expect((result.result as Record<string, unknown>).sha256).toBe(SHA256);
  });

  it('inline content passed through verbatim', async () => {
    const d = makeDeps({ resp: INLINE_RESPONSE });
    const result = await mxGetContext(VALID_INPUT, d);
    expect((result.result as Record<string, unknown>).inline).toBe('--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new');
  });

  it('size_bytes (integer ≥ 0) passed through from the response', async () => {
    const d = makeDeps({ resp: INLINE_RESPONSE });
    const result = await mxGetContext(VALID_INPUT, d);
    expect((result.result as Record<string, unknown>).size_bytes).toBe(128);
  });

  it('media_mxc absent on an inline response', async () => {
    const d = makeDeps({ resp: INLINE_RESPONSE });
    const result = await mxGetContext(VALID_INPUT, d);
    expect((result.result as Record<string, unknown>).media_mxc).toBeUndefined();
  });

  it('audit_ref populated from the response', async () => {
    const d = makeDeps({ resp: INLINE_RESPONSE });
    const result = await mxGetContext(VALID_INPUT, d);
    expect(result.audit_ref.invocation_id).toBe('inv_get_01');
    expect(result.audit_ref.request_id).toBe('req_get_01');
    expect(result.audit_ref.room).toBe(ROOM);
    expect(result.audit_ref.event_id).toBe('$evt_get_01');
  });
});

// ---------------------------------------------------------------------------
// AC 2 — large artifact: media path (media_mxc present, inline absent)
// ---------------------------------------------------------------------------

describe('mxGetContext — AC 2: large artifact uses the media path', () => {
  it('media-path response → status: ok', async () => {
    const d = makeDeps({ resp: MEDIA_RESPONSE });
    const result = await mxGetContext(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    expectValid(result);
  });

  it('media_mxc surfaced from the media-path response', async () => {
    const d = makeDeps({ resp: MEDIA_RESPONSE });
    const result = await mxGetContext(VALID_INPUT, d);
    expect((result.result as Record<string, unknown>).media_mxc).toBe('mxc://homeserver/abcdefghij');
  });

  it('inline absent on a media-path response (AC 2 discriminator)', async () => {
    const d = makeDeps({ resp: MEDIA_RESPONSE });
    const result = await mxGetContext(VALID_INPUT, d);
    expect((result.result as Record<string, unknown>).inline).toBeUndefined();
  });

  it('sha256 surfaced from the media-path response', async () => {
    const d = makeDeps({ resp: MEDIA_RESPONSE });
    const result = await mxGetContext(VALID_INPUT, d);
    expect((result.result as Record<string, unknown>).sha256).toBe(SHA256);
  });

  it('size_bytes surfaced from the media-path response', async () => {
    const d = makeDeps({ resp: MEDIA_RESPONSE });
    const result = await mxGetContext(VALID_INPUT, d);
    expect((result.result as Record<string, unknown>).size_bytes).toBe(512 * 1024);
  });

  it('media-path response carries context_id + kind', async () => {
    const d = makeDeps({ resp: MEDIA_RESPONSE });
    const result = await mxGetContext(VALID_INPUT, d);
    const r = result.result as Record<string, unknown>;
    expect(r.context_id).toBe(CONTEXT_ID);
    expect(r.kind).toBe('file');
    expectValid(result);
  });
});

// ---------------------------------------------------------------------------
// size_bytes normalization — integer ≥ 0 only; anything else reads as absent
// ---------------------------------------------------------------------------

describe('mxGetContext — size_bytes normalization', () => {
  it('size_bytes: 0 → forwarded as 0', async () => {
    const d = makeDeps({ resp: { ...INLINE_RESPONSE, size_bytes: 0 } });
    const result = await mxGetContext(VALID_INPUT, d);
    expect((result.result as Record<string, unknown>).size_bytes).toBe(0);
  });

  it('size_bytes: negative → omitted (read as absent)', async () => {
    const d = makeDeps({ resp: { ...INLINE_RESPONSE, size_bytes: -1 } });
    const result = await mxGetContext(VALID_INPUT, d);
    expect((result.result as Record<string, unknown>).size_bytes).toBeUndefined();
  });

  it('size_bytes: float → omitted (non-integer reads as absent)', async () => {
    const d = makeDeps({ resp: { ...INLINE_RESPONSE, size_bytes: 128.5 } });
    const result = await mxGetContext(VALID_INPUT, d);
    expect((result.result as Record<string, unknown>).size_bytes).toBeUndefined();
  });

  it('size_bytes: string → omitted', async () => {
    const d = makeDeps({ resp: { ...INLINE_RESPONSE, size_bytes: '128' } });
    const result = await mxGetContext(VALID_INPUT, d);
    expect((result.result as Record<string, unknown>).size_bytes).toBeUndefined();
  });

  it('size_bytes: null → omitted', async () => {
    const d = makeDeps({ resp: { ...INLINE_RESPONSE, size_bytes: null } });
    const result = await mxGetContext(VALID_INPUT, d);
    expect((result.result as Record<string, unknown>).size_bytes).toBeUndefined();
  });

  it('size_bytes: NaN → omitted (Number.isInteger(NaN) is false)', async () => {
    const d = makeDeps({ resp: { ...INLINE_RESPONSE, size_bytes: NaN } });
    const result = await mxGetContext(VALID_INPUT, d);
    expect((result.result as Record<string, unknown>).size_bytes).toBeUndefined();
    expectValid(result);
  });

  it('size_bytes: Infinity → omitted (Number.isInteger(Infinity) is false)', async () => {
    const d = makeDeps({ resp: { ...INLINE_RESPONSE, size_bytes: Infinity } });
    const result = await mxGetContext(VALID_INPUT, d);
    expect((result.result as Record<string, unknown>).size_bytes).toBeUndefined();
    expectValid(result);
  });

  it('size_bytes: -Infinity → omitted (non-integer and negative)', async () => {
    const d = makeDeps({ resp: { ...INLINE_RESPONSE, size_bytes: -Infinity } });
    const result = await mxGetContext(VALID_INPUT, d);
    expect((result.result as Record<string, unknown>).size_bytes).toBeUndefined();
    expectValid(result);
  });

  it('size_bytes: 1 (smallest positive integer) → forwarded', async () => {
    const d = makeDeps({ resp: { ...INLINE_RESPONSE, size_bytes: 1 } });
    const result = await mxGetContext(VALID_INPUT, d);
    expect((result.result as Record<string, unknown>).size_bytes).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Unknown context_id → not_found
// Pins the DAEMON_CODE_TO_ERROR aliases (T107 / Risks #6)
// ---------------------------------------------------------------------------

describe('mxGetContext — unknown context_id → not_found', () => {
  it('rpc unknown_context → errored("not_found")', async () => {
    const d = makeDeps({ resp: rpcDaemonError('unknown_context') });
    const result = await mxGetContext({ context_id: 'ctx_missing' }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
    expectValid(result);
  });

  it('rpc no_such_context → errored("not_found")', async () => {
    const d = makeDeps({ resp: rpcDaemonError('no_such_context') });
    const result = await mxGetContext({ context_id: 'ctx_missing' }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
    expectValid(result);
  });

  it('rpc context_not_found → errored("not_found")', async () => {
    const d = makeDeps({ resp: rpcDaemonError('context_not_found') });
    const result = await mxGetContext({ context_id: 'ctx_missing' }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
    expectValid(result);
  });

  it('rpc not_found (direct) → errored("not_found")', async () => {
    const d = makeDeps({ resp: rpcDaemonError('not_found') });
    const result = await mxGetContext({ context_id: 'ctx_missing' }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
    expectValid(result);
  });

  it('not_found error.message is the fixed phrase (never echoes context_id)', async () => {
    const d = makeDeps({ resp: rpcDaemonError('unknown_context') });
    const result = await mxGetContext({ context_id: 'ctx_sensitive_id' }, d);
    expect(result.error?.message).toBe('no such invocation');
    expect(result.error?.message).not.toContain('ctx_sensitive_id');
  });
});

// ---------------------------------------------------------------------------
// Denial / fault mapping
// ---------------------------------------------------------------------------

describe('mxGetContext — denial / fault mapping', () => {
  it('share.get rpc policy_denied → denied("policy_denied")', async () => {
    const d = makeDeps({ resp: rpcDaemonError('policy_denied') });
    const result = await mxGetContext(VALID_INPUT, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
    expectValid(result);
  });

  it('share.get resolves {ok:false, error:{code:"policy_denied"}} → denied("policy_denied")', async () => {
    const d = makeDeps({ resp: { ok: false, error: { code: 'policy_denied' } } });
    const result = await mxGetContext(VALID_INPUT, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
    expectValid(result);
  });

  it('share.get rpc untrusted_key → denied("untrusted_key")', async () => {
    const d = makeDeps({ resp: rpcDaemonError('untrusted_key') });
    const result = await mxGetContext(VALID_INPUT, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('untrusted_key');
    expectValid(result);
  });

  it('share.get rpc agent_offline → errored("target_offline")', async () => {
    const d = makeDeps({ resp: rpcDaemonError('agent_offline') });
    const result = await mxGetContext(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('target_offline');
    expectValid(result);
  });

  it('share.get transport timeout → errored("timeout")', async () => {
    const d = makeDeps({ resp: te('timeout', 'timed out') });
    const result = await mxGetContext(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('timeout');
    expectValid(result);
  });

  it('share.get transport not_running → errored("internal")', async () => {
    const d = makeDeps({ resp: te('not_running') });
    const result = await mxGetContext(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('thrown rpc policy_denied: audit_ref is all-null (no round-trip)', async () => {
    const d = makeDeps({ resp: rpcDaemonError('policy_denied') });
    const result = await mxGetContext(VALID_INPUT, d);
    expect(result.audit_ref.invocation_id).toBeNull();
    expect(result.audit_ref.request_id).toBeNull();
    expect(result.audit_ref.room).toBeNull();
    expect(result.audit_ref.event_id).toBeNull();
  });

  it('approval_denied rpc → denied("approval_denied")', async () => {
    const d = makeDeps({ resp: rpcDaemonError('approval_denied') });
    const result = await mxGetContext(VALID_INPUT, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('approval_denied');
    expectValid(result);
  });
});

// ---------------------------------------------------------------------------
// audit_ref disposition on missing context_id lookup
// ---------------------------------------------------------------------------

describe('mxGetContext — audit_ref on resolved vs thrown not_found', () => {
  it('thrown rpc unknown_context → EMPTY_AUDIT_REF (no round-trip)', async () => {
    const d = makeDeps({ resp: rpcDaemonError('unknown_context') });
    const result = await mxGetContext({ context_id: 'ctx_missing' }, d);
    expect(result.audit_ref.invocation_id).toBeNull();
    expect(result.audit_ref.request_id).toBeNull();
    expect(result.audit_ref.room).toBeNull();
    expect(result.audit_ref.event_id).toBeNull();
  });

  it('resolved {ok:false, not_found} with correlation ids → audit_ref populated', async () => {
    const resp = {
      ok: false,
      error: { code: 'not_found' },
      invocation_id: 'inv_nf_01',
      request_id: 'req_nf_01',
      room: ROOM,
      event_id: '$evt_nf_01',
    };
    const d = makeDeps({ resp });
    const result = await mxGetContext(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
    expect(result.audit_ref.invocation_id).toBe('inv_nf_01');
    expect(result.audit_ref.request_id).toBe('req_nf_01');
    expectValid(result);
  });
});

// ---------------------------------------------------------------------------
// Robustness — handler never throws, every output validates ENVELOPE_SCHEMA
// ---------------------------------------------------------------------------

describe('mxGetContext — robustness / never-throws', () => {
  it('malformed response (null) → internal, never throws', async () => {
    const d = makeDeps({ resp: null });
    const result = await mxGetContext(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('malformed response (scalar 42) → internal', async () => {
    const d = makeDeps({ resp: 42 });
    const result = await mxGetContext(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('malformed response (array) → internal', async () => {
    const d = makeDeps({ resp: [] });
    const result = await mxGetContext(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('malformed response (empty object) → internal (no context_id, no error signal)', async () => {
    const d = makeDeps({ resp: {} });
    const result = await mxGetContext(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('response with only context_id → ok (all optional fields absent)', async () => {
    const d = makeDeps({ resp: { context_id: CONTEXT_ID } });
    const result = await mxGetContext(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    const r = result.result as Record<string, unknown>;
    expect(r.context_id).toBe(CONTEXT_ID);
    expect(r.kind).toBeUndefined();
    expect(r.sha256).toBeUndefined();
    expect(r.inline).toBeUndefined();
    expect(r.media_mxc).toBeUndefined();
    expectValid(result);
  });

  it('plain Error (non-TransportError) from share.get → internal', async () => {
    const d = makeDeps({ resp: new Error('unexpected') });
    const result = await mxGetContext(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('all code paths produce a valid ENVELOPE_SCHEMA output', async () => {
    const scenarios: Array<{ resp?: unknown; room?: string }> = [
      { resp: null },
      { resp: {} },
      { resp: INLINE_RESPONSE },
      { resp: MEDIA_RESPONSE },
      { resp: rpcDaemonError('unknown_context') },
      { resp: rpcDaemonError('policy_denied') },
      { resp: { ok: false, error: { code: 'policy_denied' } } },
      { resp: te('timeout') },
      { resp: INLINE_RESPONSE, room: '' },
    ];
    for (const s of scenarios) {
      const d = makeDeps(s);
      const result = await mxGetContext(VALID_INPUT, d);
      expectValid(result);
    }
  });
});
