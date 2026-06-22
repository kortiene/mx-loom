/**
 * Direct unit tests for the JSON Schema validator seam (T101 Risks #1).
 *
 * These tests cover:
 *  - JSON_SCHEMA_DIALECT pin (draft-07 URI — Risk #3)
 *  - createAjvValidator() / compile() happy path
 *  - The compiled validate function returning true/false + setting .errors
 *  - Schema invalidity throws (the AC-1 meta-schema check via Ajv)
 *  - Independence between compiled schemas (no Ajv instance bleed)
 *
 * All pure unit tests — no daemon, no socket, no env.
 */
import { describe, expect, it } from 'vitest';

import {
  createAjvValidator,
  JSON_SCHEMA_DIALECT,
  type CompiledSchema,
  type SchemaValidator,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// JSON_SCHEMA_DIALECT — pinned to draft-07
// ---------------------------------------------------------------------------

describe('JSON_SCHEMA_DIALECT', () => {
  it('is the draft-07 meta-schema URI (Risk #3 decision)', () => {
    expect(JSON_SCHEMA_DIALECT).toBe('http://json-schema.org/draft-07/schema#');
  });

  it('is a non-empty string', () => {
    expect(typeof JSON_SCHEMA_DIALECT).toBe('string');
    expect(JSON_SCHEMA_DIALECT.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// createAjvValidator — SchemaValidator seam, Ajv-backed
// ---------------------------------------------------------------------------

describe('createAjvValidator', () => {
  it('returns an object satisfying the SchemaValidator interface', () => {
    const validator: SchemaValidator = createAjvValidator();
    expect(typeof validator.compile).toBe('function');
  });

  it('compile() returns a callable CompiledSchema for a minimal valid schema', () => {
    const validator = createAjvValidator();
    const compiled = validator.compile({ type: 'object' });
    expect(typeof compiled).toBe('function');
  });

  it('compile() returns a callable CompiledSchema for an empty schema ({})', () => {
    const validator = createAjvValidator();
    // {} is a valid JSON Schema that accepts everything
    const compiled = validator.compile({});
    expect(typeof compiled).toBe('function');
  });

  it('compile() throws for a schema with an illegal type value (AC-1 meta-schema check)', () => {
    const validator = createAjvValidator();
    expect(() => validator.compile({ type: 'not-a-valid-type' })).toThrow();
  });

  it('compile() throws for a schema with multiple invalid type values', () => {
    const validator = createAjvValidator();
    // JSON Schema does not allow arbitrary strings in type
    expect(() => validator.compile({ type: ['invalid-type-a', 'invalid-type-b'] })).toThrow();
  });

  it('compile() accepts all standard JSON Schema primitive types', () => {
    const validator = createAjvValidator();
    for (const type of ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']) {
      expect(() => validator.compile({ type }), `type: ${type}`).not.toThrow();
    }
  });

  it('compile() accepts an array of valid JSON Schema types', () => {
    const validator = createAjvValidator();
    expect(() => validator.compile({ type: ['string', 'null'] })).not.toThrow();
  });

  it('multiple calls to createAjvValidator() produce independent validators', () => {
    const v1 = createAjvValidator();
    const v2 = createAjvValidator();
    // Compiling on one validator should not affect the other
    expect(() => v1.compile({ type: 'object' })).not.toThrow();
    expect(() => v2.compile({ type: 'object' })).not.toThrow();
  });

  it('compile() called twice on the same validator instance with distinct schemas is independent', () => {
    const validator = createAjvValidator();
    const c1 = validator.compile({ type: 'string' });
    const c2 = validator.compile({ type: 'integer' });
    // Schemas are independent — validate against their own schema
    expect(c1('hello')).toBe(true);
    expect(c2(42)).toBe(true);
    expect(c1(42)).toBe(false);   // integer fails string schema
    expect(c2('hello')).toBe(false); // string fails integer schema
  });
});

// ---------------------------------------------------------------------------
// CompiledSchema — the validate function returned by compile()
// ---------------------------------------------------------------------------

describe('CompiledSchema — validate function behaviour', () => {
  it('returns true for data that satisfies the schema', () => {
    const validator = createAjvValidator();
    const compiled: CompiledSchema = validator.compile({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
    expect(compiled({ name: 'alice' })).toBe(true);
  });

  it('returns false for data that violates the schema', () => {
    const validator = createAjvValidator();
    const compiled: CompiledSchema = validator.compile({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
    expect(compiled({})).toBe(false); // missing required field
    expect(compiled({ name: 42 })).toBe(false); // wrong type
  });

  it('sets .errors to a non-null value after a failed validation', () => {
    const validator = createAjvValidator();
    const compiled: CompiledSchema = validator.compile({
      type: 'object',
      required: ['agent_id'],
    });
    compiled({}); // fail
    expect(compiled.errors).toBeDefined();
    expect(compiled.errors).not.toBeNull();
  });

  it('.errors is cleared / updated on a subsequent successful validation', () => {
    const validator = createAjvValidator();
    const compiled: CompiledSchema = validator.compile({ type: 'string' });
    compiled(42); // fail — .errors is set
    expect(compiled.errors).toBeDefined();
    compiled('hello'); // succeed
    // After a successful call, errors should be undefined/null (not the previous failure)
    expect(compiled.errors == null).toBe(true);
  });

  it('validates complex schemas with required + properties + additionalProperties', () => {
    const validator = createAjvValidator();
    const compiled = validator.compile({
      type: 'object',
      properties: {
        agent: { type: 'string' },
        tool: { type: 'string' },
        args: { type: 'object', additionalProperties: true },
      },
      required: ['agent', 'tool', 'args'],
      additionalProperties: false,
    });
    expect(compiled({ agent: 'a', tool: 't', args: {} })).toBe(true);
    expect(compiled({ agent: 'a', tool: 't' })).toBe(false); // missing args
    expect(compiled({ agent: 'a', tool: 't', args: {}, extra: 1 })).toBe(false); // additional property
  });

  it('validates an enum schema', () => {
    const validator = createAjvValidator();
    const compiled = validator.compile({
      type: 'string',
      enum: ['file', 'diff', 'env'],
    });
    expect(compiled('file')).toBe(true);
    expect(compiled('diff')).toBe(true);
    expect(compiled('other')).toBe(false);
  });

  it('validates an array schema with items type constraint', () => {
    const validator = createAjvValidator();
    const compiled = validator.compile({
      type: 'array',
      items: { type: 'string' },
    });
    expect(compiled(['a', 'b', 'c'])).toBe(true);
    expect(compiled(['a', 42])).toBe(false); // mixed types
    expect(compiled([])).toBe(true); // empty array is valid
  });

  it('validates a schema with minimum constraint', () => {
    const validator = createAjvValidator();
    const compiled = validator.compile({ type: 'integer', minimum: 0 });
    expect(compiled(0)).toBe(true);
    expect(compiled(100)).toBe(true);
    expect(compiled(-1)).toBe(false);
  });

  it('validates a schema with allOf', () => {
    const validator = createAjvValidator();
    const compiled = validator.compile({
      allOf: [
        { type: 'object', required: ['a'] },
        { type: 'object', required: ['b'] },
      ],
    });
    expect(compiled({ a: 1, b: 2 })).toBe(true);
    expect(compiled({ a: 1 })).toBe(false); // missing b
  });
});

// ---------------------------------------------------------------------------
// compile() — AC-1 meta-schema check via Ajv (rejects malformed schemas)
// ---------------------------------------------------------------------------

describe('createAjvValidator — AC-1 meta-schema rejection', () => {
  it('rejects a schema where type has an illegal string value', () => {
    const validator = createAjvValidator();
    expect(() => validator.compile({ type: 'not-a-type' })).toThrow();
  });

  it('rejects a schema where type is a number (not a string)', () => {
    const validator = createAjvValidator();
    expect(() => validator.compile({ type: 42 as never })).toThrow();
  });

  it('accepts a $schema keyword pointing to the draft-07 URI without throwing', () => {
    const validator = createAjvValidator();
    // $schema as a URI reference is ignored or accepted by Ajv strict:false
    expect(() =>
      validator.compile({
        $schema: JSON_SCHEMA_DIALECT,
        type: 'object',
      }),
    ).not.toThrow();
  });
});
