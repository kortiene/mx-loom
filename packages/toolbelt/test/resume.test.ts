/**
 * Unit tests for resumeSession (T302). Uses an injected FakeClient so no
 * socket, subprocess, or daemon is needed. The heartbeat is always disabled in
 * these tests; timing is injected where needed.
 *
 * Coverage:
 * - Re-registers via the idempotent upsert against a fake client, reusing the
 *   persisted room, correlation_id, and kind from the descriptor
 * - Returns a live MxSession with the correct agentId, room, correlationId
 * - Reconstructs the plan (calls task.list) and returns a PlanSnapshot
 * - `resumed` flag reflects agent-id continuity (true) vs room-keyed recovery (false)
 * - A failed agent.register rejects with the TransportError; no zombie session left
 * - An invalid descriptor is rejected before any I/O (invalid_args)
 * - A task.list fault yields an empty-but-valid PlanSnapshot (never throws)
 * - Non-re-dispatch invariant: resumeSession only calls agent.register + task.list;
 *   no dispatch or execute RPCs are issued
 * - Descriptor cursor is threaded through to the plan cursor
 */
import { describe, expect, it } from 'vitest';

import type { AgentState } from '../src/agent-state.js';
import type { MxClient as MxClientType } from '../src/client.js';
import type { DaemonStatus } from '../src/ipc/types.js';
import { resumeSession } from '../src/resume.js';
import type { SessionDescriptor } from '../src/session-descriptor.js';
import { TransportError } from '../src/transport.js';
import type { CallOptions } from '../src/transport.js';

// ---------------------------------------------------------------------------
// FakeClient (mirrors the pattern from session.unit.test.ts)
// ---------------------------------------------------------------------------

type Behavior = { result: unknown } | { err: string };

class FakeClient {
  callCount = 0;
  closeCount = 0;
  readonly seenMethods: string[] = [];
  readonly seenParams: unknown[] = [];

  readonly #methodQueues = new Map<string, Behavior[]>();
  #defaultBehavior: Behavior = { result: undefined };

  whenMethod(method: string, ...behaviors: Behavior[]): this {
    this.#methodQueues.set(method, [...behaviors]);
    return this;
  }

  withDefault(behavior: Behavior): this {
    this.#defaultBehavior = behavior;
    return this;
  }

  async call(method: string, params?: unknown, _options?: CallOptions): Promise<unknown> {
    this.callCount++;
    this.seenMethods.push(method);
    this.seenParams.push(params);
    const queue = this.#methodQueues.get(method);
    let b: Behavior;
    if (queue !== undefined && queue.length > 0) {
      b = queue.length === 1 ? (queue[0] as Behavior) : (queue.shift() as Behavior);
    } else {
      b = this.#defaultBehavior;
    }
    if ('err' in b) throw new TransportError(b.err as never, `fake ${b.err} for ${method}`);
    return b.result;
  }

  async status(_opts?: CallOptions): Promise<DaemonStatus> {
    return { running: true, pid: 1, uptime_seconds: 0, socket_path: '', version: '0.0.0' };
  }
  async ping(_opts?: CallOptions): Promise<unknown> { return {}; }
  async close(): Promise<void> { this.closeCount++; }
  get activeTransport(): 'ipc' | 'cli' | null { return null; }
}

function asClient(f: FakeClient): MxClientType {
  return f as unknown as MxClientType;
}

// ---------------------------------------------------------------------------
// Fixtures — synthetic, no real credentials
// ---------------------------------------------------------------------------

const FAKE_AGENT_STATE: AgentState = {
  agent_id: 'agent-test-abc123',
  kind: 'runtime',
  matrix_user_id: '@testruntime:localhost',
  device_id: 'DEVICETEST',
  signing_key_id: 'mxagent-ed25519:TESTKEYID',
  signing_public_key: 'dGVzdC1wdWJsaWMta2V5LWJhc2U2NA==',
  status: 'active',
  capabilities: [],
  tools: [],
  workspace: { cwd: '/tmp/test', project_id: 'proj-test', git_commit: 'abc1234' },
  load: { running_invocations: 0, max_invocations: 10 },
  last_seen_ts: 1_700_000_000_000,
  state_rev: 1,
};

const FAKE_AGENT_STATE_NEW_ID: AgentState = {
  ...FAKE_AGENT_STATE,
  agent_id: 'agent-test-NEW-ID',
};

