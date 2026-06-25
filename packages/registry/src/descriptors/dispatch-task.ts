import { defineDescriptor, type ToolDescriptor } from '../descriptor.js';
import { JSON_SCHEMA_DIALECT } from '../validator.js';

/**
 * `mx_dispatch_task` — dispatch a task node's authored, signed `action` (T303 / #32).
 * Backed by the **verified** `call.start` / `exec.start` surface (a `kind: 'tool'`
 * action routes through `mx_delegate_tool`, a `kind: 'exec'` action through
 * `mx_run_command`) — so a dispatched task action is, on the wire, indistinguishable
 * from a direct delegation / exec and traverses the **identical** receiver-side
 * authorize pipeline (signature → trust store → `policy.toml` → sandbox → human
 * approval). That is the single acceptance criterion: a task action runs through the
 * full authorize pipeline on dispatch.
 *
 * **The action in the DAG is a request shape, not a grant.** T301 *authors* a node's
 * `action`; T303 *dispatches* it. Dispatch re-runs authorize from scratch on the
 * receiving daemon — authoring an action ≠ authorizing it (design §1, §5, §6). This
 * verb is a request-producer, **not** a governance verb: it performs no
 * trust/policy/approval/sandbox check in-process; `policy_denied` / `untrusted_key` /
 * `awaiting_approval` are outcomes it *maps*, never decisions it makes.
 *
 * `deferred`: an action the receiver holds for approval surfaces as
 * `awaiting_approval` + a `handle`; a running action surfaces as `running`; both
 * resolve via `mx_await_result` (the model is never given an approval-mutation tool).
 *
 * **Idempotent.** A task-derived default `idempotency_key` (`idk_task_<task_id>`)
 * ties the dispatch to the task so the daemon's replay protection dedupes a re-issued
 * dispatch (a retry, or a runtime that restarted mid-plan per T302/T304) without
 * double-executing. A dedup nonce, never a capability — idempotency never bypasses
 * authorize.
 *
 * No property name is credential-shaped (loader-enforced); the dangerous surface —
 * the *values* inside the node's `action.args` / `command_args` — is guarded at
 * dispatch by the toolbelt `MxClient` (`assertNoCredentialShapedArgs`), the same
 * guard that ran at authoring (T301). Doubly bounded.
 */
export const MX_DISPATCH_TASK: ToolDescriptor = defineDescriptor({
  name: 'mx_dispatch_task',
  description:
    "Dispatch a task node's authored signed action (tool or guarded command) through the full receiver-side authorize pipeline.",
  async_semantics: 'deferred',
  input_schema: {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'mx_dispatch_task input',
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'The DAG node whose authored action to dispatch.',
      },
      wait_ms: {
        type: 'integer',
        minimum: 0,
        description: 'Optional inline wait before returning a deferred handle (the §4.3 / T103 poll hint).',
      },
      idempotency_key: {
        type: 'string',
        description:
          'Optional client-supplied idempotency key (design §4.4): a dedup nonce that confers no authority. Omit and the handler derives a task-stable key (idk_task_<task_id>) so a re-dispatch of the same task dedupes on the daemon.',
      },
    },
    required: ['task_id'],
    additionalProperties: false,
  },
  output_schema: {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'mx_dispatch_task result',
    description:
      "The dispatched action's success payload — the inner tool's output (kind=tool) or the exec result { exit_code, summary?, log_ref? } (kind=exec). Its shape is known only at dispatch time, so the descriptor declares an open object; a held/running dispatch carries a handle resolvable via mx_await_result.",
    type: 'object',
    additionalProperties: true,
  },
});
