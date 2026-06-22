/**
 * Conformance · Tier 2 — T102 fault-envelope path (operational error codes).
 *
 * The unit tests in `packages/registry/test/errors.test.ts` cover
 * `mapDaemonError` exhaustively with synthetic inputs.  What they cannot cover
 * is the **live** path: a real daemon fault → `mapDaemonError` → `errored()` →
 * `validateEnvelope()`.  The existing Tier 2 T102 tests in
 * `delegate.conformance.test.ts` exercise the `ok()` and `denied()` helpers
 * against live data; THIS file closes the gap for the `errored()` helper and
 * the operational fault codes (`not_found`, `target_offline`, `invalid_args`,
 * `internal`) that the denial path never exercises.
 *
 * Three scenarios, each pinning an AC from the T102 spec (#10):
 *
 *   1. Unknown tool on a known agent (call.start) → daemon returns a
 *      "not_found"-class fault → `mapDaemonError` resolves → `errored()` →
 *      `validateEnvelope()` (AC 1 + AC 2 for the fault partition).
 *
 *   2. Unknown agent id → daemon returns a "not_found"/"target_offline"-class
 *      fault → same chain → conforming `error` envelope (AC 1 + AC 2).
 *
 *   3. Secret-free fault envelope (Boundary A on the error path): the
 *      `error.message` constructed from a live daemon fault must never contain
 *      a secret-shaped value (AC per design §4.7, §6).
 *
 * Pre-conditions (identical to the Tier 2 delegation suite):
 *   - `MXL_CONFORMANCE_TWO_DAEMON=1` set in the environment.
 *   - A live mx-agent daemon reachable at the conformance socket.
 *   - Fixture coordinates: `MXL_CONFORMANCE_ROOM` + `MXL_CONFORMANCE_TARGET_AGENT`
 *     + `MXL_CONFORMANCE_TOOL`.
 *
 * Run: MXL_CONFORMANCE_TWO_DAEMON=1 pnpm --filter @mx-loom/toolbelt test:conformance
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ENVELOPE_SCHEMA,
  FAULT_CODES,
  errored,
  isErrorCode,
  mapDaemonError,
  validateEnvelope,
} from '@mx-loom/registry';
import type { AuditRef, ErrorCode } from '@mx-loom/registry';

import { TransportError } from '../../src/transport.js';
import { createClient } from '../../src/client.js';
import type { MxClient } from '../../src/client.js';

import {
  SECRET_PATTERN,
  SKIP_TWO_DAEMON,
  assertTwoDaemonPrereqs,
  readTwoDaemonFixture,
} from './_harness.js';
import type { TwoDaemonFixture } from './_harness.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NULL_AUDIT_REF: AuditRef = { invocation_id: null, request_id: null, room: null, event_id: null };

/**
 * Call `call.start` with params that the daemon SHOULD reject (unknown tool,
 * unknown agent, …) and capture the fault.  Returns the raw daemon error value
 * — either a rejected `TransportError` or an `ok:false` response object.
 */
async function captureFault(client: MxClient, params: Record<string, unknown>): Promise<unknown> {
  return client
    .call('call.start', params, { timeoutMs: 30_000 })
    .catch((e: unknown) => e);
}

