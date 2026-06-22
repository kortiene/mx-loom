/**
 * Agent-record projection for the discovery handlers (T104 / #12) — design §2
 * (the discovery verbs) / §4.7 / §6 (the secret-free output boundary).
 *
 * The **redaction/shaping heart** shared by `mx_find_agents` and
 * `mx_describe_agent`. It maps the daemon's `AgentState` / `ToolSchema` payloads
 * onto the non-secret, model-facing {@link AgentSummary} / {@link AgentDetail} /
 * {@link PublishedTool} shapes the descriptors declare. Pure: no I/O, **never
 * throws** — every reader is total and degrades a malformed value to "absent".
 *
 * **Allowlist-by-construction.** The projectors only ever read *named* fields, so
 * a field added to `AgentState` upstream can never silently leak into the model
 * context. The public-but-noisy identifiers (`matrix_user_id`, `device_id`,
 * `signing_key_id`, `signing_public_key`, `state_rev`) are deliberately **never
 * copied** — defense in depth on top of the daemon's own secret boundary (T008),
 * keeping the canonical contract free of any credential-substring field name
 * (design §4.7). The daemon's `AgentState` carries no Matrix tokens, Ed25519
 * *private* keys, provider keys, or `GH_TOKEN` in the first place — those stay
 * daemon-held — but discovery still projects to a strict subset.
 *
 * The exact v0.2.1 surface is pinned in `docs/mx-agent-surface-v0.2.1.md` (T001):
 * `AgentState = { agent_id, kind, …, capabilities[], tools[], workspace{…},
 * load{…}, last_seen_ts, … }`; `ToolSchema = { name, version, description,
 * input_schema, output_schema }`, returned by `agent.tools` under `schemas`.
 */
import type { AgentLiveness } from '@mx-loom/toolbelt';

// Re-export the liveness enum from its single source (the toolbelt's typed agent
// view) so handlers + bindings name it from one place. `type`-only, erased under
// `verbatimModuleSyntax`, so the registry keeps its zero runtime toolbelt dep.
export type { AgentLiveness } from '@mx-loom/toolbelt';

/** The `mx_find_agents` row — a non-secret subset of `AgentState` + derived liveness. */
export interface AgentSummary {
  readonly agent_id: string;
  readonly kind?: string;
  readonly capabilities: string[];
  readonly liveness: AgentLiveness;
}

/** The `mx_describe_agent` `agent` sub-object — a richer non-secret `AgentState` subset. */
export interface AgentDetail {
  readonly agent_id: string;
  readonly kind?: string;
  readonly status?: string;
  readonly capabilities: string[];
  readonly liveness?: AgentLiveness;
  readonly workspace?: { cwd?: string; project_id?: string; git_commit?: string };
  readonly load?: { running_invocations?: number; max_invocations?: number };
  readonly last_seen_ts?: number;
}

/** The projection of one published `ToolSchema` (`com.mxagent.tool.v1`). The inner
 *  `input_schema` / `output_schema` pass through **verbatim** — the model needs
 *  them to build a `mx_delegate_tool` call (T105). */
export interface PublishedTool {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly input_schema?: Record<string, unknown>;
  readonly output_schema?: Record<string, unknown>;
}

/** One normalised `agent.list` row: the `AgentState` record + its raw liveness. */
export interface AgentListRow {
  readonly agent: Record<string, unknown>;
  readonly liveness: unknown;
}

// ---------------------------------------------------------------------------
// Small, total readers — no throw, no assumption about the wire layout. A value
// of the wrong shape reads as "absent" (mirrors `invocation.ts`'s reader style).
// ---------------------------------------------------------------------------

export function asRecord(x: unknown): Record<string, unknown> | undefined {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined;
}

export function readString(x: unknown): string | undefined {
  return typeof x === 'string' ? x : undefined;
}

function readNumber(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}

export function readStringArray(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : [];
}

/** Validate a raw liveness against the enum; an absent/unknown value fails **closed**
 *  to `'offline'` (never optimistically `'active'`) — symmetric with `invocation.ts`'s
 *  fail-safe `high` risk. */
export function readLiveness(x: unknown): AgentLiveness {
  return x === 'active' || x === 'stale' || x === 'offline' ? x : 'offline';
}

/**
 * Normalise one `agent.list` row to `{ agent, liveness }`. The verified v0.2.1
 * shape is `{ agent: AgentState, liveness }`; as a defensive fallback, a row that
 * *is itself* an agent record (carries `agent_id`, no wrapper) is read as the
 * agent with an absent liveness. A non-object / unrecognised row reads as absent.
 */
export function readListRow(row: unknown): AgentListRow | undefined {
  const r = asRecord(row);
  if (r === undefined) return undefined;
  const agent = asRecord(r.agent);
  if (agent !== undefined) return { agent, liveness: r.liveness };
  if (typeof r.agent_id === 'string') return { agent: r, liveness: r.liveness };
  return undefined;
}

