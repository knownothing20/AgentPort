const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createProjectLockManager } = require('./packages/daemon-core/project-lock.cjs');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentport-project-lock-'));
  const locksDir = path.join(root, 'locks');
  const project = path.join(root, 'repo');
  await fs.mkdir(project);
  const manager = createProjectLockManager({ locksDir, lockTimeoutMs: 200, lockLeaseMs: 1000 });
  try {
    let entered = false;
    const first = manager.withLock(project, async () => { entered = true; await sleep(1400); return 'first'; });
    while (!entered) await sleep(10);
    await sleep(1100);
    await assert.rejects(() => manager.withLock(project, async () => 'stolen'), (error) => error?.code === 'EPROJECT_LOCKED');
    assert.equal(await first, 'first');
    assert.equal(await manager.withLock(project, async () => 'after-release'), 'after-release');
    const lockPath = manager.lockPathFor(project);
    await fs.writeFile(lockPath, JSON.stringify({ ownerId: 'dead', pid: 99999999, expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    assert.equal(await manager.withLock(project, async () => 'recovered'), 'recovered');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log('PASS live project locks cannot expire or be stolen, and dead owners are recoverable');
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
