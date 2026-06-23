/**
 * Invocation-state → result-envelope normalizer (T103 / #11).
 *
 * Tests pin:
 * - Every named daemon state maps to the correct T102 envelope status and helper.
 * - Every output validates against ENVELOPE_SCHEMA (conformance by construction).
 * - audit_ref is carried from the raw response; missing ids render null, never fabricated.
 * - error.message is always a fixed secret-free phrase — no raw daemon payload echoed.
 * - Unrecognised/malformed input degrades to errored('internal', …) — never throws.
 * - approval block is populated secret-free for held invocations.
 * - classifyInvocation is always consistent with invocationToResult(raw).status.
 *
 * Pure unit tests; no daemon, no socket, no env.
 */
import { describe, expect, it } from 'vitest';

import {
  classifyInvocation,
  invocationToResult,
  validateEnvelope,
  type InvocationDisposition,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectValid(result: unknown): void {
  const ok = validateEnvelope(result);
  expect(ok, `envelope invalid: ${JSON.stringify((validateEnvelope as { errors?: unknown }).errors)}`).toBe(true);
}

function withState(state: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return { state, ...extra };
}

// ---------------------------------------------------------------------------
// Running states
// ---------------------------------------------------------------------------

const RUNNING_STATES = [
  'running', 'in_flight', 'inflight', 'executing', 'active',
  'pending', 'queued', 'started', 'dispatched',
];

describe('invocationToResult — running states', () => {
  for (const state of RUNNING_STATES) {
    it(`state "${state}" maps to running envelope`, () => {
      const result = invocationToResult(withState(state, { handle: 'inv_r1' }));
      expect(result.status).toBe('running');
      expect(result.handle).toBe('inv_r1');
      expect(result.error).toBeNull();
      expect(result.result).toBeNull();
      expect(result.approval).toBeNull();
      expectValid(result);
    });
  }

  it('classifyInvocation returns "running" for running state', () => {
    expect(classifyInvocation(withState('running'))).toBe('running');
  });

  it('running envelope carries audit_ref from flat fields', () => {
    const raw = {
      state: 'running',
      handle: 'inv_r2',
      invocation_id: 'inv_r2',
      request_id: 'req_r2',
      room: '!room:srv',
      event_id: '$evt_r2',
    };
    const result = invocationToResult(raw);
    expect(result.audit_ref.invocation_id).toBe('inv_r2');
    expect(result.audit_ref.request_id).toBe('req_r2');
    expect(result.audit_ref.room).toBe('!room:srv');
    expect(result.audit_ref.event_id).toBe('$evt_r2');
  });

  it('handle falls back to invocation_id when no explicit handle field', () => {
    const raw = { state: 'running', invocation_id: 'inv_r3' };
    const result = invocationToResult(raw);
    expect(result.handle).toBe('inv_r3');
  });
});

// ---------------------------------------------------------------------------
// Awaiting-approval (held) states
// ---------------------------------------------------------------------------

const AWAITING_STATES = [
  'awaiting_approval', 'awaiting', 'held', 'approval_pending',
  'pending_approval', 'needs_approval',
];

describe('invocationToResult — awaiting_approval states', () => {
  for (const state of AWAITING_STATES) {
    it(`state "${state}" maps to awaiting_approval envelope`, () => {
      const result = invocationToResult(withState(state, { handle: 'inv_ap1' }));
      expect(result.status).toBe('awaiting_approval');
      expect(result.handle).toBe('inv_ap1');
      expect(result.error).toBeNull();
      expect(result.result).toBeNull();
      expect(result.approval).not.toBeNull();
      expectValid(result);
    });
  }

  it('classifyInvocation returns "awaiting_approval" for held state', () => {
    expect(classifyInvocation(withState('held'))).toBe('awaiting_approval');
  });

  it('approval block is populated from nested approval object', () => {
    const raw = {
      state: 'awaiting_approval',
      handle: 'inv_ap2',
      approval: {
        request_id: 'req_ap2',
        risk: 'medium',
        summary: 'Deploy to staging',
        expires_at: '2026-06-22T14:00:00Z',
      },
    };
    const result = invocationToResult(raw);
    expect(result.approval?.request_id).toBe('req_ap2');
    expect(result.approval?.risk).toBe('medium');
    expect(result.approval?.summary).toBe('Deploy to staging');
    expect(result.approval?.expires_at).toBe('2026-06-22T14:00:00Z');
  });

  it('approval block falls back to flat fields when no nested approval object', () => {
    const raw = {
      state: 'held',
      handle: 'inv_ap3',
      request_id: 'req_ap3',
      risk: 'low',
      summary: 'Run test',
      expires_at: '2026-06-22T15:00:00Z',
    };
    const result = invocationToResult(raw);
    expect(result.approval?.request_id).toBe('req_ap3');
    expect(result.approval?.risk).toBe('low');
    expect(result.approval?.summary).toBe('Run test');
  });

  it('absent approval fields get safe defaults (empty strings, fail-safe high risk)', () => {
    const raw = { state: 'awaiting_approval', handle: 'inv_ap4' };
    const result = invocationToResult(raw);
    expect(result.approval?.risk).toBe('high');
    expect(result.approval?.request_id).toBe('');
    expect(result.approval?.summary).toBe('');
    expect(result.approval?.expires_at).toBe('');
    expectValid(result);
  });

  it('unknown approval risk defaults to "high" (fail-safe — never under-stated)', () => {
    const raw = { state: 'awaiting_approval', handle: 'h', approval: { risk: 'critical' } };
    expect(invocationToResult(raw).approval?.risk).toBe('high');
  });

  it('known risk values low/medium/high are preserved as-is', () => {
    for (const risk of ['low', 'medium', 'high'] as const) {
      const raw = { state: 'awaiting_approval', handle: 'h', approval: { risk } };
      expect(invocationToResult(raw).approval?.risk).toBe(risk);
    }
  });

  it('approval block exposes only the four documented fields (no raw daemon extras)', () => {
    const raw = {
      state: 'awaiting_approval',
      handle: 'inv_ap5',
      approval: {
        request_id: 'req_ap5',
        risk: 'low',
        summary: 'Approve action',
        expires_at: '2026-06-22T14:00:00Z',
        secret_token: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
    };
    const result = invocationToResult(raw);
    const keys = Object.keys(result.approval ?? {});
    expect(keys.sort()).toEqual(['expires_at', 'request_id', 'risk', 'summary']);
    expect(keys).not.toContain('secret_token');
  });
});

// ---------------------------------------------------------------------------
// Terminal success (ok) states
// ---------------------------------------------------------------------------

const OK_STATES = ['ok', 'completed', 'complete', 'succeeded', 'success', 'done', 'finished', 'resolved'];

describe('invocationToResult — ok states', () => {
  for (const state of OK_STATES) {
    it(`state "${state}" maps to ok envelope`, () => {
      const result = invocationToResult(withState(state, { result: { v: 1 } }));
      expect(result.status).toBe('ok');
      expect(result.error).toBeNull();
      expect(result.handle).toBeNull();
      expect(result.approval).toBeNull();
      expectValid(result);
    });
  }

  it('classifyInvocation returns "ok" for succeeded state', () => {
    expect(classifyInvocation(withState('succeeded'))).toBe('ok');
  });

  it('ok envelope carries the result payload', () => {
    const raw = { state: 'completed', result: { files: ['a.ts', 'b.ts'], count: 2 } };
    expect(invocationToResult(raw).result).toEqual({ files: ['a.ts', 'b.ts'], count: 2 });
  });

  it('absent result payload normalises to {} (not null)', () => {
    const result = invocationToResult({ state: 'ok' });
    expect(result.result).toEqual({});
    expectValid(result);
  });

  it('ok envelope carries audit_ref ids', () => {
    const raw = {
      state: 'done',
      result: {},
      invocation_id: 'inv_ok1',
      request_id: 'req_ok1',
      room: '!room:ok',
      event_id: '$evt_ok1',
    };
    const r = invocationToResult(raw);
    expect(r.audit_ref.invocation_id).toBe('inv_ok1');
    expect(r.audit_ref.request_id).toBe('req_ok1');
    expect(r.audit_ref.room).toBe('!room:ok');
    expect(r.audit_ref.event_id).toBe('$evt_ok1');
  });
});

// ---------------------------------------------------------------------------
// Terminal denial states — code ∈ denial-set → denied envelope
// ---------------------------------------------------------------------------

describe('invocationToResult — denied (governance denial) states', () => {
  it('state "policy_denied" → denied, code: policy_denied', () => {
    const r = invocationToResult(withState('policy_denied'));
    expect(r.status).toBe('denied');
    expect(r.error?.code).toBe('policy_denied');
    expectValid(r);
  });

  it('state "denied_by_policy" → denied, code: policy_denied', () => {
    const r = invocationToResult(withState('denied_by_policy'));
    expect(r.status).toBe('denied');
    expect(r.error?.code).toBe('policy_denied');
  });

  it('state "rejected" → error/internal (fail kind; "rejected" not in daemon code table → internal fallback)', () => {
    const r = invocationToResult(withState('rejected'));
    // 'rejected' is in INVOCATION_STATE_KIND as 'fail', but mapDaemonError('rejected')
    // returns 'internal' (not in the daemon code table), which is in the fault-set.
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('internal');
  });

  it('state "untrusted_key" → denied, code: untrusted_key', () => {
    const r = invocationToResult(withState('untrusted_key'));
    expect(r.status).toBe('denied');
    expect(r.error?.code).toBe('untrusted_key');
    expectValid(r);
  });

  it('state "untrusted" → denied, code: untrusted_key', () => {
    const r = invocationToResult(withState('untrusted'));
    expect(r.status).toBe('denied');
    expect(r.error?.code).toBe('untrusted_key');
  });

  it('state "approval_denied" → denied, code: approval_denied', () => {
    const r = invocationToResult(withState('approval_denied'));
    expect(r.status).toBe('denied');
    expect(r.error?.code).toBe('approval_denied');
    expectValid(r);
  });

  it('state "approval_rejected" → denied, code: approval_denied', () => {
    const r = invocationToResult(withState('approval_rejected'));
    expect(r.status).toBe('denied');
    expect(r.error?.code).toBe('approval_denied');
  });

  it('state "approval_expired" → denied, code: approval_expired', () => {
    const r = invocationToResult(withState('approval_expired'));
    expect(r.status).toBe('denied');
    expect(r.error?.code).toBe('approval_expired');
    expectValid(r);
  });

  it('state "approval_timeout" → denied, code: approval_expired', () => {
    const r = invocationToResult(withState('approval_timeout'));
    expect(r.status).toBe('denied');
    expect(r.error?.code).toBe('approval_expired');
  });

  it('denied envelope sets result, handle, approval to null', () => {
    const r = invocationToResult(withState('policy_denied'));
    expect(r.result).toBeNull();
    expect(r.handle).toBeNull();
    expect(r.approval).toBeNull();
  });

  it('explicit denial error object on the record raises specificity', () => {
    const raw = { state: 'failed', error: { code: 'policy_denied' } };
    const r = invocationToResult(raw);
    expect(r.status).toBe('denied');
    expect(r.error?.code).toBe('policy_denied');
  });
});

// ---------------------------------------------------------------------------
// Terminal fault states — code ∈ fault-set → error envelope
// ---------------------------------------------------------------------------

describe('invocationToResult — error (operational fault) states', () => {
  it('state "failed" → error, code: internal', () => {
    const r = invocationToResult(withState('failed'));
    expect(r.status).toBe('error');
    expectValid(r);
  });

  it('state "not_found" → error, code: not_found', () => {
    const r = invocationToResult(withState('not_found'));
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('not_found');
    expectValid(r);
  });

  it('state "timeout" → error, code: timeout', () => {
    const r = invocationToResult(withState('timeout'));
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('timeout');
  });

  it('state "timed_out" → error (fail kind; "timed_out" not in daemon table → internal fallback)', () => {
    const r = invocationToResult(withState('timed_out'));
    // 'timed_out' is in INVOCATION_STATE_KIND as 'fail'; mapDaemonError('timed_out')
    // returns 'internal' since only 'timeout' (without underscore) is in the daemon table.
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('internal');
  });

  it('state "target_offline" → error, code: target_offline', () => {
    const r = invocationToResult(withState('target_offline'));
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('target_offline');
    expectValid(r);
  });

  it('state "agent_offline" → error, code: target_offline', () => {
    const r = invocationToResult(withState('agent_offline'));
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('target_offline');
  });

  it('state "offline" → error, code: target_offline', () => {
    const r = invocationToResult(withState('offline'));
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('target_offline');
  });

  it('state "unreachable" → error, code: target_offline', () => {
    const r = invocationToResult(withState('unreachable'));
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('target_offline');
  });

  it('state "errored" → error envelope', () => {
    expect(invocationToResult(withState('errored')).status).toBe('error');
  });

  it('state "faulted" → error envelope', () => {
    expect(invocationToResult(withState('faulted')).status).toBe('error');
  });

  it('state "error" → error envelope', () => {
    expect(invocationToResult(withState('error')).status).toBe('error');
  });

  it('error envelope sets result, handle, approval to null', () => {
    const r = invocationToResult(withState('failed'));
    expect(r.result).toBeNull();
    expect(r.handle).toBeNull();
    expect(r.approval).toBeNull();
  });

  it('explicit fault error object on record raises specificity via mapDaemonError', () => {
    const raw = { state: 'failed', error: { code: 'not_found' } };
    const r = invocationToResult(raw);
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// Unrecognised / malformed input — safe internal fallback
// ---------------------------------------------------------------------------

describe('invocationToResult — unrecognised / malformed input', () => {
  it('null → errored internal, never throws', () => {
    expect(() => invocationToResult(null)).not.toThrow();
    const r = invocationToResult(null);
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('internal');
  });

  it('string → errored internal', () => {
    const r = invocationToResult('some_string');
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('internal');
  });

  it('array → errored internal', () => {
    const r = invocationToResult([]);
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('internal');
  });

  it('number → errored internal', () => {
    const r = invocationToResult(42);
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('internal');
  });

  it('boolean → errored internal', () => {
    const r = invocationToResult(false);
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('internal');
  });

  it('object with unrecognised state string → errored internal', () => {
    const r = invocationToResult({ state: 'TOTALLY_UNKNOWN_STATE_XYZ' });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('internal');
    expect(r.error?.message).toBe('unrecognised invocation state');
  });

  it('object with null state → errored internal', () => {
    const r = invocationToResult({ state: null });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('internal');
  });

  it('object with no state/status/phase, no error signal → errored internal', () => {
    const r = invocationToResult({ id: 'inv_001' });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('internal');
    expect(r.error?.message).toBe('unrecognised invocation state');
  });

  it('object with no state but ok:false error signal → error envelope', () => {
    const r = invocationToResult({ ok: false, error: { code: 'not_found' } });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('not_found');
  });

  it('object with ok:false and no code → error, internal fallback', () => {
    const r = invocationToResult({ ok: false });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('internal');
  });

  it('object with string error field and no state → uses error string as code', () => {
    const r = invocationToResult({ error: 'policy_denied' });
    expect(r.status).toBe('denied');
    expect(r.error?.code).toBe('policy_denied');
  });

  it('never throws on any input', () => {
    const inputs = [null, undefined, '', 0, false, {}, [], { state: null }, { status: 99 }, 'xyz'];
    for (const input of inputs) {
      expect(() => invocationToResult(input)).not.toThrow();
    }
  });

  it('all outputs from malformed input validate against ENVELOPE_SCHEMA', () => {
    const inputs = [null, undefined, '', 0, false, {}, [], 'unknown', { state: 'xyz' }, { ok: false }];
    for (const input of inputs) {
      expectValid(invocationToResult(input));
    }
  });
});

// ---------------------------------------------------------------------------
// error.message — fixed secret-free vocabulary, no raw daemon payload echoed
// ---------------------------------------------------------------------------

describe('invocationToResult — secret-free error messages', () => {
  // Note: 'internal' cannot be tested via `{ state: 'internal' }` because 'internal'
  // is not a recognised state token (it takes the unrecognised fallback path instead).
  // Use `{ state: 'failed' }` to reach the 'internal' code via a recognised state.
  const PHRASE: Record<string, string> = {
    not_found: 'no such invocation',
    policy_denied: 'denied by the receiver policy',
    untrusted_key: 'the signing key is not trusted by the receiver',
    approval_denied: 'the operator denied the approval request',
    approval_expired: 'the approval request expired before a decision',
    timeout: 'the operation timed out',
    target_offline: 'the target agent is offline',
  };

  for (const [code, phrase] of Object.entries(PHRASE)) {
    it(`error.message for code "${code}" is the fixed phrase`, () => {
      const r = invocationToResult({ state: code });
      expect(r.error?.message).toBe(phrase);
    });
  }

  it('error.message for code "internal" (via state "failed") is the fixed phrase', () => {
    // state: 'failed' → kind: 'fail' → mapDaemonError returns 'internal' → errored('internal', …)
    const r = invocationToResult({ state: 'failed' });
    expect(r.error?.code).toBe('internal');
    expect(r.error?.message).toBe('the invocation failed');
  });

  it('raw daemon payload in the response is not echoed into error.message', () => {
    const raw = { state: 'failed', rawPayload: 'syt_super_secret_token' };
    const r = invocationToResult(raw);
    expect(r.error?.message).not.toContain('syt_super_secret_token');
    expect(r.error?.message).not.toContain('rawPayload');
    expect(r.error?.message).toBe('the invocation failed');
  });

  it('unrecognised state message is the fixed fallback phrase', () => {
    const r = invocationToResult({ state: 'TOTALLY_UNKNOWN' });
    expect(r.error?.message).toBe('unrecognised invocation state');
  });
});

// ---------------------------------------------------------------------------
// audit_ref — extraction layout priority; missing ids → null
// ---------------------------------------------------------------------------

describe('invocationToResult — audit_ref extraction', () => {
  it('prefers nested audit_ref block over flat fields', () => {
    const raw = {
      state: 'ok',
      result: {},
      invocation_id: 'flat_id',
      audit_ref: {
        invocation_id: 'nested_id',
        request_id: 'req_n',
        room: '!room:n',
        event_id: '$evt_n',
      },
    };
    const r = invocationToResult(raw);
    expect(r.audit_ref.invocation_id).toBe('nested_id');
    expect(r.audit_ref.request_id).toBe('req_n');
  });

  it('falls back to flat fields when no nested audit_ref block', () => {
    const raw = {
      state: 'ok',
      result: {},
      invocation_id: 'flat_id',
      request_id: 'flat_req',
      room: '!room:flat',
      event_id: '$flat_evt',
    };
    const r = invocationToResult(raw);
    expect(r.audit_ref.invocation_id).toBe('flat_id');
    expect(r.audit_ref.request_id).toBe('flat_req');
    expect(r.audit_ref.room).toBe('!room:flat');
    expect(r.audit_ref.event_id).toBe('$flat_evt');
  });

  it('falls back to "id" field for invocation_id when invocation_id is absent', () => {
    const raw = { state: 'running', id: 'inv_id_fallback' };
    expect(invocationToResult(raw).audit_ref.invocation_id).toBe('inv_id_fallback');
  });

  it('missing ids render null, never fabricated', () => {
    const raw = { state: 'running', handle: 'inv_h1' };
    const r = invocationToResult(raw);
    expect(r.audit_ref.request_id).toBeNull();
    expect(r.audit_ref.room).toBeNull();
    expect(r.audit_ref.event_id).toBeNull();
  });

  it('audit_ref is always structurally present (object, not null)', () => {
    const r = invocationToResult(null);
    expect(r.audit_ref).toBeDefined();
    expect(typeof r.audit_ref).toBe('object');
    expect(r.audit_ref).not.toBeNull();
  });

  it('all four audit_ref fields are present on every output', () => {
    for (const input of [null, { state: 'running' }, { state: 'done', result: {} }]) {
      const r = invocationToResult(input);
      expect('invocation_id' in r.audit_ref).toBe(true);
      expect('request_id' in r.audit_ref).toBe(true);
      expect('room' in r.audit_ref).toBe(true);
      expect('event_id' in r.audit_ref).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Alternate state-field names: status and phase (stateToken priority)
// ---------------------------------------------------------------------------

describe('invocationToResult — alternate state-field names (status / phase)', () => {
  it('"status" field is used when "state" is absent', () => {
    const r = invocationToResult({ status: 'running', handle: 'inv_s1' });
    expect(r.status).toBe('running');
    expectValid(r);
  });

  it('"phase" field is used when "state" and "status" are absent', () => {
    const r = invocationToResult({ phase: 'running', handle: 'inv_p1' });
    expect(r.status).toBe('running');
    expectValid(r);
  });

  it('"state" takes precedence over "status"', () => {
    // state: 'running' wins over status: 'completed'
    const r = invocationToResult({ state: 'running', status: 'completed', handle: 'inv_prio' });
    expect(r.status).toBe('running');
  });

  it('"status" takes precedence over "phase"', () => {
    const r = invocationToResult({ status: 'succeeded', phase: 'running', result: {} });
    expect(r.status).toBe('ok');
  });

  it('"status" field maps awaiting_approval correctly', () => {
    const r = invocationToResult({ status: 'awaiting_approval', handle: 'inv_s2' });
    expect(r.status).toBe('awaiting_approval');
    expectValid(r);
  });

  it('"status" field maps ok correctly', () => {
    const r = invocationToResult({ status: 'done', result: { v: 1 } });
    expect(r.status).toBe('ok');
    expect(r.result).toEqual({ v: 1 });
    expectValid(r);
  });

  it('"status" field maps denied correctly', () => {
    const r = invocationToResult({ status: 'policy_denied' });
    expect(r.status).toBe('denied');
    expectValid(r);
  });

  it('"phase" field maps error correctly', () => {
    const r = invocationToResult({ phase: 'failed' });
    expect(r.status).toBe('error');
    expectValid(r);
  });
});

// ---------------------------------------------------------------------------
// State token normalization — case-insensitive, non-alphanumeric → underscore
// ---------------------------------------------------------------------------

describe('invocationToResult — state token normalization', () => {
  it('"RUNNING" (uppercase) normalizes to running', () => {
    const r = invocationToResult({ state: 'RUNNING', handle: 'inv_n1' });
    expect(r.status).toBe('running');
    expectValid(r);
  });

  it('"Running" (mixed case) normalizes to running', () => {
    const r = invocationToResult({ state: 'Running', handle: 'inv_n2' });
    expect(r.status).toBe('running');
  });

  it('"in-flight" (hyphen) normalizes to in_flight → running', () => {
    const r = invocationToResult({ state: 'in-flight', handle: 'inv_n3' });
    expect(r.status).toBe('running');
    expectValid(r);
  });

  it('"In-Flight" (mixed case + hyphen) normalizes to in_flight → running', () => {
    const r = invocationToResult({ state: 'In-Flight', handle: 'inv_n4' });
    expect(r.status).toBe('running');
  });

  it('"awaiting-approval" (hyphen) normalizes to awaiting_approval', () => {
    const r = invocationToResult({ state: 'awaiting-approval', handle: 'inv_n5' });
    expect(r.status).toBe('awaiting_approval');
    expectValid(r);
  });

  it('"AWAITING_APPROVAL" (uppercase) normalizes to awaiting_approval', () => {
    const r = invocationToResult({ state: 'AWAITING_APPROVAL', handle: 'inv_n6' });
    expect(r.status).toBe('awaiting_approval');
  });

  it('"POLICY_DENIED" (uppercase) normalizes to policy_denied → denied', () => {
    const r = invocationToResult({ state: 'POLICY_DENIED' });
    expect(r.status).toBe('denied');
    expect(r.error?.code).toBe('policy_denied');
    expectValid(r);
  });

  it('"target-offline" (hyphen) normalizes to target_offline → error', () => {
    const r = invocationToResult({ state: 'target-offline' });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('target_offline');
  });

  it('"  running  " (whitespace) normalizes to running', () => {
    const r = invocationToResult({ state: '  running  ', handle: 'inv_ws' });
    expect(r.status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// handleOf — field priority and fallback chain
// ---------------------------------------------------------------------------

describe('invocationToResult — handle field priority', () => {
  it('"handle" field takes priority over "invocation_id" when both are present', () => {
    const raw = { state: 'running', handle: 'handle_value', invocation_id: 'id_value' };
    const r = invocationToResult(raw);
    expect(r.handle).toBe('handle_value');
  });

  it('"invocation_id" is used when "handle" is absent', () => {
    const raw = { state: 'running', invocation_id: 'inv_id_only' };
    const r = invocationToResult(raw);
    expect(r.handle).toBe('inv_id_only');
  });

  it('"id" field is used when "handle" and "invocation_id" are absent', () => {
    const raw = { state: 'running', id: 'id_field_fallback' };
    const r = invocationToResult(raw);
    expect(r.handle).toBe('id_field_fallback');
  });

  it('handle is empty string when none of handle/invocation_id/id are present', () => {
    const raw = { state: 'running' };
    const r = invocationToResult(raw);
    expect(r.handle).toBe('');
    expectValid(r);
  });
});

// ---------------------------------------------------------------------------
// resultOf — normalization of non-object result values
// ---------------------------------------------------------------------------

describe('invocationToResult — result field normalization', () => {
  it('result: null normalizes to {} for ok envelope', () => {
    const r = invocationToResult({ state: 'done', result: null });
    expect(r.status).toBe('ok');
    expect(r.result).toEqual({});
    expectValid(r);
  });

  it('result: [] (array) normalizes to {} for ok envelope', () => {
    const r = invocationToResult({ state: 'succeeded', result: [] });
    expect(r.status).toBe('ok');
    expect(r.result).toEqual({});
    expectValid(r);
  });

  it('result: 42 (scalar) normalizes to {} for ok envelope', () => {
    const r = invocationToResult({ state: 'completed', result: 42 });
    expect(r.status).toBe('ok');
    expect(r.result).toEqual({});
    expectValid(r);
  });

  it('result: "string" normalizes to {} for ok envelope', () => {
    const r = invocationToResult({ state: 'ok', result: 'payload_string' });
    expect(r.status).toBe('ok');
    expect(r.result).toEqual({});
    expectValid(r);
  });

  it('a valid result object is preserved exactly', () => {
    const payload = { files: ['a.ts'], count: 1 };
    const r = invocationToResult({ state: 'done', result: payload });
    expect(r.result).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// classifyInvocation — always consistent with invocationToResult(raw).status
// ---------------------------------------------------------------------------

describe('classifyInvocation', () => {
  const CASES: [unknown, InvocationDisposition][] = [
    [{ state: 'running' }, 'running'],
    [{ state: 'executing' }, 'running'],
    [{ state: 'queued' }, 'running'],
    [{ state: 'awaiting_approval' }, 'awaiting_approval'],
    [{ state: 'held' }, 'awaiting_approval'],
    [{ state: 'needs_approval' }, 'awaiting_approval'],
    [{ state: 'completed', result: {} }, 'ok'],
    [{ state: 'succeeded', result: {} }, 'ok'],
    [{ state: 'done', result: {} }, 'ok'],
    [{ state: 'policy_denied' }, 'denied'],
    [{ state: 'untrusted_key' }, 'denied'],
    [{ state: 'approval_denied' }, 'denied'],
    [{ state: 'approval_expired' }, 'denied'],
    [{ state: 'failed' }, 'error'],
    [{ state: 'not_found' }, 'error'],
    [{ state: 'timeout' }, 'error'],
    [{ state: 'target_offline' }, 'error'],
    [null, 'error'],
    [{ state: 'totally_unknown_xyz' }, 'error'],
    [42, 'error'],
  ];

  for (const [raw, expected] of CASES) {
    it(`classifyInvocation(${JSON.stringify(raw)}) === "${expected}"`, () => {
      expect(classifyInvocation(raw)).toBe(expected);
    });
  }

  it('classifyInvocation always equals invocationToResult(raw).status', () => {
    const samples = [
      { state: 'running' },
      { state: 'awaiting_approval' },
      { state: 'done', result: {} },
      { state: 'policy_denied' },
      { state: 'failed' },
      null,
      'weird_string',
    ];
    for (const raw of samples) {
      expect(classifyInvocation(raw)).toBe(invocationToResult(raw).status);
    }
  });
});

// ---------------------------------------------------------------------------
// Terminal cancellation states (T108) — resolved from the deliberate TODO
//
// Before T108 a `cancelled` invocation observed via mx_await_result fell through to
// the misleading `internal` "unrecognised invocation state" default. T108 makes the
// cancelled family a recognised terminal kind that resolves to a CLEAN terminal
// `error` envelope with an honest message. Conservative M1 disposition (spec Risk
// #1, Option B): the closed nine-code taxonomy stays frozen — the code is `internal`
// (the fault-set member) with the dedicated "the invocation was cancelled" message,
// NOT the "unrecognised" phrase. A distinct `cancelled` error code remains the
// documented future extension (Option A).
// ---------------------------------------------------------------------------

describe('invocationToResult — cancelled states (T108)', () => {
  const CANCELLED_STATES = ['cancelled', 'canceled', 'aborted'];

  for (const state of CANCELLED_STATES) {
    it(`state "${state}" → clean terminal error envelope (code internal, honest message)`, () => {
      const r = invocationToResult(withState(state, { invocation_id: 'inv_c1' }));
      expect(r.status).toBe('error');
      expect(r.error?.code).toBe('internal');
      // The message is honest about the cause — NOT the misleading "unrecognised" phrase.
      expect(r.error?.message).toBe('the invocation was cancelled');
      expect(r.error?.message).not.toContain('unrecognised');
      expect(r.result).toBeNull();
      expect(r.handle).toBeNull();
      expect(r.approval).toBeNull();
      expectValid(r);
    });
  }

  it('classifyInvocation returns "error" for a cancelled state', () => {
    expect(classifyInvocation(withState('cancelled'))).toBe('error');
  });

  it('carries audit_ref from the response, never fabricated', () => {
    const r = invocationToResult({ state: 'cancelled', invocation_id: 'inv_c2', room: '!r:s' });
    expect(r.audit_ref.invocation_id).toBe('inv_c2');
    expect(r.audit_ref.room).toBe('!r:s');
    expect(r.audit_ref.request_id).toBeNull();
    expect(r.audit_ref.event_id).toBeNull();
  });

  it('normalises an uppercase spelling onto the cancelled disposition', () => {
    expect(classifyInvocation(withState('CANCELLED'))).toBe('error');
    expect(invocationToResult(withState('ABORTED')).error?.message).toBe('the invocation was cancelled');
  });
});
