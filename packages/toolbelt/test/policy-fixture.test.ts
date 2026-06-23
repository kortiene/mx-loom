/**
 * Static validation tests for the canonical golden-test receiver policy fixture
 * `scripts/conformance/policy.golden.toml` (T112 / #20, T114 / #22).
 *
 * These run in the NORMAL fast suite (no daemon, no network, no TOML parser).
 * They pin the fixture's structural invariants, substitution-contract coverage,
 * and secret-free guarantee so any accidental corruption of the committed file
 * surfaces as a test failure -- before the live AC-1 daemon check can catch it.
 *
 * SCHEMA: the fixture is authored against the real mx-agent v0.2.1 policy schema
 * (crates/mx-agent-policy/src/file.rs, pinned in #73): an `[execution]` block
 * plus a per-room, per-SENDER-AGENT `[rooms."…".agents."…"]` rule with
 * `allow_tools` / `allow_commands` / `allow_cwd` (arrays), a `deny_args_regex`
 * array, and a per-agent `requires_approval`. mx-loom never parses the file
 * (design §1, §6 L3); these tests treat it as opaque text, asserting structural
 * patterns rather than semantics.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { SECRET_PATTERN } from './conformance/_harness.js';

// ---------------------------------------------------------------------------
// Fixture location -- walk up from this file to the repo root
// ---------------------------------------------------------------------------

function locateFixture(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, 'scripts', 'conformance', 'policy.golden.toml');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'policy-fixture.test: could not locate scripts/conformance/policy.golden.toml walking up from test dir',
  );
}

// Documented substitution placeholders. The v0.2.1 real schema keys policy on the
// room + sender-agent, so those are placeholders too (not just tool/command names).
const DOCUMENTED_PLACEHOLDERS = new Set([
  '@@ROOM@@',
  '@@SENDER_AGENT@@',
  '@@ALLOW_TOOL@@',
  '@@APPROVAL_TOOL@@',
  '@@ALLOW_COMMAND@@',
  '@@ALLOW_CWD@@',
  '@@SANDBOX_BACKEND@@',
]);

/** Extract the single-quoted literal entries of the `deny_args_regex = [ … ]` array. */
function extractDenyArgsRegexes(content: string): string[] {
  const m = content.match(/deny_args_regex\s*=\s*\[([\s\S]*?)\]/m);
  if (!m || m[1] === undefined) return [];
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]!);
}

/** Whether ANY of the deny_args_regex patterns matches the command line. */
function blockedByAny(patterns: string[], command: string): boolean {
  return patterns.some((p) => new RegExp(p).test(command));
}

