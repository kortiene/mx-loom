import { describe, expect, it } from 'vitest';

import {
  deepFreeze,
  defineDescriptor,
  TOOL_NAME_RE,
  type AsyncSemantics,
  type ToolDescriptor,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// TOOL_NAME_RE — the mx_* namespace rule
// ---------------------------------------------------------------------------

describe('TOOL_NAME_RE', () => {
  it.each([
    'mx_find_agents',
    'mx_delegate_tool',
    'mx_a',
    'mx_a1',
    'mx_run_command',
    'mx_await_result',
    'mx_share_context',
    'mx_get_context',
    'mx_x1_y2_z3',
  ])('accepts valid name: %s', (name) => {
    expect(TOOL_NAME_RE.test(name)).toBe(true);
  });

  it.each([
    ['find_agents', 'no mx_ prefix'],
    ['mx_', 'empty tail after prefix'],
    ['mxFindAgents', 'camelCase, no underscore segment'],
    ['mx__x', 'double underscore separator'],
    ['mx_X', 'uppercase letter'],
    ['mx_find-agents', 'hyphen separator'],
    ['mx_find agents', 'space in name'],
    ['', 'empty string'],
    ['_mx_find', 'leading underscore before mx_'],
    ['MX_FIND', 'fully uppercase'],
    ['mx_1abc', 'segment starting with digit is actually valid per regex'],
    // confirm digit-leading segment: mx_1abc is valid because [a-z0-9]+ allows it
  ] as const)('rejects %s (%s)', (name, _reason) => {
    // 'mx_1abc' → segment [a-z0-9]+ allows digit-first; everything else should fail
    if (name === 'mx_1abc') {
      expect(TOOL_NAME_RE.test(name)).toBe(true); // digit-leading segment is allowed
    } else {
      expect(TOOL_NAME_RE.test(name)).toBe(false);
    }
  });

  // Additional rejection cases not covered above
  it.each([
    'find_agents',
    'mx_',
    'mxFindAgents',
    'mx__x',
    'mx_X',
  ])('rejects explicitly invalid: %s', (name) => {
    expect(TOOL_NAME_RE.test(name)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// defineDescriptor — authoring a frozen descriptor
// ---------------------------------------------------------------------------

describe('defineDescriptor', () => {
  const minimal = (): ToolDescriptor => ({
    name: 'mx_test_tool',
    description: 'A test descriptor.',
    async_semantics: 'sync',
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
  });

  it('returns the descriptor unchanged', () => {
    const d = defineDescriptor(minimal());
    expect(d.name).toBe('mx_test_tool');
    expect(d.description).toBe('A test descriptor.');
    expect(d.async_semantics).toBe('sync');
  });

  it('freezes the top-level descriptor object', () => {
    const d = defineDescriptor(minimal());
    expect(Object.isFrozen(d)).toBe(true);
  });

  it('deep-freezes nested input_schema', () => {
    const d = defineDescriptor({
      ...minimal(),
      input_schema: { type: 'object', properties: { foo: { type: 'string' } } },
    });
    expect(Object.isFrozen(d.input_schema)).toBe(true);
    const props = d.input_schema.properties as Record<string, unknown>;
    expect(Object.isFrozen(props)).toBe(true);
    expect(Object.isFrozen(props.foo)).toBe(true);
  });

  it('deep-freezes nested output_schema', () => {
    const d = defineDescriptor({
      ...minimal(),
      output_schema: { type: 'object', properties: { bar: { type: 'integer' } } },
    });
    expect(Object.isFrozen(d.output_schema)).toBe(true);
    expect(Object.isFrozen((d.output_schema.properties as Record<string, unknown>).bar)).toBe(true);
  });

  it('mutation attempt on frozen descriptor leaves value unchanged', () => {
    const d = defineDescriptor(minimal());
    try {
      (d as unknown as Record<string, unknown>).name = 'mx_mutated';
    } catch {
      // Strict-mode environments throw; non-strict silently ignore. Either is fine.
    }
    expect(d.name).toBe('mx_test_tool');
  });

  it('round-trips async_semantics: sync', () => {
    const d = defineDescriptor({ ...minimal(), async_semantics: 'sync' });
    expect(d.async_semantics).toBe('sync' satisfies AsyncSemantics);
  });

  it('round-trips async_semantics: deferred', () => {
    const d = defineDescriptor({ ...minimal(), async_semantics: 'deferred' });
    expect(d.async_semantics).toBe('deferred' satisfies AsyncSemantics);
  });
});

// ---------------------------------------------------------------------------
// deepFreeze — the immutability utility
// ---------------------------------------------------------------------------

describe('deepFreeze', () => {
  it('freezes a flat object', () => {
    const obj = { a: 1, b: 'x' };
    deepFreeze(obj);
    expect(Object.isFrozen(obj)).toBe(true);
  });

  it('freezes nested objects recursively', () => {
    const obj = { outer: { inner: { value: 42 } } };
    deepFreeze(obj);
    expect(Object.isFrozen(obj)).toBe(true);
    expect(Object.isFrozen(obj.outer)).toBe(true);
    expect(Object.isFrozen(obj.outer.inner)).toBe(true);
  });

  it('freezes arrays and their element objects', () => {
    const arr = [{ x: 1 }, { y: 2 }];
    deepFreeze(arr);
    expect(Object.isFrozen(arr)).toBe(true);
    expect(Object.isFrozen(arr[0])).toBe(true);
    expect(Object.isFrozen(arr[1])).toBe(true);
  });

  it('returns the same reference it was passed', () => {
    const obj = { a: 1 };
    const result = deepFreeze(obj);
    expect(result).toBe(obj);
  });

  it('is idempotent — calling twice does not throw', () => {
    const obj = { a: 1 };
    deepFreeze(obj);
    expect(() => deepFreeze(obj)).not.toThrow();
    expect(Object.isFrozen(obj)).toBe(true);
  });

  it('is a no-op on primitives (null, string, number)', () => {
    expect(() => deepFreeze(null)).not.toThrow();
    expect(() => deepFreeze('string')).not.toThrow();
    expect(() => deepFreeze(42)).not.toThrow();
  });

  it('returns primitives unchanged', () => {
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze('hello')).toBe('hello');
    expect(deepFreeze(99)).toBe(99);
  });
});
