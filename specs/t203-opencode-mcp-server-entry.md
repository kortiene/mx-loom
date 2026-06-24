# OpenCode MCP Server Entry (T203 / #25)

> Planning specification for GitHub issue **#25 — T203 · binding: OpenCode MCP server entry**.
>
> Dependency: **blocked-by #17 / T109** (`@mx-loom/mcp`, the generated MCP server). In this checkout T109 appears landed (`packages/mcp` exists and already documents a minimal OpenCode local entry), but a later coding agent must still verify the dependency is present and green before implementing T203.

## Problem Statement

OpenCode users need a reliable, copy-pasteable way to mount the mx-loom generated MCP server from `opencode.json` so an OpenCode agent can discover and call the canonical `mx_*` coordination tools.

The universal MCP server already provides the binding surface that OpenCode should consume: local stdio (`mx-loom-mcp --stdio`) and Streamable HTTP (`mx-loom-mcp --http`). The current gap for T203 is OpenCode-specific verification and documentation:

- no dedicated `examples/opencode/` recipe exists;
- the local stdio `opencode.json` entry has not been tested through OpenCode itself;
- the remote MCP entry is not documented for OpenCode;
- tool surfacing has not been proven at the OpenCode runtime boundary;
- the issue acceptance criterion is not yet satisfied: **an OpenCode agent calls `mx_delegate_tool` via the configured MCP server**.

Without this work, users may hand-write an incompatible OpenCode MCP block, omit required session flags such as the workspace room, accidentally run the MCP child with a secret-bearing environment, expose the remote HTTP server unsafely, or mis-handle mx-loom's `running` / `awaiting_approval` result envelopes.

## Goals

- Provide verified OpenCode `opencode.json` examples for both supported MCP server modes:
  - **local stdio**: OpenCode spawns `mx-loom-mcp --stdio` as a local MCP server;
  - **remote**: OpenCode connects to an already-running `mx-loom-mcp --http` endpoint.
- Preserve the one canonical tool surface: OpenCode must consume the generated MCP tools from `@mx-loom/mcp`; no OpenCode-specific tool descriptors should be hand-authored.
- Verify tool surfacing through OpenCode:
  - all canonical `mx_*` tools are available where OpenCode exposes a tool-listing surface;
  - forbidden authority verbs (`trust.*`, `approval.decide`, `policy.*`, `auth.*`, `device.*`, `daemon.*`) are absent.
- Satisfy the acceptance criterion with a gated end-to-end smoke: an OpenCode agent calls `mx_delegate_tool` through the configured MCP server and receives a valid T102 result envelope.
- Cover both local-stdio and remote server-entry configurations in tests or, where OpenCode lacks deterministic introspection, in gated e2e runs with clear fail-not-skip behavior.
- Document safe session mapping: one OpenCode workspace/session should map to one `mx-loom-mcp` process/session and one MX workspace room.
- Maintain the full secret boundary and out-of-process enforcement model.

## Non-Goals

- No new model-facing `mx_*` tools, tool descriptors, or registry handlers.
- No changes to daemon JSON-RPC methods or mx-agent policy/trust/approval semantics.
- No OpenCode-native non-MCP shim. OpenCode is in scope only as an MCP-consuming runtime.
- No model-facing trust, policy, auth, device, daemon, or approval-decision tools.
- No ADK `LongRunningFunctionTool` work (T202), Pi native binding work (T205), or full M2 portability matrix (T206).
- No implementation of remote MCP authentication in `@mx-loom/mcp`; the existing HTTP transport remains localhost-bound by default, with non-local exposure requiring an operator-managed authenticated reverse proxy.
- No package publication work for `mx-loom-mcp` (T602). Until publication, examples/tests may use an in-repo `tsx packages/mcp/src/cli.ts` launcher.
- No reliance on an ungated live provider/model test as the default local test path.

## Relevant Repository Context

- `docs/mx-agent-tool-fabric-design.md` defines the core boundary:
  - runtimes own cognition;
  - mx-agent daemons own coordination, identity, trust, policy, sandboxing, Matrix credentials, approvals, and audit;
  - mx-loom is the secret-free adaptation plane between runtime tool calls and daemon RPC.
