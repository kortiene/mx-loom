/**
 * ADK example safe-env / argv helper — BEHAVIORAL coverage (T201 / #23).
 *
 * `packages/mcp/test/cli-options.test.ts` pins the Python deny/allow *lists*
 * against the canonical toolbelt constants (a static drift guard). That proves
 * the rules are spelled the same — but it never *runs* `safe_mx_mcp_env()`, so a
 * logic bug in the Python (an inverted predicate, a forgotten case-fold, a
 * missing `extra` re-check) would pass the static guard while silently leaking a
 * secret into the spawned `mx-loom-mcp` child. The Python helper IS the
 * secret-boundary enforcement at the ADK stdio seam, so it must be exercised, not
 * just diffed.
 *
 * This suite drives `examples/adk/mcp_toolset_agent.py` in a **single** python3
 * subprocess (computed once in `beforeAll`) under a fully synthetic, secret-laden
 * environment (no real secrets — clearly-fake values) and asserts the observable
 * contract:
 *  - deny-by-default: only allowlisted, non-secret keys survive into the child env;
 *  - every enumerated Boundary-A / provider / audit-DSN secret is filtered out
 *    (by name AND by value);
 *  - an explicit `extra` cannot re-admit a secret-shaped key (it raises);
 *  - a non-secret `extra` is admitted;
 *  - the argv builder emits the documented `mx-loom-mcp --stdio` flags and rejects
 *    a non-positive `max_invocations`;
 *  - `mx_session_state` returns only the two non-secret ToolContext keys.
 *
 * Toolchain note: the repo runs no Python test runner and CI installs no Python,
 * so this stays inside vitest and is **skip-clean** when `python3` is unavailable
 * (mirroring the repo's `describe.skipIf` live-tier convention). The Python module
 * defers its `google-adk` imports into the factory functions, so the helper is
 * importable and exercisable here without ADK installed. One subprocess, no
 * daemon, no network, no model provider — fully deterministic.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  BASE_ENV_ALLOW,
  ENV_DENY_EXACT,
  ENV_DENY_PREFIXES,
  ENV_DENY_SUFFIXES,
} from '@mx-loom/toolbelt';
import { beforeAll, describe, expect, it } from 'vitest';

/** Absolute path to the examples/adk dir (module lives at <repo>/examples/adk). */
const adkExampleDir = fileURLToPath(new URL('../../../examples/adk', import.meta.url));

/** Whether a `python3` interpreter is resolvable (else this suite skips cleanly). */
function hasPython3(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const SKIP = !hasPython3();

/**
 * Clearly-fake secret keys a host might try to forward via `extra` — all must be
 * refused. Chosen so EACH deny rule is independently guarded (no rule is masked
 * by an overlapping one):
 *  - `GH_TOKEN`           → exact deny (also the `_TOKEN` suffix);
 *  - `MATRIX_ONLYPREFIX`  → `MATRIX_` PREFIX only (no secret suffix) — guards the
 *                           prefix rule in isolation;
 *  - `MX_AGENT_ONLYPREFIX`→ `MX_AGENT_` PREFIX only — guards the prefix rule;
 *  - `FOO_API_KEY` / `BAR_SECRET` / `BAZ_ACCESS_KEY` / `QUX_TOKEN` → each suffix;
 *  - `DATABASE_URL` / `PGPASSWORD` → the ADK audit-DSN layered deny.
 */
const SECRET_EXTRAS = [
  'GH_TOKEN',
  'MATRIX_ONLYPREFIX',
  'MX_AGENT_ONLYPREFIX',
  'FOO_API_KEY',
  'BAR_SECRET',
  'BAZ_ACCESS_KEY',
  'QUX_TOKEN',
  'DATABASE_URL',
  'PGPASSWORD',
] as const;

/**
 * Enumerated synthetic secrets that must never survive into the child env.
 * Includes prefix-ONLY shapes (`MATRIX_SESSION` / `MX_AGENT_HOME` — no credential
 * suffix) so the deny-PREFIX rule is exercised in isolation by the FILTERING path,
 * not only the `extra` path, and is not masked by an overlapping suffix rule.
 */
const SYNTHETIC_SECRETS = {
  GH_TOKEN: 'fake-gh-token-not-real',
  MATRIX_ACCESS_TOKEN: 'fake-matrix-token-not-real',
  MATRIX_SESSION: 'fake-matrix-session-prefix-only-not-real',
  MX_AGENT_SECRET: 'fake-mx-agent-secret-not-real',
  MX_AGENT_HOME: 'fake-mx-agent-home-prefix-only-not-real',
  ANTHROPIC_API_KEY: 'fake-anthropic-key-not-real',
  OPENAI_API_KEY: 'fake-openai-key-not-real',
  GOOGLE_API_KEY: 'fake-google-key-not-real',
  AWS_SECRET_ACCESS_KEY: 'fake-aws-secret-not-real',
  SOME_CLIENT_SECRET: 'fake-client-secret-not-real',
  DATABASE_URL: 'postgres://user:fakepw@fake-db-host.invalid/db',
  PGPASSWORD: 'fake-pg-password-not-real',
  PGHOST: 'fake-pg-host-not-real',
} as const;

/**
 * The synthetic parent environment handed to the python3 subprocess: the full
 * non-secret base allowlist + the two non-secret MXL_* extras + the clearly-fake
 * secrets above. Built from the canonical toolbelt constants so it stays honest
 * if the allowlist changes. This fully REPLACES the parent env (no inheritance)
 * so the result is deterministic across shells/CI.
 */
function syntheticParentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  // Allowed, non-secret base keys. Locale/term vars get VALID values (so the
  // spawned python3 emits no setlocale warnings); the rest get benign values.
  const benignBaseValue: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin',
    LANG: 'C',
    LC_ALL: 'C',
    TERM: 'xterm',
  };
  for (const key of BASE_ENV_ALLOW) env[key] = benignBaseValue[key] ?? `val-${key}`;
  env.MXL_AGENT_BIN = '/opt/mx-agent';
  env.MXL_AUDIT_PG = '1';
  for (const [key, value] of Object.entries(SYNTHETIC_SECRETS)) env[key] = value;
  return env;
}

