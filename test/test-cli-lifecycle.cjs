#!/usr/bin/env node

const assert = require("assert");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { Server: SshServer } = require("ssh2");

const ROOT = path.resolve(__dirname, "..");
const NODE = process.execPath;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

class FakeSshClient extends EventEmitter {
  constructor({ closeAfterMs = 0, stdout = "", stderr = "" } = {}) {
    super();
    this.closeAfterMs = closeAfterMs;
    this.stdout = stdout;
    this.stderr = stderr;
    this.destroyed = false;
    this.ended = false;
    this.calls = [];
  }

  exec(command, options, callback) {
    this.calls.push({ command, options });
    const stream = new PassThrough();
    stream.stderr = new PassThrough();
    stream.close = () => stream.emit("close", 0);
    setImmediate(() => {
      callback(null, stream);
      if (this.closeAfterMs > 0) {
        setTimeout(() => {
          if (this.stdout) stream.emit("data", Buffer.from(this.stdout));
          if (this.stderr) stream.stderr.emit("data", Buffer.from(this.stderr));
          stream.emit("close", 0);
        }, this.closeAfterMs);
      }
    });
  }

  end() {
    this.ended = true;
    this.emit("close");
  }

  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}

async function testParentWatchdogUnit() {
  const { startParentWatchdog } = await import("../cli-lifecycle.js");
  let exitCode = null;
  const error = new Error("missing");
  error.code = "ESRCH";
  const stop = startParentWatchdog({
    parentPid: 424242,
    intervalMs: 10,
    probe: () => { throw error; },
    onParentExit: () => { exitCode = 143; },
  });
  await wait(40);
  stop();
  assert.strictEqual(exitCode, 143);
}

async function testForcedExitUnit() {
  const { scheduleForcedExit } = await import("../cli-lifecycle.js");
  let exitCode = null;
  scheduleForcedExit({ delayMs: 10, exitCode: 7, exit: (code) => { exitCode = code; } });
  await wait(40);
  assert.strictEqual(exitCode, 7);
}

