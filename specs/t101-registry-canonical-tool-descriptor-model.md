# Registry: Canonical Tool Descriptor Model (T101 / #9)

> Implementation spec for GitHub issue **#9 — T101 · registry: canonical tool descriptor model**.
> Labels: `area/registry` · `priority/P0` · `type/feature`. Milestone **M1 — Delegation MVP**. Estimate **M**.
> Sources: [`docs/mx-agent-tool-fabric-design.md`](../docs/mx-agent-tool-fabric-design.md) (§1 boundary,
> §2 the model-facing tool set, §4 the minimum common tool contract, §8 MVP scope, §9 what to avoid),
> [`docs/backlog.md`](../docs/backlog.md) (`T101` and the items that depend on it — T102, T104, T105, T109,
> T110, T111), [`docs/mx-agent-surface-v0.2.1.md`](../docs/mx-agent-surface-v0.2.1.md) (verified `ToolSchema`
> = `{name, version, description, input_schema, output_schema}`, the confirmed `input_schema` pass-through),
> and the landed `packages/toolbelt` tree (T002–T008 — the `MxClient`/`MxSession` seam this registry will
> later be wired onto by the handlers in T104–T108).
> Blocked-by **#4 (T004)** — satisfied: `MxClient` + `createClient` exist. **Unblocks T102** (result
> envelope), **T104/T105** (the `mx_find_agents`/`mx_describe_agent`/`mx_delegate_tool` handlers), **T109**
> (generated MCP server), **T110** (Claude SDK shim), and **T111** (JSON Schema → Zod converter) — every one
> of which reads the canonical descriptor set this issue defines.

## Problem Statement

The design's central build rule (§3, §9) is: **never hand-author tools per runtime — one canonical descriptor
set feeds *both* a generated MCP server *and* generated native shims (Claude, later ADK/OpenCode/Pi).** That
single source does not exist yet. The repo today has the M0 transport/session seam (`@mx-loom/toolbelt`:
`MxClient`, `MxSession`, the secret-boundary guards) but **no notion of a "tool" at all** — `MxClient.call()`
takes a raw daemon RPC `method` string and resolves the raw `result`. There is nothing that:

- enumerates the **model-facing** verb set (`mx_find_agents`, `mx_describe_agent`, `mx_delegate_tool`,
  `mx_run_command`, `mx_await_result`, `mx_share_context`, `mx_get_context`, and the P1 `mx_cancel` /
  `mx_workspace_status`) as first-class, namespaced descriptors;
