# AgentPort Daemon

This directory is the explicit **remote/server side** of AgentPort. It runs once
on the Linux development server and serves multiple local AgentPort clients.

## Public gateway and legacy compatibility

`server-entry.cjs` starts two cooperating processes:

```text
LAN / virtual-LAN clients
  -> public modular gateway (PORT, default 3183)
       -> daemon-core file, search, exec, and job services
       -> loopback-only legacy daemon for dashboard, config, and diagnostics
```

The legacy daemon binds to `127.0.0.1` on a dynamically selected internal port.
It is no longer exposed directly when the new source-tree entrypoint is used.
Unextracted paths are proxied to it without changing the public URLs.

## Routes owned by the modular gateway

### Files and search

- `/read` and `/api/fs/read`
- `/stat` and `/api/fs/stat`
- `/glob` and `/api/fs/glob`
- `/grep` and `/api/fs/grep`
- `/write` and `/api/fs/write`
- `/api/fs/read-bytes`
- `/api/fs/manifest`
- `/api/fs/remove` and `/api/fs/delete`

### Synchronous execution

- `/bash`
- `/api/exec`
- `/api/cmd/execute`
- `/api/exec/script`
- `/api/batch`

The execution service applies one shared command policy, workspace-bound working
directories, output limits, command timeouts, and a concurrency queue.

### Persistent jobs

- `GET|POST /api/jobs`
- `POST /api/jobs/start`
- `POST /api/exec/async`
- `GET|DELETE /api/jobs/:jobId`
- `GET /api/jobs/:jobId/logs`
- `POST /api/jobs/:jobId/cancel`
- `POST /api/jobs/:jobId/delete`
- `GET /api/task/:taskId`

Every new job runs in an independent detached Worker. Its metadata, result, and
stdout/stderr are stored on disk, so the public Gateway can restart without
losing the task.

## Idempotent job submission

Long-running tasks may be submitted with a stable key:

```http
POST /api/exec/async
Idempotency-Key: script2shorts:build:commit-a83f92
Content-Type: application/json

{
  "command": "pnpm build",
  "cwd": "/home/leon/projects/script2shorts"
}
```

Repeating the same key and parameters returns the existing `jobId` with
`reused: true`. Reusing the key with different parameters returns HTTP 409.
The body fields `idempotencyKey` and `key`, plus `X-Idempotency-Key`, are also
accepted for compatibility.

## Cursor-based job logs

The first log request returns stdout, stderr, and a cursor:

```text
GET /api/jobs/<job-id>/logs?maxBytes=65536
```

Continue from the returned position:

```text
GET /api/jobs/<job-id>/logs?cursor=<cursor>&maxBytes=65536
```

This avoids repeatedly downloading the complete log over a remote virtual LAN.
The older `tailBytes` and `bytes` parameters remain supported.

## Entrypoints

- `server-entry.cjs`: public modular gateway entrypoint.
- `modular-gateway.cjs`: extracted HTTP routes, auth compatibility, audit, and
  reverse proxy.
- `legacy-process.cjs`: starts and supervises the loopback legacy daemon.
- `config-loader.cjs`: reloadable `.env`, tokens, identity, workspace, execution,
  and job settings.
- `../packages/daemon-core/`: filesystem, command policy, execution queue,
  synchronous executor, persistent job store/service/Worker, and process-tree
  controls.
- `../server/`: legacy dashboard, config, diagnostics, and compatibility code.

## Start from the source tree

Install both dependency sets once:

```bash
npm install
npm --prefix server install
npm run start:daemon
```

Useful optional variables:

```bash
AGENTPORT_SERVER_ID=debian-main
AGENTPORT_WORKSPACE_ID=projects
AGENTPORT_PUBLIC_PORT=3183
AGENTPORT_LEGACY_PORT=3184

EXEC_MAX_CONCURRENCY=2
JOB_MAX_CONCURRENCY=2
JOB_DEFAULT_TIMEOUT_MS=1800000
```

If `AGENTPORT_LEGACY_PORT` is omitted, a free loopback port is selected.
See `.env.example` for the complete settings.

## Deployment compatibility

Existing installations that copy only `server/` continue to run the legacy
single-process daemon. They do not receive the modular services until the new
`daemon/`, `packages/daemon-core/`, and `server/` directories are deployed
together and `daemon/server-entry.cjs` becomes the service entrypoint.

The modular Job service reuses the existing `JOBS_DIR` by default. It can read
legacy job metadata and paths while all newly submitted jobs use detached
Workers, idempotency records, and cursor logs.

## Validation

```bash
npm run test:architecture
npm run test:gateway
npm run test:exec
npm run test:jobs
npm run test:lifecycle
```

Cross-platform tests cover the file gateway and synchronous execution on Windows
and Linux. Linux additionally validates detached Worker lifecycle, persistent
metadata, idempotency, cancellation, and cursor-based logs.
