/**
 * ADK scenario-driver helpers for the T206 portability matrix (#28).
 *
 * A self-contained driver the matrix gate (`portability-matrix.e2e.test.ts`)
 * composes for the ADK row. It reuses the T201/T202 ADK example
 * (`examples/adk/long_running_tools.py`) — the `LongRunningFunctionTool` bundle
 * that exposes all nine canonical verbs — and drives the **full binding-agnostic
 * S1–S8** model-free (no provider/model call): discovery (S1/S2), ungated
 * delegation (S3), the approval gate approve/deny legs (S4/S5), guarded exec
 * approve (S6), `deny_args_regex` (S7), and deny-by-default (S8). Approval is real
 * and out-of-band — Python shells out to `scripts/conformance/decide-approval.sh`,
 * the same operator the Pi/MCP/Claude arms use.
 *
 * The existing T202 arm (`adk.long-running.e2e.test.ts`) covers S4/S5/S6/S8 + the
 * shim's ticket disposition with detailed per-runtime assertions; this driver adds
 * S2/S3/S7 so the ADK matrix row is a true S1–S8 (spec OQ5). The two share the same
 * `examples/adk/long_running_tools.py` bundle and the same secret env (sentinel
 * `MXLADKLONGLEAK`); the matrix asserts the aggregate cross-runtime invariant.
 *
 * Secret-free: the spawned `mx-loom-mcp` child env is a deny-by-default allowlist
 * (never `...process.env`); the parent seeds clearly-fake secret-shaped values and
 * the matrix asserts none reach the child env or any ADK-visible output.
 */
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { validateEnvelope } from '@mx-loom/registry';
import type { ToolResult } from '@mx-loom/registry';

import {
  GOLDEN_RESOLVE_BUDGET_MS,
  isDaemonReachable,
  isGoldenPolicyActive,
  isTwoDaemonRequired,
  readGoldenFixture,
  resolveDaemonSocket,
  type GoldenFixture,
} from './_golden-harness.js';
import { DANGEROUS_COMMAND_ARGS, SAFE_COMMAND_ARGS } from './scenario.js';

const execFileAsync = promisify(execFile);

export const ADK_LONG_E2E_ENV = 'MXL_ADK_LONG_RUNNING_E2E';
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

/** The raw probe the Python driver prints (each S* is a T102 envelope dict). */
interface AdkScenarioProbeRaw {
  readonly tool_names: readonly string[];
  readonly child_env_keys: readonly string[];
  readonly session_state: Record<string, string>;
  readonly steps: Record<string, Record<string, unknown>>;
  readonly remaining_pending_ids: readonly string[];
}

/** The normalized ADK row the matrix consumes. */
export interface AdkScenarioResult {
  /** Canonical tool names the ADK bundle exposed (for descriptor identity). */
  readonly toolNames: readonly string[];
  /** The deny-by-default child env keys (proves the secret scrub). */
  readonly childEnvKeys: readonly string[];
  /** room/correlation as session metadata (never model args). */
  readonly sessionState: Record<string, string>;
  /** S1–S8 → the terminal T102 envelope observed under ADK. */
  readonly steps: Record<string, ToolResult>;
  /** Tickets still pending at the end (must be empty — every held step resolved). */
  readonly remainingPendingIds: readonly string[];
  /** The full probe serialized (for the secret-leak backstop). */
  readonly raw: string;
}

export function isAdkRequested(env: NodeJS.ProcessEnv = process.env): boolean {
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
        `T206 ADK row could not find ${ADK_MCP_COMMAND_ENV} at ${configured}. ` +
          'Point it at a resolvable, executable mx-loom-mcp bin.',
      );
    }
    return { command: configured, cleanupDir: null };
  }
  const tsxBin = resolveTsxBin();
  if (tsxBin === null) {
    throw new Error(
      'T206 ADK row could not find a `tsx` binary in the workspace ' +
        `(looked in ${tsxBinCandidates.join(', ')}). Run \`pnpm install\`, or set ` +
        `${ADK_MCP_COMMAND_ENV} to a runnable mx-loom-mcp bin.`,
    );
  }
  if (!existsSync(defaultCliEntry)) {
    throw new Error(`T206 ADK row could not find the mx-loom-mcp source entry at ${defaultCliEntry}.`);
  }
  const cleanupDir = mkdtempSync(join(tmpdir(), 'mxl-portability-adk-launcher-'));
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

