import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import {
  jsonSchemaToZod,
  jsonSchemaToZodRawShape,
  JsonSchemaConversionError,
  SUPPORTED_JSON_SCHEMA_TYPES,
} from '../src/index.js';

/** Convenience: does the converted schema accept this value? */
const accepts = (schema: Record<string, unknown>, value: unknown): boolean =>
  jsonSchemaToZod(schema).safeParse(value).success;

describe('jsonSchemaToZod — per-construct conversion', () => {
  describe('string', () => {
    it('converts type:string to z.string()', () => {
      const schema = { type: 'string' };
      expect(accepts(schema, 'hi')).toBe(true);
      expect(accepts(schema, 5)).toBe(false);
      expect(accepts(schema, null)).toBe(false);
    });

    it('converts string+enum to z.enum (accepts members, rejects non-members)', () => {
      const schema = { type: 'string', enum: ['active', 'stale', 'offline'] };
      expect(accepts(schema, 'active')).toBe(true);
      expect(accepts(schema, 'offline')).toBe(true);
      expect(accepts(schema, 'gone')).toBe(false);
      expect(accepts(schema, 5)).toBe(false);
    });

    it('throws on a non-string enum member (never widens)', () => {
      expect(() => jsonSchemaToZod({ type: 'string', enum: ['a', 2] })).toThrow(
        JsonSchemaConversionError,
      );
    });

    it('throws on an empty enum', () => {
      expect(() => jsonSchemaToZod({ type: 'string', enum: [] })).toThrow(
        JsonSchemaConversionError,
      );
    });
  });

  describe('integer', () => {
    it('rejects non-integers and floats, accepts integers', () => {
      const schema = { type: 'integer' };
      expect(accepts(schema, 0)).toBe(true);
      expect(accepts(schema, 42)).toBe(true);
      expect(accepts(schema, -7)).toBe(true);
      expect(accepts(schema, 5.5)).toBe(false);
      expect(accepts(schema, '5')).toBe(false);
    });

    it('honors minimum:0 (rejects -1, accepts 0)', () => {
      const schema = { type: 'integer', minimum: 0 };
      expect(accepts(schema, 0)).toBe(true);
      expect(accepts(schema, 1)).toBe(true);
      expect(accepts(schema, -1)).toBe(false);
    });

    it('honors maximum and exclusive bounds', () => {
      expect(accepts({ type: 'integer', maximum: 10 }, 10)).toBe(true);
      expect(accepts({ type: 'integer', maximum: 10 }, 11)).toBe(false);
      expect(accepts({ type: 'integer', exclusiveMinimum: 0 }, 0)).toBe(false);
      expect(accepts({ type: 'integer', exclusiveMinimum: 0 }, 1)).toBe(true);
      expect(accepts({ type: 'integer', exclusiveMaximum: 5 }, 5)).toBe(false);
      expect(accepts({ type: 'integer', exclusiveMaximum: 5 }, 4)).toBe(true);
    });
  });

  describe('array', () => {
    it('items:{string} accepts ["a"], rejects [1] and non-arrays', () => {
      const schema = { type: 'array', items: { type: 'string' } };
      expect(accepts(schema, ['a'])).toBe(true);
      expect(accepts(schema, [])).toBe(true);
      expect(accepts(schema, [1])).toBe(false);
      expect(accepts(schema, 'a')).toBe(false);
    });

    it('items absent → z.array(z.unknown()) (any element, still rejects non-array)', () => {
      const schema = { type: 'array' };
      expect(accepts(schema, [1, 'a', {}])).toBe(true);
      expect(accepts(schema, 'nope')).toBe(false);
    });
  });

  describe('object — additionalProperties ↔ strictness (the fidelity rule)', () => {
    it('closed object (additionalProperties:false) REJECTS an unknown extra key', () => {
      const schema = {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
        additionalProperties: false,
      };
      expect(accepts(schema, { a: 'x' })).toBe(true);
      expect(accepts(schema, { a: 'x', b: 'extra' })).toBe(false);
    });

    it('open object (additionalProperties:true, with properties) PASSES unknown keys', () => {
      const schema = {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
        additionalProperties: true,
      };
      expect(accepts(schema, { a: 'x', b: 'extra' })).toBe(true);
    });

    it('additionalProperties ABSENT (with properties) passes unknown keys (JSON default true)', () => {
      const schema = {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
      };
      expect(accepts(schema, { a: 'x', b: 'extra' })).toBe(true);
    });

    it('open object (no properties) accepts arbitrary object content, REJECTS non-objects', () => {
      const schema = { type: 'object', additionalProperties: true };
      expect(accepts(schema, {})).toBe(true);
      expect(accepts(schema, { anything: { nested: [1, 2] } })).toBe(true);
      expect(accepts(schema, 'string')).toBe(false);
      expect(accepts(schema, [1])).toBe(false);
      expect(accepts(schema, 5)).toBe(false);
      expect(accepts(schema, null)).toBe(false);
    });

    it('open object via openObject:passthrough also rejects non-objects', () => {
      const schema = { type: 'object', additionalProperties: true };
      const zType = jsonSchemaToZod(schema, { openObject: 'passthrough' });
      expect(zType.safeParse({ x: 1 }).success).toBe(true);
      expect(zType.safeParse('string').success).toBe(false);
      expect(zType.safeParse([1]).success).toBe(false);
    });

    it('closed EMPTY object (additionalProperties:false, no properties) accepts only {}', () => {
      const schema = { type: 'object', additionalProperties: false };
      expect(accepts(schema, {})).toBe(true);
      expect(accepts(schema, { x: 1 })).toBe(false);
      expect(accepts(schema, 'string')).toBe(false);
    });
  });

  describe('required vs optional', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    };

    it('an optional field parses when omitted', () => {
      expect(accepts(schema, { a: 'x' })).toBe(true);
    });

    it('a required field missing → reject', () => {
      expect(accepts(schema, { b: 'y' })).toBe(false);
    });
  });

  describe('description propagation', () => {
    it('propagates description to .describe() (visible via z.toJSONSchema)', () => {
      const zType = jsonSchemaToZod({ type: 'string', description: 'a label' });
      expect(z.toJSONSchema(zType).description).toBe('a label');
    });

    it('propagates nested property descriptions', () => {
      const zType = jsonSchemaToZod({
        type: 'object',
        properties: { a: { type: 'string', description: 'field a' } },
        required: ['a'],
        additionalProperties: false,
      });
      const json = z.toJSONSchema(zType) as { properties?: Record<string, { description?: string }> };
      expect(json.properties?.a?.description).toBe('field a');
    });
  });

  describe('margin constructs (output-schema coverage; not in any input schema)', () => {
    it('boolean converts', () => {
      const schema = { type: 'boolean' };
      expect(accepts(schema, true)).toBe(true);
      expect(accepts(schema, false)).toBe(true);
      expect(accepts(schema, 'true')).toBe(false);
    });

    it('number converts (and accepts floats, unlike integer)', () => {
      const schema = { type: 'number' };
      expect(accepts(schema, 5.5)).toBe(true);
      expect(accepts(schema, 5)).toBe(true);
      expect(accepts(schema, '5')).toBe(false);
    });

    it('nested object with its own properties converts and stays strict-faithful', () => {
      const schema = {
        type: 'object',
        properties: {
          inner: {
            type: 'object',
            properties: { x: { type: 'integer' } },
            required: ['x'],
            additionalProperties: false,
          },
        },
        required: ['inner'],
        additionalProperties: false,
      };
      expect(accepts(schema, { inner: { x: 1 } })).toBe(true);
      expect(accepts(schema, { inner: { x: 1, y: 2 } })).toBe(false); // inner strict
      expect(accepts(schema, { inner: { x: 1 }, z: 3 })).toBe(false); // outer strict
    });
  });
});

