import { defineDescriptor, type ToolDescriptor } from '../descriptor.js';
import { JSON_SCHEMA_DIALECT } from '../validator.js';

/**
 * `mx_await_result` — resolve a deferred handle (running / awaiting-approval →
 * terminal). Backed by `invocation.get` / `task.watch` in T103. `sync`: it is
 * the *resolver* of the deferred protocol, so it itself returns directly.
 */
export const MX_AWAIT_RESULT: ToolDescriptor = defineDescriptor({
  name: 'mx_await_result',
  description: 'Resolve a deferred invocation handle to its terminal result (or the still-pending status).',
  async_semantics: 'sync',
  input_schema: {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'mx_await_result input',
    type: 'object',
    properties: {
      handle: { type: 'string', description: 'The deferred handle returned by a prior delegate/run call.' },
      wait_ms: {
        type: 'integer',
        minimum: 0,
        description: 'Max time to block for resolution; returns the pending status without error on timeout.',
      },
    },
    required: ['handle'],
    additionalProperties: false,
  },
  output_schema: {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'mx_await_result result',
    description: 'The resolved terminal success payload of the awaited handle (open — shape depends on the original tool).',
    type: 'object',
    additionalProperties: true,
  },
});