const DESCRIPTOR: SessionDescriptor = {
  v: 1,
  agent_id: 'agent-test-abc123',
  room: '!myroom:server',
  correlation_id: 'corr_persisted-id',
  kind: 'runtime',
};

// ---------------------------------------------------------------------------
// resumeSession — session re-registration
// ---------------------------------------------------------------------------

describe('resumeSession — session re-registration', () => {
  it('calls agent.register exactly once', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('task.list', { result: [] });
    await resumeSession(DESCRIPTOR, { client: asClient(client), heartbeat: false });
    const registerCalls = client.seenMethods.filter((m) => m === 'agent.register');
    expect(registerCalls).toHaveLength(1);
  });

  it('re-registers with the persisted room', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('task.list', { result: [] });
    await resumeSession(DESCRIPTOR, { client: asClient(client), heartbeat: false });
    const registerParams = client.seenParams[0] as Record<string, unknown>;
    expect(registerParams['room']).toBe('!myroom:server');
  });

  it('re-registers with the persisted kind', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('task.list', { result: [] });
    await resumeSession(DESCRIPTOR, { client: asClient(client), heartbeat: false });
    const registerParams = client.seenParams[0] as Record<string, unknown>;
    expect(registerParams['kind']).toBe('runtime');
  });

  it('omits kind from register params when descriptor has no kind', async () => {
    const { kind: _k, ...noKind } = DESCRIPTOR;
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('task.list', { result: [] });
    await resumeSession(noKind as SessionDescriptor, { client: asClient(client), heartbeat: false });
    const registerParams = client.seenParams[0] as Record<string, unknown>;
    expect(registerParams['kind']).toBeUndefined();
  });

  it('reuses the persisted correlation_id on the returned session', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('task.list', { result: [] });
    const { session } = await resumeSession(DESCRIPTOR, { client: asClient(client), heartbeat: false });
    expect(session.correlationId).toBe('corr_persisted-id');
  });

  it('the returned session has the persisted room', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('task.list', { result: [] });
    const { session } = await resumeSession(DESCRIPTOR, { client: asClient(client), heartbeat: false });
    expect(session.room).toBe('!myroom:server');
  });

  it('the returned session is active (not in error state)', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('task.list', { result: [] });
    const { session } = await resumeSession(DESCRIPTOR, { client: asClient(client), heartbeat: false });
    expect(session.state).toBe('active');
  });

  it('the returned session exposes the agent_id from the register response', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('task.list', { result: [] });
    const { session } = await resumeSession(DESCRIPTOR, { client: asClient(client), heartbeat: false });
    expect(session.agentId).toBe(FAKE_AGENT_STATE.agent_id);
  });
});

// ---------------------------------------------------------------------------
// resumeSession — registration config is threaded to the re-register
// ---------------------------------------------------------------------------
// max_invocations is REQUIRED by agent.register on v0.2.1; capabilities/tools/workspace
// are the runtime's own static config. They are NOT session state (so not in the
// descriptor), but they must reach the re-`agent.register` via ResumeOptions or the
// re-register would be degraded and rejected by a live daemon.

