const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createAgentPortGateway } = require('../daemon/modular-gateway.cjs');

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function close(server) { return new Promise((resolve) => server.close(resolve)); }
let sshOriginals;
async function fixture(t, { handle, backup = true, capabilities = {}, clientId = 'client-a' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentport-runtime-replay-'));
  const { createClientRuntime } = await import('../packages/client-core/client-runtime.js');
  const { ConnectionRegistry } = await import('../packages/client-core/connection-registry.js');
  const { SSHClient } = await import('../ssh-client.js');
  const ssh = { operations: 0, commands: [] };
  if (!sshOriginals) sshOriginals = Object.fromEntries(['connect', 'disconnect', 'detectWorkspaceRoot', 'exec', 'readFile', 'writeFile', 'resolveWorkspaceCwd'].map((name) => [name, SSHClient.prototype[name]]));
  const originals = sshOriginals;
  SSHClient.prototype.connect = async function () { this.workspaceRoot = root; };
  SSHClient.prototype.disconnect = function () {};
  SSHClient.prototype.detectWorkspaceRoot = async () => root;
  SSHClient.prototype.resolveWorkspaceCwd = (cwd) => cwd;
  SSHClient.prototype.exec = async (command) => {
    if (command.includes('printf "serverId=')) return { code: 0, stdout: `serverId=srv-test\nworkspaceId=ws-test\nworkspaceRoot=${root}\n`, stderr: '' };
    ssh.operations += 1;
    ssh.commands.push(command);
    return { code: 0, stdout: './item.txt:1:needle\n', stderr: '' };
  };
  SSHClient.prototype.readFile = async () => { ssh.operations += 1; return 'ssh-read'; };
  SSHClient.prototype.writeFile = async () => { ssh.operations += 1; };
  const counts = { primary: 0, backup: 0, writes: 0, submits: 0, deletes: 0 };
  const bodies = { primary: [], backup: [] };
  const servers = [];
  const endpoints = [];
  for (const name of backup ? ['primary', 'backup'] : ['primary']) {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', async () => {
        try {
          if (req.url === '/healthz') return json(res, 200, { ok: true, serverId: 'srv-test', workspaceId: 'ws-test', workspaceRoot: root, capabilities });
          const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
          counts[name] += 1;
          bodies[name].push(body);
          if (handle) return await handle({ name, req, res, body, counts, root });
          json(res, 200, { success: true });
        } catch (error) { json(res, 500, { code: 'EFIXTURE', error: error.message }); }
      });
    });
    const port = await listen(server);
    servers.push(server);
    endpoints.push({ id: name, type: 'daemon', url: `http://127.0.0.1:${port}`, priority: name === 'primary' ? 1 : 2, clientId, timeoutMs: 1000 });
  }
  endpoints.push({ id: 'ssh', type: 'ssh', host: 'synthetic.invalid', clientId: 'client-a', priority: 10, workspaceRoot: root });
  const registry = new ConnectionRegistry({ servers: [{ id: 'srv-test', workspaceId: 'ws-test', endpoints }] });
  const runtime = await createClientRuntime({ registry, projects: new Map(), state: { load: async () => ({}), select: async () => {} }, healthTtlMs: 30_000 });
  t.after(async () => {
    runtime.close();
    for (const server of servers) await close(server);
    for (const [name, fn] of Object.entries(originals)) SSHClient.prototype[name] = fn;
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, runtime, counts, bodies, ssh, servers, endpoints };
}

test('T03 keyed writes, control, execution and mixed batch are not replayed after response loss', async (t) => {
  for (const [operation, args] of [
    ['remote_write', { path: 'sentinel.txt', content: 'once', expectedEtag: 'guard', createOnly: true }],
    ['remote_bash', { command: 'synthetic-command' }],
    ['job_cancel', { jobId: 'synthetic-job' }],
    ['remote_batch', { operations: [{ type: 'read', path: 'item.txt' }, { type: 'write', path: 'sentinel.txt', content: 'once' }] }],
  ]) {
    await t.test(operation, async (subtest) => {
      const f = await fixture(subtest, { handle: ({ req, res, name }) => name === 'primary' ? req.socket.destroy() : json(res, 200, { success: true }) });
      const outcome = await f.runtime.invoke(operation, args, { idempotencyKey: 'supplied-but-not-deduplicated' }).then(() => null, (error) => error);
      subtest.diagnostic(`${operation}: primary=${f.counts.primary}, backup=${f.counts.backup}, ssh=${f.ssh.operations}, code=${outcome?.code || 'success'}`);
      assert.equal(f.counts.primary, 1);
      assert.equal(f.counts.backup, 0);
      assert.equal(f.ssh.operations, 0);
      assert.equal(outcome?.code, 'EOUTCOME_UNKNOWN');
      assert.equal(outcome.retryable, false);
    });
  }
});

