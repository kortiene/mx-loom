---
description: Resolve failing repository checks reported by the phased ADW test gate
argument-hint: "<failing-output-and-context>"
---
The repository's test/verification gate is failing. Fix the failures.

Failing output and context (truncated):

$ARGUMENTS

## Instructions

- Investigate the failures above and make the smallest correct change that fixes them.
- Fix the root cause in the code or the tests as appropriate. Do NOT weaken or delete
  meaningful assertions, skip tests, or mask failures to make the gate pass.
- Stay within the scope of the current change; do not start unrelated work.
- Preserve mx-loom constraints: keep the secret boundary intact — Matrix tokens, Ed25519 signing
  keys, provider keys, and `GH_TOKEN` never cross Boundary A into the runtime process, the model
  context, or runner children (deny-by-default env allowlist; runners receive retrieved TEXT only).
  Never weaken the contract, never log or persist secrets or tokens, and keep no tool field carrying
  credentials inbound or outbound. Keep enforcement out-of-process on the receiving mx-agent daemon
  (Ed25519 trust store + deny-by-default `policy.toml` + sandbox + human approval gates); cognition
  can only produce a signed request, never grant itself authority; approval reaches the model only as
  an `awaiting_approval` result status, re-validated against live policy at release.
- The orchestrator re-runs the gate after you finish. Report how many failing checks you
  fixed (`resolved`) and how many remain (`remaining`); if you could fix nothing, say so via
  the counts so the loop can stop.

## Verify before finishing

Before you report, re-run the failing check and the project's configured verification gate
(the command surfaced via `MX_AGENT_TEST_CMD`) plus any format/lint/build checks the project
defines, and confirm they pass.

The repo is docs-only today, so test gates are empty until the first package exists. The stack is
TypeScript (pnpm, Node ≥20.19, vitest, Apache-2.0). So:

- If a test/lint/format/build command IS configured, run it, fix anything it surfaces, and rerun
  the relevant check until it passes.
- If NO test command is configured yet, say so explicitly and recommend the exact command that should
  be run once the package lands so the gate can be re-run — do NOT invent commands the repo does not
  yet define.

If a check cannot be run, say why and give the exact command.
