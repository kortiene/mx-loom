/**
 * T203 / #25 OpenCode `mcp` server-entry end-to-end acceptance.
 *
 * Target behavior: OpenCode mounts the generated `mx-loom-mcp` server from
 * `opencode.json` (local stdio AND remote Streamable HTTP), surfaces the canonical
 * `mx_*` tools to its agents, and an OpenCode agent calls `mx_delegate_tool`
 * through the configured server. The M2 OpenCode acceptance slice the M1 golden
 * gate cannot cover: OpenCode runtime → MCP (stdio | HTTP) → mx-loom-mcp → live
 * `mx-agent` daemon A → daemon B.
 *
 * Deterministic core (no provider/model call): OpenCode reports MCP status and the
 * registered tool ids over its HTTP API without invoking a model, so the default
 * arm proves *surfacing* — `mx-loom` connects and exactly the canonical `mx_*`
 * tools appear, with no authority verb — for both local and remote entries.
 *
 * The acceptance criterion's "an OpenCode agent calls `mx_delegate_tool`" requires
 * a model in the loop (OpenCode exposes no model-free tool-call surface). That arm
 * is opt-in behind `MXL_OPENCODE_MODEL` and drives a real `session.prompt`, then
 * validates the returned T102 envelope. Without it, the actual delegation
 * round-trip stays covered by the golden MCP arm (T114) and the ADK arm (T201),
 * which exercise the same `@mx-loom/mcp` server programmatically.
 *
 * Secret boundary: the `opencode serve` child is spawned with a deny-by-default,
 * EXPLICIT allowlist env (never `...process.env`), exactly as the recipe mandates —
 * OpenCode's per-server `environment` only ADDS, it does not reset, so the
 * load-bearing scrub is the OpenCode process env. The test seeds the parent process
 * with clearly-fake secret-shaped values and asserts neither the scrubbed child env,
 * the rendered config, the tool ids, nor any tool result echoes them. The SDK's own
 * `createOpencodeServer` is deliberately NOT used (it spreads the full parent env
 * onto the child — the exact leak this boundary prevents).
 *
 * Gating:
 *   - clean skip unless `MXL_OPENCODE_MCP_E2E=1`;
 *   - fail-not-skip when requested but the two-daemon fixture, daemon A's socket,
 *     the `opencode` binary, or a runnable `mx-loom-mcp` command is missing;
 *   - `MXL_OPENCODE_MCP_MODE=local|remote|both` (default `both`).
 */
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import type { OpencodeClient, Part } from '@opencode-ai/sdk/v2/client';
import { CANONICAL_M1_TOOLS, isForbiddenAuthorityVerb, validateEnvelope } from '@mx-loom/registry';
import type { ToolResult } from '@mx-loom/registry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SECRET_PATTERN, isDaemonReachable, resolveDaemonSocket } from './_golden-harness.js';

const execFileAsync = promisify(execFile);

const OPENCODE_E2E_ENV = 'MXL_OPENCODE_MCP_E2E';
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

type Mode = 'local' | 'remote';

interface OpencodeFixture {
  readonly room: string;
  readonly targetAgentId: string;
  readonly tool: string;
}

/** What one mode's run observed — the assertions read this, never the live server. */
interface ModeProbe {
  readonly mode: Mode;
  /** The exact env handed to the spawned `opencode serve` (proves the scrub). */
  readonly serverEnvKeys: readonly string[];
  /** The rendered `opencode.json` text injected via OPENCODE_CONFIG_CONTENT. */
  readonly renderedConfig: string;
  /** `mcp.status()` keyed by server name → status string. */
  readonly mcpStatus: Record<string, string>;
  /** Every tool id OpenCode reports (built-in + the mx-loom MCP tools). */
  readonly toolIds: readonly string[];
  /** The T102 envelope from a model-in-loop `mx_delegate_tool` call, when run. */
  readonly delegate: ToolResult | null;
}

function isRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[OPENCODE_E2E_ENV] === '1';
}

