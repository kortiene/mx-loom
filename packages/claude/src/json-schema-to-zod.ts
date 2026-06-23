/**
 * JSON Schema → Zod converter (T111 / #19) — the Claude-binding seam.
 *
 * The canonical registry (`@mx-loom/registry`, T101) describes every model-facing
 * `mx_*` verb with a **draft-07 JSON Schema** `input_schema`. That representation
 * is correct for the universal bindings (MCP T109, Google ADK, OpenCode) and the
 * daemon — they consume JSON Schema directly. The **Claude Agent SDK shim** (T110)
 * is the exception: `tool()` / `createSdkMcpServer()` from
 * `@anthropic-ai/claude-agent-sdk` take a **Zod** schema, not JSON Schema. So
 * before T110 can register the nine canonical verbs in-process, each descriptor's
 * JSON Schema must be converted to an equivalent Zod schema. This module is that
 * converter — and **only** that: it covers the exact JSON Schema subset the
 * canonical input schemas use, not the full spec.
 *
 * **The acceptance bar is *equivalence*, not "it produced a Zod object".** For
 * every representative input, the generated Zod schema must accept/reject exactly
 * what the original JSON Schema (validated by the registry's Ajv seam) does. A
 * converter that silently widens validation — emitting `z.any()` for an unknown
 * construct, or dropping `additionalProperties: false` — would weaken the model's
 * input surface and is a correctness **and** a security regression. Hence the two
 * load-bearing rules below:
 *
 *  1. **Fail closed.** Any construct outside the supported subset throws a typed
 *     {@link JsonSchemaConversionError} naming the JSON-path and the offending
 *     keyword. The converter NEVER falls through to a permissive `z.any()` /
 *     `z.unknown()`.
 *  2. **`additionalProperties` ↔ object strictness is exact.** A plain
 *     `z.object({…})` *strips* unknown keys (parse succeeds, extras dropped); JSON
 *     Schema `additionalProperties: false` *rejects* them. The converter emits a
 *     **strict** object for `additionalProperties: false` so extras are rejected,
 *     matching the JSON Schema exactly.
 *
 * **Target: Zod v4** (pinned to the major `@anthropic-ai/claude-agent-sdk`
 * depends on — `zod@^4.4.3`). v4 idioms used: `z.int()` (not `z.number().int()`),
 * `z.strictObject` / `z.looseObject` (not `.strict()` / `.passthrough()`).
 *
 * Pure, synchronous, side-effect-free: no `Date`/random/I/O. The same schema
 * converts to a structurally identical Zod schema every time.
 */
import { z } from 'zod';
import type { ZodType, ZodRawShape } from 'zod';

/**
 * Thrown when a schema uses a construct outside the supported subset (or is
 * otherwise malformed for conversion). **Fail-closed**: the converter throws this
 * rather than emitting a permissive schema that would widen validation.
 *
 * This is a *build-/load-time developer error* (like the registry's
 * `DescriptorValidationError`) — it is NOT a model-facing `error.code`, never
 * enters a result envelope, and is not part of the closed error taxonomy. Its
 * message carries only the JSON-path and the offending keyword — never an
 * arbitrary value echo (and the descriptors are secret-free regardless).
 */
export class JsonSchemaConversionError extends Error {
  /** JSON-path of the offending node, e.g. `"#/properties/args"`. */
  readonly path: string;
  /** The unsupported keyword / type, e.g. `"oneOf"` or `"type:null"`. */
  readonly keyword: string;

  constructor(path: string, keyword: string, detail?: string) {
    super(
      `Cannot convert JSON Schema to Zod at ${path}: unsupported ${keyword}` +
        (detail ? ` — ${detail}` : ''),
    );
    this.name = 'JsonSchemaConversionError';
    this.path = path;
    this.keyword = keyword;
  }
}

export interface ConvertOptions {
  /**
   * How an OPEN object (`additionalProperties: true` / absent) **with no
   * `properties`** is represented:
   *  - `'record'` → `z.record(z.string(), z.unknown())` (default)
   *  - `'passthrough'` → `z.looseObject({})`
   *
   * Both accept any object and **reject non-objects** (string/array/number/null),
   * matching JSON Schema `type: object`. (`z.any()` / `z.unknown()` would accept
   * non-objects and are therefore wrong here — never used.)
   */
  openObject?: 'record' | 'passthrough';
}

