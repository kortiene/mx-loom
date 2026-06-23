# T111 · JSON Schema → Zod converter (Claude binding)

> GitHub issue **#19** — `area/claude-binding` `type/chore` `priority/P1` · Estimate **S** · Milestone **M1 — Delegation MVP** · Source: `docs/backlog.md` (`T111`). Blocked-by **#9 (T101)** — the canonical descriptor model, which is **landed** (`@mx-loom/registry`).

## Problem Statement

The canonical tool registry (`@mx-loom/registry`, T101) describes every model-facing `mx_*` verb with a **JSON Schema** `input_schema` (draft-07). That representation is correct for the universal binding: MCP (T109), Google ADK, and OpenCode all consume JSON Schema directly, and the daemon's own `ToolSchema.input_schema` is JSON Schema.

The **Claude Agent SDK in-process shim** (T110) is the exception. Its tool-registration helpers — `tool()` and `createSdkMcpServer()` from `@anthropic-ai/claude-agent-sdk` — take a **Zod** schema (a `ZodRawShape` / `ZodType`), not JSON Schema. So before T110 can register the nine canonical verbs in-process, each descriptor's JSON Schema must be converted to an equivalent Zod schema.

There is currently **no converter**. The registry index and README already name "the JSON Schema → Zod converter (T111)" as a planned reader of the descriptor set, but no module, no package, and no Zod dependency exist in the shipped mx-loom packages today (`zod` appears only in the unrelated `adw_sdlc` build harness). T111 fills exactly that gap, and **only** that gap: a small, pure, well-tested converter covering the JSON Schema subset the canonical input schemas actually use — not general JSON-Schema-spec coverage.

