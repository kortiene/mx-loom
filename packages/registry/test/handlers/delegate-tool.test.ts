/**
 * `mxDelegateTool` handler — AC 1–3, deferred dispositions, idempotency,
 * inline wait_ms, robustness, and `callResponseToResult` (T105 / #13).
 *
 * Tests pin:
 * - Phase 0: absent/empty room → internal, no daemon calls made.
 * - Phase 1: unknown agent → not_found; unknown tool name → not_found;
 *            name@version mismatch → not_found; malformed agent.tools → not_found.
 * - AC 2: invalid args (missing/wrong-type/extra prop) → invalid_args BEFORE
 *         call.start is dispatched (spy assertion); absent/malformed input_schema
 *         → validation skipped, dispatch proceeds.
 * - AC 1: synchronous ok response → status:ok, inner payload, populated audit_ref.
 * - AC 3: policy_denied / untrusted_key rpc error → denied with the right code;
 *         call.start returns ok:false → denied; transport timeout → errored.
 * - Deferred: call.start running → status:running, handle; awaiting_approval →
 *             status:awaiting_approval, approval block (fail-safe high risk default).
 * - Idempotency: caller-supplied key forwarded verbatim; absent → generated
 *                idk_<uuid>; call.start params include room/agent/tool/args/key.
 * - Phase 5: wait_ms=0 → no mxAwaitResult composition; wait_ms>0 + deferred →
 *            composes mxAwaitResult; wait_ms expiry → pending (not errored timeout).
 * - Robustness: malformed CallResponse (null/scalar/array/empty) → internal;
 *               every output validates ENVELOPE_SCHEMA; handler never throws.
 * - callResponseToResult: success signal (ok:true / bare result), handle-only
 *   running, error signal, parity with invocationToResult for shared state tokens.
 *
 * Pure unit tests; injected DaemonCall, fake/real validator — no daemon, no socket.
 */
import { describe, expect, it } from 'vitest';

import { TransportError } from '@mx-loom/toolbelt';

import {
  callResponseToResult,
  invocationToResult,
  mxDelegateTool,
  validateEnvelope,
  type DaemonCall,
  type DelegateDeps,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const AGENT_ID = 'ag_target_01';
const TOOL_NAME = 'run_tests';
const TOOL_VERSION = '1.0.0';
const TOOL_REF = `${TOOL_NAME}@${TOOL_VERSION}`;
const ROOM = '!workspace:homeserver';

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    suite: { type: 'string' },
    verbose: { type: 'boolean' },
  },
  required: ['suite'],
  additionalProperties: false,
} as const;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { passed: { type: 'number' }, failed: { type: 'number' } },
} as const;

const TOOLS_RESPONSE = {
  agent_id: AGENT_ID,
  kind: 'worker',
  status: 'online',
  capabilities: ['code_execution'],
  tools: ['run_tests'],
  schemas: [
    {
      name: TOOL_NAME,
      version: TOOL_VERSION,
      description: 'Run the test suite',
      input_schema: INPUT_SCHEMA,
      output_schema: OUTPUT_SCHEMA,
    },
  ],
};

const VALID_ARGS = { suite: 'unit' };

const SYNC_OK_RESPONSE = {
  ok: true,
  result: { passed: 10, failed: 0 },
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
    risk: 'medium',
    summary: 'Approve running tests',
    expires_at: '2026-06-22T14:00:00Z',
  },
};

const noSleep = async (_ms: number): Promise<void> => {};
const nowZero = () => 0;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a `DelegateDeps` with per-method fake daemon responses. Tracks all
 * calls for spy assertions. Throws on any unexpected method call.
 */
