/**
 * The `withAudit` tap (T113 / #21) + the AC-2 correlation join.
 *
 * - Pass-through: the envelope is returned unchanged.
 * - Best-effort: a throwing sink is swallowed (logged, never rethrown).
 * - Exactly one `record` per result; over a fake dispatch of N results, N rows.
 * - AC 2: rows recovered for one `invocation_id` recover model action ↔
 *   invocation ↔ approval; a `correlation_id` query returns a session's results.
 */
import { describe, expect, it, vi } from 'vitest';

import { awaitingApproval, ok, running, type ApprovalInfo, type AuditRef, type ToolResult } from '@mx-loom/registry';

import { InMemoryAuditSink, withAudit, type AuditPerCall, type AuditSink } from '../src/index.js';

const REF: AuditRef = { invocation_id: 'inv_1', request_id: 'req_1', room: '!r:s', event_id: '$e' };
const PER: AuditPerCall = { tool_name: 'mx_delegate_tool', call_id: 'c1' };

describe('withAudit — pass-through', () => {
  it('returns the exact envelope object, unmodified', async () => {
    const env = ok({ value: 42 }, REF);
    const tap = withAudit(new InMemoryAuditSink(), { correlation_id: 'corr_1' });
    const out = await tap(env, PER);
    expect(out).toBe(env);
  });
});

describe('withAudit — best-effort (swallow sink failure)', () => {
  it('a throwing sink is swallowed and the failure logged, never rethrown', async () => {
    const throwing: AuditSink = {
      record: () => Promise.reject(new Error('pg down')),
    };
    const log = vi.fn();
    const tap = withAudit(throwing, { correlation_id: 'corr_1' }, log);
    const env = ok({}, REF);
    await expect(tap(env, PER)).resolves.toBe(env); // still returns the envelope
    expect(log).toHaveBeenCalledOnce();
    // logged with the dedup_key, not the row's ids
    expect(log.mock.calls[0]?.[1]).toBe('c1:ok:inv_1');
  });
});

describe('withAudit — exactly one row per result', () => {
  it('records exactly once per call', async () => {
    const sink = new InMemoryAuditSink();
    const record = vi.spyOn(sink, 'record');
    const tap = withAudit(sink, { correlation_id: 'corr_1' });
    await tap(ok({}, REF), PER);
    expect(record).toHaveBeenCalledOnce();
  });

  it('over a fake dispatch of N distinct results, exactly N rows', async () => {
    const sink = new InMemoryAuditSink();
    const tap = withAudit(sink, { correlation_id: 'corr_1' });
    const results: ToolResult[] = Array.from({ length: 5 }, (_, i) => ok({ i }, REF));
    for (const [i, r] of results.entries()) {
      await tap(r, { tool_name: 'mx_find_agents', call_id: `call_${i}` });
    }
    expect(sink.count).toBe(5);
  });
});

describe('withAudit — AC 2 correlation', () => {
  const APPROVAL: ApprovalInfo = {
    request_id: 'apr_9',
    risk: 'high',
    summary: 's',
    expires_at: '2026-06-22T00:00:00Z',
  };

  it('recovers model action ↔ invocation ↔ approval for one invocation_id', async () => {
    const sink = new InMemoryAuditSink();
    const tap = withAudit(sink, { correlation_id: 'corr_session' });
    // awaiting_approval → resolved ok, same call + invocation.
    await tap(awaitingApproval('h', APPROVAL, REF), { tool_name: 'mx_run_command', call_id: 'c9', idempotency_key: 'idk_9' });
    await tap(ok({ exit_code: 0 }, REF), { tool_name: 'mx_run_command', call_id: 'c9' });

    const chain = sink.byInvocation('inv_1');
    expect(chain).toHaveLength(2);
    // model action
    expect(chain.every((r) => r.tool_name === 'mx_run_command')).toBe(true);
    expect(chain.every((r) => r.correlation_id === 'corr_session')).toBe(true);
    // invocation (substrate pointer)
    expect(chain.every((r) => r.event_id === '$e' && r.request_id === 'req_1')).toBe(true);
    // approval — request_id is on the awaiting_approval row; idempotency_key is propagated
    expect(chain.find((r) => r.status === 'awaiting_approval')?.approval_request_id).toBe('apr_9');
    expect(chain.find((r) => r.status === 'awaiting_approval')?.idempotency_key).toBe('idk_9');
    // the resolved ok row has no approval_request_id (different status, different row)
    expect(chain.find((r) => r.status === 'ok')?.approval_request_id).toBeNull();
  });

  it('a correlation_id query returns a full session result set', async () => {
    const sink = new InMemoryAuditSink();
    const tap = withAudit(sink, { correlation_id: 'corr_session' });
    await tap(running('h', REF), { tool_name: 'mx_delegate_tool', call_id: 'a' });
    await tap(ok({}, REF), { tool_name: 'mx_delegate_tool', call_id: 'b' });
    expect(sink.byCorrelation('corr_session')).toHaveLength(2);
  });
});

describe('withAudit — NullAuditSink still passes through', () => {
  it('passes the envelope through unchanged when using a NullAuditSink', async () => {
    const { NullAuditSink } = await import('../src/index.js');
    const env = ok({ done: true }, REF);
    const tap = withAudit(new NullAuditSink(), { correlation_id: 'c' });
    await expect(tap(env, PER)).resolves.toBe(env);
  });
});

describe('withAudit — per-call idempotency_key context merge', () => {
  it('per-call idempotency_key overrides the base context value', async () => {
    const sink = new InMemoryAuditSink();
    const tap = withAudit(sink, { correlation_id: 'c', idempotency_key: 'base_key' });
    await tap(ok({}, REF), { tool_name: 'mx_run_command', call_id: 'x1', idempotency_key: 'per_call_key' });
    expect(sink.rows[0]?.idempotency_key).toBe('per_call_key');
  });

  it('per-call idempotency_key absent means null in row when base also has none', async () => {
    const sink = new InMemoryAuditSink();
    const tap = withAudit(sink, { correlation_id: 'c' });
    await tap(ok({}, REF), { tool_name: 'mx_find_agents', call_id: 'x2' });
    expect(sink.rows[0]?.idempotency_key).toBeNull();
  });

  it('base idempotency_key is used when per-call does not specify one', async () => {
    // The withAudit spread is { ...baseCtx, ...perCall }. If baseCtx has an
    // idempotency_key and perCall does not, the base value flows to the row.
    // This is intentional: a session-level default key is propagated; per-call
    // mutating verbs override with their own key (tested above).
    const sink = new InMemoryAuditSink();
    const tap = withAudit(sink, { correlation_id: 'c', idempotency_key: 'session_idk' });
    await tap(ok({}, REF), { tool_name: 'mx_run_command', call_id: 'x3' });
    expect(sink.rows[0]?.idempotency_key).toBe('session_idk');
  });
});

describe('withAudit — synchronous throw from sink', () => {
  it('a sink.record that throws synchronously is swallowed, envelope returned unchanged', async () => {
    // `await sink.record(row)` converts a synchronous throw into a rejected promise,
    // which the surrounding try/catch catches. The tap must not propagate it.
    const syncThrow: AuditSink = {
      record: (() => { throw new Error('sync failure'); }) as () => Promise<void>,
    };
    const log = vi.fn();
    const env = ok({}, REF);
    const tap = withAudit(syncThrow, { correlation_id: 'c' }, log);
    await expect(tap(env, PER)).resolves.toBe(env);
    expect(log).toHaveBeenCalledOnce();
  });
});
