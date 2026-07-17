# AgentPort Client

This directory is the explicit **local/client side** of AgentPort. Install or
copy one physical client directory per AI desktop application so every tool keeps
its own credentials, selected server, logs, and MCP process lifecycle.

## Entrypoints

- `mcp-entry.js`: compatibility bootstrap for Codex, WorkBuddy, Cursor, Windsurf,
  Claude Desktop, and other MCP hosts.
- `mcp-v3.js`: modular MCP implementation with logical servers, immutable request
  contexts, project profiles, idempotency keys, and cursor logs.
- `cli-entry.js`: compatibility CLI. New `server`, `project`, and `v3` commands use
  the modular runtime; every other command delegates to the existing root CLI.
- `modular-cli.js`: project-aware modular CLI implementation.
- `../packages/client-core/`: connection registry, endpoint selection, project
  profiles, session state, and request runtime.
- `../packages/client-transport/`: daemon HTTP transport and lazy SSH adapter.
- `../packages/shared/`: operation-specific safety policies and immutable request
  contexts.

## Automatic compatibility mode

`client/mcp-entry.js` uses this order:

1. `AGENTPORT_CLIENT_MODE=legacy` always starts the original root `index.js`.
2. `AGENTPORT_CLIENT_MODE=v3` always starts `mcp-v3.js`.
3. In the default `auto` mode, `local/connections.v3.json` enables V3; otherwise
   the original root MCP implementation starts.

Existing registrations pointing directly to root `index.js` are unchanged.

## V3 connection setup

Copy and edit:

```text
local/connections.v3.json.example -> local/connections.v3.json
local/projects.json.example       -> local/projects.json
```

A logical server can contain several endpoints:

```text
debian-main
  -> LAN daemon
  -> virtual-LAN daemon
  -> SSH recovery
```

The client probes endpoint identity and health before each uncached selection.
Mutating operations require matching `serverId` and `workspaceId`; long-running
Jobs require a daemon endpoint.

## Recommended MCP configuration

```json
{
  "mcpServers": {
    "agentport": {
      "command": "node",
      "args": ["ABSOLUTE_PATH/AgentPort/client/mcp-entry.js"],
      "env": {
        "AGENTPORT_CLIENT_MODE": "auto"
      }
    }
  }
}
```

## Modular CLI examples

```bash
node client/cli-entry.js server list --json
node client/cli-entry.js server health debian-main --force
node client/cli-entry.js server select debian-main

node client/cli-entry.js project list
node client/cli-entry.js project status script2shorts
node client/cli-entry.js project run script2shorts build \
  --idempotency-key script2shorts:build:commit-a83f92
node client/cli-entry.js project follow <job-id>
```

Use the explicit V3 namespace for generic Jobs:

```bash
node client/cli-entry.js v3 job start "pnpm test" \
  --server debian-main \
  --cwd /home/leon/projects/app \
  --idempotency-key app:test:commit-a83f92
node client/cli-entry.js v3 job logs <job-id> --cursor <cursor>
```

## MCP V3 additions

Existing core names remain available, including `remote_read`, `remote_write`,
`remote_bash`, `remote_script`, `remote_exec_async`, and `remote_task`.
The modular MCP also exposes:

- `remote_job_logs`
- `remote_project_list`
- `remote_project_status`
- `remote_project_run`

`remote_exec_async`, `remote_script_async`, and `remote_project_run` accept
`idempotencyKey`. `remote_task` can accept `cursor` and `maxBytes` to include only
new Job output.

## Safety and failover behavior

- read-only calls may retry and move to another verified endpoint
- synchronous commands are never retried after being sent
- persistent Job submissions reuse one idempotency key during transport retry
- Jobs and config operations require a daemon endpoint
- SSH is loaded only when an SSH endpoint is actually selected
- relative paths supplied with `project` stay inside that project root
