# ADK MCPToolset Integration (T201 / #23)

> Implementation specification for GitHub issue **#23 — T201 · binding: ADK `MCPToolset` integration**.
> Labels: `area/adk` · `priority/P0` · `type/feature`. Milestone **M2 — Universal binding**. Estimate **M**.
> Dependency: **blocked-by #17 / T109** (`@mx-loom/mcp`, the generated MCP server). In this checkout T109 appears landed (`packages/mcp` exists), but a later coding agent must still verify the dependency is present and green before implementing T201.
> Sources read: [`docs/mx-agent-tool-fabric-design.md`](../docs/mx-agent-tool-fabric-design.md), [`docs/backlog.md`](../docs/backlog.md) (`T201`, M2, and T109/T202/T206 context), [`docs/mx-agent-surface-v0.2.1.md`](../docs/mx-agent-surface-v0.2.1.md), and the existing source tree for the affected area (`packages/mcp`, `packages/toolbelt`, `packages/registry`, `packages/golden`). The issue context was supplied inline; no GitHub access is required.

## Problem Statement

Google ADK users need to mount the mx-loom toolbelt MCP server on an ADK `LlmAgent` so the agent can discover and call the canonical `mx_*` coordination tools through ADK's `MCPToolset` interface:

```python
LlmAgent(..., tools=[MCPToolset(...)])
```

The universal MCP server exists as the intended runtime-agnostic surface (`@mx-loom/mcp` / T109), and its README already contains a minimal ADK snippet. The current gap is that there is no tested, documented ADK binding path that proves an ADK agent can:

- start or connect to `mx-loom-mcp` safely;
- list the canonical `mx_*` tools via ADK's `MCPToolset`;
- call at least one `mx_*` tool and receive the normalized T102 result envelope;
- map an ADK session/conversation to a single mx-loom `MxSession`/workspace room without putting room IDs, credentials, policy, trust, or approval authority into model-visible tool arguments; and
- preserve the secret boundary when ADK spawns the MCP server as a child process.

Without T201, M2's ADK arm remains an unverified README recipe. Users may hand-wire the MCP server incorrectly, accidentally inherit provider tokens into the MCP child process, omit the workspace room so room-scoped tools fail, or misinterpret `running` / `awaiting_approval` envelopes as failures instead of deferred states to resolve with `mx_await_result`.

## Goals

- Provide a **copy-pasteable ADK `LlmAgent` integration** using `tools=[MCPToolset(...)]` against the existing `mx-loom-mcp` stdio transport.
- Prove the issue acceptance criterion: **an ADK agent lists and calls `mx_*` tools via MCP**.
- Define and document the **ADK session / `ToolContext` mapping**:
  - one ADK agent/session instance maps to one `mx-loom-mcp` process, which maps to one `MxSession` registration;
  - the workspace room and other session metadata are supplied by the host application/session context, never by model tool args;
  - a session-stable `correlation_id` is used when available so audit rows can correlate ADK session activity with daemon invocations;
  - `ToolContext` may store/read non-secret session configuration and deferred handles for host UI continuity, but it must not carry secrets or authority decisions.
- Add minimal MCP CLI/session configuration needed by ADK if the existing `mx-loom-mcp` flags are insufficient, especially a safe way to pass a correlation id and workspace metadata.
- Document the ADK integration path in repo docs/examples and keep it aligned with `@mx-loom/mcp`'s actual public API.
- Keep T201 limited to **generic MCPToolset wiring**. Approval-aware long-running behavior belongs to T202.
- Preserve the existing contract and security model: no hand-authored ADK tool schemas, no ADK-only tool names, no trust/policy/approval mutation tools, no credential-bearing tool fields, no daemon authority in the runtime.

## Non-Goals

- **Do not implement the requested feature in this spec phase.** This document is planning only.
- **No ADK `LongRunningFunctionTool` approval shim.** T201 may surface `awaiting_approval` / `running` envelopes over MCP and document `mx_await_result`; T202 owns wrapping `mx_delegate_tool` / `mx_run_command` as ADK long-running tools that produce pending tickets and resume on approval.
- **No new model-facing tools and no registry descriptor changes.** ADK must consume the canonical registry through `@mx-loom/mcp`; it must not hand-author or fork the `mx_*` descriptors.
- **No daemon RPC or policy implementation.** Trust, policy, sandbox, approval, signing, Matrix transport, and audit truth remain on mx-agent daemons.
- **No trust/policy/approval mutation surface.** `trust.*`, `approval.decide`, `policy.*`, `auth.*`, `device.*`, `daemon.*`, and related operator functions must not appear in ADK tools.
- **No real-provider model test requirement.** T201 should be testable with a deterministic or direct toolset invocation path. A live model arm may be optional, but provider keys must not be required for the gate.
- **No OpenCode or Pi integration.** OpenCode is T203; Pi native registration is T205.
- **No multi-tenant/RLS work.** Tenant=room isolation and RLS are M5.
- **No public Python package unless maintainers explicitly decide to add one.** Prefer examples/docs and conformance fixtures for T201; avoid inventing an unsupported `mx_loom_adk` package if a small ADK recipe plus tests is sufficient.

## Relevant Repository Context

**Stack and repository status.** The stack is TypeScript, ESM, pnpm workspaces, Node `>=20.19`, vitest, Apache-2.0. The prompt notes that the repo may be docs-only, but this checkout is **not docs-only** for M0/M1: it contains implemented packages under `packages/`. The ADK-specific package/module does **not** exist today; that absence should be treated as the T201 gap, not as evidence that the lower layers are missing.

Existing relevant packages/modules:

- `packages/registry` (`@mx-loom/registry`): canonical transport-neutral descriptor set and handlers for the M1 model-facing verbs. It defines the normalized T102 result envelope:
  - `status: ok | running | awaiting_approval | denied | error`;
  - `result`, `error`, `handle`, `approval`, and always-present `audit_ref`;
  - closed error taxonomy: `policy_denied`, `untrusted_key`, `approval_denied`, `approval_expired`, `timeout`, `not_found`, `invalid_args`, `target_offline`, `internal`;
  - `idempotency_key` support on mutating tools.
- `packages/toolbelt` (`@mx-loom/toolbelt`): Boundary-B daemon client and session layer. `openSession()` registers an agent, starts heartbeat, and exposes `MxSession.call()`. The toolbelt includes the credential-shaped-arg guard and inbound redaction. `MxSessionOptions` already supports `room`, `kind`, `workspace` (`{ cwd, project_id, git_commit }`), `maxInvocations`, `correlationId`, and heartbeat options at the library layer (verified in `src/session.ts`). Note: `buildRegisterParams()` flattens `workspace` into flat top-level params (`cwd`/`project_id`/`git_commit`) for v0.2.1, so any new MCP CLI workspace flags pass through `MxSessionOptions.workspace`, not raw register params.
  - **Canonical secret-boundary primitives live here and are the single source of truth a coding agent must reuse, not re-derive:** `src/guards.ts` (`assertNoCredentialShapedArgs`, `CREDENTIAL_KEY_RE`) rejects credential-shaped args on every outbound call; `src/cli/env.ts` defines the deny-by-default subprocess env allowlist — `BASE_ENV_ALLOW = [HOME, PATH, XDG_RUNTIME_DIR, XDG_DATA_HOME, TMPDIR, LANG, LC_ALL, TERM]`, deny **prefixes** `MATRIX_` / `MX_AGENT_`, deny **suffixes** `_TOKEN` / `_API_KEY` / `_SECRET` / `_ACCESS_KEY`, deny **exact** `GH_TOKEN`, and `safeSubprocessEnv()` / `isDeniedEnvKey()`. The ADK example's safe-env helper must mirror this exact rule set (see Proposed Implementation §3), because divergence is a latent secret leak.
