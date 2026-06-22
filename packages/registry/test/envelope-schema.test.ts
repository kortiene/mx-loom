/**
 * Envelope JSON Schema (T102 / #10) — AC 1: "every tool result conforms to
 * the envelope schema".
 *
 * Tests that:
 * - Every constructor helper's output validates against ENVELOPE_SCHEMA.
 * - Malformed envelopes fail validation (covering each deviation from the
 *   §4.2 field-presence table).
 * - ENVELOPE_SCHEMA is well-formed (compiles against the draft-07 meta-schema).
 *
 * Pure unit tests; no daemon, no socket, no env.
 */
import { describe, expect, it } from 'vitest';

import {
  awaitingApproval,
  createAjvValidator,
  denied,
  ENVELOPE_SCHEMA,
  errored,
  JSON_SCHEMA_DIALECT,
  ok,
  running,
  validateEnvelope,
  type ApprovalInfo,
  type AuditRef,
  type ToolResult,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const nullAuditRef: AuditRef = {
  invocation_id: null,
  request_id: null,
  room: null,
  event_id: null,
};

const fullAuditRef: AuditRef = {
  invocation_id: 'inv_01',
  request_id: 'req_01',
  room: '!room:server',
  event_id: '$event01',
};

const approval: ApprovalInfo = {
  request_id: 'req_ap',
  risk: 'high',
  summary: 'Deploy to production',
  expires_at: '2026-06-22T18:00:00Z',
};

// ---------------------------------------------------------------------------
// Helper outputs validate — AC 1 (structural conformance by construction)
// ---------------------------------------------------------------------------

describe('validateEnvelope — helper outputs conform (AC 1)', () => {
  it('ok() result validates', () => {
    expect(validateEnvelope(ok({ count: 3 }, nullAuditRef))).toBe(true);
  });

  it('ok() result with a full audit_ref validates', () => {
    expect(validateEnvelope(ok({ items: [] }, fullAuditRef))).toBe(true);
  });

  it('running() result validates', () => {
    expect(validateEnvelope(running('inv_handle', nullAuditRef))).toBe(true);
  });

  it('awaitingApproval() result validates', () => {
    expect(validateEnvelope(awaitingApproval('inv_ap', approval, nullAuditRef))).toBe(true);
  });

  it('denied() with policy_denied validates', () => {
    expect(validateEnvelope(denied('policy_denied', 'blocked by policy', nullAuditRef))).toBe(true);
  });

  it('denied() with untrusted_key validates', () => {
    expect(validateEnvelope(denied('untrusted_key', 'unknown signer', nullAuditRef))).toBe(true);
  });

  it('denied() with approval_denied validates', () => {
    expect(validateEnvelope(denied('approval_denied', 'operator rejected', nullAuditRef))).toBe(true);
  });

  it('denied() with approval_expired validates', () => {
    expect(validateEnvelope(denied('approval_expired', 'window closed', nullAuditRef))).toBe(true);
  });

  it('errored() with timeout validates', () => {
    expect(validateEnvelope(errored('timeout', 'deadline exceeded', nullAuditRef))).toBe(true);
  });

  it('errored() with not_found validates', () => {
    expect(validateEnvelope(errored('not_found', 'agent unknown', nullAuditRef))).toBe(true);
  });

  it('errored() with invalid_args validates', () => {
    expect(validateEnvelope(errored('invalid_args', 'bad params', nullAuditRef))).toBe(true);
  });

  it('errored() with target_offline validates', () => {
    expect(validateEnvelope(errored('target_offline', 'remote unreachable', nullAuditRef))).toBe(true);
  });

  it('errored() with internal validates', () => {
    expect(validateEnvelope(errored('internal', 'fabric fault', nullAuditRef))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Malformed envelopes fail — each deviation from the §4.2 table is rejected
// ---------------------------------------------------------------------------

describe('validateEnvelope — malformed envelopes fail', () => {
  const baseOk: ToolResult = { status: 'ok', result: { x: 1 }, error: null, handle: null, approval: null, audit_ref: nullAuditRef };

  it('rejects ok with a non-null error', () => {
    expect(validateEnvelope({ ...baseOk, error: { code: 'internal', message: 'oops' } })).toBe(false);
  });

  it('rejects ok with a null result', () => {
    expect(validateEnvelope({ ...baseOk, result: null })).toBe(false);
  });

  it('rejects ok with a non-null handle', () => {
    expect(validateEnvelope({ ...baseOk, handle: 'inv_1' })).toBe(false);
  });

  it('rejects ok with a non-null approval', () => {
    expect(validateEnvelope({ ...baseOk, approval })).toBe(false);
  });

  it('rejects running with a null handle', () => {
    const e: ToolResult = { status: 'running', result: null, error: null, handle: null, approval: null, audit_ref: nullAuditRef };
    expect(validateEnvelope(e)).toBe(false);
  });

  it('rejects running with a non-null error', () => {
    const e: ToolResult = { status: 'running', result: null, error: { code: 'timeout', message: 'm' }, handle: 'inv_1', approval: null, audit_ref: nullAuditRef };
    expect(validateEnvelope(e)).toBe(false);
  });

  it('rejects awaiting_approval with a null handle', () => {
    const e: ToolResult = { status: 'awaiting_approval', result: null, error: null, handle: null, approval, audit_ref: nullAuditRef };
    expect(validateEnvelope(e)).toBe(false);
  });

  it('rejects awaiting_approval with a null approval', () => {
    const e: ToolResult = { status: 'awaiting_approval', result: null, error: null, handle: 'inv_1', approval: null, audit_ref: nullAuditRef };
    expect(validateEnvelope(e)).toBe(false);
  });

  it('rejects denied with a null error', () => {
    const e: ToolResult = { status: 'denied', result: null, error: null, handle: null, approval: null, audit_ref: nullAuditRef };
    expect(validateEnvelope(e)).toBe(false);
  });

  it('rejects denied with a fault code (wrong partition)', () => {
    const e = { status: 'denied', result: null, error: { code: 'timeout', message: 'oops' }, handle: null, approval: null, audit_ref: nullAuditRef };
    expect(validateEnvelope(e)).toBe(false);
  });

  it('rejects error status with a null error', () => {
    const e: ToolResult = { status: 'error', result: null, error: null, handle: null, approval: null, audit_ref: nullAuditRef };
    expect(validateEnvelope(e)).toBe(false);
  });

  it('rejects error status with a denial code (wrong partition)', () => {
    const e = { status: 'error', result: null, error: { code: 'policy_denied', message: 'msg' }, handle: null, approval: null, audit_ref: nullAuditRef };
    expect(validateEnvelope(e)).toBe(false);
  });

  it('rejects an out-of-set error.code (arbitrary string)', () => {
    const e = { status: 'error', result: null, error: { code: 'unknown_code', message: 'm' }, handle: null, approval: null, audit_ref: nullAuditRef };
    expect(validateEnvelope(e)).toBe(false);
  });

  it('rejects a missing audit_ref', () => {
    const { audit_ref: _, ...noAuditRef } = baseOk;
    expect(validateEnvelope(noAuditRef)).toBe(false);
  });

  it('rejects a missing status field', () => {
    const { status: _, ...noStatus } = baseOk;
    expect(validateEnvelope(noStatus)).toBe(false);
  });

  it('rejects an unknown status value', () => {
    expect(validateEnvelope({ ...baseOk, status: 'cancelled' })).toBe(false);
  });

  it('rejects null (not an envelope)', () => {
    expect(validateEnvelope(null)).toBe(false);
  });

  it('rejects a primitive (not an envelope)', () => {
    expect(validateEnvelope('ok')).toBe(false);
  });

  it('rejects an empty object (not an envelope)', () => {
    expect(validateEnvelope({})).toBe(false);
  });

  it('rejects extra/unknown top-level fields (additionalProperties: false)', () => {
    expect(validateEnvelope({ ...baseOk, extra_field: true })).toBe(false);
  });

  // ok result must be an object per the status branch — primitives and arrays fail.
  it('rejects ok with a string result (result must be type: object)', () => {
    expect(validateEnvelope({ ...baseOk, result: 'text' })).toBe(false);
  });

  it('rejects ok with a numeric result', () => {
    expect(validateEnvelope({ ...baseOk, result: 42 })).toBe(false);
  });

  it('rejects ok with an array result (arrays are not type: object in JSON Schema)', () => {
    expect(validateEnvelope({ ...baseOk, result: ['a', 'b'] })).toBe(false);
  });

  // approval block field validation.
  it('rejects awaiting_approval with an invalid risk value', () => {
    const badApproval = { ...approval, risk: 'critical' };
    const e = { status: 'awaiting_approval', result: null, error: null, handle: 'inv_1', approval: badApproval, audit_ref: nullAuditRef };
    expect(validateEnvelope(e)).toBe(false);
  });

  it('rejects awaiting_approval when approval is missing the summary field', () => {
    const { summary: _, ...noSummary } = approval;
    const e = { status: 'awaiting_approval', result: null, error: null, handle: 'inv_1', approval: noSummary, audit_ref: nullAuditRef };
    expect(validateEnvelope(e)).toBe(false);
  });

  it('rejects awaiting_approval when approval is missing the expires_at field', () => {
    const { expires_at: _, ...noExpiry } = approval;
    const e = { status: 'awaiting_approval', result: null, error: null, handle: 'inv_1', approval: noExpiry, audit_ref: nullAuditRef };
    expect(validateEnvelope(e)).toBe(false);
  });

  // error object field validation.
  it('rejects an error object missing the required message field', () => {
    // The error schema requires both "code" and "message".
    const e = { status: 'error', result: null, error: { code: 'internal' }, handle: null, approval: null, audit_ref: nullAuditRef };
    expect(validateEnvelope(e)).toBe(false);
  });

  it('rejects an error object missing the required code field', () => {
    const e = { status: 'error', result: null, error: { message: 'oops' }, handle: null, approval: null, audit_ref: nullAuditRef };
    expect(validateEnvelope(e)).toBe(false);
  });

  // audit_ref nested-object validation.
  it('rejects audit_ref with extra/unknown fields (additionalProperties: false on nested object)', () => {
    const extraAuditRef = { ...nullAuditRef, unexpected_field: 'oops' };
    expect(validateEnvelope({ ...baseOk, audit_ref: extraAuditRef })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateEnvelope.errors is populated on failure
// ---------------------------------------------------------------------------

describe('validateEnvelope.errors', () => {
  it('is null or empty after a successful validation', () => {
    validateEnvelope(ok({ x: 1 }, nullAuditRef));
    // Ajv sets errors to null on success
    expect(validateEnvelope.errors ?? null).toBeNull();
  });

  it('is a non-empty array after a failed validation', () => {
    validateEnvelope({ status: 'ok', result: null, error: null, handle: null, approval: null, audit_ref: nullAuditRef });
    const errs = validateEnvelope.errors as unknown[] | null | undefined;
    expect(Array.isArray(errs)).toBe(true);
    expect((errs ?? []).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ENVELOPE_SCHEMA is well-formed (consistency with the T101 draft-07 dialect)
// ---------------------------------------------------------------------------

describe('ENVELOPE_SCHEMA document', () => {
  it('declares the draft-07 dialect', () => {
    expect((ENVELOPE_SCHEMA as Record<string, unknown>)['$schema']).toBe(JSON_SCHEMA_DIALECT);
  });

  it('is frozen (immutable contract document)', () => {
    expect(Object.isFrozen(ENVELOPE_SCHEMA)).toBe(true);
  });

  it('requires all six envelope fields', () => {
    const required = (ENVELOPE_SCHEMA as { required: string[] }).required;
    for (const field of ['status', 'result', 'error', 'handle', 'approval', 'audit_ref']) {
      expect(required).toContain(field);
    }
  });

  it('compiles against the draft-07 meta-schema without errors (schema is well-formed)', () => {
    // createAjvValidator() performs the compilation — if the schema is invalid it throws.
    expect(() => {
      createAjvValidator().compile(ENVELOPE_SCHEMA);
    }).not.toThrow();
  });

  it('the compiled validator accepts every helper output', () => {
    // Re-compile independently to verify the exported schema document is consistent.
    const validate = createAjvValidator().compile(ENVELOPE_SCHEMA);
    expect(validate(ok({ x: 1 }, nullAuditRef))).toBe(true);
    expect(validate(running('h', nullAuditRef))).toBe(true);
    expect(validate(awaitingApproval('h', approval, nullAuditRef))).toBe(true);
    expect(validate(denied('policy_denied', 'msg', nullAuditRef))).toBe(true);
    expect(validate(errored('internal', 'msg', nullAuditRef))).toBe(true);
  });
});
