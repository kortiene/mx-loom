import { defineDescriptor, type ToolDescriptor } from '../descriptor.js';
import { JSON_SCHEMA_DIALECT } from '../validator.js';

/**
 * `mx_delegate_tool` — the primary delegation verb: invoke a *named tool* on a
 * remote agent. Backed by `call.start` → `CallRequest`/`CallResponse` in T105.
 *
 * `deferred`: a remote call may return `running` / `awaiting_approval` + a handle
 * the caller resolves via `mx_await_result` (design §4.3, §5).
 *
 * **Dynamic inner schema.** This descriptor's `input_schema` is the OUTER
 * envelope (`agent` / `tool` / `args`). `args` is an OPEN object: the descriptor
 * deliberately does NOT bake in any target tool's schema. T105 validates `args`
 * dynamically against the target agent's published `ToolSchema.input_schema` at
 * dispatch (the confirmed v0.2.1 pass-through). Likewise `output_schema` is open
 * because the success payload is the target's `ToolSchema.output_schema`, known
 * only at call time.
 */
export const MX_DELEGATE_TOOL: ToolDescriptor = defineDescriptor({
  name: 'mx_delegate_tool',
  description: 'Invoke a named tool on a remote agent with JSON arguments (the primary delegation verb).',
  async_semantics: 'deferred',
  input_schema: {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'mx_delegate_tool input',
    type: 'object',
    properties: {
      agent: { type: 'string', description: 'The target agent id.' },
      tool: { type: 'string', description: 'The target tool name (optionally `name@version`).' },
      args: {
        type: 'object',
        description:
          "Inner-tool arguments — an OPEN object. The descriptor does NOT declare the target tool's schema; T105 validates these dynamically against the target's published ToolSchema.input_schema at dispatch.",
        additionalProperties: true,
      },
      wait_ms: {
        type: 'integer',
        minimum: 0,
        description: 'Optional inline wait before returning a deferred handle (the §4.3 / T103 poll hint).',
      },
      idempotency_key: {
        type: 'string',
        description:
          'Optional client-supplied idempotency key (design §4.4): supply a stable key to make a retry of THIS SAME delegation idempotent (the daemon dedupes on it); omit and the handler (T105) generates one per invocation. A dedup nonce, not a credential — confers no authority.',
      },
    },
    required: ['agent', 'tool', 'args'],
    additionalProperties: false,
  },
  output_schema: {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'mx_delegate_tool result',
    description:
      "The inner tool's success payload. Its shape is the target ToolSchema.output_schema, known only at call time, so the OUTER descriptor declares an open object.",
    type: 'object',
    additionalProperties: true,
  },
});
