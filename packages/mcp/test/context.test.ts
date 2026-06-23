/**
 * createBindingContext (T109) — deterministic resolution paths.
 *
 * Only the two injected-dependency paths are tested here; the live `openSession`
 * path (path 3) requires a daemon and belongs in e2e tests.
 *
 * Tests:
 *  - Session injection: `ctx.room`/`ctx.correlationId` come from the session;
 *    `ctx.daemon` is the session itself (the `DaemonCall` seam); `ctx.close()` is
 *    a noop that does NOT propagate to `session.close()` (the caller owns it).
 *  - Daemon injection: `ctx.daemon` is the injected daemon; `ctx.room` is the
 *    supplied room (never model input); `ctx.correlationId` is `undefined`;
 *    `ctx.close()` is a noop.
 *  - `auditSink` defaults to `NullAuditSink` when omitted; a supplied sink is used.
 *  - `close()` resolves without throwing when called more than once (idempotent).
 */
import { describe, expect, it, vi } from 'vitest';

import { InMemoryAuditSink, NullAuditSink } from '@mx-loom/audit';
import type { DaemonCall } from '@mx-loom/registry';
import type { MxSession } from '@mx-loom/toolbelt';

import { createBindingContext } from '../src/context.js';

const ROOM = '!ctx-test:server';
const CORR_ID = 'corr-ctx-test-abc-123';

function fakeDaemon(): DaemonCall {
  return {
    async call(): Promise<unknown> {
      throw new Error('fakeDaemon.call should not be invoked in context tests');
    },
  };
}

/**
 * Build a minimal structural fake that satisfies the `MxSession` interface for
 * the properties `createBindingContext` actually reads (`room`, `correlationId`,
 * `close`). The cast is intentional: the full `AgentState` shape is irrelevant to
 * the context binding path; only the fields context.ts reads matter.
 */
function fakeSession(opts: {
  room?: string | undefined;
  correlationId?: string;
  onClose?: () => void;
}): MxSession {
  return {
    agentId: 'fake-agent',
    // Minimal agentState shape; not read by createBindingContext.
    agentState: {
      agent_id: 'fake-agent',
      kind: 'test',
      matrix_user_id: '@bot:server',
      device_id: 'FAKE',
      signing_key_id: 'mxagent-ed25519:fake',
      signing_public_key: 'AAAA',
      status: 'active',
      capabilities: [],
      tools: [],
      workspace: {},
      load: { running_invocations: 0, max_invocations: 1 },
      last_seen_ts: 0,
      state_rev: 0,
    } as const,
    room: opts.room,
    correlationId: opts.correlationId ?? CORR_ID,
    state: 'active',
    async call(): Promise<unknown> { return null; },
    async liveness() { return 'active'; },
    async close(): Promise<void> { opts.onClose?.(); },
  } as unknown as MxSession;
}

// ---------------------------------------------------------------------------
// Session injection path
// ---------------------------------------------------------------------------

describe('session injection path', () => {
  it('room comes from the session', async () => {
    const session = fakeSession({ room: ROOM });
    const ctx = await createBindingContext({ session });
    expect(ctx.room).toBe(ROOM);
  });

  it('correlationId comes from the session', async () => {
    const session = fakeSession({ room: ROOM, correlationId: CORR_ID });
    const ctx = await createBindingContext({ session });
    expect(ctx.correlationId).toBe(CORR_ID);
  });

  it('daemon is the session (the DaemonCall seam)', async () => {
    const session = fakeSession({ room: ROOM });
    const ctx = await createBindingContext({ session });
    expect(ctx.daemon).toBe(session);
  });

  it('close() is a noop — it does NOT propagate to session.close()', async () => {
    const onClose = vi.fn();
    const session = fakeSession({ room: ROOM, onClose });
    const ctx = await createBindingContext({ session });

    await ctx.close();

    expect(onClose).not.toHaveBeenCalled();
  });

  it('room is undefined when the session has no room', async () => {
    const session = fakeSession({ room: undefined });
    const ctx = await createBindingContext({ session });
    expect(ctx.room).toBeUndefined();
  });

  it('auditSink defaults to NullAuditSink when omitted', async () => {
    const session = fakeSession({ room: ROOM });
    const ctx = await createBindingContext({ session });
    expect(ctx.auditSink).toBeInstanceOf(NullAuditSink);
  });

  it('a supplied auditSink is used', async () => {
    const session = fakeSession({ room: ROOM });
    const sink = new InMemoryAuditSink();
    const ctx = await createBindingContext({ session, auditSink: sink });
    expect(ctx.auditSink).toBe(sink);
  });
});

// ---------------------------------------------------------------------------
// Daemon injection path
// ---------------------------------------------------------------------------

describe('daemon injection path', () => {
  it('daemon is the injected DaemonCall', async () => {
    const daemon = fakeDaemon();
    const ctx = await createBindingContext({ daemon, room: ROOM });
    expect(ctx.daemon).toBe(daemon);
  });

  it('room comes from the supplied option, never from model input', async () => {
    const ctx = await createBindingContext({ daemon: fakeDaemon(), room: ROOM });
    expect(ctx.room).toBe(ROOM);
  });

  it('correlationId is undefined (no session to supply one)', async () => {
    const ctx = await createBindingContext({ daemon: fakeDaemon(), room: ROOM });
    expect(ctx.correlationId).toBeUndefined();
  });

  it('room is undefined when not supplied', async () => {
    const ctx = await createBindingContext({ daemon: fakeDaemon() });
    expect(ctx.room).toBeUndefined();
  });

  it('close() is a noop (does not throw)', async () => {
    const ctx = await createBindingContext({ daemon: fakeDaemon(), room: ROOM });
    await expect(ctx.close()).resolves.toBeUndefined();
  });

  it('auditSink defaults to NullAuditSink when omitted', async () => {
    const ctx = await createBindingContext({ daemon: fakeDaemon(), room: ROOM });
    expect(ctx.auditSink).toBeInstanceOf(NullAuditSink);
  });

  it('a supplied auditSink is used', async () => {
    const sink = new InMemoryAuditSink();
    const ctx = await createBindingContext({ daemon: fakeDaemon(), room: ROOM, auditSink: sink });
    expect(ctx.auditSink).toBe(sink);
  });
});

// ---------------------------------------------------------------------------
// close() idempotency (both paths)
// ---------------------------------------------------------------------------

describe('close() idempotency', () => {
  it('daemon path: close() resolves cleanly when called twice', async () => {
    const ctx = await createBindingContext({ daemon: fakeDaemon(), room: ROOM });
    await ctx.close();
    await expect(ctx.close()).resolves.toBeUndefined();
  });

  it('session path: close() resolves cleanly when called twice', async () => {
    const session = fakeSession({ room: ROOM });
    const ctx = await createBindingContext({ session });
    await ctx.close();
    await expect(ctx.close()).resolves.toBeUndefined();
  });
});