The acceptance bar is *equivalence*, not mere "it produces a Zod object": **all v1 tool input schemas must convert and validate equivalently** — i.e., for every representative input, the generated Zod schema accepts/rejects exactly what the original JSON Schema (validated by the registry's Ajv seam) accepts/rejects. A converter that silently widens validation (e.g. emitting `z.any()` for an unrecognized construct, or dropping `additionalProperties: false`) would weaken the model's input surface and is a correctness **and** security regression.

## Goals

- Provide a pure, synchronous, dependency-light function — `jsonSchemaToZod(schema) → ZodType` — that converts a draft-07 JSON Schema (the subset used by the canonical `mx_*` `input_schema`s) into an equivalent Zod schema.
- Provide a companion `jsonSchemaToZodRawShape(schema) → ZodRawShape` (the `properties`-map form `tool()` accepts) for the object-rooted descriptors, since every canonical `input_schema` has `type: 'object'` at the root.
- Cover, faithfully, the **exact** JSON Schema subset the nine canonical input schemas use (enumerated in *Proposed Implementation*): `object` (closed via `additionalProperties: false`, open via `additionalProperties: true`), `string` (+ `enum`), `integer` (+ `minimum`), `array` (+ `items`), `required`/optional handling, and `description` propagation.
- **Fail closed:** on any unsupported construct or unknown `type`, throw a typed `JsonSchemaConversionError` that names the JSON-path and the offending keyword — never silently emit a permissive `z.any()`/`z.unknown()` that would widen validation.
- Prove the acceptance criterion mechanically: for each of the nine `CANONICAL_M1_TOOLS` input schemas, assert the generated Zod schema and the registry's Ajv validator agree (accept/reject) across a table of representative valid and invalid inputs.
- Keep the converter a stand-alone, independently testable unit that T110 consumes, with `@mx-loom/registry` as the source of the descriptors (and their schemas as the canonical test fixtures).

## Non-Goals

- **Full JSON-Schema spec coverage.** No `oneOf`/`anyOf`/`allOf`/`not`, `$ref`/`$defs`, `if/then/else`, `patternProperties`, tuple `items`, `dependentSchemas`, `const`, format-driven refinements, etc. These do not appear in any canonical input schema; the converter rejects them (fail-closed) rather than half-supporting them.
- **A general daemon-schema converter.** `mx_delegate_tool`'s *inner* `args` are validated **dynamically against the target agent's published `ToolSchema.input_schema`** by the T105 handler using the registry's Ajv seam. That path stays Ajv-validated; T111 does **not** convert arbitrary target tool schemas to Zod. Its required scope is the nine *canonical* (outer) input schemas only.
- **The reverse direction (Zod → JSON Schema).** Not needed here; the Claude SDK's `tool()` already round-trips the Zod schema back to JSON Schema internally to advertise the tool to the model (Zod v4 has native `z.toJSONSchema`). T111 is forward-only.
- **The Claude binding itself (T110)** — `tool()`/`createSdkMcpServer()` registration, `canUseTool` HITL wiring, hiding the `mx_await_result` poll loop. T111 only supplies the converter T110 will call.
- **Converting `output_schema`** is **not required** by the AC (which names input schemas). The converter is general enough to also cover the output-schema constructs (nested objects, `boolean`, `number`), and doing so cheaply de-risks T110, but it is an *optional* extension, not part of the T111 acceptance bar.
- **Runtime/transport behavior, secrets, daemon RPC.** The converter is an offline, build-time transformation of static, public, secret-free descriptors. It performs no I/O.

## Relevant Repository Context

**Stack & status.** TypeScript, pnpm workspace (`pnpm@9.12.0`), Node ≥ 20.19, vitest, Apache-2.0, ESM (`"type": "module"`, `nodenext` resolution, `verbatimModuleSyntax`). `pnpm-workspace.yaml` globs `packages/*` (plus `adw_sdlc`), so a new package under `packages/` is picked up automatically. Unlike the "docs-only" baseline, M0 + most of M1 are **implemented**: `packages/toolbelt` (`@mx-loom/toolbelt`) and `packages/registry` (`@mx-loom/registry`) exist with full source and tests.

**What exists and is relevant:**

- **`@mx-loom/registry` (T101–T108, landed).** The source T111 reads:
  - `src/descriptor.ts` — `ToolDescriptor { name, description, input_schema, output_schema, async_semantics }`; `JsonSchema = Record<string, unknown>`.
  - `src/descriptors/*.ts` — the **nine** canonical descriptors; `CANONICAL_M1_TOOLS` (exported from `src/index.ts`) is the frozen, ordered set. These are the converter's required inputs and its test fixtures.
  - `src/validator.ts` — the `SchemaValidator` seam and `createAjvValidator()` (Ajv, `strict: false`, draft-07). `JSON_SCHEMA_DIALECT = 'http://json-schema.org/draft-07/schema#'`. **Reuse this as the equivalence oracle** in tests, so T111 is proven equivalent to the *same* validator the loader and the T105 dispatch guard use.
  - `src/security.ts` — `CREDENTIAL_KEY_RE`, `findCredentialShapedProperty`; the registry already guarantees no canonical `input_schema` declares a credential-shaped property name. The converter does not need to re-enforce this, but must not *defeat* it by widening.
- **`@mx-loom/toolbelt` (T002–T008, landed).** `src/guards.ts` exports `assertNoCredentialShapedArgs` (the authoritative runtime credential-rejection guard at dispatch) and `redactSecrets`. These are the *real* secret boundary; the converter is upstream of them and is **not** itself a secret boundary.

**What does NOT exist yet (decisions to confirm, flagged below):**

- **No Claude binding package.** There is no `@mx-loom/claude` (T110). T111 needs a *home* for the converter and its `zod` dependency. The recommendation (see *Risks*) is to bootstrap that package now with the converter as its first module.
- **No `zod` dependency** in any shipped mx-loom package. `zod@^4.4.3` and `@anthropic-ai/claude-agent-sdk@^0.3.170` are present only in `adw_sdlc` (the build harness), which is evidence of the intended versions but is **not** a shared dependency T111 can assume.
- **No JSON-Schema↔Zod library** is vendored. `adw_sdlc/src/schemas.ts` notes Zod v4's *native* `toJSONSchema` makes a zod-to-json dep unnecessary — but that is the reverse direction; the forward direction (JSON Schema → Zod) has no native helper and is what T111 builds.

**The exact JSON Schema subset in the canonical input schemas** (the converter's required coverage), read from `src/descriptors/*`:

| Descriptor | Input-schema constructs used |
|---|---|
| `mx_find_agents` | `object` (`additionalProperties:false`, **no** `required`); `string`; `string`+`enum` (`active`/`stale`/`offline`) |
| `mx_describe_agent` | `object`(closed); `string`; `required` |
| `mx_delegate_tool` | `object`(closed); `string`; **open `object`** (`additionalProperties:true`, no `properties` — the `args` passthrough); `integer`+`minimum:0`; `required` |
| `mx_run_command` | `object`(closed); `string`; `array` `items:{string}`; `integer`+`minimum:0`; `required` |
| `mx_await_result` | `object`(closed); `string`; `integer`+`minimum:0`; `required` |
| `mx_share_context` | `object`(closed); `string`; `string`+`enum` (×2: `file/diff/env`, `utf-8/base64`); `required` |
| `mx_get_context` | `object`(closed); `string`; `required` |
| `mx_cancel` | `object`(closed); `string`; `required` |
| `mx_workspace_status` | `object`(closed, **no `properties`**) |

Plus universal annotations the converter must tolerate/propagate: `$schema`, `title` (ignored), `description` (→ `.describe()`). **Nested objects with their own `properties` do not appear in any input schema** (only in output schemas), so they are an optional-margin construct, not required by the AC.

## Proposed Implementation

### Package home (recommended)

Create **`packages/claude` → `@mx-loom/claude`** (the Claude binding package T110 will flesh out) and land the converter as its first module:

```
packages/claude/
  package.json            # name @mx-loom/claude; deps: zod (pinned to the SDK's major)
  tsconfig.json           # copy registry's (ES2022, nodenext, strict, noEmit)
  tsconfig.build.json
  vitest.config.ts        # plain unit config (copy registry's — no daemon/env gating)
  src/
    json-schema-to-zod.ts # the converter + JsonSchemaConversionError
    index.ts              # re-export the converter (T110 adds the binding later)
  test/
    json-schema-to-zod.test.ts        # per-construct unit tests + fail-closed
    json-schema-to-zod.equivalence.test.ts  # the AC: Ajv ↔ Zod agreement over the 9 schemas
  README.md
```

Rationale: zod is a *Claude-binding* representation (ADK/OpenCode/MCP all consume JSON Schema directly), so it must **not** be added to the representation-neutral `@mx-loom/registry`. The label is `area/claude-binding`. The converter's sole consumer is T110, so a dedicated micro-package is unwarranted; bootstrapping `@mx-loom/claude` now and having T110 build on it keeps the package count down and matches the dependency direction (T110 blocked-by T111). `@mx-loom/registry` is a **dev** dependency (fixtures + the Ajv oracle); the converter's *runtime* dependency is only `zod`. (Alternative homes — a standalone leaf `@mx-loom/json-schema-zod`, or inside `@mx-loom/registry` — are discussed in *Risks*; the package is new either way, so its creation is a decision to confirm.)

### Public API

```ts
// @mx-loom/claude — src/json-schema-to-zod.ts
import { z } from 'zod';
import type { ZodType, ZodRawShape } from 'zod';

/** Thrown when a schema uses a construct outside the supported subset. Fail-closed. */
export class JsonSchemaConversionError extends Error {
  readonly path: string;     // JSON-path of the offending node, e.g. "#/properties/args"
  readonly keyword: string;  // the unsupported keyword/type, e.g. "oneOf" | "type:null"
  constructor(path: string, keyword: string, detail?: string);
}

export interface ConvertOptions {
  /**
   * How an OPEN object (additionalProperties:true / absent) with no `properties`
   * is represented. 'record' → z.record(z.string(), z.unknown()); 'passthrough'
   * → z.object({}).passthrough() (v3) / z.looseObject({}) (v4). Both accept any
   * object and REJECT non-objects (matching JSON Schema `type:object`). Default 'record'.
   */
  openObject?: 'record' | 'passthrough';
}

/** Convert a (subset) JSON Schema document to an equivalent Zod schema. */
export function jsonSchemaToZod(schema: Record<string, unknown>, opts?: ConvertOptions): ZodType;

/**
 * Convert an object-rooted JSON Schema to the `properties`-map form `tool()` wants.
 * Throws if the root is not `type:object`. Optional fields are `.optional()`.
 */
export function jsonSchemaToZodRawShape(schema: Record<string, unknown>, opts?: ConvertOptions): ZodRawShape;
```

### Conversion algorithm (a single recursive `convert(node, path, opts)`)

Switch on `node.type` (a string in the subset). Carry a `path` for error messages. Apply `.describe(node.description)` last if `description` is a non-empty string.

| JSON Schema node | Zod output |
|---|---|
| `type:'string'` (no `enum`) | `z.string()` |
| `type:'string'` + `enum:[…]` (all strings) | `z.enum([…])` (non-string enum member → `JsonSchemaConversionError`) |
| `type:'integer'` | `z.number().int()` (zod v4: `z.int()`); `minimum`→`.gte(n)`, `maximum`→`.lte(n)`, exclusive bounds → `.gt`/`.lt` |
| `type:'number'` | `z.number()` (+ bounds as above) — *margin (output schemas), not in inputs* |
| `type:'boolean'` | `z.boolean()` — *margin (output schemas), not in inputs* |
| `type:'array'` + `items:S` | `z.array(convert(S))`; `items` absent → `z.array(z.unknown())` |
| `type:'object'` with `properties` | build a shape: each `[k,sub]` → `convert(sub)`, then `.optional()` if `k ∉ required`; wrap in `z.object(shape)`; then apply `additionalProperties` (below) |
| `type:'object'`, no `properties`, `additionalProperties:true`/absent | open object per `opts.openObject` (default `z.record(z.string(), z.unknown())`) |
| `additionalProperties:false` (on an object with properties) | `.strict()` |
| `additionalProperties:true` (on an object with properties) | `.passthrough()` |
| `additionalProperties` absent (object with properties) | **JSON Schema default is `true`** → `.passthrough()` (preserve equivalence) |

**Fail-closed cases — throw `JsonSchemaConversionError`:** unknown/missing `type` with no recognizable handler; `type` as an array (`['string','null']` union); `additionalProperties` as a *schema object* (subset uses booleans only — schema-valued is out of scope; or, as a cheap opt-in, `.catchall(convert(ap))`); and any unsupported keyword present (`oneOf`, `anyOf`, `allOf`, `not`, `$ref`, `$defs`, `if`, `patternProperties`, tuple `items`). The error names the `path` and `keyword`. **Never** fall through to `z.any()`.

**The single most important fidelity rule — `additionalProperties` ↔ object strictness:**
- Zod's default `z.object({…})` **strips** unknown keys (parse *succeeds*, extras silently dropped). JSON Schema `additionalProperties:false` **rejects** unknown keys. They are NOT equivalent. The converter MUST emit `.strict()` for `additionalProperties:false` so extras are rejected, exactly matching the JSON Schema. Mishandling this is the difference between passing and failing the equivalence test (and silently widening the model's input surface).
- The open `args` object (`additionalProperties:true`, no `properties`) must accept arbitrary object content but still **reject non-objects** (JSON Schema `type:object` rejects a string/array/number). `z.record(z.string(), z.unknown())` and `z.looseObject({})` both satisfy this; `z.any()`/`z.unknown()` do **not** (they accept non-objects) and are wrong.

### Output form for `tool()`

Every canonical `input_schema` is object-rooted, so `jsonSchemaToZodRawShape` returns the `Record<string, ZodType>` of (optional-aware) property converters — the form `tool(name, description, shape, handler)` accepts. **Caveat to surface to T110:** a raw shape passed to `tool()` is re-wrapped by the SDK as a *non-strict* `z.object`, so `additionalProperties:false` strictness (rejecting extra keys) is **not** enforced at the Claude layer when the shape form is used. That is acceptable because (a) the toolbelt's `assertNoCredentialShapedArgs` + the daemon re-validate at dispatch, and (b) the model rarely emits extras — but it should be **documented**, and `jsonSchemaToZod` (which *can* return a `.strict()` `z.object`) is offered as the alternative for any call site that wants client-side strictness. T110 picks the form based on what its pinned `tool()` accepts.

### Determinism & purity

Pure function of its input; no `Date`/random/I/O. Converting the same schema twice yields a structurally identical Zod schema. This keeps the converter trivially testable and side-effect-free.

## Affected Files / Packages / Modules

**New (recommended `@mx-loom/claude` home):**
- `packages/claude/package.json` — `name: "@mx-loom/claude"`, `private: true`, `type: module`, `engines.node >=20.19`, runtime dep `zod` (pinned to the SDK's major — see *Risks #2*), dev deps `@mx-loom/registry` (`workspace:*`), `ajv` (the equivalence oracle; or import it transitively via the registry's `createAjvValidator`), `vitest`, `typescript`, `@types/node`.
- `packages/claude/tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts` — copied from `packages/registry` (same compiler + plain-unit vitest config).
- `packages/claude/src/json-schema-to-zod.ts` — the converter + `JsonSchemaConversionError` + `ConvertOptions`.
- `packages/claude/src/index.ts` — re-export the converter (T110 extends).
- `packages/claude/test/json-schema-to-zod.test.ts` — per-construct + fail-closed unit tests.
- `packages/claude/test/json-schema-to-zod.equivalence.test.ts` — the AC: Ajv↔Zod agreement over `CANONICAL_M1_TOOLS`.
- `packages/claude/README.md` — documents the supported subset + the fail-closed contract + the strictness caveat.

**Read (not modified):**
- `packages/registry/src/descriptors/*.ts`, `packages/registry/src/index.ts` (`CANONICAL_M1_TOOLS`) — fixtures.
- `packages/registry/src/validator.ts` (`createAjvValidator`, `JSON_SCHEMA_DIALECT`) — the test oracle.
- `packages/registry/src/descriptor.ts` (`ToolDescriptor`, `JsonSchema`).

**Possibly touched (workspace plumbing):**
- `pnpm-workspace.yaml` — already globs `packages/*`; no edit needed (confirm).
- Root `tsconfig`/CI references if the repo maintains an explicit project-reference list (verify; the existing packages suggest per-package configs, so likely none).

## API / Interface Changes

**New public API (in `@mx-loom/claude`):** `jsonSchemaToZod()`, `jsonSchemaToZodRawShape()`, `JsonSchemaConversionError`, `ConvertOptions`. These are a **library API**, internal to the binding layer and consumed by T110.

**No** changes to: command-line surface, the daemon JSON-RPC surface (Boundary B), the tool descriptors themselves (the canonical JSON Schemas are unchanged — only *read*), the result envelope, or the MCP tool surface. The converter is additive build-time tooling.

## Data Model / Protocol Changes

**None.** The result envelope (`{status, result, error, handle, approval, audit_ref}`), the closed nine-code error taxonomy, the `idempotency_key` contract, audit rows, and all wire serializations are untouched. `JsonSchemaConversionError` is a **load-/build-time** developer error (like `DescriptorValidationError`), **not** a model-facing `error.code` — it never enters an envelope and is not part of the taxonomy. The converter reads the existing `ToolDescriptor.input_schema` and produces an in-memory Zod schema; no persisted or wire shape changes.

## Security & Compliance Considerations

- **Not a secret boundary, but must not widen one.** The converter transforms *static, public, secret-free* descriptors offline at build time. No Matrix token, Ed25519 signing key, provider key, or `GH_TOKEN` is anywhere near it; it crosses no boundary, spawns no child, reads no env. The authoritative secret rejection stays where it already is: the toolbelt's `assertNoCredentialShapedArgs` at dispatch (Boundary A chokepoint, T008/T105) and the daemon's out-of-process enforcement (Ed25519 trust store + deny-by-default `policy.toml` + sandbox + approval gates). The converter is strictly *upstream* of those.
- **Fidelity is the security property.** A permissive conversion (`z.any()` on an unknown construct, dropping `additionalProperties:false`, or treating the open `args` object as `z.any()`) would *widen* the input surface the model can submit through the Claude binding — potentially admitting an extra, credential-shaped property that the strict JSON Schema would have rejected. Fail-closed conversion + faithful strictness keep the Zod gate exactly as tight as the canonical JSON Schema. (Even so, a widened Zod gate would not breach the secret boundary — the dispatch-time `assertNoCredentialShapedArgs` still rejects credential-shaped args — but defense-in-depth and equivalence both demand fidelity.)
- **No authority surface.** The converter operates only on the nine model-facing verbs already in the no-authority allowlist (`MODEL_FACING_ALLOWLIST`); it neither adds tools nor grants capability. Cognition still only ever produces a signed request; nothing here changes that. The model is never given trust/policy/approval-mutation tools, and the converter cannot introduce one (it converts existing descriptors, it does not author them).
- **Secret-free contract preserved.** The registry already guarantees no canonical `input_schema` declares a credential-shaped property name (`findCredentialShapedProperty`); the converter preserves property names verbatim and adds none, so the converted Zod shape stays secret-free by construction. The converter rejects no inbound credentials itself — that is not its job and not its boundary.
- **Logging / redaction.** The converter logs nothing. `JsonSchemaConversionError` messages carry only the JSON-path and the offending keyword — never an arbitrary value echo (and the descriptors are secret-free regardless). Follow the repo convention: never log or persist secrets; errors name a path/keyword, not a payload.
- **Audit correlation:** N/A — the converter produces no tool result, hence no `audit_ref`. It is a pure transformation, not an invocation.

## Testing Plan

All vitest unit tests (no daemon, no socket, no env gating — copy `packages/registry/vitest.config.ts`).

1. **Per-construct unit tests** (`json-schema-to-zod.test.ts`):
   - `string` → `z.string()`; `string`+`enum` → `z.enum` (accepts members, rejects non-members); a non-string enum member throws.
   - `integer` → rejects non-integers/floats and accepts integers; `minimum:0` rejects `-1`, accepts `0`.
   - `array` `items:{string}` → accepts `["a"]`, rejects `[1]` and non-arrays.
   - `object` closed (`additionalProperties:false`) → **rejects an unknown extra key** (the strictness assertion); open (`additionalProperties:true`, no properties) → accepts arbitrary object content, **rejects a non-object** (string/array/number/null).
   - `required` vs optional: a field absent from `required` parses when omitted; a `required` field missing → reject.
   - `description` propagates to `.describe()` (assert via the schema's metadata / a Zod v4 `z.toJSONSchema` round-trip).
   - **Margin constructs** (`boolean`, `number`, nested `object` with `properties`) convert correctly even though no input schema uses them (de-risks output-schema conversion / T110).
2. **Fail-closed tests:** each unsupported construct (`oneOf`/`anyOf`/`allOf`/`not`, `$ref`, `if/then/else`, `patternProperties`, tuple-`items`, `type:['string','null']`, unknown/missing `type`, schema-valued `additionalProperties`) throws `JsonSchemaConversionError` with the right `path`/`keyword` — explicitly assert it **throws rather than** producing a permissive schema.
3. **Equivalence tests — the acceptance criterion** (`json-schema-to-zod.equivalence.test.ts`): iterate `CANONICAL_M1_TOOLS`; for each `input_schema`, build the Zod schema via the converter and compile the JSON Schema via the registry's `createAjvValidator()`. For a per-descriptor table of representative samples (valid baseline; missing-required; extra-key; wrong-type; enum out-of-range; negative-where-`minimum:0`; non-integer-for-integer; the open-`args` object with nested arbitrary content; `args` as a non-object), assert `ajvValidate(sample) === zodSchema.safeParse(sample).success`. The two validators must agree on **every** sample. This is the literal "all v1 tool input schemas convert and validate equivalently."
4. **Property-preservation test:** for each object-rooted schema, assert the converted shape's keys exactly equal the JSON Schema `properties` keys (no field added or dropped — the converter cannot silently widen or narrow the field set).
5. **`jsonSchemaToZodRawShape` tests:** returns the `properties`-map form; optional fields are `.optional()`; throws on a non-object root.
6. **Determinism test:** converting the same schema twice yields structurally equal output (sanity for purity; supports future round-trip diffing).
7. **(Optional) round-trip fidelity:** convert JSON Schema → Zod → `z.toJSONSchema` (Zod v4 native) and diff against the original for the supported subset, to catch fidelity regressions; secondary to the Ajv-equivalence test.
8. **Documentation test (lightweight):** the README's supported-subset table stays in sync with the converter (or a test enumerates supported `type`s so drift is visible).

No integration/e2e/conformance/idempotency/secret-boundary suites are added by T111 — the converter is offline, secret-free, and stateless. (The Claude binding's e2e lands with T110/T114.)

## Documentation Updates

- **`packages/claude/README.md`** (new) — document the supported JSON Schema subset (the table above), the fail-closed contract, the `additionalProperties` ↔ strictness rule, the raw-shape-vs-strict-object trade-off, and the public API.
- **`docs/backlog.md`** — mark `T111` status (analogous to the landed-status notes on T101–T108): converter delivered in `@mx-loom/claude`, scope = the nine canonical input schemas, equivalence proven against the registry's Ajv seam, fail-closed on unsupported constructs. Note T110 remains blocked only on its own work now.
- **`docs/mx-agent-tool-fabric-design.md`** — light touch: §3's Claude-SDK bullet already references "the JSON Schema → Zod converter (T111)"; update the parenthetical to record it as **landed** (with its package home) once implemented. No architectural change.
- **`@mx-loom/registry` README/index comments** — already name T111 as a reader; optionally update to point at the concrete `@mx-loom/claude` converter module once it exists. Optional.

## Risks and Open Questions

1. **Package home (decision to confirm).** No `@mx-loom/claude` exists yet. Recommendation: **bootstrap `@mx-loom/claude` now** with the converter as its first module (label is `area/claude-binding`; zod is Claude-specific; T110 builds on it). Alternatives: a standalone leaf `@mx-loom/json-schema-zod` (justified only if a non-Claude binding will ever want Zod — none is planned, since ADK/OpenCode/MCP/Pi consume JSON Schema), or inside `@mx-loom/registry` (**rejected** — pollutes the representation-neutral core with a binding-specific zod dep). Confirm before creating the package.
2. **Zod major version + SDK compatibility (real risk).** The repo's `adw_sdlc` uses `zod@^4.4.3` and `@anthropic-ai/claude-agent-sdk@^0.3.170`, but those are not shared deps. `tool()` type-checks the schema against the zod version the **SDK** resolves; mixing zod majors between the converter and the SDK's expected zod can break `instanceof`/type compatibility. **Pin the converter's `zod` to the major `@anthropic-ai/claude-agent-sdk` (T110) depends on** (confirm v3 vs v4 against the pinned SDK), and prefer a single hoisted zod in the workspace. v4 vs v3 also changes a few call sites (`z.int()` vs `z.number().int()`; `z.looseObject`/`z.strictObject` vs `.passthrough()`/`.strict()`) — the converter should target one and document it.
3. **Output form for `tool()` (`ZodRawShape` vs strict `z.object`).** `tool()` accepts a raw shape and re-wraps it non-strict, so `additionalProperties:false` strictness is not enforced client-side via the shape form. Recommendation: provide both `jsonSchemaToZodRawShape` (for `tool()`) and `jsonSchemaToZod` (a `.strict()` `z.object` for any call site wanting client-side strictness); document the trade-off; let T110 choose against its pinned `tool()` signature. The daemon + dispatch guard re-validate regardless, so the gap is defense-in-depth, not a security hole.
4. **Open-object representation for `args`.** `additionalProperties:true` with no `properties` must accept any object yet reject non-objects (matching `type:object`). `z.record(z.string(), z.unknown())` (default) and `z.looseObject({})` both satisfy this; `z.any()`/`z.unknown()` are **wrong** (they accept non-objects). Confirm the chosen representation passes the `args`-is-a-non-object rejection sample in the equivalence table.
5. **Is the converter even necessary, or does `tool()` accept JSON Schema directly?** The design pins Claude `tool()` to Zod, and `createSdkMcpServer` advertises via an internal Zod→JSON-Schema round-trip. Confirm against the **pinned** `@anthropic-ai/claude-agent-sdk` that `tool()` requires Zod (it does as of the referenced versions). If a future SDK accepts JSON Schema natively, T111 could be slimmed — low risk; proceed as specified.
6. **Equivalence oracle choice.** Recommend the registry's `createAjvValidator()` (the *same* validator the loader and T105 dispatch use) as the test oracle, so "validate equivalently" is proven against the authoritative validator, not a second independent one. Confirm Ajv is reachable from the test (transitively via `@mx-loom/registry` dev-dep, or add `ajv` as a dev-dep of `@mx-loom/claude`).
7. **Scope of converted schemas.** AC = the **nine canonical input schemas**. The dynamic *inner* `args` of `mx_delegate_tool` stay Ajv-validated by T105 (the target's published schema), **not** converted to Zod. Keep that boundary explicit so the converter is not over-built into a general daemon-schema converter.
8. **Optional output-schema coverage.** Not required by the AC, but cheap (the converter already needs `object`/`string`/`integer`/`array`/`enum`; output schemas add `boolean`, `number`, nested objects — all margin constructs the implementation should cover anyway). Decide whether to ship output conversion in T111 or defer to T110; recommend covering the constructs (so output conversion "just works") without making output-equivalence a T111 acceptance gate.

## Implementation Checklist

1. **Confirm decisions** (Risks #1, #2, #3, #5): package home (`@mx-loom/claude` recommended), zod major (match the pinned `@anthropic-ai/claude-agent-sdk`), output form, and that `tool()` requires Zod.
2. **Scaffold `packages/claude`**: `package.json` (`@mx-loom/claude`, `private`, ESM, `engines.node >=20.19`, runtime dep `zod@<pinned>`, dev deps `@mx-loom/registry` `workspace:*`, `vitest`, `typescript`, `@types/node`, and `ajv` if not transitively available), `tsconfig.json` + `tsconfig.build.json` + `vitest.config.ts` copied from `packages/registry`. `pnpm install`.
3. **Implement `src/json-schema-to-zod.ts`**: `JsonSchemaConversionError` (with `path`, `keyword`); the recursive `convert(node, path, opts)` per the conversion table; `jsonSchemaToZod()` and `jsonSchemaToZodRawShape()`; `ConvertOptions` (`openObject`). Apply `.describe()` for `description`. **Fail-closed** on every unsupported construct/type — never emit `z.any()`.
4. **Get strictness right**: `additionalProperties:false` → `.strict()`; `additionalProperties:true`/absent (with properties) → `.passthrough()`; open object (no properties) → `z.record(z.string(), z.unknown())` (or per `opts`). These are the equivalence-critical rules.
5. **Export** the public API from `src/index.ts`.
6. **Write per-construct + fail-closed unit tests** (`json-schema-to-zod.test.ts`), including the strictness, open-object-rejects-non-object, optional/required, and enum cases, and the throws-not-widens assertions.
7. **Write the equivalence test** (`json-schema-to-zod.equivalence.test.ts`): iterate `CANONICAL_M1_TOOLS`; for each input schema, assert `createAjvValidator()` and the converted Zod schema agree (accept/reject) across the representative valid+invalid sample table. This is the AC.
8. **Add the property-preservation, raw-shape, and determinism tests.**
9. **Run** `pnpm --filter @mx-loom/claude test`, `typecheck`, and `build`; ensure the workspace lint/CI passes.
10. **Write `packages/claude/README.md`**: supported subset table, fail-closed contract, strictness rule, raw-shape-vs-strict trade-off, public API.
11. **Update `docs/backlog.md`** (`T111` status) and the `docs/mx-agent-tool-fabric-design.md` §3 parenthetical (converter landed + home). Optionally update the `@mx-loom/registry` index/README pointer.
12. **Confirm AC:** all nine v1 tool input schemas convert and validate equivalently (the equivalence suite is green); unsupported constructs fail closed.
