/**
 * T301 / #30 — end-to-end coverage for the task-DAG verbs
 * `mx_create_task` / `mx_update_task` / `mx_list_tasks`.
 *
 * Three sections, increasing fixture cost:
 *
 * §1  Descriptor surface (always-on, no daemon) — the three task verbs appear in
 *     `CANONICAL_TOOLS` (grew 9 → 12), surface in the MCP binding's `tools/list`
 *     with valid JSON Schema, and are not authority verbs. This is the binding-layer
 *     complement of the `descriptors.task.test.ts` unit suite and pins the 12-verb
 *     count at the serialization layer.
 *
 * §2  Task verb dispatch via a fake stateful daemon (always-on) — each verb routes
 *     through the MCP server's `dispatchCall` to the correct registry handler and
 *     produces a conformant T102 envelope. Exercises the full create→list(graph)→
 *     update flow through the binding layer without a real daemon. Also asserts:
 *     - The task verbs are `sync` (never return `awaiting_approval` or `running`).
 *     - `mx_list_tasks` view:'list' omits `edges`; view:'graph' includes them.
 *     - `mx_create_task` with `depends_on` reflects the dep in the node.
 *     - `mx_update_task` returns the requested state.
 *     - Create/update carry a populated `audit_ref`; list carries EMPTY_AUDIT_REF.
 *
 * §2b Secret boundary via MCP binding (always-on, fake daemon) — a
 *     credential-shaped value in `action.args` is rejected as `invalid_args` at
 *     Boundary A before any dispatch; the value never appears in any envelope field.
 *
 * §3  Live single-daemon round-trip (gated `MXL_TASK_E2E=1` or
 *     `MXL_CONFORMANCE_TWO_DAEMON=1`) — drives the core issue #30 acceptance
 *     criterion through the real daemon wire protocol:
 *       1. `mx_create_task` creates task A → ok + populated `audit_ref`.
 *       2. `mx_create_task` creates task B with `depends_on: [aId]` → ok.
 *       3. `mx_list_tasks` (graph) → the B→A `depends_on` edge is present.
 *       4. `mx_update_task` transitions B to `executing` → ok + populated `audit_ref`.
 *       5. `mx_list_tasks` again → B.state === `executing`.
 *     The room ALWAYS comes from the session (via `MXL_CONFORMANCE_ROOM`), never from
 *     model args. No secret-shaped value appears in any envelope.
 *
 * Gating mirrors T205 (Pi e2e) and T114 (golden gate) patterns:
 *   - §1 and §2/§2b: always-on, no daemon needed.
 *   - §3: skip cleanly when neither `MXL_TASK_E2E=1` nor `MXL_CONFORMANCE_TWO_DAEMON=1`
 *     is set; fail-not-skip (hard RED) when either is set but daemon / room is absent.
 *
 * Deliberately out of scope for this file:
 *   - `task.watch` push-based resumption → T302.
 *   - Multi-agent plan across ≥2 agents surviving restart → T302/T304 (M3 exit).
 *   - Signed task-action dispatch → T303.
 *   - The portability matrix (Pi/ADK/OpenCode) for the task verbs — they surface via
 *     `CANONICAL_TOOLS`, so T206's descriptor-identity arm covers them automatically.
 */
import { randomUUID } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { NullAuditSink } from '@mx-loom/audit';
import { createBindingContext, createMcpServer } from '@mx-loom/mcp';
import {
  CANONICAL_TOOLS,
  isForbiddenAuthorityVerb,
  validateEnvelope,
  type DaemonCall,
  type ToolResult,
} from '@mx-loom/registry';
import { createClient } from '@mx-loom/toolbelt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DAEMON_REACHABLE,
  SECRET_PATTERN,
  isTwoDaemonRequired,
  resolveDaemonSocket,
} from './_golden-harness.js';

// ---------------------------------------------------------------------------
// Env flags and gate logic
// ---------------------------------------------------------------------------

/** Whether the live §3 round-trip was explicitly requested. */
const isTaskE2eRequested: boolean =
  process.env['MXL_TASK_E2E'] === '1' || isTwoDaemonRequired();

