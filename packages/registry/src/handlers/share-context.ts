/**
 * `mx_share_context` — publish a shared-context artifact (T107 / #15) — design §2
 * (the context-exchange verbs) / §7 ("Context, task state, sessions, audit").
 *
 * The **publish half** of the substrate's cross-agent context channel. Design §7
 * draws the line precisely: *private agent memory* (scratchpad, conversation,
 * retrieved knowledge) stays in the runtime — MX-Agent never touches it; *shared,
 * cross-agent context* (a diff, a file, an env snapshot one agent produces and
 * another needs to read) moves through this verb as `com.mxagent.context.share.v1`.
 * **Rule: if another agent needs to see it, it's an MX share; if only this agent's
 * reasoning needs it, it's runtime memory.**
 *
 * "Publish an artifact to the workspace room and turn the daemon's reply into the
 * normalized T102 envelope." A `sync` mutating handler — **three phases**: room
 * provenance → resolve the `share.*` RPC from `kind` → dispatch with `content`
 * forwarded verbatim → normalize into `ok({ context_id, sha256 }, audit_ref)`. It
 * is `sync`: it resolves directly to a terminal `ok` / `denied` / `error` envelope
 * and does **not** return `running` / `awaiting_approval` or compose
 * `mx_await_result`.
 *
 * **The inline-vs-media split + sha256 is substrate behavior the handler SURFACES,
 * never reimplements (AC 2).** The ≤256 KiB inline threshold, the Matrix-media
 * upload, the content-addressing, and the authoritative sha256 over the *stored*
 * bytes all live on the receiving daemon (which holds the Matrix credentials
 * mx-loom never has — Boundary A). The handler forwards `content` and surfaces the
 * `context_id` + `sha256` the daemon returns; it performs **no** client-side
 * threshold check, **no** media chunking, and **no** sha256 computation. Re-deriving
 * any of it would duplicate substrate behavior and falsely imply the toolbelt is the
 * storage boundary (it is not).
 *
 * **Secret boundary — the single most dangerous exfiltration surface, doubly
 * bounded.** A model that wanted to leak a credential would reach for "share this".
 * No field carries a credential inbound or outbound: the concrete `deps.daemon.call`
 * (an `MxClient` in production) runs `assertNoCredentialShapedArgs` over keys **and**
 * values *before dispatch* — so a `content`/`path` carrying a token-shaped value
 * (`ghp_…`, `sk-ant-…`, a PEM header, a `Bearer …` secret, `GH_TOKEN`) is **rejected
 * as `invalid_args` rather than published** (you cannot exfiltrate a credential-shaped
 * secret by sharing it). `kind:'env'` is the highest-risk artifact but is doubly
 * bounded: the daemon's secrets (`MATRIX_*` / `MX_AGENT_*` / provider keys /
 * `GH_TOKEN`) never cross Boundary A, so a model-assembled env snapshot cannot
 * contain them by construction, and the value guard rejects any credential the model
 * assembled from elsewhere. The handler adds no env access of its own and
 * re-implements neither guard (single source = the toolbelt), keeping its zero
 * **runtime** toolbelt dependency (the seam is injected, imported `type`-only).
 *
 * **Authority stays out-of-process.** The handler emits a *signed request* only; it
 * performs no trust/policy/sandbox check. `policy_denied` / `untrusted_key` are
 * outcomes it *maps*, never decisions it makes (design §1, §6). It is not a
 * forbidden authority verb.
 *
 * Wire-shape assumptions (the `share.file/diff/env` param names, the success field
 * names `context_id`/`sha256`, whether share publishes a Matrix event with a
 * populated `audit_ref`, and whether the daemon content-addresses a re-share) are
 * **pending the two-daemon round-trip** (`MXL_CONFORMANCE_TWO_DAEMON=1`) — `share.*`
 * is "◻️ documented", the least-verified surface in the design-§2 table. Authored
 * against the design's named shapes now, with the method names localised below so
 * the fixture corrects them in one place, reusing the T102 readers + `internal`-safe
 * fallbacks so a new daemon code degrades to `internal` (never the wrong code),
 * never throws.
 */
import { errored, type ToolResult } from '../envelope.js';
import { readString } from './agent-projection.js';
import { contextResponseToResult } from './context-response.js';
import type { RoomScopedDeps } from './deps.js';
import { EMPTY_AUDIT_REF, faultToResult } from './handler-fault.js';
import { failureResult } from './invocation.js';

/**
 * The daemon RPC per `kind`. Localised so the two-daemon round-trip (or a pin bump)
 * corrects the wire in one place — the `delegate-tool.ts` / `run-command.ts`
 * precedent. The `share.*` param names (`room`/`path`/`content`/`encoding`) are
 * likewise pinned at the round-trip.
 */
