/**
 * The binding-agnostic golden scenario (T114 / #22) — the "what the model does".
 *
 * This is NOT a test file (no `.test.ts` suffix). It exports an ordered list of
 * **logical model actions** (S1–S8), each independent of *how* it is dispatched.
 * Each binding arm (`golden.mcp.e2e.test.ts`, `golden.claude.e2e.test.ts`) adapts a
 * step into a real binding call and asserts the same expected terminal outcome, so
 * the scenario — the boundaries it crosses — is authored once.
 *
 * The step table mirrors the spec's S1–S8 and the golden policy
 * (`scripts/conformance/policy.golden.toml`) branch-for-branch:
 *
 * | #  | tool                | golden-policy branch                 | terminal           | operator |
 * |----|---------------------|--------------------------------------|--------------------|----------|
 * | S1 | mx_find_agents      | local read                           | ok (B present)     | —        |
 * | S2 | mx_describe_agent   | local read                           | ok (exposes tool)  | —        |
 * | S3 | mx_delegate_tool    | [[allow]] requires_approval=false    | ok + audit_ref     | —        |
 * | S4 | mx_delegate_tool    | [[allow]] requires_approval=true     | awaiting → ok      | approve  |
 * | S5 | mx_delegate_tool    | same, denied this time               | awaiting → denied  | deny     |
 * | S6 | mx_run_command      | [exec] requires_approval=true        | awaiting → ok      | approve  |
 * | S7 | mx_run_command      | deny_args_regex match                | policy_denied      | —        |
 * | S8 | mx_delegate_tool    | deny-by-default                      | policy_denied      | —        |
 *
 * The deferred steps (S4–S6) are held at the receiver's approval gate; the harness
 * resolves them via a second `mx_await_result` call *after* the out-of-band operator
 * decision, so the test is deterministic — no guessing bot (see `_golden-harness.ts`).
 */
import type { ErrorCode, ToolStatus } from '@mx-loom/registry';

/** The out-of-band operator decision a held step requires. */
export type OperatorDecision = 'approve' | 'deny';

/** A single logical model action + its expected terminal outcome under the golden policy. */
export interface GoldenStep {
  /** Stable id, `S1`…`S8`. */
  readonly id: string;
  /** Human-readable label for test output. */
  readonly label: string;
  /** The `mx_*` verb the model invokes. */
  readonly tool: string;
  /** The model-supplied arguments (secret-free; the room is NEVER here — it comes from the session). */
  readonly args: Record<string, unknown>;
  /** Which golden-policy branch this step exercises (documentation / assertion message). */
  readonly policyBranch: string;
  /**
   * Whether the daemon is expected to **hold** the first dispatch at the approval
   * gate (`awaiting_approval`) before an operator decides. The harness then issues
   * the operator decision out-of-band and resolves the handle.
   */
  readonly heldForApproval: boolean;
  /** The out-of-band operator action when held (`undefined` for non-held steps). */
  readonly operator?: OperatorDecision;
  /** Substring marker used to target the operator decision at THIS step's pending request. */
  readonly approvalMatch?: string;
  /** The expected terminal envelope status after resolution. */
  readonly terminalStatus: ToolStatus;
  /** The expected terminal `error.code` for `denied`/`error` steps (absent for `ok`). */
  readonly terminalErrorCode?: ErrorCode;
}

/** The fixture coordinates the scenario is parameterised over (from the bring-up). */
export interface ScenarioCoords {
  /** Workspace room daemon A + B both joined. Never passed as a model arg — the binding injects it. */
  readonly room: string;
  /** Agent id of daemon B's registered target agent. */
  readonly targetAgentId: string;
  /** Low-risk named tool B publishes and the golden policy ALLOWS ungated (`@@ALLOW_TOOL@@`). */
  readonly allowTool: string;
  /** High-risk named tool B publishes, held `requires_approval=true` (`@@APPROVAL_TOOL@@`). */
  readonly approvalTool: string;
  /** Named tool B publishes but the golden policy DENIES by default (`@@DENY_TOOL@@`). */
  readonly deniedTool: string;
  /** The one allowlisted, approval-gated guarded command (`@@ALLOW_COMMAND@@`). */
  readonly allowedCommand: string;
  /** The cwd the command is permitted to run in (`@@ALLOW_CWD@@`); omitted when absent. */
  readonly allowCwd?: string;
}

/**
 * Safe guarded-exec args — none of the golden policy's `deny_args_regex` patterns
 * (`| sh`, `rm -rf /`, `ssh`, `curl`). For the default `echo` command these are benign,
 * so only the `requires_approval=true` gate (not `deny_args_regex`) holds S6.
 */
export const SAFE_COMMAND_ARGS: readonly string[] = ['mx-loom-golden-exec-marker'];

/**
 * Dangerous guarded-exec args — `curl …` trips the golden policy's `deny_args_regex`
 * (`\bcurl\b`). Sent as a bare arg to the allowlisted binary so the *args* match the
 * pattern without the binary itself being `curl` (the S7 deny path).
 */
export const DANGEROUS_COMMAND_ARGS: readonly string[] = ['curl', 'https://evil.example.invalid'];

/**
 * Build the ordered S1–S8 scenario for a given fixture + run nonce.
 *
 * `nonce` makes every mutating step's `idempotency_key` unique per run (so a re-run
 * never collides on the daemon's dedup store), while S4 and S5 deliberately use
 * DISTINCT keys for the same approval tool — S4 is approved, S5 is denied — so the
 * operator can decide each independently.
 */
