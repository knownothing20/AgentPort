# Compatibility Contract

## Supported runtime model

AgentPort keeps three execution paths because different AI desktop applications
expose different capabilities:

1. **Local MCP stdio client** for short structured operations.
2. **Daemon HTTP jobs** for builds, tests, installs, and durable logs.
3. **SSH recovery** when the MCP or daemon transport is unavailable.

The root entrypoints remain supported during the refactor:

| Existing path | Explicit path | Status |
|---|---|---|
| `index.js` | `client/mcp-entry.js` | Both supported |
| `cli.js` | `client/cli-entry.js` | Both supported |
| `server/server.js` | `daemon/server-entry.cjs` | Both supported in source tree |

## Operating systems

| Component | Windows | Linux | macOS |
|---|---:|---:|---:|
| MCP client | Supported | Supported | Supported |
| CLI client | Supported | Supported | Supported |
| SSH transport | Supported | Supported | Supported |
| Remote daemon | Development only | Recommended | Development only |

The production daemon remains Linux-focused because persistent job process-group
control, shell behavior, system metrics, and deployment scripts are Linux-based.

## Node.js

- Node.js 20 and 22 are the compatibility targets for the new extracted modules.
- Existing Node.js 18 installations may continue to work, but CI should not add
  new Node 18-only workarounds.

## Refactor rules

- Do not rename existing MCP tools during extraction.
- Keep current daemon routes as aliases when moving handlers.
- New mutating operations must use request-scoped context and operation policy.
- Read-only operations may fail over automatically after endpoint verification.
- Write, execution, and job-control operations require matching server and
  workspace identity before transport fallback.
- Job-start requests must use an idempotency key before retrying after uncertain
  network delivery.
