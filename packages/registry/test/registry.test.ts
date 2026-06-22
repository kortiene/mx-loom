import { describe, expect, it } from 'vitest';

import {
  CANONICAL_M1_TOOLS,
  DescriptorValidationError,
  loadRegistry,
  type CompiledSchema,
  type JsonSchema,
  type SchemaValidator,
  type ToolDescriptor,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// DescriptorValidationError
// ---------------------------------------------------------------------------

describe('DescriptorValidationError', () => {
  it('sets .name to "DescriptorValidationError"', () => {
    const err = new DescriptorValidationError('mx_x', 'something');
    expect(err.name).toBe('DescriptorValidationError');
  });

  it('sets .descriptor to the offending descriptor name', () => {
    const err = new DescriptorValidationError('mx_bad', 'test reason');
    expect(err.descriptor).toBe('mx_bad');
  });

  it('sets .reason to the reason string', () => {
    const err = new DescriptorValidationError('mx_x', 'name regex failed');
    expect(err.reason).toBe('name regex failed');
  });

  it('formats .message including descriptor name and reason', () => {
    const err = new DescriptorValidationError('mx_x', 'name regex failed');
    expect(err.message).toContain('mx_x');
    expect(err.message).toContain('name regex failed');
  });

  it('is an instance of Error', () => {
    const err = new DescriptorValidationError('mx_x', 'r');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DescriptorValidationError);
  });
});

// ---------------------------------------------------------------------------
// loadRegistry — structural validation
// ---------------------------------------------------------------------------

describe('loadRegistry — structural validation', () => {
  const good = CANONICAL_M1_TOOLS[0]!;

  it('accepts an empty descriptor array and returns a valid empty registry', () => {
    const registry = loadRegistry([]);
    expect(registry.list()).toEqual([]);
    expect(registry.has('mx_find_agents')).toBe(false);
    expect(registry.get('mx_find_agents')).toBeUndefined();
    expect([...registry]).toEqual([]);
  });

  it('accepts a single custom descriptor', () => {
    const custom: ToolDescriptor = {
      name: 'mx_custom_tool',
      description: 'A custom tool for testing.',
      async_semantics: 'sync',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
    };
    const registry = loadRegistry([custom]);
    expect(registry.list()).toHaveLength(1);
    expect(registry.has('mx_custom_tool')).toBe(true);
    expect(registry.get('mx_custom_tool')?.description).toBe('A custom tool for testing.');
  });

  it('rejects a descriptor whose name is not a string', () => {
    expect(() =>
      loadRegistry([{ ...good, name: 42 as unknown as string }]),
    ).toThrow(DescriptorValidationError);
  });

  it('rejects a descriptor whose name is an empty string', () => {
    expect(() =>
      loadRegistry([{ ...good, name: '' }]),
    ).toThrow(DescriptorValidationError);
  });

  it('rejects a whitespace-only description', () => {
    expect(() =>
      loadRegistry([{ ...good, description: '   \t\n' }]),
    ).toThrow(DescriptorValidationError);
  });

  it('rejects a descriptor with input_schema that is an array (not a plain object)', () => {
    expect(() =>
      loadRegistry([{ ...good, input_schema: [] as unknown as JsonSchema }]),
    ).toThrow(DescriptorValidationError);
  });

  it('rejects a descriptor with input_schema that is null', () => {
    expect(() =>
      loadRegistry([{ ...good, input_schema: null as unknown as JsonSchema }]),
    ).toThrow(DescriptorValidationError);
  });

  it('rejects a descriptor with input_schema that is a string', () => {
    expect(() =>
      loadRegistry([{ ...good, input_schema: 'schema' as unknown as JsonSchema }]),
    ).toThrow(DescriptorValidationError);
  });

  it('rejects a descriptor with output_schema that is not a plain object', () => {
    expect(() =>
      loadRegistry([{ ...good, output_schema: null as unknown as JsonSchema }]),
    ).toThrow(DescriptorValidationError);
  });

  it('rejects a duplicate name — error message mentions "duplicate"', () => {
    expect(() => loadRegistry([good, good])).toThrow(/duplicate/);
  });

  it('DescriptorValidationError.descriptor names the offending descriptor on rejection', () => {
    try {
      loadRegistry([{ ...good, description: '' }]);
      expect.fail('expected to throw');
    } catch (err) {
      expect((err as DescriptorValidationError).descriptor).toBe(good.name);
    }
  });
});

// ---------------------------------------------------------------------------
// loadRegistry — JSON Schema validity (AC 1) via injectable SchemaValidator
// ---------------------------------------------------------------------------

