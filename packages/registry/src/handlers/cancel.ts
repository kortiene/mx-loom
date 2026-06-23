/**
 * `mx_cancel` — cancel an in-flight invocation (T108 / #16) — design §2 (the
 * observe/coordinate surface) / §5 (the invocation flow). The verb that lets a
 * model stop a long-running delegation or guarded command it has changed its mind
 * about, or recognised as wrong/runaway, instead of waiting for it to finish or
 * time out.
 *
 * "Cancel the invocation behind a deferred `handle` and turn the daemon's reply
 * into the normalized T102 envelope." A `sync` mutating handler — **one phase plus
 * normalization**: dispatch `invocation.cancel` → normalize the narrow reply into a
 * terminal `ok({ handle, cancelled, state? }, audit_ref)`. It is `sync`: it resolves
 * directly to a terminal `ok` / `denied` / `error` and does **not** return
 * `running` / `awaiting_approval` or compose `mx_await_result` (cancellation is not
 * approval-gated in M1).
 *
 * **Plain {@link HandlerDeps} (daemon-only), mirroring `mx_await_result`** — which
 * also operates on a handle via the `invocation.*` family and needs no room. The
 * signed cancel event's room is derived daemon-side from the invocation record. No
 * `idempotency_key`: cancelling is monotonic toward a terminal `cancelled` state, so
 * a re-issued cancel is a safe no-op (T107's content-addressing reasoning).
 *
 * **The handler performs NO authority check.** It emits a *signed cancel request*
 * and faithfully surfaces the receiver's verdict: a cross-agent cancel the receiver
 * refuses maps to `policy_denied` / `untrusted_key`; an unknown handle to
 * `not_found`; a transport fault per `mapTransportError`. Cognition can only produce
 * a signed cancel; it can never grant itself the authority to cancel (design §1, §6).
 * `mx_cancel` cancels a single *invocation* handle — not a task or a multi-step plan.
 *
 * **Secret boundary.** The only input is a correlation `handle` (an `inv_…` id, not
 * a secret); no field carries a credential inbound or outbound. `error.message` is
 * the fixed, secret-free phrase per code — the handler echoes no `handle` and no raw
 * daemon payload into it. The concrete `MxClient` still runs
 * `assertNoCredentialShapedArgs` / `redactSecrets` at the boundary (T008); the
 * registry re-implements neither and keeps its zero **runtime** toolbelt dependency
 * (the seam is injected, imported `type`-only).
 *
 * Wire-shape assumptions (the `invocation.cancel` method/param name and the reply
 * disposition) are **pending the two-daemon round-trip** (`MXL_CONFORMANCE_TWO_DAEMON=1`)
 * — `invocation.cancel` is "◻️ documented", and a cancel needs an in-flight
 * invocation (≥2 agents) to exercise. Authored against the design's named shapes
 * now, with the method/param consts localised below so the fixture corrects them in
 * one place, reusing the T102 readers + `internal`-safe fallbacks so a new daemon
 * code degrades to `internal` (never the wrong code), never throws.
 */
import { ok, errored, type AuditRef, type ToolResult } from '../envelope.js';
import { asRecord, readString } from './agent-projection.js';
import type { HandlerDeps } from './deps.js';
import { EMPTY_AUDIT_REF, faultToResult } from './handler-fault.js';
import { extractAuditRef, failureCode, failureResult, hasErrorSignal } from './invocation.js';

/**
 * The daemon RPC + its param name. Localised so the two-daemon round-trip (or a pin
 * bump) corrects the wire in one place — the `await-result.ts` precedent (`handle`
 * vs `invocation_id` vs `id` is pinned there too).
 */
const INVOCATION_CANCEL_METHOD = 'invocation.cancel';
const INVOCATION_ID_PARAM = 'invocation_id';

/** Fixed, **secret-free** phrase for a cancel reply that is neither a recognised
 *  acknowledgement nor an explicit daemon error. */
const UNRECOGNISED_CANCEL_MESSAGE = 'unrecognised cancel response';

/**
 * Normalised reply states meaning "there was nothing to cancel" — the invocation
 * had already reached a terminal completion, so a cancel is a successful no-op with
 * `cancelled: false`. Anything else (with no explicit `cancelled` flag and no error
 * signal) is read as "the cancel was accepted" → `cancelled: true`.
 */
const NOTHING_TO_CANCEL: ReadonlySet<string> = new Set([
  'already_complete',
  'already_completed',
  'already_done',
  'already_finished',
  'complete',
  'completed',
  'succeeded',
  'success',
  'done',
  'finished',
  'resolved',
  'noop',
  'no_op',
  'nothing_to_cancel',
]);

