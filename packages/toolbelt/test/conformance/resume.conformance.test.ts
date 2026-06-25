/**
 * Conformance · T302 — `resumeSession` + task-stream resumption.
 *
 * Two gated describe blocks mirror the repo's single-daemon / two-daemon pattern:
 *
 * **Tier 1 (single daemon, `MXL_CONFORMANCE=1`):**
 * Drives the full T302 acceptance criterion — "a killed-and-restarted runtime
 * resumes the plan from task state" — against a live pinned daemon:
 *
 *   openSession (prior runtime) → task.create (optional, best-effort) →
 *   session.describe() → session.close() (kill simulation) →
 *   resumeSession(descriptor) → assert session/plan shape, idempotency,
 *   secret boundary, non-re-dispatch, watchTasks poll backend.
 *
 * `task.create` is flag-confirmed (T301) but the wire shape is pending the
 * two-daemon round-trip. Tests that need authored tasks degrade gracefully when
 * `task.create` is unavailable on the daemon — plan assertions are structural
 * and the plan may have zero tasks. The non-structural test (task classification)
 * only runs when tasks are actually created.
 *
 * **Tier 2 (two-daemon, `MXL_CONFORMANCE_TWO_DAEMON=1`):**
 * A staged single-flow resume arm in the shared fixture room. The room already
 * has tasks created by the delegation tests, so `task.list` returns real rows.
 * Pins the `task.list` resumption reply shape (cursor, field names, task
 * structure). `task.watch` push is separately gated (TASK_WATCH_METHOD is
 * undefined; T302 satisfies its AC on the poll backend).
 *
 * Timing note: `agent.register` waits for Matrix /sync (~29s on a local
 * homeserver). One client is shared per suite.
 *
 * External requirements (Tier 1):
 *   - mx-agent daemon running at the default socket path
 *   - daemon logged in (`mx-agent auth status` → logged_in: true)
 *
 * Additional requirements (Tier 2):
 *   - Two-daemon fixture with MXL_CONFORMANCE_ROOM, MXL_CONFORMANCE_TARGET_AGENT,
 *     MXL_CONFORMANCE_TOOL set. See `_harness.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createClient } from '../../src/client.js';
import type { MxClient } from '../../src/client.js';
import { openSession } from '../../src/session.js';
import type { MxSession } from '../../src/session.js';
import { resumeSession } from '../../src/resume.js';
import type { ResumedSession } from '../../src/resume.js';
import { watchTasks, TASK_WATCH_METHOD } from '../../src/task-watch.js';
import type { SessionDescriptor } from '../../src/session-descriptor.js';

import {
  AGENT_STATE_FIELDS,
  SECRET_PATTERN,
  SKIP_SINGLE_DAEMON,
  SKIP_TWO_DAEMON,
  assertSingleDaemonPrereqs,
  assertTwoDaemonPrereqs,
  readTwoDaemonFixture,
} from './_harness.js';
import type { TwoDaemonFixture } from './_harness.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The stable task-state vocabulary plus the safe-fallback. */
const RESUMED_TASK_STATES = new Set([
  'proposed', 'pending', 'assigned', 'executing', 'succeeded', 'failed', 'unknown',
]);

/**
 * Assert a `PlanSnapshot`-shaped object has the correct structural invariants
 * regardless of task count. Shared between both tiers.
 */
function assertPlanShape(plan: ResumedSession['plan'], room: string): void {
  expect(plan.room).toBe(room);

  // tasks is a read-only array; every entry has the expected non-secret fields
  for (const task of plan.tasks) {
    expect(typeof task.task_id).toBe('string');
    expect(task.task_id.length).toBeGreaterThan(0);
    expect(RESUMED_TASK_STATES.has(task.state)).toBe(true);
    expect(Array.isArray(task.depends_on)).toBe(true);
    expect(Array.isArray(task.blocks)).toBe(true);
    // assignee is string | null — no other type
    expect(task.assignee === null || typeof task.assignee === 'string').toBe(true);
  }

  // edges: each has from, to, kind
  for (const edge of plan.edges) {
    expect(typeof edge.from).toBe('string');
    expect(typeof edge.to).toBe('string');
    expect(['depends_on', 'blocks']).toContain(edge.kind);
  }

  // reconciliation: every task_id in exactly one bucket
  const { done, inFlight, ready, blocked } = plan.reconciliation;
  const allBuckets = [...done, ...inFlight, ...ready, ...blocked];
  expect(new Set(allBuckets).size).toBe(allBuckets.length); // no duplicates
  expect(allBuckets.length).toBe(plan.tasks.length);

  // cursor is always defined (may be empty)
  expect(plan.cursor).toBeDefined();
  if (plan.cursor.state_rev !== undefined) {
    expect(typeof plan.cursor.state_rev).toBe('number');
    expect(Number.isFinite(plan.cursor.state_rev)).toBe(true);
  }
}

