# ADK LongRunningFunctionTool Approval Shim (T202 / #24)

> Implementation specification for GitHub issue **#24 — T202 · binding: ADK `LongRunningFunctionTool` approval shim**.
> Labels: `area/adk` · `priority/P0` · `type/feature`. Milestone **M2 — Universal binding**. Estimate **M**.
> Dependencies: **blocked-by #23 / T201** (ADK `MCPToolset` integration) and **#11 / T103** (`mx_await_result` deferred-result resolver).
> Sources read: [`docs/mx-agent-tool-fabric-design.md`](../docs/mx-agent-tool-fabric-design.md), [`docs/backlog.md`](../docs/backlog.md) (`T202`, M2, and dependencies), the inline issue text supplied for #24, existing ADK example/docs under [`examples/adk`](../examples/adk), and the current source tree for the affected areas (`packages/mcp`, `packages/registry`, `packages/toolbelt`, `packages/golden`, `packages/claude`). No GitHub access is assumed.

## Problem Statement

Google ADK users can already mount the generated `mx-loom-mcp` server via ADK `MCPToolset` (T201). That generic MCP path exposes `mx_delegate_tool` and `mx_run_command` as ordinary MCP tools. When either tool is held by the receiving daemon's human approval gate, the model sees a normalized T102 envelope with:

- `status: "awaiting_approval"`;
- a deferred `handle`;
- a secret-free `approval` block; and
- `audit_ref` correlation ids.

Generic MCP has no native long-running tool semantics, so the model or host must later call `mx_await_result(handle)` explicitly. ADK, however, has a native `LongRunningFunctionTool` protocol intended for exactly this shape: a tool call can yield a pending ticket, the agent/runtime can continue doing other work, and the host can resume the tool call when the external result is ready.

The current gap is that mx-loom does **not** provide an ADK-native wrapper for the two deferred, approval-bearing verbs. Without this shim:

- approval-gated ADK calls look like ordinary envelope results rather than ADK pending tickets;
- host applications must hand-roll handle storage and resume logic;
- agents may block, retry, or mis-handle `awaiting_approval`; and
- M2 cannot prove the ADK-native approval-resume behavior required by T202/T206.

## Goals

- Provide an ADK-native long-running shim for the two deferred mutating verbs:
  - `mx_delegate_tool`;
  - `mx_run_command`.
- Preserve the canonical model-facing names where ADK permits it: the long-running wrappers should appear as `mx_delegate_tool` and `mx_run_command`, not new `*_long_running` names.
- Convert a T102 `running` / `awaiting_approval` envelope into an ADK `LongRunningFunctionTool` pending ticket without blocking on a human operator.
- Resume the original ADK tool call by resolving the daemon handle with `mx_await_result(handle)` after the operator approves/denies out-of-process, returning the terminal T102 envelope (`ok`, `denied`, or `error`) to ADK.
- Prove the issue acceptance criteria:
  - an approval-gated call yields a pending ticket and resumes on approval;
  - the agent/runtime can perform other work while that ticket is pending.
- Reuse the T201 safe ADK `MCPToolset`/`mx-loom-mcp --stdio` integration and T103 resolver semantics instead of implementing a Python daemon client.
- Keep all authority and enforcement on mx-agent daemons: the ADK shim observes approval state and resumes results; it never grants approval, mutates policy, or bypasses trust/sandbox checks.
- Preserve the T102 result envelope, closed error taxonomy, idempotency behavior, `audit_ref` correlation, and secret-free contract.
- Add tests and docs that are skip-clean locally but fail-not-skip when the ADK/daemon fixtures are explicitly requested.

## Non-Goals

- **Do not implement the feature in this spec phase.** This document is planning only.
- No trust, policy, approval-decision, auth, device, daemon, or operator mutation tools. In particular, do **not** expose `approval.decide`, `trust.*`, `policy.*`, `auth.*`, `device.*`, or `daemon.*` to ADK/model tools.
- No reimplementation of the mx-agent daemon JSON-RPC protocol in Python. The shim should route through the existing `mx-loom-mcp`/toolbelt seam so credential guards, redaction, session registration, and audit taps remain centralized.
- No daemon RPC, Matrix event, policy, sandbox, or approval-dashboard implementation changes.
- No result-envelope shape change and no error-taxonomy expansion.
- No unrestricted exec and no requester-side enforcement of `allow_commands`, `deny_args_regex`, `allow_cwd`, sandbox, or `requires_approval`; those remain receiver-daemon policy decisions.
- No model self-approval and no model-visible approval mutation surface. Approval reaches ADK only as pending state and terminal result.
- No full M2 portability matrix. T206 owns the cross-runtime matrix after T202/T203/T205 land.
- No packaging commitment to a Python `mx_loom_adk` distribution unless maintainers explicitly choose that as a follow-up. Prefer examples/helpers/tests first, because this TypeScript workspace does not currently publish Python packages.
- No durable crash-recovery of pending ADK tickets beyond a single ADK session/process. Durable task/watch resumption belongs to M3 (`task.watch` / T302), though the design should not preclude it.

## Relevant Repository Context

**Stack and repository status.** The project is TypeScript, ESM, pnpm workspaces, Node `>=20.19`, vitest, Apache-2.0. The issue prompt cautions that the repo may be docs-only. In this checkout, the repo is **not** docs-only: M0/M1 packages and some M2 integration examples/tests already exist. A later implementation agent should still verify the baseline it is running on and not assume packages exist if working from an older docs-only checkout.

