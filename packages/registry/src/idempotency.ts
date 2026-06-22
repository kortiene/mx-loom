/**
 * Client-supplied idempotency (T102 / #10) — AC 3, design §4.4.
 *
 * Every **mutating** call carries a client-supplied `idempotency_key`; the daemon
 * already dedupes on `idempotency_key`/`nonce` for replay protection, so a retried
 * tool call does not double-execute. T102 supplies the **contract** — the
 * descriptor field (`mx_delegate_tool` / `mx_run_command` `input_schema`), the
 * generator below, and the documented handler plumbing. The daemon does the
 * actual replay protection.
 *
 * The key is a client-chosen **dedup nonce, not a capability**: it carries no
 * authority and is not credential-shaped (it does not match `CREDENTIAL_KEY_RE`),
 * so adding it to a descriptor passes the loader's secret-free-shape check, and
 * the daemon re-runs sig→trust→policy regardless of the key (idempotency never
 * bypasses authorize — design §5).
 *
 * **The handler contract (for T105/T106; enforced by their tests).** A mutating
 * handler:
 *  1. uses the caller-supplied `idempotency_key` if present, else calls
 *     {@link newIdempotencyKey} **once per logical invocation**;
 *  2. places it in the outbound `call.start`/`exec.start` **params** (the daemon's
 *     `idempotency_key`/`nonce` field — exact wire name confirmed at the two-daemon
 *     round-trip, T102 OQ #5);
 *  3. **never regenerates** it on a transport-level retry. Because
 *     `MxClient.withRetry` reuses `params` verbatim, a key placed in `params` is
 *     automatically stable across retries — so **no `MxClient`/`CallOptions`
 *     change is required** (T102 OQ #7: the key rides in handler-built params, not
 *     a transport option, keeping the transport method-agnostic).
 */
import { randomUUID } from 'node:crypto';

/** Prefix that marks a value as an mx-loom idempotency key (human-recognisable). */
export const IDEMPOTENCY_KEY_PREFIX = 'idk_';

/**
 * Generate a fresh idempotency key — `idk_<uuid>`, backed by `node:crypto`
 * `randomUUID()` (built-in, no new dependency). A handler calls this **once per
 * logical invocation** when the caller did not supply one, then reuses the same
 * value across every transport-level retry of that call.
 */
export function newIdempotencyKey(): string {
  return `${IDEMPOTENCY_KEY_PREFIX}${randomUUID()}`;
}
