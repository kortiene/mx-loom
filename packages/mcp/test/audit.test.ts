/**
 * Audit tap (T109 + T113) — the single result-return chokepoint in `createMcpServer`
 * applies the T113 `withAudit` tap exactly once per tool call.
 *
 * Tests:
 *  - With `InMemoryAuditSink`: one row per tool call carrying the correct
 *    `tool_name`, `correlation_id`, `invocation_id`/`request_id` from `audit_ref`,
 *    and `idempotency_key` when the mutating verb supplies one.
 *  - Two distinct tool calls produce two rows (different `call_id` → different
 *    `dedup_key`).
 *  - A throwing sink is swallowed — best-effort, the tool result is still returned.
 *  - `NullAuditSink` (the default): no rows, no error.
 *
 * All tests use the in-memory MCP transport pair (no real daemon, deterministic).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import type { DaemonCall } from '@mx-loom/registry';
import { InMemoryAuditSink, NullAuditSink } from '@mx-loom/audit';
import type { AuditRow, AuditSink } from '@mx-loom/audit';

import type { BindingContext } from '../src/context.js';
import { createMcpServer } from '../src/server.js';

const ROOM = '!test-room:server';

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
              invocation_id: 'inv_42',
              request_id: 'req_42',
              room: ROOM,
              event_id: '$evt_42',
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

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

/** Wire a client to a server using the given context, over a linked in-memory pair. */
async function connectWith(ctx: BindingContext): Promise<Client> {
  const server = createMcpServer(ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  clients.push(client);
  return client;
}

/** Build a BindingContext directly (no live session needed for these unit tests). */
function makeCtx(auditSink: AuditSink, correlationId?: string): BindingContext {
  return {
    daemon: fakeDaemon(),
    room: ROOM,
    correlationId,
    auditSink,
    close: async () => {
      /* nothing to close */
    },
  };
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
    const client = await connectWith(makeCtx(sink, 'corr-test-abc-123'));

    await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: {} },
    });

    expect(sink.rows[0]?.correlation_id).toBe('corr-test-abc-123');
  });

  it('row carries audit_ref ids from the daemon response', async () => {
    const sink = new InMemoryAuditSink();
    const client = await connectWith(makeCtx(sink));

    await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: {} },
    });

    const row = sink.rows[0]!;
    expect(row.invocation_id).toBe('inv_42');
    expect(row.request_id).toBe('req_42');
  });

  it('row carries the idempotency_key when the mutating verb supplies one', async () => {
    const sink = new InMemoryAuditSink();
    const client = await connectWith(makeCtx(sink));

    await client.callTool({
      name: 'mx_delegate_tool',
      arguments: {
        agent: 'agent-b',
        tool: 'run_tests',
        args: {},
        idempotency_key: 'idk_test-idempotency-key',
      },
    });

    expect(sink.rows[0]?.idempotency_key).toBe('idk_test-idempotency-key');
  });

  it('row has null idempotency_key for a non-mutating verb', async () => {
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

    // Each call gets a fresh randomUUID() call_id → distinct dedup_keys.
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
    // No correlationId supplied → undefined → tap uses empty base context.
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

    // Must NOT throw — the tap swallows the sink error.
    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: {} },
    })) as CallToolResult;

    // A valid, non-null CallToolResult with structuredContent is returned.
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
    // NullAuditSink is the default when auditSink is omitted from the context.
    const ctx: BindingContext = {
      daemon: fakeDaemon(),
      room: ROOM,
      correlationId: undefined,
      auditSink: new NullAuditSink(),
      close: async () => {
        /* nothing */
      },
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