- The design's OpenCode runtime bullet says OpenCode should register the toolbelt as an MCP server in `opencode.json` using the `mcp` block; OpenCode then surfaces MCP tools directly to agents.
- `docs/backlog.md` places **T203** in **M2 — Universal binding**, `area/opencode`, `priority/P0`, `type/feature`, estimate **S**, blocked by **T109 / #17**. Its scope is local-stdio + remote server entries and tool-surfacing verification; its acceptance criterion is an OpenCode agent calling `mx_delegate_tool` via the configured MCP server.
- `packages/mcp` (`@mx-loom/mcp`) exists in the current checkout and is the owning package for the generic MCP server:
  - `src/cli.ts` exposes `mx-loom-mcp` over `--stdio` and `--http --host 127.0.0.1 --port 7800`. The HTTP mode is **stateless and path-agnostic**: it constructs one `StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })` and a single `http.createServer((req, res) => transport.handleRequest(req, res))` that routes *every* request (any path) to that one transport. There is no `/mcp` route to match server-side.
  - `src/cli-options.ts` already supports non-secret session flags: `--room`, `--kind`, `--correlation-id`, `--cwd`, `--project-id`, `--git-commit`, `--max-invocations`, and `--audit`.
  - `src/tools.ts` enumerates `CANONICAL_M1_TOOLS` and passes descriptor input schemas through to MCP `tools/list`.
  - `src/dispatch.ts` routes MCP `tools/call` to registry handlers; the room comes from the binding context/session, never model input.
  - `src/serialize.ts` serializes the full T102 envelope into MCP `CallToolResult.structuredContent` and JSON text, with `isError === true` only for `status: "error"`.
  - `README.md` already includes a minimal OpenCode local snippet, but it does not yet provide a full OpenCode recipe, remote example, or OpenCode runtime verification.
- `packages/registry` owns the canonical descriptors, result envelope, error taxonomy, and handlers for the nine M1 tools: `mx_find_agents`, `mx_describe_agent`, `mx_delegate_tool`, `mx_run_command`, `mx_await_result`, `mx_share_context`, `mx_get_context`, `mx_cancel`, and `mx_workspace_status`.
- `packages/toolbelt` owns Boundary-B daemon communication and secret-boundary guards. Concrete calls through `MxClient` / `MxSession` reject credential-shaped outbound args and redact credential-shaped inbound values.
- `packages/golden` is the existing home for gated cross-binding e2e tests. It already has:
  - `golden.mcp.e2e.test.ts` for the generic MCP binding against a live two-daemon fixture;
  - `adk.mcp-toolset.e2e.test.ts` as an M2 runtime-specific MCP consumer example;
  - shared live-fixture helpers and fail-not-skip conventions.
- `examples/adk/` is the pattern for a runtime-specific copy-paste recipe, safe child environment guidance, and README-driven setup. There is currently **no** `examples/opencode/` directory.
- There is currently **no** `packages/opencode` / `@mx-loom/opencode` product package, and none is expected for T203 unless OpenCode unexpectedly requires runtime-specific code. OpenCode should consume `@mx-loom/mcp` directly.
- `adw_sdlc/src/runners/runner-opencode.ts` is the ADW pipeline's internal OpenCode runner. It demonstrates safe OpenCode server spawning and SDK usage, but it is build-harness tooling, not the mx-loom OpenCode binding. T203 should not modify ADW runner code unless a later issue specifically targets the harness.
- The prompt warns that the repository may be docs-only; this checkout is not docs-only. It contains TypeScript workspace packages and tests. If a later coding agent works from an older docs-only branch, it must treat all packages named above as proposed/absent until T109 and its dependencies land.
- Stack conventions in this repo: TypeScript, pnpm workspaces, Node `>=20.19`, vitest, Apache-2.0.

## Proposed Implementation

### 1. Verify the current OpenCode MCP configuration contract

Before writing examples or tests, confirm the exact `opencode.json` MCP schema for the OpenCode version targeted by CI/release:

- local server entry shape:
  - expected: `mcp.<name>.type = "local"`;
  - expected command format: either `command: ["mx-loom-mcp", "--stdio", ...]` or a `command` + `args` split, depending on OpenCode's current schema;
  - expected optional fields: `enabled`, `env` / `environment`, `cwd`, timeout fields, or permissions, if any.
- remote server entry shape:
  - expected: `mcp.<name>.type = "remote"`;
  - expected URL field: likely `url`, pointing to the Streamable HTTP endpoint;
  - URL value: the mx-loom HTTP server is path-agnostic (it routes any request path to one transport), so the open question is purely client-side — confirm what URL string OpenCode's MCP client requires and whether it appends a path segment. Start the example from the root (`http://127.0.0.1:7800`) and adjust only if OpenCode's client demands a specific path.
