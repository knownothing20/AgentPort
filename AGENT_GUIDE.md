# Agent Install And Usage Guide

This guide is for AI agents and AI desktop tools that need remote Linux
development access through `agentport`.

## Capability Priority

Always choose the most stable available runtime for the task:

1. Native MCP tools for quick structured operations.
   If `remote_*` tools are visible and stable, use `remote_connect`,
   `remote_health`, `remote_read`, `remote_write`, `remote_bash`, and the other
   `remote_*` tools directly.
2. SSH-first CLI for baseline stability.
   Use `node cli.js ssh-health`, `node cli.js read|write|bash --route ssh`, and
   `node cli.js job ... --route ssh` when MCP transport closes or daemon health
   is unknown.
3. CLI daemon gateway for long-running development.
   Use `node cli.js status` and `node cli.js job ...` for tests, builds,
   polling, and work that must survive native MCP transport failures.
4. HTTP/manual fallback.
   If none of the above are available, print exact commands for the user to run.

For long-term coding, prefer daemon jobs when healthy. If daemon or native MCP
transport is unstable, keep working through `--route ssh` instead of stopping.

## Fresh Install Baseline

From the skill directory:

```bash
npm install
cp local/connections.json.example local/connections.json
```

Edit `local/connections.json` so it contains an SSH connection for the target
server. Do not add a daemon token by hand.

Then verify SSH:

```bash
node cli.js ssh-health --connection <ssh-connection> --route ssh --json
```

`doctor` is useful after a real connection exists. On a fresh clone without
`local/connections.json`, it can only report that no connection is configured.

## Remote Setup Compatibility Guard

When using `remote_setup`:

- Default is **client-only** (`deploy=false`), so remote daemon files are not
  modified.
- Use `deploy=true` only for first-time remote bootstrap or planned upgrades.
- If remote daemon already exists, overwrite is skipped by default.
- Use `forceDeploy=true` only for intentional replacement after confirmation.

## Required Questions Before Setup

Before guiding installation, always ask:

1. Which server should this computer connect to (for example `192.168.31.183`)?
2. Is this an existing daemon server or first-time bootstrap?
3. Should this computer run client-only mode or perform server deployment?
4. Does this user need Dashboard access on this computer?

Then enforce read-only detection before any deployment action.

Practical setup order:
1. Local install first (`git clone` + `npm install`).
2. Create SSH-only `local/connections.json`.
3. Confirm target host and SSH connectivity.
4. Detect existing daemon state first (dir/env/process/3183).
5. Existing daemon -> client-only, provision a unique machine/software token.
6. Missing daemon -> one-time bootstrap from one operator machine.
7. If Dashboard is required, ensure token is in `ADMIN_TOKENS` and use:
   - `http://<host>:3183/?token=<admin-token>`
   - `http://<host>:3183/dashboard?token=<admin-token>`

Token guidance:
- For existing daemon servers, use `node cli.js client provision` instead of
  reading and copying raw `AUTH_TOKENS` by hand.
- Do not rotate existing remote tokens unless replacement was explicitly approved.
- Do not reuse one token across multiple computers.
- Create one unique `clientId=token` per computer/software.
- If Dashboard access is required, ensure the same token is also present in
  `ADMIN_TOKENS`.

Standard token flow for a new AI software with only SSH configured:

```bash
node <skill-dir>/cli.js ssh-health --connection <ssh-connection> --route ssh --json
node <skill-dir>/cli.js client provision \
  --client-id <machine-software> \
  --connection <ssh-connection> \
  --route ssh \
  --daemon-url http://<host>:3183 \
  --daemon-name <machine-software-daemon> \
  --local-dir <skill-dir> \
  --json
node <skill-dir>/cli.js job list --connection <machine-software-daemon> --route daemon --limit 1 --json
```

The command creates or reuses the remote `clientId=token`, writes the local
daemon connection into that software's own `local/connections.json`, and prints
only `tokenMasked`. If the result says the token was written but verification is
unauthorized, reload or restart the daemon, then run the same provision command
again.

If this install already has an admin daemon connection, the shorter hot-reload
path is:

