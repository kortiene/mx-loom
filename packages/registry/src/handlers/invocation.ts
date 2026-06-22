/**
 * The invocation-state → result-envelope normalizer (T103 / #11) — design §4.2
 * (the envelope) / §4.3 (the deferred protocol) / §5 (the invocation flow).
 *
 * The **pure heart** of `mx_await_result`: it takes a raw `invocation.get`
 * response and returns a T102 {@link ToolResult}, classifying the invocation into
 * exactly one of the five statuses and building the envelope **only** through the
 * T102 constructor helpers (so it conforms to `ENVELOPE_SCHEMA` by construction).
 * No I/O; **never throws** — an unrecognised/malformed response degrades to a safe
 * `errored('internal', …)`.
 *
 * The exact v0.2.1 invocation **state vocabulary**, the held-invocation `approval`
 * fields, and the `audit_ref` field availability are **pending the two-daemon
 * round-trip** (spec Open Questions #3–#5): this module is authored against the
 * design's named states with a safe `internal` fallback now, and pinned to the
 * verified vocabulary at the conformance round-trip. A mis-mapped state degrades
 * to `internal` (never the wrong code — only less specific), never throws.
 *
 * Secret-free output (design §4.7, §6): the normalizer **echoes no raw daemon
 * payload** into `error.message` or `approval.summary` — those are built from a
 * fixed vocabulary + the (non-secret) code; `audit_ref` ids are correlation
 * handles, never secrets. A missing id is `null`, never fabricated.
 */
import {
  awaitingApproval,
  denied,
  errored,
  ok,
  running,
  type ApprovalInfo,
  type AuditRef,
  type ToolResult,
  type ToolStatus,
} from '../envelope.js';
import { DENIAL_CODES, mapDaemonError, type DenialCode, type ErrorCode } from '../errors.js';

/** The five envelope statuses an invocation resolves to (mirrors `ToolStatus`). */
export type InvocationDisposition = 'running' | 'awaiting_approval' | 'ok' | 'denied' | 'error';

/** A fixed, **secret-free** message per error code (built from the code only,
 *  never by echoing a raw daemon payload — design §4.7 / §6). */
const MESSAGE_FOR_CODE: Readonly<Record<ErrorCode, string>> = {
  policy_denied: 'denied by the receiver policy',
  untrusted_key: 'the signing key is not trusted by the receiver',
  approval_denied: 'the operator denied the approval request',
  approval_expired: 'the approval request expired before a decision',
  timeout: 'the operation timed out',
  not_found: 'no such invocation',
  invalid_args: 'the request was rejected as invalid',
  target_offline: 'the target agent is offline',
  internal: 'the invocation failed',
};

const UNRECOGNISED_MESSAGE = 'unrecognised invocation state';

/**
 * The coarse kind a (normalised) daemon state token maps to. A `fail` is split
 * into `denied` vs `error` later by the **mapped code's** set membership (spec
 * Open Question #7 — disposition follows the mapped code, not the state label).
 */
type StateKind = 'running' | 'awaiting_approval' | 'ok' | 'fail';

/**
 * Daemon invocation-state tokens (normalised: lowercased, non-alphanumerics
 * collapsed to `_`, edges trimmed — mirroring `errors.ts`'s `normaliseDaemonCode`)
 * → the coarse {@link StateKind}. Authored against the design's named states
 * (§5); pinned to the verified v0.2.1 vocabulary at the two-daemon round-trip.
 *
 * `cancelled` is **deliberately absent** — a cancelled invocation is T108
 * (`mx_cancel`) territory; here it degrades to the safe `internal` fallback until
 * T108 pins its disposition.
 */
const INVOCATION_STATE_KIND: Readonly<Record<string, StateKind>> = {
  // In-flight / executing.
  running: 'running',
  in_flight: 'running',
  inflight: 'running',
  executing: 'running',
  active: 'running',
  pending: 'running',
  queued: 'running',
  started: 'running',
  dispatched: 'running',
  // Held at the human approval gate.
  awaiting_approval: 'awaiting_approval',
  awaiting: 'awaiting_approval',
  held: 'awaiting_approval',
  approval_pending: 'awaiting_approval',
  pending_approval: 'awaiting_approval',
  needs_approval: 'awaiting_approval',
  // Terminal success.
  ok: 'ok',
  completed: 'ok',
  complete: 'ok',
  succeeded: 'ok',
  success: 'ok',
  done: 'ok',
  finished: 'ok',
  resolved: 'ok',
  // Terminal failure (denied vs error decided by the mapped code).
  denied: 'fail',
  denied_by_policy: 'fail',
  policy_denied: 'fail',
  rejected: 'fail',
  approval_denied: 'fail',
  approval_rejected: 'fail',
  approval_expired: 'fail',
  approval_timeout: 'fail',
  untrusted: 'fail',
  untrusted_key: 'fail',
  failed: 'fail',
  error: 'fail',
  errored: 'fail',
  faulted: 'fail',
  not_found: 'fail',
  timeout: 'fail',
  timed_out: 'fail',
  offline: 'fail',
  target_offline: 'fail',
  agent_offline: 'fail',
  unreachable: 'fail',
};

