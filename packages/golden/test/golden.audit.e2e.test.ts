/**
 * GOLDEN end-to-end — AC4: the audit arm (T114 / #22).
 *
 * Runs the binding-agnostic S1–S8 scenario once through the MCP arm against the live
 * golden fixture, into an injected sink, then asserts AC4 over **live** envelopes
 * (vs the synthesised envelopes of `@mx-loom/audit`'s binding-e2e.test.ts):
 *
 *   - exactly one audit row per emission (5 non-held + 3 held×2 = 11);
 *   - `byCorrelation(correlationId)` recovers the complete session;
 *   - the approval leg joins: the `awaiting_approval` row carries `approval_request_id`
 *     + `idempotency_key`; the resolved `denied` row carries `error_code: approval_denied`
 *     and a null `approval_request_id`;
 *   - `byInvocation` recovers each lifecycle chain;
 *   - no row carries a secret.
 *
 * Behind `MXL_AUDIT_PG=1` (+ a DSN) the same scenario runs into a live
 * `PostgresAuditSink`; the test SELECTs the rows back and proves the dedup
 * `ON CONFLICT (dedup_key) DO NOTHING` no-op holds on re-record. Skips cleanly with
 * no DB.
 *
 * This turns the staged T113 ACs (#21) live: "every tool result produces exactly one
 * audit row" / "rows correlate model action ↔ daemon invocation ↔ approval".
 */
import { randomUUID } from 'node:crypto';

import {
  InMemoryAuditSink,
  PostgresAuditSink,
  auditRowFrom,
  type AuditContext,
  type PgQueryable,
} from '@mx-loom/audit';
import { ok, type AuditRef, type ToolResult } from '@mx-loom/registry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SECRET_PATTERN,
  SKIP_GOLDEN,
  assertGoldenPrereqs,
  coordsFromFixture,
  createGoldenMcpArm,
  readGoldenFixture,
  runStep,
  type LiveMcpArm,
} from './_golden-harness.js';
import { buildGoldenScenario, expectedEmissions, type GoldenStep } from './scenario.js';

/** Per-step outcome capture so the audit assertions can correlate by invocation_id. */
interface StepRecord {
  readonly step: GoldenStep;
  readonly initial: ToolResult;
  readonly terminal: ToolResult;
}

describe.skipIf(SKIP_GOLDEN)('GOLDEN e2e · AC4 — audit rows present + correlated for each step', () => {
  const correlationId = `mxl-golden-audit-${randomUUID()}`;
  const nonce = randomUUID();
  let live: LiveMcpArm | undefined;
  let sink: InMemoryAuditSink | undefined;
  let steps: GoldenStep[] = [];
  const records: StepRecord[] = [];

  beforeAll(async () => {
    assertGoldenPrereqs();
    const fixture = readGoldenFixture();
    if (fixture === null) throw new Error('golden audit arm: fixture coordinates absent');
    steps = buildGoldenScenario(coordsFromFixture(fixture), nonce);
    sink = new InMemoryAuditSink();
    live = await createGoldenMcpArm({ room: fixture.room, auditSink: sink, correlationId });

    // Run the whole scenario once, capturing each step's initial + terminal envelopes.
    for (const step of steps) {
      const { initial, terminal } = await runStep(live.arm, step);
      records.push({ step, initial, terminal });
    }
  });

  afterAll(async () => {
    await live?.arm.close();
  });

  it('AC4: exactly one row per emission (5 non-held + 3 held×2 = 11)', () => {
    if (!sink) throw new Error('sink not initialised');
    expect(sink.count).toBe(expectedEmissions(steps).total);
  });

  it('AC4: byCorrelation recovers the complete session; every verb + status present', () => {
    if (!sink) throw new Error('sink not initialised');
    const session = sink.byCorrelation(correlationId);
    expect(session).toHaveLength(expectedEmissions(steps).total);
    expect(session.every((r) => r.correlation_id === correlationId)).toBe(true);

    const verbs = new Set(session.map((r) => r.tool_name));
    expect(verbs.has('mx_find_agents')).toBe(true);
    expect(verbs.has('mx_delegate_tool')).toBe(true);
    expect(verbs.has('mx_run_command')).toBe(true);
    expect(verbs.has('mx_await_result')).toBe(true);

    const statuses = new Set(session.map((r) => r.status));
    expect(statuses.has('ok')).toBe(true);
    expect(statuses.has('awaiting_approval')).toBe(true);
    expect(statuses.has('denied')).toBe(true);
  });

  it('AC4 approval join: S5 awaiting_approval row links request_id + idempotency_key; resolved denied row is approval_denied', () => {
    if (!sink) throw new Error('sink not initialised');
    const s5 = records.find((r) => r.step.id === 'S5');
    if (!s5) throw new Error('S5 not captured');

    // The awaiting_approval emission carries the approval request id (the leg the
    // operator decided) and the step's idempotency_key.
    const invId = s5.initial.audit_ref.invocation_id;
    if (invId !== null) {
      const chain = sink.byInvocation(invId);
      const awaitingRow = chain.find((r) => r.status === 'awaiting_approval');
      const deniedRow = chain.find((r) => r.status === 'denied');
      expect(awaitingRow?.approval_request_id, 'awaiting row carries approval_request_id').toBeTruthy();
      expect(deniedRow?.error_code, 'denied row is approval_denied (operator decision)').toBe('approval_denied');
      // The denied envelope's approval block is null → no approval_request_id on it.
      expect(deniedRow?.approval_request_id).toBeNull();
    } else {
      // The daemon did not surface an invocation_id on the held leg (T102 permits a
      // null id). Fall back to the correlation-level assertion: both legs are present.
      const session = sink.byCorrelation(correlationId);
      expect(session.some((r) => r.status === 'awaiting_approval' && r.approval_request_id !== null)).toBe(true);
      expect(session.some((r) => r.status === 'denied' && r.error_code === 'approval_denied')).toBe(true);
    }
  });

  it('AC4 denial taxonomy: S7/S8 each produce a single policy_denied row, no approval link', () => {
    if (!sink) throw new Error('sink not initialised');
    const session = sink.byCorrelation(correlationId);
    const policyDenials = session.filter((r) => r.status === 'denied' && r.error_code === 'policy_denied');
    // S7 (deny_args_regex) + S8 (deny-by-default) → at least two policy_denied rows,
    // neither carrying an approval link (no gate was ever opened).
    expect(policyDenials.length).toBeGreaterThanOrEqual(2);
    expect(policyDenials.every((r) => r.approval_request_id === null)).toBe(true);
  });

  it('AC4 secret boundary: no audit row carries a secret-shaped value', () => {
    if (!sink) throw new Error('sink not initialised');
    expect(JSON.stringify(sink.byCorrelation(correlationId))).not.toMatch(SECRET_PATTERN);
  });
});

