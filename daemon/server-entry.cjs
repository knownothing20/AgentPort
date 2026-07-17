#!/usr/bin/env node

// Public Phase 5 entrypoint.
// Starts the development-session gateway on the public port, the modular
// file/exec/job gateway on loopback, and the remaining legacy management
// service behind that modular gateway.
require("./development-gateway.cjs")
  .startDevelopmentGateway()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
