/**
 * The GOLDEN end-to-end harness (T114 / #22) — env-flag gating, fixture
 * coordinates, the live-fixture builders for both binding arms, and the
 * out-of-band operator-decision driver.
 *
 * This is NOT a test file (leading underscore, no `.test.ts` suffix) so vitest
 * never collects it as a suite. The gate logic itself is pure / injectable so it
 * is unit-testable daemon-free — see `golden-harness.test.ts`, which runs in the
 * fast default suite.
 *
 * Wire model for an arm (both arms share it; only the binding factory differs):
 *
 *   scripted cognition → BINDING → BindingContext
 *        → real MxClient → daemon A Unix socket → daemon A → daemon B
 *        ↑                                                       │
 *        └── envelope (status / handle / approval / audit_ref) ──┘
 *
 *   operator (out-of-band, NEVER a model tool):
 *        decide-approval.sh → mx-agent approval approve|deny → daemon B
 *
 * The room ALWAYS comes from the `BindingContext` (the workspace the session
 * joined), never from a model arg. The operator decision is issued by a separate
 * CLI against daemon B — `approval.decide` / `trust.*` / `policy.*` are operator
 * authority and are structurally absent from the model tool set; this harness
 * simulates the human, it does not grant the model the power to approve.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AuditSink } from '@mx-loom/audit';
import {
  createMxCanUseTool,
  createMxToolServer,
  mxToolName,
} from '@mx-loom/claude';
import type {
  ApprovalSummary,
  CreateMxToolServerOptions,
  OnApprovalRequest,
} from '@mx-loom/claude';
import type { BindingContext } from '@mx-loom/mcp';
import { createMcpServer } from '@mx-loom/mcp';
import { createPiBindingContext, createPiToolDefinitions } from '@mx-loom/pi';
import type {
  BindingContext as PiBindingContext,
  ToolDefinition as PiToolDefinition,
  TypeBoxBuilders,
} from '@mx-loom/pi';
import type { DaemonCall, ToolResult } from '@mx-loom/registry';
import { createClient } from '@mx-loom/toolbelt';
import type { MxClient } from '@mx-loom/toolbelt';

import { INLINE_FAKE_BUILDERS } from './_pi-builders.js';
import type { GoldenStep, ScenarioCoords } from './scenario.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Env flags (mirror the conformance harness; replicated to avoid cross-test-dir
// imports that are not on any package exports surface).
// ---------------------------------------------------------------------------

/** `MXL_CONFORMANCE_TWO_DAEMON=1` — the two-daemon fixture is up. */
export function isTwoDaemonRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['MXL_CONFORMANCE_TWO_DAEMON'] === '1';
}

/** `MXL_CONFORMANCE_GOLDEN_POLICY=1` — daemon B started with `policy.golden.toml`. */
export function isGoldenPolicyActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['MXL_CONFORMANCE_GOLDEN_POLICY'] === '1';
}

/**
 * Resolve the daemon-A socket path.
 * Priority: `MXL_CONFORMANCE_SOCKET` → `$XDG_RUNTIME_DIR/mx-agent/daemon.sock`
 * → `$HOME/.local/share/mx-agent/daemon.sock`.
 */
export function resolveDaemonSocket(env: NodeJS.ProcessEnv = process.env): string {
  if (env['MXL_CONFORMANCE_SOCKET']) return env['MXL_CONFORMANCE_SOCKET'];
  const xdg = env['XDG_RUNTIME_DIR'];
  if (xdg) return `${xdg}/mx-agent/daemon.sock`;
  const home = env['HOME'] ?? '/root';
  return `${home}/.local/share/mx-agent/daemon.sock`;
}

/** Whether daemon A's socket file exists (the cheap reachability probe). */
export function isDaemonReachable(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(resolveDaemonSocket(env));
}

// Module-level snapshots evaluated once at import — used by `describe.skipIf`.
export const TWO_DAEMON_REQUIRED = isTwoDaemonRequired();
export const GOLDEN_POLICY_ACTIVE = isGoldenPolicyActive();
export const DAEMON_REACHABLE = isDaemonReachable();

/**
 * The golden suite is *demanded* only when BOTH the two-daemon fixture and the
 * golden policy are declared up — running the golden scenario against the
 * throwaway `policy.b.toml` (no approval gate, no `deny_args_regex`, no `[exec]`)
 * would be meaningless. The plain Tier-2 delegate job (two-daemon, no golden
 * policy) therefore does not drag this suite red.
 */
