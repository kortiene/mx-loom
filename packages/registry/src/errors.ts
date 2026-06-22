/**
 * The closed, model-facing error taxonomy (T102 / #10) — design §4.2 / §4.5.
 *
 * The result envelope (`./envelope.ts`) reports every failure with an
 * `error.code` drawn from **exactly** the nine codes below, so a runtime binding
 * reacts programmatically (`untrusted_key` → onboarding hint, `policy_denied` →
 * don't retry, `target_offline` → try elsewhere) without parsing prose. This is
 * the **single source of truth** for that set: the `ErrorCode` type, the
 * `denied`/`error` status partition, the schema's `enum`, and the two
 * fault→envelope mappers all derive from the consts here.
 *
 * This taxonomy is **distinct from** the toolbelt's transport `TransportErrorCode`
 * set (`not_running | connect_failed | timeout | closed | frame | protocol | rpc
 * | invalid_args`); {@link mapTransportError} / {@link mapDaemonError} bridge a
 * raw transport/daemon fault onto this model-facing set in one place, so a
 * handler never invents an ad-hoc code.
 *
 * Secret-free: a code is a fixed vocabulary token, never a secret. Mappers build
 * an `ErrorCode` from the (non-secret) transport/daemon code only — never by
 * echoing raw daemon payloads.
 */

// A type-only import, erased under `verbatimModuleSyntax`, so the registry gains
// **no runtime dependency** on the toolbelt (it stays a devDependency). The
// transport set is single-sourced from the toolbelt rather than re-declared
// here; `mapTransportError`'s `never` default fails the build if it ever drifts
// (T102 Open Question #8 — type-only import).
import type { TransportErrorCode } from '@mx-loom/toolbelt';

/**
 * The closed model-facing `error.code` set (design §4.2). **Exactly** these nine
 * codes — the AC-2 regression test pins the set so adding/removing one is a
 * deliberate, reviewed change.
 */
export const ERROR_CODES = [
  'policy_denied',
  'untrusted_key',
  'approval_denied',
  'approval_expired',
  'timeout',
  'not_found',
  'invalid_args',
  'target_offline',
  'internal',
] as const;

