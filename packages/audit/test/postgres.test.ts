/**
 * `PostgresAuditSink` over a fake `PgQueryable` (T113 / #21).
 *
 * Exercises the SQL contract without a live database: the INSERT carries the 11
 * columns in order, `ON CONFLICT (dedup_key) DO NOTHING` is honored (the fake
 * dedups by `dedup_key`), `migrate()` applies the real migration SQL, and
 * `close()` ends the pool. The *live* path is `postgres.integration.test.ts`
 * (gated on `MXL_AUDIT_PG=1`).
 */
import { describe, expect, it, vi } from 'vitest';

import { awaitingApproval, denied, errored, ok, type ApprovalInfo, type AuditRef } from '@mx-loom/registry';

import { auditRowFrom, loadMigrationSql, PostgresAuditSink, type PgQueryable, type AuditContext } from '../src/index.js';

const REF: AuditRef = { invocation_id: 'inv_1', request_id: 'req_1', room: '!r:s', event_id: '$e' };
const CTX: AuditContext = { tool_name: 'mx_delegate_tool', call_id: 'c1', correlation_id: 'corr_1', idempotency_key: 'idk_1' };

/** A fake pg pool that records queries and simulates the unique `dedup_key` index. */
function fakeDb(): PgQueryable & { calls: Array<{ text: string; params?: readonly unknown[] }>; stored: Set<string>; ended: boolean } {
  const stored = new Set<string>();
  const calls: Array<{ text: string; params?: readonly unknown[] }> = [];
  return {
    calls,
    stored,
    ended: false,
    async query(text: string, params?: readonly unknown[]) {
      calls.push({ text, params });
      // The dedup_key is the 11th positional param ($11 → index 10).
      if (text.includes('INSERT INTO mx_audit_log') && params) {
        const dedupKey = params[10] as string;
        if (stored.has(dedupKey)) return { rows: [] }; // ON CONFLICT DO NOTHING
        stored.add(dedupKey);
      }
      return { rows: [] };
    },
    async end() {
      this.ended = true;
    },
  };
}

describe('PostgresAuditSink.record', () => {
  it('issues an ON CONFLICT INSERT with the 11 row columns in order', async () => {
    const db = fakeDb();
    const sink = new PostgresAuditSink(db);
    const row = auditRowFrom(ok({}, REF), CTX);
    await sink.record(row);

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]?.text).toContain('INSERT INTO mx_audit_log');
    expect(db.calls[0]?.text).toContain('ON CONFLICT (dedup_key) DO NOTHING');
    expect(db.calls[0]?.params).toEqual([
      'inv_1',
      'req_1',
      '!r:s',
      '$e',
      'mx_delegate_tool',
      'corr_1',
      'idk_1',
      'ok',
      null,
      null,
      row.dedup_key,
    ]);
  });

  it('a second write of the same dedup_key is a no-op (exactly-once)', async () => {
    const db = fakeDb();
    const sink = new PostgresAuditSink(db);
    const row = auditRowFrom(ok({}, REF), CTX);
    await sink.record(row);
    await sink.record(row);
    expect(db.stored.size).toBe(1);
    expect(db.calls).toHaveLength(2); // both dispatched; the second stored nothing
  });

  it('awaiting_approval row: approval_request_id ($10) is non-null, error_code ($9) is null', async () => {
    const db = fakeDb();
    const sink = new PostgresAuditSink(db);
    const APPROVAL: ApprovalInfo = { request_id: 'apr_42', risk: 'high', summary: 's', expires_at: '2026-06-22T00:00:00Z' };
    const row = auditRowFrom(awaitingApproval('h', APPROVAL, REF), CTX);
    await sink.record(row);

    const params = db.calls[0]?.params ?? [];
    expect(params[8]).toBeNull();      // error_code ($9) — null for awaiting_approval
    expect(params[9]).toBe('apr_42'); // approval_request_id ($10)
    expect(params[7]).toBe('awaiting_approval'); // status ($8)
  });

  it('error row: error_code ($9) is non-null, approval_request_id ($10) is null', async () => {
    const db = fakeDb();
    const sink = new PostgresAuditSink(db);
    const row = auditRowFrom(errored('timeout', 'too slow', REF), CTX);
    await sink.record(row);

    const params = db.calls[0]?.params ?? [];
    expect(params[7]).toBe('error');
    expect(params[8]).toBe('timeout'); // error_code ($9)
    expect(params[9]).toBeNull();      // approval_request_id ($10)
  });

  it('denied row: error_code ($9) is non-null', async () => {
    const db = fakeDb();
    const sink = new PostgresAuditSink(db);
    const row = auditRowFrom(denied('policy_denied', 'blocked', REF), CTX);
    await sink.record(row);

    const params = db.calls[0]?.params ?? [];
    expect(params[7]).toBe('denied');
    expect(params[8]).toBe('policy_denied');
    expect(params[9]).toBeNull();
  });

  it('propagates a DB query error (does not swallow — withAudit is the swallow layer)', async () => {
    const dbError = new Error('connection reset');
    const badDb: PgQueryable = {
      query: () => Promise.reject(dbError),
    };
    const sink = new PostgresAuditSink(badDb);
    await expect(sink.record(auditRowFrom(ok({}, REF), CTX))).rejects.toThrow('connection reset');
  });
});

