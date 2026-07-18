const fs = require('node:fs');

function read(file) { return fs.readFileSync(file, 'utf8'); }
function write(file, value) { fs.writeFileSync(file, value); }
function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, got ${count}`);
  return source.replace(before, after);
}


// Project lock integration.
{
  const file = 'packages/daemon-core/project-lock.cjs';
  let source = read(file);
  source = source.replace('lockLeaseMs, 5 * 60_000, 30_000, 60 * 60_000', 'lockLeaseMs, 5 * 60_000, 1000, 60 * 60_000');
  write(file, source);
}
{
  const file = 'packages/daemon-core/development-session-service.cjs';
  let source = read(file);
  source = replaceOnce(
    source,
    "const { pidAlive, terminateProcessTree } = require('./process-utils.cjs');",
    "const { pidAlive, terminateProcessTree } = require('./process-utils.cjs');\nconst { createProjectLockManager } = require('./project-lock.cjs');",
    'session lock import',
  );
  source = replaceOnce(source, "function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }\n", '', 'remove old lock hash');
  source = replaceOnce(
    source,
    "  lockTimeoutMs = 15_000,\n  gitTimeoutMs = 60_000,",
    "  lockTimeoutMs = 15_000,\n  projectLockLeaseMs = 5 * 60_000,\n  gitTimeoutMs = 60_000,",
    'session lock options',
  );
  const oldLock = `  async function withProjectLock(projectRoot, fn) {\n    await init();\n    const lockPath = path.join(locksDir, \`${'${hash(path.resolve(projectRoot)).slice(0, 24)}'}.lock\`);\n    const deadline = Date.now() + lockTimeoutMs;\n    let handle = null;\n    while (!handle) {\n      try {\n        handle = await fs.open(lockPath, 'wx', 0o600);\n        await handle.writeFile(JSON.stringify({ pid: process.pid, projectRoot: path.resolve(projectRoot), acquiredAt: nowIso(), expiresAt: new Date(Date.now() + Math.max(lockTimeoutMs * 2, 30_000)).toISOString() }));\n      } catch (error) {\n        if (error?.code !== 'EEXIST') throw error;\n        let stale = false;\n        try {\n          const info = JSON.parse(await fs.readFile(lockPath, 'utf8'));\n          stale = Date.parse(info.expiresAt || 0) < Date.now() || (info.pid && !pidAlive(info.pid));\n        } catch { stale = true; }\n        if (stale) { await fs.rm(lockPath, { force: true }); continue; }\n        if (Date.now() >= deadline) throw errorWith('Project operation lock timed out', 'EPROJECT_LOCKED', 423, { projectRoot });\n        await sleep(100);\n      }\n    }\n    try { return await fn(); }\n    finally { try { await handle.close(); } catch {} await fs.rm(lockPath, { force: true }); }\n  }`;
  const newLock = `  const projectLocks = createProjectLockManager({ locksDir, lockTimeoutMs, lockLeaseMs: projectLockLeaseMs });\n  async function withProjectLock(projectRoot, fn) {\n    await init();\n    return projectLocks.withLock(projectRoot, fn);\n  }`;
  source = replaceOnce(source, oldLock, newLock, 'replace project lock');
  source = replaceOnce(
    source,
    "leaseActive: sessions.filter((item) => item.leaseActive).length, sessionsDir: sessionRoot, worktreesDir: worktreeRoot }",
    "leaseActive: sessions.filter((item) => item.leaseActive).length, sessionsDir: sessionRoot, worktreesDir: worktreeRoot, projectLockLeaseMs: projectLocks.leaseMs }",
    'session stats lock lease',
  );
  write(file, source);
}

// Keep admin audit identity stable rather than accepting a caller-supplied client id.
{
  const file = 'daemon/auth-context.cjs';
  let source = read(file);
  source = replaceOnce(source, '  const clientId = mappedClientId || requested || adminClientId(token);', '  const clientId = mappedClientId || adminClientId(token);', 'stable admin client id');
  write(file, source);
}
