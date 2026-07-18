# Phase 4: Modular Client Runtime

## Scope

Phase 4 moves the active client-side connection and transport responsibilities
out of the large root MCP and CLI files while keeping both legacy entrypoints
available.

```text
AI desktop application
  -> client/mcp-entry.js
       -> V3 modular MCP when V3 config exists
       -> legacy index.js otherwise

Terminal / Agent fallback
  -> client/cli-entry.js
       -> modular server/project/v3 commands
       -> legacy cli.js for every existing command
```

## Connection registry

`packages/client-core/connection-registry.js` reads both formats:

- V3 `servers[].endpoints[]`
- existing `connections[]`

V3 defines one physical machine as a logical server with multiple ways to reach
it:

```text
debian-main
  - debian-main-lan          daemon, local LAN
  - debian-main-virtual-lan  daemon, Tailscale/WireGuard LAN
  - debian-main-ssh          SSH recovery
```

Endpoint ids must be globally unique. The registry accepts a logical server id or
an endpoint id and resolves both to the same server identity.

## Request-scoped runtime

`packages/client-core/client-runtime.js` creates a new immutable context for every
call. The context carries:

- request and trace ids
- operation safety policy
- logical server and workspace ids
- selected endpoint and route
- session and client ids
- idempotency key

Transport headers are produced from this context rather than mutable global
trace variables.

## Endpoint probing and selection

The runtime caches health briefly and then uses the endpoint selector introduced
in Phase 1. Selection considers:

- endpoint enabled state
- current health
- server/workspace identity
- priority
- latency
- LAN, virtual-LAN, and SSH route penalties
- a session-selected preferred endpoint

Mutating operations require identity match. Persistent Jobs, Job logs, and config
operations additionally require a daemon endpoint.

## Retry and failover

Behavior follows the shared operation policy:

- reads can retry and move to another verified endpoint
- synchronous commands do not retry after the request is sent
- Job submissions use one idempotency key for same-endpoint retry
- endpoint failover is allowed only when identity is verified
- admin writes never automatically fail over

For `remote_script_async`, the uploaded wrapper path is derived from the
idempotency key, script content, interpreter, and working directory. The same
submission therefore produces the same command path across retries, while a
different script produces an idempotency conflict instead of accidental reuse.

## Transports

### Daemon HTTP

`packages/client-transport/daemon-http.js` provides:

- bearer and client-id authentication
- trace and request headers
- request timeouts
- response limits
- transport-vs-HTTP error classification
- idempotency headers
- cursor log query parameters
- all existing public filesystem, exec, Job, and config paths

### SSH

`packages/client-transport/ssh.js` adapts the existing SSH client for:

- health and identity discovery
- read/write/stat/glob/grep
- synchronous command execution
- synchronous multiline scripts
- batch operations

SSH dependencies are loaded lazily through `lazy-ssh.js`, so daemon-only clients
and lightweight CI do not need to initialize `ssh2`.

Persistent daemon Jobs intentionally do not silently degrade to SSH. The existing
legacy CLI SSH Job implementation remains the explicit recovery path.

## Project profiles

The V3 runtime activates `local/projects.json`:

```json
{
  "projects": {
    "script2shorts": {
      "server": "debian-main",
      "root": "/home/YOUR_USER/projects/script2shorts",
      "commands": {
        "test": "pnpm test",
        "build": "pnpm build"
      }
    }
  }
}
```

Project-relative file and working-directory values are resolved under the
configured root. `project status` returns Git branch, HEAD, dirty count, and
short status. `project run` submits a standard action as a persistent Job.

## MCP compatibility

`client/mcp-entry.js` defaults to auto mode:

- V3 config present: start `client/mcp-v3.js`
- V3 config absent: start root `index.js`
- `AGENTPORT_CLIENT_MODE=legacy`: always use root `index.js`
- `AGENTPORT_CLIENT_MODE=v3`: require the modular runtime

The modular server keeps core tool names and adds:

- `remote_job_logs`
- `remote_project_list`
- `remote_project_status`
- `remote_project_run`

The guided `remote_setup` workflow remains in legacy mode; V3 setup is an
explicit config-file workflow.

## CLI compatibility

`client/cli-entry.js` handles:

- `server ...`
- `project ...`
- `v3 job ...`

All other invocations import the existing root `cli.js`. The package binary now
points to this compatibility entrypoint, so existing commands remain available
while new project-aware commands can be introduced without duplicating the old
CLI.

## Validation

Cross-platform tests cover:

- V3 and legacy registry parsing
- unhealthy LAN to healthy virtual-LAN selection
- server/workspace identity checks
- project path resolution
- request metadata
- idempotent Job retry after a lost response
- cursor log reads
- modular CLI startup without eager SSH dependencies

The dependency-installed Linux job additionally validates MCP initialize,
`tools/list`, health routing, and idempotent Job submission.

## Remaining work

Phase 5 focuses on remote development sessions rather than transport internals:

- per-task Git Worktrees
- project locks and active Agent sessions
- standard setup/lint/test/build workflows with progress
- project-aware change summaries and cleanup
- dashboard project, endpoint, Agent, Worktree, queue, and Job views
- optional Streamable HTTP MCP endpoint
