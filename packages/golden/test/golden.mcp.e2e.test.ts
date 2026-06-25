/**
 * GOLDEN end-to-end — arm A: the @mx-loom/mcp binding (T114 / #22).
 *
 * Drives the binding-agnostic S1–S8 scenario (`scenario.ts`) through the generated
 * MCP server against the live two-daemon golden fixture, with a deterministic
 * out-of-band operator. Every boundary the M1-exit gate names is crossed here:
 *   model action → MCP `tools/call` → dispatch → call.start/exec.start
 *     → daemon A → daemon B → receiver policy → approval gate
 *     → out-of-band operator decision → re-authorize-at-release
 *     → T102 envelope → CallToolResult → audit row.
 *
 * Acceptance criteria asserted by this arm:
 *   AC1 — named-tool delegation succeeds end-to-end (S3 → ok + populated audit_ref).
 *   AC2 — guarded command runs only after approval (S6); denial path both ways
 *         (S5 operator-deny → approval_denied; S7 deny_args_regex → policy_denied).
 *   AC3 — the scenario runs through the MCP binding (this file).
 *   AC4 — one audit row per emission, joinable by correlation_id (inline below;
 *         the deep approval-join + Postgres arm is golden.audit.e2e.test.ts).
 *
 * Gating: `SKIP_GOLDEN` skips cleanly with no fixture (laptop / fast CI). Under
 * `MXL_CONFORMANCE_TWO_DAEMON=1` + `MXL_CONFORMANCE_GOLDEN_POLICY=1`, `assertGoldenPrereqs`
 * turns an unreachable daemon / incomplete fixture into a HARD failure (never green).
 */
import { randomUUID } from 'node:crypto';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryAuditSink } from '@mx-loom/audit';
import {
  CANONICAL_TOOLS,
  isForbiddenAuthorityVerb,
  validateEnvelope,
  type ToolResult,
} from '@mx-loom/registry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SECRET_PATTERN,
  SKIP_GOLDEN,
  GOLDEN_RESOLVE_BUDGET_MS,
  approvePending,
  assertGoldenPrereqs,
  coordsFromFixture,
  createGoldenMcpArm,
  denyPending,
  envelopeFromCallResult,
  readGoldenFixture,
  type LiveMcpArm,
} from './_golden-harness.js';
import { buildGoldenScenario, expectedEmissions, type GoldenStep } from './scenario.js';