- tool naming in OpenCode transcripts/events:
  - confirm whether tool calls appear as `mx_delegate_tool`, `mx-loom.mx_delegate_tool`, `mcp__mx-loom__mx_delegate_tool`, or another namespaced form.
- tool-list introspection:
  - determine whether OpenCode exposes MCP tool lists through a CLI/API without a model call. If yes, use it for deterministic surfacing tests. If no, make the model-in-loop test the gated acceptance proof.

Record the verified schema in `examples/opencode/README.md` and pin it in tests. Do not ship unverified config field names as if they were guaranteed.

### 2. Add OpenCode example configuration and guide

Create `examples/opencode/` with:

- `README.md` — copy-pasteable setup, security notes, local and remote modes, testing instructions.
- `opencode.local.example.json` — valid JSON sample for local stdio.
- `opencode.remote.example.json` — valid JSON sample for remote Streamable HTTP.
- Optionally, a tiny launcher script example for development checkouts before T602 publishes a standalone `mx-loom-mcp` binary.

Recommended local stdio shape, subject to schema verification:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mx-loom": {
      "type": "local",
      "enabled": true,
      "command": [
        "mx-loom-mcp",
        "--stdio",
        "--room", "!workspace:server",
        "--kind", "opencode",
        "--correlation-id", "opencode_<session-id>"
      ]
    }
  }
}
```

Recommended remote shape, subject to schema verification:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mx-loom": {
      "type": "remote",
      "enabled": true,
      "url": "http://127.0.0.1:7800"
    }
  }
}
```

The remote server is started separately with the session configuration that the local command would otherwise carry:

```sh
mx-loom-mcp \
  --http --host 127.0.0.1 --port 7800 \
  --room '!workspace:server' \
  --kind opencode \
  --correlation-id 'opencode_<session-id>'
```

Guidance to include:

- `--room` and `--correlation-id` are non-secret session config, not model tool args.
- The model never supplies the Matrix room; the MCP server's `BindingContext` injects it from the session.
- One OpenCode workspace/session should use one `mx-loom-mcp` server process/session. Do not share a single process across unrelated rooms until tenant scoping (M5) supports that explicitly.
- Generic MCP clients, including OpenCode, may surface `running` / `awaiting_approval` as ordinary tool results. The agent should call `mx_await_result` with the returned `handle` after an approval decision or long-running operation.
- For in-repo development before publication, use a launcher that runs `tsx packages/mcp/src/cli.ts "$@"`; do not point users at `packages/mcp/dist/cli.js` unless the package exports/build layout is verified to be standalone-runnable.

### 3. Preserve environment safety for local stdio

Local OpenCode MCP mode is the only new child-process boundary: OpenCode spawns `mx-loom-mcp`. The implementation must verify how OpenCode populates the MCP child's environment.

Preferred order:

1. If OpenCode supports a per-MCP-server `env` / `environment` field, document and test an explicit allowlist containing only non-secret operational variables required for the child, for example:
   - `PATH` if needed to resolve `mx-loom-mcp` / `tsx`;
   - `HOME` only if needed for non-secret binary lookup or daemon socket fallback;
   - `XDG_RUNTIME_DIR` to resolve `$XDG_RUNTIME_DIR/mx-agent/daemon.sock`;
   - non-secret `MXL_*` conformance/session flags when applicable.
2. If OpenCode does **not** support per-server env override, document that OpenCode itself must be launched from a scrubbed environment so its MCP children cannot inherit provider keys, Matrix tokens, `GH_TOKEN`, or other credentials.
3. In both cases, the examples must not include provider keys, Matrix credentials, `GH_TOKEN`, audit DSNs, policy paths, signing keys, or trust mutation material.

The MCP server still uses `MxClient` / `MxSession`, so credential-shaped tool arguments are rejected and inbound results are redacted. The local stdio work must not bypass that path.

### 4. Add an OpenCode acceptance e2e under `packages/golden`

Add a gated test such as `packages/golden/test/opencode.mcp-entry.e2e.test.ts` that follows the existing T201 ADK pattern:

- skip cleanly unless `MXL_OPENCODE_MCP_E2E=1` is set;
- fail, rather than skip, when requested but prerequisites are missing;
- require the live two-daemon fixture used by the existing golden/conformance tests:
  - `MXL_CONFORMANCE_TWO_DAEMON=1`;
  - `MXL_CONFORMANCE_ROOM`;
  - `MXL_CONFORMANCE_TARGET_AGENT`;
  - `MXL_CONFORMANCE_TOOL`;
  - daemon A socket reachable via `MXL_CONFORMANCE_SOCKET` or standard socket resolution;
