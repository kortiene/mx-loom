# Toolbelt Secret-Boundary Guard — No Secret Crosses Boundary A (T008 / #8)

| | |
|---|---|
| Issue | #8 · `area/toolbelt` `priority/P0` `type/feature` |
| Milestone | M0 — SDK seam |
| Estimate | S |
| Backlog | `docs/backlog.md` → `T008` |
| Blocked-by | T004 (unified client — **landed**) |
| Out of scope | Sandbox enforcement (daemon-side) |
| Source design | `docs/mx-agent-tool-fabric-design.md` §4.7 (secret-free contract), §6.6 (sandbox + secret boundary) |

## Problem Statement

mx-agency's standing rule — reinforced in design §6.6 — is that `MATRIX_*`, `MX_AGENT_*`,
provider API keys, and `GH_TOKEN` **never** reach the runtime process or the model context.
The toolbelt is the chokepoint that enforces "no secret crosses Boundary A" (the runtime's
tool-call ABI between cognition and the adaptation layer). The secret-free tool contract
(§4.7) makes this concrete: *no tool field ever carries a credential, inbound or outbound,
and the toolbelt rejects args that look like credential injection.*

Two of the three required mechanisms already exist on the shared client seam (landed in
T003/T004); one does not:

1. **Outbound arg scrubber — exists, but the deny-list is thin.** `assertNoCredentialShapedArgs`
   (`packages/toolbelt/src/guards.ts`) runs on **both** transports via `MxClient.call`
   (hoisted out of the CLI client in T004 to close the IPC-path gap). It rejects
   credential-shaped param keys/values with `invalid_args`. Its deny-list covers the common
   cases but omits several allowlisted-secret shapes the rule names (`mx_agent_`, `GH_TOKEN`,
   provider-key prefixes, AWS keys, PEM private-key headers, bearer/authorization).
2. **Deny-by-default env allowlist — exists, but `extraAllow` can smuggle.** `safeSubprocessEnv`
   (`src/cli/env.ts`) builds the CLI child's environment deny-by-default, dropping
   `MATRIX_*` / `MX_AGENT_*`. But its only hard deny is `ENV_DENY_PREFIXES`; a caller passing
   `extraAllow: ['GH_TOKEN']` (or any `*_TOKEN` / `*_API_KEY`) would re-admit a known secret,
   and nothing asserts that allowlisted-secret env vars never reach a **tool payload**.
3. **Inbound result redaction — does not exist.** Nothing scrubs daemon-returned results
   before they reach the model context. By design the daemon never returns secrets (it owns
   them out-of-process), and the conformance Tier 1 test asserts `agent.register` yields only
   public key material — but there is no defense-in-depth backstop if a daemon bug or a future
   RPC ever surfaced a token-shaped value into a result the model would read.

T008 closes all three: harden the outbound deny-list, harden the env allowlist so it cannot
be widened to a known secret, and add a high-precision **inbound result redaction** pass on
the shared `MxClient.call` seam — plus the tests that pin both acceptance criteria.

The T004 landing note already scopes this exactly: *"T008 hardens the deny-list + adds
inbound result redaction on this shared seam."*

## Goals

- **Reject credential-shaped args (hardened).** Extend `assertNoCredentialShapedArgs`'s
  key/value deny-lists to cover the allowlisted-secret shapes the rule names — at minimum
  `mx_agent_` keys, `GH_TOKEN` / `*_TOKEN`-shaped keys, provider-key value prefixes
  (`sk-ant-`, OpenAI `sk-`), AWS access-key ids (`AKIA…`), and PEM private-key headers
  (`-----BEGIN … PRIVATE KEY-----`) — while keeping error messages secret-free (name the
  key/path, never the value). **AC: an attempt to pass a secret-shaped arg is rejected with
  `invalid_args`.**
- **Inbound result redaction (new).** Add a `redactSecrets()` pass that runs on every
  `MxClient.call` resolved result, replacing any **known secret-shaped value** with a fixed,
  non-reversible placeholder (e.g. `"«redacted»"`) before the result returns toward the model
  context. High-precision (value-shape only) so legitimate results are never corrupted.
  Defense-in-depth: the daemon remains the primary boundary; redaction is a backstop.
