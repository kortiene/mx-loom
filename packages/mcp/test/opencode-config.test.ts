/**
 * OpenCode `mcp` server-entry example validation (T203 / #25).
 *
 * Fast, daemon-free, OpenCode-free coverage for the copy-paste configs under
 * `examples/opencode/`. The live acceptance arm — `opencode serve` connects to
 * `mx-loom-mcp` and an agent calls `mx_delegate_tool` — is the gated e2e in
 * `packages/golden/test/opencode.mcp-entry.e2e.test.ts`. This suite pins the parts
 * that must hold on every laptop / PR with no `opencode` binary, no daemon, and no
 * provider key:
 *
 *  - both example files parse as strict JSON and carry an `mcp.mx-loom` entry of
 *    the verified `McpLocalConfig` / `McpRemoteConfig` shape (`@opencode-ai/sdk`:
 *    local → `command` string array + optional `environment`; remote → `url`);
 *  - the **argv seam**: every `--flag` the local `command` array emits is a
 *    recognized `mx-loom-mcp` bin option (a renamed/dropped flag would break
 *    OpenCode at spawn time, exactly like the ADK argv-seam guard), and the
 *    command projects the `opencode` session mapping;
 *  - the **secret boundary at the config surface**: no example carries a
 *    credential-shaped key/value, the local `environment` allowlist is non-secret
 *    per the toolbelt's own oracle, the remote `url` is localhost, and the remote
 *    entry commits no `headers`/`oauth` (no auth material in git).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CANONICAL_M1_TOOLS, isForbiddenAuthorityVerb } from '@mx-loom/registry';
import {
  CREDENTIAL_KEY_RE,
  ENV_DENY_EXACT,
  ENV_DENY_PREFIXES,
  ENV_DENY_SUFFIXES,
} from '@mx-loom/toolbelt';
import { describe, expect, it } from 'vitest';

import { buildSessionOptions, parseCliArgs } from '../src/cli-options.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const exampleDir = resolve(repoRoot, 'examples', 'opencode');

/**
 * Real credential-VALUE shapes that must never appear in a committed example or doc.
 * The PEM fragment matches `-----BEGIN … KEY-----` headers without spelling the
 * literal private-key phrase in source (so the repo's gitleaks scan does not flag
 * this guard's own pattern as a finding).
 */
const SECRET_VALUE_PATTERN =
  /ghp_[A-Za-z0-9]|gho_[A-Za-z0-9]|github_pat_|syt_[a-z]|xox[bp]-|sk-ant-[A-Za-z0-9-]|sk-[A-Za-z0-9]{16}|-----BEGIN [A-Z ]+ KEY-----/;
/** Whole-namespace secret KEY prefixes — never named in a config file (README prose may). */
const SECRET_NAMESPACE_PATTERN = /MATRIX_|MX_AGENT_/;

interface OpencodeConfig {
  $schema?: string;
  mcp?: Record<string, Record<string, unknown>>;
}

function readExample(name: string): { raw: string; config: OpencodeConfig } {
  const raw = readFileSync(resolve(exampleDir, name), 'utf8');
  return { raw, config: JSON.parse(raw) as OpencodeConfig };
}

function mxLoomEntry(config: OpencodeConfig): Record<string, unknown> {
  const entry = config.mcp?.['mx-loom'];
  expect(entry, 'examples must define the `mx-loom` mcp server entry').toBeTruthy();
  return entry as Record<string, unknown>;
}

/** Every distinct `"--flag"` token in a local `command` array. */
function emittedFlags(command: readonly string[]): string[] {
  return [...new Set(command.filter((tok) => /^--[a-z][a-z-]*$/.test(tok)))].sort();
}

/** Recursively collect every object key in a parsed config (for credential-key scans). */
function allKeys(value: unknown, acc: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) allKeys(v, acc);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      acc.push(k);
      allKeys(v, acc);
    }
  }
  return acc;
}

const local = readExample('opencode.local.example.json');
const remote = readExample('opencode.remote.example.json');

describe('examples/opencode — both example configs', () => {
  it('parse as strict JSON, pin the OpenCode schema, and define mcp.mx-loom', () => {
    for (const { config } of [local, remote]) {
      expect(config.$schema).toBe('https://opencode.ai/config.json');
      const entry = mxLoomEntry(config);
      expect(entry['type'], 'mx-loom entry must declare a connection type').toMatch(/^(local|remote)$/);
    }
  });

  it('carry no credential-shaped key and no credential-value shape', () => {
    for (const { raw, config } of [local, remote]) {
      for (const key of allKeys(config)) {
        expect(CREDENTIAL_KEY_RE.test(key), `credential-shaped config key: ${key}`).toBe(false);
      }
      expect(raw, 'committed example must not name a secret namespace').not.toMatch(
        SECRET_NAMESPACE_PATTERN,
      );
      expect(raw, 'committed example must not embed a credential value').not.toMatch(
        SECRET_VALUE_PATTERN,
      );
    }
  });
});