/**
 * Structural keywords outside the supported subset. Their presence means the
 * schema composes/branches/references in ways the converter deliberately does not
 * half-support — it fails closed (see *Non-Goals* in the spec). Detected up front
 * so the error names the exact offending keyword.
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

/** Apply a `description` annotation to a converted schema, if present & non-empty. */
function withDescription(zType: ZodType, node: Record<string, unknown>): ZodType {
  const description = node['description'];
  return typeof description === 'string' && description.length > 0
    ? zType.describe(description)
    : zType;
}

/** Apply draft-07 numeric bounds (`minimum`/`maximum`/exclusive*) to a number/int. */
function applyNumericBounds(
  zNum: z.ZodNumber,
  node: Record<string, unknown>,
): z.ZodNumber {
  let out = zNum;
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum } = node;
  if (typeof minimum === 'number') out = out.gte(minimum);
  if (typeof maximum === 'number') out = out.lte(maximum);
  if (typeof exclusiveMinimum === 'number') out = out.gt(exclusiveMinimum);
  if (typeof exclusiveMaximum === 'number') out = out.lt(exclusiveMaximum);
  return out;
}

/** Build the `{ key → (optional-aware) ZodType }` shape from `properties`/`required`. */
function buildShape(
  node: Record<string, unknown>,
  path: string,
  opts: ConvertOptions,
): ZodRawShape {
  const properties = node['properties'];
  const required = Array.isArray(node['required']) ? (node['required'] as unknown[]) : [];
  const shape: Record<string, ZodType> = {};
  if (isPlainObject(properties)) {
    for (const [key, sub] of Object.entries(properties)) {
      const converted = convert(sub, `${path}/properties/${key}`, opts);
      shape[key] = required.includes(key) ? converted : converted.optional();
    }
  }
  return shape;
}

/** Convert a `type: 'object'` node, getting `additionalProperties` strictness exact. */
function convertObject(
  node: Record<string, unknown>,
  path: string,
  opts: ConvertOptions,
): ZodType {
  const ap = node['additionalProperties'];
  // The subset uses boolean `additionalProperties` only. A schema-valued
  // `additionalProperties` (a `.catchall(...)` shape) is out of scope — fail closed.
  if (ap !== undefined && typeof ap !== 'boolean') {
    throw new JsonSchemaConversionError(
      path,
      'additionalProperties',
      'schema-valued additionalProperties is outside the supported subset (booleans only)',
    );
  }

  const properties = node['properties'];
  const hasProperties = isPlainObject(properties) && Object.keys(properties).length > 0;

  if (!hasProperties) {
    // Closed empty object (`additionalProperties: false`, no properties): accepts
    // ONLY `{}` and rejects any key — `z.strictObject({})` matches exactly.
    if (ap === false) return z.strictObject({});
    // Open object (`additionalProperties: true` / absent, no properties): accepts
    // arbitrary object content but MUST reject non-objects (JSON Schema
    // `type: object`). Both representations satisfy that; default to `z.record`.
    return opts.openObject === 'passthrough'
      ? z.looseObject({})
      : z.record(z.string(), z.unknown());
  }

  const shape = buildShape(node, path, opts);
  // `additionalProperties: false` → strict (reject extras). `true` or ABSENT →
  // loose/passthrough: the JSON Schema default for `additionalProperties` is
  // `true`, so an absent keyword permits extra keys; emitting strict here would
  // wrongly NARROW validation.
  return ap === false ? z.strictObject(shape) : z.looseObject(shape);
}

/** Convert a `type: 'string'` node (plain or an `enum` of string literals). */
function convertString(node: Record<string, unknown>, path: string): ZodType {
  const enumValue = node['enum'];
  if (enumValue === undefined) return z.string();

  if (!Array.isArray(enumValue) || enumValue.length === 0) {
    throw new JsonSchemaConversionError(path, 'enum', 'enum must be a non-empty array');
  }
  for (const member of enumValue) {
    if (typeof member !== 'string') {
      throw new JsonSchemaConversionError(
        path,
        'enum',
        'every enum member must be a string in the supported subset',
      );
    }
  }
  return z.enum(enumValue as [string, ...string[]]);
}

/**
 * The single recursive worker: convert one JSON Schema node to a Zod schema.
 * Fail-closed on anything outside the subset.
 */
