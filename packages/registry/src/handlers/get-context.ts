/**
 * `mx_get_context` — fetch a shared-context artifact by id (T107 / #15) — design §2
 * (the context-exchange verbs) / §7 ("Context, task state, sessions, audit").
 *
 * The **fetch half** of the substrate's cross-agent context channel and the sibling
 * of `mx_share_context`: one agent publishes a diff/file/env via `mx_share_context`,
 * another retrieves it here by `context_id`. A `sync` read mapping to the daemon RPC
 * `share.get` — **two phases**: room provenance → dispatch `share.get` → normalize
 * the flat reply into `ok({ context_id, kind?, sha256?, size_bytes?, inline?,
 * media_mxc? }, audit_ref)`. It is `sync`: a terminal `ok` / `denied` / `error`
 * envelope, never `running` / `awaiting_approval`.
 *
 * **Where sha256 verification lives (AC 2) — the architectural decision.** AC 2 says
 * "media path **with sha256 verification**." The non-obvious, security-critical fact:
 * **mx-loom cannot verify the media path itself** — downloading `mxc://` media
 * requires Matrix credentials, which never cross Boundary A. So:
 *  - **Media path (>256 KiB → `media_mxc`):** the **daemon** fetches the media (it
 *    holds the Matrix session), computes sha256 over the bytes, and verifies. The
 *    handler **surfaces** `media_mxc` + `sha256` and downloads nothing — the only
 *    boundary-respecting design.
 *  - **Inline path (≤256 KiB → `inline`):** the handler surfaces the daemon's
 *    `sha256` as the authoritative integrity anchor and **does not recompute** by
 *    default. A client-side recompute over `inline` would mismatch the daemon's
 *    pre-redaction digest whenever inbound `redactSecrets` rewrote a token-shaped
 *    byte (the byte-identity ↔ redaction interaction, spec Risk #4), falsely
 *    reporting an integrity failure. The share-time value guard (which rejects
 *    credential-shaped content *before* it is stored) keeps the secret-free
 *    invariant without redaction needing to fire on fetch, so the AC-1 byte-identity
 *    guarantee holds for the realistic case (secret-free diffs/files).
 *
 * The `inline` vs `media_mxc` discriminator tells the consumer which storage path
 * the artifact took (AC 2: a >256 KiB artifact returns `media_mxc`, not `inline`);
 * `sha256` is the integrity anchor. Both pass through verbatim.
 *
 * **Secret boundary.** Inbound `redactSecrets` on the concrete `MxClient.call` exit
 * scrubs any token-shaped value in returned `inline` content before it reaches the
 * model — runners receive retrieved TEXT only, never credentials. `error.message`
 * is the fixed, secret-free phrase per code; the handler never echoes `context_id`,
 * `inline`, or a daemon payload into it. The registry re-implements neither guard
 * and keeps its zero **runtime** toolbelt dependency (the seam is injected,
 * imported `type`-only).
 *
 * **Authority stays out-of-process.** The handler emits a *signed read* only; the
 * receiving daemon's policy decides whether a fetch is permitted. `policy_denied` /
 * `untrusted_key` are outcomes it *maps*; an unknown `context_id` maps to
 * `not_found`. It is not a forbidden authority verb.
 *
 * Wire-shape assumptions (the `share.get` param names, the success field names
 * `context_id`/`kind`/`sha256`/`size_bytes`/`inline`/`media_mxc`, whether `share.get`
 * needs `room`, and whether it is a local read or a media-fetching round-trip — spec
 * Risk #5) are **pending the two-daemon round-trip** (`MXL_CONFORMANCE_TWO_DAEMON=1`)
 * — `share.*` is "◻️ documented". Authored against the design's named shapes now,
 * with the method name localised below, reusing the T102 readers + `internal`/
 * `not_found`-safe fallbacks so a new daemon code degrades to `internal`/`not_found`
 * (never the wrong code), never throws.
 */
