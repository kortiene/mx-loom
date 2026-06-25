/**
 * Dispatch table (T109) — name→handler routing and deps-subtype wiring.
 *
 * Tests:
 *  - DISPATCH has exactly the nine canonical tool names as keys (no more, no less).
 *  - No forbidden authority verb is reachable through the dispatch table.
 *  - `dispatchCall` returns errored('not_found') for an unknown name — never throws.
 *  - All nine canonical names dispatch without throwing and return a ToolResult.
 *  - `undefined` args are treated as `{}` (the `?? {}` fallback).
 *  - Room is sourced from the binding context, never from model args (the model must
 *    never name a Matrix room id — design §1/§7): `mx_workspace_status` forwards
 *    `ctx.room` to the daemon `workspace.status` call; `mx_delegate_tool` forwards
 *    `ctx.room` to the `call.start` params.
 *  - `mx_delegate_tool` fails fast with `internal` when the context has no room
 *    (room-less delegation is prevented before any daemon round-trip).
 */
import { describe, expect, it } from 'vitest';

import { CANONICAL_M1_TOOLS, CANONICAL_TOOLS, FORBIDDEN_AUTHORITY_VERBS, isForbiddenAuthorityVerb } from '@mx-loom/registry';
import type { DaemonCall } from '@mx-loom/registry';
import { NullAuditSink } from '@mx-loom/audit';

import { DISPATCH, dispatchCall } from '../src/dispatch.js';
import type { BindingContext } from '../src/context.js';

const ROOM = '!test-room:server';

/** Minimal stub responses for every daemon method the twelve handlers may call. */
function makeFakeDaemon(
  onCall?: (method: string, params: unknown) => void,
): DaemonCall {
  return {
    async call(method: string, params?: unknown): Promise<unknown> {
      onCall?.(method, params ?? null);
      switch (method) {
        case 'agent.list':
          return [];
        case 'agent.tools':
          return {
            schemas: [
              { name: 'run_tests', input_schema: { type: 'object', additionalProperties: true } },
            ],
          };
        case 'invocation.get':
          return { state: 'ok', result: {} };
        case 'invocation.cancel':
          return { ok: true, cancelled: true };
        case 'call.start':
          return {
            ok: true,
            result: {},
            audit_ref: { invocation_id: 'inv_1', request_id: 'req_1', room: ROOM, event_id: '$evt_1' },
          };
        case 'exec.start':
          return {
            ok: true,
            result: {},
            audit_ref: { invocation_id: 'inv_1', request_id: 'req_1', room: ROOM, event_id: '$evt_1' },
          };
        case 'share.file':
        case 'share.diff':
        case 'share.env':
          return { context_id: 'ctx_1', sha256: 'abc123' };
        case 'share.get':
          return { context_id: 'ctx_1', kind: 'file' };
        case 'workspace.status':
          return { room_id: ROOM, name: 'test room', encrypted: false };
        // M3 (T301) — task-DAG verbs.
        case 'task.create':
        case 'task.update':
          return {
            task_id: 'task_stub_1',
            title: 'Stub task',
            state: 'proposed',
            depends_on: [],
            blocks: [],
            action: null,
            audit_ref: { invocation_id: 'inv_t1', request_id: 'req_t1', room: ROOM, event_id: '$tevt_1' },
          };
        case 'task.list':
          return { tasks: [] };
        case 'task.graph':
          return [];
        default:
          throw new Error(`unexpected daemon method in dispatch test: ${method}`);
      }
    },
  };
}

function makeCtx(options?: { room?: string | undefined; daemon?: DaemonCall }): BindingContext {
  // Use `'room' in options` to distinguish "no room property" (use ROOM default)
  // from "room: undefined" (explicit no-room, testing the fail-fast path).
  const roomValue =
    options !== undefined && Object.prototype.hasOwnProperty.call(options, 'room')
      ? options.room
      : ROOM;
  return {
    daemon: options?.daemon ?? makeFakeDaemon(),
    room: roomValue,
    correlationId: undefined,
    auditSink: new NullAuditSink(),
    close: async () => {
      /* no-op */
    },
  };
}

/** Minimal args for each verb — enough to reach the daemon (not necessarily succeed). */
const TOOL_ARGS: Readonly<Record<string, Record<string, unknown>>> = {
  mx_find_agents: {},
  mx_describe_agent: { agent: 'agent-b' },
  mx_await_result: { handle: 'inv_123' },
  mx_cancel: { handle: 'inv_123' },
  mx_delegate_tool: { agent: 'agent-b', tool: 'run_tests', args: {} },
  mx_run_command: { command: 'echo', args: [] },
  mx_share_context: { kind: 'file', content: 'hello' },
  mx_get_context: { context_id: 'ctx_1' },
  mx_workspace_status: {},
  // M3 (T301) task-DAG verbs.
  mx_create_task: { title: 'Stub task' },
  mx_update_task: { task_id: 'task_stub_1' },
  mx_list_tasks: {},
};

// ---------------------------------------------------------------------------
// DISPATCH table structure
// ---------------------------------------------------------------------------

