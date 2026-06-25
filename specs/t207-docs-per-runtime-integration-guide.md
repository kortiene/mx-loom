# T207 · Per-Runtime Integration Guide

> Spec for GitHub issue **#29** — `T207 · docs: per-runtime integration guide`
> (`area/docs` `type/docs` `priority/P1`, **S**, milestone **M2 — Universal binding**).
> Blocked-by **#28** (T206 portability matrix). Source: `docs/backlog.md` (`T207`).

## Problem Statement

A developer who wants to weave their agent runtime into the mx-agent fabric must
today **reverse-engineer the integration from five scattered sources**:

- `examples/adk/README.md` — ADK `MCPToolset` (T201) + native long-running (T202)
- `examples/opencode/README.md` — OpenCode `opencode.json` `mcp` entry (T203)
- `packages/claude/README.md` — the Claude Agent SDK in-process shim (T110)
- `packages/pi/README.md` — the Pi native-tool binding (T205)
- `packages/mcp/README.md` — the generated `mx-loom-mcp` server + minimal
  Claude Code / Claude Desktop / ADK / OpenCode shapes (T109)

There is **no single page** a reader can open to answer "how do I mount the
toolbelt in *my* runtime?", and **custom runners have no documented recipe at
all** (the design doc §3 promises "anything that can call a Unix socket and
accept a JSON-Schema tool list gets the tools for free", but nothing shows how).
The root `README.md` "Supported runtimes" list and the design doc §3 describe the
options narratively but ship no copy-pasteable setup.

The gap is now closable: with **T206 landed (the M2-exit portability matrix)**,
the same canonical descriptor set is proven to work under ADK, OpenCode, and Pi,
and the Claude arm is proven by the M1 golden gate (T114). Every per-runtime
recipe now has a **verified** reference implementation behind a gated e2e arm.
T207's job is to consolidate those into **one copy-pasteable setup per runtime,
each cross-referenced to the test that verifies it**.

## Goals

- Deliver **one authoritative, copy-pasteable setup per runtime** —
  **ADK, Claude (Agent SDK + Claude Code/Desktop), OpenCode, Pi, and custom** —
  on a single discoverable page.
- For each runtime, the copy-paste block is **the recipe the verifying e2e arm
  actually drives** (the T206 portability matrix arms + the T114 golden arm +
  the T201/T202/T203/T205 acceptance arms), so the AC "verified against #28" is
  literally true, not aspirational.
- Include a per-runtime **"verify this works"** subsection that names the gated
  e2e file and the exact env flags to re-run the verification locally.
- State the **cross-cutting contract once** (the secret boundary, session
  mapping `one session ⇒ one MxSession ⇒ one room`, the result envelope, deferred
  results via `mx_await_result`, the closed error taxonomy, idempotency), and
  have each runtime section defer to it rather than re-explaining it.
- Establish the guide as a **hub that links the per-runtime READMEs as the
  canonical deep references** — minimal duplication, with the inlined blocks kept
  in lockstep with the verified examples by the existing config drift-guards.
- Add the missing **custom-runner recipe** (MCP-mount path + link-the-library
  path).
- Wire the guide into discovery: root `README.md` "Documentation" list and the
  design doc §3.

## Non-Goals

- **No new runtime binding, package, tool descriptor, envelope, or daemon-RPC
  change.** T207 is documentation only. The bindings already exist (T109/T110/
  T201–T206); the guide describes them.
- **Not a replacement for the per-runtime READMEs.** The deep treatment
  (env-backstop nuances, troubleshooting tables, ADK long-running internals, the
  Pi peer-dependency/injected-builder mechanics, the OpenCode scrubbed-launch
  rationale) stays in each README as the single source of truth; the guide links
  to it.
- **Not a publishing/packaging change.** The `mx-loom-mcp` standalone bin is
  published by **T602 (M6)**, not here. The guide documents today's reality (the
  `tsx` launcher) and flags the published-bin path as future.
- **No conceptual/architecture rewrite.** The architecture lives in
  `docs/mx-agent-tool-fabric-design.md`; the guide is task-oriented and links to
  it rather than restating it.
- **No new e2e coverage.** The verification arms already exist (T201–T206); the
  guide cites them. (A small *config drift-guard* extension to keep the guide's
  inlined blocks honest is in scope under Testing — see below.)
