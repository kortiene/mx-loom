/**
 * The shared action→dispatch mapper (T303 / #32) — design §2 (the task-DAG verbs) /
 * §7 ("Task state": a node's signed `action` is **authored, not dispatched**; T303
 * dispatches it through the authorize pipeline).
 *
 * This module is the **single source of truth** for "what a {@link TaskAction} *is*
 * on the wire": a `kind: 'tool'` action is a `call.start` (the `mx_delegate_tool`
 * dispatch) and a `kind: 'exec'` action is an `exec.start` (the `mx_run_command`
 * dispatch). Both the create-time authoring (`mx_create_task`, T301) and the
 * dispatch path (`mx_dispatch_task`, T303) consume {@link actionToDispatch}, so the
 * shape **authored** into the DAG is provably the shape that will be **dispatched**
 * (the issue's "alignment"; a drift test pins authored params == dispatch params).
 * No second, divergent copy of the mapping exists.
 *
 * Pure; **never throws**; performs **no** authority decision. The mapper only routes
 * fields; the receiving daemon re-runs the full authorize pipeline at dispatch.
 * `action.args` / `command_args` (the most dangerous surface — the likeliest place a
 * credential is inlined) are guarded by the toolbelt `MxClient`
 * (`assertNoCredentialShapedArgs`) at **both** authoring (T301) and dispatch (T303);
 * this mapper re-implements no guard.
 */
import type { TaskAction } from './task-projection.js';

/**
 * The dispatch a {@link TaskAction} resolves to: a named-tool `call.start` or a
 * guarded `exec.start`. A closed discriminated union mirroring the delegation /
 * exec input surface (`mx_delegate_tool` / `mx_run_command`). `args` /
 * `command_args` default to empty (never `undefined`) so the dispatch path always
 * has a concrete value to forward.
 */
export type ActionDispatch =
  | { readonly mode: 'tool'; readonly tool: string; readonly args: Record<string, unknown> }
  | {
      readonly mode: 'exec';
      readonly command: string;
      readonly command_args: readonly string[];
      readonly cwd?: string;
    };

/** A {@link TaskAction} that cannot be dispatched (a tool action with no `tool`, or
 *  an exec action with no `command`). `invalid` is a fixed, secret-free reason. */
export interface InvalidActionDispatch {
  readonly invalid: string;
}

/** True iff {@link actionToDispatch} could not map the action to a dispatch. */
export function isInvalidDispatch(d: ActionDispatch | InvalidActionDispatch): d is InvalidActionDispatch {
  return 'invalid' in d;
}

/**
 * Map an authored {@link TaskAction} onto the {@link ActionDispatch} it should run
 * as. Pure; **total** (never throws). Returns an {@link InvalidActionDispatch} for an
 * action that cannot be dispatched (missing `tool` / `command`) — the dispatch
 * handler maps that to `invalid_args`, and the authoring handler authors only the
 * declared fields and lets the daemon validate legality.
 */
export function actionToDispatch(action: TaskAction): ActionDispatch | InvalidActionDispatch {
  if (action.kind === 'exec') {
    if (action.command === undefined || action.command === '') {
      return { invalid: 'exec action carries no command to run' };
    }
    return {
      mode: 'exec',
      command: action.command,
      command_args: action.command_args ?? [],
      ...(action.cwd !== undefined ? { cwd: action.cwd } : {}),
    };
  }
  // kind: 'tool'
  if (action.tool === undefined || action.tool === '') {
    return { invalid: 'tool action carries no tool to invoke' };
  }
  return {
    mode: 'tool',
    tool: action.tool,
    args: action.args ?? {},
  };
}

/**
 * Map an {@link ActionDispatch} onto the daemon's `task.create` `action` param — the
 * shape **authored** into the DAG. The exact inverse of how {@link actionToDispatch}
 * reads a node's action back out: a `kind: 'tool'` action authors `{ kind, tool,
 * args? }`; a `kind: 'exec'` action authors `{ kind, command, args?, cwd? }` (the
 * daemon's exec argv field is `args`, mapped from `command_args`). Empty `args` /
 * `command_args` and an absent `cwd` are omitted so no empty/`undefined` field leaks
 * into the authored record (and the round-trip — author → read → dispatch — is
 * stable). The single source of truth for the authoring side of the alignment.
 */
export function dispatchToCreateActionParam(dispatch: ActionDispatch): Record<string, unknown> {
  if (dispatch.mode === 'tool') {
    return {
      kind: 'tool',
      tool: dispatch.tool,
      ...(Object.keys(dispatch.args).length > 0 ? { args: dispatch.args } : {}),
    };
  }
  return {
    kind: 'exec',
    command: dispatch.command,
    ...(dispatch.command_args.length > 0 ? { args: dispatch.command_args } : {}),
    ...(dispatch.cwd !== undefined ? { cwd: dispatch.cwd } : {}),
  };
}
