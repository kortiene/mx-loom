---
description: Review a PR produced by /implement and comment when useful
argument-hint: "<pr-url-or-number> [spec-file]"
---
Review this pull request, which may have been produced by `/implement`:

PR: $1
Spec file, if provided: $2
Extra context/notes from me (everything after the PR and optional spec file; may be empty). Full invocation for reference: $ARGUMENTS

Do not modify code unless explicitly asked. Focus on review quality, correctness, security, scope control, and actionable feedback. If the PR has actionable issues, comment on the PR when useful.

Workflow:

1. Validate inputs
   - If `$1` is missing, stop and ask for a PR URL or number.
   - If `$2` is provided, read the spec file completely and review the PR against it.
   - If `$2` is provided but missing, report that clearly and continue reviewing against repository context if possible.

2. Read repository context before reviewing
   - `docs/mx-agent-tool-fabric-design.md` (architecture, tool contract, and security model)
   - `docs/backlog.md` (epics, issues, milestone order, and dependencies)
   - the specific GitHub issue the PR addresses, if referenced
   - the toolbelt source tree once it exists (the repo is docs-only today — if no toolbelt code exists yet, say so and review against the design doc/backlog and any committed design notes under `docs/`)
   - changed source files, tests, and docs from the PR

3. Inspect the PR
   - Use `gh` (or `~/.local/bin/gh` if needed) to inspect PR metadata, commits, changed files, checks, and diff.
   - Determine the base branch and compare the PR against the correct base.
   - Read enough of the changed files in context to understand the implementation, not just the diff.

4. Review against the spec and repository constraints
   - Verify whether the PR satisfies the provided spec and acceptance criteria.
   - Check that the implementation does not exceed the requested scope.
   - Confirm docs are updated when behavior changes.
   - Confirm tests cover the new behavior and important edge cases.

5. Check mx-loom-specific requirements
   - Preserve the secret boundary: Matrix tokens, Ed25519 signing keys, provider keys, and `GH_TOKEN` must never cross Boundary A into the runtime process, the model context, or runner children; the toolbelt enforces a deny-by-default env allowlist and runner children receive retrieved TEXT only.
   - Ensure the contract is never weakened; no secret or token is ever logged or persisted, and no tool field carries credentials inbound or outbound.
   - Ensure enforcement stays out-of-process on the receiving daemon: Ed25519 trust store, deny-by-default `policy.toml`, sandbox, and human approval gates. Cognition only produces a signed request and never grants itself authority.
   - Verify the model is never given trust/policy/approval mutation tools; approval reaches the model only as an `awaiting_approval` result status, re-validated against live policy at release.
   - Verify audit correlation: every tool result carries `audit_ref` tying model action ↔ daemon invocation ↔ operator approval.
   - Confirm secrets and tokens are never logged or posted; use existing redaction patterns.
   - Do not accept misleading status claims or docs implying unimplemented behavior exists.

6. Look for general review issues
   - Correctness bugs or incomplete behavior
   - Missing error handling or poor error messages
   - Race conditions, restart/retry issues, or persistence gaps
   - Security regressions or trust/policy/approval bypasses
   - Protocol/schema compatibility issues (result envelope, error taxonomy, idempotency)
   - Weak tests or missing negative tests
   - Overly broad rewrites or unrelated changes
   - Formatting, lint, or docs-warning risks

7. Verify checks when practical
   - Inspect existing PR/CI check status with `gh`.
   - When practical and appropriate locally, run the project's configured test gate (the command surfaced via `MX_AGENT_TEST_CMD`) plus any format/lint/build checks the project defines.
   - The repo is docs-only today, so test gates are empty until the first package exists. The stack is TypeScript (pnpm, Node ≥20.19, vitest, Apache-2.0). If no test command is configured yet, say so explicitly and recommend the exact command to run once the package lands — do not invent commands the repo does not yet define.
   - If checks cannot be run, explain why and recommend exact commands.

8. Comment on the PR when needed
   - If the PR has actionable issues, post a clear PR review comment or review summary using `gh`.
   - Prefer one consolidated review comment over many noisy comments unless line-specific feedback is important.
   - Comment only when feedback is useful, actionable, and relevant to the PR.
   - Do not post a PR comment for purely local observations unless they affect the PR.
   - If the PR looks good, either approve if appropriate or leave a concise positive summary, depending on available permissions.
   - Never post secrets, tokens, credentials, Matrix tokens, Ed25519 signing keys, provider keys, `GH_TOKEN`, private paths that matter, or sensitive data in PR comments.
   - In the local final report, state exactly what PR comments or reviews were posted, if any.

9. Produce a structured local review report
   - Summary
   - Spec compliance assessment
   - Security assessment
   - Correctness issues
   - Testing/docs gaps
   - Required fixes
   - Optional improvements
   - Checks reviewed or run, with results
   - PR comments posted, if any
   - Final recommendation: approve / request changes / needs more info

Important: do not implement fixes during review unless explicitly asked. Review first; comment on the PR only when it improves the PR outcome.