/** Input of `mx_cancel` — exactly the descriptor's schema (`handle` required). */
export interface CancelInput {
  /** The deferred handle (an `inv_…` invocation id) a prior delegate/run/await returned. */
  readonly handle: string;
}

/** The `mx_cancel` success payload — whether a cancellation took effect + the
 *  post-cancel state when the daemon reports one. */
export interface CancelResult {
  readonly handle: string;
  readonly cancelled: boolean;
  readonly state?: string;
}

/**
 * Cancel the invocation behind `handle` and return its normalized {@link ToolResult}.
 * Never throws — every transport/daemon fault maps onto the closed T102 taxonomy
 * (`faultToResult`) or a builder. Performs **no** authority check: it emits a signed
 * cancel and surfaces the receiver's verdict.
 */
export async function mxCancel(input: CancelInput, deps: HandlerDeps): Promise<ToolResult> {
  // Dispatch the signed cancel. The handle IS the invocation id; the daemon derives
  // the room from the invocation record, so no room param (unlike the mutating
  // delegate/exec verbs) — mirrors `mx_await_result`'s handle-only `invocation.*` call.
  let response: unknown;
  try {
    response = await deps.daemon.call(INVOCATION_CANCEL_METHOD, { [INVOCATION_ID_PARAM]: input.handle });
  } catch (err) {
    // An unknown handle maps to `not_found`; a refused cross-agent cancel to
    // `policy_denied` / `untrusted_key`; a transport fault per `mapTransportError`.
    // No round-trip completed → EMPTY_AUDIT_REF.
    return faultToResult(err, EMPTY_AUDIT_REF);
  }

  return cancelResponseToResult(response, input.handle);
}

/**
 * Map a raw `invocation.cancel` reply onto a T102 {@link ToolResult}. The reply is
 * **narrow** (`{ cancelled?, state? }`), not a wrapped `CallResponse`, so this is a
 * small dedicated classifier (à la `context-response.ts`) rather than
 * `callResponseToResult` (whose tokenless default would misread a bare reply as a
 * deferred `running` handle). Reuses the shared response readers so correlation-id
 * extraction and error-code mapping match every other handler by construction.
 *
 * Pure; never throws; builds the envelope only through the T102 helpers.
 */
function cancelResponseToResult(raw: unknown, handle: string): ToolResult {
  const obj = asRecord(raw);
  // Cancellation emits a signed Matrix event (it is a mutation), so `audit_ref` is
  // populated from the response (null inner ids when the daemon omits them, never
  // fabricated). The handle is surfaced on the success payload for correlation.
  const audit_ref: AuditRef = extractAuditRef(obj);

  // Not an object (null / scalar / array) → cannot classify → safe terminal, never
  // a misleading `ok`.
  if (obj === undefined) {
    return errored('internal', UNRECOGNISED_CANCEL_MESSAGE, audit_ref);
  }

  // An explicit daemon error signal (`{ok:false}` / `{error}`, or a denial/fault
  // state label) is a terminal failure, mapped through the shared classifier so the
  // partition matches every other handler (unknown handle → `not_found`; refused
  // cross-agent cancel → `policy_denied` / `untrusted_key`).
  if (hasErrorSignal(obj)) {
    return failureResult(failureCode(obj, stateTokenOf(obj)), audit_ref);
  }

  // Success: the cancel was acknowledged. `cancelled: true` when the invocation was
  // running and is now cancelling/cancelled; `cancelled: false` when there was
  // nothing to cancel (an already-terminal invocation) — still a non-error outcome.
  const state = readString(obj.state) ?? readString(obj.status);
  const result: CancelResult = {
    handle,
    cancelled: readCancelled(obj, state),
    ...(state !== undefined ? { state } : {}),
  };
  return ok(result, audit_ref);
}

/** Whether the cancel took effect: the explicit daemon flag if present, else
 *  inferred from the reply state (an already-terminal invocation ⇒ `false`). */
function readCancelled(obj: Record<string, unknown>, state: string | undefined): boolean {
  if (typeof obj.cancelled === 'boolean') return obj.cancelled;
  if (state !== undefined && NOTHING_TO_CANCEL.has(normaliseToken(state))) return false;
  return true;
}

/** The reply's state token, normalised for the shared `failureCode` classifier
 *  (lowercased, non-alphanumerics collapsed to `_`, edges trimmed). */
function stateTokenOf(obj: Record<string, unknown>): string | undefined {
  const raw = readString(obj.state) ?? readString(obj.status);
  return raw !== undefined ? normaliseToken(raw) : undefined;
}

/** Normalise a daemon spelling to a lookup key (mirrors `invocation.ts` / `errors.ts`). */
function normaliseToken(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
