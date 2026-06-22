/**
 * `mxRunCommand` handler — guarded exec (T106 / #14): AC 1–3, the non-zero-exit
 * convention, deferred dispositions, idempotency, inline wait_ms, robustness, and
 * the params shape.
 *
 * Because the guard is **receiver-side**, the fake `exec.start` daemon *simulates*
 * each policy outcome (the handler itself performs no allowlist/regex/cwd check):
 *
 * - Phase 1: absent/empty room → internal, no daemon calls made.
 * - AC 1 (disabled by default → policy_denied): exec.start throws rpc/policy_denied
 *   AND a variant that resolves ExecResponse{ok:false, error:{code:policy_denied}}
 *   → both denied('policy_denied').
 * - AC 2 (allowlisted command runs → envelope): exec.start returns a synchronous
 *   ok with { exit_code, summary, log_ref } → status:ok, result passthrough,
 *   populated audit_ref.
 * - AC 3 (deny_args_regex match blocked): exec.start returns/throws policy_denied
 *   → denied('policy_denied'). Documented: indistinguishable from AC 1 at the unit
 *   layer (both are "daemon returned policy_denied"); the policy CONFIG that yields
 *   each is a two-daemon conformance concern, not a handler distinction.
 * - Non-zero exit is ok: { exit_code: 1 } → status:ok, result.exit_code === 1.
 * - Deferred: running → status:running, handle; awaiting_approval → approval block
 *   (fail-safe high risk default).
 * - Inline wait_ms: deferred + poll resolves terminal → terminal; expiry → pending
 *   (error:null, never errored timeout); terminal/wait_ms=0 → no composition.
 * - Idempotency: caller key forwarded verbatim; absent → generated idk_<uuid>;
 *   distinct per invocation; params include room/agent/command/args/idempotency_key.
 * - untrusted_key / target_offline mapping.
 * - Missing room never dispatches exec.start.
 * - args/cwd omission: args absent → []; cwd absent → omitted (no undefined leaks).
 * - Robustness: malformed ExecResponse → internal; handle-only → running; every
 *   output validates ENVELOPE_SCHEMA; handler never throws.
 *
 * Pure unit tests; injected DaemonCall — no daemon, no socket, no env.
 */
import { describe, expect, it } from 'vitest';

import { TransportError } from '@mx-loom/toolbelt';

