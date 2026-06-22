---
description: Review the working-tree implementation in the phased ADW pipeline
argument-hint: "<spec-file-or-empty> <issue-and-change-context>"
---
Review the implementation currently in the working tree for this change. There is no pull
request yet — review the staged and uncommitted changes against the issue and, if one was
created, the spec.

Spec file, if any: $1

Issue and change context:

${@:2}

## What to do

1. Understand the change.
   - Inspect the working-tree diff against the base branch and read the changed files in
     context, not just the diff.
   - Read the issue/acceptance criteria and the spec (`$1`) when provided; treat them as the
     definition of done. For mx-loom background, consult `docs/mx-agent-tool-fabric-design.md`,
     `docs/backlog.md`, and the specific GitHub issue being worked. The toolbelt source tree may
     not exist yet (the repo is docs-only today) — review whatever artifacts the change touches.

2. Review for quality and correctness.
   - Correctness bugs, missing error handling, weak or missing tests, untested edge cases.
   - Scope control: the change should not exceed what the issue/spec asked for.
   - Docs updated when behavior changes; new public APIs documented.

3. Check mx-loom constraints.
   - Secret boundary: Matrix tokens, Ed25519 signing keys, provider keys, and `GH_TOKEN` must
     never cross Boundary A into the runtime process, the model context, or runner children; the
     toolbelt enforces a deny-by-default env allowlist and runner children receive retrieved TEXT
     only.
   - The contract is never weakened; secrets and tokens are never logged or persisted, and no tool
     field carries credentials inbound or outbound.
   - Out-of-process enforcement: trust (Ed25519 store), deny-by-default `policy.toml`, sandbox, and
     human approval gates all execute on the receiving mx-agent daemon; cognition only produces a
     signed request and never grants itself authority.
   - The model is never given trust/policy/approval mutation tools; approval reaches the model only
     as an `awaiting_approval` result status, re-validated against live policy at release.
   - Audit correlation: every tool result carries `audit_ref` tying model action ↔ daemon
     invocation ↔ operator approval.

4. Grade every finding by severity:
   - `blocker` — must be fixed before merge. A later `patch` phase auto-resolves these.
   - `tech_debt` — should be addressed but is not blocking. Reported, not auto-fixed.
   - `skippable` — minor or nit. Reported only.

5. Author the release text.
   - This is the final authoring phase for most runs, so write a high-quality commit message
     (`commit_message.txt`) and PR body (`pr_body.md`) (see the output instructions below)
     describing the change, the tests/checks run, and any security considerations.
   - For tests/checks: run the project's configured test gate (the command surfaced via
     `MX_AGENT_TEST_CMD`) plus any format/lint/build checks the project defines. The repo is
     docs-only today, so test gates are empty until the first package exists; the stack is
     TypeScript (pnpm, Node ≥20.19, vitest, Apache-2.0). If no test command is configured yet, say
     so explicitly and recommend the exact command to run once the package lands; do not invent
     commands the repo does not yet define.

Do not modify code in this phase — only report findings; the `patch` phase fixes blockers.