- Multi-tenant / remote-exposure hardening, billing, streaming — all out of
  scope per M5/M6 and design §9.

## Relevant Repository Context

**Stack.** TypeScript monorepo (pnpm workspaces, Node ≥ 20.19, vitest,
Apache-2.0). Python is used only in the ADK example (`examples/adk/`, deferred
imports so it runs daemon-free). The repo is **not docs-only**: M0/M1/M2 code is
landed.

**Packages that exist today** (all relevant to the guide):

| Package / dir | Role in the guide |
|---|---|
| `@mx-loom/registry` | The canonical 9-verb descriptor set every binding renders. |
| `@mx-loom/toolbelt` | Daemon transport + `openSession`/`MxSession` + the secret-boundary guards (`safeSubprocessEnv`, `assertNoCredentialShapedArgs`, `redactSecrets`). The "link the library directly" custom path. |
| `@mx-loom/mcp` | The generated **`mx-loom-mcp`** server (stdio + Streamable HTTP). The universal binding ADK / OpenCode / Claude Code / custom all mount. |
| `@mx-loom/claude` | The Claude Agent SDK **in-process** shim (`createMxToolServer` + `createMxCanUseTool`). |
| `@mx-loom/pi` | The Pi **native-tool** binding (`createPiToolDefinitions` / `registerMxTools`). |
| `@mx-loom/audit` | The opt-in Postgres mirror (only referenced for the audit-DSN caveat). |
| `@mx-loom/golden` | Test-only; holds the verifying e2e arms the guide cites. |
| `examples/adk/` | `mcp_toolset_agent.py` (T201), `long_running_tools.py` (T202), `README.md`, `requirements.txt`. |
| `examples/opencode/` | `opencode.local.example.json`, `opencode.remote.example.json`, `README.md` (T203). |

**Does not exist yet** (decisions to confirm, not assumptions):

- **`examples/custom/`** — no custom-runner example. The guide must add a
  custom-runner recipe; whether it also ships a runnable `examples/custom/`
  sample (vs. an inline snippet) is an open question (see Risks).
- **A consolidated guide page** (`docs/runtime-integration.md` or similar) — the
  primary deliverable; does not exist.
- **`examples/README.md`** — no index tying the example dirs together.
- **A published standalone `mx-loom-mcp` bin** — T602 (M6); today a `tsx`
  launcher is the verified path.

**The canonical 9 verbs** (what every runtime surfaces — the guide states this
once): `mx_find_agents`, `mx_describe_agent`, `mx_delegate_tool`,
`mx_run_command` (guarded, off by default), `mx_await_result`,
`mx_share_context`, `mx_get_context`, `mx_cancel`, `mx_workspace_status`.
**No** `trust.*` / `approval.decide` / `policy.*` / `auth.*` / `device.*` /
`daemon.*` is ever surfaced — they are structurally unreachable.

**The `mx-loom-mcp` CLI surface** the guide documents (from `packages/mcp`):
`--stdio` (default), `--http --host <h> --port <p>`, `--room <id>`,
`--kind <adk|opencode|…>`, `--correlation-id <id>`, `--cwd <path>`,
`--project-id <id>`, `--git-commit <sha>`, `--max-invocations <n>`, `--audit`
(or `MXL_AUDIT_PG=1`). All are **non-secret session config**, never model tool
args, never credentials.

**Conventions to follow:**

- Specs live in `specs/<tN-slug>.md` (this file). Example/READMEs use the
  `examples/<runtime>/README.md` layout.
- Example values are obviously-fake placeholders (`!workspace:server`,
  `<your-model>`, `adk_<session_id>`) — never realistic credentials.
- The secret-boundary rule is repeated prominently in every per-runtime doc;
  the guide keeps that discipline.
- Drift guards already pin example argv/env: `packages/mcp/test/cli-options.test.ts`
  (ADK Python deny-tuples == toolbelt constants) and
  `packages/mcp/test/opencode-config.test.ts` (parses the OpenCode examples,
  pins the argv seam + non-secret env allowlist + no credential-shaped key).

## Proposed Implementation

**Shape: a hub-and-spoke documentation page.** Add a single guide page that
gives the *one verified copy-pasteable setup per runtime* and links each to its
canonical README (the spoke) for depth. The guide is intentionally thin so it
cannot drift from the READMEs; the READMEs remain the single source of truth.

