# Contract Conformance Suite Gating the Version Pin (T007 / #7)

| | |
|---|---|
| Issue | #7 · `area/ci` `area/contract` `priority/P0` `type/test` |
| Milestone | M0 — SDK seam |
| Estimate | M |
| Backlog | `docs/backlog.md` → `T007` |
| Blocked-by | T004 (unified client — **landed**), T006 (version pin — **partly landed**) |
| Out of scope | Per-runtime conformance certification (T601 / #45) |
| Source design | `docs/mx-agent-tool-fabric-design.md` §4, §9; `docs/mx-agent-surface-v0.2.1.md`; `docs/mx-agent-pin.md` |

## Problem Statement

The mx-loom toolbelt encodes assumptions about the pinned `mx-agent v0.2.1` daemon's
JSON-RPC surface — method names, param shapes, the `AgentState` record, the
`{agent, liveness}` list rows, and (for M1) the `call.start` delegation envelope. Those
assumptions were verified **once, by hand**, during the T001 surface spike
(`docs/mx-agent-surface-v0.2.1.md`) and are otherwise only exercised by the *gated*
integration suites that **skip cleanly when no daemon is present** (`describe.skipIf(!socketExists)`).

That leaves two gaps:

1. **No automated gate proves the surface still holds.** A new `mx-agent` release could
   rename a method, reshape `AgentState`, or change `call.start`'s flags, and nothing in
   CI would notice — the gated suites would simply skip, stay green, and the drift would
   surface only as a runtime failure much later.
2. **The pin-bump policy references a gate that does not exist.** `docs/mx-agent-pin.md`
   already states a bump lands "**only** when the conformance suite (backlog **T007 / #7**)
   passes against the new version." That suite, and the CI job that runs it, are not yet
   built — so the documented gate is currently unenforceable.

T007 closes both gaps: an **automated conformance suite** that round-trips
`agent.register` / `agent.list` / `call.start` against a **live** pinned daemon in CI,
goes **red on surface drift**, and is wired in as the executable pin-bump gate the pin
doc already promises.

## Goals

- A conformance test suite that, against a **live `mx-agent v0.2.1` daemon**, asserts:
  - `daemon.status.version` matches `.mx-agent-version` (the pin is the substrate under test).
  - `agent.register` returns a full, well-shaped `AgentState` (field-for-field with the verified surface).
  - `agent.list` returns `[{agent, liveness}]` rows and the just-registered agent is `active`.
  - `call.start` round-trips a named-tool delegation (`CallRequest` → `CallResponse`) to a
    **second** registered target agent, mapping into the toolbelt's resolved result.
  - Known-bad inputs map onto the **closed** transport error taxonomy (drift in error
    behavior is also caught).
- A **CI job** that provisions the live daemon (homeserver + pinned binary + bootstrap) and
  runs the suite — and **fails the build** if the daemon is unreachable or the surface has
  drifted (no silent skip in the conformance job).
- The suite is **green on `v0.2.1`** and **documented as the pin-bump gate** (cross-linked
  from `docs/mx-agent-pin.md`, the toolbelt README, and the backlog).
- A reusable **bring-up fixture** (single-daemon, plus the two-daemon variant `call.start`
  needs) that later conformance/golden work (T114, T601) can extend rather than reinvent.

## Non-Goals

- **Per-runtime certification (T601 / #45).** This suite certifies the *toolbelt ⇄ daemon*
  surface (Boundary B), not that ADK / Claude / OpenCode / Pi each consume the tools
  correctly. That is the M6 "MX-Agent inside" badge.
- **The model-facing result envelope and `mx_*` tools (M1, T101–T108).** At M0 the suite
  exercises raw daemon RPC through the existing `MxClient`/`MxSession`, not the normalized
  `{status, result, error, audit_ref}` envelope, which does not exist yet.
- **The guarded-exec / approval-gated golden path (T114).** `call.start` is exercised on a
  **non**-approval-gated named tool here; the full approval round-trip is M1.
- **Bumping the pin.** T007 builds the gate; actually moving off `v0.2.1` is future work
  that *uses* the gate.
- **Multi-tenant, audit-mirror, or observability assertions** (M5) — tenant-agnostic at M0.

## Relevant Repository Context

The stack is TypeScript (pnpm workspace, Node ≥20.19, vitest 4, Apache-2.0). Two real
packages exist today: `packages/toolbelt` (`@mx-loom/toolbelt`) and `adw_sdlc` (the ADW
pipeline tooling). `pnpm-workspace.yaml` lists `packages/*` and `adw_sdlc`.

**What exists and is reusable:**

- **`packages/toolbelt/src/client.ts`** — `MxClient` / `createClient` (T004, landed). The
  single typed entry point across Boundary B: IPC primary, CLI fallback, conservative retry.
  `MxClient.call(method, params, opts)` resolves the bare daemon RPC `result`; `status()` /
  `ping()` are conveniences. This is what the conformance suite drives.
- **`packages/toolbelt/src/session.ts`** — `openSession` / `MxSession` (T005, landed):
  `agent.register` on open, liveness heartbeat, `agent.list`-backed `liveness()`,
  correlation threading. The suite uses this for the `agent.register`/`agent.list` round-trips.
- **`packages/toolbelt/src/agent-state.ts`** — `AgentState`, `AgentListEntry`,
  `AgentLiveness` types mirroring the verified `com.mxagent.agent.v1` shape.
- **`packages/toolbelt/src/transport.ts`** + **`src/ipc/errors.ts`** — `TransportError` and
  the **closed** `TransportErrorCode` set (`not_running | timeout | rpc | closed |
  connect_failed | frame | protocol | invalid_args`). The error-taxonomy assertions pin to
  this set. **Note:** this is the *transport* code set, distinct from the M1 *envelope*
  `error.code` set (`policy_denied | untrusted_key | …`) which does not exist yet.
- **`packages/toolbelt/src/guards.ts`** — `assertNoCredentialShapedArgs` (the credential-shaped-arg
  reject, runs on every `MxClient.call`).
- **Existing integration-test pattern** — `test/mxclient.integration.test.ts` and
  `test/session.integration.test.ts` show the established shape: a **fixture-backed** suite
  (always runs, driven by `test/fixtures/mock-mx-agent.mjs`) plus a **live-daemon** suite
  gated by `describe.skipIf(!existsSync(resolveSocketPath()))`. The live `session.integration`
  suite already drives `workspace.create` → `openSession` → `agent.list` and documents the
  v0.2.1 `agent.register` param shape (flat `cwd`/`project_id`/`max_invocations`).
- **`docs/mx-agent-surface-v0.2.1.md`** (T001) — the verified method/shape table. Records
  `agent.register` / `agent.list` / `agent.tools` as fully round-tripped, and `call.start` /
  `exec.start` / `task.*` as "flags confirmed" but **not yet round-tripped** because they
  "need a two-daemon fixture — reuse `mx-agent/dev/matrix` + a second registered agent."
- **`.mx-agent-version`** = `v0.2.1` and **`docs/mx-agent-pin.md`** (T006) — the pin file and
  the deny-by-default pin-bump policy, which **already names T007 as the gate**. T006's
  remaining checkbox work overlaps here; T007 makes the referenced gate real.

**What does NOT exist yet (decisions to confirm, not assume built):**

- **No CI at all.** There is **no `.github/` directory** and no workflow files anywhere in
  the repo. T007 introduces the **first** GitHub Actions workflow to `mx-loom`. (The CI
  provider — GitHub Actions — is assumed from the `area/ci` label and the `kortiene/mx-loom`
  GitHub home; confirm before building.)
- **No daemon-provisioning automation in this repo.** The Tuwunel homeserver bring-up
  (`scripts/matrix_dev.sh`) and the `mx-agent` binary live in the **`mx-agent` repo**, not
  here. How CI obtains them (download the pinned release binary + vendor or check out the
  compose) is an open decision (see Risks).
- **No `call.start` exercise anywhere.** No code path in the toolbelt issues `call.start`
  yet (`mx_delegate_tool` is T105/M1). The suite issues it via the **raw**
  `MxClient.call('call.start', …)` seam until the M1 tool lands.
- **No `policy.toml` / trust fixture in-repo.** The minimal allow-policy fixture is T112
  (M1); T007 needs a *minimal* receiver-side policy + trust just to let `call.start` succeed
  (see Risks — possible small overlap with T112).
- **No conformance test files, no `test:conformance` script, no conformance vitest config.**

## Proposed Implementation

The work has four parts: (1) a tier-structured conformance **suite**, (2) a **mode switch**
that makes the conformance job fail-not-skip, (3) the **CI workflow** that provisions a live
daemon and runs the suite, and (4) the **docs** wiring it in as the pin gate.

### 1. Conformance suite (the tests)

Place the suite in `packages/toolbelt/test/conformance/` with the filename convention
`*.conformance.test.ts`, so it is selectable independently of the normal `*.test.ts` run.
The suite drives the **public toolbelt API** (`createClient`, `openSession`,
`MxClient.call`) — it verifies "the toolbelt's assumed surface against the pinned daemon,"
so it must go through the same client real callers use, not raw sockets.

Structure it in three tiers so the cheap, always-available checks are separable from the
heavyweight two-daemon one:

**Tier 0 — pin identity (single daemon).** `surface.conformance.test.ts`
- Read `.mx-agent-version` from the repo root; assert `client.status().version` equals the
  pinned version (normalize the leading `v`). A daemon that is *not* the pinned version is
  itself drift → red.

**Tier 1 — discovery round-trips (single daemon).** `agent-lifecycle.conformance.test.ts`
- `openSession(...)` → assert `agent.register` returns an `AgentState` with every field the
  toolbelt's `AgentState` type relies on (`agent_id`, `kind`, `matrix_user_id`, `device_id`,
  `signing_key_id`, `signing_public_key`, `status`, `capabilities`, `tools`, `workspace`,
  `load`, `last_seen_ts`, `state_rev`). Assert the public-key fields are present **and** that
  no private-key/token-shaped field leaked into the record (drift *and* secret-boundary check).
- `session.liveness()` (→ `agent.list`) → assert the row shape `{agent, liveness}` and that
  the just-registered `agent_id` is present with `liveness: "active"`.
- A deliberately bad call (e.g. `client.call('does.not.exist')`, and a malformed-params
  `agent.register`) → assert it rejects with a `TransportError` whose `.code` is in the
  closed set (`rpc` / `invalid_args` as appropriate). This catches error-behavior drift.

**Tier 2 — delegation round-trip (two daemons).** `delegate.conformance.test.ts`
- Pre-condition (fixture, out-of-band): a **second** daemon B is running, logged in as a
  distinct Matrix user, joined to the same workspace room, registered as a target agent that
  **publishes a named tool** (e.g. a trivial `run_tests@1.0.0`-shaped echo tool), with mutual
  Ed25519 trust established and a minimal receiver policy allowing that tool.
- The suite (pointed at daemon **A** only) issues `MxClient.call('call.start', { room, agent:
  <B's agent_id>, tool: '<name>@<ver>', args: {…}, idempotency_key })` and asserts the
  `CallResponse` resolves to the target tool's output shape. Because the M1 envelope does not
  exist yet, the suite asserts on the **raw** `CallResponse` fields documented in the surface
  doc, not on `{status, result, audit_ref}`.
- Negative: a `call.start` to a tool **not** allowed by B's policy returns the daemon's
  policy-denied response (assert the daemon signals denial; do not assert the M1
  `policy_denied` envelope code, which is not built).

The first two tiers need **one** daemon (already exercised by the live `session.integration`
suite); only Tier 2 needs the two-daemon fixture. Keeping them in separate files lets CI run
Tier 0/1 unconditionally and stage Tier 2 once the two-daemon bring-up is wired.

### 2. Fail-not-skip mode (`MXL_CONFORMANCE`)

The existing integration suites *skip* when no daemon is found — correct for a developer
laptop, **wrong** for the conformance gate, where a missing daemon must be a **failure**
(otherwise "red on drift" silently degrades to "always green"). Introduce a small helper,
e.g. `test/conformance/_harness.ts`:

```ts
// When MXL_CONFORMANCE=1 (set ONLY by the conformance CI job), a missing/unreachable
// daemon is a hard failure. Otherwise (local dev, normal unit CI) the suite skips cleanly.
export const CONFORMANCE_REQUIRED = process.env['MXL_CONFORMANCE'] === '1';
export const daemonReachable = existsSync(resolveSocketPath(/* honor MXL override */));
// Use: describe.skipIf(!CONFORMANCE_REQUIRED && !daemonReachable)(...) and, inside a
// beforeAll, throw if CONFORMANCE_REQUIRED && !daemonReachable so the job goes red.
```

So: locally, `pnpm test:conformance` with no daemon → clean skip; in the conformance job,
`MXL_CONFORMANCE=1` with no daemon → red. Tier 2 additionally guards on a
`MXL_CONFORMANCE_TWO_DAEMON=1` (or a resolvable second-agent id) so the single-daemon job
does not fail for lack of daemon B while the two-daemon job is being stood up.

Add scripts to `packages/toolbelt/package.json`:
- `"test:conformance": "vitest run --dir test/conformance"` (or a dedicated
  `vitest.conformance.config.ts` with `include: ['test/conformance/**/*.conformance.test.ts']`).
- Keep the default `"test": "vitest run"` excluding the conformance dir so the fast unit/
  integration CI stays daemon-free. (Confirm vitest include/exclude vs. a separate config —
  a separate `vitest.conformance.config.ts` is the cleanest split.)

### 3. CI workflow (`.github/workflows/conformance.yml`)

This is net-new CI infrastructure. The job must provision a live pinned daemon, then run the
suite. Recommended shape (GitHub Actions, `ubuntu-latest`):

1. **Resolve the pin.** Read `.mx-agent-version` into a job output (single source of truth;
   never hard-code the tag).
2. **Stand up a Matrix homeserver.** A throwaway Tuwunel instance (the T001 setup used
   `mx-agent/dev/matrix` `scripts/matrix_dev.sh up`). In CI this is a service container or a
   `docker compose` step. **Decision (Risks):** vendor a minimal `dev/matrix/compose.yml`
   into mx-loom vs. check out `mx-agent` at the pin and reuse its compose.
3. **Install the pinned `mx-agent` binary** for the resolved version (download the release
   asset; cache by version). The binary, not a `main` build, is what the pin means.
4. **Bootstrap (single-daemon tier):** start daemon A with an isolated `XDG_RUNTIME_DIR`/data
   dir; register a throwaway user; `auth login`; `workspace.create`. Export the socket path.
5. **Bootstrap (two-daemon tier):** start daemon B with its own runtime/data dir + a second
   throwaway user; join B to A's room; register B as a target agent publishing the fixture
   named tool; establish **mutual trust** via `mx-agent trust approve` (operator/out-of-band —
   never a toolbelt path); load a minimal allow-`policy.toml` on B. This is the costly part;
   gate it behind its own step/flag so Tier 0/1 can land first.
6. **Run** `pnpm install` then `pnpm --filter @mx-loom/toolbelt test:conformance` with
   `MXL_CONFORMANCE=1` (+ `MXL_CONFORMANCE_TWO_DAEMON=1` and the resolved socket/agent ids for
   Tier 2).
7. **Teardown** daemons + homeserver; never persist any session/keys.

Trigger on `pull_request` and `push` to the default branch, and expose a
`workflow_dispatch` input for the target version so a **pin-bump PR** can run the gate
against a candidate version before editing `.mx-agent-version`.

### 4. Documentation wiring (the gate)

- Update `docs/mx-agent-pin.md` step 1 to point at the **actual** suite path + how to run it
  (`pnpm --filter @mx-loom/toolbelt test:conformance`) and the CI job name, so the policy is
  executable, not aspirational.
- Add a "Conformance" section to `packages/toolbelt/README.md`: what the suite asserts, how
  to run it locally (with a live daemon), and that it is the pin-bump gate.
- Tick `docs/backlog.md` T007 acceptance boxes and note the suite/job locations; update the
  surface doc's "full round-trip pending" row for `call.start` once Tier 2 is green.

## Affected Files / Packages / Modules

**New:**
- `packages/toolbelt/test/conformance/surface.conformance.test.ts` (Tier 0 — pin/version).
- `packages/toolbelt/test/conformance/agent-lifecycle.conformance.test.ts` (Tier 1 — register/list/errors).
- `packages/toolbelt/test/conformance/delegate.conformance.test.ts` (Tier 2 — `call.start`).
- `packages/toolbelt/test/conformance/_harness.ts` (fail-not-skip helper + pin reader + env gates).
- `packages/toolbelt/vitest.conformance.config.ts` (conformance include glob) — *if* the
  separate-config split is chosen over `--dir`.
- `.github/workflows/conformance.yml` (first CI workflow in the repo).
- CI bring-up scripts under `scripts/` or `.github/` (homeserver + daemon bootstrap, two-daemon
  fixture, mutual trust, minimal policy) — exact home is an open decision.
- Possibly `dev/matrix/compose.yml` + a minimal `policy.toml` fixture if vendored rather than
  reused from `mx-agent`.

**Modified:**
- `packages/toolbelt/package.json` — add `test:conformance` (and keep default `test` excluding it).
- `docs/mx-agent-pin.md` — point the policy at the real suite + CI job.
- `packages/toolbelt/README.md` — conformance section.
- `docs/backlog.md` — tick T007 ACs; note locations.
- `docs/mx-agent-surface-v0.2.1.md` — flip `call.start` from "round-trip pending" to verified
  once Tier 2 passes.

**Read (no change expected):**
- `packages/toolbelt/src/{client,session,agent-state,transport,guards}.ts`,
  `src/ipc/{errors,socket-path,types}.ts`, and the existing
  `test/{mxclient,session}.integration.test.ts` (pattern source).
- `.mx-agent-version`, `pnpm-workspace.yaml`.

## API / Interface Changes

**None to the toolbelt's public TypeScript API.** T007 is a test + CI + docs change; it adds
no exports to `packages/toolbelt/src/index.ts` and changes no client/session surface. It
*consumes* the existing `createClient` / `openSession` / `MxClient.call`.

New **developer-facing** surfaces (not library API):
- `pnpm --filter @mx-loom/toolbelt test:conformance` script.
- `MXL_CONFORMANCE` / `MXL_CONFORMANCE_TWO_DAEMON` env switches (CI-only; documented).
- A `conformance` GitHub Actions workflow + its `workflow_dispatch` version input.

No daemon-RPC surface change — the daemon is the system under test, treated as fixed at the pin.

## Data Model / Protocol Changes

**None.** No new result-envelope shape, error-taxonomy code, tool schema, idempotency-key
format, audit-row, or serialization is introduced. The suite **asserts against** existing
shapes:
- `AgentState` / `AgentListEntry` (`src/agent-state.ts`, mirroring `com.mxagent.agent.v1`).
- The closed `TransportErrorCode` set (`src/ipc/errors.ts`).
- The `call.start` `CallRequest`/`CallResponse` fields as documented in
  `docs/mx-agent-surface-v0.2.1.md` (raw daemon shape; the M1 normalized envelope is **not**
  introduced here).

`call.start` carries a client-supplied `idempotency_key` per the contract (§4.4); the suite
**uses** it but defines no new format.

## Security & Compliance Considerations

The conformance fixture spins up real daemons and a real homeserver, so the secret boundary
must hold *in the test/CI harness too* — the suite both relies on and **asserts** it.

- **Secret boundary (Boundary A) holds in-suite.** Matrix tokens, the Ed25519 **private**
  signing key, provider keys, and `GH_TOKEN` never enter the test process, the toolbelt, or
  any tool payload. They live only in each daemon's on-disk state
  (`~/.local/share/mx-agent/signing_key.ed25519`, mode 0600) and the daemon's own Matrix
  session. The CLI-fallback leg already runs under the deny-by-default env allowlist
  (`src/cli/env.ts`); the conformance job inherits that. **Add an explicit assertion** that
  the `AgentState` returned by `agent.register` carries only the **public**
  `signing_public_key` / `signing_key_id` and no private-key/token-shaped field — drift that
  began leaking a secret would fail the suite.
- **Reject credential-shaped args.** `MxClient.call` already runs
  `assertNoCredentialShapedArgs`; the suite must never pass a credential-shaped arg into
  `call.start`/`agent.register` (it would be rejected with `invalid_args`), and a negative
  test can assert that rejection stays intact.
- **Out-of-process enforcement is exercised, not bypassed.** Trust (Ed25519 store), the
  receiver `policy.toml`, sandbox, and any approval gate all execute on the **receiving**
  daemon (B). The suite cannot and must not grant authority — it only issues a *signed
  request* via daemon A and observes B's verdict. Establishing trust + policy for the fixture
  is an **operator/out-of-band** action in the bring-up script (`mx-agent trust approve`,
  policy file load) — **never** a toolbelt call and **never** a model tool. The
  `policy_denied` negative case proves deny-by-default enforcement is real.
- **No trust/policy/approval mutation tools.** Nothing in the suite or harness exposes
  `trust.*` / `approval.decide` / `policy.*` as a model-callable surface; they are invoked
  only by the operator-role bootstrap script outside the toolbelt.
- **Audit correlation.** At M0 there is no `audit_ref` envelope to assert (M1/T102/T113). The
  suite should not imply audit correlation exists yet; it may record `correlation_id`
  threading (already covered by T005's suite) but must not assert an `audit_ref` field that
  is unbuilt.
- **Logging / redaction.** CI logs and test output must never print Matrix tokens, signing
  keys, or homeserver credentials. Use **throwaway, synthetic** users/secrets generated at
  job time (never committed); scrub daemon logs before upload; assert no
  `MATRIX_*`/`MX_AGENT_*`/`syt_`/`ghp_`/`xox[bp]-` pattern appears in any value the suite
  reads back (the session integration suite already does this for the debug seam — reuse the
  regex). No real or long-lived credential ever enters the repo or the workflow secrets for
  this throwaway-homeserver setup.

## Testing Plan

T007 **is** a testing deliverable; the "tests" here are the conformance assertions plus the
guards that keep the suite honest.

- **Conformance — Tier 0 (version/pin):** `daemon.status.version === .mx-agent-version`.
- **Conformance — Tier 1 (single daemon):**
  - `agent.register` returns a full `AgentState`; every field the toolbelt type depends on is
    present and typed; only public key material appears (secret-boundary assertion).
  - `agent.list` returns `[{agent, liveness}]`; the registered agent is `active`.
  - Error taxonomy: unknown method → `TransportError.code` in the closed set; malformed
    `agent.register` params → `invalid_args` or `rpc` per daemon behavior.
- **Conformance — Tier 2 (two daemons):**
  - `call.start` to an allowed named tool on agent B resolves to the tool's output shape.
  - `call.start` with a client `idempotency_key` retried does not double-execute (best-effort
    at M0; full idempotency coverage is T102).
  - `call.start` to a policy-denied tool returns the daemon's denial (enforcement is real).
- **Fail-not-skip guard:** a unit-level check that with `MXL_CONFORMANCE=1` and no reachable
  daemon, the suite **fails** (not skips) — so the gate cannot silently degrade. Conversely,
  without the flag and no daemon, it **skips** cleanly (keeps local dev + the fast unit CI
  green).
- **Secret-boundary/redaction:** assert no secret-shaped value appears in any read-back
  record or in captured daemon/test logs.
- **CI integration test:** the workflow itself is validated by running green end-to-end on
  `v0.2.1` (the AC). Add a deliberate-drift smoke check during development (e.g. point the
  version assertion at a wrong pin) to confirm the suite actually goes **red** — then revert.
- **Documentation test:** the pin doc + README instructions are copy-pasteable and match the
  real script/job names.

The normal fast suite (`pnpm test`, fixture-backed + skip-gated integration) must remain
**daemon-free and unchanged** — the conformance dir is excluded from it.

## Documentation Updates

- **`docs/mx-agent-pin.md`** — replace the aspirational T007 reference in the pin-bump policy
  with the concrete suite path, the `test:conformance` command, and the CI job name; state
  that a red conformance run blocks the bump.
- **`packages/toolbelt/README.md`** — new "Conformance" section: what the three tiers assert,
  how to run them against a live daemon locally, and the two-daemon requirement for `call.start`.
- **`docs/backlog.md`** — tick T007 ACs; record suite + workflow locations; note any overlap
  resolved with T006/T112.
- **`docs/mx-agent-surface-v0.2.1.md`** — once Tier 2 is green, move `call.start` from
  "surface present, full round-trip pending" to verified, citing the conformance job.
- **`docs/mx-agent-tool-fabric-design.md`** — no change expected (the conformance discipline
  is already described in §9 "Don't depend on unstable daemon surfaces"); add a back-reference
  only if helpful.

## Risks and Open Questions

1. **CI provider + first-CI bootstrap.** The repo has **no `.github/` and no CI today**.
   GitHub Actions is assumed (label `area/ci`, `kortiene/mx-loom` home) — **confirm** before
   authoring the workflow.
2. **Homeserver + binary provenance.** The Tuwunel bring-up (`scripts/matrix_dev.sh`) and the
   `mx-agent` binary live in the **`mx-agent` repo**. **Decide:** (a) vendor a minimal
   `dev/matrix/compose.yml` + download the pinned release binary into mx-loom, or (b) check
   out `mx-agent` at the pin in CI and reuse its tooling. (a) keeps mx-loom self-contained;
   (b) avoids drift between the two repos' fixtures. This also raises the question of where
   the pinned `mx-agent v0.2.1` **release binary** is published and whether it is fetchable in
   CI.
3. **Two-daemon fixture cost (the main risk).** `call.start` round-trip needs a **second**
   daemon (distinct Matrix identity), a shared room, **mutual Ed25519 trust**, and a minimal
   receiver `policy.toml` — none of which exist in-repo. `agent.register`/`agent.list` are
   fully verified live (single daemon, cheap); `call.start` is only "flags confirmed."
   **Recommendation:** land Tier 0/1 green first (satisfies most ACs and "red on drift"), then
   stage Tier 2 behind its own CI step/flag. **Do not silently drop `call.start`** — the AC
   lists it; if the two-daemon bring-up cannot land within the M0 timebox, flag that
   explicitly and track it, rather than marking the AC done with only register/list.
4. **Live-daemon timing in CI.** The T005 live suite documents that `agent.register` waits for
   Matrix `/sync` to confirm a state event (~29s on a local homeserver), and room creation can
   make the daemon briefly unresponsive. The conformance job needs generous timeouts, a single
   shared workspace/session per run, and care to avoid flakiness. Budget the run accordingly;
   consider marking Tier 2 `call.start` as the slow path.
5. **Minimal policy/trust overlap with T112/T401.** Tier 2 needs a *minimal* allow-policy +
   trust just to make `call.start` succeed. T112 (M1) owns the canonical golden-test
   `policy.toml`; T401 (M4) owns operator trust onboarding. **Decide** whether T007 ships a
   throwaway fixture policy/trust (scoped to the conformance bring-up) or waits on T112 — the
   former is recommended to keep T007 self-contained, with a note to converge on T112's
   fixture later.
6. **`--json` framing still unverified per verb.** The surface doc flags that the exact CLI
   `--json` stdout framing and `--input-json -` stdin support are confirmed only for some
   verbs. If the conformance job runs over IPC (recommended — primary transport, fully
   verified), this does not block it; but a cross-transport conformance variant (IPC vs CLI
   equivalence, as the live `mxclient.integration` suite hints) would surface any per-verb CLI
   gaps. **Decide** whether T007 asserts IPC-only or also CLI equivalence.
7. **T006 overlap.** `.mx-agent-version` and `docs/mx-agent-pin.md` already exist (T006 partly
   landed) and the pin doc already names T007. Confirm whether the remaining T006 checkboxes
   are closed here or separately, to avoid double-ownership of the pin doc edit.

## Implementation Checklist

1. **Confirm prerequisites:** CI provider = GitHub Actions; how CI obtains the pinned
   `mx-agent v0.2.1` binary; vendor-vs-checkout for the homeserver fixture (Risks 1–2).
2. **Add the conformance harness** `test/conformance/_harness.ts`: read `.mx-agent-version`,
   resolve the socket, and implement the `MXL_CONFORMANCE` fail-not-skip + `MXL_CONFORMANCE_TWO_DAEMON`
   gates. Reuse the secret-pattern regex from the session integration suite.
3. **Write Tier 0** `surface.conformance.test.ts`: assert `client.status().version` matches
   the pin.
4. **Write Tier 1** `agent-lifecycle.conformance.test.ts`: `openSession` → assert full
   `AgentState` (public key material only); `liveness()` → `agent.list` row shape + `active`;
   bad-input → closed-set `TransportError.code`.
5. **Write Tier 2** `delegate.conformance.test.ts`: `call.start` to agent B's allowed tool
   resolves to its output; policy-denied negative; idempotency-key retry (best-effort). Guard
   the whole file on the two-daemon flag.
6. **Add scripts/config:** `test:conformance` in `packages/toolbelt/package.json` (+ optional
   `vitest.conformance.config.ts`); ensure default `test` excludes `test/conformance/`.
7. **Author the single-daemon CI bring-up:** resolve pin → start homeserver → install pinned
   binary → start daemon A → login → `workspace.create` → export socket. Run Tier 0/1 with
   `MXL_CONFORMANCE=1`.
8. **Author the two-daemon bring-up:** start daemon B (second user/identity) → join room →
   register B's target agent with a fixture named tool → establish **mutual trust**
   (operator/out-of-band) → load minimal allow `policy.toml` on B. Run Tier 2 with
   `MXL_CONFORMANCE_TWO_DAEMON=1`.
9. **Create `.github/workflows/conformance.yml`** wiring steps 7–8 on `pull_request` + default
   branch + `workflow_dispatch(version)`. Scrub logs; teardown daemons/homeserver; never
   persist keys/sessions.
10. **Prove red-on-drift:** temporarily break the version assertion (or point at a wrong pin)
    and confirm the job fails; revert.
11. **Confirm green on `v0.2.1`** end-to-end in CI (the AC).
12. **Wire the gate in docs:** update `docs/mx-agent-pin.md` (concrete suite/job), add the
    toolbelt README conformance section, tick `docs/backlog.md` T007 ACs, and flip the
    `call.start` row in `docs/mx-agent-surface-v0.2.1.md` once Tier 2 is green.
13. **Verify the secret boundary in-suite:** assert no private-key/token-shaped value appears
    in any read-back record or captured log; confirm credential-shaped args stay rejected.
14. **Confirm the fast unit/integration CI is unaffected** (conformance dir excluded; `pnpm
    test` stays daemon-free).