function makeDeps(opts: {
  toolsResp?: unknown;
  callResp?: unknown;
  /** Response for `invocation.get` (used when mxAwaitResult is composed). */
  invGetResp?: unknown;
  room?: string;
  validator?: DelegateDeps['validator'];
  sleep?: DelegateDeps['sleep'];
  now?: DelegateDeps['now'];
  pollIntervalMs?: number;
}): DelegateDeps & {
  readonly calls: Array<{ method: string; params: unknown }>;
  callCount(method: string): number;
} {
  const calls: Array<{ method: string; params: unknown }> = [];

  const daemon: DaemonCall = {
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === 'agent.tools') {
        const r = opts.toolsResp;
        if (r instanceof Error) throw r;
        if (r === undefined) throw new Error('Unexpected agent.tools call (no toolsResp)');
        return r;
      }
      if (method === 'call.start') {
        const r = opts.callResp;
        if (r instanceof Error) throw r;
        if (r === undefined) throw new Error('Unexpected call.start call (no callResp)');
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
    validator: opts.validator,
    sleep: opts.sleep ?? noSleep,
    now: opts.now ?? nowZero,
    pollIntervalMs: opts.pollIntervalMs ?? 50,
    calls,
    callCount: (method: string) => calls.filter((c) => c.method === method).length,
  };
  return deps;
}

/** Fake validator — compile always succeeds, validate always returns true. */
const alwaysValidValidator: DelegateDeps['validator'] = {
  compile: () => {
    const fn = (_data: unknown): boolean => true;
    (fn as { errors?: unknown }).errors = undefined;
    return fn as ReturnType<NonNullable<DelegateDeps['validator']>['compile']>;
  },
};

/** Fake validator — compile succeeds, validate always returns false. */
const alwaysInvalidValidator: DelegateDeps['validator'] = {
  compile: () => {
    const fn = (_data: unknown): boolean => false;
    (fn as { errors?: unknown }).errors = [{ message: 'fake validation error' }];
    return fn as ReturnType<NonNullable<DelegateDeps['validator']>['compile']>;
  },
};

/** Fake validator — compile always throws (simulates malformed input_schema). */
const compilingFailsValidator: DelegateDeps['validator'] = {
  compile: () => { throw new Error('Malformed schema — cannot compile'); },
};

function te(code: string, message = 'error', cause?: unknown): TransportError {
  return new TransportError(
    code as 'rpc',
    message,
    cause !== undefined ? { cause } : undefined,
  );
}

function rpcDaemonError(code: string): TransportError {
  return te('rpc', `rpc error: ${code}`, { error: { code } });
}

function expectValid(result: unknown): void {
  const ok = validateEnvelope(result);
  expect(ok, `envelope invalid: ${JSON.stringify((validateEnvelope as { errors?: unknown }).errors)}`).toBe(true);
}

// ---------------------------------------------------------------------------
// Phase 0 — room provenance
// ---------------------------------------------------------------------------

