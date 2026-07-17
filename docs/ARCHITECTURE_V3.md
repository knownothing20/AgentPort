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
daemon/                     Explicit remote-daemon entrypoint and modular gateway
packages/shared/            Request context and operation safety policy
packages/client-core/       Endpoint selection and project profiles
packages/daemon-core/       Path guard and read/search/write services
index.js                    Legacy-compatible MCP implementation
cli.js                      Legacy-compatible CLI implementation
server/server.js            Legacy daemon behind the compatibility proxy
```

The old client entrypoints remain compatible. The daemon has moved to a staged
public-gateway model: extracted route groups run in small modules while the
legacy service remains available on loopback for functionality not yet moved.

## Read/search/write separation

The daemon core is separated by responsibility:

- `file-read-service.cjs`
  - full text reads with size limits
  - streamed line-range reads
  - byte-range reads
  - file metadata
  - directory manifests
- `file-search-service.cjs`
  - built-in glob matching
  - content grep
  - excluded build/cache directories
  - symlink skipping
  - result and scan limits
- `file-write-service.cjs`
  - optimistic concurrency through ETags
  - create-only writes
  - per-path locks
  - verified atomic replacement
  - existing permission preservation
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

## Modular daemon gateway

The source-tree daemon entrypoint now starts:

```text
public modular gateway
  -> daemon-core file APIs
  -> loopback legacy daemon for exec, jobs, dashboard, config, and diagnostics
```

The gateway owns the existing read/stat/glob/grep/write aliases plus new byte
range, manifest, and guarded-delete routes. Unextracted paths are transparently
proxied to the legacy daemon without changing client URLs.

The legacy process binds only to `127.0.0.1` and uses either a configured
`AGENTPORT_LEGACY_PORT` or an automatically selected free port. See
`PHASE2_MODULAR_GATEWAY.md` for route and deployment details.

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

The modular daemon health response now supplies stable `serverId` and
`workspaceId` fields for this validation.

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

### Phase 1 — repository and core boundaries

Completed:

- explicit Client and Daemon directories
- compatibility entrypoints
- operation policy
- request-scoped context model
- logical endpoint selector
- project profile parser
- read/write daemon services
- atomic writes and symlink-safe path checks
- cross-platform architecture tests

### Phase 2 — file route extraction

Completed in the source-tree daemon entrypoint:

1. health identity and capability augmentation
2. read/stat routes
3. streamed range and byte reads
4. manifest routes
5. glob/grep routes
6. write and guarded delete routes
7. loopback legacy process and transparent compatibility proxy
8. cross-platform gateway integration tests

Existing deployments that copy only `server/` remain on the legacy single
process until they deploy `daemon/`, `packages/daemon-core/`, and `server/`
together.

### Phase 3 — execution and job extraction

Next:

1. command policy module
2. execution queue module
3. script execution adapter
4. job store and runner
5. cursor-based log reads
6. idempotent job submission
7. daemon restart reconciliation

### Phase 4 — client extraction

Move from `index.js` and `cli.js` into:

1. connection registry
2. daemon HTTP transport
3. SSH transport
4. MCP tool adapters
5. CLI command adapters
6. project commands

### Phase 5 — remote development experience

- project commands
- Git worktree sessions per agent task
- daemon job worker separated from the HTTP process
- optional Streamable HTTP MCP endpoint
- dashboard project, agent, endpoint, and task views

## Non-goals

This design is for trusted physical or virtual LAN development. It does not add
multi-tenant SaaS accounts, billing, enterprise SSO, Kubernetes, or public
internet exposure requirements.
