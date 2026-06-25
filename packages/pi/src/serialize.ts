/**
 * The envelope serializer (T205) — `ToolResult` → Pi `AgentToolResult`.
 *
 * The TypeBox sibling of `@mx-loom/mcp`'s `serializeToolResult`. Pure and total: a
 * T102 {@link ToolResult} in, a Pi {@link AgentToolResult} out, no daemon, no I/O —
 * so it is unit-pinnable with a status table.
 *
 * The mapping:
 *  - **`details`** ← the **full** envelope verbatim (`status`, `result`, `error`,
 *    `handle`, `approval`, `audit_ref`). Pi has no MCP `structuredContent` channel,
 *    so `details` is the machine-readable channel a host/model reacts to.
 *  - **`content[0]`** ← a single `text` block carrying the **same** envelope as
 *    JSON, for the model loop and for any consumer that reads only `content`.
 *  - **No Pi failure flag.** `denied` / `running` / `awaiting_approval` are NOT
 *    failures — they are outcomes the model reads and replans around (the same
 *    rule as the MCP serializer's `isError === (status === 'error')`). And even a
 *    genuine `status: "error"` envelope is a *result the model should read*, not a
 *    Pi tool-execution failure, so it too maps to a normal `AgentToolResult`
 *    carrying the envelope. Adapter bugs never reach here as a throw — `tools.ts`
 *    converts them to an `errored('internal', …)` envelope first — so the Pi
 *    "failed"/`terminate` flag is never raised by this binding.
 *
 * Secret boundary: the envelope is already secret-free by the T102/T008 contract
 * (no `result` payload, `error.message`, `approval.summary`, or `audit_ref` id is
 * a credential). The serializer copies **only** the envelope into `content` /
 * `details` and never reaches outside it — so it can introduce no leak. Both
 * channels carry the identical object, so a redaction-shaped value is redacted (by
 * the toolbelt seam, upstream) in both at once.
 */
import type { ToolResult } from '@mx-loom/registry';

import type { AgentToolResult } from './pi-abi.js';

/** The full T102 envelope as a plain record — the verbatim wire shape both channels carry. */
function toEnvelope(result: ToolResult): Record<string, unknown> {
  // A `ToolResult` is a named interface (no index signature); shape it explicitly
  // rather than via a lossy cast, documenting the exact fields and order.
  return {
    status: result.status,
    result: result.result,
    error: result.error,
    handle: result.handle,
    approval: result.approval,
    audit_ref: result.audit_ref,
  };
}

/**
 * Map a normalized T102 {@link ToolResult} onto a Pi {@link AgentToolResult}.
 *
 * Pure + total: every one of the five statuses maps to a normal (non-failing)
 * `AgentToolResult` whose `content[0].text` is the JSON envelope and whose
 * `details` is the same envelope object.
 */
export function serializePiToolResult(result: ToolResult): AgentToolResult {
  const envelope = toEnvelope(result);
  return {
    // Model-/loop-readable channel — the envelope as JSON text.
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    // Structured channel (Pi's stand-in for MCP `structuredContent`) — the same
    // envelope object, so a host can react to `status` / `handle` / `approval`
    // programmatically without re-parsing the text.
    details: envelope,
  };
}
