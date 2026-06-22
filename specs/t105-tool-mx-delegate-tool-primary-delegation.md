# T105 · `mx_delegate_tool` — the primary delegation verb

> Issue #13 · `area/registry` `priority/P0` `type/feature` · Estimate **M** · Milestone **M1 — Delegation MVP** · Source `docs/backlog.md` (`T105`).
> Blocked-by **#10 (T102 — result envelope)** and **#12 (T104 — discovery handlers)**. Out of scope: guarded exec (**#14 / T106**).

## Problem Statement

mx-loom can now describe the coordination mesh but cannot yet **act** on it. After T101 (descriptor model), T102 (result envelope + error taxonomy + idempotency), T103 (`mx_await_result` deferred-result resolver), and T104 (`mx_find_agents` / `mx_describe_agent`), a runtime can discover a target agent and read the `ToolSchema.input_schema` it publishes — but there is no handler that takes the next step: invoking a *named tool* on that remote agent and turning the daemon's `CallResponse` into the normalized envelope.

`mx_delegate_tool` is that step — design §2 names it the **primary delegation verb** and §5 makes it the spine of the whole fabric: `model → mx-loom → daemon call.start → remote daemon (verify → trust → policy → approval → sandbox → execute) → CallResponse → envelope → model`. It is the verb the M1 golden test (T114) and both bindings (MCP T109, Claude shim T110) are built around; without it, M1 has discovery but no delegation, and the "delegate signed work across a room" thesis is unproven.

The gap is concrete: the descriptor `MX_DELEGATE_TOOL` exists (T101) with an **open** `args` object, and the contract layer it must use (envelope helpers, error mappers, idempotency generator, the `invocationToResult` normalizer) exists (T102/T103) — but no handler function wires `call.start` to them. T105 adds exactly that handler.

## Goals

- Add a `mxDelegateTool(input, deps)` handler in `@mx-loom/registry` that invokes a named tool on a remote agent via the daemon `call.start` RPC and returns a normalized `ToolResult` — built **only** through the T102 constructor helpers, **never throwing** (every transport/daemon fault maps onto the closed taxonomy).
- **Pass the inner `input_schema` through** from the target's published `ToolSchema` and validate the caller's `args` against it **before dispatch**; a mismatch returns `error` / `invalid_args` and never reaches `call.start` (AC 2).
- **Map the `CallResponse` into the envelope**, covering every disposition the design names: synchronous `ok` with the inner tool's `result`, a deferred `running` handle, a held `awaiting_approval` (handle + approval block), and the denial/fault terminals — reusing the T103 normalizer machinery so the initial delegation result and a later `mx_await_result` poll agree by construction (AC 1, AC 3).
- Honor the **idempotency contract** (T102 §4.4): use the caller's `idempotency_key` when supplied, else generate one once per invocation; place it in the outbound `call.start` params; never regenerate on a transport-level retry.
- Populate **`audit_ref`** from the `CallResponse` correlation ids (this is a real Matrix round-trip, unlike the T104 local reads) — null inner ids when the daemon does not return them, never fabricated.
- Keep the registry's invariants intact: **zero runtime dependency** on `@mx-loom/toolbelt` (the daemon transport is injected, imported `type`-only), secret-free in and out, and no authority surface (the handler only emits a signed *request*; trust/policy/approval/sandbox all execute out-of-process on the receiving daemon).

## Non-Goals

