/**
 * Pure unit tests for `projectWorkspaceMeta` and `deriveProject` (T108 / #16) —
 * the redaction/shaping heart of `mx_workspace_status`.
 *
 * These tests exercise the exported pure projectors in isolation, giving sharper
 * failure messages than the handler-level tests and pinning the allowlist-by-
 * construction invariant for `projectWorkspaceMeta` at the module boundary.
 *
 * Coverage:
 * - `projectWorkspaceMeta`: non-object input → `{}`; only the four named fields
 *   projected; `encrypted: false` (boolean false preserved, not treated as absent);
 *   `members[]` / `user_id` / extra upstream fields NOT included; non-boolean
 *   `encrypted` absent; missing fields absent (no undefined/null leakage).
 * - `deriveProject`: status `project` block wins; status `workspace` block wins
 *   when no `project`; agent row workspace as fallback; priority: status > agent;
 *   first agent row with a workspace is used (not a later one); all absent → undefined;
 *   malformed blocks → undefined; partial blocks (only one field) returned.
 *
 * No I/O, no daemon, no env.
 */
import { describe, expect, it } from 'vitest';

import { deriveProject, projectWorkspaceMeta } from '../../src/index.js';

// ---------------------------------------------------------------------------
// projectWorkspaceMeta
// ---------------------------------------------------------------------------

describe('projectWorkspaceMeta — non-object inputs', () => {
  it('null → empty object', () => {
    expect(projectWorkspaceMeta(null)).toEqual({});
  });

  it('undefined → empty object', () => {
    expect(projectWorkspaceMeta(undefined)).toEqual({});
  });

  it('string → empty object', () => {
    expect(projectWorkspaceMeta('room-id-string')).toEqual({});
  });

  it('number → empty object', () => {
    expect(projectWorkspaceMeta(42)).toEqual({});
  });

  it('array → empty object', () => {
    expect(projectWorkspaceMeta([])).toEqual({});
  });
});

describe('projectWorkspaceMeta — allowlist projection', () => {
  it('all four named fields projected when present', () => {
    const result = projectWorkspaceMeta({
      room_id: '!room:home',
      name: 'my-workspace',
      canonical_alias: '#alias:home',
      encrypted: true,
    });
    expect(result.room_id).toBe('!room:home');
    expect(result.name).toBe('my-workspace');
    expect(result.canonical_alias).toBe('#alias:home');
    expect(result.encrypted).toBe(true);
  });

  it('encrypted: false is preserved (boolean false is not treated as absent)', () => {
    const result = projectWorkspaceMeta({ room_id: '!r:h', encrypted: false });
    expect(result.encrypted).toBe(false);
  });

  it('only room_id present → output has only room_id', () => {
    const result = projectWorkspaceMeta({ room_id: '!r:h' });
    expect(result.room_id).toBe('!r:h');
    expect('name' in result).toBe(false);
    expect('canonical_alias' in result).toBe(false);
    expect('encrypted' in result).toBe(false);
  });

  it('missing fields are absent in output — no undefined or null leakage', () => {
    const result = projectWorkspaceMeta({ name: 'ws' });
    expect('room_id' in result).toBe(false);
    expect('canonical_alias' in result).toBe(false);
    expect('encrypted' in result).toBe(false);
    // name IS present
    expect(result.name).toBe('ws');
  });

  it('non-boolean encrypted is omitted (numeric 1 does not pass as true)', () => {
    const result = projectWorkspaceMeta({ encrypted: 1 });
    expect('encrypted' in result).toBe(false);
  });

  it('non-string room_id is omitted (numeric room_id does not pass)', () => {
    const result = projectWorkspaceMeta({ room_id: 123 });
    expect('room_id' in result).toBe(false);
  });
});

describe('projectWorkspaceMeta — raw Matrix fields NOT projected', () => {
  it('members[] is NOT in the output', () => {
    const result = projectWorkspaceMeta({
      room_id: '!r:h',
      members: [{ user_id: '@alice:h', membership: 'join' }],
    });
    expect('members' in result).toBe(false);
  });

  it('user_id is NOT in the output', () => {
    const result = projectWorkspaceMeta({ room_id: '!r:h', user_id: '@alice:h' });
    expect('user_id' in result).toBe(false);
  });

  it('joined_members count is NOT in the output', () => {
    const result = projectWorkspaceMeta({ room_id: '!r:h', joined_members: 3 });
    expect('joined_members' in result).toBe(false);
  });

  it('arbitrary extra upstream fields are NOT in the output', () => {
    const result = projectWorkspaceMeta({
      room_id: '!r:h',
      secret_token: 'syt_AAAA',
      __internal__: true,
      display_name: 'Alice',
    });
    expect('secret_token' in result).toBe(false);
    expect('__internal__' in result).toBe(false);
    expect('display_name' in result).toBe(false);
  });

  it('output has at most the four named keys, no extras from a rich daemon reply', () => {
    const result = projectWorkspaceMeta({
      room_id: '!r:h',
      name: 'ws',
      canonical_alias: '#ws:h',
      encrypted: true,
      members: [],
      joined_members: 0,
      topic: 'some topic',
      avatar_url: 'mxc://h/abc',
    });
    const keys = Object.keys(result).sort();
    expect(keys).toEqual(['canonical_alias', 'encrypted', 'name', 'room_id']);
  });
});

