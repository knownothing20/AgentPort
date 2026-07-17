# Compatibility Contract

## Supported runtime model

AgentPort keeps three execution paths because different AI desktop applications
and network conditions expose different capabilities:

1. **Local MCP stdio client** for structured operations.
2. **Daemon HTTP and persistent Jobs** for builds, tests, installs, and durable
   incremental logs.
3. **SSH recovery** for files and synchronous work when a verified daemon
   endpoint is unavailable.

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

`client/cli-entry.js` handles modular `server`, `project`, and `v3` commands and
delegates every other command to root `cli.js`. The package binary points to this
compatibility entrypoint.

## Configuration compatibility

The modular connection registry accepts:

- V3 `servers[].endpoints[]`
- legacy `connections[]`

V3 is required for reliable automatic grouping of LAN, virtual-LAN, and SSH
endpoints under one physical server identity. Legacy connections without a
`logicalServer` or `serverId` remain separate logical servers.

## Public API compatibility

Existing core MCP names and daemon HTTP paths remain available. MCP V3 adds
project and cursor tools without renaming the old ones.

Job status and logs continue to accept existing task ids and tail parameters.
New clients may additionally use idempotency keys and cursor offsets.

## Operating systems

| Component | Windows | Linux | macOS |
|---|---:|---:|---:|
| MCP client | Supported | Supported | Supported |
| CLI client | Supported | Supported | Supported |
| Daemon HTTP transport | Supported | Supported | Supported |
| SSH transport | Supported | Supported | Supported |
| Remote daemon | Development only | Recommended | Development only |

The production daemon remains Linux-focused because detached Worker process
control, shell behavior, system metrics, and deployment scripts are Linux-based.

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
- Write, execution, Job, and config operations require matching server/workspace
  identity before fallback.
- Persistent Job submissions keep one idempotency key during response-loss retry.
- Jobs and config operations require a daemon endpoint; they do not silently
  become ad-hoc SSH commands.
- Project-relative paths cannot escape the configured project root.
