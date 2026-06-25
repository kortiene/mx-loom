/**
 * Binding context (T205) — createPiBindingContext resolution paths.
 *
 * Tests:
 *  - Daemon injection path: room/correlationId come from options; close is no-op.
 *  - Session injection path: room/correlationId come from the injected session;
 *    close is no-op (does NOT close the caller's session).
 *  - Default auditSink is NullAuditSink when omitted.
 *  - Daemon path with no room: room is undefined.
 *  - close() is idempotent (calling it multiple times does not throw).
 *  - Session injection exposes the session's daemon as the context daemon.
 *  - Multiple independent contexts do not share state (distinct room values).
 */
import { describe, expect, it } from 'vitest';

import { NullAuditSink, InMemoryAuditSink } from '@mx-loom/audit';
import type { AuditSink } from '@mx-loom/audit';
import type { DaemonCall } from '@mx-loom/registry';
import type { AgentLiveness, AgentState } from '@mx-loom/toolbelt';
import type { MxSession, SessionDescriptor, SessionState, TaskCursor } from '@mx-loom/toolbelt';

import { createPiBindingContext } from '../src/context.js';
import { ROOM, makeFakeDaemon } from './helpers.js';

// ---------------------------------------------------------------------------
// Fake MxSession — structurally satisfies the session injection path.
// ---------------------------------------------------------------------------

function makeFakeSession(overrides?: {
  room?: string | undefined;
  correlationId?: string;
}): MxSession & { closeCalled: boolean } {
  let closeCalled = false;
  const daemon = makeFakeDaemon();
  const room = overrides?.room ?? '!session-room:server';
  const correlationId = overrides?.correlationId ?? 'corr-session-test-abc';
  const agentState: AgentState = {
    agent_id: 'agent-ctx-test',
    kind: 'test',
    matrix_user_id: '@agent-ctx-test:server',
    device_id: 'DEVICE_CTX_TEST',
    signing_key_id: 'mxagent-ed25519:test',
    signing_public_key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    status: 'active',
    capabilities: [],
    tools: [],
    workspace: {},
    load: { running_invocations: 0, max_invocations: 1 },
    last_seen_ts: 0,
    state_rev: 0,
  };
  const session = {
    agentId: 'agent-ctx-test',
    agentState,
    room,
    correlationId,
    state: 'active' as SessionState,
    get closeCalled() {
      return closeCalled;
    },
    call: daemon.call.bind(daemon),
    async liveness(): Promise<AgentLiveness> {
      return 'active';
    },
    describe(cursor?: TaskCursor): SessionDescriptor {
      return {
        v: 1,
        agent_id: 'agent-ctx-test',
        room,
        correlation_id: correlationId,
        ...(cursor !== undefined ? { cursor } : {}),
      };
    },
    async close() {
      closeCalled = true;
    },
  };
  return session;
}

// ---------------------------------------------------------------------------
// Daemon injection path
// ---------------------------------------------------------------------------

