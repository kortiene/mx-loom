/**
 * OpenCode scenario-driver helpers for the T206 portability matrix (#28).
 *
 * A self-contained driver the matrix gate (`portability-matrix.e2e.test.ts`)
 * composes for the OpenCode row, mirroring the T203 acceptance arm
 * (`opencode.mcp-entry.e2e.test.ts`) without re-pasting the per-runtime assertions.
 * It renders this repo's `opencode.json` (local stdio / remote HTTP), starts
 * `opencode serve` from a **deny-by-default scrubbed env** (never `...process.env`;
 * the SDK's env-spreading `createOpencodeServer` is deliberately NOT used), and
 * reports — model-free — that the `mx-loom` server connects and surfaces exactly
 * the canonical `mx_*` tools. When `MXL_OPENCODE_MODEL` is set it additionally
 * drives a real `session.prompt` so an OpenCode agent calls `mx_delegate_tool`
 * (S3), and returns the resulting T102 envelope.
 *
 * Divergence note (spec OQ3): this module duplicates the load-bearing
 * scrubbed-env/spawn logic from the T203 arm rather than refactoring that ~570-line
 * suite (kept green + untouched). The two share the same secret-boundary contract;
 * the leak sentinel `MXLOPENCODELEAK` is reused so a single grep covers both.
 *
 * Secret-free by construction: no secret crosses into the `opencode serve` child;
 * the test seeds clearly-fake secret-shaped values and the matrix asserts none reach
 * the child env, the rendered config, the tool ids, or any tool result.
 */
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import type { OpencodeClient, Part } from '@opencode-ai/sdk/v2/client';
import type { ToolResult } from '@mx-loom/registry';

import { isDaemonReachable, resolveDaemonSocket } from './_golden-harness.js';

const execFileAsync = promisify(execFile);

export const OPENCODE_E2E_ENV = 'MXL_OPENCODE_MCP_E2E';
const OPENCODE_MODE_ENV = 'MXL_OPENCODE_MCP_MODE';
const OPENCODE_BIN_ENV = 'MXL_OPENCODE_BIN';
const OPENCODE_MODEL_ENV = 'MXL_OPENCODE_MODEL';
const OPENCODE_MCP_COMMAND_ENV = 'MXL_OPENCODE_MCP_COMMAND';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const defaultCliEntry = join(repoRoot, 'packages', 'mcp', 'src', 'cli.ts');
const tsxBinCandidates = [
  join(repoRoot, 'packages', 'golden', 'node_modules', '.bin', 'tsx'),
  join(repoRoot, 'packages', 'mcp', 'node_modules', '.bin', 'tsx'),
  join(repoRoot, 'node_modules', '.bin', 'tsx'),
];

const READY_BANNER = 'opencode server listening';
const READY_URL = /on\s+(https?:\/\/\S+)/;
const SERVER_START_TIMEOUT_MS = 30_000;
const HTTP_MCP_READY_TIMEOUT_MS = 20_000;
const PORT_RANGE_START = 49152;
const PORT_RANGE_SIZE = 16384;

export type OpencodeMode = 'local' | 'remote';

export interface OpencodeFixture {
  readonly room: string;
  readonly targetAgentId: string;
  readonly tool: string;
}

/** What one OpenCode run observed — the matrix reads this, never the live server. */
export interface OpencodeScenarioResult {
  readonly mode: OpencodeMode;
  /** The exact env handed to the spawned `opencode serve` (proves the scrub). */
  readonly serverEnvKeys: readonly string[];
  /** The rendered `opencode.json` injected via OPENCODE_CONFIG_CONTENT. */
  readonly renderedConfig: string;
  /** `mcp.status()` keyed by server name → status string. */
  readonly mcpStatus: Record<string, string>;
  /** Every tool id OpenCode reports (built-in + the mx-loom MCP tools). */
  readonly toolIds: readonly string[];
  /** The T102 envelope from a model-in-loop `mx_delegate_tool` (S3), when run. */
  readonly delegate: ToolResult | null;
  /** Whether a model arm ran (`MXL_OPENCODE_MODEL` set). */
  readonly modelRan: boolean;
}

export function isOpencodeRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[OPENCODE_E2E_ENV] === '1';
}

export function requestedModes(env: NodeJS.ProcessEnv = process.env): OpencodeMode[] {
  const raw = (env[OPENCODE_MODE_ENV] ?? 'local').toLowerCase();
  if (raw === 'remote') return ['remote'];
  if (raw === 'both') return ['local', 'remote'];
  return ['local'];
}

function isTwoDaemonDeclared(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['MXL_CONFORMANCE_TWO_DAEMON'] === '1';
}

