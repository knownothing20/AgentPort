const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createAgentPortGateway } = require('../daemon/modular-gateway.cjs');
const { createDevelopmentFrontServer } = require('../daemon/development-gateway.cjs');
const { createDaemonConfigLoader, parseEnvText } = require('../daemon/config-loader.cjs');
const { startLegacyProcess } = require('../daemon/legacy-process.cjs');
const { createFileSearchService } = require('../packages/daemon-core/file-search-service.cjs');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request(port, method, requestPath, body, headers = {}) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: requestPath,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function shellArg(value) {
  const text = String(value);
  if (process.platform === 'win32') return `"${text.replace(/"/g, '""')}"`;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

async function waitForJob(port, jobId, headers) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await request(port, 'GET', `/api/jobs/${encodeURIComponent(jobId)}`, undefined, headers);
    if (['completed', 'error', 'timeout', 'cancelled', 'orphaned'].includes(response.json?.job?.status)) return response;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Job ${jobId} did not finish during the test`);
}

async function testConfigAndLegacyProcess(root) {
  const envPath = path.join(root, 'daemon.env');
  await fs.writeFile(envPath, [
    'WORKSPACE_ROOT=' + root,
    'AUTH_TOKENS=client-a=secret',
    'ADMIN_TOKENS=admin-secret',
    'AGENTPORT_SERVER_ID=server-from-env',
    'AGENTPORT_WORKSPACE_ID=workspace-from-env',
  ].join('\n') + '\n');
  const parsed = parseEnvText('A=1\nB="hello world"\n');
  assert.equal(parsed.B, 'hello world');
  const loader = createDaemonConfigLoader({ envPath, baseDir: root });
  const config = await loader.load();
  assert.equal(config.serverId, 'server-from-env');
  assert.equal(config.tokenClientMap.get('secret'), 'client-a');

  const legacyEntry = path.join(root, 'fake-legacy.cjs');
  await fs.writeFile(legacyEntry, [
    "const http = require('node:http');",
    "http.createServer((req, res) => { res.end('ok'); }).listen(Number(process.env.PORT), process.env.BIND_HOST);",
  ].join('\n'));
  const legacy = await startLegacyProcess({ entryPath: legacyEntry, cwd: root, stdio: 'ignore' });
  assert.match(legacy.origin, /^http:\/\/127\.0\.0\.1:/);
  legacy.stop();
  await new Promise((resolve) => legacy.child.once('exit', resolve));
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentport-phase2-'));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'a.js'), 'const needle = 1;\nconsole.log(needle);\n');
  await fs.writeFile(path.join(root, 'src', 'b.txt'), 'hello\nworld\n');
  await fs.writeFile(path.join(root, 'src', 'long.txt'), `${'x'.repeat(4096)}\nsecond\n`);

  await testConfigAndLegacyProcess(root);

  const search = createFileSearchService({ workspaceRoot: root });
  const glob = await search.glob('**/*.{js,txt}');
  assert.deepEqual(glob.files.sort(), ['src/a.js', 'src/b.txt', 'src/long.txt']);
  const grep = await search.grep({ pattern: 'needle', include: '**/*.js' });
  assert.equal(grep.matches.length, 2);

  const legacy = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ ok: true, legacy: true }));
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ proxied: true, path: req.url }));
  });
  const legacyPort = await listen(legacy);
  const configLoader = {
    allowExec: true,
    async load() {
      return {
        workspaceRoot: root,
        jobsDir: path.join(root, '.jobs'),
        serverId: 'srv-test',
        workspaceId: 'ws-test',
        auditLogPath: path.join(root, 'audit.log'),
        tokenClientMap: new Map([['secret', 'client-a']]),
        adminTokens: new Set(),
        dashboardEnabled: false,
        values: {},
        command: { allowExec: this.allowExec, allowedCommands: '', allowedInterpreters: '' },
        exec: {
          timeoutMs: 5000,
          maxTimeoutMs: 60_000,
          maxConcurrency: 2,
          queueTimeoutMs: 500,
          maxBufferBytes: 1024 * 1024,
        },
        jobs: {
          maxConcurrency: 1,
          queueTimeoutMs: 500,
          defaultTimeoutMs: 5000,
          maxTimeoutMs: 60_000,
          logChunkBytes: 4096,
        },
      };
    },
    setWorkspaceRoot() {},
    clearWorkspaceRootOverride() {},
  };
  const gateway = createAgentPortGateway({ legacyOrigin: `http://127.0.0.1:${legacyPort}`, configLoader });
  const port = await listen(gateway);
  const attachedSessionJobs = [];
  const developmentGateway = createDevelopmentFrontServer({
    baseOrigin: `http://127.0.0.1:${port}`,
    configLoader,
    authorizeContext: () => ({ clientId: 'client-a' }),
    serviceFactory: () => ({
      async status() {
        return { id: 'session-test', clientId: 'client-a', status: 'active', worktreePath: root, commands: {} };
      },
      async attachJob(sessionId, job) { attachedSessionJobs.push({ sessionId, ...job }); },
    }),
  });
  const developmentPort = await listen(developmentGateway);
  const auth = { authorization: 'Bearer secret', 'x-mcp-client-id': 'client-a' };

  try {
    const publicHealth = await request(port, 'GET', '/healthz');
    assert.equal(publicHealth.status, 200);
    assert.equal(publicHealth.json.ok, true);
    assert.equal(publicHealth.json.serverId, undefined);
    assert.equal(publicHealth.json.jobRuntime, undefined);

    const health = await request(port, 'GET', '/healthz', undefined, auth);
    assert.equal(health.status, 200);
    assert.equal(health.json.serverId, 'srv-test');
    assert.equal(health.json.capabilities.atomicWrite, true);
    assert.equal(health.json.capabilities.persistentJobWorker, true);

    const unauthorized = await request(port, 'POST', '/api/fs/read', { path: 'src/a.js' });
    assert.equal(unauthorized.status, 401);

    const ranged = await request(port, 'POST', '/api/fs/read', { path: 'src/a.js', startLine: 2, endLine: 2 }, auth);
    assert.equal(ranged.status, 200);
    assert.equal(ranged.json.content, 'console.log(needle);');
    assert.equal(ranged.json.ranged, true);
    assert.equal(ranged.json.streamed, true);
    assert.equal(ranged.json.etagKind, 'metadata');
    assert.equal(ranged.json.writeEtag, null);

    const rangeTooLarge = await request(port, 'POST', '/api/fs/read', { path: 'src/long.txt', startLine: 1, endLine: 1, maxBytes: 16 }, auth);
    assert.equal(rangeTooLarge.status, 413);
    assert.equal(rangeTooLarge.json.code, 'ERANGE_BYTES');

    const scanTooLarge = await request(port, 'POST', '/api/fs/read', { path: 'src/long.txt', startLine: 2, endLine: 2, maxBytes: 16, maxScanBytes: 64 }, auth);
    assert.equal(scanTooLarge.status, 413);
    assert.equal(scanTooLarge.json.code, 'ESCAN_LIMIT');

    const write = await request(port, 'POST', '/api/fs/write', { path: 'src/new.txt', content: 'new-content' }, auth);
    assert.equal(write.status, 200);
    assert.equal(write.json.atomic, true);
    assert.equal(await fs.readFile(path.join(root, 'src', 'new.txt'), 'utf8'), 'new-content');

    const conflict = await request(port, 'POST', '/api/fs/write', { path: 'src/new.txt', content: 'bad', expectedEtag: 'wrong' }, auth);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.code, 'EWRITE_CONFLICT');

    const manifest = await request(port, 'POST', '/api/fs/manifest', { path: '.' }, auth);
    assert.ok(manifest.json.entries.some((entry) => entry.path === 'src/new.txt'));

    const globResponse = await request(port, 'POST', '/api/fs/glob', { pattern: '**/*.txt' }, auth);
    assert.ok(globResponse.json.files.includes('src/b.txt'));
    assert.ok(globResponse.json.files.includes('src/new.txt'));

    const grepResponse = await request(port, 'POST', '/api/fs/grep', { pattern: 'needle', include: '**/*.js' }, auth);
    assert.equal(grepResponse.json.matches.length, 2);

    const bytes = await request(port, 'POST', '/api/fs/read-bytes', { path: 'src/new.txt', offset: 4, length: 7 }, auth);
    assert.equal(Buffer.from(bytes.json.contentBase64, 'base64').toString(), 'content');

    const jobs = await request(port, 'GET', '/api/jobs', undefined, auth);
    assert.equal(jobs.status, 200);
    assert.equal(jobs.json.success, true);
    assert.equal(jobs.json.count, 0);

    const enabledCommand = `${shellArg(process.execPath)} -e ${shellArg("process.stdout.write('gateway-command-ok')")}`;
    const commandResponse = await request(port, 'POST', '/api/exec', { command: enabledCommand }, auth);
    assert.equal(commandResponse.status, 200);
    assert.equal(commandResponse.json.stdout, 'gateway-command-ok');

    const enabledScript = await request(port, 'POST', '/api/exec/script', {
      interpreter: process.execPath,
      content: "process.stdout.write('gateway-script-ok')",
    }, auth);
    assert.equal(enabledScript.status, 200);
    assert.equal(enabledScript.json.stdout, 'gateway-script-ok');

    configLoader.allowExec = false;
    const disabledCommand = await request(port, 'POST', '/api/exec', { command: enabledCommand }, auth);
    assert.equal(disabledCommand.status, 403);
    assert.equal(disabledCommand.json.code, 'ECOMMAND_POLICY');

    const scriptSentinel = path.join(root, 'disabled-script-sentinel');
    const disabledScript = await request(port, 'POST', '/api/exec/script', {
      interpreter: process.execPath,
      content: `require('node:fs').writeFileSync(${JSON.stringify(scriptSentinel)}, 'executed')`,
    }, auth);
    assert.equal(disabledScript.status, 403);
    assert.equal(disabledScript.json.code, 'ECOMMAND_POLICY');
    await assert.rejects(() => fs.access(scriptSentinel), (error) => error.code === 'ENOENT');

    const disabledBatchSentinel = path.join(root, 'disabled-batch-sentinel');
    const disabledBatch = await request(port, 'POST', '/api/batch', {
      operations: [
        { type: 'read', path: 'src/a.js' },
        {
          type: 'bash',
          command: `${shellArg(process.execPath)} -e ${shellArg(`require('node:fs').writeFileSync(${JSON.stringify(disabledBatchSentinel)}, 'executed')`)}`,
        },
      ],
    }, auth);
    assert.equal(disabledBatch.status, 200);
    assert.equal(disabledBatch.json.results[0].status, 200);
    assert.equal(disabledBatch.json.results[1].status, 403);
    await assert.rejects(() => fs.access(disabledBatchSentinel), (error) => error.code === 'ENOENT');

    const disabledJob = await request(port, 'POST', '/api/jobs/start', { command: enabledCommand }, auth);
    assert.equal(disabledJob.status, 403);
    assert.equal(disabledJob.json.code, 'ECOMMAND_POLICY');
    assert.equal((await request(port, 'GET', '/api/jobs', undefined, auth)).json.count, 0);

    const disabledSessionRun = await request(developmentPort, 'POST', '/api/dev/sessions/session-test/run', {
      command: enabledCommand,
    }, auth);
    assert.equal(disabledSessionRun.status, 403);
    assert.equal(disabledSessionRun.json.code, 'ECOMMAND_POLICY');
    assert.equal(attachedSessionJobs.length, 0);

    const stillReadable = await request(port, 'POST', '/api/fs/read', { path: 'src/a.js' }, auth);
    assert.equal(stillReadable.status, 200);

    configLoader.allowExec = true;
    const reenabledCommand = await request(port, 'POST', '/api/exec', { command: enabledCommand }, auth);
    assert.equal(reenabledCommand.status, 200);
    assert.equal(reenabledCommand.json.stdout, 'gateway-command-ok');
    const reenabledScript = await request(port, 'POST', '/api/exec/script', {
      interpreter: process.execPath,
      content: "process.stdout.write('gateway-script-ok')",
    }, auth);
    assert.equal(reenabledScript.status, 200);
    assert.equal(reenabledScript.json.stdout, 'gateway-script-ok');

    const enabledBatch = await request(port, 'POST', '/api/batch', {
      operations: [{ type: 'bash', command: enabledCommand }],
    }, auth);
    assert.equal(enabledBatch.status, 200);
    assert.equal(enabledBatch.json.results[0].status, 200);
    assert.equal(enabledBatch.json.results[0].stdout, 'gateway-command-ok');

    const enabledJob = await request(port, 'POST', '/api/jobs/start', { command: enabledCommand }, auth);
    assert.equal(enabledJob.status, 200);
    const finishedJob = await waitForJob(port, enabledJob.json.jobId, auth);
    assert.equal(finishedJob.json.job.status, 'completed');

    const enabledSessionRun = await request(developmentPort, 'POST', '/api/dev/sessions/session-test/run', {
      command: enabledCommand,
    }, auth);
    assert.equal(enabledSessionRun.status, 200);
    assert.equal(enabledSessionRun.json.success, true);
    const finishedSessionJob = await waitForJob(port, enabledSessionRun.json.jobId, auth);
    assert.equal(finishedSessionJob.json.job.status, 'completed');
    assert.equal(attachedSessionJobs.length, 1);

    const proxied = await request(port, 'GET', '/legacy-route', undefined, auth);
    assert.equal(proxied.json.proxied, true);
  } finally {
    await close(developmentGateway);
    await close(gateway);
    await close(legacy);
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log('PASS daemon modular gateway, file search, and job compatibility');
}

main().catch((error) => { console.error(error.stack || error); process.exit(1); });
