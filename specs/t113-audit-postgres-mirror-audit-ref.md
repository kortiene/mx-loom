# T113 · Postgres audit mirror of `audit_ref` — the queryable index of the two-tier audit

> Issue #21 · `area/audit` · `type/feature` · `P1` · **M** · Milestone **M1 — Delegation MVP**
> Source: `docs/backlog.md` (`T113`). Blocked-by #10 (T102 — the result envelope + `audit_ref` + error taxonomy + idempotency), which has **landed**.

## Problem Statement

mx-loom's audit story is two-tier (design §7): the **substrate** — the signed, replay-protected `com.mxagent.*` Matrix event stream — is the tamper-evident *truth*; a **Postgres index** is the *queryable* mirror an operator/app actually searches ("show me every delegation in room X today", "which model action led to invocation `inv_…`", "what was approved and by correlation to what request"). Today only the first tier exists in this repo: every tool result already carries the `audit_ref` correlation block (`{ invocation_id, request_id, room, event_id }`, landed in T102 / `packages/registry/src/envelope.ts`), but **nothing persists it**. There is no Postgres table, no `pg` dependency, no migration, and no sink that turns the stream of `ToolResult` envelopes into queryable rows.

The roadmap pins this as an M1-exit requirement: *"audit refs land in Postgres"* (design §10, M1 row; backlog M1 DoD). Design §8 (MVP scope) names the deliverable precisely — *"Read-only audit refs surfaced on every result + a thin mirror into the existing Postgres audit table"* — and the golden end-to-end test (T114) asserts *"Audit rows present for each step."* T113 builds that thin mirror: a minimal schema/migration plus the secret-free projection and idempotent write path that lands exactly one row per tool result and lets an operator correlate **model action ↔ daemon invocation ↔ approval**.

The current gap, concretely:

- The `audit_ref` is *surfaced* on the envelope but *unpersisted* — it evaporates the moment the runtime moves on.
- There is no chokepoint that observes every `ToolResult` and records it. Handlers (T104–T108) return envelopes; the bindings that will return them to the runtime (MCP T109, Claude shim T110) **do not exist yet**, so the place where "every result is seen exactly once" lives is still on the drawing board.
- There is no notion of *exactly-once* mirroring: a transport-level retry (T102 idempotency) or a re-emitted result must not double-write.

## Goals

- **A minimal Postgres schema + migration** for an audit table that stores, per tool result: the four `audit_ref` correlation ids (`invocation_id`, `request_id`, `room`, `event_id`), the `tool_name`, the envelope `status`, the closed-taxonomy `error.code` (when failed), the `approval.request_id` (when approval-gated), and the session `correlation_id` (T005) — the columns the two acceptance criteria require, and nothing the index does not need.
- **A pure projection** `auditRowFrom(result, ctx)` that maps a T102 `ToolResult` + a small binding-supplied context (`tool_name`, `call_id`, `correlation_id?`, `idempotency_key?`) onto an `AuditRow` — no I/O, no secrets, deterministic, total.
- **An injected `AuditSink` port** with an idempotent `record(row)` (exactly-once via a dedup key + `ON CONFLICT DO NOTHING`), plus three adapters: a `PostgresAuditSink` (the real mirror), an `InMemoryAuditSink` (unit + golden-test fixture), and a `NullAuditSink` (audit disabled / no DSN configured).
- **AC 1 — exactly one row per tool result:** the sink writes each result's row idempotently; wired at the *single* binding dispatch chokepoint (a thin `withAudit` tap), every returned envelope produces exactly one row, and a retry of the same emission produces none extra.
- **AC 2 — rows correlate model action ↔ daemon invocation ↔ approval:** `tool_name` + `correlation_id` + `idempotency_key` (model action) ↔ `invocation_id` + `request_id` + `event_id` + `room` (daemon invocation, the substrate-truth pointer) ↔ `approval_request_id` (approval), all on one queryable row, joinable across a deferred call's lifecycle by `invocation_id`.
- **Preserve every mx-loom invariant:** the mirror stores only non-secret correlation data; it never persists `result` payloads, raw tokens, or unredacted free text; the audit write is *best-effort* and never compromises or blocks the tamper-evident substrate truth or the model's tool call; no new model-facing tool is added (the sink is host/binding infrastructure, never an `mx_*` verb).

