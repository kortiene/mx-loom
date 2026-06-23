/**
 * `mxCancel` handler — cancel an in-flight invocation (T108 / #16).
 *
 * Tests pin:
 * - AC 1: a successful cancel → ok({ handle, cancelled: true, state? }); audit_ref
 *   populated from the response (cancellation is a mutation / signed Matrix event).
 * - Cancelling an already-terminal invocation → ok({ handle, cancelled: false, state })
 *   (a successful no-op, not an error).
 * - Unknown handle → errored('not_found'), both thrown (faultToResult path) and
 *   resolved ({ ok:false } path via cancelResponseToResult) variants.
 * - Cross-agent cancel refused → denied('policy_denied') / denied('untrusted_key').
 * - Transport faults → errored('timeout'), errored('target_offline'), errored('internal').
 * - Malformed/empty reply → errored('internal'), never a misleading ok.
 * - Explicit cancelled:boolean daemon flag overrides state-based inference.
 * - audit_ref all-null on a pre-dispatch fault (faultToResult uses EMPTY_AUDIT_REF).
 * - invocation.cancel dispatched with { invocation_id: handle }.
 * - handler never throws; every output validates ENVELOPE_SCHEMA.
 *
 * Pure unit tests; injected DaemonCall — no daemon, no socket, no env.
 */
import { describe, expect, it } from 'vitest';

import { TransportError } from '@mx-loom/toolbelt';

import {
  mxCancel,
  validateEnvelope,
  type CancelInput,
  type DaemonCall,
  type HandlerDeps,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HANDLE = 'inv_c0001';
const VALID_INPUT: CancelInput = { handle: HANDLE };

/**
 * Build HandlerDeps with a fake daemon. `cancelResp` is returned (or thrown if it
 * is an Error instance) for every `invocation.cancel` call. All method names are
 * tracked in `calls` for dispatch-discipline assertions.
 */
function makeDeps(cancelResp: unknown): HandlerDeps & {
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  const daemon: DaemonCall = {
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === 'invocation.cancel') {
        if (cancelResp instanceof Error) throw cancelResp;
        return cancelResp;
      }
      throw new Error(`Unexpected daemon method: ${method}`);
    },
  };
  return { daemon, calls };
}

function te(code: string, message = 'error', cause?: unknown): TransportError {
  return new TransportError(code as 'rpc', message, cause !== undefined ? { cause } : undefined);
}

function rpcDaemonError(code: string): TransportError {
  return te('rpc', `rpc error: ${code}`, { error: { code } });
}

function expectValid(result: unknown): void {
  const isOk = validateEnvelope(result);
  expect(isOk, `envelope invalid: ${JSON.stringify((validateEnvelope as { errors?: unknown }).errors)}`).toBe(true);
}

// ---------------------------------------------------------------------------
// AC 1 — successful cancel: ok({ handle, cancelled: true, state? })
// ---------------------------------------------------------------------------

