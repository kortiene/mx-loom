---
description: Implement a spec file end-to-end
argument-hint: "<spec-file>"
---
Implement the specification in this file end-to-end:

$1

Extra context/notes from me (everything after the spec path; may be empty). Full invocation for reference: $ARGUMENTS

Do not stop after planning unless the spec is genuinely ambiguous, unsafe, impossible, or blocked by missing information. Read the spec, implement it, test it, and report the result.

Workflow:

1. Read and understand the spec
   - Read the spec file at `$1` completely.
   - Treat the spec as the source of truth for scope and acceptance criteria.
   - If the file does not exist, stop and report the missing path.
   - If the spec is ambiguous, state the ambiguity, make a reasonable assumption when safe, and proceed. Stop only for real blockers.

2. Read repository context before editing
   - `docs/mx-agent-tool-fabric-design.md` (architecture, tool contract, and security model)
   - `docs/backlog.md` (epics, issues, milestone order, dependencies)
   - the specific GitHub issue the spec implements, if one is referenced
   - the existing toolbelt source tree and tests for the affected behavior — note that the repo is docs-only today, so if no source tree exists yet, say so and work from the design doc/backlog and spec
   - existing docs around the affected behavior

3. Summarize and plan briefly
   - Summarize the requested implementation in a few bullets.
   - Identify the owning component(s) (e.g. transport/IPC client, canonical registry, result envelope, a per-runtime binding, the daemon RPC seam), modules, and existing patterns.
   - List the concrete implementation steps.
   - Then proceed with implementation.

4. Implement the spec completely
   - Make the smallest correct change that satisfies the spec.
   - Keep changes focused, idiomatic, and testable.
   - Preserve existing repository conventions and milestone boundaries.
   - Do not introduce broad rewrites unless the spec explicitly requires them.
   - Update docs when behavior changes.
   - Add or update tests that cover the new behavior.

5. Preserve mx-loom constraints
   - Secret boundary: Matrix tokens, Ed25519 signing keys, provider keys, and `GH_TOKEN` never cross Boundary A into the runtime process, the model context, or runner children. The toolbelt is the chokepoint enforcing a deny-by-default env allowlist; runner children receive retrieved TEXT only, never credentials.
   - Never weaken the contract; never log or persist secrets or tokens. No tool field carries credentials inbound or outbound; reject credential-shaped args.
   - Out-of-process enforcement: trust (Ed25519 store), deny-by-default `policy.toml`, sandbox, and human approval gates all execute on the receiving mx-agent daemon. Cognition can only produce a signed request; it can never grant itself authority.
   - The model is never given trust/policy/approval mutation tools; approval reaches the model only as an `awaiting_approval` result status, re-validated against live policy at release.
   - Do not imply unimplemented behavior exists unless this implementation actually adds it.

6. Verify before finishing
   - Run the project's configured test gate (the command surfaced via the `MX_AGENT_TEST_CMD` environment variable) plus any format, lint, and build checks the project defines.
   - The repo is docs-only today, so test gates are empty until the first package exists. The stack is TypeScript (pnpm, Node ≥20.19, vitest, Apache-2.0). If no test command is configured yet, say so explicitly and recommend the exact command to run once the package lands — do not invent commands the repo does not yet define.
   - Run any additional checks named in the spec.
   - If a check fails, fix the issue and rerun the relevant check when practical.
   - If a check cannot be run, explain why and recommend the exact command.

7. Final report
   - Spec implemented: `$1`
   - Files changed
   - Behavior implemented
   - Tests/checks run and results
   - Any assumptions made
   - Any remaining risks, limitations, or follow-up work

Important: do not merely create another plan. Implement the provided spec end-to-end.
