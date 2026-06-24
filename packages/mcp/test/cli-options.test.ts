/**
 * `mx-loom-mcp` CLI option parsing + session projection (T201 / #23).
 *
 * Focused, daemon-free coverage for the pure {@link ../src/cli-options.ts}
 * module the bin wraps:
 *  - the pre-T201 flags (`--stdio`/`--http`/`--host`/`--port`/`--room`/`--kind`/
 *    `--audit`) keep their exact behavior and defaults (backward-compat);
 *  - the T201 session flags (`--correlation-id`/`--cwd`/`--project-id`/
 *    `--git-commit`/`--max-invocations`) parse and project onto `MxSessionOptions`;
 *  - `--max-invocations` is validated as a positive integer;
 *  - `buildSessionOptions` emits only defined keys and groups workspace fields.
 *
 * Plus the **secret-boundary parity drift guard**: the ADK example's Python
 * deny-by-default env helper (`examples/adk/mcp_toolset_agent.py`) must mirror the
 * canonical toolbelt rules (`packages/toolbelt/src/cli/env.ts`) 1:1. The spec
 * flags a divergent Python list as a latent secret leak; this test parses the
 * Python tuples and asserts they equal the exported toolbelt constants, so any
 * drift fails CI rather than silently weakening Boundary A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BASE_ENV_ALLOW,
  CREDENTIAL_KEY_RE,
  ENV_DENY_EXACT,
  ENV_DENY_PREFIXES,
  ENV_DENY_SUFFIXES,
} from '@mx-loom/toolbelt';
import { isForbiddenAuthorityVerb } from '@mx-loom/registry';
import { describe, expect, it } from 'vitest';

import { buildSessionOptions, parseCliArgs } from '../src/cli-options.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

/** Strip Python `#` comments so a `)` inside `(Linux)` cannot end a literal early. */
function stripPyComments(source: string): string {
  return source
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n');
}

/** Extract the contents of a `NAME = ( ... )` Python tuple/frozenset literal as a string list. */
function pyStringSeq(source: string, name: string): string[] {
  const clean = stripPyComments(source);
  const re = new RegExp(`${name}\\s*=\\s*(?:frozenset\\()?[\\(\\{]([\\s\\S]*?)[\\)\\}]`, 'm');
  const match = re.exec(clean);
  expect(match, `missing Python literal ${name}`).not.toBeNull();
  const body = match![1] ?? '';
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '');
}

describe('parseCliArgs — backward compatibility', () => {
  it('defaults to stdio with localhost HTTP coordinates and no session metadata', () => {
    const opts = parseCliArgs([], {});
    expect(opts.http).toBe(false);
    expect(opts.host).toBe('127.0.0.1');
    expect(opts.port).toBe(7800);
    expect(opts.room).toBeUndefined();
    expect(opts.kind).toBeUndefined();
    expect(opts.correlationId).toBeUndefined();
    expect(opts.cwd).toBeUndefined();
    expect(opts.projectId).toBeUndefined();
    expect(opts.gitCommit).toBeUndefined();
    expect(opts.maxInvocations).toBeUndefined();
    expect(opts.audit).toBe(false);
  });

  it('keeps the existing --http/--host/--port/--room/--kind behavior', () => {
    const opts = parseCliArgs(
      ['--http', '--host', '0.0.0.0', '--port', '9000', '--room', '!r:server', '--kind', 'adk'],
      {},
    );
    expect(opts.http).toBe(true);
    expect(opts.host).toBe('0.0.0.0');
    expect(opts.port).toBe(9000);
    expect(opts.room).toBe('!r:server');
    expect(opts.kind).toBe('adk');
  });

  it('enables audit via --audit or MXL_AUDIT_PG=1, off otherwise', () => {
    expect(parseCliArgs(['--audit'], {}).audit).toBe(true);
    expect(parseCliArgs([], { MXL_AUDIT_PG: '1' }).audit).toBe(true);
    expect(parseCliArgs([], { MXL_AUDIT_PG: '0' }).audit).toBe(false);
    expect(parseCliArgs([], {}).audit).toBe(false);
  });
});

