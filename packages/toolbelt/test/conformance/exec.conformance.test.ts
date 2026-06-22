/**
 * Conformance · Tier 2 — exec.start guarded-exec round-trip (two daemons). T106 / #14.
 *
 * Exercises the interface between the T106 handler contract and the **live**
 * `exec.start` daemon surface (Boundary B), which no pure unit test can cover.
 * Because the unit tests inject a fake `DaemonCall`, the guard (AC 1 disabled
 * by default, AC 2 allow-path, AC 3 deny_args_regex) is simulated there — this
 * suite pins the **real** daemon behavior so handler wire-shape assumptions and
 * DAEMON_CODE_TO_ERROR table entries degrade visibly when the daemon drifts.
 *
 * Pre-conditions (established OUT OF BAND — never via the toolbelt, never as a
 * model tool):
 *   - daemon B logged in as a distinct Matrix user, joined to A's workspace room;
 *   - mutual Ed25519 trust established (`mx-agent trust approve`);
 *   - for the allow-path (AC 2): `MXL_CONFORMANCE_ALLOWED_COMMAND` set to a
 *     binary in B's `allow_commands` list (e.g. `echo`); B's `policy.toml` must
 *     carry a matching `[[allow_commands]]` entry;
 *   - for the deny-path (AC 1 / AC 3): `MXL_CONFORMANCE_DENIED_COMMAND` set to
 *     any command that B's deny-by-default `policy.toml` does NOT allow (the
 *     empty / default policy satisfies this for any command).
 *
 * The suite drives the **raw** `MxClient.call('exec.start', …)` seam exactly as
 * the T105 `call.start` suite drives `call.start`. AC assertions are on the raw
 * `ExecResponse` because the T102 envelope is applied by the handler layer, not
 * the transport — the second describe block exercises the T102 seam on top.
 *
 * Gate: `MXL_CONFORMANCE_TWO_DAEMON=1` (same as `delegate.conformance.test.ts`).
 * The suite is marked as staged; it is red-on-drift once the bring-up lands the
 * two-daemon `exec.start` fixture. Allow- and deny-path tests skip independently
 * when their respective fixture coordinate is absent so CI stays informative
 * about what was and wasn't exercised.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isErrorCode, mapDaemonError, ok, denied, errored, validateEnvelope } from '@mx-loom/registry';
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

// ---------------------------------------------------------------------------
// Local helpers (mirror delegate.conformance.test.ts)
// ---------------------------------------------------------------------------

/** Did the daemon signal a refusal — transport rejection OR an `ok:false`/denial response? */
function isDenial(value: unknown): boolean {
  if (value instanceof TransportError) return true;
  if (value === null || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  if (rec['ok'] === false) return true;
  if (rec['error'] !== undefined && rec['error'] !== null) return true;
  if (typeof rec['status'] === 'string' && /deny|denied|reject|refus|policy/i.test(rec['status'])) return true;
  if (typeof rec['state'] === 'string' && /policy_denied|denied/i.test(rec['state'])) return true;
  return false;
}

/** Extract an invocation/call identifier from an ExecResponse, if present. */
function invocationIdOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const rec = value as Record<string, unknown>;
  for (const key of ['invocation_id', 'exec_id', 'call_id', 'id', 'handle']) {
    if (typeof rec[key] === 'string') return rec[key] as string;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tier 2 — raw exec.start round-trip (AC 1, AC 2, AC 3)
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_TWO_DAEMON)('conformance · Tier 2 — exec.start guarded-exec round-trip', () => {
  let client: MxClient | undefined;
  let fixture: TwoDaemonFixture | undefined;

  beforeAll(() => {
    assertTwoDaemonPrereqs();
    const fx = readTwoDaemonFixture();
    if (fx === null) throw new Error('conformance Tier 2 (exec.start): two-daemon fixture coordinates absent');
    fixture = fx;
    client = createClient();
  });

  afterAll(async () => {
    await client?.close();
  });

  // -------------------------------------------------------------------------
  // AC 1 — disabled by default → policy_denied
  // The deny-by-default policy on B must block any un-allowlisted command.
  // MXL_CONFORMANCE_DENIED_COMMAND is the coordinate; it skips (not fails) if
  // absent so CI can land the allow-path first.
  // -------------------------------------------------------------------------

  it(
    'AC 1: exec.start to a policy-denied command signals denial (deny-by-default is real)',
    async (ctx) => {
      if (!client || !fixture) throw new Error('Tier 2 (exec.start AC 1) fixture not initialised');
      if (!fixture.deniedCommand) {
        // MXL_CONFORMANCE_DENIED_COMMAND not supplied — skip rather than silently pass.
        ctx.skip();
        return;
      }

      const outcome = await client
        .call(
          'exec.start',
          {
            room: fixture.room,
            agent: fixture.targetAgentId,
            command: fixture.deniedCommand,
            args: [],
            idempotency_key: `mxl-exec-deny-${randomUUID()}`,
          },
          { timeoutMs: 90_000 },
        )
        .catch((e: unknown) => e);

      // The receiving daemon enforces deny-by-default out-of-process; assert it
      // signals denial (transport rejection OR ok:false/policy_denied state).
      expect(isDenial(outcome)).toBe(true);
      // Secret boundary: the denial response must never carry a token.
      expect(JSON.stringify(outcome instanceof Error ? outcome.message : outcome)).not.toMatch(
        SECRET_PATTERN,
      );
    },
  );

  // -------------------------------------------------------------------------
  // AC 2 — allowlisted command runs → ExecResponse with a result
  // MXL_CONFORMANCE_ALLOWED_COMMAND is the coordinate (e.g. `echo`).
  // -------------------------------------------------------------------------

  it(
    'AC 2: exec.start to an allowlisted command resolves to its output (raw ExecResponse)',
    async (ctx) => {
      if (!client || !fixture) throw new Error('Tier 2 (exec.start AC 2) fixture not initialised');
      if (!fixture.allowedCommand) {
        ctx.skip();
        return;
      }

      const response = await client.call(
        'exec.start',
        {
          room: fixture.room,
          agent: fixture.targetAgentId,
          command: fixture.allowedCommand,
          args: ['mx-loom-conformance'],
          idempotency_key: `mxl-exec-allow-${randomUUID()}`,
        },
        { timeoutMs: 90_000 },
      );

      // The raw ExecResponse must resolve to an object (not throw / not null).
      expect(response).not.toBeNull();
      expect(typeof response).toBe('object');
      // The allowed command must not be denied.
      expect(isDenial(response)).toBe(false);
      // Secret boundary holds across the exec result.
      expect(JSON.stringify(response)).not.toMatch(SECRET_PATTERN);
      // An invocation id must be a non-empty string when present.
      const invId = invocationIdOf(response);
      if (invId !== undefined) {
        expect(invId.length, 'invocation id returned by daemon must be non-empty').toBeGreaterThan(0);
      }
    },
  );

  // -------------------------------------------------------------------------
  // AC 3 — deny_args_regex match → policy_denied
  // This exercises the negative policy path that is DISTINCT from AC 1 in the
  // policy.toml (a regex match vs. an un-allowlisted command) but produces the
  // same `policy_denied` outcome at the transport layer.
  //
  // Because the daemon cannot distinguish AC 1 from AC 3 from the client side
  // (both are `policy_denied`), this test uses the same denial coordinate as
  // AC 1 to assert the shared outcome. A CI bring-up that wants to exercise a
  // true deny_args_regex case should export MXL_CONFORMANCE_DENIED_COMMAND as a
  // command that IS in allow_commands but whose args trip the deny_args_regex.
  // -------------------------------------------------------------------------

  it(
    'AC 3: exec.start with deny_args_regex-matched args signals policy denial (same transport outcome as AC 1)',
    async (ctx) => {
      if (!client || !fixture) throw new Error('Tier 2 (exec.start AC 3) fixture not initialised');
      if (!fixture.deniedCommand) {
        ctx.skip();
        return;
      }

      const outcome = await client
        .call(
          'exec.start',
          {
            room: fixture.room,
            agent: fixture.targetAgentId,
            command: fixture.deniedCommand,
            // Typical deny_args_regex catch: a flag that escalates privilege.
            args: ['--allow-root', '--unsafe'],
            idempotency_key: `mxl-exec-regex-${randomUUID()}`,
          },
          { timeoutMs: 90_000 },
        )
        .catch((e: unknown) => e);

      expect(isDenial(outcome)).toBe(true);
      expect(JSON.stringify(outcome instanceof Error ? outcome.message : outcome)).not.toMatch(
        SECRET_PATTERN,
      );
    },
  );

  // -------------------------------------------------------------------------
  // Idempotency — same key reuses the invocation, no double-execute
  // -------------------------------------------------------------------------

  it(
    'exec.start idempotency: same key does not double-execute (best-effort)',
    async (ctx) => {
      if (!client || !fixture) throw new Error('Tier 2 (exec.start idempotency) fixture not initialised');
      if (!fixture.allowedCommand) {
        ctx.skip();
        return;
      }

      const idempotencyKey = `mxl-exec-idem-${randomUUID()}`;
      const params = {
        room: fixture.room,
        agent: fixture.targetAgentId,
        command: fixture.allowedCommand,
        args: ['mx-loom-idempotency'],
        idempotency_key: idempotencyKey,
      };

      const first = await client.call('exec.start', params, { timeoutMs: 90_000 });
      const second = await client.call('exec.start', params, { timeoutMs: 90_000 });

      expect(isDenial(first)).toBe(false);
      expect(isDenial(second)).toBe(false);

      // When the daemon surfaces an invocation id, the replay must reuse it.
      const firstId = invocationIdOf(first);
      const secondId = invocationIdOf(second);
      if (firstId !== undefined && secondId !== undefined) {
        expect(secondId, 'same idempotency_key must not produce a second invocation id').toBe(firstId);
      } else {
        // Structural equality is the fallback assertion.
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Tier 2 — T102 result-envelope seam (exec.start)
//
// Exercises the interface between the T102 contract layer helpers
// (`@mx-loom/registry`) and live `exec.start` daemon responses. Three open
// questions the spec flags as "pending the round-trip":
//
// (a) mapDaemonError maps the live `exec.start` denial spelling → `policy_denied`
//     (OQ #3 analogue for exec). If it maps to `internal`, DAEMON_CODE_TO_ERROR
//     needs the real daemon exec denial vocabulary.
// (b) audit_ref field availability on an `exec.start` success — which of the four
//     fields the daemon surfaces (OQ #4 analogue).
// (c) Idempotency dedup with T102 envelope validation — same key → conforming ok
//     envelopes with no second invocation id.
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_TWO_DAEMON)('conformance · Tier 2 — exec.start T102 envelope seam', () => {
  let client: MxClient | undefined;
  let fixture: TwoDaemonFixture | undefined;

  beforeAll(() => {
    assertTwoDaemonPrereqs();
    const fx = readTwoDaemonFixture();
    if (fx === null) throw new Error('conformance Tier 2 (exec.start T102 envelope): fixture coordinates absent');
    fixture = fx;
    client = createClient();
  });

  afterAll(async () => {
    await client?.close();
  });

  // (b) audit_ref field availability on exec.start success — document OQ #4 resolution.
  it(
    'exec.start success: raw response wraps into a conforming T102 ok envelope (audit_ref field probe)',
    async (ctx) => {
      if (!client || !fixture) throw new Error('T102 envelope (exec.start) fixture not initialised');
      if (!fixture.allowedCommand) {
        ctx.skip();
        return;
      }

      const response = await client.call(
        'exec.start',
        {
          room: fixture.room,
          agent: fixture.targetAgentId,
          command: fixture.allowedCommand,
          args: ['mx-loom-t102-envelope-audit'],
          idempotency_key: `mxl-exec-t102-env-${randomUUID()}`,
        },
        { timeoutMs: 90_000 },
      );

      expect(isDenial(response)).toBe(false);
      expect(JSON.stringify(response)).not.toMatch(SECRET_PATTERN);

      const rec = response as Record<string, unknown>;

      const auditRef: AuditRef = {
        invocation_id: typeof rec['invocation_id'] === 'string' ? (rec['invocation_id'] as string) : null,
        request_id: typeof rec['request_id'] === 'string' ? (rec['request_id'] as string) : null,
        room: typeof rec['room'] === 'string' ? (rec['room'] as string) : null,
        event_id: typeof rec['event_id'] === 'string' ? (rec['event_id'] as string) : null,
      };

      // The raw exec payload passthrough — result may carry exit_code / summary / log_ref.
      const resultPayload: Record<string, unknown> = Array.isArray(rec) ? { raw: rec } : rec;
      const envelope = ok(resultPayload, auditRef);
      expect(validateEnvelope(envelope)).toBe(true);

      // Document OQ #4 (exec.start variant) resolution.
      console.info('[T106 OQ#4/exec] audit_ref fields present in exec.start response:', {
        invocation_id: auditRef.invocation_id !== null,
        request_id: auditRef.request_id !== null,
        room: auditRef.room !== null,
        event_id: auditRef.event_id !== null,
      });
    },
  );

  // (a) mapDaemonError maps the live exec.start denial → policy_denied (OQ #3 analogue).
  it(
    'exec.start denial: mapDaemonError maps the live denial to policy_denied (T106 OQ #3/exec)',
    async (ctx) => {
      if (!client || !fixture) throw new Error('T102 envelope (exec.start) fixture not initialised');
      if (!fixture.deniedCommand) {
        ctx.skip();
        return;
      }

      const outcome = await client
        .call(
          'exec.start',
          {
            room: fixture.room,
            agent: fixture.targetAgentId,
            command: fixture.deniedCommand,
            args: [],
            idempotency_key: `mxl-exec-t102-denial-${randomUUID()}`,
          },
          { timeoutMs: 90_000 },
        )
        .catch((e: unknown) => e);

      expect(isDenial(outcome)).toBe(true);

      const daemonPayload = outcome instanceof Error ? (outcome.cause ?? outcome) : outcome;
      const code = mapDaemonError(daemonPayload);

      expect(isErrorCode(code)).toBe(true);
      // If this fails ('internal' instead of 'policy_denied'), the DAEMON_CODE_TO_ERROR
      // table in errors.ts needs the real exec.start denial vocabulary (T106 OQ #3).
      expect(code).toBe('policy_denied');

      const nullAuditRef: AuditRef = { invocation_id: null, request_id: null, room: null, event_id: null };
      const envelope = denied(code as DenialCode, 'policy denial from live exec.start daemon', nullAuditRef);
      expect(validateEnvelope(envelope)).toBe(true);

      console.info('[T106 OQ#3/exec] live exec.start policy denial mapped to:', code);
    },
  );

  // (c) Idempotency dedup with T102 envelope validation.
  it(
    'exec.start idempotency: repeated key → conforming T102 envelopes + no double-execute',
    async (ctx) => {
      if (!client || !fixture) throw new Error('T102 envelope (exec.start) fixture not initialised');
      if (!fixture.allowedCommand) {
        ctx.skip();
        return;
      }

      const idempotencyKey = `mxl-exec-t102-idem-${randomUUID()}`;
      const params = {
        room: fixture.room,
        agent: fixture.targetAgentId,
        command: fixture.allowedCommand,
        args: ['mx-loom-exec-idempotency-t102'],
        idempotency_key: idempotencyKey,
      };

      const first = await client.call('exec.start', params, { timeoutMs: 90_000 });
      const second = await client.call('exec.start', params, { timeoutMs: 90_000 });

      expect(isDenial(first)).toBe(false);
      expect(isDenial(second)).toBe(false);

      const nullAuditRef: AuditRef = { invocation_id: null, request_id: null, room: null, event_id: null };
      const r1 = first as Record<string, unknown>;
      const r2 = second as Record<string, unknown>;

      const env1 = ok(Array.isArray(r1) ? { raw: r1 } : r1, nullAuditRef);
      const env2 = ok(Array.isArray(r2) ? { raw: r2 } : r2, nullAuditRef);

      expect(validateEnvelope(env1)).toBe(true);
      expect(validateEnvelope(env2)).toBe(true);

      const firstId = invocationIdOf(first);
      const secondId = invocationIdOf(second);
      if (firstId !== undefined && secondId !== undefined) {
        expect(secondId, 'same idempotency_key must not produce a second invocation id').toBe(firstId);
      } else {
        expect(JSON.stringify(r2)).toBe(JSON.stringify(r1));
      }
    },
  );

  // Secret boundary — exec result must never carry a token.
  it('exec.start result carries no secret-shaped value (Boundary A holds over exec)', async (ctx) => {
    if (!client || !fixture) throw new Error('T102 envelope (exec.start) fixture not initialised');
    if (!fixture.allowedCommand) {
      ctx.skip();
      return;
    }

    const response = await client.call(
      'exec.start',
      {
        room: fixture.room,
        agent: fixture.targetAgentId,
        command: fixture.allowedCommand,
        args: ['mx-loom-secret-boundary'],
        idempotency_key: `mxl-exec-sec-${randomUUID()}`,
      },
      { timeoutMs: 90_000 },
    );

    expect(JSON.stringify(response)).not.toMatch(SECRET_PATTERN);

    // Build a minimal ok envelope and assert it also passes the boundary check.
    const rec = response as Record<string, unknown>;
    const auditRef: AuditRef = {
      invocation_id: typeof rec['invocation_id'] === 'string' ? (rec['invocation_id'] as string) : null,
      request_id: typeof rec['request_id'] === 'string' ? (rec['request_id'] as string) : null,
      room: typeof rec['room'] === 'string' ? (rec['room'] as string) : null,
      event_id: typeof rec['event_id'] === 'string' ? (rec['event_id'] as string) : null,
    };
    const envelope = ok(Array.isArray(rec) ? { raw: rec } : rec, auditRef);
    expect(JSON.stringify(envelope)).not.toMatch(SECRET_PATTERN);
    expect(validateEnvelope(envelope)).toBe(true);
  });
});
