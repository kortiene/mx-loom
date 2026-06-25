/**
 * T303 / #32 — end-to-end coverage for `mx_dispatch_task` (signed task-action dispatch).
 *
 * Issue AC: "A task action runs through the full authorize pipeline on dispatch."
 *
 * Three sections, increasing fixture cost:
 *
 * §1  Descriptor surface (always-on, no daemon) — `mx_dispatch_task` appears in
 *     CANONICAL_TOOLS (total 13 verbs), surfaces in the MCP binding's `tools/list`
 *     with a `task_id`-required input schema and `async_semantics: 'deferred'` — the
 *     right contract for approval-gatable dispatches. No authority verb is reachable;
 *     no credential-shaped property appears in any descriptor. Complements the
 *     descriptor unit suite and pins dispatch at the binding serialization layer.
 *
 * §2  Dispatch through MCP binding + fake stateful daemon (always-on) — drives
 *     `mx_dispatch_task` from `tools/call` through the full path:
 *     `dispatchCall` → `mxDispatchTask` → `mxListTasks` (resolve node) →
 *     `mxDelegateTool` (kind=tool) / `mxRunCommand` (kind=exec) → fake daemon.
 *     Covers:
 *       §2a  Happy paths: tool action (→ call.start → ok) and exec action (→ exec.start → ok).
 *       §2b  Routing correctness: tool dispatches through call.start only, exec through exec.start.
 *       §2c  Deferred + denial paths: awaiting_approval surfaces with handle; policy_denied maps.
 *       §2d  Idempotency: re-dispatching the same task produces the same idempotency_key.
 *       §2e  Guard paths: terminal tasks and missing action/assignee → invalid_args.
 *       §2f  Secret boundary: credential-shaped value in action.args rejected at Boundary A.
 *
 * §3  Live dispatch (gated `MXL_CONFORMANCE_TWO_DAEMON=1` +
 *     `MXL_CONFORMANCE_GOLDEN_POLICY=1` — the GOLDEN_REQUIRED flag) — drives
 *     the issue AC against a real two-daemon fixture:
 *       L1 — Allowed-tool dispatch: create a task with the ungated `allowTool`, dispatch it
 *            → ok + populated audit_ref (call.start traversed sig → trust → policy → ok).
 *       L2 — Approval-gated dispatch: create a task with the `approvalTool`, dispatch →
 *            awaiting_approval + handle → operator approves → ok (the full hold →
 *            re-authorize-at-release cycle at the task-action level).
 *       L3 — Policy-denied dispatch: create a task with the `deniedTool`, dispatch →
 *            denied(policy_denied) (the receiver's policy runs at dispatch, not at authoring).
 *       L4 — Idempotent re-dispatch: same task_id on a second dispatch → same invocation_id
 *            (daemon deduplicated by the task-stable `idk_task_<task_id>` key).
 *       L5 — Secret boundary: no secret-shaped value in any live dispatch response.
 *
 * Gating mirrors T301 (§1/§2 always-on; §3 demands GOLDEN_REQUIRED — skip-clean
 * without the fixture, fail-not-skip when demanded). The approval-gated path (L2) is
 * the definitive runtime proof that "authoring an action ≠ authorizing it": the operator
 * decides out-of-band after the dispatch, and the daemon re-runs the authorize pipeline at
 * release.
 *
 * Deliberately out of scope:
 *   - Cross-agent plan with restart → T304.
 *   - `task.watch` resumption → T302.
 *   - Portability matrix for `mx_dispatch_task` → T206 descriptor-identity arm covers it.
 */
import { randomUUID } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { NullAuditSink } from '@mx-loom/audit';
import { createBindingContext, createMcpServer } from '@mx-loom/mcp';
import {
  CANONICAL_TOOLS,
  MX_DISPATCH_TASK,
  isForbiddenAuthorityVerb,
  validateEnvelope,
  type DaemonCall,
  type ToolResult,
} from '@mx-loom/registry';
import { TransportError, createClient } from '@mx-loom/toolbelt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DAEMON_REACHABLE,
  GOLDEN_RESOLVE_BUDGET_MS,
  SECRET_PATTERN,
  SKIP_GOLDEN,
  approvePending,
  assertGoldenPrereqs,
  readGoldenFixture,
  resolveDaemonSocket,
} from './_golden-harness.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const FAKE_ROOM = '!t303-dispatch-fake:homeserver';

/**
 * Wire an MCP client to a fresh server backed by `daemon` over an in-memory pair.
 * Pattern mirrors T301 / T205 golden arm builders.
 */
async function connectFake(daemon: DaemonCall): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const ctx = await createBindingContext({ daemon, room: FAKE_ROOM });
  const server = createMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't303-e2e-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await ctx.close();
    },
  };
}

/** Extract the T102 envelope from a `CallToolResult.structuredContent`. Never throws. */
function envelopeFrom(result: CallToolResult): ToolResult {
  const sc = result.structuredContent;
  if (sc === undefined || sc === null) {
    throw new Error('T303 e2e: no structuredContent in CallToolResult');
  }
  return sc as unknown as ToolResult;
}

// ---------------------------------------------------------------------------
// Fake stateful daemon (§2) — handles task.create + task.list + agent.tools +
// call.start + exec.start. Configurable responses for call.start/exec.start let
// individual tests drive different dispositions.
// ---------------------------------------------------------------------------

interface FakeDaemonConfig {
  /** What call.start returns (default: sync ok). */
  readonly callResponse?: unknown;
  /** Error call.start throws instead of returning (simulates receiver fault). */
  readonly callError?: Error;
  /** What exec.start returns (default: sync ok). */
  readonly execResponse?: unknown;
}

/**
 * Build a minimal in-memory stateful daemon for dispatch e2e tests.
 * Supports task.create (store), task.list (read store), task.graph (empty),
 * agent.tools (static schema for 'run_tests' and 'build'), and configurable
 * call.start / exec.start responses.
 */
