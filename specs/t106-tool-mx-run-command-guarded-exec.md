# T106 · `mx_run_command` — guarded exec

> Issue #14 · `area/registry` `area/policy` `priority/P0` `type/feature` · Estimate **M** · Milestone **M1 — Delegation MVP** · Source `docs/backlog.md` (`T106`).
> Blocked-by **#10 (T102 — result envelope + error taxonomy + idempotency)**. Sibling of **#13 (T105 — `mx_delegate_tool`)**. Out of scope: streaming output into the model (v2+).

## Problem Statement

After T101–T105, mx-loom can discover the coordination mesh (`mx_find_agents` / `mx_describe_agent`), invoke a *named tool* on a remote agent (`mx_delegate_tool`), and resolve deferred handles (`mx_await_result`). What it still cannot do is run an **allowlisted command** on a remote agent — the second delegation surface the design locks in.

`mx_run_command` is that verb. Design **decision 2** ("Delegation surface — named tools + guarded exec") ships it *alongside* `mx_delegate_tool`, but with a hard constraint: **disabled by default, enabled per-agent only behind strict `allow_commands` + `deny_args_regex`; no unrestricted exec** (design §2 table, §6 layer 4 "Guarded exec", §9 "Guarded exec only — no unrestricted exec"). It maps to the daemon RPC `exec.start` → `ExecRequest`, the sibling of `call.start`.

The crucial property — and the reason this issue is `area/policy` as well as `area/registry` — is that the guard is **not** in mx-loom. The handler emits a signed `exec.start` request and nothing more; the receiving daemon's deny-by-default `policy.toml` (`allow_commands`, `deny_args_regex`, `allow_cwd`, sandbox backend, `network = "deny"`, `requires_approval`) is the only thing that says "yes". So "disabled by default → `policy_denied`" is an outcome the handler **surfaces cleanly**, never a check it performs. A model that names `mx_run_command` on a target whose operator never allowlisted a command gets a clean `denied`/`policy_denied` envelope — exactly the same shape every other tool returns — and keeps planning.

The gap is concrete: the descriptor `MX_RUN_COMMAND` exists (T101, `src/descriptors/run-command.ts`) with a fixed `command`/`args`/`cwd` input shape, and the entire contract + handler machinery it needs (envelope helpers, error mappers, idempotency generator, the `callResponseToResult` normalizer, the shared `faultToResult` path, the injected `HandlerDeps` seam) exists (T102/T103/T105) — but **no handler function wires `exec.start` to them.** T106 adds exactly that handler.

## Goals

- Add a `mxRunCommand(input, deps)` handler in `@mx-loom/registry` that runs an allowlisted command on a remote agent via the daemon `exec.start` RPC and returns a normalized `ToolResult` — built **only** through the T102 constructor helpers, **never throwing** (every transport/daemon fault maps onto the closed taxonomy).
- **Surface `policy_denied` cleanly when not allowlisted (AC 1).** The handler performs **no** allowlist / regex / cwd / sandbox check; it maps the receiving daemon's deny-by-default `policy.toml` outcome (`policy_denied`) onto `denied('policy_denied')`. "Disabled by default" is a *receiver policy* property the handler observes, never enforces.
- **Run an allowlisted command and return the envelope (AC 2).** When the receiver's policy permits the command, `exec.start` returns a result that normalizes to a `status: ok` envelope carrying the exec payload (`exit_code` + optional `summary` / `log_ref`).
- **Block a `deny_args_regex` match (AC 3).** A command whose args trip the receiver's `deny_args_regex` is denied on the daemon; the handler maps that denial to `denied('policy_denied')` — the same surfacing path as AC 1, the *distinction* between the two living in the receiver's policy, not the handler.
- **Map the `ExecResponse` across every disposition** the design names — synchronous `ok`, deferred `running` handle, held `awaiting_approval` (handle + approval block), and the denial/fault terminals — reusing the T105 `callResponseToResult` normalizer so an initial exec result and a later `mx_await_result` poll agree by construction.
- Honor the **idempotency contract** (T102 §4.4): use the caller's `idempotency_key` when supplied, else generate one once per invocation; place it in the outbound `exec.start` params; never regenerate it on a transport-level retry.
- Populate **`audit_ref`** from the `ExecResponse` correlation ids (a real Matrix round-trip, like delegation) — null inner ids when the daemon omits them, never fabricated.
- Keep the registry's invariants intact: **zero runtime dependency** on `@mx-loom/toolbelt` (the daemon transport is injected, imported `type`-only), secret-free in and out, and no authority surface (the handler only emits a signed *request*; trust/policy/approval/sandbox all execute out-of-process on the receiving daemon).

## Non-Goals

- **Streaming command output into the model.** Explicitly out of scope per the issue (and design §9 "Don't stream tool output into the model"). The success payload is the descriptor's `{ exit_code, summary?, log_ref? }`; the full captured output is an artifact referenced by `log_ref` and fetched later via `mx_get_context` (T107). No live `StreamChunk` plumbing.
- **Any client-side policy enforcement.** The handler must **not** implement `allow_commands`, `deny_args_regex`, `allow_cwd`, the sandbox, `network = "deny"`, or `requires_approval`. All of these run **out-of-process on the receiving daemon** (design §6). Re-implementing any of them in mx-loom would both duplicate the authority surface (forbidden) and create a false sense that the toolbelt is the boundary (it is not).
- **The bindings** — the MCP server (T109) and the Claude in-process shim (T110) that surface this handler to a runtime, hide the `mx_await_result` poll loop, and (optionally) let an operator omit `mx_run_command` from the exposed toolset entirely. T106 ships the transport-neutral handler only.
- **The golden end-to-end test (T114)** ("guarded command runs only after approval; denial path also asserted") and the **two-daemon live `exec.start` round-trip**. T106 lands with unit tests over a fake `DaemonCall`; the live round-trip + a staged exec conformance fixture pin the wire assumptions later.
- **Postgres audit mirror (T113).** T106 populates `audit_ref` on the result; persisting a row is a separate issue.
- **Policy authoring (T402).** Authoring `allow_commands` / `deny_args_regex` / `allow_cwd` / `requires_approval` for an agent is an operator concern (out-of-band `policy.toml` / a later UI), never a model tool.
- **Approval mutation of any kind.** The handler surfaces `awaiting_approval` as a *status*; it never approves, polls for an approval decision it issued, or exposes an approve/deny surface. The operator decides out-of-process and the daemon re-validates at release (design §5).
- **Task DAG tools, share/get context, cancel, workspace status** (T107/T108/M3).

