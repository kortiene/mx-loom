/**
 * T202 / #24 ADK LongRunningFunctionTool end-to-end acceptance.
 *
 * Target behavior: Google ADK consumes the T202 native long-running shim from
 * `examples/adk/long_running_tools.py`: `mx_delegate_tool` and `mx_run_command`
 * are exposed as ADK `LongRunningFunctionTool`s (canonical names preserved), an
 * approval-gated call returns a secret-free pending ticket, the same ADK session
 * can do other work while that ticket is pending, and the host resumes the ticket
 * through the canonical `mx_await_result(handle)` path after an out-of-band
 * operator approval/denial. It also exercises out-of-process policy enforcement:
 * a deny-by-default `policy_denied` terminal surfaces directly on first dispatch
 * and must NOT manufacture a pending ticket (the shim's terminal-disposition
 * branch — a misclassification there would hang forever awaiting a resume).
 *
 * Boundaries crossed by the live arm:
 *   ADK LongRunningFunctionTool → private ADK MCPToolset → mx-loom-mcp --stdio
 *     → MxSession/MxClient → daemon A Unix socket → daemon B receiver policy
 *     → human approval gate → decide-approval.sh operator → mx_await_result.
 *
 * The test is deterministic and model/provider-free: it builds an ADK `LlmAgent`
 * only to prove the tool bundle is acceptable to ADK, then directly invokes the ADK
 * tool objects with a minimal ToolContext stand-in. Approval is still real and
 * out-of-band: Python shells out to `scripts/conformance/decide-approval.sh`, which
 * uses the mx-agent CLI as daemon B's operator and never any model-facing surface.
 *
 * Gating:
 *   - clean skip unless `MXL_ADK_LONG_RUNNING_E2E=1` is set;
 *   - fail-not-skip when requested but python/google-adk, the golden two-daemon
 *     fixture, daemon A's socket, or a runnable mx-loom-mcp command is missing;
 *   - requires `MXL_CONFORMANCE_TWO_DAEMON=1` and
 *     `MXL_CONFORMANCE_GOLDEN_POLICY=1` because the approval-gated tool/command
 *     coordinates come from the canonical golden receiver policy.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  CANONICAL_M1_TOOLS,
  isForbiddenAuthorityVerb,
  validateEnvelope,
  type ToolResult,
} from '@mx-loom/registry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  GOLDEN_RESOLVE_BUDGET_MS,
  SECRET_PATTERN,
  isDaemonReachable,
  isGoldenPolicyActive,
  isTwoDaemonRequired,
  readGoldenFixture,
  resolveDaemonSocket,
  type GoldenFixture,
} from './_golden-harness.js';

const execFileAsync = promisify(execFile);

const ADK_LONG_E2E_ENV = 'MXL_ADK_LONG_RUNNING_E2E';
const ADK_PYTHON_ENV = 'MXL_ADK_PYTHON';
const ADK_MCP_COMMAND_ENV = 'MXL_ADK_MCP_COMMAND';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const adkExampleDir = join(repoRoot, 'examples', 'adk');
const decideApprovalScript = join(repoRoot, 'scripts', 'conformance', 'decide-approval.sh');
const defaultCliEntry = join(repoRoot, 'packages', 'mcp', 'src', 'cli.ts');
const tsxBinCandidates = [
  join(repoRoot, 'packages', 'golden', 'node_modules', '.bin', 'tsx'),
  join(repoRoot, 'packages', 'mcp', 'node_modules', '.bin', 'tsx'),
  join(repoRoot, 'node_modules', '.bin', 'tsx'),
];

interface SpawnPlan {
  readonly command: string;
  readonly cleanupDir: string | null;
}

interface AdkLongProbe {
  readonly agent_name: string;
  readonly tool_names: readonly string[];
  readonly tool_entry_types: readonly string[];
  readonly long_tool_types: Record<string, string>;
  readonly child_env_keys: readonly string[];
  readonly session_state: Record<string, string>;
  readonly delegate_pending: Record<string, unknown>;
  readonly delegate_state_keys: readonly string[];
  readonly pending_ids_during_other_work: readonly string[];
  readonly other_work: Record<string, unknown>;
  readonly delegate_terminal: Record<string, unknown>;
  readonly delegate_repeat: Record<string, unknown>;
  readonly delegate_resume_content: Record<string, unknown>;
  readonly run_command_pending: Record<string, unknown>;
  readonly run_command_terminal: Record<string, unknown>;
  readonly deny_pending: Record<string, unknown>;
  readonly deny_terminal: Record<string, unknown>;
  readonly policy_denied_terminal: Record<string, unknown>;
  readonly policy_denied_made_ticket: boolean;
  readonly remaining_pending_ids: readonly string[];
}

function isRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ADK_LONG_E2E_ENV] === '1';
}

function resolvedPython(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[ADK_PYTHON_ENV];
  return configured && configured.trim() !== '' ? configured : 'python3';
}

function runtimeDirFromSocket(socketPath: string): string | null {
  const normalized = resolve(socketPath);
  const expectedTail = join('mx-agent', 'daemon.sock');
  if (!normalized.endsWith(expectedTail)) return null;
  const mxAgentDir = dirname(normalized);
  if (dirname(mxAgentDir) === mxAgentDir) return null;
  return dirname(mxAgentDir);
}

function resolveTsxBin(): string | null {
  return tsxBinCandidates.find((candidate) => existsSync(candidate)) ?? null;
}

function prepareSpawnCommand(env: NodeJS.ProcessEnv = process.env): SpawnPlan {
  const configured = env[ADK_MCP_COMMAND_ENV];
  if (configured && configured.trim() !== '') {
    if (!existsSync(configured)) {
      throw new Error(
        `T202 ADK LongRunningFunctionTool e2e could not find ${ADK_MCP_COMMAND_ENV} at ${configured}. ` +
          'Point it at a resolvable, executable mx-loom-mcp bin.',
      );
    }
    return { command: configured, cleanupDir: null };
  }

  const tsxBin = resolveTsxBin();
  if (tsxBin === null) {
    throw new Error(
      'T202 ADK LongRunningFunctionTool e2e could not find a `tsx` binary in the workspace ' +
        `(looked in ${tsxBinCandidates.join(', ')}). Run \`pnpm install\`, or set ` +
        `${ADK_MCP_COMMAND_ENV} to a runnable mx-loom-mcp bin.`,
    );
  }
  if (!existsSync(defaultCliEntry)) {
    throw new Error(`T202 ADK e2e could not find the mx-loom-mcp source entry at ${defaultCliEntry}.`);
  }

  const cleanupDir = mkdtempSync(join(tmpdir(), 'mxl-adk-long-launcher-'));
  const launcher = join(cleanupDir, 'mx-loom-mcp');
  writeFileSync(
    launcher,
    `#!/usr/bin/env bash\nexec ${JSON.stringify(tsxBin)} ${JSON.stringify(defaultCliEntry)} "$@"\n`,
  );
  chmodSync(launcher, 0o755);
  return { command: launcher, cleanupDir };
}

async function commandWorks(command: string, args: readonly string[] = ['--version']): Promise<boolean> {
  try {
    await execFileAsync(command, [...args], { timeout: 10_000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

async function googleAdkLongRunningImportsWork(python: string): Promise<boolean> {
  try {
    await execFileAsync(
      python,
      [
        '-c',
        'from google.adk.agents import LlmAgent; '
          + 'from google.adk.tools import LongRunningFunctionTool; '
          + 'from google.adk.tools.mcp_tool import MCPToolset, StdioServerParameters; '
          + 'from google.genai import types',
      ],
      { timeout: 10_000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
    );
    return true;
  } catch {
    return false;
  }
}

async function assertAdkLongPrereqs(): Promise<{
  fixture: GoldenFixture;
  python: string;
  spawn: SpawnPlan;
  runtimeDir: string;
}> {
  if (!isTwoDaemonRequired()) {
    throw new Error(
      'T202 ADK LongRunningFunctionTool e2e was requested with MXL_ADK_LONG_RUNNING_E2E=1, ' +
        'but MXL_CONFORMANCE_TWO_DAEMON=1 is not set. Bring up daemon A+B or unset the flag.',
    );
  }
  if (!isGoldenPolicyActive()) {
    throw new Error(
      'T202 ADK LongRunningFunctionTool e2e needs the golden approval policy. Set ' +
        'MXL_CONFORMANCE_GOLDEN_POLICY=1 after bringing up daemon B with POLICY_FIXTURE=policy.golden.toml.',
    );
  }
  if (!isDaemonReachable()) {
    throw new Error(
      `T202 ADK e2e was requested, but no mx-agent daemon is reachable at ${resolveDaemonSocket()}. ` +
        'The requested live arm must fail, not skip, when its fixture is declared but daemon A is unreachable.',
    );
  }
  const fixture = readGoldenFixture();
  if (fixture === null) {
    throw new Error(
      'T202 ADK e2e fixture coordinates are incomplete. Expected the golden fixture env vars: ' +
        'MXL_CONFORMANCE_ROOM, MXL_CONFORMANCE_TARGET_AGENT, MXL_CONFORMANCE_TOOL, ' +
        'MXL_CONFORMANCE_APPROVAL_TOOL, MXL_CONFORMANCE_DENIED_TOOL, ' +
        'MXL_CONFORMANCE_ALLOWED_COMMAND, and optionally MXL_CONFORMANCE_ALLOW_CWD.',
    );
  }

  const runtimeDir = runtimeDirFromSocket(resolveDaemonSocket());
  if (runtimeDir === null) {
    throw new Error(
      'T202 ADK e2e needs daemon A at $XDG_RUNTIME_DIR/mx-agent/daemon.sock so the ' +
        `ADK-spawned mx-loom-mcp child can resolve it safely. Got: ${resolveDaemonSocket()}`,
    );
  }

  const python = resolvedPython();
  if (!(await commandWorks(python))) {
    throw new Error(
      `T202 ADK e2e could not run ${python}. Install Python 3 or set ${ADK_PYTHON_ENV} ` +
        'to the interpreter in the virtualenv where google-adk is installed.',
    );
  }
  if (!(await googleAdkLongRunningImportsWork(python))) {
    throw new Error(
      'T202 ADK e2e requires google-adk exposing LlmAgent, LongRunningFunctionTool, MCPToolset, ' +
        'StdioServerParameters, and google.genai.types. Run `python -m pip install -r examples/adk/requirements.txt` ' +
        `inside ${python}'s environment, or update examples/adk/long_running_tools.py for the pinned ADK API.`,
    );
  }
  if (!existsSync(decideApprovalScript)) {
    throw new Error(`T202 ADK e2e could not find the out-of-band operator script at ${decideApprovalScript}.`);
  }

  return { fixture, python, spawn: prepareSpawnCommand(), runtimeDir };
}

/** Synthetic, clearly-fake credentials that must never reach the MCP child or model-visible output. */
const FAKE_SECRET_ENV: Readonly<Record<string, string>> = {
  GH_TOKEN: 'ghp_fake_MXLADKLONGLEAK_not_real_1234567890',
  MATRIX_ACCESS_TOKEN: 'syt_a_fake_MXLADKLONGLEAK_not_real',
  MX_AGENT_SECRET: 'fake_MXLADKLONGLEAK_mx_agent_secret_not_real',
  GOOGLE_API_KEY: 'fake_MXLADKLONGLEAK_google_api_key_not_real',
  ANTHROPIC_API_KEY: 'sk-ant-fake_MXLADKLONGLEAK_not_real',
  OPENAI_API_KEY: 'sk-fake_MXLADKLONGLEAK_openai_not_real',
  DATABASE_URL: 'postgres://user:fake_MXLADKLONGLEAK_pw@db.invalid/mxloom',
};