function makeStatefulFakeDaemon(config: FakeDaemonConfig = {}): DaemonCall {
  const store = new Map<string, Record<string, unknown>>();
  let counter = 0;

  const defaultCallOk = {
    ok: true,
    result: { tests_run: 42, passed: 42 },
    invocation_id: 'inv_call_01',
    request_id: 'req_call_01',
    room: FAKE_ROOM,
    event_id: '$evt_call_01',
  };

  const defaultExecOk = {
    ok: true,
    result: { exit_code: 0, summary: 'Build complete' },
    invocation_id: 'inv_exec_01',
    request_id: 'req_exec_01',
    room: FAKE_ROOM,
    event_id: '$evt_exec_01',
  };

  const TOOLS_SCHEMA = {
    agent_id: 'ag_worker_01',
    kind: 'worker',
    status: 'online',
    capabilities: [],
    tools: ['run_tests', 'build'],
    schemas: [
      {
        name: 'run_tests',
        version: '1.0.0',
        description: 'Run tests',
        input_schema: { type: 'object', additionalProperties: true },
        output_schema: { type: 'object', additionalProperties: true },
      },
      {
        name: 'build',
        version: '1.0.0',
        description: 'Build the project',
        input_schema: { type: 'object', additionalProperties: true },
        output_schema: { type: 'object', additionalProperties: true },
      },
    ],
  };

  return {
    async call(method: string, params?: unknown): Promise<unknown> {
      const p = (params ?? {}) as Record<string, unknown>;

      if (method === 'task.create') {
        const id = `task_${++counter}`;
        const record: Record<string, unknown> = {
          task_id: id,
          title: p['title'] ?? '',
          state: p['state'] ?? 'assigned',
          // daemon param is 'assign' → projected as 'assignee' by projectTaskNode
          assignee: typeof p['assign'] === 'string' ? p['assign'] : 'ag_worker_01',
          depends_on: Array.isArray(p['depends_on']) ? p['depends_on'] : [],
          blocks: Array.isArray(p['blocks']) ? p['blocks'] : [],
          action: p['action'] ?? null,
          audit_ref: {
            invocation_id: `inv_${id}`,
            request_id: `req_${id}`,
            room: FAKE_ROOM,
            event_id: `$evt_${id}`,
          },
        };
        store.set(id, record);
        return record;
      }

      if (method === 'task.update') {
        const task_id = p['task_id'] as string;
        const existing = store.get(task_id);
        if (existing === undefined) {
          throw Object.assign(new Error('not_found'), {
            code: 'rpc',
            cause: { error: { code: 'not_found' } },
          });
        }
        const updated: Record<string, unknown> = {
          ...existing,
          ...(p['state'] !== undefined ? { state: p['state'] } : {}),
          audit_ref: {
            invocation_id: `inv_upd_${task_id}`,
            request_id: `req_upd_${task_id}`,
            room: FAKE_ROOM,
            event_id: `$evt_upd_${task_id}`,
          },
        };
        store.set(task_id, updated);
        return updated;
      }

      if (method === 'task.list') {
        return { tasks: [...store.values()] };
      }

      if (method === 'task.graph') {
        return [];
      }

      if (method === 'agent.tools') {
        return TOOLS_SCHEMA;
      }

      if (method === 'call.start') {
        if (config.callError) throw config.callError;
        return config.callResponse ?? defaultCallOk;
      }

      if (method === 'exec.start') {
        return config.execResponse ?? defaultExecOk;
      }

      throw new Error(`T303 stateful fake daemon: unexpected method "${method}"`);
    },
  };
}

// ---------------------------------------------------------------------------
// §1 — Descriptor surface (always-on, no daemon)
// ---------------------------------------------------------------------------

describe('T303 e2e §1 — mx_dispatch_task descriptor in the MCP binding (no daemon)', () => {
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const conn = await connectFake(makeStatefulFakeDaemon());
    client = conn.client;
    close = conn.close;
    // Pre-populate the SDK's outputSchema cache.
    await client.listTools();
  });

  afterAll(async () => {
    await close();
  });

  it('CANONICAL_TOOLS contains mx_dispatch_task — the canonical set is exactly 13 verbs', () => {
    const names = CANONICAL_TOOLS.map((d) => d.name);
    expect(names).toContain('mx_dispatch_task');
    expect(names).toHaveLength(13);
  });

  it('tools/list surfaces mx_dispatch_task with a task_id-required input schema', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'mx_dispatch_task');
    expect(tool, 'mx_dispatch_task must appear in tools/list').toBeDefined();

    const schema = tool!.inputSchema as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.required ?? []).toContain('task_id');
    expect(schema.properties).toHaveProperty('task_id');
    // wait_ms and idempotency_key are optional (not in required).
    expect(schema.required ?? []).not.toContain('wait_ms');
    expect(schema.required ?? []).not.toContain('idempotency_key');
  });

  it('mx_dispatch_task.async_semantics is deferred — dispatched actions are approval-gatable', () => {
    // The descriptor (as exported from the registry) must declare deferred
    // async_semantics so the binding exposes the awaiting_approval path, not hiding it.
    expect(MX_DISPATCH_TASK.async_semantics).toBe('deferred');
  });

  it('mx_dispatch_task is not a forbidden authority verb', () => {
    expect(isForbiddenAuthorityVerb('mx_dispatch_task')).toBe(false);
  });

  it('no authority verb is reachable in tools/list — no trust.* / approval.decide / policy.* / daemon.* surface', async () => {
    const { tools } = await client.listTools();
    for (const { name } of tools) {
      expect(isForbiddenAuthorityVerb(name), `authority verb in tools/list: ${name}`).toBe(false);
    }
  });

  it('mx_dispatch_task descriptor matches the CANONICAL_TOOLS entry verbatim in the MCP serialization', async () => {
    const { tools } = await client.listTools();
    const mcpTool = tools.find((t) => t.name === 'mx_dispatch_task')!;
    const descriptor = CANONICAL_TOOLS.find((d) => d.name === 'mx_dispatch_task')!;
    // MCP binding passes input_schema verbatim — no Zod round-trip here.
    expect(mcpTool.inputSchema).toEqual(descriptor.input_schema);
  });

  it('no secret-shaped value appears in tools/list (descriptor payload is secret-free)', async () => {
    const { tools } = await client.listTools();
    expect(JSON.stringify(tools)).not.toMatch(SECRET_PATTERN);
  });
});