import { errored, type ToolResult } from '../envelope.js';
import { readString } from './agent-projection.js';
import { contextResponseToResult } from './context-response.js';
import type { RoomScopedDeps } from './deps.js';
import { EMPTY_AUDIT_REF, faultToResult } from './handler-fault.js';

/**
 * The daemon fetch RPC. Localised so the two-daemon round-trip (or a pin bump)
 * corrects the wire in one place. The `share.get` param names (`context_id`/`room`)
 * are pinned at the round-trip.
 */
const SHARE_GET_METHOD = 'share.get';

/** Input of `mx_get_context` — exactly the descriptor's input schema. */
export interface GetContextInput {
  /** The artifact id returned by `mx_share_context`. */
  readonly context_id: string;
}

/**
 * Fetch a shared-context artifact by `context_id` and return its normalized
 * {@link ToolResult}. Never throws — every transport/daemon fault maps onto the
 * closed T102 taxonomy (`faultToResult`) or a builder; an unknown `context_id` maps
 * to `not_found`. **Downloads no Matrix media** — it surfaces the daemon's
 * `media_mxc` reference + `sha256` (AC 2).
 */
export async function mxGetContext(input: GetContextInput, deps: RoomScopedDeps): Promise<ToolResult> {
  // Phase 1 — room provenance. Artifacts are room-scoped (design §7); require the
  // session `room` for consistency with `mx_share_context` (the model never names a
  // room — the binding injects it). Whether `share.get` strictly needs `room`, or
  // resolves a globally-unique `context_id`, is pending the round-trip (spec Risk
  // #5); requiring it is the conservative default. No round-trip → EMPTY_AUDIT_REF.
  if (deps.room === undefined || deps.room === '') {
    return errored('internal', 'no workspace room configured for get', EMPTY_AUDIT_REF);
  }

  // Phase 2 — dispatch `share.get`. `room` from the session; `context_id` from input.
  const params = { context_id: input.context_id, room: deps.room };
  let response: unknown;
  try {
    response = await deps.daemon.call(SHARE_GET_METHOD, params);
  } catch (err) {
    // An unknown-context daemon code maps to `not_found` (via the errors.ts aliases);
    // a transport fault maps via `mapTransportError`. No round-trip → EMPTY_AUDIT_REF.
    return faultToResult(err, EMPTY_AUDIT_REF);
  }

  // Phase 3 — normalize the flat reply, passing the documented get fields through
  // verbatim (the descriptor output is `additionalProperties: true`). `audit_ref` is
  // extracted if the daemon surfaces ids (a media-fetching round-trip), else all-null
  // (a local read) — never fabricated (spec Risk #5).
  return contextResponseToResult(response, projectGet);
}

/**
 * Project a `share.get` success payload onto the descriptor's documented fields
 * (`context_id` required; `kind` / `sha256` / `size_bytes` / `inline` / `media_mxc`
 * optional), passing each value through verbatim. The `inline` vs `media_mxc`
 * discriminator is the storage-path indicator (AC 2); `sha256` is the integrity
 * anchor surfaced from the substrate. `context_id` is guaranteed present by the
 * classifier's success marker; the rest are included only when the daemon returns
 * them — never fabricated.
 */
function projectGet(payload: Record<string, unknown>): Record<string, unknown> {
  const context_id = readString(payload.context_id);
  const kind = readString(payload.kind);
  const sha256 = readString(payload.sha256);
  const size_bytes = readNonNegativeInt(payload.size_bytes);
  const inline = readString(payload.inline);
  const media_mxc = readString(payload.media_mxc);
  return {
    ...(context_id !== undefined ? { context_id } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(sha256 !== undefined ? { sha256 } : {}),
    ...(size_bytes !== undefined ? { size_bytes } : {}),
    ...(inline !== undefined ? { inline } : {}),
    ...(media_mxc !== undefined ? { media_mxc } : {}),
  };
}

/** A finite, non-negative integer (matching the descriptor's `size_bytes` schema:
 *  `integer, minimum: 0`); any other value reads as "absent". */
function readNonNegativeInt(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0 ? x : undefined;
}