describe('PostgresAuditSink.migrate', () => {
  it('applies the real migration SQL (table + indexes)', async () => {
    const db = fakeDb();
    await new PostgresAuditSink(db).migrate();
    const sql = db.calls[0]?.text ?? '';
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS mx_audit_log');
    expect(sql).toContain('mx_audit_log_dedup_key_uq');
  });

  it('is idempotent — calling twice issues two queries without throwing', async () => {
    const db = fakeDb();
    const sink = new PostgresAuditSink(db);
    await sink.migrate();
    await sink.migrate(); // second run must not throw
    expect(db.calls).toHaveLength(2);
  });
});

describe('PostgresAuditSink.close', () => {
  it('ends the underlying pool', async () => {
    const db = fakeDb();
    await new PostgresAuditSink(db).close();
    expect(db.ended).toBe(true);
  });

  it('tolerates a db with no end()', async () => {
    const q = vi.fn(async () => ({ rows: [] }));
    await expect(new PostgresAuditSink({ query: q }).close()).resolves.toBeUndefined();
  });
});

describe('loadMigrationSql', () => {
  it('reads the canonical migration file', async () => {
    const sql = await loadMigrationSql();
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS mx_audit_log');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS mx_audit_log_dedup_key_uq');
    expect(sql).toContain('mx_audit_log_invocation_idx');
    expect(sql).toContain('mx_audit_log_correlation_idx');
    expect(sql).toContain('mx_audit_log_room_recorded_idx');
  });

  it('pins NOT NULL constraints on tool_name, status, and dedup_key', async () => {
    // These three columns are required for AC-1 (dedup_key) and meaningful rows.
    // Regression-pin so a schema edit is a deliberate, reviewed change.
    const sql = await loadMigrationSql();
    expect(sql).toMatch(/tool_name\s+TEXT NOT NULL/);
    expect(sql).toMatch(/status\s+TEXT NOT NULL/);
    expect(sql).toMatch(/dedup_key\s+TEXT NOT NULL/);
  });

  it('contains all 12 required column names (11 data + recorded_at bookkeeping)', async () => {
    const sql = await loadMigrationSql();
    const required = [
      // audit_ref (daemon invocation / substrate pointer)
      'invocation_id', 'request_id', 'room', 'event_id',
      // model action
      'tool_name', 'correlation_id', 'idempotency_key',
      // outcome / approval
      'status', 'error_code', 'approval_request_id',
      // exactly-once + bookkeeping
      'dedup_key', 'recorded_at',
    ];
    for (const col of required) {
      expect(sql, `column "${col}" missing from migration`).toContain(col);
    }
  });
});
