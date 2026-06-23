/**
 * The in-process tool-server builder (T110 / #18) — descriptors →
 * `createSdkMcpServer`.
 *
 * {@link createMxToolServer} enumerates the canonical {@link CANONICAL_M1_TOOLS}
 * and produces one SDK `tool()` per descriptor, wrapped in a
 * `createSdkMcpServer({ name, version, tools })` config the host drops into
 * `options.mcpServers`. The toolbelt then runs **inside** the agent process — no
 * extra socket, no subprocess, no stdio framing (the "in-process shim").
 *
 * **Generated, never hand-authored.** Each tool's input schema is the descriptor's
 * draft-07 `input_schema` converted via the T111 {@link jsonSchemaToZodRawShape}
 * (the `ZodRawShape` form `tool()` accepts). Adding a tenth canonical descriptor
 * surfaces it here with no per-tool edit. Because the converter is **fail-closed**,
 * a descriptor whose schema drifts outside the supported subset throws
 * {@link JsonSchemaConversionError} at *build* time (a developer error, not a
 * model-facing `error.code`) — surfacing the drift loudly instead of silently
 * widening the gate.
 *
 * **Reuse, don't duplicate.** The SDK's `createSdkMcpServer` is itself an
 * in-process MCP server, so each `tool()` handler must return a `CallToolResult` —
 * the exact shape `@mx-loom/mcp`'s {@link serializeToolResult} produces from a T102
 * envelope. So each handler is a thin closure that routes via {@link dispatchCall}
 * (the shared name → registry-handler router), applies the **hidden poll loop**
 * ({@link resolveDeferred}) for deferred verbs, taps audit once ({@link withAudit},
 * the single result-return chokepoint), and serializes — re-implementing none of
 * the router, the envelope mapping, or the secret boundary.
 *
 * Secret-free by construction: the shim holds no secret and starts no child
 * process; every daemon call routes through `ctx.daemon` (an `MxSession`/`MxClient`)
 * so the deny-by-default env allowlist, outbound credential-shaped-arg rejection,
 * and inbound `redactSecrets` all stay in force, and trust/policy/approval
 * enforcement stays out-of-process on the receiving daemon.
 */
import { randomUUID } from 'node:crypto';

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { withAudit } from '@mx-loom/audit';
import type { AuditTap } from '@mx-loom/audit';
import { dispatchCall, serializeToolResult } from '@mx-loom/mcp';
import type { BindingContext, ToolArgs } from '@mx-loom/mcp';
import { CANONICAL_M1_TOOLS } from '@mx-loom/registry';

import { jsonSchemaToZodRawShape } from './json-schema-to-zod.js';
import { DEFAULT_SERVER_NAME } from './names.js';
import { resolveDeferred } from './resolve.js';
import type { ResolveOptions } from './resolve.js';

/** Default advertised version of the in-process server. */
export const DEFAULT_SERVER_VERSION = '0.0.0';

/** Options for {@link createMxToolServer}. */
export interface CreateMxToolServerOptions {
  /** In-process MCP server name. Default {@link DEFAULT_SERVER_NAME} (`'mx'`). */
  name?: string;
  /** Advertised server version. Default {@link DEFAULT_SERVER_VERSION}. */
  version?: string;
  /** Total budget for the hidden `running` poll loop. See {@link ResolveOptions}. */
  resolveTimeoutMs?: number;
  /** Block on `awaiting_approval` until the operator decides. Default `false`. */
  awaitApproval?: boolean;
  /**
   * Override the audit tap (tests). Default: a {@link withAudit} tap over
   * `ctx.auditSink`, fixed with the session `correlation_id`. This shim's tap is
   * independent of the MCP server's — each binding taps its own single chokepoint.
   */
  auditTap?: AuditTap;
  /** Deterministic clock for the poll loop (tests). Forwarded to {@link resolveDeferred}. */
  now?: () => number;
  /** Deterministic sleep for the poll loop (tests). Forwarded to {@link resolveDeferred}. */
  sleep?: (ms: number) => Promise<void>;
  /** Base poll interval for the loop (tests). Forwarded to {@link resolveDeferred}. */
  pollIntervalMs?: number;
}

/** Read a string `idempotency_key` from the model's args, if a mutating verb supplied one. */
function idempotencyKeyOf(args: ToolArgs | undefined): string | undefined {
  const key = args?.['idempotency_key'];
  return typeof key === 'string' ? key : undefined;
}

/**
 * Build the in-process `createSdkMcpServer` config for the nine canonical `mx_*`
 * verbs, bound to a secret-free {@link BindingContext}.
 *
 * @throws {JsonSchemaConversionError} at build time if a descriptor's
 * `input_schema` uses a construct outside the T111 supported subset (fail-closed).
 */
export function createMxToolServer(
  ctx: BindingContext,
  options: CreateMxToolServerOptions = {},
): McpSdkServerConfigWithInstance {
  // The single result-return chokepoint's audit tap (best-effort). `correlation_id`
  // is session-stable; the per-call `tool_name`/`call_id`/`idempotency_key` are
  // supplied per result below. Independent of the MCP server's own tap.
  const tap =
    options.auditTap ??
    withAudit(
      ctx.auditSink,
      ctx.correlationId !== undefined ? { correlation_id: ctx.correlationId } : {},
    );

  const resolveOptions: ResolveOptions = {
    ...(options.resolveTimeoutMs !== undefined ? { resolveTimeoutMs: options.resolveTimeoutMs } : {}),
    ...(options.awaitApproval !== undefined ? { awaitApproval: options.awaitApproval } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
  };

  const tools = CANONICAL_M1_TOOLS.map((descriptor) => {
    // Fail-closed at build time: a drifted schema throws JsonSchemaConversionError
    // here, never silently widening the model's input surface.
    const shape = jsonSchemaToZodRawShape(descriptor.input_schema);

    return tool(
      descriptor.name,
      descriptor.description,
      shape,
      async (args): Promise<CallToolResult> => {
        // The SDK has already parsed `args` against the Zod shape; treat it as the
        // open arg record the dispatch router expects (each handler re-validates).
        const toolArgs = (args ?? {}) as unknown as ToolArgs;

        // 1. Route to the matching registry handler (shared with the MCP binding).
        const dispatched = await dispatchCall(descriptor.name, toolArgs, ctx);
        // 2. Hide the poll loop for a deferred (`running`) result; surface
        //    `awaiting_approval` per the disposition policy.
        const resolved = await resolveDeferred(dispatched, ctx.daemon, resolveOptions);
        // 3. Tap audit once at this single return point (best-effort).
        const idempotency_key = idempotencyKeyOf(toolArgs);
        const audited = await tap(resolved, {
          tool_name: descriptor.name,
          call_id: randomUUID(),
          ...(idempotency_key !== undefined ? { idempotency_key } : {}),
        });
        // 4. Serialize the T102 envelope onto the SDK MCP `CallToolResult`.
        return serializeToolResult(audited);
      },
    );
  });

  return createSdkMcpServer({
    name: options.name ?? DEFAULT_SERVER_NAME,
    version: options.version ?? DEFAULT_SERVER_VERSION,
    tools,
  });
}