describe('mxDelegateTool — Phase 0: room provenance', () => {
  it('absent room → internal, zero daemon calls', async () => {
    const d = makeDeps({ room: undefined });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expect(d.calls).toHaveLength(0);
    expectValid(result);
  });

  it('empty string room → internal, zero daemon calls', async () => {
    const d = makeDeps({ room: '' });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expect(d.calls).toHaveLength(0);
    expectValid(result);
  });

  it('absent room never dispatches agent.tools or call.start', async () => {
    const d = makeDeps({ room: undefined });
    await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    expect(d.callCount('agent.tools')).toBe(0);
    expect(d.callCount('call.start')).toBe(0);
  });

  it('absent room: audit_ref is all-null (no round-trip)', async () => {
    const d = makeDeps({ room: undefined });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    expect(result.audit_ref.invocation_id).toBeNull();
    expect(result.audit_ref.request_id).toBeNull();
    expect(result.audit_ref.room).toBeNull();
    expect(result.audit_ref.event_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase 1 — tool lookup
// ---------------------------------------------------------------------------

describe('mxDelegateTool — Phase 1: tool lookup via agent.tools', () => {
  it('agent.tools called with the correct agent_id param', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: SYNC_OK_RESPONSE,
      validator: alwaysValidValidator,
    });
    await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_NAME, args: VALID_ARGS }, d);
    const call = d.calls.find((c) => c.method === 'agent.tools');
    expect(call?.params).toEqual({ agent_id: AGENT_ID });
  });

  it('unknown agent (rpc/unknown_agent) → not_found, call.start NOT called', async () => {
    const d = makeDeps({
      toolsResp: te('rpc', 'unknown', { error: { code: 'unknown_agent' } }),
    });
    const result = await mxDelegateTool({ agent: 'ag_unknown', tool: TOOL_NAME, args: VALID_ARGS }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
    expect(d.callCount('call.start')).toBe(0);
    expectValid(result);
  });

  it('transport timeout on agent.tools → errored("timeout")', async () => {
    const d = makeDeps({ toolsResp: te('timeout', 'timed out') });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_NAME, args: VALID_ARGS }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('timeout');
    expect(d.callCount('call.start')).toBe(0);
    expectValid(result);
  });

  it('plain Error on agent.tools → internal', async () => {
    const d = makeDeps({ toolsResp: new Error('network failure') });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_NAME, args: VALID_ARGS }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expect(d.callCount('call.start')).toBe(0);
  });

  it('tool name not published by the agent → not_found', async () => {
    const d = makeDeps({ toolsResp: TOOLS_RESPONSE });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: 'unknown_tool', args: VALID_ARGS }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
    expect(d.callCount('call.start')).toBe(0);
    expectValid(result);
  });

  it('name@version mismatch → not_found', async () => {
    const d = makeDeps({ toolsResp: TOOLS_RESPONSE });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: `${TOOL_NAME}@2.0.0`, args: VALID_ARGS }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
    expect(d.callCount('call.start')).toBe(0);
  });

  it('bare tool name (no @version) matches regardless of published version', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: SYNC_OK_RESPONSE,
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_NAME, args: VALID_ARGS }, d);
    expect(result.status).toBe('ok');
    expect(d.callCount('call.start')).toBe(1);
  });

  it('name@version exact match proceeds to dispatch', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: SYNC_OK_RESPONSE,
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    expect(result.status).toBe('ok');
    expect(d.callCount('call.start')).toBe(1);
  });

  it('agent.tools returns null (malformed) → not_found', async () => {
    const d = makeDeps({ toolsResp: null });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_NAME, args: VALID_ARGS }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
    expect(d.callCount('call.start')).toBe(0);
  });

  it('agent.tools returns empty schemas array → not_found', async () => {
    const d = makeDeps({ toolsResp: { agent_id: AGENT_ID, schemas: [] } });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_NAME, args: VALID_ARGS }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
  });

  it('agent.tools response with no schemas field → not_found', async () => {
    const d = makeDeps({ toolsResp: { agent_id: AGENT_ID, kind: 'worker' } });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_NAME, args: VALID_ARGS }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
  });

  it('pre-dispatch failure audit_ref is all-null (no Matrix round-trip yet)', async () => {
    const d = makeDeps({ toolsResp: TOOLS_RESPONSE });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: 'no_such_tool', args: VALID_ARGS }, d);
    expect(result.error?.code).toBe('not_found');
    expect(result.audit_ref.invocation_id).toBeNull();
    expect(result.audit_ref.request_id).toBeNull();
    expect(result.audit_ref.room).toBeNull();
    expect(result.audit_ref.event_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC 2 — invalid args rejected before dispatch
// ---------------------------------------------------------------------------

describe('mxDelegateTool — AC 2: invalid args rejected before call.start', () => {
  it('missing required property → invalid_args, call.start NOT called', async () => {
    const d = makeDeps({ toolsResp: TOOLS_RESPONSE });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: {} }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
    expect(d.callCount('call.start')).toBe(0);
    expectValid(result);
  });

  it('wrong type for required property → invalid_args, call.start NOT called', async () => {
    const d = makeDeps({ toolsResp: TOOLS_RESPONSE });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: { suite: 42 } }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
    expect(d.callCount('call.start')).toBe(0);
  });

  it('extra property when additionalProperties:false → invalid_args, call.start NOT called', async () => {
    const d = makeDeps({ toolsResp: TOOLS_RESPONSE });
    const result = await mxDelegateTool(
      { agent: AGENT_ID, tool: TOOL_REF, args: { suite: 'unit', extra: 'oops' } },
      d,
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
    expect(d.callCount('call.start')).toBe(0);
  });

  it('fake validator that always rejects → invalid_args, call.start NOT called', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      validator: alwaysInvalidValidator,
    });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
    expect(d.callCount('call.start')).toBe(0);
  });

  it('absent input_schema → validation skipped, dispatch proceeds normally', async () => {
    const toolsNoSchema = {
      ...TOOLS_RESPONSE,
      schemas: [{ name: TOOL_NAME, version: TOOL_VERSION }],
    };
    const d = makeDeps({ toolsResp: toolsNoSchema, callResp: SYNC_OK_RESPONSE });
    const result = await mxDelegateTool(
      { agent: AGENT_ID, tool: TOOL_REF, args: { completely: 'arbitrary' } },
      d,
    );
    expect(result.status).toBe('ok');
    expect(d.callCount('call.start')).toBe(1);
  });

  it('malformed input_schema (compile throws) → validation skipped, dispatch proceeds', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: SYNC_OK_RESPONSE,
      validator: compilingFailsValidator,
    });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    expect(result.status).toBe('ok');
    expect(d.callCount('call.start')).toBe(1);
  });

  it('invalid_args audit_ref is all-null (rejected before any round-trip)', async () => {
    const d = makeDeps({ toolsResp: TOOLS_RESPONSE });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: {} }, d);
    expect(result.error?.code).toBe('invalid_args');
    expect(result.audit_ref.invocation_id).toBeNull();
    expect(result.audit_ref.request_id).toBeNull();
    expect(result.audit_ref.room).toBeNull();
    expect(result.audit_ref.event_id).toBeNull();
  });

  it('invalid_args error.message is the fixed secret-free phrase (not arg values)', async () => {
    const d = makeDeps({ toolsResp: TOOLS_RESPONSE });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: {} }, d);
    expect(result.error?.code).toBe('invalid_args');
    expect(result.error?.message).toBe('the request was rejected as invalid');
  });
});