export const GOLDEN_REQUIRED = TWO_DAEMON_REQUIRED && GOLDEN_POLICY_ACTIVE;

/**
 * Skip the golden suite *cleanly* only when it is not demanded — so a developer
 * laptop and the fast unit CI (neither flag set) never run it. When it IS demanded
 * (`GOLDEN_REQUIRED`) the suite runs and {@link assertGoldenPrereqs} turns an
 * unreachable daemon / incomplete fixture into a HARD failure — never a silent skip.
 */
export const SKIP_GOLDEN = !GOLDEN_REQUIRED;

// ---------------------------------------------------------------------------
// Fail-not-skip prerequisite check (pure → unit-testable)
// ---------------------------------------------------------------------------

export interface GoldenPrereqInput {
  /** Is the golden suite demanded (`MXL_CONFORMANCE_TWO_DAEMON=1` && `MXL_CONFORMANCE_GOLDEN_POLICY=1`)? */
  readonly required: boolean;
  /** Is daemon A reachable at the conformance socket? */
  readonly reachable: boolean;
  /** The resolved golden fixture coordinates, or `null` if any required coordinate is absent. */
  readonly fixture: GoldenFixture | null;
}

/**
 * The gate decision as a pure function, so both branches are unit-testable without
 * touching `process.env`. Returns an `Error` to throw (a HARD failure) when the
 * golden suite is demanded but its daemon / fixture is missing; otherwise `null`.
 */
export function goldenPrereqError(input: GoldenPrereqInput): Error | null {
  if (!input.required) return null; // not demanded → clean skip (handled by SKIP_GOLDEN)
  if (!input.reachable) {
    return new Error(
      'golden gate (T114): MXL_CONFORMANCE_TWO_DAEMON=1 and MXL_CONFORMANCE_GOLDEN_POLICY=1 are set ' +
        'but no mx-agent daemon is reachable at the conformance socket. The golden suite must FAIL ' +
        '(never silently skip) when its fixture is demanded but unreachable — otherwise the M1-exit ' +
        'gate degrades to "always green". Bring up the golden two-daemon fixture, or unset the flags ' +
        'to run locally.',
    );
  }
  if (input.fixture === null) {
    return new Error(
      'golden gate (T114): the golden fixture coordinates are incomplete. Expected ' +
        'MXL_CONFORMANCE_ROOM, MXL_CONFORMANCE_TARGET_AGENT, MXL_CONFORMANCE_TOOL, ' +
        'MXL_CONFORMANCE_APPROVAL_TOOL, MXL_CONFORMANCE_DENIED_TOOL, and MXL_CONFORMANCE_ALLOWED_COMMAND ' +
        '(the bring-up exports these from bootstrap-daemon-b.sh with POLICY_FIXTURE=policy.golden.toml).',
    );
  }
  return null;
}

/**
 * Use inside the golden suite's `beforeAll`: throws (→ red) when the golden suite
 * is demanded but the daemon / fixture is missing; no-op otherwise.
 */
export function assertGoldenPrereqs(
  required: boolean = GOLDEN_REQUIRED,
  reachable: boolean = DAEMON_REACHABLE,
  fixture: GoldenFixture | null = readGoldenFixture(),
): void {
  const err = goldenPrereqError({ required, reachable, fixture });
  if (err) throw err;
}

// ---------------------------------------------------------------------------
// Golden fixture coordinates (exported by the bring-up via env vars)
// ---------------------------------------------------------------------------

/**
 * The golden two-daemon fixture coordinates. Every one of the five named
 * coordinates is REQUIRED — each of S1–S8 depends on one — so a partial set
 * resolves to `null` and (when the suite is demanded) becomes a hard failure
 * rather than a half-run.
 */