describe('parseCliArgs — T201 session flags', () => {
  it('parses --correlation-id and the workspace metadata flags', () => {
    const opts = parseCliArgs(
      [
        '--stdio',
        '--room',
        '!ws:server',
        '--correlation-id',
        'adk_sess_42',
        '--cwd',
        '/work/proj',
        '--project-id',
        'proj-1',
        '--git-commit',
        'abc123',
      ],
      {},
    );
    expect(opts.correlationId).toBe('adk_sess_42');
    expect(opts.cwd).toBe('/work/proj');
    expect(opts.projectId).toBe('proj-1');
    expect(opts.gitCommit).toBe('abc123');
  });

  it('parses a valid --max-invocations and rejects non-positive / non-integer values', () => {
    expect(parseCliArgs(['--max-invocations', '4'], {}).maxInvocations).toBe(4);
    expect(() => parseCliArgs(['--max-invocations', '0'], {})).toThrow(/positive integer/);
    expect(() => parseCliArgs(['--max-invocations', '2.5'], {})).toThrow(/positive integer/);
    expect(() => parseCliArgs(['--max-invocations', 'abc'], {})).toThrow(/positive integer/);
    // A dash-prefixed value must use the `=` form (parseArgs ambiguity rule); our
    // validator still rejects the negative integer it carries.
    expect(() => parseCliArgs(['--max-invocations=-3'], {})).toThrow(/positive integer/);
  });
});

describe('buildSessionOptions — projection', () => {
  it('omits absent options entirely (no undefined keys)', () => {
    const sessionOptions = buildSessionOptions(parseCliArgs([], {}));
    expect(sessionOptions).toEqual({});
    expect(Object.keys(sessionOptions)).not.toContain('workspace');
  });

  it('groups workspace fields and forwards room/kind/correlation/max', () => {
    const sessionOptions = buildSessionOptions(
      parseCliArgs(
        [
          '--room',
          '!ws:server',
          '--kind',
          'adk',
          '--correlation-id',
          'adk_x',
          '--cwd',
          '/w',
          '--project-id',
          'p',
          '--git-commit',
          'sha',
          '--max-invocations',
          '8',
        ],
        {},
      ),
    );
    expect(sessionOptions).toEqual({
      room: '!ws:server',
      kind: 'adk',
      correlationId: 'adk_x',
      workspace: { cwd: '/w', project_id: 'p', git_commit: 'sha' },
      maxInvocations: 8,
    });
  });

  it('includes workspace only when at least one workspace field is set', () => {
    const onlyCwd = buildSessionOptions(parseCliArgs(['--cwd', '/w'], {}));
    expect(onlyCwd).toEqual({ workspace: { cwd: '/w' } });

    const noWorkspace = buildSessionOptions(parseCliArgs(['--room', '!r:server'], {}));
    expect(noWorkspace).toEqual({ room: '!r:server' });
  });

  it('groups a partial workspace (no --cwd) without inventing the missing field', () => {
    // project_id + git_commit but no cwd: the workspace object must carry exactly
    // the two set fields and never a `cwd: undefined` key (the projection emits
    // only defined values — an absent flag leaves the option absent).
    const sessionOptions = buildSessionOptions(
      parseCliArgs(['--project-id', 'p', '--git-commit', 'sha'], {}),
    );
    expect(sessionOptions).toEqual({ workspace: { project_id: 'p', git_commit: 'sha' } });
    expect(Object.keys(sessionOptions.workspace ?? {})).not.toContain('cwd');
  });

  it('--stdio is accepted and does not flip the transport (http stays false)', () => {
    // `--stdio` is the documented default-transport selector; it is parsed (no
    // ERR_PARSE_ARGS_UNKNOWN_OPTION) but carries no CliOptions field — the only
    // transport signal is `http`, which must remain false.
    const opts = parseCliArgs(['--stdio', '--room', '!r:server'], {});
    expect(opts.http).toBe(false);
    expect(buildSessionOptions(opts)).toEqual({ room: '!r:server' });
  });
});

// ---------------------------------------------------------------------------
// Secret boundary at the CLI surface: the parser is a closed allowlist of
// NON-secret flags. parseArgs runs in strict mode (no `strict: false`), so any
// unknown flag throws ERR_PARSE_ARGS_UNKNOWN_OPTION — which means there is no
// way to introduce a Matrix/provider/GitHub credential or an authority-mutation
// decision through the bin's argv. These tests pin that no such flag exists and
// that the projection never emits a credential- or authority-shaped key.
// ---------------------------------------------------------------------------

