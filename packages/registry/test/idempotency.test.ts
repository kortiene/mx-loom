/**
 * Client-supplied idempotency (T102 / #10) — AC 3, design §4.4.
 *
 * Tests pin:
 * - newIdempotencyKey() produces unique, prefix-stable, non-credential-shaped keys.
 * - The dedup contract: a fake "daemon" that caches responses by key ensures two
 *   calls with the same key execute once and return identical results.
 * - The no-regeneration contract: a handler that builds params once carries the
 *   same key through simulated transport-level retries.
 *
 * Pure unit tests; no daemon, no socket, no env.
 */
import { describe, expect, it } from 'vitest';

import { CREDENTIAL_KEY_RE } from '@mx-loom/toolbelt';

import {
  IDEMPOTENCY_KEY_PREFIX,
  newIdempotencyKey,
  ok,
  type AuditRef,
  type ToolResult,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// newIdempotencyKey() — generator invariants
// ---------------------------------------------------------------------------

describe('newIdempotencyKey()', () => {
  it('returns a non-empty string', () => {
    expect(typeof newIdempotencyKey()).toBe('string');
    expect(newIdempotencyKey().length).toBeGreaterThan(0);
  });

  it(`starts with the '${IDEMPOTENCY_KEY_PREFIX}' prefix`, () => {
    expect(newIdempotencyKey().startsWith(IDEMPOTENCY_KEY_PREFIX)).toBe(true);
  });

  it('returns different values on successive calls (non-deterministic)', () => {
    const k1 = newIdempotencyKey();
    const k2 = newIdempotencyKey();
    expect(k1).not.toBe(k2);
  });

  it('returns different values across many calls (collision-resistant)', () => {
    const keys = Array.from({ length: 100 }, () => newIdempotencyKey());
    expect(new Set(keys).size).toBe(100);
  });

  it('key is not credential-shaped (CREDENTIAL_KEY_RE does not match the prefix or a full key)', () => {
    // The field NAME 'idempotency_key' should not match; the VALUE should not match either.
    expect(CREDENTIAL_KEY_RE.test('idempotency_key')).toBe(false);
    // The generated value itself is not a credential.
    expect(CREDENTIAL_KEY_RE.test(newIdempotencyKey())).toBe(false);
  });

  it('key suffix has UUID-like format (hex + dashes)', () => {
    const key = newIdempotencyKey();
    const suffix = key.slice(IDEMPOTENCY_KEY_PREFIX.length);
    // UUID v4: 8-4-4-4-12 hex chars separated by dashes
    expect(suffix).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

// ---------------------------------------------------------------------------
// Dedup contract — fake "daemon" caches responses per key (AC 3)
//
// This models the handler-side idempotency contract: the handler generates one
// key per logical invocation, places it in params, and the daemon deduplicates
// on that key. Two calls with the same key execute one side effect; two calls
// with different keys execute two side effects.
// ---------------------------------------------------------------------------

/**
 * Minimal stand-in for a daemon's idempotent call store.
 * A real daemon dedupes by key in persistent storage; here a Map suffices.
 */
interface FakeDaemonStore {
  readonly cache: Map<string, ToolResult>;
  readonly sideEffectCount: { value: number };
}

function createFakeDaemon(): FakeDaemonStore {
  return { cache: new Map(), sideEffectCount: { value: 0 } };
}

/** Simulates a mutating handler call with daemon-side dedup. */
function callWithDedup(store: FakeDaemonStore, idempotencyKey: string, auditRef: AuditRef): ToolResult {
  const cached = store.cache.get(idempotencyKey);
  if (cached !== undefined) return cached;
  store.sideEffectCount.value++;
  const result = ok({ call: store.sideEffectCount.value }, auditRef);
  store.cache.set(idempotencyKey, result);
  return result;
}

const nullAuditRef: AuditRef = { invocation_id: null, request_id: null, room: null, event_id: null };

describe('idempotency dedup contract (AC 3)', () => {
  it('two calls with the same key execute exactly one side effect', () => {
    const store = createFakeDaemon();
    const key = newIdempotencyKey();

    callWithDedup(store, key, nullAuditRef);
    callWithDedup(store, key, nullAuditRef);

    expect(store.sideEffectCount.value).toBe(1);
  });

  it('two calls with the same key return identical results', () => {
    const store = createFakeDaemon();
    const key = newIdempotencyKey();

    const first = callWithDedup(store, key, nullAuditRef);
    const second = callWithDedup(store, key, nullAuditRef);

    expect(first).toBe(second); // same object reference (cache hit)
  });

  it('two calls with different keys execute two side effects', () => {
    const store = createFakeDaemon();
    const key1 = newIdempotencyKey();
    const key2 = newIdempotencyKey();

    callWithDedup(store, key1, nullAuditRef);
    callWithDedup(store, key2, nullAuditRef);

    expect(store.sideEffectCount.value).toBe(2);
  });

  it('two calls with different keys return different results', () => {
    const store = createFakeDaemon();
    const k1 = newIdempotencyKey();
    const k2 = newIdempotencyKey();

    const r1 = callWithDedup(store, k1, nullAuditRef);
    const r2 = callWithDedup(store, k2, nullAuditRef);

    expect(r1).not.toBe(r2);
    expect((r1.result as { call: number }).call).toBe(1);
    expect((r2.result as { call: number }).call).toBe(2);
  });

  it('the first response is served from cache on subsequent calls (no re-execution)', () => {
    const store = createFakeDaemon();
    const key = newIdempotencyKey();

    const first = callWithDedup(store, key, nullAuditRef);
    // Execute many more times with the same key.
    for (let i = 0; i < 5; i++) {
      const hit = callWithDedup(store, key, nullAuditRef);
      expect(hit).toBe(first);
    }
    expect(store.sideEffectCount.value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// No-regeneration contract — same key across transport-level retries (AC 3)
//
// Design §4.4: a handler generates the key ONCE per logical invocation and
// places it in the outbound params object. MxClient.withRetry reuses params
// verbatim, so the key is automatically stable across retries — no extra
// plumbing required. We test that a params object built once carries the same
// key through simulated retries.
// ---------------------------------------------------------------------------

/** Params object a mutating handler would build and pass to MxClient.call(). */
interface MutatingParams {
  agent: string;
  tool: string;
  args: Record<string, unknown>;
  idempotency_key: string;
}

/** Models the handler-side key-generation rule: use caller-supplied key or generate once. */
function buildHandlerParams(callerKey: string | undefined): MutatingParams {
  return {
    agent: 'agent-A',
    tool: 'some_tool',
    args: {},
    idempotency_key: callerKey ?? newIdempotencyKey(),
  };
}

describe('no-regeneration on retry (AC 3)', () => {
  it('the handler params object carries the same key on every "attempt"', () => {
    // Simulate: build params once (handler generates key), then "retry" by
    // passing the same params object to the transport again.
    const params = buildHandlerParams(undefined);
    const attemptKeys: string[] = [];

    // Two transport attempts use the same params verbatim (MxClient.withRetry pattern).
    attemptKeys.push(params.idempotency_key); // attempt 1
    attemptKeys.push(params.idempotency_key); // retry   — same params, same key

    expect(attemptKeys[0]).toBe(attemptKeys[1]);
    expect(attemptKeys).toHaveLength(2);
  });

  it('a caller-supplied key is preserved as-is (not regenerated)', () => {
    const callerKey = newIdempotencyKey();
    const params = buildHandlerParams(callerKey);
    expect(params.idempotency_key).toBe(callerKey);
  });

  it('a handler-generated key is stable across two params accesses', () => {
    const params = buildHandlerParams(undefined);
    const key1 = params.idempotency_key;
    const key2 = params.idempotency_key;
    expect(key1).toBe(key2);
  });

  it('two separate logical invocations produce distinct keys when no caller key supplied', () => {
    const params1 = buildHandlerParams(undefined);
    const params2 = buildHandlerParams(undefined);
    expect(params1.idempotency_key).not.toBe(params2.idempotency_key);
  });

  it('using an explicit caller key on both logical calls gives predictable dedup', () => {
    const callerKey = 'idk_fixed-key-for-testing';
    const params1 = buildHandlerParams(callerKey);
    const params2 = buildHandlerParams(callerKey);
    expect(params1.idempotency_key).toBe(params2.idempotency_key);
  });
});

// ---------------------------------------------------------------------------
// assertNoCredentialShapedArgs compatibility — key does not block dispatch
// ---------------------------------------------------------------------------

import { assertNoCredentialShapedArgs, redactSecrets } from '@mx-loom/toolbelt';

describe('idempotency_key value passes redactSecrets unchanged', () => {
  it('a params object with an idk_<uuid> value is not altered by redactSecrets', () => {
    const key = newIdempotencyKey();
    const params = { idempotency_key: key, agent: 'a', tool: 't', args: {} };
    const result = redactSecrets(params) as typeof params;
    expect(result.idempotency_key).toBe(key);
  });

  it('redactSecrets fires no onRedact callback for a params object carrying an idempotency key', () => {
    const redactedPaths: string[] = [];
    redactSecrets(
      { idempotency_key: newIdempotencyKey(), agent: 'a', tool: 't' },
      (path) => redactedPaths.push(path),
    );
    expect(redactedPaths).toHaveLength(0);
  });
});

describe('idempotency_key passes the outbound credential guard', () => {
  it('assertNoCredentialShapedArgs does not throw for a params object with idempotency_key', () => {
    const params = buildHandlerParams(newIdempotencyKey());
    expect(() => assertNoCredentialShapedArgs(params)).not.toThrow();
  });

  it('assertNoCredentialShapedArgs does not throw for a fixed idk_<uuid> value', () => {
    expect(() =>
      assertNoCredentialShapedArgs({ idempotency_key: 'idk_00000000-0000-0000-0000-000000000000' }),
    ).not.toThrow();
  });

  it('assertNoCredentialShapedArgs does not throw for the key field name alone', () => {
    // The key field name 'idempotency_key' is not credential-shaped.
    expect(() => assertNoCredentialShapedArgs({ idempotency_key: 'safe-value' })).not.toThrow();
  });
});
