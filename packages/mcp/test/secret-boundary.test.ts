/**
 * Secret boundary / redaction (T109 + T008) — Boundary A holds at the MCP seam.
 *
 * The MCP server must never let a credential-shaped argument reach the daemon,
 * and must never surface a raw secret in the serialized `content` or
 * `structuredContent` returned to the model/runtime.
 *
 * The guard lives on `MxClient.call` (toolbelt T008). In production, the binding
 * context's `daemon` is an `MxSession` backed by `MxClient`; in these tests a
 * "guarded fake daemon" that calls `assertNoCredentialShapedArgs` (outbound) and
 * `redactSecrets` (inbound) simulates that contract, so the test verifies the
 * end-to-end boundary without a live daemon.
 *
 * Tests:
 *  - A credential-shaped **key** in `mx_delegate_tool` args (e.g. `access_token`)
 *    surfaces as `invalid_args` (isError: true) and never reaches `call.start`.
 *  - The `content[0].text` for that case names the key, never echoes the value.
 *  - A credential-shaped **value** (e.g. a `ghp_…` GitHub PAT) in args also
 *    surfaces as `invalid_args` — the value-shape guard fires before dispatch.
 *  - The `content` / `structuredContent` never contains the raw token value.
 *  - Inbound: a daemon reply containing a token-shaped value is redacted to
 *    `«redacted»` before serialization, so no raw secret reaches the model.
 *  - No FORBIDDEN_AUTHORITY_VERB or authority-prefix verb is reachable through
 *    the dispatch table (belt-and-suspenders no-authority regression).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import { FORBIDDEN_AUTHORITY_VERBS, isForbiddenAuthorityVerb } from '@mx-loom/registry';
import type { DaemonCall } from '@mx-loom/registry';
import {
  REDACTION_PLACEHOLDER,
  assertNoCredentialShapedArgs,
  redactSecrets,
} from '@mx-loom/toolbelt';
import { NullAuditSink } from '@mx-loom/audit';

import { DISPATCH } from '../src/dispatch.js';
import type { BindingContext } from '../src/context.js';
import { createMcpServer } from '../src/server.js';

const ROOM = '!test-room:server';

/**
 * A "guarded" fake daemon that simulates the two-sided secret-boundary contract
 * of a real `MxClient.call`:
 *  - **Outbound**: calls `assertNoCredentialShapedArgs(params)` before
 *    dispatching — throws `TransportError('invalid_args')` on a credential key
 *    or value shape, causing the handler to return `errored('invalid_args')`.
 *  - **Inbound**: applies `redactSecrets` on the response before returning —
 *    replaces any credential-value-shaped string with `«redacted»`.
 */
function guardedFakeDaemon(
  callStartOverride?: (params: unknown) => unknown,
): DaemonCall {
  return {
    async call(method: string, params?: unknown): Promise<unknown> {
      // Outbound guard (mirrors MxClient.call — T008).
      assertNoCredentialShapedArgs(params);

      let response: unknown;
      switch (method) {
        case 'agent.tools':
          response = {
            schemas: [
              { name: 'run_tests', input_schema: { type: 'object', additionalProperties: true } },
            ],
          };
          break;
        case 'call.start':
          response =
            callStartOverride !== undefined
              ? callStartOverride(params)
              : {
                  ok: true,
                  result: {},
                  audit_ref: {
                    invocation_id: 'inv_1',
                    request_id: 'req_1',
                    room: ROOM,
                    event_id: '$evt_1',
                  },
                };
          break;
        default:
          throw new Error(`unexpected daemon method in secret-boundary test: ${method}`);
      }

      // Inbound defense-in-depth redaction (mirrors MxClient.call — T008).
      return redactSecrets(response);
    },
  };
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function connectGuarded(daemon: DaemonCall): Promise<Client> {
  const ctx: BindingContext = {
    daemon,
    room: ROOM,
    correlationId: undefined,
    auditSink: new NullAuditSink(),
    close: async () => {
      /* nothing */
    },
  };
  const server = createMcpServer(ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  clients.push(client);
  return client;
}

// ---------------------------------------------------------------------------
// Outbound: credential-shaped ARG KEY is rejected before reaching the daemon
// ---------------------------------------------------------------------------

describe('outbound: credential-shaped arg key rejected', () => {
  it('access_token key in args → invalid_args (isError: true)', async () => {
    const client = await connectGuarded(guardedFakeDaemon());

    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: {
        agent: 'agent-b',
        tool: 'run_tests',
        args: { access_token: 'any-value-does-not-matter' },
      },
    })) as CallToolResult;

    expect(res.isError).toBe(true);
    const sc = res.structuredContent as { status: string; error: { code: string } };
    expect(sc.status).toBe('error');
    expect(sc.error.code).toBe('invalid_args');
  });

  it('content[0].text names the credential key but never echoes the value', async () => {
    const client = await connectGuarded(guardedFakeDaemon());
    const secretValue = 'unique-secret-value-for-test-purposes-only';

    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: {
        agent: 'agent-b',
        tool: 'run_tests',
        args: { access_token: secretValue },
      },
    })) as CallToolResult;

    const text = (res.content?.[0] as { type: string; text: string } | undefined)?.text ?? '';
    // The error message identifies the key name ('access_token'), not the value.
    expect(text).not.toContain(secretValue);
  });

  it('structuredContent does not contain the rejected value', async () => {
    const client = await connectGuarded(guardedFakeDaemon());
    const secretValue = 'another-unique-secret-value-should-not-appear';

    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: {
        agent: 'agent-b',
        tool: 'run_tests',
        args: { api_key: secretValue },
      },
    })) as CallToolResult;

    expect(JSON.stringify(res.structuredContent)).not.toContain(secretValue);
  });
});

