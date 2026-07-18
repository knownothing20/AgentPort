#!/usr/bin/env node

// Public Phase 5 entrypoint.
// Starts the development-session gateway on the public port, the modular
// file/exec/job gateway on loopback, and the remaining legacy management
// service behind that modular gateway. The safe wrapper sanitizes command
// metadata before development-session responses leave the daemon.
require("./development-gateway-safe.cjs")
  .startDevelopmentGateway()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
