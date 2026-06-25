/**
 * `mx_dispatch_task` — dispatch a task node's authored, signed `action` (T303 / #32)
 * — design §2 (the task-DAG verbs) / §5 (the invocation flow) / §7 ("Task state": a
 * node's signed `action` is authored by T301, dispatched through the authorize
 * pipeline by T303).
 *
 * "Take a DAG node's authored `action` and **run** it — such that a `kind: 'tool'`
 * action routes through `call.start` and a `kind: 'exec'` action routes through
 * `exec.start`, i.e. through the **identical receiver-side authorize pipeline** that
 * `mx_delegate_tool` (T105) and `mx_run_command` (T106) already use." The acceptance
 * criterion ("a task action runs through the full authorize pipeline on dispatch") is
 * true **by construction**: this handler re-routes the authored action through the
 * two landed delegation handlers, so the dispatch is — on the wire — indistinguishable
 * from a direct delegation / exec and traverses the same sig → trust → policy →
 * sandbox → approval pipeline.
 *
 * **Authoring an action ≠ authorizing it.** The `action` in the DAG is a *request
 * shape*, never a grant (design §1: "cognition can only ever produce a signed
 * request; it can never grant itself authority"). Dispatch re-runs authorize from
 * scratch on the receiving daemon; this handler performs **no** trust/policy/approval/
 * sandbox check in-process. `policy_denied` / `untrusted_key` / `approval_denied` /
 * `awaiting_approval` are outcomes it *maps* (via the callee handlers), never decisions
 * it makes. A revoked key or a tightened policy between authoring and dispatch is
 * honored at dispatch time (the "re-validated at release" property, design §5).
 *
 * **Single source of truth for the mapping (the "alignment").** The action → dispatch
 * mapping is the shared, pure {@link actionToDispatch} (`task-action.ts`), the same
 * mapper `mx_create_task` authors through (T301), so what was authored is exactly what
 * is dispatched.
 *
 * **Idempotent.** A task-stable default `idempotency_key` (`idk_task_<task_id>`) makes
 * a re-dispatch (a retry, or a runtime that restarted mid-plan per T302/T304) dedupe on
 * the daemon's replay protection rather than double-execute (design §4.4) — the
 * load-bearing property for T304's restart scenario.
 *
 * **Secret boundary holds at dispatch, not just authoring.** Because dispatch routes
 * through `mxDelegateTool` / `mxRunCommand` over the concrete `MxClient`,
 * `assertNoCredentialShapedArgs` (keys **and** values) runs again before the wire and
 * `redactSecrets` scrubs token-shaped values inbound. The registry re-implements
 * neither guard and keeps its zero **runtime** toolbelt dependency (the `DaemonCall`
 * seam is injected, imported `type`-only).
 *
 * **No daemon-RPC invented.** The handler consumes only the already-flags-confirmed
 * `call.start` / `exec.start` surface, plus a `task.list` read (client-side id filter
 * — the T104 / T302 precedent) to resolve the node; there is no unconfirmed
 * `task.dispatch` / `task.get` dependency. If a first-class daemon dispatch RPC is
 * later verified at the two-daemon round-trip, step 3 becomes a localized swap; either
 * way the AC holds because both routes hit the receiver pipeline. The read shape is
 * localized in `mxListTasks` and pinned behind `MXL_CONFORMANCE_TWO_DAEMON=1`.
 *
 * Never throws — every transport/daemon fault maps onto the closed T102 taxonomy
 * (`faultToResult`) or is produced by a callee handler.
 */
import { errored, type ToolResult } from '../envelope.js';
import { IDEMPOTENCY_KEY_PREFIX } from '../idempotency.js';
import { mxDelegateTool } from './delegate-tool.js';
import type { DispatchDeps } from './deps.js';
import { EMPTY_AUDIT_REF } from './handler-fault.js';
import { failureResult } from './invocation.js';
import { mxListTasks, type ListTasksResult } from './list-tasks.js';
import { mxRunCommand } from './run-command.js';
import { actionToDispatch, isInvalidDispatch } from './task-action.js';
import type { TaskNode } from './task-projection.js';

/** Input of `mx_dispatch_task` — the descriptor's input schema (`task_id` required). */
export interface DispatchTaskInput {
  /** The DAG node whose authored action to dispatch. */
  readonly task_id: string;
  /** Optional inline wait before returning a deferred handle (the §4.3 / T103 poll hint). */
  readonly wait_ms?: number;
  /** Optional client-supplied idempotency key; derived (task-stable) when omitted. */
  readonly idempotency_key?: string;
}

