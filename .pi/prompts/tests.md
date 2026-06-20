---
description: Add or improve focused non-e2e tests for a spec, PR, or working tree
argument-hint: "[spec-file|pr-url-or-number|notes]"
---
Add or improve focused non-e2e test coverage for this target:

$ARGUMENTS

This command is for unit tests, deterministic integration tests that do not require external services, argument/output tests, result-envelope/error-taxonomy/schema tests, and negative/security regression tests. Do not add tests that require live infrastructure (a running mx-agent daemon, a second registered agent, or a real Matrix homeserver) here; use `/e2e_tests` for those.

Workflow:

1. Understand the testing target
   - If the argument is a spec file path, read it completely and identify the behavior that should be covered by tests.
   - If the argument is a PR URL or number, inspect PR metadata, changed files, commits, checks, and diff using `gh` (or `~/.local/bin/gh` if needed).
   - If the argument is notes/free text, treat it as testing goals for the current working tree.
   - If no argument is provided, inspect the current working tree and ask for clarification only if the target is genuinely unclear.

2. Read repository context before editing
   - `docs/mx-agent-tool-fabric-design.md` (architecture, the tool contract, the security/trust/approval model)
   - `docs/backlog.md` (epics, issues, and their order)
   - the specific GitHub issue being worked (kortiene/mx-loom), if named in the target
   - the existing toolbelt source tree and any tests around the target behavior — note: the repo is docs-only today, so the source tree may not exist yet; if so, say so.

3. Identify coverage gaps
   - Summarize the behavior under test.
   - Identify existing tests that already cover it.
   - Identify missing edge cases, negative cases, error handling, secret-boundary/redaction boundaries, policy-denial and approval-gate checks, result-envelope/error-taxonomy/schema compatibility, idempotency/replay paths, and regression risks.
   - Prefer the smallest test layer that gives confidence: unit tests before integration tests, integration tests before e2e tests.

4. Add or improve tests
   - Add focused, deterministic tests that cover the gaps.
   - Do not implement new product behavior except minimal testability hooks when absolutely necessary.
   - Do not weaken assertions or delete meaningful coverage to make tests pass.
   - Do not introduce flaky sleeps, timing-sensitive assertions, network dependencies, or external service requirements.
   - Do not use real secrets, Matrix tokens, signing keys, provider keys, or `GH_TOKEN` in fixtures; use synthetic, clearly-fake values.
   - Match the project's TypeScript toolchain (pnpm, vitest); do not introduce a new toolchain.
   - Document public test helpers if they are public APIs; prefer private helpers when possible.

5. Preserve mx-loom constraints
   - Secret boundary: Matrix tokens, Ed25519 signing keys, provider keys, and `GH_TOKEN` never cross Boundary A into the runtime process, the model context, or runner children; the toolbelt enforces a deny-by-default env allowlist. Tests must assert this, never circumvent it.
   - Never weaken the contract; never log or persist secrets or tokens — including in test fixtures, assertions, and snapshots. Add tests that credential-shaped args are rejected and no allowlisted-secret env var appears in any tool payload.
   - Out-of-process enforcement: trust (Ed25519 store), deny-by-default `policy.toml`, sandbox, and human approval gates execute on the receiving daemon; cognition only produces a signed request. Add negative tests that a policy-denied or untrusted call cannot execute, and that approval reaches the model only as an `awaiting_approval` status.
   - Result envelope / error taxonomy: every tool result conforms to the envelope; error codes are a closed set; retried calls with the same `idempotency_key` do not double-execute. Cover these.
   - Do not imply unimplemented behavior exists; only test what is actually implemented.

6. Verify before finishing
   - Run the most relevant test first (the single test or module covering the changed behavior) before the full gate, when practical.
   - Then run the project's configured test gate (the command surfaced via `MX_AGENT_TEST_CMD`) plus any format, lint, and build checks the project defines.
   - The repo is docs-only today, so test gates are empty until the first package exists. The stack is TypeScript (pnpm, Node ≥20.19, vitest, Apache-2.0). If no test command is configured yet, say so explicitly and recommend the exact command to run once the package lands — do NOT invent commands the repo does not yet define.
   - If a check fails, fix the issue and rerun the relevant check when practical.
   - If a check cannot be run, explain why and recommend the exact command.

7. Final report
   - Testing target
   - Files changed
   - Tests added or updated
   - Coverage gaps closed
   - Bugs discovered, if any
   - Checks run and results
   - Remaining coverage gaps or follow-up recommendations

Important: focus on tests. Do not broaden the implementation scope or add e2e infrastructure unless explicitly asked.
