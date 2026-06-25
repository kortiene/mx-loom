# `@mx-loom/toolbelt`

The mx-loom **adaptation layer** between agent runtimes and the mx-agent
coordination daemon (Boundary B). It is deliberately *dumb and secret-free*: it
speaks framed JSON-RPC 2.0 to the daemon and resolves raw RPC results to
callers. All trust, policy, signing, and approval stay **out-of-process** in the
daemon — this package only translates and selects a transport.

> Scope today: M0 — the SDK seam. The model-facing result envelope
> (`{status, result, error, …}`), the `mx_*` tools, and `audit_ref` are M1.

## Transports

Two transports, both implementing the single `MxTransport` interface:

- **`IpcClient`** (T002) — the **primary**: a framed Unix-socket JSON-RPC client
  (one persistent connection, id-correlated multiplexing, per-call timeouts).
- **`CliClient`** (T003) — the **fallback**: a one-shot `mx-agent … --json`
  subprocess under a deny-by-default env allowlist.

Both normalize failures onto one closed error set (`TransportError` /
`TransportErrorCode`): `not_running | connect_failed | timeout | closed | frame |
protocol | rpc | invalid_args`.

## Unified client (T004)

`MxClient` (and the `createClient()` factory) is the **single typed client all
callers use**. It holds either transport behind `MxTransport`, selects between
them, and applies a conservative retry policy.

```ts
import { createClient } from '@mx-loom/toolbelt';

const mx = createClient(); // transport: 'auto'
const status = await mx.status(); // round-trips daemon.status
// …
await mx.close();
```

`MxClient` *is* an `MxTransport`, so it is a drop-in anywhere the seam is already
typed, and the M1 registry/binding layers build on it without re-plumbing.

### Transport selection — `transport: 'auto'` (default)

1. **Absent-socket fast-path.** If the daemon socket file is absent, skip IPC
   entirely and go straight to the CLI (avoids a guaranteed-failing connect).
2. **`not_running`-only failover.** If IPC *is* attempted and rejects with
   **`not_running`**, fail over to the CLI. **No other code fails over** — see
   the safety note below.
3. **Sticky.** Once a transport answers, it is preferred for later calls;
   re-selection happens only if it later returns `not_running`.
4. **Both unreachable.** A single `TransportError('not_running')` whose message
   names both attempted paths (socket path + CLI bin) — never any arg or env
   value.

Pin a transport with `transport: 'ipc'` (never spawns the CLI) or
`transport: 'cli'` (never opens the socket).

### Retry / backoff — and the safety invariant

The default `RetryPolicy` retries **only `connect_failed`** — the one code that
is both transient *and* provably **pre-dispatch** (raised during connection
setup, before any request is sent). It deliberately does **not** retry `timeout`
(the request was sent; the daemon may be executing it), `rpc`, `closed`,
`protocol`, or `frame`.

> **Mutating calls are not auto-retried.** Because `idempotency_key` is not
> plumbed until M1 (T102/T105), the client cannot tell a read from a mutation,
> so it never re-issues a call that *might already have executed*. Callers that
> plumb an idempotency key later may widen `retryableCodes` knowingly. Set
> `retry: false` to disable retries entirely.

Likewise, IPC→CLI failover triggers on `not_running` *only* for the same reason:
re-issuing any other failure on the CLI could double-execute a mutating call.

### Secret boundary (Boundary A · T008)

The unified layer does **not** weaken the boundary the transports enforce. "No
secret crosses Boundary A" — `MATRIX_*`, `MX_AGENT_*`, the Ed25519 **private**
signing key, provider API keys, and `GH_TOKEN` never reach the runtime process,
the model context, or the CLI child. The toolbelt is the chokepoint, enforcing
this on three edges:

