# MX-Agent Tool-Fabric — Implementation Backlog

Derived from [`mx-agent-tool-fabric-design.md`](./mx-agent-tool-fabric-design.md). Cross-references mx-agency ADR-11 (integration contract), ADR-04 (runtime cognition), ADR-03/07/08/10/12, and issue #37 (SDK seam).

| | |
|---|---|
| Status | Active — M0 complete; M1 in progress — T101–T107 landed (both delegation surfaces: named tools + guarded exec; plus the shared-context publish/fetch seam); GitHub issues live in `kortiene/mx-loom` |
| Target repo | `kortiene/mx-loom` — this repo (branded `mx-loom`); a fresh repo, so issue numbering starts clean |
| ID scheme | Local `T###` IDs for stable dependency refs; real GitHub numbers assigned at `gh issue create` time |
| Estimate scale | T-shirt — **S** ≈ ½–1d · **M** ≈ 1–2d · **L** ≈ 3–5d |
| Milestones | One per roadmap phase, M0–M6 |

## Label taxonomy

- **area/** · `contract` `toolbelt` `registry` `mcp` `claude-binding` `adk` `opencode` `pi` `daemon` `policy` `approvals` `audit` `ci` `docs`
- **type/** · `epic` `feature` `chore` `test` `docs` `spike`
- **priority/** · `P0` (critical path) · `P1` (needed for milestone) · `P2` (nice-to-have)

---

## Critical path & dependency summary

The spine that gates each milestone's exit:

```
M0  T001 ─▶ T002 ─▶ T004 ─▶ T005
                      │
M1                    ▼
            T101 ─▶ T102 ─▶ T103 ─┐
                      └─▶ T105 ────┤
                          T106 ────┤
                  T109 (MCP) ◀──────┤
                  T110 (Claude) ◀───┘
                          │
                          ▼
                  T114  GOLDEN test  ◀── M1 exit
                          │
M2                        ▼
            T201/T202 · T203 · T205 ─▶ T206  ◀── M2 exit
                          │
M3                        ▼
            T301 ─▶ T302 ─▶ T304  ◀── M3 exit
                          │
M4                        ▼
            T401 · T402 · T403 ─▶ T405  ◀── M4 exit
                          │
M5                        ▼
            T501 ─▶ T502 · T504 ─▶ T505  ◀── M5 exit
                          │
M6                        ▼
            T601 · T603  ◀── M6 exit (certification)
```

**Spikes that de-risk the path (do first):** `T001` (verify live daemon RPC surface vs design §2) and `T204` (Pi tool-surface capability).

---

## Milestones

| Milestone | Goal | Definition of done (exit criteria) |
|---|---|---|
| **M0 — SDK seam** | Close #37: a TS toolbelt that talks to the daemon | Toolbelt round-trips `agent.register` / `agent.list` / `call.start` against a live daemon; conformance suite green on v0.2.1 |
| **M1 — Delegation MVP** | One runtime family, both bindings | Claude-SDK agent delegates a named tool **and** a guarded command to a second agent through an approval gate, via **both** the MCP server and the Claude native shim; audit refs land in Postgres |
| **M2 — Universal binding** | ADK / OpenCode / Pi | The golden test passes under ADK, OpenCode, and Pi from the same descriptor set |
| **M3 — Coordination depth** | Plans + context as tools | A multi-agent plan executes across ≥2 agents with durable task state surviving a runtime restart |
| **M4 — Governance UX** | Operator-grade trust / policy / approval | A new runtime agent is onboarded and policy-scoped with no code changes; approvals fully audited |
| **M5 — Multi-tenant + observability** | Agency scale | N tenants isolated (RLS); per-tenant audit queryable; per-call cost attributed |
| **M6 — Production hardening** | Certify the fabric | Per-runtime conformance certification; MCP server published; chaos/fault tests on approval + revocation pass; E2EE-on-by-default; SLA monitoring |

---

## M0 — SDK seam

> **Epics:** E0.1 Transport & client · E0.2 Contract & conformance

#### T001 · contract: verify live daemon JSON-RPC surface vs design §2 (v0.2.1)
`area/contract` `type/spike` `P0` · **S** · M0
- **Context:** The tool list in design §2 is mapped from docs; confirm method names/params on a live `v0.2.1` daemon before building against them.
- **Scope:** Exercise `agent.register/list/show/tools`, `call.start`, `exec.start`, `task.*`, `share.*`, `invocation.get/cancel`, `approval.decide`. Produce a verified method/param table.
- **Out of scope:** Any toolbelt code.
- **Acceptance criteria:**
  - [ ] Verified method table committed to `docs/`
  - [ ] Each method's params/result confirmed or deltas flagged as issues
- **Dependencies:** none (do first)

#### T002 · toolbelt: framed JSON-RPC 2.0 IPC client over Unix socket
`area/toolbelt` `type/feature` `P0` · **M** · M0
- **Context:** Boundary B is the daemon socket (4-byte big-endian len prefix + JSON, UID-gated, mode 0600).
- **Scope:** Socket-path resolution (`$XDG_RUNTIME_DIR/mx-agent/daemon.sock`, `--socket` override), framing codec, request/response id correlation, per-call timeouts, error mapping.
- **Out of scope:** CLI fallback (T003); tool registry (M1).
- **Acceptance criteria:**
  - [ ] Can send a request and parse a framed response
  - [ ] `daemon.ping` / `daemon.status` round-trip in an integration test
  - [ ] Timeout + malformed-frame paths covered by tests
- **Dependencies:** blocked-by T001

#### T003 · toolbelt: `--json` CLI fallback transport
`area/toolbelt` `type/feature` `P0` · **M** · M0
- **Context:** ADR-11 mandates IPC primary, one-shot `--json` CLI as secondary/fallback.
- **Scope:** Subprocess invocation with `safeSubprocessEnv` allowlist; parse `--json` stdout; normalize errors to match IPC client.
- **Out of scope:** Transport selection logic (T004).
- **Acceptance criteria:**
  - [x] A CLI-backed call returns the same typed result shape as the IPC client (`CliClient` + `IpcClient` both satisfy `MxTransport`; `status()` → `DaemonStatus`)
  - [x] Subprocess env is allowlisted (no `MATRIX_*` / `MX_AGENT_*` leak) — toolbelt-local deny-by-default `safeSubprocessEnv`
- **Dependencies:** blocked-by T001 · **unblocks T004** (transport selection)

#### T004 · toolbelt: unified client behind the `app/src/sdk` seam (closes #37)
`area/toolbelt` `type/feature` `P0` · **M** · M0
- **Context:** #37 is currently a throwing stub. Replace with a real client: IPC primary, CLI fallback, single typed interface.
- **Scope:** Transport selector, ret/backoff policy, the public client interface all callers use, removal of the fail-loud stub.
- **Out of scope:** Tools (M1).
- **Acceptance criteria:**
  - [x] `@mx-loom/toolbelt` exports a working unified client (`MxClient` + `createClient`, no throw); the literal `app/src/sdk` stub removal is a cross-repo follow-up in `kortiene/mx-agency#37` (OQ #5: mx-loom is the standalone package mx-agency consumes)
  - [x] Falls back to CLI when the socket is absent (auto transport: absent-socket fast-path + `not_running`-only failover)
  - [x] Unit + integration tests pass (`client.unit.test.ts`, `retry.test.ts`, `guards.test.ts`, `mxclient.integration.test.ts`; live `daemon.status` round-trips through `createClient()`)
- **Dependencies:** blocked-by T002, T003 · **unblocks T005, T007, T008, T101**
- **Note:** the credential-shaped-arg guard was hoisted to `src/guards.ts` so it now runs on **both** transports (closing the IPC-path gap where `invalid_args` was never emitted); T008 hardens the deny-list + adds inbound result redaction on this shared seam.

#### T005 · toolbelt: session model + agent registration
`area/toolbelt` `type/feature` `P0` · **M** · M0
- **Context:** `MxSession = { agent_id, room/workspace, socket, correlation_id }`; a runtime conversation maps 1:1 to an MX agent registration.
- **Scope:** Session lifecycle; `agent.register` on start; heartbeat/liveness; thread `correlation_id` onto every call.
- **Out of scope:** Multi-tenant scoping (M5).
- **Acceptance criteria:**
  - [x] Opening a session registers an agent visible via `agent.list`
  - [x] Heartbeat keeps liveness `active`; session close deregisters/goes stale
  - [x] `correlation_id` present on all outbound calls
- **Dependencies:** blocked-by T004 · **unblocks T302** (`task.watch` resume), **T501** (tenant=room scoping)
- **Status:** Landed (`packages/toolbelt`: `openSession`/`MxSession`, `heartbeat.ts`, `correlation.ts`, `agent-state.ts`). Gated defaults pending a live v0.2.1 check: heartbeat refresh = idempotent re-`agent.register`; deregister = decay (no method); `correlation_id` param propagation off. Heartbeat interval defaults to 15 s until the staleness window is recorded.

#### T006 · contract: pin mx-agent v0.2.1 (#36)
`area/contract` `type/chore` `P0` · **S** · M0
- **Context:** Treat alpha v0.2.1 as a pinned substrate, not a moving dependency.
- **Scope:** Add `.mx-agent-version` file; document the pin-bump policy (conformance must pass before bump).
- **Out of scope:** The conformance suite itself (T007).
- **Acceptance criteria:**
  - [x] `.mx-agent-version` records `v0.2.1`
  - [x] Pin-bump policy documented — `docs/mx-agent-pin.md`; T007 wired in as the executable gate.
- **Dependencies:** none

#### T007 · contract: conformance suite gating the version pin
`area/contract` `area/ci` `type/test` `P0` · **M** · M0
- **Context:** Verify the toolbelt's assumed surface against the pinned daemon before any bump.
- **Scope:** Automated suite asserting `agent.register` / `agent.list` / `call.start` round-trips; CI job; red on surface drift.
- **Out of scope:** Per-runtime certification (T601).
- **Acceptance criteria:**
  - [x] Suite runs in CI against a live daemon — `.github/workflows/conformance.yml` (`live` job, `MXL_CONFORMANCE=1` → fail-not-skip); suite at `packages/toolbelt/test/conformance/`, run via `pnpm --filter @mx-loom/toolbelt test:conformance`.
  - [x] Green on v0.2.1; documented as the pin-bump gate — Tier 0 (pin identity) + Tier 1 (`agent.register` / `agent.list` + closed error taxonomy + secret boundary) verified green against a live `v0.2.1` daemon; gate wired in `docs/mx-agent-pin.md` + the toolbelt README.
- **Notes:** Tier 2 (`call.start` delegation) is implemented (`delegate.conformance.test.ts`) and staged behind `MXL_CONFORMANCE_TWO_DAEMON=1` + the two-daemon bring-up (`scripts/conformance/bootstrap-daemon-b.sh`); it round-trips green once the two-daemon CI fixture (second daemon + mutual trust + minimal allow-policy) is provisioned (release-binary/homeserver provenance — see the spec Risks #2/#3). Throwaway receiver policy fixture (`scripts/conformance/policy.b.toml`) to converge on T112 later.
- **Dependencies:** blocked-by T004, T006

#### T008 · toolbelt: secret-boundary guard (no secret crosses Boundary A)
`area/toolbelt` `type/feature` `P0` · **S** · M0
- **Context:** Reinforce mx-agency's rule — `MATRIX_*`, `MX_AGENT_*`, provider keys, `GH_TOKEN` never reach the runtime process or model context.
- **Scope:** Outbound arg scrubber + inbound result redaction; deny-list + tests; reject credential-shaped args.
- **Out of scope:** Sandbox enforcement (daemon-side).
- **Acceptance criteria:**
  - [x] Attempt to pass a secret-shaped arg is rejected with `invalid_args` — hardened `assertNoCredentialShapedArgs` (`src/guards.ts`): boundaried `token` (rejects `GH_TOKEN`/`*_token`, accepts `max_tokens`/`token_count`) + `mx_agent_` keys + `sk-ant-`/bounded `sk-`/`AKIA…`/PEM value prefixes (`test/guards.test.ts`).
  - [x] No allowlisted-secret env var appears in any tool payload (test asserts) — `test/secret-boundary.test.ts` asserts across CLI argv/stdin/child-env and the IPC request frame; `safeSubprocessEnv` (`src/cli/env.ts`) denies `_TOKEN`/`_API_KEY`/`_SECRET`/`_ACCESS_KEY` + exact `GH_TOKEN` even via `extraAllow` (keeps `MXL_*`).
- **Modules:** `src/guards.ts` (hardened deny-list + new `redactSecrets`/`REDACTION_PLACEHOLDER`), `src/client.ts` (inbound redaction on the `MxClient.call` exit point), `src/cli/env.ts` (`extraAllow`-proof deny). Tests: `test/guards.test.ts` (hardened reject + false-positive accept), `test/redaction.test.ts`, `test/secret-boundary.test.ts`, `test/cli-env.test.ts`.
- **Note:** false-positive refinement — `token` matched **boundaried** (`(?:^|[_-])token$`), not as a substring, so delegation pass-through keys (`max_tokens`/`token_count`/`num_tokens`) are accepted while credential `*_token` keys reject. Inbound `redactSecrets` is value-shape-only defense-in-depth (never by key name), not the boundary itself.
- **Dependencies:** blocked-by T004

---

## M1 — Delegation MVP

> **Epics:** E1.1 Canonical registry + envelope · E1.2 Bindings (MCP + Claude) · E1.3 Golden test + audit

#### T101 · registry: canonical tool descriptor model
`area/registry` `type/feature` `P0` · **M** · M1
- **Context:** One transport-neutral descriptor set is the single source for all bindings.
- **Scope:** Descriptor = `name` (`mx_*`), `description`, `input_schema` (JSON Schema), `output_schema`, async semantics flag. Registry loader/validator.
- **Out of scope:** Individual tool handlers (T104–T108).
- **Acceptance criteria:**
  - [x] Descriptors validate as JSON Schema — `loadRegistry()` compiles every `input_schema`/`output_schema` against the draft-07 meta-schema (Ajv) at construction; a malformed schema throws `DescriptorValidationError` naming the field.
  - [x] Registry enumerable; binding generators can read it — `ToolRegistry` exposes `list()`/`get()`/`has()`/`[Symbol.iterator]`; a fake-binding-generator test renders a tool list with no handler/daemon.
- **Dependencies:** blocked-by T004 · **unblocks T102** (envelope), **T104/T105** (discovery + delegation handlers), **T109** (MCP server), **T110** (Claude shim), **T111** (JSON Schema → Zod).
- **Status:** Landed (`packages/registry` = `@mx-loom/registry`: `ToolDescriptor` model, the 7 P0 `mx_*` descriptors, `loadRegistry`/`DescriptorValidationError`, the Ajv-backed `SchemaValidator` seam, the no-authority + secret-free invariants). **Resolved decisions:** (#1) Ajv as a **runtime** dep behind an injectable seam — toolbelt keeps its zero-runtime-dep streak; (#2) a new leaf package; (#3) JSON Schema dialect = **draft-07**; (#4) `async_semantics: 'sync' | 'deferred'`; (#5) descriptor metadata-only, RPC mapping attaches in T104–T108; (#7) the **7 P0** verbs now, P1 `mx_cancel`/`mx_workspace_status` with T108; (#8) no `guarded` hint; (#9) no `version` field. The comprehensive per-descriptor test suite (the spec's Testing Plan) lands in the dedicated tests phase; a smoke suite proves both ACs now.

#### T102 · registry: normalized result envelope + error taxonomy + idempotency
`area/registry` `type/feature` `P0` · **M** · M1
- **Context:** §4 — one envelope shape every tool returns.
- **Scope:** `{status, result, error, handle, approval, audit_ref}`; closed `error.code` set (`policy_denied|untrusted_key|approval_denied|approval_expired|timeout|not_found|invalid_args|target_offline|internal`); client-supplied `idempotency_key` plumbing.
- **Out of scope:** Async resolution (T103).
- **Acceptance criteria:**
  - [x] Every tool result conforms to the envelope schema — `ToolResult` + the draft-07 `ENVELOPE_SCHEMA`/`validateEnvelope` (status-discriminated union, compiled via the T101 Ajv seam) + constructor helpers (`ok`/`running`/`awaitingApproval`/`denied`/`errored`) that are the only sanctioned builder, so handlers conform by construction. (The literal per-tool assertion is exercised by the handler tests T104–T108 + the golden test T114, since the handlers do not exist yet.)
  - [x] Error codes are closed-set and tested — single-source `ERROR_CODES` (the nine documented codes) → `ErrorCode`/`isErrorCode`, the `DENIAL_CODES`/`FAULT_CODES` partition, and the exhaustive `mapTransportError` (`never`-default) / `mapDaemonError` (`internal` fallback) mappers. (The closed-set regression + exhaustive-mapper suites land in the dedicated tests phase.)
  - [x] Retried call with same `idempotency_key` does not double-execute — plumbed as the optional `idempotency_key` field on the mutating descriptors (`mx_delegate_tool`/`mx_run_command`) + `newIdempotencyKey()`; the handler contract reuses the same key on transport-level retries (params reused verbatim by `MxClient.withRetry`) so the daemon dedupes. (Live dedup rides the staged two-daemon conformance fixture.)
- **Dependencies:** blocked-by T101 · **unblocks T103** (deferred-result), **T105/T106** (handlers build envelopes via the helpers + mappers + idempotency contract), **T107/T108**, **T113** (reads `audit_ref`), **T114** (golden test).
- **Status:** Landed (`packages/registry`: `src/envelope.ts`, `src/errors.ts`, `src/envelope-schema.ts`, `src/idempotency.ts`; `idempotency_key` added to the two mutating descriptors; surface exported from `src/index.ts`). **Resolved decisions:** (#1) envelope home = **extend `@mx-loom/registry`**; (#2) status↔code partition = denial-set `{policy_denied, untrusted_key, approval_denied, approval_expired}` / fault-set `{timeout, not_found, invalid_args, target_offline, internal}`; (#7) idempotency in handler-built params (not `CallOptions`), failover stays conservative `not_running`-only; (#8) transport-code coupling = **type-only import** (no runtime dep on the toolbelt). **Pending the two-daemon round-trip** (#3 daemon error vocabulary, #4 `audit_ref` field availability, #5 `idempotency_key`/`nonce` wire param name) — authored against the design's named codes now, pinned by the conformance fixture later.

#### T103 · registry: deferred-result protocol (`mx_await_result`)
`area/registry` `type/feature` `P0` · **M** · M1
- **Context:** Remote calls/approvals are async; long-running ops return a handle.
- **Scope:** `mx_await_result(handle, wait_ms)` over `invocation.get` (+ `task.watch` later); resolve `running`/`awaiting_approval` → terminal.
- **Out of scope:** Native long-running shims (M2).
- **Acceptance criteria:**
  - [x] A `running` handle resolves to a terminal envelope — `mxAwaitResult` probes `invocation.get`, classifies via the pure `invocationToResult` normalizer, and returns the terminal `ok`/`denied`/`error` envelope (`audit_ref` carried through).
  - [x] `awaiting_approval` resolves to `ok`/`denied` after an operator decision — the resolver **only observes**: it polls until the daemon (which re-runs the authorize pipeline at release) surfaces the post-decision terminal state; it issues no approval and exposes no approve/deny/mutate surface.
  - [x] `wait_ms` timeout returns the still-pending status without error — a `wait_ms` expiry returns the pending `running`/`awaiting_approval` envelope (`error: null`), **never** `errored('timeout')`; the `timeout` code is reserved for a genuine transport fault (the crux of T103).
- **Dependencies:** blocked-by T102 · **unblocks T109** (MCP surfaces/resolves `awaiting_approval`), **T110** (Claude shim hides the poll loop), **T202** (ADK `LongRunningFunctionTool` resumes on result).
- **Status:** Landed (`packages/registry/src/handlers/`: `deps.ts` the injected daemon-call seam `DaemonCall`/`HandlerDeps`, `invocation.ts` the pure state→envelope normalizer `classifyInvocation`/`invocationToResult`, `await-result.ts` the `mxAwaitResult` resolver + `wait_ms` poll-with-timeout; barrel-exported from `src/index.ts`). **Resolved decisions:** (#1) handler home = **extend `@mx-loom/registry`** (option A) — matches the `area/registry` label and keeps the zero **runtime** toolbelt dep via the `type`-only `MxTransport` import (the remit grows from "contract only" to "contract + handlers calling an injected daemon"); (#3) `wait_ms` = **client-side poll-with-timeout** baseline (server-side long-poll deferred until verified); (#6) `wait_ms` is a logical budget realised as many short reads with a bounded poll interval (~200 ms floor 10 ms / cap 2 s) so a large `wait_ms` cannot hammer the daemon — no upper cap enforced here (binding layer's call); (#7) terminal-failure disposition (`denied` vs `error`) follows the **mapped daemon code's** set membership, not the state label. **Pending the two-daemon round-trip** (`MXL_CONFORMANCE_TWO_DAEMON=1`): (#2) `invocation.get` method/param name, (#3) the invocation state vocabulary + whether `invocation.get` long-polls, (#4) the held-invocation `approval` fields, (#5) `audit_ref` field availability — authored against the design's named states with a safe `internal` fallback now, pinned at the round-trip.

#### T104 · tool: `mx_find_agents` + `mx_describe_agent`
`area/registry` `type/feature` `P0` · **S** · M1
- **Context:** Discovery verbs (`agent.list` + filter; `agent.show` + `agent.tools`).
- **Scope:** Capability/tool/liveness filtering; return published `ToolSchema[]` for an agent.
- **Out of scope:** Trust mutation (operator-only).
- **Acceptance criteria:**
  - [x] Filter by capability returns expected agents — `mxFindAgents` calls `agent.list` once, applies the `capability`/`tool`/`liveness` filters client-side with **AND** semantics (absent filter ⇒ matches all), projects each survivor onto a non-secret `AgentSummary`, and returns `ok({ agents }, EMPTY_AUDIT_REF)`.
  - [x] `mx_describe_agent` returns the target's tool schemas — `mxDescribeAgent` resolves `agent.tools` (the published `schemas: ToolSchema[]`, `input_schema`/`output_schema` passed through verbatim) + `agent.list` (liveness/workspace/load) and returns `ok({ agent, tools }, EMPTY_AUDIT_REF)`; an unknown `agent_id` maps to `not_found`.
- **Dependencies:** blocked-by T101
- **Status:** Landed (`packages/registry/src/handlers/`: `agent-projection.ts` the pure non-secret `AgentState`→`AgentSummary`/`AgentDetail` + `ToolSchema`→`PublishedTool` projectors, `find-agents.ts` `mxFindAgents`, `describe-agent.ts` `mxDescribeAgent`, `handler-fault.ts` the shared `faultToResult` + `EMPTY_AUDIT_REF` extracted from `await-result.ts`; barrel-exported from `src/index.ts`). Both verbs are `sync` **local reads** — terminal `ok`/`denied`/`error` envelopes with an **all-null** `audit_ref` (no Matrix round-trip), built only through the T102 helpers, **never throwing** (transport/daemon faults map onto the closed taxonomy via the shared `faultToResult`, e.g. `unknown_agent` → `not_found`). **Resolved decisions:** (#1) the `mx_find_agents` `output_schema` array→object reconciliation — the success payload is `{ agents: AgentSummary[] }` (a bare array fails the envelope `ok` branch's `result: {type:'object'}`); the descriptor was updated, the envelope contract left untouched. (#4) filtering is **client-side** over the verified surface (no server-side filter param). (#5) the output is **projected** to a non-secret subset (drops `matrix_user_id`/`device_id`/`signing_key_id`/`signing_public_key`/`state_rev`), allowlist-by-construction. (#6) a missing/unknown liveness fails **closed** to `offline`. (#7) the shared fault path was **extracted** to `handler-fault.ts` (now reused by 3 handlers). **Pending the live check:** (#2) `agent.show` is **not** in the verified v0.2.1 surface, so `mx_describe_agent` is backed by `agent.list` + `agent.tools`; an `agent.show {agent_id}` fast-path is gated off pending a pin that verifies it. (#3) whether the `agent.list` row's `tools[]` carries tool *names* is unverified — the `tool` filter reads names from the row when it carries them and otherwise resolves `agent.tools` for the (capability+liveness) survivors only (bounded fan-out, per-agent fault tolerated as "no match"). The comprehensive handler/projection/security/conformance test suite (the spec's Testing Plan) lands in the dedicated tests phase.

#### T105 · tool: `mx_delegate_tool` (primary delegation verb)
`area/registry` `type/feature` `P0` · **M** · M1
- **Context:** `call.start` → `CallRequest`/`CallResponse`; the core remote-tool verb.
- **Scope:** Pass inner `input_schema` through from the target's `ToolSchema`; validate args; map response into the envelope (incl. `awaiting_approval`).
- **Out of scope:** Guarded exec (T106).
- **Acceptance criteria:**
  - [x] Valid call returns `status: ok` with `result` matching `output_schema`
  - [x] Invalid args rejected as `invalid_args` before dispatch
  - [x] Policy-denied target returns `policy_denied`
- **Dependencies:** blocked-by T102, T104
- **Status:** Landed (`packages/registry/src/handlers/delegate-tool.ts` — `mxDelegateTool` / `DelegateToolInput`; `invocation.ts` extended with `callResponseToResult` (the sibling of `invocationToResult`, sharing every reader/classifier, adding a success-signal path so a bare `{ok:true, result}` maps to `ok`) + `isTerminal` (shared by the T103 poll loop and the T105 inline-wait); `deps.ts` extended with `DelegateDeps`; barrel-exported from `src/handlers/index.ts` and `src/index.ts`). Four phases: (1) `agent.tools {agent_id}` → resolve the target's published `input_schema` via `projectTools` (re-fetched, never trusted from model input); (2) validate `args` against it **before** `call.start` — a mismatch returns `invalid_args` without dispatching; (3) `call.start` with the caller's or a freshly generated `idempotency_key` in params; (4) `callResponseToResult` normalizes the `CallResponse` into the envelope. A non-terminal result + positive `wait_ms` composes `mx_await_result` (inheriting T103's "expiry → pending, not timeout"). **Resolved decisions:** (#1) `callResponseToResult` as a distinct function — keeps `invocationToResult` (T103) untouched and each verb's tokenless semantics correct; (#2) client-side validation is a fast-fail convenience — an absent/malformed target schema degrades to "let the daemon decide", never a hard block; (#3) the session `room` is injected via `DelegateDeps.room` (never model input); a missing room fails fast as `internal` before any dispatch; (#4) a module-level lazy default Ajv validator covers the common path without deps wiring. First handler to emit populated `audit_ref` ids (real Matrix round-trip, `null` when omitted, never fabricated) and to exercise the idempotency contract end-to-end. **Pending the two-daemon round-trip** (`MXL_CONFORMANCE_TWO_DAEMON=1`): `call.start` param names, `CallResponse` disposition vocabulary, `approval` fields, `audit_ref` field availability — authored against the design's named shapes now, localized in module consts, with `internal`-safe fallbacks (a new daemon code degrades to `internal`, never the wrong code).

#### T106 · tool: `mx_run_command` (guarded exec)
`area/registry` `area/policy` `type/feature` `P0` · **M** · M1
- **Context:** `exec.start` → `ExecRequest`. Disabled by default; enabled per-agent only behind `allow_commands` + `deny_args_regex`.
- **Scope:** Tool ships off; surfaces `policy_denied` cleanly when not allowlisted; passes idempotency/nonce.
- **Out of scope:** Streaming output into the model (avoided in v1).
- **Acceptance criteria:**
  - [x] Disabled by default → `policy_denied` — the handler performs **no** allowlist check; a daemon deny-by-default outcome (a thrown `rpc`/`policy_denied`, **or** a resolved `ExecResponse{ok:false, error:{code:policy_denied}}`, **or** a `state:'policy_denied'` token) maps to `denied('policy_denied')` via the shared `faultToResult` / `callResponseToResult` path. "Disabled by default" is a *receiver policy* property the handler surfaces, never enforces.
  - [x] With an `allow_commands` entry, an allowlisted command runs and returns the envelope — a synchronous `exec.start` success normalizes to `ok({ exit_code, summary?, log_ref? }, audit_ref)` with the exec payload passed through verbatim and `audit_ref` populated from the round-trip. A permitted command that **exits non-zero** is still `status: ok` with `result.exit_code !== 0` (the envelope status is the governance outcome, not the command's exit).
  - [x] A `deny_args_regex` match is blocked — args that trip the receiver's regex come back as `policy_denied` and map identically to AC 1. **Honesty caveat:** at the unit layer this is indistinguishable from "not allowlisted" (both are "daemon returned `policy_denied`"); the *policy configuration* that yields each is a two-daemon conformance concern (the staged exec fixture), not a distinction the handler can or should make.
- **Dependencies:** blocked-by T102
- **Status:** Landed (`packages/registry/src/handlers/run-command.ts` — `mxRunCommand` / `RunCommandInput`; `deps.ts` refactored to extract a shared `RoomScopedDeps extends HandlerDeps { room? }` that both `DelegateDeps` (re-pointed) and the new `ExecDeps` extend — `ExecDeps` is `RoomScopedDeps` with **no** validator; `invocation.ts`' `callResponseToResult` reused verbatim (now documented as verb-agnostic — it also normalizes an `ExecResponse`); barrel-exported from `src/handlers/index.ts` and `src/index.ts`). The leaner sibling of T105 — **three phases** (no inner-schema fetch, no args validation, since exec has a fixed input shape): (1) room provenance — a missing/empty `deps.room` fails fast as `errored('internal', …, EMPTY_AUDIT_REF)` before any dispatch; (2) `exec.start` with the caller's or a freshly generated `idempotency_key` in params (`command`/`args`/`cwd` forwarded verbatim — `args` defaults to `[]`, `cwd` omitted when absent so no `undefined` leaks; a dispatch rejection maps via `faultToResult`); (3) `callResponseToResult` normalizes the `ExecResponse` across every disposition (sync `ok`, deferred `running`, held `awaiting_approval` with fail-safe `high` risk, denial/fault terminals). A non-terminal result + positive `wait_ms` composes `mx_await_result` (inheriting T103's "expiry → pending, not timeout"). **The guard is entirely receiver-side** (`area/policy`): the handler emits a signed `exec.start` and performs **no** `allow_commands`/`deny_args_regex`/`allow_cwd`/sandbox/`requires_approval` check — all five enforcement layers run out-of-process on the receiving daemon (design §1, §6 layer 4, §9). **Secret boundary:** `command`/`args`/`cwd` ride through the concrete `MxClient` whose `assertNoCredentialShapedArgs` (keys **and** values) rejects a token-shaped arg as `invalid_args` and whose `redactSecrets` scrubs token-shaped daemon values inbound — matters more for exec than delegation (args are the likeliest secret-inlining surface); the registry re-implements neither and keeps its zero **runtime** toolbelt dep. `mx_run_command` stays in `MODEL_FACING_ALLOWLIST` and is **not** a forbidden authority verb. Tests: `test/handlers/run-command.test.ts` (AC 1–3, non-zero-exit convention, deferred dispositions, idempotency, inline `wait_ms`, `args`/`cwd` omission, robustness/never-throws) + `test/handlers/run-command.security.test.ts` (credential-shaped `command`/`args` → `invalid_args` via the **real** toolbelt guard at the registry boundary, inbound redaction, secret-free messages, no-authority invariants, immutability). **Pending the two-daemon round-trip** (`MXL_CONFORMANCE_TWO_DAEMON=1`): unlike `call.start`, `exec.start` has **no** existing conformance probe — the `exec.start` param names (`room`/`agent`/`command`/`args`/`cwd`/`idempotency_key`), the `ExecResponse` disposition vocabulary, the success payload field names (`exit_code`/`summary`/`log_ref`), the `approval` fields, and the `audit_ref` availability are authored against the design's named shapes now (localized in a module const), pinned at the round-trip (a new daemon code degrades to `internal`, never the wrong code). The staged exec conformance fixture + the golden end-to-end test (T114) land later.

#### T107 · tool: `mx_share_context` + `mx_get_context`
`area/registry` `type/feature` `P1` · **M** · M1
- **Context:** Cross-agent context exchange (`share.file/diff/env`, `share.list/get`) as `com.mxagent.context.share.v1`.
- **Scope:** Inline ≤256 KiB vs Matrix-media path; sha256; fetch by `context_id`.
- **Out of scope:** Runtime-private memory (never touched).
- **Acceptance criteria:**
  - [x] Share a diff, list it, fetch it back byte-identical — `mx_share_context({kind:'diff', content})` maps to `share.diff` and normalizes the reply to `ok({ context_id, sha256 }, audit_ref)`; `mx_get_context({context_id})` maps to `share.get` and surfaces `{ context_id, kind?, sha256?, size_bytes?, inline? }` verbatim (the descriptor's get output is `additionalProperties: true`). At the **unit** layer the round-trip + byte-identity are simulated by the fake `DaemonCall`'s return shapes; the live byte-identity (and the "list it" step against `share.list`) is pinned by the staged two-daemon conformance fixture. The AC-1 byte-identity guarantee holds for secret-free artifacts (the realistic case — normal diffs/files); a token-shaped substring would trip the share-time value guard or inbound `redactSecrets` (spec Risk #4).
  - [x] >256 KiB artifact uses media path with sha256 verification — the ≤256 KiB inline threshold, the Matrix-media upload/download, the content-addressing, and the authoritative sha256 over *stored* bytes are **substrate** behavior. `mx_get_context` **surfaces** the daemon's `media_mxc` reference + `sha256` (an `inline`-absent reply signals the media path) and **downloads no Matrix media** — the daemon (holding the Matrix session mx-loom never has, Boundary A) fetches and verifies the digest. The handler trusts and passes through the digest + path discriminator; it performs no client-side threshold/chunking/sha256 logic. The actual >256 KiB split + media verification is the staged conformance concern.
- **Dependencies:** blocked-by T102
- **Status:** Landed (`packages/registry/src/handlers/share-context.ts` — `mxShareContext` / `ShareContextInput`; `get-context.ts` — `mxGetContext` / `GetContextInput`; `context-response.ts` — the shared flat-payload classifier `contextResponseToResult`; `invocation.ts` refactored to **export** the response readers `extractAuditRef` / `hasErrorSignal` / `failureCode` (previously module-private) so the share handlers reuse the **single** correlation-id reader + error-code classifier rather than duplicating ~30 lines; `errors.ts` gains the unknown-context daemon-code aliases `unknown_context` / `no_such_context` / `context_not_found` → `not_found`; barrel-exported from `src/handlers/index.ts` and `src/index.ts`). Two **`sync`** verbs reusing the `RoomScopedDeps` seam (**no** validator — there is no dynamic inner schema): `mxShareContext` is **three phases** — (1) room provenance — a missing/empty `deps.room` fails fast as `errored('internal', …, EMPTY_AUDIT_REF)` before any dispatch (mirrors T105/T106); (2) resolve the `share.file`/`share.diff`/`share.env` RPC from `kind` (localized in a module const; a defensive out-of-enum `kind` → `invalid_args` before dispatch); (3) dispatch with `room` from the session and `path`/`content`/`encoding` forwarded **verbatim** (omitted when absent so no `undefined` leaks), then normalize via `contextResponseToResult` → `ok({ context_id, sha256 }, audit_ref)` (a publish IS a Matrix round-trip → populated `audit_ref`). `mxGetContext` is **two phases** — room provenance → `share.get { context_id, room }` → normalize, passing the get fields through verbatim with `audit_ref` extracted if present, else all-null. **The inline-vs-media (≤256 KiB) split + sha256 are substrate behavior the handlers SURFACE, never reimplement** — no client-side threshold check, no media chunking, no sha256 computation, and **no Matrix-media download** (the daemon holds the credentials; Boundary A). **Secret boundary — the single most dangerous exfiltration surface, doubly bounded:** `content`/`path` ride through the concrete `MxClient` whose `assertNoCredentialShapedArgs` (keys **and** values) rejects a token-shaped `content`/`path` as `invalid_args` *before publish* (you cannot exfiltrate a credential-shaped secret by sharing it), and whose `redactSecrets` scrubs token-shaped daemon values on fetch; `kind:'env'` is doubly bounded (daemon secrets never cross Boundary A, so a model-assembled env snapshot cannot contain them by construction). The registry re-implements neither guard and keeps its zero **runtime** toolbelt dep (the seam is injected, imported `type`-only). Both verbs stay in `MODEL_FACING_ALLOWLIST` and are **not** forbidden authority verbs; an unknown `context_id` maps to `not_found`. **Idempotency:** none added — content-addressing makes a re-share naturally idempotent (the recommended M1 default; revisit toward an `idempotency_key` only if the daemon proves not to content-address). **Pending the two-daemon round-trip** (`MXL_CONFORMANCE_TWO_DAEMON=1`): `share.*` is the *least*-verified surface in the design-§2 table ("◻️ documented", not flag-confirmed, no existing conformance probe) — the `share.file/diff/env` / `share.get` param names (`room`/`path`/`content`/`encoding`; `context_id`/`room`), the success field names (`context_id`/`sha256`/`inline`/`media_mxc`/`size_bytes`), whether share publishes a Matrix event (populated `audit_ref`) and whether `share.get` is a local read or a media round-trip, and the unknown-context daemon code spelling are authored against the design's named shapes now (localized consts + `internal`/`not_found`-safe fallbacks), pinned at the round-trip (a new daemon code degrades to `internal`/`not_found`, never the wrong code). The staged `share.*` conformance fixture (byte-identity AC 1 + media-path AC 2) + the golden end-to-end test (T114) land later.

#### T108 · tool: `mx_cancel` + `mx_workspace_status`
`area/registry` `type/feature` `P1` · **S** · M1
- **Context:** `invocation.cancel`, `workspace.status`.
- **Scope:** Cancel an in-flight invocation; report workspace agents/tasks/project.
- **Out of scope:** Task DAG tools (M3).
- **Acceptance criteria:**
  - [ ] Cancelling a running handle transitions it to cancelled
  - [ ] `mx_workspace_status` lists registered agents + project context
- **Dependencies:** blocked-by T102

#### T109 · binding: MCP server generated from the canonical registry
`area/mcp` `type/feature` `P0` · **L** · M1
- **Context:** Universal binding consumed by Claude/ADK/OpenCode/Pi.
- **Scope:** Generate MCP tools from descriptors; stdio + remote transports; map the envelope; async via `mx_await_result`.
- **Out of scope:** Runtime-specific shims (M2).
- **Acceptance criteria:**
  - [ ] An MCP client lists all `mx_*` tools with correct schemas
  - [ ] A delegated call round-trips through the MCP server
  - [ ] `awaiting_approval` surfaces correctly over MCP
- **Dependencies:** blocked-by T103, T104, T105

#### T110 · binding: Claude Agent SDK in-process shim
`area/claude-binding` `type/feature` `P0` · **L** · M1
- **Context:** Default mx-agency runner; `createSdkMcpServer` + `tool()`, `canUseTool` wired to approval status.
- **Scope:** Register `mx_*` tools in-process; `canUseTool` short-circuits to daemon approval state; hides the `mx_await_result` poll loop.
- **Out of scope:** External-MCP variant (covered by T109).
- **Acceptance criteria:**
  - [ ] A Claude-SDK agent can call `mx_delegate_tool` and receive the result
  - [ ] `canUseTool` presents HITL for an approval-gated call without exposing secrets
- **Dependencies:** blocked-by T103, T105, T111

#### T111 · chore: JSON Schema → Zod converter
`area/claude-binding` `type/chore` `P1` · **S** · M1
- **Context:** Claude `tool()` uses Zod; descriptors are JSON Schema.
- **Scope:** Converter covering the subset used by tool input schemas; tests on representative schemas.
- **Out of scope:** Full JSON-Schema spec coverage.
- **Acceptance criteria:**
  - [ ] All v1 tool input schemas convert and validate equivalently
- **Dependencies:** blocked-by T101

#### T112 · policy: minimal v1 `policy.toml` fixture
`area/policy` `type/chore` `P0` · **S** · M1
- **Context:** Deterministic env for the golden test.
- **Scope:** Allow two named tools + one allowlisted command; `network = "deny"`; `requires_approval` on the high-risk path.
- **Out of scope:** Policy authoring UI (M4).
- **Acceptance criteria:**
  - [ ] Fixture loads on the target daemon
  - [ ] Drives both the allowed and approval-gated golden-test branches
- **Dependencies:** none

#### T113 · audit: Postgres audit mirror of `audit_ref`
`area/audit` `type/feature` `P1` · **M** · M1
- **Context:** Two-tier audit — substrate is truth; Postgres is the queryable index (ADR-07/ADR-10).
- **Scope:** Write a row per tool result (`invocation_id`, `request_id`, `room`, `event_id`, status); minimal schema/migration.
- **Out of scope:** Multi-tenant RLS (M5).
- **Acceptance criteria:**
  - [ ] Every tool result produces exactly one audit row
  - [ ] Rows correlate model action ↔ daemon invocation ↔ approval
- **Dependencies:** blocked-by T102

#### T114 · test: GOLDEN end-to-end (approval-gated, both bindings)
`area/test` `type/test` `P0` · **L** · M1 · **← M1 exit**
- **Context:** The one test that exercises every boundary.
- **Scope:** A Claude-SDK agent delegates `run_tests` **and** a guarded command to a second registered agent across a room → approval gate → operator approves → result returns. Run via **both** the MCP server and the Claude native shim; assert audit rows.
- **Out of scope:** Other runtimes (M2).
- **Acceptance criteria:**
  - [ ] Named-tool delegation succeeds end-to-end
  - [ ] Guarded command runs only after approval; denial path also asserted
  - [ ] Passes through MCP binding and Claude native shim
  - [ ] Audit rows present for each step
- **Dependencies:** blocked-by T105, T106, T109, T110, T112, T113

---

## M2 — Universal binding

> **Epics:** E2.1 ADK · E2.2 OpenCode · E2.3 Pi · E2.4 Portability proof

#### T201 · binding: ADK `MCPToolset` integration
`area/adk` `type/feature` `P0` · **M** · M2
- **Context:** Mount the toolbelt MCP server on an `LlmAgent`.
- **Scope:** `tools=[MCPToolset(...)]` wiring; session/`ToolContext` mapping.
- **Acceptance criteria:**
  - [ ] An ADK agent lists and calls `mx_*` tools via MCP
- **Dependencies:** blocked-by T109

#### T202 · binding: ADK `LongRunningFunctionTool` approval shim
`area/adk` `type/feature` `P0` · **M** · M2
- **Context:** ADK's long-running protocol matches mx-agent's `awaiting_approval`.
- **Scope:** Wrap `mx_delegate_tool` / `mx_run_command` as long-running; pending ticket → resume on result.
- **Acceptance criteria:**
  - [ ] An approval-gated call yields a pending ticket and resumes on approval
  - [ ] The agent can do other work while pending
- **Dependencies:** blocked-by T201, T103

#### T203 · binding: OpenCode MCP server entry
`area/opencode` `type/feature` `P0` · **S** · M2
- **Context:** OpenCode consumes MCP servers via `opencode.json`.
- **Scope:** Local-stdio + remote server entries; verify tool surfacing.
- **Acceptance criteria:**
  - [ ] An OpenCode agent calls `mx_delegate_tool` via the configured MCP server
- **Dependencies:** blocked-by T109

#### T204 · spike: Pi tool-surface capability
`area/pi` `type/spike` `P0` · **S** · M2
- **Context:** Confirm whether `@earendil-works/pi-coding-agent` supports MCP or needs native tool registration.
- **Scope:** Determine the integration path; document it.
- **Acceptance criteria:**
  - [ ] Decision recorded: MCP vs native registration for Pi
- **Dependencies:** none (do early)

#### T205 · binding: Pi
`area/pi` `type/feature` `P0` · **M** · M2
- **Context:** Thin map from canonical registry to Pi's tool type (or MCP, per T204).
- **Scope:** Implement per the T204 decision; reuse the `AgentRunner` seam.
- **Acceptance criteria:**
  - [ ] A Pi agent calls `mx_delegate_tool` and receives the result
- **Dependencies:** blocked-by T204, T109 (or T101 if native)

#### T206 · test: portability matrix
`area/test` `type/test` `P0` · **M** · M2 · **← M2 exit**
- **Context:** Same descriptors must work everywhere.
- **Scope:** Run the (subset) golden test under ADK, OpenCode, Pi.
- **Acceptance criteria:**
  - [ ] Golden scenario passes under all three runtimes
- **Dependencies:** blocked-by T202, T203, T205

#### T207 · docs: per-runtime integration guide
`area/docs` `type/docs` `P1` · **S** · M2
- **Scope:** How to mount the toolbelt in each runtime (ADK/Claude/OpenCode/Pi/custom).
- **Acceptance criteria:**
  - [ ] One copy-pasteable setup per runtime, verified against T206
- **Dependencies:** blocked-by T206

---

## M3 — Coordination depth

> **Epics:** E3.1 Task DAG tools · E3.2 Durable resumption

#### T301 · tool: `mx_create_task` / `mx_update_task` / `mx_list_tasks`
`area/registry` `type/feature` `P0` · **M** · M3
- **Context:** The DAG (`com.mxagent.task.v1`) is the durable shared plan.
- **Scope:** Create/update/list/graph with `depends_on` / `blocks`; map states.
- **Acceptance criteria:**
  - [ ] Create a task with deps; list reflects the DAG; update transitions state
- **Dependencies:** blocked-by T102

#### T302 · feature: `task.watch` resumption
`area/toolbelt` `type/feature` `P0` · **L** · M3
- **Context:** Crash-recovery boundary — a runtime resumes from task state.
- **Scope:** Subscribe to the task stream; reconstruct a cognitive session from durable state after restart.
- **Acceptance criteria:**
  - [ ] A killed-and-restarted runtime resumes the plan from task state
- **Dependencies:** blocked-by T301, T005

#### T303 · feature: signed task-action dispatch alignment
`area/registry` `area/policy` `type/feature` `P1` · **M** · M3
- **Context:** Task `action` carries signed authorization (exec/tool).
- **Scope:** Ensure `mx_create_task` actions map to a properly authorized exec/tool action.
- **Acceptance criteria:**
  - [ ] A task action runs through the full authorize pipeline on dispatch
- **Dependencies:** blocked-by T301

#### T304 · test: multi-agent plan with restart
`area/test` `type/test` `P0` · **L** · M3 · **← M3 exit**
- **Scope:** A plan executes across ≥2 agents; kill+restart a runtime mid-plan; verify resume.
- **Acceptance criteria:**
  - [ ] Plan completes across agents
  - [ ] Mid-plan restart resumes from durable task state
- **Dependencies:** blocked-by T302, T303

#### T305 · docs: cognition-vs-coordination state guide
`area/docs` `type/docs` `P2` · **S** · M3
- **Scope:** What's runtime-private memory vs MX shared/task state.
- **Acceptance criteria:**
  - [ ] Guide published with concrete examples
- **Dependencies:** blocked-by T301

---

## M4 — Governance UX

> **Epics:** E4.1 Trust onboarding · E4.2 Policy authoring · E4.3 Approval dashboard

#### T401 · feature: trust-onboarding flow (operator-only)
`area/approvals` `area/policy` `type/feature` `P0` · **M** · M4
- **Context:** `(agent_id, key_id)` trust is approved out-of-band; never a model tool.
- **Scope:** Operator approve/revoke wrapper; surface `untrusted_key` as an onboarding hint to the model.
- **Acceptance criteria:**
  - [ ] Operator can approve a new agent's key; model sees `untrusted_key` until then
  - [ ] No trust-mutation tool is exposed to the model
- **Dependencies:** none

#### T402 · feature: policy authoring UI/CLI
`area/policy` `type/feature` `P0` · **L** · M4
- **Scope:** Author per-agent `allow_tools` / `allow_commands` / `deny_args_regex` / `allow_cwd` / `requires_approval` with validation.
- **Acceptance criteria:**
  - [ ] Author + validate a policy without hand-editing TOML
  - [ ] Invalid policy is rejected with actionable errors
- **Dependencies:** blocked-by T401

#### T403 · feature: approval dashboard
`area/approvals` `type/feature` `P0` · **L** · M4
- **Context:** Wired to `approval.request` / `approval.decision`; re-validation at release.
- **Scope:** Operator decide UI; show pending requests; emit signed decisions.
- **Acceptance criteria:**
  - [ ] Operator approves/denies; the held call resolves accordingly
  - [ ] Decision re-runs the authorize pipeline at release
- **Dependencies:** blocked-by T113

#### T404 · feature: risk surfacing in dashboard
`area/approvals` `type/feature` `P1` · **S** · M4
- **Scope:** Show `risk` / `summary` / `expires_at` from the approval envelope.
- **Acceptance criteria:**
  - [ ] Each pending request shows risk + expiry; expired requests are marked
- **Dependencies:** blocked-by T403

#### T405 · test: governance end-to-end
`area/test` `type/test` `P0` · **M** · M4 · **← M4 exit**
- **Scope:** Onboard a new runtime agent and policy-scope it with **no code changes**; approval fully audited.
- **Acceptance criteria:**
  - [ ] New agent onboarded via operator flow only
  - [ ] Its calls are policy-scoped; approval trail is complete in the audit store
- **Dependencies:** blocked-by T401, T402, T403

---

## M5 — Multi-tenant + observability

> **Epics:** E5.1 Tenant scoping · E5.2 Observability & cost

#### T501 · feature: tenant=room scoping (ADR-03)
`area/toolbelt` `area/audit` `type/feature` `P0` · **L** · M5
- **Scope:** Scope sessions, tools, and audit by tenant (room); align with RLS partitioning.
- **Acceptance criteria:**
  - [ ] Tools operate within a tenant boundary; cross-tenant access denied
- **Dependencies:** blocked-by T005

#### T502 · feature: two-tier audit/index
`area/audit` `type/feature` `P0` · **M** · M5
- **Scope:** Substrate truth + per-tenant queryable Postgres index (RLS).
- **Acceptance criteria:**
  - [ ] Per-tenant audit queries return only that tenant's rows
- **Dependencies:** blocked-by T113, T501

#### T503 · feature: observability (logs/metrics/traces) — ADR-08
`area/ci` `area/toolbelt` `type/feature` `P1` · **M** · M5
- **Scope:** Structured logging, metrics, and traces for tool calls.
- **Acceptance criteria:**
  - [ ] Each tool call emits a trace span + metrics; redaction verified
- **Dependencies:** none

#### T504 · feature: cost guardrails (ADR-12)
`area/toolbelt` `type/feature` `P1` · **M** · M5
- **Scope:** Per-call cost attribution + per-feature caps/alerts.
- **Acceptance criteria:**
  - [ ] Per-call cost recorded and attributable to tenant/agent
  - [ ] Cap breach triggers an alert
- **Dependencies:** blocked-by T503

#### T505 · test: multi-tenant isolation
`area/test` `type/test` `P0` · **M** · M5 · **← M5 exit**
- **Scope:** N tenants isolated (RLS); per-tenant audit queryable; per-call cost attributed.
- **Acceptance criteria:**
  - [ ] Isolation, audit queryability, and cost attribution all asserted
- **Dependencies:** blocked-by T501, T502, T504

---

## M6 — Production hardening

> **Epics:** E6.1 Certification · E6.2 Resilience · E6.3 Distribution

#### T601 · test: per-runtime conformance certification
`area/test` `area/contract` `type/test` `P0` · **L** · M6
- **Scope:** Formal suite per runtime — the "MX-Agent inside" badge.
- **Acceptance criteria:**
  - [ ] Each runtime passes a documented conformance suite
- **Dependencies:** blocked-by T206

#### T602 · chore: publish the MCP server
`area/mcp` `type/chore` `P1` · **M** · M6
- **Scope:** Package + registry listing for the generated MCP server.
- **Acceptance criteria:**
  - [ ] Installable from a public registry; versioned to the pin
- **Dependencies:** blocked-by T109

#### T603 · test: chaos/fault on approval + revocation
`area/test` `type/test` `P0` · **L** · M6
- **Scope:** Revoke trust mid-flight; stale/expired approval; target offline.
- **Acceptance criteria:**
  - [ ] Revocation mid-flight blocks release
  - [ ] Stale approval is rejected at release; offline target returns `target_offline`
- **Dependencies:** blocked-by T403

#### T604 · feature: E2EE-on-by-default workspaces
`area/daemon` `area/policy` `type/feature` `P1` · **M** · M6
- **Scope:** Default workspaces to `--e2ee on`; verify tool/context flows under Megolm.
- **Acceptance criteria:**
  - [ ] New workspaces are E2EE by default; golden test still passes
- **Dependencies:** blocked-by T114

#### T605 · feature: SLA monitoring + alerting
`area/ci` `type/feature` `P2` · **M** · M6
- **Scope:** Latency/availability SLOs on delegation + approval; alerts.
- **Acceptance criteria:**
  - [ ] SLO dashboards live; breach alerts fire
- **Dependencies:** blocked-by T503

---

## Open questions / gaps (flagged, not invented)

1. **Target repo — RESOLVED.** Issues land in the dedicated `kortiene/mx-loom` repo (this repo, branded `mx-loom`). Confirm the GitHub **owner** (`kortiene` vs a personal org) before `gh repo create`.
2. **Numbering overlap — RESOLVED by the dedicated repo.** Because `mx-loom` is a fresh repo, issue numbers start at #1 with no collision against mx-agency's ~#35–#129. Keep cross-references to mx-agency issues (e.g. #37) fully qualified as `kortiene/mx-agency#37`.
3. **Daemon surface confirmation.** Several issues assume the design-§2 RPC methods exist as documented on v0.2.1 — `T001` is the gate; deltas may reshape M0/M1.
4. **Pi MCP support unknown** — `T204` resolves; `T205`'s shape depends on it.
5. **Toolbelt home — RESOLVED.** `mx-loom` ships as a standalone published package; mx-agency consumes it behind its `app/src/sdk` seam (`kortiene/mx-agency#37`). Affects T004, T602.
6. **Estimates are t-shirt placeholders** — re-point once the team calibrates.

---

## Next step (gated)

After review/approval of this backlog, generate idempotent `gh` commands:
`gh milestone create` for M0–M6, then `gh issue create --milestone … --label … --body-file …` per issue (bodies rendered from the sections above), targeting `kortiene/mx-loom`. Confirm the GitHub owner first (Open Question #1).