async function googleAdkImportsWork(python: string): Promise<boolean> {
  try {
    await execFileAsync(
      python,
      [
        '-c',
        'from google.adk.agents import LlmAgent; ' +
          'from google.adk.tools import LongRunningFunctionTool; ' +
          'from google.adk.tools.mcp_tool import MCPToolset, StdioServerParameters; ' +
          'from google.genai import types',
      ],
      { timeout: 10_000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
    );
    return true;
  } catch {
    return false;
  }
}

export interface AdkPrereqs {
  readonly fixture: GoldenFixture;
  readonly python: string;
  readonly spawn: SpawnPlan;
  readonly runtimeDir: string;
}

/**
 * Fail-not-skip prereqs for the ADK row. Throws (→ red) when the row is requested
 * but python/google-adk, the golden two-daemon fixture, daemon A's socket, or a
 * runnable mx-loom-mcp command is missing.
 */
export async function assertAdkPrereqs(): Promise<AdkPrereqs> {
  if (!isTwoDaemonRequired()) {
    throw new Error(
      'T206 ADK row was requested, but MXL_CONFORMANCE_TWO_DAEMON=1 is not set. Bring up daemon A+B or unset the opt-in.',
    );
  }
  if (!isGoldenPolicyActive()) {
    throw new Error(
      'T206 ADK row needs the golden approval policy. Set MXL_CONFORMANCE_GOLDEN_POLICY=1 after bringing up ' +
        'daemon B with POLICY_FIXTURE=policy.golden.toml.',
    );
  }
  if (!isDaemonReachable()) {
    throw new Error(
      `T206 ADK row was requested, but no mx-agent daemon is reachable at ${resolveDaemonSocket()}. ` +
        'It must fail, not skip, when its fixture is declared but daemon A is unreachable.',
    );
  }
  const fixture = readGoldenFixture();
  if (fixture === null) {
    throw new Error(
      'T206 ADK row fixture coordinates are incomplete. Expected the golden fixture env vars ' +
        '(MXL_CONFORMANCE_ROOM, MXL_CONFORMANCE_TARGET_AGENT, MXL_CONFORMANCE_TOOL, ' +
        'MXL_CONFORMANCE_APPROVAL_TOOL, MXL_CONFORMANCE_DENIED_TOOL, MXL_CONFORMANCE_ALLOWED_COMMAND).',
    );
  }
  const runtimeDir = runtimeDirFromSocket(resolveDaemonSocket());
  if (runtimeDir === null) {
    throw new Error(
      'T206 ADK row needs daemon A at $XDG_RUNTIME_DIR/mx-agent/daemon.sock so the ADK-spawned mx-loom-mcp ' +
        `child can resolve it safely. Got: ${resolveDaemonSocket()}`,
    );
  }
  const python = resolvedPython();
  if (!(await commandWorks(python))) {
    throw new Error(
      `T206 ADK row could not run ${python}. Install Python 3 or set ${ADK_PYTHON_ENV} to the interpreter ` +
        'in the virtualenv where google-adk is installed.',
    );
  }
  if (!(await googleAdkImportsWork(python))) {
    throw new Error(
      'T206 ADK row requires google-adk exposing LlmAgent, LongRunningFunctionTool, MCPToolset, ' +
        'StdioServerParameters, and google.genai.types. Run `python -m pip install -r examples/adk/requirements.txt`.',
    );
  }
  if (!existsSync(decideApprovalScript)) {
    throw new Error(`T206 ADK row could not find the out-of-band operator script at ${decideApprovalScript}.`);
  }
  return { fixture, python, spawn: prepareSpawnCommand(), runtimeDir };
}

/** Synthetic, clearly-fake credentials that must never reach the MCP child or model-visible output. */
export const ADK_FAKE_SECRET_ENV: Readonly<Record<string, string>> = {
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
    ...ADK_FAKE_SECRET_ENV,
  };
  for (const key of OPERATOR_ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined && value !== '') env[key] = value;
  }
  return env;
}

function parseProbe(stdout: string): AdkScenarioProbeRaw {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const last = lines.at(-1);
  if (last === undefined) throw new Error('T206 ADK row: Python driver produced no JSON output');
  return JSON.parse(last) as AdkScenarioProbeRaw;
}

/**
 * The full S1–S8 ADK driver. Reuses the existing example bundle helpers verbatim
 * (the proven `call_tool` / `extract_envelope` / `decide` / `resolve_ticket` path
 * from `adk.long-running.e2e.test.ts`) and runs the scenario in S1–S8 order. The
 * held steps (S4/S5/S6) decide out-of-band strictly between the pending dispatch
 * and the host resume — deterministic, no guessing bot.
 */