const OPERATOR_ENV_PASSTHROUGH = [
  'CONF_STATE_DIR',
  'RUNNER_TEMP',
  'B_RUNTIME',
  'B_DATA',
  'MXL_APPROVAL_DECIDE_TIMEOUT',
] as const;

function pythonEnv(runtimeDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '/usr/bin',
    HOME: process.env['HOME'] ?? repoRoot,
    XDG_RUNTIME_DIR: runtimeDir,
    LANG: 'C',
    LC_ALL: 'C',
    TERM: 'xterm',
    PYTHONPATH: adkExampleDir,
    PYTHONDONTWRITEBYTECODE: '1',
    MXL_APPROVAL_DECIDE_TIMEOUT: '90',
    ...FAKE_SECRET_ENV,
  };
  for (const key of OPERATOR_ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined && value !== '') env[key] = value;
  }
  return env;
}

function parseProbe(stdout: string): AdkLongProbe {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const last = lines.at(-1);
  if (last === undefined) throw new Error('ADK long-running e2e Python driver produced no JSON output');
  return JSON.parse(last) as AdkLongProbe;
}

function asEnvelope(value: Record<string, unknown>, label: string): ToolResult {
  expect(validateEnvelope(value), `${label}: expected a valid T102 envelope`).toBe(true);
  return value as unknown as ToolResult;
}