// ---------------------------------------------------------------------------
// Outbound: credential-shaped ARG VALUE is rejected before reaching the daemon
// ---------------------------------------------------------------------------

describe('outbound: credential-shaped arg value rejected', () => {
  // CREDENTIAL_VALUE_RE matches values starting with `ghp_` (GitHub PAT prefix).
  const FAKE_GH_PAT = 'ghp_fakeTokenForTestingPurposesOnlyXXXXX';

  it('a GitHub-PAT-shaped value in args → invalid_args (isError: true)', async () => {
    const client = await connectGuarded(guardedFakeDaemon());

    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: {
        agent: 'agent-b',
        tool: 'run_tests',
        args: { data: FAKE_GH_PAT },
      },
    })) as CallToolResult;

    expect(res.isError).toBe(true);
    const sc = res.structuredContent as { error: { code: string } };
    expect(sc.error.code).toBe('invalid_args');
  });

  it('content[0].text does not contain the raw token value', async () => {
    const client = await connectGuarded(guardedFakeDaemon());

    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: {
        agent: 'agent-b',
        tool: 'run_tests',
        args: { data: FAKE_GH_PAT },
      },
    })) as CallToolResult;

    const text = (res.content?.[0] as { type: string; text: string } | undefined)?.text ?? '';
    expect(text).not.toContain(FAKE_GH_PAT);
  });

  it('structuredContent does not contain the raw token value', async () => {
    const client = await connectGuarded(guardedFakeDaemon());

    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: {
        agent: 'agent-b',
        tool: 'run_tests',
        args: { data: FAKE_GH_PAT },
      },
    })) as CallToolResult;

    expect(JSON.stringify(res.structuredContent)).not.toContain(FAKE_GH_PAT);
  });
});

// ---------------------------------------------------------------------------
// Inbound: daemon reply containing a token-shaped value is redacted
// ---------------------------------------------------------------------------

describe('inbound: daemon reply with a token-shaped value is redacted', () => {
  // CREDENTIAL_VALUE_RE matches values starting with `syt_` (Matrix token prefix).
  const FAKE_MATRIX_TOKEN = 'syt_fakeMatrixTokenForTestingPurposesXXXXX';

  it('token-shaped value in call.start result is replaced with REDACTION_PLACEHOLDER', async () => {
    const daemonWithLeak = guardedFakeDaemon(() => ({
      // Simulate a daemon bug that leaks a token-shaped value in the result.
      ok: true,
      result: { session_data: FAKE_MATRIX_TOKEN },
      audit_ref: {
        invocation_id: 'inv_1',
        request_id: 'req_1',
        room: ROOM,
        event_id: '$evt_1',
      },
    }));
    const client = await connectGuarded(daemonWithLeak);

    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: {} },
    })) as CallToolResult;

    const sc = JSON.stringify(res.structuredContent);
    const text = (res.content?.[0] as { type: string; text: string } | undefined)?.text ?? '';

    // Raw token must NOT appear in any serialized channel.
    expect(sc).not.toContain(FAKE_MATRIX_TOKEN);
    expect(text).not.toContain(FAKE_MATRIX_TOKEN);

    // The inbound redaction placeholder must appear instead.
    expect(sc).toContain(REDACTION_PLACEHOLDER);
  });
});

// ---------------------------------------------------------------------------
// No-authority invariant (regression): no authority verb is reachable
// ---------------------------------------------------------------------------

describe('no-authority invariant', () => {
  it('FORBIDDEN_AUTHORITY_VERBS are not keys in DISPATCH', () => {
    for (const forbidden of FORBIDDEN_AUTHORITY_VERBS) {
      expect(Object.prototype.hasOwnProperty.call(DISPATCH, forbidden)).toBe(false);
    }
  });

  it('no dispatch key passes isForbiddenAuthorityVerb', () => {
    for (const key of Object.keys(DISPATCH)) {
      expect(isForbiddenAuthorityVerb(key)).toBe(false);
    }
  });
});