Current relevant packages/modules:

- `packages/registry` (`@mx-loom/registry`): canonical descriptors, T102 envelope, closed error taxonomy, idempotency helper, and M1 handlers. Relevant contracts:
  - `ToolResult.status` is `ok | running | awaiting_approval | denied | error`.
  - `awaiting_approval` carries `handle` + `approval`; it is not an error.
  - `audit_ref` is structurally present on every result.
  - `mx_delegate_tool` and `mx_run_command` have `async_semantics: "deferred"` and optional `idempotency_key`.
  - `mx_await_result` implements T103: `wait_ms` expiry returns the still-pending envelope, never a fabricated timeout fault.
- `packages/mcp` (`@mx-loom/mcp`): generated MCP server from canonical descriptors. Relevant modules:
  - `src/tools.ts`: lists tools from `CANONICAL_M1_TOOLS`.
  - `src/dispatch.ts`: routes tool calls to registry handlers; the room comes from `BindingContext`, never model args.
  - `src/context.ts`: opens/binds `MxSession` with room/correlation and an audit sink.
  - `src/serialize.ts`: serializes the full T102 envelope into MCP `CallToolResult`; `isError` is true only for `status: "error"`.
  - `src/cli-options.ts` / `src/cli.ts`: T201 session flags (`--room`, `--kind`, `--correlation-id`, `--cwd`, `--project-id`, `--git-commit`, `--max-invocations`) and audit flag parsing.
- `packages/toolbelt` (`@mx-loom/toolbelt`): daemon client/session seam, env allowlist, credential-shaped-arg guard, and inbound redaction. ADK code must not bypass this seam.
- `examples/adk`: T201 Python example. It currently provides:
  - `mcp_toolset_agent.py` with `safe_mx_mcp_env()`, `_mx_mcp_args(...)`, `mx_mcp_toolset(...)`, `mx_session_state(...)`, and `build_agent(...)` for generic `MCPToolset` wiring.
  - `README.md` documenting safe child env, session/`ToolContext` mapping, `mx_await_result` for generic deferred results, and stating that ADK-native `LongRunningFunctionTool` pending tickets remain T202.
  - `requirements.txt` with `google-adk>=1.0.0` as a version to verify/pin, not a vendored dependency.
- `packages/golden`: binding/e2e test harnesses and live two-daemon fixtures. It already includes:
  - `test/adk.mcp-toolset.e2e.test.ts` for T201, using Python ADK deterministically without a model/provider call.
  - `test/scenario.ts`, whose held approval steps S4/S5/S6 are ideal fixtures for T202.
  - helpers for skip-clean/fail-not-skip behavior and fake secret sentinel checks.
- `packages/claude`: useful precedent for binding-level deferred handling:
  - `src/resolve.ts` hides the poll loop for `running`, surfaces `awaiting_approval` by default, and only blocks on approval behind opt-in host policy.
  - This is a TypeScript/Claude binding, not directly reusable by Python ADK, but its disposition policy should guide T202.

Current ADK-native long-running status:

- There is **no** `packages/adk` workspace package.
- There is **no** Python `mx_loom_adk` package.
- There is **no** `examples/adk/long_running*.py` helper.
- There is **no** ADK `LongRunningFunctionTool` shim for `mx_delegate_tool` / `mx_run_command`.
- There is **no** T202 e2e test proving pending ticket → approval → resume.
- The exact Google ADK `LongRunningFunctionTool` import path, pending-ticket representation, resume API, and interaction with `ToolContext` must be verified against the pinned ADK version before implementation.

Architectural constraints from the design doc:

- Runtimes own cognition; mx-agent daemons own coordination, signing, trust, policy, sandboxing, approvals, Matrix credentials, and audit truth.
- mx-loom is the adaptation plane. It is secret-free and only translates runtime tool calls into daemon requests/results.
- The model-facing surface is the canonical nine M1 `mx_*` verbs. Authority/operator verbs are explicitly excluded.
- Approval-gated flow is: daemon holds request → toolbelt returns `awaiting_approval` → operator decides out-of-process → daemon re-runs authorization at release → caller observes terminal result via `mx_await_result`.

## Proposed Implementation

### 1. Verify the ADK long-running API before coding

Start with a small spike against the exact `google-adk` version selected for the examples/tests. Record the verified imports and behavior in comments/docs. Confirm:

- `LongRunningFunctionTool` import path and constructor signature.
- Whether it wraps sync functions, async functions, or both.
- How the function signals "pending" to ADK:
  - a special return object;
  - a field on `ToolContext.actions`;
  - an exception/sentinel;
  - or another ADK-defined mechanism.
- How ADK names the tool and derives the input schema from the Python function signature/docstring.
- Whether a wrapper can use the canonical tool name `mx_delegate_tool` / `mx_run_command`.
- How ADK provides the original function/tool call id (`function_call_id`, `tool_call_id`, etc.) needed to resume the same pending call.
- How a host injects a terminal function response to resume the agent run.
- Whether ADK allows an agent to keep processing while a long-running tool is pending, or whether the host must start a follow-up run/turn after the pending response.
- Whether `ToolContext.state` is available and safe for storing non-secret handle metadata.
- Whether `LlmAgent.tools` can include individual MCP tool objects returned from `MCPToolset.get_tools(...)`; this determines how to avoid duplicate names when replacing the two generic MCP tools with native long-running wrappers.

