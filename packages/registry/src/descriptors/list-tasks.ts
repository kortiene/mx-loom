import { defineDescriptor, type ToolDescriptor } from '../descriptor.js';
import { JSON_SCHEMA_DIALECT } from '../validator.js';

/**
 * `mx_list_tasks` — read the durable shared plan as a list or a DAG. Backed by the
 * daemon RPC `task.list` (+ `task.graph` for edges) in T301. `sync` **local read**:
 * resolves to `ok({ tasks, edges? }, EMPTY_AUDIT_REF)` — no Matrix round-trip, so an
 * all-null `audit_ref` (consistent with `mx_find_agents` / `mx_workspace_status`).
 *
 * **`view: 'graph'` (default) returns nodes AND edges** so "list reflects the DAG"
 * holds out of the box: the edges are derived from each node's `depends_on` / `blocks`
 * (the node records already carry them — spec Risk #1) and merged with any explicit
 * `task.graph` reply. A `task.graph` fault never fails the list — the derived edges
 * still reflect the DAG. `view: 'list'` returns nodes only.
 *
 * Read verb → no `idempotency_key`. The optional `state` / `assignee` filters are
 * forwarded to the daemon; the room is best-effort (the daemon may default to its
 * current workspace), never named by the model.
 */
export const MX_LIST_TASKS: ToolDescriptor = defineDescriptor({
  name: 'mx_list_tasks',
  description: 'List the shared plan as a DAG (nodes + dependency edges) or a flat list, with optional filters.',
  async_semantics: 'sync',
  input_schema: {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'mx_list_tasks input',
    type: 'object',
    properties: {
      state: {
        type: 'string',
        enum: ['proposed', 'pending', 'assigned', 'executing', 'succeeded', 'failed'],
        description: 'Optional state filter.',
      },
      assignee: { type: 'string', description: 'Optional assignee agent_id filter.' },
      view: {
        type: 'string',
        enum: ['list', 'graph'],
        description: '"graph" (default) returns nodes and dependency edges; "list" returns nodes only.',
        default: 'graph',
      },
    },
    additionalProperties: false,
  },
  output_schema: {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'mx_list_tasks result',
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description: 'The task nodes (each a non-secret TaskNode projection).',
        items: { type: 'object', additionalProperties: true },
      },
      edges: {
        type: 'array',
        description: 'The DAG edges (present for view: graph): { from, to, kind }.',
        items: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            kind: { type: 'string', enum: ['depends_on', 'blocks'] },
          },
          required: ['from', 'to', 'kind'],
          additionalProperties: false,
        },
      },
    },
    required: ['tasks'],
    additionalProperties: true,
  },
});
