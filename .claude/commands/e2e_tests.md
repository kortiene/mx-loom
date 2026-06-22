---
description: Add or improve end-to-end tests for mx-loom delegation/coordination flows
argument-hint: "[spec-file|pr-url-or-number|notes]"
---
Add or improve end-to-end test coverage for this target:

$ARGUMENTS

This command is for heavier end-to-end scenarios, especially behavior crossing the runtime binding, the canonical tool registry, the daemon JSON-RPC transport, remote delegation, the approval gate, and the async/deferred-result boundaries. Prefer `/tests` for unit tests and deterministic non-e2e integration tests.

Workflow:

1. Understand the e2e target
   - If the argument is a spec file path, read it completely and identify the end-to-end behavior that needs coverage.
   - If the argument is a PR URL or number, inspect PR metadata, changed files, commits, checks, and diff via the orchestrator-provided context. Do not run git or gh yourself; the orchestrator owns all git/gh.
   - If the argument is notes/free text, treat it as e2e testing goals for the current working tree.
   - If no argument is provided, inspect the current working tree and ask for clarification only if the target is genuinely unclear.

2. Read repository and test infrastructure context before editing
   - `docs/mx-agent-tool-fabric-design.md` for the architecture, the tool contract, and the security/trust/approval model.
   - `docs/backlog.md` for the epics, milestone ordering, and the specific GitHub issue (kortiene/mx-loom #1–#49 / T001–T605) being worked.
   - The specific GitHub issue under test, if one is named.
   - The existing toolbelt source tree, existing tests, and any e2e harness — once they exist. The repo is docs-only today: there is no toolbelt source or e2e harness yet, so say so explicitly and base scenarios on the design doc and the issue.
   - The pinned mx-agent version (`.mx-agent-version`, v0.2.1) and the conformance suite (T007) once they exist, since the e2e harness runs against a live daemon at that pin.

3. Decide whether e2e coverage is warranted
   - Summarize the behavior under test.
   - Identify what lower-level tests already cover.
   - Add e2e tests only when unit or non-e2e integration tests are insufficient.
   - Prefer a small number of high-value scenarios over broad, slow, flaky coverage.
   - Clearly separate live-daemon / multi-process / multi-agent tests from default tests if the project convention requires gating.
   - High-value mx-loom end-to-end surfaces include:
     - The golden delegation loop: a Claude-SDK agent calls `mx_delegate_tool` (e.g. `run_tests`) on a second registered agent across a room, hits an approval gate, an operator approves, and the result returns — run through both the MCP server binding and the Claude native shim from the same canonical descriptor set.
     - Guarded exec: `mx_run_command` is denied by default (`policy_denied`); with an `allow_commands` entry an allowlisted command runs and returns the envelope, and a `deny_args_regex` match is blocked.
     - Deferred-result / approval path: an `awaiting_approval` envelope resolves to `ok` or `denied` after an operator decision via `mx_await_result(handle, wait_ms)`; the model can fan out other work while a delegation is pending.
     - Cross-agent context: `mx_share_context` publishes a diff/file/env artifact and `mx_get_context` fetches it back byte-identical (inline ≤256 KiB vs Matrix-media + sha256 path).
     - Durable task state: a multi-agent plan executes across ≥2 agents and survives a runtime restart, resuming from durable task state (`task.watch`).

4. Add or improve e2e tests
   - Use existing project infrastructure and patterns.
   - Drive the real end-to-end flow (runtime binding → mx-loom → daemon JSON-RPC → remote agent) rather than mocking past the boundary under test.
   - Do not require real production services, real Matrix credentials, or live provider keys; use local/test daemons, fixture policies, and synthetic fixtures.
   - Avoid making the default test gate depend on a live daemon, external networks, or remote runtimes unless that is already the project convention.
   - Prefer gated/tagged tests, or clearly documented external prerequisites, for tests that need a live daemon, a second registered agent, or a Postgres audit instance.
   - Keep tests reproducible, deterministic where possible, and safe to run repeatedly.
   - Avoid arbitrary sleeps; prefer readiness checks, bounded retries, or existing synchronization helpers. For approval-gate and `wait_ms` timeouts, drive a controllable clock or the deferred-result protocol rather than wall-clock sleeps.
   - Ensure test logs and fixtures never expose Matrix tokens, signing keys, provider keys, or `GH_TOKEN`.

5. Preserve mx-loom constraints
   - Secret-free contract: no tool field ever carries Matrix tokens, Ed25519 signing keys, provider keys, or `GH_TOKEN`, inbound or outbound; the toolbelt rejects credential-shaped args. E2E assertions must confirm no secret crosses Boundary A into the runtime/model.
   - Never log or persist secrets or tokens — including in test output and fixtures.
   - Out-of-process enforcement: trust (Ed25519 store), deny-by-default `policy.toml`, sandbox, and approval all execute on the receiving daemon; cognition only produces a signed request and never grants itself authority. E2E tests must exercise the approval gate and policy denial, not bypass them.
   - Approval is human-in-the-loop and re-validated at release: a stale/revoked approval must not smuggle through. Tests must drive the real approve/deny decision and assert the denial path too.
   - Durable vs ephemeral state: shared context and the task DAG are durable coordination state on the substrate; runtime-private memory is never touched by mx-loom.
   - E2E tests must not create trust/policy/approval bypasses just to pass.
   - Do not imply unimplemented behavior exists unless it is actually implemented.

6. Document how to run the e2e tests
   - Update nearby docs, test comments, or scripts when needed.
   - Clearly list external requirements such as a live mx-agent daemon at the pinned version, a second registered agent, a policy fixture, or a Postgres audit instance.
   - Include exact commands for setup, execution, and cleanup.

7. Verify before finishing
   - Run the narrowest relevant e2e test first when practical.
   - Run the project's configured test gate (the command surfaced via `MX_AGENT_TEST_CMD`) plus any format, lint, and build checks the project defines.
   - The repo is docs-only today, so test gates are empty until the first package exists. The stack is TypeScript (pnpm, Node ≥20.19, vitest, Apache-2.0). If no test command is configured yet, say so explicitly and recommend the exact commands to run once the toolbelt package lands — do not invent commands the repo does not yet define.
   - If a check cannot be run, explain why and recommend the exact command.

8. Final report
   - E2E target and scenario covered
   - Test infrastructure used
   - Files changed
   - Tests added or updated
   - Commands run and results
   - External requirements, if any
   - Bugs discovered, if any
   - Remaining gaps, flakes, risks, or follow-up recommendations

Important: focus on end-to-end coverage. Do not broaden product behavior beyond what is necessary to make the e2e scenario testable and safe.