- run with a scrubbed environment and a temporary OpenCode config/data directory;
- exercise both modes where practical:
  - `local`: OpenCode reads `opencode.json` and spawns `mx-loom-mcp --stdio`;
  - `remote`: the test starts `mx-loom-mcp --http` and OpenCode connects via the remote `mcp` entry.

Suggested gating/config variables:

- `MXL_OPENCODE_MCP_E2E=1` — demand the OpenCode e2e arm.
- `MXL_OPENCODE_MCP_MODE=local|remote|both` — default to `both` when feasible.
- `MXL_OPENCODE_BIN=/path/to/opencode` — optional OpenCode binary override.
- `MXL_OPENCODE_MODEL=<provider/model>` — optional model route if a real model call is required.
- `MXL_OPENCODE_MCP_COMMAND=/path/to/mx-loom-mcp` — optional real/published MCP binary; otherwise generate an in-repo `tsx` launcher, as the ADK test does.
- Any OpenCode auth/provider setup should come from OpenCode's normal auth store or a test-only fake provider if OpenCode supports one, not from provider-key env vars passed to the MCP child.

Test flow:

1. Create a temp OpenCode workspace with an `opencode.json` rendered from the example template and live fixture coordinates.
2. Start OpenCode in headless/server mode with a deny-by-default/scrubbed environment.
3. For local mode, let OpenCode spawn the MCP server from the `opencode.json` local entry.
4. For remote mode, start `mx-loom-mcp --http --host 127.0.0.1 --port <free-port>` separately, then render `opencode.json` with the remote URL.
5. Verify tool surfacing:
   - if OpenCode exposes a direct tool-list surface, assert that the canonical `mx_*` names are present and forbidden authority verbs are absent;
   - otherwise, inspect session events/final message parts to confirm OpenCode recognized/called the MCP tool.
6. Prompt/drive an OpenCode agent to call `mx_delegate_tool` with fixture coordinates:
   - `agent: MXL_CONFORMANCE_TARGET_AGENT`;
   - `tool: MXL_CONFORMANCE_TOOL`;
   - `args: { package: "mx-loom-opencode" }` or another schema-valid, secret-free payload;
   - an explicit `idempotency_key` for deterministic dedupe assertions.
7. Assert the resulting tool output contains a valid T102 envelope:
   - status is `ok`, `running`, or `awaiting_approval` for the allowed path;
   - `audit_ref` exists and is structurally valid;
   - `error.code`, when present, belongs to the closed taxonomy;
   - no secret-shaped value appears in tool results, OpenCode transcript output, or test logs.
8. If the initial result is `running`, resolve it with `mx_await_result` or run the allowed fixture so it returns `ok` immediately. If the fixture returns `awaiting_approval`, either use the existing out-of-band operator decision helper or skip approval behavior for T203 and leave approval-resume coverage to T206/T202/T114.

If OpenCode cannot be driven deterministically without a real model/provider, keep the model-in-loop OpenCode test opt-in and clearly documented. The default unit/docs tests should still parse and validate the example configs without needing OpenCode, Matrix, or provider keys.

### 5. Add config/documentation tests

Add fast tests that do not require OpenCode or mx-agent:

- parse `examples/opencode/*.example.json` as JSON;
- assert both local and remote examples have an `mcp.mx-loom` entry with the verified fields;
- assert examples contain no credential-shaped keys or values;
- assert local command includes `--stdio` and non-secret session placeholders (`--room`, `--kind opencode`, `--correlation-id`);
- assert remote docs mention localhost binding and authenticated proxy requirements before non-local exposure;
- optionally, snapshot the README snippets if the repo already has a documentation-snippet test pattern.

### 6. Keep `@mx-loom/mcp` as the only runtime binding

T203 should not introduce `@mx-loom/opencode` unless verification proves OpenCode cannot consume the generated MCP server directly. The expected implementation is documentation + examples + tests around the existing MCP server.

Only change `packages/mcp` source if OpenCode verification reveals a real interoperability issue in the generic MCP server, such as a Streamable HTTP path mismatch or a schema field OpenCode requires. Any such change must remain generic MCP behavior, not OpenCode-specific tool authoring.

## Affected Files / Packages / Modules

Likely additions:

