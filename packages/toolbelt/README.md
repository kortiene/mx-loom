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

### Secret boundary

The unified layer does **not** weaken the boundary the transports enforce. The
CLI leg always spawns under the deny-by-default `safeSubprocessEnv`
(`MATRIX_*` / `MX_AGENT_*` dropped; no `*_TOKEN` / `*_API_KEY` / `GH_TOKEN`), and
the credential-shaped-arg guard (`assertNoCredentialShapedArgs`, hoisted to
`src/guards.ts`) runs **before dispatch to either transport** — so a
credential-shaped key/value is rejected as `invalid_args` uniformly, on IPC and
CLI alike. Diagnostics carry only the error code, transport name, socket path,
CLI bin name, and attempt number — never params, env values, or raw output.

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

## Public API

| Export | Kind | Notes |
|---|---|---|
| `createClient(options?)` | factory | returns an `MxClient` with auto defaults |
| `MxClient` | class (`implements MxTransport`) | `call` / `status` / `ping` / `close` / `activeTransport` |
| `MxClientOptions` | type | `transport`, `socketPath`, `cliBin`, `env`, `defaultTimeoutMs`, `retry`, factories (testing seam) |
| `TransportPreference` | type | `'auto' \| 'ipc' \| 'cli'` |
| `RetryPolicy`, `DEFAULT_RETRY_POLICY`, `withRetry`, `backoffDelay` | retry primitives | conservative, pre-dispatch-only by default |
| `openSession(options?)` | factory | registers an agent, returns an active `MxSession` |
| `MxSession` | interface | `agentId` / `agentState` / `room` / `correlationId` / `state` / `call` / `liveness` / `close` |
| `MxSessionOptions`, `SessionState`, `DEFAULT_HEARTBEAT_INTERVAL_MS` | session types | client ownership, register params, heartbeat + correlation knobs (all gated defaults) |
| `startHeartbeat`, `HeartbeatHandle`, `HeartbeatOptions`, `HeartbeatSchedule` | heartbeat | cancellable interval loop with an injected scheduler |
| `newCorrelationId`, `withCorrelationParam`, `CORRELATION_PARAM_KEY` | correlation | `corr_<uuid>` mint + the gated param-stamping rule |
| `AgentState`, `AgentListEntry`, `AgentLiveness` | types | typed view of `agent.register` / `agent.list` payloads |
| `IpcClient`, `CliClient` | classes | the underlying transports (use directly only to pin behavior) |
| `MxTransport`, `CallOptions`, `TransportError`, `TransportErrorCode` | seam | shared interface + closed error taxonomy |
| `assertNoCredentialShapedArgs`, `CREDENTIAL_KEY_RE`, `CREDENTIAL_VALUE_RE` | guard | shared secret-boundary guard (T008 hardens) |

## Development

```sh
pnpm -C packages/toolbelt typecheck   # tsc --noEmit (strict, nodenext)
pnpm -C packages/toolbelt test        # vitest; live integration tests skip without a daemon
pnpm -C packages/toolbelt build       # emit dist/ with d.ts
```

Live integration tests are gated on `existsSync(socketPath)` (and an
`mx-agent --version` probe for the CLI leg), so CI skips cleanly when no daemon
is present and runs the round-trip when one is up (`mx-agent daemon start`).
