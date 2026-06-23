/**
 * The `canUseTool` HITL hook (T110 / #18) — the requester-side approval surface
 * (AC2).
 *
 * {@link createMxCanUseTool} returns the callback the host passes to
 * `query({ options: { canUseTool } })`. It is the **cleanest HITL hook of the four
 * runtimes** (design §3, Claude bullet): it intercepts an `mx_*` call *before
 * dispatch*, renders a **secret-free** summary for an operator, and maps the
 * operator's decision onto the SDK's allow/deny `PermissionResult`.
 *
 * It is a **local requester-side gate** — distinct from, and strictly weaker than,
 * the receiving daemon's authority:
 *  - A local **deny** short-circuits *before* the tool dispatches (the request is
 *    never signed).
 *  - A local **allow** only permits the request to be signed and dispatched; the
 *    receiving daemon still independently enforces trust/policy/approval and may
 *    still return `awaiting_approval` / `policy_denied`. Cognition produces a signed
 *    *request*; it never grants itself authority, and there is **no** model-facing
 *    approve/deny surface — `onApprovalRequest` is wired to a human/operator, never
 *    to model output.
 *
 * The prompt is built from a **non-secret projection** of the call (verb, target
 * agent/command, an arg *summary* of key names only, a risk hint). It never renders
 * env, tokens, or raw arg values. The args are already secret-free by contract
 * (`assertNoCredentialShapedArgs` rejects credential-shaped keys/values at
 * dispatch), so the projection is defense-in-depth, not the boundary — and it
 * additionally filters any credential-shaped key from the rendered summary using
 * the registry's {@link CREDENTIAL_KEY_RE} oracle.
 */
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { CREDENTIAL_KEY_RE } from '@mx-loom/registry';

import { DEFAULT_SERVER_NAME, mxVerbFromToolName } from './names.js';

/** The risk-bearing (mutating/guarded) verbs prompted for by the default predicate. */
const RISK_BEARING_VERBS: ReadonlySet<string> = new Set(['mx_delegate_tool', 'mx_run_command']);

/**
 * The secret-free HITL payload presented to the operator. Assembled only from
 * non-secret fields; it is **not** a result envelope and never enters the closed
 * error taxonomy.
 */
export interface ApprovalSummary {
  /** The `mx_*` verb being gated (e.g. `mx_delegate_tool`). */
  readonly tool: string;
  /** The target agent id, when the call names one. */
  readonly agent?: string;
  /** The command (for `mx_run_command`), when present. Never includes argv values. */
  readonly command?: string;
  /** A secret-free, value-free arg summary (key names only; credential-shaped keys omitted). */
  readonly args_summary: string;
  /** A coarse risk hint for the operator. */
  readonly risk: 'low' | 'medium' | 'high';
}

/** The host's operator decision surface. Returns `'allow'` or `'deny'`. */
export type OnApprovalRequest = (summary: ApprovalSummary) => Promise<'allow' | 'deny'>;

/**
 * Decide whether a given `mx_*` verb prompts. Receives the **bare** verb (e.g.
 * `mx_delegate_tool`) and the raw input.
 */
export type ShouldPrompt = (verb: string, input: Record<string, unknown>) => boolean;

/** Options for {@link createMxCanUseTool}. */
export interface CreateMxCanUseToolOptions {
  /** The operator decision surface (UI / CLI). Required — there is no model self-approval. */
  onApprovalRequest: OnApprovalRequest;
  /**
   * Which `mx_*` verbs prompt. Default {@link defaultShouldPrompt}: prompt for the
   * risk-bearing verbs (`mx_delegate_tool` / `mx_run_command`); auto-allow the
   * read/observe verbs.
   */
  shouldPrompt?: ShouldPrompt;
  /** The in-process server name to scope-match. Default {@link DEFAULT_SERVER_NAME}. */
  serverName?: string;
  /**
   * The callback any **non-`mx_*`** tool is delegated to (so the shim composes with
   * a host that already has its own `canUseTool`). Default: allow unchanged.
   */
  fallback?: CanUseTool;
}

/**
 * The default prompt predicate: prompt only for the risk-bearing
 * (mutating/guarded) verbs; auto-allow the read/observe verbs. Conservative and
 * needs no daemon round-trip.
 */
export const defaultShouldPrompt: ShouldPrompt = (verb) => RISK_BEARING_VERBS.has(verb);

/** A coarse, secret-free risk hint per verb. */
function riskHint(verb: string): ApprovalSummary['risk'] {
  if (verb === 'mx_run_command') return 'high';
  if (verb === 'mx_delegate_tool') return 'medium';
  return 'low';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Key names with any credential-shaped key dropped (defense-in-depth; values never rendered). */
function nonSecretKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).filter((key) => !CREDENTIAL_KEY_RE.test(key));
}