- `examples/opencode/README.md` — OpenCode setup guide.
- `examples/opencode/opencode.local.example.json` — local stdio MCP config.
- `examples/opencode/opencode.remote.example.json` — remote MCP config.
- `packages/golden/test/opencode.mcp-entry.e2e.test.ts` — gated OpenCode acceptance e2e.
- `packages/golden/test/opencode-config.test.ts` or similar — fast config/docs validation, if it belongs in the golden package.

Likely modifications:

- `packages/golden/package.json` — add `@opencode-ai/sdk` as a dev dependency if the e2e uses the SDK directly. Do not rely on the ADW harness dependency leaking through the root install.
- `packages/golden/README.md` — document how to run the OpenCode e2e arm and its gating variables.
- `packages/golden/vitest.e2e.config.ts` — include the OpenCode e2e file if needed by existing glob/config.
- `packages/mcp/README.md` — expand the OpenCode section with verified local and remote snippets and defer to `examples/opencode/`.
- `.github/workflows/conformance.yml` — optional: add a manually triggered OpenCode arm or document that T206 owns CI matrix wiring. If added in T203, keep it opt-in and fail-not-skip only when explicitly requested.
- `docs/mx-agent-tool-fabric-design.md` — update the OpenCode bullet/status after implementation lands.
- `docs/backlog.md` — update T203 status after implementation lands.

Potentially read-only / reference:

- `packages/mcp/src/cli.ts`, `src/cli-options.ts`, `src/context.ts`, `src/tools.ts`, `src/dispatch.ts`, `src/serialize.ts`.
- `packages/mcp/test/stdio.integration.test.ts` and `packages/mcp/test/conformance/mcp.conformance.test.ts` for MCP fixture patterns.
- `packages/golden/test/adk.mcp-toolset.e2e.test.ts` for runtime-specific MCP consumer patterns.
- `adw_sdlc/src/runners/runner-opencode.ts` for OpenCode SDK/spawn learnings only; it is internal ADW tooling and should not be changed for the product binding.

Not expected:

- No `packages/opencode` package.
- No changes to `packages/registry` descriptors or handlers.
- No changes to `packages/toolbelt` unless a generic secret-boundary bug is discovered.
- No daemon or policy source changes.

## API / Interface Changes

No TypeScript library, daemon-RPC, tool-descriptor, or result-envelope API changes are expected.

New public/user-facing configuration documentation is expected:

- OpenCode local MCP entry in `opencode.json`, verified against the current OpenCode schema.
- OpenCode remote MCP entry in `opencode.json`, verified against the current OpenCode schema.
- Existing `mx-loom-mcp` CLI flags are reused:
  - local mode: `--stdio`, `--room`, `--kind opencode`, `--correlation-id`, and optional non-secret workspace flags;
  - remote mode: `--http`, `--host`, `--port`, `--room`, `--kind opencode`, `--correlation-id`, and optional non-secret workspace flags.

If verification shows OpenCode requires a field not currently documented by `@mx-loom/mcp` examples (for example `enabled: true`, `headers`, or split `command`/`args`), document that field in the OpenCode examples. Do not add credentials or authority-bearing fields.

No new model-facing tool names are expected. OpenCode should see the same canonical names emitted by `@mx-loom/mcp`.

## Data Model / Protocol Changes

None expected.

T203 uses existing protocol/data shapes:

- MCP `tools/list` and `tools/call` from `@mx-loom/mcp`.
- The T102 result envelope:

```jsonc
{
  "status": "ok|running|awaiting_approval|denied|error",
  "result": {},
  "error": { "code": "policy_denied|untrusted_key|approval_denied|approval_expired|timeout|not_found|invalid_args|target_offline|internal", "message": "..." },
  "handle": "inv_...",
  "approval": { "request_id": "req_...", "risk": "low|medium|high", "summary": "...", "expires_at": "..." },
  "audit_ref": { "invocation_id": "inv_...", "request_id": "req_...", "room": "!...", "event_id": "$..." }
}
```

- MCP serialization invariants already owned by `@mx-loom/mcp`:
  - full envelope in `structuredContent`;
  - same envelope rendered as JSON text in `content[0]`;
  - `isError` true only for `status: "error"`.
- Existing mutating-tool idempotency behavior: `mx_delegate_tool` accepts optional `idempotency_key`; handlers generate one when omitted; tests should provide one for deterministic assertions.
- Existing audit correlation: every result includes `audit_ref`; the binding's `withAudit` tap records a non-secret row when an audit sink is enabled.

If OpenCode does not expose MCP `structuredContent` to the model/transcript and only exposes `content` text, do not change the envelope. Tests should parse the JSON text fallback and document the observed OpenCode behavior.

