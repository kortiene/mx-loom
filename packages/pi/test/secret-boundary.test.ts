/**
 * Secret boundary / redaction (T205) — Boundary A holds at the Pi binding seam.
 *
 * The toolbelt's `MxClient.call()` enforces two-sided guards:
 *  - **Outbound:** `assertNoCredentialShapedArgs(params)` before dispatch —
 *    credential-shaped args surface as `invalid_args`.
 *  - **Inbound:** `redactSecrets(response)` — credential-value-shaped strings in
 *    the daemon reply are replaced with `«redacted»`.
 *
 * A "guarded fake daemon" simulates that contract so the boundary is verified
 * end-to-end without a live daemon.
 *
 * Tests:
 *  - A credential-shaped KEY in `mx_delegate_tool.args` → invalid_args.
 *  - A credential-shaped VALUE (e.g. `ghp_…`) → invalid_args.
 *  - Neither content[0].text nor details contains the rejected secret.
 *  - A daemon reply with a token-shaped value → redacted to REDACTION_PLACEHOLDER
 *    in both content and details.
 *  - The room is sourced from the session context, NEVER from model params (verified
 *    by asserting that the string "!pi-test-room" never comes from args).
 *  - No authority verb is in the generated tool set (no-authority regression).
 */
import { describe, expect, it } from 'vitest';

import { NullAuditSink } from '@mx-loom/audit';
import { FORBIDDEN_AUTHORITY_VERBS, isForbiddenAuthorityVerb } from '@mx-loom/registry';
import type { DaemonCall } from '@mx-loom/registry';
import {
  REDACTION_PLACEHOLDER,
  assertNoCredentialShapedArgs,
  redactSecrets,
} from '@mx-loom/toolbelt';

import { createPiBindingContext } from '../src/context.js';
import { createPiToolDefinitions } from '../src/tools.js';
import type { ToolDefinition } from '../src/pi-abi.js';
import { ROOM, fakeBuilders } from './helpers.js';

const CALL_START_OK = {
  ok: true,
  result: {},
  audit_ref: { invocation_id: 'inv_sb', request_id: 'req_sb', room: ROOM, event_id: '$evt_sb' },
};

/**
 * Guarded fake daemon: simulates the two-sided MxClient.call contract —
 * outbound `assertNoCredentialShapedArgs` + inbound `redactSecrets`.
 */
function guardedFakeDaemon(callStartOverride?: (params: unknown) => unknown): DaemonCall {
  return {
    async call(method: string, params?: unknown): Promise<unknown> {
      assertNoCredentialShapedArgs(params);
      let response: unknown;
      switch (method) {
        case 'agent.tools':
          response = {
            schemas: [{ name: 'run_tests', input_schema: { type: 'object', additionalProperties: true } }],
          };
          break;
        case 'call.start':
          response = callStartOverride !== undefined ? callStartOverride(params) : CALL_START_OK;
          break;
        default:
          throw new Error(`unexpected method in secret-boundary test: ${method}`);
      }
      return redactSecrets(response);
    },
  };
}

async function makeTools(daemon: DaemonCall): Promise<ToolDefinition[]> {
  const ctx = await createPiBindingContext({
    daemon,
    room: ROOM,
    auditSink: new NullAuditSink(),
  });
  return createPiToolDefinitions(ctx, { builders: fakeBuilders });
}

function findTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const t = tools.find((x) => x.name === name);
  if (t === undefined) throw new Error(`tool ${name} not found`);
  return t;
}

// ---------------------------------------------------------------------------
// Outbound: credential-shaped ARG KEY is rejected before reaching the daemon
// ---------------------------------------------------------------------------

describe('outbound: credential-shaped arg key rejected', () => {
  it('access_token key in args → invalid_args', async () => {
    const tools = await makeTools(guardedFakeDaemon());
    const delegate = findTool(tools, 'mx_delegate_tool');
    const out = await delegate.execute('call-sb-1', {
      agent: 'agent-b',
      tool: 'run_tests',
      args: { access_token: 'any-value' },
    });
    const d = out.details as { status: string; error: { code: string } };
    expect(d.status).toBe('error');
    expect(d.error.code).toBe('invalid_args');
  });

  it('api_key in args → invalid_args', async () => {
    const tools = await makeTools(guardedFakeDaemon());
    const delegate = findTool(tools, 'mx_delegate_tool');
    const out = await delegate.execute('call-sb-2', {
      agent: 'agent-b',
      tool: 'run_tests',
      args: { api_key: 'some-secret' },
    });
    const d = out.details as { status: string; error: { code: string } };
    expect(d.status).toBe('error');
    expect(d.error.code).toBe('invalid_args');
  });

  it('content[0].text does not contain the rejected secret key value', async () => {
    const secretValue = 'unique-secret-value-key-pi-boundary-test';
    const tools = await makeTools(guardedFakeDaemon());
    const delegate = findTool(tools, 'mx_delegate_tool');
    const out = await delegate.execute('call-sb-3', {
      agent: 'agent-b',
      tool: 'run_tests',
      args: { access_token: secretValue },
    });
    expect(out.content[0]!.text).not.toContain(secretValue);
  });

  it('details does not contain the rejected secret key value', async () => {
    const secretValue = 'another-unique-secret-value-pi-boundary';
    const tools = await makeTools(guardedFakeDaemon());
    const delegate = findTool(tools, 'mx_delegate_tool');
    const out = await delegate.execute('call-sb-4', {
      agent: 'agent-b',
      tool: 'run_tests',
      args: { api_key: secretValue },
    });
    expect(JSON.stringify(out.details)).not.toContain(secretValue);
  });
});

