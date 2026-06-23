/**
 * MCP binding conformance (T109 / #17) — live two-daemon suite.
 *
 * This is the "dedicated tests phase" arm the T109 backlog entry deferred:
 *   "live two-daemon MCP conformance arm (parity with the toolbelt suite) … land
 *    in the dedicated tests phase behind `MXL_CONFORMANCE_TWO_DAEMON=1`"
 *
 * Three acceptance criteria (verbatim from issue #17 / T109 AC column):
 *   AC1 — An MCP client lists all `mx_*` tools with correct schemas.
 *   AC2 — A delegated call round-trips through the MCP server.
 *   AC3 — `awaiting_approval` surfaces correctly over MCP.
 *
 * Wire model (each test):
 *   MCP Client → InMemoryTransport ↔ MCP Server → BindingContext
 *                → real MxClient → daemon Unix socket → daemon A → daemon B
 *
 * The `InMemoryTransport` exercises the full MCP message encoding/decoding path;
 * the real `MxClient` exercises the actual `call.start` / `agent.list` / … daemon
 * round-trips. Together they validate every layer without spawning the stdio bin.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Prerequisites (established OUT OF BAND by the CI bring-up — never via the
 * toolbelt, never as a model tool):
 *   • Daemon pair A and B (mx-agent v0.2.1 pin), distinct Matrix users, both
 *     joined to the same workspace room.
 *   • Mutual Ed25519 trust established via `mx-agent trust approve`.
 *   • Daemon B running a receiver `policy.toml` (at minimum the throwaway
 *     `scripts/conformance/policy.b.toml`; use `policy.golden.toml` for the
 *     approval-gated AC3 paths):
 *       · allows at least one named tool  (MXL_CONFORMANCE_TOOL);
 *       · denies at least one tool by default (MXL_CONFORMANCE_DENIED_TOOL);
 *       · optionally holds one tool for approval (MXL_CONFORMANCE_APPROVAL_TOOL).
 *   • Env exports required:
 *       MXL_CONFORMANCE_TWO_DAEMON=1
 *       MXL_CONFORMANCE_ROOM=!<room>:<server>
 *       MXL_CONFORMANCE_TARGET_AGENT=<agent-id-of-B>
 *       MXL_CONFORMANCE_TOOL=<allowed-tool-name>
 *   • Optional env exports:
 *       MXL_CONFORMANCE_DENIED_TOOL=<denied-tool-name>
 *       MXL_CONFORMANCE_APPROVAL_TOOL=<approval-gated-tool-name>
 *       MXL_CONFORMANCE_SOCKET=<daemon-socket-path>    (overrides XDG default)
 *
 * Gating: `SKIP_TWO_DAEMON = !TWO_DAEMON_REQUIRED || !DAEMON_REACHABLE` ensures
 * this suite skips cleanly on developer laptops (where neither flag is set) and
 * fails hard only when `MXL_CONFORMANCE_TWO_DAEMON=1` is set but no daemon is
 * reachable — preserving the "red on drift, never silently green" invariant.
 * ──────────────────────────────────────────────────────────────────────────────
 */
import { randomUUID } from 'node:crypto';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CANONICAL_M1_TOOLS, validateEnvelope } from '@mx-loom/registry';

import {
  SECRET_PATTERN,
  SKIP_TWO_DAEMON,
  assertTwoDaemonPrereqs,
  createLiveMcpFixture,
  readMcpTwoDaemonFixture,
} from './_mcp-harness.js';
import type { LiveMcpFixture, McpTwoDaemonFixture } from './_mcp-harness.js';