function readFixture(env: NodeJS.ProcessEnv = process.env): OpencodeFixture | null {
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

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveOpencodeBin(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env[OPENCODE_BIN_ENV];
  if (override && override.trim() !== '') return existsSync(override) ? override : null;
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (dir && isExecutableFile(join(dir, 'opencode'))) return join(dir, 'opencode');
  }
  const candidate = join(env['HOME'] ?? homedir(), '.opencode/bin/opencode');
  return isExecutableFile(candidate) ? candidate : null;
}

function resolveTsxBin(): string | null {
  return tsxBinCandidates.find((c) => existsSync(c)) ?? null;
}

function randomPort(): number {
  // `Math.random()` is unavailable inside Workflow scripts, but this is a normal
  // test module — a random high port avoids collisions across serial mode runs.
  return PORT_RANGE_START + Math.floor(Math.random() * PORT_RANGE_SIZE);
}

interface McpCommand {
  readonly bin: string;
  readonly cleanupDir: string | null;
}

function prepareMcpCommand(env: NodeJS.ProcessEnv = process.env): McpCommand {
  const configured = env[OPENCODE_MCP_COMMAND_ENV];
  if (configured && configured.trim() !== '') {
    if (!existsSync(configured)) {
      throw new Error(
        `T206 OpenCode row could not find the ${OPENCODE_MCP_COMMAND_ENV} bin at ${configured}. ` +
          'Point it at a resolvable, executable mx-loom-mcp.',
      );
    }
    return { bin: configured, cleanupDir: null };
  }
  const tsxBin = resolveTsxBin();
  if (tsxBin === null) {
    throw new Error(
      `T206 OpenCode row could not find a \`tsx\` binary (looked in ${tsxBinCandidates.join(', ')}). ` +
        `Run \`pnpm install\`, or set ${OPENCODE_MCP_COMMAND_ENV} to a runnable mx-loom-mcp bin.`,
    );
  }
  if (!existsSync(defaultCliEntry)) {
    throw new Error(`T206 OpenCode row could not find the mx-loom-mcp source entry at ${defaultCliEntry}.`);
  }
  const cleanupDir = mkdtempSync(join(tmpdir(), 'mxl-portability-opencode-launcher-'));
  const launcher = join(cleanupDir, 'mx-loom-mcp');
  writeFileSync(launcher, `#!/usr/bin/env bash\nexec ${JSON.stringify(tsxBin)} ${JSON.stringify(defaultCliEntry)} "$@"\n`);
  chmodSync(launcher, 0o755);
  return { bin: launcher, cleanupDir };
}

/**
 * Clearly-fake Boundary-A / provider / audit secrets seeded into the test process.
 * Each value carries the sentinel `MXLOPENCODELEAK` so the leak check is unambiguous.
 */
export const OPENCODE_FAKE_SECRET_ENV: Readonly<Record<string, string>> = {
  GH_TOKEN: 'ghp_fake_MXLOPENCODELEAK_not_real_123',
  MATRIX_ACCESS_TOKEN: 'syt_a_fake_MXLOPENCODELEAK_not_real',
  MX_AGENT_SECRET: 'fake_MXLOPENCODELEAK_mx_agent_secret',
  ANTHROPIC_API_KEY: 'sk-ant-fake_MXLOPENCODELEAK_not_real',
  OPENAI_API_KEY: 'sk-fake_MXLOPENCODELEAK_openai_not_real',
  DATABASE_URL: 'postgres://u:fake_MXLOPENCODELEAK_pw@db.invalid/mxloom',
};

/** The deny-by-default allowlist env for `opencode serve` — never spreads process.env. */
function scrubbedServerEnv(runtimeDir: string, configContent: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin',
    HOME: process.env['HOME'] ?? repoRoot,
    XDG_RUNTIME_DIR: runtimeDir,
    LANG: 'C',
    LC_ALL: 'C',
    TERM: 'xterm',
    OPENCODE_CONFIG_CONTENT: configContent,
  };
}

function localConfig(mcpBin: string, fixture: OpencodeFixture, correlationId: string): unknown {
  return {
    mcp: {
      'mx-loom': {
        type: 'local',
        enabled: true,
        command: [mcpBin, '--stdio', '--room', fixture.room, '--kind', 'opencode', '--correlation-id', correlationId],
        environment: { PATH: process.env['PATH'] ?? '/usr/bin', HOME: process.env['HOME'] ?? repoRoot },
      },
    },
    permission: { '*': 'allow', bash: { 'git *': 'deny', 'gh *': 'deny', '*': 'allow' } },
  };
}

function remoteConfig(url: string): unknown {
  return {
    mcp: { 'mx-loom': { type: 'remote', enabled: true, url } },
    permission: { '*': 'allow', bash: { 'git *': 'deny', 'gh *': 'deny', '*': 'allow' } },
  };
}

