/**
 * T206 / #28 — the PORTABILITY MATRIX (the M2 exit gate).
 *
 * The whole bet of mx-loom: **one canonical descriptor set** drives the **same
 * delegation/approval behaviour across every runtime** — "same descriptors must
 * work everywhere." This gate runs the agreed (subset) golden scenario from the
 * SAME `scenario.ts` step table under Pi, ADK, and OpenCode, collects a
 * `runtime × step → {expected, actual, pass}` matrix, asserts every in-scope cell
 * matches the binding-agnostic expectation, emits a legible matrix table, and
 * proves the cross-runtime descriptor-identity invariant (the nine `mx_*` names,
 * no authority verb, identical across all three).
 *
 *   - **Pi** (native binding) drives the **full S1–S8** model-free via
 *     `ToolDefinition.execute()` + the shared `runStep` hold→decide→resolve runner.
 *   - **ADK** (long-running shim) drives the **full S1–S8** model-free via the
 *     `examples/adk` bundle and the out-of-band operator.
 *   - **OpenCode** contributes the descriptor-identity / surfacing invariant
 *     always-on, and S3 under an opt-in model (`MXL_OPENCODE_MODEL`) — the held
 *     execution steps are a documented stretch, never the gate (T203 posture).
 *
 * Gating (G5): with no fixture (laptop / fast CI) the matrix skips cleanly. When
 * demanded (`MXL_PORTABILITY_MATRIX=1` + the golden fixture + all three per-runtime
 * opt-ins) a missing/unreachable runtime or daemon is a HARD failure. The file also
 * runs whichever per-runtime opt-ins are present, so a single row is runnable
 * locally (the full three-runtime demand requires `MXL_PORTABILITY_MATRIX=1`).
 */
import { randomUUID } from 'node:crypto';

import { InMemoryAuditSink } from '@mx-loom/audit';
import { isForbiddenAuthorityVerb, validateEnvelope } from '@mx-loom/registry';
import type { ToolResult } from '@mx-loom/registry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ADK_FAKE_SECRET_ENV,
  assertAdkPrereqs,
  cleanupAdk,
  runAdkScenario,
  type AdkPrereqs,
  type AdkScenarioResult,
} from './_adk-runtime.js';
import {
  DAEMON_REACHABLE,
  SECRET_PATTERN,
  coordsFromFixture,
  createGoldenPiArm,
  readGoldenFixture,
  runStep,
  type LivePiArm,
} from './_golden-harness.js';
import {
  OPENCODE_FAKE_SECRET_ENV,
  assertOpencodePrereqs,
  cleanupOpencode,
  requestedModes,
  runOpencodeScenario,
  type OpencodePrereqs,
  type OpencodeScenarioResult,
} from './_opencode-runtime.js';
import { resolvePiBuilders, resolvePiPackageRoot } from './_pi-builders.js';
import {
  canonicalNamesFromIds,
  capabilityFor,
  checkDescriptorIdentity,
  crossRuntimeIdentityDivergence,
  enabledRuntimes,
  evaluateCell,
  isPortabilityMatrixRequired,
  portabilityPrereqError,
  readOptIns,
  reduceMatrix,
  renderMatrixTable,
  type MatrixRow,
  type RuntimeName,
} from './_portability-matrix.js';
import { buildGoldenScenario, expectedEmissions, type GoldenStep } from './scenario.js';

const ENABLED = enabledRuntimes();
const REQUIRED = isPortabilityMatrixRequired();
/** Skip cleanly only when not demanded AND no per-runtime opt-in is present. */
const SKIP = !REQUIRED && ENABLED.length === 0;

/** Map a terminal envelope's error code (or null) for a matrix cell. */
function errorCodeOf(env: ToolResult | undefined | null): MatrixRow['actualErrorCode'] {
  return env?.error?.code ?? null;
}

