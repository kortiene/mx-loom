// The mx-loom Claude Agent SDK binding (`area/claude-binding`).
//
// T111 (#19) lands the JSON Schema → Zod converter that turns each canonical
// `mx_*` descriptor's draft-07 `input_schema` (from `@mx-loom/registry`) into an
// equivalent Zod schema the SDK's `tool()` accepts. Fail-closed on any construct
// outside the supported subset; equivalence is proven against the registry's Ajv
// seam.
//
// T110 (#18) lands the **in-process shim** on top of it: the nine `mx_*` verbs
// registered via `createSdkMcpServer()` + `tool()` (generated, never hand-authored
// — reusing `@mx-loom/mcp`'s `dispatchCall` / `BindingContext` / `serializeToolResult`),
// the hidden `mx_await_result` poll loop, and the secret-free `canUseTool` HITL
// hook. The host (the mx-agency runner) composes the `createSdkMcpServer` config and
// the `canUseTool` factory into its own `query()` call. Secret-free by construction;
// every authority decision stays out-of-process on the receiving mx-agent daemon.

// ---------------------------------------------------------------------------
// T111 — the JSON Schema → Zod converter (the Claude-binding seam).
// ---------------------------------------------------------------------------
export {
  jsonSchemaToZod,
  jsonSchemaToZodRawShape,
  JsonSchemaConversionError,
  SUPPORTED_JSON_SCHEMA_TYPES,
} from './json-schema-to-zod.js';
export type { ConvertOptions } from './json-schema-to-zod.js';

// ---------------------------------------------------------------------------
// T110 — the in-process shim.
// ---------------------------------------------------------------------------

// The tool-server builder — `CANONICAL_TOOLS` → `tool()[]` → `createSdkMcpServer`.
export {
  createMxToolServer,
  DEFAULT_SERVER_VERSION,
} from './tool-server.js';
export type { CreateMxToolServerOptions } from './tool-server.js';

// The `canUseTool` HITL hook + its composition helper, and the secret-free payload.
export {
  createMxCanUseTool,
  wrapCanUseTool,
  defaultShouldPrompt,
} from './can-use-tool.js';
export type {
  ApprovalSummary,
  CreateMxCanUseToolOptions,
  OnApprovalRequest,
  ShouldPrompt,
} from './can-use-tool.js';

// Tool namespacing — the `mcp__<server>__<verb>` helper + the server-name constant.
export { mxToolName, mxVerbFromToolName, DEFAULT_SERVER_NAME } from './names.js';

// The hidden-poll-loop disposition policy (exported for hosts that resolve handles
// themselves and for T114's golden harness).
export { resolveDeferred, DEFAULT_RESOLVE_TIMEOUT_MS } from './resolve.js';
export type { ResolveOptions } from './resolve.js';
