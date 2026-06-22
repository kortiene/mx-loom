import { describe, expect, it } from 'vitest';

import { branchPrefix, deriveBranch, slugifyTitle } from '../src/issue.js';

describe('branchPrefix', () => {
  it('maps type labels with last-match-wins and defaults to feat', () => {
    expect(branchPrefix([])).toBe('feat');
    expect(branchPrefix(['type:bug'])).toBe('fix');
    expect(branchPrefix(['type:feature', 'type:docs'])).toBe('docs');
    expect(branchPrefix(['type:docs', 'type:ci'])).toBe('ci');
  });

  it('maps mx-loom type/* labels and plain fallbacks case-insensitively', () => {
    expect(branchPrefix(['type/feature'])).toBe('feat');
    expect(branchPrefix(['type/chore'])).toBe('chore');
    expect(branchPrefix(['type/docs'])).toBe('docs');
    expect(branchPrefix(['type/spike'])).toBe('spike');
    expect(branchPrefix(['Bug'])).toBe('fix');
    expect(branchPrefix(['tech-debt'])).toBe('refactor');
    expect(branchPrefix(['area/contract'])).toBe('feat'); // unmapped -> default
    expect(branchPrefix(['type/docs', 'type/test'])).toBe('test'); // last match wins
  });
});

describe('slugifyTitle', () => {
  it('strips the phase prefix, slugifies, and caps at 40 chars', () => {
    expect(slugifyTitle('Phase issue 12: Fix the Frobnicator!')).toBe('fix-the-frobnicator');
    expect(slugifyTitle('  Weird___chars && symbols  ')).toBe('weird-chars-symbols');
    const long = slugifyTitle('a'.repeat(60));
    expect(long.length).toBeLessThanOrEqual(40);
    expect(slugifyTitle('ends with junk!!!')).toBe('ends-with-junk');
  });

  it('strips diacritics so accented titles slug cleanly', () => {
    expect(slugifyTitle('Café déjà vu señor')).toBe('cafe-deja-vu-senor');
    const slug = slugifyTitle('Validation des performances (élévation < 3 s)');
    expect(slug).toMatch(/^[a-z0-9-]+$/); // fully transliterated, no accents survive
    expect(slug.startsWith('validation-des-performances')).toBe(true);
    expect(slug.length).toBeLessThanOrEqual(40);
  });
});

describe('deriveBranch', () => {
  it('builds {prefix}/{issue}-[{adw_id}-]{slug}', () => {
    expect(deriveBranch(5, 'Add the thing', ['type:bug'], 'a1b2c3d4')).toBe('fix/5-a1b2c3d4-add-the-thing');
    expect(deriveBranch(5, 'Add the thing', [])).toBe('feat/5-add-the-thing');
  });
});