async function testParentWatchdogIntegration() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentport-watchdog-"));
  const childPath = path.join(tempDir, "child.mjs");
  const parentPath = path.join(tempDir, "parent.cjs");
  const pidPath = path.join(tempDir, "child.pid");
  const lifecycleUrl = new URL(`file:///${path.join(ROOT, "cli-lifecycle.js").replace(/\\/g, "/")}`).href;
  fs.writeFileSync(childPath, [
    `import { startParentWatchdog } from ${JSON.stringify(lifecycleUrl)};`,
    "startParentWatchdog({ parentPid: Number(process.env.TEST_PARENT_PID), intervalMs: 100 });",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"));
  fs.writeFileSync(parentPath, [
    "const { spawn } = require('child_process');",
    "const fs = require('fs');",
    "const child = spawn(process.execPath, [process.env.TEST_CHILD_PATH], {",
    "  detached: true,",
    "  stdio: 'ignore',",
    "  env: { ...process.env, TEST_PARENT_PID: String(process.pid) },",
    "});",
    "fs.writeFileSync(process.env.TEST_PID_PATH, String(child.pid));",
    "child.unref();",
    "",
  ].join("\n"));

  const parent = spawnSync(NODE, [parentPath], {
    env: { ...process.env, TEST_CHILD_PATH: childPath, TEST_PID_PATH: pidPath },
    timeout: 5000,
  });
  assert.strictEqual(parent.status, 0, parent.stderr?.toString());
  const childPid = Number(fs.readFileSync(pidPath, "utf8"));
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && processExists(childPid)) await wait(100);
  const stillRunning = processExists(childPid);
  if (stillRunning) {
    try { process.kill(childPid); } catch {}
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
  assert.strictEqual(stillRunning, false, `watchdog child ${childPid} survived its parent`);
}

async function testHiddenLauncherParentCleanup() {
  if (process.platform !== "win32") return;
  const launcherPath = path.join(process.env.USERPROFILE || "", ".codex", "bin", "hidden-stdio-launcher-v3.exe");
  assert.ok(fs.existsSync(launcherPath), `launcher missing: ${launcherPath}`);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentport-launcher-"));
  const parentPath = path.join(tempDir, "parent.cjs");
  const childPidPath = path.join(tempDir, "child.pid");
  const launcherPidPath = path.join(tempDir, "launcher.pid");
  fs.writeFileSync(parentPath, [
    "const { spawn } = require('child_process');",
    "const fs = require('fs');",
    "const code = \"require('fs').writeFileSync(process.env.TEST_CHILD_PID, String(process.pid)); setInterval(() => {}, 1000);\";",
    "const launcher = spawn(process.env.TEST_LAUNCHER, [process.execPath, '-e', code], {",
    "  detached: true,",
    "  stdio: 'ignore',",
    "  env: { ...process.env, TEST_CHILD_PID: process.env.TEST_CHILD_PID },",
    "});",
    "fs.writeFileSync(process.env.TEST_LAUNCHER_PID, String(launcher.pid));",
    "launcher.unref();",
    "const waitArray = new Int32Array(new SharedArrayBuffer(4));",
    "const deadline = Date.now() + 3000;",
    "while (!fs.existsSync(process.env.TEST_CHILD_PID) && Date.now() < deadline) Atomics.wait(waitArray, 0, 0, 25);",
    "if (!fs.existsSync(process.env.TEST_CHILD_PID)) process.exit(2);",
    "",
  ].join("\n"));

  const parent = spawnSync(NODE, [parentPath], {
    env: {
      ...process.env,
      TEST_LAUNCHER: launcherPath,
      TEST_CHILD_PID: childPidPath,
      TEST_LAUNCHER_PID: launcherPidPath,
    },
    timeout: 5000,
  });
  assert.strictEqual(parent.status, 0, parent.stderr?.toString());
  const childPid = Number(fs.readFileSync(childPidPath, "utf8"));
  const launcherPid = Number(fs.readFileSync(launcherPidPath, "utf8"));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (processExists(childPid) || processExists(launcherPid))) await wait(100);
  const childRunning = processExists(childPid);
  const launcherRunning = processExists(launcherPid);
  if (childRunning) try { process.kill(childPid); } catch {}
  if (launcherRunning) try { process.kill(launcherPid); } catch {}
  fs.rmSync(tempDir, { recursive: true, force: true });
  assert.strictEqual(childRunning, false, `launcher child ${childPid} survived parent exit`);
  assert.strictEqual(launcherRunning, false, `launcher ${launcherPid} survived parent exit`);
}

async function testSshExecTimeout() {
  const { SSHClient } = await import("../ssh-client.js");
  const fake = new FakeSshClient();
  const ssh = new SSHClient({ host: "test", execTimeoutMs: 30 });
  ssh.connect = async () => {
    ssh.client = fake;
    ssh.connected = true;
  };
  await assert.rejects(
    () => ssh.exec("sleep forever"),
    (error) => error?.code === "ETIMEDOUT" && error?.timeoutMs === 30,
  );
  assert.strictEqual(fake.destroyed, true);
}

async function testSshExecCompletesBeforeTimeout() {
  const { SSHClient } = await import("../ssh-client.js");
  const fake = new FakeSshClient({ closeAfterMs: 10, stdout: "ok\n" });
  const ssh = new SSHClient({ host: "test", execTimeoutMs: 200 });
  ssh.connect = async () => {
    ssh.client = fake;
    ssh.connected = true;
  };
  const result = await ssh.exec("printf ok");
  assert.deepStrictEqual(result, { stdout: "ok", stderr: "", code: 0 });
  ssh.disconnect();
}