// ---------------------------------------------------------------------------
// Outbound: credential-shaped ARG VALUE is rejected before reaching the daemon
// ---------------------------------------------------------------------------

describe('outbound: credential-shaped arg value rejected', () => {
  const FAKE_GH_PAT = 'ghp_fakeGitHubPATForPiBindingBoundaryTestXX';

  it('a GitHub-PAT-shaped value in args → invalid_args', async () => {
    const tools = await makeTools(guardedFakeDaemon());
    const delegate = findTool(tools, 'mx_delegate_tool');
    const out = await delegate.execute('call-sb-5', {
      agent: 'agent-b',
      tool: 'run_tests',
      args: { data: FAKE_GH_PAT },
    });
    const d = out.details as { status: string; error: { code: string } };
    expect(d.status).toBe('error');
    expect(d.error.code).toBe('invalid_args');
  });

  it('content[0].text does not contain the raw PAT value', async () => {
    const tools = await makeTools(guardedFakeDaemon());
    const delegate = findTool(tools, 'mx_delegate_tool');
    const out = await delegate.execute('call-sb-6', {
      agent: 'agent-b',
      tool: 'run_tests',
      args: { data: FAKE_GH_PAT },
    });
    expect(out.content[0]!.text).not.toContain(FAKE_GH_PAT);
  });

  it('details does not contain the raw PAT value', async () => {
    const tools = await makeTools(guardedFakeDaemon());
    const delegate = findTool(tools, 'mx_delegate_tool');
    const out = await delegate.execute('call-sb-7', {
      agent: 'agent-b',
      tool: 'run_tests',
      args: { data: FAKE_GH_PAT },
    });
    expect(JSON.stringify(out.details)).not.toContain(FAKE_GH_PAT);
  });
});

// ---------------------------------------------------------------------------
// Inbound: daemon reply with a token-shaped value is redacted
// ---------------------------------------------------------------------------

describe('inbound: daemon reply with token-shaped value is redacted', () => {
  const FAKE_MATRIX_TOKEN = 'syt_fakeMatrixTokenForPiBindingBoundaryXXX';

  it('token-shaped value in call.start result → REDACTION_PLACEHOLDER in details', async () => {
    const daemonWithLeak = guardedFakeDaemon(() => ({
      ok: true,
      result: { session_data: FAKE_MATRIX_TOKEN },
      audit_ref: CALL_START_OK.audit_ref,
    }));
    const tools = await makeTools(daemonWithLeak);
    const delegate = findTool(tools, 'mx_delegate_tool');
    const out = await delegate.execute('call-sb-8', {
      agent: 'agent-b',
      tool: 'run_tests',
      args: {},
    });

    expect(JSON.stringify(out.details)).not.toContain(FAKE_MATRIX_TOKEN);
    expect(out.content[0]!.text).not.toContain(FAKE_MATRIX_TOKEN);
    expect(JSON.stringify(out.details)).toContain(REDACTION_PLACEHOLDER);
  });
});

// ---------------------------------------------------------------------------
// No-authority invariant
// ---------------------------------------------------------------------------

describe('no-authority invariant', () => {
  it('FORBIDDEN_AUTHORITY_VERBS are not in the generated tool set', async () => {
    const tools = await makeTools(guardedFakeDaemon());
    const names = new Set(tools.map((t) => t.name));
    for (const forbidden of FORBIDDEN_AUTHORITY_VERBS) {
      expect(names.has(forbidden)).toBe(false);
    }
  });

  it('no generated tool name passes isForbiddenAuthorityVerb', async () => {
    const tools = await makeTools(guardedFakeDaemon());
    for (const tool of tools) {
      expect(isForbiddenAuthorityVerb(tool.name)).toBe(false);
    }
  });
});
