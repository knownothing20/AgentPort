const fs = require('node:fs');

function read(file) { return fs.readFileSync(file, 'utf8'); }
function write(file, value) { fs.writeFileSync(file, value); }
function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, got ${count}`);
  return source.replace(before, after);
}


// Modular gateway authorization and Job ownership.
{
  const file = 'daemon/modular-gateway.cjs';
  let source = read(file);
  source = replaceOnce(
    source,
    'const { startLegacyProcess } = require("./legacy-process.cjs");',
    'const { startLegacyProcess } = require("./legacy-process.cjs");\nconst {\n  assertResourceOwner,\n  authorizeContext,\n  extractToken: extractAuthToken,\n  filterOwnedResources,\n  requestedClientId: requestedAuthClientId,\n  scopeIdempotencyKey,\n} = require("./auth-context.cjs");',
    'modular auth import',
  );
  const oldAuth = `function extractToken(req, url) {\n  if (url.searchParams.get("token")) return url.searchParams.get("token");\n  const authorization = req.headers.authorization;\n  const alternate = req.headers["x-mcp-token"] || req.headers["x-niuma-token"];\n  const raw = (typeof authorization === "string" && authorization.trim())\n    || (typeof alternate === "string" && alternate.trim())\n    || "";\n  return raw.startsWith("Bearer ") ? raw.slice(7).trim() : raw;\n}\n\nfunction requestedClientId(req) {\n  const value = req.headers["x-mcp-client-id"] || req.headers["x-niuma-client-id"] || req.headers["x-client-id"];\n  return typeof value === "string" ? value.trim() : "";\n}\n\nfunction authorizeApi(req, url, config) {\n  if (config.tokenClientMap.size === 0) {\n    const error = new Error("Server auth not configured");\n    error.statusCode = 500;\n    throw error;\n  }\n  const token = extractToken(req, url);\n  const clientId = config.tokenClientMap.get(token);\n  if (!clientId) {\n    const error = new Error("Unauthorized");\n    error.statusCode = 401;\n    throw error;\n  }\n  const requested = requestedClientId(req);\n  if (requested && requested !== clientId) {\n    const error = new Error("Client ID mismatch");\n    error.statusCode = 403;\n    throw error;\n  }\n  return clientId;\n}`;
  const newAuth = `function extractToken(req, url) { return extractAuthToken(req, url); }\nfunction requestedClientId(req) { return requestedAuthClientId(req); }\nfunction authorizeApiContext(req, url, config) { return authorizeContext(req, url, config); }\nfunction authorizeApi(req, url, config) { return authorizeApiContext(req, url, config).clientId; }`;
  source = replaceOnce(source, oldAuth, newAuth, 'replace modular auth');
  source = replaceOnce(
    source,
    '  clientId,\n  maxBodyBytes,\n  startedAt,\n}) {\n  const route = jobRoute(pathname);',
    '  auth,\n  maxBodyBytes,\n  startedAt,\n}) {\n  const route = jobRoute(pathname);\n  const clientId = auth.clientId;',
    'job auth signature',
  );
  source = replaceOnce(
    source,
    '        idempotencyKey: idempotencyKey(req, body),',
    '        idempotencyKey: scopeIdempotencyKey(clientId, idempotencyKey(req, body)),',
    'scope job idempotency',
  );
  const oldList = `    if (route.action === "collection" && req.method === "GET") {\n      const jobs = await services.jobs.list({\n        limit: url.searchParams.get("limit") || 50,\n        status: url.searchParams.get("status") || "",\n      });\n      sendJson(res, 200, {\n        success: true,\n        jobs,\n        count: jobs.length,\n        jobRuntime: services.jobs.stats(),\n      });\n      return true;\n    }`;
  const newList = `    if (route.action === "collection" && req.method === "GET") {\n      const requestedLimit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 500);\n      const candidates = await services.jobs.list({\n        limit: auth.isAdmin ? requestedLimit : 500,\n        status: url.searchParams.get("status") || "",\n      });\n      const jobs = filterOwnedResources(candidates, auth).slice(0, requestedLimit);\n      sendJson(res, 200, {\n        success: true,\n        jobs,\n        count: jobs.length,\n        jobRuntime: services.jobs.stats(),\n      });\n      return true;\n    }`;
  source = replaceOnce(source, oldList, newList, 'job list ownership');
  source = source.replace('      const job = await services.jobs.get(route.jobId);\n      sendJson(res, 200, { success: true, job, ...job });', '      const job = assertResourceOwner(await services.jobs.get(route.jobId), auth, "Job");\n      sendJson(res, 200, { success: true, job, ...job });');
  source = source.replace('    if (route.action === "logs" && req.method === "GET") {\n      const value = await services.jobs.logs(route.jobId, {', '    if (route.action === "logs" && req.method === "GET") {\n      assertResourceOwner(await services.jobs.get(route.jobId), auth, "Job");\n      const value = await services.jobs.logs(route.jobId, {');
  source = source.replace('    if (route.action === "cancel" && req.method === "POST") {\n      const value = await services.jobs.cancel(route.jobId);', '    if (route.action === "cancel" && req.method === "POST") {\n      assertResourceOwner(await services.jobs.get(route.jobId), auth, "Job");\n      const value = await services.jobs.cancel(route.jobId);');
  source = source.replace('    ) {\n      const value = await services.jobs.remove(route.jobId);', '    ) {\n      assertResourceOwner(await services.jobs.get(route.jobId), auth, "Job");\n      const value = await services.jobs.remove(route.jobId);');
  source = source.replace('    if (route.action === "task" && req.method === "GET") {\n      const job = await services.jobs.get(route.jobId);', '    if (route.action === "task" && req.method === "GET") {\n      const job = assertResourceOwner(await services.jobs.get(route.jobId), auth, "Job");');
  source = replaceOnce(
    source,
    '      const clientId = authorizeApi(req, url, config);\n      const services = servicesFor(config);',
    '      const auth = authorizeApiContext(req, url, config);\n      const clientId = auth.clientId;\n      const services = servicesFor(config);',
    'gateway auth context',
  );
  source = replaceOnce(source, '        clientId,\n        maxBodyBytes,\n        startedAt,\n      })) return;\n\n      if (\n        pathname === "/api/batch"', '        auth,\n        maxBodyBytes,\n        startedAt,\n      })) return;\n\n      if (\n        pathname === "/api/batch"', 'pass job auth context');
  source = replaceOnce(source, '          maxBytes: body.maxBytes,\n        });', '          maxBytes: body.maxBytes,\n          maxScanBytes: body.maxScanBytes,\n        });', 'pass read scan limit');
  source = replaceOnce(source, '  authorizeApi,\n  createAgentPortGateway,', '  authorizeApi,\n  authorizeApiContext,\n  createAgentPortGateway,', 'export auth context');
  source = source.replace('            restartRecoverableJobs: true,', '            restartRecoverableJobs: true,\n            resourceOwnership: true,\n            clientScopedIdempotency: true,');
  write(file, source);
}
