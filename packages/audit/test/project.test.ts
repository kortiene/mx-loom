/**
 * The pure projection (T113 / #21) — `auditRowFrom` + `deriveDedupKey`.
 *
 * Proves the projection is total across all five statuses, lifts the four
 * `audit_ref` ids verbatim, draws `error_code` from the closed set only for
 * `denied`/`error`, surfaces `approval_request_id` only for `awaiting_approval`,
 * and folds `(call_id, status, invocation_id)` into a stable dedup key.
 */
import { describe, expect, it } from 'vitest';

import {
  awaitingApproval,
  DENIAL_CODES,
  denied,
  errored,
  FAULT_CODES,
  ok,
  running,
  type ApprovalInfo,
  type AuditRef,
} from '@mx-loom/registry';

import { auditRowFrom, deriveDedupKey, type AuditContext } from '../src/index.js';

const POPULATED_REF: AuditRef = {
  invocation_id: 'inv_1',
  request_id: 'req_1',
  room: '!room:server',
  event_id: '$evt_1',
};
const NULL_REF: AuditRef = { invocation_id: null, request_id: null, room: null, event_id: null };

const CTX: AuditContext = {
  tool_name: 'mx_delegate_tool',
  call_id: 'call_abc',
  correlation_id: 'corr_xyz',
  idempotency_key: 'idk_123',
};

const APPROVAL: ApprovalInfo = {
  request_id: 'apr_1',
  risk: 'high',
  summary: 'run a guarded command',
  expires_at: '2026-06-22T00:00:00Z',
};

describe('auditRowFrom — model-action context lifting', () => {
  it('lifts tool_name / correlation_id / idempotency_key from ctx', () => {
    const row = auditRowFrom(ok({ done: true }, POPULATED_REF), CTX);
    expect(row.tool_name).toBe('mx_delegate_tool');
    expect(row.correlation_id).toBe('corr_xyz');
    expect(row.idempotency_key).toBe('idk_123');
  });

  it('lifts the four audit_ref ids verbatim', () => {
    const row = auditRowFrom(ok({}, POPULATED_REF), CTX);
    expect(row.invocation_id).toBe('inv_1');
    expect(row.request_id).toBe('req_1');
    expect(row.room).toBe('!room:server');
    expect(row.event_id).toBe('$evt_1');
  });

  it('null-coalesces optional ctx fields to null', () => {
    const row = auditRowFrom(ok({}, POPULATED_REF), { tool_name: 'mx_find_agents', call_id: 'c1' });
    expect(row.correlation_id).toBeNull();
    expect(row.idempotency_key).toBeNull();
  });

  it('a local read (all-null audit_ref) yields null correlation ids but a valid row', () => {
    const row = auditRowFrom(ok({ agents: [] }, NULL_REF), { tool_name: 'mx_find_agents', call_id: 'c1' });
    expect(row.invocation_id).toBeNull();
    expect(row.room).toBeNull();
    expect(row.tool_name).toBe('mx_find_agents');
    expect(row.status).toBe('ok');
    expect(row.dedup_key).toBe('c1:ok:∅');
  });
});

describe('auditRowFrom — status → outcome columns', () => {
  it('ok: no error_code, no approval', () => {
    const row = auditRowFrom(ok({}, POPULATED_REF), CTX);
    expect(row.status).toBe('ok');
    expect(row.error_code).toBeNull();
    expect(row.approval_request_id).toBeNull();
  });

  it('running: no error_code, no approval', () => {
    const row = auditRowFrom(running('h1', POPULATED_REF), CTX);
    expect(row.status).toBe('running');
    expect(row.error_code).toBeNull();
    expect(row.approval_request_id).toBeNull();
  });

  it('awaiting_approval: approval_request_id populated, no error_code', () => {
    const row = auditRowFrom(awaitingApproval('h1', APPROVAL, POPULATED_REF), CTX);
    expect(row.status).toBe('awaiting_approval');
    expect(row.approval_request_id).toBe('apr_1');
    expect(row.error_code).toBeNull();
  });

  it('denied: closed-set error_code populated, no approval', () => {
    const row = auditRowFrom(denied('policy_denied', 'nope', POPULATED_REF), CTX);
    expect(row.status).toBe('denied');
    expect(row.error_code).toBe('policy_denied');
    expect(row.approval_request_id).toBeNull();
  });

  it('error: closed-set error_code populated', () => {
    const row = auditRowFrom(errored('timeout', 'slow', POPULATED_REF), CTX);
    expect(row.status).toBe('error');
    expect(row.error_code).toBe('timeout');
  });
});

