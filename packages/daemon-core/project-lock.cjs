const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pidAlive } = require("./process-utils.cjs");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockError(message, code = "EPROJECT_LOCKED", statusCode = 423, details = null) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}

function intValue(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

async function readLock(lockPath) {
  try {
    return JSON.parse(await fs.readFile(lockPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return { invalid: true };
  }
}

function createProjectLockManager({
  locksDir,
  lockTimeoutMs = 15_000,
  lockLeaseMs = 5 * 60_000,
} = {}) {
  if (!locksDir) throw new TypeError("locksDir is required");
  const timeoutMs = intValue(lockTimeoutMs, 15_000, 0, 10 * 60_000);
  const leaseMs = intValue(lockLeaseMs, 5 * 60_000, 1000, 60 * 60_000);
  const activeOwners = new Set();

  function lockPathFor(projectRoot) {
    const key = crypto.createHash("sha256").update(path.resolve(projectRoot)).digest("hex").slice(0, 24);
    return path.join(locksDir, `${key}.lock`);
  }

  function isStale(info, now = Date.now()) {
    if (!info || info.invalid) return true;
    const pid = Number(info.pid || 0);
    const ownerId = String(info.ownerId || "");
    const expired = Date.parse(info.expiresAt || 0) <= now;
    if (pid > 0 && pid !== process.pid) return !pidAlive(pid);
    if (pid === process.pid) return expired && (!ownerId || !activeOwners.has(ownerId));
    return expired;
  }

  async function withLock(projectRoot, fn) {
    await fs.mkdir(locksDir, { recursive: true });
    const normalizedRoot = path.resolve(projectRoot);
    const lockPath = lockPathFor(normalizedRoot);
    const deadline = Date.now() + timeoutMs;
    const ownerId = crypto.randomUUID();
    let handle = null;

    while (!handle) {
      try {
        handle = await fs.open(lockPath, "wx", 0o600);
        activeOwners.add(ownerId);
        await handle.writeFile(JSON.stringify({
          version: 2,
          ownerId,
          pid: process.pid,
          projectRoot: normalizedRoot,
          acquiredAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + leaseMs).toISOString(),
        }));
      } catch (error) {
        if (handle) {
          try { await handle.close(); } catch {}
          handle = null;
        }
        activeOwners.delete(ownerId);
        if (error?.code !== "EEXIST") throw error;
        const current = await readLock(lockPath);
        if (isStale(current)) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw lockError("Project operation lock timed out", "EPROJECT_LOCKED", 423, {
            projectRoot: normalizedRoot,
            ownerPid: current?.pid || null,
            ownerId: current?.ownerId || null,
            acquiredAt: current?.acquiredAt || null,
          });
        }
        await sleep(100);
      }
    }

    try {
      return await fn({ ownerId, lockPath, leaseMs });
    } finally {
      activeOwners.delete(ownerId);
      try { await handle.close(); } catch {}
      const current = await readLock(lockPath);
      if (current?.ownerId === ownerId) await fs.rm(lockPath, { force: true });
    }
  }

  return Object.freeze({ activeOwners, isStale, leaseMs, lockPathFor, timeoutMs, withLock });
}

module.exports = { createProjectLockManager, lockError, readLock };
