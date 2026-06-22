# Registry: Normalized Result Envelope + Error Taxonomy + Idempotency (T102 / #10)

> Implementation spec for GitHub issue **#10 — T102 · registry: normalized result envelope + error taxonomy + idempotency**.
> Labels: `area/registry` · `priority/P0` · `type/feature`. Milestone **M1 — Delegation MVP**. Estimate **M**.
> Sources: [`docs/mx-agent-tool-fabric-design.md`](../docs/mx-agent-tool-fabric-design.md) (§4.2 the one normalized
> result envelope, §4.4 idempotency, §4.5 the stable error taxonomy, §4.6 audit correlation, §4.7 secret-free
> contract, §5 the invocation flow incl. the approval-gated path, §6 security, §7 audit),
> [`docs/backlog.md`](../docs/backlog.md) (`T102` and what it unblocks — T103 deferred-result, T105/T106
> delegation+exec handlers, T107/T108, T113 audit mirror, T114 golden test),
> [`docs/mx-agent-surface-v0.2.1.md`](../docs/mx-agent-surface-v0.2.1.md) (the verified daemon surface;
> `call.start`/`exec.start`/`invocation.*` round-trips staged behind the two-daemon fixture), the landed
> **`@mx-loom/registry`** (T101 — `ToolDescriptor`, `loadRegistry`, the Ajv-backed `SchemaValidator`/draft-07
> seam, the no-authority + secret-free invariants) and **`@mx-loom/toolbelt`** (M0 — `MxClient.call`, the closed
> `TransportError`/`TransportErrorCode` taxonomy, `assertNoCredentialShapedArgs`/`redactSecrets`, the
> `correlation_id` session stamping in T005).
> Blocked-by **#9 (T101)** — satisfied: the registry package, descriptor model, and validator seam exist.
> **Unblocks T103** (deferred-result protocol / `mx_await_result`), **T105/T106** (delegation + guarded-exec
> handlers that construct envelopes), **T107/T108** (context + cancel/status handlers), **T113** (the Postgres
> `audit_ref` mirror), and **T114** (the approval-gated golden end-to-end test).

## Problem Statement

Design §4.2 fixes a single hard requirement: **one normalized result envelope is the only shape every mx-loom
tool returns** —

```jsonc
{ "status": "ok|running|awaiting_approval|denied|error",
  "result": {…}|null, "error": {"code": <closed set>, "message": "…"}|null,
  "handle": "inv_…"|null, "approval": {request_id, risk, summary, expires_at}|null,
  "audit_ref": {invocation_id, request_id, room, event_id} }
```

so that **any** runtime binding (MCP T109, Claude shim T110, ADK/OpenCode/Pi later) reacts to results
programmatically — `untrusted_key` → onboarding hint, `awaiting_approval` → keep planning, `target_offline` →
retry elsewhere — without parsing prose. Today that envelope does not exist anywhere in the repo:

- **T101 deliberately stopped short of it.** `@mx-loom/registry` ships the descriptor model
  (`name`/`description`/`input_schema`/`output_schema`/`async_semantics`) and a fail-fast loader, but its
  doc-comments are explicit that "the result **envelope** below is T102, not part of the descriptor" and that
  T101 "introduces no `status`/`error`/`handle`/`audit_ref` types." A descriptor declares the *shape of a
  success payload* (`output_schema`); nothing yet wraps that payload (or an error/handle/approval) in the
  common envelope.
- **The toolbelt has only the raw transport taxonomy.** `MxClient.call()` resolves the **raw daemon RPC
  `result`** and rejects with a `TransportError` carrying a code from a *different*, closed set
  (`not_running|connect_failed|timeout|closed|frame|protocol|rpc|invalid_args`). `transport.ts` states plainly
  that "the model-facing result envelope (`{status, result, error, …}`) and its `error.code` set are M1
  (T102), not here." Nothing maps a transport fault — or a daemon `CallResponse{ok:false}` — onto the
  *model-facing* taxonomy (`policy_denied|untrusted_key|approval_denied|approval_expired|timeout|not_found|
  invalid_args|target_offline|internal`).
- **Nothing plumbs `idempotency_key`.** Design §4.4 requires every mutating call to carry a client-supplied
  `idempotency_key` (the daemon already uses `idempotency_key`/`nonce` for replay protection) so a retried tool
  call does not double-execute. `client.ts` even gates its failover policy on this gap: it fails over IPC→CLI
  *only* on `not_running` because "until `idempotency_key` is plumbed (M1) the client must not take that risk."
  T102 is that plumbing.

T102 closes the gap by introducing, in `@mx-loom/registry`, **the envelope contract**: its TypeScript types, a
draft-07 **envelope JSON Schema** (validated with the same Ajv seam T101 ships), the **closed `error.code` set**
as a single source of truth (with the transport→envelope mapping), envelope **constructor helpers** that make a
non-conforming envelope unrepresentable, and the **`idempotency_key` contract + helper** the mutating handlers
(T105/T106) thread onto outbound `call.start`/`exec.start` params. It is the contract layer; the per-tool
*construction* of envelopes is the handlers' job (T104–T108), and the *deferred-result resolution* of a
`running`/`awaiting_approval` handle is T103.

## Goals

- Define the **result-envelope types** in `@mx-loom/registry`: `ToolResult` (the envelope), `ToolStatus`
  (`ok|running|awaiting_approval|denied|error`), `ToolError` (`{code, message}`), `ErrorCode` (the closed set),
  `ApprovalInfo` (`{request_id, risk, summary, expires_at}`), and `AuditRef`
  (`{invocation_id, request_id, room, event_id}`) — matching design §4.2 field-for-field.
- Ship a **draft-07 envelope JSON Schema** (a `status`-discriminated union enforcing field-presence rules per
  status) and validate it with the existing `SchemaValidator`/`createAjvValidator` seam, so **AC 1 — "every
  tool result conforms to the envelope schema"** is mechanically checkable. The schema is the contract; helper
  outputs are tested against it.
