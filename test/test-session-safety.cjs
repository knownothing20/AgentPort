const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { createDevelopmentSessionService } = require('../packages/daemon-core/development-session-service.cjs');
const { createDevelopmentFrontServer } = require('../daemon/development-gateway.cjs');
const { createProjectLockManager } = require('../packages/daemon-core/project-lock.cjs');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentport-session-safety-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const worktrees = path.join(root, 'worktrees');
  const sessions = path.join(root, 'sessions');
  await fs.mkdir(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'AgentPort Test']);
  git(repo, ['config', 'user.email', 'agentport@example.com']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(repo, 'sentinel.txt'), 'base\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'fixture']);
  const service = createDevelopmentSessionService({ workspaceRoot: root, sessionsDir: sessions, worktreesDir: worktrees });
  await service.init();
  return { root, repo, worktrees, sessions, service };
}

test('T01 existing target is a conflict and preserves its sentinel', async (t) => {
  const { service, repo, worktrees } = await fixture(t);
  const target = path.join(worktrees, 'existing');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'sentinel.txt'), 'keep');
  const outcome = await service.create({ projectRoot: repo, sessionId: 'existing' }).then(() => null, (error) => error);
  assert.equal(await fs.readFile(path.join(target, 'sentinel.txt'), 'utf8'), 'keep', 'existing directory was deleted');
  assert.equal(outcome?.code, 'ESESSION_EXISTS');
});

test('T01 malformed IDs cannot remove the managed root or its parent', async (t) => {
  for (const sessionId of ['.', '..', '...', 'bad.', '../escape', '..\\escape', '/absolute', 'x/y', 'x\\y', '']) {
    const { service, root, repo, worktrees } = await fixture(t);
    await fs.writeFile(path.join(worktrees, 'sentinel.txt'), 'managed');
    await fs.writeFile(path.join(root, 'sentinel.txt'), 'parent');
    const outcome = await service.create({ projectRoot: repo, sessionId }).then(() => null, (error) => error);
    assert.equal(await fs.readFile(path.join(worktrees, 'sentinel.txt'), 'utf8'), 'managed', `root changed for ${JSON.stringify(sessionId)}`);
    assert.equal(await fs.readFile(path.join(root, 'sentinel.txt'), 'utf8'), 'parent');
    assert.equal(outcome?.code, 'EINVAL', `accepted ${JSON.stringify(sessionId)}`);
  }
});

test('T01 existing junction/symlink and outside target both survive', async (t) => {
  const { service, root, repo, worktrees } = await fixture(t);
  const outside = path.join(root, 'outside-managed-root');
  const link = path.join(worktrees, 'linked');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'sentinel.txt'), 'outside');
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const outcome = await service.create({ projectRoot: repo, sessionId: 'linked' }).then(() => null, (error) => error);
  assert.equal(await fs.readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'outside');
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true, 'existing link was replaced');
  assert.equal(outcome?.code, 'ESESSION_EXISTS');
});

test('T01 failed creation only reclaims its own empty or registered resources', async (t) => {
  const { service, repo, sessions, worktrees, root } = await fixture(t);
  const mainHead = git(repo, ['rev-parse', 'main']);
  await assert.rejects(() => service.create({ projectRoot: repo, sessionId: 'branch-conflict', branchName: 'main' }));
  assert.equal(git(repo, ['rev-parse', 'main']), mainHead);
  await assert.rejects(() => fs.lstat(path.join(worktrees, 'branch-conflict')), { code: 'ENOENT' });

  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'sentinel.txt'), 'keep');
  for (const replace of [false, true]) {
    const id = replace ? 'replaced-failure' : 'metadata-failure';
    const branchName = `test/${id}`;
    const target = path.join(worktrees, id);
    const rename = fs.rename;
    fs.rename = async (source, destination) => {
      if (destination !== path.join(sessions, `${id}.json`)) return rename(source, destination);
      if (replace) {
        await rename(target, path.join(worktrees, `${id}-moved`));
        await fs.symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
      }
      throw Object.assign(new Error('synthetic metadata failure'), { code: 'EIO' });
    };
    let outcome;
    try { outcome = await service.create({ projectRoot: repo, sessionId: id, branchName }).then(() => null, (error) => error); }
    finally { fs.rename = rename; }
    assert.equal(outcome?.code, 'EIO');
    const branchExists = git(repo, ['branch', '--list', branchName]).length > 0;
    if (replace) {
      assert.equal((await fs.lstat(target)).isSymbolicLink(), true);
      assert.equal(branchExists, true, 'unconfirmed branch must be preserved');
      assert.ok(outcome.details.cleanupError);
    } else {
      await assert.rejects(() => fs.lstat(target), { code: 'ENOENT' });
      assert.equal(branchExists, false);
    }
    assert.equal(await fs.readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'keep');
    assert.equal(git(repo, ['rev-parse', 'main']), mainHead);
  }
});

