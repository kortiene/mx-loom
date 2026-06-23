/**
 * Tool namespacing for the in-process Claude shim (T110 / #18).
 *
 * The SDK's `createSdkMcpServer({ name, tools })` is itself an *in-process MCP
 * server*, so every `tool()` it registers is surfaced to the model under the MCP
 * namespacing convention `mcp__<serverName>__<toolName>`. The host needs the
 * namespaced form to populate `options.allowedTools`, and the `canUseTool` hook
 * (`can-use-tool.ts`) needs it to scope-match this shim's tools reliably — so the
 * mapping lives in one place here, derived from a single server-name constant.
 *
 * The default server name is the short, configurable {@link DEFAULT_SERVER_NAME}
 * (`'mx'`), yielding e.g. `mcp__mx__mx_delegate_tool` (the cosmetic double-`mx` —
 * server `mx` + verb `mx_*` — is deliberate and documented in the README/spec
 * Open Question #6; a host may override it). No secret is involved; these are pure
 * string transforms.
 */

/** Default in-process MCP server name. Override via `createMxToolServer({ name })`. */
export const DEFAULT_SERVER_NAME = 'mx';

/** The fixed MCP in-process-server namespace prefix. */
const NAMESPACE_PREFIX = 'mcp__';

/**
 * Build the namespaced tool name the model and the host see for a given `mx_*`
 * verb: `mcp__<serverName>__<verb>`. Use it to populate `allowedTools` and to
 * match in a `canUseTool` hook.
 */
export function mxToolName(verb: string, serverName: string = DEFAULT_SERVER_NAME): string {
  return `${NAMESPACE_PREFIX}${serverName}__${verb}`;
}

/**
 * The inverse of {@link mxToolName}: given a namespaced tool name as it arrives in
 * `canUseTool`, return the bare `mx_*` verb iff it belongs to this shim's server
 * **and** is an `mx_*` verb — otherwise `undefined` (the name is some other tool
 * the host owns, and the shim must not act on it).
 */
export function mxVerbFromToolName(
  toolName: string,
  serverName: string = DEFAULT_SERVER_NAME,
): string | undefined {
  const prefix = `${NAMESPACE_PREFIX}${serverName}__`;
  if (!toolName.startsWith(prefix)) return undefined;
  const verb = toolName.slice(prefix.length);
  // Only the canonical `mx_*` verbs are ours; a non-`mx_*` tool under the same
  // server name (a host could register more) is not this shim's to gate.
  return verb.startsWith('mx_') ? verb : undefined;
}