## Security & Compliance Considerations

- **Secret boundary / Boundary A.** Matrix tokens, Ed25519 signing keys, provider keys, and `GH_TOKEN` must never cross Boundary A into the runtime process, the model context, or runner children. The toolbelt enforces a deny-by-default environment allowlist for subprocesses it owns; runner children receive retrieved TEXT only, never credentials.
- **OpenCode local stdio child.** OpenCode, not mx-loom, spawns the local MCP child. T203 must verify whether OpenCode lets `opencode.json` specify a per-MCP-server environment. If yes, the example must use an explicit deny-by-default allowlist. If no, the guide must require launching OpenCode itself from a scrubbed environment so `mx-loom-mcp` cannot inherit provider keys, Matrix tokens, `GH_TOKEN`, audit DSNs, or other secrets.
- **No credentials in config examples.** `opencode.json` examples may include non-secret session config (`--room`, `--kind`, `--correlation-id`, `--cwd`, `--project-id`, `--git-commit`, `--max-invocations`) but must not include Matrix credentials, signing keys, provider keys, `GH_TOKEN`, `DATABASE_URL`, trust store paths, policy mutation fields, or approval decisions.
- **Remote MCP exposure.** `mx-loom-mcp --http` binds to `127.0.0.1` by default and adds no authentication. OpenCode remote examples should use localhost. Non-local exposure must be explicit operator opt-in behind an authenticated reverse proxy. Even then, the daemon independently enforces trust, policy, sandboxing, and approval, but an exposed MCP endpoint would let callers issue requests as that local agent, so it must not be publicly reachable unauthenticated.
- **Out-of-process enforcement remains authoritative.** Trust (Ed25519 trust store), deny-by-default `policy.toml`, sandbox, and human approval gates execute on the receiving mx-agent daemon. The OpenCode agent can only produce a signed request via the daemon; it never grants itself authority.
- **No model approval or governance mutation.** The model is never given trust/policy/approval mutation tools. Approval reaches the model only as an `awaiting_approval` result status and is re-validated against live policy at release.
- **Secret-free tool contract.** No tool field carries credentials inbound or outbound. Credential-shaped args must be rejected (`invalid_args`) before dispatch by the toolbelt guard, and inbound daemon values must be redacted. Tests should seed fake secret-shaped values and assert they never appear in OpenCode-visible output, MCP results, or logs.
- **Audit correlation.** Every result must carry `audit_ref`. If the OpenCode e2e enables an audit sink, rows should correlate tool name, correlation id, idempotency key, invocation id, and approval request id without storing `result`, `error.message`, or `approval.summary` payloads.
- **Logging/redaction.** OpenCode e2e logs, MCP server stderr, test transcripts, and CI output must never log secrets or tokens. Failure messages should mention missing prerequisites by variable name only, not by secret value.
- **Runner permissions.** OpenCode's own permission settings should allow MCP tool calls needed for the test but must not add git/GitHub authority or operator-only mx-agent authority. Any bash/shell permission settings in the test harness should remain unrelated to model-facing mx-loom tools and should not reintroduce `GH_TOKEN`.

## Testing Plan

### Fast unit / documentation tests

- Parse `examples/opencode/opencode.local.example.json` and `opencode.remote.example.json` as strict JSON.
- Validate the `mcp.mx-loom` local entry against the verified OpenCode schema subset:
  - type is local;
  - command resolves to `mx-loom-mcp` or a documented placeholder launcher;
  - includes `--stdio`;
  - includes non-secret session arguments or documented placeholders for `--room`, `--kind opencode`, and `--correlation-id`.
- Validate the remote entry:
  - type is remote;
  - URL is localhost by default;
  - no header/token examples are committed;
  - docs mention an authenticated proxy before non-local exposure.
- Secret-pattern tests over examples and README snippets: no `MATRIX_*`, `MX_AGENT_*`, `GH_TOKEN`, `*_TOKEN`, `*_API_KEY`, `*_SECRET`, `*_ACCESS_KEY`, PEM blocks, `sk-*`, or fake values matching the repo's `SECRET_PATTERN` appear except in explicit negative documentation prose where appropriate.
- If OpenCode supports per-MCP env in config, add a test that the example env allowlist does not include provider-key or token-shaped keys.

### OpenCode schema/config verification tests

- If OpenCode provides a config parser or diagnostic command/API, add a deterministic test that loads both example entries and reports them valid.
- If no parser exists, keep schema verification in the e2e arm and document the manual verification command in `examples/opencode/README.md`.

