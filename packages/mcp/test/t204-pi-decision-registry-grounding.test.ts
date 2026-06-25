/**
 * T204 / #26 — decision-record GROUNDING coverage.
 *
 * The companion `t204-pi-decision-docs.test.ts` proves the decision record, the
 * backlog, the design doc, and the MCP package docs are *internally consistent*
 * (doc ⇄ doc prose). That is necessary but not sufficient: the Pi decision record
 * is the spec **T205 will be built against**, and it makes load-bearing,
 * *enumerable* factual claims — "the nine model-facing verbs", "seven `enum`
 * string fields", a named authority denylist, the five-status envelope, the
 * closed error taxonomy, a secret-free descriptor surface.
 *
 * If `@mx-loom/registry` drifts (a tenth verb, an eighth enum field, a new
 * authority prefix, a sixth envelope status) the decision record silently becomes
 * a *wrong* spec while every prose-only test stays green. These tests close that
 * gap by checking each countable claim against the **actual registry code** (and
 * the filesystem), so doc drift fails CI instead of misleading the T205 author.
 *
 * Daemon-free, deterministic, no secrets — pure module + file reads.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_M1_TOOLS,
  DENIAL_CODES,
  ENVELOPE_SCHEMA,
  ERROR_CODES,
  FAULT_CODES,
  FORBIDDEN_AUTHORITY_PREFIXES,
  FORBIDDEN_AUTHORITY_VERBS,
  findCredentialShapedProperty,
  isForbiddenAuthorityVerb,
  MODEL_FACING_ALLOWLIST,
  type ToolDescriptor,
} from '@mx-loom/registry';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

const DECISION_DOC = readRepoFile('docs/pi-tool-surface-capability.md');

/** Canonical verb names, as a set for membership checks. */
const CANONICAL_NAMES = new Set(CANONICAL_M1_TOOLS.map((d) => d.name));

/** Collect every `enum` array declared anywhere in a JSON Schema graph. */
function collectEnums(node: unknown, out: unknown[][]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectEnums(item, out);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'enum' && Array.isArray(value)) {
      out.push(value);
    } else {
      collectEnums(value, out);
    }
  }
}

function allCanonicalEnums(): unknown[][] {
  const out: unknown[][] = [];
  for (const d of CANONICAL_M1_TOOLS as readonly ToolDescriptor[]) {
    collectEnums(d.input_schema, out);
    collectEnums(d.output_schema, out);
  }
  return out;
}

