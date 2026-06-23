/**
 * createMcpServer edge cases (T109).
 *
 * Tests that are not covered by the integration round-trip suite:
 *
 *  - `idempotencyKeyOf` coercion: only a `string` value for `idempotency_key`
 *    is captured in the audit row; any non-string value (number, boolean, null,
 *    object) must be treated as absent → the row carries `null`.
 *
 *  - Custom `auditTap` override: when `CreateMcpServerOptions.auditTap` is
 *    supplied, it replaces the default `withAudit(ctx.auditSink)` tap. The
 *    override must be called for every tool call; the context's `auditSink`
 *    must NOT receive a write.
 *
 *  - `SERVER_NAME` / `SERVER_VERSION` are stable string constants (downstream
 *    bindings T110/T201/T203 advertise the same identity in `initialize`).
 *
 * All tests use the in-memory MCP transport pair (no real daemon, deterministic).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DaemonCall } from '@mx-loom/registry';
import type { ToolResult } from '@mx-loom/registry';
import { InMemoryAuditSink, NullAuditSink } from '@mx-loom/audit';
import type { AuditTap, AuditPerCall } from '@mx-loom/audit';

import type { BindingContext } from '../src/context.js';
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from '../src/server.js';

const ROOM = '!server-test:server';

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
              invocation_id: 'inv_svr',
              request_id: 'req_svr',
              room: ROOM,
              event_id: '$evt_svr',
            },
          };
        case 'workspace.status':
          return { room_id: ROOM, name: 'test room', encrypted: false };
        case 'agent.list':
          return [];
        default:
          throw new Error(`unexpected daemon method in server test: ${method}`);
      }
    },
  };
}

function makeCtx(auditSink = new NullAuditSink(), correlationId?: string): BindingContext {
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

async function connectWith(ctx: BindingContext, options?: Parameters<typeof createMcpServer>[1]): Promise<Client> {
  const server = createMcpServer(ctx, options);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  clients.push(client);
  return client;
}

// ---------------------------------------------------------------------------
// idempotencyKeyOf coercion — only strings reach the audit context
// ---------------------------------------------------------------------------

describe('idempotencyKeyOf coercion', () => {
  it('number idempotency_key is treated as absent → null in audit row', async () => {
    const sink = new InMemoryAuditSink();
    const client = await connectWith(makeCtx(sink));

    await client.callTool({
      name: 'mx_delegate_tool',
      // idempotency_key is a number — not a string → must be dropped
      arguments: { agent: 'agent-b', tool: 'run_tests', args: {}, idempotency_key: 42 },
    });

    expect(sink.count).toBe(1);
    expect(sink.rows[0]?.idempotency_key).toBeNull();
  });

  it('boolean idempotency_key is treated as absent → null in audit row', async () => {
    const sink = new InMemoryAuditSink();
    const client = await connectWith(makeCtx(sink));

    await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: {}, idempotency_key: true },
    });

    expect(sink.rows[0]?.idempotency_key).toBeNull();
  });

  it('null idempotency_key is treated as absent → null in audit row', async () => {
    const sink = new InMemoryAuditSink();
    const client = await connectWith(makeCtx(sink));

    await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: {}, idempotency_key: null },
    });

    expect(sink.rows[0]?.idempotency_key).toBeNull();
  });

  it('object idempotency_key is treated as absent → null in audit row', async () => {
    const sink = new InMemoryAuditSink();
    const client = await connectWith(makeCtx(sink));

    await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: {}, idempotency_key: { nested: 'value' } },
    });

    expect(sink.rows[0]?.idempotency_key).toBeNull();
  });

  it('string idempotency_key is captured in the audit row', async () => {
    const sink = new InMemoryAuditSink();
    const client = await connectWith(makeCtx(sink));

    await client.callTool({
      name: 'mx_delegate_tool',
      arguments: {
        agent: 'agent-b',
        tool: 'run_tests',
        args: {},
        idempotency_key: 'idk_string-key-for-test',
      },
    });

    expect(sink.rows[0]?.idempotency_key).toBe('idk_string-key-for-test');
  });
});

// ---------------------------------------------------------------------------
// Custom auditTap override
// ---------------------------------------------------------------------------

describe('custom auditTap override', () => {
  it('the provided tap is called once per tool call instead of the default', async () => {
    const sink = new InMemoryAuditSink(); // the ctx auditSink — must NOT be written to
    const tapResults: Array<{ result: ToolResult; ctx: AuditPerCall }> = [];

    // A custom tap that records calls and passes the result through unchanged.
    const customTap: AuditTap = async (result, auditCtx) => {
      tapResults.push({ result, ctx: auditCtx });
      return result;
    };

    const client = await connectWith(makeCtx(sink), { auditTap: customTap });

    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: {} },
    })) as CallToolResult;

    // The custom tap was invoked exactly once.
    expect(tapResults).toHaveLength(1);
    expect(tapResults[0]?.ctx.tool_name).toBe('mx_delegate_tool');

    // The default sink was NOT written to (the custom tap replaced it).
    expect(sink.count).toBe(0);

    // The tool result is still returned correctly.
    expect(res.isError ?? false).toBe(false);
    const sc = res.structuredContent as { status: string };
    expect(sc.status).toBe('ok');
  });

  it('custom tap returning a modified result changes the serialized output', async () => {
    // Build a tap that swaps the result envelope for a fake 'denied' outcome.
    const { denied } = await import('@mx-loom/registry');
    const FAKE_AUDIT_REF = { invocation_id: 'inv_tap', request_id: 'req_tap', room: ROOM, event_id: '$tap' };

    const overridingTap: AuditTap = async () => denied('policy_denied', 'tap override', FAKE_AUDIT_REF);

    const client = await connectWith(makeCtx(), { auditTap: overridingTap });

    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: {} },
    })) as CallToolResult;

    // The tap replaced the ok result with denied → not isError (governance outcome).
    expect(res.isError ?? false).toBe(false);
    const sc = res.structuredContent as { status: string };
    expect(sc.status).toBe('denied');
  });
});

// ---------------------------------------------------------------------------
// SERVER_NAME / SERVER_VERSION constants
// ---------------------------------------------------------------------------

describe('SERVER_NAME / SERVER_VERSION', () => {
  it('SERVER_NAME is a non-empty string', () => {
    expect(typeof SERVER_NAME).toBe('string');
    expect(SERVER_NAME.length).toBeGreaterThan(0);
  });

  it('SERVER_VERSION is a valid semver-shaped string', () => {
    expect(typeof SERVER_VERSION).toBe('string');
    // Must match major.minor.patch (minimal semver check).
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
