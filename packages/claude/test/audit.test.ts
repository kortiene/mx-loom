/**
 * Audit tap (T110 / #18 + T113) — the single result-return chokepoint in
 * `createMxToolServer` applies the T113 `withAudit` tap exactly once per tool call.
 *
 * Mirrors `packages/mcp/test/audit.test.ts` for the Claude in-process shim.
 *
 * Tests:
 *  - With `InMemoryAuditSink`: exactly one row is written per tool call, carrying
 *    the correct `tool_name`, `correlation_id`, and `audit_ref` ids from the daemon
 *    response.
 *  - The `idempotency_key` is captured in the row when the mutating verb supplies
 *    a string value; a non-string value is treated as absent → `null`.
 *  - Two distinct calls produce two rows (different `call_id` → different `dedup_key`).
 *  - A throwing sink is swallowed (best-effort) and does not block the tool result.
 *  - `NullAuditSink` (the default): no rows, no error.
 *  - Custom `auditTap` option: the provided tap is called instead of the default;
 *    the `ctx.auditSink` receives no write.
 *
 * All tests use the InMemoryTransport pair (no real daemon, deterministic).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import { InMemoryAuditSink, NullAuditSink } from '@mx-loom/audit';
import type { AuditRow, AuditSink, AuditTap, AuditPerCall } from '@mx-loom/audit';
import type { DaemonCall, ToolResult } from '@mx-loom/registry';
import type { BindingContext } from '@mx-loom/mcp';

import { createMxToolServer } from '../src/tool-server.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const ROOM = '!audit-test:server';

function fakeDaemon(): DaemonCall {
  return {
    async call(method: string): Promise<unknown> {
      switch (method) {
        case 'agent.tools':
          return {
            schemas: [
              { name: 'run_tests', input_schema: { type: 'object', additionalProperties: true } },
            ],
          };
        case 'call.start':
          return {
            ok: true,
            result: { passed: true },
            audit_ref: {
              invocation_id: 'inv_audit',
              request_id: 'req_audit',
              room: ROOM,
              event_id: '$evt_audit',
            },
          };
        case 'workspace.status':
          return { room_id: ROOM, name: 'test', encrypted: false };
        case 'agent.list':
          return [];
        default:
          throw new Error(`unexpected daemon method in audit test: ${method}`);
      }
    },
  };
}

/** A sink whose `record` always throws — for the best-effort swallow test. */
class ThrowingSink implements AuditSink {
  record(_row: AuditRow): Promise<void> {
    return Promise.reject(new Error('sink failure — must be swallowed by withAudit'));
  }
}

