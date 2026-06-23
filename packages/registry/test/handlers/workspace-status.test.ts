/**
 * `mxWorkspaceStatus` handler — observe the workspace (T108 / #16).
 *
 * Tests pin:
 * - AC 2: workspace.status + agent.list → ok({ workspace, agents, project? })
 *   with agents projected to AgentSummary[] and registered agents present.
 * - workspace metadata: room_id, name, canonical_alias, encrypted projected;
 *   raw Matrix members[] is NOT surfaced (that's the security test).
 * - agents: projected via projectAgentSummary (agent_id, kind, capabilities, liveness).
 * - project: derived from workspace.status reply when it carries one; from agent
 *   rows as fallback; omitted when neither source has it.
 * - Empty workspace → ok({ workspace:{}, agents:[] }) (no agents or project).
 * - agent.list fault tolerated → agents:[], handler still returns ok.
 * - agent.list non-array reply tolerated → agents:[].
 * - workspace.status fault (primary) → fault envelope (not_found / timeout / internal).
 * - room present in deps → workspace.status called with { room }.
 * - room absent (undefined/empty string) → workspace.status called without room param.
 * - Malformed agent rows tolerated (readListRow returns undefined → skipped).
 * - audit_ref all-null (workspace.status + agent.list are local reads, no Matrix
 *   round-trip, consistent with T104's EMPTY_AUDIT_REF).
 * - handler never throws; every output validates ENVELOPE_SCHEMA.
 *
 * Pure unit tests; injected DaemonCall — no daemon, no socket, no env.
 */
import { describe, expect, it } from 'vitest';

import { TransportError } from '@mx-loom/toolbelt';

import {
  mxWorkspaceStatus,
  validateEnvelope,
  type DaemonCall,
  type RoomScopedDeps,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOM = '!workspace:homeserver';

/** Build RoomScopedDeps with per-method fake responses. */
function makeDeps(opts: {
  statusResp?: unknown;
  agentListResp?: unknown;
  room?: string;
  /** Use 'room' in opts to distinguish "explicitly no room" from "default ROOM". */
  noRoom?: boolean;
}): RoomScopedDeps & { calls: Array<{ method: string; params: unknown }> } {
  const calls: Array<{ method: string; params: unknown }> = [];
  const daemon: DaemonCall = {
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === 'workspace.status') {
        const r = opts.statusResp;
        if (r instanceof Error) throw r;
        return r;
      }
      if (method === 'agent.list') {
        const r = opts.agentListResp;
        if (r instanceof Error) throw r;
        return r;
      }
      throw new Error(`Unexpected daemon method: ${method}`);
    },
  };
  const room = opts.noRoom ? undefined : (opts.room ?? ROOM);
  return { daemon, room, calls };
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

/** A realistic workspace.status reply with all defined fields + raw Matrix members[]. */
const STATUS_WITH_MEMBERS = {
  room_id: ROOM,
  name: 'test-workspace',
  canonical_alias: '#test:homeserver',
  encrypted: true,
  joined_members: 2,
  members: [
    { user_id: '@alice:homeserver', display_name: 'Alice', membership: 'join' },
    { user_id: '@bob:homeserver', display_name: 'Bob', membership: 'join' },
  ],
};

/** Minimal workspace.status reply (no members). */
const STATUS_MINIMAL = { room_id: ROOM, name: 'my-workspace', encrypted: false };

/** One agent.list row: wrapped { agent, liveness } format (v0.2.1 shape). */
const AGENT_ROW_1 = {
  agent: {
    agent_id: 'ag_01',
    kind: 'code-assistant',
    capabilities: ['code', 'debug'],
    matrix_user_id: '@ag_01:homeserver',
    signing_key_id: 'ed25519:KEY01',
    device_id: 'DEVICE01',
  },
  liveness: 'active',
};

const AGENT_ROW_2 = {
  agent: {
    agent_id: 'ag_02',
    kind: 'reviewer',
    capabilities: ['review'],
    matrix_user_id: '@ag_02:homeserver',
  },
  liveness: 'stale',
};