- **Outbound — reject credential-shaped args.** `assertNoCredentialShapedArgs`
  (`src/guards.ts`) runs **before dispatch to either transport**, so a
  credential-shaped key/value is rejected as `invalid_args` uniformly on IPC and
  CLI alike. The deny-list covers the allowlisted-secret shapes the rule names:
  credential **keys** (`secret` / `password` / `*api[_-]?key` / `signing[_-]?key`
  / `private[_-]?key` / `matrix_*` / `mx_agent_*` / `gh_token` / a **boundaried**
  `token` — so `GH_TOKEN` / `access_token` reject while pass-through count keys
  like `max_tokens` / `token_count` pass), and credential **value** prefixes
  (GitHub / Matrix / Slack tokens, `sk-ant-`, length-bounded OpenAI `sk-`, AWS
  `AKIA…`, PEM private-key headers). Error messages name only the key/path,
  never the value.
- **Env edge — deny-by-default allowlist `extraAllow` cannot widen.** The CLI leg
  always spawns under `safeSubprocessEnv`: `MATRIX_*` / `MX_AGENT_*` are dropped,
  and any known-secret-shaped name — suffix `_TOKEN` / `_API_KEY` / `_SECRET` /
  `_ACCESS_KEY` or exact `GH_TOKEN` — is denied **even when passed via
  `extraAllow`**, so a caller can never re-admit a known secret into a tool
  payload or the child env. The toolbelt's own non-secret `MXL_*` namespace
  (e.g. `MXL_AGENT_BIN`) stays forwardable.
- **Inbound — redact secret-shaped values from results (defense-in-depth).**
  `redactSecrets` runs on every `MxClient.call` resolved result, replacing any
  **known secret-shaped value** (the same value-shape set, **never** by key name)
  with the fixed, non-reversible placeholder `«redacted»` before the result
  returns toward the model context. This is a **backstop, not the boundary**: the
  daemon owns secrets out-of-process and must never return one (the conformance
  Tier 1 secret-boundary assertion is the contract). Redaction guarantees that
  *even if* a daemon bug leaked a token-shaped value, it cannot reach the model.

Diagnostics carry only the error code, transport name, socket path, CLI bin
name, attempt number, and (for a redaction) the method + result path — never
params, env values, raw output, or the secret value itself.

## Sessions + agent registration (T005)

`MxSession` (via the `openSession()` factory) is the runtime-conversation ⇄
agent-registration handle (design §7), layered **on top of** `MxClient`. A
runtime conversation maps **1:1** to an MX agent registration.

```ts
import { openSession } from '@mx-loom/toolbelt';

const s = await openSession(); // builds a client, calls agent.register, starts the heartbeat
s.agentId; // captured AgentState.agent_id — the agent is now visible via agent.list
await s.call('agent.list'); // correlation-stamped + credential-guarded
await s.close(); // stops the heartbeat; deregisters or lets liveness decay
```

What it does — and only this; it changes neither the wire protocol, the
transports, nor the daemon:

- **Registers on start.** `openSession()` calls `agent.register` exactly once
  through the client, captures the full `AgentState`, and exposes `agentId` /
  `agentState`. A failed register rejects (no half-open session; a self-built
  client is closed) and starts no heartbeat.
- **Keeps liveness `active`.** A cancellable heartbeat refreshes `last_seen_ts`
  on `heartbeatIntervalMs` (default `15_000`). A failing tick is swallowed and
  reported — it never crashes the process; the next success restores `active`.
- **Threads a `correlation_id`.** One session-stable `corr_<uuid>` is stamped on
  the diagnostics seam of **every** outbound call (`session.call`). Injecting it
  into daemon *params* (so it rides into the signed Matrix events across
  delegations) is **gated on daemon support** — enabled only for methods listed
  in `correlationParamMethods` (default empty).
- **Deregister-or-decay on close.** `close()` is idempotent: it stops the
  heartbeat, calls `deregisterMethod` if one is configured (failures are logged,
  not thrown), otherwise lets liveness decay to `stale`/`offline`, and closes the
  client only if the session owns it. A process crash lands in the decay path.

It composes the lower layers rather than weakening them: every call goes through
`client.call`, so `assertNoCredentialShapedArgs` runs on `agent.register` and
every heartbeat tick, and no env surface is added. Registration is toolbelt-run
**lifecycle** — never a model-facing `mx_*` authority tool.

