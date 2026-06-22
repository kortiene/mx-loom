/**
 * Deny-by-default subprocess environment for the mx-agent `--json` CLI
 * fallback transport (T003) — acceptance criterion 2.
 *
 * The CLI child is the *mx-agent binary itself*, which needs **no credentials
 * at all**: it reads its Ed25519 signing key and Matrix session from on-disk
 * daemon state (`~/.local/share/mx-agent/`, mode 0600), never from the
 * environment. So this allowlist is deliberately **stricter** than
 * `adw_sdlc/src/env.ts`: it carries NO provider keys (`*_API_KEY`), NO
 * `GH_TOKEN` / `*_TOKEN`, and drops `MATRIX_*` / `MX_AGENT_*` unconditionally.
 *
 * Do NOT import or "unify" this with `adw_sdlc/src/env.ts`. That allowlist
 * intentionally forwards provider credentials to LLM *runner* children
 * (claude/codex/opencode/pi) and would violate the toolbelt's secret boundary
 * (Boundary A). The toolbelt is the chokepoint enforcing "no secret crosses
 * into the CLI child".
 */

/** Prefixes never forwarded to the child, even via `extraAllow`. */
export const ENV_DENY_PREFIXES = ['MATRIX_', 'MX_AGENT_'] as const;

/**
 * Minimal base allowlist: only what the mx-agent CLI needs to locate its
 * socket / on-disk state and run. Intentionally excludes every credential.
 *
 * - `XDG_RUNTIME_DIR` / `TMPDIR` — let the CLI resolve the daemon socket
 *   (matching {@link import('../ipc/socket-path.js').resolveSocketPath}).
 * - `HOME` / `XDG_DATA_HOME` — let it find on-disk daemon state.
 * - `PATH` — let it resolve any helper binaries.
 * - `LANG` / `LC_ALL` / `TERM` — cosmetic locale/term settings.
 *
 * NOTE: trim this against the live binary once available (an over-broad
 * allowlist is a latent leak risk — see spec open question #6). Notably absent
 * by design: `USER`, `SHELL`, and anything credential-shaped.
 */
export const BASE_ENV_ALLOW = [
  'HOME',
  'PATH',
  'XDG_RUNTIME_DIR',
  'XDG_DATA_HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
] as const;

export interface SafeSubprocessEnvOptions {
  /** Parent environment to read from. Default: `process.env`. Injectable for tests. */
  source?: Record<string, string | undefined>;
  /** Extra NON-secret keys to forward; deny-prefixed keys are dropped even here. */
  extraAllow?: readonly string[];
}

/**
 * Build the allowlist environment for the mx-agent CLI child. Deny-by-default:
 * starts from an empty object and copies only allowlisted keys that are present
 * in `source`. Any key matching {@link ENV_DENY_PREFIXES} is never copied, even
 * when explicitly requested via `extraAllow`.
 */
export function safeSubprocessEnv(options: SafeSubprocessEnvOptions = {}): Record<string, string> {
  const source = options.source ?? process.env;

  const allow: string[] = [...BASE_ENV_ALLOW];
  for (const key of options.extraAllow ?? []) {
    if (!ENV_DENY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      allow.push(key);
    }
  }

  const env: Record<string, string> = {};
  for (const key of allow) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}
