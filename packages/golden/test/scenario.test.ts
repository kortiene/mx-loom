/**
 * Unit tests for the binding-agnostic scenario module (T114 / #22).
 *
 * `golden-harness.test.ts` covers the SHAPE invariants (step ids, heldForApproval
 * flags, idempotency-key uniqueness, SECRET_PATTERN, etc.). This file covers the
 * CONTENT: the exact arg values each step passes to the binding, so the scenario is
 * authoritatively pinned to the golden fixture coords — a typo (e.g. `agent_id`
 * instead of `agent` for delegation verbs, or swapped tool names) fails here rather
 * than producing a subtly wrong test that still "passes".
 *
 * All tests are daemon-free and deterministic (pure function inputs).
 */
import { describe, expect, it } from 'vitest';

import {
  DANGEROUS_COMMAND_ARGS,
  SAFE_COMMAND_ARGS,
  buildGoldenScenario,
  expectedEmissions,
  type GoldenStep,
  type ScenarioCoords,
} from './scenario.js';

// ---------------------------------------------------------------------------
// Fixture — distinct values per coord so misuse is detectable
// ---------------------------------------------------------------------------

const COORDS: ScenarioCoords = {
  room: '!test-room-scenario:localhost',
  targetAgentId: 'agent-target-01',
  allowTool: 'run_tests@1.0.0',
  approvalTool: 'deploy@2.0.0',
  deniedTool: 'rm_rf@0.1.0',
  allowedCommand: 'echo',
  allowCwd: '/workspace/golden-data',
};

const COORDS_NO_CWD: ScenarioCoords = { ...COORDS, allowCwd: undefined };
const NONCE = 'unit-content-nonce';

// ---------------------------------------------------------------------------
// S1 — mx_find_agents (capability/tool filter)
// ---------------------------------------------------------------------------

