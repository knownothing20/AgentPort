const fs = require('node:fs');

function read(file) { return fs.readFileSync(file, 'utf8'); }
function write(file, value) { fs.writeFileSync(file, value); }
function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, got ${count}`);
  return source.replace(before, after);
}


// Development Session ownership and lock config.
{
  const file = 'daemon/development-gateway.cjs';
  let source = read(file);
  source = replaceOnce(
    source,
    "const { createDevelopmentSessionService } = require('../packages/daemon-core/development-session-service.cjs');",
    "const { createDevelopmentSessionService } = require('../packages/daemon-core/development-session-service.cjs');\nconst { assertResourceOwner, filterOwnedResources, normalizeAuthContext } = require('./auth-context.cjs');",
    'development auth import',
  );
  source = replaceOnce(
    source,
    'function createDevelopmentFrontServer({ baseOrigin, configLoader, authorizeApi, serviceFactory, maxBodyBytes = 10 * 1024 * 1024 } = {}) {',
    'function createDevelopmentFrontServer({ baseOrigin, configLoader, authorizeApi, authorizeContext, serviceFactory, maxBodyBytes = 10 * 1024 * 1024 } = {}) {',
    'development signature',
  );
  source = replaceOnce(source, "  if (!authorizeApi) throw new TypeError('authorizeApi is required');", "  if (!authorizeApi && !authorizeContext) throw new TypeError('authorizeApi or authorizeContext is required');", 'development auth requirement');
  source = replaceOnce(
    source,
    "        lockTimeoutMs: Number(config.values?.AGENTPORT_PROJECT_LOCK_TIMEOUT_MS || 15_000),\n        maxDiffBytes:",
    "        lockTimeoutMs: Number(config.values?.AGENTPORT_PROJECT_LOCK_TIMEOUT_MS || 15_000),\n        projectLockLeaseMs: Number(config.values?.AGENTPORT_PROJECT_LOCK_LEASE_MS || 300_000),\n        maxDiffBytes:",
    'development lock lease config',
  );
  source = replaceOnce(
    source,
    '      const clientId = authorizeApi(req, url, config);\n      const service = serviceFor(config);',
    '      const auth = normalizeAuthContext(authorizeContext ? authorizeContext(req, url, config) : authorizeApi(req, url, config));\n      const clientId = auth.clientId;\n      const service = serviceFor(config);',
    'development auth context',
  );
  source = replaceOnce(
    source,
    "        const [sessions, jobs] = await Promise.all([\n          service.list({ limit: url.searchParams.get('limit') || 100 }),",
    "        const [allSessions, jobs] = await Promise.all([\n          service.list({ limit: 500 }),",
    'overview all sessions',
  );
  source = replaceOnce(
    source,
    '        return sendJson(res, 200, {\n          success: true,\n          serverId: config.serverId,',
    '        const sessions = filterOwnedResources(allSessions, auth).slice(0, Math.min(Math.max(Number(url.searchParams.get(\'limit\') || 100), 1), 500));\n        return sendJson(res, 200, {\n          success: true,\n          serverId: config.serverId,',
    'overview filtered sessions',
  );
  const oldCollection = `      if (developmentRoute.action === 'collection' && req.method === 'GET') {\n        return sendJson(res, 200, {\n          success: true,\n          sessions: await service.list({ limit: url.searchParams.get('limit'), status: url.searchParams.get('status'), projectName: url.searchParams.get('projectName') }),\n          runtime: await service.stats(),\n        });\n      }`;
  const newCollection = `      if (developmentRoute.action === 'collection' && req.method === 'GET') {\n        const requestedLimit = Math.min(Math.max(Number(url.searchParams.get('limit') || 100), 1), 500);\n        const sessions = filterOwnedResources(await service.list({ limit: 500, status: url.searchParams.get('status'), projectName: url.searchParams.get('projectName') }), auth).slice(0, requestedLimit);\n        return sendJson(res, 200, { success: true, sessions, runtime: await service.stats() });\n      }`;
  source = replaceOnce(source, oldCollection, newCollection, 'session list ownership');
  source = replaceOnce(
    source,
    '      const session = await service.status(developmentRoute.sessionId);',
    '      const session = assertResourceOwner(await service.status(developmentRoute.sessionId), auth, "Session");',
    'session item ownership',
  );
  source = replaceOnce(
    source,
    "  const server = createDevelopmentFrontServer({ baseOrigin: `http://127.0.0.1:${internalPort}`, configLoader, authorizeApi: modular.authorizeApi });",
    "  const server = createDevelopmentFrontServer({ baseOrigin: `http://127.0.0.1:${internalPort}`, configLoader, authorizeApi: modular.authorizeApi, authorizeContext: modular.authorizeApiContext });",
    'start gateway auth context',
  );
  write(file, source);
}

