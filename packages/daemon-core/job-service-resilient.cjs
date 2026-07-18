const fs = require("node:fs/promises");
const path = require("node:path");
const { createJobService: createBaseJobService, jobError } = require("./job-service.cjs");
const { createJobStore, nowIso } = require("./job-store.cjs");
const { pidAlive, terminateProcessTree } = require("./process-utils.cjs");

function intValue(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
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
    const message = workerDiagnostic
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
    try { await store.writeResult(job.id, result); }
    catch (error) {
      message.concat(`\nFailed to persist fallback result: ${error.message}`);
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
    if (started.reused) return started;
    const ready = await waitForWorker(started.job);
    if (ready.status === "error" && ready.orphanReason) {
      throw jobError(ready.error || "Job worker failed during startup", "EJOB_WORKER_START", 500, {
        jobId: ready.id,
        workerError: ready.workerError || null,
      });
    }
    return { ...started, job: ready };
  }

  return Object.freeze({
    ...base,
    start,
    workerReadyTimeoutMs: readyTimeoutMs,
  });
}

module.exports = { createJobService };
