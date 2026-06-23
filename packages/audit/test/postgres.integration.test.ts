/**
 * Live Postgres integration (T113 / #21) — GATED on `MXL_AUDIT_PG=1`.
 *
 * In the spirit of the toolbelt's `MXL_CONFORMANCE*` gates, this suite runs
 * against a disposable Postgres **only** when `MXL_AUDIT_PG=1` is set; otherwise
 * it skips cleanly (never fails) so the default `pnpm test` is harmless without a
 * database. Provide the DSN via `MXL_AUDIT_PG_DSN` (default:
 * `postgres://postgres:postgres@localhost:5432/postgres`). See the package README.
 *
 * It asserts: `migrate()` is idempotent (run twice), an INSERT lands a row, a
 * re-emission with the same `dedup_key` is a no-op, and the indexed query paths
 * (invocation / correlation) recover the rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ok, running, type AuditRef } from '@mx-loom/registry';

import { auditRowFrom, createPostgresAuditSink, type PostgresAuditSink, type PgQueryable, type AuditContext } from '../src/index.js';

const ENABLED = process.env['MXL_AUDIT_PG'] === '1';
const DSN = process.env['MXL_AUDIT_PG_DSN'] ?? 'postgres://postgres:postgres@localhost:5432/postgres';

const REF = (inv: string): AuditRef => ({ invocation_id: inv, request_id: 'req_1', room: '!r:s', event_id: '$e' });
const ctx = (call_id: string, corr: string): AuditContext => ({ tool_name: 'mx_run_command', call_id, correlation_id: corr });

describe.skipIf(!ENABLED)('PostgresAuditSink (live, MXL_AUDIT_PG=1)', () => {
  let sink: PostgresAuditSink;
  // The sink owns the only pool; reach through it for read-back assertions
  // (the private `db` field is the injected PgQueryable).
  const query = (text: string, params?: readonly unknown[]) =>
    (sink as unknown as { db: PgQueryable }).db.query(text, params);

  beforeAll(async () => {
    sink = await createPostgresAuditSink({ connectionString: DSN });
    await sink.migrate();
    await sink.migrate(); // idempotent: a second run must not error
  });

  afterAll(async () => {
    await sink.close();
  });

  it('inserts a row and dedups a re-emission', async () => {
    const inv = `inv_${Date.now()}`;
    const row = auditRowFrom(ok({}, REF(inv)), ctx(`call_${inv}`, `corr_${inv}`));
    await sink.record(row);
    await sink.record(row); // dedup

    const res = await query('SELECT count(*)::int AS n FROM mx_audit_log WHERE dedup_key = $1', [row.dedup_key]);
    expect((res.rows[0] as { n: number }).n).toBe(1);
  });

  it('recovers a lifecycle by invocation_id and a session by correlation_id (AC 2)', async () => {
    const inv = `inv_life_${Date.now()}`;
    const corr = `corr_life_${Date.now()}`;
    await sink.record(auditRowFrom(running('h', REF(inv)), ctx(`c_${inv}`, corr)));
    await sink.record(auditRowFrom(ok({}, REF(inv)), ctx(`c_${inv}`, corr)));

    const byInv = await query('SELECT status FROM mx_audit_log WHERE invocation_id = $1 ORDER BY id', [inv]);
    expect(byInv.rows.map((r) => (r as { status: string }).status)).toEqual(['running', 'ok']);

    const byCorr = await query('SELECT count(*)::int AS n FROM mx_audit_log WHERE correlation_id = $1', [corr]);
    expect((byCorr.rows[0] as { n: number }).n).toBe(2);
  });
});
