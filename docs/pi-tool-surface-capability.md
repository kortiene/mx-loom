# Pi tool-surface capability — decision record (T204)

| | |
|---|---|
| Issue | [`#26`](https://github.com/kortiene/mx-loom/issues/26) · T204 · `area/pi` `type/spike` `P0` |
| Milestone | M2 — Universal binding |
| Spec | [`specs/t204-pi-tool-surface-capability.md`](../specs/t204-pi-tool-surface-capability.md) |
| Status | **Decided — native tool registration** (this spike's sole acceptance criterion) |
| Date | 2026-06-23 |
| Pi version observed | `@earendil-works/pi-coding-agent@0.74.2` (`engines.node >=20.6.0`, bundled `typebox@^1.1.24`, `@earendil-works/pi-ai@^0.74.2`) — re-confirm at the pinned target version |

## Question

> **MCP vs native registration for Pi** — does `@earendil-works/pi-coding-agent`
> consume an MCP server (the way ADK's `MCPToolset` or OpenCode's `mcp` entry do),
> or must mx-loom register the canonical `mx_*` descriptors through Pi's native
> tool-registration API?

This is the M2 dependency gate for **T205 (`binding: Pi`)**: T205 cannot choose its
dependency path or implementation shape, and **T206 (`portability matrix`)** cannot
plan the Pi arm of the golden scenario, until this is recorded.

## Decision

**Pi has no built-in MCP client today, so the mx-loom Pi binding (T205) uses Pi's
native tool registration — not MCP.** Generate Pi `ToolDefinition[]` from the
canonical `@mx-loom/registry` descriptors and route execution through the same
registry handlers + `@mx-loom/toolbelt` daemon seam every other binding already uses.

The literal "MCP vs native" question resolves to **three** options, not a binary:

1. **Built-in MCP client — NO.** Pi ships no MCP client. There is no `--mcp` flag,
   no `mcpServers` config, and no MCP entry in any `settings.json` /
   `opencode.json`-style consumption surface. mx-loom **cannot** point Pi at
   `@mx-loom/mcp` (stdio or Streamable-HTTP) the way ADK (`MCPToolset`) or OpenCode
   (`mcp` entry) can.
2. **MCP via a Pi extension — POSSIBLE, but build-it-yourself.** Pi explicitly
   blesses "MCP server integration" as something an *extension* can add. This is a
   future option, not a capability mx-loom can rely on today: it would require
   mx-loom to first write and ship a generic Pi-side MCP **client** extension —
   strictly *more* work than, and *on top of*, native registration.
3. **Native tool registration — YES, first-class.** Pi's primary, documented
   extensibility path is registering custom tools (SDK `customTools` / `defineTool`,
   extension-time `pi.registerTool()`).

**Therefore: native Pi tool registration for T205.** Do **not** run `@mx-loom/mcp`
inside Pi. Revisit only if Pi later ships a built-in MCP client, or if a generic
Pi MCP-client extension is independently justified.

## Evidence (installed Pi `0.74.2`; re-confirm at target version)

No built-in MCP — extension-mediated MCP is the only blessed escape hatch:

- **README — Philosophy:** *"**No MCP.** Build CLI tools with READMEs … or build an
  extension that adds MCP support."* (`README.md` line ~472).
- **README — Extensions "What's possible":** lists **"MCP server integration"** as
  an extension capability (`README.md` line ~368) — confirming option 2 is
  sanctioned but self-built.
- **`docs/usage.md` — Design Principles:** Pi *"intentionally does not include
  built-in MCP, sub-agents, permission popups, plan mode …"* and pushes such
  workflows into extensions/packages (line ~275).

Native custom tools are first-class and documented:

- **SDK:** `createAgentSession({ customTools: ToolDefinition[] })` and `defineTool()`
  (`docs/sdk.md`; `customTools?: ToolDefinition[]` verified in `dist/index.d.ts`).
- **Extension API:** `pi.registerTool(tool)` during extension load **or** after
  startup; new tools appear in `pi.getAllTools()` and become callable without
  `/reload` (`docs/extensions.md`).
- **Tool shape:** `ToolDefinition<TParams extends TSchema>` — `name`, `label`,
  `description`, optional prompt metadata (`promptSnippet`/`promptGuidelines`),
  `parameters` (TypeBox `TSchema`), and `execute(toolCallId, params, signal,
  onUpdate, ctx)` returning `AgentToolResult` (exported from `dist/index.d.ts`).
- **Session controls:** `--tools <list>`, `--no-builtin-tools`, `--no-tools`,
  `-e/--extension`, package loading, `pi.getAllTools()`, `pi.setActiveTools()`.

## Consequences for T205 (`binding: Pi`)

> **Delivered (T205, binding mechanism).** `@mx-loom/pi` now exists
> ([`packages/pi`](../packages/pi/README.md)) and implements every consequence
> below: generated `ToolDefinition[]` from `CANONICAL_M1_TOOLS`, the fail-closed
> JSON Schema → TypeBox converter with `enum → StringEnum`, dispatch through the
> registry/toolbelt seam, the T102 envelope serialized into `content`+`details`,
> the single `withAudit` tap, and the recommended public surface
> (`createPiBindingContext` / `createPiToolDefinitions` / `registerMxTools` /
> `createMxPiExtension`). Open Question #1 resolved as **reimplement dispatch/context
> locally** (no `@modelcontextprotocol/sdk` in Pi's dep graph). The TypeBox
> `Type`/`StringEnum` builders are **injected by the host** (peer + local ABI
> mirror) so there is a single TypeBox runtime and no heavy/native dependency leaks.
> The live "a Pi agent calls `mx_delegate_tool`" arm (the issue AC + the
> verification checklist below) is staged behind `MXL_PI_BINDING_E2E=1` + the
> two-daemon fixture, at `packages/golden/test/t205-pi-binding.e2e.test.ts`
> (skip-clean without the fixture, fail-not-skip in CI when requested).

- **Dependency path:** T205 is blocked-by **T204** (this decision) **+ the
  `@mx-loom/registry` / `@mx-loom/toolbelt` handler stack** — *not* the MCP protocol.
  **T109 (`@mx-loom/mcp`) is reference-only** for the Pi arm (its `dispatchCall` /
  `createBindingContext` / `serializeToolResult` are useful patterns), not a runtime
  dependency.
- **New leaf package:** create **`@mx-loom/pi`** at `packages/pi` that
  (a) generates Pi `ToolDefinition[]` from `CANONICAL_M1_TOOLS` (never hand-authored),
  (b) dispatches each `execute()` to the existing registry handler via the toolbelt
  `MxClient`/`MxSession` seam, and (c) serializes the **T102 envelope** into Pi's
  `AgentToolResult`. **This package does not exist yet and is out of scope for T204.**
- **Recommended T205 public surface:** expose binding helpers such as
  `createPiBindingContext(options?)`, `createPiToolDefinitions(ctx, options?)`,
  `registerMxTools(pi, options?)`, and optionally `createMxPiExtension(options?)` /
  a default extension export once Pi package-loading semantics are verified. These
  names are guidance for T205, not an API shipped by T204.
- **Repository state today:** this checkout has `packages/registry`, `packages/toolbelt`,
  `packages/mcp`, `packages/claude`, `packages/audit`, `packages/golden`, **and now
  `packages/pi`** (`@mx-loom/pi`, landed by T205). If this doc is read on an earlier
  docs-only branch, treat the package names as planned surfaces from the design/backlog.
- **No envelope/protocol change.** The Pi binding preserves the T102 result envelope
  (`status` ∈ `ok|running|awaiting_approval|denied|error`, `result`, `error.code` from
  the closed taxonomy, `handle`, `approval`, `audit_ref` always present), the
  deferred-result protocol (`running` / `awaiting_approval` → resolve later via
  `mx_await_result`), idempotency-key semantics, and the audit-row schema unchanged.

### Implementation notes the T205 agent must verify

- **Schema adaptation (Pi uses TypeBox, not raw JSON Schema).** TypeBox `Unsafe()`
  exists in Pi's bundled build, but `Unsafe(schema)` only **tags** the schema
  (`~unsafe`) for serialization to the model — it is *not* confirmed to add runtime
  validation in Pi's tool pipeline. So either (a) wrap the draft-07 descriptor schemas
  with `Unsafe()` **and** add fail-closed preflight validation against `loadRegistry()`
  / Ajv, or (b) write a small JSON Schema → TypeBox converter for the canonical subset,
  modeled on `@mx-loom/claude`'s fail-closed converter. **Unsupported constructs must
  throw at build/startup — never degrade to a permissive `Any`.**
- **Enums → `StringEnum`, not `Type.Union`/`Type.Literal`.** `CANONICAL_M1_TOOLS`
  carries **seven** `enum` string fields — `liveness: ['active','stale','offline']`
  (`mx_find_agents` in+out, `mx_workspace_status`, `mx_describe_agent`),
  `kind: ['file','diff','env']` (`mx_share_context`, `mx_get_context`), and
  `encoding: ['utf-8','base64']` (`mx_share_context`). Pi's `docs/extensions.md` warns:
  *"Use `StringEnum` from `@earendil-works/pi-ai` … `Type.Union`/`Type.Literal` doesn't
  work with Google's API."* A naive `enum → Type.Union` mapping would pass mx-loom's
  Ajv equivalence test yet silently break Pi runs on Google models. Equivalence tests
  must cover **every** enum field.
- **No native structured-result channel.** Pi tool results expose model-visible
  `content` plus a `details` field — there is no MCP `structuredContent` equivalent.
  Put the **full envelope JSON** in `content[0].text` *and* in `details`, with prompt
  guidelines that explicitly tell the model to call `mx_await_result` with the returned
  `handle` on `running` / `awaiting_approval`.
- **Throw semantics.** Throwing from `execute()` marks the Pi tool as *failed* and may
  discard the envelope. **Return** the envelope for all normal statuses — including
  `denied`, `awaiting_approval`, `running`, and `error` — and reserve throws for adapter
  bugs (catch and convert to `errored('internal', …)` where possible).
- **SDK dependency mode.** Two in-repo precedents pull opposite ways: `@mx-loom/claude`
  declares its SDK as a **`peerDependency`** (host owns the single instance);
  `adw_sdlc/src/runners/runner-pi.ts` stays **import-free** because Pi's npm `engines`
  floor (it observed `>=22.19.0` for a different build — the floor is itself
  version-dependent) can make Pi an `optionalDependency` that vanishes on older Node.
  **Recommendation:** declare `@earendil-works/pi-coding-agent`, `typebox`, and
  `@earendil-works/pi-ai` (for `StringEnum`) as **`peerDependencies`** with matching
  devDependencies, and import Pi types **`type`-only** so `@mx-loom/pi` type-checks even
  when the peer is absent. Pin TypeBox to Pi's major (`^1.x`) to avoid a split TypeBox
  runtime. Re-confirm the exact ranges and engines floor at the pinned Pi version.
- **No MCP proxy inside Pi.** Do not spawn `mx-loom-mcp` from the Pi binding as the
  default path — it adds a protocol hop and a process lifecycle while *still* needing a
  native extension to surface the tools. Bind directly to the registry/toolbelt seam.
- **Active-tool selection.** Pi operators can enable/disable tools with `--tools`,
  `--no-tools`, `--no-builtin-tools`, `pi.getAllTools()`, and `pi.setActiveTools()`.
  T205 must document how to enable only the generated `mx_*` tools when desired and
  must not assume registration makes a disabled tool callable.

### T205 verification checklist

The following testing dimensions were verified in `packages/pi/test/smoke.test.ts` (daemon-free, #1–#9) and `packages/golden/test/t205-pi-binding.e2e.test.ts` (#9/#10, gated `MXL_PI_BINDING_E2E=1`; skip-clean without the fixture):

1. **Generated tool list:** generated names exactly match `CANONICAL_M1_TOOLS`, every
   prompt snippet/guideline is non-empty and names the tool explicitly, and no authority
   verbs (`trust.*`, `approval.decide`, `policy.*`, `auth.*`, `device.*`, `daemon.*`) are
   registered.
2. **Schema adapter:** each canonical input schema accepts/rejects the same representative
   samples as the registry Ajv seam; unsupported schema constructs fail closed at startup;
   all seven descriptor string-enum fields serialize through `StringEnum`.
3. **Execution + serialization:** fake daemon results for all five envelope statuses
   (`ok`, `running`, `awaiting_approval`, `denied`, `error`) return a Pi `AgentToolResult`
   with the full envelope JSON in `content[0].text` and `details`, including `handle`,
   `approval`, error code, and `audit_ref`.
4. **Deferred protocol:** `running` / `awaiting_approval` responses carry a `handle`, and
   the generated `mx_await_result` tool resolves fake terminal state without exposing an
   approval-mutation surface.
5. **Idempotency:** mutating verbs (`mx_delegate_tool`, `mx_run_command`) pass caller
   `idempotency_key` through and generate one when omitted, preserving existing handler
   behavior.
6. **Secret boundary/redaction:** credential-shaped args are rejected before dispatch;
   token-shaped fake daemon values are redacted in `content` and `details`; logs are
   secret-free.
7. **Audit:** exactly one `withAudit` tap runs at the Pi result-return chokepoint; sink
   failures are swallowed without changing the envelope.
8. **SDK / extension integration:** generated `customTools` appear in a Pi `AgentSession`
   and `registerMxTools(pi, ...)` / `createMxPiExtension()` register dynamically without
   `/reload`, under the chosen active-tool allowlist.
9. **Portability / live gate:** the T206 Pi arm runs the same golden scenario via native
   registration, gated behind the two-daemon/model fixture and never assumed green without
   that fixture.
10. **Version compatibility:** tests assert the Pi SDK symbols used by T205
    (`ToolDefinition`, `AgentToolResult`, `defineTool`, `customTools`, `registerTool`,
    TypeBox, and `StringEnum`) against the pinned target Pi version.

### T204 e2e coverage

The repo now has a gated, daemon-free e2e smoke for this spike at
`packages/golden/test/t204-pi-capability.e2e.test.ts`. It points at a real installed
`@earendil-works/pi-coding-agent` package and verifies the load-bearing runtime facts
behind this decision: no built-in MCP CLI/config surface, native SDK `customTools`,
extension-time `pi.registerTool()`, executable wrapped `AgentTool`s, and `StringEnum`
availability. It also grounds **Risk #3** end-to-end: a *real* canonical-registry
`enum` value-set (read from `CANONICAL_M1_TOOLS`, e.g. `mx_find_agents.liveness`)
survives `StringEnum` -> live-Pi-TypeBox registration in the Google-compatible
`{ type: 'string', enum: [...] }` shape (not `Type.Union`/`oneOf`), so the
descriptor->Pi enum mapping T205 depends on is proven against the real registry,
not a synthetic enum. It does not require Matrix, mx-agent daemons, model/provider
keys, or a Pi golden arm; that live delegation arm remains T205/T206.

Run it explicitly with:

```sh
MXL_PI_CAPABILITY_E2E=1 \
MXL_PI_PACKAGE_ROOT=/path/to/node_modules/@earendil-works/pi-coding-agent \
  pnpm --filter @mx-loom/golden exec vitest run \
  --config vitest.e2e.config.ts test/t204-pi-capability.e2e.test.ts
```

Unset `MXL_PI_CAPABILITY_E2E` / `MXL_PI_PACKAGE_ROOT` afterward; the test removes its
own temporary Pi config/session directory.

## Security & boundary (unchanged by this decision)

- The secret boundary is mandatory and unaffected: Matrix tokens, Ed25519 signing keys,
  provider keys, and `GH_TOKEN` never cross Boundary A into Pi, the model context, or
  runner children. The toolbelt remains the chokepoint — deny-by-default env allowlist,
  outbound credential-shaped-arg rejection, inbound token-shaped redaction. If Pi needs
  provider auth for its *own* model calls, that is outside the mx-loom tool contract and
  must not be read, copied, logged, or forwarded by the binding.
- Out-of-process enforcement is unchanged: trust (Ed25519 store), deny-by-default
  `policy.toml`, sandbox, and human approval gates all run on the receiving mx-agent
  daemon. Pi/the model can only produce signed requests; it cannot grant itself
  authority. The binding registers **only** the nine model-facing `mx_*` verbs — never
  `trust.*`, `approval.decide`, `policy.*`, `auth.*`, `device.*`, or `daemon.*`. Approval
  reaches the model only as `status:"awaiting_approval"`, re-validated against live
  policy at release.
- Pi extensions run with full system permissions, so the mx-loom Pi extension/package
  must be small, auditable, must not call `pi.exec()` or spawn child processes for normal
  operation, and must reach mx-agent only through the toolbelt daemon client. Apply the
  `withAudit` tap once at the Pi result-return chokepoint; never log tokens, signing
  keys, provider keys, `GH_TOKEN`, raw args, or raw env.

## Revisit condition

Re-evaluate this decision if **Pi ships a built-in MCP client** (a `--mcp` flag /
`mcpServers` config), or if a **generic Pi MCP-client extension** is independently
justified for other reasons. In either case, mounting `@mx-loom/mcp` directly may
become the lower-surface path; until then, native registration stands.
