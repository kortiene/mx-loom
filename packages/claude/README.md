# @mx-loom/claude

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

T110 (the `tool()` / `createSdkMcpServer()` registration, `canUseTool` HITL
wiring, and the hidden `mx_await_result` poll loop) will build on top of this.

## Public API

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
