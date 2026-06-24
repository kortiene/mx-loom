# OpenCode × mx-loom — MCP server entry (T203 / #25)

Mount the generated **`mx-loom-mcp`** server from `opencode.json` so an OpenCode
agent can discover and call the canonical `mx_*` coordination tools over MCP:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mx-loom": {
      "type": "local",
      "command": ["mx-loom-mcp", "--stdio", "--room", "!workspace:server",
                  "--kind", "opencode", "--correlation-id", "opencode_<session-id>"]
    }
  }
}
```

This is the **generic MCP `mcp` entry** (issue #25 acceptance: *an OpenCode agent
calls `mx_delegate_tool` via the configured MCP server*). OpenCode consumes the
**same** universal server ADK mounts via `MCPToolset` (T201) and Claude Code via
`mcpServers` — there is **no** `@mx-loom/opencode` package and no OpenCode-specific
tool authoring. The tool schemas are generated from the canonical
`@mx-loom/registry` descriptors by `@mx-loom/mcp`; OpenCode never hand-authors or
forks them.

> Ready-to-copy configs live next to this README:
> [`opencode.local.example.json`](./opencode.local.example.json) and
> [`opencode.remote.example.json`](./opencode.remote.example.json).

## What you get

Through the configured server an OpenCode agent can:

- **list** the nine canonical tools — `mx_find_agents`, `mx_describe_agent`,
  `mx_delegate_tool`, `mx_run_command`, `mx_await_result`, `mx_share_context`,
  `mx_get_context`, `mx_cancel`, `mx_workspace_status` (and **only** those — no
  `trust.*` / `approval.decide` / `policy.*` / `auth.*` / `device.*` / `daemon.*`
  authority verb is reachable); and
- **call** any of them and receive the normalized **T102 result envelope**
  (`status`, `result`, `error`, `handle`, `approval`, `audit_ref`).

OpenCode namespaces MCP tools by server name, so in OpenCode tool ids / transcripts
`mx_delegate_tool` is surfaced under the `mx-loom` server (e.g.
`mx-loom_mx_delegate_tool`). The underlying MCP tool is still `mx_delegate_tool`;
the gated e2e asserts the canonical name regardless of OpenCode's exact namespacing.

## Two modes

OpenCode supports two `mcp` entry shapes, verified against `@opencode-ai/sdk`'s
`McpLocalConfig` / `McpRemoteConfig`:

| Mode | `type` | Who spawns the server | Key fields |
|---|---|---|---|
| **local stdio** | `"local"` | OpenCode spawns `mx-loom-mcp --stdio` | `command` (string array), optional `environment`, `enabled` |
| **remote** | `"remote"` | you run `mx-loom-mcp --http` separately | `url`, `enabled` (no `headers`/`oauth` — localhost, no auth) |

### Local stdio

OpenCode spawns `mx-loom-mcp --stdio` as a child process. The non-secret session
config (`--room`, `--kind`, `--correlation-id`) rides the `command` array:

```jsonc
// opencode.local.example.json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mx-loom": {
      "type": "local",
      "enabled": true,
      "command": [
        "mx-loom-mcp", "--stdio",
        "--room", "!workspace:server",
        "--kind", "opencode",
        "--correlation-id", "opencode_<session-id>"
      ],
      "environment": { "PATH": "{env:PATH}", "HOME": "{env:HOME}",
                       "XDG_RUNTIME_DIR": "{env:XDG_RUNTIME_DIR}" }
    }
  }
}
```

### Remote (Streamable HTTP)

Start the server yourself with the session config the local `command` would
otherwise carry, then point OpenCode at it:

```sh
mx-loom-mcp \
  --http --host 127.0.0.1 --port 7800 \
  --room '!workspace:server' \
  --kind opencode \
  --correlation-id 'opencode_<session-id>'
```

```jsonc
// opencode.remote.example.json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mx-loom": { "type": "remote", "enabled": true, "url": "http://127.0.0.1:7800" }
  }
}
```

`mx-loom-mcp`'s HTTP transport is **stateless and path-agnostic** — it routes every
request path to a single transport — so the `url` is the server **root**
(`http://127.0.0.1:7800`), no `/mcp` path segment.

## Setup

