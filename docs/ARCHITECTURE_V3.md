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
client/                     Client bootstraps, modular MCP, and project-aware CLI
packages/client-core/       Registry, state, endpoint selection, project runtime
packages/client-transport/  Daemon HTTP and lazy SSH transports
packages/shared/            Request context and operation safety policy

daemon/                     Remote daemon entrypoint and modular Gateway
packages/daemon-core/       Files, search, execution, queue, and persistent Jobs
server/server.js            Legacy dashboard/config/diagnostics behind proxy

index.js                    Legacy-compatible MCP implementation
cli.js                      Legacy-compatible CLI implementation
```

Both root client implementations remain available. `client/mcp-entry.js` and
`client/cli-entry.js` select modular functionality without removing the old
behavior.

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

Execution is divided into focused components:

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
  - persistent metadata, results, logs, and idempotency references
  - compatibility with the existing Job directory
- `job-worker.cjs`
  - detached command process
  - direct stdout/stderr streaming to disk
  - timeout and cancellation handling
- `job-service.cjs`
  - submission, reconciliation, listing, cancellation, deletion
  - idempotency conflict detection
  - cursor-based incremental logs

A Gateway restart no longer requires command ChildProcess objects to remain in
Gateway memory. New tasks are reconciled through metadata, Worker PIDs, and
result files.

## Modular daemon Gateway

The source-tree daemon entrypoint starts:

```text
public modular Gateway
  -> daemon-core file/search APIs
  -> daemon-core synchronous execution
  -> daemon-core persistent Jobs
  -> loopback legacy daemon for dashboard, config, and diagnostics
```

The Gateway owns existing file, execution, batch, and Job aliases. Unextracted
paths are transparently proxied to the legacy daemon without changing client
URLs. The compatibility process binds only to `127.0.0.1`.

See:

- `PHASE2_MODULAR_GATEWAY.md`
- `PHASE3_EXEC_JOBS.md`

## Modular client runtime

The client now has the same separation of responsibilities:

- `connection-registry.js`
  - V3 logical servers and endpoints
  - legacy `connections[]` compatibility
  - server-or-endpoint name resolution
- `client-state.js`
  - session-scoped selected server and endpoint
  - atomic local state updates
- `client-runtime.js`
  - immutable request context per call
  - health cache and identity validation
  - endpoint choice, retry, and verified failover
  - project-relative paths and standard actions
- `daemon-http.js`
  - authentication and trace headers
  - response limits and request timeouts
  - idempotency and cursor parameters
  - transport-vs-HTTP error classification
- `ssh.js` / `lazy-ssh.js`
  - on-demand SSH loading
  - identity discovery
  - file/search/synchronous execution recovery

```text
client/mcp-entry.js
  -> V3 MCP when connections.v3.json exists
  -> legacy index.js otherwise

client/cli-entry.js
  -> modular server/project/v3 commands
  -> legacy cli.js for all other commands
```

See `PHASE4_CLIENT_RUNTIME.md`.

## Client request model

Every modular call creates one immutable context:

```text
requestId
traceId
sessionId
clientId
operation and safety policy
logical serverId
workspaceId
selected endpoint
route
idempotencyKey
```

The context is passed through the runtime and transport. Concurrent MCP calls do
not share a mutable trace or per-call connection value.

## Logical servers and endpoint selection

A logical server may expose several endpoints:

```text
debian-main
  - LAN daemon endpoint
  - virtual-LAN daemon endpoint
  - SSH recovery endpoint
```

The runtime probes and selects by health, priority, latency, route type, and
identity. Mutating operations require matching server/workspace identity.
Persistent Jobs, Job logs, and config operations require a daemon endpoint.

Read-only operations can move to another verified endpoint. Synchronous commands
are not retried after send. Persistent Job submissions use one idempotency key
for safe response-loss retry.

## Project profiles

`local/projects.json` gives Agents stable project names instead of repeatedly
constructing paths and commands. Profiles contain:

- logical server
- project root
- default branch
- Agent instruction files
- package manager
- standard install, lint, test, and build commands

The modular interfaces now expose:

```text
agentport project list
agentport project status <project>
agentport project run <project> <action>
agentport project follow <job-id>
```

MCP equivalents are `remote_project_list`, `remote_project_status`, and
`remote_project_run`.

## Migration plan

### Phase 1 — repository and core boundaries

Completed:

1. explicit Client and Daemon directories
2. compatibility entrypoints
3. operation policy and immutable request context
4. logical endpoint selector and project parser
5. atomic writes and symlink-safe paths
6. cross-platform architecture tests

### Phase 2 — file route extraction

Completed:

1. health identity and capability augmentation
2. read/stat/range/byte/manifest routes
3. glob and grep routes
4. write and guarded delete routes
5. loopback legacy process and compatibility proxy
6. cross-platform Gateway tests

### Phase 3 — execution and Job extraction

Completed:

1. shared command policy and synchronous queue
2. command, script, and batch services
3. persistent Job store and detached Worker
4. cursor logs and idempotent submission
5. Gateway restart reconciliation
6. legacy Job directory compatibility
7. cross-platform execution and Linux Worker tests

### Phase 4 — Client extraction

Completed:

1. V3 and legacy connection registry
2. daemon HTTP transport
3. lazy SSH transport adapter
4. live logical-server endpoint selection
5. immutable per-call contexts in the modular MCP runtime
6. idempotency and cursor options in MCP and CLI
7. project-aware CLI and MCP commands
8. automatic legacy fallback when no V3 config is present
9. cross-platform runtime and MCP integration tests

### Phase 5 — remote development sessions

Next:

1. per-task Git Worktrees
2. project and branch locks
3. active Agent session registry
4. standard setup/lint/test/build workflows with progress
5. project-aware diff, commit, merge, and cleanup helpers
6. optional Streamable HTTP MCP endpoint
7. Dashboard project, Agent, endpoint, Worktree, queue, and Job views

## Non-goals

This design targets trusted physical or virtual LAN development. It does not add
multi-tenant SaaS accounts, billing, enterprise SSO, Kubernetes, or public
internet exposure requirements.
