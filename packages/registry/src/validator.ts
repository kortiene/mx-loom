/**
 * The JSON Schema validation seam (T101 Risks #1).
 *
 * **Decision (Risk #1): Ajv is a RUNTIME dependency of `@mx-loom/registry`,
 * behind this injectable `SchemaValidator` seam (option b).** Rationale:
 *  - `loadRegistry()` then meta-validates every descriptor schema at construction
 *    in *all* environments (fail-fast), which is the strongest reading of AC 1
 *    ("descriptors validate as JSON Schema") and matches the §3 validator design.
 *  - T105 ("reject `invalid_args` before dispatch") and T111 (schema → Zod) both
 *    need JSON-Schema handling one issue later; paying the dependency once, and
 *    exposing the same compiled-validator seam, avoids churn.
 *  - The seam keeps the registry core testable — a fake validator can be injected
 *    in unit tests — and lets the (a)↔(b) wiring be a one-line change.
 *
 * The toolbelt keeps its zero-runtime-dependency streak: Ajv lives here, in the
 * separate leaf package, not in `@mx-loom/toolbelt`.
 */
import { Ajv } from 'ajv';
import type { Options } from 'ajv';

import type { JsonSchema } from './descriptor.js';

/**
 * The JSON Schema dialect the registry authors and validates against.
 *
 * **Decision (Risk #3): draft-07.** It is Ajv's default meta-schema, the broadest
 * interop target, and the easiest subset for T111's JSON Schema → Zod converter.
 * The v0.2.1 surface doc records `ToolSchema.input_schema` only as "JSON Schema"
 * without naming a draft; draft-07 is a compatible superset of the simple
 * `{type, properties, required}` shapes it emits (e.g. `run_tests@1.0.0`).
 */
export const JSON_SCHEMA_DIALECT = 'http://json-schema.org/draft-07/schema#';

/** A compiled validate function: returns true iff `data` matches the schema. */
export interface CompiledSchema {
  (data: unknown): boolean;
  /** Validation errors from the most recent call (validator-specific), if any. */
  errors?: unknown;
}

/**
 * The pluggable JSON Schema validator the registry depends on. Compiling a
 * schema both (a) proves it is a well-formed JSON Schema document — the AC-1
 * meta-schema check, which throws on a malformed schema — and (b) yields a
 * reusable validate function T105/T111 can reuse verbatim.
 */
export interface SchemaValidator {
  /**
   * Compile `schema` into a reusable validate function. **Throws** if `schema`
   * is not a valid JSON Schema document (illegal `type`, dangling `$ref`, etc.).
   */
  compile(schema: JsonSchema): CompiledSchema;
}

/**
 * The default Ajv-backed {@link SchemaValidator}.
 *
 * `strict: false` so authored schemas are not rejected for benign Ajv-specific
 * strictness (e.g. a missing `type` alongside a `format`), while the meta-schema
 * validation (`validateSchema`, on by default) still rejects genuinely malformed
 * schemas and `$ref` resolution still throws on a dangling reference.
 */
export function createAjvValidator(options?: Options): SchemaValidator {
  const ajv = new Ajv({ strict: false, allErrors: true, ...options });
  return {
    compile(schema: JsonSchema): CompiledSchema {
      const validate = ajv.compile(schema);
      const compiled = ((data: unknown): boolean => {
        const ok = validate(data);
        compiled.errors = validate.errors ?? undefined;
        return ok === true;
      }) as CompiledSchema;
      return compiled;
    },
  };
}
