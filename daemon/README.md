# AgentPort Daemon

This directory is the explicit **remote/server side** of AgentPort. It runs once
on the Linux development server and serves multiple local AgentPort clients.

## Public gateway and legacy compatibility

`server-entry.cjs` now starts two cooperating processes:

```text
LAN / virtual-LAN clients
  -> public modular gateway (PORT, default 3183)
       -> daemon-core file APIs
       -> loopback-only legacy daemon for jobs, exec, dashboard, and config
```

The legacy daemon binds to `127.0.0.1` on a dynamically selected internal port.
It is no longer exposed directly when the new source-tree entrypoint is used.

The modular gateway currently owns:

- `/read` and `/api/fs/read`
- `/stat` and `/api/fs/stat`
- `/glob` and `/api/fs/glob`
- `/grep` and `/api/fs/grep`
- `/write` and `/api/fs/write`
- `/api/fs/read-bytes`
- `/api/fs/manifest`
- `/api/fs/remove` and `/api/fs/delete`
- `/healthz` capability and server/workspace identity augmentation

Every other HTTP path is proxied unchanged to `../server/server.js`.

## Entrypoints

- `server-entry.cjs`: public modular gateway entrypoint.
- `modular-gateway.cjs`: file-route handlers, auth compatibility, audit, and
  reverse proxy.
- `legacy-process.cjs`: starts and supervises the loopback legacy daemon.
- `config-loader.cjs`: reloadable `.env`, token, server identity, and workspace
  configuration.
- `../server/`: legacy daemon, dashboard, manager scripts, and compatibility
  implementation.
- `../packages/daemon-core/`: path security, read/search/write services, atomic
  writes, and keyed locking.

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
```

If `AGENTPORT_LEGACY_PORT` is omitted, a free loopback port is selected.

## Deployment compatibility

Existing installations that copy only `server/` continue to run the legacy
single-process daemon. They do not receive the modular file gateway until the
new `daemon/`, `packages/daemon-core/`, and `server/` directories are deployed
together and `daemon/server-entry.cjs` becomes the service entrypoint.

This staged model keeps current MCP tools, CLI commands, HTTP paths, jobs, and
dashboard behavior compatible while route groups are extracted incrementally.

## Validation

```bash
npm run test:gateway
```

The gateway test uses only Node.js built-ins and runs on Windows and Linux.
