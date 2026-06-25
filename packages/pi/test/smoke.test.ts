/**
 * Focused smoke test for the Pi binding (T205).
 *
 * This is intentionally MINIMAL — it verifies the core wiring runs green end to
 * end against an injected fake `DaemonCall` + an ABI-shaped fake TypeBox builder
 * set. The comprehensive daemon-free suite (Testing Plan #1–#9: full converter
 * accept/reject parity, all five statuses, every enum field, secret-boundary,
 * audit) and the gated live e2e (#10) land in the dedicated tests / e2e phases.
 *
 * No daemon, no socket, no real Pi/TypeBox install.
 */
import { NullAuditSink } from '@mx-loom/audit';
import { CANONICAL_TOOLS, MX_FIND_AGENTS, isForbiddenAuthorityVerb } from '@mx-loom/registry';
import type { DaemonCall } from '@mx-loom/registry';
import { describe, expect, it } from 'vitest';

import { createPiBindingContext } from '../src/context.js';
import { jsonSchemaToTypeBox, PiSchemaConversionError } from '../src/json-schema-to-typebox.js';
import { mxToolNames } from '../src/names.js';
import type { TypeBoxBuilders, TypeBoxSchema } from '../src/pi-abi.js';
import { serializePiToolResult } from '../src/serialize.js';
import { createPiToolDefinitions } from '../src/tools.js';

const ROOM = '!smoke-room:server';

/** Marker symbol the fake `Type.Object` uses to derive `required` from non-optional props. */
const OPTIONAL = Symbol('optional');

/**
 * An ABI-shaped fake of `{ Type, StringEnum }` that emits plain JSON-Schema-like
 * objects (the same wire shape Pi's real TypeBox + pi-ai `StringEnum` produce), so
 * the converter's output is directly inspectable without installing TypeBox.
 */
const fakeBuilders: TypeBoxBuilders = {
  Type: {
    Object(properties, options = {}) {
      const required = Object.entries(properties)
        .filter(([, schema]) => !(schema as Record<symbol, unknown>)[OPTIONAL])
        .map(([key]) => key);
      return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        ...options,
      };
    },
    Optional(schema) {
      return { ...(schema as Record<string, unknown>), [OPTIONAL]: true };
    },
    String(options = {}) {
      return { type: 'string', ...options };
    },
    Integer(options = {}) {
      return { type: 'integer', ...options };
    },
    Number(options = {}) {
      return { type: 'number', ...options };
    },
    Boolean(options = {}) {
      return { type: 'boolean', ...options };
    },
    Array(items, options = {}) {
      return { type: 'array', items, ...options };
    },
  },
  StringEnum(values, options = {}) {
    return { type: 'string', enum: [...values], ...options };
  },
};

/** Minimal fake daemon: enough for a clean `mx_find_agents` and `mx_delegate_tool` round-trip. */
function makeFakeDaemon(record?: (method: string, params: unknown) => void): DaemonCall {
  return {
    async call(method: string, params?: unknown): Promise<unknown> {
      record?.(method, params ?? null);
      switch (method) {
        case 'agent.list':
          return [];
        case 'agent.tools':
          return { schemas: [{ name: 'run_tests', input_schema: { type: 'object', additionalProperties: true } }] };
        case 'call.start':
          return {
            ok: true,
            result: { passed: true },
            audit_ref: { invocation_id: 'inv_1', request_id: 'req_1', room: ROOM, event_id: '$evt_1' },
          };
        default:
          throw new Error(`unexpected daemon method in smoke test: ${method}`);
      }
    },
  };
}

async function makeTools(daemon?: DaemonCall) {
  const ctx = await createPiBindingContext({
    daemon: daemon ?? makeFakeDaemon(),
    room: ROOM,
    auditSink: new NullAuditSink(),
  });
  return createPiToolDefinitions(ctx, { builders: fakeBuilders });
}

describe('createPiToolDefinitions — generated tool list', () => {
  it('generates exactly the canonical mx_* verbs, no authority verb, with non-empty prompt metadata', async () => {
    const tools = await makeTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(CANONICAL_TOOLS.map((d) => d.name).sort());
    expect(names).toEqual(mxToolNames().sort());

    for (const tool of tools) {
      expect(isForbiddenAuthorityVerb(tool.name)).toBe(false);
      expect(tool.promptSnippet.length).toBeGreaterThan(0);
      expect(tool.promptSnippet).toContain(tool.name);
      expect(tool.promptGuidelines.length).toBeGreaterThan(0);
      expect(tool.promptGuidelines.join(' ')).toContain(tool.name);
    }
  });
});

