/**
 * T204 / #26 Pi capability e2e smoke.
 *
 * This is not the future T205 `@mx-loom/pi` binding. It is the smallest live
 * check that the T204 decision was grounded in the real Pi runtime surface:
 *   - Pi exposes native tools through `customTools` and extension `registerTool()`;
 *   - those native tools become active `AgentTool`s and execute through Pi's own
 *     wrapper without a model call, provider key, Matrix credential, or daemon;
 *   - the installed Pi CLI/docs still have no built-in MCP mount surface.
 *
 * Gating mirrors the golden suite style:
 *   - no local Pi package and no `MXL_PI_CAPABILITY_E2E=1` → clean skip;
 *   - `MXL_PI_CAPABILITY_E2E=1` (or an explicit `MXL_PI_PACKAGE_ROOT`) with an
 *     invalid/missing Pi install → hard failure, never a misleading green.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { CANONICAL_M1_TOOLS, isForbiddenAuthorityVerb } from '@mx-loom/registry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SECRET_PATTERN } from './_golden-harness.js';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const packageRequire = createRequire(resolve(repoRoot, 'package.json'));

const PI_CAPABILITY_ENV = 'MXL_PI_CAPABILITY_E2E';
const PI_PACKAGE_ROOT_ENV = 'MXL_PI_PACKAGE_ROOT';

interface ResolvedPiPackage {
  readonly root: string | null;
  readonly source: 'env' | 'workspace-dependency' | 'absent';
}

interface PiPrereqInput {
  readonly required: boolean;
  readonly packageRoot: string | null;
}

interface PiPackageJson {
  readonly name: string;
  readonly version: string;
  readonly engines?: { readonly node?: string };
  readonly dependencies?: Record<string, string>;
  readonly bin?: Record<string, string>;
}

interface PiToolResult {
  readonly content: Array<{ readonly type: string; readonly text?: string }>;
  readonly details?: unknown;
  readonly terminate?: boolean;
}

interface PiAgentTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
  execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<PiToolResult>;
}

interface PiSession {
  readonly agent: { readonly state: { readonly tools: readonly PiAgentTool[] } };
  dispose(): void;
}

interface PiRuntime {
  readonly VERSION?: string;
  createAgentSession(options?: Record<string, unknown>): Promise<{ readonly session: PiSession }>;
  defineTool(tool: Record<string, unknown>): unknown;
  readonly DefaultResourceLoader: new (options?: Record<string, unknown>) => { reload(): Promise<void> };
  readonly SessionManager: { inMemory(cwd?: string): unknown };
  readonly SettingsManager: { inMemory(settings?: Record<string, unknown>): unknown };
}

interface TypeboxRuntime {
  readonly Type: {
    Object(properties: Record<string, unknown>, options?: Record<string, unknown>): unknown;
    Optional(schema: unknown): unknown;
    String(options?: Record<string, unknown>): unknown;
  };
}

interface PiAiRuntime {
  StringEnum(values: readonly string[]): unknown;
}

function resolvePiPackageRoot(env: NodeJS.ProcessEnv = process.env): ResolvedPiPackage {
  const explicit = env[PI_PACKAGE_ROOT_ENV];
  if (explicit !== undefined && explicit.trim() !== '') {
    return { root: resolve(explicit), source: 'env' };
  }

  try {
    const entry = packageRequire.resolve('@earendil-works/pi-coding-agent');
    // Package entry is normally <root>/dist/index.js. Walk up until the package
    // manifest is found so this also works if Pi changes its entry file later.
    let dir = dirname(entry);
    while (dir !== dirname(dir)) {
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest)) {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as PiPackageJson;
        if (parsed.name === '@earendil-works/pi-coding-agent') {
          return { root: dir, source: 'workspace-dependency' };
        }
      }
      dir = dirname(dir);
    }
  } catch {
    // Optional upstream runtime dependency is absent from this workspace, which
    // is the common local/CI case until T205 adds a real package dependency.
  }

  return { root: null, source: 'absent' };
}

function piCapabilityPrereqError(input: PiPrereqInput): Error | null {
  if (input.packageRoot === null) {
    if (!input.required) return null;
    return new Error(
      'T204 Pi capability e2e was requested with MXL_PI_CAPABILITY_E2E=1, but no ' +
        '@earendil-works/pi-coding-agent package root was found. Set MXL_PI_PACKAGE_ROOT to an ' +
        'installed Pi package root (for example the directory containing Pi package.json), or unset ' +
        'MXL_PI_CAPABILITY_E2E for a clean local skip.',
    );
  }

  const manifest = join(input.packageRoot, 'package.json');
  const cli = join(input.packageRoot, 'dist', 'cli.js');
  const index = join(input.packageRoot, 'dist', 'index.js');
  for (const path of [manifest, cli, index]) {
    if (!existsSync(path)) {
      return new Error(`T204 Pi capability e2e package root is incomplete: missing ${path}`);
    }
  }
  return null;
}

function readPiFile(root: string, relativePath: string): string {
  return readFileSync(join(root, relativePath), 'utf8');
}

function readPiPackageJson(root: string): PiPackageJson {
  return JSON.parse(readPiFile(root, 'package.json')) as PiPackageJson;
}

/**
 * Deterministically extract one real canonical string-enum value-set from the
 * registry descriptors (breadth-first; verbs in canonical order; input before
 * output). This is the value-set the Pi binding (T205) must emit as `StringEnum`
 * for Google-provider compatibility (decision doc Risk #3). The e2e threads this
 * genuine registry value-set through the live Pi schema — not a synthetic one — so
 * the registry <-> Pi-runtime boundary is actually exercised. Throws
 * (fail-not-skip) if the registry no longer declares any string enum, since that
 * would mean the decision record's StringEnum/Google-compat claim is ungrounded.
 */
