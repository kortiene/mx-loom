/**
 * The Pi runtime ABI — local structural mirror (T205).
 *
 * Pi (`@earendil-works/pi-coding-agent`) is consumed by this binding **purely
 * structurally**: a generated `ToolDefinition` is a plain object, an
 * `AgentToolResult` is a plain object, and registration goes through whatever
 * `customTools` / `registerTool` surface the host already has. So rather than take
 * a *static* type-import dependency on the Pi SDK — which would force the package
 * to type-check only when the heavy, native-dependency-carrying Pi tree is
 * installed, and which would raise this leaf package's effective Node floor to
 * Pi's (`>=22.19` at the 0.80.x pin, above mx-loom's `>=20.19`) — the ABI is
 * mirrored here as small structural interfaces.
 *
 * This is the same "import-free" discipline `adw_sdlc/src/runners/runner-pi.ts`
 * uses, and it is exactly what the spec's Open Question #6 recommends ("peer +
 * type-only imports — type-checks without the peer"). The shapes below were
 * confirmed against Pi `dist/index.d.ts` / `dist/core/sdk.d.ts` at the pinned
 * version (see `docs/pi-tool-surface-capability.md`) and are re-asserted live by
 * the gated golden e2e (`packages/golden/test/t205-pi-binding.e2e.test.ts`) and
 * the T204 capability smoke, which run against the operator-provided real Pi tree.
 *
 * Nothing here holds or imports a secret, a TypeBox instance, or a Pi instance.
 */

/**
 * A TypeBox schema, opaque at this layer. A real TypeBox `TSchema` is a plain
 * object carrying both JSON-Schema string keys (`type`, `properties`, `enum`, …)
 * and TypeBox `[Kind]` symbol metadata; we never introspect it in this package
 * (the {@link import('./serialize.js')} path serializes only the registry
 * envelope, never the schema), so `unknown` is the honest type.
 */
export type TypeBoxSchema = unknown;

/**
 * The subset of TypeBox's `Type` namespace the §1 converter calls. **Injected**
 * by the host, never imported here — so a single TypeBox runtime (the one Pi
 * bundled) builds every schema, and Pi's `[Kind]`-symbol identity check at
 * registration cannot fail on a split TypeBox copy (the spec's "Pin TypeBox to
 * Pi's major to avoid a split TypeBox runtime").
 */
export interface TypeBoxTypeNamespace {
  /** Closed/open object. `options.additionalProperties` controls strictness; `description` rides options. */
  Object(properties: Record<string, TypeBoxSchema>, options?: Record<string, unknown>): TypeBoxSchema;
  /** Mark a property optional; `Type.Object` derives `required` from the non-optional props. */
  Optional(schema: TypeBoxSchema): TypeBoxSchema;
  String(options?: Record<string, unknown>): TypeBoxSchema;
  Integer(options?: Record<string, unknown>): TypeBoxSchema;
  Number(options?: Record<string, unknown>): TypeBoxSchema;
  Boolean(options?: Record<string, unknown>): TypeBoxSchema;
  Array(items: TypeBoxSchema, options?: Record<string, unknown>): TypeBoxSchema;
}

/**
 * The injected TypeBox builders: the `Type` namespace plus `StringEnum` (from
 * `@earendil-works/pi-ai`). A host resolves these from Pi's own tree — exactly as
 * the T204/T205 e2e does:
 *
 * ```ts
 * import { Type } from 'typebox';                 // Pi's bundled TypeBox
 * import { StringEnum } from '@earendil-works/pi-ai';
 * const builders = { Type, StringEnum };
 * ```
 *
 * `StringEnum(values)` produces the **Google-provider-safe** `{ type: 'string',
 * enum: [...] }` shape (NOT a `Type.Union`/`oneOf` of literals). The optional
 * second `options` arg carries a `description` when present; a `StringEnum`
 * implementation that ignores it merely omits the (cosmetic) description — the
 * fail-closed Ajv preflight, not the TypeBox schema, is the real input gate.
 */
export interface TypeBoxBuilders {
  readonly Type: TypeBoxTypeNamespace;
  readonly StringEnum: (values: readonly string[], options?: Record<string, unknown>) => TypeBoxSchema;
}

/** One block of a Pi {@link AgentToolResult}'s `content` array (we only emit `text`). */
export interface PiToolResultContent {
  readonly type: 'text';
  readonly text: string;
}

/**
 * Pi's tool-result type (`AgentToolResult`). Confirmed shape: a `content` array
 * (model-facing) plus an optional structured `details` channel and an optional
 * `terminate` flag. We populate `content` + `details` with the same verbatim
 * T102 envelope and never set `terminate` (no mx-loom verb ends a Pi turn).
 */
export interface AgentToolResult {
  readonly content: readonly PiToolResultContent[];
  readonly details?: unknown;
  readonly terminate?: boolean;
}

/**
 * Pi's native tool type (`ToolDefinition`). `execute` is the call closure; Pi
 * passes `(toolCallId, params, signal?)` (further trailing args — `onUpdate`/`ctx`
 * in some versions — are ignored by our closure). `parameters` is the converted
 * TypeBox schema; the prompt metadata is generated, non-empty, and names the tool.
 */
export interface ToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines: readonly string[];
  readonly parameters: TypeBoxSchema;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AgentToolResult>;
}

/**
 * The extension-time registration surface (`pi.registerTool` / the extension
 * factory's `api.registerTool`). Structural — any object exposing `registerTool`
 * works, so {@link import('./register.js').registerMxTools} can drive both the
 * top-level `pi` handle and an extension `api`.
 */
export interface PiToolHost {
  registerTool(tool: ToolDefinition): unknown;
}

/**
 * The extension factory Pi invokes at load time
 * (`extensionFactories: [(api) => …]`). Our {@link
 * import('./register.js').createMxPiExtension} returns one of these.
 */
export type PiExtensionFactory = (api: PiToolHost) => void | Promise<void>;
