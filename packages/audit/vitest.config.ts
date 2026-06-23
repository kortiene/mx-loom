import { defineConfig } from 'vitest/config';

/**
 * The audit mirror's unit suite (T113) is pure and dependency-light: the
 * projection, the dedup key, the `InMemoryAuditSink`/`NullAuditSink`, the
 * `withAudit` tap, and the `PostgresAuditSink` SQL shape (driven through a fake
 * `PgQueryable`) all run with no real Postgres, no socket, and no env gating —
 * mirroring `packages/registry/vitest.config.ts`.
 *
 * The *live* Postgres path is exercised by `test/postgres.integration.test.ts`,
 * which self-gates on `MXL_AUDIT_PG=1` (in the spirit of the toolbelt's
 * `MXL_CONFORMANCE*` gates) and skips cleanly — never fails — when no disposable
 * database is provisioned. See the package README.
 */
export default defineConfig({
  test: {},
});