export interface GoldenFixture {
  /** Shared workspace room daemon A and B both joined (`!…:server`). */
  readonly room: string;
  /** Agent id of daemon B's registered target agent. */
  readonly targetAgentId: string;
  /** Low-risk named tool B publishes and the golden policy ALLOWS ungated (`MXL_CONFORMANCE_TOOL`). */
  readonly allowTool: string;
  /** High-risk named tool B publishes, held `requires_approval=true` (`MXL_CONFORMANCE_APPROVAL_TOOL`). */
  readonly approvalTool: string;
  /** Named tool B publishes but the golden policy DENIES by default (`MXL_CONFORMANCE_DENIED_TOOL`). */
  readonly deniedTool: string;
  /** The one allowlisted, approval-gated guarded command (`MXL_CONFORMANCE_ALLOWED_COMMAND`). */
  readonly allowedCommand: string;
  /** The cwd the command may run in (`MXL_CONFORMANCE_ALLOW_CWD`); optional. */
  readonly allowCwd: string | undefined;
}

/** Read the golden fixture from the env; `null` if any required coordinate is absent. */
export function readGoldenFixture(env: NodeJS.ProcessEnv = process.env): GoldenFixture | null {
  const room = env['MXL_CONFORMANCE_ROOM'];
  const targetAgentId = env['MXL_CONFORMANCE_TARGET_AGENT'];
  const allowTool = env['MXL_CONFORMANCE_TOOL'];
  const approvalTool = env['MXL_CONFORMANCE_APPROVAL_TOOL'];
  const deniedTool = env['MXL_CONFORMANCE_DENIED_TOOL'];
  const allowedCommand = env['MXL_CONFORMANCE_ALLOWED_COMMAND'];
  if (!room || !targetAgentId || !allowTool || !approvalTool || !deniedTool || !allowedCommand) {
    return null;
  }
  return {
    room,
    targetAgentId,
    allowTool,
    approvalTool,
    deniedTool,
    allowedCommand,
    allowCwd: env['MXL_CONFORMANCE_ALLOW_CWD'],
  };
}

/** Project the env fixture onto the binding-agnostic {@link ScenarioCoords}. */
export function coordsFromFixture(fixture: GoldenFixture): ScenarioCoords {
  return {
    room: fixture.room,
    targetAgentId: fixture.targetAgentId,
    allowTool: fixture.allowTool,
    approvalTool: fixture.approvalTool,
    deniedTool: fixture.deniedTool,
    allowedCommand: fixture.allowedCommand,
    ...(fixture.allowCwd !== undefined ? { allowCwd: fixture.allowCwd } : {}),
  };
}

// ---------------------------------------------------------------------------
// Shared assertion vocabulary + timing budgets
// ---------------------------------------------------------------------------

/** Secret-shaped patterns that must NEVER appear in any golden response or audit row. */
export const SECRET_PATTERN = /MATRIX_|MX_AGENT_|syt_[a-z]|ghp_|xox[bp]-/;

/**
 * Budget for `mx_await_result` to resolve a held step once the operator has
 * decided. Matches `await-result.conformance.test.ts` AC2's 120 s — generous
 * enough for the daemon's re-authorize-at-release, bounded so a stuck approval
 * fails rather than hangs CI.
 */
export const GOLDEN_RESOLVE_BUDGET_MS = 120_000;

/** Wall-clock budget for the out-of-band operator-decision script to act. */
export const OPERATOR_DECISION_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// Out-of-band operator-decision driver (decide-approval.sh)
// ---------------------------------------------------------------------------

/** Options for {@link approvePending} / {@link denyPending}. */
export interface OperatorDecisionOptions {
  /** Substring marker (tool/command name) to target the right pending request. */
  readonly match?: string;
  /** Override the wall-clock budget for the decision script. */
  readonly timeoutMs?: number;
}

/** Absolute path to the out-of-band operator-decision driver on daemon B. */
function decideApprovalScriptPath(): string {
  return fileURLToPath(new URL('../../../scripts/conformance/decide-approval.sh', import.meta.url));
}

/**
 * Issue an out-of-band operator decision on daemon B at the exact moment a step is
 * held. Shells out to `decide-approval.sh` (which uses the `mx-agent` CLI as the
 * operator, never any `@mx-loom/*` model-facing surface). `execFile` rejects on a
 * non-zero exit, so a missing pending request or a wrong CLI spelling fails the
 * golden run RED — never silently.
 */
async function decide(action: 'approve' | 'deny', options: OperatorDecisionOptions = {}): Promise<void> {
  const argv: string[] = [action];
  if (options.match !== undefined) argv.push('--match', options.match);
  await execFileAsync(decideApprovalScriptPath(), argv, {
    timeout: options.timeoutMs ?? OPERATOR_DECISION_TIMEOUT_MS,
    env: process.env,
  });
}

