# agentport

AI Remote Development Gateway for MCP, CLI, SSH, and persistent daemon jobs

Enable AI Agents to develop on remote Linux servers through the most stable
available channel: native MCP tools, CLI fallback, daemon HTTP APIs, SSH
recovery, and persistent remote jobs.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-2.5.0-blue)](https://github.com/knownothing20/agentport)

[中文文档](./README_CN.md)

---

## One-line Summary

Give AI Agents a stable remote development gateway: direct file operations,
command execution, diagnostics, long-running job control, and recovery paths
when a desktop tool's native MCP transport is unavailable or unstable.

**Analogy**: VS Code Remote SSH is for humans; agentport is for AI.

---

## Architecture Overview

`agentport` is split into a local agent gateway and a remote Linux
daemon:

```text
AI desktop tool
  -> CLI daemon gateway, native MCP tools, or SSH recovery
  -> local agentport gateway
  -> remote daemon HTTP API
  -> remote Linux workspace
```

The local side registers MCP tools when available, provides a CLI fallback for
tools that can run terminal commands, reads private connection config, and turns
daemon errors into agent-readable messages. The remote daemon performs token
auth, safe path checks, file operations, command execution, persistent
development jobs, audit logging, health checks, Dashboard responses, and hot
config reload.

For desktop tools that spawn multiple MCP stdio children per software, agentport
now keeps one local "core" process per software key and lets other sessions
attach through a localhost proxy broker. This reduces duplicate connection churn
without forcing single-session usage.

For design rationale, deployment model, and security boundaries, see
the project documentation in this repository.

---

## Core Features

| Feature | Description |
|---------|-------------|
| Remote File R/W | `remote_read` / `remote_write` / `remote_stat` |
| Remote Search | `remote_glob` search file paths, `remote_grep` search file contents |
| Command Execution | `remote_bash` for simple commands, `remote_script` for multi-line scripts |
| Batch Operations | `remote_batch` up to 20 operations per request |
| Native MCP Tools | Structured `remote_*` tools when the host supports custom MCP servers |
| CLI Daemon Gateway | `node cli.js status` and `node cli.js job ...` for stable development workflows |
| Persistent Jobs | Remote daemon jobs for tests, builds, logs, status, and cancel |
| Async Execution | `remote_exec_async` + `remote_task` compatibility for long-running tasks |
| Config Hot Reload | `remote_config` modify remote config without restart |
| Execution Backpressure | Queue timeout returns clear 429 with exec running/max/queued state |
| Dynamic Connections | Switch between multiple servers without restarting MCP |
| Multi-session Reuse | One local core instance per software key, extra sessions attach via local proxy broker |
| Health Check | Automatic remote service status detection |
| Encoding Handling | Auto base64 encode special chars, clean CRLF/BOM |

---

## Agent Integration Priority

`agentport` is a remote development gateway with multiple runtime channels.
Choose by task type:

1. **SSH-first CLI for stable base operations**: use `--route ssh` for health,
   read/write, stat, glob, grep, and one-off command execution.
2. **CLI daemon gateway for long-running development**: use `node cli.js status`
   and persistent `job` commands for tests, builds, polling, and durable logs.
3. **Native MCP for convenience when available**: if `remote_*` tools are visible
   and stable, use them for quick structured operations.
4. **HTTP/manual last**: only use direct REST calls or manual commands when SSH,
   daemon, and native MCP are all unavailable.

CLI fallback examples:

```bash
node cli.js doctor
node cli.js list
node cli.js connect <connection-name>
node cli.js health
node cli.js ssh-health
node cli.js health --route ssh
node cli.js read /path/to/workspace/AGENTS.md
node cli.js bash "pwd && ls -la" --cwd /path/to/workspace
node cli.js bash "pwd && ls -la" --route ssh --json
node cli.js write /path/to/workspace/tmp.txt --content "hello"
```

For long-running development tasks, use the persistent daemon job gateway:

```bash
node cli.js status
node cli.js job start "npm test" --cwd /path/to/workspace
node cli.js job status <job-id>
node cli.js job logs <job-id> --tail 200
node cli.js job cancel <job-id>
node cli.js job list --limit 20
```

The job gateway is designed for AI tools whose native MCP stdio transport may
disconnect during long work. Jobs continue inside the remote daemon, and the AI
can reconnect through the CLI to inspect status and logs.

When daemon transport is unhealthy, use lightweight SSH jobs as a recovery path:

```bash
node cli.js job start "sleep 30" --route ssh
node cli.js job status <job-id> --route ssh
node cli.js job logs <job-id> --route ssh --json
node cli.js job cancel <job-id> --route ssh
```

See [AGENT_GUIDE.md](./AGENT_GUIDE.md) for the full install and agent bootstrap
workflow.

---

## Execution Backpressure

The remote daemon protects itself with an execution slot queue:

| Setting | Default | Description |
|---------|---------|-------------|
| `EXEC_TIMEOUT_MS` | `120000` | Timeout for a running command |
| `EXEC_MAX_CONCURRENCY` | `4` | Maximum commands running at the same time |
| `EXEC_QUEUE_TIMEOUT_MS` | `15000` | Maximum time a request waits for an execution slot |

When all execution slots are busy, new command requests wait in a queue. If the
queue wait exceeds `EXEC_QUEUE_TIMEOUT_MS`, the daemon returns HTTP `429` with
the current `exec` state:

```json
{
  "error": "Too many concurrent exec operations",
  "exec": {
    "running": 4,
    "max": 4,
    "queued": 1,
    "timeoutMs": 120000,
    "queueTimeoutMs": 15000
  }
}
```

`remote_health` also reports this `exec` state, which helps distinguish service
disconnects from an overloaded execution queue.

---

## Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/knownothing20/agentport.git
cd agentport
```

### 2. Install dependencies

```bash
npm install
```

### 2.1 Install on another computer

For a new computer or another AI desktop tool, see
[INSTALL_OTHER_MACHINE.md](./INSTALL_OTHER_MACHINE.md).

Short version:

```bash
git clone https://github.com/knownothing20/agentport.git
cd agentport
npm install
cp local/connections.json.example local/connections.json
npm run doctor
```

Then copy your private `local/connections.json`, optional
`local/agentport.json`, and SSH keys from the old computer through a
secure channel. Update any absolute key paths for the new machine.

### 3. CLI Guided Setup (Recommended)

Use the interactive wizard to scan your SSH environment and guide you through configuration:

```bash
npm run setup
```

The wizard will:
1. Auto-scan your local SSH keys, config, and known_hosts
2. Display scan results and let you choose an authentication method
3. Guide you through entering server address and username
4. Test the SSH connection
5. Auto-save config to `local/connections.json`

### 4. Manual Configuration (Alternative)

If you prefer not to use the guided wizard:

```bash
cp agentport.example.json local/agentport.json
# Edit local/agentport.json, fill in all variables
```

Key variables:

| Variable | Description |
|----------|-------------|
| `skillDir` | Absolute path to the skill installation directory |
| `mcpConfigPath` | Path to the target AI tool's MCP config file |
| `remoteUrl` | Remote daemon address |
| `authToken` | Client authentication token |
| `serverExecMaxConcurrency` | Remote daemon command concurrency limit, default `4` |
| `serverExecQueueTimeoutMs` | Queue wait timeout before HTTP `429`, default `15000` |

### 5. Sync configuration

```bash
node sync.cjs
```

### 6. Deploy remote daemon

```bash
# Create daemon directory on remote server
ssh USER@SERVER "mkdir -p /path/to/daemon"

# Upload server files to remote server
scp server/server.js server/agentport-manager.sh server/package.json USER@SERVER:/path/to/daemon/

# Upload generated .env config (created by sync.cjs in step 4)
scp local/server/.env USER@SERVER:/path/to/daemon/

# SSH to remote server
ssh USER@SERVER
cd /path/to/daemon
npm install
nohup bash agentport-manager.sh >> boot.log 2>&1 &
```

### 7. Restart AI tool

After configuration takes effect, restart your AI tool to activate MCP registration.

### 8. Verify fallback mode

If your AI tool does not expose native `remote_*` MCP tools, verify the CLI
fallback:

```bash
npm run doctor
node cli.js health
```

At least one configured connection should report `"ok": true`.

---

## Supported AI Tools

| AI Tool | MCP Config Path (Windows) | MCP Config Path (macOS/Linux) |
|---------|---------------------------|-------------------------------|
| WorkBuddy | `C:\Users\<user>\.workbuddy\mcp.json` | `~/.workbuddy/mcp.json` |
| Claude Desktop | `C:\Users\<user>\AppData\Roaming\Claude\claude_desktop_config.json` | `~/.config/Claude/claude_desktop_config.json` |
| Cursor | `<project>\.cursor\mcp.json` | `<project>/.cursor/mcp.json` |
| Windsurf | `C:\Users\<user>\.codeium\windsurf\mcp_config.json` | `~/.codeium/windsurf/mcp_config.json` |
| Tools without custom MCP | Use `node cli.js ...` through Bash/terminal | Use `node cli.js ...` through Bash/terminal |

---

## Tool List

| Tool | Function |
|------|----------|
| `remote_ssh_info` | Scan local SSH environment (keys, config, known hosts) |
| `remote_health` | Check remote service reachability |
| `remote_read` | Read remote file (ETag cache) |
| `remote_write` | Write remote file (auto clean CRLF/BOM) |
| `remote_stat` | Get file metadata |
| `remote_glob` | Search by glob pattern |
| `remote_grep` | Search remote file contents |
| `remote_bash` | Execute remote command |
| `remote_script` | Execute multi-line script |
| `remote_batch` | Batch operations |
| `remote_exec_async` | Async execution |
| `remote_task` | Query async task |
| `remote_config` | Config hot reload |
| `remote_status` | Connection diagnostics |

For detailed usage, see [SKILL.md](./SKILL.md)

---

## Directory Structure

```
agentport/
|-- SKILL.md                         # Complete agent documentation
|-- README.md                        # This file (English)
|-- README_CN.md                     # Chinese documentation
|-- AGENT_GUIDE.md                   # Agent install and usage guide
|-- index.js                         # MCP server main program
|-- cli.js                           # CLI fallback for tools without native MCP
|-- package.json                     # Client dependencies
|-- agentport.example.json    # Public config template
|-- sync.cjs                         # Variable sync script
|-- test.cjs                         # Test script
|-- LICENSE                          # MIT License
|-- CHANGELOG.md                     # Version changelog
|-- local/                           # Local private config directory
|   |-- config-guide.md              # Configuration guide
|   |-- connections.json.example     # Multi-server config example
|   `-- server/
|       `-- .env                     # Server config generated by sync.cjs
`-- server/
    |-- server.js                    # Remote daemon process
    |-- agentport-manager.sh  # Process guardian script
    |-- setup-autostart-agentport.sh           # Autostart config script
    |-- dashboard.html               # Web Dashboard UI
    |-- .env.example                 # Server config template
    `-- package.json                 # Server dependencies
```

## Configuration Files

| File | Location | Description |
|------|----------|-------------|
| `agentport.json` | `local/` | Main configuration (copy from `agentport.example.json`) |
| `connections.json` | `local/` | Multi-server connections (optional, see `connections.json.example`) |
| `.env` | `server/` | Server configuration (auto-generated by `sync.cjs`) |

See [`local/config-guide.md`](./local/config-guide.md) for detailed configuration guide.

---

## Dashboard

agentport provides a Web Dashboard for monitoring and management:

### Enable Dashboard

Set in `local/agentport.json`:

```json
{
  "variables": {
    "serverEnableDashboard": "true"
  }
}
```

### Access Dashboard

After starting the service, visit:
- `http://your-server:3183/`
- `http://your-server:3183/dashboard`

### Dashboard Features

| Feature | Description |
|---------|-------------|
| Service Status | View Node.js, dependencies, port, disk status |
| Audit Statistics | View request stats, success rate, by type/client analysis |
| Error Logs | View recent error logs |
| Config Management | View and modify server config (requires Admin Token) |

---

## Autostart Configuration

### Method 1: Using setup-autostart-agentport.sh (Recommended)

```bash
# SSH to remote server
ssh USER@SERVER
cd /path/to/daemon

# Install autostart
bash setup-autostart-agentport.sh install

# Check status
bash setup-autostart-agentport.sh status

# Uninstall autostart
bash setup-autostart-agentport.sh uninstall
```

### Method 2: Manual crontab configuration

```bash
# Edit crontab
crontab -e

# Add the following line
@reboot /path/to/daemon/agentport-manager.sh # agentport autostart
```

### Method 3: Using systemd (Optional)

Create `/etc/systemd/system/agentport.service`:

```ini
[Unit]
Description=agentport daemon
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/daemon
ExecStart=/bin/bash /path/to/daemon/agentport-manager.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then enable:

```bash
sudo systemctl enable agentport
sudo systemctl start agentport
```

---

## Security Features

- **Workspace Isolation**: File operations restricted within `WORKSPACE_ROOT`
- **Token Authentication**: Client token + admin token
- **Path Restrictions**: Prevent unauthorized access
- **Script Interpreter Whitelist**: Only allow safe interpreters
- **Command Execution Limits**: Configurable `ALLOW_BASH_EXEC` and `ALLOWED_COMMANDS`

---

## Version History

See [CHANGELOG.md](./CHANGELOG.md)

---

## License

MIT License - See [LICENSE](./LICENSE)

---

## Contributing

Issues and Pull Requests are welcome!
