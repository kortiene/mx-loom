/**
 * Session correlation id (T005, design §7).
 *
 * A runtime conversation maps 1:1 to an MX agent registration, and the toolbelt
 * threads one **session-stable `correlation_id`** onto every outbound call so a
 * cognitive session is reconstructable across delegations. The id is a
 * **non-secret** random UUID: safe in logs, the model context, and the (M1)
 * audit trail, and never derived from any secret. It must NOT be conflated with
 * the daemon's `idempotency_key` / `nonce` (replay protection, M1).
 *
 * Two layers, deliberately separated (see `session.ts` and design §7):
 * - **Always (M0-safe, daemon-independent):** the session stamps the id on its
 *   diagnostics seam for every call — no call it issues is un-correlated.
 * - **Gated on verification:** injecting the id into daemon *params* (so it rides
 *   into the signed Matrix events and survives across delegations) is enabled
 *   only for an allowlist of methods confirmed to accept it. Until verified the
 *   allowlist is empty, so {@link withCorrelationParam} is never invoked and no
 *   outbound params are mutated.
 */
import { randomUUID } from 'node:crypto';

/** Reserved param key the correlation id rides on when param-injection is enabled. */
export const CORRELATION_PARAM_KEY = 'correlation_id';

/** Mint a fresh, collision-free session correlation id (`corr_<uuid>`). */
export function newCorrelationId(): string {
  return `corr_${randomUUID()}`;
}

/**
 * Return `params` with the correlation id added as a reserved
 * {@link CORRELATION_PARAM_KEY} sibling — the **gated** param-injection path,
 * applied by the session only for methods on its confirmed-accepted allowlist.
 *
 * - `undefined` / `null` params become `{ correlation_id }`.
 * - A plain object gets a shallow copy with the id added, unless it already
 *   carries a `correlation_id` (a caller-set value is never overwritten).
 * - Arrays and primitives are returned untouched: stamping them would change the
 *   call's semantics, so the diagnostics-seam stamping is the only guarantee for
 *   such shapes.
 */
export function withCorrelationParam(params: unknown, correlationId: string): unknown {
  if (params === undefined || params === null) {
    return { [CORRELATION_PARAM_KEY]: correlationId };
  }
  if (typeof params === 'object' && !Array.isArray(params)) {
    const obj = params as Record<string, unknown>;
    if (CORRELATION_PARAM_KEY in obj) return params;
    return { ...obj, [CORRELATION_PARAM_KEY]: correlationId };
  }
  return params;
}
