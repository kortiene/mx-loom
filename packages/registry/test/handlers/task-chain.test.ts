/**
 * Handler chain tests for T301 / #30 — the core acceptance criterion:
 * "Create a task with deps; list reflects the DAG; update transitions state."
 *
 * These tests exercise the three task handlers in sequence through a shared
 * scripted daemon — no real daemon, no network. Each test drives the full
 * create → list → update → list cycle (or sub-sequences) to prove the
 * end-to-end AC at the handler layer.
 *
 * Covered:
 *  - Create with depends_on → list (graph view) → DAG edges reflect the dep.
 *  - Create with blocks → list (graph view) → blocks edge present.
 *  - Create with both depends_on AND blocks → list → both edge kinds present.
 *  - Create → update state transition → list → node state updated.
 *  - Create with action → list → node carries the authored action (not dispatched).
 *  - Idempotency: update with the same key twice; the handler emits it verbatim both times.
 *  - audit_ref populated by create/update; EMPTY_AUDIT_REF by list.
 *  - All intermediate envelopes validate against ENVELOPE_SCHEMA.
 */
import { describe, expect, it } from 'vitest';

import {
  mxCreateTask,
  mxListTasks,
  mxUpdateTask,
  validateEnvelope,
  type DaemonCall,
  type RoomScopedDeps,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

const ROOM = '!workspace:homeserver';

/**
 * A scripted daemon that stores tasks in memory so the handler chain can
 * exercise a realistic create → list → update → list flow without a real
 * daemon. All tasks share a fake `audit_ref` shape.
 */
function makeStatefulDaemon(): {
  daemon: DaemonCall;
  /** Inspect the tasks the daemon currently holds. */
  taskStore: Map<string, Record<string, unknown>>;
  /** The task.create call count (for idempotency checks). */
  createCalls: number;
  updateCalls: number;
} {
  const taskStore = new Map<string, Record<string, unknown>>();
  let nextId = 1;
  let createCalls = 0;
  let updateCalls = 0;

  const daemon: DaemonCall = {
    async call(method: string, params?: unknown): Promise<unknown> {
      const p = (params ?? {}) as Record<string, unknown>;

      if (method === 'task.create') {
        createCalls++;
        const task_id = `task_${nextId++}`;
        const task: Record<string, unknown> = {
          task_id,
          title: p['title'] ?? '',
          state: p['state'] ?? 'proposed',
          assignee: p['assigned_to'] ?? null,
          depends_on: p['depends_on'] ?? [],
          blocks: p['blocks'] ?? [],
          action: p['action'] ?? null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          audit_ref: {
            invocation_id: `inv_create_${task_id}`,
            request_id: `req_create_${task_id}`,
            room: ROOM,
            event_id: `$create_${task_id}`,
          },
        };
        taskStore.set(task_id, task);
        return task;
      }

      if (method === 'task.update') {
        updateCalls++;
        const task_id = p['task_id'] as string;
        const existing = taskStore.get(task_id);
        if (existing === undefined) {
          throw Object.assign(new Error('not_found'), { code: 'rpc', cause: { error: { code: 'not_found' } } });
        }
        const updated: Record<string, unknown> = {
          ...existing,
          ...(p['state'] !== undefined ? { state: p['state'] } : {}),
          ...(p['assigned_to'] !== undefined ? { assignee: p['assigned_to'] } : {}),
          ...(p['depends_on'] !== undefined ? { depends_on: p['depends_on'] } : {}),
          ...(p['blocks'] !== undefined ? { blocks: p['blocks'] } : {}),
          updated_at: '2026-01-02T00:00:00Z',
          audit_ref: {
            invocation_id: `inv_update_${task_id}`,
            request_id: `req_update_${task_id}`,
            room: ROOM,
            event_id: `$update_${task_id}`,
          },
        };
        taskStore.set(task_id, updated);
        return updated;
      }

      if (method === 'task.list') {
        const tasks = [...taskStore.values()];
        const stateFilter = typeof p['state'] === 'string' ? p['state'] : undefined;
        const assigneeFilter = typeof p['assigned_to'] === 'string' ? p['assigned_to'] : undefined;
        const filtered = tasks.filter((t) => {
          if (stateFilter !== undefined && t['state'] !== stateFilter) return false;
          if (assigneeFilter !== undefined && t['assignee'] !== assigneeFilter) return false;
          return true;
        });
        return { tasks: filtered };
      }

      if (method === 'task.graph') {
        // Return no extra edges — handler derives them from node records.
        return [];
      }

      throw new Error(`unexpected daemon method: ${method}`);
    },
  };

  return { daemon, taskStore, get createCalls() { return createCalls; }, get updateCalls() { return updateCalls; } };
}

function makeDeps(daemon: DaemonCall): RoomScopedDeps {
  return { room: ROOM, daemon };
}

// ---------------------------------------------------------------------------
// Core AC: Create with deps → list reflects the DAG
// ---------------------------------------------------------------------------

describe('task chain — create with depends_on → list reflects the DAG (AC)', () => {
  it('list(graph) returns an edge reflecting the created dependency', async () => {
    const { daemon } = makeStatefulDaemon();
    const deps = makeDeps(daemon);

    // Step 1: create the prerequisite task.
    const prereq = await mxCreateTask({ title: 'Prerequisite' }, deps);
    expect(prereq.status).toBe('ok');
    const prereqId = (prereq.result as Record<string, unknown>).task_id as string;

    // Step 2: create the dependent task.
    const dependent = await mxCreateTask(
      { title: 'Dependent', depends_on: [prereqId] },
      deps,
    );
    expect(dependent.status).toBe('ok');
    const dependentId = (dependent.result as Record<string, unknown>).task_id as string;

    // Step 3: list — the DAG must reflect the dependency.
    const list = await mxListTasks({}, deps);
    expect(list.status).toBe('ok');
    const payload = list.result as { tasks: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };

    expect(payload.tasks).toHaveLength(2);
    const depEdge = payload.edges.find((e) => e.from === dependentId && e.to === prereqId);
    expect(depEdge, 'dependency edge must be present in graph').toBeDefined();
    expect(depEdge?.kind).toBe('depends_on');

    // Envelopes all valid.
    expect(validateEnvelope(prereq)).toBe(true);
    expect(validateEnvelope(dependent)).toBe(true);
    expect(validateEnvelope(list)).toBe(true);
  });

  it('list(graph) returns a blocks edge reflecting the created task', async () => {
    const { daemon } = makeStatefulDaemon();
    const deps = makeDeps(daemon);

    const blocker = await mxCreateTask({ title: 'Blocker' }, deps);
    const blockerId = (blocker.result as Record<string, unknown>).task_id as string;

    const blocked = await mxCreateTask({ title: 'Blocked' }, deps);
    const blockedId = (blocked.result as Record<string, unknown>).task_id as string;

    // Create an explicit blocks relationship.
    const blockerWithEdge = await mxCreateTask(
      { title: 'Blocker with edge', blocks: [blockedId] },
      deps,
    );
    const blokerEdgeId = (blockerWithEdge.result as Record<string, unknown>).task_id as string;

    const list = await mxListTasks({}, deps);
    const payload = list.result as { edges: Array<Record<string, unknown>> };
    const blocksEdge = payload.edges.find((e) => e.from === blokerEdgeId && e.to === blockedId);
    expect(blocksEdge?.kind).toBe('blocks');

    // blocker is not expected to have edges (created without blocks).
    expect(blockerId).toBeDefined(); // referenced only to avoid lint
  });

  it('list(graph) returns both depends_on and blocks edges when both are authored', async () => {
    const { daemon } = makeStatefulDaemon();
    const deps = makeDeps(daemon);

    const prereq = await mxCreateTask({ title: 'Pre' }, deps);
    const prereqId = (prereq.result as Record<string, unknown>).task_id as string;

    const next = await mxCreateTask({ title: 'Next' }, deps);
    const nextId = (next.result as Record<string, unknown>).task_id as string;

    const center = await mxCreateTask(
      { title: 'Center', depends_on: [prereqId], blocks: [nextId] },
      deps,
    );
    const centerId = (center.result as Record<string, unknown>).task_id as string;

    const list = await mxListTasks({}, deps);
    const payload = list.result as { edges: Array<Record<string, unknown>> };
    const dep = payload.edges.find((e) => e.from === centerId && e.to === prereqId && e.kind === 'depends_on');
    const blk = payload.edges.find((e) => e.from === centerId && e.to === nextId && e.kind === 'blocks');
    expect(dep, 'depends_on edge must be present').toBeDefined();
    expect(blk, 'blocks edge must be present').toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Core AC: update transitions state → list reflects new state
// ---------------------------------------------------------------------------

describe('task chain — update transitions state → list reflects new state (AC)', () => {
  it('state is updated and reflected in the next list call', async () => {
    const { daemon } = makeStatefulDaemon();
    const deps = makeDeps(daemon);

    // Create in proposed state (the default).
    const created = await mxCreateTask({ title: 'State task' }, deps);
    expect((created.result as Record<string, unknown>).state).toBe('proposed');
    const taskId = (created.result as Record<string, unknown>).task_id as string;

    // Transition to executing.
    const updated = await mxUpdateTask({ task_id: taskId, state: 'executing' }, deps);
    expect(updated.status).toBe('ok');
    expect((updated.result as Record<string, unknown>).state).toBe('executing');
    // update is a signed mutation → audit_ref must be populated.
    expect(updated.audit_ref.invocation_id).not.toBeNull();

    // List — the node must carry the new state.
    const list = await mxListTasks({}, deps);
    const payload = list.result as { tasks: Array<Record<string, unknown>> };
    const node = payload.tasks.find((t) => t['task_id'] === taskId);
    expect(node?.['state']).toBe('executing');

    // list is a local read → EMPTY_AUDIT_REF.
    expect(list.audit_ref.invocation_id).toBeNull();
  });

  it('full lifecycle: proposed → assigned → executing → succeeded', async () => {
    const { daemon } = makeStatefulDaemon();
    const deps = makeDeps(daemon);

    const created = await mxCreateTask({ title: 'Lifecycle task' }, deps);
    const taskId = (created.result as Record<string, unknown>).task_id as string;

    for (const [targetState, expectedState] of [
      ['assigned', 'assigned'],
      ['executing', 'executing'],
      ['succeeded', 'succeeded'],
    ] as const) {
      const upd = await mxUpdateTask({ task_id: taskId, state: targetState }, deps);
      expect(upd.status, `update to ${targetState} should succeed`).toBe('ok');
      expect((upd.result as Record<string, unknown>).state).toBe(expectedState);
    }

    // Final state in list.
    const list = await mxListTasks({}, deps);
    const tasks = (list.result as { tasks: Array<Record<string, unknown>> }).tasks;
    expect(tasks.find((t) => t['task_id'] === taskId)?.['state']).toBe('succeeded');
  });
});

// ---------------------------------------------------------------------------
// Core AC: authored action is present in the listed node (not dispatched)
// ---------------------------------------------------------------------------

describe('task chain — authored action reflected in list (T303 dispatches, not T301)', () => {
  it('list returns the authored action on the node', async () => {
    const { daemon } = makeStatefulDaemon();
    const deps = makeDeps(daemon);

    await mxCreateTask(
      { title: 'With action', action: { kind: 'tool', tool: 'run_tests', args: { suite: 'unit' } } },
      deps,
    );

    const list = await mxListTasks({}, deps);
    const payload = list.result as { tasks: Array<Record<string, unknown>> };
    const node = payload.tasks[0] as Record<string, unknown>;
    const action = node['action'] as Record<string, unknown> | null;
    expect(action).not.toBeNull();
    expect(action?.['kind']).toBe('tool');
    expect(action?.['tool']).toBe('run_tests');
  });
});

// ---------------------------------------------------------------------------
// Idempotency — same key emitted verbatim on two updates
// ---------------------------------------------------------------------------

describe('task chain — idempotency key is stable across retries', () => {
  it('two update calls with the same idempotency_key both forward the key verbatim', async () => {
    const keys: string[] = [];
    const { daemon } = makeStatefulDaemon();
    const baseDeps = makeDeps(daemon);

    const created = await mxCreateTask({ title: 'Idem task' }, baseDeps);
    const taskId = (created.result as Record<string, unknown>).task_id as string;
    const IDEM_KEY = 'idk_stable_retry_key_xyz';

    // Wrap the stateful daemon to capture idempotency keys on update.
    const spyDaemon: DaemonCall = {
      async call(method: string, params?: unknown): Promise<unknown> {
        if (method === 'task.update') {
          keys.push((params as Record<string, unknown>)['idempotency_key'] as string);
        }
        return daemon.call(method, params);
      },
    };
    const spyDeps = makeDeps(spyDaemon);

    await mxUpdateTask({ task_id: taskId, state: 'pending', idempotency_key: IDEM_KEY }, spyDeps);
    await mxUpdateTask({ task_id: taskId, state: 'pending', idempotency_key: IDEM_KEY }, spyDeps);

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(IDEM_KEY);
    expect(keys[1]).toBe(IDEM_KEY);
  });
});

// ---------------------------------------------------------------------------
// audit_ref: populated by mutations, EMPTY by reads
// ---------------------------------------------------------------------------

describe('task chain — audit_ref contract across the full chain', () => {
  it('create returns populated audit_ref; list returns all-null audit_ref', async () => {
    const { daemon } = makeStatefulDaemon();
    const deps = makeDeps(daemon);

    const created = await mxCreateTask({ title: 'Audit chain' }, deps);
    expect(created.audit_ref.invocation_id).not.toBeNull();
    expect(created.audit_ref.request_id).not.toBeNull();
    expect(created.audit_ref.room).toBe(ROOM);

    const list = await mxListTasks({}, deps);
    // A local read has no Matrix round-trip → EMPTY_AUDIT_REF.
    expect(list.audit_ref.invocation_id).toBeNull();
    expect(list.audit_ref.request_id).toBeNull();
    expect(list.audit_ref.room).toBeNull();
    expect(list.audit_ref.event_id).toBeNull();
  });

  it('update returns populated audit_ref (it is a signed mutation)', async () => {
    const { daemon } = makeStatefulDaemon();
    const deps = makeDeps(daemon);

    const created = await mxCreateTask({ title: 'Audit update chain' }, deps);
    const taskId = (created.result as Record<string, unknown>).task_id as string;

    const updated = await mxUpdateTask({ task_id: taskId, state: 'assigned' }, deps);
    expect(updated.audit_ref.invocation_id).not.toBeNull();
    expect(updated.audit_ref.room).toBe(ROOM);
  });
});

// ---------------------------------------------------------------------------
// State filter: list(state=X) after update → only nodes in state X returned
// ---------------------------------------------------------------------------

describe('task chain — list with state filter after update', () => {
  it('state filter returns only nodes matching the requested state after update', async () => {
    const { daemon } = makeStatefulDaemon();
    const deps = makeDeps(daemon);

    // Create two tasks.
    const t1 = await mxCreateTask({ title: 'Task 1' }, deps);
    const t2 = await mxCreateTask({ title: 'Task 2' }, deps);
    const t1Id = (t1.result as Record<string, unknown>).task_id as string;

    // Transition task 1 to executing; leave task 2 in proposed.
    await mxUpdateTask({ task_id: t1Id, state: 'executing' }, deps);

    // List with state=executing → only task 1.
    const execList = await mxListTasks({ state: 'executing' }, deps);
    const execPayload = execList.result as { tasks: Array<Record<string, unknown>> };
    expect(execPayload.tasks).toHaveLength(1);
    expect(execPayload.tasks[0]?.['task_id']).toBe(t1Id);

    // List with state=proposed → only task 2.
    const t2Id = (t2.result as Record<string, unknown>).task_id as string;
    const propList = await mxListTasks({ state: 'proposed' }, deps);
    const propPayload = propList.result as { tasks: Array<Record<string, unknown>> };
    expect(propPayload.tasks).toHaveLength(1);
    expect(propPayload.tasks[0]?.['task_id']).toBe(t2Id);
  });
});
