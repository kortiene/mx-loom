/**
 * Pure unit tests for the task-projection layer (T301 / #30) —
 * `mapTaskState`, `projectTaskNode`, `projectTaskEdge`, `deriveEdges`,
 * `mergeEdges`, and `taskNodeResponseToResult`.
 *
 * Tests pin:
 *  - `mapTaskState`: the full 6-state canonical table + every synonym + safe
 *    `unknown` fallback for unrecognised / absent / non-string tokens.
 *    Case-insensitive; token normalisation (hyphens, mixed-case, `IN_PROGRESS`, …).
 *  - `projectTaskNode`: total / never-throws; allowlist-by-construction; reads
 *    bare and wrapped `{ task: {...} }` shapes; task_id fallback (`id`);
 *    state/status/phase alternates; assignee/assigned_to/assign alternates;
 *    action sub-shapes (tool + exec); malformed input degrades gracefully.
 *  - `projectTaskEdge`: happy path; from/to aliases (source/target); kind='blocks'
 *    preserved, default kind='depends_on'; missing from/to → undefined; empty strings.
 *  - `deriveEdges`: generates depends_on + blocks edges; deduplication; empty nodes.
 *  - `mergeEdges`: merged without duplicates; non-array graph response → derived only;
 *    malformed edge items skipped.
 *  - `taskNodeResponseToResult`: success → ok(TaskNode, audit_ref); daemon error signal
 *    → failure envelope; non-object → internal; audit_ref extracted from reply.
 *
 * No daemon, no env, no network. Pure functions.
 */
import { describe, expect, it } from 'vitest';

