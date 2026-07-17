#!/usr/bin/env node
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const jobDir = path.resolve(process.argv[2] || "");
if (!jobDir) process.exit(2);
const metaPath = path.join(jobDir, "meta.json");
const resultPath = path.join(jobDir, "result.json");
const stdoutPath = path.join(jobDir, "stdout.log");
const stderrPath = path.join(jobDir, "stderr.log");
let child = null;
let finishing = false;
let cancelled = false;
let timedOut = false;
let timeout = null;

function nowIso() { return new Date().toISOString(); }
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; } }

async function atomicJson(filePath, value) {
  const temp = `${filePath}.${process.pid}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fsp.rename(temp, filePath);
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

async function finish(status, code, signal, error) {
  if (finishing) return;
  finishing = true;
  if (timeout) clearTimeout(timeout);
  await atomicJson(resultPath, {
    status,
    exitCode: typeof code === "number" ? code : null,
    signal: signal || null,
    timedOut,
    cancelled,
    error: error ? String(error.stack || error.message || error) : null,
    finishedAt: nowIso(),
  }).catch(() => {});
  process.exit(status === "completed" ? 0 : 1);
}

async function main() {
  const meta = JSON.parse((await fsp.readFile(metaPath, "utf8")).replace(/^\uFEFF/, ""));
  const stdout = fs.createWriteStream(stdoutPath, { flags: "a" });
  const stderr = fs.createWriteStream(stderrPath, { flags: "a" });
  child = spawn(meta.command, [], {
    cwd: meta.cwd,
    shell: true,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(meta.env || {}) },
  });
  await atomicJson(path.join(jobDir, "worker.json"), { workerPid: process.pid, commandPid: child.pid, startedAt: nowIso() });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  child.once("error", (error) => finish("error", null, null, error));
  child.once("close", (code, signal) => {
    stdout.end();
    stderr.end();
    const status = cancelled ? "cancelled" : timedOut ? "timeout" : code === 0 ? "completed" : "error";
    finish(status, code, signal, null);
  });
  const timeoutMs = Number(meta.timeoutMs || 0);
  if (timeoutMs > 0) {
    timeout = setTimeout(async () => {
      timedOut = true;
      await stopChild("SIGTERM");
      setTimeout(() => stopChild("SIGKILL"), 1000).unref?.();
    }, timeoutMs);
    timeout.unref?.();
  }
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, async () => {
    cancelled = true;
    await stopChild("SIGTERM");
    setTimeout(() => stopChild("SIGKILL"), 1000).unref?.();
    if (!child) await finish("cancelled", null, signal, null);
  });
}

main().catch((error) => finish("error", null, null, error));
