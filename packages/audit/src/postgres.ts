/**
 * The `pg`-backed audit mirror (T113 / #21) — the real queryable index.
 *
 * This is the **only** module that touches Postgres, so importing the port +
 * fakes (`./sink.js`) or the projection (`./project.js`) never loads the driver.
 * The class itself depends on the narrow {@link PgQueryable} structural port —
 * not a concrete `pg.Pool` — so it is unit-testable with a fake and the heavy
 * `pg` import is confined to {@link createPostgresAuditSink}, which constructs a
 * real pool on demand.
 *
 * Secret hygiene: the connection string / config is an **app-layer credential**
 * (not a Boundary-A Matrix/Ed25519/provider/`GH_TOKEN` secret), but it is still
 * never logged, never placed in a tool field, and never exposed to the
 * runtime/model. Nothing here logs the config.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { AuditRow } from './row.js';
import type { AuditSink } from './sink.js';

/**
 * The narrow database surface {@link PostgresAuditSink} needs — a structural
 * subset of `pg.Pool`/`pg.Client` (`query`, optional `end`). A real `pg` pool
 * satisfies it, and so does a one-line fake in unit tests, so the sink's SQL +
 * dedup behavior is testable with no live database.
 */
export interface PgQueryable {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }>;
  end?(): Promise<void>;
}

/**
 * Config for {@link createPostgresAuditSink}. Either a `connectionString` (DSN)
 * or the discrete fields — both forwarded verbatim to `pg.Pool`. **Never
 * logged.** Single-tenant for M1 (no tenant/RLS plumbing — that is M5/T502).
 */
export interface PostgresAuditConfig {
  /** Standard libpq connection string, e.g. `postgres://user:pass@host:5432/db`. NEVER logged. */
  readonly connectionString?: string;
  readonly host?: string;
  readonly port?: number;
  readonly database?: string;
  readonly user?: string;
  /** NEVER logged. */
  readonly password?: string;
  /** Max pooled connections (forwarded to `pg.Pool`). */
  readonly max?: number;
}

/** Idempotent INSERT: a re-emission with the same `dedup_key` is silently dropped (AC 1). */
const INSERT_SQL = `
INSERT INTO mx_audit_log
  (invocation_id, request_id, room, event_id,
   tool_name, correlation_id, idempotency_key,
   status, error_code, approval_request_id, dedup_key)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
ON CONFLICT (dedup_key) DO NOTHING
`;

/** Resolve + read the canonical migration SQL (`migrations/0001_mx_audit_log.sql`). */
export async function loadMigrationSql(): Promise<string> {
  // `../migrations` resolves the same from `src/` (vitest) and `dist/` (built) —
  // both are siblings of the package-root `migrations/` directory.
  const path = fileURLToPath(new URL('../migrations/0001_mx_audit_log.sql', import.meta.url));
  return readFile(path, 'utf8');
}

/**
 * The real Postgres {@link AuditSink}: `INSERT … ON CONFLICT (dedup_key) DO
 * NOTHING`, plus {@link migrate} to apply the (idempotent) schema. Constructed
 * over an injected {@link PgQueryable} so it is testable without a live database
 * and the `pg` import stays in {@link createPostgresAuditSink}.
 */
export class PostgresAuditSink implements AuditSink {
  constructor(private readonly db: PgQueryable) {}

  async record(row: AuditRow): Promise<void> {
    await this.db.query(INSERT_SQL, [
      row.invocation_id,
      row.request_id,
      row.room,
      row.event_id,
      row.tool_name,
      row.correlation_id,
      row.idempotency_key,
      row.status,
      row.error_code,
      row.approval_request_id,
      row.dedup_key,
    ]);
  }

  /** Apply `0001_mx_audit_log.sql`. Idempotent — safe to run on every startup. */
  async migrate(): Promise<void> {
    await this.db.query(await loadMigrationSql());
  }

  /** Close the underlying pool/client if it exposes `end()`. */
  async close(): Promise<void> {
    await this.db.end?.();
  }
}

/**
 * Construct a {@link PostgresAuditSink} backed by a real `pg.Pool`. The `pg`
 * driver is **dynamically imported** here so it loads only when a real mirror is
 * actually wired — the port, the projection, and the in-memory/null sinks stay
 * driver-free. Call {@link PostgresAuditSink.migrate} once after construction to
 * ensure the schema. The `config` is never logged.
 */
export async function createPostgresAuditSink(config: PostgresAuditConfig): Promise<PostgresAuditSink> {
  const { Pool } = await import('pg');
  const pool = new Pool(config);
  // `pg.Pool.query` has many overloads; it is structurally a `PgQueryable`.
  return new PostgresAuditSink(pool as unknown as PgQueryable);
}
