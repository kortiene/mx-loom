/**
 * `mxListTasks` handler unit tests (T301 / #30) — daemon-free.
 *
 * Tests pin:
 *  - Happy path (view='graph', the default): ok({ tasks, edges }, EMPTY_AUDIT_REF).
 *  - view='list': ok({ tasks }, EMPTY_AUDIT_REF) — no task.graph call, no edges in result.
 *  - view='graph' (explicit): edges derived from node depends_on / blocks arrays.
 *  - The DAG AC: create with depends_on → list returns tasks and edges reflecting the DAG.
 *  - Filter forwarding: state and assignee reach the daemon params.
 *  - Room is best-effort: passed when set, omitted when room is undefined / empty.
 *  - EMPTY_AUDIT_REF on success (a local read, no Matrix round-trip).
 *  - task.list fault → error envelope (faultToResult).
 *  - task.graph fault → tolerated; derived edges still reflect the DAG; result is ok.
 *  - task.list returns bare array, wrapped { tasks: [...] }, { nodes: [...] }, { items: [...] }.
 *  - Empty task list → { tasks: [], edges: [] }.
 *  - All envelopes validate against ENVELOPE_SCHEMA.
 *  - Never throws on any input.
 */
import { describe, expect, it } from 'vitest';

import { TransportError } from '@mx-loom/toolbelt';

