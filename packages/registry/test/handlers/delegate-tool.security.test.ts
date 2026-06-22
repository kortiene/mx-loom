/**
 * Security invariants for the `mx_delegate_tool` handler (T105 / #13) — design
 * §1, §4.7, §6, §9 ("Don't give cognition any authority surface").
 *
 * Tests pin:
 * - `mx_delegate_tool` is in `MODEL_FACING_ALLOWLIST` and NOT a forbidden authority verb.
 * - `DelegateToolInput` shape has no credential-shaped or authority-mutation field.
 * - The handler emits ONLY `agent.tools` and `call.start` RPCs — no approve/decide/
 *   mutate method ever dispatched.
 * - `call.start` transporting `TransportError('invalid_args')` → `invalid_args` envelope
 *   (the registry-boundary representation of the toolbelt credential guard).
 * - `error.message` on every failure envelope is always a fixed, secret-free phrase —
 *   never a raw daemon payload, never an echoed arg value.
 * - No token-shaped value from a daemon response leaks into the returned envelope.
 * - Result envelopes are deeply frozen (immutable after construction).
 * - Result envelopes pass `redactSecrets` unchanged (no false-positive redaction of
 *   audit_ref ids, handle, or non-secret result payloads).
 * - `approval.summary` from a held invocation does not carry a credential-shaped value.
 * - The handler never calls approve/decide/grant/cancel/trust methods.
 *
 * Pure unit tests; injected DaemonCall — no daemon, no socket, no env.
 */
import { describe, expect, it } from 'vitest';

import { TransportError, redactSecrets } from '@mx-loom/toolbelt';