import {
  invocationToResult,
  mxRunCommand,
  validateEnvelope,
  type DaemonCall,
  type ExecDeps,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const AGENT_ID = 'ag_target_01';
const COMMAND = 'pytest';
const ARGS = ['-q', 'tests/'];
const CWD = '/repo';
const ROOM = '!workspace:homeserver';

const SYNC_OK_RESPONSE = {
  ok: true,
  result: { exit_code: 0, summary: '12 passed', log_ref: 'ctx_log_01' },
  invocation_id: 'inv_ok_01',
  request_id: 'req_ok_01',
  room: ROOM,
  event_id: '$evt_ok_01',
};

const RUNNING_RESPONSE = {
  state: 'running',
  handle: 'inv_run_01',
  invocation_id: 'inv_run_01',
  request_id: 'req_run_01',
  room: ROOM,
  event_id: '$evt_run_01',
};

const AWAITING_RESPONSE = {
  state: 'awaiting_approval',
  handle: 'inv_ap_01',
  invocation_id: 'inv_ap_01',
  request_id: 'req_ap_01',
  room: ROOM,
  event_id: '$evt_ap_01',
  approval: {
    request_id: 'apr_01',
    risk: 'high',
    summary: 'Approve running pytest',
    expires_at: '2026-06-22T14:00:00Z',
  },
};

const noSleep = async (_ms: number): Promise<void> => {};
const nowZero = () => 0;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build an `ExecDeps` with per-method fake daemon responses. Tracks all calls for
 * spy assertions. Throws on any unexpected method call.
 */
function makeDeps(opts: {
  execResp?: unknown;
  /** Response for `invocation.get` (used when mxAwaitResult is composed). */
  invGetResp?: unknown;
  room?: string;
  sleep?: ExecDeps['sleep'];
  now?: ExecDeps['now'];
  pollIntervalMs?: number;
}): ExecDeps & {
  readonly calls: Array<{ method: string; params: unknown }>;
  callCount(method: string): number;
} {
  const calls: Array<{ method: string; params: unknown }> = [];

  const daemon: DaemonCall = {
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === 'exec.start') {
        const r = opts.execResp;
        if (r instanceof Error) throw r;
        if (r === undefined) throw new Error('Unexpected exec.start call (no execResp)');
        return r;
      }
      if (method === 'invocation.get') {
        const r = opts.invGetResp;
        if (r instanceof Error) throw r;
        if (r === undefined) throw new Error('Unexpected invocation.get (no invGetResp)');
        return r;
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  };

  const deps = {
    daemon,
    // Use 'in' check so an explicitly-passed `room: undefined` stays undefined
    // rather than falling back to the default ROOM constant.
    room: 'room' in opts ? opts.room : ROOM,
    sleep: opts.sleep ?? noSleep,
    now: opts.now ?? nowZero,
    pollIntervalMs: opts.pollIntervalMs ?? 50,
    calls,
    callCount: (method: string) => calls.filter((c) => c.method === method).length,
  };
  return deps;
}

function te(code: string, message = 'error', cause?: unknown): TransportError {
  return new TransportError(code as 'rpc', message, cause !== undefined ? { cause } : undefined);
}

function rpcDaemonError(code: string): TransportError {
  return te('rpc', `rpc error: ${code}`, { error: { code } });
}

function expectValid(result: unknown): void {
  const ok = validateEnvelope(result);
  expect(ok, `envelope invalid: ${JSON.stringify((validateEnvelope as { errors?: unknown }).errors)}`).toBe(true);
}

const VALID_INPUT = { agent: AGENT_ID, command: COMMAND, args: ARGS } as const;

// ---------------------------------------------------------------------------
// Phase 1 — room provenance
// ---------------------------------------------------------------------------

describe('mxRunCommand — Phase 1: room provenance', () => {
  it('absent room → internal, zero daemon calls', async () => {
    const d = makeDeps({ room: undefined });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expect(d.calls).toHaveLength(0);
    expectValid(result);
  });

  it('empty string room → internal, zero daemon calls', async () => {
    const d = makeDeps({ room: '' });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expect(d.calls).toHaveLength(0);
    expectValid(result);
  });

  it('absent room never dispatches exec.start', async () => {
    const d = makeDeps({ room: undefined });
    await mxRunCommand(VALID_INPUT, d);
    expect(d.callCount('exec.start')).toBe(0);
  });

  it('absent room: audit_ref is all-null (no round-trip)', async () => {
    const d = makeDeps({ room: undefined });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.audit_ref.invocation_id).toBeNull();
    expect(result.audit_ref.request_id).toBeNull();
    expect(result.audit_ref.room).toBeNull();
    expect(result.audit_ref.event_id).toBeNull();
  });

  it('room-provenance error.message is the fixed, secret-free phrase', async () => {
    const d = makeDeps({ room: undefined });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.error?.message).toBe('no workspace room configured for exec');
  });
});

// ---------------------------------------------------------------------------
// AC 1 — disabled by default → policy_denied
// ---------------------------------------------------------------------------

describe('mxRunCommand — AC 1: disabled by default → policy_denied', () => {
  it('exec.start rpc error policy_denied (no allow_commands entry) → denied("policy_denied")', async () => {
    const d = makeDeps({ execResp: rpcDaemonError('policy_denied') });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
    expectValid(result);
  });

  it('exec.start resolves ExecResponse{ok:false, error:{code:policy_denied}} → denied("policy_denied")', async () => {
    const d = makeDeps({ execResp: { ok: false, error: { code: 'policy_denied' } } });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
    expectValid(result);
  });

  it('exec.start state "policy_denied" → denied("policy_denied")', async () => {
    const d = makeDeps({ execResp: { state: 'policy_denied', invocation_id: 'inv_pd_01' } });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
  });

  it('policy_denied error.message is the fixed phrase, not the command or args', async () => {
    const d = makeDeps({ execResp: rpcDaemonError('policy_denied') });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.error?.message).toBe('denied by the receiver policy');
    expect(result.error?.message).not.toContain(COMMAND);
    expect(result.error?.message).not.toContain('tests/');
  });
});

// ---------------------------------------------------------------------------
// AC 2 — allowlisted command runs → envelope
// ---------------------------------------------------------------------------

