# Contributing to mx-loom

Thanks for your interest. `mx-loom` is in the **design phase** — the architecture and a
sequenced backlog exist; implementation has not started.

## Start here

1. Read the [design doc](docs/mx-agent-tool-fabric-design.md) — it defines the boundary,
   the tool contract, and the security model.
2. Read the [backlog](docs/backlog.md) — work is organized into milestones M0–M6 with
   `T###` issues and a critical path. Pick up unblocked `P0` issues first.

## Principles (from the design doc)

- **Cognition is pluggable; coordination is the constant.** Keep all model/planning/memory
  concerns in the runtime; `mx-loom` only translates.
- **No secrets cross Boundary A.** Matrix tokens, signing keys, and provider credentials stay
  in the daemon — never in the runtime process or model context.
- **One canonical registry.** Every runtime binding is generated from the same tool
  descriptors; never hand-author tools per runtime.
- **The model never holds authority.** Trust, policy, and approval are operator/daemon
  concerns, never model-facing tools.

## Conventions

- TypeScript, pnpm workspace, Node ≥ 20.19 (matching the mx-* family).
- Licensed under Apache-2.0; by contributing you agree your contributions are licensed under it.
- Don't expand scope beyond the design doc — raise an issue/open question instead.

## Pinned substrate

`mx-loom` targets a pinned `mx-agent` version (see `.mx-agent-version`, backlog T006). A
conformance suite (T007) must pass before any pin bump.
