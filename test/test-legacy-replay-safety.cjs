const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const ROOT = path.resolve(__dirname, "..");

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "cli.js"), ...args], {
      env: { ...process.env, ...env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentport-replay-safety-"));
  const connections = path.join(temp, "connections.json");
  const script = path.join(temp, "fixture.sh");
  const batch = path.join(temp, "batch.json");
  const files = new Map();
  let mode = "write-drop", writes = 0, jobStarts = 0, cleanupCalls = 0, sshConnections = 0, reads = 0;
  const sshTrap = net.createServer((socket) => { sshConnections++; socket.destroy(); });
  const daemon = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      const send = (value, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.url === "/api/fs/write") {
        if (mode === "denied") return send({ error: "workspace denied", code: "EWORKSPACE" }, 403);
        if (mode === "known-rejection") return send({ success: false, error: "queue full", code: "EQUEUE_FULL" }, 503);
        writes++;
        files.set(body.path, body.content);
        if (mode === "write-drop") return req.socket.destroy();
        return send({ success: true, etag: "fixture-etag" });
      }
      if (req.url === "/api/fs/read") {
        reads++;
        if (mode === "read-retry" && reads === 1) return req.socket.destroy();
        return send({ success: true, content: files.get(body.path) || "fixture content" });
      }
      if (req.url === "/api/jobs" && req.method === "POST") {
        jobStarts++;
        if (mode === "job-drop") return req.socket.destroy();
        return send({ success: true, jobId: "fixture-job", job: { id: "fixture-job", status: "running", exitCode: null } });
      }
      if (req.url === "/api/exec/script") { cleanupCalls++; return send({ success: true, code: 0 }); }
      if (req.url === "/api/batch") {
        for (const item of body.operations || []) {
          if (item.type === "write") { writes++; files.set(item.path, item.content); }
        }
        return req.socket.destroy();
      }
      return send({ error: "not found" }, 404);
    });
  });
  try {
    const sshPort = await listen(sshTrap), port = await listen(daemon);
    fs.writeFileSync(connections, JSON.stringify({ connections: [
      { name: "fixture", type: "daemon", url: `http://127.0.0.1:${port}`, authToken: "fixture-token", clientId: "fixture-client" },
      { name: "fixture-ssh", type: "ssh", host: "127.0.0.1", port: sshPort, username: "fixture", password: "fixture-password" },
    ], default: "fixture" }));
    fs.writeFileSync(script, "printf 'fixture'\n");
    const env = {
      AGENTPORT_LEGACY_CONNECTIONS_PATH: connections, AGENTPORT_SESSION_ID: "fixture-replay", MCP_REMOTE_TIMEOUT_MS: "1000",
      HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "127.0.0.1,localhost",
    };
    const common = ["--connection", "fixture", "--json"];
    const lostWrite = await run(["write", "/fixture/file.txt", "--file", script, ...common], env);
    assert.equal(writes, 1, "a delivered write with a lost response must not be repeated");
    assert.equal(sshConnections, 0, "a delivered mutation must not fall back to SSH");
    assert.equal(lostWrite.code, 1);
    assert.equal(JSON.parse(lostWrite.stdout).code, "EOUTCOME_UNKNOWN", lostWrite.stdout);

    mode = "job-drop";
    const lostJob = await run(["safe-job", script, "--cwd", "/fixture/project", ...common], env);
    assert.equal(jobStarts, 1, "unknown job submission must not be repeated");
    assert.equal(cleanupCalls, 0, "an accepted job's wrapper must not be deleted");
    assert.equal(sshConnections, 0);
    const error = JSON.parse(lostJob.stdout);
    assert.equal(error.code, "EOUTCOME_UNKNOWN");
    assert.ok(error.recovery.remoteWrapper);
    assert.ok(files.has(error.recovery.remoteWrapper));

    mode = "denied";
    const denied = await run(["write", "/fixture/file.txt", "--file", script, ...common], env);
    assert.equal(JSON.parse(denied.stdout).code, "EWORKSPACE");
    assert.equal(sshConnections, 0, "permission denial must not switch transports");
    mode = "known-rejection";
    const rejected = await run(["write", "/fixture/file.txt", "--file", script, ...common], env);
    assert.equal(JSON.parse(rejected.stdout).code, "EQUEUE_FULL", "an explicit remote failure must keep its code");
    fs.writeFileSync(batch, JSON.stringify([{ type: "write", path: "/fixture/batch.txt", content: "once" }, { type: "stat", path: "/fixture/batch.txt" }]));
    const beforeBatch = writes;
    const lostBatch = await run(["batch", batch, ...common], env);
    assert.equal(writes, beforeBatch + 1);
    assert.equal(JSON.parse(lostBatch.stdout).code, "EOUTCOME_UNKNOWN");
    assert.equal(sshConnections, 0);
    mode = "read-retry"; reads = 0;
    const read = await run(["read", "/fixture/file.txt", ...common], env);
    assert.equal(read.code, 0, read.stderr || read.stdout);
    assert.equal(reads, 2, "read-only bounded retry remains available");
    console.log("PASS legacy response-loss replay, wrapper retention, denial, and read-only retry");
  } finally {
    if (daemon.listening) await new Promise((resolve) => daemon.close(resolve));
    if (sshTrap.listening) await new Promise((resolve) => sshTrap.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