The implementation must fail-not-skip when T202 e2e is explicitly requested but the pinned ADK API has drifted.

### 2. Add an ADK-side helper that reuses the existing MCP server

Preferred location: add a new Python helper under `examples/adk/`, for example:

- `examples/adk/long_running_tools.py`; or
- an explicitly separated section/module in `examples/adk/mcp_toolset_agent.py` if maintainers prefer fewer files.

Recommended shape:

- Keep `mcp_toolset_agent.py` as the generic T201 recipe.
- Add a new helper that builds an **ADK MX tool bundle**:
  - one private, safely-spawned `MCPToolset` connected to `mx-loom-mcp --stdio` using the existing `safe_mx_mcp_env(...)` and `_mx_mcp_args(...)` helpers;
  - public ADK `LongRunningFunctionTool` wrappers for `mx_delegate_tool` and `mx_run_command`;
  - the remaining canonical non-deferred/read tools exposed through MCP, if ADK supports extracting individual MCP tool objects safely.

The helper must **not** open the daemon socket directly from Python. Initial dispatches and resume polls should call the canonical MCP tools (`mx_delegate_tool`, `mx_run_command`, `mx_await_result`) through `mx-loom-mcp`, so the production path remains:

```text
ADK LongRunningFunctionTool -> Python helper -> ADK MCPToolset/MCP tool call -> mx-loom-mcp -> MxSession/MxClient -> daemon
```

This preserves:

- session registration and correlation stamping;
- outbound credential-shaped-arg rejection;
- inbound redaction;
- T102 serialization/parsing;
- the `withAudit` tap applied in `@mx-loom/mcp`; and
- out-of-process daemon enforcement.

### 3. Avoid duplicate `mx_delegate_tool` / `mx_run_command` definitions

T201's generic `MCPToolset` exposes all nine tools, including `mx_delegate_tool` and `mx_run_command`. T202's native wrappers should use those same names. The implementation must avoid exposing duplicate tool names to the same ADK agent.

Recommended resolution order:

1. **Use ADK's own filtering/composition if available.** If the verified ADK API lets a host list MCP tools and pass individual `BaseTool` objects into `LlmAgent.tools`, build an async factory that:
   - starts one MCPToolset;
   - calls `get_tools(...)`;
   - filters out `mx_delegate_tool` and `mx_run_command` from the public MCP tool list;
   - adds the two `LongRunningFunctionTool` wrappers with the same canonical names;
   - returns a bundle with `tools=[...seven_mcp_tools, long_delegate, long_run]` and a `close()` method for the underlying MCPToolset.
2. **Use an ADK `tool_filter` if the verified `MCPToolset` supports one.** Configure it to exclude only `mx_delegate_tool` and `mx_run_command`, then add the native wrappers beside that filtered MCPToolset.
3. **Only if ADK cannot filter or expose individual tools**, add a generic fail-closed subset option to `@mx-loom/mcp` (for example `--include-tools` / `--exclude-tools` over canonical `mx_*` names) and document it as a filtering surface, not an authority surface. This is a fallback because it changes MCP public API. If added, it must:
   - accept only names present in `CANONICAL_M1_TOOLS`;
   - only reduce the surfaced tool set, never add tools;
   - reject unknown names and authority-like names;
   - default to the current full nine-tool behavior;
   - keep dispatch unavailable for excluded names; and
   - be tested independently.

Do **not** solve duplication by renaming the native wrappers to new model-facing names unless maintainers explicitly decide to break the canonical-name requirement. New names would weaken portability and should be treated as a last-resort open question.

### 4. Generate or drift-guard the long-running wrapper schemas

The native ADK wrappers must mirror the canonical descriptor inputs for the two wrapped tools:

- `mx_delegate_tool(agent: str, tool: str, args: dict[str, Any], wait_ms?: int, idempotency_key?: str)`
- `mx_run_command(agent: str, command: str, args?: list[str], cwd?: str, wait_ms?: int, idempotency_key?: str)`

Because Google ADK is Python and may derive tool declarations from Python function signatures rather than accepting JSON Schema directly, implementation may need small Python functions. To avoid per-runtime schema drift:

- Prefer any ADK-supported API that accepts an explicit JSON schema/function declaration generated from `@mx-loom/registry`.
- If ADK only supports Python signature introspection, hand-write the minimal function signatures but add a **drift guard** in TypeScript or Python tests that compares the wrapper field names/requiredness against `MX_DELEGATE_TOOL.input_schema` and `MX_RUN_COMMAND.input_schema`.
- Keep descriptions aligned with the canonical descriptors and T202-specific pending/resume behavior.
- Do not add room, correlation id, policy, trust, approval decision, Matrix credentials, provider keys, or `GH_TOKEN` fields to the tool input schema.

`wait_ms` handling in the native ADK long-running path needs special care. The long-running wrapper should not let a model-supplied `wait_ms` block indefinitely or hide a human approval gate. Recommended default:

- Initial dispatch uses a non-blocking probe (`wait_ms=0` or omitted) so `awaiting_approval` becomes an ADK pending ticket promptly.
- If maintainers want a short settling window for non-human `running` states, gate it behind a host option such as `initial_wait_ms_cap`, defaulting to `0` and capped to a small value.
- For `awaiting_approval`, never spin in the initial function call waiting for a human. ADK's pending/resume protocol is the point of T202.

### 5. Initial dispatch: envelope -> immediate result or pending ticket

The long-running wrapper function for each verb should:

1. Read the ADK `ToolContext` / function call id if available.
2. Build the canonical input arguments from model input, preserving `idempotency_key` when supplied.
3. If the model omitted `idempotency_key`, generate a stable key for this ADK function call before dispatch, and store/reuse it for any replay of the same initial call. The key is a dedup nonce, not a capability.
4. Call the underlying MCP tool (`mx_delegate_tool` or `mx_run_command`) through the private MCPToolset.
5. Extract and validate the T102 envelope from ADK's MCP tool result representation, using the same robust extraction strategy as `packages/golden/test/adk.mcp-toolset.e2e.test.ts`:
   - prefer `structuredContent` if ADK exposes it;
   - fall back to JSON text content if needed.
6. If the envelope is terminal (`ok`, `denied`, `error`), return it as the final ADK tool result. Do not manufacture a pending ticket.
7. If the envelope is `running` or `awaiting_approval`, create an ADK long-running pending ticket and store a non-secret mapping to the daemon handle.

The pending ticket metadata should contain only non-secret fields. Suggested ADK-local shape if ADK permits metadata:

```python
class MxPendingTicket(TypedDict):
    ticket_id: str             # ADK function/tool call id, or generated local id
    tool: Literal["mx_delegate_tool", "mx_run_command"]
    handle: str                # daemon invocation handle; not an approval capability
    status: Literal["running", "awaiting_approval"]
    approval: dict[str, Any] | None   # request_id, risk, summary, expires_at; secret-free
    audit_ref: dict[str, Any]
    idempotency_key: str | None
    created_at: str
    correlation_id: str | None
```

If ADK defines its own pending-ticket class/format, store this metadata in the sanctioned ADK field/state rather than inventing a parallel public wire format.

### 6. Resume path: pending handle -> `mx_await_result` -> ADK terminal response

Implement a host-side resolver that takes an ADK pending ticket and observes the daemon result:

1. Read the stored `handle` for the original function call.
2. Call the canonical `mx_await_result({ handle, wait_ms })` through the same safe MCP path.
3. If the result is still `running` / `awaiting_approval`, keep the ticket pending and reschedule according to host policy. A poll-budget expiry is not an error; preserve T103 semantics.
4. If the result is terminal (`ok`, `denied`, `error`), feed the terminal T102 envelope back to ADK as the completion of the original long-running function call.
5. Remove or mark the pending ticket completed. Repeated completion/resume attempts should be idempotent and return the same terminal envelope if ADK calls the resolver again.

The resolver only observes. It must not call `approval.decide`, mutate policy, or grant authority. Approval/denial must happen out-of-band through the operator surfaces already used by the golden fixture (for example `scripts/conformance/decide-approval.sh` in tests), and the receiving daemon re-validates trust/policy at release.

### 7. Concurrency and "agent can do other work while pending"

The shim must not serialize the entire ADK/MCP session behind one pending approval. Support multiple independent pending tickets in one ADK session:

- pending ticket store keyed by ADK function call id / ticket id;
- no global singleton handle;
- bounded polling intervals and no busy wait;
- cancellation/cleanup when ADK session closes;
- no unbounded background tasks after toolset shutdown.

To prove the second acceptance criterion, the e2e should call another tool while the approval ticket is still pending. Prefer a canonical read/observe tool such as `mx_find_agents` or `mx_workspace_status` through the same ADK tool bundle. That demonstrates the ADK runtime and the underlying `mx-loom-mcp` session remain usable while an approval-gated delegation is held.

### 8. Documentation and examples

Update the ADK docs to present two ADK integration modes:

- **Generic MCPToolset (T201):** all nine `mx_*` tools over MCP; `running` / `awaiting_approval` are ordinary envelopes resolved with `mx_await_result`.
- **Native long-running (T202):** `mx_delegate_tool` / `mx_run_command` are ADK `LongRunningFunctionTool`s that return pending tickets and resume on terminal results; the other tools remain ordinary MCP tools.

The docs must make clear that the host/operator approves out-of-band. The model never receives an approval mutation tool.

## Affected Files / Packages / Modules

Likely files to read or modify during implementation:

- `examples/adk/mcp_toolset_agent.py`
  - reuse `safe_mx_mcp_env`, `_mx_mcp_args`, `mx_mcp_toolset`, and `mx_session_state`;
  - possibly add shared envelope extraction utilities if they are not better placed in a new module.
- `examples/adk/long_running_tools.py` (new, recommended)
  - ADK `LongRunningFunctionTool` wrappers;
  - pending-ticket store/resolver helpers;
  - tool-bundle builder that composes filtered MCP tools + native wrappers.
- `examples/adk/README.md`
  - add T202 mode, pending/resume flow, lifecycle, and safety guidance.
- `examples/adk/requirements.txt`
  - pin or document the verified `google-adk` version/imports once confirmed.
