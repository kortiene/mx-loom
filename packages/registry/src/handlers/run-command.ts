/**
 * `mx_run_command` — guarded exec (T106 / #14) — design §2 (the delegation
 * surface: named tools **+** guarded exec) / §6 layer 4 ("Guarded exec") / §9
 * ("Guarded exec only — no unrestricted exec"). The second delegation verb,
 * mapping to the daemon RPC `exec.start` → `ExecRequest`, the sibling of
 * `call.start`.
 *
 * "Run an *allowlisted command* on a remote agent and turn the daemon's
 * `ExecResponse` into the normalized T102 envelope." It is the leaner sibling of
 * {@link mxDelegateTool}: a `deferred` mutating handler whose body is **three
 * phases plus an optional inline-wait** — **room provenance → dispatch `exec.start`
 * with idempotency → normalize the `ExecResponse`** — with no inner-schema fetch
 * and no args validation (exec has a fixed input shape, not a dynamic per-tool
 * `input_schema`).
 *
 * **The guard is NOT here — and that is the point (`area/policy`).** The handler
 * emits a *signed request* and nothing more; it performs **no** allowlist /
 * `deny_args_regex` / `allow_cwd` / sandbox / `requires_approval` check. The
 * receiving daemon's deny-by-default `policy.toml` is the only thing that says
 * "yes" (design §1, §6 layer 4). So "disabled by default → `policy_denied`" is an
 * outcome this handler **surfaces cleanly**, never a check it performs: a model that
 * names `mx_run_command` on a target whose operator never allowlisted a command
 * gets a clean `denied('policy_denied')` envelope — the same shape every other tool
 * returns — and keeps planning. Re-implementing any guard locally would both
 * duplicate the authority surface (forbidden) and create a false sense that the
 * toolbelt is the boundary (it is not).
 *
 * **Non-zero exit is a *success*.** A command the receiver allowed and ran but that
 * exits non-zero (tests failed, a linter found issues) is `status: ok` with
 * `result.exit_code !== 0`. The envelope `status` reflects the **coordination /
 * governance** outcome (was it allowlisted, did it run, was it approved), **not**
 * the command's own exit semantics; `denied` / `error` are reserved for the daemon
 * refusing or failing to run the command at all. A binding/model reads
 * `result.exit_code` for the command's own success/failure.
 *
 * **Secret boundary.** No field carries a credential inbound or outbound. The
 * concrete `deps.daemon.call` (an `MxClient` in production) runs
 * `assertNoCredentialShapedArgs` before dispatch over both keys **and** values — so
 * a token-shaped arg (e.g. `['-H', 'Authorization: Bearer ghp_…']`) is rejected as
 * `invalid_args` rather than becoming a command line — and `redactSecrets` on the
 * inbound result (T008). This matters more for exec than delegation: args are the
 * likeliest place a model would try to inline a secret. The registry re-implements
 * neither and keeps its zero **runtime** toolbelt dependency (the seam is injected,
 * imported `type`-only).
 *
 * Wire-shape assumptions (the `exec.start` param names, the `ExecResponse`
 * disposition vocabulary, the success payload field names `exit_code`/`summary`/
 * `log_ref`, the held-invocation `approval` fields, and the `audit_ref` field
 * availability) are **pending the two-daemon round-trip**
 * (`MXL_CONFORMANCE_TWO_DAEMON=1`): authored against the design's named shapes, with
 * the method/param names localised below so the fixture corrects them in one place,
 * reusing the T102/T105 token tables + `internal`-safe fallbacks so a new daemon
 * code degrades to `internal` (never the wrong code), never throws.
 */
import { errored, type ToolResult } from '../envelope.js';
import { newIdempotencyKey } from '../idempotency.js';
import { mxAwaitResult } from './await-result.js';
import type { ExecDeps } from './deps.js';
import { EMPTY_AUDIT_REF, faultToResult } from './handler-fault.js';
import { callResponseToResult, isTerminal } from './invocation.js';

/**
 * The daemon RPC + param names this handler consumes. Localised so the two-daemon
 * round-trip (or a pin bump) corrects the wire in one place — the
 * `await-result.ts` / `delegate-tool.ts` precedent. The `exec.start` param names
 * (`room`/`agent`/`command`/`args`/`cwd`/`idempotency_key`) are pinned at the
 * round-trip; they likely mirror `call.start`, which the conformance probe already
 * supplies `room` for.
 */
const EXEC_START_METHOD = 'exec.start';

/**
 * Input of `mx_run_command` — the descriptor's input schema (`agent` / `command`
 * required; `args` / `cwd` / `wait_ms` / `idempotency_key` optional). There is no
 * inner-tool schema: `command` / `args` / `cwd` are forwarded verbatim and the
 * receiver's policy decides.
 */
