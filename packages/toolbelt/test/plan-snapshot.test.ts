/**
 * Unit tests for plan-snapshot.ts (T302). All functions are pure and total;
 * no daemon, no I/O. The async `reconstructPlan` is driven by a fake DaemonCall.
 *
 * Coverage:
 * - mapResumedTaskState: known vocab, synonyms, normalisation, unknown fallback
 * - projectResumedTask: bare records, wrapped under 'task', field aliases,
 *   malformed input degrades gracefully
 * - readTaskRows: bare array, wrapped shapes, non-array fallbacks
 * - readTaskRev: state_rev/rev/version fields, absent/non-numeric → undefined
 * - advanceCursor: advances monotonically, preserves prior token, never regresses
 * - deriveEdges: depends_on + blocks → PlanEdge, deduplication, empty-id skip
 * - reconcile: done/inFlight/ready/blocked classification over deps satisfaction
 * - buildPlanSnapshot: assembles all pieces from raw rows
 * - reconstructPlan: calls task.list with room param; fault → empty-but-valid
 *   snapshot carrying the fault code (never throws); never re-dispatches
 */
import { describe, expect, it } from 'vitest';

import {
  TASK_LIST_METHOD,
  advanceCursor,
  buildPlanSnapshot,
  deriveEdges,
  mapResumedTaskState,
  projectResumedTask,
  readTaskRev,
  readTaskRows,
  reconcile,
  reconstructPlan,
} from '../src/plan-snapshot.js';
import { TransportError } from '../src/transport.js';
import type { DaemonCall, ResumedTask } from '../src/plan-snapshot.js';

// ---------------------------------------------------------------------------
// TASK_LIST_METHOD
// ---------------------------------------------------------------------------

describe('TASK_LIST_METHOD', () => {
  it('is the string "task.list"', () => {
    expect(TASK_LIST_METHOD).toBe('task.list');
  });
});

// ---------------------------------------------------------------------------
// mapResumedTaskState
// ---------------------------------------------------------------------------

describe('mapResumedTaskState — canonical states', () => {
  const canonicalCases: Array<[string, string]> = [
    ['proposed', 'proposed'],
    ['pending', 'pending'],
    ['assigned', 'assigned'],
    ['executing', 'executing'],
    ['succeeded', 'succeeded'],
    ['failed', 'failed'],
  ];
  for (const [raw, expected] of canonicalCases) {
    it(`maps '${raw}' to '${expected}'`, () => {
      expect(mapResumedTaskState(raw)).toBe(expected);
    });
  }
});

describe('mapResumedTaskState — synonyms', () => {
  const synonymCases: Array<[string, string]> = [
    ['new', 'proposed'],
    ['created', 'proposed'],
    ['draft', 'proposed'],
    ['queued', 'pending'],
    ['waiting', 'pending'],
    ['blocked', 'pending'],
    ['ready', 'pending'],
    ['claimed', 'assigned'],
    ['accepted', 'assigned'],
    ['scheduled', 'assigned'],
    ['running', 'executing'],
    ['in_progress', 'executing'],
    ['active', 'executing'],
    ['started', 'executing'],
    ['in_flight', 'executing'],
    ['inflight', 'executing'],
    ['success', 'succeeded'],
    ['done', 'succeeded'],
    ['complete', 'succeeded'],
    ['completed', 'succeeded'],
    ['finished', 'succeeded'],
    ['resolved', 'succeeded'],
    ['ok', 'succeeded'],
    ['failure', 'failed'],
    ['error', 'failed'],
    ['errored', 'failed'],
    ['faulted', 'failed'],
    ['cancelled', 'failed'],
    ['canceled', 'failed'],
    ['aborted', 'failed'],
  ];
  for (const [raw, expected] of synonymCases) {
    it(`maps synonym '${raw}' to '${expected}'`, () => {
      expect(mapResumedTaskState(raw)).toBe(expected);
    });
  }
});

