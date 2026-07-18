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
    return parsed.toString().replace(/\/$/, value.endsWith("/") ? "/" : "");
  } catch {
    return value;
  }
}

export function redactSensitive(value, { maxDepth = 32 } = {}) {
  const seen = new WeakMap();

  function visit(current, depth, parentKey = "") {
    if (SENSITIVE_KEYS.has(normalizedKey(parentKey))) {
      return current === undefined ? undefined : REDACTED;
    }
    if (typeof current === "string") return sanitizeUrl(current);
    if (current === null || typeof current !== "object") return current;
    if (depth >= maxDepth) return "[MAX_DEPTH]";
    if (seen.has(current)) return seen.get(current);

    if (Array.isArray(current)) {
      const next = [];
      seen.set(current, next);
      for (const item of current) next.push(visit(item, depth + 1));
      return next;
    }

    const next = {};
    seen.set(current, next);
    for (const [key, item] of Object.entries(current)) {
      next[key] = visit(item, depth + 1, key);
    }
    return next;
  }

  return visit(value, 0);
}

export function publicEndpoint(endpoint) {
  return redactSensitive(endpoint || {});
}

export function publicServer(server) {
  if (!server || typeof server !== "object") return server;
  return redactSensitive({
    ...server,
    endpoints: Array.isArray(server.endpoints)
      ? server.endpoints.map((endpoint) => publicEndpoint(endpoint))
      : [],
  });
}

export { REDACTED };