import {
  deriveEdges,
  mapTaskState,
  mergeEdges,
  projectTaskEdge,
  projectTaskNode,
  taskNodeResponseToResult,
  validateEnvelope,
  TASK_STATES,
  TASK_STATE_OUTPUTS,
  type TaskNode,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// mapTaskState — the "map states" AC
// ---------------------------------------------------------------------------

describe('mapTaskState — canonical tokens', () => {
  it.each([
    ['proposed', 'proposed'],
    ['pending', 'pending'],
    ['assigned', 'assigned'],
    ['executing', 'executing'],
    ['succeeded', 'succeeded'],
    ['failed', 'failed'],
  ] as [string, string][])('%s → %s', (raw, expected) => {
    expect(mapTaskState(raw)).toBe(expected);
  });
});

describe('mapTaskState — tolerated synonyms (proposed group)', () => {
  it.each(['new', 'created', 'draft'])('%s → proposed', (token) => {
    expect(mapTaskState(token)).toBe('proposed');
  });
});

describe('mapTaskState — tolerated synonyms (pending group)', () => {
  it.each(['queued', 'waiting', 'blocked', 'ready'])('%s → pending', (token) => {
    expect(mapTaskState(token)).toBe('pending');
  });
});

describe('mapTaskState — tolerated synonyms (assigned group)', () => {
  it.each(['claimed', 'accepted', 'scheduled'])('%s → assigned', (token) => {
    expect(mapTaskState(token)).toBe('assigned');
  });
});

describe('mapTaskState — tolerated synonyms (executing group)', () => {
  it.each(['running', 'in_progress', 'inprogress', 'active', 'started', 'in_flight', 'inflight'])(
    '%s → executing',
    (token) => {
      expect(mapTaskState(token)).toBe('executing');
    },
  );
});

describe('mapTaskState — tolerated synonyms (succeeded group)', () => {
  it.each(['success', 'done', 'complete', 'completed', 'finished', 'resolved', 'ok'])(
    '%s → succeeded',
    (token) => {
      expect(mapTaskState(token)).toBe('succeeded');
    },
  );
});

describe('mapTaskState — tolerated synonyms (failed group)', () => {
  it.each(['failure', 'error', 'errored', 'faulted', 'cancelled', 'canceled', 'aborted'])(
    '%s → failed',
    (token) => {
      expect(mapTaskState(token)).toBe('failed');
    },
  );
});

describe('mapTaskState — case and punctuation normalisation', () => {
  it('Executing (capital E) → executing', () => expect(mapTaskState('Executing')).toBe('executing'));
  it('IN_PROGRESS → executing', () => expect(mapTaskState('IN_PROGRESS')).toBe('executing'));
  it('in-progress (hyphen) → executing', () => expect(mapTaskState('in-progress')).toBe('executing'));
  it('SUCCEEDED → succeeded', () => expect(mapTaskState('SUCCEEDED')).toBe('succeeded'));
  it('Failed → failed', () => expect(mapTaskState('Failed')).toBe('failed'));
  it('PROPOSED → proposed', () => expect(mapTaskState('PROPOSED')).toBe('proposed'));
});

describe('mapTaskState — safe unknown fallback', () => {
  it('undefined → unknown (absent)', () => expect(mapTaskState(undefined)).toBe('unknown'));
  it('null → unknown', () => expect(mapTaskState(null)).toBe('unknown'));
  it('empty string → unknown', () => expect(mapTaskState('')).toBe('unknown'));
  it('totally unrecognised token → unknown', () => expect(mapTaskState('teleported')).toBe('unknown'));
  it('number → unknown', () => expect(mapTaskState(42)).toBe('unknown'));
  it('object → unknown', () => expect(mapTaskState({})).toBe('unknown'));
});

describe('TASK_STATES / TASK_STATE_OUTPUTS constants', () => {
  it('TASK_STATES has the 6 input states', () => {
    expect([...TASK_STATES]).toEqual(['proposed', 'pending', 'assigned', 'executing', 'succeeded', 'failed']);
  });

  it('TASK_STATE_OUTPUTS has the 6 input states + "unknown"', () => {
    expect([...TASK_STATE_OUTPUTS]).toEqual([...TASK_STATES, 'unknown']);
  });
});

// ---------------------------------------------------------------------------
// projectTaskNode
// ---------------------------------------------------------------------------

const AUDIT_REF = {
  invocation_id: 'inv_1',
  request_id: 'req_1',
  room: '!room:server',
  event_id: '$evt_1',
};

describe('projectTaskNode — happy path', () => {
  it('projects a well-formed task record onto TaskNode', () => {
    const raw = {
      task_id: 'task_abc',
      title: 'Write tests',
      state: 'proposed',
      assignee: 'agent_x',
      depends_on: ['task_dep1'],
      blocks: ['task_dep2'],
      action: { kind: 'tool', tool: 'run_tests', args: { suite: 'unit' } },
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    };
    const node = projectTaskNode(raw);
    expect(node.task_id).toBe('task_abc');
    expect(node.title).toBe('Write tests');
    expect(node.state).toBe('proposed');
    expect(node.assignee).toBe('agent_x');
    expect(node.depends_on).toEqual(['task_dep1']);
    expect(node.blocks).toEqual(['task_dep2']);
    expect(node.action?.kind).toBe('tool');
    expect(node.action?.tool).toBe('run_tests');
    expect(node.created_at).toBe('2026-01-01T00:00:00Z');
    expect(node.updated_at).toBe('2026-01-02T00:00:00Z');
  });

  it('unwraps a wrapped { task: {...} } reply shape', () => {
    const raw = {
      task: { task_id: 'task_wrapped', title: 'Wrapped', state: 'pending', depends_on: [], blocks: [] },
      audit_ref: AUDIT_REF,
    };
    const node = projectTaskNode(raw);
    expect(node.task_id).toBe('task_wrapped');
    expect(node.state).toBe('pending');
  });

  it('falls back to `id` when `task_id` is absent (pinned at the round-trip)', () => {
    const raw = { id: 'task_via_id', title: 'ID fallback', state: 'executing' };
    const node = projectTaskNode(raw);
    expect(node.task_id).toBe('task_via_id');
  });

  it('reads state from `status` when `state` is absent', () => {
    const raw = { task_id: 'task_s', title: 'Status field', status: 'running' };
    const node = projectTaskNode(raw);
    expect(node.state).toBe('executing');
  });

  it('reads state from `phase` when `state` and `status` are absent', () => {
    const raw = { task_id: 'task_p', title: 'Phase field', phase: 'done' };
    const node = projectTaskNode(raw);
    expect(node.state).toBe('succeeded');
  });

  it('reads assignee from `assigned_to` when `assignee` is absent', () => {
    const raw = { task_id: 'task_at', title: 'AssignedTo', state: 'assigned', assigned_to: 'agent_y' };
    const node = projectTaskNode(raw);
    expect(node.assignee).toBe('agent_y');
  });

  it('reads assignee from `assign` when both `assignee` and `assigned_to` are absent', () => {
    const raw = { task_id: 'task_a', title: 'Assign', state: 'assigned', assign: 'agent_z' };
    const node = projectTaskNode(raw);
    expect(node.assignee).toBe('agent_z');
  });

  it('assignee is null when not present', () => {
    const raw = { task_id: 'task_noassign', title: 'No assignee', state: 'proposed' };
    const node = projectTaskNode(raw);
    expect(node.assignee).toBeNull();
  });

  it('action is null when the record carries none', () => {
    const raw = { task_id: 'task_noaction', title: 'No action', state: 'proposed' };
    const node = projectTaskNode(raw);
    expect(node.action).toBeNull();
  });

  it('action kind=exec: projects command, command_args, cwd', () => {
    const raw = {
      task_id: 'task_exec',
      title: 'Exec',
      state: 'proposed',
      action: { kind: 'exec', command: 'make', command_args: ['test'], cwd: '/repo' },
    };
    const node = projectTaskNode(raw);
    expect(node.action?.kind).toBe('exec');
    expect(node.action?.command).toBe('make');
    expect(node.action?.command_args).toEqual(['test']);
    expect(node.action?.cwd).toBe('/repo');
  });

  it('action with unknown kind is projected as null (filtered out)', () => {
    const raw = {
      task_id: 'task_badkind',
      title: 'Bad kind',
      state: 'proposed',
      action: { kind: 'unknown_kind', tool: 'something' },
    };
    const node = projectTaskNode(raw);
    expect(node.action).toBeNull();
  });

  it('action kind=exec with `args` array (daemon may return exec argv in `args` not `command_args`)', () => {
    // The daemon may serialise exec argv as `args` (an array) rather than `command_args`.
    // The projector falls back: kind=exec && Array.isArray(a.args) → command_args.
    const raw = {
      task_id: 'task_exec_args',
      title: 'Exec args alias',
      state: 'proposed',
      action: { kind: 'exec', command: 'npm', args: ['test', '--ci'], cwd: '/repo' },
    };
    const node = projectTaskNode(raw);
    expect(node.action?.kind).toBe('exec');
    expect(node.action?.command).toBe('npm');
    // The projector maps the daemon's `args` array onto `command_args`.
    expect(node.action?.command_args).toEqual(['test', '--ci']);
    expect(node.action?.cwd).toBe('/repo');
  });
});

describe('projectTaskNode — malformed / missing inputs (never throws)', () => {
  it('null → safe default node (never throws)', () => {
    expect(() => projectTaskNode(null)).not.toThrow();
    const node = projectTaskNode(null);
    expect(node.task_id).toBe('');
    expect(node.title).toBe('');
    expect(node.state).toBe('unknown');
    expect(node.assignee).toBeNull();
    expect(node.depends_on).toEqual([]);
    expect(node.blocks).toEqual([]);
    expect(node.action).toBeNull();
  });

  it('undefined → safe default node', () => {
    expect(() => projectTaskNode(undefined)).not.toThrow();
  });

  it('string → safe default node (never throws)', () => {
    expect(() => projectTaskNode('not an object')).not.toThrow();
  });

  it('array → safe default node (never throws)', () => {
    expect(() => projectTaskNode([1, 2, 3])).not.toThrow();
  });

  it('empty object → task_id="" title="" state="unknown"', () => {
    const node = projectTaskNode({});
    expect(node.task_id).toBe('');
    expect(node.title).toBe('');
    expect(node.state).toBe('unknown');
    expect(node.depends_on).toEqual([]);
  });

  it('non-string depends_on / blocks → empty arrays (never throws)', () => {
    const raw = { task_id: 'task_bad', title: 'Bad edges', depends_on: 'not-an-array', blocks: 42 };
    const node = projectTaskNode(raw);
    expect(node.depends_on).toEqual([]);
    expect(node.blocks).toEqual([]);
  });

  it('does not leak non-allowlisted fields onto the projected node', () => {
    const raw = {
      task_id: 'task_leak',
      title: 'Leak',
      state: 'proposed',
      matrix_token: 'mxs_super_secret',
      signing_key: 'ed25519_private',
      extra_field: 'should_not_appear',
    };
    const node = projectTaskNode(raw) as unknown as Record<string, unknown>;
    expect(node.matrix_token).toBeUndefined();
    expect(node.signing_key).toBeUndefined();
    expect(node.extra_field).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// projectTaskEdge
// ---------------------------------------------------------------------------

describe('projectTaskEdge — happy path', () => {
  it('projects a well-formed edge record', () => {
    const edge = projectTaskEdge({ from: 'task_a', to: 'task_b', kind: 'depends_on' });
    expect(edge).toEqual({ from: 'task_a', to: 'task_b', kind: 'depends_on' });
  });

  it('kind "blocks" is preserved', () => {
    const edge = projectTaskEdge({ from: 'task_a', to: 'task_c', kind: 'blocks' });
    expect(edge?.kind).toBe('blocks');
  });

  it('kind defaults to "depends_on" when absent or unrecognised', () => {
    expect(projectTaskEdge({ from: 'a', to: 'b' })?.kind).toBe('depends_on');
    expect(projectTaskEdge({ from: 'a', to: 'b', kind: 'unknown_kind' })?.kind).toBe('depends_on');
  });

  it('reads `source` as alias for `from`', () => {
    const edge = projectTaskEdge({ source: 'task_a', to: 'task_b', kind: 'depends_on' });
    expect(edge?.from).toBe('task_a');
  });

  it('reads `target` as alias for `to`', () => {
    const edge = projectTaskEdge({ from: 'task_a', target: 'task_b', kind: 'depends_on' });
    expect(edge?.to).toBe('task_b');
  });
});

describe('projectTaskEdge — absent / malformed input → undefined', () => {
  it('null → undefined', () => expect(projectTaskEdge(null)).toBeUndefined());
  it('undefined → undefined', () => expect(projectTaskEdge(undefined)).toBeUndefined());
  it('string → undefined', () => expect(projectTaskEdge('edge')).toBeUndefined());
  it('missing from → undefined', () => expect(projectTaskEdge({ to: 'task_b' })).toBeUndefined());
  it('missing to → undefined', () => expect(projectTaskEdge({ from: 'task_a' })).toBeUndefined());
  it('empty from → undefined', () => expect(projectTaskEdge({ from: '', to: 'task_b' })).toBeUndefined());
  it('empty to → undefined', () => expect(projectTaskEdge({ from: 'task_a', to: '' })).toBeUndefined());
});

describe('projectTaskEdge — daemon spelling aliases (task_id / depends_on)', () => {
  it('reads `task_id` as alias for `from` (daemon may omit `from` and use `task_id`)', () => {
    // The daemon may emit { task_id, depends_on } instead of { from, to }.
    const edge = projectTaskEdge({ task_id: 'task_a', to: 'task_b', kind: 'depends_on' });
    expect(edge?.from).toBe('task_a');
    expect(edge?.to).toBe('task_b');
  });

  it('reads `depends_on` as alias for `to` (daemon may use `depends_on` for the target edge)', () => {
    const edge = projectTaskEdge({ from: 'task_a', depends_on: 'task_b', kind: 'depends_on' });
    expect(edge?.to).toBe('task_b');
  });

  it('task_id + depends_on combination (both daemon aliases together)', () => {
    const edge = projectTaskEdge({ task_id: 'task_c', depends_on: 'task_d' });
    expect(edge?.from).toBe('task_c');
    expect(edge?.to).toBe('task_d');
    expect(edge?.kind).toBe('depends_on');
  });
});

// ---------------------------------------------------------------------------
// deriveEdges
// ---------------------------------------------------------------------------

describe('deriveEdges', () => {
  const nodeA: TaskNode = {
    task_id: 'task_a',
    title: 'A',
    state: 'proposed',
    assignee: null,
    depends_on: ['task_b'],
    blocks: ['task_c'],
    action: null,
  };
  const nodeB: TaskNode = {
    task_id: 'task_b',
    title: 'B',
    state: 'proposed',
    assignee: null,
    depends_on: [],
    blocks: [],
    action: null,
  };
  const nodeC: TaskNode = {
    task_id: 'task_c',
    title: 'C',
    state: 'proposed',
    assignee: null,
    depends_on: [],
    blocks: [],
    action: null,
  };

  it('derives depends_on edges', () => {
    const edges = deriveEdges([nodeA]);
    const depEdge = edges.find((e) => e.kind === 'depends_on');
    expect(depEdge).toEqual({ from: 'task_a', to: 'task_b', kind: 'depends_on' });
  });

  it('derives blocks edges', () => {
    const edges = deriveEdges([nodeA]);
    const blocksEdge = edges.find((e) => e.kind === 'blocks');
    expect(blocksEdge).toEqual({ from: 'task_a', to: 'task_c', kind: 'blocks' });
  });

  it('deduplicates identical edges', () => {
    const dupNode: TaskNode = { ...nodeA, depends_on: ['task_b', 'task_b'] };
    const edges = deriveEdges([dupNode]);
    const depEdges = edges.filter((e) => e.kind === 'depends_on');
    expect(depEdges).toHaveLength(1);
  });

  it('returns [] for an empty node list', () => {
    expect(deriveEdges([])).toEqual([]);
  });

  it('skips edges where task_id is empty', () => {
    const emptyIdNode: TaskNode = { ...nodeA, task_id: '' };
    const edges = deriveEdges([emptyIdNode]);
    expect(edges).toHaveLength(0);
  });

  it('collects edges from multiple nodes', () => {
    const nodeDep: TaskNode = { ...nodeB, depends_on: ['task_c'] };
    const edges = deriveEdges([nodeA, nodeDep]);
    expect(edges.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// mergeEdges
// ---------------------------------------------------------------------------

describe('mergeEdges', () => {
  const base = [{ from: 'a', to: 'b', kind: 'depends_on' as const }];

  it('returns derived edges when rawEdges is not an array', () => {
    expect(mergeEdges(base, undefined)).toEqual(base);
    expect(mergeEdges(base, null)).toEqual(base);
    expect(mergeEdges(base, 'not-an-array')).toEqual(base);
    expect(mergeEdges(base, {})).toEqual(base);
  });

  it('adds explicit edges from the graph reply (no duplicates)', () => {
    const explicit = [{ from: 'c', to: 'd', kind: 'depends_on' }];
    const merged = mergeEdges(base, explicit);
    expect(merged).toHaveLength(2);
    expect(merged.find((e) => e.from === 'c')).toBeDefined();
  });

  it('does not duplicate derived edges that appear in the graph reply', () => {
    const duplicate = [{ from: 'a', to: 'b', kind: 'depends_on' }];
    const merged = mergeEdges(base, duplicate);
    expect(merged).toHaveLength(1);
  });

  it('skips malformed edge items from the graph reply', () => {
    const malformed = [null, 'not-an-edge', { from: '', to: 'b' }, { from: 'x', to: 'y', kind: 'depends_on' }];
    const merged = mergeEdges(base, malformed);
    // Only the valid { from: 'x', to: 'y' } edge is added
    expect(merged).toHaveLength(2);
    expect(merged.find((e) => e.from === 'x')).toBeDefined();
  });

  it('returns [] when both derived and raw are empty', () => {
    expect(mergeEdges([], [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// taskNodeResponseToResult
// ---------------------------------------------------------------------------

describe('taskNodeResponseToResult', () => {
  it('success reply → ok(TaskNode, audit_ref) with status "ok"', () => {
    const reply = {
      task_id: 'task_1',
      title: 'Success',
      state: 'proposed',
      depends_on: [],
      blocks: [],
      audit_ref: AUDIT_REF,
    };
    const result = taskNodeResponseToResult(reply);
    expect(result.status).toBe('ok');
    expect((result.result as Record<string, unknown>).task_id).toBe('task_1');
    expect(result.audit_ref.invocation_id).toBe('inv_1');
  });

  it('extracts audit_ref from the reply', () => {
    const reply = { task_id: 'task_2', title: 'WithRef', state: 'pending', audit_ref: AUDIT_REF };
    const result = taskNodeResponseToResult(reply);
    expect(result.audit_ref).toEqual(AUDIT_REF);
  });

  it('reply with ok:false (explicit daemon error) → failure envelope', () => {
    const reply = { ok: false, error: { code: 'policy_denied', message: 'denied' }, audit_ref: AUDIT_REF };
    const result = taskNodeResponseToResult(reply);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
  });

  it('reply with explicit error and policy_denied code → denied status', () => {
    const reply = { ok: false, state: 'policy_denied', audit_ref: AUDIT_REF };
    const result = taskNodeResponseToResult(reply);
    expect(result.status).toBe('denied');
  });

  it('reply with untrusted_key state → denied(untrusted_key)', () => {
    const reply = { ok: false, error: { code: 'untrusted_key' } };
    const result = taskNodeResponseToResult(reply);
    expect(result.error?.code).toBe('untrusted_key');
  });

  it('reply with approval_denied → denied(approval_denied) (denial-set code)', () => {
    const reply = { ok: false, error: { code: 'approval_denied', message: 'operator denied' } };
    const result = taskNodeResponseToResult(reply);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('approval_denied');
  });

  it('reply with approval_expired → denied(approval_expired) (denial-set code)', () => {
    const reply = { ok: false, error: { code: 'approval_expired', message: 'expired' } };
    const result = taskNodeResponseToResult(reply);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('approval_expired');
  });

  it('null → internal error (non-object reply)', () => {
    const result = taskNodeResponseToResult(null);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });

  it('scalar → internal error', () => {
    const result = taskNodeResponseToResult('not-an-object');
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });

  it('array → internal error', () => {
    const result = taskNodeResponseToResult([1, 2, 3]);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });

  it('all results validate against ENVELOPE_SCHEMA', () => {
    const cases = [
      { task_id: 'task_ok', title: 'OK', state: 'proposed' },
      { ok: false, error: { code: 'policy_denied' } },
      null,
    ];
    for (const c of cases) {
      const result = taskNodeResponseToResult(c);
      expect(validateEnvelope(result), `${JSON.stringify(c)} should produce a valid envelope`).toBe(true);
    }
  });

  it('never throws on any input', () => {
    const inputs = [null, undefined, '', 0, [], {}, Symbol(), () => {}];
    for (const input of inputs) {
      expect(() => taskNodeResponseToResult(input)).not.toThrow();
    }
  });
});
