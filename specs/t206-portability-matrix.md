# T206 · Portability Matrix — the same descriptors pass under ADK, OpenCode, and Pi (M2 exit gate)

> Issue #28 · `area/test` `type/test` `P0` · **M** · M2 · **← M2 exit**
> Depends on #24 (T202 ADK `LongRunningFunctionTool`), #25 (T203 OpenCode `mcp` entry), #27 (T205 Pi native binding) — **all landed**.

## Problem Statement

The whole bet of mx-loom is that **one canonical descriptor set** (`CANONICAL_M1_TOOLS`, the nine `mx_*` verbs in `@mx-loom/registry`) drives the **same delegation/approval behaviour across every runtime** — "same descriptors must work everywhere." M1 proved this for one runtime family (Claude SDK) through **two bindings** with the GOLDEN gate (T114): a single binding-agnostic scenario (`scenario.ts`, steps S1–S8) is authored once and run through both the `@mx-loom/mcp` server and the `@mx-loom/claude` in-process shim against a live two-daemon golden fixture, asserting the same terminal outcomes, the secret boundary, and the audit rows.

M2 added three more runtimes, each with its **own** end-to-end acceptance arm:

- **ADK** — `packages/golden/test/adk.mcp-toolset.e2e.test.ts` (T201: surfacing + ungated delegate) and `packages/golden/test/adk.long-running.e2e.test.ts` (T202: the *full* approval-gated flow — pending ticket → out-of-band approve/deny → resume, guarded-exec, `approval_denied`, deny-by-default `policy_denied`).
- **OpenCode** — `packages/golden/test/opencode.mcp-entry.e2e.test.ts` (T203: deterministic surfacing of the canonical tools for local-stdio and remote-HTTP entries, plus an opt-in model-in-loop `mx_delegate_tool`).
- **Pi** — `packages/golden/test/t205-pi-binding.e2e.test.ts` (T205: native `ToolDefinition.execute()` → live daemon for `mx_delegate_tool` / `mx_find_agents` / `mx_await_result` / credential-arg rejection).

The gap T206 closes is that **there is no single, runtime-agnostic assertion that the same scenario passes across all three runtimes**. Each arm asserts its own bespoke shape (an ADK Python probe, an OpenCode HTTP probe, a Pi `AgentToolResult`); none drives the shared `scenario.ts` step table cross-runtime, and there is no **matrix artifact** (runtime × step → terminal) that constitutes the M2 exit. Concretely:

1. **Pi has no full-scenario golden arm.** T205 exercises three verbs and a credential rejection — it never runs the approval gate (S4/S5/S6), the `deny_args_regex` denial (S7), or deny-by-default (S8). Pi is the one runtime whose binding is *in-process and model-free* (it dispatches `ToolDefinition.execute()` directly, exactly like the golden MCP/Claude arms dispatch `tools/call`), so it *can* drive the full binding-agnostic S1–S8 — but the arm to do so does not exist yet.
2. **No cross-runtime invariant is asserted.** Nothing checks that all three runtimes surface *exactly* the same nine descriptors (identity, not just presence) and produce *the same* terminal status/error-code for the in-scope steps.
3. **No M2-exit CI job** runs the matrix, and no aggregated matrix table appears in docs.

T206 builds the **portability matrix**: a shared, runtime-parametrised gate that runs the agreed (subset) golden scenario under ADK, OpenCode, and Pi from the **same** descriptor set and asserts a single cross-runtime invariant — the M2 exit.

## Goals

- **G1 — A Pi golden arm over the shared scenario.** Add a `GoldenArm` implementation (`createGoldenPiArm`) that dispatches via `@mx-loom/pi` `ToolDefinition.execute()` and resolves deferred handles via the `mx_await_result` tool definition, so the existing `runStep` / `buildGoldenScenario` driver pumps the **full S1–S8** through Pi natively (model-free), with the same out-of-band operator (`scripts/conformance/decide-approval.sh`) the MCP/Claude arms use.
- **G2 — A single portability-matrix gate.** Add `packages/golden/test/portability-matrix.e2e.test.ts` that runs each runtime's **declared in-scope** subset of S1–S8, collects a `runtime × step → {expected, actual, pass}` matrix, asserts every in-scope cell matches the binding-agnostic expectation from `scenario.ts`, and emits a legible matrix table (the M2-exit artifact).
- **G3 — A cross-runtime descriptor-identity invariant.** Assert (always-on, model-free for every runtime) that each runtime surfaces **exactly** the nine `CANONICAL_M1_TOOLS` `mx_*` names — no extra tool, no missing tool, no authority verb (`trust.*` / `approval.decide` / `policy.*` / `auth.*` / `device.*` / `daemon.*` structurally absent).
- **G4 — Honest, documented per-runtime scope.** Encode a **capability matrix** declaring which step ids each runtime expresses model-free vs. model-gated vs. out-of-scope, with the reason, so a subset is **documented, never a silent skip**.
- **G5 — Skip-clean / fail-not-skip gating.** With no fixture (laptop / fast CI) the matrix skips cleanly; when demanded (`MXL_PORTABILITY_MATRIX=1` + golden fixture + the per-runtime opt-ins) a missing/unreachable runtime or daemon is a **hard failure**, never a misleading green — mirroring `GOLDEN_REQUIRED` / `assertGoldenPrereqs`.
- **G6 — Daemon-free unit coverage of the matrix logic.** Add `packages/golden/test/portability-matrix.test.ts` (a fast `*.test.ts`, not `*.e2e.test.ts`) locking the capability-matrix shape, the in-scope step selection, the pass/fail reduction, and the gating decision — so the wiring is verifiable on a laptop without a daemon.
- **G7 — CI + docs.** Add a `portability` job to `.github/workflows/conformance.yml` (opt-in like `golden`) and update the golden `README.md` matrix table, `docs/backlog.md` (T206 → landed; check the AC), and the design doc M2 row.

