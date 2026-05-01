# mcp-remote-agent

MCP Server for AI Agent Remote Development

Enable AI Agents to operate remote Linux servers through MCP protocol, seamlessly connecting local development environments with remote servers.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-2.5.0-blue)](https://github.com/knownothing20/mcp-remote-agent)

[中文文档](./README_CN.md)

---

## One-line Summary

Enable AI Agents (like WorkBuddy, Claude Desktop, Cursor) to directly read/write remote Linux server files and execute commands via MCP, seamlessly connecting local development with remote servers.

**Analogy**: VS Code Remote SSH is for humans; mcp-remote-agent is for AI.

---

## Core Features

| Feature | Description |
|---------|-------------|
| Remote File R/W | `remote_read` / `remote_write` / `remote_stat` |
| Remote Search | `remote_glob` search files by glob pattern |
| Command Execution | `remote_bash` for simple commands, `remote_script` for multi-line scripts |
| Batch Operations | `remote_batch` up to 20 operations per request |
| Async Execution | `remote_exec_async` + `remote_task` for long-running tasks |
| Config Hot Reload | `remote_config` modify remote config without restart |
| Dynamic Connections | Switch between multiple servers without restarting MCP |
| Health Check | Automatic remote service status detection |
| Encoding Handling | Auto base64 encode special chars, clean CRLF/BOM |

---

## Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/knownothing20/mcp-remote-agent.git
cd mcp-remote-agent
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure

```bash
cp mcp-remote-agent.example.json local/mcp-remote-agent.json
# Edit local/mcp-remote-agent.json, fill in all variables
```

Key variables:

| Variable | Description |
|----------|-------------|
| `skillDir` | Absolute path to the skill installation directory |
| `mcpConfigPath` | Path to the target AI tool's MCP config file |
| `remoteUrl` | Remote daemon address |
| `authToken` | Client authentication token |

### 4. Sync configuration

```bash
node sync.cjs
```

### 5. Deploy remote daemon

```bash
# Create daemon directory on remote server
ssh USER@SERVER "mkdir -p /path/to/daemon"

# Upload server files to remote server
scp server/server.js server/mcp-remote-agent-manager.sh server/package.json USER@SERVER:/path/to/daemon/

# Upload generated .env config (created by sync.cjs in step 4)
scp local/server/.env USER@SERVER:/path/to/daemon/

# SSH to remote server
ssh USER@SERVER
cd /path/to/daemon
npm install
nohup bash mcp-remote-agent-manager.sh >> boot.log 2>&1 &
```

### 6. Restart AI tool

After configuration takes effect, restart your AI tool to activate MCP registration.

---

## Supported AI Tools

| AI Tool | MCP Config Path (Windows) | MCP Config Path (macOS/Linux) |
|---------|---------------------------|-------------------------------|
| WorkBuddy | `C:\Users\<user>\.workbuddy\mcp.json` | `~/.workbuddy/mcp.json` |
| Claude Desktop | `C:\Users\<user>\AppData\Roaming\Claude\claude_desktop_config.json` | `~/.config/Claude/claude_desktop_config.json` |
| Cursor | `<project>\.cursor\mcp.json` | `<project>/.cursor/mcp.json` |
| Windsurf | `C:\Users\<user>\.codeium\windsurf\mcp_config.json` | `~/.codeium/windsurf/mcp_config.json` |

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
mcp-remote-agent/
├── SKILL.md                        # Complete documentation
├── README.md                       # This file (English)
├── README_CN.md                    # Chinese documentation
├── index.js                        # MCP server main program
├── package.json                    # Client dependencies
├── mcp-remote-agent.example.json   # Config template
├── sync.cjs                        # Variable sync script
├── test.cjs                        # Test script
├── .gitignore                      # Git ignore config
├── LICENSE                         # MIT License
├── CHANGELOG.md                    # Version changelog
├── local/                          # Local config directory
│   ├── config-guide.md             # Configuration guide
│   ├── mcp-remote-agent.json       # Main config (copy from example)
│   ├── connections.json.example    # Multi-server config example
│   └── server/
│       └── .env                    # Server config (auto-generated)
└── server/
    ├── server.js                   # Daemon process
    ├── mcp-remote-agent-manager.sh # Process guardian script
    ├── setup-autostart.sh          # Autostart config script
    ├── dashboard.html              # Web Dashboard UI
    ├── .env.example                # Server config template
    └── package.json                # Server dependencies
```

## Configuration Files

| File | Location | Description |
|------|----------|-------------|
| `mcp-remote-agent.json` | `local/` | Main configuration (copy from `mcp-remote-agent.example.json`) |
| `connections.json` | `local/` | Multi-server connections (optional, see `connections.json.example`) |
| `.env` | `server/` | Server configuration (auto-generated by `sync.cjs`) |

See [`local/config-guide.md`](./local/config-guide.md) for detailed configuration guide.

---

## Dashboard

mcp-remote-agent provides a Web Dashboard for monitoring and management:

### Enable Dashboard

Set in `local/mcp-remote-agent.json`:

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

### Method 1: Using setup-autostart.sh (Recommended)

```bash
# SSH to remote server
ssh USER@SERVER
cd /path/to/daemon

# Install autostart
bash setup-autostart.sh install

# Check status
bash setup-autostart.sh status

# Uninstall autostart
bash setup-autostart.sh uninstall
```

### Method 2: Manual crontab configuration

```bash
# Edit crontab
crontab -e

# Add the following line
@reboot /path/to/daemon/mcp-remote-agent-manager.sh # mcp-remote-agent autostart
```

### Method 3: Using systemd (Optional)

Create `/etc/systemd/system/mcp-remote-agent.service`:

```ini
[Unit]
Description=mcp-remote-agent daemon
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/daemon
ExecStart=/bin/bash /path/to/daemon/mcp-remote-agent-manager.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then enable:

```bash
sudo systemctl enable mcp-remote-agent
sudo systemctl start mcp-remote-agent
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
