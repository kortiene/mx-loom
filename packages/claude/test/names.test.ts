/**
 * Tool namespacing (T110 / #18) — `mxToolName` + `mxVerbFromToolName` + the
 * `DEFAULT_SERVER_NAME` constant.
 *
 * Tests:
 *  - `mxToolName` produces `mcp__<server>__<verb>` with the default and custom
 *    server names for each of the nine canonical verbs.
 *  - `mxVerbFromToolName` extracts the bare verb iff the name matches this
 *    shim's server; returns `undefined` for a different server, a non-`mx_*`
 *    tool under the same server, and a bare (un-namespaced) name.
 *  - `mxVerbFromToolName` is the exact inverse of `mxToolName` for all nine
 *    canonical verbs.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_SERVER_NAME, mxToolName, mxVerbFromToolName } from '../src/names.js';

const CANONICAL_VERBS = [
  'mx_find_agents',
  'mx_describe_agent',
  'mx_delegate_tool',
  'mx_run_command',
  'mx_await_result',
  'mx_share_context',
  'mx_get_context',
  'mx_cancel',
  'mx_workspace_status',
] as const;

describe('DEFAULT_SERVER_NAME', () => {
  it('is the string "mx"', () => {
    expect(DEFAULT_SERVER_NAME).toBe('mx');
  });
});

describe('mxToolName', () => {
  it('produces the expected namespaced form for mx_delegate_tool with the default server name', () => {
    expect(mxToolName('mx_delegate_tool')).toBe('mcp__mx__mx_delegate_tool');
  });

  it('uses a custom server name when provided', () => {
    expect(mxToolName('mx_delegate_tool', 'mxloom')).toBe('mcp__mxloom__mx_delegate_tool');
  });

  it('produces the correct namespaced form for every canonical verb', () => {
    for (const verb of CANONICAL_VERBS) {
      expect(mxToolName(verb)).toBe(`mcp__mx__${verb}`);
    }
  });
});

describe('mxVerbFromToolName', () => {
  it('extracts the verb from a correctly namespaced name', () => {
    expect(mxVerbFromToolName('mcp__mx__mx_delegate_tool')).toBe('mx_delegate_tool');
  });

  it('returns undefined for a different server name', () => {
    expect(mxVerbFromToolName('mcp__other__mx_delegate_tool')).toBeUndefined();
  });

  it('returns undefined for a non-mx_* tool under the same server', () => {
    expect(mxVerbFromToolName('mcp__mx__some_other_tool')).toBeUndefined();
  });

  it('returns undefined for a bare (un-namespaced) name', () => {
    expect(mxVerbFromToolName('mx_delegate_tool')).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(mxVerbFromToolName('')).toBeUndefined();
  });

  it('returns undefined for a prefix-only name (empty verb after the separator)', () => {
    // 'mcp__mx__' → verb = '' → does not start with 'mx_' → undefined.
    expect(mxVerbFromToolName('mcp__mx__')).toBeUndefined();
  });

  it('uses a custom server name when provided', () => {
    expect(mxVerbFromToolName('mcp__custom__mx_delegate_tool', 'custom')).toBe('mx_delegate_tool');
  });

  it('returns undefined when custom server name does not match', () => {
    expect(mxVerbFromToolName('mcp__mx__mx_delegate_tool', 'custom')).toBeUndefined();
  });

  it('is the exact inverse of mxToolName for all canonical verbs', () => {
    for (const verb of CANONICAL_VERBS) {
      expect(mxVerbFromToolName(mxToolName(verb))).toBe(verb);
    }
  });
});
