/**
 * Conformance · Tier 2 — delegation round-trip (two daemons). T007 / #7.
 *
 * The heavyweight tier: a real `call.start` named-tool delegation from daemon A
 * to a **second** registered target agent on daemon B, exercising the full
 * Boundary-B delegation path the toolbelt's `mx_delegate_tool` (T105 / M1) will
 * later sit on. Because no code path issues `call.start` yet, the suite drives
 * the **raw** `MxClient.call('call.start', …)` seam.
 *
 * Pre-conditions (the CI bring-up establishes them OUT OF BAND — never via the
 * toolbelt, never as a model tool):
 *   - daemon B logged in as a distinct Matrix user, joined to A's workspace room;
 *   - B registered as a target agent that PUBLISHES a named tool (e.g. a trivial
 *     `run_tests@1.0.0`-shaped echo tool);
 *   - mutual Ed25519 trust established (`mx-agent trust approve`);
 *   - a minimal receiver `policy.toml` on B allowing that tool (and, for the
 *     negative case, denying a second tool).
 * The bring-up exports the coordinates via `MXL_CONFORMANCE_ROOM`,
 * `MXL_CONFORMANCE_TARGET_AGENT`, `MXL_CONFORMANCE_TOOL`, and (optional)
 * `MXL_CONFORMANCE_DENIED_TOOL`.
 *
 * This tier is gated behind `MXL_CONFORMANCE_TWO_DAEMON=1` so the cheap
 * single-daemon tiers (0/1) land and stay green while the two-daemon bring-up is
 * being stood up. The M0 envelope does NOT exist yet, so assertions are on the
 * **raw** `CallResponse` the daemon returns — not on `{status, result,
 * audit_ref}` (that is M1 / T102).
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isErrorCode, mapDaemonError, ok, denied, validateEnvelope } from '@mx-loom/registry';
import type { AuditRef, DenialCode } from '@mx-loom/registry';

import { createClient } from '../../src/client.js';
import type { MxClient } from '../../src/client.js';
import { TransportError } from '../../src/transport.js';

import {
  SECRET_PATTERN,
  SKIP_TWO_DAEMON,
  assertTwoDaemonPrereqs,
  readTwoDaemonFixture,
} from './_harness.js';
import type { TwoDaemonFixture } from './_harness.js';

/** Did the daemon signal a refusal — either a transport rejection or an `ok:false` response? */
function isDenial(value: unknown): boolean {
  if (value instanceof TransportError) return true; // daemon JSON-RPC error → `rpc`
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record['ok'] === false) return true;
  if (record['error'] !== undefined && record['error'] !== null) return true;
  if (typeof record['status'] === 'string' && /deny|denied|reject|refus/i.test(record['status'])) return true;
  return false;
}

/** Extract a stable invocation identifier from a CallResponse, if present. */
function invocationIdOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['invocation_id', 'call_id', 'id', 'handle']) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  return undefined;
}