- `packages/mcp` (`@mx-loom/mcp`): generated MCP server from the canonical registry (T109 / #17). Important modules:
  - `src/tools.ts`: enumerates `CANONICAL_M1_TOOLS` into MCP `tools/list`, passing descriptor input schemas through verbatim and advertising the T102 envelope schema as `outputSchema`.
  - `src/dispatch.ts`: central name-to-handler dispatch table; room comes from `BindingContext`, never model args.
  - `src/context.ts`: `createBindingContext()` opens or binds an `MxSession`; exposes `room`, `correlationId`, and `auditSink` to dispatch.
  - `src/server.ts`: low-level MCP server with generated list and call handlers; applies the `withAudit` tap once at the result-return chokepoint.
  - `src/serialize.ts`: maps the full T102 envelope into MCP `CallToolResult.structuredContent` and JSON text; `isError` is true only for `status: "error"`.
  - `src/cli.ts`: `mx-loom-mcp` bin supports `--stdio` (default), `--http`, `--host`, `--port`, `--room`, `--kind`, and `--audit`/`MXL_AUDIT_PG`.
- `packages/golden` (`@mx-loom/golden`): binding-agnostic S1-S8 golden scenario for MCP and Claude. It is the right place to add an optional ADK arm or a smaller ADK smoke once T201 lands, while leaving T206 to run the full M2 portability matrix.
- `docs/mx-agent-tool-fabric-design.md`: defines the cognition/coordination boundary, the MCP/ADK strategy, the tool contract, the result envelope, deferred-result semantics, and the security/trust/approval model.
- `docs/backlog.md`: places T201 in M2, blocked by T109; T202 follows with ADK `LongRunningFunctionTool`; T206 is the M2 portability gate.
- `docs/mx-agent-surface-v0.2.1.md`: pins the daemon surface and confirms `agent.register`, `agent.list`, `agent.tools`, and `workspace.status`; `call.start`/`exec.start`/`invocation.*` remain staged behind two-daemon conformance.

ADK-specific current status:

- There is **no** `packages/adk`, `examples/adk`, Python test fixture, ADK conformance job, or ADK-specific session helper in the repository today.
- The only ADK content found is a minimal README snippet in `packages/mcp/README.md` and design/backlog references.
- Google ADK is not installed in this environment (`import google.adk` fails), so a coding agent must verify exact ADK import paths and APIs before committing tests or examples.

Conventions and constraints to preserve:

- One canonical descriptor set feeds all bindings. ADK must consume `@mx-loom/mcp`; it must not duplicate schema definitions.
- The default local MCP transport for ADK should be **stdio** (`mx-loom-mcp --stdio`), not unauthenticated remote HTTP.
- If HTTP is documented for ADK at all, it must remain localhost-bound by default and require an authenticated proxy before non-local exposure.
- The room/workspace scope is session configuration. The model must never be asked to provide a Matrix room id as a tool argument.
- `awaiting_approval` is a non-error result status. T201 must not add any way for the model to approve or deny its own request.

## Proposed Implementation

### 1. Verify the Google ADK API surface first

Before writing integration code, run a small local spike against the intended `google-adk` version and record the verified import paths in comments/docs/tests. Confirm at least:

- `LlmAgent` import path;
- `MCPToolset` import path;
- `StdioServerParameters` import path and whether it accepts an `env` mapping;
- whether `MCPToolset` exposes a direct list/call API for tests or must be exercised through an ADK `Runner`;
- whether ADK preserves MCP `structuredContent` or only surfaces text content to the model/tool result; and
- how `ToolContext` state is available at agent construction time versus per tool call.

The examples in this spec use the import shape already present in `packages/mcp/README.md`, but the coding agent must treat it as a hypothesis until verified:

```python
from google.adk.agents import LlmAgent
from google.adk.tools.mcp_tool import MCPToolset, StdioServerParameters
```

If ADK's actual imports differ, update the examples and docs to the verified names and add a note to the implementation PR/commit.

### 2. Prefer a lightweight ADK example/fixture over a new runtime package

T201's core integration is configuration of an existing MCP server, not a new TypeScript runtime shim. The recommended implementation is:

- add `examples/adk/README.md` with setup and safety notes;
- add `examples/adk/mcp_toolset_agent.py` (or similar) showing a minimal `LlmAgent` factory;
- add optional Python smoke fixtures under `packages/golden/test/adk/` or `examples/adk/test/` if the test runner can invoke them cleanly;
- update `packages/mcp/README.md` so the existing ADK snippet points to the full example and includes safe env/session handling.

Do **not** create `@mx-loom/adk` unless maintainers decide a stable reusable package is needed. A TypeScript `@mx-loom/adk` package would be awkward because Google ADK is Python; a premature package risks implying a supported public API that is just a recipe.

### 3. Provide a safe ADK `MCPToolset` factory in the example

The example should expose a small Python factory function that the host ADK app can call when constructing its agent. The factory should:

- build `StdioServerParameters` for `mx-loom-mcp --stdio`;
- pass `--room <room>` and `--kind adk`;
- pass an optional `--correlation-id <id>` once the MCP CLI supports it;
- pass optional workspace metadata (`--cwd`, `--project-id`, `--git-commit`) if added to the CLI;
- supply an explicit **safe child environment** to ADK's stdio spawn API, rather than inheriting the full ADK/model-provider environment;
- return an `MCPToolset` ready for `tools=[...]`.

Illustrative target shape (adjust to verified ADK names):

```python
import os
from google.adk.agents import LlmAgent
from google.adk.tools.mcp_tool import MCPToolset, StdioServerParameters

# This helper MUST mirror the canonical toolbelt rule set in
# packages/toolbelt/src/cli/env.ts (BASE_ENV_ALLOW + isDeniedEnvKey). Keep them in
# lockstep — a divergent Python list is a latent secret leak. Mirrored 1:1 below.
_DENY_ENV_PREFIXES = ("MATRIX_", "MX_AGENT_")             # whole secret namespaces
_DENY_ENV_SUFFIXES = ("_TOKEN", "_API_KEY", "_SECRET", "_ACCESS_KEY")
_DENY_ENV_EXACT = {"GH_TOKEN"}
_ALLOW_ENV = {
    "HOME",
    "PATH",
    "XDG_RUNTIME_DIR",      # daemon socket resolution (Linux)
    "XDG_DATA_HOME",        # on-disk daemon state / CLI-fallback discovery
    "TMPDIR",               # daemon socket resolution (macOS)
    "LANG",
    "LC_ALL",
    "TERM",
    "MXL_AGENT_BIN",        # optional non-secret mx-agent binary override
    "MXL_AUDIT_PG",         # optional audit toggle (the DSN is handled separately)
}

def _is_denied_env_key(key: str) -> bool:
    upper = key.upper()
    if any(upper.startswith(p) for p in _DENY_ENV_PREFIXES):
        return True
    if upper in _DENY_ENV_EXACT:
        return True
    return any(upper.endswith(s) for s in _DENY_ENV_SUFFIXES)

def safe_mx_mcp_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    # Deny-by-default: start empty, copy only allowlisted, non-denied keys.
    env = {k: v for k, v in os.environ.items() if k in _ALLOW_ENV and not _is_denied_env_key(k)}
    if extra:
        for k, v in extra.items():
            if _is_denied_env_key(k):
                raise ValueError(f"refusing to pass secret-shaped env var to mx-loom-mcp: {k}")
            env[k] = v
    return env

def mx_mcp_toolset(room: str, correlation_id: str | None = None) -> MCPToolset:
    args = ["--stdio", "--room", room, "--kind", "adk"]
    if correlation_id:
        args += ["--correlation-id", correlation_id]
    return MCPToolset(
        connection_params=StdioServerParameters(
            command="mx-loom-mcp",
            args=args,
            env=safe_mx_mcp_env(),
        )
    )

def build_agent(room: str, session_id: str) -> LlmAgent:
    return LlmAgent(
        name="mx_adk_agent",
        model="<configured-by-host>",
        instruction=(
            "Use mx_* tools for MX-Agent coordination. "
            "If a tool returns status=running or status=awaiting_approval, "
            "continue useful work and later call mx_await_result with the handle. "
            "Never ask for or include credentials in tool arguments."
        ),
        tools=[mx_mcp_toolset(room=room, correlation_id=f"adk_{session_id}")],
    )
```

The example must clearly state that the host application owns model/provider configuration and must not pass provider keys to the MCP child process.

**`mx-loom-mcp` discoverability.** `mx-loom-mcp` is a Node `bin` from the pnpm workspace; it is not on a fresh `PATH` by default. The example/docs must show a resolvable command: a globally installed/linked `mx-loom-mcp`, an absolute path to the built `dist` entry, or `pnpm exec mx-loom-mcp` from the workspace. State this explicitly so the spawn does not fail with `ENOENT`.

**Audit DSN caveat.** `MXL_AUDIT_PG=1` only *toggles* the Postgres mirror; the connection string is read by the `mx-loom-mcp` process from `DATABASE_URL` / `PG*`. `DATABASE_URL` can embed a password, so it is credential-shaped: it is denied by `safe_mx_mcp_env` above (so audit is **off by default** for the ADK child — the best-effort tap degrades silently), and a host that wants audit must forward the DSN **deliberately** via a dedicated, never-logged path. A Postgres DSN is an app-store/index credential, not one of the enumerated Boundary-A secrets (Matrix tokens, Ed25519 keys, provider keys, `GH_TOKEN`), but it must still never be logged.

**`StdioServerParameters` env-support backstop (secret-boundary critical).** The safe env above only holds if ADK's stdio spawn API actually applies a caller-supplied `env`. If the verified ADK version does **not** accept an `env` mapping (or inherits the parent env regardless), the secret boundary cannot rely on it. The required fallback is to **pre-sanitize before spawn**: either (a) wrap `mx-loom-mcp` in a tiny launcher that clears the env and re-exports only the allowlist, set as the `command`, or (b) ensure the ADK host process itself never holds Boundary-A secrets in its own environment when it constructs the toolset. Do not ship the example depending on an unverified ADK `env` feature.

### 4. Extend `mx-loom-mcp` CLI session flags only if needed

`MxSessionOptions` already supports metadata that ADK needs, but `packages/mcp/src/cli.ts` currently exposes only `--room` and `--kind` among session options. For robust ADK session mapping, add narrowly-scoped CLI flags to bridge existing library options:

- `--correlation-id <id>` → `openSession({ correlationId })`;
- `--cwd <path>` → `openSession({ workspace: { cwd } })`;
- `--project-id <id>` → `openSession({ workspace: { project_id } })`;
- `--git-commit <sha>` → `openSession({ workspace: { git_commit } })`;
- optionally `--max-invocations <n>` if ADK hosts need to declare concurrency.

These flags should be non-secret session metadata only. Do not add flags for Matrix credentials, signing keys, provider keys, `GH_TOKEN`, trust stores, policy paths, approval decisions, or raw daemon authority operations.

If maintainers decide that `--room` and auto-generated correlation are sufficient for T201, document that decision and defer the extra flags. However, the spec recommends at least `--correlation-id` so `ToolContext`/ADK session IDs can be correlated with audit rows without relying on process-local randomness.

Implementation details for CLI changes:

- keep defaults backward-compatible;
- parse and validate `--max-invocations` as a positive integer if added;
- pass only defined values into `createBindingContext({ sessionOptions: ... })`;
- do not log the full option object or environment;
- add unit tests for parsing and session-option projection;
- keep stdout reserved for MCP protocol bytes in stdio mode; diagnostics go to stderr and remain secret-free.

### 5. Define ADK session / `ToolContext` mapping

T201 should document a clear mapping even if the basic MCPToolset API does not expose per-call `ToolContext` metadata to the MCP server:

- **ADK application/session**: the host app creates an ADK session or agent instance for one workspace room.
- **ADK `ToolContext` state**: stores non-secret values such as `mx_room`, `mx_correlation_id`, and possibly the last observed deferred `handle` for UI/resume convenience. It must not store credentials, approval decisions, trust mutations, policy content, or raw Matrix identities for model use.
- **`MCPToolset` construction**: the host reads `ToolContext`/session config before constructing the `LlmAgent` or toolset and starts `mx-loom-mcp` with `--room` and `--correlation-id`.
- **`mx-loom-mcp` process**: opens one `MxSession`; `createBindingContext()` supplies `room` and `correlationId` to every dispatch.
- **Tool calls**: model-visible args contain only each canonical descriptor's input fields. Room and correlation stay outside model args.
- **Deferred results**: for T201, `running` / `awaiting_approval` are returned as ordinary MCP results and resolved by a later `mx_await_result(handle)` call. If the host wants to remember handles in `ToolContext`, it may do so as non-secret state. T202 will define ADK-native pending tickets and resume semantics.

If ADK's `MCPToolset` creates one server process per agent rather than per session, the host must build one agent/toolset per workspace session or use a host-side factory that scopes the toolset correctly. Do not share one MCP process across unrelated rooms unless and until M5 tenant scoping supports it explicitly.

### 6. Make list/call behavior explicit for ADK

Document the exact expected behavior ADK users and tests should assert:

- `MCPToolset` lists the nine canonical tools: `mx_find_agents`, `mx_describe_agent`, `mx_delegate_tool`, `mx_run_command`, `mx_await_result`, `mx_share_context`, `mx_get_context`, `mx_cancel`, `mx_workspace_status`.
- The listed input schemas are the same schemas produced by `@mx-loom/mcp` from the registry. ADK-specific code must not rewrite them.
- The result of a call is the full T102 envelope. Prefer `structuredContent` if ADK exposes it; otherwise parse the JSON text content that `serializeToolResult()` already emits.
- `status: "denied"` is not a protocol/tool exception; it is a governance outcome.
- `status: "awaiting_approval"` / `"running"` is not a failure. The response should contain a `handle`, and the agent should later call `mx_await_result`.
- `audit_ref` must be present on every envelope, even if inner ids are `null` for local reads.

For the acceptance call path, use the least policy-dependent smoke possible first:

1. call `mx_find_agents` or `mx_workspace_status` to prove `tools/call` works without a two-daemon target;
2. in the live two-daemon fixture, call `mx_delegate_tool` against the golden allowlisted tool to prove a real remote `mx_*` call via ADK.

### 7. Testing implementation shape

Add two layers of tests:

1. **Daemon-free ADK API smoke (optional dependency):**
   - gated by an env var such as `MXL_ADK_SMOKE=1` or skipped cleanly when `google-adk` is not installed;
   - uses a small fixture MCP server command with a fake daemon or in-memory dispatch so no Matrix daemon or model provider is required;
   - verifies ADK can list `mx_*` tools through `MCPToolset` and call a harmless read tool, receiving a T102 envelope;
   - fails, not skips, when the env var is set but ADK is missing or the API drifted.

2. **Live two-daemon ADK e2e (T201 acceptance):**
   - gated by `MXL_CONFORMANCE_TWO_DAEMON=1` and the existing golden fixture variables;
   - starts `mx-loom-mcp --stdio --room <room> --kind adk` through ADK `MCPToolset`;
   - lists tools and asserts the canonical names;
   - calls `mx_find_agents` or `mx_describe_agent`;
   - calls `mx_delegate_tool` using the golden fixture's allowlisted tool and a fresh `idempotency_key`;
   - asserts a terminal `ok` envelope with `audit_ref` present;
   - keeps approval-gated long-running behavior out of scope except for verifying that `awaiting_approval` is surfaced as a normal envelope if encountered.

Prefer adding the live ADK e2e under `packages/golden/test/golden.adk.e2e.test.ts` plus a Python helper script, because the golden package already owns binding-level e2e fixtures and fail-not-skip gate logic. T206 can later extend this into the full M2 portability matrix.

## Affected Files / Packages / Modules

Likely files to read or modify during implementation:

- `packages/mcp/src/cli.ts`
  - possibly add `--correlation-id`, workspace metadata, and max-invocation flags;
  - ensure stdio logs remain stderr-only and secret-free.
- `packages/mcp/src/context.ts`
  - no behavior change expected if CLI can already pass through `MxSessionOptions`; verify `createBindingContext()` handles new options correctly.
- `packages/toolbelt/src/cli/env.ts` (read-only reference; do not fork)
  - the canonical deny-by-default env allowlist (`BASE_ENV_ALLOW`, `isDeniedEnvKey`, `safeSubprocessEnv`) the ADK example's safe-env helper must mirror exactly.
- `packages/toolbelt/src/guards.ts` (read-only reference)
  - `assertNoCredentialShapedArgs` / `CREDENTIAL_KEY_RE` — the outbound credential-shaped-arg rejection already enforced under every `mx_*` call; ADK code must not bypass it.
- `packages/mcp/README.md`
  - expand the ADK section from minimal snippet to safe session/env guidance and link to examples.
- `packages/mcp/test/*`
  - add/adjust CLI option parsing/session projection tests if flags are added;
  - add documentation or snapshot tests only if useful.
- `examples/adk/README.md` (new)
  - setup, dependency/version pin, safe env, session mapping, local stdio and optional HTTP notes.
- `examples/adk/mcp_toolset_agent.py` (new)
  - minimal ADK `LlmAgent` factory using `MCPToolset`.
- `examples/adk/requirements.txt` or `requirements-adk.txt` (new, optional)
  - pin the verified ADK package/version for smoke tests/examples if maintainers want a reproducible Python fixture.
- `packages/golden/test/golden.adk.e2e.test.ts` (new, optional but recommended)
  - TypeScript vitest wrapper that invokes a Python ADK smoke/e2e script under the existing conformance gates.
- `packages/golden/test/adk_mcp_smoke.py` or `packages/golden/test/adk_mcp_e2e.py` (new, optional)
  - Python script that constructs the ADK agent/toolset and performs list/call checks.
- `.github/workflows/conformance.yml`
  - add an optional ADK job only when ADK dependency installation is acceptable; keep default CI skip-clean and fail-not-skip when explicitly requested.
- `docs/mx-agent-tool-fabric-design.md`
  - update the ADK bullet after T201 lands with the verified `MCPToolset` wiring and any session-mapping caveats.
- `docs/backlog.md`
  - mark T201 status/acceptance after implementation lands, and preserve T202 as the long-running approval follow-up.

Modules that **do not exist today** and should not be assumed:

- no `packages/adk` workspace package;
- no Python `mx_loom_adk` package;
- no ADK golden/e2e arm;
- no ADK-specific native tool wrappers;
- no ADK `LongRunningFunctionTool` shim (T202).

## API / Interface Changes

Expected public-facing changes:

- **ADK integration recipe**: documented Python usage of `MCPToolset` + `StdioServerParameters` with `mx-loom-mcp --stdio`.
- **Potential new `mx-loom-mcp` CLI flags** (recommended if session mapping requires them):
  - `--correlation-id <id>`: optional non-secret session correlation id;
  - `--cwd <path>`: optional workspace cwd for `agent.register`;
  - `--project-id <id>`: optional workspace project id;
  - `--git-commit <sha>`: optional workspace git commit;
  - `--max-invocations <n>`: optional concurrency declaration.
- **No new MCP tool names.** ADK lists the same canonical `mx_*` names generated by `@mx-loom/mcp`.
- **No new result-envelope API.** `CallToolResult.structuredContent` remains the full T102 envelope; JSON text fallback remains unchanged.
- **No daemon RPC changes.** All calls still route through existing handlers and daemon methods.
- **No trust/policy/approval public API.** Operator authority surfaces remain absent from model-facing tools.

If the coding agent verifies that existing `--room`/`--kind` and generated correlation ids are sufficient for T201, then the CLI additions can be deferred and this section should be updated in the implementation notes to state: **none beyond documentation/examples**.

## Data Model / Protocol Changes

Expected protocol changes: **none**.

- The MCP `tools/list` protocol remains generated by `packages/mcp/src/tools.ts` from canonical descriptors.
- The MCP `tools/call` result remains the T102 envelope serialized by `packages/mcp/src/serialize.ts`:
  - `structuredContent` contains `{ status, result, error, handle, approval, audit_ref }`;
  - text content contains the same envelope as JSON;
  - `isError` is true only for `status: "error"`.
- The result-envelope shape, error taxonomy, idempotency semantics, and audit ref structure do not change.
- Mutating ADK-driven calls should supply an `idempotency_key` in examples/tests when retrying at the scenario level. Transport-level retries inside `MxClient` already reuse params; ADK/model-level repeated calls without an idempotency key may be distinct user actions.
- No new tool input/output schemas are added.
- No new daemon serialization, audit-row schema, or Matrix event schema is introduced.

Potential data passed as non-secret session metadata only (if CLI flags are added): `correlation_id`, `cwd`, `project_id`, `git_commit`, and `max_invocations`. These are session registration inputs, not model tool arguments and not credentials.

## Security & Compliance Considerations

T201 must preserve the full mx-loom security model.

- **Secret boundary / Boundary A:** Matrix tokens, Ed25519 signing keys, provider keys, and `GH_TOKEN` must never cross Boundary A into the runtime process, the model context, or runner children. The toolbelt enforces a deny-by-default environment allowlist; runner children receive retrieved TEXT only, never credentials.
- **ADK child-process env:** ADK's `MCPToolset` commonly starts the MCP server as a stdio subprocess. The example and tests must pass an explicit safe env to `StdioServerParameters` if ADK supports it. Do not inherit `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GH_TOKEN`, `MATRIX_*`, `MX_AGENT_*`, `*_TOKEN`, `*_API_KEY`, `*_SECRET`, or `*_ACCESS_KEY` into the `mx-loom-mcp` child. The ADK safe-env helper must mirror the canonical deny rules in `packages/toolbelt/src/cli/env.ts` (`BASE_ENV_ALLOW` + `isDeniedEnvKey`: deny prefixes `MATRIX_`/`MX_AGENT_`, deny suffixes `_TOKEN`/`_API_KEY`/`_SECRET`/`_ACCESS_KEY`, deny exact `GH_TOKEN`) — do not invent a parallel list that omits the whole-namespace deny prefixes.
- **Env-support is not guaranteed by ADK:** the safe child env only protects the boundary if ADK's stdio API applies a caller-supplied `env`. If the verified ADK version ignores or cannot set `env`, pre-sanitize before spawn (a clear-and-re-export launcher set as `command`, or guarantee the ADK host process holds no Boundary-A secret when it builds the toolset). The boundary must never depend on an unverified ADK feature.
- **Audit DSN is credential-shaped:** `DATABASE_URL`/`PG*` can embed a password. It is denied by the default safe-env helper (audit off for the ADK child) and, when explicitly enabled, must be forwarded deliberately through a never-logged path. A Postgres DSN is an app-store/index credential rather than one of the enumerated Boundary-A secrets, but it must still never be logged or placed on argv.
- **Tool contract is secret-free:** no field carries credentials inbound or outbound. Credential-shaped tool args must be rejected by the toolbelt guard as `invalid_args`; do not add ADK code that bypasses `MxClient`/`MxSession` or calls daemon RPCs directly.
- **Out-of-process enforcement:** trust (Ed25519 store), deny-by-default `policy.toml`, sandboxing, and human approval gates all execute on the receiving mx-agent daemon. The ADK model can only trigger a signed request through the daemon; it cannot grant itself authority.
- **No authority mutation tools:** ADK must expose only canonical model-facing `mx_*` tools. Do not surface `trust.*`, `approval.decide`, `policy.*`, `auth.*`, `device.*`, `daemon.*`, or any wrapper that mutates trust, policy, auth, devices, daemon config, or approval decisions.
- **Approval semantics:** approval reaches ADK only as `status: "awaiting_approval"` with `handle`/`approval` data. The model is never given an approve/deny function. At release, the receiving daemon re-validates against live policy.
- **Audit correlation:** every tool result must carry `audit_ref`. If `--correlation-id` is added, it should allow audit rows to join ADK session activity to daemon invocations without adding secrets.
- **Logging/redaction:** never log secrets, tokens, full environment, raw provider config, raw Matrix credentials, or unredacted tool args/results. Stdio mode must never write diagnostics to stdout because stdout is the MCP protocol channel; use stderr only.
- **HTTP transport caution:** ADK should default to local stdio. If Streamable HTTP is documented, keep `127.0.0.1` default and require an authenticated reverse proxy before exposure. An unauthenticated endpoint could issue requests as this local session even though the daemon still enforces policy.
- **Provider keys:** ADK host code may need provider credentials to talk to its model, but those credentials must stay in the host/provider layer and not be forwarded to `mx-loom-mcp`, the daemon, the model context, or remote runner children.
- **No weakening due to `ToolContext`:** `ToolContext` is not an authority store. It may carry non-secret room/correlation/handle metadata but must not store approval decisions, policy overrides, trust state mutations, tokens, keys, or credentials.

## Testing Plan

**Acceptance-criteria traceability (issue #23).** The single issue AC — *"An ADK agent lists and calls `mx_*` tools via MCP"* — is proven by the live integration / e2e test below: it (1) constructs an ADK `LlmAgent` with `tools=[MCPToolset(...)]` over `mx-loom-mcp --stdio`, (2) asserts `tools/list` returns the nine canonical `mx_*` names (and excludes authority verbs), and (3) calls at least one `mx_*` tool and validates a normalized T102 envelope with `audit_ref` present. The daemon-free smoke proves the same list/call path without a Matrix daemon or model provider so the gate is runnable in fast CI; the live arm proves a real remote `mx_*` round-trip. Both default to skip-clean and fail-not-skip when their gate env is set.

Add or update tests in layers, with skip-clean defaults and fail-not-skip when explicitly enabled.

### Unit / static tests

- If new `mx-loom-mcp` CLI flags are added:
  - parse each flag correctly;
  - reject invalid `--max-invocations` values;
  - pass only defined values into `sessionOptions`;
  - keep existing `--stdio`, `--http`, `--room`, `--kind`, and `--audit` behavior backward-compatible.
- Test ADK example safe-env helper (if testable):
  - allow `PATH`, `HOME`, `XDG_RUNTIME_DIR`, `TMPDIR`, and `MXL_AGENT_BIN`;
  - deny `GH_TOKEN`, `MATRIX_ACCESS_TOKEN`, `MX_AGENT_*`, `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `*_TOKEN`, `*_API_KEY`, `*_SECRET`, `*_ACCESS_KEY`;
  - reject secret-shaped `extra` env entries.
- Documentation tests (optional): verify the README/example references `mx-loom-mcp --stdio`, not raw daemon RPCs or authority verbs.

### Daemon-free ADK smoke tests

- Gate with `MXL_ADK_SMOKE=1` or similar; skip cleanly by default.
- Install/use the pinned `google-adk` version only in the optional job or local env.
- Start a fake or fixture MCP server over stdio that uses `@mx-loom/mcp` with an injected fake daemon, or a minimal MCP fixture that returns the generated tool list and an envelope.
- Through ADK `MCPToolset`, assert:
  - tool list includes all canonical `mx_*` tools and excludes authority verbs;
  - a call returns a parseable T102 envelope;
  - `awaiting_approval` and `denied` are not treated as protocol errors if those statuses are exercised.
- If `MXL_ADK_SMOKE=1` is set but ADK is absent/API-incompatible, fail red rather than skipping.

### Live integration / e2e tests

- Add a T201 acceptance test under `packages/golden` or a dedicated ADK test fixture, gated by `MXL_CONFORMANCE_TWO_DAEMON=1` and required fixture env.
- Start `mx-loom-mcp --stdio --room <room> --kind adk` via ADK `MCPToolset`.
- Verify list:
  - canonical nine `mx_*` tools present;
  - no forbidden authority verbs present.
- Verify call:
  - `mx_find_agents` or `mx_workspace_status` returns `status: "ok"` and an `audit_ref` object;
  - `mx_delegate_tool` against the golden allowlisted tool returns terminal `ok` with populated audit correlation when the live two-daemon fixture is available.
- Use fresh `idempotency_key` values for mutating live calls.
- Keep approval-gated resume assertions for T202/T206; T201 may assert only that an unexpected `awaiting_approval` is surfaced as a normal envelope and can be resolved by explicit `mx_await_result`.

### Security / redaction tests

- Run an ADK spawned MCP child with fake secret env vars in the parent and assert the child does not receive them (via a test fixture, not by logging real env).
- Pass credential-shaped model args through ADK/MCP and assert the envelope is `status: "error"` with `error.code: "invalid_args"` or the established invalid-args mapping, with no secret in `error.message` or content.
- Assert logs contain no provider keys, Matrix tokens, Ed25519 material, `GH_TOKEN`, or raw env dumps.

### Conformance / documentation tests

- Ensure `packages/mcp/README.md` ADK snippet remains syntactically aligned with the example.
- If `.github/workflows/conformance.yml` gains an ADK job, ensure local default remains skip-clean and CI with explicit ADK flags fails if ADK or the two-daemon fixture is unavailable.

## Documentation Updates

- `packages/mcp/README.md`
  - replace the minimal ADK snippet with the verified import paths and safe stdio env/session example;
  - document `--room`, `--kind`, and any new session flags;
  - explain that `awaiting_approval` / `running` are resolved with `mx_await_result` in T201 and that T202 will add ADK-native long-running semantics.
- `examples/adk/README.md` (new)
  - install steps for the verified ADK version;
  - local development command (`pnpm --filter @mx-loom/mcp build` or equivalent) and installed `mx-loom-mcp` usage;
  - safe env policy;
  - `LlmAgent(tools=[MCPToolset(...)])` example;
  - session/`ToolContext` mapping guidance;
  - live two-daemon fixture notes;
  - troubleshooting: missing room, missing `mx-loom-mcp` on PATH, ADK structuredContent fallback, approval status handling.
- `examples/adk/mcp_toolset_agent.py` (new)
  - concise runnable example with no real credentials in source.
- `docs/mx-agent-tool-fabric-design.md`
  - after implementation, update the Google ADK bullet to state the verified `MCPToolset` path and mention the safe child-env/session mapping.
- `docs/backlog.md`
  - after implementation, mark T201 status/AC and note any remaining staged/live-gated pieces; do not mark T202 complete.
- Optional M2 runtime integration guide (if T207 is started later)
  - T201 should leave enough docs for T207 to consolidate.

## Risks and Open Questions

- **ADK API drift / import uncertainty:** `google.adk` is not installed in this environment, and the existing README snippet is unverified here. The coding agent must pin and test the exact ADK version/import paths.
- **`MCPToolset` result representation:** ADK may expose MCP `structuredContent`, text content only, or a transformed result. Tests must verify the actual behavior. The server's JSON text fallback should keep the envelope parseable even if structured content is not surfaced.
- **`ToolContext` availability with MCP tools:** ADK may not pass per-call `ToolContext` into MCP server calls. If so, T201's mapping must be at agent/toolset construction time, with `ToolContext` used only by the host to decide how to build the toolset and optionally remember handles.
- **MCP server process lifecycle:** confirm ADK shuts down the stdio child when the agent/session ends. If not, document explicit cleanup to avoid stale heartbeats/sessions.
- **Safe child environment:** ADK's `StdioServerParameters` may or may not accept an `env` parameter. If it does not, identify the ADK-supported way to spawn with sanitized env or wrap `mx-loom-mcp` in a tiny safe-env launcher. Do not accept inherited provider-key env as the final design. This is a **blocking secret-boundary decision**, not a nicety: confirm the env-application behavior of the pinned ADK version before the example is considered safe.
- **Safe-env list drift:** the ADK example duplicates the toolbelt's deny-by-default allowlist in Python. The TypeScript `packages/toolbelt/src/cli/env.ts` is the source of truth; the Python mirror can silently drift (e.g. dropping the `MATRIX_`/`MX_AGENT_` deny prefixes). A small test that asserts the two lists agree (or a comment + review checklist item) is needed.
- **`mx-loom-mcp` not on PATH:** the `bin` is a workspace artifact and may not resolve on a bare `PATH`, causing `ENOENT` at spawn. The example must show a resolvable invocation (global link, absolute `dist` path, or `pnpm exec`).
- **Audit DSN forwarding:** enabling the Postgres mirror for the ADK child requires forwarding a credential-shaped `DATABASE_URL` that the default safe-env helper denies. Decide whether T201 supports ADK-child audit at all, or defers it to the host/daemon, so the secret-free default is not quietly weakened.
- **Need for CLI flags:** existing `mx-loom-mcp --room --kind` may pass acceptance, but robust audit/session mapping likely needs `--correlation-id`. Decide whether to add the recommended flags in T201 or defer them.
- **No ADK package today:** adding a new package may overstate support. Prefer examples/tests unless maintainers want a reusable runtime package.
- **Two-daemon fixture availability:** live `mx_delegate_tool` acceptance depends on the staged golden fixture. Tests must be skip-clean locally but fail if flags demand the fixture.
- **Idempotency at ADK/model retry layer:** handler-generated idempotency keys protect transport retries, but a model/ADK-level repeated mutating call without a supplied `idempotency_key` may be a new invocation. Examples/tests should provide explicit keys for scripted mutating calls.
- **Approval path split:** users may expect ADK-native pending tickets in T201. Be explicit that generic MCPToolset surfaces `awaiting_approval`; T202 owns `LongRunningFunctionTool` resumption.
- **HTTP temptation:** ADK can likely connect to HTTP MCP servers, but exposing unauthenticated HTTP is risky. Keep stdio as the default and make HTTP an explicit advanced path.

## Implementation Checklist

1. Verify T109 dependency is present and green:
   - `@mx-loom/mcp` lists tools and calls through the existing tests;
   - `mx-loom-mcp --stdio` is buildable/runnable in local dev.
2. Verify Google ADK version and import/API surface:
   - `LlmAgent`;
   - `MCPToolset`;
   - `StdioServerParameters`;
   - child env support (**blocking** for the secret boundary — if `env` is not applied, implement the pre-spawn sanitization fallback);
   - list/call test hooks or runner API;
   - `ToolContext` state behavior.
   - confirm a resolvable `mx-loom-mcp` command (global link / absolute `dist` path / `pnpm exec`) so the spawn does not `ENOENT`.
3. Decide whether T201 needs new `mx-loom-mcp` CLI flags:
   - if yes, add `--correlation-id` and any workspace flags with tests;
   - if no, document the decision and rely on `--room` plus generated correlation.
4. Add or update `mx-loom-mcp` CLI/session tests for any new flags and confirm no stdout diagnostics in stdio mode.
5. Create `examples/adk/`:
   - README with setup, safe env, session mapping, `awaiting_approval` handling, and troubleshooting;
   - Python agent/toolset example using verified imports;
   - optional requirements file pinning ADK.
6. Update `packages/mcp/README.md` ADK section to point to the full example and include safe env/session arguments.
7. Add daemon-free ADK smoke fixture, gated by an explicit env var, if practical:
   - list canonical `mx_*` tools;
   - call a fake/read tool;
   - parse/validate the T102 envelope.
8. Add live ADK e2e acceptance, preferably under `packages/golden`:
   - reuse existing two-daemon/golden fixture env;
   - instantiate ADK `MCPToolset` over `mx-loom-mcp --stdio --room <room> --kind adk`;
   - assert list of `mx_*` tools;
   - call `mx_find_agents` or `mx_workspace_status`;
   - call allowlisted `mx_delegate_tool` with an explicit `idempotency_key`;
   - assert terminal envelope and `audit_ref`.
9. Add secret-boundary tests for ADK spawn env and credential-shaped args:
   - mirror `packages/toolbelt/src/cli/env.ts` (`BASE_ENV_ALLOW` + `isDeniedEnvKey`) in the example helper and add a test (or review check) asserting the lists agree, including the `MATRIX_`/`MX_AGENT_` deny prefixes;
   - assert a parent env carrying fake `MATRIX_*`, `MX_AGENT_*`, `GH_TOKEN`, `*_API_KEY`, and `DATABASE_URL` does not reach the spawned `mx-loom-mcp` child;
   - confirm no DSN / token / key appears in any log line.
10. Update design/backlog docs after implementation:
    - T201 status and verified ADK recipe;
    - leave T202/T206 outstanding.
11. Run relevant checks:
    - TypeScript typecheck/build/tests for touched packages;
    - optional ADK smoke only when dependency is installed;
    - live e2e only when fixture flags are set.
12. Confirm no code exposed or documented any trust/policy/approval mutation tool and no logs contain credentials.
