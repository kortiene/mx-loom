import { describe, expect, it } from 'vitest';

import { TransportError } from '../src/transport.js';
import type { TransportErrorCode } from '../src/transport.js';
import { backoffDelay, DEFAULT_RETRY_POLICY, withRetry } from '../src/retry.js';
import type { RetryPolicy } from '../src/retry.js';

/** A no-op sleep so retries never wait in tests. */
const noSleep = async (): Promise<void> => {};

/** Build a policy from the default, overriding only what a test cares about. */
function policy(overrides: Partial<RetryPolicy> = {}): RetryPolicy {
  return { ...DEFAULT_RETRY_POLICY, ...overrides };
}

/** A fn that throws a scripted sequence of TransportError codes then (if exhausted) succeeds. */
function scripted(codes: TransportErrorCode[], success: unknown = 'ok') {
  let i = 0;
  const calls: number[] = [];
  const fn = async (): Promise<unknown> => {
    calls.push(++i);
    const code = codes[i - 1];
    if (code !== undefined) throw new TransportError(code, `scripted ${code} (call ${i})`);
    return success;
  };
  return { fn, callCount: () => i, calls };
}

describe('backoffDelay', () => {
  it('follows min(maxDelayMs, baseDelayMs*factor**(n-1)) with jitter disabled', () => {
    const p = policy({ baseDelayMs: 50, factor: 2, maxDelayMs: 1_000, jitter: false });
    expect(backoffDelay(p, 1)).toBe(50); // 50 * 2^0
    expect(backoffDelay(p, 2)).toBe(100); // 50 * 2^1
    expect(backoffDelay(p, 3)).toBe(200); // 50 * 2^2
    expect(backoffDelay(p, 4)).toBe(400);
  });

  it('caps at maxDelayMs', () => {
    const p = policy({ baseDelayMs: 50, factor: 2, maxDelayMs: 1_000, jitter: false });
    expect(backoffDelay(p, 10)).toBe(1_000); // 50 * 2^9 = 25600 → capped
  });

  it('full jitter bounds the delay to [0, computed] using the injected RNG', () => {
    const p = policy({ baseDelayMs: 100, factor: 2, maxDelayMs: 1_000, jitter: true });
    // computed for attempt 2 = 200; jitter multiplies by random()
    expect(backoffDelay(p, 2, () => 0)).toBe(0);
    expect(backoffDelay(p, 2, () => 0.5)).toBe(100);
    expect(backoffDelay(p, 2, () => 1)).toBe(200);
  });
});

describe('withRetry', () => {
  it('retries a retryable code up to maxAttempts, then surfaces the last error', async () => {
    const { fn, callCount } = scripted(['connect_failed', 'connect_failed', 'connect_failed']);
    const err = await withRetry(fn, policy({ maxAttempts: 3, jitter: false, baseDelayMs: 0 }), {
      sleep: noSleep,
    }).catch((e: unknown) => e);
    expect(callCount()).toBe(3);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).code).toBe('connect_failed');
  });

  it('succeeds once a retryable code clears before maxAttempts', async () => {
    const { fn, callCount } = scripted(['connect_failed'], { ok: true });
    const result = await withRetry(fn, policy({ maxAttempts: 3, jitter: false }), { sleep: noSleep });
    expect(result).toEqual({ ok: true });
    expect(callCount()).toBe(2); // one failure + one success
  });

  it.each(['timeout', 'rpc', 'closed', 'protocol', 'frame', 'not_running', 'invalid_args'] as const)(
    'does NOT retry %s (default policy) — exactly one attempt',
    async (code) => {
      const { fn, callCount } = scripted([code]);
      const err = await withRetry(fn, DEFAULT_RETRY_POLICY, { sleep: noSleep }).catch((e: unknown) => e);
      expect(callCount()).toBe(1);
      expect((err as TransportError).code).toBe(code);
    },
  );

  it('treats a non-TransportError as non-retryable and rethrows immediately', async () => {
    let calls = 0;
    const fn = async (): Promise<unknown> => {
      calls++;
      throw new Error('boom');
    };
    await expect(withRetry(fn, DEFAULT_RETRY_POLICY, { sleep: noSleep })).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });

  it('invokes onRetry once per retry (not on the terminal failure) with code + attempt', async () => {
    const { fn } = scripted(['connect_failed', 'connect_failed', 'connect_failed']);
    const seen: Array<[TransportErrorCode, number]> = [];
    await withRetry(fn, policy({ maxAttempts: 3, jitter: false, baseDelayMs: 0 }), {
      sleep: noSleep,
      onRetry: (code, attempt) => seen.push([code, attempt]),
    }).catch(() => undefined);
    // 3 attempts → 2 retries (after attempt 1 and attempt 2); attempt 3 is terminal.
    expect(seen).toEqual([
      ['connect_failed', 1],
      ['connect_failed', 2],
    ]);
  });

  it('waits the jittered backoff via the injected sleep', async () => {
    const { fn } = scripted(['connect_failed', 'connect_failed', 'connect_failed']);
    const waited: number[] = [];
    await withRetry(fn, policy({ maxAttempts: 3, baseDelayMs: 50, factor: 2, jitter: false }), {
      sleep: async (ms) => {
        waited.push(ms);
      },
    }).catch(() => undefined);
    expect(waited).toEqual([50, 100]); // backoff before attempts 2 and 3
  });

  it('the default policy retries only connect_failed', () => {
    expect(DEFAULT_RETRY_POLICY.retryableCodes).toEqual(['connect_failed']);
  });

  it('maxAttempts: 1 → executes exactly once, no retry even for retryable codes', async () => {
    const { fn, callCount } = scripted(['connect_failed']);
    const err = await withRetry(fn, policy({ maxAttempts: 1, jitter: false, baseDelayMs: 0 }), {
      sleep: noSleep,
    }).catch((e: unknown) => e);
    expect(callCount()).toBe(1);
    expect((err as TransportError).code).toBe('connect_failed');
  });

  it('sleep is not called when the first attempt succeeds', async () => {
    const slept: number[] = [];
    const { fn } = scripted([], 'ok');
    const result = await withRetry(fn, policy({ maxAttempts: 3 }), {
      sleep: async (ms) => { slept.push(ms); },
    });
    expect(result).toBe('ok');
    expect(slept).toHaveLength(0);
  });

  it('onRetry is not called when the first attempt succeeds', async () => {
    const seen: number[] = [];
    const { fn } = scripted([], 'success');
    await withRetry(fn, DEFAULT_RETRY_POLICY, {
      sleep: noSleep,
      onRetry: (_code, attempt) => seen.push(attempt),
    });
    expect(seen).toHaveLength(0);
  });

  it('retryableCodes: [] treats every code as non-retryable — single attempt even for connect_failed', async () => {
    const { fn, callCount } = scripted(['connect_failed']);
    const err = await withRetry(fn, policy({ maxAttempts: 3, retryableCodes: [] }), {
      sleep: noSleep,
    }).catch((e: unknown) => e);
    expect(callCount()).toBe(1);
    expect((err as TransportError).code).toBe('connect_failed');
  });

  it('widened retryableCodes retries additional codes the caller explicitly opts into', async () => {
    const { fn, callCount } = scripted(['timeout', 'timeout'], 'recovered');
    const result = await withRetry(
      fn,
      policy({ maxAttempts: 3, retryableCodes: ['connect_failed', 'timeout'], jitter: false, baseDelayMs: 0 }),
      { sleep: noSleep },
    );
    expect(result).toBe('recovered');
    expect(callCount()).toBe(3); // timeout × 2 then success
  });
});
