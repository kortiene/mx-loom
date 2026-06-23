/**
 * GOLDEN end-to-end — arm B: the @mx-loom/claude in-process shim (T114 / #22).
 *
 * The same binding-agnostic S1–S8 scenario, the same live two-daemon golden fixture,
 * the same out-of-band operator — but dispatched the way the Claude Agent SDK
 * composes the shim: `createMxToolServer` (the in-process MCP server) + a secret-free
 * `createMxCanUseTool` HITL gate fired before every routed call. The scripted
 * cognition asserts the rendered `ApprovalSummary` (verb / target / arg-key-names
 * only, never values; `risk: 'high'` for `mx_run_command`), then routes on allow.
 *
 * Acceptance criteria asserted by this arm:
 *   AC1/AC2 — as arm A, but through the Claude shim (uses the shared `runStep`).
 *   AC3 — the scenario runs through the Claude native shim (this file).
 *   AC4 — one audit row per emission (inline; deep join in golden.audit.e2e.test.ts).
 *   Secret boundary — the HITL summary is value-free; a requester-side deny
 *   short-circuits before any daemon RPC.
 *
 * The opt-in real-model arm (`MXL_GOLDEN_LIVE_MODEL=1` + `ANTHROPIC_API_KEY`) drives a
 * genuine `@anthropic-ai/claude-agent-sdk` `query()` through the same shim — proving
 * the faithful integration, but it is NEVER the M1-exit gate (cost/flakiness/secret
 * reasons; the scripted arm above is the gate).
 */
import { randomUUID } from 'node:crypto';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { InMemoryAuditSink, NullAuditSink } from '@mx-loom/audit';
import {
  createMxCanUseTool,
  createMxToolServer,
  mxToolName,
} from '@mx-loom/claude';
import type { BindingContext } from '@mx-loom/mcp';
import { validateEnvelope, type ToolResult } from '@mx-loom/registry';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SECRET_PATTERN,
  SKIP_GOLDEN,
  assertGoldenPrereqs,
  coordsFromFixture,
  countingDaemon,
  createGoldenClaudeArm,
  readGoldenFixture,
  resolveDaemonSocket,
  runStep,
  type LiveClaudeArm,
} from './_golden-harness.js';
import { buildGoldenScenario, expectedEmissions, type GoldenStep } from './scenario.js';

