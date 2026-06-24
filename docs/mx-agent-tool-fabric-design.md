# MX-Agent as the Coordination Fabric for Agent Teams

**A portable tool interface across Google ADK, Claude SDK, OpenCode SDK, Pi SDK, and custom runners**

| | |
|---|---|
| Status | Active — M0 complete (T001–T008 delivered); M1 in progress — T101–T108 landed (both delegation surfaces: named tools + guarded exec; the shared-context publish/fetch seam; and the cancel + workspace-observe verbs — the **9-verb M1 model-facing surface is complete** at the handler layer); **T111 landed** (`@mx-loom/claude` bootstrapped — JSON Schema → Zod converter, the Claude-binding seam); **T113 landed** (`@mx-loom/audit` — the Postgres queryable-index mirror of `audit_ref`: projection + idempotent sink + best-effort tap); **T109 + T110 landed — both bindings of locked decision #1 are live**: the generated MCP server (`@mx-loom/mcp`) *and* the Claude Agent SDK in-process shim (`@mx-loom/claude`: `createSdkMcpServer()` + `tool()`, hidden poll loop, `canUseTool` HITL), each applying the T113 audit tap once at its single chokepoint; **T114 landed — the GOLDEN end-to-end gate** (`@mx-loom/golden`): one binding-agnostic S1–S8 scenario (discovery → ungated delegation → approval-gated approve/deny → guarded exec → `deny_args_regex` + deny-by-default denials) driven through **both** bindings with a genuinely out-of-band operator, asserting the T102 envelope + the secret boundary + the audit rows for each step — skip-clean locally, fail-not-skip in CI, with the live green (and live-Postgres) staged behind the golden two-daemon fixture (`MXL_CONFORMANCE_TWO_DAEMON=1` + `MXL_CONFORMANCE_GOLDEN_POLICY=1` / `MXL_AUDIT_PG=1`); **T201 landed** — ADK `MCPToolset` recipe (`examples/adk/`, T201 / #23): deny-by-default `safe_mx_mcp_env()` + all non-secret session flags (`--correlation-id`/`--cwd`/`--project-id`/`--git-commit`/`--max-invocations`) wired through `MxSessionOptions`; Python–TypeScript boundary drift guard; ADK e2e acceptance arm gated `MXL_ADK_MCP_E2E=1`; **T204 decided the Pi arm of M2**: no built-in MCP client, so Pi uses native tool registration and treats `@mx-loom/mcp` as reference-only; see `docs/backlog.md` |
| Date | 2026-06-23 |
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
| `mx_find_agents` | `agent.list` (+capability filter) | Discover agents by capability/tool/liveness (T104: capability / tool / liveness filters applied **client-side** with AND semantics; result projected to a non-secret `AgentSummary[]` — `matrix_user_id`, signing identifiers deliberately excluded) |
| `mx_describe_agent` | `agent.show` + `agent.tools` | Inspect one agent and the `ToolSchema[]` it offers (the v0.2.1 T104 handler uses `agent.list` + `agent.tools` — the **verified** surface — since `agent.show` is unconfirmed on v0.2.1; see `docs/mx-agent-surface-v0.2.1.md`) |
| `mx_workspace_status` | `workspace.status` | Who/what is in the workspace (agents, tasks, project) (T108: composes `workspace.status` + `agent.list` — `workspace.status` is the *Matrix room* view, so the registered MX agents come from `agent.list`; the raw `members[].user_id` list is deliberately projected **out**, identities are MX `agent_id`s. Surfaces **agents + project** in M1; the `tasks` dimension is deferred to M3/T301, the output leaving an additive slot) |
| `mx_delegate_tool` | `call.start` → `CallRequest`/`CallResponse` | **Primary delegation verb** — invoke a *named tool* on a remote agent with JSON args |
| `mx_run_command` *(guarded)* | `exec.start` → `ExecRequest` | Run an allowlisted command on a remote agent. Disabled by default; enabled per-agent via `allow_commands` + `deny_args_regex` |
| `mx_await_result` | `invocation.get` / `task.watch` | Resolve a deferred handle (running / awaiting-approval → terminal) |
| `mx_cancel` | `invocation.cancel` | Cancel an in-flight invocation (T108: a `sync` verb taking the deferred `handle`; emits a *signed cancel* and surfaces the receiver's verdict — it never enforces. No `idempotency_key` — cancelling is naturally idempotent. Cancels a single invocation, not a task/plan) |
| `mx_create_task` / `mx_update_task` / `mx_list_tasks` | `task.create/update/list/graph` | Author and read the shared, durable plan (DAG) |
| `mx_share_context` | `share.file` / `share.diff` / `share.env` | Publish a diff/file/env artifact to the workspace |
| `mx_get_context` | `share.list` / `share.get` | Fetch a shared artifact by id |

**Explicitly NOT model tools** (operator / out-of-band only): `trust.publish`/approve/revoke, `approval.decide`, `policy.*`, `auth.*`, `device.verify.*`, `cross_signing.*`, `recovery.*`, `daemon.*`. The model may *read* trust/approval state but never *decide* it. Approvals reach the model only as a **result status**, never as a grant it can issue to itself.

Each tool is described to the model with: a namespaced name (`mx_*`), a one-line description, an **input JSON Schema** (forwarded from `ToolSchema.input_schema` for `mx_delegate_tool`), and the normalized **result envelope** (§4).

---

## 3. How each runtime consumes the tools

The canonical registry is transport-neutral. **MCP is the universal binding for MCP-capable runtimes**; **native shims** are added where a runtime offers something *better* for async / human-in-the-loop than generic MCP, or where the runtime has no built-in MCP client (Pi). Per the locked decision, the MCP server and the Claude native shim are both built from day one.

**Google ADK (Python).**
- Default: mount the toolbelt as an `MCPToolset` on an `LlmAgent` (`tools=[MCPToolset(...)]`). *(Implemented in T201: the copy-pasteable recipe lives in [`examples/adk`](../examples/adk/README.md) — a `mx-loom-mcp --stdio` subprocess with a **deny-by-default child env** (`safe_mx_mcp_env`, mirroring `packages/toolbelt/src/cli/env.ts`), the session/`ToolContext` mapping of one ADK session ⇒ one workspace room ⇒ one `MxSession` (room + correlation id as non-secret `--room`/`--correlation-id` CLI flags, never model tool args), and the additional non-secret workspace metadata flags `--cwd`, `--project-id`, `--git-commit`, `--max-invocations` that ride `agent.register` — all session config, none model args. The pure `packages/mcp/src/cli-options.ts` module handles parsing and projection; a Python–TypeScript drift guard (`packages/mcp/test/cli-options.test.ts`) parses the Python deny-tuples and asserts byte-for-byte equality with the exported toolbelt constants (divergence fails CI). Generic `MCPToolset` surfaces `running`/`awaiting_approval` as ordinary envelopes resolved via `mx_await_result`; the live two-daemon ADK acceptance (`packages/golden/test/adk.mcp-toolset.e2e.test.ts`) stages behind `MXL_ADK_MCP_E2E=1` + `MXL_CONFORMANCE_TWO_DAEMON=1`.)*
- Better for approval-blocking delegation: wrap `mx_delegate_tool` / `mx_run_command` as a `LongRunningFunctionTool`. ADK's long-running tool protocol is a near-perfect match for mx-agent's `awaiting_approval` flow — the tool returns a pending ticket, the agent keeps reasoning, ADK resumes when the result arrives. `ToolContext` carries the session/handle. *(Implemented in T202: the shim lives in [`examples/adk/long_running_tools.py`](../examples/adk/long_running_tools.py) — `mx_long_running_tool_bundle(...)` starts one private `MCPToolset` (the T201 `safe_mx_mcp_env` recipe), drops the generic `mx_delegate_tool` / `mx_run_command`, and re-adds them as `LongRunningFunctionTool`s with the **canonical names preserved**. Initial dispatch is a non-blocking probe (`wait_ms=0`, so a human approval gate is never hidden); a `running`/`awaiting_approval` envelope becomes a secret-free **pending ticket** (`handle` + projected `approval` + `audit_ref`, keyed by ADK function-call id so many tickets can be held concurrently and other `mx_*` work proceeds). `resolve_ticket(...)` resumes by calling the canonical `mx_await_result(handle)` through the same MCP seam — observe-only, idempotent on completion, never re-dispatching the mutation and never carrying an approval/idempotency capability — and `build_resume_content(...)` injects the terminal T102 envelope as the ADK `FunctionResponse`. Approval stays out-of-band and is re-validated by the receiving daemon at release; the model is never given an approval-mutation tool. The ADK-free core (`MxLongRunningCore`) and the canonical wrapper signatures are exercisable without `google-adk`; the live two-daemon T202 acceptance now lives at `packages/golden/test/adk.long-running.e2e.test.ts` behind `MXL_ADK_LONG_RUNNING_E2E=1` + `MXL_CONFORMANCE_TWO_DAEMON=1` + `MXL_CONFORMANCE_GOLDEN_POLICY=1`.)*

**Claude Agent SDK (TypeScript — the mx-agency default runner).**
- In-process: define tools with `createSdkMcpServer` + `tool()` (Zod schemas); the toolbelt runs inside the agent process, no extra socket.
- Or external: register the toolbelt as an external MCP server in `options.mcpServers`.
- Approval surface: use the `canUseTool` callback to intercept `mx_*` calls — it can short-circuit to the daemon's approval state and present HITL without the model ever seeing credentials. Cleanest HITL hook of the four.

**OpenCode SDK.**
- Register the toolbelt as an MCP server (local stdio or remote) in `opencode.json` (`mcp` block). OpenCode surfaces MCP tools to its agents directly; no custom code beyond the server entry.
- **Landed by T203 ([`examples/opencode/`](../examples/opencode/README.md)):** OpenCode consumes the generated `@mx-loom/mcp` server directly — **no** `@mx-loom/opencode` package, no OpenCode-specific tool authoring. Both entry shapes are verified against `@opencode-ai/sdk`'s `McpLocalConfig`/`McpRemoteConfig` (local: `command` array + per-server `environment`; remote: `url`). The non-secret session mapping (`--room`/`--kind opencode`/`--correlation-id`) rides the `command` array / CLI, never model args. Secret-boundary nuance: OpenCode's `environment` field only *adds* (it does not reset), so the load-bearing control is launching OpenCode itself from a scrubbed env — the gated e2e (`packages/golden/test/opencode.mcp-entry.e2e.test.ts`) spawns `opencode serve` from an explicit allowlist, proves `mcp.status`/`tool.ids` surfacing deterministically, and drives the `mx_delegate_tool` call model-in-loop behind `MXL_OPENCODE_MODEL`.

**Pi SDK (`@earendil-works/pi-coding-agent`).**
- **Resolved by T204 ([decision record](pi-tool-surface-capability.md)): Pi has no built-in MCP client today, so the Pi binding uses Pi's *native tool-registration* API** (SDK `customTools` / `defineTool`, extension-time `pi.registerTool()`) — it cannot consume `@mx-loom/mcp` directly the way ADK (`MCPToolset`) or OpenCode (`mcp` entry) can. MCP for Pi remains only a possible *future, extension-mediated* path (Pi blesses "MCP server integration" as something an extension can add, but mx-loom would have to build that Pi-side MCP client first). So T205 generates Pi `ToolDefinition[]` from the canonical descriptors (Pi `parameters` are TypeBox, so `enum` fields emit `StringEnum` for Google-provider compatibility) and routes execution through the same registry handlers + toolbelt seam. Because mx-agency already wraps Pi behind `AgentRunner`, the Pi binding stays a thin map from the canonical registry to Pi's tool type.

**Custom runners.** Anything that can (a) call a Unix socket and (b) accept a JSON-Schema tool list gets the tools for free — point it at the MCP server, or link the toolbelt library directly.

> **Build rule:** never hand-author tools per runtime. One canonical descriptor set → generated MCP server + generated native shims (Claude `canUseTool`, ADK `LongRunningFunctionTool`, Pi `ToolDefinition[]`) as those bindings land. *(That canonical descriptor set is now a concrete, validated, enumerable module — `@mx-loom/registry` (T101). The discovery handlers `mxFindAgents` + `mxDescribeAgent` (T104) are live, and **both** delegation surfaces of decision 2 are live: the primary verb `mxDelegateTool` (T105) — discover a target, read its published `ToolSchema.input_schema`, validate args, dispatch `call.start`, receive a normalized envelope — and its guarded-exec sibling `mxRunCommand` (T106), which dispatches `exec.start` for an allowlisted command and surfaces the receiver's verdict (`policy_denied` when not allowlisted) cleanly. So M1's "delegate a named tool *and* a guarded command" surface is code-complete at the handler layer. The guard stays entirely receiver-side (§6 layer 4 / §9). The shared-context publish/fetch seam is also live: `mxShareContext` + `mxGetContext` (T107) map `share.file/diff/env` (publish) and `share.get` (fetch), surfacing — never reimplementing — the substrate's inline-vs-media (≤256 KiB) split and the authoritative sha256 over stored bytes (mx-loom downloads no Matrix media; §1 / §7). With T108, `mxCancel` (cancels an in-flight invocation by its deferred handle; `invocation.cancel` → `ok({ handle, cancelled, state? }, audit_ref)`, emitting a signed cancel and surfacing the receiver's verdict — never enforcing it) and `mxWorkspaceStatus` (the observe verb; `workspace.status` + `agent.list` → `ok({ workspace, agents: AgentSummary[], project? }, EMPTY_AUDIT_REF)` with the Matrix `members[].user_id` list deliberately projected out) are now live, completing the **9-verb M1 model-facing surface** at the handler layer. The first generator is now live too: **T109** landed `@mx-loom/mcp`, the **generated MCP server** — it enumerates the canonical descriptor set into a `tools/list` (each `input_schema`/`output_schema` passed through **verbatim**, no per-tool hand-authoring), routes `tools/call` through the existing handlers via the injected `MxClient`/`MxSession` seam, and serializes the T102 envelope onto an MCP `CallToolResult` (the `awaiting_approval` status surfaces as a non-error structured result carrying the `handle` + `approval`, resolved later via `mx_await_result`). It runs over stdio or Streamable HTTP, is secret-free by construction, and applies the T113 `withAudit` tap once at its single result-return chokepoint. **T110** then landed the second generator — the **Claude Agent SDK in-process shim** in `@mx-loom/claude`: the same nine descriptors registered with `createSdkMcpServer()` + `tool()` (Zod schemas from the T111 converter), reusing `@mx-loom/mcp`'s `dispatchCall` / `createBindingContext` / `serializeToolResult` verbatim (the SDK's in-process server is itself an MCP server, so each `tool()` handler returns the exact `CallToolResult` the serializer produces). It adds only the Claude-specific pieces: the **hidden `mx_await_result` poll loop** (a `running` delegation resolves to its terminal envelope in one tool call; `awaiting_approval` is surfaced for the model to resolve later, with an opt-in blocking mode), and the **`canUseTool` HITL hook** — a secret-free, requester-side local operator gate that can only refuse to dispatch (never grant authority; the receiving daemon re-validates against live policy at release). It is a library (no `bin`): it hands the host a `createSdkMcpServer` config + a `canUseTool` factory to compose into its own `query()`. So **both bindings of locked decision #1 are now live**; and **T114** (`@mx-loom/golden`) composes them into the **golden end-to-end gate** — one binding-agnostic S1–S8 scenario driven through both arms against the live two-daemon golden fixture, with an out-of-band operator approval (`decide-approval.sh`), asserting the envelope, the secret boundary, and the audit row at each step (skip-clean locally, fail-not-skip in CI; live green staged behind the golden fixture).)*

