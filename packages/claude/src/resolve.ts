/**
 * Hiding the `mx_await_result` poll loop (T110 / #18) — the crux of AC1's
 * "receive the result."
 *
 * Generic MCP (T109) *surfaces* a deferred `handle` and lets the model re-call
 * `mx_await_result`; the Claude shim *hides* that loop so a single
 * `mx_delegate_tool` / `mx_run_command` call returns the **terminal** result in one
 * shot whenever the work settles within a bounded budget. This module is that
 * disposition policy — and **only** the policy: it adds no new transport semantics,
 * it drives the registry's existing {@link mxAwaitResult} resolver.
 *
 * Per the design §5 Claude flow, the policy is:
 *  - **`ok` / `denied` / `error`** (terminal) → return as-is, no poll.
 *  - **`running`** → resolve transparently: poll the daemon up to a bounded
 *    `resolveTimeoutMs` budget; return the terminal envelope if it settles, else
 *    the still-`running` envelope (no unbounded block, and **never** a fabricated
 *    `timeout` — `mxAwaitResult` guarantees a `wait_ms` expiry returns the pending
 *    envelope, not `errored('timeout')`). The model can still re-poll the handle
 *    via the registered `mx_await_result` tool.
 *  - **`awaiting_approval`** → this is the receiving daemon's *out-of-process*
 *    human approval gate. The shim does **not** silently spin on a human. Default:
 *    return the `awaiting_approval` envelope (handle + secret-free approval) so the
 *    model fans out other work and resolves later. Opt-in `awaitApproval: true`
 *    polls up to `resolveTimeoutMs` for hosts that want a single blocking call.
 *
 * The resolver only **observes** (a read RPC); it issues no approval and grants no
 * authority. Approval is decided out-of-process and re-validated against live
 * policy by the receiving daemon at release.
 */
import { mxAwaitResult } from '@mx-loom/registry';
import type { DaemonCall, HandlerDeps, ToolResult } from '@mx-loom/registry';

/** Default total budget for the hidden `running` poll loop. */
export const DEFAULT_RESOLVE_TIMEOUT_MS = 60_000;

/** Options for {@link resolveDeferred} — the disposition policy + the test seams. */
export interface ResolveOptions {
  /**
   * Total budget (ms) to transparently resolve a `running` (and, under
   * {@link awaitApproval}, an `awaiting_approval`) handle before giving up and
   * returning the still-pending envelope. Default {@link DEFAULT_RESOLVE_TIMEOUT_MS}.
   * Realised as the resolver's own bounded short-poll cadence, never one long read.
   */
  resolveTimeoutMs?: number;
  /**
   * When `true`, also block (up to {@link resolveTimeoutMs}) on an
   * `awaiting_approval` handle until the operator decides. Default `false` — the
   * shim surfaces `awaiting_approval` immediately and never blocks the turn on a
   * human.
   */
  awaitApproval?: boolean;
  /** Wait `ms` ms. Forwarded to the resolver. Default: a real, unref'd `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic-ish clock for the poll deadline. Forwarded to the resolver. Default: `Date.now`. */
  now?: () => number;
  /** Base poll interval (ms) for the loop. Forwarded to the resolver (clamped there). */
  pollIntervalMs?: number;
}

/**
 * Apply the deferred-result disposition policy to a freshly dispatched
 * {@link ToolResult}. Terminal and (by default) `awaiting_approval` results pass
 * through untouched; a `running` result is resolved to a terminal-or-still-pending
 * envelope via the hidden poll loop.
 */
export async function resolveDeferred(
  result: ToolResult,
  daemon: DaemonCall,
  options: ResolveOptions = {},
): Promise<ToolResult> {
  // `running` is always resolved transparently (the common deferred case).
  if (result.status === 'running' && result.handle !== null) {
    return pollToTerminal(result.handle, daemon, options);
  }

  // `awaiting_approval` is blocked on ONLY when the host opted in; the default is
  // to surface it immediately (don't block the turn on a human operator).
  if (
    result.status === 'awaiting_approval' &&
    result.handle !== null &&
    options.awaitApproval === true
  ) {
    return pollToTerminal(result.handle, daemon, options);
  }

  // ok / denied / error / (default) awaiting_approval / a handle-less deferred →
  // pass through unchanged.
  return result;
}

/**
 * Drive the registry's {@link mxAwaitResult} resolver over a bounded budget. A
 * `wait_ms` expiry there returns the still-pending envelope (never a fabricated
 * `timeout`), so this returns either the terminal result or the last pending one.
 */
function pollToTerminal(
  handle: string,
  daemon: DaemonCall,
  options: ResolveOptions,
): Promise<ToolResult> {
  const wait_ms = options.resolveTimeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS;
  const deps: HandlerDeps = {
    daemon,
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
  };
  return mxAwaitResult({ handle, wait_ms }, deps);
}