// ---------------------------------------------------------------------------
// AC1 — tools/list lists all nine canonical mx_* tools with correct schemas
//        via a BindingContext backed by a real MxClient
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_TWO_DAEMON)(
  'MCP conformance · AC1 — tools/list over a live BindingContext',
  () => {
    let liveFixture: LiveMcpFixture | undefined;

    beforeAll(async () => {
      assertTwoDaemonPrereqs();
      const coords = readMcpTwoDaemonFixture();
      if (coords === null) {
        throw new Error(
          'MCP conformance AC1: fixture coordinates absent — set MXL_CONFORMANCE_ROOM, ' +
            'MXL_CONFORMANCE_TARGET_AGENT, MXL_CONFORMANCE_TOOL',
        );
      }
      liveFixture = await createLiveMcpFixture(coords.room);
    });

    afterAll(async () => {
      await liveFixture?.close();
    });

    it('lists exactly the nine canonical mx_* tools', async () => {
      if (!liveFixture) throw new Error('fixture not initialised');
      const { tools } = await liveFixture.mcpClient.listTools();

      expect(tools).toHaveLength(CANONICAL_M1_TOOLS.length);
      expect(tools.map((t) => t.name)).toEqual(CANONICAL_M1_TOOLS.map((d) => d.name));
    });

    it('each tool carries its descriptor inputSchema verbatim (deep-equal)', async () => {
      if (!liveFixture) throw new Error('fixture not initialised');
      const { tools } = await liveFixture.mcpClient.listTools();

      for (const descriptor of CANONICAL_M1_TOOLS) {
        const tool = tools.find((t) => t.name === descriptor.name);
        expect(tool, `mx_* tool missing from tools/list: ${descriptor.name}`).toBeDefined();
        expect(tool!.inputSchema).toEqual(descriptor.input_schema);
      }
    });

    it('no forbidden authority verb appears in tools/list', async () => {
      if (!liveFixture) throw new Error('fixture not initialised');
      const { tools } = await liveFixture.mcpClient.listTools();

      // trust.*, approval.decide, policy.*, auth.*, device.*, daemon.* must be
      // structurally absent — they are operator-only, never model tools (§9).
      for (const { name } of tools) {
        expect(
          name.startsWith('trust.') ||
            name.startsWith('approval.decide') ||
            name.startsWith('policy.') ||
            name.startsWith('auth.') ||
            name.startsWith('device.') ||
            name.startsWith('daemon.'),
          `forbidden authority verb in tools/list: ${name}`,
        ).toBe(false);
      }
    });

    it('tools/list response contains no secret-shaped patterns', async () => {
      if (!liveFixture) throw new Error('fixture not initialised');
      const { tools } = await liveFixture.mcpClient.listTools();
      expect(JSON.stringify(tools)).not.toMatch(SECRET_PATTERN);
    });
  },
);

