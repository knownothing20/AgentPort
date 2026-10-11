const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..");
const brokerToken = "synthetic-local-broker-secret";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}
function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
function json(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}
async function body(req) {
  const parts = [];
  for await (const part of req) parts.push(part);
  return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
}

async function testPolicy() {
  const { recoverBrokerCall, replaySafeTool, replaySafePost, normalizeToolResult } = await import(pathToFileURL(path.join(ROOT, "packages/client-core/mcp-recovery.js")));
  assert.equal(replaySafeTool("remote_batch", { operations: [{ type: "read" }] }), true);
  assert.equal(replaySafeTool("remote_batch", { operations: [{ type: "bash" }] }), false);
  assert.equal(replaySafePost(["/api/exec"]), false);
  assert.equal(replaySafePost(["/api/fs/read", "/read"]), true);
  const oldBroker = { url: "http://127.0.0.1:1", token: "old" };
  for (const operation of ["remote_write", "remote_script", "remote_bash", "remote_exec_async", "remote_script_async"]) {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EPIPE"]) {
      let sent = 0;
      let fallback = 0;
      await assert.rejects(recoverBrokerCall({
        operation, args: {}, broker: oldBroker,
        request: async () => { sent++; throw Object.assign(new Error("lost reply"), { code }); },
        refresh: () => null, invalidate: () => {}, warn: () => {}, fallback: () => { fallback++; },
      }), { code: "EOUTCOME_UNKNOWN", outcome: "unknown", retryable: false });
      assert.equal(sent, 1);
      assert.equal(fallback, 0);
    }
  }
  const replacement = { url: "http://127.0.0.1:2", token: "new" };
  const requested = [];
  assert.equal(await recoverBrokerCall({
    operation: "remote_write", args: {}, broker: oldBroker,
    request: async (broker) => {
      requested.push(broker.url);
      if (broker === oldBroker) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      return "replacement";
    },
    refresh: () => replacement, invalidate: () => {}, warn: () => {},
    fallback: () => { throw new Error("unexpected fallback"); },
  }), "replacement");
  assert.deepEqual(requested, [oldBroker.url, replacement.url]);
  const text = { content: [{ type: "text", text: '{"error":"document contents"}' }] };
  assert.equal(normalizeToolResult("remote_read", text).isError, undefined);
  assert.equal(normalizeToolResult("remote_config", text).isError, true);
}

