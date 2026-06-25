/**
 * Tool-name helpers (T205) — mxToolNames + isMxToolName.
 *
 * Tests:
 *  - `mxToolNames()` returns exactly the twelve canonical mx_* verb names.
 *  - Every name starts with `mx_`.
 *  - Count matches CANONICAL_TOOLS.
 *  - `isMxToolName()` returns true for each canonical name.
 *  - `isMxToolName()` returns false for unknown or authority-flavored names.
 */
import { describe, expect, it } from 'vitest';

import { CANONICAL_TOOLS } from '@mx-loom/registry';

import { isMxToolName, mxToolNames } from '../src/names.js';

describe('mxToolNames()', () => {
  it('returns exactly the twelve canonical names', () => {
    const names = mxToolNames();
    expect(names).toHaveLength(CANONICAL_TOOLS.length);
    const expected = CANONICAL_TOOLS.map((d) => d.name).sort();
    expect([...names].sort()).toEqual(expected);
  });

  it('every name starts with "mx_"', () => {
    for (const name of mxToolNames()) {
      expect(name.startsWith('mx_')).toBe(true);
    }
  });

  it('count matches CANONICAL_TOOLS.length', () => {
    expect(mxToolNames()).toHaveLength(CANONICAL_TOOLS.length);
  });

  it('each call returns a fresh array (not the same reference)', () => {
    expect(mxToolNames()).not.toBe(mxToolNames());
  });
});

describe('isMxToolName()', () => {
  it('returns true for every canonical mx_* verb', () => {
    for (const descriptor of CANONICAL_TOOLS) {
      expect(isMxToolName(descriptor.name)).toBe(true);
    }
  });

  it('returns false for an unknown name', () => {
    expect(isMxToolName('mx_not_real')).toBe(false);
    expect(isMxToolName('unknown_tool')).toBe(false);
    expect(isMxToolName('')).toBe(false);
  });

  it('returns false for authority-flavored names', () => {
    expect(isMxToolName('trust.approve')).toBe(false);
    expect(isMxToolName('approval.decide')).toBe(false);
    expect(isMxToolName('policy.update')).toBe(false);
  });

  it('is case-sensitive (partial match does not count)', () => {
    expect(isMxToolName('MX_FIND_AGENTS')).toBe(false);
    expect(isMxToolName('mx_find')).toBe(false);
  });
});
