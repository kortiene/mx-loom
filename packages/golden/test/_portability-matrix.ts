/**
 * The portability-matrix logic (T206 / #28) — the M2 exit gate's pure core.
 *
 * This is NOT a test file (leading underscore, no `.test.ts`). It encodes the
 * **capability matrix** (which S1–S8 step each runtime expresses model-free vs.
 * model-gated vs. out-of-scope, with a documented reason — never a silent skip),
 * the **demand gate** (`MXL_PORTABILITY_MATRIX=1`, mirroring `GOLDEN_REQUIRED`),
 * the fail-not-skip prerequisite check, the pure pass/fail **reduction**, the
 * cross-runtime **descriptor-identity** oracle, and a secret-free table renderer.
 * All of it is daemon-free and injectable, so the wiring is unit-testable on a
 * laptop (`portability-matrix.test.ts`) and the heavy e2e
 * (`portability-matrix.e2e.test.ts`) only orchestrates and asserts.
 *
 * T206 adds **no** model-facing tool, descriptor, envelope, or daemon-RPC surface
 * — it is a consumer/aggregator of the canonical surfaces. The only new "types"
 * here are test-internal (never exported from a package `exports`).
 */
import { CANONICAL_TOOLS, isForbiddenAuthorityVerb } from '@mx-loom/registry';
import type { ErrorCode, ToolStatus } from '@mx-loom/registry';

import { goldenPrereqError, type GoldenFixture } from './_golden-harness.js';

// ---------------------------------------------------------------------------
// Runtimes, scope, and the capability matrix
// ---------------------------------------------------------------------------

/** The three M2 runtimes the matrix spans. */
export type RuntimeName = 'pi' | 'adk' | 'opencode';

/** Every runtime the matrix declares, in render order. */
export const RUNTIMES: readonly RuntimeName[] = ['pi', 'adk', 'opencode'];

/** How a step is expressible under a runtime, model-free. */
export type StepScope = 'in-scope' | 'model-gated' | 'out-of-scope';

/** The binding-agnostic scenario step ids (mirrors `scenario.ts` S1–S8). */
export const SCENARIO_STEP_IDS: readonly string[] = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'];

/** One runtime's declared capability over the scenario steps + its env opt-in. */
export interface RuntimeCapability {
  readonly runtime: RuntimeName;
  /** S1–S8 → scope under THIS runtime, model-free. */
  readonly stepScope: Readonly<Record<string, StepScope>>;
  /**
   * Human reason a step is model-gated / out-of-scope (for the legible matrix +
   * the no-silent-skip invariant). Required for every non-`in-scope` step.
   */
  readonly notes: Readonly<Record<string, string>>;
  /** The env opt-in that selects this runtime row (e.g. `MXL_PI_BINDING_E2E`). */
  readonly optInEnv: string;
}

/** Build a `stepScope` where every step is `in-scope` (Pi / ADK express the full S1–S8). */
function allInScope(): Record<string, StepScope> {
  return Object.fromEntries(SCENARIO_STEP_IDS.map((id) => [id, 'in-scope'])) as Record<string, StepScope>;
}

/**
 * The canonical capability matrix (model-free, the always-on matrix).
 *
 * - **Pi** (native binding) and **ADK** (long-running shim) express the **full
 *   S1–S8** model-free — both dispatch tool calls directly (Pi via
 *   `ToolDefinition.execute()`, ADK via the `LongRunningFunctionTool` shim).
 * - **OpenCode** exposes **no model-free tool-call surface** (T203 posture), so
 *   every execution step needs a model in the loop. Its model-free contribution is
 *   the descriptor-identity / surfacing invariant only; S3 is **model-gated**
 *   (driven deterministically under `MXL_OPENCODE_MODEL`) and S1/S2/S4–S8 are
 *   out-of-scope model-free — each with a documented reason (no silent skip).
 *
 * Descriptor identity (the nine `mx_*` names, no authority verb) is asserted for
 * **all three** runtimes always-on (model-free), separately from these step cells.
 */