### Primary deliverable: `docs/runtime-integration.md`

Recommended structure:

1. **Title + one-paragraph framing.** The Boundary A / Boundary B picture in two
   sentences, a link to `docs/mx-agent-tool-fabric-design.md` §1/§3 for the full
   architecture. State the build rule: *one canonical descriptor set → every
   binding; never hand-author tools per runtime.*

2. **"Pick your runtime" table** — runtime → integration mechanism → canonical
   deep-reference link:

   | Runtime | Mechanism | Deep reference |
   |---|---|---|
   | Google ADK (Python) | `MCPToolset` over `mx-loom-mcp --stdio`; optional `LongRunningFunctionTool` | `examples/adk/README.md` |
   | Claude Agent SDK (TS) | in-process `createSdkMcpServer` + `tool()` + `canUseTool` | `packages/claude/README.md` |
   | Claude Code / Desktop | `mcpServers` entry → `mx-loom-mcp --stdio` | `packages/mcp/README.md` |
   | OpenCode | `opencode.json` `mcp` entry (local stdio / remote HTTP) | `examples/opencode/README.md` |
   | Pi | native tool registration (`@mx-loom/pi`, no MCP client) | `packages/pi/README.md` |
   | Custom | mount `mx-loom-mcp`, or link `@mx-loom/toolbelt` directly | this guide |

3. **Universal prerequisites (state once).**
   - A reachable mx-agent daemon (Boundary B; pinned `v0.2.1` — link
     `docs/mx-agent-pin.md`).
   - The **`mx-loom-mcp` launcher** for MCP-mounting runtimes. Document today's
     verified reality — a `tsx` launcher wrapping `packages/mcp/src/cli.ts` — and
     flag the published standalone bin as **T602 (future)**. Reuse the exact
     launcher snippet the ADK/OpenCode READMEs already document, and warn (as
     they do) not to point a runtime at `packages/mcp/dist/cli.js` directly in
     the source workspace.
   - The **session-mapping rule**: one runtime session ⇒ one `mx-loom-mcp`
     process / one `MxSession` ⇒ one workspace room. `--room` / `--correlation-id`
     are session config supplied by the host, **never** model tool arguments.

4. **The secret boundary (state once, prominently).** A single dedicated
   section, since it is the load-bearing cross-cutting rule and each runtime
   enforces it slightly differently:
   - Matrix tokens, Ed25519 signing keys, provider keys, and `GH_TOKEN` **never**
     cross Boundary A into the runtime process, the model context, or any child.
   - The deny-by-default env allowlist (`packages/toolbelt/src/cli/env.ts`:
     `BASE_ENV_ALLOW` + `isDeniedEnvKey`) is the canonical source of truth; ADK's
     `safe_mx_mcp_env()` mirrors it 1:1 (drift-guarded).
   - The per-runtime nuance, summarized with links: **ADK** passes an explicit
     `env=safe_mx_mcp_env()` (+ the `StdioServerParameters` env-backstop caveat);
     **OpenCode**'s `environment` field only *adds*, so the load-bearing control
     is launching OpenCode itself from a scrubbed env; **Claude in-process** and
     **Pi** start no child and read no env for daemon access — every call rides
     the toolbelt `MxClient`/`MxSession`, so the guards stay in force.
   - Configs/launch flags carry **only non-secret session config**; never put a
     credential-shaped value in `opencode.json`, a launcher, a prompt, or a log.
   - The **audit-DSN caveat**: `DATABASE_URL`/`PG*` is credential-shaped and
     therefore denied by default; audit is off unless deliberately forwarded.
   - **Out-of-process enforcement is authoritative**: trust (Ed25519 store),
     deny-by-default `policy.toml`, sandbox, and human approval gates all run on
     the receiving daemon. Cognition only produces a *signed request*; it never
     grants itself authority. There is **no** model-facing trust/policy/approval
     mutation tool; approval reaches the model **only** as the `awaiting_approval`
     result status, re-validated against live policy at release.