export interface RunCommandInput {
  /** The target agent id. */
  readonly agent: string;
  /** The allowlisted binary to run (subject to the receiver's `allow_commands`). */
  readonly command: string;
  /** Command arguments (subject to the receiver's `deny_args_regex`). */
  readonly args?: readonly string[];
  /** Working directory (subject to the receiver's `allow_cwd`). */
  readonly cwd?: string;
  /** Optional inline wait before returning a deferred handle (the §4.3 / T103 poll hint). */
  readonly wait_ms?: number;
  /** Optional client-supplied idempotency key; generated once per invocation when omitted. */
  readonly idempotency_key?: string;
}

/**
 * Run an allowlisted command on a remote agent and return its normalized
 * {@link ToolResult}. Never throws — every transport/daemon fault maps onto the
 * closed T102 taxonomy (`faultToResult`) or a builder. Performs **no**
 * allowlist/regex/cwd/sandbox check: the guard runs entirely on the receiving
 * daemon (design §6, §9).
 */
export async function mxRunCommand(input: RunCommandInput, deps: ExecDeps): Promise<ToolResult> {
  // Phase 1 — room provenance. The model never names a Matrix room (design §1/§7);
  // the binding injects it from the `MxSession`. Fail fast rather than dispatch a
  // room-less `exec.start` (no Matrix round-trip happened → EMPTY_AUDIT_REF).
  // Mirrors `mxDelegateTool` Phase 0.
  if (deps.room === undefined || deps.room === '') {
    return errored('internal', 'no workspace room configured for exec', EMPTY_AUDIT_REF);
  }

  // Phase 2 — dispatch `exec.start` with idempotency. The key rides in `params`,
  // so `MxClient.withRetry`'s verbatim param reuse keeps it stable across
  // transport-level retries (T102 §4.4); the handler never regenerates it.
  // `command` / `args` / `cwd` are forwarded VERBATIM — the receiver allowlists the
  // command, runs `deny_args_regex` over the args, and enforces `allow_cwd`. No
  // client-side check happens here. `args` defaults to `[]` and `cwd` is omitted
  // when absent so no `undefined` leaks into the params object.
  const idempotency_key = input.idempotency_key ?? newIdempotencyKey();
  const params = {
    room: deps.room, // from MxSession, not model input
    agent: input.agent,
    command: input.command,
    args: input.args ?? [],
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    idempotency_key,
  };
  let response: unknown;
  try {
    response = await deps.daemon.call(EXEC_START_METHOD, params);
  } catch (err) {
    // A daemon JSON-RPC error (policy_denied / untrusted_key / …) or a transport
    // fault → the mapped envelope. AC 1 / AC 3: a deny-by-default `policy_denied`
    // (un-allowlisted command, OR a `deny_args_regex` match, OR a `cwd` outside
    // `allow_cwd`) maps to `denied('policy_denied')`. A credential-shaped
    // `command`/`args` value is rejected at dispatch as `invalid_args`.
    return faultToResult(err, EMPTY_AUDIT_REF);
  }

  // Phase 3 — normalize the `ExecResponse` into the envelope (AC 2, AC 3). Reuses
  // T105's `callResponseToResult`: the `ExecResponse` disposition vocabulary is
  // identical to `CallResponse` — a synchronous success carrying the exec payload
  // (`{ exit_code, summary?, log_ref? }`), a deferred `running` handle, a held
  // `awaiting_approval` (handle + approval block; the expected path for a high-risk
  // `requires_approval` command), or a denial/fault terminal. The success `result`
  // passes through verbatim, so a non-zero `exit_code` stays `status: ok`. AC 3
  // also covers a denial that arrives as a resolved `ExecResponse{ok:false}` rather
  // than a thrown rpc error. `audit_ref` is populated from the response — exec IS a
  // Matrix round-trip (null inner ids when the daemon omits them, never fabricated).
  const result = callResponseToResult(response);

  // Phase 4 — optional inline wait. If the result is non-terminal and `wait_ms` is
  // a positive integer, compose `mx_await_result` on the handle so a fast command
  // feels synchronous. Inherits T103's property that a `wait_ms` expiry returns the
  // still-pending envelope (`error: null`), never `errored('timeout')`.
  if (!isTerminal(result.status) && isPositiveWait(input.wait_ms) && result.handle) {
    return mxAwaitResult({ handle: result.handle, wait_ms: input.wait_ms }, deps);
  }

  return result;
}

/** A finite, positive `wait_ms` (the descriptor already constrains it to int ≥ 0;
 *  this is the defensive floor mirroring `delegate-tool.ts` / `await-result.ts`). */
function isPositiveWait(wait_ms: number | undefined): wait_ms is number {
  return typeof wait_ms === 'number' && Number.isFinite(wait_ms) && wait_ms > 0;
}
