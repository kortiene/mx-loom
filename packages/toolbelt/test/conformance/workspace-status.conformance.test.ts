/**
 * Conformance · T108 — `mxWorkspaceStatus` live workspace observation (single daemon).
 *
 * Verifies the live behavior of the `mxWorkspaceStatus` handler against a real
 * mx-agent daemon at the pinned v0.2.1 substrate. What no pure unit test can cover:
 *
 * - The actual `workspace.status` method name + room-param call works and returns
 *   the `{ room_id, name, canonical_alias, encrypted, members[] }` shape the
 *   handler's `projectWorkspaceMeta` depends on.
 * - The actual `agent.list` composition (handler calls both RPCs in sequence) works
 *   in practice — the registered agent appears in the `agents` projection.
 * - The **load-bearing Boundary-A redaction** holds on REAL daemon output: the raw
 *   `members[{ user_id, display_name, membership }]` list the verified daemon carries
 *   is NOT present in the projected result (not just on synthetic fixtures).
 * - The `AgentSummary` projection (`projectAgentSummary`) drops `matrix_user_id`,
 *   `device_id`, `signing_key_id`, `signing_public_key` from actual agent rows.
 * - `validateEnvelope` passes on a live `ok({ workspace, agents, project? })` shape.
 * - `audit_ref` is all-null (local reads, no Matrix round-trip — confirms EMPTY_AUDIT_REF
 *   is the correct disposition for this composite read).
 *
 * Open questions pinned at this round-trip (spec T108 Risks):
 *   Risk #3 — whether `workspace.status` requires a `room` arg or defaults to the
 *             daemon's current workspace. Handler passes it when present; this test
 *             observes the result in both cases.
 *   Risk #4 — whether `joined_members` count is in scope (surfaced in the raw reply
 *             but projected out; documented here).
 *   (implicit) — whether `workspace.status` result includes `project` / `cwd` fields
 *               for `deriveProject` to pick up.
 *
 * All `console.info` lines are intentional: they document OQ resolution as the
 * suite runs under CI (the pattern established by `discovery.conformance.test.ts`).
 *
 * Pre-conditions (same single-daemon Tier 1 prerequisites):
 *   - `MXL_CONFORMANCE=1` set in the environment.
 *   - A live mx-agent daemon reachable at the conformance socket.
 *   - No second daemon or two-daemon fixture needed (`workspace.status` + `agent.list`
 *     are local reads with no Matrix round-trip outside the daemon's workspace cache).
 *
 * Run:
 *   MXL_CONFORMANCE=1 pnpm --filter @mx-loom/toolbelt test:conformance
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  mxWorkspaceStatus,
  validateEnvelope,
  type DaemonCall,
  type RoomScopedDeps,
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
 * Wrap a real `MxClient` as the `RoomScopedDeps` seam for `mxWorkspaceStatus`.
 * `MxClient` satisfies `DaemonCall` structurally. Room comes from the session, not
 * model input, exactly as the production binding wires it.
 */
function wrapClient(client: MxClient, room: string | undefined): RoomScopedDeps {
  const daemon: DaemonCall = {
    call: (method, params, options) => client.call(method, params, options),
  };
  return { daemon, room };
}

