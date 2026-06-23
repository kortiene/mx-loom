/**
 * Secret boundary / redaction (T110 / #18 + T008) — Boundary A holds at the
 * Claude in-process shim seam.
 *
 * The same outbound + inbound guardrails that apply to the MCP binding (T109)
 * apply to the Claude shim — because both route through the same `DaemonCall`
 * seam backed by a concrete `MxClient` whose `call()` enforces:
 *  - **Outbound:** `assertNoCredentialShapedArgs(params)` before dispatch —
 *    a credential key or value shape surfaces as `invalid_args`.
 *  - **Inbound:** `redactSecrets(response)` — any credential-value-shaped string
 *    in the daemon reply is replaced with `«redacted»`.
 *
 * In these tests a "guarded fake daemon" simulates that contract so the boundary
 * is verified end-to-end without a live daemon.
 *
 * Tests:
 *  - A credential-shaped **key** in `mx_delegate_tool.args` (e.g. `access_token`)
 *    surfaces as `invalid_args` (isError: true); the value never appears in the
 *    `CallToolResult`.
 *  - A credential-shaped **value** (e.g. a `ghp_…` GitHub PAT) in args also
 *    surfaces as `invalid_args`.
 *  - `content[0].text` and `structuredContent` never contain the rejected secret
 *    value.
 *  - Inbound: a daemon reply containing a token-shaped value is redacted to
 *    `«redacted»` before serialization — no raw token reaches the model context.
 *  - No-authority invariant (regression): `FORBIDDEN_AUTHORITY_VERBS` are absent
 *    from the registered tool set; no dispatch key passes `isForbiddenAuthorityVerb`.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import { NullAuditSink } from '@mx-loom/audit';
import {
  FORBIDDEN_AUTHORITY_VERBS,
  isForbiddenAuthorityVerb,
} from '@mx-loom/registry';
import type { DaemonCall } from '@mx-loom/registry';
import {
  REDACTION_PLACEHOLDER,
  assertNoCredentialShapedArgs,
  redactSecrets,
} from '@mx-loom/toolbelt';
import type { BindingContext } from '@mx-loom/mcp';

import { createMxToolServer } from '../src/tool-server.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const ROOM = '!secret-boundary-test:server';

/**
 * A "guarded" fake daemon that simulates the two-sided secret-boundary contract
 * of a real `MxClient.call`:
 *  - Outbound: `assertNoCredentialShapedArgs(params)` — throws `TransportError`
 *    on a credential key or value shape, causing the handler to return
 *    `errored('invalid_args')`.
 *  - Inbound: `redactSecrets(response)` — replaces credential-value-shaped
 *    strings with `«redacted»`.
 */
function guardedFakeDaemon(callStartOverride?: (params: unknown) => unknown): DaemonCall {
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
                    invocation_id: 'inv_sb',
                    request_id: 'req_sb',
                    room: ROOM,
                    event_id: '$evt_sb',
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
    close: async () => { /* noop */ },
  };
  const config = createMxToolServer(ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([config.instance.connect(st), client.connect(ct)]);
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

  it('api_key in args → invalid_args', async () => {
    const client = await connectGuarded(guardedFakeDaemon());

    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: { api_key: 'anything' } },
    })) as CallToolResult;

    expect(res.isError).toBe(true);
  });

  it('content[0].text names the credential key but never echoes the value', async () => {
    const client = await connectGuarded(guardedFakeDaemon());
    const secretValue = 'unique-secret-value-for-boundary-test-claude';

    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: { access_token: secretValue } },
    })) as CallToolResult;

    const text = (res.content?.[0] as { type: string; text: string } | undefined)?.text ?? '';
    expect(text).not.toContain(secretValue);
  });

  it('structuredContent does not contain the rejected credential value', async () => {
    const client = await connectGuarded(guardedFakeDaemon());
    const secretValue = 'another-unique-secret-value-must-not-appear';

    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: { api_key: secretValue } },
    })) as CallToolResult;

    expect(JSON.stringify(res.structuredContent)).not.toContain(secretValue);
  });
});

// ---------------------------------------------------------------------------
// Outbound: credential-shaped ARG VALUE is rejected before reaching the daemon
// ---------------------------------------------------------------------------

describe('outbound: credential-shaped arg value rejected', () => {
  const FAKE_GH_PAT = 'ghp_fakeGitHubPATForTestingPurposesOnlyXXXX';

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

  it('content[0].text does not contain the raw PAT value', async () => {
    const client = await connectGuarded(guardedFakeDaemon());

    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: { data: FAKE_GH_PAT } },
    })) as CallToolResult;

    const text = (res.content?.[0] as { type: string; text: string } | undefined)?.text ?? '';
    expect(text).not.toContain(FAKE_GH_PAT);
  });

  it('structuredContent does not contain the raw PAT value', async () => {
    const client = await connectGuarded(guardedFakeDaemon());

    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: { data: FAKE_GH_PAT } },
    })) as CallToolResult;

    expect(JSON.stringify(res.structuredContent)).not.toContain(FAKE_GH_PAT);
  });
});

// ---------------------------------------------------------------------------
// Inbound: daemon reply containing a token-shaped value is redacted
// ---------------------------------------------------------------------------

describe('inbound: daemon reply with a token-shaped value is redacted', () => {
  const FAKE_MATRIX_TOKEN = 'syt_fakeMatrixTokenForTestingPurposesXXXXX';

  it('token-shaped value in call.start result is replaced with REDACTION_PLACEHOLDER', async () => {
    const daemonWithLeak = guardedFakeDaemon(() => ({
      ok: true,
      result: { session_data: FAKE_MATRIX_TOKEN },
      audit_ref: {
        invocation_id: 'inv_leak',
        request_id: 'req_leak',
        room: ROOM,
        event_id: '$evt_leak',
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
// No-authority invariant (regression)
// ---------------------------------------------------------------------------

describe('no-authority invariant', () => {
  it('FORBIDDEN_AUTHORITY_VERBS are not registered in the tool server', async () => {
    const ctx: BindingContext = {
      daemon: guardedFakeDaemon(),
      room: ROOM,
      correlationId: undefined,
      auditSink: new NullAuditSink(),
      close: async () => { /* noop */ },
    };
    const config = createMxToolServer(ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([config.instance.connect(st), client.connect(ct)]);
    clients.push(client);

    const { tools } = await client.listTools();
    const registeredNames = new Set(tools.map((t) => t.name));

    for (const forbidden of FORBIDDEN_AUTHORITY_VERBS) {
      expect(registeredNames.has(forbidden)).toBe(false);
    }
  });

  it('no registered tool name passes isForbiddenAuthorityVerb', async () => {
    const ctx: BindingContext = {
      daemon: guardedFakeDaemon(),
      room: ROOM,
      correlationId: undefined,
      auditSink: new NullAuditSink(),
      close: async () => { /* noop */ },
    };
    const config = createMxToolServer(ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([config.instance.connect(st), client.connect(ct)]);
    clients.push(client);

    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(isForbiddenAuthorityVerb(t.name)).toBe(false);
    }
  });
});
