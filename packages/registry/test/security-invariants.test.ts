/**
 * Security regression tests for the T101 registry (design §2, §6, §9).
 *
 * These tests pin the no-authority invariant and the secret-free input-shape
 * contract so regressions are caught before they reach a binding generator.
 * They are the registry's second line of defence — the first is the validator
 * that runs at `loadRegistry()` construction.
 */
import { describe, expect, it } from 'vitest';

// The toolbelt's T008 guard regex is the authoritative secret-free oracle.
// Importing it here proves the registry-local copy never drifts from it.
import { CREDENTIAL_KEY_RE as TOOLBELT_CREDENTIAL_KEY_RE } from '@mx-loom/toolbelt';

import {
  CANONICAL_M1_TOOLS,
  CANONICAL_TOOLS,
  collectSchemaPropertyNames,
  CREDENTIAL_KEY_RE,
  DescriptorValidationError,
  findCredentialShapedProperty,
  FORBIDDEN_AUTHORITY_PREFIXES,
  FORBIDDEN_AUTHORITY_VERBS,
  isForbiddenAuthorityVerb,
  loadRegistry,
  MODEL_FACING_ALLOWLIST,
  MX_RUN_COMMAND,
  type JsonSchema,
  type ToolDescriptor,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Exact P0 verb set
// ---------------------------------------------------------------------------

describe('default registry — exact verb set', () => {
  // The full M1 model-facing set: the 7 P0 verbs (T101) + the 2 P1 verbs (T108).
  const EXPECTED_M1 = [
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

  // The full canonical set: the 9 M1 verbs + the 3 M3 task-DAG verbs (T301).
  const EXPECTED_ALL = [...EXPECTED_M1, 'mx_create_task', 'mx_update_task', 'mx_list_tasks'] as const;

  it('default registry contains exactly the 12 canonical verbs (9 M1 + 3 M3), no more', () => {
    const names = loadRegistry().list().map((d) => d.name);
    expect(names).toEqual([...EXPECTED_ALL]);
  });

  it('every name in the default registry is mx_*-prefixed', () => {
    for (const d of loadRegistry()) {
      expect(d.name).toMatch(/^mx_/);
    }
  });

  it('every name in the default registry is in MODEL_FACING_ALLOWLIST', () => {
    const allowlist: readonly string[] = MODEL_FACING_ALLOWLIST;
    for (const d of loadRegistry()) {
      expect(allowlist).toContain(d.name);
    }
  });

  it('MODEL_FACING_ALLOWLIST includes all 9 M1 verbs', () => {
    const allowlist: readonly string[] = MODEL_FACING_ALLOWLIST;
    for (const name of EXPECTED_M1) {
      expect(allowlist).toContain(name);
    }
  });

  it('the 2 P1 verbs (mx_cancel, mx_workspace_status) are now loaded in the default registry', () => {
    const registry = loadRegistry();
    expect(registry.has('mx_cancel')).toBe(true);
    expect(registry.has('mx_workspace_status')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No-authority invariant — isForbiddenAuthorityVerb
// ---------------------------------------------------------------------------

describe('isForbiddenAuthorityVerb', () => {
  it('returns true for each FORBIDDEN_AUTHORITY_PREFIX entry (prefix check)', () => {
    for (const prefix of FORBIDDEN_AUTHORITY_PREFIXES) {
      // e.g. "trust.publish", "policy.read"
      expect(isForbiddenAuthorityVerb(`${prefix}anything`)).toBe(true);
    }
  });

  it('returns true for each FORBIDDEN_AUTHORITY_VERBS exact match', () => {
    for (const verb of FORBIDDEN_AUTHORITY_VERBS) {
      expect(isForbiddenAuthorityVerb(verb)).toBe(true);
    }
  });

  it('returns true for known authority RPCs', () => {
    expect(isForbiddenAuthorityVerb('trust.publish')).toBe(true);
    expect(isForbiddenAuthorityVerb('trust.approve')).toBe(true);
    expect(isForbiddenAuthorityVerb('trust.revoke')).toBe(true);
    expect(isForbiddenAuthorityVerb('approval.decide')).toBe(true);
    expect(isForbiddenAuthorityVerb('policy.update')).toBe(true);
    expect(isForbiddenAuthorityVerb('auth.login')).toBe(true);
    expect(isForbiddenAuthorityVerb('device.verify.start')).toBe(true);
    expect(isForbiddenAuthorityVerb('cross_signing.upload')).toBe(true);
    expect(isForbiddenAuthorityVerb('recovery.create')).toBe(true);
    expect(isForbiddenAuthorityVerb('daemon.stop')).toBe(true);
  });

  it('returns false for all valid model-facing mx_* names (M1 + M3 full set)', () => {
    for (const d of CANONICAL_TOOLS) {
      expect(isForbiddenAuthorityVerb(d.name)).toBe(false);
    }
  });

  it('returns false for arbitrary benign strings', () => {
    expect(isForbiddenAuthorityVerb('agent.list')).toBe(false);
    expect(isForbiddenAuthorityVerb('call.start')).toBe(false);
    expect(isForbiddenAuthorityVerb('share.file')).toBe(false);
    expect(isForbiddenAuthorityVerb('')).toBe(false);
  });

  it('authority RPC names also fail TOOL_NAME_RE (belt-and-suspenders: both guards block them)', () => {
    // Confirmed property: authority verbs use dots, so they can never pass the mx_* regex.
    // The isForbiddenAuthorityVerb check is a belt-and-suspenders defense, not the first gate.
    const authVerbs = ['trust.publish', 'approval.decide', 'policy.update', 'daemon.stop'];
    for (const verb of authVerbs) {
      // Fails the name regex (dot is not allowed in mx_* names)
      expect(/^mx_[a-z0-9]+(?:_[a-z0-9]+)*$/.test(verb)).toBe(false);
      // And is caught by isForbiddenAuthorityVerb
      expect(isForbiddenAuthorityVerb(verb)).toBe(true);
    }
  });

  it('loadRegistry rejects a descriptor with a forbidden authority name (redundant but regression-proof)', () => {
    // trust.publish fails the name regex first; either way, it cannot enter the registry.
    expect(() =>
      loadRegistry([{ ...CANONICAL_M1_TOOLS[0]!, name: 'trust.publish' }]),
    ).toThrow(DescriptorValidationError);
  });
});

// ---------------------------------------------------------------------------
// collectSchemaPropertyNames — recursive property-name extraction
// ---------------------------------------------------------------------------

describe('collectSchemaPropertyNames', () => {
  it('returns [] for an empty schema object', () => {
    expect(collectSchemaPropertyNames({})).toEqual([]);
  });

  it('returns [] for null or primitives', () => {
    expect(collectSchemaPropertyNames(null)).toEqual([]);
    expect(collectSchemaPropertyNames('string')).toEqual([]);
    expect(collectSchemaPropertyNames(42)).toEqual([]);
  });

  it('returns top-level property names from a flat schema', () => {
    const schema: JsonSchema = { type: 'object', properties: { foo: {}, bar: {} } };
    expect(collectSchemaPropertyNames(schema)).toContain('foo');
    expect(collectSchemaPropertyNames(schema)).toContain('bar');
  });

  it('recurses into nested properties', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        outer: {
          type: 'object',
          properties: { inner: { type: 'string' } },
        },
      },
    };
    const names = collectSchemaPropertyNames(schema);
    expect(names).toContain('outer');
    expect(names).toContain('inner');
  });

  it('recurses into allOf branches', () => {
    const schema: JsonSchema = {
      allOf: [{ properties: { allOfProp: {} } }],
    };
    expect(collectSchemaPropertyNames(schema)).toContain('allOfProp');
  });

  it('recurses into anyOf branches', () => {
    const schema: JsonSchema = {
      anyOf: [{ properties: { anyOfProp: {} } }],
    };
    expect(collectSchemaPropertyNames(schema)).toContain('anyOfProp');
  });

  it('recurses into oneOf branches', () => {
    const schema: JsonSchema = {
      oneOf: [{ properties: { oneOfProp: {} } }],
    };
    expect(collectSchemaPropertyNames(schema)).toContain('oneOfProp');
  });

  it('recurses into $defs', () => {
    const schema: JsonSchema = {
      $defs: { MyType: { properties: { defsProp: {} } } },
    };
    expect(collectSchemaPropertyNames(schema)).toContain('defsProp');
  });

  it('recurses into definitions (draft-07 style)', () => {
    const schema: JsonSchema = {
      definitions: { MyType: { properties: { defProp: {} } } },
    };
    expect(collectSchemaPropertyNames(schema)).toContain('defProp');
  });

  it('recurses into items (array schema)', () => {
    const schema: JsonSchema = {
      type: 'array',
      items: { type: 'object', properties: { itemProp: {} } },
    };
    expect(collectSchemaPropertyNames(schema)).toContain('itemProp');
  });

  it('does not walk patternProperties keys as property names (only values)', () => {
    // patternProperties keys are regex patterns, not declared property names
    const schema: JsonSchema = {
      patternProperties: { '^safe_.*$': { properties: { nestedInPattern: {} } } },
    };
    const names = collectSchemaPropertyNames(schema);
    // '^safe_.*$' is a regex key, not a property name — should NOT appear
    expect(names).not.toContain('^safe_.*$');
    // but any properties INSIDE the pattern value ARE walked
    expect(names).toContain('nestedInPattern');
  });

  it('recurses into the not keyword', () => {
    const schema: JsonSchema = {
      not: { properties: { notProp: {} } },
    };
    expect(collectSchemaPropertyNames(schema)).toContain('notProp');
  });

  it('recurses into the if keyword', () => {
    const schema: JsonSchema = {
      if: { properties: { ifProp: {} } },
    };
    expect(collectSchemaPropertyNames(schema)).toContain('ifProp');
  });

  it('recurses into the then keyword', () => {
    const schema: JsonSchema = {
      then: { properties: { thenProp: {} } },
    };
    expect(collectSchemaPropertyNames(schema)).toContain('thenProp');
  });

  it('recurses into the else keyword', () => {
    const schema: JsonSchema = {
      else: { properties: { elseProp: {} } },
    };
    expect(collectSchemaPropertyNames(schema)).toContain('elseProp');
  });

  it('recurses into if/then/else together', () => {
    const schema: JsonSchema = {
      if: { properties: { condProp: { type: 'string' } } },
      then: { properties: { trueProp: {} } },
      else: { properties: { falseProp: {} } },
    };
    const names = collectSchemaPropertyNames(schema);
    expect(names).toContain('condProp');
    expect(names).toContain('trueProp');
    expect(names).toContain('falseProp');
  });

  it('recurses into additionalProperties when it is a schema object', () => {
    const schema: JsonSchema = {
      additionalProperties: { properties: { addlProp: {} } },
    };
    expect(collectSchemaPropertyNames(schema)).toContain('addlProp');
  });
});

// ---------------------------------------------------------------------------
// findCredentialShapedProperty — catches credential fields in not/if/then/else
// ---------------------------------------------------------------------------

describe('findCredentialShapedProperty — credential fields in conditional keywords', () => {
  it('catches a credential-shaped property nested inside not', () => {
    const schema: JsonSchema = {
      not: { properties: { api_key: { type: 'string' } } },
    };
    expect(findCredentialShapedProperty(schema)).toBe('api_key');
  });

  it('catches a credential-shaped property nested inside if', () => {
    const schema: JsonSchema = {
      if: { properties: { matrix_token: { type: 'string' } } },
    };
    expect(findCredentialShapedProperty(schema)).toBe('matrix_token');
  });

  it('catches a credential-shaped property nested inside then', () => {
    const schema: JsonSchema = {
      then: { properties: { private_key: { type: 'string' } } },
    };
    expect(findCredentialShapedProperty(schema)).toBe('private_key');
  });

  it('catches a credential-shaped property nested inside else', () => {
    const schema: JsonSchema = {
      else: { properties: { gh_token: { type: 'string' } } },
    };
    expect(findCredentialShapedProperty(schema)).toBe('gh_token');
  });

  it('catches a credential-shaped property nested inside additionalProperties schema', () => {
    const schema: JsonSchema = {
      additionalProperties: { properties: { signing_key: { type: 'string' } } },
    };
    expect(findCredentialShapedProperty(schema)).toBe('signing_key');
  });

  it('returns undefined when all conditional keyword schemas are credential-free', () => {
    const schema: JsonSchema = {
      if: { properties: { kind: { type: 'string' } } },
      then: { properties: { path: { type: 'string' } } },
      else: { properties: { content: { type: 'string' } } },
      not: { properties: { encoding: { type: 'string' } } },
    };
    expect(findCredentialShapedProperty(schema)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findCredentialShapedProperty — the secret-free oracle
// ---------------------------------------------------------------------------

describe('findCredentialShapedProperty', () => {
  it('returns undefined for a clean schema', () => {
    expect(findCredentialShapedProperty({ type: 'object', properties: { agent_id: {}, name: {} } })).toBeUndefined();
  });

  it('returns the offending name for a flat credential-shaped property', () => {
    const schema: JsonSchema = { properties: { api_key: {} } };
    expect(findCredentialShapedProperty(schema)).toBe('api_key');
  });

  it('finds "token" field that ends with _token', () => {
    const schema: JsonSchema = { properties: { access_token: {} } };
    expect(findCredentialShapedProperty(schema)).toBe('access_token');
  });

  it('finds "password" field', () => {
    const schema: JsonSchema = { properties: { password: {} } };
    expect(findCredentialShapedProperty(schema)).toBeDefined();
  });

  it('finds "gh_token" field', () => {
    const schema: JsonSchema = { properties: { gh_token: {} } };
    expect(findCredentialShapedProperty(schema)).toBe('gh_token');
  });

  it('finds a credential-shaped property nested inside allOf', () => {
    const schema: JsonSchema = {
      type: 'object',
      allOf: [{ properties: { matrix_token: {} } }],
    };
    expect(findCredentialShapedProperty(schema)).toBe('matrix_token');
  });

  it('finds a credential-shaped property nested in definitions', () => {
    const schema: JsonSchema = {
      definitions: { Auth: { properties: { signing_key: {} } } },
    };
    expect(findCredentialShapedProperty(schema)).toBe('signing_key');
  });

  it('returns undefined for an empty schema', () => {
    expect(findCredentialShapedProperty({})).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(findCredentialShapedProperty(null)).toBeUndefined();
  });

  it('accepts a custom regex oracle and applies it', () => {
    const schema: JsonSchema = { properties: { widget_id: {} } };
    // Default regex does not match 'widget_id'
    expect(findCredentialShapedProperty(schema)).toBeUndefined();
    // Custom regex matches anything containing 'widget'
    expect(findCredentialShapedProperty(schema, /widget/)).toBe('widget_id');
  });
});

// ---------------------------------------------------------------------------
// CREDENTIAL_KEY_RE — the secret-free pattern oracle
// ---------------------------------------------------------------------------

describe('CREDENTIAL_KEY_RE', () => {
  it('matches known credential-shaped field names', () => {
    for (const name of ['secret', 'password', 'passwd', 'api_key', 'api-key', 'signing_key', 'private_key', 'matrix_anything', 'mx_agent_anything', 'gh_token', 'access_token']) {
      expect(CREDENTIAL_KEY_RE.test(name), `should match: ${name}`).toBe(true);
    }
  });

  it('does not match benign field names', () => {
    for (const name of ['agent_id', 'name', 'description', 'capability', 'tool', 'args', 'kind', 'path', 'content', 'handle', 'wait_ms', 'context_id']) {
      expect(CREDENTIAL_KEY_RE.test(name), `should NOT match: ${name}`).toBe(false);
    }
  });

  it('is case-insensitive (matches API_KEY, Secret, etc.)', () => {
    expect(CREDENTIAL_KEY_RE.test('API_KEY')).toBe(true);
    expect(CREDENTIAL_KEY_RE.test('Secret')).toBe(true);
    expect(CREDENTIAL_KEY_RE.test('PASSWORD')).toBe(true);
  });

  it('registry-local CREDENTIAL_KEY_RE matches the toolbelt oracle exactly (no drift)', () => {
    expect(CREDENTIAL_KEY_RE.source).toBe(TOOLBELT_CREDENTIAL_KEY_RE.source);
    expect(CREDENTIAL_KEY_RE.flags).toBe(TOOLBELT_CREDENTIAL_KEY_RE.flags);
  });
});

// ---------------------------------------------------------------------------
// mx_run_command — guarded-exec security invariants
// ---------------------------------------------------------------------------

describe('mx_run_command — guarded exec', () => {
  it('is async_semantics: "deferred" (not sync — high-risk ops may require approval)', () => {
    expect(MX_RUN_COMMAND.async_semantics).toBe('deferred');
  });

  it('does NOT declare a "guarded" field (presence would imply descriptor-level authority — Risk #8)', () => {
    expect((MX_RUN_COMMAND as unknown as Record<string, unknown>).guarded).toBeUndefined();
  });

  it('does NOT declare a "default_enabled" field', () => {
    expect((MX_RUN_COMMAND as unknown as Record<string, unknown>).default_enabled).toBeUndefined();
  });

  it('input_schema requires "agent" and "command" (the minimum needed for a guarded exec call)', () => {
    const required = (MX_RUN_COMMAND.input_schema as { required?: string[] }).required ?? [];
    expect(required).toContain('agent');
    expect(required).toContain('command');
  });

  it('input_schema does not declare credential-shaped fields', () => {
    expect(findCredentialShapedProperty(MX_RUN_COMMAND.input_schema)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// All canonical descriptors — global security pass
// ---------------------------------------------------------------------------

describe('canonical descriptors — global security pass', () => {
  it('no canonical input_schema declares a credential-shaped property (including nested)', () => {
    for (const d of CANONICAL_TOOLS) {
      const offender = findCredentialShapedProperty(d.input_schema, TOOLBELT_CREDENTIAL_KEY_RE);
      expect(offender, `${d.name}.input_schema must not declare credential-shaped fields`).toBeUndefined();
    }
  });

  it('no canonical output_schema declares a credential-shaped property (including nested)', () => {
    for (const d of CANONICAL_TOOLS) {
      const offender = findCredentialShapedProperty(d.output_schema, TOOLBELT_CREDENTIAL_KEY_RE);
      expect(offender, `${d.name}.output_schema must not declare credential-shaped fields`).toBeUndefined();
    }
  });

  it('no canonical descriptor name is a forbidden authority verb', () => {
    for (const d of CANONICAL_TOOLS) {
      expect(isForbiddenAuthorityVerb(d.name), `${d.name} must not be an authority verb`).toBe(false);
    }
  });

  it('all canonical descriptor names pass TOOL_NAME_RE', () => {
    for (const d of CANONICAL_TOOLS) {
      expect(/^mx_[a-z0-9]+(?:_[a-z0-9]+)*$/.test(d.name), `${d.name} must match mx_* regex`).toBe(true);
    }
  });

  it('the 3 M3 task verbs pass the same security invariants as M1 verbs', () => {
    const taskVerbs = ['mx_create_task', 'mx_update_task', 'mx_list_tasks'];
    const loaded = loadRegistry();
    for (const name of taskVerbs) {
      const d = loaded.get(name);
      expect(d, `${name} must be in the default registry`).toBeDefined();
      expect(isForbiddenAuthorityVerb(name), `${name} must not be an authority verb`).toBe(false);
      expect(findCredentialShapedProperty(d!.input_schema, TOOLBELT_CREDENTIAL_KEY_RE), `${name}.input_schema`).toBeUndefined();
      expect(findCredentialShapedProperty(d!.output_schema, TOOLBELT_CREDENTIAL_KEY_RE), `${name}.output_schema`).toBeUndefined();
    }
  });
});
