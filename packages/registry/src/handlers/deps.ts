/**
 * The injected daemon-call seam shared by the M1 handlers (T103 / #11) — design
 * §4.3 (the deferred-result protocol) / §5 (the invocation flow).
 *
 * T103 is the **first** handler, so it establishes the seam T104–T108 reuse: a
 * handler never opens a socket, reads an env var, or imports a concrete client.
 * It depends only on the narrow {@link DaemonCall} surface below, which the
 * caller (a binding: MCP T109, Claude shim T110) satisfies with a concrete
 * `MxClient` — the client that already enforces the deny-by-default env allowlist
 * and inbound `redactSecrets` (T008) on every `call()`.
 *
 * Because {@link DaemonCall} is structurally a subset of the toolbelt's
 * `MxTransport` **interface**, this module imports it `type`-only (erased under
 * `verbatimModuleSyntax`). The registry therefore keeps `@mx-loom/toolbelt` a
 * **devDependency** and gains **no runtime dependency** on it — exactly the
 * technique `src/errors.ts` already uses for `TransportErrorCode`.
 */
import type { MxTransport } from '@mx-loom/toolbelt';

import type { SchemaValidator } from '../validator.js';

/**
 * The daemon-call surface a handler needs: a structural subset of
 * {@link MxTransport} (just `call`). A concrete `MxClient` satisfies it, and so
 * does a one-line fake in unit tests — so a handler is testable with no daemon,
 * no socket, and no toolbelt runtime dependency.
 */
export type DaemonCall = Pick<MxTransport, 'call'>;

/**
 * Injected dependencies + testing seams shared by handlers. Only {@link daemon}
 * is required; the clock/interval seams default to real `setTimeout` / `Date.now`
 * and a bounded poll interval, and exist so the `mx_await_result` poll loop is
 * deterministic under test (mirroring the toolbelt's `retry.ts` `sleep`/`random`
 * injection precedent).
 */
export interface HandlerDeps {
  /** The injected daemon-call seam (e.g. a concrete `MxClient`). */
  readonly daemon: DaemonCall;
  /** Wait `ms` milliseconds. Default: a real, unref'd `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Monotonic-ish clock for the poll deadline. Default: `Date.now`. */
  readonly now?: () => number;
  /**
   * Base poll interval in ms for the `wait_ms` loop (default ~200 ms; clamped to
   * a small floor so it never busy-waits and a ~2 s cap so a large `wait_ms`
   * cannot hammer the daemon).
   */
  readonly pollIntervalMs?: number;
}

/**
 * The deps for `mx_delegate_tool` (T105 / #13) — {@link HandlerDeps} plus the two
 * things a delegation needs that the read handlers do not, both **injected** (not
 * model-facing):
 *
 *  - {@link validator} — a JSON Schema validator used to validate the caller's
 *    `args` against the *target tool's* published `input_schema` **before**
 *    dispatch (T105 AC 2). Defaults to a lazily-created Ajv validator, so the
 *    common path needs no wiring while tests can inject a fake.
 *  - {@link room} — the session/workspace room the delegation is scoped to. It
 *    comes from the binding's `MxSession` (T005), **never** from model input: the
 *    model must never name a Matrix room id (a coordination-plane detail, design
 *    §1/§7). The handler fails fast (`internal`) rather than dispatch a room-less
 *    `call.start` when it is absent.
 *
 * A dedicated interface (vs. widening {@link HandlerDeps}) keeps the T103/T104 read
 * handlers' deps minimal — they neither validate args nor need a room.
 */
export interface DelegateDeps extends HandlerDeps {
  /** JSON Schema validator for dynamic args validation. Default: a lazily-created Ajv validator. */
  readonly validator?: SchemaValidator;
  /** The session/workspace room the delegation is scoped to (from `MxSession`, NOT model input). */
  readonly room?: string;
}
