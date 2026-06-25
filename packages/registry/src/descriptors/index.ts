/**
 * The canonical descriptor set (design §2, §8) — the static, frozen `mx_*` verbs the
 * fabric surfaces. T101 authored the **7 P0** M1 verbs; T108 added the **2 P1** M1
 * verbs (`mx_cancel` / `mx_workspace_status`), completing the **9-verb M1** surface;
 * T301 added the **3 M3** task-DAG verbs (`mx_create_task` / `mx_update_task` /
 * `mx_list_tasks`); T303 adds the **4th M3** verb `mx_dispatch_task` (dispatch a
 * node's authored action through the authorize pipeline), bringing the full
 * enumerable set to **13**.
 *
 * Two named sets live here:
 *  - {@link CANONICAL_M1_TOOLS} — the 9 M1 verbs (a documented, back-compat subset).
 *  - {@link CANONICAL_TOOLS} — the full 13-verb superset (the 9 M1 verbs + the 4 M3
 *    task verbs). This is what `loadRegistry()` and every binding generator default
 *    to, so the task verbs surface through MCP / Claude / Pi from one source.
 *
 * Metadata only — handler behavior lives in `src/handlers/`.
 */
import { deepFreeze } from '../freeze.js';
import type { ToolDescriptor } from '../descriptor.js';

import { MX_FIND_AGENTS } from './find-agents.js';
import { MX_DESCRIBE_AGENT } from './describe-agent.js';
import { MX_DELEGATE_TOOL } from './delegate-tool.js';
import { MX_RUN_COMMAND } from './run-command.js';
import { MX_AWAIT_RESULT } from './await-result.js';
import { MX_SHARE_CONTEXT } from './share-context.js';
import { MX_GET_CONTEXT } from './get-context.js';
import { MX_CANCEL } from './cancel.js';
import { MX_WORKSPACE_STATUS } from './workspace-status.js';
import { MX_CREATE_TASK } from './create-task.js';
import { MX_UPDATE_TASK } from './update-task.js';
import { MX_LIST_TASKS } from './list-tasks.js';
import { MX_DISPATCH_TASK } from './dispatch-task.js';

export {
  MX_FIND_AGENTS,
  MX_DESCRIBE_AGENT,
  MX_DELEGATE_TOOL,
  MX_RUN_COMMAND,
  MX_AWAIT_RESULT,
  MX_SHARE_CONTEXT,
  MX_GET_CONTEXT,
  MX_CANCEL,
  MX_WORKSPACE_STATUS,
  MX_CREATE_TASK,
  MX_UPDATE_TASK,
  MX_LIST_TASKS,
  MX_DISPATCH_TASK,
};

/**
 * The canonical **M1** descriptor set, in stable order. Frozen. The 7 P0 verbs (T101)
 * followed by the 2 P1 verbs (T108). Kept as a documented subset for back-compat
 * (and the M1-surface drift guards); the full set the registry loads is
 * {@link CANONICAL_TOOLS}.
 */
export const CANONICAL_M1_TOOLS: readonly ToolDescriptor[] = deepFreeze([
  MX_FIND_AGENTS,
  MX_DESCRIBE_AGENT,
  MX_DELEGATE_TOOL,
  MX_RUN_COMMAND,
  MX_AWAIT_RESULT,
  MX_SHARE_CONTEXT,
  MX_GET_CONTEXT,
  MX_CANCEL,
  MX_WORKSPACE_STATUS,
]);

/**
 * The **4 M3 task-DAG** verbs (T301 + T303), in stable order. Frozen. The 3 authoring
 * /reading verbs (`mx_create_task` / `mx_update_task` / `mx_list_tasks`, T301) followed
 * by the dispatch verb (`mx_dispatch_task`, T303). A documented subset; the full
 * enumerable set is {@link CANONICAL_TOOLS}.
 */
export const CANONICAL_M3_TASK_TOOLS: readonly ToolDescriptor[] = deepFreeze([
  MX_CREATE_TASK,
  MX_UPDATE_TASK,
  MX_LIST_TASKS,
  MX_DISPATCH_TASK,
]);

/**
 * The full canonical descriptor set, in stable order. Frozen. The 9 M1 verbs
 * followed by the 4 M3 task verbs (**13 total**). This is the default for
 * `loadRegistry()` and every binding generator (MCP / Claude / Pi), so a single
 * descriptor set drives the model-facing surface across every runtime.
 */
export const CANONICAL_TOOLS: readonly ToolDescriptor[] = deepFreeze([
  ...CANONICAL_M1_TOOLS,
  ...CANONICAL_M3_TASK_TOOLS,
]);
