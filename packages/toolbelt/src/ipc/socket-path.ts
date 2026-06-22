import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SocketPathOptions {
  /** Explicit override (e.g. a `--socket` flag). Always wins. */
  socketPath?: string;
  /** Environment to read (defaults to `process.env`; injectable for tests). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the mx-agent daemon IPC socket path, matching the daemon's own
 * resolution: an explicit override wins; otherwise
 * `$XDG_RUNTIME_DIR/mx-agent/daemon.sock`, falling back to
 * `$TMPDIR/mx-agent/daemon.sock` (macOS, where `XDG_RUNTIME_DIR` is unset).
 */
export function resolveSocketPath(options: SocketPathOptions = {}): string {
  if (options.socketPath !== undefined && options.socketPath.length > 0) {
    return options.socketPath;
  }
  const env = options.env ?? process.env;
  const runtimeDir = env['XDG_RUNTIME_DIR'];
  const base =
    runtimeDir !== undefined && runtimeDir.length > 0 ? runtimeDir : (env['TMPDIR'] ?? tmpdir());
  return join(base, 'mx-agent', 'daemon.sock');
}
