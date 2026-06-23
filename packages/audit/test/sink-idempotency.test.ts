/**
 * Exactly-once (AC 1) + lifecycle-trail semantics (T113 / #21).
 *
 * - Re-recording the same emission (same `dedup_key`) yields one row.
 * - A deferred call's `running` → `ok` emissions yield two rows sharing one
 *   `invocation_id` — the audit *trail*, not a duplicate.
 * - Two distinct calls with identical content (same tool, all-null `audit_ref`)
 *   yield two rows, because their `call_id`s differ.
 * - `NullAuditSink` records nothing.
 */
import { describe, expect, it } from 'vitest';

import { ok, running, type AuditRef } from '@mx-loom/registry';

import { auditRowFrom, InMemoryAuditSink, NullAuditSink, type AuditContext } from '../src/index.js';

const REF = (invocation_id: string | null): AuditRef => ({
  invocation_id,
  request_id: invocation_id ? 'req_1' : null,
  room: invocation_id ? '!r:s' : null,
  event_id: invocation_id ? '$e' : null,
});

const ctx = (call_id: string): AuditContext => ({ tool_name: 'mx_delegate_tool', call_id, correlation_id: 'corr_1' });

describe('InMemoryAuditSink — exactly-once (AC 1)', () => {
  it('recording the same emission twice yields exactly one row', async () => {
    const sink = new InMemoryAuditSink();
    const row = auditRowFrom(ok({}, REF('inv_1')), ctx('c1'));
    await sink.record(row);
    await sink.record(row); // re-delivery / transport retry
    expect(sink.count).toBe(1);
  });

  it('a running→ok lifecycle yields two rows sharing one invocation_id', async () => {
    const sink = new InMemoryAuditSink();
    await sink.record(auditRowFrom(running('h', REF('inv_1')), ctx('c1')));
    await sink.record(auditRowFrom(ok({}, REF('inv_1')), ctx('c1')));
    expect(sink.count).toBe(2);
    expect(sink.byInvocation('inv_1')).toHaveLength(2);
    expect(sink.byInvocation('inv_1').map((r) => r.status)).toEqual(['running', 'ok']);
  });

  it('two distinct calls with identical content yield two rows (distinct call_id)', async () => {
    const sink = new InMemoryAuditSink();
    await sink.record(auditRowFrom(ok({}, REF(null)), ctx('c1')));
    await sink.record(auditRowFrom(ok({}, REF(null)), ctx('c2')));
    expect(sink.count).toBe(2);
  });

  it('exposes rows as a read-only view in insertion order', async () => {
    const sink = new InMemoryAuditSink();
    await sink.record(auditRowFrom(running('h', REF('inv_1')), ctx('c1')));
    await sink.record(auditRowFrom(ok({}, REF('inv_1')), ctx('c1')));
    expect(sink.rows.map((r) => r.status)).toEqual(['running', 'ok']);
  });
});

describe('InMemoryAuditSink — initial state', () => {
  it('starts empty (count 0, rows [])', () => {
    const sink = new InMemoryAuditSink();
    expect(sink.count).toBe(0);
    expect(sink.rows).toHaveLength(0);
  });
});

describe('InMemoryAuditSink — byCorrelation isolation across mixed sessions', () => {
  it('returns only rows for the queried correlation_id when sessions are interleaved', async () => {
    const sink = new InMemoryAuditSink();
    const ctxA = (call_id: string): AuditContext => ({ tool_name: 'mx_delegate_tool', call_id, correlation_id: 'session_A' });
    const ctxB = (call_id: string): AuditContext => ({ tool_name: 'mx_run_command', call_id, correlation_id: 'session_B' });

    await sink.record(auditRowFrom(ok({}, REF('inv_1')), ctxA('a1')));
    await sink.record(auditRowFrom(ok({}, REF('inv_2')), ctxB('b1')));
    await sink.record(auditRowFrom(ok({}, REF('inv_3')), ctxA('a2')));
    await sink.record(auditRowFrom(ok({}, REF('inv_4')), ctxB('b2')));

    expect(sink.byCorrelation('session_A')).toHaveLength(2);
    expect(sink.byCorrelation('session_A').every((r) => r.correlation_id === 'session_A')).toBe(true);
    expect(sink.byCorrelation('session_B')).toHaveLength(2);
    expect(sink.byCorrelation('unknown')).toHaveLength(0);
  });
});

describe('NullAuditSink', () => {
  it('records nothing and never throws', async () => {
    const sink = new NullAuditSink();
    await expect(sink.record(auditRowFrom(ok({}, REF('inv_1')), ctx('c1')))).resolves.toBeUndefined();
  });
});

describe('InMemoryAuditSink — two-hop deferred lifecycle (null invocation_id in running phase)', () => {
  // Real-world: the daemon has not yet returned an invocation_id when it acknowledges
  // the call as `running`; the terminal `ok` carries the real id. The two emissions
  // have *different* dedup keys (running:∅ vs ok:inv_1), so both are stored.
  // `byInvocation('inv_1')` recovers only the terminal row because the running row's
  // invocation_id is null (it was unknown at emission time).
  it('running (null inv) + ok (real inv) → 2 rows; byInvocation returns only the ok row', async () => {
    const sink = new InMemoryAuditSink();
    const NULL_REF: AuditRef = { invocation_id: null, request_id: null, room: null, event_id: null };
    const REAL_REF: AuditRef = { invocation_id: 'inv_1', request_id: 'req_1', room: '!r:s', event_id: '$e' };
    await sink.record(auditRowFrom(running('h', NULL_REF), ctx('c1')));
    await sink.record(auditRowFrom(ok({}, REAL_REF), ctx('c1')));
    expect(sink.count).toBe(2);
    const byInv = sink.byInvocation('inv_1');
    expect(byInv).toHaveLength(1);
    expect(byInv[0]?.status).toBe('ok');
  });

  it('re-emitting the null-invocation running row is a no-op (same dedup_key)', async () => {
    const sink = new InMemoryAuditSink();
    const NULL_REF: AuditRef = { invocation_id: null, request_id: null, room: null, event_id: null };
    const row = auditRowFrom(running('h', NULL_REF), ctx('c1'));
    await sink.record(row);
    await sink.record(row); // transport retry
    expect(sink.count).toBe(1);
  });
});
