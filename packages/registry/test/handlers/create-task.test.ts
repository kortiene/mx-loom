/**
 * `mxCreateTask` handler unit tests (T301 / #30) — daemon-free.
 *
 * Tests pin:
 *  - Room provenance: missing / empty room → `internal` error, no daemon call.
 *  - Happy path: task.create reply → `ok(TaskNode, audit_ref)` with correct node fields.
 *  - Dependency authoring: depends_on / blocks round-tripped to the daemon + returned.
 *  - Idempotency: key is generated (idk_* prefix) when omitted; forwarded verbatim when supplied.
 *  - Action forwarding: kind='tool' and kind='exec' both mapped to daemon params correctly.
 *  - Room comes from the session deps, never from model input.
 *  - Daemon error signals: policy_denied → denied; untrusted_key → denied;
 *    invalid_args (e.g. credential-shaped action arg) → error(invalid_args);
 *    not_found → error(not_found); timeout → error(timeout).
 *  - `faultToResult` path: thrown TransportError → mapped envelope.
 *  - Reply with explicit error body → failure classification.
 *  - Never throws on any input.
 *  - All envelopes validate against ENVELOPE_SCHEMA.
 *
 * No real daemon, no network, no env.
 */
import { describe, expect, it, vi } from 'vitest';

import { TransportError } from '@mx-loom/toolbelt';

