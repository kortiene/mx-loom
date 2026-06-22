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
 * Known-secret name **suffixes** denied even via `extraAllow` (T008). An env var
 * whose name ends in one of these is a credential by convention
 * (`GH_TOKEN`, `ANTHROPIC_API_KEY`, `AWS_SECRET_ACCESS_KEY`, `CLIENT_SECRET`),
 * so it must never ride into a tool payload or the CLI child even if a caller
 * explicitly allowlists it. Matched case-insensitively.
 */
export const ENV_DENY_SUFFIXES = ['_TOKEN', '_API_KEY', '_SECRET', '_ACCESS_KEY'] as const;

/**
 * Exact env var names denied even via `extraAllow` (T008). `GH_TOKEN` is the
 * canonical case the secret-boundary rule names; it is also covered by the
 * `_TOKEN` suffix, but is listed explicitly so the deny set documents it.
 * Matched case-insensitively.
 */
export const ENV_DENY_EXACT = ['GH_TOKEN'] as const;

/**
 * Whether a key name is a known-secret shape that must never be forwarded to
 * the CLI child — a deny prefix (`MATRIX_*` / `MX_AGENT_*`), a credential
 * suffix ({@link ENV_DENY_SUFFIXES}), or an exact deny ({@link ENV_DENY_EXACT}).
 *
 * The toolbelt's own `MXL_*` namespace (e.g. `MXL_AGENT_BIN`) is non-secret and
 * matches none of these shapes, so it stays forwardable via `extraAllow`.
 */
export function isDeniedEnvKey(key: string): boolean {
  if (ENV_DENY_PREFIXES.some((prefix) => key.startsWith(prefix))) return true;
  const upper = key.toUpperCase();
  if (ENV_DENY_EXACT.some((exact) => upper === exact)) return true;
  if (ENV_DENY_SUFFIXES.some((suffix) => upper.endsWith(suffix))) return true;
  return false;
}

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
  /** Extra NON-secret keys to forward; known-secret-shaped keys are dropped even here. */
  extraAllow?: readonly string[];
}

/**
 * Build the allowlist environment for the mx-agent CLI child. Deny-by-default:
 * starts from an empty object and copies only allowlisted keys that are present
 * in `source`. Any key that is a known-secret shape ({@link isDeniedEnvKey} —
 * deny prefix, credential suffix, or exact deny) is never copied, even when
 * explicitly requested via `extraAllow`, so `extraAllow` can never re-admit a
 * known secret into a tool payload or the child env (T008).
 */
export function safeSubprocessEnv(options: SafeSubprocessEnvOptions = {}): Record<string, string> {
  const source = options.source ?? process.env;

  // Apply the known-secret deny check to BOTH the base allowlist and extraAllow,
  // so a secret-shaped name is dropped no matter where it was requested.
  const allow = [...BASE_ENV_ALLOW, ...(options.extraAllow ?? [])].filter((key) => !isDeniedEnvKey(key));

  const env: Record<string, string> = {};
  for (const key of allow) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}