/** A workspace.status reply that carries a project block. */
const STATUS_WITH_PROJECT = {
  ...STATUS_MINIMAL,
  project: { project_id: 'proj_01', cwd: '/app', git_commit: 'abc123' },
};

/** A workspace.status reply that carries a workspace block for project derivation. */
const STATUS_WITH_WORKSPACE_BLOCK = {
  ...STATUS_MINIMAL,
  workspace: { project_id: 'proj_ws', cwd: '/ws' },
};

// ---------------------------------------------------------------------------
// AC 2 — workspace.status + agent.list → ok({ workspace, agents, project? })
// ---------------------------------------------------------------------------

describe('mxWorkspaceStatus — AC 2: registered agents + project context', () => {
  it('happy path: workspace + two agents → ok({ workspace, agents, project? })', async () => {
    const d = makeDeps({
      statusResp: STATUS_MINIMAL,
      agentListResp: [AGENT_ROW_1, AGENT_ROW_2],
    });
    const result = await mxWorkspaceStatus({}, d);
    expect(result.status).toBe('ok');
    expect(result.error).toBeNull();
    expect(result.handle).toBeNull();
    expect(result.approval).toBeNull();
    expectValid(result);
  });

  it('agents array contains the registered agents projected to AgentSummary', async () => {
    const d = makeDeps({
      statusResp: STATUS_MINIMAL,
      agentListResp: [AGENT_ROW_1, AGENT_ROW_2],
    });
    const result = await mxWorkspaceStatus({}, d);
    const r = result.result as Record<string, unknown>;
    expect(Array.isArray(r.agents)).toBe(true);
    const agents = r.agents as Array<Record<string, unknown>>;
    expect(agents).toHaveLength(2);
    expect(agents[0]?.agent_id).toBe('ag_01');
    expect(agents[0]?.kind).toBe('code-assistant');
    expect(agents[0]?.liveness).toBe('active');
    expect(agents[1]?.agent_id).toBe('ag_02');
    expect(agents[1]?.liveness).toBe('stale');
  });

  it('workspace metadata is projected: room_id, name, canonical_alias, encrypted', async () => {
    const d = makeDeps({ statusResp: STATUS_WITH_MEMBERS, agentListResp: [] });
    const result = await mxWorkspaceStatus({}, d);
    const r = result.result as Record<string, unknown>;
    const workspace = r.workspace as Record<string, unknown>;
    expect(workspace.room_id).toBe(ROOM);
    expect(workspace.name).toBe('test-workspace');
    expect(workspace.canonical_alias).toBe('#test:homeserver');
    expect(workspace.encrypted).toBe(true);
  });

  it('workspace fields absent in the reply are omitted (not set to undefined/null)', async () => {
    const d = makeDeps({ statusResp: { room_id: ROOM }, agentListResp: [] });
    const result = await mxWorkspaceStatus({}, d);
    const workspace = (result.result as Record<string, unknown>).workspace as Record<string, unknown>;
    expect(workspace.room_id).toBe(ROOM);
    expect('name' in workspace).toBe(false);
    expect('canonical_alias' in workspace).toBe(false);
    expect('encrypted' in workspace).toBe(false);
  });

  it('project derived from workspace.status reply when it carries a project block', async () => {
    const d = makeDeps({ statusResp: STATUS_WITH_PROJECT, agentListResp: [] });
    const result = await mxWorkspaceStatus({}, d);
    const r = result.result as Record<string, unknown>;
    expect(r.project).toBeDefined();
    const project = r.project as Record<string, unknown>;
    expect(project.project_id).toBe('proj_01');
    expect(project.cwd).toBe('/app');
    expect(project.git_commit).toBe('abc123');
  });

  it('project derived from workspace block on workspace.status reply', async () => {
    const d = makeDeps({ statusResp: STATUS_WITH_WORKSPACE_BLOCK, agentListResp: [] });
    const result = await mxWorkspaceStatus({}, d);
    const project = (result.result as Record<string, unknown>).project as Record<string, unknown> | undefined;
    expect(project?.project_id).toBe('proj_ws');
    expect(project?.cwd).toBe('/ws');
  });

  it('project derived from agent row workspace field when workspace.status lacks it', async () => {
    const agentWithWorkspace = {
      agent: {
        agent_id: 'ag_03',
        kind: 'worker',
        capabilities: [],
        workspace: { project_id: 'proj_agent', cwd: '/agent-cwd', git_commit: 'def456' },
      },
      liveness: 'active',
    };
    const d = makeDeps({ statusResp: STATUS_MINIMAL, agentListResp: [agentWithWorkspace] });
    const result = await mxWorkspaceStatus({}, d);
    const project = (result.result as Record<string, unknown>).project as Record<string, unknown>;
    expect(project.project_id).toBe('proj_agent');
    expect(project.cwd).toBe('/agent-cwd');
    expect(project.git_commit).toBe('def456');
  });

  it('project omitted when no source (workspace.status nor agent rows) knows the project', async () => {
    const d = makeDeps({ statusResp: STATUS_MINIMAL, agentListResp: [AGENT_ROW_1] });
    const result = await mxWorkspaceStatus({}, d);
    const r = result.result as Record<string, unknown>;
    expect('project' in r).toBe(false);
  });

  it('capabilities array is preserved on each AgentSummary', async () => {
    const d = makeDeps({ statusResp: STATUS_MINIMAL, agentListResp: [AGENT_ROW_1] });
    const result = await mxWorkspaceStatus({}, d);
    const agents = (result.result as Record<string, unknown>).agents as Array<Record<string, unknown>>;
    expect(agents[0]?.capabilities).toEqual(['code', 'debug']);
  });
});