function firstCanonicalStringEnum(): readonly string[] {
  function scan(schema: unknown): readonly string[] | null {
    const queue: unknown[] = [schema];
    while (queue.length > 0) {
      const node = queue.shift();
      if (node === null || typeof node !== 'object') continue;
      const record = node as Record<string, unknown>;
      const enumValue = record['enum'];
      if (Array.isArray(enumValue) && enumValue.every((value) => typeof value === 'string')) {
        return enumValue as string[];
      }
      const properties = record['properties'];
      if (properties !== null && typeof properties === 'object') {
        for (const value of Object.values(properties as Record<string, unknown>)) queue.push(value);
      }
      if (record['items'] !== undefined) queue.push(record['items']);
    }
    return null;
  }
  for (const descriptor of CANONICAL_M1_TOOLS) {
    const fromInput = scan(descriptor.input_schema);
    if (fromInput) return fromInput;
    const fromOutput = scan(descriptor.output_schema);
    if (fromOutput) return fromOutput;
  }
  throw new Error(
    'T204 Pi capability e2e: no string enum found in CANONICAL_M1_TOOLS — the decision ' +
      "record's StringEnum/Google-compatibility claim (Risk #3) is no longer grounded by the registry.",
  );
}

async function importPiRuntime(root: string): Promise<PiRuntime> {
  return (await import(pathToFileURL(join(root, 'dist', 'index.js')).href)) as PiRuntime;
}

async function importTypebox(root: string): Promise<TypeboxRuntime> {
  const requireFromPi = createRequire(join(root, 'package.json'));
  return (await import(pathToFileURL(requireFromPi.resolve('typebox')).href)) as TypeboxRuntime;
}