/** Approve the single pending approval on daemon B (out-of-band operator action). */
export function approvePending(options?: OperatorDecisionOptions): Promise<void> {
  return decide('approve', options);
}

/** Deny the single pending approval on daemon B (out-of-band operator action). */
export function denyPending(options?: OperatorDecisionOptions): Promise<void> {
  return decide('deny', options);
}

// ---------------------------------------------------------------------------
// Live binding context + arms
// ---------------------------------------------------------------------------

/**
 * A binding arm: a uniform surface the shared {@link runStep} drives, regardless of
 * whether the underlying binding is the MCP server or the Claude in-process shim.
 */
export interface GoldenArm {
  /** `'mcp'` | `'claude'` — for test output. */
  readonly name: string;
  /** Dispatch one model tool call and return the normalized T102 envelope. */
  dispatch(tool: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** Resolve a deferred handle after the operator decided (the held-step second leg). */
  resolve(handle: string, waitMs: number): Promise<ToolResult>;
  /** Tear down the binding + the daemon client. Idempotent. */
  close(): Promise<void>;
}

/** A handle to a live arm plus the underlying daemon client + context for assertions. */
export interface LiveArm {
  readonly arm: GoldenArm;
  readonly mxClient: MxClient;
  readonly ctx: BindingContext;
}

/** The MCP arm additionally exposes its MCP `Client` for raw `isError`-semantics assertions. */
export interface LiveMcpArm extends LiveArm {
  /** The in-process MCP `Client` — used to assert the wire-level `CallToolResult.isError`. */
  readonly mcpClient: Client;
}

/** A live Claude arm additionally exposes the captured (secret-free) HITL summaries. */
export interface LiveClaudeArm extends LiveArm {
  /** Every {@link ApprovalSummary} the `canUseTool` gate rendered, in call order. */
  readonly summaries: readonly ApprovalSummary[];
}

/**
 * Wrap a {@link DaemonCall} in a call-counting proxy — so a test can prove a
 * requester-side `canUseTool` **deny** short-circuits *before* any daemon RPC
 * (the request is never signed), exactly as `shim.integration.test.ts` Scenario B does.
 */
export function countingDaemon(inner: DaemonCall): { daemon: DaemonCall; count: () => number } {
  let n = 0;
  return {
    daemon: {
      call: (method, params, options) => {
        n += 1;
        return inner.call(method, params, options);
      },
    },
    count: () => n,
  };
}

/** Build a secret-free {@link BindingContext} over a live `MxClient` (bare daemon + room). */
function buildLiveCtx(daemon: DaemonCall, room: string, auditSink: AuditSink, correlationId: string): BindingContext {
  return {
    daemon,
    room,
    correlationId,
    auditSink,
    close: async () => {
      /* the daemon client is owned by the caller, closed via LiveArm.mxClient */
    },
  };
}

/** Parse the full T102 envelope from a binding's `CallToolResult.structuredContent`. */
export function envelopeFromCallResult(result: CallToolResult): ToolResult {
  const sc = result.structuredContent;
  if (sc === undefined || sc === null) {
    throw new Error('golden arm: binding returned a CallToolResult with no structuredContent envelope');
  }
  return sc as unknown as ToolResult;
}

/**
 * Build the live MCP arm: a real `MxClient` → `BindingContext` (with the injected
 * `auditSink` + a stable `correlation_id`) → `createMcpServer` → an MCP `Client`
 * over `InMemoryTransport`. Each `dispatch` is a `tools/call`; the full stack —
 * MCP encoding, `dispatchCall`, the live `call.start` / `exec.start` round-trip,
 * the `withAudit` tap, the serializer — runs.
 */
export async function createGoldenMcpArm(opts: {
  room: string;
  auditSink: AuditSink;
  correlationId: string;
}): Promise<LiveMcpArm> {
  // Pin the client to the SAME socket the reachability probe honors
  // (`MXL_CONFORMANCE_SOCKET`). A bare `createClient()` ignores that env var and
  // resolves XDG_RUNTIME_DIR/TMPDIR instead, so it would connect to the wrong/absent
  // socket while the probe reports daemon A reachable — a silent miss.
  const mxClient = createClient({ socketPath: resolveDaemonSocket() });
  const ctx = buildLiveCtx(mxClient, opts.room, opts.auditSink, opts.correlationId);
  const server = createMcpServer(ctx);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: 'golden-mcp-arm', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

  let closed = false;
  const arm: GoldenArm = {
    name: 'mcp',
    async dispatch(tool, args) {
      const res = (await mcpClient.callTool({ name: tool, arguments: args })) as CallToolResult;
      return envelopeFromCallResult(res);
    },
    async resolve(handle, waitMs) {
      const res = (await mcpClient.callTool({
        name: 'mx_await_result',
        arguments: { handle, wait_ms: waitMs },
      })) as CallToolResult;
      return envelopeFromCallResult(res);
    },
    async close() {
      if (closed) return;
      closed = true;
      await mcpClient.close();
      await mxClient.close();
    },
  };
  return { arm, mxClient, ctx, mcpClient };
}

/**
 * Build the live Claude shim arm: the same live `BindingContext` →
 * `createMxToolServer` → an MCP `Client` over `InMemoryTransport`, fronted by the
 * secret-free `createMxCanUseTool` HITL gate. Each `dispatch` runs `canUseTool`
 * first (modelling the SDK's pre-dispatch hook), captures the rendered
 * {@link ApprovalSummary}, asserts the operator allowed, then routes to the tool
 * server. The default operator auto-allows every prompt — the *real* gate is the
 * receiving daemon's approval, exercised via the held steps.
 */
export async function createGoldenClaudeArm(opts: {
  room: string;
  auditSink: AuditSink;
  correlationId: string;
  onApprovalRequest?: OnApprovalRequest;
  serverOptions?: CreateMxToolServerOptions;
}): Promise<LiveClaudeArm> {
  // Pin to the conformance socket — see createGoldenMcpArm for the rationale.
  const mxClient = createClient({ socketPath: resolveDaemonSocket() });
  const ctx = buildLiveCtx(mxClient, opts.room, opts.auditSink, opts.correlationId);
  const config = createMxToolServer(ctx, opts.serverOptions);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: 'golden-claude-arm', version: '0.0.0' });
  await Promise.all([config.instance.connect(serverTransport), mcpClient.connect(clientTransport)]);

  const summaries: ApprovalSummary[] = [];
  const canUseTool = createMxCanUseTool({
    onApprovalRequest: async (summary) => {
      summaries.push(summary);
      return opts.onApprovalRequest ? opts.onApprovalRequest(summary) : 'allow';
    },
  });

  let closed = false;
  const arm: GoldenArm = {
    name: 'claude',
    async dispatch(tool, args) {
      // Model the SDK's HITL hook firing before routing. The signal/toolUseID are
      // the SDK's per-call context.
      const decision = await canUseTool(mxToolName(tool), args, {
        signal: new AbortController().signal,
        toolUseID: `golden-${tool}`,
      });
      if (decision.behavior !== 'allow') {
        throw new Error(
          `golden claude arm: canUseTool denied ${tool} on the happy path — ` +
            'the requester-side gate is configured to auto-allow; the daemon is the real authority',
        );
      }
      const res = (await mcpClient.callTool({ name: tool, arguments: decision.updatedInput })) as CallToolResult;
      return envelopeFromCallResult(res);
    },
    async resolve(handle, waitMs) {
      // mx_await_result is a read/observe verb — canUseTool auto-allows it without a
      // prompt, so the model resolves the handle directly.
      const res = (await mcpClient.callTool({
        name: 'mx_await_result',
        arguments: { handle, wait_ms: waitMs },
      })) as CallToolResult;
      return envelopeFromCallResult(res);
    },
    async close() {
      if (closed) return;
      closed = true;
      await mcpClient.close();
      await mxClient.close();
    },
  };
  return { arm, mxClient, ctx, summaries };
}

