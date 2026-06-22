# adw_sdlc — mx-loom build harness

`adw_sdlc` is the **agentic developer-workflow (ADW) SDLC** control plane used to BUILD mx-loom.
It drives a GitHub issue through a phased, multi-agent delivery pipeline:

```
setup → classify → plan → implement → tests → resolve(loop) → e2e(gated)
      → review → patch(loop) → document(gated) → finalize → ci-fix(loop) → merge → report
```

The orchestrator owns **all** git/gh and withholds secrets from the agent (deny-by-default env
allowlist, see `src/env.ts`); each phase runs on one of four interchangeable runner backends
(`claude` | `codex` | `opencode` | `pi`) behind a single `AgentRunner.runPhase()` seam. See
[`PLAN.md`](./PLAN.md) for the architecture and [`PARITY.md`](./PARITY.md) for the parity checklist.

## Origin

Ported from the HealthTech standalone `adw_sdlc` (itself ported from the `mx-agent` monorepo,
TypeScript-only and self-contained), then re-targeted at **mx-loom**.

## What changed for mx-loom

| Area | HealthTech port | mx-loom |
| --- | --- | --- |
| Branch prefixes (`TYPE_PREFIX`, `src/issue.ts`) | mx-agent `type:*` + HealthTech plain labels | mx-loom `type/*` scheme (`type/feature`→feat, `type/chore`→chore, `type/test`→test, `type/docs`→docs, `type/spike`→spike) + plain fallbacks |
| e2e gate hints (`CROSS_BOUNDARY_HINTS`, `src/phases.ts`) | + HealthTech domain (crypto, consent, qr, offline…) | + tool-fabric domain (mcp, binding, runner, delegate, approval, workspace, audit, e2ee…) |
| Phase prompt templates (`.claude/commands`, `.pi/prompts`) | HealthTech (local-first/zero-knowledge, AES-256-GCM, ARTCI, ≤500 KB, PRD/BACKLOG) | re-pointed at mx-loom (TypeScript/pnpm, MCP/Matrix tool fabric, the secret boundary, `docs/mx-agent-tool-fabric-design.md` + `docs/backlog.md`) |
| Test gate (`DEFAULT_TEST_CMD`) | empty | empty — repo is docs-only; set `MX_AGENT_TEST_CMD` (e.g. `pnpm test`) once a package lands |
| Pre-merge gates (`DEFAULT_FINALIZE_GATES`) | empty/configurable | unchanged; configure via `MX_AGENT_FINALIZE_GATES` (newline-separated) |
| Package manager | npm | **pnpm** workspace member (`package-lock.json` dropped) |

The cross-engine state contract is bundled at `../adw/state.schema.json` (+ fixtures under
`../adw/fixtures/cross_language/`) — JSON only, no Python.

## Layout (at the mx-loom repo root)

`REPO_ROOT` resolves two levels up from `src/`/`dist/` — the mx-loom root — which holds
`.claude/commands/`, `.pi/prompts/`, `adw/state.schema.json`, and the runtime `agents/` workspaces
(gitignored).

## Usage

```bash
pnpm install                                       # from the mx-loom root
pnpm -C adw_sdlc issue <N> --dry-run               # preview the plan for issue #N (no runner SDK needed)
pnpm -C adw_sdlc issue <N> --runner claude --yes   # run the pipeline on issue #N
```

Requires `gh` authenticated for `kortiene/mx-loom`. The env prefix is `MX_AGENT_*` (kept from
upstream; denied to runner children by the secret boundary in `src/env.ts`).

## Verification

- `pnpm -C adw_sdlc typecheck` → clean
- `pnpm -C adw_sdlc test` → vitest suite green (fully mocked; no network/keys)
- `pnpm -C adw_sdlc lint:env` → secret-withholding gate (`../scripts/check-adw-sdlc-env.sh`)