describe('CLI surface carries no secret / no authority flag (Boundary A)', () => {
  // Credential- and authority-shaped flags a leaky CLI might have grown. None of
  // these may be a recognized option; the strict parser must reject each.
  const FORBIDDEN_FLAGS = [
    '--matrix-token',
    '--matrix-access-token',
    '--access-token',
    '--api-key',
    '--anthropic-api-key',
    '--openai-api-key',
    '--google-api-key',
    '--gh-token',
    '--signing-key',
    '--private-key',
    '--secret',
    '--database-url',
    '--pgpassword',
    '--pg-host',
    '--matrix-session', // prefix-only MATRIX_* shape (not just *_TOKEN)
    '--mx-agent-home', // prefix-only MX_AGENT_* shape (not just *_SECRET)
    '--trust', // authority: Ed25519 trust mutation
    '--trust-store', // authority: trust material/path
    '--policy', // authority: policy.toml override
    '--policy-path', // authority: policy override path
    '--approve', // authority: approval decision
    '--approval', // authority: approval decision
    '--approval-decide', // authority: approval decision
    '--deny', // authority: approval decision
  ] as const;

  it('rejects every credential-/authority-shaped flag as an unknown option', () => {
    for (const flag of FORBIDDEN_FLAGS) {
      // Strict parseArgs throws ERR_PARSE_ARGS_UNKNOWN_OPTION for an undeclared
      // flag — i.e. the flag does not exist in the option set at all.
      expect(() => parseCliArgs([flag, 'x'], {}), `flag unexpectedly accepted: ${flag}`).toThrow();
      try {
        parseCliArgs([flag, 'x'], {});
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe('ERR_PARSE_ARGS_UNKNOWN_OPTION');
      }
    }
  });

  it('every recognized flag name is non-secret per the canonical oracle', () => {
    // The flags the bin DOES accept (kebab-case argv spellings), including the
    // boolean transport/audit toggles. Each must be non-secret by the toolbelt's
    // own CREDENTIAL_KEY_RE and must not be an authority verb — the CLI is
    // non-secret session config only.
    const RECOGNIZED_FLAGS = [
      'stdio',
      'http',
      'host',
      'port',
      'room',
      'kind',
      'correlation-id',
      'cwd',
      'project-id',
      'git-commit',
      'max-invocations',
      'audit',
    ] as const;
    for (const flag of RECOGNIZED_FLAGS) {
      const asKey = flag.replace(/-/g, '_');
      expect(CREDENTIAL_KEY_RE.test(asKey), `recognized flag is credential-shaped: ${flag}`).toBe(
        false,
      );
      expect(isForbiddenAuthorityVerb(flag), `recognized flag is an authority verb: ${flag}`).toBe(
        false,
      );
    }
  });

  it('buildSessionOptions emits only a closed set of NON-secret session keys', () => {
    // A maximal, all-flags-set invocation: the projected MxSessionOptions must
    // contain only the known non-secret keys, and NO key (top-level or nested
    // workspace) may be credential-shaped per the canonical oracle.
    const sessionOptions = buildSessionOptions(
      parseCliArgs(
        [
          '--room',
          '!ws:server',
          '--kind',
          'adk',
          '--correlation-id',
          'adk_x',
          '--cwd',
          '/w',
          '--project-id',
          'p',
          '--git-commit',
          'sha',
          '--max-invocations',
          '8',
        ],
        {},
      ),
    );

    const ALLOWED_SESSION_KEYS = new Set([
      'room',
      'kind',
      'correlationId',
      'workspace',
      'maxInvocations',
    ]);
    for (const key of Object.keys(sessionOptions)) {
      expect(ALLOWED_SESSION_KEYS.has(key), `unexpected session key: ${key}`).toBe(true);
      expect(CREDENTIAL_KEY_RE.test(key), `session key is credential-shaped: ${key}`).toBe(false);
    }
    for (const key of Object.keys(sessionOptions.workspace ?? {})) {
      expect(CREDENTIAL_KEY_RE.test(key), `workspace key is credential-shaped: ${key}`).toBe(false);
    }
  });
});