describe.skipIf(SKIP_GOLDEN)('GOLDEN e2e · arm B — @mx-loom/claude in-process shim', () => {
  const correlationId = `mxl-golden-claude-${randomUUID()}`;
  const nonce = randomUUID();
  let live: LiveClaudeArm | undefined;
  let sink: InMemoryAuditSink | undefined;
  let room = '';
  let steps: GoldenStep[] = [];

  beforeAll(async () => {
    assertGoldenPrereqs();
    const fixture = readGoldenFixture();
    if (fixture === null) throw new Error('golden Claude arm: fixture coordinates absent');
    room = fixture.room;
    steps = buildGoldenScenario(coordsFromFixture(fixture), nonce);
    sink = new InMemoryAuditSink();
    live = await createGoldenClaudeArm({ room, auditSink: sink, correlationId });
  });

  afterAll(async () => {
    await live?.arm.close();
  });

  // -------------------------------------------------------------------------
  // The full S1–S8 scenario via the shared runner (operator decision strictly
  // between hold and resolve).
  // -------------------------------------------------------------------------

  it(
    'runs S1–S8 end-to-end through the shim: delegation, approval gate (approve + deny), guarded exec, denial paths',
    async () => {
      if (!live) throw new Error('arm not initialised');
      const terminals = new Map<string, ToolResult>();

      for (const step of steps) {
        const { initial, terminal } = await runStep(live.arm, step);

        // Envelope validates + is secret-free at the boundary, for both legs.
        expect(validateEnvelope(initial), `${step.id}: initial envelope validates`).toBe(true);
        expect(validateEnvelope(terminal), `${step.id}: terminal envelope validates`).toBe(true);
        expect(JSON.stringify(terminal), `${step.id}: secret in terminal envelope`).not.toMatch(SECRET_PATTERN);

        if (step.heldForApproval) {
          expect(initial.status, `${step.id}: held awaiting_approval first`).toBe('awaiting_approval');
          expect(initial.approval?.request_id, `${step.id}: approval.request_id`).toBeTruthy();
          expect(['low', 'medium', 'high']).toContain(initial.approval?.risk);
        }

        expect(terminal.status, `${step.id} ${step.label}`).toBe(step.terminalStatus);
        if (step.terminalErrorCode !== undefined) {
          expect(terminal.error?.code, `${step.id}: terminal error code`).toBe(step.terminalErrorCode);
        }
        terminals.set(step.id, terminal);
      }

      // AC1 — S3 named-tool delegation succeeded with a populated audit_ref.
      expect(terminals.get('S3')?.status).toBe('ok');
      expect(terminals.get('S3')?.audit_ref.invocation_id, 'S3 (AC1): populated invocation_id').toBeTruthy();
      // AC2 — S6 guarded command produced its envelope only after approval.
      expect(terminals.get('S6')?.status).toBe('ok');
    },
  );

  // -------------------------------------------------------------------------
  // Secret-free HITL summary — the requester-side gate renders verb/target/arg-key
  // names only, with the correct risk hint, and never a value.
  // -------------------------------------------------------------------------

  it('the canUseTool HITL summaries are secret-free and carry the correct risk hints', () => {
    if (!live) throw new Error('arm not initialised');
    const summaries = live.summaries;

    // Read/observe verbs (S1 mx_find_agents, S2 mx_describe_agent) auto-allow with
    // NO prompt — only the risk-bearing verbs render a summary.
    expect(summaries.every((s) => s.tool === 'mx_delegate_tool' || s.tool === 'mx_run_command')).toBe(true);

    // mx_run_command is high-risk; mx_delegate_tool is medium.
    for (const s of summaries) {
      if (s.tool === 'mx_run_command') expect(s.risk).toBe('high');
      if (s.tool === 'mx_delegate_tool') expect(s.risk).toBe('medium');
      // arg-key names only — never the inner values, never a secret.
      expect(JSON.stringify(s)).not.toMatch(SECRET_PATTERN);
      // The guarded-exec summary shows only the argc, never the argv values.
      if (s.tool === 'mx_run_command') {
        expect(s.args_summary).toMatch(/argc=/);
        expect(s.args_summary).not.toContain('curl');
      }
    }
    // At least the four risk-bearing dispatches (S3–S8 minus the two non-prompting?
    // S3,S4,S5 delegate + S6,S7,S8 → 6 risk-bearing dispatches) prompted.
    expect(summaries.length).toBeGreaterThanOrEqual(6);
  });

  // -------------------------------------------------------------------------
  // AC2 deny — a requester-side canUseTool deny short-circuits BEFORE any daemon
  // RPC (the request is never signed). Mirrors shim.integration Scenario B, live.
  // -------------------------------------------------------------------------

  it('canUseTool deny short-circuits before dispatch — zero daemon calls (request never signed)', async () => {
    if (!live) throw new Error('arm not initialised');

    const counting = countingDaemon(live.mxClient);
    const ctx: BindingContext = {
      daemon: counting.daemon,
      room,
      correlationId: undefined,
      auditSink: new NullAuditSink(),
      close: async () => {},
    };
    const config = createMxToolServer(ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'golden-claude-deny', version: '0.0.0' });
    await Promise.all([config.instance.connect(st), client.connect(ct)]);

    try {
      const denyGate = createMxCanUseTool({ onApprovalRequest: async () => 'deny' });
      const secretAgent = 'matrix-agent-private-name';
      const decision = await denyGate(
        mxToolName('mx_delegate_tool'),
        { agent: secretAgent, tool: 'run_tests', args: {} },
        { signal: new AbortController().signal, toolUseID: 'golden-deny' },
      );

      expect(decision.behavior).toBe('deny');
      if (decision.behavior === 'deny') {
        // Secret-free reason: the verb only — never the target agent id or arg values.
        expect(decision.message).toContain('mx_delegate_tool');
        expect(decision.message).not.toContain(secretAgent);
      }
      // The gate denied → we never route to the tool server → the daemon is untouched.
      expect(counting.count(), 'a requester-side deny must issue zero daemon RPCs').toBe(0);
    } finally {
      await client.close();
    }
  });

  // -------------------------------------------------------------------------
  // AC4 (inline) — one audit row per emission, recoverable by correlation_id.
  // -------------------------------------------------------------------------

  it('AC4: every emission produced exactly one audit row, recoverable by correlation_id', () => {
    if (!sink) throw new Error('sink not initialised');
    const expected = expectedEmissions(steps);
    expect(sink.count).toBe(expected.total);
    const session = sink.byCorrelation(correlationId);
    expect(session).toHaveLength(expected.total);
    expect(JSON.stringify(session)).not.toMatch(SECRET_PATTERN);
  });
});

