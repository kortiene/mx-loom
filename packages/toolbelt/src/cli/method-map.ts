import { TransportError } from '../transport.js';

/** A pure mapping of an RPC method (+ params) to a CLI argv and optional stdin. */
export interface ArgvPlan {
  /** argv passed to the mx-agent binary, e.g. `['daemon', 'status', '--json']`. */
  argv: string[];
  /** JSON to write to the child's stdin, paired with `--input-json -`. */
  stdin?: string;
}

/**
 * Map a dotted daemon RPC method to the mx-agent CLI's noun/verb argv form.
 *
 * The daemon RPC namespace is dotted (`daemon.status`, `agent.list`,
 * `call.start`); the CLI is noun/verb (`mx-agent daemon status --json`,
 * `mx-agent agent list --json`) per the verified v0.2.1 surface. The default
 * rule splits `method` on `.` and appends `--json`, which covers the M0 read
 * methods the IPC client already round-trips (`daemon.status`, `daemon.ping`,
 * `agent.list`, `agent.show`, `agent.tools`, `workspace.status`).
 *
 * Structured params are passed via `--input-json -` on the child's **stdin**,
 * never on argv: argv is world-readable via `/proc/<pid>/cmdline` and `ps`, so
 * even non-secret args must not ride the command line. (`--input-json` is
 * confirmed on `task create`; whether `--input-json -` / stdin is accepted for
 * every verb is verified per verb as the M1 tools land — spec open question #2.)
 *
 * Pure and data-driven (no I/O): adding mutating verbs in M1 with discrete
 * flags is a table edit here, not a rewrite.
 */
export function methodToArgv(method: string, params?: unknown): ArgvPlan {
  const parts = method.split('.').filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new TransportError('invalid_args', `empty or malformed RPC method: '${method}'`);
  }

  const argv = [...parts, '--json'];
  if (params === undefined || params === null) {
    return { argv };
  }

  argv.push('--input-json', '-');
  return { argv, stdin: JSON.stringify(params) };
}
