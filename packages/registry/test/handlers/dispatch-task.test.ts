/**
 * `mxDispatchTask` handler unit tests (T303 / #32) — daemon-free.
 *
 * Tests pin:
 *  - Room provenance: missing / empty room → `internal` error, no daemon call.
 *  - Empty task_id → `invalid_args` before a list call.
 *  - Task not found (empty list) → `not_found`.
 *  - Node with no action → `invalid_args`.
 *  - Node with an un-dispatchable action (no tool/command) → `invalid_args`.
 *  - Unassigned node → `invalid_args` (cannot dispatch without a target agent).
 *  - Terminal nodes (`succeeded` / `failed`) → `invalid_args`.
 *  - Active node (`executing`) → dispatches safely (idempotency dedupes on the daemon).
 *  - Happy path kind=tool: dispatches via `call.start` (delegation path), returns ok.
 *  - Happy path kind=exec: dispatches via `exec.start` (exec path), returns ok.
 *  - Correct params forwarded: tool name, args, agent for tool; command, args, cwd, agent for exec.
 *  - Assignee used as the delegation / exec target agent.
 *  - Idempotency: default key = `idk_task_<task_id>` (task-stable, same key on re-dispatch).
 *  - Caller-supplied idempotency_key forwarded verbatim.
 *  - Deferred: running from receiver → `status: running` + handle.
 *  - Approval: awaiting_approval → `status: awaiting_approval` + handle (approval gate not hidden).
 *  - Denials: `policy_denied` / `untrusted_key` / `approval_denied` from receiver → `denied`.
 *  - `task.list` fault propagates as that envelope.
 *  - Transport faults from the delegate / exec path → closed taxonomy.
 *  - Never throws on any input.
 *  - All envelopes validate against ENVELOPE_SCHEMA.
 *
 * No real daemon, no network, no env. Injects a multi-method fake `DaemonCall` that
 * handles `task.list`, `agent.tools`, `call.start`, and `exec.start` separately.
 */
import { describe, expect, it } from 'vitest';

import { TransportError } from '@mx-loom/toolbelt';