const MATRIX_PY_DRIVER = String.raw`
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

async def call_tool(tool: Any, args: dict, ctx: FakeToolContext) -> Any:
    attempts = []
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
    errors = []
    for label, thunk in attempts:
        try:
            return await maybe_await(thunk())
        except TypeError as exc:
            errors.append(f"{label}: {exc}")
    raise RuntimeError("ADK tool did not expose a compatible call API: " + " | ".join(errors))

def collect_candidates(value: Any) -> list:
    plain = to_plain(value)
    candidates = [plain]
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
    out = []
    for candidate in candidates:
        if isinstance(candidate, str):
            try:
                candidate = json.loads(candidate)
            except json.JSONDecodeError:
                pass
        out.append(candidate)
    return out

def pending_from_result(value: Any) -> dict:
    for candidate in collect_candidates(value):
        if isinstance(candidate, dict) and candidate.get("pending") is True and isinstance(candidate.get("handle"), str):
            return candidate
    raise RuntimeError(f"could not extract mx-loom pending ticket from ADK result: {to_plain(value)!r}")

def envelope_from_result(value: Any) -> dict:
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

def tool_map(bundle: Any) -> dict:
    by_name = {}
    for tool in bundle.tools:
        name = tool_name(tool)
        if name in by_name:
            raise RuntimeError(f"duplicate ADK tool name exposed: {name}")
        by_name[name] = tool
    return by_name

async def held_step(bundle, by_name, ticket_id, tool, args, action, match):
    ctx = FakeToolContext(ticket_id)
    pending_from_result(await call_tool(by_name[tool], args, ctx))
    decide(action, match)
    return await bundle.resolve_ticket(ticket_id, wait_ms=CONFIG["resolve_wait_ms"], tool_context=ctx)

async def main() -> None:
    from google.adk.agents import LlmAgent

    correlation_id = CONFIG["correlation_id"]
    bundle = await lrt.mx_long_running_tool_bundle(
        room=CONFIG["room"],
        correlation_id=correlation_id,
        command=CONFIG["command"],
        max_invocations=16,
    )
    LlmAgent(
        name="mx_adk_portability_agent",
        model="mx-adk-portability-no-provider-call",
        instruction="Use mx_* tools. Long-running tickets are resumed by the host; never approve your own work.",
        tools=bundle.tools,
    )
    try:
        by_name = tool_map(bundle)
        steps = {}

        # S1 — discovery: mx_find_agents (filtered by the allow tool) → ok.
        steps["S1"] = envelope_from_result(await call_tool(
            by_name["mx_find_agents"], {"tool": CONFIG["allow_tool"]}, FakeToolContext("S1")))

        # S2 — discovery: mx_describe_agent(B) → ok.
        steps["S2"] = envelope_from_result(await call_tool(
            by_name["mx_describe_agent"], {"agent_id": CONFIG["target_agent_id"]}, FakeToolContext("S2")))

        # S3 — ungated named-tool delegation resolves inline → ok + audit_ref.
        steps["S3"] = envelope_from_result(await call_tool(by_name["mx_delegate_tool"], {
            "agent": CONFIG["target_agent_id"],
            "tool": CONFIG["allow_tool"],
            "args": {"package": "mx-loom-portability"},
            "wait_ms": CONFIG["resolve_wait_ms"],
            "idempotency_key": CONFIG["idem"]["s3"],
        }, FakeToolContext("S3")))

        # S4 — approval-gated delegation: pending → approve → ok.
        steps["S4"] = await held_step(bundle, by_name, "S4", "mx_delegate_tool", {
            "agent": CONFIG["target_agent_id"], "tool": CONFIG["approval_tool"], "args": {},
            "wait_ms": 0, "idempotency_key": CONFIG["idem"]["s4"],
        }, "approve", CONFIG["approval_tool"])

        # S5 — approval-gated delegation: pending → deny → denied(approval_denied).
        steps["S5"] = await held_step(bundle, by_name, "S5", "mx_delegate_tool", {
            "agent": CONFIG["target_agent_id"], "tool": CONFIG["approval_tool"], "args": {},
            "wait_ms": 0, "idempotency_key": CONFIG["idem"]["s5"],
        }, "deny", CONFIG["approval_tool"])

        # S6 — guarded exec: pending → approve → ok(exit_code).
        run_args = {
            "agent": CONFIG["target_agent_id"], "command": CONFIG["allowed_command"],
            "args": CONFIG["safe_args"], "wait_ms": 0, "idempotency_key": CONFIG["idem"]["s6"],
        }
        if CONFIG.get("allow_cwd"):
            run_args["cwd"] = CONFIG["allow_cwd"]
        steps["S6"] = await held_step(bundle, by_name, "S6", "mx_run_command", run_args, "approve", CONFIG["allowed_command"])

        # S7 — guarded exec tripping deny_args_regex → policy_denied (terminal, no ticket).
        s7_args = {
            "agent": CONFIG["target_agent_id"], "command": CONFIG["allowed_command"],
            "args": CONFIG["dangerous_args"], "wait_ms": 0, "idempotency_key": CONFIG["idem"]["s7"],
        }
        if CONFIG.get("allow_cwd"):
            s7_args["cwd"] = CONFIG["allow_cwd"]
        steps["S7"] = envelope_from_result(await call_tool(by_name["mx_run_command"], s7_args, FakeToolContext("S7")))

        # S8 — deny-by-default delegation → policy_denied (terminal, no ticket).
        steps["S8"] = envelope_from_result(await call_tool(by_name["mx_delegate_tool"], {
            "agent": CONFIG["target_agent_id"], "tool": CONFIG["denied_tool"], "args": {},
            "wait_ms": 0, "idempotency_key": CONFIG["idem"]["s8"],
        }, FakeToolContext("S8")))

        print(json.dumps({
            "tool_names": sorted(by_name.keys()),
            "child_env_keys": sorted(lrt.safe_mx_mcp_env().keys()),
            "session_state": lrt.mx_session_state(CONFIG["room"], correlation_id),
            "steps": steps,
            "remaining_pending_ids": sorted(t.ticket_id for t in bundle.pending_tickets()),
        }, sort_keys=True))
    finally:
        await bundle.close()

asyncio.run(main())
`;