describe('policy.golden.toml -- static fixture validation (T112 / #20, T114 / #22)', () => {
  let content: string;
  let denyArgsRegexes: string[];

  beforeAll(() => {
    content = readFileSync(locateFixture(), 'utf8');
    denyArgsRegexes = extractDenyArgsRegexes(content);
    if (denyArgsRegexes.length === 0) {
      throw new Error(
        'deny_args_regex array (single-quoted literals) not found in policy.golden.toml -- fixture is malformed',
      );
    }
  });

  // --- Existence and well-formedness -----------------------------------------

  it('fixture file exists at scripts/conformance/policy.golden.toml', () => {
    expect(existsSync(locateFixture())).toBe(true);
  });

  it('fixture is non-empty', () => {
    expect(content.trim().length).toBeGreaterThan(0);
  });

  // --- Real v0.2.1 schema spine ----------------------------------------------

  it('has an [execution] block', () => {
    expect(content).toMatch(/^\[execution\]/m);
  });

  it('execution block denies network egress (network = "deny")', () => {
    expect(content).toMatch(/^\s*network\s*=\s*["']deny["']/m);
  });

  it('declares the workspace room rule [rooms."@@ROOM@@"] as trusted', () => {
    expect(content).toMatch(/^\[rooms\."@@ROOM@@"\]/m);
    expect(content).toMatch(/^\s*trusted\s*=\s*true/m);
  });

  it('declares a per-sender-agent rule [rooms."@@ROOM@@".agents."@@SENDER_AGENT@@"]', () => {
    // Authorization resolves room.agents.get(<sender agent id>); the policy MUST
    // be keyed on the delegator (daemon A) agent id, not the receiver.
    expect(content).toMatch(/^\[rooms\."@@ROOM@@"\.agents\."@@SENDER_AGENT@@"\]/m);
  });

  // --- Named-tool allowlist (array; exact-string match in the daemon) --------

  it('agent rule has an allow_tools array listing the ungated + approval tools', () => {
    const m = content.match(/^\s*allow_tools\s*=\s*\[([\s\S]*?)\]/m);
    expect(m, 'allow_tools array not found').not.toBeNull();
    const list = m?.[1] ?? '';
    expect(list).toContain('@@ALLOW_TOOL@@');
    expect(list).toContain('@@APPROVAL_TOOL@@');
  });

  it('the deny tool is deliberately ABSENT from allow_tools (deny-by-default)', () => {
    // @@DENY_TOOL@@ must never appear — anything not in allow_tools is policy_denied.
    expect(content).not.toContain('@@DENY_TOOL@@');
  });

  it('permits the guarded-exec path for the agent (allow_exec = true)', () => {
    expect(content).toMatch(/^\s*allow_exec\s*=\s*true/m);
  });

  it('carries a per-agent requires_approval gate', () => {
    // v0.2.1 requires_approval is per-AGENT (one bool), not per-tool — see the
    // APPROVAL CAVEAT in the fixture header and #73. The allowed/denied branches
    // stay correct with requires_approval = false.
    expect(content).toMatch(/^\s*requires_approval\s*=\s*(true|false)/m);
  });

  // --- Guarded exec keys (now on the agent rule, not a [exec] block) ----------

  it('agent rule has allow_commands as a TOML array', () => {
    expect(content).toMatch(/^\s*allow_commands\s*=\s*\[/m);
  });

  it('agent rule has allow_cwd as a TOML array', () => {
    expect(content).toMatch(/^\s*allow_cwd\s*=\s*\[/m);
  });

  it('agent rule has a sandbox backend key', () => {
    expect(content).toMatch(/^\s*sandbox\s*=/m);
  });

  // --- deny_args_regex -- TOML literal strings and regex correctness ----------

  it('deny_args_regex is an array of TOML literal (single-quote) strings, not basic strings', () => {
    // In TOML, double-quoted basic strings process escapes: \b is backspace
    // (U+0008), NOT a regex word-boundary. Single-quoted literals pass the regex
    // verbatim. A double-quoted entry here is a silent correctness bug.
    const arr = content.match(/deny_args_regex\s*=\s*\[([\s\S]*?)\]/m)?.[1] ?? '';
    expect(arr, 'deny_args_regex array not found').not.toBe('');
    expect(arr.includes("'"), 'deny_args_regex entries must be single-quoted literals').toBe(true);
    expect(arr.includes('"'), 'deny_args_regex must not use double-quoted basic strings').toBe(false);
  });

  it('every deny_args_regex entry compiles as a valid JavaScript regex', () => {
    expect(denyArgsRegexes.length).toBeGreaterThan(0);
    for (const p of denyArgsRegexes) {
      expect(() => new RegExp(p), `pattern '${p}' must compile`).not.toThrow();
    }
  });

  it('deny_args_regex blocks pipe-to-shell (| sh and | bash)', () => {
    expect(blockedByAny(denyArgsRegexes, 'echo foo | sh')).toBe(true);
    expect(blockedByAny(denyArgsRegexes, 'curl https://example.com | sh')).toBe(true);
    expect(blockedByAny(denyArgsRegexes, 'echo foo | bash')).toBe(true);
  });

  it('deny_args_regex blocks rm -rf /', () => {
    expect(blockedByAny(denyArgsRegexes, 'rm -rf /')).toBe(true);
    expect(blockedByAny(denyArgsRegexes, 'rm  -rf /etc')).toBe(true);
  });

  it('deny_args_regex blocks ssh and curl', () => {
    expect(blockedByAny(denyArgsRegexes, 'ssh user@host')).toBe(true);
    expect(blockedByAny(denyArgsRegexes, 'curl https://example.com')).toBe(true);
  });

  it('deny_args_regex does NOT false-positive on safe commands (echo, git)', () => {
    expect(blockedByAny(denyArgsRegexes, 'echo hello world')).toBe(false);
    expect(blockedByAny(denyArgsRegexes, 'echo mx-loom-conformance')).toBe(false);
    expect(blockedByAny(denyArgsRegexes, 'git status')).toBe(false);
    expect(blockedByAny(denyArgsRegexes, 'git push origin main')).toBe(false);
  });

  // --- Substitution contract --------------------------------------------------

  it('all documented substitution placeholders are present in the fixture', () => {
    for (const placeholder of DOCUMENTED_PLACEHOLDERS) {
      expect(
        content,
        `documented placeholder '${placeholder}' is missing from policy.golden.toml`,
      ).toContain(placeholder);
    }
  });

  it('all @@...@@ placeholders are from the documented substitution contract', () => {
    const found = content.match(/@@[A-Z_]+@@/g) ?? [];
    for (const placeholder of found) {
      expect(
        DOCUMENTED_PLACEHOLDERS.has(placeholder),
        `undocumented placeholder '${placeholder}' found in policy.golden.toml`,
      ).toBe(true);
    }
  });

  it('the room + sender-agent + tool placeholders appear in non-comment config lines', () => {
    const nonComment = content
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    for (const placeholder of ['@@ROOM@@', '@@SENDER_AGENT@@', '@@ALLOW_TOOL@@', '@@APPROVAL_TOOL@@']) {
      expect(nonComment, `${placeholder} must be used as an actual config value`).toContain(placeholder);
    }
  });

  // --- Secret-free guarantee --------------------------------------------------

  it('fixture carries no credential-shaped secret values (committed to git -- must be clean)', () => {
    const nonComment = content
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(nonComment).not.toMatch(SECRET_PATTERN);
  });

  it('fixture contains no real Matrix room id (!xxx:server form)', () => {
    expect(content).not.toMatch(/![a-zA-Z0-9_-]{8,}:[a-z][a-z0-9.-]+(:\d+)?/);
  });

  it('fixture contains no PEM block or raw Ed25519 key', () => {
    expect(content).not.toMatch(/-----BEGIN/);
    expect(content).not.toMatch(/ed25519:[a-zA-Z0-9+/=]{40,}/);
  });

  it('fixture contains no provider API key shapes (sk-ant-, AKIA)', () => {
    const nonComment = content
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(nonComment).not.toMatch(/sk-ant-[a-zA-Z0-9]/);
    expect(nonComment).not.toMatch(/\bAKIA[A-Z0-9]{16}\b/);
  });
});