function expectPendingTicket(value: Record<string, unknown>, opts: { tool: string; ticketId: string }): void {
  expect(value['pending']).toBe(true);
  expect(value['tool']).toBe(opts.tool);
  expect(value['ticket_id']).toBe(opts.ticketId);
  expect(value['status']).toBe('awaiting_approval');
  expect(typeof value['handle']).toBe('string');
  expect(value['handle']).not.toBe('');
  expect(value['approval']).toEqual(expect.objectContaining({ request_id: expect.any(String) }));
  const approval = value['approval'] as Record<string, unknown>;
  expect(['low', 'medium', 'high']).toContain(approval['risk']);
  expect(value['audit_ref']).toEqual(expect.objectContaining({ invocation_id: expect.any(String) }));
}

const PY_DRIVER = String.raw`
import asyncio
import inspect
import json
import os
import subprocess
import sys
from dataclasses import asdict, is_dataclass
from typing import Any

import long_running_tools as lrt

CONFIG = json.loads(sys.argv[1])

class FakeToolContext:
    """Minimal non-authority ToolContext stand-in for direct ADK BaseTool.run_async()."""
    def __init__(self, function_call_id: str) -> None:
        self.function_call_id = function_call_id
        self.state = {}
        self.actions = type("Actions", (), {})()
        self.invocation_context = None

async def maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value

def to_plain(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): to_plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_plain(v) for v in value]
    if is_dataclass(value):
        return to_plain(asdict(value))
    if hasattr(value, "model_dump"):
        try:
            return to_plain(value.model_dump(mode="json"))
        except Exception:
            pass
    if hasattr(value, "dict"):
        try:
            return to_plain(value.dict())
        except Exception:
            pass
    if hasattr(value, "__dict__"):
        return {str(k): to_plain(v) for k, v in vars(value).items() if not str(k).startswith("_")}
    return str(value)

def tool_name(tool: Any) -> str:
    for attr in ("name", "tool_name"):
        if hasattr(tool, attr):
            value = getattr(tool, attr)
            if isinstance(value, str):
                return value
    plain = to_plain(tool)
    if isinstance(plain, dict):
        for key in ("name", "tool_name"):
            value = plain.get(key)
            if isinstance(value, str):
                return value
    raise RuntimeError(f"could not determine ADK tool name for {type(tool).__name__}")

async def call_tool(tool: Any, args: dict[str, Any], ctx: FakeToolContext) -> Any:
    attempts: list[tuple[str, Any]] = []
    if hasattr(tool, "run_async"):
        attempts.extend([
            ("run_async(args=..., tool_context=fake)", lambda: tool.run_async(args=args, tool_context=ctx)),
            ("run_async(args=..., tool_context=None)", lambda: tool.run_async(args=args, tool_context=None)),
            ("run_async(positional)", lambda: tool.run_async(args, ctx)),
        ])
    if hasattr(tool, "call_async"):
        attempts.append(("call_async(args)", lambda: tool.call_async(args)))
    if hasattr(tool, "execute_async"):
        attempts.append(("execute_async(args)", lambda: tool.execute_async(args)))
    if hasattr(tool, "execute"):
        attempts.append(("execute(args)", lambda: tool.execute(args)))

    errors: list[str] = []
    for label, thunk in attempts:
        try:
            return await maybe_await(thunk())
        except TypeError as exc:
            errors.append(f"{label}: {exc}")
    raise RuntimeError("ADK tool did not expose a compatible call API: " + " | ".join(errors))

def collect_candidates(value: Any) -> list[Any]:
    plain = to_plain(value)
    candidates: list[Any] = [plain]
    if isinstance(plain, dict):
        for key in ("result", "response", "structuredContent", "structured_content", "structured_content_json"):
            if key in plain:
                candidates.append(plain[key])
        content = plain.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and isinstance(block.get("text"), str):
                    candidates.append(block["text"])
    if isinstance(plain, list):
        for block in plain:
            if isinstance(block, dict) and isinstance(block.get("text"), str):
                candidates.append(block["text"])
    out: list[Any] = []
    for candidate in candidates:
        if isinstance(candidate, str):
            try:
                candidate = json.loads(candidate)
            except json.JSONDecodeError:
                pass
        out.append(candidate)
    return out

def pending_from_result(value: Any) -> dict[str, Any]:
    for candidate in collect_candidates(value):
        if isinstance(candidate, dict) and candidate.get("pending") is True and isinstance(candidate.get("handle"), str):
            return candidate
    raise RuntimeError(f"could not extract mx-loom pending ticket from ADK result: {to_plain(value)!r}")

def envelope_from_result(value: Any) -> dict[str, Any]:
    try:
        return lrt.extract_envelope(value)
    except Exception:
        for candidate in collect_candidates(value):
            if isinstance(candidate, dict) and candidate.get("status") in {"ok", "running", "awaiting_approval", "denied", "error"}:
                return lrt.extract_envelope(candidate)
    raise

def decide(action: str, match: str) -> None:
    subprocess.run(
        [CONFIG["decide_script"], action, "--match", match],
        check=True,
        timeout=CONFIG.get("operator_timeout_ms", 90_000) / 1000,
        env=os.environ.copy(),
    )

def tool_map(bundle: Any) -> dict[str, Any]:
    by_name: dict[str, Any] = {}
    for tool in bundle.tools:
        name = tool_name(tool)
        if name in by_name:
            raise RuntimeError(f"duplicate ADK tool name exposed: {name}")
        by_name[name] = tool
    return by_name

async def main() -> None:
    from google.adk.agents import LlmAgent

    correlation_id = CONFIG["correlation_id"]
    bundle = await lrt.mx_long_running_tool_bundle(
        room=CONFIG["room"],
        correlation_id=correlation_id,
        command=CONFIG["command"],
        max_invocations=16,
    )
    agent = LlmAgent(
        name="mx_adk_long_running_e2e_agent",
        model="mx-adk-long-running-e2e-no-provider-call",
        instruction="Use mx_* tools. Long-running tickets are resumed by the host; never approve your own work.",
        tools=bundle.tools,
    )

    try:
        by_name = tool_map(bundle)
        required = {"mx_find_agents", "mx_delegate_tool", "mx_run_command"}
        missing = sorted(required - set(by_name))
        if missing:
            raise RuntimeError(f"long-running bundle missing required tools: {missing}; got {sorted(by_name)}")

        # 1) Approval-gated named-tool delegation: pending ticket, not terminal.
        ctx_delegate = FakeToolContext("adk-e2e-delegate")
        raw_delegate_pending = await call_tool(by_name["mx_delegate_tool"], {
            "agent": CONFIG["target_agent_id"],
            "tool": CONFIG["approval_tool"],
            "args": {},
            "wait_ms": 999999,  # the shim must cap this to a non-blocking probe
            "idempotency_key": CONFIG["delegate_idempotency_key"],
        }, ctx_delegate)
        delegate_pending = pending_from_result(raw_delegate_pending)

        # 2) Do other work through the same ADK bundle while the approval ticket is still held.
        ctx_other = FakeToolContext("adk-e2e-other-work")
        other_work = envelope_from_result(await call_tool(
            by_name["mx_find_agents"], {"tool": CONFIG["approval_tool"]}, ctx_other
        ))
        pending_ids_during_other_work = sorted(t.ticket_id for t in bundle.pending_tickets())

        # 3) Out-of-band operator approves, then the host resumes the original ticket.
        decide("approve", CONFIG["approval_tool"])
        delegate_terminal = await bundle.resolve_ticket(
            "adk-e2e-delegate", wait_ms=CONFIG["resolve_wait_ms"], tool_context=ctx_delegate
        )
        delegate_repeat = await bundle.resolve_ticket("adk-e2e-delegate", wait_ms=0, tool_context=ctx_delegate)
        delegate_resume_content = to_plain(bundle.build_resume_content("adk-e2e-delegate"))

        # 4) The other wrapped verb: guarded command also becomes pending and resumes on approval.
        ctx_run = FakeToolContext("adk-e2e-run-command")
        run_args = {
            "agent": CONFIG["target_agent_id"],
            "command": CONFIG["allowed_command"],
            "args": ["mx-loom-adk-long-running-e2e"],
            "wait_ms": 999999,
            "idempotency_key": CONFIG["run_idempotency_key"],
        }
        if CONFIG.get("allow_cwd"):
            run_args["cwd"] = CONFIG["allow_cwd"]
        run_command_pending = pending_from_result(await call_tool(by_name["mx_run_command"], run_args, ctx_run))
        decide("approve", CONFIG["allowed_command"])
        run_command_terminal = await bundle.resolve_ticket(
            "adk-e2e-run-command", wait_ms=CONFIG["resolve_wait_ms"], tool_context=ctx_run
        )

        # 5) Denial path: the daemon/operator can deny, and the ADK shim only observes.
        ctx_deny = FakeToolContext("adk-e2e-delegate-deny")
        deny_pending = pending_from_result(await call_tool(by_name["mx_delegate_tool"], {
            "agent": CONFIG["target_agent_id"],
            "tool": CONFIG["approval_tool"],
            "args": {},
            "wait_ms": 0,
            "idempotency_key": CONFIG["deny_idempotency_key"],
        }, ctx_deny))
        decide("deny", CONFIG["approval_tool"])
        deny_terminal = await bundle.resolve_ticket(
            "adk-e2e-delegate-deny", wait_ms=CONFIG["resolve_wait_ms"], tool_context=ctx_deny
        )

        # 6) Deny-by-default POLICY denial through the long-running wrapper itself: a
        # terminal envelope on the FIRST dispatch must surface directly as the ADK
        # result and must NOT manufacture a pending ticket (the shim's
        # terminal-initial-dispatch disposition branch). This exercises out-of-process
        # policy enforcement (distinct from the operator-deny approval_denied leg) and
        # guards the highest-risk shim bug: mistaking a terminal denied envelope for a
        # pending one would hang forever awaiting a resume that never comes.
        ctx_policy = FakeToolContext("adk-e2e-policy-denied")
        policy_denied_terminal = envelope_from_result(await call_tool(by_name["mx_delegate_tool"], {
            "agent": CONFIG["target_agent_id"],
            "tool": CONFIG["denied_tool"],
            "args": {},
            "wait_ms": 0,
            "idempotency_key": CONFIG["policy_denied_idempotency_key"],
        }, ctx_policy))
        policy_denied_made_ticket = bundle.get_ticket("adk-e2e-policy-denied") is not None

        print(json.dumps({
            "agent_name": getattr(agent, "name", ""),
            "tool_names": sorted(by_name.keys()),
            "tool_entry_types": [type(t).__name__ for t in bundle.tools],
            "long_tool_types": {
                "mx_delegate_tool": type(by_name["mx_delegate_tool"]).__name__,
                "mx_run_command": type(by_name["mx_run_command"]).__name__,
            },
            "child_env_keys": sorted(lrt.safe_mx_mcp_env().keys()),
            "session_state": lrt.mx_session_state(CONFIG["room"], correlation_id),
            "delegate_pending": delegate_pending,
            "delegate_state_keys": sorted(ctx_delegate.state.keys()),
            "pending_ids_during_other_work": pending_ids_during_other_work,
            "other_work": other_work,
            "delegate_terminal": delegate_terminal,
            "delegate_repeat": delegate_repeat,
            "delegate_resume_content": delegate_resume_content,
            "run_command_pending": run_command_pending,
            "run_command_terminal": run_command_terminal,
            "deny_pending": deny_pending,
            "deny_terminal": deny_terminal,
            "policy_denied_terminal": policy_denied_terminal,
            "policy_denied_made_ticket": policy_denied_made_ticket,
            "remaining_pending_ids": sorted(t.ticket_id for t in bundle.pending_tickets()),
        }, sort_keys=True))
    finally:
        await bundle.close()

asyncio.run(main())
`;