/**
 * Build the secret-free arg summary. **Only key names** (never values) are
 * rendered, and credential-shaped keys are dropped — so no token, env var, or raw
 * payload can appear.
 */
function summariseArgs(verb: string, input: Record<string, unknown>): string {
  if (verb === 'mx_delegate_tool') {
    const innerTool = typeof input['tool'] === 'string' ? input['tool'] : '(unknown)';
    const innerArgs = isRecord(input['args']) ? input['args'] : {};
    return `tool=${innerTool}; args keys: [${nonSecretKeys(innerArgs).join(', ')}]`;
  }
  if (verb === 'mx_run_command') {
    const argv = Array.isArray(input['args']) ? input['args'] : [];
    const cwd = typeof input['cwd'] === 'string' ? '; cwd set' : '';
    // Never render argv values verbatim — only the count.
    return `argc=${argv.length}${cwd}`;
  }
  return `keys: [${nonSecretKeys(input).join(', ')}]`;
}

/** Assemble the secret-free {@link ApprovalSummary} from a call's non-secret fields. */
function buildApprovalSummary(verb: string, input: Record<string, unknown>): ApprovalSummary {
  const agent = typeof input['agent'] === 'string' ? input['agent'] : undefined;
  const command = typeof input['command'] === 'string' ? input['command'] : undefined;
  return {
    tool: verb,
    ...(agent !== undefined ? { agent } : {}),
    ...(command !== undefined ? { command } : {}),
    args_summary: summariseArgs(verb, input),
    risk: riskHint(verb),
  };
}

/** The default fallback for non-`mx_*` tools: allow unchanged (compose-friendly). */
const allowFallback: CanUseTool = async (_toolName, input) => ({
  behavior: 'allow',
  updatedInput: input,
});

/** Sentinel distinguishing a signal-abort from an operator `'deny'`. */
const ABORTED = Symbol('aborted');

/**
 * Await `promise`, but resolve to {@link ABORTED} if `signal` fires first — so a
 * cancelled turn aborts a pending operator prompt instead of hanging.
 */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      resolve(ABORTED);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Build the `canUseTool` callback the host passes to `query()`.
 *
 * Scope: acts only on this shim's tools (`mcp__<serverName>__mx_*`); any other tool
 * name is delegated to {@link CreateMxCanUseToolOptions.fallback}. For a prompted
 * verb it renders a secret-free {@link ApprovalSummary}, awaits the operator, and
 * maps `'allow'`→`{behavior:'allow', updatedInput}` (args unchanged) /
 * `'deny'`→`{behavior:'deny', message}` (the tool never dispatches). Honors the
 * `AbortSignal`.
 */
export function createMxCanUseTool(options: CreateMxCanUseToolOptions): CanUseTool {
  const serverName = options.serverName ?? DEFAULT_SERVER_NAME;
  const shouldPrompt = options.shouldPrompt ?? defaultShouldPrompt;
  const fallback = options.fallback ?? allowFallback;

  return async (toolName, input, callOptions): Promise<PermissionResult> => {
    const verb = mxVerbFromToolName(toolName, serverName);

    // Not one of this shim's tools → delegate to the host's hook (or allow).
    if (verb === undefined) {
      return fallback(toolName, input, callOptions);
    }

    // Our tool, but not a prompting verb (a read/observe verb) → auto-allow.
    if (!shouldPrompt(verb, input)) {
      return { behavior: 'allow', updatedInput: input };
    }

    // A cancelled turn must not even open the prompt.
    if (callOptions.signal.aborted) {
      return { behavior: 'deny', message: `approval for ${verb} aborted before an operator decision` };
    }

    const summary = buildApprovalSummary(verb, input);
    const decision = await withAbort(options.onApprovalRequest(summary), callOptions.signal);

    if (decision === ABORTED) {
      return { behavior: 'deny', message: `approval for ${verb} aborted before an operator decision` };
    }
    if (decision === 'deny') {
      // Secret-free reason: the verb only, never args/values.
      return { behavior: 'deny', message: `operator denied ${verb}` };
    }
    // Allow: do NOT mutate args. The receiving daemon remains the real authority.
    return { behavior: 'allow', updatedInput: input };
  };
}

/**
 * Compose this shim's HITL hook with a host's existing `canUseTool`: `mx_*` tools
 * are gated here, everything else is delegated to {@link existing}. Sugar for
 * `createMxCanUseTool({ ...options, fallback: existing })`.
 */
export function wrapCanUseTool(
  existing: CanUseTool,
  options: Omit<CreateMxCanUseToolOptions, 'fallback'>,
): CanUseTool {
  return createMxCanUseTool({ ...options, fallback: existing });
}
