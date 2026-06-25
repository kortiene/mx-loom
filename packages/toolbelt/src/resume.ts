/**
 * `resumeSession` — re-establish a cognitive session from durable task state after a
 * runtime restart (T302, design §7). The acceptance criterion: **a
 * killed-and-restarted runtime resumes the plan from task state.**
 *
 * Given the non-secret {@link SessionDescriptor} the prior process persisted,
 * `resumeSession`:
 *
 * 1. **validates** the descriptor (non-secret guard + schema version — fail closed);
 * 2. **re-registers** by opening a session with the *persisted* `room`,
 *    `correlation_id`, and `kind`, plus the runtime's own registration config supplied
 *    via {@link ResumeOptions} (`maxInvocations` — **required by `agent.register` on
 *    v0.2.1** — `capabilities`, `tools`, `workspace`). Those last four are *static
 *    deployment config* the restarting runtime already holds at startup, not session
 *    state, so they ride `ResumeOptions` rather than the descriptor (which stays the
 *    minimal non-secret allowlist). Re-`agent.register` is the **idempotent upsert** the
 *    T005 heartbeat already relies on — `state_rev` advances and no duplicate agent
 *    appears in `agent.list`. Agent-id continuity is best-effort and surfaced honestly
 *    via {@link ResumedSession.resumed} (spec OQ #4): `true` when the daemon re-issues
 *    the same id, otherwise the plan is still recovered **room-keyed** and `false`;
 * 3. **reconstructs the plan** for the descriptor's room into a {@link PlanSnapshot}
 *    (nodes + derived edges + the done/in-flight/ready/blocked reconciliation + a
 *    resumption cursor);
 * 4. returns the live {@link MxSession} + the snapshot.
 *
 * **Continuity without re-dispatch.** Resumption only *re-reads* state and hands it to
 * cognition; it **never re-dispatches** a task's signed `action` (that is T303) and
 * cannot double-execute in-flight work — the reconciliation marks `executing`/`assigned`
 * tasks `inFlight` (observe, do not restart). The cursor lets the resumed session
 * distinguish "already observed" from "new".
 *
 * **Failure modes.** A failed re-register rejects with the underlying `TransportError`
 * and leaves **no** half-open session (the `openSession` no-zombie guarantee is
 * inherited). The plan layer is otherwise total: a `task.list` fault yields an
 * empty-but-valid snapshot carrying the fault code, so a restarted runtime degrades to
 * "no plan recovered" rather than crashing again.
 *
 * **Secret boundary.** The descriptor, the snapshot, and every watch delta carry only
 * non-secret coordination handles; the re-register and reads ride `MxClient`, so the
 * env allowlist + credential guard + inbound redaction stay in force. Resumption grants
 * the runtime **no** authority — a resumed session is exactly as privileged as a fresh
 * one; the receiving daemon still owns trust/policy/approval out-of-process.
 */
import type { MxClient, MxClientOptions } from './client.js';
import type { HeartbeatSchedule } from './heartbeat.js';
import { reconstructPlan, type PlanSnapshot } from './plan-snapshot.js';
import { assertSessionDescriptor, type SessionDescriptor } from './session-descriptor.js';
import { openSession, type MxSession } from './session.js';

export interface ResumeOptions {
  /** An existing client to resume against. If omitted, one is built from {@link clientOptions}. */
  client?: MxClient;
  /** Options for the client built when {@link client} is omitted. */
  clientOptions?: MxClientOptions;
  /** Whether `session.close()` also closes the client (forwarded to `openSession`). */
  ownsClient?: boolean;

