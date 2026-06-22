/**
 * `mxDescribeAgent` handler — AC 2, tool-schema pass-through, fault handling, and
 * envelope conformance (T104 / #12).
 *
 * Tests pin:
 * - AC 2: returns `{ agent, tools }` where `tools` are the target's published
 *   `ToolSchema[]` (including `input_schema` / `output_schema` verbatim).
 * - Unknown `agent_id` (agent.tools fault) → `errored('not_found', …)`.
 * - Liveness / workspace / load merged from `agent.list`.
 * - Missing liveness (list row absent) → fail-safe `'offline'`.
 * - `agent.list` failure is non-fatal — merge proceeds, liveness is `'offline'`.
 * - Both `agent.tools` + `agent.list` miss the agent → `not_found`.
 * - Every output envelope conforms to `ENVELOPE_SCHEMA`.
 * - `audit_ref` ids are all-null for local discovery reads.
 * - Only `agent.tools` + `agent.list` are called (no mutating RPCs).
 *
 * Pure unit tests; injected DaemonCall — no daemon, no socket, no env.
 */
import { describe, expect, it } from 'vitest';

import { TransportError } from '@mx-loom/toolbelt';

import {
  mxDescribeAgent,
  validateEnvelope,
  type DaemonCall,
  type HandlerDeps,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function te(code: string, message = 'err', cause?: unknown): TransportError {
  return new TransportError(code as 'timeout', message, cause !== undefined ? { cause } : undefined);
}

function expectValid(result: unknown): void {
  const valid = validateEnvelope(result);
  expect(valid, `envelope invalid: ${JSON.stringify((validateEnvelope as { errors?: unknown }).errors)}`).toBe(true);
}

interface FakeResponses {
  toolsResp?: unknown;
  listResp?: unknown;
}

function makeDeps({ toolsResp, listResp }: FakeResponses = {}): HandlerDeps {
  return {
    daemon: {
      call: async (method) => {
        if (method === 'agent.tools') {
          if (toolsResp instanceof Error) throw toolsResp;
          if (toolsResp === undefined) throw te('rpc', 'unknown_agent', { error: { code: 'unknown_agent' } });
          return toolsResp;
        }
        if (method === 'agent.list') {
          if (listResp instanceof Error) throw listResp;
          return listResp ?? [];
        }
        throw new Error(`Unexpected daemon method: ${method}`);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENT_STATE = {
  agent_id: 'ag_target',
  kind: 'worker',
  status: 'online',
  capabilities: ['code_execution'],
  tools: ['run_tests'],
  workspace: { cwd: '/projects/myapp', project_id: 'proj_abc', git_commit: 'cafebabe' },
  load: { running_invocations: 1, max_invocations: 4 },
  last_seen_ts: 1_700_000_000,
  matrix_user_id: '@ag_target:server',
  device_id: 'DEVICE_X',
  signing_key_id: 'key_abc',
  signing_public_key: 'ed25519:AAAA==',
  state_rev: 7,
};

const TOOLS_RESPONSE = {
  agent_id: 'ag_target',
  kind: 'worker',
  status: 'online',
  capabilities: ['code_execution'],
  tools: ['run_tests'],
  schemas: [
    {
      name: 'run_tests',
      version: '1.0',
      description: 'Run the project test suite',
      input_schema: { type: 'object', properties: { filter: { type: 'string' } }, required: [] },
      output_schema: { type: 'object', properties: { passed: { type: 'integer' }, failed: { type: 'integer' } } },
    },
  ],
};

const LIST_RESPONSE = [{ agent: AGENT_STATE, liveness: 'active' }];

// ---------------------------------------------------------------------------
// AC 2 — returns agent + tool schemas
// ---------------------------------------------------------------------------

describe('mxDescribeAgent — AC 2: returns the target agent and its tool schemas', () => {
  it('returns ok({ agent, tools }) for a known agent', async () => {
    const deps = makeDeps({ toolsResp: TOOLS_RESPONSE, listResp: LIST_RESPONSE });
    const result = await mxDescribeAgent({ agent_id: 'ag_target' }, deps);
    expect(result.status).toBe('ok');
    const payload = result.result as { agent: Record<string, unknown>; tools: unknown[] };
    expect(payload.agent).toBeDefined();
    expect(Array.isArray(payload.tools)).toBe(true);
  });

  it('tools array contains the published ToolSchema entries', async () => {
    const deps = makeDeps({ toolsResp: TOOLS_RESPONSE, listResp: LIST_RESPONSE });
    const result = await mxDescribeAgent({ agent_id: 'ag_target' }, deps);
    const { tools } = result.result as { tools: Array<{ name: string }> };
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('run_tests');
  });

  it('input_schema passes through verbatim (needed for mx_delegate_tool T105)', async () => {
    const deps = makeDeps({ toolsResp: TOOLS_RESPONSE, listResp: LIST_RESPONSE });
    const result = await mxDescribeAgent({ agent_id: 'ag_target' }, deps);
    const { tools } = result.result as { tools: Array<{ name: string; input_schema: unknown }> };
    expect(tools[0]!.input_schema).toEqual(TOOLS_RESPONSE.schemas[0]!.input_schema);
  });

  it('output_schema passes through verbatim', async () => {
    const deps = makeDeps({ toolsResp: TOOLS_RESPONSE, listResp: LIST_RESPONSE });
    const result = await mxDescribeAgent({ agent_id: 'ag_target' }, deps);
    const { tools } = result.result as { tools: Array<{ name: string; output_schema: unknown }> };
    expect(tools[0]!.output_schema).toEqual(TOOLS_RESPONSE.schemas[0]!.output_schema);
  });

  it('agent detail carries agent_id, kind, capabilities, liveness from merged sources', async () => {
    const deps = makeDeps({ toolsResp: TOOLS_RESPONSE, listResp: LIST_RESPONSE });
    const result = await mxDescribeAgent({ agent_id: 'ag_target' }, deps);
    const { agent } = result.result as { agent: Record<string, unknown> };
    expect(agent.agent_id).toBe('ag_target');
    expect(agent.kind).toBe('worker');
    expect(agent.capabilities).toEqual(['code_execution']);
    expect(agent.liveness).toBe('active');
  });

  it('agent detail carries workspace and load from agent.list', async () => {
    const deps = makeDeps({ toolsResp: TOOLS_RESPONSE, listResp: LIST_RESPONSE });
    const result = await mxDescribeAgent({ agent_id: 'ag_target' }, deps);
    const { agent } = result.result as { agent: Record<string, unknown> };
    expect(agent.workspace).toEqual({ cwd: '/projects/myapp', project_id: 'proj_abc', git_commit: 'cafebabe' });
    expect(agent.load).toEqual({ running_invocations: 1, max_invocations: 4 });
  });

  it('agent detail carries status from the merged record', async () => {
    const deps = makeDeps({ toolsResp: TOOLS_RESPONSE, listResp: LIST_RESPONSE });
    const result = await mxDescribeAgent({ agent_id: 'ag_target' }, deps);
    const { agent } = result.result as { agent: Record<string, unknown> };
    expect(agent.status).toBe('online');
  });

  it('agent detail carries last_seen_ts from agent.list', async () => {
    const deps = makeDeps({ toolsResp: TOOLS_RESPONSE, listResp: LIST_RESPONSE });
    const result = await mxDescribeAgent({ agent_id: 'ag_target' }, deps);
    const { agent } = result.result as { agent: Record<string, unknown> };
    expect(agent.last_seen_ts).toBe(1_700_000_000);
  });

  it('tools array contains all schemas when the agent publishes multiple tools', async () => {
    const multiToolsResp = {
      agent_id: 'ag_target',
      kind: 'worker',
      schemas: [
        { name: 'run_tests', version: '1.0', input_schema: { type: 'object', properties: { filter: { type: 'string' } } } },
        { name: 'lint_code', description: 'Run the linter', output_schema: { type: 'object' } },
        { name: 'build' },
      ],
    };
    const deps = makeDeps({ toolsResp: multiToolsResp, listResp: LIST_RESPONSE });
    const result = await mxDescribeAgent({ agent_id: 'ag_target' }, deps);
    expect(result.status).toBe('ok');
    const { tools } = result.result as { tools: Array<{ name: string }> };
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual(['run_tests', 'lint_code', 'build']);
    expectValid(result);
  });

  it('the ok envelope conforms to ENVELOPE_SCHEMA', async () => {
    const deps = makeDeps({ toolsResp: TOOLS_RESPONSE, listResp: LIST_RESPONSE });
    const result = await mxDescribeAgent({ agent_id: 'ag_target' }, deps);
    expectValid(result);
  });

  it('audit_ref ids are all-null (local read, no Matrix round-trip)', async () => {
    const deps = makeDeps({ toolsResp: TOOLS_RESPONSE, listResp: LIST_RESPONSE });
    const result = await mxDescribeAgent({ agent_id: 'ag_target' }, deps);
    expect(result.audit_ref.invocation_id).toBeNull();
    expect(result.audit_ref.request_id).toBeNull();
    expect(result.audit_ref.room).toBeNull();
    expect(result.audit_ref.event_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unknown agent_id → not_found
// ---------------------------------------------------------------------------

describe('mxDescribeAgent — unknown agent_id surfaces as not_found', () => {
  it('agent.tools rejects with rpc + unknown_agent → errored("not_found")', async () => {
    const cause = { error: { code: 'unknown_agent' } };
    const deps = makeDeps({ toolsResp: te('rpc', 'unknown', cause), listResp: [] });
    const result = await mxDescribeAgent({ agent_id: 'ag_missing' }, deps);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
    expectValid(result);
  });

  it('agent.tools succeeds but agent.list has no matching row → not_found from agent.tools alone is avoided (tools record is authoritative)', async () => {
    // agent.tools returns a valid record → agent is found via tools alone
    const toolsOnly = { agent_id: 'ag_tools_only', kind: 'worker', schemas: [] };
    const deps = makeDeps({ toolsResp: toolsOnly, listResp: [] });
    const result = await mxDescribeAgent({ agent_id: 'ag_tools_only' }, deps);
    expect(result.status).toBe('ok');
    expectValid(result);
  });

  it('agent.tools returns a record without agent_id AND list has no row → not_found', async () => {
    // toolsResp with no agent_id + no list match → both sources unrecognised
    const deps = makeDeps({ toolsResp: { schemas: [], tools: [] }, listResp: [] });
    const result = await mxDescribeAgent({ agent_id: 'ag_orphan' }, deps);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
    expectValid(result);
  });
});

// ---------------------------------------------------------------------------
// agent.list failure is non-fatal
// ---------------------------------------------------------------------------

describe('mxDescribeAgent — agent.list failure is non-fatal', () => {
  it('agent.list transport fault → merge proceeds, liveness defaults to offline', async () => {
    const deps = makeDeps({ toolsResp: TOOLS_RESPONSE, listResp: te('connect_failed') });
    const result = await mxDescribeAgent({ agent_id: 'ag_target' }, deps);
    expect(result.status).toBe('ok');
    const { agent } = result.result as { agent: Record<string, unknown> };
    expect(agent.agent_id).toBe('ag_target');
    expect(agent.liveness).toBe('offline');
    expectValid(result);
  });

  it('agent.list returns non-array → merge proceeds, liveness defaults to offline', async () => {
    const deps = makeDeps({ toolsResp: TOOLS_RESPONSE, listResp: null });
    const result = await mxDescribeAgent({ agent_id: 'ag_target' }, deps);
    expect(result.status).toBe('ok');
    const { agent } = result.result as { agent: Record<string, unknown> };
    expect(agent.liveness).toBe('offline');
  });

  it('agent.list has no matching row → merge proceeds, liveness defaults to offline', async () => {
    const otherAgent = { agent_id: 'ag_other', capabilities: [], tools: [] };
    const listWithWrongAgent = [{ agent: otherAgent, liveness: 'active' }];
    const deps = makeDeps({ toolsResp: TOOLS_RESPONSE, listResp: listWithWrongAgent });
    const result = await mxDescribeAgent({ agent_id: 'ag_target' }, deps);
    expect(result.status).toBe('ok');
    const { agent } = result.result as { agent: Record<string, unknown> };
    expect(agent.liveness).toBe('offline');
  });

  it('agent.list data wins when merging (list AgentState overrides agent.tools fields)', async () => {
    const toolsWithDifferentKind = { ...TOOLS_RESPONSE, kind: 'kind_from_tools' };
    const listWithKind = [{ agent: { ...AGENT_STATE, kind: 'kind_from_list' }, liveness: 'active' }];
    const deps = makeDeps({ toolsResp: toolsWithDifferentKind, listResp: listWithKind });
    const result = await mxDescribeAgent({ agent_id: 'ag_target' }, deps);
    const { agent } = result.result as { agent: Record<string, unknown> };
    expect(agent.kind).toBe('kind_from_list');
  });
});

// ---------------------------------------------------------------------------
// Transport fault mapping on agent.tools
// ---------------------------------------------------------------------------

describe('mxDescribeAgent — transport fault mapping on agent.tools (never throws)', () => {
  it('agent.tools transport timeout → errored("timeout")', async () => {
    const deps = makeDeps({ toolsResp: te('timeout'), listResp: [] });
    const result = await mxDescribeAgent({ agent_id: 'ag_t' }, deps);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('timeout');
    expectValid(result);
  });

  it('agent.tools transport rpc + policy_denied → denied("policy_denied")', async () => {
    const cause = { error: { code: 'policy_denied' } };
    const deps = makeDeps({ toolsResp: te('rpc', 'err', cause), listResp: [] });
    const result = await mxDescribeAgent({ agent_id: 'ag_t' }, deps);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
    expectValid(result);
  });

  it('agent.tools plain Error → errored("internal")', async () => {
    const deps = makeDeps({ toolsResp: new Error('oops'), listResp: [] });
    const result = await mxDescribeAgent({ agent_id: 'ag_t' }, deps);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('every TransportErrorCode on agent.tools produces a valid envelope and never throws', async () => {
    const codes = ['timeout', 'not_running', 'connect_failed', 'closed', 'frame', 'protocol', 'rpc', 'invalid_args'];
    for (const code of codes) {
      const deps = makeDeps({ toolsResp: te(code), listResp: [] });
      const result = await mxDescribeAgent({ agent_id: 'ag_t' }, deps);
      expect(result.status).toMatch(/^(ok|denied|error)$/);
      expectValid(result);
    }
  });
});

// ---------------------------------------------------------------------------
// RPC method discipline
// ---------------------------------------------------------------------------

describe('mxDescribeAgent — RPC method discipline', () => {
  it('calls agent.tools with the agent_id param', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const spy: DaemonCall = {
      call: async (method, params) => {
        calls.push({ method, params });
        if (method === 'agent.tools') return TOOLS_RESPONSE;
        return LIST_RESPONSE;
      },
    };
    await mxDescribeAgent({ agent_id: 'ag_target' }, { daemon: spy });
    const toolsCall = calls.find((c) => c.method === 'agent.tools');
    expect(toolsCall).toBeDefined();
    expect((toolsCall!.params as Record<string, string>).agent_id).toBe('ag_target');
  });

  it('calls agent.list (no params) for the liveness/workspace/load merge', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const spy: DaemonCall = {
      call: async (method, params) => {
        calls.push({ method, params });
        if (method === 'agent.tools') return TOOLS_RESPONSE;
        return LIST_RESPONSE;
      },
    };
    await mxDescribeAgent({ agent_id: 'ag_target' }, { daemon: spy });
    const listCall = calls.find((c) => c.method === 'agent.list');
    expect(listCall).toBeDefined();
  });

  it('issues no trust/policy/approval mutation RPCs', async () => {
    const methods: string[] = [];
    const spy: DaemonCall = {
      call: async (method) => {
        methods.push(method);
        if (method === 'agent.tools') return TOOLS_RESPONSE;
        return LIST_RESPONSE;
      },
    };
    await mxDescribeAgent({ agent_id: 'ag_target' }, { daemon: spy });
    const forbidden = ['trust.add', 'trust.revoke', 'policy.update', 'approval.decide', 'approval.grant'];
    for (const m of methods) {
      expect(forbidden.includes(m)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// agent.list bare-agent fallback row
// ---------------------------------------------------------------------------

describe('mxDescribeAgent — agent.list bare-agent fallback (no { agent: ... } wrapper)', () => {
  it('bare-agent list row is recognised: the row itself is the AgentState', async () => {
    // readListRow supports a row that IS the AgentState (carries agent_id at the top level)
    const bareAgentRow = {
      agent_id: 'ag_target',
      kind: 'worker',
      status: 'idle',
      capabilities: ['code_execution'],
      liveness: 'stale',
    };
    const deps = makeDeps({ toolsResp: TOOLS_RESPONSE, listResp: [bareAgentRow] });
    const result = await mxDescribeAgent({ agent_id: 'ag_target' }, deps);
    expect(result.status).toBe('ok');
    const { agent } = result.result as { agent: Record<string, unknown> };
    expect(agent.agent_id).toBe('ag_target');
    expect(agent.liveness).toBe('stale');
    expectValid(result);
  });
});

// ---------------------------------------------------------------------------
// Determinism — same input produces the same result
// ---------------------------------------------------------------------------

describe('mxDescribeAgent — determinism (same input → same output)', () => {
  it('identical calls with the same mock produce identical results', async () => {
    const deps = makeDeps({ toolsResp: TOOLS_RESPONSE, listResp: LIST_RESPONSE });
    const r1 = await mxDescribeAgent({ agent_id: 'ag_target' }, deps);
    const r2 = await mxDescribeAgent({ agent_id: 'ag_target' }, deps);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});

// ---------------------------------------------------------------------------
// Empty schemas
// ---------------------------------------------------------------------------

describe('mxDescribeAgent — agents with no published tools', () => {
  it('agent.tools with empty schemas → ok({ agent, tools: [] })', async () => {
    const emptyTools = { agent_id: 'ag_notool', kind: 'idle', schemas: [], capabilities: [], tools: [] };
    const emptyList = [{ agent: { agent_id: 'ag_notool', capabilities: [] }, liveness: 'stale' }];
    const deps = makeDeps({ toolsResp: emptyTools, listResp: emptyList });
    const result = await mxDescribeAgent({ agent_id: 'ag_notool' }, deps);
    expect(result.status).toBe('ok');
    const { tools } = result.result as { tools: unknown[] };
    expect(tools).toHaveLength(0);
    expectValid(result);
  });

  it('agent.tools with non-array schemas → ok with empty tools', async () => {
    const badSchemas = { agent_id: 'ag_bad', schemas: 'not-an-array' };
    const deps = makeDeps({ toolsResp: badSchemas, listResp: [] });
    const result = await mxDescribeAgent({ agent_id: 'ag_bad' }, deps);
    expect(result.status).toBe('ok');
    const { tools } = result.result as { tools: unknown[] };
    expect(tools).toHaveLength(0);
    expectValid(result);
  });
});
