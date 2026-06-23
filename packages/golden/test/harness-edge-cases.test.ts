/**
 * Edge-case tests for `_golden-harness.ts` helpers that are not covered by the main
 * `golden-harness.test.ts` suite (T114 / #22).
 *
 * Covered here:
 *  - `countingDaemon` when the inner `DaemonCall` rejects (counter still increments).
 *  - `runStep` when `arm.dispatch` throws (the error propagates; resolve is never called).
 *  - `goldenPrereqError` boundary: demanded + reachable + fixture present returns null
 *    (re-stated as a property-based check over the three-field conjunction).
 *  - `readGoldenFixture` / `coordsFromFixture` composition invariant: a fixture
 *    produced by `readGoldenFixture` feeds `coordsFromFixture` without data loss.
 *  - `envelopeFromCallResult` when structuredContent is a truthy non-object (passes
 *    through as-is; the caller must validate separately).
 *
 * All tests are daemon-free and deterministic.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ok, type AuditRef, type DaemonCall, type ToolResult } from '@mx-loom/registry';
import { describe, expect, it } from 'vitest';

import {
  coordsFromFixture,
  countingDaemon,
  envelopeFromCallResult,
  goldenPrereqError,
  readGoldenFixture,
  runStep,
  type GoldenArm,
  type GoldenFixture,
} from './_golden-harness.js';
import type { GoldenStep } from './scenario.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NULL_REF: AuditRef = { invocation_id: null, request_id: null, room: null, event_id: null };

const FULL_FIXTURE: GoldenFixture = {
  room: '!golden-edge:localhost',
  targetAgentId: 'agent-edge-b',
  allowTool: 'run_tests@1.0.0',
  approvalTool: 'deploy@1.0.0',
  deniedTool: 'rm_rf@1.0.0',
  allowedCommand: 'echo',
  allowCwd: '/tmp/mxl/edge/data',
};

const FULL_ENV: NodeJS.ProcessEnv = {
  MXL_CONFORMANCE_ROOM: FULL_FIXTURE.room,
  MXL_CONFORMANCE_TARGET_AGENT: FULL_FIXTURE.targetAgentId,
  MXL_CONFORMANCE_TOOL: FULL_FIXTURE.allowTool,
  MXL_CONFORMANCE_APPROVAL_TOOL: FULL_FIXTURE.approvalTool,
  MXL_CONFORMANCE_DENIED_TOOL: FULL_FIXTURE.deniedTool,
  MXL_CONFORMANCE_ALLOWED_COMMAND: FULL_FIXTURE.allowedCommand,
  MXL_CONFORMANCE_ALLOW_CWD: FULL_FIXTURE.allowCwd,
};

// ---------------------------------------------------------------------------
// countingDaemon — reject path: the counter increments BEFORE the inner call
// ---------------------------------------------------------------------------

describe('golden harness — countingDaemon reject path', () => {
  it('counter increments even when the inner call rejects (n++ runs before the inner call)', async () => {
    const inner: DaemonCall = {
      call: async () => {
        throw new Error('inner rejected intentionally');
      },
    };
    const { daemon, count } = countingDaemon(inner);

    await expect(daemon.call('ping')).rejects.toThrow('inner rejected intentionally');
    // n += 1 executes before `return inner.call(...)` propagates the rejection.
    expect(count()).toBe(1);
  });

  it('each rejected call increments the counter independently', async () => {
    let callCount = 0;
    const inner: DaemonCall = {
      call: async () => {
        callCount += 1;
        throw new Error(`rejection #${callCount}`);
      },
    };
    const { daemon, count } = countingDaemon(inner);

    await expect(daemon.call('a')).rejects.toThrow('rejection #1');
    await expect(daemon.call('b')).rejects.toThrow('rejection #2');
    expect(count()).toBe(2);
  });

  it('a mixed sequence of successes and rejections yields the correct total count', async () => {
    let n = 0;
    const inner: DaemonCall = {
      call: async () => {
        n += 1;
        if (n % 2 === 0) throw new Error('even');
        return 'ok';
      },
    };
    const { daemon, count } = countingDaemon(inner);

    const p1 = daemon.call('one');   // n=1, success
    const p2 = daemon.call('two');   // n=2, rejects
    const p3 = daemon.call('three'); // n=3, success

    await expect(p1).resolves.toBe('ok');
    await expect(p2).rejects.toThrow('even');
    await expect(p3).resolves.toBe('ok');
    expect(count()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// runStep — error propagation: dispatch throws → runStep rejects, resolve not called
// ---------------------------------------------------------------------------

describe('golden harness — runStep error propagation from dispatch', () => {
  const NON_HELD_STEP: GoldenStep = {
    id: 'ERR1',
    label: 'error propagation test step (non-held)',
    tool: 'mx_find_agents',
    args: {},
    policyBranch: 'local read',
    heldForApproval: false,
    terminalStatus: 'ok',
  };

  const HELD_STEP: GoldenStep = {
    id: 'ERR2',
    label: 'error propagation test step (held)',
    tool: 'mx_delegate_tool',
    args: {},
    policyBranch: 'requires_approval',
    heldForApproval: true,
    operator: 'approve',
    terminalStatus: 'ok',
  };

  it('for a non-held step, dispatch throws → runStep rejects with the same error', async () => {
    let resolveCalled = false;
    const arm: GoldenArm = {
      name: 'throw-on-dispatch',
      async dispatch() {
        throw new Error('dispatch failed for non-held step');
      },
      async resolve() {
        resolveCalled = true;
        return ok(null, NULL_REF);
      },
      async close() {},
    };

    await expect(runStep(arm, NON_HELD_STEP)).rejects.toThrow('dispatch failed for non-held step');
    expect(resolveCalled).toBe(false);
  });

  it('for a held step, dispatch throws → runStep rejects before any resolve call', async () => {
    let resolveCalled = false;
    const arm: GoldenArm = {
      name: 'throw-on-dispatch-held',
      async dispatch() {
        throw new Error('dispatch failed for held step');
      },
      async resolve() {
        resolveCalled = true;
        return ok(null, NULL_REF);
      },
      async close() {},
    };

    await expect(runStep(arm, HELD_STEP)).rejects.toThrow('dispatch failed for held step');
    expect(resolveCalled).toBe(false);
  });

  it('the rejection message is forwarded faithfully (not wrapped or swallowed)', async () => {
    const DISTINCTIVE_MSG = 'mxl-golden-test-distinctively-shaped-error-message-abc';
    const arm: GoldenArm = {
      name: 'error-fidelity',
      async dispatch() {
        throw new Error(DISTINCTIVE_MSG);
      },
      async resolve() {
        return ok(null, NULL_REF);
      },
      async close() {},
    };

    await expect(runStep(arm, NON_HELD_STEP)).rejects.toThrow(DISTINCTIVE_MSG);
  });
});

// ---------------------------------------------------------------------------
// goldenPrereqError — the three-field conjunction fully controls the decision
// ---------------------------------------------------------------------------

describe('golden harness — goldenPrereqError full decision table', () => {
  it('required=F, reachable=F, fixture=null → null (not demanded: always clean skip)', () => {
    expect(goldenPrereqError({ required: false, reachable: false, fixture: null })).toBeNull();
  });

  it('required=F, reachable=F, fixture=full → null (not demanded: no-op)', () => {
    expect(goldenPrereqError({ required: false, reachable: false, fixture: FULL_FIXTURE })).toBeNull();
  });

  it('required=F, reachable=T, fixture=null → null (not demanded: reachability irrelevant)', () => {
    expect(goldenPrereqError({ required: false, reachable: true, fixture: null })).toBeNull();
  });

  it('required=F, reachable=T, fixture=full → null (not demanded: perfect conditions irrelevant)', () => {
    expect(goldenPrereqError({ required: false, reachable: true, fixture: FULL_FIXTURE })).toBeNull();
  });

  it('required=T, reachable=F, fixture=null → Error (demanded + unreachable)', () => {
    expect(goldenPrereqError({ required: true, reachable: false, fixture: null })).toBeInstanceOf(Error);
  });

  it('required=T, reachable=F, fixture=full → Error (daemon check takes priority over fixture)', () => {
    // If the daemon is unreachable, the fixture being ready does not matter —
    // there is nothing to run the scenario against.
    expect(goldenPrereqError({ required: true, reachable: false, fixture: FULL_FIXTURE })).toBeInstanceOf(Error);
  });

  it('required=T, reachable=T, fixture=null → Error (demanded + fixture incomplete)', () => {
    expect(goldenPrereqError({ required: true, reachable: true, fixture: null })).toBeInstanceOf(Error);
  });

  it('required=T, reachable=T, fixture=full → null (all conditions met, suite runs)', () => {
    expect(goldenPrereqError({ required: true, reachable: true, fixture: FULL_FIXTURE })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readGoldenFixture + coordsFromFixture composition: no data loss
// ---------------------------------------------------------------------------

describe('golden harness — readGoldenFixture + coordsFromFixture composition', () => {
  it('a fixture produced by readGoldenFixture feeds coordsFromFixture with no data loss', () => {
    const fixture = readGoldenFixture(FULL_ENV);
    expect(fixture).not.toBeNull();
    const coords = coordsFromFixture(fixture!);

    expect(coords.room).toBe(fixture!.room);
    expect(coords.targetAgentId).toBe(fixture!.targetAgentId);
    expect(coords.allowTool).toBe(fixture!.allowTool);
    expect(coords.approvalTool).toBe(fixture!.approvalTool);
    expect(coords.deniedTool).toBe(fixture!.deniedTool);
    expect(coords.allowedCommand).toBe(fixture!.allowedCommand);
    expect(coords.allowCwd).toBe(fixture!.allowCwd);
  });

  it('when MXL_CONFORMANCE_ALLOW_CWD is absent, coordsFromFixture also omits allowCwd', () => {
    const env = { ...FULL_ENV };
    delete env['MXL_CONFORMANCE_ALLOW_CWD'];
    const fixture = readGoldenFixture(env);
    expect(fixture).not.toBeNull();
    const coords = coordsFromFixture(fixture!);
    expect(coords.allowCwd).toBeUndefined();
    expect('allowCwd' in coords).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// envelopeFromCallResult — truthy non-null structuredContent passes through
// ---------------------------------------------------------------------------

describe('golden harness — envelopeFromCallResult truthy non-null structuredContent', () => {
  it('a valid ToolResult structuredContent is returned as-is (object identity preserved)', () => {
    const envelope: ToolResult = ok({ payload: 'edge-case-test' }, NULL_REF);
    const callResult = { structuredContent: envelope } as unknown as CallToolResult;
    const result = envelopeFromCallResult(callResult);
    expect(Object.is(result, envelope)).toBe(true);
  });

  it('any truthy structuredContent (incl. a plain object) is cast and returned without throwing', () => {
    // The function only guards null/undefined; additional type validation
    // (validateEnvelope) is the caller's responsibility. This test pins that
    // non-null non-undefined values never trigger the guard.
    const plain = { status: 'ok', result: null, error: null, handle: null, approval: null,
      audit_ref: NULL_REF } as unknown as CallToolResult;
    const callResult = { structuredContent: plain } as unknown as CallToolResult;
    expect(() => envelopeFromCallResult(callResult)).not.toThrow();
    expect(envelopeFromCallResult(callResult)).toBe(plain);
  });

  it('throws with a `structuredContent` mention when structuredContent is undefined', () => {
    expect(() => envelopeFromCallResult({} as unknown as CallToolResult)).toThrow(/structuredContent/);
  });

  it('throws with a `structuredContent` mention when structuredContent is null', () => {
    expect(() =>
      envelopeFromCallResult({ structuredContent: null } as unknown as CallToolResult),
    ).toThrow(/structuredContent/);
  });
});

// ---------------------------------------------------------------------------
// goldenPrereqError — unreachable-daemon error message content
// ---------------------------------------------------------------------------

describe('golden harness — goldenPrereqError unreachable-daemon error message', () => {
  const err = goldenPrereqError({ required: true, reachable: false, fixture: FULL_FIXTURE });

  it('is an Error instance', () => {
    expect(err).toBeInstanceOf(Error);
  });

  it('message contains FAIL (uppercase, asserting failure not skip)', () => {
    expect(err?.message).toMatch(/FAIL/);
  });

  it('message names both required env flags so the developer knows what to set', () => {
    expect(err?.message).toContain('MXL_CONFORMANCE_TWO_DAEMON');
    expect(err?.message).toContain('MXL_CONFORMANCE_GOLDEN_POLICY');
  });
});

// ---------------------------------------------------------------------------
// goldenPrereqError — incomplete-fixture error message content
// ---------------------------------------------------------------------------

describe('golden harness — goldenPrereqError incomplete-fixture error message', () => {
  const err = goldenPrereqError({ required: true, reachable: true, fixture: null });

  it('is an Error instance', () => {
    expect(err).toBeInstanceOf(Error);
  });

  it('message names all required golden coordinates', () => {
    expect(err?.message).toContain('MXL_CONFORMANCE_ROOM');
    expect(err?.message).toContain('MXL_CONFORMANCE_TARGET_AGENT');
    expect(err?.message).toContain('MXL_CONFORMANCE_TOOL');
    expect(err?.message).toContain('MXL_CONFORMANCE_APPROVAL_TOOL');
    expect(err?.message).toContain('MXL_CONFORMANCE_DENIED_TOOL');
    expect(err?.message).toContain('MXL_CONFORMANCE_ALLOWED_COMMAND');
  });
});
