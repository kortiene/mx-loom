---
description: Implement a GitHub issue end-to-end using plan/implement/tests/e2e/review phases
argument-hint: "<issue-number> [notes]"
---
Implement GitHub issue #$1 for this repository, end to end.

Extra context/notes from me (everything after the issue number; may be empty). Full invocation for reference: $ARGUMENTS

`/issue` is the full delivery pipeline. It should reuse the project command templates below as phase contracts, but it must not stop after any individual phase unless there is a real blocker:

- `.claude/commands/plan.md` for spec creation when warranted
- `.claude/commands/implement.md` for disciplined implementation
- `.claude/commands/tests.md` for focused non-e2e test coverage
- `.claude/commands/e2e_tests.md` for conditional end-to-end coverage
- `.claude/commands/review.md` for local self-review before shipping

Read those prompt files before starting the work. Apply their workflows inline as phases of this `/issue` run; do not merely tell the user to run them separately.

The orchestrator owns ALL git and `gh` operations (branch, commit, push, PR, CI watch, merge). Do not run `git` or `gh` yourself. Your job is to implement, test, and self-review the change in the working tree, then hand off a clean, verified result and a clear report for the orchestrator to ship.

Follow this exact workflow and do not stop until the issue is implemented, verified, and self-reviewed, or you hit a genuine blocker.