/** A code from the closed {@link ERROR_CODES} set. */
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * The status↔code partition (T102 Open Question #2). Design §4.2 lists the
 * statuses and the codes but does not spell out which code pairs with `denied`
 * vs `error`; T102 fixes it:
 *
 *  - **denial-set** — a *governance* outcome the model can reason about
 *    (`policy_denied`, `untrusted_key`, `approval_denied`, `approval_expired`) →
 *    envelope status `denied`.
 *  - **fault-set** — an *operational* failure (`timeout`, `not_found`,
 *    `invalid_args`, `target_offline`, `internal`) → envelope status `error`.
 *
 * The two consts partition {@link ERROR_CODES} with no overlap or gap (pinned by
 * the AC-2 test) and type the `denied()` / `errored()` helper signatures, so the
 * partition is compiler-enforced, not just a runtime convention.
 */
export const DENIAL_CODES = [
  'policy_denied',
  'untrusted_key',
  'approval_denied',
  'approval_expired',
] as const;

/** Operational-fault codes — envelope status `error`. See {@link DENIAL_CODES}. */
export const FAULT_CODES = ['timeout', 'not_found', 'invalid_args', 'target_offline', 'internal'] as const;

/** A code that pairs with envelope status `denied`. */
export type DenialCode = (typeof DENIAL_CODES)[number];
/** A code that pairs with envelope status `error`. */
export type FaultCode = (typeof FAULT_CODES)[number];

/** Runtime guard: is `x` one of the closed {@link ERROR_CODES}? */
export function isErrorCode(x: unknown): x is ErrorCode {
  return typeof x === 'string' && (ERROR_CODES as readonly string[]).includes(x);
}

/** Compile-time exhaustiveness backstop: a `never` default trips the build if an
 * unmapped transport code reaches the switch. */
function assertNever(value: never): never {
  throw new Error(`unmapped error-code source: ${String(value)}`);
}

/**
 * Map a toolbelt {@link TransportErrorCode} onto the closed model-facing
 * {@link ErrorCode} set. An **exhaustive** switch — the `never` default means a
 * future transport code fails the build until it is mapped here.
 *
 * Recommended mapping (T102 §4):
 *  - `timeout → timeout`, `invalid_args → invalid_args` (1:1).
 *  - `not_running | connect_failed | closed | frame | protocol → internal`: the
 *    *local* fabric is unreachable or at fault. This is deliberately **not**
 *    `target_offline`, which means the *remote* agent is offline — a daemon-level
 *    outcome surfaced through {@link mapDaemonError}, not a local transport fault.
 *  - `rpc → internal` **here**: a `rpc` fault carries the daemon's JSON-RPC error
 *    object, which this code-only entry point does not receive. A handler holding
 *    that object should route it through {@link mapDaemonError} for a specific
 *    code; absent it, `internal` is the safe, never-wrong-typed fallback.
 */
export function mapTransportError(code: TransportErrorCode): ErrorCode {
  switch (code) {
    case 'timeout':
      return 'timeout';
    case 'invalid_args':
      return 'invalid_args';
    case 'not_running':
    case 'connect_failed':
    case 'closed':
    case 'frame':
    case 'protocol':
      return 'internal';
    case 'rpc':
      // Route through mapDaemonError(err.cause) when the daemon error object is
      // available; `internal` is the code-only fallback.
      return 'internal';
    default:
      return assertNever(code);
  }
}

/**
 * Daemon error identifiers (design §4.5 / §5 / §6) normalised to the
 * model-facing {@link ErrorCode} they render as. Keyed by a normalised token
 * (lowercased, non-alphanumerics collapsed to `_`, edges trimmed) so daemon
 * spellings like `"policy.denied"`, `"PolicyDenied"`, or `"policy_denied"` all
 * resolve.
 *
 * The exact v0.2.1 daemon vocabulary is **pending the two-daemon round-trip**
 * (T102 Open Question #3 — `call.start` round-trip is gated). This table is
 * authored against the design's named outcomes now; the conformance fixture pins
 * it to the real vocabulary later. A miss degrades to `internal` (safe — never
 * the wrong code, only less specific), never throws, never silently drops.
 */
const DAEMON_CODE_TO_ERROR: Readonly<Record<string, ErrorCode>> = {
  // Governance denials (→ status `denied`).
  policy_denied: 'policy_denied',
  denied_by_policy: 'policy_denied',
  policy: 'policy_denied',
  untrusted_key: 'untrusted_key',
  untrusted: 'untrusted_key',
  trust_denied: 'untrusted_key',
  unknown_key: 'untrusted_key',
  approval_denied: 'approval_denied',
  approval_rejected: 'approval_denied',
  approval_expired: 'approval_expired',
  approval_timeout: 'approval_expired',
  // Operational faults (→ status `error`).
  timeout: 'timeout',
  not_found: 'not_found',
  unknown_agent: 'not_found',
  unknown_tool: 'not_found',
  no_such_invocation: 'not_found',
  invalid_args: 'invalid_args',
  invalid_arguments: 'invalid_args',
  invalid_params: 'invalid_args',
  target_offline: 'target_offline',
  agent_offline: 'target_offline',
  offline: 'target_offline',
  unreachable: 'target_offline',
  internal: 'internal',
};

/** Normalise an arbitrary daemon code spelling to a lookup key. */
function normaliseDaemonCode(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Extract a candidate daemon **string** code from the several shapes a fault can
 * arrive in, without assuming one wire layout (the layout is pending OQ #3):
 *  - the value is itself a string code;
 *  - a `CallResponse{ok:false}` → `{ error: { code } }` (string code);
 *  - a JSON-RPC error object → `{ code, message, data }` where the daemon's own
 *    string code rides in `data` (or `data.code`), the numeric JSON-RPC `code`
 *    being too coarse to map.
 */
function extractDaemonCode(daemonError: unknown): string | undefined {
  if (typeof daemonError === 'string') return daemonError;
  if (daemonError === null || typeof daemonError !== 'object') return undefined;
  const obj = daemonError as Record<string, unknown>;

  // CallResponse{ok:false, error:{code}} or a nested JSON-RPC error object.
  const err = obj.error;
  if (typeof err === 'string') return err;
  if (err !== null && typeof err === 'object') {
    const nested = extractDaemonCode(err);
    if (nested !== undefined) return nested;
  }

  // JSON-RPC error `data` channel (daemon string code), then a top-level string `code`.
  const data = obj.data;
  if (typeof data === 'string') return data;
  if (data !== null && typeof data === 'object') {
    const dataCode = (data as Record<string, unknown>).code;
    if (typeof dataCode === 'string') return dataCode;
  }
  if (typeof obj.code === 'string') return obj.code;
  return undefined;
}

/**
 * Map a daemon `CallResponse{ok:false}` / JSON-RPC error object onto the closed
 * {@link ErrorCode} set, with an **`internal` fallback** for any unrecognised or
 * unparseable daemon code (so an unknown daemon error is never wrong-typed or
 * dropped). Total and pure: never throws.
 */
export function mapDaemonError(daemonError: unknown): ErrorCode {
  const raw = extractDaemonCode(daemonError);
  if (raw === undefined) return 'internal';
  return DAEMON_CODE_TO_ERROR[normaliseDaemonCode(raw)] ?? 'internal';
}
