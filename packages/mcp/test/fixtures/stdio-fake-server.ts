/**
 * Stdio test fixture for @mx-loom/mcp (T109) — stdio integration test.
 *
 * A minimal fake-daemon-backed MCP server that runs over stdio. Spawned by
 * `stdio.integration.test.ts` via `StdioClientTransport`; it uses the daemon
 * injection path so no live mx-agent daemon is needed.
 *
 * Handles SIGTERM, SIGINT, and stdin close (the same three shutdown triggers
 * that `cli.ts` handles in production) to exercise the clean-shutdown path.
 *
 * This is NOT a test file — it is the subprocess the test spawns.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { NullAuditSink } from '@mx-loom/audit';
import type { DaemonCall } from '@mx-loom/registry';

import { createBindingContext } from '../../src/context.js';
import { createMcpServer } from '../../src/server.js';

const ROOM = '!stdio-fixture-room:server';

const fakeDaemon: DaemonCall = {
  async call(method: string): Promise<unknown> {
    switch (method) {
      case 'agent.list':
        return [];
      case 'agent.tools':
        return {
          schemas: [
            {
              name: 'run_tests',
              input_schema: { type: 'object', additionalProperties: true },
              output_schema: { type: 'object', additionalProperties: true },
            },
          ],
        };
      case 'call.start':
        return {
          ok: true,
          result: { passed: true },
          audit_ref: {
            invocation_id: 'inv_stdio',
            request_id: 'req_stdio',
            room: ROOM,
            event_id: '$evt_stdio',
          },
        };
      case 'workspace.status':
        return { room_id: ROOM, name: 'stdio-fixture', encrypted: false };
      default:
        throw new Error(`stdio-fake-server: unexpected daemon method: ${method}`);
    }
  },
};

async function main(): Promise<void> {
  const ctx = await createBindingContext({
    daemon: fakeDaemon,
    room: ROOM,
    auditSink: new NullAuditSink(),
  });

  const server = createMcpServer(ctx);
  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await server.close().catch(() => undefined);
    await ctx.close().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  process.stdin.on('close', () => void shutdown());

  await server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[stdio-fake-server] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
