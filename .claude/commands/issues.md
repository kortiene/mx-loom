---
description: Implement multiple GitHub issues sequentially using /issue semantics
argument-hint: "<issue-id-or-range> [issue-id-or-range ...] [-- notes]"
---
Implement multiple GitHub issues sequentially for this repository, end to end, using `/issue` semantics for each issue.

Issue selectors and shared notes:

$ARGUMENTS

`/issues` is a batch orchestrator. It must process issues one at a time, in normalized order, and must return to a clean, updated `main` between issues. Do not parallelize. Do not combine multiple issues into one branch or PR unless the user explicitly asks and the issues genuinely require a shared implementation.

Read `.claude/commands/issue.md` before starting. Treat it as the phase contract for each individual issue. Apply its workflow inline for every issue; do not merely tell the user to run `/issue` separately.

Workflow:

1. Parse and normalize issue selectors
   - Accept single numeric issue IDs, e.g. `12`.
   - Accept inclusive hyphen ranges, e.g. `12-14` expands to `12, 13, 14`.
   - Accept inclusive dot ranges, e.g. `12..14` expands to `12, 13, 14`.
   - Preserve the order written by the user.
   - Expand ranges in place.
   - Deduplicate repeated IDs while preserving the first occurrence.
   - Treat everything after `--` as shared notes/context to pass into each issue workflow.
   - If no issue selector is provided, stop and ask for one or more issue IDs/ranges.
   - If any selector is invalid, stop and report the invalid selector.
   - Print the expanded issue list before starting.
   - If more than 5 issues are selected, ask for confirmation before proceeding.

2. Preflight all selected issues before implementing any of them
   - For each normalized issue ID, inspect the title, labels, milestone, status, scope, dependencies, and acceptance criteria from the issue context the orchestrator provides. The orchestrator owns all git/gh; do not run git or gh yourself.
   - Cross-check each issue against `docs/mx-agent-tool-fabric-design.md` and `docs/backlog.md` for scope, milestone order, and the dependency chain.
   - If an issue is already CLOSED, mark it as skipped and continue.
   - If an issue is missing or inaccessible, stop and report it.
   - Detect obvious dependency lines such as `Depends on #<id>` / `blocked-by T###`, and respect the `docs/backlog.md` ordering — the SDK seam + transport (T002→T004) and the canonical registry + result envelope (T101→T102) gate most downstream work, and the approval-gated golden delegation test (T114) is the core demonstrable value.
   - If an issue depends on another selected issue that appears later in the normalized list, recommend reordering and ask whether to continue in the given order.
   - If an issue depends on an open issue that is not selected, ask whether to skip that issue, stop the batch, or continue anyway.
   - Stop for real blockers such as acceptance criteria that conflict with the secret-boundary / out-of-process-enforcement constraints, require real secrets/credentials, or require broad architecture decisions that are not yet settled.

3. Establish batch processing rules
   - Default branch/PR strategy: one issue → one branch → one PR → one merge.
   - Preserve user-provided order after range expansion unless dependency preflight leads to an explicit user-approved reorder.
   - Continue automatically after successfully shipped issues.
   - Skip already-closed issues.
   - If an issue hits a genuine blocker, stop the entire batch unless the user explicitly instructs you to skip blocked issues.
   - If CI fails for an issue, fix it as `/issue` would; do not move on while that PR is red.
   - If the repository is dirty unexpectedly between issues, stop and report the dirty state.

4. Process each issue sequentially using `/issue` semantics
   For each issue ID that was not skipped:
   - Confirm the repository is on `main`, updated from origin, and has a clean working tree before starting.
   - Run the equivalent of `/issue <id> <shared notes>` inline, following `.claude/commands/issue.md` completely:
     - start the issue from the orchestrator-provided issue context (title, labels, milestone, scope, acceptance criteria)
     - read repository context (the design doc, backlog, the issue, and any existing source tree — noting the repo is docs-only if no source exists yet)
     - decide whether a `/plan`-style spec is needed
     - implement using `/implement` semantics
     - strengthen focused tests using `/tests` semantics
     - evaluate e2e coverage using `/e2e_tests` semantics
     - self-review using `/review` semantics
     - run the configured test gate and any required checks
     - commit with a message ending in `closes #<id>`
     - push and open a PR
     - wait for CI and fix failures until green
     - perform final PR review
     - merge with squash and delete the branch
     - return to `main` and `git pull --rebase origin main`
   - Confirm the issue is closed after merge.
   - Record the result, PR number, spec path or spec-skip reason, tests added, e2e decision, checks, assumptions, and any follow-up notes.
   - Only then continue to the next issue.

5. Preserve mx-loom constraints for every issue
   - Secret boundary: Matrix tokens, Ed25519 signing keys, provider keys, and `GH_TOKEN` never cross Boundary A into the runtime process, the model context, or runner children. The toolbelt enforces a deny-by-default env allowlist; runner children receive retrieved TEXT only, never credentials.
   - Never weaken the contract; never log or persist secrets or tokens. No tool field carries credentials inbound or outbound; reject credential-shaped args.
   - Out-of-process enforcement: trust (Ed25519 store), deny-by-default `policy.toml`, sandbox, and human approval gates all execute on the receiving mx-agent daemon. Cognition can only produce a signed request; it can never grant itself authority.
   - The model is never given trust/policy/approval mutation tools; approval reaches the model only as an `awaiting_approval` result status, re-validated against live policy at release.
   - Identify the owning component (transport/IPC client, canonical registry, result envelope, a per-runtime binding, daemon RPC seam) and reuse existing patterns before editing.
   - The stack is TypeScript (pnpm, Node ≥20.19, vitest, Apache-2.0), but the repo is docs-only today: no toolbelt package exists yet. Do not imply that any tool, binding, or transport already exists unless a given issue actually implements it.

6. Final batch report
   At the end, produce a concise table with one row per normalized issue:

   | Issue | Result | PR | Spec | Tests | E2E | Notes |
   |---|---|---|---|---|---|---|

   Include:
   - Total selected
   - Total shipped
   - Total skipped
   - Total blocked
   - Final branch
   - Final working tree status
   - Any issue order/dependency decisions
   - Any assumptions, risks, limitations, or follow-up work

Important: `/issues` is intentionally sequential and conservative. Each issue should be fully shipped or explicitly skipped/blocked before moving to the next one.