async function testSshExecUsesRequestedCwd() {
  const { SSHClient } = await import("../ssh-client.js");
  const fake = new FakeSshClient({ closeAfterMs: 10, stdout: "/workspace/project\n" });
  const ssh = new SSHClient({ host: "test", workspaceRoot: "/workspace", execTimeoutMs: 200 });
  ssh.connect = async () => {
    ssh.client = fake;
    ssh.connected = true;
  };
  const result = await ssh.exec("pwd", { cwd: "project" });
  assert.strictEqual(result.stdout, "/workspace/project");
  assert.deepStrictEqual(fake.calls, [{ command: "cd -- '/workspace/project' && pwd", options: {} }]);
  ssh.disconnect();
}

async function testSshExecPreservesPlainOutput() {
  const { SSHClient } = await import("../ssh-client.js");
  const fake = new FakeSshClient({ closeAfterMs: 10, stdout: "  output\n\n", stderr: " warning\n" });
  const ssh = new SSHClient({ host: "test", execTimeoutMs: 200 });
  ssh.connect = async () => {
    ssh.client = fake;
    ssh.connected = true;
  };
  const result = await ssh.exec("printf output", { preserveOutput: true });
  assert.deepStrictEqual(result, { stdout: "  output\n\n", stderr: " warning\n", code: 0 });
  ssh.disconnect();
}