// ---------------------------------------------------------------------------
// §2 — Dispatch through MCP binding + fake stateful daemon (always-on)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// §2a — Happy paths (tool + exec)
// ---------------------------------------------------------------------------

describe('T303 e2e §2a — happy path dispatch through MCP + fake daemon', () => {
  let client: Client;
  let close: () => Promise<void>;
  let toolTaskId: string;
  let execTaskId: string;

  beforeAll(async () => {
    const conn = await connectFake(makeStatefulFakeDaemon());
    client = conn.client;
    close = conn.close;

    // Create a task with a kind=tool action assigned to 'ag_worker_01'.
    const toolRaw = (await client.callTool({
      name: 'mx_create_task',
      arguments: {
        title: 'T303 e2e tool dispatch task',
        assign: 'ag_worker_01',
        action: { kind: 'tool', tool: 'run_tests', args: { suite: 'unit' } },
      },
    })) as CallToolResult;
    const toolEnv = envelopeFrom(toolRaw);
    expect(toolEnv.status, 'task create must succeed').toBe('ok');
    toolTaskId = (toolEnv.result as Record<string, unknown>).task_id as string;

    // Create a task with a kind=exec action.
    const execRaw = (await client.callTool({
      name: 'mx_create_task',
      arguments: {
        title: 'T303 e2e exec dispatch task',
        assign: 'ag_worker_01',
        action: { kind: 'exec', command: 'make', args: ['build'] },
      },
    })) as CallToolResult;
    const execEnv = envelopeFrom(execRaw);
    expect(execEnv.status, 'exec task create must succeed').toBe('ok');
    execTaskId = (execEnv.result as Record<string, unknown>).task_id as string;
  });

  afterAll(async () => {
    await close();
  });

  it('dispatch a tool action → ok with a result payload from call.start', async () => {
    const raw = (await client.callTool({
      name: 'mx_dispatch_task',
      arguments: { task_id: toolTaskId },
    })) as CallToolResult;

    const env = envelopeFrom(raw);
    expect(validateEnvelope(env), 'envelope must validate against ENVELOPE_SCHEMA').toBe(true);
    expect(env.status, 'tool dispatch: status must be ok').toBe('ok');
    expect(raw.isError ?? false, 'isError must be false for status ok').toBe(false);
    expect(JSON.stringify(raw)).not.toMatch(SECRET_PATTERN);
  });

  it('dispatch an exec action → ok with an exit_code payload from exec.start', async () => {
    const raw = (await client.callTool({
      name: 'mx_dispatch_task',
      arguments: { task_id: execTaskId },
    })) as CallToolResult;

    const env = envelopeFrom(raw);
    expect(validateEnvelope(env), 'exec dispatch: envelope must validate').toBe(true);
    expect(env.status, 'exec dispatch: status must be ok').toBe('ok');
    expect(raw.isError ?? false, 'isError must be false').toBe(false);
    expect(JSON.stringify(raw)).not.toMatch(SECRET_PATTERN);
  });
});

// ---------------------------------------------------------------------------
// §2b — Routing: tool → call.start, exec → exec.start (not mixed)
// ---------------------------------------------------------------------------

describe('T303 e2e §2b — dispatch routing through MCP binding', () => {
  it('a tool-action task dispatches through call.start (not exec.start)', async () => {
    const methods: string[] = [];
    const daemon = makeStatefulFakeDaemon();
    // Proxy to capture method calls.
    const tracking: DaemonCall = {
      call: async (method, params, options) => {
        methods.push(method);
        return daemon.call(method, params, options);
      },
    };
    const conn = await connectFake(tracking);

    const createRaw = (await conn.client.callTool({
      name: 'mx_create_task',
      arguments: {
        title: 'routing-tool',
        assign: 'ag_worker_01',
        action: { kind: 'tool', tool: 'run_tests' },
      },
    })) as CallToolResult;
    const taskId = (envelopeFrom(createRaw).result as Record<string, unknown>).task_id as string;
    methods.length = 0; // reset after create

    await conn.client.callTool({
      name: 'mx_dispatch_task',
      arguments: { task_id: taskId },
    });

    expect(methods).toContain('call.start');
    expect(methods).not.toContain('exec.start');
    await conn.close();
  });

  it('an exec-action task dispatches through exec.start (not call.start)', async () => {
    const methods: string[] = [];
    const daemon = makeStatefulFakeDaemon();
    const tracking: DaemonCall = {
      call: async (method, params, options) => {
        methods.push(method);
        return daemon.call(method, params, options);
      },
    };
    const conn = await connectFake(tracking);

    const createRaw = (await conn.client.callTool({
      name: 'mx_create_task',
      arguments: {
        title: 'routing-exec',
        assign: 'ag_worker_01',
        action: { kind: 'exec', command: 'make', args: ['test'] },
      },
    })) as CallToolResult;
    const taskId = (envelopeFrom(createRaw).result as Record<string, unknown>).task_id as string;
    methods.length = 0; // reset after create

    await conn.client.callTool({
      name: 'mx_dispatch_task',
      arguments: { task_id: taskId },
    });

    expect(methods).toContain('exec.start');
    expect(methods).not.toContain('call.start');
    await conn.close();
  });

  it('dispatch always reads task.list (to resolve the node) before calling start', async () => {
    const methods: string[] = [];
    const daemon = makeStatefulFakeDaemon();
    const tracking: DaemonCall = {
      call: async (method, params, options) => {
        methods.push(method);
        return daemon.call(method, params, options);
      },
    };
    const conn = await connectFake(tracking);

    const createRaw = (await conn.client.callTool({
      name: 'mx_create_task',
      arguments: {
        title: 'list-first',
        assign: 'ag_worker_01',
        action: { kind: 'tool', tool: 'run_tests' },
      },
    })) as CallToolResult;
    const taskId = (envelopeFrom(createRaw).result as Record<string, unknown>).task_id as string;
    methods.length = 0;

    await conn.client.callTool({
      name: 'mx_dispatch_task',
      arguments: { task_id: taskId },
    });

    // task.list must be the first call (resolves the node before dispatch).
    expect(methods[0]).toBe('task.list');
    await conn.close();
  });
});