- `packages/golden/test/adk.long-running.e2e.test.ts` (new, recommended)
  - gated live T202 acceptance using the existing two-daemon golden approval fixture.
- `packages/golden/test/adk.mcp-toolset.e2e.test.ts`
  - reuse helper patterns for Python driver, spawn launcher, ADK import checks, envelope extraction, and secret sentinel tests.
- `packages/golden/test/scenario.ts`
  - read-only reference for approval-gated S4/S6 and denial S5; avoid changing unless the shared scenario needs a small helper export.
- `packages/mcp/src/*` and `packages/mcp/test/*`
  - no changes expected if ADK can filter/expose individual MCP tools;
  - possible fallback changes only if a generic `--include-tools` / `--exclude-tools` surface is needed to prevent duplicate names.
- `packages/registry/src/descriptors/delegate-tool.ts`, `packages/registry/src/descriptors/run-command.ts`, and tests
  - read-only contract reference; add drift-guard tests if Python signatures are compared to these schemas.
- `packages/toolbelt/src/cli/env.ts` and `packages/toolbelt/src/guards.ts`
  - read-only security reference; ADK code must continue mirroring/reusing their rules via the T201 helper.
- `packages/mcp/README.md`
  - update ADK section to point to long-running mode and distinguish it from generic MCPToolset.
- `docs/mx-agent-tool-fabric-design.md`
  - after implementation, update the Google ADK bullet to state the T202 long-running shim is available and describe its pending/resume behavior.
- `docs/backlog.md`
  - after implementation, mark T202 status/acceptance and leave T206 as the full portability-matrix gate.
- `.github/workflows/conformance.yml`
  - optional new gated ADK long-running job; keep default local/CI behavior skip-clean unless explicitly requested.

Modules/packages that do **not** exist today and should not be assumed:

- no `packages/adk` workspace package;
- no published Python `mx_loom_adk` package;
- no ADK-native `LongRunningFunctionTool` module;
- no ADK long-running e2e test;
- no generic MCP tool subset/filter API unless a later implementation adds it.

## API / Interface Changes

Expected public or semi-public changes:

- **New ADK example/helper API** (recommended, names to confirm during implementation):
  - `mx_long_running_tool_bundle(...)` or similar async factory returning:
    - ADK tools to pass to `LlmAgent`;
    - a `close()`/cleanup method for the underlying MCPToolset;
    - a resolver method for pending tickets if ADK does not own polling/resume automatically.
  - `build_agent_with_long_running(...)` convenience helper, if practical.
  - `MxPendingTicket` / pending metadata type if ADK permits custom metadata.
- **ADK model-facing tools:** `mx_delegate_tool` and `mx_run_command` become native ADK long-running function tools in the T202 helper mode. They should retain canonical names and canonical input fields.
- **Possible MCP filtering API only if needed:** if ADK cannot filter/combine individual tools, add a fail-closed `--include-tools` / `--exclude-tools` CLI and corresponding library option to `@mx-loom/mcp`. This is not preferred, but if implemented it is a public MCP server option and must be documented.
- **New test/conformance environment flag:** recommended `MXL_ADK_LONG_RUNNING_E2E=1` (or similarly named) to request the gated T202 e2e. Reuse `MXL_ADK_PYTHON`, `MXL_ADK_MCP_COMMAND`, and the existing `MXL_CONFORMANCE_*` golden fixture variables where possible.

No expected changes to:

- canonical tool names beyond replacing the ADK exposure mechanism for two tools;
- daemon JSON-RPC methods;
- Matrix event schemas;
- T102 envelope API;
- error taxonomy;
- audit-row schema;
- trust/policy/approval public APIs.

If the implementation can use ADK-native filtering/composition and only adds example/helper code, the `@mx-loom/mcp` CLI/API changes should be **none**.

## Data Model / Protocol Changes

Expected core protocol changes: **none**.

The T102 envelope remains unchanged:

- `status: ok | running | awaiting_approval | denied | error`;
- `result`, `error`, `handle`, `approval`, `audit_ref`;
- `awaiting_approval` is non-error and carries `handle` + `approval`;
- terminal approval denial is `status: "denied"` with `error.code: "approval_denied"`;
- transport/daemon faults remain in the closed fault set.

The daemon protocol remains unchanged:

- initial dispatch still uses `call.start` / `exec.start` through the registry handlers;
- resume still uses `invocation.get` through `mx_await_result`;
- approval decisions still arrive out-of-process via daemon/operator channels;
- release still re-validates against live receiver policy.

ADK-local data model additions:

- a non-secret pending ticket mapping from ADK function call id to daemon `handle` and initial pending envelope metadata;
- optional host-side state for multiple pending tickets in one ADK session;
- stable idempotency key associated with the initial ADK function call when the model did not supply one.

Serialization requirements:

- The terminal result returned to ADK should be the full T102 envelope, not only the bare `result` payload.
- The pending ticket may include the pending envelope's `approval` summary and `audit_ref`, but no credentials.
- Logs and test probe output must not contain raw env, tokens, provider keys, Matrix secrets, DB credentials, or credential-shaped arg values.

Idempotency requirements:

- For initial mutating dispatch, preserve caller-supplied `idempotency_key`.
- If omitted, generate one once per ADK function call and reuse it if ADK retries the same initial call.
- Resume via `mx_await_result` is a read and has no idempotency key.
- Repeated resolver calls for the same completed ticket should not re-dispatch the original mutation.

