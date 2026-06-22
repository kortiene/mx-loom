/**
 * The flat-payload response classifier shared by the two context-sharing handlers
 * (T107 / #15) — `mx_share_context` and `mx_get_context` — design §4.2 (the
 * envelope) / §7 ("Context, task state, sessions, audit").
 *
 * The `share.*` success payload is **flat** — `{ context_id, sha256, … }` /
 * `{ context_id, kind, inline | media_mxc, … }` — *not* wrapped under a `result`
 * key and carrying no invocation **state token**. So neither `invocationToResult`
 * (which keys on a state token) nor `callResponseToResult` (whose tokenless
 * default treats a bare `invocation_id` as a deferred `running` handle, which a
 * share response is not) classifies it correctly. This is the small, dedicated
 * normalizer the spec calls for — reusing the **same** response readers
 * (`extractAuditRef` / `hasErrorSignal` / `failureCode`) and the same
 * `failureResult` builder as `invocation.ts`, so a share/get result and any other
 * handler's result agree on correlation-id extraction and error-code mapping by
 * construction.
 *
 * Pure; **never throws**; builds the envelope only through the T102 helpers, so the
 * output conforms to `ENVELOPE_SCHEMA` by construction. An unrecognised response
 * (not an object, or a non-error response with no `context_id`) degrades to a safe
 * `errored('internal', …)` — never the wrong code, never a misleading `ok`.
 */
import { ok, errored, type ToolResult } from '../envelope.js';
import { asRecord, readString } from './agent-projection.js';
import { extractAuditRef, failureCode, failureResult, hasErrorSignal } from './invocation.js';

/** Fixed, **secret-free** phrase for a response that is neither a recognised
 *  success (a `context_id`-bearing payload) nor an explicit daemon error. */
const UNRECOGNISED_CONTEXT_MESSAGE = 'unrecognised context response';

/**
 * Map a raw `share.*` response onto a T102 {@link ToolResult}, classifying it as:
 *  - an explicit daemon **error** (`{ok:false}` / `{error}`) → the mapped
 *    `denied`/`errored` terminal (`failureCode` → `failureResult`);
 *  - a **success** — a payload bearing a string `context_id` (the defining marker
 *    of both a publish reply and a fetch reply) → `ok(project(payload), audit_ref)`,
 *    with `project` selecting the descriptor's success fields;
 *  - otherwise (not an object, or no error signal and no `context_id`) → a safe
 *    `errored('internal', …)`, mirroring how `callResponseToResult` degrades an
 *    empty/unrecognised response (consistent with `mx_run_command`).
 *
 * `audit_ref` is read from the response (a share *publish* is a Matrix round-trip →
 * populated ids; a *fetch* may be a local read → all-null), never fabricated.
 */
export function contextResponseToResult(
  raw: unknown,
  project: (payload: Record<string, unknown>) => Record<string, unknown>,
): ToolResult {
  const obj = asRecord(raw);
  const audit_ref = extractAuditRef(obj);

  // Not an object (null / scalar / array) → cannot classify.
  if (obj === undefined) {
    return errored('internal', UNRECOGNISED_CONTEXT_MESSAGE, audit_ref);
  }

  // An explicit daemon error signal is a terminal failure (mapped via the shared
  // classifier so the code partition matches every other handler).
  if (hasErrorSignal(obj)) {
    return failureResult(failureCode(obj, undefined), audit_ref);
  }

  // The success marker for both verbs is a string `context_id`. Absent it (and
  // with no error signal) the response is unrecognised → safe `internal` rather
  // than a misleading `ok({})` that fabricates a successful share/fetch.
  if (readString(obj.context_id) === undefined) {
    return errored('internal', UNRECOGNISED_CONTEXT_MESSAGE, audit_ref);
  }

  return ok(project(obj), audit_ref);
}