describe('ADK example safe-env parity with the toolbelt source of truth', () => {
  const py = readRepoFile('examples/adk/mcp_toolset_agent.py');

  it('mirrors ENV_DENY_PREFIXES / ENV_DENY_SUFFIXES / ENV_DENY_EXACT exactly', () => {
    expect(pyStringSeq(py, '_DENY_ENV_PREFIXES')).toEqual([...ENV_DENY_PREFIXES]);
    expect(pyStringSeq(py, '_DENY_ENV_SUFFIXES')).toEqual([...ENV_DENY_SUFFIXES]);
    expect(pyStringSeq(py, '_DENY_ENV_EXACT')).toEqual([...ENV_DENY_EXACT]);
  });

  it('mirrors BASE_ENV_ALLOW exactly (no extra/missing base allow keys)', () => {
    expect(pyStringSeq(py, '_BASE_ENV_ALLOW')).toEqual([...BASE_ENV_ALLOW]);
  });

  it('only admits non-secret mx-loom-namespaced extras and never the audit DSN', () => {
    const extras = pyStringSeq(py, '_EXTRA_ENV_ALLOW');
    // Every extra is itself non-secret per the canonical deny rules.
    for (const key of extras) {
      const upper = key.toUpperCase();
      const denied =
        ENV_DENY_PREFIXES.some((p) => upper.startsWith(p)) ||
        ENV_DENY_SUFFIXES.some((s) => upper.endsWith(s)) ||
        (ENV_DENY_EXACT as readonly string[]).includes(upper);
      expect(denied, `extra-allow key is secret-shaped: ${key}`).toBe(false);
    }
    // The credential-shaped audit DSN must never be on the allowlist.
    expect(extras).not.toContain('DATABASE_URL');
  });
});

// ---------------------------------------------------------------------------
// Cross-language argv seam: the Python factory (examples/adk) builds the
// `mx-loom-mcp` argv; the bin (this package) parses it. The static list-parity
// test above guards the env allowlist, but NOT the argv contract — a renamed or
// dropped CLI flag would silently break ADK at spawn time. This block pins the
// seam by extracting every `--flag` literal the Python emits and asserting the
// bin's parser actually recognizes it (and projects a representative argv).
// ---------------------------------------------------------------------------

describe('ADK example argv seam ↔ mx-loom-mcp CLI parser', () => {
  const py = readRepoFile('examples/adk/mcp_toolset_agent.py');

  /** Every distinct `"--flag"` literal the Python factory emits into argv. */
  function pyEmittedFlags(source: string): string[] {
    const clean = stripPyComments(source);
    const flags = new Set<string>();
    for (const m of clean.matchAll(/"(--[a-z][a-z-]*)"/g)) flags.add(m[1]!);
    return [...flags].sort();
  }

  it('emits at least the documented T201 session flags', () => {
    const flags = pyEmittedFlags(py);
    // The recipe must wire stdio + the room/kind/correlation session mapping.
    for (const required of ['--stdio', '--room', '--kind', '--correlation-id']) {
      expect(flags, `Python factory no longer emits ${required}`).toContain(required);
    }
  });

  it('every flag the Python factory emits is a recognized bin option (no drift)', () => {
    // A drift check focused on EXISTENCE, not value validation: feed each emitted
    // flag a universally-valid value ('1' is a fine string and a valid positive
    // integer for --max-invocations). `--stdio` is boolean (no value). A renamed
    // or dropped flag throws ERR_PARSE_ARGS_UNKNOWN_OPTION — that (and only that)
    // is the drift this test must catch.
    for (const flag of pyEmittedFlags(py)) {
      const argv = flag === '--stdio' ? [flag] : [flag, '1'];
      let thrownCode: string | undefined;
      try {
        parseCliArgs(argv, {});
      } catch (err) {
        thrownCode = (err as NodeJS.ErrnoException).code;
      }
      expect(
        thrownCode,
        `Python emits ${flag} but the bin does not recognize it (drift)`,
      ).not.toBe('ERR_PARSE_ARGS_UNKNOWN_OPTION');
    }
  });

  it('parses a representative full ADK invocation and projects the session mapping', () => {
    // The exact argv shape `mx_mcp_toolset(...)` produces for a fully-specified
    // host: stdio + room + kind=adk + correlation + workspace + concurrency.
    const opts = parseCliArgs(
      [
        '--stdio',
        '--room',
        '!workspace:server',
        '--kind',
        'adk',
        '--correlation-id',
        'adk_sess_77',
        '--cwd',
        '/work/proj',
        '--project-id',
        'proj-1',
        '--git-commit',
        'deadbeef',
        '--max-invocations',
        '3',
      ],
      {},
    );
    expect(opts.http).toBe(false);
    expect(opts.kind).toBe('adk');
    expect(buildSessionOptions(opts)).toEqual({
      room: '!workspace:server',
      kind: 'adk',
      correlationId: 'adk_sess_77',
      workspace: { cwd: '/work/proj', project_id: 'proj-1', git_commit: 'deadbeef' },
      maxInvocations: 3,
    });
  });
});
