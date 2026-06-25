/**
 * Security invariants for the T301 task-DAG handlers (T301 / #30) — design §1,
 * §4.7, §6, §9 ("Don't give cognition any authority surface").
 *
 * Tests pin:
 *  - All three task verbs are in `MODEL_FACING_ALLOWLIST`, not in the
 *    forbidden-authority set, and not governance verbs.
 *  - Input schemas declare no credential-shaped property name (loader-enforced + pinned
 *    here against the toolbelt oracle so regressions fail immediately).
 *  - No output schema declares a credential-shaped property name.
 *  - mxCreateTask / mxUpdateTask fail-fast when room is absent (no room-less mutation).
 *  - error.message is always a fixed, secret-free phrase — never a raw daemon payload,
 *    never an echoed arg value or daemon token.
 *  - No token-shaped value from a daemon response leaks into the returned envelope.
 *  - `task.create` / `task.update` do not call approve/decide/trust/policy methods.
 *  - `mx_list_tasks` DOES NOT fail-fast on an absent room (it is a read, not a mutator).
 *  - Envelopes are validated against ENVELOPE_SCHEMA (all three handlers).
 *  - `redactSecrets` passes the envelopes unchanged (no false-positive redaction).
 *
 * Daemon-free unit tests; no network, no env.
 */
import { describe, expect, it } from 'vitest';

import { TransportError, redactSecrets } from '@mx-loom/toolbelt';
import { CREDENTIAL_KEY_RE as TOOLBELT_CREDENTIAL_KEY_RE } from '@mx-loom/toolbelt';

