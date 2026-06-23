/**
 * MCP binding conformance harness (T109 / #17) — two-daemon fixture setup.
 *
 * Wire model for conformance tests:
 *   MCP Client → InMemoryTransport ↔ MCP Server → BindingContext
 *                → real MxClient → daemon Unix socket → daemon A → daemon B
 *
 * The same `MXL_CONFORMANCE_TWO_DAEMON=1` env flag and fixture-coordinate
 * convention as the toolbelt conformance harness (`packages/toolbelt/test/
 * conformance/_harness.ts`) apply here. This file re-implements only the
 * parts it needs rather than importing from a test directory that is not on any
 * package-exports surface.
 *
 * This file is NOT a test file (leading underscore, no `.test.ts` suffix) so
 * vitest never collects it as a suite.
 */
import { existsSync } from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { NullAuditSink } from '@mx-loom/audit';
import { createClient } from '@mx-loom/toolbelt';
import type { MxClient } from '@mx-loom/toolbelt';

import { createBindingContext } from '../../src/context.js';
import { createMcpServer } from '../../src/server.js';

// ---------------------------------------------------------------------------
// Env flags (mirrors the toolbelt harness; replicated to avoid cross-test-dir
// imports that are not on any package exports surface)
// ---------------------------------------------------------------------------

/** `MXL_CONFORMANCE_TWO_DAEMON=1` — set only when the two-daemon fixture is up. */
export function isTwoDaemonRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['MXL_CONFORMANCE_TWO_DAEMON'] === '1';
}

/**
 * Resolve the daemon socket path from the environment.
 * Priority: `MXL_CONFORMANCE_SOCKET` → `$XDG_RUNTIME_DIR/mx-agent/daemon.sock`
 * → `$HOME/.local/share/mx-agent/daemon.sock`.
 */
function resolveDaemonSocket(env: NodeJS.ProcessEnv = process.env): string {
  if (env['MXL_CONFORMANCE_SOCKET']) return env['MXL_CONFORMANCE_SOCKET'];
  const xdg = env['XDG_RUNTIME_DIR'];
  if (xdg) return `${xdg}/mx-agent/daemon.sock`;
  const home = env['HOME'] ?? '/root';
  return `${home}/.local/share/mx-agent/daemon.sock`;
}

/** Whether the daemon socket file exists (the cheap reachability probe). */
export function isDaemonReachable(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(resolveDaemonSocket(env));
}

// Module-level snapshots evaluated once at import — used by `describe.skipIf`.
export const TWO_DAEMON_REQUIRED = isTwoDaemonRequired();
export const DAEMON_REACHABLE = isDaemonReachable();

/**
 * Skip the MCP conformance suite unless the two-daemon fixture is explicitly
 * declared up AND a daemon is reachable. Mirrors the toolbelt's `SKIP_TWO_DAEMON`.
 */
export const SKIP_TWO_DAEMON = !TWO_DAEMON_REQUIRED || !DAEMON_REACHABLE;

// ---------------------------------------------------------------------------
// Fail-not-skip prerequisite check
// ---------------------------------------------------------------------------

/**
 * Throw (→ hard failure) when `MXL_CONFORMANCE_TWO_DAEMON=1` but no daemon is
 * reachable. Call inside `beforeAll` so vitest marks the suite red, not skipped.
 */
export function assertTwoDaemonPrereqs(
  required: boolean = TWO_DAEMON_REQUIRED,
  reachable: boolean = DAEMON_REACHABLE,
): void {
  if (required && !reachable) {
    throw new Error(
      'MCP conformance gate (two-daemon): MXL_CONFORMANCE_TWO_DAEMON=1 but no mx-agent ' +
        'daemon is reachable at the conformance socket. ' +
        'Bring up the pinned v0.2.1 daemon pair, or unset the flag to run locally. ' +
        'A missing daemon must FAIL the conformance job (never silently skip) — ' +
        'otherwise "red on surface drift" degrades to "always green".',
    );
  }
}

// ---------------------------------------------------------------------------
// Two-daemon fixture coordinates (exported by the CI bring-up via env vars)
// ---------------------------------------------------------------------------

/**
 * Fixture coordinates for the MCP two-daemon conformance suite.
 * Mirrors the toolbelt's `TwoDaemonFixture`; replicated here to stay self-contained.
 */
