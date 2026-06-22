---
description: Create a detailed implementation spec in specs/ without implementing it
argument-hint: "<prompt>"
---
Create a detailed implementation specification for this request:

$ARGUMENTS

Do not implement the requested feature. Only create a planning/spec document.

Workflow:
1. Read enough repository context to make the plan accurate:
   - `docs/mx-agent-tool-fabric-design.md` (architecture: the cognition/coordination boundary, the tool contract, the security/trust/approval model)
   - `docs/backlog.md` (epics, milestones M0–M6, issues #1–#49 / T001–T605, dependencies, and recommended implementation order)
   - the specific GitHub issue being worked, if the request maps to one
   - the existing toolbelt source tree for the affected area — note: the repo is docs-only today, so if no source exists yet for this request, say so explicitly
2. Think through the request carefully and identify the owning package(s)/module(s), existing patterns, security constraints, and likely edge cases.
3. Create the `specs/` directory if it does not already exist.
4. Write a new Markdown spec file in `specs/`.
   - Derive a short, descriptive, kebab-case filename from the prompt when possible.
   - Prefer a stable name like `specs/<descriptive-slug>.md`.
   - If a file with that name already exists, choose a non-conflicting variant.
5. After writing the spec, report the spec path and a short summary. Do not make code changes beyond the spec file.

The spec must include these sections:

# <Descriptive Title>

## Problem Statement
Explain the user need and current gap.

## Goals
List concrete outcomes this implementation should achieve.

## Non-Goals
List related work that should remain out of scope.

## Relevant Repository Context
Summarize the relevant architecture, packages, modules, current status, and conventions. The stack is TypeScript (pnpm, Node ≥20.19, vitest, Apache-2.0), but the repo is docs-only today, so state which packages/modules do not exist yet rather than assuming they are already implemented.

## Proposed Implementation
Describe the recommended implementation approach in enough detail for a coding agent to execute later.

## Affected Files / Packages / Modules
List likely files and modules to read or modify.

## API / Interface Changes
Describe any command-line, public API, tool-descriptor, result-envelope, or daemon-RPC surface changes. State "none" if none are expected.

## Data Model / Protocol Changes
Describe result-envelope shape, error taxonomy, tool input/output schema, idempotency-key, audit-row, or serialization changes. State "none" if none are expected.

## Security & Compliance Considerations
Call out the secret boundary (Matrix tokens, Ed25519 signing keys, provider keys, and `GH_TOKEN` never cross Boundary A into the runtime/model/runner children; deny-by-default env allowlist; runners receive retrieved TEXT only), out-of-process enforcement on the receiving daemon (Ed25519 trust store + deny-by-default `policy.toml` + sandbox + human approval gates), the principle that cognition only produces a signed request and never grants itself authority, the secret-free tool contract (no field carries credentials inbound or outbound; reject credential-shaped args), audit correlation (`audit_ref` on every result), and logging/redaction concerns (never log secrets or tokens) as applicable.

## Testing Plan
List unit, integration, end-to-end, conformance, result-envelope/error-taxonomy, idempotency, secret-boundary/redaction, or documentation tests that should be added or updated.

## Documentation Updates
List design-doc (`docs/mx-agent-tool-fabric-design.md`), backlog (`docs/backlog.md`), or help-text updates needed.

## Risks and Open Questions
Identify ambiguities, blockers, compatibility concerns, and decisions needing confirmation.

## Implementation Checklist
Provide a step-by-step checklist suitable for a coding agent to follow later.

Important constraints to preserve:
- Secret boundary: Matrix tokens, Ed25519 signing keys, provider keys, and `GH_TOKEN` never cross Boundary A into the runtime process, the model context, or runner children. The toolbelt enforces a deny-by-default env allowlist; runner children receive retrieved TEXT only, never credentials.
- Never weaken the contract; never log or persist secrets or tokens. No tool field carries credentials inbound or outbound; reject credential-shaped args.
- Out-of-process enforcement: trust (Ed25519 store), deny-by-default `policy.toml`, sandbox, and human approval gates all execute on the receiving mx-agent daemon. Cognition can only produce a signed request; it can never grant itself authority.
- The model is never given trust/policy/approval mutation tools; approval reaches the model only as an `awaiting_approval` result status, re-validated against live policy at release.
- The stack is TypeScript (pnpm, Node ≥20.19, vitest, Apache-2.0), but the repo is docs-only today: flag any package/module that does not exist yet as a decision to confirm rather than assuming it is built.
- Document new public APIs.
- Do not imply unimplemented behavior exists unless the later implementation actually adds it.