export const CAPABILITY_MATRIX: readonly RuntimeCapability[] = [
  {
    runtime: 'pi',
    stepScope: allInScope(),
    notes: {},
    optInEnv: 'MXL_PI_BINDING_E2E',
  },
  {
    runtime: 'adk',
    stepScope: allInScope(),
    notes: {},
    optInEnv: 'MXL_ADK_LONG_RUNNING_E2E',
  },
  {
    runtime: 'opencode',
    stepScope: {
      S1: 'out-of-scope',
      S2: 'out-of-scope',
      S3: 'model-gated',
      S4: 'out-of-scope',
      S5: 'out-of-scope',
      S6: 'out-of-scope',
      S7: 'out-of-scope',
      S8: 'out-of-scope',
    },
    notes: {
      S1: 'OpenCode has no model-free tool-call surface; discovery needs a model in the loop — covered by the descriptor-identity invariant.',
      S2: 'OpenCode has no model-free tool-call surface; discovery needs a model in the loop — covered by the descriptor-identity invariant.',
      S3: 'OpenCode runs S3 only with a model (MXL_OPENCODE_MODEL); the surfacing invariant is always-on.',
      S4: 'Model-driven timing across an out-of-band approval is brittle; the held approval steps are a documented stretch, never the gate.',
      S5: 'Model-driven timing across an out-of-band denial is brittle; the held approval steps are a documented stretch, never the gate.',
      S6: 'Model-driven timing across an out-of-band approval is brittle; the held approval steps are a documented stretch, never the gate.',
      S7: 'OpenCode has no model-free tool-call surface; the policy-denied exec leg needs a model in the loop.',
      S8: 'OpenCode has no model-free tool-call surface; the deny-by-default leg needs a model in the loop.',
    },
    optInEnv: 'MXL_OPENCODE_MCP_E2E',
  },
];

/** Look up a runtime's declared capability. */
export function capabilityFor(runtime: RuntimeName): RuntimeCapability {
  const found = CAPABILITY_MATRIX.find((c) => c.runtime === runtime);
  if (found === undefined) throw new Error(`portability matrix: no capability declared for runtime ${runtime}`);
  return found;
}

/** The env opt-in that selects a runtime's row. */
export function optInEnvFor(runtime: RuntimeName): string {
  return capabilityFor(runtime).optInEnv;
}

/** The step ids a runtime expresses model-free (`in-scope`). */
export function inScopeStepIds(runtime: RuntimeName): string[] {
  const cap = capabilityFor(runtime);
  return SCENARIO_STEP_IDS.filter((id) => cap.stepScope[id] === 'in-scope');
}

// ---------------------------------------------------------------------------
// The matrix rows + the pure reduction
// ---------------------------------------------------------------------------

/** One `runtime × step → {expected, actual, pass}` cell. */
export interface MatrixRow {
  readonly runtime: RuntimeName;
  readonly stepId: string;
  readonly scope: StepScope;
  /** The binding-agnostic expected terminal status (`scenario.ts`), or null if not evaluated. */
  readonly expected: ToolStatus | null;
  /** The expected terminal error code for `denied`/`error` steps (absent for `ok`). */
  readonly expectedErrorCode?: ErrorCode;
  /** The observed terminal status under the runtime, or null if the cell was not run. */
  readonly actual: ToolStatus | null;
  /** The observed terminal error code (null when absent). */
  readonly actualErrorCode: ErrorCode | null;
  /** Did the cell match? (Always computed; only `in-scope` cells gate the verdict.) */
  readonly pass: boolean;
}

/** Inputs for {@link evaluateCell} — keeps `MatrixRow` construction in one place. */
export interface CellInput {
  readonly runtime: RuntimeName;
  readonly stepId: string;
  readonly scope: StepScope;
  readonly expected: ToolStatus | null;
  readonly expectedErrorCode?: ErrorCode;
  readonly actual: ToolStatus | null;
  readonly actualErrorCode?: ErrorCode | null;
}

/**
 * Build a {@link MatrixRow}: a cell passes iff the observed status equals the
 * expected one AND (when an error code is expected) the observed code matches.
 */
export function evaluateCell(input: CellInput): MatrixRow {
  const actualErrorCode = input.actualErrorCode ?? null;
  const statusMatch = input.expected !== null && input.expected === input.actual;
  const codeMatch =
    input.expectedErrorCode === undefined ? true : actualErrorCode === input.expectedErrorCode;
  const row: MatrixRow = {
    runtime: input.runtime,
    stepId: input.stepId,
    scope: input.scope,
    expected: input.expected,
    actual: input.actual,
    actualErrorCode,
    pass: statusMatch && codeMatch,
  };
  return input.expectedErrorCode === undefined ? row : { ...row, expectedErrorCode: input.expectedErrorCode };
}