## Non-Goals

- **Multi-tenant RLS (M5 / T501, T502).** Explicitly out of scope ("Out of scope: Multi-tenant RLS"). T113 ships a single-tenant table. It is *designed RLS-ready* — `room` is the future tenant key — but adds **no** `CREATE POLICY`, no `tenant_id`, no row-level security. T502 ("two-tier audit/index", blocked-by T113) layers RLS on later.
- **Per-call cost attribution / metrics / traces (M5 / T503, T504).** The mirror records correlation + status, not latency, tokens, or cost. ADR-08 observability is separate.
- **Approval dashboards / decision UI (M4 / T403).** T403 *reads* this table (it is blocked-by T113) but the operator UI is not built here.
- **A bidirectional or authoritative store.** Postgres is a *mirror/index*, never truth. T113 never reconstructs substrate state from Postgres, never lets a Postgres row override a signed event, and never makes the model's tool result depend on a successful DB write.
- **Bindings (T109/T110) and the golden test (T114).** T113 delivers the schema, projection, sink, adapters, and the `withAudit` tap, plus unit tests against fake handlers. The *single-chokepoint wiring* into the MCP server and Claude shim is a one-line application those binding issues perform; the *end-to-end* "rows present for each step" assertion is T114.
- **Migrating or owning mx-agency's existing audit store.** Design §7/§8 reference mx-agency's ADR-07/ADR-10 Postgres + RLS store. Whether T113's table *is* that store or a mx-loom-local reference table that later points at it is a **decision to confirm** (see Risks) — the default here is a mx-loom-owned reference table that is schema-compatible with being repointed.

## Relevant Repository Context

**Stack.** TypeScript, pnpm workspaces, Node ≥20.19, vitest, Apache-2.0. The boilerplate "repo is docs-only today" caveat in the task template is **stale for this issue**: `packages/registry` (`@mx-loom/registry`), `packages/toolbelt` (`@mx-loom/toolbelt`), and `packages/claude` (`@mx-loom/claude`) are real, populated, tested packages (T001–T008, T101–T108, T111, T112 landed). What does **not** exist yet and T113 must introduce:

- **No persistence layer of any kind.** A repo-wide search for `postgres` / `pg` / `migration` / `.sql` finds only the design doc and backlog prose — no driver dependency, no migration runner, no `@mx-loom/audit` package, no DB config. This is greenfield within an established package conventions set.
- **No central tool dispatch and no bindings.** Handlers (`packages/registry/src/handlers/*`) are exported as individual functions. The MCP server (T109) and Claude in-process shim (T110) — the layers that will return envelopes to a runtime and are the natural "every result" chokepoint — are unbuilt (`packages/claude` holds only the JSON Schema → Zod converter from T111).

**The landed contract T113 builds on (read before coding):**

- **`packages/registry/src/envelope.ts`** — the `ToolResult<T>` envelope and its `AuditRef`:
  ```ts
  interface AuditRef {
    invocation_id: string | null;  // inv_…  daemon invocation
    request_id:    string | null;  // req_…  the signed request
    room:          string | null;  // !…:server  Matrix room (future tenant key)
    event_id:      string | null;  // $…      signed Matrix event (substrate-truth pointer)
  }
  interface ToolResult<T> {
    status: 'ok'|'running'|'awaiting_approval'|'denied'|'error';
    result: T | null;
    error:  { code: ErrorCode; message: string } | null;  // message is secret-free by contract
    handle: string | null;
    approval: { request_id; risk; summary; expires_at } | null;
    audit_ref: AuditRef;  // structurally always present; inner ids null when daemon omits them
  }
  ```
  Key facts T113 must respect: `audit_ref` is **always structurally present** but its ids are `null` for a local read (`mx_find_agents`/`mx_describe_agent`/`mx_workspace_status` use `EMPTY_AUDIT_REF`, all-null — no Matrix round-trip) and for a `running` result before the daemon returns ids; ids are **never fabricated** (T102/T103 invariant). The `error.message` is secret-free *by contract* but is human free-text, so the minimal mirror indexes on the closed `error.code`, not the message.