test('T01 poisoned metadata and unowned replacement cannot be force-cleaned', async (t) => {
  const { service, root, repo, sessions } = await fixture(t);
  const session = await service.create({ projectRoot: repo, sessionId: 'owned' });
  const metaPath = path.join(sessions, 'owned.json');
  const original = await fs.readFile(metaPath, 'utf8');
  for (const worktreePath of [root, path.dirname(session.worktreePath), repo]) {
    await fs.writeFile(metaPath, JSON.stringify({ ...JSON.parse(original), worktreePath }));
    await assert.rejects(() => service.cleanup(session.id, { force: true, confirm: session.id }), { code: 'ESESSION_PATH' });
    assert.equal(await fs.readFile(path.join(repo, 'sentinel.txt'), 'utf8'), 'base\n');
  }
  await fs.writeFile(metaPath, original);
  git(repo, ['worktree', 'remove', session.worktreePath]);
  await fs.mkdir(session.worktreePath);
  await fs.writeFile(path.join(session.worktreePath, 'sentinel.txt'), 'replacement');
  await assert.rejects(() => service.cleanup(session.id, { force: true, confirm: session.id }));
  assert.equal(await fs.readFile(path.join(session.worktreePath, 'sentinel.txt'), 'utf8'), 'replacement');
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'sentinel.txt'), 'outside');
  await fs.rename(session.worktreePath, path.join(root, 'replacement'));
  await fs.symlink(outside, session.worktreePath, process.platform === 'win32' ? 'junction' : 'dir');
  for (const action of ['merge', 'rollback', 'cleanup']) {
    await assert.rejects(() => service[action](session.id, { force: true, confirm: session.id }), { code: 'ESESSION_PATH' });
    assert.equal((await fs.lstat(session.worktreePath)).isSymbolicLink(), true);
    assert.equal(await fs.readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'outside');
  }
});

test('T01 a changed managed-root junction cannot redirect create or cleanup', async (t) => {
  const { service, root, repo, worktrees } = await fixture(t);
  const session = await service.create({ projectRoot: repo, sessionId: 'root-owner' });
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'sentinel.txt'), 'outside');
  const originalRoot = path.join(root, 'original-worktrees');
  await fs.rename(worktrees, originalRoot);
  await fs.symlink(outside, worktrees, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => service.create({ projectRoot: repo, sessionId: 'redirected' }), { code: 'ESESSION_PATH' });
  await assert.rejects(() => service.cleanup(session.id, { force: true, confirm: session.id }), { code: 'ESESSION_PATH' });
  assert.equal(await fs.readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'outside');
  await assert.rejects(() => fs.lstat(path.join(outside, 'redirected')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(originalRoot, session.id, 'sentinel.txt'), 'utf8'), 'base\n');
});

test('T01 Git refusal does not trigger recursive force deletion', async (t) => {
  const { service, repo } = await fixture(t);
  const session = await service.create({ projectRoot: repo, sessionId: 'locked' });
  git(repo, ['worktree', 'lock', session.worktreePath]);
  await fs.writeFile(path.join(session.worktreePath, 'sentinel.txt'), 'keep');
  await assert.rejects(() => service.cleanup(session.id, { force: true, confirm: session.id }), (error) => error.code === 128 && /locked/.test(error.message));
  assert.equal(await fs.readFile(path.join(session.worktreePath, 'sentinel.txt'), 'utf8'), 'keep');
  assert.equal((await service.status(session.id)).status, 'active');
  assert.ok(git(repo, ['branch', '--list', session.branch]));
  git(repo, ['worktree', 'unlock', session.worktreePath]);
  assert.equal((await service.cleanup(session.id, { force: true, confirm: session.id })).cleaned, true);
});

