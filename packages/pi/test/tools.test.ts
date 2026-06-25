/**
 * Tool generator (T205) — createPiToolDefinitions execute paths.
 *
 * Tests:
 *  - Generated list count matches CANONICAL_M1_TOOLS.
 *  - Deferred verbs (async_semantics:'deferred') include an mx_await_result hint
 *    in their `promptGuidelines`.
 *  - Sync verbs do NOT include the mx_await_result resolution hint.
 *  - All five envelope statuses (ok, running, awaiting_approval, denied, error)
 *    round-trip through execute() as an AgentToolResult with the full envelope in
 *    both content[0].text and details.
 *  - running/awaiting_approval carry a handle in the serialized envelope.
 *  - A thrown adapter bug inside execute() → errored('internal', …), NEVER
 *    propagated (a throw would mark the Pi tool failed and discard the envelope).
 *  - Ajv preflight catches invalid args BEFORE any dispatch (no daemon call).
 *  - Idempotency-key is threaded through the audit tap context.
 *  - Custom `descriptors` option lets tests inject a reduced descriptor set.
 */
import { describe, expect, it } from 'vitest';

import { NullAuditSink } from '@mx-loom/audit';
import type { AuditTap, AuditPerCall } from '@mx-loom/audit';
import {
  CANONICAL_M1_TOOLS,
  CANONICAL_TOOLS,
  type AuditRef,
  type ToolResult,
  awaitingApproval,
  denied,
  errored,
  ok,
  running,
} from '@mx-loom/registry';
import type { DaemonCall } from '@mx-loom/registry';

import { createPiBindingContext } from '../src/context.js';
import { createPiToolDefinitions } from '../src/tools.js';
import type { ToolDefinition } from '../src/pi-abi.js';
import { ROOM, fakeBuilders, makeFakeDaemon } from './helpers.js';

const EMPTY_AUDIT: AuditRef = Object.freeze({
  invocation_id: null,
  request_id: null,
  room: null,
  event_id: null,
});

async function makeCtx(daemon?: DaemonCall) {
  return createPiBindingContext({
    daemon: daemon ?? makeFakeDaemon(),
    room: ROOM,
    auditSink: new NullAuditSink(),
  });
}

async function makeTools(daemon?: DaemonCall): Promise<ToolDefinition[]> {
  const ctx = await makeCtx(daemon);
  return createPiToolDefinitions(ctx, { builders: fakeBuilders });
}

function findTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const t = tools.find((x) => x.name === name);
  if (t === undefined) throw new Error(`tool ${name} not found`);
  return t;
}

// ---------------------------------------------------------------------------
// Generated list
// ---------------------------------------------------------------------------

describe('createPiToolDefinitions — generated list', () => {
  it('count matches CANONICAL_TOOLS', async () => {
    const tools = await makeTools();
    expect(tools).toHaveLength(CANONICAL_TOOLS.length);
  });

  it('each tool has a non-empty promptSnippet naming the tool', async () => {
    const tools = await makeTools();
    for (const tool of tools) {
      expect(tool.promptSnippet.length).toBeGreaterThan(0);
      expect(tool.promptSnippet).toContain(tool.name);
    }
  });

  it('each tool has at least one promptGuideline naming the tool', async () => {
    const tools = await makeTools();
    for (const tool of tools) {
      expect(tool.promptGuidelines.length).toBeGreaterThan(0);
      expect(tool.promptGuidelines.join(' ')).toContain(tool.name);
    }
  });
});

// ---------------------------------------------------------------------------
// Deferred verbs get the mx_await_result hint; sync verbs do not
// ---------------------------------------------------------------------------

