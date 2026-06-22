---
description: Update standalone documentation after a reviewed implementation (phased ADW)
argument-hint: "<change-summary-and-files>"
---
Update the repository's documentation to reflect the implemented, reviewed change.

Change summary, files changed, and context:

$ARGUMENTS

## Scope and boundary

This is the **standalone documentation pass**, distinct from the inline doc edits already made
during implementation:

- The `implement` phase already made the tight, code-local edits that must ship with the code
  (doc-comments on new public APIs, in-app/usage text, the focused references the change toggles).
  Do not redo or fight those.
- Here, update the broader prose that benefits from seeing the finished change: the project docs
  (`docs/mx-agent-tool-fabric-design.md`, a `README`, developer/integration guides), and — when a
  change shifts project scope, an epic, or an issue's status — the relevant entries in
  `docs/backlog.md`, plus any cross-references to `docs/mx-agent-tool-fabric-design.md` that are now
  stale. The repo is docs-only today: if no developer-guide tree or README exists yet, the only
  durable docs are `docs/mx-agent-tool-fabric-design.md` and `docs/backlog.md`, so confine prose
  updates to those (and only when the change actually invalidates them).

## Instructions

- Only update documentation when the change is user-visible, alters a public API/CLI/protocol,
  or invalidates an existing doc / `docs/mx-agent-tool-fabric-design.md` / `docs/backlog.md`
  statement. If nothing needs updating, change nothing and report `docs_updated` false.
- Edit existing documentation in place. Do NOT create an `app_docs/` tree or a new
  per-feature documentation hierarchy.
- Describe only what this change actually implements; do not overstate planned or future behavior.
- Preserve mx-loom's invariants in any prose you write: the adaptation layer is secret-free —
  Matrix tokens, Ed25519 signing keys, provider keys, and `GH_TOKEN` never cross Boundary A into the
  runtime process, the model context, or runner children (deny-by-default env allowlist; runners
  receive retrieved TEXT only). Enforcement is out-of-process on the receiving mx-agent daemon
  (Ed25519 trust store + deny-by-default `policy.toml` + human approval gates); cognition can only
  produce a signed request, never grant itself authority; approval reaches the model only as an
  `awaiting_approval` result status. Do not document anything that would contradict or weaken these.
- Do not document secrets, tokens, signing keys, or credentials; preserve existing redaction
  conventions.

Because this is the last authoring phase when it runs, also author the final commit message and
PR body (see the output instructions below) so they reflect all changes — code, tests, and docs.
