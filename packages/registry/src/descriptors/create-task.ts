import { defineDescriptor, type ToolDescriptor } from '../descriptor.js';
import { JSON_SCHEMA_DIALECT } from '../validator.js';

/**
 * `mx_create_task` — author a task into the durable shared plan (the DAG). Backed by
 * the daemon RPC `task.create` in T301. `sync`: authoring the plan record resolves
 * directly to a terminal `ok(TaskNode, audit_ref)` / `denied` / `error` — it does
 * **not** return `running` / `awaiting_approval` (the deferred path belongs to a
 * task's *action dispatch*, T303, not to authoring the node).
 *
 * **Dependency authoring (the headline AC).** `depends_on` / `blocks` carry the DAG
 * edges; the created node carries them and `mx_list_tasks` returns a graph that
 * reflects them.
 *
 * **The `action` is authored, not dispatched.** A node may carry a signed `action`
 * (a named tool call or a guarded command). T301 only writes it into the DAG record;
 * running it through the authorize pipeline on dispatch is T303. Modelled as a flat
 * object with a `kind` discriminator — **not** a JSON Schema `oneOf` — because the Pi
 * (T205) and Claude (T111) schema converters fail closed on `oneOf`/`anyOf`. No
 * property name is credential-shaped (loader-enforced); the dangerous surface is the
 * *values* inside `action.args`, rejected at dispatch by the toolbelt guard.
 *
 * **Idempotency.** `idempotency_key` is the §4.4 dedup nonce, generated when omitted
 * and reused verbatim on transport-level retry (the `mx_delegate_tool` precedent).
 */
export const MX_CREATE_TASK: ToolDescriptor = defineDescriptor({
  name: 'mx_create_task',
  description: 'Author a task (with optional dependencies and a signed action) into the durable shared plan (DAG).',
  async_semantics: 'sync',
  input_schema: {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'mx_create_task input',
    type: 'object',
    properties: {
      title: { type: 'string', description: 'The human/model-readable task title.' },
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task ids this task depends on (incoming edges).',
      },
      blocks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task ids this task blocks (outgoing edges).',
      },
      assign: { type: 'string', description: 'An agent_id to assign the task to (optional).' },
      state: {
        type: 'string',
        enum: ['proposed', 'pending', 'assigned', 'executing', 'succeeded', 'failed'],
        description: 'The initial state (default: proposed).',
        default: 'proposed',
      },
      action: {
        type: 'object',
        description: 'The signed action the node carries — authored here, NOT dispatched (T303 dispatches it).',
        properties: {
          kind: {
            type: 'string',
            enum: ['tool', 'exec'],
            description: '"tool" → a named tool call; "exec" → a guarded command.',
          },
          tool: { type: 'string', description: 'For kind=tool: the named tool to invoke.' },
          args: {
            type: 'object',
            additionalProperties: true,
            description: 'For kind=tool: the tool JSON arguments (validated by the receiving daemon).',
          },
          command: { type: 'string', description: 'For kind=exec: the allowlisted command.' },
          command_args: {
            type: 'array',
            items: { type: 'string' },
            description: 'For kind=exec: the command arguments.',
          },
          cwd: { type: 'string', description: 'For kind=exec: the working directory.' },
        },
        required: ['kind'],
        additionalProperties: false,
      },
      idempotency_key: {
        type: 'string',
        description: 'Optional client-supplied idempotency key; generated when omitted.',
      },
    },
    required: ['title'],
    additionalProperties: false,
  },
  output_schema: {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'mx_create_task result',
    type: 'object',
    description: 'The created TaskNode (a non-secret projection of the com.mxagent.task.v1 record).',
    properties: {
      task_id: { type: 'string', description: 'The id of the created task.' },
      title: { type: 'string' },
      state: {
        type: 'string',
        enum: ['proposed', 'pending', 'assigned', 'executing', 'succeeded', 'failed', 'unknown'],
        description: 'The model-facing task state (an unrecognised daemon token maps to "unknown").',
      },
      assignee: { type: ['string', 'null'], description: 'The assigned agent_id, or null when unassigned.' },
      depends_on: { type: 'array', items: { type: 'string' } },
      blocks: { type: 'array', items: { type: 'string' } },
      action: { type: ['object', 'null'], description: 'The authored (not dispatched) action, or null.' },
      created_at: { type: 'string' },
      updated_at: { type: 'string' },
    },
    required: ['task_id', 'title', 'state', 'assignee', 'depends_on', 'blocks', 'action'],
    additionalProperties: true,
  },
});