function resolveDependencyEntry(root: string, packageName: string, relativeEntry: string): string | null {
  const segments = packageName.split('/');
  let dir = root;
  while (true) {
    const candidate = join(dir, 'node_modules', ...segments, relativeEntry);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function importPiAi(root: string): Promise<PiAiRuntime> {
  // Some Pi installs do not allow CJS require.resolve('@earendil-works/pi-ai')
  // because of package exports, so locate the dependency entry by walking through
  // node_modules roots from the provided Pi package. This works for nested and
  // hoisted installs while still staying under the operator-provided runtime tree.
  const entry = resolveDependencyEntry(root, '@earendil-works/pi-ai', join('dist', 'index.js'));
  if (entry === null) {
    throw new Error(
      'T204 Pi capability e2e cannot find @earendil-works/pi-ai/dist/index.js from the Pi package root',
    );
  }
  return (await import(pathToFileURL(entry).href)) as PiAiRuntime;
}

function makeSafePiEnv(tmp: string): NodeJS.ProcessEnv {
  // Intentionally do not spread process.env: the Pi subprocess gets no provider
  // keys, no GH_TOKEN, no Matrix/MX-Agent credentials, and runs fully offline.
  return {
    PATH: process.env['PATH'] ?? '',
    HOME: tmp,
    TMPDIR: tmp,
    PI_CODING_AGENT_DIR: join(tmp, 'agent'),
    PI_CODING_AGENT_SESSION_DIR: join(tmp, 'sessions'),
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    NO_COLOR: '1',
  };
}

const resolvedPi = resolvePiPackageRoot();
const piCapabilityRequired =
  process.env[PI_CAPABILITY_ENV] === '1' ||
  (process.env[PI_PACKAGE_ROOT_ENV] !== undefined && process.env[PI_PACKAGE_ROOT_ENV]!.trim() !== '');
const skipPiCapability = !piCapabilityRequired && resolvedPi.root === null;

describe.skipIf(skipPiCapability)('T204 e2e · Pi tool-surface capability (native vs MCP)', () => {
  let piRoot = '';
  let tmp = '';

  beforeAll(() => {
    const err = piCapabilityPrereqError({ required: piCapabilityRequired, packageRoot: resolvedPi.root });
    if (err) throw err;
    if (resolvedPi.root === null) throw new Error('T204 Pi capability e2e: resolved package root unexpectedly absent');
    piRoot = resolvedPi.root;
    tmp = mkdtempSync(join(tmpdir(), 'mxl-t204-pi-'));
  });

  afterAll(() => {
    if (tmp !== '') rmSync(tmp, { recursive: true, force: true });
  });

  it('installed Pi evidence still says: no built-in MCP; native tools are first-class', async () => {
    const pkg = readPiPackageJson(piRoot);
    expect(pkg.name).toBe('@earendil-works/pi-coding-agent');
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(pkg.bin?.['pi']).toBe('dist/cli.js');
    expect(pkg.dependencies).toHaveProperty('typebox');
    expect(pkg.dependencies).toHaveProperty('@earendil-works/pi-ai');

    const readme = readPiFile(piRoot, 'README.md');
    const usage = readPiFile(piRoot, 'docs/usage.md');
    const sdk = readPiFile(piRoot, 'docs/sdk.md');
    const extensions = readPiFile(piRoot, 'docs/extensions.md');
    const indexDts = readPiFile(piRoot, 'dist/index.d.ts');
    const sdkDts = readPiFile(piRoot, 'dist/core/sdk.d.ts');

    expect(readme).toContain('**No MCP.**');
    expect(usage).toContain('intentionally does not include built-in MCP');
    expect(sdk).toContain('customTools: [myTool]');
    expect(sdk).toContain('defineTool');
    expect(extensions).toContain('pi.registerTool');
    expect(extensions).toContain('Use `StringEnum` from `@earendil-works/pi-ai`');
    expect(sdkDts).toContain('customTools?: ToolDefinition[]');
    expect(indexDts).toContain('ToolDefinition');
    expect(indexDts).toContain('AgentToolResult');
    expect(indexDts).toContain('defineTool');

    const { stdout, stderr } = await execFileAsync(process.execPath, [join(piRoot, 'dist', 'cli.js'), '--help'], {
      env: makeSafePiEnv(tmp),
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const help = `${stdout}\n${stderr}`;
    expect(help).toContain('--mode <mode>');
    expect(help).toContain('--tools');
    expect(help).toContain('--no-builtin-tools');
    expect(help).toContain('--extension');
    expect(help).not.toMatch(/--mcp\b/i);
    expect(help).not.toMatch(/mcpServers/i);
  });

  it('registers and executes native Pi tools through SDK customTools and extension registerTool without MCP', async () => {
    const pi = await importPiRuntime(piRoot);
    const { Type } = await importTypebox(piRoot);
    const { StringEnum } = await importPiAi(piRoot);
    // A REAL canonical registry enum value-set (e.g. mx_find_agents.liveness).
    const canonicalEnum = firstCanonicalStringEnum();
    expect(canonicalEnum.length).toBeGreaterThan(0);

    expect(typeof pi.createAgentSession).toBe('function');
    expect(typeof pi.defineTool).toBe('function');
    expect(typeof pi.DefaultResourceLoader).toBe('function');
    expect(Object.keys(pi).filter((key) => /mcp/i.test(key))).toEqual([]);

    const settingsManager = pi.SettingsManager.inMemory({});
    const customTool = pi.defineTool({
      name: 'mxl_t204_custom_probe',
      label: 'mx-loom T204 customTools probe',
      description: 'Probe native Pi SDK customTools registration for the mx-loom T204 decision.',
      promptSnippet: 'Use mxl_t204_custom_probe only for the mx-loom T204 native-registration smoke test.',
      promptGuidelines: [
        'Use mxl_t204_custom_probe only for the mx-loom T204 native-registration smoke test.',
      ],
      parameters: Type.Object({
        mode: StringEnum(['custom', 'extension']),
        message: Type.String({ description: 'Secret-free message to echo.' }),
        // Real canonical registry enum carried through the live Pi StringEnum path.
        liveness: StringEnum(canonicalEnum),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>): Promise<PiToolResult> {
        return {
          content: [{ type: 'text', text: `custom:${String(params['mode'])}:${String(params['message'])}` }],
          details: { source: 'customTools', mode: params['mode'], message: params['message'] },
        };
      },
    });

    const extensionTool = {
      name: 'mxl_t204_extension_probe',
      label: 'mx-loom T204 extension probe',
      description: 'Probe native Pi extension registerTool registration for the mx-loom T204 decision.',
      promptSnippet: 'Use mxl_t204_extension_probe only for the mx-loom T204 native-registration smoke test.',
      promptGuidelines: [
        'Use mxl_t204_extension_probe only for the mx-loom T204 native-registration smoke test.',
      ],
      parameters: Type.Object({
        mode: StringEnum(['custom', 'extension']),
        message: Type.String({ description: 'Secret-free message to echo.' }),
        optional_note: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>): Promise<PiToolResult> {
        return {
          content: [{ type: 'text', text: `extension:${String(params['mode'])}:${String(params['message'])}` }],
          details: { source: 'extension', mode: params['mode'], note: params['optional_note'] ?? null },
        };
      },
    };

    const loader = new pi.DefaultResourceLoader({
      cwd: tmp,
      agentDir: join(tmp, 'agent'),
      settingsManager,
      extensionFactories: [
        (api: { registerTool(tool: unknown): void }) => {
          api.registerTool(extensionTool);
        },
      ],
    });
    await loader.reload();

    const { session } = await pi.createAgentSession({
      cwd: tmp,
      agentDir: join(tmp, 'agent'),
      noTools: 'builtin',
      tools: ['mxl_t204_custom_probe', 'mxl_t204_extension_probe'],
      customTools: [customTool],
      resourceLoader: loader,
      sessionManager: pi.SessionManager.inMemory(tmp),
      settingsManager,
    });

    try {
      const tools = [...session.agent.state.tools];
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        ['mxl_t204_custom_probe', 'mxl_t204_extension_probe'].sort(),
      );
      for (const tool of tools) {
        expect(isForbiddenAuthorityVerb(tool.name), `authority tool leaked into Pi native surface: ${tool.name}`).toBe(
          false,
        );
        const schema = tool.parameters as { readonly properties?: Record<string, { readonly enum?: readonly string[] }> };
        expect(schema.properties?.['mode']?.enum).toEqual(['custom', 'extension']);
      }

      const custom = tools.find((tool) => tool.name === 'mxl_t204_custom_probe');
      const extension = tools.find((tool) => tool.name === 'mxl_t204_extension_probe');
      if (!custom || !extension) throw new Error('T204 Pi native probe tools were not registered');

      // Risk #3 grounding: a REAL canonical registry enum value-set must survive
      // StringEnum -> live Pi TypeBox registration in the Google-compatible shape
      // ({ type: 'string', enum: [...] }) — NOT a Type.Union/oneOf — because that is
      // exactly the descriptor->Pi mapping T205 depends on for Google-provider runs.
      const customSchema = custom.parameters as {
        readonly properties?: Record<string, { readonly type?: string; readonly enum?: readonly string[] }>;
      };
      expect(customSchema.properties?.['liveness']?.type).toBe('string');
      expect(customSchema.properties?.['liveness']?.enum).toEqual(canonicalEnum);
      expect(JSON.stringify(customSchema.properties?.['liveness'])).not.toMatch(/oneOf|anyOf|allOf|const/);

      const customResult = await custom.execute('mxl-t204-custom-call', {
        mode: 'custom',
        message: 'native-registration',
        liveness: canonicalEnum[0],
      });
      const extensionResult = await extension.execute('mxl-t204-extension-call', {
        mode: 'extension',
        message: 'native-registration',
        optional_note: 'StringEnum path exercised',
      });

      expect(customResult.content[0]?.text).toBe('custom:custom:native-registration');
      expect(customResult.details).toEqual({
        source: 'customTools',
        mode: 'custom',
        message: 'native-registration',
      });
      expect(extensionResult.content[0]?.text).toBe('extension:extension:native-registration');
      expect(extensionResult.details).toEqual({
        source: 'extension',
        mode: 'extension',
        note: 'StringEnum path exercised',
      });
      expect(JSON.stringify({ customResult, extensionResult })).not.toMatch(SECRET_PATTERN);
    } finally {
      session.dispose();
    }
  });
});
