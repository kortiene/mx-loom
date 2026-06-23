# T114 · GOLDEN end-to-end (approval-gated, both bindings)

> GitHub issue **#22** · `area/test` `type/test` `P0` · **L** · Milestone **M1 — Delegation MVP** · **← M1 exit gate**
> Source: `docs/backlog.md` (`T114`). Blocked-by **#13 (T105)**, **#14 (T106)**, **#17 (T109)**, **#18 (T110)**, **#20 (T112)**, **#21 (T113)** — all landed at the mechanism layer; their *live* arms are staged behind `MXL_CONFORMANCE_TWO_DAEMON=1`, which this task closes.

## Problem Statement

Every M1 piece exists and is unit-proven, but nothing has yet driven **a model → both bindings → a real daemon round-trip → an approval gate → an operator decision → a returned result → an audit row** in one flow. The design (`docs/mx-agent-tool-fabric-design.md` §8, §5) names exactly this as the M1 exit:

> *Golden end-to-end test: a Claude-SDK agent calls `mx_delegate_tool("run_tests")` on a second registered agent across a room, hits an approval gate, operator approves, result returns. The same scenario runs through the MCP server binding too. One test, every boundary.*

Today the closest things are:

- `packages/mcp/test/conformance/mcp.conformance.test.ts` — drives `tools/list` and `mx_delegate_tool` through the **MCP binding** against a live two-daemon fixture, but has **no approval-gated path**, **no guarded-exec path**, **no operator decision**, and **no audit-row assertion**. AC3 only checks that an `awaiting_approval` envelope serializes correctly — it never resolves it.
- `packages/toolbelt/test/conformance/await-result.conformance.test.ts` AC2 and `policy-golden.conformance.test.ts` AC2 — exercise `awaiting_approval` against the golden policy, but only assert the **initial hold**; the operator-decision step is explicitly deferred ("requires an out-of-band operator bot … lands with T114's bring-up").
- `packages/claude/test/shim.integration.test.ts` — exercises the Claude shim end-to-end but against a **fake `DaemonCall`**, never a live daemon, never a real model.
- `packages/audit/test/binding-e2e.test.ts` — proves the `withAudit` tap and `InMemoryAuditSink` correlation against **synthesised** envelopes, never envelopes produced by a live binding+daemon round-trip.

The gaps T114 must close: (1) there is **no operator-approval driver** (the thing that says "yes"/"no" out-of-band on daemon B); (2) the golden bring-up in `bootstrap-daemon-b.sh` is **incomplete** — it does not yet register the approval tool as published, enable guarded exec, or export the `MXL_CONFORMANCE_APPROVAL_*` / `MXL_CONFORMANCE_ALLOWED_COMMAND` coordinates ("lands with T114"); (3) there is **no test that ties a binding to a live daemon to an approval gate to an audit row**; (4) there is **no CI job** that runs the golden flow. This task builds the one test (across both bindings) plus the operator/out-of-band scaffolding it needs, and turns the staged-but-not-ticked ACs of #20/#21 green.

## Goals

