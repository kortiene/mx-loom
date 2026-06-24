/**
 * T201 / #23 ADK MCPToolset end-to-end acceptance.
 *
 * Target behavior: a Google ADK `LlmAgent` mounts the generated `mx-loom-mcp`
 * stdio server via `MCPToolset`, lists the canonical `mx_*` tools, and calls them
 * through ADK's MCP tool wrapper. This is the M2 ADK acceptance slice that the M1
 * golden gate cannot cover: the runtime boundary is ADK → MCP stdio → mx-loom-mcp
 * → live `mx-agent` daemon A → daemon B.
 *
 * Scope boundaries:
 *   - Exercises generic `MCPToolset` wiring only (T201). ADK-native
 *     `LongRunningFunctionTool` approval resume is T202, so this test uses the
 *     ungated allowed delegation path and does not ask the model to approve or
 *     mutate trust/policy.
 *   - No provider/model call, no production services, no Matrix credentials in
 *     this process. The Python ADK driver builds an `LlmAgent` but drives the
 *     MCPToolset directly, keeping the run deterministic and key-free.
 *   - The MCP child gets a deny-by-default environment from the example recipe;
 *     the parent Python env is deliberately seeded with clearly-fake secret-shaped
 *     values and the test asserts neither tool lists nor results echo them.
 *
 * Gating:
 *   - clean skip unless `MXL_ADK_MCP_E2E=1` is set;
 *   - fail-not-skip when requested but python/google-adk, the two-daemon fixture,
 *     daemon A's socket, or a runnable mx-loom-mcp command (tsx+source, or a bin
 *     supplied via MXL_ADK_MCP_COMMAND) is missing.
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
} from '@mx-loom/registry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SECRET_PATTERN, isDaemonReachable, resolveDaemonSocket } from './_golden-harness.js';

const execFileAsync = promisify(execFile);

const ADK_E2E_ENV = 'MXL_ADK_MCP_E2E';
const ADK_PYTHON_ENV = 'MXL_ADK_PYTHON';
const ADK_MCP_COMMAND_ENV = 'MXL_ADK_MCP_COMMAND';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const adkExampleDir = join(repoRoot, 'examples', 'adk');
// The mx-loom-mcp bin is published as a standalone runnable binary only later
// (T602). In THIS workspace every @mx-loom/* package's `exports` points at
// TypeScript SOURCE (`./src/index.ts`), so the built `dist/cli.js` is NOT
// independently runnable under plain `node` — its cross-package `./foo.js` import
// specifiers do not resolve to the `.ts` sources (ERR_MODULE_NOT_FOUND). The proven
// in-repo subprocess spawn path — the same one `packages/mcp/test/stdio.integration.test.ts`
// uses — is `tsx packages/mcp/src/cli.ts`. ADK's `StdioServerParameters`
// spawns a single `command`, so when no real bin is supplied via MXL_ADK_MCP_COMMAND
// we generate a tiny launcher that execs tsx on the source entry. Set
// MXL_ADK_MCP_COMMAND to a globally linked / published `mx-loom-mcp` to exercise the
// real packaged bin instead.
const defaultCliEntry = join(repoRoot, 'packages', 'mcp', 'src', 'cli.ts');
const tsxBinCandidates = [
  join(repoRoot, 'packages', 'golden', 'node_modules', '.bin', 'tsx'),
  join(repoRoot, 'packages', 'mcp', 'node_modules', '.bin', 'tsx'),
  join(repoRoot, 'node_modules', '.bin', 'tsx'),
];

interface AdkFixture {
  readonly room: string;
  readonly targetAgentId: string;
  readonly tool: string;
}

interface AdkProbe {
  readonly agent_name: string;
  readonly agent_tool_entry_types: readonly string[];
  readonly tool_names: readonly string[];
  readonly argv: readonly string[];
  readonly child_env_keys: readonly string[];
  readonly session_state: Record<string, string>;
  readonly find_agents: Record<string, unknown>;
  readonly delegate: Record<string, unknown>;
}

function isAdkE2eRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ADK_E2E_ENV] === '1';
}

function isTwoDaemonFixtureDeclared(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['MXL_CONFORMANCE_TWO_DAEMON'] === '1';
}

function readAdkFixture(env: NodeJS.ProcessEnv = process.env): AdkFixture | null {
  const room = env['MXL_CONFORMANCE_ROOM'];
  const targetAgentId = env['MXL_CONFORMANCE_TARGET_AGENT'];
  const tool = env['MXL_CONFORMANCE_TOOL'];
  if (!room || !targetAgentId || !tool) return null;
  return { room, targetAgentId, tool };
}

function runtimeDirFromSocket(socketPath: string): string | null {
  const normalized = resolve(socketPath);
  const expectedTail = join('mx-agent', 'daemon.sock');
  if (!normalized.endsWith(expectedTail)) return null;
  const mxAgentDir = dirname(normalized);
  if (dirname(mxAgentDir) === mxAgentDir) return null;
  return dirname(mxAgentDir);
}

function resolvedPython(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[ADK_PYTHON_ENV];
  return configured && configured.trim() !== '' ? configured : 'python3';
}

function resolveTsxBin(): string | null {
  return tsxBinCandidates.find((candidate) => existsSync(candidate)) ?? null;
}

interface SpawnPlan {
  /** The single executable ADK's StdioServerParameters spawns (invoked as `command --stdio …`). */
  readonly command: string;
  /** A temp dir holding a generated launcher, removed on teardown; null for an external bin. */
  readonly cleanupDir: string | null;
}