function convert(node: unknown, path: string, opts: ConvertOptions): ZodType {
  if (!isPlainObject(node)) {
    throw new JsonSchemaConversionError(path, 'schema', 'a schema node must be a JSON object');
  }

  // Reject unsupported structural keywords up front so the error is precise.
  for (const keyword of UNSUPPORTED_KEYWORDS) {
    if (keyword in node) {
      throw new JsonSchemaConversionError(path, keyword);
    }
  }

  const type = node['type'];
  if (type === undefined) {
    throw new JsonSchemaConversionError(
      path,
      'type',
      'a schema with no `type` is outside the supported subset (no $ref/composition)',
    );
  }
  if (Array.isArray(type)) {
    throw new JsonSchemaConversionError(path, 'type', 'union (array) `type` is unsupported');
  }
  if (typeof type !== 'string' || !SUPPORTED_TYPES.includes(type as SupportedType)) {
    throw new JsonSchemaConversionError(path, `type:${String(type)}`);
  }

  // `enum` is supported only on strings in the subset; reject it elsewhere rather
  // than silently dropping it (which would widen).
  if (type !== 'string' && 'enum' in node) {
    throw new JsonSchemaConversionError(path, 'enum', `enum is unsupported on type:${type}`);
  }

  let result: ZodType;
  switch (type as SupportedType) {
    case 'string':
      result = convertString(node, path);
      break;
    case 'integer':
      result = applyNumericBounds(z.int(), node);
      break;
    case 'number':
      result = applyNumericBounds(z.number(), node);
      break;
    case 'boolean':
      result = z.boolean();
      break;
    case 'array': {
      const items = node['items'];
      if (Array.isArray(items)) {
        // Tuple `items` (positional schemas) is outside the subset — fail closed.
        throw new JsonSchemaConversionError(path, 'items', 'tuple `items` is unsupported');
      }
      result = z.array(
        items === undefined ? z.unknown() : convert(items, `${path}/items`, opts),
      );
      break;
    }
    case 'object':
      result = convertObject(node, path, opts);
      break;
  }

  return withDescription(result, node);
}

/**
 * Convert a (subset) draft-07 JSON Schema document to an equivalent Zod schema.
 *
 * @throws {JsonSchemaConversionError} on any construct outside the supported
 * subset (unknown/missing `type`, union `type`, `oneOf`/`anyOf`/`allOf`/`not`,
 * `$ref`, `if/then/else`, `patternProperties`, tuple `items`, schema-valued
 * `additionalProperties`, a non-string `enum` member, …).
 */
export function jsonSchemaToZod(
  schema: Record<string, unknown>,
  opts: ConvertOptions = {},
): ZodType {
  return convert(schema, '#', opts);
}

/**
 * Convert an object-rooted JSON Schema to the `properties`-map form
 * (`ZodRawShape`) that the Claude SDK's `tool(name, description, shape, handler)`
 * accepts. Optional fields (not in `required`) are `.optional()`.
 *
 * **Strictness caveat for T110:** a raw shape passed to `tool()` is re-wrapped by
 * the SDK as a *non-strict* `z.object`, so `additionalProperties: false`
 * strictness (rejecting extra keys) is NOT enforced at the Claude layer via the
 * shape form. That is acceptable — the toolbelt's `assertNoCredentialShapedArgs`
 * and the daemon re-validate at dispatch — but a call site wanting client-side
 * strictness should use {@link jsonSchemaToZod}, which returns a `.strict()`
 * (`z.strictObject`) schema.
 *
 * @throws {JsonSchemaConversionError} if the root is not `type: 'object'`, or on
 * any unsupported construct within.
 */
export function jsonSchemaToZodRawShape(
  schema: Record<string, unknown>,
  opts: ConvertOptions = {},
): ZodRawShape {
  if (!isPlainObject(schema) || schema['type'] !== 'object') {
    throw new JsonSchemaConversionError(
      '#',
      'type',
      'jsonSchemaToZodRawShape requires an object-rooted schema (type:object)',
    );
  }
  // Surface any unsupported construct in the root (e.g. composition keywords)
  // before building the shape, so callers get the same fail-closed contract.
  for (const keyword of UNSUPPORTED_KEYWORDS) {
    if (keyword in schema) {
      throw new JsonSchemaConversionError('#', keyword);
    }
  }
  return buildShape(schema, '#', opts);
}