Concrete outcomes (mapping to the issue's acceptance criteria):

1. **Named-tool delegation succeeds end-to-end** (AC1): a Claude-SDK-shaped cognition emits `mx_delegate_tool(@@ALLOW_TOOL@@)` (e.g. `run_tests@1.0.0`, `requires_approval=false`) at agent B across a real workspace room, and the binding returns `status: ok` with a `result` and a populated `audit_ref`.
2. **Guarded command runs only after approval; denial path also asserted** (AC2):
   - `mx_run_command(@@ALLOW_COMMAND@@, safeArgs)` → `awaiting_approval` → operator **approves** → resolves to `ok` (`exit_code`). The command does **not** execute before the approval.
   - A **denial path** is asserted two ways: (a) `mx_run_command(@@ALLOW_COMMAND@@, dangerousArgs)` tripping `deny_args_regex` → `policy_denied` (no approval ever requested); and (b) an approval-gated request the operator **denies** → `denied('approval_denied')`.
3. **Passes through MCP binding and Claude native shim** (AC3): the same scenario runs once via `@mx-loom/mcp` (`tools/call` over an MCP `Client`) and once via `@mx-loom/claude` (`createMxToolServer` + `canUseTool` composed as the SDK would), both against the same live daemon pair.
4. **Audit rows present for each step** (AC4): each binding applies `withAudit` at its single chokepoint into an injected `InMemoryAuditSink` (default) — and, behind `MXL_AUDIT_PG=1`, a live `PostgresAuditSink` — and the test asserts one row per emission, joinable by `correlation_id` / `invocation_id`, including the approval leg.
5. **The operator decision is genuinely out-of-process** — a separate operator client / `mx-agent approval` CLI invocation on daemon B, never the toolbelt, never a model tool. The binding surfaces the approval **only** as the `awaiting_approval` envelope status.
6. **Skip-clean locally, fail-not-skip in CI** — the golden suite skips with no daemon (developer laptop / fast unit CI) and goes **red** (never silently green) when `MXL_CONFORMANCE_TWO_DAEMON=1` is set but the fixture is unreachable, matching the existing conformance harness invariant.
7. **Both staged dependency ACs turn green:** T112 (#20) "drives both the allowed and approval-gated golden-test branches" and T113 (#21) "every tool result produces exactly one audit row" / "rows correlate model action ↔ daemon invocation ↔ approval" are asserted live by this flow.

## Non-Goals

- **Other runtimes (M2).** ADK / OpenCode / Pi binding arms are T206; only the MCP server and the Claude native shim are in scope here.
- **A real LLM in the loop as the default gate.** A deterministic scripted cognition driver is the primary, CI-stable golden arm; a real-model arm (`@anthropic-ai/claude-agent-sdk` `query()` with `ANTHROPIC_API_KEY`) is an **opt-in** addition behind a flag, never the M1-exit gate (cost/flakiness/secret-handling reasons — see Risks).
- **New product behavior in any binding, handler, descriptor, envelope, policy parser, or transport.** T114 is a test + test-scaffolding task; if the live round-trip reveals a daemon-surface delta, the *fix* lands in the owning package (T105/T106/T103/T109/T110/T112), not here. T114's job is to surface it, red.
- **Task-DAG, multi-agent plans, crash-recovery resumption** (M3 / T304).
- **Multi-tenant audit / RLS** (M5 / T502). The audit arm asserts single-tenant rows only.
- **Provisioning the homeserver / pinned daemon binary.** That provenance lives in the `mx-agent` repo and is wired by `scripts/conformance/install-mx-agent.sh` + `bootstrap-daemon-a.sh` (the open decision tracked in `scripts/conformance/README.md` "Provenance"); T114 consumes it.
- **Streaming command output into the model.** v2+ (design §9). The guarded-exec result is the `exit_code` / `summary` / `log_ref` envelope only.

## Relevant Repository Context

**Stack.** TypeScript, pnpm workspaces (`pnpm@9.12.0`), Node ≥20.19, vitest, Apache-2.0. The repo is **no longer docs-only** — M0 and the M1 mechanism layer have landed as real packages. The packages that exist today and that T114 composes:

| Package | Role for T114 | Key exports T114 uses |
|---|---|---|
| `@mx-loom/registry` (`packages/registry`) | Canonical descriptors + T102 envelope + handlers | `CANONICAL_M1_TOOLS`, `validateEnvelope`, `ToolResult`, `AuditRef` |
| `@mx-loom/toolbelt` (`packages/toolbelt`) | Boundary-B transport + session | `createClient` → `MxClient`, `openSession` → `MxSession`, `TransportError` |
| `@mx-loom/mcp` (`packages/mcp`) | **Binding arm A** — generated MCP server | `createMcpServer(ctx, opts)`, `createBindingContext(opts)`, `BindingContext`, `dispatchCall`, `serializeToolResult` |
| `@mx-loom/claude` (`packages/claude`) | **Binding arm B** — Claude in-process shim | `createMxToolServer(ctx, opts)`, `createMxCanUseTool` / `wrapCanUseTool`, `resolveDeferred`, `mxToolName` |
| `@mx-loom/audit` (`packages/audit`) | Audit assertion | `InMemoryAuditSink` (+ `byCorrelation`/`byInvocation`), `PostgresAuditSink` / `createPostgresAuditSink`, `withAudit`, `NullAuditSink` |

Both bindings already accept an injected `auditSink` through `createBindingContext({ auditSink })` and apply `withAudit` **once** at their single result-return chokepoint (`packages/mcp/src/server.ts:83`, and the Claude shim's `tool-server.ts`). Both accept an injected session or bare `DaemonCall`, so the golden harness can wire a **live** `MxSession`/`MxClient` (daemon A's socket) plus an `InMemoryAuditSink` and read rows directly. **The room always comes from `MxSession.room`, never model input** (`packages/mcp/src/context.ts`).

**Conformance scaffolding that exists.** `scripts/conformance/` provisions the two-daemon fixture: `install-mx-agent.sh` (pinned binary), `bootstrap-daemon-a.sh` (homeserver + daemon A + room), `bootstrap-daemon-b.sh` (daemon B + published tool(s) + **mutual Ed25519 trust** + receiver policy), `down.sh` (teardown + log scrub), `lib.sh` (`emit_output`, `wait_for_socket`, `die`). The golden policy fixture `scripts/conformance/policy.golden.toml` (T112) is the deny-by-default superset that drives every branch; `bootstrap-daemon-b.sh` already selects it via `POLICY_FIXTURE=policy.golden.toml`, substitutes the `@@…@@` coordinates, and fails loudly on any leftover placeholder. The harness env contract is defined in `packages/toolbelt/test/conformance/_harness.ts` and mirrored in `packages/mcp/test/conformance/_mcp-harness.ts`:

- `MXL_CONFORMANCE_TWO_DAEMON=1` — two-daemon fixture is up (fail-not-skip switch).
- `MXL_CONFORMANCE_GOLDEN_POLICY=1` — daemon B was started with `policy.golden.toml` (not the throwaway `policy.b.toml`).
- `MXL_CONFORMANCE_ROOM`, `MXL_CONFORMANCE_TARGET_AGENT`, `MXL_CONFORMANCE_TOOL`, `MXL_CONFORMANCE_DENIED_TOOL` — fixture coordinates.
- Already wired but **not yet exported by the bring-up** (the T114 gap): `MXL_CONFORMANCE_APPROVAL_TOOL` / `MXL_CONFORMANCE_APPROVAL_GATED_TOOL`, `MXL_CONFORMANCE_ALLOWED_COMMAND`, `MXL_CONFORMANCE_ALLOW_CWD`. `bootstrap-daemon-b.sh` substitutes them into the policy so it **loads**, but registering the approval tool as published, enabling exec, and `emit_output`-ing the coordinates is explicitly "lands with T114".
- `SECRET_PATTERN` — the shared regex every conformance test asserts no output matches.

**CI.** `.github/workflows/conformance.yml` has `structure` (always-on, daemon-free), `live` (Tier 0/1), and `delegate` (Tier 2 two-daemon) jobs, all live jobs `workflow_dispatch`-only until homeserver provenance is wired. T114 adds a golden job that brings up daemon B with the golden policy and runs the golden suite.

**What does NOT exist yet** (decisions to confirm — see Risks/Open Questions):

1. **A home package/dir for a cross-binding golden e2e.** No `packages/golden`, no top-level `e2e/`. The MCP and Claude arms live in separate packages today.
2. **An operator-approval driver** — nothing calls `approval.decide` / `mx-agent approval approve|deny` out-of-band. `await-result.conformance.test.ts` AC2 assumes "an out-of-band operator bot" that does not exist.
3. **The completed golden bring-up** (approval-tool registration on B, exec-enable, coordinate exports).
4. **A scripted cognition driver** shared across both binding arms.
5. **The live-Postgres audit assertion path** wired into a binding round-trip (the unit path exists in `@mx-loom/audit`; the e2e binding path is T114).

## Proposed Implementation

### Overview

Build a single, parameterised golden scenario run twice — once per binding — against the live two-daemon golden fixture, with a deterministic out-of-band operator. Structure it as a new private workspace package **`packages/golden`** (`@mx-loom/golden`, `"private": true`, not published) that depends on all five M1 packages plus the SDK type — this is the only place those packages are composed together, keeping each leaf package's dependency graph clean. (Alternative homes considered in Open Questions; this is the recommended default.)

```
packages/golden/
  package.json            # private; deps: @mx-loom/{registry,toolbelt,mcp,claude,audit}, @modelcontextprotocol/sdk,
                          #          @anthropic-ai/claude-agent-sdk (peer/dev, for the opt-in real-model arm only)
  vitest.config.ts        # long timeouts (90s+) for daemon round-trips; conformance excluded from default test run
  tsconfig.json / tsconfig.build.json
  test/
    _golden-harness.ts        # NOT a test file — env-flag gating + fixture coords + live-fixture builders + operator driver
    scenario.ts               # the shared, binding-agnostic scenario step list (the "what the model does")
    golden.mcp.e2e.test.ts    # arm A: scenario via @mx-loom/mcp
    golden.claude.e2e.test.ts # arm B: scenario via @mx-loom/claude shim
    golden.audit.e2e.test.ts  # cross-arm AC4: audit rows present + correlated for each step (both sinks)
  README.md
scripts/conformance/
  decide-approval.sh          # NEW — out-of-band operator decision driver on daemon B (approve|deny the pending request)
  bootstrap-daemon-b.sh       # EXTEND — register approval tool as published, enable exec, emit_output the coordinates
```

### The scenario (binding-agnostic step list)

`scenario.ts` exports an ordered list of **logical model actions**, each independent of how it is dispatched. A binding *adapter* (one per arm) knows how to turn `{ tool, args }` into a real binding call and return a normalised `ToolResult`. Steps:

| # | Logical action | Golden-policy branch | Expected terminal | Operator action |
|---|---|---|---|---|
| S1 | `mx_find_agents` (capability filter) | local read | `ok`, B present in `agents[]` | — |
| S2 | `mx_describe_agent(B)` | local read | `ok`, exposes `@@ALLOW_TOOL@@` schema | — |
| S3 | `mx_delegate_tool(@@ALLOW_TOOL@@, args)` | `[[allow]]` `requires_approval=false` | `ok` + populated `audit_ref` | — (AC1) |
| S4 | `mx_delegate_tool(@@APPROVAL_TOOL@@)` | `[[allow]]` `requires_approval=true` | `awaiting_approval` → **approve** → `ok` | approve |
| S5 | `mx_delegate_tool(@@APPROVAL_TOOL@@)` (new idem key) | same, denied this time | `awaiting_approval` → **deny** → `denied('approval_denied')` | deny |
| S6 | `mx_run_command(@@ALLOW_COMMAND@@, safeArgs)` | `[exec]` `requires_approval=true` | `awaiting_approval` → **approve** → `ok` (`exit_code`) | approve (AC2) |
| S7 | `mx_run_command(@@ALLOW_COMMAND@@, dangerousArgs)` | `deny_args_regex` match | `policy_denied` (no approval requested) | — (AC2 denial) |
| S8 | `mx_delegate_tool(@@DENY_TOOL@@)` | deny-by-default | `policy_denied` | — |

The deferred steps (S4–S6) use the binding's natural resolution: the **Claude shim** hides the poll loop for `running` and, with `awaitApproval: true`, can block through `awaiting_approval`; the default disposition surfaces `awaiting_approval` and the harness resolves it via a second `mx_await_result` call after the operator decides (Scenario F in `shim.integration.test.ts` is the model). The **MCP arm** always surfaces `awaiting_approval` and the harness resolves via a `tools/call mx_await_result(handle)` after the operator decision. This keeps the operator decision strictly between the hold and the resolve, so the test is deterministic — no guessing bot.

### The operator-approval driver (out-of-band)

`scripts/conformance/decide-approval.sh <approve|deny> [--match <substr>]` runs **as the operator on daemon B** (using B's isolated `XDG_RUNTIME_DIR`/`XDG_DATA_HOME`, exactly as `bootstrap-daemon-b.sh` does for `trust approve`). It:

1. Lists pending approvals on B (`mx-agent approval list --json`, or the verified v0.2.1 equivalent — pin at AC time).
2. Selects the single pending request (optionally filtered by an arg/summary marker so approve-vs-deny targets the right request).
3. Issues `mx-agent approval approve <request_id>` or `mx-agent approval deny <request_id>` (the verified CLI/RPC for `approval.decide`).

The golden harness shells out to this script (`child_process.execFile`) at the exact moment a step is held. **Critically, this path uses the `mx-agent` CLI / a raw operator client — never `@mx-loom/*` model-facing surface.** `approval.decide`, `trust.*`, `policy.*` are operator authority and are structurally absent from the model tool set; the test simulates the human, it does not grant the model the power to approve. (Mirrors how `bootstrap-daemon-b.sh` performs trust approval out-of-band.)

A small TS wrapper in `_golden-harness.ts` (`approvePending()` / `denyPending()`) provides the timing seam and asserts the script exited 0; the actual decision stays in the shell/CLI lane.

### Binding adapters

**MCP arm (`golden.mcp.e2e.test.ts`).** Mirror `mcp.conformance.test.ts`'s `createLiveMcpFixture`: open a real `MxClient`/`MxSession` against daemon A's socket, `createBindingContext({ session, auditSink: inMemorySink })`, `createMcpServer(ctx)`, connect via `InMemoryTransport` to an MCP `Client`. Each step is a `client.callTool({ name, arguments })`; assert `isError` semantics (`denied`/`awaiting_approval` are **not** `isError`), parse `structuredContent` as the T102 envelope, `validateEnvelope`, and assert `SECRET_PATTERN` absent. Resolve deferred steps with `mx_await_result(handle)` after the operator decision.

**Claude arm (`golden.claude.e2e.test.ts`).** Mirror `shim.integration.test.ts`'s composition but against the **live** daemon: `createBindingContext({ session, auditSink })` → `createMxToolServer(ctx, opts)` → MCP `Client` over `InMemoryTransport`; build `createMxCanUseTool({ onApprovalRequest })` to model the SDK's HITL gate. The scripted cognition: for each step, call `canUseTool(mxToolName(verb), input, opts)` first (assert the secret-free `ApprovalSummary`: verb/target/arg-key-names only, never values; `risk: 'high'` for `mx_run_command`); on `allow`, route to the tool server; on the deny test, assert zero daemon calls. Use the hidden poll loop for `running` and `awaitApproval`/`mx_await_result` for the held steps.

**Opt-in real-model arm.** Behind `MXL_GOLDEN_LIVE_MODEL=1` + `ANTHROPIC_API_KEY`, an additional `describe.skipIf(...)` block composes the shim into a genuine `@anthropic-ai/claude-agent-sdk` `query()` (model: `claude-opus-4-8` or a cheaper `claude-haiku-4-5` for cost) with `mcpServers: { mx: createMxToolServer(...).config }` and `canUseTool`, prompting the agent to "run the tests on backend-dev-01 then run the deploy command". Assertions are loosened to "the expected tool calls occurred and produced conforming envelopes / audit rows", since a model's exact phrasing/order is non-deterministic. This arm proves the faithful integration but is **never** the gate.

### Audit assertion (`golden.audit.e2e.test.ts` + inline per-arm checks)

Each arm injects a fresh `InMemoryAuditSink` and a session-stable `correlation_id` into its `BindingContext`. After the scenario, assert:

- `sink.byCorrelation(correlationId)` returns one row per **emission** (the held steps S4–S6 produce two rows each: `awaiting_approval` then the terminal `ok`/`denied`), matching the `binding-e2e.test.ts` counting model.
- The awaiting-approval row carries `approval_request_id` and the `idempotency_key`; the terminal `denied` row carries `error_code: 'approval_denied'` and a null `approval_request_id` (the AC2 approval-leg join).
- `sink.byInvocation(invId)` recovers each lifecycle chain.
- No row contains a secret (serialise the sink, assert `SECRET_PATTERN` absent; the row schema already excludes `result`/`error.message`/`approval.summary`).

Behind `MXL_AUDIT_PG=1` (+ DSN env), swap the sink for `createPostgresAuditSink(config)`, `await sink.migrate()` (idempotent `migrations/0001_mx_audit_log.sql`), run the scenario, then **query** the live table (a thin `SELECT … WHERE correlation_id = $1`) to prove rows landed and dedup held (re-running a step with the same `(call_id, status, invocation_id)` is a no-op via `ON CONFLICT (dedup_key) DO NOTHING`). Skips cleanly with no DB.

### Bring-up completion (`bootstrap-daemon-b.sh`)

Finish the golden branch (the `if [ "$POLICY_FIXTURE" = "policy.golden.toml" ]` block):

1. Register `@@APPROVAL_TOOL@@` as a **published** tool on B (`mx-agent agent register … --tool "$APPROVAL_TOOL"`, alongside the existing `$TOOL`/`$DENIED_TOOL`).
2. Enable guarded exec on B per the `[exec]` block (the policy already allowlists `@@ALLOW_COMMAND@@`; confirm the daemon-side enable step at AC time).
3. `emit_output approval_tool`, `emit_output allowed_command`, `emit_output allow_cwd` and export `MXL_CONFORMANCE_APPROVAL_TOOL` / `MXL_CONFORMANCE_ALLOWED_COMMAND` / `MXL_CONFORMANCE_ALLOW_CWD` (it already emits `golden_policy` + `approval_gated_tool`).

This is the one-time change that turns the staged `await-result.conformance.test.ts` AC2, `policy-golden.conformance.test.ts` AC2, and `mcp.conformance.test.ts` AC3 green too.

### CI

Add a `golden` job to `.github/workflows/conformance.yml` (or a sibling `golden.yml`), `workflow_dispatch`-gated like `delegate`: bring up A, bring up B with `POLICY_FIXTURE=policy.golden.toml`, export the golden coordinates from the bootstrap outputs, then `pnpm --filter @mx-loom/golden test:e2e` with `MXL_CONFORMANCE_TWO_DAEMON=1 MXL_CONFORMANCE_GOLDEN_POLICY=1`. Optionally a matrix dimension adds `MXL_AUDIT_PG=1` with a `postgres` service container. Teardown via `down.sh` `if: always()`.

## Affected Files / Packages / Modules

**New:**
- `packages/golden/` — `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `README.md`.
- `packages/golden/test/_golden-harness.ts` — env gating, fixture coordinates, live-fixture builders for both arms, operator-driver wrapper.
- `packages/golden/test/scenario.ts` — the binding-agnostic step list + expected outcomes.
- `packages/golden/test/golden.mcp.e2e.test.ts` — MCP binding arm.
- `packages/golden/test/golden.claude.e2e.test.ts` — Claude shim arm (+ opt-in real-model block).
- `packages/golden/test/golden.audit.e2e.test.ts` — AC4 audit assertions (InMemory + Postgres).
- `scripts/conformance/decide-approval.sh` — out-of-band operator decision driver.

**Modify:**
- `scripts/conformance/bootstrap-daemon-b.sh` — complete the golden bring-up (approval-tool registration, exec-enable, coordinate exports).
- `scripts/conformance/README.md` — document `decide-approval.sh`, the new exported coordinates, and the golden e2e run command.
- `.github/workflows/conformance.yml` — add the `golden` job (+ optional Postgres service for the audit arm).
- `docs/backlog.md` — tick T114 ACs; flip the "staged behind `MXL_CONFORMANCE_TWO_DAEMON=1`" notes for T112/T113 to "asserted live by T114"; update the Status line / M1-exit marker.
- `docs/mx-agent-tool-fabric-design.md` — Status table line 7 + §8 golden-test bullet: mark the golden arm live (both bindings).
- `pnpm-workspace.yaml` / root config — only if the workspace glob does not already match `packages/*` (it does; confirm `packages/golden` is picked up).

**Read (no change), to keep adapters faithful:**
- `packages/mcp/test/conformance/_mcp-harness.ts`, `packages/mcp/src/{server,context,dispatch,serialize}.ts`.
- `packages/claude/test/shim.integration.test.ts`, `packages/claude/src/{tool-server,can-use-tool,resolve,names}.ts`.
- `packages/audit/test/binding-e2e.test.ts`, `packages/audit/src/{with-audit,sink,postgres,project}.ts`, `migrations/0001_mx_audit_log.sql`.
- `packages/toolbelt/test/conformance/_harness.ts`, `packages/toolbelt/src/{client,session}.ts`.
- `docs/mx-agent-surface-v0.2.1.md` — the verified daemon surface (for `approval.*` method/param names).

## API / Interface Changes

**No public API, descriptor, result-envelope, or daemon-RPC surface changes.** T114 is a consumer of existing surfaces.

New **non-public** surfaces (test/operator scaffolding only):
- `scripts/conformance/decide-approval.sh <approve|deny> [--match <substr>]` — operator CLI driver, not part of any package.
- `bootstrap-daemon-b.sh` gains three additional `emit_output` keys (`approval_tool`, `allowed_command`, `allow_cwd`) and exports three additional `MXL_CONFORMANCE_*` env coordinates — a bring-up contract change, documented in `scripts/conformance/README.md`, consumed only by tests/CI.
- A new private `@mx-loom/golden` package with a `test:e2e` script; nothing is exported for downstream consumption.

The opt-in real-model arm uses `@anthropic-ai/claude-agent-sdk` as a **devDependency/peer** of `packages/golden` only (it is already a peer of `@mx-loom/claude`); it adds no runtime dependency to any shipped package.

## Data Model / Protocol Changes

**None to the contract.** T114 asserts the existing shapes against a live daemon and may *pin* (not change) values currently authored-against-design:

- The `approval.*` method/param vocabulary used by `decide-approval.sh` (`approval.list` / `approval.decide` or their CLI equivalents) — recorded in `docs/mx-agent-surface-v0.2.1.md` once verified.
- The held-invocation `approval` fields (`request_id`, `risk`, `summary`, `expires_at`) and the `awaiting_approval` ↔ terminal state vocabulary the resolver keys on (T103 OQ#3) — the golden flow is the first to exercise the full hold→decide→release cycle live.
- The audit-row data model is unchanged: `mx_audit_log` per `AuditRow` with the `dedup_key` unique index. The golden flow is the first to write rows produced by a **live binding round-trip** (vs synthesised envelopes), proving the projection's field-availability assumptions (`invocation_id`/`request_id`/`room`/`event_id`) against real daemon output.

If the live round-trip contradicts an authored-against-design assumption, the **fix** is a one-line change in the owning module (localised consts already exist: `INVOCATION_GET_METHOD`, `INVOCATION_STATE_KIND`, the `exec.start` param const, the policy grammar) — T114 surfaces it red; it does not silently adapt.

## Security & Compliance Considerations

- **Secret boundary (Boundary A) is the headline assertion, not an afterthought.** Matrix tokens, the Ed25519 **private** signing key, provider keys, and `GH_TOKEN` live only in each daemon's on-disk state (mode 0600) and its Matrix session — they never enter the test process, the bindings, the model context, or CI logs. Every golden step asserts `JSON.stringify(result)` (and the serialised audit sink) does not match `SECRET_PATTERN`. The bindings ride `MxClient`/`MxSession`, so the deny-by-default env allowlist + `assertNoCredentialShapedArgs` (outbound) + `redactSecrets` (inbound) stay in force unmodified.
- **Out-of-process enforcement, demonstrated.** Trust (mutual Ed25519 via `mx-agent trust approve` in the bring-up), deny-by-default `policy.golden.toml`, the sandbox + `network = "deny"`, and the human approval gate all execute on the **receiving** daemon B. The golden flow proves a compromised/hallucinating cognition can only emit a signed *request*: S7/S8 (`policy_denied`) and S4–S6 (held for approval) all resolve on B regardless of what the model "wants".
- **Cognition never grants itself authority.** The model tool set is exactly the nine `mx_*` verbs; `trust.*`, `approval.decide`, `policy.*`, `auth.*`, `device.*`, `daemon.*` are structurally absent (re-asserted by listing tools and checking the forbidden-verb set is ∅, as `mcp.conformance.test.ts` does). The operator decision is issued by a **separate** CLI/operator client against daemon B, never through any `@mx-loom/*` path. Approval reaches the model only as the `awaiting_approval` envelope status, and is **re-validated against live policy at release** (design §5) — the golden flow exercises exactly this re-authorize-at-release path.
- **Secret-free tool contract.** No golden step passes a credential-shaped arg; a defensive sub-case (mirroring `shim.integration.test.ts`) confirms a credential-shaped arg key/value is rejected (`invalid_args`) or stripped from the HITL `ApprovalSummary` — never dispatched, never logged.
- **Audit correlation without secrets.** Every asserted row carries `audit_ref` correlation ids + `tool_name`/`correlation_id`/`idempotency_key` + `approval_request_id`, and the row schema **excludes** `result`, `error.message`, and `approval.summary` by construction. The live-Postgres arm never logs the DSN.
- **Logging/redaction.** `down.sh` scrubs daemon logs before any CI upload; the operator driver must not echo tokens; test `console.info` diagnostics (as in the existing conformance suites) print envelopes/statuses only, which are already secret-free.

## Testing Plan

T114 *is* the test, so this section is the suite design itself:

- **End-to-end (the gate), per binding arm** — S1–S8 above, run via `@mx-loom/mcp` and via `@mx-loom/claude`, against the live golden two-daemon fixture, deterministic scripted cognition. Each step: correct terminal status, envelope validates (`validateEnvelope`), `isError` semantics correct for the binding, `SECRET_PATTERN` absent.
- **Approval lifecycle** — S4/S6 hold → operator approve → `ok`; S5 hold → operator deny → `denied('approval_denied')`. Assert the binding never executed the guarded command before approval (e.g. via a side-effect marker file the allowlisted command would create, checked only after release).
- **Denial taxonomy** — S7 (`deny_args_regex`) and S8 (deny-by-default) → `denied('policy_denied')`, `isError: false` (governance, not fault); no approval ever requested for S7.
- **Audit (AC4)** — `InMemoryAuditSink` row count/correlation/approval-join per arm (the `binding-e2e.test.ts` assertions, but over **live** envelopes); behind `MXL_AUDIT_PG=1`, a live `PostgresAuditSink` write + `SELECT` + dedup-on-retry no-op.
- **Secret-boundary/redaction** — full-envelope and full-sink `SECRET_PATTERN` checks; credential-shaped-arg rejection sub-case; no-authority-verb structural check on both bindings' tool lists.
- **Result-envelope/error-taxonomy** — every terminal envelope is one of the closed statuses with a closed `error.code`; the held→released path re-validates against the live envelope schema.
- **Idempotency** — re-issue S3 with the same `idempotency_key` and assert no double-execution (daemon dedupes) and a single net audit lifecycle.
- **Gating/skip semantics (unit-level, daemon-free)** — pure tests for the harness's skip/fail-not-skip decision (mirroring `conformance-harness.test.ts`) so the gate logic itself is verified without a daemon; and a smoke test proving the golden suite **skips cleanly** with no fixture present (so it never blocks PRs).
- **Opt-in real-model arm** (`MXL_GOLDEN_LIVE_MODEL=1`) — loosened assertions: the expected verbs were called and produced conforming envelopes + audit rows; not asserted in CI by default.
- **Documentation test** — `scripts/conformance/README.md` golden-run command stays accurate (manual / reviewer check).

## Documentation Updates

- **`docs/backlog.md`** — tick T114's four ACs once green; update the M1 Status header and the M1-exit marker; flip T112 ("drives both the allowed and approval-gated branches") and T113 ("every tool result produces exactly one audit row" / "rows correlate …") from staged to live-asserted, cross-referencing T114; note T109 AC3 / T110 ACs now have a live model-in-the-loop arm.
- **`docs/mx-agent-tool-fabric-design.md`** — Status table (line 7) and §8 golden-test bullet: mark the live, approval-gated, both-bindings golden arm as landed (was "staged behind `MXL_CONFORMANCE_TWO_DAEMON=1`"). §5 approval flow: note it is now exercised end-to-end (hold → out-of-band decide → re-authorize at release).
- **`scripts/conformance/README.md`** — document `decide-approval.sh`, the new `MXL_CONFORMANCE_APPROVAL_TOOL` / `MXL_CONFORMANCE_ALLOWED_COMMAND` / `MXL_CONFORMANCE_ALLOW_CWD` exports, the golden e2e run command, and the operator-decision timing.
- **`docs/mx-agent-surface-v0.2.1.md`** — record the verified `approval.list` / `approval.decide` method/param vocabulary and the confirmed `awaiting_approval` ↔ terminal state tokens, once pinned by the live run.
- **`packages/golden/README.md`** — what the package is, how to run it (local two-daemon bring-up + flags), and that it is the M1 exit gate.

## Risks and Open Questions

1. **Home of the golden test (decision to confirm).** Recommended: a new private `packages/golden` (`@mx-loom/golden`) composing all five M1 packages — clean dependency story, single place for the cross-binding scenario. Alternatives: (a) split arms into the existing `packages/mcp/test/conformance/` and `packages/claude/test/conformance/` with a shared scenario module imported across packages (awkward cross-package test imports, already avoided by the duplicated harnesses); (b) a top-level `e2e/` workspace. **Confirm `packages/golden` before scaffolding.**
2. **The operator-approval CLI/RPC is unverified on v0.2.1.** `approval.decide` is "◻️ documented" in design §2; the exact `mx-agent approval list/approve/deny` CLI (or RPC method + param names) must be pinned at the live round-trip. `decide-approval.sh` localises these so a correction is one line. **A wrong spelling must fail the golden run red, never be worked around.**
3. **Real model vs scripted cognition (decision to confirm).** Recommendation: scripted deterministic driver is the M1-exit gate; the real-model `query()` arm is opt-in (`MXL_GOLDEN_LIVE_MODEL=1` + `ANTHROPIC_API_KEY`). The faithful reading of "a Claude-SDK agent delegates" is a real model; the CI-stability/cost/secret-handling reading argues for scripted. Confirm whether the issue's intent is satisfied by the scripted arm (the binding+daemon+approval+audit boundaries are identical; only the token-emitter differs).
4. **Approval-decision timing & determinism.** The harness decides synchronously between hold and resolve (no background guessing bot), which is deterministic but assumes the daemon surfaces the pending approval promptly after `call.start`/`exec.start` returns `awaiting_approval`. If there is a `/sync` propagation lag between daemons, the decider may need a short bounded poll for the pending request before deciding. Bound it; never sleep unboundedly.
5. **Guarded-exec enable on daemon B.** The policy allowlists the command, but whether the daemon needs a separate "exec enabled" toggle beyond the `[exec]` block is unverified (design §6 L4 says guarded exec "ships disabled"). Pin the enable step in `bootstrap-daemon-b.sh` at AC time.
6. **`policy.golden.toml` grammar is authored-against-design.** Three in-repo sources disagree on the TOML shape (`[[allow]]` vs `[exec]` vs `[[allow_commands]]`). The golden run is a forcing function: if the daemon rejects the fixture, AC1 of T112 fails red and the grammar is corrected in the fixture (T112's deliverable), not papered over.
7. **Postgres in CI (audit arm).** Requires a service container + DSN secret handling; keep it a separate matrix dimension so the core golden gate does not depend on a DB. The DSN must never be logged.
8. **`mx_await_result` resolution budget.** The held steps poll `invocation.get` up to a budget; pick a budget (e.g. 120 s, matching `await-result.conformance.test.ts` AC2) generous enough for the operator driver to act but bounded so a stuck approval fails rather than hangs CI.
9. **Provenance dependency.** The golden CI job inherits the open homeserver/pinned-binary provenance decision (`scripts/conformance/README.md` "Provenance"); until that is wired, the job is `workflow_dispatch`-only, like `live`/`delegate`.

## Implementation Checklist

1. **Confirm decisions** (Open Questions 1 & 3): `packages/golden` as the home; scripted cognition as the gate with an opt-in real-model arm. Park OQ2/5/6 for the live round-trip.
2. **Scaffold `packages/golden`** — private `package.json` (deps on the five M1 packages + `@modelcontextprotocol/sdk`; `@anthropic-ai/claude-agent-sdk` as dev/peer), `tsconfig*`, `vitest.config.ts` (long timeouts; a `test:e2e` script; excluded from the default fast `pnpm test`). Confirm the workspace glob picks it up; `pnpm -r typecheck && build` green.
3. **Write `scenario.ts`** — the ordered S1–S8 step list with expected terminal statuses/codes and per-step operator action, binding-agnostic.
4. **Write `_golden-harness.ts`** — replicate the conformance env-flag/gating model (`MXL_CONFORMANCE_TWO_DAEMON`, `MXL_CONFORMANCE_GOLDEN_POLICY`, fail-not-skip), read the fixture coordinates (incl. the new approval/command/cwd ones), build the live `MxSession` + `BindingContext` (with an injected `InMemoryAuditSink`), and expose `approvePending()`/`denyPending()` wrappers over `decide-approval.sh`. Add daemon-free unit tests for the gate decision.
5. **Write `decide-approval.sh`** — out-of-band operator decision on daemon B (B's isolated XDG dirs; `mx-agent approval list/approve/deny`); localise method/CLI names; fail loudly on no pending request or a wrong-spelling error.
6. **Extend `bootstrap-daemon-b.sh`** — in the golden branch: register `@@APPROVAL_TOOL@@` as published, enable guarded exec, and `emit_output` + export `approval_tool` / `allowed_command` / `allow_cwd`.
7. **Implement the MCP arm** (`golden.mcp.e2e.test.ts`) — live `BindingContext` → `createMcpServer` → MCP `Client` over `InMemoryTransport`; run S1–S8; resolve held steps via `mx_await_result` after the operator decision; assert envelopes, `isError` semantics, secret boundary.
8. **Implement the Claude arm** (`golden.claude.e2e.test.ts`) — `createMxToolServer` + `createMxCanUseTool` composition against the live daemon; assert the secret-free HITL summary + `risk` levels; run S1–S8 with the hidden poll loop / `awaitApproval`; add the opt-in real-model `query()` block behind `MXL_GOLDEN_LIVE_MODEL=1`.
9. **Implement the audit arm** (`golden.audit.e2e.test.ts` + inline per-arm checks) — `InMemoryAuditSink` row count/correlation/approval-join over the live scenario; behind `MXL_AUDIT_PG=1`, `PostgresAuditSink.migrate()` + scenario + `SELECT` + dedup-no-op.
10. **Add the CI `golden` job** to `.github/workflows/conformance.yml` — `workflow_dispatch`-gated; bring up A + B(golden) + coordinate exports; run `pnpm --filter @mx-loom/golden test:e2e` with the golden flags; optional Postgres matrix dimension; `down.sh` `if: always()`.
11. **Run the live golden flow** against the pinned two-daemon fixture (locally or via dispatch). Treat any daemon rejection as **red**: pin `approval.*` vocabulary, the `awaiting_approval`/terminal state tokens, the `exec.start` shape, and the `policy.toml` grammar by **fixing the owning module/fixture** (T103/T106/T112), never by loosening the assertion.
12. **Tick the ACs and update docs** — backlog (T114 + the staged T112/T113 lines + M1-exit marker), design doc Status/§8/§5, `scripts/conformance/README.md`, `docs/mx-agent-surface-v0.2.1.md`, `packages/golden/README.md`.
13. **Verify skip-clean** — confirm the golden suite skips cleanly with no fixture (no PR breakage) and fails hard under `MXL_CONFORMANCE_TWO_DAEMON=1` with no daemon (the gate invariant).