- **`packages/registry/src/errors.ts`** — `ERROR_CODES` (the closed nine-code taxonomy), `ErrorCode`. `error_code` rows draw from this closed set — safe to store, queryable, never a secret.
- **The injected-seam pattern** (`packages/registry/src/handlers/deps.ts`) — every handler depends on a narrow injected interface (`DaemonCall = Pick<MxTransport,'call'>`), never a concrete client, imported `type`-only so the registry keeps a **zero runtime `@mx-loom/toolbelt` dependency**. T113's `AuditSink` follows this exact precedent: a narrow port, injected, with the heavy `pg` dependency quarantined in a separate adapter/package so the registry and toolbelt keep their dependency hygiene.
- **The secret boundary already enforced** (`packages/toolbelt/src/guards.ts`, T008) — `assertNoCredentialShapedArgs` rejects credential-shaped args; `redactSecrets` scrubs token-shaped values inbound on `MxClient.call`. So by the time a `ToolResult` reaches the audit tap it has already passed the secret boundary; the mirror stores a strict, non-secret *subset* of it and re-uses `redactSecrets` if it ever stores free text.
- **Session correlation** (`packages/toolbelt/src/correlation.ts`, T005) — `MxSession` carries a session-stable `correlation_id` threaded onto every outbound call. This is the "model action" thread the audit row needs to tie a session's results together; it is **not** in the `ToolResult` envelope (the binding knows it), so the projection takes it as context.

**Important honest note on the envelope ↔ AC-2 gap:** the `ToolResult` envelope alone is *insufficient* for AC-2. It carries `audit_ref` (daemon invocation), `status`, and `approval.request_id` (approval) — but **not** `tool_name`, `correlation_id`, or `idempotency_key` (the model-action side). Those are context the **binding** holds at dispatch. The projection therefore takes `(result, ctx)`; T113 must define that `ctx` shape and document that the binding supplies it. This is a real coupling and is surfaced, not hidden.

## Proposed Implementation

A new opt-in leaf package `@mx-loom/audit` containing the pure projection, the `AuditSink` port, three adapters, the migration, and a `withAudit` tap. The registry and toolbelt gain **no** new dependency; only the new package depends on `pg`.

### A. The row shape and minimal schema

`AuditRow` (TypeScript) and the table mirror each other 1:1:

```ts
export interface AuditRow {
  // correlation — the audit_ref (daemon invocation / substrate-truth pointer)
  invocation_id: string | null;   // inv_…
  request_id:    string | null;   // req_…
  room:          string | null;   // !…:server  (future tenant key — RLS-ready, M5)
  event_id:      string | null;   // $…          (signed Matrix event)
  // model action
  tool_name:      string;         // mx_delegate_tool, mx_run_command, …
  correlation_id: string | null;  // session correlation_id (T005)
  idempotency_key: string | null; // client-supplied dedup nonce (mutating verbs, T102)
  // outcome / approval
  status:     ToolStatus;         // ok|running|awaiting_approval|denied|error
  error_code: ErrorCode | null;   // closed taxonomy, only when status ∈ {denied,error}
  approval_request_id: string | null; // approval.request_id when awaiting_approval / resolved
  // exactly-once
  dedup_key: string;              // deterministic per (call_id,status) — see §C
}
```

Migration `migrations/0001_mx_audit_log.sql` (idempotent, plain SQL — no heavy framework for M1):

```sql
CREATE TABLE IF NOT EXISTS mx_audit_log (
  id              BIGSERIAL PRIMARY KEY,
  -- audit_ref (daemon invocation / substrate pointer)
  invocation_id   TEXT,
  request_id      TEXT,
  room            TEXT,
  event_id        TEXT,
  -- model action
  tool_name       TEXT NOT NULL,
  correlation_id  TEXT,
  idempotency_key TEXT,
  -- outcome / approval
  status          TEXT NOT NULL,
  error_code      TEXT,
  approval_request_id TEXT,
  -- bookkeeping + exactly-once
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  dedup_key       TEXT NOT NULL
);

-- exactly-once mirror (AC 1): a second write of the same emission is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS mx_audit_log_dedup_key_uq ON mx_audit_log (dedup_key);
-- correlation query paths (AC 2): join a deferred call's lifecycle + scope by room.
CREATE INDEX IF NOT EXISTS mx_audit_log_invocation_idx   ON mx_audit_log (invocation_id);
CREATE INDEX IF NOT EXISTS mx_audit_log_correlation_idx  ON mx_audit_log (correlation_id);
CREATE INDEX IF NOT EXISTS mx_audit_log_room_recorded_idx ON mx_audit_log (room, recorded_at);
```

