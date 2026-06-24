# `@mx-loom/golden` — the GOLDEN end-to-end test (T114, the M1 exit gate)

> The one test that exercises **every boundary**. Private, test-only — nothing is
> exported for downstream consumption.

A scripted, Claude-SDK-shaped cognition delegates a **named tool** *and* a **guarded
command** to a second registered agent across a workspace room → the receiver's
**approval gate** → an out-of-band **operator** approves (and, on the denial leg,
denies) → the **result returns** → the **audit rows** land. The same scenario runs
through **both** bindings — the `@mx-loom/mcp` server and the `@mx-loom/claude`
in-process shim — against the **same** live two-daemon golden fixture.

This is the M1 (Delegation MVP) exit gate (`docs/backlog.md` T114; design §8).

## What it composes

| Boundary | Crossed by |
|---|---|
| Model → binding | `@mx-loom/mcp` `tools/call` · `@mx-loom/claude` `createMxToolServer` + `canUseTool` |
| Binding → daemon | a live `MxClient` over daemon A's Unix socket |
| Delegation / guarded exec | `call.start` / `exec.start` → daemon B |
| Receiver policy | `scripts/conformance/policy.golden.toml` (deny-by-default, `requires_approval`, `deny_args_regex`, `network="deny"`) |
| Approval gate | held `awaiting_approval` → **out-of-band operator** `scripts/conformance/decide-approval.sh` → re-authorize-at-release |
| Result envelope | the T102 `ToolResult` (`@mx-loom/registry`) |
| Audit | `withAudit` → `InMemoryAuditSink` (default) / `PostgresAuditSink` (`MXL_AUDIT_PG=1`) |

The scenario (`test/scenario.ts`, S1–S8) is authored **once**, binding-agnostic; each
arm adapts a step into a real binding call and asserts the same terminal outcome.

## The scenario (S1–S8)

| # | action | golden-policy branch | terminal | operator |
|---|---|---|---|---|
| S1 | `mx_find_agents` | local read | `ok` (B present) | — |
| S2 | `mx_describe_agent(B)` | local read | `ok` (exposes tool) | — |
| S3 | `mx_delegate_tool(ALLOW_TOOL)` | `[[allow]]` `requires_approval=false` | `ok` + `audit_ref` (AC1) | — |
| S4 | `mx_delegate_tool(APPROVAL_TOOL)` | `[[allow]]` `requires_approval=true` | `awaiting_approval` → `ok` | **approve** |
| S5 | `mx_delegate_tool(APPROVAL_TOOL)` (new key) | same, denied | `awaiting_approval` → `denied(approval_denied)` | **deny** |
| S6 | `mx_run_command(ALLOW_COMMAND, safeArgs)` | `[exec]` `requires_approval=true` | `awaiting_approval` → `ok(exit_code)` (AC2) | **approve** |
| S7 | `mx_run_command(ALLOW_COMMAND, dangerousArgs)` | `deny_args_regex` | `policy_denied` (no approval) | — |
| S8 | `mx_delegate_tool(DENY_TOOL)` | deny-by-default | `policy_denied` | — |

## Running it

The golden suite **skips cleanly** with no fixture (developer laptop / fast CI) and
goes **red** (never silently green) when the fixture is demanded but unreachable.

```sh
# Fast, daemon-free gate-logic unit tests (run on every laptop / PR):
pnpm --filter @mx-loom/golden test

# The live golden e2e arms — needs the two-daemon golden fixture up:
#   1) bring up daemon A + B with the golden policy
scripts/conformance/install-mx-agent.sh
eval "$(scripts/conformance/bootstrap-daemon-a.sh   ... )"   # exports socket + room
POLICY_FIXTURE=policy.golden.toml \
  scripts/conformance/bootstrap-daemon-b.sh                  # exports agent/tool/approval_tool/allowed_command/…
#   2) run the gate
MXL_CONFORMANCE_TWO_DAEMON=1 \
MXL_CONFORMANCE_GOLDEN_POLICY=1 \
MXL_CONFORMANCE_ROOM=… MXL_CONFORMANCE_TARGET_AGENT=… \
MXL_CONFORMANCE_TOOL=… MXL_CONFORMANCE_APPROVAL_TOOL=… \
MXL_CONFORMANCE_DENIED_TOOL=… MXL_CONFORMANCE_ALLOWED_COMMAND=… \
  pnpm --filter @mx-loom/golden test:e2e
```

In CI this is the `golden` job of `.github/workflows/conformance.yml` (the bring-up
exports every coordinate from the bootstrap step outputs).

### T201 ADK `MCPToolset` acceptance

