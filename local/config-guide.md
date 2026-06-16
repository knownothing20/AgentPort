# Local Config Guide

Use this guide when configuring a fresh AgentPort clone for a new AI software.

## 1. Create SSH Baseline

```bash
cp local/connections.json.example local/connections.json
```

Edit the SSH connection:

```json
{
  "connections": [
    {
      "name": "ssh-main",
      "type": "ssh",
      "host": "YOUR_SERVER_IP",
      "port": 22,
      "username": "YOUR_SSH_USER",
      "privateKey": "~/.ssh/id_rsa"
    }
  ],
  "default": "ssh-main"
}
```

Check it:

```bash
node cli.js ssh-health --connection ssh-main --route ssh --json
```

## 2. Provision Daemon Token

For a new software that only has SSH configured:

```bash
node cli.js client provision \
  --client-id <machine-software> \
  --connection ssh-main \
  --route ssh \
  --daemon-url http://<host>:3183 \
  --daemon-name daemon-main \
  --local-dir . \
  --json
```

The command writes a daemon connection into `local/connections.json`. It prints
only `tokenMasked`.

Validate with a real authenticated endpoint:

```bash
node cli.js job list --connection daemon-main --route daemon --limit 1 --json
```

If verification is unauthorized after SSH provisioning, reload or restart the
remote daemon and run the provision command again.

## 3. Configure MCP Registration

Only needed for AI tools that support native MCP server registration:

```bash
cp agentport.example.json local/agentport.json
```

Important variables:

| Variable | Purpose |
| --- | --- |
| `skillDir` | Absolute path to this AgentPort skill directory |
| `mcpConfigPath` | Target AI tool MCP config path |
| `mcpServerName` | MCP server name, usually `agentport` |
| `skillTargets` | Optional directories for `node sync.cjs --skills` |

Run:

```bash
node sync.cjs
```

Restart the AI tool after MCP config changes.

## 4. Server Config

`local/server/.env` is generated from `local/agentport.json` by `node sync.cjs`.
It is only for daemon bootstrap or planned daemon maintenance. Normal client
installs should not overwrite remote daemon files.

## Security

- Never commit real files under `local/`.
- Do not share daemon tokens between AI tools.
- Do not read or print raw remote `AUTH_TOKENS`; use `client provision`.
