/**
 * The registry loader/validator (T101 / #9).
 *
 * `loadRegistry()` assembles the static canonical descriptor set into a frozen,
 * enumerable `ToolRegistry`, running the **validator** at construction
 * (fail-fast). "Loader" here means "assemble + validate the static set", not a
 * dynamic file/remote/plugin discovery mechanism (an explicit Non-Goal).
 */
import { CANONICAL_TOOLS } from './descriptors/index.js';
import { TOOL_NAME_RE, type ToolDescriptor } from './descriptor.js';
import { deepFreeze } from './freeze.js';
import { findCredentialShapedProperty, isForbiddenAuthorityVerb } from './security.js';
import { createAjvValidator, type SchemaValidator } from './validator.js';

/**
 * Raised at registry-load time (dev / CI / process-start) when a descriptor is
 * malformed. It is **not** a model-facing `error.code` and never reaches the
 * result envelope; it names the offending descriptor + reason, never a secret.
 */
export class DescriptorValidationError extends Error {
  /** The offending descriptor's `name` (or `<unknown>` if it had none). */
  readonly descriptor: string;
  /** Why validation failed — a field/path + reason, never a secret value. */
  readonly reason: string;

  constructor(descriptor: string, reason: string) {
    super(`invalid tool descriptor '${descriptor}': ${reason}`);
    this.name = 'DescriptorValidationError';
    this.descriptor = descriptor;
    this.reason = reason;
  }
}

/** The enumerable, read-only registry surface binding generators consume. */
export interface ToolRegistry {
  /** All descriptors, in a stable (authoring) order, frozen. */
  list(): readonly ToolDescriptor[];
  /** Look up by name; `undefined` if absent. */
  get(name: string): ToolDescriptor | undefined;
  /** Whether a descriptor with this name exists. */
  has(name: string): boolean;
  /** Iteration sugar so `for (const d of registry)` works for binding generators. */
  [Symbol.iterator](): Iterator<ToolDescriptor>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Assemble + validate the descriptor set into a frozen registry. Throws
 * {@link DescriptorValidationError} on the first fault.
 *
 * The validator runs, per descriptor, in order:
 *  1. **Structural** — `name` matches {@link TOOL_NAME_RE}; `description` is a
 *     non-empty string; `async_semantics ∈ {sync, deferred}`; both schemas are
 *     objects.
 *  2. **JSON Schema validity** (AC 1) — each `input_schema`/`output_schema`
 *     compiles against the meta-schema via the injected {@link SchemaValidator}.
 *  3. **Uniqueness** — no two descriptors share a `name`.
 *  4. **No-authority allowlist** — the name is not a forbidden authority verb.
 *  5. **Secret-free input shape** — no `input_schema` property name is
 *     credential-shaped.
 *
 * @param descriptors defaults to {@link CANONICAL_TOOLS} (the full 12-verb set: the
 *   9 M1 verbs + the 3 M3 task verbs); an explicit array is the test seam for
 *   validating a deliberately-bad descriptor.
 * @param validator defaults to the Ajv-backed {@link createAjvValidator}.
 */
export function loadRegistry(
  descriptors: readonly ToolDescriptor[] = CANONICAL_TOOLS,
  validator: SchemaValidator = createAjvValidator(),
): ToolRegistry {
  const byName = new Map<string, ToolDescriptor>();
  const ordered: ToolDescriptor[] = [];

  for (const descriptor of descriptors) {
    const name = typeof descriptor?.name === 'string' && descriptor.name !== '' ? descriptor.name : '<unknown>';

    // 1. Structural validation.
    if (typeof descriptor?.name !== 'string' || !TOOL_NAME_RE.test(descriptor.name)) {
      throw new DescriptorValidationError(name, `name must match ${TOOL_NAME_RE.source}`);
    }
    if (typeof descriptor.description !== 'string' || descriptor.description.trim() === '') {
      throw new DescriptorValidationError(name, 'description must be a non-empty string');
    }
    if (descriptor.async_semantics !== 'sync' && descriptor.async_semantics !== 'deferred') {
      throw new DescriptorValidationError(name, "async_semantics must be 'sync' or 'deferred'");
    }
    if (!isPlainObject(descriptor.input_schema)) {
      throw new DescriptorValidationError(name, 'input_schema must be a JSON Schema object');
    }
    if (!isPlainObject(descriptor.output_schema)) {
      throw new DescriptorValidationError(name, 'output_schema must be a JSON Schema object');
    }

    // 2. JSON Schema validity (AC 1).
    for (const field of ['input_schema', 'output_schema'] as const) {
      try {
        validator.compile(descriptor[field]);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new DescriptorValidationError(name, `${field} is not a valid JSON Schema: ${detail}`);
      }
    }

    // 3. Uniqueness.
    if (byName.has(descriptor.name)) {
      throw new DescriptorValidationError(name, 'duplicate descriptor name');
    }

    // 4. No-authority allowlist (the headline security invariant).
    if (isForbiddenAuthorityVerb(descriptor.name)) {
      throw new DescriptorValidationError(name, 'authority-mutation verbs are forbidden in the model-facing registry');
    }

    // 5. Secret-free input shape.
    const offending = findCredentialShapedProperty(descriptor.input_schema);
    if (offending !== undefined) {
      throw new DescriptorValidationError(name, `input_schema declares credential-shaped property '${offending}'`);
    }

    byName.set(descriptor.name, descriptor);
    ordered.push(descriptor);
  }

  const frozen = deepFreeze(ordered.slice());
  const registry: ToolRegistry = {
    list() {
      return frozen;
    },
    get(lookup: string) {
      return byName.get(lookup);
    },
    has(lookup: string) {
      return byName.has(lookup);
    },
    [Symbol.iterator]() {
      return frozen[Symbol.iterator]();
    },
  };
  return Object.freeze(registry);
}
