/**
 * `mxFindAgents` handler — AC 1, filter logic, fault handling, and envelope
 * conformance (T104 / #12).
 *
 * Tests pin:
 * - AC 1: Filter by capability returns exactly the expected agents.
 * - Liveness filter narrows correctly; absent filter matches all.
 * - Tool filter: names from row first, `agent.tools` fan-out as fallback.
 * - AND-combined filters: capability + liveness + tool together.
 * - Empty match → `ok({ agents: [] })` (valid empty success, not an error).
 * - Malformed / non-array `agent.list` response → empty agents (not an error).
 * - Transport faults → fault envelope; handler NEVER throws to the caller.
 * - Daemon RPC error → fault envelope with appropriate code.
 * - Every output conforms to `ENVELOPE_SCHEMA`.
 * - `audit_ref` ids are all-null for local discovery reads.
 * - Only `agent.list` (and conditionally `agent.tools`) are called — no mutating methods.
 *
 * Pure unit tests; injected DaemonCall — no daemon, no socket, no env.
 */
import { describe, expect, it } from 'vitest';

import { TransportError } from '@mx-loom/toolbelt';

import {
  mxFindAgents,
  validateEnvelope,
  type DaemonCall,
  type HandlerDeps,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent_id: 'ag_default',
    kind: 'worker',
    capabilities: ['code_execution'],
    tools: ['run_tests'],
    status: 'online',
    ...overrides,
  };
}

function makeRow(agent: Record<string, unknown>, liveness = 'active'): Record<string, unknown> {
  return { agent, liveness };
}

function makeDeps(
  responses: Map<string, unknown> | { list?: unknown; tools?: Record<string, unknown> },
): HandlerDeps {
  if (responses instanceof Map) {
    return {
      daemon: {
        call: async (method, params) => {
          const key = method + (params ? JSON.stringify(params) : '');
          const val = responses.get(key) ?? responses.get(method);
          if (val instanceof Error) throw val;
          if (val === undefined) throw new Error(`Unexpected call: ${method}`);
          return val;
        },
      },
    };
  }

  const { list, tools } = responses as { list?: unknown; tools?: Record<string, unknown> };
  return {
    daemon: {
      call: async (method, params) => {
        if (method === 'agent.list') {
          if (list instanceof Error) throw list;
          return list ?? [];
        }
        if (method === 'agent.tools') {
          const agentId = (params as Record<string, string>)?.agent_id;
          const resp = tools?.[agentId ?? ''];
          if (resp instanceof Error) throw resp;
          if (resp === undefined) throw new TransportError('rpc', 'unknown agent', { cause: { error: { code: 'unknown_agent' } } });
          return resp;
        }
        throw new Error(`Unexpected daemon method: ${method}`);
      },
    },
  };
}

function te(code: string, message = 'err', cause?: unknown): TransportError {
  return new TransportError(code as 'timeout', message, cause !== undefined ? { cause } : undefined);
}

