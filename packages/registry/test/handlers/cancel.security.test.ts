/**
 * Security invariants for the `mx_cancel` handler (T108 / #16) — design §1,
 * §4.7, §6, §9 ("Don't give cognition any authority surface").
 *
 * Tests pin:
 * - `mx_cancel` is in `MODEL_FACING_ALLOWLIST` and is NOT a forbidden authority
 *   verb: it emits a signed cancel request and surfaces the receiver's verdict —
 *   it never grants authority to cancel, never mutates trust/policy/approval.
 * - `CancelInput` has no credential-shaped field and no `room` field (room is
 *   daemon-side, derived from the invocation record).
 * - The handler dispatches ONLY `invocation.cancel` — no approve/decide/trust/
 *   policy/deny method is ever emitted.
 * - A credential-shaped value in the handle param is rejected by the real
 *   toolbelt guard → `invalid_args` (the registry-boundary representation).
 * - `error.message` is always a fixed, secret-free phrase — never the handle,
 *   never a raw daemon payload, never any credential-shaped value.
 * - Ok envelopes are deeply frozen and pass `redactSecrets` unchanged (no false
 *   positive redaction of correlation ids or cancel result fields).
 *
 * Pure unit tests; injected DaemonCall — no daemon, no socket, no env.
 */
import { describe, expect, it } from 'vitest';

import { TransportError, assertNoCredentialShapedArgs, redactSecrets } from '@mx-loom/toolbelt';