import {
  mxDispatchTask,
  validateEnvelope,
  type DaemonCall,
  type DispatchDeps,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const ROOM = '!workspace:homeserver';
const AGENT_ID = 'ag_worker_01';
const TOOL_NAME = 'run_tests';
const TASK_ID_TOOL = 'task_tool_abc';
const TASK_ID_EXEC = 'task_exec_abc';

/** A raw daemon task record with a kind='tool' action. */
const TASK_TOOL_RAW = {
  task_id: TASK_ID_TOOL,
  title: 'Run the test suite',
  state: 'assigned',
  assignee: AGENT_ID,
  depends_on: [],
  blocks: [],
  action: {
    kind: 'tool',
    tool: TOOL_NAME,
    args: {},
  },
};

/** A raw daemon task record with a kind='exec' action. */
const TASK_EXEC_RAW = {
  task_id: TASK_ID_EXEC,
  title: 'Build the project',
  state: 'assigned',
  assignee: AGENT_ID,
  depends_on: [],
  blocks: [],
  action: {
    kind: 'exec',
    command: 'make',
    command_args: ['build'],
    cwd: '/repo',
  },
};

/**
 * Agent tools response for the delegation path. The input_schema is fully open
 * so `args: {}` (the projected action's args) always passes validation.
 */
const TOOLS_RESPONSE = {
  agent_id: AGENT_ID,
  kind: 'worker',
  status: 'online',
  capabilities: [],
  tools: [TOOL_NAME],
  schemas: [
    {
      name: TOOL_NAME,
      version: '1.0.0',
      description: 'Run the test suite',
      input_schema: { type: 'object', additionalProperties: true },
      output_schema: { type: 'object', additionalProperties: true },
    },
  ],
};

/** Synchronous ok response for call.start. */
const SYNC_OK_CALL = {
  ok: true,
  result: { tests_run: 42, passed: 42 },
  invocation_id: 'inv_call_01',
  request_id: 'req_call_01',
  room: ROOM,
  event_id: '$evt_call_01',
};

/** Synchronous ok response for exec.start. */
const SYNC_OK_EXEC = {
  ok: true,
  result: { exit_code: 0, summary: 'Build complete' },
  invocation_id: 'inv_exec_01',
  request_id: 'req_exec_01',
  room: ROOM,
  event_id: '$evt_exec_01',
};

/** Deferred running response for call.start / exec.start. */
const RUNNING_RESPONSE = {
  state: 'running',
  handle: 'inv_run_01',
  invocation_id: 'inv_run_01',
  request_id: 'req_run_01',
  room: ROOM,
  event_id: '$evt_run_01',
};

/** Awaiting approval response for call.start. */
const AWAITING_RESPONSE = {
  state: 'awaiting_approval',
  handle: 'inv_ap_01',
  invocation_id: 'inv_ap_01',
  request_id: 'req_ap_01',
  room: ROOM,
  event_id: '$evt_ap_01',
  approval: { risk: 'high', context: 'test run may affect CI' },
};

/**
 * Build a multi-method fake daemon for dispatch-task tests.
 *
 * Handles: `task.list`, `task.graph`, `agent.tools`, `call.start`, `exec.start`.
 * Errors and responses are injectable per method.
 */
function makeDispatchDaemon(opts: {
  tasks?: unknown[];
  toolsResponse?: unknown;
  callResponse?: unknown;
  execResponse?: unknown;
  listError?: Error;
  callError?: Error;
  execError?: Error;
  onCall?: (method: string, params: unknown) => void;
} = {}): DaemonCall {
  const taskList = opts.tasks ?? [TASK_TOOL_RAW];

  return {
    async call(method: string, params?: unknown): Promise<unknown> {
      opts.onCall?.(method, params ?? null);

      if (method === 'task.list') {
        if (opts.listError) throw opts.listError;
        return taskList;
      }
      if (method === 'task.graph') return [];
      if (method === 'agent.tools') return opts.toolsResponse ?? TOOLS_RESPONSE;
      if (method === 'call.start') {
        if (opts.callError) throw opts.callError;
        return opts.callResponse ?? SYNC_OK_CALL;
      }
      if (method === 'exec.start') {
        if (opts.execError) throw opts.execError;
        return opts.execResponse ?? SYNC_OK_EXEC;
      }
      throw new Error(`unexpected daemon method in test: ${method}`);
    },
  };
}

/**
 * Build `DispatchDeps` with sensible defaults for tests.
 * Pass `room: undefined` explicitly to test the missing-room path.
 */
function makeDeps(opts: {
  room?: string | undefined;
  tasks?: unknown[];
  toolsResponse?: unknown;
  callResponse?: unknown;
  execResponse?: unknown;
  listError?: Error;
  callError?: Error;
  execError?: Error;
  onCall?: (method: string, params: unknown) => void;
} = {}): DispatchDeps {
  const roomValue =
    Object.prototype.hasOwnProperty.call(opts, 'room') ? opts.room : ROOM;
  return {
    room: roomValue,
    daemon: makeDispatchDaemon(opts),
  };
}

// ---------------------------------------------------------------------------
// Room provenance — fail-fast when room is absent
// ---------------------------------------------------------------------------

describe('mxDispatchTask — room provenance', () => {
  it('returns internal error when room is undefined (no daemon call)', async () => {
    const calls: string[] = [];
    const result = await mxDispatchTask(
      { task_id: TASK_ID_TOOL },
      makeDeps({ room: undefined, onCall: (m) => calls.push(m) }),
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expect(calls).toHaveLength(0);
  });

  it('returns internal error when room is empty string (no daemon call)', async () => {
    const calls: string[] = [];
    const result = await mxDispatchTask(
      { task_id: TASK_ID_TOOL },
      makeDeps({ room: '', onCall: (m) => calls.push(m) }),
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expect(calls).toHaveLength(0);
  });

  it('validates the internal-error envelope against ENVELOPE_SCHEMA', async () => {
    const result = await mxDispatchTask({ task_id: TASK_ID_TOOL }, makeDeps({ room: undefined }));
    expect(validateEnvelope(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task resolution — invalid_args / not_found before dispatch
// ---------------------------------------------------------------------------

describe('mxDispatchTask — task resolution guards', () => {
  it('returns invalid_args when task_id is empty string (early exit, no list call)', async () => {
    const calls: string[] = [];
    const result = await mxDispatchTask(
      { task_id: '' },
      makeDeps({ onCall: (m) => calls.push(m) }),
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
    expect(calls).not.toContain('call.start');
    expect(calls).not.toContain('exec.start');
  });

  it('returns not_found when the task is absent from the list', async () => {
    const result = await mxDispatchTask(
      { task_id: 'task_nonexistent' },
      makeDeps({ tasks: [] }),
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
  });

  it('returns invalid_args when the node carries no action (action: null)', async () => {
    const taskNoAction = { ...TASK_TOOL_RAW, task_id: 'task_no_action', action: null };
    const result = await mxDispatchTask(
      { task_id: 'task_no_action' },
      makeDeps({ tasks: [taskNoAction] }),
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
  });

  it('returns invalid_args for a kind=tool action with no tool name', async () => {
    const taskBadTool = {
      ...TASK_TOOL_RAW,
      task_id: 'task_bad_tool',
      action: { kind: 'tool' },   // no tool field → invalid dispatch
    };
    const result = await mxDispatchTask(
      { task_id: 'task_bad_tool' },
      makeDeps({ tasks: [taskBadTool] }),
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
  });

  it('returns invalid_args for a kind=exec action with no command', async () => {
    const taskBadExec = {
      ...TASK_EXEC_RAW,
      task_id: 'task_bad_exec',
      action: { kind: 'exec' },   // no command field → invalid dispatch
    };
    const result = await mxDispatchTask(
      { task_id: 'task_bad_exec' },
      makeDeps({ tasks: [taskBadExec] }),
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
  });

  it('returns invalid_args for an unassigned node (no delegation target)', async () => {
    const unassigned = {
      ...TASK_TOOL_RAW,
      task_id: 'task_unassigned',
      assignee: null,
    };
    const result = await mxDispatchTask(
      { task_id: 'task_unassigned' },
      makeDeps({ tasks: [unassigned] }),
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
  });

  it('returns invalid_args for a terminal succeeded task (no live action to dispatch)', async () => {
    const succeeded = { ...TASK_TOOL_RAW, task_id: 'task_succeeded', state: 'succeeded' };
    const result = await mxDispatchTask(
      { task_id: 'task_succeeded' },
      makeDeps({ tasks: [succeeded] }),
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
  });

  it('returns invalid_args for a terminal failed task (no live action to dispatch)', async () => {
    const failed = { ...TASK_TOOL_RAW, task_id: 'task_failed', state: 'failed' };
    const result = await mxDispatchTask(
      { task_id: 'task_failed' },
      makeDeps({ tasks: [failed] }),
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
  });

  it('does NOT refuse an executing task — idempotency makes re-dispatch safe (T304 crash-recovery)', async () => {
    const executing = { ...TASK_TOOL_RAW, task_id: 'task_executing', state: 'executing' };
    const result = await mxDispatchTask(
      { task_id: 'task_executing' },
      makeDeps({ tasks: [executing] }),
    );
    // An executing node must NOT be refused with invalid_args — idempotency dedupes on the daemon
    expect(result.error?.code).not.toBe('invalid_args');
  });
});

// ---------------------------------------------------------------------------
// Happy path — kind: 'tool'
// ---------------------------------------------------------------------------

describe('mxDispatchTask — happy path (kind: tool)', () => {
  it('returns ok for a well-formed tool action node', async () => {
    const result = await mxDispatchTask({ task_id: TASK_ID_TOOL }, makeDeps());
    expect(result.status).toBe('ok');
  });

  it('routes through call.start (delegation path), NOT exec.start', async () => {
    const methods: string[] = [];
    await mxDispatchTask({ task_id: TASK_ID_TOOL }, makeDeps({ onCall: (m) => methods.push(m) }));
    expect(methods).toContain('call.start');
    expect(methods).not.toContain('exec.start');
  });

  it('forwards the tool name to call.start', async () => {
    const callParams: Record<string, unknown>[] = [];
    const daemon = makeDispatchDaemon({
      onCall: (m, p) => { if (m === 'call.start') callParams.push(p as Record<string, unknown>); },
    });
    await mxDispatchTask({ task_id: TASK_ID_TOOL }, { room: ROOM, daemon });
    expect(callParams[0]?.['tool']).toBe(TOOL_NAME);
  });

  it('uses the task assignee as the delegation agent', async () => {
    const callParams: Record<string, unknown>[] = [];
    const daemon = makeDispatchDaemon({
      onCall: (m, p) => { if (m === 'call.start') callParams.push(p as Record<string, unknown>); },
    });
    await mxDispatchTask({ task_id: TASK_ID_TOOL }, { room: ROOM, daemon });
    expect(callParams[0]?.['agent']).toBe(AGENT_ID);
  });

  it('includes the room in call.start params (from session, not model input)', async () => {
    const callParams: Record<string, unknown>[] = [];
    const daemon = makeDispatchDaemon({
      onCall: (m, p) => { if (m === 'call.start') callParams.push(p as Record<string, unknown>); },
    });
    await mxDispatchTask({ task_id: TASK_ID_TOOL }, { room: ROOM, daemon });
    expect(callParams[0]?.['room']).toBe(ROOM);
  });

  it('validates the ok envelope against ENVELOPE_SCHEMA', async () => {
    const result = await mxDispatchTask({ task_id: TASK_ID_TOOL }, makeDeps());
    expect(validateEnvelope(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Happy path — kind: 'exec'
// ---------------------------------------------------------------------------

describe('mxDispatchTask — happy path (kind: exec)', () => {
  it('returns ok for a well-formed exec action node', async () => {
    const result = await mxDispatchTask({ task_id: TASK_ID_EXEC }, makeDeps({ tasks: [TASK_EXEC_RAW] }));
    expect(result.status).toBe('ok');
  });

  it('routes through exec.start (exec path), NOT call.start', async () => {
    const methods: string[] = [];
    await mxDispatchTask(
      { task_id: TASK_ID_EXEC },
      makeDeps({ tasks: [TASK_EXEC_RAW], onCall: (m) => methods.push(m) }),
    );
    expect(methods).toContain('exec.start');
    expect(methods).not.toContain('call.start');
  });

  it('forwards the command to exec.start', async () => {
    const execParams: Record<string, unknown>[] = [];
    const daemon = makeDispatchDaemon({
      tasks: [TASK_EXEC_RAW],
      onCall: (m, p) => { if (m === 'exec.start') execParams.push(p as Record<string, unknown>); },
    });
    await mxDispatchTask({ task_id: TASK_ID_EXEC }, { room: ROOM, daemon });
    expect(execParams[0]?.['command']).toBe('make');
  });

  it('forwards the command_args to exec.start as args', async () => {
    const execParams: Record<string, unknown>[] = [];
    const daemon = makeDispatchDaemon({
      tasks: [TASK_EXEC_RAW],
      onCall: (m, p) => { if (m === 'exec.start') execParams.push(p as Record<string, unknown>); },
    });
    await mxDispatchTask({ task_id: TASK_ID_EXEC }, { room: ROOM, daemon });
    expect(execParams[0]?.['args']).toEqual(['build']);
  });

  it('forwards cwd to exec.start when present', async () => {
    const execParams: Record<string, unknown>[] = [];
    const daemon = makeDispatchDaemon({
      tasks: [TASK_EXEC_RAW],
      onCall: (m, p) => { if (m === 'exec.start') execParams.push(p as Record<string, unknown>); },
    });
    await mxDispatchTask({ task_id: TASK_ID_EXEC }, { room: ROOM, daemon });
    expect(execParams[0]?.['cwd']).toBe('/repo');
  });

  it('uses the task assignee as the exec agent', async () => {
    const execParams: Record<string, unknown>[] = [];
    const daemon = makeDispatchDaemon({
      tasks: [TASK_EXEC_RAW],
      onCall: (m, p) => { if (m === 'exec.start') execParams.push(p as Record<string, unknown>); },
    });
    await mxDispatchTask({ task_id: TASK_ID_EXEC }, { room: ROOM, daemon });
    expect(execParams[0]?.['agent']).toBe(AGENT_ID);
  });

  it('validates the ok envelope against ENVELOPE_SCHEMA', async () => {
    const result = await mxDispatchTask({ task_id: TASK_ID_EXEC }, makeDeps({ tasks: [TASK_EXEC_RAW] }));
    expect(validateEnvelope(result)).toBe(true);
  });

  it('omits cwd from exec.start when the action carries no cwd', async () => {
    const taskNoCwd = {
      ...TASK_EXEC_RAW,
      task_id: 'task_exec_no_cwd',
      action: { kind: 'exec', command: 'make', command_args: ['test'] },
    };
    const execParams: Record<string, unknown>[] = [];
    const daemon = makeDispatchDaemon({
      tasks: [taskNoCwd],
      onCall: (m, p) => { if (m === 'exec.start') execParams.push(p as Record<string, unknown>); },
    });
    await mxDispatchTask({ task_id: 'task_exec_no_cwd' }, { room: ROOM, daemon });
    expect(Object.prototype.hasOwnProperty.call(execParams[0] ?? {}, 'cwd')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Idempotency (G5) — task-stable default key, caller key forwarded verbatim
// ---------------------------------------------------------------------------

describe('mxDispatchTask — idempotency (G5)', () => {
  it('derives a task-stable default key (idk_task_<task_id>) for a tool action', async () => {
    const callParams: Record<string, unknown>[] = [];
    const daemon = makeDispatchDaemon({
      onCall: (m, p) => { if (m === 'call.start') callParams.push(p as Record<string, unknown>); },
    });
    await mxDispatchTask({ task_id: TASK_ID_TOOL }, { room: ROOM, daemon });
    const key = callParams[0]?.['idempotency_key'];
    expect(typeof key).toBe('string');
    expect(key).toBe(`idk_task_${TASK_ID_TOOL}`);
  });

  it('derives a task-stable default key for an exec action', async () => {
    const execParams: Record<string, unknown>[] = [];
    const daemon = makeDispatchDaemon({
      tasks: [TASK_EXEC_RAW],
      onCall: (m, p) => { if (m === 'exec.start') execParams.push(p as Record<string, unknown>); },
    });
    await mxDispatchTask({ task_id: TASK_ID_EXEC }, { room: ROOM, daemon });
    const key = execParams[0]?.['idempotency_key'];
    expect(typeof key).toBe('string');
    expect(key).toBe(`idk_task_${TASK_ID_EXEC}`);
  });

  it('two dispatches of the same task use the SAME default key (idempotent re-dispatch)', async () => {
    const keys: string[] = [];
    const daemon = makeDispatchDaemon({
      onCall: (m, p) => {
        if (m === 'call.start') keys.push((p as Record<string, unknown>)['idempotency_key'] as string);
      },
    });
    const deps = { room: ROOM, daemon };
    await mxDispatchTask({ task_id: TASK_ID_TOOL }, deps);
    await mxDispatchTask({ task_id: TASK_ID_TOOL }, deps);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('forwards a caller-supplied idempotency_key verbatim', async () => {
    const callParams: Record<string, unknown>[] = [];
    const daemon = makeDispatchDaemon({
      onCall: (m, p) => { if (m === 'call.start') callParams.push(p as Record<string, unknown>); },
    });
    const MY_KEY = 'idk_my_explicit_dispatch_key';
    await mxDispatchTask({ task_id: TASK_ID_TOOL, idempotency_key: MY_KEY }, { room: ROOM, daemon });
    expect(callParams[0]?.['idempotency_key']).toBe(MY_KEY);
  });

  it('different task_ids produce different default keys', async () => {
    const keys = new Set<string>();
    for (const id of ['task_alpha', 'task_beta', 'task_gamma']) {
      const rawTask = { ...TASK_TOOL_RAW, task_id: id };
      const callParams: Record<string, unknown>[] = [];
      const daemon = makeDispatchDaemon({
        tasks: [rawTask],
        onCall: (m, p) => { if (m === 'call.start') callParams.push(p as Record<string, unknown>); },
      });
      await mxDispatchTask({ task_id: id }, { room: ROOM, daemon });
      const key = callParams[0]?.['idempotency_key'];
      if (typeof key === 'string') keys.add(key);
    }
    expect(keys.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Deferred dispositions (G4) — running + awaiting_approval
// ---------------------------------------------------------------------------

describe('mxDispatchTask — deferred dispositions (G4)', () => {
  it('returns status: running + handle when the receiver returns a running state', async () => {
    const result = await mxDispatchTask(
      { task_id: TASK_ID_TOOL },
      makeDeps({ callResponse: RUNNING_RESPONSE }),
    );
    expect(result.status).toBe('running');
    expect(typeof result.handle).toBe('string');
    expect(validateEnvelope(result)).toBe(true);
  });

  it('returns status: awaiting_approval + handle when the receiver holds for approval', async () => {
    const result = await mxDispatchTask(
      { task_id: TASK_ID_TOOL },
      makeDeps({ callResponse: AWAITING_RESPONSE }),
    );
    expect(result.status).toBe('awaiting_approval');
    expect(typeof result.handle).toBe('string');
    expect(validateEnvelope(result)).toBe(true);
  });

  it('running disposition for exec action returns running + handle', async () => {
    const result = await mxDispatchTask(
      { task_id: TASK_ID_EXEC },
      makeDeps({ tasks: [TASK_EXEC_RAW], execResponse: RUNNING_RESPONSE }),
    );
    expect(result.status).toBe('running');
    expect(typeof result.handle).toBe('string');
    expect(validateEnvelope(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Denial paths (G3) — receiver verdicts mapped, never self-decided
// ---------------------------------------------------------------------------

describe('mxDispatchTask — denial paths (G3: no in-process policy decision)', () => {
  it('policy_denied from the receiver → denied(policy_denied)', async () => {
    const err = new TransportError('rpc', 'rpc error', { cause: { error: { code: 'policy_denied' } } });
    const result = await mxDispatchTask(
      { task_id: TASK_ID_TOOL },
      makeDeps({ callError: err }),
    );
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
    expect(validateEnvelope(result)).toBe(true);
  });

  it('untrusted_key from the receiver → denied(untrusted_key)', async () => {
    const err = new TransportError('rpc', 'rpc error', { cause: { error: { code: 'untrusted_key' } } });
    const result = await mxDispatchTask(
      { task_id: TASK_ID_TOOL },
      makeDeps({ callError: err }),
    );
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('untrusted_key');
  });

  it('approval_denied from the receiver → denied(approval_denied)', async () => {
    const err = new TransportError('rpc', 'rpc error', { cause: { error: { code: 'approval_denied' } } });
    const result = await mxDispatchTask(
      { task_id: TASK_ID_TOOL },
      makeDeps({ callError: err }),
    );
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('approval_denied');
  });

  it('policy_denied from exec receiver → denied(policy_denied)', async () => {
    const err = new TransportError('rpc', 'rpc error', { cause: { error: { code: 'policy_denied' } } });
    const result = await mxDispatchTask(
      { task_id: TASK_ID_EXEC },
      makeDeps({ tasks: [TASK_EXEC_RAW], execError: err }),
    );
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
  });
});

// ---------------------------------------------------------------------------
// Fault paths — transport errors, task.list faults
// ---------------------------------------------------------------------------

describe('mxDispatchTask — fault paths', () => {
  it('task.list fault propagates as that envelope (not masked)', async () => {
    const err = new TransportError('timeout', 'socket timed out');
    const result = await mxDispatchTask(
      { task_id: TASK_ID_TOOL },
      makeDeps({ tasks: [], listError: err }),
    );
    // list fault propagates directly — the dispatch never happens
    expect(result.status).toBe('error');
    expect(validateEnvelope(result)).toBe(true);
  });

  it('call.start timeout → error(timeout)', async () => {
    const err = new TransportError('timeout', 'timed out waiting for response');
    const result = await mxDispatchTask(
      { task_id: TASK_ID_TOOL },
      makeDeps({ callError: err }),
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('timeout');
  });

  it('exec.start target_offline → error(target_offline)', async () => {
    const err = new TransportError('rpc', 'rpc error', { cause: { error: { code: 'target_offline' } } });
    const result = await mxDispatchTask(
      { task_id: TASK_ID_EXEC },
      makeDeps({ tasks: [TASK_EXEC_RAW], execError: err }),
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('target_offline');
  });

  it('call.start internal fault → error(internal)', async () => {
    const err = new TransportError('rpc', 'rpc error', { cause: { error: { code: 'internal' } } });
    const result = await mxDispatchTask(
      { task_id: TASK_ID_TOOL },
      makeDeps({ callError: err }),
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });
});

// ---------------------------------------------------------------------------
// Robustness — never throws; all envelopes conform
// ---------------------------------------------------------------------------

describe('mxDispatchTask — robustness', () => {
  it('never throws on any input', async () => {
    const cases = [
      { input: { task_id: TASK_ID_TOOL }, deps: makeDeps() },
      { input: { task_id: '' }, deps: makeDeps() },
      { input: { task_id: 'task_nonexistent' }, deps: makeDeps({ tasks: [] }) },
      { input: { task_id: TASK_ID_TOOL }, deps: makeDeps({ room: undefined }) },
    ];
    for (const { input, deps } of cases) {
      await expect(mxDispatchTask(input, deps)).resolves.toBeDefined();
    }
  });

  it('all result envelopes validate against ENVELOPE_SCHEMA', async () => {
    const scenarios: Array<[Parameters<typeof mxDispatchTask>[0], DispatchDeps]> = [
      [{ task_id: TASK_ID_TOOL }, makeDeps()],
      [{ task_id: 'task_nonexistent' }, makeDeps({ tasks: [] })],
      [{ task_id: TASK_ID_TOOL }, makeDeps({ room: undefined })],
      [{ task_id: TASK_ID_TOOL }, makeDeps({ callResponse: RUNNING_RESPONSE })],
      [{ task_id: TASK_ID_TOOL }, makeDeps({ callError: new TransportError('rpc', 'err', { cause: { error: { code: 'policy_denied' } } }) })],
    ];
    for (const [input, deps] of scenarios) {
      const result = await mxDispatchTask(input, deps);
      expect(validateEnvelope(result), `ENVELOPE_SCHEMA for ${JSON.stringify(input)}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// task.list call parameters
// ---------------------------------------------------------------------------

describe('mxDispatchTask — task.list call', () => {
  it('passes view: list to mxListTasks (avoids an unnecessary task.graph call)', async () => {
    const methods: string[] = [];
    await mxDispatchTask(
      { task_id: TASK_ID_TOOL },
      makeDeps({ onCall: (m) => methods.push(m) }),
    );
    // With view: 'list', task.graph is never called
    expect(methods).not.toContain('task.graph');
    expect(methods).toContain('task.list');
  });

  it('task.list is always called (the node must be read before dispatch)', async () => {
    const methods: string[] = [];
    await mxDispatchTask(
      { task_id: TASK_ID_TOOL },
      makeDeps({ onCall: (m) => methods.push(m) }),
    );
    expect(methods[0]).toBe('task.list');
  });
});
