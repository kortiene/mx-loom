# mx-agent daemon surface — verified against v0.2.1 (T001 / #1)

The verified method/schema table for the pinned substrate (`.mx-agent-version` = `v0.2.1`) — the
surface the mx-loom toolbelt integrates against (**Boundary B** in
[`mx-agent-tool-fabric-design.md`](./mx-agent-tool-fabric-design.md)). This closes the T001
surface-verification spike (#1) by exercising the **live daemon**, not just reading docs.

## How this was verified

- Substrate: `mx-agent 0.2.1` release binary.
- Homeserver: throwaway localhost Tuwunel via `mx-agent/dev/matrix` (`scripts/matrix_dev.sh up`) — no external creds.
- Session: daemon logged in as `@mxloom:localhost` (device `mBdvF3VSWX`), `/sync` state `healthy`.
- Transport: Unix-domain-socket JSON-RPC 2.0 at `$TMPDIR/mx-agent/daemon.sock` (macOS; `$XDG_RUNTIME_DIR/mx-agent/daemon.sock` on Linux).

## Verified methods (live round-trip)

| Method (RPC / CLI) | Status | Observed result shape |
|---|---|---|
| `daemon.status` | ✅ | `{running, pid, uptime_seconds, socket_path, version:"0.2.1", sync:{state,total_syncs,consecutive_failures,...}}` |
| `auth login` / `auth status` | ✅ | `{logged_in:true, homeserver, user_id, device_id}` |
| `workspace.create` | ✅ | `{room_id, encrypted, joined_members}` |
| `workspace.status` | ✅ | `{room_id, canonical_alias, name, encrypted, joined_members, members[{user_id,display_name,membership}]}` |
| `agent.register` | ✅ | full `AgentState` (below) |
| `agent.list` | ✅ | `[{agent: AgentState, liveness:"active"\|"stale"\|"offline"}]` |
| `agent.tools` | ✅ | `{agent_id, kind, status, capabilities[], tools[], schemas:[ToolSchema]}` |
| `trust.fingerprint` | ✅ | `{alg:"ed25519", fingerprint:"SHA256:…", key_id:"mxagent-ed25519:…"}` |
| auth-gating | ✅ | login-required methods reject with `not logged in; run mx-agent auth login first` before login |

### `AgentState` (`com.mxagent.agent.v1`) — confirmed

`{agent_id, kind, matrix_user_id, device_id, signing_key_id ("mxagent-ed25519:…"),
signing_public_key (base64 Ed25519), status, capabilities[], tools[],
workspace{cwd, project_id, git_commit}, load{running_invocations, max_invocations},
last_seen_ts, state_rev}` — matches design §2 field-for-field.

### `ToolSchema` (`com.mxagent.tool.v1`) — confirmed

`{name, version, description, input_schema (JSON Schema), output_schema (JSON Schema)}`.
Observed for `run_tests@1.0.0` exactly as the design-doc example: input `{package(req), coverage, name}`
→ output `{exit_code, summary, log_mxc}`. **`input_schema` pass-through for `mx_delegate_tool` (T105) is confirmed available.**

**JSON Schema dialect.** v0.2.1's observed `input_schema`/`output_schema` use only the simple
`{type, properties, required}` core (no draft-specific keywords), so the exact draft is not
distinguishable from the wire alone. **T101 standardizes the canonical registry on draft-07**
(`http://json-schema.org/draft-07/schema#` — Ajv's default meta-schema, the broadest interop target,
and within T111's Zod-conversion subset). The observed v0.2.1 shapes are a compatible subset of
draft-07, so T105's dynamic pass-through validation and T111's converter agree. _Action: if a future
v0.2.1 `ToolSchema` emits a draft-2020-12-specific keyword (`$defs`, `prefixItems`, `unevaluated*`),
revisit the dialect pin here and in `@mx-loom/registry`._

## Surface present, full round-trip pending (needs ≥2 agents/daemons)

| Method (RPC / CLI) | Status | Note |
|---|---|---|
| `call.start` (delegate named tool) | ◻️ flags confirmed · round-trip staged | conformance Tier 2 (`packages/toolbelt/test/conformance/delegate.conformance.test.ts`, T007) round-trips `CallRequest`→`CallResponse`; gated behind the two-daemon fixture (`MXL_CONFORMANCE_TWO_DAEMON=1`). Flip to ✅ once that fixture runs green in CI. |
| `exec.start` (guarded command) | ◻️ flags confirmed | same; receiver-side policy/approval gate |
| `task.create/update/list/graph` | ◻️ flags confirmed | `task create --room --title [--tool --arg/--input-json --exec --depends-on --blocks --assign --state]` — matches the DAG + signed-action model |
| `share.file/diff/env` · `approval.decide` · `invocation.*` | ◻️ documented | exercise in the conformance suite (T007 / #7) with a two-daemon fixture |

## CLI `--json` fallback transport (T003 / #3)

The toolbelt's secondary transport (ADR-11) is a one-shot `mx-agent <noun> <verb> --json` CLI
invocation, implemented in `packages/toolbelt/src/cli/` as `CliClient` (a standalone sibling of
`IpcClient`; transport *selection* is T004 / #4).

- **Verb forms used.** Dotted RPC methods map to noun/verb argv by splitting on `.` and appending
  `--json`: `daemon.status` → `mx-agent daemon status --json`, `agent.list` → `mx-agent agent list
  --json`, `workspace.status` → `mx-agent workspace status --json` (the M0 read methods the IPC
  client already round-trips). Structured params are written to the child's **stdin** via
  `--input-json -` (never on argv, which is world-readable via `/proc/<pid>/cmdline` / `ps`).
- **`--json` output framing — NOT yet live-verified.** This implementation was written without an
  `mx-agent` binary on the build host, so the exact stdout shape (bare RPC `result` vs. a wrapper
  such as `{jsonrpc, id, result}` / `{ok, data}`) is **still open** (spec open question #1). The
  normalizer (`CliClient`) handles **both**: a top-level object with a `result` field is unwrapped to
  `.result`; otherwise the parsed JSON is treated as the bare result — so the resolved value matches
  what `IpcClient.call()` returns for the same method either way. **Action:** run `mx-agent daemon
  status --json` against a live `v0.2.1` daemon and record the actual framing + `--input-json -` /
  stdin support per verb here, then tighten the normalizer if the wrapper differs from these two shapes.
- **Errors** are normalized onto the same closed `IpcErrorCode` set (aliased `TransportErrorCode`):
  spawn `ENOENT` → `not_running`; other spawn errors → `connect_failed`; deadline/kill → `timeout`;
  a JSON-RPC error object on stdout/stderr → `rpc`; any other non-JSON / non-zero exit → `protocol`;
  credential-shaped args rejected pre-spawn → `invalid_args`.
- **Secret boundary.** The CLI child is spawned under a deny-by-default env allowlist
  (`packages/toolbelt/src/cli/env.ts`) — no `MATRIX_*` / `MX_AGENT_*`, no provider keys, no
  `GH_TOKEN`. The mx-agent binary needs none of these (it reads its signing key + Matrix session from
  on-disk state). The non-secret bin override is `MXL_AGENT_BIN` (read from the parent env only, never
  forwarded). This allowlist is intentionally **stricter** than `adw_sdlc/src/env.ts`.

## Deltas from design §2

**None material.** CLI verbs are `agent.<noun>`/`workspace.<noun>`; published schemas match the
design doc's `AgentState`, `ToolSchema`, and Ed25519 identity. `key_id` and `fingerprint` share the
same base64 SHA-256 digest (`mxagent-ed25519:<x>` and `SHA256:<x>`).

## Implications for the toolbelt (unblocks T002 → T004)

- **Boundary B framing confirmed** — build the IPC client (T002 / #2) against
  `$TMPDIR/mx-agent/daemon.sock` (macOS) / `$XDG_RUNTIME_DIR/mx-agent/daemon.sock`, framed JSON-RPC 2.0.
- `agent.register` / `agent.list` / `agent.tools` are ready to back `mx_find_agents` /
  `mx_describe_agent` (T104) and the `input_schema` pass-through of `mx_delegate_tool` (T105).
- The conformance suite (T007 / #7) is built (`packages/toolbelt/test/conformance/`,
  `.github/workflows/conformance.yml`): Tier 0/1 (`agent.register` / `agent.list` + error taxonomy)
  are **green on v0.2.1**; full delegation (`call.start`, Tier 2) is staged behind the **two-daemon
  fixture** — reuse `mx-agent/dev/matrix` + a second registered agent (`scripts/conformance/`).

---
_Verified 2026-06-22 against a local Tuwunel homeserver. Reproduce: `mx-agent/scripts/matrix_dev.sh up`,
register a user, `mx-agent auth login --homeserver http://127.0.0.1:8008 --user <u>`, then the methods above._
