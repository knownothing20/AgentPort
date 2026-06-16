---
name: agentport
description: AI Remote Development Gateway for MCP, CLI fallback, SSH recovery, and persistent daemon jobs. Use for remote Linux development, agentport CLI, remote files, remote commands, daemon jobs, SSH fallback, token provisioning, and multi-agent connection safety.
license: MIT
---

# agentport

AgentPort lets AI agents work on a remote Linux workspace through three paths:

1. SSH-first CLI for stable baseline operations.
2. Daemon CLI jobs for long-running tests, builds, logs, and recovery.
3. Native MCP `remote_*` tools when the host exposes them and they are stable.

For full install details, read `AGENT_GUIDE.md`. This skill file is the short
runtime contract agents should follow inside a session.

Current version: **v2.5.0**

## Required Startup Check

From this skill directory:

```bash
node cli.js doctor --json
node cli.js list --json
node cli.js ssh-health --connection <ssh-connection> --route ssh --json
```

Before remote project work, read the remote project rules with an explicit
connection:

```bash
node cli.js read /home/leon/.openclaw/AGENTS.md --connection 183 --route ssh --json
```

If multiple connections exist, high-risk commands require
`--connection <name>`. Do not rely on shared current connection for writes,
exec, script, batch, jobs, trace, token, or config operations.

Use `AGENTPORT_SESSION_ID` or `CODEX_SESSION_ID` when a tool wants
session-scoped CLI current state.

## Runtime Priority

Use this order:

1. `--route ssh` for health, read, write, stat, glob, grep, and one-off bash
   when transport stability matters.
2. Daemon jobs for long-running work:
   `node cli.js job start "npm test" --connection <daemon> --route daemon`.
3. Native MCP `remote_*` only after `remote_connect()` and `remote_health()`
   return healthy structured data.

If native MCP reports `Transport closed`, keep working through the CLI instead
of stopping.

## New Client Token Provisioning

Each AI software and each machine should have its own local `local/` directory
and its own remote `clientId=token`.

Do not use junctions when different AI tools need different credentials. Do not
copy another software's daemon token as the final setup.

Fresh install flow when only SSH is configured:

```bash
node cli.js client provision \
  --client-id <machine-software> \
  --connection <ssh-connection> \
  --route ssh \
  --daemon-url http://<host>:3183 \
  --daemon-name <machine-software-daemon> \
  --local-dir <skill-dir> \
  --json
```

If verification is unauthorized after SSH provisioning, reload or restart the
remote daemon, then run provision again.

If this install already has an admin daemon connection, use daemon hot reload:

```bash
node cli.js client provision \
  --client-id <machine-software> \
  --connection <admin-daemon-connection> \
  --route daemon \
  --daemon-name <machine-software-daemon> \
  --local-dir <skill-dir> \
  --json
```

The command prints only `tokenMasked`; never print raw tokens in chat or logs.

Validate with an authenticated read-only command:

```bash
node cli.js job list --connection <daemon-connection> --route daemon --limit 1 --json
```

## Common CLI Commands

```bash
node cli.js health --connection <name> --route daemon --json
node cli.js ssh-health --connection <name> --route ssh --json
node cli.js read <remote-path> --connection <name> --route ssh --json
node cli.js write <remote-path> --file <local-file> --connection <name> --route ssh --json
node cli.js bash "pwd && ls -la" --connection <name> --route ssh --json
node cli.js job start "npm test" --cwd <remote-cwd> --connection <name> --route daemon --json
node cli.js job status <job-id> --connection <name> --route daemon --json
node cli.js job logs <job-id> --tail 200 --connection <name> --route daemon --json
node cli.js job cancel <job-id> --connection <name> --route daemon --json
```

## Sync Maintained Repo To Skill Copies

Keep each software's `local/`, `.git`, and `node_modules` separate. From the
maintained repository copy:

```bash
node sync.cjs --skills --target <skill-dir-1> --target <skill-dir-2>
node sync.cjs --check --skills --target <skill-dir-1> --target <skill-dir-2>
```

If local policy blocks `node sync.cjs`, copy repository files with the same
exclusions: `.git`, `local`, and `node_modules`.

## Safety Rules

- Always pass explicit `--connection` for write, exec, script, batch, job,
  trace, token, and config operations.
- Prefer structured `write` or `remote_write`; avoid shell redirection for
  non-ASCII content.
- Do not read, print, or copy raw tokens unless the user explicitly authorizes
  a credential repair task. Even then, keep values in memory and report only
  masked status.
- Do not overwrite remote daemon files during normal client setup. Deploy or
  replace daemon code only for planned maintenance.
- Keep remote project work on the remote machine; local skill directories are
  only tools and private config.