describe('mxRunCommand — AC 2: allowlisted command runs → envelope', () => {
  it('synchronous ok response (exit_code 0) → status: ok', async () => {
    const d = makeDeps({ execResp: SYNC_OK_RESPONSE });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    expect(result.error).toBeNull();
    expect(result.handle).toBeNull();
    expect(result.approval).toBeNull();
    expectValid(result);
  });

  it('ok result carries the exec payload verbatim (exit_code, summary, log_ref)', async () => {
    const d = makeDeps({ execResp: SYNC_OK_RESPONSE });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.result).toEqual({ exit_code: 0, summary: '12 passed', log_ref: 'ctx_log_01' });
  });

  it('ok envelope carries populated audit_ref ids from the ExecResponse', async () => {
    const d = makeDeps({ execResp: SYNC_OK_RESPONSE });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.audit_ref.invocation_id).toBe('inv_ok_01');
    expect(result.audit_ref.request_id).toBe('req_ok_01');
    expect(result.audit_ref.room).toBe(ROOM);
    expect(result.audit_ref.event_id).toBe('$evt_ok_01');
  });

  it('state-token "completed" response → status: ok', async () => {
    const resp = { state: 'completed', result: { exit_code: 0 }, invocation_id: 'inv_comp_01' };
    const d = makeDeps({ execResp: resp });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    expect(result.result).toEqual({ exit_code: 0 });
  });

  it('bare result object (no ok flag, no state) → status: ok via success signal', async () => {
    const resp = { result: { exit_code: 0, summary: 'done' }, invocation_id: 'inv_bare_01' };
    const d = makeDeps({ execResp: resp });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    expect(result.result).toEqual({ exit_code: 0, summary: 'done' });
  });
});

// ---------------------------------------------------------------------------
// AC 3 — deny_args_regex match blocked
//
// NOTE: at the UNIT layer this is INDISTINGUISHABLE from AC 1 — both are "the
// daemon returned policy_denied". The handler cannot (and must not) tell apart an
// un-allowlisted command from a deny_args_regex match: the distinction lives in the
// receiver's policy.toml, exercised only by the staged two-daemon conformance
// fixture. These tests assert the handler maps policy_denied → denied uniformly.
// ---------------------------------------------------------------------------

describe('mxRunCommand — AC 3: deny_args_regex match blocked (→ policy_denied)', () => {
  it('args trip deny_args_regex → exec.start rpc policy_denied → denied("policy_denied")', async () => {
    const d = makeDeps({ execResp: rpcDaemonError('policy_denied') });
    const result = await mxRunCommand(
      { agent: AGENT_ID, command: 'rm', args: ['-rf', '/'] },
      d,
    );
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
    expectValid(result);
  });

  it('args trip deny_args_regex → ExecResponse{ok:false} policy_denied → denied', async () => {
    const d = makeDeps({ execResp: { ok: false, error: { code: 'policy_denied' } } });
    const result = await mxRunCommand(
      { agent: AGENT_ID, command: 'curl', args: ['http://evil'] },
      d,
    );
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
  });
});

// ---------------------------------------------------------------------------
// Non-zero exit is a SUCCESS (the governance/exit distinction)
// ---------------------------------------------------------------------------

describe('mxRunCommand — non-zero exit is status: ok', () => {
  it('exit_code 1 (tests failed) → status: ok, result.exit_code === 1', async () => {
    const resp = { ok: true, result: { exit_code: 1, summary: '3 failed' }, invocation_id: 'inv_nz_01' };
    const d = makeDeps({ execResp: resp });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    expect(result.error).toBeNull();
    expect((result.result as { exit_code: number }).exit_code).toBe(1);
    expectValid(result);
  });

  it('a large non-zero exit code via a "completed" state token is still ok', async () => {
    const resp = { state: 'completed', result: { exit_code: 137 }, invocation_id: 'inv_nz_02' };
    const d = makeDeps({ execResp: resp });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    expect((result.result as { exit_code: number }).exit_code).toBe(137);
  });
});

// ---------------------------------------------------------------------------
// Deferred dispositions
// ---------------------------------------------------------------------------

