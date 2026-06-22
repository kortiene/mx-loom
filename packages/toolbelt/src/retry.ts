/**
 * Bounded retry/backoff policy for the unified client (T004).
 *
 * **Safety first.** Retrying a call that *might already have executed* is a
 * correctness bug, and since `idempotency_key` is not plumbed until M1
 * (T102/T105) the unified client cannot tell a read from a mutation. So the
 * default policy retries **only `connect_failed`** — a transport-present-but-
 * unusable fault raised during connection setup, *before* a request is
 * dispatched. It deliberately does **not** retry `timeout` (request was sent;
 * the daemon may be executing it), `closed`, `rpc`, `protocol`, or `frame`.
 *
 * `not_running` is intentionally **not** retryable here: at the unified-client
 * layer it is the failover trigger (IPC→CLI), not a wait-and-retry condition.
 *
 * Pure and side-effect-free except for the injected `sleep`. The timer and RNG
 * are injected (defaulting to real `setTimeout` / `Math.random`) so tests are
 * deterministic without real waits.
 */
import { TransportError } from './transport.js';
import type { TransportErrorCode } from './transport.js';

export interface RetryPolicy {
  /** Total attempts including the first. Default: 3. */
  maxAttempts: number;
  /** Base backoff in ms. Default: 50. */
  baseDelayMs: number;
  /** Backoff cap in ms. Default: 1_000. */
  maxDelayMs: number;
  /** Exponential factor. Default: 2. */
  factor: number;
  /** Apply full jitter to each delay. Default: true. */
  jitter: boolean;
  /**
   * Codes eligible for retry. Default: `['connect_failed']` — the only code
   * that is BOTH transient AND provably pre-dispatch. Callers that plumb an
   * `idempotency_key` later (M1) may widen this knowingly.
   */
  retryableCodes: readonly TransportErrorCode[];
}

/**
 * The conservative default: retry `connect_failed` only, 3 attempts, 50ms base
 * with exponential backoff capped at 1s and full jitter.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 50,
  maxDelayMs: 1_000,
  factor: 2,
  jitter: true,
  retryableCodes: ['connect_failed'],
};

/** Injected dependencies — defaulted to real timer/RNG; overridden in tests. */
export interface RetryDeps {
  /** Wait `ms` milliseconds. Default: a real, unref'd `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Source of jitter in `[0, 1)`. Default: `Math.random`. */
  random?: () => number;
  /** Redaction-safe notification before each retry (code + attempt only). */
  onRetry?: (code: TransportErrorCode, attempt: number) => void;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Backoff delay (ms) applied after a failed 1-based `attempt`:
 * `min(maxDelayMs, baseDelayMs * factor**(attempt-1))`, then full jitter
 * (`× random()` → `[0, computed]`) when `policy.jitter` is true.
 */
export function backoffDelay(policy: RetryPolicy, attempt: number, random: () => number = Math.random): number {
  const exp = policy.baseDelayMs * policy.factor ** (attempt - 1);
  const capped = Math.min(policy.maxDelayMs, exp);
  return policy.jitter ? capped * random() : capped;
}

/**
 * Run `fn`, retrying only failures whose `TransportError.code` is in
 * `policy.retryableCodes`, up to `policy.maxAttempts`. A non-retryable code (or
 * a non-`TransportError`) is thrown immediately — important so a terminal
 * `not_running` surfaces straight away for the selector to fail over on. After
 * the final attempt the last error is surfaced unchanged.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  deps: RetryDeps = {},
): Promise<T> {
  const sleep = deps.sleep ?? realSleep;
  const random = deps.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = err instanceof TransportError ? err.code : undefined;
      const retryable = code !== undefined && policy.retryableCodes.includes(code);
      if (!retryable || attempt >= policy.maxAttempts) throw err;
      deps.onRetry?.(code, attempt);
      await sleep(backoffDelay(policy, attempt, random));
    }
  }
}
