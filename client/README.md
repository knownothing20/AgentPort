# AgentPort Client

This directory is the explicit **local/client side** of AgentPort. Install or
copy one physical client directory per AI desktop application so each tool keeps
its own credentials, runtime state, logs, and MCP process lifecycle.

## Entrypoints

- `mcp-entry.js`: MCP stdio entrypoint used by Codex, WorkBuddy, Cursor, Windsurf,
  Claude Desktop, and other MCP hosts.
- `cli-entry.js`: CLI fallback for hosts that can execute terminal commands.
- `../packages/client-core/`: endpoint selection, project profiles, and future
  transport-independent client behavior.
- `../packages/shared/`: operation safety policies and request-scoped context.

## Compatibility

The entrypoints currently delegate to the legacy root `index.js` and `cli.js`.
Existing MCP tool names and CLI commands are unchanged. This allows the project
to migrate handlers gradually instead of replacing the working client in one
large rewrite.

## Recommended MCP configuration

```json
{
  "mcpServers": {
    "agentport": {
      "command": "node",
      "args": ["ABSOLUTE_PATH/AgentPort/client/mcp-entry.js"]
    }
  }
}
```

The old `ABSOLUTE_PATH/AgentPort/index.js` path remains supported.
