# Toolbelt `--json` CLI Fallback Transport (T003 / #3)

> Implementation spec for GitHub issue **#3 — T003 · toolbelt: `--json` CLI fallback transport**
> Labels: `area/toolbelt` · `priority/P0` · `type/feature`. Milestone **M0 — SDK seam**. Estimate **M**.
> Sources: [`docs/mx-agent-tool-fabric-design.md`](../docs/mx-agent-tool-fabric-design.md) (§8 MVP, §10 Phase 0,
> §6 secret boundary), [`docs/backlog.md`](../docs/backlog.md) (`T003`),
> [`docs/mx-agent-surface-v0.2.1.md`](../docs/mx-agent-surface-v0.2.1.md) (verified CLI/RPC surface).
> Blocked-by **#1 (T001)** — satisfied. Unblocks **#4 (T004)** transport selection.
>
> Note: a sibling spec, [`specs/toolbelt-json-cli-fallback-transport.md`](./toolbelt-json-cli-fallback-transport.md),
> already exists for this issue from an earlier planning pass. This document is an independent,
> code-verified spec written against the current `packages/toolbelt` tree; the two agree on substance.

## Problem Statement

mx-loom (the "toolbelt" / adaptation layer) reaches the mx-agent daemon across **Boundary B**. ADR-11
mandates **two transports**: the framed Unix-socket JSON-RPC 2.0 IPC channel as the *primary*, and a
one-shot `mx-agent … --json` **CLI invocation** as the *secondary / fallback*. The fallback is what keeps
the toolbelt usable when the framed socket path is unavailable or unsuitable — no reachable daemon socket,
restricted socket permissions, or a defense-in-depth alternate path during the alpha-substrate window.

