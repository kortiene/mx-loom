# mx-loom

**Weave any agent runtime into the MX-Agent coordination fabric.**

`mx-loom` is a portable tool layer that exposes [`mx-agent`](https://github.com/kortiene/mx-agent)'s
distributed coordination primitives — agent discovery, secure remote invocation, task
delegation, approvals, context sharing, trust, and audit — as ordinary **tools** inside any
LLM agent runtime. Google ADK, the Claude Agent SDK, OpenCode, Pi, or a custom runner each
keep their own model loop, planning, and memory; `mx-loom` gives them a shared, signed,
policy-enforced way to find each other and delegate work.

> A loom weaves separate threads into a single fabric. `mx-loom` weaves separate threads of
> **cognition** (each runtime's reasoning) into one fabric of **coordination** (the mx-agent
> mesh). **Cognition is pluggable; coordination is the constant.**

> **Status — active implementation (2026-06).** M0 and the M1 tool/binding/golden
> gate are in place, with live daemon/model verification still explicitly gated where
> noted. M2 universal-binding work is underway; T204 has decided Pi's integration path:
> native tool registration, not direct MCP mounting. See
> [`docs/mx-agent-tool-fabric-design.md`](docs/mx-agent-tool-fabric-design.md) and
> [`docs/backlog.md`](docs/backlog.md).

## The idea

Runtimes own **cognition**. mx-agent owns **coordination**. `mx-loom` is the thin, secret-free
adaptation layer between them — it translates each runtime's tool-calling ABI into the
mx-agent daemon's JSON-RPC, and nothing more.

```
┌─────────────────────────────────────────────────────────────────┐
│ COGNITION — external runtime (ADK / Claude SDK / OpenCode / Pi)   │
│   model loop · planning · private memory · prompt · tool-select   │
└───────────────▲───────────────────────────────────────────────────┘
                │  Boundary A: the runtime's tool-call ABI (MCP / function calling)
┌───────────────▼───────────────────────────────────────────────────┐
│ mx-loom — ADAPTATION                                              │
│   canonical tool registry · result envelope · async handles ·     │
│   per-runtime bindings (MCP server + native shims) · session map  │
│   NO secrets. NO model. NO enforcement — it only translates.      │
└───────────────▲───────────────────────────────────────────────────┘
                │  Boundary B: daemon Unix-socket JSON-RPC 2.0 (UID-gated, 0600)
┌───────────────▼───────────────────────────────────────────────────┐
│ mx-agent — COORDINATION (per-host daemon)                        │
│   Ed25519 signing · trust store · policy.toml · sandbox · /sync   │
│   task scheduler · approval gate · owns ALL Matrix credentials    │
└───────────────▲───────────────────────────────────────────────────┘
                │  Matrix federation + signed com.mxagent.* events
┌───────────────▼───────────────────────────────────────────────────┐
│ SUBSTRATE — Matrix homeserver(s) + remote daemons (the mesh)     │
└───────────────────────────────────────────────────────────────────┘
```

**Governing rule:** cognition can only ever produce a signed *request*; it can never grant
itself authority. Trust, policy, sandboxing, and approval all execute out-of-process on the
*receiving* daemon — so a misbehaving model is bounded by the union of policies of the agents
it can reach, not by anything it decides about itself.

## Where it fits in the mx-* family

| Repo | Role |
|---|---|
| [`mx-agent`](https://github.com/kortiene/mx-agent) | The coordination **substrate** — Rust CLI + daemon, Matrix-backed, signed `com.mxagent.*` events. |
| **`mx-loom`** *(this repo)* | The portable **tool layer** that weaves external runtimes into the mx-agent fabric. |
| `mx-agency` | An AI software **agency** platform built on top of the fabric (roles, intake, dashboards). Consumes `mx-loom` behind its `app/src/sdk` seam. |

## Supported runtimes (planned)

- **Google ADK** — `MCPToolset` + `LongRunningFunctionTool` (approval-aware).
- **Claude Agent SDK** — in-process `createSdkMcpServer` + `tool()`, with `canUseTool` for HITL.
- **OpenCode** — MCP server entry in `opencode.json`.
- **Pi** — native tool registration (T204: no built-in MCP client today; MCP only via a future extension-mediated path).
- **Custom** — any runner that speaks MCP or can accept a JSON-Schema tool list.

One canonical descriptor set generates every binding; bindings are never hand-authored per
runtime.

## Documentation

- [Design — MX-Agent as the Coordination Fabric](docs/mx-agent-tool-fabric-design.md)
- [Implementation backlog](docs/backlog.md)
- [Pi tool-surface capability decision (T204)](docs/pi-tool-surface-capability.md)

## Building mx-loom (the `adw_sdlc` harness)

`adw_sdlc/` is the **agentic build harness** used to implement mx-loom itself — internal dev
tooling, not part of the shipped tool fabric. It drives a GitHub issue (the backlog, #1–#49)
through a phased SDLC pipeline (classify → plan → implement → tests → review → … → merge) over one
`AgentRunner` seam with four interchangeable runners (`claude` | `codex` | `opencode` | `pi`). The
orchestrator owns all git/gh and withholds secrets from runners (deny-by-default env allowlist).
Phase prompts live in `.claude/commands/` + `.pi/prompts/`; the cross-engine state contract is
`adw/state.schema.json`.

```bash
pnpm install                                # from the repo root
pnpm -C adw_sdlc issue <N> --dry-run        # preview the plan for issue #N (no runner SDK needed)
pnpm -C adw_sdlc issue <N> --runner claude --yes   # run the pipeline on issue #N
```

See [`adw_sdlc/PORT.md`](adw_sdlc/PORT.md) for what changed in the mx-loom port.

## The name

A **loom** is the machine that holds many independent threads under tension and weaves them
into one cloth. That is precisely this layer's job: hold each runtime's cognition as its own
thread and weave them into the single coordination fabric mx-agent provides.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE).
