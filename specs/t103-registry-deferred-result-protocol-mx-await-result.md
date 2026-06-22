# Registry: Deferred-Result Protocol (`mx_await_result`) (T103 / #11)

> Implementation spec for GitHub issue **#11 — T103 · registry: deferred-result protocol (`mx_await_result`)**.
> Labels: `area/registry` · `priority/P0` · `type/feature`. Milestone **M1 — Delegation MVP**. Estimate **M**.
> Sources: [`docs/mx-agent-tool-fabric-design.md`](../docs/mx-agent-tool-fabric-design.md) (§4.2 the result
> envelope, **§4.3 the deferred-result protocol — "the one piece of semantics a runtime cannot skip"**, §5 the
> invocation flow incl. the approval-gated path, §6 security/approval, §7 audit/sessions),
> [`docs/backlog.md`](../docs/backlog.md) (`T103`, its place on the M1 critical path, and what it unblocks —
> T109 MCP server, T110 Claude shim, T202 ADK long-running shim),
> [`docs/mx-agent-surface-v0.2.1.md`](../docs/mx-agent-surface-v0.2.1.md) (the verified daemon surface;
> `invocation.*` is *documented but full round-trip is staged* behind the two-daemon conformance fixture), the
> landed **`@mx-loom/registry`** (T101 descriptor model + the `MX_AWAIT_RESULT` descriptor; T102 the
> `ToolResult` envelope, helpers `ok`/`running`/`awaitingApproval`/`denied`/`errored`, the closed `ErrorCode`
> taxonomy + `mapDaemonError`/`mapTransportError`, `audit_ref`) and **`@mx-loom/toolbelt`** (M0 —
> `MxClient.call`/`MxTransport`, the closed `TransportErrorCode` set, the conservative `not_running`-only
> failover).
> **Blocked-by #10 (T102)** — satisfied: the envelope, the five-status set (`ok|running|awaiting_approval|
> denied|error`), the `handle`/`approval`/`audit_ref` fields, and the mappers all exist.
> **Unblocks T109** (MCP server — `awaiting_approval` must surface and resolve over MCP), **T110** (Claude
> in-process shim — hides the poll loop), and **T202** (ADK `LongRunningFunctionTool` — resumes on result).

## Problem Statement

Design §4.3 names the deferred-result protocol "**the one piece of semantics a runtime cannot skip**." Remote
calls and approvals are asynchronous: a delegation (`mx_delegate_tool` → `call.start`) or a guarded command
(`mx_run_command` → `exec.start`) may not have a result yet when the tool call returns. Per the envelope contract
(T102), such a call returns a **non-terminal** envelope — `status: running` or `status: awaiting_approval` — plus
a `handle` (`inv_…`). Something must turn that handle into a **terminal** envelope (`ok` / `denied` / `error`).
That something is `mx_await_result(handle, wait_ms)`.

Today the *shape* of a deferred result exists but the *resolution* does not:

- **T101 shipped the descriptor; nothing backs it.** `packages/registry/src/descriptors/await-result.ts`
  declares `MX_AWAIT_RESULT` — `async_semantics: 'sync'`, input `{ handle (required, string), wait_ms (optional,
  integer ≥ 0) }`, an open `output_schema` — and its doc-comment states plainly it is "Backed by
  `invocation.get` / `task.watch` **in T103**." The descriptor is metadata only; there is no handler, no
  daemon call, no `wait_ms` semantics.
- **T102 fixed the deferred *shape* and deferred the *resolution*.** The envelope defines `running` /
  `awaiting_approval` + `handle` + the read-only `approval` block, and `running()` /`awaitingApproval()` helpers
  build them. But T102's Non-Goals are explicit: "Deferred-result resolution (T103, explicit out-of-scope) …
  polling a handle to a terminal envelope, the `wait_ms` timeout semantics, `invocation.get`/`task.watch` — is
  **T103**." `running()` even documents that its handle "is resolved to a terminal envelope via
  `mx_await_result` (T103)."
- **No handler layer exists at all.** T103 is the **first** of the M1 handlers (T103/T104/T105/T106/T107/T108).
  The registry is, by its own stated invariant, "contract only — executes nothing, makes no daemon call, holds
  no `@mx-loom/toolbelt` runtime dependency." A resolver that polls `invocation.get` *does* call the daemon, so
  T103 must establish **where handlers live and how they get a daemon-call seam** — the pattern T104–T108 reuse.

T103 closes this gap by implementing the **resolver**: a function that takes a `handle` (and optional `wait_ms`),
calls the daemon `invocation.get` through the injected `MxTransport`/`MxClient` seam, maps the invocation's
current state onto a T102 `ToolResult` via the existing helpers + `mapDaemonError`/`mapTransportError`, and
implements the `wait_ms` blocking-with-timeout semantics — where **a `wait_ms` expiry that finds the invocation
still pending is not an error**: it returns the still-pending `running` / `awaiting_approval` envelope. The model
(generic MCP) calls `mx_await_result` explicitly; a native binding (Claude T110, ADK T202) calls the same
resolver internally to hide the poll loop. Either way it is the one shared primitive that turns a handle into a
terminal answer.

## Goals

- **Implement the `mx_await_result` resolver** — `mxAwaitResult({ handle, wait_ms }, deps)` — that resolves a
  deferred handle to a `ToolResult`, backed by the daemon `invocation.get` RPC, returning the existing T102
  envelope built **only** through the T102 constructor helpers (so it conforms by construction).
- **AC 1 — a `running` handle resolves to a terminal envelope.** When the invocation has completed, the resolver
  returns the terminal envelope (`ok` with the success payload, or `denied`/`error` for a terminal failure),
  with `audit_ref` carried through from the invocation.
- **AC 2 — an `awaiting_approval` handle resolves to `ok`/`denied` after an operator decision.** While the
  operator has not decided, the handle resolves to `awaiting_approval` (still pending); once the operator decides
  out-of-process and the **daemon re-runs the authorize pipeline at release**, the next resolution observes the
  resulting terminal state — `ok` (approved + executed) or `denied` (`approval_denied` / `approval_expired` /
  `policy_denied` if policy changed). The resolver only **observes**; it never approves.
- **AC 3 — a `wait_ms` timeout returns the still-pending status without error.** When `wait_ms` elapses with the
  invocation still `running` / `awaiting_approval`, return that **pending** envelope — *not* an `error` with code
  `timeout`. The `timeout` error code is reserved for a genuine transport/daemon fault; a `wait_ms` expiry is a
  *successful poll that found the work still in progress*. This distinction is the crux of T103.
- **Define the `wait_ms` semantics precisely:** `wait_ms` omitted or `0` ⇒ a single, non-blocking probe;
  `wait_ms > 0` ⇒ block up to `wait_ms` (client-side poll loop with a bounded interval, the daemon's blocking
  long-poll as a later optimization), returning early on the first terminal state and otherwise the last pending
  state at the deadline.
- **Map the daemon invocation state → the five envelope statuses** in one normalization point (mirroring T102's
  `mapDaemonError`), authored against the design's named states now and pinned to the verified v0.2.1
  `invocation.get` vocabulary at the two-daemon round-trip.
- **Establish the handler home + the injected daemon-call seam** that T104–T108 reuse, **without** giving the
  registry a runtime dependency on the toolbelt (the transport is *injected*, imported `type`-only — the same
  technique T102 used for `TransportErrorCode`).
- **Export and document** the resolver as public API; keep `mx_await_result` a **read** verb (no
  `idempotency_key`, repeated polling is safe).

## Non-Goals

- **`task.watch` / streaming subscription (explicitly "later" in scope).** T103 resolves via **`invocation.get`
  polling**. The push-based `task.watch` subscription — and the durable task-stream resumption it enables — is
  **T302 (M3)**. The resolver's seam is designed so a later `task.watch` backend can replace the poll loop
  without changing the `mx_await_result` tool contract; T103 implements only the poll path.
- **Native long-running tool shims (M2 / out-of-scope per the issue).** Wrapping a deferred call as ADK's
  `LongRunningFunctionTool` (T202) or hiding the poll loop behind the Claude `tool()`/`canUseTool` surface
  (T110) are *binding* concerns that **consume** this resolver. T103 ships the runtime-neutral primitive; the
  bindings decide whether to expose `mx_await_result` to the model or call the resolver internally.
- **The mutating handlers that *produce* handles (T105/T106).** `mx_delegate_tool` → `call.start` and
  `mx_run_command` → `exec.start` build the request, validate args, and return the initial `running` /
  `awaiting_approval` + `handle`. T103 consumes a handle they produce; it does not implement them. (T103 may land
  a tiny fake "deferred producer" in tests to exercise resolution, but the real producers are T105/T106.)
- **`mx_cancel` (T108).** Cancelling an in-flight handle (`invocation.cancel`) and whether a cancelled
  invocation surfaces as `denied`/`error` or needs a sixth status is a T108 decision. T103 resolves a handle to
  its *natural* terminal/pending state; it does not cancel.
- **The approval *decision* path.** The operator decides via the approval dashboard / `approval.decide` (T403,
  out-of-process); the daemon re-validates against live policy at release (design §5). T103 **observes** the
  post-decision terminal state through `invocation.get`; it issues no decision and exposes no approve/deny
  surface to the model.
- **The Postgres audit mirror (T113).** T103 carries `audit_ref` on the resolved envelope (from
  `invocation.get`); writing an audit row is T113.
- **Re-validating `result` against the original tool's `output_schema`.** The resolver returns the daemon's
  success payload in `ok().result`; binding/handler-side `output_schema` validation against the *original*
  tool's schema is the delegating handler's concern (T105). `mx_await_result`'s own `output_schema` is
  deliberately open (the resolved shape depends on the original tool, unknown to the resolver).
- **Loosening the toolbelt failover policy.** `invocation.get` is a *read*; T103 may safely retry/failover it,
  but it does not change `MxClient`'s conservative `not_running`-only failover for *mutating* calls.

## Relevant Repository Context

**Stack.** TypeScript (ESM, `"type": "module"`), pnpm workspace (`packages/*` + `adw_sdlc`), Node ≥ 20.19,
vitest 4.x, Apache-2.0, strict nodenext tsconfig (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`,
`isolatedModules`). Two workspace packages exist today: `@mx-loom/toolbelt` (`packages/toolbelt`, M0) and
`@mx-loom/registry` (`packages/registry`, T101 + T102).

**The issue's "repo is docs-only" framing is stale** (it predates M0/T101/T102). M0, T101, and T102 are built;
T103 adds the first *handler*. Verified by reading the tree:

- **`@mx-loom/registry` (T101 + T102 — the package T103 builds on):**
  - `src/descriptors/await-result.ts` — **`MX_AWAIT_RESULT` already exists** (T101): `async_semantics: 'sync'`,
    `input_schema` = `{ handle (required, string), wait_ms (optional, integer, minimum 0) }`
    (`additionalProperties: false`), open `output_schema`. Its doc-comment forward-references this issue: "Backed
    by `invocation.get` / `task.watch` in T103." **T103 leaves the descriptor as-is** and adds the behavior.
  - `src/envelope.ts` — `ToolResult`, the five-status union, and the constructor helpers
    `ok`/`running`/`awaitingApproval`/`denied`/`errored` (each requires an `audit_ref`, sets exactly its
    status's fields, deep-freezes). **T103 builds every envelope through these.**
  - `src/errors.ts` — `ERROR_CODES` (closed nine-code set), `DENIAL_CODES`/`FAULT_CODES` partition,
    `mapDaemonError(daemonError)` (daemon code → `ErrorCode`, `internal` fallback) and `mapTransportError(code)`
    (toolbelt `TransportErrorCode` → `ErrorCode`, exhaustive). **T103 reuses both** to render a terminal failure
    or a transport fault onto the closed taxonomy.
  - `src/idempotency.ts` — `newIdempotencyKey()` / the idempotency contract. **Not used by T103**:
    `mx_await_result` is a read verb and carries no `idempotency_key` (confirmed — the descriptor has only
    `handle`/`wait_ms`).
  - `src/validator.ts` — `SchemaValidator` seam + `createAjvValidator()`; `JSON_SCHEMA_DIALECT` = draft-07. The
    precedent for an **injectable seam**; T103 uses the same idea for the transport.
  - `src/index.ts` — the public barrel T103 extends. `ajv` is the one runtime dep; `@mx-loom/toolbelt` is a
    **devDependency** (used today only for the `type`-only `TransportErrorCode` import in `errors.ts`).
- **`@mx-loom/toolbelt` (M0 — the transport the resolver calls through):**
  - `src/transport.ts` — the `MxTransport` interface (`call(method, params?, options?)` resolves the raw daemon
    RPC `result`; `status`/`ping`/`close`); `CallOptions = { timeoutMs? }`; `TransportError`/`TransportErrorCode`
    (closed set `not_running | connect_failed | timeout | closed | frame | protocol | rpc | invalid_args`).
    **`MxTransport` is an interface (type), so a resolver typed against it imports it `type`-only** — no runtime
    toolbelt dependency.
  - `src/client.ts` — `MxClient` *implements* `MxTransport`; `call()` applies the outbound credential guard +
    inbound `redactSecrets`, retries per `RetryPolicy`, and (in `auto`) fails over IPC→CLI only on
    `not_running`. **`MxClient` is what a binding injects into the resolver.** `defaultTimeoutMs` = 30 000.
  - `src/retry.ts` — `withRetry` + `RetryPolicy`; the `sleep`/`random` injection seams T103 mirrors for its poll
    loop's clock.

**Verified daemon surface (`docs/mx-agent-surface-v0.2.1.md`, T001) — what the resolver depends on:**

- ✅ `daemon.status`, `agent.register`/`list`/`tools`, `workspace.status`, `trust.fingerprint` round-trip live.
- ◻️ **`invocation.*` is "documented" — full round-trip is staged** behind the two-daemon conformance fixture
  (`MXL_CONFORMANCE_TWO_DAEMON=1`): "`share.file/diff/env` · `approval.decide` · `invocation.*` … exercise in the
  conformance suite (T007) with a two-daemon fixture." **Consequence:** the exact `invocation.get` **method/param
  name** (`invocation.get` vs `invocation.show`; param `invocation_id` vs `handle` vs `id`), the **invocation
  state vocabulary** (what the daemon returns for in-flight / held-for-approval / succeeded / denied / failed),
  whether `invocation.get` supports a **server-side blocking/long-poll** (`wait_ms`/`timeout` param) or must be
  **client-side polled**, the **`approval` block fields** on a held invocation, and the **`audit_ref` field
  availability** are **not yet live-verified**. T103 must author the contract against the design doc and **flag
  these as decisions to confirm** at the two-daemon round-trip — not assume them (Open Questions #2–#5).

**Does NOT exist yet (net-new in T103):** any handler/resolver; the invocation-state→envelope normalization; the
poll-with-timeout loop; the daemon-call seam the handlers share; a handler package or `src/handlers/` subtree.
Grep across `packages/*/src` finds `mx_await_result`, `invocation.get`, `wait_ms`, and "handler" only in
doc-comments (the T101/T102 forward-references), never as behavior.

## Proposed Implementation

Implement the resolver as a small, pure, dependency-light unit that takes an **injected** daemon-call seam (so it
is unit-testable with a fake transport and adds no runtime toolbelt dependency), maps the daemon's invocation
state onto a T102 envelope via the existing helpers + mappers, and runs the `wait_ms` poll-with-timeout loop. No
descriptor change; no `MxClient` change.

### 0. Where the handler lives (decision to confirm — Open Question #1)

T103 is the first handler, so it sets the precedent for T104–T108. Three options:

- **(A) `@mx-loom/registry`, `src/handlers/await-result.ts`, transport injected `type`-only — recommended.**
  Matches the `area/registry` label on T103–T108, reuses the package's seam philosophy (`SchemaValidator` is
  already injected), and — because `MxTransport` is an *interface* — keeps the registry's **zero runtime toolbelt
  dependency** intact (the resolver imports `MxTransport` `type`-only, exactly as `errors.ts` already imports
  `TransportErrorCode`; the concrete `MxClient` is passed in by the caller). The only cost is a **remit
  expansion**: the registry grows from "contract only — executes nothing" to "contract **+** handlers that call
  an injected daemon." Flag this expansion for sign-off.
- **(B) A new `@mx-loom/tools` (or `@mx-loom/handlers`) leaf package** depending on both `@mx-loom/registry` and
  `@mx-loom/toolbelt`. Cleanest separation (registry stays pure contract); cost is new workspace wiring, and it
  contradicts the `area/registry` labelling of T103–T108.
- **(C) `@mx-loom/toolbelt`.** It already holds `MxClient`/the session; cost is mixing transport with model-facing
  tool semantics and a registry→toolbelt-or-back dependency tangle.

**Recommendation: (A)** — lowest churn, matches the labels, preserves the zero-runtime-dep invariant via
injection. The rest of this spec assumes (A) but nothing below depends on the choice beyond file paths.

### 1. The daemon-call seam (`src/handlers/deps.ts`)

A narrow structural seam the resolver depends on — satisfied by `MxClient` and by a one-line fake in tests:

```ts
import type { MxTransport } from '@mx-loom/toolbelt'; // type-only — erased; no runtime dep

