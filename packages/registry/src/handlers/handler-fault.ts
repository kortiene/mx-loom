/**
 * Shared handler fault-mapping (T103 + T104) — the single transport/daemon
 * rejection → fault-envelope path reused by every `src/handlers/` handler.
 *
 * Extracted from `mx_await_result` (T103) so the three M1 handlers that probe an
 * injected `deps.daemon.call(...)` — `mxAwaitResult`, `mxFindAgents`,
 * `mxDescribeAgent` — map a rejection onto the closed T102 taxonomy **identically
 * and in one place**: a daemon-level JSON-RPC error (transport code `rpc`) routes
 * through {@link mapDaemonError} for a specific code (e.g. `unknown_agent` →
 * `not_found`); any other transport fault routes through {@link mapTransportError}
 * (e.g. `timeout` → `timeout`, a local-fabric fault → `internal`). A handler
 * therefore **never throws** a transport error to the caller — every path returns
 * a {@link ToolResult}.
 *
 * Pure; never throws. Builds the envelope only through {@link failureResult} (the
 * T102 helper that selects `denied` vs `errored` by the mapped code's set
 * membership), so the output conforms to `ENVELOPE_SCHEMA` by construction.
 */
import type { TransportErrorCode } from '@mx-loom/toolbelt';

import type { AuditRef, ToolResult } from '../envelope.js';
import { mapDaemonError, mapTransportError, type ErrorCode } from '../errors.js';
import { failureResult } from './invocation.js';

/**
 * A structurally-present `audit_ref` with **all-null** ids, for a **local daemon
 * read** (discovery) that has no Matrix round-trip — so there is no
 * `invocation_id` / `request_id` / `room` / `event_id` to populate. Never
 * fabricated (consistent with T102 / T103); populated if a future daemon surfaces
 * read-correlation ids.
 */
export const EMPTY_AUDIT_REF: AuditRef = Object.freeze({
  invocation_id: null,
  request_id: null,
  room: null,
  event_id: null,
});

/**
 * Map a `deps.daemon.call(...)` rejection onto a fault {@link ToolResult} carrying
 * `audit_ref`. A genuine transport `timeout` here is a **real** fault →
 * `errored('timeout', …)` (distinct from a `wait_ms` expiry, which never reaches
 * this path). A foreign/malformed rejection degrades to `internal` (safe — never
 * the wrong code).
 */
export function faultToResult(err: unknown, audit_ref: AuditRef): ToolResult {
  const code = readCode(err);

  // A daemon-level JSON-RPC error (transport code `rpc`) carries the daemon's own
  // error object on `cause`; route it through `mapDaemonError` so a missing/denied
  // target surfaces precisely (e.g. `not_found`), not as a blanket `internal`.
  if (code === 'rpc') {
    const cause = readProp(err, 'cause');
    return failureResult(mapDaemonError(cause ?? err), audit_ref);
  }

  // Any other transport fault: mapped onto the model-facing taxonomy via the T102
  // mapper (the single source of truth). Transport codes only ever map into the
  // fault-set, so `failureResult` builds an `errored(...)` envelope.
  return failureResult(safeMapTransport(code), audit_ref);
}

/**
 * Map a (string) transport code via the T102 {@link mapTransportError} (exhaustive
 * over the closed transport set; its `never` default trips on a foreign string).
 * Guarded so a malformed/foreign rejection degrades to `internal` rather than
 * throwing — keeping every handler total.
 */
function safeMapTransport(code: string | undefined): ErrorCode {
  try {
    return mapTransportError(code as TransportErrorCode);
  } catch {
    return 'internal';
  }
}

function readProp(x: unknown, key: string): unknown {
  return x !== null && typeof x === 'object' && key in x ? (x as Record<string, unknown>)[key] : undefined;
}

function readCode(x: unknown): string | undefined {
  const c = readProp(x, 'code');
  return typeof c === 'string' ? c : undefined;
}