`test/adk.mcp-toolset.e2e.test.ts` is the issue #23 / T201 e2e acceptance arm. It
requires a real Google ADK install plus the live two-daemon mx-agent fixture and
drives:

```
ADK LlmAgent + MCPToolset → mx-loom-mcp --stdio → daemon A → daemon B
```

It does **not** call a model or require provider keys. The Python driver builds an
`LlmAgent`, asks ADK's `MCPToolset` to list the canonical `mx_*` tools, calls
`mx_find_agents`, then delegates the fixture's allowlisted named tool with
`mx_delegate_tool`. It also seeds the ADK parent process with clearly-fake
secret-shaped environment values and asserts ADK-visible tool lists/results remain
secret-free. Approval-ticket resume is intentionally out of scope here (T202).

ADK's `MCPToolset` spawns one `command` over stdio. By default this arm generates a
small launcher that runs `tsx packages/mcp/src/cli.ts` — the same proven in-repo
subprocess path `packages/mcp/test/stdio.integration.test.ts` uses. (The built
`dist/cli.js` is **not** independently runnable under plain `node` in this workspace:
every `@mx-loom/*` package's `exports` points at TypeScript source, so the built
bin's cross-package `./foo.js` specifiers do not resolve until the standalone bin is
published in T602.) Set `MXL_ADK_MCP_COMMAND` to a globally linked / published
`mx-loom-mcp` to exercise the real packaged bin instead — no `pnpm build` step is
needed for the default path.

```sh
# Setup: install ADK in a venv/interpreter (tsx already comes with pnpm install).
python3 -m venv .venv-adk
. .venv-adk/bin/activate
python -m pip install -r examples/adk/requirements.txt

# Bring up daemon A+B using scripts/conformance/README.md, then run only the ADK arm.
MXL_ADK_MCP_E2E=1 \
MXL_ADK_PYTHON="$PWD/.venv-adk/bin/python" \
MXL_CONFORMANCE_TWO_DAEMON=1 \
MXL_CONFORMANCE_SOCKET=… \
MXL_CONFORMANCE_ROOM=… \
MXL_CONFORMANCE_TARGET_AGENT=… \
MXL_CONFORMANCE_TOOL=… \
  pnpm --filter @mx-loom/golden exec vitest run \
  --config vitest.e2e.config.ts test/adk.mcp-toolset.e2e.test.ts

# Optional: exercise a real linked/published mx-loom-mcp bin instead of tsx+source.
export MXL_ADK_MCP_COMMAND=/absolute/path/to/mx-loom-mcp

# Cleanup: deactivate the venv, tear down the daemon fixture, and unset opt-ins.
unset MXL_ADK_MCP_E2E MXL_ADK_PYTHON MXL_ADK_MCP_COMMAND
scripts/conformance/down.sh
```

If `MXL_ADK_MCP_E2E` is unset, the test skips cleanly. If it is set but Python,
`google-adk`, a runnable `mx-loom-mcp` command (`tsx` + source, or the
`MXL_ADK_MCP_COMMAND` bin), or the two-daemon fixture is missing, the run fails
rather than reporting a misleading green.

### T203 OpenCode `mcp` entry acceptance

`test/opencode.mcp-entry.e2e.test.ts` is the issue #25 / T203 e2e acceptance arm. It
renders this recipe's `opencode.json` (local stdio and remote HTTP), starts
`opencode serve` from a **scrubbed** environment, and drives:

```
OpenCode runtime → MCP (stdio | http) → mx-loom-mcp → daemon A → daemon B
```

