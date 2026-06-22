# Toolbelt Session Model + Agent Registration (T005 / #5)

> Implementation spec for GitHub issue **#5 — T005 · toolbelt: session model + agent registration**.
> Labels: `area/toolbelt` · `priority/P0` · `type/feature`. Milestone **M0 — SDK seam**. Estimate **M**.
> Sources: [`docs/mx-agent-tool-fabric-design.md`](../docs/mx-agent-tool-fabric-design.md) (§1 boundary,
> §4 contract, §6 security, §7 *Sessions*, §8 MVP), [`docs/backlog.md`](../docs/backlog.md) (`T005`, and the
> T302/T501 items that depend on it), [`docs/mx-agent-surface-v0.2.1.md`](../docs/mx-agent-surface-v0.2.1.md)
> (verified `agent.register` / `agent.list` / `AgentState`), and the landed `packages/toolbelt` tree
> (T002 IPC client, T003 CLI fallback, **T004 unified `MxClient`** — the seam this builds on).
> Blocked-by **#4 (T004)** — satisfied: `MxClient` + `createClient` exist. **Unblocks T302** (`task.watch`
> resumption) and **T501** (tenant=room scoping), both of which build on the session handle.

## Problem Statement

T004 delivered the unified `MxClient` (`createClient()`): a single typed, transport-selecting client that
round-trips raw daemon RPC `result`s across **Boundary B**. But a client is *stateless* — it knows how to
reach the daemon, not *who* it is reaching as, in which workspace, or under what correlation identity.

Design §7 defines the missing layer:

> Define `MxSession = { agent_id, room/workspace, daemon socket, correlation_id }`. A runtime conversation
> maps **1:1** to an MX agent registration. The toolbelt holds the session handle and threads
> `correlation_id` onto every call so a cognitive session is reconstructable across delegations.
> Registration (`agent.register`) happens once at session start; heartbeats keep liveness.

Today none of this exists. Concretely:

- **No `agent.register` on start.** A runtime that wants to participate in the fabric is invisible — it never
  appears in `agent.list`, so no other agent can discover or delegate to it. There is no code that registers
  an agent or captures the returned `agent_id`.
- **No liveness/heartbeat.** `agent.list` reports a per-agent `liveness: "active" | "stale" | "offline"`
  derived from `last_seen_ts`, but nothing in the toolbelt refreshes that timestamp, so even a registered
  agent would decay to `stale`/`offline` while its runtime is alive and working.
- **No correlation threading.** Each `MxClient.call()` is anonymous; there is no session-stable
  `correlation_id` tying a cognitive session's many outbound calls (and the delegations they spawn) back to
  one reconstructable thread. Design §7's audit/correlation story (and the M1 `audit_ref`) has nothing to
  correlate against.
- **No lifecycle.** There is no "open a session → work → close it (deregister / let it go stale)" object, so
  the 1:1 conversation⇄registration invariant has no home, and downstream work that *depends* on a durable
  session handle — T302 (`task.watch` resume after a runtime restart) and T501 (tenant=room scoping) — has
  nothing to build on.

T005 closes this by adding an **`MxSession`** (plus an `openSession()` factory) layered **on top of**
`MxClient`: it registers an agent at start, runs a heartbeat that keeps liveness `active`, threads a
session-stable `correlation_id` onto every outbound call, and deregisters (or lets liveness go stale) on
close — without touching the secret boundary, the wire protocol, or the daemon's authority surface.

## Goals

- Ship an **`MxSession`** value object holding `{ agentId, room, correlationId, client }` and a lifecycle
  (`open → active → closing → closed`), with an `openSession(options)` factory mirroring T004's
  `createClient()` ergonomics.
- **Register on start.** `openSession()` calls `agent.register` exactly once through the underlying
  `MxClient`, captures the returned `AgentState.agent_id` (and `state_rev`/`last_seen_ts`), and exposes it as
  `session.agentId`. (Issue AC 1: opening a session registers an agent **visible via `agent.list`**.)
- **Heartbeat / liveness.** Run a bounded, cancellable heartbeat loop that refreshes the agent's
  `last_seen_ts` on an interval shorter than the daemon's staleness window, keeping `agent.list` liveness at
  `active` for the session's lifetime. (Issue AC 2.)
- **Thread `correlation_id`.** Generate one session-stable `correlation_id` and ensure **every outbound call
  the session issues is stamped with it** — emitted on the session's diagnostics seam for every call, and
  propagated into daemon params on the methods verified to accept it. (Issue AC 3.)
- **Deregister / decay on close.** `session.close()` stops the heartbeat and either calls a daemon deregister
  method (if one exists on v0.2.1 — to be confirmed) **or** simply stops heartbeating so liveness decays to
  `stale`/`offline`. (Issue AC 2, second clause.)
- **Compose with, not replace, `MxClient`.** Accept an injected client or build one from `createClient`
  options; never re-implement transport selection, retry, or the credential guard — reuse the T004 seam.
- **Preserve the secret boundary and the authority boundary** at the session layer (see *Security*): no
  secret crosses Boundary A; `agent.register`/heartbeat/deregister are coordination-plane **lifecycle**, never
  model-facing authority tools.
- **Export the new public surface** from `packages/toolbelt/src/index.ts` and document it.

## Non-Goals

