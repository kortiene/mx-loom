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

## Surface present, full round-trip pending (needs ≥2 agents/daemons)

| Method (RPC / CLI) | Status | Note |
|---|---|---|
| `call.start` (delegate named tool) | ◻️ flags confirmed | needs a second target agent to round-trip `CallRequest`→`CallResponse` |
| `exec.start` (guarded command) | ◻️ flags confirmed | same; receiver-side policy/approval gate |
| `task.create/update/list/graph` | ◻️ flags confirmed | `task create --room --title [--tool --arg/--input-json --exec --depends-on --blocks --assign --state]` — matches the DAG + signed-action model |
| `share.file/diff/env` · `approval.decide` · `invocation.*` | ◻️ documented | exercise in the conformance suite (T007 / #7) with a two-daemon fixture |

## Deltas from design §2

**None material.** CLI verbs are `agent.<noun>`/`workspace.<noun>`; published schemas match the
design doc's `AgentState`, `ToolSchema`, and Ed25519 identity. `key_id` and `fingerprint` share the
same base64 SHA-256 digest (`mxagent-ed25519:<x>` and `SHA256:<x>`).

## Implications for the toolbelt (unblocks T002 → T004)

- **Boundary B framing confirmed** — build the IPC client (T002 / #2) against
  `$TMPDIR/mx-agent/daemon.sock` (macOS) / `$XDG_RUNTIME_DIR/mx-agent/daemon.sock`, framed JSON-RPC 2.0.
- `agent.register` / `agent.list` / `agent.tools` are ready to back `mx_find_agents` /
  `mx_describe_agent` (T104) and the `input_schema` pass-through of `mx_delegate_tool` (T105).
- Full delegation (`call.start`) and the conformance suite (T007 / #7) need a **two-daemon fixture** —
  reuse `mx-agent/dev/matrix` + a second registered agent.

---
_Verified 2026-06-22 against a local Tuwunel homeserver. Reproduce: `mx-agent/scripts/matrix_dev.sh up`,
register a user, `mx-agent auth login --homeserver http://127.0.0.1:8008 --user <u>`, then the methods above._
