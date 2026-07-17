// Explicit remote/daemon entrypoint.
// Compatibility: delegates to the existing server implementation while daemon
// services are extracted into packages/daemon-core incrementally.
require("../server/server.js");