/**
 * Best-effort tool **names** carried by a row's `AgentState.tools` array, for the
 * `mx_find_agents` `tool` filter without an N+1 — but **only** when the row is
 * unambiguously rich enough. The contract is deliberately conservative because it
 * is unverified (spec Open Question #3) whether the v0.2.1 row `tools` array even
 * carries names, or whether names live solely in `agent.tools.schemas`:
 *  - a **non-empty** array of strings / `{ name }` objects ⇒ the extracted names
 *    (filter from the row, no extra RPC);
 *  - anything else — not an array, an **empty** array, or a non-empty array
 *    yielding no names ⇒ `undefined`, meaning "the row carries no usable tool
 *    info; resolve `agent.tools` instead". An empty array is treated as ambiguous
 *    (not "definitively no tools"), so a daemon that always ships an empty row
 *    `tools[]` never causes a false negative on the `tool` filter.
 */
export function readToolNames(tools: unknown): string[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const names: string[] = [];
  for (const t of tools) {
    if (typeof t === 'string') {
      names.push(t);
      continue;
    }
    const name = readString(asRecord(t)?.name);
    if (name !== undefined) names.push(name);
  }
  return names.length > 0 ? names : undefined;
}

// ---------------------------------------------------------------------------
// Projectors — allowlist-by-construction; copy ONLY the named non-secret fields.
// ---------------------------------------------------------------------------

/** Project an `AgentState` + raw liveness onto the `mx_find_agents` row. */
export function projectAgentSummary(agent: unknown, liveness: unknown): AgentSummary {
  const a = asRecord(agent) ?? {};
  const kind = readString(a.kind);
  return {
    agent_id: readString(a.agent_id) ?? '',
    ...(kind !== undefined ? { kind } : {}),
    capabilities: readStringArray(a.capabilities),
    liveness: readLiveness(liveness),
  };
}

/** Project an `AgentState` + raw liveness onto the `mx_describe_agent` `agent` sub-object. */
export function projectAgentDetail(agent: unknown, liveness: unknown): AgentDetail {
  const a = asRecord(agent) ?? {};
  const kind = readString(a.kind);
  const status = readString(a.status);
  const workspace = projectWorkspace(a.workspace);
  const load = projectLoad(a.load);
  const lastSeen = readNumber(a.last_seen_ts);
  return {
    agent_id: readString(a.agent_id) ?? '',
    ...(kind !== undefined ? { kind } : {}),
    ...(status !== undefined ? { status } : {}),
    capabilities: readStringArray(a.capabilities),
    liveness: readLiveness(liveness),
    ...(workspace !== undefined ? { workspace } : {}),
    ...(load !== undefined ? { load } : {}),
    ...(lastSeen !== undefined ? { last_seen_ts: lastSeen } : {}),
  };
}

function projectWorkspace(x: unknown): AgentDetail['workspace'] {
  const w = asRecord(x);
  if (w === undefined) return undefined;
  const cwd = readString(w.cwd);
  const project_id = readString(w.project_id);
  const git_commit = readString(w.git_commit);
  if (cwd === undefined && project_id === undefined && git_commit === undefined) return undefined;
  return {
    ...(cwd !== undefined ? { cwd } : {}),
    ...(project_id !== undefined ? { project_id } : {}),
    ...(git_commit !== undefined ? { git_commit } : {}),
  };
}

function projectLoad(x: unknown): AgentDetail['load'] {
  const l = asRecord(x);
  if (l === undefined) return undefined;
  const running = readNumber(l.running_invocations);
  const max = readNumber(l.max_invocations);
  if (running === undefined && max === undefined) return undefined;
  return {
    ...(running !== undefined ? { running_invocations: running } : {}),
    ...(max !== undefined ? { max_invocations: max } : {}),
  };
}

/**
 * Project the daemon's `schemas: ToolSchema[]` (from `agent.tools`) onto
 * {@link PublishedTool}`[]`. A non-array or an entry without a string `name` is
 * skipped; `input_schema` / `output_schema` are passed through **verbatim**.
 */
export function projectTools(schemas: unknown): PublishedTool[] {
  if (!Array.isArray(schemas)) return [];
  const out: PublishedTool[] = [];
  for (const s of schemas) {
    const r = asRecord(s);
    const name = r !== undefined ? readString(r.name) : undefined;
    if (r === undefined || name === undefined) continue;
    const version = readString(r.version);
    const description = readString(r.description);
    const input_schema = asRecord(r.input_schema);
    const output_schema = asRecord(r.output_schema);
    out.push({
      name,
      ...(version !== undefined ? { version } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(input_schema !== undefined ? { input_schema } : {}),
      ...(output_schema !== undefined ? { output_schema } : {}),
    });
  }
  return out;
}

/** The distinct tool names an `agent.tools` response publishes (from `schemas`,
 *  supplemented by any names on the row-style `tools` array). Used by the
 *  `mx_find_agents` `tool` filter's bounded `agent.tools` fan-out. */
export function publishedToolNames(toolsResponse: unknown): string[] {
  const r = asRecord(toolsResponse);
  if (r === undefined) return [];
  const fromSchemas = projectTools(r.schemas).map((t) => t.name);
  const fromTools = readToolNames(r.tools) ?? [];
  return [...new Set([...fromSchemas, ...fromTools])];
}