## Relevant Repository Context

The stack is TypeScript (pnpm workspace, Node ≥20.19, vitest, Apache-2.0). The repo is **not** docs-only any more — M0 + most of M1 are implemented. Two packages exist:

- **`packages/toolbelt` = `@mx-loom/toolbelt`** — the Boundary-B daemon client. `MxClient` / `createClient` (T004) is the unified transport (IPC primary, CLI fallback) and **is** an `MxTransport` (`call(method, params, options)` → daemon RPC `result`). `MxClient.call()` already (a) runs `assertNoCredentialShapedArgs(params)` **before dispatch to either transport** — throwing `TransportError('invalid_args')` on a credential-shaped **key or value** (`src/guards.ts`: `CREDENTIAL_KEY_RE` + `CREDENTIAL_VALUE_RE`) — and (b) runs inbound `redactSecrets()` on the result at the single `call()` exit point (T008). `safeSubprocessEnv` enforces the deny-by-default env allowlist on the CLI path. `MxClient.withRetry` reuses `params` verbatim on retry (the idempotency-stability guarantee T102 relies on). Failover is `not_running`-only (no mutating call re-issued after possible dispatch).

- **`packages/registry` = `@mx-loom/registry`** — the canonical tool contract + handler layer. Relevant existing surface this issue **reuses**:
  - **Descriptor** `MX_RUN_COMMAND` (`src/descriptors/run-command.ts`) — already authored in T101 and already in `CANONICAL_M1_TOOLS`. Input: `agent` (req), `command` (req), `args` (opt `string[]`), `cwd` (opt), `wait_ms` (opt int ≥0), `idempotency_key` (opt string), `additionalProperties:false`. Output: `exit_code` (req int), `summary` (opt), `log_ref` (opt), `additionalProperties:true`. `async_semantics: 'deferred'`. Its TSDoc already states the contract T106 must honor verbatim: *"Its presence in the registry confers NO capability… The tool ships disabled; an un-allowlisted call returns `policy_denied`… high-risk commands surface as `awaiting_approval`."* **No `guarded` hint** is declared (T101 Risk #8 / OQ #8) — guarded-ness is receiver policy, not descriptor state.
  - **Envelope** (`src/envelope.ts`) — `ToolResult` + the only sanctioned builders `ok` / `running` / `awaitingApproval` / `denied` / `errored`, each deep-frozen and requiring an `audit_ref`. `denied()` accepts only a `DenialCode`, `errored()` only a `FaultCode` (the partition is compiler-enforced).
  - **Errors** (`src/errors.ts`) — the closed nine-code `ERROR_CODES`, the `DENIAL_CODES`/`FAULT_CODES` partition, and `mapTransportError` / `mapDaemonError` (the single place a transport/daemon fault becomes an `ErrorCode`; `policy_denied`/`denied_by_policy`/`policy` → `policy_denied` is already in `DAEMON_CODE_TO_ERROR`).
  - **Idempotency** (`src/idempotency.ts`) — `newIdempotencyKey()` → `idk_<uuid>`; the documented mutating-handler contract (use caller key or generate once; place in params; never regenerate on retry).
  - **Handler seam** (`src/handlers/deps.ts`) — `HandlerDeps { daemon: DaemonCall; sleep?; now?; pollIntervalMs? }`, where `DaemonCall = Pick<MxTransport, 'call'>` is imported `type`-only, so the registry keeps a zero **runtime** toolbelt dep. `DelegateDeps extends HandlerDeps { validator?; room? }` (T105) is the precedent for a verb that needs a session `room`.
  - **Normalizer** (`src/handlers/invocation.ts`) — `callResponseToResult(raw)` (added in T105): pure, never-throws, classifies a daemon **response** into one of the five statuses via a normalized state-token table + `failureCode` (prefers an explicit daemon error object via `mapDaemonError`, else interprets the state label, else `internal`), with a synchronous-success signal (`ok:true` / a bare `result` object) so a tokenless success normalizes to `ok`. Builds approval blocks (`approvalOf`, fail-safe `high` risk) and `audit_ref` (`extractAuditRef`, null-not-fabricated). Also exports `failureResult(code, audit_ref)` and `isTerminal(status)`. **This is structurally identical to what an `ExecResponse` needs** — the disposition vocabulary (sync result vs handle-only; running/awaiting/ok/fail) is the same; only the success *payload* differs (`{exit_code,…}` vs an inner tool's output), and the normalizer passes `result` through as an open object.
  - **Shared fault path** (`src/handlers/handler-fault.ts`) — `faultToResult(err, audit_ref)`: maps a `deps.daemon.call(...)` rejection onto a fault envelope (`rpc` → `mapDaemonError(cause)`, else `mapTransportError`); plus `EMPTY_AUDIT_REF` (all-null, for a pre-dispatch failure with no round-trip).
  - **Delegation handler** (`src/handlers/delegate-tool.ts`, T105) — the closest sibling and the structural template: a `deferred` mutating handler that resolves a session `room`, dispatches a `room/agent/…/idempotency_key` RPC, normalizes the response, and optionally composes `mx_await_result` for an inline `wait_ms`. T106 mirrors it **minus** the inner-schema fetch/validate phases (exec has no dynamic per-tool `input_schema`).
  - **Security invariants** (`src/security.ts`) — `MODEL_FACING_ALLOWLIST` (already includes `mx_run_command`), `CREDENTIAL_KEY_RE` (mirrors the toolbelt's, publish-time oracle), `isForbiddenAuthorityVerb` (`mx_run_command` is **not** an authority verb — it emits a signed request, it does not mutate trust/policy).

- **Verified daemon surface** (`docs/mx-agent-surface-v0.2.1.md`, T001):
  - `exec.start` (guarded command) is **"◻️ flags confirmed"** with the note *"same [as `call.start`]; receiver-side policy/approval gate"* — i.e. the CLI flags exist, but the full `ExecRequest`→`ExecResponse` round-trip is **not yet even staged** (there is no `exec.conformance.test.ts` today; only `delegate.conformance.test.ts` exists for `call.start`). So T106's wire-shape assumptions are authored against the design's named shapes and pinned later, exactly as T105 did for `call.start`.
  - The conformance two-daemon fixture (`_harness.ts` `TwoDaemonFixture`) currently exports `MXL_CONFORMANCE_ROOM` / `MXL_CONFORMANCE_TARGET_AGENT` / `MXL_CONFORMANCE_TOOL` / `MXL_CONFORMANCE_DENIED_TOOL` — it has **no** exec command coordinates yet (a fixture extension T106 may add; see Testing Plan).

**What does not exist yet (to build in T106):** the `mxRunCommand` handler itself (`src/handlers/run-command.ts`), any `exec.start` *handler* code path (no raw conformance probe exists either, unlike `call.start`), and (if chosen) the `ExecDeps` type. The descriptor, the envelope/error/idempotency contract, the `HandlerDeps`/`DelegateDeps` seam, the `callResponseToResult` normalizer, the `faultToResult` path, and `mxAwaitResult` all exist and are reused.

## Proposed Implementation

### Shape: a `deferred` mutating handler, the leaner sibling of T105

Add `src/handlers/run-command.ts` exporting:

```ts
export interface RunCommandInput {
  readonly agent: string;          // target agent id
  readonly command: string;        // the allowlisted binary (subject to receiver policy)
  readonly args?: readonly string[]; // command arguments
  readonly cwd?: string;           // working directory (subject to allow_cwd)
  readonly wait_ms?: number;       // optional inline wait before returning a deferred handle
  readonly idempotency_key?: string;
}

export async function mxRunCommand(
  input: RunCommandInput,
  deps: ExecDeps,
): Promise<ToolResult> { /* … */ }
```

It is `async`, returns `Promise<ToolResult>`, and **never throws** — every error path returns an envelope built through the T102 helpers (the T103/T104/T105 precedent). The body is **three phases plus an optional inline-wait** — strictly simpler than T105 because there is **no inner-schema fetch and no args validation** (exec has a fixed input shape; there is no per-tool `input_schema` to resolve from `agent.tools`):

1. **Room provenance check** → 2. **dispatch `exec.start` with idempotency** → 3. **normalize the `ExecResponse`** → (optional) **inline `wait_ms`**.

### Deps: a `room`-scoped seam, without the validator

`mxRunCommand` needs the **workspace room** the call is scoped to (like delegation), but **not** a `SchemaValidator` (there is no dynamic schema to validate against). Two clean options:

```ts
// Option A (recommended) — a dedicated, minimal exec seam:
export interface ExecDeps extends HandlerDeps {
  /** The session/workspace room the command is scoped to (from MxSession, NOT model input). */
  readonly room?: string;
}

// Option B — reuse DelegateDeps (carries an unused `validator?`), or extract a shared
// `RoomScopedDeps extends HandlerDeps { room?: string }` that BOTH DelegateDeps and ExecDeps extend.
```

Recommended: **Option A** (a dedicated `ExecDeps`), and *optionally* refactor T105's `DelegateDeps` to `extends RoomScopedDeps` so the `room` contract is single-sourced. Either way the `room` provenance rule is identical to T105:

- The model must never name a Matrix room id (coordination-plane detail, design §1/§7). The binding holds the `MxSession` (T005: `{ agent_id, room/workspace, socket, correlation_id }`) and passes its room into the handler via `deps.room`.
- The outbound `exec.start` includes `room`; if `deps.room` is absent, **fail fast** with `errored('internal', …, EMPTY_AUDIT_REF)` rather than dispatching a room-less call. (Open question: the exact `exec.start` room requirement is pinned at the round-trip — it likely mirrors `call.start`, which the conformance probe supplies `room` for.)

### Phase 1 — room provenance (fail-fast)

```ts
if (deps.room === undefined || deps.room === '') {
  return errored('internal', 'no workspace room configured for exec', EMPTY_AUDIT_REF);
}
```

No Matrix round-trip has happened → `EMPTY_AUDIT_REF`. (Mirrors `mxDelegateTool` Phase 0.)

### Phase 2 — dispatch `exec.start` with idempotency

Resolve the idempotency key once, build the params, dispatch. **No allowlist/regex/cwd check happens here** — the handler forwards the request and lets the receiver decide:

```ts
const idempotency_key = input.idempotency_key ?? newIdempotencyKey();
const params = {
  room: deps.room,                  // from MxSession, not model input
  agent: input.agent,
  command: input.command,           // forwarded verbatim; the receiver allowlists it
  args: input.args ?? [],           // forwarded verbatim; the receiver runs deny_args_regex
  ...(input.cwd !== undefined ? { cwd: input.cwd } : {}), // receiver enforces allow_cwd
  idempotency_key,
};
let response: unknown;
try {
  response = await deps.daemon.call(EXEC_START_METHOD, params);
} catch (err) {
  // A daemon JSON-RPC error (policy_denied / untrusted_key / …) or transport fault →
  // the mapped envelope. AC 1 / AC 3: policy_denied → denied('policy_denied').
  return faultToResult(err, EMPTY_AUDIT_REF);
}
```

- The key rides in `params`; because `MxClient.withRetry` reuses `params` verbatim, the same key is sent on every transport-level retry — the daemon dedupes (T102 §4.4). The handler **never** regenerates it. No `CallOptions`/transport change is required.
- `deps.daemon.call` is the injected `DaemonCall` (a concrete `MxClient` in production), so `assertNoCredentialShapedArgs` (key **and value** shape) + inbound `redactSecrets` already run on this path. A credential-shaped `command`/`args` value (e.g. a `Bearer ghp_…` arg) is rejected at dispatch as `TransportError('invalid_args')` → `faultToResult` → `invalid_args` (see Security).
- A dispatch rejection that carries the daemon's deny-by-default outcome (`policy_denied` because no `allow_commands` entry matched, **or** because a `deny_args_regex` matched, **or** because `cwd` is outside `allow_cwd`) maps via `faultToResult` → `mapDaemonError(cause)` → `denied('policy_denied')`. **AC 1 and AC 3.** An `untrusted_key` rejection → `denied('untrusted_key')`; an offline target → `errored('target_offline')`.

### Phase 3 — normalize the `ExecResponse` into the envelope — AC 2, AC 3

A *resolved* (non-throwing) `exec.start` response is mapped onto the envelope by **reusing T105's `callResponseToResult`** — the `ExecResponse` disposition vocabulary is identical to `CallResponse` (a synchronous success carrying a result object, a deferred `running` + handle, a held `awaiting_approval` + approval block, or a denial/fault terminal), and the normalizer already classifies all of these and passes the success `result` through as an open object:

```ts
const result = callResponseToResult(response);
```

- A synchronous success → `ok({ exit_code, summary?, log_ref? }, audit_ref)`. **AC 2.** The exec payload is the target's `output_schema` payload; the normalizer passes it through verbatim.
- A deferred call → `running(handle, audit_ref)`; the caller resolves via `mx_await_result` (T103).
- A held call → `awaiting_approval(handle, approval, audit_ref)`; the model keeps planning and resolves later (design §5). High-risk commands carry `requires_approval = true` on the receiver, so this is the expected path for a risky allowlisted command.
- A denial → `denied('policy_denied' | 'untrusted_key' | …)`; a fault → `errored(…)`. **AC 3** when a `deny_args_regex`/un-allowlisted command came back as an `ExecResponse{ok:false, error:{code:'policy_denied'}}` rather than a thrown rpc error.
- `audit_ref` is populated from the response (`extractAuditRef`) — exec **is** a Matrix round-trip, so `invocation_id`/`request_id`/`room`/`event_id` should be present (pending the round-trip; null when omitted, never fabricated).

> **Decision to confirm — normalizer reuse vs. alias.** Recommended: **reuse `callResponseToResult` directly** (no new code; the machinery is verb-agnostic). Optionally, for call-site clarity, rename it to a transport-neutral `responseToResult` (re-exporting `callResponseToResult` as a back-compat alias) since it now serves both `call.start` and `exec.start`. A churn-free alternative is to leave the name and add a one-line TSDoc note that it also normalizes `ExecResponse`.

### Optional Phase 4 — inline `wait_ms`

Identical to T105: if the normalized result is non-terminal **and** `input.wait_ms` is a positive integer, compose `mx_await_result` on the returned handle so a fast command feels synchronous, inheriting T103's property that a `wait_ms` expiry returns the still-pending envelope (`error: null`), **never** `errored('timeout')`:

```ts
if (!isTerminal(result.status) && isPositiveWait(input.wait_ms) && result.handle) {
  return mxAwaitResult({ handle: result.handle, wait_ms: input.wait_ms }, deps);
}
return result;
```

### The non-zero exit-code semantic (important edge)

A command the receiver **allowed and ran** but that **exits non-zero** (tests failed, a linter found issues) is a **successful invocation** → `status: ok` with `result.exit_code !== 0`. The envelope `status` reflects the **coordination/governance** outcome (was the command allowlisted, did it run, was it approved), **not** the command's own exit semantics. `status: denied` / `status: error` are reserved for the daemon refusing/failing to run the command at all. This is consistent with the descriptor's `output_schema` (which requires `exit_code` on the success payload) and must be asserted in tests. A binding/model reads `result.exit_code` to learn the command's own success/failure.

### Localized wire constants

Mirror the T103/T105 precedent: keep the assumed RPC method/param names in `const`s at the top of the module so the two-daemon round-trip corrects them in one line:

```ts
const EXEC_START_METHOD = 'exec.start';
// exec.start param names (room/agent/command/args/cwd/idempotency_key) — pinned at the round-trip.
```

## Affected Files / Packages / Modules

**New:**
- `packages/registry/src/handlers/run-command.ts` — `mxRunCommand` + `RunCommandInput` + `ExecDeps` (+ the `isPositiveWait` helper, or import it if T105 exports it).
- `packages/registry/test/handlers/run-command.test.ts` — unit tests over a fake `DaemonCall`.
- `packages/registry/test/handlers/run-command.security.test.ts` — secret-boundary + no-authority + redaction assertions.
- *(Optional, staged)* `packages/toolbelt/test/conformance/exec.conformance.test.ts` — Tier-2 raw `exec.start` round-trip behind `MXL_CONFORMANCE_TWO_DAEMON=1`.

**Modified:**
- `packages/registry/src/handlers/deps.ts` — add `ExecDeps` (Option A) and/or extract a shared `RoomScopedDeps` (and re-point `DelegateDeps`).
- `packages/registry/src/handlers/index.ts` — export `mxRunCommand`, `RunCommandInput`, `ExecDeps`.
- `packages/registry/src/index.ts` — re-export the same from the package barrel.
- `packages/registry/src/handlers/invocation.ts` — *only if* renaming `callResponseToResult` → `responseToResult` (with an alias); otherwise unchanged (the reuse path adds nothing).
- `packages/registry/README.md` — add a "guarded exec handler (T106)" section in the handler-list style.
- *(Optional)* `packages/toolbelt/test/conformance/_harness.ts` — extend `TwoDaemonFixture` with `allowedCommand` / `deniedCommand` coordinates if the exec conformance test is added.

**Read (reused, not modified):**
- `src/descriptors/run-command.ts`, `src/envelope.ts`, `src/errors.ts`, `src/idempotency.ts`, `src/handlers/handler-fault.ts` (`faultToResult`, `EMPTY_AUDIT_REF`), `src/handlers/invocation.ts` (`callResponseToResult`, `failureResult`, `isTerminal`), `src/handlers/await-result.ts` (`mxAwaitResult`), `src/security.ts`.

## API / Interface Changes

- **New public API (registry):** `mxRunCommand(input: RunCommandInput, deps: ExecDeps): Promise<ToolResult>`, plus the exported types `RunCommandInput` and `ExecDeps` (and, if extracted, `RoomScopedDeps`). All exported from `@mx-loom/registry`. Documented with TSDoc in the established header-comment style.
- **Daemon RPC surface consumed:** `exec.start` (new for a *handler* — previously not consumed by any code path). No daemon-side change.
- **Tool-descriptor surface:** **none** — `MX_RUN_COMMAND` is unchanged from T101; T106 implements its handler. The `command`/`args`/`cwd`/`wait_ms`/`idempotency_key` fields are already declared. The descriptor stays in `CANONICAL_M1_TOOLS` (present-but-off; the model can name it and receive a clean `policy_denied`).
- **CLI surface:** none.
- **`HandlerDeps`:** additive only — a new `ExecDeps extends HandlerDeps` (optionally a shared `RoomScopedDeps`); no breaking change to existing handlers' deps.

## Data Model / Protocol Changes

- **Result envelope:** **no shape change.** `mx_run_command` reuses the existing `ok` / `running` / `awaitingApproval` / `denied` / `errored` builders and produces populated `audit_ref` ids on a real round-trip (like T105). The success payload conforms to the descriptor's `output_schema` (`exit_code` required; `summary` / `log_ref` optional).
- **Error taxonomy:** **no new codes.** The handler emits, via the existing mappers: `policy_denied` (not allowlisted / `deny_args_regex` match / `cwd` outside `allow_cwd`), `untrusted_key` (signing key not trusted), `approval_denied` / `approval_expired` (a held command the operator rejected / let expire), `target_offline` (remote agent offline), `invalid_args` (credential-shaped `command`/`args` rejected at dispatch, or a malformed request), `timeout` (genuine transport fault), `internal` (unrecognised response / missing room / local fault).
- **Idempotency:** the handler is the **second** mutating verb (after T105) to exercise the T102 idempotency contract — generating/forwarding `idk_<uuid>` into `exec.start` params and relying on verbatim-param retry. No format change.
- **Status semantics for non-zero exit:** documented above — a permitted command that exits non-zero is `status: ok` with `result.exit_code !== 0`. No envelope/schema change; a normalization **convention** to assert and document.
- **Wire-shape assumptions (pending the two-daemon round-trip, `MXL_CONFORMANCE_TWO_DAEMON=1`):** the `exec.start` param names (`room`/`agent`/`command`/`args`/`cwd`/`idempotency_key`), the `ExecResponse` disposition vocabulary (synchronous-result vs handle-only; running/awaiting/ok/fail tokens; the success payload field names `exit_code`/`summary`/`log_ref`), the held-invocation `approval` fields, and `audit_ref` field availability. Authored against the design's named shapes now (reusing the T102/T105 token tables + `internal`-safe fallbacks); pinned at the round-trip. A new daemon code/state degrades to `internal` (never the wrong code), never throws.

## Security & Compliance Considerations

This issue is `area/policy` precisely because the entire guard lives **outside** mx-loom. The handler's security posture is "emit a signed request and faithfully surface the receiver's verdict — change nothing."

- **Cognition produces only a signed request; it never grants itself authority.** The handler emits an `exec.start` and performs **no** trust/policy/approval/sandbox check itself. All five enforcement layers — Ed25519 verify → trust store → deny-by-default `policy.toml` (`allow_commands` + `deny_args_regex` + `allow_cwd` + sandbox backend + `network = "deny"` + `requires_approval`) → approval gate → sandbox — execute **out-of-process on the receiving daemon** (design §1, §6 layer 4, §9). `policy_denied` / `untrusted_key` / `awaiting_approval` are *outcomes the handler maps*, never decisions it makes.
- **Disabled by default is a receiver property, not a client gate.** "Ships off" means the receiver's deny-by-default `policy.toml` has no matching `allow_commands` entry, so every command is denied (AC 1). The descriptor's *presence* in the registry confers **no** capability (its TSDoc says exactly this); the model can name the tool and gets a clean `policy_denied`. mx-loom never inspects or caches the target's policy — the policy lives on the remote host. Re-implementing the allowlist locally would be both an authority surface (forbidden) and a correctness bug (the local view can never be the receiver's truth).
- **No agent gets unrestricted exec.** This is the headline constraint (design decision 2, §9). The handler imposes no wildcard exec surface: it forwards a single `command` + `args[]` + optional `cwd`, and the receiver's allowlist + regex + cwd-list + sandbox bound the blast radius. High-risk commands additionally carry `requires_approval = true` and surface as `awaiting_approval`.
- **Secret boundary (Boundary A).** No field carries a credential inbound or outbound. The handler forwards `command`/`args`/`cwd` through `MxClient.call()`, which runs `assertNoCredentialShapedArgs` **before dispatch** over both **keys and values** — so a token-shaped arg value (`GH_TOKEN`, `ghp_…`, `sk-ant-…`, a PEM header, a `Bearer …` secret) is rejected as `invalid_args` rather than becoming a command line, and inbound `redactSecrets` (value-shape-only) scrubs any token-shaped value a daemon bug might leak into `summary`/`log_ref`. This matters **more** for exec than delegation: exec args are the most likely place a model would try to inline a secret (e.g. `curl -H "Authorization: Bearer …"`). The registry adds **no** new env access and keeps its **zero runtime toolbelt dependency** (transport injected, imported `type`-only). Matrix tokens, Ed25519 signing keys, provider keys, and `GH_TOKEN` never enter the registry, the runtime, or the runner children — they stay daemon-held; runner children receive retrieved TEXT only.
- **No secret-shaped data in the envelope.** `error.message` is the fixed, secret-free phrase per code (`MESSAGE_FOR_CODE`); `approval.summary` is operator-facing text built from a fixed vocabulary (`approvalOf`), never an echo of a raw daemon payload, the command line, or an arg value. The handler must **never** place `command`/`args`/`cwd` into `error.message`.
- **Audit correlation.** Every result carries `audit_ref` tying "model ran command X" ↔ "daemon executed Y" ↔ "operator approved Z" to the signed `com.mxagent.exec.*` / approval events (design §4.6); the Postgres mirror is T113. Ids are correlation handles, not secrets; missing ids are `null`, never fabricated.
- **Idempotency is a dedup nonce, not a capability.** `idempotency_key` confers no authority and is not credential-shaped (boundaried `token$` match accepts `idempotency_key`, see `guards.ts`); the daemon re-runs the full authorize pipeline regardless of the key (design §5) — idempotency never bypasses authorize, and never re-runs a side-effecting command twice.
- **Approval re-validation at release.** When `awaiting_approval` later resolves (via `mx_await_result`), the daemon re-runs sig→trust→policy at release time, so a revoked trust or stale policy cannot smuggle a held command through. The handler relies on this; it must not cache or short-circuit an approval.
- **Logging/redaction.** Never log `command`, `args`, `cwd`, results, or any token. The only sanctioned diagnostic sink is a redaction-safe `deps.debug` that receives codes/paths/method names — never params, values, or env. (T106 should not introduce a debug sink unless T105's pattern already did.)
- **No-authority invariant holds.** `mx_run_command` stays inside `MODEL_FACING_ALLOWLIST` and is **not** a forbidden authority verb (`isForbiddenAuthorityVerb('mx_run_command') === false`) — it emits a signed request, it does not mutate trust/policy/approval. The handler exposes no approve/deny/trust/policy mutation surface.

## Testing Plan

Unit tests over a **fake `DaemonCall`** (no socket, no daemon), mirroring `test/handlers/delegate-tool.test.ts` and `await-result*.test.ts`. Because the guard is receiver-side, the fake daemon **simulates** each policy outcome.

- **AC 1 — disabled by default → `policy_denied`:** fake `exec.start` rejects with a daemon `rpc` error whose `cause` is `policy_denied` (the no-`allow_commands`-entry case), **and** a variant where it resolves a `ExecResponse{ok:false, error:{code:'policy_denied'}}` → both assert `status: denied`, `error.code: 'policy_denied'`, `validateEnvelope(result)` passes.
- **AC 2 — allowlisted command runs → envelope:** fake `exec.start` returns a synchronous success `{ ok:true, result:{ exit_code:0, summary:'…', log_ref:'ctx_…' } }` → assert `status: ok`, `result.exit_code === 0`, `result` passed through verbatim, `audit_ref` populated, `validateEnvelope(result)` passes.
- **AC 3 — `deny_args_regex` match blocked:** fake `exec.start` (given a command whose args would trip the regex) returns/throws `policy_denied` → assert `status: denied`, `error.code: 'policy_denied'`. **Document explicitly** that at the unit layer this is *indistinguishable* from AC 1 (both are "daemon returned `policy_denied`"); the *policy configuration* that produces the un-allowlisted vs. regex-matched denial is a **two-daemon conformance** concern (the staged exec fixture), not something the registry handler can or should distinguish.
- **Non-zero exit is `ok`:** fake success with `{ exit_code: 1 }` → assert `status: ok`, `result.exit_code === 1` (the invocation succeeded; the command's own failure rides in `exit_code`). Guards against mis-mapping a non-zero exit to `error`.
- **Deferred dispositions:** `exec.start` returns a `running` state + handle → `status: running`, `handle` set; an `awaiting_approval` state + approval block (high-risk `requires_approval` command) → `status: awaiting_approval`, `handle` + `approval` set (fail-safe `high` risk when omitted). Assert the disposition agrees with a subsequent `mx_await_result` poll on the same shape.
- **Inline `wait_ms`:** deferred response + `wait_ms > 0` + a fake clock/sleep → composes `mxAwaitResult`; assert it returns the terminal envelope when the next poll is terminal, and the **still-pending** envelope (`error: null`, not `timeout`) when `wait_ms` expires.
- **Idempotency:** caller-supplied key is forwarded verbatim in `exec.start` params; omitted → a generated `idk_<uuid>`; the same key is reused across a simulated retry (assert the params object passed to `exec.start` is stable, key unchanged).
- **`untrusted_key` / `target_offline`:** `exec.start` rejects `untrusted_key` → `denied('untrusted_key')`; `agent_offline`/`offline` → `errored('target_offline')`.
- **Missing room:** `deps.room` absent/empty → `internal` (no room-less `exec.start` dispatched; assert the fake `exec.start` was **never called**).
- **Robustness / never-throws:** malformed `ExecResponse` (scalar/array/null) → `internal`, never a thrown error; a handle-only response with no state → `running`.
- **`args`/`cwd` omitted:** `args` absent → forwarded as `[]` (or omitted, per the confirmed wire shape); `cwd` absent → omitted from params. Assert no `undefined` leaks into the params object.
- **Secret boundary / redaction (`run-command.security.test.ts`):** a credential-shaped `command`/`args` **value** (`['-H','Authorization: Bearer ghp_…']`) surfaces as `invalid_args` (via the real `MxClient` guard, or asserted at the registry boundary); a credential-shaped param **key** likewise; a fake `exec.start` returning a token-shaped value in `summary`/`log_ref` is redacted before the result is returned (when exercised through `MxClient`); no `error.message` / `approval.summary` / log line contains the command, an arg value, a cwd, or a token; `mx_run_command` is in `MODEL_FACING_ALLOWLIST` and `isForbiddenAuthorityVerb('mx_run_command') === false`.
- **Envelope/error-taxonomy conformance:** every returned `ToolResult` passes `validateEnvelope`; every emitted `error.code` is in the closed `ERROR_CODES` set.

**Conformance (staged, optional this issue):** add `packages/toolbelt/test/conformance/exec.conformance.test.ts` mirroring `delegate.conformance.test.ts`, gated behind `MXL_CONFORMANCE_TWO_DAEMON=1`, driving a **raw** `MxClient.call('exec.start', …)` for (a) an allowlisted command → no denial, conforming `ok` envelope + `audit_ref` field probe; (b) an un-allowlisted / `deny_args_regex`-matched command → `isDenial(...)` true and `mapDaemonError(cause)` → `policy_denied` (pins the live `policy_denied` spelling for `exec.start`, the OQ #3 analogue); (c) idempotency dedup. This requires the bring-up to add `allow_commands` + `deny_args_regex` to daemon B's `policy.toml` and export `MXL_CONFORMANCE_ALLOWED_COMMAND` / `MXL_CONFORMANCE_DENIED_COMMAND` (a `TwoDaemonFixture` extension). Mark it staged/red-on-drift like the delegate fixture; the M1 deliverable is the **unit** tests, with the live round-trip pinned later.

## Documentation Updates

- **`docs/backlog.md`** — flip T106's three AC checkboxes once landed and append a `**Status:** Landed (…)` note in the T103/T104/T105 style (module list + resolved decisions + the wire assumptions pending the two-daemon round-trip).
- **`docs/mx-agent-tool-fabric-design.md`** — update the §3 "Build rule" parenthetical and the M1 status line (header table + §10 roadmap) to record that `mx_run_command` (T106) is implemented as the guarded-exec sibling of `mx_delegate_tool`, so M1's "delegate a named tool *and* a guarded command" surface is code-complete at the handler layer. Reaffirm §6 layer 4 / §9: the guard remains entirely receiver-side. Do **not** imply the bindings (T109/T110), the golden test (T114), or the live two-daemon `exec.start` round-trip exist.
- **`docs/mx-agent-surface-v0.2.1.md`** — once the (optional) exec conformance fixture runs green, flip `exec.start` from "◻️ flags confirmed" to ✅ and record the confirmed `ExecResponse` shape (state vocabulary, `exit_code`/`summary`/`log_ref` fields, `audit_ref` fields, approval block). Until then, leave the note and reference this spec's open questions.
- **`packages/registry/README.md`** — add a "guarded exec handler (T106)" section: the present-but-off contract, the receiver-side guard, the three-phase shape (no inner-schema validation), `ExecDeps` (room injected, **no** validator), and the reuse of `callResponseToResult` + the non-zero-exit semantic.
- TSDoc on the new handler in the established header-comment style (cross-link the design sections and the receiver-side enforcement note).

## Risks and Open Questions

1. **`exec.start` wire shape (the central unknown).** Unlike `call.start`, `exec.start` has **no** existing conformance probe — its round-trip is not even staged. The exact param names (`room`/`agent`/`command`/`args`/`cwd`/`idempotency_key`), the `ExecResponse` disposition vocabulary, the success payload field names (`exit_code`/`summary`/`log_ref`), the held-invocation `approval` fields, and `audit_ref` availability are **pending the two-daemon round-trip**. Mitigation: localize the method/param consts; reuse the T102/T105 token tables + `internal`-safe fallbacks; add the staged exec fixture to pin them. **Decision to confirm:** proceed authoring against the design's named shapes (recommended, consistent with T101–T105) vs. block on the live round-trip.
2. **Room provenance.** The model-facing schema has no `room`, but `exec.start` (like `call.start`) needs one. Recommended: inject from the `MxSession` via `deps.room`; fail fast (`internal`) if absent. **Confirm** whether `exec.start` truly requires `room` on v0.2.1 or derives it from the agent/workspace.
3. **Deps shape.** Recommended: a dedicated `ExecDeps extends HandlerDeps { room? }` (no validator), optionally extracting a shared `RoomScopedDeps` that both `DelegateDeps` and `ExecDeps` extend. **Confirm** vs. reusing `DelegateDeps` (carries an unused `validator?`).
4. **Normalizer reuse vs. rename.** Recommended: reuse `callResponseToResult` directly (verb-agnostic). **Confirm** whether to rename it `responseToResult` (with a back-compat alias) for clarity now that it serves both `call.start` and `exec.start`, or leave the name and add a TSDoc note.
5. **Non-zero exit semantics.** Recommended: a permitted command that exits non-zero is `status: ok` with `result.exit_code !== 0` (the envelope status is the governance outcome, not the command's exit). **Confirm** — this is a convention bindings/models depend on; the alternative (mapping non-zero exit to `error`) would conflate "the daemon refused" with "the command failed" and is **not** recommended.
6. **AC 1 vs AC 3 are indistinguishable at the unit layer (honesty caveat).** Both an un-allowlisted command and a `deny_args_regex` match produce a daemon `policy_denied` that the handler maps identically. The handler cannot (and must not) tell them apart — the distinction lives in the receiver's `policy.toml`. So the *handler* unit tests assert "maps `policy_denied` → `denied('policy_denied')`" for both; the *policy configuration* that yields each is exercised only by the staged exec conformance fixture. The spec/PR must not imply the handler "implements" deny-by-default or the regex.
7. **Inline `wait_ms` ownership.** Recommended: honor `wait_ms` in the handler by composing `mxAwaitResult` (the descriptor declares it, T105 precedent). **Confirm** vs. leaving the poll to the bindings. Either way the descriptor field stays.
8. **Output-schema validation.** AC 2 says the allowlisted command "returns the envelope". Recommended: **pass-through, no hard outbound validation** of `result` against `output_schema` (the target/daemon owns its output contract; at most an optional redaction-safe diagnostic on mismatch). **Confirm** whether AC 2 requires active outbound validation or just a conforming envelope.
9. **Whether a binding may hide `mx_run_command` entirely.** "Tool ships off" is satisfied by deny-by-default policy with the descriptor *present* (so the model gets a clean `policy_denied`). A binding (T109/T110) *could* additionally let an operator omit the descriptor from the exposed toolset when exec must be fully hidden — a **binding** config concern, out of scope for T106. **Confirm** this is deferred to the bindings, not gated in the handler/registry.

## Implementation Checklist

1. Add the deps seam in `src/handlers/deps.ts`: a dedicated `ExecDeps extends HandlerDeps { readonly room?: string }` (TSDoc that `room` comes from `MxSession`, never model input). Optionally extract `RoomScopedDeps` and re-point `DelegateDeps`.
2. Decide the normalizer path (Risk #4): reuse `callResponseToResult` as-is (recommended) — add a TSDoc note in `invocation.ts` that it also normalizes `ExecResponse`; or rename to `responseToResult` with a `callResponseToResult` alias and update T105's import.
3. Create `src/handlers/run-command.ts`:
   - localized wire const (`EXEC_START_METHOD = 'exec.start'`; param-name note);
   - `RunCommandInput` (`agent`, `command` req; `args?`, `cwd?`, `wait_ms?`, `idempotency_key?`);
   - Phase 1 — room provenance: `errored('internal', …, EMPTY_AUDIT_REF)` when `deps.room` is absent/empty;
   - Phase 2 — resolve `idempotency_key` (caller or `newIdempotencyKey()` once), build `exec.start` params (`room` from `deps.room`; `command`/`args`/`cwd` forwarded verbatim; omit `cwd`/`undefined`), dispatch via `deps.daemon.call`; `faultToResult(err, EMPTY_AUDIT_REF)` on rejection (maps `policy_denied` → `denied`);
   - Phase 3 — `callResponseToResult(response)` → the terminal/deferred envelope (sync `ok` carries `{exit_code,…}`);
   - Phase 4 — if non-terminal and `wait_ms > 0`, compose `mxAwaitResult({ handle, wait_ms }, deps)`;
   - guarantee the function never throws (every path returns a `ToolResult`);
   - **no** allowlist/regex/cwd/sandbox check anywhere in the handler.
4. Export `mxRunCommand`, `RunCommandInput`, `ExecDeps` from `src/handlers/index.ts` and `src/index.ts`.
5. Write `test/handlers/run-command.test.ts` covering AC 1 (policy_denied, thrown + `ok:false`), AC 2 (allowlisted → `ok` + populated `audit_ref`), AC 3 (deny_args_regex → policy_denied), non-zero exit → `ok`, deferred dispositions, inline `wait_ms`, idempotency, `untrusted_key`/`target_offline`, missing room (never dispatched), `args`/`cwd` omission, and never-throws/robustness.
6. Write `test/handlers/run-command.security.test.ts` covering credential-shaped `command`/`args` value & key → `invalid_args`, inbound redaction of token-shaped `summary`/`log_ref`, secret-free envelope/messages (no command/args/cwd echoed), and the no-authority/allowlist invariants.
7. *(Optional, staged)* Add `packages/toolbelt/test/conformance/exec.conformance.test.ts` + extend `TwoDaemonFixture` with `allowedCommand`/`deniedCommand`; gate behind `MXL_CONFORMANCE_TWO_DAEMON=1`; pin the live `exec.start` `policy_denied` spelling and `audit_ref` fields.
8. Update `packages/registry/README.md` (T106 handler section), `docs/backlog.md` (T106 ACs + Status note), `docs/mx-agent-tool-fabric-design.md` (§3/§6/§9 + M1 status), and (when the fixture is green) `docs/mx-agent-surface-v0.2.1.md`.
9. Run `pnpm --filter @mx-loom/registry test` + typecheck/lint; confirm green. Do **not** run git/gh (the orchestrator owns that).
