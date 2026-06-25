# @mx-loom/claude

> Part of the [Runtime integration guide](../../docs/runtime-integration.md#claude-agent-sdk) — the hub with one verified setup per runtime. This README is the canonical Claude-binding deep reference.

The **Claude Agent SDK binding** for mx-loom (`area/claude-binding`).

It ships its first module with **T111 / #19**: a **JSON Schema → Zod converter**.
The Claude Agent SDK's tool-registration helpers — `tool()` and
`createSdkMcpServer()` from `@anthropic-ai/claude-agent-sdk` — take a **Zod**
schema, but the canonical registry (`@mx-loom/registry`, T101) describes every
model-facing `mx_*` verb with a **draft-07 JSON Schema** `input_schema`. This
package converts the one into the other so T110 can register the nine canonical
verbs in-process.

> The MCP binding (T109), Google ADK, and OpenCode all consume JSON Schema
> directly — only the Claude shim needs Zod. So `zod` lives here, in the
> Claude-binding package, and **not** in the representation-neutral
> `@mx-loom/registry`.

**T110 / #18** builds the **in-process shim** on top of this converter: the nine
`mx_*` verbs registered via `createSdkMcpServer()` + `tool()`, the hidden
`mx_await_result` poll loop, and the secret-free `canUseTool` HITL hook. See
[The in-process binding (T110)](#the-in-process-binding-t110) below.

## The in-process binding (T110)

The Claude Agent SDK is the **default mx-agency runner**, and `createSdkMcpServer`
is itself an *in-process MCP server* — so the toolbelt can run **inside** the agent
process with no extra socket, no subprocess, and no stdio framing. T110 is that
shim. It does two things generic MCP cannot:

1. **In-process registration.** The nine `mx_*` verbs are defined with
   `tool()` (Zod schemas from the T111 converter) and wrapped in
   `createSdkMcpServer()` — **generated** by enumerating `CANONICAL_M1_TOOLS`,
   never hand-authored. Adding a tenth descriptor surfaces it with no per-tool edit.
2. **The cleanest HITL hook of the four runtimes.** A `canUseTool` callback
   intercepts `mx_*` calls and presents a **secret-free** approval prompt — and the
   `mx_await_result` poll loop is **hidden**, so a delegated call looks synchronous
   to the model (one tool call → the terminal result).

It **reuses** `@mx-loom/mcp` — `dispatchCall` (the name → registry-handler router),
`createBindingContext`/`BindingContext` (the secret-free daemon/room/audit bundle),
and `serializeToolResult` (`ToolResult` → MCP `CallToolResult`). The Claude shim
adds only what is Claude-specific: the `tool()`/`createSdkMcpServer()` registration,
the hidden poll loop, and the `canUseTool` hook.

### Host usage

The shim is a **library**, not an executable: it produces a `createSdkMcpServer`
config and a `canUseTool` factory; the host (the mx-agency runner) composes them
into its own `query()` call. T110 does not run the model.

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createBindingContext } from '@mx-loom/mcp';
import { createMxToolServer, createMxCanUseTool, mxToolName } from '@mx-loom/claude';

const ctx = await createBindingContext({ /* session / daemon / sessionOptions */ });
const mx = createMxToolServer(ctx);                 // in-process MCP server config
const canUseTool = createMxCanUseTool({             // the HITL hook
  onApprovalRequest: async (summary) => {
    // summary is secret-free: { tool, agent?, command?, args_summary, risk }
    return /* your operator UI / CLI */ 'allow';
  },
});

for await (const msg of query({
  prompt,
  options: {
    mcpServers: { mx },
    canUseTool,
    allowedTools: [mxToolName('mx_delegate_tool'), mxToolName('mx_await_result')],
  },
})) {
  /* … */
}

await ctx.close();
```

### Secret boundary — the shim is secret-free, the HITL hook is a *local gate, not authority*

The shim lives in the adaptation plane and holds **no** secret: it never touches
Matrix tokens, Ed25519 signing keys, provider keys, or `GH_TOKEN`, starts no child
process, and reads no env var. Every daemon call routes through the toolbelt
`MxClient`/`MxSession` on `ctx.daemon`, so the deny-by-default env allowlist,
outbound credential-shaped-arg rejection, and inbound `redactSecrets` all stay in
force, unmodified.

`canUseTool` is a **requester-side local operator gate**, strictly weaker than the
receiving daemon's authority:

- A local **deny** short-circuits *before* the tool dispatches (the request is
  never signed).
- A local **allow** only permits the request to be *signed and dispatched*; the
  receiving daemon still independently enforces trust / `policy.toml` / approval and
  may still return `awaiting_approval` / `policy_denied`. Cognition produces a
  signed *request*; it never grants itself authority. There is **no** model-facing
  approve/deny surface — `onApprovalRequest` is wired to a human, never to the model.

The `ApprovalSummary` is a **non-secret projection** — the verb, the target
agent/command, an arg summary of **key names only** (credential-shaped keys
dropped), and a risk hint. It never renders env, tokens, or raw arg *values*.

### Hidden poll loop + `awaitApproval`

Generic MCP surfaces a deferred `handle` and lets the model re-call
`mx_await_result`; the shim hides that loop (`resolveDeferred`):

- **`ok` / `denied` / `error`** → terminal, returned as-is.
- **`running`** → resolved transparently by polling up to `resolveTimeoutMs`
  (default 60 s, realised as a bounded short-poll cadence); if the budget elapses
  still-`running`, the `running` envelope is returned (no unbounded block, never a
  fabricated `timeout`) and the model can re-poll the still-registered
  `mx_await_result` tool.
- **`awaiting_approval`** → the receiving daemon's *out-of-process* human gate. By
  **default** the envelope is surfaced immediately (handle + secret-free approval)
  so the model fans out other work and resolves later. Opt in with
  `createMxToolServer(ctx, { awaitApproval: true })` to block up to
  `resolveTimeoutMs` for a single blocking call.

### Namespaced tool names + audit

`createSdkMcpServer({ name: 'mx', … })` surfaces each verb to the model as
`mcp__mx__<verb>` (the cosmetic double-`mx` is deliberate). Use `mxToolName(verb)`
to compute the namespaced name for `allowedTools`; the `canUseTool` hook matches it
internally. The shim's result-return point is the single place a T113 `withAudit`
tap is applied **once** (best-effort, `NullAuditSink` by default, independent of the
MCP server's own tap); the live-Postgres path is gated by `MXL_AUDIT_PG=1` and
asserted end-to-end by T114.

## Public API

### T110 — the in-process shim

```ts
import {
  createMxToolServer,   // (ctx, opts?) => McpSdkServerConfigWithInstance
  createMxCanUseTool,   // (opts) => CanUseTool   (the HITL hook)
  wrapCanUseTool,       // (existing, opts) => CanUseTool   (compose with a host hook)
  mxToolName,           // (verb, serverName?) => `mcp__<server>__<verb>`
  resolveDeferred,      // the hidden-poll-loop disposition policy
  type ApprovalSummary,
  type CreateMxToolServerOptions,
  type CreateMxCanUseToolOptions,
} from '@mx-loom/claude';
```

- **`createMxToolServer(ctx, opts?)`** — enumerate `CANONICAL_M1_TOOLS` → `tool()[]`
  → `createSdkMcpServer`. Options: `name` / `version`, `resolveTimeoutMs`,
  `awaitApproval`, `auditTap`. Throws `JsonSchemaConversionError` at build time if a
  descriptor schema drifts outside the T111 subset (fail-closed).
- **`createMxCanUseTool(opts)`** — the `canUseTool` callback. `onApprovalRequest` is
  required; `shouldPrompt` defaults to prompting for `mx_delegate_tool` /
  `mx_run_command` and auto-allowing the read/observe verbs; `serverName` /
  `fallback` configure scope-matching and composition.
- **`wrapCanUseTool(existing, opts)`** — gate `mx_*` here, delegate everything else
  to a host's existing `canUseTool`.

### T111 — the JSON Schema → Zod converter

```ts
import {
  jsonSchemaToZod,         // (schema, opts?) => ZodType
  jsonSchemaToZodRawShape, // (schema, opts?) => ZodRawShape  (the tool() form)
  JsonSchemaConversionError,
  type ConvertOptions,
} from '@mx-loom/claude';
```

- **`jsonSchemaToZod(schema, opts?)`** — convert a (subset) draft-07 JSON Schema
  to an equivalent `ZodType`. Object roots become a **strict** `z.strictObject`
  when `additionalProperties: false`, so client-side parsing rejects unknown keys
  exactly as the JSON Schema does.
- **`jsonSchemaToZodRawShape(schema, opts?)`** — convert an object-rooted schema
  to the `{ key → ZodType }` map (`ZodRawShape`) that
  `tool(name, description, shape, handler)` accepts. Non-`required` fields are
  `.optional()`. Throws if the root is not `type: 'object'`.
- **`ConvertOptions.openObject`** — `'record'` (default) or `'passthrough'`:
  how an **open** object with no `properties` (`additionalProperties: true` /
  absent) is represented. Both accept any object and **reject non-objects**.

## Target: Zod v4

The converter targets **Zod v4** (pinned to the major
`@anthropic-ai/claude-agent-sdk` depends on, `zod@^4.4.3`). It emits v4 idioms:
`z.int()` (not `z.number().int()`), and `z.strictObject` / `z.looseObject`
(not the deprecated `.strict()` / `.passthrough()`).

## Supported subset

The converter covers **exactly** the constructs the nine canonical `mx_*` input
schemas use — not the full JSON-Schema spec.

| JSON Schema node | Zod output |
|---|---|
| `type: 'string'` | `z.string()` |
| `type: 'string'` + `enum: […]` (string members) | `z.enum([…])` |
| `type: 'integer'` (+ `minimum`/`maximum`/exclusive bounds) | `z.int()` + `.gte`/`.lte`/`.gt`/`.lt` |
| `type: 'number'` (+ bounds) | `z.number()` + bounds *(margin: output schemas)* |
| `type: 'boolean'` | `z.boolean()` *(margin: output schemas)* |
| `type: 'array'` + `items: S` | `z.array(convert(S))`; `items` absent → `z.array(z.unknown())` |
| `type: 'object'` with `properties` | `z.strictObject`/`z.looseObject(shape)` per `additionalProperties` |
| `type: 'object'`, no `properties`, open | `z.record(z.string(), z.unknown())` (or `z.looseObject({})`) |
| `description` | `.describe(…)` |

`$schema` and `title` are tolerated and ignored.

### The `additionalProperties` ↔ strictness rule

This is the load-bearing fidelity rule. A plain `z.object({…})` **strips**
unknown keys (parse succeeds, extras silently dropped); JSON Schema
`additionalProperties: false` **rejects** them. They are *not* equivalent.

| `additionalProperties` (object **with** properties) | Zod |
|---|---|
| `false` | `z.strictObject(shape)` — **rejects** extra keys |
| `true` | `z.looseObject(shape)` — passes extra keys |
| absent | `z.looseObject(shape)` — JSON Schema default is `true` |

For an object with **no** properties: `false` → `z.strictObject({})` (accepts
only `{}`); open → `z.record(z.string(), z.unknown())` by default (the open
`args` passthrough of `mx_delegate_tool`). Both open forms reject non-objects
(string/array/number/null), matching `type: object`. `z.any()` / `z.unknown()`
would accept non-objects and are therefore **never** used.

## Fail-closed contract

On any construct outside the supported subset the converter **throws** a typed
`JsonSchemaConversionError(path, keyword)` rather than emitting a permissive
schema that would widen validation. A widened Zod gate would let the model submit
inputs the strict JSON Schema rejects (a correctness **and** a defense-in-depth
security regression — even though the toolbelt's `assertNoCredentialShapedArgs`
and the daemon re-validate at dispatch regardless).

Rejected (non-exhaustive): `oneOf` / `anyOf` / `allOf` / `not`, `$ref` / `$defs`,
`if` / `then` / `else`, `patternProperties`, tuple `items`, union `type`
(`['string','null']`), `type: 'null'`, unknown/missing `type`, schema-valued
`additionalProperties`, and a non-string `enum` member.

`JsonSchemaConversionError` is a **build-/load-time developer error** (like the
registry's `DescriptorValidationError`) — it is not a model-facing `error.code`,
never enters a result envelope, and is not part of the closed error taxonomy. Its
message carries only the JSON-path and the offending keyword — never a value echo.

## Raw shape vs strict object (caveat for T110)

A `ZodRawShape` passed to `tool()` is re-wrapped by the SDK as a *non-strict*
`z.object`, so `additionalProperties: false` strictness (rejecting extra keys) is
**not** enforced at the Claude layer when the shape form is used. That is
acceptable — the toolbelt and the daemon re-validate at dispatch, and the model
rarely emits extras — but a call site wanting client-side strictness should use
`jsonSchemaToZod`, which returns a `.strict()` (`z.strictObject`) schema. T110
picks the form against its pinned `tool()` signature.

## Equivalence (the acceptance criterion)

> **All v1 tool input schemas convert and validate equivalently.**

`test/json-schema-to-zod.equivalence.test.ts` proves it mechanically: for each of
the nine `CANONICAL_M1_TOOLS` input schemas it builds the Zod schema via the
converter and compiles the JSON Schema via the registry's `createAjvValidator()`
— the *same* Ajv seam the loader and the T105 dispatch guard use — then asserts
`ajvValidate(sample) === zodSchema.safeParse(sample).success` across a per-tool
table of representative valid and invalid samples (missing-required, extra-key,
wrong-type, enum-out-of-range, negative-where-`minimum:0`, non-integer, the open
`args` object with nested content, and `args` as a non-object). The two
validators agree on every sample.

## Scope boundary

T111 converts only the nine **canonical (outer)** input schemas. The dynamic
**inner** `args` of `mx_delegate_tool` stay validated **dynamically against the
target agent's published `ToolSchema.input_schema`** by the T105 handler using
the registry's Ajv seam — they are **not** converted to Zod here. Converting
`output_schema`s is not part of the acceptance bar, but the converter covers the
extra output-schema constructs (`boolean`, `number`, nested objects) so output
conversion "just works" for T110.

## Develop

```sh
pnpm --filter @mx-loom/claude test       # vitest (unit + equivalence)
pnpm --filter @mx-loom/claude typecheck  # tsc --noEmit
pnpm --filter @mx-loom/claude build      # tsc -p tsconfig.build.json
```
