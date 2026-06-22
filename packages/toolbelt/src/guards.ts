/**
 * Cross-transport credential-shaped-argument guard.
 *
 * The secret-free tool contract (design §4.7) is **transport-independent**: no
 * tool field may carry a credential inbound or outbound. The CLI path needs it
 * acutely — argv is world-visible via `/proc/<pid>/cmdline` and `ps` — but the
 * IPC path is equally bound by the contract even though `ipc/errors.ts` notes
 * IPC "never emits `invalid_args`" on its own. The unified client (T004) calls
 * this **before dispatch to either transport**, so a credential-shaped argument
 * is rejected uniformly regardless of which transport would answer.
 *
 * Extracted from `cli/client.ts` (T003) with behavior unchanged so both the CLI
 * client and `MxClient` share one definition. T008 hardens the deny-list and
 * adds inbound result redaction; this is the shared seam both build on.
 */
import { TransportError } from './transport.js';

/**
 * Param **keys** that look credential-shaped. Reject before they can become
 * argv or ride an IPC frame.
 *
 * The `token` alternative is **boundaried** (`(?:^|[_-])token$`) rather than a
 * bare substring: delegation forwards arbitrary inner-tool args, many of which
 * legitimately contain `token` (`max_tokens`, `token_count`, `num_tokens`).
 * Boundaried matching rejects the credential cases — `token`, `*_token` /
 * `*-token` (so `GH_TOKEN`, `access_token`, `auth_token`, `mx_agent_token`) —
 * while accepting the count-shaped pass-through keys. `gh[_-]?token` is named
 * explicitly (covers a separator-less `ghtoken`). `mx_agent_` mirrors the
 * existing `matrix_` prefix (the rule names both env namespaces). The
 * `api[_-]?key` / `signing[_-]?key` / `private[_-]?key` alternatives keep the
 * optional separator so separator-less `apikey` / `signingkey` still reject.
 */
export const CREDENTIAL_KEY_RE =
  /(?:secret|password|passwd|api[_-]?key|signing[_-]?key|private[_-]?key|matrix_|mx_agent_|gh[_-]?token|(?:^|[_-])token$)/i;

/**
 * A handful of well-known secret *value* shapes. All alternatives are anchored
 * with `^`, so only a value that **starts** with a known prefix is rejected — a
 * log line or doc string that merely contains a token-shaped substring passes
 * (low false-positive on legitimate pass-through args/results).
 *
 * Coverage: GitHub (`ghp_`/`gho_`/…, `github_pat_`), Matrix (`syt_`), Slack
 * (`xox[abprs]-`), Anthropic (`sk-ant-`), OpenAI (`sk-` + ≥20 alphanumerics —
 * bounded so it does not catch a short `sk-foo`), AWS access-key ids
 * (`AKIA…`, case-sensitive), and PEM private-key headers.
 */
export const CREDENTIAL_VALUE_RE =
  /^(?:gh[posru]_|github_pat_|syt_|xox[abprs]-|sk-ant-|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

/**
 * Recursively reject credential-shaped params *before* dispatch. Throws
 * `TransportError('invalid_args')`; error messages name only the key/path,
 * never the value, so they stay secret-free.
 */
export function assertNoCredentialShapedArgs(value: unknown, path = '$'): void {
  if (typeof value === 'string') {
    if (CREDENTIAL_VALUE_RE.test(value)) {
      throw new TransportError('invalid_args', `refusing to send a credential-shaped value at ${path}`);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoCredentialShapedArgs(item, `${path}[${i}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_KEY_RE.test(key)) {
      throw new TransportError('invalid_args', `refusing to send credential-shaped argument '${key}'`);
    }
    assertNoCredentialShapedArgs(child, `${path}.${key}`);
  }
}

/** Fixed, non-reversible placeholder substituted for a redacted secret-shaped value. */
export const REDACTION_PLACEHOLDER = '«redacted»';

/**
 * Inbound, **defense-in-depth** result redaction (the symmetric counterpart of
 * {@link assertNoCredentialShapedArgs}). Walks a daemon-returned result and
 * replaces any **known secret-shaped string value** ({@link CREDENTIAL_VALUE_RE})
 * with {@link REDACTION_PLACEHOLDER} before the result returns toward the model
 * context.
 *
 * High-precision by design — it matches **value shape only**, never key name,
 * because the daemon legitimately returns public fields named `signing_key_id` /
 * `signing_public_key`; redacting by key would corrupt them. So a clean result
 * is returned structurally unchanged and legitimate values are never corrupted.
 *
 * This is a **backstop, not the boundary**: the daemon owns secrets
 * out-of-process and must never return one (the conformance Tier 1 secret-boundary
 * assertion is the contract). Redaction guarantees that *even if* a daemon bug
 * leaked a token-shaped value, it cannot reach the model context.
 *
 * Returns a structurally-cloned copy; **never mutates** the input. When it
 * fires it reports via `onRedact` with the path only — never the value — so no
 * secret is logged.
 */
export function redactSecrets(value: unknown, onRedact?: (path: string) => void, path = '$'): unknown {
  if (typeof value === 'string') {
    if (CREDENTIAL_VALUE_RE.test(value)) {
      onRedact?.(path);
      return REDACTION_PLACEHOLDER;
    }
    return value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item, i) => redactSecrets(item, onRedact, `${path}[${i}]`));
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = redactSecrets(child, onRedact, `${path}.${key}`);
  }
  return out;
}