## Non-Goals

- **No new model-facing tool, descriptor, envelope, or daemon-RPC surface.** T206 is a *consumer/aggregator* of the canonical surfaces. It must not add a verb, change the T102 envelope, alter the error taxonomy, or touch the daemon protocol. (Same posture as T201/T202/T203/T205.)
- **No new runtime binding package.** No `@mx-loom/adk` / `@mx-loom/opencode`. ADK and OpenCode consume the generated `@mx-loom/mcp` server; Pi consumes `@mx-loom/pi`. The matrix only orchestrates and asserts.
- **No weakening of the gate to make a runtime "pass."** OpenCode has no model-free tool-call surface; its execution steps are model-gated and that scope is declared, not hidden. The matrix must not, e.g., fabricate an OpenCode S4 pass.
- **No requirement to drive every runtime through a single in-process driver.** Pi is in-process; ADK is a Python subprocess; OpenCode is an HTTP/`opencode serve` subprocess. The matrix presents a uniform *result* surface, not a uniform *transport*.
- **No real-model gate.** Any model-in-loop arm (OpenCode `MXL_OPENCODE_MODEL`, the opt-in Claude live-model arm) stays opt-in and is **never** the gate (cost/flakiness/secret-handling), exactly as today.
- **Not T207.** The per-runtime copy-pasteable integration guide is a separate issue; T206 only supplies the verified matrix it cites.
- **No change to the receiver policy / bring-up scripts.** The golden two-daemon fixture (`scripts/conformance/policy.golden.toml`, `bootstrap-daemon-{a,b}.sh`, `decide-approval.sh`) is reused verbatim; coordinates flow from the same `MXL_CONFORMANCE_*` env vars.

## Relevant Repository Context

**Stack.** TypeScript monorepo, pnpm workspace, Node ≥ 20.19, vitest, Apache-2.0. Packages under `packages/`: `toolbelt`, `registry`, `claude`, `mcp`, `pi`, `audit`, `golden`. The repo is **not** docs-only — all of these are implemented with green test suites. (The "docs-only" framing in older planning prompts is stale for this issue.)

**What already exists and is reused as-is:**

- `packages/golden/test/scenario.ts` — the binding-agnostic **S1–S8** step table: `GoldenStep` (id, tool, args, `heldForApproval`, `operator`, `approvalMatch`, `terminalStatus`, `terminalErrorCode`), `ScenarioCoords`, `buildGoldenScenario(coords, nonce)`, `expectedEmissions(steps)`. **This is the single source of truth for the scenario T206 runs cross-runtime.** No change expected (possible tiny additive helper — see below).
- `packages/golden/test/_golden-harness.ts` — the live harness: env-flag gates (`isTwoDaemonRequired`, `isGoldenPolicyActive`, `isDaemonReachable`, `resolveDaemonSocket`), `GOLDEN_REQUIRED` / `SKIP_GOLDEN`, `goldenPrereqError` / `assertGoldenPrereqs`, the `GoldenFixture` reader (`readGoldenFixture`) + `coordsFromFixture`, the out-of-band operator driver (`approvePending` / `denyPending` → `decide-approval.sh`), `SECRET_PATTERN`, `GOLDEN_RESOLVE_BUDGET_MS`, the **`GoldenArm` interface** (`name`, `dispatch`, `resolve`, `close`), `runStep(arm, step)` (the shared hold→decide→resolve runner), and the two existing arm factories `createGoldenMcpArm` / `createGoldenClaudeArm`. **T206 adds `createGoldenPiArm` here** and reuses everything else.
- `packages/golden/test/golden.mcp.e2e.test.ts` / `golden.claude.e2e.test.ts` — the per-binding drivers that loop S1–S8, assert per-step terminal == `step.terminalStatus`, the envelope validates (`validateEnvelope`), `isError ⇔ status==='error'`, the secret boundary, and the AC4 audit-row count via an `InMemoryAuditSink`. **The Pi matrix row mirrors this loop shape.**
- `packages/golden/test/adk.long-running.e2e.test.ts` — the ADK full approval-gated arm (Python driver via `examples/adk/long_running_tools.py`): pending ticket → `decide("approve"/"deny")` → `bundle.resolve_ticket(...)`, plus deny-by-default `policy_denied` with no manufactured ticket. **Its driver logic is the basis of the ADK matrix row** (extract reusable helpers; see Proposed Implementation).
- `packages/golden/test/adk.mcp-toolset.e2e.test.ts` — the ADK surfacing + ungated S3 arm. Source of the descriptor-identity assertion + the ADK spawn-command/secret-env helpers.
- `packages/golden/test/opencode.mcp-entry.e2e.test.ts` — the OpenCode arm: `mcp.status` (connected) + `tool.ids` (canonical surface) deterministically; opt-in `MXL_OPENCODE_MODEL` drives `session.prompt` → `mx_delegate_tool` (S3) → envelope. **Source of the OpenCode matrix row** (extract reusable helpers).
- `packages/golden/test/t205-pi-binding.e2e.test.ts` — the T205 Pi arm; already imports `_golden-harness.ts` and reads the same fixture coordinates. Its header explicitly states it is "the building block T206 (cross-runtime Pi portability arm) uses." **It uses real Pi TypeBox when resolvable, else an inline ABI-shaped `TypeBoxBuilders` shim** — the Pi golden arm reuses this builder-resolution pattern.
- `packages/golden/test/golden-harness.test.ts` — the daemon-free unit suite for the gate logic (skip-clean / fail-not-skip, fixture reader, scenario shape). **Template for `portability-matrix.test.ts`.**
- `packages/golden/vitest.config.ts` (fast, excludes `*.e2e.test.ts`) and `vitest.e2e.config.ts` (`include: test/**/*.e2e.test.ts`, `fileParallelism: false`, 180 s timeouts). The new `portability-matrix.e2e.test.ts` is collected by the e2e config automatically; the new `portability-matrix.test.ts` by the fast config.
- `@mx-loom/pi` exports: `createPiBindingContext` (opens a live `MxSession` — `agent.register` + heartbeat), `createPiToolDefinitions(ctx, { builders })` (→ `ToolDefinition[]`, each `execute(callId, args)` → fail-closed Ajv preflight → `dispatchCall` → single `withAudit` tap → `serializePiToolResult` → `AgentToolResult{ content, details }`), `mxToolNames` / `isMxToolName`, and the `TypeBoxBuilders` seam. No MCP SDK in Pi's dep graph.
- `@mx-loom/registry` exports used by the matrix: `CANONICAL_M1_TOOLS`, `isForbiddenAuthorityVerb`, `validateEnvelope`, and the `ToolResult` / `ToolStatus` / `ErrorCode` types.
- `.github/workflows/conformance.yml` — the `golden` job (opt-in `run_golden`) brings up daemon A+B with `policy.golden.toml` and exports every `MXL_CONFORMANCE_*` coordinate from the bootstrap step outputs. The new `portability` job clones this shape.
- `packages/mcp/test/t204-pi-decision-docs.test.ts` — a **drift guard** that asserts the backlog T206 block still contains `The **Pi arm uses native registration**` and `not an MCP mount`. Any backlog edit must preserve those two phrases.

