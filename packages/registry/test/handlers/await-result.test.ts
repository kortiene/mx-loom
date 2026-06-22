/**
 * `mxAwaitResult` resolver — AC 1, AC 2, and transport-fault mapping (T103 / #11).
 *
 * Tests pin:
 * - AC 1: A handle already terminal on probe 1 returns it immediately (no sleep).
 * - AC 1: A running handle that becomes terminal on probe k returns after k probes.
 * - AC 2: awaiting_approval flips to succeeded → ok; to denial → denied.
 * - AC 2: The resolver issues ONLY invocation.get calls — no approve/decide/mutate.
 * - Transport faults: every TransportErrorCode maps to the expected ToolResult code.
 * - rpc code with a daemon cause routes through mapDaemonError for specificity.
 * - The resolver never leaks a TransportError to the caller — always returns ToolResult.
 *
 * Pure unit tests; injected DaemonCall and clock — no daemon, no socket, no env.
 */
import { describe, expect, it } from 'vitest';

import { TransportError } from '@mx-loom/toolbelt';

import {
  mxAwaitResult,
  validateEnvelope,
  type DaemonCall,
  type HandlerDeps,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeDeps(
  responses: unknown[],
  opts?: { nowFn?: () => number; sleep?: (ms: number) => Promise<void>; pollIntervalMs?: number },
): HandlerDeps & { callCount: () => number; sleepCalls: number[] } {
  let idx = 0;
  let count = 0;
  const sleepCalls: number[] = [];

  const daemon: DaemonCall = {
    call: async () => {
      count++;
      const r = responses[Math.min(idx++, responses.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    },
  };

  return {
    daemon,
    sleep: opts?.sleep ?? (async (ms: number) => { sleepCalls.push(ms); }),
    now: opts?.nowFn ?? (() => 0),
    pollIntervalMs: opts?.pollIntervalMs ?? 50,
    callCount: () => count,
    sleepCalls,
  };
}

/** A `now()` that advances by `step` ms on every call, starting at 0. */
function steppingClock(step: number): () => number {
  let t = 0;
  return () => { t += step; return t; };
}

function expectValid(result: unknown): void {
  const ok = validateEnvelope(result);
  expect(ok, `envelope invalid: ${JSON.stringify((validateEnvelope as { errors?: unknown }).errors)}`).toBe(true);
}

// ---------------------------------------------------------------------------
// Response fixtures
// ---------------------------------------------------------------------------

const TERMINAL_OK = { state: 'completed', result: { value: 42 }, invocation_id: 'inv_ok' };
const TERMINAL_DENIED = { state: 'approval_denied', invocation_id: 'inv_dn' };
const TERMINAL_ERROR_NOT_FOUND = { state: 'not_found', invocation_id: 'inv_nf' };
const RUNNING = { state: 'running', handle: 'inv_run', invocation_id: 'inv_run' };
const AWAITING = {
  state: 'awaiting_approval',
  handle: 'inv_ap',
  invocation_id: 'inv_ap',
  approval: {
    request_id: 'req_ap',
    risk: 'medium',
    summary: 'Approve deployment',
    expires_at: '2026-06-22T12:00:00Z',
  },
};

// ---------------------------------------------------------------------------
// AC 1 — running handle resolves to a terminal envelope
// ---------------------------------------------------------------------------

describe('mxAwaitResult — AC 1: running handle resolves to terminal', () => {
  it('a handle already terminal on probe 1 returns it on exactly one probe (no sleep)', async () => {
    const d = makeDeps([TERMINAL_OK]);
    const result = await mxAwaitResult({ handle: 'inv_ok' }, d);
    expect(result.status).toBe('ok');
    expect(d.callCount()).toBe(1);
    expect(d.sleepCalls).toHaveLength(0);
    expectValid(result);
  });

  it('a handle already ok carries the correct result payload', async () => {
    const d = makeDeps([TERMINAL_OK]);
    const result = await mxAwaitResult({ handle: 'inv_ok' }, d);
    expect(result.result).toEqual({ value: 42 });
  });

  it('a handle already denied on probe 1 returns denied (one probe, no sleep)', async () => {
    const d = makeDeps([TERMINAL_DENIED]);
    const result = await mxAwaitResult({ handle: 'inv_dn' }, d);
    expect(result.status).toBe('denied');
    expect(d.callCount()).toBe(1);
    expect(d.sleepCalls).toHaveLength(0);
    expectValid(result);
  });

  it('a handle already errored on probe 1 returns error (one probe, no sleep)', async () => {
    const d = makeDeps([TERMINAL_ERROR_NOT_FOUND]);
    const result = await mxAwaitResult({ handle: 'inv_nf' }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
    expect(d.callCount()).toBe(1);
  });

  it('a running handle that becomes ok on probe 2 returns ok after exactly 2 probes', async () => {
    const d = makeDeps([RUNNING, TERMINAL_OK], { nowFn: steppingClock(10) });
    const result = await mxAwaitResult({ handle: 'inv_run', wait_ms: 2000 }, d);
    expect(result.status).toBe('ok');
    expect(d.callCount()).toBe(2);
    expect(d.sleepCalls).toHaveLength(1);
    expectValid(result);
  });

  it('a running handle that becomes ok on probe 3 returns ok after exactly 3 probes', async () => {
    const d = makeDeps([RUNNING, RUNNING, TERMINAL_OK], { nowFn: steppingClock(10) });
    const result = await mxAwaitResult({ handle: 'inv_run', wait_ms: 5000 }, d);
    expect(result.status).toBe('ok');
    expect(d.callCount()).toBe(3);
    expect(d.sleepCalls).toHaveLength(2);
  });

  it('resolved terminal envelope carries audit_ref from the daemon response', async () => {
    const terminal = {
      state: 'done',
      result: {},
      invocation_id: 'inv_x1',
      request_id: 'req_x1',
      room: '!room:x',
      event_id: '$evt_x1',
    };
    const d = makeDeps([terminal]);
    const result = await mxAwaitResult({ handle: 'inv_x1' }, d);
    expect(result.audit_ref.invocation_id).toBe('inv_x1');
    expect(result.audit_ref.request_id).toBe('req_x1');
    expect(result.audit_ref.room).toBe('!room:x');
    expect(result.audit_ref.event_id).toBe('$evt_x1');
  });
});

// ---------------------------------------------------------------------------
// AC 2 — awaiting_approval resolves to ok/denied after operator decision
// ---------------------------------------------------------------------------

describe('mxAwaitResult — AC 2: awaiting_approval resolves after operator decision', () => {
  it('awaiting_approval that flips to succeeded resolves to ok', async () => {
    const d = makeDeps([AWAITING, TERMINAL_OK], { nowFn: steppingClock(10) });
    const result = await mxAwaitResult({ handle: 'inv_ap', wait_ms: 5000 }, d);
    expect(result.status).toBe('ok');
    expectValid(result);
  });

  it('awaiting_approval that flips to approval_denied resolves to denied', async () => {
    const d = makeDeps([AWAITING, TERMINAL_DENIED], { nowFn: steppingClock(10) });
    const result = await mxAwaitResult({ handle: 'inv_ap', wait_ms: 5000 }, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('approval_denied');
    expectValid(result);
  });

  it('awaiting_approval that flips to policy_denied resolves to denied', async () => {
    const denied = { state: 'policy_denied', invocation_id: 'inv_pd' };
    const d = makeDeps([AWAITING, denied], { nowFn: steppingClock(10) });
    const result = await mxAwaitResult({ handle: 'inv_ap', wait_ms: 5000 }, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
  });

  it('awaiting_approval that flips to error resolves to error', async () => {
    const fault = { state: 'target_offline', invocation_id: 'inv_off' };
    const d = makeDeps([AWAITING, fault], { nowFn: steppingClock(10) });
    const result = await mxAwaitResult({ handle: 'inv_ap', wait_ms: 5000 }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('target_offline');
  });

  it('the resolver issues ONLY invocation.get calls — no approve/decide/mutate', async () => {
    const methods: string[] = [];
    const spy: DaemonCall = {
      call: async (method) => {
        methods.push(method);
        return AWAITING;
      },
    };
    await mxAwaitResult({ handle: 'inv_ap', wait_ms: 0 }, {
      daemon: spy,
      sleep: async () => {},
      now: () => 0,
    });
    expect(methods.length).toBeGreaterThan(0);
    for (const m of methods) {
      expect(m).toBe('invocation.get');
    }
  });

  it('awaiting_approval on probe 1 with wait_ms=0 returns awaiting_approval (no loop)', async () => {
    const d = makeDeps([AWAITING]);
    const result = await mxAwaitResult({ handle: 'inv_ap', wait_ms: 0 }, d);
    expect(result.status).toBe('awaiting_approval');
    expect(d.callCount()).toBe(1);
    expect(d.sleepCalls).toHaveLength(0);
  });

  it('awaiting_approval carries the approval block to the caller', async () => {
    const d = makeDeps([AWAITING]);
    const result = await mxAwaitResult({ handle: 'inv_ap', wait_ms: 0 }, d);
    expect(result.approval).not.toBeNull();
    expect(result.approval?.request_id).toBe('req_ap');
    expect(result.approval?.risk).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// Transport fault mapping
// ---------------------------------------------------------------------------

describe('mxAwaitResult — transport fault mapping', () => {
  function te(code: string, message = 'err', cause?: unknown): TransportError {
    return new TransportError(
      code as 'timeout',
      message,
      cause !== undefined ? { cause } : undefined,
    );
  }

  it('transport timeout → errored("timeout")', async () => {
    const result = await mxAwaitResult({ handle: 'inv_t1' }, makeDeps([te('timeout')]));
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('timeout');
    expectValid(result);
  });

  it('transport not_running → errored("internal")', async () => {
    const result = await mxAwaitResult({ handle: 'inv_t2' }, makeDeps([te('not_running')]));
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });

  it('transport connect_failed → errored("internal")', async () => {
    const result = await mxAwaitResult({ handle: 'inv_t3' }, makeDeps([te('connect_failed')]));
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });

  it('transport closed → errored("internal")', async () => {
    const result = await mxAwaitResult({ handle: 'inv_t4' }, makeDeps([te('closed')]));
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });

  it('transport frame → errored("internal")', async () => {
    const result = await mxAwaitResult({ handle: 'inv_t5' }, makeDeps([te('frame')]));
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });

  it('transport protocol → errored("internal")', async () => {
    const result = await mxAwaitResult({ handle: 'inv_t6' }, makeDeps([te('protocol')]));
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });

  it('transport invalid_args → errored("invalid_args")', async () => {
    const result = await mxAwaitResult({ handle: 'inv_t7' }, makeDeps([te('invalid_args')]));
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
  });

  it('transport rpc + not_found daemon cause → errored("not_found") via mapDaemonError', async () => {
    const cause = { error: { code: 'not_found' } };
    const result = await mxAwaitResult({ handle: 'inv_t8' }, makeDeps([te('rpc', 'rpc err', cause)]));
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
  });

  it('transport rpc + policy_denied daemon cause → denied("policy_denied") via mapDaemonError', async () => {
    const cause = { error: { code: 'policy_denied' } };
    const result = await mxAwaitResult({ handle: 'inv_t9' }, makeDeps([te('rpc', 'rpc err', cause)]));
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
  });

  it('transport rpc + untrusted_key cause → denied("untrusted_key")', async () => {
    const cause = { error: { code: 'untrusted_key' } };
    const result = await mxAwaitResult({ handle: 'inv_t10' }, makeDeps([te('rpc', 'rpc err', cause)]));
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('untrusted_key');
  });

  it('transport rpc + no cause → errored("internal") fallback', async () => {
    const result = await mxAwaitResult({ handle: 'inv_t11' }, makeDeps([te('rpc')]));
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });

  it('every TransportErrorCode produces a valid ToolResult (never throws)', async () => {
    const codes = ['timeout', 'not_running', 'connect_failed', 'closed', 'frame', 'protocol', 'rpc', 'invalid_args'];
    for (const code of codes) {
      const d = makeDeps([te(code)]);
      const result = await mxAwaitResult({ handle: 'inv_err' }, d);
      expect(result).toBeDefined();
      expectValid(result);
    }
  });

  it('a plain Error rejection (non-TransportError) → errored("internal")', async () => {
    const d = makeDeps([new Error('plain error')]);
    const result = await mxAwaitResult({ handle: 'inv_plain' }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });

  it('transport fault envelope carries the polled handle in audit_ref.invocation_id', async () => {
    const d = makeDeps([te('timeout')]);
    const result = await mxAwaitResult({ handle: 'inv_fault_handle' }, d);
    expect(result.audit_ref.invocation_id).toBe('inv_fault_handle');
  });

  it('transport fault produces error (fault-set code), never denial (denial-set code)', async () => {
    const denialCodes = new Set(['policy_denied', 'untrusted_key', 'approval_denied', 'approval_expired']);
    const localFaultCodes = ['timeout', 'not_running', 'connect_failed', 'closed', 'frame', 'protocol', 'invalid_args'];
    for (const code of localFaultCodes) {
      const d = makeDeps([te(code)]);
      const result = await mxAwaitResult({ handle: 'inv_deny' }, d);
      expect(result.status).toBe('error');
      expect(denialCodes.has(result.error?.code ?? '')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Probe parameter assertion — the resolver must call with { invocation_id: handle }
// ---------------------------------------------------------------------------

describe('mxAwaitResult — probe parameter name', () => {
  it('passes the handle as "invocation_id" param on the first probe', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const spy: DaemonCall = {
      call: async (method, params) => {
        calls.push({ method, params });
        return { state: 'completed', result: {} };
      },
    };
    await mxAwaitResult({ handle: 'inv_param_test' }, { daemon: spy, sleep: async () => {}, now: () => 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('invocation.get');
    expect(calls[0]!.params).toEqual({ invocation_id: 'inv_param_test' });
  });

  it('carries the handle as "invocation_id" on every probe in the poll loop', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    let probe = 0;
    const spy: DaemonCall = {
      call: async (method, params) => {
        calls.push({ method, params });
        probe++;
        return probe < 3
          ? { state: 'running', handle: 'inv_loop_h', invocation_id: 'inv_loop_h' }
          : { state: 'done', result: {} };
      },
    };
    let t = 0;
    await mxAwaitResult(
      { handle: 'inv_loop_h', wait_ms: 10_000 },
      { daemon: spy, sleep: async () => {}, now: () => (t += 10), pollIntervalMs: 50 },
    );
    expect(calls.length).toBe(3);
    for (const c of calls) {
      expect(c.method).toBe('invocation.get');
      expect(c.params).toEqual({ invocation_id: 'inv_loop_h' });
    }
  });

  it('handle is passed verbatim (no transformation)', async () => {
    const HANDLE = 'inv_Special-Handle_123';
    const calls: Array<unknown> = [];
    const spy: DaemonCall = {
      call: async (_method, params) => {
        calls.push(params);
        return { state: 'done', result: {} };
      },
    };
    await mxAwaitResult({ handle: HANDLE }, { daemon: spy, sleep: async () => {}, now: () => 0 });
    expect(calls[0]).toEqual({ invocation_id: HANDLE });
  });
});
