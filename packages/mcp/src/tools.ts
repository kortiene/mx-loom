/**
 * The tool generator (T109) — canonical descriptors → MCP `tools/list`.
 *
 * AC1 + the "one generation path" goal: enumerate {@link CANONICAL_M1_TOOLS} and
 * produce the MCP {@link Tool}[] for `tools/list`. Each MCP tool's `inputSchema`
 * is the descriptor's draft-07 JSON Schema **passed through verbatim** — exactly
 * what MCP's `inputSchema` field expects. There is **no** per-tool special-casing:
 * adding a tenth descriptor to `CANONICAL_M1_TOOLS` surfaces it over MCP with no
 * edit here.
 *
 * The advertised `outputSchema` is the **T102 {@link ENVELOPE_SCHEMA}**, NOT the
 * descriptor's bare-result `output_schema`. A conformant MCP client (the SDK
 * 1.29.0 client among them) caches each tool's `outputSchema` at `tools/list` and
 * validates every `tools/call`'s `structuredContent` against it. The serializer
 * always puts the **full** T102 envelope (`{ status, result, error, handle,
 * approval, audit_ref }`) into `structuredContent` — so the schema that describes
 * that wire shape is the envelope schema, not the bare result. Advertising the
 * bare-result schema instead made a conformant client reject the envelope for
 * every verb whose result is not an open object (e.g. `mx_workspace_status`'s
 * `required: ['agents']`) with `-32602`. The descriptor's `output_schema` still
 * documents the success `result` payload and is reachable via the registry; it is
 * just not the `structuredContent` contract (the spec's OQ#4 resolution; design §4.5).
 *
 * This verbatim pass-through is the reason T109 uses the SDK's low-level `Server`
 * (`setRequestHandler(ListToolsRequestSchema, …)`) rather than the high-level
 * `McpServer.registerTool`, which is Zod-first and would force a lossy
 * JSON Schema → Zod → JSON Schema round-trip. The registry's JSON Schema stays the
 * single source of truth (the T111 Zod converter is for the Claude SDK only and is
 * NOT used here).
 *
 * Annotations are advisory metadata only — **never** an enforcement signal. They
 * are derived uniformly from the descriptor's `async_semantics` (the one piece of
 * semantics a runtime cannot skip), not hand-set per tool: `openWorldHint` is true
 * (every verb reaches a remote mesh), and the authoritative async hint —
 * "this tool may return a deferred handle resolved via `mx_await_result`" — is
 * mirrored honestly into `_meta` so a runtime that keys on it does not have to
 * re-derive it.
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { CANONICAL_M1_TOOLS, ENVELOPE_SCHEMA } from '@mx-loom/registry';
import type { ToolDescriptor } from '@mx-loom/registry';

/** The `_meta` key carrying the descriptor's `async_semantics` (`sync`|`deferred`). */
export const ASYNC_SEMANTICS_META_KEY = 'io.mxloom/async_semantics';

/**
 * Generate the MCP tool list from the canonical registry. Defaults to
 * {@link CANONICAL_M1_TOOLS}; takes an explicit descriptor set only for tests.
 *
 * The returned `inputSchema` is the descriptor's own JSON Schema object (frozen) —
 * passed through by reference, never cloned or mutated — so a client lists exactly
 * what the registry declares (AC1, deep-equal). The `outputSchema` is the shared
 * T102 {@link ENVELOPE_SCHEMA} (the same frozen reference on every tool): the wire
 * shape of `structuredContent` is the envelope, so that is what a client validates.
 */
export function buildToolList(descriptors: readonly ToolDescriptor[] = CANONICAL_M1_TOOLS): Tool[] {
  return descriptors.map(toMcpTool);
}

/** Map one canonical descriptor onto an MCP {@link Tool} — verbatim schemas + honest hints. */
function toMcpTool(descriptor: ToolDescriptor): Tool {
  return {
    name: descriptor.name,
    description: descriptor.description,
    // `inputSchema`: verbatim pass-through. The descriptor's `input_schema` is
    // already a draft-07 `{ type: "object", … }` document; the cast only bridges
    // the registry's opaque `JsonSchema` (`Record<string, unknown>`) to MCP's
    // structurally-narrower object-schema type. No reshaping happens.
    inputSchema: descriptor.input_schema as unknown as Tool['inputSchema'],
    // `outputSchema`: the T102 envelope schema — the actual shape of the
    // `structuredContent` the serializer returns — NOT the descriptor's
    // bare-result `output_schema` (which would make a conformant client reject the
    // envelope). See the module header. Same frozen reference for every tool.
    outputSchema: ENVELOPE_SCHEMA as unknown as Tool['outputSchema'],
    annotations: {
      // Every verb acts on (or reads from) a remote agent mesh — never a closed
      // world. We deliberately do NOT claim `readOnlyHint` for any verb: several
      // are mutating, and an honest advisory must not under-state side effects.
      openWorldHint: true,
    },
    // The authoritative deferred-vs-sync signal, surfaced honestly so a runtime
    // (ADK's LongRunningFunctionTool, the Claude shim's hidden poll loop, a
    // generic MCP client) can react without re-deriving it. Advisory, not policy.
    _meta: { [ASYNC_SEMANTICS_META_KEY]: descriptor.async_semantics },
  };
}
