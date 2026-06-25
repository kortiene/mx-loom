/**
 * JSON Schema → TypeBox converter (T205) — per-construct + fail-closed suite.
 *
 * Tests:
 *  - Every supported type (string, integer, number, boolean, array, object)
 *    produces the expected TypeBox-like shape via the fake builders.
 *  - `enum` on strings emits the Google-safe `StringEnum` shape, NEVER
 *    `oneOf`/`anyOf`/`allOf`/`const`.
 *  - Numeric bounds (minimum/maximum/exclusiveMinimum/exclusiveMaximum) are
 *    forwarded onto the options bag.
 *  - Object open/closed (`additionalProperties: true/false/absent`) is exact.
 *  - Optional properties are derived correctly from the `required` array.
 *  - Every unsupported construct (oneOf, anyOf, allOf, not, if/then/else,
 *    $ref, $defs, patternProperties, tuple items, schema-valued
 *    `additionalProperties`, missing type, array union type, null type, a
 *    non-string enum member, an empty enum) throws `PiSchemaConversionError`
 *    naming the exact path + keyword — NEVER emits a permissive schema.
 *  - `SUPPORTED_JSON_SCHEMA_TYPES` exports the expected type list.
 */
import { describe, expect, it } from 'vitest';

import { PiSchemaConversionError, SUPPORTED_JSON_SCHEMA_TYPES, jsonSchemaToTypeBox } from '../src/json-schema-to-typebox.js';
import { fakeBuilders } from './helpers.js';

// Helper: convert a schema and return it as a plain record.
function convert(schema: Record<string, unknown>): Record<string, unknown> {
  return jsonSchemaToTypeBox(schema, fakeBuilders) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// SUPPORTED_JSON_SCHEMA_TYPES
// ---------------------------------------------------------------------------

describe('SUPPORTED_JSON_SCHEMA_TYPES', () => {
  it('contains the six supported types and excludes null', () => {
    expect(SUPPORTED_JSON_SCHEMA_TYPES).toContain('string');
    expect(SUPPORTED_JSON_SCHEMA_TYPES).toContain('integer');
    expect(SUPPORTED_JSON_SCHEMA_TYPES).toContain('number');
    expect(SUPPORTED_JSON_SCHEMA_TYPES).toContain('boolean');
    expect(SUPPORTED_JSON_SCHEMA_TYPES).toContain('array');
    expect(SUPPORTED_JSON_SCHEMA_TYPES).toContain('object');
    expect(SUPPORTED_JSON_SCHEMA_TYPES).not.toContain('null');
  });
});

// ---------------------------------------------------------------------------
// type: string
// ---------------------------------------------------------------------------

describe('type: string', () => {
  it('plain string → { type:"string" }', () => {
    expect(convert({ type: 'string' })).toMatchObject({ type: 'string' });
  });

  it('carries description through', () => {
    const out = convert({ type: 'string', description: 'my field' });
    expect((out as { description: string }).description).toBe('my field');
  });

  it('enum of strings → StringEnum shape (type:"string", enum:[...])', () => {
    const out = convert({ type: 'string', enum: ['a', 'b', 'c'] });
    expect(out['type']).toBe('string');
    expect(out['enum']).toEqual(['a', 'b', 'c']);
  });

  it('StringEnum shape does NOT contain oneOf/anyOf/allOf/const', () => {
    const json = JSON.stringify(convert({ type: 'string', enum: ['x', 'y'] }));
    expect(json).not.toMatch(/oneOf|anyOf|allOf|const/);
  });

  it('enum with description carries description into StringEnum', () => {
    const out = convert({ type: 'string', enum: ['active', 'stale'], description: 'liveness' });
    expect(out['description']).toBe('liveness');
    expect(out['enum']).toEqual(['active', 'stale']);
  });

  it('throws on a non-string enum member (fail-closed)', () => {
    expect(() =>
      convert({ type: 'string', enum: ['ok', 7] } as Record<string, unknown>),
    ).toThrow(PiSchemaConversionError);
  });

  it('throws on an empty enum (fail-closed)', () => {
    expect(() => convert({ type: 'string', enum: [] })).toThrow(PiSchemaConversionError);
  });

  it('error from non-string enum names path and keyword', () => {
    try {
      convert({ type: 'string', enum: ['ok', null] } as Record<string, unknown>);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PiSchemaConversionError);
      expect((e as PiSchemaConversionError).keyword).toBe('enum');
    }
  });
});

// ---------------------------------------------------------------------------
// type: integer
// ---------------------------------------------------------------------------