```bash
node <skill-dir>/cli.js client provision \
  --client-id <machine-software> \
  --connection <admin-daemon-connection> \
  --route daemon \
  --daemon-name <machine-software-daemon> \
  --local-dir <skill-dir> \
  --json
```

First-time token flow (both local + server are new):
1. Detect remote daemon state first (read-only).
2. If daemon is missing, run `remote_setup(..., deploy=true)` once.
3. Run `client provision` once for each machine/software client.
4. Validate with `job list --route daemon` and `ssh-health`.

If the target AI tool supports native MCP registration, also create
`local/agentport.json` from `agentport.example.json`, set
`skillDir` and `mcpConfigPath`, then run `node sync.cjs`.

## Native MCP Usage

When the AI session exposes native MCP tools, run this sequence before remote
work:

```text
remote_connect()
remote_health()
```

Then use:

```text
remote_read(path="/path/to/file")
remote_write(path="/path/to/file", content="...")
remote_bash(command="pwd && ls -la", cwd="/path")
remote_glob(pattern="**/*.js", cwd="/path")
remote_grep(pattern="video-analysis", cwd="/path", include=["**/*.ts", "**/*.py"])
```

Use the CLI job gateway for long-running commands even when native MCP tools are
available, because jobs can continue after the desktop MCP transport closes.

## CLI Fallback Usage

When native MCP tools are not visible but Bash/terminal is available, run:

```bash
node <skill-dir>/cli.js doctor
node <skill-dir>/cli.js list
node <skill-dir>/cli.js connect <connection-name>
node <skill-dir>/cli.js health
node <skill-dir>/cli.js ssh-health
node <skill-dir>/cli.js client provision --client-id <machine-software> --connection <name>
```

Use the actual skill path for the current AI tool. Examples:

```bash
node cli.js read /path/to/workspace/AGENTS.md
node cli.js bash "pwd && ls -la" --cwd /path/to/workspace
node cli.js glob "**/*.js" --cwd /path/to/workspace
node cli.js grep "video-analysis" --cwd /path/to/workspace --include "*.ts,*.py"
node cli.js write /path/to/workspace/tmp.txt --content "hello"
node cli.js write /path/to/workspace/tmp.txt --file local-file.txt
```

For long-running work:

```bash
node cli.js status
node cli.js job start "npm test" --cwd /path/to/workspace
node cli.js job status <job-id>
node cli.js job logs <job-id> --tail 200
node cli.js job cancel <job-id>
node cli.js job list --limit 20
node cli.js job start "sleep 30" --route ssh
node cli.js trace start ssh-link --route ssh --interval 2
node cli.js trace status ssh-link --route ssh --json
node cli.js trace logs ssh-link --route ssh --tail 120
node cli.js trace stop ssh-link --route ssh
```

The CLI reads `local/connections.json` and stores only the selected connection
name in `local/cli-state.json`. It does not copy or print full tokens.

## Safety Rules

- Never write Chinese or other non-ASCII text with shell redirection such as
  `echo >>`, `tee`, or `cat >>`.
- For file writes, use native `remote_write` first. If using CLI fallback, use
  `node cli.js write ... --content` or `--file`.
- Run `doctor` or `health` before the first read/write/bash operation.
- If daemon and SSH are both available, use daemon jobs for long-running coding work.
- If daemon fails or MCP reports `Transport closed`, switch to `--route ssh` and continue.

## Minimal Agent Bootstrap Prompt

```text
For long-running development, prefer the CLI daemon gateway:
node <skill-dir>/cli.js status
node <skill-dir>/cli.js job start "<command>" --cwd /path/to/workspace
node <skill-dir>/cli.js job status|logs|cancel <job-id>

If remote_* MCP tools are visible and stable, use native MCP for quick structured operations:
remote_connect() -> remote_health() -> remote_* operations.

If remote_* tools are not visible but Bash is available, use:
node <skill-dir>/cli.js doctor
node <skill-dir>/cli.js health
node <skill-dir>/cli.js read|write|bash|glob ...

Prefer daemon jobs for long-term coding; when transport is unstable, switch to `--route ssh` and continue.
Never use shell redirection to write non-ASCII file content.
```