const SHARE_METHOD_FOR_KIND = {
  file: 'share.file',
  diff: 'share.diff',
  env: 'share.env',
} as const;

/**
 * Input of `mx_share_context` — exactly the descriptor's input schema (`kind`
 * required; `path` / `content` / `encoding` optional). `content` is forwarded
 * verbatim; the daemon decides inline (≤256 KiB) vs the Matrix-media path.
 */
export interface ShareContextInput {
  /** The artifact kind — selects the `share.file` / `share.diff` / `share.env` RPC. */
  readonly kind: 'file' | 'diff' | 'env';
  /** Logical path/name of the artifact. */
  readonly path?: string;
  /** Inline artifact content (≤256 KiB; the daemon transparently uses the media path for larger). */
  readonly content?: string;
  /** Encoding of `content`. */
  readonly encoding?: 'utf-8' | 'base64';
}

/**
 * Publish a shared-context artifact and return its normalized {@link ToolResult}.
 * Never throws — every transport/daemon fault maps onto the closed T102 taxonomy
 * (`faultToResult`) or a builder. Performs **no** threshold / media / sha256
 * computation: the substrate stores, content-addresses, and digests (AC 2).
 */
export async function mxShareContext(input: ShareContextInput, deps: RoomScopedDeps): Promise<ToolResult> {
  // Phase 1 — room provenance. A share publishes *into the workspace room*; the
  // model never names a Matrix room (design §1/§7) — the binding injects it from the
  // `MxSession`. Fail fast rather than dispatch a room-less share (no Matrix
  // round-trip happened → EMPTY_AUDIT_REF). Mirrors `mxDelegateTool` Phase 0.
  if (deps.room === undefined || deps.room === '') {
    return errored('internal', 'no workspace room configured for share', EMPTY_AUDIT_REF);
  }

  // Phase 2 — resolve the RPC from `kind`. The descriptor's enum already constrains
  // `kind` and the binding validates input before the handler runs; this is the
  // defensive floor (an out-of-enum `kind` is impossible per the types but degrades
  // to `invalid_args` before any dispatch rather than indexing to `undefined`).
  const method: string | undefined = SHARE_METHOD_FOR_KIND[input.kind];
  if (method === undefined) {
    return failureResult('invalid_args', EMPTY_AUDIT_REF);
  }

  // Phase 3 — dispatch with `content` forwarded VERBATIM. `room` comes from the
  // session, never model input; `path` / `content` / `encoding` are omitted when
  // absent so no `undefined` leaks into the params object. No client-side threshold
  // / media / sha256 logic — the daemon owns all of it. The concrete `MxClient`'s
  // `assertNoCredentialShapedArgs` rejects a credential-shaped `content`/`path`
  // value as `invalid_args` at this dispatch (see the secret-boundary note above).
  const params = {
    room: deps.room,
    ...(input.path !== undefined ? { path: input.path } : {}),
    ...(input.content !== undefined ? { content: input.content } : {}),
    ...(input.encoding !== undefined ? { encoding: input.encoding } : {}),
  };
  let response: unknown;
  try {
    response = await deps.daemon.call(method, params);
  } catch (err) {
    // A daemon JSON-RPC error (policy_denied / untrusted_key / credential-shaped
    // content → invalid_args) or a transport fault → the mapped envelope. No
    // round-trip recorded → EMPTY_AUDIT_REF.
    return faultToResult(err, EMPTY_AUDIT_REF);
  }

  // Phase 4 — normalize the flat reply → `ok({ context_id, sha256 }, audit_ref)`.
  // A publish IS a Matrix round-trip, so `audit_ref` is populated from the response
  // (null inner ids when the daemon omits them, never fabricated). An explicit
  // daemon error signal maps to the terminal denial/fault; an unrecognised reply
  // degrades to `internal` (see `contextResponseToResult`).
  return contextResponseToResult(response, projectShare);
}

/**
 * Project a `share.*` success payload onto the descriptor's closed `output_schema`
 * fields (`context_id` required, `sha256` required; `additionalProperties: false`),
 * passing each value through verbatim. `context_id` is guaranteed present by the
 * classifier's success marker; `sha256` (the integrity anchor) is included when the
 * daemon returns it — never fabricated.
 */
function projectShare(payload: Record<string, unknown>): Record<string, unknown> {
  const context_id = readString(payload.context_id);
  const sha256 = readString(payload.sha256);
  return {
    ...(context_id !== undefined ? { context_id } : {}),
    ...(sha256 !== undefined ? { sha256 } : {}),
  };
}