function requestedModes(env: NodeJS.ProcessEnv = process.env): Mode[] {
  const raw = (env[OPENCODE_MODE_ENV] ?? 'both').toLowerCase();
  if (raw === 'local') return ['local'];
  if (raw === 'remote') return ['remote'];
  return ['local', 'remote'];
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

/** Resolve the `opencode` binary (MXL_OPENCODE_BIN → PATH → ~/.opencode/bin). */
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
  return PORT_RANGE_START + Math.floor(Math.random() * PORT_RANGE_SIZE);
}

interface McpCommand {
  /** Argv[0]: the executable OpenCode (local) / the test (remote) spawns. */
  readonly bin: string;
  /** A temp dir holding a generated launcher (removed on teardown), or null. */
  readonly cleanupDir: string | null;
}

/**
 * Resolve the `mx-loom-mcp` command. With MXL_OPENCODE_MCP_COMMAND set, use that bin
 * verbatim; otherwise generate a launcher that execs `tsx src/cli.ts "$@"` (the
 * proven in-repo subprocess path — `dist/cli.js` is not standalone-runnable here).
 */
function prepareMcpCommand(env: NodeJS.ProcessEnv = process.env): McpCommand {
  const configured = env[OPENCODE_MCP_COMMAND_ENV];
  if (configured && configured.trim() !== '') {
    if (!existsSync(configured)) {
      throw new Error(
        `T203 OpenCode e2e could not find the ${OPENCODE_MCP_COMMAND_ENV} bin at ${configured}. ` +
          'Point it at a resolvable, executable mx-loom-mcp.',
      );
    }
    return { bin: configured, cleanupDir: null };
  }
  const tsxBin = resolveTsxBin();
  if (tsxBin === null) {
    throw new Error(
      `T203 OpenCode e2e could not find a \`tsx\` binary (looked in ${tsxBinCandidates.join(', ')}). ` +
        `Run \`pnpm install\`, or set ${OPENCODE_MCP_COMMAND_ENV} to a runnable mx-loom-mcp bin.`,
    );
  }
  if (!existsSync(defaultCliEntry)) {
    throw new Error(`T203 OpenCode e2e could not find the mx-loom-mcp source entry at ${defaultCliEntry}.`);
  }
  const cleanupDir = mkdtempSync(join(tmpdir(), 'mxl-opencode-launcher-'));
  const launcher = join(cleanupDir, 'mx-loom-mcp');
  writeFileSync(launcher, `#!/usr/bin/env bash\nexec ${JSON.stringify(tsxBin)} ${JSON.stringify(defaultCliEntry)} "$@"\n`);
  chmodSync(launcher, 0o755);
  return { bin: launcher, cleanupDir };
}

/**
 * Clearly-fake Boundary-A / provider / audit secrets seeded into the test process.
 * Each value carries the sentinel `MXLOPENCODELEAK` so the leak check is unambiguous.
 * The scrubbed `opencode serve` env must contain NONE of these keys, and NONE of the
 * values may appear in any OpenCode-visible output.
 */
const FAKE_SECRET_ENV: Readonly<Record<string, string>> = {
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

/** The local `opencode.json` — OpenCode spawns `mx-loom-mcp --stdio` from `command`. */
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
    // Allow MCP tool calls; keep git/gh out of the agent's reach (mirrors the ADW runner).
    permission: { '*': 'allow', bash: { 'git *': 'deny', 'gh *': 'deny', '*': 'allow' } },
  };
}

/** The remote `opencode.json` — OpenCode connects to an already-running `--http` server. */
function remoteConfig(url: string): unknown {
  return {
    mcp: { 'mx-loom': { type: 'remote', enabled: true, url } },
    permission: { '*': 'allow', bash: { 'git *': 'deny', 'gh *': 'deny', '*': 'allow' } },
  };
}

/** Wait until a TCP port accepts a connection (the `--http` server is listening). */
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

