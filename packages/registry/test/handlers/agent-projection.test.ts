/**
 * Pure unit tests for the agent-record projectors (T104 / #12) — `agent-projection.ts`.
 *
 * Every function is pure and total (no I/O, never throws). Tests pin:
 * - `readLiveness` — valid enum values pass through; unknown/absent → fail-closed `'offline'`.
 * - `readString` / `readStringArray` — total readers degrade gracefully.
 * - `asRecord` — distinguishes plain objects from arrays, null, and primitives.
 * - `readListRow` — wrapped `{ agent, liveness }` form + bare-agent fallback + garbage → undefined.
 * - `readToolNames` — string-array, `{ name }` objects, mix, empty → undefined, non-array → undefined.
 * - `projectAgentSummary` — allowlist-by-construction; `liveness` is always present.
 * - `projectAgentDetail` — allowlist; workspace/load optional sub-objects.
 * - `projectTools` — non-array → []; missing name → skipped; `input_schema`/`output_schema` verbatim.
 * - `publishedToolNames` — dedup of `schemas` + `tools` name sources.
 */
import { describe, expect, it } from 'vitest';

import {
  asRecord,
  projectAgentDetail,
  projectAgentSummary,
  projectTools,
  publishedToolNames,
  readListRow,
  readLiveness,
  readString,
  readStringArray,
  readToolNames,
} from '../../src/handlers/agent-projection.js';

// ---------------------------------------------------------------------------
// readLiveness
// ---------------------------------------------------------------------------

describe('readLiveness', () => {
  it("'active' passes through", () => expect(readLiveness('active')).toBe('active'));
  it("'stale' passes through", () => expect(readLiveness('stale')).toBe('stale'));
  it("'offline' passes through", () => expect(readLiveness('offline')).toBe('offline'));
  it('unknown string → offline (fail-closed)', () => expect(readLiveness('unknown')).toBe('offline'));
  it('undefined → offline', () => expect(readLiveness(undefined)).toBe('offline'));
  it('null → offline', () => expect(readLiveness(null)).toBe('offline'));
  it('number → offline', () => expect(readLiveness(1)).toBe('offline'));
  it('empty string → offline', () => expect(readLiveness('')).toBe('offline'));
  it('never optimistically returns active for a missing value', () => {
    expect(readLiveness(undefined)).not.toBe('active');
    expect(readLiveness(null)).not.toBe('active');
  });
});

// ---------------------------------------------------------------------------
// readString
// ---------------------------------------------------------------------------

describe('readString', () => {
  it('string passes through', () => expect(readString('hello')).toBe('hello'));
  it('empty string passes through', () => expect(readString('')).toBe(''));
  it('number → undefined', () => expect(readString(42)).toBeUndefined());
  it('null → undefined', () => expect(readString(null)).toBeUndefined());
  it('object → undefined', () => expect(readString({})).toBeUndefined());
  it('array → undefined', () => expect(readString([])).toBeUndefined());
});

// ---------------------------------------------------------------------------
// readStringArray
// ---------------------------------------------------------------------------

describe('readStringArray', () => {
  it('string array passes through', () => expect(readStringArray(['a', 'b'])).toEqual(['a', 'b']));
  it('mixed array keeps only strings', () => expect(readStringArray(['a', 1, null, 'b'])).toEqual(['a', 'b']));
  it('non-array → []', () => expect(readStringArray('not-an-array')).toEqual([]));
  it('null → []', () => expect(readStringArray(null)).toEqual([]));
  it('empty array → []', () => expect(readStringArray([])).toEqual([]));
});

// ---------------------------------------------------------------------------
// asRecord
// ---------------------------------------------------------------------------

describe('asRecord', () => {
  it('plain object → returns the object', () => {
    const obj = { a: 1 };
    expect(asRecord(obj)).toBe(obj);
  });
  it('array → undefined (even though typeof [] === "object")', () => {
    expect(asRecord([1, 2])).toBeUndefined();
  });
  it('null → undefined', () => expect(asRecord(null)).toBeUndefined());
  it('string → undefined', () => expect(asRecord('x')).toBeUndefined());
  it('number → undefined', () => expect(asRecord(42)).toBeUndefined());
  it('undefined → undefined', () => expect(asRecord(undefined)).toBeUndefined());
});

// ---------------------------------------------------------------------------
// readListRow
// ---------------------------------------------------------------------------

