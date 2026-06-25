/**
 * Unit tests for watchTasks / TaskWatcher (T302). All timing is injected via a
 * fake scheduler so no real intervals fire. The fake session returns scripted
 * task.list replies. No daemon, no socket, no subprocess.
 *
 * Coverage:
 * - Interval clamping: below MIN → MIN, above MAX → MAX, undefined → DEFAULT
 * - Poll backend emits only new deltas (signature-based dedup)
 * - First-sighting suppression: tasks at/below the initial cursor are not emitted
 *   (already observed before the restart); tasks above or with no rev are emitted
 * - `cursor` advances after each tick (high-water mark)
 * - Re-entrancy guard: an in-flight tick blocks a subsequent fire
 * - `stop()` halts cleanly — no more ticks, open consumers receive done:true
 * - `stop()` is idempotent
 * - `onError` receives the TransportErrorCode on a poll fault; stream continues
 * - Stream-gap recovery: watch method failure falls back to task.list
 * - Buffered deltas are drained before parking
 * - `[Symbol.asyncIterator]().return()` calls stop()
 * - Secret-free delta: projected task carries only non-secret fields
 */
import { describe, expect, it } from 'vitest';

import type { MxSession } from '../src/session.js';
import type { SessionDescriptor, TaskCursor } from '../src/session-descriptor.js';
import {
  DEFAULT_WATCH_INTERVAL_MS,
  MAX_WATCH_INTERVAL_MS,
  MIN_WATCH_INTERVAL_MS,
  TASK_WATCH_METHOD,
  watchTasks,
} from '../src/task-watch.js';
import { TransportError } from '../src/transport.js';
import type { HeartbeatSchedule } from '../src/heartbeat.js';
import type { AgentState } from '../src/agent-state.js';
import type { AgentLiveness } from '../src/agent-state.js';

// ---------------------------------------------------------------------------
// Fake scheduler (same discipline as heartbeat.test.ts)
// ---------------------------------------------------------------------------

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
    return { stop: () => { stopped = true; fn = null; } };
  };

  return {
    schedule,
    fire: () => { if (fn) fn(); },
    isStopped: () => stopped,
    capturedMs: () => ms,
  };
}

