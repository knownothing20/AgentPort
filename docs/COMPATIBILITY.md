# Compatibility Contract

## Supported runtime model

AgentPort keeps three execution paths because different AI desktop applications
and network conditions expose different capabilities:

1. **Local MCP stdio client** for structured operations and Worktree Sessions.
2. **Daemon HTTP and persistent Jobs** for builds, tests, installs, durable logs,
   project locks, and Git Worktree lifecycle.
3. **SSH recovery** for files and synchronous work when a verified daemon
   endpoint is unavailable.

Persistent Jobs, configuration, and development Sessions always require a daemon
endpoint. They never silently degrade into ad-hoc SSH commands.

## Entrypoint compatibility

| Existing path | Explicit path | Status |
|---|---|---|
| `index.js` | `client/mcp-entry.js` | Both supported |
| `cli.js` | `client/cli-entry.js` | Both supported |
| `server/server.js` | `daemon/server-entry.cjs` | Both supported |

`client/mcp-entry.js` defaults to automatic compatibility:

- `local/connections.v3.json` present: modular MCP V3
- no V3 file: root legacy MCP
- `AGENTPORT_CLIENT_MODE=legacy`: force root legacy MCP
- `AGENTPORT_CLIENT_MODE=v3`: force modular MCP

`client/cli-entry.js` handles modular `server`, `project`, `session`, and `v3`
commands and delegates every other command to root `cli.js`. The package binary
points to this compatibility entrypoint.

## Configuration compatibility

The modular connection registry accepts:

- V3 `servers[].endpoints[]`
- legacy `connections[]`

V3 is required for reliable automatic grouping of LAN, virtual-LAN, and SSH
endpoints under one physical server identity. Legacy connections without a
`logicalServer` or `serverId` remain separate logical servers.

Project profiles remain optional. Worktree Session creation requires a project
profile on the client, while the server independently verifies that the resolved
Git repository is inside `WORKSPACE_ROOT`.

## Public API compatibility

Existing core MCP names and daemon HTTP paths remain available. MCP V3 adds
project, cursor, and Session tools without renaming old tools.

Job status and logs continue to accept existing task ids and tail parameters.
New clients may additionally use idempotency keys and cursor offsets.

Development Session APIs are additive under `/api/dev/*`. Existing file,
execution, Job, dashboard, config, token, and diagnostic paths remain unchanged.

## Operating systems

| Component | Windows | Linux | macOS |
|---|---:|---:|---:|
| MCP client | Supported | Supported | Supported |
| CLI client | Supported | Supported | Supported |
| Daemon HTTP transport | Supported | Supported | Supported |
| SSH transport | Supported | Supported | Supported |
| Client Session API | Supported | Supported | Supported |
| Remote Worktree daemon | Development only | Recommended | Development only |

The production daemon remains Linux-focused because detached Worker process
control, shell behavior, system metrics, deployment scripts, and long-lived Git
Worktree management are Linux-oriented.

## Node.js

- Node.js 20 and 22 are compatibility targets for extracted modules.
- Existing Node.js 18 installations may continue to work, but new code does not
  add Node 18-specific workarounds.
- SSH is loaded lazily so daemon-only client checks do not require initializing
  `ssh2`.

## Safety and fallback rules

- Do not rename existing MCP tools during extraction.
- Keep daemon routes as aliases when moving handlers.
- Every modular call uses an immutable request context.
- Read-only operations may retry and fail over after identity verification.
- Synchronous execution never retries after confirmed send.
- Write, execution, Job, config, and Session operations require matching
  server/workspace identity before fallback.
- Persistent Job submissions keep one idempotency key during response-loss retry.
- Jobs, config, and Sessions require a daemon endpoint.
- Project-relative paths cannot escape the configured project root.
- Every Agent Session uses a unique Git branch and Worktree.
- Worktree creation, merge, cleanup, and branch deletion use project-level locks.
- Merge requires a clean Session, a clean primary checkout, the correct target
  branch, no active attached Jobs, and explicit Session ID confirmation.
- Rollback never resets the primary project checkout.
- Forced cleanup and branch deletion require explicit Session ID confirmation.
