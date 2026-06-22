/**
 * `contextResponseToResult` — the shared flat-payload classifier (T107 / #15).
 *
 * `contextResponseToResult` is the **pure, exported** normalizer that both
 * `mx_share_context` and `mx_get_context` funnel their raw daemon replies through.
 * Its contract, tested directly here:
 *
 * - Non-object input (null / scalar / array) → `errored('internal', …)`.
 * - Object with an explicit daemon error signal (`{ok:false}` / `{error}`) →
 *   the mapped `denied` or `errored` terminal (via `failureCode` → `failureResult`).
 * - Object with string `context_id` but no error signal → `ok(project(obj), audit_ref)`.
 * - Object with no `context_id` (or non-string `context_id`) and no error signal →
 *   `errored('internal', …)` — no misleading `ok({})`.
 * - The `project` callback receives the **full raw object** and its return value
 *   is used verbatim as the `result` payload.
 * - `audit_ref` is read from top-level fields or a nested `audit_ref` block;
 *   missing ids are `null`, never fabricated.
 * - Every output validates `ENVELOPE_SCHEMA` and every `error.code` is in the
 *   closed set.
 * - Never throws.
 *
 * Pure unit tests; no daemon, no socket, no env.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  contextResponseToResult,
  isErrorCode,
  validateEnvelope,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectValid(result: unknown): void {
  expect(
    validateEnvelope(result),
    `envelope invalid: ${JSON.stringify((validateEnvelope as { errors?: unknown }).errors)}`,
  ).toBe(true);
}

/** Identity projection — returns the payload as-is. */
const identity = (o: Record<string, unknown>): Record<string, unknown> => o;

/** Minimal projection — returns only `context_id`. */
const minimalProject = (o: Record<string, unknown>): Record<string, unknown> => ({
  ...(typeof o.context_id === 'string' ? { context_id: o.context_id } : {}),
});

const CONTEXT_ID = 'ctx_test_01';
const SHA256 = 'a'.repeat(64);
const ROOM = '!workspace:homeserver';

// ---------------------------------------------------------------------------
// Non-object inputs → internal
// ---------------------------------------------------------------------------

