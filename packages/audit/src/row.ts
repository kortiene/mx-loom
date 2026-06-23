/**
 * The audit row + projection context (T113 / #21) — design §7 (two-tier audit),
 * §8 (MVP scope: "a thin mirror into the existing Postgres audit table").
 *
 * mx-loom's audit is two-tier: the **substrate** — the signed, replay-protected
 * `com.mxagent.*` Matrix event stream — is the tamper-evident *truth*; this
 * package is the **queryable index** an operator searches ("every delegation in
 * room X today", "which model action led to invocation `inv_…`", "what was
 * approved, by correlation to what request"). The {@link AuditRow} is the single
 * non-secret shape that mirror stores, 1:1 with the `mx_audit_log` table
 * (`migrations/0001_mx_audit_log.sql`).
 *
 * The row mirrors a strict, non-secret **subset** of the T102 result envelope.
 * It never carries a `result` payload (which can hold retrieved TEXT), the
 * free-text `error.message`, or the `approval.summary` — only correlation ids
 * (none a secret), the closed-set `tool_name`/`status`/`error_code`, and the
 * approval/idempotency/correlation pointers. See `project.ts` for the mapping
 * and `../README.md` for the secret-subset guarantee.
 */
import type { ErrorCode, ToolStatus } from '@mx-loom/registry';

// Re-export the two closed-vocabulary types the row borrows from the contract,
// so a consumer of `@mx-loom/audit` need not also reach into `@mx-loom/registry`
// for them. Type-only — erased under `verbatimModuleSyntax`, so the audit
// package keeps a **zero runtime** `@mx-loom/registry` dependency (the same
// type-only technique the registry uses for the toolbelt).
export type { ErrorCode, ToolStatus };

/**
 * One row in the queryable mirror — exactly one per returned tool-result
 * envelope. Columns serve the two acceptance criteria and nothing the index does
 * not need:
 *
 *  - **AC 1 (exactly one row per result):** {@link dedup_key} is the unique
 *    write key — re-recording the same emission is a no-op (`ON CONFLICT DO
 *    NOTHING`).
 *  - **AC 2 (correlate model action ↔ daemon invocation ↔ approval):** the four
 *    `audit_ref` ids (daemon invocation / substrate-truth pointer) +
 *    `tool_name`/`correlation_id`/`idempotency_key` (model action) +
 *    `approval_request_id` (approval), all joinable on one row.
 *
 * Every correlation id is **nullable** because the daemon may not (yet) return
 * it — a local read (`mx_find_agents`/`mx_describe_agent`/`mx_workspace_status`)
 * has an all-null `audit_ref`, and a `running` result may precede the daemon's
 * ids (T102 invariant: ids are never fabricated). The row tolerates the nulls
 * and falls back to `call_id`/`correlation_id` as join keys.
 */
export interface AuditRow {
  // --- correlation: the audit_ref (daemon invocation / substrate-truth pointer) ---
  /** `inv_…` — the daemon invocation. */
  readonly invocation_id: string | null;
  /** `req_…` — the signed request. */
  readonly request_id: string | null;
  /** `!…:server` — the Matrix room. The **future tenant key** (RLS-ready, M5/T502). */
  readonly room: string | null;
  /** `$…` — the signed Matrix event (the substrate-truth pointer). */
  readonly event_id: string | null;

  // --- model action ---
  /** Which canonical verb produced this result (`mx_delegate_tool`, `mx_run_command`, …). */
  readonly tool_name: string;
  /** Session-stable `correlation_id` (T005) — ties one session's results together. */
  readonly correlation_id: string | null;
  /** The client-supplied dedup nonce a mutating verb used (T102). */
  readonly idempotency_key: string | null;

  // --- outcome / approval ---
  /** The envelope status (`ok|running|awaiting_approval|denied|error`). */
  readonly status: ToolStatus;
  /** Closed-taxonomy code — populated only when `status ∈ {denied, error}`; never the message. */
  readonly error_code: ErrorCode | null;
  /** `approval.request_id` — populated when `awaiting_approval` (and on the resolved row). */
  readonly approval_request_id: string | null;

  // --- exactly-once ---
  /** Deterministic per `(call_id, status, invocation_id)` — the unique write key (see `project.ts`). */
  readonly dedup_key: string;
}

/**
 * The small, binding-supplied context the projection needs that the
 * {@link import('@mx-loom/registry').ToolResult} envelope alone does **not**
 * carry. This is a real, surfaced coupling: the envelope holds the daemon-side
 * `audit_ref`, `status`, and `approval.request_id`, but the *model-action* side
 * (`tool_name`, the per-call id, `correlation_id`, `idempotency_key`) is known
 * only to the binding at dispatch (MCP T109, Claude shim T110). The projection
 * therefore takes `(result, ctx)`.
 */
export interface AuditContext {
  /** Which `mx_*` verb produced this result. */
  readonly tool_name: string;
  /**
   * The binding's per-tool-call id — the MCP/Claude `tool_use` id, or a freshly
   * minted uuid. Distinct per tool call, so two distinct calls never collide on
   * {@link AuditRow.dedup_key} even when otherwise identical (e.g. two
   * `mx_find_agents` → `ok` with all-null `audit_ref`).
   */
  readonly call_id: string;
  /** Session `correlation_id` (T005), if the binding threads one. */
  readonly correlation_id?: string;
  /** The client-supplied `idempotency_key` the mutating handler used (T102), if any. */
  readonly idempotency_key?: string;
}
