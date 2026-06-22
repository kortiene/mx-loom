# T107 · `mx_share_context` + `mx_get_context` — cross-agent context exchange

> Issue #15 · `area/registry` `priority/P1` `type/feature` · Estimate **M** · Milestone **M1 — Delegation MVP** · Source `docs/backlog.md` (`T107`).
> Blocked-by **#10 (T102 — result envelope + error taxonomy + idempotency)**. Siblings: **#13 (T105 — `mx_delegate_tool`)**, **#14 (T106 — `mx_run_command`)**. Out of scope: runtime-private memory (never touched).

## Problem Statement

After T101–T106, mx-loom can discover the coordination mesh (`mx_find_agents` / `mx_describe_agent`), invoke a *named tool* (`mx_delegate_tool`) or an *allowlisted command* (`mx_run_command`) on a remote agent, and resolve deferred handles (`mx_await_result`). What it still cannot do is move **shared, cross-agent context** — a diff, a file, or an env snapshot one agent produces and another needs to read — through the fabric.

`mx_share_context` and `mx_get_context` are that pair. Design §7 ("Context, task state, sessions, audit") draws the line precisely:

> *Private agent memory* (scratchpad, conversation, retrieved knowledge) stays in the runtime — MX-Agent doesn't touch it. *Shared/cross-agent context* (diffs, files, env snapshots) moves through `mx_share_context` / `mx_get_context` as `com.mxagent.context.share.v1` (inline ≤256 KiB, else Matrix media + sha256). **Rule: if another agent needs to see it, it's an MX share; if only this agent's reasoning needs it, it's runtime memory.**

So the two verbs are the **publish/fetch seam for the substrate's shared-context channel**. `mx_share_context` publishes an artifact to the workspace room (mapping to the daemon RPCs `share.file` / `share.diff` / `share.env`); `mx_get_context` fetches one back by `context_id` (mapping to `share.get`, with the design §2 table also naming `share.list`). The substrate is content-addressed by sha256 and chooses an **inline path (≤256 KiB)** versus a **Matrix-media path (larger)** transparently; `mx_get_context` surfaces which path was used and the digest that anchors integrity.

The gap is concrete: the descriptors `MX_SHARE_CONTEXT` and `MX_GET_CONTEXT` already exist (T101, `src/descriptors/share-context.ts` / `get-context.ts`) — both `sync`, both already in `CANONICAL_M1_TOOLS`, both already in `MODEL_FACING_ALLOWLIST` — and the entire contract + handler machinery they need (envelope helpers, error mappers, the shared `faultToResult` path, the `RoomScopedDeps` seam, the response readers, `node:crypto` for sha256) exists from T102–T106. But **no handler function wires `share.*` to them.** T107 adds exactly those two handlers.

The two acceptance criteria pin the behavior:
- **AC 1 — share a diff, list it, fetch it back byte-identical.** The round-trip must be lossless: what one agent shares, another retrieves bit-for-bit.
- **AC 2 — >256 KiB artifact uses the media path with sha256 verification.** Large artifacts must transparently take the Matrix-media path, and the digest must verify.

Both ACs are fundamentally **substrate/round-trip** properties (like T105's `call.start` and T106's `exec.start`). T107 ships the transport-neutral **handlers** plus unit tests over a fake `DaemonCall`; the live byte-identity and media-path behaviors are pinned later by a staged two-daemon `share.*` conformance fixture (currently "◻️ documented" — the *least*-verified surface in the design-§2 table).

## Goals

- Add `mxShareContext(input, deps)` and `mxGetContext(input, deps)` handlers in `@mx-loom/registry`, each returning a normalized `ToolResult` built **only** through the T102 constructor helpers and **never throwing** (every transport/daemon fault maps onto the closed taxonomy via the shared `faultToResult`).
- **`mx_share_context` — publish an artifact (AC 1, share half).** Map `kind` ∈ `{file, diff, env}` to the daemon RPC `share.file` / `share.diff` / `share.env`, forward `path` / `content` / `encoding` verbatim, and normalize the response into `ok({ context_id, sha256 }, audit_ref)`. The publish is a Matrix round-trip, so `audit_ref` is populated (like T105/T106), null-not-fabricated.
- **`mx_get_context` — fetch an artifact by id (AC 1, fetch half).** Map `context_id` to `share.get`, normalize into `ok({ context_id, kind?, sha256?, size_bytes?, inline?, media_mxc? }, audit_ref)`, passing the daemon's payload through verbatim (the success `output_schema` is `additionalProperties: true`). An unknown `context_id` maps to `not_found`.
- **Surface — never reimplement — the inline-vs-media split + sha256 (AC 2).** The ≤256 KiB threshold, the media upload/download, and the authoritative sha256 over the *stored* bytes are **substrate behavior**: the daemon decides the path, computes the digest, and (holding the Matrix credentials mx-loom never has) verifies media on fetch. mx-loom **forwards content and surfaces the result** — it does not reimplement the threshold and does not (cannot) download Matrix media across Boundary A. The `sha256` and the `inline` vs `media_mxc` discriminator the daemon returns are passed through as the integrity anchor and the path indicator.
- Keep the registry's invariants intact: **zero runtime dependency** on `@mx-loom/toolbelt` (the daemon transport is injected, imported `type`-only), secret-free in and out, and no authority surface (the handlers emit a signed request / read; trust/policy/sandbox all execute out-of-process on the receiving daemon).
- Keep the two verbs `sync` (the authored descriptor flag): they resolve directly to a terminal `ok` / `denied` / `error` envelope and **do not** return `running` / `awaiting_approval` or compose `mx_await_result`.

## Non-Goals

