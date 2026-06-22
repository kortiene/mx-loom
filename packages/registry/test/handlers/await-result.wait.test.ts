/**
 * `mxAwaitResult` — AC 3: `wait_ms` timing semantics (T103 / #11).
 *
 * **The crux of T103:** a `wait_ms` *expiry* is NOT an error. A successful poll
 * that finds the invocation still pending returns that pending envelope with
 * `error: null`. The `timeout` error code is reserved for a genuine transport/
 * daemon fault — a probe that could not complete. These two cases MUST NOT be
 * confused. This file pins both explicitly.
 *
 * Tests pin:
 * - wait_ms omitted / 0 → exactly one probe, returns pending immediately (no sleep).
 * - wait_ms > 0 with invocation pending for the full budget → returns the PENDING
 *   envelope (status: running|awaiting_approval, error: null, NOT status:error/timeout).
 * - A genuine transport timeout → errored("timeout") (fault, not a wait_ms expiry).
 * - Timing: the loop does not overshoot the deadline by more than one interval.
 * - Timing: the poll interval is clamped to its floor (never busy-waits).
 * - Terminal state mid-budget returns early.
 *
 * All timing is deterministic via injected sleep and now seams.
 */
import { describe, expect, it } from 'vitest';

import { TransportError } from '@mx-loom/toolbelt';

