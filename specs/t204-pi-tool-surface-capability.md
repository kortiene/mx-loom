# T204 · Pi Tool-Surface Capability Decision

> GitHub issue **#26** · `area/pi` `type/spike` `priority/P0` · Estimate **S** · Milestone **M2 — Universal binding**
> Source: `docs/backlog.md` (`T204`). This is a planning/spec document only; it does **not** implement the Pi binding.

## Problem Statement

The M2 roadmap requires mx-loom to expose the same canonical `mx_*` tool surface to Pi (`@earendil-works/pi-coding-agent`) that it exposes to Claude, ADK, OpenCode, and custom runners. The design intentionally left the Pi path unresolved: consume the generated MCP server if Pi supports MCP, otherwise register the canonical descriptors through Pi's native tool-registration API.

The current gap is a recorded decision. Without it, T205 (`binding: Pi`) cannot choose its dependency path or implementation shape, and T206 (`portability matrix`) cannot plan how the Pi arm will execute the golden scenario.

**Decision recorded by this spike (the issue's sole acceptance criterion).** The literal question — "MCP vs native registration for Pi" — resolves to **three** options, not a binary:

1. **Built-in MCP client: NO.** Pi ships no MCP client. There is no `--mcp` flag, no `mcpServers` config, and no MCP entry in `settings.json`/`opencode.json`-style consumption. mx-loom cannot point Pi at `@mx-loom/mcp` (stdio or Streamable-HTTP) the way ADK (`MCPToolset`) or OpenCode (`mcp` entry) can.
2. **MCP via a Pi extension: POSSIBLE but build-it-yourself.** Pi explicitly blesses "MCP server integration" as a thing an *extension* can add (README "What's possible"). This is a future option, not a capability mx-loom can rely on today, because it would require mx-loom to first write and ship a generic Pi-side MCP *client* extension — strictly more work than, and on top of, native registration.
3. **Native tool registration: YES, first-class.** Pi's primary, documented extensibility path is registering custom tools.

**Therefore the decision is: native Pi tool registration for T205.** Generate Pi `ToolDefinition[]` / extension registrations from `@mx-loom/registry` descriptors and route execution through the same registry handlers + toolbelt daemon seam. Do not run `@mx-loom/mcp` inside Pi; revisit only if Pi later ships a built-in MCP client, or if a generic Pi MCP-client extension is independently justified.

Evidence from the installed Pi package (`@earendil-works/pi-coding-agent`, version `0.74.2` observed locally — re-confirm at the target version):

- README **Philosophy** (line 472): **"No MCP.** Build CLI tools with READMEs … or build an extension that adds MCP support." — no built-in MCP; extension-mediated MCP is the blessed escape hatch.
- README **Extensions "What's possible"** (line 368): lists **"MCP server integration"** as an extension capability — confirming option 2 is sanctioned but self-built.
- `docs/usage.md` Design Principles: Pi "intentionally does not include built-in MCP, sub-agents, permission popups, plan mode …" and pushes such workflows into extensions/packages.
- Pi exposes first-class native custom tools: SDK `createAgentSession({ customTools })` + `defineTool()`, and extension-time `pi.registerTool()` (verified in `docs/sdk.md`, `docs/extensions.md`, and the `dist/*.d.ts` type surface).

## Goals

- Record the Pi integration decision: **native registration, not MCP**, for the currently documented Pi capability set.
- Identify the follow-on T205 owning package/module shape without implying it already exists.
- Define how Pi-native tools should be generated from the canonical mx-loom descriptor set without hand-authoring a separate tool list.
- Preserve the T102 result envelope, deferred-result semantics (`running` / `awaiting_approval` + `mx_await_result`), idempotency, error taxonomy, audit correlation, and secret-free contract across the Pi boundary.
- Define enough tests and documentation updates for a later coding agent to implement and verify the Pi binding.
- Keep T204 itself small: a decision/documentation spike, not a runtime feature implementation.

## Non-Goals

- Do not implement `@mx-loom/pi` or any Pi binding code in T204.
- Do not implement a generic MCP client for Pi or modify Pi itself.
- Do not run or require the Pi golden scenario in this spike; that belongs to T205/T206.
- Do not add trust, policy, approval, auth, device, daemon, or other operator authority tools to the model surface.
- Do not change the canonical registry descriptors, result-envelope schema, daemon RPC methods, idempotency-key contract, or audit-row schema.
- Do not implement ADK, OpenCode, Claude, task-DAG, governance UX, multi-tenant, or publication work.
- Do not broaden environment forwarding or introduce any new place where credentials can enter model-visible tool inputs/outputs.

## Relevant Repository Context

The stack is TypeScript, pnpm workspace, Node >=20.19, vitest, ESM, and Apache-2.0.

Repository-status note: the prompt and root README describe the repo as docs-only/design-phase, but this checkout already contains implemented packages under `packages/*`. For this issue, the important source-tree fact is narrower and still true: **there is no Pi binding package or module yet**. If this spec is applied to an earlier docs-only branch, treat the package names below as planned names from the design/backlog rather than existing source.

Relevant mx-loom architecture and packages:

- `docs/mx-agent-tool-fabric-design.md` defines the hard boundary: runtimes own cognition; mx-agent owns coordination; mx-loom only adapts tool calls. Boundary A is the runtime tool ABI; Boundary B is the daemon Unix-socket JSON-RPC surface. The model can only produce signed requests; trust, policy, sandboxing, signing, and approval remain out-of-process on the receiving daemon.
- `docs/backlog.md` places T204 in M2 (`Universal binding`) and marks it as an early P0 spike. T205 (`binding: Pi`) depends on T204 and either T109 if Pi uses MCP, or the registry path if native. Since the decision is native, T205 should be planned around the registry/toolbelt path rather than the MCP protocol.
- `packages/registry` exists in this checkout and exports the canonical M1 descriptors (`CANONICAL_M1_TOOLS`), T102 envelope helpers, error taxonomy, idempotency helpers, no-authority invariants, and handlers for the nine model-facing verbs.
- `packages/toolbelt` exists and owns `MxClient` / `MxSession`, daemon transport, session registration, deny-by-default subprocess environment allowlist, outbound credential-shaped argument rejection, and inbound redaction.
- `packages/mcp` exists and is useful reference code for generated tool listing, handler dispatch, binding context, serialization, and audit tapping. It should not be treated as the Pi runtime integration path now that Pi is native-only.
- `packages/audit` exists and provides the best-effort `withAudit` tap and sinks.
- `packages/claude` exists and contains a JSON Schema -> Zod converter. Pi needs TypeBox schemas, so that converter is not directly reusable except as a pattern.
- **Missing today:** no `packages/pi`, no `@mx-loom/pi`, no Pi JSON Schema -> TypeBox adapter, no Pi-native `ToolDefinition[]` generator, no Pi extension wrapper, no Pi golden/conformance arm.

Relevant Pi capability findings from the installed package docs/source:

- Installed `@earendil-works/pi-coding-agent` observed locally: package `version` is `0.74.2`, `engines.node` is `>=20.6.0`, and it bundles `typebox@^1.1.24` (verified in its `package.json`). The TypeBox version matters because Pi tool `parameters` are TypeBox `TSchema`. Confirm all three at the target version during implementation because Pi APIs may drift (note: the existing `adw_sdlc/src/runners/runner-pi.ts` documents that a newer Pi engines floor of `>=22.19.0` was observed for a different installed build — so the engines floor is itself version-dependent and must be re-checked).
- Pi documents **no built-in MCP client** but **blesses MCP-via-extension**. The README Philosophy says "No MCP" (build an extension if you want it); the README Extensions list includes "MCP server integration" as an extension capability; `docs/usage.md` Design Principles repeats that Pi intentionally omits built-in MCP and pushes such workflows into extensions/packages. Net: mx-loom cannot mount `@mx-loom/mcp` into Pi without first building a Pi-side MCP client extension, so native registration is the lower-effort, lower-surface path.
- Pi supports native tools:
  - SDK: `createAgentSession({ customTools: [tool] })`.
  - Extension API: `pi.registerTool(tool)` during extension load or after startup.
  - Tool definition shape: `ToolDefinition<TParams extends TSchema>` with `name`, `label`, `description`, `parameters` (TypeBox `TSchema`), optional prompt metadata/rendering, and `execute(toolCallId, params, signal, onUpdate, ctx)` returning `AgentToolResult`.
  - CLI/session controls: `--tools <list>`, `--no-builtin-tools`, `--no-tools`, `-e/--extension`, package loading, `pi.getAllTools()`, and `pi.setActiveTools()`.
- Pi tool results do not provide MCP `structuredContent`; returned `content` is what the model sees, and `details` is available for state/rendering. Throwing from `execute()` marks a Pi tool as failed. Therefore the Pi binding should explicitly preserve the mx-loom envelope in returned content/details rather than depend on MCP-style structured result channels.

## Proposed Implementation

### T204 spike deliverable

Record the decision in repository documentation:

1. Add a concise decision record, recommended path: `docs/pi-tool-surface-capability.md`, stating: **Pi currently needs native registration; MCP is not built in.** Include the evidence summary and the impact on T205 dependencies.
2. Update `docs/backlog.md` T204 status to landed/decided and update T205 dependency wording to the native path.
3. Update `docs/mx-agent-tool-fabric-design.md` (the "Pi SDK (`@earendil-works/pi-coding-agent`)" bullet, around line 114–115, which currently reads "Consume via MCP if the Pi build supports it; otherwise register the canonical descriptors through Pi's native tool-registration API …") to record the resolved decision: **Pi has no built-in MCP client today, so the Pi binding uses native tool-registration**; MCP remains only a possible future *extension-mediated* path if a Pi-side MCP client is built or Pi adds one. Keep the "thin map from the canonical registry" framing intact. Also confirm the M2 milestone row (line 267) does not over-promise an MCP path for Pi.

This spec itself records the decision for planning purposes; the later T204 implementation should make that decision visible in the long-lived docs/backlog.

### Recommended T205 implementation path: native Pi binding

Create a new leaf package, proposed name **`@mx-loom/pi`** at `packages/pi`, that generates Pi-native tool definitions from the canonical registry and executes them through the existing mx-loom handler/toolbelt seam.

#### Public surface

Recommended exports:

- `createPiBindingContext(options?)`: opens or binds an mx-loom daemon/session context analogous to the MCP binding context, returning `{ daemon, room, correlationId, auditSink, close }`.
- `createPiToolDefinitions(ctx, options?)`: returns the generated Pi `ToolDefinition[]` for all canonical model-facing verbs.
- `registerMxTools(pi, options?)`: extension helper that registers the generated tools through `pi.registerTool()` and arranges cleanup on `session_shutdown` if this helper opened the session.
- `createMxPiExtension(options?)`: optional `ExtensionFactory` for use with Pi `-e` / package loading.
- A default extension export can be considered for easy `pi -e @mx-loom/pi`, but only if package loading semantics are verified.

**Pi SDK dependency strategy (decision to confirm in T205).** Two precedents in this repo pull in opposite directions and must be reconciled:
- `packages/claude` declares `@anthropic-ai/claude-agent-sdk` as a **`peerDependency`** (+ devDependency) so the host owns the single SDK instance. The same pattern fits a `@mx-loom/pi` library that registers tools *into* a host-owned Pi session via `customTools`/`registerTool`.
- `adw_sdlc/src/runners/runner-pi.ts` deliberately drives the `pi` CLI as a subprocess and stays **import-free** precisely because Pi's npm `engines` floor can make Pi an `optionalDependency` that vanishes on older Node, which a static SDK type-import would turn into a typecheck break.

Recommendation for the native binding: declare `@earendil-works/pi-coding-agent` (and `typebox`, and `@earendil-works/pi-ai` for `StringEnum`) as **`peerDependencies`** with matching devDependencies, and import Pi types **`type`-only** wherever possible so the package type-checks even if the peer is absent. Confirm the exact peer ranges against the pinned target Pi version (the bundled TypeBox is `^1.x`, so pin TypeBox to Pi's major to avoid a split TypeBox runtime).

#### Descriptor -> Pi tool generation

- Enumerate `CANONICAL_M1_TOOLS`; do not hand-author a Pi-specific tool list.
- For each descriptor, create a Pi `ToolDefinition`:
  - `name`: descriptor `name` (e.g. `mx_delegate_tool`).
  - `label`: human-readable version of the name.
  - `description`: descriptor `description`.
  - `promptSnippet`: one-line summary that names the tool explicitly.
  - `promptGuidelines`: bullets that explain envelope statuses and especially `awaiting_approval` -> call `mx_await_result` later.
  - `parameters`: TypeBox schema adapted from descriptor `input_schema`.
  - `execute`: dispatches to the registry handler and returns the normalized envelope as a Pi tool result.
- Schema conversion recommendation:
  - First verify whether TypeBox `Type.Unsafe()` / `Unsafe()` can wrap the existing draft-07 JSON Schemas while still allowing Pi's validator to enforce them. (Confirmed present in the bundled TypeBox build: both `Type.Unsafe` and a top-level `Unsafe` exist; `Unsafe(schema)` returns the schema tagged with a `~unsafe` marker, i.e. it carries the JSON Schema for serialization to the model but does **not** by itself add runtime validation.) If Pi's tool pipeline validates `Unsafe`-wrapped schemas adequately, use that with fail-closed preflight validation against `loadRegistry()` / Ajv; if it does not validate them, treat `Unsafe()` as serialization-only and fall through to a converter.
  - If `Unsafe()` is insufficient for Pi's runtime validation, implement a small JSON Schema -> TypeBox converter for the subset used by `CANONICAL_M1_TOOLS`, modeled after `packages/claude`'s fail-closed converter. Unsupported constructs must throw at build/startup, never degrade to permissive `Any`.
  - **Verified edge case — enums.** `CANONICAL_M1_TOOLS` input/output schemas contain seven `enum` string fields (e.g. `liveness: ['active','stale','offline']` in `mx_find_agents`/`mx_workspace_status`; `kind: ['file','diff','env']` and `encoding: ['utf-8','base64']` in `mx_share_context`/`mx_get_context`). Pi's `docs/extensions.md` (and `@earendil-works/pi-ai`) explicitly warns: **use `StringEnum(...)` for string enums; `Type.Union`/`Type.Literal` does not work with Google's API.** A converter (or a hand-tuned `Unsafe` path) must emit `StringEnum` for descriptor `enum` fields, not `Type.Union`/`Type.Literal`, so the generated tools work across Pi's supported providers. The schema-equivalence tests must include each enum field.
  - Add equivalence tests: Pi/TypeBox validation must accept/reject the same representative samples as the registry Ajv seam for all canonical input schemas, including the enum fields above.

#### Execution flow

For each generated Pi tool:

1. Pi validates `params` using the native TypeBox `parameters` schema.
2. The tool's `execute()` calls a shared name->handler dispatch function with the input and the binding context.
3. The registry handler builds a T102 `ToolResult` envelope. For mutating verbs, handlers preserve/generate `idempotency_key` as already specified. For daemon calls, the toolbelt `MxClient` / `MxSession` rejects credential-shaped args and redacts inbound token-shaped values.
4. Apply the `withAudit` tap once at the Pi binding result-return chokepoint.
5. Serialize the envelope to Pi's `AgentToolResult`:
   - `content`: one text block containing JSON for the full envelope (`status`, `result`, `error`, `handle`, `approval`, `audit_ref`).
   - `details`: the same envelope for session/rendering/test inspection.
   - Do **not** throw for ordinary envelope statuses, including `denied`, `awaiting_approval`, `running`, or `error`; returning the envelope preserves the mx-loom contract for the model. Reserve throws for unexpected adapter bugs, and catch/convert those to `errored('internal', ...)` where possible.
6. For `awaiting_approval` and `running`, the content/guidelines must clearly instruct the model to call `mx_await_result` with the returned `handle`. Pi has no native long-running-tool protocol equivalent to ADK's `LongRunningFunctionTool`; the generic deferred-result protocol remains model-visible.

#### Avoid an MCP proxy inside Pi

Do not spawn `mx-loom-mcp` from the Pi binding as the default path. That would add a protocol hop and process lifecycle surface while still requiring a native Pi extension to expose tools. Since Pi already supports native tools, T205 should bind directly to the registry/toolbelt seam. A future optional package could implement a generic Pi MCP-client extension, but that is not needed for mx-loom's Pi arm.

#### Reuse vs extraction

`packages/mcp` contains useful patterns (`createBindingContext`, dispatch, audit chokepoint, envelope serialization), but a Pi-native package should avoid making MCP the conceptual owner of non-MCP binding utilities. During T205, either:

- duplicate the small dispatch/context glue in `@mx-loom/pi`, or
- extract shared binding-neutral glue into a new internal package (for example `@mx-loom/binding-core`) if duplication becomes material.

Do not change the canonical descriptors or handlers to accommodate Pi.

## Affected Files / Packages / Modules

T204 decision/documentation phase:

- `docs/pi-tool-surface-capability.md` — new decision record (recommended).
- `docs/backlog.md` — update T204 status and T205 dependency note.
- `docs/mx-agent-tool-fabric-design.md` — update Pi row/wording in runtime-consumption section.
- `specs/t204-pi-tool-surface-capability.md` — this planning/spec file.

Follow-on T205 implementation phase:

- New `packages/pi/` (`@mx-loom/pi`) — does not exist yet.
- Likely new modules under `packages/pi/src/`:
  - `index.ts`
  - `context.ts`
  - `tools.ts`
  - `dispatch.ts` or shared dispatch import if extracted
  - `schema-to-typebox.ts` or `unsafe-schema.ts`
  - `serialize.ts`
  - `extension.ts`
- Likely tests under `packages/pi/test/`:
  - generated tool list
  - schema equivalence
  - dispatch/execution
  - SDK/customTools integration
  - extension registration
  - secret-boundary/redaction
  - audit tap
- Existing packages to read/reuse, not necessarily modify:
  - `packages/registry`
  - `packages/toolbelt`
  - `packages/audit`
  - `packages/mcp` as reference only
  - `packages/golden` for future Pi arm patterns
- Pi upstream docs/source to re-check during implementation:
  - Pi `README.md`
  - Pi `docs/sdk.md`
  - Pi `docs/extensions.md`
  - Pi `docs/usage.md`
  - Pi examples for `hello.ts`, `dynamic-tools.ts`, and SDK tools

## API / Interface Changes

T204 itself: **none** beyond documentation.

Expected T205 public API additions if this decision is implemented:

- New package `@mx-loom/pi`.
- Public helper to generate Pi native tools, e.g. `createPiToolDefinitions(ctx, options?)`.
- Public helper to bind/open a daemon session, e.g. `createPiBindingContext(options?)`.
- Extension helper, e.g. `registerMxTools(pi, options?)` and/or `createMxPiExtension(options?)`.
- No new daemon RPC methods.
- No changes to existing `@mx-loom/registry`, `@mx-loom/toolbelt`, `@mx-loom/mcp`, `@mx-loom/claude`, or `@mx-loom/audit` public APIs unless shared binding glue is intentionally extracted.
- No Pi MCP configuration is expected because Pi lacks built-in MCP support.

## Data Model / Protocol Changes

- No change to the canonical `ToolDescriptor` model.
- No change to the T102 result envelope shape:
  - `status: "ok" | "running" | "awaiting_approval" | "denied" | "error"`
  - `result`
  - `error.code` from the closed taxonomy
  - `handle`
  - `approval`
  - `audit_ref` on every result
- No change to the daemon RPC protocol.
- No change to idempotency-key semantics; mutating verbs continue to accept/pass `idempotency_key` per their descriptors/handlers.
- No change to audit-row schema.
- New Pi adapter serialization convention for T205:
  - Pi tool result `content[0].text` contains the full mx-loom envelope as JSON.
  - Pi tool result `details` contains the full envelope for rendering/test/state inspection.
  - Pi's thrown-error channel is not the primary representation of mx-loom `status:"error"`; the envelope remains the source of truth.
- New Pi adapter schema convention for T205:
  - Descriptor draft-07 JSON Schema is adapted to TypeBox `TSchema` via verified `Unsafe()` wrapping or a fail-closed subset converter.

## Security & Compliance Considerations

- **Secret boundary remains mandatory.** Matrix tokens, Ed25519 signing keys, provider keys, and `GH_TOKEN` must never cross Boundary A into the runtime process, model context, or runner children as mx-loom tool data. The toolbelt enforces a deny-by-default env allowlist; runner children receive retrieved TEXT only, never credentials. If Pi itself needs provider authentication to call a model, that is outside the mx-loom tool contract and must not be read, copied, logged, or forwarded by the Pi binding.
- **No credentials in tool fields.** No Pi tool input, output, `details`, prompt metadata, or log line may carry credentials inbound or outbound. Credential-shaped args must be rejected before daemon dispatch via the concrete `MxClient` / `MxSession` guard. Token-shaped daemon values must be redacted before model-visible serialization.
- **Out-of-process enforcement is unchanged.** Trust (Ed25519 trust store), deny-by-default `policy.toml`, sandbox, and human approval gates execute on the receiving mx-agent daemon. The Pi binding only translates a native Pi tool call into a daemon-backed request and returns the daemon's envelope.
- **Cognition cannot grant authority.** Pi/the model can only ask for `mx_*` requests; it cannot approve, change trust, mutate policy, access Matrix credentials, or sign independently. The binding must not expose `trust.*`, `approval.decide`, `policy.*`, `auth.*`, `device.*`, `daemon.*`, or any equivalent mutation surface.
- **Approval semantics stay model-visible but non-authoritative.** Approval reaches Pi only as `status:"awaiting_approval"` with `handle` and non-secret `approval` metadata. Release is re-validated against live policy on the daemon. The model is never given an approval mutation tool.
- **Audit correlation.** Every Pi tool result must include `audit_ref`; if the daemon has not returned concrete ids, the all-null structural `audit_ref` remains present rather than being fabricated. The T205 Pi binding should apply `withAudit` once at the result-return chokepoint.
- **Logging and redaction.** Never log Matrix tokens, signing keys, provider keys, `GH_TOKEN`, raw args, raw env, or token-shaped values. Prefer logging tool name, status, correlation id, and audit ids only. Audit sink failures must be best-effort and secret-free, never blocking tool results.
- **Pi extension/package trust.** Pi extensions run with full system permissions. The mx-loom Pi extension/package must be small, auditable, and must not call `pi.exec()` or spawn child processes for normal operation. It should reach mx-agent only through the toolbelt daemon client.
- **Tool allowlist discipline.** Pi users can enable/disable tools with `--tools`, `--no-tools`, `pi.setActiveTools()`, etc. The binding must register only the canonical model-facing `mx_*` verbs and should document how operators can allowlist only those tools if desired.

## Testing Plan

T204 documentation/spike tests:

- Documentation review: confirm the decision doc cites Pi's no-MCP statements and native tool APIs.
- Backlog/design consistency check: T204 status and T205 dependency path agree with the decision.
- Gated e2e smoke (`packages/golden/test/t204-pi-capability.e2e.test.ts`): with
  `MXL_PI_CAPABILITY_E2E=1` and `MXL_PI_PACKAGE_ROOT=/path/to/@earendil-works/pi-coding-agent`,
  assert the real installed Pi package has no built-in MCP CLI/config surface and that native
  `customTools` plus extension `pi.registerTool()` register executable `AgentTool`s without
  Matrix, mx-agent daemons, model/provider keys, or secret-bearing environment. The smoke also
  grounds Risk #3: a real canonical-registry `enum` value-set (from `CANONICAL_M1_TOOLS`)
  survives `StringEnum` -> live-Pi-TypeBox registration in the Google-compatible
  `{ type: 'string', enum: [...] }` shape (not `Type.Union`/`oneOf`).

Follow-on T205 tests:

- **Unit — generated tools:** generated Pi tool names exactly match `CANONICAL_M1_TOOLS`; no forbidden authority verbs are registered; descriptions/prompt snippets are non-empty and name the relevant tool explicitly.
- **Unit — schema adapter:** for each canonical input schema, TypeBox/Pi validation accepts and rejects the same representative samples as registry Ajv validation. Unsupported schema constructs fail closed at startup/test time.
- **Unit — execution/serialization:** fake daemon responses for all envelope statuses (`ok`, `running`, `awaiting_approval`, `denied`, `error`) serialize to Pi `AgentToolResult` content/details with the full envelope and `audit_ref` intact.
- **Unit — deferred semantics:** `awaiting_approval` and `running` results carry `handle`; `mx_await_result` can be called as a normal generated Pi tool and returns terminal envelopes after fake daemon state changes.
- **Unit — idempotency:** `mx_delegate_tool` and `mx_run_command` pass caller-supplied `idempotency_key` through and generate one when omitted, using the existing handler contract.
- **Unit — secret boundary/redaction:** credential-shaped args are rejected as `invalid_args` before dispatch; token-shaped fake daemon values are redacted in returned content/details; no logs contain the secret value.
- **Unit — audit:** one `withAudit` tap invocation per tool result using `InMemoryAuditSink`; sink failures are swallowed and do not alter the envelope.
- **SDK integration:** create a Pi `AgentSession` with generated `customTools` and assert the tools appear in `session.agent.state.tools` / `pi.getAllTools()` equivalent without requiring a real model call.
- **Extension integration:** load/register through `registerMxTools(pi, ...)` or `createMxPiExtension()` in a test extension harness; assert dynamic registration and active-tool selection work.
- **End-to-end/conformance:** add the Pi arm to the M2 portability matrix (T206) so the same golden scenario runs under Pi with the native binding. Live daemon/model tests must be gated and fail-not-skip in CI when explicitly enabled; do not assume green without the fixture.
- **Version compatibility:** pin or assert the Pi SDK version/API used by T205 (`ToolDefinition`, `defineTool`, `customTools`, `registerTool`, TypeBox version) so future Pi changes produce actionable failures.

## Documentation Updates

- Add `docs/pi-tool-surface-capability.md` with:
  - Decision: **native registration**.
  - Evidence: no built-in MCP in Pi docs; native custom tool APIs exist.
  - Consequence: T205 should create `@mx-loom/pi` using native `ToolDefinition` generation.
  - Revisit condition: if Pi later ships built-in MCP client support, re-evaluate whether `@mx-loom/mcp` can be mounted directly.
- Update `docs/backlog.md`:
  - Mark T204 as landed/decided.
  - Update T205 dependencies to reflect native path (`T204` + registry/toolbelt handler stack; `T109` optional/reference, not required for MCP protocol consumption).
  - Note that T206's Pi arm will use native registration.
- Update `docs/mx-agent-tool-fabric-design.md`:
  - Replace the unresolved Pi wording in the "Pi SDK" bullet (line ~114–115) with the recorded decision (no built-in MCP → native registration; MCP only via a future extension).
  - Confirm the M2 milestone-table Pi entry (line ~267) matches.
  - Keep the build rule: one canonical descriptor set generates bindings; do not hand-author Pi tools.
- Update `docs/backlog.md` open-question #4 ("Pi MCP support unknown — T204 resolves; T205's shape depends on it", ~line 575): mark it resolved — native registration.
- Later, update `packages/pi/README.md` (when T205 exists): SDK usage, extension usage, tool allowlisting, deferred-result pattern, secret-boundary statement, and audit opt-in.
- Later, update T207 per-runtime integration guide after T206 verifies the Pi path.

## Risks and Open Questions

1. **Pi API/version drift + engines floor.** The local install is `0.74.2` (`engines.node >=20.6.0`, bundled `typebox@^1.1.24`), but `adw_sdlc/src/runners/runner-pi.ts` documents a `>=22.19.0` engines floor for a different observed build — so the floor itself is version-dependent. The exact version used by CI/release must be pinned or checked, and the import strategy (peer + `type`-only) must keep mx-loom's `>=20.19` baseline type-checking even when the Pi peer is absent or floors higher. If Pi adds first-class built-in MCP later, revisit the native-vs-MCP decision.
2. **TypeBox adaptation uncertainty.** Both `Type.Unsafe` and `Unsafe` exist in Pi's bundled TypeBox, but `Unsafe(schema)` only tags the schema (`~unsafe`) for serialization — it is **not** confirmed to add runtime validation in Pi's tool pipeline. T205 must verify whether `Unsafe`-wrapped schemas are validated by Pi; if not, build a fail-closed JSON Schema -> TypeBox converter for the canonical subset.
3. **Enum encoding portability.** Descriptor `enum` fields must be emitted as `StringEnum` (not `Type.Union`/`Type.Literal`) for Google-provider compatibility per Pi's docs. A converter that naively maps `enum` to `Type.Union` would pass mx-loom's Ajv equivalence test yet silently break Pi runs on Google models. Equivalence tests must cover every enum field, and ideally a Google-shaped serialization assertion.
4. **No native structured result channel.** Pi tools return model-visible content and details, not MCP `structuredContent`. Returning JSON text may be less ergonomic for models than MCP structured content. Mitigation: consistent envelope JSON and explicit prompt guidelines.
5. **Pi error signaling.** Throwing marks Pi tool execution as failed, but may discard structured envelope details. Recommendation is to return the envelope for all normal mx-loom statuses and reserve throws for adapter bugs; confirm this behavior with Pi's tool-result serialization.
6. **Pi SDK dependency mode.** `peerDependency` (claude precedent, in-process registration) vs CLI-subprocess/import-free (runner-pi precedent). Recommendation: peer + `type`-only imports for the native library; confirm in T205.
7. **Shared binding glue ownership.** `packages/mcp` already has dispatch/context code. T205 must decide whether to duplicate small glue or extract a binding-neutral shared package to avoid making Pi depend conceptually on MCP.
8. **Extension permissions.** Pi extensions execute with full local permissions. The mx-loom extension must be narrowly scoped and avoid local exec/env reads beyond what the toolbelt needs.
9. **Active tool selection.** Pi users can disable tools. T205 tests and docs must make clear how to enable the generated `mx_*` tools and how this composes with built-in tools.
10. **Runtime/provider secrets.** Pi may normally use provider keys for its own model calls. The mx-loom binding must not inspect or forward those keys and must keep mx-agent/Matrix/GitHub secrets out of model-visible payloads.
11. **Live verification availability.** The Pi golden arm depends on the same two-daemon fixture and possibly a model-capable Pi setup; tests must distinguish daemon-free unit coverage from gated live conformance.

## Implementation Checklist

T204 spike/documentation checklist:

1. Re-check the target `@earendil-works/pi-coding-agent` version docs for MCP support and native tool APIs.
2. Create `docs/pi-tool-surface-capability.md` recording the decision: **native registration for Pi**.
3. Cite evidence from Pi README/usage/sdk/extensions docs.
4. Update `docs/backlog.md` T204 status and T205 dependency note.
5. Update `docs/mx-agent-tool-fabric-design.md` Pi runtime row/paragraph.
6. Do not add runtime code in T204.

Follow-on T205 implementation checklist:

1. Scaffold `packages/pi` as `@mx-loom/pi` with TypeScript, vitest, Apache-2.0, Node >=20.19, and Pi SDK dependency/peer-dependency decisions.
2. Implement or verify the descriptor JSON Schema -> TypeBox `TSchema` adapter; fail closed on unsupported schema constructs.
3. Implement `createPiBindingContext()` using toolbelt `openSession()` / injected daemon/session and optional audit sink.
4. Implement generated `ToolDefinition[]` from `CANONICAL_M1_TOOLS`; assert no forbidden authority verbs.
5. Implement name->handler dispatch with the correct deps subtype for each handler.
6. Implement Pi envelope serializer (`ToolResult` -> `AgentToolResult` content/details) preserving all statuses, handles, approval metadata, error codes, and `audit_ref`.
7. Apply `withAudit` once at the Pi result-return chokepoint.
8. Implement SDK helper (`createPiToolDefinitions`) and extension helper (`registerMxTools` / `createMxPiExtension`).
9. Add unit, integration, security/redaction, audit, schema-equivalence, and version-compatibility tests.
10. Add the Pi arm to the M2 portability/golden matrix only after the native binding is implemented; gate live daemon/model runs explicitly.
11. Document SDK and extension usage in `packages/pi/README.md` and later in the per-runtime guide.
