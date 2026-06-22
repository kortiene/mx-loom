# @mx-loom/registry

The **canonical tool registry** for mx-loom (T101 / #9): one transport-neutral,
secret-free set of `mx_*` tool descriptors plus a fail-fast loader/validator.

> One canonical descriptor set feeds **both** a generated MCP server *and*
> generated native shims (Claude, later ADK/OpenCode/Pi) — never hand-author
> tools per runtime (design §3, §9). This package is that single source.

It now ships **three layers**: the descriptor model and registry loader/validator
(T101), the normalized result-envelope + error taxonomy + idempotency contract
(T102), and the handlers — `mx_await_result` (T103), `mx_find_agents` /
`mx_describe_agent` (T104), and `mx_delegate_tool` (T105) — all backed by an
injected daemon-call seam so `@mx-loom/toolbelt` stays a `devDependency`. The
remaining handlers (`mx_run_command` T106, T107–T108), the MCP binding (T109), the
Claude shim (T110), and the JSON Schema → Zod converter (T111) all *read*
descriptors and *build envelopes* from here.

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

## The result envelope (T102)

**One normalized shape every mx-loom tool returns** (design §4.2), so any runtime
binding reacts to results programmatically — `untrusted_key` → onboarding hint,
`awaiting_approval` → keep planning, `target_offline` → retry elsewhere — without
parsing prose.

```ts
interface ToolResult<T = unknown> {
  readonly status: 'ok' | 'running' | 'awaiting_approval' | 'denied' | 'error';
  readonly result: T | null;
  readonly error: { code: ErrorCode; message: string } | null; // message: NO secrets
  readonly handle: string | null;          // running | awaiting_approval
  readonly approval: { request_id; risk; summary; expires_at } | null; // awaiting_approval
  readonly audit_ref: { invocation_id; request_id; room; event_id };    // ALWAYS present
}
```

Build envelopes **only** through the constructor helpers — they require an
`audit_ref`, set exactly the fields a status permits, and deep-freeze the result,
so a handler built on them conforms to the schema **by construction**:

```ts
import { ok, running, awaitingApproval, denied, errored, validateEnvelope } from '@mx-loom/registry';

ok({ exit_code: 0 }, auditRef);                       // terminal success
running('inv_01HZ…', auditRef);                        // deferred handle
awaitingApproval('inv_…', approvalInfo, auditRef);     // held at the approval gate
denied('policy_denied', 'not allowed by policy', auditRef);
errored('target_offline', 'agent unreachable', auditRef);

validateEnvelope(ok({ ok: true }, auditRef)); // true — the draft-07 schema is the contract (AC 1)
```

### Status ↔ field presence

| `status` | `result` | `error` | `handle` | `approval` | `audit_ref` |
|---|---|---|---|---|---|
| `ok` | object | null | null | null | required |
| `running` | null | null | string | null | required |
| `awaiting_approval` | null | null | string | object | required |
| `denied` | null | `{code ∈ denial-set}` | null | null | required |
| `error` | null | `{code ∈ fault-set}` | null | null | required |

`audit_ref` is structurally always present; its inner ids may be `null` when the
daemon does not (yet) return them — never fabricated. The `ENVELOPE_SCHEMA`
(draft-07, compiled via the same `createAjvValidator` seam) enforces this table
mechanically.

### The closed `error.code` taxonomy

Exactly **nine** codes (`ERROR_CODES`), partitioned by the status they pair with:

- **denial-set** (status `denied`) — `policy_denied`, `untrusted_key`,
  `approval_denied`, `approval_expired`. Governance outcomes; `denied()` accepts
  only these (`DenialCode`).
- **fault-set** (status `error`) — `timeout`, `not_found`, `invalid_args`,
  `target_offline`, `internal`. Operational failures; `errored()` accepts only
  these (`FaultCode`).

This set is **distinct from** the toolbelt's transport `TransportErrorCode`. Two
mappers bridge a raw fault onto the model-facing set in one place:

- `mapTransportError(code)` — exhaustive over every `TransportErrorCode`
  (compile-checked via a `never` default; a new transport code fails the build
  until mapped). Local-fabric faults (`not_running`/`connect_failed`/`closed`/
  `frame`/`protocol`) → `internal`; `timeout`/`invalid_args` 1:1; a `rpc` fault is
  routed through `mapDaemonError` when the daemon error object is available.
- `mapDaemonError(daemonError)` — maps a daemon `CallResponse{ok:false}` /
  JSON-RPC error object onto the set, with an **`internal` fallback** for any
  unrecognised code (never wrong-typed, never dropped). The exact daemon
  vocabulary is pinned at the two-daemon conformance round-trip.

### Idempotency (client-supplied)

Every **mutating** verb carries an optional `idempotency_key` (design §4.4):
`mx_delegate_tool` and `mx_run_command` declare it in their `input_schema` (read
verbs do not). A handler:

- uses the caller's `idempotency_key` if present, else calls `newIdempotencyKey()`
  (`idk_<uuid>`, `node:crypto`-backed) **once per logical invocation**;
- places it in the outbound `call.start`/`exec.start` **params** (the daemon
  dedupes on `idempotency_key`/`nonce`), so a retried call does not double-execute;
- **never regenerates** it on a transport-level retry — `MxClient.withRetry`
  reuses `params` verbatim, so a key in `params` is stable across retries with no
  transport change. The key is a dedup nonce, **not** a credential or a capability.

## The deferred-result protocol (T103)

Remote calls and approvals are asynchronous (design §4.3 — "the one piece of
semantics a runtime cannot skip"). A delegation (`mx_delegate_tool`) or a guarded
command (`mx_run_command`) may return a **non-terminal** envelope — `running` or
`awaiting_approval` plus a `handle` (`inv_…`). **`mx_await_result` is the one
shared primitive that turns a handle into a terminal answer.**

```ts
import { mxAwaitResult } from '@mx-loom/registry';
import { createClient } from '@mx-loom/toolbelt'; // the injected daemon-call seam

const deps = { daemon: createClient() };          // any { call } satisfies DaemonCall
const res = await mxAwaitResult({ handle: 'inv_01HZ…', wait_ms: 0 }, deps);
//    ^ ToolResult — ok | denied | error (terminal), or running | awaiting_approval (still pending)
```

- **Lifecycle.** `running` → `ok` / `denied` / `error` once the work completes;
  `awaiting_approval` → `ok` / `denied` once the operator decides **out-of-process**
  and the **daemon re-runs the authorize pipeline at release** (design §5). The
  resolver only **observes** state through a read RPC (`invocation.get`); it issues
  no decision and exposes no approve/deny/mutate surface to the model.
- **`wait_ms` semantics.** Omitted or `0` ⇒ a single, non-blocking probe. `> 0` ⇒
  block up to `wait_ms` (a client-side poll loop with a bounded interval),
  returning early on the first terminal state and otherwise the last pending state
  at the deadline. `wait_ms` is a **logical resolution budget** realised as many
  short reads — each probe uses the client's normal per-call transport timeout,
  independent of `wait_ms` (it does not stretch a single socket read).
- **Timeout is *not* an error (the crux).** A `wait_ms` expiry that finds the
  invocation still pending returns the **pending** envelope (`running` /
  `awaiting_approval`, `error: null`) — **never** `errored('timeout')`. The
  `timeout` *code* is reserved for a genuine transport/daemon fault (a probe that
  could not complete). A `wait_ms` expiry is a *successful poll that found the work
  still in progress*.
- **It is a read verb** — no `idempotency_key`; repeated polling of the same handle
  is naturally safe (terminal states are stable).

### The handler pattern (the precedent T104–T108 follow)

`mx_await_result` is the **first** handler. Handlers live in `src/handlers/` and
depend only on an **injected** daemon-call seam — they open no socket, read no env
var, and import no concrete client:

```ts
import type { DaemonCall, HandlerDeps } from '@mx-loom/registry';

type DaemonCall = Pick<MxTransport, 'call'>; // a structural subset of the transport
interface HandlerDeps {
  readonly daemon: DaemonCall;               // a concrete MxClient, or a test fake
  readonly sleep?: (ms: number) => Promise<void>; // injected clock for the poll loop
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
}
```

Because `MxTransport` is an **interface**, the seam imports it `type`-only (erased
under `verbatimModuleSyntax`) — so the registry keeps `@mx-loom/toolbelt` a
**devDependency** and gains **no runtime dependency** on it, exactly as `errors.ts`
imports `TransportErrorCode`. A concrete `MxClient` (which already enforces the
deny-by-default env allowlist and inbound `redactSecrets`, T008) is injected by the
caller. The pure `invocationToResult` / `classifyInvocation` normalizer maps a raw
`invocation.get` response onto the T102 envelope — built **only** through the
constructor helpers, so it conforms by construction, and **never throws** (an
unrecognised state degrades to a safe `errored('internal', …)`).

> **Staged at the two-daemon round-trip.** The exact `invocation.get` method/param
> name, the invocation **state vocabulary** `classifyInvocation` keys on, the
> held-invocation `approval` fields, and the `audit_ref` availability are authored
> against the design's named states now and pinned to the verified v0.2.1 surface
> behind `MXL_CONFORMANCE_TWO_DAEMON=1`. `task.watch` (push-based) replaces the
> poll backend in T302 (M3) without changing this tool contract.

## The discovery handlers (T104)

The two **discovery** verbs are `sync` **local daemon reads** — "who is in the
workspace and what can they do?" — and the prerequisite for delegation (T105):
you cannot call `mx_delegate_tool` until you can discover a target and read the
`input_schema` of the tool you want to invoke.

```ts
import { mxFindAgents, mxDescribeAgent } from '@mx-loom/registry';
import { createClient } from '@mx-loom/toolbelt';

const deps = { daemon: createClient() };              // any { call } satisfies DaemonCall

await mxFindAgents({ capability: 'run_tests' }, deps);
//    ^ ok({ agents: AgentSummary[] }) — agents advertising the capability
await mxDescribeAgent({ agent_id: 'agent_b' }, deps);
//    ^ ok({ agent: AgentDetail, tools: PublishedTool[] }) — the target's published ToolSchema[]
```

- **`mx_find_agents`** — one `agent.list` call, then the `capability` / `tool` /
  `liveness` filters applied **client-side** with **AND** semantics (an absent
  filter matches all). The success payload is `{ agents: AgentSummary[] }` — the
  array is wrapped in an object so it satisfies the envelope `ok` branch
  (`result` must be an object). The `tool` filter reads names from the list row
  when it carries them, else resolves `agent.tools` for the capability+liveness
  survivors only (bounded fan-out; a per-agent fault is tolerated as "no match").
- **`mx_describe_agent`** — `agent.tools` (the published `schemas: ToolSchema[]`,
  with `input_schema` / `output_schema` passed through **verbatim** for T105) +
  `agent.list` (the liveness / workspace / load the schemas RPC omits), merged and
  projected. `agent.show` is **not** in the verified v0.2.1 surface, so it is
  defaulted off; an unknown `agent_id` surfaces as `not_found`.
- **Secret-free by projection.** Both verbs project the daemon `AgentState` onto a
  strict non-secret subset and deliberately **drop** the public-but-noisy
  identifiers (`matrix_user_id`, `device_id`, `signing_key_id`,
  `signing_public_key`, `state_rev`) so they never reach the model context. The
  projectors are **allowlist-by-construction** — only named fields are copied, so a
  new upstream `AgentState` field cannot silently leak.
- **Local read ⇒ all-null `audit_ref`.** There is no Matrix round-trip, so the
  result carries `EMPTY_AUDIT_REF` (every id `null`, structurally present, never
  fabricated). Both handlers **never throw** — a transport/daemon fault maps onto
  the closed taxonomy through the shared `faultToResult` (extracted from
  `mx_await_result`), mirroring the T103 precedent.

## The delegation handler (T105)

`mx_delegate_tool` is the **primary delegation verb** — the spine of the fabric:
discovery (T104) tells the model who is in the room and what they publish;
`mx_delegate_tool` is the verb that **acts** on that mesh by invoking a *named
tool* on a remote agent and turning the daemon's `CallResponse` into the T102
envelope (design §2 / §4.1 / §5).

```ts
import { mxDelegateTool } from '@mx-loom/registry';
import { createClient } from '@mx-loom/toolbelt';

const deps = { daemon: createClient(), room: session.room }; // room from MxSession, NOT model input
const res = await mxDelegateTool(
  { agent: 'agent_b', tool: 'run_tests@1.0.0', args: { filter: 'unit' } },
  deps,
);
//    ^ ToolResult — ok (sync success), running / awaiting_approval (deferred), denied / error
```

- **Four phases (+ optional inline wait).** `agent.tools {agent_id}` → resolve the
  target tool's published `input_schema` → **validate `args` against it before
  dispatch** → `call.start` → normalize the `CallResponse`. A non-terminal result
  plus a positive `wait_ms` composes `mx_await_result` so a fast remote tool feels
  synchronous (inheriting T103's "a `wait_ms` expiry is the pending envelope, not a
  `timeout`").
- **`input_schema` pass-through (AC 1/AC 2).** The inner schema is re-fetched from
  the target's published `ToolSchema` (never trusted from model input) and the
  caller's `args` are validated against it. Invalid args return
  `error` / `invalid_args` **before `call.start` is dispatched**. Client-side
  validation is a fast-fail convenience — the receiving daemon re-validates
  in-sandbox, so an absent/malformed target schema degrades to "let the daemon
  decide", never a hard block.
- **Every disposition mapped (AC 3).** `callResponseToResult` (the sibling of
  `invocationToResult`, sharing every reader/classifier) maps a sync `ok` with the
  inner tool's `result`, a deferred `running` handle, a held `awaiting_approval`
  (handle + approval block), and the denial/fault terminals — so the initial
  delegation result and a later `mx_await_result` poll agree by construction.
  `policy_denied` → `denied('policy_denied')`, `untrusted_key` → `denied(…)`.
- **Idempotency, end-to-end.** Uses the caller's `idempotency_key` if supplied,
  else generates one once per invocation, places it in the `call.start` params, and
  never regenerates it on a transport-level retry (`MxClient.withRetry` reuses
  `params` verbatim, so the daemon dedupes).
- **Populated `audit_ref`.** Unlike the T104 local reads, delegation is a real
  Matrix round-trip, so `audit_ref` is filled from the `CallResponse` correlation
  ids (`null` when the daemon omits one, never fabricated).
- **Injected deps, no authority.** `DelegateDeps` add an injected JSON Schema
  `validator` (default: a lazily-created Ajv validator) and the session `room` (the
  model never names a Matrix room; a missing room fails fast as `internal`). The
  handler emits a *signed request* only — trust/policy/approval/sandbox all run
  out-of-process on the receiving daemon. The secret boundary is the concrete
  `MxClient` (`assertNoCredentialShapedArgs` before dispatch → a credential-shaped
  `args` key surfaces as `invalid_args`; `redactSecrets` on the inbound result),
  which the registry never re-implements.

> **Staged at the two-daemon round-trip.** The `call.start` param names
> (`room`/`agent`/`tool`/`args`/`idempotency_key`), the `CallResponse` disposition
> vocabulary, the held-invocation `approval` fields, and the `audit_ref`
> availability are authored against the design's named shapes now and pinned behind
> `MXL_CONFORMANCE_TWO_DAEMON=1`. A new daemon code degrades to `internal` (never
> the wrong code), never throws.

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

### T102 resolved decisions

| # | Decision |
|---|---|
| #1 Envelope home | **Extend `@mx-loom/registry`** (vs. a new `@mx-loom/contract` leaf) — consistent with the `area/registry` label and T101 precedent; the registry's remit grows from "pure descriptors" to "descriptors + the result contract". |
| #2 Status↔code partition | denial-set `{policy_denied, untrusted_key, approval_denied, approval_expired}` → `denied`; fault-set `{timeout, not_found, invalid_args, target_offline, internal}` → `error`. Compiler-enforced via `DenialCode`/`FaultCode`; schema-enforced per branch. |
| #7 Idempotency location | The key rides in **handler-built RPC params**, not a `CallOptions` option — keeps `MxClient` method-agnostic; `withRetry`'s verbatim param reuse gives retry-stability for free. Failover stays the conservative `not_running`-only policy (unchanged). |
| #8 Transport-code coupling | **Type-only `import type { TransportErrorCode }`** from the toolbelt (erased under `verbatimModuleSyntax`) — single source of truth, no runtime dep (toolbelt stays a devDependency). |
| #3/#4/#5 Pending round-trip | The daemon error vocabulary (`mapDaemonError` keys), the `audit_ref` field availability, and the `idempotency_key`/`nonce` wire param name are staged behind the two-daemon conformance fixture (`MXL_CONFORMANCE_TWO_DAEMON=1`); authored against the design's named codes with safe fallbacks now. |

## Tests

Pure unit tests — no daemon, no socket, no env gating. Run with `pnpm test`. The
T102 envelope/taxonomy/idempotency tests (schema conformance, the closed-set
regression, the exhaustive mappers, and the idempotency dedup via a fake daemon)
land in the dedicated tests phase; the live `idempotency_key` dedup + the real
daemon error vocabulary ride the staged two-daemon conformance fixture.