- **Guarded exec (`mx_run_command`, T106 / #14).** Running an allowlisted command via `exec.start` is a sibling verb with its own policy semantics; it is explicitly out of scope here.
- **The bindings** — the MCP server (T109) and the Claude in-process shim (T110) that surface this handler to a runtime and hide the `mx_await_result` poll loop. T105 ships the transport-neutral handler only.
- **The golden end-to-end test (T114)** and the **two-daemon live `call.start` round-trip** (staged behind `MXL_CONFORMANCE_TWO_DAEMON=1`). T105 lands with unit tests over a fake `DaemonCall`; the live round-trip pins the wire assumptions later.
- **Postgres audit mirror (T113).** T105 populates `audit_ref` on the result; persisting a row is a separate issue.
- **Approval mutation of any kind.** The handler surfaces `awaiting_approval` as a *status*; it never approves, polls for an approval decision it issued, or exposes an approve/deny surface. The operator decides out-of-process and the daemon re-validates at release (design §5).
- **Task DAG tools, share/get context, cancel, workspace status** (T107/T108/M3).

## Relevant Repository Context

The stack is TypeScript (pnpm workspace, Node ≥20.19, vitest, Apache-2.0). Two packages exist today:

- **`packages/toolbelt` = `@mx-loom/toolbelt`** — the Boundary-B daemon client. `MxClient` / `createClient` (T004) is the unified transport (IPC primary, CLI fallback) and **is** an `MxTransport` (`call(method, params, options)` → daemon RPC `result`). `MxClient.call()` already (a) runs `assertNoCredentialShapedArgs(params)` **before dispatch to either transport** — throwing `TransportError('invalid_args')` on a credential-shaped arg — and (b) runs inbound `redactSecrets()` on the result at the single `call()` exit point (T008). `safeSubprocessEnv` enforces the deny-by-default env allowlist on the CLI path. `MxClient.withRetry` reuses `params` verbatim on retry (the idempotency-stability guarantee T102 relies on). Failover is `not_running`-only (no mutating call is re-issued after possible dispatch).

- **`packages/registry` = `@mx-loom/registry`** — the canonical tool contract + handler layer. Relevant existing surface:
  - **Descriptor** `MX_DELEGATE_TOOL` (`src/descriptors/delegate-tool.ts`) — the OUTER schema: `agent` (req), `tool` (req), `args` (req, **open** object), `wait_ms` (opt int ≥0), `idempotency_key` (opt string). `async_semantics: 'deferred'`. `output_schema` is an open object (the target's output schema is known only at call time). The descriptor deliberately does **not** bake in any target tool's schema — that is T105's dynamic job.
  - **Envelope** (`src/envelope.ts`) — `ToolResult` + the only sanctioned builders `ok` / `running` / `awaitingApproval` / `denied` / `errored`, each deep-frozen and requiring an `audit_ref`. `denied()` accepts only a `DenialCode`, `errored()` only a `FaultCode` (the partition is compiler-enforced).
  - **Errors** (`src/errors.ts`) — the closed nine-code `ERROR_CODES`, the `DENIAL_CODES`/`FAULT_CODES` partition, and `mapTransportError` / `mapDaemonError` (the single place a transport/daemon fault becomes an `ErrorCode`).
  - **Idempotency** (`src/idempotency.ts`) — `newIdempotencyKey()` → `idk_<uuid>`; the documented mutating-handler contract (use caller key or generate once; place in params; never regenerate on retry).
  - **Handler seam** (`src/handlers/deps.ts`) — `HandlerDeps { daemon: DaemonCall; sleep?; now?; pollIntervalMs? }`, where `DaemonCall = Pick<MxTransport, 'call'>` is imported `type`-only, so the registry keeps a zero **runtime** toolbelt dep (toolbelt stays a devDependency). This is the seam T103/T104 use and T105 reuses.
  - **Invocation normalizer** (`src/handlers/invocation.ts`) — `invocationToResult(raw)`: pure, never-throws, classifies a daemon response into one of the five statuses (running / awaiting_approval / ok / denied / error) via a normalized state-token table + `failureCode` (prefers an explicit daemon error object via `mapDaemonError`, else interprets the state label, else `internal`). Builds approval blocks (`approvalOf`, fail-safe `high` risk) and `audit_ref` (`extractAuditRef`, null-not-fabricated) from the response. Exposes `failureResult(code, audit_ref)` (selects `denied` vs `errored` by set membership).
  - **Shared fault path** (`src/handlers/handler-fault.ts`) — `faultToResult(err, audit_ref)`: maps a `deps.daemon.call(...)` rejection onto a fault envelope (`rpc` → `mapDaemonError(cause)`, else `mapTransportError`); plus `EMPTY_AUDIT_REF` (all-null, for local reads).
  - **Discovery handlers** (`src/handlers/find-agents.ts`, `describe-agent.ts`) + **projectors** (`src/handlers/agent-projection.ts`) — `mxDescribeAgent` resolves `agent.tools` → `projectTools(schemas)` → `PublishedTool[]` (with `input_schema`/`output_schema` passed through **verbatim**). T105 needs exactly this `input_schema`, so it reuses `projectTools` (and the `asRecord`/`readString` readers).
  - **Validator seam** (`src/validator.ts`) — `SchemaValidator { compile(schema): CompiledSchema }`, default `createAjvValidator()` (Ajv is a **runtime** dep of the registry, behind this injectable seam). `JSON_SCHEMA_DIALECT = draft-07`. This is the machinery T105 uses to validate `args` against the target's `input_schema`. (T101 §"Decision Risk #1" explicitly anticipated T105 needing this.)
  - **Security invariants** (`src/security.ts`) — `MODEL_FACING_ALLOWLIST` (includes `mx_delegate_tool`), `CREDENTIAL_KEY_RE` (mirrors the toolbelt's, publish-time oracle), `isForbiddenAuthorityVerb`.

- **Verified daemon surface** (`docs/mx-agent-surface-v0.2.1.md`, T001):
  - `agent.tools {agent_id}` → `{agent_id, kind, status, capabilities[], tools[], schemas:[ToolSchema]}` is **verified live**. `ToolSchema = {name, version, description, input_schema, output_schema}`; the doc explicitly states **"`input_schema` pass-through for `mx_delegate_tool` (T105) is confirmed available."**
  - `call.start` is **"flags confirmed · round-trip staged"** — present, but the full `CallRequest`→`CallResponse` round-trip is gated behind the two-daemon fixture (`MXL_CONFORMANCE_TWO_DAEMON=1`, `packages/toolbelt/test/conformance/delegate.conformance.test.ts`). That test drives the **raw** `MxClient.call('call.start', { room, agent, tool, args, idempotency_key })` seam today, so the assumed param names are `room`/`agent`/`tool`/`args`/`idempotency_key`, and it reads a synchronous `CallResponse` that may carry an `invocation_id`/`call_id`/`id`/`handle` and may signal a denial via `ok:false` / `error` / a `deny`-shaped `status`.

**What does not exist yet (to build in T105):** the `mxDelegateTool` handler itself (`src/handlers/delegate-tool.ts`), any `call.start` *handler* code path (only the raw conformance probe exists), and a `CallResponse`-specific normalizer for the synchronous-success case. The descriptor, the envelope/error/idempotency contract, the validator seam, the `HandlerDeps` seam, the `agent.tools` lookup, and the `invocationToResult` machinery all exist and are reused.

## Proposed Implementation

### Shape: a `deferred` mutating handler, mirroring T103/T104

Add `src/handlers/delegate-tool.ts` exporting:

```ts
export interface DelegateToolInput {
  readonly agent: string;        // target agent id
  readonly tool: string;         // target tool name, optionally `name@version`
  readonly args: Record<string, unknown>;
  readonly wait_ms?: number;     // optional inline wait before returning a deferred handle
  readonly idempotency_key?: string;
}

export async function mxDelegateTool(
  input: DelegateToolInput,
  deps: DelegateDeps,
): Promise<ToolResult> { /* … */ }
```

It is `async`, returns `Promise<ToolResult>`, and **never throws** — every error path returns an envelope built through the T102 helpers (the T103/T104 precedent). The body has four phases: **resolve the inner schema → validate args → dispatch `call.start` → normalize the `CallResponse`**, with an optional **inline-wait** step.

### Deps: extend the handler seam for the validator and the room

`mxDelegateTool` needs two things the read handlers do not: a `SchemaValidator` (to validate `args` against the target's `input_schema`) and the **workspace room** the call is scoped to. Both should be injected, not model-facing:

```ts
export interface DelegateDeps extends HandlerDeps {
  /** JSON Schema validator for dynamic args validation. Default: a lazily-created Ajv validator. */
  readonly validator?: SchemaValidator;
  /** The session/workspace room the delegation is scoped to (from MxSession, NOT model input). */
  readonly room?: string;
}
```

- **Validator default.** Because Ajv is already a registry runtime dep, default to a module-level, lazily-constructed `createAjvValidator()` when `deps.validator` is absent — keeping the handler injectable for tests (a fake validator) while requiring no wiring in the common path. (Decision to confirm: extend `HandlerDeps` with an optional `validator?`/`room?` vs. a dedicated `DelegateDeps` — recommended: a dedicated `DelegateDeps extends HandlerDeps` so the read handlers' deps stay minimal.)
- **Room provenance.** The model must never name a Matrix room id (coordination-plane detail, design §1/§7). The binding holds the `MxSession` (T005: `{ agent_id, room/workspace, socket, correlation_id }`) and passes its room into the handler via `deps.room`. The outbound `call.start` includes `room`; if `deps.room` is absent, fail fast with `errored('internal', …)` rather than dispatching a room-less call (flag as an open question — the exact `call.start` room requirement is pinned at the two-daemon round-trip; the conformance probe currently supplies `room`).

### Phase 1 — resolve the target tool's `input_schema`

Parse `input.tool` into `{ name, version? }` by splitting on the last `@` (so `run_tests@1.0.0` → `name: run_tests`, `version: 1.0.0`; a bare `run_tests` → no version). Then resolve the target's published tools via the **verified** surface — a single `agent.tools {agent_id}` call, reusing `projectTools`:

```ts
let toolsResp: unknown;
try {
  toolsResp = await deps.daemon.call('agent.tools', { agent_id: input.agent });
} catch (err) {
  return faultToResult(err, EMPTY_AUDIT_REF); // unknown_agent → not_found, etc.
}
const published = projectTools(asRecord(toolsResp)?.schemas);
const target = published.find((t) =>
  t.name === name && (version === undefined || t.version === version));
if (target === undefined) {
  return failureResult('not_found', EMPTY_AUDIT_REF); // unknown tool on a known agent
}
```

`audit_ref` for these pre-dispatch failures is `EMPTY_AUDIT_REF` (no Matrix round-trip happened yet). Reuse `mapDaemonError`'s existing `unknown_agent`/`unknown_tool` → `not_found` mappings via `faultToResult`.

> **Reuse note.** This duplicates a slice of `mxDescribeAgent`. Recommended: keep the lean `agent.tools`-only lookup here (skip the `agent.list` liveness merge `mxDescribeAgent` does — irrelevant to validation), reusing only `projectTools`. Optionally extract a tiny shared `resolvePublishedTool(deps, agentId)` helper if T106 will need the same.

### Phase 2 — validate `args` against the inner schema (before dispatch) — AC 2

If `target.input_schema` is present, compile it via `deps.validator` and validate `input.args`:

```ts
if (target.input_schema !== undefined) {
  let validate: CompiledSchema;
  try {
    validate = (deps.validator ?? defaultValidator()).compile(target.input_schema as JsonSchema);
  } catch {
    // The target published a malformed input_schema — cannot validate client-side.
    // Don't block: the receiving daemon re-validates (design §5). Skip to dispatch.
  }
  if (validate !== undefined && !validate(input.args)) {
    return failureResult('invalid_args', EMPTY_AUDIT_REF); // rejected BEFORE call.start
  }
}
// Absent input_schema ⇒ nothing to validate client-side; the daemon is the authority.
```

Key properties:
- **Rejection is `error` / `invalid_args`** (fault-set), built via `failureResult('invalid_args', EMPTY_AUDIT_REF)`, and **`call.start` is never dispatched** (AC 2). The message is the fixed, secret-free phrase (`MESSAGE_FOR_CODE.invalid_args`); validation error *details* (which would echo arg values) are **not** placed in the envelope message — they may optionally be surfaced via a redaction-safe `deps.debug` path keyed on the failing JSON pointer only, never the value.
- **Client-side validation is a fast-fail convenience, not the security boundary.** The receiving daemon re-validates `args` against the published `input_schema` in-sandbox (design §5 step 4). A malformed/absent target schema therefore degrades to "skip client validation and let the daemon decide" — never a hard failure that would block a legitimately-valid call.
- **Credential-shaped args** are caught at dispatch by `MxClient.call()`'s `assertNoCredentialShapedArgs` (→ `TransportError('invalid_args')` → `faultToResult` → `invalid_args`). The registry must **not** re-implement the runtime credential guard (single source = the toolbelt, design §4.7). Document that the credential-shaped-arg case surfaces as `invalid_args` even though it is caught at the dispatch boundary rather than in Phase 2.

### Phase 3 — dispatch `call.start` with idempotency

Resolve the idempotency key once, build the params, dispatch:

```ts
const idempotency_key = input.idempotency_key ?? newIdempotencyKey();
const params = {
  room: deps.room,                 // from MxSession, not model input
  agent: input.agent,
  tool: input.tool,                // forwarded verbatim incl. any @version
  args: input.args,
  idempotency_key,
};
let response: unknown;
try {
  response = await deps.daemon.call('call.start', params);
} catch (err) {
  return faultToResult(err, EMPTY_AUDIT_REF);
}
```

- The key rides in `params`; because `MxClient.withRetry` reuses `params` verbatim, the same key is sent on every transport-level retry — the daemon dedupes (T102 §4.4). The handler **never** regenerates it. No `CallOptions`/transport change is required.
- `deps.daemon.call` is the injected `DaemonCall` (a concrete `MxClient` in production), so the credential guard + inbound redaction already run on this path.
- A dispatch rejection (transport fault, or a daemon JSON-RPC error such as `policy_denied`/`untrusted_key`) maps via `faultToResult` — which routes a `rpc` fault's `cause` through `mapDaemonError`, so `policy_denied` → `denied('policy_denied')` and `untrusted_key` → `denied('untrusted_key')` (**AC 3**). The `audit_ref` for a thrown dispatch fault carries no correlation ids beyond what the error exposes (use `EMPTY_AUDIT_REF`, or extract ids from the error if the daemon attaches them — pending the round-trip).

### Phase 4 — normalize the `CallResponse` into the envelope — AC 1, AC 3

A *resolved* (non-throwing) `call.start` response must be mapped onto the envelope covering every disposition. This is the same job `invocationToResult` does for `invocation.get`, **except** a synchronous `call.start` success may arrive as a bare `CallResponse{ok:true, result}` with **no** explicit running/awaiting/ok *state token*, which `invocationToResult`'s default branch currently treats as "unrecognised → internal". So add a sibling normalizer that reuses the shared machinery but adds a **success signal**:

```ts
// in src/handlers/invocation.ts (reusing asRecord/stateToken/resultOf/handleOf/approvalOf/
// extractAuditRef/failureCode/hasErrorSignal already defined there)
export function callResponseToResult(raw: unknown): ToolResult {
  const obj = asRecord(raw);
  const audit_ref = extractAuditRef(obj);
  if (obj === undefined) return errored('internal', UNRECOGNISED_MESSAGE, audit_ref);

  const token = stateToken(obj);
  const kind = token !== undefined ? INVOCATION_STATE_KIND[token] : undefined;
  switch (kind) {
    case 'running':            return running(handleOf(obj, audit_ref), audit_ref);
    case 'awaiting_approval':  return awaitingApproval(handleOf(obj, audit_ref), approvalOf(obj), audit_ref);
    case 'ok':                 return ok(resultOf(obj), audit_ref);
    case 'fail':               return failureResult(failureCode(obj, token), audit_ref);
    default:
      // call.start-specific: an explicit error signal is a terminal failure;
      // an explicit SUCCESS signal (ok:true or a result object) is a synchronous ok;
      // a handle with no state is a deferred running; otherwise unrecognised.
      if (hasErrorSignal(obj)) return failureResult(failureCode(obj, token), audit_ref);
      if (hasSuccessSignal(obj)) return ok(resultOf(obj), audit_ref);
      if (handleOf(obj, audit_ref) !== '') return running(handleOf(obj, audit_ref), audit_ref);
      return errored('internal', UNRECOGNISED_MESSAGE, audit_ref);
  }
}
```

where `hasSuccessSignal(obj)` returns true when `obj.ok === true` or `asRecord(obj.result) !== undefined`. (Decision to confirm: a dedicated `callResponseToResult` vs. extending `invocationToResult`'s default branch with the success signal. Recommended: a dedicated sibling, so T103's verified `invocation.get` behavior — where an unrecognised state is genuinely suspicious — is untouched, while the two share every reader/classifier.)

Then in the handler:

```ts
const result = callResponseToResult(response);
```

- A synchronous success → `ok(result, audit_ref)` with `result` being the inner tool's payload (the target's `output_schema` payload). **AC 1.**
- A deferred call → `running(handle, audit_ref)`; the caller resolves via `mx_await_result` (T103). Consistent shapes guaranteed because both go through the same machinery.
- A held call → `awaiting_approval(handle, approval, audit_ref)`; the model keeps planning, resolves later (design §5). **(part of mapping the response incl. awaiting_approval.)**
- A denial → `denied('policy_denied' | …)`; a fault → `errored(…)`. **AC 3.**
- `audit_ref` is populated from the response (`extractAuditRef`) — for delegation this **is** a Matrix round-trip, so `invocation_id`/`request_id`/`room`/`event_id` should be present (pending the round-trip; null when the daemon omits one, never fabricated). This is the key difference from the T104 read handlers' `EMPTY_AUDIT_REF`.

### Optional Phase 5 — inline `wait_ms`

The descriptor declares `wait_ms` as "an optional inline wait before returning a deferred handle (the §4.3 / T103 poll hint)". If the normalized result is non-terminal (`running` / `awaiting_approval`) **and** `input.wait_ms` is a positive integer, compose T103 directly on the returned handle:

```ts
if (!isTerminal(result.status) && (input.wait_ms ?? 0) > 0 && result.handle) {
  return mxAwaitResult({ handle: result.handle, wait_ms: input.wait_ms }, deps);
}
return result;
```

This lets a fast remote tool feel synchronous without the model issuing a separate `mx_await_result` — and it inherits T103's crucial property that a `wait_ms` expiry returns the still-pending envelope (`error: null`), **never** `errored('timeout')`. (Decision to confirm: honor `wait_ms` in the handler now vs. leave it to the bindings. Recommended: honor it here, since the descriptor already declares it and it is a one-line compose over T103 that the bindings benefit from.)

### Localized wire constants

Mirror the T103/T104 precedent: keep the assumed RPC method/param names in `const`s at the top of the module so the two-daemon round-trip corrects them in one line:

```ts
const CALL_START_METHOD = 'call.start';
const AGENT_TOOLS_METHOD = 'agent.tools';
const AGENT_ID_PARAM = 'agent_id';
// call.start param names (room/agent/tool/args/idempotency_key) — pinned at the round-trip.
```

## Affected Files / Packages / Modules

**New:**
- `packages/registry/src/handlers/delegate-tool.ts` — `mxDelegateTool` + `DelegateToolInput` + `DelegateDeps` (+ the `name@version` parse + tool-lookup helper).
- `packages/registry/test/handlers/delegate-tool.test.ts` — unit tests over a fake `DaemonCall` + fake/real validator.
- `packages/registry/test/handlers/delegate-tool.security.test.ts` — secret-boundary + no-authority + redaction assertions.

**Modified:**
- `packages/registry/src/handlers/invocation.ts` — add `callResponseToResult` (+ `hasSuccessSignal`), reusing the existing readers/classifiers; export `isTerminal` if the handler reuses it (currently private to `await-result.ts`).
- `packages/registry/src/handlers/deps.ts` — add `DelegateDeps` (or extend `HandlerDeps` with optional `validator?` / `room?` — decision above).
- `packages/registry/src/handlers/index.ts` — export `mxDelegateTool`, `DelegateToolInput`, `DelegateDeps`, `callResponseToResult`.
- `packages/registry/src/index.ts` — re-export the same from the package barrel.
- `packages/registry/README.md` — document the new handler in the handler list.

**Read (reused, not modified):**
- `src/descriptors/delegate-tool.ts`, `src/envelope.ts`, `src/errors.ts`, `src/idempotency.ts`, `src/validator.ts`, `src/handlers/agent-projection.ts` (`projectTools`, `asRecord`, `readString`), `src/handlers/handler-fault.ts` (`faultToResult`, `EMPTY_AUDIT_REF`), `src/handlers/invocation.ts` (`failureResult`, helpers).

**Optionally updated (conformance):**
- `packages/toolbelt/test/conformance/delegate.conformance.test.ts` — could route its Tier-2 probe through `mxDelegateTool` once it lands, but the raw `MxClient.call('call.start')` probe is fine to leave as-is; the registry's own unit tests cover the handler.

## API / Interface Changes

- **New public API (registry):** `mxDelegateTool(input: DelegateToolInput, deps: DelegateDeps): Promise<ToolResult>`, plus the exported types `DelegateToolInput` and `DelegateDeps`, and the normalizer `callResponseToResult(raw: unknown): ToolResult`. All exported from `@mx-loom/registry`. Documented with TSDoc in the design-doc/handler style (the T103/T104 precedent).
- **Daemon RPC surface consumed:** `call.start` (new for a *handler* — previously only the raw conformance probe used it) and `agent.tools` (already consumed by T104). No daemon-side change.
- **Tool-descriptor surface:** none — `MX_DELEGATE_TOOL` is unchanged from T101; T105 implements its handler. The `args` open-object + `idempotency_key` + `wait_ms` fields are already declared.
- **CLI surface:** none.
- **`HandlerDeps`:** additive only — a new `DelegateDeps extends HandlerDeps` (or optional fields on `HandlerDeps`); no breaking change to the T103/T104 read handlers' deps.

## Data Model / Protocol Changes

- **Result envelope:** no shape change. `mx_delegate_tool` is the first handler to produce **populated** `audit_ref` ids (T104's reads use `EMPTY_AUDIT_REF`) and the first to emit `running` / `awaiting_approval` from an *initial* call (T103 emits them from a poll). It uses only the existing `ok` / `running` / `awaitingApproval` / `denied` / `errored` builders.
- **Error taxonomy:** no new codes. The handler emits, via the existing mappers: `invalid_args` (args fail the inner schema, or a credential-shaped/invalid arg at dispatch), `not_found` (unknown agent or unknown tool), `policy_denied` / `untrusted_key` / `approval_denied` / `approval_expired` (daemon governance outcomes), `target_offline` (remote agent offline), `timeout` (genuine transport fault), `internal` (unrecognised response / missing room / local fault).
- **Idempotency:** the handler is the **first** to exercise the T102 idempotency contract end-to-end — generating/forwarding `idk_<uuid>` into `call.start` params and relying on verbatim-param retry. No format change.
- **Wire-shape assumptions (pending the two-daemon round-trip, `MXL_CONFORMANCE_TWO_DAEMON=1`):** the `call.start` param names (`room`/`agent`/`tool`/`args`/`idempotency_key`), the `CallResponse` disposition vocabulary (synchronous-result vs handle-only; the running/awaiting/ok/fail state tokens), the held-invocation `approval` fields, and `audit_ref` field availability. Authored against the design's named shapes now (reusing the T102/T103 token tables + `internal`-safe fallbacks); pinned at the round-trip. A new daemon code/state degrades to `internal` (never the wrong code), never throws.

## Security & Compliance Considerations

- **Cognition produces only a signed request.** The handler emits a `call.start`; it performs **no** trust/policy/approval/sandbox check itself. All five enforcement layers (Ed25519 verify → trust store → deny-by-default `policy.toml` → approval gate → sandbox) execute **out-of-process on the receiving daemon** (design §1, §6). `policy_denied` / `untrusted_key` / `awaiting_approval` are *outcomes the handler maps*, never decisions it makes. The handler exposes no approve/deny/trust/policy mutation surface, and `mx_delegate_tool` stays inside `MODEL_FACING_ALLOWLIST` with no authority verb.
- **Secret boundary (Boundary A).** No field carries a credential inbound or outbound. The handler forwards `args` to the daemon through `MxClient.call()`, which runs `assertNoCredentialShapedArgs` **before dispatch** (rejecting `GH_TOKEN`/`*_token`/`sk-…`/PEM/etc.) and `redactSecrets` (value-shape-only) on the inbound result — so a credential-shaped arg yields `invalid_args` and a daemon bug leaking a token-shaped value into the result is redacted before it reaches the model context. The registry adds **no** new env access and keeps its **zero runtime toolbelt dependency** (transport injected, imported `type`-only). Matrix tokens, Ed25519 signing keys, provider keys, and `GH_TOKEN` never enter the registry or the runtime — they stay daemon-held.
- **No secret-shaped data in the envelope.** `error.message` is the fixed, secret-free phrase per code; `approval.summary` is operator-facing text built from a fixed vocabulary (`invocation.ts`'s `approvalOf`/`MESSAGE_FOR_CODE`), never an echo of a raw daemon payload or an arg value. Validation-failure detail (which would echo arg values) is **not** placed in the envelope; at most a redaction-safe `deps.debug` line carrying the failing JSON pointer (never the value).
- **Audit correlation.** Every result carries `audit_ref` tying "model delegated X" ↔ "daemon executed Y" ↔ "operator approved Z" to the signed `com.mxagent.call.*` / approval events (design §4.6); the Postgres mirror is T113. Ids are correlation handles, not secrets; missing ids are `null`, never fabricated.
- **Idempotency is a dedup nonce, not a capability.** `idempotency_key` confers no authority and is not credential-shaped (passes the secret-free-shape check); the daemon re-runs the full authorize pipeline regardless of the key (design §5) — idempotency never bypasses authorize.
- **Approval re-validation at release.** When `awaiting_approval` later resolves (via `mx_await_result`), the daemon re-runs sig→trust→policy at release time, so a revoked trust or stale policy cannot smuggle a held call through. The handler relies on this; it must not cache or short-circuit an approval.
- **Logging/redaction.** Never log `args`, results, room ids beyond non-secret diagnostics, or any token. The only sanctioned diagnostic sink is a redaction-safe `deps.debug` that receives codes/paths/method names — never params, values, or env.

## Testing Plan

Unit tests over a **fake `DaemonCall`** (no socket, no daemon) + a fake or real `SchemaValidator`, mirroring `test/handlers/await-result*.test.ts` and `find-agents.test.ts`:

- **AC 1 — happy path:** fake `agent.tools` returns a `run_tests@1.0.0`-shaped `ToolSchema`; valid `args`; fake `call.start` returns a synchronous success → assert `status: ok`, `result` is the inner payload, `audit_ref` populated, `validateEnvelope(result)` passes.
- **AC 2 — invalid args rejected before dispatch:** `args` violate the inner `input_schema` → assert `status: error`, `error.code: 'invalid_args'`, **and** that the fake `call.start` was **never called** (spy assertion). Cover: missing required prop, wrong type, extra prop (if `additionalProperties:false` in the inner schema).
- **AC 3 — policy-denied target:** fake `call.start` rejects with a daemon `rpc` error whose `cause` is `policy_denied` (and a `CallResponse{ok:false, error:{code:'policy_denied'}}` variant) → assert `status: denied`, `error.code: 'policy_denied'`. Repeat for `untrusted_key` → `denied`.
- **Deferred dispositions:** `call.start` returns a `running` state + handle → `status: running`, `handle` set; an `awaiting_approval` state + approval block → `status: awaiting_approval`, `handle` + `approval` set (fail-safe `high` risk when omitted). Assert the disposition agrees with a subsequent `mx_await_result` poll on the same shape (consistency with T103).
- **Inline `wait_ms`:** deferred response + `wait_ms > 0` + a fake clock/sleep → composes `mxAwaitResult`; assert it returns the terminal envelope when the next poll is terminal, and the **still-pending** envelope (`error: null`, not `timeout`) when `wait_ms` expires.
- **Idempotency:** caller-supplied key is forwarded verbatim in `call.start` params; omitted → a generated `idk_<uuid>`; the same key is reused across a simulated retry (assert the params object passed to `call.start` is stable).
- **Unknown agent / unknown tool:** `agent.tools` rejects `unknown_agent` → `not_found`; tool name not in `schemas` → `not_found`; `name@version` mismatch → `not_found`.
- **Robustness / never-throws:** malformed `agent.tools` response (non-object, missing `schemas`); malformed `CallResponse` (scalar/array/null) → `internal`, never a thrown error. Target with **absent** inner `input_schema` → validation skipped, dispatch proceeds. Target with **malformed** inner `input_schema` (Ajv `compile` throws) → validation skipped, dispatch proceeds (daemon is the authority).
- **Missing room:** `deps.room` absent → `internal` (no room-less `call.start` dispatched) — pending the round-trip's confirmation that room is required.
- **Secret boundary / redaction (`delegate-tool.security.test.ts`):** a credential-shaped `args` key surfaces as `invalid_args` (via the real `MxClient` guard, or asserted at the registry boundary); a fake `call.start` that returns a token-shaped value is redacted before the result is returned (when exercised through `MxClient`); no `error.message` / `approval.summary` / log line contains an arg value or token; `mx_delegate_tool` is in `MODEL_FACING_ALLOWLIST` and not a forbidden authority verb.
- **`callResponseToResult` unit tests** (in `invocation.test.ts` or a new file): the synchronous-success signal (`ok:true` / bare `result` object), the handle-only `running` fallback, and parity with `invocationToResult` for the shared state tokens.

**Conformance (staged, not new code required):** the existing Tier-2 `delegate.conformance.test.ts` (`MXL_CONFORMANCE_TWO_DAEMON=1`) already round-trips a raw `call.start` allowed + policy-denied pair; it pins the wire shapes T105's normalizer assumes. Optionally re-point it through `mxDelegateTool` once landed.

**Coverage/regression:** keep the registry's per-file coverage bar; ensure `mxDelegateTool` and `callResponseToResult` are exercised on every branch (the handlers are pure over the injected fake).

## Documentation Updates

- **`docs/backlog.md`** — flip T105's three AC checkboxes once landed and append a `**Status:** Landed (…)` note in the T103/T104 style (module list + resolved decisions + the wire assumptions pending the two-daemon round-trip).
- **`docs/mx-agent-tool-fabric-design.md`** — update the §3 "Build rule" parenthetical and the M1 status line to record that `mx_delegate_tool` (T105) is implemented (the discovery → delegate prerequisite chain is now closed); §4.1's "the inner tool's `input_schema` is passed through" and §5's happy/approval-gated flow now have a concrete handler. Do **not** imply the bindings (T109/T110) or the live two-daemon round-trip exist.
- **`docs/mx-agent-surface-v0.2.1.md`** — once the two-daemon fixture runs green, flip `call.start` from "round-trip staged" to ✅ and record the confirmed `CallResponse` shape (state vocabulary, `audit_ref` fields, approval block); until then, leave the staged note and reference this spec's open questions.
- **`packages/registry/README.md`** — add `mxDelegateTool` to the handler list with a one-line description and the deps note (validator + room injected).
- TSDoc on the new handler/normalizer in the established header-comment style.

## Risks and Open Questions

1. **`call.start` wire shape (the central unknown).** The exact param names (`room`/`agent`/`tool`/`args`/`idempotency_key`), the `CallResponse` disposition vocabulary (synchronous-result vs handle-only; running/awaiting/ok/fail tokens), the held-invocation `approval` fields, and `audit_ref` field availability are **pending the two-daemon round-trip**. Mitigation: localize the method/param consts; reuse the T102/T103 token tables + `internal`-safe fallbacks; the conformance fixture pins them later. **Decision to confirm:** proceed authoring against the design's named shapes (recommended, consistent with T101–T104) vs. block on the live round-trip.
2. **Room provenance.** The model-facing schema has no `room`, but `call.start` needs one. Recommended: inject it from the `MxSession` via `deps.room`; fail fast (`internal`) if absent. **Confirm** whether `call.start` truly requires `room` on v0.2.1 (the conformance probe supplies it) or derives it from the agent/workspace — this changes whether `deps.room` is mandatory.
3. **Deps extension.** Adding `validator?` / `room?` to the handler seam. Recommended: a dedicated `DelegateDeps extends HandlerDeps` so the read handlers stay minimal. **Confirm** vs. widening `HandlerDeps` directly.
4. **Normalizer: shared vs. sibling.** Recommended: a dedicated `callResponseToResult` (sharing every reader/classifier with `invocationToResult`) so T103's verified `invocation.get` behavior is untouched while `call.start`'s synchronous-success case is handled. **Confirm** vs. extending `invocationToResult`'s default branch with a success signal.
5. **Inline `wait_ms` ownership.** Recommended: honor `wait_ms` in the handler by composing `mxAwaitResult` (the descriptor already declares it). **Confirm** vs. leaving the poll to the bindings (which also hide it for ADK/Claude). Either way the descriptor field stays.
6. **Output-schema validation.** AC 1 says the result "matches `output_schema`". The handler already fetched the target's `output_schema`; it *could* validate the inner `result` against it. Recommended: **pass-through, no hard outbound validation** (the daemon/target owns its output contract) — at most an optional redaction-safe `deps.debug` diagnostic on mismatch. **Confirm** whether AC 1 requires active outbound validation or just structural conformance of the envelope.
7. **Ajv compile cost.** Compiling the inner `input_schema` on every delegate call has a per-call cost. M1-acceptable; optionally memoize a compiled validator keyed by `(agent, tool, schema identity)` later. Not a blocker.
8. **Double lookup vs. binding-provided schema.** A binding that just called `mx_describe_agent` already holds the target's `input_schema`. T105 re-fetches via `agent.tools` for correctness/freshness (trust nothing the model passes). Recommended: re-fetch (one extra round-trip is cheap and avoids trusting a stale/forged schema). **Confirm** acceptable.

## Implementation Checklist

1. Add `DelegateDeps` to `src/handlers/deps.ts` (`extends HandlerDeps` + optional `validator?: SchemaValidator`, `room?: string`), with TSDoc.
2. Add `callResponseToResult` (+ `hasSuccessSignal`) to `src/handlers/invocation.ts`, reusing the existing readers/classifiers; export `isTerminal` (or re-derive locally) for the handler. Keep `invocationToResult` (T103) unchanged.
3. Create `src/handlers/delegate-tool.ts`:
   - localized wire consts (`call.start`, `agent.tools`, param names);
   - `DelegateToolInput`; a `name@version` parser; a lazily-created default Ajv validator;
   - Phase 1 — `agent.tools {agent_id}` → `projectTools` → find target tool (`not_found` on miss; `faultToResult` on a thrown lookup);
   - Phase 2 — compile `target.input_schema` via `deps.validator` and validate `args`; `failureResult('invalid_args', EMPTY_AUDIT_REF)` before dispatch on mismatch; skip on absent/malformed schema;
   - Phase 3 — resolve `idempotency_key` (caller or `newIdempotencyKey()` once), build `call.start` params incl. `deps.room`, dispatch via `deps.daemon.call`; `faultToResult` on rejection;
   - Phase 4 — `callResponseToResult(response)` → the terminal/deferred envelope;
   - Phase 5 — if non-terminal and `wait_ms > 0`, compose `mxAwaitResult({handle, wait_ms}, deps)`;
   - guarantee the function never throws (every path returns a `ToolResult`).
4. Export `mxDelegateTool`, `DelegateToolInput`, `DelegateDeps`, `callResponseToResult` from `src/handlers/index.ts` and `src/index.ts`.
5. Write `test/handlers/delegate-tool.test.ts` covering AC 1–3, deferred dispositions, inline `wait_ms`, idempotency, unknown agent/tool, never-throws/robustness, and missing room.
6. Write `test/handlers/delegate-tool.security.test.ts` covering credential-shaped args → `invalid_args`, inbound redaction, secret-free envelope/messages, and the no-authority/allowlist invariants.
7. Add `callResponseToResult` unit cases (success signal, handle-only running, parity with `invocationToResult`).
8. Update `packages/registry/README.md`, `docs/backlog.md` (T105 ACs + Status note), `docs/mx-agent-tool-fabric-design.md` (§3/§4/§5 + M1 status), and (when the fixture is green) `docs/mx-agent-surface-v0.2.1.md`.
9. Run `pnpm --filter @mx-loom/registry test` + typecheck/lint; confirm green. Do **not** run git/gh (the orchestrator owns that).