/**
 * Resolve the single command ADK will spawn. With MXL_ADK_MCP_COMMAND set, use that
 * external bin verbatim (validated to exist). Otherwise generate a launcher that
 * execs `tsx src/cli.ts "$@"`, so the recipe's fixed `--stdio …` argv flows straight
 * through to the real CLI without depending on a non-runnable dist build.
 */
function prepareSpawnCommand(env: NodeJS.ProcessEnv = process.env): SpawnPlan {
  const configured = env[ADK_MCP_COMMAND_ENV];
  if (configured && configured.trim() !== '') {
    if (!existsSync(configured)) {
      throw new Error(
        `T201 ADK MCPToolset e2e could not find the MXL_ADK_MCP_COMMAND bin at ${configured}. ` +
          'Point it at a resolvable, executable mx-loom-mcp (a globally linked or published bin).',
      );
    }
    return { command: configured, cleanupDir: null };
  }

  const tsxBin = resolveTsxBin();
  if (tsxBin === null) {
    throw new Error(
      'T201 ADK MCPToolset e2e could not find a `tsx` binary in the workspace ' +
        `(looked in ${tsxBinCandidates.join(', ')}). Run \`pnpm install\`, or set ` +
        'MXL_ADK_MCP_COMMAND to a runnable mx-loom-mcp bin.',
    );
  }
  if (!existsSync(defaultCliEntry)) {
    throw new Error(`T201 ADK MCPToolset e2e could not find the mx-loom-mcp source entry at ${defaultCliEntry}.`);
  }

  const cleanupDir = mkdtempSync(join(tmpdir(), 'mxl-adk-launcher-'));
  const launcher = join(cleanupDir, 'mx-loom-mcp');
  // `exec` replaces the shell so SIGTERM / stdin-close reach the Node server
  // directly (the clean-shutdown path stdio.integration.test.ts relies on). "$@"
  // forwards the recipe's `--stdio --room … --kind adk …` argv verbatim. The paths
  // are workspace-controlled (no shell metacharacters), JSON-quoted defensively.
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

async function googleAdkImportWorks(python: string): Promise<boolean> {
  try {
    await execFileAsync(
      python,
      [
        '-c',
        'from google.adk.agents import LlmAgent; from google.adk.tools.mcp_tool import MCPToolset, StdioServerParameters',
      ],
      { timeout: 10_000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
    );
    return true;
  } catch {
    return false;
  }
}

async function assertAdkPrereqs(): Promise<{ fixture: AdkFixture; python: string; spawn: SpawnPlan; runtimeDir: string }> {
  if (!isTwoDaemonFixtureDeclared()) {
    throw new Error(
      'T201 ADK MCPToolset e2e was requested with MXL_ADK_MCP_E2E=1, but ' +
        'MXL_CONFORMANCE_TWO_DAEMON=1 is not set. Bring up the pinned two-daemon fixture ' +
        '(daemon A + daemon B) or unset MXL_ADK_MCP_E2E for a clean local skip.',
    );
  }

  if (!isDaemonReachable()) {
    throw new Error(
      'T201 ADK MCPToolset e2e was requested, but no mx-agent daemon is reachable at ' +
        `${resolveDaemonSocket()}. The requested ADK e2e must fail, not skip, when the ` +
        'fixture is declared but daemon A is unreachable.',
    );
  }

  const fixture = readAdkFixture();
  if (fixture === null) {
    throw new Error(
      'T201 ADK MCPToolset e2e fixture coordinates are incomplete. Expected ' +
        'MXL_CONFORMANCE_ROOM, MXL_CONFORMANCE_TARGET_AGENT, and MXL_CONFORMANCE_TOOL ' +
        'from bootstrap-daemon-a.sh/bootstrap-daemon-b.sh.',
    );
  }

  const socketPath = resolveDaemonSocket();
  const runtimeDir = runtimeDirFromSocket(socketPath);
  if (runtimeDir === null) {
    throw new Error(
      'T201 ADK MCPToolset e2e needs daemon A at the standard socket location ' +
        '$XDG_RUNTIME_DIR/mx-agent/daemon.sock so the ADK-spawned mx-loom-mcp child can ' +
        `resolve it via the deny-by-default env. Got: ${socketPath}`,
    );
  }

  const python = resolvedPython();
  if (!(await commandWorks(python))) {
    throw new Error(
      `T201 ADK MCPToolset e2e could not run ${python}. Install Python 3 or set ${ADK_PYTHON_ENV} ` +
        'to the interpreter in the virtualenv where google-adk is installed.',
    );
  }

  if (!(await googleAdkImportWorks(python))) {
    throw new Error(
      'T201 ADK MCPToolset e2e requires google-adk with the import paths used by ' +
        'examples/adk/mcp_toolset_agent.py. Run `python -m pip install -r examples/adk/requirements.txt` ' +
        `inside ${python}'s environment, or update the example imports for your pinned ADK version.`,
    );
  }

  const spawn = prepareSpawnCommand();

  return { fixture, python, spawn, runtimeDir };
}

/**
 * Synthetic, clearly-fake Boundary-A / provider / audit credentials seeded into
 * the ADK parent process. Single source of truth so the two boundary assertions
 * stay in lockstep: (1) NONE of these KEYS may reach the mx-loom-mcp child env
 * (`child_env_keys`), and (2) NONE of these VALUES may appear anywhere in the
 * ADK-visible probe output (the inbound Boundary-A leak check). Each value carries
 * the unique sentinel `MXLADKLEAK` so the value check is unambiguous and does not
 * rely on `SECRET_PATTERN` happening to match a particular token shape.
 */
const FAKE_SECRET_ENV: Readonly<Record<string, string>> = {
  GH_TOKEN: 'ghp_fake_MXLADKLEAK_not_real_1234567890',
  MATRIX_ACCESS_TOKEN: 'syt_a_fake_MXLADKLEAK_not_real',
  MX_AGENT_SECRET: 'fake_MXLADKLEAK_mx_agent_secret_not_real',
  GOOGLE_API_KEY: 'fake_MXLADKLEAK_google_api_key_not_real',
  ANTHROPIC_API_KEY: 'sk-ant-fake_MXLADKLEAK_not_real',
  OPENAI_API_KEY: 'sk-fake_MXLADKLEAK_openai_not_real',
  DATABASE_URL: 'postgres://user:fake_MXLADKLEAK_pw@db.invalid/mxloom',
};

function pythonEnv(runtimeDir: string): NodeJS.ProcessEnv {
  // Do not inherit the caller's full env: the ADK e2e parent gets only what it
  // needs plus the synthetic secret-shaped values that must never reach the child
  // env or appear in any ADK-visible result.
  return {
    PATH: process.env['PATH'] ?? '/usr/bin',
    HOME: process.env['HOME'] ?? repoRoot,
    XDG_RUNTIME_DIR: runtimeDir,
    LANG: 'C',
    LC_ALL: 'C',
    TERM: 'xterm',
    PYTHONPATH: adkExampleDir,
    PYTHONDONTWRITEBYTECODE: '1',
    ...FAKE_SECRET_ENV,
  };
}

function parseProbe(stdout: string): AdkProbe {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const last = lines.at(-1);
  if (last === undefined) throw new Error('ADK e2e Python driver produced no JSON output');
  return JSON.parse(last) as AdkProbe;
}

const PY_DRIVER = String.raw`
import asyncio
import inspect
import json
import sys
from dataclasses import asdict, is_dataclass
from typing import Any

import mcp_toolset_agent as recipe

CONFIG = json.loads(sys.argv[1])

class FakeToolContext:
    """Minimal non-authority ToolContext stand-in for direct BaseTool.run_async()."""
    def __init__(self) -> None:
        self.state = {}
        self.actions = type("Actions", (), {})()
        self.invocation_context = None
        self.function_call_id = "mxl-adk-e2e"

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
        return to_plain(value.model_dump(mode="json"))
    if hasattr(value, "dict"):
        return to_plain(value.dict())
    if hasattr(value, "__dict__"):
        return {str(k): to_plain(v) for k, v in vars(value).items() if not k.startswith("_")}
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

async def get_tools(toolset: Any) -> list[Any]:
    attempts = [
        ("get_tools(readonly_context=None)", lambda: toolset.get_tools(readonly_context=None)),
        ("get_tools()", lambda: toolset.get_tools()),
        ("get_tools(None)", lambda: toolset.get_tools(None)),
    ]
    errors: list[str] = []
    for label, thunk in attempts:
        try:
            tools = await maybe_await(thunk())
            if tools is None:
                errors.append(f"{label}: returned None")
                continue
            return list(tools)
        except TypeError as exc:
            errors.append(f"{label}: {exc}")
    raise RuntimeError("ADK MCPToolset did not expose a compatible get_tools API: " + " | ".join(errors))

async def call_tool(tool: Any, args: dict[str, Any]) -> Any:
    ctx = FakeToolContext()
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
            # Keep trying signature variants. Non-TypeError failures are genuine
            # tool/daemon failures and should make the e2e red.
            errors.append(f"{label}: {exc}")
    raise RuntimeError("ADK tool did not expose a compatible call API: " + " | ".join(errors))

def envelope_from_result(value: Any) -> dict[str, Any]:
    plain = to_plain(value)
    candidates: list[Any] = [plain]
    if isinstance(plain, dict):
        for key in ("structuredContent", "structured_content", "structured_content_json"):
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

    for candidate in candidates:
        if isinstance(candidate, str):
            try:
                candidate = json.loads(candidate)
            except json.JSONDecodeError:
                continue
        if isinstance(candidate, dict) and candidate.get("status") in {"ok", "running", "awaiting_approval", "denied", "error"}:
            return candidate
    raise RuntimeError(f"could not extract T102 envelope from ADK tool result: {plain!r}")

async def close_toolset(toolset: Any) -> None:
    for name in ("close", "close_async", "shutdown"):
        if hasattr(toolset, name):
            await maybe_await(getattr(toolset, name)())
            return

async def main() -> None:
    # Deferred imports are part of the recipe's contract. Importing them here also
    # verifies the pinned google-adk version still exposes the documented names.
    from google.adk.agents import LlmAgent

    correlation_id = CONFIG["correlation_id"]
    toolset = recipe.mx_mcp_toolset(
        room=CONFIG["room"],
        correlation_id=correlation_id,
        command=CONFIG["command"],
        max_invocations=4,
    )
    agent = LlmAgent(
        name="mx_adk_e2e_agent",
        model=CONFIG.get("model", "mx-adk-e2e-no-provider-call"),
        instruction="List and call mx_* tools. Never include credentials in tool arguments.",
        tools=[toolset],
    )

    try:
        tools = await get_tools(toolset)
        by_name = {tool_name(t): t for t in tools}
        missing = [name for name in ("mx_find_agents", "mx_delegate_tool") if name not in by_name]
        if missing:
            raise RuntimeError(f"ADK MCPToolset did not expose required mx_* tools: {missing}; got {sorted(by_name)}")

        find_agents = envelope_from_result(await call_tool(by_name["mx_find_agents"], {"tool": CONFIG["tool"]}))
        delegate = envelope_from_result(await call_tool(by_name["mx_delegate_tool"], {
            "agent": CONFIG["target_agent_id"],
            "tool": CONFIG["tool"],
            "args": {"package": "mx-loom-adk-e2e"},
            "wait_ms": 60000,
            "idempotency_key": CONFIG["idempotency_key"],
        }))

        print(json.dumps({
            "agent_name": getattr(agent, "name", ""),
            "agent_tool_entry_types": [type(t).__name__ for t in getattr(agent, "tools", [])],
            "tool_names": sorted(by_name.keys()),
            "argv": recipe._mx_mcp_args(
                room=CONFIG["room"],
                correlation_id=correlation_id,
                max_invocations=4,
            ),
            "child_env_keys": sorted(recipe.safe_mx_mcp_env().keys()),
            "session_state": recipe.mx_session_state(CONFIG["room"], correlation_id),
            "find_agents": find_agents,
            "delegate": delegate,
        }, sort_keys=True))
    finally:
        await close_toolset(toolset)

asyncio.run(main())
`;

const skipAdk = !isAdkE2eRequested();

describe.skipIf(skipAdk)('T201 e2e · Google ADK MCPToolset lists and calls mx_* via MCP', () => {
  let probe: AdkProbe;
  let fixture: AdkFixture;
  let correlationId = '';
  let launcherCleanupDir: string | null = null;

  beforeAll(async () => {
    const prereqs = await assertAdkPrereqs();
    fixture = prereqs.fixture;
    launcherCleanupDir = prereqs.spawn.cleanupDir;
    correlationId = `adk-e2e-${randomUUID()}`;
    const stdout = await execFileAsync(
      prereqs.python,
      [
        '-c',
        PY_DRIVER,
        JSON.stringify({
          room: fixture.room,
          target_agent_id: fixture.targetAgentId,
          tool: fixture.tool,
          command: prereqs.spawn.command,
          correlation_id: correlationId,
          idempotency_key: `mxl-adk-e2e-${randomUUID()}`,
        }),
      ],
      {
        cwd: adkExampleDir,
        env: pythonEnv(prereqs.runtimeDir),
        timeout: 180_000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
      },
    );
    probe = parseProbe(stdout.stdout);
  }, 180_000);

  afterAll(() => {
    if (launcherCleanupDir !== null) {
      rmSync(launcherCleanupDir, { recursive: true, force: true });
      launcherCleanupDir = null;
    }
  });

  it('builds an ADK LlmAgent with an MCPToolset and lists exactly the canonical mx_* tools', () => {
    expect(probe.agent_name).toBe('mx_adk_e2e_agent');
    expect(probe.agent_tool_entry_types).toEqual(expect.arrayContaining(['MCPToolset']));

    const canonicalNames = CANONICAL_M1_TOOLS.map((d) => d.name).sort();
    expect([...probe.tool_names].sort()).toEqual(canonicalNames);
    for (const name of probe.tool_names) {
      expect(name.startsWith('mx_'), `non-mx tool exposed to ADK: ${name}`).toBe(true);
      expect(isForbiddenAuthorityVerb(name), `authority verb exposed to ADK: ${name}`).toBe(false);
    }
  });

  it('threads non-secret session metadata via the MCP stdio argv / ToolContext state, not model tool args', () => {
    expect(probe.argv).toEqual([
      '--stdio',
      '--room',
      fixture.room,
      '--kind',
      'adk',
      '--correlation-id',
      correlationId,
      '--max-invocations',
      '4',
    ]);
    expect(probe.session_state).toEqual({ mx_room: fixture.room, mx_correlation_id: correlationId });
    expect(Object.keys(probe.session_state).sort()).toEqual(['mx_correlation_id', 'mx_room']);
  });

  it('calls mx_find_agents through ADK MCPToolset and receives a valid secret-free envelope', () => {
    expect(validateEnvelope(probe.find_agents)).toBe(true);
    expect(probe.find_agents['status']).toBe('ok');
    const result = probe.find_agents['result'] as Record<string, unknown>;
    expect(Array.isArray(result['agents'])).toBe(true);
    expect(JSON.stringify(probe.find_agents)).not.toMatch(SECRET_PATTERN);
  });

  it('delegates the allowlisted tool through ADK MCPToolset → mx-loom-mcp → live daemon pair', () => {
    expect(validateEnvelope(probe.delegate)).toBe(true);
    expect(probe.delegate['status']).toBe('ok');
    const auditRef = probe.delegate['audit_ref'] as Record<string, unknown>;
    expect(auditRef['invocation_id'], 'live delegation should carry a daemon invocation id').toBeTruthy();
    expect(JSON.stringify(probe.delegate)).not.toMatch(SECRET_PATTERN);
  });

  it('does not expose synthetic Boundary-A/provider/audit secrets in ADK-visible outputs', () => {
    const raw = JSON.stringify(probe);
    // (1) Generic token-shape backstop.
    expect(raw).not.toMatch(SECRET_PATTERN);
    for (const [deniedKey, deniedValue] of Object.entries(FAKE_SECRET_ENV)) {
      // (2a) No secret-shaped KEY reaches the mx-loom-mcp child env (outbound).
      expect(probe.child_env_keys, `secret-shaped key admitted to mx-loom-mcp child env: ${deniedKey}`).not.toContain(
        deniedKey,
      );
      // (2b) No secret VALUE crosses Boundary A into ADK-visible output (inbound) —
      // the sentinel makes this catch ALL seven, not only the two SECRET_PATTERN matches.
      expect(raw, `secret value for ${deniedKey} leaked into ADK-visible output`).not.toContain(deniedValue);
    }
    // The shared sentinel must not appear anywhere in any ADK-visible surface.
    expect(raw).not.toContain('MXLADKLEAK');
  });
});