test('T02 direct service calls reject attached jobs without runtime evidence', async (t) => {
  const { service, repo } = await fixture(t);
  const session = await service.create({ projectRoot: repo, sessionId: 'busy' });
  await service.attachJob(session.id, { jobId: 'job-1' });
  const sentinel = path.join(session.worktreePath, 'sentinel.txt');
  await fs.writeFile(sentinel, 'keep');
  const head = git(repo, ['rev-parse', 'HEAD']);
  for (const action of ['rollback', 'merge', 'cleanup']) {
    await assert.rejects(() => service[action](session.id, { force: true, confirm: session.id }), { code: 'ESESSION_JOBS_ACTIVE' });
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep');
    assert.equal(git(repo, ['rev-parse', 'HEAD']), head);
  }
  for (const jobStates of [[], [{ jobId: 'different', status: 'completed' }], [{ jobId: 'job-1', status: 'cancelled' }], [{ jobId: 'job-1', status: 'running', processAlive: false }], [{ jobId: 'job-1', status: 'completed' }, { jobId: 'job-1', status: 'running' }]]) {
    await assert.rejects(() => service.rollback(session.id, { confirm: session.id }, jobStates), { code: 'ESESSION_JOBS_ACTIVE' });
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep');
  }
  const stopped = [{ jobId: 'job-1', status: 'cancelled', processAlive: false }];
  assert.equal((await service.rollback(session.id, { confirm: session.id }, stopped)).rolledBack, true);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'base\n');
  assert.equal((await service.cleanup(session.id, { confirm: session.id }, stopped)).cleaned, true);
  await assert.rejects(() => fs.lstat(session.worktreePath), { code: 'ENOENT' });
});

test('T02 missing or malformed persisted jobs cannot mutate session sentinels', async (t) => {
  const { service, repo, sessions } = await fixture(t);
  const session = await service.create({ projectRoot: repo, sessionId: 'invalid-jobs' });
  const metaPath = path.join(sessions, `${session.id}.json`);
  const original = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  const sentinel = path.join(session.worktreePath, 'sentinel.txt');
  await fs.writeFile(sentinel, 'keep');
  const head = git(repo, ['rev-parse', 'HEAD']);
  for (const jobs of [undefined, null, '', false, 0, {}, 'missing']) {
    const meta = { ...original, jobs };
    if (jobs === undefined) delete meta.jobs;
    await fs.writeFile(metaPath, JSON.stringify(meta));
    for (const action of ['rollback', 'merge', 'cleanup']) {
      await assert.rejects(() => service[action](session.id, { force: true, confirm: session.id }), { code: 'ESESSION_JOBS_ACTIVE' });
      assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep');
      assert.equal(git(repo, ['rev-parse', 'HEAD']), head);
      assert.deepEqual(JSON.parse(await fs.readFile(metaPath, 'utf8')), meta);
    }
  }
});

test('T02 rollback waits for the existing project lock and rechecks metadata', async (t) => {
  const { service, repo, sessions } = await fixture(t);
  const session = await service.create({ projectRoot: repo, sessionId: 'rollback-lock' });
  const metaPath = path.join(sessions, `${session.id}.json`);
  const original = await fs.readFile(metaPath, 'utf8');
  const sentinel = path.join(session.worktreePath, 'sentinel.txt');
  await fs.writeFile(sentinel, 'keep');
  const locks = createProjectLockManager({ locksDir: path.join(sessions, '.locks') });
  for (const [update, expectedCode] of [
    [{ jobs: [{ jobId: 'job-added-while-waiting' }] }, 'ESESSION_JOBS_ACTIVE'],
    [{ worktreePath: repo }, 'ESESSION_PATH'],
  ]) {
    let pending;
    try {
      await locks.withLock(session.repoRoot, async ({ lockPath }) => {
        const link = fs.link;
        let signalWaiting;
        const waiting = new Promise((resolve) => { signalWaiting = resolve; });
        fs.link = async (source, destination) => {
          try { return await link(source, destination); }
          catch (error) {
            if (destination === lockPath && error.code === 'EEXIST') signalWaiting('waiting');
            throw error;
          }
        };
        try {
          pending = service.rollback(session.id, { confirm: session.id }).then((value) => ({ value }), (error) => ({ error }));
          assert.equal(await Promise.race([waiting, pending.then(() => 'finished')]), 'waiting', 'rollback bypassed the held project lock');
          assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep');
          await fs.writeFile(metaPath, JSON.stringify({ ...JSON.parse(original), ...update }));
        } finally { fs.link = link; }
      });
      assert.equal((await pending).error?.code, expectedCode);
      assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep');
    } finally {
      await pending;
      await fs.writeFile(metaPath, original);
    }
  }
});