// ---------------------------------------------------------------------------
// deriveProject
// ---------------------------------------------------------------------------

/** Minimal AgentListRow shape (matches the exported AgentListRow interface). */
function makeRow(workspace: unknown, liveness = 'active'): { agent: Record<string, unknown>; liveness: unknown } {
  return {
    agent: {
      agent_id: `ag_${String(liveness)}`,
      kind: 'worker',
      capabilities: [],
      ...(workspace !== undefined ? { workspace } : {}),
    },
    liveness,
  };
}

describe('deriveProject — status.project block (highest priority)', () => {
  it('status with a project block → returns project_id, cwd, git_commit', () => {
    const result = deriveProject(
      { room_id: '!r:h', project: { project_id: 'proj_01', cwd: '/app', git_commit: 'abc123' } },
      [],
    );
    expect(result?.project_id).toBe('proj_01');
    expect(result?.cwd).toBe('/app');
    expect(result?.git_commit).toBe('abc123');
  });

  it('status project block wins over agent row workspace (priority)', () => {
    const row = makeRow({ project_id: 'proj_agent', cwd: '/agent-cwd' });
    const result = deriveProject(
      { project: { project_id: 'proj_status', cwd: '/status-cwd' } },
      [row],
    );
    expect(result?.project_id).toBe('proj_status');
    expect(result?.cwd).toBe('/status-cwd');
  });

  it('partial project block (only project_id) → returned without absent fields', () => {
    const result = deriveProject({ project: { project_id: 'proj_p' } }, []);
    expect(result?.project_id).toBe('proj_p');
    expect('cwd' in (result ?? {})).toBe(false);
    expect('git_commit' in (result ?? {})).toBe(false);
  });

  it('project block with none of the three fields → undefined (treated as "no project")', () => {
    const result = deriveProject({ project: { some_other_field: 'x' } }, []);
    expect(result).toBeUndefined();
  });
});

describe('deriveProject — status.workspace block (fallback within status)', () => {
  it('status workspace block used when no status.project block', () => {
    const result = deriveProject({ workspace: { project_id: 'proj_ws', cwd: '/ws' } }, []);
    expect(result?.project_id).toBe('proj_ws');
    expect(result?.cwd).toBe('/ws');
  });

  it('status workspace block wins over agent row (priority over agent fallback)', () => {
    const row = makeRow({ project_id: 'proj_agent' });
    const result = deriveProject({ workspace: { project_id: 'proj_ws', cwd: '/ws' } }, [row]);
    expect(result?.project_id).toBe('proj_ws');
  });

  it('status project block wins over status workspace block (not checked when project found)', () => {
    const result = deriveProject(
      {
        project: { project_id: 'proj_from_project' },
        workspace: { project_id: 'proj_from_workspace' },
      },
      [],
    );
    expect(result?.project_id).toBe('proj_from_project');
  });
});

describe('deriveProject — agent row workspace fallback', () => {
  it('no project info in status + one agent with workspace → agent workspace used', () => {
    const row = makeRow({ project_id: 'proj_a', cwd: '/a', git_commit: 'def456' });
    const result = deriveProject({ room_id: '!r:h' }, [row]);
    expect(result?.project_id).toBe('proj_a');
    expect(result?.cwd).toBe('/a');
    expect(result?.git_commit).toBe('def456');
  });

  it('first agent row with a workspace wins (not a later one)', () => {
    const row1 = makeRow({ project_id: 'proj_first', cwd: '/first' });
    const row2 = makeRow({ project_id: 'proj_second', cwd: '/second' });
    const result = deriveProject({ room_id: '!r:h' }, [row1, row2]);
    expect(result?.project_id).toBe('proj_first');
  });

  it('first agent row without workspace is skipped; second with workspace is used', () => {
    const row1 = makeRow(undefined); // no workspace field
    const row2 = makeRow({ project_id: 'proj_second' });
    const result = deriveProject({ room_id: '!r:h' }, [row1, row2]);
    expect(result?.project_id).toBe('proj_second');
  });

  it('agent workspace with none of the three fields → skipped (treated as no project)', () => {
    const row = makeRow({ other_field: 'x' }); // workspace exists but no project fields
    const result = deriveProject({ room_id: '!r:h' }, [row]);
    expect(result).toBeUndefined();
  });
});

describe('deriveProject — all absent → undefined', () => {
  it('empty status + empty rows → undefined', () => {
    expect(deriveProject({}, [])).toBeUndefined();
  });

  it('null status + empty rows → undefined', () => {
    expect(deriveProject(null, [])).toBeUndefined();
  });

  it('status with room_id only + no rows → undefined', () => {
    expect(deriveProject({ room_id: '!r:h' }, [])).toBeUndefined();
  });

  it('status malformed project block (non-object) → undefined', () => {
    expect(deriveProject({ project: 'not-an-object' }, [])).toBeUndefined();
  });

  it('status malformed workspace block (array) → undefined', () => {
    expect(deriveProject({ workspace: ['not', 'an', 'object'] }, [])).toBeUndefined();
  });
});
