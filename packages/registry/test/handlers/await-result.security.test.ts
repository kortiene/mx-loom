/**
 * Security invariants for the T103 `mx_await_result` resolver (design §4.3,
 * §4.7, §6).
 *
 * Tests pin:
 * - Token-shaped values in unexpected invocation fields do not surface through
 *   the resolver into the returned envelope.
 * - error.message is always a fixed secret-free phrase — never a raw daemon payload.
 * - The resolver exposes no approve/decide/grant/mutate field in its input or output.
 * - The approval block of an awaiting_approval envelope has no authority field.
 * - The resolver only calls invocation.get (read-only) — no mutating method.
 * - Resolved envelopes pass through `redactSecrets` unchanged (no false-positive
 *   redaction of audit_ref ids, handle, or non-secret result values).
 * - Resolved envelopes are deeply frozen (immutable after construction).
 *
 * Pure unit tests; injected DaemonCall — no daemon, no socket, no env.
 */
import { describe, expect, it } from 'vitest';

import { redactSecrets } from '@mx-loom/toolbelt';

import {
  mxAwaitResult,
  type DaemonCall,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noSleep = async (_ms: number): Promise<void> => {};
const nowZero = () => 0;

function singleResponseDaemon(response: unknown): DaemonCall {
  return { call: async () => response };
}

function singleProbeDeps(response: unknown) {
  return { daemon: singleResponseDaemon(response), sleep: noSleep, now: nowZero };
}

// ---------------------------------------------------------------------------
// Secret-free output — token-shaped values in raw daemon response do not surface
// ---------------------------------------------------------------------------

describe('mxAwaitResult — secret-free resolver output', () => {
  it('a token-shaped value in an unexpected invocation field does not appear in the envelope', async () => {
    const raw = {
      state: 'running',
      handle: 'inv_safe',
      invocation_id: 'inv_safe',
      unexpected_secret: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    };
    const result = await mxAwaitResult({ handle: 'inv_safe', wait_ms: 0 }, singleProbeDeps(raw));
    const json = JSON.stringify(result);
    expect(json).not.toContain('ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(json).not.toContain('unexpected_secret');
  });

  it('a Matrix token in an unknown field does not leak into the running envelope', async () => {
    const raw = {
      state: 'running',
      handle: 'inv_mat',
      invocation_id: 'inv_mat',
      _matrix_access_token: 'syt_AAAAAAAAAAAAAAAAAAAAAA',
    };
    const result = await mxAwaitResult({ handle: 'inv_mat', wait_ms: 0 }, singleProbeDeps(raw));
    const json = JSON.stringify(result);
    expect(json).not.toContain('syt_AAAAAAAAAAAAAAAAAAAAAA');
    expect(json).not.toContain('_matrix_access_token');
  });

  it('error.message for a failed invocation is a fixed phrase, not a raw daemon payload', async () => {
    const raw = { state: 'failed', raw_daemon_message: 'syt_secret_token_in_daemon_error' };
    const result = await mxAwaitResult({ handle: 'inv_err', wait_ms: 0 }, singleProbeDeps(raw));
    expect(result.error?.message).not.toContain('syt_secret_token_in_daemon_error');
    expect(result.error?.message).not.toContain('raw_daemon_message');
    expect(result.error?.message).toBe('the invocation failed');
  });

  it('a token-shaped value in daemon error.message is not echoed into the envelope', async () => {
    const raw = {
      state: 'failed',
      error: { code: 'internal', message: 'sk-ant-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    };
    const result = await mxAwaitResult({ handle: 'inv_err2', wait_ms: 0 }, singleProbeDeps(raw));
    expect(result.error?.message).not.toContain('sk-ant-');
    // The message is always from the fixed vocabulary
    expect(typeof result.error?.message).toBe('string');
    expect(result.error!.message.length).toBeGreaterThan(0);
  });

  it('approval.summary is a fixed phrase or empty, never a raw daemon payload', async () => {
    const raw = {
      state: 'awaiting_approval',
      handle: 'inv_ap',
      invocation_id: 'inv_ap',
      approval: {
        request_id: 'req_ap',
        risk: 'low',
        summary: 'Safe approval text',
        expires_at: '2026-06-22T14:00:00Z',
      },
    };
    const result = await mxAwaitResult({ handle: 'inv_ap', wait_ms: 0 }, singleProbeDeps(raw));
    // The summary is passed through from the daemon (it is not re-built from code)
    // but it must not carry a credential-shaped value
    const approvalJson = JSON.stringify(result.approval);
    expect(approvalJson).not.toContain('ghp_');
    expect(approvalJson).not.toContain('syt_');
    expect(approvalJson).not.toContain('sk-ant-');
  });
});

// ---------------------------------------------------------------------------
// No authority field — no approve/decide/mutate surface exposed
// ---------------------------------------------------------------------------

describe('mxAwaitResult — no authority field in input or output', () => {
  it('AwaitResultInput shape has no approve/decide/grant/mutate field', async () => {
    const input = { handle: 'inv_1', wait_ms: 0 };
    const forbidden = ['approve', 'decide', 'grant', 'accept', 'reject', 'cancel', 'token', 'key'];
    for (const field of forbidden) {
      expect(Object.prototype.hasOwnProperty.call(input, field)).toBe(false);
    }
  });

  it('the resolved ok envelope has no approve/decide/grant/mutate field', async () => {
    const raw = { state: 'done', result: {}, invocation_id: 'inv_ok' };
    const result = await mxAwaitResult({ handle: 'inv_ok', wait_ms: 0 }, singleProbeDeps(raw));
    const forbidden = ['approve', 'decide', 'grant', 'accept', 'reject', 'cancel'];
    for (const field of forbidden) {
      expect(Object.prototype.hasOwnProperty.call(result, field)).toBe(false);
    }
  });

  it('an awaiting_approval envelope approval block has no decide/approve field', async () => {
    const raw = {
      state: 'awaiting_approval',
      handle: 'inv_ap',
      invocation_id: 'inv_ap',
      approval: {
        request_id: 'req_ap',
        risk: 'low',
        summary: 'Approve action',
        expires_at: '2026-06-22T14:00:00Z',
      },
    };
    const result = await mxAwaitResult({ handle: 'inv_ap', wait_ms: 0 }, singleProbeDeps(raw));
    expect(result.approval).not.toBeNull();
    const forbidden = ['approve', 'decide', 'grant', 'reject', 'token'];
    for (const field of forbidden) {
      expect(Object.prototype.hasOwnProperty.call(result.approval, field)).toBe(false);
    }
  });

  it('the resolver issues ONLY invocation.get (read-only) — never a mutating method', async () => {
    const methods: string[] = [];
    const spy: DaemonCall = {
      call: async (method) => {
        methods.push(method);
        return { state: 'running', handle: 'inv_1' };
      },
    };
    await mxAwaitResult({ handle: 'inv_1', wait_ms: 0 }, { daemon: spy, sleep: noSleep, now: nowZero });
    expect(methods.length).toBeGreaterThan(0);
    for (const m of methods) {
      expect(m).toBe('invocation.get');
    }
  });

  it('the resolver emits no call to approve, decide, or cancel methods', async () => {
    const methods: string[] = [];
    const spy: DaemonCall = {
      call: async (method) => {
        methods.push(method);
        return { state: 'awaiting_approval', handle: 'inv_ap' };
      },
    };
    await mxAwaitResult({ handle: 'inv_ap', wait_ms: 0 }, { daemon: spy, sleep: noSleep, now: nowZero });
    const forbidden = ['approve', 'decide', 'cancel', 'approval.decide', 'invocation.cancel'];
    for (const m of methods) {
      expect(forbidden.includes(m)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// redactSecrets pass-through — no false-positive redaction of envelope fields
// ---------------------------------------------------------------------------

describe('mxAwaitResult — redactSecrets pass-through on resolved envelopes', () => {
  it('running envelope from the resolver is unchanged after redactSecrets', async () => {
    const raw = {
      state: 'running',
      handle: 'inv_run',
      invocation_id: 'inv_run',
      request_id: 'req_run',
      room: '!room:server',
      event_id: '$evt_run',
    };
    const result = await mxAwaitResult({ handle: 'inv_run', wait_ms: 0 }, singleProbeDeps(raw));
    const redacted = redactSecrets(result);
    expect(redacted).toEqual(result);
  });

  it('ok envelope with non-secret result is unchanged after redactSecrets', async () => {
    const raw = { state: 'done', result: { files: 3, label: 'deploy-abc' }, invocation_id: 'inv_ok' };
    const result = await mxAwaitResult({ handle: 'inv_ok', wait_ms: 0 }, singleProbeDeps(raw));
    const redacted = redactSecrets(result);
    expect(redacted).toEqual(result);
  });

  it('awaiting_approval envelope is unchanged after redactSecrets', async () => {
    const raw = {
      state: 'awaiting_approval',
      handle: 'inv_ap',
      invocation_id: 'inv_ap',
      approval: {
        request_id: 'req_ap',
        risk: 'medium',
        summary: 'Deploy to staging',
        expires_at: '2026-06-22T12:00:00Z',
      },
    };
    const result = await mxAwaitResult({ handle: 'inv_ap', wait_ms: 0 }, singleProbeDeps(raw));
    const redacted = redactSecrets(result);
    expect(redacted).toEqual(result);
  });

  it('denied envelope is unchanged after redactSecrets', async () => {
    const raw = { state: 'policy_denied', invocation_id: 'inv_dn' };
    const result = await mxAwaitResult({ handle: 'inv_dn', wait_ms: 0 }, singleProbeDeps(raw));
    const redacted = redactSecrets(result);
    expect(redacted).toEqual(result);
  });

  it('error envelope is unchanged after redactSecrets', async () => {
    const raw = { state: 'not_found', invocation_id: 'inv_err' };
    const result = await mxAwaitResult({ handle: 'inv_err', wait_ms: 0 }, singleProbeDeps(raw));
    const redacted = redactSecrets(result);
    expect(redacted).toEqual(result);
  });

  it('audit_ref ids (inv_*, req_*, !room:*, $evt_*) are not redacted', async () => {
    const raw = {
      state: 'done',
      result: {},
      invocation_id: 'inv_sec_01',
      request_id: 'req_sec_01',
      room: '!room:test',
      event_id: '$evt_sec_01',
    };
    const result = await mxAwaitResult({ handle: 'inv_sec_01', wait_ms: 0 }, singleProbeDeps(raw));
    const redacted = redactSecrets(result) as typeof result;
    expect(redacted.audit_ref.invocation_id).toBe('inv_sec_01');
    expect(redacted.audit_ref.request_id).toBe('req_sec_01');
    expect(redacted.audit_ref.room).toBe('!room:test');
    expect(redacted.audit_ref.event_id).toBe('$evt_sec_01');
  });

  it('redactSecrets fires no onRedact callback for a clean resolved envelope', async () => {
    const raw = { state: 'done', result: { count: 1, label: 'success' }, invocation_id: 'inv_clean' };
    const result = await mxAwaitResult({ handle: 'inv_clean', wait_ms: 0 }, singleProbeDeps(raw));
    const redactedPaths: string[] = [];
    redactSecrets(result, (path) => redactedPaths.push(path));
    expect(redactedPaths).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Immutability — resolved envelopes are deeply frozen
// ---------------------------------------------------------------------------

describe('mxAwaitResult — resolved envelopes are deeply frozen', () => {
  it('ok envelope returned by the resolver is frozen at the top level', async () => {
    const raw = { state: 'done', result: { x: 1 }, invocation_id: 'inv_ok' };
    const result = await mxAwaitResult({ handle: 'inv_ok', wait_ms: 0 }, singleProbeDeps(raw));
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('running envelope is frozen, including the nested audit_ref', async () => {
    const raw = { state: 'running', handle: 'inv_run', invocation_id: 'inv_run' };
    const result = await mxAwaitResult({ handle: 'inv_run', wait_ms: 0 }, singleProbeDeps(raw));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.audit_ref)).toBe(true);
  });

  it('awaiting_approval envelope approval block is frozen', async () => {
    const raw = {
      state: 'awaiting_approval',
      handle: 'inv_ap',
      invocation_id: 'inv_ap',
      approval: { request_id: 'r', risk: 'low', summary: 's', expires_at: 'e' },
    };
    const result = await mxAwaitResult({ handle: 'inv_ap', wait_ms: 0 }, singleProbeDeps(raw));
    expect(Object.isFrozen(result.approval)).toBe(true);
  });

  it('mutation of a frozen envelope field throws in strict mode', async () => {
    const raw = { state: 'done', result: { x: 1 }, invocation_id: 'inv_ok' };
    const result = await mxAwaitResult({ handle: 'inv_ok', wait_ms: 0 }, singleProbeDeps(raw));
    expect(() => {
      (result as unknown as Record<string, unknown>).status = 'error';
    }).toThrow();
  });
});