Notes:
- `status` / `error_code` are stored as `TEXT` validated *in code* against the closed T102 sets (not a PG `ENUM`, to avoid a migration on every future code addition — the closed-set guarantee is enforced by the projection, which only ever receives a valid `ToolResult`).
- No `result_payload`, no `error_message`, no `approval_summary` column — the index never stores tool output or free text (secret-hygiene + size). Storing a redacted `error_message` is a documented opt-in (see Security), not the M1 default.
- `room` is **nullable** (local reads have no room) and indexed so M5/T502 can add RLS keyed on it without a structural migration.

### B. The pure projection

`auditRowFrom(result: ToolResult, ctx: AuditContext): AuditRow` where:

```ts
export interface AuditContext {
  tool_name: string;          // which mx_* verb produced this result
  call_id: string;            // the binding's per-tool-call id (MCP/Claude tool_use id, or a uuid)
  correlation_id?: string;    // MxSession.correlation_id (T005)
  idempotency_key?: string;   // the client-supplied key the mutating handler used (T102)
}
```

Behavior — pure, total, no I/O:
- Lift the four `audit_ref` ids verbatim (already non-secret; may be `null`).
- `status = result.status`; `error_code = result.error?.code ?? null` (closed-set, never the message).
- `approval_request_id = result.approval?.request_id ?? null`.
- `tool_name`, `correlation_id ?? null`, `idempotency_key ?? null` from `ctx`.
- `dedup_key = deriveDedupKey(ctx.call_id, result.status, result.audit_ref.invocation_id)` (see §C).

### C. Exactly-once (AC 1) — the dedup key

Each returned envelope is **one audit event** → one row (an append-only trail). A deferred call that returns `running` then resolves `ok` via `mx_await_result` is **two** events sharing one `invocation_id` (status `running`, then `ok`) — that *is* the audit trail, not a duplicate. "Exactly one row per tool result" therefore means *idempotent per emission*: re-recording the *same* emission (a transport retry, a binding re-delivery) must not add a row.

`deriveDedupKey(call_id, status, invocation_id)` returns a stable string, e.g. `` `${call_id}:${status}:${invocation_id ?? '∅'}` ``. The binding supplies a unique `call_id` per tool call (runtimes already mint one — the MCP/Claude `tool_use` id), so two *distinct* calls never collide even when both are e.g. `mx_find_agents` → `ok` with all-null `audit_ref`; and a *re-emission* of the same call+status collides and `ON CONFLICT (dedup_key) DO NOTHING` makes it a no-op. This is the exact-once mechanism; "every result" is then a property of wiring it at the single chokepoint (§E).

### D. The sink port + adapters

```ts
export interface AuditSink {
  /** Idempotent: re-recording the same dedup_key is a no-op. Best-effort; must not throw into the caller's hot path. */
  record(row: AuditRow): Promise<void>;
  close?(): Promise<void>;
}
```

- **`PostgresAuditSink`** (`pg`-backed) — `INSERT … ON CONFLICT (dedup_key) DO NOTHING`. Owns a pooled connection from an injected DSN/config (never logged). Exposes `migrate()` to apply `0001_mx_audit_log.sql`.
- **`InMemoryAuditSink`** — an array-backed sink with the same dedup semantics, for unit tests and the T114 golden fixture (so the golden test can assert "rows present" with no real Postgres).
- **`NullAuditSink`** — a no-op for "audit disabled / no DSN"; the mirror is optional infrastructure and its absence never breaks tool calls.

### E. The wiring tap (`withAudit`) — best-effort, single chokepoint

A thin higher-order tap the bindings apply once:

```ts
export function withAudit(sink: AuditSink, baseCtx: Omit<AuditContext,'call_id'>) {
  return async function tap(result: ToolResult, perCall: { tool_name: string; call_id: string }) {
    try {
      await sink.record(auditRowFrom(result, { ...baseCtx, ...perCall }));
    } catch (err) {
      // Best-effort: the queryable index is not truth. Log (redacted) + metric; NEVER rethrow.
      logAuditFailure(err);
    }
    return result; // pass the envelope through untouched
  };
}
```

