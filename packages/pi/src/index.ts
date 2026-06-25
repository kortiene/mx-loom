// The mx-loom Pi binding (`area/pi`, T205 / #27).
//
// Pi (`@earendil-works/pi-coding-agent`) ships no built-in MCP client (T204 / #26),
// so the nine canonical `mx_*` verbs are registered through Pi's NATIVE tool API —
// SDK `customTools` / extension `registerTool` — generated from `@mx-loom/registry`,
// never hand-authored. Each descriptor's draft-07 `input_schema` is converted
// fail-closed to a Pi TypeBox schema (enums → `StringEnum`, never `Type.Union`),
// execution routes through the shared registry handlers + the secret-free
// `@mx-loom/toolbelt` daemon seam (re-using the binding-neutral dispatch/context
// pattern, reimplemented locally to keep the MCP SDK out of Pi's dep graph), and
// the T102 envelope serializes into Pi's `AgentToolResult` (full envelope in both
// `content` and `details`). Secret-free by construction; every authority decision
// stays out-of-process on the receiving mx-agent daemon.
//
// The TypeBox `Type`/`StringEnum` builders are INJECTED by the host (resolved from
// Pi's own tree) so there is a single TypeBox runtime and no heavy/native
// dependency leaks into consumers.

// ---------------------------------------------------------------------------
// The schema adapter — JSON Schema → TypeBox (fail-closed; enums → StringEnum).
// ---------------------------------------------------------------------------
export { jsonSchemaToTypeBox, PiSchemaConversionError, SUPPORTED_JSON_SCHEMA_TYPES } from './json-schema-to-typebox.js';
export type { ConvertOptions } from './json-schema-to-typebox.js';

// ---------------------------------------------------------------------------
// The envelope serializer — T102 `ToolResult` → Pi `AgentToolResult`.
// ---------------------------------------------------------------------------
export { serializePiToolResult } from './serialize.js';

// ---------------------------------------------------------------------------
// The binding context — the secret-free daemon seam + room + audit sink.
// ---------------------------------------------------------------------------
export { createPiBindingContext } from './context.js';
export type { BindingContext, CreatePiBindingContextOptions } from './context.js';

// ---------------------------------------------------------------------------
// The dispatch router (local; MCP-SDK-free) — name → registry handler.
// ---------------------------------------------------------------------------
export { dispatchCall, DISPATCH, EMPTY_AUDIT_REF } from './dispatch.js';
export type { DispatchEntry, ToolArgs } from './dispatch.js';

// ---------------------------------------------------------------------------
// The tool generator — `CANONICAL_TOOLS` → Pi `ToolDefinition[]`.
// ---------------------------------------------------------------------------
export { createPiToolDefinitions } from './tools.js';
export type { CreatePiToolDefinitionsOptions } from './tools.js';

// ---------------------------------------------------------------------------
// Registration helpers — extension-time `registerTool` + the extension factory.
// ---------------------------------------------------------------------------
export { registerMxTools, createMxPiExtension } from './register.js';
export type { RegisterMxToolsOptions } from './register.js';

// ---------------------------------------------------------------------------
// Active-tool-selection helpers (bare `mx_*` names; no MCP namespacing).
// ---------------------------------------------------------------------------
export { mxToolNames, isMxToolName } from './names.js';

// ---------------------------------------------------------------------------
// The local Pi ABI mirror + the injected-builder seam (structural; peer-free).
// ---------------------------------------------------------------------------
export type {
  AgentToolResult,
  PiExtensionFactory,
  PiToolHost,
  PiToolResultContent,
  ToolDefinition,
  TypeBoxBuilders,
  TypeBoxSchema,
  TypeBoxTypeNamespace,
} from './pi-abi.js';