describe('jsonSchemaToZod — fail-closed on unsupported constructs', () => {
  const cases: Array<{ name: string; schema: Record<string, unknown>; keyword: string }> = [
    { name: 'oneOf', schema: { oneOf: [{ type: 'string' }] }, keyword: 'oneOf' },
    { name: 'anyOf', schema: { anyOf: [{ type: 'string' }] }, keyword: 'anyOf' },
    { name: 'allOf', schema: { allOf: [{ type: 'string' }] }, keyword: 'allOf' },
    { name: 'not', schema: { not: { type: 'string' } }, keyword: 'not' },
    { name: '$ref', schema: { $ref: '#/$defs/X' }, keyword: '$ref' },
    { name: '$defs', schema: { type: 'object', $defs: {} }, keyword: '$defs' },
    {
      name: 'if (in if/then combo)',
      schema: { type: 'object', if: { type: 'object' }, then: { type: 'object' } },
      keyword: 'if',
    },
    // `then` and `else` are each independently unsupported — test them in isolation
    // so that removing either from UNSUPPORTED_KEYWORDS would be caught.
    {
      name: 'then (standalone)',
      schema: { type: 'object', then: { type: 'object' } },
      keyword: 'then',
    },
    {
      name: 'else (standalone)',
      schema: { type: 'object', else: { type: 'object' } },
      keyword: 'else',
    },
    {
      name: 'patternProperties',
      schema: { type: 'object', patternProperties: { '^x': { type: 'string' } } },
      keyword: 'patternProperties',
    },
    {
      name: 'definitions (old $defs alias)',
      schema: { type: 'object', definitions: { Foo: { type: 'string' } } },
      keyword: 'definitions',
    },
    {
      name: 'dependentSchemas',
      schema: { type: 'object', dependentSchemas: { a: { type: 'object' } } },
      keyword: 'dependentSchemas',
    },
    {
      name: 'dependentRequired',
      schema: { type: 'object', dependentRequired: { a: ['b'] } },
      keyword: 'dependentRequired',
    },
    {
      name: 'dependencies (draft-07 predecessor of dependentSchemas/Required)',
      schema: { type: 'object', dependencies: { a: ['b'] } },
      keyword: 'dependencies',
    },
    {
      name: 'propertyNames',
      schema: { type: 'object', propertyNames: { type: 'string' } },
      keyword: 'propertyNames',
    },
    { name: 'const', schema: { type: 'string', const: 'fixed' }, keyword: 'const' },
    {
      name: 'contains',
      schema: { type: 'array', contains: { type: 'string' } },
      keyword: 'contains',
    },
    {
      name: 'prefixItems (draft-2020-12 tuple syntax)',
      schema: { type: 'array', prefixItems: [{ type: 'string' }] },
      keyword: 'prefixItems',
    },
    {
      name: 'tuple items',
      schema: { type: 'array', items: [{ type: 'string' }, { type: 'integer' }] },
      keyword: 'items',
    },
    {
      name: "type:['string','null'] union",
      schema: { type: ['string', 'null'] },
      keyword: 'type',
    },
    { name: 'type:null', schema: { type: 'null' }, keyword: 'type:null' },
    { name: 'missing type', schema: { description: 'no type here' }, keyword: 'type' },
    { name: 'unknown type', schema: { type: 'bogus' }, keyword: 'type:bogus' },
    {
      name: 'schema-valued additionalProperties',
      schema: {
        type: 'object',
        properties: { a: { type: 'string' } },
        additionalProperties: { type: 'string' },
      },
      keyword: 'additionalProperties',
    },
    {
      name: 'enum on non-string type',
      schema: { type: 'integer', enum: [1, 2] },
      keyword: 'enum',
    },
  ];

  for (const { name, schema, keyword } of cases) {
    it(`throws (not widens) on ${name}`, () => {
      let thrown: unknown;
      try {
        jsonSchemaToZod(schema);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(JsonSchemaConversionError);
      expect((thrown as JsonSchemaConversionError).keyword).toBe(keyword);
      expect((thrown as JsonSchemaConversionError).path).toBeTypeOf('string');
    });
  }

  it('reports the JSON-path of a nested offending node (object property)', () => {
    const schema = {
      type: 'object',
      properties: { bad: { oneOf: [{ type: 'string' }] } },
      additionalProperties: false,
    };
    try {
      jsonSchemaToZod(schema);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(JsonSchemaConversionError);
      expect((err as JsonSchemaConversionError).path).toBe('#/properties/bad');
      expect((err as JsonSchemaConversionError).keyword).toBe('oneOf');
    }
  });

  it('reports the JSON-path of a deeply nested offending node (array items)', () => {
    const schema = {
      type: 'object',
      properties: {
        arr: { type: 'array', items: { anyOf: [{ type: 'string' }] } },
      },
      additionalProperties: false,
    };
    try {
      jsonSchemaToZod(schema);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(JsonSchemaConversionError);
      expect((err as JsonSchemaConversionError).path).toBe('#/properties/arr/items');
      expect((err as JsonSchemaConversionError).keyword).toBe('anyOf');
    }
  });

  it('throws when a schema node is not a plain object (e.g. a string node)', () => {
    try {
      // Passing a non-object at the root is caught early
      jsonSchemaToZod('not an object' as unknown as Record<string, unknown>);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(JsonSchemaConversionError);
      expect((err as JsonSchemaConversionError).keyword).toBe('schema');
    }
  });
});

describe('jsonSchemaToZodRawShape', () => {
  const schema = {
    type: 'object',
    properties: {
      a: { type: 'string' },
      b: { type: 'integer', minimum: 0 },
    },
    required: ['a'],
    additionalProperties: false,
  };

  it('returns the properties-map form (keys = JSON Schema properties)', () => {
    const shape = jsonSchemaToZodRawShape(schema);
    expect(Object.keys(shape).sort()).toEqual(['a', 'b']);
  });

  it('marks non-required fields optional and keeps required fields required', () => {
    const shape = jsonSchemaToZodRawShape(schema);
    // Wrap the shape the way tool() does (non-strict z.object) and probe.
    const obj = z.object(shape);
    expect(obj.safeParse({ a: 'x' }).success).toBe(true); // b optional
    expect(obj.safeParse({ b: 1 }).success).toBe(false); // a required
  });

  it('throws on a non-object root', () => {
    expect(() => jsonSchemaToZodRawShape({ type: 'string' })).toThrow(
      JsonSchemaConversionError,
    );
  });

  it('throws on an unsupported root construct', () => {
    expect(() =>
      jsonSchemaToZodRawShape({ type: 'object', oneOf: [{ type: 'object' }] }),
    ).toThrow(JsonSchemaConversionError);
  });

  it('returns {} for an object with no properties', () => {
    const shape = jsonSchemaToZodRawShape({ type: 'object' });
    expect(Object.keys(shape)).toHaveLength(0);
  });

  it('passes openObject option through to nested conversion (open-args pattern)', () => {
    // An inner open object with the passthrough option should use z.looseObject({}).
    const outer = {
      type: 'object',
      properties: { args: { type: 'object', additionalProperties: true } },
      required: ['args'],
      additionalProperties: false,
    };
    const shape = jsonSchemaToZodRawShape(outer, { openObject: 'passthrough' });
    const obj = z.object(shape);
    // args: looseObject({}) accepts an arbitrary object
    expect(obj.safeParse({ args: { x: 1, nested: {} } }).success).toBe(true);
    // args: looseObject({}) rejects a non-object
    expect(obj.safeParse({ args: 'not-an-object' }).success).toBe(false);
  });
});

describe('tolerated annotations ($schema, title)', () => {
  it('tolerates a top-level $schema annotation (does not throw)', () => {
    const schema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'string',
    };
    expect(() => jsonSchemaToZod(schema)).not.toThrow();
    expect(accepts(schema, 'hi')).toBe(true);
    expect(accepts(schema, 5)).toBe(false);
  });

  it('tolerates a title annotation (does not throw, title is ignored)', () => {
    const schema = { type: 'string', title: 'A field' };
    expect(() => jsonSchemaToZod(schema)).not.toThrow();
    expect(accepts(schema, 'hi')).toBe(true);
  });

  it('does NOT propagate an empty-string description (length > 0 guard)', () => {
    const zType = jsonSchemaToZod({ type: 'string', description: '' });
    // z.toJSONSchema should not emit a description key for the empty string
    expect(z.toJSONSchema(zType).description).toBeUndefined();
  });
});

describe('determinism & purity', () => {
  it('converting the same schema twice yields structurally identical output', () => {
    const schema = {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['file', 'diff', 'env'] },
        size: { type: 'integer', minimum: 0 },
      },
      required: ['kind'],
      additionalProperties: false,
    };
    const a = z.toJSONSchema(jsonSchemaToZod(schema));
    const b = z.toJSONSchema(jsonSchemaToZod(schema));
    expect(a).toEqual(b);
  });
});

describe('SUPPORTED_JSON_SCHEMA_TYPES (doc/drift guard)', () => {
  it('enumerates exactly the handled types', () => {
    expect([...SUPPORTED_JSON_SCHEMA_TYPES].sort()).toEqual(
      ['array', 'boolean', 'integer', 'number', 'object', 'string'].sort(),
    );
  });
});