/** The aggregate verdict over a set of matrix rows. */
export interface MatrixVerdict {
  /** Green iff every `in-scope` cell passes (model-gated / out-of-scope never force red). */
  readonly green: boolean;
  readonly inScopeTotal: number;
  readonly inScopePassed: number;
  /** The failing `in-scope` cells (empty when green). */
  readonly failures: readonly MatrixRow[];
}

/**
 * Reduce the matrix to a single verdict: green iff every **in-scope** cell passes.
 * A model-gated or out-of-scope cell never forces red (an absent model arm is a
 * documented scope, not a failure). An empty/partial matrix is handled —
 * `green` is true iff there are no in-scope failures (the e2e gate separately
 * asserts the demanded rows actually ran, via {@link portabilityPrereqError}).
 */
export function reduceMatrix(rows: readonly MatrixRow[]): MatrixVerdict {
  const inScope = rows.filter((r) => r.scope === 'in-scope');
  const failures = inScope.filter((r) => !r.pass);
  return {
    green: failures.length === 0,
    inScopeTotal: inScope.length,
    inScopePassed: inScope.length - failures.length,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Descriptor-identity invariant (G3) — the same canonical mx_* names everywhere
// ---------------------------------------------------------------------------

/** The full canonical `mx_*` descriptor names (the single source of truth) — the
 *  9 M1 verbs + the 3 M3 task-DAG verbs (T301), as every binding now surfaces them. */
export const CANONICAL_TOOL_NAMES: readonly string[] = CANONICAL_TOOLS.map((d) => d.name);

/** The result of checking a runtime's surfaced names against the canonical identity. */
export interface IdentityCheck {
  /** Exactly the canonical names, no extra, no missing, no authority verb. */
  readonly ok: boolean;
  /** Canonical names the runtime did not surface. */
  readonly missing: readonly string[];
  /** Non-canonical names the runtime surfaced. */
  readonly extra: readonly string[];
  /** Any surfaced name that is a forbidden authority verb (`trust.*` / `approval.decide` / …). */
  readonly authorityVerbs: readonly string[];
}

/**
 * Exact descriptor-identity check for a runtime whose surface uses **bare** `mx_*`
 * names (Pi `ToolDefinition[]`, the ADK bundle's `tool_names`): the name set must
 * equal the nine `CANONICAL_TOOL_NAMES` exactly, with no authority verb.
 */
export function checkDescriptorIdentity(names: readonly string[]): IdentityCheck {
  const canonical = new Set(CANONICAL_TOOL_NAMES);
  const surfaced = new Set(names);
  const missing = CANONICAL_TOOL_NAMES.filter((n) => !surfaced.has(n));
  const extra = [...surfaced].filter((n) => !canonical.has(n));
  const authorityVerbs = [...surfaced].filter((n) => isForbiddenAuthorityVerb(n));
  return { ok: missing.length === 0 && extra.length === 0 && authorityVerbs.length === 0, missing, extra, authorityVerbs };
}

/**
 * Project a list of (possibly server-namespaced) tool ids onto the set of
 * canonical `mx_*` names they express — for OpenCode, whose MCP tool ids are
 * namespaced by server (e.g. `mx-loom_mx_delegate_tool`). A canonical name counts
 * as present iff some id contains it as a substring (the T203 matching posture).
 */
export function canonicalNamesFromIds(ids: readonly string[]): string[] {
  return CANONICAL_TOOL_NAMES.filter((name) => ids.some((id) => id.includes(name)));
}

/**
 * The cross-runtime invariant (G3): assert each runtime surfaced **exactly** the
 * same canonical name-set. Returns the runtimes whose name-set diverges from the
 * canonical nine (empty ⇒ "same descriptors everywhere").
 */
export function crossRuntimeIdentityDivergence(
  perRuntime: ReadonlyArray<{ runtime: RuntimeName; names: readonly string[] }>,
): RuntimeName[] {
  const canonical = [...CANONICAL_TOOL_NAMES].sort();
  return perRuntime
    .filter(({ names }) => {
      const sorted = [...new Set(names)].sort();
      return sorted.length !== canonical.length || sorted.some((n, i) => n !== canonical[i]);
    })
    .map(({ runtime }) => runtime);
}

// ---------------------------------------------------------------------------
// The demand gate + fail-not-skip prerequisites (mirror GOLDEN_REQUIRED)
// ---------------------------------------------------------------------------

/** `MXL_PORTABILITY_MATRIX=1` — demand the full three-runtime matrix (fail-not-skip). */
export function isPortabilityMatrixRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['MXL_PORTABILITY_MATRIX'] === '1';
}

/** Whether a runtime row is opted in via its env flag. */
export function isRuntimeOptedIn(runtime: RuntimeName, env: NodeJS.ProcessEnv = process.env): boolean {
  return env[optInEnvFor(runtime)] === '1';
}

/** The runtimes whose opt-in is present (the subset to run when not fully demanded). */
export function enabledRuntimes(env: NodeJS.ProcessEnv = process.env): RuntimeName[] {
  return RUNTIMES.filter((r) => isRuntimeOptedIn(r, env));
}

/** Inputs for {@link portabilityPrereqError} (pure → unit-testable). */
export interface PortabilityPrereqInput {
  /** Is the full matrix demanded (`MXL_PORTABILITY_MATRIX=1`)? */
  readonly required: boolean;
  /** Is daemon A reachable at the conformance socket? */
  readonly reachable: boolean;
  /** The resolved golden fixture, or null if incomplete. */
  readonly fixture: GoldenFixture | null;
  /** Per-runtime opt-in presence. */
  readonly optIns: Readonly<Record<RuntimeName, boolean>>;
}

/**
 * The fail-not-skip decision as a pure function. When the full matrix is demanded
 * (`MXL_PORTABILITY_MATRIX=1`), a missing golden fixture OR a missing per-runtime
 * opt-in is a HARD failure (never a misleading green). Otherwise `null` (the e2e
 * file still runs whichever per-runtime opt-ins are present — useful for a single
 * local row). Reuses {@link goldenPrereqError} for the fixture half.
 */
export function portabilityPrereqError(input: PortabilityPrereqInput): Error | null {
  if (!input.required) return null; // not demanded → clean skip / enabled-subset only
  const fixtureErr = goldenPrereqError({ required: true, reachable: input.reachable, fixture: input.fixture });
  if (fixtureErr) {
    return new Error(`portability matrix (T206) demanded (MXL_PORTABILITY_MATRIX=1): ${fixtureErr.message}`);
  }
  const missing = RUNTIMES.filter((r) => !input.optIns[r]);
  if (missing.length > 0) {
    const flags = missing.map((r) => `${r}=${optInEnvFor(r)}`).join(', ');
    return new Error(
      'portability matrix (T206): MXL_PORTABILITY_MATRIX=1 demands ALL THREE runtimes, but the ' +
        `per-runtime opt-ins for [${flags}] are not set to 1. The full matrix must FAIL (never silently ` +
        'skip a runtime) when demanded — set every opt-in (and install its toolchain), or unset ' +
        'MXL_PORTABILITY_MATRIX to run only the enabled subset.',
    );
  }
  return null;
}

/** Read per-runtime opt-in presence from the environment. */
export function readOptIns(env: NodeJS.ProcessEnv = process.env): Record<RuntimeName, boolean> {
  return {
    pi: isRuntimeOptedIn('pi', env),
    adk: isRuntimeOptedIn('adk', env),
    opencode: isRuntimeOptedIn('opencode', env),
  };
}

// ---------------------------------------------------------------------------
// Legible, secret-free matrix rendering (the M2-exit artifact)
// ---------------------------------------------------------------------------

/**
 * Render the matrix as a legible table. Carries ONLY runtime names, step ids,
 * scopes, statuses, and error codes — never args, raw envelopes, or any value
 * that could contain a secret (the spec's logging/redaction guarantee).
 */
export function renderMatrixTable(rows: readonly MatrixRow[]): string {
  const header = ['runtime', 'step', 'scope', 'expected', 'actual', 'pass'];
  const body = rows.map((r) => [
    r.runtime,
    r.stepId,
    r.scope,
    fmtTerminal(r.expected, r.expectedErrorCode ?? null),
    fmtTerminal(r.actual, r.actualErrorCode),
    r.scope === 'in-scope' ? (r.pass ? 'PASS' : 'FAIL') : '—',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}

function fmtTerminal(status: ToolStatus | null, code: ErrorCode | null): string {
  if (status === null) return '·';
  return code !== null ? `${status}(${code})` : status;
}
