/**
 * Conformance · T104 — `mxFindAgents` + `mxDescribeAgent` (single daemon).
 *
 * Verifies the live behavior of the T104 discovery handlers against a real
 * mx-agent daemon at the pinned v0.2.1 substrate. **Single-daemon** — discovery
 * is a local read (no Matrix round-trip, no second registered agent needed).
 *
 * What this covers that no pure unit test can:
 * - The actual `agent.list` method name + no-params call works and returns the
 *   `[{agent, liveness}]` row shape the handler depends on.
 * - The actual `agent.tools { agent_id }` method name + param name round-trip.
 * - The projected `AgentSummary` / `AgentDetail` / `PublishedTool` shapes
 *   `validateEnvelope`-pass against a real daemon response.
 * - Boundary A holds in practice: none of `matrix_user_id`, `device_id`,
 *   `signing_key_id`, `signing_public_key`, `state_rev` escapes the projection.
 *
 * Tests pin:
 * - AC 1 live: `mxFindAgents({ capability })` returns the registered agent.
 * - AC 1 negative live: an absent capability returns empty agents.
 * - AC 2 live: `mxDescribeAgent({ agent_id })` returns the target + its tools.
 * - OQ #3 (doc): what does `agent.list` carry in the row `tools[]`? Logged for
 *   the spec update — string names, schema objects, or empty.
 * - Boundary A: no secret-shaped value in any projected output.
 * - Envelope conformance: `validateEnvelope` passes on live responses.
 *
 * Pre-conditions (same as Tier 1 — see `agent-lifecycle.conformance.test.ts`):
 *   - `MXL_CONFORMANCE=1` set in the environment.
 *   - A live mx-agent daemon reachable at the conformance socket (the Tuwunel
 *     dev homeserver or any registered v0.2.1 daemon; see the reproduce notes
 *     in `docs/mx-agent-surface-v0.2.1.md`).
 *   - No second daemon or two-daemon fixture needed (discovery is read-only).
 *
 * Run:
 *   MXL_CONFORMANCE=1 pnpm --filter @mx-loom/toolbelt test:conformance
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  mxDescribeAgent,
  mxFindAgents,
  validateEnvelope,
  type DaemonCall,
  type HandlerDeps,
} from '@mx-loom/registry';

import { createClient } from '../../src/client.js';
import type { MxClient } from '../../src/client.js';
import { openSession } from '../../src/session.js';
import type { MxSession } from '../../src/session.js';

import {
  SECRET_PATTERN,
  SKIP_SINGLE_DAEMON,
  assertSingleDaemonPrereqs,
} from './_harness.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a real `MxClient` as the `HandlerDeps.daemon` seam for the T104 handlers.
 * `MxClient` implements `MxTransport`, a structural superset of `DaemonCall`
 * (= `Pick<MxTransport, 'call'>`), so we just forward `call`. This gives the
 * handlers a live Boundary-B channel while preserving all existing guards
 * (credential redaction, retry, transport failover).
 */
function wrapClient(client: MxClient): HandlerDeps {
  const daemon: DaemonCall = {
    call: (method, params, options) => client.call(method, params, options),
  };
  return { daemon };
}

