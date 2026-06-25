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
 * {@link HandlerDeps} plus the session **workspace room** a *mutating* verb is
 * scoped to. The room comes from the binding's `MxSession` (T005), **never** from
 * model input: the model must never name a Matrix room id (a coordination-plane
 * detail, design §1/§7). A room-scoped handler fails fast (`internal`) rather than
 * dispatch a room-less RPC when it is absent.
 *
 * Single-sources the `room` provenance contract for both `mx_delegate_tool` (T105,
 * {@link DelegateDeps}) and `mx_run_command` (T106, {@link ExecDeps}) so the rule
 * lives in exactly one place. The T103/T104 *read* handlers stay on the narrower
 * {@link HandlerDeps} — they need no room.
 */
export interface RoomScopedDeps extends HandlerDeps {
  /** The session/workspace room the verb is scoped to (from `MxSession`, NOT model input). */
  readonly room?: string;
}

/**
 * The deps for `mx_delegate_tool` (T105 / #13) — {@link RoomScopedDeps} plus the
 * one extra thing a delegation needs that guarded exec does not, **injected** (not
 * model-facing):
 *
 *  - {@link validator} — a JSON Schema validator used to validate the caller's
 *    `args` against the *target tool's* published `input_schema` **before**
 *    dispatch (T105 AC 2). Defaults to a lazily-created Ajv validator, so the
 *    common path needs no wiring while tests can inject a fake.
 *
 * The {@link RoomScopedDeps.room} provenance rule is identical to `mx_run_command`.
 */
export interface DelegateDeps extends RoomScopedDeps {
  /** JSON Schema validator for dynamic args validation. Default: a lazily-created Ajv validator. */
  readonly validator?: SchemaValidator;
}

/**
 * The deps for `mx_run_command` (T106 / #14) — {@link RoomScopedDeps} with **no**
 * validator. Unlike delegation, guarded exec has a *fixed* input shape
 * (`command` / `args` / `cwd`) — there is no dynamic per-tool `input_schema` to
 * resolve and validate against — so the handler needs only the injected
 * daemon-call seam, the clock seams, and the session {@link RoomScopedDeps.room}.
 *
 * The handler emits a signed `exec.start` request and faithfully surfaces the
 * receiver's verdict; it performs **no** allowlist / `deny_args_regex` / `cwd` /
 * sandbox check itself — all of that runs out-of-process on the receiving daemon
 * (design §6 layer 4, §9). A type alias (not a fresh interface) because the exec
 * seam is exactly the room-scoped seam, nothing more.
 */
export type ExecDeps = RoomScopedDeps;

/**
 * The deps for `mx_dispatch_task` (T303 / #32). Dispatch re-routes a task node's
 * authored action through `mxDelegateTool` (a `kind: 'tool'` action) or `mxRunCommand`
 * (a `kind: 'exec'` action) and resolves the node via a `task.list` read, so it needs
 * exactly the delegation seam: the injected daemon-call, the session
 * {@link RoomScopedDeps.room}, and the optional {@link DelegateDeps.validator} the tool
 * path's `mxDelegateTool` consumes (defaulted inside that handler). A type alias (not a
 * fresh interface) because the dispatch seam *is* the delegation seam.
 */
export type DispatchDeps = DelegateDeps;
