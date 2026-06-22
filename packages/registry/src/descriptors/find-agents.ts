import { defineDescriptor, type ToolDescriptor } from '../descriptor.js';
import { JSON_SCHEMA_DIALECT } from '../validator.js';

/**
 * `mx_find_agents` — discover agents by capability / tool / liveness.
 * Backed by `agent.list` (+ client-side filter) in T104. `sync`: returns directly.
 *
 * The success payload is `{ agents: AgentSummary[] }` — the matching rows are
 * wrapped in an object, not returned as a bare top-level array, so the result
 * satisfies the T102 envelope `ok` branch (`result: { type: 'object' }`). Each
 * summary is a non-secret subset of the daemon `AgentState`; the handler projects
 * out the public-but-noisy identifiers (`matrix_user_id`, the public signing key).
 */
export const MX_FIND_AGENTS: ToolDescriptor = defineDescriptor({
  name: 'mx_find_agents',
  description: 'Discover agents in the workspace, optionally filtered by capability, tool name, or liveness.',
  async_semantics: 'sync',
  input_schema: {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'mx_find_agents input',
    type: 'object',
    properties: {
      capability: { type: 'string', description: 'Only return agents advertising this capability.' },
      tool: { type: 'string', description: 'Only return agents publishing a tool with this name.' },
      liveness: {
        type: 'string',
        enum: ['active', 'stale', 'offline'],
        description: 'Only return agents with this derived liveness.',
      },
    },
    additionalProperties: false,
  },
  output_schema: {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'mx_find_agents result',
    description: 'Matching agent summaries (a non-secret subset of the daemon AgentState).',
    type: 'object',
    properties: {
      agents: {
        type: 'array',
        description: 'The matching agents, in `agent.list` order.',
        items: {
          type: 'object',
          properties: {
            agent_id: { type: 'string' },
            kind: { type: 'string' },
            capabilities: { type: 'array', items: { type: 'string' } },
            liveness: { type: 'string', enum: ['active', 'stale', 'offline'] },
          },
          required: ['agent_id', 'liveness'],
          additionalProperties: true,
        },
      },
    },
    required: ['agents'],
    additionalProperties: false,
  },
});
