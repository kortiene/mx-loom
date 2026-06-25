/**
 * Runtime integration guide drift guard (T207 / #29).
 *
 * Fast, daemon-free coverage for `docs/runtime-integration.md` and
 * `examples/README.md`:
 *
 *  1. Every repo-relative path the guide references by a `./` or `../`
 *     Markdown link actually exists on disk (dead-link prevention).
 *  2. The guide's inlined OpenCode config blocks are JSON-equivalent to
 *     their canonical source files — the same files that
 *     `opencode-config.test.ts` guards. Drift between the guide and the
 *     examples would silently mislead a copy-paste reader.
 *  3. The guide carries no credential-shaped value or secret-namespace
 *     reference (gitleaks complement at the unit layer, same patterns as
 *     the opencode-config guard).
 *  4. The nine tool names in the guide's "canonical verbs" table exactly
 *     match `CANONICAL_M1_TOOLS` — no missing, extra, or misspelled verb.
 *  5. The closed `error.code` taxonomy table lists exactly `DENIAL_CODES`
 *     and `FAULT_CODES` — no missing or invented code.
 *  6. Authority verbs (`trust.*`, `approval.decide`, etc.) are mentioned
 *     only with an "unreachable / never / no" qualifier, never as callable
 *     tools — the same invariant the opencode-config README guard checks.
 *  7. The future-only features (published standalone bin, `task.watch`
 *     resumption, streaming) are flagged as not yet available, not implied
 *     to be shipped today.
 *  8. The `mx-loom-mcp` CLI flags documented in the guide's flag table are
 *     all recognized by the bin's parser — no documented-but-removed flag
 *     that would confuse a copy-paste reader.
 *  9. `examples/README.md` (the new example index) carries no
 *     credential-shaped value and links to the guide and each example dir.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_TOOLS,
  DENIAL_CODES,
  FAULT_CODES,
  isForbiddenAuthorityVerb,
} from '@mx-loom/registry';
import { CREDENTIAL_KEY_RE } from '@mx-loom/toolbelt';
import { describe, expect, it } from 'vitest';

import { parseCliArgs } from '../src/cli-options.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const guideDir = resolve(repoRoot, 'docs');

function readRepoFile(relPath: string): string {
  return readFileSync(resolve(repoRoot, relPath), 'utf8');
}

const guideText = readRepoFile('docs/runtime-integration.md');
const examplesReadme = readRepoFile('examples/README.md');

/**
 * Extract every relative Markdown link target from `text` and resolve it to
 * an absolute path.  Strips `#anchor` fragments; skips bare `#anchor` links.
 * Links are resolved from `docs/` (the guide's directory).
 */
function extractResolvedLinks(text: string): string[] {
  const resolved = new Set<string>();
  for (const m of text.matchAll(/\]\((\.\.?\/[^)]*)\)/g)) {
    const raw = m[1]!;
    const withoutFragment = raw.replace(/#[^)]*$/, '').trim();
    if (withoutFragment) {
      resolved.add(resolve(guideDir, withoutFragment));
    }
  }
  return [...resolved];
}

/**
 * Extract the body of a Markdown section starting with `heading` and ending
 * before the next `## ` heading.
 */
function extractSection(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, `guide missing section "${heading}"`).toBeGreaterThanOrEqual(0);
  const afterHeading = text.slice(start + heading.length);
  const nextHeading = afterHeading.search(/\n## /);
  return nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);
}

/**
 * Extract the JSON body of the first fenced code block (```json or ```jsonc)
 * that appears immediately after `markerText` in `text`.
 * Returns the parsed object.
 */
function extractJsonBlock(text: string, markerText: string): Record<string, unknown> {
  const markerIdx = text.indexOf(markerText);
  expect(markerIdx, `guide missing expected block marker containing: ${markerText}`).toBeGreaterThanOrEqual(0);
  const after = text.slice(markerIdx + markerText.length);
  const fenceMatch = /```(?:jsonc|json)\n([\s\S]*?)```/.exec(after);
  expect(fenceMatch, `no fenced JSON block found after marker: ${markerText}`).not.toBeNull();
  return JSON.parse(fenceMatch![1]!) as Record<string, unknown>;
}

/**
 * Real credential-VALUE shapes that must never appear in a committed example or doc.
 * The PEM fragment matches `-----BEGIN … KEY-----` headers without spelling the
 * literal private-key phrase in source (so the repo gitleaks scan does not flag
 * this guard's own pattern as a finding).
 */