describe('resumeSession — registration config threaded to the re-register', () => {
  it('forwards maxInvocations as the flat max_invocations register param', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('task.list', { result: [] });
    await resumeSession(DESCRIPTOR, { client: asClient(client), heartbeat: false, maxInvocations: 10 });
    const registerParams = client.seenParams[0] as Record<string, unknown>;
    expect(registerParams['max_invocations']).toBe(10);
  });

  it('forwards capabilities and tools to the re-register', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('task.list', { result: [] });
    await resumeSession(DESCRIPTOR, {
      client: asClient(client),
      heartbeat: false,
      capabilities: ['code.write'],
      tools: [{ name: 'mx_list_tasks' }],
    });
    const registerParams = client.seenParams[0] as Record<string, unknown>;
    expect(registerParams['capabilities']).toEqual(['code.write']);
    expect(registerParams['tools']).toEqual([{ name: 'mx_list_tasks' }]);
  });

  it('flattens workspace into cwd / project_id / git_commit register params (v0.2.1 shape)', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('task.list', { result: [] });
    await resumeSession(DESCRIPTOR, {
      client: asClient(client),
      heartbeat: false,
      workspace: { cwd: '/work', project_id: 'proj-x', git_commit: 'deadbee' },
    });
    const registerParams = client.seenParams[0] as Record<string, unknown>;
    expect(registerParams['cwd']).toBe('/work');
    expect(registerParams['project_id']).toBe('proj-x');
    expect(registerParams['git_commit']).toBe('deadbee');
    // The nested object is flattened, never sent as a `workspace` param.
    expect(registerParams['workspace']).toBeUndefined();
  });

  it('options.kind overrides the descriptor kind on the re-register', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('task.list', { result: [] });
    await resumeSession(DESCRIPTOR, { client: asClient(client), heartbeat: false, kind: 'worker' });
    const registerParams = client.seenParams[0] as Record<string, unknown>;
    expect(registerParams['kind']).toBe('worker');
  });

  it('falls back to the descriptor kind when no kind option is given', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('task.list', { result: [] });
    await resumeSession(DESCRIPTOR, { client: asClient(client), heartbeat: false });
    const registerParams = client.seenParams[0] as Record<string, unknown>;
    expect(registerParams['kind']).toBe('runtime');
  });

  it('omits the register config params when none are supplied (no degraded extra keys)', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('task.list', { result: [] });
    await resumeSession(DESCRIPTOR, { client: asClient(client), heartbeat: false });
    const registerParams = client.seenParams[0] as Record<string, unknown>;
    expect(registerParams['max_invocations']).toBeUndefined();
    expect(registerParams['capabilities']).toBeUndefined();
    expect(registerParams['tools']).toBeUndefined();
    expect(registerParams['cwd']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resumeSession — resumed flag
// ---------------------------------------------------------------------------

describe('resumeSession — resumed flag (agent-id continuity)', () => {
  it('resumed: true when the daemon re-issues the descriptor\'s agent_id', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('task.list', { result: [] });
    const { resumed } = await resumeSession(DESCRIPTOR, { client: asClient(client), heartbeat: false });
    expect(resumed).toBe(true);
  });

  it('resumed: false when the daemon issues a different agent_id (room-keyed recovery)', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE_NEW_ID })
      .whenMethod('task.list', { result: [] });
    const { resumed } = await resumeSession(DESCRIPTOR, { client: asClient(client), heartbeat: false });
    expect(resumed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resumeSession — plan reconstruction
// ---------------------------------------------------------------------------

describe('resumeSession — plan reconstruction', () => {
  it('calls task.list to reconstruct the plan', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('task.list', { result: [] });
    await resumeSession(DESCRIPTOR, { client: asClient(client), heartbeat: false });
    expect(client.seenMethods).toContain('task.list');
  });

  it('passes the room to task.list', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('task.list', { result: [] });
    await resumeSession(DESCRIPTOR, { client: asClient(client), heartbeat: false });
    const taskListIdx = client.seenMethods.indexOf('task.list');
    const params = client.seenParams[taskListIdx] as Record<string, unknown>;
    expect(params['room']).toBe('!myroom:server');
  });

  it('returns a PlanSnapshot with the correct room', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('task.list', { result: [{ task_id: 't1', state: 'succeeded' }] });
    const { plan } = await resumeSession(DESCRIPTOR, { client: asClient(client), heartbeat: false });
    expect(plan.room).toBe('!myroom:server');
    expect(plan.fault).toBeUndefined();
  });

  it('plan contains the tasks from task.list', async () => {
    const rows = [
      { task_id: 't1', state: 'succeeded' },
      { task_id: 't2', state: 'pending', depends_on: ['t1'] },
    ];
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('task.list', { result: rows });
    const { plan } = await resumeSession(DESCRIPTOR, { client: asClient(client), heartbeat: false });
    expect(plan.tasks).toHaveLength(2);
    expect(plan.reconciliation.done).toContain('t1');
    expect(plan.reconciliation.ready).toContain('t2');
  });

  it('threads the descriptor cursor to the plan cursor', async () => {
    const descriptorWithCursor: SessionDescriptor = { ...DESCRIPTOR, cursor: { state_rev: 5 } };
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('task.list', { result: [{ task_id: 't1', state_rev: 3 }] });
    const { plan } = await resumeSession(descriptorWithCursor, { client: asClient(client), heartbeat: false });
    // The cursor high-water mark should be max(descriptor.cursor.state_rev, max-row-rev) = max(5, 3) = 5
    expect(plan.cursor.state_rev).toBe(5);
  });

  it('plan has an empty-but-valid snapshot when task.list faults (never throws)', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('task.list', { err: 'rpc' });
    const { plan } = await resumeSession(DESCRIPTOR, { client: asClient(client), heartbeat: false });
    expect(plan.tasks).toEqual([]);
    expect(plan.fault).toBe('rpc');
  });

  it('a task.list fault does not prevent the session from being returned', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('task.list', { err: 'not_running' });
    const { session } = await resumeSession(DESCRIPTOR, { client: asClient(client), heartbeat: false });
    expect(session.agentId).toBe(FAKE_AGENT_STATE.agent_id);
  });
});