// ---------------------------------------------------------------------------
// AC 1 — valid call returns ok with populated audit_ref
// ---------------------------------------------------------------------------

describe('mxDelegateTool — AC 1: valid call returns ok envelope', () => {
  it('synchronous ok response (ok:true + result) → status: ok', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: SYNC_OK_RESPONSE,
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    expect(result.status).toBe('ok');
    expect(result.error).toBeNull();
    expect(result.handle).toBeNull();
    expect(result.approval).toBeNull();
    expectValid(result);
  });

  it('ok result carries the inner tool payload', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: SYNC_OK_RESPONSE,
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    expect(result.result).toEqual({ passed: 10, failed: 0 });
  });

  it('ok envelope carries populated audit_ref ids from the CallResponse', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: SYNC_OK_RESPONSE,
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    expect(result.audit_ref.invocation_id).toBe('inv_ok_01');
    expect(result.audit_ref.request_id).toBe('req_ok_01');
    expect(result.audit_ref.room).toBe(ROOM);
    expect(result.audit_ref.event_id).toBe('$evt_ok_01');
  });

  it('state-token "completed" response → status: ok', async () => {
    const resp = { state: 'completed', result: { passed: 5, failed: 0 }, invocation_id: 'inv_comp_01' };
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: resp,
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    expect(result.status).toBe('ok');
    expect(result.result).toEqual({ passed: 5, failed: 0 });
  });

  it('state-token "succeeded" response → status: ok', async () => {
    const resp = { state: 'succeeded', result: { x: 1 }, invocation_id: 'inv_succ_01' };
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: resp,
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    expect(result.status).toBe('ok');
    expectValid(result);
  });

  it('bare result object (no ok flag, no state) → status: ok via callResponseToResult success signal', async () => {
    const resp = { result: { passed: 3, failed: 0 }, invocation_id: 'inv_bare_01' };
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: resp,
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    expect(result.status).toBe('ok');
    expect(result.result).toEqual({ passed: 3, failed: 0 });
  });
});

// ---------------------------------------------------------------------------
// AC 3 — policy-denied and governance outcomes
// ---------------------------------------------------------------------------

