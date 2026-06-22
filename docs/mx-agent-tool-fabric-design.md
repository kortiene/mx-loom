# MX-Agent as the Coordination Fabric for Agent Teams

**A portable tool interface across Google ADK, Claude SDK, OpenCode SDK, Pi SDK, and custom runners**

| | |
|---|---|
| Status | Active — M0 in progress (T001–T005 delivered); see `docs/backlog.md` |
| Date | 2026-06-18 |
| Substrate pin | mx-agent `v0.2.1` (alpha) |
| Closes | mx-agency #37 (SDK seam) |

## Locked design decisions

1. **Binding strategy — both in parallel.** The canonical tool registry feeds *both* a generated MCP server (universal binding) *and* a Claude Agent SDK native shim from day one, to prove portability immediately.
2. **Delegation surface — named tools + guarded exec.** Ship `mx_delegate_tool` (named tools) *and* `mx_run_command`, the latter disabled by default and enabled per-agent only behind strict `allow_commands` + `deny_args_regex`. No unrestricted exec.
3. **Home — this document** lives in `mx-ai/docs/` as an iterable design doc.

---

## Thesis

Runtimes own **cognition** (model loop, planning, memory, tool selection). MX-Agent owns **coordination** (discovery, secure remote invocation, task DAG, approvals, trust, audit, Matrix transport). The integration layer is a thin, transport-neutral **toolbelt** that renders mx-agent's daemon RPC as ordinary "tools" in each runtime's native tool-calling ABI — while keeping all secrets, signing, and enforcement out-of-process in the daemon.

Two grounding facts make this the natural shape rather than a reframe:

- **mx-agent is already a coordination substrate, not a cognition runtime.** It ships no external SDK; its only programmatic surface is a UID-gated Unix-socket JSON-RPC 2.0 daemon. It already models agents, tools, tasks, trust, and approvals as signed `com.mxagent.*` Matrix events.
- **mx-agency already specced this seam** (ADR-11 integration contract, ADR-04 runtime cognition design) and left it unimplemented behind `app/src/sdk` (issue #37), behind a pluggable `AgentRunner` interface that already abstracts Claude/Pi/Codex/OpenCode. The missing piece is exactly: expose mx-agent as portable tools to those runners.

---

## 1. The architectural boundary

Four planes, two hard boundaries. New work lives entirely in the middle plane.

```
┌─────────────────────────────────────────────────────────────────┐
│ COGNITION PLANE  — external runtime (ADK / Claude SDK / OpenCode  │
│ / Pi / custom)                                                    │
│   model loop · planning · private memory · prompt · tool-select   │
└───────────────▲───────────────────────────────────────────────────┘
                │  Boundary A: the runtime's tool-call ABI
                │  (function-calling / MCP). Plain JSON in/out.
┌───────────────▼───────────────────────────────────────────────────┐
│ ADAPTATION PLANE — "mx-loom" (the only new code)              │
│   canonical tool registry · result envelope · async handles ·     │
│   per-runtime bindings (MCP server + native shims) · session map  │
│   NO secrets. NO model. NO enforcement — it only translates.      │
└───────────────▲───────────────────────────────────────────────────┘
                │  Boundary B: daemon Unix-socket JSON-RPC 2.0
                │  (4-byte len prefix + JSON; UID-gated; mode 0600)
┌───────────────▼───────────────────────────────────────────────────┐
│ COORDINATION PLANE — mx-agent daemon (per host)                  │
│   Ed25519 signing · trust store · policy.toml · sandbox · /sync   │
│   task scheduler · approval gate · owns ALL Matrix credentials    │
└───────────────▲───────────────────────────────────────────────────┘
                │  Matrix federation + signed com.mxagent.* events
┌───────────────▼───────────────────────────────────────────────────┐
│ SUBSTRATE — Matrix homeserver(s) + remote daemons (the mesh)     │
└───────────────────────────────────────────────────────────────────┘
```

**Governing rule:** cognition can only ever produce a signed *request*; it can never grant itself authority. Trust, policy, sandboxing, and approval execute out-of-process and on the *receiving* daemon. A compromised or hallucinating model cannot escalate, because the thing that says "yes" is not in the runtime.

| Concern | Owner |
|---|---|
| Model, planning, agent memory, prompt assembly, tool-selection loop | **Runtime** (cognition) |
| Identity (Ed25519), trust store, policy, signing, sandbox, Matrix session/keys | **Daemon** (coordination) |
| Durable task DAG, approvals, audit (signed events), cross-agent context | **Daemon / substrate** |
| Tool *descriptors* + result normalization + async handling + per-runtime binding | **mx-loom** (adaptation) |

The toolbelt is deliberately dumb and secret-free: it speaks JSON-RPC to the daemon and JSON tools to the runtime. That is the whole job.

---

## 2. Core MX-Agent tools exposed to LLM runners

The daemon has ~45 RPC methods; most are operator/crypto/lifecycle plumbing that must **never** be a model tool. The model-facing set is ~12 verbs covering *discover → delegate → coordinate → share → observe*.

| Tool (model-facing) | Maps to daemon RPC | Purpose |
|---|---|---|
| `mx_find_agents` | `agent.list` (+capability filter) | Discover agents by capability/tool/liveness |
| `mx_describe_agent` | `agent.show` + `agent.tools` | Inspect one agent and the `ToolSchema[]` it offers |
| `mx_workspace_status` | `workspace.status` | Who/what is in the workspace (agents, tasks, project) |
| `mx_delegate_tool` | `call.start` → `CallRequest`/`CallResponse` | **Primary delegation verb** — invoke a *named tool* on a remote agent with JSON args |
| `mx_run_command` *(guarded)* | `exec.start` → `ExecRequest` | Run an allowlisted command on a remote agent. Disabled by default; enabled per-agent via `allow_commands` + `deny_args_regex` |
| `mx_await_result` | `invocation.get` / `task.watch` | Resolve a deferred handle (running / awaiting-approval → terminal) |
| `mx_cancel` | `invocation.cancel` | Cancel an in-flight invocation |
| `mx_create_task` / `mx_update_task` / `mx_list_tasks` | `task.create/update/list/graph` | Author and read the shared, durable plan (DAG) |
| `mx_share_context` | `share.file` / `share.diff` / `share.env` | Publish a diff/file/env artifact to the workspace |
| `mx_get_context` | `share.list` / `share.get` | Fetch a shared artifact by id |

**Explicitly NOT model tools** (operator / out-of-band only): `trust.publish`/approve/revoke, `approval.decide`, `policy.*`, `auth.*`, `device.verify.*`, `cross_signing.*`, `recovery.*`, `daemon.*`. The model may *read* trust/approval state but never *decide* it. Approvals reach the model only as a **result status**, never as a grant it can issue to itself.

Each tool is described to the model with: a namespaced name (`mx_*`), a one-line description, an **input JSON Schema** (forwarded from `ToolSchema.input_schema` for `mx_delegate_tool`), and the normalized **result envelope** (§4).

---

## 3. How each runtime consumes the tools

The canonical registry is transport-neutral. **MCP is the universal binding** (every target runtime speaks it); **native shims** are added where a runtime offers something *better* for async / human-in-the-loop than generic MCP. Per the locked decision, the MCP server and the Claude native shim are both built from day one.

**Google ADK (Python).**
- Default: mount the toolbelt as an `MCPToolset` on an `LlmAgent` (`tools=[MCPToolset(...)]`).
- Better for approval-blocking delegation: wrap `mx_delegate_tool` / `mx_run_command` as a `LongRunningFunctionTool`. ADK's long-running tool protocol is a near-perfect match for mx-agent's `awaiting_approval` flow — the tool returns a pending ticket, the agent keeps reasoning, ADK resumes when the result arrives. `ToolContext` carries the session/handle.

**Claude Agent SDK (TypeScript — the mx-agency default runner).**
- In-process: define tools with `createSdkMcpServer` + `tool()` (Zod schemas); the toolbelt runs inside the agent process, no extra socket.
- Or external: register the toolbelt as an external MCP server in `options.mcpServers`.
- Approval surface: use the `canUseTool` callback to intercept `mx_*` calls — it can short-circuit to the daemon's approval state and present HITL without the model ever seeing credentials. Cleanest HITL hook of the four.

**OpenCode SDK.**
- Register the toolbelt as an MCP server (local stdio or remote) in `opencode.json` (`mcp` block). OpenCode surfaces MCP tools to its agents directly; no custom code beyond the server entry.

**Pi SDK (`@earendil-works/pi-coding-agent`).**
- Consume via MCP if the Pi build supports it; otherwise register the canonical descriptors through Pi's native tool-registration API using the same JSON Schemas. Because mx-agency already wraps Pi behind `AgentRunner`, the Pi binding is a thin map from the canonical registry to Pi's tool type.

**Custom runners.** Anything that can (a) call a Unix socket and (b) accept a JSON-Schema tool list gets the tools for free — point it at the MCP server, or link the toolbelt library directly.

> **Build rule:** never hand-author tools per runtime. One canonical descriptor set → generated MCP server + generated native shims (ADK `LongRunningFunctionTool`, Claude `canUseTool`) from day one.

---

## 4. The minimum common tool contract

Seven requirements; every runtime binding must honor them.

1. **Namespaced descriptor.** `name` (`mx_*`), `description`, `input_schema` (JSON Schema). For `mx_delegate_tool`, the inner tool's `input_schema` is passed through from the target agent's published `ToolSchema`.

2. **One normalized result envelope** — the single shape every tool returns:

```jsonc
{
  "status": "ok" | "running" | "awaiting_approval" | "denied" | "error",
  "result":  { /* tool-specific success payload, validated vs output_schema */ } | null,
  "error":   { "code": "policy_denied|untrusted_key|approval_denied|approval_expired|
                        timeout|not_found|invalid_args|target_offline|internal",
               "message": "human-readable, NO secrets" } | null,
  "handle":  "inv_01HZ..." | null,        // present when status=running|awaiting_approval
  "approval": { "request_id": "req_…", "risk": "low|medium|high",
                "summary": "…", "expires_at": "…" } | null,
  "audit_ref": { "invocation_id": "inv_…", "request_id": "req_…",
                 "room": "!…:server", "event_id": "$…" }   // correlation, always present
}
```

3. **Deferred-result protocol.** Remote calls and approvals are async. Long-running ops return `status: running|awaiting_approval` + a `handle`; the model (or the binding) resolves via `mx_await_result(handle, wait_ms)`. Runtimes with native long-running tools (ADK, Claude) hide the poll loop; others poll. This is the one piece of semantics a runtime cannot skip.

4. **Idempotency.** Every mutating call carries a client-supplied `idempotency_key` (the daemon already uses `idempotency_key`/`nonce` for replay protection). Retried tool calls must not double-execute.

5. **Stable error taxonomy.** The closed `error.code` set above — so a runtime can react programmatically (e.g., `untrusted_key` → surface an onboarding hint; `awaiting_approval` → keep planning).

6. **Audit correlation on every result.** `audit_ref` ties the model's action to the signed Matrix event(s).

7. **Secret-free contract.** No field ever carries Matrix tokens, signing keys, or device secrets, inbound or outbound. The toolbelt rejects args that look like credential injection.

A runtime that satisfies these seven gets correct, safe behavior regardless of which mx-agent verbs it surfaces.

---

## 5. Invocation flow: LLM → MX-Agent → remote agent

**Happy path (`mx_delegate_tool`, no approval gate):**

```
1. Model emits tool call: mx_delegate_tool{ agent:"backend-dev-01",
                          tool:"run_tests@1.0.0", args:{package:"api"} }
2. Runtime binding → mx-loom → daemon RPC  call.start(room, agent, tool, args, idem)
3. Local daemon signs CallRequest (Ed25519) → emits com.mxagent.call.request.v1 into room
4. Remote daemon /sync receives → verify signature → trust store → policy.toml
                          → (no approval needed) → validate args vs input_schema
                          → execute tool in sandbox
5. Remote daemon emits com.mxagent.call.response.v1 { ok, result | error }
6. Local daemon reconciles → toolbelt normalizes → { status:"ok", result, audit_ref }
7. Model receives result and continues reasoning.
```

**Approval-gated path:**

```
4'. Remote policy: requires_approval=true → daemon HOLDS request,
                   emits com.mxagent.approval.request.v1 { summary, risk, expires_at }
5'. Toolbelt returns { status:"awaiting_approval", handle:"inv_…", approval:{…} }
       → ADK: LongRunningFunctionTool pending ticket
       → Claude: canUseTool surfaces it
       → others: model gets the status and proceeds with other work
6'. Human operator decides in the approval UI → daemon emits signed approval.decision.v1
7'. Remote daemon RE-RUNS the full authorize pipeline (sig→trust→policy) then executes
8'. Model (or binding) calls mx_await_result(handle) → { status:"ok", result } | { status:"denied" }
```

Two properties: the model never blocks the operator (it can fan out other work while a delegation is pending), and approval is re-validated against live policy at release time — a stale approval can't smuggle through if trust was revoked in the interim.

---

## 6. Security, trust, approval, policy

The security model is inherited from the daemon; the integration's job is to **not weaken it**. Five layers, all out-of-process from cognition:

1. **Identity = Ed25519, daemon-held.** Signing key at `~/.local/share/mx-agent/signing_key.ed25519` (mode 0600), never readable by the runtime or child processes. The toolbelt cannot sign — only the daemon can. Authority comes from the key, asserted by the daemon, not from anything the model says.

2. **Trust store is final authority and operator-only.** `(agent_id, key_id)` trust is approved out-of-band (`mx-agent trust approve`); the local store overrides room-advertised trust. The model is never given trust-mutation tools. Onboarding a new runtime agent = an operator action, surfaced to the model only as an `untrusted_key` error if missing.

3. **Policy is deny-by-default and enforced on the receiver.** `policy.toml` gates `allow_tools`, `allow_commands`, `allow_cwd`, `deny_args_regex`, runtime/output caps, sandbox backend, network, `requires_approval`. Because enforcement runs on the *target* daemon, the requesting model's privileges are irrelevant — it gets exactly what the target's operator allows.

4. **Guarded exec.** `mx_run_command` ships disabled. To enable it for an agent, the operator sets `allow_commands` (an explicit binary allowlist), `deny_args_regex` (e.g. block `curl … | sh`, `rm -rf /`, `ssh`), `allow_cwd`, and a tight sandbox + `network = "deny"`. High-risk commands should additionally carry `requires_approval = true`. No agent gets unrestricted exec.

5. **Approval = human-in-the-loop, re-validated at release.** High-risk ops hold pending an operator decision; the model experiences this purely as the `awaiting_approval` envelope status. No model-driven approvals, ever.

6. **Sandbox + secret boundary.** Tool/exec runs are confined (bubblewrap/docker/podman) with env scrubbing and resource caps. Reinforce mx-agency's rule: `MATRIX_*`, `MX_AGENT_*`, provider keys, `GH_TOKEN` are never forwarded into the runtime process or the model context. The toolbelt is the chokepoint enforcing "no secret crosses Boundary A."

Net property: the blast radius of a misbehaving model is bounded by the union of policies of the agents it can reach — not by what the model decides about itself.

---

## 7. Context, task state, sessions, audit

Keep a clean line between **ephemeral cognition state (runtime)** and **durable coordination state (substrate)**.

- **Context.** *Private agent memory* (scratchpad, conversation, retrieved knowledge) stays in the runtime — MX-Agent doesn't touch it. *Shared/cross-agent context* (diffs, files, env snapshots) moves through `mx_share_context` / `mx_get_context` as `com.mxagent.context.share.v1` (inline ≤256 KiB, else Matrix media + sha256). Rule: if another agent needs to see it, it's an MX share; if only this agent's reasoning needs it, it's runtime memory.

- **Task state.** The DAG (`com.mxagent.task.v1`) is the durable, shared plan — `proposed→pending→assigned→executing→succeeded/failed`, with `depends_on`/`blocks` and signed `action`. The runtime owns how to think about the plan; MX owns the plan of record. This is also the crash-recovery boundary: a runtime can die and a new one resumes from task state.

- **Sessions.** Define `MxSession = { agent_id, room/workspace, daemon socket, correlation_id }`. A runtime conversation maps 1:1 to an MX agent registration. The toolbelt holds the session handle and threads `correlation_id` onto every call so a cognitive session is reconstructable across delegations. Registration (`agent.register`) happens once at session start; heartbeats keep liveness. *(Implemented in T005: `openSession()` in `packages/toolbelt` is the session entry point — registration is toolbelt-run lifecycle, not a model tool, and `correlation_id` is stamped on every outbound call. Stamping into the signed Matrix events — so it survives across delegations — is gated on daemon support and off by default until verified. The `audit_ref` the id ultimately lands in is the M1 envelope, T102, not yet built.)*

- **Audit.** The signed Matrix event stream is the audit log — immutable, room-scoped, Ed25519-signed, replay-protected. Every tool result carries `audit_ref`, so the app layer can correlate "model decided X" ↔ "daemon executed Y" ↔ "operator approved Z." Mirror these into mx-agency's existing audit store (ADR-07/ADR-10, Postgres + RLS) for queryable, tenant-scoped history. Two-tier audit: substrate = tamper-evident truth, app store = queryable index.

---

## 8. MVP scope

One runtime family, one workspace, the delegation core — and finally close issue #37.

- **mx-loom v0 (TypeScript)** — implements ADR-11's transport: daemon IPC primary, `--json` CLI fallback, behind the `app/src/sdk` seam. `createClient()` (→ `MxClient`) is the base transport entry point; it selects transport and fails over IPC→CLI **only on `not_running`** (the one provably pre-dispatch fault), so no possibly-applied mutating call is ever re-issued. `openSession()` (→ `MxSession`) layers the session model on top: one `agent.register` at start, a cancellable liveness heartbeat, and a session-stable `correlation_id` stamped on every outbound call. Pin mx-agent `v0.2.1` + a conformance check before any version bump.
- **Canonical registry** with: `mx_find_agents`, `mx_describe_agent`, `mx_delegate_tool`, `mx_run_command` (guarded, off by default), `mx_await_result`, `mx_share_context`, `mx_get_context`. (Full task tools follow in Phase 3.)
- **Both bindings from day one:** a generated MCP server *and* a Claude Agent SDK in-process binding (`createSdkMcpServer` + `tool()`), with `canUseTool` wired to the approval status.
- **The full result envelope (§4)** including the `awaiting_approval` deferred path and `mx_await_result`.
- **Single workspace, single tenant.** Operator-provisioned trust + a minimal `policy.toml` (allow a couple of named tools, one allowlisted command for `mx_run_command`, deny network).
- **Read-only audit refs** surfaced on every result + a thin mirror into the existing Postgres audit table.
- **Golden end-to-end test:** a Claude-SDK agent calls `mx_delegate_tool("run_tests")` on a *second* registered agent across a room, hits an approval gate, operator approves, result returns. The same scenario runs through the MCP server binding too. One test, every boundary.

---

## 9. What to avoid in v1

- **Don't give cognition any authority surface.** No `trust.*`, `approval.decide`, `policy.*`, `auth.*`, `device.*`, `daemon.*` as model tools. Ever.
- **Guarded exec only — no unrestricted exec.** `mx_run_command` is in v1, but only behind explicit `allow_commands` + `deny_args_regex` + tight sandbox. Never a wildcard command surface.
- **Don't build a new transport or fork mx-agent.** Consume across the process boundary exactly as ADR-11 dictates; the daemon socket is the contract.
- **Don't stream tool output into the model.** Use artifacts + `tail_preview` and `mx_get_context`; live `StreamChunk` plumbing into a model loop is v2+.
- **Don't unify memory across runtimes.** Agent memory stays runtime-private; only shared context flows through MX.
- **Don't hand-author N tool sets.** One canonical registry → generated bindings.
- **Don't do multi-tenant, billing, or cost guardrails yet** (ADR-03/ADR-12); keep the toolbelt tenant-agnostic so it composes later.
- **Don't auto-approve or let the model self-approve.** Approval is always human + re-validated.
- **Don't depend on unstable daemon surfaces.** Gate behind the conformance suite; treat alpha `v0.2.1` as capable substrate, not hardened dependency.

---

## 10. Roadmap

| Phase | Goal | Key deliverables | Exit criteria |
|---|---|---|---|
| **0 — SDK seam** | Close #37 | mx-loom: IPC + CLI-fallback transport; session model + agent registration; version pin + conformance suite | Toolbelt can `agent.register`, `agent.list`, `call.start` against a live daemon; conformance green on v0.2.1 |
| **1 — Delegation MVP** | One runtime family, both bindings | Canonical registry (7 tools incl. guarded `mx_run_command`) + result envelope + async handle; **MCP server + Claude native shim**; approval-gated golden test | Claude agent delegates a named tool *and* a guarded command to a remote agent through an approval gate, via both bindings; audit refs land in Postgres |
| **2 — Universal binding** | ADK / OpenCode / Pi | ADK `MCPToolset` + `LongRunningFunctionTool` shim; OpenCode `mcp` entry; Pi binding — all from the same descriptor set | Same golden test passes under ADK, OpenCode, Pi |
| **3 — Coordination depth** | Plans + context as tools | Task DAG tools (`mx_create/update/list_tasks`), `mx_cancel`, `task.watch` resumption | A multi-agent plan executes across ≥2 agents with durable task state surviving a runtime restart |
| **4 — Governance UX** | Operator-grade trust/policy/approval | Trust-onboarding flow, policy authoring UI, approval dashboard wired to `approval.request/decision`; risk surfacing | New runtime agent onboarded and policy-scoped without code changes; approvals fully audited |
| **5 — Multi-tenant + observability** | Agency-scale | Tenant=room scoping (ADR-03), two-tier audit/index, metrics/traces (ADR-08), cost guardrails (ADR-12) | N tenants isolated (RLS), per-tenant audit queryable, per-call cost attributed |
| **6 — Production hardening** | Certify the fabric | Per-runtime conformance certification, MCP server published, chaos/fault tests on approval+revocation, E2EE-on-by-default workspaces, SLA monitoring | "MX-Agent inside" badge: any conformant runtime joins the mesh safely with no bespoke code |

---

## The shape of the win

When this lands, MX-Agent stops being an agent and becomes the **fabric**. A Claude-SDK planner, an ADK specialist, a Pi coder, and a custom runner each keep their own brain — but they discover each other, delegate signed work, share context, gate risk through human approval, and leave a tamper-evident trail, all through one portable toolbelt. Cognition is pluggable; coordination is the constant. That is the decentralized execution fabric for agent teams.