describe('contextResponseToResult — non-object inputs degrade to internal', () => {
  it('null → errored("internal")', () => {
    const result = contextResponseToResult(null, identity);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('undefined → errored("internal")', () => {
    const result = contextResponseToResult(undefined, identity);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('number (42) → errored("internal")', () => {
    const result = contextResponseToResult(42, identity);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('string → errored("internal")', () => {
    const result = contextResponseToResult('ctx_01', identity);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('boolean true → errored("internal")', () => {
    const result = contextResponseToResult(true, identity);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('array → errored("internal") (arrays are not plain objects)', () => {
    const result = contextResponseToResult([], identity);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('array with context_id element → errored("internal")', () => {
    const result = contextResponseToResult([CONTEXT_ID, SHA256], identity);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('non-object: audit_ref is all-null (EMPTY_AUDIT_REF)', () => {
    const result = contextResponseToResult(null, identity);
    expect(result.audit_ref.invocation_id).toBeNull();
    expect(result.audit_ref.request_id).toBeNull();
    expect(result.audit_ref.room).toBeNull();
    expect(result.audit_ref.event_id).toBeNull();
  });

  it('non-object: error.message is the fixed phrase (never echoes raw input)', () => {
    const result = contextResponseToResult('ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', identity);
    expect(result.error?.message).toBe('unrecognised context response');
    expect(JSON.stringify(result)).not.toContain('ghp_');
  });
});

// ---------------------------------------------------------------------------
// Explicit error signal → mapped terminal
// ---------------------------------------------------------------------------

describe('contextResponseToResult — explicit daemon error signal → mapped terminal', () => {
  it('{ok:false, error:{code:"policy_denied"}} → denied("policy_denied")', () => {
    const result = contextResponseToResult({ ok: false, error: { code: 'policy_denied' } }, identity);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
    expectValid(result);
  });

  it('{ok:false, error:{code:"untrusted_key"}} → denied("untrusted_key")', () => {
    const result = contextResponseToResult({ ok: false, error: { code: 'untrusted_key' } }, identity);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('untrusted_key');
    expectValid(result);
  });

  it('{ok:false, error:{code:"not_found"}} → errored("not_found")', () => {
    const result = contextResponseToResult({ ok: false, error: { code: 'not_found' } }, identity);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
    expectValid(result);
  });

  it('{ok:false, error:{code:"unknown_context"}} → errored("not_found") via T107 alias', () => {
    const result = contextResponseToResult({ ok: false, error: { code: 'unknown_context' } }, identity);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
    expectValid(result);
  });

  it('{ok:false, error:{code:"timeout"}} → errored("timeout")', () => {
    const result = contextResponseToResult({ ok: false, error: { code: 'timeout' } }, identity);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('timeout');
    expectValid(result);
  });

  it('{ok:false, error:{code:"invalid_args"}} → errored("invalid_args")', () => {
    const result = contextResponseToResult({ ok: false, error: { code: 'invalid_args' } }, identity);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
    expectValid(result);
  });

  it('{error:"policy_denied"} (string error field) → denied("policy_denied")', () => {
    const result = contextResponseToResult({ error: 'policy_denied' }, identity);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
    expectValid(result);
  });

  it('error signal with audit_ref fields → audit_ref populated', () => {
    const resp = {
      ok: false,
      error: { code: 'policy_denied' },
      invocation_id: 'inv_err_01',
      request_id: 'req_err_01',
      room: ROOM,
      event_id: '$evt_err_01',
    };
    const result = contextResponseToResult(resp, identity);
    expect(result.status).toBe('denied');
    expect(result.audit_ref.invocation_id).toBe('inv_err_01');
    expect(result.audit_ref.request_id).toBe('req_err_01');
    expect(result.audit_ref.room).toBe(ROOM);
    expect(result.audit_ref.event_id).toBe('$evt_err_01');
  });

  it('error signal without audit_ref fields → audit_ref all-null', () => {
    const result = contextResponseToResult({ ok: false, error: { code: 'policy_denied' } }, identity);
    expect(result.audit_ref.invocation_id).toBeNull();
    expect(result.audit_ref.request_id).toBeNull();
    expect(result.audit_ref.room).toBeNull();
    expect(result.audit_ref.event_id).toBeNull();
  });

  it('error signal does not call the project callback', () => {
    const projectFn = vi.fn(identity);
    contextResponseToResult({ ok: false, error: { code: 'policy_denied' } }, projectFn);
    expect(projectFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Object without context_id (and no error signal) → internal
// ---------------------------------------------------------------------------

describe('contextResponseToResult — missing/invalid context_id → internal', () => {
  it('empty object → errored("internal")', () => {
    const result = contextResponseToResult({}, identity);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('context_id: null → errored("internal")', () => {
    const result = contextResponseToResult({ context_id: null }, identity);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('context_id: 42 (number) → errored("internal") (readString rejects non-strings)', () => {
    const result = contextResponseToResult({ context_id: 42, sha256: SHA256 }, identity);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('context_id: {} (object) → errored("internal")', () => {
    const result = contextResponseToResult({ context_id: {}, sha256: SHA256 }, identity);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('context_id: [] (array) → errored("internal")', () => {
    const result = contextResponseToResult({ context_id: [] }, identity);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('context_id: true (boolean) → errored("internal")', () => {
    const result = contextResponseToResult({ context_id: true }, identity);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('missing context_id: error.message is the fixed phrase (not a fabricated ok)', () => {
    const result = contextResponseToResult({ sha256: SHA256 }, identity);
    expect(result.error?.message).toBe('unrecognised context response');
  });

  it('missing context_id does not call the project callback', () => {
    const projectFn = vi.fn(identity);
    contextResponseToResult({}, projectFn);
    expect(projectFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// String context_id → ok(project(obj), audit_ref)
// ---------------------------------------------------------------------------

describe('contextResponseToResult — string context_id → ok', () => {
  it('flat success payload → status: ok', () => {
    const result = contextResponseToResult({ context_id: CONTEXT_ID, sha256: SHA256 }, identity);
    expect(result.status).toBe('ok');
    expect(result.error).toBeNull();
    expect(result.handle).toBeNull();
    expect(result.approval).toBeNull();
    expectValid(result);
  });

  it('the project callback is called exactly once', () => {
    const projectFn = vi.fn(identity);
    contextResponseToResult({ context_id: CONTEXT_ID }, projectFn);
    expect(projectFn).toHaveBeenCalledOnce();
  });

  it('the project callback receives the full raw object (not just context_id)', () => {
    const projectFn = vi.fn(identity);
    const payload = { context_id: CONTEXT_ID, sha256: SHA256, kind: 'diff', inline: 'content' };
    contextResponseToResult(payload, projectFn);
    expect(projectFn).toHaveBeenCalledWith(payload);
  });

  it('the project callback return value is the result payload', () => {
    const projected = { context_id: CONTEXT_ID, sha256: SHA256 };
    const projectFn = (_o: Record<string, unknown>): Record<string, unknown> => projected;
    const result = contextResponseToResult({ context_id: CONTEXT_ID, sha256: SHA256, extra: true }, projectFn);
    expect(result.result).toEqual(projected);
  });

  it('project can narrow fields: extra fields from the raw object are excluded by the projection', () => {
    const result = contextResponseToResult(
      { context_id: CONTEXT_ID, sha256: SHA256, extra_field: 'dropped' },
      minimalProject,
    );
    expect(result.status).toBe('ok');
    const r = result.result as Record<string, unknown>;
    expect(r.context_id).toBe(CONTEXT_ID);
    expect(r.extra_field).toBeUndefined();
  });

  it('project returning an empty object → ok({}, audit_ref) — no fabricated fields', () => {
    const result = contextResponseToResult({ context_id: CONTEXT_ID }, () => ({}));
    expect(result.status).toBe('ok');
    expect(result.result).toEqual({});
    expectValid(result);
  });

  it('empty-string context_id is a valid string → ok', () => {
    const result = contextResponseToResult({ context_id: '' }, identity);
    expect(result.status).toBe('ok');
    expectValid(result);
  });
});

// ---------------------------------------------------------------------------
// audit_ref extraction — top-level vs nested block
// ---------------------------------------------------------------------------

describe('contextResponseToResult — audit_ref extraction', () => {
  it('reads top-level invocation_id / request_id / room / event_id', () => {
    const resp = {
      context_id: CONTEXT_ID,
      invocation_id: 'inv_top_01',
      request_id: 'req_top_01',
      room: ROOM,
      event_id: '$evt_top_01',
    };
    const result = contextResponseToResult(resp, identity);
    expect(result.audit_ref.invocation_id).toBe('inv_top_01');
    expect(result.audit_ref.request_id).toBe('req_top_01');
    expect(result.audit_ref.room).toBe(ROOM);
    expect(result.audit_ref.event_id).toBe('$evt_top_01');
  });

  it('reads from a nested audit_ref block when present', () => {
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
    const result = contextResponseToResult(resp, identity);
    expect(result.audit_ref.invocation_id).toBe('inv_nested_01');
    expect(result.audit_ref.request_id).toBe('req_nested_01');
    expect(result.audit_ref.room).toBe(ROOM);
    expect(result.audit_ref.event_id).toBe('$evt_nested_01');
  });

  it('prefers nested audit_ref block over top-level fields for invocation_id', () => {
    const resp = {
      context_id: CONTEXT_ID,
      invocation_id: 'inv_top_should_be_shadowed',
      audit_ref: {
        invocation_id: 'inv_nested_wins',
        request_id: 'req_nested',
      },
    };
    const result = contextResponseToResult(resp, identity);
    expect(result.audit_ref.invocation_id).toBe('inv_nested_wins');
  });

  it('missing ids are null (never fabricated)', () => {
    const result = contextResponseToResult({ context_id: CONTEXT_ID }, identity);
    expect(result.audit_ref.invocation_id).toBeNull();
    expect(result.audit_ref.request_id).toBeNull();
    expect(result.audit_ref.room).toBeNull();
    expect(result.audit_ref.event_id).toBeNull();
  });

  it('partial ids: only available ids are populated', () => {
    const resp = { context_id: CONTEXT_ID, invocation_id: 'inv_partial_01' };
    const result = contextResponseToResult(resp, identity);
    expect(result.audit_ref.invocation_id).toBe('inv_partial_01');
    expect(result.audit_ref.request_id).toBeNull();
    expect(result.audit_ref.room).toBeNull();
    expect(result.audit_ref.event_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Envelope / taxonomy conformance and never-throws
// ---------------------------------------------------------------------------

describe('contextResponseToResult — envelope conformance and never-throws', () => {
  it('every output passes validateEnvelope across all major paths', () => {
    const scenarios: unknown[] = [
      null,
      undefined,
      42,
      'string',
      [],
      {},
      { context_id: CONTEXT_ID },
      { context_id: CONTEXT_ID, sha256: SHA256 },
      { ok: false, error: { code: 'policy_denied' } },
      { ok: false, error: { code: 'unknown_context' } },
      { ok: false, error: { code: 'timeout' } },
      { context_id: 42 },
      { sha256: SHA256 },
    ];
    for (const raw of scenarios) {
      const result = contextResponseToResult(raw, identity);
      expectValid(result);
    }
  });

  it('every emitted error.code is in the closed ERROR_CODES set', () => {
    const scenarios: unknown[] = [
      null,
      {},
      { context_id: 42 },
      { ok: false, error: { code: 'policy_denied' } },
      { ok: false, error: { code: 'unknown_context' } },
      { ok: false, error: { code: 'timeout' } },
      { ok: false, error: { code: 'totally_unknown' } },
    ];
    for (const raw of scenarios) {
      const result = contextResponseToResult(raw, identity);
      if (result.error !== null) {
        expect(isErrorCode(result.error.code)).toBe(true);
      }
    }
  });

  it('never throws even with deeply unusual inputs', () => {
    const weirdInputs = [
      Symbol('sym'),
      () => 'fn',
      Object.create(null),
      new Map(),
      new Set(),
    ];
    for (const raw of weirdInputs) {
      expect(() => contextResponseToResult(raw as unknown, identity)).not.toThrow();
    }
  });

  it('ok result is deeply frozen', () => {
    const result = contextResponseToResult({ context_id: CONTEXT_ID }, identity);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.audit_ref)).toBe(true);
  });

  it('error result is deeply frozen', () => {
    const result = contextResponseToResult(null, identity);
    expect(Object.isFrozen(result)).toBe(true);
  });
});
