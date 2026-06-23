# @mx-loom/audit

The **Postgres audit mirror** for mx-loom (`area/audit`). It ships with **T113 / #21**.

mx-loom's audit is **two-tier** (design §7):

- the **substrate** — the signed, replay-protected `com.mxagent.*` Matrix event
  stream — is the tamper-evident **truth**;
- this package is the **queryable index** an operator/app actually searches:
  _"show me every delegation in room X today"_, _"which model action led to
  invocation `inv_…`"_, _"what was approved, by correlation to what request"_.

Every T102 `ToolResult` already carries an `audit_ref` correlation block
(`{ invocation_id, request_id, room, event_id }`). T113 is the **thin mirror**
that turns the stream of those envelopes into queryable rows. **Postgres is a
mirror/index, never truth** — it can never override a signed event, and the
mirror being behind or unavailable never weakens the substrate.

> The `pg` driver lives **only** here. `@mx-loom/registry` and `@mx-loom/toolbelt`
> gain **no** dependency on this package, and `@mx-loom/registry` is a
> **type-only** dependency of this one — so the audit mirror is opt-in leaf
> infrastructure that adds nothing to the rest of the workspace's runtime graph.

## What this is — and is not

- **Not a model tool.** No new `mx_*` verb, no `CANONICAL_M1_TOOLS` change. The
  mirror is host/binding infrastructure the model never sees or calls. It is
  observation-only: it records what _already happened_ and confers no authority.
- **A strict non-secret subset.** A row stores only correlation ids (none a
  secret), `tool_name`, `status`, the closed-set `error_code`, the
  `approval_request_id`, the session `correlation_id`, and the `idempotency_key`.
  It **never** stores a `result` payload, the free-text `error.message`, or the
  `approval.summary`. The projection reads only the safe fields, so no token,
  free text, or payload can reach a row by construction.

## Public API

```ts
import {
  // row shape + projection context
  type AuditRow,
  type AuditContext,
  // pure, total projection + the exactly-once dedup key
  auditRowFrom,
  deriveDedupKey,
  // the injected sink port + dependency-free adapters
  type AuditSink,
  InMemoryAuditSink,
  NullAuditSink,
  // the pg-backed mirror (the only place the driver loads)
  PostgresAuditSink,
  createPostgresAuditSink,
  loadMigrationSql,
  type PgQueryable,
  type PostgresAuditConfig,
  // the best-effort, single-chokepoint wiring tap
  withAudit,
  logAuditFailure,
  type AuditTap,
  type AuditBaseContext,
  type AuditPerCall,
} from '@mx-loom/audit';
```

- **`auditRowFrom(result, ctx)`** — map a `ToolResult` + an `AuditContext` onto an
  `AuditRow`. Pure, total, deterministic, no I/O. Lifts the four `audit_ref` ids
  verbatim; `error_code` is the closed-set code (never the message), present only
  for `denied`/`error`; `approval_request_id` only for `awaiting_approval`.
- **`deriveDedupKey(callId, status, invocationId)`** — the deterministic
  exactly-once write key, `` `${callId}:${status}:${invocationId ?? '∅'}` ``.
- **`AuditSink`** — the write port: `record(row)` (idempotent, best-effort) +
  optional `close()`.
- **`InMemoryAuditSink`** — array-backed, same dedup semantics, with
  `rows` / `count` / `byInvocation(id)` / `byCorrelation(id)` read helpers. The
  unit + T114 golden-test fixture.
- **`NullAuditSink`** — a no-op for "audit disabled / no DSN configured".
- **`PostgresAuditSink`** — `INSERT … ON CONFLICT (dedup_key) DO NOTHING` over an
  injected `PgQueryable`; `migrate()` applies the (idempotent) schema; `close()`
  ends the pool.
- **`createPostgresAuditSink(config)`** — construct a `PostgresAuditSink` backed
  by a real `pg.Pool` (the only place `pg` is loaded). The config/DSN is never
  logged.
- **`withAudit(sink, baseCtx, log?)`** — the best-effort tap a binding applies
  once at its result-return point.

## The exactly-once + best-effort + non-authoritative guarantees

