/**
 * JSON Schema → TypeBox converter (T205) — the Pi-binding schema adapter.
 *
 * The canonical registry (`@mx-loom/registry`) describes every model-facing
 * `mx_*` verb with a **draft-07 JSON Schema** `input_schema`. Pi's native tool
 * type takes a **TypeBox** schema as its `parameters`, so before the nine verbs
 * can be registered with Pi each descriptor's JSON Schema must be converted to an
 * equivalent TypeBox schema. This module is that converter — and **only** that:
 * it covers the exact JSON Schema subset the canonical input schemas use, not the
 * full spec. It is the TypeBox sibling of the Claude binding's T111
 * `json-schema-to-zod.ts` and follows the same two load-bearing rules:
 *
 *  1. **Fail closed.** Any construct outside the supported subset throws a typed
 *     {@link PiSchemaConversionError} naming the JSON-path and the offending
 *     keyword. The converter NEVER falls through to a permissive `Type.Any()` /
 *     `Type.Unknown()` — that would silently widen the model's input surface
 *     (Risk #4: a naive `enum → Type.Union` would even pass an Ajv-equivalence
 *     check yet break Pi runs on Google-provider models).
 *  2. **Enums → `StringEnum`.** Every `enum` string field is emitted via the
 *     injected `StringEnum` (from `@earendil-works/pi-ai`), producing the
 *     Google-safe `{ type: 'string', enum: [...] }` shape — never a
 *     `Type.Union`/`Type.Literal` (`oneOf`/`anyOf`).
 *
 * **The TypeBox schema is the model-facing shape, not the runtime gate.** Per
 * T204, TypeBox is not confirmed to validate `parameters` inside Pi's tool
 * pipeline, so each generated `execute()` runs a fail-closed Ajv preflight
 * against the descriptor's `input_schema` (the registry's `createAjvValidator`)
 * before dispatch (see `tools.ts`). Equivalence between the two is asserted by the
 * converter test suite (accept/reject parity, every enum field included).
 *
 * **The builders are injected, never imported.** `Type` (TypeBox) and `StringEnum`
 * (pi-ai) are passed in via {@link TypeBoxBuilders} so a single TypeBox runtime —
 * the one Pi bundled — builds every schema (Pi rejects a schema tagged by a
 * different TypeBox copy's `[Kind]` symbols). This also keeps `@mx-loom/pi` free
 * of any heavy/native runtime dependency and type-checkable without the peer.
 *
 * Pure, synchronous, side-effect-free given the builders: no `Date`/random/I/O.
 */
import type { TypeBoxBuilders, TypeBoxSchema } from './pi-abi.js';

/**
 * Thrown when a schema uses a construct outside the supported subset (or is
 * otherwise malformed for conversion). **Fail-closed**: the converter throws this
 * rather than emitting a permissive schema that would widen validation.
 *
 * This is a *build-/startup-time developer error* (like the registry's
 * `DescriptorValidationError` and the Claude binding's `JsonSchemaConversionError`)
 * — it is NOT a model-facing `error.code`, never enters a result envelope, and is
 * not part of the closed error taxonomy. Its message carries only the JSON-path
 * and the offending keyword — never an arbitrary value echo (and the descriptors
 * are secret-free regardless).
 */
export class PiSchemaConversionError extends Error {
  /** JSON-path of the offending node, e.g. `"#/properties/args"`. */
  readonly path: string;
  /** The unsupported keyword / type, e.g. `"oneOf"` or `"type:null"`. */
  readonly keyword: string;

  constructor(path: string, keyword: string, detail?: string) {
    super(
      `Cannot convert JSON Schema to TypeBox at ${path}: unsupported ${keyword}` +
        (detail ? ` — ${detail}` : ''),
    );
    this.name = 'PiSchemaConversionError';
    this.path = path;
    this.keyword = keyword;
  }
}