Audit requirements:

- Initial pending result and terminal resume should each carry `audit_ref`.
- If calls route through `@mx-loom/mcp`, the existing `withAudit` tap records rows at the server result-return chokepoint; the Python shim should not duplicate audit writes.
- Pending and terminal rows should remain joinable by `invocation_id` / `request_id` / `correlation_id`.

## Security & Compliance Considerations

T202 must preserve the full mx-loom security model.

- **Secret boundary / Boundary A:** Matrix tokens, Ed25519 signing keys, provider keys, and `GH_TOKEN` never cross Boundary A into the runtime process, model context, or runner children. The toolbelt enforces a deny-by-default env allowlist; runner children receive retrieved TEXT only, never credentials.
- **ADK child-process env:** continue using `safe_mx_mcp_env()` from the T201 example. The `mx-loom-mcp` child must not inherit `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GH_TOKEN`, `MATRIX_*`, `MX_AGENT_*`, `*_TOKEN`, `*_API_KEY`, `*_SECRET`, `*_ACCESS_KEY`, `DATABASE_URL`, or `PG*` by default. If the verified ADK stdio API does not apply `env`, use the documented pre-sanitized launcher/host-env backstop.
- **Tool contract is secret-free:** no tool field carries credentials inbound or outbound. The wrapper must not add credential-bearing args or metadata. Credential-shaped args must continue to be rejected by the toolbelt path as `invalid_args`; do not bypass `MxClient`/`MxSession`.
- **Out-of-process enforcement:** trust (Ed25519 store), deny-by-default `policy.toml`, sandboxing, and human approval gates all execute on the receiving mx-agent daemon. The ADK shim only initiates signed requests and observes results.
- **Cognition never grants authority:** the model/runtime cannot approve its own request. The shim must not expose `approval.decide` or any local shortcut that turns an ADK pending ticket into authorization. A pending ticket is not a capability; it is a handle to observe the daemon's later result.
- **Approval re-validation:** on operator approval, the receiving daemon re-runs the authorization pipeline against live trust/policy before executing. The shim must rely on and document this; it must not cache an approval as if it were sufficient authority.
- **Deny-by-default exec:** `mx_run_command` remains guarded by receiver policy (`allow_commands`, `deny_args_regex`, `allow_cwd`, sandbox, network policy, and optionally `requires_approval`). The ADK wrapper must not implement its own allowlist that could diverge from daemon policy.
- **No authority mutation tools:** only canonical model-facing `mx_*` tools may be exposed. Operator functions remain out-of-band.
- **Audit correlation:** every result returned to ADK must include `audit_ref`; session `correlation_id` must remain non-secret and be threaded via T201 CLI/session config, not model args.
- **Logging/redaction:** never log full environments, provider config, Matrix tokens, signing keys, `GH_TOKEN`, database DSNs, raw command args that may contain secrets, raw tool results before redaction, or approval summaries containing secrets. Diagnostic output from `mx-loom-mcp --stdio` must stay on stderr; stdout is MCP protocol.
- **ToolContext state:** `ToolContext` may store non-secret `mx_room`, `mx_correlation_id`, handles, and ticket ids. It must not store credentials, approval decisions, trust state mutations, policy contents, or daemon secrets.
- **HTTP transport caution:** T202 should continue to default to stdio. If HTTP is documented, keep localhost-only defaults and require an authenticated proxy for non-local exposure.
- **Provider keys:** ADK host/model credentials stay in the host/provider layer and are never forwarded to `mx-loom-mcp`, daemon RPC, model-visible tool args, or remote runners.

## Testing Plan

Add tests in layers. Default behavior should be skip-clean when optional ADK/live fixtures are absent, and fail-not-skip when a T202 gate env var explicitly requests the run.

### Unit / static tests

- Python helper imports without `google-adk` installed for non-ADK pieces, mirroring the T201 safe-env pattern.
- Safe env remains aligned with `packages/toolbelt/src/cli/env.ts`; existing parity tests should continue to cover `MATRIX_`, `MX_AGENT_`, suffix denies, `GH_TOKEN`, `DATABASE_URL`, and `PG*`.
- Wrapper schema drift guard:
  - `mx_delegate_tool` wrapper fields/requiredness match `MX_DELEGATE_TOOL.input_schema`;
  - `mx_run_command` wrapper fields/requiredness match `MX_RUN_COMMAND.input_schema`;
  - no room/correlation/approval/trust/policy/credential fields are present.
- Pending-ticket conversion:
  - terminal `ok`/`denied`/`error` envelopes return final ADK results, not pending tickets;
  - `running` and `awaiting_approval` envelopes produce pending tickets with handle, status, audit_ref, and optional approval info;
  - malformed/missing handle in a deferred envelope maps to a safe `error`/`internal` result rather than a crash.
- Resume logic with a fake MCP toolset:
  - pending -> still pending on `mx_await_result` budget expiry;
  - pending -> terminal `ok` on later result;
  - pending -> terminal `denied(approval_denied)` on operator denial;
  - repeated resume for a completed ticket is idempotent and does not re-dispatch.
- Idempotency tests:
  - supplied `idempotency_key` is preserved;
  - omitted key is generated once per ADK function call and reused on retry;
  - resume does not include/generate an idempotency key.