// ---------------------------------------------------------------------------
// Live Postgres mirror — behind MXL_AUDIT_PG=1 (+ DSN). Skips cleanly with no DB.
// Proves rows produced by a live binding round-trip land in `mx_audit_log` and the
// dedup `ON CONFLICT (dedup_key) DO NOTHING` no-op holds. The DSN is never logged.
// ---------------------------------------------------------------------------

const PG_DSN = process.env['MXL_AUDIT_PG_DSN'] ?? process.env['DATABASE_URL'];
const SKIP_PG = SKIP_GOLDEN || process.env['MXL_AUDIT_PG'] !== '1' || !PG_DSN;

describe.skipIf(SKIP_PG)('GOLDEN e2e · AC4 (Postgres) — live PostgresAuditSink mirror', () => {
  const correlationId = `mxl-golden-pg-${randomUUID()}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a pg.Pool, dynamically loaded
  let pool: any;
  let pgSink: PostgresAuditSink | undefined;

  beforeAll(async () => {
    assertGoldenPrereqs();
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: PG_DSN });
    pgSink = new PostgresAuditSink(pool as unknown as PgQueryable);
    await pgSink.migrate(); // idempotent — safe on every run.
  });

  afterAll(async () => {
    await pool?.end?.();
  });

  it('a live binding round-trip writes rows into mx_audit_log; re-record is a dedup no-op', async () => {
    if (!pgSink) throw new Error('pg sink not initialised');
    const fixture = readGoldenFixture();
    if (fixture === null) throw new Error('golden Postgres arm: fixture coordinates absent');

    const nonce = randomUUID();
    const steps = buildGoldenScenario(coordsFromFixture(fixture), nonce);
    const live = await createGoldenMcpArm({ room: fixture.room, auditSink: pgSink, correlationId });
    try {
      for (const step of steps) {
        await runStep(live.arm, step);
      }
    } finally {
      await live.arm.close();
    }

    // SELECT the rows back — proving they landed in the live table.
    const before = await pool.query('SELECT count(*)::int AS n FROM mx_audit_log WHERE correlation_id = $1', [
      correlationId,
    ]);
    const n = (before.rows[0] as { n: number }).n;
    expect(n, 'live binding round-trip wrote audit rows').toBeGreaterThan(0);

    // Dedup no-op: re-record an already-seen row → row count is unchanged.
    const ref: AuditRef = { invocation_id: 'inv_pg_dedup', request_id: null, room: fixture.room, event_id: null };
    const envelope: ToolResult = ok({ done: true }, ref);
    const ctx: AuditContext = { tool_name: 'mx_delegate_tool', call_id: `${correlationId}_dedup`, correlation_id: correlationId };
    const row = auditRowFrom(envelope, ctx);
    await pgSink.record(row);
    await pgSink.record(row); // identical dedup_key → ON CONFLICT DO NOTHING.

    const after = await pool.query('SELECT count(*)::int AS n FROM mx_audit_log WHERE dedup_key = $1', [row.dedup_key]);
    expect((after.rows[0] as { n: number }).n, 'dedup_key is unique — re-record is a no-op').toBe(1);
  });
});
