/**
 * Security invariants for the `mx_run_command` handler (T106 / #14) — design §1,
 * §4.7, §6, §9 ("Don't give cognition any authority surface"). This issue is
 * `area/policy` precisely because the entire guard lives **outside** mx-loom: the
 * handler emits a signed request and faithfully surfaces the receiver's verdict.
 *
 * Tests pin:
 * - `mx_run_command` is in `MODEL_FACING_ALLOWLIST` and NOT a forbidden authority
 *   verb (it emits a signed request; it does not mutate trust/policy/approval).
 * - `RunCommandInput` shape has no credential-shaped or authority-mutation field,
 *   and no `room` field (room is injected via deps, never model input).
 * - The handler emits ONLY `exec.start` (+ `invocation.get` on an inline wait) —
 *   no approve/decide/trust/policy/sandbox method ever dispatched.
 * - A credential-shaped `command`/`args` **value** or param **key** surfaces as
 *   `invalid_args` through the REAL toolbelt guard run at the registry boundary
 *   (`assertNoCredentialShapedArgs`, exactly what `MxClient.call` runs pre-dispatch).
 * - A token-shaped value in a daemon `summary`/`log_ref` is redacted inbound
 *   (`redactSecrets`, exactly what `MxClient.call` runs at its exit point).
 * - `error.message` is always a fixed, secret-free phrase — never the command, an
 *   arg value, a cwd, or a raw daemon payload.
 * - Result envelopes are deeply frozen and pass `redactSecrets` unchanged.
 *
 * Pure unit tests; injected DaemonCall — no daemon, no socket, no env.
 */
import { describe, expect, it } from 'vitest';

import { TransportError, assertNoCredentialShapedArgs, redactSecrets } from '@mx-loom/toolbelt';

