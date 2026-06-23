/**
 * The wiring tap (T113 / #21) — best-effort, single chokepoint (design §7/§8).
 *
 * {@link withAudit} is the thin higher-order tap a binding applies **once** at
 * its result-return point (MCP T109, Claude shim T110). Wired at that single
 * chokepoint, every returned `mx_*` envelope flows through it exactly once → one
 * audit row (AC 1's "every result" is a property of where it is wired). T113
 * delivers the mechanism + the unit proof over a fake dispatch; T114 proves
 * "rows present for each step" end-to-end.
 *
 * Two hard guarantees:
 *  - **Pass-through.** The tap returns the envelope **unchanged** — it observes,
 *    it never rewrites a result.
 *  - **Best-effort.** A sink failure is swallowed (logged, redacted) and **never
 *    rethrown**. A Postgres outage degrades the queryable index; it never blocks
 *    the model's tool call or touches the substrate truth.
 */
import { auditRowFrom } from './project.js';
import type { AuditContext } from './row.js';
import type { AuditSink } from './sink.js';
import type { ToolResult } from '@mx-loom/registry';

/**
 * The session-stable context a binding fixes once (everything in
 * {@link AuditContext} except the per-call `tool_name`/`call_id`). `correlation_id`
 * is genuinely session-stable; `idempotency_key` is allowed here as a default but
 * is normally supplied per call by a mutating verb and overrides this.
 */
export type AuditBaseContext = Omit<AuditContext, 'call_id' | 'tool_name'>;

/** The per-call context the tap is handed at each result-return point. */
export interface AuditPerCall {
  /** Which `mx_*` verb produced this result. */
  readonly tool_name: string;
  /** The binding's per-tool-call id (MCP/Claude `tool_use` id, or a uuid). */
  readonly call_id: string;
  /** The mutating verb's client-supplied idempotency key, if any (overrides the base). */
  readonly idempotency_key?: string;
}

/** A secret-free logger for a swallowed sink failure. Default: {@link logAuditFailure}. */
export type AuditFailureLogger = (err: unknown, dedupKey: string) => void;

/**
 * The tap function a binding calls with each `(result, perCall)` — records the
 * projected row best-effort and returns the envelope untouched.
 */
export type AuditTap = (result: ToolResult, perCall: AuditPerCall) => Promise<ToolResult>;

/**
 * Build the best-effort audit tap. Apply it **once** at the binding's
 * result-return chokepoint:
 *
 * ```ts
 * const tap = withAudit(sink, { correlation_id: session.correlation_id });
 * // …per tool call, after the handler returns its envelope:
 * return tap(envelope, { tool_name, call_id, idempotency_key });
 * ```
 *
 * @param sink    the injected {@link AuditSink} (Postgres / in-memory / null).
 * @param baseCtx the session-stable context fixed once.
 * @param log     secret-free failure logger (injectable for tests).
 */
export function withAudit(sink: AuditSink, baseCtx: AuditBaseContext, log: AuditFailureLogger = logAuditFailure): AuditTap {
  return async function tap(result: ToolResult, perCall: AuditPerCall): Promise<ToolResult> {
    // Projection is pure + total, so it is safe outside the try; only the sink
    // I/O can fail, and only that is swallowed.
    const row = auditRowFrom(result, { ...baseCtx, ...perCall });
    try {
      await sink.record(row);
    } catch (err) {
      log(err, row.dedup_key); // best-effort: never rethrow.
    }
    return result; // pass the envelope through untouched.
  };
}

/**
 * Default secret-free failure logger. Logs the failure **class** + the
 * `dedup_key` only — never the row's correlation ids verbatim, never the DSN,
 * never a secret — so a sink outage is observable without leaking anything.
 */
export function logAuditFailure(err: unknown, dedupKey: string): void {
  const cls = err instanceof Error ? err.name : typeof err;
  // eslint-disable-next-line no-console -- best-effort operational signal; secret-free by construction.
  console.warn(`[mx-audit] sink.record failed (best-effort, row dropped): ${cls} dedup_key=${dedupKey}`);
}