Properties this guarantees and the honest limits:
- **Pass-through + best-effort:** the tap returns the envelope unchanged and *swallows* sink failures (logged, redacted). A Postgres outage degrades the index, never the model's tool call or the substrate truth.
- **Single chokepoint = "every result":** applied once at the binding's result-return point (T109/T110), every `mx_*` result flows through it exactly once. T113 cannot *prove* "every" on its own because the chokepoint is the binding; T113 delivers the mechanism + unit proof over a fake dispatch, and T114 proves it end-to-end. This limit is stated plainly rather than implied away.

### F. Package wiring

- New `packages/audit` → `@mx-loom/audit`, `exports: "./src/index.ts"`, `pg` as its **only** new runtime dep (kept out of registry/toolbelt). `@mx-loom/registry` is a `type`-only dep for `ToolResult`/`AuditRef`/`ErrorCode` (same `type`-only technique the registry uses for the toolbelt) so no runtime cycle is created.
- Add `packages/audit` under the existing `packages/*` workspace glob (already covered by `pnpm-workspace.yaml`).

## Affected Files / Packages / Modules

New package `packages/audit` (`@mx-loom/audit`):
- `package.json` — `pg` runtime dep; `@mx-loom/registry` (type-only) + `@types/node` + `typescript` + `vitest` dev deps; `tsconfig.json` / `tsconfig.build.json` mirroring sibling packages.
- `src/row.ts` — `AuditRow`, `AuditContext`, `AuditStatus`/`AuditErrorCode` re-exports.
- `src/project.ts` — `auditRowFrom(result, ctx)`, `deriveDedupKey(...)` (pure).
- `src/sink.ts` — `AuditSink` interface; `InMemoryAuditSink`, `NullAuditSink`.
- `src/postgres.ts` — `PostgresAuditSink`, `migrate()`, DSN/config plumbing (no logging of credentials).
- `src/with-audit.ts` — the `withAudit` tap + `logAuditFailure` (redacted).
- `src/index.ts` — barrel.
- `migrations/0001_mx_audit_log.sql` — the table + indexes above.
- `test/project.test.ts`, `test/sink-idempotency.test.ts`, `test/with-audit.test.ts`, `test/postgres.integration.test.ts` (gated), `test/secret-boundary.test.ts`.

Read-only references (no change needed, but the projection couples to their shapes):
- `packages/registry/src/envelope.ts` (`ToolResult`, `AuditRef`, `ToolStatus`), `packages/registry/src/errors.ts` (`ErrorCode`).
- `packages/toolbelt/src/correlation.ts` (`correlation_id` provenance), `packages/toolbelt/src/guards.ts` (`redactSecrets`, for the opt-in message path).

Docs:
- `docs/mx-agent-tool-fabric-design.md` (§7 audit, §8 MVP scope, status banner), `docs/backlog.md` (T113 status), and `packages/audit/README.md`.

To-be-modified later (out of T113, noted for the chain): the MCP server (T109) and Claude shim (T110) apply `withAudit` at their dispatch chokepoint; the golden test (T114) asserts rows via `InMemoryAuditSink` (or a real PG in CI).

## API / Interface Changes

- **No model-facing / tool-descriptor change.** No new `mx_*` verb, no `CANONICAL_M1_TOOLS` change, no `MODEL_FACING_ALLOWLIST` change. The audit mirror is host/binding infrastructure the model never sees or calls. (Stated explicitly because audit is the kind of thing one might wrongly expose as a tool — it must not be.)
- **No daemon-RPC / Boundary-B change.** T113 consumes the `audit_ref` the daemon already returns; it adds no RPC.
- **No result-envelope change.** The `ToolResult`/`AuditRef` shape is consumed verbatim; T113 adds no field. (If the round-trip later shows the daemon can surface a `correlation_id` *inside* `audit_ref`, that is a T102/T103 envelope change, not T113.)
- **New public API (documented):** the `@mx-loom/audit` surface — `AuditRow`, `AuditContext`, `auditRowFrom`, `deriveDedupKey`, `AuditSink`, `PostgresAuditSink`, `InMemoryAuditSink`, `NullAuditSink`, `withAudit`, `migrate`. Documented in `packages/audit/README.md` per the "document new public APIs" rule.

## Data Model / Protocol Changes

