const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const ROOT = path.resolve(__dirname, "..");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}
function close(server) { return new Promise((resolve) => server.close(resolve)); }
function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": payload.length });
  res.end(payload);
}

function runCli(args, env, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "client", "modular-cli.js"), ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agentport-mcp-v3-"));
  const connections = path.join(temp, "connections.v3.json");
  const projects = path.join(temp, "projects.json");
  const state = path.join(temp, "state.json");
  let receivedKey = null;
  let sessionCreateBody = null;

  const daemon = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch {}
      if (req.url === "/healthz") return sendJson(res, 200, {
        ok: true,
        serverId: "mcp-server",
        workspaceId: "mcp-workspace",
        workspaceRoot: "/srv/projects",
        capabilities: { persistentJobs: true, developmentSessions: true },
      });
      if (req.url === "/api/exec/async") {
        receivedKey = req.headers["idempotency-key"];
        return sendJson(res, 200, { success: true, jobId: "mcp-job", taskId: "mcp-job", status: "running" });
      }
      if (req.url === "/api/exec") {
        if (body.command === "empty-success") return sendJson(res, 200, { success: true, code: 0, stdout: "", stderr: "" });
        if (body.command === "timeout") return sendJson(res, 200, { success: false, code: "ETIMEDOUT", error: "Command timed out" });
        return sendJson(res, 200, { success: false, code: 7, stdout: "partial output", stderr: "failed" });
      }
      if (req.url === "/api/batch") {
        return sendJson(res, 200, { success: true, results: [{ type: "bash", status: 200, success: false, code: 9, stdout: "partial", stderr: "failed" }] });
      }
      if (/^\/api\/jobs\/job-(?:failed|missing|unknown)\/logs/.test(req.url)) {
        return sendJson(res, 200, { success: true, stdout: { content: "" }, stderr: { content: "" }, cursor: "done" });
      }
      if (req.url === "/api/jobs/job-failed") {
        return sendJson(res, 200, { success: true, job: { status: "error", exitCode: 7 } });
      }
      if (req.url === "/api/jobs/job-missing") {
        return sendJson(res, 200, { success: false, error: "missing job", jobId: "job-missing" });
      }
      if (req.url === "/api/jobs/job-unknown") {
        return sendJson(res, 200, { success: false, outcome: "unknown", code: "EOUTCOME_UNKNOWN", jobId: "job-unknown", status: "unknown" });
      }
      if (req.url === "/api/dev/sessions" && req.method === "POST") {
        sessionCreateBody = body;
        return sendJson(res, 200, { success: true, session: { id: "session-1", projectName: body.projectName, worktreePath: "/srv/worktrees/session-1", status: "active" } });
      }
      if (req.url === "/api/dev/sessions/session-1") {
        return sendJson(res, 200, { success: true, session: { id: "session-1", status: "active", git: { branch: "agentport/demo/codex" } } });
      }
      if (req.url === "/api/dev/sessions/session-1/diff") {
        return sendJson(res, 200, { success: true, diff: "demo patch" });
      }
      return sendJson(res, 404, { error: `not found ${req.url}`, body });
    });
  });
  const port = await listen(daemon);

  await fs.writeFile(connections, JSON.stringify({
    defaultServer: "mcp-server",
    servers: [{
      id: "mcp-server",
      workspaceId: "mcp-workspace",
      endpoints: [{
        id: "mcp-daemon",
        type: "daemon",
        url: `http://127.0.0.1:${port}`,
        clientId: "mcp-client",
        authToken: "secret",
        priority: 1,
      }],
    }],
  }, null, 2));
  await fs.writeFile(projects, JSON.stringify({
    projects: {
      demo: {
        server: "mcp-server",
        root: "/srv/projects/demo",
        defaultBranch: "main",
        commands: { build: "npm run build" },
        agentRules: ["AGENTS.md"],
      },
    },
  }, null, 2));

  const child = spawn(process.execPath, [path.join(ROOT, "client", "mcp-entry.js")], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENTPORT_CLIENT_MODE: "v3",
      MCP_REMOTE_V3_CONNECTIONS_PATH: connections,
      AGENTPORT_PROJECTS_PATH: projects,
      AGENTPORT_CLIENT_STATE_PATH: state,
    },
  });
  const pending = new Map();
  const stderr = [];
  let nextId = 1;
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(item.timer);
      item.resolve(message);
    }
  });
  readline.createInterface({ input: child.stderr }).on("line", (line) => stderr.push(line));

  function request(method, params) {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP timeout: ${method}\n${stderr.join("\n")}`));
      }, 15_000);
      pending.set(id, { resolve, reject, timer });
    });
  }

  try {
    const initialized = await request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "agentport-v3-test", version: "1.0" },
    });
    assert.equal(initialized.result.serverInfo.name, "agentport");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const listed = await request("tools/list", {});
    const names = listed.result.tools.map((tool) => tool.name);
    assert.ok(names.includes("remote_project_run"));
    assert.ok(names.includes("remote_job_logs"));
    assert.ok(names.includes("remote_session_create"));
    assert.ok(names.includes("remote_session_merge"));
    const asyncTool = listed.result.tools.find((tool) => tool.name === "remote_exec_async");
    assert.ok(asyncTool.inputSchema.properties.idempotencyKey);

    const health = await request("tools/call", { name: "remote_health", arguments: { server: "mcp-server", force: true } });
    const healthData = JSON.parse(health.result.content[0].text);
    assert.equal(healthData.server, "mcp-server");
    assert.equal(healthData.endpoints[0].health.serverId, "mcp-server");

    const started = await request("tools/call", {
      name: "remote_exec_async",
      arguments: { server: "mcp-server", command: "echo test", idempotencyKey: "mcp:key:1" },
    });
    const startedData = JSON.parse(started.result.content[0].text);
    assert.equal(startedData.data.jobId, "mcp-job");
    assert.equal(startedData.meta.idempotencyKey, "mcp:key:1");
    assert.equal(receivedKey, "mcp:key:1");
    assert.equal(started.result.isError, undefined, "accepted running Job remains a successful submission");

    const failedExec = await request("tools/call", {
      name: "remote_bash",
      arguments: { server: "mcp-server", command: "exit-seven" },
    });
    assert.equal(failedExec.result.isError, true);
    const failedExecValue = JSON.parse(failedExec.result.content[0].text);
    assert.equal(failedExecValue.data.code, 7);
    assert.equal(failedExecValue.data.stdout, "partial output");
    assert.equal(failedExecValue.data.stderr, "failed");

    const timedOutExec = await request("tools/call", {
      name: "remote_bash",
      arguments: { server: "mcp-server", command: "timeout" },
    });
    assert.equal(timedOutExec.result.isError, true);
    assert.equal(JSON.parse(timedOutExec.result.content[0].text).data.code, "ETIMEDOUT");

    const failedBatch = await request("tools/call", {
      name: "remote_batch",
      arguments: { server: "mcp-server", operations: [{ type: "bash", command: "exit-nine" }] },
    });
    assert.equal(failedBatch.result.isError, true);
    assert.equal(JSON.parse(failedBatch.result.content[0].text).data.results[0].code, 9);

    const emptySuccess = await request("tools/call", {
      name: "remote_bash",
      arguments: { server: "mcp-server", command: "empty-success" },
    });
    assert.equal(emptySuccess.result.isError, undefined);
    assert.equal(JSON.parse(emptySuccess.result.content[0].text).data.stdout, "");

    const created = await request("tools/call", {
      name: "remote_session_create",
      arguments: { project: "demo", agentId: "codex", task: "implement feature" },
    });
    const createdData = JSON.parse(created.result.content[0].text);
    assert.equal(createdData.data.session.id, "session-1");
    assert.equal(sessionCreateBody.projectRoot, "/srv/projects/demo");
    assert.equal(sessionCreateBody.commands.build, "npm run build");

    const status = await request("tools/call", {
      name: "remote_session_status",
      arguments: { sessionId: "session-1", server: "mcp-server" },
    });
    const statusData = JSON.parse(status.result.content[0].text);
    assert.equal(statusData.data.session.status, "active");

    const diff = await request("tools/call", {
      name: "remote_session_diff",
      arguments: { sessionId: "session-1", server: "mcp-server" },
    });
    const diffData = JSON.parse(diff.result.content[0].text);
    assert.equal(diffData.data.diff, "demo patch");

    const followedFailure = await runCli(
      ["job", "follow", "job-failed", "--server", "mcp-server", "--interval-ms", "200"],
      {
        AGENTPORT_CLIENT_MODE: "v3",
        AGENTPORT_CONNECTIONS_PATH: connections,
        AGENTPORT_CLIENT_STATE_PATH: state,
      },
    );
    assert.equal(followedFailure.code, 7, followedFailure.stderr || followedFailure.stdout);
    assert.match(followedFailure.stdout, /job job-failed: error/);

    const missingJobQuery = await runCli(
      ["job", "follow", "job-missing", "--server", "mcp-server", "--interval-ms", "200"],
      {
        AGENTPORT_CLIENT_MODE: "v3",
        AGENTPORT_CONNECTIONS_PATH: connections,
        AGENTPORT_CLIENT_STATE_PATH: state,
      },
      3000,
    );
    assert.equal(missingJobQuery.timedOut, false, "failed HTTP-200 status queries must stop polling");
    assert.equal(missingJobQuery.code, 1);
    assert.match(missingJobQuery.stdout, /"jobId": "job-missing"/);
    assert.match(missingJobQuery.stdout, /"error": "missing job"/);
    assert.doesNotMatch(missingJobQuery.stdout, /job job-missing: (?:completed|running)/);

    const unknownJobQuery = await runCli(
      ["job", "follow", "job-unknown", "--server", "mcp-server", "--interval-ms", "200"],
      {
        AGENTPORT_CLIENT_MODE: "v3",
        AGENTPORT_CONNECTIONS_PATH: connections,
        AGENTPORT_CLIENT_STATE_PATH: state,
      },
      3000,
    );
    assert.equal(unknownJobQuery.timedOut, false, "unknown outcomes must stop polling");
    assert.equal(unknownJobQuery.code, 1);
    assert.match(unknownJobQuery.stdout, /"jobId": "job-unknown"/);
    assert.match(unknownJobQuery.stdout, /"outcome": "unknown"/);
    assert.doesNotMatch(unknownJobQuery.stdout, /job job-unknown: (?:completed|running)/);

    const runningStart = await runCli(
      ["job", "start", "still-running", "--server", "mcp-server", "--json"],
      {
        AGENTPORT_CLIENT_MODE: "v3",
        AGENTPORT_CONNECTIONS_PATH: connections,
        AGENTPORT_CLIENT_STATE_PATH: state,
      },
    );
    assert.equal(runningStart.code, 0, runningStart.stderr || runningStart.stdout);
    assert.equal(JSON.parse(runningStart.stdout).status, "running");

    const failedStatus = await runCli(
      ["job", "status", "job-failed", "--server", "mcp-server", "--json"],
      {
        AGENTPORT_CLIENT_MODE: "v3",
        AGENTPORT_CONNECTIONS_PATH: connections,
        AGENTPORT_CLIENT_STATE_PATH: state,
      },
    );
    assert.equal(failedStatus.code, 7);
    const failedStatusValue = JSON.parse(failedStatus.stdout);
    assert.equal(failedStatusValue.job.status, "error");
    assert.equal(failedStatusValue.job.exitCode, 7);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    await close(daemon);
    await fs.rm(temp, { recursive: true, force: true });
  }
  console.log("PASS modular MCP tools, idempotent Jobs, and Worktree session calls");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
