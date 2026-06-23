/**
 * Hidden `mx_await_result` poll loop (T110 / #18) — `resolveDeferred`.
 *
 * Tests:
 *  - Terminal statuses (`ok`, `denied`, `error`) pass through unchanged; no
 *    daemon call is made.
 *  - `running` with a handle → the poll loop is driven via `mxAwaitResult`
 *    and the terminal envelope is returned in one logical tool call.
 *  - `running` that never settles within `resolveTimeoutMs` → the still-running
 *    envelope is returned; `error` is null and the code is never `timeout`
 *    (a `wait_ms` expiry is not an error per T103 AC 3 / T110 non-fabrication rule).
 *  - `awaiting_approval` passes through unchanged by **default** (the shim does not
 *    silently spin on a human).
 *  - `awaiting_approval` with `awaitApproval: true` polls until the operator
 *    decides and returns the terminal envelope.
 *  - A handle-less `running` / `awaiting_approval` (malformed) passes through.
 *
 * Uses the deterministic `sleep`/`now` seams so no real timer fires.
 */
import { describe, expect, it } from 'vitest';

import {
  awaitingApproval,
  denied,
  errored,
  ok,
  running,
} from '@mx-loom/registry';
import type { DaemonCall } from '@mx-loom/registry';

import { DEFAULT_RESOLVE_TIMEOUT_MS, resolveDeferred } from '../src/resolve.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const NULL_AUDIT_REF = Object.freeze({
  invocation_id: null,
  request_id: null,
  room: null,
  event_id: null,
});
const POPULATED_AUDIT_REF = Object.freeze({
  invocation_id: 'inv_test',
  request_id: 'req_test',
  room: '!test:server',
  event_id: '$evt_test',
});
const HANDLE = 'inv_test_001';

const APPROVAL_INFO = Object.freeze({
  request_id: 'req_appr',
  risk: 'high' as const,
  summary: 'run tests on backend-dev-01',
  expires_at: '2099-01-01T00:00:00Z',
});

/** A sleep that resolves immediately — no real timer fires. */
const noSleep = (): Promise<void> => Promise.resolve();

/**
 * A clock that returns `0` on the first call (setting the deadline) and a huge
 * value on every subsequent call — instantly advancing past any deadline.
 */
function fastForwardClock(): () => number {
  let calls = 0;
  return () => (calls++ === 0 ? 0 : 9_999_999);
}

/** A daemon whose `invocation.get` always returns the given raw response. */
function daemonReturning(raw: unknown): DaemonCall {
  return {
    call: async (method: string) => {
      if (method === 'invocation.get') return raw;
      throw new Error(`unexpected daemon method in resolve test: ${method}`);
    },
  };
}

/** A daemon that throws on any call — asserts the poll loop never fires. */
const neverCalledDaemon: DaemonCall = {
  call: () => Promise.reject(new Error('daemon must not be called for this terminal status')),
};

// ---------------------------------------------------------------------------
// Terminal statuses pass through unchanged
// ---------------------------------------------------------------------------

describe('terminal statuses pass through unchanged (no daemon call)', () => {
  it('ok passes through', async () => {
    const result = ok({ passed: true }, POPULATED_AUDIT_REF);
    const resolved = await resolveDeferred(result, neverCalledDaemon);
    expect(resolved).toBe(result);
  });

  it('denied passes through', async () => {
    const result = denied('policy_denied', 'denied by policy', POPULATED_AUDIT_REF);
    const resolved = await resolveDeferred(result, neverCalledDaemon);
    expect(resolved).toBe(result);
  });

  it('error passes through', async () => {
    const result = errored('internal', 'test error', POPULATED_AUDIT_REF);
    const resolved = await resolveDeferred(result, neverCalledDaemon);
    expect(resolved).toBe(result);
  });
});

// ---------------------------------------------------------------------------
// `running` → resolved to terminal (poll loop hidden)
// ---------------------------------------------------------------------------

