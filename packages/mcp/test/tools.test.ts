/**
 * Tool generator (T109) — AC1: an MCP client lists all nine `mx_*` tools with
 * correct names/descriptions and the descriptors' **input JSON Schemas verbatim**.
 * Plus the no-authority invariant (the surfaced set is exactly the nine
 * model-facing verbs; intersection with forbidden authority verbs is empty).
 */
import { describe, expect, it } from 'vitest';

import { CANONICAL_M1_TOOLS, ENVELOPE_SCHEMA, FORBIDDEN_AUTHORITY_VERBS } from '@mx-loom/registry';
import type { ToolDescriptor } from '@mx-loom/registry';

import { ASYNC_SEMANTICS_META_KEY, buildToolList } from '../src/tools.js';

describe('buildToolList', () => {
  const tools = buildToolList();

  it('lists exactly the nine canonical verbs, in order', () => {
    expect(tools).toHaveLength(9);
    expect(tools.map((t) => t.name)).toEqual(CANONICAL_M1_TOOLS.map((d) => d.name));
  });

  it('passes name/description/inputSchema through verbatim', () => {
    for (const descriptor of CANONICAL_M1_TOOLS) {
      const tool = tools.find((t) => t.name === descriptor.name)!;
      expect(tool.description).toBe(descriptor.description);
      // Deep-equal AND same reference — verbatim pass-through, no clone/mutation drift.
      expect(tool.inputSchema).toEqual(descriptor.input_schema);
      expect(tool.inputSchema).toBe(descriptor.input_schema);
    }
  });

  it('advertises the T102 ENVELOPE_SCHEMA as outputSchema, not the bare-result schema', () => {
    // structuredContent always carries the full T102 envelope, so the advertised
    // outputSchema must be the envelope schema. Advertising the descriptor's
    // bare-result output_schema made a conformant MCP client reject the envelope
    // with -32602 on every non-open-output verb (the blocker).
    for (const descriptor of CANONICAL_M1_TOOLS) {
      const tool = tools.find((t) => t.name === descriptor.name)!;
      expect(tool.outputSchema).toBe(ENVELOPE_SCHEMA);
    }
  });

  it('mirrors async_semantics honestly into _meta', () => {
    for (const descriptor of CANONICAL_M1_TOOLS) {
      const tool = tools.find((t) => t.name === descriptor.name)!;
      expect(tool._meta?.[ASYNC_SEMANTICS_META_KEY]).toBe(descriptor.async_semantics);
    }
  });

  it('claims no readOnlyHint (mutating verbs exist) and an open world', () => {
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBeUndefined();
      expect(tool.annotations?.openWorldHint).toBe(true);
    }
  });

  it('surfaces no forbidden authority verb (no-authority invariant)', () => {
    const names = new Set(tools.map((t) => t.name));
    for (const forbidden of FORBIDDEN_AUTHORITY_VERBS) {
      expect(names.has(forbidden)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// buildToolList with custom / empty descriptor sets
// ---------------------------------------------------------------------------

describe('buildToolList with custom descriptor sets', () => {
  it('returns an empty array for an empty descriptor set', () => {
    const result = buildToolList([]);
    expect(result).toHaveLength(0);
    expect(result).toEqual([]);
  });

  it('returns exactly one tool for a single synthetic descriptor', () => {
    const synthetic: ToolDescriptor = {
      name: 'mx_test_only',
      description: 'A synthetic descriptor used only in this test.',
      input_schema: { type: 'object', properties: { x: { type: 'number' } } },
      output_schema: { type: 'object', additionalProperties: true },
      async_semantics: 'sync',
    };

    const result = buildToolList([synthetic]);

    expect(result).toHaveLength(1);
    const tool = result[0]!;
    expect(tool.name).toBe('mx_test_only');
    expect(tool.description).toBe('A synthetic descriptor used only in this test.');
    // inputSchema is the SAME reference object (verbatim pass-through); outputSchema
    // is the shared T102 envelope schema, never the descriptor's bare-result schema.
    expect(tool.inputSchema).toBe(synthetic.input_schema);
    expect(tool.outputSchema).toBe(ENVELOPE_SCHEMA);
    expect(tool._meta?.[ASYNC_SEMANTICS_META_KEY]).toBe('sync');
  });

  it('deferred async_semantics is mirrored into _meta for a custom descriptor', () => {
    const deferred: ToolDescriptor = {
      name: 'mx_test_deferred',
      description: 'A synthetic deferred descriptor.',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      async_semantics: 'deferred',
    };

    const [tool] = buildToolList([deferred]);
    expect(tool!._meta?.[ASYNC_SEMANTICS_META_KEY]).toBe('deferred');
  });

  it('only the supplied descriptors appear — does not include CANONICAL_M1_TOOLS', () => {
    const synthetic: ToolDescriptor = {
      name: 'mx_test_isolated',
      description: 'Isolated test descriptor.',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      async_semantics: 'sync',
    };

    const result = buildToolList([synthetic]);
    const names = result.map((t) => t.name);
    for (const canonical of CANONICAL_M1_TOOLS) {
      expect(names).not.toContain(canonical.name);
    }
    expect(names).toContain('mx_test_isolated');
  });
});
