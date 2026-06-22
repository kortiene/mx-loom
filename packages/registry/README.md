# @mx-loom/registry

The **canonical tool registry** for mx-loom (T101 / #9): one transport-neutral,
secret-free set of `mx_*` tool descriptors plus a fail-fast loader/validator.

> One canonical descriptor set feeds **both** a generated MCP server *and*
> generated native shims (Claude, later ADK/OpenCode/Pi) — never hand-author
> tools per runtime (design §3, §9). This package is that single source.

It is **pure metadata + a validator**: no tool behavior, no daemon RPC mapping,
no result envelope. The discovery/delegation handlers (T104–T108), the MCP
binding (T109), the Claude shim (T110), and the JSON Schema → Zod converter
(T111) all *read* descriptors from here.

## The descriptor model

```ts
interface ToolDescriptor {
  readonly name: string;            // `mx_*` namespace — must match TOOL_NAME_RE
  readonly description: string;     // one-line, non-empty, never a secret
  readonly input_schema: JsonSchema;  // JSON Schema (draft-07)
  readonly output_schema: JsonSchema; // JSON Schema for the success payload
  readonly async_semantics: 'sync' | 'deferred';
}
```

- **`async_semantics`** (design §4.3) — `sync` tools resolve directly; `deferred`
  tools may return `running` / `awaiting_approval` + a handle resolved via
  `mx_await_result`. T101 carries the *flag*; the protocol is T103.
- **No `version` field** — the `mx_*` verbs are versioned by the package; the
  *delegated inner* tool keeps its `name@version` inside `mx_delegate_tool` args.
- **No `guarded` hint** — `mx_run_command`'s guarded-ness is enforced by the
  receiver's `policy.toml`, never declared here.

## The registry API

```ts
import { loadRegistry } from '@mx-loom/registry';

const registry = loadRegistry();        // validates the canonical set, fail-fast
for (const tool of registry) {          // enumerable for binding generators
  render(tool.name, tool.input_schema, tool.async_semantics === 'deferred');
}
registry.get('mx_delegate_tool');       // ToolDescriptor | undefined
registry.has('mx_run_command');         // boolean
registry.list();                        // readonly ToolDescriptor[] (frozen, stable order)
```

`loadRegistry(descriptors?, validator?)` assembles the static set into a frozen,
read-only registry, running the validator at construction (throws
`DescriptorValidationError` on the first fault). The optional `descriptors`
argument is a test seam; it is **not** a dynamic file/remote/plugin loader.

The validator runs, per descriptor: **structural** → **JSON Schema validity**
(each schema compiles against the meta-schema — AC 1) → **uniqueness** →
**no-authority allowlist** → **secret-free input shape**.

## The M1 descriptor set

The **7 P0** verbs (design §8): `mx_find_agents`, `mx_describe_agent`,
`mx_delegate_tool` *(deferred)*, `mx_run_command` *(deferred, guarded)*,
`mx_await_result`, `mx_share_context`, `mx_get_context`. The P1 `mx_cancel` /
`mx_workspace_status` land with their handlers in T108.

**`mx_delegate_tool` has a dynamic inner schema.** Its `input_schema` is the
*outer* envelope (`agent` / `tool` / `args`); `args` is an **open object**. The
descriptor does **not** bake in any target tool's schema — T105 validates `args`
dynamically against the target agent's published `ToolSchema.input_schema` at
dispatch (the confirmed v0.2.1 pass-through).

## Invariants

- **No-authority (the headline security property).** The registry is the closed
  allowlist of what cognition can even *name*. It carries only model-facing verbs
  and **never** an authority-mutation RPC (`trust.*`, `approval.decide`,
  `policy.*`, `auth.*`, `device.*`, `cross_signing.*`, `recovery.*`, `daemon.*`).
  The validator enforces it; a regression test pins it.
- **Secret-free.** Descriptors carry no secrets, and no `input_schema` declares a
  credential-shaped field — the canonical schemas never *invite* a credential
  inbound. The oracle mirrors the toolbelt's T008 `CREDENTIAL_KEY_RE` (the
  authoritative runtime dispatch guard); the security test pins them no-drift.
- **Immutable.** The descriptor set and registry are deep-frozen, so a binding
  generator cannot mutate the canonical source.

## Resolved decisions (T101 open questions)

| # | Decision |
|---|---|
| #1 Validator dependency | **Ajv as a runtime dependency**, behind the injectable `SchemaValidator` seam (`createAjvValidator`). `loadRegistry()` meta-validates at construction in all environments; T105/T111 reuse the same seam. The toolbelt keeps its zero-runtime-dep streak (Ajv lives here). |
| #2 Packaging | A new leaf package `@mx-loom/registry` (bindings read descriptors without pulling in transport/CLI/session machinery). |
| #3 JSON Schema dialect | **draft-07** (`JSON_SCHEMA_DIALECT`) — Ajv's default, broadest interop, easiest for T111's Zod subset. |
| #4 Async-semantics flag | `async_semantics: 'sync' \| 'deferred'`; `mx_await_result` is `sync` (it is the resolver); `mx_delegate_tool` + `mx_run_command` are `deferred`. |
| #5 Handler boundary | Descriptor is metadata-only; the daemon-RPC mapping + behavior attach in T104–T108, keyed by name. |
| #7 Verb set | The 7 P0 verbs now; P1 `mx_cancel` / `mx_workspace_status` with T108. |
| #8 `guarded` hint | Omitted — guarded-ness is receiver policy, not descriptor state. |
| #9 `version` field | Omitted — verbs are versioned by the package. |

## Tests

Pure unit tests — no daemon, no socket, no env gating. Run with `pnpm test`.
