#!/usr/bin/env node
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const jobDir = path.resolve(process.argv[2] || "");
if (!process.argv[2]) process.exit(2);
const metaPath = path.join(jobDir, "meta.json");
const resultPath = path.join(jobDir, "result.json");
const workerPath = path.join(jobDir, "worker.json");
const workerLogPath = path.join(jobDir, "worker.log");
const stdoutPath = path.join(jobDir, "stdout.log");
const stderrPath = path.join(jobDir, "stderr.log");
let child = null;
let stdout = null;
let stderr = null;
let finishing = false;
let cancelled = false;
let timedOut = false;
let timeout = null;
let startupReady = false;
let pendingOutcome = null;

function nowIso() { return new Date().toISOString(); }
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; } }

function diagnostic(phase, error, extra = {}) {
  const record = {
    ts: nowIso(),
    phase,
    workerPid: process.pid,
    commandPid: child?.pid || null,
    error: error ? String(error.stack || error.message || error) : null,
    ...extra,
  };
  try { fs.appendFileSync(workerLogPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 }); }
  catch {
    try { fs.appendFileSync(stderrPath, `[agentport-worker] ${JSON.stringify(record)}\n`, "utf8"); } catch {}
  }
}

async function atomicJson(filePath, value) {
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let handle = null;
  try {
    handle = await fsp.open(temp, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temp, filePath);
  } catch (error) {
    try { await handle?.close(); } catch {}
    try { await fsp.rm(temp, { force: true }); } catch {}
    throw error;
  }
}

async function writeJsonDurable(filePath, value, phase) {
  try {
    await atomicJson(filePath, value);
    return true;
  } catch (error) {
    diagnostic(`${phase}.atomic_failed`, error);
    try {
      await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      diagnostic(`${phase}.fallback_succeeded`, null);
      return true;
    } catch (fallbackError) {
      diagnostic(`${phase}.fallback_failed`, fallbackError, { atomicError: error.message });
      return false;
    }
  }
}

async function stopChild(signal = "SIGTERM") {
  if (!child?.pid || !pidAlive(child.pid)) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("exit", resolve);
      killer.once("error", resolve);
    });
    return;
  }
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch {} }
}

function closeStream(stream) {
  if (!stream || stream.closed || stream.writableFinished) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    stream.once("finish", done);
    stream.once("close", done);
    stream.once("error", done);
    stream.end();
  });
}

async function finish(status, code, signal, error) {
  if (finishing) return;
  finishing = true;
  if (timeout) clearTimeout(timeout);
  if (error) diagnostic("finish.error", error);
  await Promise.all([closeStream(stdout), closeStream(stderr)]);

  const result = {
    status,
    exitCode: typeof code === "number" ? code : null,
    signal: signal || null,
    timedOut,
    cancelled,
    error: error ? String(error.stack || error.message || error) : null,
    finishedAt: nowIso(),
  };
  const resultWritten = await writeJsonDurable(resultPath, result, "result");
  await writeJsonDurable(workerPath, {
    workerPid: process.pid,
    commandPid: child?.pid || null,
    phase: "finished",
    status,
    resultWritten,
    finishedAt: result.finishedAt,
  }, "worker_state");
  diagnostic("finish.complete", null, { status, resultWritten });
  process.exit(resultWritten && status === "completed" ? 0 : 1);
}

function requestFinish(status, code, signal, error) {
  const outcome = { status, code, signal, error };
  if (!startupReady) {
    pendingOutcome ||= outcome;
    diagnostic("command.finished_during_startup", error, { status, code, signal: signal || null });
    return;
  }
  void finish(status, code, signal, error);
}

async function main() {
  diagnostic("worker.boot", null, { node: process.version, jobDir });
  const meta = JSON.parse((await fsp.readFile(metaPath, "utf8")).replace(/^\uFEFF/, ""));
  await writeJsonDurable(workerPath, {
    workerPid: process.pid,
    commandPid: null,
    phase: "booting",
    startedAt: nowIso(),
  }, "worker_boot");

  stdout = fs.createWriteStream(stdoutPath, { flags: "a", mode: 0o600 });
  stderr = fs.createWriteStream(stderrPath, { flags: "a", mode: 0o600 });
  child = spawn(meta.command, [], {
    cwd: meta.cwd,
    shell: true,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(meta.env || {}) },
  });

  child.stdout?.pipe(stdout);
  child.stderr?.pipe(stderr);
  child.once("error", (error) => { requestFinish("error", null, null, error); });
  child.once("close", (code, signal) => {
    const status = cancelled ? "cancelled" : timedOut ? "timeout" : code === 0 ? "completed" : "error";
    requestFinish(status, code, signal, null);
  });

  const timeoutMs = Number(meta.timeoutMs || 0);
  if (timeoutMs > 0) {
    timeout = setTimeout(async () => {
      timedOut = true;
      diagnostic("command.timeout", null, { timeoutMs });
      await stopChild("SIGTERM");
      setTimeout(() => { void stopChild("SIGKILL"); }, 1000).unref?.();
    }, timeoutMs);
    timeout.unref?.();
  }

  await writeJsonDurable(workerPath, {
    workerPid: process.pid,
    commandPid: child.pid || null,
    phase: "running",
    startedAt: nowIso(),
  }, "worker_running");
  diagnostic("command.started", null, { commandPid: child.pid || null });

  startupReady = true;
  if (pendingOutcome) {
    const outcome = pendingOutcome;
    pendingOutcome = null;
    await finish(outcome.status, outcome.code, outcome.signal, outcome.error);
  }
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, async () => {
    cancelled = true;
    diagnostic("worker.signal", null, { signal });
    await stopChild("SIGTERM");
    setTimeout(() => { void stopChild("SIGKILL"); }, 1000).unref?.();
    if (!child) await finish("cancelled", null, signal, null);
  });
}

process.on("uncaughtException", (error) => { void finish("error", null, null, error); });
process.on("unhandledRejection", (error) => { void finish("error", null, null, error); });
main().catch((error) => finish("error", null, null, error));