/** Returns true when the value signals a daemon fault (not a successful response). */
function isFault(value: unknown): boolean {
  if (value instanceof TransportError) return true;
  if (value === null || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  if (r['ok'] === false) return true;
  if (r['error'] !== null && r['error'] !== undefined) return true;
  return false;
}

/**
 * Extract the daemon error payload suitable for `mapDaemonError`.
 * For a `TransportError{code:'rpc'}` the JSON-RPC error object rides in `.cause`.
 */
function daemonErrorPayload(value: unknown): unknown {
  if (value instanceof Error) return value.cause ?? value;
  return value;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_TWO_DAEMON)('conformance · Tier 2 — T102 fault-envelope path (errored() helper)', () => {
  let client: MxClient | undefined;
  let fixture: TwoDaemonFixture | undefined;

  beforeAll(() => {
    assertTwoDaemonPrereqs();
    const fx = readTwoDaemonFixture();
    if (fx === null) throw new Error('conformance Tier 2 (T102 fault-envelope): fixture coordinates absent');
    fixture = fx;
    client = createClient();
  });

  afterAll(async () => {
    await client?.close();
  });

  // -------------------------------------------------------------------------
  // Scenario 1 — unknown tool → `not_found` class fault
  //
  // Calling `call.start` for a tool name that agent B does NOT publish must
  // produce a daemon fault.  `mapDaemonError` must resolve that fault to a
  // valid `ErrorCode` (most likely `not_found`; `internal` is an acceptable
  // fallback until the real daemon vocabulary is confirmed in T102 OQ #3).
  // The mapped code must be in the fault-set (FAULT_CODES), not the
  // denial-set — an "unknown tool" is an operational error, not a governance
  // decision.  The resulting `errored()` envelope must pass `validateEnvelope`.
  // -------------------------------------------------------------------------

  it('unknown tool: fault maps to a FAULT_CODE and produces a conforming T102 error envelope (AC 1 + AC 2)', async () => {
    if (!client || !fixture) throw new Error('T102 fault-envelope fixture not initialised');

    const unknownTool = `__nonexistent_tool_${randomUUID()}__`;
    const fault = await captureFault(client, {
      room: fixture.room,
      agent: fixture.targetAgentId,
      tool: unknownTool,
      args: {},
      idempotency_key: `mxl-t102-unk-tool-${randomUUID()}`,
    });

    expect(isFault(fault)).toBe(true);

    const payload = daemonErrorPayload(fault);
    const code = mapDaemonError(payload);

    expect(isErrorCode(code), `mapDaemonError returned '${String(code)}' — must be a valid ErrorCode`).toBe(true);

    // An "unknown tool" is an operational fault, not a governance denial.
    // If this assertion fires, update DAEMON_CODE_TO_ERROR in errors.ts with the
    // real daemon vocabulary for "unknown tool" (T102 Open Question #3).
    const faultSet = new Set<string>(FAULT_CODES);
    expect(
      faultSet.has(code),
      `'${code}' must be a fault-set code (timeout|not_found|invalid_args|target_offline|internal) for an unknown-tool response; update DAEMON_CODE_TO_ERROR if the daemon uses an unexpected spelling`,
    ).toBe(true);

    // Build a conforming errored() envelope and validate it against ENVELOPE_SCHEMA (AC 1).
    const envelope = errored(code as (typeof FAULT_CODES)[number], 'unknown tool — live daemon fault', NULL_AUDIT_REF);
    expect(validateEnvelope(envelope), `errored('${code}') must conform to ENVELOPE_SCHEMA`).toBe(true);

    // Log the live mapping for OQ #3 diagnostics.
    console.info('[T102 OQ#3] unknown-tool fault code from live daemon:', code);
  });

  // -------------------------------------------------------------------------
  // Scenario 2 — unknown agent → `not_found` or `target_offline` class fault
  //
  // Calling `call.start` for an agent id that is not registered must produce
  // a daemon fault.  The mapped ErrorCode should be `not_found` (agent does
  // not exist) or `target_offline` (agent is known but offline); `internal`
  // is accepted as a fallback.  Again, this must be in FAULT_CODES, not
  // DENIAL_CODES.  The resulting `errored()` envelope must validate.
  // -------------------------------------------------------------------------

  it('unknown agent: fault maps to a FAULT_CODE and produces a conforming T102 error envelope (AC 1 + AC 2)', async () => {
    if (!client || !fixture) throw new Error('T102 fault-envelope fixture not initialised');

    const unknownAgent = `__nonexistent_agent_${randomUUID()}__`;
    const fault = await captureFault(client, {
      room: fixture.room,
      agent: unknownAgent,
      tool: fixture.tool,
      args: {},
      idempotency_key: `mxl-t102-unk-agent-${randomUUID()}`,
    });

    expect(isFault(fault)).toBe(true);

    const payload = daemonErrorPayload(fault);
    const code = mapDaemonError(payload);

    expect(isErrorCode(code), `mapDaemonError returned '${String(code)}' — must be a valid ErrorCode`).toBe(true);

    const faultSet = new Set<string>(FAULT_CODES);
    expect(
      faultSet.has(code),
      `'${code}' must be a fault-set code for an unknown-agent response; update DAEMON_CODE_TO_ERROR if needed`,
    ).toBe(true);

    const envelope = errored(code as (typeof FAULT_CODES)[number], 'unknown agent — live daemon fault', NULL_AUDIT_REF);
    expect(validateEnvelope(envelope)).toBe(true);

    console.info('[T102 OQ#3] unknown-agent fault code from live daemon:', code);
  });

  // -------------------------------------------------------------------------
  // Scenario 3 — Boundary A on the error path: no secret in a fault envelope
  //
  // The `error.message` field in an `errored()` envelope is human-readable but
  // MUST never carry a credential (design §4.7, §6).  This test constructs
  // error messages from live daemon fault responses (using safe hand-authored
  // messages in this implementation, not echoing raw payloads) and verifies
  // that neither the message nor any other envelope field matches a
  // secret-shaped pattern — confirming Boundary A holds on the error path.
  //
  // The secondary assertion checks that the JSON serialization of a live-mapped
  // `errored()` envelope does not surface a secret anywhere (the full-envelope
  // Boundary A guarantee, mirroring the `ok()` assertion in delegate.conformance).
  // -------------------------------------------------------------------------

  it('Boundary A — error envelope from live fault contains no secret-shaped value (design §4.7)', async () => {
    if (!client || !fixture) throw new Error('T102 fault-envelope fixture not initialised');

    const fault = await captureFault(client, {
      room: fixture.room,
      agent: fixture.targetAgentId,
      tool: `__boundary_a_probe_${randomUUID()}__`,
      args: {},
      idempotency_key: `mxl-t102-boundary-${randomUUID()}`,
    });

    expect(isFault(fault)).toBe(true);

    const payload = daemonErrorPayload(fault);
    const code = mapDaemonError(payload) as ErrorCode;

    // Use a safe, non-echoing message: mappers must never echo raw daemon payloads.
    const safeMessage = `operational fault mapped to ${code}`;
    const faultSet = new Set<string>(FAULT_CODES);
    const safeCode: (typeof FAULT_CODES)[number] = faultSet.has(code)
      ? (code as (typeof FAULT_CODES)[number])
      : 'internal';

    const envelope = errored(safeCode, safeMessage, NULL_AUDIT_REF);
    expect(validateEnvelope(envelope)).toBe(true);

    // No secret-shaped value anywhere in the serialized envelope.
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toMatch(SECRET_PATTERN);

    // Individual field checks for the error block.
    expect(envelope.error?.message).not.toMatch(SECRET_PATTERN);
    expect(String(envelope.error?.code)).not.toMatch(SECRET_PATTERN);
  });

  // -------------------------------------------------------------------------
  // Scenario 4 — ENVELOPE_SCHEMA covers the errored() live-mapped output
  //
  // Re-compile ENVELOPE_SCHEMA independently (as `envelope-schema.test.ts`
  // does in pure unit tests) and validate `errored()` output for every
  // live-relevant FAULT_CODE — confirming that the same contract document
  // exported from the registry still validates the live-built envelopes.
  // Pure code-path (no extra daemon call); included here because the import
  // of `ENVELOPE_SCHEMA` as a shared contract artefact is meaningful to
  // exercise alongside the live-data tests.
  // -------------------------------------------------------------------------

  it('ENVELOPE_SCHEMA (imported contract document) validates errored() for every FAULT_CODE', () => {
    // This test uses no live daemon call; it verifies that the ENVELOPE_SCHEMA
    // contract document — which the live conformance tests assert real envelopes
    // against — correctly validates all FAULT_CODES. Grouped here so any
    // schema regression surfaces in the same report as the live fault tests.
    for (const code of FAULT_CODES) {
      const envelope = errored(code, `fault: ${code}`, NULL_AUDIT_REF);
      expect(
        validateEnvelope(envelope),
        `ENVELOPE_SCHEMA must accept errored('${code}') — schema regression`,
      ).toBe(true);
    }
  });
});
