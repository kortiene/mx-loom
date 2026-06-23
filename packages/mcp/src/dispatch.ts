/**
 * The dispatch table (T109) — tool name → registry handler.
 *
 * The registry exports {@link CANONICAL_M1_TOOLS} for *listing* but no execution
 * router; T109 builds the one central map from a descriptor `name` to its
 * `(input, deps) => Promise<ToolResult>` handler. Because all nine handlers share
 * that shape and **never throw**, the router is uniform: look up by name, build
 * the handler's `deps` subtype from the {@link BindingContext}, call it, get a
 * {@link ToolResult}.
 *
 * Each entry knows which `deps` subtype its handler needs:
 *  - read/handle verbs (`mx_find_agents` / `mx_describe_agent` / `mx_await_result`
 *    / `mx_cancel`) → {@link HandlerDeps} (daemon only);
 *  - room-scoped verbs (`mx_run_command` / `mx_share_context` / `mx_get_context` /
 *    `mx_workspace_status`) → {@link RoomScopedDeps} (daemon + session room);
 *  - `mx_delegate_tool` → {@link DelegateDeps} (room + a defaulted JSON Schema
 *    validator the handler supplies itself).
 *
 * The `room` always comes from the context (the session), **never** from the
 * model's `arguments`. An unknown tool name resolves to a constructed
 * `errored('not_found', …)` envelope — never a thrown exception (the model asked
 * for a verb we do not surface).
 *
 * No authority surface is reachable: the table is keyed only by the nine
 * `CANONICAL_M1_TOOLS` names, so `trust.*` / `approval.decide` / `policy.*` /
 * `auth.*` / `device.*` / `daemon.*` are structurally absent.
 */
import {
  MX_AWAIT_RESULT,
  MX_CANCEL,
  MX_DELEGATE_TOOL,
  MX_DESCRIBE_AGENT,
  MX_FIND_AGENTS,
  MX_GET_CONTEXT,
  MX_RUN_COMMAND,
  MX_SHARE_CONTEXT,
  MX_WORKSPACE_STATUS,
  errored,
  mxAwaitResult,
  mxCancel,
  mxDelegateTool,
  mxDescribeAgent,
  mxFindAgents,
  mxGetContext,
  mxRunCommand,
  mxShareContext,
  mxWorkspaceStatus,
} from '@mx-loom/registry';
import type {
  AuditRef,
  AwaitResultInput,
  CancelInput,
  DelegateDeps,
  DelegateToolInput,
  DescribeAgentInput,
  FindAgentsInput,
  GetContextInput,
  HandlerDeps,
  RoomScopedDeps,
  RunCommandInput,
  ShareContextInput,
  ToolResult,
  WorkspaceStatusInput,
} from '@mx-loom/registry';

import type { BindingContext } from './context.js';

/** The model never names a Matrix room; no dispatch error has a daemon round-trip behind it. */
const EMPTY_AUDIT_REF: AuditRef = Object.freeze({
  invocation_id: null,
  request_id: null,
  room: null,
  event_id: null,
});

/** The tool arguments the model supplies (MCP `tools/call` `params.arguments`). */
export type ToolArgs = Record<string, unknown>;

/**
 * A dispatch entry: build the handler's `deps` from the context, run it, return
 * the envelope. One per canonical verb; the per-handler `deps` shaping lives here
 * so the router stays uniform.
 */
export type DispatchEntry = (args: ToolArgs, ctx: BindingContext) => Promise<ToolResult>;

const handlerDeps = (ctx: BindingContext): HandlerDeps => ({ daemon: ctx.daemon });

const roomScopedDeps = (ctx: BindingContext): RoomScopedDeps => ({
  daemon: ctx.daemon,
  room: ctx.room,
});

// `mx_delegate_tool` needs `DelegateDeps`; its `validator` defaults inside the
// handler (a lazily-created Ajv validator), so the binding wires only daemon + room.
const delegateDeps = (ctx: BindingContext): DelegateDeps => ({
  daemon: ctx.daemon,
  room: ctx.room,
});

/**
 * The single name → handler map, built once over the nine canonical verbs. Keyed
 * by the descriptor `name` (the single source) so the surfaced set can never drift
 * from {@link CANONICAL_M1_TOOLS}.
 */
export const DISPATCH: Readonly<Record<string, DispatchEntry>> = Object.freeze({
  // `args` is an open `Record<string, unknown>` (the model's input); each handler
  // narrows/validates it internally and never throws, so the `as unknown as`
  // bridge is the documented hand-off, not a correctness claim about the args.
  [MX_FIND_AGENTS.name]: (args, ctx) => mxFindAgents(args as unknown as FindAgentsInput, handlerDeps(ctx)),
  [MX_DESCRIBE_AGENT.name]: (args, ctx) => mxDescribeAgent(args as unknown as DescribeAgentInput, handlerDeps(ctx)),
  [MX_AWAIT_RESULT.name]: (args, ctx) => mxAwaitResult(args as unknown as AwaitResultInput, handlerDeps(ctx)),
  [MX_CANCEL.name]: (args, ctx) => mxCancel(args as unknown as CancelInput, handlerDeps(ctx)),
  [MX_DELEGATE_TOOL.name]: (args, ctx) => mxDelegateTool(args as unknown as DelegateToolInput, delegateDeps(ctx)),
  [MX_RUN_COMMAND.name]: (args, ctx) => mxRunCommand(args as unknown as RunCommandInput, roomScopedDeps(ctx)),
  [MX_SHARE_CONTEXT.name]: (args, ctx) => mxShareContext(args as unknown as ShareContextInput, roomScopedDeps(ctx)),
  [MX_GET_CONTEXT.name]: (args, ctx) => mxGetContext(args as unknown as GetContextInput, roomScopedDeps(ctx)),
  [MX_WORKSPACE_STATUS.name]: (args, ctx) => mxWorkspaceStatus(args as unknown as WorkspaceStatusInput, roomScopedDeps(ctx)),
});

/**
 * Route a `tools/call` to its handler and return the normalized {@link ToolResult}.
 *
 * Total + never-throwing: an unknown `name` maps to `errored('not_found', …)`
 * (a genuine fault — the model asked for a verb we do not surface), and the
 * handlers themselves never throw, so the server's protocol layer never sees an
 * exception from dispatch.
 */
export async function dispatchCall(
  name: string,
  args: ToolArgs | undefined,
  ctx: BindingContext,
): Promise<ToolResult> {
  const entry = DISPATCH[name];
  if (entry === undefined) {
    return errored('not_found', `unknown tool: ${name}`, EMPTY_AUDIT_REF);
  }
  return entry(args ?? {}, ctx);
}
