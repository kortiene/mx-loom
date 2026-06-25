/**
 * `mxUpdateTask` handler unit tests (T301 / #30) — daemon-free.
 *
 * Tests pin:
 *  - Room provenance: missing / empty room → `internal` error, no daemon call.
 *  - Happy path: task.update reply → `ok(TaskNode, audit_ref)` with updated state.
 *  - task_id is required and forwarded via the TASK_ID_PARAM const.
 *  - State transition is the daemon's job — the handler forwards the requested state
 *    verbatim and surfaces the daemon's resulting mapped state.
 *  - assign, depends_on, blocks forwarded when provided.
 *  - Idempotency: key generated (idk_* prefix) when omitted; forwarded verbatim.
 *  - Daemon error signals: policy_denied/untrusted_key → denied; invalid_args/
 *    not_found → error; timeout → error.
 *  - Reply with explicit error body → failure classification.
 *  - error.message is secret-free.
 *  - All envelopes validate against ENVELOPE_SCHEMA.
 *  - Never throws on any input.
 */
import { describe, expect, it } from 'vitest';

import { TransportError } from '@mx-loom/toolbelt';

import {
  mxUpdateTask,
  validateEnvelope,
  type DaemonCall,
  type RoomScopedDeps,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOM = '!workspace:homeserver';

const UPDATED_TASK = {
  task_id: 'task_xyz',
  title: 'Run migration',
  state: 'executing',
  assignee: 'agent_runner',
  depends_on: [],
  blocks: [],
  action: null,
  audit_ref: {
    invocation_id: 'inv_upd_1',
    request_id: 'req_upd_1',
    room: ROOM,
    event_id: '$upd_evt_1',
  },
};

function makeDaemon(
  response: unknown = UPDATED_TASK,
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
// Room provenance
// ---------------------------------------------------------------------------

describe('mxUpdateTask — room provenance', () => {
  it('returns internal error when room is undefined', async () => {
    const calls: string[] = [];
    const result = await mxUpdateTask(
      { task_id: 'task_xyz' },
      makeDeps({ room: undefined, daemon: makeDaemon(UPDATED_TASK, (m) => calls.push(m)) }),
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expect(calls).toHaveLength(0);
  });

  it('returns internal error when room is empty string', async () => {
    const result = await mxUpdateTask({ task_id: 'task_xyz' }, makeDeps({ room: '' }));
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });

  it('forwards the session room to the daemon (never model input)', async () => {
    const params: Record<string, unknown>[] = [];
    await mxUpdateTask(
      { task_id: 'task_xyz' },
      makeDeps({ daemon: makeDaemon(UPDATED_TASK, (_, p) => params.push(p as Record<string, unknown>)) }),
    );
    expect(params[0]?.['room']).toBe(ROOM);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('mxUpdateTask — happy path', () => {
  it('returns ok(TaskNode, audit_ref) for a well-formed reply', async () => {
    const result = await mxUpdateTask({ task_id: 'task_xyz', state: 'executing' }, makeDeps());
    expect(result.status).toBe('ok');
    expect(result.audit_ref.invocation_id).toBe('inv_upd_1');
  });

  it('surfaces the daemon-returned mapped state (the daemon owns transition legality)', async () => {
    const result = await mxUpdateTask({ task_id: 'task_xyz', state: 'executing' }, makeDeps());
    const node = result.result as Record<string, unknown>;
    // The daemon returned 'executing'; mapTaskState maps it to 'executing'.
    expect(node.state).toBe('executing');
  });

  it('forwards task_id as the TASK_ID_PARAM (task_id)', async () => {
    const params: Record<string, unknown>[] = [];
    await mxUpdateTask(
      { task_id: 'task_my_id' },
      makeDeps({ daemon: makeDaemon(UPDATED_TASK, (_, p) => params.push(p as Record<string, unknown>)) }),
    );
    expect(params[0]?.['task_id']).toBe('task_my_id');
  });

  it('forwards state when provided', async () => {
    const params: Record<string, unknown>[] = [];
    await mxUpdateTask(
      { task_id: 'task_xyz', state: 'succeeded' },
      makeDeps({ daemon: makeDaemon(UPDATED_TASK, (_, p) => params.push(p as Record<string, unknown>)) }),
    );
    expect(params[0]?.['state']).toBe('succeeded');
  });

  it('omits state from daemon params when not provided (no undefined leak)', async () => {
    const params: Record<string, unknown>[] = [];
    await mxUpdateTask(
      { task_id: 'task_xyz' },
      makeDeps({ daemon: makeDaemon(UPDATED_TASK, (_, p) => params.push(p as Record<string, unknown>)) }),
    );
    expect(Object.prototype.hasOwnProperty.call(params[0], 'state')).toBe(false);
  });

  it('forwards assign to the daemon', async () => {
    const params: Record<string, unknown>[] = [];
    await mxUpdateTask(
      { task_id: 'task_xyz', assign: 'agent_new' },
      makeDeps({ daemon: makeDaemon(UPDATED_TASK, (_, p) => params.push(p as Record<string, unknown>)) }),
    );
    expect(params[0]?.['assign']).toBe('agent_new');
  });

  it('forwards depends_on and blocks when provided', async () => {
    const params: Record<string, unknown>[] = [];
    await mxUpdateTask(
      { task_id: 'task_xyz', depends_on: ['task_dep'], blocks: ['task_blk'] },
      makeDeps({ daemon: makeDaemon(UPDATED_TASK, (_, p) => params.push(p as Record<string, unknown>)) }),
    );
    expect(params[0]?.['depends_on']).toEqual(['task_dep']);
    expect(params[0]?.['blocks']).toEqual(['task_blk']);
  });

  it('populates audit_ref from the reply (create/update are signed mutations)', async () => {
    const result = await mxUpdateTask({ task_id: 'task_xyz' }, makeDeps());
    expect(result.audit_ref.request_id).toBe('req_upd_1');
    expect(result.audit_ref.event_id).toBe('$upd_evt_1');
  });

  it('validates the result envelope', async () => {
    const result = await mxUpdateTask({ task_id: 'task_xyz', state: 'succeeded' }, makeDeps());
    expect(validateEnvelope(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('mxUpdateTask — idempotency', () => {
  it('generates an idk_* key when omitted', async () => {
    const params: Record<string, unknown>[] = [];
    await mxUpdateTask(
      { task_id: 'task_xyz' },
      makeDeps({ daemon: makeDaemon(UPDATED_TASK, (_, p) => params.push(p as Record<string, unknown>)) }),
    );
    expect(params[0]?.['idempotency_key']).toMatch(/^idk_/);
  });

  it('forwards the caller-supplied idempotency_key verbatim', async () => {
    const params: Record<string, unknown>[] = [];
    const KEY = 'idk_explicit_update_key';
    await mxUpdateTask(
      { task_id: 'task_xyz', idempotency_key: KEY },
      makeDeps({ daemon: makeDaemon(UPDATED_TASK, (_, p) => params.push(p as Record<string, unknown>)) }),
    );
    expect(params[0]?.['idempotency_key']).toBe(KEY);
  });
});

// ---------------------------------------------------------------------------
// State transition — daemon's job (no client-side transition-legality check)
// ---------------------------------------------------------------------------

describe('mxUpdateTask — state transition is daemon-owned', () => {
  it('forwards any requested state value without a client-side legality check', async () => {
    const params: Record<string, unknown>[] = [];
    // Even an "illegal" transition is forwarded — the daemon decides.
    await mxUpdateTask(
      { task_id: 'task_xyz', state: 'proposed' }, // proposed → proposed is daemon's call
      makeDeps({ daemon: makeDaemon(UPDATED_TASK, (_, p) => params.push(p as Record<string, unknown>)) }),
    );
    expect(params[0]?.['state']).toBe('proposed');
  });

  it('daemon invalid_args (illegal transition) → error(invalid_args)', async () => {
    const err = new TransportError('rpc', 'rpc error', { cause: { error: { code: 'invalid_args' } } });
    const result = await mxUpdateTask({ task_id: 'task_xyz', state: 'proposed' }, makeDeps({ daemon: makeDaemon(err) }));
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
  });
});

// ---------------------------------------------------------------------------
// Daemon / transport error paths
// ---------------------------------------------------------------------------

describe('mxUpdateTask — daemon error paths', () => {
  it('daemon policy_denied → denied(policy_denied)', async () => {
    const err = new TransportError('rpc', 'rpc error', { cause: { error: { code: 'policy_denied' } } });
    const result = await mxUpdateTask({ task_id: 'task_xyz' }, makeDeps({ daemon: makeDaemon(err) }));
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
  });

  it('daemon untrusted_key → denied(untrusted_key)', async () => {
    const err = new TransportError('rpc', 'rpc error', { cause: { error: { code: 'untrusted_key' } } });
    const result = await mxUpdateTask({ task_id: 'task_xyz' }, makeDeps({ daemon: makeDaemon(err) }));
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('untrusted_key');
  });

  it('daemon not_found (unknown task_id) → error(not_found)', async () => {
    const err = new TransportError('rpc', 'rpc error', { cause: { error: { code: 'not_found' } } });
    const result = await mxUpdateTask({ task_id: 'task_nonexistent' }, makeDeps({ daemon: makeDaemon(err) }));
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
  });

  it('daemon timeout → error(timeout)', async () => {
    const err = new TransportError('timeout', 'socket timed out');
    const result = await mxUpdateTask({ task_id: 'task_xyz' }, makeDeps({ daemon: makeDaemon(err) }));
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('timeout');
  });

  it('daemon approval_denied → denied(approval_denied) (denial-set code)', async () => {
    const err = new TransportError('rpc', 'rpc error', { cause: { error: { code: 'approval_denied' } } });
    const result = await mxUpdateTask({ task_id: 'task_xyz', state: 'executing' }, makeDeps({ daemon: makeDaemon(err) }));
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('approval_denied');
  });

  it('daemon approval_expired → denied(approval_expired) (denial-set code)', async () => {
    const err = new TransportError('rpc', 'rpc error', { cause: { error: { code: 'approval_expired' } } });
    const result = await mxUpdateTask({ task_id: 'task_xyz', state: 'executing' }, makeDeps({ daemon: makeDaemon(err) }));
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('approval_expired');
  });

  it('daemon internal fault → error(internal)', async () => {
    const err = new TransportError('rpc', 'rpc error', { cause: { error: { code: 'internal' } } });
    const result = await mxUpdateTask({ task_id: 'task_xyz' }, makeDeps({ daemon: makeDaemon(err) }));
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });

  it('reply body with explicit error signal → failure classification', async () => {
    const reply = { ok: false, error: { code: 'not_found', message: 'task does not exist' } };
    const result = await mxUpdateTask({ task_id: 'task_gone' }, makeDeps({ daemon: makeDaemon(reply) }));
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
  });

  it('error.message is a fixed phrase, not a raw daemon payload', async () => {
    const err = new TransportError('rpc', 'SENSITIVE_DATA matrix_token', {
      cause: { error: { code: 'policy_denied', message: 'SENSITIVE_DATA matrix_token' } },
    });
    const result = await mxUpdateTask({ task_id: 'task_xyz' }, makeDeps({ daemon: makeDaemon(err) }));
    expect(result.error?.message).not.toContain('SENSITIVE_DATA');
    expect(result.error?.message).not.toContain('matrix_token');
  });

  it('validates all failure envelopes', async () => {
    const cases = [
      new TransportError('rpc', 'err', { cause: { error: { code: 'policy_denied' } } }),
      new TransportError('rpc', 'err', { cause: { error: { code: 'not_found' } } }),
      new TransportError('timeout', 'timed out'),
    ];
    for (const err of cases) {
      const result = await mxUpdateTask({ task_id: 'task_xyz' }, makeDeps({ daemon: makeDaemon(err) }));
      expect(validateEnvelope(result), `${err.code} should produce valid envelope`).toBe(true);
    }
  });

  it('never throws on any input', async () => {
    const inputs = [{ task_id: '' }, { task_id: 'x', state: undefined as unknown as 'proposed' }];
    for (const input of inputs) {
      await expect(mxUpdateTask(input as { task_id: string }, makeDeps())).resolves.toBeDefined();
    }
  });
});
