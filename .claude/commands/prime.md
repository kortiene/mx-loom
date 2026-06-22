---
description: Prime the agent with mx-loom repository architecture and contribution rules
argument-hint: "[task/context]"
---
Prime yourself for working on the `mx-loom` tool-fabric before taking action.

Optional task/context from me: $ARGUMENTS

First, read and internalize the repository context:
- `docs/mx-agent-tool-fabric-design.md` (architecture: the cognition/coordination boundary, the ~12 model-facing tools, the result envelope/tool contract, invocation flow, the security/trust/approval/policy model, MVP scope, roadmap)
- `docs/backlog.md` (milestones M0–M6, epics, GitHub issues #1–#49 / T001–T605, label taxonomy, critical-path dependency map, recommended implementation order)
- the specific GitHub issue being worked (kortiene/mx-loom) and its acceptance criteria
- the existing toolbelt source tree for the requested task — note: the repo is DOCS-ONLY today, so no toolbelt code exists yet. If a source tree has since landed, read the relevant packages and files for the task.

Project summary:
`mx-loom` is a portable "tool-fabric" adaptation layer. External agent runtimes (Google ADK, Claude Agent SDK, OpenCode, Pi, custom) own COGNITION — the model loop, planning, private memory, and tool-selection. mx-agent owns COORDINATION — discovery, secure remote invocation, the task DAG, approvals, trust, audit, and Matrix transport. mx-loom is the thin, transport-neutral toolbelt in between: it renders mx-agent's daemon RPC as ordinary "tools" in each runtime's native tool-calling ABI, while keeping all secrets, signing, and enforcement out-of-process in the daemon.

Architectural boundary (the design doc's four planes, two hard boundaries):
- COGNITION PLANE — the external runtime (model loop, planning, private memory, prompt, tool-select).
- Boundary A — the runtime's tool-call ABI (function-calling / MCP); plain JSON in/out.
- ADAPTATION PLANE — mx-loom (the only new code): canonical tool registry, result envelope, async handles, per-runtime bindings (the generated MCP server + native shims), session map. NO secrets, NO model, NO enforcement — it only translates.
- Boundary B — the daemon Unix-socket JSON-RPC 2.0 (4-byte len prefix + JSON; UID-gated; mode 0600).
- COORDINATION PLANE — the mx-agent daemon (per host): Ed25519 signing, trust store, `policy.toml`, sandbox, /sync, task scheduler, approval gate; owns ALL Matrix credentials.
- SUBSTRATE — Matrix homeserver(s) + remote daemons (the mesh).

Governing rule: cognition can only ever produce a signed request; it can never grant itself authority. Trust, policy, sandboxing, and approval execute out-of-process and on the receiving daemon. A compromised or hallucinating model cannot escalate, because the thing that says "yes" is not in the runtime.

The ~12 model-facing tools (discover → delegate → coordinate → share → observe): `mx_find_agents`, `mx_describe_agent`, `mx_workspace_status`, `mx_delegate_tool` (primary delegation verb), `mx_run_command` (guarded exec, disabled by default), `mx_await_result`, `mx_cancel`, `mx_create_task`/`mx_update_task`/`mx_list_tasks`, `mx_share_context`, `mx_get_context`. Operator/crypto/lifecycle RPCs (`trust.*`, `approval.decide`, `policy.*`, `auth.*`, `device.*`, `daemon.*`) are NEVER model tools.

Architecture and security constraints:
- Secret boundary: Matrix tokens, Ed25519 signing keys, provider keys, and `GH_TOKEN` never cross Boundary A into the runtime process, the model context, or runner children. The toolbelt is the chokepoint enforcing a deny-by-default env allowlist; runner children receive retrieved TEXT only, never credentials.
- Never weaken the contract; never log or persist secrets or tokens. No tool field carries credentials inbound or outbound; reject credential-shaped args.
- Out-of-process enforcement on the receiving daemon: identity is Ed25519 (daemon-held signing key, never readable by the runtime); the trust store is final authority and operator-only; `policy.toml` is deny-by-default and enforced on the receiver; guarded exec (`mx_run_command`) ships disabled and only enables behind `allow_commands` + `deny_args_regex` + a tight sandbox; approval is human-in-the-loop and re-validated at release.
- The model is never given trust/policy/approval mutation tools; approval reaches the model only as an `awaiting_approval` result status. No model-driven approvals, ever.
- Durable vs ephemeral state: runtime-private memory stays in the runtime and mx-loom never touches it; shared context (`mx_share_context`/`mx_get_context`) and the task DAG (`com.mxagent.task.v1`) are durable coordination state on the substrate; every tool result carries `audit_ref` correlating model action ↔ daemon invocation ↔ operator approval.

Current status to preserve:
This repo is docs-only today: only the design doc and backlog exist, and no toolbelt package has been built yet. The stack is TypeScript (pnpm, Node ≥20.19, vitest, Apache-2.0); adw_sdlc itself is TypeScript. Do not imply that any tool, binding, transport, or feature exists yet — none has been implemented. Work against the design doc, the backlog, and the specific issue being worked.

Working rules:
- Identify the owning component (transport/IPC client, canonical registry, result envelope, a per-runtime binding such as the MCP server or the Claude native shim, the daemon RPC seam) and any existing patterns before editing.
- Keep changes focused, idiomatic, and testable.
- Respect the dependency order in `docs/backlog.md` — the SDK seam + transport (T002→T004) and the canonical registry + result envelope (T101→T102) gate most downstream work; the approval-gated golden delegation test (T114) is the core demonstrable value.
- Preserve the secret boundary and the out-of-process enforcement model in every change.
- Avoid broad rewrites unless explicitly requested.
- Update the relevant docs (the design doc, backlog, schema/contract notes) when behavior changes.
- The orchestrator owns ALL git/gh operations; do not run git or gh yourself.

Before finalizing code changes, run or clearly recommend:
- The project's configured test gate (the command surfaced via `MX_AGENT_TEST_CMD`) plus any format/lint/build checks the project defines.
- Note: the repo is docs-only today, so test gates are empty until the first package exists. The stack is TypeScript (pnpm, Node ≥20.19, vitest, Apache-2.0). If no test command is configured yet, say so explicitly and recommend the exact command(s) to run once the package lands — do NOT invent commands the repo does not yet define.

After reading the relevant files, summarize the repository context in a few bullets, identify the likely component(s) involved in the task/context above, and propose a short plan before making code changes.
