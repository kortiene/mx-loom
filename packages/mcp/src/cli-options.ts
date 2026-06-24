/**
 * `mx-loom-mcp` CLI option parsing + session-option projection (T201 / #23).
 *
 * Split out of {@link ./cli.ts} so the flag parsing and the
 * `CliOptions → MxSessionOptions` projection are **pure and unit-pinnable**
 * (no `main()` side effect, no daemon, no socket). The bin (`cli.ts`) is the
 * thin executable wrapper around these.
 *
 * T201 needs a clean ADK session mapping: one `mx-loom-mcp` process ⇒ one
 * `MxSession` registration. The toolbelt's `MxSessionOptions` already carries the
 * metadata ADK wants (`room`, `kind`, `correlationId`, `workspace`,
 * `maxInvocations`), but the CLI previously surfaced only `--room`/`--kind`. This
 * module bridges the remaining **non-secret** session metadata so an ADK host can
 * correlate its session with daemon audit rows and declare its workspace without
 * putting any of it into model-visible tool arguments.
 *
 * Secret boundary: every flag here is non-secret **session config**. There is no
 * flag for Matrix credentials, signing/provider keys, `GH_TOKEN`, trust stores,
 * policy paths, or approval decisions — those never cross Boundary A and are
 * enforced out-of-process on the receiving daemon. The model never names a room;
 * the room is session config, supplied by the host, not a tool arg.
 */
import { parseArgs } from 'node:util';

import type { MxSessionOptions } from '@mx-loom/toolbelt';

/** The parsed `mx-loom-mcp` invocation: transport selection + non-secret session metadata. */
export interface CliOptions {
  /** Select the Streamable-HTTP transport; default (false) is stdio. */
  http: boolean;
  /** HTTP bind host (localhost by default — non-local exposure is explicit operator opt-in). */
  host: string;
  /** HTTP bind port. */
  port: number;
  /** Workspace room to register into (session config — never a model tool arg). */
  room: string | undefined;
  /** Agent kind label (ADK passes `adk`). */
  kind: string | undefined;
  /** Session-stable, non-secret correlation id (joins ADK session activity to audit rows). */
  correlationId: string | undefined;
  /** Optional workspace cwd forwarded to `agent.register` (flat param on v0.2.1). */
  cwd: string | undefined;
  /** Optional workspace project id forwarded to `agent.register`. */
  projectId: string | undefined;
  /** Optional workspace git commit forwarded to `agent.register`. */
  gitCommit: string | undefined;
  /** Optional concurrency declaration (`max_invocations`); validated as a positive integer. */
  maxInvocations: number | undefined;
  /** Enable the best-effort Postgres audit mirror (`--audit` / `MXL_AUDIT_PG=1`). */
  audit: boolean;
}

/**
 * Validate `--max-invocations`: a positive integer or `undefined`.
 *
 * Rejects `0`, negatives, non-integers, and non-numerics with a secret-free
 * message (names only the flag + the offending literal). Thrown errors surface
 * through `cli.ts`'s `main().catch` as a clean `fatal:` exit.
 */
function parseMaxInvocations(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--max-invocations must be a positive integer (received '${raw}')`);
  }
  return value;
}

/**
 * Parse the `mx-loom-mcp` argv into {@link CliOptions}.
 *
 * Backward-compatible: the pre-T201 flags (`--stdio`, `--http`, `--host`,
 * `--port`, `--room`, `--kind`, `--audit`) keep their exact behavior and defaults
 * (`host=127.0.0.1`, `port=7800`, stdio when `--http` is absent). The T201
 * additions (`--correlation-id`, `--cwd`, `--project-id`, `--git-commit`,
 * `--max-invocations`) are all optional and non-secret.
 *
 * `env` is injectable for testing; it only sources the documented `MXL_AUDIT_PG`
 * audit switch (never a credential).
 */
export function parseCliArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): CliOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      stdio: { type: 'boolean' },
      http: { type: 'boolean' },
      host: { type: 'string' },
      port: { type: 'string' },
      room: { type: 'string' },
      kind: { type: 'string' },
      'correlation-id': { type: 'string' },
      cwd: { type: 'string' },
      'project-id': { type: 'string' },
      'git-commit': { type: 'string' },
      'max-invocations': { type: 'string' },
      audit: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  return {
    http: values.http === true,
    host: values.host ?? '127.0.0.1',
    port: values.port !== undefined ? Number(values.port) : 7800,
    room: values.room,
    kind: values.kind,
    correlationId: values['correlation-id'],
    cwd: values.cwd,
    projectId: values['project-id'],
    gitCommit: values['git-commit'],
    maxInvocations: parseMaxInvocations(values['max-invocations']),
    // `--audit` or the documented env switch enables the Postgres mirror.
    audit: values.audit === true || env['MXL_AUDIT_PG'] === '1',
  };
}

/**
 * Project {@link CliOptions} onto `MxSessionOptions`, passing **only defined**
 * values (so an absent flag leaves the option absent — never `undefined` keys).
 *
 * The workspace metadata is grouped under `workspace` exactly as
 * `MxSessionOptions` expects (the toolbelt's `buildRegisterParams` flattens it to
 * the v0.2.1 flat `cwd`/`project_id`/`git_commit` register params). `workspace`
 * is included only when at least one of its fields is set.
 */
export function buildSessionOptions(opts: CliOptions): MxSessionOptions {
  const sessionOptions: MxSessionOptions = {};
  if (opts.room !== undefined) sessionOptions.room = opts.room;
  if (opts.kind !== undefined) sessionOptions.kind = opts.kind;
  if (opts.correlationId !== undefined) sessionOptions.correlationId = opts.correlationId;

  const workspace: { cwd?: string; project_id?: string; git_commit?: string } = {};
  if (opts.cwd !== undefined) workspace.cwd = opts.cwd;
  if (opts.projectId !== undefined) workspace.project_id = opts.projectId;
  if (opts.gitCommit !== undefined) workspace.git_commit = opts.gitCommit;
  if (Object.keys(workspace).length > 0) sessionOptions.workspace = workspace;

  if (opts.maxInvocations !== undefined) sessionOptions.maxInvocations = opts.maxInvocations;

  return sessionOptions;
}
