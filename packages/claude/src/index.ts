// The mx-loom Claude Agent SDK binding (`area/claude-binding`).
//
// T111 (#19) lands the first module: the JSON Schema → Zod converter that turns
// each canonical `mx_*` descriptor's draft-07 `input_schema` (from
// `@mx-loom/registry`) into an equivalent Zod schema the SDK's `tool()` accepts.
// Fail-closed on any construct outside the supported subset; equivalence is proven
// against the registry's Ajv seam.
//
// T110 (the `tool()` / `createSdkMcpServer()` registration, `canUseTool` HITL
// wiring, and the hidden `mx_await_result` poll loop) builds on top of this.

export {
  jsonSchemaToZod,
  jsonSchemaToZodRawShape,
  JsonSchemaConversionError,
  SUPPORTED_JSON_SCHEMA_TYPES,
} from './json-schema-to-zod.js';
export type { ConvertOptions } from './json-schema-to-zod.js';
