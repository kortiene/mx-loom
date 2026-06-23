/**
 * Binding-level end-to-end scenario (T113 / #21).
 *
 * Simulates what a binding (T109 MCP server, T110 Claude shim) will do once it
 * applies `withAudit` at its single dispatch chokepoint: drive a realistic
 * multi-tool, multi-status session through the tap and assert both acceptance
 * criteria hold across the *complete* session — not just individual behaviors.
 *
 * Scenarios:
 *
 *   1. Local read   : `mx_find_agents`    → ok  (all-null audit_ref)
 *   2. Standard ok  : `mx_delegate_tool`  → ok  (populated audit_ref)
 *   3. Deferred run : `mx_run_command`    → running (null inv) → ok (real inv)
 *   4. Denial path  : `mx_run_command`    → awaiting_approval → denied (operator)
 *   5. Fault        : `mx_delegate_tool`  → error (timeout)
 *
 * AC-1 ("every result → exactly one row"):
 *   5 calls producing 7 distinct emissions → 7 rows.
 *   Transport retries of any emission are no-ops.
 *
 * AC-2 ("rows correlate model action ↔ daemon invocation ↔ approval"):
 *   byInvocation recovers a lifecycle chain; byCorrelation returns the complete
 *   session; the awaiting_approval → denied join is intact.
 *
 * Best-effort guarantee: a transient sink failure in the middle of a session
 * neither aborts the session nor corrupts subsequent rows.
 *
 * This file does NOT duplicate the unit behaviors already pinned in
 * project.test.ts / sink-idempotency.test.ts / with-audit.test.ts. It exercises
 * the *composition* of those behaviors — the whole larger than the parts.
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
} from '@mx-loom/registry';

import { InMemoryAuditSink, withAudit, type AuditSink } from '../src/index.js';

// ─── Shared fixture helpers ───────────────────────────────────────────────────

const NULL_REF: AuditRef = { invocation_id: null, request_id: null, room: null, event_id: null };

function ref(invocation_id: string): AuditRef {
  return { invocation_id, request_id: `req_${invocation_id}`, room: '!room:server', event_id: `$evt_${invocation_id}` };
}

const APPROVAL: ApprovalInfo = {
  request_id: 'apr_guard',
  risk: 'high',
  summary: 'run a guarded command',
  expires_at: '2026-06-22T00:00:00Z',
};

// ─── Helper: dispatch the canonical 5-call session ───────────────────────────
//
// Returns the sink so callers can make assertions. The session_id allows
// multiple isolated sessions to share one test file without cross-contamination.

async function runSession(sink: InMemoryAuditSink, correlationId: string): Promise<void> {
  const tap = withAudit(sink, { correlation_id: correlationId });

  // 1. Local read — all-null audit_ref; AC-1 "every result" still yields a row.
  await tap(ok({ agents: [] }, NULL_REF), { tool_name: 'mx_find_agents', call_id: `${correlationId}_c1` });

  // 2. Standard delegation — populated audit_ref.
  await tap(ok({ done: true }, ref('inv_del')), { tool_name: 'mx_delegate_tool', call_id: `${correlationId}_c2` });

  // 3a. Deferred: daemon not yet confirmed invocation_id (null inv at running).
  await tap(running('h_cmd', NULL_REF), { tool_name: 'mx_run_command', call_id: `${correlationId}_c3` });
  // 3b. Terminal ok with the real invocation_id returned by the daemon.
  await tap(ok({ exit_code: 0 }, ref('inv_cmd')), { tool_name: 'mx_run_command', call_id: `${correlationId}_c3` });

  // 4a. Guarded command triggers the approval gate.
  await tap(
    awaitingApproval('h_guard', APPROVAL, ref('inv_guard')),
    { tool_name: 'mx_run_command', call_id: `${correlationId}_c4`, idempotency_key: 'idk_guard' },
  );
  // 4b. Operator denies: the resolve delivers a `denied` envelope on the same invocation.
  await tap(
    denied('approval_denied', 'operator rejected the request', ref('inv_guard')),
    { tool_name: 'mx_run_command', call_id: `${correlationId}_c4` },
  );

  // 5. Fault — timeout, no approval involved.
  await tap(errored('timeout', 'agent timed out', ref('inv_err')), { tool_name: 'mx_delegate_tool', call_id: `${correlationId}_c5` });
}

// ─── AC-1: exactly one row per emission ──────────────────────────────────────

describe('AC-1: exactly one row per distinct emission across a full session', () => {
  it('5 calls with 2 two-emission lifecycles produce exactly 7 rows', async () => {
    const sink = new InMemoryAuditSink();
    await runSession(sink, 'e2e_ac1');
    expect(sink.count).toBe(7);
  });

  it('transport retries (re-emitting any row from the session) are no-ops', async () => {
    const sink = new InMemoryAuditSink();
    const tap = withAudit(sink, { correlation_id: 'e2e_retry' });

    // Emit two rows.
    await tap(ok({ done: true }, ref('inv_del')), { tool_name: 'mx_delegate_tool', call_id: 'c_del' });
    await tap(denied('approval_denied', 'no', ref('inv_guard')), { tool_name: 'mx_run_command', call_id: 'c_guard' });
    expect(sink.count).toBe(2);

    // Re-emit both (simulates a binding-level transport retry).
    await tap(ok({ done: true }, ref('inv_del')), { tool_name: 'mx_delegate_tool', call_id: 'c_del' });
    await tap(denied('approval_denied', 'no', ref('inv_guard')), { tool_name: 'mx_run_command', call_id: 'c_guard' });
    expect(sink.count).toBe(2); // no new rows from retries
  });

  it('local-read (all-null audit_ref) still counts as exactly one row (AC-1 "every result")', async () => {
    const sink = new InMemoryAuditSink();
    const tap = withAudit(sink, { correlation_id: 'e2e_local' });
    await tap(ok({ agents: [] }, NULL_REF), { tool_name: 'mx_find_agents', call_id: 'c_local' });
    // Re-emit (same null-ref, same call_id, same status → same dedup_key).
    await tap(ok({ agents: [] }, NULL_REF), { tool_name: 'mx_find_agents', call_id: 'c_local' });
    expect(sink.count).toBe(1);
  });
});

// ─── AC-2: correlation joins ──────────────────────────────────────────────────

describe('AC-2: rows correlate model action ↔ daemon invocation ↔ approval', () => {
  it('byCorrelation returns the complete 7-row session', async () => {
    const sink = new InMemoryAuditSink();
    await runSession(sink, 'e2e_full');

    const session = sink.byCorrelation('e2e_full');
    expect(session).toHaveLength(7);

    // All three tool verbs are represented.
    expect(session.some((r) => r.tool_name === 'mx_find_agents')).toBe(true);
    expect(session.some((r) => r.tool_name === 'mx_delegate_tool')).toBe(true);
    expect(session.some((r) => r.tool_name === 'mx_run_command')).toBe(true);

    // All five statuses are present.
    const statuses = new Set(session.map((r) => r.status));
    expect(statuses).toEqual(new Set(['ok', 'running', 'awaiting_approval', 'denied', 'error']));
  });

  it('byInvocation recovers the deferred-run lifecycle (running → ok) for mx_run_command', async () => {
    const sink = new InMemoryAuditSink();
    const tap = withAudit(sink, { correlation_id: 'e2e_deferred' });

    // The running phase has a null invocation_id (daemon hasn't confirmed yet).
    await tap(running('h_cmd', NULL_REF), { tool_name: 'mx_run_command', call_id: 'c_cmd' });
    // The terminal ok carries the real invocation_id.
    await tap(ok({ exit_code: 0 }, ref('inv_cmd')), { tool_name: 'mx_run_command', call_id: 'c_cmd' });

    // byInvocation only finds the ok row (running row had null inv_id).
    const byInv = sink.byInvocation('inv_cmd');
    expect(byInv).toHaveLength(1);
    expect(byInv[0]?.status).toBe('ok');

    // byCorrelation recovers both (call_id joins them in the session context).
    expect(sink.byCorrelation('e2e_deferred')).toHaveLength(2);
  });

  it('AC-2: awaiting_approval → denied: model action ↔ invocation ↔ approval join is intact', async () => {
    const sink = new InMemoryAuditSink();
    const tap = withAudit(sink, { correlation_id: 'e2e_denial' });

    // Operator approval requested…
    await tap(
      awaitingApproval('h_guard', APPROVAL, ref('inv_guard')),
      { tool_name: 'mx_run_command', call_id: 'c_guard', idempotency_key: 'idk_guard' },
    );
    // …and denied.
    await tap(
      denied('approval_denied', 'operator rejected the request', ref('inv_guard')),
      { tool_name: 'mx_run_command', call_id: 'c_guard' },
    );

    const chain = sink.byInvocation('inv_guard');
    expect(chain).toHaveLength(2);

    // Model action present on every row in the chain.
    expect(chain.every((r) => r.tool_name === 'mx_run_command')).toBe(true);
    expect(chain.every((r) => r.correlation_id === 'e2e_denial')).toBe(true);

    // Substrate pointer (daemon invocation) present on every row.
    expect(chain.every((r) => r.invocation_id === 'inv_guard')).toBe(true);
    expect(chain.every((r) => r.room === '!room:server')).toBe(true);
    expect(chain.every((r) => r.request_id === 'req_inv_guard')).toBe(true);

    // Approval link — request_id on the awaiting_approval row; idempotency_key from ctx.
    const awaitingRow = chain.find((r) => r.status === 'awaiting_approval');
    expect(awaitingRow?.approval_request_id).toBe('apr_guard');
    expect(awaitingRow?.idempotency_key).toBe('idk_guard');

    // Denial outcome — error_code is the closed-set 'approval_denied'.
    const deniedRow = chain.find((r) => r.status === 'denied');
    expect(deniedRow?.error_code).toBe('approval_denied');
    // denied rows do not carry an approval_request_id (the approval block is null on denied envelopes).
    expect(deniedRow?.approval_request_id).toBeNull();
  });

  it('AC-2: mx_await_result as a second model call resolves a deferred mx_run_command — two verbs joined by invocation_id', async () => {
    // Real deferred-result flow (design §4 / T102 mx_await_result):
    //   1. Model calls mx_run_command → binding records `running` (null invocation_id —
    //      daemon has not yet confirmed the id at acknowledgment time).
    //   2. Model calls mx_await_result(handle, wait_ms) as a *separate* tool call →
    //      binding records the terminal `ok` with the real invocation_id.
    //
    // The two rows come from *different* tool verbs and *different* call_ids, so AC-1
    // treats them as distinct emissions (2 rows, not 1).  The same `invocation_id` on
    // the terminal row links the mx_await_result result back to the mx_run_command
    // invocation in the daemon — this is the AC-2 cross-verb join.
    //
    // Contrast with the `byInvocation recovers the deferred-run lifecycle` test above,
    // which simulates the binding *internally* resolving the deferred call (same
    // call_id / tool_name for both emissions).  This test covers the model-visible path
    // where mx_await_result is a real separate tool call.
    const sink = new InMemoryAuditSink();
    const tap = withAudit(sink, { correlation_id: 'e2e_await_result' });

    // Step 1: mx_run_command returns running; daemon has not confirmed invocation_id yet.
    await tap(running('h_cmd', NULL_REF), { tool_name: 'mx_run_command', call_id: 'c_run' });

    // Step 2: mx_await_result resolves the deferred call; daemon returns terminal ok
    // with the real invocation_id now available.
    await tap(ok({ exit_code: 0 }, ref('inv_deferred')), { tool_name: 'mx_await_result', call_id: 'c_await' });

    // AC-1: exactly 2 rows — two distinct emissions (different call_ids + different statuses).
    expect(sink.count).toBe(2);

    // AC-2: the terminal ok row is recoverable by invocation_id (running row had null id).
    const byInv = sink.byInvocation('inv_deferred');
    expect(byInv).toHaveLength(1);
    expect(byInv[0]?.tool_name).toBe('mx_await_result');
    expect(byInv[0]?.status).toBe('ok');

    // AC-2: the full session — both tool verbs — is recovered by correlation_id.
    const session = sink.byCorrelation('e2e_await_result');
    expect(session).toHaveLength(2);
    const verbs = session.map((r) => r.tool_name).sort();
    expect(verbs).toEqual(['mx_await_result', 'mx_run_command']);

    // The two rows have distinct dedup_keys (different call_id × different status × different inv).
    expect(session[0]?.dedup_key).not.toBe(session[1]?.dedup_key);
  });

  it('AC-2: direct policy_denied (1-row) vs approval-gate denied (2-row) — distinct audit trails', async () => {
    // Pins the audit-trail depth difference between two denial paths:
    //   a) Policy rejects the call immediately → denied('policy_denied') → 1 row, no approval link.
    //   b) Operator approval gate → awaiting_approval → denied('approval_denied') → 2 rows, first has approval link.
    const sink = new InMemoryAuditSink();
    const tap = withAudit(sink, { correlation_id: 'e2e_denial_paths' });

    // Path (a): direct policy denial — no awaiting_approval step.
    await tap(
      denied('policy_denied', 'command blocked by policy', ref('inv_policy')),
      { tool_name: 'mx_run_command', call_id: 'c_policy' },
    );

    // Path (b): approval gate — awaiting_approval then denied by operator.
    await tap(
      awaitingApproval('h_op', APPROVAL, ref('inv_op')),
      { tool_name: 'mx_run_command', call_id: 'c_op', idempotency_key: 'idk_op' },
    );
    await tap(
      denied('approval_denied', 'operator rejected', ref('inv_op')),
      { tool_name: 'mx_run_command', call_id: 'c_op' },
    );

    // Path (a): 1 row for inv_policy; no approval_request_id.
    const directDenial = sink.byInvocation('inv_policy');
    expect(directDenial).toHaveLength(1);
    expect(directDenial[0]?.status).toBe('denied');
    expect(directDenial[0]?.error_code).toBe('policy_denied');
    expect(directDenial[0]?.approval_request_id).toBeNull();

    // Path (b): 2 rows for inv_op; approval link on awaiting_approval row only.
    const gatedDenial = sink.byInvocation('inv_op');
    expect(gatedDenial).toHaveLength(2);
    const awaitingRow = gatedDenial.find((r) => r.status === 'awaiting_approval');
    const deniedRow = gatedDenial.find((r) => r.status === 'denied');
    expect(awaitingRow?.approval_request_id).toBe('apr_guard');
    expect(awaitingRow?.idempotency_key).toBe('idk_op');
    expect(deniedRow?.error_code).toBe('approval_denied');
    expect(deniedRow?.approval_request_id).toBeNull();

    // Full session: 3 total rows (1 direct + 2 gated).
    expect(sink.byCorrelation('e2e_denial_paths')).toHaveLength(3);
  });

  it('two concurrent sessions interleaved do not contaminate each other', async () => {
    const sink = new InMemoryAuditSink();
    const tapA = withAudit(sink, { correlation_id: 'session_A' });
    const tapB = withAudit(sink, { correlation_id: 'session_B' });

    // Interleave emissions from both sessions on the same sink.
    await tapA(ok({}, ref('inv_A1')), { tool_name: 'mx_delegate_tool', call_id: 'a1' });
    await tapB(ok({}, ref('inv_B1')), { tool_name: 'mx_run_command',   call_id: 'b1' });
    await tapA(errored('timeout', 'slow', ref('inv_A2')), { tool_name: 'mx_delegate_tool', call_id: 'a2' });
    await tapB(denied('policy_denied', 'blocked', ref('inv_B2')), { tool_name: 'mx_run_command', call_id: 'b2' });

    expect(sink.count).toBe(4);

    const rowsA = sink.byCorrelation('session_A');
    const rowsB = sink.byCorrelation('session_B');
    expect(rowsA).toHaveLength(2);
    expect(rowsB).toHaveLength(2);
    expect(rowsA.every((r) => r.correlation_id === 'session_A')).toBe(true);
    expect(rowsB.every((r) => r.correlation_id === 'session_B')).toBe(true);
  });
});

// ─── Best-effort: sink failures never block the session ───────────────────────

describe('best-effort: transient sink failures do not abort the session', () => {
  it('a fault on call 2-of-3 is swallowed; calls 1 and 3 pass through unchanged', async () => {
    let callCount = 0;
    const faultySink: AuditSink = {
      async record() {
        callCount++;
        if (callCount === 2) throw new Error('transient db write failure');
      },
    };
    const logged: string[] = [];
    const tap = withAudit(faultySink, { correlation_id: 'e2e_fault' }, (_err, dedupKey) => logged.push(dedupKey));

    const r1 = await tap(ok({ a: 1 }, ref('inv_1')), { tool_name: 'mx_delegate_tool', call_id: 'c1' });
    const r2 = await tap(ok({ b: 2 }, ref('inv_2')), { tool_name: 'mx_delegate_tool', call_id: 'c2' }); // faults here
    const r3 = await tap(ok({ c: 3 }, ref('inv_3')), { tool_name: 'mx_delegate_tool', call_id: 'c3' });

    // All three envelopes are returned unchanged (pass-through invariant).
    expect(r1).toMatchObject({ status: 'ok' });
    expect(r2).toMatchObject({ status: 'ok' });
    expect(r3).toMatchObject({ status: 'ok' });

    // The fault was logged (secret-free) exactly once and not rethrown.
    expect(logged).toHaveLength(1);
    expect(logged[0]).toBe('c2:ok:inv_2');

    // All three sink.record calls were attempted (3 calls issued, one faulted).
    expect(callCount).toBe(3);
  });

  it('NullAuditSink passes every envelope through unchanged across a full session', async () => {
    const { NullAuditSink } = await import('../src/index.js');
    const sink = new NullAuditSink();
    const tap = withAudit(sink, { correlation_id: 'e2e_null' });

    const envelopes = await Promise.all([
      tap(ok({}, NULL_REF),                                  { tool_name: 'mx_find_agents',   call_id: 'n1' }),
      tap(running('h', ref('inv_1')),                        { tool_name: 'mx_run_command',   call_id: 'n2' }),
      tap(awaitingApproval('h', APPROVAL, ref('inv_2')),    { tool_name: 'mx_run_command',   call_id: 'n3' }),
      tap(denied('policy_denied', 'blocked', ref('inv_3')), { tool_name: 'mx_run_command',   call_id: 'n4' }),
      tap(errored('timeout', 'slow', ref('inv_4')),         { tool_name: 'mx_delegate_tool', call_id: 'n5' }),
    ]);

    expect(envelopes.map((e) => e.status)).toEqual([
      'ok', 'running', 'awaiting_approval', 'denied', 'error',
    ]);
  });
});