// ---------------------------------------------------------------------------
// resumeSession — failure modes
// ---------------------------------------------------------------------------

describe('resumeSession — register failure', () => {
  it('rejects with a TransportError when agent.register fails', async () => {
    const client = new FakeClient().whenMethod('agent.register', { err: 'timeout' });
    await expect(
      resumeSession(DESCRIPTOR, { client: asClient(client), heartbeat: false }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('rejects with code "protocol" when agent.register returns a non-object', async () => {
    const client = new FakeClient().whenMethod('agent.register', { result: 'not-an-object' });
    await expect(
      resumeSession(DESCRIPTOR, { client: asClient(client), heartbeat: false }),
    ).rejects.toMatchObject({ code: 'protocol' });
  });

  it('does not close the injected client on a register failure', async () => {
    const client = new FakeClient().whenMethod('agent.register', { err: 'rpc' });
    await resumeSession(DESCRIPTOR, { client: asClient(client), heartbeat: false }).catch(() => undefined);
    expect(client.closeCount).toBe(0);
  });

  it('does not leave a half-open session after a register failure (no call to task.list)', async () => {
    const client = new FakeClient().whenMethod('agent.register', { err: 'connect_failed' });
    await resumeSession(DESCRIPTOR, { client: asClient(client), heartbeat: false }).catch(() => undefined);
    expect(client.seenMethods).not.toContain('task.list');
  });
});

describe('resumeSession — descriptor validation', () => {
  it('rejects an invalid descriptor before any I/O', async () => {
    const badDescriptor = { v: 1, agent_id: '', room: '!r:srv', correlation_id: 'corr_x' };
    const client = new FakeClient();
    await expect(
      resumeSession(badDescriptor as unknown as SessionDescriptor, { client: asClient(client), heartbeat: false }),
    ).rejects.toMatchObject({ code: 'invalid_args' });
    expect(client.callCount).toBe(0);
  });

  it('rejects a descriptor with an unsupported version before any I/O', async () => {
    const badDescriptor = { v: 99, agent_id: 'agent-x', room: '!r:srv', correlation_id: 'corr_x' };
    const client = new FakeClient();
    await expect(
      resumeSession(badDescriptor as unknown as SessionDescriptor, { client: asClient(client), heartbeat: false }),
    ).rejects.toMatchObject({ code: 'invalid_args' });
    expect(client.callCount).toBe(0);
  });

  it('rejects a descriptor with a credential-shaped field before any I/O', async () => {
    const badDescriptor = {
      v: 1,
      agent_id: 'agent-x',
      room: '!r:srv',
      correlation_id: 'corr_x',
      auth_token: 'should-fail',
    };
    const client = new FakeClient();
    await expect(
      resumeSession(badDescriptor as unknown as SessionDescriptor, { client: asClient(client), heartbeat: false }),
    ).rejects.toMatchObject({ code: 'invalid_args' });
    expect(client.callCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resumeSession — non-re-dispatch invariant
// ---------------------------------------------------------------------------

describe('resumeSession — non-re-dispatch invariant', () => {
  it('only calls agent.register and task.list — no dispatch or execute RPCs', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('task.list', { result: [] });
    await resumeSession(DESCRIPTOR, { client: asClient(client), heartbeat: false });
    const dispatchLike = client.seenMethods.filter(
      (m) =>
        m.includes('.start') ||
        m.includes('.execute') ||
        m.includes('.dispatch') ||
        m.includes('.run') ||
        m.includes('task.create') ||
        m.includes('task.update'),
    );
    expect(dispatchLike).toHaveLength(0);
    // Only agent.register and task.list
    expect(client.seenMethods).toEqual(['agent.register', 'task.list']);
  });
});

// ---------------------------------------------------------------------------
// T302 acceptance criterion — integrated resumption narrative
// ---------------------------------------------------------------------------

describe('resumeSession — T302 acceptance criterion (integrated narrative)', () => {
  it('resumes the plan from task state on a killed-and-restarted runtime', async () => {
    // Simulates the T302 acceptance criterion:
    //   1. Prior process observed t1 (succeeded, rev=3) and t2 (pending dep on t1, rev=4).
    //      It persisted a descriptor with cursor state_rev=4.
    //   2. New process calls resumeSession with that descriptor.
    //   3. Resumed session re-registers (same room + correlation) → agent-id continuity.
    //   4. task.list returns the same tasks — t1 done, t2 ready (dep satisfied).
    //   5. plan.reconciliation reflects the live plan state for the new cognition.
    //   6. plan.cursor high-water mark = max(descriptor.cursor.state_rev=4, max-row-rev=4) = 4.
    const descriptorWithCursor: SessionDescriptor = {
      ...DESCRIPTOR,
      cursor: { state_rev: 4 },
    };
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('task.list', {
        result: [
          { task_id: 't1', state: 'succeeded', state_rev: 3, depends_on: [], blocks: [] },
          { task_id: 't2', state: 'pending',   state_rev: 4, depends_on: ['t1'], blocks: [] },
        ],
      });

    const { session, plan, resumed } = await resumeSession(descriptorWithCursor, {
      client: asClient(client),
      heartbeat: false,
    });

    // Agent-id continuity: same id re-issued by daemon
    expect(resumed).toBe(true);
    expect(session.agentId).toBe(FAKE_AGENT_STATE.agent_id);
    expect(session.room).toBe(DESCRIPTOR.room);

    // Plan reconstruction reflects live state
    expect(plan.room).toBe(DESCRIPTOR.room);
    expect(plan.tasks).toHaveLength(2);
    expect(plan.fault).toBeUndefined();
    expect(plan.reconciliation.done).toContain('t1');     // succeeded → done
    expect(plan.reconciliation.ready).toContain('t2');    // dep on t1 satisfied → ready
    expect(plan.reconciliation.inFlight).toHaveLength(0);
    expect(plan.reconciliation.blocked).toHaveLength(0);

    // Cursor high-water mark = max(descriptor.cursor=4, max-row-rev=4) = 4
    expect(plan.cursor.state_rev).toBe(4);

    await session.close();
  });

  it('resumes with room-keyed recovery when daemon issues a new agent_id', async () => {
    // resumed=false when the daemon does not re-issue the same agent_id; the plan is
    // still recovered by room — the session and plan are valid regardless.
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE_NEW_ID })
      .whenMethod('task.list', {
        result: [{ task_id: 'tx', state: 'executing', state_rev: 2 }],
      });

    const { session, plan, resumed } = await resumeSession(DESCRIPTOR, {
      client: asClient(client),
      heartbeat: false,
    });

    expect(resumed).toBe(false); // different agent_id — honest disclosure
    expect(session.agentId).toBe(FAKE_AGENT_STATE_NEW_ID.agent_id);
    expect(plan.room).toBe(DESCRIPTOR.room);
    expect(plan.reconciliation.inFlight).toContain('tx'); // executing → inFlight
    expect(plan.fault).toBeUndefined();

    await session.close();
  });

  it('degrades to empty-but-valid plan when task.list faults, session still usable', async () => {
    // A task.list fault yields an empty snapshot with a fault code; the session is
    // returned and usable — a restarted runtime degrades to "no plan recovered".
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('task.list', { err: 'timeout' });

    const { session, plan } = await resumeSession(DESCRIPTOR, {
      client: asClient(client),
      heartbeat: false,
    });

    expect(session.agentId).toBe(FAKE_AGENT_STATE.agent_id);
    expect(plan.tasks).toEqual([]);
    expect(plan.edges).toEqual([]);
    expect(plan.reconciliation).toEqual({ done: [], inFlight: [], ready: [], blocked: [] });
    expect(plan.fault).toBe('timeout');

    await session.close();
  });

  it('cursor from a prior run prevents higher-rev task list from regressing the high-water mark', async () => {
    // The prior run observed state_rev=10; the resumed task.list returns tasks at
    // max rev=7 (stale snapshot) — the cursor must NOT regress to 7.
    const descriptorHighCursor: SessionDescriptor = {
      ...DESCRIPTOR,
      cursor: { state_rev: 10 },
    };
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('task.list', {
        result: [{ task_id: 't1', state: 'succeeded', state_rev: 7 }],
      });

    const { plan } = await resumeSession(descriptorHighCursor, {
      client: asClient(client),
      heartbeat: false,
    });

    // max(descriptor.cursor=10, max-row-rev=7) = 10 — never regresses
    expect(plan.cursor.state_rev).toBe(10);
  });
});