/** True iff a key name matches the canonical toolbelt deny rules. */
function isToolbeltDenied(key: string): boolean {
  const upper = key.toUpperCase();
  if (ENV_DENY_PREFIXES.some((p) => key.startsWith(p))) return true;
  if ((ENV_DENY_EXACT as readonly string[]).includes(upper)) return true;
  return ENV_DENY_SUFFIXES.some((s) => upper.endsWith(s));
}

/**
 * The shape the in-process python driver returns (a single JSON line). Computed
 * once so the whole suite costs exactly one python3 spawn (the pyenv shim is slow
 * — per-assertion spawns blow the default test timeout).
 */
interface PyProbe {
  /** `safe_mx_mcp_env()` under the synthetic secret-laden parent env (full dict). */
  child_synthetic: Record<string, string>;
  /** `safe_mx_mcp_env()` keys after the parent env is cleared to just PATH. */
  child_empty: string[];
  /** `'MXL_AGENT_BIN' in safe_mx_mcp_env({'MXL_AGENT_BIN': ...})` — a non-secret extra is admitted. */
  extra_nonsecret_admitted: boolean;
  /** Per-key: did `safe_mx_mcp_env({key: ...})` raise (i.e. refuse the secret extra)? */
  extra_rejections: Record<string, boolean>;
  /** `_mx_mcp_args(...)` with every field set. */
  argv_full: string[];
  /** `_mx_mcp_args(room=...)` — the minimal form. */
  argv_min: string[];
  /** Did `_mx_mcp_args(max_invocations=0)` raise? */
  maxinv_zero_rejected: boolean;
  /** `mx_session_state(room, correlation_id)`. */
  session_state: Record<string, string>;
}

/**
 * The python driver: exercises every helper path in ONE process and prints one
 * JSON line. `sys.argv[1]` carries the secret-extras list so TS stays the single
 * control point for which shapes to probe. Computes the synthetic-env result
 * BEFORE clearing `os.environ` so the deny-by-default floor check is honest.
 */
const PY_DRIVER = `
import json, os, sys
import mcp_toolset_agent as m

secret_extras = json.loads(sys.argv[1])

# --- under the synthetic secret-laden parent env (as provided) ---
child_synthetic = m.safe_mx_mcp_env()
extra_nonsecret_admitted = "MXL_AGENT_BIN" in m.safe_mx_mcp_env({"MXL_AGENT_BIN": "/custom/mx"})

extra_rejections = {}
for key in secret_extras:
    try:
        m.safe_mx_mcp_env({key: "fake-value-not-real"})
        extra_rejections[key] = False  # admitted -> BAD
    except ValueError:
        extra_rejections[key] = True   # refused  -> good

argv_full = m._mx_mcp_args(room="!ws:server", correlation_id="adk_42", cwd="/w", project_id="p", git_commit="sha", max_invocations=4)
argv_min = m._mx_mcp_args(room="!r:s")

try:
    m._mx_mcp_args(room="!r:s", max_invocations=0)
    maxinv_zero_rejected = False
except ValueError:
    maxinv_zero_rejected = True

session_state = m.mx_session_state("!ws:server", "adk_42")

# --- deny-by-default floor: clear the parent env to just PATH, re-run ---
saved_path = os.environ.get("PATH", "")
os.environ.clear()
os.environ["PATH"] = saved_path
child_empty = sorted(m.safe_mx_mcp_env().keys())

print(json.dumps({
    "child_synthetic": child_synthetic,
    "child_empty": child_empty,
    "extra_nonsecret_admitted": extra_nonsecret_admitted,
    "extra_rejections": extra_rejections,
    "argv_full": argv_full,
    "argv_min": argv_min,
    "maxinv_zero_rejected": maxinv_zero_rejected,
    "session_state": session_state,
}))
`;

