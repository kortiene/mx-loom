/**
 * The binding context + session wiring (T109).
 *
 * A {@link BindingContext} is the secret-free bundle the server hands every tool
 * call: the injected {@link DaemonCall} (a live `MxSession` or a bare `MxClient`),
 * the session **workspace room** (from `MxSession.room`, **never** model input —
 * the model never names a Matrix room id), the session-stable `correlationId`, and
 * the {@link AuditSink} (default {@link NullAuditSink}). It holds **no** secret: the
 * toolbelt owns the socket and the deny-by-default env allowlist, and every daemon
 * RPC routes through `MxClient.call` (credential-shaped-arg rejection outbound +
 * `redactSecrets` inbound) — this binding re-implements none of it.
 *
 * {@link createBindingContext} prefers opening an `MxSession` (one `agent.register`,
 * a liveness heartbeat, correlation threading) so every RPC is correlation-stamped
 * and guarded; a caller may instead inject an already-open session or a bare
 * `DaemonCall` (the unit-test / embed path). `close()` tears down only what this
 * context opened — an injected session/daemon is the caller's to close.
 */
import { NullAuditSink } from '@mx-loom/audit';
import type { AuditSink } from '@mx-loom/audit';
import type { DaemonCall } from '@mx-loom/registry';
import { openSession } from '@mx-loom/toolbelt';
import type { MxSession, MxSessionOptions } from '@mx-loom/toolbelt';

/**
 * The secret-free per-server context threaded into every tool dispatch.
 *
 * `room` is `undefined` when the session is not workspace-scoped; the room-scoped
 * verbs (`mx_delegate_tool` / `mx_run_command` / `mx_share_context` / …) then fail
 * fast inside their handler rather than dispatch a room-less RPC — the room is
 * never taken from model input.
 */
export interface BindingContext {
  /** The injected daemon-call seam — an `MxSession` (preferred) or a bare `MxClient`. */
  readonly daemon: DaemonCall;
  /** The workspace room from `MxSession.room` (never model input); `undefined` if unscoped. */
  readonly room: string | undefined;
  /** Session-stable correlation id (for the audit tap), if a session supplied one. */
  readonly correlationId: string | undefined;
  /** The audit sink the `withAudit` tap records through. Default: {@link NullAuditSink}. */
  readonly auditSink: AuditSink;
  /** Tear down only what this context opened (the session it built). Idempotent. */
  close(): Promise<void>;
}

/** Options for {@link createBindingContext}. */
export interface CreateBindingContextOptions {
  /**
   * An already-open `MxSession` to bind to. The room/correlation come from it and
   * `close()` does **not** close it (the caller owns its lifecycle).
   */
  session?: MxSession;
  /**
   * A bare {@link DaemonCall} (e.g. an `MxClient` or a unit-test fake) to bind to
   * directly, bypassing session registration. `close()` does not close it. Supply
   * {@link room} alongside it for the room-scoped verbs.
   */
  daemon?: DaemonCall;
  /** Workspace room when binding a bare {@link daemon} (ignored when a session supplies one). */
  room?: string;
  /** Options forwarded to `openSession` when neither {@link session} nor {@link daemon} is given. */
  sessionOptions?: MxSessionOptions;
  /** The audit sink. Default: a {@link NullAuditSink} (audit disabled). */
  auditSink?: AuditSink;
}

const noopClose = async (): Promise<void> => {
  /* nothing this context owns to close */
};

/**
 * Build a {@link BindingContext}.
 *
 * Resolution order:
 *  1. an injected open {@link CreateBindingContextOptions.session} — bound as-is;
 *  2. an injected bare {@link CreateBindingContextOptions.daemon} — bound with the
 *     supplied {@link CreateBindingContextOptions.room};
 *  3. otherwise, open a fresh `MxSession` via `openSession` (the production path) —
 *     and `close()` will close it.
 */
export async function createBindingContext(
  options: CreateBindingContextOptions = {},
): Promise<BindingContext> {
  const auditSink = options.auditSink ?? new NullAuditSink();

  if (options.session !== undefined) {
    const session = options.session;
    return {
      daemon: session,
      room: session.room,
      correlationId: session.correlationId,
      auditSink,
      close: noopClose,
    };
  }

  if (options.daemon !== undefined) {
    return {
      daemon: options.daemon,
      room: options.room,
      correlationId: undefined,
      auditSink,
      close: noopClose,
    };
  }

  const session = await openSession(options.sessionOptions);
  return {
    daemon: session,
    room: session.room,
    correlationId: session.correlationId,
    auditSink,
    close: () => session.close(),
  };
}
