# AgentPort V3 Architecture Refactor

## Goal

Make the two sides of AgentPort visually and technically distinct without
breaking the current MCP and daemon deployment:

```text
AI desktop application
  -> AgentPort Client (MCP / CLI / route selection)
  -> LAN or virtual-LAN endpoint
  -> AgentPort Daemon (auth / files / exec / jobs)
  -> Linux workspace
```

## Repository boundaries

```text
client/                     Explicit local-client entrypoints and documentation
daemon/                     Explicit remote-daemon entrypoint and documentation
packages/shared/            Request context and operation safety policy
packages/client-core/       Endpoint selection and project profiles
packages/daemon-core/       Path guard, read service, write service, atomic writes
index.js                    Legacy-compatible MCP implementation
cli.js                      Legacy-compatible CLI implementation
server/server.js            Legacy-compatible daemon implementation
```

The old entrypoints remain authoritative in the first phase. New entrypoints are
thin facades so installations can migrate immediately while implementation code
is extracted in small reviewable steps.

## Read/write separation

The daemon core is now separated by responsibility:

- `file-read-service.cjs`
  - text reads with line ranges
  - byte-range reads
  - file metadata
  - directory manifests
- `file-write-service.cjs`
  - optimistic concurrency through ETags
  - create-only writes
  - per-path locks
  - verified atomic replacement
  - guarded file removal
- `path-guard.cjs`
  - lexical workspace checks
  - realpath checks
  - symbolic-link escape prevention
- `atomic-write.cjs`
  - same-directory temporary files
  - fsync before rename
  - SHA-256 verification

This removes the assumption that all filesystem behavior must live inside one
Express file.

## Client request model

Every tool call should eventually create one immutable request context:

```text
requestId
traceId
sessionId
clientId
operation and policy
logical serverId
workspaceId
selected endpoint
route
idempotencyKey
```

The context is passed through functions rather than stored in mutable global
variables. This prevents concurrent MCP calls from sharing the wrong trace or
connection state.

## Logical servers and endpoint selection

A logical server may expose several endpoints:

```text
debian-main
  - LAN daemon endpoint
  - virtual-LAN daemon endpoint
  - SSH recovery endpoint
```

The client selects the healthiest compatible endpoint by priority and latency.
Mutating operations require matching server and workspace identity. Read-only
operations may fail over more freely, but an explicit identity mismatch is
always rejected.

## Project profiles

`local/projects.json` gives agents stable project names instead of repeatedly
constructing remote paths and commands. Profiles contain:

- logical server
- project root
- default branch
- agent instruction files
- package manager
- standard install, lint, test, and build commands

A later CLI phase can expose `agentport project connect|status|build` while
reusing the profile parser introduced here.

## Migration plan

### Phase 1 — included in this refactor

- explicit Client and Daemon directories
- compatibility entrypoints
- operation policy
- request-scoped context model
- logical endpoint selector
- project profile parser
- read/write daemon services
- atomic writes and symlink-safe path checks
- cross-platform architecture tests

### Phase 2 — route extraction

Move the following handlers out of `server/server.js` without changing URLs:

1. health and capabilities
2. read/stat/glob/grep routes
3. write routes
4. exec routes
5. job routes
6. admin/config routes
7. dashboard and diagnostics

Each extraction should leave a compatibility route registration in the old app.

### Phase 3 — client extraction

Move from `index.js` and `cli.js` into:

1. connection registry
2. daemon HTTP transport
3. SSH transport
4. MCP tool adapters
5. CLI command adapters
6. project commands

### Phase 4 — remote development experience

- server/workspace identity endpoint
- project commands
- Git worktree sessions per agent task
- cursor-based incremental job logs
- idempotent job submission
- daemon job worker separated from the HTTP process
- optional Streamable HTTP MCP endpoint

## Non-goals

This design is for trusted physical or virtual LAN development. It does not add
multi-tenant SaaS accounts, billing, enterprise SSO, Kubernetes, or public
internet exposure requirements.