import {
  mxListTasks,
  validateEnvelope,
  type DaemonCall,
  type RoomScopedDeps,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOM = '!workspace:homeserver';

const TASK_A = {
  task_id: 'task_a',
  title: 'A',
  state: 'proposed',
  depends_on: ['task_b'],
  blocks: [],
  action: null,
};

const TASK_B = {
  task_id: 'task_b',
  title: 'B',
  state: 'pending',
  depends_on: [],
  blocks: [],
  action: null,
};

const TASK_LIST_RESPONSE = { tasks: [TASK_A, TASK_B] };
const TASK_LIST_ARRAY = [TASK_A, TASK_B];

const EMPTY_AUDIT_REF = {
  invocation_id: null,
  request_id: null,
  room: null,
  event_id: null,
};

/** Build a fake daemon that can return different responses per method. */
function makeDaemon(opts: {
  listResponse?: unknown;
  graphResponse?: unknown;
  throwOnList?: boolean;
  throwOnGraph?: boolean;
  onCall?: (method: string, params: unknown) => void;
} = {}): DaemonCall {
  return {
    async call(method: string, params?: unknown): Promise<unknown> {
      opts.onCall?.(method, params ?? null);
      if (method === 'task.list') {
        if (opts.throwOnList) throw new TransportError('timeout', 'list timeout');
        return opts.listResponse ?? TASK_LIST_RESPONSE;
      }
      if (method === 'task.graph') {
        if (opts.throwOnGraph) throw new TransportError('timeout', 'graph timeout');
        return opts.graphResponse ?? [];
      }
      throw new Error(`unexpected daemon method: ${method}`);
    },
  };
}

function makeDeps(opts?: { room?: string | undefined; daemon?: DaemonCall }): RoomScopedDeps {
  const hasRoom = opts !== undefined && Object.prototype.hasOwnProperty.call(opts, 'room');
  return {
    room: hasRoom ? opts!.room : ROOM,
    daemon: opts?.daemon ?? makeDaemon(),
  };
}

// ---------------------------------------------------------------------------
// Happy path — view='graph' (default)
// ---------------------------------------------------------------------------

describe('mxListTasks — view: graph (default)', () => {
  it('returns ok({ tasks, edges }, EMPTY_AUDIT_REF)', async () => {
    const result = await mxListTasks({}, makeDeps());
    expect(result.status).toBe('ok');
    expect(result.audit_ref).toEqual(EMPTY_AUDIT_REF);
    const payload = result.result as Record<string, unknown>;
    expect(Array.isArray(payload.tasks)).toBe(true);
    expect(Array.isArray(payload.edges)).toBe(true);
  });

  it('derives edges from node depends_on arrays (the DAG AC)', async () => {
    const result = await mxListTasks({}, makeDeps());
    const payload = result.result as { tasks: unknown[]; edges: Array<Record<string, unknown>> };
    // task_a depends_on task_b → edge { from: task_a, to: task_b, kind: depends_on }
    const depEdge = payload.edges.find((e) => e.from === 'task_a' && e.to === 'task_b');
    expect(depEdge).toBeDefined();
    expect(depEdge?.kind).toBe('depends_on');
  });

  it('view defaults to "graph" — edges DERIVED from task.list, task.graph NOT called', async () => {
    const calls: string[] = [];
    const daemon = makeDaemon({ onCall: (m) => calls.push(m) });
    const result = await mxListTasks({}, makeDeps({ daemon }));
    expect(result.status).toBe('ok');
    // Default view=graph returns edges, but they are derived from each node's
    // depends_on/blocks (task.list carries them). task.graph is deliberately NOT
    // called: it hangs on v0.2.1 and poisons the multiplexed connection
    // (kortiene/mx-agent#368). task.list alone reflects the DAG.
    expect(calls).toContain('task.list');
    expect(calls).not.toContain('task.graph');
    expect(Array.isArray((result.result as Record<string, unknown>).edges)).toBe(true);
  });

  it('view: "graph" explicitly still derives edges without calling task.graph', async () => {
    const calls: string[] = [];
    const daemon = makeDaemon({ onCall: (m) => calls.push(m) });
    await mxListTasks({ view: 'graph' }, makeDeps({ daemon }));
    expect(calls).not.toContain('task.graph');
  });
});

// ---------------------------------------------------------------------------
// view='list' — nodes only, no task.graph call
// ---------------------------------------------------------------------------

describe('mxListTasks — view: list', () => {
  it('returns ok({ tasks }, EMPTY_AUDIT_REF) with no edges field', async () => {
    const result = await mxListTasks({ view: 'list' }, makeDeps());
    expect(result.status).toBe('ok');
    const payload = result.result as Record<string, unknown>;
    expect(Array.isArray(payload.tasks)).toBe(true);
    // edges is absent or undefined for view=list
    expect(payload.edges).toBeUndefined();
  });

  it('does NOT call task.graph for view=list', async () => {
    const calls: string[] = [];
    const daemon = makeDaemon({ onCall: (m) => calls.push(m) });
    await mxListTasks({ view: 'list' }, makeDeps({ daemon }));
    expect(calls).not.toContain('task.graph');
    expect(calls).toContain('task.list');
  });
});

// ---------------------------------------------------------------------------
// The DAG acceptance criterion: create deps → list → edges reflect deps
// ---------------------------------------------------------------------------

describe('mxListTasks — DAG acceptance criterion (daemon-free, scripted)', () => {
  it('edges reflect a dependency: task_a depends_on task_b', async () => {
    const daemon = makeDaemon({
      listResponse: { tasks: [TASK_A, TASK_B] },
      graphResponse: [],
    });
    const result = await mxListTasks({}, makeDeps({ daemon }));
    const payload = result.result as { tasks: unknown[]; edges: Array<{ from: string; to: string; kind: string }> };

    expect(payload.tasks).toHaveLength(2);
    const depEdge = payload.edges.find((e) => e.from === 'task_a' && e.to === 'task_b');
    expect(depEdge?.kind).toBe('depends_on');
  });

  it('derives all edges from the task.list node records (task.graph is never consulted)', async () => {
    const calls: string[] = [];
    const daemon = makeDaemon({
      listResponse: { tasks: [TASK_A] },
      // Even if a daemon WOULD return extra explicit edges, the handler never calls
      // task.graph (kortiene/mx-agent#368), so only edges derivable from TASK_A's
      // depends_on/blocks appear — the speculative task_c edge is NOT merged.
      graphResponse: [{ from: 'task_a', to: 'task_c', kind: 'depends_on' }],
      onCall: (m) => calls.push(m),
    });
    const result = await mxListTasks({}, makeDeps({ daemon }));
    const payload = result.result as { edges: Array<Record<string, unknown>> };
    expect(calls).not.toContain('task.graph');
    const ids = payload.edges.map((e) => `${e.from as string}->${e.to as string}`);
    expect(ids).toContain('task_a->task_b'); // derived from TASK_A.depends_on
    expect(ids).not.toContain('task_a->task_c'); // task.graph not merged
  });
});

// ---------------------------------------------------------------------------
// Filter forwarding
// ---------------------------------------------------------------------------

describe('mxListTasks — filter forwarding', () => {
  it('forwards state filter to the daemon', async () => {
    const params: Record<string, unknown>[] = [];
    const daemon = makeDaemon({ onCall: (m, p) => { if (m === 'task.list') params.push(p as Record<string, unknown>); } });
    await mxListTasks({ state: 'proposed' }, makeDeps({ daemon }));
    expect(params[0]?.['state']).toBe('proposed');
  });

  it('forwards assignee filter to the daemon', async () => {
    const params: Record<string, unknown>[] = [];
    const daemon = makeDaemon({ onCall: (m, p) => { if (m === 'task.list') params.push(p as Record<string, unknown>); } });
    await mxListTasks({ assignee: 'agent_x' }, makeDeps({ daemon }));
    // The daemon's ListTasksOptions filter field is `assigned_to` (not `assignee`).
    expect(params[0]?.['assigned_to']).toBe('agent_x');
  });

  it('omits state/assignee when not provided (no undefined keys)', async () => {
    const params: Record<string, unknown>[] = [];
    const daemon = makeDaemon({ onCall: (m, p) => { if (m === 'task.list') params.push(p as Record<string, unknown>); } });
    await mxListTasks({}, makeDeps({ daemon }));
    if (params[0] !== null && params[0] !== undefined) {
      expect(Object.prototype.hasOwnProperty.call(params[0], 'state')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(params[0], 'assigned_to')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Room provenance — best-effort for a read
// ---------------------------------------------------------------------------

describe('mxListTasks — room best-effort', () => {
  it('passes room to the daemon when set', async () => {
    const params: Record<string, unknown>[] = [];
    const daemon = makeDaemon({ onCall: (m, p) => { if (m === 'task.list') params.push(p as Record<string, unknown>); } });
    await mxListTasks({}, makeDeps({ room: '!myroom:server', daemon }));
    expect(params[0]?.['room']).toBe('!myroom:server');
  });

  it('omits room from daemon params when room is undefined (best-effort)', async () => {
    const params: Record<string, unknown>[] = [];
    const daemon = makeDaemon({ onCall: (m, p) => { if (m === 'task.list') params.push(p as Record<string, unknown>); } });
    await mxListTasks({}, makeDeps({ room: undefined, daemon }));
    // Should succeed (best-effort) and not include room in params
    if (params[0] !== null && params[0] !== undefined) {
      expect(Object.prototype.hasOwnProperty.call(params[0], 'room')).toBe(false);
    }
  });

  it('does NOT fail-fast on a missing room (unlike mutators)', async () => {
    const result = await mxListTasks({}, makeDeps({ room: undefined }));
    // Should succeed (not return internal error)
    expect(result.status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// EMPTY_AUDIT_REF for all ok results (local read = no Matrix round-trip)
// ---------------------------------------------------------------------------

describe('mxListTasks — EMPTY_AUDIT_REF', () => {
  it('always returns all-null audit_ref (a local read, no Matrix round-trip)', async () => {
    const result = await mxListTasks({}, makeDeps());
    expect(result.audit_ref).toEqual(EMPTY_AUDIT_REF);
  });

  it('audit_ref is all-null even for the graph view', async () => {
    const result = await mxListTasks({ view: 'graph' }, makeDeps());
    expect(result.audit_ref.invocation_id).toBeNull();
    expect(result.audit_ref.request_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// task.list reply shapes — bare array, wrapped objects
// ---------------------------------------------------------------------------

describe('mxListTasks — task.list reply shapes', () => {
  it('bare array → tasks projected correctly', async () => {
    const daemon = makeDaemon({ listResponse: TASK_LIST_ARRAY });
    const result = await mxListTasks({ view: 'list' }, makeDeps({ daemon }));
    const payload = result.result as { tasks: Array<Record<string, unknown>> };
    expect(payload.tasks).toHaveLength(2);
    expect(payload.tasks[0]?.task_id).toBe('task_a');
  });

  it('{ tasks: [...] } wrapper → tasks projected correctly', async () => {
    const daemon = makeDaemon({ listResponse: { tasks: TASK_LIST_ARRAY } });
    const result = await mxListTasks({ view: 'list' }, makeDeps({ daemon }));
    const payload = result.result as { tasks: Array<Record<string, unknown>> };
    expect(payload.tasks).toHaveLength(2);
  });

  it('{ nodes: [...] } wrapper → tasks projected correctly', async () => {
    const daemon = makeDaemon({ listResponse: { nodes: TASK_LIST_ARRAY } });
    const result = await mxListTasks({ view: 'list' }, makeDeps({ daemon }));
    const payload = result.result as { tasks: unknown[] };
    expect(payload.tasks).toHaveLength(2);
  });

  it('{ items: [...] } wrapper → tasks projected correctly', async () => {
    const daemon = makeDaemon({ listResponse: { items: TASK_LIST_ARRAY } });
    const result = await mxListTasks({ view: 'list' }, makeDeps({ daemon }));
    const payload = result.result as { tasks: unknown[] };
    expect(payload.tasks).toHaveLength(2);
  });

  it('empty list → { tasks: [], edges: [] }', async () => {
    const daemon = makeDaemon({ listResponse: [], graphResponse: [] });
    const result = await mxListTasks({}, makeDeps({ daemon }));
    const payload = result.result as { tasks: unknown[]; edges: unknown[] };
    expect(payload.tasks).toEqual([]);
    expect(payload.edges).toEqual([]);
  });

  it('{ items: [...] } wrapper with view=graph returns tasks AND edges', async () => {
    const daemon = makeDaemon({ listResponse: { items: TASK_LIST_ARRAY }, graphResponse: [] });
    const result = await mxListTasks({ view: 'graph' }, makeDeps({ daemon }));
    const payload = result.result as { tasks: Array<Record<string, unknown>>; edges: unknown[] };
    expect(payload.tasks).toHaveLength(2);
    expect(Array.isArray(payload.edges)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Combined filters (state AND assignee together)
// ---------------------------------------------------------------------------

describe('mxListTasks — combined filters', () => {
  it('forwards both state and assignee filters in the same call', async () => {
    const params: Record<string, unknown>[] = [];
    const daemon = makeDaemon({
      onCall: (m, p) => { if (m === 'task.list') params.push(p as Record<string, unknown>); },
    });
    await mxListTasks({ state: 'executing', assignee: 'agent_runner' }, makeDeps({ daemon }));
    expect(params[0]?.['state']).toBe('executing');
    // The daemon's ListTasksOptions filter field is `assigned_to` (not `assignee`).
    expect(params[0]?.['assigned_to']).toBe('agent_runner');
  });

  it('room + state + assignee all forwarded together', async () => {
    const params: Record<string, unknown>[] = [];
    const daemon = makeDaemon({
      onCall: (m, p) => { if (m === 'task.list') params.push(p as Record<string, unknown>); },
    });
    await mxListTasks({ state: 'assigned', assignee: 'agent_x' }, makeDeps({ room: '!ws:hs', daemon }));
    expect(params[0]?.['room']).toBe('!ws:hs');
    expect(params[0]?.['state']).toBe('assigned');
    expect(params[0]?.['assigned_to']).toBe('agent_x');
  });
});

// ---------------------------------------------------------------------------
// Graph view derives edges from task.list alone (task.graph not called)
// ---------------------------------------------------------------------------

describe('mxListTasks — graph view derives edges from task.list', () => {
  it('returns ok with edges derived from node depends_on/blocks (task.graph not called)', async () => {
    const calls: string[] = [];
    const daemon = makeDaemon({ onCall: (m) => calls.push(m) });
    const result = await mxListTasks({}, makeDeps({ daemon }));
    expect(result.status).toBe('ok');
    expect(calls).not.toContain('task.graph');
    const payload = result.result as { tasks: unknown[]; edges: Array<Record<string, unknown>> };
    expect(Array.isArray(payload.edges)).toBe(true);
    const depEdge = payload.edges.find((e) => e.from === 'task_a');
    expect(depEdge).toBeDefined();
  });

  it('returns all task nodes', async () => {
    const result = await mxListTasks({}, makeDeps());
    const payload = result.result as { tasks: unknown[] };
    expect(payload.tasks).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// task.list fault
// ---------------------------------------------------------------------------

describe('mxListTasks — task.list fault', () => {
  it('task.list timeout → error(timeout)', async () => {
    const daemon = makeDaemon({ throwOnList: true });
    const result = await mxListTasks({}, makeDeps({ daemon }));
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('timeout');
  });

  it('task.list policy_denied → denied(policy_denied)', async () => {
    const daemon: DaemonCall = {
      async call(method) {
        if (method === 'task.list')
          throw new TransportError('rpc', 'err', { cause: { error: { code: 'policy_denied' } } });
        return [];
      },
    };
    const result = await mxListTasks({}, makeDeps({ daemon }));
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
  });

  it('validates failure envelopes', async () => {
    const daemon = makeDaemon({ throwOnList: true });
    const result = await mxListTasks({}, makeDeps({ daemon }));
    expect(validateEnvelope(result)).toBe(true);
  });

  it('task.list target_offline → error(target_offline)', async () => {
    const daemon: DaemonCall = {
      async call(method) {
        if (method === 'task.list')
          throw new TransportError('rpc', 'err', { cause: { error: { code: 'target_offline' } } });
        return [];
      },
    };
    const result = await mxListTasks({}, makeDeps({ daemon }));
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('target_offline');
  });
});

// ---------------------------------------------------------------------------
// Envelope validity
// ---------------------------------------------------------------------------

describe('mxListTasks — envelope validity', () => {
  it('all ok envelopes validate against ENVELOPE_SCHEMA', async () => {
    for (const view of ['list', 'graph', undefined] as const) {
      const result = await mxListTasks(view !== undefined ? { view } : {}, makeDeps());
      expect(validateEnvelope(result), `view=${view ?? 'default'} should produce valid envelope`).toBe(true);
    }
  });

  it('never throws on any input', async () => {
    const inputs = [{}, { view: 'list' as const }, { view: 'graph' as const }, { state: 'proposed' as const }];
    for (const input of inputs) {
      await expect(mxListTasks(input, makeDeps())).resolves.toBeDefined();
    }
  });
});