describe('loadRegistry — SchemaValidator seam', () => {
  const good = CANONICAL_M1_TOOLS[0]!;

  it('accepts a custom SchemaValidator that compiles every schema without error', () => {
    const permissiveValidator: SchemaValidator = {
      compile(_schema: JsonSchema): CompiledSchema {
        const fn = (_data: unknown): boolean => true;
        return fn as CompiledSchema;
      },
    };
    // A descriptor with an otherwise-invalid JSON Schema passes when the validator accepts it
    const desc: ToolDescriptor = {
      name: 'mx_permissive_test',
      description: 'Test with permissive validator.',
      async_semantics: 'sync',
      input_schema: { arbitraryKey: 'not a real schema keyword' },
      output_schema: { type: 'object' },
    };
    // Default Ajv would reject arbitrary keys; permissive validator accepts everything
    expect(() => loadRegistry([desc], permissiveValidator)).not.toThrow();
  });

  it('rejects when a custom SchemaValidator throws on compile', () => {
    const strictlyRejectingValidator: SchemaValidator = {
      compile(_schema: JsonSchema): CompiledSchema {
        throw new Error('schema rejected by custom validator');
      },
    };
    expect(() => loadRegistry([good], strictlyRejectingValidator)).toThrow(DescriptorValidationError);
  });

  it('DescriptorValidationError reason mentions the field name when schema compile fails', () => {
    const rejectValidator: SchemaValidator = {
      compile(_schema: JsonSchema): CompiledSchema {
        throw new Error('invalid schema');
      },
    };
    try {
      loadRegistry([good], rejectValidator);
      expect.fail('expected to throw');
    } catch (err) {
      const dve = err as DescriptorValidationError;
      // reason should mention which field (input_schema) triggered the error
      expect(dve.reason).toMatch(/input_schema|output_schema/);
    }
  });

  it('error reason specifically names "output_schema" when only the output schema is invalid', () => {
    let callCount = 0;
    const selectiveRejectValidator: SchemaValidator = {
      compile(_schema: JsonSchema): CompiledSchema {
        callCount++;
        // First call is for input_schema — accept it; second is for output_schema — reject it.
        if (callCount >= 2) throw new Error('output_schema is bad');
        return ((_data: unknown) => true) as CompiledSchema;
      },
    };
    try {
      loadRegistry([good], selectiveRejectValidator);
      expect.fail('expected to throw');
    } catch (err) {
      const dve = err as DescriptorValidationError;
      expect(dve.reason).toContain('output_schema');
      expect(dve.descriptor).toBe(good.name);
    }
  });
});

// ---------------------------------------------------------------------------
// loadRegistry — secret-free check (credential-shaped input_schema properties)
// ---------------------------------------------------------------------------

describe('loadRegistry — secret-free input shape check', () => {
  const good = CANONICAL_M1_TOOLS[0]!;

  it('rejects a descriptor with a top-level credential-shaped property name in input_schema', () => {
    const bad: ToolDescriptor = {
      ...good,
      name: 'mx_bad_secret',
      input_schema: {
        type: 'object',
        properties: {
          api_key: { type: 'string' },
        },
      },
    };
    expect(() => loadRegistry([bad])).toThrow(DescriptorValidationError);
    try {
      loadRegistry([bad]);
    } catch (err) {
      expect((err as DescriptorValidationError).reason).toContain('api_key');
    }
  });

  it('rejects a descriptor with a credential-shaped property nested inside allOf', () => {
    const bad: ToolDescriptor = {
      ...good,
      name: 'mx_bad_nested',
      input_schema: {
        type: 'object',
        allOf: [
          {
            properties: {
              matrix_token: { type: 'string' },
            },
          },
        ],
      },
    };
    expect(() => loadRegistry([bad])).toThrow(DescriptorValidationError);
    try {
      loadRegistry([bad]);
    } catch (err) {
      expect((err as DescriptorValidationError).reason).toContain('matrix_token');
    }
  });

  it('rejects a descriptor with a credential-shaped property in $defs', () => {
    const bad: ToolDescriptor = {
      ...good,
      name: 'mx_bad_defs',
      input_schema: {
        type: 'object',
        $defs: {
          Creds: {
            properties: {
              gh_token: { type: 'string' },
            },
          },
        },
      },
    };
    expect(() => loadRegistry([bad])).toThrow(DescriptorValidationError);
  });
});

// ---------------------------------------------------------------------------
// ToolRegistry interface — API completeness
// ---------------------------------------------------------------------------

describe('ToolRegistry API', () => {
  it('list() returns descriptors in insertion (authoring) order', () => {
    const a: ToolDescriptor = { name: 'mx_a', description: 'd', async_semantics: 'sync', input_schema: { type: 'object' }, output_schema: { type: 'object' } };
    const b: ToolDescriptor = { name: 'mx_b', description: 'd', async_semantics: 'deferred', input_schema: { type: 'object' }, output_schema: { type: 'object' } };
    const registry = loadRegistry([a, b]);
    expect(registry.list().map((d) => d.name)).toEqual(['mx_a', 'mx_b']);
  });

  it('for…of iteration yields the same descriptors as list()', () => {
    const registry = loadRegistry(CANONICAL_M1_TOOLS);
    expect([...registry]).toEqual([...registry.list()]);
  });

  it('get() is case-sensitive', () => {
    const registry = loadRegistry(CANONICAL_M1_TOOLS);
    // 'mx_Find_Agents' does not exist — only lowercase 'mx_find_agents' does
    expect(registry.get('mx_Find_Agents')).toBeUndefined();
    expect(registry.get('MX_FIND_AGENTS')).toBeUndefined();
    expect(registry.get('mx_find_agents')).toBeDefined();
  });

  it('has() returns false for a name that was not registered', () => {
    const registry = loadRegistry(CANONICAL_M1_TOOLS);
    expect(registry.has('mx_nonexistent')).toBe(false);
    expect(registry.has('')).toBe(false);
  });

  it('the registry object itself is frozen', () => {
    const registry = loadRegistry(CANONICAL_M1_TOOLS);
    expect(Object.isFrozen(registry)).toBe(true);
  });

  it('list() return value is frozen', () => {
    const registry = loadRegistry(CANONICAL_M1_TOOLS);
    expect(Object.isFrozen(registry.list())).toBe(true);
  });

  it('descriptors returned from get() are frozen', () => {
    const registry = loadRegistry(CANONICAL_M1_TOOLS);
    for (const d of registry) {
      expect(Object.isFrozen(registry.get(d.name))).toBe(true);
    }
  });

  it('list() is stable across multiple calls (same references)', () => {
    const registry = loadRegistry(CANONICAL_M1_TOOLS);
    const first = registry.list();
    const second = registry.list();
    expect(first).toBe(second);
  });
});