- **New table `mx_audit_log`** (DDL in Proposed Implementation §A) — the only schema change. Columns serve AC-1 (the `dedup_key` unique index) and AC-2 (the four `audit_ref` ids + `tool_name`/`correlation_id`/`idempotency_key` + `approval_request_id`, joinable by `invocation_id`/`correlation_id`).
- **Idempotency-key reuse:** the row stores the T102 `idempotency_key` for the mutating verbs (model-action correlation) and *separately* uses a `dedup_key` for exactly-once mirror writes — two distinct concerns (one is the daemon's replay nonce, the other is the mirror's write-dedup), kept as separate columns so neither is overloaded.
- **No error-taxonomy change.** `error_code` draws from the existing closed `ErrorCode` set; no new code.
- **No serialization/result-shape change.**

## Security & Compliance Considerations

- **Secret boundary (Boundary A) is untouched and reinforced.** The mirror runs *after* the secret boundary: by the time a `ToolResult` reaches `withAudit`, `MxClient` has already applied the deny-by-default env allowlist, `assertNoCredentialShapedArgs`, and inbound `redactSecrets` (T008). Matrix tokens, Ed25519 signing keys, provider keys, and `GH_TOKEN` never appear in a `ToolResult` and therefore never in a row. The audit package holds **no** coordination-plane secret and performs no signing.
- **The mirror stores a strict non-secret subset.** Only correlation ids (`inv_…`/`req_…`/`!…:server`/`$…` — none a secret), `tool_name`, `status`, closed-set `error_code`, `approval_request_id`, `correlation_id`, `idempotency_key`. It **never** stores `result` payloads (which can carry retrieved TEXT), and **never** the free-text `error.message` or `approval.summary` in the M1 schema. If a later need to store `error.message` arises, it MUST pass through the toolbelt `redactSecrets` first — flagged as an opt-in, not the default.
- **The Postgres DSN is an app-layer credential, not a Boundary-A secret** (it is not a Matrix/Ed25519/provider/`GH_TOKEN`). It still must never be logged, never placed in any tool field, and never exposed to the runtime/model — it lives in the host/binding process config beside the daemon socket path. `PostgresAuditSink` redacts it from any error it logs.
- **Cognition grants itself no authority here.** The audit mirror is observation-only: it records what *already happened*. It is not a model tool, confers no capability, and cannot mutate trust/policy/approval. Approval still reaches the model only as the `awaiting_approval` status, re-validated against live policy at release (design §5) — recording the `approval_request_id` does not let the model approve anything.
- **Audit correlation is the point.** Every result carries `audit_ref`; this issue is what makes "model decided X ↔ daemon executed Y ↔ operator approved Z" *queryable*, while the substrate remains the tamper-evident truth. The Postgres row is explicitly **not** authoritative — it can never override a signed event, and the mirror being behind/unavailable never weakens truth.
- **Logging/redaction.** `logAuditFailure` logs the failure *class* and `dedup_key` only — never the row's correlation ids verbatim if any policy later deems them sensitive, never the DSN, never a secret. Best-effort writes never surface DB internals to the model.
- **RLS deferred but designed-for.** No row-level security in M1 (M5/T502); `room` is the tenant key the future RLS policy keys on, so the M1 schema does not need a breaking migration to gain isolation.

## Testing Plan