- carries each verb's `description`, `input_schema`, `output_schema`, and the **async-semantics flag** that
  tells a binding whether the tool may return a deferred handle (the §4.3 "one piece of semantics a runtime
  cannot skip");
- can be read by a "binding generator" — the MCP server (T109) and the Claude shim (T110) both need to
  iterate descriptors and render them into their respective tool ABIs, and T111 needs each `input_schema` to
  produce an equivalent Zod schema;
- **validates** that what we publish is well-formed: every `input_schema`/`output_schema` is a legal JSON
  Schema document, every name is `mx_*`-namespaced and unique, and — critically for security — that the set
  contains **only** the allowlisted model-facing verbs and **never** an authority-mutation RPC
  (`trust.*`, `approval.decide`, `policy.*`, `auth.*`, `device.*`, `daemon.*`).

T101 closes this by introducing a **transport-neutral canonical tool descriptor model** plus a **registry
loader/validator**: the single, enumerable, validated source every binding and every later handler reads
from. It is pure, secret-free metadata + a validator — **no tool behavior, no daemon calls, no envelope.**

## Goals

- Define a **`ToolDescriptor`** type: `name` (must match the `mx_*` namespace), `description` (one-line),
  `input_schema` (JSON Schema), `output_schema` (JSON Schema), and an **async-semantics flag** distinguishing
  synchronous tools from those that may return a deferred handle (`running` / `awaiting_approval`) requiring
  `mx_await_result` resolution (design §4.3).
- Author the **canonical M1 descriptor set** as static, in-repo metadata for the model-facing verbs the MVP
  surfaces (§8): `mx_find_agents`, `mx_describe_agent`, `mx_delegate_tool`, `mx_run_command` (guarded),
  `mx_await_result`, `mx_share_context`, `mx_get_context` — plus the P1 `mx_cancel` / `mx_workspace_status`
  (T108) if confirmed in scope. Metadata only; **handler behavior is T104–T108.**
- Ship a **`ToolRegistry`** that loads the descriptor set, **validates** it at construction (fail-fast), and
  exposes a stable **enumerable** read API (`list()`, `get(name)`, `has(name)`, iteration) so binding
  generators can read it without knowing handler internals. *(Issue AC 2.)*
- Ship the **validator** such that **descriptors validate as JSON Schema**: each `input_schema`/`output_schema`
  compiles against the chosen JSON Schema meta-schema, and each descriptor record conforms to the descriptor
  model (namespaced unique name, non-empty description, valid async flag). *(Issue AC 1.)*
- Enforce, **in the validator and as a regression test**, the security invariant that the registry is the
  *closed allowlist* of model-facing verbs: every name is `mx_*`; **no** authority-mutation verb is present;
  **no** descriptor declares a credential-shaped input field (design §6, §9).
- Make the descriptor set + registry **immutable** to consumers (frozen), so a binding generator cannot
  mutate the canonical source.
- **Export the new public surface** and document the descriptor model, the registry API, and the
  no-authority/secret-free invariants.

## Non-Goals

- **Individual tool handlers (the explicit out-of-scope — issues #12–#16 / T104–T108).** T101 supplies the
  *descriptors* (static metadata); it does **not** map any verb to a daemon RPC, build a `CallRequest`,
  validate args before dispatch, execute anything, or resolve a handle. `mx_find_agents`→`agent.list`,
  `mx_delegate_tool`→`call.start`, etc. are attached by the handlers, keyed by descriptor name, later.
- **The normalized result envelope + error taxonomy + idempotency (T102).** The descriptor declares
  `output_schema` (the shape of the *success payload*), but the `{status, result, error, handle, approval,
  audit_ref}` envelope, the closed `error.code` set, and `idempotency_key` plumbing are **T102**, not here.
  T101 introduces no `status`/`error`/`handle`/`audit_ref` types.
- **The deferred-result protocol / `mx_await_result` behavior (T103).** T101 only carries the *flag* that a
  tool is deferred; the polling/resolution semantics are T103.
- **Any binding (T109 MCP server, T110 Claude shim) and the JSON Schema → Zod converter (T111).** T101 makes
  the registry *readable* by these; it does not generate MCP tools, register Claude `tool()`s, or convert
  schemas. (T111 is a separate consumer of `input_schema`.)
- **Dynamic / plugin descriptor loading.** The M1 descriptor set is static and authored in-repo. A
  file/remote/plugin loader (descriptors discovered at runtime) is explicitly out of scope; "loader" here
  means "assemble the static set into a validated registry instance," not a dynamic discovery mechanism.
- **The task-DAG tools** (`mx_create_task` / `mx_update_task` / `mx_list_tasks`) — those are M3 (T301) and are
  not in the M1 registry.
- **Validating a *delegated inner tool's* args against the target agent's published `ToolSchema`.** That
  dynamic, per-target validation happens at dispatch in `mx_delegate_tool` (T105). T101 defines only the
  *outer* `mx_delegate_tool` descriptor; the inner schema is resolved at call time.
- **Runtime arg validation that rejects a bad model call.** "Reject invalid args as `invalid_args` before
  dispatch" is T105's AC. T101 may *expose* compiled validators for reuse, but the rejection behavior is the
  handler's.

## Relevant Repository Context

**Stack.** TypeScript (ESM, `"type": "module"`), pnpm workspace (`packages/*` + `adw_sdlc`,
`packageManager: pnpm@9.12.0`), Node ≥ 20.19, vitest 4.x, Apache-2.0. Root package is `mx-loom`; the one
existing workspace package is `@mx-loom/toolbelt` at `packages/toolbelt`. tsconfig is strict ES2022/nodenext
(`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules`, `skipLibCheck`).

**The "repo is docs-only" caveat is stale — M0 is built, M1 has not started.** Verified by reading the tree:

- `packages/toolbelt/src/client.ts` — `MxClient implements MxTransport`, `call(method, params?, options?) →
  Promise<unknown>` resolves the **raw daemon RPC `result`** (no envelope). `createClient()` is the factory.
  This is the seam the *handlers* (T104–T108) will sit on; T101's registry is **upstream** of it — pure
  metadata, no client dependency.
- `packages/toolbelt/src/transport.ts` — `MxTransport`, `CallOptions` (`{ timeoutMs? }`), the closed
  `TransportError`/`TransportErrorCode` set. The doc-comment is explicit that the model-facing envelope and
  its `error.code` set are **M1 (T102), not here** — confirming T101 must not introduce them.
- `packages/toolbelt/src/guards.ts` — `assertNoCredentialShapedArgs` + `CREDENTIAL_KEY_RE` /
  `CREDENTIAL_VALUE_RE` (T008). **Relevant to T101 as a *test oracle*:** the validator/CI gate should assert
  no descriptor `input_schema` declares a property whose name matches `CREDENTIAL_KEY_RE` — i.e. the canonical
  schemas never invite a credential-shaped arg. (The runtime guard still runs at dispatch in T105; T101 just
  ensures the *published shapes* are clean.)
- `packages/toolbelt/src/agent-state.ts` — `AgentState` / `AgentListEntry` typed views of
  `com.mxagent.agent.v1`. Useful when authoring the `output_schema` of `mx_describe_agent` /
  `mx_workspace_status` (they surface agent/workspace shapes), but T101 declares JSON Schemas, not just TS
  types.
- `packages/toolbelt/src/index.ts` — the single public barrel; T101 adds the registry exports (or a new
  package's barrel — see *Risks #2*).
- `packages/toolbelt/test/` — house conventions T101 follows: pure unit tests, **injected** seams
  (timer/RNG/factories) for determinism, and a fail-not-skip discipline. The registry is fully static, so its
  tests need **no daemon and no socket** — they are pure unit tests (a welcome simplification vs. the gated
  integration suites).
- **Zero runtime dependencies today.** `@mx-loom/toolbelt` has only `@types/node` / `typescript` / `vitest`
  devDeps. A JSON Schema *validator* is the first thing T101 plausibly needs at non-test time — see *Risks #1*
  (the key decision).

**Verified daemon surface (`docs/mx-agent-surface-v0.2.1.md`, T001) — what the descriptors model:**

- ✅ **`ToolSchema` (`com.mxagent.tool.v1`)** = `{name, version, description, input_schema (JSON Schema),
  output_schema (JSON Schema)}`. Observed for `run_tests@1.0.0` exactly as the design example: input
  `{package(req), coverage, name}` → output `{exit_code, summary, log_mxc}`. **`input_schema` pass-through for
  `mx_delegate_tool` is confirmed available** — i.e. the *inner* tool's schema is the target's published
  `ToolSchema.input_schema`, resolved dynamically by T105, not baked into the `mx_delegate_tool` descriptor.
- ✅ `agent.register` / `agent.list` / `agent.tools` round-trip (back `mx_find_agents` / `mx_describe_agent`).
- ◻️ `call.start` / `exec.start` flags confirmed; full round-trip staged behind the two-daemon fixture (T007).
- **The JSON Schema *dialect* of `input_schema`/`output_schema` is not recorded** (the doc says "JSON Schema"
  without naming draft-07 vs 2020-12). T101's chosen dialect should match what v0.2.1 emits so T105's dynamic
  pass-through validation and T111's Zod conversion agree — **confirm (Risks #3).**

**Does NOT exist yet (net-new in T101 — decisions to confirm, not assume):**

- **No registry, no descriptor type, no descriptor data.** Grep across `packages/toolbelt/src` finds
  `registry` / `descriptor` / `input_schema` / `output_schema` only in **doc-comments** (the T101/T102
  forward-references in `client.ts`/`transport.ts`/`ipc/client.ts`) — never as code. All net-new.
- **No JSON Schema validator wired in** (no Ajv or equivalent; zero runtime deps). The validator library and
  whether it is a runtime vs. dev dependency is the central decision (*Risks #1*).
- **No second workspace package.** Whether the registry is a new `packages/registry` (`@mx-loom/registry`) or
  a `src/registry/` module inside `@mx-loom/toolbelt` is a packaging decision (*Risks #2*). The `packages/*`
  glob already supports a new package.
- **The exact async-semantics flag representation and per-tool assignment** are not fixed by any doc — design
  §4.3 describes the *behavior* but not a descriptor field. T101 defines the field (*Risks #4*).

## Proposed Implementation

Introduce the canonical descriptor model as a small, dependency-light, **fully static** module: a typed
`ToolDescriptor`, the authored M1 descriptor set, and a `ToolRegistry` that validates on load and is
read-only to consumers. No daemon calls, no `MxClient` dependency, no envelope.

### 0. Where it lives (recommended)

**Recommendation: a new leaf package `@mx-loom/registry` at `packages/registry`.** Rationale: the design
treats the canonical registry as a *distinct* concern that "feeds *both*" bindings (§3); the bindings (T109
MCP, T110 Claude) will be separate packages, and a small zero-/single-dependency leaf they (and the toolbelt
handlers) import keeps the dependency graph clean — bindings read descriptors without pulling in the
transport/CLI/session machinery. The `packages/*` workspace glob already supports it.

**Acceptable alternative (lower friction):** a `packages/toolbelt/src/registry/` submodule exported from the
toolbelt barrel — matches the current single-package status and avoids new `package.json`/`tsconfig`/`vitest`
wiring. **Flag this as a decision to confirm (Risks #2);** the rest of the spec is written package-agnostic
(paths shown as `<registry>/…`).

### 1. The descriptor model

```ts
// <registry>/src/descriptor.ts

/** A JSON Schema document (the chosen dialect — see Risks #3). Opaque object here; validated by the loader. */
export type JsonSchema = Record<string, unknown>;

/**
 * Async semantics (design §4.3). `sync` tools resolve to a terminal payload directly; `deferred` tools may
 * return `status: running | awaiting_approval` + a `handle` that the model/binding resolves via
 * `mx_await_result`. Bindings key on this: ADK wraps `deferred` tools as LongRunningFunctionTool, Claude
 * hides the poll loop, generic MCP surfaces the handle. (T101 carries the FLAG; the protocol is T103.)
 */
export type AsyncSemantics = 'sync' | 'deferred';

/** Transport-neutral, secret-free, model-facing tool descriptor. Pure metadata — no behavior, no RPC. */
export interface ToolDescriptor {
  /** Namespaced model-facing name; MUST match `^mx_[a-z0-9]+(?:_[a-z0-9]+)*$`. */
  readonly name: string;
  /** One-line, human/model-readable description. Non-empty; NO secrets. */
  readonly description: string;
  /** JSON Schema for the tool's input (the OUTER shape for mx_delegate_tool — see §2). */
  readonly input_schema: JsonSchema;
  /** JSON Schema for the tool's success payload (the envelope's `result`, validated vs this in T102/T105). */
  readonly output_schema: JsonSchema;
  /** Whether the tool may return a deferred handle requiring `mx_await_result`. */
  readonly async_semantics: AsyncSemantics;
}
```

Deliberately **excluded** from the descriptor (kept out so it stays transport-neutral metadata): the daemon
RPC mapping (handler concern, T104–T108), the envelope/`error.code` set (T102), and any version field — the
`mx_*` verbs are versioned by the package, not per-call; the *delegated inner* tool keeps its
`name@version` inside `mx_delegate_tool` args (resolved at dispatch). **Confirm** the no-version decision
(*Risks #9*). An optional non-authoritative `guarded: true` hint for `mx_run_command` is discussed in §2 and
*Risks #8* (recommended **omit** — guarded-ness is receiver policy, not descriptor state).

### 2. The canonical M1 descriptor set

Author each verb's descriptor as a frozen `const` in `<registry>/src/descriptors/`. Per-tool notes:

| Descriptor | `async_semantics` | `input_schema` (outer) | `output_schema` notes |
|---|---|---|---|
| `mx_find_agents` | `sync` | `{ capability?, tool?, liveness? }` filters | array of agent summaries (subset of `AgentState`) |
| `mx_describe_agent` | `sync` | `{ agent_id }` | agent + its published `ToolSchema[]` |
| `mx_delegate_tool` | `deferred` | `{ agent, tool, args (open object), wait_ms? }` — **inner `args` validated dynamically vs the target's `ToolSchema` at dispatch (T105), not statically here** | the inner tool's success payload (shape known only at call time) |
| `mx_run_command` *(guarded)* | `deferred` | `{ agent, command, args[], cwd?, wait_ms? }` | exit/summary/log-ref shape |
| `mx_await_result` | `sync` | `{ handle, wait_ms? }` | the resolved terminal payload |
| `mx_share_context` | `sync` | `{ kind: file\|diff\|env, … }` | `{ context_id, sha256 }` |
| `mx_get_context` | `sync` | `{ context_id }` | the artifact / media ref |
| `mx_cancel` *(P1/T108)* | `sync` | `{ handle }` | cancellation ack |
| `mx_workspace_status` *(P1/T108)* | `sync` | `{}` / `{ room? }` | workspace agents/tasks/project |

`mx_delegate_tool` is the one with a **dynamic inner schema**: its descriptor's `input_schema` describes the
*outer* envelope (`agent` / `tool` / `args`); `args` is declared as an open object and validated against the
*target agent's* published `ToolSchema.input_schema` at dispatch by T105 (the confirmed pass-through). Document
this explicitly so a binding generator (and a reader) does not mistake the outer schema for the inner one.

**Confirm with the maintainer** whether T101 authors the full 9 (including P1 `mx_cancel` /
`mx_workspace_status`, whose handlers are T108) or only the 7 P0 verbs now, leaving the P1 two to land with
T108 (*Risks #7*). The registry model supports either; the recommendation is to author the **7 P0** descriptors
now (they directly unblock T104/T105/T109/T110) and add the P1 two alongside T108.

### 3. The registry loader/validator

```ts
// <registry>/src/registry.ts
export interface ToolRegistry {
  /** All descriptors, in a stable order, frozen. */
  list(): readonly ToolDescriptor[];
  /** Look up by name; undefined if absent. */
  get(name: string): ToolDescriptor | undefined;
  has(name: string): boolean;
  /** Iteration sugar so `for (const d of registry)` works for binding generators. */
  [Symbol.iterator](): Iterator<ToolDescriptor>;
}

export class DescriptorValidationError extends Error { /* names the offending descriptor + reason */ }

/** Assemble + validate the static set into a frozen registry. Throws DescriptorValidationError on any fault. */
export function loadRegistry(descriptors?: readonly ToolDescriptor[]): ToolRegistry; // defaults to CANONICAL_M1_TOOLS
```

`loadRegistry()` runs the **validator** at construction (fail-fast) and `Object.freeze`s the result. The
validator performs, in order:

1. **Structural validation** of each record: `name` matches `^mx_[a-z0-9]+(?:_[a-z0-9]+)*$`; `description` is
   a non-empty string; `async_semantics ∈ {'sync','deferred'}`; `input_schema`/`output_schema` are objects.
2. **JSON Schema validity** (satisfies AC 1, primary reading): each `input_schema` and `output_schema`
   **compiles** against the chosen JSON Schema meta-schema using the validator library (Risks #1) — a malformed
   schema (bad `type`, dangling `$ref`, illegal keyword) is rejected with a path-naming error.
3. **Uniqueness**: no two descriptors share a `name`.
4. **Security allowlist (no-authority invariant):** every name is `mx_*`; assert the set is a subset of the
   known model-facing allowlist and contains **none** of the forbidden authority verbs
   (`trust.*`, `approval.decide`, `policy.*`, `auth.*`, `device.*`, `cross_signing.*`, `recovery.*`,
   `daemon.*`). (These are RPC method names, not `mx_*`, so they cannot match by construction — but the test
   makes the invariant explicit and regression-proof.)
5. **Secret-free shape:** no `input_schema` declares a top-level (or nested `properties`) field whose name
   matches `CREDENTIAL_KEY_RE` (reuse the toolbelt's exported regex as the oracle) — the canonical schemas
   must never *invite* a credential-shaped arg.

"Loader" in M1 = assemble the **static** `CANONICAL_M1_TOOLS` array; no dynamic file/remote loading (Non-Goal).
`loadRegistry(custom)` accepts an explicit array purely as a test seam (validate a deliberately-bad descriptor).

**Enumerability (AC 2)** is satisfied by `list()` / `get()` / iteration returning the frozen descriptors. A
"binding generator can read it" is demonstrated by a test that mimics T109/T110: iterate the registry, read
each `{name, description, input_schema, output_schema, async_semantics}`, and assert a tool-list of the
expected size/shape can be produced — without touching any handler or daemon.

### 4. Validator library + reuse seam

The JSON Schema meta-validation in step 2 needs a validator. **Recommendation: standardize on one
validator (Ajv — the de-facto JSON Schema implementation) and decide runtime-vs-dev now**, because T102/T105
(reject `invalid_args` before dispatch) and T111 (schema→Zod) will all need JSON-Schema handling one issue
later — paying the dependency decision once avoids churn. Two viable shapes, **pick one (Risks #1):**

- **(a) Validator as a build/test-time gate (devDependency); registry stays runtime-dep-free.** Descriptors
  are static and authored in-repo, so AC 1 is fully satisfiable by a **CI/test** that loads the registry and
  compiles every schema against the meta-schema. The published registry exposes the descriptors + structural
  validation only; runtime schema validation is added later by T105 where it is actually exercised. Preserves
  the zero-runtime-dep streak. **Recommended default** unless the maintainer wants runtime validation now.
- **(b) Validator as a runtime dependency of the registry.** `loadRegistry()` meta-validates at construction
  in all environments, and the registry can expose compiled per-tool validators (`validateInput(name, value)`)
  that T105 reuses verbatim. Cleaner reuse, at the cost of the package's first runtime dependency.

Either way, define a tiny **`SchemaValidator` interface** the registry depends on, with the concrete Ajv
implementation injected (mirrors the toolbelt's inject-the-seam discipline). This keeps the registry core
testable and lets (a)↔(b) be a one-line wiring change later.

### 5. Exports + docs

Export `ToolDescriptor`, `JsonSchema`, `AsyncSemantics`, `ToolRegistry`, `loadRegistry`,
`DescriptorValidationError`, the `CANONICAL_M1_TOOLS` set (and the individual descriptor consts if useful), and
the `SchemaValidator` seam — from the new package's barrel **or** the toolbelt barrel per the §0 decision. Add
a README/section documenting the descriptor model, the registry API, the no-authority + secret-free
invariants, and the gated validator-dependency decision.

## Affected Files / Packages / Modules

**New (paths shown for the recommended `packages/registry`; collapse to `packages/toolbelt/src/registry/` if
§0 alternative is chosen):**
- `packages/registry/package.json` — `@mx-loom/registry`, `private: true`, `version: 0.0.0`, Apache-2.0,
  `type: module`, `exports: { ".": "./src/index.ts" }`, Node ≥ 20.19; devDeps mirror toolbelt; **+ the
  validator dep per Risks #1**.
- `packages/registry/tsconfig.json` (+ `tsconfig.build.json`) — mirror the toolbelt's strict nodenext config.
- `packages/registry/vitest.config.ts` — pure unit tests (no daemon, no gating).
- `packages/registry/src/descriptor.ts` — `ToolDescriptor`, `JsonSchema`, `AsyncSemantics`.
- `packages/registry/src/descriptors/` — one file per `mx_*` verb (the static, frozen descriptor consts) +
  an `index.ts` exporting `CANONICAL_M1_TOOLS`.
- `packages/registry/src/registry.ts` — `ToolRegistry`, `loadRegistry`, `DescriptorValidationError`.
- `packages/registry/src/validator.ts` — the `SchemaValidator` seam + Ajv-backed implementation.
- `packages/registry/src/index.ts` — the public barrel.
- `packages/registry/test/descriptor.test.ts`, `registry.test.ts`, `descriptors.test.ts`,
  `security-invariants.test.ts` — unit coverage (see *Testing Plan*).
- `packages/registry/README.md` — descriptor model + registry API + invariants.

**Modify:**
- `pnpm-workspace.yaml` — already globs `packages/*`; **no change needed** if the new package lives there
  (verify). If the registry is folded into the toolbelt instead, edit `packages/toolbelt/src/index.ts` +
  `package.json` description instead.
- `docs/backlog.md` — tick T101's ACs; note T102/T104/T105/T109/T110/T111 unblocked.
- `docs/mx-agent-tool-fabric-design.md` — §4.1 currently lists only `name`/`description`/`input_schema`;
  reconcile with the issue scope that adds `output_schema` + the async-semantics flag (see *Documentation*).

**Read for context (no change):** `packages/toolbelt/src/guards.ts` (the `CREDENTIAL_KEY_RE` oracle),
`packages/toolbelt/src/agent-state.ts` (shapes behind `mx_describe_agent`/`mx_workspace_status` output),
`docs/mx-agent-surface-v0.2.1.md` (`ToolSchema`, the `input_schema` pass-through), design §2/§4/§8/§9.

**Cross-repo / downstream (NOT in this repo):** none — the registry is self-contained metadata. Downstream
*consumers* (T109 MCP, T110 Claude, T111 Zod, T104/T105 handlers) are separate issues in this repo.

## API / Interface Changes

**New public API (additive; new package or new toolbelt exports — no breaking changes):**
- `ToolDescriptor`, `JsonSchema`, `AsyncSemantics` — the descriptor model types.
- `ToolRegistry` (`list()` / `get(name)` / `has(name)` / `[Symbol.iterator]`), `loadRegistry(descriptors?)`,
  `DescriptorValidationError`.
- `CANONICAL_M1_TOOLS` (and optionally the individual descriptor consts).
- `SchemaValidator` (the injectable validation seam).

**Tool-descriptor surface:** this issue *defines* the descriptor surface (it did not exist). The authored
`mx_*` descriptors (`name`/`description`/`input_schema`/`output_schema`/`async_semantics`) are the new
contract the bindings render. These are **model-facing** descriptors, not new daemon RPCs.

**Unchanged:** `MxClient`/`createClient`, `MxSession`/`openSession`, the `MxTransport`/`CallOptions` seam, the
`TransportError`/`TransportErrorCode` set, both transports, the wire protocol, and the daemon RPC surface.
**No new daemon-RPC calls** (the registry makes none). **No CLI changes.** **No new model-facing *behavior*** —
T101 is descriptors + validation only; handlers are T104–T108.

## Data Model / Protocol Changes

- **New data model: the `ToolDescriptor`** (`name` / `description` / `input_schema` / `output_schema` /
  `async_semantics`) and the `CANONICAL_M1_TOOLS` set. This is in-repo metadata, **not** a wire/protocol change
  — nothing is sent to or received from the daemon differently.
- **Result envelope:** **not introduced here.** The descriptor declares `output_schema` (the shape of the
  *success payload*), but the `{status, result, error, handle, approval, audit_ref}` envelope, the closed
  `error.code` set (`policy_denied|untrusted_key|approval_denied|approval_expired|timeout|not_found|
  invalid_args|target_offline|internal`), and the validation of `result` *against* `output_schema` are **T102**.
- **Error taxonomy:** unchanged at the transport layer. T101 adds one *local* error type,
  `DescriptorValidationError`, raised **at registry-load time** in dev/CI/process-start — it is **not** a
  model-facing `error.code` and never reaches the envelope.
- **Async-semantics flag:** the new `async_semantics` field is the descriptor-level signal for the §4.3
  deferred-result protocol; the *protocol itself* (handles, `mx_await_result`) is T103.
- **Idempotency-key / audit-row / serialization:** none. `idempotency_key` is T102; the Postgres `audit_ref`
  mirror is T113. T101 touches none of these.

## Security & Compliance Considerations

The registry is the **closed allowlist of what cognition can even name** — so its *content* is itself a
security boundary (design §6, §9). The descriptors are static, public, secret-free metadata; T101 introduces
no new authority and no new secret-handling path.

- **No-authority invariant (the headline security property).** The registry MUST contain **only** the
  allowlisted model-facing verbs and MUST NEVER carry a descriptor for an authority-mutation RPC —
  `trust.publish`/approve/revoke, `approval.decide`, `policy.*`, `auth.*`, `device.verify.*`,
  `cross_signing.*`, `recovery.*`, `daemon.*` (design §2 "Explicitly NOT model tools", §9 "Don't give
  cognition any authority surface"). The validator enforces this and a regression test pins it. **Cognition
  can only ever produce a signed request; it can never grant itself authority** — and it cannot even *name* a
  governance verb, because no descriptor exists for one.
- **Approval reaches the model only as a status, never as a grant.** The descriptor model carries no
  approve/deny capability. `mx_run_command` (and approval-gated `mx_delegate_tool`) are marked
  `async_semantics: 'deferred'`; the model experiences an approval purely as the (T102) `awaiting_approval`
  envelope status, re-validated against live policy at release on the receiving daemon. T101 adds no
  approval/trust/policy mutation tool.
- **`mx_run_command` is guarded by *receiver policy*, not by the descriptor.** Its mere presence in the
  registry confers **no** capability: it ships disabled, and enforcement is the target daemon's deny-by-default
  `policy.toml` (`allow_commands` + `deny_args_regex` + sandbox + `network = "deny"`). The descriptor must not
  imply it is runnable; if a `guarded` hint is included it is **advisory UX only** and grants nothing
  (recommendation: omit it — *Risks #8*).
- **Secret boundary (Boundary A) is unaffected and reinforced.** Descriptors carry **no** secrets — no Matrix
  tokens, no Ed25519 keys (public or private), no provider keys, no `GH_TOKEN`. The validator additionally
  asserts **no `input_schema` declares a credential-shaped field** (oracle = the toolbelt's exported
  `CREDENTIAL_KEY_RE`), so the canonical shapes never *invite* a credential inbound. The runtime
  credential-shaped-arg guard (T008) still runs at dispatch in T105 — T101 keeps the *published contract* clean
  so that guard should never need to fire on a well-formed call. The secret-free tool contract (§4.7) is thus
  honored at the schema level.
- **No env, no subprocess, no socket.** The registry is pure in-process metadata: it spawns nothing, opens no
  socket, reads no env var, and forwards nothing — so there is no new env-allowlist surface to widen and no new
  place a secret could leak.
- **`audit_ref` correlation:** not introduced here (T102 envelope / T113 mirror). Descriptors carry no audit
  fields. Flagged so a later reader does not expect `audit_ref` on a descriptor.
- **Logging / redaction.** Descriptor names, descriptions, and schemas are non-secret and safe to log/enumerate
  (binding generators print them). `DescriptorValidationError` names the offending descriptor + the field/path
  and the reason — never a secret (there are none in a descriptor). Standing rule still holds: never log or
  persist secrets or tokens anywhere in the registry path.

## Testing Plan

All tests are **pure unit tests** — the registry is static, so they need no daemon, socket, or env gating.

**Descriptor model (`descriptor.test.ts`):**
- Valid descriptors of each `async_semantics` value type-check and round-trip.
- The `name` regex accepts `mx_find_agents` / `mx_delegate_tool` and rejects `find_agents` (no prefix),
  `mx_` (empty tail), `mxFindAgents` (camelCase), `mx__x` / `mx_X` (illegal chars/separators).

**Registry loader/validator (`registry.test.ts`):**
- `loadRegistry()` (default set) succeeds, is frozen (mutation attempts are no-ops/throw), and `list()` returns
  all authored descriptors in a stable order; `get(name)`/`has(name)` work; `for…of` iteration yields them.
- **AC 1 — descriptors validate as JSON Schema:** every descriptor's `input_schema` and `output_schema`
  compile against the chosen meta-schema (the validator). A deliberately malformed schema (illegal `type`,
  dangling `$ref`) passed via `loadRegistry([bad])` throws `DescriptorValidationError` naming the field/path.
- **AC 2 — enumerable for binding generators:** a "fake binding generator" test iterates the registry, reads
  `{name, description, input_schema, output_schema, async_semantics}` for each, and asserts it can build a
  tool-list of the expected size — proving a T109/T110-shaped consumer reads it with no handler/daemon.
- Validator rejects: a duplicate `name`; a missing/empty `description`; a non-`mx_*` `name`; a bad
  `async_semantics` value — each with a precise `DescriptorValidationError`.

**Security invariants (`security-invariants.test.ts`) — regression-proof the boundary:**
- The default registry contains **only** the expected M1 verb set (assert exact name set).
- The default registry contains **none** of the forbidden authority verbs (`trust.*`, `approval.decide`,
  `policy.*`, `auth.*`, `device.*`, `daemon.*`), and `loadRegistry` would reject one if authored.
- No descriptor `input_schema` declares a property whose name matches `CREDENTIAL_KEY_RE` (the secret-free
  shape oracle) — including nested `properties`.
- `mx_run_command` is `async_semantics: 'deferred'` and (if a `guarded` hint exists) it is advisory-only and
  asserted to grant nothing.

**Per-descriptor content (`descriptors.test.ts`):**
- Each authored verb's outer `input_schema` declares the expected fields (e.g. `mx_describe_agent` requires
  `agent_id`; `mx_await_result` requires `handle`).
- `mx_delegate_tool`'s `args` is an **open** object (documented dynamic-inner-schema behavior), and a test
  asserts the descriptor does NOT bake in any specific target's inner schema.

**Documentation:** a compile-checked usage snippet (`loadRegistry()` → iterate → read a descriptor) in the
README so the public example cannot rot.

## Documentation Updates

- **`docs/backlog.md`** — tick T101's two acceptance boxes once landed; note that **T102** (envelope),
  **T104/T105** (discovery + delegation handlers), **T109** (MCP server), **T110** (Claude shim), and **T111**
  (JSON Schema → Zod) are unblocked. Record the resolved decisions (validator dependency choice, packaging
  choice, JSON Schema dialect, async-flag representation).
- **`docs/mx-agent-tool-fabric-design.md`** — **reconcile §4.1**: it currently lists the descriptor as
  `name` / `description` / `input_schema` only, but the T101 issue scope (and this spec) add **`output_schema`
  and an async-semantics flag**. Update §4.1 to list all five fields so the design doc matches the implemented
  descriptor model (or note the deliberate superset). Optionally add a sentence to §3/§9 that the canonical
  registry is now a concrete, validated, enumerable module that the bindings read. Do **not** imply the
  envelope/`audit_ref` (T102) or any binding (T109/T110) exists yet.
- **`docs/mx-agent-surface-v0.2.1.md`** — record the confirmed **JSON Schema dialect** of v0.2.1's
  `ToolSchema.input_schema`/`output_schema` (draft-07 vs 2020-12) once verified, so the registry's chosen
  dialect (and T111's Zod subset) provably match.
- **New `packages/registry` README** (or the toolbelt README section) — document the `ToolDescriptor` model,
  the `ToolRegistry` API, the **no-authority** and **secret-free** invariants, the dynamic-inner-schema note
  for `mx_delegate_tool`, and the gated validator-dependency decision.

## Risks and Open Questions

1. **JSON Schema validator dependency (biggest decision; confirm).** AC 1 requires descriptors to "validate as
   JSON Schema," which needs a validator. The toolbelt has held **zero runtime dependencies** through
   T002–T008. Options: **(a)** validator as a **devDependency** (CI/test gate over the static set) — keeps the
   registry runtime-dep-free, **recommended default**; **(b)** validator as a **runtime dependency** (Ajv) so
   `loadRegistry()` validates everywhere and can expose compiled validators that T102/T105 reuse. Because
   T105 ("reject `invalid_args` before dispatch") and T111 (schema→Zod) need JSON-Schema handling one issue
   later, **decide now** (and pick the library — recommend **Ajv**) to avoid churn.
2. **Packaging — new `@mx-loom/registry` package vs. `src/registry/` module in `@mx-loom/toolbelt` (confirm).**
   Recommendation: a leaf package (cleaner dependency graph for the separate binding packages). Alternative:
   fold into the toolbelt (lower friction, matches current single-package status). Either satisfies the ACs.
3. **JSON Schema dialect (confirm).** The surface doc records "JSON Schema" without naming draft-07 vs 2020-12.
   The registry's chosen dialect should match what v0.2.1's `ToolSchema` emits (so T105's dynamic pass-through
   validation agrees) **and** what T111's Zod converter supports. Confirm the daemon's dialect; pick one (and
   keep authored schemas within T111's supported subset).
4. **Async-semantics flag representation + per-tool assignment (confirm).** This spec proposes
   `async_semantics: 'sync' | 'deferred'`. Alternatives: a boolean (`deferred: boolean`) or a richer enum
   (e.g. distinguishing `approval_capable`). Also confirm the per-tool assignment — esp. that `mx_await_result`
   is `sync` (it *is* the resolver) and that both `mx_delegate_tool` and `mx_run_command` are `deferred`.
5. **Descriptor↔RPC mapping / handler boundary (confirm the line).** This spec keeps the descriptor
   metadata-only and attaches the daemon-RPC mapping + behavior in T104–T108 (keyed by name). Confirm the
   maintainer wants the mapping kept *out* of the descriptor (recommended, for transport-neutrality) rather
   than embedded.
6. **`mx_delegate_tool` outer `input_schema` shape (partial dependency on T102).** The outer envelope likely
   includes `idempotency_key` (T102) and `wait_ms` (T103) eventually. T101 should author the outer schema with
   the fields known now (`agent`, `tool`, `args`) and leave the T102/T103 fields to be added with those issues
   — confirm whether to stub them now or defer.
7. **Which verbs T101 authors now (confirm).** Recommendation: the **7 P0** verbs (§8); author the P1
   `mx_cancel` / `mx_workspace_status` (T108) alongside T108. Confirm whether to include the P1 two up front.
8. **`guarded` / `default_enabled` descriptor hint for `mx_run_command` (confirm; recommend omit).** Guarded-ness
   is enforced by receiver `policy.toml`, not by the descriptor. Including an advisory hint risks implying
   descriptor-level authority. Recommendation: **omit**; rely on `policy.toml` + the `deferred` flag.
9. **No `version` field on `mx_*` descriptors (confirm).** The `mx_*` verbs are versioned by the package; the
   delegated *inner* tool keeps its `name@version` in `mx_delegate_tool` args. Confirm a descriptor `version`
   field is unnecessary (recommended) rather than mirroring the daemon `ToolSchema`'s `version`.

## Implementation Checklist

1. **Read** design §2 (model-facing set + the explicit NOT-model-tools), §4 (the seven-point contract), §8
   (MVP tool set), §9 (no authority surface); `docs/mx-agent-surface-v0.2.1.md` (`ToolSchema`, the
   `input_schema` pass-through); and `packages/toolbelt/src/guards.ts` (the `CREDENTIAL_KEY_RE` oracle).
2. **Confirm the gated decisions first:** validator dependency runtime-vs-dev + library (#1), packaging
   (#2), JSON Schema dialect against live v0.2.1 (#3), async-flag representation (#4), and the verb set to
   author now (#7). Record results in `docs/backlog.md` / `docs/mx-agent-surface-v0.2.1.md`.
3. **Scaffold the package/module** (per #2): `package.json` (`@mx-loom/registry`), strict nodenext
   `tsconfig`(+`.build`), `vitest.config.ts`, `src/`, `test/`, `README.md` — mirroring `packages/toolbelt`
   conventions; add the validator dep per #1.
4. **Define the model** in `src/descriptor.ts`: `ToolDescriptor`, `JsonSchema`, `AsyncSemantics` (the `mx_*`
   name regex documented on `name`).
5. **Author the canonical descriptors** in `src/descriptors/` (the confirmed verb set), each a frozen `const`
   with `name` / `description` / `input_schema` / `output_schema` / `async_semantics`; export
   `CANONICAL_M1_TOOLS`. Mark `mx_delegate_tool`/`mx_run_command` `deferred`; document `mx_delegate_tool`'s
   open `args` (dynamic inner schema resolved by T105).
6. **Implement the validator** in `src/validator.ts` (the `SchemaValidator` seam + Ajv impl per #1) and the
   `ToolRegistry`/`loadRegistry`/`DescriptorValidationError` in `src/registry.ts`: structural check → JSON
   Schema meta-validation → uniqueness → no-authority allowlist → secret-free shape (`CREDENTIAL_KEY_RE`);
   `Object.freeze` the result; expose `list()`/`get()`/`has()`/iteration.
7. **Export** the public surface from `src/index.ts` (or the toolbelt barrel per #2).
8. **Tests:** `descriptor.test.ts` (name regex, type round-trip), `registry.test.ts` (load/freeze/enumerate +
   AC 1 schema validity + AC 2 fake-binding-generator + reject malformed/dup/bad), `security-invariants.test.ts`
   (exact verb set, no authority verbs, no credential-shaped fields, `mx_run_command` deferred/advisory),
   `descriptors.test.ts` (per-verb fields + `mx_delegate_tool` open `args`).
9. **Verify:** `pnpm -C packages/registry typecheck` clean; `pnpm -C packages/registry test` green (no daemon
   needed); the root build picks up the new package.
10. **Docs:** tick T101 in `docs/backlog.md` (note T102/T104/T105/T109/T110/T111 unblocked); reconcile design
    §4.1 to list `output_schema` + the async flag; record the dialect in the surface doc; write the package
    README (descriptor model, registry API, no-authority + secret-free invariants, the dynamic-inner-schema
    note, the validator-dependency decision).
11. **Confirm the open questions** (esp. #1 validator dep, #2 packaging, #3 dialect, #4 async flag, #5
    metadata-only handler boundary) with the maintainer before or alongside review, since they shape the
    contract every downstream consumer (T102/T104/T105/T109/T110/T111) builds on.