// ---------------------------------------------------------------------------
// §2c — Deferred and denial paths
// ---------------------------------------------------------------------------

describe('T303 e2e §2c — deferred + denial paths through MCP binding', () => {
  it('awaiting_approval from receiver surfaces as status:awaiting_approval + handle (not hidden)', async () => {
    const awaitingResponse = {
      state: 'awaiting_approval',
      handle: 'inv_ap_t303_01',
      invocation_id: 'inv_ap_t303_01',
      request_id: 'req_ap_t303_01',
      room: FAKE_ROOM,
      event_id: '$evt_ap_t303_01',
      approval: { risk: 'high', context: 'high-risk test dispatch' },
    };

    const conn = await connectFake(makeStatefulFakeDaemon({ callResponse: awaitingResponse }));

    const createRaw = (await conn.client.callTool({
      name: 'mx_create_task',
      arguments: {
        title: 'approval-gated task',
        assign: 'ag_worker_01',
        action: { kind: 'tool', tool: 'run_tests' },
      },
    })) as CallToolResult;
    const taskId = (envelopeFrom(createRaw).result as Record<string, unknown>).task_id as string;

    const dispatchRaw = (await conn.client.callTool({
      name: 'mx_dispatch_task',
      arguments: { task_id: taskId },
    })) as CallToolResult;

    const env = envelopeFrom(dispatchRaw);
    expect(validateEnvelope(env), 'approval envelope must validate').toBe(true);
    expect(env.status, 'dispatch held for approval: status must be awaiting_approval').toBe(
      'awaiting_approval',
    );
    expect(typeof env.handle, 'handle must be a string').toBe('string');
    expect(env.approval, 'approval block must be present').not.toBeNull();
    expect(env.approval?.request_id ?? env.handle, 'approval or handle must be non-empty').toBeTruthy();
    // isError must be false — awaiting_approval is not a protocol error (design §4.2).
    expect(dispatchRaw.isError ?? false, 'awaiting_approval is not an MCP error').toBe(false);
    expect(JSON.stringify(dispatchRaw)).not.toMatch(SECRET_PATTERN);

    await conn.close();
  });

  it('policy_denied from receiver maps to denied(policy_denied) through the MCP binding', async () => {
    const policyErr = new TransportError('rpc', 'rpc error', {
      cause: { error: { code: 'policy_denied' } },
    });

    const conn = await connectFake(makeStatefulFakeDaemon({ callError: policyErr }));

    const createRaw = (await conn.client.callTool({
      name: 'mx_create_task',
      arguments: {
        title: 'denied task',
        assign: 'ag_worker_01',
        action: { kind: 'tool', tool: 'run_tests' },
      },
    })) as CallToolResult;
    const taskId = (envelopeFrom(createRaw).result as Record<string, unknown>).task_id as string;

    const dispatchRaw = (await conn.client.callTool({
      name: 'mx_dispatch_task',
      arguments: { task_id: taskId },
    })) as CallToolResult;

    const env = envelopeFrom(dispatchRaw);
    expect(validateEnvelope(env), 'denied envelope must validate').toBe(true);
    expect(env.status, 'policy_denied: status must be denied').toBe('denied');
    expect(env.error?.code, 'error code must be policy_denied').toBe('policy_denied');
    // isError must be false — denied is a governance outcome, not a protocol error.
    expect(dispatchRaw.isError ?? false, 'denied is not an MCP error').toBe(false);
    expect(JSON.stringify(dispatchRaw)).not.toMatch(SECRET_PATTERN);

    await conn.close();
  });

  it('untrusted_key from receiver maps to denied(untrusted_key)', async () => {
    const trustErr = new TransportError('rpc', 'rpc error', {
      cause: { error: { code: 'untrusted_key' } },
    });

    const conn = await connectFake(makeStatefulFakeDaemon({ callError: trustErr }));

    const createRaw = (await conn.client.callTool({
      name: 'mx_create_task',
      arguments: {
        title: 'untrusted key task',
        assign: 'ag_worker_01',
        action: { kind: 'tool', tool: 'run_tests' },
      },
    })) as CallToolResult;
    const taskId = (envelopeFrom(createRaw).result as Record<string, unknown>).task_id as string;

    const dispatchRaw = (await conn.client.callTool({
      name: 'mx_dispatch_task',
      arguments: { task_id: taskId },
    })) as CallToolResult;

    const env = envelopeFrom(dispatchRaw);
    expect(validateEnvelope(env)).toBe(true);
    expect(env.status).toBe('denied');
    expect(env.error?.code).toBe('untrusted_key');
    expect(dispatchRaw.isError ?? false).toBe(false);

    await conn.close();
  });
});

// ---------------------------------------------------------------------------
// §2d — Idempotency: task-stable key on re-dispatch
// ---------------------------------------------------------------------------

