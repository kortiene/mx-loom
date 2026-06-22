/**
 * `mx_delegate_tool` — the primary delegation verb (T105 / #13) — design §2 (the
 * delegation verbs) / §4.1 (`input_schema` pass-through) / §5 (the invocation
 * flow: `model → mx-loom → call.start → remote daemon → CallResponse → envelope`).
 *
 * "Invoke a *named tool* on a remote agent and turn the daemon's `CallResponse`
 * into the normalized T102 envelope." This is the spine of the fabric: discovery
 * (T104) tells the model who is in the room and what they publish; delegation is
 * the verb that **acts** on that mesh.
 *
 * A `deferred` mutating handler mirroring the T103/T104 precedent. Its body is four
 * phases (plus an optional inline-wait): **resolve the inner schema → validate the
 * args → dispatch `call.start` → normalize the `CallResponse`**. It reuses the
 * injected {@link DelegateDeps} seam (no socket / no env), builds the result only
 * through the T102 helpers, and **never throws** — every transport/daemon fault
 * maps onto the closed taxonomy (`faultToResult`) or a builder.
 *
 * **Authority stays out-of-process.** The handler emits a *signed request* only; it
 * performs no trust/policy/approval/sandbox check itself. `policy_denied` /
 * `untrusted_key` / `awaiting_approval` are outcomes it *maps*, never decisions it
 * makes — all five enforcement layers run on the receiving daemon (design §1, §6).
 *
 * **Secret boundary.** No field carries a credential inbound or outbound. The
 * concrete `deps.daemon.call` (an `MxClient` in production) runs
 * `assertNoCredentialShapedArgs` before dispatch (a credential-shaped `args` key
 * surfaces as `invalid_args`) and `redactSecrets` on the inbound result (T008) — the
 * registry re-implements neither (single source = the toolbelt, design §4.7) and
 * keeps its zero **runtime** toolbelt dependency (the seam is injected, imported
 * `type`-only).
 *
 * Wire-shape assumptions (the `call.start` param names, the `CallResponse`
 * disposition vocabulary, the held-invocation `approval` fields, the `audit_ref`
 * field availability) are **pending the two-daemon round-trip**
 * (`MXL_CONFORMANCE_TWO_DAEMON=1`): authored against the design's named shapes,
 * with the method/param names localised below so the fixture corrects them in one
 * place, and `internal`-safe fallbacks so a new daemon code degrades to `internal`
 * (never the wrong code), never throws.
 */
import type { JsonSchema } from '../descriptor.js';
import { errored, type ToolResult } from '../envelope.js';
import { newIdempotencyKey } from '../idempotency.js';
import { createAjvValidator, type CompiledSchema, type SchemaValidator } from '../validator.js';
import { asRecord, projectTools, type PublishedTool } from './agent-projection.js';
import { mxAwaitResult } from './await-result.js';
import type { DelegateDeps } from './deps.js';
import { EMPTY_AUDIT_REF, faultToResult } from './handler-fault.js';
import { callResponseToResult, failureResult, isTerminal } from './invocation.js';

/**
 * The daemon RPCs + param names this handler consumes. Localised so the two-daemon
 * round-trip (or a pin bump) corrects the wire in one place — the `await-result.ts`
 * / discovery-handler precedent. The `call.start` param names
 * (`room`/`agent`/`tool`/`args`/`idempotency_key`) are likewise pinned at the
 * round-trip; the conformance probe already supplies exactly these.
 */
const CALL_START_METHOD = 'call.start';
const AGENT_TOOLS_METHOD = 'agent.tools';
const AGENT_ID_PARAM = 'agent_id';

/** Input of `mx_delegate_tool` — the descriptor's OUTER schema (`agent` / `tool` /
 *  `args` required; `wait_ms` / `idempotency_key` optional). The inner-tool args
 *  ride in `args` (an open object) and are validated dynamically (Phase 2). */
export interface DelegateToolInput {
  /** The target agent id. */
  readonly agent: string;
  /** The target tool name, optionally `name@version`. */
  readonly tool: string;
  /** Inner-tool arguments — validated against the target's published `input_schema`. */
  readonly args: Record<string, unknown>;
  /** Optional inline wait before returning a deferred handle (the §4.3 / T103 poll hint). */
  readonly wait_ms?: number;
  /** Optional client-supplied idempotency key; generated once per invocation when omitted. */
  readonly idempotency_key?: string;
}

/**
 * A module-level, lazily-constructed default Ajv validator. Ajv is already a
 * registry runtime dep, so the common path needs no `deps.validator` wiring while
 * unit tests can inject a fake. Compiling a target schema is per-call work
 * (M1-acceptable; memoisation by `(agent, tool, schema)` is a later optimisation,
 * spec Risk #7).
 */
let cachedValidator: SchemaValidator | undefined;
function defaultValidator(): SchemaValidator {
  return (cachedValidator ??= createAjvValidator());
}

/**
 * Invoke a named tool on a remote agent and return its normalized
 * {@link ToolResult}. Never throws.
 */
