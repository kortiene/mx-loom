/**
 * Registration helpers (T205) — drive Pi's `registerTool` surface.
 *
 * Two ways a host wires the generated tools into Pi:
 *  - **SDK `customTools`** — pass {@link import('./tools.js').createPiToolDefinitions}
 *    straight into `createAgentSession({ customTools })` (no helper needed).
 *  - **Extension `registerTool`** — {@link registerMxTools} calls `registerTool(t)`
 *    for each generated tool on any host exposing it (the top-level `pi` handle, or
 *    an extension factory's `api`). Callable during load **or** after startup; new
 *    tools appear in `pi.getAllTools()` without `/reload`. {@link createMxPiExtension}
 *    packages that into the `(api) => …` extension factory Pi invokes at load time.
 *
 * Both are thin wrappers over `createPiToolDefinitions`; all the binding's logic
 * (schema conversion, Ajv preflight, dispatch, audit, serialization, the secret
 * boundary) lives there. Registering a tool does **not** make it callable on its
 * own — it must also be in Pi's active set (`--tools` / `--no-builtin-tools` /
 * `pi.setActiveTools()`; see {@link import('./names.js').mxToolNames}).
 */
import type { BindingContext } from './context.js';
import type { PiExtensionFactory, PiToolHost, ToolDefinition } from './pi-abi.js';
import { createPiToolDefinitions } from './tools.js';
import type { CreatePiToolDefinitionsOptions } from './tools.js';

/** Options for {@link registerMxTools} / {@link createMxPiExtension}. */
export interface RegisterMxToolsOptions extends CreatePiToolDefinitionsOptions {
  /** The secret-free binding context (daemon seam + room + audit sink). */
  context: BindingContext;
}

/**
 * Register the generated mx-loom tools on a Pi host (the `pi` handle or an
 * extension `api`). Returns the {@link ToolDefinition}[] it registered, so a caller
 * can also feed them to active-tool selection.
 *
 * @throws {import('./json-schema-to-typebox.js').PiSchemaConversionError} at build
 * time if a descriptor's schema drifts outside the supported subset (fail-closed).
 */
export function registerMxTools(pi: PiToolHost, options: RegisterMxToolsOptions): ToolDefinition[] {
  const { context, ...toolOptions } = options;
  const tools = createPiToolDefinitions(context, toolOptions);
  for (const tool of tools) {
    pi.registerTool(tool);
  }
  return tools;
}

/**
 * Build the Pi extension factory (`(api) => …`) that registers the mx-loom tools
 * at load time. Drop into `DefaultResourceLoader({ extensionFactories: [factory] })`
 * or a default extension export.
 *
 * The tools are generated **eagerly** (so a schema-drift {@link
 * import('./json-schema-to-typebox.js').PiSchemaConversionError} surfaces here, at
 * wiring time, not mid-load); the returned factory only registers them.
 */
export function createMxPiExtension(options: RegisterMxToolsOptions): PiExtensionFactory {
  const { context, ...toolOptions } = options;
  const tools = createPiToolDefinitions(context, toolOptions);
  return (api: PiToolHost): void => {
    for (const tool of tools) {
      api.registerTool(tool);
    }
  };
}