/**
 * Derive the task-stable default idempotency key (`idk_task_<task_id>`). Two dispatches
 * of the same task collapse on the daemon's replay protection (design §4.4 / G5); a
 * dedup nonce, never a capability.
 */
function taskDispatchKey(task_id: string): string {
  return `${IDEMPOTENCY_KEY_PREFIX}task_${task_id}`;
}

/**
 * Dispatch a task node's authored action and return its normalized {@link ToolResult}.
 * Never throws. The phases mirror `mxDelegateTool`'s structure: room provenance →
 * resolve the node + its action → map the action → route through the existing
 * authorize pipeline.
 */
export async function mxDispatchTask(input: DispatchTaskInput, deps: DispatchDeps): Promise<ToolResult> {
  // Phase 1 — room provenance. The DAG is workspace-scoped; the model never names a
  // Matrix room (design §1/§7) — the binding injects it from the `MxSession`. Fail
  // fast rather than dispatch a room-less read (no round-trip → EMPTY_AUDIT_REF).
  if (deps.room === undefined || deps.room === '') {
    return errored('internal', 'no workspace room configured for task dispatch', EMPTY_AUDIT_REF);
  }

  const task_id = typeof input.task_id === 'string' ? input.task_id : '';
  if (task_id === '') {
    return failureResult('invalid_args', EMPTY_AUDIT_REF);
  }

  // Phase 2 — resolve the node + its authored action via the verified `task.list`
  // surface (client-side id filter — no unconfirmed single-task-read RPC). Reuse
  // `mxListTasks` so the read, projection, and fault-mapping are single-sourced; a
  // `task.list` fault / denial propagates as that envelope.
  const listed = await mxListTasks({ view: 'list' }, deps);
  if (listed.status !== 'ok') {
    return listed;
  }
  const tasks = (listed.result as ListTasksResult | undefined)?.tasks ?? [];
  const node: TaskNode | undefined = tasks.find((t) => t.task_id === task_id);
  if (node === undefined) {
    return failureResult('not_found', EMPTY_AUDIT_REF);
  }

  // A clearly-terminal node carries no live action to (re-)dispatch (O5). Re-dispatch
  // of a still-active node (`executing`/…) is safe — idempotency dedupes on the
  // daemon, which is exactly what T304's crash-recovery re-dispatch relies on.
  if (node.state === 'succeeded' || node.state === 'failed') {
    return failureResult('invalid_args', EMPTY_AUDIT_REF);
  }
  if (node.action === null) {
    return failureResult('invalid_args', EMPTY_AUDIT_REF);
  }

  // Phase 3 — map the authored action → its dispatch via the SHARED mapper (the
  // alignment). An un-dispatchable action (no tool/command) → `invalid_args`.
  const dispatch = actionToDispatch(node.action);
  if (isInvalidDispatch(dispatch)) {
    return failureResult('invalid_args', EMPTY_AUDIT_REF);
  }

  // Both a tool action and a guarded exec run ON a target agent (the `call.start` /
  // `exec.start` `agent`); the node's assignee is that target (O4). An unassigned
  // node cannot be dispatched — refuse cleanly rather than guess a target.
  const target = node.assignee;
  if (target === null || target === '') {
    return failureResult('invalid_args', EMPTY_AUDIT_REF);
  }

  // Phase 4 — route through the existing authorize pipeline. Reusing the two landed
  // handlers (not re-emitting `call.start`/`exec.start`) means the entire receiver-side
  // authorize pipeline, the `awaiting_approval`/`running` normalization, the inline
  // `wait_ms` composition with `mx_await_result`, and the secret-boundary guard all run
  // unchanged. The task-derived `idempotency_key` rides in params (reused verbatim on
  // transport retry — the `mxDelegateTool`/`mxRunCommand` precedent).
  const idempotency_key = input.idempotency_key ?? taskDispatchKey(task_id);
  if (dispatch.mode === 'tool') {
    return mxDelegateTool(
      {
        agent: target,
        tool: dispatch.tool,
        args: dispatch.args,
        wait_ms: input.wait_ms,
        idempotency_key,
      },
      deps,
    );
  }
  return mxRunCommand(
    {
      agent: target,
      command: dispatch.command,
      args: dispatch.command_args,
      ...(dispatch.cwd !== undefined ? { cwd: dispatch.cwd } : {}),
      wait_ms: input.wait_ms,
      idempotency_key,
    },
    deps,
  );
}