// Ranged-read resource-limit coverage.
{
  const file = 'test-daemon-gateway.cjs';
  let source = read(file);
  source = replaceOnce(
    source,
    "  await fs.writeFile(path.join(root, 'src', 'b.txt'), 'hello\\nworld\\n');",
    "  await fs.writeFile(path.join(root, 'src', 'b.txt'), 'hello\\nworld\\n');\n  await fs.writeFile(path.join(root, 'src', 'long.txt'), `${'x'.repeat(4096)}\\nsecond\\n`);",
    'range fixture',
  );
  source = replaceOnce(source, "  assert.deepEqual(glob.files.sort(), ['src/a.js', 'src/b.txt']);", "  assert.deepEqual(glob.files.sort(), ['src/a.js', 'src/b.txt', 'src/long.txt']);", 'range glob expected');
  source = replaceOnce(
    source,
    "    assert.equal(ranged.json.streamed, true);",
    "    assert.equal(ranged.json.streamed, true);\n    assert.equal(ranged.json.etagKind, 'metadata');\n    assert.equal(ranged.json.writeEtag, null);\n\n    const rangeTooLarge = await request(port, 'POST', '/api/fs/read', { path: 'src/long.txt', startLine: 1, endLine: 1, maxBytes: 16 }, auth);\n    assert.equal(rangeTooLarge.status, 413);\n    assert.equal(rangeTooLarge.json.code, 'ERANGE_BYTES');\n\n    const scanTooLarge = await request(port, 'POST', '/api/fs/read', { path: 'src/long.txt', startLine: 2, endLine: 2, maxBytes: 16, maxScanBytes: 64 }, auth);\n    assert.equal(scanTooLarge.status, 413);\n    assert.equal(scanTooLarge.json.code, 'ESCAN_LIMIT');",
    'range limit assertions',
  );
  write(file, source);
}

// Two-client Session adversarial coverage.
{
  const file = 'test-development-gateway.cjs';
  let source = read(file);
  source = replaceOnce(
    source,
    "const { createDevelopmentFrontServer } = require('./daemon/development-gateway.cjs');",
    "const { createDevelopmentFrontServer } = require('./daemon/development-gateway.cjs');\nconst { authorizeContext } = require('./daemon/auth-context.cjs');",
    'dev test auth import',
  );
  source = replaceOnce(
    source,
    "function request(port, method, requestPath, body, headers = {}) {",
    "function request(port, method, requestPath, body, headers = {}) {",
    'request anchor',
  );
  source = replaceOnce(
    source,
    "        authorization: 'Bearer secret',\n        'x-mcp-client-id': 'client-a',",
    "        authorization: 'Bearer secret-a',\n        'x-mcp-client-id': 'client-a',",
    'default client a',
  );
  source = replaceOnce(
    source,
    "        tokenClientMap: new Map([['secret', 'client-a']]),",
    "        tokenClientMap: new Map([['secret-a', 'client-a'], ['secret-b', 'client-b']]),\n        adminTokens: new Set(['admin-secret']),",
    'dev test token map',
  );
  const oldAuthorize = `  const authorizeApi = (req, _url, config) => {\n    const token = String(req.headers.authorization || '').replace(/^Bearer\\s+/, '');\n    const clientId = config.tokenClientMap.get(token);\n    if (!clientId) { const error = new Error('Unauthorized'); error.statusCode = 401; throw error; }\n    return clientId;\n  };\n  const front = createDevelopmentFrontServer({ baseOrigin: \`http://127.0.0.1:${'${basePort}'}\`, configLoader, authorizeApi });`;
  const newAuthorize = `  const front = createDevelopmentFrontServer({ baseOrigin: \`http://127.0.0.1:${'${basePort}'}\`, configLoader, authorizeContext });`;
  source = replaceOnce(source, oldAuthorize, newAuthorize, 'dev test authorize context');
  source = replaceOnce(
    source,
    "    const session = created.data.session;\n    await fs.writeFile",
    "    const session = created.data.session;\n\n    const clientBHeaders = { authorization: 'Bearer secret-b', 'x-mcp-client-id': 'client-b' };\n    const adminHeaders = { authorization: 'Bearer admin-secret' };\n    const hiddenList = await request(port, 'GET', '/api/dev/sessions', undefined, clientBHeaders);\n    assert.equal(hiddenList.data.sessions.length, 0);\n    for (const [method, suffix, payload] of [\n      ['GET', '', undefined], ['GET', '/diff', undefined], ['POST', '/run', { command: 'echo denied' }],\n      ['POST', '/commit', { message: 'denied' }], ['POST', '/rollback', { confirm: session.id }],\n      ['POST', '/merge', { confirm: session.id }], ['POST', '/cleanup', { confirm: session.id, force: true }],\n    ]) {\n      const denied = await request(port, method, `/api/dev/sessions/${session.id}${suffix}`, payload, clientBHeaders);\n      assert.equal(denied.status, 403);\n      assert.equal(denied.data.code, 'EOWNER');\n    }\n    const adminVisible = await request(port, 'GET', `/api/dev/sessions/${session.id}`, undefined, adminHeaders);\n    assert.equal(adminVisible.status, 200);\n\n    await fs.writeFile",
    'dev two-client assertions',
  );
  write(file, source);
}