  // --- Registration config (the runtime's own static deployment config, NOT session
  // state — these are re-supplied on every startup, so they ride options, not the
  // descriptor). Forwarded verbatim to the re-`agent.register` so it is faithful and
  // not degraded against a live daemon. ---
  /**
   * Agent kind for the re-register. Overrides the descriptor's `kind` when set;
   * otherwise the persisted `kind` is replayed so the upsert is faithful.
   */
  kind?: string;
  /** Advertised capabilities, forwarded to the re-`agent.register` (M0: typically empty). */
  capabilities?: string[];
  /** Served tool surface, forwarded to the re-`agent.register` (M0: typically empty). */
  tools?: unknown[];
  /** Workspace context, forwarded to the re-`agent.register` (`cwd` / `project_id` / `git_commit`). */
  workspace?: { cwd?: string; project_id?: string; git_commit?: string };
  /**
   * Max concurrent invocations — the flat `max_invocations` param **required by
   * `agent.register` on v0.2.1** (`session.ts`). Supply it so the re-register is not
   * degraded; a live daemon would otherwise reject a re-register missing it.
   */
  maxInvocations?: number;

  /** Heartbeat interval in ms (forwarded). */
  heartbeatIntervalMs?: number;
  /** Disable the heartbeat (tests / one-shot resumes). */
  heartbeat?: false;
  /** Injected scheduler (testing seam), forwarded to the session heartbeat. */
  schedule?: HeartbeatSchedule;
  /** Redaction-safe diagnostics sink (forwarded) — non-secret ids + lifecycle only. */
  debug?: (line: string) => void;
}

export interface ResumedSession {
  /** The re-registered session — same room + correlation as before the restart. */
  readonly session: MxSession;
  /** The reconstructed durable plan view (never throws; carries a `fault` code if the read faulted). */
  readonly plan: PlanSnapshot;
  /** `true` iff the daemon re-issued the descriptor's `agent_id`; otherwise room-keyed recovery. */
  readonly resumed: boolean;
}

/**
 * Resume a session from a persisted {@link SessionDescriptor}. See the module doc for
 * the algorithm and guarantees. Rejects only on a failed re-`agent.register` (no
 * zombie session); the plan layer is total.
 */
export async function resumeSession(
  descriptor: SessionDescriptor,
  options: ResumeOptions = {},
): Promise<ResumedSession> {
  // 1. Validate — non-secret guard + schema version (throws invalid_args on a bad
  //    or poisoned descriptor before any I/O). Returns an allowlisted copy.
  const d = assertSessionDescriptor(descriptor);

  // 2. Re-register: open a session with the persisted room, correlation, and kind. A
  //    failed register rejects here, leaving no half-open session (inherited).
  // kind: an explicit option overrides; otherwise replay the persisted kind so the
  // re-register is faithful. The other register params are runtime config (options-only).
  const kind = options.kind ?? d.kind;
  const session = await openSession({
    room: d.room,
    correlationId: d.correlation_id,
    ...(kind !== undefined ? { kind } : {}),
    ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}),
    ...(options.tools !== undefined ? { tools: options.tools } : {}),
    ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
    ...(options.maxInvocations !== undefined ? { maxInvocations: options.maxInvocations } : {}),
    ...(options.client !== undefined ? { client: options.client } : {}),
    ...(options.clientOptions !== undefined ? { clientOptions: options.clientOptions } : {}),
    ...(options.ownsClient !== undefined ? { ownsClient: options.ownsClient } : {}),
    ...(options.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: options.heartbeatIntervalMs } : {}),
    ...(options.heartbeat === false ? { heartbeat: false as const } : {}),
    ...(options.schedule !== undefined ? { schedule: options.schedule } : {}),
    ...(options.debug !== undefined ? { debug: options.debug } : {}),
  });

  // Agent-id continuity is best-effort: true when the daemon re-issued the same id,
  // else the plan is recovered room-keyed and we say so honestly.
  const resumed = session.agentId === d.agent_id;

  // 3. Reconstruct the plan for the descriptor's room. Never throws — a fault yields
  //    an empty-but-valid snapshot. The room comes from the descriptor (session-owned),
  //    never model input.
  const plan = await reconstructPlan(
    (method, params, callOptions) => session.call(method, params, callOptions),
    d.room,
    d.cursor,
  );

  return { session, plan, resumed };
}