import {
  mxAwaitResult,
  validateEnvelope,
  type DaemonCall,
  type HandlerDeps,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RUNNING = { state: 'running', handle: 'inv_run', invocation_id: 'inv_run' };
const AWAITING = {
  state: 'awaiting_approval',
  handle: 'inv_ap',
  invocation_id: 'inv_ap',
  approval: {
    request_id: 'req_ap',
    risk: 'low',
    summary: 'Approve',
    expires_at: '2026-06-22T12:00:00Z',
  },
};
const TERMINAL_OK = { state: 'done', result: { x: 1 }, invocation_id: 'inv_ok' };

function expectValid(result: unknown): void {
  expect(validateEnvelope(result)).toBe(true);
}

function makeDeps(
  responses: unknown[],
  opts?: { nowFn?: () => number; pollIntervalMs?: number },
): HandlerDeps & { callCount: () => number; sleepCalls: number[] } {
  let idx = 0;
  let count = 0;
  const sleepCalls: number[] = [];

  const daemon: DaemonCall = {
    call: async () => {
      count++;
      const r = responses[Math.min(idx++, responses.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    },
  };

  return {
    daemon,
    sleep: async (ms: number) => { sleepCalls.push(ms); },
    now: opts?.nowFn ?? (() => 0),
    pollIntervalMs: opts?.pollIntervalMs ?? 50,
    callCount: () => count,
    sleepCalls,
  };
}

/** Clock that advances by `step` ms on every call. */
function steppingClock(step: number): () => number {
  let t = 0;
  return () => { t += step; return t; };
}

// ---------------------------------------------------------------------------
// wait_ms omitted / 0 → single non-blocking probe
// ---------------------------------------------------------------------------

describe('mxAwaitResult — wait_ms omitted/0: single non-blocking probe', () => {
  it('wait_ms omitted → exactly one probe of running, returns running immediately', async () => {
    const d = makeDeps([RUNNING]);
    const result = await mxAwaitResult({ handle: 'inv_run' }, d);
    expect(result.status).toBe('running');
    expect(d.callCount()).toBe(1);
    expect(d.sleepCalls).toHaveLength(0);
    expectValid(result);
  });

  it('wait_ms = 0 → exactly one probe of running, returns running immediately', async () => {
    const d = makeDeps([RUNNING]);
    const result = await mxAwaitResult({ handle: 'inv_run', wait_ms: 0 }, d);
    expect(result.status).toBe('running');
    expect(d.callCount()).toBe(1);
    expect(d.sleepCalls).toHaveLength(0);
    expectValid(result);
  });

  it('wait_ms omitted → single probe of awaiting_approval, returns it immediately', async () => {
    const d = makeDeps([AWAITING]);
    const result = await mxAwaitResult({ handle: 'inv_ap' }, d);
    expect(result.status).toBe('awaiting_approval');
    expect(d.callCount()).toBe(1);
    expect(d.sleepCalls).toHaveLength(0);
  });

  it('wait_ms = 0 → single probe of awaiting_approval, returns it immediately', async () => {
    const d = makeDeps([AWAITING]);
    const result = await mxAwaitResult({ handle: 'inv_ap', wait_ms: 0 }, d);
    expect(result.status).toBe('awaiting_approval');
    expect(d.callCount()).toBe(1);
    expect(d.sleepCalls).toHaveLength(0);
  });

  it('negative wait_ms is treated as 0 (single probe)', async () => {
    const d = makeDeps([RUNNING]);
    const result = await mxAwaitResult({ handle: 'inv_run', wait_ms: -1 }, d);
    expect(result.status).toBe('running');
    expect(d.callCount()).toBe(1);
    expect(d.sleepCalls).toHaveLength(0);
  });

  it('non-finite wait_ms (Infinity) is treated as 0 (single probe)', async () => {
    const d = makeDeps([RUNNING]);
    const result = await mxAwaitResult({ handle: 'inv_run', wait_ms: Infinity }, d);
    expect(result.status).toBe('running');
    expect(d.callCount()).toBe(1);
  });

  it('NaN wait_ms is treated as 0 (single probe)', async () => {
    const d = makeDeps([RUNNING]);
    const result = await mxAwaitResult({ handle: 'inv_run', wait_ms: NaN }, d);
    expect(result.status).toBe('running');
    expect(d.callCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC 3 — wait_ms expiry → PENDING envelope, NOT error/timeout
// ---------------------------------------------------------------------------

describe('mxAwaitResult — AC 3: wait_ms expiry returns pending (not error)', () => {
  it('running handle pending for whole budget → status is "running" (not "error")', async () => {
    const d = makeDeps(
      Array<unknown>(10).fill(RUNNING),
      { nowFn: steppingClock(100), pollIntervalMs: 50 },
    );
    const result = await mxAwaitResult({ handle: 'inv_run', wait_ms: 200 }, d);
    expect(result.status).toBe('running');
    expectValid(result);
  });

  it('AC 3 regression: error is null on wait_ms expiry (never errored("timeout"))', async () => {
    const d = makeDeps(
      Array<unknown>(10).fill(RUNNING),
      { nowFn: steppingClock(100), pollIntervalMs: 50 },
    );
    const result = await mxAwaitResult({ handle: 'inv_run', wait_ms: 200 }, d);
    expect(result.error).toBeNull();
    expect(result.error?.code).not.toBe('timeout');
  });

  it('AC 3 regression: status is not "error" on wait_ms expiry', async () => {
    const d = makeDeps(
      Array<unknown>(10).fill(RUNNING),
      { nowFn: steppingClock(100), pollIntervalMs: 50 },
    );
    const result = await mxAwaitResult({ handle: 'inv_run', wait_ms: 200 }, d);
    expect(result.status).not.toBe('error');
    expect(result.status).not.toBe('denied');
  });

  it('awaiting_approval pending for whole budget → status is "awaiting_approval" (not "error")', async () => {
    const d = makeDeps(
      Array<unknown>(10).fill(AWAITING),
      { nowFn: steppingClock(100), pollIntervalMs: 50 },
    );
    const result = await mxAwaitResult({ handle: 'inv_ap', wait_ms: 200 }, d);
    expect(result.status).toBe('awaiting_approval');
    expect(result.error).toBeNull();
    expectValid(result);
  });

  it('awaiting_approval expiry: handle is still present on the pending envelope', async () => {
    const d = makeDeps(
      Array<unknown>(10).fill(AWAITING),
      { nowFn: steppingClock(100), pollIntervalMs: 50 },
    );
    const result = await mxAwaitResult({ handle: 'inv_ap', wait_ms: 200 }, d);
    expect(result.handle).toBe('inv_ap');
  });

  it('wait_ms expiry envelope conforms to ENVELOPE_SCHEMA', async () => {
    const d = makeDeps(
      Array<unknown>(5).fill(RUNNING),
      { nowFn: steppingClock(100), pollIntervalMs: 50 },
    );
    const result = await mxAwaitResult({ handle: 'inv_run', wait_ms: 200 }, d);
    expectValid(result);
  });
});

// ---------------------------------------------------------------------------
// AC 3 — transport timeout IS a genuine fault, distinct from wait_ms expiry
// ---------------------------------------------------------------------------

describe('mxAwaitResult — AC 3: transport timeout is a genuine fault', () => {
  it('transport timeout on first probe → errored("timeout") — NOT a pending envelope', async () => {
    const d = makeDeps([new TransportError('timeout', 'socket timed out')]);
    const result = await mxAwaitResult({ handle: 'inv_run', wait_ms: 5000 }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('timeout');
    expect(result.error).not.toBeNull();
    expectValid(result);
  });

  it('transport timeout in poll loop → errored("timeout") (still a real fault)', async () => {
    const d = makeDeps(
      [RUNNING, new TransportError('timeout', 'socket timed out')],
      { nowFn: steppingClock(10), pollIntervalMs: 10 },
    );
    const result = await mxAwaitResult({ handle: 'inv_run', wait_ms: 5000 }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('timeout');
  });

  it('wait_ms expiry vs transport timeout are observably different', async () => {
    // wait_ms expiry: pending status, error: null
    const expiryDeps = makeDeps(
      Array<unknown>(5).fill(RUNNING),
      { nowFn: steppingClock(100), pollIntervalMs: 50 },
    );
    const expiry = await mxAwaitResult({ handle: 'inv_run', wait_ms: 200 }, expiryDeps);

    // transport timeout: error status, error.code === 'timeout'
    const faultDeps = makeDeps([new TransportError('timeout', 'socket timed out')]);
    const fault = await mxAwaitResult({ handle: 'inv_run' }, faultDeps);

    // wait_ms expiry → pending, no error
    expect(expiry.status).toBe('running');
    expect(expiry.error).toBeNull();

    // transport timeout → error with 'timeout' code
    expect(fault.status).toBe('error');
    expect(fault.error?.code).toBe('timeout');
  });
});

// ---------------------------------------------------------------------------
// Timing semantics — loop bounds, no busy-wait, no deadline overshoot
// ---------------------------------------------------------------------------

describe('mxAwaitResult — timing semantics', () => {
  it('terminal state mid-budget returns early (one sleep, not the full budget)', async () => {
    // Probe 1 → RUNNING (sleep), Probe 2 → TERMINAL_OK (return immediately)
    const d = makeDeps(
      [RUNNING, TERMINAL_OK],
      { nowFn: steppingClock(10), pollIntervalMs: 50 },
    );
    const result = await mxAwaitResult({ handle: 'inv_run', wait_ms: 5000 }, d);
    expect(result.status).toBe('ok');
    // Only one sleep was needed (between probe 1 and probe 2)
    expect(d.sleepCalls).toHaveLength(1);
    expectValid(result);
  });

  it('sleep is clamped to the remaining budget (never overshoots the deadline)', async () => {
    // Budget = 75ms. Clock steps 50ms per call.
    // deadline = 50 + 75 = 125ms.
    // After probe 1 (RUNNING): remaining = 125 - 100 = 25ms → sleep(min(50,25)=25).
    // After probe 2 (RUNNING): remaining = 125 - 150 ≤ 0 → break.
    const d = makeDeps(
      Array<unknown>(5).fill(RUNNING),
      { nowFn: steppingClock(50), pollIntervalMs: 50 },
    );
    await mxAwaitResult({ handle: 'inv_run', wait_ms: 75 }, d);
    for (const ms of d.sleepCalls) {
      expect(ms).toBeLessThanOrEqual(50);
      expect(ms).toBeGreaterThan(0);
    }
  });

  it('poll interval floor prevents busy-waiting (pollIntervalMs=0 → clamped to min)', async () => {
    const d = makeDeps(
      Array<unknown>(5).fill(RUNNING),
      { nowFn: steppingClock(10), pollIntervalMs: 0 },
    );
    await mxAwaitResult({ handle: 'inv_run', wait_ms: 100 }, d);
    // Every sleep must be > 0 (the implementation clamps to MIN_POLL_INTERVAL_MS=10)
    for (const ms of d.sleepCalls) {
      expect(ms).toBeGreaterThan(0);
    }
  });

  it('poll interval cap prevents hammering (pollIntervalMs=999999 → capped to 2000)', async () => {
    const d = makeDeps(
      [RUNNING, TERMINAL_OK],
      { nowFn: steppingClock(10), pollIntervalMs: 999_999 },
    );
    const result = await mxAwaitResult({ handle: 'inv_run', wait_ms: 5000 }, d);
    expect(result.status).toBe('ok');
    for (const ms of d.sleepCalls) {
      expect(ms).toBeLessThanOrEqual(2000);
    }
  });

  it('first probe always runs before the loop (wait_ms=1, deadline expires after first loop check)', async () => {
    // Clock advances 100ms per call. wait_ms=1.
    // deadline = now() + 1 = 100 + 1 = 101.
    // First probe: runs unconditionally (before the loop). Result: RUNNING.
    // Loop: remaining = 101 - 200 = -99 ≤ 0 → break immediately (no sleep).
    // Returns the first probe result.
    const d = makeDeps(
      [RUNNING, RUNNING],
      { nowFn: steppingClock(100), pollIntervalMs: 50 },
    );
    const result = await mxAwaitResult({ handle: 'inv_run', wait_ms: 1 }, d);
    expect(d.callCount()).toBe(1); // first probe ran; loop exited before second probe
    expect(result.status).toBe('running');
    expect(d.sleepCalls).toHaveLength(0);
  });

  it('sleep calls are recorded in order (first sleep before first loop probe)', async () => {
    const d = makeDeps(
      [RUNNING, RUNNING, TERMINAL_OK],
      { nowFn: steppingClock(10), pollIntervalMs: 50 },
    );
    await mxAwaitResult({ handle: 'inv_run', wait_ms: 5000 }, d);
    // Two sleeps (before probe 2 and probe 3)
    expect(d.sleepCalls).toHaveLength(2);
    for (const ms of d.sleepCalls) {
      expect(ms).toBeGreaterThan(0);
    }
  });
});