async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((res) => {
      const sock = connect({ host, port }, () => {
        sock.destroy();
        res(true);
      });
      sock.on('error', () => res(false));
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`mx-loom-mcp --http never listened on ${host}:${port} within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

interface RunningServer {
  readonly proc: ChildProcess;
  readonly url: string;
  readonly client: OpencodeClient;
}

function startOpencodeServer(bin: string, cwd: string, env: NodeJS.ProcessEnv): Promise<RunningServer> {
  const proc = spawn(bin, ['serve', '--hostname', '127.0.0.1', '--port', String(randomPort())], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise<RunningServer>((resolvePromise, reject) => {
    let output = '';
    let settled = false;
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (proc.exitCode === null && !proc.killed) proc.kill('SIGTERM');
      reject(new Error(message));
    };
    const timer = setTimeout(
      () => fail(`opencode serve produced no readiness banner within ${SERVER_START_TIMEOUT_MS}ms: ${output.trim()}`),
      SERVER_START_TIMEOUT_MS,
    );
    const onData = (chunk: Buffer | string): void => {
      if (settled) return;
      output += chunk.toString();
      for (const lineText of output.split('\n')) {
        if (lineText.includes(READY_BANNER)) {
          const match = READY_URL.exec(lineText);
          if (match === null) return fail(`could not parse the server url from: ${lineText.trim()}`);
          settled = true;
          clearTimeout(timer);
          const url = match[1]!;
          return resolvePromise({ proc, url, client: createOpencodeClient({ baseUrl: url }) });
        }
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('error', (err) => fail(`failed to spawn opencode: ${String(err)}`));
    proc.on('exit', (code) => fail(`opencode serve exited with code ${String(code)} before ready: ${output.trim()}`));
  });
}

function killProc(proc: ChildProcess | null): void {
  if (proc !== null && proc.exitCode === null && !proc.killed) proc.kill('SIGTERM');
}

function envelopeFromToolPart(part: Extract<Part, { type: 'tool' }>): ToolResult | null {
  const candidates: unknown[] = [];
  const state = part.state as { output?: unknown; metadata?: Record<string, unknown> };
  if (typeof state.output === 'string') candidates.push(state.output);
  if (state.metadata) {
    candidates.push(state.metadata['structuredContent'], state.metadata['output'], state.metadata);
  }
  for (let candidate of candidates) {
    if (typeof candidate === 'string') {
      try {
        candidate = JSON.parse(candidate);
      } catch {
        continue;
      }
    }
    if (candidate !== null && typeof candidate === 'object' && 'status' in candidate) {
      return candidate as ToolResult;
    }
  }
  return null;
}

export interface OpencodePrereqs {
  readonly fixture: OpencodeFixture;
  readonly opencodeBin: string;
  readonly mcp: McpCommand;
  readonly runtimeDir: string;
}

async function commandWorks(command: string, args: readonly string[]): Promise<boolean> {
  try {
    await execFileAsync(command, [...args], { timeout: 15_000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fail-not-skip prereqs for the OpenCode row. Throws (→ red) when the row is
 * requested but the two-daemon fixture, daemon A's socket, the `opencode` binary,
 * or a runnable `mx-loom-mcp` is missing.
 */
export async function assertOpencodePrereqs(): Promise<OpencodePrereqs> {
  if (!isTwoDaemonDeclared()) {
    throw new Error(
      'T206 OpenCode row was requested, but MXL_CONFORMANCE_TWO_DAEMON=1 is not set. Bring up the ' +
        'two-daemon fixture (daemon A + B) or unset the OpenCode opt-in for a clean skip.',
    );
  }
  if (!isDaemonReachable()) {
    throw new Error(
      `T206 OpenCode row was requested, but no mx-agent daemon is reachable at ${resolveDaemonSocket()}. ` +
        'It must fail, not skip, when the fixture is declared but daemon A is unreachable.',
    );
  }
  const fixture = readFixture();
  if (fixture === null) {
    throw new Error(
      'T206 OpenCode row fixture coordinates are incomplete. Expected MXL_CONFORMANCE_ROOM, ' +
        'MXL_CONFORMANCE_TARGET_AGENT, and MXL_CONFORMANCE_TOOL from the daemon bring-up.',
    );
  }
  const runtimeDir = runtimeDirFromSocket(resolveDaemonSocket());
  if (runtimeDir === null) {
    throw new Error(
      'T206 OpenCode row needs daemon A at $XDG_RUNTIME_DIR/mx-agent/daemon.sock so the OpenCode-spawned ' +
        `mx-loom-mcp child can resolve it via the scrubbed env. Got: ${resolveDaemonSocket()}`,
    );
  }
  const opencodeBin = resolveOpencodeBin();
  if (opencodeBin === null) {
    throw new Error(
      `T206 OpenCode row could not resolve the \`opencode\` binary. Set ${OPENCODE_BIN_ENV} or add opencode to PATH.`,
    );
  }
  if (!(await commandWorks(opencodeBin, ['--version']))) {
    throw new Error(`T206 OpenCode row could not run \`${opencodeBin} --version\`.`);
  }
  return { fixture, opencodeBin, mcp: prepareMcpCommand(), runtimeDir };
}