async function fixture(options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "agentport-mcp-recovery-"));
  const logs = path.join(base, "test-logs");
  const runtime = path.join(base, "local/runtime");
  const counts = { exec: 0, read: 0, write: 0, broker: 0, brokerEffect: 0, cleanup: 0 };
  const state = { brokerMode: "ok", execMode: "ok", scriptMode: "ok", asyncMode: "queued", taskStatus: "error" };
  const servers = [];
  let child;
  const pending = new Map();
  const terminalLogs = [];
  const returnedCalls = [];
  let nextId = 0;
  await fs.mkdir(runtime, { recursive: true });
  await fs.mkdir(path.join(base, "packages/client-core"), { recursive: true });
  for (const file of ["index.js", "logger.js", "ssh-client.js", "ssh-scanner.js", "cli-lifecycle.js"]) {
    await fs.copyFile(path.join(ROOT, file), path.join(base, file));
  }
  await fs.copyFile(path.join(ROOT, "packages/client-core/mcp-recovery.js"), path.join(base, "packages/client-core/mcp-recovery.js"));
  await fs.writeFile(path.join(base, "package.json"), JSON.stringify({ name: "agentport", version: "3.1.0", type: "module" }));
  await fs.symlink(path.join(ROOT, "node_modules"), path.join(base, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const daemon = http.createServer(async (req, res) => {
    const value = await body(req);
    if (req.url === "/healthz") return json(res, { ok: true, workspaceRoot: "/workspace" });
    if (req.url === "/api/fs/read") {
      counts.read++;
      return json(res, { content: value.path?.includes("agentport-async-") ? state.lastUpload : "Error: ordinary document text", etag: "fixture-etag" });
    }
    if (req.url === "/api/fs/write") { counts.write++; state.lastUpload = value.content; return json(res, { success: true }); }
    if (req.url === "/api/exec") {
      counts.exec++;
      if (state.execMode === "reset") return req.socket.destroy();
      return json(res, { stdout: "local", code: state.execMode === "exit" ? 7 : 0 });
    }
    if (req.url === "/api/exec/script") {
      if (String(value.content).startsWith("rm -f")) counts.cleanup++;
      else counts.exec++;
      if (state.scriptMode === "reset") return req.socket.destroy();
      return json(res, { stdout: "script", code: 0 });
    }
    if (req.url === "/api/exec/async") {
      counts.exec++;
      if (state.asyncMode === "reset") return req.socket.destroy();
      if (state.asyncMode === "missing") return json(res, { status: "queued" });
      return json(res, { taskId: "fixture-job", status: "queued" });
    }
    if (req.url === "/api/task/fixture-job") return json(res, { id: "fixture-job", status: state.taskStatus, ...(["error", "completed"].includes(state.taskStatus) ? { exitCode: 7, stderr: "fixture failure" } : {}) });
    if (req.url === "/api/batch") return json(res, { success: true, results: [{ type: "read", path: "/workspace/missing", status: 403, error: "fixture denied" }] });
    json(res, { error: "unsupported fixture route" }, 404);
  });
  servers.push(daemon);
  const daemonUrl = await listen(daemon);
  await fs.writeFile(path.join(base, "local/connections.json"), JSON.stringify({ default: "fixture", connections: [
    { name: "fixture", type: "daemon", url: daemonUrl, clientId: "fixture-client", authToken: "fixture-token" },
    ...(options.multiple ? [{ name: "other", type: "daemon", url: daemonUrl, clientId: "other-client", authToken: "other-fixture-token" }] : []),
  ] }));
  const broker = http.createServer(async (req, res) => {
    if (req.url === "/health") return json(res, { ok: true });
    const value = await body(req);
    counts.broker++;
    if (state.brokerMode === "reset") { counts.brokerEffect++; return req.socket.destroy(); }
    if (state.brokerMode === "denied") return json(res, { error: "fixture denied" }, 401);
    if (state.brokerMode === "error") return json(res, { isError: true, content: [{ type: "text", text: "fixture broker tool failed" }] });
    if (req.url === "/mcp-tools") return json(res, { tools: [] });
    json(res, { content: [{ type: "text", text: "broker-ok" }] });
  });
  servers.push(broker);
  const brokerUrl = await listen(broker);
  const lock = path.join(runtime, "instance-fixture-client.lock.json");
  async function publishBroker(url, token = brokerToken) {
    await fs.writeFile(lock, JSON.stringify({ pid: process.pid, sessionId: "fixture-owner", broker: { url, token } }));
  }
  await publishBroker(brokerUrl);
  const stderr = [];
  function request(method, params) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`fixture MCP timeout: ${method}`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  try {
    child = spawn(process.execPath, [path.join(base, "index.js")], {
      cwd: base, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", MCP_REMOTE_URL: daemonUrl, MCP_REMOTE_CLIENT_ID: "fixture-client", MCP_REMOTE_AUTH_TOKEN: "fixture-token", MCP_REMOTE_INSTANCE_KEY: "fixture-client", MCP_REMOTE_LOG_DIR: logs, MCP_REMOTE_LOG_DATA_MAX_BYTES: "64000", MCP_REMOTE_TIMEOUT_MS: "2000", MCP_REMOTE_LOG_TOOL_SUCCESS: "0", MCP_REMOTE_LOG_TOOL_START: "1" },
    });
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      let value;
      try { value = JSON.parse(line); } catch { return; }
      const item = pending.get(value.id);
      if (item) { clearTimeout(item.timer); pending.delete(value.id); value.error ? item.reject(new Error(value.error.message)) : item.resolve(value.result); }
    });
    readline.createInterface({ input: child.stderr }).on("line", (line) => stderr.push(line));
    await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "recovery-fixture", version: "1" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    return {
      base, logs, broker, counts, state, publishBroker, servers, terminalLogs, returnedCalls, stderr,
      async call(name, args = {}) {
        const result = await request("tools/call", { name, arguments: { connection: "fixture", ...args } });
        returnedCalls.push({ name, isError: Boolean(result.isError), unknown: result.structuredContent?.code === "EOUTCOME_UNKNOWN" });
        return result;
      },
      async implicitCall(name, args = {}) {
        const result = await request("tools/call", { name, arguments: args });
        returnedCalls.push({ name, isError: Boolean(result.isError), unknown: result.structuredContent?.code === "EOUTCOME_UNKNOWN" });
        return result;
      },
      list: () => request("tools/list", {}),
      async useSsh({ disconnect = false, signal } = {}) {
        const { Server } = require("ssh2");
        const { generateKeyPairSync } = require("node:crypto");
        const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
        const clients = new Set();
        const commands = [];
        const ssh = new Server({ hostKeys: [key] }, (client) => {
          clients.add(client);
          client.on("error", () => {});
          client.on("close", () => clients.delete(client));
          client.on("authentication", (ctx) => ctx.accept());
          client.on("ready", () => client.on("session", (accept) => {
            const session = accept();
            session.on("sftp", (acceptSftp) => { acceptSftp(); });
            session.on("exec", (acceptExec, _reject, info) => {
              const stream = acceptExec();
              stream.on("error", () => {});
              commands.push(info.command);
              if (disconnect) client.destroy();
              else if (signal) { stream.exit(signal); stream.end(); }
              // Model an operation accepted by SSH whose completion is unknown.
            });
          }));
        });
        await listen(ssh);
        await fs.writeFile(path.join(base, "local/connections.json"), JSON.stringify({ default: "ssh-fixture", connections: [{ name: "ssh-fixture", type: "ssh", host: "127.0.0.1", port: ssh.address().port, username: "fixture", password: "fixture-password", execTimeoutMs: 100 }] }));
        let listening = true;
        servers.push({ get listening() { return listening; }, close(callback) { for (const client of clients) client.end(); return ssh.close((error) => { listening = false; callback(error); }); } });
        return commands;
      },
      async shutdown() {
        child.stdin.end();
        await new Promise((resolve, reject) => {
          if (child.exitCode !== null) return resolve();
          const timer = setTimeout(() => { child.kill(); reject(new Error("fixture MCP did not close")); }, 4000);
          child.once("close", () => { clearTimeout(timer); resolve(); });
        });
        for (const server of servers) await close(server);
      },
    };
  } catch (error) {
    child?.kill();
    for (const server of servers) await close(server);
    await fs.rm(base, { recursive: true, force: true });
    throw error;
  }
}

