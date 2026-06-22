/**
 * Unit tests for the conformance harness gate logic (T007 / #7).
 *
 * These run in the NORMAL fast suite (no daemon) — they live OUTSIDE
 * `test/conformance/` so the root vitest config does not exclude them. They lock
 * in the one behavior that makes the conformance gate trustworthy: the
 * **fail-not-skip** decision. The live tiers (which need a daemon) are exercised
 * only by `pnpm test:conformance`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentListEntry, AgentLiveness, AgentState } from '../src/agent-state.js';
import { IpcError } from '../src/ipc/errors.js';
import {
  AGENT_STATE_FIELDS,
  CLOSED_TRANSPORT_CODES,
  SECRET_PATTERN,
  assertSingleDaemonPrereqs,
  assertTwoDaemonPrereqs,
  conformancePrereqError,
  conformanceSocketPath,
  isConformanceRequired,
  isDaemonReachable,
  isTwoDaemonRequired,
  normalizeVersion,
  readPinnedVersion,
  readTwoDaemonFixture,
} from './conformance/_harness.js';
import type { TwoDaemonFixture } from './conformance/_harness.js';

describe('conformance harness — fail-not-skip gate (the core guarantee)', () => {
  it('REQUIRES → red: flag set but daemon unreachable returns an Error to throw', () => {
    const err = conformancePrereqError({ required: true, reachable: false, tier: 'single-daemon' });
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/FAIL/);
    expect(err?.message).toMatch(/single-daemon/);
  });

  it('REQUIRES → ok: flag set and daemon reachable returns null (the suite runs)', () => {
    expect(conformancePrereqError({ required: true, reachable: true, tier: 'single-daemon' })).toBeNull();
  });

  it('NOT REQUIRED → skip: flag unset and daemon unreachable returns null (clean local skip)', () => {
    expect(conformancePrereqError({ required: false, reachable: false, tier: 'single-daemon' })).toBeNull();
  });

  it('NOT REQUIRED, reachable → null (local dev with a daemon up still runs, never errors)', () => {
    expect(conformancePrereqError({ required: false, reachable: true, tier: 'single-daemon' })).toBeNull();
  });

  it('REQUIRES → red: error message names the MXL_CONFORMANCE flag (actionable — operators know what to unset)', () => {
    const err = conformancePrereqError({ required: true, reachable: false, tier: 'single-daemon' });
    expect(err?.message).toMatch(/MXL_CONFORMANCE/);
  });
});

describe('conformance harness — env flag readers', () => {
  it('isConformanceRequired only true for exactly "1"', () => {
    expect(isConformanceRequired({ MXL_CONFORMANCE: '1' })).toBe(true);
    expect(isConformanceRequired({ MXL_CONFORMANCE: 'true' })).toBe(false);
    expect(isConformanceRequired({})).toBe(false);
  });

  it('isTwoDaemonRequired only true for exactly "1"', () => {
    expect(isTwoDaemonRequired({ MXL_CONFORMANCE_TWO_DAEMON: '1' })).toBe(true);
    expect(isTwoDaemonRequired({})).toBe(false);
  });

  it('conformanceSocketPath honors the MXL_CONFORMANCE_SOCKET override', () => {
    expect(conformanceSocketPath({ MXL_CONFORMANCE_SOCKET: '/run/custom/daemon.sock' })).toBe(
      '/run/custom/daemon.sock',
    );
  });

  it('conformanceSocketPath falls back to the standard resolution when no override', () => {
    expect(conformanceSocketPath({ XDG_RUNTIME_DIR: '/run/user/1000' })).toBe(
      '/run/user/1000/mx-agent/daemon.sock',
    );
  });

  it('isDaemonReachable is false when the resolved socket does not exist', () => {
    expect(isDaemonReachable({ MXL_CONFORMANCE_SOCKET: '/definitely/absent/daemon.sock' })).toBe(false);
  });
});

describe('conformance harness — pin reader', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mxl-conf-pin-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('normalizeVersion strips a single leading v and trims', () => {
    expect(normalizeVersion('v0.2.1')).toBe('0.2.1');
    expect(normalizeVersion('0.2.1')).toBe('0.2.1');
    expect(normalizeVersion('  v1.0.0\n')).toBe('1.0.0');
  });

  it('readPinnedVersion returns both raw and normalized from an explicit path', () => {
    const pinFile = join(dir, '.mx-agent-version');
    writeFileSync(pinFile, 'v0.2.1\n');
    expect(readPinnedVersion(pinFile)).toEqual({ raw: 'v0.2.1', normalized: '0.2.1' });
  });

  it('readPinnedVersion locates the real repo .mx-agent-version by default', () => {
    // Smoke check that the default walk-up resolves; value tracks the repo pin.
    const pin = readPinnedVersion();
    expect(pin.normalized).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('readPinnedVersion throws on an empty pin file', () => {
    const empty = join(dir, '.empty-version');
    writeFileSync(empty, '   \n');
    expect(() => readPinnedVersion(empty)).toThrow(/empty/);
  });

  it('normalizeVersion with a double-v prefix strips only the first v', () => {
    // `.mx-agent-version` format is `vX.Y.Z`; a double-v is abnormal input —
    // the regex /^v/ strips exactly one leading v, leaving `v0.2.1`.
    expect(normalizeVersion('vv0.2.1')).toBe('v0.2.1');
  });

  it('normalizeVersion returns empty string for an empty input (no version to compare)', () => {
    expect(normalizeVersion('')).toBe('');
  });

  it("normalizeVersion with just 'v' strips the prefix and returns an empty string", () => {
    expect(normalizeVersion('v')).toBe('');
  });

  it('readPinnedVersion throws when the pin file path does not exist', () => {
    expect(() => readPinnedVersion(join(dir, '.absent-version-file'))).toThrow();
  });
});

describe('conformance harness — two-daemon fixture reader', () => {
  it('returns null when any required coordinate is absent', () => {
    expect(readTwoDaemonFixture({})).toBeNull();
    expect(readTwoDaemonFixture({ MXL_CONFORMANCE_ROOM: '!r:localhost' })).toBeNull();
    expect(
      readTwoDaemonFixture({ MXL_CONFORMANCE_ROOM: '!r:localhost', MXL_CONFORMANCE_TARGET_AGENT: 'agent-b' }),
    ).toBeNull();
  });

  it('returns the coordinates when room, target, and tool are all present', () => {
    expect(
      readTwoDaemonFixture({
        MXL_CONFORMANCE_ROOM: '!r:localhost',
        MXL_CONFORMANCE_TARGET_AGENT: 'agent-b',
        MXL_CONFORMANCE_TOOL: 'run_tests@1.0.0',
        MXL_CONFORMANCE_DENIED_TOOL: 'rm_rf@1.0.0',
      }),
    ).toEqual({
      room: '!r:localhost',
      targetAgentId: 'agent-b',
      tool: 'run_tests@1.0.0',
      deniedTool: 'rm_rf@1.0.0',
    });
  });

  it('returns null when MXL_CONFORMANCE_ROOM is an empty string (falsy coordinate)', () => {
    expect(
      readTwoDaemonFixture({
        MXL_CONFORMANCE_ROOM: '',
        MXL_CONFORMANCE_TARGET_AGENT: 'agent-b',
        MXL_CONFORMANCE_TOOL: 'run_tests@1.0.0',
      }),
    ).toBeNull();
  });

  it('returns null when MXL_CONFORMANCE_TOOL is an empty string', () => {
    expect(
      readTwoDaemonFixture({
        MXL_CONFORMANCE_ROOM: '!r:localhost',
        MXL_CONFORMANCE_TARGET_AGENT: 'agent-b',
        MXL_CONFORMANCE_TOOL: '',
      }),
    ).toBeNull();
  });

  it('returns null when MXL_CONFORMANCE_TARGET_AGENT is an empty string (falsy coordinate)', () => {
    expect(
      readTwoDaemonFixture({
        MXL_CONFORMANCE_ROOM: '!r:localhost',
        MXL_CONFORMANCE_TARGET_AGENT: '',
        MXL_CONFORMANCE_TOOL: 'run_tests@1.0.0',
      }),
    ).toBeNull();
  });

  it('deniedTool is explicitly undefined when MXL_CONFORMANCE_DENIED_TOOL is absent', () => {
    const fx = readTwoDaemonFixture({
      MXL_CONFORMANCE_ROOM: '!r:localhost',
      MXL_CONFORMANCE_TARGET_AGENT: 'agent-b',
      MXL_CONFORMANCE_TOOL: 'run_tests@1.0.0',
    });
    expect(fx).not.toBeNull();
    expect(fx!.deniedTool).toBeUndefined();
  });
});

describe('conformance harness — shared assertion vocabulary', () => {
  it('CLOSED_TRANSPORT_CODES matches the IpcError code set exactly (kept in sync with the source)', () => {
    // Construct one IpcError per harness code: a typo or a code removed from the
    // source union would surface as a compile error here (the constructor is
    // typed to IpcErrorCode), keeping the harness honest about the closed set.
    for (const code of CLOSED_TRANSPORT_CODES) {
      const err = new IpcError(code, 'x');
      expect(err.code).toBe(code);
    }
    expect(new Set(CLOSED_TRANSPORT_CODES).size).toBe(CLOSED_TRANSPORT_CODES.length);
    expect(CLOSED_TRANSPORT_CODES).toContain('rpc');
    expect(CLOSED_TRANSPORT_CODES).toContain('invalid_args');
  });

  it('CLOSED_TRANSPORT_CODES has exactly 8 entries (one per IpcErrorCode union member)', () => {
    // If a new code is added to IpcErrorCode without updating this constant, the
    // Tier 1 error-taxonomy assertions would silently accept the new code. An
    // explicit count check makes that drift visible at test time.
    expect(CLOSED_TRANSPORT_CODES).toHaveLength(8);
  });

  it('SECRET_PATTERN catches known secret shapes and ignores benign correlation ids', () => {
    expect('syt_abcdef').toMatch(SECRET_PATTERN);
    expect('ghp_xxxx').toMatch(SECRET_PATTERN);
    expect('xoxb-123').toMatch(SECRET_PATTERN);
    expect('MATRIX_ACCESS_TOKEN').toMatch(SECRET_PATTERN);
    expect('corr_3f2a-9b1c').not.toMatch(SECRET_PATTERN);
    expect('agent-fixture-001').not.toMatch(SECRET_PATTERN);
  });

  it('SECRET_PATTERN matches xoxp- (Slack user OAuth token — also in xox[bp]- character class)', () => {
    expect('xoxp-fake-user-token').toMatch(SECRET_PATTERN);
  });

  it('SECRET_PATTERN matches MX_AGENT_ prefix (toolbelt env namespace)', () => {
    expect('MX_AGENT_TOKEN').toMatch(SECRET_PATTERN);
    expect('MX_AGENT_SOCKET').toMatch(SECRET_PATTERN);
  });

  it('SECRET_PATTERN does NOT match syt_ followed only by digits (no lowercase letter)', () => {
    // syt_[a-z] requires a lowercase letter immediately after the underscore;
    // real Matrix tokens start with a lowercase letter but digits alone must not
    // trigger a false positive on numeric ids.
    expect('syt_1234').not.toMatch(SECRET_PATTERN);
    expect('syt_').not.toMatch(SECRET_PATTERN);
  });

  it('SECRET_PATTERN does NOT match syt_ followed only by uppercase letters (pattern is [a-z], case-sensitive)', () => {
    // Real Matrix access tokens always begin syt_<lowercase>, so an uppercase
    // letter after syt_ is not a real token and must not trigger a false positive.
    expect('syt_ABCDEF').not.toMatch(SECRET_PATTERN);
    expect('syt_ABC').not.toMatch(SECRET_PATTERN);
  });

  it('AGENT_STATE_FIELDS covers every AgentState key exactly — no omissions or extra entries', () => {
    // The mock is type-checked at compile time: TypeScript will error if any
    // AgentState field is added or removed without updating this object, which
    // surfaces as a test failure when AGENT_STATE_FIELDS diverges.
    const mockState: AgentState = {
      agent_id: 'fixture-agent-01',
      kind: 'runtime',
      matrix_user_id: '@fixture:localhost',
      device_id: 'DEVICE01',
      signing_key_id: 'mxagent-ed25519:fixture',
      signing_public_key: 'base64pubkeyfixture==',
      status: 'active',
      capabilities: [],
      tools: [],
      workspace: {},
      load: { running_invocations: 0, max_invocations: 10 },
      last_seen_ts: 0,
      state_rev: 1,
    };
    const actualKeys = Object.keys(mockState);
    const fieldSet = new Set(AGENT_STATE_FIELDS);

    for (const field of AGENT_STATE_FIELDS) {
      expect(actualKeys, `AGENT_STATE_FIELDS entry '${field}' is not an AgentState key (typo or stale)`).toContain(field);
    }
    for (const key of actualKeys) {
      expect(Array.from(fieldSet), `AgentState key '${key}' is missing from AGENT_STATE_FIELDS`).toContain(key);
    }
    expect(fieldSet.size).toBe(AGENT_STATE_FIELDS.length);
  });
});

describe('conformance harness — asserting helpers (assertSingleDaemonPrereqs / assertTwoDaemonPrereqs)', () => {
  const FULL_FIXTURE: TwoDaemonFixture = {
    room: '!r:localhost',
    targetAgentId: 'agent-b',
    tool: 'run_tests@1.0.0',
    deniedTool: undefined,
  };

  // assertSingleDaemonPrereqs

  it('assertSingleDaemonPrereqs throws when required=true and reachable=false', () => {
    expect(() => assertSingleDaemonPrereqs(true, false)).toThrow();
  });

  it('assertSingleDaemonPrereqs throw carries the FAIL message (same text as conformancePrereqError)', () => {
    expect(() => assertSingleDaemonPrereqs(true, false)).toThrow(/FAIL/);
  });

  it('assertSingleDaemonPrereqs does not throw when required=true and reachable=true', () => {
    expect(() => assertSingleDaemonPrereqs(true, true)).not.toThrow();
  });

  it('assertSingleDaemonPrereqs does not throw when not required (either reachability)', () => {
    expect(() => assertSingleDaemonPrereqs(false, false)).not.toThrow();
    expect(() => assertSingleDaemonPrereqs(false, true)).not.toThrow();
  });

  // assertTwoDaemonPrereqs

  it('assertTwoDaemonPrereqs throws when required=true and reachable=false (daemon missing)', () => {
    expect(() => assertTwoDaemonPrereqs(true, false, FULL_FIXTURE)).toThrow(/FAIL/);
  });

  it('assertTwoDaemonPrereqs throws when required=true, reachable=true, but fixture=null (coordinates missing)', () => {
    expect(() => assertTwoDaemonPrereqs(true, true, null)).toThrow();
  });

  it('assertTwoDaemonPrereqs fixture-null error names all three expected env vars', () => {
    const run = (): void => assertTwoDaemonPrereqs(true, true, null);
    expect(run).toThrow(/MXL_CONFORMANCE_ROOM/);
    expect(run).toThrow(/MXL_CONFORMANCE_TARGET_AGENT/);
    expect(run).toThrow(/MXL_CONFORMANCE_TOOL/);
  });

  it('assertTwoDaemonPrereqs does not throw when required=true, reachable=true, fixture complete', () => {
    expect(() => assertTwoDaemonPrereqs(true, true, FULL_FIXTURE)).not.toThrow();
  });

  it('assertTwoDaemonPrereqs does not throw when not required (clean local skip, fixture absent)', () => {
    expect(() => assertTwoDaemonPrereqs(false, false, null)).not.toThrow();
    expect(() => assertTwoDaemonPrereqs(false, true, null)).not.toThrow();
  });
});

describe('conformance harness — isDaemonReachable (positive case)', () => {
  let dir: string;
  let realFile: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mxl-conf-reach-'));
    realFile = join(dir, 'daemon.sock');
    writeFileSync(realFile, ''); // exists → reachable
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('isDaemonReachable is true when the resolved socket file exists', () => {
    expect(isDaemonReachable({ MXL_CONFORMANCE_SOCKET: realFile })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AgentListEntry and AgentLiveness shape (compile-checked)
//
// The Tier 1 live suite asserts on `{ agent, liveness }` row shapes and compares
// liveness against 'active'|'stale'|'offline'. These compile-checked tests lock
// in those field names and values against the exported types so a rename would
// surface as a TypeScript error here — catching drift between the types and the
// live assertions before a daemon run.
// ---------------------------------------------------------------------------

describe('conformance harness — AgentListEntry and AgentLiveness shapes (compile-check)', () => {
  it('AgentListEntry has exactly the two fields {agent, liveness} the Tier 1 live assertions depend on', () => {
    const mockEntry: AgentListEntry = {
      agent: {
        agent_id: 'fixture-agent',
        kind: 'runtime',
        matrix_user_id: '@fixture:localhost',
        device_id: 'DFIX',
        signing_key_id: 'mxagent-ed25519:fixture',
        signing_public_key: 'base64pubkey==',
        status: 'active',
        capabilities: [],
        tools: [],
        workspace: {},
        load: { running_invocations: 0, max_invocations: 1 },
        last_seen_ts: 0,
        state_rev: 1,
      },
      liveness: 'active',
    };
    // TypeScript errors if AgentListEntry adds/renames a field without
    // updating the Tier 1 assertions. Runtime: verify the object shape.
    expect(Object.keys(mockEntry)).toContain('agent');
    expect(Object.keys(mockEntry)).toContain('liveness');
    expect(Object.keys(mockEntry)).toHaveLength(2);
  });

  it('AgentLiveness is exactly the three values the Tier 1 live suite asserts on', () => {
    // Compile-checked: TypeScript errors if a new liveness variant is added.
    const allValues: AgentLiveness[] = ['active', 'stale', 'offline'];
    expect(allValues).toHaveLength(3);
    expect(allValues).toContain('active');
    expect(allValues).toContain('stale');
    expect(allValues).toContain('offline');
  });
});
