/**
 * Recursive structural freeze.
 *
 * The canonical descriptor set must be immutable to consumers: a binding
 * generator (T109 MCP, T110 Claude) reads descriptors but must never be able to
 * mutate the single source of truth — including the nested JSON Schema objects.
 * `Object.freeze` is shallow, so we walk the whole graph.
 *
 * Idempotent (skips already-frozen nodes) and cycle-safe by construction:
 * descriptors are pure JSON-shaped data with no cycles.
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}
