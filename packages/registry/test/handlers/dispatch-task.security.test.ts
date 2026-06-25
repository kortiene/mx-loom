/**
 * Security invariants for `mx_dispatch_task` and `mxDispatchTask` (T303 / #32) —
 * design §1, §5, §6, §9 ("Don't give cognition any authority surface").
 *
 * Tests pin:
 *  - `mx_dispatch_task` is in `MODEL_FACING_ALLOWLIST` (it is a request-producing verb).
 *  - `mx_dispatch_task` is NOT a forbidden authority verb.
 *  - `MX_DISPATCH_TASK.async_semantics === 'deferred'` (dispatched actions are approval-gatable).
 *  - `MX_DISPATCH_TASK.input_schema` declares no credential-shaped property name.
 *  - Room provenance: `mxDispatchTask` fails fast with `internal` when room is absent — the
 *    DAG is workspace-scoped; the model must never supply a Matrix room id.
 *  - No authority-mutation RPCs: `mxDispatchTask` never calls `trust.*`, `approval.decide`,
 *    `policy.*`, `auth.*`, `device.*`, or `daemon.*`.
 *  - error.message is always a fixed, secret-free phrase (never echoes raw daemon payload).
 *  - No token-shaped value from a daemon response leaks into the returned envelope.
 *  - All result envelopes validate against ENVELOPE_SCHEMA.
 *  - `mxDispatchTask` is a request-producer only — it makes no trust/policy/approval decision
 *    in-process; `policy_denied` / `untrusted_key` are receiver verdicts, never self-decisions.
 *
 * Daemon-free unit tests; no network, no env.
 */
import { describe, expect, it } from 'vitest';

import { TransportError, redactSecrets } from '@mx-loom/toolbelt';
import { CREDENTIAL_KEY_RE as TOOLBELT_CREDENTIAL_KEY_RE } from '@mx-loom/toolbelt';