import {
  CANONICAL_M3_TASK_TOOLS,
  MODEL_FACING_ALLOWLIST,
  MX_CREATE_TASK,
  MX_DISPATCH_TASK,
  MX_LIST_TASKS,
  MX_UPDATE_TASK,
  collectSchemaPropertyNames,
  findCredentialShapedProperty,
  isForbiddenAuthorityVerb,
  mxCreateTask,
  mxDispatchTask,
  mxListTasks,
  mxUpdateTask,
  validateEnvelope,
  type DaemonCall,
  type DispatchDeps,
  type RoomScopedDeps,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOM = '!workspace:homeserver';

const CREATED_TASK = {
  task_id: 'task_sec_1',
  title: 'Security test task',
  state: 'proposed',
  depends_on: [],
  blocks: [],
  action: null,
  audit_ref: {
    invocation_id: 'inv_sec_1',
    request_id: 'req_sec_1',
    room: ROOM,
    event_id: '$sec_evt_1',
  },
};

function makeDaemon(
  response: unknown = CREATED_TASK,
  onCall?: (method: string) => void,
): DaemonCall {
  return {
    async call(method: string): Promise<unknown> {
      onCall?.(method);
      if (response instanceof Error) throw response;
      if (method === 'task.list') return { tasks: [] };
      if (method === 'task.graph') return [];
      return response;
    },
  };
}

function makeDeps(opts?: { room?: string | undefined; daemon?: DaemonCall }): RoomScopedDeps {
  const roomValue =
    opts !== undefined && Object.prototype.hasOwnProperty.call(opts, 'room')
      ? opts.room
      : ROOM;
  return {
    room: roomValue,
    daemon: opts?.daemon ?? makeDaemon(),
  };
}

// ---------------------------------------------------------------------------
// Allowlist + authority invariants
// ---------------------------------------------------------------------------

describe('task verbs — MODEL_FACING_ALLOWLIST membership', () => {
  const allowlist: readonly string[] = MODEL_FACING_ALLOWLIST;

  it('mx_create_task is in MODEL_FACING_ALLOWLIST', () => {
    expect(allowlist).toContain('mx_create_task');
  });

  it('mx_update_task is in MODEL_FACING_ALLOWLIST', () => {
    expect(allowlist).toContain('mx_update_task');
  });

  it('mx_list_tasks is in MODEL_FACING_ALLOWLIST', () => {
    expect(allowlist).toContain('mx_list_tasks');
  });

  it('mx_dispatch_task is in MODEL_FACING_ALLOWLIST', () => {
    expect(allowlist).toContain('mx_dispatch_task');
  });
});

describe('task verbs — not forbidden authority verbs', () => {
  it('mx_create_task is NOT a forbidden authority verb', () => {
    expect(isForbiddenAuthorityVerb(MX_CREATE_TASK.name)).toBe(false);
  });

  it('mx_update_task is NOT a forbidden authority verb', () => {
    expect(isForbiddenAuthorityVerb(MX_UPDATE_TASK.name)).toBe(false);
  });

  it('mx_list_tasks is NOT a forbidden authority verb', () => {
    expect(isForbiddenAuthorityVerb(MX_LIST_TASKS.name)).toBe(false);
  });

  it('mx_dispatch_task is NOT a forbidden authority verb', () => {
    expect(isForbiddenAuthorityVerb(MX_DISPATCH_TASK.name)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Secret-free schema invariants (using the toolbelt oracle)
// ---------------------------------------------------------------------------

describe('task descriptor schemas — secret-free (toolbelt oracle)', () => {
  it('no task input_schema declares a credential-shaped property', () => {
    for (const d of CANONICAL_M3_TASK_TOOLS) {
      const offender = findCredentialShapedProperty(d.input_schema, TOOLBELT_CREDENTIAL_KEY_RE);
      expect(offender, `${d.name}.input_schema must not declare credential-shaped fields`).toBeUndefined();
    }
  });

  it('no task output_schema declares a credential-shaped property', () => {
    for (const d of CANONICAL_M3_TASK_TOOLS) {
      const offender = findCredentialShapedProperty(d.output_schema, TOOLBELT_CREDENTIAL_KEY_RE);
      expect(offender, `${d.name}.output_schema must not declare credential-shaped fields`).toBeUndefined();
    }
  });

  it('no individual property name in any task schema matches the toolbelt credential regex', () => {
    for (const d of CANONICAL_M3_TASK_TOOLS) {
      for (const field of ['input_schema', 'output_schema'] as const) {
        const names = collectSchemaPropertyNames(d[field]);
        for (const name of names) {
          expect(TOOLBELT_CREDENTIAL_KEY_RE.test(name), `${d.name}.${field}.${name} must not be credential-shaped`).toBe(false);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Room provenance — room from session, never from model input
// ---------------------------------------------------------------------------

describe('room provenance — mxCreateTask (mutator, fail-fast)', () => {
  it('fails fast with internal error when room is absent', async () => {
    const result = await mxCreateTask({ title: 'Test' }, makeDeps({ room: undefined }));
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });

  it('fails fast with internal error when room is empty', async () => {
    const result = await mxCreateTask({ title: 'Test' }, makeDeps({ room: '' }));
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });
});

describe('room provenance — mxUpdateTask (mutator, fail-fast)', () => {
  it('fails fast with internal error when room is absent', async () => {
    const result = await mxUpdateTask({ task_id: 'task_x' }, makeDeps({ room: undefined }));
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });
});

describe('room provenance — mxListTasks (read, best-effort — does NOT fail-fast)', () => {
  it('succeeds (ok) when room is absent (best-effort read)', async () => {
    const result = await mxListTasks({}, makeDeps({ room: undefined }));
    expect(result.status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// error.message is always a fixed, secret-free phrase
// ---------------------------------------------------------------------------

describe('task handlers — error.message is secret-free', () => {
  const SENSITIVE = 'mxs_secret_token_do_not_leak';

  it('mxCreateTask: error.message does not echo the daemon payload', async () => {
    const err = new TransportError('rpc', `Raw daemon payload: ${SENSITIVE}`, {
      cause: { error: { code: 'policy_denied', message: `Raw daemon payload: ${SENSITIVE}` } },
    });
    const result = await mxCreateTask({ title: 'Test' }, makeDeps({ daemon: makeDaemon(err) }));
    expect(result.error?.message).not.toContain(SENSITIVE);
  });

  it('mxUpdateTask: error.message does not echo the daemon payload', async () => {
    const err = new TransportError('rpc', `Raw daemon payload: ${SENSITIVE}`, {
      cause: { error: { code: 'untrusted_key', message: `Raw daemon payload: ${SENSITIVE}` } },
    });
    const result = await mxUpdateTask({ task_id: 'task_x' }, makeDeps({ daemon: makeDaemon(err) }));
    expect(result.error?.message).not.toContain(SENSITIVE);
  });

  it('mxCreateTask (room-missing): internal error.message does not contain raw room value', async () => {
    const result = await mxCreateTask({ title: 'Test' }, makeDeps({ room: undefined }));
    expect(result.error?.message).not.toContain('matrix_token');
    expect(result.error?.message).not.toContain('signing_key');
  });
});

// ---------------------------------------------------------------------------
// No authority-mutation RPCs issued by task handlers
// ---------------------------------------------------------------------------

describe('task handlers — no authority-mutation RPCs', () => {
  const FORBIDDEN_METHODS = [
    'trust.publish', 'trust.approve', 'trust.revoke',
    'approval.decide', 'approval.grant',
    'policy.update', 'policy.set',
    'auth.login', 'device.verify.start',
  ];

  it('mxCreateTask never calls an authority-mutation method', async () => {
    const methods: string[] = [];
    const daemon = makeDaemon(CREATED_TASK, (m) => methods.push(m));
    await mxCreateTask(
      { title: 'Test', action: { kind: 'tool', tool: 'run_tests', args: {} } },
      makeDeps({ daemon }),
    );
    for (const forbidden of FORBIDDEN_METHODS) {
      expect(methods).not.toContain(forbidden);
    }
  });

  it('mxUpdateTask never calls an authority-mutation method', async () => {
    const methods: string[] = [];
    const daemon = makeDaemon(CREATED_TASK, (m) => methods.push(m));
    await mxUpdateTask({ task_id: 'task_x', state: 'executing' }, makeDeps({ daemon }));
    for (const forbidden of FORBIDDEN_METHODS) {
      expect(methods).not.toContain(forbidden);
    }
  });

  it('mxListTasks never calls an authority-mutation method', async () => {
    const methods: string[] = [];
    const listDaemon: DaemonCall = {
      async call(method: string): Promise<unknown> {
        methods.push(method);
        if (method === 'task.list') return [];
        if (method === 'task.graph') return [];
        throw new Error(`unexpected: ${method}`);
      },
    };
    await mxListTasks({}, makeDeps({ daemon: listDaemon }));
    for (const forbidden of FORBIDDEN_METHODS) {
      expect(methods).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// invalid_args (credential-shaped action arg rejected)
// ---------------------------------------------------------------------------

describe('mxCreateTask — credential-shaped action arg rejected', () => {
  it('TransportError(invalid_args) from the daemon guard → error(invalid_args)', async () => {
    // The toolbelt's assertNoCredentialShapedArgs rejects credential-shaped values before dispatch.
    // In this daemon-free test we simulate that rejection via a TransportError('invalid_args').
    const err = new TransportError('invalid_args', "refusing to send credential-shaped value: '-H Authorization: Bearer ghp_TOKEN'");
    const result = await mxCreateTask(
      { title: 'Cred injection', action: { kind: 'exec', command: 'curl', command_args: ['-H', 'Authorization: Bearer ghp_TOKEN'] } },
      makeDeps({ daemon: makeDaemon(err) }),
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
    // error.message must not echo the credential-shaped value
    expect(result.error?.message).not.toContain('ghp_TOKEN');
  });
});

// ---------------------------------------------------------------------------
// No secret leaks via daemon response tokens
// ---------------------------------------------------------------------------

describe('task handlers — no secret from daemon response leaks into the result', () => {
  it('mxCreateTask: token-shaped response value does not appear in envelope', async () => {
    const TOKEN = 'mxs_super_secret_matrix_access_token';
    const reply = {
      ...CREATED_TASK,
      // A hypothetical daemon bug that returns a credential in a non-allowlisted field.
      some_internal_field: TOKEN,
    };
    const result = await mxCreateTask({ title: 'Test' }, makeDeps({ daemon: makeDaemon(reply) }));
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// redactSecrets passes ok envelopes unchanged (no false-positive redaction)
// ---------------------------------------------------------------------------

describe('task handlers — redactSecrets does not false-positive on legitimate values', () => {
  it('mxCreateTask ok result passes redactSecrets unchanged', async () => {
    const result = await mxCreateTask({ title: 'Redact check' }, makeDeps());
    const redacted = redactSecrets(result as unknown as Record<string, unknown>) as Record<string, unknown>;
    expect(redacted.status).toBe('ok');
    // audit_ref ids must not be redacted (they are non-secret correlation handles).
    const ar = redacted.audit_ref as Record<string, unknown>;
    expect(ar.invocation_id).toBe('inv_sec_1');
    expect(ar.request_id).toBe('req_sec_1');
  });

  it('mxListTasks ok result passes redactSecrets unchanged', async () => {
    const result = await mxListTasks({}, makeDeps());
    const redacted = redactSecrets(result as unknown as Record<string, unknown>) as Record<string, unknown>;
    expect(redacted.status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// All envelopes validate against ENVELOPE_SCHEMA
// ---------------------------------------------------------------------------

describe('task handlers — all result envelopes pass ENVELOPE_SCHEMA', () => {
  it('mxCreateTask ok', async () => {
    const result = await mxCreateTask({ title: 'Schema check' }, makeDeps());
    expect(validateEnvelope(result)).toBe(true);
  });

  it('mxCreateTask denied', async () => {
    const err = new TransportError('rpc', 'err', { cause: { error: { code: 'policy_denied' } } });
    const result = await mxCreateTask({ title: 'Denied' }, makeDeps({ daemon: makeDaemon(err) }));
    expect(validateEnvelope(result)).toBe(true);
  });

  it('mxCreateTask error (room missing)', async () => {
    const result = await mxCreateTask({ title: 'No room' }, makeDeps({ room: undefined }));
    expect(validateEnvelope(result)).toBe(true);
  });

  it('mxUpdateTask ok', async () => {
    const result = await mxUpdateTask({ task_id: 'task_x', state: 'executing' }, makeDeps());
    expect(validateEnvelope(result)).toBe(true);
  });

  it('mxListTasks ok (graph)', async () => {
    const result = await mxListTasks({}, makeDeps());
    expect(validateEnvelope(result)).toBe(true);
  });

  it('mxListTasks ok (list)', async () => {
    const result = await mxListTasks({ view: 'list' }, makeDeps());
    expect(validateEnvelope(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mx_dispatch_task — allowlist / authority / descriptor invariants
// ---------------------------------------------------------------------------

describe('mx_dispatch_task — descriptor security invariants', () => {
  it('MX_DISPATCH_TASK.input_schema declares no credential-shaped property (toolbelt oracle)', () => {
    const offender = findCredentialShapedProperty(MX_DISPATCH_TASK.input_schema, TOOLBELT_CREDENTIAL_KEY_RE);
    expect(offender).toBeUndefined();
  });

  it('MX_DISPATCH_TASK.output_schema declares no credential-shaped property', () => {
    const offender = findCredentialShapedProperty(MX_DISPATCH_TASK.output_schema, TOOLBELT_CREDENTIAL_KEY_RE);
    expect(offender).toBeUndefined();
  });

  it('all property names in MX_DISPATCH_TASK schemas do not match TOOLBELT_CREDENTIAL_KEY_RE', () => {
    for (const field of ['input_schema', 'output_schema'] as const) {
      const names = collectSchemaPropertyNames(MX_DISPATCH_TASK[field]);
      for (const name of names) {
        expect(TOOLBELT_CREDENTIAL_KEY_RE.test(name), `dispatch_task.${field}.${name}`).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// mxDispatchTask — room provenance and no-authority-mutation checks
// ---------------------------------------------------------------------------

// A minimal multi-method daemon for mxDispatchTask security tests.
const SEC_DISPATCH_TASK_ID = 'task_sec_dispatch_01';
const SEC_AGENT_ID = 'ag_sec_dispatch_01';

const secDispatchTaskRaw = {
  task_id: SEC_DISPATCH_TASK_ID,
  title: 'Dispatch security test',
  state: 'assigned',
  assignee: SEC_AGENT_ID,
  depends_on: [],
  blocks: [],
  action: { kind: 'tool', tool: 'run_tests', args: {} },
};

const secDispatchToolsResponse = {
  agent_id: SEC_AGENT_ID,
  kind: 'worker',
  status: 'online',
  capabilities: [],
  tools: ['run_tests'],
  schemas: [{
    name: 'run_tests',
    version: '1.0.0',
    description: 'Test runner',
    input_schema: { type: 'object', additionalProperties: true },
    output_schema: { type: 'object', additionalProperties: true },
  }],
};

function makeDispatchSecDaemon(
  onMethod?: (method: string) => void,
  callError?: Error,
): DaemonCall {
  return {
    async call(method: string): Promise<unknown> {
      onMethod?.(method);
      if (method === 'task.list') return [secDispatchTaskRaw];
      if (method === 'task.graph') return [];
      if (method === 'agent.tools') return secDispatchToolsResponse;
      if (method === 'call.start') {
        if (callError) throw callError;
        return {
          ok: true,
          result: { passed: 5 },
          invocation_id: 'inv_sec_d_01',
          request_id: 'req_sec_d_01',
          room: ROOM,
          event_id: '$sec_d_evt_01',
        };
      }
      if (method === 'exec.start') return { ok: true, result: { exit_code: 0 }, invocation_id: 'inv_sec_exec_01', request_id: 'req_sec_exec_01', room: ROOM, event_id: '$sec_exec_01' };
      throw new Error(`unexpected method in security test: ${method}`);
    },
  };
}

function makeDispatchSecDeps(opts: {
  room?: string | undefined;
  onMethod?: (method: string) => void;
  callError?: Error;
} = {}): DispatchDeps {
  const roomValue = Object.prototype.hasOwnProperty.call(opts, 'room') ? opts.room : ROOM;
  return {
    room: roomValue,
    daemon: makeDispatchSecDaemon(opts.onMethod, opts.callError),
  };
}

describe('mxDispatchTask — room provenance (security)', () => {
  it('fails fast with internal error when room is absent (no daemon call)', async () => {
    const methods: string[] = [];
    const result = await mxDispatchTask(
      { task_id: SEC_DISPATCH_TASK_ID },
      makeDispatchSecDeps({ room: undefined, onMethod: (m) => methods.push(m) }),
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expect(methods).toHaveLength(0);
  });

  it('error.message does not contain raw room or credential values', async () => {
    const result = await mxDispatchTask(
      { task_id: SEC_DISPATCH_TASK_ID },
      makeDispatchSecDeps({ room: undefined }),
    );
    expect(result.error?.message).not.toContain('matrix_token');
    expect(result.error?.message).not.toContain('signing_key');
  });
});

describe('mxDispatchTask — no authority-mutation RPCs (security)', () => {
  const FORBIDDEN_METHODS = [
    'trust.publish', 'trust.approve', 'trust.revoke',
    'approval.decide', 'approval.grant',
    'policy.update', 'policy.set',
    'auth.login', 'device.verify.start',
  ];

  it('never calls an authority-mutation method', async () => {
    const methods: string[] = [];
    await mxDispatchTask(
      { task_id: SEC_DISPATCH_TASK_ID },
      makeDispatchSecDeps({ onMethod: (m) => methods.push(m) }),
    );
    for (const forbidden of FORBIDDEN_METHODS) {
      expect(methods, `must not call ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('mxDispatchTask — error.message is secret-free (security)', () => {
  it('denied error.message does not echo the raw daemon payload', async () => {
    const SENSITIVE = 'mxs_sec_signing_key_do_not_leak';
    const err = new TransportError('rpc', SENSITIVE, {
      cause: { error: { code: 'policy_denied', message: SENSITIVE } },
    });
    const result = await mxDispatchTask(
      { task_id: SEC_DISPATCH_TASK_ID },
      makeDispatchSecDeps({ callError: err }),
    );
    expect(result.error?.message).not.toContain(SENSITIVE);
  });
});

describe('mxDispatchTask — all result envelopes pass ENVELOPE_SCHEMA', () => {
  it('mxDispatchTask ok', async () => {
    const result = await mxDispatchTask({ task_id: SEC_DISPATCH_TASK_ID }, makeDispatchSecDeps());
    expect(validateEnvelope(result)).toBe(true);
  });

  it('mxDispatchTask denied (policy_denied)', async () => {
    const err = new TransportError('rpc', 'err', { cause: { error: { code: 'policy_denied' } } });
    const result = await mxDispatchTask({ task_id: SEC_DISPATCH_TASK_ID }, makeDispatchSecDeps({ callError: err }));
    expect(validateEnvelope(result)).toBe(true);
  });

  it('mxDispatchTask error (room missing)', async () => {
    const result = await mxDispatchTask({ task_id: SEC_DISPATCH_TASK_ID }, makeDispatchSecDeps({ room: undefined }));
    expect(validateEnvelope(result)).toBe(true);
  });
});