1. **Install / link `mx-loom-mcp` or provide a launcher.** OpenCode's local entry
   spawns `command[0]`; it must be resolvable on `PATH` or absolute.

   In this source workspace — before T602 publishes a standalone bin — prefer a
   tiny launcher that runs the source entry with `tsx` (the same path the gated
   e2e arm and the ADK recipe use):

   ```bash
   cat > /usr/local/bin/mx-loom-mcp <<'SH'
   #!/usr/bin/env bash
   exec /absolute/path/to/mx-loom/packages/mcp/node_modules/.bin/tsx \
     /absolute/path/to/mx-loom/packages/mcp/src/cli.ts "$@"
   SH
   chmod 755 /usr/local/bin/mx-loom-mcp
   ```

   Do **not** point OpenCode at `packages/mcp/dist/cli.js` directly in this
   workspace: every `@mx-loom/*` package's `exports` targets TypeScript source, so
   the built bin's cross-package `./foo.js` specifiers do not resolve under plain
   `node` until the standalone bin is published (T602).

   Verify: `mx-loom-mcp --stdio` starts and logs `connected over stdio` to
   **stderr** once a daemon is reachable (stdout is the MCP protocol channel).

2. **Drop `opencode.json` in your project root** (or merge the `mcp` block into an
   existing one). Copy [`opencode.local.example.json`](./opencode.local.example.json)
   or [`opencode.remote.example.json`](./opencode.remote.example.json) and fill in
   your room + correlation id.

3. **Confirm the server connected.** OpenCode reports MCP status without a model
   call — `opencode mcp` (CLI) or the SDK `client.mcp.status()` should list
   `mx-loom` as connected, and `client.tool.ids()` should include the
   `mx-loom_mx_*` tool ids.

## Session mapping (one session ⇒ one process ⇒ one room)

- **One OpenCode workspace/session → one workspace room → one `mx-loom-mcp`
  process/session → one `MxSession` registration.** Use one `mx-loom` entry per
  workspace; do not share a single process across unrelated rooms until tenant
  scoping (M5) supports it.
- The **room** and **correlation id** are *session config* supplied through the
  `command` array (local) or the CLI flags (remote) — they are **never** model
  tool arguments. The model never names a Matrix room; the MCP server's
  `BindingContext` injects it from the session.
- A stable `correlation_id` (e.g. `opencode_<session-id>`) joins OpenCode session
  activity to daemon audit rows.
- Optional non-secret workspace metadata (`--cwd`, `--project-id`, `--git-commit`)
  and a concurrency declaration (`--max-invocations`) may also ride the
  `command` array / CLI; they travel on `agent.register`, not model args.

## The secret boundary (read this)

Matrix tokens, Ed25519 signing keys, provider keys, and `GH_TOKEN` must **never**
cross into the `mx-loom-mcp` child, the model context, or the agent's tool calls.
For OpenCode local mode, OpenCode — not mx-loom — spawns the child, so you own the
child's environment:

1. **Load-bearing control — launch OpenCode from a scrubbed environment.**
   OpenCode's per-server `environment` field **adds** variables; it does **not**
   reset the inherited env. So the child inherits whatever the OpenCode process
   holds. Start OpenCode (`opencode serve` / `opencode` / your launcher) from a
   deny-by-default environment that holds no provider key, no `MATRIX_*`/
   `MX_AGENT_*`, no `*_TOKEN`/`*_API_KEY`/`*_SECRET`/`*_ACCESS_KEY`, and no
   `GH_TOKEN`. That is the only thing that keeps secrets out of the child.
2. **Belt-and-braces — the per-server `environment` allowlist.** The local example
   sets only the non-secret operational vars the child needs to resolve the bin
   and the daemon socket (`PATH`, `HOME`, `XDG_RUNTIME_DIR`), via OpenCode's
   `{env:NAME}` config substitution. Keep this list non-secret; never add a
   credential-shaped key. (If your OpenCode version does not support `{env:…}`
   substitution, set concrete non-secret values or omit the block and rely on the
   scrubbed launch above.)
3. **Never put credentials in `opencode.json`.** The `command`/`environment`/`url`
   fields may carry non-secret session config only — no Matrix credentials,
   signing/provider keys, `GH_TOKEN`, `DATABASE_URL`/audit DSN, trust-store paths,
   policy mutation fields, or approval decisions.

The MCP server still reaches the daemon **only** through the toolbelt `MxClient` /
`MxSession`, so credential-shaped tool **arguments** are rejected (`invalid_args`)
before dispatch and inbound daemon values are redacted — the local stdio work does
not bypass that path. The deny rules mirror the canonical TypeScript source of
truth in [`packages/toolbelt/src/cli/env.ts`](../../packages/toolbelt/src/cli/env.ts)
(`BASE_ENV_ALLOW` + `isDeniedEnvKey`).

### Remote exposure