// ---------------------------------------------------------------------------
// Small, total readers — no throw, no assumption about the wire layout (which is
// pending the round-trip). A non-object / array value reads as "absent".
// ---------------------------------------------------------------------------

function asRecord(x: unknown): Record<string, unknown> | undefined {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined;
}

function readString(x: unknown): string | undefined {
  return typeof x === 'string' ? x : undefined;
}

/** Normalise a daemon state spelling to a lookup key (mirrors errors.ts). */
function normaliseToken(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function stateToken(obj: Record<string, unknown>): string | undefined {
  const raw = readString(obj.state) ?? readString(obj.status) ?? readString(obj.phase);
  return raw !== undefined ? normaliseToken(raw) : undefined;
}

/**
 * The correlation ids (design §4.6), read from the response's `audit_ref` block
 * if present, else flat on the record. Missing ids are `null` — never fabricated.
 */
function extractAuditRef(obj: Record<string, unknown> | undefined): AuditRef {
  const o = obj ?? {};
  const a = asRecord(o.audit_ref) ?? o;
  return {
    invocation_id: readString(a.invocation_id) ?? readString(o.invocation_id) ?? readString(o.id) ?? null,
    request_id: readString(a.request_id) ?? readString(o.request_id) ?? null,
    room: readString(a.room) ?? readString(o.room) ?? null,
    event_id: readString(a.event_id) ?? readString(o.event_id) ?? null,
  };
}

/** The handle carried on a pending envelope: the invocation id the daemon echoes. */
function handleOf(obj: Record<string, unknown>, audit_ref: AuditRef): string {
  return readString(obj.handle) ?? audit_ref.invocation_id ?? readString(obj.id) ?? '';
}

/** The success payload. The envelope's `ok` branch requires an object, so a
 *  missing / non-object payload normalises to `{}` (pending the round-trip). */
function resultOf(obj: Record<string, unknown>): Record<string, unknown> {
  return asRecord(obj.result) ?? {};
}

/** A risk level, validated against the enum. An absent/unknown risk is reported
 *  as `high` — a **fail-safe** default (never under-stated), not an invented
 *  specific value; a real lower risk is only ever surfaced when the daemon says so. */
function readRisk(x: unknown): ApprovalInfo['risk'] {
  return x === 'low' || x === 'medium' || x === 'high' ? x : 'high';
}

/**
 * The read-only approval block of a held invocation. Populated from what the
 * daemon returns (`approval` block, else flat); fields it omits are filled with
 * **non-fabricated** placeholders (`''` / fail-safe `high` risk) so the envelope
 * stays schema-valid without inventing a misleading risk or summary (spec OQ #4).
 */
function approvalOf(obj: Record<string, unknown>): ApprovalInfo {
  const a = asRecord(obj.approval) ?? obj;
  return {
    request_id: readString(a.request_id) ?? readString(obj.request_id) ?? '',
    risk: readRisk(a.risk),
    summary: readString(a.summary) ?? '',
    expires_at: readString(a.expires_at) ?? '',
  };
}

function isDenialCode(code: ErrorCode): code is DenialCode {
  return (DENIAL_CODES as readonly string[]).includes(code);
}

/**
 * Build a terminal-failure envelope from a closed-set {@link ErrorCode}: `denied`
 * when the code is in the denial-set, `errored` when it is in the fault-set
 * (compiler-enforced by the helper signatures). The message is the fixed,
 * secret-free phrase for the code. Shared with the resolver's transport-fault path.
 */
export function failureResult(code: ErrorCode, audit_ref: AuditRef): ToolResult {
  const message = MESSAGE_FOR_CODE[code];
  return isDenialCode(code) ? denied(code, message, audit_ref) : errored(code, message, audit_ref);
}

/**
 * The error code of a terminal-failure invocation. Prefers an explicit daemon
 * error object on the record (`mapDaemonError`), else interprets the **state
 * label itself** as the daemon code (e.g. `state: "approval_denied"` with no
 * nested error object). Falls back to `internal` (safe — never the wrong code).
 */
function failureCode(obj: Record<string, unknown>, token: string | undefined): ErrorCode {
  const fromPayload = mapDaemonError(obj);
  if (fromPayload !== 'internal') return fromPayload;
  if (token !== undefined) {
    const fromState = mapDaemonError(token);
    if (fromState !== 'internal') return fromState;
  }
  return 'internal';
}

/** Does the record carry an explicit daemon error signal (`{ok:false}` or an
 *  `error` object/string)? Used to classify a stateless failure response. */
function hasErrorSignal(obj: Record<string, unknown>): boolean {
  if (obj.ok === false) return true;
  const err = obj.error;
  return typeof err === 'string' || asRecord(err) !== undefined;
}

/**
 * Does the record carry an explicit **success** signal? A synchronous `call.start`
 * success may arrive as a bare `CallResponse{ ok: true, result }` with no
 * running/awaiting/ok *state token* — `invocationToResult` would treat that
 * tokenless shape as unrecognised (`internal`), which is correct for an
 * `invocation.get` read (where a missing state IS suspicious) but wrong for a
 * `call.start` reply. {@link callResponseToResult} adds this signal so a sync
 * success normalises to `ok` (T105 AC 1).
 */
function hasSuccessSignal(obj: Record<string, unknown>): boolean {
  return obj.ok === true || asRecord(obj.result) !== undefined;
}

/** Is `status` a terminal envelope status (`ok` / `denied` / `error`)? The
 *  complement (`running` / `awaiting_approval`) is still-pending. Shared by the
 *  `mx_await_result` poll loop (T103) and the `mx_delegate_tool` inline-wait (T105). */
export function isTerminal(status: ToolStatus): boolean {
  return status === 'ok' || status === 'denied' || status === 'error';
}

/**
 * Map a raw `invocation.get` response onto a T102 {@link ToolResult}. Pure;
 * **never throws**. Builds the envelope only through the T102 constructor helpers,
 * so the output conforms to `ENVELOPE_SCHEMA` by construction.
 */
export function invocationToResult(raw: unknown): ToolResult {
  const obj = asRecord(raw);
  const audit_ref = extractAuditRef(obj);

  // Not an object (null / scalar / array) → cannot classify.
  if (obj === undefined) {
    return errored('internal', UNRECOGNISED_MESSAGE, audit_ref);
  }

  const token = stateToken(obj);
  const kind = token !== undefined ? INVOCATION_STATE_KIND[token] : undefined;

  switch (kind) {
    case 'running':
      return running(handleOf(obj, audit_ref), audit_ref);
    case 'awaiting_approval':
      return awaitingApproval(handleOf(obj, audit_ref), approvalOf(obj), audit_ref);
    case 'ok':
      return ok(resultOf(obj), audit_ref);
    case 'fail':
      return failureResult(failureCode(obj, token), audit_ref);
    default:
      // No recognised state token. A record carrying an explicit daemon error is
      // still a terminal failure; anything else is genuinely unrecognised.
      return hasErrorSignal(obj)
        ? failureResult(failureCode(obj, token), audit_ref)
        : errored('internal', UNRECOGNISED_MESSAGE, audit_ref);
  }
}

/**
 * Map a raw `call.start` `CallResponse` onto a T102 {@link ToolResult} (T105 / #13)
 * — the sibling of {@link invocationToResult} for the **initial** delegation reply.
 *
 * It shares every reader/classifier with `invocationToResult` (the state-token
 * table, `failureCode`, `approvalOf`, `extractAuditRef`, …) so an initial
 * delegation result and a later `mx_await_result` poll on the same shape agree by
 * construction. The **one** difference is the default branch: a synchronous
 * `call.start` success can arrive as a bare `{ ok: true, result }` with no state
 * token, so a tokenless reply with a {@link hasSuccessSignal} normalises to `ok`
 * (not the `internal` an `invocation.get` read would yield). Authoring
 * `invocationToResult` (T103, verified for `invocation.get`) untouched keeps each
 * verb's tokenless semantics correct.
 *
 * Pure; **never throws**; builds the envelope only through the T102 helpers, so the
 * output conforms to `ENVELOPE_SCHEMA` by construction.
 */
export function callResponseToResult(raw: unknown): ToolResult {
  const obj = asRecord(raw);
  const audit_ref = extractAuditRef(obj);

  // Not an object (null / scalar / array) → cannot classify.
  if (obj === undefined) {
    return errored('internal', UNRECOGNISED_MESSAGE, audit_ref);
  }

  const token = stateToken(obj);
  const kind = token !== undefined ? INVOCATION_STATE_KIND[token] : undefined;

  switch (kind) {
    case 'running':
      return running(handleOf(obj, audit_ref), audit_ref);
    case 'awaiting_approval':
      return awaitingApproval(handleOf(obj, audit_ref), approvalOf(obj), audit_ref);
    case 'ok':
      return ok(resultOf(obj), audit_ref);
    case 'fail':
      return failureResult(failureCode(obj, token), audit_ref);
    default: {
      // No recognised state token. Classify by signal, most-specific first:
      //  - an explicit error signal (`{ok:false}` / `error`) is a terminal failure;
      //  - an explicit SUCCESS signal (`{ok:true}` / a `result` object) is a
      //    synchronous `ok` (the call.start-specific case `invocationToResult` lacks);
      //  - a bare handle with no state is a deferred `running`;
      //  - otherwise genuinely unrecognised → `internal`.
      if (hasErrorSignal(obj)) return failureResult(failureCode(obj, token), audit_ref);
      if (hasSuccessSignal(obj)) return ok(resultOf(obj), audit_ref);
      const handle = handleOf(obj, audit_ref);
      if (handle !== '') return running(handle, audit_ref);
      return errored('internal', UNRECOGNISED_MESSAGE, audit_ref);
    }
  }
}

/**
 * Classify a raw `invocation.get` response into one of the five
 * {@link InvocationDisposition} statuses. A thin, consistency-guaranteed view over
 * {@link invocationToResult} (so the disposition can never disagree with the
 * built envelope). Pure; never throws. Useful to bindings + tests.
 */
export function classifyInvocation(raw: unknown): InvocationDisposition {
  return invocationToResult(raw).status;
}