import {
  MX_CANCEL,
  MODEL_FACING_ALLOWLIST,
  isForbiddenAuthorityVerb,
  mxCancel,
  validateEnvelope,
  type CancelInput,
  type DaemonCall,
  type HandlerDeps,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HANDLE = 'inv_sec_01';
const VALID_INPUT: CancelInput = { handle: HANDLE };

const CANCEL_OK_RESPONSE = { cancelled: true, state: 'cancelled', invocation_id: HANDLE };

/**
 * A fake daemon that mirrors the production `MxClient.call` secret boundary:
 * runs the REAL `assertNoCredentialShapedArgs` over params before "dispatch",
 * and `redactSecrets` over the result at its single exit point. A credential-
 * shaped handle value is rejected exactly as it would be over a real transport.
 */
function makeGuardedDeps(): HandlerDeps & { methods: string[] } {
  const methods: string[] = [];
  const daemon: DaemonCall = {
    call: async (method, params) => {
      methods.push(method);
      assertNoCredentialShapedArgs(params); // throws TransportError('invalid_args')
      if (method === 'invocation.cancel') {
        return redactSecrets(CANCEL_OK_RESPONSE);
      }
      throw new Error(`Security test: unexpected method "${method}"`);
    },
  };
  return { daemon, methods };
}

/** Plain fake for dispatch-discipline and message-secrecy assertions. */
function makeDeps(opts: { cancelResp?: unknown; onCall?: (method: string) => void } = {}): HandlerDeps & {
  methods: string[];
} {
  const methods: string[] = [];
  const daemon: DaemonCall = {
    call: async (method, _params) => {
      methods.push(method);
      opts.onCall?.(method);
      if (method === 'invocation.cancel') {
        // Use 'in' check so an explicitly-passed cancelResp: null stays null
        // rather than falling back to the default (null ?? default = default).
        const r = 'cancelResp' in opts ? opts.cancelResp : CANCEL_OK_RESPONSE;
        if (r instanceof Error) throw r;
        return r;
      }
      throw new Error(`Security test: unexpected method "${method}"`);
    },
  };
  return { daemon, methods };
}

function expectValid(result: unknown): void {
  expect(
    validateEnvelope(result),
    `envelope invalid: ${JSON.stringify((validateEnvelope as { errors?: unknown }).errors)}`,
  ).toBe(true);
}

// ---------------------------------------------------------------------------
// No-authority invariant — allowlist and forbidden-verb checks
// ---------------------------------------------------------------------------

describe('mx_cancel — no-authority allowlist invariants', () => {
  it('mx_cancel is in MODEL_FACING_ALLOWLIST', () => {
    expect(MODEL_FACING_ALLOWLIST).toContain('mx_cancel');
  });

  it('mx_cancel is NOT a forbidden authority verb', () => {
    expect(isForbiddenAuthorityVerb('mx_cancel')).toBe(false);
  });

  it('MX_CANCEL descriptor name is "mx_cancel"', () => {
    expect(MX_CANCEL.name).toBe('mx_cancel');
  });

  it('MX_CANCEL declares no forbidden authority hint ("guarded", "approve", etc.)', () => {
    const d = MX_CANCEL as unknown as Record<string, unknown>;
    expect(d.guarded).toBeUndefined();
    expect(d.approve).toBeUndefined();
    expect(d.authority).toBeUndefined();
  });

  it('mx_cancel is not prefixed with any forbidden authority prefix', () => {
    const FORBIDDEN_PREFIXES = ['trust.', 'policy.', 'auth.', 'device.', 'cross_signing.', 'recovery.', 'daemon.'];
    for (const prefix of FORBIDDEN_PREFIXES) {
      expect(MX_CANCEL.name.startsWith(prefix)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Secret-free input shape — CancelInput has no credential or room field
// ---------------------------------------------------------------------------

describe('mx_cancel — CancelInput has no credential-shaped or room field', () => {
  it('input only carries the "handle" key', () => {
    expect(Object.keys(VALID_INPUT)).toEqual(['handle']);
  });

  it('input has no token-suffix field', () => {
    for (const key of Object.keys(VALID_INPUT)) {
      expect(key.endsWith('token')).toBe(false);
      expect(key.endsWith('_token')).toBe(false);
    }
  });

  it('input has no secret/password/key field', () => {
    const forbidden = /(?:secret|password|passwd|api[_-]?key|signing[_-]?key|private[_-]?key|matrix_|mx_agent_|gh[_-]?token)/i;
    for (const key of Object.keys(VALID_INPUT)) {
      expect(forbidden.test(key)).toBe(false);
    }
  });

  it('input has no "room" field — the room is derived daemon-side from the invocation', () => {
    expect(Object.prototype.hasOwnProperty.call(VALID_INPUT, 'room')).toBe(false);
  });

  it('descriptor input_schema declares no credential-shaped property', () => {
    const props = Object.keys(
      (MX_CANCEL.input_schema as { properties: Record<string, unknown> }).properties,
    );
    const forbidden = /(?:secret|password|passwd|api[_-]?key|signing[_-]?key|private[_-]?key|matrix_|mx_agent_|gh[_-]?token|(?:^|[_-])token$)/i;
    for (const p of props) {
      expect(forbidden.test(p)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// RPC method discipline — only invocation.cancel dispatched
// ---------------------------------------------------------------------------

describe('mx_cancel — RPC method discipline', () => {
  it('only "invocation.cancel" is dispatched on a successful cancel', async () => {
    const d = makeDeps();
    await mxCancel(VALID_INPUT, d);
    expect(d.methods).toEqual(['invocation.cancel']);
  });

  it('no approve, decide, grant, trust, or policy method is ever dispatched', async () => {
    const FORBIDDEN_METHODS = [
      'approve', 'approval.decide', 'approval.approve', 'approval.reject',
      'trust.add', 'trust.remove', 'trust.publish', 'policy.update', 'policy.deny',
      'invocation.approve', 'invocation.get',
    ];
    const d = makeDeps();
    await mxCancel(VALID_INPUT, d);
    for (const m of d.methods) {
      expect(FORBIDDEN_METHODS.includes(m)).toBe(false);
    }
  });

  it('on a transport fault, still only invocation.cancel was attempted (no second RPC)', async () => {
    const d = makeDeps({ cancelResp: new TransportError('timeout', 'timed out') });
    await mxCancel(VALID_INPUT, d);
    expect(d.methods).toHaveLength(1);
    expect(d.methods[0]).toBe('invocation.cancel');
  });
});

// ---------------------------------------------------------------------------
// Credential-shaped handle value → invalid_args (via real guard)
// ---------------------------------------------------------------------------

describe('mx_cancel — credential-shaped handle value → invalid_args', () => {
  it('a Bearer-token handle value is rejected by the real guard → invalid_args', async () => {
    const d = makeGuardedDeps();
    const result = await mxCancel({ handle: 'sk-ant-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
    expectValid(result);
  });

  it('a GitHub PAT handle value is rejected → invalid_args', async () => {
    const d = makeGuardedDeps();
    const result = await mxCancel({ handle: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
  });

  it('a Matrix access token handle value is rejected → invalid_args', async () => {
    const d = makeGuardedDeps();
    const result = await mxCancel({ handle: 'syt_AAAAAAAAAAAAAAAAAAAAAAAA' }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
  });

  it('invalid_args error.message is the fixed phrase, never the rejected value', async () => {
    const d = makeGuardedDeps();
    const result = await mxCancel({ handle: 'sk-ant-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, d);
    expect(result.error?.message).toBe('the request was rejected as invalid');
    expect(JSON.stringify(result)).not.toContain('sk-ant-');
  });

  it('a legitimate inv_* handle passes the guard and runs normally', async () => {
    const d = makeGuardedDeps();
    const result = await mxCancel({ handle: 'inv_c_legitimate_001' }, d);
    expect(result.status).toBe('ok');
    expectValid(result);
  });
});

// ---------------------------------------------------------------------------
// Secret-free error messages — never echoes handle or raw daemon payload
// ---------------------------------------------------------------------------

describe('mx_cancel — secret-free error messages', () => {
  it('error.message for policy_denied does not echo the handle', async () => {
    const d = makeDeps({
      cancelResp: new TransportError('rpc', 'rpc error: policy_denied', { cause: { error: { code: 'policy_denied' } } }),
    });
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.error?.message).toBe('denied by the receiver policy');
    expect(result.error?.message).not.toContain(HANDLE);
  });

  it('error.message does not echo a raw daemon payload containing a secret-like string', async () => {
    const leakyError = new TransportError('rpc', 'rpc error: policy_denied', {
      cause: { error: { code: 'policy_denied', message: 'syt_AAAAAAAAAAAAAAAA leaked in daemon error' } },
    });
    const d = makeDeps({ cancelResp: leakyError });
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.error?.message).not.toContain('syt_AAAAAAAAAAAAAAAA');
    expect(result.error?.message).toBe('denied by the receiver policy');
  });

  it('error.message for not_found is the fixed phrase', async () => {
    const d = makeDeps({
      cancelResp: new TransportError('rpc', 'rpc error: not_found', { cause: { error: { code: 'not_found' } } }),
    });
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.error?.message).toBe('no such invocation');
  });

  it('internal error.message is the fixed phrase', async () => {
    const d = makeDeps({ cancelResp: null }); // null reply → internal
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.error?.message).toBe('unrecognised cancel response');
  });
});

// ---------------------------------------------------------------------------
// Envelope immutability + redactSecrets pass-through
// ---------------------------------------------------------------------------

describe('mx_cancel — envelope immutability and redactSecrets', () => {
  it('ok envelope is deeply frozen', async () => {
    const d = makeDeps();
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.audit_ref)).toBe(true);
  });

  it('ok envelope passes redactSecrets unchanged (no false-positive redaction)', async () => {
    const d = makeDeps({
      cancelResp: {
        cancelled: true,
        invocation_id: 'inv_c_clean',
        request_id: 'req_c_clean',
        room: '!room:home',
        event_id: '$evt_c_clean',
      },
    });
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    expect(redactSecrets(result)).toEqual(result);
  });

  it('mutation of a frozen ok envelope field throws in strict mode', async () => {
    const d = makeDeps();
    const result = await mxCancel(VALID_INPUT, d);
    expect(() => {
      (result as unknown as Record<string, unknown>).status = 'error';
    }).toThrow();
  });

  it('error envelope is also frozen', async () => {
    const d = makeDeps({
      cancelResp: new TransportError('rpc', 'rpc error: not_found', { cause: { error: { code: 'not_found' } } }),
    });
    const result = await mxCancel(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(Object.isFrozen(result)).toBe(true);
  });
});
