# AgentPort Daemon

This directory is the explicit **remote/server side** of AgentPort. It runs once
on the Linux development server and serves multiple local AgentPort clients.

## Entrypoint

- `server-entry.cjs`: stable daemon facade. It currently delegates to
  `../server/server.js` so existing deployments remain valid.
- `../server/`: legacy deployment package, dashboard, manager scripts, and
  current production daemon implementation.
- `../packages/daemon-core/`: extracted path security, read service, write
  service, atomic writes, and keyed locking.

## Deployment compatibility

Existing deployments that copy only `server/` continue to work. New source-tree
usage can run:

```bash
npm run start:daemon
```

The next migration phase should move route groups from `server/server.js` into
small modules that consume `packages/daemon-core`, while keeping all current
HTTP paths as compatibility aliases.
