/**
 * Integration tests for MxSession / openSession (T005, AC1–AC3).
 *
 * Three suites, following the project's established integration-test pattern
 * (see mxclient.integration.test.ts):
 *
 * SUITE 1 — FIXTURE-BACKED (always runs in CI, no live daemon needed)
 *   Drives openSession() through a real MxClient with CLI transport backed by
 *   mock-mx-agent.mjs. Exercises the full stack:
 *     openSession() → MxClient → CliClient → subprocess → stdout parse → AgentState
 *   The mock is stateless (one process per call); agent.register and agent.list
 *   both return the same synthetic agent so liveness() reflects "active".
 *
 * SUITE 3 — FIXTURE-BACKED HEARTBEAT E2E (always runs in CI, no live daemon needed)
 *   Fires an actual heartbeat tick through the real CLI transport using an injected
 *   fake scheduler (so timing is deterministic). Verifies AC2 end-to-end: tick
 *   executes, correlationId is stamped, liveness() is still "active" after the tick.
 *   Suite 1 only verifies timer lifecycle; Suite 3 verifies tick execution.
 *
 * SUITE 2 — LIVE-DAEMON GATED (skipped when no daemon socket is found)
 *   Verifies AC1/AC2/AC3 across the real Boundary B (IPC Unix socket).
 *
 *   Design constraint: agent.register sends a Matrix state event PUT per call.
 *   Repeated registrations to the SAME room event key require the daemon to wait
 *   for Matrix /sync to confirm the event (~29s on local homeserver). Creating
 *   additional workspaces mid-suite also triggers room creation events that make
 *   the daemon unresponsive for 15+ seconds to subsequent IPC calls.
 *
 *   Strategy: one workspace + one shared session in beforeAll. Most tests reuse
 *   the shared session (no additional IPC calls). Only the idempotency test opens
 *   a second session in the SAME room (using its own IpcClient) — it is slow
 *   (~29s) and runs last among the heavy tests.
 *
 * To run the live-daemon suite: `mx-agent daemon start` then `pnpm test`.
 * To run only the fixture suite: `pnpm test session.integration`.
 *
 * External requirements (live-daemon suite only):
 *   - mx-agent daemon running at the default socket path
 *   - daemon logged in (`mx-agent auth status` → logged_in: true)
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MxClient, createClient } from '../src/client.js';
import type { HeartbeatSchedule } from '../src/heartbeat.js';
import { resolveSocketPath } from '../src/ipc/socket-path.js';
import { openSession } from '../src/session.js';
import type { MxSession } from '../src/session.js';

// ---------------------------------------------------------------------------
// Fixture setup — matches the pattern in mxclient.integration.test.ts
// ---------------------------------------------------------------------------

const FIXTURE_MJS = fileURLToPath(new URL('./fixtures/mock-mx-agent.mjs', import.meta.url));
const NODE_BIN = process.execPath;
const CALL_TIMEOUT_MS = 5_000;

/** agent_id the mock fixture always returns from agent.register / agent.list */
const FIXTURE_AGENT_ID = 'agent-fixture-session-001';

let tmpDir: string;
let CLI: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mxl-session-int-'));
  CLI = join(tmpDir, 'mock-mx-agent');
  writeFileSync(CLI, `#!/bin/sh\nexec '${NODE_BIN}' '${FIXTURE_MJS}' "$@"\n`);
  chmodSync(CLI, 0o755);
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Suite 1: Fixture-backed (always runs in CI)
// ---------------------------------------------------------------------------