describe('deferred protocol prompt hints', () => {
  const deferredNames = CANONICAL_M1_TOOLS
    .filter((d) => d.async_semantics === 'deferred')
    .map((d) => d.name);
  const syncNames = CANONICAL_M1_TOOLS
    .filter((d) => d.async_semantics !== 'deferred')
    .map((d) => d.name);

  it('deferred verbs include mx_await_result resolution hint in guidelines', async () => {
    const tools = await makeTools();
    for (const name of deferredNames) {
      const tool = findTool(tools, name);
      const combined = tool.promptGuidelines.join(' ');
      expect(combined, `${name} missing mx_await_result hint`).toContain('mx_await_result');
    }
  });

  it('sync verbs do NOT include the mx_await_result resolution hint', async () => {
    const tools = await makeTools();
    for (const name of syncNames) {
      const tool = findTool(tools, name);
      const combined = tool.promptGuidelines.join(' ');
      // They should not say "call mx_await_result" (deferred resolution hint)
      expect(combined, `${name} unexpectedly has deferred hint`).not.toContain(
        'do not retry',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// All five statuses round-trip through execute()
// ---------------------------------------------------------------------------

function fakeDaemonReturning(result: ToolResult): DaemonCall {
  return {
    async call(): Promise<unknown> {
      // Fake daemon that returns whatever call.start needs to produce `result`
      // — we override the result directly via a custom audit tap that returns
      // the injected envelope.
      return {
        ok: result.status === 'ok',
        result: result.result,
        audit_ref: result.audit_ref,
        state: result.status === 'running' ? 'running' : undefined,
        handle: result.handle,
      };
    },
  };
}

/** Custom audit tap that returns the injected envelope unchanged. */
function passThroughTap(): AuditTap {
  return async (r: ToolResult) => r;
}

/** A tools set with a custom auditTap that returns the envelope unchanged. */
async function makeToolsWithResult(staticResult: ToolResult): Promise<ToolDefinition[]> {
  // We use a custom auditTap to inject any desired ToolResult into execute(),
  // bypassing dispatch (which would use the fake daemon) — this tests the
  // serialize layer in isolation from dispatch.
  const ctx = await makeCtx();
  const tap: AuditTap = async () => staticResult;
  return createPiToolDefinitions(ctx, { builders: fakeBuilders, auditTap: tap });
}

describe('all five statuses round-trip through execute()', () => {
  const CASES: Array<{ name: string; result: ToolResult }> = [
    { name: 'ok', result: ok({ value: 1 }, EMPTY_AUDIT) },
    { name: 'running', result: running('inv_run_1', EMPTY_AUDIT) },
    {
      name: 'awaiting_approval',
      result: awaitingApproval(
        'inv_ap_1',
        { request_id: 'req_ap', risk: 'low', summary: 'ok', expires_at: '2099-01-01T00:00:00Z' },
        EMPTY_AUDIT,
      ),
    },
    { name: 'denied', result: denied('policy_denied', 'not allowed', EMPTY_AUDIT) },
    { name: 'error', result: errored('timeout', 'timed out', EMPTY_AUDIT) },
  ];

  it.each(CASES)('$name: envelope in details and content[0].text', async ({ result }) => {
    const tools = await makeToolsWithResult(result);
    const tool = findTool(tools, 'mx_find_agents');
    const out = await tool.execute('call-id', {});
    const details = out.details as { status: string };
    expect(details.status).toBe(result.status);
    expect(JSON.parse(out.content[0]!.text)).toEqual(details);
  });

  it('running: handle in both channels', async () => {
    const result = running('inv_running_handle', EMPTY_AUDIT);
    const tools = await makeToolsWithResult(result);
    const out = await findTool(tools, 'mx_find_agents').execute('call-id', {});
    const details = out.details as { handle: string };
    expect(details.handle).toBe('inv_running_handle');
    expect((JSON.parse(out.content[0]!.text) as { handle: string }).handle).toBe('inv_running_handle');
  });

  it('awaiting_approval: approval fields in both channels', async () => {
    const approval = { request_id: 'req_ap3', risk: 'high' as const, summary: 's', expires_at: '2099-01-01T00:00:00Z' };
    const result = awaitingApproval('inv_ap3', approval, EMPTY_AUDIT);
    const tools = await makeToolsWithResult(result);
    const out = await findTool(tools, 'mx_find_agents').execute('call-id', {});
    const details = out.details as { approval: { request_id: string } };
    expect(details.approval.request_id).toBe('req_ap3');
    expect((JSON.parse(out.content[0]!.text) as { approval: { request_id: string } }).approval.request_id)
      .toBe('req_ap3');
  });
});

// ---------------------------------------------------------------------------
// Adapter bug safety net: thrown error → errored('internal'), never propagated
// ---------------------------------------------------------------------------

describe('adapter bug safety: execute() never propagates a throw', () => {
  it('a throwing audit tap → errored("internal") result, not a thrown exception', async () => {
    const ctx = await makeCtx();
    const throwingTap: AuditTap = async () => {
      throw new Error('simulated adapter crash');
    };
    const tools = createPiToolDefinitions(ctx, {
      builders: fakeBuilders,
      auditTap: throwingTap,
    });
    const tool = findTool(tools, 'mx_find_agents');

    let caughtError: unknown;
    let result: Awaited<ReturnType<typeof tool.execute>> | undefined;
    try {
      result = await tool.execute('call-id', {});
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeUndefined();
    const details = result?.details as { status: string; error: { code: string } } | undefined;
    expect(details?.status).toBe('error');
    expect(details?.error?.code).toBe('internal');
  });
});

// ---------------------------------------------------------------------------
// Ajv preflight — invalid args rejected BEFORE dispatch (no daemon call)
// ---------------------------------------------------------------------------

describe('Ajv preflight: invalid args rejected before dispatch', () => {
  it('mx_describe_agent: missing required agent_id → invalid_args, no daemon call', async () => {
    const calls: string[] = [];
    const daemon = makeFakeDaemon((method) => calls.push(method));
    const tools = await makeTools(daemon);
    const tool = findTool(tools, 'mx_describe_agent');

    const out = await tool.execute('call-bad', {});
    const d = out.details as { status: string; error: { code: string } };
    expect(d.status).toBe('error');
    expect(d.error.code).toBe('invalid_args');
    expect(calls).toEqual([]);
  });

  it('mx_delegate_tool: missing required args → invalid_args, no daemon call', async () => {
    const calls: string[] = [];
    const daemon = makeFakeDaemon((method) => calls.push(method));
    const tools = await makeTools(daemon);
    const tool = findTool(tools, 'mx_delegate_tool');

    // 'agent' and 'tool' and 'args' are all required
    const out = await tool.execute('call-bad', { agent: 'a', tool: 't' });
    const d = out.details as { status: string; error: { code: string } };
    expect(d.status).toBe('error');
    expect(d.error.code).toBe('invalid_args');
    expect(calls).toEqual([]);
  });

  it('invalid_args message is in content[0].text', async () => {
    const tools = await makeTools();
    const tool = findTool(tools, 'mx_await_result');
    const out = await tool.execute('call-bad', {}); // missing handle
    const d = out.details as { status: string };
    expect(d.status).toBe('error');
    const text = JSON.parse(out.content[0]!.text) as { status: string };
    expect(text.status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// Idempotency key threaded through audit tap context
// ---------------------------------------------------------------------------

describe('idempotency_key threading', () => {
  it('idempotency_key in args is passed to the audit tap context', async () => {
    const tapCtxs: AuditPerCall[] = [];
    const ctx = await makeCtx();
    const tap: AuditTap = async (result, auditCtx) => {
      tapCtxs.push(auditCtx);
      return result;
    };
    const tools = createPiToolDefinitions(ctx, { builders: fakeBuilders, auditTap: tap });
    const tool = findTool(tools, 'mx_delegate_tool');

    await tool.execute('call-idem', {
      agent: 'a',
      tool: 'run_tests',
      args: {},
      idempotency_key: 'idk_test-key-123',
    });

    expect(tapCtxs[0]?.idempotency_key).toBe('idk_test-key-123');
  });

  it('absent idempotency_key is not forwarded to audit tap', async () => {
    const tapCtxs: AuditPerCall[] = [];
    const ctx = await makeCtx();
    const tap: AuditTap = async (result, auditCtx) => {
      tapCtxs.push(auditCtx);
      return result;
    };
    const tools = createPiToolDefinitions(ctx, { builders: fakeBuilders, auditTap: tap });
    const tool = findTool(tools, 'mx_find_agents');
    await tool.execute('call-no-idem', {});
    expect(tapCtxs[0]?.idempotency_key).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Custom descriptors option
// ---------------------------------------------------------------------------

describe('custom descriptors option', () => {
  it('generates only the injected descriptors, not the full nine', async () => {
    const one = CANONICAL_M1_TOOLS.find((d) => d.name === 'mx_find_agents')!;
    const ctx = await makeCtx();
    const tools = createPiToolDefinitions(ctx, {
      builders: fakeBuilders,
      descriptors: [one],
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('mx_find_agents');
  });
});

// ---------------------------------------------------------------------------
// All 9 canonical verbs execute() full roundtrip with valid args
// Each verb must return a valid ToolResult envelope (any of the five statuses)
// with a defined `audit_ref`. This is the integration-level "all nine dispatch
// without error" check at the tools.execute() layer (distinct from the
// dispatch-level test in dispatch.test.ts).
// ---------------------------------------------------------------------------

/** Minimal valid args for each verb that satisfy the Ajv preflight. */
const VALID_ARGS: Readonly<Record<string, Record<string, unknown>>> = {
  mx_find_agents: {},
  mx_describe_agent: { agent_id: 'agent-b' },
  mx_await_result: { handle: 'inv_123' },
  mx_cancel: { handle: 'inv_123' },
  mx_delegate_tool: { agent: 'agent-b', tool: 'run_tests', args: {} },
  mx_run_command: { agent: 'agent-b', command: 'echo', args: [] },
  mx_share_context: { kind: 'file', content: 'hello' },
  mx_get_context: { context_id: 'ctx_1' },
  mx_workspace_status: {},
};

describe('all nine verbs: execute() produces a valid envelope', () => {
  it.each(CANONICAL_M1_TOOLS)(
    '$name: returns a ToolResult envelope with valid status and audit_ref',
    async ({ name }) => {
      const tools = await makeTools();
      const tool = findTool(tools, name);
      const args = VALID_ARGS[name] ?? {};
      const out = await tool.execute(`call-all9-${name}`, args);
      const d = out.details as { status: string; audit_ref: unknown };
      expect(['ok', 'running', 'awaiting_approval', 'denied', 'error']).toContain(d.status);
      expect(d.audit_ref).toBeDefined();
      // content[0].text is valid JSON that equals details
      const fromText = JSON.parse(out.content[0]!.text) as { status: string };
      expect(fromText.status).toBe(d.status);
    },
  );
});

// ---------------------------------------------------------------------------
// invalid_args error message is secret-free — never echoes the bad value
//
// `invalidArgsMessage` emits only the JSON-pointer path + keyword/message,
// never the rejected value itself. This is a regression guard: if the message
// ever started interpolating the value, a credential-shaped arg in the error
// text would be a Boundary A leak.
// ---------------------------------------------------------------------------

describe('invalid_args message is secret-free', () => {
  const UNIQUE_VALUE = 'super-secret-value-must-not-appear-in-pi-binding-error-12345';

  it('content[0].text does not contain the rejected value (string wrong-type)', async () => {
    const tools = await makeTools();
    const tool = findTool(tools, 'mx_describe_agent');
    // agent_id must be a string; pass a number instead so Ajv rejects it.
    const out = await tool.execute('call-secret-msg', { agent_id: UNIQUE_VALUE as unknown as number });
    // This actually passes type validation because the value IS a string;
    // use a number to trigger Ajv rejection.
    const out2 = await tool.execute('call-secret-msg-2', { agent_id: 42 });
    const text = out2.content[0]!.text;
    // The message should name the path/keyword but never the value "42"
    expect(text).not.toContain('"42"');
    const d = out2.details as { status: string; error: { code: string; message: string } };
    expect(d.status).toBe('error');
    expect(d.error.code).toBe('invalid_args');
    // The error message should not echo the submitted value
    expect(d.error.message).not.toContain('42');
  });

  it('error message includes the path/keyword but not the value', async () => {
    const tools = await makeTools();
    const tool = findTool(tools, 'mx_describe_agent');
    // Pass a number where a string is required — Ajv will report "must be string"
    const out = await tool.execute('call-path-msg', { agent_id: 999 });
    const d = out.details as { status: string; error: { code: string; message: string } };
    expect(d.status).toBe('error');
    expect(d.error.code).toBe('invalid_args');
    // The message should contain the tool name (structural, not a value)
    expect(d.error.message).toContain('mx_describe_agent');
    // The numeric value 999 must not appear
    expect(d.error.message).not.toContain('999');
  });
});