describe('running → resolved to terminal (AC1 — poll loop hidden)', () => {
  it('a running result resolves to ok when the daemon returns ok on the first probe', async () => {
    const result = running(HANDLE, NULL_AUDIT_REF);
    const daemon = daemonReturning({ state: 'ok', result: { done: true } });

    const resolved = await resolveDeferred(result, daemon, {
      resolveTimeoutMs: 5_000,
      sleep: noSleep,
      now: () => 0,
      pollIntervalMs: 10,
    });

    expect(resolved.status).toBe('ok');
  });

  it('a running result resolves to denied when the daemon returns a denial', async () => {
    const result = running(HANDLE, NULL_AUDIT_REF);
    const daemon = daemonReturning({ state: 'policy_denied', ok: false });

    const resolved = await resolveDeferred(result, daemon, {
      resolveTimeoutMs: 5_000,
      sleep: noSleep,
      now: () => 0,
      pollIntervalMs: 10,
    });

    expect(resolved.status).toBe('denied');
  });

  it('a running result resolves to error when the daemon returns a fault', async () => {
    const result = running(HANDLE, NULL_AUDIT_REF);
    const daemon = daemonReturning({ state: 'error', ok: false });

    const resolved = await resolveDeferred(result, daemon, {
      resolveTimeoutMs: 5_000,
      sleep: noSleep,
      now: () => 0,
      pollIntervalMs: 10,
    });

    expect(resolved.status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// `running` timeout — returns running, never errored('timeout')
// ---------------------------------------------------------------------------

describe('running that times out — returns running (never fabricates timeout)', () => {
  it('returns the still-running envelope when the budget elapses', async () => {
    const result = running(HANDLE, NULL_AUDIT_REF);
    // Daemon always returns running — work never completes.
    const daemon = daemonReturning({ state: 'running', invocation_id: HANDLE });

    const resolved = await resolveDeferred(result, daemon, {
      resolveTimeoutMs: 100,
      sleep: noSleep,
      // Fast-forward clock: first call sets deadline, then we're immediately past it.
      now: fastForwardClock(),
      pollIntervalMs: 10,
    });

    expect(resolved.status).toBe('running');
  });

  it('a timed-out result has null error (not errored("timeout"))', async () => {
    const result = running(HANDLE, NULL_AUDIT_REF);
    const daemon = daemonReturning({ state: 'running', invocation_id: HANDLE });

    const resolved = await resolveDeferred(result, daemon, {
      resolveTimeoutMs: 100,
      sleep: noSleep,
      now: fastForwardClock(),
      pollIntervalMs: 10,
    });

    expect(resolved.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// `awaiting_approval` — default: pass through; opt-in: poll
// ---------------------------------------------------------------------------

describe('awaiting_approval default — passes through without polling', () => {
  it('passes through the awaiting_approval envelope unchanged by default', async () => {
    const result = awaitingApproval(HANDLE, APPROVAL_INFO, POPULATED_AUDIT_REF);
    const resolved = await resolveDeferred(result, neverCalledDaemon);
    expect(resolved.status).toBe('awaiting_approval');
  });

  it('the handle is preserved in the pass-through', async () => {
    const result = awaitingApproval(HANDLE, APPROVAL_INFO, POPULATED_AUDIT_REF);
    const resolved = await resolveDeferred(result, neverCalledDaemon);
    expect(resolved.handle).toBe(HANDLE);
  });

  it('the approval block is preserved in the pass-through', async () => {
    const result = awaitingApproval(HANDLE, APPROVAL_INFO, POPULATED_AUDIT_REF);
    const resolved = await resolveDeferred(result, neverCalledDaemon);
    expect(resolved.approval?.request_id).toBe('req_appr');
  });
});

describe('awaiting_approval with awaitApproval: true — polls to terminal', () => {
  it('resolves to ok when the daemon returns ok', async () => {
    const result = awaitingApproval(HANDLE, APPROVAL_INFO, NULL_AUDIT_REF);
    const daemon = daemonReturning({ state: 'ok', result: { passed: true } });

    const resolved = await resolveDeferred(result, daemon, {
      awaitApproval: true,
      resolveTimeoutMs: 5_000,
      sleep: noSleep,
      now: () => 0,
      pollIntervalMs: 10,
    });

    expect(resolved.status).toBe('ok');
  });

  it('resolves to denied when the operator denies', async () => {
    const result = awaitingApproval(HANDLE, APPROVAL_INFO, NULL_AUDIT_REF);
    const daemon = daemonReturning({ state: 'approval_denied', ok: false });

    const resolved = await resolveDeferred(result, daemon, {
      awaitApproval: true,
      resolveTimeoutMs: 5_000,
      sleep: noSleep,
      now: () => 0,
      pollIntervalMs: 10,
    });

    expect(resolved.status).toBe('denied');
  });

  it('returns awaiting_approval when the budget elapses before a decision', async () => {
    const result = awaitingApproval(HANDLE, APPROVAL_INFO, NULL_AUDIT_REF);
    // Daemon always returns awaiting_approval — operator never decides.
    const daemon = daemonReturning({
      state: 'awaiting_approval',
      invocation_id: HANDLE,
      approval: APPROVAL_INFO,
    });

    const resolved = await resolveDeferred(result, daemon, {
      awaitApproval: true,
      resolveTimeoutMs: 100,
      sleep: noSleep,
      now: fastForwardClock(),
      pollIntervalMs: 10,
    });

    expect(resolved.status).toBe('awaiting_approval');
    // No fabricated error.
    expect(resolved.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Handle-less pending envelopes pass through (defensive)
// ---------------------------------------------------------------------------

describe('handle-less pending envelopes pass through (malformed / defensive)', () => {
  it('a running result with a null handle passes through without polling', async () => {
    // Construct a malformed running envelope (no public constructor for null handle;
    // build it via the type cast to exercise the null-handle guard in resolveDeferred).
    const result = {
      status: 'running' as const,
      result: null,
      error: null,
      handle: null,
      approval: null,
      audit_ref: NULL_AUDIT_REF,
    };
    const resolved = await resolveDeferred(result, neverCalledDaemon);
    expect(resolved.status).toBe('running');
    expect(resolved.handle).toBeNull();
  });

  it('awaiting_approval with null handle passes through even when awaitApproval: true', async () => {
    // The handle guard must fire before the poll attempt so a handleless
    // awaiting_approval never triggers an invocation.get call even under awaitApproval.
    const result = {
      status: 'awaiting_approval' as const,
      result: null,
      error: null,
      handle: null,
      approval: APPROVAL_INFO,
      audit_ref: POPULATED_AUDIT_REF,
    };
    const resolved = await resolveDeferred(result, neverCalledDaemon, { awaitApproval: true });
    expect(resolved.status).toBe('awaiting_approval');
    expect(resolved.handle).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_RESOLVE_TIMEOUT_MS is a sensible value
// ---------------------------------------------------------------------------

describe('DEFAULT_RESOLVE_TIMEOUT_MS', () => {
  it('is a positive number (the default poll budget)', () => {
    expect(typeof DEFAULT_RESOLVE_TIMEOUT_MS).toBe('number');
    expect(DEFAULT_RESOLVE_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