- **Multi-tenant scoping (M5 / T501).** The `room` field is carried so T501 can scope sessions/tools/audit by
  tenant, but T005 does **not** implement tenant isolation, RLS, or cross-tenant denial. Single workspace,
  single tenant (design §8).
- **The canonical tool registry, the `mx_*` tools, and the model-facing result envelope** (M1: T101–T108).
  `agent.register` is **not** a model tool — it is session bootstrap the toolbelt runs, not a verb exposed to
  cognition. T005 stays at raw transport; it does **not** introduce
  `{status, result, error, handle, approval, audit_ref}`, `mx_await_result`, or the model-facing `error.code`
  set. The eventual `audit_ref` is where `correlation_id` ultimately lands for the model — but the envelope is
  T102, not here (see *Data Model*).
- **`task.watch` resumption (T302).** Reconstructing a cognitive session from durable task state after a
  runtime restart builds on this session handle but is its own issue. T005 provides the handle and the
  `correlation_id`; it does not subscribe to the task stream or restore state.
- **Idempotency-key plumbing (T102/T105).** `agent.register` is treated as an idempotent upsert keyed by the
  daemon's agent identity, so it is safe under T004's conservative retry without a client-supplied
  `idempotency_key`; threading explicit idempotency keys onto mutating calls is M1.