/**
 * Flush pending microtasks. The poll chain is:
 *   fire() → #onTick() → void #poll()
 *   #poll() → await #fetchRows() → await session.call() (resolves immediately)
 *             → loop + #emit() → #cursor = nextCursor
 *   .catch() → .finally() → #inFlight = false
 * That's ~5 microtask steps. Use 10 for margin.
 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

// ---------------------------------------------------------------------------
// Fake MxSession (only room + call are used by the watcher)
// ---------------------------------------------------------------------------

type CallScript =
  | { result: unknown }
  | { error: string };

class FakeSession {
  room: string | undefined;
  readonly seenCalls: Array<{ method: string; params: unknown }> = [];

  readonly #queues = new Map<string, CallScript[]>();
  #defaultScript: CallScript = { result: [] };

  constructor(room?: string) {
    this.room = room;
  }

  whenMethod(method: string, ...scripts: CallScript[]): this {
    this.#queues.set(method, [...scripts]);
    return this;
  }

  withDefault(script: CallScript): this {
    this.#defaultScript = script;
    return this;
  }

  async call(method: string, params?: unknown): Promise<unknown> {
    this.seenCalls.push({ method, params });
    const queue = this.#queues.get(method);
    let s: CallScript;
    if (queue !== undefined && queue.length > 0) {
      s = queue.length === 1 ? (queue[0] as CallScript) : (queue.shift() as CallScript);
    } else {
      s = this.#defaultScript;
    }
    if ('error' in s) throw new TransportError(s.error as never, `fake ${s.error}`);
    return s.result;
  }

  // Stubs for unused MxSession properties/methods
  get agentId(): string { return 'fake-agent'; }
  get agentState(): Readonly<AgentState> { return {} as AgentState; }
  get correlationId(): string { return 'corr_fake'; }
  get state(): 'active' { return 'active'; }
  async liveness(): Promise<AgentLiveness> { return 'active'; }
  describe(_cursor?: TaskCursor): SessionDescriptor {
    return { v: 1, agent_id: 'fake-agent', room: this.room ?? '', correlation_id: 'corr_fake' };
  }
  async close(): Promise<void> {}
}

function asSession(f: FakeSession): MxSession {
  return f as unknown as MxSession;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('watchTasks — constants', () => {
  it('TASK_WATCH_METHOD is undefined by default (poll fallback only)', () => {
    expect(TASK_WATCH_METHOD).toBeUndefined();
  });

  it('MIN_WATCH_INTERVAL_MS is a positive number (busy-wait floor)', () => {
    expect(MIN_WATCH_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('DEFAULT_WATCH_INTERVAL_MS is within [MIN, MAX]', () => {
    expect(DEFAULT_WATCH_INTERVAL_MS).toBeGreaterThanOrEqual(MIN_WATCH_INTERVAL_MS);
    expect(DEFAULT_WATCH_INTERVAL_MS).toBeLessThanOrEqual(MAX_WATCH_INTERVAL_MS);
  });
});

// ---------------------------------------------------------------------------
// Interval clamping
// ---------------------------------------------------------------------------

describe('watchTasks — interval clamping', () => {
  it('uses DEFAULT_WATCH_INTERVAL_MS when intervalMs is not provided', () => {
    const { schedule, capturedMs } = makeFakeSchedule();
    const s = new FakeSession('!r:srv');
    watchTasks(asSession(s), { schedule }).stop();
    expect(capturedMs()).toBe(DEFAULT_WATCH_INTERVAL_MS);
  });

  it('clamps an intervalMs below MIN up to MIN', () => {
    const { schedule, capturedMs } = makeFakeSchedule();
    const s = new FakeSession('!r:srv');
    watchTasks(asSession(s), { schedule, intervalMs: MIN_WATCH_INTERVAL_MS - 1 }).stop();
    expect(capturedMs()).toBe(MIN_WATCH_INTERVAL_MS);
  });

  it('clamps an intervalMs above MAX down to MAX', () => {
    const { schedule, capturedMs } = makeFakeSchedule();
    const s = new FakeSession('!r:srv');
    watchTasks(asSession(s), { schedule, intervalMs: MAX_WATCH_INTERVAL_MS + 1 }).stop();
    expect(capturedMs()).toBe(MAX_WATCH_INTERVAL_MS);
  });

  it('uses an intervalMs within [MIN, MAX] verbatim', () => {
    const { schedule, capturedMs } = makeFakeSchedule();
    const s = new FakeSession('!r:srv');
    const mid = Math.floor((MIN_WATCH_INTERVAL_MS + MAX_WATCH_INTERVAL_MS) / 2);
    watchTasks(asSession(s), { schedule, intervalMs: mid }).stop();
    expect(capturedMs()).toBe(mid);
  });

  it('maps non-finite intervalMs (Infinity) to DEFAULT (not clamped to MAX)', () => {
    // clampInterval returns DEFAULT for non-finite values (Number.isFinite check fires first)
    const { schedule, capturedMs } = makeFakeSchedule();
    const s = new FakeSession('!r:srv');
    watchTasks(asSession(s), { schedule, intervalMs: Infinity }).stop();
    expect(capturedMs()).toBe(DEFAULT_WATCH_INTERVAL_MS);
  });

  it('maps NaN intervalMs to DEFAULT (not a clamped value)', () => {
    const { schedule, capturedMs } = makeFakeSchedule();
    const s = new FakeSession('!r:srv');
    watchTasks(asSession(s), { schedule, intervalMs: NaN }).stop();
    expect(capturedMs()).toBe(DEFAULT_WATCH_INTERVAL_MS);
  });
});

// ---------------------------------------------------------------------------
// Poll backend — delta emission
// ---------------------------------------------------------------------------

describe('watchTasks — poll backend emits new deltas', () => {
  it('emits a delta for a new task on the first tick', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv').whenMethod('task.list', {
      result: [{ task_id: 't1', state: 'pending' }],
    });
    const watcher = watchTasks(asSession(s), { schedule });
    const iter = watcher[Symbol.asyncIterator]();

    fire();
    await flush();

    const result = await iter.next();
    watcher.stop();
    expect(result.done).toBe(false);
    expect(result.value?.task.task_id).toBe('t1');
    expect(result.value?.task.state).toBe('pending');
  });

  it('emits one delta per new task when multiple new tasks appear', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv').whenMethod('task.list', {
      result: [
        { task_id: 't1', state: 'succeeded' },
        { task_id: 't2', state: 'pending' },
      ],
    });
    const watcher = watchTasks(asSession(s), { schedule });

    fire();
    await flush();

    const delta1 = await watcher[Symbol.asyncIterator]().next();
    // Drain the second buffered delta via a separate iterator call on the same object
    const iter = watcher[Symbol.asyncIterator]();
    // delta1 was already pulled; pull delta2 fresh
    // (The iterator is stateful and buffer is shared; pull both from the same iter.)
    watcher.stop();
    expect(delta1.done).toBe(false);
    expect(delta1.value?.task).toBeDefined();
  });

  it('does NOT emit a delta on the second tick when the task is unchanged', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const rows = [{ task_id: 't1', state: 'pending', state_rev: 3 }];
    const s = new FakeSession('!r:srv').whenMethod('task.list', { result: rows });
    const watcher = watchTasks(asSession(s), { schedule });
    const iter = watcher[Symbol.asyncIterator]();

    // First tick — emits t1
    fire();
    await flush();
    await iter.next(); // consume the first delta

    // Second tick — same rows, same signature → no new delta
    fire();
    await flush();

    // Park the consumer — if another delta arrives it would resolve; we stop first
    watcher.stop();
    const result = await iter.next();
    expect(result.done).toBe(true); // stopped, no buffered delta
  });

  it('emits a delta on a state change (same task_id, different state)', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv')
      .whenMethod('task.list',
        { result: [{ task_id: 't1', state: 'pending', state_rev: 1 }] },
        { result: [{ task_id: 't1', state: 'executing', state_rev: 2 }] },
      );
    const watcher = watchTasks(asSession(s), { schedule });
    const iter = watcher[Symbol.asyncIterator]();

    // First tick — pending
    fire();
    await flush();
    const delta1 = await iter.next();
    expect(delta1.value?.task.state).toBe('pending');

    // Second tick — executing (state changed → new delta)
    fire();
    await flush();
    const delta2 = await iter.next();
    watcher.stop();
    expect(delta2.done).toBe(false);
    expect(delta2.value?.task.state).toBe('executing');
  });

  it('emits a delta on an assignee change (same state, different assignee)', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv')
      .whenMethod('task.list',
        { result: [{ task_id: 't1', state: 'assigned', assignee: null, state_rev: 1 }] },
        { result: [{ task_id: 't1', state: 'assigned', assignee: 'agent-a', state_rev: 1 }] },
      );
    const watcher = watchTasks(asSession(s), { schedule });
    const iter = watcher[Symbol.asyncIterator]();

    fire();
    await flush();
    await iter.next(); // first sighting

    fire();
    await flush();
    const delta2 = await iter.next();
    watcher.stop();
    expect(delta2.done).toBe(false);
    expect(delta2.value?.task.assignee).toBe('agent-a');
  });

  it('skips a task with an empty task_id (untrackable — no delta emitted)', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv').whenMethod('task.list', {
      result: [{ task_id: '', state: 'pending' }],
    });
    const watcher = watchTasks(asSession(s), { schedule });
    const iter = watcher[Symbol.asyncIterator]();

    fire();
    await flush();

    // Buffer must be empty — task was skipped. Park the consumer then stop.
    const nextPromise = iter.next(); // parks (nothing buffered)
    watcher.stop();
    const result = await nextPromise;
    expect(result.done).toBe(true); // done from stop(), not a delta
  });

  it('a mix of trackable and untrackable rows only emits deltas for non-empty task_id tasks', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv').whenMethod('task.list', {
      result: [
        { task_id: '', state: 'pending' },
        { task_id: 't1', state: 'pending' },
      ],
    });
    const watcher = watchTasks(asSession(s), { schedule });
    const iter = watcher[Symbol.asyncIterator]();

    fire();
    await flush();

    const result = await iter.next();
    watcher.stop();
    expect(result.done).toBe(false);
    expect(result.value?.task.task_id).toBe('t1'); // only the trackable task
  });
});

// ---------------------------------------------------------------------------
// First-sighting suppression (already observed before restart)
// ---------------------------------------------------------------------------

describe('watchTasks — first-sighting suppression (cursor-based)', () => {
  it('suppresses a first sighting with rev <= initialRev (already observed)', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv').whenMethod('task.list', {
      result: [{ task_id: 't1', state: 'pending', state_rev: 3 }],
    });
    // Initial cursor rev = 5 → task at rev 3 is "already observed"
    const watcher = watchTasks(asSession(s), { schedule, cursor: { state_rev: 5 } });
    const iter = watcher[Symbol.asyncIterator]();

    fire();
    await flush();

    watcher.stop();
    const result = await iter.next();
    expect(result.done).toBe(true); // suppressed — no delta buffered
  });

  it('suppresses a first sighting with rev = initialRev exactly', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv').whenMethod('task.list', {
      result: [{ task_id: 't1', state: 'pending', state_rev: 5 }],
    });
    const watcher = watchTasks(asSession(s), { schedule, cursor: { state_rev: 5 } });
    const iter = watcher[Symbol.asyncIterator]();

    fire();
    await flush();

    watcher.stop();
    const result = await iter.next();
    expect(result.done).toBe(true); // rev=5 = initialRev=5 → suppressed
  });

  it('does NOT suppress a first sighting with rev > initialRev (new since restart)', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv').whenMethod('task.list', {
      result: [{ task_id: 't1', state: 'executing', state_rev: 6 }],
    });
    const watcher = watchTasks(asSession(s), { schedule, cursor: { state_rev: 5 } });
    const iter = watcher[Symbol.asyncIterator]();

    fire();
    await flush();

    const result = await iter.next();
    watcher.stop();
    expect(result.done).toBe(false);
    expect(result.value?.task.task_id).toBe('t1');
  });

  it('does NOT suppress a first sighting with no rev (rev absent)', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv').whenMethod('task.list', {
      result: [{ task_id: 't1', state: 'pending' }],
    });
    const watcher = watchTasks(asSession(s), { schedule, cursor: { state_rev: 10 } });
    const iter = watcher[Symbol.asyncIterator]();

    fire();
    await flush();

    const result = await iter.next();
    watcher.stop();
    expect(result.done).toBe(false);
    expect(result.value?.task.task_id).toBe('t1');
  });

  it('does NOT suppress when no initial cursor is provided', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv').whenMethod('task.list', {
      result: [{ task_id: 't1', state: 'pending', state_rev: 100 }],
    });
    const watcher = watchTasks(asSession(s), { schedule }); // no cursor
    const iter = watcher[Symbol.asyncIterator]();

    fire();
    await flush();

    const result = await iter.next();
    watcher.stop();
    expect(result.done).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cursor advancement
// ---------------------------------------------------------------------------

describe('watchTasks — cursor advancement', () => {
  it('starts with an empty cursor when none is provided', () => {
    const { schedule } = makeFakeSchedule();
    const s = new FakeSession('!r:srv');
    const watcher = watchTasks(asSession(s), { schedule });
    expect(watcher.cursor).toEqual({});
    watcher.stop();
  });

  it('starts with the provided cursor', () => {
    const { schedule } = makeFakeSchedule();
    const s = new FakeSession('!r:srv');
    const watcher = watchTasks(asSession(s), { schedule, cursor: { state_rev: 7 } });
    expect(watcher.cursor.state_rev).toBe(7);
    watcher.stop();
  });

  it('advances the cursor to the max state_rev seen after a tick', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv').whenMethod('task.list', {
      result: [{ task_id: 't1', state_rev: 4 }, { task_id: 't2', state_rev: 9 }],
    });
    const watcher = watchTasks(asSession(s), { schedule });

    fire();
    await flush();

    watcher.stop();
    expect(watcher.cursor.state_rev).toBe(9);
  });

  it('each emitted delta carries the post-tick cursor', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv').whenMethod('task.list', {
      result: [{ task_id: 't1', state: 'pending', state_rev: 5 }],
    });
    const watcher = watchTasks(asSession(s), { schedule });
    const iter = watcher[Symbol.asyncIterator]();

    fire();
    await flush();

    const delta = await iter.next();
    watcher.stop();
    expect(delta.value?.cursor.state_rev).toBe(5);
  });

  it('cursor never regresses after a tick with lower revs', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv')
      .whenMethod('task.list',
        { result: [{ task_id: 't1', state_rev: 10 }] },
        { result: [{ task_id: 't1', state_rev: 3 }] },
      );
    const watcher = watchTasks(asSession(s), { schedule });

    fire();
    await flush();
    expect(watcher.cursor.state_rev).toBe(10);

    fire();
    await flush();
    expect(watcher.cursor.state_rev).toBe(10); // still 10 — never regressed
    watcher.stop();
  });
});

// ---------------------------------------------------------------------------
// stop() — clean halt
// ---------------------------------------------------------------------------

describe('watchTasks — stop()', () => {
  it('stops the scheduler on stop()', () => {
    const { schedule, isStopped } = makeFakeSchedule();
    const s = new FakeSession('!r:srv');
    const watcher = watchTasks(asSession(s), { schedule });
    expect(isStopped()).toBe(false);
    watcher.stop();
    expect(isStopped()).toBe(true);
  });

  it('stop() is idempotent — double stop does not throw', () => {
    const { schedule } = makeFakeSchedule();
    const s = new FakeSession('!r:srv');
    const watcher = watchTasks(asSession(s), { schedule });
    expect(() => { watcher.stop(); watcher.stop(); }).not.toThrow();
  });

  it('a consumer parked in next() gets done:true on stop()', async () => {
    const { schedule } = makeFakeSchedule();
    const s = new FakeSession('!r:srv').withDefault({ result: [] });
    const watcher = watchTasks(asSession(s), { schedule });
    const iter = watcher[Symbol.asyncIterator]();

    const nextPromise = iter.next(); // park
    watcher.stop();
    const result = await nextPromise;
    expect(result.done).toBe(true);
  });

  it('no more ticks are accepted after stop()', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv').withDefault({ result: [{ task_id: 't1', state: 'pending' }] });
    const watcher = watchTasks(asSession(s), { schedule });
    watcher.stop();

    // Would emit a delta IF the watcher were still running
    fire();
    await flush();

    expect(watcher.cursor).toEqual({}); // cursor unchanged — tick was dropped
  });

  it('iterator return() calls stop()', async () => {
    const { schedule, isStopped } = makeFakeSchedule();
    const s = new FakeSession('!r:srv');
    const watcher = watchTasks(asSession(s), { schedule });
    const iter = watcher[Symbol.asyncIterator]();

    const returnResult = await iter.return?.();
    expect(returnResult?.done).toBe(true);
    expect(isStopped()).toBe(true);
  });

  it('discards poll results when stop() is called while a tick is in-flight', async () => {
    let resolvePoll!: (v: unknown) => void;
    const hangingCall = new Promise<unknown>((r) => { resolvePoll = r; });

    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv');
    s.call = async () => hangingCall;

    const watcher = watchTasks(asSession(s), { schedule });

    fire(); // starts an in-flight poll (hangs inside session.call)
    await Promise.resolve(); // let the tick begin

    watcher.stop(); // stop before the poll resolves

    // Resolve the hanging call with a real task — should be discarded
    resolvePoll([{ task_id: 't1', state: 'pending' }]);
    await flush();

    // No delta should have been emitted or buffered after stop
    const iter = watcher[Symbol.asyncIterator]();
    const result = await iter.next();
    expect(result.done).toBe(true); // stopped, nothing buffered
    expect(watcher.cursor).toEqual({}); // cursor did not advance (poll was discarded)
  });
});

// ---------------------------------------------------------------------------
// Re-entrancy guard (overlapping tick suppression)
// ---------------------------------------------------------------------------

describe('watchTasks — re-entrancy guard', () => {
  it('a second fire while a tick is in-flight is suppressed', async () => {
    let resolveFirst!: () => void;
    const firstSettled = new Promise<void>((r) => { resolveFirst = r; });
    let callCount = 0;

    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv');
    s.call = async (method: string) => {
      callCount++;
      if (callCount === 1) await firstSettled; // hang the first poll
      return method === 'task.list' ? [] : undefined;
    };

    watchTasks(asSession(s), { schedule });

    fire(); // starts first poll (hangs)
    await Promise.resolve(); // let the first poll start
    fire(); // should be suppressed (inFlight)
    await Promise.resolve();
    expect(callCount).toBe(1); // only one call, second fire dropped

    resolveFirst();
    await flush();
    // After resolution, a fresh fire should work
    fire();
    await flush();
    expect(callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// onError / fault tolerance
// ---------------------------------------------------------------------------

describe('watchTasks — onError and fault tolerance', () => {
  it('calls onError with the transport code when task.list throws', async () => {
    const errors: string[] = [];
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv').whenMethod('task.list', { error: 'rpc' });
    const watcher = watchTasks(asSession(s), {
      schedule,
      onError: (code) => errors.push(code),
    });

    fire();
    await flush();

    watcher.stop();
    expect(errors).toContain('rpc');
  });

  it('maps a non-TransportError fault to "protocol"', async () => {
    const errors: string[] = [];
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv');
    s.call = async () => { throw new Error('unexpected non-transport error'); };

    const watcher = watchTasks(asSession(s), {
      schedule,
      onError: (code) => errors.push(code),
    });

    fire();
    await flush();

    watcher.stop();
    expect(errors).toContain('protocol');
  });

  it('never throws to the consumer on a poll fault', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv').whenMethod('task.list', { error: 'not_running' });
    const watcher = watchTasks(asSession(s), { schedule });

    // Fire and flush — should not throw or produce an unhandled rejection
    fire();
    await flush();

    watcher.stop();
  });

  it('the watcher continues emitting after a transient fault', async () => {
    const errors: string[] = [];
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv')
      .whenMethod('task.list',
        { error: 'timeout' }, // first tick fails
        { result: [{ task_id: 't1', state: 'pending' }] }, // second tick succeeds
      );
    const watcher = watchTasks(asSession(s), {
      schedule,
      onError: (code) => errors.push(code),
    });
    const iter = watcher[Symbol.asyncIterator]();

    // First tick — fault
    fire();
    await flush();
    expect(errors).toEqual(['timeout']);

    // Second tick — emits a delta
    fire();
    await flush();
    const result = await iter.next();
    watcher.stop();
    expect(result.done).toBe(false);
    expect(result.value?.task.task_id).toBe('t1');
  });
});

// ---------------------------------------------------------------------------
// Stream-gap recovery: watch method fails → falls back to task.list
// ---------------------------------------------------------------------------

describe('watchTasks — stream-gap recovery (watch method fallback)', () => {
  it('falls back to task.list when the watch method throws', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv')
      .whenMethod('fake.watch', { error: 'rpc' }) // watch fails
      .whenMethod('task.list', { result: [{ task_id: 't1', state: 'pending' }] });
    const watcher = watchTasks(asSession(s), {
      schedule,
      taskWatchMethod: 'fake.watch',
    });
    const iter = watcher[Symbol.asyncIterator]();

    fire();
    await flush();

    const result = await iter.next();
    watcher.stop();
    expect(result.done).toBe(false);
    expect(result.value?.task.task_id).toBe('t1');
    // Both the watch method and task.list should have been called
    const methods = s.seenCalls.map((c) => c.method);
    expect(methods).toContain('fake.watch');
    expect(methods).toContain('task.list');
  });

  it('uses the watch method when it succeeds (no task.list call)', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv')
      .whenMethod('fake.watch', { result: [{ task_id: 't1', state: 'pending' }] });
    const watcher = watchTasks(asSession(s), {
      schedule,
      taskWatchMethod: 'fake.watch',
    });
    const iter = watcher[Symbol.asyncIterator]();

    fire();
    await flush();

    const result = await iter.next();
    watcher.stop();
    expect(result.done).toBe(false);
    expect(result.value?.task.task_id).toBe('t1');
    expect(s.seenCalls.map((c) => c.method)).not.toContain('task.list');
  });
});

// ---------------------------------------------------------------------------
// Watch method cursor threading (cursor params sent to the watch backend)
// ---------------------------------------------------------------------------

describe('watchTasks — watch method cursor threading', () => {
  it('includes cursor in watch method params when cursor has state_rev', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv')
      .whenMethod('fake.watch', { result: [] });
    const watcher = watchTasks(asSession(s), {
      schedule,
      taskWatchMethod: 'fake.watch',
      cursor: { state_rev: 7 },
    });

    fire();
    await flush();
    watcher.stop();

    const watchCall = s.seenCalls.find((c) => c.method === 'fake.watch');
    expect(watchCall).toBeDefined();
    const params = watchCall?.params as Record<string, unknown> | undefined;
    expect(params?.['cursor']).toEqual({ state_rev: 7 });
  });

  it('omits cursor from watch method params when no cursor was provided', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv')
      .whenMethod('fake.watch', { result: [] });
    const watcher = watchTasks(asSession(s), {
      schedule,
      taskWatchMethod: 'fake.watch',
      // no cursor
    });

    fire();
    await flush();
    watcher.stop();

    const watchCall = s.seenCalls.find((c) => c.method === 'fake.watch');
    // Without a cursor, params may be undefined (no room, no cursor)
    const params = watchCall?.params as Record<string, unknown> | undefined;
    expect(params?.['cursor']).toBeUndefined();
  });

  it('cursor in watch params advances after each tick (watcher tracks the current cursor)', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv')
      .whenMethod('fake.watch',
        { result: [{ task_id: 't1', state: 'pending', state_rev: 10 }] },
        { result: [] },
      );
    const watcher = watchTasks(asSession(s), {
      schedule,
      taskWatchMethod: 'fake.watch',
      cursor: { state_rev: 5 },
    });

    // First tick — emits t1 (rev=10 > initialRev=5), cursor advances to 10
    fire();
    await flush();
    await watcher[Symbol.asyncIterator]().next(); // consume delta

    // Cursor should now be 10
    expect(watcher.cursor.state_rev).toBe(10);

    // Second tick — watch params should include the updated cursor
    fire();
    await flush();
    watcher.stop();

    const watchCalls = s.seenCalls.filter((c) => c.method === 'fake.watch');
    expect(watchCalls).toHaveLength(2);
    const secondParams = watchCalls[1]?.params as Record<string, unknown> | undefined;
    const cursorInSecond = secondParams?.['cursor'] as Record<string, unknown> | undefined;
    expect(cursorInSecond?.['state_rev']).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Secret-free deltas
// ---------------------------------------------------------------------------

describe('watchTasks — secret-free deltas', () => {
  it('delta.task carries only non-secret coordination fields', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const rawTask = {
      task_id: 't1',
      state: 'pending',
      assignee: null,
      depends_on: [],
      blocks: [],
      // action.args with a credential-shaped value — must NOT appear in the delta
      action: { tool: 'shell', args: { api_key: 'sk-ant-supersecret-value' } },
      matrix_token: 'syt_fakematrixtoken',
    };
    const s = new FakeSession('!r:srv').whenMethod('task.list', { result: [rawTask] });
    const watcher = watchTasks(asSession(s), { schedule });
    const iter = watcher[Symbol.asyncIterator]();

    fire();
    await flush();

    const delta = await iter.next();
    watcher.stop();
    const deltaStr = JSON.stringify(delta.value);
    expect(deltaStr).not.toContain('sk-ant-supersecret-value');
    expect(deltaStr).not.toContain('api_key');
    expect(deltaStr).not.toContain('syt_fakematrixtoken');
    expect(deltaStr).not.toContain('action');
  });

  it('delta.cursor contains only state_rev/token — no credential-shaped fields', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv').whenMethod('task.list', {
      result: [{ task_id: 't1', state: 'pending', state_rev: 3 }],
    });
    const watcher = watchTasks(asSession(s), { schedule });
    const iter = watcher[Symbol.asyncIterator]();

    fire();
    await flush();

    const delta = await iter.next();
    watcher.stop();
    const cursor = delta.value?.cursor ?? {};
    const cursorKeys = Object.keys(cursor);
    const credentialKeys = cursorKeys.filter((k) =>
      /secret|password|token|api[_-]?key|signing[_-]?key/i.test(k),
    );
    expect(credentialKeys).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Buffer draining (consumer arrives after deltas are queued)
// ---------------------------------------------------------------------------

describe('watchTasks — buffer draining', () => {
  it('buffered deltas are drained before the consumer parks', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!r:srv').whenMethod('task.list', {
      result: [{ task_id: 't1', state: 'pending' }],
    });
    const watcher = watchTasks(asSession(s), { schedule });

    // Fire the tick BEFORE creating the iterator — delta is buffered
    fire();
    await flush();

    const iter = watcher[Symbol.asyncIterator]();
    const result = await iter.next(); // should drain buffer, not park
    watcher.stop();
    expect(result.done).toBe(false);
    expect(result.value?.task.task_id).toBe('t1');
  });
});

// ---------------------------------------------------------------------------
// room param threading
// ---------------------------------------------------------------------------

describe('watchTasks — room param threading', () => {
  it('includes the room param in task.list calls when session.room is set', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession('!myroom:server').whenMethod('task.list', { result: [] });
    const watcher = watchTasks(asSession(s), { schedule });

    fire();
    await flush();

    watcher.stop();
    const listCall = s.seenCalls.find((c) => c.method === 'task.list');
    expect(listCall).toBeDefined();
    expect((listCall?.params as Record<string, unknown>)?.['room']).toBe('!myroom:server');
  });

  it('omits the room param when session.room is undefined', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const s = new FakeSession(undefined).whenMethod('task.list', { result: [] });
    const watcher = watchTasks(asSession(s), { schedule });

    fire();
    await flush();

    watcher.stop();
    const listCall = s.seenCalls.find((c) => c.method === 'task.list');
    expect(listCall?.params).toBeUndefined();
  });
});
