import { describe, expect, it } from 'vitest';

// The toolbelt's T008 guard regex is the authoritative secret-free oracle
// (packages/toolbelt/src/guards.ts). Importing it here proves the canonical
// input schemas never declare a field the runtime dispatch guard would reject.
import { CREDENTIAL_KEY_RE as TOOLBELT_CREDENTIAL_KEY_RE } from '@mx-loom/toolbelt';

import {
  CANONICAL_M1_TOOLS,
  CREDENTIAL_KEY_RE,
  collectSchemaPropertyNames,
  DescriptorValidationError,
  loadRegistry,
  type ToolDescriptor,
} from '../src/index.js';

// Focused smoke coverage of the two acceptance criteria + the headline security
// invariants. The comprehensive per-descriptor suite (descriptor / registry /
// security-invariants / descriptors) is authored in the dedicated tests phase
// per the spec's Testing Plan.
describe('loadRegistry (T101 smoke)', () => {
  it('loads the default canonical set, frozen and enumerable (AC 2)', () => {
    const registry = loadRegistry();
    const names = registry.list().map((d) => d.name);
    expect(names).toEqual([
      'mx_find_agents',
      'mx_describe_agent',
      'mx_delegate_tool',
      'mx_run_command',
      'mx_await_result',
      'mx_share_context',
      'mx_get_context',
      'mx_cancel',
      'mx_workspace_status',
    ]);
    expect(registry.has('mx_delegate_tool')).toBe(true);
    expect(registry.get('mx_delegate_tool')?.async_semantics).toBe('deferred');
    expect(registry.get('nope')).toBeUndefined();
    // Iteration sugar for binding generators.
    expect([...registry].map((d) => d.name)).toEqual(names);
    // Frozen to consumers.
    expect(Object.isFrozen(registry.list())).toBe(true);
    expect(Object.isFrozen(registry.get('mx_find_agents'))).toBe(true);
  });

  it('a fake binding generator can render a tool list from the registry (AC 2)', () => {
    const tools = [...loadRegistry()].map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: d.input_schema,
      deferred: d.async_semantics === 'deferred',
    }));
    expect(tools).toHaveLength(9);
    expect(tools.every((t) => t.name.startsWith('mx_') && t.description.length > 0)).toBe(true);
  });

  it('rejects a malformed JSON Schema (AC 1)', () => {
    const bad: ToolDescriptor = {
      name: 'mx_bad_schema',
      description: 'has an illegal type keyword',
      async_semantics: 'sync',
      input_schema: { type: 'not-a-real-type' },
      output_schema: { type: 'object' },
    };
    expect(() => loadRegistry([bad])).toThrow(DescriptorValidationError);
    try {
      loadRegistry([bad]);
    } catch (err) {
      expect((err as DescriptorValidationError).descriptor).toBe('mx_bad_schema');
      expect((err as DescriptorValidationError).reason).toContain('input_schema');
    }
  });

  it('every authored input_schema and output_schema compiles as JSON Schema (AC 1)', () => {
    // loadRegistry compiles every schema at construction; a clean load proves it.
    expect(() => loadRegistry(CANONICAL_M1_TOOLS)).not.toThrow();
  });

  it('rejects structural faults: non-mx name, empty description, bad async, duplicate', () => {
    const base = CANONICAL_M1_TOOLS[0]!;
    expect(() => loadRegistry([{ ...base, name: 'find_agents' }])).toThrow(DescriptorValidationError);
    expect(() => loadRegistry([{ ...base, description: '   ' }])).toThrow(DescriptorValidationError);
    expect(() => loadRegistry([{ ...base, async_semantics: 'maybe' as never }])).toThrow(DescriptorValidationError);
    expect(() => loadRegistry([base, base])).toThrow(/duplicate/);
  });

  it('refuses an authority-mutation verb (no-authority invariant)', () => {
    // `trust.publish` is not mx_*, so it fails the name regex first — either way
    // an authority verb can never enter the registry.
    expect(() => loadRegistry([{ ...CANONICAL_M1_TOOLS[0]!, name: 'trust.publish' }])).toThrow(
      DescriptorValidationError,
    );
  });

  it('no canonical input_schema declares a credential-shaped field (secret-free oracle)', () => {
    // Pin the registry-local regex against the toolbelt's exported oracle (no drift).
    expect(CREDENTIAL_KEY_RE.source).toBe(TOOLBELT_CREDENTIAL_KEY_RE.source);
    expect(CREDENTIAL_KEY_RE.flags).toBe(TOOLBELT_CREDENTIAL_KEY_RE.flags);
    for (const descriptor of CANONICAL_M1_TOOLS) {
      for (const field of ['input_schema', 'output_schema'] as const) {
        const offenders = collectSchemaPropertyNames(descriptor[field]).filter((n) =>
          TOOLBELT_CREDENTIAL_KEY_RE.test(n),
        );
        expect(offenders, `${descriptor.name}.${field}`).toEqual([]);
      }
    }
  });

  it('mx_delegate_tool keeps args an OPEN object (dynamic inner schema)', () => {
    const args = (loadRegistry().get('mx_delegate_tool')?.input_schema as Record<string, unknown>).properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(args.args?.type).toBe('object');
    expect(args.args?.additionalProperties).toBe(true);
    expect(args.args?.properties).toBeUndefined();
  });
});