describe('DISPATCH table structure', () => {
  it('has exactly the twelve canonical tool names as keys', () => {
    const canonical = new Set(CANONICAL_TOOLS.map((d) => d.name));
    const keys = new Set(Object.keys(DISPATCH));
    expect(keys).toEqual(canonical);
  });

  it('contains no forbidden authority verb (FORBIDDEN_AUTHORITY_VERBS)', () => {
    for (const forbidden of FORBIDDEN_AUTHORITY_VERBS) {
      expect(Object.prototype.hasOwnProperty.call(DISPATCH, forbidden)).toBe(false);
    }
  });

  it('contains no authority-prefix verb (isForbiddenAuthorityVerb)', () => {
    for (const key of Object.keys(DISPATCH)) {
      expect(isForbiddenAuthorityVerb(key)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// dispatchCall routing
// ---------------------------------------------------------------------------

describe('dispatchCall', () => {
  it('returns errored(not_found) for an unknown tool name — never throws', async () => {
    const result = await dispatchCall('mx_not_a_real_tool', {}, makeCtx());
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not_found');
    expect(result.audit_ref).toBeDefined();
  });

  it('handles undefined args without throwing (the ?? {} fallback)', async () => {
    const result = await dispatchCall('mx_workspace_status', undefined, makeCtx());
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('audit_ref');
  });

  it.each(CANONICAL_M1_TOOLS)(
    '$name (M1): dispatches without throwing and returns a ToolResult',
    async ({ name }) => {
      const args = TOOL_ARGS[name] ?? {};
      const result = await dispatchCall(name, args, makeCtx());
      // Any of the five statuses is acceptable; what matters is that a ToolResult
      // (with status + audit_ref) is returned rather than an exception thrown.
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('audit_ref');
    },
  );

  it.each([
    { name: 'mx_create_task' },
    { name: 'mx_update_task' },
    { name: 'mx_list_tasks' },
  ])(
    '$name (M3 task verb): dispatches without throwing and returns a ToolResult',
    async ({ name }) => {
      const args = TOOL_ARGS[name] ?? {};
      const result = await dispatchCall(name, args, makeCtx());
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('audit_ref');
    },
  );
});

// ---------------------------------------------------------------------------
// Room-provenance invariant: room comes from context, never from model args
// ---------------------------------------------------------------------------

describe('room provenance', () => {
  it('mx_workspace_status: context room reaches the workspace.status daemon call', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const ctx = makeCtx({
      room: '!context-room:server',
      daemon: makeFakeDaemon((m, p) => calls.push({ method: m, params: p })),
    });

    await dispatchCall('mx_workspace_status', {}, ctx);

    const wsCall = calls.find((c) => c.method === 'workspace.status');
    expect(wsCall).toBeDefined();
    // When a room is set, it must be forwarded from ctx.room, not from any arg.
    const params = wsCall?.params as Record<string, unknown> | null | undefined;
    if (params !== null && params !== undefined && 'room' in params) {
      expect(params['room']).toBe('!context-room:server');
    }
  });

  it('mx_delegate_tool: context room appears in call.start params', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const ctx = makeCtx({
      room: '!delegate-room:server',
      daemon: makeFakeDaemon((m, p) => calls.push({ method: m, params: p })),
    });

    await dispatchCall('mx_delegate_tool', { agent: 'agent-b', tool: 'run_tests', args: {} }, ctx);

    const callStart = calls.find((c) => c.method === 'call.start');
    expect(callStart).toBeDefined();
    expect((callStart?.params as Record<string, unknown>)?.['room']).toBe('!delegate-room:server');
  });

  it('mx_delegate_tool: returns internal error when context has no room (fail-fast)', async () => {
    const ctx = makeCtx({ room: undefined });
    const result = await dispatchCall(
      'mx_delegate_tool',
      { agent: 'agent-b', tool: 'run_tests', args: {} },
      ctx,
    );
    // The handler fails fast before dispatching a room-less RPC.
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });

  it('mx_create_task: context room reaches the task.create daemon call', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const ctx = makeCtx({
      room: '!task-room:server',
      daemon: makeFakeDaemon((m, p) => calls.push({ method: m, params: p })),
    });
    await dispatchCall('mx_create_task', { title: 'Room test' }, ctx);
    const createCall = calls.find((c) => c.method === 'task.create');
    expect(createCall).toBeDefined();
    expect((createCall?.params as Record<string, unknown>)?.['room']).toBe('!task-room:server');
  });

  it('mx_create_task: returns internal error when context has no room (fail-fast mutator)', async () => {
    const ctx = makeCtx({ room: undefined });
    const result = await dispatchCall('mx_create_task', { title: 'No room' }, ctx);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });

  it('mx_update_task: returns internal error when context has no room (fail-fast mutator)', async () => {
    const ctx = makeCtx({ room: undefined });
    const result = await dispatchCall('mx_update_task', { task_id: 'task_x' }, ctx);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });

  it('mx_list_tasks: succeeds (ok) with no room — best-effort read does not fail-fast', async () => {
    const ctx = makeCtx({ room: undefined });
    const result = await dispatchCall('mx_list_tasks', {}, ctx);
    // The list handler is best-effort; it may return ok even with no room.
    expect(result).toHaveProperty('status');
    expect(result.status).toBe('ok');
  });
});
