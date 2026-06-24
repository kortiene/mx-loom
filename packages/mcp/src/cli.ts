#!/usr/bin/env node
/**
 * The transport-selecting `bin` entry (T109) — `mx-loom-mcp`.
 *
 * The thin executable wrapper: parse flags, open the secret-free
 * {@link BindingContext} (one `MxSession` → `agent.register` + heartbeat +
 * correlation), build the {@link createMcpServer | Server}, and connect it over the
 * selected transport:
 *  - **`--stdio`** (default) — `StdioServerTransport`. The artifact ADK
 *    (`MCPToolset`), OpenCode (`opencode.json` `mcp`), and Claude-external
 *    (`mcpServers`) register as a local subprocess.
 *  - **`--http --host 127.0.0.1 --port <n>`** — `StreamableHTTPServerTransport`
 *    behind a minimal Node `http` listener. **Binds to `127.0.0.1` by default.**
 *    Exposing the endpoint beyond localhost is explicit operator opt-in and must
 *    sit behind an authenticated reverse proxy — the server itself adds no authN
 *    (and even so, the daemon independently enforces trust/policy/approval, so a
 *    reachable endpoint cannot escalate; design §1).
 *
 * Audit is opt-in (`--audit` / `MXL_AUDIT_PG=1`) — a `PostgresAuditSink` from the
 * standard `DATABASE_URL`/`PG*` env, best-effort migrated; default is
 * `NullAuditSink` (off). The CLI holds no Boundary-A secret; the toolbelt owns the
 * socket + env allowlist.
 *
 * Non-secret **session** flags (`--room`, `--kind`, `--correlation-id`, `--cwd`,
 * `--project-id`, `--git-commit`, `--max-invocations`) map one process ⇒ one
 * `MxSession` registration (the ADK / T201 mapping). Parsing + projection live in
 * the pure {@link ./cli-options.ts} module; this file is the thin bin around them.
 *
 * Shuts down cleanly on `SIGINT` / `SIGTERM` and on stdin close (stdio mode).
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createPostgresAuditSink, NullAuditSink } from '@mx-loom/audit';
import type { AuditSink } from '@mx-loom/audit';

import { buildSessionOptions, parseCliArgs } from './cli-options.js';
import type { CliOptions } from './cli-options.js';
import { createBindingContext } from './context.js';
import type { BindingContext } from './context.js';
import { createMcpServer } from './server.js';

/** Build the audit sink: a best-effort Postgres mirror when opted in, else a no-op. */
async function buildAuditSink(opts: CliOptions): Promise<AuditSink> {
  if (!opts.audit) return new NullAuditSink();
  // Config comes from the standard libpq env (`DATABASE_URL` / `PG*`); `pg` reads
  // it itself when no fields are passed. Never logged. Migration is best-effort —
  // a Postgres outage degrades the queryable index, never blocks a tool call.
  const connectionString = process.env['DATABASE_URL'];
  const sink = await createPostgresAuditSink(connectionString !== undefined ? { connectionString } : {});
  try {
    await sink.migrate();
  } catch (err) {
    log(`audit migrate skipped (best-effort): ${err instanceof Error ? err.name : typeof err}`);
  }
  return sink;
}

/** Secret-free stderr log (stdout is the MCP stdio channel — never write protocol-foreign bytes there). */
function log(line: string): void {
  process.stderr.write(`[mx-loom-mcp] ${line}\n`);
}

async function main(): Promise<void> {
  const opts = parseCliArgs(process.argv.slice(2));
  const auditSink = await buildAuditSink(opts);

  const ctx = await createBindingContext({
    auditSink,
    sessionOptions: buildSessionOptions(opts),
  });

  const server = createMcpServer(ctx);

  let httpServer: HttpServer | undefined;
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log(`shutting down (${signal})`);
    await server.close().catch(() => undefined);
    if (httpServer !== undefined) await new Promise<void>((r) => httpServer?.close(() => r()));
    await closeContext(ctx);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  if (opts.http) {
    // Stateless JSON request/response (single workspace, single tenant — M1). One
    // server, one transport; the daemon enforces every authority decision per call.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      void transport.handleRequest(req, res);
    });
    httpServer.listen(opts.port, opts.host, () => {
      log(`listening on http://${opts.host}:${opts.port} (localhost-bind; put auth in front before exposing)`);
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // stdin close ⇒ the parent runtime detached ⇒ shut down.
    process.stdin.on('close', () => void shutdown('stdin-close'));
    log('connected over stdio');
  }
}

/** Close the context (the session it opened), swallowing teardown errors. */
async function closeContext(ctx: BindingContext): Promise<void> {
  await ctx.close().catch(() => undefined);
}

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
