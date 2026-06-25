/**
 * T205 / #27 — Pi binding end-to-end acceptance test.
 *
 * Issue AC: "A Pi agent calls mx_delegate_tool and receives the result"
 * via the @mx-loom/pi native tool registration binding.
 *
 * Stack under test:
 *   @mx-loom/pi createPiToolDefinitions → ToolDefinition.execute()
 *   → BindingContext (live MxSession) → daemon A socket
 *   → call.start → daemon B → T102 envelope
 *   → Pi AgentToolResult (content[0].text + details)
 *
 * This exercises the FULL Pi binding path (the "native registration" approach
 * mandated by T204's decision that Pi has no built-in MCP client):
 *  - createPiBindingContext opens a real MxSession (agent.register + heartbeat)
 *  - createPiToolDefinitions converts CANONICAL_M1_TOOLS → ToolDefinition[]
 *  - execute() routes through the Pi binding's dispatch → registry handlers →
 *    real toolbelt MxClient → live daemon A → daemon B
 *  - The T102 result envelope lands in Pi's AgentToolResult (content + details)
 *
 * TypeBox builders:
 *   When a real @earendil-works/pi-coding-agent is resolvable (via
 *   MXL_PI_PACKAGE_ROOT or a workspace peer), we import the real TypeBox +
 *   pi-ai `StringEnum` from that tree — this exercises the schema-adapter path
 *   that Google-provider Pi runs depend on. Otherwise we fall back to inline
 *   fake builders (the same ABI-shaped shim the pi daemon-free suite uses) so
 *   the live-daemon path is still exercised without a Pi SDK install.
 *
 * Gating (mirrors the T204 / T201 ADK patterns):
 *   - MXL_PI_BINDING_E2E=1 (or MXL_PI_PACKAGE_ROOT set) → the suite is
 *     *requested*; any missing prereq (Pi SDK, daemon, fixture) is a HARD
 *     FAILURE rather than a clean skip.
 *   - Neither flag set AND Pi not installed → clean skip (developer laptop /
 *     fast unit CI).
 *   - MXL_CONFORMANCE_TWO_DAEMON=1 required once the suite is requested.
 *
 * This test is the building block T206 (cross-runtime Pi portability arm) uses.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NullAuditSink } from '@mx-loom/audit';
import {
  createPiBindingContext,
  createPiToolDefinitions,
} from '@mx-loom/pi';
import type { BindingContext, ToolDefinition } from '@mx-loom/pi';
import {
  CANONICAL_M1_TOOLS,
  isForbiddenAuthorityVerb,
  validateEnvelope,
} from '@mx-loom/registry';
import type { ToolResult } from '@mx-loom/registry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SECRET_PATTERN,
  isDaemonReachable,
  isTwoDaemonRequired,
  resolveDaemonSocket,
} from './_golden-harness.js';
import { PI_PACKAGE_ROOT_ENV, resolvePiBuilders, resolvePiPackageRoot } from './_pi-builders.js';

// ---------------------------------------------------------------------------
// Env flags
// ---------------------------------------------------------------------------

const PI_E2E_ENV = 'MXL_PI_BINDING_E2E';

// Pi SDK resolution + the TypeBox-builder seam now live in the shared
// `_pi-builders.ts` (also consumed by the T206 portability matrix's Pi arm).

// ---------------------------------------------------------------------------
// Fixture coordinates (same env vars as T201 ADK / T114 golden)
// ---------------------------------------------------------------------------

interface PiE2eFixture {
  readonly room: string;
  readonly targetAgentId: string;
  readonly allowTool: string;
}

function readPiE2eFixture(env: NodeJS.ProcessEnv = process.env): PiE2eFixture | null {
  const room = env['MXL_CONFORMANCE_ROOM'];
  const targetAgentId = env['MXL_CONFORMANCE_TARGET_AGENT'];
  const allowTool = env['MXL_CONFORMANCE_TOOL'];
  if (!room || !targetAgentId || !allowTool) return null;
  return { room, targetAgentId, allowTool };
}

// ---------------------------------------------------------------------------
// Gate logic — module-level snapshots (evaluated once at import)
// ---------------------------------------------------------------------------

const resolvedPi = resolvePiPackageRoot();

const isPiE2eRequested: boolean =
  process.env[PI_E2E_ENV] === '1' ||
  (process.env[PI_PACKAGE_ROOT_ENV] !== undefined &&
    process.env[PI_PACKAGE_ROOT_ENV]!.trim() !== '');

/** Clean skip when neither requested explicitly nor Pi is auto-detected. */
const skipPiBinding = !isPiE2eRequested && resolvedPi.root === null;

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe.skipIf(skipPiBinding)('T205 e2e · @mx-loom/pi — Pi agent calls mx_delegate_tool (native binding)', () => {
  let ctx: BindingContext | null = null;
  let tools: ToolDefinition[] = [];
  let fixture: PiE2eFixture | null = null;
  let tmp = '';

  beforeAll(async () => {
    // -----------------------------------------------------------------------
    // Fail-not-skip when the suite is requested but prereqs are missing.
    // -----------------------------------------------------------------------
    if (isPiE2eRequested && resolvedPi.root === null && process.env[PI_E2E_ENV] === '1') {
      throw new Error(
        'T205 Pi binding e2e was requested with MXL_PI_BINDING_E2E=1, but no ' +
          '@earendil-works/pi-coding-agent package root was found. Set MXL_PI_PACKAGE_ROOT ' +
          'to an installed Pi package root, or unset MXL_PI_BINDING_E2E for a clean skip.',
      );
    }

    if (!isTwoDaemonRequired()) {
      throw new Error(
        'T205 Pi binding e2e was requested but MXL_CONFORMANCE_TWO_DAEMON=1 is not set. ' +
          'The Pi binding e2e requires the two-daemon fixture (daemon A + daemon B with a ' +
          'shared room and the allow-tool policy). Set MXL_CONFORMANCE_TWO_DAEMON=1 or unset ' +
          'MXL_PI_BINDING_E2E to skip cleanly.',
      );
    }

    if (!isDaemonReachable()) {
      throw new Error(
        `T205 Pi binding e2e: no mx-agent daemon is reachable at ${resolveDaemonSocket()}. ` +
          'Bring up daemon A (the caller daemon) before requesting the Pi e2e, or unset ' +
          'MXL_PI_BINDING_E2E to skip cleanly.',
      );
    }

    fixture = readPiE2eFixture();
    if (fixture === null) {
      throw new Error(
        'T205 Pi binding e2e: fixture coordinates are incomplete. Expected ' +
          'MXL_CONFORMANCE_ROOM, MXL_CONFORMANCE_TARGET_AGENT, and MXL_CONFORMANCE_TOOL ' +
          'from the bring-up scripts (bootstrap-daemon-a.sh / bootstrap-daemon-b.sh).',
      );
    }

    tmp = mkdtempSync(join(tmpdir(), 'mxl-t205-pi-'));

    // -----------------------------------------------------------------------
    // TypeBox builders: use real Pi TypeBox when available, else inline shim.
    // -----------------------------------------------------------------------
    const { builders } = await resolvePiBuilders(resolvedPi);

    // -----------------------------------------------------------------------
    // Live binding context: open an MxSession (agent.register + heartbeat).
    // room always comes from the session, NEVER from model tool args.
    // -----------------------------------------------------------------------
    ctx = await createPiBindingContext({
      sessionOptions: { room: fixture.room, kind: 'pi' },
      auditSink: new NullAuditSink(),
    });

    // -----------------------------------------------------------------------
    // Generate Pi ToolDefinition[] from CANONICAL_M1_TOOLS (fail-closed).
    // -----------------------------------------------------------------------
    tools = createPiToolDefinitions(ctx, { builders });
  }, 60_000);

  afterAll(async () => {
    if (ctx !== null) await ctx.close();
    if (tmp !== '') rmSync(tmp, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // No-authority surface: generated tools must be exactly the nine mx_* verbs.
  // -------------------------------------------------------------------------

  it('generates exactly the canonical mx_* verbs — no authority verb is reachable', () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(CANONICAL_M1_TOOLS.map((d) => d.name).sort());
    for (const tool of tools) {
      // trust.* / approval.decide / policy.* / auth.* / device.* / daemon.*
      // must be structurally absent from the Pi native tool surface.
      expect(
        isForbiddenAuthorityVerb(tool.name),
        `forbidden authority verb registered as a Pi tool: ${tool.name}`,
      ).toBe(false);
    }
    // No secret-shaped value in the generated tool metadata.
    const serialized = JSON.stringify(tools.map((t) => ({
      name: t.name,
      label: t.label,
      description: t.description,
      promptSnippet: t.promptSnippet,
      promptGuidelines: t.promptGuidelines,
    })));
    expect(serialized).not.toMatch(SECRET_PATTERN);
  });

  // -------------------------------------------------------------------------
  // Issue AC: a Pi agent calls mx_delegate_tool and receives the result.
  //
  // Drives the full native-binding path end-to-end:
  //   ToolDefinition.execute() → dispatch → mxDelegateTool handler
  //     → MxSession.call('call.start') → daemon A → daemon B
  //     → T102 ok envelope with populated audit_ref.invocation_id
  //     → Pi AgentToolResult (content[0].text + details)
  // -------------------------------------------------------------------------

  it(
    'issue AC: mx_delegate_tool via Pi native registration returns status ok (live two-daemon)',
    async () => {
      if (!fixture) throw new Error('fixture not loaded');

      const tool = tools.find((t) => t.name === 'mx_delegate_tool');
      if (!tool) throw new Error('mx_delegate_tool not in generated Pi tools');

      const out = await tool.execute('t205-e2e-delegate', {
        agent: fixture.targetAgentId,
        tool: fixture.allowTool,
        args: {},
        wait_ms: 60_000,
      });

      // The full T102 envelope must be present in both channels.
      expect(out.content).toHaveLength(1);
      expect(out.content[0]?.type).toBe('text');
      const fromText = JSON.parse(out.content[0]!.text) as ToolResult;
      expect(JSON.stringify(fromText)).toEqual(JSON.stringify(out.details));

      // Validate the T102 envelope schema.
      const env = out.details as ToolResult;
      expect(validateEnvelope(env), 'T102 envelope must validate against ENVELOPE_SCHEMA').toBe(true);

      // The delegation must succeed end-to-end.
      expect(env.status, 'live mx_delegate_tool must return status ok').toBe('ok');

      // A live daemon always populates audit_ref.invocation_id (a signed
      // com.mxagent.call.request.v1 event was emitted on the room).
      expect(
        env.audit_ref.invocation_id,
        'live delegation must carry a populated audit_ref.invocation_id',
      ).toBeTruthy();

      // Boundary A: no secret-shaped value in the Pi AgentToolResult.
      expect(JSON.stringify(out), 'secret-shaped value in Pi tool output').not.toMatch(SECRET_PATTERN);
    },
    90_000,
  );

  // -------------------------------------------------------------------------
  // Non-delegation verbs: mx_find_agents round-trips through the live daemon.
  // -------------------------------------------------------------------------

  it(
    'mx_find_agents round-trips through the live daemon and returns status ok',
    async () => {
      const tool = tools.find((t) => t.name === 'mx_find_agents');
      if (!tool) throw new Error('mx_find_agents not in generated Pi tools');

      const out = await tool.execute('t205-e2e-find', {});

      const env = out.details as ToolResult;
      expect(validateEnvelope(env)).toBe(true);
      expect(env.status).toBe('ok');
      const result = env.result as { agents: unknown[] } | null;
      expect(Array.isArray(result?.agents), 'mx_find_agents must return an agents array').toBe(true);
      expect(JSON.stringify(out)).not.toMatch(SECRET_PATTERN);
    },
    30_000,
  );

  // -------------------------------------------------------------------------
  // Deferred-result tool: mx_await_result is reachable via native registration.
  // -------------------------------------------------------------------------

  it(
    'mx_await_result is in the Pi native tool set and returns a valid envelope for a non-existent handle',
    async () => {
      const tool = tools.find((t) => t.name === 'mx_await_result');
      if (!tool) throw new Error('mx_await_result not in generated Pi tools');

      // A made-up handle that the daemon will not find — the handler should
      // return a deterministic not_found / internal error (never throw).
      const out = await tool.execute('t205-e2e-await', { handle: 'inv_t205_fake_handle' });
      const env = out.details as ToolResult;
      expect(validateEnvelope(env)).toBe(true);
      // Any well-formed terminal status is acceptable for a non-existent handle.
      expect(['ok', 'denied', 'error']).toContain(env.status);
      expect(JSON.stringify(out)).not.toMatch(SECRET_PATTERN);
    },
    30_000,
  );

  // -------------------------------------------------------------------------
  // Deferred result: mx_delegate_tool with wait_ms=0 returns either ok (inline
  // terminal) or running/awaiting_approval (deferred) — never a throw.
  // -------------------------------------------------------------------------

  it(
    'mx_delegate_tool with wait_ms=0 returns a valid T102 envelope (inline or deferred)',
    async () => {
      if (!fixture) throw new Error('fixture not loaded');

      const tool = tools.find((t) => t.name === 'mx_delegate_tool');
      if (!tool) throw new Error('mx_delegate_tool not in generated Pi tools');

      const out = await tool.execute('t205-e2e-delegate-nowait', {
        agent: fixture.targetAgentId,
        tool: fixture.allowTool,
        args: {},
        wait_ms: 0,
      });

      const env = out.details as ToolResult;
      expect(validateEnvelope(env)).toBe(true);
      // wait_ms=0 → any terminal or non-terminal status is valid
      expect(['ok', 'running', 'awaiting_approval', 'denied', 'error']).toContain(env.status);
      expect(JSON.stringify(out)).not.toMatch(SECRET_PATTERN);
    },
    60_000,
  );

  // -------------------------------------------------------------------------
  // Secret boundary: credential-shaped arg is rejected before dispatch.
  // -------------------------------------------------------------------------

  it(
    'secret boundary: credential-shaped arg in mx_delegate_tool args is rejected with invalid_args',
    async () => {
      if (!fixture) throw new Error('fixture not loaded');

      const tool = tools.find((t) => t.name === 'mx_delegate_tool');
      if (!tool) throw new Error('mx_delegate_tool not in generated Pi tools');

      const out = await tool.execute('t205-e2e-cred-arg', {
        agent: fixture.targetAgentId,
        tool: fixture.allowTool,
        args: { access_token: 'syt_fake_token_should_be_rejected' },
      });

      const env = out.details as { status: string; error: { code: string } | null };
      expect(env.status).toBe('error');
      expect(env.error?.code).toBe('invalid_args');
      // The rejected credential must NOT appear in the error text.
      expect(out.content[0]!.text).not.toContain('syt_fake_token_should_be_rejected');
      expect(JSON.stringify(out.details)).not.toContain('syt_fake_token_should_be_rejected');
    },
    30_000,
  );
});