describe.skipIf(SKIP)('ADK example mcp_toolset_agent.py — behavior', () => {
  let probe: PyProbe;
  let parent: Record<string, string>;

  beforeAll(() => {
    parent = syntheticParentEnv();
    const stdout = execFileSync('python3', ['-c', PY_DRIVER, JSON.stringify(SECRET_EXTRAS)], {
      cwd: adkExampleDir,
      env: { ...parent, PYTHONPATH: adkExampleDir, PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8',
    });
    probe = JSON.parse(stdout.trim()) as PyProbe;
  });

  // -------------------------------------------------------------------------
  // safe_mx_mcp_env — deny-by-default filtering
  // -------------------------------------------------------------------------

  it('keeps only allowlisted non-secret keys; drops every synthetic secret', () => {
    const childKeys = Object.keys(probe.child_synthetic);

    // Nothing secret-shaped (by the canonical toolbelt rules) survives.
    const leaked = childKeys.filter(isToolbeltDenied);
    expect(leaked, `secret-shaped keys leaked into the MCP child env: ${leaked.join(', ')}`).toEqual(
      [],
    );

    // Each specific synthetic secret is absent by name.
    for (const secret of Object.keys(SYNTHETIC_SECRETS)) {
      expect(childKeys, `secret survived into child env: ${secret}`).not.toContain(secret);
    }

    // The non-secret base + MXL_* extras that were present DO survive (proves the
    // filter is deny-by-default, not deny-all).
    for (const allowed of [...BASE_ENV_ALLOW, 'MXL_AGENT_BIN', 'MXL_AUDIT_PG']) {
      expect(childKeys, `non-secret allowlisted key was dropped: ${allowed}`).toContain(allowed);
    }
  });

  it('no child VALUE equals any synthetic secret value (value-level leak check)', () => {
    const childValues = Object.values(probe.child_synthetic);
    for (const [key, value] of Object.entries(SYNTHETIC_SECRETS)) {
      expect(
        childValues,
        `a denied secret VALUE leaked into the child env (from ${key})`,
      ).not.toContain(value);
    }
  });

  it('an emptied parent env yields only PATH (deny-by-default floor)', () => {
    // After clearing the parent env to just PATH (allowlisted), nothing else may
    // appear — proves the helper copies nothing it was not given.
    expect(probe.child_empty).toEqual(['PATH']);
  });

  // -------------------------------------------------------------------------
  // safe_mx_mcp_env — explicit `extra` handling
  // -------------------------------------------------------------------------

  it('admits a non-secret extra (MXL_AGENT_BIN) supplied explicitly', () => {
    expect(probe.extra_nonsecret_admitted).toBe(true);
  });

  it('refuses every secret-shaped extra with ValueError (cannot re-admit a secret)', () => {
    for (const key of SECRET_EXTRAS) {
      expect(
        probe.extra_rejections[key],
        `secret-shaped extra was admitted instead of rejected: ${key}`,
      ).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // argv builder + ToolContext helper
  // -------------------------------------------------------------------------

  it('builds the documented mx-loom-mcp --stdio argv from non-secret session config', () => {
    expect(probe.argv_full).toEqual([
      '--stdio',
      '--room',
      '!ws:server',
      '--kind',
      'adk',
      '--correlation-id',
      'adk_42',
      '--cwd',
      '/w',
      '--project-id',
      'p',
      '--git-commit',
      'sha',
      '--max-invocations',
      '4',
    ]);
  });

  it('minimal argv is just stdio + room + kind=adk', () => {
    expect(probe.argv_min).toEqual(['--stdio', '--room', '!r:s', '--kind', 'adk']);
  });

  it('rejects a non-positive max_invocations at the Python layer too', () => {
    expect(probe.maxinv_zero_rejected).toBe(true);
  });

  it('mx_session_state returns only the two non-secret ToolContext keys', () => {
    expect(probe.session_state).toEqual({ mx_room: '!ws:server', mx_correlation_id: 'adk_42' });
    // ToolContext is not an authority store: only room + correlation, nothing else.
    expect(Object.keys(probe.session_state).sort()).toEqual(['mx_correlation_id', 'mx_room']);
  });
});