// ---------------------------------------------------------------------------
// AC2 — a delegated call round-trips through the MCP server
//        (full stack: MCP tools/call → dispatch → mxDelegateTool → call.start
//         → daemon A → daemon B → T102 envelope → CallToolResult)
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_TWO_DAEMON)(
  'MCP conformance · AC2 — delegated call round-trip via live daemon',
  () => {
    let liveFixture: LiveMcpFixture | undefined;
    let coords: McpTwoDaemonFixture | undefined;

    beforeAll(async () => {
      assertTwoDaemonPrereqs();
      const fx = readMcpTwoDaemonFixture();
      if (fx === null) {
        throw new Error('MCP conformance AC2: fixture coordinates absent');
      }
      coords = fx;
      liveFixture = await createLiveMcpFixture(fx.room);
    });

    afterAll(async () => {
      await liveFixture?.close();
    });

    it(
      'mx_delegate_tool: CallToolResult has isError=false and a valid T102 envelope',
      async () => {
        if (!liveFixture || !coords) throw new Error('fixture not initialised');

        const result = (await liveFixture.mcpClient.callTool({
          name: 'mx_delegate_tool',
          arguments: {
            agent: coords.targetAgentId,
            tool: coords.tool,
            args: { package: 'mx-loom-mcp-conformance' },
            idempotency_key: `mxl-mcp-conf-${randomUUID()}`,
          },
        })) as CallToolResult;

        // A successful delegation must NOT be flagged as a protocol error —
        // isError=true would cause a runtime to retry/abort rather than read the result.
        expect(result.isError ?? false).toBe(false);

        // structuredContent carries the full T102 envelope verbatim.
        const sc = result.structuredContent as Record<string, unknown>;
        expect(sc).toBeDefined();

        // ok, running, and awaiting_approval are all valid non-error outcomes.
        // (A two-daemon fixture without requires_approval returns ok immediately.)
        expect(['ok', 'running', 'awaiting_approval']).toContain(sc['status']);

        // Validate against the T102 draft-07 envelope schema.
        expect(validateEnvelope(sc)).toBe(true);

        // Secret boundary holds across the full delegation result.
        expect(JSON.stringify(result)).not.toMatch(SECRET_PATTERN);
      },
      90_000,
    );

    it(
      'mx_delegate_tool: content[0] is a JSON text block containing the T102 envelope',
      async () => {
        if (!liveFixture || !coords) throw new Error('fixture not initialised');

        const result = (await liveFixture.mcpClient.callTool({
          name: 'mx_delegate_tool',
          arguments: {
            agent: coords.targetAgentId,
            tool: coords.tool,
            args: {},
            idempotency_key: `mxl-mcp-text-${randomUUID()}`,
          },
        })) as CallToolResult;

        // The human/model-readable channel: a single text block with the envelope as JSON.
        expect(result.content).toHaveLength(1);
        const block = result.content[0] as { type: string; text: string };
        expect(block.type).toBe('text');

        // Must parse as JSON and contain the five envelope top-level fields.
        const parsed = JSON.parse(block.text) as Record<string, unknown>;
        expect(['ok', 'running', 'awaiting_approval', 'denied', 'error']).toContain(
          parsed['status'],
        );
        expect(parsed).toHaveProperty('audit_ref');
        expect(parsed).toHaveProperty('result');
        expect(parsed).toHaveProperty('error');
      },
      90_000,
    );

    it(
      'policy-denied tool: mx_delegate_tool surfaces denied envelope with isError=false',
      async (ctx) => {
        if (!liveFixture || !coords) throw new Error('fixture not initialised');
        if (!coords.deniedTool) {
          // MXL_CONFORMANCE_DENIED_TOOL not supplied; mark as skipped so CI
          // reports accurately (the negative denial path was not exercised).
          ctx.skip();
          return;
        }

        const result = (await liveFixture.mcpClient.callTool({
          name: 'mx_delegate_tool',
          arguments: {
            agent: coords.targetAgentId,
            tool: coords.deniedTool,
            args: {},
            idempotency_key: `mxl-mcp-deny-${randomUUID()}`,
          },
        })) as CallToolResult;

        // Critical invariant: `policy_denied` is a governance outcome, NOT a
        // protocol fault. The model must read it and replan — not retry or abort.
        expect(result.isError ?? false).toBe(false);

        const sc = result.structuredContent as Record<string, unknown>;
        expect(sc['status']).toBe('denied');

        // The closed error taxonomy must carry policy_denied.
        const err = sc['error'] as Record<string, unknown> | null;
        expect(err).not.toBeNull();
        expect(err?.['code']).toBe('policy_denied');

        expect(validateEnvelope(sc)).toBe(true);
        expect(JSON.stringify(result)).not.toMatch(SECRET_PATTERN);
      },
      90_000,
    );

    it(
      'mx_find_agents: discovery verb lists workspace agents with no secrets',
      async () => {
        if (!liveFixture) throw new Error('fixture not initialised');

        const result = (await liveFixture.mcpClient.callTool({
          name: 'mx_find_agents',
          arguments: {},
        })) as CallToolResult;

        // Discovery verbs always return a non-error envelope (ok or graceful error).
        expect(result.isError ?? false).toBe(false);
        const sc = result.structuredContent as Record<string, unknown>;
        expect(sc['status']).toBe('ok');

        // The projected AgentSummary[] must be present (may be empty if B isn't
        // yet visible, but the field itself must be an array).
        const payload = sc['result'] as Record<string, unknown>;
        expect(Array.isArray(payload['agents'])).toBe(true);

        // Secret boundary: no Matrix user ids, signing keys, or tokens in the list.
        expect(JSON.stringify(result)).not.toMatch(SECRET_PATTERN);
      },
      30_000,
    );

    it(
      'mx_workspace_status: observe verb returns workspace + agent list with no secrets',
      async () => {
        if (!liveFixture) throw new Error('fixture not initialised');

        const result = (await liveFixture.mcpClient.callTool({
          name: 'mx_workspace_status',
          arguments: {},
        })) as CallToolResult;

        expect(result.isError ?? false).toBe(false);
        const sc = result.structuredContent as Record<string, unknown>;
        expect(sc['status']).toBe('ok');

        const payload = sc['result'] as Record<string, unknown>;
        // Must surface at least the workspace dimension and registered agents.
        expect(payload).toHaveProperty('workspace');
        expect(payload).toHaveProperty('agents');

        // Secret boundary: the raw Matrix `members[].user_id` list must have been
        // projected out (T108 design decision — identities are MX agent_ids).
        const raw = JSON.stringify(result);
        expect(raw).not.toMatch(SECRET_PATTERN);
        // Additionally, user_id values like @user:server should not appear in the
        // agents list (they were deliberately projected out in T108/T104).
        const agents = payload['agents'] as Array<Record<string, unknown>>;
        for (const agent of agents) {
          expect(agent).not.toHaveProperty('matrix_user_id');
          expect(agent).not.toHaveProperty('device_id');
          expect(agent).not.toHaveProperty('signing_key_id');
        }
      },
      30_000,
    );

    it(
      'idempotency: same idempotency_key on repeated mx_delegate_tool calls does not double-execute',
      async () => {
        if (!liveFixture || !coords) throw new Error('fixture not initialised');
        const idempotency_key = `mxl-mcp-idem-${randomUUID()}`;
        const callArgs = {
          agent: coords.targetAgentId,
          tool: coords.tool,
          args: { package: 'mx-loom-mcp-idempotency' },
          idempotency_key,
        };

        const first = (await liveFixture.mcpClient.callTool({
          name: 'mx_delegate_tool',
          arguments: callArgs,
        })) as CallToolResult;

        const second = (await liveFixture.mcpClient.callTool({
          name: 'mx_delegate_tool',
          arguments: callArgs,
        })) as CallToolResult;

        // Both must be non-error (daemon deduped the second call).
        expect(first.isError ?? false).toBe(false);
        expect(second.isError ?? false).toBe(false);

        // If the daemon surfaces an invocation_id in audit_ref, the replay must
        // reuse it — no second execution (T102 idempotency contract).
        const sc1 = first.structuredContent as Record<string, unknown>;
        const sc2 = second.structuredContent as Record<string, unknown>;
        const ref1 = sc1['audit_ref'] as Record<string, unknown> | null;
        const ref2 = sc2['audit_ref'] as Record<string, unknown> | null;
        const inv1 = ref1?.['invocation_id'];
        const inv2 = ref2?.['invocation_id'];
        if (inv1 !== null && inv1 !== undefined && inv2 !== null && inv2 !== undefined) {
          expect(inv2).toBe(inv1);
        }
      },
      180_000,
    );
  },
);