function asEnvelope(value: Record<string, unknown>, label: string): ToolResult {
  if (!validateEnvelope(value)) {
    throw new Error(`T206 ADK row: ${label} is not a valid T102 envelope`);
  }
  return value as unknown as ToolResult;
}

/** Run the full S1–S8 ADK scenario and return per-step terminals + identity. */
export async function runAdkScenario(pre: AdkPrereqs, correlationId: string): Promise<AdkScenarioResult> {
  const stdout = await execFileAsync(
    pre.python,
    [
      '-c',
      MATRIX_PY_DRIVER,
      JSON.stringify({
        room: pre.fixture.room,
        target_agent_id: pre.fixture.targetAgentId,
        allow_tool: pre.fixture.allowTool,
        approval_tool: pre.fixture.approvalTool,
        denied_tool: pre.fixture.deniedTool,
        allowed_command: pre.fixture.allowedCommand,
        allow_cwd: pre.fixture.allowCwd ?? '',
        safe_args: [...SAFE_COMMAND_ARGS],
        dangerous_args: [...DANGEROUS_COMMAND_ARGS],
        command: pre.spawn.command,
        correlation_id: correlationId,
        decide_script: decideApprovalScript,
        resolve_wait_ms: GOLDEN_RESOLVE_BUDGET_MS,
        idem: {
          s3: `mxl-adk-portability-${correlationId}-s3`,
          s4: `mxl-adk-portability-${correlationId}-s4`,
          s5: `mxl-adk-portability-${correlationId}-s5`,
          s6: `mxl-adk-portability-${correlationId}-s6`,
          s7: `mxl-adk-portability-${correlationId}-s7`,
          s8: `mxl-adk-portability-${correlationId}-s8`,
        },
      }),
    ],
    {
      cwd: adkExampleDir,
      env: pythonEnv(pre.runtimeDir),
      timeout: 300_000,
      maxBuffer: 6 * 1024 * 1024,
      encoding: 'utf8',
    },
  );

  const probe = parseProbe(stdout.stdout);
  const steps: Record<string, ToolResult> = {};
  for (const [id, env] of Object.entries(probe.steps)) {
    steps[id] = asEnvelope(env, `ADK ${id}`);
  }
  return {
    toolNames: probe.tool_names,
    childEnvKeys: probe.child_env_keys,
    sessionState: probe.session_state,
    steps,
    remainingPendingIds: probe.remaining_pending_ids,
    raw: JSON.stringify(probe),
  };
}

/** Remove the generated mx-loom-mcp launcher temp dir, if one was created. */
export function cleanupAdk(pre: AdkPrereqs | null): void {
  if (pre?.spawn.cleanupDir != null) rmSync(pre.spawn.cleanupDir, { recursive: true, force: true });
}
