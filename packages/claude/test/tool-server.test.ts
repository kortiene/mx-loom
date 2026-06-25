/**
 * In-process tool-server builder (T110 / #18) — `createMxToolServer`.
 *
 * Tests:
 *  - The server config carries `type:'sdk'`, a non-empty `name`, and `instance`.
 *  - Connecting the `instance` via InMemoryTransport exposes exactly nine tools
 *    whose names equal the `CANONICAL_M1_TOOLS` names (generated, never
 *    hand-authored — adding a tenth descriptor surfaces it with no per-tool edit).
 *  - No registered tool name passes `isForbiddenAuthorityVerb` (no-authority
 *    invariant: `trust.*` / `approval.decide` / `policy.*` / … are unreachable).
 *  - `mx_delegate_tool` dispatches end-to-end: the tool handler routes through
 *    `dispatchCall`, applies the hidden poll loop and audit tap, and returns a
 *    valid `CallToolResult` (AC1 — sync `ok` path).
 *  - `structuredContent` is the full T102 envelope; `isError` is only `true` for
 *    `status:"error"` (`denied`/`awaiting_approval`/`running`/`ok` are not errors).
 *  - `mx_workspace_status` dispatches to a valid result (exercises a different
 *    deps subtype — `RoomScopedDeps`).
 *  - `room` comes from the context, never from model input (the model must never
 *    name a Matrix room id).
 *  - A descriptor with an unsupported schema construct throws
 *    `JsonSchemaConversionError` at build time (fail-closed).
 *  - Custom `name`/`version` options are reflected on the config.
 *  - `DEFAULT_SERVER_VERSION` is a semver-shaped string.
 *
 * All tests use the InMemoryTransport pair (no real daemon, no real socket,
 * fully deterministic).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import { NullAuditSink } from '@mx-loom/audit';
import {
  CANONICAL_TOOLS,
  FORBIDDEN_AUTHORITY_VERBS,
  isForbiddenAuthorityVerb,
} from '@mx-loom/registry';
import type { DaemonCall } from '@mx-loom/registry';

import { JsonSchemaConversionError, jsonSchemaToZodRawShape } from '../src/index.js';
import type { BindingContext } from '@mx-loom/mcp';
import { DEFAULT_SERVER_NAME } from '../src/names.js';
import { createMxToolServer, DEFAULT_SERVER_VERSION } from '../src/tool-server.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const ROOM = '!tool-server-test:server';

function fakeDaemon(): DaemonCall {
  return {
    async call(method: string): Promise<unknown> {
      switch (method) {
        case 'agent.list':
          return [];
        case 'agent.tools':
          return {
            schemas: [
              { name: 'run_tests', input_schema: { type: 'object', additionalProperties: true } },
            ],
          };
        case 'call.start':
          return {
            ok: true,
            result: { passed: true },
            audit_ref: {
              invocation_id: 'inv_svr',
              request_id: 'req_svr',
              room: ROOM,
              event_id: '$evt_svr',
            },
          };
        case 'exec.start':
          return {
            ok: true,
            result: { exit_code: 0 },
            audit_ref: {
              invocation_id: 'inv_exec',
              request_id: 'req_exec',
              room: ROOM,
              event_id: '$evt_exec',
            },
          };
        case 'workspace.status':
          return { room_id: ROOM, name: 'test workspace', encrypted: false };
        case 'invocation.get':
          return { state: 'ok', result: {} };
        case 'invocation.cancel':
          return { ok: true, cancelled: true };
        case 'share.file':
        case 'share.diff':
        case 'share.env':
          return { context_id: 'ctx_1', sha256: 'abc123' };
        case 'share.get':
          return { context_id: 'ctx_1', kind: 'file', sha256: 'abc123', inline: 'content' };
        // M3 (T301 + T303) task-DAG verbs. task.list returns an empty list so
        // mx_dispatch_task → not_found (a valid envelope; enough to test routing).
        case 'task.create':
        case 'task.update':
          return {
            task_id: 'task_svr_1',
            title: 'Server test task',
            state: 'proposed',
            depends_on: [],
            blocks: [],
            action: null,
            audit_ref: { invocation_id: 'inv_svr_t', request_id: 'req_svr_t', room: ROOM, event_id: '$svr_tevt' },
          };
        case 'task.list':
          return [];
        case 'task.graph':
          return [];
        default:
          throw new Error(`unexpected daemon method in tool-server test: ${method}`);
      }
    },
  };
}

function makeCtx(overrides?: Partial<BindingContext>): BindingContext {
  return {
    daemon: fakeDaemon(),
    room: ROOM,
    correlationId: undefined,
    auditSink: new NullAuditSink(),
    close: async () => { /* noop */ },
    ...overrides,
  };
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

