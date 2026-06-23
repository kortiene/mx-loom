/**
 * The envelope serializer (T109) — `ToolResult` → MCP `CallToolResult`.
 *
 * The crux of AC2 (a delegated call round-trips as a normalized envelope) and AC3
 * (`awaiting_approval` surfaces correctly). Pure and total: a T102 {@link ToolResult}
 * in, an MCP {@link CallToolResult} out, no daemon, no I/O — so it is unit-pinnable
 * with a status table.
 *
 * The mapping (a documented, stable invariant downstream M2 bindings and T114 rely on):
 *  - **`structuredContent`** ← the **full** envelope verbatim (`status`, `result`,
 *    `error`, `handle`, `approval`, `audit_ref`). This is the machine-readable
 *    channel a modern MCP client reacts to programmatically — it is what makes
 *    every status, including `awaiting_approval` (handle + approval) and `denied`
 *    (denial code), reactable rather than prose to be parsed (design §4.5).
 *  - **`content[0]`** ← a single `text` block carrying the same envelope as JSON,
 *    for clients that do not read `structuredContent`.
 *  - **`isError`** ← `true` **only** for `status === "error"` (the fault-set). This
 *    is the single most important serialization rule: `denied` is a *governance*
 *    outcome the model must read and replan around (not a transport failure), and
 *    `running` / `awaiting_approval` are legitimate in-progress states — flagging
 *    any of them as a protocol error would push a runtime to retry or abort instead
 *    of awaiting/replanning. `ok` is obviously not an error.
 *
 * Secret boundary: the envelope is already secret-free by the T102/T008 contract
 * (no `result` payload, `error.message`, `approval.summary`, or `audit_ref` id is a
 * credential). The serializer copies **only** the envelope into `content` /
 * `structuredContent` and never reaches outside it — so it can introduce no leak.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '@mx-loom/registry';

/**
 * Map a normalized T102 {@link ToolResult} onto an MCP {@link CallToolResult}.
 *
 * Pure + total: every one of the five statuses maps; `isError` is `true` iff the
 * status is the fault `error`. The envelope is placed in `structuredContent`
 * verbatim and rendered as JSON `text` in `content`.
 */
export function serializeToolResult(result: ToolResult): CallToolResult {
  // The full envelope, verbatim — assembled as a plain record so it satisfies
  // MCP's `structuredContent` ({ [key: string]: unknown }). A `ToolResult` is a
  // named interface (no index signature), so we shape it explicitly rather than
  // relying on a lossy cast; this also documents the exact wire shape.
  const envelope: Record<string, unknown> = {
    status: result.status,
    result: result.result,
    error: result.error,
    handle: result.handle,
    approval: result.approval,
    audit_ref: result.audit_ref,
  };

  return {
    // Machine-readable channel — the full envelope.
    structuredContent: envelope,
    // Human-/model-readable channel — the same envelope as JSON text.
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    // ONLY a genuine fault is a protocol error. `denied` / `awaiting_approval` /
    // `running` / `ok` are NOT `isError` — they are outcomes the model reads.
    isError: result.status === 'error',
  };
}
