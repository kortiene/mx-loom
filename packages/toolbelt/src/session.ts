/**
 * `MxSession` — the runtime-conversation ⇄ agent-registration handle (T005, design §7).
 *
 * T004's `MxClient` knows how to reach the daemon but is *stateless*: it does not
 * know *who* it is reaching as, in which workspace, or under what correlation
 * identity. `MxSession` layers that on top **without** touching the wire
 * protocol, the transports, or the daemon's authority surface. It:
 *
 * - **Registers on start.** {@link openSession} calls `agent.register` exactly
 *   once through the underlying client, captures the returned `AgentState`, and
 *   exposes `agentId` (AC 1 — the agent becomes visible via `agent.list`).
 * - **Keeps liveness `active`.** A cancellable heartbeat refreshes `last_seen_ts`
 *   on an interval shorter than the daemon's staleness window (AC 2).
 * - **Threads a `correlation_id`.** Every call the session issues is stamped with
 *   one session-stable id on the diagnostics seam (AC 3); param injection is
 *   gated on daemon verification (default off — see `correlation.ts`).
 * - **Deregisters / decays on close.** {@link MxSession.close} stops the
 *   heartbeat and either calls a confirmed deregister method or simply lets
 *   liveness decay to `stale`/`offline` (AC 2, second clause).
 *
 * It **composes** `MxClient` rather than replacing it: every outbound call goes
 * through `client.call`, so the hoisted credential guard
 * (`assertNoCredentialShapedArgs`) runs on `agent.register` and every heartbeat
 * tick, transport selection/retry are reused, and no secret env surface is
 * added (design §6). Registration is toolbelt-run **lifecycle**, never a
 * model-facing `mx_*` authority tool.
 *
 * Gated decisions (defaulted to the verified-safe choice; each a one-line swap
 * once a live v0.2.1 check confirms the surface — see the spec's *Risks*):
 * - **Heartbeat refresh** defaults to idempotent re-`agent.register` (the one
 *   method verified to succeed; `state_rev` implies a versioned upsert). Swap via
 *   {@link MxSessionOptions.heartbeatMethod} if a dedicated `agent.heartbeat`
 *   exists.
 * - **Deregister** defaults to decay (no method called). Set
 *   {@link MxSessionOptions.deregisterMethod} once a deregister RPC is confirmed.
 * - **Correlation param propagation** defaults to off
 *   ({@link MxSessionOptions.correlationParamMethods} empty).
 */
import { createClient } from './client.js';
import type { MxClient, MxClientOptions } from './client.js';
import { newCorrelationId, withCorrelationParam } from './correlation.js';
import { startHeartbeat } from './heartbeat.js';
import type { HeartbeatHandle, HeartbeatSchedule } from './heartbeat.js';
import { TransportError } from './transport.js';
import type { CallOptions } from './transport.js';
import type { AgentLiveness, AgentState } from './agent-state.js';
import { assertSessionDescriptor } from './session-descriptor.js';
import type { SessionDescriptor, TaskCursor } from './session-descriptor.js';

/** Session lifecycle states. */
export type SessionState = 'opening' | 'active' | 'closing' | 'closed';

/** Daemon method names used by the session (all pre-existing on the daemon). */
const REGISTER_METHOD = 'agent.register';
const LIST_METHOD = 'agent.list';

/** Conservative default heartbeat interval (ms): shorter than the (undocumented) staleness window. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * The session handle. The single chokepoint for outbound calls during its
 * lifetime: callers use {@link MxSession.call} rather than the bare client, so
 * correlation threading is automatic and uniform.
 */
export interface MxSession {
  /** Registered agent id, captured from `agent.register` → `AgentState.agent_id`. */
  readonly agentId: string;
  /** Full agent record captured at registration (`state_rev`/`last_seen_ts` for T302/T501). */
  readonly agentState: Readonly<AgentState>;
  /** Workspace/room this session is scoped to (carried for T501; not enforced here). */
  readonly room: string | undefined;
  /** Session-stable correlation id, stamped on every outbound call. */
  readonly correlationId: string;
  /** Lifecycle state. */
  readonly state: SessionState;