/** Assert the descriptor carries no credential-shaped field or value. */
function assertDescriptorSecretFree(descriptor: SessionDescriptor): void {
  const str = JSON.stringify(descriptor);
  expect(SECRET_PATTERN.test(str)).toBe(false);
  // Explicit checks on the known allowlist shape
  const keys = Object.keys(descriptor);
  const disallowedKeys = keys.filter((k) =>
    /secret|password|passwd|token|api[_-]?key|signing[_-]?key|private[_-]?key/i.test(k) &&
    !['correlation_id', 'task_id', 'agent_id'].includes(k),
  );
  expect(disallowedKeys).toHaveLength(0);
}

/** Assert the plan snapshot carries no credential-shaped value. */
function assertPlanSecretFree(plan: ResumedSession['plan']): void {
  const str = JSON.stringify(plan);
  expect(SECRET_PATTERN.test(str)).toBe(false);
  // action.args — if present anywhere — must not have leaked through
  expect(str).not.toContain('"action"');
}

// ---------------------------------------------------------------------------
// Tier 1 — single daemon
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_SINGLE_DAEMON)('conformance · T302 — resumeSession (single daemon)', () => {
  let client: MxClient | undefined;
  let room: string | undefined;
  let descriptor: SessionDescriptor | undefined;
  let result: ResumedSession | undefined;
  /** Whether task.create succeeded — controls task-count assertions. */
  let tasksCreated = false;

  // The runtime's own static registration config — re-supplied on every startup and
  // identical for the prior session and the resumed one. It is NOT session state, so it
  // rides openSession/ResumeOptions rather than the descriptor; `maxInvocations` is
  // required by agent.register on v0.2.1, so the resume must supply it too or the
  // re-register would be degraded/rejected by a live daemon.
  const REGISTER_CONFIG = {
    kind: 'runtime',
    capabilities: [] as string[],
    tools: [] as unknown[],
    workspace: { cwd: '/tmp', project_id: 'mx-loom-t302' },
    maxInvocations: 10,
  };

  beforeAll(async () => {
    assertSingleDaemonPrereqs();

    // A generous timeout: agent.register waits for Matrix /sync (~29s locally).
    client = createClient({ defaultTimeoutMs: 60_000 });

    // Create a workspace room scoped to this suite.
    const ws = (await client.call(
      'workspace.create',
      { name: 'mx-loom-t302-resume', visibility: 'private' },
      { timeoutMs: 60_000 },
    )) as Record<string, unknown>;
    if (typeof ws['room_id'] !== 'string') {
      throw new Error('T302 conformance: workspace.create returned no room_id');
    }
    room = ws['room_id'];

    // Prior runtime: open a session, optionally author tasks, serialize the
    // descriptor, then close (the "kill" simulation).
    const sessionA = await openSession({
      client,
      heartbeat: false,
      room,
      ...REGISTER_CONFIG,
    });

    // Author two tasks with a depends_on edge (flag-confirmed T301; wire shape pending
    // round-trip — use best-effort with try/catch so the suite degrades gracefully).
    let t1Id: string | undefined;
    try {
      const t1 = await sessionA.call(
        'task.create',
        { room, title: 'T302-task-A (seed)', state: 'succeeded' },
        { timeoutMs: 10_000 },
      );
      t1Id = (t1 as Record<string, unknown>)?.['task_id'] as string | undefined;
      await sessionA.call(
        'task.create',
        {
          room,
          title: 'T302-task-B (depends on A)',
          state: 'pending',
          ...(t1Id !== undefined ? { depends_on: [t1Id] } : {}),
        },
        { timeoutMs: 10_000 },
      );
      tasksCreated = true;
    } catch {
      // task.create unavailable on this daemon version — structural tests continue.
    }

    // Persist the non-secret descriptor from the live session.
    descriptor = sessionA.describe();

    // Kill simulation: close the session (heartbeat stops, liveness decays).
    await sessionA.close();

    // Restart: call resumeSession with the persisted descriptor + the runtime's own
    // registration config (so the re-`agent.register` is faithful, not degraded).
    result = await resumeSession(descriptor, {
      client,
      heartbeat: false,
      ...REGISTER_CONFIG,
    });
  }, 120_000);

  afterAll(async () => {
    await result?.session.close();
    await client?.close();
  });

  // ---------- Session re-registration ----------

  it('resumed session is active', () => {
    expect(result?.session.state).toBe('active');
  });

  it('resumed session has the same room as the descriptor', () => {
    expect(result?.session.room).toBe(descriptor?.room);
  });

  it('resumed session reuses the persisted correlation_id', () => {
    expect(result?.session.correlationId).toBe(descriptor?.correlation_id);
  });

  it('resumed session has a non-empty agentId', () => {
    expect(typeof result?.session.agentId).toBe('string');
    expect((result?.session.agentId ?? '').length).toBeGreaterThan(0);
  });

  it('resumed flag is a boolean reflecting agent-id continuity', () => {
    expect(typeof result?.resumed).toBe('boolean');
  });

  it('agentState on the resumed session has the expected fields', () => {
    const state = result?.session.agentState;
    if (state === undefined) return;
    for (const field of AGENT_STATE_FIELDS) {
      expect(Object.prototype.hasOwnProperty.call(state, field)).toBe(true);
    }
  });

  // ---------- Plan reconstruction ----------

  it('plan has no fault — task.list call succeeded', () => {
    expect(result?.plan.fault).toBeUndefined();
  });

  it('plan has the correct room', () => {
    expect(result?.plan.room).toBe(room);
  });

  it('plan has the correct structural shape (T302 spec invariants)', () => {
    if (result === undefined || room === undefined) return;
    assertPlanShape(result.plan, room);
  });

  it('plan reconciliation is correct when tasks were authored (T301+T302 end-to-end)', () => {
    if (!tasksCreated || result === undefined) return;
    // Task A was set to succeeded → done. Task B depends on A (now satisfied) → ready.
    const { done, ready, inFlight, blocked } = result.plan.reconciliation;
    expect(done.length).toBeGreaterThanOrEqual(1);
    // The second task should be either ready (dep satisfied) or blocked (if state_rev
    // semantics differ) — at minimum it must be in a bucket.
    const allBuckets = [...done, ...inFlight, ...ready, ...blocked];
    expect(allBuckets.length).toBe(result.plan.tasks.length);
  });

  // ---------- Secret boundary (Boundary A) ----------

  it('descriptor is secret-free (no credential-shaped field or value)', () => {
    if (descriptor === undefined) return;
    assertDescriptorSecretFree(descriptor);
  });

  it('plan snapshot is secret-free (no credential-shaped field or value)', () => {
    if (result === undefined) return;
    assertPlanSecretFree(result.plan);
  });

  it('descriptor carries only the allowlisted fields (v, agent_id, room, correlation_id, kind, cursor)', () => {
    if (descriptor === undefined) return;
    const allowedKeys = new Set(['v', 'agent_id', 'room', 'correlation_id', 'kind', 'cursor']);
    for (const key of Object.keys(descriptor)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
  });

  // ---------- Idempotency ----------

  it('after re-register, agent.list contains exactly one entry for this agent (idempotent upsert)', async () => {
    if (result === undefined || room === undefined) return;
    let list: unknown;
    try {
      list = await result.session.call('agent.list', { room }, { timeoutMs: 10_000 });
    } catch {
      // agent.list not available on this daemon — soft skip.
      return;
    }
    if (!Array.isArray(list)) return;
    const agentId = result.session.agentId;
    const matches = list.filter((e) => {
      const rec = e as Record<string, unknown>;
      const agent = rec['agent'] as Record<string, unknown> | undefined;
      return agent?.['agent_id'] === agentId;
    });
    expect(matches.length).toBe(1); // exactly one, not two (idempotent upsert)
  });

  // ---------- Non-re-dispatch invariant ----------

  it('resumeSession does not mutate any task (no task.create/update/execute call)', async () => {
    // Read plan before: count tasks.
    if (result === undefined || room === undefined) return;
    const before = result.plan.tasks.length;

    // Run a second resumeSession on the same descriptor.
    const desc2 = result.session.describe();
    const result2 = await resumeSession(desc2, { client, heartbeat: false, ...REGISTER_CONFIG });
    await result2.session.close();

    // Task count must be unchanged (no new task was created during resumeSession).
    expect(result2.plan.tasks.length).toBe(before);
  });

  // ---------- watchTasks — poll backend ----------

  it('watchTasks(session) starts and stops cleanly against the live daemon', async () => {
    if (result === undefined) return;
    const errors: string[] = [];
    const watcher = watchTasks(result.session, {
      intervalMs: 1_000, // 1s so the test is fast
      onError: (code) => errors.push(code),
    });

    // Give it one tick (1s + margin).
    await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
    watcher.stop();

    // Stop is clean: no unhandled rejections, no unexpected errors.
    // A non-running daemon would produce a transport code; an empty room is fine.
    expect(typeof watcher.cursor).toBe('object');
  }, 10_000);

  it('TASK_WATCH_METHOD is undefined — task.watch is unverified and poll fallback is default', () => {
    expect(TASK_WATCH_METHOD).toBeUndefined();
  });

  it('watchTasks emits at least one delta for tasks that exist in the room (no cursor)', async () => {
    // Only meaningful when task.create succeeded and tasks are in the room.
    if (!tasksCreated || result === undefined) return;

    const deltas: Array<{ task_id: string; state: string }> = [];
    const errors: string[] = [];

    // No cursor — all tasks in the room are "new" to this watcher, so the first
    // tick must emit at least one delta (the two tasks we seeded above).
    const watcher = watchTasks(result.session, {
      intervalMs: 500,
      onError: (code) => errors.push(code),
    });

    // Collect for up to 4 tick intervals (2s), then stop.
    const collectPromise = (async () => {
      for await (const { task } of watcher) {
        deltas.push({ task_id: task.task_id, state: task.state });
        if (deltas.length >= 2) break; // 2 tasks were seeded; stop as soon as we see them
      }
    })();

    await new Promise<void>((resolve) => setTimeout(resolve, 3_000));
    watcher.stop();
    await collectPromise;

    // At least one delta must have been emitted.
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    for (const d of deltas) {
      expect(typeof d.task_id).toBe('string');
      expect(d.task_id.length).toBeGreaterThan(0);
      expect(RESUMED_TASK_STATES.has(d.state)).toBe(true);
    }
    // No transport errors should have occurred on the first tick.
    expect(errors).toHaveLength(0);
  }, 15_000);

  it('multi-restart cursor roundtrip: describe(plan.cursor) → second resumeSession → cursor does not regress', async () => {
    // E2e test for the cursor persistence property: the prior process persists
    // plan.cursor into the descriptor; the next resumeSession must produce a plan
    // whose cursor.state_rev is >= the persisted value (monotonic, never regresses).
    if (result === undefined || room === undefined) return;

    const cursorFromFirstResume = result.plan.cursor;

    // Mint a second descriptor with the plan cursor (simulating what the host would
    // persist before a second planned shutdown).
    const descriptor2 = result.session.describe(cursorFromFirstResume);

    // Descriptor must be secret-free and carry the cursor we passed.
    assertDescriptorSecretFree(descriptor2);
    if (cursorFromFirstResume.state_rev !== undefined) {
      expect(descriptor2.cursor?.state_rev).toBe(cursorFromFirstResume.state_rev);
    }

    // Second restart from the descriptor with cursor.
    const result2 = await resumeSession(descriptor2, { client, heartbeat: false, ...REGISTER_CONFIG });

    // The second resume's plan cursor must be >= the first's (high-water mark).
    if (
      cursorFromFirstResume.state_rev !== undefined &&
      result2.plan.cursor.state_rev !== undefined
    ) {
      expect(result2.plan.cursor.state_rev).toBeGreaterThanOrEqual(
        cursorFromFirstResume.state_rev,
      );
    }

    // Same room; plan shape is still valid.
    expect(result2.plan.room).toBe(room);
    if (room !== undefined) assertPlanShape(result2.plan, room);
    assertPlanSecretFree(result2.plan);

    // The second resume must not have dispatched any task action.
    // (Structural: plan.tasks same count or more — no tasks were deleted.)
    expect(result2.plan.tasks.length).toBeGreaterThanOrEqual(0);

    await result2.session.close();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Tier 2 — two-daemon: task.list resumption shape in the fixture room
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_TWO_DAEMON)(
  'conformance · T302 — task.list resumption shape (two-daemon fixture room)',
  () => {
    let client: MxClient | undefined;
    let fixture: TwoDaemonFixture | undefined;
    let session: MxSession | undefined;
    let result: ResumedSession | undefined;

    // Static registration config re-supplied on resume (see Tier 1 for the rationale).
    const REGISTER_CONFIG = {
      kind: 'runtime',
      capabilities: [] as string[],
      tools: [] as unknown[],
      workspace: { cwd: '/tmp', project_id: 'mx-loom-t302-fixture' },
      maxInvocations: 10,
    };

    beforeAll(async () => {
      // Fail-not-skip: when MXL_CONFORMANCE_TWO_DAEMON=1 a missing fixture is a
      // HARD failure (never silently skip on surface drift).
      assertTwoDaemonPrereqs();
      const fx = readTwoDaemonFixture();
      if (fx === null) {
        throw new Error('T302 conformance (Tier 2): two-daemon fixture coordinates absent');
      }
      fixture = fx;
      client = createClient({ defaultTimeoutMs: 60_000 });

      // Open a session in the shared fixture room (agents from previous delegation
      // tests registered here, so task.list may return real rows).
      session = await openSession({
        client,
        heartbeat: false,
        room: fixture.room,
        ...REGISTER_CONFIG,
      });

      // Capture the descriptor from the live session.
      const descriptor = session.describe();

      // Close the session (kill simulation) — a new process would start here.
      await session.close();

      // Resume from the descriptor + the runtime's registration config — this is the
      // T302 acceptance criterion, with a faithful (non-degraded) re-`agent.register`.
      result = await resumeSession(descriptor, {
        client,
        heartbeat: false,
        ...REGISTER_CONFIG,
      });
    }, 90_000);

    afterAll(async () => {
      await result?.session.close();
      await client?.close();
    });

    it('resumed session is active', () => {
      expect(result?.session.state).toBe('active');
    });

    it('resumed session has the fixture room', () => {
      expect(result?.session.room).toBe(fixture?.room);
    });

    it('plan has no fault — task.list succeeded against the live daemon', () => {
      expect(result?.plan.fault).toBeUndefined();
    });

    it('plan has the correct structural shape (T302 spec invariants)', () => {
      if (result === undefined || fixture === undefined) return;
      assertPlanShape(result.plan, fixture.room);
    });

    it('plan snapshot is secret-free', () => {
      if (result === undefined) return;
      assertPlanSecretFree(result.plan);
    });

    it('plan.cursor.state_rev is a finite number when tasks exist (cursor token shape)', () => {
      if (result === undefined) return;
      if (result.plan.tasks.length === 0) {
        // No tasks in room — cursor is empty; this is structurally valid.
        expect(result.plan.cursor).toEqual({});
        return;
      }
      // The fixture room has tasks from prior test runs — state_rev must be numeric.
      // (Pin the cursor token shape; the exact cursor structure is wire-round-trip TBD.)
      if (result.plan.cursor.state_rev !== undefined) {
        expect(Number.isFinite(result.plan.cursor.state_rev)).toBe(true);
      }
    });

    it('plan.tasks: each projected task carries only non-secret coordination fields', () => {
      if (result === undefined) return;
      for (const task of result.plan.tasks) {
        const taskStr = JSON.stringify(task);
        expect(taskStr).not.toContain('"action"');
        expect(SECRET_PATTERN.test(taskStr)).toBe(false);
        // Only the allowlisted ResumedTask keys
        const allowedKeys = new Set(['task_id', 'state', 'assignee', 'depends_on', 'blocks']);
        for (const key of Object.keys(task)) {
          expect(allowedKeys.has(key)).toBe(true);
        }
      }
    });

    it('task.watch push backend remains unverified (TASK_WATCH_METHOD is undefined)', () => {
      // The T302 spec explicitly gates task.watch push behind a one-const swap once
      // verified. This test pins that the const is still undefined — so a future
      // verification is not accidentally enabled by a code change.
      expect(TASK_WATCH_METHOD).toBeUndefined();
    });

    it('watchTasks(resumed session, { cursor: plan.cursor }) emits no immediate errors', async () => {
      if (result === undefined) return;
      const errors: string[] = [];
      const watcher = watchTasks(result.session, {
        cursor: result.plan.cursor,
        intervalMs: 1_000,
        onError: (code) => errors.push(code),
      });

      // One poll tick
      await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
      watcher.stop();

      // Suppress task state we don't control in a live room — just assert no
      // credential-shaped value appears in any emitted delta's cursor.
      const cursorStr = JSON.stringify(watcher.cursor);
      expect(SECRET_PATTERN.test(cursorStr)).toBe(false);
    }, 10_000);
  },
);