// ---------------------------------------------------------------------------
// AC3 — awaiting_approval surfaces correctly over MCP
//        and mx_await_result resolves the deferred handle
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_TWO_DAEMON)(
  'MCP conformance · AC3 — awaiting_approval + mx_await_result via live daemon',
  () => {
    let liveFixture: LiveMcpFixture | undefined;
    let coords: McpTwoDaemonFixture | undefined;

    beforeAll(async () => {
      assertTwoDaemonPrereqs();
      const fx = readMcpTwoDaemonFixture();
      if (fx === null) {
        throw new Error('MCP conformance AC3: fixture coordinates absent');
      }
      coords = fx;
      liveFixture = await createLiveMcpFixture(fx.room);
    });

    afterAll(async () => {
      await liveFixture?.close();
    });

    it(
      'approval-gated tool: surfaces awaiting_approval as isError=false with handle + approval metadata',
      async (ctx) => {
        if (!liveFixture || !coords) throw new Error('fixture not initialised');
        if (!coords.approvalTool) {
          // MXL_CONFORMANCE_APPROVAL_TOOL not set; mark as skipped — the AC3
          // live path cannot be exercised without the golden policy fixture.
          ctx.skip();
          return;
        }

        const result = (await liveFixture.mcpClient.callTool({
          name: 'mx_delegate_tool',
          arguments: {
            agent: coords.targetAgentId,
            tool: coords.approvalTool,
            args: {},
            idempotency_key: `mxl-mcp-approval-${randomUUID()}`,
          },
        })) as CallToolResult;

        // THE critical AC3 invariant: awaiting_approval is NOT a protocol error.
        // A runtime that sees isError=true would retry/abort rather than await.
        // The model must be able to read the approval metadata and continue planning.
        expect(result.isError ?? false).toBe(false);

        const sc = result.structuredContent as Record<string, unknown>;
        expect(sc['status']).toBe('awaiting_approval');

        // The handle must be present so the model can call mx_await_result.
        expect(typeof sc['handle']).toBe('string');
        expect((sc['handle'] as string).length).toBeGreaterThan(0);

        // The approval metadata must surface risk, summary, expires_at (secret-free).
        const approval = sc['approval'] as Record<string, unknown> | null;
        expect(approval).not.toBeNull();
        expect(approval).toHaveProperty('request_id');
        expect(approval).toHaveProperty('risk');
        // `risk` must be one of the closed set: low | medium | high
        expect(['low', 'medium', 'high']).toContain(approval?.['risk']);

        expect(validateEnvelope(sc)).toBe(true);
        expect(JSON.stringify(result)).not.toMatch(SECRET_PATTERN);
      },
      90_000,
    );

    it(
      'mx_await_result via MCP: wait_ms=0 probe returns current state without hanging',
      async (ctx) => {
        if (!liveFixture || !coords) throw new Error('fixture not initialised');
        if (!coords.approvalTool) {
          ctx.skip();
          return;
        }

        // Acquire a deferred handle by delegating the approval-gated tool.
        const delegateResult = (await liveFixture.mcpClient.callTool({
          name: 'mx_delegate_tool',
          arguments: {
            agent: coords.targetAgentId,
            tool: coords.approvalTool,
            args: {},
            idempotency_key: `mxl-mcp-await-${randomUUID()}`,
          },
        })) as CallToolResult;

        const delegateSc = delegateResult.structuredContent as Record<string, unknown>;
        if (delegateSc['status'] !== 'awaiting_approval') {
          // The tool did not hold for approval in this run (policy may differ).
          ctx.skip();
          return;
        }

        const handle = delegateSc['handle'] as string;

        // Probe the handle with wait_ms=0 — a single non-blocking read.
        // Must return immediately with the current state, never error on a valid handle.
        const awaitResult = (await liveFixture.mcpClient.callTool({
          name: 'mx_await_result',
          arguments: { handle, wait_ms: 0 },
        })) as CallToolResult;

        // mx_await_result is a pure observer — it never errors on a valid handle.
        // A still-pending awaiting_approval is not an error; it is valid in-progress state.
        const awaitSc = awaitResult.structuredContent as Record<string, unknown>;
        expect([
          'ok',
          'running',
          'awaiting_approval',
          'denied',
          'error',
        ]).toContain(awaitSc['status']);

        // A pending awaiting_approval from a wait_ms=0 probe must NOT be isError.
        if (awaitSc['status'] === 'awaiting_approval' || awaitSc['status'] === 'running') {
          expect(awaitResult.isError ?? false).toBe(false);
        }

        expect(validateEnvelope(awaitSc)).toBe(true);
        expect(JSON.stringify(awaitResult)).not.toMatch(SECRET_PATTERN);
      },
      90_000,
    );

    it(
      'mx_await_result: wait_ms expiry returns still-pending state, not errored(timeout)',
      async (ctx) => {
        if (!liveFixture || !coords) throw new Error('fixture not initialised');
        if (!coords.approvalTool) {
          ctx.skip();
          return;
        }

        const delegateResult = (await liveFixture.mcpClient.callTool({
          name: 'mx_delegate_tool',
          arguments: {
            agent: coords.targetAgentId,
            tool: coords.approvalTool,
            args: {},
            idempotency_key: `mxl-mcp-timeout-${randomUUID()}`,
          },
        })) as CallToolResult;

        const delegateSc = delegateResult.structuredContent as Record<string, unknown>;
        if (delegateSc['status'] !== 'awaiting_approval') {
          ctx.skip();
          return;
        }

        const handle = delegateSc['handle'] as string;

        // Poll with a short wait_ms (100ms) that is certain to expire before the
        // human operator decides. The T103 contract: a wait_ms expiry must return
        // the still-pending envelope with error=null — NEVER errored('timeout').
        // The `timeout` code is reserved for a genuine transport fault.
        const awaitResult = (await liveFixture.mcpClient.callTool({
          name: 'mx_await_result',
          arguments: { handle, wait_ms: 100 },
        })) as CallToolResult;

        const awaitSc = awaitResult.structuredContent as Record<string, unknown>;

        // A wait_ms=100 expiry must NOT produce errored('timeout') — it returns
        // the pending state (running | awaiting_approval) with error: null.
        if (awaitSc['status'] === 'running' || awaitSc['status'] === 'awaiting_approval') {
          expect(awaitSc['error']).toBeNull();
          expect(awaitResult.isError ?? false).toBe(false);
        } else {
          // The operator decided before the 100ms window — ok or denied; either
          // is valid. We can't assert the pending path in this run.
          expect(['ok', 'denied']).toContain(awaitSc['status']);
        }

        expect(validateEnvelope(awaitSc)).toBe(true);
        expect(JSON.stringify(awaitResult)).not.toMatch(SECRET_PATTERN);
      },
      90_000,
    );

    it(
      'denied path: an operator-denied approval resolves to denied envelope with isError=false',
      async (ctx) => {
        if (!liveFixture || !coords) throw new Error('fixture not initialised');
        if (!coords.approvalTool) {
          ctx.skip();
          return;
        }

        // Acquire a handle and poll for up to 5 s. If the CI bring-up pre-denies
        // the approval (operator script decides immediately), the poll resolves quickly.
        const delegateResult = (await liveFixture.mcpClient.callTool({
          name: 'mx_delegate_tool',
          arguments: {
            agent: coords.targetAgentId,
            tool: coords.approvalTool,
            args: {},
            idempotency_key: `mxl-mcp-denied-${randomUUID()}`,
          },
        })) as CallToolResult;

        const delegateSc = delegateResult.structuredContent as Record<string, unknown>;
        if (delegateSc['status'] !== 'awaiting_approval') {
          ctx.skip();
          return;
        }

        const handle = delegateSc['handle'] as string;

        const awaitResult = (await liveFixture.mcpClient.callTool({
          name: 'mx_await_result',
          arguments: { handle, wait_ms: 5_000 },
        })) as CallToolResult;

        const awaitSc = awaitResult.structuredContent as Record<string, unknown>;

        // Still pending — operator has not decided; skip rather than silently pass.
        if (awaitSc['status'] === 'awaiting_approval' || awaitSc['status'] === 'running') {
          ctx.skip();
          return;
        }

        // When the operator explicitly denied: `denied` with approval_denied/approval_expired.
        if (awaitSc['status'] === 'denied') {
          // The denial is a governance outcome, NOT a protocol error.
          expect(awaitResult.isError ?? false).toBe(false);
          const err = awaitSc['error'] as Record<string, unknown> | null;
          expect(err).not.toBeNull();
          expect(['approval_denied', 'approval_expired']).toContain(err?.['code']);
        }

        // When the operator approved instead (also valid in CI): non-error ok.
        if (awaitSc['status'] === 'ok') {
          expect(awaitResult.isError ?? false).toBe(false);
        }

        expect(validateEnvelope(awaitSc)).toBe(true);
        expect(JSON.stringify(awaitResult)).not.toMatch(SECRET_PATTERN);
      },
      60_000,
    );
  },
);