describe.skipIf(SKIP)('T206 e2e · portability matrix — same descriptors pass under Pi, ADK, OpenCode', () => {
  const rows: MatrixRow[] = [];
  const identitySurfaces: Array<{ runtime: RuntimeName; names: readonly string[] }> = [];

  // Pi
  let piArm: LivePiArm | undefined;
  let piSink: InMemoryAuditSink | undefined;
  let piSteps: GoldenStep[] = [];
  let piTerminals: Record<string, ToolResult> = {};
  let piEmissionCount = 0;
  let piCorrelationId = '';
  let piBuilderSource = '';

  // ADK
  let adkPre: AdkPrereqs | null = null;
  let adk: AdkScenarioResult | undefined;

  // OpenCode
  let opencodePre: OpencodePrereqs | null = null;
  let opencode: OpencodeScenarioResult | undefined;
  const savedSecretEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    // Fail-not-skip: when fully demanded, a missing fixture/opt-in is a HARD failure.
    const prereqErr = portabilityPrereqError({
      required: REQUIRED,
      reachable: DAEMON_REACHABLE,
      fixture: readGoldenFixture(),
      optIns: readOptIns(),
    });
    if (prereqErr) throw prereqErr;

    const fixture = readGoldenFixture();
    if (fixture === null) {
      throw new Error(
        'portability matrix: the golden fixture coordinates are absent. Set MXL_CONFORMANCE_* (the bring-up ' +
          'exports them) before running any enabled runtime row.',
      );
    }
    const coords = coordsFromFixture(fixture);

    // -----------------------------------------------------------------------
    // Pi row — full S1–S8, model-free, via the native ToolDefinition.execute().
    // -----------------------------------------------------------------------
    if (ENABLED.includes('pi')) {
      piCorrelationId = `mxl-portability-pi-${randomUUID()}`;
      const piNonce = randomUUID();
      piSteps = buildGoldenScenario(coords, piNonce);
      piSink = new InMemoryAuditSink();
      const resolved = await resolvePiBuilders(resolvePiPackageRoot());
      piBuilderSource = resolved.source;
      piArm = await createGoldenPiArm({
        room: coords.room,
        auditSink: piSink,
        correlationId: piCorrelationId,
        builders: resolved.builders,
      });

      for (const step of piSteps) {
        const outcome = await runStep(piArm.arm, step);
        const terminal = outcome.terminal;
        expect(validateEnvelope(terminal), `Pi ${step.id}: envelope must validate`).toBe(true);
        expect(JSON.stringify(terminal), `Pi ${step.id}: secret-shaped value`).not.toMatch(SECRET_PATTERN);
        piTerminals[step.id] = terminal;
        rows.push(
          evaluateCell({
            runtime: 'pi',
            stepId: step.id,
            scope: 'in-scope',
            expected: step.terminalStatus,
            ...(step.terminalErrorCode !== undefined ? { expectedErrorCode: step.terminalErrorCode } : {}),
            actual: terminal.status,
            actualErrorCode: errorCodeOf(terminal),
          }),
        );
      }
      // Snapshot emissions BEFORE any later credential-arg probe so AC4 stays exact.
      piEmissionCount = piSink.count;
      identitySurfaces.push({ runtime: 'pi', names: piArm.tools.map((t) => t.name) });
    }

    // -----------------------------------------------------------------------
    // ADK row — full S1–S8, model-free, via the LongRunningFunctionTool bundle.
    // Seed fake secrets so the child-env scrub is a real assertion (restored below).
    // -----------------------------------------------------------------------
    if (ENABLED.includes('adk')) {
      for (const [k, v] of Object.entries(ADK_FAKE_SECRET_ENV)) {
        if (!(k in savedSecretEnv)) savedSecretEnv[k] = process.env[k];
        process.env[k] = v;
      }
      adkPre = await assertAdkPrereqs();
      adk = await runAdkScenario(adkPre, `mxl-portability-adk-${randomUUID()}`);
      const adkSteps = buildGoldenScenario(coords, randomUUID());
      for (const step of adkSteps) {
        const terminal = adk.steps[step.id];
        rows.push(
          evaluateCell({
            runtime: 'adk',
            stepId: step.id,
            scope: 'in-scope',
            expected: step.terminalStatus,
            ...(step.terminalErrorCode !== undefined ? { expectedErrorCode: step.terminalErrorCode } : {}),
            actual: terminal?.status ?? null,
            actualErrorCode: errorCodeOf(terminal),
          }),
        );
      }
      identitySurfaces.push({ runtime: 'adk', names: adk.toolNames });
    }

    // -----------------------------------------------------------------------
    // OpenCode row — descriptor identity always-on; S3 under an opt-in model.
    // -----------------------------------------------------------------------
    if (ENABLED.includes('opencode')) {
      for (const [k, v] of Object.entries(OPENCODE_FAKE_SECRET_ENV)) {
        if (!(k in savedSecretEnv)) savedSecretEnv[k] = process.env[k];
        process.env[k] = v;
      }
      opencodePre = await assertOpencodePrereqs();
      const mode = requestedModes()[0]!;
      opencode = await runOpencodeScenario(mode, opencodePre, `mxl-portability-opencode-${mode}-${randomUUID()}`);

      const ocCap = capabilityFor('opencode');
      const ocSteps = buildGoldenScenario(coords, randomUUID());
      for (const step of ocSteps) {
        const scope = ocCap.stepScope[step.id]!;
        // Only S3 is observable model-free under a model arm; the rest are out-of-scope.
        const actual = step.id === 'S3' ? opencode.delegate?.status ?? null : null;
        rows.push(
          evaluateCell({
            runtime: 'opencode',
            stepId: step.id,
            scope,
            expected: step.terminalStatus,
            ...(step.terminalErrorCode !== undefined ? { expectedErrorCode: step.terminalErrorCode } : {}),
            actual,
            actualErrorCode: errorCodeOf(step.id === 'S3' ? opencode.delegate : null),
          }),
        );
      }
      identitySurfaces.push({ runtime: 'opencode', names: canonicalNamesFromIds(opencode.toolIds) });
    }
  }, 600_000);

  afterAll(async () => {
    await piArm?.arm.close();
    cleanupAdk(adkPre);
    cleanupOpencode(opencodePre);
    for (const [k, v] of Object.entries(savedSecretEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // -------------------------------------------------------------------------
  // Pi row (full S1–S8 native, model-free)
  // -------------------------------------------------------------------------

  it.skipIf(!ENABLED.includes('pi'))('Pi row: every S1–S8 terminal matches the binding-agnostic expectation', () => {
    expect(piArm, 'Pi arm not initialised').toBeTruthy();
    for (const step of piSteps) {
      const terminal = piTerminals[step.id];
      expect(terminal?.status, `Pi ${step.id} ${step.label}`).toBe(step.terminalStatus);
      if (step.terminalErrorCode !== undefined) {
        expect(terminal?.error?.code, `Pi ${step.id}: error code`).toBe(step.terminalErrorCode);
      }
    }
    // A policy_denied terminal carries no resolvable handle and requests no approval.
    const s8 = piTerminals['S8'];
    expect(s8?.handle, 'Pi S8: a policy denial has no handle').toBeNull();
    expect(s8?.approval, 'Pi S8: a policy denial requests no approval').toBeNull();
    // AC1 — S3 ungated delegation succeeded with a populated audit_ref.
    expect(piTerminals['S3']?.status).toBe('ok');
    expect(piTerminals['S3']?.audit_ref.invocation_id, 'Pi S3 (AC1): populated invocation_id').toBeTruthy();
  });

  it.skipIf(!ENABLED.includes('pi'))('Pi row: descriptor identity — exactly the nine mx_* verbs, no authority verb', () => {
    const check = checkDescriptorIdentity(piArm!.tools.map((t) => t.name));
    expect(check.missing, `Pi missing canonical tools: ${check.missing.join(', ')}`).toHaveLength(0);
    expect(check.extra, `Pi surfaced non-canonical tools: ${check.extra.join(', ')}`).toHaveLength(0);
    expect(check.authorityVerbs, `Pi surfaced authority verbs: ${check.authorityVerbs.join(', ')}`).toHaveLength(0);
    expect(check.ok).toBe(true);
  });

  it.skipIf(!ENABLED.includes('pi'))('Pi row: AC4 — one audit row per emission, recoverable by correlation_id', () => {
    const expected = expectedEmissions(piSteps);
    expect(piEmissionCount, 'one row per Pi emission (the AC4 counting model)').toBe(expected.total);
    const session = piSink!.byCorrelation(piCorrelationId);
    expect(session, 'byCorrelation recovers the complete Pi session').toHaveLength(expected.total);
    expect(JSON.stringify(session)).not.toMatch(SECRET_PATTERN);
  });

  it.skipIf(!ENABLED.includes('pi'))('Pi row: secret boundary — a credential-shaped arg is rejected with invalid_args', async () => {
    const out = await piArm!.arm.dispatch('mx_delegate_tool', {
      agent: 'irrelevant',
      tool: 'irrelevant',
      args: { access_token: 'syt_fake_MXLPILEAK_should_be_rejected' },
    });
    expect(out.status).toBe('error');
    expect(out.error?.code).toBe('invalid_args');
    expect(JSON.stringify(out)).not.toContain('MXLPILEAK');
    expect(JSON.stringify(out)).not.toMatch(SECRET_PATTERN);
  });

  // -------------------------------------------------------------------------
  // ADK row (full S1–S8 via the long-running shim)
  // -------------------------------------------------------------------------

  it.skipIf(!ENABLED.includes('adk'))('ADK row: every S1–S8 terminal matches the binding-agnostic expectation', () => {
    expect(adk, 'ADK row not initialised').toBeTruthy();
    const steps = buildGoldenScenario(coordsFromFixture(readGoldenFixture()!), 'adk-assert');
    for (const step of steps) {
      const terminal = adk!.steps[step.id];
      expect(validateEnvelope(terminal as unknown as Record<string, unknown>), `ADK ${step.id}: valid envelope`).toBe(true);
      expect(terminal?.status, `ADK ${step.id} ${step.label}`).toBe(step.terminalStatus);
      if (step.terminalErrorCode !== undefined) {
        expect(terminal?.error?.code, `ADK ${step.id}: error code`).toBe(step.terminalErrorCode);
      }
    }
    // Every held step resolved — nothing left pending.
    expect(adk!.remainingPendingIds).toEqual([]);
    // S8 deny-by-default: no resolvable handle, no approval requested.
    expect(adk!.steps['S8']?.handle, 'ADK S8: policy denial has no handle').toBeNull();
    expect(adk!.steps['S8']?.approval, 'ADK S8: policy denial requests no approval').toBeNull();
  });

  it.skipIf(!ENABLED.includes('adk'))('ADK row: descriptor identity + secret boundary (scrubbed child env)', () => {
    const check = checkDescriptorIdentity(adk!.toolNames);
    expect(check.ok, `ADK identity: missing=${check.missing} extra=${check.extra} authority=${check.authorityVerbs}`).toBe(true);
    // room/correlation are session metadata, never model args.
    expect(adk!.sessionState['mx_room']).toBeTruthy();
    // No synthetic secret key reached the mx-loom-mcp child env, no value leaked.
    expect(adk!.raw).not.toMatch(SECRET_PATTERN);
    expect(adk!.raw).not.toContain('MXLADKLONGLEAK');
    for (const key of Object.keys(ADK_FAKE_SECRET_ENV)) {
      expect(adk!.childEnvKeys, `secret-shaped key admitted to ADK child env: ${key}`).not.toContain(key);
    }
  });

  // -------------------------------------------------------------------------
  // OpenCode row (descriptor identity always; S3 under an opt-in model)
  // -------------------------------------------------------------------------

  it.skipIf(!ENABLED.includes('opencode'))('OpenCode row: connects and surfaces exactly the canonical mx_* tools, no authority verb', () => {
    expect(opencode, 'OpenCode row not initialised').toBeTruthy();
    expect(opencode!.mcpStatus['mx-loom'], `mx-loom status: ${JSON.stringify(opencode!.mcpStatus)}`).toBe('connected');
    const present = canonicalNamesFromIds(opencode!.toolIds);
    const check = checkDescriptorIdentity(present);
    expect(check.missing, `OpenCode missing canonical tools: ${check.missing.join(', ')}`).toHaveLength(0);
    // No surfaced mx id maps to an authority verb (check the full id and the bare verb).
    const mxIds = opencode!.toolIds.filter((id) => id.includes('mx-loom') || /(^|[_.])mx_/.test(id));
    for (const id of mxIds) {
      const bare = id.slice(id.lastIndexOf('_') + 1);
      expect(isForbiddenAuthorityVerb(id) || isForbiddenAuthorityVerb(bare), `authority verb surfaced: ${id}`).toBe(false);
    }
  });

  it.skipIf(!ENABLED.includes('opencode'))('OpenCode row: scrubbed env leaks no secret; S3 envelope valid when a model ran', () => {
    const raw = JSON.stringify({
      env: opencode!.serverEnvKeys,
      config: opencode!.renderedConfig,
      ids: opencode!.toolIds,
      status: opencode!.mcpStatus,
      delegate: opencode!.delegate,
    });
    for (const key of Object.keys(OPENCODE_FAKE_SECRET_ENV)) {
      expect(opencode!.serverEnvKeys, `secret-shaped key reached the opencode serve env: ${key}`).not.toContain(key);
    }
    expect(raw).not.toContain('MXLOPENCODELEAK');
    expect(raw).not.toMatch(SECRET_PATTERN);

    if (opencode!.modelRan && opencode!.delegate !== null) {
      expect(validateEnvelope(opencode!.delegate)).toBe(true);
      expect(['ok', 'running', 'awaiting_approval']).toContain(opencode!.delegate.status);
      expect(opencode!.delegate.audit_ref, 'S3 envelope must carry an audit_ref').toBeTruthy();
    }
  });

  // -------------------------------------------------------------------------
  // The aggregate: the matrix table + the verdict + the cross-runtime invariant.
  // -------------------------------------------------------------------------

  it('renders the portability matrix and asserts every in-scope cell passes (the M2 exit)', () => {
    // The M2-exit artifact (ids/statuses only — no secrets).
    // eslint-disable-next-line no-console
    console.info(
      `\n[T206 portability matrix] runtimes=${ENABLED.join(',') || '(none)'} pi-builders=${piBuilderSource || 'n/a'}\n` +
        renderMatrixTable(rows),
    );
    const verdict = reduceMatrix(rows);
    expect(verdict.failures, `in-scope failures:\n${renderMatrixTable(verdict.failures)}`).toHaveLength(0);
    expect(verdict.green).toBe(true);
    // The demanded matrix must have actually exercised in-scope cells (not vacuously green).
    if (REQUIRED) expect(verdict.inScopeTotal).toBeGreaterThan(0);
  });

  it('cross-runtime invariant: every runtime surfaces the SAME nine canonical descriptors', () => {
    expect(identitySurfaces.length, 'no runtime surface captured').toBeGreaterThan(0);
    const divergence = crossRuntimeIdentityDivergence(identitySurfaces);
    expect(divergence, `runtimes whose descriptor set diverges: ${divergence.join(', ')}`).toEqual([]);
  });
});