async function withFixture(run, options) {
  const f = await fixture(options);
  let failure;
  try { await run(f); }
  catch (error) {
    failure = error;
    error.stack += `\nFixture counts: ${JSON.stringify(f.counts)}\nFixture stderr: ${f.stderr.join("\n")}`;
    throw error;
  }
  finally {
    await f.shutdown();
    const files = await fs.readdir(f.logs);
    let log = "";
    for (const file of files.filter((name) => name.endsWith(".log"))) log += await fs.readFile(path.join(f.logs, file), "utf8");
    const rows = [...log.matchAll(/^\[([^\]]+)\] \[(\w+)\] \[([^\]]+)\] ([\s\S]*?)\n  Data: ([^\n]+)$/gm)];
    for (const row of rows) {
      if (/^(?:Completed|Failed|Slow) call/.test(row[4])) {
        f.terminalLogs.push({ tool: row[3], message: row[4], ...JSON.parse(row[5]) });
      }
    }
    try {
      if (!failure) {
      assert.ok(!log.includes(brokerToken), "broker token must not appear in local logs");
      assert.match(log, /Completed call|Failed call/);
      assert.equal(f.terminalLogs.length, f.returnedCalls.length, "every tool return must have one terminal event");
      for (let i = 0; i < f.returnedCalls.length; i++) {
        const expected = f.returnedCalls[i];
        const actual = f.terminalLogs[i];
        assert.equal(actual.tool, expected.name);
        assert.equal(actual.callOutcome, expected.unknown ? "unknown" : expected.isError ? "failed" : "succeeded");
      }
      for (const row of f.terminalLogs) {
        assert.ok(row.originCallId, "terminal events must include origin-call identity");
        if (row.message.startsWith("Failed call")) assert.ok(["failed", "unknown"].includes(row.callOutcome));
        if (row.tool === "remote_exec_async" && row.executionStatus === "queued") {
          assert.equal(row.outcome, "submitted");
          assert.equal(row.callOutcome, "succeeded");
          assert.equal(row.taskId, "fixture-job");
        }
        if (row.tool === "remote_task" && row.executionStatus === "running") {
          assert.equal(row.outcome, "pending");
          assert.equal(row.taskId, "fixture-job");
        }
      }
      }
    } finally {
      assert.equal(path.dirname(f.base), os.tmpdir());
      await fs.rm(f.base, { recursive: true, force: true });
    }
  }
}