test('T02 terminal error requires explicit stopped evidence for rollback and cleanup', async (t) => {
  const { service, repo } = await fixture(t);
  const session = await service.create({ projectRoot: repo, sessionId: 'terminal-error' });
  await service.attachJob(session.id, { jobId: 'job-error' });
  const sentinel = path.join(session.worktreePath, 'sentinel.txt');
  await fs.writeFile(sentinel, 'keep');
  for (const processAlive of [undefined, true]) {
    const jobs = [{ jobId: 'job-error', status: 'error', processAlive }];
    for (const action of ['rollback', 'cleanup']) {
      await assert.rejects(() => service[action](session.id, { force: true, confirm: session.id }, jobs), { code: 'ESESSION_JOBS_ACTIVE' });
      assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep');
    }
  }
  const stopped = [{ jobId: 'job-error', status: 'error', processAlive: false, error: 'synthetic nonzero execution' }];
  assert.equal((await service.rollback(session.id, { confirm: session.id }, stopped)).rolledBack, true);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'base\n');
  assert.equal((await service.cleanup(session.id, { confirm: session.id }, stopped)).cleaned, true);
  await assert.rejects(() => fs.lstat(session.worktreePath), { code: 'ENOENT' });
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function request(port, action, force) {
  const body = JSON.stringify({ force, confirm: 'session', jobs: [{ jobId: 'job-1', status: 'completed' }], processAlive: false });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/api/dev/sessions/session/${action}`, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('T02 gateway blocks uncertain/active jobs even with force; known idle works', async (t) => {
  let reply = { status: 'completed' };
  let mutations = 0;
  let queries = 0;
  const base = http.createServer((req, res) => {
    queries += 1;
    if (reply.disconnect) return req.socket.destroy();
    res.statusCode = reply.httpStatus || 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(reply.missing ? {} : { success: reply.success !== false, job: { id: reply.wrongId ? 'other-job' : 'job-1', ...reply } }));
  });
  const basePort = await listen(base);
  t.after(() => new Promise((resolve) => base.close(resolve)));
  const session = { id: 'session', clientId: 'test-client', jobs: [{ jobId: 'job-1' }] };
  const service = { status: async () => session };
  for (const action of ['merge', 'rollback', 'cleanup']) service[action] = async () => { mutations += 1; return { success: true }; };
  const front = createDevelopmentFrontServer({ baseOrigin: `http://127.0.0.1:${basePort}`, configLoader: { load: async () => ({ workspaceRoot: os.tmpdir(), values: {} }) }, authorizeApi: () => 'test-client', serviceFactory: () => service });
  const port = await listen(front);
  t.after(() => new Promise((resolve) => front.close(resolve)));
  for (reply of [
    ...['starting', 'queued', 'running', 'cancelling', 'unknown', 'unrecognized'].map((status) => ({ status, processAlive: false })),
    ...['cancelled', 'timeout', 'orphaned', 'error'].flatMap((status) => [{ status }, { status, processAlive: true }]),
    { status: 'completed', processAlive: true }, { status: 'failed', processAlive: true },
    { status: 'completed', httpStatus: 404 }, { status: 'completed', httpStatus: 500 },
    { status: 'completed', success: false }, { status: 'completed', wrongId: true }, {}, { missing: true }, { disconnect: true },
  ]) {
    for (const force of [false, true]) for (const action of ['merge', 'rollback', 'cleanup']) {
      const response = await request(port, action, force);
      assert.equal(response.status, 409, `${action} force=${force} allowed ${JSON.stringify(reply)}`);
      assert.equal(response.data.code, 'ESESSION_JOBS_ACTIVE');
      assert.equal(mutations, 0);
    }
  }
  assert.ok(queries > 0);
  for (const jobs of [undefined, null, '', false, 0, {}, [null], [{}]]) {
    session.jobs = jobs;
    for (const action of ['merge', 'rollback', 'cleanup']) {
      assert.equal((await request(port, action, true)).status, 409);
      assert.equal(mutations, 0);
    }
  }
  session.jobs = [{ jobId: 'job-1' }];
  for (reply of [{ status: 'completed' }, { status: 'failed' }, ...['cancelled', 'timeout', 'orphaned', 'error'].map((status) => ({ status, processAlive: false }))]) {
    for (const force of [false, true]) for (const action of ['merge', 'rollback', 'cleanup']) assert.equal((await request(port, action, force)).status, 200);
  }
  assert.equal(mutations, 36);
  session.jobs = [];
  const priorQueries = queries;
  for (const action of ['merge', 'rollback', 'cleanup']) assert.equal((await request(port, action, true)).status, 200);
  assert.equal(queries, priorQueries);
  assert.equal(mutations, 39);
});
