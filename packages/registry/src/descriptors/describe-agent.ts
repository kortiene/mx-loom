import { defineDescriptor, type ToolDescriptor } from '../descriptor.js';
import { JSON_SCHEMA_DIALECT } from '../validator.js';

/**
 * `mx_describe_agent` — inspect one agent and the `ToolSchema[]` it publishes.
 * Backed by `agent.show` + `agent.tools` in T104. `sync`.
 *
 * The output models the model-relevant, non-secret subset of the agent record;
 * the handler (T104) may surface the full `AgentState` (additionalProperties is
 * open). Public-but-noisy identifiers (`matrix_user_id`, the public signing key)
 * are intentionally omitted from the *declared* shape so the canonical schema
 * stays free of any credential-substring field name.
 */
export const MX_DESCRIBE_AGENT: ToolDescriptor = defineDescriptor({
  name: 'mx_describe_agent',
  description: 'Inspect a single agent and the tool schemas it publishes.',
  async_semantics: 'sync',
  input_schema: {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'mx_describe_agent input',
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'The agent to inspect.' },
    },
    required: ['agent_id'],
    additionalProperties: false,
  },
  output_schema: {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'mx_describe_agent result',
    type: 'object',
    properties: {
      agent: {
        type: 'object',
        properties: {
          agent_id: { type: 'string' },
          kind: { type: 'string' },
          status: { type: 'string' },
          capabilities: { type: 'array', items: { type: 'string' } },
          liveness: { type: 'string', enum: ['active', 'stale', 'offline'] },
          workspace: { type: 'object', additionalProperties: true },
          load: { type: 'object', additionalProperties: true },
          last_seen_ts: { type: 'number' },
        },
        required: ['agent_id'],
        additionalProperties: true,
      },
      tools: {
        type: 'array',
        description: "The agent's published ToolSchema[] (com.mxagent.tool.v1).",
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            version: { type: 'string' },
            description: { type: 'string' },
            input_schema: { type: 'object', additionalProperties: true },
            output_schema: { type: 'object', additionalProperties: true },
          },
          required: ['name'],
          additionalProperties: true,
        },
      },
    },
    required: ['agent', 'tools'],
    additionalProperties: true,
  },
});
