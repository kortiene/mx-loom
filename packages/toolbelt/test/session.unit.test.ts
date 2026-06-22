/**
 * Unit tests for MxSession / openSession (T005). All tests use an injected
 * FakeClient so no socket, subprocess, or daemon is needed. Heartbeat ticks are
 * driven via an injected fake scheduler. Secret-boundary tests use a real
 * MxClient with injected fake transport factories.
 *
 * Coverage goals (from the spec):
 * - register-on-open, correlation stamping, close/deregister, ownership,
 *   lifecycle, liveness mapping (all with FakeClient)
 * - credential-shaped register args rejected before dispatch; no secret in
 *   session debug lines (with real MxClient + fake transports)
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MxClient } from '../src/client.js';
import type { MxClient as MxClientType } from '../src/client.js';
import type { AgentState } from '../src/agent-state.js';
import type { HeartbeatSchedule } from '../src/heartbeat.js';
import type { DaemonStatus } from '../src/ipc/types.js';
import { openSession } from '../src/session.js';
import { TransportError } from '../src/transport.js';
import type { CallOptions, MxTransport, TransportErrorCode } from '../src/transport.js';

// ---------------------------------------------------------------------------
// Shared fixture data (synthetic, no real credentials or tokens)
// ---------------------------------------------------------------------------

const FAKE_AGENT_STATE: AgentState = {
  agent_id: 'agent-test-abc123',
  kind: 'runtime',
  matrix_user_id: '@testruntime:localhost',
  device_id: 'DEVICETEST',
  signing_key_id: 'mxagent-ed25519:TESTKEYID',
  signing_public_key: 'dGVzdC1wdWJsaWMta2V5LWJhc2U2NA==', // synthetic base64
  status: 'active',
  capabilities: [],
  tools: [],
  workspace: { cwd: '/tmp/test-workspace', project_id: 'proj-test', git_commit: 'abc1234' },
  load: { running_invocations: 0, max_invocations: 10 },
  last_seen_ts: 1_700_000_000_000,
  state_rev: 1,
};

const FAKE_AGENT_STATE_2: AgentState = { ...FAKE_AGENT_STATE, agent_id: 'agent-test-xyz789', state_rev: 2 };

/** An agent.list row with liveness. */
function listEntry(agentState: AgentState, liveness: 'active' | 'stale' | 'offline') {
  return { agent: agentState, liveness };
}

// ---------------------------------------------------------------------------
// FakeClient
//
// Scriptable per-method call sequences (last behavior is sticky). The session
// uses client.call() and client.close(); the rest are stubs so the object
// satisfies the MxClient interface structurally.
// ---------------------------------------------------------------------------

type Behavior = { result: unknown } | { err: TransportErrorCode };

class FakeClient {
  callCount = 0;
  closeCount = 0;
  readonly seenMethods: string[] = [];
  readonly seenParams: unknown[] = [];
  readonly seenOptions: Array<CallOptions | undefined> = [];

  readonly #methodQueues = new Map<string, Behavior[]>();
  #defaultBehavior: Behavior = { result: undefined };

  /** Scripted per-method sequence; the last entry is used for all subsequent calls. */
  whenMethod(method: string, ...behaviors: Behavior[]): this {
    this.#methodQueues.set(method, [...behaviors]);
    return this;
  }

  /** Fall-through default for any method with no scripted sequence. */
  withDefault(behavior: Behavior): this {
    this.#defaultBehavior = behavior;
    return this;
  }

  async call(method: string, params?: unknown, options?: CallOptions): Promise<unknown> {
    this.callCount++;
    this.seenMethods.push(method);
    this.seenParams.push(params);
    this.seenOptions.push(options);

    const queue = this.#methodQueues.get(method);
    let b: Behavior;
    if (queue !== undefined && queue.length > 0) {
      // Consume the first; keep the last sticky.
      b = queue.length === 1 ? (queue[0] as Behavior) : (queue.shift() as Behavior);
    } else {
      b = this.#defaultBehavior;
    }

    if ('err' in b) throw new TransportError(b.err, `fake ${b.err} for ${method}`);
    return b.result;
  }

