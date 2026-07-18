const fs = require('node:fs');

function read(file) { return fs.readFileSync(file, 'utf8'); }
function write(file, value) { fs.writeFileSync(file, value); }
function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, got ${count}`);
  return source.replace(before, after);
}

// Long-running lock ownership test.
write('test-project-lock.cjs', `const assert = require('node:assert/strict');\nconst fs = require('node:fs/promises');\nconst os = require('node:os');\nconst path = require('node:path');\nconst { createProjectLockManager } = require('./packages/daemon-core/project-lock.cjs');\n\nfunction sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }\n\nasync function main() {\n  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentport-project-lock-'));\n  const locksDir = path.join(root, 'locks');\n  const project = path.join(root, 'repo');\n  await fs.mkdir(project);\n  const manager = createProjectLockManager({ locksDir, lockTimeoutMs: 200, lockLeaseMs: 1000 });\n  try {\n    let entered = false;\n    const first = manager.withLock(project, async () => { entered = true; await sleep(1400); return 'first'; });\n    while (!entered) await sleep(10);\n    await sleep(1100);\n    await assert.rejects(() => manager.withLock(project, async () => 'stolen'), (error) => error?.code === 'EPROJECT_LOCKED');\n    assert.equal(await first, 'first');\n    assert.equal(await manager.withLock(project, async () => 'after-release'), 'after-release');\n    const lockPath = manager.lockPathFor(project);\n    await fs.writeFile(lockPath, JSON.stringify({ ownerId: 'dead', pid: 99999999, expiresAt: new Date(Date.now() + 60_000).toISOString() }));\n    assert.equal(await manager.withLock(project, async () => 'recovered'), 'recovered');\n  } finally {\n    await fs.rm(root, { recursive: true, force: true });\n  }\n  console.log('PASS live project locks cannot expire or be stolen, and dead owners are recoverable');\n}\n\nmain().catch((error) => { console.error(error.stack || error.message); process.exit(1); });\n`);

// Scripts and CI.
{
  const file = 'package.json';
  const pkg = JSON.parse(read(file));
  pkg.scripts['test:sessions'] = 'node test-project-lock.cjs && node test-development-session-service.cjs && node test-development-gateway.cjs';
  write(file, `${JSON.stringify(pkg, null, 2)}\n`);
}
{
  const file = '.github/workflows/ci.yml';
  let source = read(file);
  const sessionPair = '      - run: node test-development-session-service.cjs\n      - run: node test-development-gateway.cjs';
  if (source.split(sessionPair).length - 1 !== 2) throw new Error('ci project lock: expected two session pairs');
  source = source.replaceAll(sessionPair, '      - run: node test-project-lock.cjs\n' + sessionPair);
  write(file, source);
}

// Current release documentation.
{
  const file = 'docs/PHASE5_DEVELOPMENT_SESSIONS.md';
  let source = read(file);
  const old = `A full spawned three-layer production-entrypoint smoke-test file was attempted\nduring this phase but was not added because the connected GitHub write action\nwas blocked. The committed tests validate the Session service, front Gateway,\nclient adapter, persistent Job integration, and MCP tools separately. A real\nDebian gray deployment and restart test remains required before merging.\n\n## Remaining work\n\n- real Debian gray deployment and restart validation\n- a richer browser Dashboard over \`/api/dev/overview\`\n- automatic stale-session cleanup policies\n- review/approval states before merge\n- push and pull-request helpers\n- conflict-resolution workflows\n- optional Streamable HTTP MCP transport`;
  const replacement = `Validation now includes the spawned public Gateway components, Windows and Ubuntu Node.js 20/22 matrices, persistent Job lifecycle tests, 50 rapid Session diff/status reads, owner/admin authorization boundaries, client-scoped Job idempotency, bounded ranged file reads, and long-running project-lock contention.\n\nPhysical Windows + Debian gray validation completed for instant Jobs, process-tree cleanup, clean dependency installation, credential redaction, and the full Worktree Session lifecycle. Debian Session Service and Gateway repeated runs passed, including 30/30 real diff reads with non-empty status, branch, and head values.\n\n## Remaining work\n\n- a richer browser Dashboard over \`/api/dev/overview\`\n- automatic stale-session cleanup policies\n- push and pull-request helpers\n- conflict-resolution workflows\n- optional Streamable HTTP MCP transport\n- production deployment and rollback execution after merge approval`;
  source = replaceOnce(source, old, replacement, 'phase5 validation status');
  write(file, source);
}
{
  const file = 'CHANGELOG.md';
  let source = read(file);
  const section = `## [3.1.0] - 2026-07-18 | Dual-end daemon, durable Jobs, and Worktree Sessions\n\n### Added\n- Added the modular V3 file, execution, persistent Job, connection-registry, and Git Worktree Session architecture while retaining compatibility entrypoints.\n- Added owner/admin authorization boundaries for Session and Job resources, client-scoped idempotency, and adversarial two-client tests.\n- Added bounded line-range reads with explicit output and scan limits, metadata cache ETags, and no unbounded full-file hashing.\n- Added owner-aware project locks that cannot expire while the owning operation is alive.\n\n### Fixed\n- Fixed zero-delay Job completion, Worker readiness diagnostics, process-tree cancellation, Windows 8.3 path handling, and temporary-directory cleanup races.\n- Fixed Session subprocess output races by waiting for stdout/stderr close before returning Git results.\n- Fixed server lockfile reproducibility and patched dependency audit findings.\n- Unified credential and command-response redaction across CLI, MCP, Runtime, Job, Session, and public daemon responses.\n\n### Validated\n- Passed Windows and Ubuntu Node.js 20/22 CI, clean server installation, moderate-level audits, repeated Windows Job tests, and physical Debian Session/Job gray validation.\n\n---\n\n`;
  source = replaceOnce(source, '# Changelog\n\n', '# Changelog\n\n' + section, 'changelog 3.1.0');
  write(file, source);
}
{
  const file = 'daemon/.env.example';
  let source = read(file);
  source = replaceOnce(source, '# AGENTPORT_PROJECT_LOCK_TIMEOUT_MS=15000\n# AGENTPORT_MAX_DIFF_BYTES=2097152', '# AGENTPORT_PROJECT_LOCK_TIMEOUT_MS=15000\n# AGENTPORT_PROJECT_LOCK_LEASE_MS=300000\n# AGENTPORT_MAX_DIFF_BYTES=2097152', 'env lock lease');
  write(file, source);
}