export interface ConvertOptions {
  /**
   * How an OPEN object (`additionalProperties: true` / absent) is represented in
   * the emitted TypeBox object's `additionalProperties` option:
   *  - `'open'` → `additionalProperties: true` (default) — accepts extra keys,
   *    matching the JSON Schema default.
   *  - `'strip'` → `additionalProperties` omitted — TypeBox's own default.
   *
   * Either way the object still rejects non-objects. A CLOSED object
   * (`additionalProperties: false`) is always emitted strict regardless.
   */
  openObject?: 'open' | 'strip';
}

/**
 * Structural keywords outside the supported subset. Their presence means the
 * schema composes/branches/references in ways the converter deliberately does not
 * half-support — it fails closed. Detected up front so the error names the exact
 * offending keyword. Mirrors the Claude T111 converter's list.
 */
const UNSUPPORTED_KEYWORDS = [
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  '$ref',
  '$defs',
  'definitions',
  'patternProperties',
  'dependentSchemas',
  'dependentRequired',
  'dependencies',
  'propertyNames',
  'const',
  'contains',
  'prefixItems',
] as const;

/** The `type` strings the converter handles. `null` is intentionally excluded. */
type SupportedType = 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object';
const SUPPORTED_TYPES: readonly SupportedType[] = [
  'string',
  'integer',
  'number',
  'boolean',
  'array',
  'object',
];

/** The set of JSON Schema `type`s this converter supports (for docs/tests). */
export const SUPPORTED_JSON_SCHEMA_TYPES: readonly string[] = SUPPORTED_TYPES;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Build the options bag (`{ description? }`) every builder accepts, from a node. */
function annotations(node: Record<string, unknown>): Record<string, unknown> {
  const description = node['description'];
  return typeof description === 'string' && description.length > 0 ? { description } : {};
}

/** Apply draft-07 numeric bounds (`minimum`/`maximum`/exclusive*) onto an options bag. */
function numericBounds(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum } = node;
  if (typeof minimum === 'number') out['minimum'] = minimum;
  if (typeof maximum === 'number') out['maximum'] = maximum;
  if (typeof exclusiveMinimum === 'number') out['exclusiveMinimum'] = exclusiveMinimum;
  if (typeof exclusiveMaximum === 'number') out['exclusiveMaximum'] = exclusiveMaximum;
  return out;
}

/** Convert a `type: 'string'` node (plain or an `enum` of string literals → `StringEnum`). */
function convertString(
  node: Record<string, unknown>,
  path: string,
  builders: TypeBoxBuilders,
): TypeBoxSchema {
  const enumValue = node['enum'];
  if (enumValue === undefined) return builders.Type.String(annotations(node));

  if (!Array.isArray(enumValue) || enumValue.length === 0) {
    throw new PiSchemaConversionError(path, 'enum', 'enum must be a non-empty array');
  }
  for (const member of enumValue) {
    if (typeof member !== 'string') {
      throw new PiSchemaConversionError(
        path,
        'enum',
        'every enum member must be a string in the supported subset (use StringEnum, never Type.Union)',
      );
    }
  }
  // The crux: a string enum is `StringEnum`, NOT `Type.Union(Type.Literal(...))`.
  return builders.StringEnum(enumValue as string[], annotations(node));
}

/** Convert a `type: 'object'` node, getting `additionalProperties` strictness exact. */
function convertObject(
  node: Record<string, unknown>,
  path: string,
  builders: TypeBoxBuilders,
  opts: ConvertOptions,
): TypeBoxSchema {
  const ap = node['additionalProperties'];
  // The subset uses boolean `additionalProperties` only. A schema-valued
  // `additionalProperties` (a `catchall` shape) is out of scope — fail closed.
  if (ap !== undefined && typeof ap !== 'boolean') {
    throw new PiSchemaConversionError(
      path,
      'additionalProperties',
      'schema-valued additionalProperties is outside the supported subset (booleans only)',
    );
  }

  const properties = node['properties'];
  const required = Array.isArray(node['required']) ? (node['required'] as unknown[]) : [];
  const shape: Record<string, TypeBoxSchema> = {};
  if (isPlainObject(properties)) {
    for (const [key, sub] of Object.entries(properties)) {
      const converted = convert(sub, `${path}/properties/${key}`, builders, opts);
      // Optionality is marked on the property (TypeBox derives `required` from the
      // non-optional props); `additionalProperties: false` is set on the object.
      shape[key] = required.includes(key) ? converted : builders.Type.Optional(converted);
    }
  }

  const options: Record<string, unknown> = annotations(node);
  if (ap === false) {
    // Closed object: reject extra keys — match JSON Schema `additionalProperties: false`.
    options['additionalProperties'] = false;
  } else if (opts.openObject !== 'strip') {
    // Open object (`additionalProperties: true` or ABSENT — JSON Schema's default
    // is `true`): permit extra keys, so emitting strict would wrongly NARROW.
    options['additionalProperties'] = true;
  }
  return builders.Type.Object(shape, options);
}

