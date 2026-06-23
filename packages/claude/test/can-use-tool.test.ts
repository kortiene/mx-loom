/**
 * `canUseTool` HITL hook (T110 / #18 AC2) — `createMxCanUseTool` + `wrapCanUseTool`
 * + `defaultShouldPrompt`.
 *
 * Tests:
 *  - A risk-bearing verb (`mx_delegate_tool`) triggers `onApprovalRequest` with a
 *    **secret-free** `ApprovalSummary` (no token/key/credential key or value appears).
 *  - Credential-shaped arg keys in `mx_delegate_tool.args` are filtered from the
 *    summary's `args_summary`.
 *  - `onApprovalRequest` returning `'deny'` → `{ behavior: 'deny' }` (no dispatch);
 *    the deny message never contains arg values.
 *  - `onApprovalRequest` returning `'allow'` → `{ behavior: 'allow', updatedInput }` with
 *    the input object unchanged.
 *  - Read/observe verbs (`mx_find_agents`, `mx_workspace_status`, etc.) auto-allow
 *    without triggering `onApprovalRequest`.
 *  - A non-`mx_*` tool name is delegated to `fallback`.
 *  - A tool under a different server name is delegated to `fallback`.
 *  - A pre-aborted `AbortSignal` → `{ behavior: 'deny' }` without calling
 *    `onApprovalRequest`.
 *  - A signal that aborts mid-prompt → `{ behavior: 'deny' }`.
 *  - `wrapCanUseTool` routes `mx_*` tools to the shim and non-`mx_*` tools to the
 *    wrapped hook.
 *  - `defaultShouldPrompt` prompts only for the risk-bearing verbs.
 *  - `ApprovalSummary` for `mx_run_command` never includes argv values (only count).
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createMxCanUseTool,
  defaultShouldPrompt,
  wrapCanUseTool,
} from '../src/can-use-tool.js';
import type { ApprovalSummary } from '../src/can-use-tool.js';
import { DEFAULT_SERVER_NAME, mxToolName } from '../src/names.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Build the third arg the CanUseTool callback receives. */
function makeCallOpts(signal = new AbortController().signal) {
  return { signal, toolUseID: 'test-use-id' };
}

const ALLOW_HANDLER = async () => 'allow' as const;
const DENY_HANDLER = async () => 'deny' as const;

// ---------------------------------------------------------------------------
// defaultShouldPrompt
// ---------------------------------------------------------------------------

