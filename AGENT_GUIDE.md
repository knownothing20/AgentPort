# Agent Install And Usage Guide

This guide is for AI agents and AI desktop tools that need remote Linux
development access through `agentport`.

## Capability Priority

Always choose the most stable available runtime for the task:

1. Native MCP tools for quick structured operations. This is the preferred
   windowless path on Windows.
   If `remote_*` tools are visible and stable, use `remote_connect`,
   `remote_health`, `remote_read`, `remote_write`, `remote_bash`, and the other
   `remote_*` tools directly.
2. SSH-first CLI for baseline stability only when native MCP is unavailable.
   Use `node cli.js ssh-health`, `node cli.js read|safe-write|safe-apply|safe-script|safe-bash --route ssh`,
   and `node cli.js job ... --route ssh` when MCP transport closes or daemon
   health is unknown.
3. Daemon jobs for long-running development.
   Prefer MCP `remote_exec_async` or `remote_script_async`; use
   `node cli.js safe-job ...` and `node cli.js job ...` as CLI fallbacks for
   builds, tests, installs, Docker operations, polling, and durable logs.
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

1. Which server should this computer connect to (for example `192.0.2.10`)?
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
Prefer native MCP for short file operations when available. Use daemon jobs for
long-running work, CLI file operations over the daemon route when MCP is
unavailable but the daemon remains reachable, and SSH only for transport
recovery. The CLI is not synonymous with SSH, and MCP tools are not guaranteed
to use the daemon.

## Rule File Access

Use the SKILL.md Rule Files and Workspace Boundaries contract during startup.
A project's required parent rules can sit outside the daemon's workspace roots;
being referenced by project instructions does not grant access. Read them through
the active approved file-read route, not a shell command.

After an explicit workspace denial, do not retry or change routes to bypass it.
Report the required path and denial once, and pause affected project writes and
execution until the owner supplies the rules or an authorized read-only fix is
verified. Loading or editing this Skill does not enable a server-side file
exception; the client supports the optional server setting described below.

The optional `READ_ONLY_RULE_FILES_JSON` server setting is disabled by default.
If explicitly enabled on the modular daemon, it permits authenticated normal
file-read and batch-read access to registered exact text files up to 256 KiB.
It grants no stat, byte-read, search, write, cwd, or arbitrary command access.
Any roots or boundary state in health output are reported configuration, not an
independent security test; path checks are not an OS sandbox. This guide does
not imply that a server has enabled the setting.

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
node cli.js safe-write /path/to/workspace/file.ts --file local-utf8-payload.ts --verify readback
node cli.js safe-apply local.patch --cwd /path/to/workspace --check
node cli.js safe-apply local.patch --cwd /path/to/workspace
node cli.js safe-script local-script.sh --interpreter bash --cwd /path/to/workspace
node cli.js safe-bash local-readonly-check.sh --cwd /path/to/workspace
node cli.js safe-job local-build.sh --cwd /path/to/workspace --route daemon --job-timeout-ms 1800000
```

Use `safe-write`, `safe-apply`, and `safe-script` when the payload is source
code, a patch, Markdown, Chinese text, or a complex script. The shell command
should contain only short arguments and file paths; do not inline large payloads
into PowerShell, `--content`, heredoc, or `bash` strings.

Use `safe-bash` for complex read-only diagnostics such as grep/find pipelines,
`cd && git ...`, nested quotes, template strings, or commands containing `$`,
`${...}`, `|`, or backticks.

`safe-bash` and `safe-script` return JSON by default. Add `--plain` when a
short script's stdout and stderr should go directly to the corresponding local
streams. The CLI preserves the remote failure exit code. An empty stdout is
valid, not a reason to rerun the script. `--plain` cannot be combined with
`--json` or `--dry-run`.

### Remote Search Fallback

Prefer `remote_grep` for remote content search. It uses bounded Node search in
daemon mode and bounded `grep` through SSH recovery, so `rg` is optional.

Before directly running `rg` in a remote shell, first check it without emitting
an error:

```bash
if command -v rg >/dev/null 2>&1; then
  rg -n --hidden --glob '!.git/**' 'keyword' /path/to/workspace
else
  grep -RIn --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist \
    --exclude-dir=build 'keyword' /path/to/workspace
fi
```

Keep searches inside the requested project or workspace. Do not report a
known-missing `rg` command before using the fallback, and never recursively
search the whole disk.

Use `safe-job` instead of `safe-script` for builds, tests, installs, Docker
operations, and any script that may run longer than 10 seconds. It uploads and
verifies the local UTF-8 script, submits a persistent remote job, returns a job
id immediately, and removes its temporary wrapper when the job finishes. Its
daemon timeout defaults to 30 minutes; set `--job-timeout-ms 0` only for
intentionally unbounded work.

When calling the Windows CLI from Git Bash, MSYS may change remote positional
paths used by `read`, `write`, and `safe-write`, as well as `--cwd` and
`--remote-tmp-dir`, before Node receives them. Quoting alone is not reliable.
Prefer PowerShell. If Git Bash is required, disable conversion for all arguments
and pass Windows-compatible local file/script paths (use `cygpath -w` when
needed):

```bash
MSYS2_ARG_CONV_EXCL='*' node cli.js safe-job 'C:/work/build.sh' \
  --cwd=/remote/path --connection <daemon> --route daemon
```

The same prefix applies to positional remote paths and `--file` paths. For
example:

```bash
MSYS2_ARG_CONV_EXCL='*' node cli.js read /remote/path/file.txt --connection <daemon> --route daemon
MSYS2_ARG_CONV_EXCL='*' node cli.js safe-write /remote/path/file.txt --file 'C:/work/payload.txt' --connection <daemon> --route daemon
```

Do not attempt to repair an argument after it has already been converted. The
CLI rejects recognizable Windows absolute paths received as remote directory
or file target arguments, but cannot reliably infer or repair every converted
path.
`success: true` from `job start` or `safe-job` means the submission succeeded;
poll `job status` for the terminal status and exit code.

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
  `node cli.js safe-write ... --file` for large or non-ASCII payloads, and
  reserve `write --content` for tiny ASCII probes.
- For multi-file patches, use `safe-apply --check` first, then `safe-apply`.
- For short remote scripts, use `safe-script` instead of putting multiline
  scripts in a local PowerShell command. Use `safe-job` for long scripts.
- For complex read-only remote commands, use `safe-bash` instead of
  `bash "grep ... | ..."`.
- Run `doctor` or `health` before the first read/write/bash operation.
- If daemon and SSH are both available, use daemon jobs for long-running coding work.
- If daemon fails or MCP reports `Transport closed`, switch to `--route ssh` and continue.

### Windows Hidden Stdio Launcher

Windows may display a terminal when a console-based MCP server or fallback CLI
is launched directly. Build the bundled launcher with:

```powershell
./windows/build-hidden-stdio-launcher.ps1
```

The launcher preserves stdin/stdout/stderr, starts the child with
`CREATE_NO_WINDOW`, and places it in a kill-on-close Windows Job Object. If the
parent Codex or PowerShell process exits, it terminates the full child process
tree instead of leaving an orphaned `node.exe`.

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