import {
  CANONICAL_M3_TASK_TOOLS,
  MODEL_FACING_ALLOWLIST,
  MX_DISPATCH_TASK,
  collectSchemaPropertyNames,
  findCredentialShapedProperty,
  isForbiddenAuthorityVerb,
  mxDispatchTask,
  validateEnvelope,
  type DaemonCall,
  type DispatchDeps,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOM = '!workspace:homeserver';
const AGENT_ID = 'ag_sec_worker_01';
const TOOL_NAME = 'run_tests';
const TASK_ID = 'task_sec_01';

const TASK_TOOL_RAW = {
  task_id: TASK_ID,
  title: 'Security test task',
  state: 'assigned',
  assignee: AGENT_ID,
  depends_on: [],
  blocks: [],
  action: { kind: 'tool', tool: TOOL_NAME, args: {} },
};

const TASK_EXEC_RAW = {
  task_id: 'task_sec_exec_01',
  title: 'Security exec task',
  state: 'assigned',
  assignee: AGENT_ID,
  depends_on: [],
  blocks: [],
  action: { kind: 'exec', command: 'make', command_args: [], cwd: '/repo' },
};

const TOOLS_RESPONSE = {
  agent_id: AGENT_ID,
  kind: 'worker',
  status: 'online',
  capabilities: [],
  tools: [TOOL_NAME],
  schemas: [
    {
      name: TOOL_NAME,
      version: '1.0.0',
      description: 'Run tests',
      input_schema: { type: 'object', additionalProperties: true },
      output_schema: { type: 'object', additionalProperties: true },
    },
  ],
};

const OK_CALL_RESPONSE = {
  ok: true,
  result: { passed: 10 },
  invocation_id: 'inv_sec_01',
  request_id: 'req_sec_01',
  room: ROOM,
  event_id: '$sec_evt_01',
};

const OK_EXEC_RESPONSE = {
  ok: true,
  result: { exit_code: 0 },
  invocation_id: 'inv_sec_exec_01',
  request_id: 'req_sec_exec_01',
  room: ROOM,
  event_id: '$sec_exec_evt_01',
};

function makeSecDaemon(opts: {
  tasks?: unknown[];
  onMethod?: (method: string) => void;
  callError?: Error;
} = {}): DaemonCall {
  const taskList = opts.tasks ?? [TASK_TOOL_RAW, TASK_EXEC_RAW];
  return {
    async call(method: string): Promise<unknown> {
      opts.onMethod?.(method);
      if (method === 'task.list') return taskList;
      if (method === 'task.graph') return [];
      if (method === 'agent.tools') return TOOLS_RESPONSE;
      if (method === 'call.start') {
        if (opts.callError) throw opts.callError;
        return OK_CALL_RESPONSE;
      }
      if (method === 'exec.start') return OK_EXEC_RESPONSE;
      throw new Error(`unexpected method in security test: ${method}`);
    },
  };
}

function makeSecDeps(opts: {
  room?: string | undefined;
  tasks?: unknown[];
  onMethod?: (method: string) => void;
  callError?: Error;
} = {}): DispatchDeps {
  const roomValue = Object.prototype.hasOwnProperty.call(opts, 'room') ? opts.room : ROOM;
  return {
    room: roomValue,
    daemon: makeSecDaemon(opts),
  };
}

// ---------------------------------------------------------------------------
// Allowlist + no-authority invariants
// ---------------------------------------------------------------------------

describe('mx_dispatch_task — MODEL_FACING_ALLOWLIST membership', () => {
  it('mx_dispatch_task is in MODEL_FACING_ALLOWLIST', () => {
    const allowlist: readonly string[] = MODEL_FACING_ALLOWLIST;
    expect(allowlist).toContain('mx_dispatch_task');
  });
});

describe('mx_dispatch_task — not a forbidden authority verb', () => {
  it('mx_dispatch_task is NOT a forbidden authority verb', () => {
    expect(isForbiddenAuthorityVerb('mx_dispatch_task')).toBe(false);
  });

  it('MX_DISPATCH_TASK.name passes isForbiddenAuthorityVerb as false', () => {
    expect(isForbiddenAuthorityVerb(MX_DISPATCH_TASK.name)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Descriptor security invariants
// ---------------------------------------------------------------------------

describe('MX_DISPATCH_TASK descriptor — security invariants', () => {
  it('is async_semantics: deferred (dispatched actions are approval-gatable)', () => {
    expect(MX_DISPATCH_TASK.async_semantics).toBe('deferred');
  });

  it('input_schema declares no credential-shaped property name (toolbelt oracle)', () => {
    const offender = findCredentialShapedProperty(MX_DISPATCH_TASK.input_schema, TOOLBELT_CREDENTIAL_KEY_RE);
    expect(offender).toBeUndefined();
  });

  it('output_schema declares no credential-shaped property name', () => {
    const offender = findCredentialShapedProperty(MX_DISPATCH_TASK.output_schema, TOOLBELT_CREDENTIAL_KEY_RE);
    expect(offender).toBeUndefined();
  });

  it('no individual property name in input_schema matches the credential regex', () => {
    const names = collectSchemaPropertyNames(MX_DISPATCH_TASK.input_schema);
    for (const name of names) {
      expect(TOOLBELT_CREDENTIAL_KEY_RE.test(name), `input_schema.${name} must not be credential-shaped`).toBe(false);
    }
  });

  it('is in CANONICAL_M3_TASK_TOOLS (the 4th task verb)', () => {
    expect(CANONICAL_M3_TASK_TOOLS).toContain(MX_DISPATCH_TASK);
  });
});

// ---------------------------------------------------------------------------
// Room provenance — room from session, never from model input
// ---------------------------------------------------------------------------

describe('mxDispatchTask — room provenance', () => {
  it('fails fast with internal error when room is absent (no daemon call)', async () => {
    const methods: string[] = [];
    const result = await mxDispatchTask(
      { task_id: TASK_ID },
      makeSecDeps({ room: undefined, onMethod: (m) => methods.push(m) }),
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expect(methods).toHaveLength(0);
  });

  it('fails fast with internal error when room is empty string (no daemon call)', async () => {
    const methods: string[] = [];
    const result = await mxDispatchTask(
      { task_id: TASK_ID },
      makeSecDeps({ room: '', onMethod: (m) => methods.push(m) }),
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expect(methods).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// No authority-mutation RPCs issued by mxDispatchTask
// ---------------------------------------------------------------------------

describe('mxDispatchTask — no authority-mutation RPCs', () => {
  const FORBIDDEN_METHODS = [
    'trust.publish', 'trust.approve', 'trust.revoke',
    'approval.decide', 'approval.grant',
    'policy.update', 'policy.set',
    'auth.login', 'device.verify.start',
    'cross_signing.upload', 'recovery.create',
    'daemon.stop',
  ];

  it('never calls an authority-mutation method for a tool action dispatch', async () => {
    const methods: string[] = [];
    await mxDispatchTask(
      { task_id: TASK_ID },
      makeSecDeps({ onMethod: (m) => methods.push(m) }),
    );
    for (const forbidden of FORBIDDEN_METHODS) {
      expect(methods, `must not call ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('never calls an authority-mutation method for an exec action dispatch', async () => {
    const methods: string[] = [];
    await mxDispatchTask(
      { task_id: 'task_sec_exec_01' },
      makeSecDeps({ onMethod: (m) => methods.push(m) }),
    );
    for (const forbidden of FORBIDDEN_METHODS) {
      expect(methods, `must not call ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('never calls an authority-mutation method when the room is missing (early exit)', async () => {
    const methods: string[] = [];
    await mxDispatchTask(
      { task_id: TASK_ID },
      makeSecDeps({ room: undefined, onMethod: (m) => methods.push(m) }),
    );
    for (const forbidden of FORBIDDEN_METHODS) {
      expect(methods, `must not call ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// error.message is always a fixed, secret-free phrase (no raw payload echoing)
// ---------------------------------------------------------------------------

describe('mxDispatchTask — error.message is secret-free', () => {
  const SENSITIVE = 'mxs_super_secret_signing_key_do_not_leak';

  it('denied error.message never echoes the raw daemon payload', async () => {
    const err = new TransportError('rpc', SENSITIVE, {
      cause: { error: { code: 'policy_denied', message: SENSITIVE } },
    });
    const result = await mxDispatchTask(
      { task_id: TASK_ID },
      makeSecDeps({ callError: err }),
    );
    expect(result.status).toBe('denied');
    expect(result.error?.message).not.toContain(SENSITIVE);
  });

  it('internal error.message (room missing) does not contain raw room value', async () => {
    const result = await mxDispatchTask(
      { task_id: TASK_ID },
      makeSecDeps({ room: undefined }),
    );
    expect(result.error?.message).not.toContain('matrix_token');
    expect(result.error?.message).not.toContain('signing_key');
    expect(result.error?.message).not.toContain(SENSITIVE);
  });
});

// ---------------------------------------------------------------------------
// No daemon response token leaks into the returned envelope
// ---------------------------------------------------------------------------

describe('mxDispatchTask — no secret from daemon response leaks into the envelope', () => {
  it('token-shaped internal field in a daemon task.list response never reaches the envelope', async () => {
    const TOKEN = 'mxs_super_secret_matrix_access_token';
    const taskWithToken = {
      ...TASK_TOOL_RAW,
      some_internal_daemon_field: TOKEN,
    };
    const daemon: DaemonCall = {
      async call(method: string): Promise<unknown> {
        if (method === 'task.list') return [taskWithToken];
        if (method === 'agent.tools') return TOOLS_RESPONSE;
        if (method === 'call.start') return OK_CALL_RESPONSE;
        return undefined;
      },
    };
    const result = await mxDispatchTask({ task_id: TASK_ID }, { room: ROOM, daemon });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// redactSecrets does not false-positive on legitimate values
// ---------------------------------------------------------------------------

describe('mxDispatchTask — redactSecrets does not false-positive on ok envelopes', () => {
  it('ok result from a tool dispatch passes redactSecrets unchanged', async () => {
    const result = await mxDispatchTask({ task_id: TASK_ID }, makeSecDeps());
    const redacted = redactSecrets(result as unknown as Record<string, unknown>) as Record<string, unknown>;
    expect(redacted.status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// All envelopes validate against ENVELOPE_SCHEMA
// ---------------------------------------------------------------------------

describe('mxDispatchTask — all result envelopes pass ENVELOPE_SCHEMA', () => {
  it('ok result (tool dispatch)', async () => {
    const result = await mxDispatchTask({ task_id: TASK_ID }, makeSecDeps());
    expect(validateEnvelope(result)).toBe(true);
  });

  it('denied result (policy_denied)', async () => {
    const err = new TransportError('rpc', 'err', { cause: { error: { code: 'policy_denied' } } });
    const result = await mxDispatchTask({ task_id: TASK_ID }, makeSecDeps({ callError: err }));
    expect(validateEnvelope(result)).toBe(true);
  });

  it('error result (room missing)', async () => {
    const result = await mxDispatchTask({ task_id: TASK_ID }, makeSecDeps({ room: undefined }));
    expect(validateEnvelope(result)).toBe(true);
  });

  it('error result (task not found)', async () => {
    const result = await mxDispatchTask({ task_id: 'task_nonexistent' }, makeSecDeps({ tasks: [] }));
    expect(validateEnvelope(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mxDispatchTask is a request-producer, not a policy enforcer (G3)
// ---------------------------------------------------------------------------

describe('mxDispatchTask — request-producer invariant (G3)', () => {
  it('policy_denied originates from the receiver, not an in-process check', async () => {
    // The dispatch handler does NOT check policy itself; it only surfaces the receiver's verdict.
    // A denied result must have status: denied (not error: internal), proving it came from the callee.
    const err = new TransportError('rpc', 'rpc error', { cause: { error: { code: 'policy_denied' } } });
    const result = await mxDispatchTask({ task_id: TASK_ID }, makeSecDeps({ callError: err }));
    expect(result.status).toBe('denied');
    // status: denied is the receiver verdict; status: error would be a self-decision
    expect(result.status).not.toBe('error');
  });

  it('untrusted_key originates from the receiver, not an in-process trust check', async () => {
    const err = new TransportError('rpc', 'rpc error', { cause: { error: { code: 'untrusted_key' } } });
    const result = await mxDispatchTask({ task_id: TASK_ID }, makeSecDeps({ callError: err }));
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('untrusted_key');
  });
});
