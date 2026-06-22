/**
 * The canonical M1 descriptor set (design §8) — the static, frozen `mx_*` verbs
 * the Delegation MVP surfaces. T101 authors the **7 P0** verbs (Risk #7); the P1
 * `mx_cancel` / `mx_workspace_status` land with their handlers in T108.
 *
 * Metadata only — handler behavior is T104–T108.
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

export {
  MX_FIND_AGENTS,
  MX_DESCRIBE_AGENT,
  MX_DELEGATE_TOOL,
  MX_RUN_COMMAND,
  MX_AWAIT_RESULT,
  MX_SHARE_CONTEXT,
  MX_GET_CONTEXT,
};

/** The canonical M1 (P0) descriptor set, in stable order. Frozen. */
export const CANONICAL_M1_TOOLS: readonly ToolDescriptor[] = deepFreeze([
  MX_FIND_AGENTS,
  MX_DESCRIBE_AGENT,
  MX_DELEGATE_TOOL,
  MX_RUN_COMMAND,
  MX_AWAIT_RESULT,
  MX_SHARE_CONTEXT,
  MX_GET_CONTEXT,
]);
