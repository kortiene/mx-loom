---
description: Assess mx-loom feature completeness against the design doc, the backlog milestones, code, and GitHub issues
argument-hint: "[focus area or milestone target]"
---
Think hard and perform a thorough repository assessment of `mx-loom`.

Optional focus area or milestone target from me: $ARGUMENTS

Read all files needed to accurately evaluate how close the project is to being fully feature-complete relative to its design doc (architecture, boundaries, tool contract), its backlog milestones (M0–M6), and the GitHub issue state (#1–#49 / T001–T605). mx-loom is a portable "tool-fabric" adaptation layer: external runtimes own COGNITION (model loop, planning, memory); mx-agent owns COORDINATION (discovery, secure remote invocation, task DAG, approvals, trust, audit, Matrix transport). The repo is docs-only today — do not assume any package, build target, or test command exists yet unless it is actually on disk.

Start by reviewing at minimum:

- `docs/mx-agent-tool-fabric-design.md` (the architectural boundary, the ~12 model-facing tools, the result envelope/tool contract, invocation flow, security/trust/approval/policy model, MVP scope, roadmap)
- `docs/backlog.md` (milestones M0–M6, issues #1–#49 / T001–T605, label taxonomy, critical-path dependency map, implementation order)
- the specific GitHub issue(s) relevant to your focus area
- the source tree as it actually exists on disk — the design plans a TypeScript toolbelt (canonical registry, result envelope, async handles, per-runtime bindings, session map) behind the `app/src/sdk` seam, but verify which of these exist and contain real code vs. are still empty:
  - framed JSON-RPC 2.0 IPC client over the daemon Unix socket (+ `--json` CLI fallback)
  - canonical tool registry + normalized result envelope + deferred-result protocol
  - per-runtime bindings (the generated MCP server + the Claude Agent SDK native shim)
  - session model + agent registration
  - policy fixtures, audit mirror, and the golden end-to-end test

Also inspect GitHub issue state (issues #1–#49 / T001–T605) as needed, including recently completed work and remaining open issues. The orchestrator owns all git/gh; do NOT run git or gh yourself — work from the issue text already provided to you and from what is on disk.

Evaluate feature completeness across these areas (mapped to the design doc and backlog milestones M0–M6):

1. SDK seam closed (#37): a TS toolbelt that talks to the daemon (T004)
2. Framed JSON-RPC 2.0 IPC client over the Unix socket (T002)
3. `--json` CLI fallback transport (T003)
4. Session model + agent registration, `correlation_id` threading (T005)
5. mx-agent version pin + conformance suite gating the pin (T006/T007)
6. Secret-boundary guard — no secret crosses Boundary A (T008)
7. Canonical tool descriptor model (T101)
8. Normalized result envelope + closed error taxonomy + idempotency (T102)
9. Deferred-result protocol `mx_await_result` (T103)
10. Discovery: `mx_find_agents` + `mx_describe_agent` (T104)
11. Primary delegation verb `mx_delegate_tool` (T105)
12. Guarded exec `mx_run_command` — off by default behind `allow_commands` + `deny_args_regex` (T106)
13. Cross-agent context: `mx_share_context` + `mx_get_context` (T107)
14. `mx_cancel` + `mx_workspace_status` (T108)
15. MCP server generated from the canonical registry (T109)
16. Claude Agent SDK in-process shim with `canUseTool` wired to approval state (T110)
17. JSON Schema → Zod converter (T111)
18. Minimal v1 `policy.toml` fixture (deny-by-default, `network = "deny"`, `requires_approval` on the high-risk path) (T112)
19. Postgres audit mirror of `audit_ref` (T113)
20. GOLDEN end-to-end test (approval-gated, both bindings) (T114)
21. ADK `MCPToolset` + `LongRunningFunctionTool` approval shim (T201/T202)
22. OpenCode MCP server entry (T203)
23. Pi tool-surface capability + binding (T204/T205)
24. Portability matrix across ADK/OpenCode/Pi (T206)
25. Task DAG tools `mx_create/update/list_tasks` (T301)
26. `task.watch` resumption / durable crash-recovery (T302)
27. Signed task-action dispatch alignment (T303)
28. Multi-agent plan with restart (T304)
29. Trust-onboarding flow, policy authoring, approval dashboard + risk surfacing (T401–T404)
30. Governance end-to-end (onboard + policy-scope with no code changes) (T405)
31. Multi-tenant (tenant=room) scoping, two-tier audit/index, observability, cost guardrails (T501–T504)
32. Multi-tenant isolation test (T505)
33. Per-runtime conformance certification, MCP-server publication, chaos/fault on approval+revocation, E2EE-by-default, SLA monitoring (T601–T605)

For each area, report:

- status: complete / partial / missing
- evidence from files or the issue text
- gaps or risks
- security implications (weigh every gap against mx-loom's security model — the secret boundary, deny-by-default policy enforced out-of-process on the receiving daemon, Ed25519 trust, and human approval gates)
- recommended next work
- whether the design doc/backlog accurately reflect what is actually implemented

Important constraints:

- Do not assume behavior exists just because the design doc or backlog describes it. The repo is docs-only today: most of #1–#49 are likely unstarted.
- Distinguish implemented behavior from placeholders, stubs, and docs-only intent.
- Preserve and treat as non-negotiable mx-loom's security model when judging completeness:
  - The adaptation layer is deliberately secret-free: Matrix tokens, Ed25519 signing keys, provider keys, and `GH_TOKEN` never reach the runtime process, the model context, or runner children — the toolbelt is the chokepoint enforcing "no secret crosses Boundary A," under a deny-by-default env allowlist.
  - Enforcement is out-of-process on the receiving mx-agent daemon: Ed25519 trust store, deny-by-default `policy.toml`, sandbox, and human approval gates. Cognition can only ever produce a signed request; it can never grant itself authority.
  - The model is never given trust/policy/approval mutation tools; approval reaches the model only as an `awaiting_approval` result status, re-validated against live policy at release.
  - Never weaken the contract: no field ever carries credentials inbound or outbound; never log secrets or tokens.
- Respect the milestone dependency chain: M0 → M1 → M2 → M3 → M4 → M5 → M6. A later milestone cannot be "complete" if its blockers (e.g. T004, T102, T109/T110) are not.
- Do not make code changes unless explicitly asked.

End with:

- overall feature-completeness estimate (per milestone M0–M6, then overall)
- top blockers to feature complete (anchor to the critical path: T001 → T002 → T004 → T005 → T101 → T102 → T103 → T105/T106 → T109/T110 → T114 → M2…M6 exits)
- recommended GitHub issues to file or update (describe them; the orchestrator will create them)
- recommended validation commands:
  - run the configured project test gate (`MX_AGENT_TEST_CMD`) plus any project lint/format/build checks
  - if no test/lint/build tooling exists yet (the repo is docs-only), say so explicitly and recommend that the test/lint/build/CI commands be wired once the first package lands — the stack is TypeScript (pnpm, Node ≥20.19, vitest, Apache-2.0); do not invent commands the repo does not yet define
