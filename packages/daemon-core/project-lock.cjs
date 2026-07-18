const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pidAlive } = require("./process-utils.cjs");

const LINK_FALLBACK_CODES = new Set(["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"]);

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
    try {
      const stat = await fs.stat(lockPath);
      return {
        invalid: true,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        birthtimeMs: stat.birthtimeMs,
      };
    } catch (statError) {
      if (statError?.code === "ENOENT") return null;
      throw statError;
    }
  }
}

async function writePreparedLock(tempPath, metadata) {
  let handle = null;
  try {
    handle = await fs.open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
  } catch (error) {
    try { await handle?.close(); } catch {}
    try { await fs.rm(tempPath, { force: true }); } catch {}
    throw error;
  }
}

async function createLockFile(lockPath, metadata) {
  const tempPath = `${lockPath}.${process.pid}.${metadata.ownerId}.tmp`;
  await writePreparedLock(tempPath, metadata);
  try {
    try {
      await fs.link(tempPath, lockPath);
      return true;
    } catch (error) {
      if (error?.code === "EEXIST") return false;
      if (!LINK_FALLBACK_CODES.has(error?.code)) throw error;
    }

    let handle = null;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
      await handle.sync();
      return true;
    } catch (error) {
      if (error?.code === "EEXIST") return false;
      throw error;
    } finally {
      try { await handle?.close(); } catch {}
    }
  } finally {
    try { await fs.rm(tempPath, { force: true }); } catch {}
  }
}

function createProjectLockManager({
  locksDir,
  lockTimeoutMs = 15_000,
  lockLeaseMs = 5 * 60_000,
  lockInitializationGraceMs = 5_000,
  lockRetryMs = 100,
} = {}) {
  if (!locksDir) throw new TypeError("locksDir is required");
  const timeoutMs = intValue(lockTimeoutMs, 15_000, 0, 10 * 60_000);
  const leaseMs = intValue(lockLeaseMs, 5 * 60_000, 1000, 60 * 60_000);
  const initializationGraceMs = intValue(lockInitializationGraceMs, 5_000, 100, 60_000);
  const retryMs = intValue(lockRetryMs, 100, 1, 5_000);
  const activeOwners = new Set();

  function lockPathFor(projectRoot) {
    const key = crypto.createHash("sha256").update(path.resolve(projectRoot)).digest("hex").slice(0, 24);
    return path.join(locksDir, `${key}.lock`);
  }

  function isStale(info, now = Date.now()) {
    if (!info) return true;
    if (info.invalid) {
      const createdAtMs = Number(info.birthtimeMs || info.ctimeMs || info.mtimeMs || 0);
      return createdAtMs > 0 && now - createdAtMs >= initializationGraceMs;
    }
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
    const metadata = {
      version: 3,
      ownerId,
      pid: process.pid,
      projectRoot: normalizedRoot,
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + leaseMs).toISOString(),
    };
    let acquired = false;

    while (!acquired) {
      acquired = await createLockFile(lockPath, metadata);
      if (acquired) {
        activeOwners.add(ownerId);
        break;
      }

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
          initializing: Boolean(current?.invalid),
        });
      }
      await sleep(retryMs);
    }

    try {
      return await fn({ ownerId, lockPath, leaseMs });
    } finally {
      activeOwners.delete(ownerId);
      const current = await readLock(lockPath);
      if (current?.ownerId === ownerId) await fs.rm(lockPath, { force: true });
    }
  }

  return Object.freeze({
    activeOwners,
    initializationGraceMs,
    isStale,
    leaseMs,
    lockPathFor,
    retryMs,
    timeoutMs,
    withLock,
  });
}

module.exports = {
  createLockFile,
  createProjectLockManager,
  lockError,
  readLock,
  writePreparedLock,
};
