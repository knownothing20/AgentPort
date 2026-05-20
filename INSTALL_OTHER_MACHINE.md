# Install On Another Machine

This guide explains how to install `agentport` on a new computer or in a
different AI desktop tool.

## Safe Policy (Important)

- Treat remote server deployment as a one-time bootstrap action.
- New/old client computers should normally run in **client-only mode** and must
  not overwrite existing remote daemon files or tokens.
- In `remote_setup`, deployment is now opt-in: `deploy=false` by default.
  Existing daemon directories are never overwritten unless `forceDeploy=true`.

## Token Policy (Must Follow)

1. Different computers must use different `clientId=token` pairs, even for the same software.
2. Do not share one token across multiple computers.
3. Recommended `clientId` format:
   - `<machine>-<software>`
   - examples: `win11-codex`, `win11-workbuddy`, `macbook-codex`
4. `local/connections.json` daemon `authToken` must match the server-side
   `AUTH_TOKENS` entry for that `clientId`.
5. Dashboard access requires token in `ADMIN_TOKENS`.
   - simplest policy: put the same token into both `AUTH_TOKENS` and `ADMIN_TOKENS`.

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
   - add a **new** token for this machine/software if needed (do not reuse another machine token)
5. If daemon does not exist:
   - first-time bootstrap is allowed (`deploy=true`)

## Fast Decision Flow

1. Ask target host first.
2. Local install first.
3. Run remote detection first.
4. Existing daemon -> client-only mode (`deploy=false`) + unique token for this machine/software.
5. Missing daemon -> one operator runs bootstrap (`deploy=true`) once.
6. Need Dashboard on this machine -> token must be in `ADMIN_TOKENS`, then use:
   - `http://<host>:3183/?token=<admin-token>`
   - `http://<host>:3183/dashboard?token=<admin-token>`
7. If native MCP is unstable, continue with `--route ssh` CLI path.

## First-Time Local + First-Time Server (Detailed)

Use this when both sides are new.

1. Install local client:

```bash
git clone https://github.com/knownothing20/agentport.git
cd agentport
npm install
```

2. Confirm target server explicitly (example: `192.168.31.183`) and verify SSH:

```bash
ssh leon@192.168.31.183 "echo connected"
```

3. Run read-only detection first:

```bash
ssh leon@192.168.31.183 "test -d ~/.agentport/daemon && echo DAEMON_DIR=1 || echo DAEMON_DIR=0; test -f ~/.agentport/daemon/.env && echo ENV=1 || echo ENV=0; pgrep -f 'node server.js' >/dev/null && echo PROC=1 || echo PROC=0; ss -lntp 2>/dev/null | grep ':3183' >/dev/null && echo PORT3183=1 || echo PORT3183=0"
```

4. If output shows `DAEMON_DIR=0`, this is first bootstrap:
   - run `remote_setup(..., deploy=true)` once from one operator computer.
   - this generates `clientId + token` and writes remote `.env`.

5. After bootstrap, validate token from remote:

```bash
ssh leon@192.168.31.183 "grep '^AUTH_TOKENS=' ~/.agentport/daemon/.env"
```

6. Save daemon connection locally in `local/connections.json`:
   - `url`: `http://192.168.31.183:3183`
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
   - create a new token pair for this computer
   - do not deploy again

## Existing Server: Add New Token For New Computer

When daemon already exists and a new computer/software needs access, add a new
token pair instead of reusing old ones:

1. Backup remote `.env`:

```bash
ssh leon@192.168.31.183 "cp ~/.agentport/daemon/.env ~/.agentport/daemon/.env.bak.$(date +%Y%m%d-%H%M%S)"
```

2. Add a new `clientId=token` pair (example):

```bash
ssh leon@192.168.31.183 "python3 - <<'PY'
from pathlib import Path
import secrets

env = Path.home()/'.agentport/daemon/.env'
text = env.read_text(encoding='utf-8')
lines = text.splitlines()

client_id = 'win11-codex'
token = 'agentport-' + secrets.token_hex(16)

def getv(k):
    for line in lines:
        if line.startswith(k + '='):
            return line.split('=',1)[1].strip()
    return ''

def setv(k,v):
    for i,line in enumerate(lines):
        if line.startswith(k + '='):
            lines[i] = f'{k}={v}'
            return
    lines.append(f'{k}={v}')

auth = getv('AUTH_TOKENS')
admin = getv('ADMIN_TOKENS')
auth_pairs = [x for x in auth.split(',') if x]
auth_pairs = [x for x in auth_pairs if not x.startswith(client_id + '=')]
auth_pairs.append(f'{client_id}={token}')
setv('AUTH_TOKENS', ','.join(auth_pairs))

admins = [x for x in admin.split(',') if x]
if token not in admins:
    admins.append(token)
setv('ADMIN_TOKENS', ','.join(admins))

env.write_text('\\n'.join(lines) + '\\n', encoding='utf-8')
print('clientId=', client_id)
print('token=', token)
PY"
```

3. Restart daemon process (or use config hot reload API if available), then test:

```bash
node cli.js health
node cli.js ssh-health
```

4. Put returned `clientId/token` in new computer `local/connections.json`.

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