- Duplicate-name tests:
  - an ADK long-running bundle exposes exactly one `mx_delegate_tool` and one `mx_run_command`;
  - no authority verbs are exposed;
  - the other expected `mx_*` tools remain available if the full bundle is used.

### ADK API smoke tests

- Gate with a variable such as `MXL_ADK_LONG_RUNNING_SMOKE=1`; skip cleanly by default.
- Verify the pinned `google-adk` version exposes the documented `LongRunningFunctionTool` API.
- Using a fake/fixture MCP server or fake MCPToolset:
  - construct the long-running wrappers;
  - invoke `mx_delegate_tool` and receive an ADK-native pending object;
  - resume the same function call with a terminal envelope;
  - verify ADK-visible result extraction returns a valid T102 envelope.
- If the gate env is set but ADK is missing or the API has drifted, fail red.

### Live two-daemon e2e acceptance

Add a gated test under `packages/golden`, for example `test/adk.long-running.e2e.test.ts`:

- Gate with `MXL_ADK_LONG_RUNNING_E2E=1` plus the existing two-daemon/golden policy vars:
  - `MXL_CONFORMANCE_TWO_DAEMON=1`;
  - `MXL_CONFORMANCE_GOLDEN_POLICY=1`;
  - room/target/approval-tool/command coordinates from the golden bring-up;
  - `MXL_ADK_PYTHON` and optional `MXL_ADK_MCP_COMMAND`.
- Build an ADK agent/tool bundle using T202 long-running mode, with no model/provider call required.
- Exercise `mx_delegate_tool` against the approval-gated golden tool (scenario S4):
  1. initial call returns an ADK pending ticket quickly;
  2. pending metadata contains T102 `handle`, `approval`, and `audit_ref`;
  3. before approval, call `mx_find_agents` or `mx_workspace_status` through the same ADK bundle and assert `ok` — this proves other work can proceed while pending;
  4. decide approval out-of-band using the existing operator fixture (`decide-approval.sh` or equivalent);
  5. resume/poll the pending ticket via `mx_await_result` and assert terminal `ok` envelope with populated `audit_ref`.
- Exercise `mx_run_command` against the approval-gated command (scenario S6) if fixture coordinates are available:
  - pending ticket -> operator approve -> terminal `ok` with `exit_code`.
- Exercise denial path if time allows (scenario S5):
  - pending ticket -> operator deny -> terminal `denied` / `approval_denied`.
- Assert no fake secret sentinel appears in child env keys, pending metadata, terminal envelopes, logs, or ADK-visible output.
- Validate every envelope with `validateEnvelope` from `@mx-loom/registry` on the TypeScript side where practical.
- Confirm audit rows or in-memory audit sink emissions show pending + terminal correlation for the long-running call, without duplicate rows.

### Secret-boundary / redaction tests

- Seed fake parent env values for `GH_TOKEN`, `MATRIX_ACCESS_TOKEN`, `MX_AGENT_SECRET`, provider keys, and audit DSNs, as T201 does.
- Assert the `mx-loom-mcp` child env excludes secret-shaped keys.
- Pass credential-shaped tool args and assert `invalid_args` or the established fault envelope, with no secret in `error.message` or text output.
- Assert pending-ticket metadata never includes raw arg values beyond the canonical envelope fields; approval summaries must be secret-free.

### Documentation / conformance tests

- Add/readme tests or source scans ensuring docs do not instruct users to call approval/trust/policy mutation tools from ADK.
- If MCP subset filtering is added, test CLI parsing, library options, and generated tool list behavior.
- Ensure default CI remains skip-clean locally and only fails when explicit T202 env gates request ADK/live behavior.

## Documentation Updates

- `examples/adk/README.md`
  - add a T202 section explaining native long-running mode;
  - show how to build an agent/tool bundle with `LongRunningFunctionTool` wrappers;
  - explain pending ticket metadata, resume flow, cleanup, and the difference from generic `mx_await_result` over MCP;
  - document that the agent can continue useful work while pending;
  - repeat that approvals are human/out-of-band and re-validated by the daemon.
- `examples/adk/long_running_tools.py` docstrings/comments
  - record verified ADK import paths and pending/resume API;
  - call out the secret boundary and no-authority behavior.
- `packages/mcp/README.md`
  - update the Google ADK section: generic `MCPToolset` remains T201; native pending tickets are available via the T202 helper.
- `docs/mx-agent-tool-fabric-design.md`
  - after implementation, update the Google ADK bullet to state that `mx_delegate_tool` / `mx_run_command` can be wrapped as ADK `LongRunningFunctionTool`s and summarize pending/resume behavior.
- `docs/backlog.md`
  - after implementation, mark T202 acceptance/status and note any staged/live-gated caveats; leave T206 incomplete.
- Optional future integration guide (T207)
  - leave enough precise docs for a consolidated runtime guide.

## Risks and Open Questions

