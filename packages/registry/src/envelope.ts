/**
 * The normalized result envelope (T102 / #10) — design §4.2.
 *
 * **One shape every mx-loom tool returns.** Whatever a handler (T104–T108) does —
 * a successful delegation, a deferred handle, a held approval, a policy denial, a
 * transport fault — it returns a {@link ToolResult}. A runtime binding (MCP T109,
 * Claude shim T110, ADK/OpenCode/Pi later) then reacts to `status` / `error.code`
 * programmatically, never by parsing prose.
 *
 * This module is **contract only**: the types, plus the constructor helpers that
 * make a non-conforming envelope unrepresentable. It executes nothing, makes no
 * daemon call, and holds no `@mx-loom/toolbelt` runtime dependency — the per-tool
 * *construction* of envelopes is the handlers' job, which they do **only** through
 * the helpers here, so every handler conforms by construction. The envelope JSON
 * Schema (`./envelope-schema.ts`) is the mechanical contract the helper outputs
 * are validated against (AC 1).
 *
 * Secret-free output boundary (design §4.7, §6): no envelope field carries a
 * credential. `error.message`, `approval.summary`, and the `audit_ref` ids are
 * human/operator-readable and MUST never contain a secret or token.
 */
import { type DenialCode, type ErrorCode, type FaultCode } from './errors.js';
import { deepFreeze } from './freeze.js';

/**
 * The closed five-status set (design §4.2). There is **no** `cancelled` status:
 * T108 (`mx_cancel`) resolved cancellation within these five — `mx_cancel`'s own
 * acknowledgement is a terminal `ok({ cancelled })`, and an *observed* cancelled
 * invocation maps to a clean terminal `error` (the conservative M1 disposition;
 * see `handlers/invocation.ts`). The closed nine-code error taxonomy stays frozen.
 */
export type ToolStatus = 'ok' | 'running' | 'awaiting_approval' | 'denied' | 'error';

/** A failure: a closed-set {@link ErrorCode} + a human-readable, **secret-free** message. */
export interface ToolError {
  readonly code: ErrorCode;
  readonly message: string;
}

/**
 * The read-only approval block surfaced with `awaiting_approval` (design §4.2,
 * §5). It **reports** a pending governance decision; it confers no ability to
 * approve. The operator decides out-of-process and the receiving daemon
 * re-validates against live policy at release — the model never self-approves.
 */
export interface ApprovalInfo {
  readonly request_id: string;
  readonly risk: 'low' | 'medium' | 'high';
  /** Operator-facing, secret-free. */
  readonly summary: string;
  /** ISO-8601. */
  readonly expires_at: string;
}

/**
 * Correlation ids tying "model decided X" ↔ "daemon executed Y" ↔ "operator
 * approved Z" to the signed Matrix events (design §4.6). Structurally **always
 * present** on an envelope; an inner id is `null` when the daemon does not (yet)
 * return it (T102 OQ #4) — never fabricated. None of these ids is a secret; the
 * Postgres mirror is T113.
 */
export interface AuditRef {
  readonly invocation_id: string | null;
  readonly request_id: string | null;
  /** Matrix room, e.g. `"!…:server"`. */
  readonly room: string | null;
  /** Matrix event, e.g. `"$…"`. */
  readonly event_id: string | null;
}

/**
 * The single shape every mx-loom tool returns (design §4.2). Field presence is a
 * `status`-discriminated union — see the helpers below and the per-status table:
 *
 * | `status`            | `result` | `error`              | `handle` | `approval` |
 * |---------------------|----------|----------------------|----------|------------|
 * | `ok`                | object   | null                 | null     | null       |
 * | `running`           | null     | null                 | string   | null       |
 * | `awaiting_approval` | null     | null                 | string   | object     |
 * | `denied`            | null     | `{code ∈ denial-set}`| null     | null       |
 * | `error`             | null     | `{code ∈ fault-set}` | null     | null       |
 *
 * `audit_ref` is required for every status. The {@link ./envelope-schema.ENVELOPE_SCHEMA}
 * enforces this table mechanically; the helpers enforce it by construction.
 */
export interface ToolResult<T = unknown> {
  readonly status: ToolStatus;
  readonly result: T | null;
  readonly error: ToolError | null;
  /** Present when `status` is `running` | `awaiting_approval`. */
  readonly handle: string | null;
  /** Present when `status` is `awaiting_approval`. */
  readonly approval: ApprovalInfo | null;
  /** Always present (design §4.6). */
  readonly audit_ref: AuditRef;
}

// ---------------------------------------------------------------------------
// Constructor helpers — the ONLY sanctioned way to build a ToolResult.
//
// Each requires an `audit_ref`, sets exactly the fields its status permits, and
// deep-freezes the envelope so a built result is immutable to every consumer. A
// handler built on these cannot emit a non-conforming envelope (AC 1, by
// construction). `denied()` accepts only a `DenialCode` and `errored()` only a
// `FaultCode`, so the status↔code partition (errors.ts) is compiler-enforced.
// ---------------------------------------------------------------------------

/** A terminal success. `result` is the tool's success payload (validated vs the
 * tool's `output_schema` by the handler — T105, not here). */
export function ok<T>(result: T, audit_ref: AuditRef): ToolResult<T> {
  const envelope: ToolResult<T> = {
    status: 'ok',
    result,
    error: null,
    handle: null,
    approval: null,
    audit_ref,
  };
  return deepFreeze(envelope);
}

/** A deferred, still-running call. `handle` is resolved to a terminal envelope
 * via `mx_await_result` (T103). */
export function running(handle: string, audit_ref: AuditRef): ToolResult<never> {
  const envelope: ToolResult<never> = {
    status: 'running',
    result: null,
    error: null,
    handle,
    approval: null,
    audit_ref,
  };
  return deepFreeze(envelope);
}

/** A call held at a human approval gate. The model keeps planning and resolves
 * the `handle` after the operator decides (design §5). */
export function awaitingApproval(handle: string, approval: ApprovalInfo, audit_ref: AuditRef): ToolResult<never> {
  const envelope: ToolResult<never> = {
    status: 'awaiting_approval',
    result: null,
    error: null,
    handle,
    approval,
    audit_ref,
  };
  return deepFreeze(envelope);
}

/** A governance denial (status `denied`). `code` is restricted to the denial-set
 * (`policy_denied | untrusted_key | approval_denied | approval_expired`). */
export function denied(code: DenialCode, message: string, audit_ref: AuditRef): ToolResult<never> {
  const envelope: ToolResult<never> = {
    status: 'denied',
    result: null,
    error: { code, message },
    handle: null,
    approval: null,
    audit_ref,
  };
  return deepFreeze(envelope);
}

/** An operational failure (status `error`). `code` is restricted to the fault-set
 * (`timeout | not_found | invalid_args | target_offline | internal`). */
export function errored(code: FaultCode, message: string, audit_ref: AuditRef): ToolResult<never> {
  const envelope: ToolResult<never> = {
    status: 'error',
    result: null,
    error: { code, message },
    handle: null,
    approval: null,
    audit_ref,
  };
  return deepFreeze(envelope);
}