describe('deriveDedupKey', () => {
  it('is deterministic for the same (call_id, status, invocation_id)', () => {
    expect(deriveDedupKey('c1', 'ok', 'inv_1')).toBe(deriveDedupKey('c1', 'ok', 'inv_1'));
  });

  it('distinguishes status (the running→ok lifecycle is two keys)', () => {
    expect(deriveDedupKey('c1', 'running', 'inv_1')).not.toBe(deriveDedupKey('c1', 'ok', 'inv_1'));
  });

  it('distinguishes call_id (two distinct calls never collide)', () => {
    expect(deriveDedupKey('c1', 'ok', null)).not.toBe(deriveDedupKey('c2', 'ok', null));
  });

  it('collapses a null invocation_id to a stable placeholder', () => {
    expect(deriveDedupKey('c1', 'ok', null)).toBe('c1:ok:∅');
  });
});

describe('auditRowFrom — status → outcome columns (continued)', () => {
  it('error: approval_request_id is null (approval only set for awaiting_approval)', () => {
    const row = auditRowFrom(errored('timeout', 'slow', POPULATED_REF), CTX);
    expect(row.status).toBe('error');
    expect(row.error_code).toBe('timeout');
    expect(row.approval_request_id).toBeNull();
  });

  it('denied: approval_request_id is null', () => {
    const row = auditRowFrom(denied('approval_denied', 'expired', POPULATED_REF), CTX);
    expect(row.approval_request_id).toBeNull();
  });
});

describe('deriveDedupKey — all five statuses produce distinct keys', () => {
  const STATUSES = ['ok', 'running', 'awaiting_approval', 'denied', 'error'] as const;
  it('all five statuses yield distinct keys for the same (call_id, invocation_id)', () => {
    const keys = STATUSES.map((s) => deriveDedupKey('c1', s, 'inv_1'));
    expect(new Set(keys).size).toBe(5);
  });

  it('call_id distinguishes two calls with the same status and invocation_id', () => {
    const a = deriveDedupKey('call_AAA', 'ok', 'inv_1');
    const b = deriveDedupKey('call_BBB', 'ok', 'inv_1');
    expect(a).not.toBe(b);
  });
});

describe('auditRowFrom — totality (never throws on a well-formed envelope)', () => {
  it('handles every status with both populated and null refs', () => {
    const envelopes = [
      ok({}, POPULATED_REF),
      ok({}, NULL_REF),
      running('h', POPULATED_REF),
      awaitingApproval('h', APPROVAL, POPULATED_REF),
      denied('untrusted_key', 'm', POPULATED_REF),
      errored('internal', 'm', NULL_REF),
    ];
    for (const env of envelopes) {
      expect(() => auditRowFrom(env, CTX)).not.toThrow();
    }
  });
});

describe('auditRowFrom — full denial-code coverage (all 4 denial codes)', () => {
  // Pins the closed set: adding/removing a denial code must update these tests.
  it.each(DENIAL_CODES)('denial code "%s" → row.status=denied, row.error_code=code, no approval', (code) => {
    const row = auditRowFrom(denied(code, 'blocked', POPULATED_REF), CTX);
    expect(row.status).toBe('denied');
    expect(row.error_code).toBe(code);
    expect(row.approval_request_id).toBeNull();
  });
});

describe('auditRowFrom — full fault-code coverage (all 5 fault codes)', () => {
  // Pins the closed set: adding/removing a fault code must update these tests.
  it.each(FAULT_CODES)('fault code "%s" → row.status=error, row.error_code=code, no approval', (code) => {
    const row = auditRowFrom(errored(code, 'fail', POPULATED_REF), CTX);
    expect(row.status).toBe('error');
    expect(row.error_code).toBe(code);
    expect(row.approval_request_id).toBeNull();
  });
});

describe('auditRowFrom — row key completeness', () => {
  it('produces exactly the 11 documented AuditRow keys, no extras', () => {
    // Guards against accidentally adding a new field (e.g. error_message, result)
    // that could carry a secret. Any structural addition must be a deliberate change.
    const row = auditRowFrom(ok({}, POPULATED_REF), CTX);
    const keys = Object.keys(row).sort();
    expect(keys).toEqual([
      'approval_request_id',
      'correlation_id',
      'dedup_key',
      'error_code',
      'event_id',
      'idempotency_key',
      'invocation_id',
      'request_id',
      'room',
      'status',
      'tool_name',
    ]);
  });
});