describe('jsonSchemaToTypeBox — enums → StringEnum, fail-closed', () => {
  it('emits the Google-safe { type:"string", enum:[...] } shape for an enum field (never oneOf/anyOf)', () => {
    const schema = jsonSchemaToTypeBox(MX_FIND_AGENTS.input_schema, fakeBuilders) as {
      properties: Record<string, { type?: string; enum?: readonly string[] }>;
    };
    expect(schema.properties['liveness']?.type).toBe('string');
    expect(schema.properties['liveness']?.enum).toEqual(['active', 'stale', 'offline']);
    expect(JSON.stringify(schema)).not.toMatch(/oneOf|anyOf|allOf|const/);
  });

  it('throws PiSchemaConversionError on an unsupported construct (never widens to Any)', () => {
    expect(() => jsonSchemaToTypeBox({ type: 'object', properties: { x: { oneOf: [] } } }, fakeBuilders)).toThrow(
      PiSchemaConversionError,
    );
    expect(() =>
      jsonSchemaToTypeBox({ type: 'string', enum: ['ok', 7] } as Record<string, unknown>, fakeBuilders),
    ).toThrow(PiSchemaConversionError);
  });
});

describe('serializePiToolResult — envelope in both content and details', () => {
  it('places the same verbatim envelope in content[0].text and details', () => {
    const tools = serializePiToolResult({
      status: 'ok',
      result: { a: 1 },
      error: null,
      handle: null,
      approval: null,
      audit_ref: { invocation_id: null, request_id: null, room: null, event_id: null },
    } as Parameters<typeof serializePiToolResult>[0]);
    expect(tools.content[0]?.type).toBe('text');
    const fromText = JSON.parse(tools.content[0]!.text) as { status: string };
    expect(fromText.status).toBe('ok');
    expect(tools.details).toEqual(fromText);
  });
});

describe('execute — round-trips a daemon result into a Pi AgentToolResult', () => {
  it('mx_find_agents returns status ok with the agents payload (content + details)', async () => {
    const tools = await makeTools();
    const find = tools.find((t) => t.name === 'mx_find_agents');
    if (!find) throw new Error('mx_find_agents not generated');
    const out = await find.execute('call-find', {});
    const env = out.details as { status: string; result: { agents: unknown[] } };
    expect(env.status).toBe('ok');
    expect(env.result.agents).toEqual([]);
    expect(JSON.parse(out.content[0]!.text)).toEqual(env);
  });

  it('mx_delegate_tool round-trips an ok envelope and uses the session room (never params)', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const tools = await makeTools(makeFakeDaemon((method, params) => calls.push({ method, params })));
    const delegate = tools.find((t) => t.name === 'mx_delegate_tool');
    if (!delegate) throw new Error('mx_delegate_tool not generated');

    const out = await delegate.execute('call-del', { agent: 'agent-b', tool: 'run_tests', args: {} });
    const env = out.details as { status: string; result: unknown };
    expect(env.status).toBe('ok');
    expect(env.result).toEqual({ passed: true });

    // The room reaches call.start from the session context, not from model params.
    const callStart = calls.find((c) => c.method === 'call.start');
    expect(JSON.stringify(callStart?.params)).toContain(ROOM);
  });

  it('rejects invalid args with invalid_args BEFORE any dispatch (Ajv preflight)', async () => {
    const calls: string[] = [];
    const tools = await makeTools(makeFakeDaemon((method) => calls.push(method)));
    const describe = tools.find((t) => t.name === 'mx_describe_agent');
    if (!describe) throw new Error('mx_describe_agent not generated');

    // mx_describe_agent requires `agent_id`; omit it → invalid_args, no daemon call.
    const out = await describe.execute('call-bad', {});
    const env = out.details as { status: string; error: { code: string } | null };
    expect(env.status).toBe('error');
    expect(env.error?.code).toBe('invalid_args');
    expect(calls).toEqual([]);
  });
});
