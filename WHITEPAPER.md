# mcp-remote-agent Whitepaper

## 1. Positioning

`mcp-remote-agent` is a remote Linux development bridge for AI agents. It exposes a controlled MCP tool surface for reading files, writing files, running commands, executing scripts, checking task state, and hot-reloading daemon configuration on a remote server.

It is not trying to replace SSH for humans. It turns SSH, HTTP, and a remote daemon into stable, agent-readable tools. In simple terms: VS Code Remote SSH is for humans; `mcp-remote-agent` is for AI agents.

## 2. Goals

- Prefer native `remote_*` MCP tools when an AI desktop tool can inject them.
- Provide a CLI fallback for tools that cannot inject custom MCP servers.
- Keep public templates separate from private local secrets and runtime state.
- Constrain remote file access to `WORKSPACE_ROOT`.
- Protect the remote daemon with execution timeout, concurrency, and queue timeout controls.
- Support `.env` hot reload for operational changes that should not require restart.
- Avoid committing real tokens, SSH keys, generated daemon config, or local state.

## 3. Architecture

```text
AI desktop tool
  -> native MCP tools or CLI fallback
  -> local mcp-remote-agent client
  -> remote daemon HTTP API or SSH fallback
  -> remote Linux workspace
```

The local client registers MCP tools, reads private connection config, provides CLI fallback, and formats daemon errors for agents. The remote daemon performs token auth, safe path checks, file operations, command execution, audit logging, health checks, Dashboard responses, and config reload.

## 4. Local Components

| File | Role |
| --- | --- |
| `index.js` | MCP server entrypoint that exposes `remote_*` tools |
| `cli.js` | CLI fallback for AI tools without native MCP injection |
| `local/connections.json` | Private multi-server connection config, ignored by Git |
| `mcp-remote-agent.example.json` | Public configuration template |
| `sync.cjs` | Syncs template variables into MCP registration and server `.env` |

## 5. Remote Components

| File | Role |
| --- | --- |
| `server/server.js` | Remote daemon process |
| `server/.env` | Runtime daemon config, generated locally and uploaded privately |
| `server/mcp-remote-agent-manager.sh` | Process guardian script |
| `server/setup-autostart.sh` | Autostart helper |
| `server/dashboard.html` | Web Dashboard UI |

## 6. Integration Priority

Use the highest available integration level:

1. Native MCP first: `remote_connect()` -> `remote_health()` -> normal `remote_*` operations.
2. CLI fallback second: use `node cli.js ...` when native tools are unavailable but local shell is available.
3. Daemon before SSH: daemon mode is preferred for long-running coding; SSH is a fallback.
4. HTTP or manual commands last.

## 7. Tool Surface

| Capability | Tool |
| --- | --- |
| Connection switching | `remote_connect` |
| Health check | `remote_health` |
| File read/write/stat | `remote_read`, `remote_write`, `remote_stat` |
| Path search | `remote_glob` |
| Content search | `remote_grep` |
| Command execution | `remote_bash`, `remote_script` |
| Batch operations | `remote_batch` |
| Async execution | `remote_exec_async`, `remote_task` |
| Config hot reload | `remote_config` |
| Diagnostics | `remote_status` |

## 8. Configuration Model

The project uses three config layers:

- Public templates: `mcp-remote-agent.example.json`, `server/.env.example`, `local/connections.json.example`.
- Private local config: `local/mcp-remote-agent.json`, `local/connections.json`, `local/server/.env`.
- Remote runtime config: `.env` inside the remote daemon directory.

Important server variables:

| Variable | Default | Description |
| --- | --- | --- |
| `serverWorkspaceRoot` | user-defined | Remote workspace root |
| `serverExecTimeoutMs` | `120000` | Running command timeout |
| `serverExecMaxConcurrency` | `4` | Maximum concurrent command executions |
| `serverExecQueueTimeoutMs` | `15000` | Maximum wait for an execution slot |
| `serverDaemonDir` | user-defined | Remote daemon directory |
| `serverAuditLogPath` | daemon directory | Audit log path |
| `serverAuthTokens` | user-defined | Client token map |
| `serverAdminTokens` | user-defined | Dashboard/admin tokens |

## 9. Execution Backpressure

The daemon uses execution slots for command-like operations:

- `EXEC_MAX_CONCURRENCY` limits concurrently running commands. The current template default is `4`.
- Requests beyond the concurrency limit wait in a queue.
- `EXEC_QUEUE_TIMEOUT_MS` limits queue wait time. The current template default is `15000`.
- Queue timeout returns HTTP `429` with the current `exec` state.
- `remote_health` also reports `exec.running`, `exec.max`, `exec.queued`, `exec.timeoutMs`, and `exec.queueTimeoutMs`.

This avoids the old failure mode where overloaded execution appeared as a broken or disconnected service. Multiple agents can now see whether the daemon is unavailable or simply out of execution capacity.

## 10. Hot Reload

`remote_config` can update the remote `.env` and reload mutable runtime settings, including:

- `WORKSPACE_ROOT`
- client/admin token mappings
- `EXEC_TIMEOUT_MS`
- `EXEC_MAX_CONCURRENCY`
- `EXEC_QUEUE_TIMEOUT_MS`

Port and bind address remain startup-level settings and normally require a daemon restart.

## 11. Security Boundaries

- Real local config and generated `.env` files are ignored by Git.
- Remote file paths are checked against `WORKSPACE_ROOT`.
- API calls require client tokens.
- Dashboard and config management require admin tokens.
- Script execution is restricted to allowed interpreters.
- Audit logs record request type, client, duration, success state, and error summary.
- Remote Linux cannot directly read a user's local Windows or macOS paths; local artifacts must be uploaded or synchronized explicitly.

## 12. Operations Guidance

Recommended deployment flow:

1. Clone the repository and install dependencies locally.
2. Copy `mcp-remote-agent.example.json` to `local/mcp-remote-agent.json`.
3. Configure daemon URL, tokens, workspace root, and execution limits.
4. Run `node sync.cjs`.
5. Upload `server/` files and generated `local/server/.env` to the remote daemon directory.
6. Install remote daemon dependencies.
7. Start the manager script or configure systemd/crontab autostart.
8. Verify with `remote_health`.

For long-running multi-agent usage:

- Give each AI tool a separate `clientId` and token.
- Point `WORKSPACE_ROOT` at the intended project root, not the whole home directory.
- Keep `EXEC_QUEUE_TIMEOUT_MS` enabled so overload fails clearly.
- Increase `EXEC_MAX_CONCURRENCY` gradually based on CPU, memory, and IO pressure.
- Review audit logs and daemon manager logs during incidents.

## 13. Compatibility

New clients can connect to old daemons, but old daemons cannot report the new execution queue state. Old clients can connect to new daemons, but their error messages may not display the richer `exec` payload.

For best results, update the local skill, repository templates, and remote daemon together.
