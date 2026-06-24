/**
 * ADK `LongRunningFunctionTool` approval shim — BEHAVIORAL coverage (T202 / #24).
 *
 * The static drift guard (`adk-long-running.drift.test.ts`) pins the shim's Python
 * constants against the canonical registry. But constants being right does not
 * prove the disposition *logic* is right: a pending ticket that never resumes, a
 * resolve that re-dispatches the mutation, a leaked approval field, or an
 * approval gate that the model could spin through would all pass the static guard
 * while breaking T202's acceptance criteria. The shim's pure, ADK-free core
 * (`MxLongRunningCore` in `examples/adk/long_running_tools.py`) IS that logic, so
 * it must be exercised, not just diffed.
 *
 * This suite drives `examples/adk/long_running_tools.py` in a SINGLE `python3`
 * subprocess (computed once in `beforeAll`) through scripted FAKE MCP tools — no
 * `google-adk`, no daemon, no socket, no network, no model provider. The shim
 * defers every ADK import into its factories, so the core + wrappers are
 * importable/exercisable here without ADK installed. It asserts the observable
 * T202 contract:
 *   - an approval-gated call yields a pending ticket and resumes on approval
 *     (acceptance #1);
 *   - the agent can do other work (another tool call) while a ticket is pending
 *     (acceptance #2);
 *   - terminal initial results do NOT manufacture a pending ticket;
 *   - resume is idempotent and never re-dispatches the original mutation;
 *   - idempotency keys are preserved/generated/reused per the contract, and
 *     resume (a read) never carries one;
 *   - malformed/handle-less deferred results fail closed to a valid `error`
 *     envelope rather than crashing;
 *   - pending metadata is secret-free (only the four ApprovalInfo fields survive);
 *   - the long-running wrapper SIGNATURES match the canonical input schemas
 *     (the live half of the schema drift guard) and carry no
 *     authority/credential/room/correlation field;
 *   - the model-supplied `wait_ms` cannot force the initial probe to block on a
 *     human approval gate.
 *
 * Toolchain note: the repo runs no Python test runner and CI installs no Python,
 * so this stays inside vitest and is skip-clean when `python3` is unavailable
 * (mirroring `adk-safe-env.behavior.test.ts`). One subprocess, fully
 * deterministic — every fake tool returns scripted envelopes.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  ENVELOPE_SCHEMA,
  IDEMPOTENCY_KEY_PREFIX,
  MX_DELEGATE_TOOL,
  MX_RUN_COMMAND,
  validateEnvelope,
} from '@mx-loom/registry';
import { CREDENTIAL_KEY_RE } from '@mx-loom/toolbelt';
import { beforeAll, describe, expect, it } from 'vitest';

/** Absolute path to examples/adk (module lives at <repo>/examples/adk). */
const adkExampleDir = fileURLToPath(new URL('../../../examples/adk', import.meta.url));