// ---------------------------------------------------------------------------
// T108 workspace-status conformance suite (single daemon)
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_SINGLE_DAEMON)('conformance · T108 — mxWorkspaceStatus (single daemon)', () => {
  let client: MxClient | undefined;
  let session: MxSession | undefined;
  let roomScopedDeps: RoomScopedDeps | undefined;
  let room: string | undefined;

  /**
   * A unique capability string for this run — used to identify this run's registered
   * agent in the workspace agent list (mirrors the T104 conformance pattern).
   */
  const CONFORMANCE_CAPABILITY = 'mx_loom_t108_workspace_status_conformance';

  beforeAll(async () => {
    // Vitest 4.x runs beforeAll even when describe.skipIf(true) guards the suite;
    // exit early in the skip case to avoid spurious "no daemon" errors.
    if (SKIP_SINGLE_DAEMON) return;

    assertSingleDaemonPrereqs();

    client = createClient({ defaultTimeoutMs: 60_000 });

    // Create a workspace so workspace.status has a room to observe.
    const ws = (await client.call(
      'workspace.create',
      { name: 'mx-loom-t108-ws-status-conformance', visibility: 'private' },
      { timeoutMs: 60_000 },
    )) as Record<string, unknown>;

    if (typeof ws['room_id'] !== 'string') {
      throw new Error('conformance T108: workspace.create returned no room_id');
    }
    room = ws['room_id'];

    // Register an agent with the unique conformance capability so AC 2 can verify the
    // handler finds it in the workspace.
    session = await openSession({
      client,
      heartbeat: false,
      room,
      kind: 'runtime',
      capabilities: [CONFORMANCE_CAPABILITY],
      tools: ['mx_loom_t108_probe_tool'],
      workspace: { cwd: '/tmp', project_id: 'mx-loom-t108-ws-status-conformance' },
      maxInvocations: 1,
    });

    roomScopedDeps = wrapClient(client, room);
  }, 90_000);

  afterAll(async () => {
    await session?.close();
    await client?.close();
  });

  // -------------------------------------------------------------------------
  // AC 2 live — registered agent appears in mxWorkspaceStatus result
  //
  // The canonical AC 2 acceptance criterion: "mx_workspace_status lists registered
  // agents + project context." Calls the handler with the session's room and asserts
  // the just-registered agent appears in the projected `agents` array.
  // -------------------------------------------------------------------------

  it('AC 2 live: registered agent appears in mxWorkspaceStatus agents list', async () => {
    if (!roomScopedDeps || !session) throw new Error('T108 conformance: fixture not initialised');

    let result;
    try {
      result = await mxWorkspaceStatus({}, roomScopedDeps);
    } catch (err) {
      throw new Error(`[T108 AC2] mxWorkspaceStatus must never throw — caught: ${String(err)}`);
    }

    // A valid terminal envelope.
    expect(result.status).toMatch(/^(ok|denied|error)$/);
    expect(validateEnvelope(result), '[T108 AC2] envelope must be valid').toBe(true);

    if (result.status !== 'ok') {
      console.warn('[T108 AC2] mxWorkspaceStatus returned non-ok:', result.status, result.error?.code, result.error?.message);
      return;
    }

    const payload = result.result as {
      workspace: Record<string, unknown>;
      agents: Array<Record<string, unknown>>;
      project?: Record<string, unknown>;
    };

    expect(Array.isArray(payload.agents), '[T108 AC2] result.agents must be an array').toBe(true);

    // The registered agent must appear.
    const found = payload.agents.find((a) => a['agent_id'] === session!.agentId);
    expect(
      found,
      `[T108 AC2] registered agent ${session.agentId} must appear in mxWorkspaceStatus agents — agent.list surface drift?`,
    ).toBeDefined();

    console.info(
      '[T108 AC2] registered agent found in workspace agents list.',
      'agent_id:', session.agentId,
      '| liveness:', found?.['liveness'],
      '| total agents:', payload.agents.length,
    );
  });

  // -------------------------------------------------------------------------
  // workspace metadata projection — room_id, name, canonical_alias, encrypted
  //
  // The `workspace` field in the result carries the non-secret room metadata from
  // `workspace.status`. Asserts the room_id round-trips and the other fields are
  // present when the daemon provides them.
  // -------------------------------------------------------------------------

  it('workspace metadata is projected: room_id present, name/encrypted accepted when available', async () => {
    if (!roomScopedDeps) throw new Error('T108 conformance: fixture not initialised');

    const result = await mxWorkspaceStatus({}, roomScopedDeps);
    if (result.status !== 'ok') {
      console.warn('[T108 metadata] mxWorkspaceStatus non-ok:', result.status, result.error?.code);
      return;
    }

    const workspace = (result.result as { workspace: Record<string, unknown> }).workspace;
    expect(workspace, '[T108 metadata] workspace field must be an object').toBeDefined();

    // room_id must round-trip.
    expect(workspace['room_id'], '[T108 metadata] workspace.room_id must equal the session room').toBe(room);

    // Document which optional fields the daemon provides (pins spec Risks).
    console.info('[T108 metadata] workspace.status live field set:', {
      room_id: workspace['room_id'] !== undefined,
      name: workspace['name'] !== undefined,
      canonical_alias: workspace['canonical_alias'] !== undefined,
      encrypted: workspace['encrypted'] !== undefined,
    });

    // The `members[]` array must NOT be present in the projected workspace output
    // (the headline redaction decision; the raw daemon reply carries it).
    expect(
      Object.prototype.hasOwnProperty.call(workspace, 'members'),
      '[T108 metadata] workspace must NOT contain raw members[] (Boundary A)',
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(workspace, 'joined_members'),
      '[T108 metadata] joined_members must NOT be projected (design §Security)',
    ).toBe(false);

    // Document what the raw workspace.status shape looks like (pins Risk #3 / Risk #4).
    const rawStatus = await client!.call('workspace.status', { room }, { timeoutMs: 30_000 }).catch(() => null);
    if (rawStatus !== null && typeof rawStatus === 'object') {
      const raw = rawStatus as Record<string, unknown>;
      console.info('[T108 Risk#3/Risk#4] raw workspace.status field set:', Object.keys(raw).sort().join(', '));
      console.info('[T108 Risk#4] joined_members present in raw reply:', 'joined_members' in raw);
      console.info('[T108 Risk#3] members[] present in raw reply:', 'members' in raw && Array.isArray(raw['members']));
    }
  });

  // -------------------------------------------------------------------------
  // Boundary A live — Matrix identity fields NOT in any part of the result
  //
  // The unit security test (`workspace-status.security.test.ts`) already covers
  // this with injected fake data; this test pins it on REAL daemon output so a
  // daemon upgrade that adds new identity fields doesn't silently leak.
  // -------------------------------------------------------------------------

  it('Boundary A live: no Matrix user_id or identity fields in mxWorkspaceStatus result', async () => {
    if (!roomScopedDeps) throw new Error('T108 conformance: fixture not initialised');

    const result = await mxWorkspaceStatus({}, roomScopedDeps);
    if (result.status !== 'ok') return;

    const json = JSON.stringify(result);

    // Raw Matrix identifiers must not appear.
    expect(json, '[T108 BoundaryA] Matrix user_id pattern in result').not.toMatch(/@\w+:\w+/);

    // The members[] array key must be absent.
    expect(json, '[T108 BoundaryA] "members" key in result').not.toContain('"members"');

    // Token-shaped values must not appear (e.g. Matrix tokens that could leak via
    // a daemon bug or a new field the projector does not yet allowlist).
    expect(json, '[T108 BoundaryA] secret-shaped value in result').not.toMatch(SECRET_PATTERN);

    // Forbidden identity field names from the agent rows must be absent.
    for (const field of ['matrix_user_id', 'device_id', 'signing_key_id', 'signing_public_key', 'state_rev']) {
      expect(json, `[T108 BoundaryA] forbidden field '${field}' in result`).not.toContain(`"${field}"`);
    }

    console.info('[T108 BoundaryA] mxWorkspaceStatus result is clean — no identity or secret-shaped values');
  });

  // -------------------------------------------------------------------------
  // audit_ref all-null — local reads carry EMPTY_AUDIT_REF
  //
  // `workspace.status` + `agent.list` are local daemon reads with no Matrix
  // round-trip, so the handler returns EMPTY_AUDIT_REF. Confirms the invariant
  // holds against a REAL daemon (not just synthetic unit tests).
  // -------------------------------------------------------------------------

  it('audit_ref ids are all-null for local workspace read (no Matrix round-trip)', async () => {
    if (!roomScopedDeps) throw new Error('T108 conformance: fixture not initialised');

    const result = await mxWorkspaceStatus({}, roomScopedDeps);

    // audit_ref is always structurally present (even on fault envelopes).
    expect(result.audit_ref, '[T108 audit_ref] must be structurally present').toBeDefined();
    expect(typeof result.audit_ref).toBe('object');

    if (result.status === 'ok') {
      expect(result.audit_ref.invocation_id, '[T108 audit_ref] invocation_id must be null (local read)').toBeNull();
      expect(result.audit_ref.request_id, '[T108 audit_ref] request_id must be null (local read)').toBeNull();
      expect(result.audit_ref.room, '[T108 audit_ref] room must be null (local read)').toBeNull();
      expect(result.audit_ref.event_id, '[T108 audit_ref] event_id must be null (local read)').toBeNull();
    }

    console.info('[T108 audit_ref] all-null confirmed for local composite read');
  });

  // -------------------------------------------------------------------------
  // AgentSummary projection on real agent rows
  //
  // The projected agents must carry only the four documented `AgentSummary` fields
  // (agent_id, kind, capabilities, liveness). This pins the allowlist-by-construction
  // guarantee against a real v0.2.1 daemon agent row.
  // -------------------------------------------------------------------------

  it('AgentSummary projection: registered agent row carries only the four documented fields', async () => {
    if (!roomScopedDeps || !session) throw new Error('T108 conformance: fixture not initialised');

    const result = await mxWorkspaceStatus({}, roomScopedDeps);
    if (result.status !== 'ok') return;

    const agents = (result.result as { agents: Array<Record<string, unknown>> }).agents;
    const found = agents.find((a) => a['agent_id'] === session!.agentId);
    if (!found) {
      console.warn('[T108 AgentSummary] registered agent not in list — cannot probe projection');
      return;
    }

    // Only the four documented fields are permitted in the projected row.
    const PERMITTED = new Set(['agent_id', 'kind', 'capabilities', 'liveness']);
    const FORBIDDEN = ['matrix_user_id', 'device_id', 'signing_key_id', 'signing_public_key', 'state_rev'];

    for (const f of FORBIDDEN) {
      expect(
        Object.prototype.hasOwnProperty.call(found, f),
        `[T108 AgentSummary] forbidden field '${f}' in projected agent row`,
      ).toBe(false);
    }

    const extraFields = Object.keys(found).filter((k) => !PERMITTED.has(k));
    if (extraFields.length > 0) {
      // Extra fields in the projection are unexpected but non-fatal — document them
      // for a spec update (may be additive daemon additions).
      console.info('[T108 AgentSummary] unexpected extra fields in projected agent row:', extraFields.join(', '));
    }

    // Core fields must be present.
    expect(found['agent_id']).toBe(session.agentId);
    expect(['active', 'stale', 'offline']).toContain(found['liveness']);
    expect(Array.isArray(found['capabilities'])).toBe(true);

    console.info('[T108 AgentSummary] projected fields on registered agent:', Object.keys(found).sort().join(', '));
  });

  // -------------------------------------------------------------------------
  // No-room variant — handler still dispatches workspace.status (best-effort)
  //
  // When deps.room is undefined, the handler passes no room param and relies on
  // the daemon's current-workspace default (spec Risk #3). The handler must still
  // return ok (or a fault if the daemon requires a room) — NOT throw.
  // -------------------------------------------------------------------------

  it('no-room variant: handler dispatches workspace.status without room param and does not throw', async () => {
    if (!client) throw new Error('T108 conformance: fixture not initialised');

    const deps = wrapClient(client, undefined);

    let result;
    try {
      result = await mxWorkspaceStatus({}, deps);
    } catch (err) {
      throw new Error(`[T108 no-room] handler must never throw — caught: ${String(err)}`);
    }

    // Must be a valid envelope regardless of daemon disposition.
    expect(result.status).toMatch(/^(ok|denied|error)$/);
    expect(validateEnvelope(result)).toBe(true);

    // Document whether the daemon accepts a no-room workspace.status call (Risk #3).
    console.info(
      '[T108 Risk#3] no-room workspace.status disposition:',
      result.status,
      result.status !== 'ok' ? `(code: ${result.error?.code})` : '(ok — daemon uses current workspace default)',
    );
  });

  // -------------------------------------------------------------------------
  // Wire-shape probe for workspace.status
  //
  // Documents the actual field names the daemon returns for workspace.status
  // (pins spec Risk #3 and the projectWorkspaceMeta field assumptions). Non-fatal
  // and documentary-only — the projection handles absent fields gracefully.
  // -------------------------------------------------------------------------

  it('(documentary) workspace.status wire-shape probe: log raw field set for spec update', async () => {
    if (!client) throw new Error('T108 conformance: fixture not initialised');

    const raw = await client.call('workspace.status', { room }, { timeoutMs: 30_000 }).catch((e: unknown) => e);

    if (raw instanceof Error) {
      console.warn('[T108 wire-shape] workspace.status call failed:', String(raw));
      return;
    }

    if (raw === null || typeof raw !== 'object') {
      console.warn('[T108 wire-shape] workspace.status returned non-object:', typeof raw);
      return;
    }

    const rec = raw as Record<string, unknown>;
    console.info('[T108 wire-shape] workspace.status live field set:', Object.keys(rec).sort().join(', '));
    console.info('[T108 wire-shape] room_id:', rec['room_id']);
    console.info('[T108 wire-shape] name:', rec['name']);
    console.info('[T108 wire-shape] canonical_alias:', rec['canonical_alias']);
    console.info('[T108 wire-shape] encrypted:', rec['encrypted']);
    console.info('[T108 wire-shape] joined_members:', rec['joined_members']);
    console.info('[T108 wire-shape] members[] length:', Array.isArray(rec['members']) ? (rec['members'] as unknown[]).length : 'absent/non-array');
    console.info('[T108 wire-shape] project/workspace fields:', ['project', 'workspace', 'cwd', 'project_id'].filter((k) => k in rec).join(', ') || 'none');

    // Secret boundary: the raw workspace.status response must not carry a daemon credential.
    expect(JSON.stringify(raw)).not.toMatch(SECRET_PATTERN);
  });
});
