// The canonical tool registry (T101 / #9) + the normalized result contract
// (T102 / #10). The descriptor set is the single, enumerable, validated,
// secret-free source of `mx_*` tools every binding (MCP T109, Claude shim T110),
// the JSON Schema → Zod converter (T111), and the discovery/delegation handlers
// (T104–T108) read from. T102 adds the one result **envelope** (`{status, result,
// error, handle, approval, audit_ref}`), the closed `error.code` taxonomy +
// fault→envelope mappers, and the client-supplied `idempotency_key` contract —
// the contract layer the handlers (T104–T108) build envelopes with. Still no
// behavior and no daemon calls here.

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

// ---------------------------------------------------------------------------
// The normalized result contract (T102 / #10) — design §4.2/§4.4/§4.5/§4.6.
// ---------------------------------------------------------------------------

// The result envelope — the single shape every tool returns — and its
// constructor helpers (the only sanctioned way to build a conforming envelope).
export { ok, running, awaitingApproval, denied, errored } from './envelope.js';
export type { ToolResult, ToolStatus, ToolError, ApprovalInfo, AuditRef } from './envelope.js';

// The closed `error.code` taxonomy, the denied/error status partition, the
// runtime guard, and the fault→envelope mappers.
export {
  ERROR_CODES,
  DENIAL_CODES,
  FAULT_CODES,
  isErrorCode,
  mapTransportError,
  mapDaemonError,
} from './errors.js';
export type { ErrorCode, DenialCode, FaultCode } from './errors.js';

// The draft-07 envelope schema + ready-to-use validator (AC 1).
export { ENVELOPE_SCHEMA, validateEnvelope } from './envelope-schema.js';

// Client-supplied idempotency (AC 3) — the generator + the key prefix.
export { newIdempotencyKey, IDEMPOTENCY_KEY_PREFIX } from './idempotency.js';
