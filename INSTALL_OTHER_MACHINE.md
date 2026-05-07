# Install On Another Machine

This guide explains how to install `mcp-remote-agent` on a new computer or in a
different AI desktop tool.

## What Installs From GitHub

```bash
git clone https://github.com/knownothing20/mcp-remote-agent.git
cd mcp-remote-agent
npm install
npm run doctor
```

The GitHub repository contains code, docs, examples, and dependency lockfiles.
It does not contain real local tokens, passwords, private keys, or daemon `.env`
files.

## Files To Copy From Your Old Computer

Copy these only through a private channel:

- `local/connections.json`: saved daemon and SSH connection list.
- `local/mcp-remote-agent.json`: MCP registration and daemon deployment config, if the target AI tool supports MCP.
- SSH private keys referenced by `local/connections.json`, for example `~/.ssh/id_ed25519`.
- SSH config entries from `~/.ssh/config`, if your connections depend on them.

After copying SSH keys, make sure the file path in `local/connections.json`
matches the new computer. On Windows, a key path such as
`C:\Users\old-user\.ssh\id_ed25519` usually must be changed to the new user's
home directory.

## Files Not To Copy

- `node_modules/`: run `npm install` instead.
- `local/server/.env`: only needed when deploying or maintaining the remote
  daemon; do not copy it for normal client use.
- `_backup-*` folders, logs, temporary files, and old `niuma.json` files.

## MCP-Capable AI Tools

For tools that support custom MCP servers, use native MCP first:

1. Place this repo in the tool's skill/plugin directory.
2. Copy or create `local/mcp-remote-agent.json`.
3. Set `skillDir` to this repo's absolute path.
4. Set `mcpConfigPath` to the target AI tool's MCP config file.
5. Run:

```bash
node sync.cjs
```

Restart the AI tool, then verify inside the AI session:

```text
remote_connect()
remote_health()
```

## AI Tools Without MCP

For tools that do not support custom MCP but can run Bash/terminal commands,
use the CLI fallback:

```bash
node cli.js doctor
node cli.js list
node cli.js health
node cli.js read /path/to/file
node cli.js bash "pwd && ls -la"
```

Use daemon connections for long-running coding. Use SSH connections when daemon
is unavailable.

## Quick Migration Checklist

1. Clone from GitHub.
2. Run `npm install`.
3. Create `local/` if needed.
4. Copy `local/connections.json`.
5. Copy `local/mcp-remote-agent.json` only if MCP registration is needed.
6. Copy SSH keys and update key paths.
7. Run `npm run doctor`.
8. If using MCP, run `node sync.cjs` and restart the AI tool.