const skipAdkLong = !isRequested();

describe.skipIf(skipAdkLong)('T202 e2e · Google ADK LongRunningFunctionTool approval shim', () => {
  let probe: AdkLongProbe;
  let fixture: GoldenFixture;
  let correlationId = '';
  let launcherCleanupDir: string | null = null;

  beforeAll(async () => {
    const prereqs = await assertAdkLongPrereqs();
    fixture = prereqs.fixture;
    launcherCleanupDir = prereqs.spawn.cleanupDir;
    correlationId = `adk-long-e2e-${randomUUID()}`;

    const stdout = await execFileAsync(
      prereqs.python,
      [
        '-c',
        PY_DRIVER,
        JSON.stringify({
          room: fixture.room,
          target_agent_id: fixture.targetAgentId,
          approval_tool: fixture.approvalTool,
          denied_tool: fixture.deniedTool,
          allowed_command: fixture.allowedCommand,
          allow_cwd: fixture.allowCwd ?? '',
          command: prereqs.spawn.command,
          correlation_id: correlationId,
          decide_script: decideApprovalScript,
          resolve_wait_ms: GOLDEN_RESOLVE_BUDGET_MS,
          delegate_idempotency_key: `mxl-adk-long-${randomUUID()}-delegate`,
          run_idempotency_key: `mxl-adk-long-${randomUUID()}-run`,
          deny_idempotency_key: `mxl-adk-long-${randomUUID()}-deny`,
          policy_denied_idempotency_key: `mxl-adk-long-${randomUUID()}-policy-denied`,
        }),
      ],
      {
        cwd: adkExampleDir,
        env: pythonEnv(prereqs.runtimeDir),
        timeout: 300_000,
        maxBuffer: 6 * 1024 * 1024,
        encoding: 'utf8',
      },
    );
    probe = parseProbe(stdout.stdout);
  }, 300_000);

  afterAll(() => {
    if (launcherCleanupDir !== null) {
      rmSync(launcherCleanupDir, { recursive: true, force: true });
      launcherCleanupDir = null;
    }
  });

  it('builds an ADK tool bundle with exactly one canonical long-running wrapper per deferred verb', () => {
    expect(probe.agent_name).toBe('mx_adk_long_running_e2e_agent');

    const canonicalNames = CANONICAL_M1_TOOLS.map((d) => d.name).sort();
    expect([...probe.tool_names].sort()).toEqual(canonicalNames);
    expect(probe.tool_names.filter((name) => name === 'mx_delegate_tool')).toHaveLength(1);
    expect(probe.tool_names.filter((name) => name === 'mx_run_command')).toHaveLength(1);
    expect(probe.long_tool_types).toEqual({
      mx_delegate_tool: 'LongRunningFunctionTool',
      mx_run_command: 'LongRunningFunctionTool',
    });
    expect(probe.tool_entry_types).toEqual(expect.arrayContaining(['LongRunningFunctionTool']));

    for (const name of probe.tool_names) {
      expect(name.startsWith('mx_'), `non-mx tool exposed to ADK: ${name}`).toBe(true);
      expect(isForbiddenAuthorityVerb(name), `authority verb exposed to ADK: ${name}`).toBe(false);
    }
  });

  it('keeps room/correlation as session metadata, never model tool args', () => {
    expect(probe.session_state).toEqual({ mx_room: fixture.room, mx_correlation_id: correlationId });
  });

  it('approval-gated mx_delegate_tool returns a pending ticket, then resumes to ok after out-of-band approval', () => {
    expectPendingTicket(probe.delegate_pending, { tool: 'mx_delegate_tool', ticketId: 'adk-e2e-delegate' });
    expect(probe.delegate_state_keys).toContain('mx_pending_adk-e2e-delegate');

    const terminal = asEnvelope(probe.delegate_terminal, 'delegate terminal');
    expect(terminal.status).toBe('ok');
    expect(terminal.audit_ref.invocation_id, 'approved delegation should carry a live invocation id').toBeTruthy();

    // Completion is idempotent: repeat resume returns the cached terminal envelope, not a new mutation.
    expect(probe.delegate_repeat).toEqual(probe.delegate_terminal);

    const resumeContent = JSON.stringify(probe.delegate_resume_content);
    expect(resumeContent).toContain('adk-e2e-delegate');
    expect(resumeContent).toContain('mx_delegate_tool');
    expect(resumeContent).toContain('ok');
  });

  it('can do other ADK/MCP work while the approval ticket remains pending', () => {
    expect(probe.pending_ids_during_other_work).toContain('adk-e2e-delegate');
    const other = asEnvelope(probe.other_work, 'other work');
    expect(other.status).toBe('ok');
    const result = other.result as Record<string, unknown>;
    expect(Array.isArray(result['agents'])).toBe(true);
  });

  it('approval-gated mx_run_command is also wrapped as long-running and resumes on approval', () => {
    expectPendingTicket(probe.run_command_pending, { tool: 'mx_run_command', ticketId: 'adk-e2e-run-command' });
    const terminal = asEnvelope(probe.run_command_terminal, 'run_command terminal');
    expect(terminal.status).toBe('ok');
    expect(terminal.result).toEqual(expect.objectContaining({ exit_code: expect.any(Number) }));
  });

  it('observes the daemon/operator denial path without exposing an approval mutation surface', () => {
    expectPendingTicket(probe.deny_pending, { tool: 'mx_delegate_tool', ticketId: 'adk-e2e-delegate-deny' });
    const terminal = asEnvelope(probe.deny_terminal, 'denied terminal');
    expect(terminal.status).toBe('denied');
    expect(terminal.error?.code).toBe('approval_denied');
    expect(probe.remaining_pending_ids).toEqual([]);
  });

  it('surfaces a deny-by-default policy_denied terminal directly, without manufacturing a pending ticket', () => {
    // Out-of-process policy enforcement: the receiving daemon denies a non-allowlisted
    // tool by default. The long-running wrapper must return that terminal envelope as
    // the ADK result and NOT create a ticket (a shim that treats `denied` as `pending`
    // would hang awaiting a resume that never arrives).
    const terminal = asEnvelope(probe.policy_denied_terminal, 'policy_denied terminal');
    expect(terminal.status).toBe('denied');
    expect(terminal.error?.code).toBe('policy_denied');
    expect(terminal.handle, 'a policy-denied terminal must not carry a resolvable handle').toBeNull();
    expect(terminal.approval, 'a policy denial requests no approval').toBeNull();
    expect(probe.policy_denied_made_ticket, 'a terminal initial dispatch must not create a pending ticket').toBe(
      false,
    );
    expect(probe.remaining_pending_ids).toEqual([]);
  });

  it('does not expose synthetic Boundary-A/provider/audit secrets in ADK-visible outputs', () => {
    const raw = JSON.stringify(probe);
    expect(raw).not.toMatch(SECRET_PATTERN);
    for (const [deniedKey, deniedValue] of Object.entries(FAKE_SECRET_ENV)) {
      expect(probe.child_env_keys, `secret-shaped key admitted to mx-loom-mcp child env: ${deniedKey}`).not.toContain(
        deniedKey,
      );
      expect(raw, `secret value for ${deniedKey} leaked into ADK-visible output`).not.toContain(deniedValue);
    }
    expect(raw).not.toContain('MXLADKLONGLEAK');
  });
});