describe('T204 decision record is grounded against @mx-loom/registry', () => {
  it('"nine model-facing verbs" matches the real canonical set, and every mx_* token the doc names is a real verb', () => {
    // The T204 decision record is an M1-era record: its "nine model-facing verbs"
    // claim is grounded against the M1 canonical subset (still nine). The
    // MODEL_FACING_ALLOWLIST has since grown into the full canonical superset (the
    // 9 M1 verbs + the M3 task verbs, T301), so we assert the allowlist *contains*
    // every M1 verb the doc enumerates rather than equals nine.
    expect(CANONICAL_M1_TOOLS).toHaveLength(9);
    const allowlist: readonly string[] = MODEL_FACING_ALLOWLIST;
    for (const d of CANONICAL_M1_TOOLS) {
      expect(allowlist, `M1 verb ${d.name} must remain in MODEL_FACING_ALLOWLIST`).toContain(d.name);
    }
    expect(DECISION_DOC).toContain('nine model-facing');

    // Every mx_-namespaced token in the doc must resolve to a real verb — catches
    // a typo, a renamed verb, or a reference to a verb that no longer exists.
    const tokens = DECISION_DOC.match(/mx_[a-z0-9]+(?:_[a-z0-9]+)*/g) ?? [];
    for (const token of new Set(tokens)) {
      expect(CANONICAL_NAMES.has(token), `decision doc names a non-canonical verb: ${token}`).toBe(true);
    }

    // The deferred-protocol verbs the doc's `mx_await_result` guidance depends on
    // must actually be referenced.
    for (const verb of ['mx_delegate_tool', 'mx_run_command', 'mx_await_result']) {
      expect(DECISION_DOC).toContain(verb);
    }
  });

  it('"seven enum string fields" matches the canonical descriptors exactly', () => {
    const enums = allCanonicalEnums();
    // The doc's countable claim must equal the descriptor reality.
    expect(enums).toHaveLength(7);
    expect(DECISION_DOC).toContain('seven');

    // The three distinct value-sets the doc cites must all be present in the
    // descriptors (the Pi binding must emit StringEnum for each of these).
    const distinct = new Set(enums.map((e) => JSON.stringify(e)));
    expect(distinct).toEqual(
      new Set([
        JSON.stringify(['active', 'stale', 'offline']),
        JSON.stringify(['file', 'diff', 'env']),
        JSON.stringify(['utf-8', 'base64']),
      ]),
    );

    // …and the doc must cite each value-set verbatim (single-quoted, no spaces).
    expect(DECISION_DOC).toContain("['active','stale','offline']");
    expect(DECISION_DOC).toContain("['file','diff','env']");
    expect(DECISION_DOC).toContain("['utf-8','base64']");
  });

  it('the authority denylist the doc promises is genuinely forbidden by the registry', () => {
    // Map each prefix/verb the doc claims it will never register to a concrete
    // representative, and confirm the registry actually treats it as authority.
    const representatives: Record<string, string> = {
      'trust.*': 'trust.publish',
      'approval.decide': 'approval.decide',
      'policy.*': 'policy.update',
      'auth.*': 'auth.login',
      'device.*': 'device.verify',
      'daemon.*': 'daemon.stop',
    };

    for (const [cited, concrete] of Object.entries(representatives)) {
      // The doc must actually name it (it claims to exclude these).
      expect(DECISION_DOC, `doc must cite excluded authority surface ${cited}`).toContain(cited);
      // The registry must agree it is a forbidden authority verb.
      expect(isForbiddenAuthorityVerb(concrete), `${concrete} must be forbidden`).toBe(true);
      // And it must never be a model-facing verb.
      expect(CANONICAL_NAMES.has(concrete)).toBe(false);
    }

    // Each cited dotted prefix must be in the registry's real prefix denylist, and
    // approval.decide in the exact-verb denylist — so the doc cannot promise to
    // exclude something the registry does not actually treat as authority.
    for (const prefix of ['trust.', 'policy.', 'auth.', 'device.', 'daemon.']) {
      expect(FORBIDDEN_AUTHORITY_PREFIXES as readonly string[]).toContain(prefix);
    }
    expect(FORBIDDEN_AUTHORITY_VERBS as readonly string[]).toContain('approval.decide');

    // No canonical descriptor is an authority verb (the registry's own invariant,
    // re-grounded here as the basis for the doc's "registers only the nine" claim).
    for (const d of CANONICAL_M1_TOOLS) {
      expect(isForbiddenAuthorityVerb(d.name), `${d.name} must not be an authority verb`).toBe(false);
    }
  });

  it('the envelope status set the doc cites matches ENVELOPE_SCHEMA exactly', () => {
    const props = (ENVELOPE_SCHEMA as { properties?: Record<string, { enum?: unknown }> }).properties;
    const statusEnum = props?.status?.enum;
    expect(Array.isArray(statusEnum)).toBe(true);
    expect(statusEnum).toEqual(['ok', 'running', 'awaiting_approval', 'denied', 'error']);

    // The doc's "No envelope/protocol change" promise must enumerate the same set.
    expect(DECISION_DOC).toContain('ok|running|awaiting_approval|denied|error');
    for (const status of statusEnum as string[]) {
      expect(DECISION_DOC).toContain(status);
    }
  });

  it('the "closed taxonomy" the doc relies on is a real closed, partitioned error set', () => {
    // error.code is exactly nine codes, partitioned into denial + fault with no
    // overlap and no gap — the contract the Pi binding must preserve unchanged.
    expect(ERROR_CODES).toHaveLength(9);
    expect([...DENIAL_CODES, ...FAULT_CODES].sort()).toEqual([...ERROR_CODES].sort());
    const denialSet = new Set<string>(DENIAL_CODES);
    expect(FAULT_CODES.some((c) => denialSet.has(c))).toBe(false);
    expect(DECISION_DOC).toContain('closed taxonomy');
  });

  it('the secret-free descriptor surface the doc promises holds across every canonical schema', () => {
    // The doc promises the Pi boundary stays secret-free. At the descriptor layer
    // that means no input/output schema may even DECLARE a credential-shaped field.
    for (const d of CANONICAL_M1_TOOLS) {
      expect(
        findCredentialShapedProperty(d.input_schema),
        `${d.name}.input_schema must not declare a credential-shaped field`,
      ).toBeUndefined();
      expect(
        findCredentialShapedProperty(d.output_schema),
        `${d.name}.output_schema must not declare a credential-shaped field`,
      ).toBeUndefined();
    }

    // …and the doc must actually state the secret boundary it inherits.
    expect(DECISION_DOC).toContain('GH_TOKEN');
    expect(DECISION_DOC).toContain('Ed25519 signing keys');
    expect(DECISION_DOC).toContain('deny-by-default env allowlist');
  });

  it('the "packages that exist today" the doc lists are actually present on disk', () => {
    // The decision record states which packages this checkout has. Ground that
    // claim against the filesystem (non-blocking for T205: adding packages/pi
    // later does not break this subset check).
    for (const pkg of ['registry', 'toolbelt', 'mcp', 'claude', 'audit', 'golden']) {
      expect(
        existsSync(resolve(repoRoot, 'packages', pkg, 'package.json')),
        `packages/${pkg} should exist`,
      ).toBe(true);
      expect(DECISION_DOC).toContain(`\`packages/${pkg}\``);
    }
  });

  it('the backlog open-questions ledger records the Pi MCP question as resolved (native)', () => {
    // A distinct doc location (the open-questions ledger) the companion suite does
    // not assert — keep it from drifting back to "unknown".
    const backlog = readRepoFile('docs/backlog.md');
    expect(backlog).toContain('Pi MCP support — RESOLVED by `T204`');
    expect(backlog).toContain('has **no built-in MCP client**');
    expect(backlog).toContain("native tool registration");
  });
});
