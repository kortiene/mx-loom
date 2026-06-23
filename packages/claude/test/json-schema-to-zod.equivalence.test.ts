/**
 * The T111 acceptance criterion, proven mechanically:
 *
 *   "All v1 tool input schemas convert and validate equivalently."
 *
 * For each of the nine `CANONICAL_M1_TOOLS` descriptors we build the Zod schema
 * via the converter AND compile the JSON Schema via the registry's
 * `createAjvValidator()` — the *same* Ajv seam the loader and the T105 dispatch
 * guard use, so "validate equivalently" is proven against the authoritative
 * validator, not a second independent one. For a per-descriptor table of
 * representative valid + invalid samples (plus a universal non-object battery), we
 * assert `ajvValidate(sample) === zodSchema.safeParse(sample).success` — the two
 * validators must agree on EVERY sample.
 */
import { describe, it, expect } from 'vitest';

import { CANONICAL_M1_TOOLS, createAjvValidator } from '@mx-loom/registry';
import type { ToolDescriptor } from '@mx-loom/registry';

import { jsonSchemaToZod, jsonSchemaToZodRawShape } from '../src/index.js';

/** Samples that EVERY object-rooted schema must reject (JSON Schema `type:object`). */
const NON_OBJECT_SAMPLES: unknown[] = ['a string', 42, true, null, ['a', 'b'], 3.14];

/**
 * Per-descriptor representative samples — a deliberate mix of valid baselines and
 * each invalid axis the spec calls out (missing-required, extra-key, wrong-type,
 * enum-out-of-range, negative-where-minimum:0, non-integer-for-integer, the open
 * `args` object with nested content, and `args` as a non-object).
 */
const SAMPLES: Record<string, unknown[]> = {
  mx_find_agents: [
    {}, // all-optional baseline
    { capability: 'build' },
    { tool: 'run_tests' },
    { liveness: 'active' },
    { capability: 'a', tool: 'b', liveness: 'stale' },
    { liveness: 'gone' }, // enum out of range
    { capability: 5 }, // wrong type
    { unknown: 1 }, // extra key (closed)
  ],
  mx_describe_agent: [
    { agent_id: 'agent-1' },
    {}, // missing required
    { agent_id: 5 }, // wrong type
    { agent_id: 'a', extra: 'x' }, // extra key
  ],
  mx_delegate_tool: [
    { agent: 'a', tool: 't', args: {} },
    { agent: 'a', tool: 't', args: { foo: 'bar', nested: { x: [1, 2] } } },
    { agent: 'a', tool: 't', args: {}, wait_ms: 0 },
    { agent: 'a', tool: 't', args: {}, wait_ms: 100, idempotency_key: 'idem-1' },
    { agent: 'a', tool: 't' }, // missing args (required)
    { agent: 'a', tool: 't', args: 'not-an-object' }, // open arg must reject non-object
    { agent: 'a', tool: 't', args: [1, 2] }, // args as array
    { agent: 'a', tool: 't', args: {}, wait_ms: -1 }, // negative where minimum:0
    { agent: 'a', tool: 't', args: {}, wait_ms: 1.5 }, // non-integer
    { agent: 'a', tool: 't', args: {}, extra: 1 }, // extra key (closed outer)
    { agent: 5, tool: 't', args: {} }, // wrong type
  ],
  mx_run_command: [
    { agent: 'a', command: 'ls' },
    { agent: 'a', command: 'ls', args: ['-l', '-a'] },
    { agent: 'a', command: 'ls', args: [], cwd: '/tmp', wait_ms: 0, idempotency_key: 'k' },
    { agent: 'a' }, // missing command
    { agent: 'a', command: 'ls', args: [1] }, // non-string array item
    { agent: 'a', command: 'ls', args: '-l' }, // args not an array
    { agent: 'a', command: 'ls', wait_ms: -1 }, // negative
    { agent: 'a', command: 'ls', extra: 1 }, // extra key
  ],
  mx_await_result: [
    { handle: 'inv-1' },
    { handle: 'inv-1', wait_ms: 50 },
    {}, // missing required
    { handle: 'inv-1', wait_ms: -1 }, // negative
    { handle: 5 }, // wrong type
    { handle: 'inv-1', extra: 1 }, // extra key
  ],
  mx_share_context: [
    { kind: 'file' },
    { kind: 'diff', path: 'p', content: 'c', encoding: 'utf-8' },
    { kind: 'env', encoding: 'base64' },
    {}, // missing kind
    { kind: 'other' }, // enum out of range
    { kind: 'file', encoding: 'utf-16' }, // encoding enum out of range
    { kind: 'file', extra: 1 }, // extra key
    { kind: 5 }, // wrong type
  ],
  mx_get_context: [
    { context_id: 'ctx-1' },
    {}, // missing required
    { context_id: 5 }, // wrong type
    { context_id: 'ctx-1', extra: 1 }, // extra key
  ],
  mx_cancel: [
    { handle: 'inv-1' },
    {}, // missing required
    { handle: 5 }, // wrong type
    { handle: 'inv-1', extra: 1 }, // extra key
  ],
  mx_workspace_status: [
    {}, // closed empty: only {} is valid
    { anything: 1 }, // extra key (closed empty)
  ],
};

const byName = new Map(CANONICAL_M1_TOOLS.map((t) => [t.name, t]));

describe('AC — all nine canonical input schemas convert and validate equivalently', () => {
  it('covers all nine canonical tools with a sample table', () => {
    expect(CANONICAL_M1_TOOLS).toHaveLength(9);
    for (const tool of CANONICAL_M1_TOOLS) {
      expect(SAMPLES[tool.name], `missing samples for ${tool.name}`).toBeDefined();
    }
  });

  for (const tool of CANONICAL_M1_TOOLS) {
    describe(tool.name, () => {
      const descriptor = byName.get(tool.name) as ToolDescriptor;
      const ajv = createAjvValidator().compile(descriptor.input_schema);
      const zodSchema = jsonSchemaToZod(descriptor.input_schema);
      const samples = [...(SAMPLES[tool.name] ?? []), ...NON_OBJECT_SAMPLES];

      it.each(samples.map((s, i) => [i, s] as const))(
        'Ajv and Zod agree on sample #%i',
        (_i, sample) => {
          const ajvOk = ajv(sample);
          const zodOk = zodSchema.safeParse(sample).success;
          expect(
            zodOk,
            `disagreement on ${JSON.stringify(sample)} — Ajv:${ajvOk} Zod:${zodOk}`,
          ).toBe(ajvOk);
        },
      );

      it('rejects every non-object value (matching JSON Schema type:object)', () => {
        for (const sample of NON_OBJECT_SAMPLES) {
          expect(ajv(sample)).toBe(false);
          expect(zodSchema.safeParse(sample).success).toBe(false);
        }
      });

      it('exercises both an accept and a reject (the table is non-trivial)', () => {
        const results = samples.map((s) => zodSchema.safeParse(s).success);
        expect(results).toContain(true);
        expect(results).toContain(false);
      });
    });
  }
});

describe('property preservation — the converter neither adds nor drops fields', () => {
  for (const tool of CANONICAL_M1_TOOLS) {
    it(`${tool.name}: converted shape keys === input_schema properties keys`, () => {
      const schema = tool.input_schema as { properties?: Record<string, unknown> };
      const expectedKeys = Object.keys(schema.properties ?? {}).sort();
      const shapeKeys = Object.keys(jsonSchemaToZodRawShape(tool.input_schema)).sort();
      expect(shapeKeys).toEqual(expectedKeys);
    });
  }
});
