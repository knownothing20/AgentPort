# Agent Install And Usage Guide

This guide is for AI agents and AI desktop tools that need remote Linux
development access through `mcp-remote-agent`.

## Capability Priority

Always choose the highest available integration level:

1. Native MCP tools.
   Use `remote_connect`, `remote_health`, `remote_read`, `remote_write`,
   `remote_bash`, and the other `remote_*` tools directly.
2. Bash or terminal fallback.
   If native `remote_*` MCP tools are not visible but the AI tool can run local
   shell commands, use `node cli.js ...`.
3. HTTP fallback.
   If the AI tool can call HTTP but cannot run shell commands, call the daemon
   REST API directly.
4. Manual fallback.
   If none of the above are available, print exact commands for the user to run.

For long-term coding, prefer daemon connections. SSH is a reliable fallback for
quick access or when the daemon is unavailable.

## Installation Check

From the skill directory:

```bash
npm install
node cli.js doctor
```

Expected result: at least one connection reports `"ok": true`.

If the target AI tool supports native MCP registration, also create
`local/mcp-remote-agent.json` from `mcp-remote-agent.example.json`, set
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

Do not fall back to CLI when native MCP tools are working.

## CLI Fallback Usage

When native MCP tools are not visible but Bash/terminal is available, run:

```bash
node <skill-dir>/cli.js doctor
node <skill-dir>/cli.js list
node <skill-dir>/cli.js connect <connection-name>
node <skill-dir>/cli.js health
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

The CLI reads `local/connections.json` and stores only the selected connection
name in `local/cli-state.json`. It does not copy or print full tokens.

## Safety Rules

- Never write Chinese or other non-ASCII text with shell redirection such as
  `echo >>`, `tee`, or `cat >>`.
- For file writes, use native `remote_write` first. If using CLI fallback, use
  `node cli.js write ... --content` or `--file`.
- Run `doctor` or `health` before the first read/write/bash operation.
- If daemon and SSH are both available, use daemon for long-running coding work.
- If daemon fails, switch to an SSH connection and rerun `health`.

## Minimal Agent Bootstrap Prompt

```text
If remote_* MCP tools are visible, use native MCP first:
remote_connect() -> remote_health() -> remote_* operations.

If remote_* tools are not visible but Bash is available, use:
node <skill-dir>/cli.js doctor
node <skill-dir>/cli.js health
node <skill-dir>/cli.js read|write|bash|glob ...

Prefer daemon connections for long-term coding; use SSH only as fallback.
Never use shell redirection to write non-ASCII file content.
```
