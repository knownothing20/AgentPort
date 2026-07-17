#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createCommandPolicy } = require("./packages/daemon-core/command-policy.cjs");
const { createJobService } = require("./packages/daemon-core/job-service.cjs");

function shellArg(value) {
  const text = String(value);
  if (process.platform === "win32") return `"${text.replace(/"/g, '""')}"`;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

async function waitFor(fn, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for job state");
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentport-job-service-"));
  try {
    const policy = createCommandPolicy({ allowExec: true });
    const jobs = createJobService({
      jobsDir: path.join(root, ".jobs"),
      workspaceRoot: root,
      policy,
      maxConcurrency: 1,
      queueTimeoutMs: 500,
      defaultTimeoutMs: 5000,
    });

    const script = path.join(root, "job.cjs");
    await fs.writeFile(script, "console.log('job-out'); console.error('job-err')\n", "utf8");
    const command = `${shellArg(process.execPath)} ${shellArg(script)}`;

    const started = await jobs.start({ command, cwd: root, clientId: "test", idempotencyKey: "same-job" });
    assert.equal(started.reused, false);

    const reused = await jobs.start({ command, cwd: root, clientId: "test", idempotencyKey: "same-job" });
    assert.equal(reused.reused, true);
    assert.equal(reused.job.id, started.job.id);

    await assert.rejects(
      () => jobs.start({ command: `${command} different`, cwd: root, idempotencyKey: "same-job" }),
      (error) => error?.statusCode === 409 && error?.code === "EIDEMPOTENCY_CONFLICT",
    );

    const completed = await waitFor(async () => {
      const job = await jobs.get(started.job.id);
      return job.status === "completed" ? job : null;
    });
    assert.equal(completed.exitCode, 0);

    const logs = await jobs.logs(completed.id, { maxBytes: 4096 });
    assert.match(logs.stdout.content, /job-out/);
    assert.match(logs.stderr.content, /job-err/);
    assert.ok(logs.cursor);

    const next = await jobs.logs(completed.id, { cursor: logs.cursor, maxBytes: 4096 });
    assert.equal(next.stdout.content, "");
    assert.equal(next.stderr.content, "");

    const longScript = path.join(root, "long.cjs");
    await fs.writeFile(longScript, "setInterval(() => {}, 1000)\n", "utf8");
    const running = await jobs.start({ command: `${shellArg(process.execPath)} ${shellArg(longScript)}`, cwd: root });
    const cancelled = await jobs.cancel(running.job.id);
    assert.equal(cancelled.cancelled, true);
    assert.equal((await jobs.get(running.job.id)).status, "cancelled");

    console.log("PASS job service");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