### Gated OpenCode e2e — local stdio

- `MXL_OPENCODE_MCP_E2E=1 MXL_OPENCODE_MCP_MODE=local` starts OpenCode with a temp workspace and local `opencode.json`.
- OpenCode spawns `mx-loom-mcp --stdio` from the config using either:
  - a real `mx-loom-mcp` binary supplied by `MXL_OPENCODE_MCP_COMMAND`; or
  - an in-repo `tsx packages/mcp/src/cli.ts` launcher generated by the test.
- Test prerequisites fail hard when requested but missing: OpenCode binary, configured model/fake provider, daemon fixture, room/target/tool coordinates, source launcher, or socket.
- Verify the local MCP entry surfaces mx-loom tools and that an OpenCode agent calls `mx_delegate_tool`.
- Assert the result envelope validates and remains secret-free.

### Gated OpenCode e2e — remote

- `MXL_OPENCODE_MCP_E2E=1 MXL_OPENCODE_MCP_MODE=remote` starts `mx-loom-mcp --http --host 127.0.0.1 --port <free-port>` with live session config, then starts OpenCode with a remote `mcp` URL entry.
- Verify tool surfacing and `mx_delegate_tool` call as above.
- Assert no non-local bind is used in test unless explicitly configured and secured.

### Result-envelope / error-taxonomy assertions

- Validate each observed result with `validateEnvelope` from `@mx-loom/registry`.
- Assert `status` is one of the five allowed statuses.
- Assert any `error.code` belongs to the closed taxonomy.
- Assert `denied` / `awaiting_approval` / `running` are not treated as protocol failures if OpenCode exposes that distinction.
- If OpenCode only exposes JSON text, parse the JSON text and validate the envelope.

### Idempotency

- For the acceptance `mx_delegate_tool` call, provide a unique `idempotency_key`.
- If the fixture and OpenCode behavior allow a safe repeat, re-issue the same prompted call or direct MCP action with the same key and assert the daemon does not double-execute, using matching `audit_ref.invocation_id` when available.
- If model nondeterminism prevents a reliable repeat, leave deep idempotency coverage to the existing MCP/golden tests and note the limitation.

### Secret-boundary / redaction

- Seed the OpenCode parent/test process with clearly fake secret-shaped environment values.
- Assert none appear in:
  - rendered `opencode.json`;
  - the MCP child env if introspectable;
  - OpenCode session transcripts/events;
  - MCP `CallToolResult` content/structured content;
  - audit rows;
  - test failure logs.
- Attempt, where feasible through a direct MCP call or controlled prompt, a credential-shaped `mx_delegate_tool.args` key/value and assert `invalid_args` rather than dispatch.

### CI / conformance posture

- Default local/PR test path: fast docs/config tests only, no OpenCode binary, no Matrix daemon, no model/provider.
- Gated e2e path: skip cleanly when `MXL_OPENCODE_MCP_E2E` is unset; fail-not-skip when set and prerequisites are missing.
- T206 should later include this OpenCode arm in the full portability matrix.

## Documentation Updates

- `examples/opencode/README.md`:
  - local stdio setup;
  - remote setup;
  - session mapping;
  - in-repo launcher vs published binary;
  - deferred result handling with `mx_await_result`;
  - safe environment requirements;
  - remote localhost/reverse-proxy warning;
  - gated e2e instructions.
- `packages/mcp/README.md`:
  - point the OpenCode snippet to `examples/opencode/`;
  - add the verified remote OpenCode entry;
  - note OpenCode-specific environment caveats.
- `packages/golden/README.md`:
  - document the OpenCode e2e arm and all `MXL_OPENCODE_*` variables.
- `docs/mx-agent-tool-fabric-design.md`:
  - after implementation, update the OpenCode bullet/status to say T203 landed and summarize verified local/remote entries and acceptance scope.
- `docs/backlog.md`:
  - after implementation, update T203 with landed status, what was verified, what remains staged for T206, and any resolved OpenCode schema decisions.
- Optional `README.md` supported runtimes section:
  - point OpenCode users at the new example guide if the maintainers want runtime docs linked from the top-level README.

## Risks and Open Questions

