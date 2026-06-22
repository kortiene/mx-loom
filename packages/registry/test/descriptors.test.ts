/**
 * Per-descriptor content tests (T101 Testing Plan — descriptors.test.ts).
 *
 * These tests pin the outer `input_schema` shape and `async_semantics` for each
 * of the 7 P0 verbs so that a binding generator (T109/T110) can rely on them.
 * They are pure content assertions — no daemon, no env, no network.
 */
import { describe, expect, it } from 'vitest';

import {
  CANONICAL_M1_TOOLS,
  MX_AWAIT_RESULT,
  MX_DELEGATE_TOOL,
  MX_DESCRIBE_AGENT,
  MX_FIND_AGENTS,
  MX_GET_CONTEXT,
  MX_RUN_COMMAND,
  MX_SHARE_CONTEXT,
  TOOL_NAME_RE,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Individual const exports — frozen and matching CANONICAL_M1_TOOLS
// ---------------------------------------------------------------------------

describe('individual descriptor const exports', () => {
  const NAMED = [
    MX_FIND_AGENTS,
    MX_DESCRIBE_AGENT,
    MX_DELEGATE_TOOL,
    MX_RUN_COMMAND,
    MX_AWAIT_RESULT,
    MX_SHARE_CONTEXT,
    MX_GET_CONTEXT,
  ];

  it('all 7 individual consts are present and frozen', () => {
    for (const d of NAMED) {
      expect(d).toBeDefined();
      expect(Object.isFrozen(d)).toBe(true);
    }
  });

  it('CANONICAL_M1_TOOLS contains the same 7 descriptors in the same object references', () => {
    expect(CANONICAL_M1_TOOLS).toHaveLength(7);
    for (let i = 0; i < NAMED.length; i++) {
      expect(CANONICAL_M1_TOOLS[i]).toBe(NAMED[i]);
    }
  });

  it('every individual const name matches TOOL_NAME_RE', () => {
    for (const d of NAMED) {
      expect(TOOL_NAME_RE.test(d.name)).toBe(true);
    }
  });

  it('every individual const has a non-empty description', () => {
    for (const d of NAMED) {
      expect(d.description.trim().length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// async_semantics per verb
// ---------------------------------------------------------------------------

describe('async_semantics per verb', () => {
  it('mx_find_agents is sync', () => expect(MX_FIND_AGENTS.async_semantics).toBe('sync'));
  it('mx_describe_agent is sync', () => expect(MX_DESCRIBE_AGENT.async_semantics).toBe('sync'));
  it('mx_delegate_tool is deferred', () => expect(MX_DELEGATE_TOOL.async_semantics).toBe('deferred'));
  it('mx_run_command is deferred', () => expect(MX_RUN_COMMAND.async_semantics).toBe('deferred'));
  it('mx_await_result is sync (it IS the resolver of the deferred protocol)', () => {
    // T101 §2: mx_await_result is `sync` because it is the resolver; the deferred
    // protocol (T103) returns a terminal payload, not another handle.
    expect(MX_AWAIT_RESULT.async_semantics).toBe('sync');
  });
  it('mx_share_context is sync', () => expect(MX_SHARE_CONTEXT.async_semantics).toBe('sync'));
  it('mx_get_context is sync', () => expect(MX_GET_CONTEXT.async_semantics).toBe('sync'));
});

// ---------------------------------------------------------------------------
// mx_find_agents — input_schema
// ---------------------------------------------------------------------------

describe('mx_find_agents descriptor', () => {
  const schema = MX_FIND_AGENTS.input_schema as {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: boolean;
  };

  it('has no required fields (all filters are optional)', () => {
    expect(schema.required ?? []).toEqual([]);
  });

  it('declares capability, tool, and liveness as optional filter properties', () => {
    expect(schema.properties).toHaveProperty('capability');
    expect(schema.properties).toHaveProperty('tool');
    expect(schema.properties).toHaveProperty('liveness');
  });

  it('is a closed schema (additionalProperties: false)', () => {
    expect(schema.additionalProperties).toBe(false);
  });

  it('liveness enum is exactly ["active", "stale", "offline"] (no unknown values)', () => {
    const liveProp = (schema.properties as Record<string, { enum?: string[] }>).liveness;
    expect(liveProp?.enum).toEqual(['active', 'stale', 'offline']);
  });

  it('output_schema wraps the agent summaries in an { agents: [...] } object', () => {
    // T104 wraps the matches in an object (not a bare top-level array) so the
    // success payload satisfies the T102 envelope `ok` branch (`result` must be an
    // object). The array of summaries lives under `agents`.
    const out = MX_FIND_AGENTS.output_schema as {
      type: string;
      required?: string[];
      properties: { agents: { type: string; items: { type: string } } };
    };
    expect(out.type).toBe('object');
    expect(out.required ?? []).toContain('agents');
    expect(out.properties.agents.type).toBe('array');
    expect(out.properties.agents.items.type).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// mx_describe_agent — input_schema
// ---------------------------------------------------------------------------

describe('mx_describe_agent descriptor', () => {
  it('requires agent_id', () => {
    const required = (MX_DESCRIBE_AGENT.input_schema as { required?: string[] }).required ?? [];
    expect(required).toContain('agent_id');
  });

  it('declares agent_id as a string property', () => {
    const props = (MX_DESCRIBE_AGENT.input_schema as { properties: Record<string, { type: string }> }).properties;
    expect(props.agent_id?.type).toBe('string');
  });

  it('output_schema declares "agent" and "tools" as required', () => {
    const required = (MX_DESCRIBE_AGENT.output_schema as { required?: string[] }).required ?? [];
    expect(required).toContain('agent');
    expect(required).toContain('tools');
  });
});

// ---------------------------------------------------------------------------
// mx_delegate_tool — input_schema + dynamic inner schema invariant
// ---------------------------------------------------------------------------

describe('mx_delegate_tool descriptor', () => {
  const inputSchema = MX_DELEGATE_TOOL.input_schema as {
    type: string;
    properties: Record<string, { type: string; additionalProperties?: unknown; properties?: unknown }>;
    required: string[];
    additionalProperties: boolean;
  };

  it('requires agent, tool, and args', () => {
    expect(inputSchema.required).toContain('agent');
    expect(inputSchema.required).toContain('tool');
    expect(inputSchema.required).toContain('args');
  });

  it('args is an OPEN object (additionalProperties: true)', () => {
    expect(inputSchema.properties.args?.type).toBe('object');
    expect(inputSchema.properties.args?.additionalProperties).toBe(true);
  });

  it('args does NOT declare any static properties (dynamic inner schema — no target baked in)', () => {
    // T101 §2: the inner tool's schema is resolved dynamically by T105 at dispatch.
    expect(inputSchema.properties.args?.properties).toBeUndefined();
  });

  it('has wait_ms as an optional integer property', () => {
    const waitMs = inputSchema.properties.wait_ms as { type: string; minimum: number } | undefined;
    expect(waitMs?.type).toBe('integer');
    expect(waitMs?.minimum).toBe(0);
    expect(inputSchema.required).not.toContain('wait_ms');
  });

  it('is a closed outer schema (additionalProperties: false)', () => {
    expect(inputSchema.additionalProperties).toBe(false);
  });

  it('output_schema is an open object (shape depends on target tool at call time)', () => {
    const out = MX_DELEGATE_TOOL.output_schema as { type: string; additionalProperties: unknown };
    expect(out.type).toBe('object');
    expect(out.additionalProperties).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mx_run_command — input_schema
// ---------------------------------------------------------------------------

describe('mx_run_command descriptor', () => {
  const inputSchema = MX_RUN_COMMAND.input_schema as {
    properties: Record<string, { type: string; items?: { type: string } }>;
    required: string[];
    additionalProperties: boolean;
  };

  it('requires agent and command', () => {
    expect(inputSchema.required).toContain('agent');
    expect(inputSchema.required).toContain('command');
  });

  it('args is an optional array of strings', () => {
    expect(inputSchema.properties.args?.type).toBe('array');
    expect((inputSchema.properties.args?.items as { type: string })?.type).toBe('string');
    expect(inputSchema.required).not.toContain('args');
  });

  it('cwd is an optional string', () => {
    expect(inputSchema.properties.cwd?.type).toBe('string');
    expect(inputSchema.required).not.toContain('cwd');
  });

  it('is a closed schema (additionalProperties: false)', () => {
    expect(inputSchema.additionalProperties).toBe(false);
  });

  it('output_schema declares exit_code as required', () => {
    const required = (MX_RUN_COMMAND.output_schema as { required?: string[] }).required ?? [];
    expect(required).toContain('exit_code');
  });
});

// ---------------------------------------------------------------------------
// mx_await_result — input_schema
// ---------------------------------------------------------------------------

describe('mx_await_result descriptor', () => {
  const inputSchema = MX_AWAIT_RESULT.input_schema as {
    properties: Record<string, { type: string; minimum?: number }>;
    required: string[];
    additionalProperties: boolean;
  };

  it('requires handle', () => {
    expect(inputSchema.required).toContain('handle');
  });

  it('handle is a string', () => {
    expect(inputSchema.properties.handle?.type).toBe('string');
  });

  it('wait_ms is optional (no blocking commitment from the descriptor)', () => {
    expect(inputSchema.properties.wait_ms?.type).toBe('integer');
    expect(inputSchema.required).not.toContain('wait_ms');
  });

  it('is a closed schema (additionalProperties: false)', () => {
    expect(inputSchema.additionalProperties).toBe(false);
  });

  it('output_schema is an open object (terminal payload shape is tool-specific)', () => {
    const out = MX_AWAIT_RESULT.output_schema as { type: string; additionalProperties: unknown };
    expect(out.type).toBe('object');
    expect(out.additionalProperties).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mx_share_context — input_schema
// ---------------------------------------------------------------------------

describe('mx_share_context descriptor', () => {
  const inputSchema = MX_SHARE_CONTEXT.input_schema as {
    properties: Record<string, { type: string; enum?: string[] }>;
    required: string[];
    additionalProperties: boolean;
  };

  it('requires kind', () => {
    expect(inputSchema.required).toContain('kind');
  });

  it('kind is constrained to the file/diff/env enum', () => {
    const kind = inputSchema.properties.kind;
    expect(kind?.type).toBe('string');
    expect(kind?.enum).toEqual(['file', 'diff', 'env']);
  });

  it('path, content, encoding are optional', () => {
    for (const field of ['path', 'content', 'encoding']) {
      expect(inputSchema.properties).toHaveProperty(field);
      expect(inputSchema.required).not.toContain(field);
    }
  });

  it('is a closed schema (additionalProperties: false)', () => {
    expect(inputSchema.additionalProperties).toBe(false);
  });

  it('output_schema requires context_id and sha256', () => {
    const required = (MX_SHARE_CONTEXT.output_schema as { required?: string[] }).required ?? [];
    expect(required).toContain('context_id');
    expect(required).toContain('sha256');
  });
});

// ---------------------------------------------------------------------------
// mx_get_context — input_schema
// ---------------------------------------------------------------------------

describe('mx_get_context descriptor', () => {
  const inputSchema = MX_GET_CONTEXT.input_schema as {
    properties: Record<string, { type: string }>;
    required: string[];
    additionalProperties: boolean;
  };

  it('requires context_id', () => {
    expect(inputSchema.required).toContain('context_id');
  });

  it('context_id is a string', () => {
    expect(inputSchema.properties.context_id?.type).toBe('string');
  });

  it('is a closed schema (additionalProperties: false)', () => {
    expect(inputSchema.additionalProperties).toBe(false);
  });

  it('output_schema requires context_id', () => {
    const required = (MX_GET_CONTEXT.output_schema as { required?: string[] }).required ?? [];
    expect(required).toContain('context_id');
  });
});