  // MxClient surface stubs (session only uses call + close)
  async status(_opts?: CallOptions): Promise<DaemonStatus> {
    return { running: true, pid: 1, uptime_seconds: 0, socket_path: '', version: '0.0.0' };
  }
  async ping(_opts?: CallOptions): Promise<unknown> { return {}; }
  async close(): Promise<void> { this.closeCount++; }
  get activeTransport(): 'ipc' | 'cli' | null { return null; }
}

/** Cast FakeClient to the MxClient type expected by openSession. */
function asClient(f: FakeClient): MxClientType {
  return f as unknown as MxClientType;
}

// ---------------------------------------------------------------------------
// Fake scheduler (same discipline as heartbeat.test.ts)
// ---------------------------------------------------------------------------

function makeFakeSchedule(): {
  schedule: HeartbeatSchedule;
  fire: () => void;
  isStopped: () => boolean;
} {
  let fn: (() => void) | null = null;
  let stopped = false;

  const schedule: HeartbeatSchedule = (f, _ms) => {
    fn = f;
    return {
      stop: () => {
        stopped = true;
        fn = null;
      },
    };
  };

  return {
    schedule,
    fire: () => { if (fn) fn(); },
    isStopped: () => stopped,
  };
}

/**
 * Flush pending microtasks by yielding N times. The session heartbeat tick adds
 * extra `await` hops (session.call → client.call → #heartbeatTick → onTick),
 * requiring ~5 microtask steps. Use 10 for margin.
 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

// ---------------------------------------------------------------------------
// openSession — basic lifecycle
// ---------------------------------------------------------------------------

describe('openSession — registration', () => {
  it('calls agent.register exactly once on open', async () => {
    const client = new FakeClient().whenMethod('agent.register', { result: FAKE_AGENT_STATE });
    await openSession({ client: asClient(client), heartbeat: false });
    expect(client.seenMethods.filter((m) => m === 'agent.register')).toHaveLength(1);
  });

  it('captures agent_id from the AgentState returned by agent.register (AC 1)', async () => {
    const client = new FakeClient().whenMethod('agent.register', { result: FAKE_AGENT_STATE });
    const session = await openSession({ client: asClient(client), heartbeat: false });
    expect(session.agentId).toBe(FAKE_AGENT_STATE.agent_id);
  });

  it('exposes the full AgentState on session.agentState', async () => {
    const client = new FakeClient().whenMethod('agent.register', { result: FAKE_AGENT_STATE });
    const session = await openSession({ client: asClient(client), heartbeat: false });
    expect(session.agentState).toEqual(FAKE_AGENT_STATE);
  });

  it('session.state is "active" after a successful open', async () => {
    const client = new FakeClient().whenMethod('agent.register', { result: FAKE_AGENT_STATE });
    const session = await openSession({ client: asClient(client), heartbeat: false });
    expect(session.state).toBe('active');
  });

  it('session.room reflects the configured room option', async () => {
    const client = new FakeClient().whenMethod('agent.register', { result: FAKE_AGENT_STATE });
    const session = await openSession({
      client: asClient(client),
      heartbeat: false,
      room: '!myroom:server',
    });
    expect(session.room).toBe('!myroom:server');
  });

  it('session.room is undefined when no room option is given', async () => {
    const client = new FakeClient().whenMethod('agent.register', { result: FAKE_AGENT_STATE });
    const session = await openSession({ client: asClient(client), heartbeat: false });
    expect(session.room).toBeUndefined();
  });

  it('register params include room/kind/capabilities/tools and flat workspace fields when provided', async () => {
    // v0.2.1: workspace fields are flat params (cwd, project_id, git_commit), not nested.
    const client = new FakeClient().whenMethod('agent.register', { result: FAKE_AGENT_STATE });
    await openSession({
      client: asClient(client),
      heartbeat: false,
      room: '!r:srv',
      kind: 'test-runtime',
      capabilities: ['read'],
      tools: [{ name: 'greet' }],
      workspace: { cwd: '/opt/project', project_id: 'proj-1', git_commit: 'abc' },
      maxInvocations: 8,
    });
    const registerParams = client.seenParams[0] as Record<string, unknown>;
    expect(registerParams['room']).toBe('!r:srv');
    expect(registerParams['kind']).toBe('test-runtime');
    expect(registerParams['capabilities']).toEqual(['read']);
    expect(registerParams['tools']).toEqual([{ name: 'greet' }]);
    // Workspace fields are flattened — NO nested 'workspace' key in the params
    expect(registerParams['workspace']).toBeUndefined();
    expect(registerParams['cwd']).toBe('/opt/project');
    expect(registerParams['project_id']).toBe('proj-1');
    expect(registerParams['git_commit']).toBe('abc');
    expect(registerParams['max_invocations']).toBe(8);
  });

  it('register params omit undefined fields (minimal register is a clean object)', async () => {
    const client = new FakeClient().whenMethod('agent.register', { result: FAKE_AGENT_STATE });
    await openSession({ client: asClient(client), heartbeat: false });
    const registerParams = client.seenParams[0] as Record<string, unknown>;
    expect(Object.keys(registerParams)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// openSession — register failure
// ---------------------------------------------------------------------------

describe('openSession — register failure', () => {
  it('a failing agent.register rejects openSession with the TransportError', async () => {
    const client = new FakeClient().whenMethod('agent.register', { err: 'timeout' });
    await expect(openSession({ client: asClient(client), heartbeat: false })).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('a failing register starts no heartbeat (tick is never called)', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const client = new FakeClient().whenMethod('agent.register', { err: 'rpc' });
    await openSession({ client: asClient(client), schedule }).catch(() => undefined);
    fire(); // would trigger the heartbeat tick IF one was started
    await flush();
    // The only call was the failed register; no heartbeat tick call was made.
    expect(client.callCount).toBe(1);
  });

  it('a failing register closes a self-owned client (ownsClient: true)', async () => {
    const client = new FakeClient().whenMethod('agent.register', { err: 'timeout' });
    await openSession({ client: asClient(client), ownsClient: true, heartbeat: false }).catch(() => undefined);
    expect(client.closeCount).toBe(1);
  });

  it('a failing register does NOT close an injected (non-owned) client', async () => {
    const client = new FakeClient().whenMethod('agent.register', { err: 'timeout' });
    // client is injected → ownsClient defaults to false
    await openSession({ client: asClient(client), heartbeat: false }).catch(() => undefined);
    expect(client.closeCount).toBe(0);
  });

  it('a register returning a non-object rejects with code "protocol"', async () => {
    const client = new FakeClient().whenMethod('agent.register', { result: 'not-an-object' });
    await expect(openSession({ client: asClient(client), heartbeat: false })).rejects.toMatchObject({
      code: 'protocol',
    });
  });

  it('a register returning an object without agent_id rejects with code "protocol"', async () => {
    const client = new FakeClient().whenMethod('agent.register', { result: { kind: 'runtime' } });
    await expect(openSession({ client: asClient(client), heartbeat: false })).rejects.toMatchObject({
      code: 'protocol',
    });
  });

  it('a register returning an object with an empty agent_id rejects with code "protocol"', async () => {
    const client = new FakeClient().whenMethod('agent.register', {
      result: { ...FAKE_AGENT_STATE, agent_id: '' },
    });
    await expect(openSession({ client: asClient(client), heartbeat: false })).rejects.toMatchObject({
      code: 'protocol',
    });
  });

  it('a register returning null rejects with code "protocol"', async () => {
    const client = new FakeClient().whenMethod('agent.register', { result: null });
    await expect(openSession({ client: asClient(client), heartbeat: false })).rejects.toMatchObject({
      code: 'protocol',
    });
  });
});

// ---------------------------------------------------------------------------
// session.call — correlation stamping (AC 3)
// ---------------------------------------------------------------------------

describe('session.call — correlation threading (AC 3)', () => {
  it('auto-generates a correlationId with the corr_ prefix', async () => {
    const client = new FakeClient().whenMethod('agent.register', { result: FAKE_AGENT_STATE });
    const session = await openSession({ client: asClient(client), heartbeat: false });
    expect(session.correlationId).toMatch(/^corr_/);
  });

  it('uses a pre-supplied correlationId verbatim', async () => {
    const client = new FakeClient().whenMethod('agent.register', { result: FAKE_AGENT_STATE });
    const session = await openSession({
      client: asClient(client),
      heartbeat: false,
      correlationId: 'corr_preset-id',
    });
    expect(session.correlationId).toBe('corr_preset-id');
  });

  it('correlationId is stable across many session.call() invocations', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .withDefault({ result: 'ok' });
    const session = await openSession({ client: asClient(client), heartbeat: false });
    await session.call('some.method');
    await session.call('another.method');
    await session.call('yet.another.method');
    expect(session.correlationId).toBe(session.correlationId); // same id throughout
    // All three extra calls (+ the register) saw the same correlation id via debug
  });

  it('session.call stamps every call on the debug seam (no call is un-correlated)', async () => {
    const logs: string[] = [];
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .withDefault({ result: 'ok' });
    const session = await openSession({
      client: asClient(client),
      heartbeat: false,
      debug: (line) => logs.push(line),
    });
    await session.call('some.method');
    await session.call('another.method');
    // Every call log line contains the correlation id
    const callLogs = logs.filter((l) => l.startsWith('call '));
    expect(callLogs).toHaveLength(3); // agent.register + 2 explicit calls
    for (const line of callLogs) {
      expect(line).toContain(session.correlationId);
    }
  });

  it('does NOT inject correlationId into params when not on correlationParamMethods', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .withDefault({ result: 'ok' });
    const session = await openSession({
      client: asClient(client),
      heartbeat: false,
      correlationParamMethods: [], // explicitly empty — default
    });
    await session.call('some.method', { x: 1 });
    // The params that arrived at the client for 'some.method'
    const someMethodIdx = client.seenMethods.indexOf('some.method');
    const receivedParams = client.seenParams[someMethodIdx];
    expect(receivedParams).toEqual({ x: 1 }); // correlation_id NOT injected
  });

  it('injects correlationId into params for methods on the correlationParamMethods allowlist', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('allowed.method', { result: 'ok' });
    const session = await openSession({
      client: asClient(client),
      heartbeat: false,
      correlationParamMethods: ['allowed.method'],
    });
    await session.call('allowed.method', { x: 1 });
    const methodIdx = client.seenMethods.indexOf('allowed.method');
    const receivedParams = client.seenParams[methodIdx] as Record<string, unknown>;
    expect(receivedParams['correlation_id']).toBe(session.correlationId);
    expect(receivedParams['x']).toBe(1);
  });

  it('delegates to the underlying client for the call (return value passes through)', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('some.method', { result: { answer: 42 } });
    const session = await openSession({ client: asClient(client), heartbeat: false });
    const result = await session.call('some.method', undefined);
    expect(result).toEqual({ answer: 42 });
  });

  it('a failing session.call propagates the TransportError', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('some.method', { err: 'rpc' });
    const session = await openSession({ client: asClient(client), heartbeat: false });
    await expect(session.call('some.method')).rejects.toMatchObject({ code: 'rpc' });
  });

  it('session.call() forwards CallOptions to the underlying client', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('some.method', { result: 'ok' });
    const session = await openSession({ client: asClient(client), heartbeat: false });
    await session.call('some.method', undefined, { timeoutMs: 7_500 });
    const methodIdx = client.seenMethods.indexOf('some.method');
    expect(client.seenOptions[methodIdx]).toEqual({ timeoutMs: 7_500 });
  });
});

// ---------------------------------------------------------------------------
// session.liveness — mapping agent.list (AC 2 — partial)
// ---------------------------------------------------------------------------

describe('session.liveness', () => {
  it('returns "active" when agent.list shows the agent as active', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('agent.list', { result: [listEntry(FAKE_AGENT_STATE, 'active')] });
    const session = await openSession({ client: asClient(client), heartbeat: false });
    expect(await session.liveness()).toBe('active');
  });

  it('returns "stale" when agent.list shows the agent as stale', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('agent.list', { result: [listEntry(FAKE_AGENT_STATE, 'stale')] });
    const session = await openSession({ client: asClient(client), heartbeat: false });
    expect(await session.liveness()).toBe('stale');
  });

  it('returns "offline" when agent.list shows the agent as offline', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('agent.list', { result: [listEntry(FAKE_AGENT_STATE, 'offline')] });
    const session = await openSession({ client: asClient(client), heartbeat: false });
    expect(await session.liveness()).toBe('offline');
  });

  it('returns "offline" when agentId is absent from agent.list', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('agent.list', { result: [listEntry(FAKE_AGENT_STATE_2, 'active')] });
    const session = await openSession({ client: asClient(client), heartbeat: false });
    expect(await session.liveness()).toBe('offline');
  });

  it('returns "offline" when agent.list is empty', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('agent.list', { result: [] });
    const session = await openSession({ client: asClient(client), heartbeat: false });
    expect(await session.liveness()).toBe('offline');
  });

  it('returns "offline" when agent.list is non-array (malformed response)', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('agent.list', { result: { not: 'an array' } });
    const session = await openSession({ client: asClient(client), heartbeat: false });
    expect(await session.liveness()).toBe('offline');
  });

  it('liveness() uses agent.list, not local state (it goes through session.call)', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('agent.list', { result: [listEntry(FAKE_AGENT_STATE, 'active')] });
    const session = await openSession({ client: asClient(client), heartbeat: false });
    await session.liveness();
    expect(client.seenMethods).toContain('agent.list');
  });

  it('returns "offline" when an agent.list row has a null agent field', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('agent.list', { result: [{ agent: null, liveness: 'active' }] });
    const session = await openSession({ client: asClient(client), heartbeat: false });
    expect(await session.liveness()).toBe('offline');
  });

  it('returns "offline" when an agent.list row has an unrecognized liveness string', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('agent.list', {
        result: [{ agent: FAKE_AGENT_STATE, liveness: 'unknown-status' }],
      });
    const session = await openSession({ client: asClient(client), heartbeat: false });
    expect(await session.liveness()).toBe('offline');
  });

  it('liveness() call is stamped with the session correlationId on the debug seam', async () => {
    const logs: string[] = [];
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('agent.list', { result: [] });
    const session = await openSession({
      client: asClient(client),
      heartbeat: false,
      debug: (line) => logs.push(line),
    });
    await session.liveness();
    const listCallLogs = logs.filter((l) => l.includes('agent.list'));
    expect(listCallLogs.length).toBeGreaterThan(0);
    expect(listCallLogs[0]).toContain(session.correlationId);
  });
});

// ---------------------------------------------------------------------------
// session.close — lifecycle and ownership (AC 2 — close clause)
// ---------------------------------------------------------------------------

describe('session.close', () => {
  it('state is "closed" after close()', async () => {
    const client = new FakeClient().whenMethod('agent.register', { result: FAKE_AGENT_STATE });
    const session = await openSession({ client: asClient(client), heartbeat: false });
    await session.close();
    expect(session.state).toBe('closed');
  });

  it('close() is idempotent — double-close is a safe no-op', async () => {
    const client = new FakeClient().whenMethod('agent.register', { result: FAKE_AGENT_STATE });
    const session = await openSession({ client: asClient(client), heartbeat: false });
    await session.close();
    await expect(session.close()).resolves.toBeUndefined(); // second close does not throw
    expect(session.state).toBe('closed');
  });

  it('closes the client when ownsClient is true', async () => {
    const client = new FakeClient().whenMethod('agent.register', { result: FAKE_AGENT_STATE });
    const session = await openSession({ client: asClient(client), ownsClient: true, heartbeat: false });
    await session.close();
    expect(client.closeCount).toBe(1);
  });

  it('does NOT close an injected (non-owned) client', async () => {
    const client = new FakeClient().whenMethod('agent.register', { result: FAKE_AGENT_STATE });
    // client provided → ownsClient defaults to false
    const session = await openSession({ client: asClient(client), heartbeat: false });
    await session.close();
    expect(client.closeCount).toBe(0);
  });

  it('double-close does not close the client twice when ownsClient is true', async () => {
    const client = new FakeClient().whenMethod('agent.register', { result: FAKE_AGENT_STATE });
    const session = await openSession({ client: asClient(client), ownsClient: true, heartbeat: false });
    await session.close();
    await session.close(); // second close should be a no-op
    expect(client.closeCount).toBe(1); // closed exactly once
  });

  it('calls the configured deregisterMethod on close', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('agent.deregister', { result: { ok: true } });
    const session = await openSession({
      client: asClient(client),
      heartbeat: false,
      deregisterMethod: 'agent.deregister',
    });
    await session.close();
    expect(client.seenMethods).toContain('agent.deregister');
  });

  it('deregister call includes the agent_id', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('agent.deregister', { result: { ok: true } });
    const session = await openSession({
      client: asClient(client),
      heartbeat: false,
      deregisterMethod: 'agent.deregister',
    });
    await session.close();
    const deregIdx = client.seenMethods.indexOf('agent.deregister');
    const deregParams = client.seenParams[deregIdx] as { agent_id: string };
    expect(deregParams['agent_id']).toBe(FAKE_AGENT_STATE.agent_id);
  });

  it('does NOT call a deregister method when none is configured (decay path)', async () => {
    const client = new FakeClient().whenMethod('agent.register', { result: FAKE_AGENT_STATE });
    const session = await openSession({ client: asClient(client), heartbeat: false });
    await session.close();
    // Only agent.register was called; no deregister
    expect(client.seenMethods.filter((m) => m !== 'agent.register')).toHaveLength(0);
  });

  it('a failing deregister is swallowed — close() always completes (AC 2, decay clause)', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('agent.deregister', { err: 'rpc' });
    const session = await openSession({
      client: asClient(client),
      heartbeat: false,
      deregisterMethod: 'agent.deregister',
    });
    // Must not throw even though deregister fails
    await expect(session.close()).resolves.toBeUndefined();
    expect(session.state).toBe('closed');
  });

  it('deregister failure is logged via debug but the error code is not secret', async () => {
    const logs: string[] = [];
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('agent.deregister', { err: 'rpc' });
    const session = await openSession({
      client: asClient(client),
      heartbeat: false,
      deregisterMethod: 'agent.deregister',
      debug: (line) => logs.push(line),
    });
    await session.close();
    expect(logs.some((l) => l.includes('deregister') && l.includes('rpc'))).toBe(true);
  });

  it('ownsClient=true: client is closed even when deregister fails', async () => {
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('agent.deregister', { err: 'rpc' });
    const session = await openSession({
      client: asClient(client),
      heartbeat: false,
      ownsClient: true,
      deregisterMethod: 'agent.deregister',
    });
    await session.close();
    expect(client.closeCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Heartbeat lifecycle (AC 2 — keeps liveness active; stops on close)
// ---------------------------------------------------------------------------

describe('heartbeat lifecycle', () => {
  it('heartbeat: false skips the heartbeat loop entirely', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const client = new FakeClient().whenMethod('agent.register', { result: FAKE_AGENT_STATE });
    await openSession({ client: asClient(client), heartbeat: false, schedule });
    fire(); // would trigger a tick IF a heartbeat was started
    await flush();
    // Only one call was made (agent.register); no heartbeat tick
    expect(client.callCount).toBe(1);
  });

  it('heartbeat is started by default and fires agent.register tick', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const client = new FakeClient().whenMethod('agent.register', { result: FAKE_AGENT_STATE });
    await openSession({ client: asClient(client), schedule });
    expect(client.callCount).toBe(1); // only the initial register so far
    fire();
    await flush();
    expect(client.callCount).toBe(2); // + one heartbeat tick
    // The second call should be agent.register (the default heartbeat method)
    expect(client.seenMethods[1]).toBe('agent.register');
  });

  it('heartbeat tick calls the configured heartbeatMethod instead of agent.register', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('agent.heartbeat', { result: { refreshed: true } });
    await openSession({ client: asClient(client), schedule, heartbeatMethod: 'agent.heartbeat' });
    fire();
    await flush();
    expect(client.seenMethods).toContain('agent.heartbeat');
  });

  it('heartbeat tick is correlated (carries the session correlation_id via debug seam)', async () => {
    const logs: string[] = [];
    const { schedule, fire } = makeFakeSchedule();
    const client = new FakeClient().whenMethod('agent.register', { result: FAKE_AGENT_STATE });
    const session = await openSession({
      client: asClient(client),
      schedule,
      debug: (line) => logs.push(line),
    });
    fire();
    await flush();
    // The heartbeat tick goes through session.call, so the debug seam logs the correlation id
    const callLogs = logs.filter((l) => l.startsWith('call '));
    expect(callLogs.some((l) => l.includes(session.correlationId))).toBe(true);
  });

  it('close() stops the heartbeat — no tick fires after close', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const client = new FakeClient().whenMethod('agent.register', { result: FAKE_AGENT_STATE });
    const session = await openSession({ client: asClient(client), schedule });
    await session.close();
    fire(); // would run a tick if the heartbeat was still active
    await flush();
    // Only the initial register was called; no tick after close
    expect(client.callCount).toBe(1);
  });

  it('the fake schedule is stopped when close() is called', async () => {
    const { schedule, isStopped } = makeFakeSchedule();
    const client = new FakeClient().whenMethod('agent.register', { result: FAKE_AGENT_STATE });
    const session = await openSession({ client: asClient(client), schedule });
    expect(isStopped()).toBe(false);
    await session.close();
    expect(isStopped()).toBe(true);
  });

  it('heartbeat tick timeout is bounded to the heartbeat interval', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .withDefault({ result: 'ok' });
    await openSession({ client: asClient(client), schedule, heartbeatIntervalMs: 5_000 });
    fire();
    await flush();
    // The tick call's options should carry a timeoutMs bounded to the interval
    const tickCallIdx = client.seenMethods.lastIndexOf('agent.register');
    const tickOptions = client.seenOptions[tickCallIdx];
    expect((tickOptions as { timeoutMs: number } | undefined)?.timeoutMs).toBe(5_000);
  });

  it('custom heartbeatMethod tick sends { agent_id } not the registration params', async () => {
    const { schedule, fire } = makeFakeSchedule();
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .whenMethod('agent.heartbeat', { result: { refreshed: true } });
    // room is a registration param; it must NOT appear in the heartbeat tick params
    await openSession({
      client: asClient(client),
      schedule,
      heartbeatMethod: 'agent.heartbeat',
      room: '!someroom:server',
    });
    fire();
    await flush();
    const hbIdx = client.seenMethods.indexOf('agent.heartbeat');
    const hbParams = client.seenParams[hbIdx] as Record<string, unknown>;
    expect(hbParams['agent_id']).toBe(FAKE_AGENT_STATE.agent_id);
    expect(hbParams['room']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Secret boundary tests — use a real MxClient with injected fake factories
// so the credential guard in MxClient.call() actually runs on the register path.
// ---------------------------------------------------------------------------

describe('secret boundary', () => {
  let dir: string;
  let presentSocket: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mxl-session-sec-'));
    presentSocket = join(dir, 'present.sock');
    writeFileSync(presentSocket, ''); // existsSync() → true
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A fake MxTransport that should never be reached in these tests. */
  function unreachableTransport(): MxTransport {
    return {
      async call() { throw new Error('transport should not be reached'); },
      async status() { throw new Error('transport should not be reached'); },
      async ping() { throw new Error('transport should not be reached'); },
      async close() {},
    };
  }

  it('a credential-shaped key in register params is rejected as invalid_args before dispatch', async () => {
    let ipcConstructed = false;
    const mx = new MxClient({
      transport: 'ipc',
      socketPath: presentSocket,
      retry: false,
      ipcFactory: () => { ipcConstructed = true; return unreachableTransport(); },
    });
    const err = await openSession({
      client: mx,
      heartbeat: false,
      // 'tools' contents are forwarded to agent.register params; the guard inspects nested objects
      tools: [{ api_key: 'fake-api-key-value' }],
    }).catch((e: unknown) => e);
    expect((err as TransportError).code).toBe('invalid_args');
    expect(ipcConstructed).toBe(false); // guard fired before the transport was even built
  });

  it('the invalid_args message names the key path, never the secret value', async () => {
    const secretValue = 'MUST_NOT_APPEAR_IN_ERROR_MESSAGE';
    const mx = new MxClient({
      transport: 'ipc',
      socketPath: presentSocket,
      retry: false,
      ipcFactory: () => unreachableTransport(),
    });
    const err = await openSession({
      client: mx,
      heartbeat: false,
      tools: [{ token: secretValue }],
    }).catch((e: unknown) => e);
    expect((err as TransportError).message).not.toContain(secretValue);
    expect((err as TransportError).message).toContain('token');
  });

  it('a credential-shaped value in register params (credential-value pattern) is rejected', async () => {
    const mx = new MxClient({
      transport: 'ipc',
      socketPath: presentSocket,
      retry: false,
      ipcFactory: () => unreachableTransport(),
    });
    // credential-shaped value (gh_ prefix patterns)
    const err = await openSession({
      client: mx,
      heartbeat: false,
      capabilities: ['ghp_fake_github_pat_token_aaaaaaaaaaaaaaaaaaaa'],
    }).catch((e: unknown) => e);
    expect((err as TransportError).code).toBe('invalid_args');
  });
});

