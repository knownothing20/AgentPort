const fs = require("node:fs/promises");
const path = require("node:path");

function positiveInteger(value, fallback, min = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function createAuditLogWriter({
  filePath,
  maxBytes = 10 * 1024 * 1024,
  maxFiles = 5,
} = {}) {
  if (!filePath) throw new TypeError("filePath is required");
  const target = path.resolve(filePath);
  const limit = positiveInteger(maxBytes, 10 * 1024 * 1024, 1024);
  const copies = positiveInteger(maxFiles, 5, 1);
  const lockPath = target + ".rotate.lock";
  let queue = Promise.resolve();

  async function rotateIfNeeded(incomingBytes) {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    let current;
    try {
      current = await fs.stat(target);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (current.size + incomingBytes <= limit) return;

    let lock;
    try {
      lock = await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") return;
      throw error;
    }

    try {
      try {
        current = await fs.stat(target);
      } catch (error) {
        if (error?.code === "ENOENT") return;
        throw error;
      }
      if (current.size + incomingBytes <= limit) return;

      await fs.rm(target + "." + copies, { force: true });
      for (let index = copies - 1; index >= 1; index -= 1) {
        try {
          await fs.rename(target + "." + index, target + "." + (index + 1));
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      try {
        await fs.rename(target, target + ".1");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    } finally {
      await lock.close().catch(() => {});
      await fs.rm(lockPath, { force: true }).catch(() => {});
    }
  }

  function append(record) {
    const line = typeof record === "string"
      ? (record.endsWith("\n") ? record : record + "\n")
      : JSON.stringify(record) + "\n";
    const task = queue.then(async () => {
      await rotateIfNeeded(Buffer.byteLength(line));
      await fs.appendFile(target, line, { encoding: "utf8", mode: 0o600 });
    });
    queue = task.catch(() => {});
    return task;
  }

  return Object.freeze({
    append,
    filePath: target,
    maxBytes: limit,
    maxFiles: copies,
  });
}

module.exports = { createAuditLogWriter };