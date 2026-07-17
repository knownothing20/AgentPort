const fs = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { URL } = require("node:url");
const {
  createFileReadService,
  createFileSearchService,
  createFileWriteService,
} = require("../packages/daemon-core/index.cjs");
const { createDaemonConfigLoader } = require("./config-loader.cjs");
const { startLegacyProcess } = require("./legacy-process.cjs");

const FILE_ROUTES = Object.freeze({
  read: new Set(["/read", "/api/fs/read"]),
  readBytes: new Set(["/api/fs/read-bytes"]),
  stat: new Set(["/stat", "/api/fs/stat"]),
  manifest: new Set(["/api/fs/manifest"]),
  glob: new Set(["/glob", "/api/fs/glob"]),
  grep: new Set(["/grep", "/api/fs/grep"]),
  write: new Set(["/write", "/api/fs/write"]),
  remove: new Set(["/api/fs/remove", "/api/fs/delete"]),
});

function nowIso() {
  return new Date().toISOString();
}

function extractToken(req, url) {
  if (url.searchParams.get("token")) return url.searchParams.get("token");
  const authorization = req.headers.authorization;
  const alternate = req.headers["x-mcp-token"] || req.headers["x-niuma-token"];
  const raw = (typeof authorization === "string" && authorization.trim())
    || (typeof alternate === "string" && alternate.trim())
    || "";
  return raw.startsWith("Bearer ") ? raw.slice(7).trim() : raw;
}

function requestedClientId(req) {
  const value = req.headers["x-mcp-client-id"] || req.headers["x-niuma-client-id"] || req.headers["x-client-id"];
  return typeof value === "string" ? value.trim() : "";
}

function authorizeApi(req, url, config) {
  if (config.tokenClientMap.size === 0) {
    const error = new Error("Server auth not configured");
    error.statusCode = 500;
    throw error;
  }
  const token = extractToken(req, url);
  const clientId = config.tokenClientMap.get(token);
  if (!clientId) {
    const error = new Error("Unauthorized");
    error.statusCode = 401;
    throw error;
  }
  const requested = requestedClientId(req);
  if (requested && requested !== clientId) {
    const error = new Error("Client ID mismatch");
    error.statusCode = 403;
    throw error;
  }
  return clientId;
}