1. Validate input and read the issue
   - If `$1` is missing, stop and ask for an issue number.
   - Read GitHub issue #$1 (title, labels, milestone, scope, and acceptance criteria) from the issue context provided to you. Treat the acceptance criteria as the definition of done.
   - If the issue is CLOSED, stop and tell me.
   - If the issue has unmet dependencies (a "Depends on" / "blocked-by" line referencing another open issue, or a milestone that must land first per `docs/backlog.md`'s critical path M0 → M1 → M2 → M3 → M4 → M5 → M6), warn me and ask whether to continue.
   - Stop for real blockers such as acceptance criteria that conflict with the mx-loom security constraints below, require real secrets/credentials, or require broad architecture decisions with insufficient detail.

2. Read repository context
   - Read and internalize:
     - `docs/mx-agent-tool-fabric-design.md` (architecture, tool contract, and security model)
     - `docs/backlog.md` (epics, issues, milestone order, dependencies)
     - the specific GitHub issue #$1 this work implements
     - the existing toolbelt source tree and tests for the affected behavior — note that the repo is docs-only today, so if no source tree exists yet, say so and work from the design doc/backlog and issue
     - existing docs around the affected behavior
   - Preserve mx-loom constraints:
     - Secret boundary: Matrix tokens, Ed25519 signing keys, provider keys, and `GH_TOKEN` never cross Boundary A into the runtime process, the model context, or runner children. The toolbelt enforces a deny-by-default env allowlist; runner children receive retrieved TEXT only, never credentials.
     - Never weaken the contract; never log or persist secrets or tokens. No tool field carries credentials inbound or outbound; reject credential-shaped args.
     - Out-of-process enforcement: trust (Ed25519 store), deny-by-default `policy.toml`, sandbox, and human approval gates all execute on the receiving mx-agent daemon. Cognition can only produce a signed request; it can never grant itself authority.
     - The model is never given trust/policy/approval mutation tools; approval reaches the model only as an `awaiting_approval` result status, re-validated against live policy at release.
     - Respect milestone boundaries and existing repository conventions; document new public APIs and design-worthy decisions.
     - Do not imply unimplemented behavior exists unless this issue actually implements it.

3. Decide whether a `/plan`-style spec is needed
   - Create a spec when the issue is non-trivial, spans multiple components (transport/IPC client, canonical registry, result envelope, per-runtime bindings, daemon RPC seam), changes user-visible behavior, affects the tool contract, the result envelope/error taxonomy, the deferred-result/approval flow, the secret-boundary guard, the policy/trust enforcement seam, the session/registration model, persistence/audit schemas, or has ambiguous acceptance criteria.
   - For specs, create `specs/` if needed and write `specs/issue-$1-<descriptive-slug>.md` using the structure and quality bar from `.claude/commands/plan.md`.
   - The spec must include problem statement, goals/non-goals, repository context, affected components/modules, implementation approach, security considerations (secret boundary, trust/policy/approval enforcement, audit correlation), testing plan, e2e decision, risks/open questions, and implementation checklist.
   - For trivial issues, skip the spec and state: `Spec decision: no separate spec needed because ...`.
   - If a spec is created, treat it as the source of truth together with the issue acceptance criteria.

4. Summarize and plan briefly
   - Summarize the requested implementation in a few bullets.
   - Identify the owning component(s), modules, existing patterns, docs, and tests involved.
   - List the concrete implementation steps.
   - Then proceed; do not stop after planning.

5. Implement using `/implement` semantics
   - Make the smallest correct change that satisfies the issue and any created spec.
   - Keep changes focused, idiomatic, and testable.
   - Do not pull in unrelated work or broad rewrites.
   - Update docs, help text, or design notes when behavior or a design decision changes.
   - Maintain the secret boundary: no secret crosses Boundary A; trust/policy/approval enforcement stays out-of-process on the receiving daemon; cognition only produces signed requests.
   - Never expose Matrix tokens, Ed25519 signing keys, provider keys, or `GH_TOKEN` through logs, stdout/stderr, command arguments, fixtures, or PR text.

6. Strengthen focused tests using `/tests` semantics
   - Inspect existing coverage for the changed behavior.
   - Add or update focused unit tests, deterministic integration tests, result-envelope/error-taxonomy tests, idempotency tests, secret-boundary/redaction tests, schema/persistence tests, and negative/security regression tests as appropriate.
   - Prefer the smallest test layer that gives confidence.
   - Do not weaken assertions or delete meaningful tests to make the suite pass.
   - Do not add live-daemon, external-network, or multi-agent requirements in this phase.

7. Evaluate e2e coverage using `/e2e_tests` semantics
   - Consider e2e coverage when the issue affects cross-boundary flows: the full delegate → approval-gate → approve → result loop, guarded exec, the deferred-result/`mx_await_result` path, cross-agent context share/get, durable task state surviving a runtime restart, or the runtime-binding ↔ daemon ↔ remote-agent path.
   - Add e2e tests only when lower-level tests are insufficient, and use whatever e2e harness the project has adopted (or describe what it should exercise if none exists yet).
   - Do not make the default test command depend on external networks, live backends, or real devices unless that is already the project convention.
   - If e2e tests are not added, explicitly report: `E2E decision: not added because ...`.

8. Self-review using `/review` semantics before handing off
   - Review the changed files against the issue and any spec.
   - Check for scope creep, correctness bugs, missing error handling, weak tests, misleading docs, secret/token exposure, weakened or bypassed trust/policy/approval enforcement, broken approval-gate or deferred-result guarantees, secret-boundary violations, missing public docs, and formatting/lint risks.
   - Fix issues found during self-review before handing off.
   - Do not post PR comments during this local self-review phase because the PR does not exist yet.

9. Verify before handing off
   - Run the project's configured test gate (the command surfaced via the `MX_AGENT_TEST_CMD` environment variable) plus any format, lint, and build checks the project defines.
   - The repo is docs-only today, so test gates are empty until the first package exists. The stack is TypeScript (pnpm, Node ≥20.19, vitest, Apache-2.0). If no test command is configured yet, say so explicitly and recommend the exact command to run once the package lands — do not invent commands the repo does not yet define.
   - Run any explicit commands named in the issue acceptance criteria or created spec.
   - Run any relevant narrow tests first when useful; the configured gate should pass before handing off unless there is a genuine environment blocker.
   - If a check fails, fix it and rerun the relevant check. If a check cannot be run, explain why and recommend the exact command.

10. Prepare the handoff for the orchestrator (do not run git or gh)
   - Ensure the working tree contains only relevant changes for issue #$1.
   - Propose a clear commit message ending in `closes #$1`.
   - Provide a complete PR body the orchestrator can use, including:
     - Summary
     - Related issue: `Closes #$1`
     - Spec path, if one was created
     - Changes made
     - Tests/checks run and results (or why the gate could not run yet)
     - E2E decision and commands, if applicable
     - Security considerations (secret boundary, trust/policy/approval enforcement, audit correlation)
     - Any assumptions or limitations
     - Checklist from the repository PR template, if present

11. Final report
   - State that issue #$1 is implemented and self-reviewed, ready for the orchestrator to commit, open the PR, watch CI, and merge.
   - Report the spec path if one was created, or the reason a spec was skipped.
   - Summarize files changed and behavior implemented.
   - Summarize tests and e2e coverage decisions.
   - Report verification results (test gate / checks run, or why they could not run).
   - Note assumptions, risks, limitations, or follow-up work.

If anything is ambiguous, state the assumption you are making and proceed when safe. Only stop for genuine blockers.