// ---------------------------------------------------------------------------
// Empty workspace
// ---------------------------------------------------------------------------

describe('mxWorkspaceStatus — empty workspace', () => {
  it('empty agent.list → ok({ workspace, agents:[] })', async () => {
    const d = makeDeps({ statusResp: STATUS_MINIMAL, agentListResp: [] });
    const result = await mxWorkspaceStatus({}, d);
    expect(result.status).toBe('ok');
    const r = result.result as Record<string, unknown>;
    expect(r.agents).toEqual([]);
    expectValid(result);
  });

  it('malformed workspace.status (non-object) → ok with empty workspace and no agents', async () => {
    const d = makeDeps({ statusResp: null, agentListResp: [] });
    const result = await mxWorkspaceStatus({}, d);
    // null is a valid (if empty) resolved response — faultToResult is only triggered on throw
    expect(result.status).toBe('ok');
    const r = result.result as Record<string, unknown>;
    const workspace = r.workspace as Record<string, unknown>;
    expect(Object.keys(workspace)).toHaveLength(0);
    expect(r.agents).toEqual([]);
    expectValid(result);
  });
});

// ---------------------------------------------------------------------------
// agent.list fault is tolerated — degrades to agents:[], still ok
// ---------------------------------------------------------------------------

describe('mxWorkspaceStatus — agent.list fault tolerated', () => {
  it('agent.list throws rpc error → agents:[], handler still returns ok', async () => {
    const d = makeDeps({
      statusResp: STATUS_MINIMAL,
      agentListResp: rpcDaemonError('not_found'),
    });
    const result = await mxWorkspaceStatus({}, d);
    expect(result.status).toBe('ok');
    expect((result.result as Record<string, unknown>).agents).toEqual([]);
    expectValid(result);
  });

  it('agent.list throws transport error → agents:[], handler still returns ok', async () => {
    const d = makeDeps({
      statusResp: STATUS_MINIMAL,
      agentListResp: te('timeout'),
    });
    const result = await mxWorkspaceStatus({}, d);
    expect(result.status).toBe('ok');
    expect((result.result as Record<string, unknown>).agents).toEqual([]);
  });

  it('agent.list returns null (non-array) → agents:[]', async () => {
    const d = makeDeps({ statusResp: STATUS_MINIMAL, agentListResp: null });
    const result = await mxWorkspaceStatus({}, d);
    expect(result.status).toBe('ok');
    expect((result.result as Record<string, unknown>).agents).toEqual([]);
  });

  it('agent.list returns object (not array) → agents:[]', async () => {
    const d = makeDeps({ statusResp: STATUS_MINIMAL, agentListResp: { agents: [] } });
    const result = await mxWorkspaceStatus({}, d);
    expect(result.status).toBe('ok');
    expect((result.result as Record<string, unknown>).agents).toEqual([]);
  });

  it('agent.list fault does not stop workspace.status being used for workspace metadata', async () => {
    const d = makeDeps({
      statusResp: STATUS_WITH_PROJECT,
      agentListResp: te('not_running'),
    });
    const result = await mxWorkspaceStatus({}, d);
    expect(result.status).toBe('ok');
    const r = result.result as Record<string, unknown>;
    const workspace = r.workspace as Record<string, unknown>;
    expect(workspace.room_id).toBe(ROOM);
    const project = r.project as Record<string, unknown>;
    expect(project?.project_id).toBe('proj_01');
  });
});

