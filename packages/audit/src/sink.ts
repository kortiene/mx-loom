/**
 * The injected audit-sink port + its dependency-free adapters (T113 / #21).
 *
 * {@link AuditSink} is a narrow port in the exact spirit of the registry's
 * `DaemonCall = Pick<MxTransport,'call'>` seam: a handler/binding depends on the
 * port, never a concrete client, so the heavy `pg` dependency is quarantined in
 * {@link import('./postgres.js').PostgresAuditSink} and the common paths (unit
 * tests, the T114 golden fixture, audit-disabled deployments) need no database.
 *
 * Two adapters live here because they have no external dependency:
 *  - {@link InMemoryAuditSink} — array-backed, same dedup semantics; the unit +
 *    golden-test fixture.
 *  - {@link NullAuditSink} — a no-op for "audit disabled / no DSN configured".
 *
 * The `pg`-backed {@link import('./postgres.js').PostgresAuditSink} is its own
 * module so importing the port + fakes never loads the driver.
 */
import type { AuditRow } from './row.js';

/**
 * The write port the `withAudit` tap (and any binding) records through.
 *
 * Contract:
 *  - **Idempotent.** Re-recording a row with an already-seen
 *    {@link AuditRow.dedup_key} is a no-op (exactly-once, AC 1).
 *  - **Best-effort.** The mirror is the queryable index, *not* truth — a sink
 *    failure must never block or corrupt the model's tool call or the substrate.
 *    `withAudit` swallows a throw, but a well-behaved sink should also avoid
 *    throwing into a caller's hot path where it reasonably can.
 */
export interface AuditSink {
  /** Idempotent, best-effort write of one audit row. */
  record(row: AuditRow): Promise<void>;
  /** Release any held resources (e.g. a pooled connection). Optional. */
  close?(): Promise<void>;
}

/**
 * An in-memory {@link AuditSink} with the same exactly-once semantics as the
 * Postgres mirror: a row whose {@link AuditRow.dedup_key} was already recorded is
 * dropped. Used by unit tests and the T114 golden fixture so "rows present for
 * each step" is assertable with no real Postgres.
 */
export class InMemoryAuditSink implements AuditSink {
  private readonly _rows: AuditRow[] = [];
  private readonly seen = new Set<string>();

  // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy the port; the write is synchronous.
  async record(row: AuditRow): Promise<void> {
    if (this.seen.has(row.dedup_key)) return; // exactly-once: a re-emission is a no-op.
    this.seen.add(row.dedup_key);
    this._rows.push(row);
  }

  /** The recorded rows, in insertion order (a read-only view; never mutated by callers). */
  get rows(): readonly AuditRow[] {
    return this._rows;
  }

  /** Number of distinct rows recorded. */
  get count(): number {
    return this._rows.length;
  }

  /** All rows sharing an `invocation_id` — the lifecycle join an AC-2 query walks. */
  byInvocation(invocationId: string): readonly AuditRow[] {
    return this._rows.filter((r) => r.invocation_id === invocationId);
  }

  /** All rows for one session `correlation_id` — the "what did this session do" query (AC 2). */
  byCorrelation(correlationId: string): readonly AuditRow[] {
    return this._rows.filter((r) => r.correlation_id === correlationId);
  }
}

/**
 * A no-op {@link AuditSink} for when the mirror is disabled (no DSN configured).
 * The audit index is optional infrastructure; its absence never breaks a tool
 * call. Every `record` resolves immediately and stores nothing.
 */
export class NullAuditSink implements AuditSink {
  // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy the port; no work to do.
  async record(_row: AuditRow): Promise<void> {
    // intentionally empty — audit disabled.
  }
}