describe('mxCancel — AC 1: successful cancel', () => {
  it('daemon confirms cancellation with cancelled:true → ok(cancelled:true)', async () => {
    const d = makeDeps({ cancelled: true, state: 'cancelled', invocation_id: HANDLE });
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    const r = result.result as Record<string, unknown>;
    expect(r.handle).toBe(HANDLE);
    expect(r.cancelled).toBe(true);
    expect(r.state).toBe('cancelled');
    expect(result.error).toBeNull();
    expect(result.handle).toBeNull();
    expect(result.approval).toBeNull();
    expectValid(result);
  });

  it('"cancelled" state with no explicit cancelled flag → cancelled inferred true', async () => {
    const d = makeDeps({ state: 'cancelled' });
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    expect((result.result as Record<string, unknown>).cancelled).toBe(true);
    expectValid(result);
  });

  it('reply with only ok:true and no state → cancelled defaults to true', async () => {
    const d = makeDeps({ ok: true });
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    expect((result.result as Record<string, unknown>).cancelled).toBe(true);
    expectValid(result);
  });

  it('handle on success payload equals the input handle, not a daemon field', async () => {
    const MY_HANDLE = 'inv_specific_99';
    const d = makeDeps({ cancelled: true });
    const result = await mxCancel({ handle: MY_HANDLE }, d);
    expect((result.result as Record<string, unknown>).handle).toBe(MY_HANDLE);
  });

  it('state is included in ok payload when the daemon provides it', async () => {
    const d = makeDeps({ cancelled: true, state: 'cancelling' });
    const result = await mxCancel(VALID_INPUT, d);
    expect((result.result as Record<string, unknown>).state).toBe('cancelling');
    expectValid(result);
  });

  it('state is omitted from ok payload when the daemon does not provide one', async () => {
    const d = makeDeps({ cancelled: true });
    const result = await mxCancel(VALID_INPUT, d);
    expect('state' in (result.result as Record<string, unknown>)).toBe(false);
    expectValid(result);
  });

  it('"status" field used as state fallback when "state" field is absent', async () => {
    const d = makeDeps({ cancelled: true, status: 'cancelling' });
    const result = await mxCancel(VALID_INPUT, d);
    expect((result.result as Record<string, unknown>).state).toBe('cancelling');
    expectValid(result);
  });

  it('audit_ref populated from flat response fields (mutation → ids expected)', async () => {
    const d = makeDeps({
      cancelled: true,
      invocation_id: HANDLE,
      request_id: 'req_c1',
      room: '!room:home',
      event_id: '$evt_c1',
    });
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.audit_ref.invocation_id).toBe(HANDLE);
    expect(result.audit_ref.request_id).toBe('req_c1');
    expect(result.audit_ref.room).toBe('!room:home');
    expect(result.audit_ref.event_id).toBe('$evt_c1');
  });

  it('audit_ref ids are null when the daemon does not provide correlation ids', async () => {
    const d = makeDeps({ cancelled: true });
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.audit_ref.invocation_id).toBeNull();
    expect(result.audit_ref.request_id).toBeNull();
    expect(result.audit_ref.room).toBeNull();
    expect(result.audit_ref.event_id).toBeNull();
  });

  it('audit_ref extracted from nested audit_ref block', async () => {
    const d = makeDeps({
      cancelled: true,
      audit_ref: {
        invocation_id: 'inv_nested',
        request_id: 'req_nested',
        room: '!nested:home',
        event_id: '$evt_nested',
      },
    });
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.audit_ref.invocation_id).toBe('inv_nested');
    expect(result.audit_ref.request_id).toBe('req_nested');
    expect(result.audit_ref.room).toBe('!nested:home');
    expect(result.audit_ref.event_id).toBe('$evt_nested');
  });
});

// ---------------------------------------------------------------------------
// Invocation already terminal — cancelled:false (no-op success, not an error)
// ---------------------------------------------------------------------------

