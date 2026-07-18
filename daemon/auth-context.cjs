const crypto = require("node:crypto");

function extractToken(req, url) {
  if (url?.searchParams?.get("token")) return url.searchParams.get("token");
  const authorization = req?.headers?.authorization;
  const alternate = req?.headers?.["x-mcp-token"] || req?.headers?.["x-niuma-token"];
  const raw = (typeof authorization === "string" && authorization.trim())
    || (typeof alternate === "string" && alternate.trim())
    || "";
  return raw.startsWith("Bearer ") ? raw.slice(7).trim() : raw;
}

function requestedClientId(req) {
  const value = req?.headers?.["x-mcp-client-id"]
    || req?.headers?.["x-niuma-client-id"]
    || req?.headers?.["x-client-id"];
  return typeof value === "string" ? value.trim() : "";
}

function adminClientId(token) {
  const suffix = crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 12);
  return `admin-${suffix}`;
}

function authorizeContext(req, url, config) {
  const tokenClientMap = config?.tokenClientMap || new Map();
  const adminTokens = config?.adminTokens || new Set();
  if (tokenClientMap.size === 0 && adminTokens.size === 0) {
    const error = new Error("Server auth not configured");
    error.statusCode = 500;
    throw error;
  }

  const token = extractToken(req, url);
  const mappedClientId = tokenClientMap.get(token) || "";
  const isAdmin = adminTokens.has(token);
  if (!mappedClientId && !isAdmin) {
    const error = new Error("Unauthorized");
    error.statusCode = 401;
    throw error;
  }

  const requested = requestedClientId(req);
  if (mappedClientId && requested && requested !== mappedClientId) {
    const error = new Error("Client ID mismatch");
    error.statusCode = 403;
    error.code = "ECLIENT_ID";
    throw error;
  }

  const clientId = mappedClientId || adminClientId(token);
  return Object.freeze({ clientId, isAdmin, role: isAdmin ? "admin" : "owner" });
}

function normalizeAuthContext(value) {
  if (typeof value === "string") {
    return Object.freeze({ clientId: value, isAdmin: false, role: "owner" });
  }
  if (value && typeof value === "object" && typeof value.clientId === "string") {
    return Object.freeze({
      clientId: value.clientId,
      isAdmin: Boolean(value.isAdmin),
      role: value.isAdmin ? "admin" : (value.role || "owner"),
    });
  }
  throw new TypeError("Invalid authorization context");
}

function ownershipError(resourceType, resourceId) {
  const error = new Error(`${resourceType} is not owned by this client`);
  error.code = "EOWNER";
  error.statusCode = 403;
  error.details = { resourceType, resourceId: resourceId || null };
  return error;
}

function assertResourceOwner(resource, auth, resourceType = "Resource") {
  const context = normalizeAuthContext(auth);
  if (context.isAdmin) return resource;
  const owner = String(resource?.clientId || "").trim();
  if (!owner || owner !== context.clientId) {
    throw ownershipError(resourceType, resource?.id || resource?.jobId || resource?.sessionId || null);
  }
  return resource;
}

function filterOwnedResources(resources, auth) {
  const context = normalizeAuthContext(auth);
  if (context.isAdmin) return Array.isArray(resources) ? resources : [];
  return (Array.isArray(resources) ? resources : []).filter(
    (resource) => String(resource?.clientId || "").trim() === context.clientId,
  );
}

function scopeIdempotencyKey(clientId, key) {
  const normalized = String(key || "").trim();
  return normalized ? `${String(clientId)}\u0000${normalized}` : "";
}

module.exports = {
  assertResourceOwner,
  authorizeContext,
  extractToken,
  filterOwnedResources,
  normalizeAuthContext,
  ownershipError,
  requestedClientId,
  scopeIdempotencyKey,
};
