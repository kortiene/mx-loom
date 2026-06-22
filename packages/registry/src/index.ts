// The canonical tool registry (T101 / #9) — the single, enumerable, validated,
// secret-free source of `mx_*` tool descriptors every binding (MCP T109, Claude
// shim T110), the JSON Schema → Zod converter (T111), and the discovery/
// delegation handlers (T104–T108) read from. Descriptors only — no behavior, no
// daemon calls, no result envelope (those are T102/T104–T108).

// The descriptor model.
export { TOOL_NAME_RE, defineDescriptor } from './descriptor.js';
export type { ToolDescriptor, JsonSchema, AsyncSemantics } from './descriptor.js';

// The registry loader/validator.
export { loadRegistry, DescriptorValidationError } from './registry.js';
export type { ToolRegistry } from './registry.js';

// The canonical M1 descriptor set (+ the individual descriptor consts).
export {
  CANONICAL_M1_TOOLS,
  MX_FIND_AGENTS,
  MX_DESCRIBE_AGENT,
  MX_DELEGATE_TOOL,
  MX_RUN_COMMAND,
  MX_AWAIT_RESULT,
  MX_SHARE_CONTEXT,
  MX_GET_CONTEXT,
} from './descriptors/index.js';

// The JSON Schema validation seam (Ajv-backed by default; injectable).
export { createAjvValidator, JSON_SCHEMA_DIALECT } from './validator.js';
export type { SchemaValidator, CompiledSchema } from './validator.js';

// Security invariants — the no-authority allowlist + the secret-free-shape oracle.
export {
  MODEL_FACING_ALLOWLIST,
  FORBIDDEN_AUTHORITY_PREFIXES,
  FORBIDDEN_AUTHORITY_VERBS,
  isForbiddenAuthorityVerb,
  CREDENTIAL_KEY_RE,
  collectSchemaPropertyNames,
  findCredentialShapedProperty,
} from './security.js';

// Immutability helper (used to freeze authored descriptors).
export { deepFreeze } from './freeze.js';
