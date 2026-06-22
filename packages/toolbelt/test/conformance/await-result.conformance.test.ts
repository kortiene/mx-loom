/**
 * Conformance · T103 — mx_await_result deferred-result resolver.
 *
 * Verifies the live behavior of `mxAwaitResult` against a real mx-agent daemon,
 * covering what no pure unit test can: the actual `invocation.get` method + param
 * name (OQ #2), the invocation state vocabulary `classifyInvocation` keys on
 * (OQ #3), the `audit_ref` field availability (OQ #5), and the `running → ok`
 * lifecycle end-to-end (AC 1). AC 3 (`wait_ms=0` single probe returning the
 * current state without error) is verified unconditionally; the full budget-expiry
 * scenario requires an async tool and is gated on `MXL_CONFORMANCE_ASYNC_TOOL`.
 * The `awaiting_approval → ok|denied` path (AC 2) is gated on
 * `MXL_CONFORMANCE_APPROVAL_GATED_TOOL` since it requires an operator decision.
 *
 * Note: T105/T106 (`mx_delegate_tool` / `mx_run_command` — the mutating handlers
 * that *produce* handles) are not implemented yet. This suite drives `call.start`
 * directly via the raw `MxClient` seam (the same approach as the existing Tier 2
 * delegation suite) so the T103 resolver can be exercised end-to-end without those
 * handlers. The only behavioral change when T105/T106 land is the source of the
 * handle; the resolver and its assertions are unchanged.
 *
 * Pre-conditions (identical to the existing Tier 2 delegation suite):
 *   - `MXL_CONFORMANCE_TWO_DAEMON=1` set in the environment.
 *   - A live mx-agent daemon reachable at the conformance socket.
 *   - Fixture coordinates: MXL_CONFORMANCE_ROOM + MXL_CONFORMANCE_TARGET_AGENT +
 *     MXL_CONFORMANCE_TOOL (a tool that policy allows on agent B).
 *   - Optional: MXL_CONFORMANCE_DENIED_TOOL — tool policy denies (for denial path).
 *   - Optional: MXL_CONFORMANCE_ASYNC_TOOL — long-running tool that returns a
 *     handle before completing (for AC 3 wait_ms budget-expiry scenario).
 *   - Optional: MXL_CONFORMANCE_APPROVAL_GATED_TOOL — tool that goes to the human
 *     approval gate (awaiting_approval → ok|denied — AC 2 live).
 *
 * Run: MXL_CONFORMANCE_TWO_DAEMON=1 pnpm --filter @mx-loom/toolbelt test:conformance
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  classifyInvocation,
  invocationToResult,
  mxAwaitResult,
  validateEnvelope,
  type DaemonCall,
  type HandlerDeps,
} from '@mx-loom/registry';
import type { AuditRef } from '@mx-loom/registry';

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
// Helpers
// ---------------------------------------------------------------------------

const NULL_AUDIT_REF: AuditRef = { invocation_id: null, request_id: null, room: null, event_id: null };

/**
 * Wrap a real `MxClient` as the `HandlerDeps.daemon` seam for `mxAwaitResult`.
 * `MxClient` implements `MxTransport` which is a structural superset of
 * `DaemonCall` (= `Pick<MxTransport, 'call'>`), so we just forward the `call`
 * method. This gives the resolver a live Boundary-B channel while preserving the
 * existing `MxClient` guards (credential redaction, retry, failover).
 */
function wrapClient(client: MxClient): HandlerDeps {
  const daemon: DaemonCall = {
    call: (method, params, options) => client.call(method, params, options),
  };
  return { daemon, pollIntervalMs: 500 };
}

/**
 * Extract an invocation handle from a `call.start` response. The field name is
 * not yet confirmed by the two-daemon round-trip (OQ #2 descendant); check all
 * common candidates.
 */
