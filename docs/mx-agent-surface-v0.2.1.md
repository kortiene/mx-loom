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
| `workspace.status` | ✅ | `{room_id, canonical_alias, name, encrypted, joined_members, members[{user_id,display_name,membership}]}` — **backs `mx_workspace_status` (T108)**, composed with `agent.list` for the registered MX agents (this is the *Matrix room* view, carrying no `AgentState`s). The raw `members[].user_id` list is deliberately projected **out** (T104 precedent); model-facing identities are the MX `agent_id`s. _Unrecorded: whether it **takes** a `room` arg or defaults to the daemon's current workspace — the handler passes `deps.room` when present and tolerates its absence._ |
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
| `call.start` (delegate named tool) | ◻️ flags confirmed · round-trip staged | conformance Tier 2 (`packages/toolbelt/test/conformance/delegate.conformance.test.ts`, T007) round-trips `CallRequest`→`CallResponse`; gated behind the two-daemon fixture (`MXL_CONFORMANCE_TWO_DAEMON=1`). Flip to ✅ once that fixture runs green in CI. **Also the dispatch substrate for T303** — `mx_dispatch_task` re-routes a `kind: 'tool'` task action through `mx_delegate_tool` → `call.start`, so a dispatched action hits the same receiver pipeline as a direct delegation. |
| `exec.start` (guarded command) | ◻️ flags confirmed | same; receiver-side policy/approval gate. **Also the dispatch substrate for T303** — `mx_dispatch_task` re-routes a `kind: 'exec'` task action through `mx_run_command` → `exec.start`. |
| `task.create/update/list/graph` | ◻️ flags confirmed · round-trip staged | `task create --room --title [--tool --arg/--input-json --exec --depends-on --blocks --assign --state]` — matches the DAG + signed-action model. **Consumed by T301** (`mx_create_task` / `mx_update_task` / `mx_list_tasks` in `@mx-loom/registry`): the method/param names, the task-id field, the exact task-state vocabulary, the `task.graph` reply shape (nodes+edges vs edges-only / whether `task.list` already carries edges), whether `task.update` accepts edge edits, and `audit_ref` availability are authored against these named shapes with **localised wire consts** and pinned at the two-daemon round-trip (`MXL_CONFORMANCE_TWO_DAEMON=1`). Flip to ✅ and record the pinned shapes once that fixture runs green. **`task.list` is also the single-task read for T303**: `mx_dispatch_task` resolves a node by `task_id` via `task.list` + a client-side id filter (the T104/T302 precedent) rather than depending on an unconfirmed `task.get`/`task.show`/`task.dispatch` RPC — if the round-trip reveals a first-class single-task read or a daemon-side dispatch RPC, it is a localised swap (a method const), and the AC holds either way since both routes hit the receiver pipeline. |
| `share.file/diff/env` · `approval.decide` · `invocation.*` | ◻️ documented | exercise in the conformance suite (T007 / #7) with a two-daemon fixture. **`invocation.get` backs `mx_await_result` (T103); `invocation.cancel` backs `mx_cancel` (T108)** — the cancel method/param name (`invocation_id`) + reply disposition (`{cancelled?, state?}`) are authored against the design (localised consts) and pinned at the two-daemon round-trip (a cancel needs an in-flight invocation). |
| `approval.list` · `approval.approve` / `approval.deny` (the **operator** side of `approval.decide`) | ◻️ documented · golden-gate driver | the **operator-only** approval surface, exercised out-of-band by T114's `scripts/conformance/decide-approval.sh` (run as daemon B's identity via the `mx-agent` CLI; **never** a `@mx-loom/*` model-facing surface). The `approval list/approve/deny` CLI/RPC spelling is **UNVERIFIED** — localised at the top of `decide-approval.sh` (and the field used to extract the pending `request_id`/`id`) so a wrong v0.2.1 spelling is a one-line fix; a wrong spelling fails the golden run RED. Pin/correct here once the golden two-daemon fixture runs (spec OQ #2). The guarded-exec **enable** step (whether a daemon toggle beyond the `[exec]` policy block is needed) is likewise localised in `bootstrap-daemon-b.sh` and pinned then (OQ #5). |

## `policy.toml` schema (T112 / #20) — authored against design, live pin staged

The receiver's deny-by-default guard is a `policy.toml` file the **daemon** reads
and enforces (design §6 layer 3); mx-loom never parses it — it only observes the
verdict as a normalized envelope (`policy_denied` → `status: denied`; held →
`awaiting_approval`). T112 authors the canonical golden-test fixture
(`scripts/conformance/policy.golden.toml`).

**Verification status: STAGED, not yet live.** Unlike the RPC methods above
(exercised against a live daemon by T001), the `policy.toml` **file schema** has
**not** been pinned against a running `v0.2.1` daemon — no daemon was available in
the implementing environment. Three in-repo sources disagree, so the grammar
below is **authored against the design's named keys (§6 layers 3/4), pending the
live load check** (AC 1, gated behind `MXL_CONFORMANCE_TWO_DAEMON=1`). Treat a
daemon rejection as RED; update this table to the verified grammar when the live
load succeeds.

- **Load path (assumed).** `$XDG_DATA_HOME/mx-agent/policy.toml` (Linux) — the
  bring-up writes it **before** `agent.register` so B enforces deny-by-default
  from the first request. _Unverified:_ whether the daemon auto-loads on start,
  watches the file, or needs a `policy.*` RPC/CLI to (re)load.

| Key | Authored grammar | Status |
|---|---|---|
| `default` | top-level `default = "deny"` — deny-by-default fall-through | ⬜ pin at AC 1 |
| named-tool allow | `[[allow]]` array-of-tables, each `{ tool = "<name@ver>", requires_approval = <bool> }` | ⬜ matches `policy.b.toml` precedent; pin at AC 1 |
| command allowlist | `[exec]` block: `allow_commands = ["<bin>"]` | ⚠️ **divergence** — `exec.conformance.test.ts` assumes `[[allow_commands]]`; design §6 lists `allow_commands` conceptually. Pin the real shape at AC 1. |
| `deny_args_regex` | TOML **literal** string (single quotes) so `\s`/`\b` aren't TOML escapes, e.g. `'(\|\s*sh\b\|\brm\s+-rf\s+/\|\bssh\b\|\bcurl\b)'` | ⬜ pin regex flavor at AC 1 |
| `allow_cwd` | `allow_cwd = ["<dir>"]` array | ⬜ pin at AC 1 |
| `network` | top-level `network = "deny"` egress default, inherited by exec | ⬜ pin at AC 1 |
| sandbox backend | `[exec] sandbox = "bubblewrap" \| "docker" \| "podman"` | ⬜ pin accepted values at AC 1 |
| `requires_approval` | per-tool and per-`[exec]`; `true` holds the request (`awaiting_approval`) | ⬜ pin at AC 1 |
| runtime/output caps | design §6 names them; **not** in the v1 fixture | ⬜ not exercised by T112 |

**Deltas from design §6.** The design lists the keys *conceptually* (`allow_tools`,
`allow_commands`, `allow_cwd`, `deny_args_regex`, sandbox, network,
`requires_approval`) with no TOML shape. The fixture realizes per-tool allow as
`[[allow]] tool=…` (not a flat `allow_tools = […]`) following the `policy.b.toml`
precedent, and the command allowlist as an `[exec]` block. Both are the load-bearing
unknowns the AC-1 live check must confirm or correct.

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
  **`agent.show` was NOT confirmed on v0.2.1** — it is absent from the verified-methods table
  above (design §2 maps `mx_describe_agent` → `agent.show` + `agent.tools`, but the live spike did
  not exercise `agent.show`). T104 therefore backs `mx_describe_agent` on the **verified**
  `agent.list` + `agent.tools` only: `agent.tools` supplies the published `schemas[]`, `agent.list`
  the liveness/workspace/load metadata. An `agent.show {agent_id}` fast-path is gated off behind a
  wire const in the handler; **flip it on (and update this note) if a future pin verifies `agent.show`.**
- The conformance suite (T007 / #7) is built (`packages/toolbelt/test/conformance/`,
  `.github/workflows/conformance.yml`): Tier 0/1 (`agent.register` / `agent.list` + error taxonomy)
  are **green on v0.2.1**; full delegation (`call.start`, Tier 2) is staged behind the **two-daemon
  fixture** — reuse `mx-agent/dev/matrix` + a second registered agent (`scripts/conformance/`).

---
_Verified 2026-06-22 against a local Tuwunel homeserver. Reproduce: `mx-agent/scripts/matrix_dev.sh up`,
register a user, `mx-agent auth login --homeserver http://127.0.0.1:8008 --user <u>`, then the methods above._
