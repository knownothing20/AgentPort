# Phase 2: Modular File Gateway

## Purpose

The new daemon entrypoint no longer delegates directly to the legacy Express
file. It starts a public gateway and moves the legacy daemon to a loopback-only
internal port:

```text
client -> modular gateway -> daemon-core file services
                         \-> legacy daemon compatibility proxy
```

The gateway owns read, stat, manifest, glob, grep, write, and guarded delete
routes. Job, exec, dashboard, config, and diagnostic routes remain available
through transparent proxying, so existing clients do not need new URLs.

## Extracted routes

The modular gateway handles:

- `POST /read`
- `POST /api/fs/read`
- `POST /stat`
- `POST /api/fs/stat`
- `POST /glob`
- `POST /api/fs/glob`
- `POST /grep`
- `POST /api/fs/grep`
- `POST /write`
- `POST /api/fs/write`
- `POST /api/fs/read-bytes`
- `POST /api/fs/manifest`
- `POST|DELETE /api/fs/remove`
- `POST|DELETE /api/fs/delete`

`GET /healthz` is augmented with the logical server identity, workspace identity,
gateway mode, and extracted filesystem capabilities.

## Remote-development improvements

- line-range text reads without changing `/api/fs/read`
- streamed line-range processing for large source and log files
- byte-range reads through `/api/fs/read-bytes`
- directory manifests through `/api/fs/manifest`
- symlink-safe built-in glob and grep
- verified atomic writes and ETag conflict responses
- stable `serverId` and `workspaceId` in `/healthz`
- shared authentication and audit behavior across the gateway and legacy daemon
- loopback-only exposure of the legacy compatibility process

## Compatibility model

The legacy daemon is intentionally retained during this phase. It continues to
own:

- command and script execution
- persistent jobs and logs
- dashboard and diagnostics
- token and config management
- existing compatibility endpoints not yet extracted

The public gateway proxies those requests without changing their paths, headers,
or response payloads.

## Running the new daemon entrypoint

```bash
npm install
npm --prefix server install
npm run start:daemon
```

Optional identity and port variables:

```bash
AGENTPORT_SERVER_ID=debian-main
AGENTPORT_WORKSPACE_ID=projects
AGENTPORT_PUBLIC_PORT=3183
AGENTPORT_LEGACY_PORT=3184
```

When the internal port is omitted, AgentPort selects an available loopback port.

## Validation

Run:

```bash
npm run test:gateway
```

The test covers config loading, internal process supervision, authentication,
legacy proxy behavior, streamed reads, byte ranges, manifests, glob, grep,
atomic writes, and ETag conflicts on Windows and Linux.