test('T05 uncertain async-script submission retains wrapper and never repeats upload', async (t) => {
  let wrapperPath;
  let accepted;
  const f = await fixture(t, { handle: async ({ req, res, body, counts }) => {
    if (req.url === '/api/fs/write') {
      counts.writes += 1;
      wrapperPath = body.path;
      await fs.mkdir(path.dirname(body.path), { recursive: true });
      await fs.writeFile(body.path, body.content);
      return json(res, 200, { success: true });
    }
    if (req.url === '/api/fs/delete') {
      counts.deletes += 1;
      await fs.rm(body.path, { force: true });
      return json(res, 200, { success: true });
    }
    if (req.url === '/api/jobs/accepted-script') return json(res, 200, { success: true, job: accepted, wrapperAvailable: await fs.access(wrapperPath).then(() => true, () => false) });
    counts.submits += 1;
    accepted = { id: 'accepted-script', status: 'queued', command: body.command, wrapperPath };
    req.socket.destroy();
  } });
  const error = await f.runtime.invoke('remote_script_async', { content: 'echo synthetic', cwd: f.root, idempotencyKey: 'script-key' }).then(() => null, (cause) => cause);
  const retained = await fs.access(wrapperPath).then(() => true, () => false);
  t.diagnostic(`script: uploads=${f.counts.writes}, submissions=${f.counts.submits}, deletes=${f.counts.deletes}, retained=${retained}`);
  assert.equal(f.counts.writes, 1);
  assert.equal(f.counts.submits, 1);
  assert.equal(f.counts.deletes, 0);
  assert.equal(f.counts.backup, 0);
  assert.equal(retained, true);
  assert.equal(error?.code, 'EOUTCOME_UNKNOWN');
  assert.equal(error.recovery.wrapperPath, wrapperPath);
  assert.equal(error.recovery.idempotencyKey, 'script-key');
  assert.equal(error.recovery.endpointId, 'primary');
  assert.equal(error.recovery.serverId, 'srv-test');
  const { createDaemonHttpTransport } = await import('../packages/client-transport/daemon-http.js');
  const recovery = createDaemonHttpTransport(f.endpoints[0]);
  try {
    const observed = await recovery.invoke('job_status', { jobId: 'accepted-script' });
    assert.equal(observed.job.status, 'queued');
    assert.equal(observed.wrapperAvailable, true);
    assert.equal(f.counts.submits, 1);
  } finally { recovery.close(); }
});

test('T05 uncertain wrapper upload is not repeated and never submits a Job', async (t) => {
  let wrapperPath;
  const f = await fixture(t, { handle: async ({ req, body, counts }) => {
    if (req.url === '/api/fs/write') {
      counts.writes += 1;
      wrapperPath = body.path;
      await fs.mkdir(path.dirname(body.path), { recursive: true });
      await fs.writeFile(body.path, body.content);
    } else counts.submits += 1;
    req.socket.destroy();
  } });
  const error = await f.runtime.invoke('remote_script_async', { content: 'echo upload-only', cwd: f.root, idempotencyKey: 'upload-key' }).then(() => null, (cause) => cause);
  assert.equal(error?.code, 'EOUTCOME_UNKNOWN');
  assert.equal(error.recovery.phase, 'upload');
  assert.equal(f.counts.writes, 1);
  assert.equal(f.counts.submits, 0);
  assert.equal(f.counts.backup, 0);
  assert.match(await fs.readFile(wrapperPath, 'utf8'), /upload-only/);
});

