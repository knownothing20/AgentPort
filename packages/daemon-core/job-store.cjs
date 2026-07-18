const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { atomicWriteFile, sha256 } = require("./atomic-write.cjs");
const { createKeyLock } = require("./key-lock.cjs");

function nowIso() { return new Date().toISOString(); }

function safeJobId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    const error = new Error("Invalid job id");
    error.code = "EINVAL";
    error.statusCode = 400;
    throw error;
  }
  return id;
}

function createJobId(prefix = "job") {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

async function readJsonIfExists(filePath) {
  try { return await readJson(filePath); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function createJobStore({ jobsDir } = {}) {
  if (!jobsDir) throw new TypeError("jobsDir is required");
  const root = path.resolve(jobsDir);
  const keysDir = path.join(root, "_keys");
  const lock = createKeyLock();

  function jobDir(jobId) { return path.join(root, safeJobId(jobId)); }
  function metaPath(jobId) { return path.join(jobDir(jobId), "meta.json"); }
  function resultPath(jobId) { return path.join(jobDir(jobId), "result.json"); }
  function cancelPath(jobId) { return path.join(jobDir(jobId), "cancel.json"); }
  function stdoutPath(jobId) { return path.join(jobDir(jobId), "stdout.log"); }
  function stderrPath(jobId) { return path.join(jobDir(jobId), "stderr.log"); }
  function keyHash(key) { return sha256(Buffer.from(String(key), "utf8")); }
  function keyPath(key) { return path.join(keysDir, `${keyHash(key)}.json`); }

  async function ensure() {
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(keysDir, { recursive: true });
  }

  async function writeJsonAtomic(filePath, value, mode = 0o600) {
    await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode });
  }

  async function create(job) {
    await ensure();
    const id = safeJobId(job.id || createJobId());
    const createdAt = job.createdAt || nowIso();
    const value = {
      ...job,
      id,
      createdAt,
      updatedAt: job.updatedAt || createdAt,
      stdoutPath: stdoutPath(id),
      stderrPath: stderrPath(id),
    };
    await fs.mkdir(jobDir(id), { recursive: false });
    await fs.writeFile(stdoutPath(id), "", { encoding: "utf8", mode: 0o600 });
    await fs.writeFile(stderrPath(id), "", { encoding: "utf8", mode: 0o600 });
    await writeJsonAtomic(metaPath(id), value);
    return value;
  }

  async function read(jobId) { return readJson(metaPath(jobId)); }

  async function update(jobId, changes) {
    return lock.withLock(`job:${safeJobId(jobId)}`, async () => {
      const current = await read(jobId);
      const next = { ...current, ...changes, id: current.id, updatedAt: nowIso() };
      await writeJsonAtomic(metaPath(jobId), next);
      return next;
    });
  }

  async function writeResult(jobId, result) {
    return lock.withLock(`result:${safeJobId(jobId)}`, async () => {
      const existing = await readJsonIfExists(resultPath(jobId));
      if (existing) return existing;
      const value = { ...result, jobId: safeJobId(jobId), finishedAt: result.finishedAt || nowIso() };
      await writeJsonAtomic(resultPath(jobId), value);
      return value;
    });
  }

  async function readResult(jobId) { return readJsonIfExists(resultPath(jobId)); }

  async function writeCancelRequest(jobId, request = {}) {
    const id = safeJobId(jobId);
    const value = {
      requested: true,
      jobId: id,
      requestedAt: request.requestedAt || nowIso(),
      signal: request.signal || "SIGTERM",
      requestedBy: request.requestedBy || null,
    };
    await writeJsonAtomic(cancelPath(id), value);
    return value;
  }

  async function readCancelRequest(jobId) { return readJsonIfExists(cancelPath(jobId)); }

  async function list({ limit = 50, status } = {}) {
    await ensure();
    const entries = await fs.readdir(root, { withFileTypes: true });
    const jobs = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "_keys") continue;
      try {
        const job = await read(entry.name);
        if (!status || job.status === status) jobs.push(job);
      } catch {}
    }
    jobs.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    return jobs.slice(0, Math.max(1, Math.min(Number(limit) || 50, 500)));
  }

  async function remove(jobId) {
    const id = safeJobId(jobId);
    await fs.rm(jobDir(id), { recursive: true, force: true, maxRetries: process.platform === "win32" ? 20 : 5, retryDelay: 100 });
    return { deleted: true, jobId: id };
  }

  async function readIdempotency(key) {
    if (!key) return null;
    await ensure();
    return readJsonIfExists(keyPath(key));
  }

  async function writeIdempotency(key, value) {
    if (!key) return null;
    await ensure();
    const record = { ...value, keyHash: keyHash(key), updatedAt: nowIso() };
    await writeJsonAtomic(keyPath(key), record);
    return record;
  }

  async function removeIdempotency(key) {
    if (!key) return;
    await fs.rm(keyPath(key), { force: true });
  }

  function withIdempotencyLock(key, fn) {
    return lock.withLock(`idem:${keyHash(key || "no-key")}`, fn);
  }

  return Object.freeze({
    root,
    ensure,
    create,
    read,
    update,
    list,
    remove,
    readResult,
    writeResult,
    readCancelRequest,
    writeCancelRequest,
    readIdempotency,
    writeIdempotency,
    removeIdempotency,
    withIdempotencyLock,
    paths: Object.freeze({ jobDir, metaPath, resultPath, cancelPath, stdoutPath, stderrPath, keyPath }),
  });
}

module.exports = { createJobId, createJobStore, nowIso, safeJobId };