- **Unit — projection (`project.test.ts`):** `auditRowFrom` maps each status (`ok`/`running`/`awaiting_approval`/`denied`/`error`) to the right row; `error_code` populated only for `denied`/`error` and drawn from the closed set; `approval_request_id` populated only for `awaiting_approval`; all-null `audit_ref` (local read) yields null correlation ids but a valid row; `tool_name`/`correlation_id`/`idempotency_key` lifted from `ctx`. Purity/totality: never throws on any well-formed `ToolResult`.
- **Unit — exactly-once (`sink-idempotency.test.ts`):** recording the same emission twice (same `dedup_key`) yields one row (`InMemoryAuditSink` and, gated, `PostgresAuditSink` via `ON CONFLICT DO NOTHING`); distinct lifecycle emissions of one invocation (`running` then `ok`) yield two rows sharing `invocation_id`; two distinct calls with identical content (same tool, all-null `audit_ref`) yield two rows (distinct `call_id`).
- **Unit — `withAudit` (`with-audit.test.ts`):** passes the envelope through unchanged; a throwing sink is swallowed (best-effort) and logged, never rethrown; exactly one `record` call per result; over a fake dispatch of N handler results, exactly N rows.
- **Correlation query (AC 2):** an integration-style test seeds an `awaiting_approval` row then a terminal `ok`/`denied` row for the same `invocation_id` and asserts a join recovers the model action ↔ invocation ↔ approval chain; a `correlation_id` query returns a session's full result set.
- **Postgres integration (`postgres.integration.test.ts`, gated):** behind an env flag (e.g. `MXL_AUDIT_PG=1`, in the spirit of the existing `MXL_CONFORMANCE*` gates) against a disposable Postgres — `migrate()` is idempotent (run twice, no error), insert + dedup + the three indexed query paths work. Skipped (not failed) when no DB is provisioned, mirroring the toolbelt conformance gating; document this in the package README.
- **Secret-boundary / redaction (`secret-boundary.test.ts`):** assert no row column ever holds a token-shaped value across a battery of envelopes; assert `result` payloads and `error.message` are never persisted; assert the DSN never appears in a logged error.
- **Schema/migration test:** the SQL parses and applies; `dedup_key` unique index rejects a duplicate; nullable `room`/correlation columns accept nulls.
- **Documentation test/check:** the README's exactly-once + best-effort + non-authoritative claims match the code.

## Documentation Updates

- **`docs/mx-agent-tool-fabric-design.md`** — update §7 (audit) and §8 (MVP scope) status notes to reflect the mirror landing (parallel to how §1/§3/§4 carry per-task landed notes); update the status banner if T113 closes the M1 audit deliverable.
- **`docs/backlog.md`** — flip T113's checkboxes/status with the same honesty convention used by T101–T108/T112 (what landed; what is staged behind T109/T110/T114 wiring and behind a live Postgres gate); note T403 (M4) and T502 (M5) now have their blocked-by dependency satisfied.
- **`packages/audit/README.md`** — new public API surface; the two-tier "Postgres is the queryable index, not truth" framing; the exactly-once (dedup) + best-effort (non-blocking) + secret-subset guarantees; how a binding wires `withAudit`; the `MXL_AUDIT_PG` integration-test gate and DSN config.
- Cross-reference the mx-agency ADR-07/ADR-10 store as the eventual production home (see Risks) without claiming this repo owns it.

## Risks and Open Questions