describe('mxDelegateTool — AC 3: policy denied / governance outcomes', () => {
  it('call.start rpc error policy_denied → denied("policy_denied")', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: rpcDaemonError('policy_denied'),
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
    expectValid(result);
  });

  it('call.start rpc error untrusted_key → denied("untrusted_key")', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: rpcDaemonError('untrusted_key'),
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('untrusted_key');
    expectValid(result);
  });

  it('call.start rpc error approval_denied → denied("approval_denied")', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: rpcDaemonError('approval_denied'),
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('approval_denied');
  });

  it('call.start returns { ok:false, error:{code:policy_denied} } → denied', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: { ok: false, error: { code: 'policy_denied' } },
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
    expectValid(result);
  });

  it('call.start state "policy_denied" → denied("policy_denied")', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: { state: 'policy_denied', invocation_id: 'inv_pd_01' },
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
  });

  it('call.start state "untrusted_key" → denied("untrusted_key")', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: { state: 'untrusted_key', invocation_id: 'inv_uk_01' },
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('untrusted_key');
    expectValid(result);
  });

  it('call.start transport timeout → errored("timeout")', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: te('timeout', 'socket timed out'),
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('timeout');
    expectValid(result);
  });

  it('call.start transport not_running → errored("internal")', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: te('not_running'),
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });

  it('call.start plain Error → errored("internal")', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: new Error('unexpected'),
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });

  it('call.start rpc + target_offline daemon cause → errored("target_offline")', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: te('rpc', 'rpc err', { error: { code: 'target_offline' } }),
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('target_offline');
  });
});

// ---------------------------------------------------------------------------
// Deferred dispositions
// ---------------------------------------------------------------------------

describe('mxDelegateTool — deferred dispositions', () => {
  it('call.start running response → status: running, handle set', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: RUNNING_RESPONSE,
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool(
      { agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS, wait_ms: 0 },
      d,
    );
    expect(result.status).toBe('running');
    expect(result.handle).toBe('inv_run_01');
    expect(result.error).toBeNull();
    expect(result.result).toBeNull();
    expect(result.approval).toBeNull();
    expectValid(result);
  });

  it('running response carries populated audit_ref from the CallResponse', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: RUNNING_RESPONSE,
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool(
      { agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS, wait_ms: 0 },
      d,
    );
    expect(result.audit_ref.invocation_id).toBe('inv_run_01');
    expect(result.audit_ref.request_id).toBe('req_run_01');
    expect(result.audit_ref.room).toBe(ROOM);
    expect(result.audit_ref.event_id).toBe('$evt_run_01');
  });

  it('call.start awaiting_approval response → status: awaiting_approval, approval set', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: AWAITING_RESPONSE,
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool(
      { agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS, wait_ms: 0 },
      d,
    );
    expect(result.status).toBe('awaiting_approval');
    expect(result.handle).toBe('inv_ap_01');
    expect(result.approval).not.toBeNull();
    expect(result.approval?.request_id).toBe('apr_01');
    expect(result.approval?.risk).toBe('medium');
    expect(result.approval?.summary).toBe('Approve running tests');
    expect(result.error).toBeNull();
    expect(result.result).toBeNull();
    expectValid(result);
  });

  it('awaiting_approval without approval block gets fail-safe high risk defaults', async () => {
    const awaiting = { state: 'awaiting_approval', handle: 'inv_ap_02', invocation_id: 'inv_ap_02' };
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: awaiting,
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool(
      { agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS, wait_ms: 0 },
      d,
    );
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
// Idempotency (Phase 3)
// ---------------------------------------------------------------------------

describe('mxDelegateTool — idempotency', () => {
  it('caller-supplied idempotency_key is forwarded verbatim in call.start params', async () => {
    const MY_KEY = 'idk_my-own-key-12345';
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: SYNC_OK_RESPONSE,
      validator: alwaysValidValidator,
    });
    await mxDelegateTool(
      { agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS, idempotency_key: MY_KEY },
      d,
    );
    const callStart = d.calls.find((c) => c.method === 'call.start');
    expect((callStart?.params as Record<string, unknown>)?.idempotency_key).toBe(MY_KEY);
  });

  it('absent idempotency_key → a generated key starting with "idk_" is supplied', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: SYNC_OK_RESPONSE,
      validator: alwaysValidValidator,
    });
    await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    const callStart = d.calls.find((c) => c.method === 'call.start');
    const key = (callStart?.params as Record<string, unknown>)?.idempotency_key;
    expect(typeof key).toBe('string');
    expect((key as string).startsWith('idk_')).toBe(true);
  });

  it('call.start params include room, agent, tool, args, idempotency_key', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: SYNC_OK_RESPONSE,
      validator: alwaysValidValidator,
    });
    await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    const callStart = d.calls.find((c) => c.method === 'call.start');
    const p = callStart?.params as Record<string, unknown>;
    expect(p).toBeDefined();
    expect(p?.room).toBe(ROOM);
    expect(p?.agent).toBe(AGENT_ID);
    expect(p?.tool).toBe(TOOL_REF);
    expect(p?.args).toEqual(VALID_ARGS);
    expect(typeof p?.idempotency_key).toBe('string');
  });

  it('tool ref including @version is forwarded verbatim to call.start', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: SYNC_OK_RESPONSE,
      validator: alwaysValidValidator,
    });
    await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    const callStart = d.calls.find((c) => c.method === 'call.start');
    expect((callStart?.params as Record<string, unknown>)?.tool).toBe(TOOL_REF);
  });

  it('two independent calls get distinct generated keys', async () => {
    const makeCall = async () => {
      const d = makeDeps({
        toolsResp: TOOLS_RESPONSE,
        callResp: SYNC_OK_RESPONSE,
        validator: alwaysValidValidator,
      });
      await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
      return (d.calls.find((c) => c.method === 'call.start')?.params as Record<string, unknown>)?.idempotency_key as string;
    };
    const key1 = await makeCall();
    const key2 = await makeCall();
    expect(key1).not.toBe(key2);
  });
});

