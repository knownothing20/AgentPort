#!/usr/bin/env node

// Explicit remote/daemon entrypoint.
// Starts the modular file gateway on the public port and keeps the legacy daemon
// on a loopback-only internal port for jobs, dashboard, config, and compatibility.
require("./modular-gateway.cjs")
  .startAgentPortGateway()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