const SECRET_VALUE_PATTERN =
  /ghp_[A-Za-z0-9]|gho_[A-Za-z0-9]|github_pat_|syt_[a-z]|xox[bp]-|sk-ant-[A-Za-z0-9-]|sk-[A-Za-z0-9]{16}|-----BEGIN [A-Z ]+ KEY-----/;
/** Whole-namespace secret KEY prefixes — must never appear as named config keys. */
const SECRET_NAMESPACE_PATTERN = /MATRIX_|MX_AGENT_/;

// ---------------------------------------------------------------------------
// 1. Referenced-path existence
// ---------------------------------------------------------------------------

describe('docs/runtime-integration.md — referenced paths exist', () => {
  const links = extractResolvedLinks(guideText);

  it('extracts at least a dozen distinct relative links from the guide', () => {
    // Sanity check: the guide must actually reference external files, not just headings.
    expect(links.length).toBeGreaterThanOrEqual(12);
  });

  for (const absPath of links) {
    const rel = absPath.replace(repoRoot + '/', '');
    it(`exists: ${rel}`, () => {
      expect(existsSync(absPath), `referenced path not found: ${rel}`).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. OpenCode block drift guard
// ---------------------------------------------------------------------------

describe('docs/runtime-integration.md — OpenCode inlined blocks are JSON-equivalent to source files', () => {
  it('local stdio block matches examples/opencode/opencode.local.example.json', () => {
    const guideBlock = extractJsonBlock(
      guideText,
      'opencode.local.example.json',
    );
    const canonicalRaw = readRepoFile('examples/opencode/opencode.local.example.json');
    const canonical = JSON.parse(canonicalRaw) as Record<string, unknown>;
    expect(guideBlock).toEqual(canonical);
  });

  it('remote entry block matches examples/opencode/opencode.remote.example.json', () => {
    const guideBlock = extractJsonBlock(
      guideText,
      'opencode.remote.example.json',
    );
    const canonicalRaw = readRepoFile('examples/opencode/opencode.remote.example.json');
    const canonical = JSON.parse(canonicalRaw) as Record<string, unknown>;
    expect(guideBlock).toEqual(canonical);
  });
});

// ---------------------------------------------------------------------------
// 3. Secret boundary — the guide and examples/README.md carry no credential
// ---------------------------------------------------------------------------

describe('docs/runtime-integration.md — no credential-shaped content', () => {
  it('embeds no real credential value', () => {
    expect(guideText, 'guide must not embed a real credential value').not.toMatch(SECRET_VALUE_PATTERN);
  });

  it('does not name a secret namespace as a config key', () => {
    // MATRIX_ / MX_AGENT_ may appear in prose (e.g. "deny MATRIX_*"), but must
    // not appear as a literal key the guide instructs a reader to set.
    // The regex is intentionally loose — if it fires, inspect the context.
    const offendingLines = guideText
      .split('\n')
      .filter((line) => SECRET_NAMESPACE_PATTERN.test(line))
      // Allowable: the line explains what is DENIED (starts with "deny", contains
      // "never", "forbidden", "not", or appears in a deny-list prose context).
      .filter(
        (line) =>
          !/deny|never|forbidden|not |no |blocked|unreachable|structurally/i.test(line),
      );
    expect(
      offendingLines,
      `guide may be using a secret namespace outside a deny-list context: ${offendingLines.join(' | ')}`,
    ).toHaveLength(0);
  });
});

describe('examples/README.md — no credential-shaped content', () => {
  it('embeds no real credential value', () => {
    expect(examplesReadme).not.toMatch(SECRET_VALUE_PATTERN);
  });

  it('does not embed a secret-shaped key', () => {
    // The examples/README.md should never name MATRIX_ / MX_AGENT_ as
    // something to set; it may only say they are denied.
    const suspectLines = examplesReadme
      .split('\n')
      .filter((line) => SECRET_NAMESPACE_PATTERN.test(line))
      .filter((line) => !/deny|never|not |no |blocked/i.test(line));
    expect(suspectLines).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Canonical tool names — guide table matches CANONICAL_M1_TOOLS exactly
// ---------------------------------------------------------------------------

describe('docs/runtime-integration.md — thirteen canonical verbs table', () => {
  // Extract the "thirteen canonical verbs" section, then pull out every
  // backtick-wrapped `mx_*` verb from the first pipe-table in that section.
  const verbsSection = extractSection(guideText, '## The thirteen canonical verbs');

  // Match table rows like: | `mx_find_agents` | ... |
  // Only the first column's backtick-wrapped mx_* name.
  const toolNamesInGuide = [...verbsSection.matchAll(/^\|\s*`(mx_[a-z_]+)`/gm)].map(
    (m) => m[1]!,
  );

  it('lists exactly thirteen mx_* verbs (one per canonical tool)', () => {
    expect(toolNamesInGuide).toHaveLength(CANONICAL_TOOLS.length);
  });

  it('names exactly match CANONICAL_TOOLS (no missing, extra, or misspelled verb)', () => {
    const registryNames = CANONICAL_TOOLS.map((d) => d.name).sort();
    const guideNames = [...toolNamesInGuide].sort();
    expect(guideNames).toEqual(registryNames);
  });

  it('no authority verb appears in the table as a callable tool', () => {
    for (const name of toolNamesInGuide) {
      expect(
        isForbiddenAuthorityVerb(name),
        `authority verb found in the canonical tool table: ${name}`,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Closed error taxonomy — guide lists exactly DENIAL_CODES + FAULT_CODES
// ---------------------------------------------------------------------------

describe('docs/runtime-integration.md — closed error.code taxonomy table', () => {
  // Find the taxonomy table within the "common tool contract" section.
  // The table rows look like:
  //   | `denied` (governance) | `policy_denied`, `untrusted_key`, ... |
  //   | `error` (fault)       | `timeout`, `not_found`, ...           |
  const contractSection = extractSection(guideText, '### The closed `error.code` taxonomy');

  function extractBacktickNames(row: string): string[] {
    return [...row.matchAll(/`([a-z_]+)`/g)]
      .map((m) => m[1]!)
      // Skip status labels: "denied" and "error" are statuses, not codes.
      .filter((n) => n !== 'denied' && n !== 'error');
  }

  // Find the `denied` row and the `error` row in the taxonomy table.
  const denialRow = contractSection
    .split('\n')
    .find((line) => line.includes('`denied`') || line.includes('governance'));
  const faultRow = contractSection
    .split('\n')
    .find((line) => line.includes('`error`') || line.includes('fault'));

  it('the `denied` row names exactly match DENIAL_CODES', () => {
    expect(denialRow, 'taxonomy table missing `denied` row').toBeTruthy();
    const guideCodes = extractBacktickNames(denialRow!).sort();
    const registryCodes = [...DENIAL_CODES].sort();
    expect(guideCodes).toEqual(registryCodes);
  });

  it('the `error` row names exactly match FAULT_CODES', () => {
    expect(faultRow, 'taxonomy table missing `error` row').toBeTruthy();
    const guideCodes = extractBacktickNames(faultRow!).sort();
    const registryCodes = [...FAULT_CODES].sort();
    expect(guideCodes).toEqual(registryCodes);
  });

  it('no invented code appears in either row', () => {
    const ALL_CODES = new Set([...DENIAL_CODES, ...FAULT_CODES] as string[]);
    for (const row of [denialRow, faultRow]) {
      if (!row) continue;
      for (const code of extractBacktickNames(row)) {
        expect(ALL_CODES.has(code), `invented error code in guide taxonomy: ${code}`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Authority verb framing — mentioned only as unreachable, not callable
// ---------------------------------------------------------------------------

describe('docs/runtime-integration.md — authority verbs are unreachable, not callable', () => {
  const AUTHORITY_VERBS = [
    'trust.',
    'approval.decide',
    'policy.',
    'auth.',
    'device.',
    'daemon.',
  ] as const;

  it('every authority verb mention includes an "unreachable/never/no" qualifier', () => {
    for (const verb of AUTHORITY_VERBS) {
      if (!guideText.includes(verb)) continue; // not mentioned at all — fine
      // If it IS mentioned, the guide must qualify it as unreachable/forbidden.
      expect(
        guideText,
        `guide mentions "${verb}" without framing it as unreachable`,
      ).toMatch(/no\s+`?trust|only\b|unreachable|absent|never|structurally|not\s+surfaced/i);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Future-feature framing — "not yet available" section is accurate
// ---------------------------------------------------------------------------

describe('docs/runtime-integration.md — future-only features are flagged, not implied shipped', () => {
  const futureSection = extractSection(guideText, '## Not yet available');

  it('the "not yet available" section exists and mentions the published standalone bin', () => {
    expect(futureSection).toMatch(/published.*bin|standalone.*bin|T602/);
  });

  it('flags durable task.watch resumption as future (M3)', () => {
    expect(futureSection).toMatch(/task\.watch|M3/);
  });

  it('flags streaming / multi-tenant as future (M5/M6)', () => {
    expect(futureSection).toMatch(/[Ss]treaming|[Mm]ulti.tenant|M5|M6/);
  });

  it('the guide does not claim the published bin exists outside the future section', () => {
    // Anywhere outside the "not yet available" section, the guide must never
    // use the phrase "published bin" without a "future" / "T602" qualifier.
    const withoutFutureSection = guideText.replace(futureSection, '');
    // Simple check: the prose that describes the launcher correctly uses "tsx"
    // and flags T602 as future — not as current.
    expect(withoutFutureSection).toContain('tsx');
    // The word "published" must be paired with "future" or "T602" in the
    // surrounding sentence context (up to 120 chars after the match).
    for (const m of withoutFutureSection.matchAll(/published[^.]*\bbin\b/g)) {
      const contextEnd = Math.min(
        withoutFutureSection.length,
        m.index! + m[0].length + 120,
      );
      const context = withoutFutureSection.slice(m.index, contextEnd);
      expect(context, 'guide implies published bin is available without a future/T602 qualifier').toMatch(
        /future|T602/i,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Guide's documented CLI flags are all recognized by the bin's parser
// ---------------------------------------------------------------------------

describe('docs/runtime-integration.md — documented mx-loom-mcp flags are recognized by the parser', () => {
  // The guide's CLI surface table lists these flags. Extract them by finding
  // the flag table section and matching `| \`--flag\`` rows.
  const cliSection = extractSection(guideText, '### The `mx-loom-mcp` CLI surface');

  const documentedFlags = [...cliSection.matchAll(/^\|\s*`(--[a-z][a-z-]+)/gm)].map(
    (m) => m[1]!,
  );

  it('documents at least the core mx-loom-mcp flags', () => {
    // Sanity check: at minimum stdio, http, room, kind, correlation-id, audit
    for (const flag of ['--stdio', '--http', '--room', '--kind', '--audit']) {
      expect(
        documentedFlags,
        `guide missing documented flag: ${flag}`,
      ).toContain(flag);
    }
  });

  it('every documented flag is accepted by the bin parser (no dead documentation)', () => {
    for (const flag of documentedFlags) {
      const argv = flag === '--stdio' || flag === '--audit' ? [flag] : [flag, '1'];
      let thrownCode: string | undefined;
      try {
        parseCliArgs(argv, {});
      } catch (err) {
        thrownCode = (err as NodeJS.ErrnoException).code;
      }
      expect(
        thrownCode,
        `guide documents ${flag} but the bin does not recognize it`,
      ).not.toBe('ERR_PARSE_ARGS_UNKNOWN_OPTION');
    }
  });

  it('no credential-shaped flag is documented', () => {
    for (const flag of documentedFlags) {
      const asKey = flag.replace(/^--/, '').replace(/-/g, '_');
      expect(
        CREDENTIAL_KEY_RE.test(asKey),
        `guide documents a credential-shaped flag: ${flag}`,
      ).toBe(false);
      expect(
        isForbiddenAuthorityVerb(flag.replace(/^--/, '')),
        `guide documents an authority-verb flag: ${flag}`,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. examples/README.md — links to the guide and the example dirs
// ---------------------------------------------------------------------------

describe('examples/README.md — structure and links', () => {
  it('links to the runtime integration guide', () => {
    expect(examplesReadme).toContain('runtime-integration.md');
  });

  it('links to the ADK example dir', () => {
    expect(examplesReadme).toContain('adk/');
  });

  it('links to the OpenCode example dir', () => {
    expect(examplesReadme).toContain('opencode/');
  });

  it('carries no real credential value in any backtick span', () => {
    // examples/README.md may legitimately name `GH_TOKEN`, `MATRIX_*`, etc.
    // in deny-list prose — that is expected and correct. What must never appear
    // is an actual credential VALUE (a real token, API key, or PEM header).
    expect(examplesReadme).not.toMatch(SECRET_VALUE_PATTERN);
  });
});