**What does not exist yet (new in T206):**

- `packages/golden/test/portability-matrix.e2e.test.ts` — the matrix gate.
- `packages/golden/test/portability-matrix.test.ts` — the daemon-free matrix-logic unit suite.
- `createGoldenPiArm` in `_golden-harness.ts` — the Pi `GoldenArm` factory.
- `packages/golden/test/_portability-matrix.ts` — a (non-test) module holding the **capability matrix** (runtime → in-scope step ids + reason), the demand-flag gate, and the pure pass/fail reduction (unit-testable, daemon-free).
- Optional reusable runtime-driver helpers extracted from the ADK/OpenCode arms (`test/_adk-runtime.ts`, `test/_opencode-runtime.ts`) so the matrix composes them without re-pasting ~500 lines each.
- The `portability` CI job and the doc/matrix updates.

## Proposed Implementation

The strategy is **reuse-first**: the scenario, the operator, the fixture, the secret-boundary vocabulary, and the per-runtime drivers already exist. T206 adds (a) the missing Pi golden arm, (b) a capability-matrix module, (c) one aggregating e2e gate, (d) one daemon-free unit suite, and (e) CI + docs.

### 1. The Pi golden arm (`createGoldenPiArm` in `_golden-harness.ts`)

Mirror `createGoldenMcpArm` / `createGoldenClaudeArm`, but back the `GoldenArm` with `@mx-loom/pi`:

```ts
export interface LivePiArm extends LiveArm {
  /** The generated Pi ToolDefinition[] — used for descriptor-identity assertions. */
  readonly tools: readonly ToolDefinition[];
}

export async function createGoldenPiArm(opts: {
  room: string;
  auditSink: AuditSink;
  correlationId: string;
  builders?: TypeBoxBuilders;       // real Pi TypeBox when resolvable, else inline shim
}): Promise<LivePiArm> {
  const ctx = await createPiBindingContext({
    sessionOptions: { room: opts.room, kind: 'pi', correlationId: opts.correlationId },
    auditSink: opts.auditSink,
  });
  const tools = createPiToolDefinitions(ctx, { builders: opts.builders ?? INLINE_FAKE_BUILDERS });
  const byName = new Map(tools.map((t) => [t.name, t]));

  const dispatch = async (tool: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const def = byName.get(tool);
    if (!def) throw new Error(`golden Pi arm: tool ${tool} not generated`);
    const out = await def.execute(`golden-${tool}`, args);
    return out.details as ToolResult;          // the full T102 envelope is carried in details
  };
  const resolve = (handle: string, waitMs: number) =>
    dispatch('mx_await_result', { handle, wait_ms: waitMs });

  const arm: GoldenArm = { name: 'pi', dispatch, resolve, close: () => ctx.close() };
  return { arm, mxClient: /* the session's client */, ctx: /* binding ctx */, tools };
}
```

