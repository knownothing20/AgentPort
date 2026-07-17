const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

function findFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function probeHealth(origin, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const request = http.get(`${origin}/healthz`, { timeout: timeoutMs }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.on("timeout", () => { request.destroy(); resolve(false); });
    request.on("error", () => resolve(false));
  });
}

async function waitForLegacy(origin, { timeoutMs = 20_000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeHealth(origin)) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const error = new Error(`Legacy AgentPort daemon did not become ready at ${origin}`);
  error.code = "ELEGACY_START_TIMEOUT";
  throw error;
}

async function startLegacyProcess({
  entryPath = path.join(__dirname, "..", "server", "server.js"),
  cwd = path.dirname(entryPath),
  host = "127.0.0.1",
  port,
  env = process.env,
  stdio = "inherit",
} = {}) {
  const resolvedPort = Number(port) || await findFreePort(host);
  const origin = `http://${host}:${resolvedPort}`;
  const child = spawn(process.execPath, [entryPath], {
    cwd,
    env: { ...env, PORT: String(resolvedPort), BIND_HOST: host },
    stdio,
    windowsHide: true,
  });

  const childFailure = new Promise((_, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      reject(new Error(`Legacy AgentPort daemon exited before ready: code=${code} signal=${signal || ""}`));
    });
  });
  try {
    await Promise.race([waitForLegacy(origin), childFailure]);
  } catch (error) {
    try { child.kill("SIGTERM"); } catch {}
    throw error;
  }

  return {
    child,
    origin,
    host,
    port: resolvedPort,
    stop(signal = "SIGTERM") {
      if (child.exitCode === null && !child.killed) {
        try { child.kill(signal); } catch {}
      }
    },
  };
}

module.exports = {
  findFreePort,
  probeHealth,
  startLegacyProcess,
  waitForLegacy,
};
