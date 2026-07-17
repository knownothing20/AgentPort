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
packages/daemon-core/       Files, search, execution, queue, and persistent jobs
index.js                    Legacy-compatible MCP implementation
cli.js                      Legacy-compatible CLI implementation
server/server.js            Legacy dashboard/config/diagnostics behind proxy
```

The old client entrypoints remain compatible. The daemon uses a staged public
Gateway: extracted route groups run in small modules while the legacy service
remains available on loopback for functionality not yet moved.

## Read/search/write separation

The daemon core separates filesystem responsibilities:

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

## Execution and Job separation

Execution is now divided into focused components:

- `command-policy.cjs`
  - execution enable/disable
  - command allowlists
  - shell-metacharacter bypass prevention
  - script interpreter allowlists
- `execution-queue.cjs`
  - configurable concurrency
  - queue timeout and HTTP 429 state
  - shared queue statistics
- `exec-service.cjs`
  - synchronous commands and scripts
  - workspace-bound `cwd`
  - output limits and timeouts
  - process-tree cleanup
- `job-store.cjs`
  - persistent metadata, result, logs, and idempotency references
  - compatibility with the existing Job directory
- `job-worker.cjs`
  - detached command process
  - direct stdout/stderr streaming to disk
  - timeout and cancellation handling
- `job-service.cjs`
  - Job submission, reconciliation, listing, cancellation, deletion
  - idempotency conflict detection
  - cursor-based incremental logs

A public Gateway restart no longer requires the command ChildProcess to remain in
Gateway memory. New tasks are reconciled through metadata, Worker PIDs, and
result files.

## Modular daemon gateway

The source-tree daemon entrypoint now starts:

```text
public modular gateway
  -> daemon-core file/search APIs
  -> daemon-core synchronous execution
  -> daemon-core persistent jobs
  -> loopback legacy daemon for dashboard, config, and diagnostics
```

The Gateway owns existing file, execution, batch, and Job aliases. Unextracted
paths are transparently proxied to the legacy daemon without changing client
URLs.

The legacy process binds only to `127.0.0.1` and uses either a configured
`AGENTPORT_LEGACY_PORT` or an automatically selected free port.

See:

- `PHASE2_MODULAR_GATEWAY.md`
- `PHASE3_EXEC_JOBS.md`

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

The modular daemon health response supplies stable `serverId`, `workspaceId`,
execution state, Job runtime, and capability fields for validation.

## Project profiles

`local/projects.json` gives agents stable project names instead of repeatedly
constructing remote paths and commands. Profiles contain:

- logical server
- project root
- default branch
- agent instruction files
- package manager
- standard install, lint, test, and build commands

A later Client phase can expose `agentport project connect|status|build` while
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
8. cross-platform Gateway integration tests

### Phase 3 — execution and Job extraction

Completed:

1. shared command policy
2. synchronous execution queue
3. command and script execution service
4. modular batch execution
5. persistent Job store and detached Worker
6. cursor-based incremental logs
7. idempotent Job submission
8. Gateway restart reconciliation
9. legacy Job directory compatibility
10. cross-platform execution and Linux Worker tests

### Phase 4 — Client extraction

Next, move from `index.js` and `cli.js` into:

1. connection registry
2. daemon HTTP transport
3. SSH transport
4. MCP tool adapters
5. CLI command adapters
6. live logical-server endpoint selection
7. idempotency and cursor options in client interfaces

### Phase 5 — remote development experience

- project commands
- Git Worktree sessions per Agent task
- project-aware install/lint/test/build actions
- optional Streamable HTTP MCP endpoint
- Dashboard project, Agent, endpoint, and task views

## Non-goals

This design is for trusted physical or virtual LAN development. It does not add
multi-tenant SaaS accounts, billing, enterprise SSO, Kubernetes, or public
internet exposure requirements.