describe.skipIf(SKIP_GOLDEN)('GOLDEN e2e · arm A — @mx-loom/mcp binding', () => {
  const correlationId = `mxl-golden-mcp-${randomUUID()}`;
  const nonce = randomUUID();
  let live: LiveMcpArm | undefined;
  let sink: InMemoryAuditSink | undefined;
  let steps: GoldenStep[] = [];

  beforeAll(async () => {
    assertGoldenPrereqs();
    const fixture = readGoldenFixture();
    if (fixture === null) throw new Error('golden MCP arm: fixture coordinates absent');
    steps = buildGoldenScenario(coordsFromFixture(fixture), nonce);
    sink = new InMemoryAuditSink();
    live = await createGoldenMcpArm({ room: fixture.room, auditSink: sink, correlationId });
  });

  afterAll(async () => {
    await live?.arm.close();
  });

  // -------------------------------------------------------------------------
  // No-authority surface — the model tool set is exactly the nine mx_* verbs.
  // -------------------------------------------------------------------------

  it('tools/list surfaces only the twelve mx_* verbs — no authority verb is reachable', async () => {
    if (!live) throw new Error('arm not initialised');
    const { tools } = await live.mcpClient.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(CANONICAL_TOOLS.map((d) => d.name).sort());
    for (const { name } of tools) {
      // trust.* / approval.decide / policy.* / auth.* / device.* / daemon.* — structurally absent.
      expect(isForbiddenAuthorityVerb(name), `forbidden authority verb in tools/list: ${name}`).toBe(false);
    }
    expect(JSON.stringify(tools)).not.toMatch(SECRET_PATTERN);
  });

  // -------------------------------------------------------------------------
  // The full S1–S8 golden scenario in one pass — every boundary, every status.
  // -------------------------------------------------------------------------

  it(
    'runs S1–S8 end-to-end: named-tool delegation, approval gate (approve + deny), guarded exec, both denial paths',
    async () => {
      if (!live) throw new Error('arm not initialised');
      const client = live.mcpClient;

      // Capture the terminal envelope of each step so the audit assertions below can
      // correlate by invocation_id.
      const terminals = new Map<string, ToolResult>();

      const dispatchRaw = async (
        tool: string,
        args: Record<string, unknown>,
      ): Promise<{ raw: CallToolResult; env: ToolResult }> => {
        const raw = (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
        const env = envelopeFromCallResult(raw);
        // Every envelope validates and is secret-free at the boundary.
        expect(validateEnvelope(env), `${tool}: envelope must validate against ENVELOPE_SCHEMA`).toBe(true);
        expect(JSON.stringify(raw), `${tool}: secret-shaped value in CallToolResult`).not.toMatch(SECRET_PATTERN);
        // THE serialization invariant: isError iff status === 'error' (denied /
        // awaiting_approval / running / ok are NOT protocol errors — design §4.5).
        expect(raw.isError ?? false, `${tool}: isError must equal (status==='error')`).toBe(env.status === 'error');
        return { raw, env };
      };

      for (const step of steps) {
        const { env: initial } = await dispatchRaw(step.tool, step.args);

        if (!step.heldForApproval) {
          expect(initial.status, `${step.id} ${step.label}`).toBe(step.terminalStatus);
          if (step.terminalErrorCode !== undefined) {
            expect(initial.error?.code, `${step.id}: error code`).toBe(step.terminalErrorCode);
          }
          terminals.set(step.id, initial);
          continue;
        }

        // Held step: the daemon must hold for approval BEFORE executing (S6's command
        // does not run until release — the awaiting_approval hold is that proof at the
        // binding boundary).
        expect(initial.status, `${step.id}: must be held awaiting_approval`).toBe('awaiting_approval');
        expect(typeof initial.handle, `${step.id}: handle present`).toBe('string');
        expect(initial.approval, `${step.id}: approval block present`).not.toBeNull();
        expect(initial.approval?.request_id, `${step.id}: approval.request_id`).toBeTruthy();
        expect(['low', 'medium', 'high'], `${step.id}: approval.risk closed set`).toContain(initial.approval?.risk);

        // Out-of-band operator decision (the human, never the model).
        if (step.operator === 'approve') await approvePending({ match: step.approvalMatch });
        else await denyPending({ match: step.approvalMatch });

        // Resolve the handle AFTER the decision.
        const resolved = (await client.callTool({
          name: 'mx_await_result',
          arguments: { handle: initial.handle, wait_ms: GOLDEN_RESOLVE_BUDGET_MS },
        })) as CallToolResult;
        const terminal = envelopeFromCallResult(resolved);
        expect(validateEnvelope(terminal)).toBe(true);
        expect(JSON.stringify(resolved)).not.toMatch(SECRET_PATTERN);
        expect(resolved.isError ?? false).toBe(terminal.status === 'error');

        expect(terminal.status, `${step.id} ${step.label}`).toBe(step.terminalStatus);
        if (step.terminalErrorCode !== undefined) {
          expect(terminal.error?.code, `${step.id}: terminal error code`).toBe(step.terminalErrorCode);
        }
        terminals.set(step.id, terminal);
      }

      // AC1 — S3 named-tool delegation succeeded with a populated audit_ref.
      const s3 = terminals.get('S3');
      expect(s3?.status).toBe('ok');
      expect(s3?.audit_ref.invocation_id, 'S3 (AC1): a real delegation has a populated invocation_id').toBeTruthy();

      // AC2 — S6 guarded command produced an exit_code only after approval.
      const s6 = terminals.get('S6');
      expect(s6?.status).toBe('ok');
      expect(s6?.result, 'S6: guarded exec returns an exit_code envelope').toBeTruthy();
    },
  );

  // -------------------------------------------------------------------------
  // AC4 (inline) — one audit row per emission, recoverable by correlation_id.
  // -------------------------------------------------------------------------

  it('AC4: every emission produced exactly one audit row, recoverable by correlation_id', () => {
    if (!sink) throw new Error('sink not initialised');
    const expected = expectedEmissions(steps);

    // 8 dispatches + 3 held-step resolutions = 11 emissions (5 non-held + 3×2 held).
    expect(sink.count, 'one row per binding emission (the AC4 counting model)').toBe(expected.total);

    const session = sink.byCorrelation(correlationId);
    expect(session, 'byCorrelation recovers the complete session').toHaveLength(expected.total);
    expect(session.every((r) => r.correlation_id === correlationId)).toBe(true);

    // All three verbs and every produced status are represented.
    const verbs = new Set(session.map((r) => r.tool_name));
    expect(verbs.has('mx_delegate_tool')).toBe(true);
    expect(verbs.has('mx_run_command')).toBe(true);
    const statuses = new Set(session.map((r) => r.status));
    expect(statuses.has('ok')).toBe(true);
    expect(statuses.has('denied')).toBe(true);
    expect(statuses.has('awaiting_approval')).toBe(true);

    // No audit row carries a secret.
    expect(JSON.stringify(session)).not.toMatch(SECRET_PATTERN);
  });

  // -------------------------------------------------------------------------
  // Idempotency — re-issuing S3 with the same key does not double-execute.
  // -------------------------------------------------------------------------

  it('idempotency: re-issuing S3 with the same idempotency_key reuses the invocation (no double-execute)', async () => {
    if (!live) throw new Error('arm not initialised');
    const s3 = steps.find((s) => s.id === 'S3');
    if (!s3) throw new Error('S3 missing from scenario');

    const first = (await live.mcpClient.callTool({ name: s3.tool, arguments: s3.args })) as CallToolResult;
    const second = (await live.mcpClient.callTool({ name: s3.tool, arguments: s3.args })) as CallToolResult;
    const e1 = envelopeFromCallResult(first);
    const e2 = envelopeFromCallResult(second);

    expect(first.isError ?? false).toBe(false);
    expect(second.isError ?? false).toBe(false);

    const inv1 = e1.audit_ref.invocation_id;
    const inv2 = e2.audit_ref.invocation_id;
    if (inv1 !== null && inv2 !== null) {
      expect(inv2, 'same idempotency_key → same invocation_id (daemon deduped)').toBe(inv1);
    }
  });
});
