/**
 * `@mx-loom/audit` (T113 / #21) — the Postgres mirror of `audit_ref`, the
 * **queryable index** of mx-loom's two-tier audit (design §7/§8).
 *
 * The substrate (signed `com.mxagent.*` Matrix event stream) is the
 * tamper-evident *truth*; this package is the searchable mirror. It contributes:
 *  - the non-secret row shape + context ({@link AuditRow}, {@link AuditContext});
 *  - a pure, total projection ({@link auditRowFrom}, {@link deriveDedupKey});
 *  - an injected {@link AuditSink} port + three adapters
 *    ({@link PostgresAuditSink}, {@link InMemoryAuditSink}, {@link NullAuditSink});
 *  - the best-effort, single-chokepoint {@link withAudit} tap a binding applies once.
 *
 * `@mx-loom/registry` is a **type-only** dependency (erased at runtime), and `pg`
 * is loaded only by {@link createPostgresAuditSink} — so this package adds no
 * runtime dependency to the registry or toolbelt, and the projection / fakes load
 * no database driver.
 */

// Row shape + projection context (and the closed-vocabulary type re-exports).
export type { AuditRow, AuditContext, ErrorCode, ToolStatus } from './row.js';

// The pure projection + the exactly-once dedup key.
export { auditRowFrom, deriveDedupKey } from './project.js';

// The sink port + the dependency-free adapters.
export { InMemoryAuditSink, NullAuditSink } from './sink.js';
export type { AuditSink } from './sink.js';

// The `pg`-backed mirror + its structural db port, config, migration loader, and
// the on-demand pool factory (the only place the `pg` driver is loaded).
export { PostgresAuditSink, createPostgresAuditSink, loadMigrationSql } from './postgres.js';
export type { PgQueryable, PostgresAuditConfig } from './postgres.js';

// The best-effort wiring tap + its default secret-free failure logger.
export { withAudit, logAuditFailure } from './with-audit.js';
export type { AuditTap, AuditBaseContext, AuditPerCall, AuditFailureLogger } from './with-audit.js';
