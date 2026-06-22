import { describe, expect, it } from 'vitest';

import {
  CORRELATION_PARAM_KEY,
  newCorrelationId,
  withCorrelationParam,
} from '../src/correlation.js';
import {
  assertNoCredentialShapedArgs,
  CREDENTIAL_KEY_RE,
  CREDENTIAL_VALUE_RE,
} from '../src/guards.js';

describe('CORRELATION_PARAM_KEY', () => {
  it("is 'correlation_id'", () => {
    expect(CORRELATION_PARAM_KEY).toBe('correlation_id');
  });
});

describe('newCorrelationId', () => {
  it('returns a corr_-prefixed UUID string', () => {
    const id = newCorrelationId();
    // corr_ prefix + 32 hex chars + 4 hyphens
    expect(id).toMatch(/^corr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('is non-empty', () => {
    expect(newCorrelationId().length).toBeGreaterThan(0);
  });

  it('every call returns a unique value (collision-free across many calls)', () => {
    const ids = Array.from({ length: 200 }, () => newCorrelationId());
    expect(new Set(ids).size).toBe(200);
  });

  it('is non-secret: value cannot be mistaken for a known credential prefix', () => {
    // A correlation id must not look like a credential-shaped value
    const id = newCorrelationId();
    expect(id).not.toMatch(/^(ghp_|gho_|ghs_|syt_|xoxb-|xoxp-)/);
  });
});

describe('withCorrelationParam', () => {
  const ID = 'corr_a1b2c3d4-0000-0000-0000-000000000000';

  it('undefined params → { correlation_id: id }', () => {
    expect(withCorrelationParam(undefined, ID)).toEqual({ [CORRELATION_PARAM_KEY]: ID });
  });

  it('null params → { correlation_id: id }', () => {
    expect(withCorrelationParam(null, ID)).toEqual({ [CORRELATION_PARAM_KEY]: ID });
  });

  it('plain object → shallow copy with correlation_id added', () => {
    const input = { agent_id: 'backend-01', room: '!r:srv' };
    const result = withCorrelationParam(input, ID);
    expect(result).toEqual({ agent_id: 'backend-01', room: '!r:srv', [CORRELATION_PARAM_KEY]: ID });
  });

  it('plain object shallow copy: does not mutate the original', () => {
    const input = { agent_id: 'a' };
    withCorrelationParam(input, ID);
    expect(input).not.toHaveProperty(CORRELATION_PARAM_KEY);
  });

  it('object already carrying correlation_id → returned as-is (caller-set id wins)', () => {
    const input = { [CORRELATION_PARAM_KEY]: 'existing-id', x: 1 };
    const result = withCorrelationParam(input, ID);
    expect(result).toBe(input); // same reference — not a copy
    expect((result as Record<string, unknown>)[CORRELATION_PARAM_KEY]).toBe('existing-id');
  });

  it('array params → returned untouched (stamping arrays would change semantics)', () => {
    const input = [1, 2, 3];
    expect(withCorrelationParam(input, ID)).toBe(input);
  });

  it('empty array → returned untouched', () => {
    const input: unknown[] = [];
    expect(withCorrelationParam(input, ID)).toBe(input);
  });

  it('string params → returned untouched', () => {
    expect(withCorrelationParam('hello', ID)).toBe('hello');
  });

  it('number params → returned untouched', () => {
    expect(withCorrelationParam(42, ID)).toBe(42);
  });

  it('boolean params → returned untouched', () => {
    expect(withCorrelationParam(true, ID)).toBe(true);
    expect(withCorrelationParam(false, ID)).toBe(false);
  });

  it('nested objects inside the plain object are NOT deep-copied (shallow copy)', () => {
    const nested = { deep: true };
    const input = { a: nested };
    const result = withCorrelationParam(input, ID) as { a: typeof nested; correlation_id: string };
    expect(result.a).toBe(nested); // same reference — shallow copy
    expect(result[CORRELATION_PARAM_KEY]).toBe(ID);
  });

  it('an empty object receives only the correlation_id', () => {
    expect(withCorrelationParam({}, ID)).toEqual({ [CORRELATION_PARAM_KEY]: ID });
  });
});

// ---------------------------------------------------------------------------
// Security non-regression: the injected key and value must never trigger the
// credential guard. session.call() injects { correlation_id: corr_<uuid> }
// into allowlisted method params, and MxClient.call() then runs
// assertNoCredentialShapedArgs on those params before dispatch. If either the
// key or the value matched a credential pattern the session would reject its
// own heartbeat ticks and correlated calls with 'invalid_args'.
// ---------------------------------------------------------------------------

describe('guard non-regression', () => {
  it('CORRELATION_PARAM_KEY does not match CREDENTIAL_KEY_RE', () => {
    expect(CREDENTIAL_KEY_RE.test(CORRELATION_PARAM_KEY)).toBe(false);
  });

  it('a newCorrelationId() value does not match CREDENTIAL_VALUE_RE', () => {
    const id = newCorrelationId();
    expect(CREDENTIAL_VALUE_RE.test(id)).toBe(false);
  });

  it('withCorrelationParam output (object) passes assertNoCredentialShapedArgs', () => {
    const params = withCorrelationParam({ agent_id: 'backend-01' }, 'corr_test-id-0000');
    expect(() => assertNoCredentialShapedArgs(params)).not.toThrow();
  });

  it('withCorrelationParam output (undefined → object) passes assertNoCredentialShapedArgs', () => {
    const params = withCorrelationParam(undefined, 'corr_test-id-0000');
    expect(() => assertNoCredentialShapedArgs(params)).not.toThrow();
  });

  it('50 generated ids — none trigger CREDENTIAL_VALUE_RE', () => {
    const ids = Array.from({ length: 50 }, () => newCorrelationId());
    for (const id of ids) {
      expect(CREDENTIAL_VALUE_RE.test(id)).toBe(false);
    }
  });
});
