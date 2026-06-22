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
 */
export const CREDENTIAL_KEY_RE =
  /(?:token|secret|password|passwd|api[_-]?key|signing[_-]?key|private[_-]?key|matrix_)/i;

/** A handful of well-known secret *value* shapes (GitHub / Matrix / Slack tokens). */
export const CREDENTIAL_VALUE_RE = /^(?:gh[posru]_|github_pat_|syt_|xox[abprs]-)/;

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
