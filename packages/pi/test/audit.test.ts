/**
 * Audit tap (T205 / T113) — the single result-return chokepoint in each
 * generated tool's `execute()` applies the `withAudit` tap exactly once.
 *
 * Tests:
 *  - With `InMemoryAuditSink`: exactly one row is written per tool call,
 *    carrying the correct `tool_name`, `correlation_id`, and `audit_ref` ids.
 *  - `idempotency_key` is captured in the row when the mutating verb supplies a
 *    string; absent → null in the row.
 *  - Non-mutating verb (no idempotency_key in args) → null in the row.
 *  - Two distinct calls produce two rows.
 *  - A throwing sink is swallowed (best-effort) and does not block the tool result.
 *  - `NullAuditSink` (the default): no rows, no error.
 *  - Custom `auditTap` option: the provided tap is called instead of the default;
 *    the `ctx.auditSink` receives no write.
 */
import { describe, expect, it } from 'vitest';

import { InMemoryAuditSink, NullAuditSink } from '@mx-loom/audit';
import type { AuditRow, AuditSink, AuditTap, AuditPerCall } from '@mx-loom/audit';
import type { ToolResult } from '@mx-loom/registry';

import { createPiBindingContext } from '../src/context.js';
import { createPiToolDefinitions } from '../src/tools.js';
import type { ToolDefinition } from '../src/pi-abi.js';
import { ROOM, fakeBuilders, makeFakeDaemon } from './helpers.js';

/** A sink whose `record` always throws — for the best-effort swallow test. */
class ThrowingSink implements AuditSink {
  record(_row: AuditRow): Promise<void> {
    return Promise.reject(new Error('sink failure — must be swallowed by withAudit'));
  }
}

async function makeTools(auditSink: AuditSink, correlationId?: string): Promise<ToolDefinition[]> {
  const ctx = await createPiBindingContext({
    daemon: makeFakeDaemon(),
    room: ROOM,
    auditSink,
  });
  // inject correlation id into a manually constructed ctx to test row field
  const ctxWithCorr = correlationId !== undefined
    ? { ...ctx, correlationId }
    : ctx;
  return createPiToolDefinitions(ctxWithCorr, { builders: fakeBuilders });
}

function findTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const t = tools.find((x) => x.name === name);
  if (t === undefined) throw new Error(`tool ${name} not found`);
  return t;
}

// ---------------------------------------------------------------------------
// InMemoryAuditSink — row count and field values
// ---------------------------------------------------------------------------

