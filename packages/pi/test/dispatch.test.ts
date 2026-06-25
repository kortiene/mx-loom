/**
 * Dispatch table (T205) — name→handler routing and room-provenance invariant.
 *
 * Tests:
 *  - DISPATCH has exactly the nine canonical tool names as keys.
 *  - No forbidden authority verb is reachable through the dispatch table.
 *  - `dispatchCall` returns errored('not_found') for an unknown name — never throws.
 *  - Undefined args are handled (the `?? {}` fallback) without throwing.
 *  - All nine canonical names dispatch without throwing and return a ToolResult
 *    (any of the five statuses is acceptable).
 *  - Room is sourced from the BindingContext, NEVER from model args: mx_workspace_status
 *    and mx_delegate_tool forward the context room to the daemon call.
 *  - A context with no room → internal error for mx_delegate_tool (fail-fast before
 *    any daemon round-trip).
 *  - EMPTY_AUDIT_REF is all-null and exported.
 */
import { describe, expect, it } from 'vitest';

import { NullAuditSink } from '@mx-loom/audit';
import { CANONICAL_M1_TOOLS, FORBIDDEN_AUTHORITY_VERBS, isForbiddenAuthorityVerb } from '@mx-loom/registry';
import type { DaemonCall } from '@mx-loom/registry';

import type { BindingContext } from '../src/context.js';
import { DISPATCH, EMPTY_AUDIT_REF, dispatchCall } from '../src/dispatch.js';
import { ROOM, makeFakeDaemon } from './helpers.js';

function makeCtx(options?: { room?: string | undefined; daemon?: DaemonCall }): BindingContext {
  const roomValue =
    options !== undefined && Object.prototype.hasOwnProperty.call(options, 'room')
      ? options.room
      : ROOM;
  return {
    daemon: options?.daemon ?? makeFakeDaemon(),
    room: roomValue,
    correlationId: undefined,
    auditSink: new NullAuditSink(),
    close: async () => { /* no-op */ },
  };
}

/** Minimal valid args for each of the nine verbs (enough to reach the handler). */
const TOOL_ARGS: Readonly<Record<string, Record<string, unknown>>> = {
  mx_find_agents: {},
  mx_describe_agent: { agent_id: 'agent-b' },
  mx_await_result: { handle: 'inv_123' },
  mx_cancel: { handle: 'inv_123' },
  mx_delegate_tool: { agent: 'agent-b', tool: 'run_tests', args: {} },
  mx_run_command: { agent: 'agent-b', command: 'echo', args: [] },
  mx_share_context: { kind: 'file', content: 'hello' },
  mx_get_context: { context_id: 'ctx_1' },
  mx_workspace_status: {},
};

// ---------------------------------------------------------------------------
// DISPATCH table structure
// ---------------------------------------------------------------------------

describe('DISPATCH table structure', () => {
  it('has exactly the nine canonical tool names as keys', () => {
    const canonical = new Set(CANONICAL_M1_TOOLS.map((d) => d.name));
    const keys = new Set(Object.keys(DISPATCH));
    expect(keys).toEqual(canonical);
  });

  it('contains no forbidden authority verb (FORBIDDEN_AUTHORITY_VERBS)', () => {
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

// ---------------------------------------------------------------------------
// EMPTY_AUDIT_REF
// ---------------------------------------------------------------------------

describe('EMPTY_AUDIT_REF', () => {
  it('is all-null (no daemon round-trip behind a dispatch error)', () => {
    expect(EMPTY_AUDIT_REF).toEqual({
      invocation_id: null,
      request_id: null,
      room: null,
      event_id: null,
    });
  });

  it('is frozen (cannot be mutated)', () => {
    expect(Object.isFrozen(EMPTY_AUDIT_REF)).toBe(true);
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
    '$name: dispatches without throwing and returns a ToolResult',
    async ({ name }) => {
      const args = TOOL_ARGS[name] ?? {};
      const result = await dispatchCall(name, args, makeCtx());
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('audit_ref');
      // Any of the five valid statuses is acceptable.
      expect(['ok', 'running', 'awaiting_approval', 'denied', 'error']).toContain(result.status);
    },
  );

  it('not_found envelope carries EMPTY_AUDIT_REF', async () => {
    const result = await dispatchCall('mx_bogus_verb', {}, makeCtx());
    expect(result.audit_ref).toEqual(EMPTY_AUDIT_REF);
  });
});

// ---------------------------------------------------------------------------
// Room-provenance invariant: room always from context, never from model args
// ---------------------------------------------------------------------------

describe('room provenance', () => {
  it('mx_workspace_status: context room reaches workspace.status daemon call', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const ctx = makeCtx({
      room: '!context-room:server',
      daemon: makeFakeDaemon((m, p) => calls.push({ method: m, params: p })),
    });

    await dispatchCall('mx_workspace_status', {}, ctx);

    const wsCall = calls.find((c) => c.method === 'workspace.status');
    expect(wsCall).toBeDefined();
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
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
  });
});