import {
  MX_RUN_COMMAND,
  MODEL_FACING_ALLOWLIST,
  isForbiddenAuthorityVerb,
  mxRunCommand,
  validateEnvelope,
  type DaemonCall,
  type ExecDeps,
  type RunCommandInput,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENT_ID = 'ag_sec_01';
const COMMAND = 'pytest';
const ROOM = '!workspace:homeserver';

const noSleep = async (_ms: number): Promise<void> => {};
const nowZero = () => 0;

/**
 * A fake daemon that mirrors the production `MxClient.call` secret boundary: it runs
 * the REAL `assertNoCredentialShapedArgs` over the params BEFORE "dispatch" and
 * `redactSecrets` over the result at its single exit point (T008). So a
 * credential-shaped value/key the handler forwards is rejected exactly as it would
 * be over a real transport, and a token-shaped daemon value is scrubbed inbound —
 * without a socket. This is the registry-boundary representation of the guard.
 */
function makeGuardedDeps(opts: { execResp?: unknown }): ExecDeps & { methods: string[] } {
  const methods: string[] = [];
  const daemon: DaemonCall = {
    call: async (method, params) => {
      methods.push(method);
      assertNoCredentialShapedArgs(params); // throws TransportError('invalid_args')
      if (method === 'exec.start') {
        const r = opts.execResp ?? { ok: true, result: { exit_code: 0 }, invocation_id: 'inv_sec_01' };
        if (r instanceof Error) throw r;
        return redactSecrets(r);
      }
      throw new Error(`Security test: unexpected method "${method}"`);
    },
  };
  return { daemon, room: ROOM, sleep: noSleep, now: nowZero, methods };
}

/** A plain fake daemon (no guard) for non-credential assertions. */
function makeDeps(opts: { execResp?: unknown; onCall?: (method: string) => void }): ExecDeps & { methods: string[] } {
  const methods: string[] = [];
  const daemon: DaemonCall = {
    call: async (method, _params) => {
      methods.push(method);
      opts.onCall?.(method);
      if (method === 'exec.start') {
        const r = opts.execResp ?? { ok: true, result: { exit_code: 0 }, invocation_id: 'inv_sec_01' };
        if (r instanceof Error) throw r;
        return r;
      }
      throw new Error(`Security test: unexpected method "${method}"`);
    },
  };
  return { daemon, room: ROOM, sleep: noSleep, now: nowZero, methods };
}

const VALID_INPUT: RunCommandInput = { agent: AGENT_ID, command: COMMAND, args: ['-q'] };

function expectValid(result: unknown): void {
  expect(
    validateEnvelope(result),
    `envelope invalid: ${JSON.stringify((validateEnvelope as { errors?: unknown }).errors)}`,
  ).toBe(true);
}

// ---------------------------------------------------------------------------
// No-authority invariant — allowlist and forbidden-verb checks
// ---------------------------------------------------------------------------

describe('mx_run_command — no-authority allowlist invariants', () => {
  it('mx_run_command is in MODEL_FACING_ALLOWLIST', () => {
    expect(MODEL_FACING_ALLOWLIST).toContain('mx_run_command');
  });

  it('mx_run_command is NOT a forbidden authority verb', () => {
    expect(isForbiddenAuthorityVerb('mx_run_command')).toBe(false);
  });

  it('MX_RUN_COMMAND descriptor name is "mx_run_command"', () => {
    expect(MX_RUN_COMMAND.name).toBe('mx_run_command');
  });

  it('MX_RUN_COMMAND is not prefixed with a forbidden authority prefix', () => {
    const FORBIDDEN_PREFIXES = ['trust.', 'policy.', 'auth.', 'device.', 'cross_signing.', 'recovery.', 'daemon.'];
    for (const prefix of FORBIDDEN_PREFIXES) {
      expect(MX_RUN_COMMAND.name.startsWith(prefix)).toBe(false);
    }
  });

  it('MX_RUN_COMMAND declares no "guarded" hint (guarded-ness is receiver policy)', () => {
    expect((MX_RUN_COMMAND as unknown as Record<string, unknown>).guarded).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Secret-free input shape — RunCommandInput has no credential/authority field
// ---------------------------------------------------------------------------

describe('mx_run_command — RunCommandInput has no credential-shaped field', () => {
  it('input keys have no "token"-suffix field', () => {
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

  it('input has no approve/decide/grant/trust authority field', () => {
    const authority = ['approve', 'decide', 'grant', 'trust', 'cancel', 'reject'];
    for (const key of Object.keys(VALID_INPUT)) {
      expect(authority.includes(key)).toBe(false);
    }
  });

  it('input has no "room" field — room is injected via deps, not model input', () => {
    expect(Object.prototype.hasOwnProperty.call(VALID_INPUT, 'room')).toBe(false);
  });

  it('the descriptor input_schema declares no credential-shaped property', () => {
    const props = Object.keys(
      (MX_RUN_COMMAND.input_schema as { properties: Record<string, unknown> }).properties,
    );
    const forbidden = /(?:secret|password|passwd|api[_-]?key|signing[_-]?key|private[_-]?key|matrix_|mx_agent_|gh[_-]?token|(?:^|[_-])token$)/i;
    for (const p of props) {
      // idempotency_key is a dedup nonce, not a credential — and the boundaried
      // `token$` rule deliberately accepts it. Everything else must be clean too.
      expect(forbidden.test(p)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// RPC method discipline — only exec.start (+ invocation.get on wait) dispatched
// ---------------------------------------------------------------------------

describe('mx_run_command — RPC method discipline', () => {
  it('only exec.start is called on a successful synchronous run', async () => {
    const d = makeDeps({});
    await mxRunCommand(VALID_INPUT, d);
    expect(d.methods).toEqual(['exec.start']);
  });

  it('no approve, decide, cancel, trust, or policy method is ever dispatched', async () => {
    const FORBIDDEN_METHODS = [
      'approve', 'approval.decide', 'approval.approve', 'approval.reject',
      'trust.add', 'trust.remove', 'policy.update', 'policy.deny',
      'invocation.cancel', 'invocation.approve', 'exec.cancel',
    ];
    const d = makeDeps({ execResp: { state: 'running', handle: 'inv_x', invocation_id: 'inv_x' } });
    await mxRunCommand({ ...VALID_INPUT, wait_ms: 0 }, d);
    for (const m of d.methods) {
      expect(FORBIDDEN_METHODS.includes(m)).toBe(false);
    }
  });

  it('on room absence, exec.start is never dispatched', async () => {
    const d = makeDeps({});
    const dNoRoom = { ...d, room: undefined };
    await mxRunCommand(VALID_INPUT, dNoRoom as ExecDeps);
    expect(d.methods).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Credential-shaped command/args → invalid_args (the REAL guard, registry boundary)
// ---------------------------------------------------------------------------

describe('mx_run_command — credential-shaped command/args surface as invalid_args', () => {
  it('a Bearer-token arg VALUE is rejected by the real guard → invalid_args envelope', async () => {
    const d = makeGuardedDeps({});
    const result = await mxRunCommand(
      { agent: AGENT_ID, command: 'curl', args: ['-H', 'sk-ant-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'] },
      d,
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
    expect(d.methods).toContain('exec.start'); // guard fires inside the dispatch path
    expectValid(result);
  });

  it('a ghp_ token passed as an arg value is rejected → invalid_args', async () => {
    // The value guard is anchored (^): a token must START the value (an embedded
    // substring in a URL passes by design). A model inlining a bare token as an arg
    // is exactly the case the guard catches.
    const d = makeGuardedDeps({});
    const result = await mxRunCommand(
      { agent: AGENT_ID, command: 'git', args: ['clone', 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'] },
      d,
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
  });

  it('a PEM private-key header in args is rejected → invalid_args', async () => {
    const d = makeGuardedDeps({});
    const result = await mxRunCommand(
      { agent: AGENT_ID, command: 'echo', args: ['-----BEGIN OPENSSH PRIVATE KEY-----'] },
      d,
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
  });

  it('TransportError("invalid_args") from exec.start → invalid_args envelope (registry boundary)', async () => {
    const d = makeDeps({ execResp: new TransportError('invalid_args', 'credential-shaped arg rejected') });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
    expectValid(result);
  });

  it('invalid_args error.message is the fixed phrase, never the rejected value', async () => {
    const d = makeGuardedDeps({});
    const result = await mxRunCommand(
      { agent: AGENT_ID, command: 'curl', args: ['-H', 'sk-ant-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'] },
      d,
    );
    expect(result.error?.message).toBe('the request was rejected as invalid');
    expect(JSON.stringify(result)).not.toContain('sk-ant-');
  });

  it('a clean command/args passes the guard and runs normally', async () => {
    const d = makeGuardedDeps({});
    const result = await mxRunCommand({ agent: AGENT_ID, command: 'pytest', args: ['-q', 'tests/'] }, d);
    expect(result.status).toBe('ok');
    expectValid(result);
  });
});

// ---------------------------------------------------------------------------
// Secret-free output — no token-shaped value leaks into the envelope
// ---------------------------------------------------------------------------

describe('mx_run_command — secret-free envelope output', () => {
  it('a token-shaped value in summary/log_ref is redacted inbound (via the guarded path)', async () => {
    // redactSecrets matches the value shape (^-anchored): a daemon bug returning a
    // bare token-shaped value is scrubbed to the placeholder before it reaches here.
    const d = makeGuardedDeps({
      execResp: {
        ok: true,
        result: { exit_code: 0, summary: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', log_ref: 'ctx_01' },
        invocation_id: 'inv_leak_01',
      },
    });
    const result = await mxRunCommand(VALID_INPUT, d);
    const json = JSON.stringify(result);
    expect(json).not.toContain('ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(json).toContain('«redacted»');
    expectValid(result);
  });

  it('error.message for a denial is a fixed phrase — never a raw daemon payload', async () => {
    const leakyError = new TransportError('rpc', 'syt_AAAAAAAAAAAAAAAAAAAAAA in daemon error', {
      cause: { error: { code: 'policy_denied', message: 'syt_AAAAAAAAAAAAAAAAAAAAAA leaked' } },
    });
    const d = makeDeps({ execResp: leakyError });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.error?.message).not.toContain('syt_AAAAAAAAAAAAAAAAAAAAAA');
    expect(result.error?.message).toBe('denied by the receiver policy');
  });

  it('error.message never echoes the command or args', async () => {
    const d = makeDeps({ execResp: { state: 'failed', rawPayload: 'sk-ant-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } });
    const result = await mxRunCommand({ agent: AGENT_ID, command: 'secret-binary', args: ['--flag'] }, d);
    expect(result.error?.message).not.toContain('secret-binary');
    expect(result.error?.message).not.toContain('--flag');
    expect(result.error?.message).not.toContain('sk-ant-');
    expect(result.error?.message).not.toContain('rawPayload');
  });

  it('a token-shaped value in an unexpected daemon field does not appear in the envelope (via guarded path)', async () => {
    const d = makeGuardedDeps({
      execResp: {
        ok: true,
        result: { exit_code: 0 },
        invocation_id: 'inv_leak_02',
        __unexpected: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
    });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(JSON.stringify(result)).not.toContain('ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  });

  it('approval.summary is passed through but exposes only the four documented fields', async () => {
    const awaitingWithExtras = {
      state: 'awaiting_approval',
      handle: 'inv_ap_sec_01',
      invocation_id: 'inv_ap_sec_01',
      approval: {
        request_id: 'req_ap_sec_01',
        risk: 'high',
        summary: 'Approve running the build',
        expires_at: '2026-06-22T14:00:00Z',
        secret_token: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        __raw_daemon: 'should_be_stripped',
      },
    };
    const d = makeDeps({ execResp: awaitingWithExtras });
    const result = await mxRunCommand({ ...VALID_INPUT, wait_ms: 0 }, d);
    expect(result.status).toBe('awaiting_approval');
    const approvalKeys = Object.keys(result.approval ?? {});
    expect(approvalKeys.sort()).toEqual(['expires_at', 'request_id', 'risk', 'summary']);
    expect(approvalKeys).not.toContain('secret_token');
    expect(approvalKeys).not.toContain('__raw_daemon');
  });
});

// ---------------------------------------------------------------------------
// redactSecrets pass-through + immutability on resolved envelopes
// ---------------------------------------------------------------------------

describe('mx_run_command — redactSecrets pass-through and immutability', () => {
  it('ok envelope with non-secret result is unchanged after redactSecrets', async () => {
    const d = makeDeps({
      execResp: {
        ok: true,
        result: { exit_code: 0, summary: 'all green', log_ref: 'ctx_clean' },
        invocation_id: 'inv_clean_ok',
        request_id: 'req_clean_ok',
        room: ROOM,
        event_id: '$evt_clean_ok',
      },
    });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(result.status).toBe('ok');
    expect(redactSecrets(result)).toEqual(result);
  });

  it('audit_ref ids (inv_*, req_*, !room:*, $evt_*) are not redacted', async () => {
    const d = makeDeps({
      execResp: {
        ok: true,
        result: { exit_code: 0 },
        invocation_id: 'inv_sec_audit',
        request_id: 'req_sec_audit',
        room: '!room:test',
        event_id: '$evt_sec_audit',
      },
    });
    const result = await mxRunCommand(VALID_INPUT, d);
    const redacted = redactSecrets(result) as typeof result;
    expect(redacted.audit_ref.invocation_id).toBe('inv_sec_audit');
    expect(redacted.audit_ref.request_id).toBe('req_sec_audit');
    expect(redacted.audit_ref.room).toBe('!room:test');
    expect(redacted.audit_ref.event_id).toBe('$evt_sec_audit');
  });

  it('ok envelope is deeply frozen', async () => {
    const d = makeDeps({ execResp: { ok: true, result: { exit_code: 0 }, invocation_id: 'inv_frz' } });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.audit_ref)).toBe(true);
  });

  it('mutation of a frozen envelope field throws in strict mode', async () => {
    const d = makeDeps({ execResp: { ok: true, result: { exit_code: 0 }, invocation_id: 'inv_frz_mut' } });
    const result = await mxRunCommand(VALID_INPUT, d);
    expect(() => {
      (result as unknown as Record<string, unknown>).status = 'error';
    }).toThrow();
  });
});