function makeCtx(auditSink: AuditSink, correlationId?: string): BindingContext {
  return {
    daemon: fakeDaemon(),
    room: ROOM,
    correlationId,
    auditSink,
    close: async () => { /* noop */ },
  };
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function connectWith(ctx: BindingContext, options?: Parameters<typeof createMxToolServer>[1]): Promise<Client> {
  const config = createMxToolServer(ctx, options);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([config.instance.connect(st), client.connect(ct)]);
  clients.push(client);
  return client;
}

// ---------------------------------------------------------------------------
// InMemoryAuditSink — one row per call, correct field values
// ---------------------------------------------------------------------------

describe('InMemoryAuditSink — row fields', () => {
  it('writes exactly one row per tool call', async () => {
    const sink = new InMemoryAuditSink();
    const client = await connectWith(makeCtx(sink));

    await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: {} },
    });

    expect(sink.count).toBe(1);
  });

  it('row carries the correct tool_name', async () => {
    const sink = new InMemoryAuditSink();
    const client = await connectWith(makeCtx(sink));

    await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: {} },
    });

    expect(sink.rows[0]?.tool_name).toBe('mx_delegate_tool');
  });

  it('row carries the session correlation_id from the context', async () => {
    const sink = new InMemoryAuditSink();
    const client = await connectWith(makeCtx(sink, 'corr-claude-shim-123'));

    await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: {} },
    });

    expect(sink.rows[0]?.correlation_id).toBe('corr-claude-shim-123');
  });

  it('row carries audit_ref ids from the daemon response', async () => {
    const sink = new InMemoryAuditSink();
    const client = await connectWith(makeCtx(sink));

    await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: {} },
    });

    const row = sink.rows[0]!;
    expect(row.invocation_id).toBe('inv_audit');
    expect(row.request_id).toBe('req_audit');
  });

  it('row carries the idempotency_key when the mutating verb supplies a string', async () => {
    const sink = new InMemoryAuditSink();
    const client = await connectWith(makeCtx(sink));

    await client.callTool({
      name: 'mx_delegate_tool',
      arguments: {
        agent: 'agent-b',
        tool: 'run_tests',
        args: {},
        idempotency_key: 'idk_claude-shim-test-key',
      },
    });

    expect(sink.rows[0]?.idempotency_key).toBe('idk_claude-shim-test-key');
  });

  it('absent idempotency_key is null in the row', async () => {
    const sink = new InMemoryAuditSink();
    const client = await connectWith(makeCtx(sink));

    // Omit idempotency_key entirely (the most common path for a read-like call).
    await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: {} },
    });

    expect(sink.rows[0]?.idempotency_key).toBeNull();
  });

  it('non-mutating verb has null idempotency_key in the row', async () => {
    const sink = new InMemoryAuditSink();
    const client = await connectWith(makeCtx(sink));

    await client.callTool({ name: 'mx_workspace_status', arguments: {} });

    expect(sink.count).toBe(1);
    expect(sink.rows[0]?.tool_name).toBe('mx_workspace_status');
    expect(sink.rows[0]?.idempotency_key).toBeNull();
  });

  it('two distinct calls produce two rows (different dedup_keys)', async () => {
    const sink = new InMemoryAuditSink();
    const client = await connectWith(makeCtx(sink));

    await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: {} },
    });
    await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: {} },
    });

    expect(sink.count).toBe(2);
  });

  it('correlation_id is null in the row when the context has no session', async () => {
    const sink = new InMemoryAuditSink();
    const client = await connectWith(makeCtx(sink, undefined));

    await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: {} },
    });

    expect(sink.rows[0]?.correlation_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Best-effort: a throwing sink must never block the tool result
// ---------------------------------------------------------------------------

describe('best-effort sink failure is swallowed', () => {
  it('a throwing sink does not block or corrupt the tool result', async () => {
    const client = await connectWith(makeCtx(new ThrowingSink()));

    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: {} },
    })) as CallToolResult;

    expect(res).toBeDefined();
    expect(res.structuredContent).toBeDefined();
    const sc = res.structuredContent as { status: string };
    expect(['ok', 'running', 'awaiting_approval', 'denied', 'error']).toContain(sc.status);
  });
});

// ---------------------------------------------------------------------------
// NullAuditSink (default): no rows, no error
// ---------------------------------------------------------------------------

describe('NullAuditSink (default)', () => {
  it('tool call completes without error when no auditSink is configured', async () => {
    const ctx: BindingContext = {
      daemon: fakeDaemon(),
      room: ROOM,
      correlationId: undefined,
      auditSink: new NullAuditSink(),
      close: async () => { /* noop */ },
    };
    const client = await connectWith(ctx);

    await expect(
      client.callTool({
        name: 'mx_delegate_tool',
        arguments: { agent: 'agent-b', tool: 'run_tests', args: {} },
      }),
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

    const client = await connectWith(makeCtx(sink), { auditTap: customTap });

    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: {} },
    })) as CallToolResult;

    expect(tapResults).toHaveLength(1);
    expect(tapResults[0]?.ctx.tool_name).toBe('mx_delegate_tool');
    expect(sink.count).toBe(0);
    expect(res.isError ?? false).toBe(false);
  });
});