/** The daemon-call surface a handler needs (a structural subset of MxTransport). */
export type DaemonCall = Pick<MxTransport, 'call'>;

/** Injected dependencies + testing seams shared by handlers. */
export interface HandlerDeps {
  readonly daemon: DaemonCall;
  /** Injected clock/sleep for the poll loop (default: real `setTimeout` + `Date.now`). */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Base poll interval in ms (default ~200 ms, capped ~1–2 s). */
  readonly pollIntervalMs?: number;
}
```

Importing `MxTransport` `type`-only (erased under `verbatimModuleSyntax`) means the registry keeps `@mx-loom/
toolbelt` a **devDependency** and gains no runtime edge — identical to how `errors.ts` already imports
`TransportErrorCode`.

### 2. The invocation-state → envelope normalizer (`src/handlers/invocation.ts`)

The pure heart of T103 — fully unit-testable with fixtures, no I/O. It takes a raw `invocation.get` response and
returns a `ToolResult`, classifying the invocation into exactly one of the five statuses and building the
envelope **only** through the T102 helpers.

```ts
export type InvocationDisposition = 'running' | 'awaiting_approval' | 'ok' | 'denied' | 'error';

/** Classify the daemon's invocation state. Authored against the design's named
 *  states; pinned to the real v0.2.1 vocabulary at the two-daemon round-trip (OQ #3). */
