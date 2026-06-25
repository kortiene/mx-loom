/**
 * Unit tests for the portability-matrix logic (T206 / #28).
 *
 * Daemon-free, runs in the NORMAL fast suite (a `*.test.ts`, not `*.e2e.test.ts`),
 * so the wiring is verifiable on a laptop without a daemon. It locks the four
 * things that make the matrix trustworthy: the capability-matrix shape (no silent
 * skip), the pass/fail reduction, the demand gate (skip-clean / fail-not-skip), and
 * the descriptor-identity oracle. The live three-runtime arm is exercised only by
 * `pnpm test:e2e` (`portability-matrix.e2e.test.ts`).
 */
import { CANONICAL_M1_TOOLS, MODEL_FACING_ALLOWLIST } from '@mx-loom/registry';
import { describe, expect, it } from 'vitest';

import type { GoldenFixture } from './_golden-harness.js';
import { INLINE_FAKE_BUILDERS, resolvePiPackageRoot } from './_pi-builders.js';
import {
  CANONICAL_TOOL_NAMES,
  CAPABILITY_MATRIX,
  RUNTIMES,
  SCENARIO_STEP_IDS,
  canonicalNamesFromIds,
  capabilityFor,
  checkDescriptorIdentity,
  crossRuntimeIdentityDivergence,
  enabledRuntimes,
  evaluateCell,
  inScopeStepIds,
  isPortabilityMatrixRequired,
  isRuntimeOptedIn,
  optInEnvFor,
  portabilityPrereqError,
  readOptIns,
  reduceMatrix,
  renderMatrixTable,
  type MatrixRow,
  type RuntimeName,
} from './_portability-matrix.js';
import { buildGoldenScenario } from './scenario.js';

const FULL_FIXTURE: GoldenFixture = {
  room: '!golden:localhost',
  targetAgentId: 'agent-b',
  allowTool: 'run_tests@1.0.0',
  approvalTool: 'deploy@1.0.0',
  deniedTool: 'rm_rf@1.0.0',
  allowedCommand: 'echo',
  allowCwd: '/tmp/mxl/b/data',
};

const ALL_OPT_INS: Record<RuntimeName, boolean> = { pi: true, adk: true, opencode: true };

// ---------------------------------------------------------------------------
// Capability matrix is well-formed (no silent skip)
// ---------------------------------------------------------------------------

describe('portability matrix — capability matrix shape', () => {
  it('declares exactly the three M2 runtimes', () => {
    expect(CAPABILITY_MATRIX.map((c) => c.runtime).sort()).toEqual(['adk', 'opencode', 'pi']);
    expect([...RUNTIMES].sort()).toEqual(['adk', 'opencode', 'pi']);
  });

  it('every runtime maps ALL of S1–S8 (a step can never be undeclared)', () => {
    for (const cap of CAPABILITY_MATRIX) {
      for (const id of SCENARIO_STEP_IDS) {
        expect(cap.stepScope[id], `${cap.runtime} ${id} scope`).toBeDefined();
        expect(['in-scope', 'model-gated', 'out-of-scope']).toContain(cap.stepScope[id]);
      }
    }
  });

  it('Pi and ADK express the full S1–S8 model-free (in-scope)', () => {
    for (const runtime of ['pi', 'adk'] as RuntimeName[]) {
      expect(inScopeStepIds(runtime)).toEqual([...SCENARIO_STEP_IDS]);
    }
  });

  it('OpenCode has NO in-scope model-free steps (inScopeStepIds returns empty)', () => {
    expect(inScopeStepIds('opencode')).toEqual([]);
  });

  it('OpenCode marks S3 model-gated and the rest out-of-scope — each with a non-empty reason', () => {
    const oc = capabilityFor('opencode');
    expect(oc.stepScope['S3']).toBe('model-gated');
    for (const id of SCENARIO_STEP_IDS) {
      if (id === 'S3') continue;
      expect(oc.stepScope[id], `${id} should be out-of-scope model-free`).toBe('out-of-scope');
    }
    // No silent skip: every non-in-scope step has a documented reason.
    for (const id of SCENARIO_STEP_IDS) {
      if (oc.stepScope[id] !== 'in-scope') {
        expect(oc.notes[id], `${id} must carry a reason`).toBeTruthy();
        expect((oc.notes[id] ?? '').length).toBeGreaterThan(0);
      }
    }
  });

  it('exposes each runtime opt-in env flag', () => {
    expect(optInEnvFor('pi')).toBe('MXL_PI_BINDING_E2E');
    expect(optInEnvFor('adk')).toBe('MXL_ADK_LONG_RUNNING_E2E');
    expect(optInEnvFor('opencode')).toBe('MXL_OPENCODE_MCP_E2E');
  });

  it('capabilityFor throws for an unknown runtime (contract is closed)', () => {
    expect(() => capabilityFor('unknown' as RuntimeName)).toThrow(/unknown/);
  });
});

