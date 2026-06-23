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
