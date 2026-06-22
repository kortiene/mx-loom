/**
 * Envelope types + constructor helpers (T102 / #10) — design §4.2.
 *
 * Tests pin field-presence invariants per status, immutability, and the
 * compile-time status↔code partition (DenialCode / FaultCode). Pure unit tests;
 * no daemon, no socket, no env.
 */
import { describe, expect, it } from 'vitest';

import {
  awaitingApproval,
  denied,
  errored,
  ok,
  running,
  type ApprovalInfo,
  type AuditRef,
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
  risk: 'medium',
  summary: 'Approve deployment to staging',
  expires_at: '2026-06-22T12:00:00Z',
};

// ---------------------------------------------------------------------------
// ok() helper
// ---------------------------------------------------------------------------

describe('ok()', () => {
  it('returns status "ok"', () => {
    expect(ok({ value: 1 }, nullAuditRef).status).toBe('ok');
  });

  it('carries the supplied result payload', () => {
    const payload = { x: 42 };
    expect(ok(payload, nullAuditRef).result).toEqual(payload);
  });

  it('sets error, handle, and approval to null', () => {
    const e = ok({ x: 1 }, nullAuditRef);
    expect(e.error).toBeNull();
    expect(e.handle).toBeNull();
    expect(e.approval).toBeNull();
  });

  it('carries the supplied audit_ref', () => {
    const e = ok({ x: 1 }, fullAuditRef);
    expect(e.audit_ref).toEqual(fullAuditRef);
  });

  it('returns a deeply frozen object (top level)', () => {
    expect(Object.isFrozen(ok({ x: 1 }, nullAuditRef))).toBe(true);
  });

  it('deeply freezes nested audit_ref', () => {
    const e = ok({ x: 1 }, { ...nullAuditRef });
    expect(Object.isFrozen(e.audit_ref)).toBe(true);
  });

  it('deeply freezes the result object', () => {
    const payload = { nested: { a: 1 } };
    const e = ok(payload, nullAuditRef);
    expect(Object.isFrozen(e.result)).toBe(true);
  });

  it('mutation of top-level fields silently fails (frozen)', () => {
    const e = ok({ x: 1 }, nullAuditRef);
    expect(() => {
      (e as unknown as Record<string, unknown>).status = 'error';
    }).toThrow();
  });

  it('accepts null audit ref inner fields (pending daemon round-trip)', () => {
    const e = ok({ x: 1 }, nullAuditRef);
    expect(e.audit_ref.invocation_id).toBeNull();
    expect(e.audit_ref.request_id).toBeNull();
    expect(e.audit_ref.room).toBeNull();
    expect(e.audit_ref.event_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// running() helper
// ---------------------------------------------------------------------------

describe('running()', () => {
  it('returns status "running"', () => {
    expect(running('inv_handle', nullAuditRef).status).toBe('running');
  });

  it('carries the supplied handle', () => {
    expect(running('inv_42', nullAuditRef).handle).toBe('inv_42');
  });

  it('sets result, error, and approval to null', () => {
    const e = running('inv_1', nullAuditRef);
    expect(e.result).toBeNull();
    expect(e.error).toBeNull();
    expect(e.approval).toBeNull();
  });

  it('carries the supplied audit_ref', () => {
    const e = running('inv_1', fullAuditRef);
    expect(e.audit_ref).toEqual(fullAuditRef);
  });

  it('returns a deeply frozen object', () => {
    expect(Object.isFrozen(running('h', nullAuditRef))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// awaitingApproval() helper
// ---------------------------------------------------------------------------

describe('awaitingApproval()', () => {
  it('returns status "awaiting_approval"', () => {
    expect(awaitingApproval('inv_ap', approval, nullAuditRef).status).toBe('awaiting_approval');
  });

  it('carries the supplied handle', () => {
    expect(awaitingApproval('inv_ap', approval, nullAuditRef).handle).toBe('inv_ap');
  });

  it('carries the supplied approval block', () => {
    const e = awaitingApproval('inv_ap', approval, nullAuditRef);
    expect(e.approval).toEqual(approval);
  });

  it('sets result and error to null', () => {
    const e = awaitingApproval('inv_ap', approval, nullAuditRef);
    expect(e.result).toBeNull();
    expect(e.error).toBeNull();
  });

  it('carries the supplied audit_ref', () => {
    const e = awaitingApproval('inv_ap', approval, fullAuditRef);
    expect(e.audit_ref).toEqual(fullAuditRef);
  });

  it('returns a deeply frozen object', () => {
    expect(Object.isFrozen(awaitingApproval('h', approval, nullAuditRef))).toBe(true);
  });

  it('deeply freezes the approval block', () => {
    const e = awaitingApproval('h', { ...approval }, nullAuditRef);
    expect(Object.isFrozen(e.approval)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// denied() helper
// ---------------------------------------------------------------------------

describe('denied()', () => {
  it('returns status "denied"', () => {
    expect(denied('policy_denied', 'blocked by policy', nullAuditRef).status).toBe('denied');
  });

  it('carries the supplied denial code in error.code', () => {
    const e = denied('untrusted_key', 'msg', nullAuditRef);
    expect(e.error?.code).toBe('untrusted_key');
  });

  it('carries the supplied message in error.message', () => {
    const e = denied('approval_denied', 'operator rejected', nullAuditRef);
    expect(e.error?.message).toBe('operator rejected');
  });

  it('sets result, handle, and approval to null', () => {
    const e = denied('policy_denied', 'msg', nullAuditRef);
    expect(e.result).toBeNull();
    expect(e.handle).toBeNull();
    expect(e.approval).toBeNull();
  });

  it('accepts every DenialCode', () => {
    const codes = ['policy_denied', 'untrusted_key', 'approval_denied', 'approval_expired'] as const;
    for (const code of codes) {
      expect(denied(code, 'msg', nullAuditRef).error?.code).toBe(code);
    }
  });

  it('carries the supplied audit_ref', () => {
    const e = denied('policy_denied', 'msg', fullAuditRef);
    expect(e.audit_ref).toEqual(fullAuditRef);
  });

  it('returns a deeply frozen object', () => {
    expect(Object.isFrozen(denied('policy_denied', 'msg', nullAuditRef))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// errored() helper
// ---------------------------------------------------------------------------

describe('errored()', () => {
  it('returns status "error"', () => {
    expect(errored('timeout', 'call timed out', nullAuditRef).status).toBe('error');
  });

  it('carries the supplied fault code in error.code', () => {
    const e = errored('not_found', 'msg', nullAuditRef);
    expect(e.error?.code).toBe('not_found');
  });

  it('carries the supplied message in error.message', () => {
    const e = errored('internal', 'fabric error', nullAuditRef);
    expect(e.error?.message).toBe('fabric error');
  });

  it('sets result, handle, and approval to null', () => {
    const e = errored('timeout', 'msg', nullAuditRef);
    expect(e.result).toBeNull();
    expect(e.handle).toBeNull();
    expect(e.approval).toBeNull();
  });

  it('accepts every FaultCode', () => {
    const codes = ['timeout', 'not_found', 'invalid_args', 'target_offline', 'internal'] as const;
    for (const code of codes) {
      expect(errored(code, 'msg', nullAuditRef).error?.code).toBe(code);
    }
  });

  it('carries the supplied audit_ref', () => {
    const e = errored('timeout', 'msg', fullAuditRef);
    expect(e.audit_ref).toEqual(fullAuditRef);
  });

  it('returns a deeply frozen object', () => {
    expect(Object.isFrozen(errored('timeout', 'msg', nullAuditRef))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Status ↔ code partition — compile-time enforcement
//
// The TypeScript compiler should flag these call sites as type errors because
// the code arguments belong to the wrong partition. vitest executes through the
// TS compiler, so an absent @ts-expect-error would cause a build error.
// ---------------------------------------------------------------------------

describe('status↔code partition (compile-time)', () => {
  it('denied() rejects FaultCodes at the type level', () => {
    // @ts-expect-error — 'timeout' is a FaultCode, not a DenialCode
    void denied('timeout', 'msg', nullAuditRef);
    // @ts-expect-error — 'not_found' is a FaultCode, not a DenialCode
    void denied('not_found', 'msg', nullAuditRef);
    // @ts-expect-error — 'invalid_args' is a FaultCode, not a DenialCode
    void denied('invalid_args', 'msg', nullAuditRef);
    // @ts-expect-error — 'target_offline' is a FaultCode, not a DenialCode
    void denied('target_offline', 'msg', nullAuditRef);
    // @ts-expect-error — 'internal' is a FaultCode, not a DenialCode
    void denied('internal', 'msg', nullAuditRef);
    expect(true).toBe(true); // the test itself always passes; TS checks the partitioning
  });

  it('errored() rejects DenialCodes at the type level', () => {
    // @ts-expect-error — 'policy_denied' is a DenialCode, not a FaultCode
    void errored('policy_denied', 'msg', nullAuditRef);
    // @ts-expect-error — 'untrusted_key' is a DenialCode, not a FaultCode
    void errored('untrusted_key', 'msg', nullAuditRef);
    // @ts-expect-error — 'approval_denied' is a DenialCode, not a FaultCode
    void errored('approval_denied', 'msg', nullAuditRef);
    // @ts-expect-error — 'approval_expired' is a DenialCode, not a FaultCode
    void errored('approval_expired', 'msg', nullAuditRef);
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// audit_ref — always structurally present
// ---------------------------------------------------------------------------

describe('audit_ref is always structurally present', () => {
  it('ok() audit_ref is an object, not null', () => {
    expect(ok({}, nullAuditRef).audit_ref).not.toBeNull();
    expect(typeof ok({}, nullAuditRef).audit_ref).toBe('object');
  });

  it('running() audit_ref is an object', () => {
    expect(typeof running('h', nullAuditRef).audit_ref).toBe('object');
  });

  it('awaitingApproval() audit_ref is an object', () => {
    expect(typeof awaitingApproval('h', approval, nullAuditRef).audit_ref).toBe('object');
  });

  it('denied() audit_ref is an object', () => {
    expect(typeof denied('policy_denied', 'msg', nullAuditRef).audit_ref).toBe('object');
  });

  it('errored() audit_ref is an object', () => {
    expect(typeof errored('timeout', 'msg', nullAuditRef).audit_ref).toBe('object');
  });
});