/**
 * A live Pi arm. Unlike {@link LiveArm}, it does NOT expose an `mxClient`: the Pi
 * binding owns its `MxSession` inside `createPiBindingContext` and the matrix only
 * needs the generated tools (for descriptor identity) and the `GoldenArm` (to drive
 * the scenario). `close()` is `ctx.close()` — see the spec's OQ6 recommendation
 * (omit `mxClient`; no new Pi export required).
 */
export interface LivePiArm {
  readonly arm: GoldenArm;
  /** The Pi binding context (its `close()` tears down the session this arm opened). */
  readonly ctx: PiBindingContext;
  /** The generated Pi `ToolDefinition[]` — used for the descriptor-identity invariant. */
  readonly tools: readonly PiToolDefinition[];
}

/**
 * Build the live Pi arm (T206): the @mx-loom/pi NATIVE binding, **model-free** —
 * `createPiBindingContext` opens a real `MxSession` (`agent.register` + heartbeat),
 * `createPiToolDefinitions` converts `CANONICAL_M1_TOOLS` → Pi `ToolDefinition[]`,
 * and each `dispatch` calls `ToolDefinition.execute()` directly (exactly as the
 * golden MCP/Claude arms dispatch `tools/call`). The full T102 envelope is carried
 * verbatim in the Pi `AgentToolResult.details` channel, so the shared `runStep`
 * hold→decide→resolve runner drives the **full S1–S8** through Pi natively.
 *
 * Deferred handles resolve via the `mx_await_result` `ToolDefinition` (Pi keeps
 * deferred results model-driven — no hidden poll loop), so the held-step second leg
 * works unchanged. The room ALWAYS comes from the session, never a model arg
 * (`buildGoldenScenario` never puts a room in `step.args`). The arm shares the
 * injected `auditSink`, so the AC4 emission count is assertable for the Pi row.
 */