// ---------------------------------------------------------------------------
// Opt-in real-model arm — a genuine query() through the same shim.
// NEVER the gate: cost/flakiness/secret reasons. Skips unless BOTH the golden
// fixture is up AND the model arm is explicitly opted in with an API key.
// ---------------------------------------------------------------------------

const LIVE_MODEL = process.env['MXL_GOLDEN_LIVE_MODEL'] === '1' && Boolean(process.env['ANTHROPIC_API_KEY']);

describe.skipIf(SKIP_GOLDEN || !LIVE_MODEL)(
  'GOLDEN e2e · arm B (opt-in) — real Claude model in the loop via query()',
  () => {
    const correlationId = `mxl-golden-livemodel-${randomUUID()}`;
    let sink: InMemoryAuditSink | undefined;
    let close: (() => Promise<void>) | undefined;

    afterAll(async () => {
      await close?.();
    });

    it(
      'a real model emits mx_* tool calls that produce conforming envelopes + audit rows',
      async () => {
        const fixture = readGoldenFixture();
        if (fixture === null) throw new Error('live-model arm: fixture coordinates absent');

        // Lazy-load the SDK so the default scripted arms never depend on it at import.
        const { query } = await import('@anthropic-ai/claude-agent-sdk');
        const { createClient } = await import('@mx-loom/toolbelt');

        sink = new InMemoryAuditSink();
        // Pin to the conformance socket the reachability probe honors — a bare
        // createClient() ignores MXL_CONFORMANCE_SOCKET and would miss daemon A.
        const mxClient = createClient({ socketPath: resolveDaemonSocket() });
        const ctx: BindingContext = {
          daemon: mxClient,
          room: fixture.room,
          correlationId,
          auditSink: sink,
          close: async () => {},
        };
        close = async () => {
          await mxClient.close();
        };

        const config = createMxToolServer(ctx);
        const canUseTool = createMxCanUseTool({ onApprovalRequest: async () => 'allow' });

        // A bounded, model-non-deterministic run: ask it to use the discovery verbs.
        // Assertions are loosened — the model's exact phrasing/order is not asserted;
        // only that the shim faithfully surfaced conforming envelopes + audit rows.
        const response = query({
          prompt: `List the agents in this workspace and describe agent ${fixture.targetAgentId}.`,
          options: {
            model: process.env['MXL_GOLDEN_LIVE_MODEL_NAME'] ?? 'claude-haiku-4-5',
            mcpServers: { mx: config },
            canUseTool,
            allowedTools: [mxToolName('mx_find_agents'), mxToolName('mx_describe_agent')],
            maxTurns: 4,
          },
        });

        for await (const _message of response) {
          // Drain the stream; the audit tap records each tool result as it returns.
          void _message;
        }

        // The faithful-integration assertion: the shim produced at least one audit
        // row for this session, each secret-free and correlation-tagged.
        const session = sink.byCorrelation(correlationId);
        expect(session.length, 'the model issued at least one mx_* tool call').toBeGreaterThan(0);
        expect(session.every((r) => r.correlation_id === correlationId)).toBe(true);
        expect(JSON.stringify(session)).not.toMatch(SECRET_PATTERN);
      },
    );
  },
);