5. **One section per runtime**, each = (a) a single copy-pasteable block lifted
   from the verified example, (b) a one-line "this is what the model sees", and
   (c) a **"Verify it"** subsection naming the gated e2e file + env flags. The
   blocks (kept minimal, identical to the verified sources):

   - **Google ADK** — `mx_mcp_toolset(room=...)` on an `LlmAgent`
     (`examples/adk/mcp_toolset_agent.py`). One line on the optional
     `LongRunningFunctionTool` mode (`long_running_tools.py`) for approval-aware
     pending tickets → link the README §"Native long-running mode (T202)".
   - **Claude Agent SDK** — the `createBindingContext` + `createMxToolServer` +
     `createMxCanUseTool` + `query({ options: { mcpServers: { mx }, canUseTool }})`
     snippet from `packages/claude/README.md`, plus the namespaced-name note
     (`mxToolName('mx_delegate_tool')` → `mcp__mx__mx_delegate_tool`).
   - **Claude Code / Desktop** — the minimal `mcpServers` JSON from
     `packages/mcp/README.md`.
   - **OpenCode** — the `opencode.local.example.json` block + the one-line remote
     variant (`mx-loom-mcp --http` + a `type: "remote"` `url`), with the
     scrubbed-launch warning called out and linked.
   - **Pi** — the `createPiBindingContext` + `createPiToolDefinitions(ctx,
     { builders: { Type, StringEnum } })` + `createAgentSession({ customTools,
     noTools: 'builtin', tools: mxToolNames() })` recipe from
     `packages/pi/README.md`, with the peer-dependency + injected-builders note
     and the "no MCP client; native registration" rationale (link T204 decision).
   - **Custom runners** — *new content.* Two paths:
     1. **Speaks MCP** → point it at `mx-loom-mcp --stdio` (or `--http` on
        localhost) exactly like Claude Code; the tool list + envelope are
        identical.
     2. **Links the library** → depend on `@mx-loom/toolbelt` +
        `@mx-loom/registry`, `openSession(...)`, enumerate `CANONICAL_M1_TOOLS`,
        and dispatch via the registry handlers (reference `@mx-loom/mcp`'s
        `dispatchCall` as the pattern). State plainly that the custom path must
        honor the same seven-point contract (design §4) — most importantly the
        deferred-result `mx_await_result` semantics and the secret boundary.

6. **The common tool contract (state once).** A compact section the runtime
   sections defer to:
   - **The result envelope** (`{status, result, error, handle, approval,
     audit_ref}`), with the rule that `denied` is a *governance outcome* (replan),
     `running`/`awaiting_approval` are *not* failures (resolve via
     `mx_await_result(handle)`), and `error` is a genuine fault.
   - **The closed `error.code` taxonomy** (the nine codes) — copied once, not per
     runtime.
   - **Deferred results** — every runtime resolves via `mx_await_result`; ADK and
     Claude can hide the poll loop (LongRunningFunctionTool / hidden poll), the
     rest surface the handle.
   - **Idempotency** — supply an explicit `idempotency_key` to
     `mx_delegate_tool` / `mx_run_command` for safe mutating retries.

