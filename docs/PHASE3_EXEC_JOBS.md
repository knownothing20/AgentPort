# Phase 3: Modular Execution and Durable Jobs

## Scope

Phase 3 moves command execution and persistent jobs out of the legacy daemon
without changing the public HTTP paths used by MCP and CLI clients.

```text
AgentPort Client
  -> public modular gateway
       -> synchronous execution service
       -> persistent job service
       -> loopback legacy daemon for dashboard/config/diagnostics
```

## Extracted execution components

### `command-policy.cjs`

One shared policy validates:

- whether command execution is enabled
- optional command allowlists
- shell-metacharacter bypass attempts in allowlist mode
- allowed script interpreters

The synchronous executor, batch executor, and persistent Job service all use the
same policy.

### `execution-queue.cjs`

The queue provides:

- configurable maximum concurrency
- bounded queue waiting
- HTTP 429-compatible overload errors
- live `running`, `max`, and `queued` statistics

This prevents several AI sessions from starting expensive commands at the same
time on a small development server.

### `exec-service.cjs`

The service owns synchronous command and script execution:

- workspace-bound working directories
- configurable timeouts
- stdout/stderr size limits
- process-tree cleanup on timeout
- Windows hidden execution
- temporary script cleanup

## Durable Job architecture

Every newly submitted Job uses a directory under `JOBS_DIR`:

```text
jobs/<job-id>/
  meta.json
  result.json
  worker.json
  stdout.log
  stderr.log
```

`meta.json` is written before the Worker starts. The detached Worker then starts
the real command, streams output to disk, and writes `result.json` exactly once
when the task finishes, times out, or is cancelled.

The Gateway does not need to keep the command's ChildProcess object in memory.
After a Gateway restart it reloads metadata, checks the Worker PID and result
file, and reconstructs the public Job state.

## Legacy Job compatibility

The modular service reuses the existing `JOBS_DIR` by default. It supports old
metadata fields and paths, including legacy `pid`, `stdoutPath`, and
`stderrPath` values. This allows old and new Job directories to remain visible
during staged deployment.

New Jobs use `workerPid`, persistent result files, cursor logs, and idempotency
records.

## Idempotency

A client can supply a key through:

- `Idempotency-Key`
- `X-Idempotency-Key`
- JSON body `idempotencyKey`
- JSON body `key`

The server stores only a SHA-256 key hash with the Job reference. Repeating the
same key and normalized parameters returns the original Job. Reusing the same
key for a different command, working directory, timeout, or resource class
returns HTTP 409.

This is important for remote networks where a client may lose the response after
the server has already accepted a long-running build.

## Cursor-based logs

Each log response includes a cursor containing stdout and stderr byte offsets.
The next request sends that cursor and receives only newly appended data.

```text
GET /api/jobs/<id>/logs?maxBytes=65536
GET /api/jobs/<id>/logs?cursor=<cursor>&maxBytes=65536
```

Older tail-based requests remain supported.

## Public route compatibility

The modular Gateway now owns:

- `/bash`
- `/api/exec`
- `/api/cmd/execute`
- `/api/exec/script`
- `/api/batch`
- `/api/exec/async`
- `/api/jobs` and `/api/jobs/start`
- `/api/jobs/:jobId`
- `/api/jobs/:jobId/logs`
- `/api/jobs/:jobId/cancel`
- `/api/jobs/:jobId/delete`
- `/api/task/:taskId`

Existing MCP tools continue using the same paths. For compatibility,
`/api/task/:taskId` maps timeout, cancellation, and orphan states to the old
terminal `error` status while also returning the more specific
`terminalStatus`.

## Validation

Cross-platform tests validate:

- command policy and allowlist bypass prevention
- execution queue saturation
- synchronous command execution
- script interpreter execution
- Gateway execution compatibility

Linux tests additionally validate:

- detached Worker lifecycle
- persisted Job state
- Job cancellation
- idempotent submission and conflict detection
- cursor-based incremental logs
- `/api/task` compatibility

## Remaining work

The next phase moves client responsibilities out of the large root files:

- daemon HTTP transport
- SSH transport
- immutable per-call request context
- logical server endpoint selection in live MCP calls
- idempotency-key support in MCP and CLI interfaces
- project commands and task Worktrees