describe('mxRunCommand — deferred dispositions', () => {
  it('exec.start running response → status: running, handle set', async () => {
    const d = makeDeps({ execResp: RUNNING_RESPONSE });
    const result = await mxRunCommand({ ...VALID_INPUT, wait_ms: 0 }, d);
    expect(result.status).toBe('running');
    expect(result.handle).toBe('inv_run_01');
    expect(result.error).toBeNull();
    expect(result.result).toBeNull();
    expect(result.approval).toBeNull();
    expectValid(result);
  });

  it('running response carries populated audit_ref from the ExecResponse', async () => {
    const d = makeDeps({ execResp: RUNNING_RESPONSE });
    const result = await mxRunCommand({ ...VALID_INPUT, wait_ms: 0 }, d);
    expect(result.audit_ref.invocation_id).toBe('inv_run_01');
    expect(result.audit_ref.request_id).toBe('req_run_01');
    expect(result.audit_ref.room).toBe(ROOM);
    expect(result.audit_ref.event_id).toBe('$evt_run_01');
  });

  it('exec.start awaiting_approval response → status: awaiting_approval, approval set', async () => {
    const d = makeDeps({ execResp: AWAITING_RESPONSE });
    const result = await mxRunCommand({ ...VALID_INPUT, wait_ms: 0 }, d);
    expect(result.status).toBe('awaiting_approval');
    expect(result.handle).toBe('inv_ap_01');
    expect(result.approval).not.toBeNull();
    expect(result.approval?.request_id).toBe('apr_01');
    expect(result.approval?.risk).toBe('high');
    expect(result.approval?.summary).toBe('Approve running pytest');
    expect(result.error).toBeNull();
    expect(result.result).toBeNull();
    expectValid(result);
  });

  it('awaiting_approval without approval block gets fail-safe high risk defaults', async () => {
    const awaiting = { state: 'awaiting_approval', handle: 'inv_ap_02', invocation_id: 'inv_ap_02' };
    const d = makeDeps({ execResp: awaiting });
    const result = await mxRunCommand({ ...VALID_INPUT, wait_ms: 0 }, d);
    expect(result.status).toBe('awaiting_approval');
    expect(result.approval?.risk).toBe('high');
    expectValid(result);
  });

  it('disposition of running response agrees with invocationToResult for the same shape', () => {
    const normalized = invocationToResult(RUNNING_RESPONSE);
    expect(normalized.status).toBe('running');
    expect(normalized.handle).toBe('inv_run_01');
  });

  it('disposition of awaiting_approval response agrees with invocationToResult', () => {
    const normalized = invocationToResult(AWAITING_RESPONSE);
    expect(normalized.status).toBe('awaiting_approval');
    expect(normalized.approval?.request_id).toBe('apr_01');
  });
});

// ---------------------------------------------------------------------------
// untrusted_key / target_offline
// ---------------------------------------------------------------------------

