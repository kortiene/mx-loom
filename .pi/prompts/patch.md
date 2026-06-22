---
description: Resolve blocking review findings in the phased ADW pipeline
argument-hint: "<blocker-findings-and-context>"
---
A self-review found blocking issues in the current implementation. Resolve them.

Blocking findings and context:

$ARGUMENTS

## Instructions

- Address every blocking finding above with the smallest correct change.
- Only fix the listed blockers; do not act on tech-debt or skippable items, and do not start
  unrelated work or broad rewrites.
- Keep tests meaningful — fix the cause, do not weaken assertions.
- Preserve mx-loom constraints: keep the secret boundary intact — Matrix tokens, Ed25519 signing
  keys, provider keys, and `GH_TOKEN` never cross Boundary A into the runtime process, the model
  context, or runner children (deny-by-default env allowlist; runners receive retrieved TEXT only).
  Never weaken the contract; never log or persist secrets or tokens; no tool field carries
  credentials inbound or outbound. Keep enforcement out-of-process on the receiving mx-agent daemon
  (Ed25519 trust store + deny-by-default `policy.toml` + sandbox + human approval gates); cognition
  can only produce a signed request, never grant itself authority. Approval reaches the model only as
  an `awaiting_approval` result status, re-validated against live policy at release.
- Report how many blocking findings you fixed (`resolved`) and how many remain (`remaining`).

## Verify before finishing

If you changed code, before you report run the project's configured test gate (the command surfaced via
`MX_AGENT_TEST_CMD`) plus any format, lint, and build checks the project defines.

The repo is docs-only today, so test gates are empty until the first package exists. The stack is
TypeScript (pnpm, Node ≥20.19, vitest, Apache-2.0). If no test command is configured yet, say so
explicitly and recommend the exact command to run once the package lands — do not invent commands the
repo does not yet define.

Fix anything these surface and rerun the relevant check. If a check cannot be run, say why and
give the exact command.
