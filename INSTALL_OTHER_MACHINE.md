# Install On Another Machine

This guide explains how to install `agentport` on a new computer or in a
different AI desktop tool.

## Safe Policy (Important)

- Treat remote server deployment as a one-time bootstrap action.
- New/old client computers should normally run in **client-only mode** and must
  not overwrite existing remote daemon files or tokens.
- In `remote_setup`, deployment is now opt-in: `deploy=false` by default.
  Existing daemon directories are never overwritten unless `forceDeploy=true`.

## Mandatory Onboarding Order

Use this exact order to avoid accidental overwrite:

1. Install local client (`git clone` + `npm install`).
2. Ask target server IP/host explicitly.
3. Run remote read-only detection first:
   - daemon dir exists?
   - daemon `.env` exists?
   - daemon process running?
   - port `3183` listening?
4. If daemon already exists:
   - do **not** deploy
   - read `AUTH_TOKENS` and configure local `authToken/clientId`
5. If daemon does not exist:
   - first-time bootstrap is allowed (`deploy=true`)

## First-Time Local + First-Time Server (Detailed)

Use this when both sides are new.

1. Install local client:

```bash
git clone https://github.com/knownothing20/agentport.git
cd agentport
npm install
```

2. Confirm target server explicitly (example: `192.0.2.10`) and verify SSH:

```bash
ssh YOUR_USER@192.0.2.10 "echo connected"
```

3. Run read-only detection first:

```bash
ssh YOUR_USER@192.0.2.10 "test -d ~/.agentport/daemon && echo DAEMON_DIR=1 || echo DAEMON_DIR=0; test -f ~/.agentport/daemon/.env && echo ENV=1 || echo ENV=0; pgrep -f 'node server.js' >/dev/null && echo PROC=1 || echo PROC=0; ss -lntp 2>/dev/null | grep ':3183' >/dev/null && echo PORT3183=1 || echo PORT3183=0"
```

4. If output shows `DAEMON_DIR=0`, this is first bootstrap:
   - run `remote_setup(..., deploy=true)` once from one operator computer.
   - this generates `clientId + token` and writes remote `.env`.

5. After bootstrap, validate token from remote:

```bash
ssh YOUR_USER@192.0.2.10 "grep '^AUTH_TOKENS=' ~/.agentport/daemon/.env"
```

6. Save daemon connection locally in `local/connections.json`:
   - `url`: `http://192.0.2.10:3183`
   - `clientId`: one key from `AUTH_TOKENS`
   - `authToken`: matching token value

7. Verify from local machine:

```bash
node cli.js doctor
node cli.js connect 183-agentport-daemon
node cli.js health
node cli.js ssh-health
```

8. For the next new computer:
   - do local install only
   - reuse existing token
   - do not deploy again

## What Installs From GitHub

```bash
git clone https://github.com/knownothing20/agentport.git
cd agentport
npm install
```

The GitHub repository contains code, docs, examples, and dependency lockfiles.
It does not contain real local tokens, passwords, private keys, or daemon `.env`
files.

## Files To Copy From Your Old Computer

Copy these only through a private channel:

- `local/connections.json`: saved daemon and SSH connection list.
- `local/agentport.json`: MCP registration and daemon deployment config, if the target AI tool supports MCP.
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
2. Copy or create `local/agentport.json`.
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
5. Copy `local/agentport.json` only if MCP registration is needed.
6. Copy SSH keys and update key paths.
7. Run `npm run doctor`.
8. If using MCP, run `node sync.cjs` and restart the AI tool.

## Recommended Validation Order

Run checks only after your local config files are ready:

```bash
npm run doctor
node cli.js list
node cli.js health
```

Expected result: at least one connection reports `"ok": true`.

## remote_setup Safety Modes

Use `remote_setup` in one of two explicit modes:

1. Client-only (recommended for additional computers):
   - `deploy=false` (default)
   - only tests SSH + saves local connection
   - does **not** write `~/.agentport/daemon/*` on remote

2. First-time server bootstrap or planned upgrade:
   - set `deploy=true`
   - if daemon already exists, setup skips overwrite by default
   - only use `forceDeploy=true` for intentional replacement/upgrade
