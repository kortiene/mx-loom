/**
 * Shared harness for the toolbelt ⇄ daemon **conformance** suite (T007 / #7).
 *
 * The conformance suite verifies the toolbelt's assumed `mx-agent` daemon
 * surface (Boundary B) against a **live, pinned** daemon, and is the executable
 * gate the pin-bump policy (`docs/mx-agent-pin.md`) already names. This module
 * is the seam every tier shares. It is **not** a test file (leading underscore,
 * no `.test.ts` suffix) so vitest never collects it as a suite.
 *
 * The single behavioral difference from the existing `*.integration.test.ts`
 * suites is the **fail-not-skip** rule:
 *
 * - On a developer laptop / the fast unit CI (no `MXL_CONFORMANCE`), a missing
 *   daemon makes the suite **skip cleanly** — exactly like the integration
 *   suites — so `pnpm test:conformance` is harmless without a daemon.
 * - In the conformance CI job (`MXL_CONFORMANCE=1`), a missing / unreachable
 *   daemon is a **hard failure**. Otherwise "red on drift" would silently
 *   degrade to "always green" the moment the daemon failed to come up.
 *
 * Tier 2 (`call.start` delegation) additionally needs a *two-daemon* fixture, so
 * it guards on `MXL_CONFORMANCE_TWO_DAEMON=1` plus the fixture coordinates the
 * bring-up exports — letting the cheap single-daemon tiers land and stay green
 * while the heavier two-daemon bring-up is being stood up.
 *
 * Everything here is intentionally pure / injectable (env + paths are
 * parameters) so the gate logic itself is unit-testable daemon-free — see
 * `test/conformance-harness.test.ts`, which runs in the normal suite.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveSocketPath } from '../../src/ipc/socket-path.js';

// ---------------------------------------------------------------------------
// Env flags (CI-only switches; documented in the toolbelt README + pin doc)
// ---------------------------------------------------------------------------

/** `MXL_CONFORMANCE=1` — set ONLY by the conformance CI job. */
export function isConformanceRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['MXL_CONFORMANCE'] === '1';
}

/** `MXL_CONFORMANCE_TWO_DAEMON=1` — set only when the two-daemon fixture is up. */
export function isTwoDaemonRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['MXL_CONFORMANCE_TWO_DAEMON'] === '1';
}

/**
 * The daemon socket the conformance suite probes. Honors an explicit
 * `MXL_CONFORMANCE_SOCKET` override (the CI bring-up exports the isolated
 * per-run socket here); otherwise the standard resolution
 * (`resolveSocketPath`).
 */
export function conformanceSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveSocketPath({ socketPath: env['MXL_CONFORMANCE_SOCKET'], env });
}

/** Whether the daemon socket file exists (the cheap reachability probe). */
export function isDaemonReachable(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(conformanceSocketPath(env));
}

// Module-level snapshots for `describe.skipIf(...)` (evaluated once at import).
export const CONFORMANCE_REQUIRED = isConformanceRequired();
export const TWO_DAEMON_REQUIRED = isTwoDaemonRequired();
export const DAEMON_REACHABLE = isDaemonReachable();

/**
 * Skip the single-daemon tiers (0/1) only when conformance is NOT required and
 * no daemon is reachable. Under `MXL_CONFORMANCE=1` the suite runs and the
 * `beforeAll` prereq check converts an unreachable daemon into a failure.
 */
export const SKIP_SINGLE_DAEMON = !CONFORMANCE_REQUIRED && !DAEMON_REACHABLE;

/**
 * Skip Tier 2 (`call.start`) unless the two-daemon fixture is explicitly
 * declared up AND a daemon is reachable. This keeps the single-daemon
 * conformance job from failing for lack of daemon B.
 */
export const SKIP_TWO_DAEMON = !TWO_DAEMON_REQUIRED || !DAEMON_REACHABLE;

// ---------------------------------------------------------------------------
// Fail-not-skip prerequisite check (pure → unit-testable)
// ---------------------------------------------------------------------------

export interface PrereqInput {
  /** Is this tier *required* to run (the relevant `MXL_CONFORMANCE*` flag is set)? */
  required: boolean;
  /** Is the daemon reachable? */
  reachable: boolean;
  /** Tier label for the error message. */
  tier: string;
}

/**
 * The gate decision, as a pure function so both branches are unit-testable
 * without touching `process.env`. Returns an `Error` to throw (a HARD failure)
 * when the tier is required but its daemon is missing; otherwise `null`.
 */
export function conformancePrereqError(input: PrereqInput): Error | null {
  if (input.required && !input.reachable) {
    return new Error(
      `conformance gate (${input.tier}): MXL_CONFORMANCE flag is set but no mx-agent ` +
        `daemon is reachable at the conformance socket. A missing daemon must FAIL the ` +
        `conformance job (never silently skip) — otherwise "red on surface drift" degrades ` +
        `to "always green". Bring up the pinned daemon, or unset the flag to run locally.`,
    );
  }
  return null;
}

/**
 * Use inside a single-daemon tier's `beforeAll`: throws (→ red) when
 * `MXL_CONFORMANCE=1` but no daemon is reachable; no-op otherwise.
 */
export function assertSingleDaemonPrereqs(
  required = CONFORMANCE_REQUIRED,
  reachable = DAEMON_REACHABLE,
): void {
  const err = conformancePrereqError({ required, reachable, tier: 'single-daemon (Tier 0/1)' });
  if (err) throw err;
}

/**
 * Use inside Tier 2's `beforeAll`: throws when `MXL_CONFORMANCE_TWO_DAEMON=1`
 * but the daemon or the fixture coordinates are missing; no-op otherwise.
 */