function hasPython3(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const SKIP = !hasPython3();

/**
 * A unique sentinel embedded in every NON-canonical/secret-shaped value the
 * driver seeds, so leak checks are unambiguous (a single `not.toContain` catches
 * any of them regardless of token shape).
 */
const LEAK = 'MXLT202LEAK';

/** The shape the python driver returns (one JSON line). */
interface PyProbe {
  /** A representative pending payload (awaiting_approval) the model would see. */
  pending_payload: Record<string, unknown>;
  /** Was a non-canonical approval field dropped from the pending payload? */
  approval_projected: Record<string, unknown>;
  /** The initial dispatch args the fake delegate tool actually received. */
  initial_dispatch_args: Record<string, unknown>;
  /** Non-secret pending payload mirrored into ToolContext.state for host resume continuity. */
  tool_context_state: Record<string, unknown>;
  /** Resume #1 (still awaiting approval) — kept pending, not a fault. */
  resume_still_pending: Record<string, unknown>;
  /** Resume #2 (operator approved) — terminal ok envelope. */
  resume_terminal_ok: Record<string, unknown>;
  /** Resume #3 (repeat after terminal) — idempotent, identical to resume #2. */
  resume_repeat: Record<string, unknown>;
  /** Count of fake await_result calls observed across the three resumes. */
  await_call_count: number;
  /** Every await_result call's args (assert no idempotency_key on the read path). */
  await_call_args: Array<Record<string, unknown>>;
  /** "Other work while pending": a read tool call succeeds with the ticket open. */
  other_work_envelope: Record<string, unknown>;
  /** Were both tickets still pending at the moment the other-work call ran? */
  pending_ids_during_other_work: string[];
  /** A denied initial dispatch returns terminal denied with no ticket created. */
  terminal_denied: Record<string, unknown>;
  terminal_denied_made_ticket: boolean;
  /** mx_run_command terminal error path returns a valid error envelope, no ticket. */
  run_terminal_error: Record<string, unknown>;
  /** mx_run_command awaiting_approval path also yields a pending ticket. */
  run_pending_payload: Record<string, unknown>;
  /** mx_run_command resume can terminally deny after out-of-band operator denial. */
  run_resume_denied: Record<string, unknown>;
  /** The fake mx_run_command dispatch args for the pending path. */
  run_initial_dispatch_args: Record<string, unknown>;
  /** Every await_result call's args for the run_command pending path. */
  run_await_call_args: Array<Record<string, unknown>>;
  /** A deferred envelope missing a handle fails closed to an internal error. */
  handle_less_error: Record<string, unknown>;
  /** Resolving an unknown ticket id → not_found error envelope. */
  unknown_ticket_error: Record<string, unknown>;
  /** Supplied idempotency key preserved; omitted retry of same call reuses it. */
  idem_supplied_then_retry: string[];
  /** Two independent fresh calls each get a distinct generated idk_ key. */
  idem_generated_distinct: string[];
  /** A plain running envelope also becomes a pending ticket (not only awaiting_approval). */
  running_pending_payload: Record<string, unknown>;
  /** A model-supplied huge wait_ms is capped to the non-blocking probe (0). */
  probe_wait_ms_capped: number;
  /** Invalid-arg rejections (each a valid invalid_args error envelope). */
  invalid_delegate_args: Record<string, unknown>;
  invalid_run_args: Record<string, unknown>;
  invalid_idempotency_type: Record<string, unknown>;
  /** Envelope extraction also accepts JSON text content when structuredContent is absent. */
  text_fallback_envelope: Record<string, unknown>;
  /** Malformed ADK/MCP results fail closed with a fixed, secret-free EnvelopeError message. */
  malformed_extract_error: string;
  /** Wrapper signatures (name → [{name, required}]) for the live schema drift guard. */
  wrapper_signatures: Record<string, Array<{ name: string; required: boolean }>>;
  /** compose_tool_names output for a full nine-tool MCP list. */
  composed_tool_names: string[];
}

/**
 * The python driver: exercises every core path in ONE process and prints one JSON
 * line. Uses scripted fake MCP tools (returning T102 envelopes as both
 * structuredContent and a JSON text block, mimicking an MCP CallToolResult) so
 * the run is hermetic and deterministic. `sys.argv[1]` carries the leak sentinel
 * so TS stays the single control point.
 */
const PY_DRIVER = String.raw`
import asyncio, json, inspect, sys
import long_running_tools as lrt

LEAK = sys.argv[1]

def env(status, **kw):
    e = {"status": status, "result": None, "error": None, "handle": None,
         "approval": None, "audit_ref": dict(lrt._EMPTY_AUDIT_REF)}
    e.update(kw)
    return e

POP_AUDIT = {"invocation_id": "inv_1", "request_id": "req_1", "room": "!r:s", "event_id": "$e"}
APPROVAL = {"request_id": "req_1", "risk": "high", "summary": "run approval tool",
            "expires_at": "2099-01-01T00:00:00Z", "leak_" + LEAK: "DROP_ME_" + LEAK}

class ScriptedTool:
    """Fake MCP tool: returns scripted envelopes as an MCP-CallToolResult-ish dict."""
    def __init__(self, name, responses):
        self.name = name
        self._responses = list(responses)
        self.calls = []
        self._last = None
    async def run_async(self, args=None, tool_context=None):
        self.calls.append(dict(args or {}))
        e = self._responses.pop(0) if self._responses else self._last
        self._last = e
        return {"structuredContent": e, "content": [{"type": "text", "text": json.dumps(e)}],
                "isError": e["status"] == "error"}

class Ctx:
    def __init__(self, fid):
        self.function_call_id = fid
        self.state = {}

out = {}

async def main():
    # ---- (A) awaiting_approval -> pending ticket; resume still-pending -> ok ----
    delegate = ScriptedTool("mx_delegate_tool",
        [env("awaiting_approval", handle="inv_1", approval=APPROVAL, audit_ref=POP_AUDIT)])
    await_tool = ScriptedTool("mx_await_result", [
        env("awaiting_approval", handle="inv_1", approval=APPROVAL, audit_ref=POP_AUDIT),
        env("ok", result={"package": "ok"}, audit_ref=POP_AUDIT),
    ])
    run_noop = ScriptedTool("mx_run_command", [])
    core = lrt.MxLongRunningCore(delegate_tool=delegate, run_tool=run_noop, await_tool=await_tool)

    ctx = Ctx("call_A")
    pending = await core.dispatch_delegate("agent-b", "approval_tool", {}, 999_999, "", ctx)
    out["pending_payload"] = pending
    out["approval_projected"] = pending.get("approval")
    out["initial_dispatch_args"] = delegate.calls[0]
    out["tool_context_state"] = ctx.state
    out["probe_wait_ms_capped"] = delegate.calls[0]["wait_ms"]

    out["resume_still_pending"] = await core.resolve_ticket("call_A", wait_ms=0, tool_context=ctx)
    out["resume_terminal_ok"] = await core.resolve_ticket("call_A", wait_ms=0, tool_context=ctx)
    out["resume_repeat"] = await core.resolve_ticket("call_A", wait_ms=0, tool_context=ctx)
    out["await_call_count"] = len(await_tool.calls)
    out["await_call_args"] = await_tool.calls

    # ---- (B) other work while a ticket is pending (acceptance #2) ----
    delegate_b = ScriptedTool("mx_delegate_tool",
        [env("awaiting_approval", handle="inv_open", approval=APPROVAL, audit_ref=POP_AUDIT)])
    # The "other work" is a read verb modeled as a terminal ok the core returns directly.
    read_tool = ScriptedTool("mx_find_agents", [env("ok", result={"agents": []}, audit_ref=POP_AUDIT)])
    await_b = ScriptedTool("mx_await_result", [])
    core_b = lrt.MxLongRunningCore(delegate_tool=delegate_b, run_tool=read_tool, await_tool=await_b)
    await core_b.dispatch_delegate("agent-b", "approval_tool", {}, 0, "", Ctx("call_open"))
    # While call_open is held, a run_command terminal ok still flows through.
    other = await core_b.dispatch_run_command("agent-b", "echo", ["hi"], None, 0, "", Ctx("call_work"))
    out["other_work_envelope"] = other
    out["pending_ids_during_other_work"] = sorted(t.ticket_id for t in core_b.pending_tickets())

    # ---- (C) terminal initial dispatch -> no ticket ----
    deny_tool = ScriptedTool("mx_run_command",
        [env("denied", error={"code": "policy_denied", "message": "not allowlisted"})])
    core_c = lrt.MxLongRunningCore(delegate_tool=ScriptedTool("mx_delegate_tool", []),
                                   run_tool=deny_tool, await_tool=ScriptedTool("mx_await_result", []))
    out["terminal_denied"] = await core_c.dispatch_run_command("agent-b", "curl", None, None, 0, "", Ctx("call_C"))
    out["terminal_denied_made_ticket"] = core_c.get_ticket("call_C") is not None

    err_tool = ScriptedTool("mx_run_command",
        [env("error", error={"code": "target_offline", "message": "agent offline"})])
    core_ce = lrt.MxLongRunningCore(delegate_tool=ScriptedTool("d", []),
                                    run_tool=err_tool, await_tool=ScriptedTool("a", []))
    out["run_terminal_error"] = await core_ce.dispatch_run_command("agent-b", "echo", None, None, 0, "", Ctx("call_CE"))

    # mx_run_command is the other wrapped long-running verb: prove its pending path
    # and an operator-denied approval resume, not just terminal-on-initial behavior.
    run_pending_tool = ScriptedTool("mx_run_command",
        [env("awaiting_approval", handle="inv_run", approval=APPROVAL, audit_ref=POP_AUDIT)])
    run_await_tool = ScriptedTool("mx_await_result", [
        env("denied", error={"code": "approval_denied", "message": "operator denied"}, audit_ref=POP_AUDIT),
    ])
    core_cr = lrt.MxLongRunningCore(delegate_tool=ScriptedTool("d", []),
                                    run_tool=run_pending_tool, await_tool=run_await_tool)
    out["run_pending_payload"] = await core_cr.dispatch_run_command(
        "agent-b", "make", ["test"], "/repo", 42, "", Ctx("call_RUN"))
    out["run_initial_dispatch_args"] = run_pending_tool.calls[0]
    out["run_resume_denied"] = await core_cr.resolve_ticket("call_RUN", wait_ms=5)
    out["run_await_call_args"] = run_await_tool.calls

    # ---- (D) malformed deferred (missing handle) -> internal error, not a crash ----
    bad_tool = ScriptedTool("mx_delegate_tool", [env("running", handle="")])
    core_d = lrt.MxLongRunningCore(delegate_tool=bad_tool, run_tool=ScriptedTool("r", []),
                                   await_tool=ScriptedTool("a", []))
    out["handle_less_error"] = await core_d.dispatch_delegate("agent-b", "t", {}, 0, "", Ctx("call_D"))
    out["unknown_ticket_error"] = await core_d.resolve_ticket("does-not-exist", wait_ms=0)

    # ---- (E) idempotency: supplied preserved + reused on retry; fresh distinct ----
    idem_tool = ScriptedTool("mx_delegate_tool", [
        env("running", handle="inv_2", audit_ref=POP_AUDIT),
        env("running", handle="inv_2", audit_ref=POP_AUDIT),
    ])
    core_e = lrt.MxLongRunningCore(delegate_tool=idem_tool, run_tool=ScriptedTool("r", []),
                                   await_tool=ScriptedTool("a", []))
    ctx_e = Ctx("call_E")
    await core_e.dispatch_delegate("agent-b", "t", {}, 0, "idk_supplied", ctx_e)
    await core_e.dispatch_delegate("agent-b", "t", {}, 0, "", ctx_e)  # retry, no key
    out["idem_supplied_then_retry"] = [c["idempotency_key"] for c in idem_tool.calls]

    fresh_tool = ScriptedTool("mx_delegate_tool", [
        env("running", handle="inv_3", audit_ref=POP_AUDIT),
        env("running", handle="inv_4", audit_ref=POP_AUDIT),
    ])
    core_f = lrt.MxLongRunningCore(delegate_tool=fresh_tool, run_tool=ScriptedTool("r", []),
                                   await_tool=ScriptedTool("a", []))
    running_pending = await core_f.dispatch_delegate("agent-b", "t", {}, 0, "", Ctx("call_F1"))
    await core_f.dispatch_delegate("agent-b", "t", {}, 0, "", Ctx("call_F2"))
    out["running_pending_payload"] = running_pending
    out["idem_generated_distinct"] = [c["idempotency_key"] for c in fresh_tool.calls]

    # ---- (F) invalid args -> invalid_args error envelopes (no crash) ----
    core_g = lrt.MxLongRunningCore(delegate_tool=ScriptedTool("d", []),
                                   run_tool=ScriptedTool("r", []), await_tool=ScriptedTool("a", []))
    out["invalid_delegate_args"] = await core_g.dispatch_delegate("agent-b", "t", "not-a-dict", 0, "", Ctx("call_G1"))
    out["invalid_run_args"] = await core_g.dispatch_run_command("agent-b", "echo", [1, 2], None, 0, "", Ctx("call_G2"))
    out["invalid_idempotency_type"] = await core_g.dispatch_delegate("agent-b", "t", {}, 0, 123, Ctx("call_G3"))

    # ---- (G) envelope extraction fallback / malformed-result guard ----
    text_env = env("ok", result={"source": "json-text"}, audit_ref=POP_AUDIT)
    out["text_fallback_envelope"] = lrt.extract_envelope(
        {"content": [{"type": "text", "text": json.dumps(text_env)}]})
    try:
        lrt.extract_envelope({"structuredContent": {"status": "ok", "result": {"missing": "fields"}}})
    except lrt.EnvelopeError as exc:
        out["malformed_extract_error"] = str(exc)
    else:
        out["malformed_extract_error"] = "NO_ERROR"

    # ---- (H) wrapper signatures (live schema drift guard) + composition ----
    deleg_fn, run_fn = lrt.build_long_running_callables(core_g)
    def sig(fn):
        return [{"name": n, "required": p.default is inspect._empty}
                for n, p in inspect.signature(fn).parameters.items()]
    out["wrapper_signatures"] = {"mx_delegate_tool": sig(deleg_fn), "mx_run_command": sig(run_fn)}
    out["composed_tool_names"] = lrt.compose_tool_names([
        "mx_find_agents", "mx_describe_agent", "mx_delegate_tool", "mx_run_command",
        "mx_await_result", "mx_share_context", "mx_get_context", "mx_cancel", "mx_workspace_status",
    ])

    print(json.dumps(out))

asyncio.run(main())
`;

describe.skipIf(SKIP)('T202 ADK long-running shim — core behavior (python subprocess)', () => {
  let probe: PyProbe;

  beforeAll(() => {
    const stdout = execFileSync('python3', ['-c', PY_DRIVER, LEAK], {
      cwd: adkExampleDir,
      env: { PATH: process.env.PATH ?? '/usr/bin', PYTHONPATH: adkExampleDir, PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8',
    });
    probe = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!) as PyProbe;
  });

  // -------------------------------------------------------------------------
  // Acceptance #1 — an approval-gated call yields a pending ticket and resumes
  // -------------------------------------------------------------------------

  describe('approval-gated call → pending ticket → resume on approval', () => {
    it('an awaiting_approval initial dispatch produces a pending ticket (not a terminal result)', () => {
      const p = probe.pending_payload;
      expect(p.pending).toBe(true);
      expect(p.status).toBe('awaiting_approval');
      expect(p.handle).toBe('inv_1');
      expect(p.ticket_id).toBe('call_A');
      expect(p.tool).toBe('mx_delegate_tool');
      // The pending ticket carries the daemon handle + secret-free approval + audit.
      expect(p.audit_ref).toEqual({ invocation_id: 'inv_1', request_id: 'req_1', room: '!r:s', event_id: '$e' });
    });

    it('the initial dispatch is a NON-BLOCKING probe even when the model asks to block', () => {
      // The model passed wait_ms=999_999; the core must cap it to 0 so the human
      // approval gate becomes a pending ticket promptly instead of blocking.
      expect(probe.probe_wait_ms_capped).toBe(0);
      expect(probe.initial_dispatch_args.wait_ms).toBe(0);
    });

    it('mirrors the non-secret pending payload into ToolContext.state for host resume continuity', () => {
      expect(probe.tool_context_state).toEqual({ mx_pending_call_A: probe.pending_payload });
    });

    it('resume keeps the ticket pending on a still-awaiting result (T103: not a fault)', () => {
      const r = probe.resume_still_pending;
      expect(r.pending).toBe(true);
      expect(r.status).toBe('awaiting_approval');
      // A poll-budget expiry is NOT an error envelope.
      expect(r.status).not.toBe('error');
    });

    it('resume returns the terminal ok envelope once the operator approves', () => {
      const r = probe.resume_terminal_ok;
      expect(validateEnvelope(r)).toBe(true);
      expect(r.status).toBe('ok');
      expect(r.result).toEqual({ package: 'ok' });
    });

    it('also treats a plain running result as a pending ticket (not only awaiting_approval)', () => {
      const p = probe.running_pending_payload;
      expect(p.pending).toBe(true);
      expect(p.status).toBe('running');
      expect(p.handle).toBe('inv_3');
      expect(p.approval).toBeNull();
    });

    it('mx_run_command also yields a pending ticket and can resume to approval_denied', () => {
      const p = probe.run_pending_payload;
      expect(p.pending).toBe(true);
      expect(p.status).toBe('awaiting_approval');
      expect(p.tool).toBe('mx_run_command');
      expect(p.handle).toBe('inv_run');

      // Canonical run_command args are forwarded, while initial wait_ms is capped.
      expect(probe.run_initial_dispatch_args.command).toBe('make');
      expect(probe.run_initial_dispatch_args.args).toEqual(['test']);
      expect(probe.run_initial_dispatch_args.cwd).toBe('/repo');
      expect(probe.run_initial_dispatch_args.wait_ms).toBe(0);
      expect((probe.run_initial_dispatch_args.idempotency_key as string).startsWith(IDEMPOTENCY_KEY_PREFIX)).toBe(true);

      const denied = probe.run_resume_denied;
      expect(validateEnvelope(denied)).toBe(true);
      expect(denied.status).toBe('denied');
      expect((denied.error as { code: string }).code).toBe('approval_denied');
      expect(probe.run_await_call_args).toEqual([{ handle: 'inv_run', wait_ms: 5 }]);
    });
  });

  // -------------------------------------------------------------------------
  // Acceptance #2 — the agent can do other work while pending
  // -------------------------------------------------------------------------

  describe('the agent can do other work while a ticket is pending', () => {
    it('a second tool call returns a terminal ok while an approval ticket stays open', () => {
      expect(probe.pending_ids_during_other_work).toEqual(['call_open']);
      const w = probe.other_work_envelope;
      expect(validateEnvelope(w)).toBe(true);
      expect(w.status).toBe('ok');
      // The pending approval did not serialize the session: other work completed.
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency — preserve / generate-once / reuse-on-retry; resume is a read
  // -------------------------------------------------------------------------

  describe('idempotency contract', () => {
    it('generates an idk_-prefixed key for the initial dispatch when the model omits one', () => {
      const key = probe.initial_dispatch_args.idempotency_key as string;
      expect(typeof key).toBe('string');
      expect(key.startsWith(IDEMPOTENCY_KEY_PREFIX)).toBe(true);
    });

    it('preserves a supplied key and reuses it on a no-key retry of the SAME ADK call', () => {
      expect(probe.idem_supplied_then_retry).toEqual(['idk_supplied', 'idk_supplied']);
    });

    it('generates a DISTINCT key for two independent ADK function calls', () => {
      const [k1, k2] = probe.idem_generated_distinct;
      expect(k1).not.toBe(k2);
      expect(k1!.startsWith(IDEMPOTENCY_KEY_PREFIX)).toBe(true);
      expect(k2!.startsWith(IDEMPOTENCY_KEY_PREFIX)).toBe(true);
    });

    it('resume (mx_await_result) is a read: it never carries an idempotency_key', () => {
      for (const args of probe.await_call_args) {
        expect(Object.prototype.hasOwnProperty.call(args, 'idempotency_key')).toBe(false);
        // The resolver passes only the handle + a bounded wait.
        expect(args.handle).toBe('inv_1');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Resume idempotency — a completed ticket does not re-dispatch / re-read
  // -------------------------------------------------------------------------

  describe('resume idempotency (no double-execute)', () => {
    it('a repeated resolve after terminal returns the identical cached envelope', () => {
      expect(probe.resume_repeat).toEqual(probe.resume_terminal_ok);
    });

    it('the repeated resolve does NOT hit the daemon again (only two real await reads)', () => {
      // Resume #1 (pending) + resume #2 (ok) = 2 daemon reads; resume #3 is cached.
      expect(probe.await_call_count).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Terminal-on-initial / fail-closed negative paths
  // -------------------------------------------------------------------------

  describe('terminal initial results and fail-closed errors', () => {
    it('a denied initial dispatch returns the terminal denied envelope and creates NO ticket', () => {
      expect(validateEnvelope(probe.terminal_denied)).toBe(true);
      expect(probe.terminal_denied.status).toBe('denied');
      expect(probe.terminal_denied_made_ticket).toBe(false);
    });

    it('a terminal error initial dispatch returns a valid error envelope', () => {
      expect(validateEnvelope(probe.run_terminal_error)).toBe(true);
      expect(probe.run_terminal_error.status).toBe('error');
    });

    it('a deferred result missing a handle fails closed to a valid internal error envelope', () => {
      expect(validateEnvelope(probe.handle_less_error)).toBe(true);
      expect(probe.handle_less_error.status).toBe('error');
      expect((probe.handle_less_error.error as { code: string }).code).toBe('internal');
    });

    it('resolving an unknown ticket id returns a not_found error envelope', () => {
      expect(validateEnvelope(probe.unknown_ticket_error)).toBe(true);
      expect(probe.unknown_ticket_error.status).toBe('error');
      expect((probe.unknown_ticket_error.error as { code: string }).code).toBe('not_found');
    });

    it('invalid args fail closed to valid invalid_args error envelopes (no crash)', () => {
      for (const env of [probe.invalid_delegate_args, probe.invalid_run_args, probe.invalid_idempotency_type]) {
        expect(validateEnvelope(env)).toBe(true);
        expect(env.status).toBe('error');
        expect((env.error as { code: string }).code).toBe('invalid_args');
      }
    });

    it('extracts envelopes from JSON text content when structuredContent is absent', () => {
      expect(validateEnvelope(probe.text_fallback_envelope)).toBe(true);
      expect(probe.text_fallback_envelope.status).toBe('ok');
      expect(probe.text_fallback_envelope.result).toEqual({ source: 'json-text' });
    });

    it('rejects malformed ADK/MCP results with a fixed secret-free EnvelopeError message', () => {
      expect(probe.malformed_extract_error).toBe(
        'mx-loom: could not extract a valid T102 result envelope from the ADK tool result',
      );
      expect(probe.malformed_extract_error).not.toContain(LEAK);
    });
  });

  // -------------------------------------------------------------------------
  // Secret boundary — pending metadata is secret-free; only ApprovalInfo fields
  // -------------------------------------------------------------------------

  describe('secret-free pending metadata', () => {
    it('projects approval through exactly the four ApprovalInfo fields, dropping extras', () => {
      const approvalRequired =
        (
          ENVELOPE_SCHEMA as unknown as {
            properties: { approval: { oneOf: ReadonlyArray<{ type?: string; required?: string[] }> } };
          }
        ).properties.approval.oneOf.find((s) => s.type === 'object')?.required ?? [];
      expect(Object.keys(probe.approval_projected).sort()).toEqual([...approvalRequired].sort());
    });

    it('no non-canonical / sentinel value survives anywhere in the pending payload', () => {
      const raw = JSON.stringify(probe.pending_payload);
      expect(raw).not.toContain(LEAK);
      expect(raw).not.toContain('DROP_ME');
    });

    it('no pending-payload key is credential-shaped per the canonical oracle', () => {
      for (const key of Object.keys(probe.pending_payload)) {
        expect(CREDENTIAL_KEY_RE.test(key), `pending key is credential-shaped: ${key}`).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Live schema drift guard — wrapper signatures match the canonical input schema
  // -------------------------------------------------------------------------

  describe('wrapper signatures mirror the canonical input schemas', () => {
    // ADK derives a tool's model-facing declaration from the Python function
    // signature, so the wrapper params ARE the schema. These must equal the
    // canonical descriptor fields (plus the ADK-injected, model-hidden
    // `tool_context`), never adding room/correlation/credential/authority fields.
    const HIDDEN = new Set(['tool_context']);

    function modelFacingParams(name: 'mx_delegate_tool' | 'mx_run_command') {
      return probe.wrapper_signatures[name]!.filter((p) => !HIDDEN.has(p.name));
    }

    it('mx_delegate_tool wrapper params == delegate input schema (names + requiredness)', () => {
      const schema = MX_DELEGATE_TOOL.input_schema as {
        properties: Record<string, unknown>;
        required: string[];
      };
      const params = modelFacingParams('mx_delegate_tool');
      expect(params.map((p) => p.name)).toEqual(Object.keys(schema.properties));
      const requiredParams = params.filter((p) => p.required).map((p) => p.name);
      expect(requiredParams.sort()).toEqual([...schema.required].sort());
    });

    it('mx_run_command wrapper params == run_command input schema (names + requiredness)', () => {
      const schema = MX_RUN_COMMAND.input_schema as {
        properties: Record<string, unknown>;
        required: string[];
      };
      const params = modelFacingParams('mx_run_command');
      expect(params.map((p) => p.name)).toEqual(Object.keys(schema.properties));
      const requiredParams = params.filter((p) => p.required).map((p) => p.name);
      expect(requiredParams.sort()).toEqual([...schema.required].sort());
    });

    it('no wrapper param is credential-shaped or a room/correlation/authority field', () => {
      const forbidden = new Set(['room', 'correlation_id', 'correlationid', 'approval', 'trust', 'policy']);
      for (const name of ['mx_delegate_tool', 'mx_run_command'] as const) {
        for (const param of probe.wrapper_signatures[name]!) {
          expect(CREDENTIAL_KEY_RE.test(param.name), `${name} param credential-shaped: ${param.name}`).toBe(false);
          expect(forbidden.has(param.name.toLowerCase()), `${name} exposes a forbidden field: ${param.name}`).toBe(
            false,
          );
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Composition — exactly one of each canonical name, no authority verbs
  // -------------------------------------------------------------------------

  describe('tool-name composition (no duplicates, no authority verbs)', () => {
    it('exposes exactly one mx_delegate_tool and one mx_run_command', () => {
      const names = probe.composed_tool_names;
      expect(names.filter((n) => n === 'mx_delegate_tool')).toHaveLength(1);
      expect(names.filter((n) => n === 'mx_run_command')).toHaveLength(1);
    });

    it('keeps the other canonical verbs and exposes no authority verb', () => {
      const names = probe.composed_tool_names;
      expect(names).toContain('mx_find_agents');
      expect(names).toContain('mx_await_result');
      for (const forbidden of ['approval.decide', 'trust.set', 'policy.reload', 'daemon.shutdown']) {
        expect(names).not.toContain(forbidden);
      }
    });
  });
});
