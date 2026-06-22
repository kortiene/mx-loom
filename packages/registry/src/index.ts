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

// ---------------------------------------------------------------------------
// The T103 (deferred-result) + T104 (discovery) handlers — design §4.3 / §2.
// ---------------------------------------------------------------------------

// The `mx_await_result` resolver (handle → terminal-or-still-pending envelope via
// `invocation.get` + `wait_ms` poll-with-timeout) and the pure invocation-state →
// envelope normalizers (`invocationToResult` for an `invocation.get` read,
// `callResponseToResult` for an initial `call.start` reply — T105). The daemon
// transport is injected through `HandlerDeps` (imported `type`-only), so the
// registry keeps its zero runtime toolbelt dep.
export { mxAwaitResult, classifyInvocation, invocationToResult, callResponseToResult } from './handlers/index.js';
export type { AwaitResultInput, HandlerDeps, DaemonCall, InvocationDisposition } from './handlers/index.js';

// The discovery handlers (T104): `mx_find_agents` (agent.list → filter → project)
// and `mx_describe_agent` (agent.tools + agent.list → project the ToolSchema[]).
// Both are `sync` local reads — they resolve to a terminal `ok`/`denied`/`error`
// envelope with an all-null `audit_ref` — plus the pure non-secret projectors.
export { mxFindAgents, mxDescribeAgent, projectAgentSummary, projectAgentDetail, projectTools } from './handlers/index.js';
export type {
  FindAgentsInput,
  DescribeAgentInput,
  DescribeAgentResult,
  AgentSummary,
  AgentDetail,
  PublishedTool,
  AgentLiveness,
} from './handlers/index.js';

// The delegation handler (T105): `mx_delegate_tool` — the primary delegation verb
// (agent.tools → validate args vs the target's `input_schema` → call.start →
// normalize the CallResponse incl. `awaiting_approval`). The first handler to emit
// a populated `audit_ref` and to exercise the idempotency contract end-to-end. Its
// `DelegateDeps` add an injected JSON Schema `validator` + the session `room`.
export { mxDelegateTool } from './handlers/index.js';
export type { DelegateToolInput, DelegateDeps } from './handlers/index.js';

// The guarded-exec handler (T106): `mx_run_command` — the second delegation verb
// (room provenance → exec.start with idempotency → normalize the ExecResponse,
// reusing `callResponseToResult`). The leaner sibling of T105: no inner-schema
// fetch, no args validation. The guard (allow_commands / deny_args_regex /
// allow_cwd / sandbox / requires_approval) runs entirely out-of-process on the
// receiving daemon; the handler surfaces `policy_denied` cleanly, never enforces
// it. Its `ExecDeps` carry the session `room` (the room-scoped seam) and NO
// validator. A permitted command that exits non-zero is `status: ok` with
// `result.exit_code !== 0` (governance outcome, not the command's exit).
export { mxRunCommand } from './handlers/index.js';
export type { RunCommandInput, ExecDeps, RoomScopedDeps } from './handlers/index.js';

// The context-sharing handlers (T107): `mx_share_context` + `mx_get_context` — the
// publish/fetch seam for the substrate's cross-agent context channel (a diff, a
// file, an env snapshot one agent produces and another needs to read), mapping to
// the daemon `share.file/diff/env` (publish) and `share.get` (fetch). Both `sync`,
// both `RoomScopedDeps` (no validator). The inline (≤256 KiB) vs Matrix-media split,
// the content-addressing, and the authoritative sha256 over stored bytes are
// *substrate* behavior the handlers surface (via `context_id` / `sha256` / the
// `inline` vs `media_mxc` discriminator) and never reimplement — mx-loom holds no
// Matrix credentials and downloads no media (Boundary A). `mx_share_context` is the
// single most dangerous exfiltration surface and is doubly bounded: the concrete
// `MxClient.call` rejects credential-shaped `content`/`path` as `invalid_args`
// before dispatch. `contextResponseToResult` is the shared flat-payload classifier.
export { mxShareContext, mxGetContext, contextResponseToResult } from './handlers/index.js';
export type { ShareContextInput, GetContextInput } from './handlers/index.js';