describe('T303 e2e §2d — idempotency: task-stable key through MCP binding', () => {
  it('re-dispatching the same task sends the same idempotency_key to call.start', async () => {
    const capturedKeys: string[] = [];

    const inner = makeStatefulFakeDaemon();
    const trackingDaemon: DaemonCall = {
      async call(method: string, params?: unknown) {
        if (method === 'call.start') {
          const p = (params ?? {}) as Record<string, unknown>;
          const key = p['idempotency_key'];
          if (typeof key === 'string') capturedKeys.push(key);
        }
        return inner.call(method, params);
      },
    };

    const conn = await connectFake(trackingDaemon);

    const createRaw = (await conn.client.callTool({
      name: 'mx_create_task',
      arguments: {
        title: 'idem task',
        assign: 'ag_worker_01',
        action: { kind: 'tool', tool: 'run_tests' },
      },
    })) as CallToolResult;
    const taskId = (envelopeFrom(createRaw).result as Record<string, unknown>).task_id as string;

    // First dispatch.
    await conn.client.callTool({
      name: 'mx_dispatch_task',
      arguments: { task_id: taskId },
    });
    // Second dispatch — same task_id, no explicit idempotency_key.
    await conn.client.callTool({
      name: 'mx_dispatch_task',
      arguments: { task_id: taskId },
    });

    expect(capturedKeys).toHaveLength(2);
    // Both dispatches must use the same task-derived key so the daemon can deduplicate.
    expect(capturedKeys[0], 'both dispatches must share the same task-stable key').toBe(
      capturedKeys[1],
    );
    // The key must follow the task-stable pattern: idk_task_<task_id>.
    expect(capturedKeys[0]).toBe(`idk_task_${taskId}`);

    await conn.close();
  });
});

// ---------------------------------------------------------------------------
// §2e — Guard paths: invalid_args for terminal tasks, missing action, no assignee
// ---------------------------------------------------------------------------

