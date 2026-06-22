/**
 * `mx_describe_agent` — the single-agent inspection handler (T104 / #12) — design
 * §2 (the discovery verbs). "Show me one agent and the exact tool schemas it
 * publishes" — the prerequisite for a `mx_delegate_tool` call (T105), which needs
 * the target tool's `input_schema`.
 *
 * A `sync` read backed by the **verified v0.2.1 surface** (`agent.tools` +
 * `agent.list`). `agent.tools` carries the published `schemas: ToolSchema[]` (+
 * `kind` / `status` / `capabilities`); `agent.list` supplies the
 * liveness / workspace / load metadata the schemas RPC omits. (`agent.show` is
 * **not** in the verified surface table — `docs/mx-agent-surface-v0.2.1.md` — so
 * it is gated off by default; a future pin that verifies it can prefer one
 * targeted `agent.show {agent_id}` instead of the `agent.list` scan.)
 *
 * Returns `ok({ agent, tools }, EMPTY_AUDIT_REF)`. AC 2 — "returns the target's
 * tool schemas". Reuses the T103 {@link HandlerDeps} seam, builds only through the
 * T102 helpers, and **never throws**: an unknown `agent_id` surfaces as the
 * daemon's `unknown_agent`/`not_found` (mapped to `not_found`) via the shared
 * {@link faultToResult}; discovery is a local read, so `audit_ref` ids are all-null.
 */
import { ok, type ToolResult } from '../envelope.js';
import {
  asRecord,
  projectAgentDetail,
  projectTools,
  readListRow,
  readString,
  type AgentDetail,
  type PublishedTool,
} from './agent-projection.js';
import type { HandlerDeps } from './deps.js';
import { EMPTY_AUDIT_REF, faultToResult } from './handler-fault.js';
import { failureResult } from './invocation.js';

/** The verified v0.2.1 discovery RPCs (and the `agent.tools` param name). Localised
 *  so a pin bump corrects the wire in one place (the `await-result.ts` precedent).
 *  `agent.show` is intentionally **not** wired — it is unverified on v0.2.1. */
const AGENT_TOOLS_METHOD = 'agent.tools';
const AGENT_LIST_METHOD = 'agent.list';
const AGENT_ID_PARAM = 'agent_id';

/** Input of `mx_describe_agent` — exactly the descriptor's schema (`agent_id` required). */
export interface DescribeAgentInput {
  readonly agent_id: string;
}

/** The `mx_describe_agent` success payload: the agent detail + its published tools. */
export interface DescribeAgentResult {
  readonly agent: AgentDetail;
  readonly tools: PublishedTool[];
}

/**
 * Resolve one agent's record + its published `ToolSchema[]`.
 *
 * Algorithm (verified-surface-first):
 *  1. `agent.tools {agent_id}` → `{ …, schemas: ToolSchema[] }`. A reject (e.g.
 *     `unknown_agent`) maps to a fault envelope (`not_found`).
 *  2. `agent.list` → the row for `agent_id`, for the liveness / workspace / load
 *     the schemas RPC omits. A list failure is tolerated (the merge proceeds with
 *     liveness unknown → fail-safe `offline`).
 *  3. Merge (the list `AgentState` wins; `agent.tools` fields backfill), project,
 *     and return `ok({ agent, tools })`. If neither source knows the agent →
 *     `not_found`.
 */
export async function mxDescribeAgent(input: DescribeAgentInput, deps: HandlerDeps): Promise<ToolResult> {
  // 1. Published tools + base metadata, in one verified call.
  let toolsResp: unknown;
  try {
    toolsResp = await deps.daemon.call(AGENT_TOOLS_METHOD, { [AGENT_ID_PARAM]: input.agent_id });
  } catch (err) {
    return faultToResult(err, EMPTY_AUDIT_REF);
  }

  // 2. Liveness / workspace / load from `agent.list` (verified surface). A list
  //    failure is non-fatal — we can still describe from the `agent.tools` record.
  let listRows: unknown;
  try {
    listRows = await deps.daemon.call(AGENT_LIST_METHOD);
  } catch {
    listRows = undefined;
  }
  const entry = findListEntry(listRows, input.agent_id);

  const toolsRecord = asRecord(toolsResp);
  const toolsAgentId = toolsRecord !== undefined ? readString(toolsRecord.agent_id) : undefined;

  // If neither the list nor `agent.tools` recognises the agent, it does not exist.
  if (entry === undefined && toolsAgentId === undefined) {
    return failureResult('not_found', EMPTY_AUDIT_REF);
  }

  // 3. Merge base metadata (the list `AgentState` wins; `agent.tools` backfills
  //    kind/status/capabilities when the list row is absent), then project.
  const merged: Record<string, unknown> = { ...(toolsRecord ?? {}), ...(entry?.agent ?? {}) };
  const agent: AgentDetail = projectAgentDetail(merged, entry?.liveness);
  const tools: PublishedTool[] = projectTools(toolsRecord?.schemas);

  const result: DescribeAgentResult = { agent, tools };
  return ok(result, EMPTY_AUDIT_REF);
}

/** Find the `agent.list` row whose `AgentState.agent_id` equals `agentId`. */
function findListEntry(listRows: unknown, agentId: string) {
  if (!Array.isArray(listRows)) return undefined;
  for (const row of listRows) {
    const entry = readListRow(row);
    if (entry !== undefined && readString(entry.agent.agent_id) === agentId) return entry;
  }
  return undefined;
}
