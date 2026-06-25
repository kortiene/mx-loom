/**
 * Per-descriptor content tests for the three T301 task-DAG verbs
 * (`mx_create_task` / `mx_update_task` / `mx_list_tasks`).
 *
 * Mirrors the structure of `descriptors.test.ts` (the M1 verbs). Pure content
 * assertions — no daemon, no env, no network.
 *
 * Tests pin:
 *  - Individual const exports are present, frozen, and in `CANONICAL_M3_TASK_TOOLS`.
 *  - All three are `async_semantics: 'sync'` (authoring the plan record is not approval-gated).
 *  - The two mutating verbs (`mx_create_task` / `mx_update_task`) declare an optional
 *    `idempotency_key`; the read verb (`mx_list_tasks`) does not.
 *  - `mx_create_task` requires `title`; `mx_update_task` requires `task_id`; `mx_list_tasks`
 *    has no required fields.
 *  - `mx_list_tasks.input_schema.view` defaults to `'graph'` so "list reflects the DAG"
 *    holds out of the box.
 *  - The state enum on all three input schemas is exactly the 6 canonical tokens; the
 *    output `state` enum adds `'unknown'` (the safe fallback).
 *  - The `action` sub-schema on `mx_create_task` uses a flat kind-discriminator (`oneOf`
 *    is intentionally absent — the Pi/Claude schema converters fail closed on it).
 *  - Input schemas are closed (`additionalProperties: false`); output schemas are open
 *    (`additionalProperties: true`).
 *  - No input schema declares a credential-shaped property name.
 *  - `CANONICAL_TOOLS` (the full 13-verb set) contains the 4 task verbs in stable position.
 */
import { describe, expect, it } from 'vitest';

import { CREDENTIAL_KEY_RE as TOOLBELT_CREDENTIAL_KEY_RE } from '@mx-loom/toolbelt';

import {
  CANONICAL_M3_TASK_TOOLS,
  CANONICAL_TOOLS,
  MX_CREATE_TASK,
  MX_DISPATCH_TASK,
  MX_LIST_TASKS,
  MX_UPDATE_TASK,
  TOOL_NAME_RE,
  collectSchemaPropertyNames,
  findCredentialShapedProperty,
} from '../src/index.js';

// The canonical 6 task states the model can set.
const INPUT_TASK_STATES = ['proposed', 'pending', 'assigned', 'executing', 'succeeded', 'failed'] as const;
// The 7 states the output may carry (adds `unknown`).
const OUTPUT_TASK_STATES = [...INPUT_TASK_STATES, 'unknown'] as const;

// ---------------------------------------------------------------------------
// Individual const exports + CANONICAL_M3_TASK_TOOLS membership
// ---------------------------------------------------------------------------