describe('mapResumedTaskState — normalisation and unknown fallback', () => {
  it('normalises case (EXECUTING → executing)', () => {
    expect(mapResumedTaskState('EXECUTING')).toBe('executing');
    expect(mapResumedTaskState('SUCCEEDED')).toBe('succeeded');
  });

  it('normalises hyphen separators (in-progress → executing)', () => {
    expect(mapResumedTaskState('in-progress')).toBe('executing');
  });

  it('trims leading/trailing underscores after normalisation', () => {
    expect(mapResumedTaskState('_pending_')).toBe('pending');
  });

  it('returns unknown for an unrecognised token', () => {
    expect(mapResumedTaskState('mystery_state')).toBe('unknown');
  });

  it('returns unknown for an empty string', () => {
    expect(mapResumedTaskState('')).toBe('unknown');
  });

  it('returns unknown for a number', () => {
    expect(mapResumedTaskState(42)).toBe('unknown');
  });

  it('returns unknown for null', () => {
    expect(mapResumedTaskState(null)).toBe('unknown');
  });

  it('returns unknown for undefined', () => {
    expect(mapResumedTaskState(undefined)).toBe('unknown');
  });

  it('returns unknown for an object', () => {
    expect(mapResumedTaskState({ state: 'pending' })).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// projectResumedTask
// ---------------------------------------------------------------------------

describe('projectResumedTask — field reading', () => {
  it('reads a bare task record with all fields', () => {
    const raw = {
      task_id: 't1',
      state: 'executing',
      assignee: 'agent-xyz',
      depends_on: ['t2', 't3'],
      blocks: ['t4'],
    };
    const task = projectResumedTask(raw);
    expect(task.task_id).toBe('t1');
    expect(task.state).toBe('executing');
    expect(task.assignee).toBe('agent-xyz');
    expect(task.depends_on).toEqual(['t2', 't3']);
    expect(task.blocks).toEqual(['t4']);
  });

  it('reads a record wrapped under a "task" key', () => {
    const raw = {
      task: { task_id: 't1', state: 'succeeded', assignee: null, depends_on: [], blocks: [] },
    };
    expect(projectResumedTask(raw).task_id).toBe('t1');
    expect(projectResumedTask(raw).state).toBe('succeeded');
  });

  it('falls back to "id" field when task_id is absent', () => {
    expect(projectResumedTask({ id: 'fallback-id', state: 'pending' }).task_id).toBe('fallback-id');
  });

  it('reads assignee from "assigned_to" alias', () => {
    expect(projectResumedTask({ task_id: 't1', assigned_to: 'agent-a' }).assignee).toBe('agent-a');
  });

  it('reads assignee from "assign" alias', () => {
    expect(projectResumedTask({ task_id: 't1', assign: 'agent-b' }).assignee).toBe('agent-b');
  });

  it('reads state from "status" alias', () => {
    expect(projectResumedTask({ task_id: 't1', status: 'running' }).state).toBe('executing');
  });

  it('reads state from "phase" alias', () => {
    expect(projectResumedTask({ task_id: 't1', phase: 'done' }).state).toBe('succeeded');
  });

  it('sets assignee to null when no assignee field is present', () => {
    expect(projectResumedTask({ task_id: 't1', state: 'pending' }).assignee).toBeNull();
  });

  it('returns empty depends_on and blocks arrays when absent', () => {
    const task = projectResumedTask({ task_id: 't1' });
    expect(task.depends_on).toEqual([]);
    expect(task.blocks).toEqual([]);
  });

  it('filters non-string entries from depends_on / blocks arrays', () => {
    const task = projectResumedTask({ task_id: 't1', depends_on: ['t2', 42, null, 't3'], blocks: [undefined] });
    expect(task.depends_on).toEqual(['t2', 't3']);
    expect(task.blocks).toEqual([]);
  });
});

describe('projectResumedTask — malformed / total fallback', () => {
  it('returns empty task_id for a record with no id fields', () => {
    expect(projectResumedTask({ state: 'pending' }).task_id).toBe('');
  });

  it('returns unknown state for a record with an unrecognised state', () => {
    expect(projectResumedTask({ task_id: 't1', state: 'mystery' }).state).toBe('unknown');
  });

  it('returns a safe empty task for null input (never throws)', () => {
    const task = projectResumedTask(null);
    expect(task.task_id).toBe('');
    expect(task.state).toBe('unknown');
    expect(task.depends_on).toEqual([]);
    expect(task.blocks).toEqual([]);
  });

  it('returns a safe empty task for a non-object (string) input (never throws)', () => {
    const task = projectResumedTask('not-a-record');
    expect(task.task_id).toBe('');
    expect(task.state).toBe('unknown');
  });

  it('returns a safe empty task for undefined input (never throws)', () => {
    expect(() => projectResumedTask(undefined)).not.toThrow();
    expect(projectResumedTask(undefined).task_id).toBe('');
  });

  it('never carries credential-shaped action.args (allowlist-by-construction)', () => {
    const raw = {
      task_id: 't1',
      state: 'pending',
      action: { tool: 'shell', args: { api_key: 'sk-ant-supersecret' } },
    };
    const task = projectResumedTask(raw);
    const taskStr = JSON.stringify(task);
    expect(taskStr).not.toContain('api_key');
    expect(taskStr).not.toContain('sk-ant-supersecret');
  });
});

// ---------------------------------------------------------------------------
// readTaskRows
// ---------------------------------------------------------------------------

describe('readTaskRows', () => {
  it('returns a bare array as-is', () => {
    const rows = [{ task_id: 't1' }, { task_id: 't2' }];
    expect(readTaskRows(rows)).toBe(rows);
  });

  it('returns an empty bare array as-is', () => {
    expect(readTaskRows([])).toEqual([]);
  });

  it('unwraps a reply object with a "tasks" key', () => {
    const tasks = [{ task_id: 't1' }];
    expect(readTaskRows({ tasks })).toBe(tasks);
  });

  it('unwraps a reply object with a "nodes" key', () => {
    const nodes = [{ task_id: 't1' }];
    expect(readTaskRows({ nodes })).toBe(nodes);
  });

  it('unwraps a reply object with an "items" key', () => {
    const items = [{ task_id: 't1' }];
    expect(readTaskRows({ items })).toBe(items);
  });

  it('returns [] for null', () => {
    expect(readTaskRows(null)).toEqual([]);
  });

  it('returns [] for undefined', () => {
    expect(readTaskRows(undefined)).toEqual([]);
  });

  it('returns [] for a number', () => {
    expect(readTaskRows(42)).toEqual([]);
  });

  it('returns [] for an empty object (no known key)', () => {
    expect(readTaskRows({})).toEqual([]);
  });

  it('returns [] when "tasks" value is not an array', () => {
    expect(readTaskRows({ tasks: 'not-an-array' })).toEqual([]);
  });

  it('returns [] for a plain string', () => {
    expect(readTaskRows('data')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// readTaskRev
// ---------------------------------------------------------------------------

describe('readTaskRev', () => {
  it('reads state_rev from a bare record', () => {
    expect(readTaskRev({ state_rev: 5 })).toBe(5);
  });

  it('reads rev as a fallback', () => {
    expect(readTaskRev({ rev: 3 })).toBe(3);
  });

  it('reads version as a second fallback', () => {
    expect(readTaskRev({ version: 7 })).toBe(7);
  });

  it('prefers state_rev over rev and version', () => {
    expect(readTaskRev({ state_rev: 9, rev: 1, version: 2 })).toBe(9);
  });

  it('reads rev when state_rev is absent', () => {
    expect(readTaskRev({ rev: 4, version: 1 })).toBe(4);
  });

  it('reads from a wrapped "task" record', () => {
    expect(readTaskRev({ task: { state_rev: 12 } })).toBe(12);
  });

  it('returns undefined when no rev field is present', () => {
    expect(readTaskRev({ task_id: 't1', state: 'pending' })).toBeUndefined();
  });

  it('returns undefined for a non-numeric (string) rev', () => {
    expect(readTaskRev({ state_rev: 'not-a-number' })).toBeUndefined();
  });

  it('returns undefined for Infinity rev', () => {
    expect(readTaskRev({ state_rev: Infinity })).toBeUndefined();
  });

  it('returns undefined for NaN rev', () => {
    expect(readTaskRev({ state_rev: NaN })).toBeUndefined();
  });

  it('returns undefined for null input', () => {
    expect(readTaskRev(null)).toBeUndefined();
  });

  it('returns undefined for a non-object input', () => {
    expect(readTaskRev('string')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// advanceCursor
// ---------------------------------------------------------------------------

describe('advanceCursor', () => {
  it('returns an empty cursor for empty rows and no prior cursor', () => {
    expect(advanceCursor(undefined, [])).toEqual({});
  });

  it('advances to the max rev from rows', () => {
    const rows = [{ state_rev: 3 }, { state_rev: 7 }, { state_rev: 1 }];
    expect(advanceCursor(undefined, rows)).toEqual({ state_rev: 7 });
  });

  it('uses the prior state_rev as a floor (never regresses)', () => {
    const rows = [{ state_rev: 2 }];
    expect(advanceCursor({ state_rev: 10 }, rows)).toEqual({ state_rev: 10 });
  });

  it('advances beyond the prior state_rev when rows have a higher rev', () => {
    const rows = [{ state_rev: 15 }, { state_rev: 8 }];
    expect(advanceCursor({ state_rev: 10 }, rows)).toEqual({ state_rev: 15 });
  });

  it('preserves a prior opaque token when no row advances the rev', () => {
    const rows = [{ state_rev: 2 }];
    const cursor = advanceCursor({ state_rev: 5, token: 'opaque-tok' }, rows);
    expect(cursor.token).toBe('opaque-tok');
    expect(cursor.state_rev).toBe(5);
  });

  it('preserves a prior opaque token when rows do advance the rev', () => {
    const rows = [{ state_rev: 9 }];
    const cursor = advanceCursor({ state_rev: 5, token: 'opaque-tok' }, rows);
    expect(cursor.token).toBe('opaque-tok');
    expect(cursor.state_rev).toBe(9);
  });

  it('ignores rows with no state_rev', () => {
    const rows = [{ task_id: 't1' }, { state: 'pending' }];
    expect(advanceCursor({ state_rev: 3 }, rows)).toEqual({ state_rev: 3 });
  });

  it('preserves a token-only prior cursor when rows have no revisions', () => {
    // A prior cursor with only a token (no state_rev) is preserved as-is when
    // no row has a revision — state_rev should not be added (it stays absent).
    const rows = [{ task_id: 't1', state: 'pending' }];
    const cursor = advanceCursor({ token: 'opaque-continuation-xyz' }, rows);
    expect(cursor.token).toBe('opaque-continuation-xyz');
    expect(cursor.state_rev).toBeUndefined();
  });

  it('adds state_rev from rows to a token-only prior cursor', () => {
    const rows = [{ task_id: 't1', state_rev: 8 }];
    const cursor = advanceCursor({ token: 'opaque-tok' }, rows);
    expect(cursor.token).toBe('opaque-tok');
    expect(cursor.state_rev).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// deriveEdges
// ---------------------------------------------------------------------------

describe('deriveEdges', () => {
  it('derives depends_on edges from tasks', () => {
    const tasks: ResumedTask[] = [
      { task_id: 't2', state: 'pending', assignee: null, depends_on: ['t1'], blocks: [] },
    ];
    const edges = deriveEdges(tasks);
    expect(edges).toContainEqual({ from: 't2', to: 't1', kind: 'depends_on' });
  });

  it('derives blocks edges from tasks', () => {
    const tasks: ResumedTask[] = [
      { task_id: 't1', state: 'pending', assignee: null, depends_on: [], blocks: ['t3'] },
    ];
    const edges = deriveEdges(tasks);
    expect(edges).toContainEqual({ from: 't1', to: 't3', kind: 'blocks' });
  });

  it('deduplicates edges from overlapping depends_on / blocks', () => {
    const tasks: ResumedTask[] = [
      { task_id: 't2', state: 'pending', assignee: null, depends_on: ['t1', 't1'], blocks: [] },
    ];
    const edges = deriveEdges(tasks);
    const depEdges = edges.filter((e) => e.from === 't2' && e.to === 't1' && e.kind === 'depends_on');
    expect(depEdges).toHaveLength(1);
  });

  it('skips edges where from or to is empty string', () => {
    const tasks: ResumedTask[] = [
      { task_id: '', state: 'pending', assignee: null, depends_on: ['t1'], blocks: ['t2'] },
      { task_id: 't3', state: 'pending', assignee: null, depends_on: [''], blocks: [] },
    ];
    const edges = deriveEdges(tasks);
    expect(edges).toHaveLength(0);
  });

  it('returns an empty array for an empty task list', () => {
    expect(deriveEdges([])).toEqual([]);
  });

  it('handles tasks with multiple deps and blocks correctly', () => {
    const tasks: ResumedTask[] = [
      { task_id: 't3', state: 'pending', assignee: null, depends_on: ['t1', 't2'], blocks: ['t4'] },
    ];
    const edges = deriveEdges(tasks);
    expect(edges).toHaveLength(3);
    expect(edges).toContainEqual({ from: 't3', to: 't1', kind: 'depends_on' });
    expect(edges).toContainEqual({ from: 't3', to: 't2', kind: 'depends_on' });
    expect(edges).toContainEqual({ from: 't3', to: 't4', kind: 'blocks' });
  });
});

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

describe('reconcile — state partitioning', () => {
  it('classifies succeeded tasks as done', () => {
    const tasks: ResumedTask[] = [
      { task_id: 't1', state: 'succeeded', assignee: null, depends_on: [], blocks: [] },
    ];
    const r = reconcile(tasks);
    expect(r.done).toContain('t1');
    expect(r.inFlight).not.toContain('t1');
    expect(r.ready).not.toContain('t1');
    expect(r.blocked).not.toContain('t1');
  });

  it('classifies failed tasks as done (terminal)', () => {
    const tasks: ResumedTask[] = [
      { task_id: 't1', state: 'failed', assignee: null, depends_on: [], blocks: [] },
    ];
    const r = reconcile(tasks);
    expect(r.done).toContain('t1');
  });

  it('classifies executing tasks as inFlight', () => {
    const tasks: ResumedTask[] = [
      { task_id: 't1', state: 'executing', assignee: 'agent-x', depends_on: [], blocks: [] },
    ];
    const r = reconcile(tasks);
    expect(r.inFlight).toContain('t1');
    expect(r.done).not.toContain('t1');
    expect(r.ready).not.toContain('t1');
    expect(r.blocked).not.toContain('t1');
  });

  it('classifies assigned tasks as inFlight', () => {
    const tasks: ResumedTask[] = [
      { task_id: 't1', state: 'assigned', assignee: 'agent-y', depends_on: [], blocks: [] },
    ];
    expect(reconcile(tasks).inFlight).toContain('t1');
  });

  it('classifies a pending task with no deps as ready', () => {
    const tasks: ResumedTask[] = [
      { task_id: 't1', state: 'pending', assignee: null, depends_on: [], blocks: [] },
    ];
    expect(reconcile(tasks).ready).toContain('t1');
  });

  it('classifies a proposed task with no deps as ready', () => {
    const tasks: ResumedTask[] = [
      { task_id: 't1', state: 'proposed', assignee: null, depends_on: [], blocks: [] },
    ];
    expect(reconcile(tasks).ready).toContain('t1');
  });

  it('classifies an unknown-state task with no deps as ready', () => {
    const tasks: ResumedTask[] = [
      { task_id: 't1', state: 'unknown', assignee: null, depends_on: [], blocks: [] },
    ];
    expect(reconcile(tasks).ready).toContain('t1');
  });

  it('classifies a task as ready when all deps have succeeded', () => {
    const tasks: ResumedTask[] = [
      { task_id: 't1', state: 'succeeded', assignee: null, depends_on: [], blocks: [] },
      { task_id: 't2', state: 'pending', assignee: null, depends_on: ['t1'], blocks: [] },
    ];
    expect(reconcile(tasks).ready).toContain('t2');
  });

  it('classifies a task as blocked when a dep is still pending', () => {
    const tasks: ResumedTask[] = [
      { task_id: 't1', state: 'pending', assignee: null, depends_on: [], blocks: [] },
      { task_id: 't2', state: 'pending', assignee: null, depends_on: ['t1'], blocks: [] },
    ];
    expect(reconcile(tasks).blocked).toContain('t2');
  });

  it('classifies a task as blocked when a dep has failed (failed ≠ succeeded)', () => {
    const tasks: ResumedTask[] = [
      { task_id: 't1', state: 'failed', assignee: null, depends_on: [], blocks: [] },
      { task_id: 't2', state: 'pending', assignee: null, depends_on: ['t1'], blocks: [] },
    ];
    expect(reconcile(tasks).blocked).toContain('t2');
    expect(reconcile(tasks).ready).not.toContain('t2');
  });

  it('classifies a task as blocked when a dep is in-flight', () => {
    const tasks: ResumedTask[] = [
      { task_id: 't1', state: 'executing', assignee: 'agent-a', depends_on: [], blocks: [] },
      { task_id: 't2', state: 'pending', assignee: null, depends_on: ['t1'], blocks: [] },
    ];
    expect(reconcile(tasks).blocked).toContain('t2');
  });

  it('classifies a task as blocked when a dep is entirely missing from the list', () => {
    const tasks: ResumedTask[] = [
      { task_id: 't2', state: 'pending', assignee: null, depends_on: ['missing-t1'], blocks: [] },
    ];
    expect(reconcile(tasks).blocked).toContain('t2');
  });

  it('classifies a task as blocked when any dep is not succeeded (partial satisfaction)', () => {
    const tasks: ResumedTask[] = [
      { task_id: 't1', state: 'succeeded', assignee: null, depends_on: [], blocks: [] },
      { task_id: 't2', state: 'pending', assignee: null, depends_on: [], blocks: [] },
      { task_id: 't3', state: 'pending', assignee: null, depends_on: ['t1', 't2'], blocks: [] },
    ];
    expect(reconcile(tasks).blocked).toContain('t3');
    expect(reconcile(tasks).ready).not.toContain('t3');
  });

  it('returns empty arrays for an empty task list', () => {
    const r = reconcile([]);
    expect(r.done).toEqual([]);
    expect(r.inFlight).toEqual([]);
    expect(r.ready).toEqual([]);
    expect(r.blocked).toEqual([]);
  });

  it('a task with an empty task_id in terminal state lands in done (empty id, not added to succeeded set)', () => {
    // projectResumedTask degrades to task_id='' for untrackable rows; reconcile
    // still classifies them by state (they land in a bucket by their empty id string).
    // The watchTasks layer skips these before emitting deltas — this test pins the
    // reconcile behavior so the contract is explicit and documented.
    const tasks: ResumedTask[] = [
      { task_id: '', state: 'succeeded', assignee: null, depends_on: [], blocks: [] },
    ];
    const r = reconcile(tasks);
    expect(r.done).toContain('');
    // The empty id is NOT added to the succeeded set, so it cannot satisfy a dependent.
    expect(r.ready).toEqual([]);
  });

  it('a task with empty task_id does NOT satisfy another task\'s depends_on', () => {
    // Empty id is excluded from the succeeded set, so a dep on '' is never satisfied.
    const tasks: ResumedTask[] = [
      { task_id: '', state: 'succeeded', assignee: null, depends_on: [], blocks: [] },
      { task_id: 't2', state: 'pending', assignee: null, depends_on: [''], blocks: [] },
    ];
    const r = reconcile(tasks);
    expect(r.blocked).toContain('t2'); // dep on '' is not satisfied
    expect(r.ready).not.toContain('t2');
  });

  it('every task appears in exactly one bucket', () => {
    const tasks: ResumedTask[] = [
      { task_id: 't1', state: 'succeeded', assignee: null, depends_on: [], blocks: [] },
      { task_id: 't2', state: 'executing', assignee: 'a', depends_on: [], blocks: [] },
      { task_id: 't3', state: 'pending', assignee: null, depends_on: ['t1'], blocks: [] },
      { task_id: 't4', state: 'pending', assignee: null, depends_on: ['t2'], blocks: [] },
    ];
    const r = reconcile(tasks);
    const allBuckets = [...r.done, ...r.inFlight, ...r.ready, ...r.blocked];
    expect(allBuckets).toHaveLength(tasks.length);
    expect(new Set(allBuckets).size).toBe(tasks.length);
  });
});

// ---------------------------------------------------------------------------
// buildPlanSnapshot
// ---------------------------------------------------------------------------

describe('buildPlanSnapshot', () => {
  it('assembles tasks, edges, reconciliation and cursor from raw rows', () => {
    const rows = [
      { task_id: 't1', state: 'succeeded', depends_on: [], blocks: ['t2'] },
      { task_id: 't2', state: 'pending', depends_on: ['t1'], blocks: [] },
    ];
    const snapshot = buildPlanSnapshot('!room:srv', rows, undefined);
    expect(snapshot.room).toBe('!room:srv');
    expect(snapshot.tasks).toHaveLength(2);
    expect(snapshot.edges.length).toBeGreaterThan(0);
    expect(snapshot.reconciliation.done).toContain('t1');
    expect(snapshot.reconciliation.ready).toContain('t2');
    expect(snapshot.fault).toBeUndefined();
  });

  it('advances the cursor from row revisions', () => {
    const rows = [{ task_id: 't1', state_rev: 5 }, { task_id: 't2', state_rev: 3 }];
    const snapshot = buildPlanSnapshot('!r:srv', rows, undefined);
    expect(snapshot.cursor.state_rev).toBe(5);
  });

  it('preserves a prior cursor and advances it', () => {
    const rows = [{ task_id: 't1', state_rev: 10 }];
    const snapshot = buildPlanSnapshot('!r:srv', rows, { state_rev: 7, token: 'tok' });
    expect(snapshot.cursor.state_rev).toBe(10);
    expect(snapshot.cursor.token).toBe('tok');
  });

  it('handles an empty row list (empty-but-valid snapshot)', () => {
    const snapshot = buildPlanSnapshot('!r:srv', [], undefined);
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.edges).toEqual([]);
    expect(snapshot.reconciliation).toEqual({ done: [], inFlight: [], ready: [], blocked: [] });
    expect(snapshot.fault).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// reconstructPlan — the async orchestrator
// ---------------------------------------------------------------------------

describe('reconstructPlan — happy path', () => {
  it('calls task.list with the room param', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const call: DaemonCall = async (method, params) => {
      calls.push({ method, params });
      return [];
    };
    await reconstructPlan(call, '!myroom:srv');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe(TASK_LIST_METHOD);
    expect((calls[0]?.params as Record<string, unknown>)?.['room']).toBe('!myroom:srv');
  });

  it('omits the room param when room is empty string', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const call: DaemonCall = async (method, params) => {
      calls.push({ method, params });
      return [];
    };
    await reconstructPlan(call, '');
    expect(calls[0]?.params).toBeUndefined();
  });

  it('returns a PlanSnapshot with the room field', async () => {
    const call: DaemonCall = async () => [];
    const snapshot = await reconstructPlan(call, '!myroom:srv');
    expect(snapshot.room).toBe('!myroom:srv');
    expect(snapshot.fault).toBeUndefined();
  });

  it('projects tasks from a bare array reply', async () => {
    const rows = [{ task_id: 't1', state: 'pending' }];
    const call: DaemonCall = async () => rows;
    const snapshot = await reconstructPlan(call, '!r:srv');
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]?.task_id).toBe('t1');
  });

  it('projects tasks from a wrapped { tasks: [...] } reply', async () => {
    const call: DaemonCall = async () => ({ tasks: [{ task_id: 't2', state: 'executing' }] });
    const snapshot = await reconstructPlan(call, '!r:srv');
    expect(snapshot.tasks[0]?.task_id).toBe('t2');
  });

  it('passes the prior cursor to buildPlanSnapshot (cursor advances)', async () => {
    const call: DaemonCall = async () => [{ task_id: 't1', state_rev: 9 }];
    const snapshot = await reconstructPlan(call, '!r:srv', { state_rev: 5 });
    expect(snapshot.cursor.state_rev).toBe(9);
  });

  it('does NOT call any dispatch RPC — only task.list', async () => {
    const methods: string[] = [];
    const call: DaemonCall = async (method) => { methods.push(method); return []; };
    await reconstructPlan(call, '!r:srv');
    expect(methods).toEqual([TASK_LIST_METHOD]);
  });
});

describe('reconstructPlan — fault handling (never throws)', () => {
  it('returns an empty-but-valid snapshot when task.list throws a TransportError', async () => {
    const call: DaemonCall = async () => {
      throw new TransportError('rpc', 'fake rpc error');
    };
    const snapshot = await reconstructPlan(call, '!r:srv');
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.edges).toEqual([]);
    expect(snapshot.reconciliation).toEqual({ done: [], inFlight: [], ready: [], blocked: [] });
    expect(snapshot.fault).toBe('rpc');
  });

  it('maps non-TransportError faults to "protocol"', async () => {
    const call: DaemonCall = async () => { throw new Error('unexpected'); };
    const snapshot = await reconstructPlan(call, '!r:srv');
    expect(snapshot.fault).toBe('protocol');
  });

  it('preserves the prior cursor in a fault snapshot', async () => {
    const call: DaemonCall = async () => { throw new TransportError('timeout', 'timed out'); };
    const snapshot = await reconstructPlan(call, '!r:srv', { state_rev: 7, token: 'tok' });
    expect(snapshot.cursor.state_rev).toBe(7);
    expect(snapshot.cursor.token).toBe('tok');
    expect(snapshot.fault).toBe('timeout');
  });

  it('never throws — awaiting reconstructPlan always resolves', async () => {
    const call: DaemonCall = async () => { throw new TransportError('not_running', 'gone'); };
    await expect(reconstructPlan(call, '!r:srv')).resolves.toBeDefined();
  });

  it('a fault snapshot has an empty but structurally valid reconciliation', async () => {
    const call: DaemonCall = async () => { throw new TransportError('closed', 'gone'); };
    const snapshot = await reconstructPlan(call, '!r:srv');
    expect(snapshot.reconciliation.done).toEqual([]);
    expect(snapshot.reconciliation.inFlight).toEqual([]);
    expect(snapshot.reconciliation.ready).toEqual([]);
    expect(snapshot.reconciliation.blocked).toEqual([]);
  });
});
