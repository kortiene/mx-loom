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