/** Spawn `opencode serve` with the scrubbed env, scrape the readiness banner. */
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
      for (const line of output.split('\n')) {
        if (line.includes(READY_BANNER)) {
          const match = READY_URL.exec(line);
          if (match === null) return fail(`could not parse the server url from: ${line.trim()}`);
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

/** Extract a T102 envelope from a completed OpenCode tool part's output/metadata. */
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

interface Prereqs {
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

async function assertPrereqs(): Promise<Prereqs> {
  if (!isTwoDaemonDeclared()) {
    throw new Error(
      `T203 OpenCode e2e was requested with ${OPENCODE_E2E_ENV}=1, but MXL_CONFORMANCE_TWO_DAEMON=1 is not set. ` +
        'Bring up the two-daemon fixture (daemon A + B) or unset the opt-in for a clean local skip.',
    );
  }
  if (!isDaemonReachable()) {
    throw new Error(
      `T203 OpenCode e2e was requested, but no mx-agent daemon is reachable at ${resolveDaemonSocket()}. ` +
        'It must fail, not skip, when the fixture is declared but daemon A is unreachable.',
    );
  }
  const fixture = readFixture();
  if (fixture === null) {
    throw new Error(
      'T203 OpenCode e2e fixture coordinates are incomplete. Expected MXL_CONFORMANCE_ROOM, ' +
        'MXL_CONFORMANCE_TARGET_AGENT, and MXL_CONFORMANCE_TOOL from the daemon bring-up.',
    );
  }
  const socketPath = resolveDaemonSocket();
  const runtimeDir = runtimeDirFromSocket(socketPath);
  if (runtimeDir === null) {
    throw new Error(
      'T203 OpenCode e2e needs daemon A at $XDG_RUNTIME_DIR/mx-agent/daemon.sock so the OpenCode-spawned ' +
        `mx-loom-mcp child can resolve it via the scrubbed env. Got: ${socketPath}`,
    );
  }
  const opencodeBin = resolveOpencodeBin();
  if (opencodeBin === null) {
    throw new Error(
      `T203 OpenCode e2e could not resolve the \`opencode\` binary. Set ${OPENCODE_BIN_ENV} or add opencode to PATH.`,
    );
  }
  if (!(await commandWorks(opencodeBin, ['--version']))) {
    throw new Error(`T203 OpenCode e2e could not run \`${opencodeBin} --version\`.`);
  }
  const mcp = prepareMcpCommand();
  return { fixture, opencodeBin, mcp, runtimeDir };
}

/** Run one mode end to end and capture everything the assertions need. */
async function runMode(mode: Mode, pre: Prereqs, correlationId: string): Promise<ModeProbe> {
  const cwd = mkdtempSync(join(tmpdir(), `mxl-opencode-${mode}-`));
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
    const model = process.env[OPENCODE_MODEL_ENV];
    if (model && model.trim() !== '') {
      delegate = await driveDelegate(server.client, cwd, model, pre.fixture, correlationId);
    }

    return {
      mode,
      serverEnvKeys: Object.keys(serverEnv),
      renderedConfig,
      mcpStatus,
      toolIds,
      delegate,
    };
  } finally {
    killProc(server?.proc ?? null);
    killProc(httpProc);
    rmSync(cwd, { recursive: true, force: true });
  }
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
  const created = await client.session.create({ directory: cwd, title: `t203 opencode ${correlationId}` });
  const sessionID = created.data?.id;
  if (sessionID === undefined) return null;
  const prompt =
    `Call the tool mx_delegate_tool exactly once with these arguments and then stop: ` +
    `agent="${fixture.targetAgentId}", tool="${fixture.tool}", args={"package":"mx-loom-opencode-e2e"}, ` +
    `idempotency_key="opencode-e2e-${correlationId}". Do not include any credentials.`;
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

const skip = !isRequested();

describe.skipIf(skip)('T203 e2e · OpenCode mounts mx-loom-mcp and surfaces/calls mx_* via MCP', () => {
  const probes = new Map<Mode, ModeProbe>();
  let launcherCleanupDir: string | null = null;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    // Seed the parent process with fake secrets so the scrub is a real assertion.
    for (const [k, v] of Object.entries(FAKE_SECRET_ENV)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    const pre = await assertPrereqs();
    launcherCleanupDir = pre.mcp.cleanupDir;
    for (const mode of requestedModes()) {
      const correlationId = `opencode-e2e-${mode}-${randomUUID()}`;
      probes.set(mode, await runMode(mode, pre, correlationId));
    }
  }, 180_000);

  afterAll(() => {
    if (launcherCleanupDir !== null) {
      rmSync(launcherCleanupDir, { recursive: true, force: true });
      launcherCleanupDir = null;
    }
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const canonicalNames = CANONICAL_M1_TOOLS.map((d) => d.name);

  it.each(requestedModes())('[%s] connects the mx-loom MCP server', (mode) => {
    const probe = probes.get(mode);
    expect(probe, `mode ${mode} did not run`).toBeTruthy();
    expect(probe!.mcpStatus['mx-loom'], `mx-loom status: ${JSON.stringify(probe!.mcpStatus)}`).toBe('connected');
  });

  it.each(requestedModes())('[%s] surfaces exactly the canonical mx_* tools, no authority verb', (mode) => {
    const probe = probes.get(mode)!;
    // OpenCode namespaces MCP tool ids by server; match the canonical tool inside each id.
    const mxToolIds = probe.toolIds.filter((id) => id.includes('mx-loom') || /(^|[_.])mx_/.test(id));
    for (const name of canonicalNames) {
      expect(
        mxToolIds.some((id) => id.includes(name)),
        `OpenCode did not surface ${name}; saw mx ids: ${JSON.stringify(mxToolIds)}`,
      ).toBe(true);
    }
    for (const id of mxToolIds) {
      const bare = id.slice(id.lastIndexOf('_') + 1);
      expect(isForbiddenAuthorityVerb(id) || isForbiddenAuthorityVerb(bare), `authority verb surfaced: ${id}`).toBe(false);
    }
    expect(JSON.stringify(probe.toolIds)).not.toMatch(SECRET_PATTERN);
  });

  it.each(requestedModes())('[%s] spawns opencode from a scrubbed env and leaks no secret', (mode) => {
    const probe = probes.get(mode)!;
    const raw = JSON.stringify({ env: probe.serverEnvKeys, config: probe.renderedConfig, ids: probe.toolIds, status: probe.mcpStatus, delegate: probe.delegate });
    for (const [key, value] of Object.entries(FAKE_SECRET_ENV)) {
      expect(probe.serverEnvKeys, `secret-shaped key reached the opencode serve env: ${key}`).not.toContain(key);
      expect(raw, `secret value for ${key} leaked into OpenCode-visible output`).not.toContain(value);
    }
    expect(raw).not.toContain('MXLOPENCODELEAK');
    expect(raw).not.toMatch(SECRET_PATTERN);
  });

  it.each(requestedModes())('[%s] (model-in-loop, opt-in) delegates via mx_delegate_tool to a valid envelope', (mode) => {
    const probe = probes.get(mode)!;
    if (probe.delegate === null) {
      // No MXL_OPENCODE_MODEL: surfacing is proven above; the delegation round-trip
      // through @mx-loom/mcp is covered by the golden (T114) + ADK (T201) arms.
      expect(process.env[OPENCODE_MODEL_ENV] ?? '').toBe('');
      return;
    }
    expect(validateEnvelope(probe.delegate)).toBe(true);
    expect(['ok', 'running', 'awaiting_approval']).toContain(probe.delegate.status);
    // Every envelope carries an audit_ref; a live `ok` delegation also carries an
    // invocation_id (the deferred states may not until resolved).
    expect(probe.delegate.audit_ref, 'envelope must carry an audit_ref').toBeTruthy();
    expect(JSON.stringify(probe.delegate)).not.toMatch(SECRET_PATTERN);
  });
});
