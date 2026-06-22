/**
 * The canonical, transport-neutral tool descriptor model (T101 / #9).
 *
 * One descriptor set is the single source for **all** bindings (design §3, §9):
 * the generated MCP server (T109), the Claude SDK shim (T110), the JSON Schema →
 * Zod converter (T111), and the discovery/delegation handlers (T104–T108) each
 * read the *same* descriptors. A descriptor is pure, secret-free metadata — it
 * carries **no behavior, no daemon-RPC mapping, and no result envelope** (those
 * are deliberately attached later by the handlers and T102).
 */
import { deepFreeze } from './freeze.js';

/**
 * A JSON Schema document, in the dialect the registry validates against
 * (draft-07 — see {@link ../validator.JSON_SCHEMA_DIALECT}). Opaque at the type
 * level; the loader compiles it against the meta-schema (the AC-1 check).
 */
export type JsonSchema = Record<string, unknown>;

/**
 * Async semantics (design §4.3 — "the one piece of semantics a runtime cannot
 * skip"). A `sync` tool resolves to a terminal success payload directly; a
 * `deferred` tool may instead return `status: running | awaiting_approval` plus
 * a `handle` the caller resolves via `mx_await_result`. Bindings key on this:
 * ADK wraps `deferred` tools as `LongRunningFunctionTool`, the Claude shim hides
 * the poll loop, generic MCP surfaces the handle. **T101 carries only the FLAG;
 * the deferred-result protocol itself is T103.**
 */
export type AsyncSemantics = 'sync' | 'deferred';

/** Transport-neutral, secret-free, model-facing tool descriptor. Pure metadata. */
export interface ToolDescriptor {
  /** Namespaced model-facing name; MUST match {@link TOOL_NAME_RE}. */
  readonly name: string;
  /** One-line, human/model-readable description. Non-empty; never a secret. */
  readonly description: string;
  /**
   * JSON Schema for the tool's input. For `mx_delegate_tool` this is the OUTER
   * envelope (`agent`/`tool`/`args`); the inner tool's args are validated
   * dynamically against the target's published `ToolSchema.input_schema` at
   * dispatch (T105), never baked in here.
   */
  readonly input_schema: JsonSchema;
  /**
   * JSON Schema for the tool's success payload (what the T102 envelope's
   * `result` is validated against, later). May be an open object where the
   * shape is only known at call time (e.g. `mx_delegate_tool`/`mx_await_result`).
   */
  readonly output_schema: JsonSchema;
  /** Whether the tool may return a deferred handle requiring `mx_await_result`. */
  readonly async_semantics: AsyncSemantics;
}

/**
 * The `mx_*` namespace rule for a model-facing verb name.
 *
 * `mx_` prefix, then lowercase `[a-z0-9]` segments joined by single underscores.
 * Accepts `mx_find_agents` / `mx_delegate_tool`; rejects `find_agents` (no
 * prefix), `mx_` (empty tail), `mxFindAgents` (camelCase), `mx__x` (double
 * separator), and `mx_X` (uppercase).
 */
export const TOOL_NAME_RE = /^mx_[a-z0-9]+(?:_[a-z0-9]+)*$/;

/**
 * Author a descriptor: validate-light at the type level (`ToolDescriptor`) and
 * deep-freeze so the canonical const is immutable to every consumer. The full
 * validation (JSON Schema validity, uniqueness, no-authority, secret-free shape)
 * runs in {@link ../registry.loadRegistry}.
 */
export function defineDescriptor(descriptor: ToolDescriptor): ToolDescriptor {
  return deepFreeze(descriptor);
}