describe('scenario — S1 (mx_find_agents) arg content', () => {
  const s1 = buildGoldenScenario(COORDS, NONCE).find((s) => s.id === 'S1')!;

  it('S1 tool is mx_find_agents', () => {
    expect(s1.tool).toBe('mx_find_agents');
  });

  it('S1 filters by `tool` using coords.allowTool', () => {
    expect(s1.args['tool']).toBe(COORDS.allowTool);
  });

  it('S1 has no `agent_id` field (tool filter, not agent inspection)', () => {
    expect(s1.args).not.toHaveProperty('agent_id');
  });

  it('S1 has no `agent` field (not a delegation verb)', () => {
    expect(s1.args).not.toHaveProperty('agent');
  });

  it('S1 has no idempotency_key (read-only verb)', () => {
    expect(s1.args).not.toHaveProperty('idempotency_key');
  });

  it('S1 is not held for approval', () => {
    expect(s1.heldForApproval).toBe(false);
  });

  it('S1 terminal status is ok', () => {
    expect(s1.terminalStatus).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// S2 — mx_describe_agent(B)
// ---------------------------------------------------------------------------

describe('scenario — S2 (mx_describe_agent) arg content', () => {
  const s2 = buildGoldenScenario(COORDS, NONCE).find((s) => s.id === 'S2')!;

  it('S2 tool is mx_describe_agent', () => {
    expect(s2.tool).toBe('mx_describe_agent');
  });

  it('S2 targets the fixture targetAgentId via agent_id', () => {
    expect(s2.args['agent_id']).toBe(COORDS.targetAgentId);
  });

  it('S2 has no `tool` field (inspection, not tool-filter)', () => {
    expect(s2.args).not.toHaveProperty('tool');
  });

  it('S2 has no `agent` field (not a delegation/exec verb)', () => {
    expect(s2.args).not.toHaveProperty('agent');
  });

  it('S2 has no idempotency_key (read-only verb)', () => {
    expect(s2.args).not.toHaveProperty('idempotency_key');
  });

  it('S2 is not held for approval', () => {
    expect(s2.heldForApproval).toBe(false);
  });

  it('S2 terminal status is ok', () => {
    expect(s2.terminalStatus).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// S3 — mx_delegate_tool(allowTool), ungated
// ---------------------------------------------------------------------------

describe('scenario — S3 (mx_delegate_tool, ungated allow) arg content', () => {
  const s3 = buildGoldenScenario(COORDS, NONCE).find((s) => s.id === 'S3')!;

  it('S3 tool is mx_delegate_tool', () => {
    expect(s3.tool).toBe('mx_delegate_tool');
  });

  it('S3 `agent` is the target agent (not agent_id)', () => {
    expect(s3.args['agent']).toBe(COORDS.targetAgentId);
    expect(s3.args).not.toHaveProperty('agent_id');
  });

  it('S3 delegates coords.allowTool', () => {
    expect(s3.args['tool']).toBe(COORDS.allowTool);
  });

  it('S3 inner `args` is a plain object containing a non-empty `package` string', () => {
    const inner = s3.args['args'] as Record<string, unknown>;
    expect(inner !== null && typeof inner === 'object').toBe(true);
    expect(typeof inner['package']).toBe('string');
    expect((inner['package'] as string).length).toBeGreaterThan(0);
  });

  it('S3 inner `args` does NOT carry the deniedTool or approvalTool name (no tool confusion)', () => {
    const json = JSON.stringify(s3.args['args']);
    expect(json).not.toContain(COORDS.deniedTool);
    expect(json).not.toContain(COORDS.approvalTool);
  });

  it('S3 is not held for approval', () => {
    expect(s3.heldForApproval).toBe(false);
  });

  it('S3 terminal status is ok', () => {
    expect(s3.terminalStatus).toBe('ok');
  });

  it('S3 carries an idempotency_key (mutating verb)', () => {
    expect(typeof s3.args['idempotency_key']).toBe('string');
    expect((s3.args['idempotency_key'] as string).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// S4 — mx_delegate_tool(approvalTool), held → approve → ok
// ---------------------------------------------------------------------------

describe('scenario — S4 (mx_delegate_tool, approval-gated, approve) arg content', () => {
  const steps = buildGoldenScenario(COORDS, NONCE);
  const s4 = steps.find((s) => s.id === 'S4')!;

  it('S4 tool is mx_delegate_tool', () => {
    expect(s4.tool).toBe('mx_delegate_tool');
  });

  it('S4 delegates coords.approvalTool (not allowTool or deniedTool)', () => {
    expect(s4.args['tool']).toBe(COORDS.approvalTool);
    expect(s4.args['tool']).not.toBe(COORDS.allowTool);
    expect(s4.args['tool']).not.toBe(COORDS.deniedTool);
  });

  it('S4 `agent` is the target agent', () => {
    expect(s4.args['agent']).toBe(COORDS.targetAgentId);
  });

  it('S4 inner args is an empty object (no app-level payload for the approval tool)', () => {
    expect(s4.args['args']).toEqual({});
  });

  it('S4 is held for approval', () => {
    expect(s4.heldForApproval).toBe(true);
  });

  it('S4 operator is approve', () => {
    expect(s4.operator).toBe('approve');
  });

  it('S4 approvalMatch targets the approval tool name', () => {
    expect(s4.approvalMatch).toBe(COORDS.approvalTool);
  });

  it('S4 terminal status is ok', () => {
    expect(s4.terminalStatus).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// S5 — mx_delegate_tool(approvalTool) again, held → deny → denied(approval_denied)
// ---------------------------------------------------------------------------

describe('scenario — S5 (mx_delegate_tool, approval-gated, deny) arg content', () => {
  const steps = buildGoldenScenario(COORDS, NONCE);
  const s4 = steps.find((s) => s.id === 'S4')!;
  const s5 = steps.find((s) => s.id === 'S5')!;

  it('S5 tool is mx_delegate_tool', () => {
    expect(s5.tool).toBe('mx_delegate_tool');
  });

  it('S5 also delegates coords.approvalTool (same as S4)', () => {
    expect(s5.args['tool']).toBe(COORDS.approvalTool);
  });

  it('S5 `agent` is the target agent', () => {
    expect(s5.args['agent']).toBe(COORDS.targetAgentId);
  });

  it('S5 is held for approval', () => {
    expect(s5.heldForApproval).toBe(true);
  });

  it('S5 operator is deny', () => {
    expect(s5.operator).toBe('deny');
  });

  it('S5 approvalMatch targets the approval tool name', () => {
    expect(s5.approvalMatch).toBe(COORDS.approvalTool);
  });

  it('S5 terminal status is denied with approval_denied code', () => {
    expect(s5.terminalStatus).toBe('denied');
    expect(s5.terminalErrorCode).toBe('approval_denied');
  });

  it('S5 idempotency_key is DIFFERENT from S4 (each decided independently)', () => {
    expect(s5.args['idempotency_key']).not.toBe(s4.args['idempotency_key']);
  });
});

// ---------------------------------------------------------------------------
// S6 — mx_run_command(allowedCommand, safeArgs), held → approve → ok(exit_code)
// ---------------------------------------------------------------------------

describe('scenario — S6 (mx_run_command, approved exec) arg content', () => {
  const s6 = buildGoldenScenario(COORDS, NONCE).find((s) => s.id === 'S6')!;

  it('S6 tool is mx_run_command', () => {
    expect(s6.tool).toBe('mx_run_command');
  });

  it('S6 `command` is coords.allowedCommand', () => {
    expect(s6.args['command']).toBe(COORDS.allowedCommand);
  });

  it('S6 `args` matches SAFE_COMMAND_ARGS (an allowable arg array)', () => {
    expect(s6.args['args']).toEqual([...SAFE_COMMAND_ARGS]);
  });

  it('S6 `args` does NOT contain any element from DANGEROUS_COMMAND_ARGS', () => {
    const execArgs = s6.args['args'] as string[];
    for (const dangerous of DANGEROUS_COMMAND_ARGS) {
      expect(execArgs).not.toContain(dangerous);
    }
  });

  it('S6 includes `cwd` when coords.allowCwd is present', () => {
    expect(s6.args['cwd']).toBe(COORDS.allowCwd);
  });

  it('S6 `agent` is the target agent', () => {
    expect(s6.args['agent']).toBe(COORDS.targetAgentId);
  });

  it('S6 is held for approval', () => {
    expect(s6.heldForApproval).toBe(true);
  });

  it('S6 operator is approve', () => {
    expect(s6.operator).toBe('approve');
  });

  it('S6 approvalMatch targets the command name (to filter the right pending request)', () => {
    expect(s6.approvalMatch).toBe(COORDS.allowedCommand);
  });

  it('S6 terminal status is ok', () => {
    expect(s6.terminalStatus).toBe('ok');
  });
});

describe('scenario — S6 omits cwd when coords.allowCwd is absent', () => {
  const s6NoCwd = buildGoldenScenario(COORDS_NO_CWD, 'no-cwd-content-nonce').find((s) => s.id === 'S6')!;

  it('S6 omits `cwd` entirely when allowCwd is absent (no undefined leak)', () => {
    expect('cwd' in s6NoCwd.args).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// S7 — mx_run_command(allowedCommand, dangerousArgs), deny_args_regex → policy_denied
// ---------------------------------------------------------------------------

describe('scenario — S7 (mx_run_command, deny_args_regex denial) arg content', () => {
  const s7 = buildGoldenScenario(COORDS, NONCE).find((s) => s.id === 'S7')!;

  it('S7 tool is mx_run_command', () => {
    expect(s7.tool).toBe('mx_run_command');
  });

  it('S7 `command` is coords.allowedCommand (same binary, dangerous args)', () => {
    expect(s7.args['command']).toBe(COORDS.allowedCommand);
  });

  it('S7 `args` matches DANGEROUS_COMMAND_ARGS (trips deny_args_regex)', () => {
    expect(s7.args['args']).toEqual([...DANGEROUS_COMMAND_ARGS]);
  });

  it('S7 `args` does NOT contain any element from SAFE_COMMAND_ARGS', () => {
    const execArgs = s7.args['args'] as string[];
    for (const safe of SAFE_COMMAND_ARGS) {
      expect(execArgs).not.toContain(safe);
    }
  });

  it('S7 `agent` is the target agent', () => {
    expect(s7.args['agent']).toBe(COORDS.targetAgentId);
  });

  it('S7 is NOT held for approval (deny_args_regex fires before the gate)', () => {
    expect(s7.heldForApproval).toBe(false);
  });

  it('S7 has no operator (not held)', () => {
    expect(s7.operator).toBeUndefined();
  });

  it('S7 terminal status is denied with policy_denied code', () => {
    expect(s7.terminalStatus).toBe('denied');
    expect(s7.terminalErrorCode).toBe('policy_denied');
  });
});

// ---------------------------------------------------------------------------
// S8 — mx_delegate_tool(deniedTool), deny-by-default → policy_denied
// ---------------------------------------------------------------------------

describe('scenario — S8 (mx_delegate_tool, deny-by-default) arg content', () => {
  const s8 = buildGoldenScenario(COORDS, NONCE).find((s) => s.id === 'S8')!;

  it('S8 tool is mx_delegate_tool', () => {
    expect(s8.tool).toBe('mx_delegate_tool');
  });

  it('S8 delegates coords.deniedTool', () => {
    expect(s8.args['tool']).toBe(COORDS.deniedTool);
  });

  it('S8 does NOT delegate allowTool or approvalTool (only the explicitly denied one)', () => {
    expect(s8.args['tool']).not.toBe(COORDS.allowTool);
    expect(s8.args['tool']).not.toBe(COORDS.approvalTool);
  });

  it('S8 `agent` is the target agent', () => {
    expect(s8.args['agent']).toBe(COORDS.targetAgentId);
  });

  it('S8 inner args is an empty object', () => {
    expect(s8.args['args']).toEqual({});
  });

  it('S8 is NOT held for approval (policy denies before any gate)', () => {
    expect(s8.heldForApproval).toBe(false);
  });

  it('S8 terminal status is denied with policy_denied code (deny-by-default)', () => {
    expect(s8.terminalStatus).toBe('denied');
    expect(s8.terminalErrorCode).toBe('policy_denied');
  });
});

// ---------------------------------------------------------------------------
// Cross-step invariants — agent vs agent_id field naming
// ---------------------------------------------------------------------------

describe('scenario — agent vs agent_id field naming across all steps', () => {
  const steps = buildGoldenScenario(COORDS, NONCE);

  it('delegation and exec verbs (S3–S8) use `agent`, not `agent_id`', () => {
    for (const id of ['S3', 'S4', 'S5', 'S6', 'S7', 'S8']) {
      const step = steps.find((s) => s.id === id)!;
      expect(step.args, `${id} must carry agent`).toHaveProperty('agent', COORDS.targetAgentId);
      expect(step.args, `${id} must NOT carry agent_id`).not.toHaveProperty('agent_id');
    }
  });

  it('S2 (inspect verb) uses `agent_id`, not `agent`', () => {
    const s2 = steps.find((s) => s.id === 'S2')!;
    expect(s2.args).toHaveProperty('agent_id', COORDS.targetAgentId);
    expect(s2.args).not.toHaveProperty('agent');
  });

  it('S1 (filter verb) carries neither `agent` nor `agent_id`', () => {
    const s1 = steps.find((s) => s.id === 'S1')!;
    expect(s1.args).not.toHaveProperty('agent');
    expect(s1.args).not.toHaveProperty('agent_id');
  });
});

// ---------------------------------------------------------------------------
// Room never in any step args (always injected from the session)
// ---------------------------------------------------------------------------

describe('scenario — room is never in any step args', () => {
  const steps = buildGoldenScenario(COORDS, NONCE);

  it('no step args object has a `room` property', () => {
    for (const step of steps) {
      expect(step.args, `${step.id} must not carry room`).not.toHaveProperty('room');
    }
  });

  it('the room value does not appear anywhere in the serialised arg objects', () => {
    const json = JSON.stringify(steps.map((s) => s.args));
    expect(json).not.toContain(COORDS.room);
  });
});

// ---------------------------------------------------------------------------
// JSON serializability — step args must survive JSON round-trip (Boundary A)
// ---------------------------------------------------------------------------

describe('scenario — all step args are JSON-serializable (no class instances, no circular refs)', () => {
  it('JSON.parse(JSON.stringify(steps)) produces the same ids and arg shapes', () => {
    const steps = buildGoldenScenario(COORDS, 'json-rt-nonce');
    const rt = JSON.parse(JSON.stringify(steps)) as GoldenStep[];
    expect(rt.map((s) => s.id)).toEqual(steps.map((s) => s.id));
    for (let i = 0; i < steps.length; i++) {
      // Arg values round-trip faithfully (no function/symbol/undefined/class).
      expect(rt[i]!.args).toEqual(steps[i]!.args);
    }
  });
});

// ---------------------------------------------------------------------------
// expectedEmissions — the canonical 8-step counts (5 non-held + 3 held = 11)
// ---------------------------------------------------------------------------

describe('scenario — expectedEmissions exact counts for the canonical 8-step scenario', () => {
  const steps = buildGoldenScenario(COORDS, NONCE);
  const e = expectedEmissions(steps);

  it('exactly 5 non-held steps (S1, S2, S3, S7, S8)', () => {
    const nonHeldIds = steps.filter((s) => !s.heldForApproval).map((s) => s.id);
    expect(nonHeldIds).toEqual(['S1', 'S2', 'S3', 'S7', 'S8']);
    expect(e.nonHeld).toBe(5);
  });

  it('exactly 3 held steps (S4, S5, S6)', () => {
    const heldIds = steps.filter((s) => s.heldForApproval).map((s) => s.id);
    expect(heldIds).toEqual(['S4', 'S5', 'S6']);
    expect(e.held).toBe(6); // 3 steps × 2 emissions each
  });

  it('total = 5 non-held + 6 held = 11 emissions', () => {
    expect(e.total).toBe(11);
  });
});

// ---------------------------------------------------------------------------
// SAFE / DANGEROUS command args — content assertions (what the daemon sees)
// ---------------------------------------------------------------------------

describe('scenario — SAFE_COMMAND_ARGS content', () => {
  it('SAFE_COMMAND_ARGS contains no curl/ssh/rm -rf pattern (would trip deny_args_regex)', () => {
    const joined = SAFE_COMMAND_ARGS.join(' ');
    expect(joined).not.toMatch(/\bcurl\b/);
    expect(joined).not.toMatch(/\bssh\b/);
    expect(joined).not.toMatch(/rm\s+-rf\s+\//);
  });

  it('SAFE_COMMAND_ARGS elements are non-empty strings', () => {
    expect(SAFE_COMMAND_ARGS.length).toBeGreaterThan(0);
    for (const a of SAFE_COMMAND_ARGS) {
      expect(typeof a).toBe('string');
      expect(a.length).toBeGreaterThan(0);
    }
  });
});

describe('scenario — DANGEROUS_COMMAND_ARGS content', () => {
  it('DANGEROUS_COMMAND_ARGS contains `curl` (triggers the deny_args_regex pattern)', () => {
    expect(DANGEROUS_COMMAND_ARGS.join(' ')).toMatch(/\bcurl\b/);
  });

  it('DANGEROUS_COMMAND_ARGS elements are non-empty strings', () => {
    expect(DANGEROUS_COMMAND_ARGS.length).toBeGreaterThan(0);
    for (const a of DANGEROUS_COMMAND_ARGS) {
      expect(typeof a).toBe('string');
      expect(a.length).toBeGreaterThan(0);
    }
  });

  it('DANGEROUS_COMMAND_ARGS does not overlap with SAFE_COMMAND_ARGS (disjoint arg sets)', () => {
    const safeSet = new Set(SAFE_COMMAND_ARGS);
    for (const dangerous of DANGEROUS_COMMAND_ARGS) {
      expect(safeSet.has(dangerous), `"${dangerous}" must not appear in SAFE_COMMAND_ARGS`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Policy branch documentation — each step has a non-empty policyBranch string
// ---------------------------------------------------------------------------

describe('scenario — policyBranch strings are non-empty and distinct (documentation)', () => {
  const steps = buildGoldenScenario(COORDS, NONCE);

  it('every step has a non-empty policyBranch', () => {
    for (const step of steps) {
      expect(typeof step.policyBranch, `${step.id}: policyBranch must be string`).toBe('string');
      expect(step.policyBranch.length, `${step.id}: policyBranch must be non-empty`).toBeGreaterThan(0);
    }
  });

  it('S3 policy branch marks it as ungated (requires_approval=false)', () => {
    const s3 = steps.find((s) => s.id === 'S3')!;
    expect(s3.policyBranch).toMatch(/requires_approval=false/);
  });

  it('S7 policy branch marks it as a deny_args_regex match', () => {
    const s7 = steps.find((s) => s.id === 'S7')!;
    expect(s7.policyBranch).toMatch(/deny_args_regex/);
  });

  it('S8 policy branch marks it as deny-by-default', () => {
    const s8 = steps.find((s) => s.id === 'S8')!;
    expect(s8.policyBranch).toMatch(/deny[-\s]by[-\s]default/i);
  });
});

// ---------------------------------------------------------------------------
// Step label uniqueness (documentation strings must be distinct for test output)
// ---------------------------------------------------------------------------

describe('scenario — step label uniqueness', () => {
  it('all step labels are distinct (each uniquely identifies the step in test output)', () => {
    const steps = buildGoldenScenario(COORDS, NONCE);
    const labels = steps.map((s) => s.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