// ---------------------------------------------------------------------------
// Phase 5 — inline wait_ms
// ---------------------------------------------------------------------------

describe('mxDelegateTool — Phase 5: inline wait_ms', () => {
  it('wait_ms=0 with deferred response → returns pending directly, no invocation.get', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: RUNNING_RESPONSE,
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool(
      { agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS, wait_ms: 0 },
      d,
    );
    expect(result.status).toBe('running');
    expect(d.callCount('invocation.get')).toBe(0);
  });

  it('terminal response + wait_ms>0 → no mxAwaitResult composition (returns directly)', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: SYNC_OK_RESPONSE,
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool(
      { agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS, wait_ms: 5000 },
      d,
    );
    expect(result.status).toBe('ok');
    expect(d.callCount('invocation.get')).toBe(0);
  });

  it('deferred response + wait_ms>0 + poll resolves terminal → returns terminal', async () => {
    let callStartDone = false;
    const daemon: DaemonCall = {
      call: async (method) => {
        if (method === 'agent.tools') return TOOLS_RESPONSE;
        if (method === 'call.start') { callStartDone = true; return RUNNING_RESPONSE; }
        if (method === 'invocation.get' && callStartDone) {
          return { state: 'completed', result: { passed: 5 }, invocation_id: 'inv_run_01' };
        }
        throw new Error(`Unexpected: ${method}`);
      },
    };
    const result = await mxDelegateTool(
      { agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS, wait_ms: 5000 },
      {
        daemon,
        room: ROOM,
        validator: alwaysValidValidator,
        sleep: noSleep,
        now: () => 0,
        pollIntervalMs: 50,
      },
    );
    expect(result.status).toBe('ok');
    expect(result.result).toEqual({ passed: 5 });
    expectValid(result);
  });

  it('deferred + wait_ms>0 budget expires → pending envelope, error:null (never errored timeout)', async () => {
    const daemon: DaemonCall = {
      call: async (method) => {
        if (method === 'agent.tools') return TOOLS_RESPONSE;
        if (method === 'call.start') return RUNNING_RESPONSE;
        if (method === 'invocation.get') return {
          state: 'running', handle: 'inv_run_01', invocation_id: 'inv_run_01',
        };
        throw new Error(`Unexpected: ${method}`);
      },
    };
    let t = 0;
    const result = await mxDelegateTool(
      { agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS, wait_ms: 50 },
      {
        daemon,
        room: ROOM,
        validator: alwaysValidValidator,
        sleep: noSleep,
        now: () => (t += 200), // clock jumps past budget fast
        pollIntervalMs: 50,
      },
    );
    // AC 3 from T103: wait_ms expiry → pending, error:null, NOT errored('timeout')
    expect(result.status).toBe('running');
    expect(result.error).toBeNull();
    expectValid(result);
  });

  it('awaiting_approval + wait_ms>0 budget expires → awaiting_approval returned, not error', async () => {
    const daemon: DaemonCall = {
      call: async (method) => {
        if (method === 'agent.tools') return TOOLS_RESPONSE;
        if (method === 'call.start') return AWAITING_RESPONSE;
        if (method === 'invocation.get') return {
          state: 'awaiting_approval',
          handle: 'inv_ap_01',
          invocation_id: 'inv_ap_01',
          approval: { request_id: 'apr_01', risk: 'medium', summary: 'Approve', expires_at: '2026-06-22T14:00:00Z' },
        };
        throw new Error(`Unexpected: ${method}`);
      },
    };
    let t = 0;
    const result = await mxDelegateTool(
      { agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS, wait_ms: 50 },
      {
        daemon,
        room: ROOM,
        validator: alwaysValidValidator,
        sleep: noSleep,
        now: () => (t += 200),
        pollIntervalMs: 50,
      },
    );
    expect(result.status).toBe('awaiting_approval');
    expect(result.error).toBeNull();
    expectValid(result);
  });
});

