/**
 * `mx_await_result` — the deferred-result resolver (T103 / #11) — design §4.3
 * ("the one piece of semantics a runtime cannot skip") / §5 (the invocation flow).
 *
 * Turns a deferred `handle` (`inv_…`) into a **terminal** envelope (`ok` /
 * `denied` / `error`) — or, when `wait_ms` elapses while the work is still in
 * progress, the **still-pending** envelope (`running` / `awaiting_approval`). It
 * polls the daemon `invocation.get` RPC through the injected {@link HandlerDeps}
 * seam, maps each response onto a T102 envelope via {@link invocationToResult},
 * and runs a bounded `wait_ms` poll-with-timeout loop.
 *
 * **The single most important behavior in T103 (AC 3):** a `wait_ms` *expiry* is
 * NOT an error. A successful poll that finds the invocation still pending returns
 * that pending envelope with `error: null` — **never** `errored('timeout')`. The
 * `timeout` *code* is reserved for a genuine transport/daemon fault (a probe that
 * could not complete), which is a different code path entirely (see {@link probe}).
 *
 * The resolver only **observes** state via a read RPC. It issues no approval and
 * exposes no approve/deny/mutate surface: AC 2 (`awaiting_approval` → `ok`/`denied`)
 * resolves because the operator decided out-of-process and the **daemon re-ran the
 * authorize pipeline at release** (design §5) — the resolver merely reads the
 * resulting terminal state. It opens no socket, reads no env var, and never throws
 * a transport error to the caller — every path returns a {@link ToolResult}.
 */
import type { AuditRef, ToolResult, ToolStatus } from '../envelope.js';
import type { HandlerDeps } from './deps.js';
import { faultToResult } from './handler-fault.js';
import { invocationToResult } from './invocation.js';

/**
 * The daemon read RPC + its param name. Localised here (spec Open Question #2:
 * `invocation.get` vs `invocation.show`; param `invocation_id` vs `handle` vs
 * `id`) so the two-daemon round-trip's correction is a one-line change.
 */
const INVOCATION_GET_METHOD = 'invocation.get';
const INVOCATION_ID_PARAM = 'invocation_id';

/** Poll-interval bounds for the `wait_ms` loop. The floor prevents a busy-wait;
 *  the cap stops a large `wait_ms` from hammering the daemon. */
const DEFAULT_POLL_INTERVAL_MS = 200;
const MIN_POLL_INTERVAL_MS = 10;
const MAX_POLL_INTERVAL_MS = 2_000;

/** Input of the `mx_await_result` resolver — exactly the descriptor's schema
 *  (`handle` required, `wait_ms` optional ≥ 0). No `idempotency_key`: it is a read. */
export interface AwaitResultInput {
  readonly handle: string;
  readonly wait_ms?: number;
}

/**
 * Resolve a deferred handle to a terminal-or-still-pending {@link ToolResult}.
 *
 * Algorithm: probe once → if terminal, return it → if `wait_ms` is omitted/`0`,
 * return the single pending probe → otherwise poll (bounded interval, clamped to
 * the deadline) until the first terminal state or the `wait_ms` deadline, then
 * return the last **pending** envelope (AC 3 — pending, not an error).
 */
export async function mxAwaitResult(input: AwaitResultInput, deps: HandlerDeps): Promise<ToolResult> {
  // 1. Probe once. A handle that has already completed returns its terminal
  //    envelope here, on a single read, with no sleep (AC 1).
  let current = await probe(input.handle, deps);
  if (isTerminal(current.status)) return current;

  // 2. Still pending. `wait_ms` omitted or 0 ⇒ a single non-blocking probe.
  const waitMs = normaliseWaitMs(input.wait_ms);
  if (waitMs <= 0) return current;

  // 3. `wait_ms > 0` ⇒ poll up to the deadline, returning early on a terminal
  //    state. Each underlying probe uses the client's own per-call transport
  //    timeout, INDEPENDENT of `wait_ms`: `wait_ms` is a logical resolution
  //    budget realised as many short reads, not a single stretched socket read.
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const interval = resolvePollInterval(deps.pollIntervalMs);
  const deadline = now() + waitMs;

  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    // Never overshoot the deadline; never sleep less than nothing.
    await sleep(Math.min(interval, remaining));
    current = await probe(input.handle, deps);
    if (isTerminal(current.status)) return current;
  }

  // 4. AC 3: the deadline passed with the work still in progress. Return the last
  //    PENDING envelope (`running` / `awaiting_approval`, `error: null`). A
  //    `wait_ms` expiry is a successful poll, NOT an `errored('timeout')`.
  return current;
}

/**
 * One `invocation.get` probe → a {@link ToolResult}. A transport/daemon rejection
 * is mapped onto the closed taxonomy and returned as a fault envelope — the
 * resolver never leaks a `TransportError` to the caller.
 */
async function probe(handle: string, deps: HandlerDeps): Promise<ToolResult> {
  try {
    const raw = await deps.daemon.call(INVOCATION_GET_METHOD, { [INVOCATION_ID_PARAM]: handle });
    return invocationToResult(raw);
  } catch (err) {
    // A transport/daemon rejection maps onto the closed taxonomy via the shared
    // fault path. A genuine transport `timeout` here is a **real** fault →
    // `errored('timeout', …)`, DISTINCT from a `wait_ms` expiry (which returns the
    // pending envelope from the loop and never reaches this path) — the crux of AC 3.
    return faultToResult(err, handleAuditRef(handle));
  }
}

function isTerminal(status: ToolStatus): boolean {
  return status === 'ok' || status === 'denied' || status === 'error';
}

/** A finite, positive `wait_ms` budget, else `0` (single-probe). The descriptor
 *  already constrains `wait_ms` to an integer ≥ 0; this is the defensive floor. */
function normaliseWaitMs(wait_ms: number | undefined): number {
  return typeof wait_ms === 'number' && Number.isFinite(wait_ms) && wait_ms > 0 ? wait_ms : 0;
}

function resolvePollInterval(ms: number | undefined): number {
  const v = typeof ms === 'number' && Number.isFinite(ms) ? ms : DEFAULT_POLL_INTERVAL_MS;
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, v));
}

/** A transport fault carries no daemon correlation ids beyond the handle we polled. */
function handleAuditRef(handle: string): AuditRef {
  return { invocation_id: handle, request_id: null, room: null, event_id: null };
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
