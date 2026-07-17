# AgentPort V3 Architecture Refactor

## Goal

Make the two sides of AgentPort visually and technically distinct without
breaking the current MCP and daemon deployment:

```text
AI desktop application
  -> AgentPort Client (MCP / CLI / route selection)
  -> LAN or virtual-LAN endpoint
  -> AgentPort public development Gateway
  -> modular file / exec / Job services
  -> isolated Git Worktrees and Linux workspace
```

## Repository boundaries

```text
client/                     Client bootstraps, modular MCP, project and Session CLI
packages/client-core/       Registry, state, routing, projects, Session client
packages/client-transport/  Daemon HTTP and lazy SSH transports
packages/shared/            Request context and operation safety policy

daemon/                     Public development and modular daemon Gateways
packages/daemon-core/       Files, exec, Jobs, Git Worktree Session lifecycle
server/server.js            Legacy dashboard/config/diagnostics behind proxy

index.js                    Legacy-compatible MCP implementation
cli.js                      Legacy-compatible CLI implementation
```

Both root client implementations remain available. `client/mcp-entry.js` and
`client/cli-entry.js` select modular functionality without removing old behavior.

## Read/search/write separation

The daemon core separates filesystem responsibilities:

- `file-read-service.cjs`
  - full text reads with size limits
  - streamed line-range reads
  - byte-range reads
  - file metadata and directory manifests
- `file-search-service.cjs`
  - built-in glob matching and content grep
  - excluded build/cache directories
  - symlink skipping and scan limits
- `file-write-service.cjs`
  - optimistic concurrency through ETags
  - create-only writes and per-path locks
  - verified atomic replacement
  - permission preservation and guarded removal
- `path-guard.cjs`
  - lexical and realpath workspace checks
  - symbolic-link escape prevention
- `atomic-write.cjs`
  - same-directory temporary files
  - fsync before rename and SHA-256 verification

## Execution and Job separation

Execution is divided into focused components:

- `command-policy.cjs`
  - execution enable/disable
  - command and interpreter allowlists
  - shell-metacharacter bypass prevention
- `execution-queue.cjs`
  - configurable concurrency
  - queue timeout and HTTP 429 state
- `exec-service.cjs`
  - synchronous commands and scripts
  - workspace-bound `cwd`
  - output limits, timeouts, and process-tree cleanup
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
Gateway memory. Tasks are reconciled through metadata, Worker PIDs, and results.

## Public daemon layers

The source-tree daemon entrypoint starts three layers:

```text
public development Gateway
  -> Git Worktree Session API
  -> loopback modular Gateway
       -> daemon-core file/search APIs
       -> daemon-core synchronous execution
       -> daemon-core persistent Jobs
       -> loopback legacy daemon for dashboard, config, token, and diagnostics
```

Only the development Gateway binds to the LAN address. The modular and legacy
services use dynamically selected loopback ports. Existing file, execution, Job,
and management URLs remain reachable through transparent proxying.

See:

- `PHASE2_MODULAR_GATEWAY.md`
- `PHASE3_EXEC_JOBS.md`
- `PHASE5_DEVELOPMENT_SESSIONS.md`

## Modular client runtime

The client has the same separation of responsibilities:

- `connection-registry.js`
  - V3 logical servers and endpoints
  - legacy `connections[]` compatibility
- `client-state.js`
  - session-scoped selected server and endpoint
  - atomic local state updates
- `client-runtime.js`
  - immutable request context per call
  - health cache and identity validation
  - endpoint choice, retry, and verified failover
  - project-relative paths and standard actions
- `development-sessions.js`
  - daemon-only Session endpoint selection
  - project profile to Worktree Session mapping
  - idempotent Session Job submission
  - status, Diff, commit, merge, rollback, and cleanup requests
- `daemon-http.js`
  - authentication and trace headers
  - response limits and request timeouts
  - idempotency and cursor parameters
- `ssh.js` / `lazy-ssh.js`
  - on-demand SSH loading
  - identity discovery
  - file/search/synchronous execution recovery

```text
client/mcp-entry.js
  -> V3 MCP when connections.v3.json exists
  -> legacy index.js otherwise

client/cli-entry.js
  -> modular server/project/session/v3 commands
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

Concurrent MCP calls do not share mutable trace or per-call connection state.

## Logical servers and endpoint selection

A logical server may expose several endpoints:

```text
debian-main
  - LAN daemon endpoint
  - virtual-LAN daemon endpoint
  - SSH recovery endpoint
```

The runtime selects by health, priority, latency, route type, and identity.
Mutating operations require matching server/workspace identity. Persistent Jobs,
Session operations, Job logs, and config operations require a daemon endpoint.

Read-only operations can move to another verified endpoint. Synchronous commands
are not retried after send. Persistent Job and Session Job submissions retain one
idempotency key for safe response-loss retry.

## Project profiles

`local/projects.json` gives Agents stable project names instead of repeatedly
constructing paths and commands. Profiles contain:

- logical server
- project root and default branch
- Agent instruction files
- package manager
- standard install, lint, test, and build commands

The modular interfaces expose:

```text
agentport project list
agentport project status <project>
agentport project run <project> <action>
agentport project follow <job-id>
```

MCP equivalents are `remote_project_list`, `remote_project_status`, and
`remote_project_run`.

## Multi-Agent development Sessions

`development-session-service.cjs` creates a unique Git branch and Worktree for
each Agent task. Session metadata records the repository, Worktree, branch, base
commit, Agent, task, rule files, commands, attached Jobs, heartbeat, and lease.

```text
agentport session create <project>
agentport session status <session-id>
agentport session run <session-id> test
agentport session diff <session-id>
agentport session commit <session-id> --message "..."
agentport session merge <session-id> --confirm <session-id>
agentport session cleanup <session-id> --confirm <session-id>
```

Short project locks serialize repository-level operations while editing and
builds remain parallel in separate Worktrees. Merge requires:

- explicit Session ID confirmation
- no active attached Jobs unless force is explicit
- clean Session and primary Worktrees
- primary Worktree already on the requested target branch

Rollback never resets the primary project checkout. Forced cleanup and branch
deletion also require explicit Session ID confirmation.

The public development Gateway exposes `/api/dev/*` and aggregates Session and
Job state through `/api/dev/overview`, providing the data contract for a future
browser control surface.

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
2. daemon HTTP and lazy SSH transports
3. live logical-server endpoint selection
4. immutable per-call contexts in MCP
5. idempotency and cursor options in MCP and CLI
6. project-aware CLI and MCP commands
7. automatic legacy fallback
8. cross-platform runtime and MCP integration tests

### Phase 5 — remote development Sessions

Completed:

1. per-task Git branches and Worktrees
2. lease-aware project operation locks
3. active Agent Session registry and heartbeat
4. standard project actions executed as persistent Jobs
5. Session Job attachment and status aggregation
6. bounded project Diff and Git status
7. isolated branch commit
8. confirmation-gated rollback, merge, cleanup, and branch deletion
9. CLI and MCP Session interfaces
10. real Git Worktree, Gateway, client, and MCP integration tests

### Phase 6 — productization and deployment

Remaining:

1. gray deployment and restart testing on the real Debian server
2. browser Dashboard using `/api/dev/overview`
3. optional automatic stale-Session cleanup policy
4. approval/review workflow before merge
5. push and pull-request helpers
6. conflict-resolution workflow
7. optional Streamable HTTP MCP endpoint

## Non-goals

This design targets trusted physical or virtual LAN development. It does not add
multi-tenant SaaS accounts, billing, enterprise SSO, Kubernetes, or public
internet exposure requirements.