describe('defaultShouldPrompt', () => {
  it('returns true for mx_delegate_tool', () => {
    expect(defaultShouldPrompt('mx_delegate_tool', {})).toBe(true);
  });

  it('returns true for mx_run_command', () => {
    expect(defaultShouldPrompt('mx_run_command', {})).toBe(true);
  });

  it('returns false for mx_find_agents', () => {
    expect(defaultShouldPrompt('mx_find_agents', {})).toBe(false);
  });

  it('returns false for mx_workspace_status', () => {
    expect(defaultShouldPrompt('mx_workspace_status', {})).toBe(false);
  });

  it('returns false for mx_await_result', () => {
    expect(defaultShouldPrompt('mx_await_result', {})).toBe(false);
  });

  it('returns false for mx_cancel', () => {
    expect(defaultShouldPrompt('mx_cancel', {})).toBe(false);
  });

  it('returns false for mx_share_context', () => {
    expect(defaultShouldPrompt('mx_share_context', {})).toBe(false);
  });

  it('returns false for mx_get_context', () => {
    expect(defaultShouldPrompt('mx_get_context', {})).toBe(false);
  });

  it('returns false for mx_describe_agent', () => {
    expect(defaultShouldPrompt('mx_describe_agent', {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// `'allow'` decision — tool is dispatched, input unchanged
// ---------------------------------------------------------------------------

describe('allow decision', () => {
  it('returns behavior:allow for a risk-bearing verb when operator allows', async () => {
    const canUseTool = createMxCanUseTool({ onApprovalRequest: ALLOW_HANDLER });
    const input = { agent: 'backend-dev-01', tool: 'run_tests', args: {} };
    const result = await canUseTool(mxToolName('mx_delegate_tool'), input, makeCallOpts());
    expect(result.behavior).toBe('allow');
  });

  it('the updatedInput is the original input object (unchanged)', async () => {
    const canUseTool = createMxCanUseTool({ onApprovalRequest: ALLOW_HANDLER });
    const input = { agent: 'backend-dev-01', tool: 'run_tests', args: { package: 'api' } };
    const result = await canUseTool(mxToolName('mx_delegate_tool'), input, makeCallOpts());
    expect(result.behavior).toBe('allow');
    if (result.behavior === 'allow') {
      expect(result.updatedInput).toBe(input);
    }
  });
});

// ---------------------------------------------------------------------------
// `'deny'` decision — short-circuits before dispatch
// ---------------------------------------------------------------------------

describe('deny decision', () => {
  it('returns behavior:deny when operator denies', async () => {
    const canUseTool = createMxCanUseTool({ onApprovalRequest: DENY_HANDLER });
    const input = { agent: 'backend-dev-01', tool: 'run_tests', args: {} };
    const result = await canUseTool(mxToolName('mx_delegate_tool'), input, makeCallOpts());
    expect(result.behavior).toBe('deny');
  });

  it('the deny message is secret-free: does not contain arg values', async () => {
    const canUseTool = createMxCanUseTool({ onApprovalRequest: DENY_HANDLER });
    const input = { agent: 'agent-x', tool: 'secret_op', args: { payload: 'super-secret-value' } };
    const result = await canUseTool(mxToolName('mx_delegate_tool'), input, makeCallOpts());
    expect(result.behavior).toBe('deny');
    if (result.behavior === 'deny') {
      expect(result.message).not.toContain('super-secret-value');
      expect(result.message).not.toContain('payload');
    }
  });
});

// ---------------------------------------------------------------------------
// Secret-free `ApprovalSummary`
// ---------------------------------------------------------------------------

describe('ApprovalSummary is secret-free', () => {
  it('the summary carries the tool verb', async () => {
    let capturedSummary: ApprovalSummary | undefined;
    const canUseTool = createMxCanUseTool({
      onApprovalRequest: async (summary) => {
        capturedSummary = summary;
        return 'allow';
      },
    });
    const input = { agent: 'backend-dev-01', tool: 'run_tests', args: {} };
    await canUseTool(mxToolName('mx_delegate_tool'), input, makeCallOpts());
    expect(capturedSummary?.tool).toBe('mx_delegate_tool');
  });

  it('the summary carries the target agent id', async () => {
    let capturedSummary: ApprovalSummary | undefined;
    const canUseTool = createMxCanUseTool({
      onApprovalRequest: async (summary) => {
        capturedSummary = summary;
        return 'allow';
      },
    });
    const input = { agent: 'backend-dev-01', tool: 'run_tests', args: {} };
    await canUseTool(mxToolName('mx_delegate_tool'), input, makeCallOpts());
    expect(capturedSummary?.agent).toBe('backend-dev-01');
  });

  it('args_summary for mx_delegate_tool shows the inner tool name and arg key names', async () => {
    let capturedSummary: ApprovalSummary | undefined;
    const canUseTool = createMxCanUseTool({
      onApprovalRequest: async (summary) => {
        capturedSummary = summary;
        return 'allow';
      },
    });
    const input = { agent: 'agent-b', tool: 'run_tests', args: { package: 'api', flags: '--ci' } };
    await canUseTool(mxToolName('mx_delegate_tool'), input, makeCallOpts());
    expect(capturedSummary?.args_summary).toContain('run_tests');
    expect(capturedSummary?.args_summary).toContain('package');
    expect(capturedSummary?.args_summary).toContain('flags');
    // Values must NOT appear.
    expect(capturedSummary?.args_summary).not.toContain('api');
    expect(capturedSummary?.args_summary).not.toContain('--ci');
  });

  it('credential-shaped arg keys are filtered from args_summary', async () => {
    let capturedSummary: ApprovalSummary | undefined;
    const canUseTool = createMxCanUseTool({
      onApprovalRequest: async (summary) => {
        capturedSummary = summary;
        return 'allow';
      },
    });
    // A credential-shaped key like `access_token` must be filtered out.
    const input = { agent: 'agent-b', tool: 'run_tests', args: { access_token: 'secret', safe_key: 'v' } };
    await canUseTool(mxToolName('mx_delegate_tool'), input, makeCallOpts());
    // The credential key should be omitted from the summary.
    expect(capturedSummary?.args_summary).not.toContain('access_token');
    // Safe keys are still included.
    expect(capturedSummary?.args_summary).toContain('safe_key');
    // The value must never appear.
    expect(capturedSummary?.args_summary).not.toContain('secret');
  });

  it('credential-shaped key values never appear anywhere in the summary', async () => {
    let capturedSummary: ApprovalSummary | undefined;
    const canUseTool = createMxCanUseTool({
      onApprovalRequest: async (summary) => {
        capturedSummary = summary;
        return 'allow';
      },
    });
    const secretValue = 'ghp_fakePATForTestingPurposesOnly';
    const input = { agent: 'agent-b', tool: 'run_tests', args: { token: secretValue } };
    await canUseTool(mxToolName('mx_delegate_tool'), input, makeCallOpts());
    expect(JSON.stringify(capturedSummary)).not.toContain(secretValue);
  });

  it('risk for mx_delegate_tool is medium', async () => {
    let capturedSummary: ApprovalSummary | undefined;
    const canUseTool = createMxCanUseTool({
      onApprovalRequest: async (summary) => {
        capturedSummary = summary;
        return 'allow';
      },
    });
    await canUseTool(
      mxToolName('mx_delegate_tool'),
      { agent: 'agent-b', tool: 'run_tests', args: {} },
      makeCallOpts(),
    );
    expect(capturedSummary?.risk).toBe('medium');
  });

  it('risk for mx_run_command is high', async () => {
    let capturedSummary: ApprovalSummary | undefined;
    const canUseTool = createMxCanUseTool({
      onApprovalRequest: async (summary) => {
        capturedSummary = summary;
        return 'allow';
      },
    });
    await canUseTool(
      mxToolName('mx_run_command'),
      { agent: 'agent-b', command: 'ls', args: ['-la'] },
      makeCallOpts(),
    );
    expect(capturedSummary?.risk).toBe('high');
  });

  it('args_summary for mx_run_command never includes argv values, only count', async () => {
    let capturedSummary: ApprovalSummary | undefined;
    const canUseTool = createMxCanUseTool({
      onApprovalRequest: async (summary) => {
        capturedSummary = summary;
        return 'allow';
      },
    });
    const argValues = ['--secret-flag', 'private_value'];
    const input = { command: 'bash', args: argValues };
    await canUseTool(mxToolName('mx_run_command'), input, makeCallOpts());
    // argv values must NOT appear.
    for (const val of argValues) {
      expect(capturedSummary?.args_summary).not.toContain(val);
    }
    // But the count should be present.
    expect(capturedSummary?.args_summary).toContain('argc=2');
  });
});

// ---------------------------------------------------------------------------
// Read/observe verbs auto-allow without prompting
// ---------------------------------------------------------------------------

describe('read/observe verbs auto-allow (no prompt)', () => {
  const READ_VERBS = [
    'mx_find_agents',
    'mx_describe_agent',
    'mx_await_result',
    'mx_get_context',
    'mx_share_context',
    'mx_cancel',
    'mx_workspace_status',
  ];

  for (const verb of READ_VERBS) {
    it(`${verb} auto-allows without calling onApprovalRequest`, async () => {
      const onApprovalRequest = vi.fn(async () => 'allow' as const);
      const canUseTool = createMxCanUseTool({ onApprovalRequest });
      const result = await canUseTool(mxToolName(verb), {}, makeCallOpts());
      expect(result.behavior).toBe('allow');
      expect(onApprovalRequest).not.toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------------
// Non-`mx_*` tools are delegated to fallback
// ---------------------------------------------------------------------------

describe('non-mx_* tools are delegated to fallback', () => {
  it('a bare non-namespaced tool name goes to the fallback', async () => {
    const fallback = vi.fn(async (_toolName: string, input: Record<string, unknown>) => ({
      behavior: 'allow' as const,
      updatedInput: input,
    }));
    const onApprovalRequest = vi.fn(async () => 'allow' as const);
    const canUseTool = createMxCanUseTool({ onApprovalRequest, fallback });
    await canUseTool('bash', { command: 'ls' }, makeCallOpts());
    expect(fallback).toHaveBeenCalledWith('bash', { command: 'ls' }, expect.anything());
    expect(onApprovalRequest).not.toHaveBeenCalled();
  });

  it('a different-server namespaced name goes to fallback', async () => {
    const fallback = vi.fn(async (_toolName: string, input: Record<string, unknown>) => ({
      behavior: 'allow' as const,
      updatedInput: input,
    }));
    const onApprovalRequest = vi.fn(async () => 'allow' as const);
    const canUseTool = createMxCanUseTool({ onApprovalRequest, fallback });
    await canUseTool('mcp__other__mx_delegate_tool', {}, makeCallOpts());
    expect(fallback).toHaveBeenCalled();
    expect(onApprovalRequest).not.toHaveBeenCalled();
  });

  it('when no fallback is provided, a non-mx_* tool is allowed by default', async () => {
    const onApprovalRequest = vi.fn(async () => 'allow' as const);
    const canUseTool = createMxCanUseTool({ onApprovalRequest });
    const result = await canUseTool('some_other_tool', { x: 1 }, makeCallOpts());
    expect(result.behavior).toBe('allow');
    expect(onApprovalRequest).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AbortSignal — pre-aborted + mid-flight abort
// ---------------------------------------------------------------------------

describe('AbortSignal aborts a pending prompt', () => {
  it('a pre-aborted signal → deny without calling onApprovalRequest', async () => {
    const onApprovalRequest = vi.fn(async () => 'allow' as const);
    const canUseTool = createMxCanUseTool({ onApprovalRequest });
    const ac = new AbortController();
    ac.abort();
    const result = await canUseTool(mxToolName('mx_delegate_tool'), { agent: 'a', tool: 't', args: {} }, {
      signal: ac.signal,
      toolUseID: 'test-id',
    });
    expect(result.behavior).toBe('deny');
    expect(onApprovalRequest).not.toHaveBeenCalled();
  });

  it('a signal that aborts mid-flight → deny', async () => {
    const ac = new AbortController();
    let settleApproval!: (v: 'allow' | 'deny') => void;
    const pendingApproval = new Promise<'allow' | 'deny'>((resolve) => {
      settleApproval = resolve;
    });
    const canUseTool = createMxCanUseTool({
      onApprovalRequest: () => pendingApproval,
    });

    const resultPromise = canUseTool(
      mxToolName('mx_delegate_tool'),
      { agent: 'a', tool: 't', args: {} },
      { signal: ac.signal, toolUseID: 'test-id' },
    );

    // Abort while the approval is pending.
    ac.abort();

    const result = await resultPromise;
    expect(result.behavior).toBe('deny');

    // Clean up the hanging promise — does not affect the test result.
    settleApproval('allow');
  });
});

// ---------------------------------------------------------------------------
// `wrapCanUseTool` — compose with host's existing hook
// ---------------------------------------------------------------------------

describe('wrapCanUseTool — composition', () => {
  it('routes mx_* tools to the shim and non-mx_* to the wrapped hook', async () => {
    const existingMxCalls: string[] = [];
    const existingNonMxCalls: string[] = [];
    const existing = vi.fn(async (toolName: string, input: Record<string, unknown>) => {
      existingNonMxCalls.push(toolName);
      return { behavior: 'allow' as const, updatedInput: input };
    });
    const shim = wrapCanUseTool(existing, { onApprovalRequest: ALLOW_HANDLER });

    // An mx_* tool goes through the shim.
    await shim(mxToolName('mx_delegate_tool'), { agent: 'a', tool: 't', args: {} }, makeCallOpts());
    // A non-mx_* tool goes to the wrapped hook.
    await shim('bash', { cmd: 'ls' }, makeCallOpts());

    expect(existingNonMxCalls).toContain('bash');
    expect(existingNonMxCalls).not.toContain(mxToolName('mx_delegate_tool'));
    expect(existing).toHaveBeenCalledTimes(1);
    void existingMxCalls; // suppress unused variable warning
  });

  it('shim deny overrides the wrapped hook for mx_* tools', async () => {
    const existing = vi.fn(async (_n: string, i: Record<string, unknown>) => ({
      behavior: 'allow' as const,
      updatedInput: i,
    }));
    const shim = wrapCanUseTool(existing, { onApprovalRequest: DENY_HANDLER });
    const result = await shim(
      mxToolName('mx_delegate_tool'),
      { agent: 'a', tool: 't', args: {} },
      makeCallOpts(),
    );
    expect(result.behavior).toBe('deny');
    // The wrapped hook must not have been called for an mx_* tool.
    expect(existing).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Custom `shouldPrompt` predicate
// ---------------------------------------------------------------------------

describe('custom shouldPrompt predicate', () => {
  it('auto-allows mx_delegate_tool when shouldPrompt returns false for it', async () => {
    const onApprovalRequest = vi.fn(async () => 'deny' as const);
    const canUseTool = createMxCanUseTool({
      onApprovalRequest,
      shouldPrompt: () => false,
    });
    const result = await canUseTool(
      mxToolName('mx_delegate_tool'),
      { agent: 'a', tool: 't', args: {} },
      makeCallOpts(),
    );
    expect(result.behavior).toBe('allow');
    expect(onApprovalRequest).not.toHaveBeenCalled();
  });

  it('prompts for mx_find_agents when shouldPrompt returns true for it', async () => {
    const onApprovalRequest = vi.fn(async () => 'allow' as const);
    const canUseTool = createMxCanUseTool({
      onApprovalRequest,
      shouldPrompt: () => true,
    });
    await canUseTool(mxToolName('mx_find_agents'), {}, makeCallOpts());
    expect(onApprovalRequest).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// ApprovalSummary edge cases — `command` field, generic verb fallback, absent agent
// ---------------------------------------------------------------------------

describe('ApprovalSummary edge cases', () => {
  it('ApprovalSummary.command is present for mx_run_command when command is a string', async () => {
    let capturedSummary: ApprovalSummary | undefined;
    const canUseTool = createMxCanUseTool({
      onApprovalRequest: async (summary) => {
        capturedSummary = summary;
        return 'allow';
      },
    });
    await canUseTool(mxToolName('mx_run_command'), { command: 'pytest', args: [] }, makeCallOpts());
    expect(capturedSummary?.command).toBe('pytest');
  });

  it('ApprovalSummary.agent is undefined when mx_delegate_tool input has no string agent', async () => {
    let capturedSummary: ApprovalSummary | undefined;
    const canUseTool = createMxCanUseTool({
      onApprovalRequest: async (summary) => {
        capturedSummary = summary;
        return 'allow';
      },
    });
    // No `agent` field — summary must not fabricate one.
    await canUseTool(mxToolName('mx_delegate_tool'), { tool: 'run_tests', args: {} }, makeCallOpts());
    expect(capturedSummary?.agent).toBeUndefined();
  });

  it('args_summary for a non-delegate non-run_command verb lists the non-credential key names', async () => {
    // The summariseArgs fallback for generic verbs returns "keys: [...]".
    let capturedSummary: ApprovalSummary | undefined;
    const canUseTool = createMxCanUseTool({
      onApprovalRequest: async (summary) => {
        capturedSummary = summary;
        return 'allow';
      },
      // Force prompt for a read verb to exercise the fallback path.
      shouldPrompt: () => true,
    });
    await canUseTool(mxToolName('mx_find_agents'), { filter: 'backend', limit: 10 }, makeCallOpts());
    // Key names must appear; values must not.
    expect(capturedSummary?.args_summary).toContain('filter');
    expect(capturedSummary?.args_summary).toContain('limit');
    expect(capturedSummary?.args_summary).not.toContain('backend');
  });

  it('args_summary for mx_run_command includes cwd indicator when cwd is set', async () => {
    let capturedSummary: ApprovalSummary | undefined;
    const canUseTool = createMxCanUseTool({
      onApprovalRequest: async (summary) => {
        capturedSummary = summary;
        return 'allow';
      },
    });
    await canUseTool(
      mxToolName('mx_run_command'),
      { command: 'make', args: ['test'], cwd: '/workspace' },
      makeCallOpts(),
    );
    expect(capturedSummary?.args_summary).toContain('cwd set');
    // The cwd path value must NOT appear.
    expect(capturedSummary?.args_summary).not.toContain('/workspace');
  });
});