- **ADK API uncertainty:** the exact `LongRunningFunctionTool` import path, pending-ticket shape, and resume API are not verified in this environment. This is the first implementation step and the largest blocker.
- **Agent continues while pending:** ADK may define "long-running" as pausing the current tool call until a function response is injected, rather than allowing fully concurrent model turns. The acceptance test must be written against the verified ADK semantics and prove a second tool/action can occur while the ticket remains unresolved.
- **Tool composition / duplicate names:** it is unknown whether ADK can expose individual MCP tools or filter an MCPToolset. If not, implementing T202 without duplicate `mx_delegate_tool` / `mx_run_command` names may require a small generic MCP filtering API.
- **Python helper vs package:** a helper under `examples/adk` may be sufficient for M2, but users may later want a supported Python package. Do not imply a published `mx_loom_adk` API exists unless maintainers decide to create one.
- **Schema generation:** ADK may not accept JSON Schema directly for `LongRunningFunctionTool`. If Python signatures must be hand-written, drift guards are required to preserve the canonical descriptor contract.
- **`wait_ms` semantics:** canonical descriptors expose optional `wait_ms`, but ADK-native long-running behavior should not block on human approvals. Decide whether the native wrapper ignores, caps, or documents `wait_ms` differently.
- **Underlying MCPToolset lifecycle:** if the private MCPToolset is not itself in `LlmAgent.tools`, verify extracted MCP tool objects remain valid and that close/shutdown is explicit.
- **Background polling:** a naive background poller can leak tasks or hammer the daemon. Use bounded intervals, cleanup on session close, and T103 semantics.
- **Idempotency across ADK retries:** need a stable per-function-call id to generate/reuse idempotency keys. If ADK does not expose one, the helper must create and store one in `ToolContext`/pending state.
- **Audit duplication:** routing through `@mx-loom/mcp` should already tap audit. Python resume code should not write its own rows unless a future package introduces an explicit audit sink.
- **Two-daemon fixture availability:** live approval e2e depends on the golden policy/approval tool fixture. Tests must fail red when requested but fixture variables, daemon, `google-adk`, or `mx-loom-mcp` command are missing.
- **Operator decision vocabulary:** tests rely on existing out-of-band scripts/CLI. If daemon approval CLI vocabulary changes, the e2e should fail red, not simulate approval inside the model/runtime.
- **Safe env application:** as in T201, if ADK's stdio spawn ignores `env`, the helper must use a sanitized launcher or require a scrubbed host env.
- **Crash recovery:** pending tickets stored only in process memory are lost on host crash. Durable recovery is M3/T302; document the limitation.

## Implementation Checklist

1. Verify dependencies are present and green in the current baseline:
   - T103 `mx_await_result` exists and tests pass;
   - T201 ADK `MCPToolset` example/e2e exists and uses safe env/session flags;
   - `mx-loom-mcp --stdio` is runnable via the existing launcher pattern.
2. Pin/verify the Google ADK version for T202:
   - `LongRunningFunctionTool` import and constructor;
   - pending signal shape;
   - resume/function-response API;
   - access to `ToolContext` and function call id;
   - support for async functions;
   - support for individual MCP tool objects or filtering.
3. Decide composition strategy to avoid duplicate names:
   - prefer ADK individual-tool filtering;
   - otherwise use ADK `tool_filter` if available;
   - only then add a generic fail-closed MCP include/exclude filter with tests/docs.
4. Add the ADK long-running helper under `examples/adk`:
   - private safe `MCPToolset` construction using existing T201 helpers;
   - long-running wrappers for `mx_delegate_tool` and `mx_run_command`;
   - pending-ticket store keyed by ADK function call id;
   - resolver that calls `mx_await_result` through MCP;
   - cleanup/close method.
5. Implement envelope extraction and validation in the Python helper:
   - prefer structured content;
   - parse JSON text fallback;
   - reject malformed envelopes with secret-free errors.
6. Implement idempotency handling:
   - preserve supplied key;
   - generate once per ADK function call when omitted;
   - reuse on initial-call retry;
   - never re-dispatch during resume.
7. Implement pending conversion:
   - terminal statuses return final T102 envelope;
   - `running` / `awaiting_approval` produce ADK pending tickets;
   - pending metadata is secret-free and includes handle/audit/approval.
8. Implement resume:
   - poll with bounded `wait_ms` using `mx_await_result`;
   - still-pending remains pending, not timeout;
   - terminal result completes the original ADK function call;
   - duplicate resume is idempotent.
9. Add unit/static tests for schema drift, duplicate names, pending conversion, resume, idempotency, secret-free metadata, and no authority verbs.
10. Add gated ADK smoke tests against fake pending/terminal results.
11. Add live T202 e2e under `packages/golden`:
    - initial approval-gated `mx_delegate_tool` returns pending;
    - another tool succeeds while pending;
    - out-of-band approval occurs;
    - resume returns terminal `ok`;
    - optional `mx_run_command` approve and delegation denial paths;
    - no fake secrets leak;
    - audit correlation is present.
12. Update `examples/adk/README.md`, `packages/mcp/README.md`, `docs/mx-agent-tool-fabric-design.md`, and `docs/backlog.md` after implementation.
13. Run relevant checks:
    - TypeScript typecheck/tests for touched packages;
    - Python helper smoke;
    - gated ADK long-running smoke/e2e when env vars are set;
    - secret-boundary scans.
14. Confirm before completion:
    - no model-facing trust/policy/approval mutation tool exists;
    - no secret-shaped env or arg crosses Boundary A;
    - all ADK-visible results are valid T102 envelopes;
    - pending approval is only observed/resumed, never granted by cognition.