describe('openSession — fixture-backed (no live daemon)', () => {
  it('openSession() completes through the real MxClient/CliClient stack and captures agent_id (AC1 mechanism)', async () => {
    const mx = new MxClient({ transport: 'cli', cliBin: CLI });
    const session = await openSession({ client: mx, heartbeat: false });
    try {
      expect(session.state).toBe('active');
      expect(session.agentId).toBe(FIXTURE_AGENT_ID);
    } finally {
      await session.close();
      await mx.close();
    }
  });

  it('session.agentState reflects the AgentState returned by agent.register via real transport', async () => {
    const mx = new MxClient({ transport: 'cli', cliBin: CLI });
    const session = await openSession({ client: mx, heartbeat: false });
    try {
      expect(session.agentState).toMatchObject({
        agent_id: FIXTURE_AGENT_ID,
        kind: 'runtime',
        status: 'active',
        capabilities: [],
        tools: [],
      });
    } finally {
      await session.close();
      await mx.close();
    }
  });

  it('session.liveness() returns "active" — agent.list round-trips through the real CLI transport (AC1 query)', async () => {
    const mx = new MxClient({ transport: 'cli', cliBin: CLI });
    const session = await openSession({ client: mx, heartbeat: false });
    try {
      const liveness = await session.liveness({ timeoutMs: CALL_TIMEOUT_MS });
      expect(liveness).toBe('active');
    } finally {
      await session.close();
      await mx.close();
    }
  });

  it('session.close() transitions state to "closed" cleanly through the real transport (AC2 — close)', async () => {
    const mx = new MxClient({ transport: 'cli', cliBin: CLI });
    const session = await openSession({ client: mx, heartbeat: false });
    await session.close();
    expect(session.state).toBe('closed');
    await mx.close();
  });

  it('correlationId is stamped on the debug seam for every call — register AND list (AC3 via real transport)', async () => {
    const logs: string[] = [];
    const mx = new MxClient({ transport: 'cli', cliBin: CLI });
    const session = await openSession({
      client: mx,
      heartbeat: false,
      debug: (line) => logs.push(line),
    });
    try {
      await session.liveness({ timeoutMs: CALL_TIMEOUT_MS }); // triggers agent.list call
      const callLogs = logs.filter((l) => l.startsWith('call '));
      // register (at open) + list (at liveness) = at least 2 correlated call logs
      expect(callLogs.length).toBeGreaterThanOrEqual(2);
      for (const line of callLogs) {
        expect(line).toContain(session.correlationId);
      }
    } finally {
      await session.close();
      await mx.close();
    }
  });

  it('opening with heartbeat enabled starts the real timer; close() stops it without throwing (AC2 — liveness refresh lifecycle)', async () => {
    // Uses the real setInterval (not fake scheduler). The default 15s interval
    // means no tick fires during this short test — only the timer lifecycle is verified.
    const mx = new MxClient({ transport: 'cli', cliBin: CLI });
    const session = await openSession({ client: mx, heartbeatIntervalMs: 60_000 });
    try {
      expect(session.state).toBe('active');
    } finally {
      await session.close();
      expect(session.state).toBe('closed');
      await mx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Fixture-backed heartbeat e2e (always runs in CI)
//
// Verifies that a heartbeat tick actually fires through the real CLI transport
// (subprocess → stdout parse) and produces a successful result. Suite 1's
// heartbeat test only checks timer lifecycle (starts/stops without error);
// this suite drives an actual tick and asserts on the outcome.
//
// Uses an injected fake scheduler (same pattern as session.unit.test.ts) so
// ticks are triggered deterministically without real timers. waitForLog polls
// with a bounded retry rather than an arbitrary sleep to wait for the async
// subprocess to settle.
// ---------------------------------------------------------------------------

/**
 * Wait (bounded retry) for a matching log entry to appear.
 * Returns as soon as the condition is met; rejects on timeout.
 */
async function waitForLog(
  logs: string[],
  predicate: (l: string) => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!logs.some(predicate)) {
    if (Date.now() > deadline) throw new Error(`waitForLog: condition not met in ${timeoutMs}ms`);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

describe('openSession — fixture-backed heartbeat e2e (AC2, no live daemon)', () => {
  it('heartbeat tick fires agent.register through the real CLI transport (AC2 — tick executes)', async () => {
    let scheduledFn: (() => void) | null = null;
    const schedule: HeartbeatSchedule = (fn, _ms) => {
      scheduledFn = fn;
      return { stop: () => { scheduledFn = null; } };
    };
    const debugLogs: string[] = [];
    const mx = new MxClient({ transport: 'cli', cliBin: CLI });
    const session = await openSession({
      client: mx,
      schedule,
      heartbeatIntervalMs: 60_000,
      debug: (line) => debugLogs.push(line),
    });
    try {
      expect(scheduledFn).not.toBeNull();
      // Clear open-phase logs; fire one tick through the real CliClient subprocess
      debugLogs.length = 0;
      scheduledFn!();
      // Wait (bounded) for the subprocess to complete and onTick to call debug
      await waitForLog(debugLogs, (l) => l.includes('heartbeat'));
      expect(debugLogs.some((l) => l.includes('heartbeat ok'))).toBe(true);
    } finally {
      await session.close();
      await mx.close();
    }
  });

  it('heartbeat tick carries the session correlationId through the real CLI transport (AC2 ∩ AC3 — tick is correlated)', async () => {
    let scheduledFn: (() => void) | null = null;
    const schedule: HeartbeatSchedule = (fn, _ms) => {
      scheduledFn = fn;
      return { stop: () => { scheduledFn = null; } };
    };
    const debugLogs: string[] = [];
    const mx = new MxClient({ transport: 'cli', cliBin: CLI });
    const session = await openSession({
      client: mx,
      schedule,
      heartbeatIntervalMs: 60_000,
      debug: (line) => debugLogs.push(line),
    });
    try {
      debugLogs.length = 0; // clear open-phase logs
      scheduledFn!();
      await waitForLog(debugLogs, (l) => l.includes('heartbeat'));
      // Tick goes through session.call — every call log must carry the correlation id
      const tickCallLogs = debugLogs.filter((l) => l.startsWith('call '));
      expect(tickCallLogs.length).toBeGreaterThanOrEqual(1);
      for (const line of tickCallLogs) {
        expect(line).toContain(session.correlationId);
      }
      // Correlation id must not leak secret patterns into the debug seam
      for (const line of debugLogs) {
        expect(line).not.toMatch(/MATRIX_|MX_AGENT_|syt_[a-z]|ghp_|xox[bp]-/);
      }
    } finally {
      await session.close();
      await mx.close();
    }
  });

  it('liveness() is "active" after a heartbeat tick fires through the real CLI transport (AC2 — full round-trip)', async () => {
    let scheduledFn: (() => void) | null = null;
    const schedule: HeartbeatSchedule = (fn, _ms) => {
      scheduledFn = fn;
      return { stop: () => { scheduledFn = null; } };
    };
    const debugLogs: string[] = [];
    const mx = new MxClient({ transport: 'cli', cliBin: CLI });
    const session = await openSession({
      client: mx,
      schedule,
      heartbeatIntervalMs: 60_000,
      debug: (line) => debugLogs.push(line),
    });
    try {
      scheduledFn!();
      // Wait for tick to settle before querying liveness
      await waitForLog(debugLogs, (l) => l.includes('heartbeat'));
      // liveness() round-trips agent.list through the real CLI transport
      const liveness = await session.liveness({ timeoutMs: CALL_TIMEOUT_MS });
      expect(liveness).toBe('active');
    } finally {
      await session.close();
      await mx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Live-daemon gated
// ---------------------------------------------------------------------------

const socketPath = resolveSocketPath();
const socketExists = existsSync(socketPath);

describe.skipIf(!socketExists)('openSession — live mx-agent daemon (IPC transport)', () => {
  /**
   * Minimum required session options for agent.register on v0.2.1:
   * room, kind, capabilities, tools, cwd (flat), project_id (flat), max_invocations.
   * Room is always passed separately (per-call) to allow the idempotency test to
   * open a session in the same room while other tests share the beforeAll room.
   */
  const REQUIRED_SESSION_OPTS = {
    kind: 'runtime' as const,
    capabilities: [] as string[],
    tools: [] as unknown[],
    workspace: { cwd: '/tmp', project_id: 'mx-loom-int-test' },
    maxInvocations: 10,
  };

  /**
   * Shared client + session. Opened ONCE in beforeAll; most tests reuse it.
   *
   * IPC call budget per test run (to avoid overwhelming the daemon with Matrix events):
   *   beforeAll  : workspace.create (mxl-1) + agent.register (mxl-2) = 2
   *   AC1        : agent.list via sharedSession.liveness (mxl-3)     = 1
   *   AC3        : reads sharedLogs only — NO new IPC call            = 0
   *   error      : does.not.exist via sharedSession.call (mxl-4)     = 1
   *   AC2-hb     : agent.register via sharedSession.call (mxl-5 ≈ 29s) = 1
   *   idempotency: agent.register in R1, own client (mxl-6 ≈ 29s)   = 1
   *   AC2        : sharedSession.close() — local, no IPC             = 0
   *   Total      : 6 IPC calls, 1 workspace, 1 Matrix room
   */
  let setupClient: MxClient | undefined;
  let sharedSession: MxSession | undefined;
  let testRoomId: string | undefined;
  const sharedLogs: string[] = [];

  beforeAll(async () => {
    setupClient = createClient();
    try {
      const ws = await setupClient.call(
        'workspace.create',
        { name: 'mx-loom-session-int-test', visibility: 'private' },
        { timeoutMs: 50_000 },
      ) as Record<string, unknown>;
      if (typeof ws['room_id'] !== 'string') return;
      testRoomId = ws['room_id'];

      sharedSession = await openSession({
        client: setupClient,
        heartbeat: false,
        room: testRoomId,
        ...REQUIRED_SESSION_OPTS,
        debug: (line) => sharedLogs.push(line),
      });
    } catch {
      // Individual tests call ctx.skip()
    }
  }, 60_000);

  afterAll(async () => {
    // sharedSession uses setupClient (ownsClient=false); close both.
    // session.close() is idempotent — safe even if AC2 already closed it.
    await sharedSession?.close();
    await setupClient?.close();
  });

  it('AC1: openSession() registers the agent and it appears in agent.list as active on the live daemon', { timeout: 30_000 }, async (ctx) => {
    if (!sharedSession) return ctx.skip('session setup failed — skipping live-daemon test');
    // Calls agent.list via the shared client — adds a call log to sharedLogs (used by AC3).
    const liveness = await sharedSession.liveness({ timeoutMs: 15_000 });
    expect(liveness).toBe('active');
    expect(sharedSession.state).toBe('active');
  });

  it('AC3: correlationId is stamped on the debug seam for every call (live IPC)', { timeout: 15_000 }, async (ctx) => {
    if (!sharedSession) return ctx.skip('session setup failed — skipping live-daemon test');
    // sharedLogs now contains: register (beforeAll) + list (AC1) — no new IPC call.
    // Verify ALL call-line entries carry the session correlationId.
    const callLogs = sharedLogs.filter((l) => l.startsWith('call '));
    expect(callLogs.length).toBeGreaterThanOrEqual(2); // agent.register + agent.list
    for (const line of callLogs) {
      expect(line).toContain(sharedSession.correlationId);
    }
    for (const line of sharedLogs) {
      expect(line).not.toMatch(/MATRIX_|MX_AGENT_|syt_[a-z]|ghp_|xox[bp]-/);
    }
  });

  it('session.call() propagates a real daemon RPC error as a TransportError with a typed code', { timeout: 15_000 }, async (ctx) => {
    if (!sharedSession) return ctx.skip('session setup failed — skipping live-daemon test');
    // The daemon responds quickly to unknown methods with an error.
    const err = await sharedSession
      .call('does.not.exist', undefined, { timeoutMs: 8_000 })
      .catch((e: unknown) => e);
    expect(err).toBeDefined();
    expect(typeof (err as { code?: string }).code).toBe('string');
  });

  it('heartbeat tick (manual re-register via sharedSession.call) succeeds and liveness stays active on the live daemon (AC2 — heartbeat refresh)', { timeout: 60_000 }, async (ctx) => {
    if (!sharedSession || !testRoomId) return ctx.skip('session setup failed — skipping live-daemon test');
    // Simulate what MxSession#heartbeatTick() does (heartbeatMethod === 'agent.register'):
    // call agent.register with the registration params through the existing session.
    // NOTE: agent.register sends a Matrix state event PUT; the daemon waits for /sync
    // to confirm it (~29s on a local homeserver), so this test can be slow.
    const registerParams: Record<string, unknown> = {
      room: testRoomId,
      kind: 'runtime',
      capabilities: [],
      tools: [],
      cwd: '/tmp',
      project_id: 'mx-loom-int-test',
      max_invocations: 10,
    };
    const tickResult = await sharedSession.call('agent.register', registerParams, { timeoutMs: 50_000 });
    // The result must be a valid AgentState for the same agent (idempotent upsert)
    expect((tickResult as { agent_id?: string }).agent_id).toBe(sharedSession.agentId);
    // Liveness must still be active after the tick refreshes last_seen_ts
    const liveness = await sharedSession.liveness({ timeoutMs: 15_000 });
    expect(liveness).toBe('active');
  });

  it('agent_id is daemon-identity-based — a second session in the same room shares the agentId', { timeout: 60_000 }, async (ctx) => {
    if (!testRoomId || !sharedSession) return ctx.skip('session setup failed — skipping live-daemon test');
    // A second agent.register in the SAME room triggers a Matrix state event update.
    // This takes ~29s (daemon waits for /sync to confirm the update). Using a fresh
    // IpcClient (not setupClient) keeps the shared connection responsive.
    const s2 = await openSession({
      room: testRoomId,
      ...REQUIRED_SESSION_OPTS,
      heartbeat: false,
    });
    try {
      expect(s2.agentId).toBe(sharedSession.agentId); // daemon identity → same agent_id
      expect(s2.correlationId).not.toBe(sharedSession.correlationId); // distinct sessions
    } finally {
      await s2.close();
    }
  });

  it('AC2: session state is active after open; close() transitions to closed without error', { timeout: 15_000 }, async (ctx) => {
    if (!sharedSession) return ctx.skip('session setup failed — skipping live-daemon test');
    // liveness already verified in AC1. This test checks the state machine and close() path.
    // Runs last so closing the shared session does not affect earlier tests.
    expect(sharedSession.state).toBe('active');
    await sharedSession.close();
    expect(sharedSession.state).toBe('closed');
  });
});
