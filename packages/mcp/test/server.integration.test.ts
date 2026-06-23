/**
 * In-memory MCP round-trip (T109) — AC1/AC2/AC3 over the SDK's `InMemoryTransport`
 * client↔server pair, backed by a **fake `DaemonCall`** (no real daemon,
 * deterministic):
 *  - AC1: `tools/list` returns the nine canonical schemas, verbatim.
 *  - AC2: `tools/call` for `mx_delegate_tool` round-trips to a normalized envelope.
 *  - AC3: a fake `awaiting_approval` reply surfaces as a non-error structured
 *    result carrying `status` / `handle` / `approval`.
 *
 * The stdio-bin, secret-boundary, and audit-tap suites are the dedicated tests
 * phase; this proves the protocol seam end-to-end now.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import { CANONICAL_M1_TOOLS } from '@mx-loom/registry';
import type { DaemonCall } from '@mx-loom/registry';

import { createBindingContext } from '../src/context.js';
import { createMcpServer } from '../src/server.js';

const ROOM = '!room:server';

/** A target agent that publishes one open-input tool, `run_tests`. */
const AGENT_TOOLS_REPLY = {
  schemas: [
    {
      name: 'run_tests',
      input_schema: { type: 'object', additionalProperties: true },
      output_schema: { type: 'object', additionalProperties: true },
    },
  ],
};

/** Build a fake `DaemonCall` whose `call.start` reply is supplied per test. */
function fakeDaemon(callStartReply: (params: unknown) => unknown): DaemonCall {
  return {
    async call(method: string, params?: unknown): Promise<unknown> {
      if (method === 'agent.tools') return AGENT_TOOLS_REPLY;
      if (method === 'call.start') return callStartReply(params);
      throw new Error(`unexpected daemon method in test: ${method}`);
    },
  };
}

/** Wire a client to a server backed by `daemon`, over a linked in-memory pair. */
async function connect(daemon: DaemonCall): Promise<Client> {
  const ctx = await createBindingContext({ daemon, room: ROOM });
  const server = createMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  open.push(client);
  return client;
}

const open: Client[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});

describe('MCP server in-memory round-trip', () => {
  it('AC1 — tools/list returns the nine canonical tools with verbatim schemas', async () => {
    const client = await connect(fakeDaemon(() => ({ ok: true, result: {} })));
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual(CANONICAL_M1_TOOLS.map((d) => d.name));
    for (const descriptor of CANONICAL_M1_TOOLS) {
      const tool = tools.find((t) => t.name === descriptor.name)!;
      expect(tool.inputSchema).toEqual(descriptor.input_schema);
    }
  });

  it('AC2 — mx_delegate_tool round-trips to a normalized ok envelope', async () => {
    const client = await connect(
      fakeDaemon(() => ({
        ok: true,
        result: { passed: true },
        audit_ref: { invocation_id: 'inv_42', request_id: 'req_42', room: ROOM, event_id: '$evt_42' },
      })),
    );

    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: { suite: 'unit' } },
    })) as CallToolResult;

    expect(res.isError ?? false).toBe(false);
    const sc = res.structuredContent as {
      status: string;
      result: { passed: boolean };
      audit_ref: { invocation_id: string };
    };
    expect(sc.status).toBe('ok');
    expect(sc.result.passed).toBe(true);
    expect(sc.audit_ref.invocation_id).toBe('inv_42');
  });

  it('AC3 — an awaiting_approval reply surfaces as a non-error structured result', async () => {
    const client = await connect(
      fakeDaemon(() => ({
        state: 'awaiting_approval',
        handle: 'inv_99',
        approval: {
          request_id: 'req_99',
          risk: 'high',
          summary: 'guarded command needs approval',
          expires_at: '2099-01-01T00:00:00Z',
        },
        audit_ref: { invocation_id: 'inv_99', request_id: 'req_99', room: ROOM, event_id: '$evt_99' },
      })),
    );

    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: {} },
    })) as CallToolResult;

    // awaiting_approval is NOT a protocol error — the model keeps working and
    // resolves the handle later via mx_await_result.
    expect(res.isError ?? false).toBe(false);
    const sc = res.structuredContent as {
      status: string;
      handle: string;
      approval: { request_id: string; risk: string };
    };
    expect(sc.status).toBe('awaiting_approval');
    expect(sc.handle).toBe('inv_99');
    expect(sc.approval.request_id).toBe('req_99');
    expect(sc.approval.risk).toBe('high');
  });

  it('a non-open-output verb (mx_workspace_status) validates structuredContent — no -32602', async () => {
    // Regression: the SDK client caches each tool's advertised outputSchema at
    // tools/list and validates structuredContent on callTool (the standard
    // discovery flow). structuredContent is the full T102 envelope, so the server
    // must advertise the envelope schema — advertising the descriptor's bare-result
    // schema made the client reject this verb with "data must have required
    // property 'agents'" (MCP error -32602).
    const client = await connect({
      async call(method: string): Promise<unknown> {
        if (method === 'workspace.status') return { room_id: ROOM, name: 'srv' };
        if (method === 'agent.list') return [];
        throw new Error(`unexpected daemon method in test: ${method}`);
      },
    });

    // listTools() first so the client compiles + caches the outputSchema validator.
    await client.listTools();

    const res = (await client.callTool({
      name: 'mx_workspace_status',
      arguments: {},
    })) as CallToolResult;

    expect(res.isError ?? false).toBe(false);
    const sc = res.structuredContent as { status: string; result: { agents: unknown[] } };
    expect(sc.status).toBe('ok');
    expect(Array.isArray(sc.result.agents)).toBe(true);
  });

  it('an unknown tool surfaces as an error envelope, not a thrown protocol fault', async () => {
    const client = await connect(fakeDaemon(() => ({ ok: true, result: {} })));
    const res = (await client.callTool({ name: 'mx_not_a_tool', arguments: {} })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: { code: string } }).error.code).toBe('not_found');
  });
});