- Make the **`error.code` set closed and tested (AC 2):** a single `ERROR_CODES` const → the `ErrorCode` type,
  an `isErrorCode()` guard, and a regression test pinning the set to **exactly** the nine documented codes —
  `policy_denied`, `untrusted_key`, `approval_denied`, `approval_expired`, `timeout`, `not_found`,
  `invalid_args`, `target_offline`, `internal`.
- Provide **envelope constructor helpers** — `ok()`, `running()`, `awaitingApproval()`, `denied()`, `errored()`
  — that are the only sanctioned way to build a `ToolResult`, so any handler built on them conforms by
  construction (every helper requires an `audit_ref`; each sets exactly the fields its status permits).
- Provide a **fault→envelope mapper**: `mapTransportError(code)` (toolbelt `TransportErrorCode` → `ErrorCode`,
  exhaustive/compile-checked) and `mapDaemonError(daemonError)` (a `CallResponse{ok:false}` / JSON-RPC error
  object → `ErrorCode`, with an `internal` fallback for any unrecognised daemon code), so the handlers
  translate every failure mode onto the closed taxonomy in one place.
- Plumb **client-supplied idempotency (AC 3):** an `idempotency_key` field added to the **mutating** descriptors
  (`mx_delegate_tool`, `mx_run_command`) input schemas, a `newIdempotencyKey()` generator, and the documented
  contract that the mutating handlers attach the key to the outbound `call.start`/`exec.start` params and reuse
  the **same** key on every transport-level retry — so the daemon's replay protection dedupes and a retried
  call does not double-execute.
- **Export and document** the envelope contract, the taxonomy, and the idempotency contract as public API of
  `@mx-loom/registry`.

## Non-Goals

- **Deferred-result resolution (T103, explicit out-of-scope).** T102 defines the `running`/`awaiting_approval`
  statuses and the `handle`/`approval` fields, but `mx_await_result(handle, wait_ms)` — polling a handle to a
  terminal envelope, the `wait_ms` timeout semantics, `invocation.get`/`task.watch` — is **T103**. T102 only
  fixes the *shape* a deferred result takes.
- **The per-tool handlers that construct envelopes (T104–T108).** `mx_find_agents`→`agent.list`,
  `mx_delegate_tool`→`call.start`, `mx_run_command`→`exec.start`, etc. map verbs to daemon RPCs, build the
  request, validate args, and *call the T102 helpers/mapper to produce the envelope*. T102 supplies the
  contract + helpers; it executes nothing and makes no daemon call.
- **Validating `result` against a descriptor's `output_schema`.** The envelope schema validates the envelope
  *structure* (and that `result` is an object on `ok`). Validating the success payload against the specific
  tool's `output_schema` is the handler's job (T105) using the T101 `SchemaValidator`; T102 does not couple the
  envelope schema to any one tool.
- **Rejecting a bad model call as `invalid_args` before dispatch.** That is T105's AC (it reuses the T101
  compiled input validator + the T008 credential guard). T102 only defines the `invalid_args` *code* and how a
  pre-dispatch rejection is rendered into the envelope.
- **The audit mirror (T113).** T102 carries `audit_ref` on every envelope; **writing a Postgres row** per
  result is T113. T102 changes no storage.