---

## 4. The minimum common tool contract

Seven requirements; every runtime binding must honor them.

1. **Namespaced descriptor.** `name` (`mx_*`), `description`, `input_schema` (JSON Schema), `output_schema` (JSON Schema for the success payload), and an `async_semantics` flag (`sync` | `deferred` — see point 3). For `mx_delegate_tool`, the inner tool's `input_schema` is passed through from the target agent's published `ToolSchema`. *(Implemented in T101 as the canonical `ToolDescriptor` in `@mx-loom/registry` — a transport-neutral, secret-free, deep-frozen descriptor set with a fail-fast loader/validator (`loadRegistry()`). It is enumerable so the bindings (T109/T110) and the JSON Schema → Zod converter (T111, **landed** in `@mx-loom/claude` — fail-closed, equivalence-proven against the registry's Ajv seam) read it directly; it is the closed no-authority allowlist of model-facing verbs. The result **envelope** below is T102, not part of the descriptor.)*

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

*(Implemented in T102 as `ToolResult` in `@mx-loom/registry` — the TypeScript types, a **draft-07 envelope JSON Schema** (validated with the same Ajv seam T101 ships), and constructor helpers (`ok`/`running`/`awaitingApproval`/`denied`/`errored`) that are the only sanctioned way to build an envelope, so a handler conforms by construction. The **status↔`error.code` partition** the JSONC above does not spell out is fixed: status `denied` carries a **denial-set** code (`policy_denied`, `untrusted_key`, `approval_denied`, `approval_expired`); status `error` carries a **fault-set** code (`timeout`, `not_found`, `invalid_args`, `target_offline`, `internal`); the two sets partition the closed nine-code taxonomy with no overlap. `audit_ref` is structurally always present, with `null` inner ids when the daemon does not yet return them (never fabricated). T102 is contract-only — the per-tool **construction** of envelopes is the handlers' job (T104–T108), and the deferred-result **resolution** of a `running`/`awaiting_approval` handle is T103.)*

3. **Deferred-result protocol.** Remote calls and approvals are async. Long-running ops return `status: running|awaiting_approval` + a `handle`; the model (or the binding) resolves via `mx_await_result(handle, wait_ms)`. Runtimes with native long-running tools (ADK, Claude) hide the poll loop; others poll. This is the one piece of semantics a runtime cannot skip. *(Implemented in T103 as `mxAwaitResult({ handle, wait_ms }, deps)` in `@mx-loom/registry` — the **first handler**. It polls the daemon `invocation.get` RPC through an **injected** daemon-call seam (`HandlerDeps`; the toolbelt `MxTransport` is imported `type`-only, so the registry keeps its zero runtime toolbelt dep) and maps each response onto the T102 envelope via the pure `invocationToResult` normalizer (built only through the constructor helpers; never throws). `wait_ms` is a **client-side poll-with-timeout**: omitted/`0` ⇒ a single non-blocking probe; `> 0` ⇒ block up to a logical deadline realised as many short reads (bounded poll interval), returning early on the first terminal state. **A `wait_ms` expiry returns the still-pending envelope (`error: null`), never `errored('timeout')`** — the `timeout` code is reserved for a genuine transport/daemon fault. The resolver only **observes**: `awaiting_approval` → `ok`/`denied` resolves because the operator decided out-of-process and the daemon re-ran the authorize pipeline at release (§5); it issues no decision and exposes no approve/deny/mutate surface. `task.watch` (push-based) replaces the poll backend in T302/M3 without changing this tool contract; the invocation state vocabulary, the `invocation.get` method/param name, the held-invocation `approval` fields, and `audit_ref` availability are pinned at the two-daemon round-trip.)*

4. **Idempotency.** Every mutating call carries a client-supplied `idempotency_key` (the daemon already uses `idempotency_key`/`nonce` for replay protection). Retried tool calls must not double-execute. *(Plumbed in T102 as the descriptor field + handler contract: the **mutating** verbs `mx_delegate_tool` / `mx_run_command` declare an optional `idempotency_key` in their `input_schema` (read verbs do not); `newIdempotencyKey()` generates one (`idk_<uuid>`) when the caller omits it; the mutating handlers (T105/T106) attach it to the outbound `call.start`/`exec.start` params and reuse the **same** key on every transport-level retry — `MxClient.withRetry` reuses params verbatim, so no transport change is needed and the daemon's replay protection dedupes. The key is a dedup nonce, not a capability; idempotency never bypasses authorize. The exact wire param name is confirmed at the two-daemon round-trip.)*

5. **Stable error taxonomy.** The closed `error.code` set above — so a runtime can react programmatically (e.g., `untrusted_key` → surface an onboarding hint; `awaiting_approval` → keep planning). *(Implemented in T102 as the single-source `ERROR_CODES` const → the `ErrorCode` type → the envelope schema's `enum`, with `mapTransportError`/`mapDaemonError` translating every transport/daemon fault onto the closed set in one place.)*

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

*(This full hold → out-of-band decide → re-authorize-at-release cycle is now exercised **end-to-end** by the golden gate (T114 `@mx-loom/golden`): a held `awaiting_approval` surfaces to the scripted cognition; a genuinely out-of-band operator (`scripts/conformance/decide-approval.sh`, the `mx-agent` CLI on daemon B — never a model-facing surface) approves on one leg and denies on another; `mx_await_result` then observes the daemon's post-decision terminal (`ok` / `denied('approval_denied')`). The model is never given a trust/policy/approval mutation tool — it only ever produces a signed request and reads the `awaiting_approval` status.)*

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

- **Context.** *Private agent memory* (scratchpad, conversation, retrieved knowledge) stays in the runtime — MX-Agent doesn't touch it. *Shared/cross-agent context* (diffs, files, env snapshots) moves through `mx_share_context` / `mx_get_context` as `com.mxagent.context.share.v1` (inline ≤256 KiB, else Matrix media + sha256). Rule: if another agent needs to see it, it's an MX share; if only this agent's reasoning needs it, it's runtime memory. *(Implemented in T107: two `sync` handlers in `@mx-loom/registry` — `mx_share_context` maps `kind` ∈ `{file, diff, env}` to `share.file/diff/env` and returns `ok({ context_id, sha256 }, audit_ref)`; `mx_get_context` maps `context_id` to `share.get` and surfaces `{ context_id, kind?, sha256?, size_bytes?, inline? | media_mxc? }`. The inline-vs-media split, the content-addressing, and the authoritative sha256 over stored bytes are **substrate** behavior the handlers surface, never reimplement — mx-loom holds no Matrix credentials and downloads no media (Boundary A): the daemon fetches/verifies media and the handler trusts + passes through the digest and the `inline` vs `media_mxc` path discriminator. Runtime-private memory is never touched. Credential-shaped `content`/`path` is rejected as `invalid_args` before publish by the toolbelt chokepoint. The live `share.*` shapes are pinned by the staged two-daemon conformance fixture.)*

- **Task state.** The DAG (`com.mxagent.task.v1`) is the durable, shared plan — `proposed→pending→assigned→executing→succeeded/failed`, with `depends_on`/`blocks` and signed `action`. The runtime owns how to think about the plan; MX owns the plan of record. This is also the crash-recovery boundary: a runtime can die and a new one resumes from task state.

- **Sessions.** Define `MxSession = { agent_id, room/workspace, daemon socket, correlation_id }`. A runtime conversation maps 1:1 to an MX agent registration. The toolbelt holds the session handle and threads `correlation_id` onto every call so a cognitive session is reconstructable across delegations. Registration (`agent.register`) happens once at session start; heartbeats keep liveness. *(Implemented in T005: `openSession()` in `packages/toolbelt` is the session entry point — registration is toolbelt-run lifecycle, not a model tool, and `correlation_id` is stamped on every outbound call. Stamping into the signed Matrix events — so it survives across delegations — is gated on daemon support and off by default until verified. The `audit_ref` the id lands in is the M1 envelope delivered by T102.)*

- **Audit.** The signed Matrix event stream is the audit log — immutable, room-scoped, Ed25519-signed, replay-protected. Every tool result carries `audit_ref`, so the app layer can correlate "model decided X" ↔ "daemon executed Y" ↔ "operator approved Z." Mirror these into mx-agency's existing audit store (ADR-07/ADR-10, Postgres + RLS) for queryable, tenant-scoped history. Two-tier audit: substrate = tamper-evident truth, app store = queryable index. *(Implemented in T113: a new opt-in leaf package `@mx-loom/audit` is the **queryable index** half. A pure, total projection `auditRowFrom(result, ctx)` maps each T102 `ToolResult` + a binding-supplied context onto a non-secret `AuditRow` — the four `audit_ref` ids (daemon invocation) + `tool_name`/`correlation_id`/`idempotency_key` (model action) + `approval_request_id` (approval), all joinable on one row (AC 2). An injected `AuditSink` port has three adapters — `PostgresAuditSink` (`INSERT … ON CONFLICT (dedup_key) DO NOTHING` over `migrations/0001_mx_audit_log.sql`), `InMemoryAuditSink` (the golden-test fixture), `NullAuditSink` (audit disabled). Exactly-once (AC 1) is a deterministic `dedup_key` per `(call_id, status, invocation_id)`: a `running`→`ok` lifecycle is two correlated rows, a re-emission is a no-op. A best-effort `withAudit` tap a binding applies once at its single result-return chokepoint passes the envelope through untouched and swallows sink failures (logged secret-free) — a Postgres outage never blocks a tool call or weakens the substrate truth. The mirror stores a strict non-secret subset (no `result`, no `error.message`, no `approval.summary`); `pg` is quarantined in `@mx-loom/audit` (registry/toolbelt gain no dependency). **Staged:** the single-chokepoint wiring lands with the bindings (T109/T110); the live-Postgres path is gated behind `MXL_AUDIT_PG=1`; the end-to-end "rows present for each step" assertion is T114. Single-tenant — RLS keyed on `room` is M5/T502.)*

---

## 8. MVP scope

One runtime family, one workspace, the delegation core — and finally close issue #37.

- **mx-loom v0 (TypeScript)** — implements ADR-11's transport: daemon IPC primary, `--json` CLI fallback, behind the `app/src/sdk` seam. `createClient()` (→ `MxClient`) is the base transport entry point; it selects transport and fails over IPC→CLI **only on `not_running`** (the one provably pre-dispatch fault), so no possibly-applied mutating call is ever re-issued. `openSession()` (→ `MxSession`) layers the session model on top: one `agent.register` at start, a cancellable liveness heartbeat, and a session-stable `correlation_id` stamped on every outbound call. Pin mx-agent `v0.2.1` + a conformance check before any version bump.
- **Canonical registry** with the **9 M1 verbs**: `mx_find_agents`, `mx_describe_agent`, `mx_delegate_tool`, `mx_run_command` (guarded, off by default), `mx_await_result`, `mx_share_context`, `mx_get_context`, `mx_cancel`, `mx_workspace_status`. (Full task DAG tools follow in Phase 3; `mx_workspace_status` surfaces agents + project in M1 and leaves the `tasks` dimension to Phase 3.)
- **Both bindings from day one:** a generated MCP server *and* a Claude Agent SDK in-process binding (`createSdkMcpServer` + `tool()`), with `canUseTool` wired to the approval status. *(**Both landed.** MCP half — T109 `@mx-loom/mcp`: descriptors → `tools/list` (verbatim JSON Schema) and the T102 envelope → `CallToolResult` over stdio + Streamable HTTP, secret-free. Claude half — T110 `@mx-loom/claude`: the nine verbs registered in-process via `createSdkMcpServer()` + `tool()` (Zod schemas from the T111 converter), reusing T109's `dispatchCall` / `createBindingContext` / `serializeToolResult`; the `mx_await_result` poll loop hidden so a delegated call looks synchronous; and the `canUseTool` HITL hook presenting a secret-free approval prompt as a requester-side local gate. With both generators live, the golden end-to-end (T114) is **landed** on both arms.)*
- **The full result envelope (§4)** including the `awaiting_approval` deferred path and `mx_await_result`.
- **Single workspace, single tenant.** Operator-provisioned trust + a minimal `policy.toml` (allow a couple of named tools, one allowlisted command for `mx_run_command`, deny network).
- **Read-only audit refs** surfaced on every result + a thin mirror into the existing Postgres audit table. *(The thin mirror landed in T113 as `@mx-loom/audit`: schema/migration + the pure projection + the idempotent `AuditSink` + the best-effort `withAudit` tap. Mechanism complete and unit-proven; the binding chokepoint wiring (T109/T110) and the live-Postgres path (`MXL_AUDIT_PG=1`) are staged, end-to-end asserted by T114.)*
- **Golden end-to-end test:** a Claude-SDK agent calls `mx_delegate_tool("run_tests")` on a *second* registered agent across a room, hits an approval gate, operator approves, result returns. The same scenario runs through the MCP server binding too. One test, every boundary. *(**Landed — T114 `@mx-loom/golden`.** A binding-agnostic S1–S8 scenario — discovery → ungated delegation → approval-gated **approve and deny** → guarded `mx_run_command` (held → approved → `exit_code`) → `deny_args_regex` denial → deny-by-default denial — driven through **both** the MCP server and the Claude shim by a deterministic scripted cognition, with a genuinely **out-of-band operator** (`scripts/conformance/decide-approval.sh` issuing `approval.decide` on daemon B via the `mx-agent` CLI, never a `@mx-loom/*` surface — see §5). Each step asserts the T102 envelope, the secret boundary, and the audit row; the approval reaches the model **only** as `awaiting_approval` and is re-validated against live policy at release. Skip-clean locally, fail-not-skip in CI; the scripted arm is the gate, an opt-in real-model `query()` arm (`MXL_GOLDEN_LIVE_MODEL=1`) is never. The live green is staged behind the golden two-daemon fixture (`MXL_CONFORMANCE_TWO_DAEMON=1` + `MXL_CONFORMANCE_GOLDEN_POLICY=1`), like every M1 conformance arm.)*

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
| **1 — Delegation MVP** | One runtime family, both bindings | Canonical registry (9 tools incl. guarded `mx_run_command`, plus `mx_cancel` + `mx_workspace_status`) + result envelope + async handle; **MCP server + Claude native shim**; approval-gated golden test | Claude agent delegates a named tool *and* a guarded command to a remote agent through an approval gate, via both bindings; audit refs land in Postgres |
| **2 — Universal binding** | ADK / OpenCode / Pi | ADK `MCPToolset` + `LongRunningFunctionTool` shim; OpenCode `mcp` entry; Pi binding via **native tool registration** (T204 decision — Pi has no built-in MCP client) — all from the same descriptor set | Same golden test passes under ADK, OpenCode, Pi |
| **3 — Coordination depth** | Plans + context as tools | Task DAG tools (`mx_create/update/list_tasks`), `task.watch` resumption (`mx_cancel` shipped in Phase 1 via T108) | A multi-agent plan executes across ≥2 agents with durable task state surviving a runtime restart |
| **4 — Governance UX** | Operator-grade trust/policy/approval | Trust-onboarding flow, policy authoring UI, approval dashboard wired to `approval.request/decision`; risk surfacing | New runtime agent onboarded and policy-scoped without code changes; approvals fully audited |
| **5 — Multi-tenant + observability** | Agency-scale | Tenant=room scoping (ADR-03), two-tier audit/index, metrics/traces (ADR-08), cost guardrails (ADR-12) | N tenants isolated (RLS), per-tenant audit queryable, per-call cost attributed |
| **6 — Production hardening** | Certify the fabric | Per-runtime conformance certification, MCP server published, chaos/fault tests on approval+revocation, E2EE-on-by-default workspaces, SLA monitoring | "MX-Agent inside" badge: any conformant runtime joins the mesh safely with no bespoke code |

---

## The shape of the win

When this lands, MX-Agent stops being an agent and becomes the **fabric**. A Claude-SDK planner, an ADK specialist, a Pi coder, and a custom runner each keep their own brain — but they discover each other, delegate signed work, share context, gate risk through human approval, and leave a tamper-evident trail, all through one portable toolbelt. Cognition is pluggable; coordination is the constant. That is the decentralized execution fabric for agent teams.