test('T05 wrappers are client-scoped and same-client/key filenames remain stable', async (t) => {
  const paths = new Map();
  const handler = async ({ req, res, body }) => {
    const client = req.headers['x-mcp-client-id'];
    if (req.url === '/api/fs/write') {
      paths.set(client, body.path);
      await fs.mkdir(path.dirname(body.path), { recursive: true });
      await fs.writeFile(body.path, body.content);
      return json(res, 200, { success: true });
    }
    json(res, 200, { success: true, jobId: `queued-${client}`, status: 'queued' });
  };
  const a = await fixture(t, { handle: handler, backup: false, clientId: 'client-a' });
  const b = await fixture(t, { handle: handler, backup: false, clientId: 'client-b' });
  const args = { cwd: a.root, content: 'echo shared-content', idempotencyKey: 'shared-explicit-key' };
  await a.runtime.invoke('remote_script_async', args);
  const firstA = paths.get('client-a');
  await a.runtime.invoke('remote_script_async', args);
  assert.equal(paths.get('client-a'), firstA);
  await b.runtime.invoke('remote_script_async', args);
  const firstB = paths.get('client-b');
  assert.notEqual(firstA, firstB, 'two queued clients share a self-cleaning wrapper');
  await fs.rm(firstA);
  assert.match(await fs.readFile(firstB, 'utf8'), /shared-content/);
});

