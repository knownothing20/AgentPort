const { URL } = require("node:url");
const baseGateway = require("./development-gateway.cjs");

const REDACTED = "[REDACTED]";
const SENSITIVE_KEYS = new Set([
  "authorization",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "bearertoken",
  "token",
  "password",
  "passphrase",
  "privatekey",
  "privatekeydata",
  "apikey",
  "clientsecret",
  "secret",
  "credential",
  "credentials",
  "command",
  "commandpreview",
  "env",
]);

function normalizedKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sanitizeUrl(value) {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return value;
  try {
    const parsed = new URL(value);
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_KEYS.has(normalizedKey(key))) parsed.searchParams.set(key, REDACTED);
    }
    if (parsed.username) parsed.username = REDACTED;
    if (parsed.password) parsed.password = REDACTED;
    return parsed.toString();
  } catch {
    return value;
  }
}

function sanitizeDevelopmentPayload(value) {
  const seen = new WeakMap();

  function visit(current, parentKey = "") {
    const key = normalizedKey(parentKey);
    if (SENSITIVE_KEYS.has(key)) return current === undefined ? undefined : REDACTED;
    if (typeof current === "string") return sanitizeUrl(current);
    if (current === null || typeof current !== "object") return current;
    if (seen.has(current)) return seen.get(current);

    if (Array.isArray(current)) {
      const next = [];
      seen.set(current, next);
      for (const item of current) next.push(visit(item));
      return next;
    }

    const next = {};
    seen.set(current, next);
    let commandRedacted = false;
    for (const [childKey, item] of Object.entries(current)) {
      const normalized = normalizedKey(childKey);
      if (normalized === "commands" && item && typeof item === "object" && !Array.isArray(item)) {
        next[childKey] = Object.fromEntries(Object.keys(item).map((name) => [name, REDACTED]));
        next.commandActions = Object.keys(item);
        commandRedacted = Object.keys(item).length > 0;
        continue;
      }
      if (["command", "commandpreview"].includes(normalized)) {
        commandRedacted = item !== undefined && item !== null && item !== "";
      }
      next[childKey] = visit(item, childKey);
    }
    if (commandRedacted) next.commandRedacted = true;
    return next;
  }

  return visit(value);
}

function replaceHeader(headers, name, value) {
  const next = { ...(headers || {}) };
  for (const key of Object.keys(next)) {
    if (key.toLowerCase() === name.toLowerCase()) delete next[key];
  }
  next[name] = value;
  return next;
}

function installDevelopmentResponseSanitizer(server) {
  if (!server || typeof server.prependListener !== "function") {
    throw new TypeError("HTTP server is required");
  }
  if (server.__agentportDevelopmentSanitizerInstalled) return server;
  Object.defineProperty(server, "__agentportDevelopmentSanitizerInstalled", { value: true });

  server.prependListener("request", (req, res) => {
    let pathname = "";
    try { pathname = new URL(req.url || "/", "http://agentport.local").pathname; }
    catch { return; }
    if (!pathname.startsWith("/api/dev/")) return;

    const originalWriteHead = res.writeHead.bind(res);
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    let statusCode = res.statusCode || 200;
    let statusMessage = null;
    let headers = {};
    const chunks = [];

    res.writeHead = function patchedWriteHead(code, messageOrHeaders, maybeHeaders) {
      statusCode = Number(code) || 200;
      if (typeof messageOrHeaders === "string") {
        statusMessage = messageOrHeaders;
        headers = { ...(maybeHeaders || {}) };
      } else {
        headers = { ...(messageOrHeaders || {}) };
      }
      return this;
    };

    res.write = function patchedWrite(chunk, encoding, callback) {
      if (chunk !== undefined && chunk !== null) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === "string" ? encoding : "utf8"));
      }
      const cb = typeof encoding === "function" ? encoding : callback;
      if (typeof cb === "function") queueMicrotask(cb);
      return true;
    };

    res.end = function patchedEnd(chunk, encoding, callback) {
      if (chunk !== undefined && chunk !== null) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === "string" ? encoding : "utf8"));
      }
      let output = Buffer.concat(chunks);
      try {
        const parsed = JSON.parse(output.toString("utf8"));
        output = Buffer.from(`${JSON.stringify(sanitizeDevelopmentPayload(parsed))}\n`, "utf8");
        headers = replaceHeader(headers, "content-type", "application/json; charset=utf-8");
      } catch {
        // Preserve non-JSON responses unchanged.
      }
      headers = replaceHeader(headers, "content-length", output.length);
      if (statusMessage !== null) originalWriteHead(statusCode, statusMessage, headers);
      else originalWriteHead(statusCode, headers);
      const cb = typeof encoding === "function" ? encoding : callback;
      return originalEnd(output, typeof encoding === "string" ? encoding : undefined, cb);
    };

    res.once("close", () => {
      res.writeHead = originalWriteHead;
      res.write = originalWrite;
      res.end = originalEnd;
    });
  });

  return server;
}

async function startDevelopmentGateway(options = {}) {
  const started = await baseGateway.startDevelopmentGateway(options);
  installDevelopmentResponseSanitizer(started.server);
  return started;
}

module.exports = {
  ...baseGateway,
  REDACTED,
  installDevelopmentResponseSanitizer,
  sanitizeDevelopmentPayload,
  startDevelopmentGateway,
};