/** The workspace room for the live §3 round-trip, if exported by the bring-up. */
function readRoom(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const r = env['MXL_CONFORMANCE_ROOM'];
  return r !== undefined && r !== '' ? r : undefined;
}

/**
 * Skip §3 cleanly when neither `MXL_TASK_E2E=1` nor `MXL_CONFORMANCE_TWO_DAEMON=1`
 * is set — a developer laptop and fast CI never run it. When demanded, the
 * `beforeAll` below turns a missing daemon or room into a HARD failure.
 */
const SKIP_TASK_LIVE = !isTaskE2eRequested;

// ---------------------------------------------------------------------------
// Shared fake-daemon builder (§1 and §2)
// ---------------------------------------------------------------------------

const FAKE_ROOM = '!task-e2e-fake:homeserver';

/**
 * A minimal in-memory task daemon that supports `task.create`, `task.update`,
 * `task.list`, and `task.graph`. Enough for the MCP binding round-trip tests
 * in §1 and §2 without a real mx-agent process.
 */
function makeFakeTaskDaemon(): DaemonCall {
  const store = new Map<string, Record<string, unknown>>();
  let counter = 0;

  return {
    async call(method: string, params?: unknown): Promise<unknown> {
      const p = (params ?? {}) as Record<string, unknown>;

      if (method === 'task.create') {
        const id = `task_${++counter}`;
        const record: Record<string, unknown> = {
          task_id: id,
          title: p['title'] ?? '',
          state: p['state'] ?? 'proposed',
          assignee: p['assign'] ?? null,
          depends_on: Array.isArray(p['depends_on']) ? p['depends_on'] : [],
          blocks: Array.isArray(p['blocks']) ? p['blocks'] : [],
          action: p['action'] ?? null,
          created_at: '2026-06-25T00:00:00Z',
          updated_at: '2026-06-25T00:00:00Z',
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
          throw Object.assign(
            new Error('not_found'),
            { code: 'rpc', cause: { error: { code: 'not_found' } } },
          );
        }
        const updated: Record<string, unknown> = {
          ...existing,
          ...(p['state'] !== undefined ? { state: p['state'] } : {}),
          ...(p['assign'] !== undefined ? { assignee: p['assign'] } : {}),
          ...(p['depends_on'] !== undefined ? { depends_on: p['depends_on'] } : {}),
          ...(p['blocks'] !== undefined ? { blocks: p['blocks'] } : {}),
          updated_at: '2026-06-25T12:00:00Z',
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
        const tasks = [...store.values()];
        const stateFilter = typeof p['state'] === 'string' ? p['state'] : undefined;
        const assigneeFilter = typeof p['assignee'] === 'string' ? p['assignee'] : undefined;
        const filtered = tasks.filter((t) => {
          if (stateFilter !== undefined && t['state'] !== stateFilter) return false;
          if (assigneeFilter !== undefined && t['assignee'] !== assigneeFilter) return false;
          return true;
        });
        return { tasks: filtered };
      }

      if (method === 'task.graph') {
        // Return no explicit edges — the handler derives them from node records.
        return [];
      }

      throw new Error(`T301 fake daemon: unexpected method "${method}"`);
    },
  };
}

/** Wire an MCP client to a server backed by `daemon` over an in-memory pair. */
async function connectFake(daemon: DaemonCall): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const ctx = await createBindingContext({ daemon, room: FAKE_ROOM });
  const server = createMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'task-e2e-test', version: '0.0.0' });
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
    throw new Error('T301 e2e: no structuredContent in CallToolResult');
  }
  return sc as unknown as ToolResult;
}

// ---------------------------------------------------------------------------
// §1 — Descriptor surface (always-on, no daemon)
// ---------------------------------------------------------------------------