async function main() {
  await testPolicy();
  await withFixture(async (f) => {
    await close(f.broker);
    let result = await f.call("remote_bash", { command: "fixture-noop" });
    assert.ok(!result.isError, JSON.stringify(result));
    result = await f.call("remote_bash", { command: "fixture-noop" });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.equal(f.counts.exec, 2);
    assert.equal(f.counts.broker, 0);
    const raw = (await fs.readdir(f.logs)).filter((name) => name.endsWith(".log"));
    let warnings = "";
    for (const file of raw) warnings += await fs.readFile(path.join(f.logs, file), "utf8");
    assert.equal((warnings.match(/Proxy broker invalidated;/g) || []).length, 1);
    f.state.execMode = "exit";
    assert.equal((await f.call("remote_bash", { command: "fixture-fail" })).isError, true);
    f.state.execMode = "reset";
    const before = f.counts.exec;
    result = await f.call("remote_bash", { command: "fixture-once" });
    assert.equal(result.structuredContent.code, "EOUTCOME_UNKNOWN");
    assert.equal(f.counts.exec, before + 1, "daemon mutation must not be retried");
    f.state.execMode = "ok";
    assert.equal((await f.call("remote_read", { path: "/workspace/file.txt" })).isError, undefined);
    assert.equal((await f.call("remote_task", { taskId: "fixture-job" })).isError, true);
    assert.ok(!(await f.call("remote_exec_async", { command: "fixture-job" })).isError);
    f.state.taskStatus = "running";
    assert.ok(!(await f.call("remote_task", { taskId: "fixture-job" })).isError);
    assert.equal((await f.call("remote_batch", { operations: [{ type: "read", path: "/workspace/missing" }] })).isError, true);
    f.state.asyncMode = "reset";
    const cleanup = f.counts.cleanup;
    result = await f.call("remote_script_async", { content: "fixture-script", cwd: "/workspace" });
    assert.equal(result.structuredContent.code, "EOUTCOME_UNKNOWN");
    assert.equal(f.counts.cleanup, cleanup, "uncertain job submission must preserve its wrapper");
    f.state.asyncMode = "missing";
    result = await f.call("remote_exec_async", { command: "fixture-job" });
    assert.equal(result.structuredContent.code, "EOUTCOME_UNKNOWN");
  });
  await withFixture(async (f) => {
    f.state.brokerMode = "reset";
    const result = await f.call("remote_script", { content: "fixture-once", cwd: "/workspace" });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, "EOUTCOME_UNKNOWN");
    assert.equal(f.counts.brokerEffect, 1);
    assert.equal(f.counts.exec, 0, "ambiguous broker reply must never trigger local execution");
  });
  await withFixture(async (f) => {
    f.state.brokerMode = "denied";
    assert.equal((await f.call("remote_write", { path: "/workspace/file.txt", content: "fixture" })).isError, true);
    assert.equal(f.counts.write, 0, "broker permission denial must not bypass to local execution");
    f.state.brokerMode = "error";
    assert.equal((await f.call("remote_script", { content: "fixture" })).isError, true);
  });
  await withFixture(async (f) => {
    f.state.brokerMode = "reset";
    const result = await f.call("remote_read", { path: "/workspace/file.txt" });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.equal(f.counts.read, 1);
    assert.equal(f.counts.exec, 0);
    await f.call("remote_read", { path: "/workspace/file.txt" });
    assert.equal(f.counts.broker, 1, "a cleared broker must not be retried by the next read");
  });
  await withFixture(async (f) => {
    await close(f.broker);
    await f.call("remote_read", { path: "/workspace/file.txt" });
    await close(f.servers[0]);
    const result = await f.call("remote_script", { content: "fixture" });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, "ECONNREFUSED", "confirmed-unsent envelope must not be mislabeled UNKNOWN");
  });
  await withFixture(async (f) => {
    await close(f.broker);
    const replacement = http.createServer(async (req, res) => { await body(req); json(res, { content: [{ type: "text", text: "replacement-broker" }] }); });
    f.servers.push(replacement);
    await f.publishBroker(await listen(replacement), "synthetic-replacement-token");
    const result = await f.call("remote_bash", { command: "fixture-noop" });
    assert.equal(result.content[0].text, "replacement-broker");
    assert.equal(f.counts.exec, 0);
  });
  await withFixture(async (f) => {
    await close(f.broker);
    await f.list();
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await f.implicitCall("remote_read", { path: "/workspace/file.txt" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /explicit connection/);
    }
    assert.equal(f.counts.read, 0);
    assert.ok(!(await f.call("remote_connect")).isError);
    assert.ok(!(await f.implicitCall("remote_read", { path: "/workspace/file.txt" })).isError);
    assert.equal(f.counts.read, 1);
  }, { multiple: true });
  await withFixture(async (f) => {
    await close(f.broker);
    const commands = await f.useSsh();
    const result = await f.call("remote_batch", { connection: "ssh-fixture", operations: [{ type: "bash", command: "first-effect" }, { type: "bash", command: "must-not-run" }] });
    assert.equal(result.structuredContent.code, "EOUTCOME_UNKNOWN");
    assert.equal(result.structuredContent.results[0].outcome, "unknown", JSON.stringify(result));
    assert.equal(result.structuredContent.results[1].status, 424);
    assert.equal(commands.length, 1);
  });
  await withFixture(async (f) => {
    await close(f.broker);
    const commands = await f.useSsh({ disconnect: true });
    const result = await f.call("remote_batch", { connection: "ssh-fixture", operations: [{ type: "bash", command: "accepted-effect" }, { type: "bash", command: "must-not-run" }] });
    assert.equal(result.structuredContent.code, "EOUTCOME_UNKNOWN");
    assert.equal(result.structuredContent.results[1].status, 424);
    assert.equal(commands.length, 1);
  });
  await withFixture(async (f) => {
    await close(f.broker);
    await f.useSsh({ signal: "TERM" });
    const result = await f.call("remote_batch", { connection: "ssh-fixture", operations: [{ type: "bash", command: "terminated-effect" }] });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /SIGNAL: SIGTERM/);
  });
  console.log("PASS real stdio MCP broker recovery, single-delivery UNKNOWN, error envelopes, terminal logging and local secret redaction");
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