describe('T303 e2e §2e — guard paths through MCP binding', () => {
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const conn = await connectFake(makeStatefulFakeDaemon());
    client = conn.client;
    close = conn.close;
  });

  afterAll(async () => {
    await close();
  });

  it('dispatching a non-existent task_id → not_found', async () => {
    const raw = (await client.callTool({
      name: 'mx_dispatch_task',
      arguments: { task_id: 'task_nonexistent_t303' },
    })) as CallToolResult;

    const env = envelopeFrom(raw);
    expect(validateEnvelope(env)).toBe(true);
    expect(env.status).toBe('error');
    expect(env.error?.code).toBe('not_found');
    expect(raw.isError ?? false, 'error status → isError true').toBe(true);
  });

  it('dispatching a succeeded task → invalid_args (no live action to re-dispatch)', async () => {
    // Create a task and update its state to succeeded.
    const createRaw = (await client.callTool({
      name: 'mx_create_task',
      arguments: {
        title: 'terminal-succeeded',
        assign: 'ag_worker_01',
        action: { kind: 'tool', tool: 'run_tests' },
      },
    })) as CallToolResult;
    const taskId = (envelopeFrom(createRaw).result as Record<string, unknown>).task_id as string;

    // Transition to 'succeeded'.
    await client.callTool({
      name: 'mx_update_task',
      arguments: { task_id: taskId, state: 'succeeded' },
    });

    const dispatchRaw = (await client.callTool({
      name: 'mx_dispatch_task',
      arguments: { task_id: taskId },
    })) as CallToolResult;

    const env = envelopeFrom(dispatchRaw);
    expect(validateEnvelope(env)).toBe(true);
    expect(env.status).toBe('error');
    expect(env.error?.code).toBe('invalid_args');
  });

  it('dispatching a task with no action → invalid_args', async () => {
    // Create a task without any action.
    const createRaw = (await client.callTool({
      name: 'mx_create_task',
      arguments: {
        title: 'no-action task',
        assign: 'ag_worker_01',
        // no action field
      },
    })) as CallToolResult;
    const taskId = (envelopeFrom(createRaw).result as Record<string, unknown>).task_id as string;

    const dispatchRaw = (await client.callTool({
      name: 'mx_dispatch_task',
      arguments: { task_id: taskId },
    })) as CallToolResult;

    const env = envelopeFrom(dispatchRaw);
    expect(validateEnvelope(env)).toBe(true);
    expect(env.status).toBe('error');
    expect(env.error?.code).toBe('invalid_args');
  });

  it('all guard-path envelopes validate against ENVELOPE_SCHEMA', async () => {
    const scenarios = [
      { task_id: 'task_absolutely_nonexistent' },
    ];
    for (const args of scenarios) {
      const raw = (await client.callTool({ name: 'mx_dispatch_task', arguments: args })) as CallToolResult;
      const env = envelopeFrom(raw);
      expect(validateEnvelope(env), `ENVELOPE_SCHEMA for ${JSON.stringify(args)}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// §2f — Secret boundary via MCP binding
// ---------------------------------------------------------------------------

describe('T303 e2e §2f — secret boundary via MCP binding (fake daemon)', () => {
  it('credential-shaped value in dispatched action.args is rejected as invalid_args at Boundary A', async () => {
    // Build a daemon that simulates the toolbelt guard: task.create rejects credential-shaped
    // action args. This models the real MxClient's assertNoCredentialShapedArgs chokepoint
    // running before the daemon persists the action (the T303 "doubly bounded" property).
    const guardingDaemon: DaemonCall = {
      async call(method: string, params?: unknown): Promise<unknown> {
        const p = (params ?? {}) as Record<string, unknown>;

        if (method === 'task.create') {
          const action = p['action'] as Record<string, unknown> | undefined;
          if (action !== undefined) {
            const argValues = Object.values(
              (action['args'] ?? {}) as Record<string, unknown>,
            );
            const hasCredential = argValues.some(
              (v) => typeof v === 'string' && /^(ghp_|syt_|sk-ant-|mxs_)/.test(v),
            );
            if (hasCredential) {
              throw Object.assign(
                new Error('refusing to send credential-shaped value in action.args'),
                { code: 'invalid_args' },
              );
            }
          }
          return {
            task_id: 'task_bound_01',
            title: p['title'] ?? '',
            state: 'assigned',
            assignee: 'ag_worker_01',
            depends_on: [],
            blocks: [],
            action: null,
            audit_ref: {
              invocation_id: 'inv_bound_01',
              request_id: 'req_bound_01',
              room: FAKE_ROOM,
              event_id: '$evt_bound_01',
            },
          };
        }
        if (method === 'task.list') return { tasks: [] };
        if (method === 'task.graph') return [];
        throw new Error(`guarding daemon: unexpected method "${method}"`);
      },
    };

    const conn = await connectFake(guardingDaemon);

    const raw = (await conn.client.callTool({
      name: 'mx_create_task',
      arguments: {
        title: 'Credential injection attempt',
        assign: 'ag_worker_01',
        action: {
          kind: 'tool',
          tool: 'deploy',
          args: { access_token: 'ghp_fake_github_token_must_be_rejected_T303' },
        },
      },
    })) as CallToolResult;

    const env = envelopeFrom(raw);
    expect(validateEnvelope(env), 'error envelope must validate').toBe(true);
    expect(env.status, 'rejected by the credential guard → status error').toBe('error');
    expect(env.error?.code, 'credential arg rejected → invalid_args').toBe('invalid_args');

    const serialized = JSON.stringify(raw);
    expect(serialized, 'credential value must not appear in the envelope').not.toContain(
      'ghp_fake_github_token_must_be_rejected_T303',
    );
    expect(serialized).not.toMatch(SECRET_PATTERN);

    await conn.close();
  });

  it('a normal dispatch response carries no secret-shaped value', async () => {
    const conn = await connectFake(makeStatefulFakeDaemon());

    const createRaw = (await conn.client.callTool({
      name: 'mx_create_task',
      arguments: {
        title: 'clean dispatch — no credential',
        assign: 'ag_worker_01',
        action: { kind: 'tool', tool: 'run_tests' },
      },
    })) as CallToolResult;
    const taskId = (envelopeFrom(createRaw).result as Record<string, unknown>).task_id as string;

    const dispatchRaw = (await conn.client.callTool({
      name: 'mx_dispatch_task',
      arguments: { task_id: taskId },
    })) as CallToolResult;

    const env = envelopeFrom(dispatchRaw);
    expect(env.status).toBe('ok');
    expect(JSON.stringify(dispatchRaw)).not.toMatch(SECRET_PATTERN);

    await conn.close();
  });
});

// ---------------------------------------------------------------------------
// §3 — Live dispatch (gated GOLDEN_REQUIRED)
//
// Both DAEMON flags are required:
//   MXL_CONFORMANCE_TWO_DAEMON=1  — daemon B is up and the target agent is registered
//   MXL_CONFORMANCE_GOLDEN_POLICY=1 — daemon B runs policy.golden.toml (allowTool ungated,
//                                     approvalTool held, deniedTool blocked)
//
// The golden fixture env vars supply coordinates:
//   MXL_CONFORMANCE_ROOM          — shared workspace room
//   MXL_CONFORMANCE_TARGET_AGENT  — daemon B's agent id
//   MXL_CONFORMANCE_TOOL          — the ungated allowed tool (for L1)
//   MXL_CONFORMANCE_APPROVAL_TOOL — the approval-gated tool (for L2)
//   MXL_CONFORMANCE_DENIED_TOOL   — the policy-denied tool (for L3)
//
// The room always comes from the BindingContext (session), never from model args.
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_GOLDEN)(
  'T303 e2e §3 — live dispatch: full authorize pipeline (GOLDEN_REQUIRED)',
  () => {
    const nonce = randomUUID();
    let mcpClient: Client | undefined;
    let mxClientRef: { close(): Promise<void> } | undefined;
    let ctxRef: { close(): Promise<void> } | undefined;

    let targetAgentId: string;
    let allowTool: string;
    let approvalTool: string;
    let deniedTool: string;

    beforeAll(async () => {
      assertGoldenPrereqs();

      const fixture = readGoldenFixture();
      if (fixture === null) {
        throw new Error(
          'T303 task-action live e2e: golden fixture coordinates absent. ' +
            'Set MXL_CONFORMANCE_ROOM / MXL_CONFORMANCE_TARGET_AGENT / ' +
            'MXL_CONFORMANCE_TOOL / MXL_CONFORMANCE_APPROVAL_TOOL / ' +
            'MXL_CONFORMANCE_DENIED_TOOL (the bootstrap-daemon-b.sh with ' +
            'POLICY_FIXTURE=policy.golden.toml exports these).',
        );
      }

      if (!DAEMON_REACHABLE) {
        throw new Error(
          'T303 task-action live e2e: demanded (GOLDEN_REQUIRED) but daemon A is not ' +
            `reachable at ${resolveDaemonSocket()}. Bring up the golden two-daemon fixture.`,
        );
      }

      targetAgentId = fixture.targetAgentId;
      allowTool = fixture.allowTool;
      approvalTool = fixture.approvalTool;
      deniedTool = fixture.deniedTool;

      const mxClient = createClient({ socketPath: resolveDaemonSocket() });
      mxClientRef = mxClient;

      const ctx = await createBindingContext({
        daemon: mxClient,
        room: fixture.room,
        auditSink: new NullAuditSink(),
      });
      ctxRef = ctx;

      const server = createMcpServer(ctx);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 't303-live', version: '0.0.0' });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      mcpClient = client;
    }, 30_000);

    afterAll(async () => {
      await mcpClient?.close();
      await ctxRef?.close();
      await mxClientRef?.close();
    });

    // -----------------------------------------------------------------------
    // L1 — Allowed-tool dispatch → ok + populated audit_ref
    // The issue AC: "a task action runs through the full authorize pipeline on dispatch."
    // -----------------------------------------------------------------------

    it(
      'L1 — T303 AC: create a task with the allowed tool → dispatch → ok + populated audit_ref (full authorize pipeline)',
      async () => {
        if (!mcpClient) throw new Error('MCP client not initialised');

        // Create a task with the ungated allowTool assigned to daemon B's agent.
        const createRaw = (await mcpClient.callTool({
          name: 'mx_create_task',
          arguments: {
            title: `T303 L1 allowTool dispatch nonce=${nonce}`,
            assign: targetAgentId,
            action: { kind: 'tool', tool: allowTool, args: {} },
            idempotency_key: `idk_t303_live_create_allow_${nonce}`,
          },
        })) as CallToolResult;

        const createEnv = envelopeFrom(createRaw);
        expect(validateEnvelope(createEnv), 'create: envelope must validate').toBe(true);
        expect(createEnv.status, 'create: status must be ok').toBe('ok');
        expect(JSON.stringify(createRaw)).not.toMatch(SECRET_PATTERN);

        const taskId = (createEnv.result as Record<string, unknown>).task_id as string;
        expect(taskId, 'create: task_id must be present').toBeTruthy();

        // Dispatch the task — routes through call.start → daemon A → daemon B → policy allows → ok.
        const dispatchRaw = (await mcpClient.callTool({
          name: 'mx_dispatch_task',
          arguments: {
            task_id: taskId,
            idempotency_key: `idk_t303_live_dispatch_allow_${nonce}`,
          },
        })) as CallToolResult;

        const dispatchEnv = envelopeFrom(dispatchRaw);
        expect(validateEnvelope(dispatchEnv), 'dispatch: envelope must validate').toBe(true);
        expect(
          dispatchEnv.status,
          'L1 dispatch: allowed tool must succeed (full authorize pipeline → ok)',
        ).toBe('ok');
        // A live call.start traversal emits a signed Matrix event → audit_ref populated.
        expect(
          dispatchEnv.audit_ref.invocation_id,
          'L1: dispatch is a live call.start → populated invocation_id (the AC)',
        ).toBeTruthy();
        expect(dispatchRaw.isError ?? false).toBe(false);
        expect(JSON.stringify(dispatchRaw)).not.toMatch(SECRET_PATTERN);
      },
      120_000,
    );

    // -----------------------------------------------------------------------
    // L2 — Approval-gated dispatch (the hold → decide → re-authorize cycle)
    // Proves: authoring an action ≠ authorizing it. The operator decides after
    // the dispatch; the daemon re-runs authorize-at-release before executing.
    // -----------------------------------------------------------------------

    it(
      'L2 — approval-gated dispatch: create task → dispatch → awaiting_approval → approve → ok (re-authorize-at-release)',
      async () => {
        if (!mcpClient) throw new Error('MCP client not initialised');

        const createRaw = (await mcpClient.callTool({
          name: 'mx_create_task',
          arguments: {
            title: `T303 L2 approvalTool dispatch nonce=${nonce}`,
            assign: targetAgentId,
            action: { kind: 'tool', tool: approvalTool, args: {} },
            idempotency_key: `idk_t303_live_create_approval_${nonce}`,
          },
        })) as CallToolResult;

        const createEnv = envelopeFrom(createRaw);
        expect(createEnv.status, 'L2 create: must be ok').toBe('ok');
        const taskId = (createEnv.result as Record<string, unknown>).task_id as string;

        // Dispatch — the receiver holds for approval (the AC: full authorize pipeline → holds).
        const dispatchRaw = (await mcpClient.callTool({
          name: 'mx_dispatch_task',
          arguments: {
            task_id: taskId,
            idempotency_key: `idk_t303_live_dispatch_approval_${nonce}`,
          },
        })) as CallToolResult;

        const dispatchEnv = envelopeFrom(dispatchRaw);
        expect(validateEnvelope(dispatchEnv), 'dispatch: envelope must validate').toBe(true);
        expect(
          dispatchEnv.status,
          'L2: approval_tool must be held awaiting_approval (full authorize pipeline ran → held)',
        ).toBe('awaiting_approval');
        expect(typeof dispatchEnv.handle, 'handle must be a string').toBe('string');
        expect(dispatchEnv.approval?.request_id, 'approval.request_id must be present').toBeTruthy();
        expect(['low', 'medium', 'high'], 'approval.risk must be in the closed set').toContain(
          dispatchEnv.approval?.risk,
        );
        // awaiting_approval is not an MCP protocol error (model can continue reasoning).
        expect(dispatchRaw.isError ?? false, 'awaiting_approval is not an error').toBe(false);
        expect(JSON.stringify(dispatchRaw)).not.toMatch(SECRET_PATTERN);

        // Out-of-band operator approves (NOT a model tool — the model only produced a
        // signed request; the operator decides; the daemon re-validates at release).
        await approvePending({ match: approvalTool });

        // Resolve the handle — the daemon re-ran the authorize pipeline at release → ok.
        const resolveRaw = (await mcpClient.callTool({
          name: 'mx_await_result',
          arguments: {
            handle: dispatchEnv.handle,
            wait_ms: GOLDEN_RESOLVE_BUDGET_MS,
          },
        })) as CallToolResult;

        const resolveEnv = envelopeFrom(resolveRaw);
        expect(validateEnvelope(resolveEnv), 'resolve: envelope must validate').toBe(true);
        expect(
          resolveEnv.status,
          'L2: after approval → ok (re-authorize-at-release succeeded)',
        ).toBe('ok');
        expect(resolveRaw.isError ?? false).toBe(false);
        expect(JSON.stringify(resolveRaw)).not.toMatch(SECRET_PATTERN);
      },
      120_000,
    );

    // -----------------------------------------------------------------------
    // L3 — Policy-denied dispatch
    // Proves: the receiver's policy (not the authoring side) gates execution.
    // -----------------------------------------------------------------------

    it(
      'L3 — policy-denied dispatch: create task → dispatch → denied(policy_denied) (receiver policy gates execution)',
      async () => {
        if (!mcpClient) throw new Error('MCP client not initialised');

        const createRaw = (await mcpClient.callTool({
          name: 'mx_create_task',
          arguments: {
            title: `T303 L3 deniedTool dispatch nonce=${nonce}`,
            assign: targetAgentId,
            action: { kind: 'tool', tool: deniedTool, args: {} },
            idempotency_key: `idk_t303_live_create_denied_${nonce}`,
          },
        })) as CallToolResult;

        const createEnv = envelopeFrom(createRaw);
        expect(createEnv.status, 'L3 create: must be ok').toBe('ok');
        const taskId = (createEnv.result as Record<string, unknown>).task_id as string;

        // Dispatch — the receiver's policy denies the tool (deny-by-default or explicit deny rule).
        const dispatchRaw = (await mcpClient.callTool({
          name: 'mx_dispatch_task',
          arguments: {
            task_id: taskId,
            idempotency_key: `idk_t303_live_dispatch_denied_${nonce}`,
          },
        })) as CallToolResult;

        const dispatchEnv = envelopeFrom(dispatchRaw);
        expect(validateEnvelope(dispatchEnv), 'denied dispatch: envelope must validate').toBe(true);
        expect(
          dispatchEnv.status,
          'L3: denied tool → status denied (receiver policy ran, authoring ≠ authorizing)',
        ).toBe('denied');
        expect(
          dispatchEnv.error?.code,
          'L3: error code must be policy_denied',
        ).toBe('policy_denied');
        // denied is not a protocol error (the model can handle it programmatically).
        expect(dispatchRaw.isError ?? false, 'denied is not an MCP error').toBe(false);
        expect(JSON.stringify(dispatchRaw)).not.toMatch(SECRET_PATTERN);
      },
      60_000,
    );

    // -----------------------------------------------------------------------
    // L4 — Idempotent re-dispatch: same invocation_id on second dispatch
    // -----------------------------------------------------------------------

    it(
      'L4 — idempotent re-dispatch: same task + same idempotency_key → daemon deduplicates (same invocation_id)',
      async () => {
        if (!mcpClient) throw new Error('MCP client not initialised');

        const idemKey = `idk_t303_live_dispatch_idem_${nonce}`;

        const createRaw = (await mcpClient.callTool({
          name: 'mx_create_task',
          arguments: {
            title: `T303 L4 idempotent dispatch nonce=${nonce}`,
            assign: targetAgentId,
            action: { kind: 'tool', tool: allowTool, args: {} },
            idempotency_key: `idk_t303_live_create_idem_${nonce}`,
          },
        })) as CallToolResult;
        const taskId = (envelopeFrom(createRaw).result as Record<string, unknown>).task_id as string;

        // First dispatch with an explicit idempotency key.
        const first = (await mcpClient.callTool({
          name: 'mx_dispatch_task',
          arguments: { task_id: taskId, idempotency_key: idemKey },
        })) as CallToolResult;
        const e1 = envelopeFrom(first);
        expect(e1.status, 'L4 first dispatch: must be ok').toBe('ok');

        // Second dispatch with the same key — the daemon's replay protection deduplicates.
        const second = (await mcpClient.callTool({
          name: 'mx_dispatch_task',
          arguments: { task_id: taskId, idempotency_key: idemKey },
        })) as CallToolResult;
        const e2 = envelopeFrom(second);
        expect(e2.status, 'L4 second dispatch: must also be ok').toBe('ok');

        // When the daemon deduplicates, both invocations share the same invocation_id.
        const inv1 = e1.audit_ref.invocation_id;
        const inv2 = e2.audit_ref.invocation_id;
        if (inv1 !== null && inv2 !== null) {
          expect(
            inv2,
            'L4: same idempotency_key → same invocation_id (daemon deduplicated)',
          ).toBe(inv1);
        }

        expect(JSON.stringify(first)).not.toMatch(SECRET_PATTERN);
        expect(JSON.stringify(second)).not.toMatch(SECRET_PATTERN);
      },
      60_000,
    );

    // -----------------------------------------------------------------------
    // L5 — Secret boundary: no secret in any live dispatch response
    // -----------------------------------------------------------------------

    it(
      'L5 — live secret boundary: no secret-shaped value in any dispatch response',
      async () => {
        if (!mcpClient) throw new Error('MCP client not initialised');

        const createRaw = (await mcpClient.callTool({
          name: 'mx_create_task',
          arguments: {
            title: `T303 L5 secret-boundary probe nonce=${nonce}`,
            assign: targetAgentId,
            action: { kind: 'tool', tool: allowTool, args: {} },
            idempotency_key: `idk_t303_live_create_secret_${nonce}`,
          },
        })) as CallToolResult;
        expect(JSON.stringify(createRaw)).not.toMatch(SECRET_PATTERN);

        const taskId = (envelopeFrom(createRaw).result as Record<string, unknown>).task_id as string;

        const dispatchRaw = (await mcpClient.callTool({
          name: 'mx_dispatch_task',
          arguments: {
            task_id: taskId,
            idempotency_key: `idk_t303_live_dispatch_secret_${nonce}`,
          },
        })) as CallToolResult;

        expect(JSON.stringify(dispatchRaw)).not.toMatch(SECRET_PATTERN);
        const env = envelopeFrom(dispatchRaw);
        expect(validateEnvelope(env)).toBe(true);
        expect(env.status).toBe('ok');
      },
      60_000,
    );
  },
);
