# mx-loom examples

Runnable, verified recipes for mounting the mx-loom toolbelt in a specific agent
runtime. **Start with the [Runtime integration guide](../docs/runtime-integration.md)**
— it gives one copy-pasteable setup per runtime and links each example here as the
canonical deep reference.

| Example | Runtime | Mechanism |
|---|---|---|
| [`adk/`](./adk/README.md) | Google ADK (Python) | `MCPToolset` over `mx-loom-mcp --stdio` ([`mcp_toolset_agent.py`](./adk/mcp_toolset_agent.py)); optional `LongRunningFunctionTool` ([`long_running_tools.py`](./adk/long_running_tools.py)) |
| [`opencode/`](./opencode/README.md) | OpenCode | `opencode.json` `mcp` entry — [local stdio](./opencode/opencode.local.example.json) / [remote HTTP](./opencode/opencode.remote.example.json) |

The other bindings are **libraries**, not example dirs — they link the toolbelt
directly and are documented in their package READMEs:

- **Claude Agent SDK** (in-process shim) — [`packages/claude`](../packages/claude/README.md)
- **Claude Code / Desktop** (`mcpServers` entry) and the generated server —
  [`packages/mcp`](../packages/mcp/README.md)
- **Pi** (native tool registration) — [`packages/pi`](../packages/pi/README.md)
- **Custom runners** — [Runtime integration guide → Custom runners](../docs/runtime-integration.md#custom-runners)

Every example uses **obviously-fake placeholders** (`!workspace:server`,
`<your-model>`, `adk_<session_id>`) — never realistic credentials. The secret
boundary is the load-bearing rule in each one: Matrix tokens, signing keys,
provider keys, and `GH_TOKEN` never cross into the runtime, the model context, or
any child. See the guide's
[secret-boundary section](../docs/runtime-integration.md#the-secret-boundary-read-this).
</content>