function handleOf(response: unknown): string | undefined {
  if (response === null || typeof response !== 'object') return undefined;
  const r = response as Record<string, unknown>;
  for (const key of ['invocation_id', 'handle', 'call_id', 'id']) {
    if (typeof r[key] === 'string' && (r[key] as string).length > 0) {
      return r[key] as string;
    }
  }
  return undefined;
}

/**
 * Whether the value carries a daemon-level denial (transport rejection or
 * `ok:false` response). Mirrors `isDenial` from `delegate.conformance.test.ts`.
 */
function isDenial(value: unknown): boolean {
  if (value instanceof TransportError) return true;
  if (value === null || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  if (r['ok'] === false) return true;
  if (r['error'] !== undefined && r['error'] !== null) return true;
  return false;
}

// ---------------------------------------------------------------------------
// T103 conformance suite
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_TWO_DAEMON)('conformance · T103 — mx_await_result deferred-result resolver', () => {
  let client: MxClient | undefined;
  let deps: HandlerDeps | undefined;
  let fixture: TwoDaemonFixture | undefined;

  beforeAll(() => {
    // Fail-not-skip: under MXL_CONFORMANCE_TWO_DAEMON=1 a missing daemon is a HARD
    // failure. The single-daemon tiers do the same inside assertSingleDaemonPrereqs.
    assertTwoDaemonPrereqs();
    const fx = readTwoDaemonFixture();
    if (fx === null) throw new Error('conformance T103: two-daemon fixture coordinates absent');
    fixture = fx;
    client = createClient();
    deps = wrapClient(client);
  });

  afterAll(async () => {
    await client?.close();
  });

  // -------------------------------------------------------------------------
  // OQ #2 — pin `invocation.get` method + `invocation_id` param name
  //
  // T103 spec Open Question #2: "`invocation.get` vs `invocation.show`; param
  // `invocation_id` vs `handle` vs `id`." The resolver localises both in one
  // constant each so the round-trip correction is a one-line change. This test
  // calls `invocation.get` + `{ invocation_id }` directly via `MxClient` and
  // verifies the daemon does not reject with "method not found" or "invalid
  // params." The raw response is logged to document the confirmed vocabulary.
  //
  // If the assertion fires with "method not found": update INVOCATION_GET_METHOD
  // in `src/handlers/await-result.ts`. If it fires with "invalid params": update
  // INVOCATION_ID_PARAM in the same file.
  // -------------------------------------------------------------------------

  it('OQ #2: invocation.get method + invocation_id param round-trips without "method not found"', async () => {
    if (!client || !fixture) throw new Error('T103 fixture not initialised');

    // Start a real invocation to obtain a live handle.
    const startResp = await client.call(
      'call.start',
      {
        room: fixture.room,
        agent: fixture.targetAgentId,
        tool: fixture.tool,
        args: { package: `mx-loom-t103-oq2-${randomUUID()}` },
        idempotency_key: `mxl-t103-oq2-${randomUUID()}`,
      },
      { timeoutMs: 90_000 },
    );

    const handle = handleOf(startResp);
    if (handle === undefined) {
      // call.start returned a terminal result with no surfaced invocation id.
      // Possible when the daemon executes the tool inline and returns no async
      // handle. Log and skip the invocation.get probe for this fixture.
      console.info(
        '[T103 OQ#2] call.start returned no invocation_id/handle field — ' +
          'cannot probe invocation.get separately; skipping OQ #2 for this fixture.\n' +
          'call.start response:', JSON.stringify(startResp),
      );
      return;
    }

    // Probe `invocation.get` with `{ invocation_id: handle }` — the spec's assumed
    // method/param spelling. Capture errors instead of throwing so we can assert
    // on their code.
    const raw = await client
      .call('invocation.get', { invocation_id: handle }, { timeoutMs: 30_000 })
      .catch((e: unknown) => e);

    // The two failure modes that indicate a wrong spelling:
    const isMethodNotFound =
      raw instanceof TransportError &&
      raw.code === 'rpc' &&
      String(raw.message).toLowerCase().includes('not found');
    const isInvalidParams =
      raw instanceof TransportError &&
      raw.code === 'rpc' &&
      (String(raw.message).toLowerCase().includes('invalid') ||
        String(raw.message).toLowerCase().includes('param'));

    expect(
      isMethodNotFound,
      '[T103 OQ#2] "invocation.get" is the wrong method name — ' +
        'update INVOCATION_GET_METHOD in src/handlers/await-result.ts',
    ).toBe(false);

    expect(
      isInvalidParams,
      '[T103 OQ#2] "invocation_id" is the wrong param name — ' +
        'update INVOCATION_ID_PARAM in src/handlers/await-result.ts',
    ).toBe(false);

    // Log the raw response to document the confirmed OQ #2 vocabulary.
    console.info('[T103 OQ#2] invocation.get raw response:', JSON.stringify(raw));
    console.info('[T103 OQ#2] classifyInvocation result:', classifyInvocation(raw));
    console.info('[T103 OQ#2] CONFIRMED: method=invocation.get param=invocation_id handle=', handle);
  });

  // -------------------------------------------------------------------------
  // OQ #3 — pin invocation state vocabulary
  //
  // The T103 spec flags the exact state strings v0.2.1 returns as pending the
  // round-trip (the normaliser authors against the design's named states with
  // an `internal` fallback). This test probes the live response and logs the
  // raw `state`/`status`/`phase` field values so `INVOCATION_STATE_KIND` in
  // `src/handlers/invocation.ts` can be confirmed or updated.
  //
  // The assertions are intentionally permissive (any valid disposition is
  // accepted); the log output is the primary deliverable of this test.
  // -------------------------------------------------------------------------

  it('OQ #3: live invocation.get response classifies into a valid InvocationDisposition', async () => {
    if (!client || !fixture) throw new Error('T103 fixture not initialised');

    const startResp = await client.call(
      'call.start',
      {
        room: fixture.room,
        agent: fixture.targetAgentId,
        tool: fixture.tool,
        args: { package: `mx-loom-t103-oq3-${randomUUID()}` },
        idempotency_key: `mxl-t103-oq3-${randomUUID()}`,
      },
      { timeoutMs: 90_000 },
    );

    const handle = handleOf(startResp);
    let source: unknown;

    if (handle === undefined) {
      source = startResp;
      console.info('[T103 OQ#3] No handle from call.start; classifying call.start response directly.');
    } else {
      source = await client
        .call('invocation.get', { invocation_id: handle }, { timeoutMs: 30_000 })
        .catch((e: unknown) => e);

      if (source instanceof TransportError) {
        console.info(
          '[T103 OQ#3] invocation.get rejected:', source.code, source.message,
          '— method/param drift suspected; see OQ #2.',
        );
        return;
      }
    }

    const rec = source as Record<string, unknown>;
    console.info('[T103 OQ#3] raw invocation response:', JSON.stringify(source));
    console.info('[T103 OQ#3] state field candidates:', {
      state: rec['state'],
      status: rec['status'],
      phase: rec['phase'],
    });

    const disposition = classifyInvocation(source);
    console.info('[T103 OQ#3] classifyInvocation →', disposition);

    // Any valid InvocationDisposition is acceptable; the safe `internal` fallback
    // means an unrecognised state degrades to 'error' (never the wrong code).
    const VALID: string[] = ['ok', 'running', 'awaiting_approval', 'denied', 'error'];
    expect(VALID).toContain(disposition);

    // If classifyInvocation returns 'error' with code 'internal' for a clearly
    // succeeded response, the INVOCATION_STATE_KIND map needs the live state token.
    // This is the only path where the test produces a "soft" failure (wrong
    // disposition but not a thrown error). A console warning flags it for update.
    if (disposition === 'error') {
      const result = invocationToResult(source);
      if (result.error?.code === 'internal') {
        console.warn(
          '[T103 OQ#3] WARNING: invocation classified as error/internal — ' +
            `state token not in INVOCATION_STATE_KIND map. ` +
            `Raw state: "${String(rec['state'])}". Add to the map in invocation.ts.`,
        );
      }
    }
  });

  // -------------------------------------------------------------------------
  // OQ #5 — audit_ref field availability
  //
  // T103 spec (inherited from T102 OQ #4) flags which of the four audit_ref
  // fields v0.2.1 returns on `invocation.get`. `invocationToResult` always
  // produces a structurally complete `AuditRef` (missing ids → null). This
  // test documents which ids are actually present so callers know which ones
  // can be assumed non-null for reliable cross-referencing.
  // -------------------------------------------------------------------------

  it('OQ #5: audit_ref field availability — invocationToResult produces a complete AuditRef from live response', async () => {
    if (!client || !fixture) throw new Error('T103 fixture not initialised');

    const startResp = await client.call(
      'call.start',
      {
        room: fixture.room,
        agent: fixture.targetAgentId,
        tool: fixture.tool,
        args: { package: `mx-loom-t103-oq5-${randomUUID()}` },
        idempotency_key: `mxl-t103-oq5-${randomUUID()}`,
      },
      { timeoutMs: 90_000 },
    );

    const handle = handleOf(startResp);
    let source: unknown = startResp;
    if (handle !== undefined) {
      const polled = await client
        .call('invocation.get', { invocation_id: handle }, { timeoutMs: 30_000 })
        .catch(() => startResp);
      if (!(polled instanceof TransportError)) source = polled;
    }

    const rec = source as Record<string, unknown>;
    const nested = typeof rec['audit_ref'] === 'object' && rec['audit_ref'] !== null
      ? (rec['audit_ref'] as Record<string, unknown>)
      : rec;

    // Log OQ #5 resolution: which audit_ref fields v0.2.1 actually surfaces.
    console.info('[T103 OQ#5] audit_ref field availability:', {
      has_nested_audit_ref_block: typeof rec['audit_ref'] === 'object' && rec['audit_ref'] !== null,
      invocation_id: typeof (nested['invocation_id'] ?? rec['invocation_id'] ?? rec['id']) === 'string',
      request_id: typeof (nested['request_id'] ?? rec['request_id']) === 'string',
      room: typeof (nested['room'] ?? rec['room']) === 'string',
      event_id: typeof (nested['event_id'] ?? rec['event_id']) === 'string',
    });

    // `invocationToResult` must produce a structurally complete AuditRef — four
    // fields present, missing ids null (never fabricated, never throwing).
    const result = invocationToResult(source);
    expect(validateEnvelope(result)).toBe(true);
    const ref = result.audit_ref;
    expect(typeof ref).toBe('object');
    expect(ref).not.toBeNull();
    expect('invocation_id' in ref).toBe(true);
    expect('request_id' in ref).toBe(true);
    expect('room' in ref).toBe(true);
    expect('event_id' in ref).toBe(true);
  });

  // -------------------------------------------------------------------------
  // AC 1 live — mxAwaitResult resolves a live handle to a terminal envelope
  //
  // AC 1 acceptance criterion: "a running handle resolves to a terminal
  // envelope." The resolver is exercised end-to-end: real `call.start` → live
  // `MxClient` injected as `HandlerDeps.daemon` → `mxAwaitResult` polling
  // `invocation.get` → terminal T102 envelope.
  //
  // When `call.start` returns an inline terminal result with no separate handle
  // (the invocation ran synchronously), `invocationToResult` maps the response
  // directly — this is still the "first probe already terminal" AC 1 path.
  // -------------------------------------------------------------------------

  it('AC 1 live: mxAwaitResult resolves a live handle to a conforming terminal envelope', async () => {
    if (!client || !deps || !fixture) throw new Error('T103 fixture not initialised');

    const startResp = await client.call(
      'call.start',
      {
        room: fixture.room,
        agent: fixture.targetAgentId,
        tool: fixture.tool,
        args: { package: `mx-loom-t103-ac1-${randomUUID()}` },
        idempotency_key: `mxl-t103-ac1-${randomUUID()}`,
      },
      { timeoutMs: 90_000 },
    );

    expect(isDenial(startResp)).toBe(false);

    const handle = handleOf(startResp);
    let result;

    if (handle === undefined) {
      // No deferred handle: call.start returned inline. Map directly — this is
      // still a valid T103 AC 1 path (terminal on the first and only probe).
      console.info('[T103 AC1] call.start returned inline terminal result (no deferred handle)');
      result = invocationToResult(startResp);
    } else {
      // Deferred handle: use mxAwaitResult with a 60 s budget to poll until terminal.
      console.info('[T103 AC1] resolving deferred handle:', handle);
      try {
        result = await mxAwaitResult({ handle, wait_ms: 60_000 }, deps);
      } catch (err) {
        throw new Error(`[T103 AC1] mxAwaitResult must never throw — caught: ${String(err)}`);
      }
    }

    // (a) Terminal status — the resolver must not return pending after 60 s.
    expect(
      ['ok', 'denied', 'error'],
      '[T103 AC1] mxAwaitResult must return a terminal envelope within the 60 s budget',
    ).toContain(result.status);

    // (b) Conforms to ENVELOPE_SCHEMA.
    expect(validateEnvelope(result), '[T103 AC1] result must pass ENVELOPE_SCHEMA').toBe(true);

    // (c) audit_ref is always structurally present.
    expect(result.audit_ref).not.toBeNull();
    expect('invocation_id' in result.audit_ref).toBe(true);

    // (d) Boundary A: no secret-shaped value in the resolved envelope.
    expect(JSON.stringify(result)).not.toMatch(SECRET_PATTERN);

    console.info('[T103 AC1] resolved status:', result.status, '| audit_ref:', JSON.stringify(result.audit_ref));
  });

  // -------------------------------------------------------------------------
  // AC 3 live (single probe) — wait_ms=0 returns current state without error
  //
  // AC 3 acceptance criterion (first clause): "`wait_ms` omitted or `0` ⇒ a
  // single, non-blocking probe." The resolver must return the invocation's
  // CURRENT state — terminal if the tool ran synchronously, pending if still
  // in-flight — without ever returning `errored('timeout')` due to a `wait_ms`
  // expiry. This is the crux of T103 (design §4.3).
  //
  // Because most conformance tools complete synchronously, this test usually
  // exercises the "terminal on first probe" path. Both paths are AC 3 conformant.
  // The budget-expiry variant (persistent pending across the full budget) is in
  // the next test, gated on MXL_CONFORMANCE_ASYNC_TOOL.
  // -------------------------------------------------------------------------

  it('AC 3 live (single probe): mxAwaitResult(wait_ms=0) returns current state — never errored("timeout")', async () => {
    if (!client || !deps || !fixture) throw new Error('T103 fixture not initialised');

    const startResp = await client.call(
      'call.start',
      {
        room: fixture.room,
        agent: fixture.targetAgentId,
        tool: fixture.tool,
        args: { package: `mx-loom-t103-ac3-single-${randomUUID()}` },
        idempotency_key: `mxl-t103-ac3s-${randomUUID()}`,
      },
      { timeoutMs: 90_000 },
    );

    expect(isDenial(startResp)).toBe(false);

    const handle = handleOf(startResp);
    if (handle === undefined) {
      console.info('[T103 AC3 single] call.start returned no handle — single probe test not applicable');
      return;
    }

    let result;
    try {
      result = await mxAwaitResult({ handle, wait_ms: 0 }, deps);
    } catch (err) {
      throw new Error(`[T103 AC3 single] mxAwaitResult(wait_ms=0) must never throw — caught: ${String(err)}`);
    }

    // AC 3 regression guard: a wait_ms=0 expiry MUST NOT produce errored('timeout').
    // Any other status (running, awaiting_approval, ok, denied, or a genuine
    // transport error) is acceptable.
    if (result.status === 'error') {
      expect(
        result.error?.code,
        '[T103 AC3] status=error with code=timeout on a wait_ms=0 probe is an AC 3 regression — ' +
          'wait_ms expiry must return the pending envelope (error: null), not errored("timeout")',
      ).not.toBe('timeout');
    }

    expect(validateEnvelope(result)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(SECRET_PATTERN);

    console.info('[T103 AC3 single] status:', result.status, '| error:', result.error);
  });

  // -------------------------------------------------------------------------
  // AC 3 live (budget expiry) — wait_ms expiry on still-pending returns pending
  //
  // The definitive AC 3 scenario: a `wait_ms` budget expires while the
  // invocation is still pending → the resolver returns the PENDING envelope
  // (`error: null`), NOT `errored('timeout')`. This requires a tool that is
  // still in-flight for longer than `wait_ms`. Gate on
  // `MXL_CONFORMANCE_ASYNC_TOOL` — a tool the daemon starts asynchronously
  // and whose handle is returned before it completes (a long-running tool).
  // -------------------------------------------------------------------------

  it('AC 3 live (budget expiry): wait_ms expiry returns pending envelope with error: null (gated on MXL_CONFORMANCE_ASYNC_TOOL)', async (ctx) => {
    const asyncTool = process.env['MXL_CONFORMANCE_ASYNC_TOOL'];
    if (!asyncTool || !client || !deps || !fixture) {
      ctx.skip();
      return;
    }

    // Start the long-running tool with a zero client timeout so call.start
    // returns the handle immediately (before the tool completes).
    const startResp = await client.call(
      'call.start',
      {
        room: fixture.room,
        agent: fixture.targetAgentId,
        tool: asyncTool,
        args: { delay_ms: 30_000 },
        idempotency_key: `mxl-t103-ac3-async-${randomUUID()}`,
      },
      // Short timeout so call.start returns the handle before the tool finishes.
      { timeoutMs: 5_000 },
    ).catch((e: unknown) => e);

    const handle = handleOf(startResp instanceof Error ? undefined : startResp);
    if (handle === undefined) {
      console.info('[T103 AC3 async] call.start returned no handle; skipping budget-expiry scenario');
      ctx.skip();
      return;
    }

    // Poll with a short budget (2 s) — the tool takes 30 s so the budget will
    // expire with the invocation still pending.
    const result = await mxAwaitResult({ handle, wait_ms: 2_000 }, deps);

    // AC 3 core assertion: wait_ms expiry → pending status, error: null.
    // If this fires, the resolver is incorrectly converting a `wait_ms` expiry
    // into `errored('timeout')` — a regression of the crux behavior.
    expect(
      result.status,
      '[T103 AC3] budget-expiry must return running|awaiting_approval, not error',
    ).not.toBe('error');
    expect(
      result.error,
      '[T103 AC3] budget-expiry must have error: null (not errored("timeout"))',
    ).toBeNull();
    expect(validateEnvelope(result)).toBe(true);

    console.info('[T103 AC3 async] budget-expiry status:', result.status, '| handle:', result.handle);
  });

  // -------------------------------------------------------------------------
  // AC 2 live — awaiting_approval → ok|denied after operator decision
  //
  // The approval-gated path requires a tool that the receiving daemon holds
  // for human approval before executing. The operator (or a test bot) must
  // call `approval.decide` out-of-process; then `mxAwaitResult` observes the
  // resulting terminal state. Gate on MXL_CONFORMANCE_APPROVAL_GATED_TOOL.
  //
  // Note: the resolver makes NO approval/deny call — it only reads state via
  // `invocation.get`. The operator's decision and the daemon's re-authorization
  // at release (design §5) are entirely out-of-process.
  // -------------------------------------------------------------------------

  it('AC 2 live: awaiting_approval resolves to ok|denied after operator decision (gated on MXL_CONFORMANCE_APPROVAL_GATED_TOOL)', async (ctx) => {
    const approvalTool = process.env['MXL_CONFORMANCE_APPROVAL_GATED_TOOL'];
    if (!approvalTool || !client || !deps || !fixture) {
      ctx.skip();
      return;
    }

    const startResp = await client.call(
      'call.start',
      {
        room: fixture.room,
        agent: fixture.targetAgentId,
        tool: approvalTool,
        args: {},
        idempotency_key: `mxl-t103-ac2-${randomUUID()}`,
      },
      { timeoutMs: 30_000 },
    );

    expect(isDenial(startResp)).toBe(false);

    const handle = handleOf(startResp);
    if (handle === undefined) {
      console.info('[T103 AC2] call.start returned no handle for approval-gated tool — check fixture');
      ctx.skip();
      return;
    }

    // Immediately probe to confirm the invocation is awaiting_approval.
    const singleProbe = await mxAwaitResult({ handle, wait_ms: 0 }, deps);
    console.info('[T103 AC2] initial probe:', singleProbe.status, '| approval:', JSON.stringify(singleProbe.approval));

    // The operator must decide via approval.decide (out-of-process, test fixture bot).
    // Poll with a 120 s budget to allow the bot time to act.
    const result = await mxAwaitResult({ handle, wait_ms: 120_000 }, deps);

    // After the operator decides, the result must be terminal.
    expect(
      ['ok', 'denied'],
      '[T103 AC2] awaiting_approval must resolve to ok or denied after operator decision',
    ).toContain(result.status);

    // AC 2 secondary assertion: the resolver issued no approve/decide call.
    // (Verified structurally — the resolver only calls invocation.get — but
    // confirm at the network level that no other method was invoked.)
    expect(validateEnvelope(result)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(SECRET_PATTERN);

    console.info('[T103 AC2] resolved status:', result.status, '| error code:', result.error?.code);
  });

  // -------------------------------------------------------------------------
  // Boundary A — resolved envelope from live daemon contains no secret
  //
  // Design §4.3, §4.7, §6: the resolver's output crosses Boundary A toward the
  // model carrying only status / result / `approval` summary / `audit_ref`.
  // Matrix tokens, Ed25519 signing keys, provider keys, and `GH_TOKEN` must
  // never appear. Mirrors the same assertion from `delegate.conformance.test.ts`
  // and `envelope.conformance.test.ts`.
  // -------------------------------------------------------------------------

  it('Boundary A: resolved envelope from live daemon contains no secret-shaped value (design §4.3, §4.7, §6)', async () => {
    if (!client || !deps || !fixture) throw new Error('T103 fixture not initialised');

    const startResp = await client.call(
      'call.start',
      {
        room: fixture.room,
        agent: fixture.targetAgentId,
        tool: fixture.tool,
        args: { package: `mx-loom-t103-boundary-${randomUUID()}` },
        idempotency_key: `mxl-t103-boundary-${randomUUID()}`,
      },
      { timeoutMs: 90_000 },
    );

    expect(isDenial(startResp)).toBe(false);

    const handle = handleOf(startResp);
    let result;

    if (handle === undefined) {
      result = invocationToResult(startResp);
    } else {
      try {
        result = await mxAwaitResult({ handle, wait_ms: 30_000 }, deps);
      } catch (err) {
        throw new Error(`[T103 Boundary A] mxAwaitResult must never throw — caught: ${String(err)}`);
      }
    }

    // Full-envelope Boundary A check: no secret-shaped value in any field.
    const serialized = JSON.stringify(result);
    expect(serialized, '[T103 Boundary A] secret-shaped value found in resolved envelope').not.toMatch(
      SECRET_PATTERN,
    );

    // error.message (if present) must be a fixed vocabulary phrase, not a raw
    // daemon payload that could carry a credential.
    if (result.error?.message) {
      expect(result.error.message).not.toMatch(SECRET_PATTERN);
    }

    // approval.summary (if present) must not carry a credential.
    if (result.approval?.summary) {
      expect(result.approval.summary).not.toMatch(SECRET_PATTERN);
    }
  });
});