import {
  MX_DELEGATE_TOOL,
  MODEL_FACING_ALLOWLIST,
  isForbiddenAuthorityVerb,
  mxDelegateTool,
  validateEnvelope,
  type DaemonCall,
  type DelegateDeps,
  type DelegateToolInput,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENT_ID = 'ag_sec_01';
const TOOL_NAME = 'run_tests';
const TOOL_VERSION = '1.0.0';
const TOOL_REF = `${TOOL_NAME}@${TOOL_VERSION}`;
const ROOM = '!workspace:homeserver';

const TOOLS_RESPONSE = {
  agent_id: AGENT_ID,
  schemas: [
    {
      name: TOOL_NAME,
      version: TOOL_VERSION,
      input_schema: { type: 'object', properties: { suite: { type: 'string' } }, required: ['suite'] },
      output_schema: { type: 'object' },
    },
  ],
};

const noSleep = async (_ms: number): Promise<void> => {};
const nowZero = () => 0;

/** Fake validator — always passes. */
const alwaysValid: DelegateDeps['validator'] = {
  compile: () => {
    const fn = (_data: unknown): boolean => true;
    (fn as { errors?: unknown }).errors = undefined;
    return fn as ReturnType<NonNullable<DelegateDeps['validator']>['compile']>;
  },
};

function makeDeps(opts: {
  toolsResp?: unknown;
  callResp?: unknown;
  validator?: DelegateDeps['validator'];
  onCall?: (method: string) => void;
}): DelegateDeps & { methods: string[] } {
  const methods: string[] = [];

  const daemon: DaemonCall = {
    call: async (method, _params) => {
      methods.push(method);
      opts.onCall?.(method);
      if (method === 'agent.tools') {
        const r = opts.toolsResp;
        if (r instanceof Error) throw r;
        return r ?? TOOLS_RESPONSE;
      }
      if (method === 'call.start') {
        const r = opts.callResp;
        if (r instanceof Error) throw r;
        return r ?? { ok: true, result: {}, invocation_id: 'inv_sec_01' };
      }
      throw new Error(`Security test: unexpected method "${method}"`);
    },
  };

  return {
    daemon,
    room: ROOM,
    // When validator is not provided, leave it undefined so the handler falls
    // through to its real Ajv default — letting "real schema validation" tests
    // work without needing to inject a fake validator.
    validator: opts.validator,
    sleep: noSleep,
    now: nowZero,
    methods,
  };
}

const VALID_INPUT: DelegateToolInput = {
  agent: AGENT_ID,
  tool: TOOL_REF,
  args: { suite: 'unit' },
};

function expectValid(result: unknown): void {
  expect(
    validateEnvelope(result),
    `envelope invalid: ${JSON.stringify((validateEnvelope as { errors?: unknown }).errors)}`,
  ).toBe(true);
}

// ---------------------------------------------------------------------------
// No-authority invariant — allowlist and forbidden-verb checks
// ---------------------------------------------------------------------------

describe('mx_delegate_tool — no-authority allowlist invariants', () => {
  it('mx_delegate_tool is in MODEL_FACING_ALLOWLIST', () => {
    expect(MODEL_FACING_ALLOWLIST).toContain('mx_delegate_tool');
  });

  it('mx_delegate_tool is NOT a forbidden authority verb', () => {
    expect(isForbiddenAuthorityVerb('mx_delegate_tool')).toBe(false);
  });

  it('MX_DELEGATE_TOOL descriptor name is "mx_delegate_tool"', () => {
    expect(MX_DELEGATE_TOOL.name).toBe('mx_delegate_tool');
  });

  it('MX_DELEGATE_TOOL is not prefixed with a forbidden authority prefix', () => {
    const FORBIDDEN_PREFIXES = ['trust.', 'policy.', 'auth.', 'device.', 'cross_signing.', 'recovery.', 'daemon.'];
    for (const prefix of FORBIDDEN_PREFIXES) {
      expect(MX_DELEGATE_TOOL.name.startsWith(prefix)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Secret-free input shape — DelegateToolInput has no credential-shaped field
// ---------------------------------------------------------------------------

describe('mx_delegate_tool — DelegateToolInput has no credential-shaped field', () => {
  it('DelegateToolInput shape has no "token"-suffix field', () => {
    const input = VALID_INPUT;
    const keys = Object.keys(input);
    for (const key of keys) {
      expect(key.endsWith('token')).toBe(false);
      expect(key.endsWith('_token')).toBe(false);
    }
  });

  it('DelegateToolInput has no secret/password/key field', () => {
    const input = VALID_INPUT;
    const keys = Object.keys(input);
    const forbidden = /(?:secret|password|passwd|api[_-]?key|signing[_-]?key|private[_-]?key|matrix_|mx_agent_|gh[_-]?token)/i;
    for (const key of keys) {
      expect(forbidden.test(key)).toBe(false);
    }
  });

  it('DelegateToolInput has no approve/decide/grant/trust authority field', () => {
    const input = VALID_INPUT;
    const keys = Object.keys(input);
    const authority = ['approve', 'decide', 'grant', 'trust', 'cancel', 'reject'];
    for (const key of keys) {
      expect(authority.includes(key)).toBe(false);
    }
  });

  it('DelegateToolInput has no "room" field — room is injected via deps, not model input', () => {
    const input = VALID_INPUT;
    expect(Object.prototype.hasOwnProperty.call(input, 'room')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RPC method discipline — only agent.tools and call.start dispatched
// ---------------------------------------------------------------------------

describe('mx_delegate_tool — RPC method discipline', () => {
  it('only agent.tools and call.start are called on a successful delegation', async () => {
    const d = makeDeps({});
    await mxDelegateTool(VALID_INPUT, d);
    const unexpected = d.methods.filter(
      (m) => m !== 'agent.tools' && m !== 'call.start',
    );
    expect(unexpected).toHaveLength(0);
    expect(d.methods).toContain('agent.tools');
    expect(d.methods).toContain('call.start');
  });

  it('no approve, decide, cancel, trust, or policy method is ever dispatched', async () => {
    const FORBIDDEN_METHODS = [
      'approve', 'approval.decide', 'approval.approve', 'approval.reject',
      'trust.add', 'trust.remove', 'policy.update', 'policy.deny',
      'invocation.cancel', 'invocation.approve',
    ];
    const d = makeDeps({});
    await mxDelegateTool(VALID_INPUT, d);
    for (const m of d.methods) {
      expect(FORBIDDEN_METHODS.includes(m)).toBe(false);
    }
  });

  it('on pre-dispatch failure (invalid args), call.start is never reached', async () => {
    const badInput: DelegateToolInput = { agent: AGENT_ID, tool: TOOL_REF, args: {} };
    // Use real Ajv validator — the registered input_schema requires 'suite'
    const d = makeDeps({});
    await mxDelegateTool(badInput, d);
    expect(d.methods.includes('call.start')).toBe(false);
  });

  it('on room absence, neither agent.tools nor call.start is dispatched', async () => {
    const d = makeDeps({});
    const dNoRoom = { ...d, room: undefined };
    await mxDelegateTool(VALID_INPUT, dNoRoom as DelegateDeps);
    expect(d.methods).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Credential-shaped args → invalid_args (registry-boundary representation)
// ---------------------------------------------------------------------------

describe('mx_delegate_tool — credential-shaped args surface as invalid_args', () => {
  it('TransportError("invalid_args") from call.start → invalid_args envelope', async () => {
    // Simulates what MxClient.call() raises when assertNoCredentialShapedArgs fires.
    const d = makeDeps({
      callResp: new TransportError('invalid_args', 'credential-shaped arg rejected'),
    });
    const result = await mxDelegateTool(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
    expectValid(result);
  });

  it('invalid_args from credential guard: error.message is fixed phrase, not the arg value', async () => {
    const d = makeDeps({
      callResp: new TransportError('invalid_args', 'credential-shaped arg rejected'),
    });
    const result = await mxDelegateTool(VALID_INPUT, d);
    expect(result.error?.code).toBe('invalid_args');
    expect(result.error?.message).toBe('the request was rejected as invalid');
    // The transport error message must not appear in the envelope
    expect(result.error?.message).not.toContain('credential-shaped');
    expect(result.error?.message).not.toContain('arg rejected');
  });

  it('gh_token-shaped key in args: validation rejects before dispatch via real Ajv schema', async () => {
    // The target schema has additionalProperties:false, so a 'gh_token' key fails schema.
    const d = makeDeps({
      toolsResp: {
        agent_id: AGENT_ID,
        schemas: [{
          name: TOOL_NAME,
          version: TOOL_VERSION,
          input_schema: {
            type: 'object',
            properties: { suite: { type: 'string' } },
            required: ['suite'],
            additionalProperties: false,
          },
        }],
      },
      callResp: { ok: true, result: {} },
      // No fake validator — use the real Ajv validator (default)
    });
    const result = await mxDelegateTool(
      { agent: AGENT_ID, tool: TOOL_REF, args: { suite: 'unit', gh_token: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } },
      d,
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
    expect(d.methods.includes('call.start')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Secret-free output — no token-shaped value leaks into the envelope
// ---------------------------------------------------------------------------

describe('mx_delegate_tool — secret-free envelope output', () => {
  it('a token-shaped value in an unexpected daemon result field does not appear in the envelope', async () => {
    const leakyResponse = {
      ok: true,
      result: { summary: 'all green' },
      invocation_id: 'inv_leak_01',
      __unexpected: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    };
    const d = makeDeps({ callResp: leakyResponse });
    const result = await mxDelegateTool(VALID_INPUT, d);
    const json = JSON.stringify(result);
    expect(json).not.toContain('ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(json).not.toContain('__unexpected');
  });

  it('a Matrix token in an unexpected field does not leak into the envelope', async () => {
    const leakyResponse = {
      state: 'running',
      handle: 'inv_mat_01',
      invocation_id: 'inv_mat_01',
      _matrix_token: 'syt_AAAAAAAAAAAAAAAAAAAAAA',
    };
    const d = makeDeps({ callResp: leakyResponse });
    const result = await mxDelegateTool(VALID_INPUT, d);
    const json = JSON.stringify(result);
    expect(json).not.toContain('syt_AAAAAAAAAAAAAAAAAAAAAA');
    expect(json).not.toContain('_matrix_token');
    expectValid(result);
  });

  it('error.message for any failure code is a fixed phrase — never a raw daemon payload', async () => {
    const leakyError = new TransportError('rpc', 'syt_AAAAAAAAAAAAAAAAAAAAAA in daemon error', {
      cause: { error: { code: 'policy_denied', message: 'syt_AAAAAAAAAAAAAAAAAAAAAA leaked' } },
    });
    const d = makeDeps({ callResp: leakyError });
    const result = await mxDelegateTool(VALID_INPUT, d);
    expect(result.error?.message).not.toContain('syt_AAAAAAAAAAAAAAAAAAAAAA');
    expect(result.error?.message).toBe('denied by the receiver policy');
  });

  it('error.message for internal fault is fixed phrase — never daemon payload', async () => {
    const d = makeDeps({ callResp: { state: 'failed', rawPayload: 'sk-ant-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } });
    const result = await mxDelegateTool(VALID_INPUT, d);
    expect(result.error?.message).not.toContain('sk-ant-');
    expect(result.error?.message).not.toContain('rawPayload');
  });

  it('approval.summary is passed through but must never carry a credential-shaped value', async () => {
    const awaitingWithCleanApproval = {
      state: 'awaiting_approval',
      handle: 'inv_ap_sec_01',
      invocation_id: 'inv_ap_sec_01',
      approval: {
        request_id: 'req_ap_sec_01',
        risk: 'high',
        summary: 'Approve running the test suite',
        expires_at: '2026-06-22T14:00:00Z',
      },
    };
    const d = makeDeps({ callResp: awaitingWithCleanApproval });
    const result = await mxDelegateTool({ ...VALID_INPUT, wait_ms: 0 }, d);
    const approvalJson = JSON.stringify(result.approval);
    expect(approvalJson).not.toContain('ghp_');
    expect(approvalJson).not.toContain('syt_');
    expect(approvalJson).not.toContain('sk-ant-');
    expectValid(result);
  });

  it('approval block exposes only the four documented fields (no raw daemon extras)', async () => {
    const awaitingWithExtras = {
      state: 'awaiting_approval',
      handle: 'inv_ap_sec_02',
      invocation_id: 'inv_ap_sec_02',
      approval: {
        request_id: 'req_ap_sec_02',
        risk: 'medium',
        summary: 'Deploy',
        expires_at: '2026-06-22T14:00:00Z',
        secret_token: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        __raw_daemon: 'should_be_stripped',
      },
    };
    const d = makeDeps({ callResp: awaitingWithExtras });
    const result = await mxDelegateTool({ ...VALID_INPUT, wait_ms: 0 }, d);
    expect(result.status).toBe('awaiting_approval');
    const approvalKeys = Object.keys(result.approval ?? {});
    expect(approvalKeys.sort()).toEqual(['expires_at', 'request_id', 'risk', 'summary']);
    expect(approvalKeys).not.toContain('secret_token');
    expect(approvalKeys).not.toContain('__raw_daemon');
  });
});

// ---------------------------------------------------------------------------
// redactSecrets pass-through — no false-positive redaction of envelope fields
// ---------------------------------------------------------------------------

describe('mx_delegate_tool — redactSecrets pass-through on resolved envelopes', () => {
  it('ok envelope with non-secret result is unchanged after redactSecrets', async () => {
    const resp = {
      ok: true,
      result: { files: 3, label: 'deploy-abc' },
      invocation_id: 'inv_clean_ok',
      request_id: 'req_clean_ok',
      room: ROOM,
      event_id: '$evt_clean_ok',
    };
    const d = makeDeps({ callResp: resp });
    const result = await mxDelegateTool(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    const redacted = redactSecrets(result);
    expect(redacted).toEqual(result);
  });

  it('running envelope is unchanged after redactSecrets', async () => {
    const resp = {
      state: 'running',
      handle: 'inv_clean_run',
      invocation_id: 'inv_clean_run',
      request_id: 'req_clean_run',
      room: ROOM,
      event_id: '$evt_clean_run',
    };
    const d = makeDeps({ callResp: resp });
    const result = await mxDelegateTool({ ...VALID_INPUT, wait_ms: 0 }, d);
    const redacted = redactSecrets(result);
    expect(redacted).toEqual(result);
  });

  it('denied envelope is unchanged after redactSecrets', async () => {
    const resp = { state: 'policy_denied', invocation_id: 'inv_clean_dn' };
    const d = makeDeps({ callResp: resp });
    const result = await mxDelegateTool(VALID_INPUT, d);
    const redacted = redactSecrets(result);
    expect(redacted).toEqual(result);
  });

  it('awaiting_approval envelope is unchanged after redactSecrets', async () => {
    const resp = {
      state: 'awaiting_approval',
      handle: 'inv_clean_ap',
      invocation_id: 'inv_clean_ap',
      approval: {
        request_id: 'req_clean_ap',
        risk: 'medium',
        summary: 'Deploy to staging',
        expires_at: '2026-06-22T12:00:00Z',
      },
    };
    const d = makeDeps({ callResp: resp });
    const result = await mxDelegateTool({ ...VALID_INPUT, wait_ms: 0 }, d);
    const redacted = redactSecrets(result);
    expect(redacted).toEqual(result);
  });

  it('error envelope is unchanged after redactSecrets', async () => {
    const d = makeDeps({ callResp: new TransportError('timeout', 'timed out') });
    const result = await mxDelegateTool(VALID_INPUT, d);
    const redacted = redactSecrets(result);
    expect(redacted).toEqual(result);
  });

  it('audit_ref ids (inv_*, req_*, !room:*, $evt_*) are not redacted', async () => {
    const resp = {
      ok: true,
      result: {},
      invocation_id: 'inv_sec_audit',
      request_id: 'req_sec_audit',
      room: '!room:test',
      event_id: '$evt_sec_audit',
    };
    const d = makeDeps({ callResp: resp });
    const result = await mxDelegateTool(VALID_INPUT, d);
    const redacted = redactSecrets(result) as typeof result;
    expect(redacted.audit_ref.invocation_id).toBe('inv_sec_audit');
    expect(redacted.audit_ref.request_id).toBe('req_sec_audit');
    expect(redacted.audit_ref.room).toBe('!room:test');
    expect(redacted.audit_ref.event_id).toBe('$evt_sec_audit');
  });

  it('redactSecrets fires no onRedact callback for a clean resolved envelope', async () => {
    const resp = {
      ok: true,
      result: { count: 1, label: 'success' },
      invocation_id: 'inv_clean_cb',
    };
    const d = makeDeps({ callResp: resp });
    const result = await mxDelegateTool(VALID_INPUT, d);
    const redactedPaths: string[] = [];
    redactSecrets(result, (path) => redactedPaths.push(path));
    expect(redactedPaths).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Immutability — resolved envelopes are deeply frozen
// ---------------------------------------------------------------------------

describe('mx_delegate_tool — resolved envelopes are deeply frozen', () => {
  it('ok envelope is frozen at the top level', async () => {
    const d = makeDeps({ callResp: { ok: true, result: { x: 1 }, invocation_id: 'inv_frz_ok' } });
    const result = await mxDelegateTool(VALID_INPUT, d);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('ok envelope audit_ref is frozen', async () => {
    const d = makeDeps({ callResp: { ok: true, result: {}, invocation_id: 'inv_frz_ar' } });
    const result = await mxDelegateTool(VALID_INPUT, d);
    expect(Object.isFrozen(result.audit_ref)).toBe(true);
  });

  it('running envelope is frozen including audit_ref', async () => {
    const d = makeDeps({ callResp: { state: 'running', handle: 'inv_frz_run', invocation_id: 'inv_frz_run' } });
    const result = await mxDelegateTool({ ...VALID_INPUT, wait_ms: 0 }, d);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.audit_ref)).toBe(true);
  });

  it('awaiting_approval envelope approval block is frozen', async () => {
    const d = makeDeps({
      callResp: {
        state: 'awaiting_approval',
        handle: 'inv_frz_ap',
        invocation_id: 'inv_frz_ap',
        approval: { request_id: 'r', risk: 'low', summary: 's', expires_at: 'e' },
      },
    });
    const result = await mxDelegateTool({ ...VALID_INPUT, wait_ms: 0 }, d);
    expect(Object.isFrozen(result.approval)).toBe(true);
  });

  it('denied envelope is frozen', async () => {
    const d = makeDeps({ callResp: { state: 'policy_denied', invocation_id: 'inv_frz_dn' } });
    const result = await mxDelegateTool(VALID_INPUT, d);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('mutation of a frozen envelope field throws in strict mode', async () => {
    const d = makeDeps({ callResp: { ok: true, result: {}, invocation_id: 'inv_frz_mut' } });
    const result = await mxDelegateTool(VALID_INPUT, d);
    expect(() => {
      (result as unknown as Record<string, unknown>).status = 'error';
    }).toThrow();
  });
});