export async function createGoldenPiArm(opts: {
  room: string;
  auditSink: AuditSink;
  correlationId: string;
  /** Real Pi TypeBox when resolvable (see `_pi-builders.ts`), else the inline shim. */
  builders?: TypeBoxBuilders;
}): Promise<LivePiArm> {
  const ctx = await createPiBindingContext({
    sessionOptions: { room: opts.room, kind: 'pi', correlationId: opts.correlationId },
    auditSink: opts.auditSink,
  });
  const tools = createPiToolDefinitions(ctx, { builders: opts.builders ?? INLINE_FAKE_BUILDERS });
  const byName = new Map(tools.map((t) => [t.name, t] as const));

  const dispatch = async (tool: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const def = byName.get(tool);
    if (def === undefined) throw new Error(`golden Pi arm: tool ${tool} not generated`);
    const out = await def.execute(`golden-${tool}`, args);
    // The full T102 envelope is carried verbatim in the `details` channel.
    return out.details as ToolResult;
  };

  let closed = false;
  const arm: GoldenArm = {
    name: 'pi',
    dispatch,
    resolve(handle, waitMs) {
      return dispatch('mx_await_result', { handle, wait_ms: waitMs });
    },
    async close() {
      if (closed) return;
      closed = true;
      await ctx.close();
    },
  };
  return { arm, ctx, tools };
}

// ---------------------------------------------------------------------------
// The shared step runner (the operator decision lives strictly between hold and
// resolve, so the flow is deterministic — no guessing bot).
// ---------------------------------------------------------------------------

/** The result of running one step: the initial dispatch envelope + the terminal one. */
export interface StepOutcome {
  /** The first dispatch result (an `awaiting_approval` hold for held steps). */
  readonly initial: ToolResult;
  /** The terminal result (== `initial` for non-held steps; the resolved leg otherwise). */
  readonly terminal: ToolResult;
}

/**
 * Run one logical step through an arm. For a non-held step the initial dispatch is
 * terminal. For a held step the daemon returns `awaiting_approval`; the harness
 * then issues the out-of-band operator decision and resolves the handle — keeping
 * the decision strictly between the hold and the resolve.
 */
export async function runStep(arm: GoldenArm, step: GoldenStep): Promise<StepOutcome> {
  const initial = await arm.dispatch(step.tool, step.args);

  if (!step.heldForApproval) {
    return { initial, terminal: initial };
  }

  // The daemon must hold a `requires_approval` step. If it did not (status not
  // awaiting_approval, or no handle), return as-is and let the caller assert the
  // (failed) expectation — never fabricate a decision.
  if (initial.status !== 'awaiting_approval' || initial.handle === null) {
    return { initial, terminal: initial };
  }

  if (step.operator === 'approve') {
    await approvePending({ match: step.approvalMatch });
  } else if (step.operator === 'deny') {
    await denyPending({ match: step.approvalMatch });
  }

  const terminal = await arm.resolve(initial.handle, GOLDEN_RESOLVE_BUDGET_MS);
  return { initial, terminal };
}
