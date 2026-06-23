/**
 * The pure projection (T113 / #21) — design §7/§8.
 *
 * {@link auditRowFrom} maps a T102 `ToolResult` + a binding-supplied
 * {@link AuditContext} onto a non-secret {@link AuditRow}. It is **pure, total,
 * deterministic, and does no I/O** — given any well-formed envelope it never
 * throws and always returns a valid row. All persistence lives behind the
 * {@link import('./sink.js').AuditSink} port; this module just shapes the row.
 *
 * Secret hygiene is structural here: the projection lifts only the non-secret
 * *subset* of the envelope. It reads `error.code` (closed taxonomy) but **never**
 * `error.message`; it reads `approval.request_id` but **never** `approval.summary`;
 * it never touches `result`. So no token, free text, or payload can reach a row
 * by construction. See `secret-boundary.test.ts`.
 */
import type { ToolResult, ToolStatus } from '@mx-loom/registry';

import type { AuditContext, AuditRow } from './row.js';

/** Placeholder for a null `invocation_id` inside a {@link deriveDedupKey} string. */
const NULL_INVOCATION = '∅'; // ∅

/**
 * Derive the deterministic exactly-once write key for one emission (AC 1).
 *
 * Each *returned envelope* is one audit event → one row (an append-only trail).
 * A deferred call that returns `running` then resolves `ok` is **two** events
 * sharing one `invocation_id` — that *is* the trail, not a duplicate — so the key
 * folds in `status`. The binding supplies a unique `call_id` per tool call, so:
 *
 *  - two **distinct** calls never collide (even both `mx_find_agents` → `ok` with
 *    an all-null `audit_ref`), because their `call_id`s differ; and
 *  - a **re-emission** of the same call+status collides, so `ON CONFLICT
 *    (dedup_key) DO NOTHING` makes the second write a no-op.
 *
 * `invocation_id` is folded in defensively: it pins the key to the substrate
 * invocation when the daemon has returned one, while a null collapses to a fixed
 * placeholder so the key stays stable for local reads.
 */
export function deriveDedupKey(callId: string, status: ToolStatus, invocationId: string | null): string {
  return `${callId}:${status}:${invocationId ?? NULL_INVOCATION}`;
}

/**
 * Project a result envelope + its dispatch context onto an {@link AuditRow}.
 * Pure and total — see the module doc. The four `audit_ref` ids are lifted
 * verbatim (already non-secret, may be `null`); `error_code` is the closed-set
 * code (never the message) and only present for `denied`/`error`;
 * `approval_request_id` only for an `awaiting_approval` (or its resolved) result.
 */
export function auditRowFrom(result: ToolResult, ctx: AuditContext): AuditRow {
  const ref = result.audit_ref;
  return {
    // correlation — the audit_ref, verbatim (never fabricated; may be null)
    invocation_id: ref.invocation_id,
    request_id: ref.request_id,
    room: ref.room,
    event_id: ref.event_id,
    // model action — from the binding-supplied context
    tool_name: ctx.tool_name,
    correlation_id: ctx.correlation_id ?? null,
    idempotency_key: ctx.idempotency_key ?? null,
    // outcome / approval — closed-set code only, never free text
    status: result.status,
    error_code: result.error?.code ?? null,
    approval_request_id: result.approval?.request_id ?? null,
    // exactly-once
    dedup_key: deriveDedupKey(ctx.call_id, result.status, ref.invocation_id),
  };
}