- **Spawning, supervising, or authenticating the daemon.** The session assumes a logged-in, running daemon
  (the surface doc's preconditions); it does not run `auth login`, create workspaces, or start a daemon.
- **Publishing the runtime's *own* served tools.** In M0 the runtime agent is a *consumer* (it delegates); the
  registration's `tools[]`/`capabilities[]` may be empty or minimal. Authoring a served-tool surface is later
  work.

## Relevant Repository Context

**Stack.** TypeScript (ESM, `"type": "module"`), pnpm workspace, Node ≥ 20.19, vitest 4.x, Apache-2.0. The
toolbelt is `@mx-loom/toolbelt` at `packages/toolbelt` (`private: true`, `version: 0.0.0`) with **zero
runtime dependencies** (only `@types/node`, `typescript`, `vitest` devDeps; `exports` maps `.` →
`./src/index.ts`). tsconfig is strict ES2022/nodenext (`strict`, `noUncheckedIndexedAccess`,
`verbatimModuleSyntax`, `isolatedModules`). T005 adds **no new runtime dependency** — registration/heartbeat/
correlation use only language built-ins plus `node:crypto` `randomUUID()` for the correlation id (Node core,
already permitted) and a timer for the heartbeat.

**The "repo is docs-only" caveat is stale for M0** — the M0 spine is well underway. Verified by reading the
source the session builds on:

- `packages/toolbelt/src/client.ts` — **the seam T005 builds on.** `MxClient implements MxTransport` with
  `call(method, params?, options?) → Promise<unknown>` (resolves the raw daemon RPC `result`), plus
  `status()` / `ping()` / `close()` and a read-only `activeTransport`. `createClient(options?)` is the factory
  all callers use. The constructor already hoists `assertNoCredentialShapedArgs(params)` so **every** call —
  including the `agent.register` the session will issue — is credential-scrubbed before dispatch on both
  transports.
- `packages/toolbelt/src/transport.ts` — `MxTransport` (`call`/`status`/`ping`/`close`), `CallOptions`
  (`{ timeoutMs? }`), and the transport-neutral `TransportError` / `TransportErrorCode` aliases. **Note:**
  `CallOptions` currently carries *only* `timeoutMs` — there is **no** existing channel for per-call metadata
  such as a correlation id; T005's threading must decide where the id rides (see *Proposed Implementation §3*).
- `packages/toolbelt/src/retry.ts` — `DEFAULT_RETRY_POLICY` (retries **`connect_failed` only** — provably
  pre-dispatch), `withRetry`, injected `sleep`/`random` for deterministic tests. T005's heartbeat reuses the
  same *inject-the-timer* discipline so its loop is testable without real waits.
- `packages/toolbelt/src/guards.ts` — `assertNoCredentialShapedArgs` + `CREDENTIAL_KEY_RE` /
  `CREDENTIAL_VALUE_RE` (hoisted in T004 so it runs on both transports). Registration/heartbeat params pass
  through it automatically because they go through `MxClient.call`.
- `packages/toolbelt/src/cli/method-map.ts` — pure `methodToArgv`: dotted RPC method → `mx-agent <noun>
  <verb> --json` argv; structured params go to the child's **stdin** via `--input-json -`, never argv. The
  doc-comment notes the default split rule already covers `agent.*`; **adding `agent.register` with structured
  params over the CLI leg is a table/verification concern flagged below**, not a rewrite.
- `packages/toolbelt/src/ipc/types.ts` — `DaemonStatus`. **There is no `AgentState` type yet** — T005 should
  add a typed `AgentState` (and the `agent.list` row shape `{ agent: AgentState, liveness }`) mirroring the
  fields the surface doc confirms.
- `packages/toolbelt/test/` — conventions T005 follows: pure unit tests with injected fakes
  (`client.unit.test.ts`, `retry.test.ts`), a fixture CLI (`test/fixtures/mock-mx-agent.mjs`), and
  **live integration tests gated** on `existsSync(socketPath)` / a `mx-agent --version` probe so CI skips
  cleanly without a daemon (`mxclient.integration.test.ts`).

**Verified daemon surface (`docs/mx-agent-surface-v0.2.1.md`, T001):**

- ✅ **`agent.register`** → returns the full `AgentState` (`com.mxagent.agent.v1`):
  `{agent_id, kind, matrix_user_id, device_id, signing_key_id, signing_public_key, status, capabilities[],
  tools[], workspace{cwd, project_id, git_commit}, load{running_invocations, max_invocations}, last_seen_ts,
  state_rev}` — matches design §2 field-for-field.
- ✅ **`agent.list`** → `[{ agent: AgentState, liveness: "active" | "stale" | "offline" }]`.
- ✅ **`workspace.status`** → `{room_id, …, members[…]}` (the `room`/workspace the session is scoped to).
- The daemon was verified logged in as `@mxloom:localhost` with `/sync` `healthy`; the signing key lives in
  the daemon, never the runtime.

**Does NOT exist yet (decisions to confirm, not assume):**

- **No session code at all.** No `MxSession`, `openSession`, heartbeat loop, correlation generator, or
  `AgentState` type — all net-new. Grep across the repo finds `MxSession`/`heartbeat`/`correlation`/
  `deregister` **only in design/backlog/surface docs and prior specs**, never in `src/`.
- **The `agent.register` input params are not enumerated in the surface doc** — only its *result* (`AgentState`)
  was recorded. The exact request shape (which of `kind` / `capabilities[]` / `tools[]` / `workspace` / a
  room/workspace selector are required vs. defaulted) **must be confirmed against a live v0.2.1 daemon**
  (a T001-style check) before finalizing the registration call. **Decision to confirm, not assume.**
- **No verified heartbeat / liveness-refresh RPC.** The surface doc confirms liveness is *reported* by
  `agent.list` (derived from `last_seen_ts`) but does **not** list any `agent.heartbeat` / `agent.touch` /
  `agent.refresh` method, nor does it state what refreshes `last_seen_ts` (a dedicated call? an idempotent
  re-`agent.register`? the daemon's own `/sync` activity?). **This is the single biggest open question for
  T005** — see *Risks*. The implementation must pick a refresh mechanism that is **verified to work on
  v0.2.1**, defaulting to the one method known-good (`agent.register` as an idempotent upsert) unless a
  dedicated method is confirmed.
- **No verified deregister RPC.** No `agent.deregister` / `agent.unregister` appears in the surface table.
  The AC's "deregisters **/ goes stale**" wording gives a safe fallback: if no deregister method exists, stop
  heartbeating and let liveness decay. **Confirm whether a deregister method exists.**
- **No per-call metadata channel.** As noted, `CallOptions` carries only `timeoutMs`; whether the daemon
  **accepts and propagates** a `correlation_id` (e.g. into the signed Matrix events so it survives across
  delegations) is **unverified**. T005 must guarantee toolbelt-side stamping regardless, and gate substrate
  propagation on verification (see *Proposed Implementation §3* and *Risks*).

## Proposed Implementation

Add session/lifecycle modules layered on the existing `MxClient`; change neither the wire protocol, the
transports, nor the daemon. Keep the heartbeat and correlation concerns in small, separately unit-testable
modules, mirroring how `retry.ts` was split from `client.ts`.

**New modules:**
- `packages/toolbelt/src/session.ts` — `MxSession`, `openSession`, `MxSessionOptions`, `SessionState`.
- `packages/toolbelt/src/heartbeat.ts` — the cancellable heartbeat loop (pure-ish; injected timer).
- `packages/toolbelt/src/correlation.ts` — `newCorrelationId()` + the rule for stamping a call.
- `packages/toolbelt/src/agent-state.ts` *(or fold into `ipc/types.ts`)* — the `AgentState` /
  `AgentListEntry` types from the verified surface.

### 1. Session shape and lifecycle

```ts
// src/session.ts
import type { MxClient, MxClientOptions } from './client.js';
import type { CallOptions } from './transport.js';
import type { AgentState } from './agent-state.js';

export type SessionState = 'opening' | 'active' | 'closing' | 'closed';

/** The runtime-conversation ⇄ agent-registration handle (design §7). */
export interface MxSession {
  /** Registered agent id, captured from `agent.register` → `AgentState.agent_id`. */
  readonly agentId: string;
  /** Workspace/room this session is scoped to (carried for T501; not enforced here). */
  readonly room: string | undefined;
  /** Session-stable correlation id, stamped on every outbound call. */
  readonly correlationId: string;
  /** Lifecycle state. */
  readonly state: SessionState;

  /** Issue a daemon RPC through the session — threads `correlation_id`, delegates to the client. */
  call(method: string, params?: unknown, options?: CallOptions): Promise<unknown>;
  /** Liveness of THIS agent as reported by `agent.list` (`active|stale|offline`), or `offline` if absent. */
  liveness(options?: CallOptions): Promise<'active' | 'stale' | 'offline'>;
  /** Stop the heartbeat and deregister (or let liveness decay). Idempotent. */
  close(): Promise<void>;
}

export interface MxSessionOptions {
  /** An existing client to use. If omitted, one is built from {@link clientOptions} via `createClient`. */
  client?: MxClient;
  /** Options for the client built when {@link client} is omitted. */
  clientOptions?: MxClientOptions;
  /** Whether `close()` also closes the client. Default: true when the session built the client, else false. */
  ownsClient?: boolean;

  /** Workspace/room to register into (forwarded to `agent.register` per the confirmed param shape). */
  room?: string;
  /** Agent kind, capabilities, served tools (M0: typically minimal/empty — the runtime is a consumer). */
  kind?: string;
  capabilities?: string[];
  tools?: unknown[];
  /** Workspace context `{cwd, project_id, git_commit}` if the confirmed register shape accepts it. */
  workspace?: { cwd?: string; project_id?: string; git_commit?: string };

  /** Pre-supplied correlation id (else a fresh `corr_<uuid>` is generated). */
  correlationId?: string;

  /** Heartbeat interval in ms. Default: a conservative value < the daemon staleness window (TBC — see Risks). */
  heartbeatIntervalMs?: number;
  /** Disable the heartbeat entirely (tests / one-shot sessions). Default: false. */
  heartbeat?: false;

  /** Injected timer + diagnostics (testing seam), mirroring `retry.ts`/`client.ts`. */
  setInterval?: (fn: () => void, ms: number) => { stop: () => void };
  debug?: (line: string) => void;
}

export async function openSession(options?: MxSessionOptions): Promise<MxSession>;
```

- `openSession()` (state `opening`): resolve/construct the `MxClient`; generate the `correlation_id`; build the
  **confirmed** `agent.register` params from `{room, kind, capabilities, tools, workspace}`; call
  `register` **through the session's own `call()`** (so the credential guard + correlation stamping apply);
  capture `AgentState`; store `agentId`; start the heartbeat (unless disabled); transition to `active`. A
  failed register rejects `openSession` with the underlying `TransportError` (no partial/zombie session; the
  heartbeat is never started).
- The session is the **single chokepoint** for outbound calls during its lifetime: callers use
  `session.call(...)` rather than the bare client, so correlation threading is automatic and uniform.

### 2. Heartbeat / liveness

```ts
// src/heartbeat.ts
export interface HeartbeatHandle { stop(): void; }

export interface HeartbeatOptions {
  intervalMs: number;
  /** One liveness-refresh tick. Resolves on success; rejects with TransportError on failure. */
  tick: () => Promise<void>;
  /** Injected scheduler (default: real setInterval wrapped to a stop() handle). */
  schedule?: (fn: () => void, ms: number) => { stop: () => void };
  /** Redaction-safe notification of tick outcomes (code/agentId/tick# only — never secrets). */
  onTick?: (outcome: 'ok' | { code: string }) => void;
}

export function startHeartbeat(opts: HeartbeatOptions): HeartbeatHandle;
```

- **What a tick does (gated on verification):** refresh `last_seen_ts` so `agent.list` keeps the agent
  `active`. **Default mechanism = idempotent re-`agent.register`** (the one method *verified* to succeed on
  v0.2.1; `state_rev` indicates a versioned upsert keyed by the daemon's agent identity, so re-registering is
  safe and non-duplicating). **If T001-style verification confirms a dedicated `agent.heartbeat`/`agent.touch`,
  prefer it** (cheaper, clearer intent). **If verification shows the daemon's own `/sync` keeps `last_seen_ts`
  fresh**, the toolbelt heartbeat degrades to a periodic liveness *poll* (`agent.list` self-check) — still
  satisfying the "keeps liveness active" AC, with the daemon doing the refresh. The chosen mechanism is a
  one-line swap behind `tick`.
- **Interval.** Must be shorter than the daemon's staleness threshold. That threshold is **not yet documented**
  — flag it (Risks) and default to a conservative value (e.g. 15 s) with a config override, to be tuned once
  the window is confirmed.
- **Failure handling.** A failing tick must **not** crash the process or reject an unhandled promise: catch,
  emit a redaction-safe `onTick({code})`, and continue — a transient miss may dip liveness to `stale` and the
  next success restores `active`. The tick goes through `session.call()`, so it inherits the client's
  conservative retry (retries only `connect_failed`).
- **Cancellation.** `close()` calls `stop()`; no tick fires after close. Use an injected scheduler so unit
  tests drive ticks deterministically (advance fake time) with no real waits, exactly as `retry.test.ts`
  injects `sleep`.

### 3. Correlation threading (AC 3 — "present on all outbound calls")

```ts
// src/correlation.ts
import { randomUUID } from 'node:crypto';
export function newCorrelationId(): string { return `corr_${randomUUID()}`; }
```

The honest constraint: `CallOptions` has no metadata slot today, and **whether the daemon accepts/propagates
a `correlation_id` on v0.2.1 is unverified**. So T005 guarantees the *toolbelt-side* invariant unconditionally
and gates *substrate* propagation on verification:

- **Always (M0-safe, no daemon dependency):** `session.call()` stamps **every** outbound call with the
  session `correlation_id` on the session's diagnostics/observability seam (the `debug` sink and the per-call
  context object the session builds). This satisfies "present on all outbound calls" at Boundary B — no call
  the session issues is un-correlated — and gives the M1 envelope/`audit_ref` (T102) and the Postgres audit
  mirror (T113) a stable key to attach. This is the part that must land in T005.
- **When confirmed accepted:** inject `correlation_id` into the daemon **params** for the methods verified to
  accept it (a small allowlist, default-empty until T001-style verification), e.g. as a reserved
  `correlation_id` / `_meta.correlation_id` sibling that does **not** collide with tool-arg schemas. This is
  what lets the id ride into the **signed Matrix events** so a session is reconstructable *across
  delegations* (design §7's actual intent). Until verified, leave this allowlist empty so we never trip a
  receiver-side arg-schema validation or have the credential guard inspect an unexpected shape.
- `correlation_id` is a **non-secret** random UUID; it is safe in logs, the model context, and the audit
  trail, and is never derived from any secret. (Contrast: it must *not* be confused with the daemon's
  `idempotency_key`/`nonce`, which are M1 and serve replay protection, not session correlation.)

### 4. Deregister / decay on close

`close()` (state `closing` → `closed`, idempotent):
1. `stop()` the heartbeat (no further ticks).
2. **If a deregister method is confirmed on v0.2.1** (e.g. `agent.deregister`/`agent.unregister`), call it
   through `session.call()` (correlation-stamped, credential-scrubbed). A failure here is logged, not thrown —
   close must always complete.
3. **Otherwise**, do nothing further: with heartbeats stopped, `last_seen_ts` ages out and `agent.list`
   liveness transitions `active → stale → offline` on its own. The AC's "deregisters **/ goes stale**"
   explicitly permits this decay path.
4. Close the underlying client **only if the session owns it** (`ownsClient`); an injected client is left open
   for its owner. Double-`close()` is a no-op.

A process crash (no clean `close`) naturally lands in path 3 — liveness decays — which is the intended
crash-recovery boundary (design §7: durable coordination state outlives an ephemeral runtime).

### 5. Exports + docs

Extend `src/index.ts` with `openSession`, `MxSession`, `MxSessionOptions`, `SessionState`, the heartbeat and
correlation helpers, and the `AgentState` / `AgentListEntry` types. Add a usage block to the package README —
the common path is `const s = await openSession(); /* … s.call(...) … */ await s.close();`.

## Affected Files / Packages / Modules

**New:**
- `packages/toolbelt/src/session.ts` — `MxSession`, `openSession`, options/state types.
- `packages/toolbelt/src/heartbeat.ts` — cancellable heartbeat loop (injected scheduler).
- `packages/toolbelt/src/correlation.ts` — `newCorrelationId` + stamping rule.
- `packages/toolbelt/src/agent-state.ts` — `AgentState`, `AgentListEntry` (or add to `src/ipc/types.ts`).
- `packages/toolbelt/test/session.unit.test.ts` — register-on-open, correlation stamping, close/deregister,
  ownership, lifecycle, all with an injected fake `MxClient`.
- `packages/toolbelt/test/heartbeat.test.ts` — tick scheduling, failure tolerance, cancellation (fake timer).
- `packages/toolbelt/test/correlation.test.ts` — id shape + non-collision + per-call stamping.
- `packages/toolbelt/test/session.integration.test.ts` — live `agent.register` → `agent.list` shows the agent
  `active` → `close()` → liveness goes `stale`/absent (gated like the existing integration suites; CLI leg via
  the mock fixture).

**Modify:**
- `packages/toolbelt/src/index.ts` — add the new public exports.
- `packages/toolbelt/src/ipc/types.ts` — *(if `AgentState` is colocated here rather than a new module)*.
- `packages/toolbelt/test/fixtures/mock-mx-agent.mjs` — extend to answer `agent register` / `agent list`
  (and a deregister verb if confirmed) so the CLI-leg integration test can drive registration deterministically.
- `packages/toolbelt/src/cli/method-map.ts` — only if `agent.register` needs a non-default argv/stdin mapping
  once its param shape is confirmed (the default split rule may already suffice).

**Read for context (no change):** `src/client.ts`, `src/transport.ts`, `src/retry.ts`, `src/guards.ts`,
`docs/mx-agent-surface-v0.2.1.md` (`agent.register`/`agent.list`/`AgentState`), design §7.

**Cross-repo / downstream (NOT in this repo):** mx-agency's `app/src/sdk` consumer (kortiene/mx-agency#37)
may later open one `MxSession` per conversation; T302/T501 build on this handle. Flagged, not performed here.

## API / Interface Changes

**New public API (additive — no breaking changes):**
- `openSession(options?): Promise<MxSession>` — the factory (mirrors `createClient`).
- `MxSession` — `{ agentId, room, correlationId, state, call(), liveness(), close() }`.
- Types: `MxSessionOptions`, `SessionState`, `HeartbeatHandle`/`HeartbeatOptions`, `AgentState`,
  `AgentListEntry`; helper `newCorrelationId()`.

**Unchanged:** `MxClient` / `createClient`, the `MxTransport` / `CallOptions` interface, the
`TransportError` / `TransportErrorCode` closed set, both transports, the CLI argv mapping (unless
`agent.register` needs a discrete mapping once its shape is confirmed), and the wire protocol. No new CLI
flags; **no new model-facing tools** (registration is lifecycle, not an `mx_*` verb).

**Daemon-RPC surface used (all pre-existing on the daemon):** `agent.register` (✅ verified),
`agent.list` (✅ verified), and — *gated on confirmation* — a heartbeat-refresh method and a deregister
method (see *Risks*). T005 adds no daemon RPC; it consumes existing ones.

## Data Model / Protocol Changes

**Largely none at the wire level; one additive, gated request field.**

- **Result envelope:** unchanged — `session.call()` resolves the raw daemon RPC `result` exactly as
  `MxClient.call()` does. The `{status, result, error, handle, approval, audit_ref}` envelope is **not**
  introduced here (M1 / T102). `audit_ref` — the field that will ultimately carry the session correlation to
  the model — is **not** added by T005; T005 only *produces* the `correlation_id` that the M1 envelope and the
  T113 Postgres mirror will key on.
- **Error taxonomy:** unchanged — reuses the existing closed `TransportErrorCode` set; the session introduces
  no new codes. (Register/heartbeat/deregister failures surface as ordinary `TransportError`s.)
- **New types (toolbelt-internal):** `AgentState`, `AgentListEntry` (`{agent, liveness}`) mirroring the
  verified `com.mxagent.agent.v1` shape; `SessionState`. These are TS types over already-existing daemon
  payloads, not protocol changes.
- **`correlation_id` placement (gated, additive):** when confirmed accepted, a reserved
  `correlation_id` / `_meta.correlation_id` sibling on outbound params for an allowlisted method set. Until
  verified, **no params are mutated** — the id lives only on the toolbelt's diagnostics/context seam. Either
  way it is a non-secret identifier.
- **Idempotency:** `agent.register` is relied on as an **idempotent upsert** (keyed by the daemon's agent
  identity; `state_rev` is the version), which is what makes both T004's `connect_failed` retry and the
  re-register heartbeat safe. No client-supplied `idempotency_key`/`nonce` is plumbed (M1).

## Security & Compliance Considerations

The session is now the chokepoint "all outbound calls" flow through, so it must **not weaken** the boundary
the lower layers enforce (design §6).

- **Secret boundary (Boundary A) holds, unchanged.** `MATRIX_*`, `MX_AGENT_*`, provider keys, and `GH_TOKEN`
  never cross into the runtime/model/CLI child. The session adds **no env surface**: it forwards only the
  non-secret `clientOptions` to `createClient`, and the CLI leg keeps re-deriving its deny-by-default
  `safeSubprocessEnv` internally. The session holds `agentId`, `room`, and `correlationId` — **all non-secret
  identifiers** — and **never** the Ed25519 signing key, Matrix tokens, or device secrets, which remain
  daemon-held (`AgentState` exposes only the *public* `signing_public_key`/`signing_key_id`, never private
  material; the session must not log or persist even those beyond ordinary identifiers).
- **Credential-shaped args are rejected on register/heartbeat/deregister too.** Because every session call
  goes through `MxClient.call`, the hoisted `assertNoCredentialShapedArgs(params)` runs on the
  `agent.register` params and every heartbeat tick — so a misconfigured registration carrying a
  credential-shaped key/value is rejected as `invalid_args` before dispatch, on both transports. The session
  must **not** bypass the client to call a transport directly.
- **`correlation_id` is non-secret and safe to surface.** It is a random UUID, never derived from a secret,
  and is intended to appear in logs, the model context, and the (M1) audit trail. It must **not** be conflated
  with the daemon's `idempotency_key`/`nonce` (replay protection), and must never carry encoded credentials.
- **Out-of-process enforcement is untouched; no authority is granted.** Trust (Ed25519 store), deny-by-default
  `policy.toml`, sandbox, and human approval gates all execute on the **receiving** mx-agent daemon. Opening a
  session is the runtime *asserting an identity the daemon already holds the key for* — **cognition can only
  produce a signed request; it can never grant itself authority.** Registration confers no trust: a freshly
  registered agent is still subject to every receiver's policy/trust, and surfaces as `untrusted_key` to peers
  until an operator approves it out-of-band.
- **No trust/policy/approval mutation surface, and registration is not a model tool.** T005 exposes
  lifecycle (`openSession`/`close`) + transport (`call`/`liveness`) only — **no** `trust.*` /
  `approval.decide` / `policy.*` / `auth.*` / `daemon.*` capability, and `agent.register` is **not** added to
  the model-facing `mx_*` set. The model never registers or deregisters itself; the toolbelt does it as
  session bootstrap/teardown. (Approval reaches the model only as an `awaiting_approval` *status* — an M1
  envelope concern, re-validated against live policy at release, not introduced here.)
- **Logging / redaction.** Session/heartbeat/correlation diagnostics carry **only** `agentId` (non-secret),
  `room`, `correlationId`, lifecycle state, the error `code`, and a tick counter — **never** params, env
  values, `AgentState` private-key-adjacent fields, tokens, or raw transport output. Never log or persist
  secrets or tokens.
- **Audit correlation (forward-looking).** The `correlation_id` minted here is precisely the key the M1
  `audit_ref` (T102) and the Postgres mirror (T113) use to tie "model decided X" ↔ "daemon executed Y" ↔
  "operator approved Z" across a session. T005 establishes the key; the envelope attaches it later.

## Testing Plan

**Unit — session (`session.unit.test.ts`, injected fake `MxClient` with scripted responses):**
- `openSession()` calls `agent.register` exactly once, captures `AgentState.agent_id` → `session.agentId`,
  transitions `opening → active`, and starts the heartbeat. *(AC 1.)*
- A failing `agent.register` rejects `openSession` with the underlying `TransportError`, starts **no**
  heartbeat, and leaves no half-open session.
- `session.call()` stamps the session `correlation_id` on **every** outbound call (assert via the injected
  client's recorded call-contexts / the `debug` sink), and the id is stable across many calls. *(AC 3.)*
- `close()` stops the heartbeat, performs deregister-or-decay, closes the client **only** when owned, and is
  idempotent (double-close is a no-op); no tick fires after close.
- Ownership: injected client is left open on close; self-built client is closed.
- `liveness()` maps the agent's `agent.list` row to `active|stale|offline`, and returns `offline` when the
  agent id is absent from the list.

**Unit — heartbeat (`heartbeat.test.ts`, injected fake scheduler / fake time, no real waits):**
- Ticks fire on the configured interval; `stop()` cancels and no further ticks run.
- A throwing/`rejecting` tick is swallowed (no unhandled rejection), reported via `onTick({code})`, and the
  loop continues to the next tick.
- `heartbeat: false` starts no loop.

**Unit — correlation (`correlation.test.ts`):**
- `newCorrelationId()` returns a `corr_`-prefixed, non-empty, collision-free id across many calls.
- A pre-supplied `correlationId` is used verbatim; every `session.call` carries the same id.

**Integration — live daemon (`session.integration.test.ts`, gated like the existing suites):**
- `openSession()` against a running daemon registers an agent **visible via `agent.list`** with
  `liveness: "active"`. *(AC 1.)*
- With the heartbeat running, repeated `agent.list` polls keep the agent `active` across more than one
  staleness interval. *(AC 2, first clause.)*
- After `close()` (deregister, if confirmed) **or** after stopping the heartbeat, `agent.list` shows the agent
  `stale`/`offline` or absent within the staleness window. *(AC 2, second clause.)*
- CLI-leg variant: force `transport: 'cli'` against the extended `mock-mx-agent.mjs` fixture to prove
  registration/heartbeat work on the fallback transport too.

**Secret-boundary / redaction:**
- An `agent.register` with a credential-shaped key (`api_key`, …) or a `gh_`/`syt_`/`xox*`-shaped value is
  rejected as `invalid_args` **before dispatch** (proves the guard runs on the register path), with the
  message naming only the key/path, never the value.
- A polluted parent env (`MATRIX_*`, `MX_AGENT_*`, fake provider key, fake `GH_TOKEN`) does **not** reach the
  CLI child during registration/heartbeat (reuse the T003 fixture env-dump pattern).
- Assert no session/heartbeat/correlation log line contains a param value, env value, token, or raw transport
  output — only the redaction-safe fields listed in *Security*.

**Documentation:** a compile-checked usage snippet (`openSession()` → `call()`/`liveness()` → `close()`) so
the public example cannot rot.

## Documentation Updates

- **`docs/backlog.md`** — tick T005's acceptance boxes once landed; note **T302** (`task.watch` resumption)
  and **T501** (tenant=room scoping) are unblocked. Record the resolved choices for the heartbeat-refresh
  mechanism, the deregister path, and the staleness/interval window.
- **`docs/mx-agent-surface-v0.2.1.md`** — **promote this from a spec open question to a verified fact:** after
  the T001-style check, record (a) the exact `agent.register` request param shape, (b) what refreshes
  `last_seen_ts` and the staleness threshold, (c) whether a dedicated heartbeat method exists, (d) whether a
  deregister method exists, and (e) whether the daemon accepts/propagates a `correlation_id`. These five
  confirmations are prerequisites the spec currently flags as gated.
- **`docs/mx-agent-tool-fabric-design.md`** — optional: a sentence in §7 noting `openSession()` is the session
  entry point, that registration is toolbelt-run lifecycle (not a model tool), and that `correlation_id` is
  stamped on every outbound call (with substrate propagation gated on daemon support). Do not imply the M1
  envelope/`audit_ref` exists yet.
- **`packages/toolbelt` README / module headers** — document the new public API (`openSession`, `MxSession`,
  the heartbeat/correlation helpers, `AgentState`), the 1:1 conversation⇄registration invariant, the heartbeat
  semantics, and the explicit note that close uses deregister-or-decay and that `correlation_id` substrate
  propagation is gated on daemon support.

## Risks and Open Questions

1. **Heartbeat-refresh mechanism is unverified (biggest open question; confirm).** The surface doc confirms
   `agent.list` *reports* liveness from `last_seen_ts` but does **not** record what *refreshes* it. The spec
   defaults to **idempotent re-`agent.register`** (the one verified-good method) but must confirm against a
   live v0.2.1 daemon whether (a) a dedicated `agent.heartbeat`/`agent.touch` exists (preferred), (b)
   re-register actually refreshes `last_seen_ts` without side effects, or (c) the daemon's own `/sync` keeps it
   fresh (making the toolbelt tick a poll). The chosen `tick` is a one-line swap, but the decision gates the
   AC-2 guarantee.
2. **Staleness threshold / heartbeat interval unknown (confirm).** The interval must be shorter than the
   daemon's `active → stale` window, which is undocumented. The spec defaults conservatively (e.g. 15 s) with
   an override; the real window must be recorded in the surface doc and the default tuned to it.
3. **`agent.register` request shape unverified (confirm).** Only the *result* (`AgentState`) was recorded by
   T001. Which of `room`/`kind`/`capabilities`/`tools`/`workspace` are required vs. defaulted — and whether a
   room/workspace selector is mandatory — must be confirmed before finalizing the register call and the CLI
   argv/stdin mapping.
4. **Deregister method may not exist (confirm; safe fallback).** If no `agent.deregister`/`agent.unregister`
   exists on v0.2.1, `close()` falls back to stop-heartbeat-and-decay (the AC permits "goes stale"). Confirm
   which path is real; prefer explicit deregister for prompt teardown if available.
5. **`correlation_id` substrate propagation is unverified (confirm).** Toolbelt-side stamping (the part T005
   guarantees) is daemon-independent, but the design's "reconstructable **across delegations**" intent
   requires the id to ride into the signed Matrix events — which needs daemon support. Confirm whether v0.2.1
   accepts a `correlation_id` (and where: a `_meta` sibling? on `call.start`/`exec.start` params?). Until
   confirmed, the param-injection allowlist stays empty and the id is toolbelt-local + audit-bound (M1).
6. **One registration per daemon vs. N per process (confirm; M0 scope).** Design §7 maps a conversation 1:1 to
   a registration, implying multiple concurrent sessions ⇒ multiple registrations. Whether a single
   (single-key) daemon supports N concurrent agent registrations with distinct `agent_id`s — and how their
   identities are distinguished — is unverified. **M0 scopes to one session/registration per client**;
   multi-session-per-daemon is flagged for confirmation (and intersects T501's multi-tenant work).
7. **Idempotency of re-register under retry (confirm).** The design relies on `agent.register` being an
   idempotent upsert (so T004's `connect_failed` retry and the re-register heartbeat don't create duplicates).
   `state_rev` strongly implies this, but confirm no duplicate-registration or churn side effect on repeat.
8. **Where `AgentState` lives.** Colocate in `src/ipc/types.ts` (next to `DaemonStatus`) or a new
   `src/agent-state.ts`? Minor; the spec proposes a dedicated module for cohesion, but either is fine —
   confirm the preferred convention.

## Implementation Checklist

1. **Read** `src/client.ts`, `src/transport.ts`, `src/retry.ts`, `src/guards.ts`,
   `docs/mx-agent-surface-v0.2.1.md` (`agent.register`/`agent.list`/`AgentState`), and design §7 to confirm
   the seam and the verified surface.
2. **Confirm the gated unknowns first (T001-style, against a live v0.2.1 daemon):** the `agent.register`
   request shape (#3), the heartbeat-refresh mechanism + staleness window (#1/#2), whether a deregister method
   exists (#4), and whether a `correlation_id` is accepted/propagated (#5). Record results in
   `docs/mx-agent-surface-v0.2.1.md`.
3. **Add types:** `AgentState` + `AgentListEntry` (`{agent, liveness}`) in `src/agent-state.ts`
   (or `src/ipc/types.ts`), mirroring the verified `com.mxagent.agent.v1` fields.
4. **Add `src/correlation.ts`:** `newCorrelationId()` (`corr_<randomUUID>`), and the rule that `session.call`
   stamps every outbound call (diagnostics/context always; params only for the confirmed-accepted allowlist,
   default empty).
5. **Add `src/heartbeat.ts`:** `startHeartbeat({intervalMs, tick, schedule, onTick})` — interval loop with an
   **injected scheduler**, swallow+report tick failures, `stop()` cancels cleanly, no tick after stop.
6. **Add `src/session.ts`:** `MxSession` + `openSession`.
   - Resolve/construct the `MxClient` (`ownsClient` accordingly); generate/accept `correlation_id`.
   - Build the **confirmed** `agent.register` params; call register via `session.call` (guard + correlation
     apply); capture `AgentState`; store `agentId`/`room`; transition to `active`.
   - Start the heartbeat (unless `heartbeat:false`) with `tick` = the confirmed refresh mechanism.
   - `call()`: stamp correlation, delegate to the client. `liveness()`: `agent.list` self-lookup →
     `active|stale|offline` (or `offline` if absent).
   - `close()`: stop heartbeat → deregister-or-decay → close client iff owned; idempotent.
7. **Extend `src/index.ts`:** export `openSession`, `MxSession`, `MxSessionOptions`, `SessionState`, the
   heartbeat/correlation helpers, and the `AgentState`/`AgentListEntry` types.
8. **Extend the fixture** `test/fixtures/mock-mx-agent.mjs` to answer `agent register` / `agent list`
   (+ deregister if confirmed) for the CLI-leg integration test.
9. **Tests:** add `session.unit.test.ts`, `heartbeat.test.ts`, `correlation.test.ts`, and the gated
   `session.integration.test.ts`; include the secret-boundary/redaction assertions (credential-shaped register
   arg rejected; polluted env not forwarded; no secret in logs).
10. **Verify:** `pnpm -C packages/toolbelt typecheck` clean; `pnpm -C packages/toolbelt test` green
    (integration tests skip cleanly without a daemon, run when one is up).
11. **Docs:** tick T005 in `docs/backlog.md` (note T302/T501 unblocked); record the five confirmed surface
    facts in `docs/mx-agent-surface-v0.2.1.md`; document the new public API + session/heartbeat/correlation
    semantics in the package README/headers.
12. **Confirm the open questions** (esp. #1 refresh mechanism, #3 register shape, #4 deregister, #5
    correlation propagation, #6 one-vs-N registrations) with the maintainer before or alongside review, since
    they shape the contract callers and downstream issues (T302/T501) depend on.