// ---------------------------------------------------------------------------
// Robustness — handler never throws, every output validates ENVELOPE_SCHEMA
// ---------------------------------------------------------------------------

describe('mxDelegateTool — robustness / never-throws', () => {
  it('malformed CallResponse (null) → internal, never throws', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: null,
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('malformed CallResponse (scalar 42) → internal', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: 42,
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('malformed CallResponse (array) → internal', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: [],
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('malformed CallResponse (empty object) → internal', async () => {
    const d = makeDeps({
      toolsResp: TOOLS_RESPONSE,
      callResp: {},
      validator: alwaysValidValidator,
    });
    const result = await mxDelegateTool({ agent: AGENT_ID, tool: TOOL_REF, args: VALID_ARGS }, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('all error paths produce a valid ENVELOPE_SCHEMA output', async () => {
    type Scenario = { toolsResp: unknown; callResp?: unknown; args?: Record<string, unknown>; room?: string };
    const scenarios: Scenario[] = [
      { toolsResp: null },
      { toolsResp: TOOLS_RESPONSE, callResp: null },
      { toolsResp: TOOLS_RESPONSE, callResp: {} },
      { toolsResp: TOOLS_RESPONSE, callResp: SYNC_OK_RESPONSE, args: {} },
      { toolsResp: TOOLS_RESPONSE, callResp: SYNC_OK_RESPONSE, room: '' },
    ];
    for (const { toolsResp, callResp, args, room } of scenarios) {
      const d = makeDeps({ toolsResp, callResp, validator: alwaysValidValidator, room });
      const result = await mxDelegateTool(
        { agent: AGENT_ID, tool: TOOL_REF, args: args ?? VALID_ARGS },
        d,
      );
      expectValid(result);
    }
  });
});

// ---------------------------------------------------------------------------
// callResponseToResult — synchronous success signal (the call.start-specific case)
// ---------------------------------------------------------------------------

describe('callResponseToResult — synchronous success signal', () => {
  it('{ ok: true, result: {...} } → status: ok', () => {
    const r = callResponseToResult({ ok: true, result: { x: 1 } });
    expect(r.status).toBe('ok');
    expect(r.result).toEqual({ x: 1 });
    expectValid(r);
  });

  it('{ result: { x: 1 } } (no ok flag, no state) → status: ok via success signal', () => {
    const r = callResponseToResult({ result: { x: 1 } });
    expect(r.status).toBe('ok');
    expect(r.result).toEqual({ x: 1 });
    expectValid(r);
  });

  it('ok:true + handle → success signal wins over handle-only running', () => {
    const r = callResponseToResult({ ok: true, result: { y: 2 }, handle: 'inv_h' });
    expect(r.status).toBe('ok');
  });

  it('{ handle: "inv_h" } (no state, no ok, no error) → status: running', () => {
    const r = callResponseToResult({ handle: 'inv_h', invocation_id: 'inv_h' });
    expect(r.status).toBe('running');
    expect(r.handle).toBe('inv_h');
    expectValid(r);
  });

  it('handle-only running carries populated audit_ref', () => {
    const r = callResponseToResult({
      handle: 'inv_h',
      invocation_id: 'inv_h',
      request_id: 'req_h',
      room: '!room:x',
      event_id: '$evt_h',
    });
    expect(r.status).toBe('running');
    expect(r.audit_ref.invocation_id).toBe('inv_h');
    expect(r.audit_ref.request_id).toBe('req_h');
    expect(r.audit_ref.room).toBe('!room:x');
    expect(r.audit_ref.event_id).toBe('$evt_h');
  });

  it('error signal wins over success signal: { ok:false, error:{code:policy_denied} } → denied', () => {
    const r = callResponseToResult({ ok: false, error: { code: 'policy_denied' } });
    expect(r.status).toBe('denied');
    expect(r.error?.code).toBe('policy_denied');
    expectValid(r);
  });

  it('{ ok:false } with no code → internal (error signal, no specific code)', () => {
    const r = callResponseToResult({ ok: false });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('internal');
    expectValid(r);
  });

  it('empty object {} (no state, no handle, no ok) → internal', () => {
    const r = callResponseToResult({});
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('internal');
    expectValid(r);
  });

  it('null → internal (consistent with invocationToResult)', () => {
    const r = callResponseToResult(null);
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('internal');
    expectValid(r);
  });

  it('array → internal (consistent with invocationToResult)', () => {
    const r = callResponseToResult([]);
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('internal');
    expectValid(r);
  });

  it('never throws on any input', () => {
    for (const input of [null, undefined, '', 0, false, {}, [], { ok: true }, 'xyz']) {
      expect(() => callResponseToResult(input)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// callResponseToResult — parity with invocationToResult for shared state tokens
// ---------------------------------------------------------------------------

describe('callResponseToResult — parity with invocationToResult for shared state tokens', () => {
  const SHARED_CASES: Array<{ raw: Record<string, unknown>; label: string }> = [
    { raw: { state: 'running', handle: 'h' }, label: 'running' },
    { raw: { state: 'in_flight', handle: 'h' }, label: 'in_flight' },
    { raw: { state: 'executing', handle: 'h' }, label: 'executing' },
    { raw: { state: 'awaiting_approval', handle: 'h', approval: { request_id: 'r', risk: 'low', summary: 's', expires_at: 'e' } }, label: 'awaiting_approval' },
    { raw: { state: 'held', handle: 'h' }, label: 'held' },
    { raw: { state: 'completed', result: {} }, label: 'completed' },
    { raw: { state: 'succeeded', result: {} }, label: 'succeeded' },
    { raw: { state: 'done', result: {} }, label: 'done' },
    { raw: { state: 'policy_denied' }, label: 'policy_denied' },
    { raw: { state: 'untrusted_key' }, label: 'untrusted_key' },
    { raw: { state: 'approval_denied' }, label: 'approval_denied' },
    { raw: { state: 'approval_expired' }, label: 'approval_expired' },
    { raw: { state: 'failed' }, label: 'failed' },
    { raw: { state: 'not_found' }, label: 'not_found' },
    { raw: { state: 'target_offline' }, label: 'target_offline' },
    { raw: { state: 'timeout' }, label: 'timeout' },
  ];

  for (const { raw, label } of SHARED_CASES) {
    it(`state "${label}" → same status as invocationToResult`, () => {
      const r1 = callResponseToResult(raw);
      const r2 = invocationToResult(raw);
      expect(r1.status).toBe(r2.status);
    });

    it(`state "${label}" → same error code as invocationToResult`, () => {
      const r1 = callResponseToResult(raw);
      const r2 = invocationToResult(raw);
      expect(r1.error?.code).toBe(r2.error?.code);
    });
  }

  it('all shared-token outputs from callResponseToResult validate ENVELOPE_SCHEMA', () => {
    for (const { raw } of SHARED_CASES) {
      expectValid(callResponseToResult(raw));
    }
  });
});