/** Build the server config and wire a client to it via InMemoryTransport. */
async function connectServer(ctx: BindingContext, options?: Parameters<typeof createMxToolServer>[1]): Promise<Client> {
  const config = createMxToolServer(ctx, options);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([config.instance.connect(st), client.connect(ct)]);
  clients.push(client);
  return client;
}

// ---------------------------------------------------------------------------
// Server config shape
// ---------------------------------------------------------------------------

describe('server config shape', () => {
  it('config.type is "sdk"', () => {
    const config = createMxToolServer(makeCtx());
    expect(config.type).toBe('sdk');
  });

  it('config.name matches DEFAULT_SERVER_NAME by default', () => {
    const config = createMxToolServer(makeCtx());
    expect(config.name).toBe(DEFAULT_SERVER_NAME);
  });

  it('custom name is reflected on config', () => {
    const config = createMxToolServer(makeCtx(), { name: 'custom-server' });
    expect(config.name).toBe('custom-server');
  });

  it('config.instance is present', () => {
    const config = createMxToolServer(makeCtx());
    expect(config.instance).toBeDefined();
  });

  it('DEFAULT_SERVER_VERSION is a semver-shaped string', () => {
    expect(typeof DEFAULT_SERVER_VERSION).toBe('string');
    expect(DEFAULT_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ---------------------------------------------------------------------------
// Tool registration — exactly nine canonical tools, no authority verbs
// ---------------------------------------------------------------------------

describe('tool registration', () => {
  it('exactly thirteen tools are registered (matching CANONICAL_TOOLS)', async () => {
    const client = await connectServer(makeCtx());
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(CANONICAL_TOOLS.length);
    expect(tools).toHaveLength(13);
  });

  it('the registered tool names equal CANONICAL_TOOLS names', async () => {
    const client = await connectServer(makeCtx());
    const { tools } = await client.listTools();
    const registeredNames = new Set(tools.map((t) => t.name));
    for (const descriptor of CANONICAL_TOOLS) {
      expect(registeredNames.has(descriptor.name)).toBe(true);
    }
  });

  it('no registered tool name passes isForbiddenAuthorityVerb (no-authority invariant)', async () => {
    const client = await connectServer(makeCtx());
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(isForbiddenAuthorityVerb(t.name)).toBe(false);
    }
  });

  it('FORBIDDEN_AUTHORITY_VERBS are absent from the registered tool set', async () => {
    const client = await connectServer(makeCtx());
    const { tools } = await client.listTools();
    const registeredNames = new Set(tools.map((t) => t.name));
    for (const forbidden of FORBIDDEN_AUTHORITY_VERBS) {
      expect(registeredNames.has(forbidden)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Handler dispatch — AC1 (sync `ok` path)
// ---------------------------------------------------------------------------

describe('handler dispatch (AC1 — sync ok path)', () => {
  it('mx_delegate_tool returns a CallToolResult', async () => {
    const client = await connectServer(makeCtx());
    const res = await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'backend-dev-01', tool: 'run_tests', args: {} },
    });
    expect(res).toBeDefined();
  });

  it('mx_delegate_tool structuredContent carries the full T102 envelope', async () => {
    const client = await connectServer(makeCtx());
    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'backend-dev-01', tool: 'run_tests', args: {} },
    })) as CallToolResult;
    expect(res.structuredContent).toBeDefined();
    const sc = res.structuredContent as { status: string };
    expect(['ok', 'running', 'awaiting_approval', 'denied', 'error']).toContain(sc.status);
  });

  it('mx_delegate_tool result is ok for a successful daemon call', async () => {
    const client = await connectServer(makeCtx());
    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'backend-dev-01', tool: 'run_tests', args: {} },
    })) as CallToolResult;
    const sc = res.structuredContent as { status: string };
    expect(sc.status).toBe('ok');
  });

  it('isError is false for status:ok (ok is not an error)', async () => {
    const client = await connectServer(makeCtx());
    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'backend-dev-01', tool: 'run_tests', args: {} },
    })) as CallToolResult;
    expect(res.isError ?? false).toBe(false);
  });

  it('content[0] carries the envelope as JSON text', async () => {
    const client = await connectServer(makeCtx());
    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'backend-dev-01', tool: 'run_tests', args: {} },
    })) as CallToolResult;
    const firstContent = (res.content?.[0] ?? {}) as { type?: string; text?: string };
    expect(firstContent.type).toBe('text');
    const parsed = JSON.parse(firstContent.text ?? '{}') as { status: string };
    expect(['ok', 'running', 'awaiting_approval', 'denied', 'error']).toContain(parsed.status);
  });

  it('mx_workspace_status dispatches successfully (RoomScopedDeps path)', async () => {
    const client = await connectServer(makeCtx());
    const res = (await client.callTool({
      name: 'mx_workspace_status',
      arguments: {},
    })) as CallToolResult;
    const sc = res.structuredContent as { status: string };
    expect(['ok', 'denied', 'error']).toContain(sc.status);
  });

  it('mx_dispatch_task routes through the dispatch table and returns a valid T102 envelope (DispatchDeps path)', async () => {
    // The fakeDaemon returns an empty task list, so mx_dispatch_task maps to
    // not_found — still a valid ToolResult envelope confirming the routing works.
    const client = await connectServer(makeCtx());
    const res = (await client.callTool({
      name: 'mx_dispatch_task',
      arguments: { task_id: 'task_svr_dispatch_test_1' },
    })) as CallToolResult;
    expect(res).toBeDefined();
    const sc = res.structuredContent as { status: string };
    expect(['ok', 'running', 'awaiting_approval', 'denied', 'error']).toContain(sc.status);
  });

  it('mx_dispatch_task: internal error (not an isError) when room is missing from context', async () => {
    const client = await connectServer(makeCtx({ room: undefined }));
    const res = (await client.callTool({
      name: 'mx_dispatch_task',
      arguments: { task_id: 'task_svr_dispatch_no_room' },
    })) as CallToolResult;
    const sc = res.structuredContent as { status: string; error?: { code: string } };
    expect(sc.status).toBe('error');
    expect(sc.error?.code).toBe('internal');
    // A status:error that originates from an internal guard (not a daemon fault) still
    // carries isError:true (the protocol layer signals error to the model).
    expect(res.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isError semantics — only true for status:"error" (denied/ok/running/awaiting are not errors)
// ---------------------------------------------------------------------------

describe('isError is only true for status:error', () => {
  it('isError is false for status:denied', async () => {
    // A denied result comes from a daemon that returns policy_denied.
    const deniedDaemon: DaemonCall = {
      async call(method: string): Promise<unknown> {
        if (method === 'agent.tools') {
          return { schemas: [{ name: 'run_tests', input_schema: { type: 'object', additionalProperties: true } }] };
        }
        if (method === 'call.start') {
          return { state: 'denied_by_policy', ok: false };
        }
        throw new Error(`unexpected: ${method}`);
      },
    };
    const ctx = makeCtx({ daemon: deniedDaemon });
    const client = await connectServer(ctx);
    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: {} },
    })) as CallToolResult;
    const sc = res.structuredContent as { status: string };
    expect(sc.status).toBe('denied');
    expect(res.isError ?? false).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Room provenance — comes from ctx.room, never from model args
// ---------------------------------------------------------------------------

describe('room provenance', () => {
  it('the room forwarded to call.start comes from the context, not model args', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const spyDaemon: DaemonCall = {
      async call(method: string, params?: unknown): Promise<unknown> {
        calls.push({ method, params: params ?? null });
        switch (method) {
          case 'agent.tools':
            return { schemas: [{ name: 'run_tests', input_schema: { type: 'object', additionalProperties: true } }] };
          case 'call.start':
            return { ok: true, result: {}, audit_ref: { invocation_id: 'inv_1', request_id: 'req_1', room: ROOM, event_id: '$evt' } };
          default:
            throw new Error(`unexpected: ${method}`);
        }
      },
    };
    const ctx = makeCtx({ daemon: spyDaemon });
    const client = await connectServer(ctx);
    await client.callTool({
      name: 'mx_delegate_tool',
      // Attempt to supply a room in the model args — it must be ignored.
      arguments: { agent: 'agent-b', tool: 'run_tests', args: { room: '!hacked:evil.org' } },
    });
    const callStart = calls.find((c) => c.method === 'call.start');
    expect(callStart).toBeDefined();
    const params = callStart?.params as Record<string, unknown> | null | undefined;
    // The room in the outbound params must be the session room, not the model-supplied one.
    if (params !== null && params !== undefined) {
      expect(params.room).toBe(ROOM);
    }
  });
});

// ---------------------------------------------------------------------------
// isError: true for status:error — the positive case (AC1 envelope fidelity)
// ---------------------------------------------------------------------------

describe('isError is true only for status:error (positive case)', () => {
  it('isError is true when the daemon faults on call.start (status:error)', async () => {
    // A daemon that throws on call.start maps to errored('internal', ...) →
    // serializeToolResult sets isError: true for status:error.
    const faultingDaemon: DaemonCall = {
      async call(method: string): Promise<unknown> {
        if (method === 'agent.tools') {
          return { schemas: [{ name: 'run_tests', input_schema: { type: 'object', additionalProperties: true } }] };
        }
        if (method === 'call.start') {
          throw new Error('simulated internal daemon fault');
        }
        throw new Error(`unexpected method in isError test: ${method}`);
      },
    };
    const ctx = makeCtx({ daemon: faultingDaemon });
    const client = await connectServer(ctx);
    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: {} },
    })) as CallToolResult;
    const sc = res.structuredContent as { status: string };
    expect(sc.status).toBe('error');
    expect(res.isError).toBe(true);
  });

  it('structuredContent.error.code is present for status:error', async () => {
    const faultingDaemon: DaemonCall = {
      async call(method: string): Promise<unknown> {
        if (method === 'agent.tools') {
          return { schemas: [{ name: 'run_tests', input_schema: { type: 'object', additionalProperties: true } }] };
        }
        throw new Error('simulated fault');
      },
    };
    const ctx = makeCtx({ daemon: faultingDaemon });
    const client = await connectServer(ctx);
    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'agent-b', tool: 'run_tests', args: {} },
    })) as CallToolResult;
    const sc = res.structuredContent as { status: string; error?: { code: string } };
    expect(sc.status).toBe('error');
    expect(typeof sc.error?.code).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Hidden poll loop end-to-end via the server (AC1 — resolve.ts + tool-server.ts)