- **Exactly-once (AC 1).** Each returned envelope is **one** audit event → one
  row (an append-only trail). A deferred call that returns `running` then resolves
  `ok` is **two** correlated rows sharing one `invocation_id` — that _is_ the
  trail, not a duplicate. "Exactly one row per result" means **idempotent per
  emission**: re-recording the same emission (a transport retry, a binding
  re-delivery) is a no-op, enforced by the unique `dedup_key` index +
  `ON CONFLICT DO NOTHING`. Two _distinct_ calls never collide because the binding
  supplies a unique `call_id` per tool call.
- **Best-effort (non-blocking).** `withAudit` returns the envelope **unchanged**
  and **swallows** sink failures (logged via `logAuditFailure`, which prints only
  the failure class + `dedup_key` — never an id verbatim, never the DSN, never a
  secret). A Postgres outage degrades the index; it never blocks the model's tool
  call or touches the substrate truth.
- **Non-authoritative.** The Postgres row is explicitly not truth. T113 never
  reconstructs substrate state from Postgres and never makes a tool result depend
  on a successful DB write.

## Correlate model action ↔ daemon invocation ↔ approval (AC 2)

A single row carries all three correlation legs, joinable across a deferred
call's lifecycle:

| leg | columns |
|---|---|
| **model action** | `tool_name`, `correlation_id`, `idempotency_key` |
| **daemon invocation** (substrate pointer) | `invocation_id`, `request_id`, `event_id`, `room` |
| **approval** | `approval_request_id` |

Join a deferred call's lifecycle by `invocation_id`; recover a session's full
result set by `correlation_id`; scope/sort by `room` (the future tenant key).

## Wiring a binding (T109/T110)

`withAudit` is applied **once** at the binding's single result-return chokepoint,
so every `mx_*` result flows through it exactly once:

```ts
import { createPostgresAuditSink, withAudit } from '@mx-loom/audit';

const sink = await createPostgresAuditSink({ connectionString: process.env.MXL_AUDIT_DSN });
await sink.migrate(); // idempotent; safe on every startup

const tap = withAudit(sink, { correlation_id: session.correlation_id });

// …per tool call, after the handler returns its envelope:
return tap(envelope, { tool_name, call_id, idempotency_key });
```

T113 delivers the mechanism + the unit proof over a fake dispatch; the
single-chokepoint wiring is the one-line application the bindings (T109/T110)
perform, and the end-to-end "rows present for each step" assertion is T114.

## Schema & migration

`migrations/0001_mx_audit_log.sql` is plain, idempotent SQL (`IF NOT EXISTS`) —
no migration framework for M1. It creates `mx_audit_log` (the 1:1 mirror of
`AuditRow`), the unique `dedup_key` index (AC 1), and the
invocation / correlation / `(room, recorded_at)` indexes (AC 2). `status` and
`error_code` are `TEXT` validated **in code** against the closed T102 sets (not a
PG `ENUM`, to avoid a migration on every future code addition). It is
**single-tenant**: no RLS, no `tenant_id` (Multi-tenant RLS is M5 / T502, which
keys on `room`).

This repo owns a **reference table** that is schema-compatible with being
repointed at mx-agency's existing ADR-07/ADR-10 Postgres + RLS store; that store
is the eventual production home. This repo does not own or migrate it.

## Tests & the live-Postgres gate

The default suite (`pnpm test`) is pure and needs **no** database: the
projection, the dedup key, the in-memory/null sinks, the `withAudit` tap, and the
`PostgresAuditSink` SQL shape (driven through a fake `PgQueryable`).

`test/postgres.integration.test.ts` runs against a **real** Postgres only when
`MXL_AUDIT_PG=1` is set, in the spirit of the toolbelt's `MXL_CONFORMANCE*`
gates — it **skips cleanly** (never fails) without one. Provide the DSN via
`MXL_AUDIT_PG_DSN` (default `postgres://postgres:postgres@localhost:5432/postgres`):

```sh
MXL_AUDIT_PG=1 MXL_AUDIT_PG_DSN=postgres://… pnpm --filter @mx-loom/audit test
```

The golden test (T114) runs the sink in a strict/awaited mode (or uses
`InMemoryAuditSink` and asserts directly) so it can assert rows without the
production best-effort path making it flaky.