// ---------------------------------------------------------------------------
// evaluateCell + reduceMatrix
// ---------------------------------------------------------------------------

function cell(
  runtime: RuntimeName,
  stepId: string,
  scope: MatrixRow['scope'],
  expected: MatrixRow['expected'],
  actual: MatrixRow['actual'],
  opts: { expectedErrorCode?: MatrixRow['expectedErrorCode']; actualErrorCode?: MatrixRow['actualErrorCode'] } = {},
): MatrixRow {
  return evaluateCell({
    runtime,
    stepId,
    scope,
    expected,
    actual,
    ...(opts.expectedErrorCode !== undefined ? { expectedErrorCode: opts.expectedErrorCode } : {}),
    ...(opts.actualErrorCode !== undefined ? { actualErrorCode: opts.actualErrorCode } : {}),
  });
}

describe('portability matrix — evaluateCell', () => {
  it('passes when status matches and no error code is expected', () => {
    expect(cell('pi', 'S3', 'in-scope', 'ok', 'ok').pass).toBe(true);
  });

  it('fails when status differs', () => {
    expect(cell('pi', 'S3', 'in-scope', 'ok', 'denied').pass).toBe(false);
  });

  it('requires the error code to match for denied/error steps', () => {
    expect(
      cell('pi', 'S7', 'in-scope', 'denied', 'denied', {
        expectedErrorCode: 'policy_denied',
        actualErrorCode: 'policy_denied',
      }).pass,
    ).toBe(true);
    expect(
      cell('pi', 'S5', 'in-scope', 'denied', 'denied', {
        expectedErrorCode: 'approval_denied',
        actualErrorCode: 'policy_denied',
      }).pass,
    ).toBe(false);
  });

  it('a null actual (cell not run) never passes', () => {
    expect(cell('opencode', 'S1', 'out-of-scope', 'ok', null).pass).toBe(false);
  });
});