function expectValid(result: unknown): void {
  const valid = validateEnvelope(result);
  expect(valid, `envelope invalid: ${JSON.stringify((validateEnvelope as { errors?: unknown }).errors)}`).toBe(true);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENT_A = makeAgent({ agent_id: 'ag_a', kind: 'orchestrator', capabilities: ['orchestration', 'code_execution'], tools: ['deploy'] });
const AGENT_B = makeAgent({ agent_id: 'ag_b', kind: 'worker', capabilities: ['code_execution'], tools: ['run_tests', 'deploy'] });
const AGENT_C = makeAgent({ agent_id: 'ag_c', kind: 'worker', capabilities: ['docs'], tools: [] });

const ROW_A_ACTIVE = makeRow(AGENT_A, 'active');
const ROW_B_STALE = makeRow(AGENT_B, 'stale');
const ROW_C_OFFLINE = makeRow(AGENT_C, 'offline');

const THREE_ROWS = [ROW_A_ACTIVE, ROW_B_STALE, ROW_C_OFFLINE];

// ---------------------------------------------------------------------------
// Absent filters — match all
// ---------------------------------------------------------------------------

describe('mxFindAgents — absent filters match all agents', () => {
  it('no filters → all agents returned', async () => {
    const deps = makeDeps({ list: THREE_ROWS });
    const result = await mxFindAgents({}, deps);
    expect(result.status).toBe('ok');
    const agents = (result.result as { agents: unknown[] }).agents;
    expect(agents).toHaveLength(3);
  });

  it('no filters → result envelope validates', async () => {
    const deps = makeDeps({ list: THREE_ROWS });
    const result = await mxFindAgents({}, deps);
    expectValid(result);
  });

  it('no filters → audit_ref ids are all null', async () => {
    const deps = makeDeps({ list: THREE_ROWS });
    const result = await mxFindAgents({}, deps);
    expect(result.audit_ref.invocation_id).toBeNull();
    expect(result.audit_ref.request_id).toBeNull();
    expect(result.audit_ref.room).toBeNull();
    expect(result.audit_ref.event_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC 1 — capability filter
// ---------------------------------------------------------------------------

describe('mxFindAgents — AC 1: capability filter returns expected agents', () => {
  it('capability "orchestration" returns only ag_a', async () => {
    const deps = makeDeps({ list: THREE_ROWS });
    const result = await mxFindAgents({ capability: 'orchestration' }, deps);
    expect(result.status).toBe('ok');
    const agents = (result.result as { agents: Array<{ agent_id: string }> }).agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]!.agent_id).toBe('ag_a');
  });

  it('capability "code_execution" returns ag_a and ag_b (both advertise it)', async () => {
    const deps = makeDeps({ list: THREE_ROWS });
    const result = await mxFindAgents({ capability: 'code_execution' }, deps);
    const agents = (result.result as { agents: Array<{ agent_id: string }> }).agents;
    expect(agents).toHaveLength(2);
    const ids = agents.map((a) => a.agent_id).sort();
    expect(ids).toEqual(['ag_a', 'ag_b']);
  });

  it('capability "docs" returns only ag_c', async () => {
    const deps = makeDeps({ list: THREE_ROWS });
    const result = await mxFindAgents({ capability: 'docs' }, deps);
    const agents = (result.result as { agents: Array<{ agent_id: string }> }).agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]!.agent_id).toBe('ag_c');
  });

  it('non-matching capability → ok({ agents: [] }) (valid empty success)', async () => {
    const deps = makeDeps({ list: THREE_ROWS });
    const result = await mxFindAgents({ capability: 'nonexistent' }, deps);
    expect(result.status).toBe('ok');
    expect((result.result as { agents: unknown[] }).agents).toHaveLength(0);
    expectValid(result);
  });
});

// ---------------------------------------------------------------------------
// Liveness filter
// ---------------------------------------------------------------------------

describe('mxFindAgents — liveness filter', () => {
  it('liveness "active" returns only ag_a', async () => {
    const deps = makeDeps({ list: THREE_ROWS });
    const result = await mxFindAgents({ liveness: 'active' }, deps);
    const agents = (result.result as { agents: Array<{ agent_id: string }> }).agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]!.agent_id).toBe('ag_a');
  });

  it('liveness "stale" returns only ag_b', async () => {
    const deps = makeDeps({ list: THREE_ROWS });
    const result = await mxFindAgents({ liveness: 'stale' }, deps);
    const agents = (result.result as { agents: Array<{ agent_id: string }> }).agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]!.agent_id).toBe('ag_b');
  });

  it('liveness "offline" returns only ag_c', async () => {
    const deps = makeDeps({ list: THREE_ROWS });
    const result = await mxFindAgents({ liveness: 'offline' }, deps);
    const agents = (result.result as { agents: Array<{ agent_id: string }> }).agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]!.agent_id).toBe('ag_c');
  });
});

// ---------------------------------------------------------------------------
// Tool filter — from row names, then agent.tools fan-out
// ---------------------------------------------------------------------------

describe('mxFindAgents — tool filter', () => {
  it('tool "deploy" returns agents that carry the name in the row tools array', async () => {
    const deps = makeDeps({ list: THREE_ROWS });
    const result = await mxFindAgents({ tool: 'deploy' }, deps);
    const agents = (result.result as { agents: Array<{ agent_id: string }> }).agents;
    const ids = agents.map((a) => a.agent_id).sort();
    expect(ids).toEqual(['ag_a', 'ag_b']);
  });

  it('tool "run_tests" returns only ag_b (only agent carrying the name)', async () => {
    const deps = makeDeps({ list: THREE_ROWS });
    const result = await mxFindAgents({ tool: 'run_tests' }, deps);
    const agents = (result.result as { agents: Array<{ agent_id: string }> }).agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]!.agent_id).toBe('ag_b');
  });

  it('tool filter via agent.tools fan-out when row tools array is empty/absent', async () => {
    const agentWithEmptyTools = makeAgent({ agent_id: 'ag_fan', capabilities: ['code'], tools: [] });
    const row = makeRow(agentWithEmptyTools, 'active');
    const toolsResp = { agent_id: 'ag_fan', schemas: [{ name: 'build_tool' }], tools: [] };
    const deps = makeDeps({ list: [row], tools: { ag_fan: toolsResp } });
    const result = await mxFindAgents({ tool: 'build_tool' }, deps);
    const agents = (result.result as { agents: Array<{ agent_id: string }> }).agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]!.agent_id).toBe('ag_fan');
  });

  it('a per-agent agent.tools fault is tolerated as "no match" — entire query succeeds', async () => {
    const agentWithEmptyTools = makeAgent({ agent_id: 'ag_fault', capabilities: ['code'], tools: [] });
    const agentOk = makeAgent({ agent_id: 'ag_ok', capabilities: ['code'], tools: [] });
    const toolsOk = { agent_id: 'ag_ok', schemas: [{ name: 'mytool' }], tools: [] };
    const deps = makeDeps({
      list: [makeRow(agentWithEmptyTools, 'active'), makeRow(agentOk, 'active')],
      tools: {
        ag_fault: te('rpc', 'err', { error: { code: 'unknown_agent' } }),
        ag_ok: toolsOk,
      },
    });
    const result = await mxFindAgents({ tool: 'mytool' }, deps);
    expect(result.status).toBe('ok');
    const agents = (result.result as { agents: Array<{ agent_id: string }> }).agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]!.agent_id).toBe('ag_ok');
    expectValid(result);
  });
});

