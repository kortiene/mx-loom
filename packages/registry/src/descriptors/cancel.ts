import { defineDescriptor, type ToolDescriptor } from '../descriptor.js';
import { JSON_SCHEMA_DIALECT } from '../validator.js';

/**
 * `mx_cancel` — cancel an in-flight invocation by its deferred handle. Backed by
 * the daemon RPC `invocation.cancel` in T108. `sync`: a cancellation request is
 * acknowledged immediately and the verb returns a terminal envelope — it does not
 * return `running` / `awaiting_approval` and does not compose `mx_await_result`
 * (cancellation is not approval-gated in M1).
 *
 * **Its presence confers NO authority.** Cancellation is a *request* the receiving
 * daemon authorizes out-of-process (Ed25519 trust + deny-by-default `policy.toml`);
 * the handler emits a signed cancel and surfaces the receiver's verdict
 * (`policy_denied` / `untrusted_key`), it never decides. It cannot release a held
 * invocation — it can only request a stop. Not a forbidden authority verb.
 *
 * **No `idempotency_key`.** Cancelling is naturally idempotent — it is monotonic
 * toward a terminal `cancelled` state, so a re-issued cancel is a safe no-op
 * (mirroring T107's "content-addressing makes a re-share idempotent; add no key").
 *
 * The output discriminates a real cancellation from a no-op: `cancelled: true`
 * means the invocation was running and is now cancelling/cancelled;
 * `cancelled: false` with a `state` (e.g. `already_complete`) means there was
 * nothing to cancel — still a successful, non-error outcome. `additionalProperties:
 * true` tolerates daemon extras (the `invocation.cancel` wire shape is "◻️
 * documented" — pinned at the two-daemon round-trip, T108).
 */
export const MX_CANCEL: ToolDescriptor = defineDescriptor({
  name: 'mx_cancel',
  description: 'Cancel an in-flight invocation by its deferred handle.',
  async_semantics: 'sync',
  input_schema: {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'mx_cancel input',
    type: 'object',
    properties: {
      handle: {
        type: 'string',
        description: 'The deferred handle (an inv_… invocation id) returned by a prior delegate/run/await call.',
      },
    },
    required: ['handle'],
    additionalProperties: false,
  },
  output_schema: {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'mx_cancel result',
    type: 'object',
    properties: {
      handle: { type: 'string', description: 'The invocation handle the cancel targeted.' },
      cancelled: {
        type: 'boolean',
        description: 'True if the invocation was running and is now cancelling/cancelled; false if there was nothing to cancel.',
      },
      state: { type: 'string', description: 'The post-cancel invocation state, when the daemon reports one.' },
    },
    required: ['handle', 'cancelled'],
    additionalProperties: true,
  },
});
