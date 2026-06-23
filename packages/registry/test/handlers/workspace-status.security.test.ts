/**
 * Security invariants for the `mx_workspace_status` handler (T108 / #16) — design
 * §1, §4.7, §6, §9.
 *
 * Tests pin:
 * - **Headline**: the verified `workspace.status` reply carries
 *   `members[{ user_id, display_name, membership }]` — raw Matrix user ids. The
 *   handler's `projectWorkspaceMeta` (allowlist-by-construction) deliberately drops
 *   the entire `members[]` array. A workspace.status reply with members is fed in
 *   and the test asserts NO Matrix identifier appears anywhere in the ok.result.
 * - Matrix identity fields from agent rows (matrix_user_id, device_id,
 *   signing_key_id, signing_public_key) are also absent: `projectAgentSummary`
 *   copies only agent_id, kind, capabilities, liveness.
 * - `mx_workspace_status` is in `MODEL_FACING_ALLOWLIST` and is NOT a forbidden
 *   authority verb.
 * - The input schema declares no model-facing fields (no room, no credential).
 * - Only `workspace.status` and `agent.list` are dispatched — no approve/trust/
 *   cancel/policy method is ever emitted.
 * - `error.message` is the fixed, secret-free phrase — never a raw daemon payload.
 * - Ok envelopes are deeply frozen and pass `redactSecrets` unchanged.
 *
 * Pure unit tests; injected DaemonCall — no daemon, no socket, no env.
 */
import { describe, expect, it } from 'vitest';

import { redactSecrets, TransportError } from '@mx-loom/toolbelt';

