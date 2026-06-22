# MX-Agent Tool-Fabric — Implementation Backlog

Derived from [`mx-agent-tool-fabric-design.md`](./mx-agent-tool-fabric-design.md). Cross-references mx-agency ADR-11 (integration contract), ADR-04 (runtime cognition), ADR-03/07/08/10/12, and issue #37 (SDK seam).

| | |
|---|---|
| Status | Active — M0 in progress; GitHub issues live in `kortiene/mx-loom` (T001–T005 delivered) |
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
  - [ ] `.mx-agent-version` records `v0.2.1`
  - [ ] Pin-bump policy documented
- **Dependencies:** none

#### T007 · contract: conformance suite gating the version pin
`area/contract` `area/ci` `type/test` `P0` · **M** · M0
- **Context:** Verify the toolbelt's assumed surface against the pinned daemon before any bump.
- **Scope:** Automated suite asserting `agent.register` / `agent.list` / `call.start` round-trips; CI job; red on surface drift.
- **Out of scope:** Per-runtime certification (T601).
- **Acceptance criteria:**
  - [ ] Suite runs in CI against a live daemon
  - [ ] Green on v0.2.1; documented as the pin-bump gate
- **Dependencies:** blocked-by T004, T006

#### T008 · toolbelt: secret-boundary guard (no secret crosses Boundary A)
`area/toolbelt` `type/feature` `P0` · **S** · M0
- **Context:** Reinforce mx-agency's rule — `MATRIX_*`, `MX_AGENT_*`, provider keys, `GH_TOKEN` never reach the runtime process or model context.
- **Scope:** Outbound arg scrubber + inbound result redaction; deny-list + tests; reject credential-shaped args.
- **Out of scope:** Sandbox enforcement (daemon-side).
- **Acceptance criteria:**
  - [ ] Attempt to pass a secret-shaped arg is rejected with `invalid_args`
  - [ ] No allowlisted-secret env var appears in any tool payload (test asserts)
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
  - [ ] Descriptors validate as JSON Schema
  - [ ] Registry enumerable; binding generators can read it
- **Dependencies:** blocked-by T004

#### T102 · registry: normalized result envelope + error taxonomy + idempotency
`area/registry` `type/feature` `P0` · **M** · M1
- **Context:** §4 — one envelope shape every tool returns.
- **Scope:** `{status, result, error, handle, approval, audit_ref}`; closed `error.code` set (`policy_denied|untrusted_key|approval_denied|approval_expired|timeout|not_found|invalid_args|target_offline|internal`); client-supplied `idempotency_key` plumbing.
- **Out of scope:** Async resolution (T103).
- **Acceptance criteria:**
  - [ ] Every tool result conforms to the envelope schema
  - [ ] Error codes are closed-set and tested
  - [ ] Retried call with same `idempotency_key` does not double-execute
- **Dependencies:** blocked-by T101

#### T103 · registry: deferred-result protocol (`mx_await_result`)
`area/registry` `type/feature` `P0` · **M** · M1
- **Context:** Remote calls/approvals are async; long-running ops return a handle.
- **Scope:** `mx_await_result(handle, wait_ms)` over `invocation.get` (+ `task.watch` later); resolve `running`/`awaiting_approval` → terminal.
- **Out of scope:** Native long-running shims (M2).
- **Acceptance criteria:**
  - [ ] A `running` handle resolves to a terminal envelope
  - [ ] `awaiting_approval` resolves to `ok`/`denied` after an operator decision
  - [ ] `wait_ms` timeout returns the still-pending status without error
- **Dependencies:** blocked-by T102

#### T104 · tool: `mx_find_agents` + `mx_describe_agent`
`area/registry` `type/feature` `P0` · **S** · M1
- **Context:** Discovery verbs (`agent.list` + filter; `agent.show` + `agent.tools`).
- **Scope:** Capability/tool/liveness filtering; return published `ToolSchema[]` for an agent.
- **Out of scope:** Trust mutation (operator-only).
- **Acceptance criteria:**
  - [ ] Filter by capability returns expected agents
  - [ ] `mx_describe_agent` returns the target's tool schemas
- **Dependencies:** blocked-by T101

#### T105 · tool: `mx_delegate_tool` (primary delegation verb)
`area/registry` `type/feature` `P0` · **M** · M1
- **Context:** `call.start` → `CallRequest`/`CallResponse`; the core remote-tool verb.
- **Scope:** Pass inner `input_schema` through from the target's `ToolSchema`; validate args; map response into the envelope (incl. `awaiting_approval`).
- **Out of scope:** Guarded exec (T106).
- **Acceptance criteria:**
  - [ ] Valid call returns `status: ok` with `result` matching `output_schema`
  - [ ] Invalid args rejected as `invalid_args` before dispatch
  - [ ] Policy-denied target returns `policy_denied`
- **Dependencies:** blocked-by T102, T104

#### T106 · tool: `mx_run_command` (guarded exec)
`area/registry` `area/policy` `type/feature` `P0` · **M** · M1
- **Context:** `exec.start` → `ExecRequest`. Disabled by default; enabled per-agent only behind `allow_commands` + `deny_args_regex`.
- **Scope:** Tool ships off; surfaces `policy_denied` cleanly when not allowlisted; passes idempotency/nonce.
- **Out of scope:** Streaming output into the model (avoided in v1).
- **Acceptance criteria:**
  - [ ] Disabled by default → `policy_denied`
  - [ ] With an `allow_commands` entry, an allowlisted command runs and returns the envelope
  - [ ] A `deny_args_regex` match is blocked
- **Dependencies:** blocked-by T102

#### T107 · tool: `mx_share_context` + `mx_get_context`
`area/registry` `type/feature` `P1` · **M** · M1
- **Context:** Cross-agent context exchange (`share.file/diff/env`, `share.list/get`) as `com.mxagent.context.share.v1`.
- **Scope:** Inline ≤256 KiB vs Matrix-media path; sha256; fetch by `context_id`.
- **Out of scope:** Runtime-private memory (never touched).
- **Acceptance criteria:**
  - [ ] Share a diff, list it, fetch it back byte-identical
  - [ ] >256 KiB artifact uses media path with sha256 verification
- **Dependencies:** blocked-by T102

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