describe('daemon injection path', () => {
  it('room comes from options (not from any session)', async () => {
    const ctx = await createPiBindingContext({
      daemon: makeFakeDaemon(),
      room: ROOM,
    });
    expect(ctx.room).toBe(ROOM);
  });

  it('correlationId is undefined (no session to supply one)', async () => {
    const ctx = await createPiBindingContext({
      daemon: makeFakeDaemon(),
      room: ROOM,
    });
    expect(ctx.correlationId).toBeUndefined();
  });

  it('daemon property is the injected DaemonCall', async () => {
    const daemon = makeFakeDaemon();
    const ctx = await createPiBindingContext({ daemon, room: ROOM });
    expect(ctx.daemon).toBe(daemon);
  });

  it('close() is a no-op and does not throw', async () => {
    const ctx = await createPiBindingContext({ daemon: makeFakeDaemon(), room: ROOM });
    await expect(ctx.close()).resolves.toBeUndefined();
  });

  it('close() is idempotent (calling twice does not throw)', async () => {
    const ctx = await createPiBindingContext({ daemon: makeFakeDaemon(), room: ROOM });
    await ctx.close();
    await expect(ctx.close()).resolves.toBeUndefined();
  });

  it('room is undefined when not supplied (unscoped daemon)', async () => {
    const ctx = await createPiBindingContext({ daemon: makeFakeDaemon() });
    expect(ctx.room).toBeUndefined();
  });

  it('auditSink is the supplied sink', async () => {
    const sink = new InMemoryAuditSink();
    const ctx = await createPiBindingContext({ daemon: makeFakeDaemon(), room: ROOM, auditSink: sink });
    expect(ctx.auditSink).toBe(sink);
  });

  it('auditSink defaults to NullAuditSink when omitted', async () => {
    const ctx = await createPiBindingContext({ daemon: makeFakeDaemon(), room: ROOM });
    expect(ctx.auditSink).toBeInstanceOf(NullAuditSink);
  });
});

// ---------------------------------------------------------------------------
// Session injection path
// ---------------------------------------------------------------------------

describe('session injection path', () => {
  it('room comes from the injected session', async () => {
    const session = makeFakeSession({ room: '!injected-session-room:server' });
    const ctx = await createPiBindingContext({ session });
    expect(ctx.room).toBe('!injected-session-room:server');
  });

  it('correlationId comes from the injected session', async () => {
    const session = makeFakeSession({ correlationId: 'corr-injected-session-xyz' });
    const ctx = await createPiBindingContext({ session });
    expect(ctx.correlationId).toBe('corr-injected-session-xyz');
  });

  it('daemon is the session itself (session satisfies DaemonCall)', async () => {
    const session = makeFakeSession();
    const ctx = await createPiBindingContext({ session });
    expect(ctx.daemon).toBe(session);
  });

  it('close() does NOT close the injected session (caller owns it)', async () => {
    const session = makeFakeSession();
    const ctx = await createPiBindingContext({ session });
    await ctx.close();
    expect(session.closeCalled).toBe(false);
  });

  it('close() is idempotent for the session path', async () => {
    const session = makeFakeSession();
    const ctx = await createPiBindingContext({ session });
    await ctx.close();
    await expect(ctx.close()).resolves.toBeUndefined();
  });

  it('auditSink is injected independently of the session', async () => {
    const sink = new InMemoryAuditSink();
    const session = makeFakeSession();
    const ctx = await createPiBindingContext({ session, auditSink: sink });
    expect(ctx.auditSink).toBe(sink);
  });

  it('session with undefined room → ctx.room is undefined', async () => {
    const session = makeFakeSession({ room: undefined });
    // Force the room field to undefined (the type allows it).
    const sessionWithNoRoom = { ...session, room: undefined };
    const ctx = await createPiBindingContext({ session: sessionWithNoRoom as MxSession });
    expect(ctx.room).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Multiple independent contexts
// ---------------------------------------------------------------------------

describe('multiple independent contexts', () => {
  it('two contexts with different rooms do not share room state', async () => {
    const ctx1 = await createPiBindingContext({
      daemon: makeFakeDaemon(),
      room: '!room-ctx1:server',
    });
    const ctx2 = await createPiBindingContext({
      daemon: makeFakeDaemon(),
      room: '!room-ctx2:server',
    });
    expect(ctx1.room).toBe('!room-ctx1:server');
    expect(ctx2.room).toBe('!room-ctx2:server');
  });

  it('closing one context does not affect the other', async () => {
    const ctx1 = await createPiBindingContext({ daemon: makeFakeDaemon(), room: ROOM });
    const ctx2 = await createPiBindingContext({ daemon: makeFakeDaemon(), room: ROOM });
    await ctx1.close();
    // ctx2 should still be usable
    await expect(ctx2.close()).resolves.toBeUndefined();
  });
});
