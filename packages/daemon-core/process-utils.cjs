const { spawn } = require("node:child_process");

function pidAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function taskkill(pid, force = false) {
  return new Promise((resolve) => {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    const child = spawn("taskkill.exe", args, { windowsHide: true, stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

async function terminateProcessTree(pid, { signal = "SIGTERM", forceAfterMs = 5000 } = {}) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  if (process.platform === "win32") {
    const stopped = await taskkill(value, false);
    if (stopped || !pidAlive(value)) return true;
    if (forceAfterMs > 0) await new Promise((resolve) => setTimeout(resolve, forceAfterMs));
    return taskkill(value, true);
  }

  try {
    process.kill(-value, signal);
  } catch {
    try { process.kill(value, signal); } catch { return !pidAlive(value); }
  }
  if (forceAfterMs <= 0) return true;
  const deadline = Date.now() + forceAfterMs;
  while (Date.now() < deadline) {
    if (!pidAlive(value)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { process.kill(-value, "SIGKILL"); }
  catch { try { process.kill(value, "SIGKILL"); } catch {} }
  return !pidAlive(value);
}

module.exports = { pidAlive, terminateProcessTree };
