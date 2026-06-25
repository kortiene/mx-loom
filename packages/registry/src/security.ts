/**
 * The registry's security invariants (design §2 "Explicitly NOT model tools",
 * §6, §9 "Don't give cognition any authority surface").
 *
 * The registry is the **closed allowlist of what cognition can even name** — its
 * *content* is itself a security boundary. Two invariants live here:
 *
 *  1. **No-authority.** The model-facing set must NEVER carry a descriptor for an
 *     authority-mutation RPC (`trust.*`, `approval.decide`, `policy.*`, `auth.*`,
 *     `device.*`, `cross_signing.*`, `recovery.*`, `daemon.*`). Cognition can only
 *     ever produce a signed request; it cannot even *name* a governance verb,
 *     because no descriptor exists for one.
 *  2. **Secret-free input shape.** No `input_schema` may declare a property whose
 *     name looks credential-shaped — so the canonical schemas never *invite* a
 *     credential inbound (design §4.7).
 */

/**
 * The complete universe of known model-facing `mx_*` verbs (design §2, §8). The
 * default registry now loads all **13** verbs: the 7 P0 M1 verbs (T101) + the 2 P1
 * M1 verbs `mx_cancel` / `mx_workspace_status` (T108) + the 3 M3 task-DAG verbs
 * `mx_create_task` / `mx_update_task` / `mx_list_tasks` (T301) + the M3 dispatch verb
 * `mx_dispatch_task` (T303). The security regression test asserts the default set is a
 * subset of this allowlist. Task verbs (authoring, reading, and dispatching the plan)
 * are not governance verbs — the forbidden-authority check is untouched.
 */
export const MODEL_FACING_ALLOWLIST = [
  'mx_find_agents',
  'mx_describe_agent',
  'mx_delegate_tool',
  'mx_run_command',
  'mx_await_result',
  'mx_share_context',
  'mx_get_context',
  // P1 (T108) — the cancel + workspace-observe verbs.
  'mx_cancel',
  'mx_workspace_status',
  // M3 (T301) — the task-DAG verbs (author + read the durable shared plan).
  'mx_create_task',
  'mx_update_task',
  'mx_list_tasks',
  // M3 (T303) — dispatch a node's authored action through the authorize pipeline.
  // A request-producer, not a governance verb — the forbidden-authority set is untouched.
  'mx_dispatch_task',
] as const;

/**
 * Authority-mutation RPC method *prefixes* that must never appear as a model
 * tool. These are dotted daemon RPC names (not `mx_*`), so a descriptor whose
 * name passes {@link ../descriptor.TOOL_NAME_RE} can never match — the check is
 * belt-and-suspenders that makes the no-authority invariant explicit and
 * regression-proof.
 */
export const FORBIDDEN_AUTHORITY_PREFIXES = [
  'trust.',
  'policy.',
  'auth.',
  'device.',
  'cross_signing.',
  'recovery.',
  'daemon.',
] as const;

/** Exact forbidden authority verbs that are not covered by a prefix. */
export const FORBIDDEN_AUTHORITY_VERBS = ['approval.decide'] as const;

/** True iff `name` is (or is namespaced under) a forbidden authority-mutation verb. */
export function isForbiddenAuthorityVerb(name: string): boolean {
  if ((FORBIDDEN_AUTHORITY_VERBS as readonly string[]).includes(name)) return true;
  return FORBIDDEN_AUTHORITY_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Param **keys** that look credential-shaped.
 *
 * This MIRRORS the toolbelt's T008 `CREDENTIAL_KEY_RE`
 * (`packages/toolbelt/src/guards.ts`), which is the authoritative runtime guard
 * that still rejects credential-shaped *args* at dispatch (T105). Here it is the
 * *publish-time* oracle: a canonical `input_schema` must never declare a property
 * the dispatch guard would reject, so a well-formed model call never needs that
 * guard to fire. `security-invariants.test.ts` imports the toolbelt's exported
 * regex and pins this copy against it (no-drift).
 */
export const CREDENTIAL_KEY_RE =
  /(?:secret|password|passwd|api[_-]?key|signing[_-]?key|private[_-]?key|matrix_|mx_agent_|gh[_-]?token|(?:^|[_-])token$)/i;

/**
 * Collect every property *name* a JSON Schema declares, recursively. Walks
 * `properties` keys plus the standard schema-bearing keywords (`items`,
 * `additionalProperties`, `patternProperties`, `definitions`/`$defs`, and the
 * `allOf`/`anyOf`/`oneOf`/`not` combinators) so a credential-shaped field cannot
 * hide in a nested sub-schema.
 */
export function collectSchemaPropertyNames(schema: unknown): string[] {
  const names: string[] = [];
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    const properties = obj.properties;
    if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
      for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
        names.push(key);
        visit(child);
      }
    }
    const patternProperties = obj.patternProperties;
    if (patternProperties !== null && typeof patternProperties === 'object' && !Array.isArray(patternProperties)) {
      for (const child of Object.values(patternProperties as Record<string, unknown>)) visit(child);
    }
    for (const key of ['definitions', '$defs'] as const) {
      const defs = obj[key];
      if (defs !== null && typeof defs === 'object' && !Array.isArray(defs)) {
        for (const child of Object.values(defs as Record<string, unknown>)) visit(child);
      }
    }
    for (const key of ['items', 'additionalProperties', 'not', 'if', 'then', 'else'] as const) {
      visit(obj[key]);
    }
    for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
      const branch = obj[key];
      if (Array.isArray(branch)) for (const child of branch) visit(child);
    }
  };
  visit(schema);
  return names;
}

/**
 * Return the first declared property name that looks credential-shaped, or
 * `undefined` if the schema is clean. Used by the loader to enforce the
 * secret-free input-shape invariant.
 */
export function findCredentialShapedProperty(
  schema: unknown,
  keyRe: RegExp = CREDENTIAL_KEY_RE,
): string | undefined {
  for (const name of collectSchemaPropertyNames(schema)) {
    if (keyRe.test(name)) return name;
  }
  return undefined;
}
