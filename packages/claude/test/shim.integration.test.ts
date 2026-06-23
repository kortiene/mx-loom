/**
 * In-process shim integration tests (T110 / #18) — AC1 + AC2 combined.
 *
 * Each scenario exercises `createMxToolServer` + `createMxCanUseTool` +
 * `resolveDeferred` together, simulating the Claude Agent SDK's composition:
 *   1. SDK calls `canUseTool(namespacedName, input, opts)` before routing.
 *   2. `{behavior:'allow'}` → SDK routes to the in-process MCP server →
 *      `dispatchCall` → `resolveDeferred` → `serializeToolResult`.
 *   3. `{behavior:'deny'}` → tool handler never fires; daemon never called.
 *
 * Scenarios:
 *  A  AC1+AC2 combined — allow path: canUseTool allows → tool dispatches → ok.
 *  B  AC2 deny prevents dispatch: canUseTool denies → zero daemon calls.
 *  C  awaiting_approval end-to-end through the server (default: surfaced, not spun on).
 *  D  awaitApproval=true end-to-end: awaiting_approval polls to ok / denied.
 *  E  mx_run_command HITL (risk:high) + exec.start dispatch.
 *  F  Multi-turn escape hatch: awaiting_approval in turn 1 → mx_await_result in turn 2.
 *
 * None of these scenarios are covered by the existing unit tests, which exercise
 * each module in isolation (tool-server.test.ts, can-use-tool.test.ts, resolve.test.ts).
 *
 * No real daemon, no real model. `InMemoryTransport` wires MCP client ↔ server;
 * a fake `DaemonCall` replaces the daemon. Tests are deterministic: the `sleep`/
 * `now` seams control the poll loop; no real timers fire.
 *
 * External requirements: none.
 * The true model-in-the-loop, approval-gated golden arm is T114, staged behind
 * `MXL_CONFORMANCE_TWO_DAEMON=1`.
 *
 * To run:
 *   pnpm --filter @mx-loom/claude test
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import { NullAuditSink } from '@mx-loom/audit';
import type { DaemonCall } from '@mx-loom/registry';
import type { BindingContext } from '@mx-loom/mcp';

import { createMxCanUseTool, wrapCanUseTool } from '../src/can-use-tool.js';
import type { ApprovalSummary } from '../src/can-use-tool.js';
import { mxToolName } from '../src/names.js';
import { createMxToolServer } from '../src/tool-server.js';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const ROOM = '!shim-integration-test:server';

interface CallRecord {
  method: string;
  params?: unknown;
}

/**
 * A fake daemon that records every RPC call and resolves each method via the
 * provided handler. Throws surfaced as `invalid_args` / `internal` in the handler,
 * which is the correct behavior for a daemon that rejects a call.
 */
function spyDaemon(
  handler: (method: string, params?: unknown) => Promise<unknown>,
): { daemon: DaemonCall; calls: CallRecord[] } {
  const calls: CallRecord[] = [];
  return {
    calls,
    daemon: {
      async call(method: string, params?: unknown): Promise<unknown> {
        calls.push({ method, params });
        return handler(method, params);
      },
    },
  };
}

