# `@mx-loom/pi`

The mx-loom **Pi binding** (T205 / [#27](https://github.com/kortiene/mx-loom/issues/27)).

Pi ([`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent))
ships **no built-in MCP client** (the T204 / [#26](https://github.com/kortiene/mx-loom/issues/26)
decision — see [`docs/pi-tool-surface-capability.md`](../../docs/pi-tool-surface-capability.md)),
so mx-loom cannot point Pi at `@mx-loom/mcp` the way ADK (`MCPToolset`) or OpenCode do.
Instead, this package registers the nine canonical `mx_*` verbs through Pi's
**native tool API** — SDK `customTools` / extension `registerTool` — generated from
`@mx-loom/registry`, never hand-authored.

- **Generated, not hand-authored.** One `ToolDefinition` per `CANONICAL_M1_TOOLS`
  descriptor. Adding a tenth canonical descriptor surfaces it in Pi with no per-tool edit.
- **Fail-closed schema adapter.** Each descriptor's draft-07 `input_schema` is
  converted to a Pi TypeBox schema; **enums become `StringEnum`** (the
  Google-provider-safe `{ type: "string", enum: [...] }`, never a `Type.Union`/`oneOf`).
  Any construct outside the supported subset throws `PiSchemaConversionError` at
  build time — it never degrades to a permissive `Type.Any()`.
- **Shared execution path.** Every `execute()` runs a fail-closed Ajv preflight
  (the real input gate), routes through the same registry handlers + the secret-free
  `@mx-loom/toolbelt` daemon seam every other binding uses, taps audit once, and
  serializes the T102 envelope into Pi's `AgentToolResult` (full envelope in **both**
  `content` and `details`, since Pi has no MCP `structuredContent` channel).
- **Secret-free by construction.** The binding holds no secret, reads no env var for
  daemon access, and starts no child process. Trust / policy / sandbox / approval all
  stay out-of-process on the receiving mx-agent daemon.

## Install

`@mx-loom/pi` takes the Pi SDK, TypeBox, and `@earendil-works/pi-ai` as **peer**
dependencies — the host owns the single instance Pi already bundles (pinning TypeBox
to Pi's major avoids a split TypeBox runtime, which Pi rejects via its `[Kind]`-symbol
identity check). The binding imports none of them statically; the TypeBox `Type` /
`StringEnum` **builders are injected** by you, resolved from Pi's own tree. This keeps
the package's heavy/native dependency footprint at zero and lets it type-check even
when Pi is absent (Pi's `engines.node` floor — `>=22.19` at the current pin — is above
mx-loom's `>=20.19`).

```jsonc
// your host app
"dependencies": {
  "@mx-loom/pi": "workspace:*",
  "@earendil-works/pi-coding-agent": "…",  // provides Pi + bundled typebox + pi-ai
}
```

## Recipe — SDK `customTools`

```ts
import { Type } from 'typebox';                         // Pi's bundled TypeBox
import { StringEnum } from '@earendil-works/pi-ai';      // the Google-safe enum helper
import { createAgentSession } from '@earendil-works/pi-coding-agent';
import { createPiBindingContext, createPiToolDefinitions, mxToolNames } from '@mx-loom/pi';

// 1. Open the secret-free binding context (registers an MxSession; correlation +
//    liveness heartbeat). For tests, inject a session / bare DaemonCall instead.
const ctx = await createPiBindingContext({ /* sessionOptions, auditSink */ });

// 2. Generate the nine mx_* tools, injecting Pi's TypeBox builders.
const customTools = createPiToolDefinitions(ctx, { builders: { Type, StringEnum } });

// 3. Hand them to Pi, and (optionally) activate ONLY the mx-loom verbs.
const { session } = await createAgentSession({
  customTools,
  noTools: 'builtin',          // drop Pi's built-ins …
  tools: mxToolNames(),        // … and enable only the mx_* verbs
});
```

## Recipe — extension `registerTool`

```ts
import { registerMxTools, createMxPiExtension } from '@mx-loom/pi';

// (a) register directly on a `pi` handle (during load OR after startup — new tools
//     appear in `pi.getAllTools()` without `/reload`):
registerMxTools(pi, { context: ctx, builders: { Type, StringEnum } });

// (b) or package it as a Pi extension factory:
const factory = createMxPiExtension({ context: ctx, builders: { Type, StringEnum } });
// new DefaultResourceLoader({ extensionFactories: [factory], … })
```

## Active-tool selection

Registering a tool does **not** make it callable — it must also be in Pi's active
set. Use `mxToolNames()` with `createAgentSession({ tools })` / `pi.setActiveTools()`,
and combine with `--no-builtin-tools` / `noTools: 'builtin'` to run an mx-loom-only
surface. `isMxToolName(name)` recognises a generated verb.

## Deferred results — `mx_await_result`

Deferred verbs (`mx_delegate_tool`, `mx_run_command`) may return
`status: "running"` or `"awaiting_approval"` with a `handle`. The baseline is
**model-driven**: the generated `promptGuidelines` tell the model to call
`mx_await_result(handle)` to obtain the terminal result. There is no hidden Pi poll
loop. (The handlers already support an inline `wait_ms` budget; an opt-in bounded
inline resolve is a possible enhancement, not the baseline.)

## Secret boundary

No `mx_*` tool field carries a credential inbound or outbound. Every daemon call
routes through `ctx.daemon` (an `MxSession`/`MxClient`), so the toolbelt's
deny-by-default env allowlist (`safeSubprocessEnv`), the outbound
`assertNoCredentialShapedArgs` guard, and inbound `redactSecrets` all stay in force.
Matrix tokens, Ed25519 signing keys, provider keys, and `GH_TOKEN` never cross into
Pi, the model context, or any child process. Only the nine model-facing verbs are
registered — `trust.*` / `approval.decide` / `policy.*` / `auth.*` / `device.*` /
`daemon.*` are structurally unreachable, and approval reaches the model only as a
`status: "awaiting_approval"` result re-validated against live policy on the daemon.

> **Pi-specific hazard (T204):** Pi extensions run with full system permissions. This
> binding stays small and auditable, calls no `pi.exec()` and spawns no child process
> for normal operation, and reaches mx-agent only through the toolbelt daemon client.

## Testing

Daemon-free unit/integration tests run against a fake `DaemonCall` + an ABI-shaped
fake TypeBox builder set — no daemon, socket, or real Pi/TypeBox install
(`pnpm --filter @mx-loom/pi test`). The live "a Pi agent calls `mx_delegate_tool` and
receives the result" arm (the issue's acceptance criterion) lives in `@mx-loom/golden`
(`test/t205-pi-binding.e2e.test.ts`), gated behind `MXL_PI_BINDING_E2E=1` + the
two-daemon golden fixture flags; it skips clean without the fixture and fails (never
greens) in CI when requested but unavailable.