- **Harden the env allowlist.** Make `safeSubprocessEnv` refuse to forward any known-secret
  env var even via `extraAllow` (extend the deny set with `*_TOKEN` / `*_API_KEY` / `*_SECRET`
  suffixes + exact `GH_TOKEN`, alongside the existing `MATRIX_` / `MX_AGENT_` prefixes), so an
  allowlisted-secret env var can never reach a tool payload through the CLI leg.
- **Pin the boundary with tests.** **AC: no allowlisted-secret env var appears in any tool
  payload (test asserts)** — populate `process.env` with representative secrets
  (`MATRIX_ACCESS_TOKEN`, `MX_AGENT_*`, `GH_TOKEN`, provider keys) and assert none of their
  values appear in the serialized outbound payload (CLI argv/stdin and IPC frame) for a range
  of calls.
- **Keep it transport-uniform and secret-free in logs.** Both mechanisms run on the shared
  seam so IPC and CLI behave identically; no secret or token is ever logged or persisted, and
  the redaction "fired" signal carries only a code, never the value.

## Non-Goals

- **Sandbox enforcement (daemon-side).** Env scrubbing, resource caps, and namespace
  confinement on the *receiving* daemon (bubblewrap/docker/podman) are the daemon's job
  (§6.6) and out of scope here. T008 is the toolbelt-side chokepoint only.
- **The M1 result envelope / `audit_ref`.** Redaction lands on the **raw** `MxClient.call`
  result seam (M0), not on the normalized `{status, result, error, audit_ref}` envelope,
  which does not exist yet (T102). When the envelope lands, redaction will compose with it;
  T008 does not introduce or imply it.
- **Trust / policy / approval surfaces.** Out-of-process enforcement (Ed25519 trust store,
  `policy.toml`, approval gates) stays on the daemon; T008 exposes no trust/policy/approval
  mutation and no model-facing authority tool.
- **A general DLP / entropy classifier.** Redaction and the arg scrubber match **known
  credential shapes** (named prefixes/patterns), not arbitrary high-entropy strings — keeping
  false positives low on legitimate pass-through delegation args and results. A heuristic
  entropy detector is explicitly deferred (see Risks).
- **Cross-repo removal of mx-agency's `app/src/sdk` stub** (tracked in `kortiene/mx-agency#37`).

## Relevant Repository Context

> **Note — the repo is no longer docs-only.** The backlog/issue boilerplate predates the M0
> code landing. `packages/toolbelt` (`@mx-loom/toolbelt`) is implemented through T007: the
> two transports, the unified `MxClient`, the session model, and the conformance suite all
> exist. T008 **extends existing modules** (`src/guards.ts`, `src/cli/env.ts`, `src/client.ts`)
> rather than starting from scratch. The only net-new file is the redaction logic (which may
> live inside `src/guards.ts`) and its tests.

The stack is TypeScript (pnpm workspace, Node ≥20.19, vitest 4, Apache-2.0; `pnpm-workspace.yaml`
lists `packages/*` and `adw_sdlc`).

**What exists and T008 builds on:**

- **`packages/toolbelt/src/guards.ts`** — `assertNoCredentialShapedArgs(value, path?)` plus
  the exported `CREDENTIAL_KEY_RE` / `CREDENTIAL_VALUE_RE`. Recursive, throws
  `TransportError('invalid_args', …)`, messages name only the key/path. This is the outbound
  scrubber to **harden**, and the natural home for the new inbound `redactSecrets()`.
  - `CREDENTIAL_KEY_RE` today: `/(?:token|secret|password|passwd|api[_-]?key|signing[_-]?key|private[_-]?key|matrix_)/i`
  - `CREDENTIAL_VALUE_RE` today: `/^(?:gh[posru]_|github_pat_|syt_|xox[abprs]-)/` (anchored — only matches a value that *starts* with a known token prefix).
- **`packages/toolbelt/src/client.ts`** — `MxClient.call()` already calls
  `assertNoCredentialShapedArgs(params)` **before dispatch to either transport** (line ~140).
  This is exactly where the symmetric inbound `redactSecrets(result)` pass attaches — on the
  resolved value, before `call()` returns.
- **`packages/toolbelt/src/cli/env.ts`** — `safeSubprocessEnv({ source, extraAllow })`,
  `BASE_ENV_ALLOW`, `ENV_DENY_PREFIXES = ['MATRIX_', 'MX_AGENT_']`. Deny-by-default; the
  allowlist source the CLI child inherits. The hardening target so `extraAllow` cannot re-admit
  a known secret.
