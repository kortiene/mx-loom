/**
 * Unit tests for the GOLDEN harness gate logic (T114 / #22).
 *
 * These run in the NORMAL fast suite (no daemon) — they are a `*.test.ts` file (not
 * `*.e2e.test.ts`), so the default vitest config collects them and the e2e config
 * excludes them. They lock in the one behavior that makes the golden gate
 * trustworthy: the **skip-clean / fail-not-skip** decision (spec AC6), plus the
 * fixture reader and the binding-agnostic scenario shape. The live arms (which need
 * the two-daemon golden fixture) are exercised only by `pnpm test:e2e`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { awaitingApproval, ok, type AuditRef, type DaemonCall, type ToolResult } from '@mx-loom/registry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  coordsFromFixture,
  countingDaemon,
  envelopeFromCallResult,
  goldenPrereqError,
  isDaemonReachable,
  isGoldenPolicyActive,
  isTwoDaemonRequired,
  readGoldenFixture,
  resolveDaemonSocket,
  runStep,
  SECRET_PATTERN,
  GOLDEN_RESOLVE_BUDGET_MS,
  OPERATOR_DECISION_TIMEOUT_MS,
  type GoldenArm,
  type GoldenFixture,
} from './_golden-harness.js';
import {
  DANGEROUS_COMMAND_ARGS,
  SAFE_COMMAND_ARGS,
  buildGoldenScenario,
  expectedEmissions,
  type GoldenStep,
} from './scenario.js';

const FULL_FIXTURE: GoldenFixture = {
  room: '!golden:localhost',
  targetAgentId: 'agent-b',
  allowTool: 'run_tests@1.0.0',
  approvalTool: 'deploy@1.0.0',
  deniedTool: 'rm_rf@1.0.0',
  allowedCommand: 'echo',
  allowCwd: '/tmp/mxl/b/data',
};

const FULL_ENV: NodeJS.ProcessEnv = {
  MXL_CONFORMANCE_ROOM: '!golden:localhost',
  MXL_CONFORMANCE_TARGET_AGENT: 'agent-b',
  MXL_CONFORMANCE_TOOL: 'run_tests@1.0.0',
  MXL_CONFORMANCE_APPROVAL_TOOL: 'deploy@1.0.0',
  MXL_CONFORMANCE_DENIED_TOOL: 'rm_rf@1.0.0',
  MXL_CONFORMANCE_ALLOWED_COMMAND: 'echo',
  MXL_CONFORMANCE_ALLOW_CWD: '/tmp/mxl/b/data',
};

// ---------------------------------------------------------------------------
// The fail-not-skip gate (the core guarantee — spec AC6)
// ---------------------------------------------------------------------------

describe('golden harness — fail-not-skip gate (the M1-exit invariant)', () => {
  it('NOT demanded → null: flags unset means a clean local/PR skip (no red)', () => {
    expect(goldenPrereqError({ required: false, reachable: false, fixture: null })).toBeNull();
    expect(goldenPrereqError({ required: false, reachable: true, fixture: FULL_FIXTURE })).toBeNull();
  });

  it('demanded + daemon unreachable → red: returns an Error to throw (never a silent skip)', () => {
    const err = goldenPrereqError({ required: true, reachable: false, fixture: FULL_FIXTURE });
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/FAIL/);
    expect(err?.message).toMatch(/MXL_CONFORMANCE_TWO_DAEMON/);
    expect(err?.message).toMatch(/MXL_CONFORMANCE_GOLDEN_POLICY/);
  });

  it('demanded + reachable + fixture incomplete → red: names the missing coordinates', () => {
    const err = goldenPrereqError({ required: true, reachable: true, fixture: null });
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/MXL_CONFORMANCE_APPROVAL_TOOL/);
    expect(err?.message).toMatch(/MXL_CONFORMANCE_ALLOWED_COMMAND/);
    expect(err?.message).toMatch(/MXL_CONFORMANCE_DENIED_TOOL/);
  });

  it('demanded + reachable + fixture complete → null: the suite runs', () => {
    expect(goldenPrereqError({ required: true, reachable: true, fixture: FULL_FIXTURE })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Env-flag readers
// ---------------------------------------------------------------------------

describe('golden harness — env-flag readers', () => {
  it('isTwoDaemonRequired only true for exactly "1"', () => {
    expect(isTwoDaemonRequired({ MXL_CONFORMANCE_TWO_DAEMON: '1' })).toBe(true);
    expect(isTwoDaemonRequired({ MXL_CONFORMANCE_TWO_DAEMON: 'true' })).toBe(false);
    expect(isTwoDaemonRequired({})).toBe(false);
  });

  it('isGoldenPolicyActive only true for exactly "1"', () => {
    expect(isGoldenPolicyActive({ MXL_CONFORMANCE_GOLDEN_POLICY: '1' })).toBe(true);
    expect(isGoldenPolicyActive({ MXL_CONFORMANCE_GOLDEN_POLICY: '0' })).toBe(false);
    expect(isGoldenPolicyActive({})).toBe(false);
  });

  it('resolveDaemonSocket honors MXL_CONFORMANCE_SOCKET then XDG_RUNTIME_DIR', () => {
    expect(resolveDaemonSocket({ MXL_CONFORMANCE_SOCKET: '/run/custom/daemon.sock' })).toBe(
      '/run/custom/daemon.sock',
    );
    expect(resolveDaemonSocket({ XDG_RUNTIME_DIR: '/run/user/1000' })).toBe(
      '/run/user/1000/mx-agent/daemon.sock',
    );
  });
});

// ---------------------------------------------------------------------------
// The golden fixture reader (every named coordinate is required)
// ---------------------------------------------------------------------------

describe('golden harness — fixture reader', () => {
  it('returns null when any required coordinate is absent', () => {
    expect(readGoldenFixture({})).toBeNull();
    // Drop one required coordinate at a time → null each time.
    for (const drop of [
      'MXL_CONFORMANCE_ROOM',
      'MXL_CONFORMANCE_TARGET_AGENT',
      'MXL_CONFORMANCE_TOOL',
      'MXL_CONFORMANCE_APPROVAL_TOOL',
      'MXL_CONFORMANCE_DENIED_TOOL',
      'MXL_CONFORMANCE_ALLOWED_COMMAND',
    ] as const) {
      const partial = { ...FULL_ENV };
      delete partial[drop];
      expect(readGoldenFixture(partial), `expected null when ${drop} is absent`).toBeNull();
    }
  });

  it('returns all coordinates when every required env var is present', () => {
    expect(readGoldenFixture(FULL_ENV)).toEqual(FULL_FIXTURE);
  });

  it('allowCwd is optional — undefined when MXL_CONFORMANCE_ALLOW_CWD is absent', () => {
    const env = { ...FULL_ENV };
    delete env['MXL_CONFORMANCE_ALLOW_CWD'];
    const fx = readGoldenFixture(env);
    expect(fx).not.toBeNull();
    expect(fx!.allowCwd).toBeUndefined();
  });

  it('coordsFromFixture omits allowCwd when absent (no `undefined` leaks into args)', () => {
    const fx: GoldenFixture = { ...FULL_FIXTURE, allowCwd: undefined };
    const coords = coordsFromFixture(fx);
    expect('allowCwd' in coords).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The binding-agnostic scenario shape
// ---------------------------------------------------------------------------

describe('golden harness — scenario (S1–S8) shape', () => {
  const coords = coordsFromFixture(FULL_FIXTURE);
  const steps = buildGoldenScenario(coords, 'unit-nonce');

  it('produces the eight ordered steps S1…S8', () => {
    expect(steps.map((s) => s.id)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']);
  });

  it('held steps are exactly S4, S5, S6 with the right operator decisions', () => {
    const held = steps.filter((s) => s.heldForApproval);
    expect(held.map((s) => s.id)).toEqual(['S4', 'S5', 'S6']);
    expect(steps.find((s) => s.id === 'S4')?.operator).toBe('approve');
    expect(steps.find((s) => s.id === 'S5')?.operator).toBe('deny');
    expect(steps.find((s) => s.id === 'S6')?.operator).toBe('approve');
  });

  it('terminal statuses match the golden policy branches', () => {
    const byId = new Map(steps.map((s) => [s.id, s]));
    expect(byId.get('S3')?.terminalStatus).toBe('ok');
    expect(byId.get('S4')?.terminalStatus).toBe('ok');
    expect(byId.get('S5')?.terminalStatus).toBe('denied');
    expect(byId.get('S5')?.terminalErrorCode).toBe('approval_denied');
    expect(byId.get('S6')?.terminalStatus).toBe('ok');
    expect(byId.get('S7')?.terminalStatus).toBe('denied');
    expect(byId.get('S7')?.terminalErrorCode).toBe('policy_denied');
    expect(byId.get('S8')?.terminalStatus).toBe('denied');
    expect(byId.get('S8')?.terminalErrorCode).toBe('policy_denied');
  });

  it('S4 and S5 (same approval tool) use DISTINCT idempotency keys so each is decided independently', () => {
    const s4 = steps.find((s) => s.id === 'S4')!.args['idempotency_key'];
    const s5 = steps.find((s) => s.id === 'S5')!.args['idempotency_key'];
    expect(typeof s4).toBe('string');
    expect(typeof s5).toBe('string');
    expect(s4).not.toBe(s5);
  });

  it('the room is NEVER carried in any step args (it comes from the session)', () => {
    for (const step of steps) {
      expect(step.args).not.toHaveProperty('room');
      expect(JSON.stringify(step.args)).not.toContain(coords.room);
    }
  });

  it('no step arg carries a secret-shaped value (Boundary A holds for inputs too)', () => {
    expect(JSON.stringify(steps)).not.toMatch(SECRET_PATTERN);
  });

  it('S6 safe args avoid the deny_args_regex patterns; S7 dangerous args trip them', () => {
    expect(SAFE_COMMAND_ARGS.join(' ')).not.toMatch(/\bcurl\b|\bssh\b|rm\s+-rf\s+\//);
    expect(DANGEROUS_COMMAND_ARGS.join(' ')).toMatch(/\bcurl\b/);
  });

  it('expectedEmissions: 5 non-held + 3 held×2 = 11 audit rows per arm', () => {
    const e = expectedEmissions(steps);
    expect(e.nonHeld).toBe(5);
    expect(e.held).toBe(6);
    expect(e.total).toBe(11);
  });
});

// ---------------------------------------------------------------------------
// runStep — three safety short-circuit paths (daemon-free, fake arm)
// ---------------------------------------------------------------------------

describe('golden harness — runStep safety paths (daemon-free, fake arm)', () => {
  const NULL_REF: AuditRef = { invocation_id: null, request_id: null, room: null, event_id: null };

  function makeArm(returns: ToolResult): GoldenArm {
    return {
      name: 'fake',
      async dispatch(_tool, _args) {
        return returns;
      },
      async resolve(_handle, _waitMs) {
        throw new Error('resolve must not be called in safety-path tests');
      },
      async close() {},
    };
  }

  const NON_HELD_STEP: GoldenStep = {
    id: 'T1',
    label: 'non-held test step',
    tool: 'mx_delegate_tool',
    args: {},
    policyBranch: 'allow',
    heldForApproval: false,
    terminalStatus: 'ok',
  };

  const HELD_STEP: GoldenStep = {
    id: 'T2',
    label: 'held test step',
    tool: 'mx_delegate_tool',
    args: {},
    policyBranch: 'requires_approval',
    heldForApproval: true,
    operator: 'approve',
    terminalStatus: 'ok',
  };

  it('non-held step: initial is terminal, resolve is never called', async () => {
    const initial = ok({ data: 'unit' }, NULL_REF);
    const { initial: i, terminal: t } = await runStep(makeArm(initial), NON_HELD_STEP);
    expect(i).toBe(initial);
    expect(t).toBe(initial);
  });

  it('non-held step: initial and terminal are the same object reference (not a copy)', async () => {
    const initial = ok(null, NULL_REF);
    const { initial: i, terminal: t } = await runStep(makeArm(initial), NON_HELD_STEP);
    expect(Object.is(i, t)).toBe(true);
  });

  it('held step but initial status is not awaiting_approval: short-circuits, resolve is never called', async () => {
    // Dispatch returns 'ok' even though the step expects a hold — simulates the daemon
    // not gating when it should. runStep must short-circuit rather than fabricate a decision.
    const wrongStatus = ok({ data: 'unit' }, NULL_REF);
    const { initial: i, terminal: t } = await runStep(makeArm(wrongStatus), HELD_STEP);
    expect(i).toBe(wrongStatus);
    expect(t).toBe(wrongStatus);
    expect(Object.is(i, t)).toBe(true);
  });

  it('held step but handle is null: short-circuits, resolve is never called', async () => {
    // awaitingApproval() requires a non-null handle string; build the degenerate case directly.
    const nullHandleResult = {
      status: 'awaiting_approval',
      result: null,
      error: null,
      handle: null,
      approval: {
        request_id: 'req-null-handle',
        risk: 'medium',
        summary: 'unit-test approval — handle intentionally null',
        expires_at: '2099-01-01T00:00:00Z',
      },
      audit_ref: NULL_REF,
    } as unknown as ToolResult;
    const { initial: i, terminal: t } = await runStep(makeArm(nullHandleResult), HELD_STEP);
    expect(i).toBe(nullHandleResult);
    expect(t).toBe(nullHandleResult);
  });
});

// ---------------------------------------------------------------------------
// countingDaemon proxy
// ---------------------------------------------------------------------------

describe('golden harness — countingDaemon proxy', () => {
  it('starts at zero before any calls', () => {
    const inner: DaemonCall = { call: async () => ({}) };
    const { count } = countingDaemon(inner);
    expect(count()).toBe(0);
  });

  it('increments the counter on each call', async () => {
    const inner: DaemonCall = { call: async () => ({}) };
    const { daemon, count } = countingDaemon(inner);
    await daemon.call('ping');
    expect(count()).toBe(1);
    await daemon.call('ping');
    expect(count()).toBe(2);
  });

  it('passes the method and params through to the inner DaemonCall and returns its result', async () => {
    const captured: Array<{ method: string; params: unknown }> = [];
    const inner: DaemonCall = {
      call: async (method, params) => {
        captured.push({ method, params });
        return 'forwarded';
      },
    };
    const { daemon } = countingDaemon(inner);
    const result = await daemon.call('agent.list', { room: '!test:localhost' });
    expect(result).toBe('forwarded');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.method).toBe('agent.list');
    expect(captured[0]?.params).toEqual({ room: '!test:localhost' });
  });

  it('two wrappers around the same inner do not share a counter', async () => {
    const inner: DaemonCall = { call: async () => ({}) };
    const a = countingDaemon(inner);
    const b = countingDaemon(inner);
    await a.daemon.call('ping');
    expect(a.count()).toBe(1);
    expect(b.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// envelopeFromCallResult
// ---------------------------------------------------------------------------

describe('golden harness — envelopeFromCallResult', () => {
  const NULL_REF: AuditRef = { invocation_id: null, request_id: null, room: null, event_id: null };

  it('returns the structuredContent typed as ToolResult', () => {
    const envelope = ok({ data: 'unit' }, NULL_REF);
    const callResult = { structuredContent: envelope } as unknown as CallToolResult;
    expect(envelopeFromCallResult(callResult)).toBe(envelope);
  });

  it('preserves exact object identity (no clone)', () => {
    const envelope = awaitingApproval('handle-42', { request_id: 'r1', risk: 'high', summary: 'test', expires_at: '2099-01-01T00:00:00Z' }, NULL_REF);
    const callResult = { structuredContent: envelope } as unknown as CallToolResult;
    expect(envelopeFromCallResult(callResult)).toBe(envelope);
  });

  it('throws when structuredContent is undefined', () => {
    const callResult = {} as unknown as CallToolResult;
    expect(() => envelopeFromCallResult(callResult)).toThrow(/structuredContent/);
  });

  it('throws when structuredContent is null', () => {
    const callResult = { structuredContent: null } as unknown as CallToolResult;
    expect(() => envelopeFromCallResult(callResult)).toThrow(/structuredContent/);
  });
});

// ---------------------------------------------------------------------------
// resolveDaemonSocket — the HOME fallback (the third resolution tier, not yet
// covered by the env-flag-readers suite above which only tests tiers 1 and 2)
// ---------------------------------------------------------------------------

describe('golden harness — resolveDaemonSocket HOME fallback', () => {
  it('falls back to $HOME/.local/share/mx-agent/daemon.sock when neither SOCKET nor XDG_RUNTIME_DIR is set', () => {
    expect(resolveDaemonSocket({ HOME: '/home/testuser' })).toBe(
      '/home/testuser/.local/share/mx-agent/daemon.sock',
    );
  });

  it('uses /root as the HOME default when HOME is also absent', () => {
    expect(resolveDaemonSocket({})).toBe('/root/.local/share/mx-agent/daemon.sock');
  });

  it('MXL_CONFORMANCE_SOCKET takes priority over XDG_RUNTIME_DIR and HOME', () => {
    expect(
      resolveDaemonSocket({
        MXL_CONFORMANCE_SOCKET: '/run/override/daemon.sock',
        XDG_RUNTIME_DIR: '/run/user/1000',
        HOME: '/home/user',
      }),
    ).toBe('/run/override/daemon.sock');
  });

  it('XDG_RUNTIME_DIR takes priority over HOME', () => {
    expect(
      resolveDaemonSocket({
        XDG_RUNTIME_DIR: '/run/user/2000',
        HOME: '/home/user',
      }),
    ).toBe('/run/user/2000/mx-agent/daemon.sock');
  });
});

// ---------------------------------------------------------------------------
// isDaemonReachable — positive case with a real temp file
// ---------------------------------------------------------------------------

describe('golden harness — isDaemonReachable (positive case via temp file)', () => {
  let tmpDir = '';
  let sockPath = '';

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mxl-golden-test-'));
    sockPath = join(tmpDir, 'daemon.sock');
    writeFileSync(sockPath, ''); // existsSync does not require a real socket
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns true when the resolved socket path exists on disk', () => {
    expect(isDaemonReachable({ MXL_CONFORMANCE_SOCKET: sockPath })).toBe(true);
  });

  it('returns false when the socket path does not exist', () => {
    expect(isDaemonReachable({ MXL_CONFORMANCE_SOCKET: join(tmpDir, 'nonexistent.sock') })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GOLDEN_REQUIRED conjunction (&&) semantics
// ---------------------------------------------------------------------------

describe('golden harness — GOLDEN_REQUIRED conjunction (&&)', () => {
  it('is false when only MXL_CONFORMANCE_TWO_DAEMON is set', () => {
    const env = { MXL_CONFORMANCE_TWO_DAEMON: '1' };
    expect(isTwoDaemonRequired(env) && isGoldenPolicyActive(env)).toBe(false);
  });

  it('is false when only MXL_CONFORMANCE_GOLDEN_POLICY is set', () => {
    const env = { MXL_CONFORMANCE_GOLDEN_POLICY: '1' };
    expect(isTwoDaemonRequired(env) && isGoldenPolicyActive(env)).toBe(false);
  });

  it('is true only when both flags are exactly "1"', () => {
    const env = { MXL_CONFORMANCE_TWO_DAEMON: '1', MXL_CONFORMANCE_GOLDEN_POLICY: '1' };
    expect(isTwoDaemonRequired(env) && isGoldenPolicyActive(env)).toBe(true);
  });

  it('is false when neither flag is set', () => {
    expect(isTwoDaemonRequired({}) && isGoldenPolicyActive({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildGoldenScenario — cwd injection
// ---------------------------------------------------------------------------

describe('golden harness — buildGoldenScenario cwd handling', () => {
  it('S6 and S7 args include cwd when coords.allowCwd is provided', () => {
    const coords = coordsFromFixture(FULL_FIXTURE);
    const steps = buildGoldenScenario(coords, 'cwd-nonce');
    const s6 = steps.find((s) => s.id === 'S6')!;
    const s7 = steps.find((s) => s.id === 'S7')!;
    expect(s6.args['cwd']).toBe(FULL_FIXTURE.allowCwd);
    expect(s7.args['cwd']).toBe(FULL_FIXTURE.allowCwd);
  });

  it('S6 and S7 args omit cwd entirely when coords.allowCwd is absent', () => {
    const coords = coordsFromFixture({ ...FULL_FIXTURE, allowCwd: undefined });
    const steps = buildGoldenScenario(coords, 'no-cwd-nonce');
    const s6 = steps.find((s) => s.id === 'S6')!;
    const s7 = steps.find((s) => s.id === 'S7')!;
    expect('cwd' in s6.args).toBe(false);
    expect('cwd' in s7.args).toBe(false);
  });

  it('non-exec steps (S1, S2, S3, S4, S5, S8) never carry a cwd field', () => {
    const coords = coordsFromFixture(FULL_FIXTURE);
    const steps = buildGoldenScenario(coords, 'cwd-check-nonce');
    const nonExec = steps.filter((s) => !['S6', 'S7'].includes(s.id));
    for (const step of nonExec) {
      expect('cwd' in step.args, `${step.id} must not carry cwd`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// buildGoldenScenario — approvalMatch targeting
// ---------------------------------------------------------------------------

describe('golden harness — buildGoldenScenario approvalMatch targeting', () => {
  const coords = coordsFromFixture(FULL_FIXTURE);
  const steps = buildGoldenScenario(coords, 'match-nonce');
  const byId = new Map(steps.map((s) => [s.id, s]));

  it('S4 approvalMatch targets the approval tool name', () => {
    expect(byId.get('S4')?.approvalMatch).toBe(FULL_FIXTURE.approvalTool);
  });

  it('S5 approvalMatch targets the approval tool name', () => {
    expect(byId.get('S5')?.approvalMatch).toBe(FULL_FIXTURE.approvalTool);
  });

  it('S6 approvalMatch targets the allowed command name', () => {
    expect(byId.get('S6')?.approvalMatch).toBe(FULL_FIXTURE.allowedCommand);
  });

  it('non-held steps (S1, S2, S3, S7, S8) have no approvalMatch', () => {
    const nonHeld = steps.filter((s) => !s.heldForApproval);
    for (const s of nonHeld) {
      expect(s.approvalMatch, `${s.id} must not have approvalMatch`).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// buildGoldenScenario — idempotency_key presence and uniqueness
// ---------------------------------------------------------------------------

describe('golden harness — buildGoldenScenario idempotency_key', () => {
  const coords = coordsFromFixture(FULL_FIXTURE);
  const steps = buildGoldenScenario(coords, 'idem-nonce');
  const byId = new Map(steps.map((s) => [s.id, s]));

  it('S1 and S2 (read-only verbs) carry no idempotency_key', () => {
    expect(byId.get('S1')?.args).not.toHaveProperty('idempotency_key');
    expect(byId.get('S2')?.args).not.toHaveProperty('idempotency_key');
  });

  it('every mutating step (S3–S8) carries a non-empty idempotency_key string', () => {
    for (const id of ['S3', 'S4', 'S5', 'S6', 'S7', 'S8']) {
      const key = byId.get(id)?.args['idempotency_key'];
      expect(typeof key, `${id}: idempotency_key must be a string`).toBe('string');
      expect((key as string).length, `${id}: idempotency_key must be non-empty`).toBeGreaterThan(0);
    }
  });

  it('all idempotency_keys within a run are mutually unique', () => {
    const keys = ['S3', 'S4', 'S5', 'S6', 'S7', 'S8'].map(
      (id) => byId.get(id)?.args['idempotency_key'] as string,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('re-building with the same nonce produces identical keys (deterministic output)', () => {
    const steps2 = buildGoldenScenario(coords, 'idem-nonce');
    for (const id of ['S3', 'S4', 'S5', 'S6', 'S7', 'S8']) {
      expect(steps2.find((s) => s.id === id)?.args['idempotency_key']).toBe(
        byId.get(id)?.args['idempotency_key'],
      );
    }
  });

  it('a different nonce produces different keys so runs do not collide on the daemon dedup store', () => {
    const steps3 = buildGoldenScenario(coords, 'other-nonce');
    for (const id of ['S3', 'S4', 'S5', 'S6', 'S7', 'S8']) {
      expect(steps3.find((s) => s.id === id)?.args['idempotency_key']).not.toBe(
        byId.get(id)?.args['idempotency_key'],
      );
    }
  });
});

// ---------------------------------------------------------------------------
// expectedEmissions edge cases
// ---------------------------------------------------------------------------

describe('golden harness — expectedEmissions edge cases', () => {
  it('zero steps → all counts are zero', () => {
    const e = expectedEmissions([]);
    expect(e.nonHeld).toBe(0);
    expect(e.held).toBe(0);
    expect(e.total).toBe(0);
  });

  it('all non-held steps → total equals step count (one row per step)', () => {
    const coords = coordsFromFixture(FULL_FIXTURE);
    const allNonHeld = buildGoldenScenario(coords, 'e-nonce').filter((s) => !s.heldForApproval);
    const e = expectedEmissions(allNonHeld);
    expect(e.held).toBe(0);
    expect(e.total).toBe(allNonHeld.length);
    expect(e.total).toBe(e.nonHeld);
  });

  it('all held steps → total equals 2 × step count (awaiting_approval row + terminal row each)', () => {
    const coords = coordsFromFixture(FULL_FIXTURE);
    const allHeld = buildGoldenScenario(coords, 'e-nonce2').filter((s) => s.heldForApproval);
    const e = expectedEmissions(allHeld);
    expect(e.nonHeld).toBe(0);
    expect(e.held).toBe(allHeld.length * 2);
    expect(e.total).toBe(allHeld.length * 2);
  });

  it('single held step → total is exactly 2', () => {
    const singleHeld: GoldenStep = {
      id: 'SX',
      label: 'synthetic held step',
      tool: 'mx_delegate_tool',
      args: {},
      policyBranch: 'requires_approval',
      heldForApproval: true,
      operator: 'approve',
      terminalStatus: 'ok',
    };
    const e = expectedEmissions([singleHeld]);
    expect(e.nonHeld).toBe(0);
    expect(e.held).toBe(2);
    expect(e.total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// SECRET_PATTERN coverage — positive matches + clean-fixture non-matches
// ---------------------------------------------------------------------------

describe('golden harness — SECRET_PATTERN coverage', () => {
  it('matches MATRIX_ env-var prefix', () => {
    expect('MATRIX_ACCESS_TOKEN=syt_abc').toMatch(SECRET_PATTERN);
  });

  it('matches MX_AGENT_ daemon config key prefix', () => {
    expect('MX_AGENT_SIGNING_KEY=abc123').toMatch(SECRET_PATTERN);
  });

  it('matches syt_[a-z] Matrix access token format', () => {
    expect('syt_abc_longtoken').toMatch(SECRET_PATTERN);
  });

  it('does not match syt_ followed by a non-lowercase character', () => {
    expect('syt_0ABCDEF').not.toMatch(SECRET_PATTERN);
    expect('syt_').not.toMatch(SECRET_PATTERN);
  });

  it('matches ghp_ GitHub personal-access-token prefix', () => {
    expect('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcde').toMatch(SECRET_PATTERN);
  });

  it('matches xoxb- Slack bot-token prefix', () => {
    expect('xoxb-123456789-987654321-ABCDEF').toMatch(SECRET_PATTERN);
  });

  it('matches xoxp- Slack user-token prefix', () => {
    expect('xoxp-123456789-987654321-ABCDEF').toMatch(SECRET_PATTERN);
  });

  it('does not match clean test-fixture values used by FULL_FIXTURE and the scenario', () => {
    expect('!golden:localhost').not.toMatch(SECRET_PATTERN);
    expect('agent-b').not.toMatch(SECRET_PATTERN);
    expect('run_tests@1.0.0').not.toMatch(SECRET_PATTERN);
    expect('deploy@1.0.0').not.toMatch(SECRET_PATTERN);
    expect('echo').not.toMatch(SECRET_PATTERN);
    expect('mx-loom-golden-exec-marker').not.toMatch(SECRET_PATTERN);
    expect('/tmp/mxl/b/data').not.toMatch(SECRET_PATTERN);
  });

  it('does not match bare prefix stems without the required trailing separator', () => {
    expect('MATRIX').not.toMatch(SECRET_PATTERN); // needs trailing _
    expect('MX_AGENT').not.toMatch(SECRET_PATTERN); // needs trailing _
  });
});

// ---------------------------------------------------------------------------
// readGoldenFixture — empty-string handling (falsy, not just absent)
// ---------------------------------------------------------------------------

describe('golden harness — readGoldenFixture empty-string handling', () => {
  const required = [
    'MXL_CONFORMANCE_ROOM',
    'MXL_CONFORMANCE_TARGET_AGENT',
    'MXL_CONFORMANCE_TOOL',
    'MXL_CONFORMANCE_APPROVAL_TOOL',
    'MXL_CONFORMANCE_DENIED_TOOL',
    'MXL_CONFORMANCE_ALLOWED_COMMAND',
  ] as const;

  it('returns null when any required coordinate is set to an empty string', () => {
    for (const key of required) {
      const env = { ...FULL_ENV, [key]: '' };
      expect(readGoldenFixture(env), `expected null when ${key} is empty string`).toBeNull();
    }
  });

  it('returns a fixture when only MXL_CONFORMANCE_ALLOW_CWD is empty (it is optional)', () => {
    const env = { ...FULL_ENV, MXL_CONFORMANCE_ALLOW_CWD: '' };
    // allowCwd is optional — an empty-string env var collapses to undefined via the falsy check;
    // the fixture still resolves because all required coords are present.
    const fixture = readGoldenFixture(env);
    // The implementation stores env[key] directly, so '' is allowed as an optional value.
    // What matters is that the REQUIRED fields being empty cause a null return.
    // Since MXL_CONFORMANCE_ALLOW_CWD is optional, an empty value must not break resolution.
    expect(fixture).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// coordsFromFixture — complete field projection (every field, not just allowCwd)
// ---------------------------------------------------------------------------

describe('golden harness — coordsFromFixture complete field projection', () => {
  it('maps every required fixture field to the matching coords field when allowCwd is present', () => {
    const coords = coordsFromFixture(FULL_FIXTURE);
    expect(coords.room).toBe(FULL_FIXTURE.room);
    expect(coords.targetAgentId).toBe(FULL_FIXTURE.targetAgentId);
    expect(coords.allowTool).toBe(FULL_FIXTURE.allowTool);
    expect(coords.approvalTool).toBe(FULL_FIXTURE.approvalTool);
    expect(coords.deniedTool).toBe(FULL_FIXTURE.deniedTool);
    expect(coords.allowedCommand).toBe(FULL_FIXTURE.allowedCommand);
    expect(coords.allowCwd).toBe(FULL_FIXTURE.allowCwd);
  });

  it('coords object contains exactly the expected keys when allowCwd is present', () => {
    const coords = coordsFromFixture(FULL_FIXTURE);
    const keys = Object.keys(coords).sort();
    expect(keys).toEqual(
      ['allowCwd', 'allowTool', 'allowedCommand', 'approvalTool', 'deniedTool', 'room', 'targetAgentId'].sort(),
    );
  });

  it('coords object contains exactly the expected keys when allowCwd is absent', () => {
    const coords = coordsFromFixture({ ...FULL_FIXTURE, allowCwd: undefined });
    const keys = Object.keys(coords).sort();
    expect(keys).toEqual(
      ['allowTool', 'allowedCommand', 'approvalTool', 'deniedTool', 'room', 'targetAgentId'].sort(),
    );
  });

  it('projection is exact — no extra keys leak in (no prototype pollution)', () => {
    const coords = coordsFromFixture(FULL_FIXTURE) as unknown as Record<string, unknown>;
    // No daemon RPC names, no secret fields, no internal harness keys.
    expect('daemon' in coords).toBe(false);
    expect('socket' in coords).toBe(false);
    expect('correlationId' in coords).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runStep — resolve called with exact handle + GOLDEN_RESOLVE_BUDGET_MS
// ---------------------------------------------------------------------------

describe('golden harness — runStep resolve call arguments', () => {
  const NULL_REF: AuditRef = { invocation_id: null, request_id: null, room: null, event_id: null };

  it('for a held step without an operator, resolve receives the exact handle from initial + GOLDEN_RESOLVE_BUDGET_MS', async () => {
    // A held step with operator=undefined: no external script is invoked (neither
    // approvePending nor denyPending fires), but the resolve leg still runs. This
    // verifies that runStep passes the right (handle, budget) pair to the arm.
    const handle = 'inv_resolve_args_test_42';
    const initial = awaitingApproval(
      handle,
      { request_id: 'req-resolve-args', risk: 'low', summary: 'resolve-args test hold', expires_at: '2099-01-01T00:00:00Z' },
      NULL_REF,
    );
    const terminal = ok(null, NULL_REF);
    const resolveArgs: Array<{ handle: string; waitMs: number }> = [];

    const arm: GoldenArm = {
      name: 'fake-resolve-args',
      async dispatch() {
        return initial;
      },
      async resolve(h, w) {
        resolveArgs.push({ handle: h, waitMs: w });
        return terminal;
      },
      async close() {},
    };

    const step: GoldenStep = {
      id: 'TR',
      label: 'resolve-args test step',
      tool: 'mx_delegate_tool',
      args: {},
      policyBranch: 'requires_approval',
      heldForApproval: true,
      // operator intentionally omitted — no external decision script invoked
      terminalStatus: 'ok',
    };

    const outcome = await runStep(arm, step);
    expect(outcome.initial).toBe(initial);
    expect(outcome.terminal).toBe(terminal);
    // The resolve must be called exactly once with the original handle + the budget constant.
    expect(resolveArgs).toHaveLength(1);
    expect(resolveArgs[0]?.handle).toBe(handle);
    expect(resolveArgs[0]?.waitMs).toBe(GOLDEN_RESOLVE_BUDGET_MS);
  });

  it('for a non-held step, resolve is never invoked (no side effects on the resolve path)', async () => {
    let resolveCalled = false;
    const result = ok({ data: 'non-held' }, NULL_REF);
    const arm: GoldenArm = {
      name: 'fake-no-resolve',
      async dispatch() {
        return result;
      },
      async resolve() {
        resolveCalled = true;
        return result;
      },
      async close() {},
    };

    const step: GoldenStep = {
      id: 'TNR',
      label: 'no-resolve test step',
      tool: 'mx_find_agents',
      args: {},
      policyBranch: 'local read',
      heldForApproval: false,
      terminalStatus: 'ok',
    };

    const outcome = await runStep(arm, step);
    expect(outcome.initial).toBe(result);
    expect(outcome.terminal).toBe(result);
    expect(resolveCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Timing budget constants — pinned so accidental changes are caught
// ---------------------------------------------------------------------------

describe('golden harness — timing budget constants', () => {
  it('GOLDEN_RESOLVE_BUDGET_MS is 120 s (matches await-result.conformance.test.ts AC2)', () => {
    expect(GOLDEN_RESOLVE_BUDGET_MS).toBe(120_000);
  });

  it('OPERATOR_DECISION_TIMEOUT_MS is 90 s', () => {
    expect(OPERATOR_DECISION_TIMEOUT_MS).toBe(90_000);
  });

  it('the operator timeout is shorter than the resolve budget (operator must decide before the resolver times out)', () => {
    expect(OPERATOR_DECISION_TIMEOUT_MS).toBeLessThan(GOLDEN_RESOLVE_BUDGET_MS);
  });
});

// ---------------------------------------------------------------------------
// buildGoldenScenario — idempotency key format
// ---------------------------------------------------------------------------

describe('golden harness — buildGoldenScenario idempotency key format', () => {
  const coords = coordsFromFixture(FULL_FIXTURE);
  const nonce = 'test-nonce-abc123-xyz';
  const steps = buildGoldenScenario(coords, nonce);

  it('every mutating step key embeds the nonce (cross-run daemon-dedup isolation)', () => {
    for (const id of ['S3', 'S4', 'S5', 'S6', 'S7', 'S8']) {
      const key = steps.find((s) => s.id === id)?.args['idempotency_key'] as string;
      expect(key, `${id}: key must contain the nonce`).toContain(nonce);
    }
  });

  it('every mutating step key starts with the mxl-golden- prefix (identifies the golden runner)', () => {
    for (const id of ['S3', 'S4', 'S5', 'S6', 'S7', 'S8']) {
      const key = steps.find((s) => s.id === id)?.args['idempotency_key'] as string;
      expect(key, `${id}: key must have mxl-golden- prefix`).toMatch(/^mxl-golden-/);
    }
  });

  it('keys are non-empty strings longer than the prefix alone (suffix disambiguates per step)', () => {
    const prefix = 'mxl-golden-';
    for (const id of ['S3', 'S4', 'S5', 'S6', 'S7', 'S8']) {
      const key = steps.find((s) => s.id === id)?.args['idempotency_key'] as string;
      expect(key.length).toBeGreaterThan(prefix.length);
    }
  });
});

// ---------------------------------------------------------------------------
// buildGoldenScenario — step field invariants
// ---------------------------------------------------------------------------

describe('golden harness — buildGoldenScenario step field invariants', () => {
  const coords = coordsFromFixture(FULL_FIXTURE);
  const steps = buildGoldenScenario(coords, 'invariant-nonce');

  it('every step has all required fields as the correct runtime type', () => {
    for (const step of steps) {
      expect(typeof step.id, `${step.id}: id`).toBe('string');
      expect(step.id.length, `${step.id}: id non-empty`).toBeGreaterThan(0);
      expect(typeof step.label, `${step.id}: label`).toBe('string');
      expect(step.label.length, `${step.id}: label non-empty`).toBeGreaterThan(0);
      expect(typeof step.tool, `${step.id}: tool`).toBe('string');
      expect(step.tool.length, `${step.id}: tool non-empty`).toBeGreaterThan(0);
      expect(step.args !== null && typeof step.args, `${step.id}: args is object`).toBe('object');
      expect(typeof step.policyBranch, `${step.id}: policyBranch`).toBe('string');
      expect(typeof step.heldForApproval, `${step.id}: heldForApproval`).toBe('boolean');
      expect(typeof step.terminalStatus, `${step.id}: terminalStatus`).toBe('string');
    }
  });

  it('every step tool name is an mx_* verb (no authority verb reaches the model surface)', () => {
    for (const step of steps) {
      expect(step.tool, `${step.id}: tool must start with mx_`).toMatch(/^mx_/);
    }
  });

  it('every held step has an operator field set to approve or deny', () => {
    for (const step of steps.filter((s) => s.heldForApproval)) {
      expect(['approve', 'deny'], `${step.id}: held step must have approve or deny operator`).toContain(step.operator);
    }
  });

  it('non-held steps have no operator field', () => {
    for (const step of steps.filter((s) => !s.heldForApproval)) {
      expect(step.operator, `${step.id}: non-held step must not have an operator`).toBeUndefined();
    }
  });

  it('denied-terminal steps carry a terminalErrorCode; ok-terminal steps do not', () => {
    for (const step of steps) {
      if (step.terminalStatus === 'denied') {
        expect(step.terminalErrorCode, `${step.id}: denied step must carry terminalErrorCode`).toBeDefined();
        expect(typeof step.terminalErrorCode).toBe('string');
      } else if (step.terminalStatus === 'ok') {
        expect(step.terminalErrorCode, `${step.id}: ok step must not carry terminalErrorCode`).toBeUndefined();
      }
    }
  });

  it('S6 and S7 are the only exec (mx_run_command) steps; all others delegate or discover', () => {
    const execSteps = steps.filter((s) => s.tool === 'mx_run_command').map((s) => s.id);
    expect(execSteps).toEqual(['S6', 'S7']);
  });
});

// ---------------------------------------------------------------------------
// Command arg arrays — content and type guards
// ---------------------------------------------------------------------------

describe('golden scenario — command arg arrays', () => {
  it('SAFE_COMMAND_ARGS is a non-empty array of strings', () => {
    expect(Array.isArray(SAFE_COMMAND_ARGS)).toBe(true);
    expect(SAFE_COMMAND_ARGS.length).toBeGreaterThan(0);
    for (const arg of SAFE_COMMAND_ARGS) {
      expect(typeof arg, `SAFE_COMMAND_ARGS element "${arg}" must be string`).toBe('string');
    }
  });

  it('DANGEROUS_COMMAND_ARGS is a non-empty array of strings', () => {
    expect(Array.isArray(DANGEROUS_COMMAND_ARGS)).toBe(true);
    expect(DANGEROUS_COMMAND_ARGS.length).toBeGreaterThan(0);
    for (const arg of DANGEROUS_COMMAND_ARGS) {
      expect(typeof arg, `DANGEROUS_COMMAND_ARGS element "${arg}" must be string`).toBe('string');
    }
  });

  it('SAFE_COMMAND_ARGS do not contain any secret-shaped value (Boundary A holds for exec args too)', () => {
    expect(SAFE_COMMAND_ARGS.join(' ')).not.toMatch(SECRET_PATTERN);
  });

  it('DANGEROUS_COMMAND_ARGS do not contain secret-shaped values (danger is in args-regex match, not credential leakage)', () => {
    expect(DANGEROUS_COMMAND_ARGS.join(' ')).not.toMatch(SECRET_PATTERN);
  });
});

// ---------------------------------------------------------------------------
// Secret-free test fixtures (sanity guard — the test data itself must be clean)
// ---------------------------------------------------------------------------

describe('golden harness — test fixtures are secret-free', () => {
  it('FULL_FIXTURE values contain no secret-shaped content', () => {
    expect(JSON.stringify(FULL_FIXTURE)).not.toMatch(SECRET_PATTERN);
  });

  it('FULL_ENV values contain no secret-shaped content', () => {
    expect(JSON.stringify(FULL_ENV)).not.toMatch(SECRET_PATTERN);
  });
});