function readBody(req, maxBytes = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error(`Request body exceeds ${maxBytes} bytes`);
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req, maxBytes) {
  const buffer = await readBody(req, maxBytes);
  if (buffer.length === 0) return { body: {}, buffer };
  try {
    return { body: JSON.parse(buffer.toString("utf8")), buffer };
  } catch {
    const error = new Error("Invalid JSON body");
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(res, statusCode, payload, headers = {}) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

function sanitizeProxyHeaders(headers, target, bodyBuffer) {
  const next = { ...headers, host: target.host };
  delete next.connection;
  if (bodyBuffer) {
    next["content-length"] = String(bodyBuffer.length);
    delete next["transfer-encoding"];
  }
  return next;
}

function transportFor(url) {
  return url.protocol === "https:" ? https : http;
}

function requestLegacy(legacyOrigin, { method, requestPath, headers, bodyBuffer, timeoutMs = 120_000 }) {
  return new Promise((resolve, reject) => {
    const target = new URL(requestPath, legacyOrigin);
    const request = transportFor(target).request(target, {
      method,
      headers: sanitizeProxyHeaders(headers || {}, target, bodyBuffer),
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        statusCode: response.statusCode || 502,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.on("timeout", () => {
      request.destroy(new Error(`Legacy request timed out after ${timeoutMs}ms`));
    });
    request.on("error", reject);
    if (bodyBuffer?.length) request.write(bodyBuffer);
    request.end();
  });
}

function sendLegacyResponse(res, response) {
  const headers = { ...response.headers };
  delete headers.connection;
  delete headers["transfer-encoding"];
  headers["content-length"] = String(response.body.length);
  res.writeHead(response.statusCode, headers);
  res.end(response.body);
}

function proxyRequest(req, res, legacyOrigin) {
  const target = new URL(req.url || "/", legacyOrigin);
  const proxy = transportFor(target).request(target, {
    method: req.method,
    headers: sanitizeProxyHeaders(req.headers, target),
  }, (proxyResponse) => {
    const headers = { ...proxyResponse.headers };
    delete headers.connection;
    res.writeHead(proxyResponse.statusCode || 502, headers);
    proxyResponse.pipe(res);
  });
  proxy.on("error", (error) => {
    if (!res.headersSent) sendJson(res, 502, { error: `Legacy daemon unavailable: ${error.message}` });
    else res.destroy(error);
  });
  req.pipe(proxy);
}

function createServiceRegistry() {
  const cache = new Map();
  return function servicesFor(workspaceRoot) {
    const key = path.resolve(workspaceRoot);
    if (!cache.has(key)) {
      cache.set(key, Object.freeze({
        reader: createFileReadService({ workspaceRoot: key }),
        search: createFileSearchService({ workspaceRoot: key }),
        writer: createFileWriteService({ workspaceRoot: key }),
      }));
    }
    return cache.get(key);
  };
}

async function appendAudit(config, event) {
  try {
    await fs.mkdir(path.dirname(config.auditLogPath), { recursive: true });
    await fs.appendFile(config.auditLogPath, `${JSON.stringify({ ts: nowIso(), gateway: "modular-fs", ...event })}\n`, "utf8");
  } catch {}
}

function routeType(pathname) {
  for (const [type, paths] of Object.entries(FILE_ROUTES)) {
    if (paths.has(pathname)) return type;
  }
  return null;
}

function createAgentPortGateway({
  legacyOrigin,
  configLoader = createDaemonConfigLoader(),
  maxBodyBytes = 50 * 1024 * 1024,
} = {}) {
  if (!legacyOrigin) throw new TypeError("legacyOrigin is required");
  const servicesFor = createServiceRegistry();

  return http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const url = new URL(req.url || "/", "http://agentport.local");
    const pathname = url.pathname;

    try {
      if (req.method === "GET" && pathname === "/healthz") {
        const [legacy, config] = await Promise.all([
          requestLegacy(legacyOrigin, { method: "GET", requestPath: req.url, headers: req.headers, timeoutMs: 10_000 }),
          configLoader.load(),
        ]);
        let payload;
        try { payload = JSON.parse(legacy.body.toString("utf8")); }
        catch { payload = { ok: legacy.statusCode < 500 }; }
        return sendJson(res, legacy.statusCode, {
          ...payload,
          serverId: config.serverId,
          workspaceId: config.workspaceId,
          gateway: {
            mode: "modular-fs-proxy",
            version: 3,
            legacyOrigin,
          },
          capabilities: {
            ...(payload.capabilities || {}),
            fileReadRanges: true,
            fileReadBytes: true,
            fileManifest: true,
            safeGlob: true,
            safeGrep: true,
            atomicWrite: true,
            symlinkEscapeGuard: true,
          },
        });
      }

      if (req.method === "POST" && pathname === "/update-workspace") {
        const { body, buffer } = await readJson(req, maxBodyBytes);
        const legacy = await requestLegacy(legacyOrigin, {
          method: req.method,
          requestPath: req.url,
          headers: req.headers,
          bodyBuffer: buffer,
        });
        if (legacy.statusCode >= 200 && legacy.statusCode < 300 && typeof body.new_workspace === "string" && body.new_workspace.trim()) {
          configLoader.setWorkspaceRoot(body.new_workspace.trim());
        }
        return sendLegacyResponse(res, legacy);
      }

      if (pathname === "/api/config" && req.method !== "GET" && req.method !== "HEAD") {
        const buffer = await readBody(req, maxBodyBytes);
        const legacy = await requestLegacy(legacyOrigin, {
          method: req.method,
          requestPath: req.url,
          headers: req.headers,
          bodyBuffer: buffer,
        });
        if (legacy.statusCode >= 200 && legacy.statusCode < 300) configLoader.clearWorkspaceRootOverride();
        return sendLegacyResponse(res, legacy);
      }

      const type = routeType(pathname);
      if (!type || !["POST", "DELETE"].includes(req.method || "")) {
        return proxyRequest(req, res, legacyOrigin);
      }

      const config = await configLoader.load();
      const clientId = authorizeApi(req, url, config);
      const { body } = await readJson(req, maxBodyBytes);
      const services = servicesFor(config.workspaceRoot);
      let result;

      if (type === "read") {
        result = await services.reader.readText(body.path, {
          startLine: body.startLine,
          endLine: body.endLine,
          maxBytes: body.maxBytes,
        });
        const ifNoneMatch = String(req.headers["if-none-match"] || body.ifNoneMatch || "").replace(/^"|"$/g, "").trim();
        if (ifNoneMatch && ifNoneMatch === result.etag) {
          await appendAudit(config, { type: "fs.read", clientId, path: body.path, ok: true, cached: true, ms: Date.now() - startedAt });
          return sendJson(res, 304, { success: true, etag: result.etag, cached: true });
        }
        result = { success: true, ...result };
      } else if (type === "readBytes") {
        result = { success: true, ...(await services.reader.readBytes(body.path, body)) };
      } else if (type === "stat") {
        const value = await services.reader.stat(body.path);
        result = {
          success: true,
          ...value,
          mtime: new Date(value.mtimeMs).toISOString(),
          isDir: value.isDirectory,
        };
      } else if (type === "manifest") {
        result = { success: true, ...(await services.reader.manifest(body.path || ".", body)) };
      } else if (type === "glob") {
        result = await services.search.glob(body.pattern, body);
      } else if (type === "grep") {
        result = await services.search.grep(body);
      } else if (type === "write") {
        const value = await services.writer.writeText(body.path, body.content, {
          expectedEtag: body.expectedEtag,
          createOnly: body.createOnly,
          mode: body.mode,
        });
        result = { message: "File written successfully", ...value };
      } else if (type === "remove") {
        result = await services.writer.removeFile(body.path || url.searchParams.get("path"), {
          expectedEtag: body.expectedEtag,
        });
      }

      await appendAudit(config, {
        type: `fs.${type}`,
        clientId,
        path: body.path,
        pattern: body.pattern,
        ok: true,
        ms: Date.now() - startedAt,
      });
      return sendJson(res, 200, result);
    } catch (error) {
      let config = null;
      try { config = await configLoader.load(); } catch {}
      if (config) {
        await appendAudit(config, {
          type: `fs.${routeType(pathname) || "gateway"}`,
          clientId: requestedClientId(req) || null,
          ok: false,
          error: error.message,
          ms: Date.now() - startedAt,
        });
      }
      const statusCode = Number(error.statusCode) || (error.code === "ENOENT" ? 404 : 500);
      return sendJson(res, statusCode, {
        error: error.message,
        code: error.code || null,
        currentEtag: error.currentEtag || null,
      });
    }
  });
}

async function listen(server, port, host) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}

async function startAgentPortGateway(options = {}) {
  const configLoader = options.configLoader || createDaemonConfigLoader({
    baseDir: __dirname,
    envPath: process.env.AGENTPORT_ENV_PATH,
  });
  const config = await configLoader.load();
  const publicPort = Number(options.port || process.env.AGENTPORT_PUBLIC_PORT || config.values.PORT || 3183);
  const publicHost = String(options.host || process.env.AGENTPORT_PUBLIC_HOST || config.values.BIND_HOST || "0.0.0.0");
  let legacyProcess = null;
  let legacyOrigin = options.legacyOrigin || process.env.AGENTPORT_LEGACY_ORIGIN || "";

  if (!legacyOrigin) {
    legacyProcess = await startLegacyProcess({
      entryPath: process.env.AGENTPORT_LEGACY_ENTRY || path.join(__dirname, "..", "server", "server.js"),
      port: process.env.AGENTPORT_LEGACY_PORT,
    });
    legacyOrigin = legacyProcess.origin;
  }

  const gateway = createAgentPortGateway({ legacyOrigin, configLoader });
  await listen(gateway, publicPort, publicHost);
  console.log(`AgentPort modular gateway running on ${publicHost}:${publicPort}`);
  console.log(`legacy=${legacyOrigin}`);
  console.log(`workspace=${config.workspaceRoot}`);

  let stopping = false;
  const stop = async (signal = "SIGTERM") => {
    if (stopping) return;
    stopping = true;
    await new Promise((resolve) => gateway.close(resolve));
    legacyProcess?.stop(signal);
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      stop(signal).finally(() => process.exit(0));
    });
  }
  if (legacyProcess?.child) {
    legacyProcess.child.once("exit", (code, signal) => {
      if (stopping) return;
      console.error(`Legacy daemon exited unexpectedly: code=${code} signal=${signal || ""}`);
      gateway.close(() => process.exit(code || 1));
    });
  }

  return { gateway, legacyOrigin, legacyProcess, publicHost, publicPort, stop };
}

module.exports = {
  FILE_ROUTES,
  authorizeApi,
  createAgentPortGateway,
  extractToken,
  requestLegacy,
  startAgentPortGateway,
};