> **Gated defaults (verified-safe; each a one-line swap once a live v0.2.1 check
> confirms the surface).** Heartbeat refresh defaults to idempotent
> re-`agent.register` (`state_rev` implies a versioned upsert); set
> `heartbeatMethod` if a dedicated `agent.heartbeat` is confirmed. Deregister
> defaults to decay (no method); set `deregisterMethod` once a deregister RPC is
> confirmed. Correlation param propagation defaults off.

## Crash-recovery resumption (T302)

The crash-recovery boundary is the **durable task DAG** (design §7). When a
runtime dies, its *ephemeral cognition state* (scratchpad, conversation,
retrieved knowledge) is runtime-private and **lost**; the *durable coordination
state* — the signed task plan of record — survives on the substrate. So "a
runtime can die and a new one resumes from task state" needs exactly one
non-secret record to cross the restart boundary, plus a way to re-read the plan.

```ts
import { openSession, serializeSessionDescriptor, resumeSession, watchTasks } from '@mx-loom/toolbelt';

// --- before a planned shutdown / crash: persist a NON-SECRET descriptor ---
const runtimeConfig = { kind: 'runtime', maxInvocations: 10 }; // the runtime's own startup config
const s = await openSession({ room, ...runtimeConfig });
const descriptor = s.describe();                 // { v, agent_id, room, correlation_id, kind?, cursor? }
host.persist(serializeSessionDescriptor(descriptor)); // disk / app store / env — the host's call (no secret)

// --- after the restart: re-establish the session + reconstruct the plan ---
// Re-supply the runtime's registration config (`max_invocations` is required by
// agent.register on v0.2.1) — it is static deployment config, not session state, so it
// rides ResumeOptions rather than the descriptor.
const { session, plan, resumed } = await resumeSession(descriptor, runtimeConfig);
plan.reconciliation;  // { done, inFlight, ready, blocked } — where the dead runtime left off
plan.tasks; plan.edges; plan.cursor;             // the durable plan view + a resumption cursor
// `resumed` is true iff the daemon re-issued the same agent_id; else room-keyed recovery.

// --- stay in sync: subscribe to the task stream (poll fallback by default) ---
const watcher = watchTasks(session, { cursor: plan.cursor });
for await (const { task, cursor } of watcher) {
  /* react to a task-state change; persist `cursor` for the next restart */
  if (allDone) watcher.stop();
}
```

What it does — and only this; it **re-reads** state and never re-dispatches:

- **`SessionDescriptor` — the non-secret resume handle.** Carries only
  `agent_id` / `room` / `correlation_id` / `kind` / a task `cursor` — **never** a
  Matrix token, Ed25519 key, device secret, provider key, or `GH_TOKEN`.
  `serialize` / `parse` (and `MxSession.describe()`) route the record through
  `assertNoCredentialShapedArgs` on both write and read, so a poisoned field is
  rejected as `invalid_args`; an unknown `v` fails closed.
- **`resumeSession(descriptor, options?)` — re-establish + reconstruct.**
  Re-registers via the **idempotent** re-`agent.register` upsert (same room +
  persisted `correlation_id`, so audit spans the restart), then reconstructs the
  durable plan. The runtime's own registration config — `maxInvocations`
  (**required by `agent.register` on v0.2.1**), `capabilities`, `tools`,
  `workspace`, and a `kind` override — is supplied via `ResumeOptions`, not the
  descriptor: it is static deployment config the runtime re-derives on every
  startup, not session state. A failed re-register rejects with no half-open
  session; a `task.list` fault yields an **empty-but-valid** `PlanSnapshot`
  carrying a `fault` code (degrade to "no plan recovered", never re-crash).
- **`PlanSnapshot` + reconciliation.** The non-secret `ResumedTask` nodes, derived
  edges, a resumption cursor, and a **pure** done/in-flight/ready/blocked
  classification. `inFlight` (`executing`/`assigned`) tasks are **observed, not
  restarted** — their work is durable on the receiving daemon; re-dispatch is
  T303.