- **Runtime-private memory.** Explicitly out of scope per the issue and design §7 ("Don't unify memory across runtimes", §9). Agent scratchpad / conversation / retrieved knowledge stays in the runtime; MX-Agent never touches it. T107 is *only* the shared-context channel.
- **Reimplementing the substrate's storage policy.** The ≤256 KiB inline-vs-media threshold, the Matrix media upload/download, the content-addressing, and the authoritative sha256 over stored bytes all live on the daemon/substrate. mx-loom must **not** reimplement the threshold, must **not** chunk/upload media itself, and (lacking Matrix credentials — Boundary A) **cannot** download `mxc://` media. Re-deriving any of this in the toolbelt would duplicate substrate behavior and create a false impression that the toolbelt is the storage boundary (it is not).
- **Approval-gated sharing / deferred shares.** The descriptors are `sync`. T107 does not add an `awaiting_approval` path or a `wait_ms` poll to share/get. (If a future policy requires approval to share sensitive context, that is a descriptor/flag change beyond M1.)
- **A model-facing *list* verb.** The authored `mx_get_context` descriptor requires `context_id` (fetch-by-id). The design §2 table also maps `mx_get_context → share.list`, but the current descriptor does not express a list mode. Whether to add one (an optional `context_id` ⇒ `share.list`, a descriptor change) or defer it is an **open question** (see Risks #2); T107's recommended default is fetch-by-id, with the "list it" step of AC 1 exercised against `share.list` in the staged conformance fixture.
- **The bindings** — the MCP server (T109) and the Claude in-process shim (T110) that surface these handlers to a runtime. T107 ships the transport-neutral handlers only.
- **The golden end-to-end test (T114)** and the **two-daemon live `share.*` round-trip**. T107 lands with unit tests over a fake `DaemonCall`; the live round-trip + a staged share conformance fixture pin the wire assumptions and the byte-identity/media-path ACs later.
- **Postgres audit mirror (T113).** T107 populates `audit_ref` on the result; persisting a row is a separate issue.
- **Task DAG tools, cancel, workspace status** (T108 / M3).

## Relevant Repository Context

The stack is TypeScript (pnpm workspace, Node ≥20.19, vitest, Apache-2.0). The repo is **not** docs-only — M0 + most of M1 are implemented. Two packages exist:

- **`packages/toolbelt` = `@mx-loom/toolbelt`** — the Boundary-B daemon client. `MxClient` / `createClient` (T004) is the unified transport (IPC primary, CLI fallback) and **is** an `MxTransport` (`call(method, params, options)` → daemon RPC `result`). `MxClient.call()` already (a) runs `assertNoCredentialShapedArgs(params)` **before dispatch on both transports** — throwing `TransportError('invalid_args')` on a credential-shaped **key or value** (`src/guards.ts`: `CREDENTIAL_KEY_RE` + `CREDENTIAL_VALUE_RE`) — and (b) runs inbound `redactSecrets()` on the result at the single `call()` exit point (T008). `MxClient.withRetry` reuses `params` verbatim on retry. **These two guards are load-bearing for T107 and have non-obvious interactions with shared content — see Security & the redaction tension in Risks #4.**

- **`packages/registry` = `@mx-loom/registry`** — the canonical tool contract + handler layer. Relevant existing surface this issue **reuses**:
  - **Descriptors** `MX_SHARE_CONTEXT` (`src/descriptors/share-context.ts`) and `MX_GET_CONTEXT` (`src/descriptors/get-context.ts`) — already authored in T101 and in `CANONICAL_M1_TOOLS`. Both `async_semantics: 'sync'`.
    - `mx_share_context` input: `kind` (req, enum `file|diff|env`), `path` (opt), `content` (opt; *"Inline artifact content (≤256 KiB; larger uses the media path)"*), `encoding` (opt, enum `utf-8|base64`); `additionalProperties: false`. Output: `context_id` (req), `sha256` (req); `additionalProperties: false`.
    - `mx_get_context` input: `context_id` (req); `additionalProperties: false`. Output: `context_id` (req), `kind` / `sha256` / `size_bytes` / `inline` / `media_mxc` (opt); `additionalProperties: true`.
    - **Neither descriptor declares `idempotency_key`** (T102 added it only to the two `deferred` mutating verbs). Whether `mx_share_context` — a publish — should carry one is an open question (Risks #3).
  - **Envelope** (`src/envelope.ts`) — `ToolResult` + the only sanctioned builders `ok` / `running` / `awaitingApproval` / `denied` / `errored`, each deep-frozen and requiring an `audit_ref`. `denied()` accepts only a `DenialCode`, `errored()` only a `FaultCode` (partition compiler-enforced).
  - **Errors** (`src/errors.ts`) — the closed nine-code `ERROR_CODES`, the `DENIAL_CODES`/`FAULT_CODES` partition, and `mapTransportError` / `mapDaemonError` (the single place a transport/daemon fault becomes an `ErrorCode`; `not_found` is already produced for `unknown_agent`/`unknown_tool`/`no_such_invocation`, which an unknown `context_id` should join — see Risks #6).
  - **Idempotency** (`src/idempotency.ts`) — `newIdempotencyKey()` → `idk_<uuid>`, `node:crypto`-backed (so `node:crypto` is **already a transitive dep of the package** — `createHash('sha256')` for any client-side digest needs no new dependency).
  - **Handler seam** (`src/handlers/deps.ts`) — `HandlerDeps { daemon: DaemonCall; sleep?; now?; pollIntervalMs? }` (`DaemonCall = Pick<MxTransport, 'call'>`, imported `type`-only) and `RoomScopedDeps extends HandlerDeps { room? }` (the shared room-provenance seam both `DelegateDeps` and `ExecDeps` already extend). T107's share/get handlers are room-scoped, so they reuse `RoomScopedDeps` (no validator).
  - **Shared fault path** (`src/handlers/handler-fault.ts`) — `faultToResult(err, audit_ref)` (maps a `deps.daemon.call(...)` rejection: `rpc` → `mapDaemonError(cause)`, else `mapTransportError`) and `EMPTY_AUDIT_REF` (all-null, for a pre-dispatch failure with no round-trip). Reused verbatim by T103/T104/T105/T106 and now T107.
  - **Response normalizer + readers** (`src/handlers/invocation.ts`) — `invocationToResult` / `callResponseToResult` (the verb-agnostic `CallResponse`/`ExecResponse` normalizer), `failureResult(code, audit_ref)` (exported; selects `denied` vs `errored` by the mapped code's set membership), `isTerminal(status)`. **Module-private** (not exported today): `extractAuditRef`, `asRecord`, `hasErrorSignal`, `failureCode`, `stateToken`. T107 needs `extractAuditRef` + a success/error classification for a **flat** success payload (`{context_id, sha256, …}`, *not* wrapped under `result`), so a small refactor to share these readers is recommended (see Proposed Implementation).
  - **Projection helper** (`src/handlers/agent-projection.ts`) — exports `asRecord` (a total `unknown → Record | undefined` reader) used by T104/T105; reusable by the share handlers.
  - **Security invariants** (`src/security.ts`) — `MODEL_FACING_ALLOWLIST` (already includes `mx_share_context` **and** `mx_get_context`), `CREDENTIAL_KEY_RE` (the publish-time oracle, mirrors the toolbelt's), `isForbiddenAuthorityVerb` (neither verb is an authority verb — they publish/read shared context, they do not mutate trust/policy/approval).

- **Verified daemon surface** (`docs/mx-agent-surface-v0.2.1.md`, T001):
  - `share.file/diff/env` · `share.list` · `share.get` are listed as **"◻️ documented"** — *not* flag-confirmed (weaker than `call.start`/`exec.start`, which are "◻️ flags confirmed"). The note: *"exercise in the conformance suite (T007 / #7) with a two-daemon fixture."* So **all** of T107's wire-shape assumptions (the `share.*` param names, the response field names `context_id`/`sha256`/`inline`/`media_mxc`/`size_bytes`, whether share is a Matrix-publishing round-trip with `audit_ref` ids, whether `share.get` is a local read or a media-fetching round-trip) are authored against the design's named shapes and pinned later — exactly as T105 did for `call.start` and T106 for `exec.start`, but with even less prior verification.
  - `workspace.create` returns `{ room_id, encrypted, … }`; `workspace.status` confirms the room model. Shares are room-scoped (design §7), so the handlers need the session `room` (from `MxSession`, T005) — the same provenance rule as delegation/exec.
  - The conformance two-daemon fixture (`packages/toolbelt/test/conformance/_harness.ts`, `TwoDaemonFixture`) exports `room` / `targetAgentId` / `tool` / `deniedTool` / `allowedCommand` / `deniedCommand` — it has **no** share/context coordinates yet (a fixture extension T107 may add; see Testing Plan).

**What does not exist yet (to build in T107):** the `mxShareContext` / `mxGetContext` handlers (`src/handlers/share-context.ts`, `get-context.ts`), any `share.*` *handler* code path (no raw conformance probe exists either, unlike `call.start`'s `delegate.conformance.test.ts`), their input/result types, and the share/get sections of the README + design-doc status lines. The descriptors, the envelope/error/idempotency contract, the `RoomScopedDeps` seam, the `faultToResult` path, the response readers, and `node:crypto` all exist and are reused.

## Proposed Implementation

### Shape: two `sync` handlers — a mutating publish + a read

Both verbs are `sync` (no `running`/`awaiting_approval`, no `wait_ms`, no `mx_await_result` composition). They are simpler than T105/T106 in that respect, but `mx_share_context` is the **third mutating verb** (a Matrix publish) and `mx_get_context` is the **third read verb** (after the two discovery reads).

Add `src/handlers/share-context.ts` and `src/handlers/get-context.ts` (or a single `src/handlers/context.ts` exporting both — they share readers; recommend two files mirroring `find-agents.ts`/`describe-agent.ts`). Each exports its handler + input type:

```ts
export interface ShareContextInput {
  readonly kind: 'file' | 'diff' | 'env'; // selects the share.* RPC
  readonly path?: string;                  // logical path/name of the artifact
  readonly content?: string;               // inline content (daemon decides inline ≤256 KiB vs media)
  readonly encoding?: 'utf-8' | 'base64';  // encoding of `content`
}
export async function mxShareContext(input: ShareContextInput, deps: RoomScopedDeps): Promise<ToolResult>;

export interface GetContextInput {
  readonly context_id: string;
}
export async function mxGetContext(input: GetContextInput, deps: RoomScopedDeps): Promise<ToolResult>;
```

Both are `async`, return `Promise<ToolResult>`, and **never throw** — every error path returns an envelope built through the T102 helpers (the T103–T106 precedent). Both use `RoomScopedDeps` (no `SchemaValidator` — there is no dynamic inner schema), with the same room-provenance rule as T105/T106: the model never names a Matrix room; the binding injects it from the `MxSession`.

### Localized wire constants

Mirror the T103/T105/T106 precedent — keep the assumed RPC method/param names in module `const`s so the staged round-trip corrects them in one place:

```ts
const SHARE_METHOD_FOR_KIND = { file: 'share.file', diff: 'share.diff', env: 'share.env' } as const;
const SHARE_GET_METHOD = 'share.get';
// share.* param names (room / path / content / encoding ; context_id) — pinned at the round-trip.
```

### `mxShareContext` — phases

1. **Room provenance (fail-fast).** A share publishes *into the workspace room*; without it there is no target. `if (deps.room === undefined || deps.room === '') return errored('internal', 'no workspace room configured for share', EMPTY_AUDIT_REF);` (no Matrix round-trip yet → `EMPTY_AUDIT_REF`; mirrors `mxDelegateTool` Phase 0).
2. **Resolve the RPC by `kind`.** `const method = SHARE_METHOD_FOR_KIND[input.kind];`. The descriptor's enum already constrains `kind`, and the binding validates input against the descriptor before the handler runs; defensively, an unrecognized `kind` (should be impossible) → `failureResult('invalid_args', EMPTY_AUDIT_REF)` before dispatch.
3. **Dispatch with content forwarded verbatim.** Build params `{ room: deps.room, ...(path ? {path} : {}), ...(content !== undefined ? {content} : {}), ...(encoding ? {encoding} : {}) }` and `await deps.daemon.call(method, params)`. **No client-side threshold check, no media chunking, no sha256 computation is required here** — the daemon decides inline-vs-media (≤256 KiB), stores, and computes the authoritative digest. The `assertNoCredentialShapedArgs` guard on `MxClient.call` runs over keys **and** values, so credential-shaped `content`/`path` is rejected at dispatch as `invalid_args` (see Security). On rejection: `return faultToResult(err, EMPTY_AUDIT_REF)`.
4. **Normalize the response → `ok({ context_id, sha256 }, audit_ref)`.** A resolved (non-throwing) response is a success unless it carries an explicit daemon error signal. Read `audit_ref` from the response (publish = a Matrix round-trip → populated ids, null-not-fabricated). Project the success payload to the descriptor's `output_schema` fields (`context_id`, `sha256`) — pass them through verbatim. An explicit error signal (`{ok:false}` / `error`) maps via `failureCode` → `failureResult(...)`.

> **Idempotency (open question, Risks #3).** `mx_share_context` is a mutating publish, and design §4.4 says "every mutating call carries a client-supplied `idempotency_key`." But the authored descriptor has no such field. Two defensible positions: **(a, recommended)** rely on content-addressing — re-sharing identical bytes yields the same `context_id`/`sha256` (the substrate dedupes), so a retry is naturally idempotent and no key is needed; **(b)** add an `idempotency_key` to the descriptor + forward it (a T101-surface change). Recommend (a) for M1 — keep the descriptor as-authored — and pin the daemon's content-addressing behavior at the round-trip. If the daemon does *not* content-address (a double-share creates two `context_id`s), revisit toward (b).

### `mxGetContext` — phases

1. **Room provenance.** Recommend the same fail-fast `room` check (artifacts are room-scoped, design §7) — but flag whether `share.get` needs `room` or resolves a globally-unique `context_id` (Risks #5). If `room` is genuinely not required by the daemon, the check can be dropped for `get`; default to requiring it for consistency with share.
2. **Dispatch `share.get`.** `await deps.daemon.call(SHARE_GET_METHOD, { context_id: input.context_id, ...(deps.room ? {room: deps.room} : {}) })`. On rejection: `faultToResult(err, EMPTY_AUDIT_REF)` — an `unknown context_id` daemon code maps to `not_found` (confirm the spelling is in `DAEMON_CODE_TO_ERROR`; add `unknown_context` / `no_such_context` aliases, Risks #6).
3. **Normalize → `ok({ context_id, kind?, sha256?, size_bytes?, inline?, media_mxc? }, audit_ref)`.** Pass the daemon's payload through verbatim (the descriptor output is `additionalProperties: true`). The `inline` vs `media_mxc` discriminator tells the consumer which storage path the artifact took (AC 2: a >256 KiB artifact returns `media_mxc`, not `inline`); `sha256` is the integrity anchor.
4. **sha256 verification (the AC 2 surface).** See the dedicated subsection below — the *recommended* M1 behavior is to **surface** the daemon's digest (and optionally, defensively, recompute over any *inline* bytes), while the authoritative media verification stays on the daemon.

### Where sha256 verification lives (AC 2) — the architectural decision

AC 2 says "media path **with sha256 verification**." The non-obvious, security-critical fact: **mx-loom cannot verify the media path itself.** Downloading `mxc://` media requires Matrix credentials, which never cross Boundary A into the runtime/registry. So:

- **Media path (>256 KiB → `media_mxc`):** the **daemon** fetches the media (it holds the Matrix session), computes sha256 over the bytes, and verifies the digest. mx-loom **surfaces** `media_mxc` + `sha256` and trusts the daemon's verification. It does **not** download media. This is the only boundary-respecting design.
- **Inline path (≤256 KiB → `inline`):** mx-loom *receives* the bytes, so it **may** recompute `sha256(decode(inline, encoding))` and compare to the returned `sha256`, failing closed (`errored('internal', 'context integrity check failed')`) on mismatch — a real, deterministic, secret-free integrity check (`node:crypto` `createHash`, already available). **But** this interacts with inbound `redactSecrets` (Risks #4): the toolbelt redacts token-shaped values in the result *before the handler sees them*, so a recompute over redacted bytes would mismatch the daemon's pre-redaction digest and falsely report an integrity failure. Recommended resolution: **surface the daemon's `sha256` as the integrity anchor and do not recompute inline by default**; treat the digest the daemon returns as authoritative, and let the *conformance test* (which controls the content and can disable redaction-tripping content) assert byte-identity + digest match. Gate any client-side recompute behind a clear decision once the redaction interaction is confirmed.

This keeps mx-loom "dumb and secret-free" (design §1) and honest about what it can verify. The "verification" of AC 2 is fundamentally the substrate's; mx-loom carries the digest and the path discriminator.

### Normalizer reuse vs. a small dedicated reader

`callResponseToResult` (T105) expects the success payload under a `result` key and classifies by a state token; the `share.*` success payload is a **flat** object (`{context_id, sha256, …}`) with likely no state token, so routing it through `callResponseToResult` would fall to the default branch and mis-map (no `ok:true`, no nested `result` → `internal`). Therefore write a **small, dedicated normalizer** for the share/get responses:

```ts
// pseudo-shape — reuse exported readers where possible
function shareResponseToResult(raw: unknown, project: (o: Record<string, unknown>) => Record<string, unknown>): ToolResult {
  const obj = asRecord(raw) ?? {};
  const audit_ref = extractAuditRef(obj);          // populated for a publish; may be all-null for a read
  if (hasErrorSignal(obj)) return failureResult(failureCode(obj, undefined), audit_ref);
  return ok(project(obj), audit_ref);              // flat payload IS the success
}
```

To build this without duplication, **refactor `src/handlers/invocation.ts` to export the shared response readers** (`extractAuditRef`, `hasErrorSignal`, `failureCode`) — or extract them into a new `src/handlers/response-readers.ts` that both `invocation.ts` and the share handlers import. This is a clean, reviewable refactor (single source for "read correlation ids / classify a daemon error from a response"). The alternative (duplicating ~30 lines of readers in the share handlers) is discouraged. `failureResult`, `isTerminal`, and `asRecord` are already exported.

### `audit_ref` disposition

- **`mx_share_context`** publishes a `com.mxagent.context.share.v1` event → a Matrix round-trip → **populated** `audit_ref` (`event_id` of the share event, `room`, etc.), filled from the response via `extractAuditRef`, null-not-fabricated (like T105/T106).
- **`mx_get_context`** is a fetch. Whether it is a local daemon read (all-null `audit_ref`, like T104 discovery) or a Matrix-media round-trip (populated) is **unverified** — extract whatever the response carries, defaulting to `EMPTY_AUDIT_REF` when the daemon returns no ids. Flag at the round-trip (Risks #5).

## Affected Files / Packages / Modules

**New:**
- `packages/registry/src/handlers/share-context.ts` — `mxShareContext` + `ShareContextInput`.
- `packages/registry/src/handlers/get-context.ts` — `mxGetContext` + `GetContextInput`.
- *(Recommended)* `packages/registry/src/handlers/response-readers.ts` — `extractAuditRef` / `hasErrorSignal` / `failureCode` extracted from `invocation.ts` for reuse (or export them from `invocation.ts` directly).
- `packages/registry/test/handlers/share-context.test.ts` — unit tests over a fake `DaemonCall`.
- `packages/registry/test/handlers/get-context.test.ts` — unit tests over a fake `DaemonCall`.
- `packages/registry/test/handlers/context.security.test.ts` — secret-boundary + no-authority + redaction assertions for both verbs (or fold into the per-handler test files, mirroring `run-command.security.test.ts`).
- *(Optional, staged)* `packages/toolbelt/test/conformance/share.conformance.test.ts` — Tier-2 raw `share.*` round-trip behind `MXL_CONFORMANCE_TWO_DAEMON=1` (AC 1 byte-identity + AC 2 media path).

**Modified:**
- `packages/registry/src/handlers/invocation.ts` — *only if* extracting/exporting the shared readers (`extractAuditRef`, `hasErrorSignal`, `failureCode`).
- `packages/registry/src/handlers/index.ts` — export `mxShareContext`, `mxGetContext`, `ShareContextInput`, `GetContextInput`.
- `packages/registry/src/index.ts` — re-export the same from the package barrel.
- `packages/registry/README.md` — add a "context-sharing handlers (T107)" section in the established handler-list style.
- *(Optional)* `packages/toolbelt/test/conformance/_harness.ts` — extend `TwoDaemonFixture` with share/context coordinates (e.g. a known artifact `kind` + a large-artifact fixture) if the share conformance test is added.

**Read (reused, not modified):**
- `src/descriptors/share-context.ts`, `src/descriptors/get-context.ts`, `src/envelope.ts`, `src/errors.ts`, `src/handlers/deps.ts` (`RoomScopedDeps`), `src/handlers/handler-fault.ts` (`faultToResult`, `EMPTY_AUDIT_REF`), `src/handlers/agent-projection.ts` (`asRecord`), `src/security.ts`, `src/idempotency.ts` (only if Risks #3 resolves toward adding a key).

## API / Interface Changes

- **New public API (registry):** `mxShareContext(input: ShareContextInput, deps: RoomScopedDeps): Promise<ToolResult>` and `mxGetContext(input: GetContextInput, deps: RoomScopedDeps): Promise<ToolResult>`, plus the exported `ShareContextInput` / `GetContextInput` types. All exported from `@mx-loom/registry`. Documented with TSDoc in the established header-comment style.
- **Daemon RPC surface consumed:** `share.file` / `share.diff` / `share.env` (share) and `share.get` (get) — new for a *handler* (previously consumed by no code path). No daemon-side change. `share.list` is **not** consumed by the recommended fetch-by-id `mx_get_context` (see Risks #2).
- **Tool-descriptor surface:** **none** under the recommended approach — `MX_SHARE_CONTEXT` / `MX_GET_CONTEXT` are unchanged from T101; T107 implements their handlers. *(If Risks #2 — list mode — or Risks #3 — share idempotency_key — resolve toward a descriptor amendment, that becomes a flagged T101-surface change requiring confirmation; default is no change.)*
- **`RoomScopedDeps`:** reused as-is — **no new deps type** (unlike T105's `DelegateDeps`/T106's `ExecDeps`, share/get need only the room-scoped seam, no validator). Additive only.
- **CLI surface:** none.

## Data Model / Protocol Changes

- **Result envelope:** **no shape change.** Both verbs reuse `ok` / `denied` / `errored`. `mx_share_context` produces populated `audit_ref` (publish round-trip); `mx_get_context` extracts ids if present, else `EMPTY_AUDIT_REF`. Success payloads conform to the descriptors' `output_schema` (`{context_id, sha256}` for share; `{context_id, …}` open object for get).
- **Error taxonomy:** **no new codes.** The handlers emit, via the existing mappers: `policy_denied` (receiver policy forbids the share/fetch), `untrusted_key` (signing key not trusted), `not_found` (unknown `context_id` — needs a daemon-code alias, below), `invalid_args` (credential-shaped `content`/`path` rejected at dispatch, or a malformed request), `target_offline`, `timeout` (genuine transport fault), `internal` (missing room / unrecognized response / local fault, incl. an inline integrity-check failure if client-side recompute is enabled).
- **`mapDaemonError` aliases (small addition, Risks #6):** add the unknown-context daemon spellings to `DAEMON_CODE_TO_ERROR` so they map to `not_found` (joining `unknown_agent`/`unknown_tool`/`no_such_invocation`): e.g. `unknown_context` / `no_such_context` / `context_not_found` → `not_found`. Pin the real spelling at the round-trip.
- **Idempotency:** under the recommended content-addressing approach, **no idempotency_key** is added (Risks #3). If added later, it rides in `share.*` params exactly as T105/T106 (verbatim-param retry; daemon dedupes).
- **sha256 / integrity:** the `sha256` field is **passed through** from the daemon (authoritative, computed over stored bytes). Any client-side recompute is over *inline* bytes only and is a defensive check, gated by the redaction interaction (Risks #4). No new field.
- **Wire-shape assumptions (pending the two-daemon round-trip, `MXL_CONFORMANCE_TWO_DAEMON=1`):** the `share.file/diff/env` and `share.get` param names (`room`/`path`/`content`/`encoding`; `context_id`/`room`), the success field names (`context_id`/`sha256`/`inline`/`media_mxc`/`size_bytes`), whether share publishes a Matrix event (populated `audit_ref`) and whether `share.get` is a local read or a media round-trip, the unknown-context daemon code spelling, and whether the daemon content-addresses shares. Authored against the design's named shapes now (localized consts + `internal`-safe fallbacks); pinned at the round-trip. A new daemon code degrades to `internal`/`not_found` as appropriate (never the wrong code), never throws.

## Security & Compliance Considerations

`mx_share_context` is, of the M1 verbs, the **single most dangerous secret-exfiltration surface** — a model that wanted to leak a credential it somehow obtained would reach for "share this content." So the secret-boundary posture here is paramount, even though the handler itself enforces nothing.

- **Cognition produces only a signed request / read; it never grants itself authority.** Neither handler performs a trust/policy/sandbox check. The receiving daemon's deny-by-default `policy.toml` decides whether a share/fetch is permitted; `policy_denied` / `untrusted_key` are outcomes the handlers *map*, never decisions they make (design §1, §6). Neither verb is in `FORBIDDEN_AUTHORITY_PREFIXES`/`VERBS`; `isForbiddenAuthorityVerb('mx_share_context') === false` and likewise for get (assert in tests).
- **The secret boundary holds at the toolbelt chokepoint (Boundary A).** No field carries a credential inbound or outbound. `content` and `path` ride through `MxClient.call()`, which runs `assertNoCredentialShapedArgs` over keys **and values** *before dispatch* — so a share whose `content` contains a token-shaped value (`ghp_…`, `sk-ant-…`, a PEM header, a `Bearer …` secret, `GH_TOKEN`) is **rejected as `invalid_args`** rather than published. This is a feature: **you cannot exfiltrate a credential-shaped secret by sharing it.** (Known limitation / false-positive risk: a legitimate diff containing a token-shaped substring is also rejected — see Risks #4; fail-closed is the correct default.)
- **`kind: 'env'` is the highest-risk artifact and is doubly bounded.** An env snapshot is the most likely place a secret would appear. But (a) the runtime **never holds** the daemon's secrets — `MATRIX_*`, `MX_AGENT_*`, provider keys, `GH_TOKEN` are daemon-held and never cross Boundary A, so a model-assembled env snapshot cannot contain them by construction; and (b) the value-shape guard rejects any credential-shaped content the model assembled from elsewhere. The handler adds no env access of its own.
- **Inbound redaction on fetch.** `mx_get_context` results pass through `MxClient.redactSecrets` at the `call()` exit, so any token-shaped value in returned `inline` content is redacted before it reaches the model — runners receive retrieved TEXT only, never credentials. **This has a correctness interaction with byte-identity and any client-side sha256 recompute (Risks #4) that must be resolved explicitly.**
- **mx-loom never touches Matrix media or credentials.** The `media_mxc` path is fetched/verified entirely on the daemon (it holds the Matrix session). mx-loom surfaces the reference + digest and downloads nothing. This is the boundary line for AC 2's "sha256 verification."
- **No secret-shaped data in the envelope.** `error.message` is the fixed, secret-free phrase per code (`MESSAGE_FOR_CODE`); the handlers must **never** place `content`, `path`, an arg value, or a daemon payload into `error.message`. `context_id` / `sha256` / `media_mxc` are correlation/integrity handles, not secrets.
- **Audit correlation.** `mx_share_context` populates `audit_ref` tying "model shared X" to the signed `com.mxagent.context.share.v1` event; the Postgres mirror is T113. Missing ids are `null`, never fabricated.
- **Logging/redaction.** Never log `content`, `path`, fetched bytes, or any token. No `console`/debug sink that receives params or values; at most codes/method names. (T107 should not introduce a debug sink unless the existing handlers already established one — they did not.)
- **No-authority + secret-free invariants regression-tested.** Both verbs stay in `MODEL_FACING_ALLOWLIST`; their descriptors' `input_schema` declare no credential-shaped property (the existing `findCredentialShapedProperty` loader check already enforces this — `content`/`path`/`context_id`/`kind`/`encoding`/`sha256` are clean).

## Testing Plan

Unit tests over a **fake `DaemonCall`** (no socket, no daemon), mirroring `test/handlers/delegate-tool.test.ts` / `run-command.test.ts`. The fake simulates each daemon outcome; the substrate behaviors (threshold, media, byte-identity) are simulated by the fake's return shapes and pinned for real by the staged conformance fixture.

**`mx_share_context` (`share-context.test.ts`):**
- **AC 1 (share half) — share a diff returns `{context_id, sha256}`:** fake `share.diff` returns a success `{ context_id: 'ctx_…', sha256: '…', audit_ref: {…} }` → assert `status: ok`, `result.context_id` / `result.sha256` passed through verbatim, `audit_ref` populated, `validateEnvelope(result)` passes.
- **`kind` → method routing:** `kind:'file'` dispatches `share.file`, `kind:'diff'` → `share.diff`, `kind:'env'` → `share.env` (assert the method passed to the fake). Defensive: an out-of-enum `kind` (forced) → `invalid_args`, no dispatch.
- **Param forwarding / omission:** `path`/`content`/`encoding` forwarded verbatim when present; omitted when absent (assert no `undefined` leaks into params); `room` injected from `deps.room`, never from input.
- **Missing room:** `deps.room` absent/empty → `internal`; assert the fake `share.*` was **never called**.
- **Denial / fault mapping:** `policy_denied` (thrown rpc **and** resolved `{ok:false, error:{code:'policy_denied'}}`) → `denied('policy_denied')`; `untrusted_key` → `denied('untrusted_key')`; `target_offline` → `errored('target_offline')`; a genuine transport `timeout` → `errored('timeout')`.
- **Robustness / never-throws:** malformed response (scalar/array/null) → a safe envelope (`internal` or, if a flat payload, `ok` with the projected fields), never a thrown error.

**`mx_get_context` (`get-context.test.ts`):**
- **AC 1 (fetch half) — fetch an inline artifact:** fake `share.get` returns `{ context_id, kind:'diff', sha256, size_bytes, inline:'…' }` → assert `status: ok`, all fields passed through, `validateEnvelope` passes; (byte-identity of `inline` vs the shared content is the *conformance* assertion, not the unit-level one).
- **AC 2 — large artifact uses the media path:** fake `share.get` returns `{ context_id, kind:'file', sha256, size_bytes: 512*1024, media_mxc:'mxc://…' }` (no `inline`) → assert `result.media_mxc` present, `result.inline` absent, `result.sha256` surfaced. (Asserts the handler *surfaces* the media path; the daemon's actual >256 KiB split + media sha256 verification is the conformance concern.)
- **Unknown `context_id` → `not_found`:** fake `share.get` rejects with the unknown-context daemon code → `errored`/`not_found` (and pins the `mapDaemonError` alias added in Risks #6).
- **sha256 surfacing (and, if client-recompute is enabled per Risks #4) integrity check:** assert `sha256` is passed through; if recompute is implemented, an inline payload whose bytes mismatch the declared `sha256` → `errored('internal', …)` (integrity failure), and a matching one → `ok`.
- **Denial / fault mapping + missing room + robustness:** as for share.

**Shared / security (`context.security.test.ts`):**
- **Credential-shaped `content`/`path` → `invalid_args`** via the **real** `MxClient` guard at the registry boundary (a `content` containing `ghp_…` / a PEM header / `Bearer …` is rejected before publish); a credential-shaped param **key** likewise.
- **Inbound redaction:** a fake `share.get` returning a token-shaped value in `inline` is redacted before the result is returned (when exercised through a real `MxClient`); **document the byte-identity vs redaction interaction** explicitly (Risks #4) so the test asserts the *intended* resolution, not an accidental one.
- **Secret-free envelope:** no `error.message` / log line contains `content`, `path`, a fetched byte, or a token.
- **No-authority invariants:** `isForbiddenAuthorityVerb('mx_share_context') === false`, same for get; both in `MODEL_FACING_ALLOWLIST`; result immutability (deep-frozen).
- **Envelope/error-taxonomy conformance:** every returned `ToolResult` passes `validateEnvelope`; every emitted `error.code` ∈ `ERROR_CODES`.

**Conformance (staged, optional this issue):** add `packages/toolbelt/test/conformance/share.conformance.test.ts`, gated behind `MXL_CONFORMANCE_TWO_DAEMON=1`, driving **raw** `MxClient.call('share.diff'|'share.get', …)` for: **(AC 1)** share a known diff → `share.list`/`share.get` → assert the bytes round-trip **byte-identical** and the `sha256` matches; **(AC 2)** share a >256 KiB artifact → assert the fetched result takes the **media path** (`media_mxc`, no `inline`) and the daemon-reported `sha256` verifies. This requires extending `TwoDaemonFixture` with share coordinates and pins the live `share.*` shapes (the OQ-laden wire). Mark it staged/red-on-drift like `delegate`/`exec`; the M1 deliverable is the **unit** tests, with the live ACs pinned later. (This is also where "list it" of AC 1 is exercised, via `share.list`.)

## Documentation Updates

- **`docs/backlog.md`** — flip T107's two AC checkboxes once landed and append a `**Status:** Landed (…)` note in the T103–T106 style (module list + resolved decisions + the wire assumptions pending the two-daemon round-trip). Update the M1 status line ("T101–T106 landed" → include T107).
- **`docs/mx-agent-tool-fabric-design.md`** — update the §3 "Build rule" parenthetical and the M1 status line (header table + §7 context paragraph + §10 roadmap) to record that `mx_share_context` / `mx_get_context` (T107) are implemented as the shared-context publish/fetch seam (inline ≤256 KiB vs media + sha256, surfaced from the substrate). Reaffirm §1/§7: mx-loom stays dumb and secret-free — it never touches runtime-private memory or Matrix media. Do **not** imply the bindings (T109/T110), the golden test (T114), or the live two-daemon `share.*` round-trip exist.
- **`docs/mx-agent-surface-v0.2.1.md`** — once the (optional) share conformance fixture runs green, flip `share.file/diff/env` · `share.list` · `share.get` from "◻️ documented" to ✅ and record the confirmed shapes (param names, `context_id`/`sha256`/`inline`/`media_mxc`/`size_bytes`, the inline-vs-media threshold behavior, `audit_ref` availability for share vs get). Until then, leave the note and reference this spec's open questions.
- **`packages/registry/README.md`** — add a "context-sharing handlers (T107)" section: the two `sync` verbs, the `kind` → `share.*` routing, the inline-vs-media + sha256 split as *substrate* behavior the handler surfaces (mx-loom never downloads media), the populated-vs-empty `audit_ref` split, and the secret-boundary note (credential-shaped `content` rejected at dispatch; the byte-identity ↔ redaction interaction).
- TSDoc on the new handlers in the established header-comment style (cross-link design §7 and the receiver-side enforcement / boundary notes).

## Risks and Open Questions

1. **`share.*` wire shape (the central unknown — even less verified than T105/T106).** `share.*` is "◻️ documented", not even flag-confirmed; no existing conformance probe. The `share.file/diff/env` and `share.get` param names, the success field names (`context_id`/`sha256`/`inline`/`media_mxc`/`size_bytes`), and the inline-vs-media threshold behavior are all pending the two-daemon round-trip. **Mitigation:** localize the method/param consts; reuse the response readers + `internal`/`not_found`-safe fallbacks; add the staged share fixture to pin them. **Decision to confirm:** proceed authoring against the design's named shapes (recommended, consistent with T101–T106) vs. block on the live round-trip.
2. **`share.list` / a model-facing list mode (the AC "list it").** Design §2 maps `mx_get_context → share.list / share.get`, but the authored descriptor requires `context_id` (fetch only). **Recommended:** keep `mx_get_context` as fetch-by-id for M1 (matches the descriptor exactly; satisfies "fetch it back"), and exercise the "list it" step against `share.list` in the staged conformance test. **Alternative (flag):** make `context_id` optional in the descriptor (omit ⇒ `share.list` → `ok({ contexts: ContextSummary[] })`, the `find-agents` `{agents}` pattern) — a T101-surface change requiring confirmation, plus an `output_schema` that admits both a single artifact and a list. **Confirm** whether a model-facing list is needed in M1 or deferred.
3. **`mx_share_context` idempotency.** It is a mutating publish, but the descriptor has no `idempotency_key`. **Recommended:** rely on content-addressing (re-sharing identical bytes → same `context_id`, naturally idempotent); add no key for M1. **Confirm** the daemon content-addresses shares; if not, a double-share creates two `context_id`s and adding an `idempotency_key` (a descriptor change) becomes warranted.
4. **Byte-identity ↔ inbound redaction ↔ client-side sha256 (the subtle one).** `MxClient.redactSecrets` rewrites token-shaped values in *every* inbound result, including `mx_get_context`'s `inline` content. That means: (a) a fetched artifact containing a token-shaped substring is **altered**, breaking AC 1's "byte-identical" for *that* content; and (b) a handler that recomputed sha256 over the redacted bytes would mismatch the daemon's pre-redaction digest and falsely report an integrity failure. **Recommended:** surface the daemon's `sha256` as the authoritative anchor and **do not** recompute inline by default; rely on the *share-time* value guard (which rejects credential-shaped content before it is ever stored through mx-loom) so the secret-free invariant holds without redaction needing to fire on fetch; restrict the AC-1 byte-identity guarantee to secret-free artifacts (the realistic case — normal diffs/files). **Confirm** with the toolbelt/daemon owners whether `mx_get_context` content should be redaction-exempt (a toolbelt change, *not* recommended — it weakens defense-in-depth) or whether the "secret-free artifact" framing is acceptable. **Do not weaken the contract to make a test pass.**
5. **Does `mx_get_context` need `room`, and is it a round-trip?** `share.get` may resolve a globally-unique `context_id` (no room needed, possibly a local read → all-null `audit_ref`) or be room-scoped + media-fetching (populated `audit_ref`). **Recommended:** pass `room` through for consistency and extract `audit_ref` if present, defaulting to `EMPTY_AUDIT_REF`. **Confirm** the room requirement and the read-vs-round-trip nature at the round-trip; drop the room fail-fast for `get` if it is genuinely not required.
6. **Unknown-`context_id` daemon code.** `not_found` should cover it, but the exact daemon spelling is unverified. **Recommended:** add `unknown_context` / `no_such_context` / `context_not_found` → `not_found` aliases to `DAEMON_CODE_TO_ERROR` and pin the real spelling at the round-trip (a miss degrades to `internal`, never the wrong code).
7. **Response-reader refactor.** Reusing the flat-payload classification cleanly wants `extractAuditRef` / `hasErrorSignal` / `failureCode` shared from `invocation.ts`. **Recommended:** export them (or extract to `response-readers.ts`). **Confirm** the refactor vs. a small local duplication (discouraged).
8. **`path` vs `content` semantics per `kind`.** For `kind:'file'`, does the daemon read `path` server-side from the agent workspace, or is `content` always the source (with `path` a label)? The descriptor calls `path` a *"logical path/name"*, implying `content` is the bytes — but a >256 KiB file is awkward to inline. **Recommended:** forward both `path` and `content` verbatim and let the daemon interpret per kind. **Confirm** at the round-trip whether large `file` shares are content-inlined by the model or read server-side by `path`.

## Implementation Checklist

1. *(Recommended refactor)* In `src/handlers/invocation.ts`, export the shared response readers (`extractAuditRef`, `hasErrorSignal`, `failureCode`) — or extract them to `src/handlers/response-readers.ts` and re-point `invocation.ts` — so the share handlers reuse them without duplication. Keep `invocationToResult`/`callResponseToResult` behavior unchanged.
2. Create `src/handlers/share-context.ts`:
   - localized wire consts (`SHARE_METHOD_FOR_KIND`, param-name note);
   - `ShareContextInput` (`kind` req; `path?` / `content?` / `encoding?`);
   - Phase 1 — room provenance: `errored('internal', …, EMPTY_AUDIT_REF)` when `deps.room` is absent/empty;
   - Phase 2 — resolve `share.file/diff/env` from `kind` (defensive `invalid_args` on an out-of-enum kind);
   - Phase 3 — build params (`room` from `deps.room`; `path`/`content`/`encoding` forwarded verbatim, omitted when absent), dispatch via `deps.daemon.call`; `faultToResult(err, EMPTY_AUDIT_REF)` on rejection (maps `policy_denied`/`untrusted_key`/credential-shaped `content` → `invalid_args`);
   - Phase 4 — normalize via the shared flat-payload classifier → `ok({ context_id, sha256 }, audit_ref)` (populated `audit_ref`) or `failureResult(...)`;
   - **no** threshold / media / sha256-compute logic; **never throws**.
3. Create `src/handlers/get-context.ts`:
   - localized wire const (`SHARE_GET_METHOD`);
   - `GetContextInput` (`context_id` req);
   - Phase 1 — room provenance (or pass-through, per Risks #5);
   - Phase 2 — dispatch `share.get { context_id, room? }`; `faultToResult` on rejection (unknown context → `not_found`);
   - Phase 3 — normalize → `ok({ context_id, kind?, sha256?, size_bytes?, inline?, media_mxc? }, audit_ref)` (payload passed through; `audit_ref` extracted or `EMPTY_AUDIT_REF`);
   - Phase 4 — surface `sha256` as the integrity anchor; **do not download media**; client-side inline recompute only if Risks #4 is resolved to allow it;
   - **never throws**.
4. Add the unknown-context aliases to `DAEMON_CODE_TO_ERROR` in `src/errors.ts` (Risks #6).
5. Export `mxShareContext`, `mxGetContext`, `ShareContextInput`, `GetContextInput` from `src/handlers/index.ts` and `src/index.ts`.
6. Write `test/handlers/share-context.test.ts` and `test/handlers/get-context.test.ts` (AC 1 share/fetch, AC 2 media path, `kind` routing, param forwarding/omission, missing room not-dispatched, denial/fault mapping, unknown-context → not_found, robustness/never-throws, envelope conformance).
7. Write `test/handlers/context.security.test.ts` (credential-shaped `content`/`path` value & key → `invalid_args` via the real `MxClient` guard; inbound redaction of token-shaped `inline` + the documented byte-identity interaction; secret-free envelope/messages; no-authority + allowlist + immutability invariants).
8. *(Optional, staged)* Add `packages/toolbelt/test/conformance/share.conformance.test.ts` + extend `TwoDaemonFixture` with share coordinates; gate behind `MXL_CONFORMANCE_TWO_DAEMON=1`; pin the live `share.*` shapes, byte-identity (AC 1), and the media path + sha256 (AC 2).
9. Update `packages/registry/README.md` (T107 handler section), `docs/backlog.md` (T107 ACs + Status note + M1 status line), `docs/mx-agent-tool-fabric-design.md` (§3/§7/§10 + M1 status), and (when the fixture is green) `docs/mx-agent-surface-v0.2.1.md`.
10. Run `pnpm --filter @mx-loom/registry test` + typecheck/lint; confirm green. Do **not** run git/gh (the orchestrator owns that).
