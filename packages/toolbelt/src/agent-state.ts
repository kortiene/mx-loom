/**
 * Typed view of the daemon's agent records (T005).
 *
 * These are TypeScript types over **already-existing** daemon payloads — not a
 * protocol change. They mirror the `com.mxagent.agent.v1` shape verified live in
 * [`docs/mx-agent-surface-v0.2.1.md`](../../../docs/mx-agent-surface-v0.2.1.md)
 * (T001): `agent.register` returns a full {@link AgentState}, and `agent.list`
 * returns rows of `{ agent, liveness }` ({@link AgentListEntry}).
 *
 * Secret boundary: `AgentState` exposes only the **public** `signing_public_key`
 * / `signing_key_id` — never the private Ed25519 key, Matrix tokens, or device
 * secrets, which stay daemon-held (design §6). The session captures this state
 * but must not log or persist these fields beyond ordinary non-secret
 * identifiers (`agent_id`, `room`, lifecycle state).
 */

/** Per-agent liveness `agent.list` derives from `last_seen_ts`. */
export type AgentLiveness = 'active' | 'stale' | 'offline';

/**
 * The agent record returned by `agent.register` and embedded in each
 * `agent.list` row (`com.mxagent.agent.v1`). Field-for-field with design §2 and
 * the verified v0.2.1 surface.
 */
export interface AgentState {
  agent_id: string;
  kind: string;
  matrix_user_id: string;
  device_id: string;
  /** Public key identifier, e.g. `mxagent-ed25519:…` — non-secret. */
  signing_key_id: string;
  /** base64 Ed25519 **public** key — non-secret (the private key never leaves the daemon). */
  signing_public_key: string;
  status: string;
  capabilities: string[];
  tools: unknown[];
  workspace: { cwd?: string; project_id?: string; git_commit?: string };
  load: { running_invocations: number; max_invocations: number };
  /** Last-seen wall-clock the daemon derives liveness from. */
  last_seen_ts: number;
  /** Monotonic version of the agent record — implies `agent.register` is an idempotent upsert. */
  state_rev: number;
}

/** One row of `agent.list`: an {@link AgentState} plus its derived {@link AgentLiveness}. */
export interface AgentListEntry {
  agent: AgentState;
  liveness: AgentLiveness;
}