export function classifyInvocation(raw: unknown): InvocationDisposition;

/** Map a raw `invocation.get` response onto a T102 envelope. Pure; never throws. */
export function invocationToResult(raw: unknown): ToolResult;
```

Mapping (design §4.2/§5; daemon vocabulary normalized like `mapDaemonError`, lowercased/underscored, with a safe
fallback):

| Daemon invocation state (named / observed) | `mx_await_result` returns |
|---|---|
| in-flight / executing / running / pending | `running(handle, audit_ref)` |
| held / awaiting_approval / approval_pending | `awaitingApproval(handle, approval, audit_ref)` |
| completed-ok / succeeded / done `{ result }` | `ok(result, audit_ref)` |
| denied-by-policy / approval-denied / approval-expired / untrusted | `denied(mapDaemonError(raw) ∩ denial-set, message, audit_ref)` |
| failed / errored / not-found / target-offline | `errored(mapDaemonError(raw) ∩ fault-set, message, audit_ref)` |
| **unrecognised state** | `errored('internal', 'unrecognised invocation state', audit_ref)` (safe fallback; never throws) |

Notes:
- **Reuse `mapDaemonError`** for terminal failures so the resolver never invents an ad-hoc code; choose
  `denied()` vs `errored()` by whether the mapped code is in the denial-set or fault-set (the partition is
  already exported). A terminal failure whose mapped code lands in the "wrong" set for the disposition is
  reconciled toward the daemon's authoritative outcome — document the precedence and pin it at the round-trip.
- **`approval` block** (`request_id`/`risk`/`summary`/`expires_at`) is read from the held invocation when
  present; all fields are operator-facing and secret-free. If the daemon does not surface every field, fill what
  it returns and leave the rest to the verified shape (OQ #4) — never fabricate a `risk`/`summary`.
- **`audit_ref`** (`invocation_id`/`request_id`/`room`/`event_id`) is read from the response; missing ids are
  `null` (T102 contract — never fabricated; OQ #5).
- The normalizer **echoes no raw daemon payload into `error.message`** — it builds messages from a fixed
  vocabulary + the (non-secret) code, per T102's secret-free rule.

### 3. The resolver + `wait_ms` poll loop (`src/handlers/await-result.ts`)

```ts
export interface AwaitResultInput {
  readonly handle: string;
  readonly wait_ms?: number;
}

