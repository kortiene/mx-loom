/**
 * `mx_find_agents` — the agent-discovery handler (T104 / #12) — design §2 (the
 * discovery verbs). "Who is in the workspace and what can they do?"
 *
 * A `sync` read: a single `agent.list` call, the descriptor's filters applied
 * **client-side** with **AND** semantics (an absent filter matches all), each
 * surviving row projected onto a non-secret {@link AgentSummary}, returned as
 * `ok({ agents }, EMPTY_AUDIT_REF)`. AC 1 — "filter by capability returns the
 * expected agents".
 *
 * It reuses the T103 {@link HandlerDeps} seam (the injected daemon-call surface,
 * no socket / no env), builds the result only through the T102 helpers, and
 * **never throws** — a transport/daemon fault maps onto the closed taxonomy via
 * the shared {@link faultToResult} (mirroring `mxAwaitResult`). Discovery is a
 * **local** daemon read, so the result's `audit_ref` ids are all-null
 * ({@link EMPTY_AUDIT_REF}) — never fabricated.
 *
 * Wire assumptions are localised to the consts below so the two-daemon round-trip
 * (or a future pin bump) corrects them in one line, per the `await-result.ts`
 * precedent.
 */
import type { AgentLiveness } from '@mx-loom/toolbelt';

import { ok, type ToolResult } from '../envelope.js';
import {
  projectAgentSummary,
  publishedToolNames,
  readListRow,
  readLiveness,
  readStringArray,
  readString,
  readToolNames,
  type AgentListRow,
  type AgentSummary,
} from './agent-projection.js';
import type { HandlerDeps } from './deps.js';
import { EMPTY_AUDIT_REF, faultToResult } from './handler-fault.js';

/** The verified v0.2.1 discovery RPCs (and the `agent.tools` param name). Localised
 *  so a pin bump corrects the wire in one place (the `await-result.ts` precedent). */
const AGENT_LIST_METHOD = 'agent.list';
const AGENT_TOOLS_METHOD = 'agent.tools';
const AGENT_ID_PARAM = 'agent_id';

/** Input of `mx_find_agents` — exactly the descriptor's schema (all optional). */
export interface FindAgentsInput {
  readonly capability?: string;
  readonly tool?: string;
  readonly liveness?: AgentLiveness;
}

/**
 * Discover agents, optionally filtered by `capability` / `tool` / `liveness`.
 *
 * Algorithm: one `agent.list` → normalise rows → apply the AND-combined filters
 * client-side → project → `ok({ agents })`. A non-array / malformed *successful*
 * response yields an empty (but valid) result — "no agents matched" is not an
 * error. A failed call maps onto a fault envelope.
 */
export async function mxFindAgents(input: FindAgentsInput, deps: HandlerDeps): Promise<ToolResult> {
  let rows: unknown;
  try {
    rows = await deps.daemon.call(AGENT_LIST_METHOD);
  } catch (err) {
    return faultToResult(err, EMPTY_AUDIT_REF);
  }

  // A non-array / malformed payload on a *successful* call → an empty result, not
  // an error: a missing or unparseable list means "no agents matched".
  const entries: AgentListRow[] = Array.isArray(rows)
    ? rows.map(readListRow).filter((e): e is AgentListRow => e !== undefined)
    : [];

  // Cheap, row-local predicates first (liveness + capability), AND-combined.
  let candidates = entries.filter(
    (e) => matchesLiveness(e, input.liveness) && matchesCapability(e, input.capability),
  );

  // The `tool` filter may need a bounded `agent.tools` fan-out (only for the
  // candidates that already passed the cheap predicates).
  if (input.tool !== undefined) {
    candidates = await filterByTool(candidates, input.tool, deps);
  }

  const agents: AgentSummary[] = candidates.map((e) => projectAgentSummary(e.agent, e.liveness));
  return ok({ agents }, EMPTY_AUDIT_REF);
}

/** Liveness predicate: absent filter ⇒ matches all; else the row's derived
 *  liveness (fail-closed `offline`) must equal the requested value. */
function matchesLiveness(entry: AgentListRow, want: AgentLiveness | undefined): boolean {
  return want === undefined || readLiveness(entry.liveness) === want;
}

/** Capability predicate: absent filter ⇒ matches all; else the agent's
 *  `capabilities[]` must include the requested capability. */
function matchesCapability(entry: AgentListRow, want: string | undefined): boolean {
  return want === undefined || readStringArray(entry.agent.capabilities).includes(want);
}

/**
 * Keep only the candidates publishing a tool named `tool`. Reads tool names from
 * the list row when it carries them (no extra RPC); otherwise resolves
 * `agent.tools` for that single candidate (bounded fan-out). A per-agent
 * `agent.tools` fault is tolerated as "no match" — it never fails the whole query.
 */
async function filterByTool(
  candidates: AgentListRow[],
  tool: string,
  deps: HandlerDeps,
): Promise<AgentListRow[]> {
  const kept: AgentListRow[] = [];
  for (const entry of candidates) {
    const fromRow = readToolNames(entry.agent.tools);
    const names = fromRow ?? (await resolveToolNames(entry.agent, deps));
    if (names.includes(tool)) kept.push(entry);
  }
  return kept;
}

/** Resolve one candidate's published tool names via `agent.tools`. A fault (or an
 *  agent without an `agent_id`) yields `[]` → "no match", never a thrown query. */
async function resolveToolNames(agent: Record<string, unknown>, deps: HandlerDeps): Promise<string[]> {
  const agentId = readString(agent.agent_id);
  if (agentId === undefined) return [];
  try {
    const resp = await deps.daemon.call(AGENT_TOOLS_METHOD, { [AGENT_ID_PARAM]: agentId });
    return publishedToolNames(resp);
  } catch {
    return [];
  }
}
