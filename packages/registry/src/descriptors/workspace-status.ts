import { defineDescriptor, type ToolDescriptor } from '../descriptor.js';
import { JSON_SCHEMA_DIALECT } from '../validator.js';

/**
 * `mx_workspace_status` — observe the workspace: "where am I / who is here / what
 * project is this". Backed by `workspace.status` (room/project metadata) composed
 * with `agent.list` (the registered MX agents) in T108. `sync`: a local read that
 * resolves directly to a terminal `ok` / `denied` / `error` envelope.
 *
 * **No model-facing input.** The workspace room is injected from the session
 * (`MxSession`), never named by the model (a Matrix room id is a coordination-plane
 * detail — design §1/§7), so the input schema declares no properties.
 *
 * **The model-facing identities are the MX `agent_id`s, not Matrix user ids.** The
 * verified `workspace.status` reply carries `members[{ user_id, … }]` — raw Matrix
 * user ids — which the handler deliberately projects **out** (T104's precedent:
 * `mx_find_agents` drops `matrix_user_id` etc.). The `agents` array is the
 * non-secret `AgentSummary` shape from `agent.list`, exactly what `mx_find_agents`
 * returns.
 *
 * `required: ['agents']` and `additionalProperties: true` so a future `tasks`
 * dimension (M3 / T301) is an additive, non-breaking extension — task DAG tools are
 * out of scope for M1, so this verb surfaces agents + project and leaves the
 * forward-compatible slot unpopulated.
 */
export const MX_WORKSPACE_STATUS: ToolDescriptor = defineDescriptor({
  name: 'mx_workspace_status',
  description: 'Report the current workspace: the registered agents and the project context.',
  async_semantics: 'sync',
  input_schema: {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'mx_workspace_status input',
    type: 'object',
    additionalProperties: false,
  },
  output_schema: {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'mx_workspace_status result',
    description: 'Non-secret workspace metadata + the registered MX agents + the project context.',
    type: 'object',
    properties: {
      workspace: {
        type: 'object',
        description: 'Non-secret room metadata (the raw Matrix members[] list is deliberately omitted).',
        properties: {
          room_id: { type: 'string' },
          name: { type: 'string' },
          canonical_alias: { type: 'string' },
          encrypted: { type: 'boolean' },
        },
        additionalProperties: true,
      },
      agents: {
        type: 'array',
        description: 'The registered MX agents, projected to the non-secret AgentSummary shape (as mx_find_agents).',
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
      project: {
        type: 'object',
        description: 'Derived project context (when available).',
        properties: {
          project_id: { type: 'string' },
          cwd: { type: 'string' },
          git_commit: { type: 'string' },
        },
        additionalProperties: true,
      },
    },
    required: ['agents'],
    additionalProperties: true,
  },
});