  /** Issue a daemon RPC through the session — threads `correlation_id`, delegates to the client. */
  call(method: string, params?: unknown, options?: CallOptions): Promise<unknown>;
  /** Liveness of THIS agent as reported by `agent.list` (`active|stale|offline`), or `offline` if absent. */
  liveness(options?: CallOptions): Promise<AgentLiveness>;
  /**
   * Mint a **non-secret** {@link SessionDescriptor} from this live session so the host
   * can persist it before a planned shutdown and hand it to `resumeSession` on restart
   * (T302). Carries only `agent_id` / `room` / `correlation_id` / `kind` (+ the supplied
   * resumption `cursor`); never any token or key. Requires a registered session with a
   * room (the resumption key) — throws otherwise.
   */
  describe(cursor?: TaskCursor): SessionDescriptor;
  /** Stop the heartbeat and deregister (or let liveness decay). Idempotent. */
  close(): Promise<void>;
}

export interface MxSessionOptions {
  /** An existing client to use. If omitted, one is built from {@link clientOptions} via `createClient`. */
  client?: MxClient;
  /** Options for the client built when {@link client} is omitted. */
  clientOptions?: MxClientOptions;
  /** Whether `close()` also closes the client. Default: `true` when the session built the client, else `false`. */
  ownsClient?: boolean;

  /** Workspace/room to register into (forwarded to `agent.register` per the confirmed param shape). */
  room?: string;
  /** Agent kind (M0: typically minimal — the runtime is a consumer). */
  kind?: string;
  /** Advertised capabilities (M0: typically empty). */
  capabilities?: string[];
  /** Served tool surface (M0: typically empty — publishing served tools is later work). */
  tools?: unknown[];
  /**
   * Workspace context forwarded to `agent.register`. v0.2.1 daemon expects these
   * as **flat** top-level params (`cwd`, `project_id`, `git_commit`) — `buildRegisterParams`
   * flattens them; the response nests them back under `AgentState.workspace`.
   */
  workspace?: { cwd?: string; project_id?: string; git_commit?: string };
  /**
   * Max concurrent invocations this agent accepts. Maps to the flat `max_invocations`
   * param required by `agent.register` on v0.2.1.
   */
  maxInvocations?: number;

  /** Pre-supplied correlation id (else a fresh `corr_<uuid>` is generated). */
  correlationId?: string;
  /**
   * Methods confirmed to accept a `correlation_id` in their params — the id is
   * injected into outbound params only for these. Default: `[]` (toolbelt-side
   * diagnostics stamping only; substrate propagation gated on daemon support).
   */
  correlationParamMethods?: readonly string[];

  /** Heartbeat interval in ms. Default: {@link DEFAULT_HEARTBEAT_INTERVAL_MS}. */
  heartbeatIntervalMs?: number;
  /** Disable the heartbeat entirely (tests / one-shot sessions). Default: `false`. */
  heartbeat?: false;
  /**
   * Daemon method a heartbeat tick calls to refresh liveness. Default:
   * `'agent.register'` (idempotent re-register — the verified-good upsert).
   * Set to a dedicated `'agent.heartbeat'`/`'agent.touch'` once confirmed.
   */
  heartbeatMethod?: string;
  /**
   * Deregister method called on `close()`. Default: `undefined` → no call; with
   * the heartbeat stopped, liveness decays to `stale`/`offline` on its own (the
   * AC permits "goes stale"). Set once a deregister RPC is confirmed on v0.2.1.
   */
  deregisterMethod?: string;

  /** Injected scheduler (testing seam), mirroring `retry.ts`/`heartbeat.ts`. */
  schedule?: HeartbeatSchedule;
  /**
   * Redaction-safe diagnostics sink. Receives lines carrying ONLY `agentId`
   * (non-secret), `room`, `correlationId`, lifecycle state, an error `code`, and
   * the method name — never params, env values, `AgentState` key material,
   * tokens, or raw transport output. Default: a no-op.
   */
  debug?: (line: string) => void;
}

/**
 * Build the `agent.register` params from the options, omitting absent fields.
 *
 * v0.2.1 verified: workspace context fields are **flat** top-level params
 * (`cwd`, `project_id`, `git_commit`) — the daemon does NOT accept a nested
 * `workspace` object in the request even though it returns one in the response
 * (confirmed by T005 live-daemon e2e probe).
 */