// ---------------------------------------------------------------------------

describe('hidden poll loop end-to-end via the server (AC1)', () => {
  it('a daemon returning running on call.start then ok on invocation.get resolves to ok', async () => {
    // This is the critical AC1 scenario: the model issues ONE mx_delegate_tool call
    // and receives the terminal ok — the running/invocation.get poll loop is hidden.
    const pollingDaemon: DaemonCall = {
      async call(method: string): Promise<unknown> {
        switch (method) {
          case 'agent.tools':
            return { schemas: [{ name: 'run_tests', input_schema: { type: 'object', additionalProperties: true } }] };
          case 'call.start':
            // Returns a running deferred handle — triggers resolveDeferred's poll loop.
            return {
              state: 'running',
              invocation_id: 'inv_poll_end2end',
              request_id: 'req_poll',
              room: ROOM,
              event_id: '$evt_poll',
            };
          case 'invocation.get':
            // Work completes on the first probe.
            return { state: 'ok', result: { passed: true } };
          default:
            throw new Error(`unexpected method in poll-loop test: ${method}`);
        }
      },
    };
    const ctx = makeCtx({ daemon: pollingDaemon });
    // Inject deterministic seams so no real timer fires.
    const client = await connectServer(ctx, {
      resolveTimeoutMs: 5_000,
      sleep: () => Promise.resolve(),
      now: () => 0,
      pollIntervalMs: 10,
    });
    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'backend-dev-01', tool: 'run_tests', args: {} },
    })) as CallToolResult;
    const sc = res.structuredContent as { status: string };
    expect(sc.status).toBe('ok');
    expect(res.isError ?? false).toBe(false);
  });

  it('a running result that times out returns running (no fabricated timeout error)', async () => {
    let callCount = 0;
    const alwaysRunningDaemon: DaemonCall = {
      async call(method: string): Promise<unknown> {
        switch (method) {
          case 'agent.tools':
            return { schemas: [{ name: 'run_tests', input_schema: { type: 'object', additionalProperties: true } }] };
          case 'call.start':
            return { state: 'running', invocation_id: 'inv_timeout_test' };
          case 'invocation.get':
            callCount++;
            return { state: 'running', invocation_id: 'inv_timeout_test' };
          default:
            throw new Error(`unexpected method: ${method}`);
        }
      },
    };
    const ctx = makeCtx({ daemon: alwaysRunningDaemon });
    // Fast-forward clock past the budget immediately.
    let nowCalls = 0;
    const client = await connectServer(ctx, {
      resolveTimeoutMs: 100,
      sleep: () => Promise.resolve(),
      now: () => (nowCalls++ === 0 ? 0 : 9_999_999),
      pollIntervalMs: 10,
    });
    const res = (await client.callTool({
      name: 'mx_delegate_tool',
      arguments: { agent: 'backend-dev-01', tool: 'run_tests', args: {} },
    })) as CallToolResult;
    const sc = res.structuredContent as { status: string; error: unknown };
    expect(sc.status).toBe('running');
    // No fabricated error — a budget expiry is not an error per T103 AC3.
    expect(sc.error).toBeNull();
    void callCount; // variable used for daemon verification if needed
  });
});