// Two-client Job adversarial coverage and client-scoped idempotency.
{
  const file = 'test-daemon-exec-jobs.cjs';
  let source = read(file);
  source = replaceOnce(
    source,
    '    tokenClientMap: new Map([["token", "client"]]),\n    adminTokens: new Set(),',
    '    tokenClientMap: new Map([["token-a", "client-a"], ["token-b", "client-b"]]),\n    adminTokens: new Set(["admin-token"]),',
    'job token map',
  );
  source = replaceOnce(
    source,
    '  const headers = { authorization: "Bearer token", "x-mcp-client-id": "client", "content-type": "application/json" };',
    '  const headers = { authorization: "Bearer token-a", "x-mcp-client-id": "client-a", "content-type": "application/json" };\n  const headersB = { authorization: "Bearer token-b", "x-mcp-client-id": "client-b", "content-type": "application/json" };\n  const adminHeaders = { authorization: "Bearer admin-token", "content-type": "application/json" };',
    'job auth headers',
  );
  source = replaceOnce(
    source,
    "    assert.match(task.stdout, /gateway-job/);",
    "    assert.match(task.stdout, /gateway-job/);\n\n    response = await fetch(`${base}/api/jobs`, { headers: headersB });\n    body = await response.json();\n    assert.equal(body.jobs.some((job) => job.id === jobId), false);\n    for (const [method, route] of [\n      ['GET', `/api/jobs/${jobId}`], ['GET', `/api/jobs/${jobId}/logs`], ['GET', `/api/task/${jobId}`],\n      ['POST', `/api/jobs/${jobId}/cancel`], ['POST', `/api/jobs/${jobId}/delete`],\n    ]) {\n      const denied = await fetch(`${base}${route}`, { method, headers: headersB });\n      const deniedBody = await denied.json();\n      assert.equal(denied.status, 403);\n      assert.equal(deniedBody.code, 'EOWNER');\n    }\n    const adminView = await fetch(`${base}/api/jobs/${jobId}`, { headers: adminHeaders });\n    assert.equal(adminView.status, 200);\n\n    response = await fetch(`${base}/api/exec/async`, { method: 'POST', headers: { ...headersB, 'idempotency-key': 'gateway-job' }, body: JSON.stringify({ command: jobCommand, cwd: root }) });\n    body = await response.json();\n    assert.equal(body.reused, false);\n    assert.notEqual(body.jobId, jobId);",
    'job two-client assertions',
  );
  write(file, source);
}