/** Resolve a deferred handle to a terminal-or-still-pending ToolResult (T103). */
export async function mxAwaitResult(input: AwaitResultInput, deps: HandlerDeps): Promise<ToolResult>;
```

Algorithm:

1. **Probe once.** Call `deps.daemon.call('invocation.get', { invocation_id: input.handle })` (method/param name
   per OQ #2). On a transport rejection, map it: `errored(mapTransportError(err.code), …, audit_ref)` — but note
   a transport `timeout` here is a *genuine* fault → `error`/`timeout`, **distinct** from a `wait_ms` expiry
   (step 4).
2. **Classify** the response via `invocationToResult(raw)`.
3. **Terminal?** If the status is `ok` / `denied` / `error`, return it immediately. (AC 1: a `running` handle
   that has since completed returns its terminal envelope on the first probe.)
4. **Still pending (`running` / `awaiting_approval`)?**
   - If `wait_ms` is omitted or `0` ⇒ **return the pending envelope now** (single non-blocking probe).
   - If `wait_ms > 0` ⇒ enter the **poll loop**: compute `deadline = now() + wait_ms`; `sleep(interval)`
     (bounded `pollIntervalMs`, optionally backing off, never overshooting the deadline); re-probe; on a terminal
     classification return it (AC 1/AC 2 — `awaiting_approval` resolves to `ok`/`denied` after the operator
     decides and the daemon releases); on continued pending, loop while `now() < deadline`.
   - **At the deadline, still pending ⇒ return the last pending envelope** (`running` / `awaiting_approval`) —
     **`status` is the pending status, `error` is `null`** (AC 3: "returns the still-pending status without
     error"). The resolver never converts a `wait_ms` expiry into `error`/`timeout`.
5. **Each underlying `invocation.get`** uses a normal per-call transport timeout (`CallOptions.timeoutMs`, the
   client default 30 s), **independent of `wait_ms`**. A large `wait_ms` is realized as *many short reads*
   accumulating to the logical deadline — it does not stretch a single socket read. Document this so `wait_ms`
   is understood as a *logical resolution budget*, not a socket timeout.
6. **Server-side long-poll (optional optimization, OQ #3).** If the verified `invocation.get` accepts a blocking
   `wait_ms`/`timeout` param, the loop can pass a per-probe blocking budget (min of remaining `wait_ms` and a cap)
   and poll fewer times. Implement the client-side loop as the baseline (works regardless), and adopt long-poll
   only once verified.

**The `wait_ms`-expiry-vs-`timeout`-error distinction is the single most important behavior in T103** — call it
out in code comments and pin it with a dedicated test (Testing Plan).

### 4. Exports + docs

Barrel-export from `src/index.ts`: `mxAwaitResult`, `AwaitResultInput`, `HandlerDeps`/`DaemonCall`, and the pure
`invocationToResult`/`classifyInvocation` (useful to bindings + tests). Update `packages/registry/README.md` with
the deferred-result protocol: the `running`/`awaiting_approval` → terminal lifecycle, the `wait_ms` semantics
(including the timeout-is-not-an-error rule), and the injected-transport handler pattern T104–T108 follow.

## Affected Files / Packages / Modules

**New (in `packages/registry`, assuming Open Question #1 → option A):**
- `src/handlers/deps.ts` — `DaemonCall` / `HandlerDeps` (the injected daemon-call seam + clock seams; `type`-only
  `MxTransport` import).
- `src/handlers/invocation.ts` — `classifyInvocation` + `invocationToResult` (the pure state→envelope normalizer).
- `src/handlers/await-result.ts` — `mxAwaitResult` (the resolver + `wait_ms` poll loop).
- `src/handlers/index.ts` — handler barrel (re-exported from the package root).
- `test/handlers/await-result.test.ts`, `test/handlers/invocation.test.ts`, and a focused
  `test/handlers/await-result.wait.test.ts` for the `wait_ms` timing/timeout semantics (see *Testing Plan*).

**Modify (in `packages/registry`):**
- `src/index.ts` — export the resolver + the pure normalizer.
- `README.md` — document the deferred-result protocol + the handler pattern.
- `package.json` — likely **no change** (`@mx-loom/toolbelt` already a devDependency for the `type`-only import;
  `node:timers`/`Date` are built-in; no new runtime dep). Confirm during implementation; if option (A) is
  rejected for a new package (B), add the workspace package + its `dependencies` instead.

**Read for context (no change):** `src/descriptors/await-result.ts` (the descriptor the resolver backs),
`src/envelope.ts` (helpers), `src/errors.ts` (`mapDaemonError`/`mapTransportError` + the denial/fault partition),
`packages/toolbelt/src/transport.ts` + `src/client.ts` + `src/retry.ts` (the `MxTransport`/`MxClient` seam and the
`sleep`/`random` injection precedent), `docs/mx-agent-surface-v0.2.1.md` (`invocation.*` staging), design §4.2/
§4.3/§5/§6/§7.

**Downstream consumers (separate issues, not modified here):** T109 (MCP server surfaces `mx_await_result` and
`awaiting_approval`), T110 (Claude shim calls the resolver to hide the poll loop), T202 (ADK `LongRunning-
FunctionTool` resumes via the resolver), T108 (`mx_cancel` interacts with a handle), T302 (`task.watch` replaces
the poll backend).

## API / Interface Changes

**New public API of `@mx-loom/registry` (additive — no breaking changes):**
- `mxAwaitResult(input: AwaitResultInput, deps: HandlerDeps): Promise<ToolResult>` — the resolver.
- Types: `AwaitResultInput`, `HandlerDeps`, `DaemonCall`, `InvocationDisposition`.
- Pure helpers: `invocationToResult(raw): ToolResult`, `classifyInvocation(raw): InvocationDisposition`.

**Tool-descriptor surface:** **none.** `MX_AWAIT_RESULT` already exists (T101) with the correct input/output
schema; T103 adds behavior behind it and changes no descriptor.

**Result-envelope surface:** **none new.** T103 *produces* the existing T102 envelope; it adds no field or status
(the five statuses stay closed; no `cancelled` — that is T108).

**Daemon-RPC surface (Boundary B):** T103 **calls** `invocation.get` (read-only). It introduces no new RPC and
sends no new param shape beyond `{ invocation_id: handle }` (exact method/param name confirmed at the two-daemon
round-trip — Open Question #2). No mutating call, so no `idempotency_key`.

**CLI surface:** none. **`MxClient`/`CallOptions`/`MxTransport`:** **unchanged** — the resolver consumes the
existing `call()` seam; the per-probe timeout uses the existing `CallOptions.timeoutMs`.

## Data Model / Protocol Changes

- **No new envelope shape, status, or error code.** T103 reuses T102's `ToolResult`, the five-status set, and the
  closed nine-code taxonomy. The `wait_ms`-expiry result is an *ordinary* `running` / `awaiting_approval`
  envelope (`error: null`) — **not** a new "timed-out" status and **not** `error`/`timeout`.
- **New (internal) normalization:** the daemon-invocation-state → envelope-status mapping (`classifyInvocation`),
  analogous to T102's `mapDaemonError`. Authored against the design's named states; the exact v0.2.1 invocation
  vocabulary, the `invocation.get` method/param name, the `approval` block fields on a held invocation, and the
  `audit_ref` field availability are **pending the two-daemon round-trip** (Open Questions #2–#5).
- **`audit_ref`:** carried through from the `invocation.get` response per the T102 contract (missing ids `null`,
  never fabricated). No storage change (the Postgres mirror is T113).
- **Idempotency:** **none** — `mx_await_result` is a read verb; repeated `invocation.get` polls are naturally
  safe and carry no `idempotency_key`.

## Security & Compliance Considerations

`mx_await_result` is the model's window onto a pending remote action. Its security job is to surface *status and
correlation* as it polls — never to leak a secret and never to become an authority surface (design §4.3, §4.7,
§5, §6).

- **Approval is a status, never a grant — re-validated at release by the daemon.** AC 2 resolves
  `awaiting_approval` → `ok`/`denied`, but the resolver makes **no decision**: the operator decides
  out-of-process (approval dashboard / `approval.decide`, T403), and the **receiving daemon re-runs the full
  authorize pipeline (sig → trust → policy) at release** — so a stale approval cannot smuggle through if trust was
  revoked in the interim (design §5). The resolver only *observes* the resulting terminal state via
  `invocation.get`. There is no approve/deny/mutate field anywhere in its input or output; the model is **never**
  given a trust/policy/approval-mutation tool. Cognition produces nothing here but a *read* of state it cannot
  influence.
- **Secret boundary (Boundary A) untouched.** The resolved envelope crosses Boundary A toward the model carrying
  only status / result / `approval` summary / `audit_ref`. Matrix tokens, Ed25519 signing keys, provider keys,
  and `GH_TOKEN` never appear in it — they live only in the daemon, out-of-process. The registry/resolver spawns
  nothing, opens no socket itself, and reads no env var; the only daemon contact is the **injected** `MxClient`,
  which already enforces the deny-by-default env allowlist and inbound `redactSecrets` (T008) on every `call()`.
  The resolver adds no new path that could carry a credential.
- **Secret-free output — both the result and the messages.** `error.message` and `approval.summary` are built
  from a fixed vocabulary + the (non-secret) daemon/transport code, **never** by echoing a raw daemon payload.
  The success `result` is the daemon's tool payload, which the secret-free contract requires be credential-free;
  the toolbelt's inbound `redactSecrets` remains the defense-in-depth backstop on the injected client. The
  resolver introduces no field that carries a credential inbound or outbound, and rejects nothing the model sends
  except a malformed `handle` (which the binding has already schema-validated).
- **Out-of-process enforcement unchanged.** Trust (Ed25519 store), deny-by-default `policy.toml`, sandbox, and
  the human approval gate all execute on the **receiving** daemon. T103 only *names* their outcomes
  (`policy_denied`, `untrusted_key`, `approval_denied`, `approval_expired`) as it reads invocation state; it
  must **not** imply any enforcement, trust check, or approval happens in-runtime.
- **Audit correlation on every result.** The resolved envelope always carries `audit_ref`
  (`invocation_id`/`request_id`/`room`/`event_id`) so the app layer (T113) can tie "model polled X" ↔ "daemon
  invocation Y" ↔ "operator approved Z" to the signed Matrix events — without those ids being secret. Missing ids
  are `null`, never fabricated.
- **No resource-exhaustion via the poll loop.** The `wait_ms` loop is bounded by the caller's `wait_ms` *and* a
  minimum poll interval, so a model cannot make `mx_await_result` hammer the daemon. Per-probe transport timeouts
  remain in force; the loop never busy-waits.
- **Logging/redaction.** Diagnostics log only the (non-secret) `handle`, the disposition, the code, and the
  attempt/poll count — never params, raw daemon payloads, or `result` values. The injected client's redaction
  sink stays the single inbound chokepoint.

## Testing Plan

All tests are **pure unit tests** with a **fake `DaemonCall`** and an **injected clock** (no daemon/socket),
except the explicitly-staged two-daemon conformance items. The fake returns scripted `invocation.get` responses
per probe and records call counts; the injected `sleep`/`now` make the `wait_ms` timing deterministic.

**Invocation normalizer (`test/handlers/invocation.test.ts`):**
- `invocationToResult` maps each named daemon state → the correct envelope status and helper output: in-flight →
  `running`; held → `awaiting_approval` (with the `approval` block populated, secret-free); succeeded → `ok` with
  the payload; policy/approval denials → `denied` with the right denial-set code (via `mapDaemonError`); failures
  → `error` with the right fault-set code; **unrecognised state → `errored('internal', …)`** (never throws).
- Every output **validates against `ENVELOPE_SCHEMA`** (`validateEnvelope` → true) — the normalizer conforms by
  construction (it builds only through the T102 helpers).
- `audit_ref` carried through; missing ids render `null` (never fabricated). No raw daemon payload appears in
  `error.message`.

**Resolver — AC 1 (`test/handlers/await-result.test.ts`):**
- A handle whose first `invocation.get` is already terminal returns that terminal envelope on **one** probe (no
  sleep).
- A `running` handle that becomes terminal on the **k-th** probe returns the terminal envelope after exactly
  `k` probes (assert the fake's call count and that `sleep` was called `k−1` times).

**Resolver — AC 2 (`test/handlers/await-result.test.ts`):**
- An `awaiting_approval` handle that flips to **succeeded** after a scripted operator decision resolves to `ok`
  with the payload; one that flips to **denied** (`approval_denied`) resolves to `denied`. Assert the resolver
  issued no approval/decision call — only `invocation.get`.

**Resolver — AC 3, the timeout-is-not-an-error rule (`test/handlers/await-result.wait.test.ts`):**
- `wait_ms` omitted / `0` ⇒ exactly **one** probe, returns the pending envelope immediately (no sleep).
- `wait_ms > 0` with the invocation pending for the whole budget ⇒ returns the **pending** envelope
  (`status: running` or `awaiting_approval`, **`error: null`**) — **explicitly assert it is NOT
  `status: 'error'` / code `timeout`** (the AC-3 regression).
- A **transport** `timeout` (the injected `DaemonCall` rejects with `TransportError('timeout')`) ⇒
  `errored('timeout', …)` — proving the resolver distinguishes a *genuine fault* from a *`wait_ms` expiry*.
- Timing: with an injected clock, the loop stops at the `wait_ms` deadline (does not overshoot by more than one
  interval) and respects the minimum poll interval (does not busy-wait); a terminal state mid-budget returns
  early.

**Transport-fault mapping (`test/handlers/await-result.test.ts`):**
- Each `TransportErrorCode` the probe can reject with maps through `mapTransportError` to the expected envelope
  code (`connect_failed`/`closed`/… → `internal`, `timeout` → `timeout`); the resolver never leaks a
  `TransportError` to the caller (always returns a `ToolResult`).

**Security invariants (`test/handlers/await-result.security.test.ts`):**
- A scripted `invocation.get` response containing a token-shaped value in an unexpected field does not surface
  it: the resolver returns only envelope fields, and a round-trip through the toolbelt `redactSecrets` leaves the
  envelope unchanged (no `audit_ref`/`request_id` false-positive redaction). `mx_await_result` exposes no
  approve/deny/mutate field.

**Documentation:** a compile-checked README snippet (`await mxAwaitResult({ handle, wait_ms: 0 }, deps)` against a
trivial fake) so the public example cannot rot.

**Staged (two-daemon conformance — not in the unit gate):** once `MXL_CONFORMANCE_TWO_DAEMON=1` runs green,
extend the conformance suite to (a) pin the `invocation.get` method/param name and the invocation **state
vocabulary** `classifyInvocation` keys on; (b) confirm the held-invocation `approval` block fields and the
`audit_ref` field availability; (c) assert the **live** `running → ok` and **approval-gated** `awaiting_approval
→ ok | denied` lifecycles end-to-end (delegate via T105 → poll via `mx_await_result`), including a real `wait_ms`
expiry returning pending without error. Flag these as staged, not implied-live.

## Documentation Updates

- **`docs/backlog.md`** — tick T103's three ACs once landed; note that **T109** (MCP), **T110** (Claude shim),
  and **T202** (ADK long-running) are unblocked. Record the resolved decisions (handler home, the injected
  daemon-call seam, `wait_ms` = client-side poll-with-timeout, timeout-is-not-an-error).
- **`docs/mx-agent-tool-fabric-design.md`** — §4.3 already specifies the deferred protocol; add a short note that
  `mx_await_result` is now **implemented** in `@mx-loom/registry` (poll over `invocation.get`, `wait_ms`
  blocking-with-timeout, the timeout-returns-pending rule), and that `task.watch` remains the M3 (T302)
  push-based optimization. Do **not** imply the producing handlers (T105/T106), the bindings (T109/T110/T202), or
  the audit mirror (T113) exist yet.
- **`docs/mx-agent-surface-v0.2.1.md`** — once the two-daemon round-trip runs, record the **verified**
  `invocation.get` method/param name, the invocation state vocabulary, the held-invocation `approval` fields, and
  the `audit_ref` availability — closing Open Questions #2–#5 and flipping `invocation.*` from "documented" to
  verified.
- **`packages/registry/README.md`** — document the deferred-result protocol: the `running`/`awaiting_approval` →
  terminal lifecycle, the `wait_ms` semantics (single probe at 0; poll-with-timeout above; **timeout returns the
  pending envelope, not an error**), and the injected-transport handler pattern (the precedent T104–T108 follow).

## Risks and Open Questions

1. **Handler home — extend `@mx-loom/registry` (option A) vs. a new `@mx-loom/tools` package (B) vs. the toolbelt
   (C) (confirm; recommend A).** T103 sets the precedent for all M1 handlers. Option A matches the `area/registry`
   label and keeps the registry's zero **runtime** toolbelt dependency (transport injected, imported `type`-only),
   at the cost of expanding the registry's stated remit from "contract only — executes nothing" to "contract +
   handlers." Confirm the remit expansion, or choose B for cleaner separation.
2. **`invocation.get` method + param name (pending two-daemon round-trip).** `invocation.get` vs `invocation.show`;
   param `invocation_id` vs `handle` vs `id`. The design names `invocation.get`; the round-trip pins it. The
   resolver localizes this in one call site so the correction is one line.
3. **Invocation state vocabulary + whether `invocation.get` long-polls (pending round-trip).** The exact strings
   the v0.2.1 daemon returns for in-flight / held / succeeded / denied / failed, and whether `invocation.get`
   accepts a blocking `wait_ms`/`timeout` param (server-side long-poll) or must be client-side polled. Decision:
   author `classifyInvocation` against the design's named states with a safe `internal` fallback, and implement
   **client-side polling** as the baseline (works regardless); adopt server-side long-poll only once verified.
   Risk: a mis-mapped state degrades to `internal` until pinned — safe (never wrong-types), only less specific.
4. **The held-invocation `approval` block fields (pending round-trip).** Whether `invocation.get` on a held
   invocation returns the full `{ request_id, risk, summary, expires_at }`. Decision: populate what the daemon
   returns; never fabricate a `risk`/`summary`. Confirm at the round-trip.
5. **`audit_ref` field availability (pending round-trip; inherited from T102 OQ #4).** Whether `invocation.get`
   returns all four ids. Decision: always carry the `audit_ref` object; missing ids are `null`. Consider whether
   the session `correlation_id` (T005) belongs in `audit_ref` as a guaranteed-non-null handle — a T102/T113
   cross-cutting question, not resolved here.
6. **`wait_ms` upper bound / default poll interval (confirm).** The descriptor sets `minimum: 0` and no maximum.
   Decision: treat `wait_ms` as a *logical* budget realized as many short reads (each under the normal per-call
   transport timeout), with a minimum poll interval (~200 ms, optional backoff capped ~1–2 s) so a large
   `wait_ms` cannot hammer the daemon. Confirm whether to cap `wait_ms` at the binding layer.
7. **Terminal-failure disposition vs. mapped code (confirm precedence).** When the daemon reports a terminal
   failure, the disposition (`denied` vs `error`) follows whether `mapDaemonError(raw)` lands in the denial-set or
   the fault-set. Confirm the precedence when a daemon state label and its code disagree; pin at the round-trip.
8. **Re-entrancy / repeated polling (low risk).** `mx_await_result` is a read verb; multiple calls on the same
   handle are independent and safe (terminal states are stable). No idempotency key is needed or added. Flagged
   only to confirm no double-execution concern exists (there is none — the *mutating* call already ran via
   T105/T106).

## Implementation Checklist

1. **Read** design §4.3 (deferred protocol), §4.2 (envelope), §5 (approval-gated flow + re-validation at
   release), §6/§7 (security/audit); `docs/mx-agent-surface-v0.2.1.md` (`invocation.*` staging); the landed
   `@mx-loom/registry` (`descriptors/await-result.ts`, `envelope.ts`, `errors.ts`) and the toolbelt
   `transport.ts`/`client.ts`/`retry.ts`.
2. **Confirm the gated decisions first:** handler home (#1), and record that `invocation.get` method/param (#2),
   the state vocabulary + long-poll (#3), the `approval` fields (#4), and `audit_ref` availability (#5) are
   authored-against-design-now / pinned-at-round-trip. Record in `docs/backlog.md`.
3. **Add the daemon-call seam** (`src/handlers/deps.ts`): `DaemonCall = Pick<MxTransport,'call'>` (import
   `MxTransport` **`type`-only**), `HandlerDeps` (+ injected `sleep`/`now`/`pollIntervalMs`).
4. **Add the normalizer** (`src/handlers/invocation.ts`): `classifyInvocation` + `invocationToResult` — pure,
   builds envelopes only through the T102 helpers, reuses `mapDaemonError`, populates `approval`/`audit_ref`,
   `internal` fallback, never throws.
5. **Add the resolver** (`src/handlers/await-result.ts`): `mxAwaitResult` — probe → classify → return-if-terminal
   → `wait_ms` poll-with-timeout, where **a `wait_ms` expiry returns the pending envelope (`error: null`)** and a
   **transport `timeout` returns `errored('timeout', …)`**. Per-probe timeout independent of `wait_ms`.
6. **Export** `mxAwaitResult` + `AwaitResultInput`/`HandlerDeps`/`DaemonCall` + the pure
   `invocationToResult`/`classifyInvocation` from `src/index.ts` (via `src/handlers/index.ts`).
7. **Tests:** `invocation.test.ts` (normalizer per-state + schema-conformance + secret-free messages),
   `await-result.test.ts` (AC 1 running→terminal, AC 2 awaiting_approval→ok/denied, transport-fault mapping),
   `await-result.wait.test.ts` (**AC 3** — single probe at 0; pending-at-deadline returns pending **not** error;
   transport-timeout returns error; deterministic timing), `await-result.security.test.ts` (no secret surfaced,
   no authority field).
8. **Verify:** `pnpm -C packages/registry typecheck` clean (the `type`-only `MxTransport` import adds no runtime
   dep); `pnpm -C packages/registry test` green (no daemon); root build picks up the new modules.
9. **Docs:** tick T103 in `docs/backlog.md` (note T109/T110/T202 unblocked); add the "implemented" note to design
   §4.3; write the README deferred-result section (lifecycle + `wait_ms` + timeout-is-not-an-error + handler
   pattern).
10. **Stage the two-daemon conformance follow-ups** (pin `invocation.get` method/param + state vocabulary,
    confirm `approval` fields + `audit_ref`, assert live `running → ok` and `awaiting_approval → ok|denied` +
    real `wait_ms` expiry returns pending) behind `MXL_CONFORMANCE_TWO_DAEMON=1`; record the verified shapes in
    `docs/mx-agent-surface-v0.2.1.md`, closing Open Questions #2–#5.
11. **Confirm the remaining open questions** (#1 handler home, #6 `wait_ms` bound/interval, #7 terminal-failure
    precedence) with the maintainer before/alongside review, since #1 shapes where T104–T108 land too.