function buildRegisterParams(o: MxSessionOptions): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (o.room !== undefined) params['room'] = o.room;
  if (o.kind !== undefined) params['kind'] = o.kind;
  if (o.capabilities !== undefined) params['capabilities'] = o.capabilities;
  if (o.tools !== undefined) params['tools'] = o.tools;
  if (o.workspace !== undefined) {
    if (o.workspace.cwd !== undefined) params['cwd'] = o.workspace.cwd;
    if (o.workspace.project_id !== undefined) params['project_id'] = o.workspace.project_id;
    if (o.workspace.git_commit !== undefined) params['git_commit'] = o.workspace.git_commit;
  }
  if (o.maxInvocations !== undefined) params['max_invocations'] = o.maxInvocations;
  return params;
}

/** Narrow the `agent.register` result to an {@link AgentState}, asserting a usable `agent_id`. */
function parseAgentState(result: unknown): AgentState {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new TransportError('protocol', 'agent.register did not return an AgentState object');
  }
  const agentId = (result as { agent_id?: unknown }).agent_id;
  if (typeof agentId !== 'string' || agentId.length === 0) {
    throw new TransportError('protocol', 'agent.register returned no agent_id');
  }
  return result as AgentState;
}

/** Find THIS agent's liveness in an `agent.list` result; `offline` if absent or unparseable. */
function livenessFor(list: unknown, agentId: string): AgentLiveness {
  if (!Array.isArray(list)) return 'offline';
  for (const row of list) {
    if (row === null || typeof row !== 'object') continue;
    const agent = (row as { agent?: unknown }).agent;
    if (agent === null || typeof agent !== 'object') continue;
    if ((agent as { agent_id?: unknown }).agent_id !== agentId) continue;
    const liveness = (row as { liveness?: unknown }).liveness;
    return liveness === 'active' || liveness === 'stale' || liveness === 'offline' ? liveness : 'offline';
  }
  return 'offline';
}

function codeOf(err: unknown): string {
  return err instanceof TransportError ? err.code : 'internal';
}

class MxSessionImpl implements MxSession {
  readonly #client: MxClient;
  readonly #ownsClient: boolean;
  readonly #correlationId: string;
  readonly #correlationParamMethods: readonly string[];
  readonly #registerParams: Record<string, unknown>;
  readonly #heartbeatEnabled: boolean;
  readonly #heartbeatIntervalMs: number;
  readonly #heartbeatMethod: string;
  readonly #deregisterMethod: string | undefined;
  readonly #schedule: HeartbeatSchedule | undefined;
  readonly #debug: (line: string) => void;
  readonly #room: string | undefined;

  #state: SessionState = 'opening';
  #agentState: AgentState | null = null;
  #heartbeat: HeartbeatHandle | null = null;

  constructor(client: MxClient, ownsClient: boolean, options: MxSessionOptions) {
    this.#client = client;
    this.#ownsClient = ownsClient;
    this.#correlationId = options.correlationId ?? newCorrelationId();
    this.#correlationParamMethods = options.correlationParamMethods ?? [];
    this.#registerParams = buildRegisterParams(options);
    this.#heartbeatEnabled = options.heartbeat !== false;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.#heartbeatMethod = options.heartbeatMethod ?? REGISTER_METHOD;
    this.#deregisterMethod = options.deregisterMethod;
    this.#schedule = options.schedule;
    this.#debug = options.debug ?? ((): void => {});
    this.#room = options.room;
  }