// ---------------------------------------------------------------------------
// AND-combined filters
// ---------------------------------------------------------------------------

describe('mxFindAgents — AND-combined filters', () => {
  it('capability + liveness together: narrows to the intersection', async () => {
    const deps = makeDeps({ list: THREE_ROWS });
    const result = await mxFindAgents({ capability: 'code_execution', liveness: 'active' }, deps);
    const agents = (result.result as { agents: Array<{ agent_id: string }> }).agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]!.agent_id).toBe('ag_a');
  });

  it('capability + tool + liveness together: narrows to single match', async () => {
    const deps = makeDeps({ list: THREE_ROWS });
    const result = await mxFindAgents({ capability: 'code_execution', liveness: 'stale', tool: 'deploy' }, deps);
    const agents = (result.result as { agents: Array<{ agent_id: string }> }).agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]!.agent_id).toBe('ag_b');
  });

  it('AND semantics: no match when capability matches but liveness does not', async () => {
    const deps = makeDeps({ list: THREE_ROWS });
    const result = await mxFindAgents({ capability: 'orchestration', liveness: 'stale' }, deps);
    const agents = (result.result as { agents: unknown[] }).agents;
    expect(agents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Empty and malformed list payloads
// ---------------------------------------------------------------------------

describe('mxFindAgents — empty / malformed list payload', () => {
  it('empty agent.list → ok({ agents: [] })', async () => {
    const deps = makeDeps({ list: [] });
    const result = await mxFindAgents({}, deps);
    expect(result.status).toBe('ok');
    expect((result.result as { agents: unknown[] }).agents).toHaveLength(0);
    expectValid(result);
  });

  it('non-array agent.list response (null) → ok({ agents: [] })', async () => {
    const deps = makeDeps({ list: null });
    const result = await mxFindAgents({}, deps);
    expect(result.status).toBe('ok');
    expect((result.result as { agents: unknown[] }).agents).toHaveLength(0);
    expectValid(result);
  });

  it('non-array agent.list response (object) → ok({ agents: [] })', async () => {
    const deps = makeDeps({ list: { garbage: true } });
    const result = await mxFindAgents({}, deps);
    expect(result.status).toBe('ok');
    expectValid(result);
  });

  it('agent.list with malformed rows: valid rows kept, garbage skipped', async () => {
    const rows = [ROW_A_ACTIVE, 'not-an-object', null, ROW_B_STALE];
    const deps = makeDeps({ list: rows });
    const result = await mxFindAgents({}, deps);
    const agents = (result.result as { agents: Array<{ agent_id: string }> }).agents;
    expect(agents).toHaveLength(2);
    const ids = agents.map((a) => a.agent_id).sort();
    expect(ids).toEqual(['ag_a', 'ag_b']);
  });
});

// ---------------------------------------------------------------------------
// Transport and daemon fault mapping
// ---------------------------------------------------------------------------

describe('mxFindAgents — transport fault mapping (never throws)', () => {
  it('transport timeout → errored("timeout") envelope', async () => {
    const deps = makeDeps({ list: te('timeout') });
    const result = await mxFindAgents({}, deps);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('timeout');
    expectValid(result);
  });

  it('transport connect_failed → errored("internal")', async () => {
    const deps = makeDeps({ list: te('connect_failed') });
    const result = await mxFindAgents({}, deps);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('transport rpc + daemon not_found → errored("not_found") via mapDaemonError', async () => {
    const cause = { error: { code: 'not_found' } };
    const deps = makeDeps({ list: te('rpc', 'rpc err', cause) });
    const result = await mxFindAgents({}, deps);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
    expectValid(result);
  });

  it('transport rpc + daemon policy_denied → denied("policy_denied")', async () => {
    const cause = { error: { code: 'policy_denied' } };
    const deps = makeDeps({ list: te('rpc', 'rpc err', cause) });
    const result = await mxFindAgents({}, deps);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('policy_denied');
    expectValid(result);
  });

  it('transport invalid_args → errored("invalid_args")', async () => {
    const deps = makeDeps({ list: te('invalid_args') });
    const result = await mxFindAgents({}, deps);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_args');
  });

  it('plain Error (non-TransportError) → errored("internal")', async () => {
    const deps = makeDeps({ list: new Error('unexpected') });
    const result = await mxFindAgents({}, deps);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expectValid(result);
  });

  it('every TransportErrorCode produces a valid envelope and never throws', async () => {
    const codes = ['timeout', 'not_running', 'connect_failed', 'closed', 'frame', 'protocol', 'rpc', 'invalid_args'];
    for (const code of codes) {
      const deps = makeDeps({ list: te(code) });
      const result = await mxFindAgents({}, deps);
      expect(result.status).toMatch(/^(ok|denied|error)$/);
      expectValid(result);
    }
  });
});

// ---------------------------------------------------------------------------
// RPC method assertions — only reads agent.list (and agent.tools when needed)
// ---------------------------------------------------------------------------

describe('mxFindAgents — RPC method discipline', () => {
  it('calls agent.list exactly once per invocation (no capability or liveness filter)', async () => {
    const calls: string[] = [];
    const spy: DaemonCall = {
      call: async (method) => {
        calls.push(method);
        return THREE_ROWS;
      },
    };
    await mxFindAgents({}, { daemon: spy });
    const listCalls = calls.filter((m) => m === 'agent.list');
    expect(listCalls).toHaveLength(1);
  });

  it('does NOT call agent.tools when no tool filter is requested', async () => {
    const calls: string[] = [];
    const spy: DaemonCall = {
      call: async (method) => {
        calls.push(method);
        return THREE_ROWS;
      },
    };
    await mxFindAgents({ capability: 'code_execution' }, { daemon: spy });
    expect(calls.every((m) => m !== 'agent.tools')).toBe(true);
  });

  it('calls agent.tools only for candidates that pass the cheap filters', async () => {
    // Only ag_b passes liveness=stale; ag_a (active) and ag_c (offline) should not trigger agent.tools
    const agentA = makeAgent({ agent_id: 'ag_a_no_tools', capabilities: ['code'], tools: [] });
    const agentB = makeAgent({ agent_id: 'ag_b_stale', capabilities: ['code'], tools: [] });
    const agentC = makeAgent({ agent_id: 'ag_c_offline', capabilities: ['code'], tools: [] });
    const rows = [makeRow(agentA, 'active'), makeRow(agentB, 'stale'), makeRow(agentC, 'offline')];
    const toolsCalls: string[] = [];
    const spy: DaemonCall = {
      call: async (method, params) => {
        if (method === 'agent.list') return rows;
        if (method === 'agent.tools') {
          const p = params as { agent_id: string };
          toolsCalls.push(p.agent_id);
          return { agent_id: p.agent_id, schemas: [], tools: [] };
        }
        throw new Error(`Unexpected: ${method}`);
      },
    };
    await mxFindAgents({ liveness: 'stale', tool: 'any_tool' }, { daemon: spy });
    expect(toolsCalls).toHaveLength(1);
    expect(toolsCalls[0]!).toBe('ag_b_stale');
  });

  it('issues no trust/policy/approval mutation RPCs', async () => {
    const methods: string[] = [];
    const spy: DaemonCall = {
      call: async (method) => {
        methods.push(method);
        return [];
      },
    };
    await mxFindAgents({}, { daemon: spy });
    const forbidden = ['trust.add', 'trust.revoke', 'policy.update', 'approval.decide', 'approval.grant'];
    for (const m of methods) {
      expect(forbidden.includes(m)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Projected output shape
// ---------------------------------------------------------------------------

describe('mxFindAgents — projected output shape', () => {
  it('each agent summary contains agent_id, capabilities, and liveness', async () => {
    const deps = makeDeps({ list: [ROW_A_ACTIVE] });
    const result = await mxFindAgents({}, deps);
    const [agent] = (result.result as { agents: Array<Record<string, unknown>> }).agents;
    expect(typeof agent!.agent_id).toBe('string');
    expect(Array.isArray(agent!.capabilities)).toBe(true);
    expect(typeof agent!.liveness).toBe('string');
  });

  it('the result object wraps agents in { agents: [...] }, not a bare array', async () => {
    const deps = makeDeps({ list: [ROW_A_ACTIVE] });
    const result = await mxFindAgents({}, deps);
    expect(result.status).toBe('ok');
    expect(result.result).toHaveProperty('agents');
    expect(Array.isArray(result.result)).toBe(false);
    expect(Array.isArray((result.result as Record<string, unknown>).agents)).toBe(true);
  });

  it('kind field is present in summary when the agent carries it', async () => {
    const deps = makeDeps({ list: [ROW_A_ACTIVE] });
    const result = await mxFindAgents({}, deps);
    const [agent] = (result.result as { agents: Array<Record<string, unknown>> }).agents;
    expect(agent!.kind).toBe('orchestrator');
  });

  it('kind field is absent from summary when the agent omits it', async () => {
    const agentNoKind = { agent_id: 'ag_nokind', capabilities: [], tools: [] };
    const deps = makeDeps({ list: [makeRow(agentNoKind, 'active')] });
    const result = await mxFindAgents({}, deps);
    const [agent] = (result.result as { agents: Array<Record<string, unknown>> }).agents;
    expect(Object.prototype.hasOwnProperty.call(agent, 'kind')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tool filter — { name } object entries in row.tools
// ---------------------------------------------------------------------------

describe('mxFindAgents — tool filter: { name } objects in row.tools', () => {
  it('row with { name } objects in tools resolves from the row — no agent.tools fan-out', async () => {
    const agentWithObjTools = makeAgent({
      agent_id: 'ag_obj',
      capabilities: ['code'],
      tools: [{ name: 'grep_tool' }, { name: 'build_tool' }],
    });
    const row = makeRow(agentWithObjTools, 'active');
    // If the handler incorrectly fans out, this spy would throw on agent.tools.
    const deps: HandlerDeps = {
      daemon: {
        call: async (method) => {
          if (method === 'agent.list') return [row];
          throw new Error(`Unexpected daemon method: ${method}`);
        },
      },
    };
    const result = await mxFindAgents({ tool: 'grep_tool' }, deps);
    expect(result.status).toBe('ok');
    const agents = (result.result as { agents: Array<{ agent_id: string }> }).agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]!.agent_id).toBe('ag_obj');
    expectValid(result);
  });

  it('row with { name } objects where tool is absent → not matched (from row, no fan-out)', async () => {
    const agentWithObjTools = makeAgent({
      agent_id: 'ag_obj2',
      capabilities: ['code'],
      tools: [{ name: 'other_tool' }],
    });
    const row = makeRow(agentWithObjTools, 'active');
    const deps: HandlerDeps = {
      daemon: {
        call: async (method) => {
          if (method === 'agent.list') return [row];
          throw new Error(`Unexpected daemon method: ${method}`);
        },
      },
    };
    const result = await mxFindAgents({ tool: 'grep_tool' }, deps);
    const agents = (result.result as { agents: unknown[] }).agents;
    expect(agents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tool filter — agent with no agent_id triggers fan-out that returns []
// ---------------------------------------------------------------------------

describe('mxFindAgents — tool filter: agent with no agent_id', () => {
  it('agent row missing agent_id → fan-out returns [] → not matched (never throws)', async () => {
    // No agent_id in the row agent object: resolveToolNames returns [] immediately.
    const agentNoId: Record<string, unknown> = { kind: 'worker', capabilities: ['code'], tools: [] };
    const row = makeRow(agentNoId, 'active');
    const deps = makeDeps({ list: [row], tools: {} });
    const result = await mxFindAgents({ tool: 'any_tool' }, deps);
    expect(result.status).toBe('ok');
    const agents = (result.result as { agents: unknown[] }).agents;
    expect(agents).toHaveLength(0);
    expectValid(result);
  });
});

// ---------------------------------------------------------------------------
// Determinism — same input produces the same result
// ---------------------------------------------------------------------------

describe('mxFindAgents — determinism (same input → same output)', () => {
  it('identical calls with the same mock produce identical results', async () => {
    const deps = makeDeps({ list: THREE_ROWS });
    const r1 = await mxFindAgents({ capability: 'code_execution' }, deps);
    const r2 = await mxFindAgents({ capability: 'code_execution' }, deps);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('identical calls with no filters produce identical results', async () => {
    const deps = makeDeps({ list: THREE_ROWS });
    const r1 = await mxFindAgents({}, deps);
    const r2 = await mxFindAgents({}, deps);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});