1. **Where does the table live — the central placement decision (confirm).** Design §7/§8 say "mirror into mx-agency's *existing* Postgres audit store (ADR-07/ADR-10)." mx-loom is a standalone package; mx-agency consumes it (OQ #5, RESOLVED: standalone package). Two coherent positions: **(a, recommended)** mx-loom owns a reference table + adapter (`@mx-loom/audit`) that is schema-compatible with being repointed at mx-agency's DSN — lets T114 stand the table up locally and keeps T113's "schema/migration" deliverable in-repo; **(b)** mx-loom ships only the port + projection and mx-agency implements the adapter against its store — most faithful to "the existing table," zero new deps, but the migration + golden-test rows become cross-repo. Default taken: **(a)**. Confirm before building the `pg` adapter, since (b) would drop `pg` from this repo entirely. The ADR-07/ADR-10 schema is **not readable in this repo** — column names/types may need to align cross-repo.
2. **"Exactly one row per result" semantics (confirm).** Recommended: append-only, one row **per returned envelope/emission**, deduped per `(call_id, status, invocation_id)` — so a deferred call's `running`→`ok` is two correlated rows (the audit *trail*). Alternative: one row **per invocation**, upserted in place as it transitions. The append-only reading is more faithful to "audit log / tamper-evident truth mirror" and is the default; flag in case the team wants the upsert (single-row-per-invocation) model.
3. **Does a local-read result (all-null `audit_ref`) get a row? (confirm).** Default: **yes** — AC-1 says *every* result; the row carries null correlation ids but a valid `tool_name`/`status`/`call_id` (useful "what did the model do" telemetry). Alternative: skip rows with an all-null `audit_ref` (mirror only substrate-correlated actions), which is arguably more faithful to "queryable index of the *truth* log" but violates AC-1's literal "every." Recommend yes; flag.
4. **`call_id` provenance.** Exactly-once relies on the binding supplying a unique per-tool-call `call_id`. MCP and Claude both expose a `tool_use`/call id, so this is sound — but it is a **dependency on the bindings (T109/T110)**. T113 defines and unit-tests the contract; the real id-threading lands with the bindings. Flagged so the chain is explicit.
5. **`audit_ref` ids can be `null` at write time.** A `running` result may carry a null `invocation_id`/`event_id` (daemon hasn't returned them); the later terminal result carries them. Correlation across the lifecycle then depends on `invocation_id` being populated on at least the terminal rows. This is honest two-daemon-round-trip-pending behavior (T102 OQ #4 — `audit_ref` field availability), not a T113 defect; the schema tolerates nulls and the `correlation_id`/`call_id` provide a fallback join key.
6. **Migration tooling.** Default: a single idempotent `.sql` + a tiny `migrate()` (no framework) for M1 minimalism. If mx-agency standardizes on a migration framework (node-pg-migrate / drizzle / kysely), align later (M5/T502). Confirm whether to adopt a framework now.
7. **Best-effort vs strict in the golden test.** The mirror is best-effort in production (never blocks a tool call). The golden test (T114) needs to *assert* rows, so it should run the sink in a strict/awaited mode (or use `InMemoryAuditSink` and assert directly). Note the mode switch so T114 isn't flaky.

## Implementation Checklist

1. Confirm the placement decision (Risk #1: mx-loom-owned reference table vs port-only) and the "exactly one row" semantics (Risk #2) and local-read inclusion (Risk #3) before writing the adapter.
2. Scaffold `packages/audit` (`@mx-loom/audit`): `package.json` (`pg` runtime dep; `@mx-loom/registry` type-only + standard dev deps), `tsconfig*.json`, `src/index.ts` barrel, README stub. It is already inside the `packages/*` workspace glob.
3. `src/row.ts` — define `AuditRow`, `AuditContext`; re-export `ToolStatus`/`ErrorCode` (type-only) from `@mx-loom/registry`.
4. `src/project.ts` — implement `auditRowFrom(result, ctx)` and `deriveDedupKey(call_id, status, invocation_id)` (pure, total). Unit-test all five statuses + all-null `audit_ref` + null context fields.
5. `migrations/0001_mx_audit_log.sql` — table + unique `dedup_key` index + the three correlation indexes (DDL in §A). Keep idempotent (`IF NOT EXISTS`).
6. `src/sink.ts` — `AuditSink` interface; `InMemoryAuditSink` (array + dedup) and `NullAuditSink`. Unit-test idempotency + lifecycle-trail + distinct-call semantics.
7. `src/postgres.ts` — `PostgresAuditSink` (`INSERT … ON CONFLICT (dedup_key) DO NOTHING`, pooled, DSN never logged) + `migrate()`. Gated integration test behind `MXL_AUDIT_PG=1`; skip (not fail) without a DB.
8. `src/with-audit.ts` — the `withAudit` tap (pass-through, best-effort, swallow+log redacted) + `logAuditFailure`. Unit-test pass-through, swallowed sink failure, exactly-N-rows over a fake dispatch.
9. `src/secret-boundary.test.ts` — assert no column ever holds a token-shaped value; `result`/`error.message`/DSN never persisted or logged.
10. Correlation test — seed `awaiting_approval` + terminal rows for one `invocation_id`; assert the model-action ↔ invocation ↔ approval join (AC 2) and the `correlation_id` session query.
11. README — public API, two-tier framing, exactly-once + best-effort + non-authoritative + secret-subset guarantees, binding-wiring example, the `MXL_AUDIT_PG` gate. Document every exported symbol (public-API rule).
12. Update `docs/mx-agent-tool-fabric-design.md` (§7/§8 + banner) and `docs/backlog.md` (T113 status with the established honesty convention; note T403/T502 unblocked). Do **not** mark AC-1/AC-2 fully green if the binding chokepoint (T109/T110) and the live-Postgres path are still staged — mark them landed-at-the-mechanism, staged-end-to-end (T114), exactly as T112 staged its two-daemon ACs.
13. Verify no runtime cycle and no dependency leak: `@mx-loom/registry` and `@mx-loom/toolbelt` gain **no** dependency on `@mx-loom/audit`; `pg` lives only in `@mx-loom/audit`. Run typecheck + the package test suite.