Deterministically, with **no** model/provider call, it asserts via OpenCode's HTTP
API that the `mx-loom` server **connects** (`mcp.status`) and surfaces exactly the
canonical `mx_*` tools (`tool.ids`), with no authority verb. It seeds the OpenCode
parent process with clearly-fake secret-shaped values and asserts the scrubbed child
env, the rendered config, the tool ids, and any tool result remain secret-free (the
SDK's `createOpencodeServer` is deliberately not used — it spreads the parent env).
When `MXL_OPENCODE_MODEL` is set it additionally drives a real `session.prompt` so an
OpenCode agent calls `mx_delegate_tool`, then validates the returned T102 envelope.
Without a model, the delegation round-trip stays covered by the golden MCP (T114) and
ADK (T201) arms over the same `@mx-loom/mcp` server.

By default the arm spawns `mx-loom-mcp` via `tsx packages/mcp/src/cli.ts`; set
`MXL_OPENCODE_MCP_COMMAND` to a globally linked / published bin instead.

```sh
# Bring up daemon A+B (scripts/conformance/README.md), then run only the OpenCode arm.
MXL_OPENCODE_MCP_E2E=1 \
MXL_OPENCODE_MCP_MODE=both \
MXL_CONFORMANCE_TWO_DAEMON=1 \
MXL_CONFORMANCE_SOCKET=… \
MXL_CONFORMANCE_ROOM=… \
MXL_CONFORMANCE_TARGET_AGENT=… \
MXL_CONFORMANCE_TOOL=… \
  pnpm --filter @mx-loom/golden exec vitest run \
  --config vitest.e2e.config.ts test/opencode.mcp-entry.e2e.test.ts

# Optional opt-ins:
export MXL_OPENCODE_MODEL=anthropic/claude-haiku-4-5   # real model-in-loop delegate arm
export MXL_OPENCODE_BIN=/absolute/path/to/opencode      # specific opencode binary
export MXL_OPENCODE_MCP_COMMAND=/absolute/path/to/mx-loom-mcp

# Cleanup.
unset MXL_OPENCODE_MCP_E2E MXL_OPENCODE_MCP_MODE MXL_OPENCODE_MODEL MXL_OPENCODE_BIN MXL_OPENCODE_MCP_COMMAND
scripts/conformance/down.sh
```

Gating: `MXL_OPENCODE_MCP_E2E` unset → clean skip. Set but the `opencode` binary, a
runnable `mx-loom-mcp` command, or the two-daemon fixture is missing → hard failure,
never a misleading green. `MXL_OPENCODE_MCP_MODE=local|remote|both` (default `both`).
T206 later folds this into the full M2 portability matrix.

### T204 Pi capability smoke

`test/t204-pi-capability.e2e.test.ts` is the T204/#26 e2e smoke for the Pi
MCP-vs-native decision. It does **not** require mx-agent daemons, Matrix, a model, or
provider keys. Instead, it points at a real installed `@earendil-works/pi-coding-agent`
package and verifies the live Pi surface that the T204 decision depends on:

- Pi CLI/docs expose no built-in MCP mount (`--mcp` / `mcpServers`).
- Pi SDK native tools registered via `customTools` become active `AgentTool`s.
- Pi extension tools registered via `pi.registerTool()` become active `AgentTool`s.
- Both native paths execute through Pi's wrapper and return secret-free results.
- A **real** canonical-registry `enum` value-set (pulled from `CANONICAL_M1_TOOLS`,
  e.g. `mx_find_agents.liveness`) survives `StringEnum` -> live-Pi-TypeBox
  registration in the Google-compatible `{ type: 'string', enum: [...] }` shape
  (not `Type.Union`/`oneOf`) — grounding the decision record's Risk #3, the most
  consequential claim T205's descriptor->Pi mapping inherits.

It skips cleanly when no Pi package is configured. To demand it (fail-not-skip):

```sh
# Setup: install or locate Pi, then point at the package root that contains package.json.
export MXL_PI_PACKAGE_ROOT=/path/to/node_modules/@earendil-works/pi-coding-agent

# Run only the T204 Pi capability smoke.
MXL_PI_CAPABILITY_E2E=1 \
  pnpm --filter @mx-loom/golden exec vitest run \
  --config vitest.e2e.config.ts test/t204-pi-capability.e2e.test.ts

# Or run it along with the other e2e arms (golden live arms still need their own fixture flags).
MXL_PI_CAPABILITY_E2E=1 pnpm --filter @mx-loom/golden test:e2e

# Cleanup: unset the opt-in variables; the test removes its temporary Pi config/session dir.
unset MXL_PI_CAPABILITY_E2E MXL_PI_PACKAGE_ROOT
```

### Optional flags

- `MXL_AUDIT_PG=1` + `MXL_AUDIT_PG_DSN=postgres://…` — run the audit arm against a live
  `PostgresAuditSink` (writes + `SELECT` read-back + dedup no-op). The DSN is never logged.
- `MXL_GOLDEN_LIVE_MODEL=1` + `ANTHROPIC_API_KEY` — the opt-in real-model arm: a genuine
  `@anthropic-ai/claude-agent-sdk` `query()` through the shim. Loosened assertions; **never**
  the gate (cost / flakiness / secret-handling). `MXL_GOLDEN_LIVE_MODEL_NAME` overrides the
  model (default `claude-haiku-4-5`).

## Secret boundary

Every step asserts the full `CallToolResult` (and the serialised audit sink) does not
match `SECRET_PATTERN`. Matrix tokens, the Ed25519 private signing key, provider keys,
and `GH_TOKEN` live only in each daemon's on-disk state — they never enter the test
process, the bindings, the model context, or CI logs. The operator decision is issued by
a **separate** CLI against daemon B (`approval.decide` / `trust.*` / `policy.*` are
structurally absent from the model tool set); the test simulates the human, it does not
grant the model the power to approve.