/**
 * The single recursive worker: convert one JSON Schema node to a TypeBox schema.
 * Fail-closed on anything outside the subset.
 */
function convert(
  node: unknown,
  path: string,
  builders: TypeBoxBuilders,
  opts: ConvertOptions,
): TypeBoxSchema {
  if (!isPlainObject(node)) {
    throw new PiSchemaConversionError(path, 'schema', 'a schema node must be a JSON object');
  }

  // Reject unsupported structural keywords up front so the error is precise.
  for (const keyword of UNSUPPORTED_KEYWORDS) {
    if (keyword in node) {
      throw new PiSchemaConversionError(path, keyword);
    }
  }

  const type = node['type'];
  if (type === undefined) {
    throw new PiSchemaConversionError(
      path,
      'type',
      'a schema with no `type` is outside the supported subset (no $ref/composition)',
    );
  }
  if (Array.isArray(type)) {
    throw new PiSchemaConversionError(path, 'type', 'union (array) `type` is unsupported');
  }
  if (typeof type !== 'string' || !SUPPORTED_TYPES.includes(type as SupportedType)) {
    throw new PiSchemaConversionError(path, `type:${String(type)}`);
  }

  // `enum` is supported only on strings in the subset; reject it elsewhere rather
  // than silently dropping it (which would widen).
  if (type !== 'string' && 'enum' in node) {
    throw new PiSchemaConversionError(path, 'enum', `enum is unsupported on type:${type}`);
  }

  switch (type as SupportedType) {
    case 'string':
      return convertString(node, path, builders);
    case 'integer':
      return builders.Type.Integer({ ...annotations(node), ...numericBounds(node) });
    case 'number':
      return builders.Type.Number({ ...annotations(node), ...numericBounds(node) });
    case 'boolean':
      return builders.Type.Boolean(annotations(node));
    case 'array': {
      const items = node['items'];
      if (Array.isArray(items)) {
        // Tuple `items` (positional schemas) is outside the subset — fail closed.
        throw new PiSchemaConversionError(path, 'items', 'tuple `items` is unsupported');
      }
      if (items === undefined) {
        // An array with no `items` would have an unknown element type; the subset
        // always declares `items`, so a missing one is a fail-closed signal.
        throw new PiSchemaConversionError(path, 'items', 'array requires an `items` schema in the supported subset');
      }
      return builders.Type.Array(convert(items, `${path}/items`, builders, opts), annotations(node));
    }
    case 'object':
      return convertObject(node, path, builders, opts);
  }
}

/**
 * Convert a (subset) draft-07 JSON Schema document to an equivalent Pi TypeBox
 * schema, using the injected {@link TypeBoxBuilders}.
 *
 * @throws {PiSchemaConversionError} on any construct outside the supported subset
 * (unknown/missing `type`, union `type`, `oneOf`/`anyOf`/`allOf`/`not`, `$ref`,
 * `if/then/else`, `patternProperties`, tuple `items`, schema-valued
 * `additionalProperties`, a non-string `enum` member, …).
 */
export function jsonSchemaToTypeBox(
  schema: Record<string, unknown>,
  builders: TypeBoxBuilders,
  opts: ConvertOptions = {},
): TypeBoxSchema {
  return convert(schema, '#', builders, opts);
}