export interface McpTwoDaemonFixture {
  /** Shared workspace room daemon A and B both joined (`!…:server`). */
  room: string;
  /** Agent id of daemon B's registered target agent. */
  targetAgentId: string;
  /** Named tool B publishes and policy allows (e.g. `run_tests@1.0.0`). */
  tool: string;
  /**
   * Named tool B publishes but policy DENIES — the deny-by-default negative
   * case. Set via `MXL_CONFORMANCE_DENIED_TOOL`. Optional; tests that need it
   * skip when absent.
   */
  deniedTool: string | undefined;
  /**
   * Named tool B's golden policy holds for operator approval
   * (`requires_approval=true` in `policy.golden.toml`).
   * Set via `MXL_CONFORMANCE_APPROVAL_TOOL`. When present, tests exercise the
   * `awaiting_approval` → non-error MCP result path (T109 AC3 live arm).
   * Required for the AC3 assertion; tests that need it skip when absent.
   */
  approvalTool: string | undefined;
}

/**
 * Read the two-daemon fixture coordinates from the environment.
 * Returns `null` if any required field (`room`, `targetAgentId`, `tool`) is absent.
 */
export function readMcpTwoDaemonFixture(
  env: NodeJS.ProcessEnv = process.env,
): McpTwoDaemonFixture | null {
  const room = env['MXL_CONFORMANCE_ROOM'];
  const targetAgentId = env['MXL_CONFORMANCE_TARGET_AGENT'];
  const tool = env['MXL_CONFORMANCE_TOOL'];
  if (!room || !targetAgentId || !tool) return null;
  return {
    room,
    targetAgentId,
    tool,
    deniedTool: env['MXL_CONFORMANCE_DENIED_TOOL'],
    approvalTool: env['MXL_CONFORMANCE_APPROVAL_TOOL'],
  };
}

// ---------------------------------------------------------------------------
// Live MCP fixture — MCP Client wired to a real BindingContext
// ---------------------------------------------------------------------------

/**
 * A live MCP fixture: an open MCP `Client` connected over `InMemoryTransport`
 * to an MCP `Server` backed by a real `MxClient` → daemon socket.
 *
 * The `InMemoryTransport` exercises the full MCP message encoding/decoding path;
 * the real `MxClient` exercises the actual `call.start` / `agent.list` / … RPC
 * round-trips. Together they validate every layer of the T109 binding without
 * spawning the stdio bin or requiring a network address.
 *
 * Call `close()` in `afterAll` to tear down both the MCP connection and the
 * underlying daemon socket client. Idempotent.
 */
export interface LiveMcpFixture {
  /** In-process MCP client connected to the binding server. */
  mcpClient: Client;
  /** Underlying real `MxClient` (for direct daemon assertions when needed). */
  mxClient: MxClient;
  /** Tear down the MCP connection and close the daemon client. Idempotent. */
  close: () => Promise<void>;
}

/**
 * Build a live MCP fixture for the given workspace room:
 *   `createClient()` → `BindingContext({ daemon, room })` → `createMcpServer`
 *   → `InMemoryTransport` → MCP `Client`.
 *
 * `room` must be the workspace room daemon A joined (from the fixture coords).
 * It flows through the `BindingContext` into every room-scoped verb — never
 * through model args (design §1/§7).
 */
export async function createLiveMcpFixture(room: string): Promise<LiveMcpFixture> {
  const mxClient = createClient();
  const ctx = await createBindingContext({
    daemon: mxClient,
    room,
    auditSink: new NullAuditSink(),
  });
  const server = createMcpServer(ctx);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: 'mcp-conformance-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

  let closed = false;
  return {
    mcpClient,
    mxClient,
    close: async () => {
      if (closed) return;
      closed = true;
      await mcpClient.close();
      await mxClient.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Shared assertion vocabulary
// ---------------------------------------------------------------------------

/**
 * Secret-shaped patterns that must NEVER appear in any MCP response.
 * Mirrors the toolbelt conformance harness `SECRET_PATTERN`.
 */
export const SECRET_PATTERN = /MATRIX_|MX_AGENT_|syt_[a-z]|ghp_|xox[bp]-/;
