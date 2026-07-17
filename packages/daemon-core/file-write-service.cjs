const fs = require("node:fs/promises");
const path = require("node:path");
const { resolveWorkspacePath } = require("./path-guard.cjs");
const { atomicWriteFile, sha256 } = require("./atomic-write.cjs");
const { createKeyLock } = require("./key-lock.cjs");

async function readCurrentEtag(filePath) {
  try {
    const content = await fs.readFile(filePath);
    return sha256(content);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function conflict(message, currentEtag = null) {
  const error = new Error(message);
  error.code = "EWRITE_CONFLICT";
  error.statusCode = 409;
  error.currentEtag = currentEtag;
  return error;
}

function createFileWriteService({ workspaceRoot } = {}) {
  if (!workspaceRoot) throw new TypeError("workspaceRoot is required");
  const locks = createKeyLock();

  async function writeText(inputPath, content, options = {}) {
    if (typeof content !== "string") {
      const error = new TypeError("content must be a string");
      error.statusCode = 400;
      throw error;
    }

    const resolved = await resolveWorkspacePath(workspaceRoot, inputPath, { mustExist: false });
    return locks.withLock(resolved.path, async () => {
      const currentEtag = await readCurrentEtag(resolved.path);
      const expectedEtag = String(options.expectedEtag || "").trim();
      if (expectedEtag && expectedEtag !== currentEtag) {
        throw conflict("Write conflict: expectedEtag mismatch", currentEtag);
      }
      if (options.createOnly && currentEtag) {
        throw conflict("Write conflict: target already exists", currentEtag);
      }

      const result = await atomicWriteFile(resolved.path, content, {
        encoding: "utf8",
        mode: options.mode || 0o600,
      });
      const readback = await fs.readFile(resolved.path);
      const readbackEtag = sha256(readback);
      if (readbackEtag !== result.sha256) {
        const error = new Error("Write verification failed");
        error.code = "EWRITE_VERIFY";
        error.statusCode = 500;
        throw error;
      }

      return {
        success: true,
        path: path.relative(resolved.root, resolved.path).replace(/\\/g, "/"),
        etag: readbackEtag,
        previousEtag: currentEtag,
        bytes: result.bytes,
        atomic: true,
        verified: true,
      };
    });
  }

  async function removeFile(inputPath, options = {}) {
    const resolved = await resolveWorkspacePath(workspaceRoot, inputPath, { mustExist: true });
    return locks.withLock(resolved.realPath, async () => {
      const value = await fs.lstat(resolved.realPath);
      if (!value.isFile()) {
        const error = new Error("Only regular files can be removed through removeFile");
        error.statusCode = 400;
        throw error;
      }
      const currentEtag = await readCurrentEtag(resolved.realPath);
      const expectedEtag = String(options.expectedEtag || "").trim();
      if (expectedEtag && expectedEtag !== currentEtag) {
        throw conflict("Delete conflict: expectedEtag mismatch", currentEtag);
      }
      await fs.rm(resolved.realPath);
      return {
        success: true,
        path: path.relative(resolved.root, resolved.realPath).replace(/\\/g, "/"),
        previousEtag: currentEtag,
      };
    });
  }

  return Object.freeze({ writeText, removeFile, activeLocks: locks.size });
}

module.exports = { createFileWriteService };
