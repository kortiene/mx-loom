import { defineDescriptor, type ToolDescriptor } from '../descriptor.js';
import { JSON_SCHEMA_DIALECT } from '../validator.js';

/**
 * `mx_run_command` — run an allowlisted command on a remote agent (guarded
 * exec). Backed by `exec.start` → `ExecRequest` in T106. `deferred`.
 *
 * **Its presence in the registry confers NO capability.** Guarded-ness is
 * enforced by the *receiver's* deny-by-default `policy.toml` (`allow_commands` +
 * `deny_args_regex` + sandbox + `network = "deny"`), never by this descriptor —
 * so no advisory `guarded` hint is declared (Risk #8: it would risk implying
 * descriptor-level authority). The tool ships disabled; an un-allowlisted call
 * returns `policy_denied` (the T102 envelope), and high-risk commands surface as
 * `awaiting_approval` — the model never approves anything itself (design §6, §9).
 */
export const MX_RUN_COMMAND: ToolDescriptor = defineDescriptor({
  name: 'mx_run_command',
  description: 'Run an allowlisted command on a remote agent (disabled by default; gated by receiver policy).',
  async_semantics: 'deferred',
  input_schema: {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'mx_run_command input',
    type: 'object',
    properties: {
      agent: { type: 'string', description: 'The target agent id.' },
      command: { type: 'string', description: 'The allowlisted binary to run (subject to receiver policy).' },
      args: { type: 'array', items: { type: 'string' }, description: 'Command arguments.' },
      cwd: { type: 'string', description: 'Working directory (subject to `allow_cwd`).' },
      wait_ms: {
        type: 'integer',
        minimum: 0,
        description: 'Optional inline wait before returning a deferred handle (the §4.3 / T103 poll hint).',
      },
    },
    required: ['agent', 'command'],
    additionalProperties: false,
  },
  output_schema: {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'mx_run_command result',
    type: 'object',
    properties: {
      exit_code: { type: 'integer', description: 'Process exit code.' },
      summary: { type: 'string', description: 'Short, non-streamed result summary.' },
      log_ref: { type: 'string', description: 'Reference to the captured output artifact (fetch via mx_get_context).' },
    },
    required: ['exit_code'],
    additionalProperties: true,
  },
});