export function assertTwoDaemonPrereqs(
  required = TWO_DAEMON_REQUIRED,
  reachable = DAEMON_REACHABLE,
  fixture: TwoDaemonFixture | null = readTwoDaemonFixture(),
): void {
  const err = conformancePrereqError({ required, reachable, tier: 'two-daemon (Tier 2)' });
  if (err) throw err;
  if (required && fixture === null) {
    throw new Error(
      `conformance gate (two-daemon Tier 2): MXL_CONFORMANCE_TWO_DAEMON=1 but the fixture ` +
        `coordinates are incomplete. Expected MXL_CONFORMANCE_ROOM, MXL_CONFORMANCE_TARGET_AGENT, ` +
        `and MXL_CONFORMANCE_TOOL (the named tool agent B publishes) in the environment.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Pinned version reader
// ---------------------------------------------------------------------------

/** Drop a single leading `v`: `.mx-agent-version` records `v0.2.1`; `daemon.status` reports `0.2.1`. */
export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/, '');
}

/** Walk up from this file to find the repo-root `.mx-agent-version`. */
function locatePinFile(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, '.mx-agent-version');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('conformance harness: could not locate .mx-agent-version walking up from the test dir');
}

export interface PinnedVersion {
  /** As recorded in the file, e.g. `v0.2.1`. */
  raw: string;
  /** With the leading `v` stripped, e.g. `0.2.1` — compare against `daemon.status.version`. */
  normalized: string;
}

/**
 * Read the pinned `mx-agent` version from `.mx-agent-version` (the single source
 * of truth; never hard-code the tag). Pass an explicit path in tests.
 */
export function readPinnedVersion(pinFilePath: string = locatePinFile()): PinnedVersion {
  const raw = readFileSync(pinFilePath, 'utf8').trim();
  if (raw.length === 0) {
    throw new Error(`conformance harness: ${pinFilePath} is empty`);
  }
  return { raw, normalized: normalizeVersion(raw) };
}

// ---------------------------------------------------------------------------
// Two-daemon fixture coordinates (exported by the CI bring-up; absent locally)
// ---------------------------------------------------------------------------

export interface TwoDaemonFixture {
  /** Shared workspace room daemon A and B both joined. */
  room: string;
  /** Agent id of daemon B's registered target agent. */
  targetAgentId: string;
  /** Named tool B publishes and policy allows, e.g. `run_tests@1.0.0`. */
  tool: string;
  /** Optional named tool B publishes but policy DENIES — the deny-by-default negative case. */
  deniedTool: string | undefined;
  /**
   * Optional allowlisted command B's policy permits (e.g. `echo`).
   * Set via `MXL_CONFORMANCE_ALLOWED_COMMAND`. Required for the exec conformance
   * allow-path (AC 2); tests that need it skip when absent.
   */
  allowedCommand: string | undefined;
  /**
   * Optional command that B's policy denies — either un-allowlisted (AC 1) or one
   * whose args trip `deny_args_regex` (AC 3). A command that is simply absent from
   * `allow_commands` is the safest default (no policy authoring needed beyond the
   * empty/default `policy.toml`). Set via `MXL_CONFORMANCE_DENIED_COMMAND`.
   */
  deniedCommand: string | undefined;
}

/** Read the Tier 2 fixture coordinates from the env; `null` if any required field is absent. */
export function readTwoDaemonFixture(env: NodeJS.ProcessEnv = process.env): TwoDaemonFixture | null {
  const room = env['MXL_CONFORMANCE_ROOM'];
  const targetAgentId = env['MXL_CONFORMANCE_TARGET_AGENT'];
  const tool = env['MXL_CONFORMANCE_TOOL'];
  if (!room || !targetAgentId || !tool) return null;
  return {
    room,
    targetAgentId,
    tool,
    deniedTool: env['MXL_CONFORMANCE_DENIED_TOOL'],
    allowedCommand: env['MXL_CONFORMANCE_ALLOWED_COMMAND'],
    deniedCommand: env['MXL_CONFORMANCE_DENIED_COMMAND'],
  };
}

// ---------------------------------------------------------------------------
// Shared assertion vocabulary
// ---------------------------------------------------------------------------

/**
 * The closed `TransportErrorCode` set (mirrors `src/ipc/errors.ts` `IpcErrorCode`).
 * Tier 1's error-taxonomy assertions pin to this — drift in error *behavior*
 * (a new code, or a non-`TransportError` thrown) fails the suite. Kept in sync
 * with the source union by the harness unit test.
 */
export const CLOSED_TRANSPORT_CODES = [
  'not_running',
  'connect_failed',
  'timeout',
  'closed',
  'frame',
  'protocol',
  'rpc',
  'invalid_args',
] as const;

/**
 * Secret-shaped patterns that must NEVER appear in any record the suite reads
 * back from the daemon. Reused verbatim from the session integration suite's
 * debug-seam assertion — the secret boundary (Boundary A) must hold in the
 * conformance harness too: `agent.register` returns only the **public**
 * `signing_public_key` / `signing_key_id`, never a private key or token.
 */
export const SECRET_PATTERN = /MATRIX_|MX_AGENT_|syt_[a-z]|ghp_|xox[bp]-/;

/** Field names the toolbelt's `AgentState` type depends on — asserted present in Tier 1. */
export const AGENT_STATE_FIELDS = [
  'agent_id',
  'kind',
  'matrix_user_id',
  'device_id',
  'signing_key_id',
  'signing_public_key',
  'status',
  'capabilities',
  'tools',
  'workspace',
  'load',
  'last_seen_ts',
  'state_rev',
] as const;