export function buildGoldenScenario(coords: ScenarioCoords, nonce: string): GoldenStep[] {
  const idem = (suffix: string): string => `mxl-golden-${nonce}-${suffix}`;
  const cwd = coords.allowCwd !== undefined ? { cwd: coords.allowCwd } : {};

  return [
    {
      id: 'S1',
      label: 'mx_find_agents (capability/tool filter) → ok, agent B present',
      tool: 'mx_find_agents',
      args: { tool: coords.allowTool },
      policyBranch: 'local read',
      heldForApproval: false,
      terminalStatus: 'ok',
    },
    {
      id: 'S2',
      label: 'mx_describe_agent(B) → ok, exposes the allowed tool schema',
      tool: 'mx_describe_agent',
      args: { agent_id: coords.targetAgentId },
      policyBranch: 'local read',
      heldForApproval: false,
      terminalStatus: 'ok',
    },
    {
      id: 'S3',
      label: 'mx_delegate_tool(@@ALLOW_TOOL@@) ungated → ok + populated audit_ref (AC1)',
      tool: 'mx_delegate_tool',
      args: {
        agent: coords.targetAgentId,
        tool: coords.allowTool,
        args: { package: 'mx-loom-golden' },
        idempotency_key: idem('s3-allow'),
      },
      policyBranch: '[[allow]] requires_approval=false',
      heldForApproval: false,
      terminalStatus: 'ok',
    },
    {
      id: 'S4',
      label: 'mx_delegate_tool(@@APPROVAL_TOOL@@) → awaiting_approval → operator APPROVES → ok (AC2)',
      tool: 'mx_delegate_tool',
      args: {
        agent: coords.targetAgentId,
        tool: coords.approvalTool,
        args: {},
        idempotency_key: idem('s4-approve'),
      },
      policyBranch: '[[allow]] requires_approval=true',
      heldForApproval: true,
      operator: 'approve',
      approvalMatch: coords.approvalTool,
      terminalStatus: 'ok',
    },
    {
      id: 'S5',
      label: 'mx_delegate_tool(@@APPROVAL_TOOL@@) (new idem key) → awaiting_approval → operator DENIES → denied(approval_denied) (AC2 denial)',
      tool: 'mx_delegate_tool',
      args: {
        agent: coords.targetAgentId,
        tool: coords.approvalTool,
        args: {},
        idempotency_key: idem('s5-deny'),
      },
      policyBranch: '[[allow]] requires_approval=true (denied)',
      heldForApproval: true,
      operator: 'deny',
      approvalMatch: coords.approvalTool,
      terminalStatus: 'denied',
      terminalErrorCode: 'approval_denied',
    },
    {
      id: 'S6',
      label: 'mx_run_command(@@ALLOW_COMMAND@@, safeArgs) → awaiting_approval → operator APPROVES → ok(exit_code) (AC2)',
      tool: 'mx_run_command',
      args: {
        agent: coords.targetAgentId,
        command: coords.allowedCommand,
        args: [...SAFE_COMMAND_ARGS],
        ...cwd,
        idempotency_key: idem('s6-exec-approve'),
      },
      policyBranch: '[exec] requires_approval=true',
      heldForApproval: true,
      operator: 'approve',
      approvalMatch: coords.allowedCommand,
      terminalStatus: 'ok',
    },
    {
      id: 'S7',
      label: 'mx_run_command(@@ALLOW_COMMAND@@, dangerousArgs) tripping deny_args_regex → policy_denied (no approval requested) (AC2 denial)',
      tool: 'mx_run_command',
      args: {
        agent: coords.targetAgentId,
        command: coords.allowedCommand,
        args: [...DANGEROUS_COMMAND_ARGS],
        ...cwd,
        idempotency_key: idem('s7-exec-deny'),
      },
      policyBranch: '[exec] deny_args_regex match',
      heldForApproval: false,
      terminalStatus: 'denied',
      terminalErrorCode: 'policy_denied',
    },
    {
      id: 'S8',
      label: 'mx_delegate_tool(@@DENY_TOOL@@) → deny-by-default → policy_denied',
      tool: 'mx_delegate_tool',
      args: {
        agent: coords.targetAgentId,
        tool: coords.deniedTool,
        args: {},
        idempotency_key: idem('s8-deny-default'),
      },
      policyBranch: 'deny-by-default',
      heldForApproval: false,
      terminalStatus: 'denied',
      terminalErrorCode: 'policy_denied',
    },
  ];
}

/** The expected total number of distinct audit emissions for one arm over S1–S8. */
export interface ExpectedEmissions {
  /** One row per non-held step (S1, S2, S3, S7, S8) = 5. */
  readonly nonHeld: number;
  /** Two rows per held step (awaiting_approval then the terminal) — S4, S5, S6 = 3 steps × 2. */
  readonly held: number;
  /** The total across the whole scenario. */
  readonly total: number;
}

/** Compute the expected audit-emission counts for a scenario (the AC4 counting model). */
export function expectedEmissions(steps: readonly GoldenStep[]): ExpectedEmissions {
  const held = steps.filter((s) => s.heldForApproval).length;
  const nonHeld = steps.length - held;
  return { nonHeld, held: held * 2, total: nonHeld + held * 2 };
}