- **`packages/toolbelt/src/cli/client.ts`** — `CliClient.call()` already runs the arg guard
  and `safeSubprocessEnv`; it maps method→argv (`cli/method-map.ts`) and may pass a stdin JSON
  payload. The env→payload test must inspect **both** argv and stdin here.
- **`packages/toolbelt/src/ipc/`** — `framing.ts` (`encodeFrame`), `types.ts` (`JsonRpcRequest`).
  The IPC payload the env→payload test inspects is the encoded request frame (params as JSON).
- **`packages/toolbelt/src/transport.ts`** + **`src/ipc/errors.ts`** — `TransportError` with the
  closed `TransportErrorCode` set including **`invalid_args`** (the code the arg scrubber
  throws). No new code is needed; `invalid_args` already exists.
- **`packages/toolbelt/src/index.ts`** — re-exports `assertNoCredentialShapedArgs`,
  `CREDENTIAL_KEY_RE`, `CREDENTIAL_VALUE_RE`, `safeSubprocessEnv`, `BASE_ENV_ALLOW`,
  `ENV_DENY_PREFIXES`. T008 adds `redactSecrets` (+ any new pattern constant) here, as a new
  **public API to document**.
- **`packages/toolbelt/test/guards.test.ts`** — the existing, thorough guard suite (key cases,
  value cases, secret-free-message assertions, nesting, case-insensitivity, near-miss
  acceptance). Extend it for the hardened deny-list and add the redaction + env→payload suites.
- **Test vocabulary already present:** the conformance harness exports
  `SECRET_PATTERN = /MATRIX_|MX_AGENT_|syt_[a-z]|ghp_|xox[bp]-/`
  (`test/conformance/_harness.ts`) and the session-integration suite asserts no secret-shaped
  value crosses the debug seam. Reuse/extend this vocabulary rather than re-inventing it.

**What does NOT exist yet (build or decide, do not assume):**

- **No inbound redaction anywhere.** `redactSecrets()` and its wiring in `MxClient.call` are
  net-new.
- **No env→payload assertion test.** No test currently proves a secret in `process.env` cannot
  reach an outbound payload; this is AC #2 and must be authored.
- **No `*_TOKEN` / `*_API_KEY` / `GH_TOKEN` hard deny in `env.ts`.** Today these are excluded
  only by virtue of deny-by-default; `extraAllow` could re-admit them. The hard-deny extension
  is new.

## Proposed Implementation

Three small, surgical changes on the shared seam, plus tests. Keep the public-API delta
minimal (one new export) and preserve the existing behavior/tests.

### 1. Harden the outbound arg scrubber (`src/guards.ts`)

Extend the two deny patterns to cover the allowlisted-secret shapes the rule names, biasing
toward **value-shape** matches (low false-positive) over broad key-name matches:

- **Keys (`CREDENTIAL_KEY_RE`).** Add `mx_agent_` (mirroring the existing `matrix_`), and
  `gh[_-]?token` / a `[_-]token$`-style boundaried token suffix so `GH_TOKEN`, `access_token`,
  `auth_token` are caught. **Guard against false positives:** the current `token` alternative
  already matches legitimate pass-through keys like `max_tokens` / `token_count`
  (delegation forwards arbitrary inner-tool args). Prefer a **boundaried** key match
  (e.g. require the credential word to be the whole key or a `_`/`-`-delimited segment that is
  itself credential-shaped, like `*_token` / `token`, not a substring of `max_tokens`). This
  refinement is the crux of the change — see Risks #1; confirm the exact regex with the
  reviewer, and add explicit accept-cases (`max_tokens`, `token_count`, `num_tokens`) to the
  test matrix so the refinement is pinned.