describe('mxRunCommand — untrusted_key / target_offline', () => {
  it('exec.start rpc untrusted_key → denied("untrusted_key")', async () => {
    const d = makeDeps({ execResp: rpcDaemonError('untrusted_key') });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('untrusted_key');
    expectValid(result);
  });

  it('exec.start rpc agent_offline → errored("target_offline")', async () => {
    const d = makeDeps({ execResp: rpcDaemonError('agent_offline') });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('target_offline');
    expectValid(result);
  });

  it('exec.start transport timeout → errored("timeout")', async () => {
    const d = makeDeps({ execResp: te('timeout', 'socket timed out') });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('timeout');
    expectValid(result);
  });

  it('exec.start transport not_running → errored("internal")', async () => {
    const d = makeDeps({ execResp: te('not_running') });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });

  it('pre-dispatch fault audit_ref is all-null (no round-trip)', async () => {
    const d = makeDeps({ execResp: rpcDaemonError('policy_denied') });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.audit_ref.invocation_id).toBeNull();
    expect(result.audit_ref.request_id).toBeNull();
    expect(result.audit_ref.room).toBeNull();
    expect(result.audit_ref.event_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Idempotency (Phase 2)
// ---------------------------------------------------------------------------

describe('mxRunCommand — idempotency', () => {
  it('caller-supplied idempotency_key is forwarded verbatim in exec.start params', async () => {
    const MY_KEY = 'idk_my-own-key-12345';
    const d = makeDeps({ execResp: SYNC_OK_RESPONSE });
    await mxRunCommand({ ...VALID_INPUT, idempotency_key: MY_KEY }, d);
    const execStart = d.calls.find((c) => c.method === 'exec.start');
    expect((execStart?.params as Record<string, unknown>)?.idempotency_key).toBe(MY_KEY);
  });

  it('absent idempotency_key → a generated key starting with "idk_" is supplied', async () => {
    const d = makeDeps({ execResp: SYNC_OK_RESPONSE });
    await mxRunCommand(VALID_INPUT, d);
    const execStart = d.calls.find((c) => c.method === 'exec.start');
    const key = (execStart?.params as Record<string, unknown>)?.idempotency_key;
    expect(typeof key).toBe('string');
    expect((key as string).startsWith('idk_')).toBe(true);
  });

  it('exec.start params include room, agent, command, args, cwd, idempotency_key', async () => {
    const d = makeDeps({ execResp: SYNC_OK_RESPONSE });
    await mxRunCommand({ ...VALID_INPUT, cwd: CWD }, d);
    const execStart = d.calls.find((c) => c.method === 'exec.start');
    const p = execStart?.params as Record<string, unknown>;
    expect(p).toBeDefined();
    expect(p?.room).toBe(ROOM);
    expect(p?.agent).toBe(AGENT_ID);
    expect(p?.command).toBe(COMMAND);
    expect(p?.args).toEqual(ARGS);
    expect(p?.cwd).toBe(CWD);
    expect(typeof p?.idempotency_key).toBe('string');
  });

  it('two independent calls get distinct generated keys', async () => {
    const makeCall = async () => {
      const d = makeDeps({ execResp: SYNC_OK_RESPONSE });
      await mxRunCommand(VALID_INPUT, d);
      return (d.calls.find((c) => c.method === 'exec.start')?.params as Record<string, unknown>)
        ?.idempotency_key as string;
    };
    const key1 = await makeCall();
    const key2 = await makeCall();
    expect(key1).not.toBe(key2);
  });
});

// ---------------------------------------------------------------------------
// args / cwd omission — no undefined leaks into params
// ---------------------------------------------------------------------------

describe('mxRunCommand — args / cwd omission', () => {
  it('args absent → forwarded as [] in params', async () => {
    const d = makeDeps({ execResp: SYNC_OK_RESPONSE });
    await mxRunCommand({ agent: AGENT_ID, command: COMMAND }, d);
    const p = d.calls.find((c) => c.method === 'exec.start')?.params as Record<string, unknown>;
    expect(p.args).toEqual([]);
  });

  it('cwd absent → omitted from params (key not present, no undefined)', async () => {
    const d = makeDeps({ execResp: SYNC_OK_RESPONSE });
    await mxRunCommand({ agent: AGENT_ID, command: COMMAND }, d);
    const p = d.calls.find((c) => c.method === 'exec.start')?.params as Record<string, unknown>;
    expect('cwd' in p).toBe(false);
  });

  it('no params value is undefined', async () => {
    const d = makeDeps({ execResp: SYNC_OK_RESPONSE });
    await mxRunCommand({ agent: AGENT_ID, command: COMMAND }, d);
    const p = d.calls.find((c) => c.method === 'exec.start')?.params as Record<string, unknown>;
    for (const value of Object.values(p)) {
      expect(value).not.toBeUndefined();
    }
  });

  it('cwd present → forwarded verbatim', async () => {
    const d = makeDeps({ execResp: SYNC_OK_RESPONSE });
    await mxRunCommand({ agent: AGENT_ID, command: COMMAND, cwd: CWD }, d);
    const p = d.calls.find((c) => c.method === 'exec.start')?.params as Record<string, unknown>;
    expect(p.cwd).toBe(CWD);
  });
});

// ---------------------------------------------------------------------------
// Phase 4 — inline wait_ms
// ---------------------------------------------------------------------------

describe('mxRunCommand — Phase 4: inline wait_ms', () => {
  it('wait_ms=0 with deferred response → returns pending directly, no invocation.get', async () => {
    const d = makeDeps({ execResp: RUNNING_RESPONSE });
    const result = await mxRunCommand({ ...VALID_INPUT, wait_ms: 0 }, d);
    expect(result.status).toBe('running');
    expect(d.callCount('invocation.get')).toBe(0);
  });

  it('terminal response + wait_ms>0 → no mxAwaitResult composition (returns directly)', async () => {
    const d = makeDeps({ execResp: SYNC_OK_RESPONSE });
    const result = await mxRunCommand({ ...VALID_INPUT, wait_ms: 5000 }, d);
    expect(result.status).toBe('ok');
    expect(d.callCount('invocation.get')).toBe(0);
  });

  it('deferred response + wait_ms>0 + poll resolves terminal → returns terminal', async () => {
    let execStartDone = false;
    const daemon: DaemonCall = {
      call: async (method) => {
        if (method === 'exec.start') {
          execStartDone = true;
          return RUNNING_RESPONSE;
        }
        if (method === 'invocation.get' && execStartDone) {
          return { state: 'completed', result: { exit_code: 0 }, invocation_id: 'inv_run_01' };
        }
        throw new Error(`Unexpected: ${method}`);
      },
    };
    const result = await mxRunCommand(
      { ...VALID_INPUT, wait_ms: 5000 },
      { daemon, room: ROOM, sleep: noSleep, now: () => 0, pollIntervalMs: 50 },
    );
    expect(result.status).toBe('ok');
    expect(result.result).toEqual({ exit_code: 0 });
    expectValid(result);
  });

  it('deferred + wait_ms>0 budget expires → pending envelope, error:null (never errored timeout)', async () => {
    const daemon: DaemonCall = {
      call: async (method) => {
        if (method === 'exec.start') return RUNNING_RESPONSE;
        if (method === 'invocation.get') {
          return { state: 'running', handle: 'inv_run_01', invocation_id: 'inv_run_01' };
        }
        throw new Error(`Unexpected: ${method}`);
      },
    };
    let t = 0;
    const result = await mxRunCommand(
      { ...VALID_INPUT, wait_ms: 50 },
      { daemon, room: ROOM, sleep: noSleep, now: () => (t += 200), pollIntervalMs: 50 },
    );
    // T103 AC 3: wait_ms expiry → pending, error:null, NOT errored('timeout')
    expect(result.status).toBe('running');
    expect(result.error).toBeNull();
    expectValid(result);
  });

  it('awaiting_approval + wait_ms>0 budget expires → awaiting_approval returned, not error', async () => {
    const daemon: DaemonCall = {
      call: async (method) => {
        if (method === 'exec.start') return AWAITING_RESPONSE;
        if (method === 'invocation.get') {
          return {
            state: 'awaiting_approval',
            handle: 'inv_ap_01',
            invocation_id: 'inv_ap_01',
            approval: { request_id: 'apr_01', risk: 'high', summary: 'Approve', expires_at: '2026-06-22T14:00:00Z' },
          };
        }
        throw new Error(`Unexpected: ${method}`);
      },
    };
    let t = 0;
    const result = await mxRunCommand(
      { ...VALID_INPUT, wait_ms: 50 },
      { daemon, room: ROOM, sleep: noSleep, now: () => (t += 200), pollIntervalMs: 50 },
    );
    expect(result.status).toBe('awaiting_approval');
    expect(result.error).toBeNull();
    expectValid(result);
  });
});

// ---------------------------------------------------------------------------
// approval_denied / approval_expired / not_found — the remaining denial/fault
// terminal codes from the closed taxonomy.
//
// These arise when:
//   - approval_denied: operator rejects a held exec (exec.start rpc OR a resolved
//     response with state 'approval_denied' — the latter occurs when the daemon
//     learns of a rejection synchronously or the state surfaces in a poll already
//     composed by inline wait_ms).
//   - approval_expired: the approval request times out before an operator decision.
//   - not_found: exec.start targets an unknown agent (unknown_agent daemon alias).
//
// All three are in the closed ERROR_CODES denial- or fault-set and must round-trip
// through the handler cleanly. Delegate-tool tests (T105) cover them for call.start;
// these tests pin the same mapping for exec.start (T106).
// ---------------------------------------------------------------------------

describe('mxRunCommand — approval_denied / approval_expired / not_found paths', () => {
  it('exec.start rpc approval_denied → denied("approval_denied")', async () => {
    const d = makeDeps({ execResp: rpcDaemonError('approval_denied') });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('approval_denied');
    expectValid(result);
  });

  it('exec.start rpc approval_rejected (alias) → denied("approval_denied")', async () => {
    const d = makeDeps({ execResp: rpcDaemonError('approval_rejected') });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('approval_denied');
    expectValid(result);
  });

  it('exec.start rpc approval_expired → denied("approval_expired")', async () => {
    const d = makeDeps({ execResp: rpcDaemonError('approval_expired') });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('approval_expired');
    expectValid(result);
  });

  it('exec.start rpc approval_timeout (alias) → denied("approval_expired")', async () => {
    const d = makeDeps({ execResp: rpcDaemonError('approval_timeout') });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('approval_expired');
    expectValid(result);
  });

  it('exec.start resolved state "approval_denied" → denied("approval_denied")', async () => {
    const resp = { state: 'approval_denied', invocation_id: 'inv_ad_01', room: ROOM };
    const d = makeDeps({ execResp: resp });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('approval_denied');
    expectValid(result);
  });

  it('exec.start resolved state "approval_expired" → denied("approval_expired")', async () => {
    const resp = { state: 'approval_expired', invocation_id: 'inv_ae_01', room: ROOM };
    const d = makeDeps({ execResp: resp });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('approval_expired');
    expectValid(result);
  });

  it('exec.start rpc unknown_agent → errored("not_found")', async () => {
    const d = makeDeps({ execResp: rpcDaemonError('unknown_agent') });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
    expectValid(result);
  });

  it('exec.start rpc not_found → errored("not_found")', async () => {
    const d = makeDeps({ execResp: rpcDaemonError('not_found') });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
    expectValid(result);
  });

  it('exec.start resolved state "not_found" → errored("not_found")', async () => {
    const resp = { state: 'not_found', invocation_id: 'inv_nf_01' };
    const d = makeDeps({ execResp: resp });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
    expectValid(result);
  });
});

// ---------------------------------------------------------------------------
// audit_ref on resolved denial vs thrown error — the two paths diverge:
//   - Thrown error (faultToResult) → EMPTY_AUDIT_REF (all-null: no round-trip).
//   - Resolved ExecResponse{ok:false} → audit_ref extracted from the response
//     (exec.start IS a Matrix round-trip; correlation ids may be present).
//
// This distinction matters for auditability: an operator investigating a denial
// needs to know whether the correlation ids are available. The tests pin both cases.
// ---------------------------------------------------------------------------

describe('mxRunCommand — audit_ref on resolved vs thrown denial', () => {
  it('resolved policy_denied with audit_ref fields → audit_ref populated (not EMPTY)', async () => {
    const resp = {
      ok: false,
      error: { code: 'policy_denied' },
      invocation_id: 'inv_pd_audit_01',
      request_id: 'req_pd_audit_01',
      room: ROOM,
      event_id: '$evt_pd_audit_01',
    };
    const d = makeDeps({ execResp: resp });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
    expect(result.audit_ref.invocation_id).toBe('inv_pd_audit_01');
    expect(result.audit_ref.request_id).toBe('req_pd_audit_01');
    expect(result.audit_ref.room).toBe(ROOM);
    expect(result.audit_ref.event_id).toBe('$evt_pd_audit_01');
    expectValid(result);
  });

  it('thrown rpc policy_denied → audit_ref is all-null (no round-trip: EMPTY_AUDIT_REF)', async () => {
    const d = makeDeps({ execResp: rpcDaemonError('policy_denied') });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('denied');
    expect(result.audit_ref.invocation_id).toBeNull();
    expect(result.audit_ref.request_id).toBeNull();
    expect(result.audit_ref.room).toBeNull();
    expect(result.audit_ref.event_id).toBeNull();
  });

  it('resolved approval_denied with nested audit_ref block → audit_ref populated', async () => {
    const resp = {
      state: 'approval_denied',
      invocation_id: 'inv_ad_audit_01',
      audit_ref: {
        invocation_id: 'inv_ad_audit_01',
        request_id: 'req_ad_audit_01',
        room: ROOM,
        event_id: '$evt_ad_audit_01',
      },
    };
    const d = makeDeps({ execResp: resp });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('approval_denied');
    expect(result.audit_ref.invocation_id).toBe('inv_ad_audit_01');
    expect(result.audit_ref.request_id).toBe('req_ad_audit_01');
    expectValid(result);
  });
});

// ---------------------------------------------------------------------------
// State-token aliases — the INVOCATION_STATE_KIND table covers many spellings;
// pin the most relevant aliases for exec.start so a daemon spelling change
// degrades at this test, not silently in production.
// ---------------------------------------------------------------------------

describe('mxRunCommand — state-token alias coverage', () => {
  it('"denied_by_policy" state → denied("policy_denied")', async () => {
    const d = makeDeps({ execResp: { state: 'denied_by_policy', invocation_id: 'inv_dbp_01' } });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
    expectValid(result);
  });

  it('"rejected" state with no error code → errored("internal") safe fallback', async () => {
    // "rejected" is in INVOCATION_STATE_KIND (→ 'fail') but NOT in DAEMON_CODE_TO_ERROR,
    // so failureCode() falls back to 'internal' — a fault, not a denial.
    // Documents the intentional behavior: bare state tokens without a code object
    // that aren't in the daemon-code table degrade safely to 'internal'.
    const d = makeDeps({ execResp: { state: 'rejected', invocation_id: 'inv_rej_01' } });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('"approval_rejected" rpc error (alias) → denied("approval_denied")', async () => {
    // approval_rejected IS in DAEMON_CODE_TO_ERROR → 'approval_denied'; its
    // state-token alias in the state table is 'approval_rejected: fail'.
    const d = makeDeps({ execResp: rpcDaemonError('approval_rejected') });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('approval_denied');
    expectValid(result);
  });

  it('"executing" state (running alias) → running', async () => {
    const d = makeDeps({
      execResp: { state: 'executing', handle: 'inv_ex_01', invocation_id: 'inv_ex_01' },
    });
    const result = await mxRunCommand({ ...VALID_INPUT, wait_ms: 0 }, d);
    expect(result.status).toBe('running');
    expect(result.handle).toBe('inv_ex_01');
    expectValid(result);
  });

  it('"succeeded" state (ok alias) → ok', async () => {
    const d = makeDeps({
      execResp: { state: 'succeeded', result: { exit_code: 0 }, invocation_id: 'inv_succ_01' },
    });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    expect((result.result as { exit_code: number }).exit_code).toBe(0);
    expectValid(result);
  });

  it('"held" state (awaiting_approval alias) → awaiting_approval', async () => {
    const d = makeDeps({
      execResp: {
        state: 'held',
        handle: 'inv_held_01',
        invocation_id: 'inv_held_01',
        approval: { request_id: 'apr_held_01', risk: 'high', summary: 'Approve', expires_at: '2026-06-30T00:00:00Z' },
      },
    });
    const result = await mxRunCommand({ ...VALID_INPUT, wait_ms: 0 }, d);
    expect(result.status).toBe('awaiting_approval');
    expect(result.approval?.risk).toBe('high');
    expectValid(result);
  });
});

// ---------------------------------------------------------------------------
// Robustness — handler never throws, every output validates ENVELOPE_SCHEMA
// ---------------------------------------------------------------------------

describe('mxRunCommand — robustness / never-throws', () => {
  it('malformed ExecResponse (null) → internal, never throws', async () => {
    const d = makeDeps({ execResp: null });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('malformed ExecResponse (scalar 42) → internal', async () => {
    const d = makeDeps({ execResp: 42 });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('malformed ExecResponse (array) → internal', async () => {
    const d = makeDeps({ execResp: [] });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('malformed ExecResponse (empty object) → internal', async () => {
    const d = makeDeps({ execResp: {} });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('handle-only response (no state) → running', async () => {
    const d = makeDeps({ execResp: { handle: 'inv_h', invocation_id: 'inv_h' } });
    const result = await mxRunCommand({ ...VALID_INPUT, wait_ms: 0 }, d);
    expect(result.status).toBe('running');
    expect(result.handle).toBe('inv_h');
    expectValid(result);
  });

  it('plain Error from exec.start → internal', async () => {
    const d = makeDeps({ execResp: new Error('unexpected') });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });

  it('all error/disposition paths produce a valid ENVELOPE_SCHEMA output', async () => {
    type Scenario = { execResp?: unknown; room?: string };
    const scenarios: Scenario[] = [
      { execResp: null },
      { execResp: {} },
      { execResp: SYNC_OK_RESPONSE },
      { execResp: rpcDaemonError('policy_denied') },
      { execResp: { ok: false, error: { code: 'policy_denied' } } },
      { execResp: RUNNING_RESPONSE },
      { execResp: AWAITING_RESPONSE },
      { execResp: SYNC_OK_RESPONSE, room: '' },
    ];
    for (const { execResp, room } of scenarios) {
      const d = makeDeps({ execResp, room });
      const result = await mxRunCommand({ ...VALID_INPUT, wait_ms: 0 }, d);
      expectValid(result);
    }
  });
});