`mx-loom-mcp --http` binds to `127.0.0.1` by default and adds **no** authentication.
Keep the remote `url` localhost. Non-local exposure is explicit operator opt-in and
**must** sit behind an authenticated reverse proxy: an open endpoint would let an
unauthorized caller *issue requests as this agent*, even though the daemon still
independently enforces trust/policy/approval per request. Any proxy credentials are
an operational secret and must not appear in committed `opencode.json`, model
prompts, tool args, or logs — so the remote example commits no `headers`/`oauth`.

### Out-of-process enforcement remains authoritative

Trust (Ed25519 store), deny-by-default `policy.toml`, sandbox, and human approval
gates all execute on the receiving mx-agent daemon. The OpenCode agent can only
produce a signed request; it never grants itself authority. Approval reaches the
model **only** as the `awaiting_approval` result status, re-validated against live
policy at release.

## Reading results

Every tool call returns the full T102 envelope. Modern MCP clients expose
`structuredContent`; OpenCode also receives the JSON text content `mx-loom-mcp`
always emits, so parse that if `structuredContent` is not surfaced.

- `status: "ok"` — success; `result` holds the payload, `audit_ref` is present.
- `status: "denied"` — a **governance** outcome (not a tool exception): the agent
  reads the denial and replans.
- `status: "running"` / `"awaiting_approval"` — **not** a failure. The envelope
  carries a `handle`; the agent keeps working and later calls
  `mx_await_result(handle)` (generic MCP has no native long-running-tool protocol,
  so OpenCode surfaces these as ordinary results).
- `status: "error"` — a genuine fault; `error.code` is from the closed taxonomy
  (`policy_denied`, `untrusted_key`, `approval_denied`, `approval_expired`,
  `timeout`, `not_found`, `invalid_args`, `target_offline`, `internal`).

For mutating retries supply an explicit `idempotency_key` to `mx_delegate_tool` /
`mx_run_command` so the daemon dedupes.

## Troubleshooting

- **`mx-loom` shows `failed` in `mcp.status`** — `command[0]` is not resolvable, or
  no daemon is reachable; see *Setup* step 1.
- **Room-scoped tool fails fast** — you omitted `--room`; the room is session
  config, not a model arg.
- **Provider key visible to the child** — OpenCode was launched with secrets in its
  env; `environment` only adds, it does not scrub. Launch OpenCode scrubbed.
- **Treating `awaiting_approval` as an error** — it is a deferred state; resolve it
  with `mx_await_result(handle)`.

## Live two-daemon acceptance (gated)

The T203/#25 e2e acceptance arm lives in
[`packages/golden/test/opencode.mcp-entry.e2e.test.ts`](../../packages/golden/test/opencode.mcp-entry.e2e.test.ts).
It renders this recipe's `opencode.json`, starts `opencode serve` from a scrubbed
environment, and asserts — deterministically, **without a model/provider call** —
that the `mx-loom` server connects (`mcp.status`) and surfaces exactly the canonical
`mx_*` tools (`tool.ids`), with no authority verb. When a model route is supplied it
additionally drives an OpenCode agent to call `mx_delegate_tool` through the
configured server and validates the returned T102 envelope.

```bash
# Bring up daemon A+B (see scripts/conformance/README.md), then run only the OpenCode arm.
MXL_OPENCODE_MCP_E2E=1 \
MXL_OPENCODE_MCP_MODE=both \
MXL_CONFORMANCE_TWO_DAEMON=1 \
MXL_CONFORMANCE_SOCKET=… \
MXL_CONFORMANCE_ROOM=… \
MXL_CONFORMANCE_TARGET_AGENT=… \
MXL_CONFORMANCE_TOOL=… \
  pnpm --filter @mx-loom/golden exec vitest run \
  --config vitest.e2e.config.ts test/opencode.mcp-entry.e2e.test.ts

# Optional: drive a real model-in-loop mx_delegate_tool call (provider auth via
# OpenCode's own auth store, never a key passed to the MCP child).
export MXL_OPENCODE_MODEL=anthropic/claude-haiku-4-5

# Optional: exercise a real linked/published mx-loom-mcp bin instead of tsx+source.
export MXL_OPENCODE_MCP_COMMAND=/absolute/path/to/mx-loom-mcp

# Optional: point at a specific opencode binary.
export MXL_OPENCODE_BIN=/absolute/path/to/opencode
```

If `MXL_OPENCODE_MCP_E2E` is unset, the arm skips cleanly. If it is set but the
`opencode` binary, a runnable `mx-loom-mcp` command, or the two-daemon fixture is
missing, it fails rather than reporting a misleading green. T206 later extends this
into the full M2 portability matrix.
