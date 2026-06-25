/**
 * Shared Pi TypeBox-builder resolution (T206 / #28).
 *
 * Both the T205 Pi binding e2e (`t205-pi-binding.e2e.test.ts`) and the T206 Pi
 * portability arm (`createGoldenPiArm` in `_golden-harness.ts`, driven by
 * `portability-matrix.e2e.test.ts`) need the same builder-resolution policy:
 * prefer the **real** Pi TypeBox (`typebox` + `@earendil-works/pi-ai`'s
 * `StringEnum`) resolved from an installed Pi tree, falling back to an inline
 * ABI-shaped shim when Pi is not installed. The daemon round-trip is identical
 * either way; preferring real Pi additionally exercises the Google-safe
 * `StringEnum` schema-adapter path. Factoring it here keeps one copy (no drift)
 * and is a non-test module (leading underscore, no `.test.ts`).
 *
 * This module holds no secret and starts no process. It only resolves a package
 * root and dynamically imports TypeBox from Pi's own tree (so a single TypeBox
 * runtime builds every schema — Pi's `[Kind]`-symbol identity check at
 * registration cannot fail on a split copy).
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { TypeBoxBuilders } from '@mx-loom/pi';

/** Env var that points at an installed `@earendil-works/pi-coding-agent` package root. */
export const PI_PACKAGE_ROOT_ENV = 'MXL_PI_PACKAGE_ROOT';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const packageRequire = createRequire(resolve(repoRoot, 'package.json'));

/** Where the Pi package root was resolved from (or that it is absent). */
export interface ResolvedPiPackage {
  readonly root: string | null;
  readonly source: 'env' | 'workspace-dependency' | 'absent';
}

/**
 * Resolve the `@earendil-works/pi-coding-agent` package root.
 * Priority: `MXL_PI_PACKAGE_ROOT` → a workspace-resolvable dependency → absent.
 * (Mirrors `t204-pi-capability.e2e.test.ts` / the pre-T206 `t205` resolver.)
 */
export function resolvePiPackageRoot(env: NodeJS.ProcessEnv = process.env): ResolvedPiPackage {
  const explicit = env[PI_PACKAGE_ROOT_ENV];
  if (explicit !== undefined && explicit.trim() !== '') {
    return { root: resolve(explicit), source: 'env' };
  }
  try {
    const entry = packageRequire.resolve('@earendil-works/pi-coding-agent');
    let dir = dirname(entry);
    while (dir !== dirname(dir)) {
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest)) {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name: string };
        if (parsed.name === '@earendil-works/pi-coding-agent') {
          return { root: dir, source: 'workspace-dependency' };
        }
      }
      dir = dirname(dir);
    }
  } catch {
    // Pi not installed — acceptable for the clean-skip path.
  }
  return { root: null, source: 'absent' };
}

function resolveDependencyEntry(root: string, packageName: string, relativeEntry: string): string | null {
  const segments = packageName.split('/');
  let dir = root;
  for (;;) {
    const candidate = join(dir, 'node_modules', ...segments, relativeEntry);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

interface TypeBoxRuntime {
  readonly Type: {
    Object(properties: Record<string, unknown>, options?: Record<string, unknown>): unknown;
    Optional(schema: unknown): unknown;
    String(options?: Record<string, unknown>): unknown;
    Integer(options?: Record<string, unknown>): unknown;
    Number(options?: Record<string, unknown>): unknown;
    Boolean(options?: Record<string, unknown>): unknown;
    Array(items: unknown, options?: Record<string, unknown>): unknown;
  };
}
interface PiAiRuntime {
  StringEnum(values: readonly string[], options?: Record<string, unknown>): unknown;
}

async function importTypebox(root: string): Promise<TypeBoxRuntime> {
  const requireFromPi = createRequire(join(root, 'package.json'));
  return (await import(pathToFileURL(requireFromPi.resolve('typebox')).href)) as TypeBoxRuntime;
}

async function importPiAi(root: string): Promise<PiAiRuntime> {
  const entry = resolveDependencyEntry(root, '@earendil-works/pi-ai', join('dist', 'index.js'));
  if (entry === null) {
    throw new Error('Pi builders: cannot find @earendil-works/pi-ai/dist/index.js from the Pi package root');
  }
  return (await import(pathToFileURL(entry).href)) as PiAiRuntime;
}

// ---------------------------------------------------------------------------
// Inline fake TypeBox builders (ABI-shaped shim, mirrors pi/test/helpers.ts).
// Used when Pi SDK is not installed but the daemon-call path still runs — the
// daemon round-trip is identical regardless of which builders are used.
// ---------------------------------------------------------------------------

const OPTIONAL = Symbol('optional');

export const INLINE_FAKE_BUILDERS: TypeBoxBuilders = {
  Type: {
    Object(properties, options = {}) {
      const required = Object.entries(properties)
        .filter(([, schema]) => !(schema as Record<symbol, unknown>)[OPTIONAL])
        .map(([key]) => key);
      return { type: 'object', properties, ...(required.length > 0 ? { required } : {}), ...options };
    },
    Optional(schema) {
      return { ...(schema as Record<string, unknown>), [OPTIONAL]: true };
    },
    String(options = {}) {
      return { type: 'string', ...options };
    },
    Integer(options = {}) {
      return { type: 'integer', ...options };
    },
    Number(options = {}) {
      return { type: 'number', ...options };
    },
    Boolean(options = {}) {
      return { type: 'boolean', ...options };
    },
    Array(items, options = {}) {
      return { type: 'array', items, ...options };
    },
  },
  StringEnum(values, options = {}) {
    return { type: 'string', enum: [...values], ...options };
  },
};

/** Which builder set was selected — surfaced so a run can `log()` it (no silent degradation). */
export interface ResolvedPiBuilders {
  readonly builders: TypeBoxBuilders;
  readonly source: 'pi-typebox' | 'inline-fake';
  readonly packageRoot: string | null;
}

/**
 * Resolve the TypeBox builders: real Pi TypeBox when a package root is present,
 * else the inline ABI shim. Returns which was used so the caller can record it
 * (the spec's OQ4 recommendation: prefer real, accept shim, log which).
 */
export async function resolvePiBuilders(
  resolved: ResolvedPiPackage = resolvePiPackageRoot(),
): Promise<ResolvedPiBuilders> {
  if (resolved.root !== null) {
    const { Type } = await importTypebox(resolved.root);
    const { StringEnum } = await importPiAi(resolved.root);
    return { builders: { Type, StringEnum } as TypeBoxBuilders, source: 'pi-typebox', packageRoot: resolved.root };
  }
  return { builders: INLINE_FAKE_BUILDERS, source: 'inline-fake', packageRoot: null };
}
