/**
 * Unit tests for the heartbeat loop (T005). All tests use an injected fake
 * scheduler so ticks are triggered synchronously — no real timers, no waits.
 * Mirrors the inject-the-timer discipline used by retry.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { startHeartbeat } from '../src/heartbeat.js';
import type { HeartbeatSchedule } from '../src/heartbeat.js';
import { TransportError } from '../src/transport.js';

// ---------------------------------------------------------------------------
// Fake scheduler
// ---------------------------------------------------------------------------

/**
 * Returns a fake scheduler and a `fire()` helper that triggers the scheduled
 * function synchronously. The scheduler records the configured interval.
 */
function makeFakeSchedule(): {
  schedule: HeartbeatSchedule;
  fire: () => void;
  isStopped: () => boolean;
  capturedMs: () => number;
} {
  let fn: (() => void) | null = null;
  let stopped = false;
  let ms = 0;

  const schedule: HeartbeatSchedule = (f, intervalMs) => {
    fn = f;
    ms = intervalMs;
    return {
      stop: () => {
        stopped = true;
        fn = null;
      },
    };
  };

  return {
    schedule,
    fire: () => {
      if (fn) fn();
    },
    isStopped: () => stopped,
    capturedMs: () => ms,
  };
}

/**
 * Flush pending microtasks by yielding N times. Each `await Promise.resolve()`
 * interleaves one flush step with one pending microtask from the chain, so N
 * iterations drain N chain steps. The heartbeat chain is:
 *   tick() → .then(onTick) → .catch() → .finally(inFlight=false)
 * That's 3 steps for a simple tick. The session heartbeat adds 2 more `await`
 * steps (session.call → client.call), for a total of ~5. Use 10 for margin.
 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startHeartbeat — scheduling', () => {
  it('registers the callback at the configured interval', () => {
    const { schedule, capturedMs } = makeFakeSchedule();
    startHeartbeat({ intervalMs: 30_000, tick: async () => {}, schedule });
    expect(capturedMs()).toBe(30_000);
  });

  it('does not fire a tick on its own before the scheduler triggers', () => {
    let tickCount = 0;
    const { schedule } = makeFakeSchedule();
    startHeartbeat({ intervalMs: 15_000, tick: async () => { tickCount++; }, schedule });
    // no fire() called
    expect(tickCount).toBe(0);
  });

  it('fires the tick when the scheduler triggers', async () => {
    let tickCount = 0;
    const { schedule, fire } = makeFakeSchedule();
    startHeartbeat({ intervalMs: 15_000, tick: async () => { tickCount++; }, schedule });
    fire();
    await flush();
    expect(tickCount).toBe(1);
  });

  it('fires multiple ticks on multiple scheduler triggers', async () => {
    let tickCount = 0;
    const { schedule, fire } = makeFakeSchedule();
    startHeartbeat({ intervalMs: 15_000, tick: async () => { tickCount++; }, schedule });
    fire();
    await flush();
    fire();
    await flush();
    fire();
    await flush();
    expect(tickCount).toBe(3);
  });
});

describe('startHeartbeat — stop()', () => {
  it('stop() cancels the scheduler', () => {
    const { schedule, isStopped } = makeFakeSchedule();
    const handle = startHeartbeat({ intervalMs: 15_000, tick: async () => {}, schedule });
    expect(isStopped()).toBe(false);
    handle.stop();
    expect(isStopped()).toBe(true);
  });

  it('no tick fires after stop()', async () => {
    let tickCount = 0;
    const { schedule, fire } = makeFakeSchedule();
    const handle = startHeartbeat({ intervalMs: 15_000, tick: async () => { tickCount++; }, schedule });
    handle.stop();
    fire();
    await flush();
    expect(tickCount).toBe(0);
  });

  it('stop() is idempotent — double-stop is safe', () => {
    const { schedule } = makeFakeSchedule();
    const handle = startHeartbeat({ intervalMs: 15_000, tick: async () => {}, schedule });
    expect(() => {
      handle.stop();
      handle.stop();
    }).not.toThrow();
  });

  it("onTick is NOT called after stop() — even if the scheduler fires late", async () => {
    const outcomes: Array<'ok' | { code: string }> = [];
    const { schedule, fire } = makeFakeSchedule();
    const handle = startHeartbeat({
      intervalMs: 15_000,
      tick: async () => {},
      schedule,
      onTick: (o) => outcomes.push(o),
    });
    handle.stop();
    fire(); // late scheduler fire after stop
    await flush();
    expect(outcomes).toHaveLength(0);
  });
});

describe('startHeartbeat — onTick outcomes', () => {
  it("calls onTick('ok') on a successful tick", async () => {
    const outcomes: Array<'ok' | { code: string }> = [];
    const { schedule, fire } = makeFakeSchedule();
    startHeartbeat({
      intervalMs: 15_000,
      tick: async () => {},
      schedule,
      onTick: (o) => outcomes.push(o),
    });
    fire();
    await flush();
    expect(outcomes).toEqual(['ok']);
  });

  it("calls onTick({ code }) on a TransportError tick failure", async () => {
    const outcomes: Array<'ok' | { code: string }> = [];
    const { schedule, fire } = makeFakeSchedule();
    startHeartbeat({
      intervalMs: 15_000,
      tick: async () => { throw new TransportError('timeout', 'heartbeat timeout'); },
      schedule,
      onTick: (o) => outcomes.push(o),
    });
    fire();
    await flush();
    expect(outcomes).toEqual([{ code: 'timeout' }]);
  });

  it("maps an unknown (non-TransportError) tick failure to code 'internal'", async () => {
    const outcomes: Array<'ok' | { code: string }> = [];
    const { schedule, fire } = makeFakeSchedule();
    startHeartbeat({
      intervalMs: 15_000,
      tick: async () => { throw new Error('unexpected non-transport error'); },
      schedule,
      onTick: (o) => outcomes.push(o),
    });
    fire();
    await flush();
    expect(outcomes).toEqual([{ code: 'internal' }]);
  });

  it('each TransportError code is surfaced as-is (connect_failed, rpc, closed)', async () => {
    for (const code of ['connect_failed', 'rpc', 'closed'] as const) {
      const outcomes: Array<'ok' | { code: string }> = [];
      const { schedule, fire } = makeFakeSchedule();
      startHeartbeat({
        intervalMs: 15_000,
        tick: async () => { throw new TransportError(code, `fake ${code}`); },
        schedule,
        onTick: (o) => outcomes.push(o),
      });
      fire();
      await flush();
      expect(outcomes).toEqual([{ code }]);
    }
  });

  it('each remaining TransportError code is surfaced as-is (not_running, timeout, frame, protocol, invalid_args)', async () => {
    for (const code of ['not_running', 'timeout', 'frame', 'protocol', 'invalid_args'] as const) {
      const outcomes: Array<'ok' | { code: string }> = [];
      const { schedule, fire } = makeFakeSchedule();
      startHeartbeat({
        intervalMs: 15_000,
        tick: async () => { throw new TransportError(code, `fake ${code}`); },
        schedule,
        onTick: (o) => outcomes.push(o),
      });
      fire();
      await flush();
      expect(outcomes).toEqual([{ code }]);
    }
  });
});

describe('startHeartbeat — failure tolerance', () => {
  it('a failing tick does not throw or cause an unhandled rejection', async () => {
    const { schedule, fire } = makeFakeSchedule();
    // No `onTick` configured; failure must be fully swallowed.
    startHeartbeat({
      intervalMs: 15_000,
      tick: async () => { throw new TransportError('timeout', 'transient'); },
      schedule,
    });
    // If this throws or produces an unhandled rejection, vitest will fail the test.
    fire();
    await flush();
  });

  it('the loop continues after a failing tick — subsequent ticks still fire', async () => {
    let tickCount = 0;
    const outcomes: Array<'ok' | { code: string }> = [];
    const { schedule, fire } = makeFakeSchedule();
    startHeartbeat({
      intervalMs: 15_000,
      tick: async () => {
        tickCount++;
        if (tickCount === 1) throw new TransportError('timeout', 'transient miss');
      },
      schedule,
      onTick: (o) => outcomes.push(o),
    });
    // First tick fails
    fire();
    await flush();
    expect(outcomes).toEqual([{ code: 'timeout' }]);
    // Second tick succeeds
    fire();
    await flush();
    expect(outcomes).toEqual([{ code: 'timeout' }, 'ok']);
    expect(tickCount).toBe(2);
  });
});

describe('startHeartbeat — overlapping-tick suppression', () => {
  it('a second scheduler fire while a tick is in-flight is suppressed (no re-entry)', async () => {
    let resolveFirst!: () => void;
    let tickCount = 0;
    const firstSettles = new Promise<void>((r) => { resolveFirst = r; });

    const { schedule, fire } = makeFakeSchedule();
    startHeartbeat({
      intervalMs: 15_000,
      tick: async () => {
        tickCount++;
        if (tickCount === 1) await firstSettles; // first tick hangs
      },
      schedule,
    });

    // Fire the first tick — it starts but does not finish
    fire();
    await flush();
    expect(tickCount).toBe(1);

    // Fire while still in-flight — must be suppressed
    fire();
    await flush();
    expect(tickCount).toBe(1); // still 1, second fire was dropped

    // Resolve the first tick, then a fresh fire should work
    resolveFirst();
    await flush();
    fire();
    await flush();
    expect(tickCount).toBe(2);
  });

  it('inFlight is cleared after a failed tick — next fire runs', async () => {
    let tickCount = 0;
    const { schedule, fire } = makeFakeSchedule();
    startHeartbeat({
      intervalMs: 15_000,
      tick: async () => {
        tickCount++;
        if (tickCount === 1) throw new TransportError('timeout', 'fail first');
      },
      schedule,
    });
    fire();
    await flush();
    // inFlight should be false again after rejection
    fire();
    await flush();
    expect(tickCount).toBe(2);
  });
});