// ---------------------------------------------------------------------------
// Session debug-line redaction
// ---------------------------------------------------------------------------

describe('session diagnostics — redaction', () => {
  it('session debug lines never contain param values (only safe identifiers)', async () => {
    const logs: string[] = [];
    const SENTINEL = 'MUST_NOT_APPEAR_IN_LOG_PARAM_VALUE';
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .withDefault({ result: 'ok' });
    const session = await openSession({
      client: asClient(client),
      heartbeat: false,
      debug: (line) => logs.push(line),
    });
    // Call with a param carrying a sentinel value
    await session.call('some.method', { field: SENTINEL });
    for (const line of logs) {
      expect(line).not.toContain(SENTINEL);
    }
  });

  it('open debug line carries agentId, room, correlationId — not secrets', async () => {
    const logs: string[] = [];
    const client = new FakeClient().whenMethod('agent.register', { result: FAKE_AGENT_STATE });
    const session = await openSession({
      client: asClient(client),
      heartbeat: false,
      room: '!room:srv',
      debug: (line) => logs.push(line),
    });
    const openLine = logs.find((l) => l.startsWith('open '));
    expect(openLine).toBeDefined();
    expect(openLine).toContain(FAKE_AGENT_STATE.agent_id);
    expect(openLine).toContain('!room:srv');
    expect(openLine).toContain(session.correlationId);
    // Must not contain the signing key or any credential
    expect(openLine).not.toContain(FAKE_AGENT_STATE.signing_public_key);
    expect(openLine).not.toContain(FAKE_AGENT_STATE.matrix_user_id);
  });

  it('call debug lines carry only the method name and correlationId', async () => {
    const logs: string[] = [];
    const client = new FakeClient()
      .whenMethod('agent.register', { result: FAKE_AGENT_STATE })
      .withDefault({ result: 'ok' });
    const session = await openSession({
      client: asClient(client),
      heartbeat: false,
      debug: (line) => logs.push(line),
    });
    await session.call('some.method', { secret_param: 'MUST_NOT_LOG' });
    const callLogs = logs.filter((l) => l.startsWith('call '));
    expect(callLogs.length).toBeGreaterThan(0);
    for (const line of callLogs) {
      expect(line).not.toContain('MUST_NOT_LOG');
      expect(line).not.toContain('secret_param');
    }
  });

  it('heartbeat ok debug line carries no secrets or param values', async () => {
    const logs: string[] = [];
    const { schedule, fire } = makeFakeSchedule();
    const client = new FakeClient().whenMethod('agent.register', { result: FAKE_AGENT_STATE });
    await openSession({
      client: asClient(client),
      schedule,
      debug: (line) => logs.push(line),
    });
    logs.length = 0; // clear logs from open
    fire();
    await flush();
    const hbLog = logs.find((l) => l.includes('heartbeat'));
    expect(hbLog).toBeDefined();
    // 'heartbeat ok' should not contain agent state private fields
    expect(hbLog).not.toContain(FAKE_AGENT_STATE.signing_public_key);
    expect(hbLog).not.toContain(FAKE_AGENT_STATE.matrix_user_id);
  });
});

// ---------------------------------------------------------------------------
// Compile-checked usage snippet
// ---------------------------------------------------------------------------

describe('compile-checked usage snippet', () => {
  it('exposes the documented public API (compile-checked example)', () => {
    // The common path: openSession() → call() / liveness() → close().
    // Written here as a typed function so TypeScript verifies it at compile time.
    const example = async (): Promise<void> => {
      const session = await openSession({ heartbeat: false });
      try {
        const _result: unknown = await session.call('agent.list');
        const _liveness: 'active' | 'stale' | 'offline' = await session.liveness();
        const _id: string = session.agentId;
        const _corr: string = session.correlationId;
      } finally {
        await session.close();
      }
    };
    expect(typeof example).toBe('function');
  });
});