7. **Verifying your integration (#28 / T206).** A short section that ties the
   guide to the portability matrix: the same nine descriptors are proven
   cross-runtime by `packages/golden/test/portability-matrix.e2e.test.ts`
   (`MXL_PORTABILITY_MATRIX=1`), and each runtime's standalone acceptance arm is
   listed with its gate flag (see Testing Plan). This is the section that makes
   "verified against #28" auditable by a reader.

### Secondary deliverables (small, recommended)

- **`examples/README.md`** — a one-screen index of the example dirs that links
  back to the guide as the entry point and forward to `examples/adk/` and
  `examples/opencode/`.
- **Discovery wiring** — add the guide to the root `README.md` "Documentation"
  list and link it from `docs/mx-agent-tool-fabric-design.md` §3.

### Authoring discipline (to prevent drift)

- The guide's copy-paste blocks are **byte-identical to the verified sources**
  (the example files / README snippets the e2e arms drive). Where a block is
  inlined, add a short HTML comment pointing to the canonical source file so a
  later editor knows where the source of truth lives.
- Where the existing config guards already pin a block
  (`opencode-config.test.ts`, `cli-options.test.ts`), the guide should reuse the
  *same* example file content so those guards transitively protect the guide.

## Affected Files / Packages / Modules

**Create:**

- `docs/runtime-integration.md` — the guide (primary deliverable).
- `examples/README.md` — example index (secondary).
- *(open)* `examples/custom/` — only if the custom recipe ships a runnable
  sample rather than an inline snippet (decision — see Risks).

**Edit:**

- `README.md` (root) — add the guide to the "Documentation" list; optionally
  cross-link from "Supported runtimes".
- `docs/mx-agent-tool-fabric-design.md` — link §3 ("How each runtime consumes
  the tools") to the new guide.
- `docs/backlog.md` — check the T207 AC box and add a one-line landed-status note
  (handled by the implement/document phase; the orchestrator owns the commit).
- *(optional)* `packages/mcp/test/runtime-guide.test.ts` **or** an extension to
  the existing config guards — assert the guide's inlined OpenCode/ADK blocks
  match the verified example files (drift guard for the guide). See Testing.

**Read (sources to consolidate, not modify):**

- `examples/adk/README.md`, `examples/adk/mcp_toolset_agent.py`,
  `examples/adk/long_running_tools.py`
- `examples/opencode/README.md`, `opencode.local.example.json`,
  `opencode.remote.example.json`
- `packages/claude/README.md`, `packages/pi/README.md`, `packages/mcp/README.md`
- `packages/toolbelt/src/cli/env.ts` (the canonical env allowlist)
- `docs/pi-tool-surface-capability.md`, `docs/mx-agent-pin.md`,
  `scripts/conformance/README.md`
- `packages/golden/test/portability-matrix.e2e.test.ts` and the per-runtime
  acceptance arms (for the exact gate flags).

## API / Interface Changes

**None.** T207 is documentation. No CLI flag, public API, tool descriptor,
result envelope, or daemon-RPC surface changes. The guide *describes* the
already-shipped `mx-loom-mcp` CLI surface and the `@mx-loom/claude` /
`@mx-loom/pi` library surfaces; it does not add to them.

## Data Model / Protocol Changes

**None.** No envelope shape, error-taxonomy, tool schema, idempotency-key,
audit-row, or serialization change. The guide documents the existing T102
envelope and the closed nine-code error taxonomy verbatim.

## Security & Compliance Considerations

The guide is documentation, so the security work is **teaching the boundary
correctly and never modeling an insecure pattern**:

- **Secret boundary, stated once and prominently** (and reinforced in every
  recipe): Matrix tokens, Ed25519 signing keys, provider keys, and `GH_TOKEN`
  **never** cross Boundary A into the runtime process, the model context, or any
  runner child. The deny-by-default env allowlist
  (`packages/toolbelt/src/cli/env.ts`) is named as the source of truth; ADK's
  `safe_mx_mcp_env()` mirrors it; OpenCode requires a scrubbed launch because its
  `environment` field only adds. Runner children receive retrieved **TEXT** only,
  never credentials.
- **Secret-free contract**: no tool field carries a credential inbound or
  outbound; the guide must not show any recipe that passes a credential as a tool
  arg, and must state that credential-shaped args are rejected
  (`invalid_args`) and inbound daemon values are redacted.
- **No credential-shaped values anywhere in the guide or any new example** — only
  obviously-fake placeholders. The remote OpenCode example commits no
  `headers`/`oauth`; the guide repeats "never commit credentials to
  `opencode.json` / a launcher / a prompt / a log."
- **Audit-DSN caveat**: `DATABASE_URL`/`PG*` is credential-shaped → denied by
  default → audit off unless deliberately forwarded through a never-logged path.
- **Out-of-process enforcement is authoritative**: the guide must make clear that
  trust (Ed25519 store), deny-by-default `policy.toml`, sandbox, and human
  approval gates all run on the **receiving daemon**, not in the runtime. The
  toolbelt only translates; it cannot grant authority.
- **Cognition produces only a signed request**: the guide must never imply a
  runtime can self-grant authority. There is **no** model-facing
  trust/policy/approval mutation tool; only the nine verbs are surfaced;
  `trust.*` / `approval.decide` / `policy.*` / `auth.*` / `device.*` / `daemon.*`
  are structurally unreachable. Approval reaches the model **only** as the
  `awaiting_approval` result status, re-validated against live policy at release.
- **Remote-exposure warning** (OpenCode/custom HTTP): `mx-loom-mcp --http` binds
  `127.0.0.1` and adds no auth; non-local exposure is explicit operator opt-in
  behind an authenticated reverse proxy. The guide repeats this, does not soften
  it.
- **Audit correlation**: note that every result carries `audit_ref`; the guide
  must not suggest stripping it.
- **Logging/redaction**: the guide must instruct readers never to log secrets or
  tokens, and that `mx-loom-mcp` logs protocol to stdout and status to stderr
  (no secrets in either).
- **Do not imply unimplemented behavior**: the standalone published bin (T602),
  durable `task.watch` resumption (M3), streaming, and multi-tenant scoping (M5)
  must be flagged as future, not described as available.

## Testing Plan

Documentation-focused; the behavioral verification already exists and is *cited*,
not re-implemented.

- **Documentation / link tests.**
  - Markdown link-check across `docs/runtime-integration.md`, `examples/README.md`,
    and the cross-links added to the root README and the design doc (no dead
    relative links to package READMEs, example files, or e2e test paths).
  - A repo-relative path existence check for every file the guide references
    (e.g. `examples/adk/mcp_toolset_agent.py`, the e2e test files).
- **Secret-scan / redaction.** Confirm the guide and any new example contain **no
  credential-shaped strings** (the global gitleaks pre-commit hook + a targeted
  assertion that example values are placeholders). Watch for false positives on
  fixture-shaped placeholders (see the memory on the gitleaks ADW block —
  `.gitleaksignore` if needed).
- **Drift guard for inlined blocks (recommended).** Extend (or add alongside) the
  existing config guards so the guide's inlined OpenCode/ADK blocks are asserted
  equal to the verified example files:
  - reuse `packages/mcp/test/opencode-config.test.ts` coverage by having the
    guide embed the *same* `opencode.local.example.json` content;
  - optionally a new `packages/mcp/test/runtime-guide.test.ts` that parses the
    guide's fenced blocks and asserts every `--flag` is a recognized
    `mx-loom-mcp` option and no credential-shaped key/value appears.
- **Verification arms the guide cites (already exist — re-run to confirm the
  recipes still pass; do not duplicate):**
  - ADK MCPToolset — `packages/golden/test/adk.mcp-toolset.e2e.test.ts`
    (`MXL_ADK_MCP_E2E=1` + two-daemon fixture).
  - ADK long-running — `packages/golden/test/adk.long-running.e2e.test.ts`
    (`MXL_ADK_LONG_RUNNING_E2E=1` + golden policy).
  - OpenCode entry — `packages/golden/test/opencode.mcp-entry.e2e.test.ts`
    (`MXL_OPENCODE_MCP_E2E=1`).
  - Pi binding — `packages/golden/test/t205-pi-binding.e2e.test.ts`
    (`MXL_PI_BINDING_E2E=1`).
  - Claude — exercised by the M1 golden arm in `@mx-loom/golden` (T114).
  - Cross-runtime — `packages/golden/test/portability-matrix.e2e.test.ts`
    (`MXL_PORTABILITY_MATRIX=1`).
- **No new envelope / error-taxonomy / idempotency / integration / unit tests**
  are introduced by T207 beyond the doc/drift guards above — the behavior is
  unchanged.

## Documentation Updates

- **New:** `docs/runtime-integration.md` (the guide) — primary deliverable.
- **New (secondary):** `examples/README.md` index.
- **`README.md` (root):** add the guide to the "Documentation" list; optionally
  cross-link the "Supported runtimes (planned)" entries to the guide's sections.
- **`docs/mx-agent-tool-fabric-design.md`:** link §3 to the guide as the
  hands-on companion to the narrative.
- **`docs/backlog.md`:** tick the T207 AC and add the landed-status note (done by
  the implement/document phase, committed by the orchestrator).
- The per-runtime READMEs (`examples/adk`, `examples/opencode`, `packages/claude`,
  `packages/pi`, `packages/mcp`) **stay canonical**; add a single back-link from
  each to the guide if low-cost, but do not migrate their content into the guide.

## Risks and Open Questions

1. **Guide location / name.** Recommended: `docs/runtime-integration.md`.
   Alternatives: `docs/integration-guide.md`, or an `examples/README.md`-first
   layout. *Decision to confirm* — defaulting to `docs/runtime-integration.md`
   (lives next to the design doc, discoverable from the root README "Documentation"
   list).
2. **Custom-runner deliverable shape.** Inline snippet in the guide (lower scope,
   matches the **S** estimate) **vs.** a runnable `examples/custom/` sample
   (higher fidelity, more to maintain, no verifying e2e exists for it). *Decision
   to confirm* — recommend inline snippet for T207; a runnable
   `examples/custom/` + its own gated arm could be a follow-up.
3. **Hub-vs-duplicate.** Recommended hub-and-spoke (thin guide + canonical
   READMEs) to avoid drift, accepting that a reader clicks through for depth. The
   alternative (self-contained guide) duplicates content that *will* drift. *Lean
   hub-and-spoke* unless reviewers prefer a single self-contained page.
4. **Published-bin timing.** The verified launcher is a `tsx` wrapper because the
   standalone `mx-loom-mcp` bin is **T602 (M6)**. The guide documents today's
   reality and flags the bin as future — it must not imply the published bin
   exists. Confirm T602 is still the owner so the future-pointer is accurate.
5. **"Verified against #28" interpretation.** Read as: each copy-paste recipe is
   the one the corresponding gated e2e arm drives, and the guide cites that arm so
   a reader can reproduce the verification. If the AC instead intends a *new*
   automated test that runs every guide snippet end-to-end in one job, that is a
   larger effort than the **S** estimate and should be re-scoped. *Recommend the
   citation interpretation.*
6. **Drift-guard scope.** Whether to add a dedicated `runtime-guide.test.ts` or
   rely on the existing example-file guards by embedding identical content.
   *Recommend* embedding identical content (zero new test surface) and adding a
   guard only if reviewers want the guide's fences independently pinned.
7. **Claude has two verified surfaces** (in-process shim + external `mcpServers`)
   and ADK has two modes (generic / long-running). The guide must present one
   *default* copy-paste per runtime and link the alternate, to honor "one
   copy-pasteable setup per runtime" without hiding the better mode. *Recommend*:
   ADK default = generic `MCPToolset`; Claude default = in-process shim — each
   with a one-line pointer to the alternate.

## Implementation Checklist

1. **Read the sources** to be consolidated: the five per-runtime READMEs, the two
   example dirs, `packages/toolbelt/src/cli/env.ts`, `docs/mx-agent-pin.md`,
   `docs/pi-tool-surface-capability.md`, and the gated e2e arms in
   `packages/golden/test/` (for exact file paths + env flags).
2. **Confirm the open questions** (guide location, custom-runner shape, the
   "verified against #28" interpretation) — default to the recommendations above
   if no reviewer steer.
3. **Write `docs/runtime-integration.md`** following the structure in *Proposed
   Implementation*: framing → pick-your-runtime table → universal prerequisites →
   the secret boundary → one verified copy-paste block per runtime (ADK, Claude
   SDK, Claude Code/Desktop, OpenCode, Pi, custom), each with a "Verify it"
   subsection → the common tool contract (envelope, error taxonomy, deferred
   results, idempotency) → "Verifying your integration (#28 / T206)".
4. **Lift each copy-paste block verbatim from its verified source** (example
   files / README snippets the e2e arms drive); add an HTML comment pointing at
   the source-of-truth file. Use only placeholder values.
5. **Add the custom-runner recipe** (MCP-mount path + link-the-library path),
   pointing at the seven-point contract in design §4 and the `mx_await_result`
   semantics.
6. **Write `examples/README.md`** as a thin index linking the guide and the
   example dirs.
7. **Wire discovery:** add the guide to the root `README.md` "Documentation"
   list; link it from `docs/mx-agent-tool-fabric-design.md` §3; add low-cost
   back-links from the per-runtime READMEs.
8. **(Recommended) Lock the inlined config blocks** by embedding the *same*
   content the existing guards pin (`opencode.local.example.json`, the ADK argv),
   or add `packages/mcp/test/runtime-guide.test.ts` if independent pinning is
   wanted.
9. **Run the doc checks:** markdown link-check, referenced-path existence,
   secret-scan (gitleaks; `.gitleaksignore` only if a placeholder false-positives).
10. **Re-run (or confirm green) the cited verification arms** for at least one
    runtime to prove a copy-paste block still works end-to-end:
    `MXL_PORTABILITY_MATRIX=1 pnpm --filter @mx-loom/golden exec vitest run
    --config vitest.e2e.config.ts test/portability-matrix.e2e.test.ts` (with the
    two-daemon fixture + per-runtime opt-ins), and/or a single per-runtime arm.
11. **Tick the T207 AC** in `docs/backlog.md` with a landed-status note
    (orchestrator commits). Confirm nothing in the guide implies unimplemented
    behavior (published bin, `task.watch`, streaming, multi-tenant).