describe('mxCancel — nothing to cancel (already-terminal invocation)', () => {
  it('"already_complete" state → ok(cancelled:false)', async () => {
    const d = makeDeps({ state: 'already_complete' });
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    const r = result.result as Record<string, unknown>;
    expect(r.cancelled).toBe(false);
    expect(r.state).toBe('already_complete');
    expectValid(result);
  });

  it('explicit cancelled:false from daemon overrides state-based inference', async () => {
    const d = makeDeps({ cancelled: false, state: 'cancelled' });
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    expect((result.result as Record<string, unknown>).cancelled).toBe(false);
  });

  it('explicit cancelled:true overrides a "nothing to cancel" state', async () => {
    const d = makeDeps({ cancelled: true, state: 'already_complete' });
    const result = await mxCancel(VALID_INPUT, d);
    expect((result.result as Record<string, unknown>).cancelled).toBe(true);
  });

  const NOTHING_TO_CANCEL_STATES = [
    'already_complete', 'already_completed', 'already_done', 'already_finished',
    'complete', 'completed', 'succeeded', 'success', 'done', 'finished', 'resolved',
    'noop', 'no_op', 'nothing_to_cancel',
  ];

  for (const state of NOTHING_TO_CANCEL_STATES) {
    it(`"${state}" state (no explicit flag) → ok(cancelled:false)`, async () => {
      const d = makeDeps({ state });
      const result = await mxCancel(VALID_INPUT, d);
      expect(result.status).toBe('ok');
      expect((result.result as Record<string, unknown>).cancelled).toBe(false);
      expectValid(result);
    });
  }

  it('"already_complete" expressed via "status" field (not "state") → cancelled:false', async () => {
    // The handler reads state = obj.state ?? obj.status; the nothing-to-cancel
    // inference must work whichever field the daemon uses.
    const d = makeDeps({ status: 'already_complete' });
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    expect((result.result as Record<string, unknown>).cancelled).toBe(false);
    expectValid(result);
  });

  it('"done" expressed via "status" field → cancelled:false', async () => {
    const d = makeDeps({ status: 'done' });
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    expect((result.result as Record<string, unknown>).cancelled).toBe(false);
  });

  it('mixed-case "Already-Complete" state → normalised to already_complete → cancelled:false', async () => {
    // normaliseToken lowercases and collapses non-alphanumerics to '_'.
    const d = makeDeps({ state: 'Already-Complete' });
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    expect((result.result as Record<string, unknown>).cancelled).toBe(false);
  });

  it('upper-case "ALREADY_COMPLETE" state → normalised → cancelled:false', async () => {
    const d = makeDeps({ state: 'ALREADY_COMPLETE' });
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    expect((result.result as Record<string, unknown>).cancelled).toBe(false);
  });

  it('dot-separated "already.complete" → normalised to already_complete → cancelled:false', async () => {
    const d = makeDeps({ state: 'already.complete' });
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    expect((result.result as Record<string, unknown>).cancelled).toBe(false);
  });

  it('leading/trailing underscores in state token are trimmed before lookup', async () => {
    // "_already_complete_" → trimmed to "already_complete" → nothing-to-cancel.
    const d = makeDeps({ state: '_already_complete_' });
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    expect((result.result as Record<string, unknown>).cancelled).toBe(false);
  });

  it('"cancelling" state (active cancel, not terminal) → cancelled:true even without explicit flag', async () => {
    // "cancelling" is not in NOTHING_TO_CANCEL → defaults to active-cancel → true.
    const d = makeDeps({ state: 'cancelling' });
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    expect((result.result as Record<string, unknown>).cancelled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unknown handle — not_found
// ---------------------------------------------------------------------------

describe('mxCancel — unknown handle → not_found', () => {
  it('thrown rpc/not_found → errored("not_found")', async () => {
    const d = makeDeps(rpcDaemonError('not_found'));
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
    expectValid(result);
  });

  it('thrown rpc/no_such_invocation (alias) → errored("not_found")', async () => {
    const d = makeDeps(rpcDaemonError('no_such_invocation'));
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
    expectValid(result);
  });

  it('resolved { ok:false, error:{code:"not_found"} } → errored("not_found")', async () => {
    const d = makeDeps({ ok: false, error: { code: 'not_found' } });
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
    expectValid(result);
  });

  it('thrown fault: audit_ref is all-null (no Matrix round-trip completed)', async () => {
    const d = makeDeps(rpcDaemonError('not_found'));
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.audit_ref.invocation_id).toBeNull();
    expect(result.audit_ref.request_id).toBeNull();
    expect(result.audit_ref.room).toBeNull();
    expect(result.audit_ref.event_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Authority denied — cross-agent cancel refused
// ---------------------------------------------------------------------------

describe('mxCancel — authority denied paths', () => {
  it('thrown rpc/policy_denied → denied("policy_denied")', async () => {
    const d = makeDeps(rpcDaemonError('policy_denied'));
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
    expectValid(result);
  });

  it('resolved {ok:false, error:{code:"policy_denied"}} → denied("policy_denied")', async () => {
    const d = makeDeps({ ok: false, error: { code: 'policy_denied' } });
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
    expectValid(result);
  });

  it('thrown rpc/untrusted_key → denied("untrusted_key")', async () => {
    const d = makeDeps(rpcDaemonError('untrusted_key'));
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('untrusted_key');
    expectValid(result);
  });

  it('policy_denied error.message is the fixed phrase, never the handle', async () => {
    const d = makeDeps(rpcDaemonError('policy_denied'));
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.error?.message).toBe('denied by the receiver policy');
    expect(result.error?.message).not.toContain(HANDLE);
  });

  it('denied envelope: result, handle, approval are null', async () => {
    const d = makeDeps(rpcDaemonError('policy_denied'));
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.result).toBeNull();
    expect(result.handle).toBeNull();
    expect(result.approval).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Transport faults
// ---------------------------------------------------------------------------

describe('mxCancel — transport faults', () => {
  it('TransportError("timeout") → errored("timeout")', async () => {
    const d = makeDeps(te('timeout', 'socket timed out'));
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('timeout');
    expectValid(result);
  });

  it('rpc/target_offline → errored("target_offline")', async () => {
    const d = makeDeps(rpcDaemonError('target_offline'));
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('target_offline');
    expectValid(result);
  });

  it('TransportError("not_running") → errored("internal")', async () => {
    const d = makeDeps(te('not_running'));
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });

  it('plain Error (non-TransportError) → errored("internal")', async () => {
    const d = makeDeps(new Error('unexpected crash'));
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });

  it('timeout error.message is the fixed phrase, never the raw error details', async () => {
    const d = makeDeps(te('timeout', 'socket timed out after 30s on inv_c_secret'));
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.error?.message).toBe('the operation timed out');
    expect(result.error?.message).not.toContain('socket');
    expect(result.error?.message).not.toContain('inv_c_secret');
  });
});

// ---------------------------------------------------------------------------
// Malformed / empty reply — safe internal fallback
// ---------------------------------------------------------------------------

describe('mxCancel — malformed/empty reply → safe internal', () => {
  it('null reply → errored("internal") with "unrecognised cancel response"', async () => {
    const d = makeDeps(null);
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expect(result.error?.message).toBe('unrecognised cancel response');
    expectValid(result);
  });

  it('string reply → errored("internal")', async () => {
    const d = makeDeps('cancelled');
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });

  it('number reply → errored("internal")', async () => {
    const d = makeDeps(42);
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });

  it('array reply → errored("internal")', async () => {
    const d = makeDeps([]);
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('empty object reply → ok(cancelled:true) — no error signal, state absent → active cancel inferred', async () => {
    const d = makeDeps({});
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    expect((result.result as Record<string, unknown>).cancelled).toBe(true);
    expectValid(result);
  });
});

// ---------------------------------------------------------------------------
// Dispatch discipline — invocation.cancel called with correct params
// ---------------------------------------------------------------------------

describe('mxCancel — dispatch discipline', () => {
  it('dispatches exactly "invocation.cancel" once', async () => {
    const d = makeDeps({ cancelled: true });
    await mxCancel(VALID_INPUT, d);
    expect(d.calls.map((c) => c.method)).toEqual(['invocation.cancel']);
  });

  it('params contain invocation_id equal to the input handle', async () => {
    const d = makeDeps({ cancelled: true });
    await mxCancel(VALID_INPUT, d);
    const params = d.calls[0]?.params as Record<string, unknown>;
    expect(params?.invocation_id).toBe(HANDLE);
  });

  it('different handles produce different invocation_id params', async () => {
    const handle1 = 'inv_a1';
    const handle2 = 'inv_b2';
    const d1 = makeDeps({ cancelled: true });
    const d2 = makeDeps({ cancelled: true });
    await mxCancel({ handle: handle1 }, d1);
    await mxCancel({ handle: handle2 }, d2);
    const p1 = d1.calls[0]?.params as Record<string, unknown>;
    const p2 = d2.calls[0]?.params as Record<string, unknown>;
    expect(p1?.invocation_id).toBe(handle1);
    expect(p2?.invocation_id).toBe(handle2);
  });
});

// ---------------------------------------------------------------------------
// Robustness — never throws, every output validates ENVELOPE_SCHEMA
// ---------------------------------------------------------------------------

describe('mxCancel — robustness / never throws', () => {
  it('handler never throws on any response or transport fault', async () => {
    const responses: unknown[] = [
      null, undefined, '', 0, false, [], {},
      { cancelled: true },
      { state: 'already_complete' },
      rpcDaemonError('policy_denied'),
      te('timeout'),
      new Error('crash'),
    ];
    for (const resp of responses) {
      const actual = resp ?? null; // undefined → null so the daemon can return it
      const d = makeDeps(actual instanceof Error ? actual : actual);
      await expect(mxCancel(VALID_INPUT, d)).resolves.toBeDefined();
    }
  });

  it('all disposition paths produce ENVELOPE_SCHEMA-valid output', async () => {
    const scenarios: unknown[] = [
      { cancelled: true, state: 'cancelled', invocation_id: HANDLE },
      { state: 'already_complete' },
      { ok: false, error: { code: 'not_found' } },
      rpcDaemonError('policy_denied'),
      rpcDaemonError('untrusted_key'),
      te('timeout'),
      te('not_running'),
      null,
      [],
      {},
    ];
    for (const cancelResp of scenarios) {
      const d = makeDeps(cancelResp);
      const result = await mxCancel(VALID_INPUT, d);
      expectValid(result);
    }
  });

  it('every output has the four required envelope fields', async () => {
    const d = makeDeps({ cancelled: true });
    const result = await mxCancel(VALID_INPUT, d);
    expect('status' in result).toBe(true);
    expect('result' in result).toBe(true);
    expect('error' in result).toBe(true);
    expect('audit_ref' in result).toBe(true);
  });
});
