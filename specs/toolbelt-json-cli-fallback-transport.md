# Toolbelt `--json` CLI Fallback Transport (T003 / #3)

> Implementation spec for GitHub issue **#3 — T003 · toolbelt: `--json` CLI fallback transport**
> (`area/toolbelt` `priority/P0` `type/feature`, Milestone **M0 — SDK seam**).
> Derived from [`docs/mx-agent-tool-fabric-design.md`](../docs/mx-agent-tool-fabric-design.md) (§8 MVP, §10 Phase 0)
> and [`docs/backlog.md`](../docs/backlog.md) (`T003`). Blocked-by **#1 (T001)** — already satisfied.

## Problem Statement

mx-loom (the adaptation layer / "toolbelt") talks to the mx-agent daemon across **Boundary B**.
ADR-11 mandates **two transports**: the daemon Unix-socket JSON-RPC IPC as the *primary*, and a
**one-shot `mx-agent … --json` CLI invocation** as the *secondary / fallback*. The fallback exists so
the toolbelt keeps working when the framed socket path is unavailable or unsuitable (no live daemon
socket, a host where only the CLI is reachable, restricted socket permissions, or as a
defense-in-depth alternate path during the alpha substrate window).

Today the IPC transport exists (`packages/toolbelt/src/ipc/`, landed in T002/#2) but there is **no CLI
transport**. Without it:

- the toolbelt has a single point of failure at the socket;
- ADR-11's "IPC primary, CLI fallback" contract is unmet, which blocks the unified client (T004/#4)
  whose whole job is to *select between* the two transports;
- the M0 exit criteria ("Toolbelt can `agent.register` / `agent.list` / `call.start` against a live
  daemon") cannot be met through both documented paths.

The gap T003 closes is: a **`CliClient`** that invokes the `mx-agent` binary with `--json`, parses its
stdout, and returns **the exact same typed result shape and normalized error taxonomy as `IpcClient`**,
while enforcing a **deny-by-default subprocess env allowlist** so no `MATRIX_*` / `MX_AGENT_*` / provider
key / `GH_TOKEN` ever leaks into the child process.

## Goals

- Provide a `CliClient` whose public surface mirrors `IpcClient` (`call(method, params, options)` plus
  the `status()` / `ping()` conveniences) so the two are **interchangeable** behind a common transport
  interface — the precondition T004/#4 needs to do transport selection.
- A CLI-backed `call()` resolves to the **same typed result** the IPC client returns for the same RPC
  method (acceptance criterion 1). Demonstrated minimally end-to-end with `daemon.status` →
  `DaemonStatus`.
- Map RPC method names (`agent.list`, `daemon.status`, `call.start`, …) to the CLI's noun/verb argv
  form (`mx-agent agent list --json`, …) via an explicit, testable mapping.
- Spawn the CLI with a **deny-by-default environment allowlist** (`safeSubprocessEnv`) that withholds
  every secret by default — verified by a test asserting no `MATRIX_*` / `MX_AGENT_*` (and no provider
  key / `GH_TOKEN`) reaches the child (acceptance criterion 2).
- **Normalize CLI failures into the same closed error taxonomy** the IPC client uses, so callers
  branch identically regardless of transport.
- Keep the transport **secret-free**: reject credential-shaped args before they become argv; never log
  argv/env/stdout that could carry secrets.

## Non-Goals

- **Transport selection / fallback orchestration** (which transport to try, retry/backoff, IPC→CLI
  failover). That is **T004 / #4** and explicitly out of scope here. T003 only builds the CLI transport
  as a standalone sibling of `IpcClient`.
- The **tool registry, result envelope, and `mx_*` model-facing tools** (M1: T101–T108). T003 is raw
  transport, below the canonical-registry layer.
- **`agent.register` / session model** (T005/#5) and the conformance suite (T007/#7).
- Streaming output, long-running/`awaiting_approval` resolution, and `mx_await_result` (M1+).
- Spawning or supervising the daemon itself; the CLI is invoked one-shot and exits.
- Full argv mapping for **every** daemon verb. T003 covers the read/round-trip methods the IPC client
  already supports plus a generic param-passing path; per-verb argv for mutating tools (`call.start`,
  `exec.start`, `task.*`, `share.*`) is finalized when those tools land (M1+), tracked as an open
  question below.

## Relevant Repository Context

**Stack.** TypeScript (ESM, `"type": "module"`), pnpm workspace (`pnpm@9.12.0`), Node ≥ 20.19, vitest,
Apache-2.0. Workspace packages: `adw_sdlc` (the ported ADW build harness) and `packages/*`
(`packages/toolbelt` = `@mx-loom/toolbelt`).

**The repo is NOT docs-only anymore** (the planning template's standing caveat is now stale for M0):

- **T001 / #1 — done.** `docs/mx-agent-surface-v0.2.1.md` records the live-verified daemon surface:
  framed JSON-RPC 2.0 at `$XDG_RUNTIME_DIR/mx-agent/daemon.sock` (Linux) / `$TMPDIR/mx-agent/daemon.sock`
  (macOS); verified `daemon.status` result shape; CLI verbs are `agent.<noun>` / `workspace.<noun>`
  form; `task create --room --title [--tool --arg/--input-json --exec …]` confirmed (the CLI accepts
  `--input-json` for structured args). `call.start` / `exec.start` flags confirmed but not yet
  round-tripped (need a two-daemon fixture).
- **T002 / #2 — done.** `packages/toolbelt/src/ipc/` implements the IPC transport:
  - `ipc/client.ts` — `IpcClient` with `call(method, params?, {timeoutMs}?)`, `status()`, `ping()`,
    `close()`. One persistent socket, id-correlated, per-call timeouts, lazy connect.
  - `ipc/errors.ts` — `IpcError` + the **closed** `IpcErrorCode` set:
    `not_running | connect_failed | timeout | closed | frame | protocol | rpc`.
  - `ipc/framing.ts` — 4-byte BE length prefix codec (`encodeFrame` / `FrameDecoder`,
    `MAX_FRAME_BYTES = 16 MiB`).
  - `ipc/socket-path.ts` — `resolveSocketPath({socketPath?, env?})` (override → `XDG_RUNTIME_DIR` →
    `TMPDIR`/`os.tmpdir()`).
  - `ipc/types.ts` — JSON-RPC envelopes + `DaemonStatus`
    (`{running, pid, uptime_seconds, socket_path, version, sync?}`).
  - `index.ts` re-exports the public surface. Tests: `test/client.test.ts` (mock-daemon over a real
    `net` server), `test/client.integration.test.ts` (`describe.skipIf(!live)` gated on socket
    existence), `test/framing.test.ts`, `test/socket-path.test.ts`.
- **T006 / #6 — done.** `.mx-agent-version` = `v0.2.1`; pin policy in `docs/mx-agent-pin.md`.

**Prior art for the env allowlist.** `adw_sdlc/src/env.ts` already implements a `safeSubprocessEnv`
for the *ADW build harness* (runner children: claude/codex/opencode/pi). It is the **pattern to follow**
but **not to import**: its allowlist intentionally forwards provider keys (`ANTHROPIC_API_KEY`, …) and
optionally `GH_TOKEN` because its children are LLM runners that need credentials. The toolbelt's CLI
child is the *mx-agent binary*, which must receive **no credentials at all** (it reads its signing key
and Matrix session from on-disk `~/.local/share/mx-agent/`, mode 0600 — never from env). So the toolbelt
needs its **own, much tighter** `safeSubprocessEnv`. Reusable, copyable specifics from `env.ts`:
`ENV_DENY_PREFIXES = ['MATRIX_', 'MX_AGENT_']`, the deny-by-default loop (only allowlisted keys present
in the source are forwarded), and an injectable `source` env for tests. `adw_sdlc/src/exec.ts` shows the
house subprocess convention (`spawnSync`, `Captured = {returncode, stdout, stderr}`, ENOENT → synthetic
127), but the toolbelt should prefer **async** spawning (see below) for parity with the async
`IpcClient`.

**What does not exist yet (build it in T003):** `packages/toolbelt/src/cli/` (the whole CLI transport),
any toolbelt-local env allowlist, and any shared transport interface/error abstraction unifying IPC and
CLI. These are decisions to confirm, flagged below — they do not exist today.

## Proposed Implementation

Add a `cli/` sibling to `ipc/` inside `@mx-loom/toolbelt`, structured so T004 can later treat IPC and
CLI as one interface.

### 1. Shared transport contract (small refactor)

Introduce a minimal common interface both clients satisfy, so #4 can hold either:

```ts
// packages/toolbelt/src/transport.ts
export interface MxTransport {
  call(method: string, params?: unknown, options?: CallOptions): Promise<unknown>;
  status(options?: CallOptions): Promise<DaemonStatus>;
  ping(options?: CallOptions): Promise<unknown>;
  close(): Promise<void>;
}
export interface CallOptions { timeoutMs?: number }
```

`IpcClient` already structurally matches this — annotate it `implements MxTransport` (no behavior
change). `CliClient` implements the same. `close()` on the CLI client is a no-op (each call is its own
short-lived subprocess) but is kept for interface symmetry.

**Error taxonomy — reuse, do not fork.** Acceptance criterion 1 ("same typed result shape") extends to
errors: callers must branch on one closed code set. Recommended approach (confirm in review): keep the
existing `IpcError` / `IpcErrorCode` as the **shared transport error**, re-exported under a
transport-neutral alias (`TransportError` / `TransportErrorCode`) for clarity, and have `CliClient`
reject with the **same class and codes**:

| Situation (CLI) | Normalized code | Rationale (matches IPC meaning) |
|---|---|---|
| `mx-agent` binary not found on PATH (spawn `ENOENT`) | `not_running` | "this transport cannot reach the daemon" — same meaning IPC gives an absent socket, so #4 can treat both uniformly |
| other spawn error (EACCES, etc.) | `connect_failed` | transport present but could not be used |
| subprocess exceeded the deadline (killed) | `timeout` | mirrors IPC per-call timeout |
| exit ≠ 0 **and** stdout/stderr carries a JSON-RPC-style error object | `rpc` | daemon-level error surfaced through the CLI; extract `message` + numeric code exactly like `IpcClient.#dispatch` |
| exit ≠ 0 with no parseable JSON error | `protocol` | unexpected CLI failure shape |
| exit 0 but stdout is not valid JSON / not the expected shape | `protocol` | same as IPC's "response was not a valid envelope" |

The `frame` and `closed` codes are inapplicable to the CLI path (no socket/framing) and simply never
arise. No new codes are required by the M0 method set; if review prefers explicit CLI provenance, add
`spawn_failed` as a sibling of `connect_failed` rather than overloading — flagged as a decision.

### 2. `CliClient`

```ts
// packages/toolbelt/src/cli/client.ts
export interface CliClientOptions {
  /** Path/name of the mx-agent CLI. Default: resolve `MXL_AGENT_BIN` (see note) else 'mx-agent' on PATH. */
  cliBin?: string;
  /** Environment used for bin resolution + as the allowlist source. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Default per-call timeout in ms. Default: 30_000 (matches IpcClient). */
  defaultTimeoutMs?: number;
  /** Optional extra non-secret env keys the CLI legitimately needs (deny-prefixed keys dropped). */
  extraEnvAllow?: readonly string[];
}

export class CliClient implements MxTransport { /* … */ }
```

`call(method, params?, options?)`:

1. **Reject credential-shaped args** in `params` *before* building argv (see Security §). Throw
   `TransportError('invalid_args', …)` on a match. (`invalid_args` is part of the design §4 error
   taxonomy; if the shared transport error set should stay the IPC subset, surface it as `protocol`
   with a clear message — decision flagged below.)
2. **Map method → argv** via the method map (§3): `['agent','list','--json', …flags]`.
3. **Build env** with the toolbelt's `safeSubprocessEnv` (§4) from `options.env`.
4. **Spawn** `cliBin` with the argv and the scrubbed env, `stdio: ['pipe'|'ignore','pipe','pipe']`,
   `cwd` left to the OS default. Use **async** `spawn` (not `spawnSync`) so concurrent calls and the
   per-call timeout work like the IPC client; capture stdout/stderr to bounded buffers (reuse the
   `MAX_FRAME_BYTES`-style cap to avoid unbounded memory on a misbehaving CLI).
5. **Enforce timeout**: `setTimeout` → `child.kill('SIGKILL')` → reject `timeout`. Clear on exit.
6. **On exit**: parse stdout as JSON; normalize per the table above; resolve the **`result` payload**
   (unwrapping the CLI's envelope if it wraps — see open question) so the resolved value equals what
   `IpcClient.call()` resolves for the same method.

`status()` / `ping()` delegate to `call('daemon.status')` / `call('daemon.ping')`, identical to
`IpcClient`, guaranteeing shape parity for the demonstrated acceptance criterion.

> **Bin-override naming.** Do **not** name the override `MX_AGENT_BIN` — the `MX_AGENT_` deny prefix
> means the toolbelt would (correctly) refuse to forward it, and it reads as a daemon secret. Use
> `MXL_AGENT_BIN` (mx-loom-namespaced) for the toolbelt's own resolution, read from the *parent* env and
> never forwarded to the child. The constructor `cliBin` option always wins (tests inject a fixture
> script path here).

### 3. Method → argv mapping

```ts
// packages/toolbelt/src/cli/method-map.ts
```

The daemon RPC namespace is dotted (`daemon.status`, `agent.list`, `call.start`); the CLI is noun/verb
(`mx-agent daemon status`, `mx-agent agent list`, `mx-agent call start`) per the verified surface.
Strategy:

- **Default rule:** split `method` on `.` → `[noun, verb]`, emit `[noun, verb, '--json']`. Covers the
  M0 read methods (`daemon.status`, `daemon.ping`, `agent.list`, `agent.show`, `agent.tools`,
  `workspace.status`) the IPC client already round-trips.
- **Param passing:** for methods that take structured params, append `--input-json -` and write the
  JSON `params` to the child's **stdin** (preferred) rather than placing them on argv. Rationale:
  argv is world-readable via `/proc/<pid>/cmdline` and `ps`, so even non-secret args should not ride
  the command line; stdin avoids that exposure entirely. (The surface doc confirms `--input-json` on
  `task create`; verify `--input-json -` / stdin support per verb during implementation — open
  question.) Where a verb only accepts discrete flags, add a per-method entry mapping known param keys
  to flags; keep that table small and explicit, scoped to methods actually used in M0.
- Keep the map **data-driven and unit-testable** (pure function `methodToArgv(method, params) →
  {argv, stdin?}`), so adding mutating verbs in M1 is a table edit, not a rewrite.

### 4. `safeSubprocessEnv` (toolbelt-local, tighter than adw_sdlc)

```ts
// packages/toolbelt/src/cli/env.ts
export const ENV_DENY_PREFIXES = ['MATRIX_', 'MX_AGENT_'] as const;     // never forwarded, ever
// Minimal: only what the mx-agent CLI needs to find its socket/config + run.
export const BASE_ENV_ALLOW = ['HOME', 'PATH', 'XDG_RUNTIME_DIR', 'XDG_DATA_HOME',
                               'TMPDIR', 'LANG', 'LC_ALL', 'TERM'] as const;
export function safeSubprocessEnv(opts: {
  source?: Record<string, string | undefined>;   // default process.env
  extraAllow?: readonly string[];                 // deny-prefixed keys dropped even here
}): Record<string, string>;
```

Semantics: deny-by-default — start from `{}`, copy only allowlisted keys that are present in `source`;
a key matching `ENV_DENY_PREFIXES` is never copied, even if requested via `extraAllow`. **No provider
keys, no `GH_TOKEN`, no `*_API_KEY`, no `*_TOKEN`** are in the allowlist — the toolbelt child is the
daemon binary, which needs none of them (it reads on-disk creds). This is deliberately stricter than
`adw_sdlc/src/env.ts`; document the divergence in the file header so the two are not "unified" later by
mistake. (Confirm the exact base-allow set against the live CLI during implementation — e.g. whether
the CLI honors `XDG_CONFIG_HOME` — and trim to the minimum that works.)

### 5. Exports

Extend `packages/toolbelt/src/index.ts` to export `CliClient`, `CliClientOptions`, the `MxTransport`
interface, `CallOptions`, `safeSubprocessEnv`, and the transport-error alias — mirroring how the IPC
surface is exported today.

## Affected Files / Packages / Modules

Owning package: **`packages/toolbelt`** (`@mx-loom/toolbelt`).

**Read for context:**
- `packages/toolbelt/src/ipc/client.ts`, `ipc/errors.ts`, `ipc/types.ts`, `ipc/socket-path.ts`
- `packages/toolbelt/src/index.ts`
- `packages/toolbelt/test/client.test.ts`, `test/client.integration.test.ts` (test conventions)
- `adw_sdlc/src/env.ts` (env-allowlist pattern), `adw_sdlc/src/exec.ts` (subprocess convention)
- `docs/mx-agent-surface-v0.2.1.md` (CLI verb forms, `--json`, `--input-json`)

**Create:**
- `packages/toolbelt/src/cli/client.ts` — `CliClient`
- `packages/toolbelt/src/cli/env.ts` — toolbelt-local `safeSubprocessEnv` + allowlist constants
- `packages/toolbelt/src/cli/method-map.ts` — `methodToArgv()` mapping
- `packages/toolbelt/src/transport.ts` — `MxTransport` interface + transport-error alias (or fold the
  alias into `ipc/errors.ts`)
- `packages/toolbelt/test/cli-client.test.ts` — `CliClient` over a **fake mx-agent** fixture script
- `packages/toolbelt/test/cli-env.test.ts` — allowlist / secret-leak assertions
- `packages/toolbelt/test/method-map.test.ts` — argv mapping
- `packages/toolbelt/test/cli-client.integration.test.ts` — `skipIf` gated on a real `mx-agent` binary
- `packages/toolbelt/test/fixtures/fake-mx-agent.mjs` — a tiny script that emits canned `--json` output
  and can echo its received env (for the leak test)

**Modify:**
- `packages/toolbelt/src/index.ts` — new exports
- `packages/toolbelt/src/ipc/client.ts` — add `implements MxTransport` (type-only)
- `packages/toolbelt/package.json` — description note ("T002 IPC + T003 CLI fallback transport")

## API / Interface Changes

- **New public exports** from `@mx-loom/toolbelt`: `CliClient`, `CliClientOptions`, `MxTransport`,
  `CallOptions` (shared), `safeSubprocessEnv`, and a transport-error alias (`TransportError` /
  `TransportErrorCode`) over the existing `IpcError` / `IpcErrorCode`.
- **No change to `IpcClient`'s behavior**; it gains an `implements MxTransport` annotation only.
- **CLI surface consumed (not defined here):** `mx-agent <noun> <verb> --json [--input-json -]`. T003
  does not change the mx-agent CLI; it consumes the existing `v0.2.1` surface.
- **New non-secret env override read by the toolbelt:** `MXL_AGENT_BIN` (parent-process only; never
  forwarded to the child). Document it.
- No daemon-RPC or tool-descriptor surface changes (those are M1).

## Data Model / Protocol Changes

- **No new wire protocol.** The CLI's `--json` stdout is parsed and **normalized to the same in-memory
  result** `IpcClient.call()` returns for the same method (e.g. `daemon.status` → `DaemonStatus` from
  `ipc/types.ts`, reused unchanged).
- **Error taxonomy:** reuse the existing closed `IpcErrorCode` set as the shared transport taxonomy; CLI
  failures map onto it per the table in Proposed Implementation §1. No new codes required for M0 (a
  possible `spawn_failed` is flagged as a decision, not a commitment).
- The **canonical result envelope** (`{status,result,error,handle,approval,audit_ref}` from design §4)
  and the model-facing `error.code` set (`policy_denied|untrusted_key|…`) are **M1 (T102)** and are not
  introduced here — T003 stays at raw transport level (it returns the daemon RPC `result`, normalizes
  *transport* errors), so it must not imply the envelope exists yet.
- No idempotency-key, audit-row, or schema changes (idempotency/audit land with the tools in M1).

## Security & Compliance Considerations

The CLI transport sits at **Boundary A's chokepoint** and must not weaken the secret boundary. The CLI
path has one exposure the IPC path does not — **subprocess argv and env** — so it is the more
security-sensitive of the two transports.

- **Secret boundary (the load-bearing requirement).** Matrix tokens, Ed25519 signing keys, provider
  keys, and `GH_TOKEN` must never cross Boundary A into the child. The mx-agent CLI child needs **none**
  of them — it reads its signing key (`~/.local/share/mx-agent/signing_key.ed25519`, mode 0600) and
  Matrix session from on-disk daemon state, not from env. Therefore the toolbelt's `safeSubprocessEnv`
  is **deny-by-default** with a minimal base allowlist (no `*_API_KEY`, no `*_TOKEN`, no `GH_TOKEN`),
  and `MATRIX_*` / `MX_AGENT_*` are dropped unconditionally (even via `extraAllow`). Acceptance
  criterion 2 is enforced by a test that poisons the source env with `MATRIX_FOO`, `MX_AGENT_BAR`,
  `ANTHROPIC_API_KEY`, `GH_TOKEN` and asserts none appear in the child's received env.
- **Cognition produces only a signed request; it grants no authority.** The CLI transport carries a
  request to the daemon and returns a result. All enforcement — Ed25519 trust store, deny-by-default
  `policy.toml`, sandbox, human approval gates — runs **out-of-process on the receiving daemon**. The
  toolbelt cannot sign and cannot self-authorize; switching transport from socket to CLI changes
  nothing about where "yes" is decided.
- **No trust/policy/approval mutation surface.** T003 adds none. The model never sees credentials;
  approval reaches it only as a result status (M1), re-validated against live policy at release —
  unaffected by transport choice.
- **Secret-free tool contract / reject credential-shaped args.** No field carries credentials inbound
  or outbound. Before building argv, reject params whose **keys** look credential-shaped
  (`/(?:token|secret|password|api[_-]?key|signing[_-]?key|matrix_)/i`) or whose **values** match
  known secret shapes — fail with a transport error rather than spawning. This matters acutely on the
  CLI path because argv is world-visible via `/proc/<pid>/cmdline` and `ps`.
- **Prefer stdin over argv for structured params** (`--input-json -`), so non-secret args also avoid
  the process table. Argv is reserved for the verb and `--json` flags.
- **Logging / redaction.** Never log the child env, never log argv that could contain args, never log
  raw stdout/stderr on the error path without redaction. Transport-error messages are
  human-readable and **secret-free** (mirror the IPC client's message discipline). Bound stdout/stderr
  capture to avoid memory-exhaustion from a hostile CLI.
- **Audit correlation (`audit_ref`).** Audit lives in the M1 result envelope (T102/T113), not in raw
  transport; T003 introduces no audit rows but must not strip any `audit_ref` the daemon includes in a
  result payload — it passes the `result` through verbatim.

## Testing Plan

**Unit (no daemon, fake CLI):**
- `cli-env.test.ts` — `safeSubprocessEnv`: deny-by-default; `MATRIX_*`/`MX_AGENT_*` dropped even via
  `extraAllow`; provider keys + `GH_TOKEN` absent; only base-allow keys present in source are forwarded;
  injectable `source`. **Secret-leak assertion = acceptance criterion 2.**
- `method-map.test.ts` — `daemon.status` → `['daemon','status','--json']`; param method emits
  `--input-json -` + stdin payload; unknown/oddly-shaped method handled deterministically.
- `cli-client.test.ts` (fake `mx-agent` fixture script via `cliBin`):
  - **Result-shape parity (acceptance criterion 1):** fixture emits a `daemon.status` `--json` payload;
    assert `CliClient.status()` resolves to the same `DaemonStatus` shape the IPC mock-daemon test
    asserts (ideally a shared assertion helper across `client.test.ts` and `cli-client.test.ts`).
  - **Error normalization:** binary-absent (`cliBin` → nonexistent path) → `not_running`; fixture exits
    non-zero with a JSON-RPC error → `rpc` (message/code extracted); fixture prints non-JSON on exit 0 →
    `protocol`; fixture sleeps past `timeoutMs` → `timeout` (and the child is killed).
  - **Secret-shaped arg rejection:** `call('x', {api_key:'…'})` rejects *before* spawn (fixture asserts
    it was never invoked).
  - **Concurrency:** multiple concurrent `call()`s each get an independent subprocess and correct result.
- `index` export test (optional) — public surface present.

**Integration (gated, real binary):**
- `cli-client.integration.test.ts` — `describe.skipIf` gated on an `mx-agent` binary being resolvable
  (mirror `client.integration.test.ts`'s socket gate). Round-trip `daemon.status` through the real CLI
  and assert it equals the IPC client's `daemon.status` result on the same host (the strongest form of
  "same typed result shape"). Skips cleanly in CI without a daemon/binary.

**Secret-boundary / redaction:** covered by `cli-env.test.ts` (env) + the arg-rejection case; add a test
that an induced transport error message contains none of the poisoned secret values.

**Conformance:** the cross-transport parity assertion feeds the T007/#7 conformance suite later (note
the linkage; don't build the suite here).

## Documentation Updates

- **`docs/mx-agent-surface-v0.2.1.md`** — add a short "CLI `--json` fallback" subsection: the verb
  forms used, `--json` output shape vs the RPC `result` (record what the live CLI actually emits —
  wrapped or bare — once verified), and `--input-json -`/stdin support per verb.
- **`docs/backlog.md`** — tick T003 acceptance boxes when implemented; note that T004/#4 (transport
  selection) is unblocked.
- **`packages/toolbelt/package.json`** — update the `description` to mention the CLI fallback transport.
- **`docs/mx-agent-tool-fabric-design.md`** — no change required (it already names the `--json` CLI
  fallback in §8/§10); add a pointer only if a CLI-specifics note is wanted.
- **Help/JSDoc** — document `CliClient`, `CliClientOptions`, `MxTransport`, `safeSubprocessEnv`, and the
  `MXL_AGENT_BIN` override as public API (the repo documents public APIs via JSDoc, as in `ipc/`).

## Risks and Open Questions

1. **CLI `--json` output shape (verify against live binary).** Does `mx-agent <noun> <verb> --json` print
   the bare RPC `result`, or wrap it (e.g. `{ok, data}` / a JSON-RPC-like envelope)? The normalizer must
   unwrap to match `IpcClient.call()`. T001 verified the RPC `daemon.status` shape but not the CLI's
   `--json` framing. **Recommend a short live check (T001-style) before/with implementation.**
2. **Param passing per verb.** `--input-json` is confirmed for `task create`; is `--input-json -`
   (stdin) accepted generally, and which verbs need discrete flags instead? Affects `method-map.ts`.
   Scope the M0 read methods first; finalize mutating-verb argv with the M1 tools.
3. **What "fallback" means operationally.** When the daemon socket is absent, can a one-shot
   `mx-agent … --json` still serve the request (does the CLI auto-spawn/own a daemon, or only work when
   one is up)? If the CLI also requires a live daemon, the "fallback" value is narrower (alternate path,
   not daemon-independent). This shapes T004's selection logic but does **not** block building the CLI
   transport. **Flag for confirmation.**
4. **Shared error type — refactor scope (decision).** Recommended: alias `IpcError`/`IpcErrorCode` as
   the transport-neutral `TransportError`/`TransportErrorCode` and reuse them, rather than introduce a
   parallel error class. Confirm this naming and whether to add `invalid_args` / `spawn_failed` to the
   closed set now or keep the strict IPC subset and reuse `protocol`/`connect_failed`.
5. **`MxTransport` interface placement (decision).** New `src/transport.ts` vs co-locating in
   `ipc/`. Recommend a dedicated `transport.ts` since it is transport-neutral and T004 will depend on it.
6. **Base env allowlist exactness.** The minimal set the mx-agent CLI needs (`HOME`, `PATH`,
   `XDG_RUNTIME_DIR`, `XDG_DATA_HOME`, …) should be **trimmed to what actually works** against the live
   binary; over-broad allowlists are a latent leak risk. Verify during implementation.
7. **Async vs sync spawn.** Recommend async `spawn` (parity with the async `IpcClient`, real timeouts,
   concurrency). `adw_sdlc` uses `spawnSync`, but its control plane is deliberately sequential; the
   toolbelt's is not. Confirm.
8. **Do not import `adw_sdlc/src/env.ts`.** Its allowlist forwards provider keys / `GH_TOKEN` by design
   and would violate the toolbelt's stricter boundary. The toolbelt gets its own `safeSubprocessEnv`.
9. **Stale template caveat.** The planning template says "repo is docs-only"; that is no longer true for
   M0 (`packages/toolbelt/src/ipc/` exists). This spec builds on real code.

## Implementation Checklist

1. [ ] **Verify CLI behavior live** (depends on access to an `mx-agent v0.2.1` binary): run
   `mx-agent daemon status --json`; record whether output is bare `result` or wrapped, and confirm
   `--input-json -`/stdin param passing. Update `docs/mx-agent-surface-v0.2.1.md` with findings.
2. [ ] Add `src/transport.ts`: `MxTransport` interface + `CallOptions`; export a transport-neutral
   `TransportError`/`TransportErrorCode` alias over `IpcError`/`IpcErrorCode` (decision #4).
3. [ ] Annotate `IpcClient implements MxTransport` (type-only; no behavior change).
4. [ ] Add `src/cli/env.ts`: deny-by-default `safeSubprocessEnv` + `ENV_DENY_PREFIXES` + minimal
   `BASE_ENV_ALLOW`; file header documenting why it is stricter than `adw_sdlc/src/env.ts`.
5. [ ] Add `src/cli/method-map.ts`: `methodToArgv(method, params) → {argv, stdin?}` (default dotted-split
   rule + `--input-json -` for structured params + small per-verb table for M0 read methods).
6. [ ] Add `src/cli/client.ts`: `CliClient implements MxTransport` — bin resolution (`cliBin` →
   `MXL_AGENT_BIN` → `mx-agent`), credential-shaped-arg rejection, async `spawn` with scrubbed env,
   stdin param write, bounded stdout/stderr capture, per-call timeout + kill, JSON parse, error
   normalization per the table, `status()`/`ping()` delegators, no-op `close()`.
7. [ ] Update `src/index.ts` exports (`CliClient`, `CliClientOptions`, `MxTransport`, `CallOptions`,
   `safeSubprocessEnv`, transport-error alias).
8. [ ] Add `test/fixtures/fake-mx-agent.mjs`: canned `--json` for `daemon status`; modes to exit
   non-zero / emit non-JSON / sleep / echo received env (for the leak test).
9. [ ] Add `test/cli-env.test.ts` (secret-leak / allowlist — **AC 2**).
10. [ ] Add `test/method-map.test.ts` (argv mapping).
11. [ ] Add `test/cli-client.test.ts` (result-shape parity **AC 1**, error normalization, arg
    rejection, timeout/kill, concurrency) — share the `DaemonStatus` assertion with `client.test.ts`.
12. [ ] Add `test/cli-client.integration.test.ts` (`skipIf` on real binary; cross-transport
    `daemon.status` equality).
13. [ ] Update `packages/toolbelt/package.json` description; add JSDoc to all new public symbols.
14. [ ] `pnpm --filter @mx-loom/toolbelt typecheck && pnpm --filter @mx-loom/toolbelt test` green;
    confirm no secret-bearing env keys appear in any test-captured child env.
15. [ ] Tick T003 boxes in `docs/backlog.md`; note T004/#4 unblocked.

---
_Spec for T003/#3. Blocked-by #1 (satisfied). Unblocks #4 (transport selection). Substrate pin:
mx-agent `v0.2.1`. Out of scope: transport selection (#4), tools/envelope (M1)._
