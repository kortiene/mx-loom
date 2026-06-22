# mx-agent version pin

mx-loom builds against a single, pinned `mx-agent` version, recorded in
[`.mx-agent-version`](../.mx-agent-version) at the repo root — currently **`v0.2.1`**.

## Why pin

`mx-agent` is public alpha. Its daemon JSON-RPC surface and the `com.mxagent.*` Matrix event
schemas (see [`docs/mx-agent-tool-fabric-design.md`](./mx-agent-tool-fabric-design.md) §2) may
change between releases. mx-loom's toolbelt encodes assumptions about that surface, so it targets
one known-good version rather than tracking `main`. This is the substrate-pin discipline from
mx-agency's ADR-11.

## Pin-bump policy (deny-by-default)

A bump to a new `mx-agent` version lands **only** when:

1. The **conformance suite** (backlog **T007 / #7**) passes against the new version. It is real and
   executable, not aspirational:
   - **Suite:** `packages/toolbelt/test/conformance/` — Tier 0 (pin identity), Tier 1
     (`agent.register` / `agent.list` + closed error taxonomy), Tier 2 (`call.start` delegation,
     two daemons).
   - **Run it:** `pnpm --filter @mx-loom/toolbelt test:conformance` against a live daemon. With no
     daemon it skips cleanly; in CI the `conformance` job sets `MXL_CONFORMANCE=1` so a missing or
     drifted daemon is a **hard failure** (never a silent skip).
   - **CI job:** `.github/workflows/conformance.yml` (job `live` for Tier 0/1, `delegate` for
     Tier 2). For a pin-bump PR, run it against the candidate via the workflow's
     `workflow_dispatch` `version` input **before** editing `.mx-agent-version`.
2. If the bump spans schema or RPC changes, the surface-verification spike (**T001 / #1**) is
   re-run and any deltas are filed as issues before bumping.
3. `.mx-agent-version` is updated **and** the PR notes the version delta and conformance result.

If conformance is red, the bump does not land. Treat `.mx-agent-version` as the single source of
truth for the supported substrate version; tooling and CI read it rather than hard-coding a tag.