test('T05 later rejection does not delete an earlier same-key accepted Job wrapper', async (t) => {
  let wrapperPath;
  let submissions = 0;
  const f = await fixture(t, { backup: false, handle: async ({ req, res, body, counts }) => {
    if (req.url === '/api/fs/write') {
      wrapperPath = body.path;
      await fs.mkdir(path.dirname(body.path), { recursive: true });
      await fs.writeFile(body.path, body.content);
      return json(res, 200, { success: true });
    }
    if (req.url === '/api/fs/delete') {
      counts.deletes += 1;
      await fs.rm(body.path, { force: true });
      return json(res, 200, { success: true });
    }
    submissions += 1;
    return submissions === 1 ? json(res, 200, { success: true, jobId: 'earlier-job', status: 'queued' }) : json(res, 403, { code: 'EEXEC_DISABLED', error: 'synthetic rejection' });
  } });
  const args = { cwd: f.root, content: 'echo previous-owner', idempotencyKey: 'earlier-job-key' };
  await f.runtime.invoke('remote_script_async', args);
  await assert.rejects(() => f.runtime.invoke('remote_script_async', args), { code: 'EEXEC_DISABLED' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(f.counts.deletes, 0);
  assert.match(await fs.readFile(wrapperPath, 'utf8'), /previous-owner/);
});

test('T04 explicit HTTP rejection and application errors do not trigger recovery', async (t) => {
  for (const [status, code] of [[401, 'EAUTH'], [403, 'EWORKSPACE'], [500, 'ECONNRESET']]) {
    const f = await fixture(t, { handle: ({ res }) => json(res, status, { error: 'synthetic application rejection', code }) });
    const error = await f.runtime.invoke('remote_write', { path: 'sentinel.txt', content: 'no-change' }, { idempotencyKey: 'a-key' }).then(() => null, (cause) => cause);
    assert.equal(error?.status, status);
    assert.equal(error.code, code);
    assert.equal(f.counts.primary, 1);
    assert.equal(f.counts.backup, 0);
    assert.equal(f.ssh.operations, 0);
  }
});

test('T03 ambiguous proxy HTTP outcomes are UNKNOWN without retry or endpoint replay', async (t) => {
  for (const status of [408, 502, 503, 504]) {
    for (const operation of ['remote_write', 'remote_exec_async']) {
      await t.test(`${operation} HTTP ${status}`, async (subtest) => {
        const f = await fixture(subtest, {
          capabilities: { idempotentJobs: true, clientScopedIdempotency: true },
          handle: ({ res }) => {
            if (status === 503) return json(res, status, { error: 'generic proxy unavailable' });
            res.writeHead(status, { 'content-type': 'text/html' });
            res.end(status === 504 ? '' : '<html>proxy did not return an upstream receipt</html>');
          },
        });
        const error = await f.runtime.invoke(operation, { path: 'item.txt', content: 'once', command: 'synthetic-job', idempotencyKey: 'proxy-key' }).then(() => null, (cause) => cause);
        assert.equal(error?.code, 'EOUTCOME_UNKNOWN');
        assert.equal(error.cause.status, status);
        assert.equal(error.retryable, false);
        assert.equal(f.counts.primary, 1);
        assert.equal(f.counts.backup, 0);
        assert.equal(f.ssh.operations, 0);
      });
    }
  }
});

test('T04 structured proxy-status application rejections remain explicit failures', async (t) => {
  for (const [status, code] of [[503, 'EWORKSPACE'], [502, 'EIDEMPOTENCY_CONFLICT'], [408, 'EEXEC_DISABLED']]) {
    const f = await fixture(t, { handle: ({ res }) => json(res, status, { success: false, code, error: 'explicit synthetic rejection' }) });
    const error = await f.runtime.invoke('remote_write', { path: 'item.txt', content: 'denied' }).then(() => null, (cause) => cause);
    assert.equal(error?.code, code);
    assert.equal(error.status, status);
    assert.equal(f.counts.primary, 1);
    assert.equal(f.counts.backup, 0);
    assert.equal(f.ssh.operations, 0);
  }
});

test('T05 generic proxy failure retains async-script wrapper and recovery metadata', async (t) => {
  let wrapperPath;
  const f = await fixture(t, { handle: async ({ req, res, body, counts }) => {
    if (req.url === '/api/fs/write') {
      counts.writes += 1;
      wrapperPath = body.path;
      await fs.mkdir(path.dirname(body.path), { recursive: true });
      await fs.writeFile(body.path, body.content);
      return json(res, 200, { success: true });
    }
    counts.submits += 1;
    return json(res, 502, { error: 'generic upstream failure' });
  } });
  const error = await f.runtime.invoke('remote_script_async', { cwd: f.root, content: 'echo proxy-retained', idempotencyKey: 'proxy-script' }).then(() => null, (cause) => cause);
  assert.equal(error?.code, 'EOUTCOME_UNKNOWN');
  assert.equal(error.recovery.phase, 'submit');
  assert.equal(error.recovery.wrapperPath, wrapperPath);
  assert.equal(f.counts.writes, 1);
  assert.equal(f.counts.submits, 1);
  assert.equal(f.counts.backup, 0);
  assert.match(await fs.readFile(wrapperPath, 'utf8'), /proxy-retained/);
});

test('T04 all-read batches recover within the existing bounded endpoint loop', async (t) => {
  for (const proxyStatus of [false, true]) {
    const f = await fixture(t, { handle: ({ name, req, res }) => {
      if (name === 'backup') return json(res, 200, { success: true, results: [{ type: 'read', status: 200, content: 'batch-read' }] });
      if (proxyStatus) return json(res, 503, { error: 'generic proxy unavailable' });
      req.socket.destroy();
    } });
    const result = await f.runtime.invoke('remote_batch', { operations: [{ type: 'read', path: 'item.txt' }, { type: 'stat', path: 'item.txt' }, { type: 'glob', pattern: '*' }, { type: 'grep', pattern: 'literal', regex: false }] });
    assert.equal(result.data.results[0].content, 'batch-read');
    assert.equal(result.meta.attempts, 3);
    assert.equal(f.counts.primary, 2);
    assert.equal(f.counts.backup, 1);
    assert.equal(f.ssh.operations, 0);
  }
});

test('T04 read-only batch recovery uses the validated payload snapshot', async (t) => {
  const args = { operations: [{ type: 'read', path: 'item.txt' }] };
  const f = await fixture(t, { handle: ({ name, req, res }) => {
    if (name === 'backup') return json(res, 200, { success: true, results: [{ type: 'read', content: 'snapshot-read' }] });
    args.operations.push({ type: 'write', path: 'item.txt', content: 'must-not-send' });
    req.socket.destroy();
  } });
  assert.equal((await f.runtime.invoke('remote_batch', args)).data.results[0].content, 'snapshot-read');
  assert.equal(f.counts.primary, 2);
  assert.equal(f.counts.backup, 1);
  for (const body of [...f.bodies.primary, ...f.bodies.backup]) assert.deepEqual(body.operations, [{ type: 'read', path: 'item.txt' }]);
});

test('T03 mixed, empty and unknown-type batches keep conservative replay protection', async (t) => {
  for (const operations of [[], [{ type: 'unknown', path: 'item.txt' }], [{ type: 'read', path: 'item.txt' }, { type: 'write', path: 'item.txt', content: 'once' }]]) {
    const f = await fixture(t, { handle: ({ res }) => json(res, 504, { error: 'generic proxy timeout' }) });
    await assert.rejects(() => f.runtime.invoke('remote_batch', { operations }), { code: 'EOUTCOME_UNKNOWN' });
    assert.equal(f.counts.primary, 1);
    assert.equal(f.counts.backup, 0);
    assert.equal(f.ssh.operations, 0);
  }
});

test('T04 read-only daemon regex batch never automatically executes native SSH grep', async (t) => {
  const f = await fixture(t, { backup: false, handle: ({ req }) => req.socket.destroy() });
  const error = await f.runtime.invoke('remote_batch', { operations: [{ type: 'grep', pattern: '(?=needle)', regex: true, cwd: f.root }] }).then(() => null, (cause) => cause);
  assert.ok(error);
  assert.notEqual(error.code, 'EOUTCOME_UNKNOWN');
  assert.equal(f.counts.primary, 2);
  assert.equal(f.ssh.operations, 0);
});

test('T04 definitely-unsent HTTP write can recover without dropping protection', async (t) => {
  const f = await fixture(t);
  await f.runtime.probeServer('srv-test');
  await close(f.servers[0]);
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  const args = { path: 'sentinel.txt', content: 'once', expectedEtag: 'guard', createOnly: true, mode: 0o600 };
  const result = await f.runtime.invoke('remote_write', args);
  assert.equal(result.data.success, true);
  assert.equal(f.counts.primary, 0);
  assert.equal(f.counts.backup, 1);
  assert.deepEqual(f.bodies.backup[0], args);
  assert.equal(f.ssh.operations, 0);
});

test('T04 native read recovery is bounded, daemon regex never falls through to SSH', async (t) => {
  const read = await fixture(t, { handle: ({ name, req, res }) => name === 'primary' ? req.socket.destroy() : json(res, 200, { success: true, content: 'backup-read' }) });
  assert.equal((await read.runtime.invoke('remote_read', { path: 'item.txt' })).data.content, 'backup-read');
  assert.equal(read.counts.primary, 2);
  assert.equal(read.counts.backup, 1);
  const grep = await fixture(t, { backup: false, handle: ({ req }) => req.socket.destroy() });
  const error = await grep.runtime.invoke('remote_grep', { pattern: '(?=needle)', regex: true, cwd: grep.root }).then(() => null, (cause) => cause);
  assert.ok(error, 'daemon regex was silently executed using native grep');
  assert.equal(grep.counts.primary, 2);
  assert.equal(grep.ssh.operations, 0);
  const explicit = await grep.runtime.invoke('remote_grep', { pattern: '(?=needle)', regex: true, cwd: grep.root }, { endpoint: 'ssh' });
  assert.equal(explicit.data.engine, 'grep');
  assert.equal(grep.ssh.operations, 1);
  assert.match(grep.ssh.commands[0], /grep /);
});

test('T06 verified Job retries stay on the original endpoint with a frozen payload', async (t) => {
  const args = { command: 'synthetic-job', cwd: '/synthetic', idempotencyKey: 'same-job', extra: { value: 'original' } };
  const f = await fixture(t, {
    capabilities: { idempotentJobs: true, clientScopedIdempotency: true },
    handle: ({ req }) => { args.extra.value = 'changed-by-caller'; req.socket.destroy(); },
  });
  const error = await f.runtime.invoke('remote_exec_async', args).then(() => null, (cause) => cause);
  assert.equal(error?.code, 'EOUTCOME_UNKNOWN');
  assert.equal(error.recovery.endpointId, 'primary');
  assert.equal(error.recovery.idempotencyKey, 'same-job');
  assert.equal(f.counts.primary, 2);
  assert.equal(f.counts.backup, 0);
  assert.equal(f.ssh.operations, 0);
  assert.deepEqual(f.bodies.primary[0], f.bodies.primary[1]);
  assert.equal(f.bodies.primary[1].extra.value, 'original');
});

function shellArg(value) {
  return process.platform === 'win32' ? `"${String(value).replace(/"/g, '""')}"` : `'${String(value).replace(/'/g, `'"'"'`)}'`;
}
test('T06 actual daemon Job chain deduplicates same client/key/payload after lost receipt', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentport-runtime-dedup-'));
  const { createClientRuntime } = await import('../packages/client-core/client-runtime.js');
  const { ConnectionRegistry } = await import('../packages/client-core/connection-registry.js');
  const { createDaemonHttpTransport } = await import('../packages/client-transport/daemon-http.js');
  const { pidAlive, terminateProcessTree } = require('../packages/daemon-core/process-utils.cjs');
  const legacy = http.createServer((req, res) => json(res, 200, { ok: true }));
  const legacyPort = await listen(legacy);
  const configLoader = { load: async () => ({
    workspaceRoot: root, jobsDir: path.join(root, '.jobs'), serverId: 'srv-test', workspaceId: 'ws-test', auditLogPath: path.join(root, 'audit.log'),
    tokenClientMap: new Map([['fixture-token', 'client-a']]), adminTokens: new Set(), values: {},
    command: { allowExec: true, allowedCommands: '', allowedInterpreters: '' },
    exec: { timeoutMs: 5000, maxTimeoutMs: 60_000, maxConcurrency: 2, queueTimeoutMs: 500, maxBufferBytes: 1024 * 1024 },
    jobs: { maxConcurrency: 2, queueTimeoutMs: 500, defaultTimeoutMs: 5000, maxTimeoutMs: 60_000, logChunkBytes: 4096 },
  }) };
  const gateway = createAgentPortGateway({ legacyOrigin: `http://127.0.0.1:${legacyPort}`, configLoader });
  const port = await listen(gateway);
  const receipts = [];
  const submissions = [];
  const proxy = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.url === '/api/exec/async') submissions.push({ client: req.headers['x-mcp-client-id'], key: req.headers['idempotency-key'], body: body.toString('utf8') });
      const upstream = http.request({ hostname: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, (reply) => {
        const output = [];
        reply.on('data', (chunk) => output.push(chunk));
        reply.on('end', () => {
          const bytes = Buffer.concat(output);
          if (req.url === '/api/exec/async' && reply.statusCode === 200) {
            receipts.push(JSON.parse(bytes));
            if (receipts.length === 1) return req.socket.destroy();
          }
          res.writeHead(reply.statusCode, reply.headers);
          res.end(bytes);
        });
      });
      upstream.on('error', (error) => json(res, 502, { error: error.message }));
      upstream.end(body);
    });
  });
  const proxyPort = await listen(proxy);
  const endpoint = { id: 'primary', type: 'daemon', url: `http://127.0.0.1:${proxyPort}`, clientId: 'client-a', authToken: 'fixture-token', timeoutMs: 2000 };
  const direct = createDaemonHttpTransport({ ...endpoint, url: `http://127.0.0.1:${port}` });
  const runtime = await createClientRuntime({ registry: new ConnectionRegistry({ servers: [{ id: 'srv-test', workspaceId: 'ws-test', endpoints: [endpoint] }] }), projects: new Map(), state: { load: async () => ({}) } });
  t.after(async () => {
    for (const jobId of new Set(receipts.map((receipt) => receipt.jobId))) {
      const deadline = Date.now() + 10_000;
      let job;
      do {
        job = await direct.invoke('job_status', { jobId }).then((data) => data.job, () => null);
        if (!job?.processAlive) break;
        await new Promise((resolve) => setTimeout(resolve, 40));
      } while (Date.now() < deadline);
      if (job?.processAlive && pidAlive(job.workerPid)) await terminateProcessTree(job.workerPid, { forceAfterMs: 500 });
    }
    runtime.close(); direct.close();
    await close(proxy); await close(gateway); await close(legacy);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const script = path.join(root, 'counter.cjs');
  const counter = path.join(root, 'count.txt');
  await fs.writeFile(script, "require('node:fs').appendFileSync(process.argv[2], 'once\\n');\n");
  const command = `${shellArg(process.execPath)} ${shellArg(script)} ${shellArg(counter)}`;
  const args = { command, cwd: root, idempotencyKey: 'verified-job-key' };
  const result = await runtime.invoke('remote_exec_async', args);
  assert.equal(result.meta.attempts, 2);
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].jobId, receipts[1].jobId);
  assert.equal(receipts[1].reused, true);
  assert.deepEqual(submissions[0], submissions[1]);
  const explicit = await runtime.invoke('remote_exec_async', args);
  assert.equal(explicit.data.jobId, result.data.jobId);
  await assert.rejects(() => runtime.invoke('remote_exec_async', { ...args, command: `${command} changed` }), { code: 'EIDEMPOTENCY_CONFLICT' });
  let job;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    job = (await direct.invoke('job_status', { jobId: result.data.jobId })).job;
    if (job.status === 'completed' && job.processAlive === false) break;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.equal(job.status, 'completed');
  assert.equal(job.processAlive, false);
  assert.equal(await fs.readFile(counter, 'utf8'), 'once\n');
  t.diagnostic(`actual Job: first/retried/explicit IDs equal, submissions=${submissions.length}, execution count=1`);
});