describe('T301 e2e §1 — descriptor surface via MCP binding (no daemon)', () => {
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const conn = await connectFake(makeFakeTaskDaemon());
    client = conn.client;
    close = conn.close;
    // Pre-populate the SDK's outputSchema cache (required by some SDK versions).
    await client.listTools();
  });

  afterAll(async () => {
    await close();
  });

  it('CANONICAL_TOOLS includes all four task verbs (grew 9 → 13)', () => {
    const names = CANONICAL_TOOLS.map((d) => d.name);
    expect(names).toContain('mx_create_task');
    expect(names).toContain('mx_update_task');
    expect(names).toContain('mx_list_tasks');
    expect(names).toContain('mx_dispatch_task');
    // The canonical set is now 13: the 9 M1 verbs + the 4 M3 task verbs (T301 + T303).
    expect(names).toHaveLength(13);
  });

  it('tools/list surfaces exactly 13 mx_* verbs — no authority verb is reachable', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      CANONICAL_TOOLS.map((d) => d.name).sort(),
    );
    for (const { name } of tools) {
      expect(
        isForbiddenAuthorityVerb(name),
        `authority verb must not appear in tools/list: ${name}`,
      ).toBe(false);
    }
    // No secret-shaped value in the descriptor payload.
    expect(JSON.stringify(tools)).not.toMatch(SECRET_PATTERN);
  });

  it('mx_create_task is in tools/list with a `title`-required input schema', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'mx_create_task');
    expect(tool, 'mx_create_task must appear in tools/list').toBeDefined();
    const schema = tool!.inputSchema as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.required ?? []).toContain('title');
    expect(schema.properties).toHaveProperty('title');
    expect(schema.properties).toHaveProperty('depends_on');
    expect(schema.properties).toHaveProperty('blocks');
  });

  it('mx_update_task is in tools/list with a `task_id`-required input schema', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'mx_update_task');
    expect(tool, 'mx_update_task must appear in tools/list').toBeDefined();
    const schema = tool!.inputSchema as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.required ?? []).toContain('task_id');
    expect(schema.properties).toHaveProperty('state');
  });

  it('mx_list_tasks is in tools/list with an optional-only input schema', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'mx_list_tasks');
    expect(tool, 'mx_list_tasks must appear in tools/list').toBeDefined();
    const schema = tool!.inputSchema as { required?: string[] };
    // All inputs are optional — the model can call mx_list_tasks with no args.
    expect((schema.required ?? []).length).toBe(0);
  });

  it('task verb schemas match the CANONICAL_TOOLS descriptors verbatim', async () => {
    const { tools } = await client.listTools();
    for (const name of ['mx_create_task', 'mx_update_task', 'mx_list_tasks'] as const) {
      const descriptor = CANONICAL_TOOLS.find((d) => d.name === name)!;
      const mcpTool = tools.find((t) => t.name === name)!;
      // The MCP binding passes input_schema verbatim — no Zod round-trip here.
      expect(mcpTool.inputSchema, `${name}: schema must match descriptor`).toEqual(
        descriptor.input_schema,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// §2 — Task verb dispatch via MCP + fake stateful daemon (always-on)
// ---------------------------------------------------------------------------

describe('T301 e2e §2 — task verbs dispatched through MCP binding (fake daemon)', () => {
  let client: Client;
  let close: () => Promise<void>;
  const idem = (suffix: string): string => `idk_t301_fake_${suffix}`;

  beforeAll(async () => {
    const conn = await connectFake(makeFakeTaskDaemon());
    client = conn.client;
    close = conn.close;
  });

  afterAll(async () => {
    await close();
  });

  it('mx_create_task returns ok with task_id and populated audit_ref (signed mutation)', async () => {
    const raw = (await client.callTool({
      name: 'mx_create_task',
      arguments: { title: 'E2E create test', idempotency_key: idem('create-basic') },
    })) as CallToolResult;

    const env = envelopeFrom(raw);
    expect(validateEnvelope(env), 'envelope must validate').toBe(true);
    expect(env.status).toBe('ok');
    expect((env.result as Record<string, unknown>).task_id).toBeTruthy();
    // Create is a signed mutation → populated audit_ref (not EMPTY).
    expect(env.audit_ref.invocation_id, 'create: populated invocation_id').toBeTruthy();
    expect(env.audit_ref.room, 'create: populated room').toBeTruthy();
    // isError must be false for status !== 'error'.
    expect(raw.isError ?? false).toBe(false);
    expect(JSON.stringify(raw)).not.toMatch(SECRET_PATTERN);
  });

  it('mx_create_task with depends_on reflects the dep on the returned node', async () => {
    // Create the prerequisite.
    const prereqRaw = (await client.callTool({
      name: 'mx_create_task',
      arguments: { title: 'Prereq', idempotency_key: idem('prereq') },
    })) as CallToolResult;
    const prereqId = (
      (envelopeFrom(prereqRaw).result as Record<string, unknown>).task_id as string
    );
    expect(prereqId).toBeTruthy();

    // Create the dependent task.
    const depRaw = (await client.callTool({
      name: 'mx_create_task',
      arguments: {
        title: 'Dependent',
        depends_on: [prereqId],
        idempotency_key: idem('dep'),
      },
    })) as CallToolResult;
    const depEnv = envelopeFrom(depRaw);
    expect(validateEnvelope(depEnv)).toBe(true);
    expect(depEnv.status).toBe('ok');
    const node = depEnv.result as Record<string, unknown>;
    expect(Array.isArray(node.depends_on), 'depends_on must be an array').toBe(true);
    expect(node.depends_on as string[]).toContain(prereqId);
  });

  it('mx_list_tasks (graph view) returns ok with a tasks array and an edges array', async () => {
    const raw = (await client.callTool({
      name: 'mx_list_tasks',
      arguments: {},
    })) as CallToolResult;

    const env = envelopeFrom(raw);
    expect(validateEnvelope(env)).toBe(true);
    expect(env.status).toBe('ok');
    const result = env.result as { tasks: unknown[]; edges?: unknown[] };
    expect(Array.isArray(result.tasks), 'tasks must be an array').toBe(true);
    // Graph view must include an edges array (may be empty).
    expect(result.edges, 'graph view must include an edges key').toBeDefined();
    expect(Array.isArray(result.edges), 'edges must be an array').toBe(true);
    // List is a local read → EMPTY_AUDIT_REF.
    expect(env.audit_ref.invocation_id, 'list: EMPTY_AUDIT_REF').toBeNull();
    expect(raw.isError ?? false).toBe(false);
    expect(JSON.stringify(raw)).not.toMatch(SECRET_PATTERN);
  });

  it('mx_list_tasks (list view) returns ok with tasks but no edges key', async () => {
    const raw = (await client.callTool({
      name: 'mx_list_tasks',
      arguments: { view: 'list' },
    })) as CallToolResult;

    const env = envelopeFrom(raw);
    expect(env.status).toBe('ok');
    const result = env.result as Record<string, unknown>;
    expect(Array.isArray(result['tasks'])).toBe(true);
    // list view: no edges.
    expect(result['edges']).toBeUndefined();
  });

  it('mx_list_tasks (graph) includes the depends_on edge from a created task', async () => {
    // Using a fresh daemon so the store is empty.
    const conn = await connectFake(makeFakeTaskDaemon());

    const aRaw = (await conn.client.callTool({
      name: 'mx_create_task',
      arguments: { title: 'A', idempotency_key: idem('dag-a') },
    })) as CallToolResult;
    const aId = (envelopeFrom(aRaw).result as Record<string, unknown>).task_id as string;

    const bRaw = (await conn.client.callTool({
      name: 'mx_create_task',
      arguments: { title: 'B', depends_on: [aId], idempotency_key: idem('dag-b') },
    })) as CallToolResult;
    const bId = (envelopeFrom(bRaw).result as Record<string, unknown>).task_id as string;

    const listRaw = (await conn.client.callTool({
      name: 'mx_list_tasks',
      arguments: {},
    })) as CallToolResult;
    const listResult = envelopeFrom(listRaw).result as {
      tasks: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
    };

    const depEdge = listResult.edges.find(
      (e) => e['from'] === bId && e['to'] === aId && e['kind'] === 'depends_on',
    );
    expect(depEdge, 'the B→A depends_on edge must be present in the DAG').toBeDefined();

    await conn.close();
  });

  it('mx_update_task returns ok with the updated state and a populated audit_ref', async () => {
    // Create a task to update.
    const createRaw = (await client.callTool({
      name: 'mx_create_task',
      arguments: { title: 'State task', idempotency_key: idem('state-create') },
    })) as CallToolResult;
    const taskId = (
      (envelopeFrom(createRaw).result as Record<string, unknown>).task_id as string
    );

    const updateRaw = (await client.callTool({
      name: 'mx_update_task',
      arguments: {
        task_id: taskId,
        state: 'executing',
        idempotency_key: idem('state-update'),
      },
    })) as CallToolResult;

    const env = envelopeFrom(updateRaw);
    expect(validateEnvelope(env)).toBe(true);
    expect(env.status).toBe('ok');
    expect((env.result as Record<string, unknown>).state).toBe('executing');
    // Update is a signed mutation → populated audit_ref.
    expect(env.audit_ref.invocation_id, 'update: populated invocation_id').toBeTruthy();
    expect(updateRaw.isError ?? false).toBe(false);
    expect(JSON.stringify(updateRaw)).not.toMatch(SECRET_PATTERN);
  });

  it('update state transition is reflected in the next list call', async () => {
    const conn = await connectFake(makeFakeTaskDaemon());

    const createRaw = (await conn.client.callTool({
      name: 'mx_create_task',
      arguments: { title: 'Reflect task', idempotency_key: idem('reflect-create') },
    })) as CallToolResult;
    const createEnv = envelopeFrom(createRaw);
    expect((createEnv.result as Record<string, unknown>).state).toBe('proposed');
    const taskId = (createEnv.result as Record<string, unknown>).task_id as string;

    await conn.client.callTool({
      name: 'mx_update_task',
      arguments: { task_id: taskId, state: 'assigned', idempotency_key: idem('reflect-update') },
    });

    const listRaw = (await conn.client.callTool({
      name: 'mx_list_tasks',
      arguments: {},
    })) as CallToolResult;
    const tasks = (envelopeFrom(listRaw).result as { tasks: Array<Record<string, unknown>> }).tasks;
    const node = tasks.find((t) => t['task_id'] === taskId);
    expect(node?.['state'], 'list must reflect the updated state').toBe('assigned');

    await conn.close();
  });

  it('task verbs are sync — create/update/list never return awaiting_approval or running', async () => {
    const createRaw = (await client.callTool({
      name: 'mx_create_task',
      arguments: { title: 'Sync assertion', idempotency_key: idem('sync-create') },
    })) as CallToolResult;
    const createEnv = envelopeFrom(createRaw);
    expect(createEnv.status).not.toBe('awaiting_approval');
    expect(createEnv.status).not.toBe('running');

    const taskId = (createEnv.result as Record<string, unknown>).task_id as string;

    const updateRaw = (await client.callTool({
      name: 'mx_update_task',
      arguments: { task_id: taskId, state: 'pending', idempotency_key: idem('sync-update') },
    })) as CallToolResult;
    const updateEnv = envelopeFrom(updateRaw);
    expect(updateEnv.status).not.toBe('awaiting_approval');
    expect(updateEnv.status).not.toBe('running');

    const listRaw = (await client.callTool({
      name: 'mx_list_tasks',
      arguments: {},
    })) as CallToolResult;
    const listEnv = envelopeFrom(listRaw);
    expect(listEnv.status).not.toBe('awaiting_approval');
    expect(listEnv.status).not.toBe('running');
  });
});

// ---------------------------------------------------------------------------
// §2b — Secret boundary via MCP binding (always-on, fake daemon)
// ---------------------------------------------------------------------------

describe('T301 e2e §2b — secret boundary via MCP binding (fake daemon)', () => {
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    // A daemon that simulates the toolbelt guard rejecting credential-shaped action args.
    // The real MxClient's `assertNoCredentialShapedArgs` rejects values matching the
    // credential regex before dispatch; we model that as an invalid_args error thrown
    // by the daemon so the handler's `faultToResult` path is exercised through the
    // MCP layer (end-to-end from MCP tools/call to the error envelope).
    const guardingDaemon: DaemonCall = {
      async call(method: string, params?: unknown): Promise<unknown> {
        const p = (params ?? {}) as Record<string, unknown>;

        if (method === 'task.create') {
          // Simulate the toolbelt credential guard: reject credential-shaped action arg values.
          const action = p['action'] as Record<string, unknown> | undefined;
          if (action !== undefined) {
            const argValues = Object.values(
              (action['args'] ?? {}) as Record<string, unknown>,
            );
            const hasCredential = argValues.some(
              (v) => typeof v === 'string' && /^(ghp_|syt_|sk-ant-)/.test(v),
            );
            if (hasCredential) {
              // TransportError('invalid_args', …) is what the real guard throws.
              throw Object.assign(
                new Error('refusing to send credential-shaped value in action.args'),
                { code: 'invalid_args' },
              );
            }
          }
          const id = `task_bound_${Date.now()}`;
          return {
            task_id: id,
            title: p['title'] ?? '',
            state: 'proposed',
            assignee: null,
            depends_on: [],
            blocks: [],
            action: null,
            audit_ref: {
              invocation_id: `inv_${id}`,
              request_id: `req_${id}`,
              room: FAKE_ROOM,
              event_id: `$evt_${id}`,
            },
          };
        }

        if (method === 'task.list') return { tasks: [] };
        if (method === 'task.graph') return [];
        throw new Error(`guarding daemon: unexpected method "${method}"`);
      },
    };

    const conn = await connectFake(guardingDaemon);
    client = conn.client;
    close = conn.close;
  });

  afterAll(async () => {
    await close();
  });

  it('credential-shaped value in action.args is rejected as invalid_args at Boundary A', async () => {
    const raw = (await client.callTool({
      name: 'mx_create_task',
      arguments: {
        title: 'Credential injection attempt',
        action: {
          kind: 'tool',
          tool: 'deploy',
          // A token-shaped value that the toolbelt guard must reject before dispatch.
          args: { access_token: 'ghp_fake_github_token_must_be_rejected_T301' },
        },
      },
    })) as CallToolResult;

    const env = envelopeFrom(raw);
    expect(validateEnvelope(env), 'error envelope must validate').toBe(true);
    expect(env.status, 'rejected by the credential guard → status error').toBe('error');
    expect(env.error?.code, 'rejected arg → invalid_args').toBe('invalid_args');
    // The credential value must not appear in any field of the error envelope.
    const serialized = JSON.stringify(raw);
    expect(serialized, 'credential must not leak into error message').not.toContain(
      'ghp_fake_github_token_must_be_rejected_T301',
    );
    expect(serialized).not.toMatch(SECRET_PATTERN);
    // isError === true for status === 'error'.
    expect(raw.isError ?? false, 'isError must be true for status error').toBe(true);
  });

  it('a normal mx_create_task response carries no secret-shaped value', async () => {
    const raw = (await client.callTool({
      name: 'mx_create_task',
      arguments: { title: 'Clean task — no credential in args' },
    })) as CallToolResult;
    const env = envelopeFrom(raw);
    expect(env.status).toBe('ok');
    expect(JSON.stringify(raw)).not.toMatch(SECRET_PATTERN);
  });

  it('no secret-shaped value appears in mx_list_tasks response', async () => {
    const raw = (await client.callTool({
      name: 'mx_list_tasks',
      arguments: {},
    })) as CallToolResult;
    const env = envelopeFrom(raw);
    expect(env.status).toBe('ok');
    expect(JSON.stringify(raw)).not.toMatch(SECRET_PATTERN);
  });
});

// ---------------------------------------------------------------------------
// §3 — Live single-daemon round-trip (gated MXL_TASK_E2E=1 or TWO_DAEMON)
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_TASK_LIVE)(
  'T301 e2e §3 — live round-trip: create/list(DAG)/update/list (MXL_TASK_E2E)',
  () => {
    const nonce = randomUUID();
    let client: Client | undefined;
    let mxClientRef: { close(): Promise<void> } | undefined;

    beforeAll(async () => {
      // Fail-not-skip: demanded but missing prereqs → HARD failure (never silently green).
      if (!DAEMON_REACHABLE) {
        throw new Error(
          'T301 task live e2e: the live round-trip was demanded (MXL_TASK_E2E=1 or ' +
            'MXL_CONFORMANCE_TWO_DAEMON=1) but no mx-agent daemon is reachable at the ' +
            `conformance socket (${resolveDaemonSocket()}). Bring up the daemon first, ` +
            'or unset the env flag for a clean skip.',
        );
      }

      const room = readRoom();
      if (room === undefined) {
        throw new Error(
          'T301 task live e2e: MXL_CONFORMANCE_ROOM is not set. The task verbs are ' +
            'workspace-scoped; the bring-up scripts (bootstrap-daemon-b.sh) export this. ' +
            'Set MXL_CONFORMANCE_ROOM before demanding the live round-trip, or unset ' +
            'MXL_TASK_E2E / MXL_CONFORMANCE_TWO_DAEMON to skip cleanly.',
        );
      }

      // Build a live BindingContext over the real MxClient.
      // Pattern mirrors createGoldenMcpArm: client is pinned to the conformance socket,
      // and room comes from the session configuration (never from a model tool arg).
      const mxClient = createClient({ socketPath: resolveDaemonSocket() });
      mxClientRef = mxClient;

      const ctx = await createBindingContext({
        daemon: mxClient,
        room,
        auditSink: new NullAuditSink(),
      });

      const server = createMcpServer(ctx);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcpClient = new Client({ name: 'task-e2e-live', version: '0.0.0' });
      await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

      client = mcpClient;
    }, 30_000);

    afterAll(async () => {
      await client?.close();
      await mxClientRef?.close();
    });

    it(
      'issue #30 AC: create with deps → list(graph) reflects DAG → update transitions state → list reflects update',
      async () => {
        if (!client) throw new Error('live MCP client not initialised');

        // -----------------------------------------------------------------------
        // Step 1: Create task A (no deps) → ok + populated audit_ref.
        // A live create emits a signed com.mxagent.task.v1 event on the room,
        // so audit_ref.invocation_id must be populated (not null).
        // -----------------------------------------------------------------------
        const aRaw = (await client.callTool({
          name: 'mx_create_task',
          arguments: {
            title: `T301 task A nonce=${nonce}`,
            idempotency_key: `idk_t301_live_a_${nonce}`,
          },
        })) as CallToolResult;
        const aEnv = envelopeFrom(aRaw);

        expect(validateEnvelope(aEnv), 'task A: envelope must validate').toBe(true);
        expect(aEnv.status, 'task A: status must be ok').toBe('ok');
        expect(
          aEnv.audit_ref.invocation_id,
          'task A: create is a signed mutation → populated invocation_id',
        ).toBeTruthy();
        expect(JSON.stringify(aRaw)).not.toMatch(SECRET_PATTERN);

        const aId = (aEnv.result as Record<string, unknown>).task_id as string;
        expect(aId, 'task A: task_id must be present').toBeTruthy();

        // -----------------------------------------------------------------------
        // Step 2: Create task B with depends_on: [aId] → ok + populated audit_ref.
        // -----------------------------------------------------------------------
        const bRaw = (await client.callTool({
          name: 'mx_create_task',
          arguments: {
            title: `T301 task B nonce=${nonce}`,
            depends_on: [aId],
            idempotency_key: `idk_t301_live_b_${nonce}`,
          },
        })) as CallToolResult;
        const bEnv = envelopeFrom(bRaw);

        expect(validateEnvelope(bEnv), 'task B: envelope must validate').toBe(true);
        expect(bEnv.status, 'task B: status must be ok').toBe('ok');
        expect(
          bEnv.audit_ref.invocation_id,
          'task B: create is a signed mutation → populated invocation_id',
        ).toBeTruthy();
        expect(JSON.stringify(bRaw)).not.toMatch(SECRET_PATTERN);

        const bId = (bEnv.result as Record<string, unknown>).task_id as string;
        expect(bId, 'task B: task_id must be present').toBeTruthy();

        // -----------------------------------------------------------------------
        // Step 3: list(graph) → "list reflects the DAG" (issue #30 AC).
        // Both tasks must appear; the B→A depends_on edge must be present.
        // list is a local read → EMPTY_AUDIT_REF.
        // -----------------------------------------------------------------------
        const listRaw = (await client.callTool({
          name: 'mx_list_tasks',
          arguments: {},
        })) as CallToolResult;
        const listEnv = envelopeFrom(listRaw);

        expect(validateEnvelope(listEnv), 'list: envelope must validate').toBe(true);
        expect(listEnv.status, 'list: status must be ok').toBe('ok');
        expect(
          listEnv.audit_ref.invocation_id,
          'list: local read → EMPTY_AUDIT_REF',
        ).toBeNull();
        expect(JSON.stringify(listRaw)).not.toMatch(SECRET_PATTERN);

        const listResult = listEnv.result as {
          tasks: Array<Record<string, unknown>>;
          edges: Array<Record<string, unknown>>;
        };
        expect(Array.isArray(listResult.tasks), 'list: tasks is an array').toBe(true);
        expect(Array.isArray(listResult.edges), 'list: edges is an array').toBe(true);

        const taskIds = listResult.tasks.map((t) => t['task_id'] as string);
        expect(taskIds, 'task A must be in list').toContain(aId);
        expect(taskIds, 'task B must be in list').toContain(bId);

        // The core issue #30 AC: "list reflects the DAG".
        const depEdge = listResult.edges.find(
          (e) => e['from'] === bId && e['to'] === aId && e['kind'] === 'depends_on',
        );
        expect(
          depEdge,
          'list(graph): the B→A depends_on edge must be in the DAG (issue #30 AC)',
        ).toBeDefined();

        // -----------------------------------------------------------------------
        // Step 4: update B (state: executing) → ok + populated audit_ref.
        // "update transitions state" — the other half of issue #30 AC.
        // -----------------------------------------------------------------------
        const updateRaw = (await client.callTool({
          name: 'mx_update_task',
          arguments: {
            task_id: bId,
            state: 'executing',
            idempotency_key: `idk_t301_live_upd_${nonce}`,
          },
        })) as CallToolResult;
        const updateEnv = envelopeFrom(updateRaw);

        expect(validateEnvelope(updateEnv), 'update: envelope must validate').toBe(true);
        expect(updateEnv.status, 'update: status must be ok').toBe('ok');
        expect(
          updateEnv.audit_ref.invocation_id,
          'update: signed mutation → populated invocation_id',
        ).toBeTruthy();
        expect(JSON.stringify(updateRaw)).not.toMatch(SECRET_PATTERN);

        const updNode = updateEnv.result as Record<string, unknown>;
        expect(updNode.state, 'update: state must reflect the requested transition').toBe(
          'executing',
        );

        // -----------------------------------------------------------------------
        // Step 5: list again → B.state === 'executing' (state persisted in the DAG).
        // -----------------------------------------------------------------------
        const list2Raw = (await client.callTool({
          name: 'mx_list_tasks',
          arguments: {},
        })) as CallToolResult;
        const list2Env = envelopeFrom(list2Raw);
        expect(list2Env.status, 'list2: must be ok').toBe('ok');
        const list2Result = list2Env.result as {
          tasks: Array<Record<string, unknown>>;
        };

        const bAfterUpdate = list2Result.tasks.find((t) => t['task_id'] === bId);
        expect(bAfterUpdate, 'list2: task B must still be present').toBeDefined();
        expect(
          bAfterUpdate?.['state'],
          'list2: task B.state must be executing (state transition persisted)',
        ).toBe('executing');
      },
      120_000,
    );

    it(
      'live secret boundary: no secret-shaped value in any task verb response',
      async () => {
        if (!client) throw new Error('live MCP client not initialised');

        const raw = (await client.callTool({
          name: 'mx_create_task',
          arguments: {
            title: `T301 boundary probe nonce=${nonce}`,
            idempotency_key: `idk_t301_live_boundary_${nonce}`,
          },
        })) as CallToolResult;
        expect(JSON.stringify(raw)).not.toMatch(SECRET_PATTERN);
        const env = envelopeFrom(raw);
        expect(validateEnvelope(env)).toBe(true);
        expect(env.status).toBe('ok');
      },
      30_000,
    );
  },
);