1. **Exact OpenCode MCP config schema.** The expected `mcp` shapes must be verified against the targeted OpenCode version. The existing `packages/mcp/README.md` local snippet may be correct, but T203 must not assume unverified remote or env field names.
2. **OpenCode tool-list introspection.** It is unclear whether OpenCode exposes MCP tool lists without invoking a model. If not, deterministic surfacing tests may be limited and acceptance may require a gated model-in-loop run.
3. **Provider/model dependency.** A real OpenCode agent call may require configured provider auth and incur cost/flakiness. Prefer a fake/local provider or no-model tool API if OpenCode supports one; otherwise keep the run opt-in and fail-not-skip only when explicitly requested.
4. **Local MCP child env inheritance.** If OpenCode local MCP entries inherit the entire OpenCode process env and provide no per-server env override, users must launch OpenCode from a scrubbed env. This needs prominent docs and a test harness that proves the safe path.
5. **Published binary not available until T602.** In this workspace, `dist/cli.js` may not be standalone-runnable because workspace exports point at source. Examples for development should use a launcher or require a linked/published `mx-loom-mcp` binary.
6. **Remote URL path and transport compatibility.** `@mx-loom/mcp`'s HTTP mode is stateless and path-agnostic (one `StreamableHTTPServerTransport` with `sessionIdGenerator: undefined` + `enableJsonResponse: true`, handling every request path through a single listener), so there is no server-side path to mismatch. The residual risk is purely client-side: OpenCode's MCP remote client may require a particular URL form or MCP protocol revision. Verify OpenCode's expected `url` (root vs appended path) and protocol revision against the running `mx-loom-mcp --http` server before freezing the remote example.
7. **Remote auth.** The MCP server intentionally has no built-in auth. The safe example should stay localhost-only. If users need non-local access, proxy credentials become an operational secret and must not appear in committed `opencode.json`, model prompts, tool args, or logs.
8. **Structured result preservation.** OpenCode may expose only text content from MCP tool results to the agent/transcript. The JSON text fallback should still preserve the envelope, but tests need to assert the observed channel.
9. **Tool naming differences.** OpenCode may namespace MCP tools in transcripts/events. Tests should accept the verified OpenCode form while asserting that the underlying MCP tool is `mx_delegate_tool`.
10. **Session cardinality.** OpenCode configuration can be workspace-global. A single `mx-loom-mcp` process should not be shared across unrelated rooms; docs must make per-workspace/per-session scoping clear.
11. **T109 dependency drift.** T203 depends on T109. If a later branch lacks `packages/mcp` or its stdio/HTTP transports, implement/merge T109 first rather than adding an OpenCode-specific workaround.

## Implementation Checklist

1. Confirm T109 / #17 is present and green: `@mx-loom/mcp` exists, `mx-loom-mcp` supports stdio + HTTP, and MCP unit/integration tests pass.
2. Verify the target OpenCode version's `opencode.json` MCP schema:
   - local command shape;
   - remote URL shape/path;
   - `enabled` default;
   - per-server env support;
   - any tool permissions needed for MCP calls.
3. Decide whether OpenCode exposes a no-model tool-list/introspection API. Record the result in the OpenCode example README and tests.
4. Create `examples/opencode/` with local and remote example JSON files using only verified fields and non-secret placeholders.
5. Write `examples/opencode/README.md` with setup, local/remote modes, safe env guidance, session mapping, deferred-result handling, and e2e instructions.
6. Add fast tests that parse and validate the example configs and scan docs/examples for credential-shaped values.
7. If OpenCode local MCP supports per-server env, add/test the documented allowlist. If it does not, document and test the scrubbed-OpenCode-process approach.
8. Add the gated OpenCode e2e under `packages/golden`:
   - prerequisite checks;
   - temp workspace/config rendering;
   - local stdio mode;
   - remote HTTP mode;
   - OpenCode SDK/client driving;
   - `mx_delegate_tool` acceptance assertion;
   - envelope validation;
   - secret-boundary assertions.
9. Add `@opencode-ai/sdk` as an explicit `devDependency` of `@mx-loom/golden` if the e2e imports it.
10. Update `packages/golden/README.md` with `MXL_OPENCODE_*` gating variables and run commands.
11. Update `packages/mcp/README.md` to point to the new OpenCode guide and include both verified entry types.
12. If desired for CI, add an opt-in OpenCode e2e workflow arm; otherwise document that T206 owns the full portability-matrix CI integration.
13. Run fast tests locally; run the gated OpenCode e2e only with the two-daemon fixture and appropriate OpenCode/model setup.
14. After implementation, update `docs/backlog.md` and `docs/mx-agent-tool-fabric-design.md` to mark T203 landed and capture any resolved OpenCode schema decisions.
