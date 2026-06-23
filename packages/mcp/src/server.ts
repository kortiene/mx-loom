/**
 * The server assembly (T109) — the low-level MCP `Server` + the two request
 * handlers + the single audit chokepoint.
 *
 * {@link createMcpServer} instantiates the SDK's **low-level** `Server` (not the
 * Zod-first high-level `McpServer`, so descriptor JSON Schema passes through
 * verbatim — see `tools.ts`) and registers exactly two handlers:
 *  - `ListToolsRequestSchema` → the generator (`buildToolList`) — AC1;
 *  - `CallToolRequestSchema` → the router (`dispatchCall`) → the **`withAudit` tap
 *    applied once here** → the serializer (`serializeToolResult`) — AC2/AC3.
 *
 * This `tools/call` path is the binding's single result-return chokepoint, so it is
 * the one correct place to apply the T113 audit tap (best-effort, `NullAuditSink`
 * by default): every `mx_*` envelope flows through it exactly once. The server
 * re-implements no security: the credential-shaped-arg rejection and inbound
 * redaction live on the concrete `MxClient.call` the handlers' `deps.daemon` wraps,
 * and trust/policy/approval enforcement stays out-of-process on the receiving
 * daemon. The router and handlers never throw, so the protocol layer never sees an
 * exception (a fault becomes an `error` envelope, serialized with `isError: true`).
 *
 * Transports are chosen by the caller (`cli.ts`: stdio | Streamable HTTP); this
 * module produces a transport-agnostic `Server` ready to `connect()`.
 */
import { randomUUID } from 'node:crypto';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { withAudit } from '@mx-loom/audit';
import type { AuditTap } from '@mx-loom/audit';

import type { BindingContext } from './context.js';
import { dispatchCall } from './dispatch.js';
import type { ToolArgs } from './dispatch.js';
import { serializeToolResult } from './serialize.js';
import { buildToolList } from './tools.js';

/** Server identity advertised in the MCP `initialize` handshake. */
export const SERVER_NAME = 'mx-loom-mcp';
export const SERVER_VERSION = '0.0.0';

/** Options for {@link createMcpServer}. */
export interface CreateMcpServerOptions {
  /** Advertised server name. Default: {@link SERVER_NAME}. */
  name?: string;
  /** Advertised server version. Default: {@link SERVER_VERSION}. */
  version?: string;
  /**
   * Override the audit tap (tests). Default: a {@link withAudit} tap over
   * `ctx.auditSink`, fixed with the session `correlation_id`.
   */
  auditTap?: AuditTap;
}

/** Read a string `idempotency_key` from the model's args, if the mutating verb supplied one. */
function idempotencyKeyOf(args: ToolArgs | undefined): string | undefined {
  const key = args?.['idempotency_key'];
  return typeof key === 'string' ? key : undefined;
}

/**
 * Build the MCP `Server` bound to a {@link BindingContext}. Register the list +
 * call handlers; return a server ready to `connect(transport)`.
 */
export function createMcpServer(ctx: BindingContext, options: CreateMcpServerOptions = {}): Server {
  const server = new Server(
    { name: options.name ?? SERVER_NAME, version: options.version ?? SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  // AC1 — list: generated from the registry, verbatim schemas.
  const tools = buildToolList();
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  // The single result-return chokepoint's audit tap (best-effort). `correlation_id`
  // is session-stable; the per-call `tool_name`/`call_id`/`idempotency_key` are
  // supplied per result below.
  const tap =
    options.auditTap ??
    withAudit(ctx.auditSink, ctx.correlationId !== undefined ? { correlation_id: ctx.correlationId } : {});

  // AC2/AC3 — call: route → audit once → serialize. Never throws to the protocol.
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    const result = await dispatchCall(name, args, ctx);
    const idempotency_key = idempotencyKeyOf(args);
    const audited = await tap(result, {
      tool_name: name,
      call_id: randomUUID(),
      ...(idempotency_key !== undefined ? { idempotency_key } : {}),
    });
    return serializeToolResult(audited);
  });

  return server;
}
