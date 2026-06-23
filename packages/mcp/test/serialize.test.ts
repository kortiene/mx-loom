/**
 * Serializer status table (T109) — the single most important serialization rule:
 * `isError` is `true` **only** for `status: "error"`. `awaiting_approval` (AC3) and
 * `denied` are non-error, structured results the model reads and replans around.
 *
 * Pure, no daemon. The broader serializer suite (every field, redaction) expands in
 * the dedicated tests phase; this pins the AC-critical invariants now.
 */
import { describe, expect, it } from 'vitest';

import {
  type AuditRef,
  type ToolResult,
  DENIAL_CODES,
  FAULT_CODES,
  awaitingApproval,
  denied,
  errored,
  ok,
  running,
  validateEnvelope,
} from '@mx-loom/registry';

import { serializeToolResult } from '../src/serialize.js';

const AUDIT: AuditRef = {
  invocation_id: 'inv_1',
  request_id: 'req_1',
  room: '!room:server',
  event_id: '$evt_1',
};

const cases: Array<{ name: string; result: ToolResult; isError: boolean }> = [
  { name: 'ok', result: ok({ value: 42 }, AUDIT), isError: false },
  { name: 'running', result: running('inv_1', AUDIT), isError: false },
  {
    name: 'awaiting_approval',
    result: awaitingApproval(
      'inv_1',
      { request_id: 'req_1', risk: 'high', summary: 'guarded command', expires_at: '2099-01-01T00:00:00Z' },
      AUDIT,
    ),
    isError: false,
  },
  { name: 'denied', result: denied('policy_denied', 'not allowlisted', AUDIT), isError: false },
  { name: 'error', result: errored('timeout', 'daemon timed out', AUDIT), isError: true },
];

describe('serializeToolResult', () => {
  it.each(cases)('$name → isError=$isError, structuredContent is the full envelope', ({ result, isError }) => {
    const out = serializeToolResult(result);

    // The single most important rule.
    expect(out.isError ?? false).toBe(isError);

    // structuredContent carries the FULL envelope, verbatim, and re-validates.
    expect(out.structuredContent).toEqual({
      status: result.status,
      result: result.result,
      error: result.error,
      handle: result.handle,
      approval: result.approval,
      audit_ref: result.audit_ref,
    });
    expect(validateEnvelope(out.structuredContent)).toBe(true);

    // content[0] is a text JSON rendering of the same envelope.
    expect(out.content).toHaveLength(1);
    const block = out.content?.[0];
    expect(block?.type).toBe('text');
    expect(JSON.parse((block as { text: string }).text)).toEqual(out.structuredContent);

    // audit_ref always present.
    expect((out.structuredContent as { audit_ref: unknown }).audit_ref).toEqual(AUDIT);
  });

  it('awaiting_approval surfaces handle + approval and is NOT an error (AC3)', () => {
    const result = cases.find((c) => c.name === 'awaiting_approval')!.result;
    const out = serializeToolResult(result);
    expect(out.isError ?? false).toBe(false);
    const sc = out.structuredContent as { status: string; handle: unknown; approval: { request_id: string } };
    expect(sc.status).toBe('awaiting_approval');
    expect(sc.handle).toBe('inv_1');
    expect(sc.approval.request_id).toBe('req_1');
  });

  it('denied carries the denial code and is NOT an error', () => {
    const out = serializeToolResult(denied('untrusted_key', 'key not trusted', AUDIT));
    expect(out.isError ?? false).toBe(false);
    expect((out.structuredContent as { error: { code: string } }).error.code).toBe('untrusted_key');
  });
});

// ---------------------------------------------------------------------------
// All DENIAL_CODES → denied status, isError false (status↔code partition pin)
// ---------------------------------------------------------------------------

describe('all denial codes → status denied, isError false', () => {
  it.each(DENIAL_CODES)('%s: denied, isError=false, envelope validates', (code) => {
    const result = denied(code, `denial message for ${code}`, AUDIT);
    const out = serializeToolResult(result);

    expect(out.isError ?? false).toBe(false);
    expect((out.structuredContent as { status: string }).status).toBe('denied');
    expect((out.structuredContent as { error: { code: string } }).error.code).toBe(code);
    expect(validateEnvelope(out.structuredContent)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// All FAULT_CODES → error status, isError true (status↔code partition pin)
// ---------------------------------------------------------------------------

describe('all fault codes → status error, isError true', () => {
  it.each(FAULT_CODES)('%s: error, isError=true, envelope validates', (code) => {
    const result = errored(code, `fault message for ${code}`, AUDIT);
    const out = serializeToolResult(result);

    expect(out.isError ?? false).toBe(true);
    expect((out.structuredContent as { status: string }).status).toBe('error');
    expect((out.structuredContent as { error: { code: string } }).error.code).toBe(code);
    expect(validateEnvelope(out.structuredContent)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// running: handle field is present in structuredContent
// ---------------------------------------------------------------------------

describe('running status', () => {
  it('handle is set in structuredContent and content, not isError', () => {
    const result = running('inv_running_handle', AUDIT);
    const out = serializeToolResult(result);

    expect(out.isError ?? false).toBe(false);
    const sc = out.structuredContent as { status: string; handle: string; result: null };
    expect(sc.status).toBe('running');
    expect(sc.handle).toBe('inv_running_handle');
    expect(sc.result).toBeNull();
    expect(validateEnvelope(out.structuredContent)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EMPTY_AUDIT_REF (all-null ids): round-trips through validateEnvelope
// ---------------------------------------------------------------------------

describe('EMPTY_AUDIT_REF (null inner ids)', () => {
  const EMPTY: AuditRef = Object.freeze({
    invocation_id: null,
    request_id: null,
    room: null,
    event_id: null,
  });

  it('errored with all-null audit_ref validates against the envelope schema', () => {
    const result = errored('not_found', 'unknown tool', EMPTY);
    const out = serializeToolResult(result);

    expect(validateEnvelope(out.structuredContent)).toBe(true);
    expect((out.structuredContent as { audit_ref: AuditRef }).audit_ref).toEqual(EMPTY);
  });

  it('ok with all-null audit_ref validates against the envelope schema', () => {
    const result = ok({ value: 1 }, EMPTY);
    const out = serializeToolResult(result);

    expect(validateEnvelope(out.structuredContent)).toBe(true);
    expect((out.structuredContent as { audit_ref: AuditRef }).audit_ref).toEqual(EMPTY);
  });
});