describe('individual task descriptor consts', () => {
  const TASK_TOOLS = [MX_CREATE_TASK, MX_UPDATE_TASK, MX_LIST_TASKS];

  it('all 3 task descriptor consts are defined and frozen', () => {
    for (const d of TASK_TOOLS) {
      expect(d).toBeDefined();
      expect(Object.isFrozen(d)).toBe(true);
    }
  });

  it('CANONICAL_M3_TASK_TOOLS contains exactly the 4 task descriptors in order', () => {
    expect(CANONICAL_M3_TASK_TOOLS).toHaveLength(4);
    expect(CANONICAL_M3_TASK_TOOLS[0]).toBe(MX_CREATE_TASK);
    expect(CANONICAL_M3_TASK_TOOLS[1]).toBe(MX_UPDATE_TASK);
    expect(CANONICAL_M3_TASK_TOOLS[2]).toBe(MX_LIST_TASKS);
    expect(CANONICAL_M3_TASK_TOOLS[3]).toBe(MX_DISPATCH_TASK);
  });

  it('CANONICAL_TOOLS ends with the 4 task verbs at positions 9–12', () => {
    expect(CANONICAL_TOOLS).toHaveLength(13);
    expect(CANONICAL_TOOLS[9]).toBe(MX_CREATE_TASK);
    expect(CANONICAL_TOOLS[10]).toBe(MX_UPDATE_TASK);
    expect(CANONICAL_TOOLS[11]).toBe(MX_LIST_TASKS);
    expect(CANONICAL_TOOLS[12]).toBe(MX_DISPATCH_TASK);
  });

  it('every task descriptor name matches TOOL_NAME_RE', () => {
    for (const d of TASK_TOOLS) {
      expect(TOOL_NAME_RE.test(d.name)).toBe(true);
    }
  });

  it('every task descriptor has a non-empty description', () => {
    for (const d of TASK_TOOLS) {
      expect(d.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('task verb names are exactly mx_create_task, mx_update_task, mx_list_tasks', () => {
    expect(MX_CREATE_TASK.name).toBe('mx_create_task');
    expect(MX_UPDATE_TASK.name).toBe('mx_update_task');
    expect(MX_LIST_TASKS.name).toBe('mx_list_tasks');
  });
});

// ---------------------------------------------------------------------------
// async_semantics — all three task verbs are sync
// ---------------------------------------------------------------------------

describe('async_semantics — all three task verbs are sync', () => {
  it('mx_create_task is sync (authoring the plan record is not approval-gated)', () =>
    expect(MX_CREATE_TASK.async_semantics).toBe('sync'));
  it('mx_update_task is sync (state transition is not approval-gated in M3)', () =>
    expect(MX_UPDATE_TASK.async_semantics).toBe('sync'));
  it('mx_list_tasks is sync (a local read)', () =>
    expect(MX_LIST_TASKS.async_semantics).toBe('sync'));
});

// ---------------------------------------------------------------------------
// mx_create_task — input_schema
// ---------------------------------------------------------------------------

describe('mx_create_task descriptor', () => {
  type InputSchema = {
    type: string;
    properties: Record<string, {
      type?: string;
      enum?: string[];
      default?: unknown;
      items?: { type: string };
      properties?: Record<string, unknown>;
      required?: string[];
      additionalProperties?: unknown;
    }>;
    required?: string[];
    additionalProperties: boolean;
  };

  const input = MX_CREATE_TASK.input_schema as InputSchema;
  const output = MX_CREATE_TASK.output_schema as {
    properties: Record<string, { type?: string | string[]; enum?: string[] }>;
    required?: string[];
    additionalProperties: unknown;
  };

  it('requires title and nothing else', () => {
    const required = input.required ?? [];
    expect(required).toContain('title');
    expect(required).not.toContain('depends_on');
    expect(required).not.toContain('blocks');
    expect(required).not.toContain('assign');
    expect(required).not.toContain('state');
    expect(required).not.toContain('action');
    expect(required).not.toContain('idempotency_key');
  });

  it('is a closed input schema (additionalProperties: false)', () => {
    expect(input.additionalProperties).toBe(false);
  });

  it('declares idempotency_key as an optional string (mutating verb)', () => {
    expect(input.properties.idempotency_key?.type).toBe('string');
    expect(input.required ?? []).not.toContain('idempotency_key');
  });

  it('depends_on and blocks are optional string arrays', () => {
    expect(input.properties.depends_on?.type).toBe('array');
    expect(input.properties.depends_on?.items?.type).toBe('string');
    expect(input.properties.blocks?.type).toBe('array');
    expect(input.properties.blocks?.items?.type).toBe('string');
    expect(input.required ?? []).not.toContain('depends_on');
    expect(input.required ?? []).not.toContain('blocks');
  });

  it('state enum is exactly the 6 input task states with default "proposed"', () => {
    const stateProp = input.properties.state;
    expect(stateProp?.type).toBe('string');
    expect(stateProp?.enum).toEqual([...INPUT_TASK_STATES]);
    expect(stateProp?.default).toBe('proposed');
  });

  it('action is optional and uses a flat kind-discriminator (NOT oneOf/anyOf)', () => {
    const actionProp = input.properties.action;
    expect(actionProp).toBeDefined();
    expect(input.required ?? []).not.toContain('action');
    // The kind discriminator must NOT use oneOf/anyOf — Pi/Claude converters fail closed.
    const actionSchema = actionProp as Record<string, unknown>;
    expect(actionSchema.oneOf).toBeUndefined();
    expect(actionSchema.anyOf).toBeUndefined();
  });

  it('action.required is ["kind"] (the discriminator is the only required field)', () => {
    const actionProp = input.properties.action as { required?: string[] };
    expect(actionProp.required).toEqual(['kind']);
  });

  it('action.kind enum is exactly ["tool", "exec"]', () => {
    type ActionProps = { properties: Record<string, { enum?: string[] }> };
    const actionProps = (input.properties.action as ActionProps).properties;
    expect(actionProps.kind?.enum).toEqual(['tool', 'exec']);
  });

  it('action is a closed sub-schema (additionalProperties: false)', () => {
    type ActionSchema = { additionalProperties?: unknown };
    expect((input.properties.action as ActionSchema).additionalProperties).toBe(false);
  });

  it('output_schema is open (additionalProperties: true — daemon-added fields are non-breaking)', () => {
    expect(output.additionalProperties).toBe(true);
  });

  it('output_schema requires task_id, title, state, assignee, depends_on, blocks, action', () => {
    const required = output.required ?? [];
    for (const field of ['task_id', 'title', 'state', 'assignee', 'depends_on', 'blocks', 'action']) {
      expect(required).toContain(field);
    }
  });

  it('output_schema.state enum includes "unknown" (the safe fallback for unrecognised daemon tokens)', () => {
    const stateOut = output.properties.state;
    expect(stateOut?.enum).toEqual([...OUTPUT_TASK_STATES]);
  });

  it('output_schema.assignee is string | null (not required to be set)', () => {
    const assignee = output.properties.assignee;
    expect(assignee?.type).toContain('null');
    expect(assignee?.type).toContain('string');
  });

  it('no input property is credential-shaped (enforced by the fail-fast loader)', () => {
    expect(findCredentialShapedProperty(MX_CREATE_TASK.input_schema, TOOLBELT_CREDENTIAL_KEY_RE)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mx_update_task — input_schema
// ---------------------------------------------------------------------------

describe('mx_update_task descriptor', () => {
  type InputSchema = {
    properties: Record<string, { type?: string; enum?: string[]; items?: { type: string } }>;
    required?: string[];
    additionalProperties: boolean;
  };

  const input = MX_UPDATE_TASK.input_schema as InputSchema;
  const output = MX_UPDATE_TASK.output_schema as {
    properties: Record<string, { type?: string | string[]; enum?: string[] }>;
    required?: string[];
    additionalProperties: unknown;
  };

  it('requires task_id and nothing else', () => {
    const required = input.required ?? [];
    expect(required).toContain('task_id');
    expect(required).not.toContain('state');
    expect(required).not.toContain('assign');
    expect(required).not.toContain('depends_on');
    expect(required).not.toContain('blocks');
    expect(required).not.toContain('idempotency_key');
  });

  it('is a closed input schema (additionalProperties: false)', () => {
    expect(input.additionalProperties).toBe(false);
  });

  it('declares idempotency_key as an optional string (mutating verb)', () => {
    expect(input.properties.idempotency_key?.type).toBe('string');
    expect(input.required ?? []).not.toContain('idempotency_key');
  });

  it('state is optional and restricted to the 6 canonical task states', () => {
    const stateProp = input.properties.state;
    expect(stateProp?.type).toBe('string');
    expect(stateProp?.enum).toEqual([...INPUT_TASK_STATES]);
    expect(input.required ?? []).not.toContain('state');
  });

  it('assign is an optional string', () => {
    expect(input.properties.assign?.type).toBe('string');
    expect(input.required ?? []).not.toContain('assign');
  });

  it('depends_on and blocks are optional string arrays', () => {
    expect(input.properties.depends_on?.type).toBe('array');
    expect(input.properties.blocks?.type).toBe('array');
  });

  it('output_schema is open (additionalProperties: true)', () => {
    expect(output.additionalProperties).toBe(true);
  });

  it('output_schema.state enum includes "unknown" fallback', () => {
    expect(output.properties.state?.enum).toEqual([...OUTPUT_TASK_STATES]);
  });

  it('no input property is credential-shaped', () => {
    expect(findCredentialShapedProperty(MX_UPDATE_TASK.input_schema, TOOLBELT_CREDENTIAL_KEY_RE)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mx_list_tasks — input_schema
// ---------------------------------------------------------------------------

describe('mx_list_tasks descriptor', () => {
  type InputSchema = {
    properties: Record<string, { type?: string; enum?: string[]; default?: unknown }>;
    required?: string[];
    additionalProperties: boolean;
  };

  const input = MX_LIST_TASKS.input_schema as InputSchema;
  const output = MX_LIST_TASKS.output_schema as {
    properties: Record<string, { type?: string; items?: unknown }>;
    required?: string[];
    additionalProperties: unknown;
  };

  it('has no required fields (all filters are optional)', () => {
    expect(input.required ?? []).toEqual([]);
  });

  it('is a closed input schema (additionalProperties: false)', () => {
    expect(input.additionalProperties).toBe(false);
  });

  it('does NOT declare idempotency_key (read verb — not mutating)', () => {
    expect(input.properties.idempotency_key).toBeUndefined();
  });

  it('view defaults to "graph" so "list reflects the DAG" holds out of the box', () => {
    const viewProp = input.properties.view;
    expect(viewProp?.type).toBe('string');
    expect(viewProp?.enum).toEqual(['list', 'graph']);
    expect(viewProp?.default).toBe('graph');
  });

  it('state filter is an optional enum of the 6 canonical task states', () => {
    const stateProp = input.properties.state;
    expect(stateProp?.type).toBe('string');
    expect(stateProp?.enum).toEqual([...INPUT_TASK_STATES]);
    expect(input.required ?? []).not.toContain('state');
  });

  it('assignee is an optional string filter', () => {
    expect(input.properties.assignee?.type).toBe('string');
    expect(input.required ?? []).not.toContain('assignee');
  });

  it('output_schema requires tasks array', () => {
    expect(output.required ?? []).toContain('tasks');
    expect(output.properties.tasks?.type).toBe('array');
  });

  it('output_schema.edges is an array of { from, to, kind } objects', () => {
    const edges = output.properties.edges as {
      type?: string;
      items?: {
        properties?: Record<string, { type?: string; enum?: string[] }>;
        required?: string[];
      };
    } | undefined;
    expect(edges?.type).toBe('array');
    expect(edges?.items?.properties?.from?.type).toBe('string');
    expect(edges?.items?.properties?.to?.type).toBe('string');
    expect(edges?.items?.properties?.kind?.enum).toEqual(['depends_on', 'blocks']);
    expect(edges?.items?.required ?? []).toContain('from');
    expect(edges?.items?.required ?? []).toContain('to');
    expect(edges?.items?.required ?? []).toContain('kind');
  });

  it('no input property is credential-shaped', () => {
    expect(findCredentialShapedProperty(MX_LIST_TASKS.input_schema, TOOLBELT_CREDENTIAL_KEY_RE)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mx_dispatch_task — descriptor-specific tests
// ---------------------------------------------------------------------------

describe('mx_dispatch_task descriptor', () => {
  type InputSchema = {
    type: string;
    properties: Record<string, { type?: string; minimum?: number; description?: string }>;
    required?: string[];
    additionalProperties: boolean;
  };

  const input = MX_DISPATCH_TASK.input_schema as InputSchema;
  const output = MX_DISPATCH_TASK.output_schema as {
    type?: string;
    additionalProperties: unknown;
  };

  it('name is mx_dispatch_task', () => {
    expect(MX_DISPATCH_TASK.name).toBe('mx_dispatch_task');
  });

  it('is async_semantics: deferred (dispatched actions are approval-gatable, unlike the sync authoring verbs)', () => {
    expect(MX_DISPATCH_TASK.async_semantics).toBe('deferred');
  });

  it('is defined and frozen', () => {
    expect(MX_DISPATCH_TASK).toBeDefined();
    expect(Object.isFrozen(MX_DISPATCH_TASK)).toBe(true);
  });

  it('has a non-empty description', () => {
    expect(MX_DISPATCH_TASK.description.trim().length).toBeGreaterThan(0);
  });

  it('requires only task_id', () => {
    const required = input.required ?? [];
    expect(required).toContain('task_id');
    expect(required).not.toContain('wait_ms');
    expect(required).not.toContain('idempotency_key');
  });

  it('task_id is a required string', () => {
    expect(input.properties.task_id?.type).toBe('string');
  });

  it('wait_ms is an optional integer with minimum 0', () => {
    expect(input.properties.wait_ms?.type).toBe('integer');
    expect(input.properties.wait_ms?.minimum).toBe(0);
    expect(input.required ?? []).not.toContain('wait_ms');
  });

  it('idempotency_key is an optional string (dedup nonce, task-stable when omitted)', () => {
    expect(input.properties.idempotency_key?.type).toBe('string');
    expect(input.required ?? []).not.toContain('idempotency_key');
  });

  it('is a closed input schema (additionalProperties: false)', () => {
    expect(input.additionalProperties).toBe(false);
  });

  it('output_schema is open (additionalProperties: true — inner tool result shape is dynamic)', () => {
    expect(output.additionalProperties).toBe(true);
  });

  it('no input property is credential-shaped', () => {
    expect(findCredentialShapedProperty(MX_DISPATCH_TASK.input_schema, TOOLBELT_CREDENTIAL_KEY_RE)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Global security pass — all task descriptor schemas are credential-free
// ---------------------------------------------------------------------------

describe('task descriptor schemas — global security pass', () => {
  it('no task input_schema declares a credential-shaped property', () => {
    for (const d of CANONICAL_M3_TASK_TOOLS) {
      const offender = findCredentialShapedProperty(d.input_schema, TOOLBELT_CREDENTIAL_KEY_RE);
      expect(offender, `${d.name}.input_schema must be credential-free`).toBeUndefined();
    }
  });

  it('no task output_schema declares a credential-shaped property', () => {
    for (const d of CANONICAL_M3_TASK_TOOLS) {
      const offender = findCredentialShapedProperty(d.output_schema, TOOLBELT_CREDENTIAL_KEY_RE);
      expect(offender, `${d.name}.output_schema must be credential-free`).toBeUndefined();
    }
  });

  it('all property names in task schemas do not match TOOLBELT_CREDENTIAL_KEY_RE', () => {
    for (const d of CANONICAL_M3_TASK_TOOLS) {
      for (const field of ['input_schema', 'output_schema'] as const) {
        const names = collectSchemaPropertyNames(d[field]);
        for (const name of names) {
          expect(TOOLBELT_CREDENTIAL_KEY_RE.test(name), `${d.name}.${field}.${name} must not be credential-shaped`).toBe(false);
        }
      }
    }
  });
});
