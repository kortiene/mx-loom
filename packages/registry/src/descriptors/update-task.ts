import { defineDescriptor, type ToolDescriptor } from '../descriptor.js';
import { JSON_SCHEMA_DIALECT } from '../validator.js';

/**
 * `mx_update_task` — transition a task's state / re-assign / adjust edges in the
 * durable shared plan. Backed by the daemon RPC `task.update` in T301. `sync`: the
 * update resolves directly to a terminal `ok(TaskNode, audit_ref)` / `denied` /
 * `error`.
 *
 * **The state transition is the daemon's job (the headline AC).** The handler
 * forwards the requested target `state` and surfaces the daemon's resulting node
 * state; it performs **no** client-side transition-legality check — an illegal
 * transition is the daemon's `invalid_args` / `policy_denied`, surfaced cleanly.
 *
 * Whether the daemon accepts edge edits (`depends_on` / `blocks`) on update vs
 * create-only is **pending the two-daemon round-trip**; the fields are forwarded and
 * documented (if unsupported they are dropped daemon-side, not silently ignored
 * client-side). `idempotency_key` is the §4.4 dedup nonce, generated when omitted.
 */
export const MX_UPDATE_TASK: ToolDescriptor = defineDescriptor({
  name: 'mx_update_task',
  description: 'Update a task in the shared plan: transition its state, re-assign it, or adjust its dependency edges.',
  async_semantics: 'sync',
  input_schema: {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'mx_update_task input',
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The id of the task to update.' },
      state: {
        type: 'string',
        enum: ['proposed', 'pending', 'assigned', 'executing', 'succeeded', 'failed'],
        description: 'The target state to transition the task to.',
      },
      assign: { type: 'string', description: 'Re-assign the task to this agent_id.' },
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'Replace the tasks this task depends on (if the daemon supports edge edits on update).',
      },
      blocks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Replace the tasks this task blocks (if the daemon supports edge edits on update).',
      },
      idempotency_key: {
        type: 'string',
        description: 'Optional client-supplied idempotency key; generated when omitted.',
      },
    },
    required: ['task_id'],
    additionalProperties: false,
  },
  output_schema: {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'mx_update_task result',
    type: 'object',
    description: 'The updated TaskNode (a non-secret projection of the com.mxagent.task.v1 record).',
    properties: {
      task_id: { type: 'string' },
      title: { type: 'string' },
      state: {
        type: 'string',
        enum: ['proposed', 'pending', 'assigned', 'executing', 'succeeded', 'failed', 'unknown'],
        description: 'The model-facing task state after the update.',
      },
      assignee: { type: ['string', 'null'] },
      depends_on: { type: 'array', items: { type: 'string' } },
      blocks: { type: 'array', items: { type: 'string' } },
      action: { type: ['object', 'null'] },
      created_at: { type: 'string' },
      updated_at: { type: 'string' },
    },
    required: ['task_id', 'title', 'state', 'assignee', 'depends_on', 'blocks', 'action'],
    additionalProperties: true,
  },
});