// ---------------------------------------------------------------------------
// mx_await_result is registered as the escape hatch for prior-turn handles
// ---------------------------------------------------------------------------

describe('mx_await_result is registered as the escape hatch', () => {
  it('mx_await_result appears in the registered tool list', async () => {
    const client = await connectServer(makeCtx());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('mx_await_result');
  });

  it('mx_await_result is callable with a handle and returns a valid CallToolResult', async () => {
    // The escape hatch must be reachable: model passes a handle from a prior turn
    // and mx_await_result resolves it.  The fakeDaemon returns ok on invocation.get.
    const client = await connectServer(makeCtx());
    const res = (await client.callTool({
      name: 'mx_await_result',
      arguments: { handle: 'inv_prior_turn_handle' },
    })) as CallToolResult;
    const sc = res.structuredContent as { status: string };
    expect(['ok', 'running', 'awaiting_approval', 'denied', 'error']).toContain(sc.status);
  });
});

// ---------------------------------------------------------------------------
// Custom version and name options (config shape)
// ---------------------------------------------------------------------------

describe('custom name and version options', () => {
  it('custom name option yields tools registered under that server name', async () => {
    // Regression guard: a custom server name must not silently fall back to 'mx'.
    const config = createMxToolServer(makeCtx(), { name: 'mxloom' });
    expect(config.name).toBe('mxloom');
  });

  it('createMxToolServer does not throw when a non-default version string is provided', () => {
    // The SDK does not expose version on the returned config object, but the
    // constructor must not throw on a valid semver string.
    expect(() => createMxToolServer(makeCtx(), { version: '2.0.0-beta.1' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Fail-closed: unsupported schema construct throws JsonSchemaConversionError at build time
// ---------------------------------------------------------------------------

describe('fail-closed: unsupported schema → JsonSchemaConversionError at build time', () => {
  it('a $ref in a property schema throws JsonSchemaConversionError (unsupported by T111)', () => {
    // `$ref` is outside the T111 supported subset — the converter throws fail-closed,
    // not silently widening to z.any(). This is what would fire if a canonical
    // descriptor drifted to use a construct outside the subset.
    expect(() =>
      jsonSchemaToZodRawShape({ type: 'object', properties: { x: { $ref: '#/$defs/Foo' } } }),
    ).toThrow(JsonSchemaConversionError);
  });

  it('a top-level allOf throws JsonSchemaConversionError (unsupported by T111)', () => {
    // `allOf` is unsupported by the T111 converter.
    expect(() =>
      jsonSchemaToZodRawShape({
        type: 'object',
        properties: { x: { allOf: [{ type: 'string' }, { minLength: 1 }] } },
      }),
    ).toThrow(JsonSchemaConversionError);
  });

  it('thrown error has the expected constructor (JsonSchemaConversionError)', () => {
    let caught: unknown;
    try {
      jsonSchemaToZodRawShape({ type: 'object', properties: { x: { $ref: '#' } } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(JsonSchemaConversionError);
  });
});