  get agentId(): string {
    if (this.#agentState === null) throw new Error('session is not registered yet');
    return this.#agentState.agent_id;
  }

  get agentState(): Readonly<AgentState> {
    if (this.#agentState === null) throw new Error('session is not registered yet');
    return this.#agentState;
  }

  get room(): string | undefined {
    return this.#room;
  }

  get correlationId(): string {
    return this.#correlationId;
  }

  get state(): SessionState {
    return this.#state;
  }

  /** Register the agent and start the heartbeat. Called once by {@link openSession}. */
  async start(): Promise<void> {
    const result = await this.call(REGISTER_METHOD, this.#registerParams);
    this.#agentState = parseAgentState(result);
    this.#debug(`open agent=${this.#agentState.agent_id} room=${this.#room ?? ''} corr=${this.#correlationId}`);
    if (this.#heartbeatEnabled) this.#startHeartbeat();
    this.#state = 'active';
  }

  async call(method: string, params?: unknown, options?: CallOptions): Promise<unknown> {
    // AC 3: every outbound call is stamped with the session correlation id on
    // the diagnostics seam (always), and injected into params only for the
    // confirmed-accepted allowlist (default empty).
    this.#debug(`call ${method} corr=${this.#correlationId}`);
    const outParams = this.#correlationParamMethods.includes(method)
      ? withCorrelationParam(params, this.#correlationId)
      : params;
    return await this.#client.call(method, outParams, options);
  }

  async liveness(options?: CallOptions): Promise<AgentLiveness> {
    // v0.2.1: agent.list requires { room, capabilities } — passing room when the
    // session has one, and an empty capabilities filter to list all agents.
    const listParams: Record<string, unknown> = { capabilities: [] };
    if (this.#room !== undefined) listParams['room'] = this.#room;
    const list = await this.call(LIST_METHOD, listParams, options);
    return livenessFor(list, this.agentId);
  }

  describe(cursor?: TaskCursor): SessionDescriptor {
    if (this.#agentState === null) throw new Error('session is not registered yet');
    if (this.#room === undefined || this.#room === '') {
      throw new Error('cannot describe a session without a room (the resumption key)');
    }
    // The registered kind round-trips back in AgentState; only carry it when non-empty.
    const kind = this.#agentState.kind;
    // Build through the validator so the result is allowlisted + provably non-secret.
    return assertSessionDescriptor({
      v: 1,
      agent_id: this.#agentState.agent_id,
      room: this.#room,
      correlation_id: this.#correlationId,
      ...(typeof kind === 'string' && kind !== '' ? { kind } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    });
  }

  async close(): Promise<void> {
    if (this.#state === 'closing' || this.#state === 'closed') return;
    this.#state = 'closing';

    this.#heartbeat?.stop();
    this.#heartbeat = null;

    // Deregister-or-decay: call a confirmed deregister method if configured;
    // otherwise stopping the heartbeat lets `last_seen_ts` age out so liveness
    // decays on its own. A deregister failure is logged, never thrown — close
    // must always complete.
    if (this.#deregisterMethod !== undefined && this.#agentState !== null) {
      try {
        await this.call(this.#deregisterMethod, { agent_id: this.#agentState.agent_id });
      } catch (err) {
        this.#debug(`deregister failed code=${codeOf(err)}`);
      }
    }

    this.#debug(`close agent=${this.#agentState?.agent_id ?? ''}`);
    if (this.#ownsClient) await this.#client.close();
    this.#state = 'closed';
  }

  #startHeartbeat(): void {
    this.#heartbeat = startHeartbeat({
      intervalMs: this.#heartbeatIntervalMs,
      ...(this.#schedule ? { schedule: this.#schedule } : {}),
      tick: () => this.#heartbeatTick(),
      onTick: (outcome) => {
        this.#debug(outcome === 'ok' ? 'heartbeat ok' : `heartbeat ${outcome.code}`);
      },
    });
  }

  /**
   * One heartbeat tick. Defaults to idempotent re-`agent.register` (reusing the
   * registration params); a dedicated method gets a minimal `{ agent_id }`. The
   * call rides through {@link call}, so it inherits the credential guard,
   * correlation stamping, and the client's conservative retry. Bounded to the
   * interval so a tick can never outlive its slot.
   */
  async #heartbeatTick(): Promise<void> {
    const params =
      this.#heartbeatMethod === REGISTER_METHOD ? this.#registerParams : { agent_id: this.agentId };
    await this.call(this.#heartbeatMethod, params, { timeoutMs: this.#heartbeatIntervalMs });
  }
}

/**
 * Open a session: construct/resolve the client, register the agent
 * (`agent.register`), start the heartbeat, and return the active handle. Mirrors
 * T004's `createClient()` ergonomics.
 *
 * ```ts
 * const s = await openSession();   // builds its own client; registers an agent
 * await s.call('agent.list');      // correlation-stamped, credential-guarded
 * await s.close();                 // stops the heartbeat; deregisters or decays
 * ```
 *
 * A failed `agent.register` rejects with the underlying `TransportError`,
 * starts **no** heartbeat, and leaves no half-open session (a self-built client
 * is closed before the error propagates).
 */
export async function openSession(options: MxSessionOptions = {}): Promise<MxSession> {
  const usingInjected = options.client !== undefined;
  const ownsClient = options.ownsClient ?? !usingInjected;
  const client = options.client ?? createClient(options.clientOptions);

  const session = new MxSessionImpl(client, ownsClient, options);
  try {
    await session.start();
  } catch (err) {
    // No partial/zombie session: drop a self-built client before surfacing.
    if (ownsClient) await client.close().catch(() => undefined);
    throw err;
  }
  return session;
}