describe('InMemoryAuditSink — row fields', () => {
  it('writes exactly one row per tool call', async () => {
    const sink = new InMemoryAuditSink();
    const tools = await makeTools(sink);
    await findTool(tools, 'mx_delegate_tool').execute('call-audit-1', {
      agent: 'agent-b',
      tool: 'run_tests',
      args: {},
    });
    expect(sink.count).toBe(1);
  });

  it('row carries the correct tool_name', async () => {
    const sink = new InMemoryAuditSink();
    const tools = await makeTools(sink);
    await findTool(tools, 'mx_delegate_tool').execute('call-audit-2', {
      agent: 'agent-b',
      tool: 'run_tests',
      args: {},
    });
    expect(sink.rows[0]?.tool_name).toBe('mx_delegate_tool');
  });

  it('row carries the session correlation_id from the context', async () => {
    const sink = new InMemoryAuditSink();
    const tools = await makeTools(sink, 'corr-pi-binding-123');
    await findTool(tools, 'mx_delegate_tool').execute('call-audit-3', {
      agent: 'agent-b',
      tool: 'run_tests',
      args: {},
    });
    expect(sink.rows[0]?.correlation_id).toBe('corr-pi-binding-123');
  });

  it('row carries audit_ref ids from the daemon response', async () => {
    const sink = new InMemoryAuditSink();
    const tools = await makeTools(sink);
    await findTool(tools, 'mx_delegate_tool').execute('call-audit-4', {
      agent: 'agent-b',
      tool: 'run_tests',
      args: {},
    });
    const row = sink.rows[0]!;
    expect(row.invocation_id).toBe('inv_1');
    expect(row.request_id).toBe('req_1');
  });

  it('row carries the idempotency_key when the mutating verb supplies a string', async () => {
    const sink = new InMemoryAuditSink();
    const tools = await makeTools(sink);
    await findTool(tools, 'mx_delegate_tool').execute('call-audit-5', {
      agent: 'agent-b',
      tool: 'run_tests',
      args: {},
      idempotency_key: 'idk_pi-test-key-abc',
    });
    expect(sink.rows[0]?.idempotency_key).toBe('idk_pi-test-key-abc');
  });

  it('absent idempotency_key is null in the row', async () => {
    const sink = new InMemoryAuditSink();
    const tools = await makeTools(sink);
    await findTool(tools, 'mx_delegate_tool').execute('call-audit-6', {
      agent: 'agent-b',
      tool: 'run_tests',
      args: {},
    });
    expect(sink.rows[0]?.idempotency_key).toBeNull();
  });

  it('non-mutating verb has null idempotency_key in the row', async () => {
    const sink = new InMemoryAuditSink();
    const tools = await makeTools(sink);
    await findTool(tools, 'mx_find_agents').execute('call-audit-7', {});
    expect(sink.count).toBe(1);
    expect(sink.rows[0]?.tool_name).toBe('mx_find_agents');
    expect(sink.rows[0]?.idempotency_key).toBeNull();
  });

  it('two distinct calls produce two rows', async () => {
    const sink = new InMemoryAuditSink();
    const tools = await makeTools(sink);
    const delegate = findTool(tools, 'mx_delegate_tool');
    await delegate.execute('call-audit-8a', { agent: 'agent-b', tool: 'run_tests', args: {} });
    await delegate.execute('call-audit-8b', { agent: 'agent-b', tool: 'run_tests', args: {} });
    expect(sink.count).toBe(2);
  });

  it('correlation_id is null in the row when the context has no session correlation', async () => {
    const sink = new InMemoryAuditSink();
    const tools = await makeTools(sink, undefined);
    await findTool(tools, 'mx_delegate_tool').execute('call-audit-9', {
      agent: 'agent-b',
      tool: 'run_tests',
      args: {},
    });
    expect(sink.rows[0]?.correlation_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Best-effort: a throwing sink must never block the tool result
// ---------------------------------------------------------------------------

describe('best-effort: throwing sink is swallowed', () => {
  it('a throwing sink does not block or corrupt the tool result', async () => {
    const tools = await makeTools(new ThrowingSink());
    const out = await findTool(tools, 'mx_delegate_tool').execute('call-audit-throw', {
      agent: 'agent-b',
      tool: 'run_tests',
      args: {},
    });
    expect(out).toBeDefined();
    const details = out.details as { status: string };
    expect(['ok', 'running', 'awaiting_approval', 'denied', 'error']).toContain(details.status);
  });
});

// ---------------------------------------------------------------------------
// NullAuditSink (the default): no rows, no error
// ---------------------------------------------------------------------------

describe('NullAuditSink (default)', () => {
  it('tool call completes without error when no auditSink is configured', async () => {
    const ctx = await createPiBindingContext({
      daemon: makeFakeDaemon(),
      room: ROOM,
      auditSink: new NullAuditSink(),
    });
    const tools = createPiToolDefinitions(ctx, { builders: fakeBuilders });
    await expect(
      findTool(tools, 'mx_find_agents').execute('call-null-sink', {}),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Custom auditTap override
// ---------------------------------------------------------------------------

describe('custom auditTap override', () => {
  it('the provided tap is called once per tool call instead of the default', async () => {
    const sink = new InMemoryAuditSink();
    const tapResults: Array<{ result: ToolResult; ctx: AuditPerCall }> = [];
    const customTap: AuditTap = async (result, auditCtx) => {
      tapResults.push({ result, ctx: auditCtx });
      return result;
    };

    const ctx = await createPiBindingContext({
      daemon: makeFakeDaemon(),
      room: ROOM,
      auditSink: sink,
    });
    const tools = createPiToolDefinitions(ctx, {
      builders: fakeBuilders,
      auditTap: customTap,
    });

    const out = await findTool(tools, 'mx_delegate_tool').execute('call-custom-tap', {
      agent: 'agent-b',
      tool: 'run_tests',
      args: {},
    });

    expect(tapResults).toHaveLength(1);
    expect(tapResults[0]?.ctx.tool_name).toBe('mx_delegate_tool');
    // call_id in the per-call context must match the toolCallId passed to execute().
    expect(tapResults[0]?.ctx.call_id).toBe('call-custom-tap');
    expect(sink.count).toBe(0);
    expect(out).toBeDefined();
  });

  it('call_id in the per-call context equals the toolCallId passed to execute()', async () => {
    const tapCtxs: AuditPerCall[] = [];
    const tap: AuditTap = async (result, auditCtx) => {
      tapCtxs.push(auditCtx);
      return result;
    };
    const ctx = await createPiBindingContext({
      daemon: makeFakeDaemon(),
      room: ROOM,
      auditSink: new NullAuditSink(),
    });
    const tools = createPiToolDefinitions(ctx, { builders: fakeBuilders, auditTap: tap });

    await findTool(tools, 'mx_find_agents').execute('call-unique-id-for-test-42', {});

    expect(tapCtxs[0]?.call_id).toBe('call-unique-id-for-test-42');
  });
});
