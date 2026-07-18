const fs = require("node:fs/promises");
const path = require("node:path");
const { createJobService: createBaseJobService, jobError } = require("./job-service.cjs");
const { createJobStore, nowIso } = require("./job-store.cjs");
const { pidAlive, terminateProcessTree } = require("./process-utils.cjs");

const REDACTED = "[REDACTED]";
const SECRET_OUTPUT_KEYS = new Set([
  "authorization",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "bearertoken",
  "token",
  "password",
  "passphrase",
  "privatekey",
  "privatekeydata",
  "apikey",
  "clientsecret",
  "secret",
  "credential",
  "credentials",
  "command",
  "commandpreview",
  "env",
]);

function intValue(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function normalizedKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sanitizeUrl(value) {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return value;
  try {
    const parsed = new URL(value);
    for (const key of [...parsed.searchParams.keys()]) {
      if (SECRET_OUTPUT_KEYS.has(normalizedKey(key))) parsed.searchParams.set(key, REDACTED);
    }
    if (parsed.username) parsed.username = REDACTED;
    if (parsed.password) parsed.password = REDACTED;
    return parsed.toString();
  } catch {
    return value;
  }
}

function sanitizePublicValue(value) {
  const seen = new WeakMap();

  function visit(current, parentKey = "") {
    const key = normalizedKey(parentKey);
    if (SECRET_OUTPUT_KEYS.has(key)) return current === undefined ? undefined : REDACTED;
    if (typeof current === "string") return sanitizeUrl(current);
    if (current === null || typeof current !== "object") return current;
    if (seen.has(current)) return seen.get(current);

    if (Array.isArray(current)) {
      const next = [];
      seen.set(current, next);
      for (const item of current) next.push(visit(item));
      return next;
    }

    const next = {};
    seen.set(current, next);
    let commandRedacted = false;
    for (const [childKey, item] of Object.entries(current)) {
      const normalized = normalizedKey(childKey);
      if (["command", "commandpreview"].includes(normalized)) commandRedacted = item !== undefined && item !== null && item !== "";
      next[childKey] = visit(item, childKey);
    }
    if (commandRedacted) next.commandRedacted = true;
    return next;
  }

  return visit(value);
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readTail(filePath, maxBytes = 16 * 1024) {
  try {
    const stat = await fs.stat(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      const result = await handle.read(buffer, 0, buffer.length, start);
      return buffer.subarray(0, result.bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    return `[failed to read worker diagnostic: ${error.message}]`;
  }
}

function createJobService(options = {}) {
  const base = createBaseJobService(options);
  const store = createJobStore({ jobsDir: options.jobsDir });
  const readyTimeoutMs = intValue(
    options.workerReadyTimeoutMs ?? process.env.JOB_WORKER_READY_TIMEOUT_MS,
    5000,
    500,
    60_000,
  );

  async function workerFailure(job, reason) {
    const workerLogPath = path.join(store.paths.jobDir(job.id), "worker.log");
    const workerDiagnostic = await readTail(workerLogPath);
    let message = workerDiagnostic
      ? `${reason}\n${workerDiagnostic}`
      : reason;
    const result = {
      status: "error",
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: false,
      error: message,
      finishedAt: nowIso(),
    };
    try {
      await store.writeResult(job.id, result);
    } catch (error) {
      message += `\nFailed to persist fallback result: ${error.message}`;
    }
    const updated = await store.update(job.id, {
      status: "error",
      error: message,
      workerError: workerDiagnostic || null,
      orphanReason: reason,
      finishedAt: result.finishedAt,
    });
    return updated;
  }

  async function waitForWorker(job) {
    const workerStatePath = path.join(store.paths.jobDir(job.id), "worker.json");
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      const result = await store.readResult(job.id);
      if (result) return base.get(job.id);

      const workerState = await readJsonIfExists(workerStatePath);
      if (workerState && ["booting", "running", "finished"].includes(workerState.phase)) {
        return base.get(job.id);
      }

      const current = await store.read(job.id);
      const workerPid = current.workerPid || current.pid;
      if (!pidAlive(workerPid)) {
        return workerFailure(current, `Job worker exited before readiness (pid=${workerPid || "unknown"})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const current = await store.read(job.id);
    const workerPid = current.workerPid || current.pid;
    if (pidAlive(workerPid)) {
      await terminateProcessTree(workerPid, { forceAfterMs: 1000 }).catch(() => {});
    }
    return workerFailure(current, `Job worker did not become ready within ${readyTimeoutMs}ms`);
  }

  async function start(input = {}) {
    const started = await base.start(input);
    if (started.reused) return sanitizePublicValue(started);
    const ready = await waitForWorker(started.job);
    if (ready.status === "error" && ready.orphanReason) {
      throw jobError(ready.error || "Job worker failed during startup", "EJOB_WORKER_START", 500, {
        jobId: ready.id,
        workerError: ready.workerError || null,
      });
    }
    return sanitizePublicValue({ ...started, job: ready });
  }

  async function cancel(jobId, input = {}) {
    let job = await base.reconcile(await store.read(jobId));
    if (!["running", "starting", "cancelling"].includes(job.status)) {
      return sanitizePublicValue({ cancelled: false, alreadyFinished: true, job: base.publicJob(job) });
    }

    const requestedAt = nowIso();
    job = await store.update(jobId, { status: "cancelling", cancelRequestedAt: requestedAt });
    await store.writeCancelRequest(jobId, {
      requestedAt,
      signal: input.signal || "SIGTERM",
      requestedBy: input.clientId || null,
    });

    const workerPid = job.workerPid || job.pid;
    const workerStatePath = path.join(store.paths.jobDir(jobId), "worker.json");
    const deadline = Date.now() + intValue(input.waitTimeoutMs, 5000, 500, 30_000);
    let lastCommandPid = null;

    while (Date.now() < deadline) {
      const result = await store.readResult(jobId);
      if (result) break;

      const workerState = await readJsonIfExists(workerStatePath);
      const commandPid = Number(workerState?.commandPid || 0);
      if (commandPid > 0 && commandPid !== lastCommandPid && pidAlive(commandPid)) {
        lastCommandPid = commandPid;
        await terminateProcessTree(commandPid, { forceAfterMs: 1000 }).catch(() => {});
      }

      if (!pidAlive(workerPid)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (!(await store.readResult(jobId)) && pidAlive(workerPid)) {
      await terminateProcessTree(workerPid, { forceAfterMs: 1000 }).catch(() => {});
    }

    if (!(await store.readResult(jobId))) {
      await store.writeResult(jobId, {
        status: "cancelled",
        exitCode: null,
        signal: input.signal || "SIGTERM",
        cancelled: true,
        timedOut: false,
        finishedAt: nowIso(),
      });
    }

    job = await base.reconcile(await store.read(jobId));
    return sanitizePublicValue({ cancelled: true, job: base.publicJob(job) });
  }

  async function get(...args) { return sanitizePublicValue(await base.get(...args)); }
  async function list(...args) { return sanitizePublicValue(await base.list(...args)); }
  async function logs(...args) { return sanitizePublicValue(await base.logs(...args)); }
  async function remove(...args) { return sanitizePublicValue(await base.remove(...args)); }
  async function reconcile(...args) { return sanitizePublicValue(await base.reconcile(...args)); }
  function publicJob(job) { return sanitizePublicValue(base.publicJob(job)); }

  return Object.freeze({
    ...base,
    start,
    get,
    list,
    logs,
    cancel,
    remove,
    reconcile,
    publicJob,
    workerReadyTimeoutMs: readyTimeoutMs,
  });
}

module.exports = { createJobService, sanitizePublicValue };