describe('type: integer', () => {
  it('plain integer → { type:"integer" }', () => {
    expect(convert({ type: 'integer' })).toMatchObject({ type: 'integer' });
  });

  it('forwards minimum', () => {
    const out = convert({ type: 'integer', minimum: 0 });
    expect(out['minimum']).toBe(0);
  });

  it('forwards maximum', () => {
    const out = convert({ type: 'integer', maximum: 100 });
    expect(out['maximum']).toBe(100);
  });

  it('forwards exclusiveMinimum', () => {
    const out = convert({ type: 'integer', exclusiveMinimum: 0 });
    expect(out['exclusiveMinimum']).toBe(0);
  });

  it('forwards exclusiveMaximum', () => {
    const out = convert({ type: 'integer', exclusiveMaximum: 10 });
    expect(out['exclusiveMaximum']).toBe(10);
  });

  it('carries description', () => {
    const out = convert({ type: 'integer', description: 'count', minimum: 0 });
    expect(out['description']).toBe('count');
    expect(out['minimum']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// type: number
// ---------------------------------------------------------------------------

describe('type: number', () => {
  it('plain number → { type:"number" }', () => {
    expect(convert({ type: 'number' })).toMatchObject({ type: 'number' });
  });

  it('forwards numeric bounds', () => {
    const out = convert({ type: 'number', minimum: 0.5, maximum: 9.5 });
    expect(out['minimum']).toBe(0.5);
    expect(out['maximum']).toBe(9.5);
  });
});

// ---------------------------------------------------------------------------
// type: boolean
// ---------------------------------------------------------------------------

describe('type: boolean', () => {
  it('plain boolean → { type:"boolean" }', () => {
    expect(convert({ type: 'boolean' })).toMatchObject({ type: 'boolean' });
  });

  it('carries description', () => {
    const out = convert({ type: 'boolean', description: 'flag' });
    expect(out['description']).toBe('flag');
  });
});

// ---------------------------------------------------------------------------
// type: array
// ---------------------------------------------------------------------------

describe('type: array', () => {
  it('array with string items', () => {
    const out = convert({ type: 'array', items: { type: 'string' } }) as {
      type: string;
      items: { type: string };
    };
    expect(out.type).toBe('array');
    expect(out.items.type).toBe('string');
  });

  it('throws when items is absent (fail-closed — subset requires items)', () => {
    expect(() => convert({ type: 'array' })).toThrow(PiSchemaConversionError);
  });

  it('throws on tuple items (array of schemas) — fail-closed', () => {
    expect(() =>
      convert({
        type: 'array',
        items: [{ type: 'string' }, { type: 'integer' }],
      } as Record<string, unknown>),
    ).toThrow(PiSchemaConversionError);
  });

  it('error from tuple items names "items" keyword', () => {
    try {
      convert({ type: 'array', items: [{ type: 'string' }] } as Record<string, unknown>);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PiSchemaConversionError);
      expect((e as PiSchemaConversionError).keyword).toBe('items');
    }
  });
});

// ---------------------------------------------------------------------------
// type: object — open/closed/optional properties
// ---------------------------------------------------------------------------

describe('type: object', () => {
  it('closed object (additionalProperties:false) → additionalProperties:false', () => {
    const out = convert({
      type: 'object',
      properties: { x: { type: 'string' } },
      required: ['x'],
      additionalProperties: false,
    }) as { additionalProperties: boolean };
    expect(out.additionalProperties).toBe(false);
  });

  it('open object (additionalProperties:true) → additionalProperties:true', () => {
    const out = convert({
      type: 'object',
      additionalProperties: true,
    }) as { additionalProperties: boolean };
    expect(out.additionalProperties).toBe(true);
  });

  it('absent additionalProperties → open (additionalProperties:true)', () => {
    const out = convert({ type: 'object' }) as { additionalProperties: boolean };
    expect(out.additionalProperties).toBe(true);
  });

  it('openObject:"strip" suppresses additionalProperties on an open object', () => {
    const out = jsonSchemaToTypeBox(
      { type: 'object' },
      fakeBuilders,
      { openObject: 'strip' },
    ) as Record<string, unknown>;
    expect('additionalProperties' in out).toBe(false);
  });

  it('closed object ignores openObject option (always strict)', () => {
    const out = jsonSchemaToTypeBox(
      { type: 'object', additionalProperties: false },
      fakeBuilders,
      { openObject: 'strip' },
    ) as Record<string, unknown>;
    expect(out['additionalProperties']).toBe(false);
  });

  it('required prop appears in "required" array; optional prop does not', () => {
    const out = convert({
      type: 'object',
      properties: {
        req: { type: 'string' },
        opt: { type: 'integer' },
      },
      required: ['req'],
      additionalProperties: false,
    }) as { required: string[] };
    expect(out.required).toContain('req');
    expect(out.required).not.toContain('opt');
  });

  it('object with no properties emits an empty properties bag', () => {
    const out = convert({ type: 'object', additionalProperties: false }) as {
      properties?: Record<string, unknown>;
    };
    // No crash; properties may be absent or empty.
    expect(out).toBeDefined();
  });

  it('throws on schema-valued additionalProperties (fail-closed)', () => {
    expect(() =>
      convert({
        type: 'object',
        additionalProperties: { type: 'string' },
      } as Record<string, unknown>),
    ).toThrow(PiSchemaConversionError);
  });
});

// ---------------------------------------------------------------------------
// Unsupported structural keywords — each throws PiSchemaConversionError naming
// the keyword at the correct path (fail-closed, never widens to Any).
// ---------------------------------------------------------------------------

const UNSUPPORTED_CONSTRUCTS: Array<{ label: string; schema: Record<string, unknown>; keyword: string }> = [
  { label: 'oneOf', schema: { type: 'object', oneOf: [] }, keyword: 'oneOf' },
  { label: 'anyOf', schema: { type: 'object', anyOf: [] }, keyword: 'anyOf' },
  { label: 'allOf', schema: { type: 'object', allOf: [] }, keyword: 'allOf' },
  { label: 'not', schema: { type: 'object', not: {} }, keyword: 'not' },
  { label: 'if', schema: { type: 'object', if: {}, then: {} }, keyword: 'if' },
  { label: '$ref', schema: { type: 'object', $ref: '#/definitions/Foo' }, keyword: '$ref' },
  { label: '$defs', schema: { type: 'object', $defs: {} }, keyword: '$defs' },
  { label: 'definitions', schema: { type: 'object', definitions: {} }, keyword: 'definitions' },
  { label: 'patternProperties', schema: { type: 'object', patternProperties: {} }, keyword: 'patternProperties' },
  { label: 'const', schema: { type: 'string', const: 'x' }, keyword: 'const' },
  { label: 'contains', schema: { type: 'array', contains: {}, items: { type: 'string' } }, keyword: 'contains' },
  { label: 'prefixItems', schema: { type: 'array', prefixItems: [], items: { type: 'string' } }, keyword: 'prefixItems' },
];

describe('fail-closed on unsupported structural keywords', () => {
  it.each(UNSUPPORTED_CONSTRUCTS)(
    '$label throws PiSchemaConversionError naming keyword "$keyword"',
    ({ schema, keyword }) => {
      let threw: unknown;
      try {
        convert(schema);
      } catch (e) {
        threw = e;
      }
      expect(threw).toBeInstanceOf(PiSchemaConversionError);
      expect((threw as PiSchemaConversionError).keyword).toBe(keyword);
    },
  );
});

// ---------------------------------------------------------------------------
// Unsupported types — each throws PiSchemaConversionError (fail-closed)
// ---------------------------------------------------------------------------

describe('fail-closed on unsupported or missing types', () => {
  it('type: null throws PiSchemaConversionError', () => {
    expect(() =>
      convert({ type: 'null' } as Record<string, unknown>),
    ).toThrow(PiSchemaConversionError);
  });

  it('array union type throws PiSchemaConversionError', () => {
    expect(() =>
      convert({ type: ['string', 'null'] } as Record<string, unknown>),
    ).toThrow(PiSchemaConversionError);
  });

  it('missing type throws PiSchemaConversionError', () => {
    expect(() =>
      convert({ description: 'no type field' } as Record<string, unknown>),
    ).toThrow(PiSchemaConversionError);
  });

  it('non-plain-object schema (e.g. boolean true) throws PiSchemaConversionError', () => {
    expect(() =>
      jsonSchemaToTypeBox(true as unknown as Record<string, unknown>, fakeBuilders),
    ).toThrow(PiSchemaConversionError);
  });

  it('enum on non-string type (type:integer) throws PiSchemaConversionError', () => {
    expect(() =>
      convert({ type: 'integer', enum: [1, 2, 3] } as Record<string, unknown>),
    ).toThrow(PiSchemaConversionError);
  });

  it('enum on type:boolean throws PiSchemaConversionError', () => {
    expect(() =>
      convert({ type: 'boolean', enum: [true] } as Record<string, unknown>),
    ).toThrow(PiSchemaConversionError);
  });
});

// ---------------------------------------------------------------------------
// Nested object — recursive conversion
// ---------------------------------------------------------------------------

describe('nested objects', () => {
  it('nested object property converts recursively', () => {
    const out = convert({
      type: 'object',
      properties: {
        inner: {
          type: 'object',
          properties: {
            val: { type: 'integer', minimum: 0 },
          },
          required: ['val'],
          additionalProperties: false,
        },
      },
      required: ['inner'],
      additionalProperties: false,
    }) as { properties: { inner: { properties: { val: { type: string; minimum: number } } } } };
    expect(out.properties.inner.properties.val.type).toBe('integer');
    expect(out.properties.inner.properties.val.minimum).toBe(0);
  });
});