describe.skipIf(SKIP_TWO_DAEMON)('conformance · Tier 2 — call.start delegation round-trip', () => {
  let client: MxClient | undefined;
  let fixture: TwoDaemonFixture | undefined;

  beforeAll(() => {
    // Fail-not-skip: under MXL_CONFORMANCE_TWO_DAEMON=1 a missing daemon OR
    // missing fixture coordinates is a HARD failure.
    assertTwoDaemonPrereqs();
    const fx = readTwoDaemonFixture();
    if (fx === null) throw new Error('conformance Tier 2: two-daemon fixture coordinates absent');
    fixture = fx;
    client = createClient();
  });

  afterAll(async () => {
    await client?.close();
  });

  it('call.start delegates a named tool to agent B and resolves to its output (raw CallResponse)', async () => {
    if (!client || !fixture) throw new Error('Tier 2 fixture not initialised');
    const response = await client.call(
      'call.start',
      {
        room: fixture.room,
        agent: fixture.targetAgentId,
        tool: fixture.tool,
        args: { package: 'mx-loom-conformance' },
        idempotency_key: `mxl-conf-${randomUUID()}`,
      },
      { timeoutMs: 90_000 },
    );

    // The raw CallResponse must resolve to a usable object (not throw / not null).
    expect(response).not.toBeNull();
    expect(typeof response).toBe('object');
    // Delegation succeeded (the daemon did not signal a denial for an allowed tool).
    expect(isDenial(response)).toBe(false);
    // Secret boundary holds across the delegation result too.
    expect(JSON.stringify(response)).not.toMatch(SECRET_PATTERN);
    // If the daemon surfaces a call / invocation id it must be a non-empty string —
    // pins that the field isn't present but empty.
    const callId = invocationIdOf(response);
    if (callId !== undefined) {
      expect(callId.length, 'invocation id returned by daemon must be non-empty').toBeGreaterThan(0);
    }
  });

  it("call.start to a policy-denied tool returns the daemon's denial (deny-by-default is real)", async (ctx) => {
    if (!client || !fixture) throw new Error("Tier 2 fixture not initialised");
    if (!fixture.deniedTool) {
      // MXL_CONFORMANCE_DENIED_TOOL was not supplied — mark as SKIPPED rather than
      // silently PASSED so CI reports accurately reflect that the negative case was
      // not exercised. The bring-up script should publish a denied tool.
      ctx.skip();
      return;
    }
    const outcome = await client
      .call(
        'call.start',
        {
          room: fixture.room,
          agent: fixture.targetAgentId,
          tool: fixture.deniedTool,
          args: {},
          idempotency_key: `mxl-conf-deny-${randomUUID()}`,
        },
        { timeoutMs: 90_000 },
      )
      .catch((e: unknown) => e);

    // The receiving daemon enforces policy out-of-process; assert it signals
    // denial (transport rejection OR ok:false). Do NOT assert the M1
    // `policy_denied` envelope code — that envelope does not exist yet.
    expect(isDenial(outcome)).toBe(true);
  });

  it('a retried call.start with the same idempotency_key does not double-execute (best-effort, M0)', async () => {
    if (!client || !fixture) throw new Error('Tier 2 fixture not initialised');
    const idempotencyKey = `mxl-conf-idem-${randomUUID()}`;
    const params = {
      room: fixture.room,
      agent: fixture.targetAgentId,
      tool: fixture.tool,
      args: { package: 'mx-loom-idempotency' },
      idempotency_key: idempotencyKey,
    };

    const first = await client.call('call.start', params, { timeoutMs: 90_000 });
    const second = await client.call('call.start', params, { timeoutMs: 90_000 });

    expect(isDenial(first)).toBe(false);
    expect(isDenial(second)).toBe(false);

    // If the daemon surfaces an invocation id, the replay must reuse it (no
    // second execution). When no id is exposed, fall back to asserting the two
    // responses are structurally equal — neither indicates a fresh side effect.
    // Full idempotency coverage is T102; this stays intentionally light at M0.
    const firstId = invocationIdOf(first);
    const secondId = invocationIdOf(second);
    if (firstId !== undefined && secondId !== undefined) {
      expect(secondId).toBe(firstId);
    } else {
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    }
  });
});

/**
 * Conformance · Tier 2 — T102 result-envelope seam.
 *
 * Exercises the interface between the T102 contract layer (`@mx-loom/registry`
 * envelope helpers + mappers) and **live** `call.start` daemon responses, which
 * no pure unit test can cover. Three scenarios pinned by the T102 spec:
 *
 * (a) `mapDaemonError` maps the live denial spelling → `policy_denied`.
 *     If it maps to `internal` instead, `DAEMON_CODE_TO_ERROR` needs the real
 *     daemon vocabulary (T102 Open Question #3).
 * (b) `audit_ref` field availability: which of the four fields the daemon
 *     surfaces on a `call.start` success (T102 Open Question #4).
 * (c) Live idempotency_key dedup: repeated call with the same key produces
 *     conforming T102 ok envelopes with no double-execute (no second invocation id).
 *
 * All tests share the same `MXL_CONFORMANCE_TWO_DAEMON=1` gate and fixture
 * coordinates as the M0 raw-response tier above.
 */