describe('portability matrix — reduceMatrix', () => {
  it('green iff every in-scope cell passes', () => {
    const rows = [
      cell('pi', 'S1', 'in-scope', 'ok', 'ok'),
      cell('pi', 'S3', 'in-scope', 'ok', 'ok'),
      cell('adk', 'S8', 'in-scope', 'denied', 'denied', {
        expectedErrorCode: 'policy_denied',
        actualErrorCode: 'policy_denied',
      }),
    ];
    const v = reduceMatrix(rows);
    expect(v.green).toBe(true);
    expect(v.inScopeTotal).toBe(3);
    expect(v.inScopePassed).toBe(3);
    expect(v.failures).toHaveLength(0);
  });

  it('a single failing in-scope cell turns the verdict red', () => {
    const rows = [cell('pi', 'S1', 'in-scope', 'ok', 'ok'), cell('pi', 'S4', 'in-scope', 'ok', 'denied')];
    const v = reduceMatrix(rows);
    expect(v.green).toBe(false);
    expect(v.failures).toHaveLength(1);
    expect(v.failures[0]!.stepId).toBe('S4');
  });

  it('model-gated and out-of-scope cells NEVER force red (even when not run / mismatched)', () => {
    const rows = [
      cell('pi', 'S1', 'in-scope', 'ok', 'ok'),
      cell('opencode', 'S3', 'model-gated', 'ok', null), // no model arm
      cell('opencode', 'S4', 'out-of-scope', 'ok', null),
      cell('opencode', 'S8', 'out-of-scope', 'denied', 'ok'), // even a "mismatch" doesn't count
    ];
    const v = reduceMatrix(rows);
    expect(v.green).toBe(true);
    expect(v.inScopeTotal).toBe(1);
  });

  it('an empty matrix reduces without throwing (green, nothing failed)', () => {
    expect(reduceMatrix([]).green).toBe(true);
    expect(reduceMatrix([]).inScopeTotal).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Demand gate — skip-clean / fail-not-skip
// ---------------------------------------------------------------------------

describe('portability matrix — demand gate', () => {
  it('isPortabilityMatrixRequired only true for exactly "1"', () => {
    expect(isPortabilityMatrixRequired({ MXL_PORTABILITY_MATRIX: '1' })).toBe(true);
    expect(isPortabilityMatrixRequired({ MXL_PORTABILITY_MATRIX: 'true' })).toBe(false);
    expect(isPortabilityMatrixRequired({})).toBe(false);
  });

  it('isRuntimeOptedIn true only for exactly "1" on the correct flag', () => {
    expect(isRuntimeOptedIn('pi', { MXL_PI_BINDING_E2E: '1' })).toBe(true);
    expect(isRuntimeOptedIn('pi', { MXL_PI_BINDING_E2E: 'true' })).toBe(false);
    expect(isRuntimeOptedIn('pi', {})).toBe(false);
    expect(isRuntimeOptedIn('adk', { MXL_ADK_LONG_RUNNING_E2E: '1' })).toBe(true);
    expect(isRuntimeOptedIn('adk', { MXL_PI_BINDING_E2E: '1' })).toBe(false);
    expect(isRuntimeOptedIn('opencode', { MXL_OPENCODE_MCP_E2E: '1' })).toBe(true);
    expect(isRuntimeOptedIn('opencode', { MXL_ADK_LONG_RUNNING_E2E: '1' })).toBe(false);
  });

  it('enabledRuntimes reflects which per-runtime opt-ins are present', () => {
    expect(enabledRuntimes({})).toEqual([]);
    expect(enabledRuntimes({ MXL_PI_BINDING_E2E: '1' })).toEqual(['pi']);
    expect(
      enabledRuntimes({ MXL_PI_BINDING_E2E: '1', MXL_ADK_LONG_RUNNING_E2E: '1', MXL_OPENCODE_MCP_E2E: '1' }),
    ).toEqual(['pi', 'adk', 'opencode']);
  });

  it('enabledRuntimes preserves RUNTIMES render order (pi → adk → opencode)', () => {
    const env = { MXL_OPENCODE_MCP_E2E: '1', MXL_PI_BINDING_E2E: '1', MXL_ADK_LONG_RUNNING_E2E: '1' };
    expect(enabledRuntimes(env)).toEqual(['pi', 'adk', 'opencode']);
  });

  it('readOptIns reads each runtime flag', () => {
    expect(readOptIns({ MXL_ADK_LONG_RUNNING_E2E: '1' })).toEqual({ pi: false, adk: true, opencode: false });
  });
});

describe('portability matrix — portabilityPrereqError (fail-not-skip)', () => {
  it('NOT demanded → null (clean skip / enabled-subset only)', () => {
    expect(
      portabilityPrereqError({ required: false, reachable: false, fixture: null, optIns: { pi: false, adk: false, opencode: false } }),
    ).toBeNull();
  });

  it('demanded + daemon unreachable → red (reuses the golden fixture error)', () => {
    const err = portabilityPrereqError({ required: true, reachable: false, fixture: FULL_FIXTURE, optIns: ALL_OPT_INS });
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/MXL_PORTABILITY_MATRIX=1/);
    expect(err?.message).toMatch(/FAIL/);
  });

  it('demanded + fixture incomplete → red, naming the missing coordinates', () => {
    const err = portabilityPrereqError({ required: true, reachable: true, fixture: null, optIns: ALL_OPT_INS });
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/MXL_CONFORMANCE_APPROVAL_TOOL/);
  });

  it('demanded + a per-runtime opt-in missing → red, naming the missing runtime flag', () => {
    const err = portabilityPrereqError({
      required: true,
      reachable: true,
      fixture: FULL_FIXTURE,
      optIns: { pi: true, adk: false, opencode: true },
    });
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/MXL_ADK_LONG_RUNNING_E2E/);
    expect(err?.message).toMatch(/ALL THREE/);
  });

  it('demanded + fixture complete + all opt-ins present → null (the matrix runs)', () => {
    expect(
      portabilityPrereqError({ required: true, reachable: true, fixture: FULL_FIXTURE, optIns: ALL_OPT_INS }),
    ).toBeNull();
  });

  it('demanded + daemon unreachable + fixture null → red (daemon check takes priority over fixture)', () => {
    const err = portabilityPrereqError({ required: true, reachable: false, fixture: null, optIns: ALL_OPT_INS });
    expect(err).toBeInstanceOf(Error);
    // The reachability check fires before the fixture check (mirrors goldenPrereqError ordering).
    expect(err?.message).toMatch(/MXL_PORTABILITY_MATRIX=1/);
    expect(err?.message).toMatch(/FAIL/);
    // The fixture-coordinate names do NOT appear — daemon check short-circuits.
    expect(err?.message).not.toMatch(/MXL_CONFORMANCE_APPROVAL_TOOL/);
  });

  it('demanded + all three opt-ins missing → red, names ALL three flags', () => {
    const err = portabilityPrereqError({
      required: true,
      reachable: true,
      fixture: FULL_FIXTURE,
      optIns: { pi: false, adk: false, opencode: false },
    });
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/MXL_PI_BINDING_E2E/);
    expect(err?.message).toMatch(/MXL_ADK_LONG_RUNNING_E2E/);
    expect(err?.message).toMatch(/MXL_OPENCODE_MCP_E2E/);
    expect(err?.message).toMatch(/ALL THREE/);
  });
});

