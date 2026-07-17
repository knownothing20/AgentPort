#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createAgentPortGateway } = require("./daemon/modular-gateway.cjs");

function shellArg(value) {
  const text = String(value);
  if (process.platform === "win32") return `"${text.replace(/"/g, '""')}"`;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}
function listen(server) { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); }); }
function close(server) { return new Promise((resolve) => server.close(resolve)); }
async function waitFor(fn, timeoutMs = 10_000) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Timed out waiting for gateway job"); }

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentport-daemon-jobs-"));
  const legacy = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/healthz") res.end(JSON.stringify({ ok: true, legacy: true }));
    else res.end(JSON.stringify({ legacyPath: req.url }));
  });
  const legacyPort = await listen(legacy);
  const config = {
    workspaceRoot: root,
    jobsDir: path.join(root, ".jobs"),
    serverId: "server-test",
    workspaceId: "workspace-test",
    auditLogPath: path.join(root, "audit.log"),
    tokenClientMap: new Map([["token", "client"]]),
    adminTokens: new Set(),
    dashboardEnabled: false,
    values: { PORT: "0", BIND_HOST: "127.0.0.1" },
    command: { allowExec: true, allowedCommands: "", allowedInterpreters: "" },
    exec: { timeoutMs: 5000, maxTimeoutMs: 60_000, maxConcurrency: 2, queueTimeoutMs: 500, maxBufferBytes: 1024 * 1024 },
    jobs: { maxConcurrency: 1, queueTimeoutMs: 500, defaultTimeoutMs: 5000, maxTimeoutMs: 60_000, logChunkBytes: 4096 },
  };
  const configLoader = { load: async () => config, setWorkspaceRoot() {}, clearWorkspaceRootOverride() {} };
  const gateway = createAgentPortGateway({ legacyOrigin: `http://127.0.0.1:${legacyPort}`, configLoader });
  const gatewayPort = await listen(gateway);
  const base = `http://127.0.0.1:${gatewayPort}`;
  const headers = { authorization: "Bearer token", "x-mcp-client-id": "client", "content-type": "application/json" };

  try {
    let response = await fetch(`${base}/healthz`);
    let body = await response.json();
    assert.equal(body.capabilities.modularExec, true);
    assert.equal(body.capabilities.idempotentJobs, true);
    assert.equal(body.capabilities.cursorJobLogs, true);

    const execScript = path.join(root, "exec.cjs");
    await fs.writeFile(execScript, "process.stdout.write('exec-ok')\n", "utf8");
    response = await fetch(`${base}/api/exec`, { method: "POST", headers, body: JSON.stringify({ command: `${shellArg(process.execPath)} ${shellArg(execScript)}`, cwd: root }) });
    body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.stdout, "exec-ok");

    const jobScript = path.join(root, "job.cjs");
    await fs.writeFile(jobScript, "console.log('gateway-job')\n", "utf8");
    const jobCommand = `${shellArg(process.execPath)} ${shellArg(jobScript)}`;
    response = await fetch(`${base}/api/exec/async`, { method: "POST", headers: { ...headers, "idempotency-key": "gateway-job" }, body: JSON.stringify({ command: jobCommand, cwd: root }) });
    body = await response.json();
    const jobId = body.jobId;
    assert.ok(jobId);

    response = await fetch(`${base}/api/exec/async`, { method: "POST", headers: { ...headers, "idempotency-key": "gateway-job" }, body: JSON.stringify({ command: jobCommand, cwd: root }) });
    body = await response.json();
    assert.equal(body.reused, true);
    assert.equal(body.jobId, jobId);

    const task = await waitFor(async () => {
      const value = await fetch(`${base}/api/task/${jobId}`, { headers }).then((result) => result.json());
      return value.status === "completed" ? value : null;
    });
    assert.match(task.stdout, /gateway-job/);

    response = await fetch(`${base}/api/jobs/${jobId}/logs`, { headers });
    body = await response.json();
    assert.ok(body.cursor);
    assert.match(body.stdout.content, /gateway-job/);

    response = await fetch(`${base}/legacy-route`, { headers });
    body = await response.json();
    assert.equal(body.legacyPath, "/legacy-route");

    console.log("PASS daemon exec jobs");
  } finally {
    await close(gateway);
    await close(legacy);
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