async function testSshDoctorRipgrepProbeParsing() {
  const { parseSshDoctorOutput } = await import("../doctor-utils.js");

  assert.deepStrictEqual(
    parseSshDoctorOutput("agentport-rg=available\nuser@host:/workspace"),
    { ripgrepAvailable: true, data: "user@host:/workspace" },
  );
  assert.deepStrictEqual(
    parseSshDoctorOutput("notice: remote banner\nagentport-rg=missing\nuser@host:/workspace"),
    { ripgrepAvailable: false, data: "notice: remote banner\nuser@host:/workspace" },
  );
  assert.deepStrictEqual(
    parseSshDoctorOutput("notice: probe missing\nuser@host:/workspace"),
    { ripgrepAvailable: false, data: "notice: probe missing\nuser@host:/workspace" },
  );
}

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [path.join(ROOT, "cli.js"), ...args], {
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function testCliPropagatesRemoteFailures() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentport-cli-exit-"));
  const connectionsPath = path.join(tempDir, "connections.json");
  const scriptPath = path.join(tempDir, "diagnostic.sh");
  let scriptRequests = 0;
  let grepRequests = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/fs/grep") {
        grepRequests++;
        res.end(JSON.stringify({ matches: [] }));
        return;
      }
      if (req.url === "/api/fs/read") {
        const { path: targetPath } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        res.end(JSON.stringify(targetPath === "/registered/rules.md"
          ? {
            etag: "read-etag",
            content: "rule text",
            accessScope: "registered-rule-file",
            readOnly: true,
            writeEtag: "write-etag",
          }
          : { etag: "plain-etag", content: "ordinary text" }));
        return;
      }
      if (req.url === "/api/batch") {
        res.end(JSON.stringify({ results: [{ status: 403, error: "blocked" }] }));
        return;
      }
      if (req.url === "/api/exec") {
        res.end(JSON.stringify({ code: 7, stdout: "", stderr: "failed" }));
        return;
      }
      if (req.url === "/api/exec/script") {
        scriptRequests += 1;
        const content = JSON.parse(Buffer.concat(chunks).toString("utf8")).content;
        const result = content.includes("script-fail")
          ? { success: false, stdout: "partial\n", stderr: "problem\n", code: 9 }
          : content.includes("script-silent-fail")
            ? { success: false, stdout: "", stderr: "", code: 5 }
            : content.includes("script-empty")
              ? { success: true, stdout: "", stderr: "", code: 0 }
              : { success: true, stdout: "first\nsecond\n", stderr: "notice\n", code: 0 };
        res.end(JSON.stringify(result));
        return;
      }
      if (req.url === "/api/jobs" && req.method === "POST") {
        const command = JSON.parse(Buffer.concat(chunks).toString("utf8")).command;
        const failed = command === "fail-immediately";
        res.end(JSON.stringify({
          success: true,
          jobId: failed ? "job-failed" : "job-running",
          status: failed ? "error" : "running",
          job: {
            status: failed ? "error" : "running",
            exitCode: failed ? 127 : null,
          },
        }));
        return;
      }
      if (req.url === "/api/jobs/job-failed" && req.method === "GET") {
        res.end(JSON.stringify({ success: true, job: { status: "error", exitCode: 127 } }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  fs.writeFileSync(connectionsPath, JSON.stringify({
    connections: [{
      name: "fake",
      type: "daemon",
      url: `http://127.0.0.1:${port}`,
      authToken: "test-token",
      clientId: "test-client",
    }],
    default: "fake",
  }));
  fs.writeFileSync(scriptPath, "script-ok\n");

  try {
    const env = {
      AGENTPORT_LEGACY_CONNECTIONS_PATH: connectionsPath,
      AGENTPORT_SESSION_ID: "cli-exit-test",
    };
    for (const pattern of ["(?i)invalid", "["]) {
      const invalid = await runCli(["grep", pattern, "--regex", "--connection", "fake", "--route", "daemon", "--json"], env);
      assert.strictEqual(invalid.code, 1);
      assert.match(JSON.parse(invalid.stdout).error, /JavaScript syntax/);
    }
    assert.strictEqual(grepRequests, 0, "invalid daemon regex must fail before network search");
    const literal = await runCli(["grep", "(?i)literal", "--connection", "fake", "--route", "daemon", "--json"], env);
    assert.strictEqual(literal.code, 0, literal.stderr || literal.stdout);
    assert.strictEqual(grepRequests, 1);
    const stat = await runCli(["stat", "/outside", "--connection", "fake"], env);
    assert.strictEqual(stat.code, 1, stat.stderr || stat.stdout);

    const ruleRead = await runCli(["read", "/registered/rules.md", "--connection", "fake", "--json"], env);
    assert.strictEqual(ruleRead.code, 0, ruleRead.stderr || ruleRead.stdout);
    const ruleReadData = JSON.parse(ruleRead.stdout);
    assert.strictEqual(ruleReadData.content, "rule text");
    assert.strictEqual(ruleReadData.accessScope, "registered-rule-file");
    assert.strictEqual(ruleReadData.readOnly, true);
    assert.strictEqual(ruleReadData.writeEtag, "write-etag");
    assert.strictEqual(ruleReadData.connection, "fake");
    assert.strictEqual(ruleReadData.route, "daemon");

    const plainRead = await runCli(["read", "/ordinary.txt", "--connection", "fake", "--json"], env);
    assert.strictEqual(plainRead.code, 0, plainRead.stderr || plainRead.stdout);
    const plainReadData = JSON.parse(plainRead.stdout);
    assert.strictEqual(plainReadData.content, "ordinary text");
    assert.ok(!Object.hasOwn(plainReadData, "accessScope"));
    assert.ok(!Object.hasOwn(plainReadData, "readOnly"));
    assert.ok(!Object.hasOwn(plainReadData, "writeEtag"));

    const bash = await runCli(["bash", "exit 7", "--connection", "fake", "--json"], env);
    assert.strictEqual(bash.code, 7, bash.stderr || bash.stdout);
    assert.strictEqual(JSON.parse(bash.stdout).ok, false);

    const running = await runCli(["job", "start", "still-running", "--connection", "fake", "--json"], env);
    assert.strictEqual(running.code, 0, running.stderr || running.stdout);
    assert.strictEqual(JSON.parse(running.stdout).job.status, "running");

    const failedStart = await runCli(["job", "start", "fail-immediately", "--connection", "fake", "--json"], env);
    assert.strictEqual(failedStart.code, 127, failedStart.stderr || failedStart.stdout);
    assert.strictEqual(JSON.parse(failedStart.stdout).job.status, "error");

    const failedStatus = await runCli(["job", "status", "job-failed", "--connection", "fake", "--json"], env);
    assert.strictEqual(failedStatus.code, 127, failedStatus.stderr || failedStatus.stdout);
    assert.strictEqual(JSON.parse(failedStatus.stdout).job.exitCode, 127);

    const scriptArgs = [scriptPath, "--connection", "fake", "--cwd", "/workspace"];
    const structured = await runCli(["safe-bash", ...scriptArgs], env);
    assert.strictEqual(structured.code, 0, structured.stderr || structured.stdout);
    assert.strictEqual(JSON.parse(structured.stdout).result.stdout, "first\nsecond\n");

    const plain = await runCli(["safe-bash", ...scriptArgs, "--plain"], env);
    assert.deepStrictEqual(plain, { code: 0, stdout: "first\nsecond\n", stderr: "notice\n" });

    const plainScript = await runCli(["safe-script", ...scriptArgs, "--interpreter", "bash", "--plain"], env);
    assert.deepStrictEqual(plainScript, { code: 0, stdout: "first\nsecond\n", stderr: "notice\n" });

    fs.writeFileSync(scriptPath, "script-empty\n");
    const beforeEmpty = scriptRequests;
    const empty = await runCli(["safe-bash", ...scriptArgs, "--plain"], env);
    assert.deepStrictEqual(empty, { code: 0, stdout: "", stderr: "" });
    assert.strictEqual(scriptRequests, beforeEmpty + 1);

    fs.writeFileSync(scriptPath, "script-fail\n");
    const failedScript = await runCli(["safe-bash", ...scriptArgs, "--plain"], env);
    assert.deepStrictEqual(failedScript, { code: 9, stdout: "partial\n", stderr: "problem\n" });

    fs.writeFileSync(scriptPath, "script-silent-fail\n");
    const silentFailure = await runCli(["safe-bash", ...scriptArgs, "--plain"], env);
    assert.strictEqual(silentFailure.code, 5);
    assert.strictEqual(silentFailure.stdout, "");
    assert.match(silentFailure.stderr, /Remote script failed \(exit code 5\)/);

    const beforeInvalid = scriptRequests;
    const conflicting = await runCli(["safe-bash", ...scriptArgs, "--plain", "--json"], env);
    assert.strictEqual(conflicting.code, 1);
    assert.match(JSON.parse(conflicting.stdout).error, /cannot be combined/);
    const dryRun = await runCli(["safe-bash", ...scriptArgs, "--plain", "--dry-run"], env);
    assert.strictEqual(dryRun.code, 1);
    assert.match(dryRun.stderr, /unavailable with --dry-run/);
    assert.strictEqual(scriptRequests, beforeInvalid);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function testSafeJobDryRun() {
  const result = spawnSync(NODE, [
    path.join(ROOT, "cli.js"),
    "safe-job",
    __filename,
    "--cwd",
    "/tmp/agentport-test",
    "--dry-run",
    "--json",
  ], { encoding: "utf8", timeout: 5000 });
  assert.strictEqual(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.strictEqual(data.command, "safe-job");
  assert.strictEqual(data.dryRun, true);
  assert.strictEqual(data.jobTimeoutMs, 1800000);
  assert.strictEqual(data.verifiedUpload, false);
}

function expectedRecommendedOrder() {
  return ["native-mcp", "daemon-job", "cli-daemon", "ssh"];
}

async function testSshHealthWorkspaceBoundary() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentport-ssh-health-"));
  const connectionsPath = path.join(tempDir, "connections.json");
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  const hostKey = privateKey.export({ type: "pkcs1", format: "pem" });
  const server = new SshServer({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.username === "test" && ctx.method === "password" && ctx.password === "test-only") ctx.accept();
      else ctx.reject();
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("sftp", (acceptSftp) => { acceptSftp(); });
        session.on("exec", (acceptExec) => {
          const stream = acceptExec();
          stream.exit(0);
          stream.end("agentport-rg=available\ntest@fake:/workspace");
        });
      });
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    fs.writeFileSync(connectionsPath, JSON.stringify({
      connections: [
        { name: "bounded", type: "ssh", host: "127.0.0.1", port: server.address().port, username: "test", password: "test-only", workspaceRoot: "/workspace" },
        { name: "legacy", type: "ssh", host: "127.0.0.1", port: server.address().port, username: "test", password: "test-only" },
        { name: "trailing-root", type: "ssh", host: "127.0.0.1", port: server.address().port, username: "test", password: "test-only", workspaceRoot: "/workspace/" },
        { name: "filesystem-root", type: "ssh", host: "127.0.0.1", port: server.address().port, username: "test", password: "test-only", workspaceRoot: "/" },
      ],
      default: "bounded",
    }));
    const result = await runCli(["doctor", "--json"], {
      AGENTPORT_LEGACY_CONNECTIONS_PATH: connectionsPath,
      AGENTPORT_SESSION_ID: "ssh-health-boundary-test",
    });
    assert.strictEqual(result.code, 0, result.stderr || result.stdout);
    const doctor = JSON.parse(result.stdout);
    assert.deepStrictEqual(doctor.recommendedOrder, expectedRecommendedOrder());
    const [bounded, legacy, trailingRoot, filesystemRoot] = doctor.results;
    assert.strictEqual(bounded.ok, true);
    assert.deepStrictEqual(bounded.workspaceBoundary, {
      kind: "ssh-path-argument-boundary",
      root: "/workspace",
      enforced: true,
      source: "connection.workspaceRoot",
      legacyUnrestrictedPathArguments: false,
      osIsolation: false,
    });
    assert.strictEqual(legacy.ok, true);
    assert.deepStrictEqual(legacy.workspaceBoundary, {
      kind: "ssh-path-argument-boundary",
      root: null,
      enforced: false,
      source: "unconfigured",
      legacyUnrestrictedPathArguments: true,
      osIsolation: false,
    });
    assert.strictEqual(trailingRoot.workspaceBoundary.root, "/workspace");
    assert.strictEqual(trailingRoot.workspaceBoundary.enforced, true);
    assert.strictEqual(filesystemRoot.workspaceBoundary.root, null);
    assert.strictEqual(filesystemRoot.workspaceBoundary.enforced, false);
    assert.strictEqual(filesystemRoot.workspaceBoundary.source, "connection.workspaceRoot");
    assert.strictEqual(bounded.recommendedDependencies.ripgrep.installed, true);
    assert.ok(!result.stdout.includes("test-only"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testDaemonHealthWorkspaceRootsAndRouteOrder() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentport-daemon-health-"));
  const connectionsPath = path.join(tempDir, "connections.json");
  const roots = { projects: "/work/projects", docs: "/work/docs" };
  const healthVariants = [
    {
      ok: true,
      workspaceRoot: "/work/projects",
      defaultWorkspace: "projects",
      workspaceRoots: roots,
      workspaceNames: ["projects", "docs"],
      workspaceBoundary: { enforced: true, scope: "file-operations-and-execution-cwd", osIsolation: false },
    },
    { ok: true, workspaceRoot: "/reported/default-only" },
    { ok: true },
  ];
  const servers = healthVariants.map((health) => http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/healthz") {
      res.end(JSON.stringify(health));
      return;
    }
    if (req.url === "/api/jobs?limit=1") {
      res.end(JSON.stringify({ count: 0, jobs: [] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  }));
  try {
    for (const server of servers) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
    }
    fs.writeFileSync(connectionsPath, JSON.stringify({
      connections: servers.map((server, index) => ({
        name: `daemon-${index}`,
        type: "daemon",
        url: `http://127.0.0.1:${server.address().port}`,
        authToken: "not-output",
        clientId: "health-test",
      })),
      default: "daemon-0",
    }));
    const result = await runCli(["doctor", "--json"], {
      AGENTPORT_LEGACY_CONNECTIONS_PATH: connectionsPath,
      AGENTPORT_SESSION_ID: "daemon-health-boundary-test",
    });
    assert.strictEqual(result.code, 0, result.stderr || result.stdout);
    const doctor = JSON.parse(result.stdout);
    assert.deepStrictEqual(doctor.recommendedOrder, expectedRecommendedOrder());
    assert.deepStrictEqual(doctor.results[0].workspaceBoundary, {
      kind: "daemon-path-boundary",
      source: "healthz.workspaceRoots",
      roots,
      defaultWorkspace: "projects",
      workspaceNames: ["projects", "docs"],
      reported: true,
      enforced: true,
      scope: "file-operations-and-execution-cwd",
      enforcement: "healthz-reported-not-independently-verified",
      osIsolation: false,
    });
    assert.deepStrictEqual(doctor.results[1].workspaceBoundary, {
      kind: "daemon-path-boundary",
      source: "healthz.workspaceRoot",
      roots: ["/reported/default-only"],
      defaultWorkspace: null,
      workspaceNames: null,
      reported: true,
      enforced: null,
      scope: null,
      enforcement: "unknown",
      osIsolation: null,
    });
    assert.deepStrictEqual(doctor.results[2].workspaceBoundary, {
      kind: "daemon-path-boundary",
      source: "unreported",
      roots: null,
      defaultWorkspace: null,
      workspaceNames: null,
      reported: false,
      enforced: null,
      scope: null,
      enforcement: "unknown",
      osIsolation: null,
    });
    const status = await runCli(["status", "--connection", "daemon-0", "--json"], {
      AGENTPORT_LEGACY_CONNECTIONS_PATH: connectionsPath,
      AGENTPORT_SESSION_ID: "daemon-health-boundary-test",
    });
    assert.strictEqual(status.code, 0, status.stderr || status.stdout);
    assert.deepStrictEqual(JSON.parse(status.stdout).recommendedOrder, expectedRecommendedOrder());
    assert.ok(!result.stdout.includes("not-output"));
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testConvertedRemoteCwdIsRejected() {
  const converted = "C:/Users/test/PortableGit/home/example";
  for (const [option, value] of [
    ["--cwd", converted],
    ["--cwd=" + converted],
    ["--remote-tmp-dir", converted],
  ]) {
    const args = option.includes("=") ? [option] : [option, value];
    const result = await runCli(["safe-job", __filename, ...args, "--dry-run", "--json"]);
    assert.strictEqual(result.code, 1, result.stderr || result.stdout);
    const data = JSON.parse(result.stdout);
    assert.match(data.error, /Git Bash may have converted/);
    assert.ok(!data.error.includes(converted));
  }

  const normal = await runCli(["safe-job", __filename, "--cwd", "/home/example", "--dry-run", "--json"]);
  assert.strictEqual(normal.code, 0, normal.stderr || normal.stdout);
  assert.strictEqual(JSON.parse(normal.stdout).cwd, "/home/example");

  const named = await runCli(["safe-job", __filename, "--cwd", "p:/project", "--dry-run", "--json"]);
  assert.strictEqual(named.code, 0, named.stderr || named.stdout);
  assert.strictEqual(JSON.parse(named.stdout).cwd, "p:/project");
}

async function testConvertedRemoteFileTargetsAreRejectedBeforeIO() {
  const converted = "C:/Users/test/PortableGit/home/workspace/file.txt";
  const missingPayload = path.join(os.tmpdir(), `agentport-missing-payload-${process.pid}.txt`);
  const cases = [
    ["read", [converted, "--json"]],
    ["read", ["--path", converted, "--json"]],
    ["write", [converted, "--content", "x", "--json"]],
    ["write", ["--path", converted, "--content", "x", "--json"]],
    ["safe-write", [converted, "--file", missingPayload, "--json"]],
    ["safe-write", ["--path", converted, "--file", missingPayload, "--json"]],
  ];
  for (const [command, args] of cases) {
    const result = await runCli([command, ...args]);
    assert.strictEqual(result.code, 1, result.stderr || result.stdout);
    const error = JSON.parse(result.stdout).error;
    assert.match(error, /Git Bash may have converted/);
    assert.match(error, /MSYS2_ARG_CONV_EXCL='\*'/);
    assert.ok(!error.includes(converted));
    assert.ok(!error.includes("ENOENT"), "target preflight must precede local payload reads");
  }

  for (const target of ["relative/file.txt", "projects:/file.txt"]) {
    const result = await runCli(["safe-write", target, "--file", __filename, "--dry-run", "--json"]);
    assert.strictEqual(result.code, 0, result.stderr || result.stdout);
    assert.strictEqual(JSON.parse(result.stdout).path, target);
  }
  const namedRead = await runCli(["read", "--path=projects:/file.txt", "--connection", "unknown", "--json"]);
  assert.strictEqual(namedRead.code, 1);
  assert.match(JSON.parse(namedRead.stdout).error, /Connection 'unknown' not found/);
}

async function testLocalDiagnosticsCli() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentport-cli-diagnostics-"));
  const now = new Date().toISOString();
  const logPath = path.join(tempDir, `agentport-${now.slice(0, 10)}.log`);
  const data = { callId: 1, originCallId: "private-origin-canary", sessionId: "private-session-canary", durationMs: 123, callOutcome: "failed", outcome: "failed", failureCategory: "command-failed", args: { token: "private-token-canary" } };
  const content = `[${now}] [ERROR] [remote_bash] Failed call #1\n  Data: ${JSON.stringify(data)}\n`;
  fs.writeFileSync(logPath, content);
  try {
    const env = { AGENTPORT_LEGACY_CONNECTIONS_PATH: path.join(tempDir, "nonexistent-config.json") };
    const result = await runCli(["diagnostics", "--log-dir", tempDir, "--json"], env);
    assert.strictEqual(result.code, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.strictEqual(report.scope, "observed-mcp-logs-only");
    assert.strictEqual(report.totals.callOutcome.failed, 1);
    assert.strictEqual(report.totals.failureCategories["command-failed"], 1);
    assert.ok(!result.stdout.includes("canary"));
    assert.ok(!result.stdout.includes(tempDir));
    const plain = await runCli(["diagnostics", "--log-dir", tempDir], env);
    assert.strictEqual(plain.code, 0, plain.stderr);
    assert.match(plain.stdout, /command-failed/);
    assert.match(plain.stdout, /remote_bash/);
    const invalid = await runCli(["diagnostics", "--days", "NaN", "--json"], env);
    assert.strictEqual(invalid.code, 1);
    assert.strictEqual(JSON.parse(invalid.stdout).ok, false);
    assert.strictEqual(fs.readFileSync(logPath, "utf8"), content, "diagnostics must never modify source logs");
  } finally {
    assert.strictEqual(path.dirname(tempDir), os.tmpdir());
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const tests = [
    ["parent watchdog unit", testParentWatchdogUnit],
    ["forced exit unit", testForcedExitUnit],
    ["parent watchdog integration", testParentWatchdogIntegration],
    ["hidden launcher parent cleanup", testHiddenLauncherParentCleanup],
    ["SSH exec timeout", testSshExecTimeout],
    ["SSH exec completes", testSshExecCompletesBeforeTimeout],
    ["SSH exec honors cwd", testSshExecUsesRequestedCwd],
    ["SSH exec preserves plain output", testSshExecPreservesPlainOutput],
    ["SSH doctor ripgrep probe parsing", testSshDoctorRipgrepProbeParsing],
    ["SSH health workspace boundary", testSshHealthWorkspaceBoundary],
    ["daemon health workspace roots and route order", testDaemonHealthWorkspaceRootsAndRouteOrder],
    ["CLI propagates remote failures", testCliPropagatesRemoteFailures],
    ["safe-job dry-run", testSafeJobDryRun],
    ["converted remote cwd rejection", testConvertedRemoteCwdIsRejected],
    ["converted remote file targets preflight", testConvertedRemoteFileTargetsAreRejectedBeforeIO],
    ["local diagnostics CLI", testLocalDiagnosticsCli],
  ];
  for (const [name, test] of tests) {
    await test();
    console.log(`PASS ${name}`);
  }
  console.log(`PASS ${tests.length}/${tests.length}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