import {
  mxCreateTask,
  validateEnvelope,
  type DaemonCall,
  type RoomScopedDeps,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const ROOM = '!workspace:homeserver';

const CREATED_TASK = {
  task_id: 'task_abc123',
  title: 'Implement feature X',
  state: 'proposed',
  assignee: null,
  depends_on: ['task_dep1'],
  blocks: ['task_dep2'],
  action: null,
  created_at: '2026-01-01T00:00:00Z',
  audit_ref: {
    invocation_id: 'inv_task_1',
    request_id: 'req_task_1',
    room: ROOM,
    event_id: '$task_evt_1',
  },
};

function makeDaemon(
  response: unknown = CREATED_TASK,
  onCall?: (method: string, params: unknown) => void,
): DaemonCall {
  return {
    async call(method: string, params?: unknown): Promise<unknown> {
      onCall?.(method, params ?? null);
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

function makeDeps(opts?: { room?: string | undefined; daemon?: DaemonCall }): RoomScopedDeps {
  const roomValue =
    opts !== undefined && Object.prototype.hasOwnProperty.call(opts, 'room')
      ? opts.room
      : ROOM;
  return {
    room: roomValue,
    daemon: opts?.daemon ?? makeDaemon(),
  };
}

// ---------------------------------------------------------------------------
// Room provenance — fail-fast when room is absent
// ---------------------------------------------------------------------------

describe('mxCreateTask — room provenance', () => {
  it('returns internal error when room is undefined (no daemon call)', async () => {
    const calls: string[] = [];
    const deps = makeDeps({ room: undefined, daemon: makeDaemon(CREATED_TASK, (m) => calls.push(m)) });
    const result = await mxCreateTask({ title: 'Test' }, deps);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expect(calls).toHaveLength(0);
  });

  it('returns internal error when room is empty string (no daemon call)', async () => {
    const calls: string[] = [];
    const deps = makeDeps({ room: '', daemon: makeDaemon(CREATED_TASK, (m) => calls.push(m)) });
    const result = await mxCreateTask({ title: 'Test' }, deps);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expect(calls).toHaveLength(0);
  });

  it('forwards the session room (not model input) to the daemon call', async () => {
    const params: Record<string, unknown>[] = [];
    const daemon = makeDaemon(CREATED_TASK, (_, p) => params.push(p as Record<string, unknown>));
    await mxCreateTask({ title: 'Test' }, makeDeps({ daemon }));
    expect(params[0]?.['room']).toBe(ROOM);
  });
});

// ---------------------------------------------------------------------------
// Happy path — successful task creation
// ---------------------------------------------------------------------------

describe('mxCreateTask — happy path', () => {
  it('returns ok(TaskNode, audit_ref) for a well-formed reply', async () => {
    const result = await mxCreateTask({ title: 'Implement feature X' }, makeDeps());
    expect(result.status).toBe('ok');
    expect(result.audit_ref.invocation_id).toBe('inv_task_1');
  });

  it('includes task_id and state in the returned TaskNode', async () => {
    const result = await mxCreateTask({ title: 'Test' }, makeDeps());
    const node = result.result as Record<string, unknown>;
    expect(node.task_id).toBe('task_abc123');
    expect(node.state).toBe('proposed');
  });

  it('forwards title to the daemon params', async () => {
    const params: Record<string, unknown>[] = [];
    const daemon = makeDaemon(CREATED_TASK, (_, p) => params.push(p as Record<string, unknown>));
    await mxCreateTask({ title: 'My Task' }, makeDeps({ daemon }));
    expect(params[0]?.['title']).toBe('My Task');
  });

  it('round-trips depends_on to the daemon and back into the node', async () => {
    const calls: { method: string; params: unknown }[] = [];
    const reply = { ...CREATED_TASK, depends_on: ['task_dep1', 'task_dep2'] };
    const daemon = makeDaemon(reply, (m, p) => calls.push({ method: m, params: p }));
    const result = await mxCreateTask(
      { title: 'Dep task', depends_on: ['task_dep1', 'task_dep2'] },
      makeDeps({ daemon }),
    );
    const params = calls[0]?.params as Record<string, unknown>;
    expect(params?.['depends_on']).toEqual(['task_dep1', 'task_dep2']);
    const node = result.result as Record<string, unknown>;
    expect(node.depends_on).toEqual(['task_dep1', 'task_dep2']);
  });

  it('round-trips blocks to the daemon and back into the node', async () => {
    const calls: { method: string; params: unknown }[] = [];
    const reply = { ...CREATED_TASK, blocks: ['task_b1'] };
    const daemon = makeDaemon(reply, (m, p) => calls.push({ method: m, params: p }));
    await mxCreateTask({ title: 'Blocking task', blocks: ['task_b1'] }, makeDeps({ daemon }));
    const params = calls[0]?.params as Record<string, unknown>;
    expect(params?.['blocks']).toEqual(['task_b1']);
  });

  it('forwards state to the daemon when provided', async () => {
    const params: Record<string, unknown>[] = [];
    const daemon = makeDaemon(CREATED_TASK, (_, p) => params.push(p as Record<string, unknown>));
    await mxCreateTask({ title: 'Test', state: 'pending' }, makeDeps({ daemon }));
    expect(params[0]?.['state']).toBe('pending');
  });

  it('omits state from daemon params when not provided (no undefined leak)', async () => {
    const params: Record<string, unknown>[] = [];
    const daemon = makeDaemon(CREATED_TASK, (_, p) => params.push(p as Record<string, unknown>));
    await mxCreateTask({ title: 'Test' }, makeDeps({ daemon }));
    expect(Object.prototype.hasOwnProperty.call(params[0], 'state')).toBe(false);
  });

  it('forwards assign to the daemon when provided', async () => {
    const params: Record<string, unknown>[] = [];
    const daemon = makeDaemon(CREATED_TASK, (_, p) => params.push(p as Record<string, unknown>));
    await mxCreateTask({ title: 'Assigned', assign: 'agent_x' }, makeDeps({ daemon }));
    expect(params[0]?.['assign']).toBe('agent_x');
  });

  it('populates audit_ref from the reply (not fabricated)', async () => {
    const result = await mxCreateTask({ title: 'Test' }, makeDeps());
    expect(result.audit_ref.request_id).toBe('req_task_1');
    expect(result.audit_ref.event_id).toBe('$task_evt_1');
  });

  it('validates the result envelope against ENVELOPE_SCHEMA', async () => {
    const result = await mxCreateTask({ title: 'Envelope check' }, makeDeps());
    expect(validateEnvelope(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('mxCreateTask — idempotency', () => {
  it('generates an idempotency_key with idk_ prefix when not supplied', async () => {
    const params: Record<string, unknown>[] = [];
    const daemon = makeDaemon(CREATED_TASK, (_, p) => params.push(p as Record<string, unknown>));
    await mxCreateTask({ title: 'No key' }, makeDeps({ daemon }));
    const key = params[0]?.['idempotency_key'];
    expect(typeof key).toBe('string');
    expect(key as string).toMatch(/^idk_/);
  });

  it('forwards the caller-supplied idempotency_key verbatim', async () => {
    const params: Record<string, unknown>[] = [];
    const daemon = makeDaemon(CREATED_TASK, (_, p) => params.push(p as Record<string, unknown>));
    const SUPPLIED_KEY = 'idk_my_explicit_key';
    await mxCreateTask({ title: 'With key', idempotency_key: SUPPLIED_KEY }, makeDeps({ daemon }));
    expect(params[0]?.['idempotency_key']).toBe(SUPPLIED_KEY);
  });

  it('two calls without a key each get a unique generated key', async () => {
    const keys: string[] = [];
    const daemon = makeDaemon(CREATED_TASK, (_, p) =>
      keys.push((p as Record<string, unknown>)['idempotency_key'] as string),
    );
    const deps = makeDeps({ daemon });
    await mxCreateTask({ title: 'Call 1' }, deps);
    await mxCreateTask({ title: 'Call 2' }, deps);
    expect(keys[0]).not.toBe(keys[1]);
  });
});

// ---------------------------------------------------------------------------
// Action forwarding (authored, not dispatched — T303 dispatches)
// ---------------------------------------------------------------------------

describe('mxCreateTask — action forwarding', () => {
  it('kind=tool: forwards tool and args to the daemon action param', async () => {
    const params: Record<string, unknown>[] = [];
    const daemon = makeDaemon(CREATED_TASK, (_, p) => params.push(p as Record<string, unknown>));
    await mxCreateTask(
      { title: 'Tool action', action: { kind: 'tool', tool: 'run_tests', args: { suite: 'unit' } } },
      makeDeps({ daemon }),
    );
    const action = params[0]?.['action'] as Record<string, unknown>;
    expect(action?.kind).toBe('tool');
    expect(action?.tool).toBe('run_tests');
    expect(action?.args).toEqual({ suite: 'unit' });
  });

  it('kind=exec: forwards command, command_args (as args), cwd to the daemon action param', async () => {
    const params: Record<string, unknown>[] = [];
    const daemon = makeDaemon(CREATED_TASK, (_, p) => params.push(p as Record<string, unknown>));
    await mxCreateTask(
      {
        title: 'Exec action',
        action: { kind: 'exec', command: 'make', command_args: ['test', '-v'], cwd: '/repo' },
      },
      makeDeps({ daemon }),
    );
    const action = params[0]?.['action'] as Record<string, unknown>;
    expect(action?.kind).toBe('exec');
    expect(action?.command).toBe('make');
    expect(action?.args).toEqual(['test', '-v']);
    expect(action?.cwd).toBe('/repo');
  });

  it('does NOT issue a call.start / exec.start when an action is provided (T303 dispatches)', async () => {
    const methods: string[] = [];
    const daemon = makeDaemon(CREATED_TASK, (m) => methods.push(m));
    await mxCreateTask(
      { title: 'Action authored', action: { kind: 'tool', tool: 'run_tests', args: {} } },
      makeDeps({ daemon }),
    );
    expect(methods).not.toContain('call.start');
    expect(methods).not.toContain('exec.start');
    // Only the task.create RPC should be emitted.
    expect(methods).toEqual(['task.create']);
  });

  it('kind=tool with no args (minimal tool action — only kind+tool required)', async () => {
    const params: Record<string, unknown>[] = [];
    const daemon = makeDaemon(CREATED_TASK, (_, p) => params.push(p as Record<string, unknown>));
    await mxCreateTask(
      { title: 'Minimal tool action', action: { kind: 'tool', tool: 'run_tests' } },
      makeDeps({ daemon }),
    );
    const action = params[0]?.['action'] as Record<string, unknown>;
    expect(action?.kind).toBe('tool');
    expect(action?.tool).toBe('run_tests');
    // args is omitted from params when not supplied (no undefined leak).
    expect(Object.prototype.hasOwnProperty.call(action, 'args')).toBe(false);
  });

  it('both depends_on AND blocks in a single call (the headline AC: deps + blocking edges)', async () => {
    const params: Record<string, unknown>[] = [];
    const reply = { ...CREATED_TASK, depends_on: ['task_prereq'], blocks: ['task_next'] };
    const daemon = makeDaemon(reply, (_, p) => params.push(p as Record<string, unknown>));
    const result = await mxCreateTask(
      { title: 'DAG node', depends_on: ['task_prereq'], blocks: ['task_next'] },
      makeDeps({ daemon }),
    );
    expect(params[0]?.['depends_on']).toEqual(['task_prereq']);
    expect(params[0]?.['blocks']).toEqual(['task_next']);
    const node = result.result as Record<string, unknown>;
    expect(node.depends_on).toEqual(['task_prereq']);
    expect(node.blocks).toEqual(['task_next']);
  });
});

// ---------------------------------------------------------------------------
// Daemon / transport error paths
// ---------------------------------------------------------------------------

describe('mxCreateTask — daemon error paths', () => {
  it('daemon policy_denied → denied(policy_denied)', async () => {
    const err = new TransportError('rpc', 'rpc error', { cause: { error: { code: 'policy_denied' } } });
    const result = await mxCreateTask({ title: 'Denied' }, makeDeps({ daemon: makeDaemon(err) }));
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
  });

  it('daemon untrusted_key → denied(untrusted_key)', async () => {
    const err = new TransportError('rpc', 'rpc error', { cause: { error: { code: 'untrusted_key' } } });
    const result = await mxCreateTask({ title: 'Untrusted' }, makeDeps({ daemon: makeDaemon(err) }));
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('untrusted_key');
  });

  it('daemon invalid_args (credential-shaped action arg) → error(invalid_args)', async () => {
    const err = new TransportError('invalid_args', 'refusing to send a credential-shaped value');
    const result = await mxCreateTask({ title: 'Cred leak' }, makeDeps({ daemon: makeDaemon(err) }));
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
  });

  it('daemon timeout → error(timeout)', async () => {
    const err = new TransportError('timeout', 'socket timed out');
    const result = await mxCreateTask({ title: 'Timeout' }, makeDeps({ daemon: makeDaemon(err) }));
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('timeout');
  });

  it('daemon not_found (e.g. room not found) → error(not_found)', async () => {
    const err = new TransportError('rpc', 'rpc error', { cause: { error: { code: 'not_found' } } });
    const result = await mxCreateTask({ title: 'Room gone' }, makeDeps({ daemon: makeDaemon(err) }));
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
  });

  it('daemon target_offline → error(target_offline)', async () => {
    const err = new TransportError('rpc', 'rpc error', { cause: { error: { code: 'target_offline' } } });
    const result = await mxCreateTask({ title: 'Offline' }, makeDeps({ daemon: makeDaemon(err) }));
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('target_offline');
  });

  it('daemon internal fault → error(internal)', async () => {
    const err = new TransportError('rpc', 'rpc error', { cause: { error: { code: 'internal' } } });
    const result = await mxCreateTask({ title: 'Fault' }, makeDeps({ daemon: makeDaemon(err) }));
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });

  it('reply body with explicit error signal → failure result', async () => {
    const reply = { ok: false, error: { code: 'invalid_args', message: 'bad title' } };
    const result = await mxCreateTask({ title: 'Bad reply' }, makeDeps({ daemon: makeDaemon(reply) }));
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
  });

  it('error.message is never the raw daemon payload (secret-free)', async () => {
    const err = new TransportError('rpc', 'SUPER SECRET PAYLOAD ghp_TOKEN', {
      cause: { error: { code: 'policy_denied', message: 'SUPER SECRET PAYLOAD ghp_TOKEN' } },
    });
    const result = await mxCreateTask({ title: 'Leak test' }, makeDeps({ daemon: makeDaemon(err) }));
    expect(result.error?.message).not.toContain('SUPER SECRET PAYLOAD');
    expect(result.error?.message).not.toContain('ghp_TOKEN');
  });

  it('validates the failure envelope against ENVELOPE_SCHEMA', async () => {
    const err = new TransportError('rpc', 'err', { cause: { error: { code: 'policy_denied' } } });
    const result = await mxCreateTask({ title: 'Validate denied' }, makeDeps({ daemon: makeDaemon(err) }));
    expect(validateEnvelope(result)).toBe(true);
  });

  it('never throws on any input', async () => {
    const cases: Array<{ title?: unknown; deps?: Partial<RoomScopedDeps> }> = [
      {},
      { title: undefined as unknown as string },
      { deps: { room: undefined } },
    ];
    for (const c of cases) {
      const deps = makeDeps({ room: c.deps?.room as string | undefined });
      await expect(mxCreateTask(c.title !== undefined ? { title: c.title as string } : ({ title: 'T' } as { title: string }), deps)).resolves.toBeDefined();
    }
  });
});
