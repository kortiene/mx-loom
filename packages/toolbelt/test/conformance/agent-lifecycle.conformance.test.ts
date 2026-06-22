/**
 * Conformance · Tier 1 — discovery round-trips (single daemon). T007 / #7.
 *
 * Drives the public toolbelt API (`createClient` / `openSession` /
 * `MxClient.call`) against a live pinned daemon and asserts the surface the
 * toolbelt's types depend on actually holds:
 *
 * - `agent.register` returns a full, well-shaped `AgentState` (every field the
 *   toolbelt relies on), carrying **only public** key material.
 * - `agent.list` returns `[{ agent, liveness }]` rows and the just-registered
 *   agent is present with `liveness: "active"`.
 * - Known-bad inputs map onto the **closed** `TransportError` code set, so drift
 *   in error *behavior* is caught too — and the credential-shaped-arg guard
 *   stays intact across the boundary.
 *
 * Timing note (mirrors `session.integration.test.ts`): `agent.register` waits
 * for Matrix `/sync` to confirm a state event (~29s on a local homeserver), and
 * room creation can make the daemon briefly unresponsive. One workspace + one
 * shared session is opened in `beforeAll`; the tests reuse it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createClient } from '../../src/client.js';
import type { MxClient } from '../../src/client.js';
import { openSession } from '../../src/session.js';
import type { MxSession } from '../../src/session.js';
import { TransportError } from '../../src/transport.js';

import {
  AGENT_STATE_FIELDS,
  CLOSED_TRANSPORT_CODES,
  SECRET_PATTERN,
  SKIP_SINGLE_DAEMON,
  assertSingleDaemonPrereqs,
} from './_harness.js';

describe.skipIf(SKIP_SINGLE_DAEMON)('conformance · Tier 1 — agent lifecycle round-trips', () => {
  let client: MxClient | undefined;
  let session: MxSession | undefined;
  let room: string | undefined;

  beforeAll(async () => {
    // Fail-not-skip: under MXL_CONFORMANCE=1 a missing daemon is a HARD failure.
    assertSingleDaemonPrereqs();
    // Generous default: agent.register waits for Matrix /sync (~29s locally) and
    // room creation can leave the daemon briefly unresponsive (see the timing
    // note above + session.integration.test.ts). openSession's register inherits
    // this default, so it gets the full window.
    client = createClient({ defaultTimeoutMs: 60_000 });

    const ws = (await client.call(
      'workspace.create',
      { name: 'mx-loom-conformance', visibility: 'private' },
      { timeoutMs: 60_000 },
    )) as Record<string, unknown>;
    if (typeof ws['room_id'] !== 'string') {
      throw new Error('conformance Tier 1: workspace.create returned no room_id');
    }
    room = ws['room_id'];

    session = await openSession({
      client,
      heartbeat: false,
      room,
      kind: 'runtime',
      capabilities: [],
      tools: [],
      workspace: { cwd: '/tmp', project_id: 'mx-loom-conformance' },
      maxInvocations: 10,
    });
  }, 90_000);

  afterAll(async () => {
    await session?.close();
    await client?.close();
  });

  it('agent.register returns a full, well-shaped AgentState (every toolbelt field present)', () => {
    if (!session) throw new Error('session not opened');
    const state = session.agentState as unknown as Record<string, unknown>;

    for (const field of AGENT_STATE_FIELDS) {
      expect(state, `AgentState is missing '${field}' (surface drift)`).toHaveProperty(field);
    }
    // Spot-check the types the toolbelt actually relies on.
    expect(typeof state['agent_id']).toBe('string');
    expect(typeof state['kind']).toBe('string');
    expect(typeof state['matrix_user_id']).toBe('string');
    expect(typeof state['device_id']).toBe('string');
    expect(typeof state['status']).toBe('string');
    expect(Array.isArray(state['capabilities'])).toBe(true);
    expect(Array.isArray(state['tools'])).toBe(true);
    expect(typeof state['workspace']).toBe('object');
    expect(typeof state['last_seen_ts']).toBe('number');
    expect(typeof state['state_rev']).toBe('number');
    const load = state['load'] as Record<string, unknown>;
    expect(typeof load['running_invocations']).toBe('number');
    expect(typeof load['max_invocations']).toBe('number');
  });

  it('AgentState carries only PUBLIC key material — no private-key/token-shaped field leaked', () => {
    if (!session) throw new Error('session not opened');
    const state = session.agentState as unknown as Record<string, unknown>;

    // Public key material is present and non-empty…
    expect(typeof state['signing_key_id']).toBe('string');
    expect((state['signing_key_id'] as string).length).toBeGreaterThan(0);
    expect(typeof state['signing_public_key']).toBe('string');
    expect((state['signing_public_key'] as string).length).toBeGreaterThan(0);

    // …and no private/secret-shaped field or value crossed the boundary.
    expect(state).not.toHaveProperty('signing_private_key');
    expect(state).not.toHaveProperty('private_key');
    expect(state).not.toHaveProperty('access_token');
    expect(state).not.toHaveProperty('matrix_access_token');
    for (const key of Object.keys(state)) {
      expect(key, `AgentState leaked a secret-shaped key '${key}'`).not.toMatch(SECRET_PATTERN);
    }
    expect(JSON.stringify(state)).not.toMatch(SECRET_PATTERN);
  });

  it('agent.list returns [{ agent, liveness }] rows and the registered agent is active', async () => {
    if (!session || !client || room === undefined) throw new Error('session not opened');

    // One raw agent.list call (generous timeout — absorbs any post-register
    // settling), asserting both the row shape the typed view depends on AND that
    // our agent is present + active.
    const rows = (await client.call('agent.list', { room, capabilities: [] }, { timeoutMs: 60_000 })) as unknown[];
    expect(Array.isArray(rows)).toBe(true);
    const row = rows.find(
      (r) =>
        r !== null &&
        typeof r === 'object' &&
        ((r as { agent?: { agent_id?: unknown } }).agent?.agent_id ?? undefined) === session!.agentId,
    ) as { agent?: Record<string, unknown>; liveness?: unknown } | undefined;
    expect(row, 'just-registered agent is absent from agent.list (surface drift)').toBeDefined();
    expect(row?.liveness).toBe('active');
    expect(row?.agent).toMatchObject({ agent_id: session.agentId });

    // The toolbelt's typed path resolves the same to "active" (daemon has settled
    // now that the raw list returned, so this second call is fast).
    const liveness = await session.liveness({ timeoutMs: 30_000 });
    expect(liveness).toBe('active');
  });

  it('an unknown method rejects with a TransportError in the closed code set (error-behavior drift)', async () => {
    if (!client) throw new Error('client not built');
    const err = await client.call('does.not.exist', undefined, { timeoutMs: 30_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    const code = (err as TransportError).code;
    expect(CLOSED_TRANSPORT_CODES).toContain(code);
    // An unknown RPC method is the daemon answering with a JSON-RPC error → `rpc`.
    expect(code).toBe('rpc');
  });

  it('a credential-shaped argument is rejected pre-dispatch with invalid_args (guard intact)', async () => {
    if (!client) throw new Error('client not built');
    // The guard runs BEFORE either transport dispatches — no daemon round-trip.
    const err = await client
      .call('agent.list', { matrix_token: 'value-does-not-matter' }, { timeoutMs: 5_000 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).code).toBe('invalid_args');
  });
});