- **Values (`CREDENTIAL_VALUE_RE`).** Add, all anchored with `^` (match only values that
  *start* with the prefix, preserving the existing "mid-value substring is allowed" behavior):
  `sk-ant-` (Anthropic), `AKIA[0-9A-Z]{16}` (AWS access-key id), `-----BEGIN [A-Z ]*PRIVATE KEY-----`
  (PEM private key). Treat OpenAI `sk-` cautiously — `sk-ant-` is safe; bare `sk-` risks false
  positives, so either require `sk-[A-Za-z0-9]{20,}` or omit it and flag (Risks #1).
- Keep the throw contract unchanged: `TransportError('invalid_args', …)`, message names the
  key/path only, never the value.

### 2. Add inbound result redaction (`src/guards.ts` + `src/client.ts`)

```ts
// src/guards.ts
/** Fixed, non-reversible placeholder substituted for a redacted secret-shaped value. */
export const REDACTION_PLACEHOLDER = '«redacted»';

/**
 * Defense-in-depth: walk a daemon-returned result and replace any KNOWN
 * secret-shaped string value with REDACTION_PLACEHOLDER. High-precision —
 * matches CREDENTIAL_VALUE_RE only (named prefixes), never arbitrary strings —
 * so legitimate results are never corrupted. Returns a structurally-cloned copy;
 * never mutates the input. Reports (code-only, no value) when it fires.
 */
export function redactSecrets(value: unknown, onRedact?: (path: string) => void): unknown;
```

- Match policy: redact a string iff `CREDENTIAL_VALUE_RE.test(value)` (the same known-shape
  set the outbound scrubber uses). **Do not** redact on key name inbound — the daemon legitimately
  returns public fields named `signing_key_id` / `signing_public_key`; redacting by key would
  corrupt them. Value-shape only.
- Recurse through objects/arrays exactly like `assertNoCredentialShapedArgs`; return a cloned,
  redacted structure (don't mutate the transport's resolved object).
- Wire it in `MxClient.call`, symmetric with the outbound guard:

  ```ts
  async call(method, params, options) {
    assertNoCredentialShapedArgs(params);                 // outbound (existing)
    const result = await /* …dispatch via selected transport… */;
    return redactSecrets(result, (path) =>                // inbound (new)
      this.#debug(`redacted secret-shaped value in ${method} result at ${path}`));
  }
  ```

  Note the existing `call()` body dispatches through `#callAuto` / `#attempt`; apply
  `redactSecrets` to the **value those return**, at the single `call()` exit point, so it
  covers IPC, CLI, retries, and failover uniformly. Apply it inside `call()` (not in
  `#attempt`) so it runs exactly once per logical call.
- **Framing:** redaction is a backstop, not the primary boundary. The daemon owns secrets
  out-of-process and should never return one; the conformance Tier 1 secret-boundary assertion
  is the contract. Redaction guarantees that *even if* a daemon bug leaked a token-shaped
  value, it cannot reach the model context. Say this explicitly in the README/docstring so it
  is not mistaken for the boundary itself.

### 3. Harden the env allowlist (`src/cli/env.ts`)

Make the deny set defeat `extraAllow` for known-secret shapes:

- Add a deny predicate beyond the existing `ENV_DENY_PREFIXES` prefixes: reject any key whose
  name matches a known-secret shape — suffixes `_TOKEN` / `_API_KEY` / `_SECRET` /
  `_ACCESS_KEY`, plus the exact `GH_TOKEN` and `*_API_KEY` provider patterns — even when listed
  in `extraAllow`. Keep `MXL_*` (the toolbelt's own non-secret namespace, e.g. `MXL_AGENT_BIN`)
  explicitly **allowed** so the existing bin override still works.
- Keep `BASE_ENV_ALLOW` unchanged (it already carries no credential). The change is purely to
  the deny check that filters both `BASE_ENV_ALLOW` additions and `extraAllow`.

### 4. Tests (the two ACs, pinned)

- Extend `test/guards.test.ts` with the hardened deny-list cases **and** the new false-positive
  accept-cases (`max_tokens` etc.).
- New `test/redaction.test.ts`: `redactSecrets` replaces known token-shaped values (top-level,
  nested, in arrays) with the placeholder; leaves clean results byte-identical; never mutates
  input; reports via the callback without the secret; preserves non-secret values that merely
  *contain* a token-shaped substring (anchored regex).
- New `test/secret-boundary.test.ts` (AC #2): set representative secrets in a fake env
  (`MATRIX_ACCESS_TOKEN=syt_…`, `MX_AGENT_KEY=…`, `GH_TOKEN=ghp_…`, `ANTHROPIC_API_KEY=sk-ant-…`),
  drive a `CliClient` (and `safeSubprocessEnv` directly) and assert **no secret value** appears
  in the spawned argv, stdin payload, or child env; drive an `IpcClient` against the existing
  mock fixture and assert no secret value appears in the encoded request frame. Reuse/extend
  `SECRET_PATTERN`.

## Affected Files / Packages / Modules

**Modified:**
- `packages/toolbelt/src/guards.ts` — harden `CREDENTIAL_KEY_RE` / `CREDENTIAL_VALUE_RE`; add
  `redactSecrets` + `REDACTION_PLACEHOLDER`.
- `packages/toolbelt/src/client.ts` — apply `redactSecrets` to the `MxClient.call` resolved
  result (single exit point), reporting via the existing `#debug` seam.
- `packages/toolbelt/src/cli/env.ts` — extend the deny check (suffix/exact known-secret shapes)
  so `extraAllow` cannot re-admit a known secret; keep `MXL_*` allowed.
- `packages/toolbelt/src/index.ts` — export `redactSecrets`, `REDACTION_PLACEHOLDER` (and any
  new pattern constant).
- `packages/toolbelt/test/guards.test.ts` — hardened deny-list + false-positive accept cases.
- `packages/toolbelt/README.md` — expand the "Secret boundary" section with inbound redaction
  and the hardened env deny.
- `docs/backlog.md` — tick T008 ACs; note module locations.

**New:**
- `packages/toolbelt/test/redaction.test.ts` — inbound redaction unit suite.
- `packages/toolbelt/test/secret-boundary.test.ts` — env→payload assertion (AC #2), across CLI
  argv/stdin/env and the IPC frame.

**Read (no change expected):**
- `packages/toolbelt/src/cli/client.ts`, `src/cli/method-map.ts`, `src/ipc/{client,framing,types}.ts`,
  `src/transport.ts`, `src/ipc/errors.ts` (the `invalid_args` code already exists).
- `packages/toolbelt/test/fixtures/mock-mx-agent.mjs` (IPC payload-inspection fixture).
- `packages/toolbelt/test/conformance/_harness.ts` (`SECRET_PATTERN` to reuse).

## API / Interface Changes

- **New public exports (document these):** `redactSecrets(value, onRedact?)` and
  `REDACTION_PLACEHOLDER` from `@mx-loom/toolbelt`. Add to the README public-API table.
- **Behavioral change to an existing export:** `assertNoCredentialShapedArgs` rejects a wider
  set of credential shapes. This is a **tightening** — previously-accepted secret-shaped args
  may now throw `invalid_args`. Conversely, the false-positive refinement *accepts* some keys
  the current broad `token` substring would reject (`max_tokens`); call this out in the changelog.
- **`safeSubprocessEnv` semantics:** `extraAllow` can no longer re-admit known-secret env keys.
  No signature change.
- **No daemon-RPC change.** The daemon is unchanged; T008 is entirely toolbelt-side.
- **No CLI command-surface change.** No new flags.

## Data Model / Protocol Changes

**None to the wire protocol or any persisted shape.** No result-envelope, error-taxonomy code,
tool input/output schema, idempotency-key, audit-row, or serialization change is introduced.
T008 reuses the existing closed `TransportError` code `invalid_args` for outbound rejection and
introduces only an in-memory `REDACTION_PLACEHOLDER` string substituted into resolved results.
The redaction is applied *after* deserialization and does not alter the JSON-RPC framing.

## Security & Compliance Considerations

- **Secret boundary (Boundary A).** `MATRIX_*`, `MX_AGENT_*`, the Ed25519 **private** signing
  key, provider API keys, and `GH_TOKEN` must never reach the runtime process, the model
  context, or the CLI child. T008 reinforces this on three edges: (a) outbound — reject
  credential-shaped args before dispatch; (b) the env edge — deny-by-default allowlist that
  `extraAllow` cannot widen to a known secret, so no host secret rides into a tool payload or
  the child env (runner children receive retrieved **TEXT** only, never credentials); (c)
  inbound — redact known secret-shaped values from results as defense-in-depth.
- **Out-of-process enforcement is unchanged and not bypassed.** Trust (Ed25519 store),
  deny-by-default `policy.toml`, sandbox, and human approval gates all execute on the
  **receiving** daemon. T008 grants no authority; cognition still only ever produces a signed
  request. No `trust.*` / `approval.decide` / `policy.*` surface is exposed, and the model is
  given no trust/policy/approval mutation tool. Approval still reaches the model only as an
  `awaiting_approval` status (M1), re-validated against live policy at release.
- **Secret-free tool contract (§4.7) enforced.** No tool field carries a credential inbound or
  outbound; credential-shaped args are rejected. The hardened deny-list extends coverage to the
  full set the rule names without weakening the contract.
- **No secret is ever logged or persisted.** Outbound rejection messages name only the
  key/path. The inbound redaction report (via the `#debug` seam) carries only the method, a
  path, and a code — never the value. The placeholder is fixed and non-reversible. Redaction
  returns a clone; the secret is never written to disk, a log line, or an error `cause`.
- **Audit correlation.** At M0 there is no `audit_ref` envelope to populate; T008 must not
  imply one exists (it is M1/T102/T113). Redaction composes with that envelope later but does
  not introduce it.
- **Defense-in-depth framing.** Redaction is a backstop behind the daemon's own secret
  custody, not the primary boundary — documented as such so it is not over-trusted. The
  conformance Tier 1 secret-boundary assertion remains the contract proving the daemon does not
  return secrets.

## Testing Plan

- **Unit — outbound scrubber (hardened):** extend `test/guards.test.ts` — new reject cases
  (`mx_agent_token`, `GH_TOKEN`, `sk-ant-…`, `AKIA…`, PEM private-key header) all → `invalid_args`;
  new **accept** cases pinning the false-positive refinement (`max_tokens`, `token_count`,
  `num_tokens`, `gh_not_a_real_prefix`, mid-value token substrings) → no throw; messages stay
  secret-free (path/key only).
- **Unit — inbound redaction (new):** `test/redaction.test.ts` — known token-shaped values
  (top-level, nested object, array element) replaced with `REDACTION_PLACEHOLDER`; clean
  results returned structurally equal; input never mutated; `onRedact` reports a path but not
  the value; values merely *containing* a token-shaped substring are preserved (anchored regex).
- **Secret-boundary / env→payload (AC #2):** `test/secret-boundary.test.ts` — with secrets set
  in a fake env, assert none of their values appear in (a) `safeSubprocessEnv` output, (b) the
  `CliClient` spawn argv + stdin, (c) the encoded IPC request frame. Assert `extraAllow` cannot
  re-admit `GH_TOKEN` / `*_API_KEY` / `*_TOKEN`, while `MXL_AGENT_BIN` is still forwarded.
- **Integration — client seam:** a fixture-backed `MxClient.call` whose mock fixture returns a
  token-shaped value in its result → assert the caller receives the placeholder, not the token
  (redaction fires end-to-end on the real seam).
- **Acceptance-criteria coverage:** AC #1 (secret-shaped arg → `invalid_args`) by the hardened
  guard cases; AC #2 (no allowlisted-secret env var in any tool payload) by the env→payload
  suite across both transports.
- **Conformance (no change required):** the Tier 1 credential-shaped-arg + secret-boundary
  assertions already exist (`agent-lifecycle.conformance.test.ts`); confirm they still pass and
  optionally extend the secret-pattern set to match the hardened deny-list.
- **Regression:** the existing `guards.test.ts` near-miss accept-cases and the fast unit suite
  stay green and daemon-free.

## Documentation Updates

- **`packages/toolbelt/README.md`** — expand the "Secret boundary" section: document inbound
  `redactSecrets` (defense-in-depth framing), the hardened arg deny-list, and the
  `extraAllow`-proof env deny; add `redactSecrets` / `REDACTION_PLACEHOLDER` to the public-API
  table (the table already flags "T008 hardens" on the guard row).
- **`docs/backlog.md`** — tick T008's two ACs; record the touched modules (`src/guards.ts`,
  `src/cli/env.ts`, `src/client.ts`) and new test files; note the false-positive refinement.
- **`docs/mx-agent-tool-fabric-design.md`** — no change required (§4.7 and §6.6 already state
  the rule). Add a one-line back-reference to the toolbelt enforcement points only if helpful.
- **Help text:** none (no CLI surface change).

## Risks and Open Questions

1. **False positives on pass-through delegation args (the main design tension).**
   `mx_delegate_tool` forwards arbitrary inner-tool args, many of which legitimately contain
   `token` (`max_tokens`, `token_count`). The current broad `token` substring would already
   reject those; hardening must *refine* to a boundaried/whole-segment match rather than widen
   the substring net. **Decide** the exact key regex (boundaried `*_token` vs. substring) with
   the reviewer, and pin both reject and accept cases in tests. Erring toward over-rejection
   breaks legitimate delegation; erring toward under-rejection leaks. Value-shape matching is
   the lower-risk lever — prefer it.
2. **Provider-key value prefixes.** `sk-ant-` is safe to match; bare OpenAI `sk-` is ambiguous
   (risk of matching non-secret values). **Decide** whether to require a length-bounded
   `sk-[A-Za-z0-9]{20,}` or omit bare `sk-`. AWS `AKIA…` and PEM headers are low-risk.
3. **Redaction placement: raw seam (M0) vs. M1 envelope.** The T004 note scopes redaction to
   "this shared seam" (i.e. `MxClient.call`, M0) — adopted here. When the M1 envelope (T102)
   lands, confirm redaction runs once (on the raw result) and the envelope wraps the already-
   redacted value, to avoid a double pass or a gap.
4. **Redact-vs-reject asymmetry.** Outbound **rejects** (the model should not send secrets —
   contract violation → `invalid_args`); inbound **redacts** (a daemon-returned token should
   not break the call, just be scrubbed). Confirm this asymmetry is the intended behavior (vs.
   throwing on an inbound secret, which would surface a daemon bug more loudly but break the
   call). Recommendation: redact + report; surface loudly only in tests/conformance.
5. **Env deny-list breadth.** A suffix deny (`_TOKEN` / `_API_KEY` / `_SECRET`) is heuristic and
   could drop a legitimately-needed non-secret env var named that way. Given `BASE_ENV_ALLOW` is
   tiny and credential-free and the CLI child needs no secrets, the blast radius is low —
   confirm no required CLI env var collides with the deny suffixes.
6. **Scope vs. estimate (S).** The issue is sized **S**; keep the change surgical — extend the
   existing guard/env modules and add two test files, not a new abstraction layer or a general
   DLP engine. A heuristic entropy classifier is explicitly out of scope.

## Implementation Checklist

1. **Confirm the key-regex refinement** (Risk #1) and the provider-prefix policy (Risk #2) with
   the reviewer before coding the deny-list, so the false-positive boundary is agreed up front.
2. **Harden `src/guards.ts` outbound deny-list:** refine `CREDENTIAL_KEY_RE` to a boundaried
   match adding `mx_agent_` and `gh[_-]?token` / `*_token`-shaped segments; extend
   `CREDENTIAL_VALUE_RE` (anchored) with `sk-ant-`, `AKIA…`, PEM private-key header (+ optional
   bounded `sk-`). Keep messages secret-free.
3. **Add `redactSecrets` + `REDACTION_PLACEHOLDER` to `src/guards.ts`:** value-shape-only,
   recursive, returns a clone, never mutates, reports via callback without the value.
4. **Wire redaction into `MxClient.call`** (`src/client.ts`) at the single `call()` exit point,
   reporting through the existing `#debug` seam (code/path only). Verify it covers IPC, CLI,
   retry, and failover paths and runs exactly once per logical call.
5. **Harden `src/cli/env.ts`:** add a known-secret deny predicate (suffixes `_TOKEN` / `_API_KEY`
   / `_SECRET` / `_ACCESS_KEY`, exact `GH_TOKEN`) applied to both `BASE_ENV_ALLOW` and
   `extraAllow`; keep `MXL_*` allowed.
6. **Export** `redactSecrets` / `REDACTION_PLACEHOLDER` (and any new pattern constant) from
   `src/index.ts`.
7. **Extend `test/guards.test.ts`:** hardened reject cases + false-positive accept cases
   (`max_tokens` etc.); messages stay secret-free.
8. **Add `test/redaction.test.ts`:** top-level/nested/array redaction, clean-result passthrough,
   no-mutation, report-without-value, anchored-substring preservation, end-to-end via a
   token-returning mock fixture.
9. **Add `test/secret-boundary.test.ts` (AC #2):** secrets in a fake env never appear in CLI
   argv/stdin/env or the IPC request frame; `extraAllow` cannot re-admit a known secret;
   `MXL_AGENT_BIN` still forwards.
10. **Run** `pnpm -C packages/toolbelt typecheck && pnpm -C packages/toolbelt test`; confirm the
    fast suite stays daemon-free and green, and the conformance secret-boundary assertions still
    pass.
11. **Docs:** update the README "Secret boundary" section + public-API table; tick T008 ACs in
    `docs/backlog.md` with module/test locations.
12. **Confirm both ACs:** secret-shaped arg → `invalid_args`; no allowlisted-secret env var in
    any tool payload (asserted across both transports).