export async function mxDelegateTool(input: DelegateToolInput, deps: DelegateDeps): Promise<ToolResult> {
  // Phase 0 — room provenance. The model never names a Matrix room (design §1/§7);
  // the binding injects it from the `MxSession`. Fail fast rather than dispatch a
  // room-less `call.start` (no Matrix round-trip happened → EMPTY_AUDIT_REF).
  if (deps.room === undefined || deps.room === '') {
    return errored('internal', 'no workspace room configured for delegation', EMPTY_AUDIT_REF);
  }

  // Phase 1 — resolve the target tool's published `input_schema` via the verified
  // `agent.tools` surface. Re-fetch (vs. trusting a schema the model passes) for
  // correctness/freshness — one extra round-trip is cheap (spec OQ #8).
  const { name, version } = parseToolRef(input.tool);
  let toolsResp: unknown;
  try {
    toolsResp = await deps.daemon.call(AGENT_TOOLS_METHOD, { [AGENT_ID_PARAM]: input.agent });
  } catch (err) {
    // unknown_agent → not_found, transport fault → mapped; no round-trip yet.
    return faultToResult(err, EMPTY_AUDIT_REF);
  }
  const published = projectTools(asRecord(toolsResp)?.schemas);
  const target = published.find((t) => t.name === name && (version === undefined || t.version === version));
  if (target === undefined) {
    // A known agent that does not publish this tool (or this `name@version`).
    return failureResult('not_found', EMPTY_AUDIT_REF);
  }

  // Phase 2 — validate `args` against the inner schema BEFORE dispatch (AC 2). A
  // mismatch returns `invalid_args` and `call.start` is never reached.
  const rejection = validateArgs(target, input.args, deps);
  if (rejection !== undefined) return rejection;

  // Phase 3 — dispatch `call.start` with idempotency. The key rides in `params`,
  // so `MxClient.withRetry`'s verbatim param reuse keeps it stable across
  // transport-level retries (T102 §4.4); the handler never regenerates it.
  const idempotency_key = input.idempotency_key ?? newIdempotencyKey();
  const params = {
    room: deps.room, // from MxSession, not model input
    agent: input.agent,
    tool: input.tool, // forwarded verbatim incl. any @version
    args: input.args,
    idempotency_key,
  };
  let response: unknown;
  try {
    response = await deps.daemon.call(CALL_START_METHOD, params);
  } catch (err) {
    // A daemon JSON-RPC error (policy_denied / untrusted_key / …) or transport
    // fault → the mapped envelope (AC 3: policy_denied → denied('policy_denied')).
    return faultToResult(err, EMPTY_AUDIT_REF);
  }

  // Phase 4 — normalize the `CallResponse` into the envelope (AC 1, AC 3): a
  // synchronous `ok` with the inner tool's `result`, a deferred `running`, a held
  // `awaiting_approval`, or a denial/fault terminal. `audit_ref` is populated from
  // the response — for delegation this IS a Matrix round-trip (unlike T104 reads).
  const result = callResponseToResult(response);

  // Phase 5 — optional inline wait. If the result is non-terminal and `wait_ms` is
  // a positive integer, compose `mx_await_result` on the handle so a fast remote
  // tool feels synchronous. It inherits T103's property that a `wait_ms` expiry
  // returns the still-pending envelope (`error: null`), never `errored('timeout')`.
  if (!isTerminal(result.status) && isPositiveWait(input.wait_ms) && result.handle) {
    return mxAwaitResult({ handle: result.handle, wait_ms: input.wait_ms }, deps);
  }

  return result;
}

/**
 * Validate `args` against the target's published `input_schema` (AC 2). Returns an
 * `invalid_args` envelope on a mismatch, else `undefined` (proceed to dispatch).
 *
 * Client-side validation is a **fast-fail convenience, not the security boundary**:
 * the receiving daemon re-validates `args` in-sandbox (design §5). So an absent or
 * malformed (un-compilable) target schema degrades to "skip client validation and
 * let the daemon decide" — never a hard failure that would block a legitimately
 * valid call. The rejection message is the fixed, secret-free phrase; validation
 * *detail* (which would echo arg values) is deliberately NOT placed in the envelope.
 */
function validateArgs(
  target: PublishedTool,
  args: Record<string, unknown>,
  deps: DelegateDeps,
): ToolResult | undefined {
  if (target.input_schema === undefined) return undefined; // nothing to validate client-side

  let validate: CompiledSchema;
  try {
    validate = (deps.validator ?? defaultValidator()).compile(target.input_schema as JsonSchema);
  } catch {
    // The target published a malformed input_schema — cannot validate client-side.
    // Don't block: the receiving daemon re-validates. Skip to dispatch.
    return undefined;
  }
  if (!validate(args)) {
    return failureResult('invalid_args', EMPTY_AUDIT_REF); // rejected BEFORE call.start
  }
  return undefined;
}

/**
 * Parse a `tool` ref into `{ name, version? }`, splitting on the **last** `@` so a
 * bare `run_tests` → `{ name: 'run_tests' }` and `run_tests@1.0.0` →
 * `{ name: 'run_tests', version: '1.0.0' }`. A leading `@` or a trailing `@` (no
 * version after it) is treated as a bare name (no version) rather than an empty
 * segment, so the lookup never matches on `version: ''`.
 */
function parseToolRef(tool: string): { name: string; version?: string } {
  const at = tool.lastIndexOf('@');
  if (at <= 0 || at === tool.length - 1) return { name: tool };
  return { name: tool.slice(0, at), version: tool.slice(at + 1) };
}

/** A finite, positive `wait_ms` (the descriptor already constrains it to int ≥ 0;
 *  this is the defensive floor mirroring `await-result.ts`). */
function isPositiveWait(wait_ms: number | undefined): boolean {
  return typeof wait_ms === 'number' && Number.isFinite(wait_ms) && wait_ms > 0;
}