/** Opt-in model arm: prompt an OpenCode agent to call mx_delegate_tool and read the envelope. */
async function driveDelegate(
  client: OpencodeClient,
  cwd: string,
  model: string,
  fixture: OpencodeFixture,
  correlationId: string,
): Promise<ToolResult | null> {
  const slash = model.indexOf('/');
  const modelRoute = slash > 0 ? { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) } : undefined;
  const created = await client.session.create({ directory: cwd, title: `t206 opencode ${correlationId}` });
  const sessionID = created.data?.id;
  if (sessionID === undefined) return null;
  const prompt =
    `Call the tool mx_delegate_tool exactly once with these arguments and then stop: ` +
    `agent="${fixture.targetAgentId}", tool="${fixture.tool}", args={"package":"mx-loom-portability-e2e"}, ` +
    `idempotency_key="opencode-portability-${correlationId}". Do not include any credentials.`;
  const res = await client.session.prompt({
    sessionID,
    directory: cwd,
    ...(modelRoute ? { model: modelRoute } : {}),
    parts: [{ type: 'text', text: prompt }],
  });
  for (const part of res.data?.parts ?? []) {
    if (part.type === 'tool' && part.tool.includes('mx_delegate_tool') && part.state.status === 'completed') {
      const envelope = envelopeFromToolPart(part as Extract<Part, { type: 'tool' }>);
      if (envelope !== null) return envelope;
    }
  }
  return null;
}

/**
 * Run ONE OpenCode mode end to end for the matrix: render the config, start
 * `opencode serve` from the scrubbed env, capture `mcp.status` + `tool.ids`, and
 * (when `MXL_OPENCODE_MODEL` is set) drive the S3 `mx_delegate_tool` arm. The
 * launcher temp dir (if any) is cleaned by {@link cleanupOpencode}.
 */
export async function runOpencodeScenario(
  mode: OpencodeMode,
  pre: OpencodePrereqs,
  correlationId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OpencodeScenarioResult> {
  const cwd = mkdtempSync(join(tmpdir(), `mxl-portability-opencode-${mode}-`));
  let httpProc: ChildProcess | null = null;
  let server: RunningServer | null = null;
  try {
    let config: unknown;
    if (mode === 'local') {
      config = localConfig(pre.mcp.bin, pre.fixture, correlationId);
    } else {
      const port = randomPort();
      httpProc = spawn(
        pre.mcp.bin,
        ['--http', '--host', '127.0.0.1', '--port', String(port), '--room', pre.fixture.room, '--kind', 'opencode', '--correlation-id', correlationId],
        { cwd, env: scrubbedServerEnv(pre.runtimeDir, ''), stdio: ['ignore', 'pipe', 'pipe'] },
      );
      await waitForPort('127.0.0.1', port, HTTP_MCP_READY_TIMEOUT_MS);
      config = remoteConfig(`http://127.0.0.1:${port}`);
    }

    const renderedConfig = JSON.stringify(config);
    const serverEnv = scrubbedServerEnv(pre.runtimeDir, renderedConfig);
    server = await startOpencodeServer(pre.opencodeBin, cwd, serverEnv);

    const statusRes = await server.client.mcp.status({ directory: cwd });
    const mcpStatus: Record<string, string> = {};
    for (const [name, value] of Object.entries(statusRes.data ?? {})) {
      mcpStatus[name] = (value as { status?: string }).status ?? 'unknown';
    }

    const idsRes = await server.client.tool.ids({ directory: cwd });
    const toolIds = (idsRes.data ?? []) as string[];

    let delegate: ToolResult | null = null;
    const model = env[OPENCODE_MODEL_ENV];
    const modelRan = Boolean(model && model.trim() !== '');
    if (modelRan) {
      delegate = await driveDelegate(server.client, cwd, model!, pre.fixture, correlationId);
    }

    return { mode, serverEnvKeys: Object.keys(serverEnv), renderedConfig, mcpStatus, toolIds, delegate, modelRan };
  } finally {
    killProc(server?.proc ?? null);
    killProc(httpProc);
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** Remove the generated mx-loom-mcp launcher temp dir, if one was created. */
export function cleanupOpencode(pre: OpencodePrereqs | null): void {
  if (pre?.mcp.cleanupDir != null) rmSync(pre.mcp.cleanupDir, { recursive: true, force: true });
}