import {
  MX_WORKSPACE_STATUS,
  MODEL_FACING_ALLOWLIST,
  isForbiddenAuthorityVerb,
  mxWorkspaceStatus,
  validateEnvelope,
  type DaemonCall,
  type RoomScopedDeps,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOM = '!workspace:homeserver';

function makeDeps(opts: {
  statusResp?: unknown;
  agentListResp?: unknown;
  room?: string;
}): RoomScopedDeps & { methods: string[] } {
  const methods: string[] = [];
  const daemon: DaemonCall = {
    call: async (method, _params) => {
      methods.push(method);
      if (method === 'workspace.status') {
        const r = opts.statusResp;
        if (r instanceof Error) throw r;
        return r;
      }
      if (method === 'agent.list') {
        const r = opts.agentListResp ?? [];
        if (r instanceof Error) throw r;
        return r;
      }
      throw new Error(`Security test: unexpected method "${method}"`);
    },
  };
  return { daemon, room: opts.room ?? ROOM, methods };
}

function expectValid(result: unknown): void {
  expect(
    validateEnvelope(result),
    `envelope invalid: ${JSON.stringify((validateEnvelope as { errors?: unknown }).errors)}`,
  ).toBe(true);
}

// ---------------------------------------------------------------------------
// Headline security test: Matrix members[] NOT surfaced (the load-bearing redaction)
// ---------------------------------------------------------------------------

describe('mx_workspace_status — headline: Matrix members[] NOT surfaced', () => {
  /**
   * The verified workspace.status reply carries members[{ user_id, display_name,
   * membership }]. The handler MUST NOT surface any of these in ok.result.
   * This is the "load-bearing redaction decision" per the spec §Security.
   */
  const STATUS_WITH_MEMBERS = {
    room_id: ROOM,
    name: 'Secure Workspace',
    canonical_alias: '#sec:homeserver',
    encrypted: true,
    joined_members: 3,
    members: [
      { user_id: '@alice:homeserver', display_name: 'Alice', membership: 'join' },
      { user_id: '@bob:homeserver', display_name: 'Bob', membership: 'join' },
      { user_id: '@charlie:homeserver', display_name: 'Charlie', membership: 'invite' },
    ],
  };

  it('members[] is NOT present anywhere in the ok result (JSON scan)', async () => {
    const d = makeDeps({ statusResp: STATUS_WITH_MEMBERS, agentListResp: [] });
    const result = await mxWorkspaceStatus({}, d);
    expect(result.status).toBe('ok');
    const json = JSON.stringify(result);
    expect(json).not.toContain('"members"');
    expectValid(result);
  });

  it('Matrix user_id values are absent from the ok result', async () => {
    const d = makeDeps({ statusResp: STATUS_WITH_MEMBERS, agentListResp: [] });
    const result = await mxWorkspaceStatus({}, d);
    const json = JSON.stringify(result);
    expect(json).not.toContain('@alice:homeserver');
    expect(json).not.toContain('@bob:homeserver');
    expect(json).not.toContain('@charlie:homeserver');
  });

  it('display_name values from members[] are absent from the ok result', async () => {
    const d = makeDeps({ statusResp: STATUS_WITH_MEMBERS, agentListResp: [] });
    const result = await mxWorkspaceStatus({}, d);
    const json = JSON.stringify(result);
    expect(json).not.toContain('Alice');
    expect(json).not.toContain('Bob');
    expect(json).not.toContain('Charlie');
  });

  it('"membership" field from members[] is absent from the ok result', async () => {
    const d = makeDeps({ statusResp: STATUS_WITH_MEMBERS, agentListResp: [] });
    const result = await mxWorkspaceStatus({}, d);
    const json = JSON.stringify(result);
    expect(json).not.toContain('"membership"');
  });

  it('non-secret room metadata IS present (room_id, name, canonical_alias, encrypted)', async () => {
    const d = makeDeps({ statusResp: STATUS_WITH_MEMBERS, agentListResp: [] });
    const result = await mxWorkspaceStatus({}, d);
    const r = result.result as Record<string, unknown>;
    const workspace = r.workspace as Record<string, unknown>;
    expect(workspace.room_id).toBe(ROOM);
    expect(workspace.name).toBe('Secure Workspace');
    expect(workspace.canonical_alias).toBe('#sec:homeserver');
    expect(workspace.encrypted).toBe(true);
  });

  it('workspace object has exactly the projected keys, no extras from the daemon reply', async () => {
    const d = makeDeps({ statusResp: STATUS_WITH_MEMBERS, agentListResp: [] });
    const result = await mxWorkspaceStatus({}, d);
    const workspace = (result.result as Record<string, unknown>).workspace as Record<string, unknown>;
    const keys = Object.keys(workspace).sort();
    // Only the four projected fields; the raw reply also had joined_members + members[]
    expect(keys).not.toContain('members');
    expect(keys).not.toContain('joined_members');
    expect(keys).not.toContain('user_id');
  });
});

// ---------------------------------------------------------------------------
// Matrix identity fields from agent rows NOT surfaced (allowlist-by-construction)
// ---------------------------------------------------------------------------

describe('mx_workspace_status — agent rows: Matrix identity fields NOT surfaced', () => {
  const FIELDS_FORBIDDEN_FROM_AGENTS = [
    'matrix_user_id',
    'device_id',
    'signing_key_id',
    'signing_public_key',
    'state_rev',
    '__unexpected_extra',
  ];

  const FULL_AGENT_STATE = {
    agent_id: 'ag_sec_01',
    kind: 'worker',
    capabilities: ['code'],
    matrix_user_id: '@ag_sec_01:homeserver',
    device_id: 'DEVICE_SEC_01',
    signing_key_id: 'ed25519:KEY_ID_01',
    signing_public_key: 'ed25519:AABB==',
    state_rev: 99,
    __unexpected_extra: 'should_not_appear_in_output',
  };

  it('projectAgentSummary drops all forbidden identity fields from agent rows', async () => {
    const d = makeDeps({
      statusResp: { room_id: ROOM },
      agentListResp: [{ agent: FULL_AGENT_STATE, liveness: 'active' }],
    });
    const result = await mxWorkspaceStatus({}, d);
    expect(result.status).toBe('ok');
    const agents = (result.result as Record<string, unknown>).agents as Array<Record<string, unknown>>;
    expect(agents).toHaveLength(1);
    const projected = agents[0]!;
    for (const field of FIELDS_FORBIDDEN_FROM_AGENTS) {
      expect(field in projected).toBe(false);
    }
  });

  it('projected agent contains only the four documented AgentSummary fields', async () => {
    const d = makeDeps({
      statusResp: { room_id: ROOM },
      agentListResp: [{ agent: FULL_AGENT_STATE, liveness: 'active' }],
    });
    const result = await mxWorkspaceStatus({}, d);
    const agents = (result.result as Record<string, unknown>).agents as Array<Record<string, unknown>>;
    const keys = Object.keys(agents[0]!).sort();
    expect(keys).toContain('agent_id');
    expect(keys).toContain('capabilities');
    expect(keys).toContain('liveness');
    // Exactly these fields — plus optionally 'kind'
    const EXTRA_FIELDS = keys.filter(
      (k) => !['agent_id', 'kind', 'capabilities', 'liveness'].includes(k),
    );
    expect(EXTRA_FIELDS).toEqual([]);
  });

  it('forbidden field values from FULL_AGENT_STATE do not appear in JSON output', async () => {
    const d = makeDeps({
      statusResp: { room_id: ROOM },
      agentListResp: [{ agent: FULL_AGENT_STATE, liveness: 'active' }],
    });
    const result = await mxWorkspaceStatus({}, d);
    const json = JSON.stringify(result);
    expect(json).not.toContain('@ag_sec_01:homeserver');
    expect(json).not.toContain('DEVICE_SEC_01');
    expect(json).not.toContain('KEY_ID_01');
    expect(json).not.toContain('should_not_appear_in_output');
  });
});

// ---------------------------------------------------------------------------
// No-authority invariant
// ---------------------------------------------------------------------------

describe('mx_workspace_status — no-authority allowlist invariants', () => {
  it('mx_workspace_status is in MODEL_FACING_ALLOWLIST', () => {
    expect(MODEL_FACING_ALLOWLIST).toContain('mx_workspace_status');
  });

  it('mx_workspace_status is NOT a forbidden authority verb', () => {
    expect(isForbiddenAuthorityVerb('mx_workspace_status')).toBe(false);
  });

  it('MX_WORKSPACE_STATUS descriptor name is "mx_workspace_status"', () => {
    expect(MX_WORKSPACE_STATUS.name).toBe('mx_workspace_status');
  });

  it('MX_WORKSPACE_STATUS is async_semantics: "sync" (a local read)', () => {
    expect(MX_WORKSPACE_STATUS.async_semantics).toBe('sync');
  });

  it('MX_WORKSPACE_STATUS declares no authority hint ("guarded", "approve")', () => {
    const d = MX_WORKSPACE_STATUS as unknown as Record<string, unknown>;
    expect(d.guarded).toBeUndefined();
    expect(d.approve).toBeUndefined();
    expect(d.authority).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Input schema: no model-facing fields (room is session-injected)
// ---------------------------------------------------------------------------

describe('mx_workspace_status — no model-facing input fields', () => {
  it('input schema declares no properties (model never names a room or credential)', () => {
    const schema = MX_WORKSPACE_STATUS.input_schema as {
      properties?: Record<string, unknown>;
      additionalProperties: boolean;
    };
    expect(schema.properties ?? {}).toEqual({});
    expect(schema.additionalProperties).toBe(false);
  });

  it('input schema has no credential-shaped property', () => {
    const forbidden = /(?:secret|password|passwd|api[_-]?key|signing[_-]?key|private[_-]?key|matrix_|mx_agent_|gh[_-]?token|room_id|user_id|(?:^|[_-])token$)/i;
    const schema = MX_WORKSPACE_STATUS.input_schema as { properties?: Record<string, unknown> };
    for (const key of Object.keys(schema.properties ?? {})) {
      expect(forbidden.test(key)).toBe(false);
    }
  });

  it('passing {} as input (the empty record) succeeds', async () => {
    const d = makeDeps({ statusResp: { room_id: ROOM }, agentListResp: [] });
    const result = await mxWorkspaceStatus({}, d);
    expect(result.status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// RPC method discipline — only workspace.status + agent.list dispatched
// ---------------------------------------------------------------------------

describe('mx_workspace_status — RPC method discipline', () => {
  it('only workspace.status and agent.list are called on a successful read', async () => {
    const d = makeDeps({ statusResp: { room_id: ROOM }, agentListResp: [] });
    await mxWorkspaceStatus({}, d);
    expect(d.methods.sort()).toEqual(['agent.list', 'workspace.status']);
  });

  it('no cancel, approve, decide, trust, or policy method is ever dispatched', async () => {
    const FORBIDDEN_METHODS = [
      'invocation.cancel', 'invocation.approve', 'approval.decide',
      'trust.add', 'trust.remove', 'trust.publish',
      'policy.update', 'policy.deny',
      'call.start', 'exec.start',
    ];
    const d = makeDeps({ statusResp: { room_id: ROOM }, agentListResp: [] });
    await mxWorkspaceStatus({}, d);
    for (const m of d.methods) {
      expect(FORBIDDEN_METHODS.includes(m)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Secret-free error messages
// ---------------------------------------------------------------------------

describe('mx_workspace_status — secret-free error messages', () => {
  it('error.message for not_found is the fixed phrase, never a raw daemon payload', async () => {
    const leakyError = new TransportError('rpc', 'rpc error: not_found', {
      cause: { error: { code: 'not_found', message: 'syt_AAAAAAAAAAAAAAAA leaked in daemon error' } },
    });
    const d = makeDeps({ statusResp: leakyError });
    const result = await mxWorkspaceStatus({}, d);
    expect(result.error?.message).toBe('no such invocation');
    expect(result.error?.message).not.toContain('syt_AAAAAAAAAAAAAAAA');
    expect(result.error?.message).not.toContain('leaked');
  });

  it('error.message for timeout is the fixed phrase', async () => {
    const d = makeDeps({ statusResp: new TransportError('timeout', 'timed out') });
    const result = await mxWorkspaceStatus({}, d);
    expect(result.error?.message).toBe('the operation timed out');
  });
});

// ---------------------------------------------------------------------------
// Envelope immutability + redactSecrets pass-through
// ---------------------------------------------------------------------------

describe('mx_workspace_status — envelope immutability and redactSecrets', () => {
  it('ok envelope is deeply frozen', async () => {
    const d = makeDeps({ statusResp: { room_id: ROOM }, agentListResp: [] });
    const result = await mxWorkspaceStatus({}, d);
    expect(result.status).toBe('ok');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.audit_ref)).toBe(true);
  });

  it('ok envelope passes redactSecrets unchanged (no false-positive redaction)', async () => {
    const d = makeDeps({
      statusResp: { room_id: ROOM, name: 'safe-workspace', encrypted: false },
      agentListResp: [{ agent: { agent_id: 'ag_clean', kind: 'worker', capabilities: [] }, liveness: 'active' }],
    });
    const result = await mxWorkspaceStatus({}, d);
    expect(result.status).toBe('ok');
    expect(redactSecrets(result)).toEqual(result);
  });

  it('mutation of a frozen ok envelope field throws in strict mode', async () => {
    const d = makeDeps({ statusResp: { room_id: ROOM }, agentListResp: [] });
    const result = await mxWorkspaceStatus({}, d);
    expect(() => {
      (result as unknown as Record<string, unknown>).status = 'error';
    }).toThrow();
  });

  it('error envelope is also frozen', async () => {
    const d = makeDeps({ statusResp: new TransportError('rpc', 'err', { cause: { error: { code: 'not_found' } } }) });
    const result = await mxWorkspaceStatus({}, d);
    expect(result.status).toBe('error');
    expect(Object.isFrozen(result)).toBe(true);
  });
});
