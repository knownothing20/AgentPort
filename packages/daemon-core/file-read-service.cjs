const crypto = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { resolveWorkspacePath } = require("./path-guard.cjs");
const { sha256 } = require("./atomic-write.cjs");

function positiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

async function readLineRangeWithHash(filePath, startLine, requestedEndLine) {
  const decoder = new StringDecoder("utf8");
  const hash = crypto.createHash("sha256");
  const selected = [];
  let pending = "";
  let lineNumber = 0;
  let endedWithNewline = false;

  function acceptLine(rawLine) {
    lineNumber += 1;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (lineNumber >= startLine && lineNumber <= requestedEndLine) selected.push(line);
  }

  const stream = fsSync.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
    const text = pending + decoder.write(chunk);
    const parts = text.split("\n");
    pending = parts.pop();
    for (const part of parts) acceptLine(part);
    endedWithNewline = text.endsWith("\n");
  }

  pending += decoder.end();
  if (pending.length > 0 || endedWithNewline || lineNumber === 0) acceptLine(pending);

  const actualStartLine = Math.min(startLine, Math.max(lineNumber, 1));
  const actualEndLine = Math.min(requestedEndLine, Math.max(lineNumber, actualStartLine));
  return {
    content: selected.join("\n"),
    etag: hash.digest("hex"),
    totalLines: lineNumber,
    startLine: actualStartLine,
    endLine: actualEndLine,
  };
}

function createFileReadService({ workspaceRoot, defaultMaxBytes = 2 * 1024 * 1024 } = {}) {
  if (!workspaceRoot) throw new TypeError("workspaceRoot is required");

  async function stat(inputPath) {
    const resolved = await resolveWorkspacePath(workspaceRoot, inputPath, { mustExist: true });
    const value = await fs.stat(resolved.realPath);
    return {
      path: path.relative(resolved.root, resolved.realPath).replace(/\\/g, "/") || ".",
      size: value.size,
      mtimeMs: value.mtimeMs,
      mode: value.mode,
      isFile: value.isFile(),
      isDirectory: value.isDirectory(),
    };
  }

  async function readText(inputPath, options = {}) {
    const resolved = await resolveWorkspacePath(workspaceRoot, inputPath, { mustExist: true });
    const value = await fs.stat(resolved.realPath);
    if (!value.isFile()) {
      const error = new Error("Target is not a file");
      error.code = "EISDIR";
      error.statusCode = 400;
      throw error;
    }

    const hasRange = options.startLine !== undefined || options.endLine !== undefined;
    const maxBytes = positiveInt(options.maxBytes, defaultMaxBytes, 1, 50 * 1024 * 1024);
    if (value.size > maxBytes && !hasRange) {
      const error = new Error(`File size ${value.size} exceeds maxBytes ${maxBytes}; use a line range or byte range`);
      error.code = "EFILESIZE";
      error.statusCode = 413;
      throw error;
    }

    if (hasRange) {
      const startLine = positiveInt(options.startLine, 1, 1);
      const requestedEndLine = positiveInt(options.endLine, Number.MAX_SAFE_INTEGER, startLine);
      const ranged = await readLineRangeWithHash(resolved.realPath, startLine, requestedEndLine);
      return {
        path: path.relative(resolved.root, resolved.realPath).replace(/\\/g, "/"),
        ...ranged,
        size: value.size,
        ranged: true,
        streamed: true,
      };
    }

    const fullContent = await fs.readFile(resolved.realPath, "utf8");
    const lines = fullContent.split(/\r?\n/);
    return {
      path: path.relative(resolved.root, resolved.realPath).replace(/\\/g, "/"),
      content: fullContent,
      etag: sha256(Buffer.from(fullContent, "utf8")),
      size: value.size,
      totalLines: lines.length,
      startLine: 1,
      endLine: lines.length,
      ranged: false,
      streamed: false,
    };
  }

  async function readBytes(inputPath, options = {}) {
    const resolved = await resolveWorkspacePath(workspaceRoot, inputPath, { mustExist: true });
    const value = await fs.stat(resolved.realPath);
    if (!value.isFile()) {
      const error = new Error("Target is not a file");
      error.statusCode = 400;
      throw error;
    }

    const offset = positiveInt(options.offset, 0, 0, value.size);
    const remaining = Math.max(0, value.size - offset);
    if (remaining === 0) {
      return {
        path: path.relative(resolved.root, resolved.realPath).replace(/\\/g, "/"),
        offset,
        bytesRead: 0,
        size: value.size,
        contentBase64: "",
      };
    }
    const length = positiveInt(options.length, Math.min(64 * 1024, remaining), 1, 5 * 1024 * 1024);
    const handle = await fs.open(resolved.realPath, "r");
    try {
      const buffer = Buffer.alloc(Math.min(length, remaining));
      const result = await handle.read(buffer, 0, buffer.length, offset);
      return {
        path: path.relative(resolved.root, resolved.realPath).replace(/\\/g, "/"),
        offset,
        bytesRead: result.bytesRead,
        size: value.size,
        contentBase64: buffer.subarray(0, result.bytesRead).toString("base64"),
      };
    } finally {
      await handle.close();
    }
  }

  async function manifest(inputPath = ".", options = {}) {
    const root = await resolveWorkspacePath(workspaceRoot, inputPath, { mustExist: true });
    const rootStat = await fs.stat(root.realPath);
    if (!rootStat.isDirectory()) {
      const error = new Error("Manifest target must be a directory");
      error.statusCode = 400;
      throw error;
    }

    const maxEntries = positiveInt(options.maxEntries, 2000, 1, 20_000);
    const maxDepth = positiveInt(options.maxDepth, 8, 0, 64);
    const entries = [];
    const queue = [{ absolute: root.realPath, depth: 0 }];
    let truncated = false;

    while (queue.length > 0) {
      const current = queue.shift();
      const children = await fs.readdir(current.absolute, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));

      for (const child of children) {
        if (entries.length >= maxEntries) {
          truncated = true;
          queue.length = 0;
          break;
        }
        const absolute = path.join(current.absolute, child.name);
        const relative = path.relative(root.root, absolute).replace(/\\/g, "/");
        if (child.isSymbolicLink()) {
          entries.push({ path: relative, type: "symlink", skipped: true });
          continue;
        }
        const childStat = await fs.stat(absolute);
        entries.push({
          path: relative,
          type: child.isDirectory() ? "directory" : "file",
          size: childStat.size,
          mtimeMs: childStat.mtimeMs,
        });
        if (child.isDirectory() && current.depth < maxDepth) {
          queue.push({ absolute, depth: current.depth + 1 });
        }
      }
    }

    return {
      root: path.relative(root.root, root.realPath).replace(/\\/g, "/") || ".",
      entries,
      count: entries.length,
      truncated,
      maxEntries,
      maxDepth,
    };
  }

  return Object.freeze({ stat, readText, readBytes, manifest });
}

module.exports = { createFileReadService, readLineRangeWithHash };
