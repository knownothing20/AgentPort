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
2. acquires a short project operation lock
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

MCP:

```json
{
  "project": "script2shorts",
  "agentId": "codex-main",
  "task": "Fix provider retries"
}
```

Tool: `remote_session_create`.

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

Short-lived lock files serialize operations that change repository-level Git
state:

- Worktree creation
- merge into the primary checkout
- Worktree removal
- branch deletion

The lock contains a PID and expiry. A lock is reclaimed when its owner process is
gone or its expiry has passed. Normal editing and builds in different Worktrees
do not hold the project lock, so parallel Agents remain possible.

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
- one idempotency key
- normal queue, timeout, resource-class, and log behavior
- the returned Job attached to the session registry

The command can also be supplied explicitly when no standard action exists.

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

The Diff response contains:

- short branch/status output
- Diff stat
- unstaged Diff
- staged Diff
- truncation and byte information

Diff output is bounded by `AGENTPORT_MAX_DIFF_BYTES`.

## Commit

A session commit affects only its isolated branch:

```bash
agentport session commit <session-id> \
  --message "Fix provider retry handling"
```

The server uses argument-array Git execution rather than shell command
construction. By default all Worktree changes are added before commit. Author
name and email may be supplied explicitly.

AgentPort does not push automatically.

## Merge safety

Merge is intentionally stricter than commit. It requires:

- `confirm` exactly equal to the session id
- no active attached Jobs, unless explicitly forced
- a clean session Worktree
- a clean primary project checkout
- the primary checkout already on the requested target branch

Example:

```bash
agentport session merge <session-id> \
  --confirm <session-id> \
  --target main
```

Supported strategies:

- `no-ff` (default)
- `ff-only`

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
verification as file, execution, and Job APIs.

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
- rule-file discovery
- lease renewal
- Diff generation
- explicit rollback confirmation
- commit on the Agent branch
- rejection when the primary checkout is dirty
- merge into the target branch
- Worktree and branch cleanup
- persistent Job attachment
- client idempotent retry
- MCP Session tool calls

## Remaining work

Phase 5 provides the core APIs and workflow. Later product work may add:

- a richer browser Dashboard over `/api/dev/overview`
- automatic stale-session cleanup policies
- review/approval states before merge
- push and pull-request helpers
- conflict-resolution workflows
- optional Streamable HTTP MCP transport