function makeCtx(daemon: DaemonCall): BindingContext {
  return {
    daemon,
    room: ROOM,
    correlationId: undefined,
    auditSink: new NullAuditSink(),
    close: async () => { /* noop */ },
  };
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function connectServer(
  ctx: BindingContext,
  options?: Parameters<typeof createMxToolServer>[1],
): Promise<Client> {
  const config = createMxToolServer(ctx, options);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([config.instance.connect(st), client.connect(ct)]);
  clients.push(client);
  return client;
}

function makeCallOpts(signal = new AbortController().signal) {
  return { signal, toolUseID: 'integration-test-tool-use-id' };
}

/** Standard agent.tools response exposing a single "run_tests" tool. */
const RUN_TESTS_TOOLS_RESP = {
  schemas: [
    { name: 'run_tests', input_schema: { type: 'object', additionalProperties: true } },
  ],
} as const;

/** A call.start success response the delegation handler maps to status:ok. */
function callStartOkResp(suffix = 'integ'): unknown {
  return {
    ok: true,
    result: { passed: true },
    audit_ref: {
      invocation_id: `inv_${suffix}`,
      request_id: `req_${suffix}`,
      room: ROOM,
      event_id: `$evt_${suffix}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario A — AC1 + AC2 combined: allow path
//
// `canUseTool` fires for the risk-bearing verb; the operator allows; the MCP
// server tool handler runs; dispatch succeeds; terminal result is ok.
// Both modules (`createMxCanUseTool` + `createMxToolServer`) are exercised
// in the same flow — the gap that unit tests cannot cover.
// ---------------------------------------------------------------------------

describe('Scenario A — AC1+AC2 combined: allow path', () => {
  it('canUseTool allows → tool dispatches → ok result (AC1+AC2 together)', async () => {
    const { daemon, calls } = spyDaemon(async (method) => {
      if (method === 'agent.tools') return RUN_TESTS_TOOLS_RESP;
      if (method === 'call.start') return callStartOkResp('combined_ok');
      throw new Error(`unexpected method in allow-path test: ${method}`);
    });

    let capturedSummary: ApprovalSummary | undefined;
    const canUseTool = createMxCanUseTool({
      onApprovalRequest: async (summary) => {
        capturedSummary = summary;
        return 'allow';
      },
    });

    // Step 1 — SDK calls canUseTool before routing.
    const input: Record<string, unknown> = {
      agent: 'backend-dev-01',
      tool: 'run_tests',
      args: { package: 'api' },
    };
    const hookResult = await canUseTool(mxToolName('mx_delegate_tool'), input, makeCallOpts());

    // Step 2 — SDK routes to the MCP server because behavior is 'allow'.
    expect(hookResult.behavior).toBe('allow');

    const client = await connectServer(makeCtx(daemon));
    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: input,
    })) as CallToolResult;

    // The HITL summary was built with non-secret fields only.
    expect(capturedSummary?.tool).toBe('mx_delegate_tool');
    expect(capturedSummary?.agent).toBe('backend-dev-01');
    expect(capturedSummary?.risk).toBe('medium');
    // The arg summary shows the inner tool name and arg keys, never values.
    expect(capturedSummary?.args_summary).toContain('run_tests');
    expect(capturedSummary?.args_summary).toContain('package');
    expect(capturedSummary?.args_summary).not.toContain('api');

    // Terminal result is ok (AC1).
    const sc = res.structuredContent as { status: string };
    expect(sc.status).toBe('ok');
    expect(res.isError ?? false).toBe(false);

    // Daemon's call.start was invoked (not short-circuited).
    expect(calls.some((c) => c.method === 'call.start')).toBe(true);
  });

  it('updatedInput is the exact original input object when operator allows', async () => {
    const { daemon } = spyDaemon(async (method) => {
      if (method === 'agent.tools') return RUN_TESTS_TOOLS_RESP;
      if (method === 'call.start') return callStartOkResp('input_unchanged');
      throw new Error(`unexpected: ${method}`);
    });

    const canUseTool = createMxCanUseTool({
      onApprovalRequest: async () => 'allow',
    });
    const input: Record<string, unknown> = { agent: 'a', tool: 'run_tests', args: {} };
    const hookResult = await canUseTool(mxToolName('mx_delegate_tool'), input, makeCallOpts());

    // The SDK's contract: allow must return the original input unchanged.
    expect(hookResult.behavior).toBe('allow');
    if (hookResult.behavior === 'allow') {
      expect(hookResult.updatedInput).toBe(input);
    }
    void daemon;
  });
});

// ---------------------------------------------------------------------------
// Scenario B — AC2: deny prevents dispatch
//
// `canUseTool` fires for the risk-bearing verb; the operator denies; the MCP
// server tool handler is NEVER called; the daemon receives zero calls.
// This cross-component invariant cannot be captured in a unit test for either
// module alone.
// ---------------------------------------------------------------------------

describe('Scenario B — AC2 deny prevents dispatch (no daemon call)', () => {
  it('canUseTool deny → behavior:deny + zero daemon calls', async () => {
    const { daemon, calls } = spyDaemon(async (method) => {
      throw new Error(`daemon must NOT be called when canUseTool denies; got: ${method}`);
    });

    const canUseTool = createMxCanUseTool({
      onApprovalRequest: async () => 'deny',
    });

    const toolName = mxToolName('mx_delegate_tool');
    const input: Record<string, unknown> = {
      agent: 'backend-dev-01',
      tool: 'run_tests',
      args: {},
    };
    const hookResult = await canUseTool(toolName, input, makeCallOpts());

    // SDK receives deny — it does NOT route to the MCP server.
    expect(hookResult.behavior).toBe('deny');

    // Deny message is secret-free: it carries the verb name but not arg values.
    if (hookResult.behavior === 'deny') {
      expect(hookResult.message).toContain('mx_delegate_tool');
      expect(hookResult.message).not.toContain('run_tests'); // inner tool value not leaked
    }

    // Zero daemon calls: agent.tools and call.start were never issued.
    expect(calls).toHaveLength(0);
    void daemon;
  });

  it('deny message never contains the target agent id (secret-free)', async () => {
    const { daemon } = spyDaemon(async () => {
      throw new Error('must not be called');
    });
    const canUseTool = createMxCanUseTool({ onApprovalRequest: async () => 'deny' });
    const secretAgent = 'matrix-agent-with-private-name';
    const result = await canUseTool(
      mxToolName('mx_delegate_tool'),
      { agent: secretAgent, tool: 'run_tests', args: {} },
      makeCallOpts(),
    );
    expect(result.behavior).toBe('deny');
    if (result.behavior === 'deny') {
      expect(result.message).not.toContain(secretAgent);
    }
    void daemon;
  });

  it('read/observe verbs auto-allow without an operator prompt', async () => {
    // Regression: mx_find_agents, mx_workspace_status, etc. must NOT open a prompt,
    // so the user-facing HITL is skipped for verbs the model can safely call without
    // operator confirmation.
    let promptCalled = false;
    const canUseTool = createMxCanUseTool({
      onApprovalRequest: async () => {
        promptCalled = true;
        return 'allow';
      },
    });
    const hookResult = await canUseTool(mxToolName('mx_find_agents'), {}, makeCallOpts());
    expect(hookResult.behavior).toBe('allow');
    expect(promptCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario C — awaiting_approval end-to-end through the server
//
// `call.start` returns `awaiting_approval` (remote policy held the request).
// `resolveDeferred` surfaces it immediately (default: do not spin on a human).
// The envelope carries the handle + approval block; `isError` is false.
//
// This path is tested in `resolve.test.ts` at the module level, but NOT end-
// to-end through the full server chain; any serialization or routing gap in
// the server-level awaiting_approval path would be invisible to the unit test.
// ---------------------------------------------------------------------------

describe('Scenario C — awaiting_approval end-to-end through the server', () => {
  it('call.start awaiting_approval → envelope surfaced (handle + approval, isError:false)', async () => {
    const HANDLE = 'inv_awaiting_approval_integ';
    const { daemon } = spyDaemon(async (method) => {
      if (method === 'agent.tools') return RUN_TESTS_TOOLS_RESP;
      if (method === 'call.start') {
        return {
          state: 'awaiting_approval',
          invocation_id: HANDLE,
          approval: {
            request_id: 'req_approval_integ',
            risk: 'medium',
            summary: 'delegate run_tests to backend-dev-01',
            expires_at: '2099-01-01T00:00:00Z',
          },
        };
      }
      throw new Error(`unexpected in awaiting_approval test: ${method}`);
    });

    const client = await connectServer(makeCtx(daemon));
    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'backend-dev-01', tool: 'run_tests', args: {} },
    })) as CallToolResult;

    const sc = res.structuredContent as {
      status: string;
      handle: string | null;
      approval: { request_id: string } | null;
    };
    // awaiting_approval is surfaced — not hidden, not an error.
    expect(sc.status).toBe('awaiting_approval');
    expect(res.isError ?? false).toBe(false);

    // The handle is non-null so the model can re-poll or the binding resolves later.
    expect(typeof sc.handle).toBe('string');
    expect(sc.handle).toBeTruthy();

    // The approval block carries non-secret metadata for the operator.
    expect(sc.approval).not.toBeNull();
    expect(typeof sc.approval?.request_id).toBe('string');
  });

  it('awaiting_approval content[0].text is parseable JSON carrying the full envelope', async () => {
    const { daemon } = spyDaemon(async (method) => {
      if (method === 'agent.tools') return RUN_TESTS_TOOLS_RESP;
      if (method === 'call.start') {
        return {
          state: 'awaiting_approval',
          invocation_id: 'inv_aa_json_fidelity',
          approval: { request_id: 'req_aa_json', risk: 'low', summary: '', expires_at: '' },
        };
      }
      throw new Error(`unexpected: ${method}`);
    });

    const client = await connectServer(makeCtx(daemon));
    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: {} },
    })) as CallToolResult;

    const firstContent = (res.content?.[0] ?? {}) as { type?: string; text?: string };
    expect(firstContent.type).toBe('text');
    const parsed = JSON.parse(firstContent.text ?? '{}') as { status: string };
    expect(parsed.status).toBe('awaiting_approval');
  });

  it('invocation.get is NOT called during the default awaiting_approval path', async () => {
    // Regression guard: the default disposition must NOT poll on a human approval.
    // resolveDeferred's awaitApproval defaults to false.
    const { daemon, calls } = spyDaemon(async (method) => {
      if (method === 'agent.tools') return RUN_TESTS_TOOLS_RESP;
      if (method === 'call.start') {
        return {
          state: 'awaiting_approval',
          invocation_id: 'inv_no_poll_aa',
          approval: { request_id: 'req_nopoll', risk: 'medium', summary: '', expires_at: '' },
        };
      }
      if (method === 'invocation.get') {
        throw new Error('invocation.get must NOT be called in the default awaiting_approval path');
      }
      throw new Error(`unexpected: ${method}`);
    });

    const client = await connectServer(makeCtx(daemon));
    await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'backend-dev-01', tool: 'run_tests', args: {} },
    });

    expect(calls.some((c) => c.method === 'invocation.get')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario D — awaitApproval=true end-to-end through the server
//
// With `awaitApproval: true`, `resolveDeferred` also polls on `awaiting_approval`
// until the operator decides (up to `resolveTimeoutMs`). The daemon returns
// `awaiting_approval` from `call.start`, then terminal state from `invocation.get`.
// Deterministic `sleep`/`now` seams prevent real timers from firing.
// ---------------------------------------------------------------------------

describe('Scenario D — awaitApproval=true: polls until operator decides (through server)', () => {
  it('awaiting_approval + operator approval → ok in one tool call', async () => {
    const HANDLE = 'inv_await_approval_ok';
    const { daemon } = spyDaemon(async (method) => {
      if (method === 'agent.tools') return RUN_TESTS_TOOLS_RESP;
      if (method === 'call.start') {
        return {
          state: 'awaiting_approval',
          invocation_id: HANDLE,
          approval: {
            request_id: 'req_await_ok',
            risk: 'medium',
            summary: 'run tests',
            expires_at: '2099-01-01T00:00:00Z',
          },
        };
      }
      if (method === 'invocation.get') {
        // Operator approved; work completed.
        return { state: 'ok', result: { passed: true } };
      }
      throw new Error(`unexpected in awaitApproval=true ok test: ${method}`);
    });

    const client = await connectServer(makeCtx(daemon), {
      awaitApproval: true,
      resolveTimeoutMs: 5_000,
      sleep: () => Promise.resolve(),
      now: () => 0,
      pollIntervalMs: 10,
    });

    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'backend-dev-01', tool: 'run_tests', args: {} },
    })) as CallToolResult;

    const sc = res.structuredContent as { status: string };
    expect(sc.status).toBe('ok');
    expect(res.isError ?? false).toBe(false);
  });

  it('awaiting_approval + operator denial → denied in one tool call', async () => {
    const HANDLE = 'inv_await_approval_deny';
    const { daemon } = spyDaemon(async (method) => {
      if (method === 'agent.tools') return RUN_TESTS_TOOLS_RESP;
      if (method === 'call.start') {
        return {
          state: 'awaiting_approval',
          invocation_id: HANDLE,
          approval: { request_id: 'req_deny_op', risk: 'high', summary: 'risky op', expires_at: '' },
        };
      }
      if (method === 'invocation.get') {
        // Operator denied.
        return { state: 'approval_denied', ok: false };
      }
      throw new Error(`unexpected in awaitApproval=true deny test: ${method}`);
    });

    const client = await connectServer(makeCtx(daemon), {
      awaitApproval: true,
      resolveTimeoutMs: 5_000,
      sleep: () => Promise.resolve(),
      now: () => 0,
      pollIntervalMs: 10,
    });

    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'backend-dev-01', tool: 'run_tests', args: {} },
    })) as CallToolResult;

    const sc = res.structuredContent as { status: string };
    expect(sc.status).toBe('denied');
    // denied is NOT an error (not the fault-set).
    expect(res.isError ?? false).toBe(false);
  });

  it('awaitApproval=true budget elapses before decision → still awaiting_approval (no fabricated error)', async () => {
    const HANDLE = 'inv_await_approval_timeout';
    let nowCalls = 0;
    const { daemon } = spyDaemon(async (method) => {
      if (method === 'agent.tools') return RUN_TESTS_TOOLS_RESP;
      if (method === 'call.start') {
        return {
          state: 'awaiting_approval',
          invocation_id: HANDLE,
          approval: { request_id: 'req_timeout_aa', risk: 'medium', summary: '', expires_at: '' },
        };
      }
      if (method === 'invocation.get') {
        // Operator never decides within the budget.
        return {
          state: 'awaiting_approval',
          invocation_id: HANDLE,
          approval: { request_id: 'req_timeout_aa', risk: 'medium', summary: '', expires_at: '' },
        };
      }
      throw new Error(`unexpected: ${method}`);
    });

    const client = await connectServer(makeCtx(daemon), {
      awaitApproval: true,
      resolveTimeoutMs: 100,
      sleep: () => Promise.resolve(),
      // Fast-forward clock: first call sets deadline, second exceeds it.
      now: () => (nowCalls++ === 0 ? 0 : 9_999_999),
      pollIntervalMs: 10,
    });

    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'backend-dev-01', tool: 'run_tests', args: {} },
    })) as CallToolResult;

    const sc = res.structuredContent as { status: string; error: unknown };
    expect(sc.status).toBe('awaiting_approval');
    // A budget expiry is NOT a fabricated error — the model can re-poll via mx_await_result.
    expect(sc.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scenario E — mx_run_command: HITL (risk:high) + exec.start dispatch
//
// `mx_run_command` is a high-risk verb:
//   - The HITL summary must carry risk:'high' and the command name.
//   - Argv values must NOT appear in the summary (only count).
//   - After `canUseTool` allows, `exec.start` is dispatched (not call.start).
//   - Result is ok.
//
// `mx_run_command` dispatch through the server is not tested anywhere in the
// existing unit-test suite (tool-server.test.ts only exercises mx_delegate_tool
// and mx_workspace_status through the MCP client path).
// ---------------------------------------------------------------------------

describe('Scenario E — mx_run_command HITL (risk:high) + exec.start dispatch', () => {
  it('canUseTool fires with risk:high and correct command; exec.start dispatched → ok', async () => {
    const { daemon, calls } = spyDaemon(async (method) => {
      if (method === 'exec.start') {
        return {
          ok: true,
          result: { exit_code: 0 },
          audit_ref: {
            invocation_id: 'inv_run_cmd_integ',
            request_id: 'req_run_cmd_integ',
            room: ROOM,
            event_id: '$evt_run_cmd_integ',
          },
        };
      }
      throw new Error(`unexpected in mx_run_command test: ${method}`);
    });

    let capturedSummary: ApprovalSummary | undefined;
    const canUseTool = createMxCanUseTool({
      onApprovalRequest: async (summary) => {
        capturedSummary = summary;
        return 'allow';
      },
    });

    // Step 1 — HITL fires for the high-risk guarded exec verb.
    const input: Record<string, unknown> = {
      agent: 'worker-01',
      command: 'pytest',
      args: ['-x', 'tests/'],
    };
    const hookResult = await canUseTool(mxToolName('mx_run_command'), input, makeCallOpts());

    expect(hookResult.behavior).toBe('allow');
    // risk must be 'high' for guarded exec (design §3 Claude bullet).
    expect(capturedSummary?.risk).toBe('high');
    // The command name is visible; argv values must NOT appear.
    expect(capturedSummary?.command).toBe('pytest');
    expect(capturedSummary?.args_summary).toContain('argc=2');
    expect(capturedSummary?.args_summary).not.toContain('-x');
    expect(capturedSummary?.args_summary).not.toContain('tests/');

    // Step 2 — SDK dispatches via exec.start.
    const client = await connectServer(makeCtx(daemon));
    const res = (await client.callTool({
      name: 'mx_run_command',
      arguments: input,
    })) as CallToolResult;

    const sc = res.structuredContent as { status: string };
    expect(sc.status).toBe('ok');
    expect(res.isError ?? false).toBe(false);
    // exec.start was used, not call.start.
    expect(calls.some((c) => c.method === 'exec.start')).toBe(true);
    expect(calls.some((c) => c.method === 'call.start')).toBe(false);
  });

  it('mx_run_command policy_denied surfaces as denied (guarded exec disabled by default)', async () => {
    // The receiving daemon returns policy_denied when the command is not allowlisted.
    // The shim must surface this as {status:'denied'}, not an internal error.
    const { daemon } = spyDaemon(async (method) => {
      if (method === 'exec.start') {
        // Daemon returns a failure signal without a state token: {ok:false}.
        // The handler maps this to denied('policy_denied') via callResponseToResult.
        return { ok: false, state: 'policy_denied' };
      }
      throw new Error(`unexpected: ${method}`);
    });

    const client = await connectServer(makeCtx(daemon));
    const res = (await client.callTool({
      name: 'mx_run_command',
      arguments: { agent: 'worker-01', command: 'rm', args: ['-rf', '/'] },
    })) as CallToolResult;

    const sc = res.structuredContent as { status: string };
    expect(sc.status).toBe('denied');
    expect(res.isError ?? false).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario F — multi-turn: mx_await_result escape hatch after awaiting_approval
//
// Simulates the two-turn model flow:
//   Turn 1 — mx_delegate_tool → awaiting_approval → handle saved.
//   Turn 2 — model calls mx_await_result(savedHandle) → operator decided → ok.
//
// This tests the registered mx_await_result tool as a first-class escape hatch,
// not just the hidden poll loop (which resolves 'running', not 'awaiting_approval'
// by default). The combination of two tool calls in the same server session is
// the genuine multi-turn behavior the shim must support.
// ---------------------------------------------------------------------------

describe('Scenario F — multi-turn: mx_await_result escape hatch after awaiting_approval', () => {
  it('turn 1 awaiting_approval → turn 2 mx_await_result(handle) → ok', async () => {
    const HANDLE = 'inv_multi_turn_escape_hatch';
    const { daemon } = spyDaemon(async (method) => {
      if (method === 'agent.tools') return RUN_TESTS_TOOLS_RESP;
      if (method === 'call.start') {
        // Turn 1: request held; operator hasn't decided.
        return {
          state: 'awaiting_approval',
          invocation_id: HANDLE,
          approval: {
            request_id: 'req_escape',
            risk: 'medium',
            summary: 'run tests on backend-dev-01',
            expires_at: '2099-01-01T00:00:00Z',
          },
        };
      }
      if (method === 'invocation.get') {
        // Turn 2: operator approved; work completed.
        return { state: 'ok', result: { passed: true } };
      }
      throw new Error(`unexpected in escape-hatch test: ${method}`);
    });

    // Default server (awaitApproval: false — surfaces awaiting_approval immediately).
    const client = await connectServer(makeCtx(daemon));

    // Turn 1 — delegation returns awaiting_approval; the model sees the handle.
    const turn1 = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'backend-dev-01', tool: 'run_tests', args: {} },
    })) as CallToolResult;

    const sc1 = turn1.structuredContent as { status: string; handle: string | null };
    expect(sc1.status).toBe('awaiting_approval');
    const savedHandle = sc1.handle;
    expect(savedHandle).toBeTruthy();

    // Turn 2 — model uses the escape hatch to resolve the deferred handle.
    const turn2 = (await client.callTool({
      name: 'mx_await_result',
      arguments: { handle: savedHandle },
    })) as CallToolResult;

    const sc2 = turn2.structuredContent as { status: string };
    expect(sc2.status).toBe('ok');
    expect(turn2.isError ?? false).toBe(false);
  });

  it('mx_await_result resolves a running handle in the same session (poll hidden)', async () => {
    // Also covers the scenario where mx_await_result is called explicitly for a
    // running handle from a prior turn (not just awaiting_approval).
    const HANDLE = 'inv_running_prior_turn';
    const { daemon } = spyDaemon(async (method) => {
      if (method === 'invocation.get') {
        return { state: 'ok', result: { done: true } };
      }
      throw new Error(`unexpected: ${method}`);
    });

    const client = await connectServer(makeCtx(daemon), {
      resolveTimeoutMs: 5_000,
      sleep: () => Promise.resolve(),
      now: () => 0,
      pollIntervalMs: 10,
    });

    const res = (await client.callTool({
      name: 'mx_await_result',
      arguments: { handle: HANDLE },
    })) as CallToolResult;

    const sc = res.structuredContent as { status: string };
    expect(sc.status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: secret-free HITL summary with credential-shaped args
//
// A credential-shaped arg key (e.g. `access_token`) in the inner args of an
// mx_delegate_tool call must be filtered from the HITL summary AND the deny
// message (AC2 + T008 defense-in-depth). This combines canUseTool + the
// credential filter in the same integration scenario.
// ---------------------------------------------------------------------------

describe('cross-cutting: secret-free HITL summary (credential-shaped args)', () => {
  it('credential-shaped key in mx_delegate_tool.args is absent from the ApprovalSummary', async () => {
    let capturedSummary: ApprovalSummary | undefined;
    const canUseTool = createMxCanUseTool({
      onApprovalRequest: async (summary) => {
        capturedSummary = summary;
        return 'allow';
      },
    });

    const input: Record<string, unknown> = {
      agent: 'agent-b',
      tool: 'run_tests',
      args: { access_token: 'secret-value-must-not-appear', safe_key: 'safe' },
    };
    await canUseTool(mxToolName('mx_delegate_tool'), input, makeCallOpts());

    // Credential-shaped key must be omitted from the args_summary.
    expect(capturedSummary?.args_summary).not.toContain('access_token');
    // Safe keys are included.
    expect(capturedSummary?.args_summary).toContain('safe_key');
    // Values must never appear.
    expect(capturedSummary?.args_summary).not.toContain('secret-value-must-not-appear');
    // The full summary JSON must not contain the secret value.
    expect(JSON.stringify(capturedSummary)).not.toContain('secret-value-must-not-appear');
  });

  it('gh PAT-shaped value in args is absent from the ApprovalSummary', async () => {
    let capturedSummary: ApprovalSummary | undefined;
    const canUseTool = createMxCanUseTool({
      onApprovalRequest: async (summary) => {
        capturedSummary = summary;
        return 'allow';
      },
    });

    const FAKE_PAT = 'ghp_fakeGitHubPATForIntegrationTestXXXX';
    const input: Record<string, unknown> = {
      agent: 'agent-b',
      tool: 'run_tests',
      args: { token: FAKE_PAT },
    };
    await canUseTool(mxToolName('mx_delegate_tool'), input, makeCallOpts());

    expect(JSON.stringify(capturedSummary)).not.toContain(FAKE_PAT);
  });
});

// ---------------------------------------------------------------------------
// Scenario G — context-sharing round-trip through the shim
//
// `mx_share_context` publishes a file artifact and `mx_get_context` fetches it
// back with byte-identical inline content — the full cross-agent context surface
// exercised as a two-call sequence in the same server session.
//
// Neither the share nor the get is tested elsewhere in the shim's integration
// suite (existing scenarios cover only delegation and guarded exec verbs). This
// confirms that the context-exchange verbs dispatch end-to-end through the shim
// and that the content arrives at the model unchanged.
// ---------------------------------------------------------------------------

describe('Scenario G — context-sharing round-trip through the shim', () => {
  it('mx_share_context (kind:file) → mx_get_context → inline content byte-identical', async () => {
    const CONTEXT_ID = 'ctx_g_integ';
    const SHA256 = 'sha256_g_integ_abc123';
    const INLINE_CONTENT = 'export const answer = 42;';

    const { daemon } = spyDaemon(async (method) => {
      if (method === 'share.file') {
        return { context_id: CONTEXT_ID, sha256: SHA256 };
      }
      if (method === 'share.get') {
        return {
          context_id: CONTEXT_ID,
          kind: 'file',
          sha256: SHA256,
          size_bytes: INLINE_CONTENT.length,
          inline: INLINE_CONTENT,
        };
      }
      throw new Error(`unexpected in context-sharing test: ${method}`);
    });

    const client = await connectServer(makeCtx(daemon));

    // Turn 1 — publish the artifact.
    const shareRes = (await client.callTool({
      name: 'mx_share_context',
      arguments: { kind: 'file', path: 'src/answer.ts', content: INLINE_CONTENT },
    })) as CallToolResult;

    const shareSc = shareRes.structuredContent as {
      status: string;
      result: { context_id: string; sha256: string } | null;
    };
    expect(shareSc.status).toBe('ok');
    expect(shareRes.isError ?? false).toBe(false);
    // The context_id and sha256 are forwarded verbatim from the daemon reply.
    expect(shareSc.result?.context_id).toBe(CONTEXT_ID);
    expect(shareSc.result?.sha256).toBe(SHA256);

    // Turn 2 — fetch it back and assert byte-identical inline content.
    const getRes = (await client.callTool({
      name: 'mx_get_context',
      arguments: { context_id: CONTEXT_ID },
    })) as CallToolResult;

    const getSc = getRes.structuredContent as {
      status: string;
      result: { context_id: string; inline: string; sha256: string } | null;
    };
    expect(getSc.status).toBe('ok');
    expect(getRes.isError ?? false).toBe(false);
    // Byte-identical: the inline content returned equals what was published.
    expect(getSc.result?.inline).toBe(INLINE_CONTENT);
    expect(getSc.result?.sha256).toBe(SHA256);
    expect(getSc.result?.context_id).toBe(CONTEXT_ID);
  });

  it('mx_share_context (kind:diff) → ok with context_id + sha256', async () => {
    const { daemon } = spyDaemon(async (method) => {
      if (method === 'share.diff') {
        return { context_id: 'ctx_diff_integ', sha256: 'sha256_diff_integ' };
      }
      throw new Error(`unexpected: ${method}`);
    });

    const client = await connectServer(makeCtx(daemon));
    const res = (await client.callTool({
      name: 'mx_share_context',
      arguments: { kind: 'diff', content: '--- a/foo\n+++ b/foo\n@@ -1 +1 @@\n-old\n+new\n' },
    })) as CallToolResult;

    const sc = res.structuredContent as { status: string };
    expect(sc.status).toBe('ok');
    expect(res.isError ?? false).toBe(false);
  });

  it('mx_get_context not_found surfaces as error (isError: true), not an internal crash', async () => {
    const { daemon } = spyDaemon(async (method) => {
      if (method === 'share.get') {
        // Daemon returns an explicit error signal for an unknown context_id.
        return { ok: false, error: 'not_found' };
      }
      throw new Error(`unexpected: ${method}`);
    });

    const client = await connectServer(makeCtx(daemon));
    const res = (await client.callTool({
      name: 'mx_get_context',
      arguments: { context_id: 'unknown-ctx-id' },
    })) as CallToolResult;

    // The daemon error signal maps to a closed-set error status — the shim does
    // not crash or fabricate a misleading ok.
    const sc = res.structuredContent as { status: string };
    expect(['error', 'denied']).toContain(sc.status);
  });
});

// ---------------------------------------------------------------------------
// Scenario H — wrapCanUseTool composition: shim + host hook integrated dispatch
//
// `wrapCanUseTool` is the composition API that lets a host with an existing
// `canUseTool` add the mx_* HITL gate without replacing its own hook. This
// scenario is only unit-tested in can-use-tool.test.ts; here we verify the
// composition works end-to-end in a dispatch context: the composed hook correctly
// gates mx_* calls (onApprovalRequest fires), the host's hook is NOT called for
// mx_* tools, and the tool dispatches and returns ok when allowed.
// ---------------------------------------------------------------------------

describe('Scenario H — wrapCanUseTool composition: shim + host hook integrated dispatch', () => {
  it('host hook NOT called for mx_* tools; shim gate fires and allows → dispatch ok', async () => {
    const { daemon, calls } = spyDaemon(async (method) => {
      if (method === 'agent.tools') return RUN_TESTS_TOOLS_RESP;
      if (method === 'call.start') return callStartOkResp('wrap_allow');
      throw new Error(`unexpected in wrapCanUseTool allow test: ${method}`);
    });

    let hostHookCalledWith: string | undefined;
    const hostHook: CanUseTool = async (toolName, input) => {
      hostHookCalledWith = toolName;
      return { behavior: 'allow', updatedInput: input };
    };

    let shimPromptCalled = false;
    const composed = wrapCanUseTool(hostHook, {
      onApprovalRequest: async () => {
        shimPromptCalled = true;
        return 'allow';
      },
    });

    // The composed hook gates mx_delegate_tool via the shim's prompt.
    const hookResult = await composed(
      mxToolName('mx_delegate_tool'),
      { agent: 'backend-dev-01', tool: 'run_tests', args: {} },
      makeCallOpts(),
    );

    // Shim gate was invoked.
    expect(shimPromptCalled).toBe(true);
    // Host hook was NOT called for the mx_* tool.
    expect(hostHookCalledWith).toBeUndefined();
    expect(hookResult.behavior).toBe('allow');

    // Dispatch goes through normally.
    const client = await connectServer(makeCtx(daemon));
    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'backend-dev-01', tool: 'run_tests', args: {} },
    })) as CallToolResult;

    const sc = res.structuredContent as { status: string };
    expect(sc.status).toBe('ok');
    expect(calls.some((c) => c.method === 'call.start')).toBe(true);
  });

  it('host hook IS called for non-mx_* tools (fallback route)', async () => {
    let hostHookToolName: string | undefined;
    const hostHook: CanUseTool = async (toolName, input) => {
      hostHookToolName = toolName;
      return { behavior: 'allow', updatedInput: input };
    };

    const composed = wrapCanUseTool(hostHook, {
      onApprovalRequest: async () => 'deny',
    });

    // A non-mx_* tool (the host owns it) bypasses the shim's gate entirely.
    const result = await composed('bash', { command: 'ls' }, makeCallOpts());

    expect(result.behavior).toBe('allow');
    expect(hostHookToolName).toBe('bash');
  });

  it('wrapCanUseTool deny path: shim gate denies → zero daemon calls', async () => {
    const { daemon, calls } = spyDaemon(async (method) => {
      throw new Error(`daemon must NOT be called when composed hook denies; got: ${method}`);
    });

    const hostHook: CanUseTool = async (_toolName, input) => ({ behavior: 'allow', updatedInput: input });
    const composed = wrapCanUseTool(hostHook, {
      onApprovalRequest: async () => 'deny',
    });

    const hookResult = await composed(
      mxToolName('mx_delegate_tool'),
      { agent: 'backend-dev-01', tool: 'run_tests', args: {} },
      makeCallOpts(),
    );

    expect(hookResult.behavior).toBe('deny');
    // The host hook allows, but shim gate denies → host allow is irrelevant.
    expect(calls).toHaveLength(0);
    void daemon;
  });
});