- **`watchTasks(session)` — subscribe to the task stream.** Emits non-secret
  `TaskDelta`s as tasks change. The default backend is the **poll fallback** (a
  clamped re-`task.list` on an injected schedule, cursor/signature-deduped); the
  push `task.watch` backend is a **one-const swap** (`taskWatchMethod`) once that
  surface is verified, with the poll as gap recovery. Like the heartbeat, the
  watcher is lifecycle — never a model-facing `mx_*` verb, never throws to the
  consumer.

> **Gated (verified-safe).** `task.watch` is **not** a verified v0.2.1 surface, so
> the AC is satisfied on the landed `task.list` poll surface and the push backend
> stays gated until pinned. The cursor token shape, the task-id field name, and
> in-flight durability across a requester restart are pending the two-daemon
> round-trip (localized consts); the **multi-agent** kill-mid-plan gate is T304.

## Public API

| Export | Kind | Notes |
|---|---|---|
| `createClient(options?)` | factory | returns an `MxClient` with auto defaults |
| `MxClient` | class (`implements MxTransport`) | `call` / `status` / `ping` / `close` / `activeTransport` |
| `MxClientOptions` | type | `transport`, `socketPath`, `cliBin`, `env`, `defaultTimeoutMs`, `retry`, factories (testing seam) |
| `TransportPreference` | type | `'auto' \| 'ipc' \| 'cli'` |
| `RetryPolicy`, `DEFAULT_RETRY_POLICY`, `withRetry`, `backoffDelay` | retry primitives | conservative, pre-dispatch-only by default |
| `openSession(options?)` | factory | registers an agent, returns an active `MxSession` |
| `MxSession` | interface | `agentId` / `agentState` / `room` / `correlationId` / `state` / `call` / `liveness` / `describe` / `close` |
| `resumeSession(descriptor, options?)` | factory | re-establish a session + reconstruct the plan after a restart → `{ session, plan, resumed }` (T302); `options` re-supplies the runtime's register config (`maxInvocations` (required on v0.2.1), `capabilities`, `tools`, `workspace`, `kind`) |
| `watchTasks(session, options?)` | factory | subscribe to the task stream → `TaskWatcher` (poll fallback; `task.watch` push gated) |
| `SessionDescriptor`, `TaskCursor`, `serializeSessionDescriptor`, `parseSessionDescriptor`, `assertSessionDescriptor`, `SESSION_DESCRIPTOR_VERSION` | resume handle | the non-secret persisted descriptor + (de)serialize routed through the credential guard |
| `ResumedTask`, `ResumedTaskState`, `PlanEdge`, `PlanReconciliation`, `PlanSnapshot`, `reconstructPlan`, `reconcile`, `deriveEdges`, `buildPlanSnapshot`, `projectResumedTask`, `mapResumedTaskState`, `advanceCursor`, `readTaskRows`, `readTaskRev`, `DaemonCall`, `TASK_LIST_METHOD` | plan reconstruction | thin non-secret task view + pure reconciliation classifier; never throws |
| `TaskWatcher`, `TaskDelta`, `WatchOptions`, `TASK_WATCH_METHOD`, `MIN_WATCH_INTERVAL_MS`, `MAX_WATCH_INTERVAL_MS`, `DEFAULT_WATCH_INTERVAL_MS` | task-stream watch | non-secret deltas, clamped injected schedule, cursor dedup, gated push backend |
| `MxSessionOptions`, `SessionState`, `DEFAULT_HEARTBEAT_INTERVAL_MS` | session types | client ownership, register params, heartbeat + correlation knobs (all gated defaults) |
| `startHeartbeat`, `HeartbeatHandle`, `HeartbeatOptions`, `HeartbeatSchedule` | heartbeat | cancellable interval loop with an injected scheduler |
| `newCorrelationId`, `withCorrelationParam`, `CORRELATION_PARAM_KEY` | correlation | `corr_<uuid>` mint + the gated param-stamping rule |
| `AgentState`, `AgentListEntry`, `AgentLiveness` | types | typed view of `agent.register` / `agent.list` payloads |
| `IpcClient`, `CliClient` | classes | the underlying transports (use directly only to pin behavior) |
| `MxTransport`, `CallOptions`, `TransportError`, `TransportErrorCode` | seam | shared interface + closed error taxonomy |
| `assertNoCredentialShapedArgs`, `CREDENTIAL_KEY_RE`, `CREDENTIAL_VALUE_RE` | outbound guard | hardened secret-boundary arg scrubber (rejects credential-shaped args → `invalid_args`) |
| `redactSecrets`, `REDACTION_PLACEHOLDER` | inbound guard | defense-in-depth result redaction on the `MxClient.call` seam (value-shape only) |
| `safeSubprocessEnv`, `isDeniedEnvKey`, `BASE_ENV_ALLOW`, `ENV_DENY_PREFIXES`, `ENV_DENY_SUFFIXES`, `ENV_DENY_EXACT` | env guard | deny-by-default CLI-child env; `extraAllow` cannot re-admit a known secret |

