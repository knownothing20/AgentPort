const fsNative = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { canonicalRealpath, sameFileIdentity } = require("./path-guard.cjs");
const { sha256 } = require("./atomic-write.cjs");

const MAX_RULE_FILE_BYTES = 256 * 1024;

function ruleError(message, code = "EWORKSPACE", statusCode = 403) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeRuleFilePaths(paths = []) {
  if (!Array.isArray(paths) || paths.length > 32) {
    throw ruleError("Read-only rule files must be an array of at most 32 absolute file paths", "ERULE_FILES_CONFIG", 500);
  }
  const normalized = paths.map((entry) => {
    if (typeof entry !== "string" || !path.isAbsolute(entry) || /[\0*?\[\]]/.test(entry)) {
      throw ruleError("Read-only rule files require exact absolute paths without wildcards", "ERULE_FILES_CONFIG", 500);
    }
    return path.resolve(entry);
  });
  return Object.freeze([...new Set(normalized)]);
}

function pathEquals(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : fallback;
}

function createRuleFileReader(paths = []) {
  const allowed = new Set(normalizeRuleFilePaths(paths));

  async function readText(inputPath, options = {}) {
    // Only the configured spelling is accepted; traversal and symlink aliases
    // must not turn an outside-workspace path into an authorized rule read.
    if (!allowed.has(inputPath)) return null;
    const denied = () => ruleError("Read-only rule file must be a regular file at its configured real path");
    const before = await fs.lstat(inputPath, { bigint: true });
    if (!before.isFile() || !pathEquals(await canonicalRealpath(inputPath), inputPath)) throw denied();

    const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fsNative.constants;
    let handle;
    try {
      handle = await fs.open(inputPath, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (error) {
      if (["ELOOP", "EISDIR", "ENXIO"].includes(error?.code)) throw denied();
      throw error;
    }
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !sameFileIdentity(before, opened)) throw denied();
      const current = await fs.lstat(inputPath, { bigint: true });
      if (!current.isFile() || !sameFileIdentity(opened, current)
          || !pathEquals(await canonicalRealpath(inputPath), inputPath)) throw denied();

      const maxBytes = Math.min(positiveInt(options.maxBytes, MAX_RULE_FILE_BYTES), MAX_RULE_FILE_BYTES);
      if (opened.size > BigInt(maxBytes)) {
        throw ruleError(`Rule file exceeds maxBytes ${maxBytes}`, "EFILESIZE", 413);
      }
      const buffer = Buffer.alloc(maxBytes + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!result.bytesRead) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead > maxBytes) throw ruleError(`Rule file exceeds maxBytes ${maxBytes}`, "EFILESIZE", 413);
      const after = await handle.stat({ bigint: true });
      if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) {
        throw ruleError("Rule file changed while reading; obtain a stable version", "ESTALE", 409);
      }
      let content;
      try {
        content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytesRead));
        if (content.includes("\0")) throw new Error("Binary content");
      } catch {
        throw ruleError("Rule file must contain UTF-8 text", "ERULE_FILE_ENCODING", 415);
      }
      // A scope change must invalidate a cached workspace read, even if the
      // content is unchanged, so clients refresh the read-only metadata.
      const etag = `rule-${sha256(Buffer.from(content, "utf8"))}`;
      const lines = content.split(/\r?\n/);
      const ranged = options.startLine !== undefined || options.endLine !== undefined;
      const startLine = Math.min(positiveInt(options.startLine, 1), lines.length);
      const endLine = Math.min(Math.max(startLine, positiveInt(options.endLine, lines.length)), lines.length);
      return {
        path: inputPath,
        accessScope: "read-only-rule-file",
        readOnly: true,
        content: ranged ? lines.slice(startLine - 1, endLine).join("\n") : content,
        etag,
        etagKind: "scoped-content",
        writeEtag: null,
        size: bytesRead,
        totalLines: lines.length,
        totalLinesKnown: true,
        startLine: ranged ? startLine : 1,
        endLine: ranged ? endLine : lines.length,
        ranged,
        streamed: false,
      };
    } finally {
      await handle.close();
    }
  }

  return Object.freeze({ readText });
}

module.exports = { createRuleFileReader, normalizeRuleFilePaths, MAX_RULE_FILE_BYTES };