Today only the IPC transport exists. `packages/toolbelt/src/ipc/` (landed in **T002 / #2**) implements a
complete framed JSON-RPC client (`IpcClient`), its closed error taxonomy (`IpcError` / `IpcErrorCode`),
the length-prefix framing codec, and socket-path resolution. There is **no CLI transport**. Until there
is:

- the toolbelt has a single point of failure at the socket;
- ADR-11's "IPC primary, CLI fallback" contract is unmet, which **blocks T004 / #4**, whose entire job is
  to *select between* the two transports and fail over IPC→CLI;
- the M0 exit criteria ("toolbelt round-trips `agent.register` / `agent.list` / `call.start` against a
  live daemon; conformance green on v0.2.1") cannot be demonstrated through both documented paths.

T003 closes this by adding a **`CliClient`** that spawns the `mx-agent` binary with `--json`, parses its
stdout, and returns **the same typed result shape and the same normalized error taxonomy as `IpcClient`**,
while spawning the subprocess under a **deny-by-default environment allowlist** so that no `MATRIX_*`,
`MX_AGENT_*`, provider key, or `GH_TOKEN` ever reaches the child.

## Goals

- Ship a `CliClient` whose public surface mirrors `IpcClient` — `call(method, params?, options?)` plus the
  `status()` / `ping()` conveniences and a `close()` — so the two are **interchangeable behind a common
  transport interface**, the precondition T004 needs.
- **Acceptance criterion 1:** a CLI-backed `call()` resolves to the *same typed result* the IPC client
  returns for the same RPC method. Demonstrated end-to-end with `daemon.status` → `DaemonStatus` (reusing
  the existing `ipc/types.ts` type unchanged).
- Map dotted RPC method names (`daemon.status`, `agent.list`, `call.start`, …) to the CLI's noun/verb argv
  form (`mx-agent daemon status --json`, `mx-agent agent list --json`, …) through an explicit, pure,
  unit-testable mapping.
- **Acceptance criterion 2:** spawn the CLI with a deny-by-default env allowlist (`safeSubprocessEnv`) that
  withholds every secret by default — verified by a test asserting no `MATRIX_*` / `MX_AGENT_*` / provider
  key / `GH_TOKEN` reaches the child.
- **Normalize CLI failures into the same closed error set** the IPC client uses, so callers branch
  identically regardless of transport.
- Keep the transport **secret-free**: reject credential-shaped args before they ever become argv; never log
  argv, env, or raw stdout/stderr that could carry secrets.

## Non-Goals

- **Transport selection / fallback orchestration** — which transport to try, retry/backoff, IPC→CLI
  failover. That is **T004 / #4**, explicitly out of scope. T003 builds the CLI transport as a *standalone
  sibling* of `IpcClient`; it does not decide when it is used.
- The **canonical tool registry, result envelope, and `mx_*` model-facing tools** (M1: T101–T108). T003 is
  raw transport, below the registry layer. It must **not** introduce the `{status, result, error, handle,
  approval, audit_ref}` envelope or the model-facing `error.code` set (those land in T102).
- **`agent.register` / the session model** (T005 / #5) and the **conformance suite** (T007 / #7).
- Streaming output, long-running / `awaiting_approval` resolution, and `mx_await_result` (M1+).
- Spawning or supervising the daemon itself. The CLI is invoked one-shot and exits.
- Full argv mapping for **every** daemon verb. T003 covers the M0 read/round-trip methods plus a generic
  param-passing path; per-verb argv for mutating tools (`call.start`, `exec.start`, `task.*`, `share.*`) is
  finalized when those tools land (M1+) — flagged as an open question.

## Relevant Repository Context

**Stack.** TypeScript (ESM, `"type": "module"`), pnpm workspace (`pnpm@9.12.0`), Node ≥ 20.19, vitest
4.x, Apache-2.0. Workspace members: `adw_sdlc` (the ported ADW build harness) and `packages/*`
(`packages/toolbelt` = `@mx-loom/toolbelt`). The toolbelt currently depends on nothing beyond
`@types/node`, `typescript`, and `vitest` — adding the CLI transport requires **no new runtime
dependency** (it uses `node:child_process`).

**The standing "repo is docs-only" caveat from the planning template is now stale for M0.** The following
already exist and are verified by reading the source:

- **T001 / #1 — done.** `docs/mx-agent-surface-v0.2.1.md` records the live-verified daemon surface:
  framed JSON-RPC 2.0 at `$XDG_RUNTIME_DIR/mx-agent/daemon.sock` (Linux) / `$TMPDIR/mx-agent/daemon.sock`
  (macOS); the confirmed `daemon.status` result shape; CLI verbs in `agent.<noun>` / `workspace.<noun>`
  form; and `task create --room --title [--tool --arg/--input-json --exec …]` (the CLI accepts
  `--input-json` for structured args). `call.start` / `exec.start` **flags are confirmed but not yet
  round-tripped** (needs a two-daemon fixture). The doc does **not** yet record the exact `--json` *output*
  framing (bare RPC `result` vs. a wrapper) — an open question below.
- **T002 / #2 — done.** `packages/toolbelt/src/ipc/` (verified by reading it):
  - `ipc/client.ts` — `IpcClient` with `call(method, params?, {timeoutMs}?)`, `status(): Promise<DaemonStatus>`,
    `ping()`, `close()`. One persistent socket, lazily connected, id-correlated (`mxl-<base36>`), per-call
    `setTimeout` deadline (default **30_000 ms**), `#failAll` on socket error/close. `call()` resolves the
    JSON-RPC `result` directly (`entry.resolve(msg.result)`).
  - `ipc/errors.ts` — `IpcError extends Error` with a `code` field and the **closed** `IpcErrorCode` set:
    `not_running | connect_failed | timeout | closed | frame | protocol | rpc`. Mapping in the client:
    `ENOENT`/`ECONNREFUSED` → `not_running`; other connect/write errors → `connect_failed`; deadline →
    `timeout`; bad frame → `frame`; non-JSON / `result`-and-`error`-absent envelope → `protocol`; daemon
    JSON-RPC error object → `rpc` (message rendered as `` `${error.message} (rpc code ${error.code})` ``).
  - `ipc/framing.ts` — 4-byte big-endian length-prefix codec (`encodeFrame` / `FrameDecoder`,
    `HEADER_BYTES`, `MAX_FRAME_BYTES`).
  - `ipc/socket-path.ts` — `resolveSocketPath({socketPath?, env?})` (override → `XDG_RUNTIME_DIR` →
    `TMPDIR`/`os.tmpdir()`), with `SocketPathOptions`.
  - `ipc/types.ts` — JSON-RPC envelope types + `DaemonStatus`
    (`{running, pid, uptime_seconds, socket_path, version, sync?}`).
  - `index.ts` re-exports the IPC public surface (`IpcClient`, `IpcClientOptions`, `CallOptions`,
    `IpcError`, `IpcErrorCode`, `resolveSocketPath`, framing, types).
  - Tests: `test/client.test.ts` (mock daemon over a real `net` server), `test/client.integration.test.ts`
    (`describe.skipIf(!live)` gated on socket existence), `test/framing.test.ts`, `test/socket-path.test.ts`.
- **T006 / #6 — done.** `.mx-agent-version` = `v0.2.1`; pin-bump policy in `docs/mx-agent-pin.md`.

**Prior art for the env allowlist — `adw_sdlc/src/env.ts` (pattern, NOT a dependency).** It implements a
`safeSubprocessEnv` for the *ADW build harness*' runner children (claude/codex/opencode/pi). Verified
specifics worth copying: `ENV_DENY_PREFIXES = ['MATRIX_', 'MX_AGENT_']` (never forwarded, even via
`extraAllow`), a deny-by-default base allow (`HOME, USER, PATH, SHELL, TERM, LANG, LC_ALL, TMPDIR`), and an
injectable source env for tests. **Crucially, it must NOT be imported:** its `RUNNER_ENV_ALLOW` *forwards
provider credentials* (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, …) because its
children are LLM runners that need them. The toolbelt's CLI child is the **mx-agent binary**, which needs
**no credentials at all** — it reads its Ed25519 signing key and Matrix session from on-disk daemon state
(`~/.local/share/mx-agent/`, mode 0600), never from env. The toolbelt therefore needs its **own, strictly
tighter** `safeSubprocessEnv`. (`adw_sdlc/src/exec.ts` shows the house `spawnSync`/`Captured` subprocess
convention, but the toolbelt should prefer **async** spawning, see below, for parity with the async
`IpcClient`.)

**What does not exist yet (build it in T003), flagged as decisions to confirm:** `packages/toolbelt/src/cli/`
(the entire CLI transport), any toolbelt-local env allowlist, and any shared transport interface/error
abstraction unifying IPC and CLI. None of these are in the tree today.

## Proposed Implementation

Add a `cli/` sibling to `ipc/` inside `@mx-loom/toolbelt`, structured so T004 can later treat IPC and CLI
as one interface.

### 1. Shared transport contract (small, type-only refactor)

Introduce a minimal common interface both clients satisfy, so #4 can hold either behind one type:

```ts
// packages/toolbelt/src/transport.ts
export interface CallOptions { timeoutMs?: number }

export interface MxTransport {
  call(method: string, params?: unknown, options?: CallOptions): Promise<unknown>;
  status(options?: CallOptions): Promise<DaemonStatus>;
  ping(options?: CallOptions): Promise<unknown>;
  close(): Promise<void>;
}
```

`IpcClient` already structurally matches this — add an `implements MxTransport` annotation (no behavior
change). `CliClient` implements the same. `close()` on the CLI client is a no-op (each call is its own
short-lived subprocess) but is kept for interface symmetry. `CallOptions` currently lives in
`ipc/client.ts`; relocate the canonical definition to `transport.ts` and re-export it from `ipc` so the
existing `index.ts` export keeps working.

**Error taxonomy — reuse, do not fork.** AC 1 ("same typed result shape") extends to errors: callers must
branch on one closed code set across transports. **Recommended (confirm in review):** keep the existing
`IpcError` / `IpcErrorCode` as the **shared transport error**, re-exported under a transport-neutral alias
(`TransportError` / `TransportErrorCode`) for clarity, and have `CliClient` reject with the **same class and
codes**:

| Situation (CLI path) | Normalized code | Rationale (matches IPC meaning) |
|---|---|---|
| `mx-agent` binary not found (spawn `ENOENT`) | `not_running` | "this transport cannot reach the daemon" — same meaning IPC gives an absent socket, so #4 treats both uniformly |
| other spawn error (`EACCES`, etc.) | `connect_failed` | transport present but unusable |
| subprocess exceeded the deadline (killed) | `timeout` | mirrors the IPC per-call timeout |
| exit ≠ 0 **and** stdout/stderr carries a JSON-RPC-style error object | `rpc` | daemon-level error surfaced through the CLI; extract `message` + numeric `code` exactly as `IpcClient.#dispatch` does |
| exit ≠ 0 with no parseable JSON error | `protocol` | unexpected CLI failure shape |
| exit 0 but stdout is not valid JSON / not the expected shape | `protocol` | same as IPC's "response was not a valid envelope" |

`frame` and `closed` are inapplicable to the CLI path (no socket/framing) and simply never arise. The M0
method set needs no new codes. If review prefers explicit CLI provenance, add `spawn_failed` as a sibling
of `connect_failed` rather than overloading — flagged as a decision, not a commitment.

### 2. `CliClient`

```ts
// packages/toolbelt/src/cli/client.ts
export interface CliClientOptions {
  /** Path/name of the mx-agent CLI. Default: MXL_AGENT_BIN (parent env) else 'mx-agent' on PATH. */
  cliBin?: string;
  /** Environment used for bin resolution + as the allowlist source. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Default per-call timeout in ms. Default: 30_000 (matches IpcClient). */
  defaultTimeoutMs?: number;
  /** Optional extra NON-secret env keys the CLI legitimately needs (deny-prefixed keys dropped even here). */
  extraEnvAllow?: readonly string[];
}

export class CliClient implements MxTransport { /* … */ }
```

`call(method, params?, options?)`:

1. **Reject credential-shaped args** in `params` *before* building argv (Security §). On a match throw a
   `TransportError` — `invalid_args` if the shared set is extended, else `protocol` with a clear message
   (decision flagged below).
2. **Map method → argv** via the method map (§3): `['agent','list','--json', …]`.
3. **Build env** with the toolbelt's `safeSubprocessEnv` (§4) from `options.env ?? this.env`.
4. **Spawn** `cliBin` with the argv and scrubbed env using **async** `spawn` (not `spawnSync`), so
   concurrent calls and the per-call timeout work like the IPC client. `stdio: ['pipe' | 'ignore', 'pipe',
   'pipe']`. Capture stdout/stderr into **bounded** buffers (reuse a `MAX_FRAME_BYTES`-style cap so a
   misbehaving CLI can't exhaust memory).
5. **Enforce the deadline:** `setTimeout(timeoutMs)` → `child.kill('SIGKILL')` → reject `timeout`; clear on
   exit. `timer.unref()` (matching the IPC client).
6. **On exit:** parse stdout as JSON, normalize per the table above, and resolve the **`result` payload**
   (unwrapping the CLI envelope if it wraps — open question #1) so the resolved value *equals* what
   `IpcClient.call()` resolves for the same method.

`status()` / `ping()` delegate to `call('daemon.status')` / `call('daemon.ping')` and cast, identical to
`IpcClient`, guaranteeing shape parity for the demonstrated acceptance criterion.

> **Bin-override naming.** Do **not** name the override `MX_AGENT_BIN` — the `MX_AGENT_` deny prefix means
> the toolbelt would (correctly) refuse to forward it, and it reads as a daemon secret. Use the
> mx-loom-namespaced **`MXL_AGENT_BIN`** for the toolbelt's own resolution, read from the *parent* env and
> never forwarded to the child. The constructor `cliBin` option always wins (tests inject a fixture-script
> path here).

### 3. Method → argv mapping

```ts
// packages/toolbelt/src/cli/method-map.ts
export function methodToArgv(method: string, params?: unknown): { argv: string[]; stdin?: string };
```

The daemon RPC namespace is dotted (`daemon.status`, `agent.list`, `call.start`); the CLI is noun/verb
(`mx-agent daemon status`, `mx-agent agent list`, `mx-agent call start`) per the verified surface. Strategy:

- **Default rule:** split `method` on `.` → `[noun, verb]`, emit `[noun, verb, '--json']`. Covers the M0
  read methods (`daemon.status`, `daemon.ping`, `agent.list`, `agent.show`, `agent.tools`,
  `workspace.status`) the IPC client already round-trips.
- **Param passing:** for methods taking structured params, append `--input-json -` and write the JSON
  `params` to the child's **stdin** (preferred) rather than placing them on argv. Rationale: argv is
  world-readable via `/proc/<pid>/cmdline` and `ps`, so even non-secret args should not ride the command
  line; stdin avoids that exposure. (`--input-json` is confirmed on `task create`; whether `--input-json -`
  / stdin is accepted *generally* must be verified per verb — open question #2.) Where a verb only accepts
  discrete flags, add a small, explicit per-method entry mapping known param keys to flags, scoped to
  methods actually used in M0.
- Keep the map **data-driven and pure** (`methodToArgv` returns `{argv, stdin?}` with no I/O), so adding
  mutating verbs in M1 is a table edit, not a rewrite, and unit tests are trivial.

### 4. `safeSubprocessEnv` (toolbelt-local, tighter than `adw_sdlc`)

```ts
// packages/toolbelt/src/cli/env.ts
export const ENV_DENY_PREFIXES = ['MATRIX_', 'MX_AGENT_'] as const;       // never forwarded, ever
// Minimal: only what the mx-agent CLI needs to find its socket/config + run.
export const BASE_ENV_ALLOW = ['HOME', 'PATH', 'XDG_RUNTIME_DIR', 'XDG_DATA_HOME',
                               'TMPDIR', 'LANG', 'LC_ALL', 'TERM'] as const;
export function safeSubprocessEnv(opts?: {
  source?: Record<string, string | undefined>;   // default process.env
  extraAllow?: readonly string[];                 // deny-prefixed keys dropped even here
}): Record<string, string>;
```

Semantics: **deny-by-default** — start from `{}`, copy only allowlisted keys that are present in `source`; a
key matching `ENV_DENY_PREFIXES` is never copied, even if requested via `extraAllow`. **No provider keys, no
`GH_TOKEN`, no `*_API_KEY`, no `*_TOKEN`** are in the allowlist — the toolbelt child is the daemon binary,
which needs none of them. This is deliberately stricter than `adw_sdlc/src/env.ts`; document the divergence
in the file header so the two are not "unified" later by mistake. Confirm the exact base-allow set against
the live CLI during implementation (e.g. whether the CLI honors `XDG_CONFIG_HOME`) and trim to the minimum
that works — an over-broad allowlist is a latent leak risk.

### 5. Exports

Extend `packages/toolbelt/src/index.ts` to export `CliClient`, `CliClientOptions`, the `MxTransport`
interface, `CallOptions` (now sourced from `transport.ts`), `safeSubprocessEnv` (plus
`BASE_ENV_ALLOW` / `ENV_DENY_PREFIXES`), `methodToArgv`, and the transport-error alias — mirroring how the
IPC surface is exported today.

## Affected Files / Packages / Modules

Owning package: **`packages/toolbelt`** (`@mx-loom/toolbelt`).

**Read for context:**
- `packages/toolbelt/src/ipc/client.ts`, `ipc/errors.ts`, `ipc/types.ts`, `ipc/socket-path.ts`, `ipc/framing.ts`
- `packages/toolbelt/src/index.ts`
- `packages/toolbelt/test/client.test.ts`, `test/client.integration.test.ts` (test conventions; mock-daemon + `skipIf` gating)
- `adw_sdlc/src/env.ts` (env-allowlist pattern), `adw_sdlc/src/exec.ts` (subprocess convention)
- `docs/mx-agent-surface-v0.2.1.md` (CLI verb forms, `--json`, `--input-json`)

**Create:**
- `packages/toolbelt/src/transport.ts` — `MxTransport` interface + `CallOptions` + transport-error alias (or fold the alias into `ipc/errors.ts`)
- `packages/toolbelt/src/cli/client.ts` — `CliClient`
- `packages/toolbelt/src/cli/env.ts` — toolbelt-local `safeSubprocessEnv` + allowlist constants
- `packages/toolbelt/src/cli/method-map.ts` — `methodToArgv()`
- `packages/toolbelt/test/cli-client.test.ts` — `CliClient` over a fake mx-agent fixture script
- `packages/toolbelt/test/cli-env.test.ts` — allowlist / secret-leak assertions (**AC 2**)
- `packages/toolbelt/test/method-map.test.ts` — argv mapping
- `packages/toolbelt/test/cli-client.integration.test.ts` — `skipIf` gated on a real `mx-agent` binary
- `packages/toolbelt/test/fixtures/fake-mx-agent.mjs` — a tiny script emitting canned `--json` output, with modes to exit non-zero / emit non-JSON / sleep / echo received env (for the leak test)

**Modify:**
- `packages/toolbelt/src/index.ts` — new exports; re-export `CallOptions` from `transport.ts`
- `packages/toolbelt/src/ipc/client.ts` — add `implements MxTransport` (type-only); import `CallOptions` from `transport.ts`
- `packages/toolbelt/package.json` — description note ("T002 IPC + T003 CLI fallback transport")

## API / Interface Changes

- **New public exports** from `@mx-loom/toolbelt`: `CliClient`, `CliClientOptions`, `MxTransport`,
  `CallOptions` (now canonical in `transport.ts`), `safeSubprocessEnv` (+ `BASE_ENV_ALLOW`,
  `ENV_DENY_PREFIXES`), `methodToArgv`, and a transport-error alias (`TransportError` /
  `TransportErrorCode`) over the existing `IpcError` / `IpcErrorCode`.
- **No change to `IpcClient`'s runtime behavior** — it gains an `implements MxTransport` annotation only,
  and its `CallOptions` import moves to `transport.ts` (re-exported, so external imports are unaffected).
- **CLI surface consumed (not defined here):** `mx-agent <noun> <verb> --json [--input-json -]`. T003 does
  not change the mx-agent CLI; it consumes the existing `v0.2.1` surface.
- **New non-secret env override read by the toolbelt:** `MXL_AGENT_BIN` (parent-process only; never
  forwarded to the child). Document it.
- No daemon-RPC or tool-descriptor surface changes (those are M1).

## Data Model / Protocol Changes

- **No new wire protocol.** The CLI's `--json` stdout is parsed and **normalized to the same in-memory
  result** `IpcClient.call()` returns for the same method (e.g. `daemon.status` → `DaemonStatus` from
  `ipc/types.ts`, reused unchanged).
- **Error taxonomy:** reuse the existing closed `IpcErrorCode` set as the shared transport taxonomy; CLI
  failures map onto it per the table in Proposed Implementation §1. No new codes required for M0 (a possible
  `spawn_failed` / extending the set with `invalid_args` is flagged as a decision, not committed).
- The **canonical result envelope** (`{status, result, error, handle, approval, audit_ref}` from design §4)
  and the model-facing `error.code` set (`policy_denied | untrusted_key | …`) are **M1 (T102)** and are
  **not** introduced here. T003 stays at raw-transport level: it returns the daemon RPC `result` and
  normalizes *transport* errors only — it must not imply the envelope exists yet.
- No idempotency-key, audit-row, or tool input/output schema changes (those land with the tools in M1).

## Security & Compliance Considerations

The CLI transport sits at **Boundary A's chokepoint** and must not weaken the secret boundary. The CLI path
has one exposure the IPC path does not — **subprocess argv and env** — making it the more
security-sensitive of the two transports.

- **Secret boundary (the load-bearing requirement).** Matrix tokens, Ed25519 signing keys, provider keys,
  and `GH_TOKEN` must never cross Boundary A into the child. The mx-agent CLI child needs **none** of them —
  it reads its signing key (`~/.local/share/mx-agent/signing_key.ed25519`, mode 0600) and Matrix session
  from on-disk daemon state, not from env. Therefore the toolbelt's `safeSubprocessEnv` is deny-by-default
  with a minimal base allowlist (no `*_API_KEY`, no `*_TOKEN`, no `GH_TOKEN`), and `MATRIX_*` / `MX_AGENT_*`
  are dropped unconditionally (even via `extraEnvAllow`). **AC 2 is enforced by a test** that poisons the
  source env with `MATRIX_FOO`, `MX_AGENT_BAR`, `ANTHROPIC_API_KEY`, `GH_TOKEN` and asserts none appear in
  the child's received env.
- **Cognition produces only a signed request; it grants no authority.** The CLI transport carries a request
  to the daemon and returns a result. All enforcement — Ed25519 trust store, deny-by-default `policy.toml`,
  sandbox, human approval gates — runs **out-of-process on the receiving daemon**. The toolbelt cannot sign
  and cannot self-authorize; switching transport from socket to CLI changes nothing about *where* "yes" is
  decided.
- **No trust/policy/approval mutation surface.** T003 adds none. The model never sees credentials; approval
  reaches it only as a result status (M1), re-validated against live policy at release — unaffected by
  transport choice.
- **Secret-free tool contract / reject credential-shaped args.** No field carries credentials inbound or
  outbound. Before building argv, reject params whose **keys** look credential-shaped
  (`/(?:token|secret|password|api[_-]?key|signing[_-]?key|matrix_)/i`) or whose **values** match known
  secret shapes — fail with a transport error rather than spawning. This matters acutely on the CLI path
  because argv is world-visible.
- **Prefer stdin over argv for structured params** (`--input-json -`), so non-secret args also avoid the
  process table. Argv is reserved for the verb and `--json` flags.
- **Logging / redaction.** Never log the child env, argv that could contain args, or raw stdout/stderr on
  the error path without redaction. Transport-error messages stay human-readable and **secret-free** (mirror
  the IPC client's message discipline). Bound stdout/stderr capture to prevent memory exhaustion from a
  hostile CLI.
- **Audit correlation (`audit_ref`).** Audit lives in the M1 result envelope (T102 / T113), not in raw
  transport; T003 introduces no audit rows but must **not strip** any `audit_ref` a daemon includes in a
  result payload — it passes `result` through verbatim.

## Testing Plan

**Unit (no daemon, fake CLI):**
- `cli-env.test.ts` — `safeSubprocessEnv`: deny-by-default; `MATRIX_*` / `MX_AGENT_*` dropped even via
  `extraAllow`; provider keys + `GH_TOKEN` absent; only base-allow keys present in `source` are forwarded;
  injectable `source`. **The secret-leak assertion is acceptance criterion 2.**
- `method-map.test.ts` — `daemon.status` → `['daemon','status','--json']`; a param method emits
  `--input-json -` + the stdin payload; unknown/oddly-shaped methods handled deterministically.
- `cli-client.test.ts` (fake `mx-agent` fixture via `cliBin`):
  - **Result-shape parity (AC 1):** fixture emits a `daemon.status` `--json` payload; assert
    `CliClient.status()` resolves to the same `DaemonStatus` shape the IPC mock-daemon test asserts — ideally
    via a **shared assertion helper** reused by `client.test.ts` and `cli-client.test.ts`.
  - **Error normalization:** binary-absent (`cliBin` → nonexistent path) → `not_running`; fixture exits
    non-zero with a JSON-RPC error → `rpc` (message/code extracted); fixture prints non-JSON on exit 0 →
    `protocol`; fixture sleeps past `timeoutMs` → `timeout` (and the child is killed).
  - **Secret-shaped arg rejection:** `call('x', {api_key:'…'})` rejects *before* spawn (fixture asserts it
    was never invoked).
  - **Concurrency:** multiple concurrent `call()`s each get an independent subprocess and the correct result.
- Optional `index` export test — public surface present.

**Integration (gated, real binary):**
- `cli-client.integration.test.ts` — `describe.skipIf` gated on an `mx-agent` binary being resolvable
  (mirror `client.integration.test.ts`'s socket gate). Round-trip `daemon.status` through the real CLI and
  assert it **equals** the IPC client's `daemon.status` result on the same host (the strongest form of "same
  typed result shape"). Skips cleanly in CI without a daemon/binary.

**Secret-boundary / redaction:** covered by `cli-env.test.ts` (env) + the arg-rejection case; add a test
asserting an induced transport-error message contains none of the poisoned secret values.

**Conformance:** the cross-transport parity assertion feeds the T007 / #7 conformance suite later — note the
linkage; do **not** build the suite here.

## Documentation Updates

- **`docs/mx-agent-surface-v0.2.1.md`** — add a short "CLI `--json` fallback" subsection recording the verb
  forms used, the actual `--json` output shape vs. the RPC `result` (wrapped or bare — fill in once verified
  live), and `--input-json -` / stdin support per verb.
- **`docs/backlog.md`** — tick the T003 acceptance boxes when implemented; note that T004 / #4 (transport
  selection) is unblocked.
- **`packages/toolbelt/package.json`** — update `description` to mention the CLI fallback transport.
- **`docs/mx-agent-tool-fabric-design.md`** — no change required (it already names the `--json` CLI fallback
  in §8/§10); add a pointer only if a CLI-specifics note is wanted.
- **JSDoc** — document `CliClient`, `CliClientOptions`, `MxTransport`, `safeSubprocessEnv`, `methodToArgv`,
  and the `MXL_AGENT_BIN` override as public API (the repo documents public APIs via JSDoc, as in `ipc/`).

## Risks and Open Questions

1. **CLI `--json` output shape (verify against the live binary).** Does `mx-agent <noun> <verb> --json` print
   the bare RPC `result` or wrap it (e.g. `{ok, data}` / a JSON-RPC-like envelope)? The normalizer must
   unwrap to match `IpcClient.call()`. T001 verified the RPC `daemon.status` *result* shape but **not** the
   CLI's `--json` framing. **Recommend a short live check (T001-style) before/with implementation.**
2. **Param passing per verb.** `--input-json` is confirmed for `task create`; is `--input-json -` (stdin)
   accepted generally, and which verbs need discrete flags instead? Affects `method-map.ts`. Scope the M0
   read methods first; finalize mutating-verb argv with the M1 tools.
3. **What "fallback" means operationally.** When the daemon socket is absent, can a one-shot
   `mx-agent … --json` still serve the request (does the CLI auto-spawn/own a daemon, or only work when one
   is up)? If the CLI also requires a live daemon, the "fallback" value is narrower (alternate path, not
   daemon-independent). This shapes T004's selection logic but does **not** block building the CLI transport.
   **Flag for confirmation.**
4. **Shared error type — refactor scope (decision).** Recommended: alias `IpcError` / `IpcErrorCode` as the
   transport-neutral `TransportError` / `TransportErrorCode` and reuse them rather than introduce a parallel
   error class. Confirm the naming and whether to extend the closed set now (`invalid_args` / `spawn_failed`)
   or keep the strict IPC subset and reuse `protocol` / `connect_failed`.
5. **`MxTransport` / `CallOptions` placement (decision).** New `src/transport.ts` vs. co-locating in `ipc/`.
   Recommend a dedicated `transport.ts` since both are transport-neutral and T004 depends on them; move
   `CallOptions` there and re-export from `ipc` to avoid breaking the existing export.
6. **Base env allowlist exactness.** Trim `BASE_ENV_ALLOW` to what the mx-agent CLI *actually* needs against
   the live binary; over-broad allowlists are a latent leak risk. Verify during implementation.
7. **Async vs. sync spawn.** Recommend async `spawn` (parity with the async `IpcClient`, real timeouts,
   concurrency). `adw_sdlc` uses `spawnSync`, but its control plane is deliberately sequential; the
   toolbelt's is not. Confirm.
8. **Do not import `adw_sdlc/src/env.ts`.** Its allowlist forwards provider keys / `GH_TOKEN` by design and
   would violate the toolbelt's stricter boundary. The toolbelt gets its own `safeSubprocessEnv`.
9. **Stale template caveat.** The planning template's "repo is docs-only" no longer holds for M0
   (`packages/toolbelt/src/ipc/` exists, verified). This spec builds on real, read code.

## Implementation Checklist

1. [ ] **Verify CLI behavior live** (needs an `mx-agent v0.2.1` binary): run `mx-agent daemon status --json`;
   record whether the output is a bare `result` or wrapped, and confirm `--input-json -` / stdin param
   passing. Update `docs/mx-agent-surface-v0.2.1.md` with findings. (Open questions #1, #2.)
2. [ ] Add `src/transport.ts`: `MxTransport` interface + `CallOptions`; export a transport-neutral
   `TransportError` / `TransportErrorCode` alias over `IpcError` / `IpcErrorCode` (decision #4).
3. [ ] Annotate `IpcClient implements MxTransport` (type-only); import `CallOptions` from `transport.ts` and
   re-export it from `ipc` so `index.ts` stays unbroken.
4. [ ] Add `src/cli/env.ts`: deny-by-default `safeSubprocessEnv` + `ENV_DENY_PREFIXES` + minimal
   `BASE_ENV_ALLOW`; file header documenting why it is stricter than `adw_sdlc/src/env.ts` (no provider keys,
   no `GH_TOKEN`).
5. [ ] Add `src/cli/method-map.ts`: `methodToArgv(method, params) → {argv, stdin?}` (default dotted-split
   rule + `--input-json -` for structured params + a small per-verb table for M0 read methods).
6. [ ] Add `src/cli/client.ts`: `CliClient implements MxTransport` — bin resolution (`cliBin` →
   `MXL_AGENT_BIN` → `mx-agent`), credential-shaped-arg rejection, async `spawn` with scrubbed env, stdin
   param write, bounded stdout/stderr capture, per-call timeout + `SIGKILL`, JSON parse, error normalization
   per the table, `status()` / `ping()` delegators, no-op `close()`.
7. [ ] Update `src/index.ts` exports (`CliClient`, `CliClientOptions`, `MxTransport`, `CallOptions`,
   `safeSubprocessEnv` + allowlist constants, `methodToArgv`, transport-error alias).
8. [ ] Add `test/fixtures/fake-mx-agent.mjs`: canned `--json` for `daemon status`; modes to exit non-zero /
   emit non-JSON / sleep / echo received env (for the leak test).
9. [ ] Add `test/cli-env.test.ts` (secret-leak / allowlist — **AC 2**).
10. [ ] Add `test/method-map.test.ts` (argv mapping).
11. [ ] Add `test/cli-client.test.ts` (result-shape parity **AC 1**, error normalization, arg rejection,
    timeout/kill, concurrency) — share the `DaemonStatus` assertion with `client.test.ts`.
12. [ ] Add `test/cli-client.integration.test.ts` (`skipIf` on a real binary; cross-transport `daemon.status`
    equality).
13. [ ] Update `packages/toolbelt/package.json` description; add JSDoc to all new public symbols.
14. [ ] `pnpm --filter @mx-loom/toolbelt typecheck && pnpm --filter @mx-loom/toolbelt test` green; confirm no
    secret-bearing env key appears in any test-captured child env.
15. [ ] Tick the T003 boxes in `docs/backlog.md`; note T004 / #4 unblocked.

---
_Spec for T003 / #3. Blocked-by #1 (satisfied). Unblocks #4 (transport selection). Substrate pin: mx-agent
`v0.2.1`. Out of scope: transport selection (#4), tools/envelope (M1)._
