# Toolbelt Unified Client behind the `app/src/sdk` Seam (T004 / #4)

> Implementation spec for GitHub issue **#4 — T004 · toolbelt: unified client behind the `app/src/sdk` seam (closes #37)**
> Labels: `area/toolbelt` · `priority/P0` · `type/feature`. Milestone **M0 — SDK seam**. Estimate **M**.
> Sources: [`docs/mx-agent-tool-fabric-design.md`](../docs/mx-agent-tool-fabric-design.md) (§1 boundary, §4 contract,
> §6 security, §8 MVP, §10 Phase 0), [`docs/backlog.md`](../docs/backlog.md) (`T004`, open questions #5/#6),
> [`docs/mx-agent-surface-v0.2.1.md`](../docs/mx-agent-surface-v0.2.1.md) (verified daemon surface),
> and the landed `packages/toolbelt` tree (T002 IPC client, T003 CLI fallback).
> Blocked-by **#2 (T002)** and **#3 (T003)** — both satisfied (see below). **Unblocks T005, T007, T008, and M1 (T101).**

## Problem Statement

mx-loom (the toolbelt / adaptation layer) reaches the mx-agent daemon across **Boundary B**. ADR-11 and the
design doc (§8, §10 Phase 0) mandate **two transports** — a framed Unix-socket JSON-RPC 2.0 IPC channel as
the *primary*, and a one-shot `mx-agent … --json` CLI invocation as the *fallback*. Those two transports now
exist as **standalone siblings**:

- **T002 / #2 — done.** `packages/toolbelt/src/ipc/` provides `IpcClient` (framed JSON-RPC over the Unix
  socket), the closed `IpcError` / `IpcErrorCode` taxonomy, the length-prefix framing codec, and socket-path
  resolution.
- **T003 / #3 — done.** `packages/toolbelt/src/cli/` provides `CliClient` (spawns `mx-agent … --json`,
  parses stdout, normalizes failures onto the *same* error codes), a deny-by-default `safeSubprocessEnv`,
  the pure `methodToArgv` mapping, and a pre-spawn credential-shaped-arg guard. A shared seam
  (`packages/toolbelt/src/transport.ts`) already declares the common `MxTransport` interface and re-exports
  `IpcError` as the transport-neutral `TransportError` / `TransportErrorCode`. **Both clients already
  implement `MxTransport`** — by deliberate design, so this task can hold either behind one type.

What is **missing** is the piece that ties them together for callers. Today the only thing a consumer can
do is instantiate `IpcClient` or `CliClient` directly and decide for itself which to use, when to fail over,
and whether to retry. The downstream consumer — mx-agency's `app/src/sdk` seam (`kortiene/mx-agency#37`) —
is described in the backlog as a **throwing stub** (a fail-loud placeholder). Until a unified client exists:

- there is **no single typed entry point** that "all callers use" (design §1: the toolbelt is "deliberately
  dumb and secret-free" but must still present one coherent surface to the runtime);
- **IPC→CLI failover is unspecified and unimplemented** — nothing falls back to the CLI when the socket is
  absent, which is acceptance criterion 2 of this issue;
- there is **no retry/backoff policy**, so transient connection faults surface as hard errors;
- the M0 exit criteria ("toolbelt round-trips `agent.register` / `agent.list` / `call.start` against a live
  daemon") cannot be demonstrated through one stable client that consumers can depend on; and
- **#37 cannot be closed**, because the seam mx-agency consumes has nothing real to call.

T004 closes this by adding a **`MxClient`** (plus a `createClient()` factory) that holds either underlying
transport behind the existing `MxTransport` interface, **selects** the transport (IPC primary, CLI fallback),
applies a **conservative, idempotency-safe retry/backoff policy**, and is exported from `@mx-loom/toolbelt`
as the single client all callers use. Removing the fail-loud stub itself happens in the **sibling
mx-agency repo** (it consumes the published package) — see *Risks and Open Questions*.

## Goals

- Ship a **`MxClient implements MxTransport`** — `call(method, params?, options?)` plus the `status()` /
  `ping()` conveniences and `close()` — that is the single typed client all callers use. (Issue AC 1:
  "`app/src/sdk` exports a working client (no throw).")
- Ship a **`createClient(options?)` factory** that constructs an `MxClient` with sensible defaults, so the
  common case is one call with no arguments.
- **Transport selection.** Default `transport: 'auto'` — prefer IPC, **fall back to the CLI when the socket
  is absent** (issue AC 2). Provide explicit `'ipc'` and `'cli'` overrides for callers that must pin one.
- **Retry/backoff policy.** A configurable `RetryPolicy` (bounded attempts, exponential backoff, jitter)
  applied **only to failures that provably did not execute the request** — see the safety rule below. Off or
  conservative by default; never silently re-executes a possibly-applied mutating call.
- **Preserve the shared error taxonomy.** Failures from either transport, and from the selector/retry layer,
  surface as `TransportError` with a code from the existing closed set, so callers branch identically
  regardless of which transport answered.
- **Preserve the secret boundary at the unified layer** — composing the two transports must not widen the
  env allowlist, leak secrets into argv, or weaken the credential-shaped-arg rejection; recommend hoisting
  the guard so it applies on **both** transports uniformly (see *Security*).
- **Export the new public surface** from `packages/toolbelt/src/index.ts` and document it.

## Non-Goals

- **The canonical tool registry, the model-facing result envelope, and the `mx_*` tools** (M1: T101–T108).
  T004 is still raw transport: `call()` resolves the daemon RPC `result` directly. It must **not** introduce
  the `{status, result, error, handle, approval, audit_ref}` envelope, the model-facing `error.code` set,
  `mx_await_result`, or `audit_ref` — those are T102/T103/M1. (`audit_ref` correlation is therefore *not*
  added here; see *Data Model*.)
- **The session model + `agent.register`** (T005 / #5). `MxSession`, heartbeats, and `correlation_id`
  threading build *on top of* this client; T004 stops at the transport-selection client.
- **The dedicated secret-boundary guard feature** (T008 / #8). T004 must not regress the boundary and
  *should* hoist the existing guard for cross-transport parity, but the exhaustive deny-list, inbound result
  redaction, and their dedicated tests are T008.
- **The conformance suite** (T007 / #7) and **the version-pin gate** (already T006, done). T004's tests
  exercise the client; the suite that *gates the pin* is T007.
- **Editing mx-agency's `app/src/sdk`** (deleting the throwing stub, re-exporting the client). That is a
  cross-repo change in `kortiene/mx-agency` and is outside this repo's tree — see *Risks*.
- **Idempotency-key plumbing.** The daemon supports `idempotency_key`/`nonce`, but threading it through the
  client is M1 (T102/T105). T004's retry policy is deliberately conservative *because* idempotency keys are
  not yet plumbed (see *Proposed Implementation*).
- **Spawning or supervising the daemon.** Failover chooses an *existing* transport; it never starts a daemon.

## Relevant Repository Context

**Stack.** TypeScript (ESM, `"type": "module"`), pnpm workspace, Node ≥ 20.19, vitest 4.x, Apache-2.0. The
toolbelt is `@mx-loom/toolbelt` at `packages/toolbelt`, currently `private: true`, `version: 0.0.0`, with
**zero runtime dependencies** (only `@types/node ^22.10`, `typescript ^5.9`, `vitest ^4.1` as devDeps;
`exports` maps `.` → `./src/index.ts`). T004 adds **no new runtime dependency** — selection, retry, and
backoff use only language built-ins (and, for the absent-socket fast path, `node:fs`/`node:net`, already used
elsewhere in the package). tsconfig is strict ES2022/nodenext (`strict`, `noUncheckedIndexedAccess`,
`verbatimModuleSyntax`, `isolatedModules`).

**The standing "repo is docs-only" caveat is stale for M0** — the toolbelt package is real and the M0 spine
is well underway. Verified by reading the source:

- `packages/toolbelt/src/transport.ts` — **the seam T004 builds on.** Declares `MxTransport`
  (`call` / `status` / `ping` / `close`) and `CallOptions` (`{ timeoutMs? }`), and re-exports
  `IpcError`→`TransportError`, `IpcErrorCode`→`TransportErrorCode`. The doc-comment explicitly names T004 as
  the consumer that "can hold either transport behind a single type and fail over IPC→CLI without callers
  branching."
- `packages/toolbelt/src/ipc/client.ts` — `IpcClient` (lazy persistent connection, id-correlated
  multiplexing, per-call timeout, `close()` fails all in-flight). **Maps connection faults to codes T004
  keys off:** `ENOENT`/`ECONNREFUSED` → `not_running`; other connect/write errors → `connect_failed`;
  no response in deadline → `timeout`; mid-flight close → `closed`; bad frame → `frame`; bad envelope →
  `protocol`; daemon error object → `rpc`.
- `packages/toolbelt/src/ipc/errors.ts` — the closed `IpcErrorCode` set:
  `not_running | connect_failed | timeout | closed | frame | protocol | rpc | invalid_args`. The source
  comment is explicit that **`invalid_args` is a CLI pre-flight code and "IPC never emits it"** — this is the
  exact gap the credential-guard hoist (below) closes for the IPC path.
- `packages/toolbelt/src/cli/client.ts` — `CliClient` (one-shot spawn, `--json` parse, bounded output
  capture, per-call timeout via SIGKILL). **Binary-not-found (`ENOENT`) maps to `not_running`** — the same
  meaning IPC gives an absent socket, *intentionally* so the selector treats "this transport can't reach the
  daemon" uniformly across both (see the `spawnErrorToTransport` comment); other spawn errors → `connect_failed`.
  Also hosts the recursive `assertNoCredentialShapedArgs` guard — `CREDENTIAL_KEY_RE`
  (`token|secret|password|passwd|api[_-]?key|signing[_-]?key|private[_-]?key|matrix_`) and `CREDENTIAL_VALUE_RE`
  (`^(?:gh[posru]_|github_pat_|syt_|xox[abprs]-)`) — which rejects credential-shaped **keys** and known
  credential **value** shapes as `invalid_args` before spawn, naming only the key/path (never the value); and
  `unwrapResult` (`--json` payload → RPC `result`). Default bin override is the mx-loom-namespaced
  `MXL_AGENT_BIN` (read from the parent env only, never forwarded to the child).
- `packages/toolbelt/src/cli/env.ts` — `safeSubprocessEnv` (deny-by-default allowlist; `ENV_DENY_PREFIXES`
  = `MATRIX_`/`MX_AGENT_`; `BASE_ENV_ALLOW`; no provider keys / `*_TOKEN` / `GH_TOKEN`).
- `packages/toolbelt/src/cli/method-map.ts` — pure `methodToArgv` (dotted method → noun/verb argv + stdin).
- `packages/toolbelt/src/ipc/{framing,socket-path,types}.ts` — the framing codec, `resolveSocketPath`
  (override wins → `$XDG_RUNTIME_DIR/mx-agent/daemon.sock` → `$TMPDIR/mx-agent/daemon.sock` on macOS), and
  `DaemonStatus`.
- `packages/toolbelt/src/index.ts` — current public surface (exports `IpcClient`, `CliClient`, `MxTransport`,
  `TransportError`, `resolveSocketPath`, `safeSubprocessEnv`, `methodToArgv`, framing, and their types).
  **T004 extends this file** with the new exports.
- `packages/toolbelt/test/` — established conventions: pure unit tests (`framing.test.ts`,
  `socket-path.test.ts`, `cli-env.test.ts`, `cli-method-map.test.ts`, `cli-client.test.ts`,
  `client.test.ts`), a fixture CLI (`test/fixtures/mock-mx-agent.mjs`) the CLI client tests drive via
  `cliBin`, and **live integration tests** (`client.integration.test.ts`, `cli-client.integration.test.ts`)
  **gated on `existsSync(socketPath)` / a `mx-agent --version` probe** so CI skips cleanly when no daemon is
  present.

**Does NOT exist yet (decisions to confirm, not assume):**

- **`app/src/sdk` does not exist in this repo.** A tree scan of `app/` returns nothing (there is no `app/`
  directory). The "`app/src/sdk` seam" named in the issue title is in the **sibling `kortiene/mx-agency` repo**
  (issue #37). Backlog open question **#5 (RESOLVED)** records the architecture: *mx-loom ships as a standalone
  published package; mx-agency consumes it behind its `app/src/sdk` seam.* So in **this** repo the deliverable
  is the unified `MxClient` exported from `@mx-loom/toolbelt`; the literal edits to `app/src/sdk` (delete the
  throwing stub, re-export the client) are a follow-up in mx-agency. This spec is explicit about that split so
  a coding agent does not hunt for a nonexistent `app/` tree here.
- No `MxClient`, `createClient`, transport selector, or retry policy module exists yet — this is net-new code.

## Proposed Implementation

Add one new module — `packages/toolbelt/src/client.ts` — exporting `MxClient` and `createClient`, plus a
small `packages/toolbelt/src/retry.ts` for the backoff policy (kept separate so it is unit-testable in
isolation). Wire both into `src/index.ts`. No changes to the wire protocol, the daemon, or the existing
transports' behavior (one *recommended* refactor: extract the credential guard — see *Security*).

### 1. Public interface

```ts
// src/client.ts
import type { MxTransport, CallOptions } from './transport.js';
import { TransportError } from './transport.js';
import type { DaemonStatus } from './ipc/types.js';
import type { RetryPolicy } from './retry.js';

/** Which transport(s) the unified client uses. */
export type TransportPreference =
  | 'auto'   // default: prefer IPC, fall back to CLI when the socket is absent
  | 'ipc'    // force the framed Unix-socket client; never spawn the CLI
  | 'cli';   // force the one-shot CLI; never open the socket

export interface MxClientOptions {
  /** Transport preference. Default: 'auto'. */
  transport?: TransportPreference;
  /** Explicit daemon socket path (forwarded to the IPC client / used by the fast-path probe). */
  socketPath?: string;
  /** mx-agent CLI bin override (forwarded to the CLI client; non-secret, e.g. tests' fixture). */
  cliBin?: string;
  /** Environment for socket/bin resolution + the CLI allowlist source. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Default per-call timeout in ms (forwarded to both transports). Default: 30_000. */
  defaultTimeoutMs?: number;
  /** Retry/backoff policy, or `false` to disable retries. Default: the conservative policy below. */
  retry?: RetryPolicy | false;
  /**
   * Injected transport factories (testing seam). Default: construct the real
   * IpcClient / CliClient. Lets unit tests substitute fakes with deterministic
   * failure codes without a socket or a subprocess.
   */
  ipcFactory?: (o: MxClientOptions) => MxTransport;
  cliFactory?: (o: MxClientOptions) => MxTransport;
}

export class MxClient implements MxTransport {
  constructor(options?: MxClientOptions);
  call(method: string, params?: unknown, options?: CallOptions): Promise<unknown>;
  status(options?: CallOptions): Promise<DaemonStatus>;
  ping(options?: CallOptions): Promise<unknown>;
  close(): Promise<void>;
  /** Read-only: which transport answered the most recent call ('ipc' | 'cli' | null). Observability only. */
  get activeTransport(): 'ipc' | 'cli' | null;
}

export function createClient(options?: MxClientOptions): MxClient;
```

`MxClient` **is** an `MxTransport`, so it is a drop-in for anything already typed against the seam, and the
M1 registry/binding layers build on it without re-plumbing.

### 2. Transport selection (`transport: 'auto'`)

The selector's job: prefer IPC, fall back to CLI **when the socket is absent**, and surface a clear combined
error when neither transport can reach the daemon.

- **Lazy construction.** Construct the IPC client on first use; construct the CLI client only if/when needed.
  `'ipc'` never constructs a CLI client; `'cli'` never opens a socket.
- **Fast-path absent-socket check (auto).** Before the first IPC attempt, if `existsSync(resolveSocketPath(...))`
  is false, **skip IPC entirely** and go straight to the CLI. This directly satisfies AC 2 ("falls back to
  CLI when the socket is absent") and avoids a guaranteed-failing connect. (Reuses `resolveSocketPath`.)
- **Failover trigger — `not_running` only.** If IPC *is* attempted and rejects with **`not_running`** (socket
  vanished between the probe and the call, or a stale socket file), fail over to the CLI. **Do not fail over
  on any other code.** `connect_failed`, `timeout`, `closed`, `frame`, `protocol`, and `rpc` all mean either
  the request may already have reached the daemon *or* the daemon gave a real answer; re-issuing them on the
  CLI risks double-execution or masks a genuine error. `not_running` is the one code that **provably means no
  request was dispatched** (the IPC client raises it only from the connect phase, before any byte is
  written). This is the core safety invariant of the selector.
- **Sticky selection.** Once a transport answers successfully, remember it (`activeTransport`) and prefer it
  for subsequent calls, re-probing only if it later returns `not_running`. Avoids re-running the absent-socket
  check on every call.
- **Both unreachable.** If the chosen path is CLI and the CLI also returns `not_running` (binary not found),
  reject with a single `TransportError('not_running', …)` whose message names *both* attempted transports
  (socket path + CLI bin) — never embedding any arg or env value.

### 3. Retry/backoff policy (`retry`)

A small, pure helper drives bounded retries with exponential backoff and jitter. **Safety first:** retrying a
call that *might already have executed* is a correctness/safety bug, and since `idempotency_key` is not
plumbed until M1, the **default policy retries only `connect_failed`** — a transport-present-but-unusable
fault raised during connection setup, before a request is dispatched. It explicitly does **not** retry
`timeout` (request was sent; the daemon may be executing it), `closed`, `rpc`, `protocol`, or `frame`.

```ts
// src/retry.ts
import type { TransportErrorCode } from './transport.js';

export interface RetryPolicy {
  /** Total attempts including the first. Default: 3. */
  maxAttempts: number;
  /** Base backoff in ms. Default: 50. */
  baseDelayMs: number;
  /** Backoff cap in ms. Default: 1_000. */
  maxDelayMs: number;
  /** Exponential factor. Default: 2. */
  factor: number;
  /** Apply full jitter to each delay. Default: true. */
  jitter: boolean;
  /**
   * Codes eligible for retry. Default: ['connect_failed'] — the only code that
   * is BOTH transient AND provably pre-dispatch. Callers that plumb an
   * idempotency_key later (M1) may widen this knowingly.
   */
  retryableCodes: readonly TransportErrorCode[];
}
```

- Backoff for attempt *n* (1-based): `min(maxDelayMs, baseDelayMs * factor**(n-1))`, then full jitter
  (`delay = random in [0, delay]`) when `jitter` is true. The waited delay is the only place `MxClient` needs
  a timer/`random`; inject both (a `sleep(ms)` and an optional `random()`), defaulting to real
  `setTimeout`/`Math.random`, so tests are deterministic without real waits.
- Retry and failover compose cleanly: per chosen transport, retry the `retryableCodes`; on a terminal
  `not_running` from IPC, hand off to the CLI (which then has its own retry budget). `retry: false` disables
  retries entirely (single attempt per transport).
- Retries are silent except for a redaction-safe debug log line (code + transport + attempt number only).

### 4. Result + error semantics (unchanged contract)

`call()` resolves the **raw daemon RPC `result`**, exactly as both underlying transports already do — no
envelope wrapping (that is T102). All failures are `TransportError` with a code from the existing closed set;
the selector/retry layer introduces **no new error codes**. `status()`/`ping()` delegate to `call()` so they
inherit selection + retry uniformly. This keeps the "interchangeable behind one transport interface" property
the seam was designed for.

### 5. Exports + docs

Extend `src/index.ts` with `MxClient`, `createClient`, and the `MxClientOptions` / `TransportPreference` /
`RetryPolicy` types. Add a short usage block to the package README/headers (the common path is
`const mx = createClient(); await mx.status();`).

## Affected Files / Packages / Modules

**New:**
- `packages/toolbelt/src/client.ts` — `MxClient` + `createClient` (selection + failover).
- `packages/toolbelt/src/retry.ts` — `RetryPolicy` + pure backoff/retry helper.
- `packages/toolbelt/test/client.unit.test.ts` — selection + failover + retry unit tests (injected fakes).
- `packages/toolbelt/test/retry.test.ts` — backoff schedule + jitter + eligibility unit tests.
- `packages/toolbelt/test/mxclient.integration.test.ts` — live-daemon round-trip + absent-socket→CLI failover
  (gated like the existing integration tests; drives `test/fixtures/mock-mx-agent.mjs` for the CLI leg).

**Modify:**
- `packages/toolbelt/src/index.ts` — add the new public exports.
- *(Recommended)* `packages/toolbelt/src/cli/client.ts` — extract `assertNoCredentialShapedArgs` (+ the two
  regexes) into a shared `src/guards.ts` so `MxClient` can apply it on both transports; CLI client imports it
  from there (behavior unchanged). See *Security*.
- *(Optional, if hoisting)* new `packages/toolbelt/src/guards.ts` + `packages/toolbelt/test/guards.test.ts`.

**Read for context (no change):** `src/transport.ts`, `src/ipc/client.ts`, `src/ipc/errors.ts`,
`src/ipc/socket-path.ts`, `src/cli/env.ts`, `src/cli/method-map.ts`, `docs/mx-agent-surface-v0.2.1.md`.

**Cross-repo follow-up (NOT in this repo):** `kortiene/mx-agency` `app/src/sdk` — replace the throwing stub
with a thin wrapper/re-export over `@mx-loom/toolbelt`'s `createClient`. Tracked under #37; flagged here, not
performed here.

## API / Interface Changes

**New public API (additive — no breaking changes):**
- `MxClient` (class, `implements MxTransport`) — `call` / `status` / `ping` / `close` / `activeTransport`.
- `createClient(options?)` — factory returning `MxClient`.
- Types: `MxClientOptions`, `TransportPreference` (`'auto' | 'ipc' | 'cli'`), `RetryPolicy`.

**Unchanged:** the `MxTransport` / `CallOptions` interface, the `TransportError` / `TransportErrorCode` set,
both transports' constructors and behavior, the daemon RPC surface, the CLI argv mapping, and the wire
protocol. No CLI flags, no daemon-RPC methods, and no tool descriptors are added (tools are M1).

## Data Model / Protocol Changes

**None.** T004 does not change the result-envelope shape (no envelope yet — raw RPC `result` passes through),
the error taxonomy (reuses the existing closed `TransportErrorCode` set), tool input/output schemas (no tools
yet), the `idempotency_key`/`nonce` handling (not plumbed until M1), the audit-row shape, or any
serialization. `audit_ref` is **not** added here (it is part of the M1 result envelope, T102). The retry
helper's `RetryPolicy` is a client-config type, not a protocol structure.

## Security & Compliance Considerations

The unified client is the surface "all callers use," so it must **not weaken** the boundary the two
transports already enforce (design §6; backlog T008).

- **Secret boundary (Boundary A) holds, unchanged.** `MATRIX_*`, `MX_AGENT_*`, provider keys, and `GH_TOKEN`
  must never cross into the runtime/model/CLI child. The CLI leg keeps spawning under the deny-by-default
  `safeSubprocessEnv` (`ENV_DENY_PREFIXES` = `MATRIX_`/`MX_AGENT_`; no `*_TOKEN`/`*_API_KEY`); the unified
  client **must not pass a widened env** to the CLI factory — it forwards only `env`/`cliBin`/`socketPath`/
  timeout, and the CLI client re-derives its allowlist internally. Composing the transports adds no new env
  surface.
- **Credential-shaped args — close the cross-transport gap.** Today the credential guard
  (`assertNoCredentialShapedArgs`) runs only inside `CliClient.call` (because argv is world-visible). On the
  IPC path it does **not** run (`errors.ts` is explicit: IPC "never emits `invalid_args`"). At the unified
  layer a credential could therefore ride an IPC-primary call unscrubbed. The design's secret-free contract
  (§4.7) is transport-independent. **Recommendation:** hoist the guard into a shared `src/guards.ts` and call
  it in `MxClient.call` **before dispatch to either transport**, so credential-shaped keys/values are rejected
  as `invalid_args` uniformly. (T008 then hardens the deny-list and adds inbound redaction; T004 must at
  minimum not regress.) This is a decision to confirm — see *Risks* — because it touches T008's territory.
- **Out-of-process enforcement is untouched.** Trust (Ed25519 store), deny-by-default `policy.toml`, sandbox,
  and human approval gates all execute on the **receiving mx-agent daemon**. The unified client only chooses
  *how* to reach the local daemon and *whether to retry a pre-dispatch fault*; it grants no authority. The
  governing rule stands: **cognition can only produce a signed request; it can never grant itself authority.**
- **No trust/policy/approval mutation surface.** T004 exposes only transport verbs (`call`/`status`/`ping`).
  It adds **no** `trust.*` / `approval.decide` / `policy.*` / `auth.*` / `daemon.*` capability, and the model
  is never handed any authority tool. (Approval reaches the model only as an `awaiting_approval` *status* —
  an M1 envelope concern, re-validated against live policy at release, not introduced here.)
- **Audit correlation.** `audit_ref` on every result is an M1 envelope field (T102); T004's raw `result`
  pass-through neither adds nor strips it. Flagged so the later envelope layer remains the single place it is
  attached.
- **Logging / redaction.** Selection, failover, and retry logs carry **only** the error `code`, the transport
  name, the socket path, the CLI bin name, and the attempt number — **never** params, env values, stdin,
  raw stdout/stderr, or any arg value. The combined "both transports unreachable" error names the socket
  path and bin name only. Never log or persist secrets or tokens.

## Testing Plan

**Unit — selection/failover (`client.unit.test.ts`, injected fake transports with scripted failure codes):**
- `auto` with socket present + healthy IPC → uses IPC, never constructs the CLI client.
- `auto` with **absent socket** (fast-path) → goes straight to CLI; returns the CLI result; IPC never
  attempted. *(AC 2.)*
- `auto`, socket present but IPC rejects `not_running` (stale socket) → fails over to CLI and succeeds.
- `auto`, IPC rejects `timeout` / `rpc` / `closed` / `connect_failed` → **does NOT fail over**; the error
  propagates (safety invariant — no double-dispatch).
- `transport: 'ipc'` → never spawns the CLI even when IPC fails. `transport: 'cli'` → never opens the socket.
- Both transports `not_running` → single combined `TransportError('not_running')` naming both paths; no secret
  in the message.
- `activeTransport` reflects the transport that answered; sticky preference reused on the next call.
- `status()`/`ping()` go through selection + retry like `call()`. `close()` releases whichever transport(s)
  were constructed (and only those).

**Unit — retry/backoff (`retry.test.ts`, injected `sleep`/`random`, no real waits):**
- Retries `connect_failed` up to `maxAttempts`, then surfaces the last error.
- Does **not** retry `timeout` / `rpc` / `closed` / `protocol` / `frame` (default policy).
- Backoff schedule matches `min(maxDelayMs, baseDelayMs*factor**(n-1))`; full jitter bounds delays to
  `[0, computed]` with the injected RNG; `jitter:false` is exact.
- `retry: false` → exactly one attempt per transport.
- Retry composes with failover: IPC `connect_failed` retried, then terminal `not_running` hands off to CLI.

**Integration — live daemon (`mxclient.integration.test.ts`, gated like the existing suites):**
- `createClient().status()` round-trips `daemon.status` → `DaemonStatus` against a running daemon (auto→IPC).
- **Absent-socket failover:** point `socketPath` at a nonexistent path and `cliBin` at
  `test/fixtures/mock-mx-agent.mjs`; assert `status()` returns the fixture's `DaemonStatus` via the CLI leg
  (proves AC 2 without needing the socket down globally).
- Cross-transport equivalence: `MxClient` forced `'ipc'` vs `'cli'` against the same live daemon resolve the
  same `daemon.status` shape (mirrors the existing T003 live equivalence test).

**Secret-boundary / redaction:**
- On the failover (CLI) path, a polluted parent env (`MATRIX_*`, `MX_AGENT_*`, fake provider key, fake
  `GH_TOKEN`) must not reach the child — assert via the fixture's env dump (reuse the T003 pattern).
- A credential-shaped arg (key like `api_key`, or a `gh_`/`syt_`/`xox*`-shaped value) is rejected as
  `invalid_args` **on both** `transport: 'ipc'` and `'cli'` when the guard is hoisted; the error message
  names only the key/path, never the value.
- Assert no selection/failover/retry log line contains a param value, env value, or raw stdout/stderr.

**Documentation:** a compile-checked usage snippet (`createClient()` → `status()`) so the public example
cannot rot.

## Documentation Updates

- **`docs/backlog.md`** — tick T004's acceptance boxes once landed; note T005/T007/T008/T101 are unblocked.
  If the credential-guard hoist is adopted, add a one-line cross-reference from T004 to T008 so the boundary
  ownership stays clear.
- **`docs/mx-agent-tool-fabric-design.md`** — optional: a sentence in §8/§10 noting the unified client is the
  single seam entry point (`createClient`), and that IPC→CLI failover triggers on `not_running` only. Do not
  imply the M1 envelope/tools exist.
- **`packages/toolbelt` README / module headers** — document the new public API (`MxClient`, `createClient`,
  `TransportPreference`, `RetryPolicy`) and the failover/retry semantics, including the explicit safety note
  that mutating calls are not auto-retried until idempotency keys land (M1).
- **mx-agency `#37` (cross-repo)** — note that `app/src/sdk` should now wrap/re-export
  `@mx-loom/toolbelt`'s `createClient`; the throwing stub is removed there, not here.

## Risks and Open Questions

1. **`app/src/sdk` is in a different repo (decision to confirm).** The issue title says "behind the
   `app/src/sdk` seam," but that path lives in `kortiene/mx-agency` (#37), not in mx-loom (backlog OQ #5,
   RESOLVED: mx-loom is a standalone package mx-agency consumes). **This spec delivers the unified client in
   `@mx-loom/toolbelt`** and treats the `app/src/sdk` stub removal as a cross-repo follow-up. Confirm that
   split is intended for this issue (vs. expecting the edit to happen here, which is impossible — no `app/`
   tree exists). Since the package is `private: true` / `version: 0.0.0`, also confirm whether mx-agency
   consumes it via workspace link, a published version, or a git/file dependency.
2. **Failover trigger = `not_running` only (recommended; confirm).** Restricting failover to the one provably
   pre-dispatch code is the safe default but means a daemon reachable only via the CLI *while the socket
   exists but is wedged* (e.g. a hung socket → `timeout`) will **not** auto-fail-over. That is deliberate (a
   `timeout` may mean the call is executing). Confirm this conservative stance vs. a more aggressive failover;
   the aggressive variant is only safe once `idempotency_key` is plumbed (M1).
3. **Conservative retry default (confirm).** Default retries `connect_failed` only. Read methods
   (`daemon.status`, `agent.list`, …) are idempotent and *could* safely retry on `timeout`, but the client
   has no method-safety classification in M0 and must not assume one. The method-safety table / idempotency-
   aware retry is deferred to M1 (T102/T105). Confirm the conservative default is acceptable for M0.
4. **Credential-guard hoist overlaps T008 (confirm scope).** Hoisting `assertNoCredentialShapedArgs` to apply
   on both transports closes a real IPC-path gap (`errors.ts` states IPC "never emits `invalid_args`"), but
   the dedicated secret-boundary guard is T008. Decide whether T004 hoists now (recommended — non-regression +
   cross-transport parity) or defers entirely to T008, leaving the IPC path temporarily unguarded.
5. **CLI `--json` output framing still partly unverified.** Per the T003 spec / `mx-agent-surface-v0.2.1.md`,
   the exact `--json` wrapper (bare `result` vs `{…, result}`) and per-verb stdin acceptance were not fully
   round-tripped for mutating verbs (the `unwrapResult` doc-comment flags this as its own open question).
   T004 inherits `unwrapResult`/`methodToArgv` as-is and adds no new assumption, but the cross-transport
   equivalence integration test should be run against a live daemon to confirm IPC and CLI resolve identically
   for the M0 read methods before this is relied on downstream.
6. **`activeTransport` observability surface.** Exposing which transport answered is useful for diagnostics
   but is mutable per-call state. Confirm a getter is sufficient (vs. an event/callback), and that it carries
   no security-sensitive detail (it does not — only `'ipc' | 'cli' | null`).

## Implementation Checklist

1. **Read** `src/transport.ts`, `src/ipc/client.ts`, `src/ipc/errors.ts`, `src/ipc/socket-path.ts`,
   `src/cli/client.ts`, `src/cli/env.ts`, `src/cli/method-map.ts`, and the existing tests to confirm the
   error-code contract and test conventions (gating, fixture usage).
2. **Add `src/retry.ts`:** the `RetryPolicy` type + a pure `withRetry(fn, policy, {sleep, random})` helper
   that retries only `retryableCodes`, applies `min(maxDelay, base*factor**(n-1))` backoff with optional full
   jitter, and surfaces the last `TransportError` after `maxAttempts`. Inject `sleep`/`random` (default real).
3. *(Recommended)* **Extract the credential guard:** move `assertNoCredentialShapedArgs` (+ `CREDENTIAL_KEY_RE`
   / `CREDENTIAL_VALUE_RE`) into `src/guards.ts`; update `src/cli/client.ts` to import it (no behavior change).
   Add `guards.test.ts`.
4. **Add `src/client.ts`:** `MxClient implements MxTransport` + `createClient`.
   - Constructor stores options; defaults `transport:'auto'`, `defaultTimeoutMs:30_000`, the conservative
     `RetryPolicy`. Lazily build transports via `ipcFactory`/`cliFactory` (default: real `IpcClient` /
     `CliClient`, forwarding `socketPath`/`cliBin`/`env`/`defaultTimeoutMs`).
   - `call()`: *(if guard hoisted)* assert no credential-shaped args; then select transport — `'ipc'`/`'cli'`
     force one; `'auto'` does the `existsSync(resolveSocketPath(...))` fast-path, else tries IPC and fails over
     to CLI **only on `not_running`**. Wrap each transport attempt in `withRetry`. Track `activeTransport`;
     make selection sticky; re-probe only on a later `not_running`.
   - `status()`/`ping()` delegate to `call()`. `close()` closes only constructed transports.
   - Combined "both unreachable" → one `TransportError('not_running', …)` naming socket path + CLI bin (no
     arg/env values). Redaction-safe debug logging (code/transport/attempt only).
5. **Extend `src/index.ts`:** export `MxClient`, `createClient`, and the `MxClientOptions` /
   `TransportPreference` / `RetryPolicy` types.
6. **Tests:** add `retry.test.ts`, `client.unit.test.ts` (selection/failover/safety with injected fakes),
   `mxclient.integration.test.ts` (live round-trip + absent-socket→CLI failover via the mock fixture,
   gated), the secret-boundary/redaction assertions, and the cross-transport equivalence test. *(If hoisted,
   `guards.test.ts`.)*
7. **Verify:** `pnpm -C packages/toolbelt typecheck` clean; `pnpm -C packages/toolbelt test` green (live
   integration tests skip cleanly without a daemon, run when one is up).
8. **Docs:** tick T004 in `docs/backlog.md` (note unblocked T005/T007/T008/T101); document the new public API
   + failover/retry safety semantics in the package README/headers; add the cross-repo note for mx-agency #37.
9. **Confirm the open questions** (esp. #1 cross-repo split, #2 failover trigger, #3 retry default, #4 guard
   hoist) with the maintainer before or alongside review, since they shape the contract callers depend on.