describe('readListRow', () => {
  it('wrapped form { agent: AgentState, liveness } → extracts both', () => {
    const agent = { agent_id: 'ag_1', kind: 'worker' };
    const row = readListRow({ agent, liveness: 'active' });
    expect(row).toEqual({ agent, liveness: 'active' });
  });

  it('bare-agent fallback: a row that IS an AgentState (has agent_id, no wrapper) → row itself as agent', () => {
    const row = readListRow({ agent_id: 'ag_2', kind: 'worker', liveness: 'stale' });
    expect(row).toBeDefined();
    expect(row!.agent.agent_id).toBe('ag_2');
    expect(row!.liveness).toBe('stale');
  });

  it('non-object → undefined', () => expect(readListRow('bad')).toBeUndefined());
  it('null → undefined', () => expect(readListRow(null)).toBeUndefined());
  it('object with no agent or agent_id → undefined', () => {
    expect(readListRow({ foo: 'bar' })).toBeUndefined();
  });
  it('object with agent that is not a record → undefined', () => {
    expect(readListRow({ agent: 'not-a-record', liveness: 'active' })).toBeUndefined();
  });
  it('wrapped form with null liveness still yields a row (liveness is raw, not yet validated)', () => {
    const row = readListRow({ agent: { agent_id: 'ag_3' }, liveness: null });
    expect(row).toBeDefined();
    expect(row!.liveness).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readToolNames
// ---------------------------------------------------------------------------

describe('readToolNames', () => {
  it('non-empty string array → returns names', () => {
    expect(readToolNames(['tool_a', 'tool_b'])).toEqual(['tool_a', 'tool_b']);
  });

  it('non-empty array of { name } objects → returns names', () => {
    expect(readToolNames([{ name: 'tool_c' }, { name: 'tool_d' }])).toEqual(['tool_c', 'tool_d']);
  });

  it('mixed string + { name } array → returns all names', () => {
    expect(readToolNames(['tool_a', { name: 'tool_b' }])).toEqual(['tool_a', 'tool_b']);
  });

  it('non-empty array yielding no names → undefined (not an empty array)', () => {
    expect(readToolNames([{ no_name: true }, 42, null])).toBeUndefined();
  });

  it('empty array → undefined (ambiguous — not "definitively no tools")', () => {
    expect(readToolNames([])).toBeUndefined();
  });

  it('non-array → undefined', () => {
    expect(readToolNames('tool_a')).toBeUndefined();
    expect(readToolNames(null)).toBeUndefined();
    expect(readToolNames({ name: 'tool_a' })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// projectAgentSummary
// ---------------------------------------------------------------------------

describe('projectAgentSummary', () => {
  it('projects agent_id, kind, capabilities, and liveness', () => {
    const agent = { agent_id: 'ag_1', kind: 'worker', capabilities: ['code_execution'], extra: 'ignored' };
    const summary = projectAgentSummary(agent, 'active');
    expect(summary.agent_id).toBe('ag_1');
    expect(summary.kind).toBe('worker');
    expect(summary.capabilities).toEqual(['code_execution']);
    expect(summary.liveness).toBe('active');
  });

  it('absent kind is omitted (not present as undefined)', () => {
    const agent = { agent_id: 'ag_2', capabilities: [] };
    const summary = projectAgentSummary(agent, 'stale');
    expect(Object.prototype.hasOwnProperty.call(summary, 'kind')).toBe(false);
  });

  it('liveness is always present (fail-closed to offline for unknown values)', () => {
    const summary = projectAgentSummary({ agent_id: 'ag_3', capabilities: [] }, undefined);
    expect(summary.liveness).toBe('offline');
  });

  it('non-object agent → empty agent_id + empty capabilities + offline liveness (never throws)', () => {
    const summary = projectAgentSummary(null, 'active');
    expect(summary.agent_id).toBe('');
    expect(summary.capabilities).toEqual([]);
    expect(summary.liveness).toBe('active');
  });

  it('capabilities is always an array', () => {
    const summary = projectAgentSummary({ agent_id: 'ag_4', capabilities: null }, 'offline');
    expect(Array.isArray(summary.capabilities)).toBe(true);
  });

  it('NEVER copies matrix_user_id into the summary', () => {
    const agent = { agent_id: 'ag_5', matrix_user_id: '@ag:server', capabilities: [] };
    const summary = projectAgentSummary(agent, 'active');
    expect(Object.prototype.hasOwnProperty.call(summary, 'matrix_user_id')).toBe(false);
    expect(JSON.stringify(summary)).not.toContain('matrix_user_id');
  });

  it('NEVER copies device_id into the summary', () => {
    const agent = { agent_id: 'ag_6', device_id: 'DEVICE_X', capabilities: [] };
    const summary = projectAgentSummary(agent, 'active');
    expect(Object.prototype.hasOwnProperty.call(summary, 'device_id')).toBe(false);
  });

  it('NEVER copies signing_key_id into the summary', () => {
    const agent = { agent_id: 'ag_7', signing_key_id: 'key_abc', capabilities: [] };
    const summary = projectAgentSummary(agent, 'active');
    expect(Object.prototype.hasOwnProperty.call(summary, 'signing_key_id')).toBe(false);
  });

  it('NEVER copies signing_public_key into the summary', () => {
    const agent = { agent_id: 'ag_8', signing_public_key: 'ed25519:AABB==', capabilities: [] };
    const summary = projectAgentSummary(agent, 'active');
    expect(Object.prototype.hasOwnProperty.call(summary, 'signing_public_key')).toBe(false);
  });

  it('NEVER copies state_rev into the summary', () => {
    const agent = { agent_id: 'ag_9', state_rev: 42, capabilities: [] };
    const summary = projectAgentSummary(agent, 'active');
    expect(Object.prototype.hasOwnProperty.call(summary, 'state_rev')).toBe(false);
  });

  it('an unknown extra field in the agent record is NOT included (allowlist-by-construction)', () => {
    const agent = { agent_id: 'ag_10', capabilities: [], secret_field: 'super_secret_value' };
    const summary = projectAgentSummary(agent, 'active');
    expect(JSON.stringify(summary)).not.toContain('secret_field');
    expect(JSON.stringify(summary)).not.toContain('super_secret_value');
  });
});

// ---------------------------------------------------------------------------
// projectAgentDetail
// ---------------------------------------------------------------------------

describe('projectAgentDetail', () => {
  it('projects all allowed top-level fields', () => {
    const agent = {
      agent_id: 'ag_1',
      kind: 'worker',
      status: 'online',
      capabilities: ['code'],
      workspace: { cwd: '/tmp', project_id: 'proj_1', git_commit: 'abc123' },
      load: { running_invocations: 2, max_invocations: 5 },
      last_seen_ts: 1_700_000_000,
    };
    const detail = projectAgentDetail(agent, 'active');
    expect(detail.agent_id).toBe('ag_1');
    expect(detail.kind).toBe('worker');
    expect(detail.status).toBe('online');
    expect(detail.capabilities).toEqual(['code']);
    expect(detail.liveness).toBe('active');
    expect(detail.workspace).toEqual({ cwd: '/tmp', project_id: 'proj_1', git_commit: 'abc123' });
    expect(detail.load).toEqual({ running_invocations: 2, max_invocations: 5 });
    expect(detail.last_seen_ts).toBe(1_700_000_000);
  });

  it('optional fields (workspace, load, last_seen_ts) are absent when not in the source', () => {
    const detail = projectAgentDetail({ agent_id: 'ag_2', capabilities: [] }, 'stale');
    expect(Object.prototype.hasOwnProperty.call(detail, 'workspace')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(detail, 'load')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(detail, 'last_seen_ts')).toBe(false);
  });

  it('workspace with all-null values is omitted entirely', () => {
    const detail = projectAgentDetail({ agent_id: 'ag_3', capabilities: [], workspace: { foo: 'bar' } }, 'active');
    expect(Object.prototype.hasOwnProperty.call(detail, 'workspace')).toBe(false);
  });

  it('NEVER copies matrix_user_id, device_id, signing_key_id, signing_public_key, or state_rev', () => {
    const agent = {
      agent_id: 'ag_4',
      capabilities: [],
      matrix_user_id: '@ag:server',
      device_id: 'DEVICE',
      signing_key_id: 'key_id',
      signing_public_key: 'ed25519:AABB==',
      state_rev: 99,
    };
    const detail = projectAgentDetail(agent, 'active');
    const json = JSON.stringify(detail);
    for (const field of ['matrix_user_id', 'device_id', 'signing_key_id', 'signing_public_key', 'state_rev']) {
      expect(json).not.toContain(field);
    }
  });

  it('non-object agent → empty agent_id + empty capabilities (never throws)', () => {
    const detail = projectAgentDetail('not-an-object', 'active');
    expect(detail.agent_id).toBe('');
    expect(detail.capabilities).toEqual([]);
  });

  it('liveness fails closed to offline for unknown values', () => {
    const detail = projectAgentDetail({ agent_id: 'ag_5', capabilities: [] }, 'UNKNOWN');
    expect(detail.liveness).toBe('offline');
  });
});

// ---------------------------------------------------------------------------
// projectTools
// ---------------------------------------------------------------------------

describe('projectTools', () => {
  it('non-array input → []', () => {
    expect(projectTools(null)).toEqual([]);
    expect(projectTools('not-an-array')).toEqual([]);
    expect(projectTools({ schemas: [] })).toEqual([]);
  });

  it('schema entry without a string name is skipped', () => {
    const tools = projectTools([{ version: '1.0' }, { name: null }]);
    expect(tools).toHaveLength(0);
  });

  it('projects name, version, description, input_schema, output_schema', () => {
    const schema = {
      name: 'run_tests',
      version: '1.0',
      description: 'Run the test suite',
      input_schema: { type: 'object', properties: { filter: { type: 'string' } } },
      output_schema: { type: 'object', properties: { passed: { type: 'integer' } } },
    };
    const [tool] = projectTools([schema]);
    expect(tool!.name).toBe('run_tests');
    expect(tool!.version).toBe('1.0');
    expect(tool!.description).toBe('Run the test suite');
    expect(tool!.input_schema).toEqual(schema.input_schema);
    expect(tool!.output_schema).toEqual(schema.output_schema);
  });

  it('input_schema passes through verbatim (needed for mx_delegate_tool T105)', () => {
    const deepSchema = { type: 'object', properties: { x: { type: 'number', minimum: 0 } }, required: ['x'] };
    const [tool] = projectTools([{ name: 'my_tool', input_schema: deepSchema }]);
    expect(tool!.input_schema).toEqual(deepSchema);
  });

  it('optional fields (version, description, input_schema, output_schema) are absent when not in source', () => {
    const [tool] = projectTools([{ name: 'minimal_tool' }]);
    expect(tool!.name).toBe('minimal_tool');
    expect(Object.prototype.hasOwnProperty.call(tool, 'version')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(tool, 'description')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(tool, 'input_schema')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(tool, 'output_schema')).toBe(false);
  });

  it('input_schema that is not an object is omitted', () => {
    const [tool] = projectTools([{ name: 'tool_1', input_schema: 'not-an-object' }]);
    expect(Object.prototype.hasOwnProperty.call(tool, 'input_schema')).toBe(false);
  });

  it('processes multiple schemas, skipping invalid entries', () => {
    const schemas = [
      { name: 'tool_a' },
      { no_name: true },
      { name: 'tool_b', version: '2.0' },
    ];
    const tools = projectTools(schemas);
    expect(tools).toHaveLength(2);
    expect(tools[0]!.name).toBe('tool_a');
    expect(tools[1]!.name).toBe('tool_b');
  });
});

// ---------------------------------------------------------------------------
// publishedToolNames
// ---------------------------------------------------------------------------

describe('publishedToolNames', () => {
  it('extracts names from schemas', () => {
    const resp = { schemas: [{ name: 'tool_a' }, { name: 'tool_b' }] };
    expect(publishedToolNames(resp)).toEqual(['tool_a', 'tool_b']);
  });

  it('supplements from tools array when it carries names', () => {
    const resp = { schemas: [{ name: 'tool_a' }], tools: ['tool_b'] };
    const names = publishedToolNames(resp);
    expect(names).toContain('tool_a');
    expect(names).toContain('tool_b');
  });

  it('deduplicates names appearing in both schemas and tools', () => {
    const resp = { schemas: [{ name: 'tool_a' }], tools: ['tool_a', 'tool_b'] };
    const names = publishedToolNames(resp);
    const toolACount = names.filter((n) => n === 'tool_a').length;
    expect(toolACount).toBe(1);
  });

  it('non-record input → []', () => {
    expect(publishedToolNames(null)).toEqual([]);
    expect(publishedToolNames('not-a-record')).toEqual([]);
  });

  it('missing schemas → []', () => {
    expect(publishedToolNames({ tools: [] })).toEqual([]);
  });
});
