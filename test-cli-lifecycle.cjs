#!/usr/bin/env node

const assert = require("assert");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = __dirname;
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
  constructor({ closeAfterMs = 0, stdout = "" } = {}) {
    super();
    this.closeAfterMs = closeAfterMs;
    this.stdout = stdout;
    this.destroyed = false;
    this.ended = false;
  }

  exec(_command, _options, callback) {
    const stream = new PassThrough();
    stream.stderr = new PassThrough();
    stream.close = () => stream.emit("close", 0);
    setImmediate(() => {
      callback(null, stream);
      if (this.closeAfterMs > 0) {
        setTimeout(() => {
          if (this.stdout) stream.emit("data", Buffer.from(this.stdout));
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
  const { startParentWatchdog } = await import("./cli-lifecycle.js");
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
  const { scheduleForcedExit } = await import("./cli-lifecycle.js");
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
  const launcherPath = path.join(process.env.USERPROFILE || "", ".codex", "bin", "hidden-stdio-launcher-v2.exe");
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
  const { SSHClient } = await import("./ssh-client.js");
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
  const { SSHClient } = await import("./ssh-client.js");
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

async function main() {
  const tests = [
    ["parent watchdog unit", testParentWatchdogUnit],
    ["forced exit unit", testForcedExitUnit],
    ["parent watchdog integration", testParentWatchdogIntegration],
    ["hidden launcher parent cleanup", testHiddenLauncherParentCleanup],
    ["SSH exec timeout", testSshExecTimeout],
    ["SSH exec completes", testSshExecCompletesBeforeTimeout],
    ["safe-job dry-run", testSafeJobDryRun],
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