- **Loosening the toolbelt failover policy.** Plumbing `idempotency_key` *enables* safe retry of mutating calls
  across transports, but T102 keeps `MxClient`'s conservative `not_running`-only IPC→CLI failover unchanged.
  Widening it is a separate, riskier change (Open Question #7).
- **A `cancelled` terminal status.** `mx_cancel` (T108) transitions a handle to cancelled; whether that needs a
  new envelope status or is surfaced through `denied`/`error`+`mx_await_result` is decided with T108 (Open
  Question #6). T102 keeps the documented **five** statuses closed.
- **Streaming / partial results into the model** (design §9 — v2+). The envelope is a single terminal-or-handle
  shape; no `StreamChunk` plumbing.

## Relevant Repository Context

**Stack.** TypeScript (ESM, `"type": "module"`), pnpm workspace (`packages/*` + `adw_sdlc`), Node ≥ 20.19,
vitest 4.x, Apache-2.0, strict nodenext tsconfig (`strict`, `noUncheckedIndexedAccess`,
`verbatimModuleSyntax`, `isolatedModules`). Two workspace packages exist today: `@mx-loom/toolbelt`
(`packages/toolbelt`, M0) and `@mx-loom/registry` (`packages/registry`, T101).

**The issue's "repo is docs-only" framing is stale** (it predates M0/T101). M0 and T101 are built; T102 extends
the existing `@mx-loom/registry` package. Verified by reading the tree:

- **`@mx-loom/registry` (T101 — the package T102 extends):**
  - `src/descriptor.ts` — `ToolDescriptor` (`name`/`description`/`input_schema`/`output_schema`/
    `async_semantics`), `JsonSchema`, `AsyncSemantics`, `TOOL_NAME_RE`, `defineDescriptor()` (deep-freezes).
    Doc-comments explicitly defer the envelope to T102.
  - `src/descriptors/*.ts` — the 7 P0 descriptor consts. `delegate-tool.ts` and `run-command.ts` are the two
    **`deferred`** mutating verbs (`mx_delegate_tool` already declares `wait_ms`; both will gain
    `idempotency_key`). `await-result.ts` is `sync`.
  - `src/registry.ts` — `loadRegistry()` / `ToolRegistry` / `DescriptorValidationError`; runs structural →
    JSON-Schema-validity → uniqueness → no-authority → secret-free-shape checks at construction.
  - `src/validator.ts` — `SchemaValidator` seam + `createAjvValidator()` (Ajv `strict:false`, draft-07);
    `JSON_SCHEMA_DIALECT = 'http://json-schema.org/draft-07/schema#'`. **T102 reuses this to validate the
    envelope schema** — no new validator dependency.
  - `src/security.ts` — `CREDENTIAL_KEY_RE` (mirrors the toolbelt's T008 guard), `findCredentialShapedProperty`,
    the no-authority allowlist. **Verified:** `idempotency_key` does **not** match `CREDENTIAL_KEY_RE` (the
    regex has no bare-`key` alternative; only `api[_-]?key`/`signing[_-]?key`/`private[_-]?key`), so adding it
    to a descriptor's `input_schema` passes the loader's secret-free-shape check.
  - `src/index.ts` — the public barrel T102 extends; `ajv` is the package's one runtime dep.
- **`@mx-loom/toolbelt` (M0 — what produces the faults the envelope normalizes):**
  - `src/transport.ts` — the `MxTransport` seam; `TransportError`/`TransportErrorCode` (re-exports of
    `IpcError`/`IpcErrorCode`). The closed transport set is `not_running | connect_failed | timeout | closed |
    frame | protocol | rpc | invalid_args` (`src/ipc/errors.ts`). This is the **input** to `mapTransportError`.
  - `src/client.ts` — `MxClient.call(method, params?, options?)` resolves the raw RPC `result`; applies
    `assertNoCredentialShapedArgs` (outbound, both transports) + `redactSecrets` (inbound) from `src/guards.ts`;
    `withRetry` reuses `params` verbatim on a transport-level retry (so an `idempotency_key` placed in `params`
    is automatically stable across retries — no transport change needed for AC 3). The failover doc-comment
    names the `idempotency_key` gap T102 fills.
  - `src/correlation.ts` / T005 — the session stamps a stable `correlation_id` on outbound calls; relevant to
    `audit_ref` correlation (Open Question #4).
  - `CallOptions` today is `{ timeoutMs? }` only.

**Verified daemon surface (`docs/mx-agent-surface-v0.2.1.md`, T001) — what the envelope normalizes:**

- ✅ `daemon.status`, `agent.register`/`list`/`tools`, `workspace.status`, `trust.fingerprint` round-trip live.
- ◻️ **`call.start` / `exec.start` / `invocation.*` / `approval.decide`** are *flags-confirmed but full
  round-trip is staged* behind the two-daemon conformance fixture (`MXL_CONFORMANCE_TWO_DAEMON=1`,
  `delegate.conformance.test.ts`). **Consequence:** the exact `CallResponse` success/error field names, the
  daemon's own error vocabulary (what it returns for policy-denied / untrusted / not-found / target-offline),
  the `audit_ref` field availability (`invocation_id`/`request_id`/`room`/`event_id`), and the
  `idempotency_key`/`nonce` request param names are **not yet live-verified**. T102 must define the contract
  against the design doc and **flag these as decisions to confirm** at the two-daemon round-trip, not assume
  them (Open Questions #3, #4, #5).

**Does NOT exist yet (net-new in T102):** any envelope type/schema/helper; the `ErrorCode` taxonomy and the
transport/daemon→envelope mappers; the `idempotency_key` field on any descriptor; `newIdempotencyKey()`. Grep
for `status`/`error.code`/`handle`/`audit_ref`/`idempotency` across `packages/*/src` finds them only in
doc-comments (the T102 forward-references), never as code.

## Proposed Implementation

Add the envelope **contract** to `@mx-loom/registry` as a small set of pure, dependency-light modules (reusing
the T101 Ajv seam), extend the two mutating descriptors with `idempotency_key`, and document the handler-side
plumbing contract. No daemon calls, no `MxClient` runtime dependency, no behavior — handlers (T104–T108)
consume this to build envelopes.

### 0. Where it lives (recommended)

**Recommendation: extend `@mx-loom/registry`** (`packages/registry/src/`), consistent with the `area/registry`
label and T101's precedent. New modules: `src/envelope.ts` (types + helpers), `src/errors.ts` (the closed
taxonomy + mappers), `src/envelope-schema.ts` (the draft-07 schema), `src/idempotency.ts`
(`newIdempotencyKey` + the key contract). This expands the registry package's remit slightly — from "pure
descriptors" to "descriptors **+** the result contract" — which is the natural home and what the issue label
implies. *Flag this remit expansion as a decision to confirm (Open Question #1); the alternative is a dedicated
`@mx-loom/contract` leaf package, at the cost of more workspace wiring.*

### 1. The envelope types (`src/envelope.ts`)

```ts
export type ToolStatus = 'ok' | 'running' | 'awaiting_approval' | 'denied' | 'error';

export interface ToolError { readonly code: ErrorCode; readonly message: string; } // message: human-readable, NO secrets

export interface ApprovalInfo {
  readonly request_id: string;
  readonly risk: 'low' | 'medium' | 'high';
  readonly summary: string;     // operator-facing, secret-free
  readonly expires_at: string;  // ISO-8601
}

export interface AuditRef {
  readonly invocation_id: string | null;
  readonly request_id: string | null;
  readonly room: string | null;       // "!…:server"
  readonly event_id: string | null;   // "$…"
}

/** The single shape every mx-loom tool returns (design §4.2). */
export interface ToolResult<T = unknown> {
  readonly status: ToolStatus;
  readonly result: T | null;
  readonly error: ToolError | null;
  readonly handle: string | null;        // present when status = running | awaiting_approval
  readonly approval: ApprovalInfo | null; // present when status = awaiting_approval
  readonly audit_ref: AuditRef;           // ALWAYS present (design §4.6)
}
```

**Field-presence invariants (the discriminated-union contract, enforced by the schema in §3 and by the helpers
in §2):**

| `status` | `result` | `error` | `handle` | `approval` | `audit_ref` |
|---|---|---|---|---|---|
| `ok` | object | null | null | null | required |
| `running` | null | null | string | null | required |
| `awaiting_approval` | null | null | string | object | required |
| `denied` | null | `{code ∈ denial-set}` | null | null | required |
| `error` | null | `{code ∈ fault-set}` | null | null | required |

`audit_ref` is structurally always present (an object); its inner fields may be `null` when the daemon does not
yet return them (Open Question #4).

### 2. Envelope constructor helpers (`src/envelope.ts`)

The **only** sanctioned way to build a `ToolResult`, so handlers cannot emit a non-conforming envelope. Each
helper requires an `audit_ref` and sets exactly the fields its status permits, then `deepFreeze`s the result
(reuse `freeze.ts`).

```ts
export function ok<T>(result: T, audit_ref: AuditRef): ToolResult<T>;
export function running(handle: string, audit_ref: AuditRef): ToolResult<never>;
export function awaitingApproval(handle: string, approval: ApprovalInfo, audit_ref: AuditRef): ToolResult<never>;
export function denied(code: DenialCode, message: string, audit_ref: AuditRef): ToolResult<never>;   // code ∈ denial-set
export function errored(code: FaultCode, message: string, audit_ref: AuditRef): ToolResult<never>;    // code ∈ fault-set
```

`denied()` accepts only the denial subset and `errored()` only the fault subset (compile-time `DenialCode` /
`FaultCode` subtypes of `ErrorCode`) so the status↔code partition (§4) is enforced by the type system, not just
the runtime schema.

### 3. The envelope JSON Schema (`src/envelope-schema.ts`) — AC 1

A draft-07 schema (`$schema = JSON_SCHEMA_DIALECT`) modelling the discriminated union: a base `required:
[status, result, error, handle, approval, audit_ref]` plus an `allOf` of `if status=X then {field presence}`
branches mirroring the §1 table, with `error.code` constrained to `{ enum: ERROR_CODES }`. Compile it once via
`createAjvValidator().compile(ENVELOPE_SCHEMA)` and export both `ENVELOPE_SCHEMA` (the document) and a
ready-to-use `validateEnvelope(value): boolean` (with `.errors`).

**AC 1 is satisfied** structurally: the schema is the contract; every constructor helper's output is tested to
validate against it, and hand-rolled malformed envelopes (e.g. `ok` with a non-null `error`, `awaiting_approval`
without `approval`, an out-of-set `error.code`) are tested to fail. Because handlers build envelopes **only**
through the helpers, conformance is guaranteed by construction; the *per-tool* "every result conforms" assertion
is then exercised in each handler's tests (T104–T108) and the golden test (T114) — T102 cannot test handlers
that do not exist yet, and the spec does not over-claim that it does.

### 4. The closed error taxonomy + mappers (`src/errors.ts`) — AC 2

```ts
export const ERROR_CODES = [
  'policy_denied', 'untrusted_key', 'approval_denied', 'approval_expired',
  'timeout', 'not_found', 'invalid_args', 'target_offline', 'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export function isErrorCode(x: unknown): x is ErrorCode;

// The status↔code partition (§ proposal; confirm OQ #2):
export const DENIAL_CODES = ['policy_denied', 'untrusted_key', 'approval_denied', 'approval_expired'] as const;
export const FAULT_CODES  = ['timeout', 'not_found', 'invalid_args', 'target_offline', 'internal'] as const;
export type DenialCode = (typeof DENIAL_CODES)[number];
export type FaultCode  = (typeof FAULT_CODES)[number];
```

**AC 2** is a regression test asserting `ERROR_CODES` equals **exactly** the nine codes (closed-set), that
`DENIAL_CODES ∪ FAULT_CODES` partitions it with no overlap/gap, and that `isErrorCode` accepts each and rejects
a near-miss (`'denied'`, `'POLICY_DENIED'`, `''`).

**Mappers** (one place that translates every failure mode onto the closed set):

- `mapTransportError(code: TransportErrorCode): ErrorCode` — an **exhaustive** switch (compile-checked via a
  `never` default) over the toolbelt's closed transport set. Recommended mapping:
  `timeout → timeout`; `invalid_args → invalid_args`; `not_running | connect_failed | closed | frame |
  protocol → internal` (the *local* fabric is unreachable/at-fault — distinct from `target_offline`, which is
  the *remote* agent); `rpc → ` delegate to `mapDaemonError` (a `rpc` TransportError carries the daemon's
  JSON-RPC error object). Import `TransportErrorCode` **type-only** (`import type`, erased under
  `verbatimModuleSyntax`) so the registry gains **no runtime dependency** on the toolbelt; keep `@mx-loom/toolbelt`
  a devDependency (already present) — or, to avoid even the type coupling, re-declare the transport union and
  pin it equal to the toolbelt's with a no-drift test (Open Question #8).
- `mapDaemonError(daemonError: unknown): ErrorCode` — map a `CallResponse{ok:false}` / JSON-RPC error object's
  daemon code onto the envelope set (policy-denied / untrusted-key / not-found / target-offline / approval-*),
  with an **`internal` fallback** for any unrecognised daemon code so an unknown daemon error is never silently
  dropped or mis-typed. The exact daemon error vocabulary is **pending the two-daemon round-trip** (Open
  Question #3); author the mapping against the design's named codes now and pin it with a conformance test once
  the fixture runs.

### 5. Idempotency plumbing (`src/idempotency.ts` + descriptor edits) — AC 3

Design §4.4: every **mutating** call carries a client-supplied `idempotency_key`; the daemon already dedupes on
`idempotency_key`/`nonce`. T102 supplies the contract; the daemon does the actual replay protection.

1. **Descriptor field.** Add an optional `idempotency_key` (string) to the **mutating** descriptors'
   `input_schema` — `mx_delegate_tool` and `mx_run_command` (the two `deferred` verbs). Document it as
   client-supplied: "supply a stable key to make a retry of *this same call* idempotent; omit and the handler
   generates one per invocation." (Read verbs — `mx_find_agents`, `mx_describe_agent`, `mx_get_context`,
   `mx_await_result` — do **not** get it; they are non-mutating.) `idempotency_key` passes the loader's
   secret-free-shape check (verified — it does not match `CREDENTIAL_KEY_RE`).
2. **Generator.** `newIdempotencyKey(): string` — a `node:crypto` `randomUUID()`-backed key (e.g.
   `idk_<uuid>`); built-in, no new dependency.
3. **The handler contract (documented for T105/T106; enforced by their tests).** A mutating handler:
   - uses the caller-supplied `idempotency_key` if present, else calls `newIdempotencyKey()` **once per logical
     invocation**;
   - places it in the outbound `call.start`/`exec.start` **params** (the daemon's `idempotency_key`/`nonce`
     field — exact name confirmed at the round-trip, Open Question #5);
   - **never regenerates** it on a transport-level retry. Because `MxClient.withRetry` reuses `params` verbatim,
     a key in `params` is automatically stable across retries — **so no `MxClient`/`CallOptions` change is
     required.** (An optional `CallOptions.idempotencyKey` that `MxClient` stamps onto params is rejected: it
     would make the method-agnostic transport aware of which methods mutate. Keep the key in handler-built
     params. — Open Question #7.)
4. **AC 3 test.** A fake transport/daemon that executes a side effect **once per unique `idempotency_key`** and
   returns the cached first `CallResponse` for a repeat key: invoke the mutating path twice with the **same**
   key → assert exactly one execution and identical envelopes; invoke twice with **different** keys → two
   executions. Plus a plumbing unit test that a transport-level retry of one logical call carries the **same**
   key (no regeneration). The end-to-end dedup against a live daemon rides the two-daemon conformance fixture
   (since `call.start` round-trip is gated) — note the staging explicitly rather than implying live coverage.

### 6. Exports + docs

Barrel-export from `src/index.ts`: `ToolResult`, `ToolStatus`, `ToolError`, `ApprovalInfo`, `AuditRef`,
`ErrorCode`/`ERROR_CODES`/`isErrorCode`, `DenialCode`/`FaultCode`/`DENIAL_CODES`/`FAULT_CODES`, the helpers
(`ok`/`running`/`awaitingApproval`/`denied`/`errored`), `mapTransportError`/`mapDaemonError`, `ENVELOPE_SCHEMA`/
`validateEnvelope`, and `newIdempotencyKey`. Update the package README with the envelope contract, the
status↔code table, the taxonomy, and the idempotency contract.

## Affected Files / Packages / Modules

**New (in `packages/registry`):**
- `src/envelope.ts` — `ToolResult`/`ToolStatus`/`ToolError`/`ApprovalInfo`/`AuditRef` + the constructor helpers.
- `src/errors.ts` — `ERROR_CODES`/`ErrorCode`/`isErrorCode`, `DENIAL_CODES`/`FAULT_CODES`, `mapTransportError`,
  `mapDaemonError`.
- `src/envelope-schema.ts` — `ENVELOPE_SCHEMA` (draft-07 discriminated union) + `validateEnvelope`.
- `src/idempotency.ts` — `newIdempotencyKey`.
- `test/envelope.test.ts`, `test/envelope-schema.test.ts`, `test/errors.test.ts`, `test/idempotency.test.ts`,
  `test/envelope.security.test.ts` (see *Testing Plan*).

**Modify (in `packages/registry`):**
- `src/descriptors/delegate-tool.ts`, `src/descriptors/run-command.ts` — add the optional `idempotency_key`
  field to `input_schema` (mutating verbs only).
- `src/index.ts` — export the new envelope/taxonomy/idempotency surface.
- `README.md` — document the envelope contract + taxonomy + idempotency.
- `package.json` — likely **no change** (Ajv already a dep; `@mx-loom/toolbelt` already a devDep for the
  type-only transport-code import; `node:crypto` is built-in). Confirm during implementation.

**Read for context (no change):** `packages/toolbelt/src/transport.ts` + `src/ipc/errors.ts` (the transport
taxonomy that `mapTransportError` consumes), `src/client.ts`/`src/retry.ts` (the params-reuse-on-retry behavior
AC 3 relies on), `src/guards.ts` (`CREDENTIAL_KEY_RE` — confirm `idempotency_key` is clean),
`src/correlation.ts` (the `correlation_id` relevant to `audit_ref`), `docs/mx-agent-surface-v0.2.1.md`
(`CallResponse`/`invocation.*` shapes — staged), design §4/§5/§6/§7.

**Downstream consumers (separate issues, not modified here):** T103 (`mx_await_result` resolves a handle into a
T102 envelope), T105/T106 (handlers build envelopes via the helpers + mappers + idempotency contract), T107/T108,
T113 (reads `audit_ref` to write a row), T114 (golden test asserts envelopes + audit refs).

## API / Interface Changes

**New public API of `@mx-loom/registry` (additive — no breaking changes):**
- Types: `ToolResult<T>`, `ToolStatus`, `ToolError`, `ApprovalInfo`, `AuditRef`, `ErrorCode`, `DenialCode`,
  `FaultCode`.
- Values: `ERROR_CODES`, `DENIAL_CODES`, `FAULT_CODES`, `isErrorCode()`; helpers `ok`/`running`/
  `awaitingApproval`/`denied`/`errored`; `mapTransportError()`/`mapDaemonError()`; `ENVELOPE_SCHEMA`/
  `validateEnvelope()`; `newIdempotencyKey()`.

**Tool-descriptor surface:** `mx_delegate_tool` and `mx_run_command` gain an **optional** `idempotency_key`
string in their `input_schema` (additive; existing required fields unchanged). All bindings that render
descriptors (T109/T110) pick this up automatically.

**Result-envelope surface:** this issue *defines* the model-facing result envelope (it did not exist). It is
the new contract every binding renders results into.

**Daemon-RPC surface:** **none** (T102 makes no daemon call). The mutating handlers (T105/T106) will *add an
`idempotency_key` field to the params they send* to `call.start`/`exec.start`, but that wiring is those issues';
T102 defines the contract and the field name is confirmed at the two-daemon round-trip (Open Question #5).

**CLI surface:** none. **`MxClient`/`CallOptions`/`MxTransport`:** **unchanged** — the idempotency key rides in
handler-built RPC params, not a new transport option (see §5).

## Data Model / Protocol Changes

- **New: the result-envelope data model** — `ToolResult` and its constituents (`ToolStatus`, `ToolError`,
  `ApprovalInfo`, `AuditRef`), plus the **draft-07 envelope JSON Schema**. This is the model-facing contract the
  bindings render; it is **not** a Boundary-B wire change (nothing is sent to the daemon differently).
- **Error taxonomy:** the new closed model-facing `error.code` set
  (`policy_denied|untrusted_key|approval_denied|approval_expired|timeout|not_found|invalid_args|target_offline|
  internal`) — **distinct from** the toolbelt's transport `TransportErrorCode` set, with `mapTransportError`/
  `mapDaemonError` bridging them. The transport taxonomy is unchanged.
- **Idempotency-key:** a new optional `idempotency_key` field on the **mutating** descriptors' `input_schema`,
  and the contract that handlers thread it onto outbound `call.start`/`exec.start` params (daemon
  `idempotency_key`/`nonce`). No serialization/framing change to the transport.
- **`audit_ref`:** the envelope always carries `audit_ref` (`{invocation_id, request_id, room, event_id}`),
  populated by handlers from the daemon `CallResponse`/invocation fields. The **Postgres audit row is T113**;
  T102 changes no storage. The exact daemon field availability is pending verification (Open Question #4).
- **Status set:** the closed five-status set (`ok|running|awaiting_approval|denied|error`); no `cancelled`
  (Open Question #6).

## Security & Compliance Considerations

The envelope is the model-facing **output** boundary; its job is to surface *status and correlation* without
ever leaking authority or secrets (design §4.7, §6, §7).

- **Secret-free contract — both directions.** No envelope field carries a credential. `error.message`,
  `approval.summary`, and all `audit_ref` ids are human/operator-readable and **must never contain a secret or
  token** — mappers/helpers construct messages from a fixed vocabulary + the (non-secret) daemon code, never by
  echoing raw daemon output verbatim. The new `idempotency_key` descriptor field is **not** credential-shaped
  (verified against `CREDENTIAL_KEY_RE`) and carries no authority — it is a client-chosen dedup nonce, not a
  capability. The toolbelt's inbound `redactSecrets` (T008) remains the defense-in-depth backstop on
  `MxClient.call`; T102 adds no new path that could carry a secret.
- **No authority surface; approval is a status, never a grant.** The envelope **reports** governance outcomes
  (`awaiting_approval`, `denied` with `approval_denied`/`approval_expired`/`policy_denied`/`untrusted_key`) but
  confers **no** ability to approve, trust, or set policy. There is no approve/deny/mutate field anywhere in the
  envelope. The model experiences an approval purely as the `awaiting_approval` status + the read-only
  `approval` block (`request_id`/`risk`/`summary`/`expires_at`); the operator decides out-of-process and the
  receiving daemon **re-validates against live policy at release** (design §5, §6) — T102 introduces nothing
  that lets cognition self-approve or escalate.
- **Out-of-process enforcement unchanged.** Trust (Ed25519 store), deny-by-default `policy.toml`, sandbox, and
  the human approval gate all execute on the receiving mx-agent daemon. T102 only *names* their outcomes in a
  closed taxonomy so a runtime can react (`untrusted_key` → onboarding hint, `policy_denied` → don't retry,
  `target_offline` → try elsewhere). The envelope **must not** imply any enforcement happens in-runtime.
- **Secret boundary (Boundary A) untouched.** The envelope crosses Boundary A toward the model; it carries only
  status/result/correlation. Matrix tokens, Ed25519 signing keys, provider keys, and `GH_TOKEN` never appear in
  it. The registry remains pure in-process metadata + contract — it spawns nothing, opens no socket, reads no
  env var, and the deny-by-default env allowlist / sandbox stay daemon-side.
- **Audit correlation on every result.** `audit_ref` is structurally always present so the app layer (T113) can
  tie "model decided X" ↔ "daemon executed Y" ↔ "operator approved Z" to the signed Matrix events — without the
  ids themselves being secret. When the daemon does not yet return an id, the field is `null` (never fabricated).
- **Idempotency is not a security control by itself.** It prevents *double-execution on retry*; it is the
  daemon's replay protection that enforces it. T102 must not let a client-supplied key bypass any authorize
  step — the daemon re-runs sig→trust→policy regardless of the key (design §5).
- **Logging/redaction.** Never log envelope `error.message`/`approval.summary` to a sink that could capture a
  secret; mappers log only the **code** + a fixed path, never raw daemon payloads. `validateEnvelope` errors
  name fields/paths, never values.

## Testing Plan

All tests are **pure unit tests** (the contract is static; no daemon/socket), except the explicitly-staged
two-daemon conformance items.

**Envelope types + helpers (`test/envelope.test.ts`):**
- Each helper (`ok`/`running`/`awaitingApproval`/`denied`/`errored`) returns the correct status with exactly
  the §1-table field presence, requires an `audit_ref`, and returns a frozen object (mutation is a no-op/throws).
- `denied()` rejects a fault code and `errored()` rejects a denial code at the **type** level (a `// @ts-expect-error`
  fixture) — proving the status↔code partition is compiler-enforced.

**Envelope schema (`test/envelope-schema.test.ts`) — AC 1:**
- Every constructor helper's output **validates** against `ENVELOPE_SCHEMA` (`validateEnvelope` → true).
- Malformed envelopes **fail**: `ok` with non-null `error`; `error`/`denied` with null `error`;
  `awaiting_approval` missing `approval`; `running` missing `handle`; an out-of-set `error.code`; a missing
  `audit_ref`. Each asserts `validateEnvelope` → false.
- `ENVELOPE_SCHEMA` itself compiles against the draft-07 meta-schema via `createAjvValidator` (the schema is
  well-formed) — consistency with the T101 dialect.

**Error taxonomy + mappers (`test/errors.test.ts`) — AC 2:**
- `ERROR_CODES` equals **exactly** the nine documented codes (closed-set, order-insensitive); `DENIAL_CODES ∪
  FAULT_CODES` partitions it with no overlap/gap; `isErrorCode` accepts each, rejects near-misses.
- `mapTransportError` is **exhaustive** over every `TransportErrorCode` (a table test over the full toolbelt
  set) and returns a valid `ErrorCode` for each; the `never`-default guard means a future transport code fails
  the build until mapped.
- `mapDaemonError` maps each known daemon error identifier to the expected envelope code and falls back to
  `internal` for an unknown/garbage input (never throws, never returns a non-`ErrorCode`).

**Idempotency (`test/idempotency.test.ts`) — AC 3:**
- `newIdempotencyKey()` returns a unique, non-empty, non-credential-shaped string each call (and is **not**
  rejected by `CREDENTIAL_KEY_RE` / `assertNoCredentialShapedArgs`).
- **Dedup via a fake daemon:** a fake transport that executes a side effect once per unique key and caches the
  first `CallResponse`; two calls with the **same** key → one execution + identical envelopes; two calls with
  **different** keys → two executions.
- **No regeneration on retry:** a fake transport that fails once with a retryable transport fault then
  succeeds; assert the **same** `idempotency_key` is present on both attempts (params reused verbatim).

**Security invariants (`test/envelope.security.test.ts`):**
- The mutating descriptors (`mx_delegate_tool`, `mx_run_command`) declare `idempotency_key`, and the registry
  still loads clean (the field passes the secret-free-shape check); the read verbs do **not** declare it.
- No envelope field name or helper output path is credential-shaped; a constructed envelope round-trips through
  the toolbelt's `redactSecrets` **unchanged** (no false-positive redaction of `audit_ref`/`request_id`).

**Documentation:** a compile-checked README snippet (`ok(payload, auditRef)` → `validateEnvelope` → true) so
the public example cannot rot.

**Staged (two-daemon conformance — not in the unit gate):** once `MXL_CONFORMANCE_TWO_DAEMON=1` runs green,
add/extend `delegate.conformance.test.ts` to (a) pin `mapDaemonError` against the **real** daemon error
vocabulary, (b) confirm `audit_ref` field availability, and (c) assert live `idempotency_key` dedup
(double-dispatch executes once). Flag these as staged, not implied-live.

## Documentation Updates

- **`docs/backlog.md`** — tick T102's three ACs once landed; note that **T103** (deferred-result),
  **T105/T106** (handlers), **T107/T108**, **T113** (audit mirror), and **T114** (golden test) are unblocked.
  Record the resolved decisions (envelope home, status↔code partition, transport→envelope mapping, daemon error
  vocabulary status, `idempotency_key` param name, failover policy unchanged).
- **`docs/mx-agent-tool-fabric-design.md`** — §4.2 already specifies the envelope; add a short note that it is
  now **implemented** in `@mx-loom/registry` (the closed taxonomy + helpers + draft-07 schema), state the
  proposed status↔code partition (which §4.2's JSONC does not spell out) so the doc and code agree, and confirm
  §4.4 idempotency is plumbed as the descriptor field + handler contract. Do **not** imply the handlers
  (T104–T108), `mx_await_result` (T103), or the audit mirror (T113) exist yet.
- **`docs/mx-agent-surface-v0.2.1.md`** — once the two-daemon round-trip runs, record the **verified**
  `CallResponse` success/error field names, the daemon error vocabulary `mapDaemonError` keys on, the
  `audit_ref` field availability, and the `idempotency_key`/`nonce` request param name — closing Open Questions
  #3/#4/#5.
- **`packages/registry/README.md`** — document the `ToolResult` envelope, the status↔code table, the closed
  `error.code` set + mappers, and the `idempotency_key` contract (client-supplied vs handler-generated, reused
  on retry).

## Risks and Open Questions

1. **Envelope home — extend `@mx-loom/registry` vs. a new `@mx-loom/contract` package (confirm; recommend
   extend).** The `area/registry` label and T101 precedent point to extending the registry, which slightly
   expands its remit from "pure descriptors" to "descriptors + result contract." A dedicated contract leaf is
   cleaner separation at the cost of workspace wiring. Either satisfies the ACs.
2. **The status↔`error.code` partition (confirm; well-reasoned proposal).** Design §4.2 lists the statuses and
   the codes but does not spell out which code pairs with `denied` vs `error`. This spec proposes denial-set =
   `{policy_denied, untrusted_key, approval_denied, approval_expired}` (status `denied`) and fault-set =
   `{timeout, not_found, invalid_args, target_offline, internal}` (status `error`). Confirm — it determines the
   `denied()`/`errored()` helper signatures and the schema branches.
3. **Daemon error vocabulary for `mapDaemonError` (pending two-daemon round-trip).** The exact identifiers the
   v0.2.1 daemon returns for policy-denied / untrusted / not-found / target-offline / approval-* are not yet
   live-verified (`call.start` round-trip is gated). Author the mapping against the design's named codes with an
   `internal` fallback now; pin it with the conformance fixture later. Risk: a mis-map silently degrades a
   specific code to `internal` until verified — the fallback is safe (never wrong-types), only less specific.
4. **`audit_ref` field availability (pending verification).** Whether v0.2.1's `CallResponse`/`invocation.*`
   actually return all four of `invocation_id`/`request_id`/`room`/`event_id` is unconfirmed. Decision: the
   envelope always carries the `audit_ref` object; missing ids are `null` (never fabricated). Consider stamping
   the session `correlation_id` (T005) into `audit_ref` as a guaranteed-non-null correlation handle — confirm
   whether `correlation_id` belongs in `audit_ref` or is a separate concern.
5. **`idempotency_key` request param name (pending verification).** Design §4.4 says the daemon uses
   `idempotency_key`/`nonce`; the exact `call.start`/`exec.start` param name (and whether it is `idempotency_key`
   or `nonce` or both) is confirmed at the round-trip. The descriptor field name (`idempotency_key`) is
   client-facing and independent of the wire name; the handler maps one to the other.
6. **No `cancelled` status in T102 (confirm; defer to T108).** `mx_cancel` transitions a handle to cancelled;
   whether that needs a sixth envelope status or is surfaced via `denied`/`error` + `mx_await_result` is a T108
   decision. T102 keeps the documented five statuses closed; adding one later is additive but would touch the
   closed-set test.
7. **Idempotency lives in handler params, not `CallOptions` (confirm; recommend params).** Keeping the key in
   handler-built RPC params (vs. a new `CallOptions.idempotencyKey` the transport stamps) keeps `MxClient`
   method-agnostic and needs no transport change; `withRetry`'s verbatim param reuse gives retry-stability for
   free. Confirm we do **not** also loosen the conservative `not_running`-only failover in T102 (it is *enabled*
   by idempotency but is a separate, riskier change).
8. **Transport-code coupling direction (confirm; recommend type-only import).** `mapTransportError` needs the
   toolbelt's `TransportErrorCode`. Importing it `type`-only adds no runtime dep (toolbelt stays a devDep);
   re-declaring the union in the registry + a no-drift test avoids even the type coupling but duplicates the
   set. Recommend the type-only import for single-source-of-truth.
9. **AC 1 scope clarity.** "Every tool result conforms to the envelope schema" is satisfied *structurally* by
   T102 (schema + helpers-as-the-only-builder); the literal per-tool assertion is exercised in T104–T108 +
   T114, since the handlers do not exist yet. Confirm the reviewer accepts this reading (the spec does not
   over-claim handler coverage in T102).

## Implementation Checklist

1. **Read** design §4.2 (envelope), §4.4 (idempotency), §4.5 (taxonomy), §4.6 (audit), §4.7 (secret-free), §5
   (approval-gated flow); `docs/mx-agent-surface-v0.2.1.md` (`CallResponse`/`invocation.*` staging); the landed
   `@mx-loom/registry` (`descriptor.ts`, `validator.ts`, `security.ts`, `freeze.ts`) and the toolbelt
   `transport.ts`/`ipc/errors.ts`/`client.ts`/`guards.ts`.
2. **Confirm the gated decisions first:** envelope home (#1), status↔code partition (#2), transport-code import
   direction (#8), and that failover stays conservative (#7). Record in `docs/backlog.md`.
3. **Add the taxonomy** in `src/errors.ts`: `ERROR_CODES`/`ErrorCode`/`isErrorCode`, `DENIAL_CODES`/
   `FAULT_CODES`/`DenialCode`/`FaultCode`, `mapTransportError` (exhaustive, `never`-default) and `mapDaemonError`
   (`internal` fallback).
4. **Add the envelope types + helpers** in `src/envelope.ts`: `ToolResult`/`ToolStatus`/`ToolError`/
   `ApprovalInfo`/`AuditRef` and `ok`/`running`/`awaitingApproval`/`denied`/`errored` (each requires
   `audit_ref`, sets only its status's fields, `deepFreeze`s).
5. **Add the envelope schema** in `src/envelope-schema.ts`: the draft-07 `status`-discriminated `ENVELOPE_SCHEMA`
   + `validateEnvelope` compiled via `createAjvValidator`.
6. **Add idempotency** in `src/idempotency.ts` (`newIdempotencyKey` via `node:crypto.randomUUID`) and extend
   `mx_delegate_tool` / `mx_run_command` `input_schema` with the optional `idempotency_key` field; confirm the
   registry still loads clean (secret-free-shape check passes).
7. **Export** the new surface from `src/index.ts`.
8. **Tests:** `envelope.test.ts` (helpers + freeze + type-level partition), `envelope-schema.test.ts` (AC 1 —
   conform + reject malformed + schema compiles), `errors.test.ts` (AC 2 — closed set + exhaustive mappers),
   `idempotency.test.ts` (AC 3 — dedup via fake daemon + no-regeneration-on-retry + non-credential),
   `envelope.security.test.ts` (descriptor field clean, read verbs omit it, redaction round-trip).
9. **Verify:** `pnpm -C packages/registry typecheck` clean; `pnpm -C packages/registry test` green (no daemon);
   root build picks up the new modules.
10. **Docs:** tick T102 in `docs/backlog.md` (note T103/T105/T106/T107/T108/T113/T114 unblocked); add the
    "implemented" + status↔code-partition note to design §4.2/§4.4; write the README envelope/taxonomy/
    idempotency section.
11. **Stage the two-daemon conformance follow-ups** (pin `mapDaemonError` to the real daemon vocabulary, confirm
    `audit_ref` fields, assert live `idempotency_key` dedup) behind `MXL_CONFORMANCE_TWO_DAEMON=1`; record the
    verified shapes in `docs/mx-agent-surface-v0.2.1.md`, closing Open Questions #3/#4/#5.
12. **Confirm the remaining open questions** (#2 partition, #3 daemon vocabulary, #4 audit fields, #5 wire param
    name) with the maintainer before/alongside review, since they shape the contract every downstream consumer
    (T103/T105/T106/T113/T114) builds on.