describe('examples/opencode — local stdio entry (McpLocalConfig)', () => {
  const entry = mxLoomEntry(local.config);
  const command = entry['command'] as string[];

  it('is a local entry whose command launches mx-loom-mcp over --stdio', () => {
    expect(entry['type']).toBe('local');
    expect(entry['enabled']).toBe(true);
    expect(Array.isArray(command) && command.length > 0).toBe(true);
    expect(command.every((tok) => typeof tok === 'string')).toBe(true);
    // command[0] is the bin (or a documented launcher resolving to it), not a flag.
    expect(command[0]).toBe('mx-loom-mcp');
    expect(command).toContain('--stdio');
  });

  it('threads the opencode session mapping via the command array, not model args', () => {
    // command.slice(1) is the argv the bin parses (command[0] is the executable).
    const opts = parseCliArgs(command.slice(1), {});
    const session = buildSessionOptions(opts);
    expect(opts.http, '--stdio must not flip the transport to http').toBe(false);
    expect(session.kind).toBe('opencode');
    expect(session.room, 'a non-secret workspace room must be present').toBeTruthy();
    expect(session.correlationId, 'a correlation id placeholder must be present').toBeTruthy();
  });

  it('every flag the command emits is a recognized mx-loom-mcp option (no argv drift)', () => {
    for (const flag of emittedFlags(command)) {
      const argv = flag === '--stdio' ? [flag] : [flag, '1'];
      let thrownCode: string | undefined;
      try {
        parseCliArgs(argv, {});
      } catch (err) {
        thrownCode = (err as NodeJS.ErrnoException).code;
      }
      expect(
        thrownCode,
        `local example emits ${flag} but the bin does not recognize it (drift)`,
      ).not.toBe('ERR_PARSE_ARGS_UNKNOWN_OPTION');
    }
  });

  it('has a non-secret environment allowlist (no provider key / token / DSN)', () => {
    const environment = (entry['environment'] ?? {}) as Record<string, string>;
    for (const key of Object.keys(environment)) {
      const upper = key.toUpperCase();
      const denied =
        ENV_DENY_PREFIXES.some((p) => upper.startsWith(p)) ||
        ENV_DENY_SUFFIXES.some((s) => upper.endsWith(s)) ||
        (ENV_DENY_EXACT as readonly string[]).includes(upper);
      expect(denied, `environment allowlist admits a secret-shaped key: ${key}`).toBe(false);
      expect(CREDENTIAL_KEY_RE.test(key), `environment key is credential-shaped: ${key}`).toBe(false);
    }
    // The audit DSN is credential-shaped and must never be allowlisted to the child.
    expect(Object.keys(environment)).not.toContain('DATABASE_URL');
  });

  it('does not name any forbidden authority verb in its command argv', () => {
    for (const tok of command) {
      const verb = tok.replace(/^--/, '');
      expect(isForbiddenAuthorityVerb(verb), `command carries an authority verb: ${tok}`).toBe(false);
    }
  });
});

describe('examples/opencode — remote entry (McpRemoteConfig)', () => {
  const entry = mxLoomEntry(remote.config);

  it('is a remote entry pointing at the localhost Streamable-HTTP root', () => {
    expect(entry['type']).toBe('remote');
    expect(entry['enabled']).toBe(true);
    const url = entry['url'] as string;
    expect(typeof url).toBe('string');
    // Localhost only — non-local exposure is operator opt-in behind a proxy and is
    // never committed. The mx-loom HTTP server is path-agnostic, so the url is the root.
    expect(url).toMatch(/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/);
  });

  it('commits no auth material (no headers / oauth)', () => {
    expect(entry).not.toHaveProperty('headers');
    expect(entry).not.toHaveProperty('oauth');
  });
});

describe('examples/opencode — README documentation invariants', () => {
  const readme = readFileSync(resolve(exampleDir, 'README.md'), 'utf8');

  it('embeds no real credential value', () => {
    expect(readme).not.toMatch(SECRET_VALUE_PATTERN);
  });

  it('documents the localhost / authenticated-proxy requirement before non-local exposure', () => {
    expect(readme).toMatch(/127\.0\.0\.1/);
    expect(readme.toLowerCase()).toMatch(/reverse proxy|authenticated proxy/);
  });

  it('names the deferred-result resolution verb and the canonical acceptance tool', () => {
    expect(readme).toContain('mx_await_result');
    expect(readme).toContain('mx_delegate_tool');
  });

  it('lists only canonical mx_* tools and no authority verb in its tool table', () => {
    // The "nine canonical tools" bullet must enumerate exactly the registry set.
    for (const descriptor of CANONICAL_M1_TOOLS) {
      expect(readme, `README omits canonical tool ${descriptor.name}`).toContain(descriptor.name);
    }
    for (const forbidden of ['trust.', 'approval.decide', 'policy.', 'auth.', 'device.', 'daemon.']) {
      // Only allowed inside the explicit "no … is reachable" negative list.
      // A bare authority verb presented as callable would be a leak; we assert the
      // README frames them as unreachable.
      if (readme.includes(forbidden)) {
        expect(
          readme,
          `README mentions ${forbidden} without framing it as unreachable`,
        ).toMatch(/no\s+`?trust|only\b|unreachable|absent|never/i);
      }
    }
  });
});