## Development

```sh
pnpm -C packages/toolbelt typecheck   # tsc --noEmit (strict, nodenext)
pnpm -C packages/toolbelt test        # vitest; live integration tests skip without a daemon
pnpm -C packages/toolbelt build       # emit dist/ with d.ts
```

Live integration tests are gated on `existsSync(socketPath)` (and an
`mx-agent --version` probe for the CLI leg), so CI skips cleanly when no daemon
is present and runs the round-trip when one is up (`mx-agent daemon start`).

## Conformance (T007) — the pin-bump gate

The **conformance suite** (`test/conformance/`) verifies the toolbelt's assumed
`mx-agent` surface (Boundary B) against a **live, pinned** daemon and goes red on
drift. It is the executable gate the pin-bump policy
([`docs/mx-agent-pin.md`](../../docs/mx-agent-pin.md)) names: a bump lands only
when this suite is green against the new version.

Three tiers, driven through the public client (`createClient` / `openSession` /
`MxClient.call`) — the same path real callers use:

- **Tier 0 — pin identity** (`surface.conformance.test.ts`, one daemon):
  `daemon.status.version` equals `.mx-agent-version`. A non-pinned daemon is drift.
- **Tier 1 — discovery round-trips** (`agent-lifecycle.conformance.test.ts`, one
  daemon): `agent.register` returns a full, well-shaped `AgentState` carrying
  **only public** key material; `agent.list` returns `[{ agent, liveness }]` with
  the just-registered agent `active`; known-bad inputs map onto the closed
  `TransportError` code set; the credential-shaped-arg guard stays intact.
- **Tier 2 — delegation** (`delegate.conformance.test.ts`, **two daemons**):
  `call.start` round-trips a named tool to a second registered target agent
  (mutual Ed25519 trust + a minimal allow-policy on the receiver), plus a
  policy-denied negative and a best-effort idempotency-key retry.

```sh
pnpm -C packages/toolbelt test:conformance   # vitest, conformance config only
```

Fail-not-skip (`test/conformance/_harness.ts`): with no daemon and no flag the
suite **skips cleanly** (harmless locally and in the fast unit CI). The
conformance CI job sets `MXL_CONFORMANCE=1`, which turns a missing/unreachable
daemon into a **hard failure** — otherwise "red on drift" would silently degrade
to "always green". Tier 2 additionally guards on `MXL_CONFORMANCE_TWO_DAEMON=1`
plus the fixture coordinates (`MXL_CONFORMANCE_ROOM` / `_TARGET_AGENT` / `_TOOL`),
so the cheap single-daemon tiers run even before the two-daemon bring-up lands.

The suite is **excluded from `pnpm test`** (via `vitest.config.ts`) so the fast
suite stays daemon-free. CI: `.github/workflows/conformance.yml`; bring-up:
`scripts/conformance/`.
