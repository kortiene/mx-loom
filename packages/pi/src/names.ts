/**
 * Tool-name helpers for the Pi binding (T205).
 *
 * Unlike the Claude in-process shim — whose `createSdkMcpServer` forces the
 * `mcp__<server>__<verb>` namespacing — Pi registers a native tool under its
 * **bare** name. So the names the model and Pi's active-tool selection
 * (`--tools` / `pi.setActiveTools()` / `createAgentSession({ tools })`) see are
 * exactly the canonical `mx_*` verbs. These helpers exist so a host can enable
 * *only* the generated mx-loom tools without restating the list.
 */
import { CANONICAL_TOOLS } from '@mx-loom/registry';

/**
 * The bare names of the generated mx-loom Pi tools, in canonical order. Pass to
 * `createAgentSession({ tools: mxToolNames() })` or `pi.setActiveTools(...)` to
 * activate only the mx-loom verbs (combine with `--no-builtin-tools` / `noTools:
 * 'builtin'` to run an mx-loom-only surface). Registration alone does NOT make a
 * disabled tool callable — it must also be in the active set.
 */
export function mxToolNames(): string[] {
  return CANONICAL_TOOLS.map((descriptor) => descriptor.name);
}

/** True iff `name` is one of the canonical mx-loom `mx_*` verbs this binding registers. */
export function isMxToolName(name: string): boolean {
  return CANONICAL_TOOLS.some((descriptor) => descriptor.name === name);
}