Notes:
- **Builder resolution** reuses the T205 pattern (`resolvePiPackageRoot` → real `typebox` + `@earendil-works/pi-ai` `StringEnum`; else `INLINE_FAKE_BUILDERS`). Factor that resolution into a shared helper (`resolvePiBuilders()`), imported by both `t205-pi-binding.e2e.test.ts` and the matrix, to avoid duplication. The daemon round-trip is identical regardless of which builders are used; preferring real Pi builders additionally exercises the Google-safe `StringEnum` shape.
- The room **always** comes from the session (`createPiBindingContext`'s `sessionOptions.room`), **never** a model arg — `buildGoldenScenario` never puts a room in `step.args`, matching the harness invariant.
- The Pi arm consumes the same `auditSink`, so the AC4 emission count (`expectedEmissions(steps)`) is assertable for the Pi row exactly as for MCP.
- Deferred steps resolve via the `mx_await_result` `ToolDefinition` — Pi keeps deferred results **model-driven** (no hidden poll loop), so `runStep`'s hold→decide→resolve sequence works unchanged.

### 2. The capability matrix (`_portability-matrix.ts`, non-test, pure)

A small, daemon-free module that encodes scope and reduces results:

```ts
export type RuntimeName = 'pi' | 'adk' | 'opencode';
export type StepScope = 'in-scope' | 'model-gated' | 'out-of-scope';

export interface RuntimeCapability {
  readonly runtime: RuntimeName;
  /** S1–S8 → scope under THIS runtime, model-free. */
  readonly stepScope: Readonly<Record<string, StepScope>>;
  /** Human reason a step is model-gated / out-of-scope (for the legible matrix + no-silent-skip). */
  readonly notes: Readonly<Record<string, string>>;
  /** Which env opt-in selects this runtime row, e.g. MXL_PI_BINDING_E2E. */
  readonly optInEnv: string;
}

export const CAPABILITY_MATRIX: readonly RuntimeCapability[] = [/* pi: S1–S8 in-scope; adk: S1–S8 in-scope; opencode: S3 model-gated, S1/S2/S4–S8 out-of-scope model-free, identity always-on */];

/** Pure reduction: given per-(runtime,step) outcomes, is the demanded matrix green? */
export function reduceMatrix(rows: MatrixRow[]): MatrixVerdict { /* every in-scope cell pass */ }

/** Demand gate — mirrors GOLDEN_REQUIRED. */
export function isPortabilityMatrixRequired(env = process.env): boolean {
  return env['MXL_PORTABILITY_MATRIX'] === '1';
}
```

The **canonical scope** (model-free, the always-on matrix):

| Step | Pi (native) | ADK (long-running shim) | OpenCode (MCP) |
|---|---|---|---|
| Descriptor identity (9 `mx_*`, no authority) | ✓ | ✓ | ✓ (model-free) |
| S1 `mx_find_agents` → `ok` | ✓ | ✓ | model-gated¹ |
| S2 `mx_describe_agent` → `ok` | ✓ | ✓ | model-gated¹ |
| S3 `mx_delegate_tool` ungated → `ok` + `audit_ref` | ✓ | ✓ | ✓ when `MXL_OPENCODE_MODEL`² |
| S4 delegate → approve → `ok` | ✓ | ✓ | out-of-scope¹ |
| S5 delegate → deny → `denied(approval_denied)` | ✓ | ✓ | out-of-scope¹ |
| S6 `mx_run_command` → approve → `ok(exit_code)` | ✓ | ✓ | out-of-scope¹ |
| S7 `mx_run_command` → `deny_args_regex` → `policy_denied` | ✓ | ✓ | out-of-scope¹ |
| S8 delegate deny-by-default → `policy_denied` | ✓ | ✓ | out-of-scope¹ |

¹ OpenCode exposes **no model-free tool-call surface** — every execution step needs a model in the loop, so model-free OpenCode contributes the **descriptor-identity + surfacing** invariant only (this is exactly the T203 posture). ² With `MXL_OPENCODE_MODEL`, OpenCode drives S3 deterministically enough to assert the envelope; the held approval steps (S4–S6) are a documented **stretch** (model-driven timing across an out-of-band approval is brittle) and are **not** part of the gate.

This keeps the matrix faithful to the issue's "(subset) golden test" wording: **Pi and ADK express the full S1–S8; OpenCode expresses the descriptor-identity invariant always and S3 under a model.**

### 3. The matrix gate (`portability-matrix.e2e.test.ts`)

- `describe.skipIf(SKIP)` where `SKIP = !isPortabilityMatrixRequired()` for the *demanded* matrix; the file additionally runs whichever per-runtime opt-ins are present so it is usable to run a single runtime row locally.
- `beforeAll`: `assertPortabilityPrereqs()` — when `MXL_PORTABILITY_MATRIX=1`, require the golden two-daemon fixture (`MXL_CONFORMANCE_TWO_DAEMON=1` + `MXL_CONFORMANCE_GOLDEN_POLICY=1` + reachable daemon + complete `GoldenFixture`) **and** all three per-runtime opt-ins (`MXL_PI_BINDING_E2E=1`, `MXL_ADK_LONG_RUNNING_E2E=1`, `MXL_OPENCODE_MCP_E2E=1`); any missing one is a **hard failure** (fail-not-skip). Reuse `goldenPrereqError` for the fixture half.
- Run rows (serial — `fileParallelism:false` already; the live daemon must not be overwhelmed), each with a **distinct `correlationId` + scenario `nonce`** so runtimes never collide on the daemon's idempotency-dedup store:
  - **Pi row:** `createGoldenPiArm(...)` → loop in-scope steps via `runStep(arm, step)`; assert `outcome.terminal.status === step.terminalStatus` (and `error.code` when set), `validateEnvelope`, secret-free, AC4 emission count against `expectedEmissions(piSteps)`. Assert descriptor identity from `arm.tools` (names === `CANONICAL_M1_TOOLS` names, `isForbiddenAuthorityVerb` false).
  - **ADK row:** call an extracted `runAdkScenario(fixture, correlationId)` (factored from `adk.long-running.e2e.test.ts`'s Python driver + prereqs) that returns a `Record<stepId, ToolResult>` covering S1–S8 (it already approves/denies via `decide-approval.sh`). Map probe outputs → matrix terminals. Assert descriptor identity from the ADK probe's `tool_names`.
  - **OpenCode row:** call an extracted `runOpencodeScenario(fixture, correlationId)` (factored from `opencode.mcp-entry.e2e.test.ts`) returning `{ mcpStatus, toolIds, delegate? }`. Always assert descriptor identity (`toolIds` ⊇ the nine canonical names, no authority verb, connected). When `MXL_OPENCODE_MODEL` is set, assert the S3 `delegate` envelope.
- Build the matrix `rows: MatrixRow[]` (`{ runtime, stepId, expected, actual, pass }`), `log()` a rendered table, then `reduceMatrix(rows)` and `expect(verdict.green).toBe(true)`. **Cross-runtime invariant:** also assert the descriptor name-set is **identical across all three** runtimes (one `Set` equality check), proving "same descriptors."

To keep scope bounded, the recommended extraction is **thin**: move the prereq/spawn/secret-env/probe-parse helpers out of the existing ADK/OpenCode e2e files into `_adk-runtime.ts` / `_opencode-runtime.ts`, leaving the existing per-runtime test files as thin consumers (they keep their detailed per-runtime assertions; the matrix consumes the same helpers for the aggregate invariant). If extraction proves heavy under the M estimate, an acceptable fallback is for the matrix file to import and invoke the existing driver functions directly without moving them — but extraction is preferred to avoid divergence.

### 4. The daemon-free unit suite (`portability-matrix.test.ts`)

Mirror `golden-harness.test.ts`. Daemon-free, runs in the fast config:
- The capability matrix is well-formed (every runtime maps all of S1–S8; `pi`/`adk` mark S1–S8 `in-scope`; `opencode` marks S3 `model-gated` and the rest `out-of-scope` with a non-empty `notes` reason — **no silent skip**).
- `reduceMatrix` is green iff every in-scope cell passes; a failing in-scope cell makes it red; an out-of-scope/model-gated cell never forces red.
- `isPortabilityMatrixRequired` / `assertPortabilityPrereqs` skip-clean vs fail-not-skip decisions (inject env + fixture, assert the thrown error / no-op) — reuse `goldenPrereqError` semantics.
- Descriptor-identity helper: given a name list, it equals `CANONICAL_M1_TOOLS` and contains no authority verb (drive `isForbiddenAuthorityVerb` with positive + negative cases).

### 5. CI (`conformance.yml` → `portability` job)

Clone the `golden` job: bring up daemon A+B with `POLICY_FIXTURE=policy.golden.toml`, export the `MXL_CONFORMANCE_*` coordinates, then run `pnpm --filter @mx-loom/golden test:e2e` with `MXL_PORTABILITY_MATRIX=1`, the three per-runtime opt-ins, and the toolchains installed (Python venv + `google-adk` from `examples/adk/requirements.txt`; the `opencode` binary; the Pi package root via `MXL_PI_PACKAGE_ROOT` or workspace peer). Gate it `workflow_dispatch`-only behind a new `run_portability` input (so a missing-toolchain run can never paint `main`/PRs red), and keep the always-on `structure` job's "e2e arms load + skip cleanly" step covering the new files (they skip cleanly with no fixture). Because the matrix is heavy (three runtimes), document that it may run as its own dispatch rather than always alongside `golden`.

### 6. Idempotency, ordering, determinism

- Each runtime row uses its own `nonce` (so `buildGoldenScenario` mints unique `idempotency_key`s) and its own `correlationId` (so audit rows are recoverable per-runtime via `byCorrelation`). S4 vs S5 already use distinct keys within a run.
- Rows run **serially**; the out-of-band operator decision is issued strictly between a step's hold and its resolve (the `runStep` contract), so there is no guessing-bot nondeterminism.

## Affected Files / Packages / Modules

**New:**
- `specs/t206-portability-matrix.md` (this spec).
- `packages/golden/test/portability-matrix.e2e.test.ts` — the matrix gate.
- `packages/golden/test/portability-matrix.test.ts` — daemon-free matrix-logic unit suite.
- `packages/golden/test/_portability-matrix.ts` — capability matrix, demand gate, pure reduction (non-test, unit-tested).
- `packages/golden/test/_adk-runtime.ts` — ADK scenario driver helpers extracted from `adk.long-running.e2e.test.ts` (recommended).
- `packages/golden/test/_opencode-runtime.ts` — OpenCode scenario driver helpers extracted from `opencode.mcp-entry.e2e.test.ts` (recommended).

**Modified:**
- `packages/golden/test/_golden-harness.ts` — add `createGoldenPiArm` + `LivePiArm` + `resolvePiBuilders` (or a small `_pi-builders.ts`); no change to existing exports.
- `packages/golden/test/t205-pi-binding.e2e.test.ts` — optionally consume the shared `resolvePiBuilders` (de-dup) and (optionally) the Pi arm; behaviour unchanged.
- `packages/golden/test/adk.long-running.e2e.test.ts`, `packages/golden/test/opencode.mcp-entry.e2e.test.ts` — optionally thin to consume the extracted helper modules (no behaviour change).
- `packages/golden/README.md` — add the portability-matrix section + the runtime × step table + run recipe.
- `.github/workflows/conformance.yml` — add the `portability` job + `run_portability` dispatch input.
- `docs/backlog.md` — T206 status → landed; tick/annotate the AC. **Preserve** `The **Pi arm uses native registration**` and `not an MCP mount` (drift guard).
- `docs/mx-agent-tool-fabric-design.md` — M2 roadmap row: note the portability matrix is the realised M2 exit (if/when landed).

**Read-only (referenced, not modified):** `packages/golden/test/scenario.ts` (a tiny additive `stepsByScope(...)` helper is acceptable but not required), `packages/golden/test/golden.mcp.e2e.test.ts` (pattern), `packages/registry/src/*` (`CANONICAL_M1_TOOLS`, `isForbiddenAuthorityVerb`, `validateEnvelope`), `packages/pi/src/*`, `scripts/conformance/*`, `examples/adk/*`, `examples/opencode/*`, `packages/mcp/test/t204-pi-decision-docs.test.ts` (drift guard).

## API / Interface Changes

**None to any public/runtime/model-facing surface.** No CLI flag, no tool descriptor, no result-envelope field, no daemon-RPC method changes. The only new "interfaces" are **test-internal** (not exported from any package `exports`): `createGoldenPiArm` / `LivePiArm` (in the test-only `_golden-harness.ts`), the `RuntimeCapability` / `MatrixRow` / `MatrixVerdict` types, and the env contract below.

**New env flags (test-runner only, deny-by-default semantics):**
- `MXL_PORTABILITY_MATRIX=1` — demand the full three-runtime matrix (fail-not-skip when set). Unset → clean skip.
- The matrix reuses the existing per-runtime opt-ins (`MXL_PI_BINDING_E2E`, `MXL_ADK_LONG_RUNNING_E2E`, `MXL_OPENCODE_MCP_E2E`, optional `MXL_OPENCODE_MODEL`, `MXL_PI_PACKAGE_ROOT`, `MXL_ADK_PYTHON`, `MXL_ADK_MCP_COMMAND`, `MXL_OPENCODE_BIN`, `MXL_OPENCODE_MCP_COMMAND`) and the golden fixture coordinates (`MXL_CONFORMANCE_*`) — no new fixture coordinate is introduced.

## Data Model / Protocol Changes

**None.** T206 asserts against the **existing** T102 `ToolResult` envelope (`status` ∈ `ok|running|awaiting_approval|denied|error`, `error.code` taxonomy, `audit_ref`, `handle`, `approval`) validated by `validateEnvelope`. It introduces **test-only** data shapes (`MatrixRow`, `MatrixVerdict`, `RuntimeCapability`) that never cross a wire or a package boundary. No idempotency-key, audit-row, or serialization change. The audit assertions use the existing `InMemoryAuditSink` projection and `expectedEmissions` counting model.

## Security & Compliance Considerations

T206 must preserve every Boundary-A and out-of-process-enforcement guarantee the M1/M2 arms already assert — and the matrix's job is partly to **re-prove them under every runtime**:

- **Secret boundary (Boundary A).** Matrix tokens, the Ed25519 private signing key, provider keys, and `GH_TOKEN` never cross into the runtime/model/runner children. Each runtime row spawns its child(ren) from a **deny-by-default explicit allowlist env**, never `...process.env`: Pi rides the toolbelt `MxClient`/`MxSession` env allowlist (no subprocess at all); ADK reuses `safe_mx_mcp_env()` for the `mx-loom-mcp` child; OpenCode is started from `scrubbedServerEnv` (the SDK's env-spreading `createOpencodeServer` is deliberately not used). The matrix **re-asserts** this: every runtime row seeds clearly-fake secret-shaped values with a unique sentinel and asserts **none** reach the child env, the tool list, any tool result, or any audit row.
- **Secret-free tool contract.** No tool field carries a credential inbound or outbound; credential-shaped args are rejected with `invalid_args` before dispatch. The matrix keeps (and may reuse from T205) a credential-arg rejection check on at least one runtime, and asserts every envelope/result is `SECRET_PATTERN`-clean.
- **Out-of-process enforcement on the receiving daemon.** Trust (Ed25519 store), deny-by-default `policy.golden.toml`, sandbox, and the human approval gate all execute on **daemon B** — never in any runtime/binding. The matrix proves this by exercising, under Pi and ADK, the held `awaiting_approval` (the command does **not** run until release), the operator-deny `approval_denied` leg, and the deny-by-default / `deny_args_regex` `policy_denied` legs. A `policy_denied` terminal carries **no resolvable handle and requests no approval** (asserted for the ADK row already; the Pi row asserts the same).
- **Cognition only produces a signed request; it never grants itself authority.** The model tool set in **every** runtime is exactly the nine `mx_*` verbs — `trust.*` / `approval.decide` / `policy.*` / `auth.*` / `device.*` / `daemon.*` are **structurally absent**. The descriptor-identity invariant (G3) is, in effect, a per-runtime proof of this: `isForbiddenAuthorityVerb` is false for every surfaced name in all three runtimes. Approval reaches the model only as an `awaiting_approval` **result status**, re-validated against live policy at release (re-authorize-at-release).
- **The operator is out-of-band.** Every approval/denial is issued by `scripts/conformance/decide-approval.sh` (the `mx-agent` CLI as daemon B's operator) — never by any model-facing surface. The matrix simulates the human; it never gives the model the power to approve.
- **Audit correlation.** Every result carries an `audit_ref`; the matrix correlates per-runtime emissions by a per-runtime `correlation_id` and asserts the AC4 counting model (one row per emission), never logging a secret.
- **Logging / redaction.** No secret or token is ever logged or persisted. The rendered matrix table and any `log()` output carry only step ids, statuses, error codes, and runtime names — never args containing potential secrets, never raw envelopes with un-redacted fields. Inbound redaction (`redactSecrets`) stays in force on every binding.

## Testing Plan

**Unit (daemon-free, fast config — `portability-matrix.test.ts`):**
- Capability matrix well-formed: every runtime covers all of S1–S8; `pi`/`adk` = `in-scope` for S1–S8; `opencode` = `model-gated` for S3 and `out-of-scope` for the rest, each with a non-empty `notes` reason (no silent skip).
- `reduceMatrix`: green iff all in-scope cells pass; a single failing in-scope cell → red; model-gated/out-of-scope cells never force red; empty/partial rows handled.
- Gating: `isPortabilityMatrixRequired` and `assertPortabilityPrereqs` skip-clean (no flag) vs fail-not-skip (flag set, fixture/opt-in missing) — inject env + `GoldenFixture`, assert the thrown error message names the missing piece, assert no-op otherwise. Reuse `goldenPrereqError` for the fixture half.
- Descriptor-identity helper: a name list equals `CANONICAL_M1_TOOLS` names and contains no authority verb (positive + negative `isForbiddenAuthorityVerb` cases).
- Cross-runtime identity: identical name-set across the three runtimes' declared surfaces.

**End-to-end (e2e config, demanded — `portability-matrix.e2e.test.ts`, behind `MXL_PORTABILITY_MATRIX=1` + golden fixture + per-runtime opt-ins):**
- **Pi row** (model-free, full S1–S8): each step terminal == expected; `validateEnvelope`; `isError`/status invariant via the envelope (Pi has no MCP `isError`, so assert via `details.status`); secret-free; AC4 emission count; descriptor identity from generated tools; credential-arg rejection (`invalid_args`); deferred wait_ms=0 well-formed.
- **ADK row** (model-free, full S1–S8 via the long-running shim): S3 ungated → `ok` + `audit_ref`; S4 approve → `ok`; S5 deny → `approval_denied`; S6 exec approve → `ok(exit_code)`; S7 `deny_args_regex` → `policy_denied`; S8 deny-by-default → `policy_denied` (no manufactured ticket, null handle, null approval); descriptor identity; secret-boundary (sentinel + child-env-key checks).
- **OpenCode row**: always-on — `mcp.status` connected for the configured entry, `tool.ids` ⊇ the nine canonical names with no authority verb, secret-free (scrubbed env, rendered config, tool ids). Model arm (`MXL_OPENCODE_MODEL`) — S3 `mx_delegate_tool` → valid envelope, status ∈ `{ok, running, awaiting_approval}`, `audit_ref` present.
- **Matrix aggregate**: build `rows`, render the table, `reduceMatrix(rows).green === true`; cross-runtime descriptor-identity equality across all three runtimes.

**Conformance / result-envelope / error-taxonomy:** every runtime row validates each envelope against `ENVELOPE_SCHEMA` and asserts the exact `error.code` for `denied`/`error` steps (`approval_denied`, `policy_denied`) — the matrix is itself an envelope-conformance gate replicated across runtimes.

**Idempotency:** per-runtime distinct `nonce`; optionally re-issue S3 within a runtime and assert the same `invocation_id` (daemon dedup), reusing the golden MCP arm's idempotency check shape.

**Secret-boundary / redaction:** sentinel-based key + value leak checks per runtime (`MXLPILEAK`, reuse `MXLADKLONGLEAK`, `MXLOPENCODELEAK`); `SECRET_PATTERN` backstop on every result/log/audit serialization.

**Skip-clean wiring:** the always-on `structure` CI job runs `pnpm --filter @mx-loom/golden test` (collects `portability-matrix.test.ts`) and `pnpm --filter @mx-loom/golden test:e2e` (proves `portability-matrix.e2e.test.ts` **skips cleanly** with no fixture).

**Documentation tests:** keep `packages/mcp/test/t204-pi-decision-docs.test.ts` green (the T206 backlog phrases). If any backlog assertion is added for T206 (e.g. "portability matrix"), extend that guard rather than loosening it.

## Documentation Updates

- **`packages/golden/README.md`** — add a "### T206 portability matrix" section: the runtime × step table (above), the `MXL_PORTABILITY_MATRIX=1` demand flag + the per-runtime opt-ins, a copy-pasteable run recipe (bring up the golden fixture, set the three opt-ins + toolchains, run `test:e2e`), and an explicit statement of OpenCode's model-free scope (descriptor identity always; S3 under a model; held steps a stretch). Update the existing T203 line "T206 later folds this into the full M2 portability matrix" to reference the now-landed matrix.
- **`docs/backlog.md`** — set T206's AC and add a **Status:** line summarising what landed (the Pi golden arm, the matrix gate, the daemon-free unit suite, the capability matrix, the CI job), the demand-flag gating (skip-clean/fail-not-skip), and that it is the realised **M2 exit**. **Must keep** `The **Pi arm uses native registration**` and `not an MCP mount` verbatim. Update the M2 milestone row / status banner to reflect the portability matrix as M2-complete once green.
- **`docs/mx-agent-tool-fabric-design.md`** — annotate the M2 roadmap row that the portability matrix is the exercised M2 exit gate (no behavioural claim beyond what the tests assert). Do not introduce any claim of unimplemented behaviour.
- **`.github/workflows/conformance.yml`** — header comment documenting the new `portability` job and its `run_portability` opt-in.
- **T207 hand-off note:** the per-runtime integration guide (T207) cites this matrix as its verification source — leave a pointer, but do not write T207 here.

## Risks and Open Questions

1. **OpenCode cannot run the execution steps model-free — is descriptor-identity "passing the golden scenario under OpenCode"?** Recommended stance: **yes, as the documented (subset)**. The issue scope says "(subset) golden test"; OpenCode's model-free contribution is the descriptor-identity/surfacing invariant (the same nine descriptors surface, no authority verb) plus model-gated S3. Pi and ADK carry the full approval-gated subset. **Decision to confirm:** is descriptor-identity + model-gated S3 an acceptable OpenCode row for the M2 exit, or must the gate require `MXL_OPENCODE_MODEL` + S3 to be green (making a model mandatory for the OpenCode row)? Recommendation: keep S3-under-model **opt-in**, gate on descriptor-identity always — avoids a mandatory paid model in CI.
2. **Heavy fixture: three runtimes + two daemons in one job.** Python+`google-adk`, the `opencode` binary, and a resolvable Pi package must all be present alongside the live golden fixture. Recommendation: `workflow_dispatch`-only `run_portability`, serial rows, generous timeouts (already 180 s); document that the matrix may run as its own dispatch. **Open:** should the matrix allow a **partial** demand (e.g. run only the runtimes whose opt-ins are present, and assert the matrix over those), with full three-runtime demand only under `MXL_PORTABILITY_MATRIX=1`? Recommendation: yes — full demand requires all three; otherwise assert over the enabled subset (useful for local single-runtime runs).
3. **Driver extraction vs duplication.** Extracting `_adk-runtime.ts` / `_opencode-runtime.ts` from the existing ~500-line e2e files risks churn. Recommendation: extract the thin, reusable helpers (prereqs, spawn-command, secret env, probe parsing, the scenario driver) and leave the per-runtime files as consumers; if the M estimate is at risk, fall back to importing the existing driver functions directly. **Confirm** the preferred path before refactoring.
4. **Pi TypeBox builders in CI.** The Pi arm prefers real Pi TypeBox (`MXL_PI_PACKAGE_ROOT` / workspace peer) and falls back to the inline ABI shim. The daemon round-trip is identical either way; only the Google-safe `StringEnum` shape differs. **Open:** should the M2-exit Pi row **require** real Pi builders (to assert the real schema-adapter path live), or accept the shim? Recommendation: prefer real, accept shim, and `log()` which was used (no silent degradation).
5. **ADK "S1/S2" coverage.** The long-running bundle exposes all nine verbs (read verbs are ordinary MCP tools), so the ADK row can call `mx_find_agents`/`mx_describe_agent` for S1/S2; the existing T202 driver already calls `mx_find_agents` as "other work." Confirm the extracted ADK driver returns S1/S2 terminals (small addition) so the ADK row is a true S1–S8, not S3–S8.
6. **`createGoldenPiArm` session/client handle.** The Pi binding owns its `MxSession` inside `createPiBindingContext`; `LiveArm` expects an `mxClient`. Confirm the Pi binding context exposes (or can expose) the underlying client/session for the `LiveArm.mxClient` field, or relax `LivePiArm` to omit it (the matrix only needs `tools` + the `GoldenArm`). Recommendation: omit `mxClient` from `LivePiArm` (close via `ctx.close()`); no new Pi export required.
7. **Audit emission parity across runtimes.** AC4 counting (`expectedEmissions`) is straightforward for the in-process Pi arm (shared `InMemoryAuditSink`); for ADK/OpenCode the audit tap runs inside the spawned `mx-loom-mcp` child (a different process), so the matrix asserts the **per-step terminal parity + secret boundary**, not a shared in-process row count, for those rows. Document this asymmetry so the matrix does not imply an audit-row count it cannot observe cross-process.
8. **Cross-runtime ordering / dedup.** Distinct `nonce` + `correlationId` per runtime avoids idempotency-key collisions on daemon B. Confirm the bring-up's single shared room tolerates three sequential runtime sessions joining/leaving without state bleed (the conformance fixture already supports repeated sessions; reuse `down.sh` only at job end).

## Implementation Checklist

1. **Read** `scenario.ts`, `_golden-harness.ts`, `golden.mcp.e2e.test.ts`, the three runtime arms (`adk.long-running`, `opencode.mcp-entry`, `t205-pi-binding`), and `golden-harness.test.ts` to lock the patterns. Confirm OQ 1–8 decisions (esp. OQ1 OpenCode scope, OQ3 extraction, OQ4 Pi builders) before coding.
2. **Add the Pi builder resolver** — factor `resolvePiBuilders()` (real Pi TypeBox else `INLINE_FAKE_BUILDERS`) into a shared `_pi-builders.ts`; refactor `t205-pi-binding.e2e.test.ts` to consume it (behaviour unchanged).
3. **Add `createGoldenPiArm` + `LivePiArm`** to `_golden-harness.ts`: `createPiBindingContext({ sessionOptions: { room, kind: 'pi', correlationId }, auditSink })` → `createPiToolDefinitions(ctx, { builders })`; `dispatch` via `ToolDefinition.execute()` (envelope from `details`); `resolve` via `mx_await_result`; `close` via `ctx.close()`. Keep the room session-sourced.
4. **Write `_portability-matrix.ts`** — `RuntimeName`, `StepScope`, `RuntimeCapability`, `CAPABILITY_MATRIX` (pi/adk full S1–S8; opencode S3 model-gated, rest out-of-scope, identity always), `MatrixRow`/`MatrixVerdict`, `reduceMatrix`, `isPortabilityMatrixRequired`, `assertPortabilityPrereqs` (reuse `goldenPrereqError`), and a `renderMatrixTable(rows)` (ids/statuses only — no secrets).
5. **Write `portability-matrix.test.ts`** (fast, daemon-free) covering the capability-matrix shape, `reduceMatrix`, the gating decisions, and the descriptor-identity helper. Green on a laptop with no daemon.
6. **Extract** `_adk-runtime.ts` (from `adk.long-running.e2e.test.ts`: prereqs, spawn-command, secret env, Python driver, probe→`Record<stepId, ToolResult>` incl. S1/S2) and `_opencode-runtime.ts` (from `opencode.mcp-entry.e2e.test.ts`: prereqs, scrubbed env, server start, `mcp.status`/`tool.ids`, optional model S3). Thin the original files to consume them (no behaviour change); keep their suites green.
7. **Write `portability-matrix.e2e.test.ts`**: `describe.skipIf(!isPortabilityMatrixRequired())`; `beforeAll` → `assertPortabilityPrereqs()`; run Pi (full S1–S8 via `runStep`), ADK (`runAdkScenario`), OpenCode (`runOpencodeScenario`) rows with distinct nonce/correlationId; assert per-step terminal parity, `validateEnvelope`, secret boundary, descriptor identity per runtime, cross-runtime identity equality; build + `log()` the matrix; `expect(reduceMatrix(rows).green).toBe(true)`.
8. **Run locally** against a brought-up golden fixture (per `scripts/conformance/README.md`) with the three opt-ins + `MXL_PORTABILITY_MATRIX=1`; confirm fail-not-skip when a runtime/daemon is missing and skip-clean when unset.
9. **Add the `portability` CI job** to `conformance.yml` (`workflow_dispatch` + `run_portability`), cloning the `golden` job's bring-up and exporting the `MXL_CONFORMANCE_*` coordinates + the three opt-ins + toolchains; keep the always-on `structure` job's skip-clean coverage of the new files.
10. **Docs:** golden `README.md` matrix section + recipe; `docs/backlog.md` T206 status/AC (preserving the two drift-guard phrases); design-doc M2 row; `conformance.yml` header.
11. **Verify:** `pnpm -r typecheck`; `pnpm --filter @mx-loom/golden test` (fast incl. the new unit suite); `pnpm --filter @mx-loom/golden test:e2e` (skips cleanly with no fixture); `packages/mcp/test/t204-pi-decision-docs.test.ts` still green. Confirm no new export crosses any package `exports` boundary and no secret-shaped value appears in any test output.