// ---------------------------------------------------------------------------
// workspace.status fault — primary read: fault envelope
// ---------------------------------------------------------------------------

describe('mxWorkspaceStatus — workspace.status primary fault', () => {
  it('workspace.status throws rpc/not_found → errored("not_found")', async () => {
    const d = makeDeps({ statusResp: rpcDaemonError('not_found') });
    const result = await mxWorkspaceStatus({}, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
    expectValid(result);
  });

  it('workspace.status throws timeout → errored("timeout")', async () => {
    const d = makeDeps({ statusResp: te('timeout') });
    const result = await mxWorkspaceStatus({}, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('timeout');
    expectValid(result);
  });

  it('workspace.status throws rpc/target_offline → errored("target_offline")', async () => {
    const d = makeDeps({ statusResp: rpcDaemonError('target_offline') });
    const result = await mxWorkspaceStatus({}, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('target_offline');
    expectValid(result);
  });

  it('workspace.status throws plain Error → errored("internal")', async () => {
    const d = makeDeps({ statusResp: new Error('crash') });
    const result = await mxWorkspaceStatus({}, d);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });

  it('workspace.status fault: agent.list is never called (no unnecessary second RPC)', async () => {
    const d = makeDeps({ statusResp: rpcDaemonError('not_found') });
    await mxWorkspaceStatus({}, d);
    const agentListCalls = d.calls.filter((c) => c.method === 'agent.list');
    expect(agentListCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Room param dispatch
// ---------------------------------------------------------------------------

describe('mxWorkspaceStatus — room param dispatch', () => {
  it('room present in deps → workspace.status called with { room }', async () => {
    const d = makeDeps({ statusResp: STATUS_MINIMAL, agentListResp: [], room: ROOM });
    await mxWorkspaceStatus({}, d);
    const statusCall = d.calls.find((c) => c.method === 'workspace.status');
    expect((statusCall?.params as Record<string, unknown>)?.room).toBe(ROOM);
  });

  it('room undefined → workspace.status called without a room param', async () => {
    const d = makeDeps({ statusResp: STATUS_MINIMAL, agentListResp: [], noRoom: true });
    await mxWorkspaceStatus({}, d);
    const statusCall = d.calls.find((c) => c.method === 'workspace.status');
    expect(statusCall?.params).toBeUndefined();
  });

  it('room empty string → workspace.status called without a room param', async () => {
    const d = makeDeps({ statusResp: STATUS_MINIMAL, agentListResp: [], room: '' });
    await mxWorkspaceStatus({}, d);
    const statusCall = d.calls.find((c) => c.method === 'workspace.status');
    expect(statusCall?.params).toBeUndefined();
  });

  it('room absent → handler still dispatches workspace.status (best-effort read)', async () => {
    const d = makeDeps({ statusResp: STATUS_MINIMAL, agentListResp: [], noRoom: true });
    const result = await mxWorkspaceStatus({}, d);
    expect(result.status).toBe('ok');
    expect(d.calls.some((c) => c.method === 'workspace.status')).toBe(true);
  });

  it('agent.list is always called without params', async () => {
    const d = makeDeps({ statusResp: STATUS_MINIMAL, agentListResp: [] });
    await mxWorkspaceStatus({}, d);
    const agentListCall = d.calls.find((c) => c.method === 'agent.list');
    expect(agentListCall?.params).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Malformed agent rows tolerated
// ---------------------------------------------------------------------------

describe('mxWorkspaceStatus — malformed agent rows tolerated', () => {
  it('malformed rows are skipped, valid rows still projected', async () => {
    const listWithBad = [
      null,
      'not-a-row',
      42,
      {},
      { agent: null, liveness: 'active' }, // agent is null → readListRow returns undefined
      AGENT_ROW_1,
    ];
    const d = makeDeps({ statusResp: STATUS_MINIMAL, agentListResp: listWithBad });
    const result = await mxWorkspaceStatus({}, d);
    expect(result.status).toBe('ok');
    const agents = (result.result as Record<string, unknown>).agents as unknown[];
    expect(agents).toHaveLength(1);
    expect((agents[0] as Record<string, unknown>).agent_id).toBe('ag_01');
    expectValid(result);
  });

  it('all-malformed list → agents:[], still ok', async () => {
    const d = makeDeps({ statusResp: STATUS_MINIMAL, agentListResp: [null, 42, 'bad'] });
    const result = await mxWorkspaceStatus({}, d);
    expect(result.status).toBe('ok');
    expect((result.result as Record<string, unknown>).agents).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// audit_ref — all-null (local read, no Matrix round-trip)
// ---------------------------------------------------------------------------

describe('mxWorkspaceStatus — audit_ref all-null (local read)', () => {
  it('ok envelope carries all-null audit_ref (workspace.status + agent.list are local reads)', async () => {
    const d = makeDeps({ statusResp: STATUS_MINIMAL, agentListResp: [AGENT_ROW_1] });
    const result = await mxWorkspaceStatus({}, d);
    expect(result.audit_ref.invocation_id).toBeNull();
    expect(result.audit_ref.request_id).toBeNull();
    expect(result.audit_ref.room).toBeNull();
    expect(result.audit_ref.event_id).toBeNull();
  });

  it('audit_ref is structurally present (object, not null) on every output', async () => {
    const d = makeDeps({ statusResp: rpcDaemonError('not_found') });
    const result = await mxWorkspaceStatus({}, d);
    expect(result.audit_ref).not.toBeNull();
    expect(typeof result.audit_ref).toBe('object');
    expect('invocation_id' in result.audit_ref).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Robustness — never throws, every output validates ENVELOPE_SCHEMA
// ---------------------------------------------------------------------------

describe('mxWorkspaceStatus — robustness / never throws', () => {
  it('handler never throws on any combination of responses', async () => {
    const scenarios: Array<{ status: unknown; list: unknown }> = [
      { status: STATUS_MINIMAL, list: [AGENT_ROW_1] },
      { status: STATUS_MINIMAL, list: [] },
      { status: null, list: [] },
      { status: STATUS_MINIMAL, list: rpcDaemonError('not_found') },
      { status: rpcDaemonError('not_found'), list: [] },
      { status: te('timeout'), list: [] },
    ];
    for (const { status, list } of scenarios) {
      const d = makeDeps({ statusResp: status, agentListResp: list });
      await expect(mxWorkspaceStatus({}, d)).resolves.toBeDefined();
    }
  });

  it('all disposition paths produce ENVELOPE_SCHEMA-valid output', async () => {
    const scenarios: Array<{ status: unknown; list: unknown }> = [
      { status: STATUS_WITH_MEMBERS, list: [AGENT_ROW_1, AGENT_ROW_2] },
      { status: STATUS_WITH_PROJECT, list: [] },
      { status: STATUS_MINIMAL, list: rpcDaemonError('timeout') },
      { status: rpcDaemonError('not_found'), list: undefined },
      { status: te('timeout'), list: undefined },
      { status: null, list: null },
    ];
    for (const { status, list } of scenarios) {
      const d = makeDeps({ statusResp: status, agentListResp: list });
      const result = await mxWorkspaceStatus({}, d);
      expectValid(result);
    }
  });
});
