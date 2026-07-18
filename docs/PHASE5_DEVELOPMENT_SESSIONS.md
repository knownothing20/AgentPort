# Phase 5: Multi-Agent Development Sessions

## Goal

Phase 5 turns AgentPort from a remote command gateway into a safer multi-Agent
remote development workspace. Every Agent task can receive its own Git branch,
Worktree, lease, Job list, Diff, commit, merge, rollback, and cleanup lifecycle.

```text
AI desktop application
  -> AgentPort MCP / CLI
  -> logical server and verified daemon endpoint
  -> development session API
  -> isolated Git Worktree
  -> persistent build/test Jobs
```

The primary project checkout is no longer the default place where multiple AI
sessions write concurrently.

## Runtime layout

```text
~/.agentport/
  sessions/
    <session-id>.json
    .locks/
  worktrees/
    <session-id>/
  daemon/jobs/
    <job-id>/
```

Session metadata records:

- logical project name
- source repository and primary checkout
- Worktree path
- base commit and target branch
- isolated Agent branch
- Agent and client identity
- task description
- standard project commands
- instruction files found in the Worktree
- attached persistent Job ids
- heartbeat and lease expiry
- merge, rollback, and cleanup history

## Creating a session

The client resolves the project profile and sends the server:

- project root
- default base and target branch
- install/lint/test/build commands
- Agent rule files
- Agent id and task description

The server then:

1. verifies that the project is a Git repository inside `WORKSPACE_ROOT`
2. acquires an owner-aware project operation lock
3. resolves the base commit
4. creates a unique `agentport/...` branch
5. creates an isolated Worktree under `AGENTPORT_WORKTREES_DIR`
6. detects rule files such as `AGENTS.md`
7. persists session metadata atomically

Example:

```bash
agentport session create script2shorts \
  --agent codex-main \
  --task "Fix provider retries"
```

MCP tool: `remote_session_create`.

## Agent leases and active-session registry

Each session has:

```text
heartbeatAt
leaseExpiresAt
leaseActive
```

A heartbeat renews the lease:

```bash
agentport session heartbeat <session-id> --agent codex-main
```

Expired leases do not automatically delete Worktrees. They are surfaced as stale
so a human or cleanup workflow can decide whether to resume, inspect, or remove
the session.

## Project operation locks

Owner-aware lock files serialize operations that change repository-level Git
state:

- Worktree creation
- merge into the primary checkout
- Worktree removal
- branch deletion

Each lock records a random owner id, process id, acquisition time, and lease
metadata. A lock owned by a live operation cannot be reclaimed merely because a
fixed timestamp has passed. A lock is reclaimed only when its external owner
process is gone, or when a same-process lock is no longer registered as active
and its lease has expired. Release verifies the owner id before removing the
lock file. `AGENTPORT_PROJECT_LOCK_LEASE_MS` controls the recovery lease, not the
maximum duration of a valid operation.

Normal editing and builds in different Worktrees do not hold the project lock,
so parallel Agents remain possible.

## Running project workflows

Commands from `local/projects.json` are copied into session metadata at creation.
A session can run a named action:

```bash
agentport session run <session-id> test \
  --idempotency-key project:test:commit-a83f92
```

The development gateway submits the command to the existing persistent Job
service with:

- `cwd` forced to the session Worktree
- an idempotency key scoped to the authenticated client
- normal queue, timeout, resource-class, and log behavior
- the returned Job attached to the session registry

The command can also be supplied explicitly when no standard action exists.

## Resource ownership

Each Session and Job records the authenticated `clientId` that created it.
Normal client tokens can list, inspect, run, commit, rollback, merge, cancel, or
clean up only resources owned by that client. Other clients receive `403
EOWNER`, and list/overview responses omit resources owned by other clients.

Tokens configured through `ADMIN_TOKENS` receive an administrator authorization
context and may inspect or operate resources across clients. The administrator
identity is derived by the server from the token rather than trusted from a
caller-supplied client-id header.

## Status and Diff

Session status reports:

- branch and HEAD
- dirty file count
- short Git status
- lease state
- instruction files
- attached Job statuses

```bash
agentport session status <session-id>
agentport session diff <session-id>
```