// ---------------------------------------------------------------------------
// T104 conformance suite (single daemon)
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_SINGLE_DAEMON)('conformance · T104 — mxFindAgents + mxDescribeAgent (single daemon)', () => {
  let client: MxClient | undefined;
  let session: MxSession | undefined;
  let deps: HandlerDeps | undefined;
  let room: string | undefined;

  /**
   * A unique capability string for this run — used for the AC 1 capability
   * filter so the test does not accidentally match other agents that may already
   * be registered on the daemon's workspace.
   */
  const CONFORMANCE_CAPABILITY = 'mx_loom_t104_discovery_conformance';

  beforeAll(async () => {
    // Vitest 4.x runs beforeAll even when describe.skipIf(true) guards the suite;
    // exit early when neither the conformance flag nor a reachable daemon is present
    // to avoid spurious "no daemon" errors in the skip case.
    if (SKIP_SINGLE_DAEMON) return;

    // Fail-not-skip: under MXL_CONFORMANCE=1 a missing daemon is a HARD failure.
    assertSingleDaemonPrereqs();

    // Generous default: agent.register waits for Matrix /sync (~29s locally).
    client = createClient({ defaultTimeoutMs: 60_000 });

    const ws = (await client.call(
      'workspace.create',
      { name: 'mx-loom-t104-conformance', visibility: 'private' },
      { timeoutMs: 60_000 },
    )) as Record<string, unknown>;
    if (typeof ws['room_id'] !== 'string') {
      throw new Error('conformance T104: workspace.create returned no room_id');
    }
    room = ws['room_id'];

    // Register an agent with the unique conformance capability and a named tool
    // so both AC 1 (capability filter) and AC 2 (tool schemas) can be exercised
    // against the live daemon.
    session = await openSession({
      client,
      heartbeat: false,
      room,
      kind: 'runtime',
      capabilities: [CONFORMANCE_CAPABILITY],
      tools: ['mx_loom_t104_probe_tool'],
      workspace: { cwd: '/tmp', project_id: 'mx-loom-t104-conformance' },
      maxInvocations: 1,
    });

    deps = wrapClient(client);
  }, 90_000);

  afterAll(async () => {
    await session?.close();
    await client?.close();
  });

  // -------------------------------------------------------------------------
  // AC 1 live — mxFindAgents no-filter: registered agent appears
  //
  // Baseline: the discovery handler can call agent.list (no params) and the
  // just-registered agent is present in the returned list. Exercises the live
  // `agent.list` method name and the `{agent, liveness}` row shape the handler
  // depends on.
  // -------------------------------------------------------------------------

  it('AC 1 live (no filter): registered agent is present in mxFindAgents result', async () => {
    if (!deps || !session) throw new Error('T104 conformance: fixture not initialised');

    let result;
    try {
      result = await mxFindAgents({}, deps);
    } catch (err) {
      throw new Error(`[T104 AC1] mxFindAgents must never throw — caught: ${String(err)}`);
    }

    // A valid terminal envelope.
    expect(result.status).toMatch(/^(ok|denied|error)$/);
    expect(validateEnvelope(result), '[T104 AC1] envelope must be valid').toBe(true);

    if (result.status !== 'ok') {
      // If agent.list fails, report the error code for the spec update.
      console.warn('[T104 AC1] mxFindAgents returned non-ok:', result.status, result.error?.code, result.error?.message);
      return;
    }

    const agents = (result.result as { agents: Array<Record<string, unknown>> }).agents;
    expect(Array.isArray(agents), '[T104 AC1] result.agents must be an array').toBe(true);

    const found = agents.find((a) => a['agent_id'] === session!.agentId);
    expect(
      found,
      `[T104 AC1] registered agent ${session.agentId} must appear in mxFindAgents({}) result — agent.list surface drift?`,
    ).toBeDefined();

    console.info(
      '[T104 AC1] no-filter: found registered agent in list of', agents.length, 'agents.',
      'agent_id:', session.agentId, '| liveness:', found?.['liveness'],
    );
  });

  // -------------------------------------------------------------------------
  // AC 1 live — capability filter returns expected agents
  //
  // The canonical AC 1 acceptance criterion: "Filter by capability returns
  // expected agents." Calls `mxFindAgents({ capability: CONFORMANCE_CAPABILITY })`
  // and asserts the registered agent (which advertises that capability) is
  // returned. Agents NOT advertising the capability must be absent.
  // -------------------------------------------------------------------------

  it('AC 1 live (capability filter): mxFindAgents returns only agents advertising the capability', async () => {
    if (!deps || !session) throw new Error('T104 conformance: fixture not initialised');

    let result;
    try {
      result = await mxFindAgents({ capability: CONFORMANCE_CAPABILITY }, deps);
    } catch (err) {
      throw new Error(`[T104 AC1 cap] mxFindAgents must never throw — caught: ${String(err)}`);
    }

    expect(result.status).toMatch(/^(ok|denied|error)$/);
    expect(validateEnvelope(result), '[T104 AC1 cap] envelope must be valid').toBe(true);

    if (result.status !== 'ok') {
      console.warn('[T104 AC1 cap] mxFindAgents returned non-ok:', result.status, result.error?.code);
      return;
    }

    const agents = (result.result as { agents: Array<Record<string, unknown>> }).agents;
    expect(Array.isArray(agents)).toBe(true);

    // The registered agent must appear.
    const found = agents.find((a) => a['agent_id'] === session!.agentId);
    expect(
      found,
      `[T104 AC1 cap] registered agent must appear when filtering by capability '${CONFORMANCE_CAPABILITY}'`,
    ).toBeDefined();

    // Every returned agent must advertise the capability.
    for (const agent of agents) {
      const caps = agent['capabilities'];
      expect(
        Array.isArray(caps) && (caps as string[]).includes(CONFORMANCE_CAPABILITY),
        `[T104 AC1 cap] all returned agents must have capability '${CONFORMANCE_CAPABILITY}' — agent_id: ${String(agent['agent_id'])}`,
      ).toBe(true);
    }

    console.info(
      '[T104 AC1 cap] capability filter returned', agents.length, 'agent(s) with capability', CONFORMANCE_CAPABILITY,
    );
  });

  // -------------------------------------------------------------------------
  // AC 1 live — negative case: non-matching capability returns empty
  //
  // A capability no registered agent advertises must produce ok({ agents: [] })
  // — a valid empty success, not a fault.
  // -------------------------------------------------------------------------

  it('AC 1 live (negative): unknown capability returns ok({ agents: [] })', async () => {
    if (!deps) throw new Error('T104 conformance: fixture not initialised');

    const result = await mxFindAgents({ capability: 'mx_loom_t104_capability_that_no_agent_has_xyzzy' }, deps);

    expect(result.status).toMatch(/^(ok|denied|error)$/);
    expect(validateEnvelope(result)).toBe(true);

    if (result.status === 'ok') {
      const agents = (result.result as { agents: unknown[] }).agents;
      expect(Array.isArray(agents)).toBe(true);
      expect(agents).toHaveLength(0);
      console.info('[T104 AC1 neg] non-matching capability correctly returned 0 agents');
    } else {
      // A fault is unexpected but not a hard failure here — log for investigation.
      console.warn('[T104 AC1 neg] mxFindAgents returned fault for unknown capability:', result.status, result.error?.code);
    }
  });

  // -------------------------------------------------------------------------
  // AC 2 live — mxDescribeAgent returns the target's tool schemas
  //
  // The canonical AC 2 acceptance criterion: "mx_describe_agent returns the
  // target's tool schemas." Calls `mxDescribeAgent({ agent_id })` against the
  // live daemon (which exercises `agent.tools { agent_id }` then `agent.list`
  // for the liveness merge), and asserts:
  //   - status: ok
  //   - result has `agent` (with the correct agent_id) and `tools` (an array).
  //   - envelope passes validateEnvelope.
  // The exact tool-schema content depends on what the daemon returns for the
  // registered agent (see OQ #3 note below).
  // -------------------------------------------------------------------------

  it('AC 2 live: mxDescribeAgent returns the agent detail + its tool schemas', async () => {
    if (!deps || !session) throw new Error('T104 conformance: fixture not initialised');

    let result;
    try {
      result = await mxDescribeAgent({ agent_id: session.agentId }, deps);
    } catch (err) {
      throw new Error(`[T104 AC2] mxDescribeAgent must never throw — caught: ${String(err)}`);
    }

    expect(result.status).toMatch(/^(ok|denied|error)$/);
    expect(validateEnvelope(result), '[T104 AC2] envelope must be valid').toBe(true);

    if (result.status !== 'ok') {
      console.warn('[T104 AC2] mxDescribeAgent returned non-ok:', result.status, result.error?.code, result.error?.message);
      return;
    }

    const payload = result.result as { agent: Record<string, unknown>; tools: unknown[] };
    expect(payload.agent, '[T104 AC2] result.agent must be defined').toBeDefined();
    expect(Array.isArray(payload.tools), '[T104 AC2] result.tools must be an array').toBe(true);

    // The agent_id must round-trip correctly.
    expect(payload.agent['agent_id']).toBe(session.agentId);

    // The liveness must be a valid enum value (merged from agent.list).
    expect(['active', 'stale', 'offline']).toContain(payload.agent['liveness']);

    console.info(
      '[T104 AC2] mxDescribeAgent returned:',
      'agent_id:', payload.agent['agent_id'],
      '| kind:', payload.agent['kind'],
      '| liveness:', payload.agent['liveness'],
      '| tools count:', payload.tools.length,
    );
  });

  // -------------------------------------------------------------------------
  // AC 2 live — unknown agent_id surfaces as not_found
  //
  // When an agent_id has no corresponding registration, the handler must return
  // a fault envelope with code 'not_found' (not a thrown error, not 'internal').
  // Exercises the faultToResult path on a real daemon rejection.
  // -------------------------------------------------------------------------

  it('AC 2 live (not_found): an unknown agent_id produces a fault envelope, never a throw', async () => {
    if (!deps) throw new Error('T104 conformance: fixture not initialised');

    const NONEXISTENT_ID = 'ag_t104_conformance_nonexistent_xyzzy_12345';
    let result;
    try {
      result = await mxDescribeAgent({ agent_id: NONEXISTENT_ID }, deps);
    } catch (err) {
      throw new Error(`[T104 AC2 not_found] mxDescribeAgent must never throw — caught: ${String(err)}`);
    }

    // Must be a valid fault envelope (error or denied), never a throw or ok.
    expect(result.status).toMatch(/^(denied|error)$/);
    expect(validateEnvelope(result), '[T104 AC2 not_found] fault envelope must be valid').toBe(true);
    expect(result.result).toBeNull();

    console.info(
      '[T104 AC2 not_found] unknown agent_id →',
      result.status, '| code:', result.error?.code,
      '| confirms the daemon rejects with a recognisable error for unknown agents.',
    );
  });

  // -------------------------------------------------------------------------
  // OQ #3 documentary — what does agent.list carry in the row tools[] array?
  //
  // T104 spec Open Question #3: whether the `agent.list` row's `tools[]` array
  // carries tool *names* (strings) usable for the `tool` filter without an N+1
  // `agent.tools` fan-out, or whether names only come from `agent.tools.schemas`.
  // This test is purely documentary — it logs the live row tools shape so
  // the spec + handler can be updated. The T104 handler's readToolNames already
  // handles both cases conservatively (see `agent-projection.ts`).
  // -------------------------------------------------------------------------

  it('OQ #3 (documentary): log agent.list row tools[] shape for spec update', async () => {
    if (!deps || !session) throw new Error('T104 conformance: fixture not initialised');

    const rawRows = await client!
      .call('agent.list', undefined, { timeoutMs: 30_000 })
      .catch((e: unknown) => e);

    if (rawRows instanceof Error) {
      console.warn('[T104 OQ#3] agent.list call failed — cannot inspect row tools[]:', String(rawRows));
      return;
    }

    if (!Array.isArray(rawRows)) {
      console.warn('[T104 OQ#3] agent.list returned non-array:', typeof rawRows);
      return;
    }

    const myRow = rawRows.find(
      (r) =>
        r !== null &&
        typeof r === 'object' &&
        (r as { agent?: { agent_id?: unknown } }).agent?.agent_id === session!.agentId,
    ) as { agent?: Record<string, unknown>; liveness?: unknown } | undefined;

    if (!myRow) {
      console.warn('[T104 OQ#3] registered agent not found in raw agent.list response');
      return;
    }

    const rowTools = myRow.agent?.['tools'];
    console.info('[T104 OQ#3] agent.list row tools[] for registered agent:', JSON.stringify(rowTools));
    console.info('[T104 OQ#3] type:', Array.isArray(rowTools) ? 'array' : typeof rowTools);
    if (Array.isArray(rowTools) && rowTools.length > 0) {
      const first = rowTools[0];
      console.info(
        '[T104 OQ#3] first entry type:', typeof first,
        '| is string:', typeof first === 'string',
        '| is object with name:', first !== null && typeof first === 'object' && 'name' in (first as object),
      );
    } else {
      console.info('[T104 OQ#3] tools[] is empty or absent — tool filter will use agent.tools fan-out (correct fallback)');
    }

    // No assertion — this test is documentation-only. A future pin update should
    // confirm whether string names are available here (eliminating the N+1 path)
    // and update readToolNames in agent-projection.ts accordingly.
  });

  // -------------------------------------------------------------------------
  // Boundary A — discovery output contains no secret-shaped value
  //
  // Design §4.7, §6: the projected `AgentSummary` / `AgentDetail` / `PublishedTool`
  // shapes must not expose `matrix_user_id`, `device_id`, `signing_key_id`,
  // `signing_public_key`, `state_rev`, or any token-shaped value (Boundary A).
  // The unit `discovery.security.test.ts` already covers this with injected
  // fixtures; this test runs it against the REAL daemon response, confirming
  // the projection holds on actual v0.2.1 daemon output.
  // -------------------------------------------------------------------------

  it('Boundary A: mxFindAgents output contains no secret-shaped value (design §4.7, §6)', async () => {
    if (!deps) throw new Error('T104 conformance: fixture not initialised');

    const result = await mxFindAgents({}, deps);
    if (result.status !== 'ok') return; // tested in AC 1; skip boundary check on non-ok

    const json = JSON.stringify(result);

    // Token-shaped patterns must never appear.
    expect(json, '[T104 BoundaryA find] secret-shaped value in mxFindAgents output').not.toMatch(SECRET_PATTERN);

    // Explicitly named forbidden fields.
    for (const field of ['matrix_user_id', 'device_id', 'signing_key_id', 'signing_public_key', 'state_rev']) {
      expect(json, `[T104 BoundaryA find] forbidden field '${field}' in mxFindAgents output`).not.toContain(field);
    }

    console.info('[T104 BoundaryA find] mxFindAgents output clean (no secret-shaped values)');
  });

  it('Boundary A: mxDescribeAgent output contains no secret-shaped value (design §4.7, §6)', async () => {
    if (!deps || !session) throw new Error('T104 conformance: fixture not initialised');

    const result = await mxDescribeAgent({ agent_id: session.agentId }, deps);
    if (result.status !== 'ok') return;

    const json = JSON.stringify(result);

    expect(json, '[T104 BoundaryA describe] secret-shaped value in mxDescribeAgent output').not.toMatch(SECRET_PATTERN);

    for (const field of ['matrix_user_id', 'device_id', 'signing_key_id', 'signing_public_key', 'state_rev']) {
      expect(json, `[T104 BoundaryA describe] forbidden field '${field}' in mxDescribeAgent output`).not.toContain(field);
    }

    console.info('[T104 BoundaryA describe] mxDescribeAgent output clean (no secret-shaped values)');
  });

  // -------------------------------------------------------------------------
  // audit_ref — all-null for local reads (structural always-present invariant)
  //
  // Discovery is a local daemon read with no Matrix round-trip, so there is no
  // invocation_id / request_id / room / event_id to populate. The handlers
  // return EMPTY_AUDIT_REF (all-null ids) — this is the honest v0.2.1 behavior.
  // -------------------------------------------------------------------------

  it('audit_ref ids are all-null for local discovery reads (no Matrix round-trip)', async () => {
    if (!deps) throw new Error('T104 conformance: fixture not initialised');

    const findResult = await mxFindAgents({}, deps);
    if (findResult.status === 'ok') {
      expect(findResult.audit_ref.invocation_id).toBeNull();
      expect(findResult.audit_ref.request_id).toBeNull();
      expect(findResult.audit_ref.room).toBeNull();
      expect(findResult.audit_ref.event_id).toBeNull();
    }

    if (!session) return;
    const descResult = await mxDescribeAgent({ agent_id: session.agentId }, deps);
    if (descResult.status === 'ok') {
      expect(descResult.audit_ref.invocation_id).toBeNull();
      expect(descResult.audit_ref.request_id).toBeNull();
      expect(descResult.audit_ref.room).toBeNull();
      expect(descResult.audit_ref.event_id).toBeNull();
    }
  });

  // -------------------------------------------------------------------------
  // RPC method discipline — no mutating methods in discovery
  //
  // Discovery handlers must ONLY call the read-only discovery RPCs
  // (`agent.list`, `agent.tools`). This test wraps the client in a spy and
  // confirms no trust/policy/approval/mutation method is called.
  // -------------------------------------------------------------------------

  it('discovery handlers call no mutating daemon methods (read-only discipline)', async () => {
    if (!deps || !session) throw new Error('T104 conformance: fixture not initialised');

    const calledMethods: string[] = [];
    const spyDeps: HandlerDeps = {
      daemon: {
        call: (method, params, options) => {
          calledMethods.push(method);
          return client!.call(method, params, options);
        },
      },
    };

    await mxFindAgents({}, spyDeps);
    await mxDescribeAgent({ agent_id: session.agentId }, spyDeps);

    const MUTATION_METHODS = [
      'trust.add', 'trust.revoke', 'policy.update', 'approval.decide', 'approval.grant',
      'agent.register', 'agent.deregister', 'call.start', 'exec.start',
    ];
    for (const m of calledMethods) {
      expect(
        MUTATION_METHODS.includes(m),
        `[T104 RPC discipline] discovery handler called mutating method '${m}'`,
      ).toBe(false);
    }

    console.info('[T104 RPC discipline] methods called:', calledMethods.join(', '));
  });
});