describe.skipIf(SKIP_TWO_DAEMON)('conformance · Tier 2 — T102 result-envelope seam', () => {
  let client: MxClient | undefined;
  let fixture: TwoDaemonFixture | undefined;

  beforeAll(() => {
    assertTwoDaemonPrereqs();
    const fx = readTwoDaemonFixture();
    if (fx === null) throw new Error('conformance Tier 2 (T102 envelope): fixture coordinates absent');
    fixture = fx;
    client = createClient();
  });

  afterAll(async () => {
    await client?.close();
  });

  // (b) Confirm which audit_ref fields v0.2.1 exposes on call.start success.
  // The T102 spec requires invocation_id / request_id / room / event_id but flags
  // all four as pending verification (OQ #4). This test documents the reality and
  // asserts that whatever the daemon returns wraps into a conforming ok envelope.
  it('call.start success: raw response wraps into a conforming T102 ok envelope (audit_ref field probe)', async () => {
    if (!client || !fixture) throw new Error('T102 envelope fixture not initialised');
    const response = await client.call(
      'call.start',
      {
        room: fixture.room,
        agent: fixture.targetAgentId,
        tool: fixture.tool,
        args: { package: 'mx-loom-t102-envelope-audit' },
        idempotency_key: `mxl-t102-env-${randomUUID()}`,
      },
      { timeoutMs: 90_000 },
    );

    expect(isDenial(response)).toBe(false);
    expect(JSON.stringify(response)).not.toMatch(SECRET_PATTERN);

    const rec = response as Record<string, unknown>;

    // Build an AuditRef from whatever the daemon surfaced; missing fields → null.
    const auditRef: AuditRef = {
      invocation_id: typeof rec['invocation_id'] === 'string' ? (rec['invocation_id'] as string) : null,
      request_id: typeof rec['request_id'] === 'string' ? (rec['request_id'] as string) : null,
      room: typeof rec['room'] === 'string' ? (rec['room'] as string) : null,
      event_id: typeof rec['event_id'] === 'string' ? (rec['event_id'] as string) : null,
    };

    // Wrap the raw daemon payload in a T102 ok envelope and validate.
    const resultPayload: Record<string, unknown> = Array.isArray(rec) ? { raw: rec } : rec;
    const envelope = ok(resultPayload, auditRef);
    expect(validateEnvelope(envelope)).toBe(true);

    // Document OQ #4 resolution: which audit_ref fields v0.2.1 actually surfaces.
    console.info('[T102 OQ#4] audit_ref fields present in call.start response:', {
      invocation_id: auditRef.invocation_id !== null,
      request_id: auditRef.request_id !== null,
      room: auditRef.room !== null,
      event_id: auditRef.event_id !== null,
    });
  });

  // (a) Pin mapDaemonError against the real daemon denial vocabulary (OQ #3).
  // A policy-denied call.start must map to 'policy_denied'. If this assertion
  // fails with 'internal', update DAEMON_CODE_TO_ERROR in errors.ts with the
  // real daemon code spelling.
  it('call.start denial: mapDaemonError maps the live denial to policy_denied (T102 OQ #3)', async (ctx) => {
    if (!client || !fixture) throw new Error('T102 envelope fixture not initialised');
    if (!fixture.deniedTool) {
      ctx.skip();
      return;
    }

    const outcome = await client
      .call(
        'call.start',
        {
          room: fixture.room,
          agent: fixture.targetAgentId,
          tool: fixture.deniedTool,
          args: {},
          idempotency_key: `mxl-t102-denial-${randomUUID()}`,
        },
        { timeoutMs: 90_000 },
      )
      .catch((e: unknown) => e);

    expect(isDenial(outcome)).toBe(true);

    // For TransportError{code:'rpc'} the daemon's JSON-RPC error rides in .cause.
    const daemonPayload = outcome instanceof Error ? (outcome.cause ?? outcome) : outcome;
    const code = mapDaemonError(daemonPayload);

    expect(isErrorCode(code)).toBe(true);
    // If this fails ('internal' instead of 'policy_denied'), the DAEMON_CODE_TO_ERROR
    // table in errors.ts needs the real daemon vocabulary spelling (T102 OQ #3).
    expect(code).toBe('policy_denied');

    // Build and validate a conforming denied() envelope from the live mapped code.
    const nullAuditRef: AuditRef = { invocation_id: null, request_id: null, room: null, event_id: null };
    const envelope = denied(code as DenialCode, 'policy denial from live daemon', nullAuditRef);
    expect(validateEnvelope(envelope)).toBe(true);

    console.info('[T102 OQ#3] live policy denial mapped to:', code);
  });

  // (c) Live idempotency_key dedup — upgrade of the M0 test with T102 envelope validation.
  // Both attempts must produce conforming ok envelopes AND share the same invocation id
  // (no double-execute). Completes the "Full idempotency coverage is T102" note above.
  it('call.start idempotency: repeated key → conforming T102 envelopes + no double-execute', async () => {
    if (!client || !fixture) throw new Error('T102 envelope fixture not initialised');
    const idempotencyKey = `mxl-t102-idem-${randomUUID()}`;
    const params = {
      room: fixture.room,
      agent: fixture.targetAgentId,
      tool: fixture.tool,
      args: { package: 'mx-loom-idempotency-t102' },
      idempotency_key: idempotencyKey,
    };

    const first = await client.call('call.start', params, { timeoutMs: 90_000 });
    const second = await client.call('call.start', params, { timeoutMs: 90_000 });

    expect(isDenial(first)).toBe(false);
    expect(isDenial(second)).toBe(false);

    const nullAuditRef: AuditRef = { invocation_id: null, request_id: null, room: null, event_id: null };
    const r1 = first as Record<string, unknown>;
    const r2 = second as Record<string, unknown>;

    const env1 = ok(Array.isArray(r1) ? { raw: r1 } : r1, nullAuditRef);
    const env2 = ok(Array.isArray(r2) ? { raw: r2 } : r2, nullAuditRef);

    expect(validateEnvelope(env1)).toBe(true);
    expect(validateEnvelope(env2)).toBe(true);

    // Dedup: same idempotency_key → same invocation id (no second execution).
    const firstId = invocationIdOf(first);
    const secondId = invocationIdOf(second);
    if (firstId !== undefined && secondId !== undefined) {
      expect(secondId, 'same idempotency_key must not produce a second invocation id').toBe(firstId);
    } else {
      expect(JSON.stringify(r2)).toBe(JSON.stringify(r1));
    }
  });
});