// ---------------------------------------------------------------------------
// Descriptor-identity oracle (G3)
// ---------------------------------------------------------------------------

describe('portability matrix — descriptor identity', () => {
  it('the canonical name-set is the nine model-facing mx_* verbs', () => {
    expect(CANONICAL_TOOL_NAMES.length).toBe(9);
    expect([...CANONICAL_TOOL_NAMES].sort()).toEqual([...MODEL_FACING_ALLOWLIST].sort());
    expect([...CANONICAL_TOOL_NAMES].sort()).toEqual(CANONICAL_M1_TOOLS.map((d) => d.name).sort());
  });

  it('exact identity passes for the canonical set, no authority verb', () => {
    const check = checkDescriptorIdentity([...CANONICAL_TOOL_NAMES]);
    expect(check.ok).toBe(true);
    expect(check.missing).toHaveLength(0);
    expect(check.extra).toHaveLength(0);
    expect(check.authorityVerbs).toHaveLength(0);
  });

  it('flags a missing canonical name', () => {
    const check = checkDescriptorIdentity(CANONICAL_TOOL_NAMES.filter((n) => n !== 'mx_run_command'));
    expect(check.ok).toBe(false);
    expect(check.missing).toContain('mx_run_command');
  });

  it('flags an extra non-canonical name', () => {
    const check = checkDescriptorIdentity([...CANONICAL_TOOL_NAMES, 'mx_extra_tool']);
    expect(check.ok).toBe(false);
    expect(check.extra).toContain('mx_extra_tool');
  });

  it('flags a forbidden authority verb (cognition can never name governance)', () => {
    for (const verb of ['trust.grant', 'approval.decide', 'policy.set', 'daemon.shutdown']) {
      const check = checkDescriptorIdentity([...CANONICAL_TOOL_NAMES, verb]);
      expect(check.ok, `${verb} must be flagged`).toBe(false);
      expect(check.authorityVerbs).toContain(verb);
    }
  });

  it('canonicalNamesFromIds resolves OpenCode-style namespaced ids to the canonical set', () => {
    const ids = CANONICAL_TOOL_NAMES.map((n) => `mx-loom_${n}`);
    expect(canonicalNamesFromIds(ids).sort()).toEqual([...CANONICAL_TOOL_NAMES].sort());
    // A built-in OpenCode tool id contributes nothing.
    expect(canonicalNamesFromIds([...ids, 'bash', 'read', 'webfetch']).sort()).toEqual(
      [...CANONICAL_TOOL_NAMES].sort(),
    );
  });

  it('cross-runtime identity: all three declared surfaces produce the same canonical name-set', () => {
    const divergence = crossRuntimeIdentityDivergence([
      { runtime: 'pi', names: [...CANONICAL_TOOL_NAMES] },
      { runtime: 'adk', names: [...CANONICAL_TOOL_NAMES] },
      { runtime: 'opencode', names: canonicalNamesFromIds(CANONICAL_TOOL_NAMES.map((n) => `mx-loom_${n}`)) },
    ]);
    expect(divergence).toEqual([]);
  });

  it('cross-runtime identity flags a runtime whose surface diverges', () => {
    const divergence = crossRuntimeIdentityDivergence([
      { runtime: 'pi', names: [...CANONICAL_TOOL_NAMES] },
      { runtime: 'adk', names: CANONICAL_TOOL_NAMES.filter((n) => n !== 'mx_cancel') },
    ]);
    expect(divergence).toEqual(['adk']);
  });

  it('cross-runtime identity: single runtime with the canonical set diverges from nothing (returns empty)', () => {
    const divergence = crossRuntimeIdentityDivergence([{ runtime: 'pi', names: [...CANONICAL_TOOL_NAMES] }]);
    expect(divergence).toEqual([]);
  });

  it('cross-runtime identity: empty input is trivially non-diverging', () => {
    expect(crossRuntimeIdentityDivergence([])).toEqual([]);
  });

  it('cross-runtime identity: deduplicates names before comparing (no false divergence from repeated ids)', () => {
    // A surface that lists each name twice should still pass as canonical.
    const doubled = [...CANONICAL_TOOL_NAMES, ...CANONICAL_TOOL_NAMES];
    const divergence = crossRuntimeIdentityDivergence([{ runtime: 'pi', names: doubled }]);
    expect(divergence).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Secret-free, legible rendering
// ---------------------------------------------------------------------------

describe('portability matrix — renderMatrixTable', () => {
  it('renders ids/scopes/statuses only (no secrets, no args)', () => {
    const rows = [
      cell('pi', 'S3', 'in-scope', 'ok', 'ok'),
      cell('pi', 'S7', 'in-scope', 'denied', 'denied', {
        expectedErrorCode: 'policy_denied',
        actualErrorCode: 'policy_denied',
      }),
      cell('opencode', 'S3', 'model-gated', 'ok', null),
      cell('opencode', 'S4', 'out-of-scope', 'ok', null),
    ];
    const table = renderMatrixTable(rows);
    expect(table).toContain('runtime');
    expect(table).toContain('pi');
    expect(table).toContain('S3');
    expect(table).toContain('policy_denied');
    expect(table).toContain('PASS');
    // out-of-scope / model-gated render a dash, not PASS/FAIL.
    expect(table).toMatch(/opencode\s+S4\s+out-of-scope.*—/);
    // No credential-shaped token leaks into the rendered artifact.
    expect(table).not.toMatch(/MATRIX_|MX_AGENT_|syt_[a-z]|ghp_|xox[bp]-/);
  });

  it('a failing in-scope cell renders FAIL', () => {
    const rows = [cell('adk', 'S4', 'in-scope', 'ok', 'denied')];
    expect(renderMatrixTable(rows)).toContain('FAIL');
    expect(renderMatrixTable(rows)).not.toContain('PASS');
  });

  it('renders cleanly with zero rows (only the header + separator)', () => {
    const table = renderMatrixTable([]);
    expect(table).toContain('runtime');
    expect(table).toContain('pass');
    // No data rows means no runtime name in the body.
    expect(table).not.toContain('pi');
    expect(table).not.toContain('adk');
    expect(table).not.toContain('opencode');
  });
});

// ---------------------------------------------------------------------------
// SCENARIO_STEP_IDS drift guard: the module's declared step set must match
// the IDs buildGoldenScenario actually produces.
// ---------------------------------------------------------------------------

const FAKE_COORDS = {
  room: '!drift:localhost',
  targetAgentId: 'agent-b',
  allowTool: 'run_tests@1.0.0',
  approvalTool: 'deploy@1.0.0',
  deniedTool: 'rm_rf@1.0.0',
  allowedCommand: 'echo',
};

describe('portability matrix — SCENARIO_STEP_IDS drift guard', () => {
  it('matches the step ids buildGoldenScenario actually produces (no silent drift)', () => {
    const steps = buildGoldenScenario(FAKE_COORDS, 'drift-nonce');
    const actualIds = steps.map((s) => s.id);
    expect(actualIds).toEqual([...SCENARIO_STEP_IDS]);
  });

  it('SCENARIO_STEP_IDS is ordered S1–S8 (eight steps, sequential)', () => {
    expect(SCENARIO_STEP_IDS).toHaveLength(8);
    expect(SCENARIO_STEP_IDS[0]).toBe('S1');
    expect(SCENARIO_STEP_IDS[7]).toBe('S8');
  });
});

// ---------------------------------------------------------------------------
// INLINE_FAKE_BUILDERS — schema shape correctness (daemon-free)
//
// The `INLINE_FAKE_BUILDERS` shim is the fallback used by the Pi arm when the
// real @earendil-works/pi-coding-agent is not installed. The daemon round-trip
// is identical regardless of which builders are used, so this shim must produce
// JSON-Schema-compatible objects (type, properties, required, enum, items, …)
// that survive JSON serialization and correctly encode the required/optional
// distinction Type.Object derives from Type.Optional markers.
// ---------------------------------------------------------------------------

describe('portability matrix — INLINE_FAKE_BUILDERS primitive schema shapes', () => {
  it('Type.String() produces { type: "string" }', () => {
    const schema = INLINE_FAKE_BUILDERS.Type.String() as Record<string, unknown>;
    expect(schema['type']).toBe('string');
  });

  it('Type.String({ description }) forwards extra options', () => {
    const schema = INLINE_FAKE_BUILDERS.Type.String({ description: 'my label' }) as Record<string, unknown>;
    expect(schema['type']).toBe('string');
    expect(schema['description']).toBe('my label');
  });

  it('Type.Integer() produces { type: "integer" }', () => {
    const schema = INLINE_FAKE_BUILDERS.Type.Integer() as Record<string, unknown>;
    expect(schema['type']).toBe('integer');
  });

  it('Type.Integer({ minimum, maximum }) forwards numeric constraints', () => {
    const schema = INLINE_FAKE_BUILDERS.Type.Integer({ minimum: 0, maximum: 100 }) as Record<string, unknown>;
    expect(schema['type']).toBe('integer');
    expect(schema['minimum']).toBe(0);
    expect(schema['maximum']).toBe(100);
  });

  it('Type.Number() produces { type: "number" }', () => {
    expect((INLINE_FAKE_BUILDERS.Type.Number() as Record<string, unknown>)['type']).toBe('number');
  });

  it('Type.Boolean() produces { type: "boolean" }', () => {
    expect((INLINE_FAKE_BUILDERS.Type.Boolean() as Record<string, unknown>)['type']).toBe('boolean');
  });

  it('Type.Array(items) produces { type: "array", items }', () => {
    const items = INLINE_FAKE_BUILDERS.Type.String();
    const schema = INLINE_FAKE_BUILDERS.Type.Array(items) as Record<string, unknown>;
    expect(schema['type']).toBe('array');
    expect(schema['items']).toEqual({ type: 'string' });
  });

  it('StringEnum(["a","b"]) produces { type: "string", enum: ["a","b"] }', () => {
    const schema = INLINE_FAKE_BUILDERS.StringEnum(['a', 'b']) as Record<string, unknown>;
    expect(schema['type']).toBe('string');
    expect(schema['enum']).toEqual(['a', 'b']);
  });

  it('StringEnum copies the values array (mutating the input does not affect the schema)', () => {
    const values: string[] = ['x', 'y'];
    const schema = INLINE_FAKE_BUILDERS.StringEnum(values) as Record<string, unknown>;
    values.push('z');
    expect(schema['enum']).toEqual(['x', 'y']);
  });

  it('all primitive builders produce JSON-serializable, symbol-free values with a `type` key', () => {
    const schemas = [
      INLINE_FAKE_BUILDERS.Type.String(),
      INLINE_FAKE_BUILDERS.Type.Integer(),
      INLINE_FAKE_BUILDERS.Type.Number(),
      INLINE_FAKE_BUILDERS.Type.Boolean(),
      INLINE_FAKE_BUILDERS.Type.Array(INLINE_FAKE_BUILDERS.Type.String()),
      INLINE_FAKE_BUILDERS.StringEnum(['a', 'b']),
    ];
    for (const schema of schemas) {
      const rt = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
      expect(rt['type'], `${JSON.stringify(rt)} must carry 'type'`).toBeDefined();
    }
  });
});

describe('portability matrix — INLINE_FAKE_BUILDERS Type.Object required/optional', () => {
  it('all required fields appear in `required`', () => {
    const schema = INLINE_FAKE_BUILDERS.Type.Object({
      foo: INLINE_FAKE_BUILDERS.Type.String(),
      bar: INLINE_FAKE_BUILDERS.Type.Integer(),
    }) as Record<string, unknown>;
    expect(schema['type']).toBe('object');
    expect([...(schema['required'] as string[])].sort()).toEqual(['bar', 'foo']);
  });

  it('Type.Optional fields are absent from `required`', () => {
    const schema = INLINE_FAKE_BUILDERS.Type.Object({
      required_field: INLINE_FAKE_BUILDERS.Type.String(),
      optional_field: INLINE_FAKE_BUILDERS.Type.Optional(INLINE_FAKE_BUILDERS.Type.Integer()),
    }) as Record<string, unknown>;
    const required = schema['required'] as string[];
    expect(required).toContain('required_field');
    expect(required).not.toContain('optional_field');
  });

  it('all-optional fields → no `required` property on the schema', () => {
    const schema = INLINE_FAKE_BUILDERS.Type.Object({
      a: INLINE_FAKE_BUILDERS.Type.Optional(INLINE_FAKE_BUILDERS.Type.String()),
      b: INLINE_FAKE_BUILDERS.Type.Optional(INLINE_FAKE_BUILDERS.Type.Boolean()),
    }) as Record<string, unknown>;
    expect(schema).not.toHaveProperty('required');
  });

  it('Type.Object forwards extra options (additionalProperties, description)', () => {
    const schema = INLINE_FAKE_BUILDERS.Type.Object(
      { x: INLINE_FAKE_BUILDERS.Type.String() },
      { additionalProperties: false, description: 'test object' },
    ) as Record<string, unknown>;
    expect(schema['additionalProperties']).toBe(false);
    expect(schema['description']).toBe('test object');
  });

  it('Type.Object with mixed required/optional is JSON-serializable (no symbol bleed into JSON)', () => {
    const schema = INLINE_FAKE_BUILDERS.Type.Object({
      name: INLINE_FAKE_BUILDERS.Type.String(),
      count: INLINE_FAKE_BUILDERS.Type.Optional(INLINE_FAKE_BUILDERS.Type.Integer()),
    });
    const rt = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
    expect((rt['required'] as string[])).toEqual(['name']);
    expect(rt['properties']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// resolvePiPackageRoot — env override behavior (no filesystem side-effects needed)
// ---------------------------------------------------------------------------

describe('portability matrix — resolvePiPackageRoot env override', () => {
  it('MXL_PI_PACKAGE_ROOT set to an absolute path returns it with source "env"', () => {
    const result = resolvePiPackageRoot({ MXL_PI_PACKAGE_ROOT: '/opt/pi-root' });
    expect(result.root).toBe('/opt/pi-root');
    expect(result.source).toBe('env');
  });

  it('MXL_PI_PACKAGE_ROOT whitespace-only is treated as absent (falls through to workspace)', () => {
    const result = resolvePiPackageRoot({ MXL_PI_PACKAGE_ROOT: '   ' });
    expect(result.source).not.toBe('env');
  });

  it('absent MXL_PI_PACKAGE_ROOT never reports source "env"', () => {
    const result = resolvePiPackageRoot({});
    expect(result.source).not.toBe('env');
    // When Pi is not installed in the workspace, `root` is null and source is 'absent'.
    if (result.source === 'absent') {
      expect(result.root).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// evaluateCell — expectedErrorCode set but actualErrorCode absent
//
// A runtime returning `denied` with no error code when `policy_denied` was
// expected is a regression (the error taxonomy is a closed set and every denial
// must carry its code). The cell must fail even when statuses match.
// ---------------------------------------------------------------------------

describe('portability matrix — evaluateCell: expectedErrorCode set but actual code absent', () => {
  it('fails when the expected code is set but the actual result carries no code (null)', () => {
    const c = evaluateCell({
      runtime: 'pi',
      stepId: 'S7',
      scope: 'in-scope',
      expected: 'denied',
      expectedErrorCode: 'policy_denied',
      actual: 'denied',
      actualErrorCode: null,
    });
    expect(c.pass).toBe(false);
    expect(c.actualErrorCode).toBeNull();
  });

  it('fails when the expected code is set and the wrong code is returned', () => {
    const c = evaluateCell({
      runtime: 'adk',
      stepId: 'S5',
      scope: 'in-scope',
      expected: 'denied',
      expectedErrorCode: 'approval_denied',
      actual: 'denied',
      actualErrorCode: 'policy_denied',
    });
    expect(c.pass).toBe(false);
  });

  it('passes when both status and error code match', () => {
    const c = evaluateCell({
      runtime: 'pi',
      stepId: 'S8',
      scope: 'in-scope',
      expected: 'denied',
      expectedErrorCode: 'policy_denied',
      actual: 'denied',
      actualErrorCode: 'policy_denied',
    });
    expect(c.pass).toBe(true);
  });

  it('when expectedErrorCode is absent, any actualErrorCode (including null) does not block pass', () => {
    // status match is sufficient when no error code is expected.
    const c = evaluateCell({
      runtime: 'pi',
      stepId: 'S1',
      scope: 'in-scope',
      expected: 'ok',
      actual: 'ok',
      actualErrorCode: null,
    });
    expect(c.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// crossRuntimeIdentityDivergence — multiple diverging runtimes
// ---------------------------------------------------------------------------

describe('portability matrix — crossRuntimeIdentityDivergence: multiple diverging runtimes', () => {
  it('flags both Pi and ADK when both surfaces diverge from the canonical set', () => {
    const divergence = crossRuntimeIdentityDivergence([
      { runtime: 'pi', names: CANONICAL_TOOL_NAMES.filter((n) => n !== 'mx_cancel') },
      { runtime: 'adk', names: [...CANONICAL_TOOL_NAMES, 'mx_extra'] },
      { runtime: 'opencode', names: [...CANONICAL_TOOL_NAMES] },
    ]);
    expect(divergence).toContain('pi');
    expect(divergence).toContain('adk');
    expect(divergence).not.toContain('opencode');
    expect(divergence).toHaveLength(2);
  });

  it('flags all three runtimes when all three surfaces diverge', () => {
    const divergence = crossRuntimeIdentityDivergence([
      { runtime: 'pi', names: ['mx_find_agents'] },
      { runtime: 'adk', names: ['mx_delegate_tool'] },
      { runtime: 'opencode', names: [] },
    ]);
    expect(divergence.sort()).toEqual(['adk', 'opencode', 'pi']);
  });
});

// ---------------------------------------------------------------------------
// canonicalNamesFromIds — edge cases
// ---------------------------------------------------------------------------

describe('portability matrix — canonicalNamesFromIds edge cases', () => {
  it('empty ids list produces empty resolved names', () => {
    expect(canonicalNamesFromIds([])).toEqual([]);
  });

  it('ids with no canonical substring produce empty resolved names', () => {
    expect(canonicalNamesFromIds(['bash', 'read', 'webfetch', 'computer_use'])).toEqual([]);
  });

  it('duplicate ids do not produce duplicate canonical names (one match per canonical verb)', () => {
    const doubled = [
      ...CANONICAL_TOOL_NAMES.map((n) => `mx-loom_${n}`),
      ...CANONICAL_TOOL_NAMES.map((n) => `mx-loom_${n}`),
    ];
    const resolved = canonicalNamesFromIds(doubled);
    expect(new Set(resolved).size).toBe(resolved.length);
    expect(resolved.length).toBe(CANONICAL_TOOL_NAMES.length);
  });

  it('a single server-namespaced id resolves to exactly the one matching canonical name', () => {
    const resolved = canonicalNamesFromIds(['mx-loom_mx_find_agents']);
    expect(resolved).toContain('mx_find_agents');
    expect(resolved).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// portabilityPrereqError — two of three opt-ins missing
// ---------------------------------------------------------------------------

describe('portability matrix — portabilityPrereqError: two opt-ins missing', () => {
  it('pi and adk both missing → error names both MXL_PI_BINDING_E2E and MXL_ADK_LONG_RUNNING_E2E', () => {
    const err = portabilityPrereqError({
      required: true,
      reachable: true,
      fixture: FULL_FIXTURE,
      optIns: { pi: false, adk: false, opencode: true },
    });
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/MXL_PI_BINDING_E2E/);
    expect(err?.message).toMatch(/MXL_ADK_LONG_RUNNING_E2E/);
    expect(err?.message).not.toMatch(/MXL_OPENCODE_MCP_E2E/);
  });

  it('adk and opencode both missing → error names both flags, not the present pi flag', () => {
    const err = portabilityPrereqError({
      required: true,
      reachable: true,
      fixture: FULL_FIXTURE,
      optIns: { pi: true, adk: false, opencode: false },
    });
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/MXL_ADK_LONG_RUNNING_E2E/);
    expect(err?.message).toMatch(/MXL_OPENCODE_MCP_E2E/);
    expect(err?.message).not.toMatch(/MXL_PI_BINDING_E2E/);
  });
});

// ---------------------------------------------------------------------------
// renderMatrixTable — model-gated-only and mixed matrices
// ---------------------------------------------------------------------------

describe('portability matrix — renderMatrixTable: model-gated / out-of-scope rows', () => {
  it('a matrix with only model-gated rows renders "—", no PASS or FAIL', () => {
    const rows = [
      evaluateCell({ runtime: 'opencode', stepId: 'S3', scope: 'model-gated', expected: 'ok', actual: null }),
    ];
    const table = renderMatrixTable(rows);
    expect(table).not.toContain('PASS');
    expect(table).not.toContain('FAIL');
    expect(table).toMatch(/—/);
  });

  it('a mixed matrix (in-scope passing + model-gated not run) shows PASS only for in-scope', () => {
    const rows = [
      evaluateCell({ runtime: 'pi', stepId: 'S1', scope: 'in-scope', expected: 'ok', actual: 'ok' }),
      evaluateCell({ runtime: 'opencode', stepId: 'S3', scope: 'model-gated', expected: 'ok', actual: null }),
    ];
    const table = renderMatrixTable(rows);
    expect(table).toContain('PASS');
    expect(table).not.toContain('FAIL');
    expect(table).toMatch(/—/);
  });

  it('a mixed matrix (in-scope failing + out-of-scope) shows FAIL only for in-scope', () => {
    const rows = [
      evaluateCell({ runtime: 'adk', stepId: 'S4', scope: 'in-scope', expected: 'ok', actual: 'denied' }),
      evaluateCell({ runtime: 'opencode', stepId: 'S4', scope: 'out-of-scope', expected: 'ok', actual: null }),
    ];
    const table = renderMatrixTable(rows);
    expect(table).toContain('FAIL');
    expect(table).not.toContain('PASS');
    expect(table).toMatch(/—/);
  });
});