The Diff response contains short status, Diff stat, unstaged Diff, staged Diff,
and truncation information. Output is bounded by `AGENTPORT_MAX_DIFF_BYTES`.
The subprocess helper waits for the ChildProcess `close` event, ensuring Git
stdout and stderr pipes have drained before results are returned.

## Commit

A session commit affects only its isolated branch:

```bash
agentport session commit <session-id> \
  --message "Fix provider retry handling"
```

The server uses argument-array Git execution rather than shell command
construction. By default all Worktree changes are added before commit. AgentPort
does not push automatically.

## Merge safety

Merge is intentionally stricter than commit. It requires:

- `confirm` exactly equal to the session id
- no active attached Jobs, unless explicitly forced
- a clean session Worktree
- a clean primary project checkout
- the primary checkout already on the requested target branch
- ownership by the authenticated client, or an administrator token

```bash
agentport session merge <session-id> \
  --confirm <session-id> \
  --target main
```

Supported strategies are `no-ff` (default) and `ff-only`.

AgentPort does not silently checkout another branch in the primary project. This
avoids replacing a user's current branch behind their back.

## Rollback safety

Rollback requires the session id as confirmation:

```bash
agentport session rollback <session-id> \
  --confirm <session-id>
```

Modes:

- `working-tree`: discard uncommitted changes and untracked files
- `base`: reset the isolated Agent branch to the session base commit

Rollback never resets the primary project checkout.

## Cleanup safety

Normal cleanup removes a clean Worktree. Force removal or branch deletion
requires explicit confirmation:

```bash
agentport session cleanup <session-id> \
  --confirm <session-id> \
  --delete-branch
```

Cleanup refuses to proceed while attached Jobs are running unless `force` is
explicitly supplied. Session metadata remains as an audit record after the
Worktree is removed.

## HTTP routes

The public development gateway owns:

- `GET /api/dev/overview`
- `GET|POST /api/dev/sessions`
- `GET /api/dev/sessions/:sessionId`
- `POST /api/dev/sessions/:sessionId/heartbeat`
- `POST /api/dev/sessions/:sessionId/run`
- `GET|POST /api/dev/sessions/:sessionId/diff`
- `POST /api/dev/sessions/:sessionId/commit`
- `POST /api/dev/sessions/:sessionId/rollback`
- `POST /api/dev/sessions/:sessionId/merge`
- `POST /api/dev/sessions/:sessionId/cleanup`

All development routes use the same daemon authentication and client-id
verification as file, execution, and Job APIs, plus owner/admin authorization
for resource operations.

## MCP tools

Phase 5 adds:

- `remote_development_overview`
- `remote_session_list`
- `remote_session_create`
- `remote_session_status`
- `remote_session_heartbeat`
- `remote_session_run`
- `remote_session_diff`
- `remote_session_commit`
- `remote_session_rollback`
- `remote_session_merge`
- `remote_session_cleanup`

Existing MCP tool names remain available.

## Validation

Tests cover:

- real Git repository and Worktree creation
- primary branch isolation
- rule-file discovery and lease renewal
- Diff generation and 50 rapid Diff/status reads
- explicit rollback confirmation
- commit on the Agent branch
- rejection when the primary checkout is dirty
- merge into the target branch
- Worktree and branch cleanup
- persistent Job attachment
- client-scoped idempotent retry
- MCP Session tool calls
- live project operations exceeding the recovery lease without lock theft
- dead-owner lock recovery
- owner/admin boundaries for Session and Job APIs
- two-client adversarial access attempts
- bounded ranged reads and bounded line scanning

Validation includes the spawned public Gateway components, Windows and Ubuntu
Node.js 20/22 matrices, persistent Job lifecycle tests, owner/admin
authorization boundaries, client-scoped Job idempotency, bounded ranged file
reads, and long-running project-lock contention.

Physical Windows + Debian gray validation completed for instant Jobs,
process-tree cleanup, clean dependency installation, credential redaction, and
the full Worktree Session lifecycle. Debian Session Service and Gateway repeated
runs passed, including 30/30 real Diff reads with non-empty status, branch, and
HEAD values.

## Remaining work

- a richer browser Dashboard over `/api/dev/overview`
- automatic stale-session cleanup policies
- push and pull-request helpers
- conflict-resolution workflows
- optional Streamable HTTP MCP transport
- production deployment and rollback execution after merge approval
