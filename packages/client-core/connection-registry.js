import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function expandHome(value) {
  const text = String(value || "").trim();
  if (text === "~") return os.homedir();
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2));
  return text;
}

async function readJsonIfPresent(filePath) {
  if (!filePath) return null;
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    error.message = `Failed to read connection config '${filePath}': ${error.message}`;
    throw error;
  }
}

function normalizedPriority(value, fallback = 100) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeEndpoint(endpoint, serverId, index = 0) {
  if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) {
    throw new Error(`Endpoint ${index + 1} on server '${serverId}' must be an object`);
  }
  const type = String(endpoint.type || "daemon").trim().toLowerCase();
  if (!new Set(["daemon", "ssh"]).has(type)) {
    throw new Error(`Endpoint '${endpoint.id || endpoint.name || index + 1}' has unsupported type '${type}'`);
  }
  const id = String(endpoint.id || endpoint.name || `${serverId}-${type}-${index + 1}`).trim();
  if (!id) throw new Error(`Endpoint ${index + 1} on server '${serverId}' is missing id`);
  if (type === "daemon" && !String(endpoint.url || "").trim()) {
    throw new Error(`Daemon endpoint '${id}' is missing url`);
  }
  if (type === "ssh" && !String(endpoint.host || "").trim()) {
    throw new Error(`SSH endpoint '${id}' is missing host`);
  }
  return Object.freeze({
    ...endpoint,
    id,
    name: String(endpoint.name || id).trim(),
    serverId,
    type,
    scope: String(endpoint.scope || (type === "ssh" ? "recovery" : "lan")).trim(),
    priority: normalizedPriority(endpoint.priority),
    url: type === "daemon" ? String(endpoint.url).replace(/\/+$/, "") : undefined,
    host: type === "ssh" ? String(endpoint.host).trim() : undefined,
    port: type === "ssh" ? Number(endpoint.port || 22) : undefined,
    username: type === "ssh" ? String(endpoint.username || "root").trim() : undefined,
    privateKey: endpoint.privateKey ? expandHome(endpoint.privateKey) : undefined,
    workspaceRoot: endpoint.workspaceRoot ? String(endpoint.workspaceRoot).trim() : undefined,
    enabled: endpoint.enabled !== false,
  });
}

function normalizeServer(server, index = 0) {
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    throw new Error(`Server ${index + 1} must be an object`);
  }
  const id = String(server.id || server.name || `server-${index + 1}`).trim();
  if (!id) throw new Error(`Server ${index + 1} is missing id`);
  const endpoints = (Array.isArray(server.endpoints) ? server.endpoints : [])
    .map((endpoint, endpointIndex) => normalizeEndpoint(endpoint, id, endpointIndex));
  if (endpoints.length === 0) throw new Error(`Server '${id}' has no endpoints`);
  return Object.freeze({
    ...server,
    id,
    name: String(server.name || id).trim(),
    description: String(server.description || "").trim(),
    workspaceId: server.workspaceId ? String(server.workspaceId).trim() : null,
    endpoints: Object.freeze(endpoints),
  });
}

function normalizeV3Config(parsed) {
  const servers = (Array.isArray(parsed?.servers) ? parsed.servers : [])
    .map((server, index) => normalizeServer(server, index));
  if (servers.length === 0) throw new Error("V3 connection config has no servers");
  return {
    format: "v3",
    servers,
    defaultServer: String(parsed.defaultServer || servers[0].id).trim(),
  };
}

function normalizeLegacyConfig(parsed) {
  const connections = Array.isArray(parsed?.connections) ? parsed.connections : [];
  if (connections.length === 0) throw new Error("Legacy connection config has no connections");
  const groups = new Map();
  const endpointToServer = new Map();

  for (const [index, connection] of connections.entries()) {
    const endpointName = String(connection?.name || `connection-${index + 1}`).trim();
    const logicalId = String(
      connection?.logicalServer || connection?.serverId || connection?.server || endpointName,
    ).trim();
    if (!groups.has(logicalId)) {
      groups.set(logicalId, {
        id: logicalId,
        name: logicalId,
        description: String(connection?.description || "").trim(),
        workspaceId: connection?.workspaceId || connection?.workspaceRoot || null,
        endpoints: [],
      });
    }
    const endpoint = normalizeEndpoint({ ...connection, id: endpointName }, logicalId, groups.get(logicalId).endpoints.length);
    groups.get(logicalId).endpoints.push(endpoint);
    endpointToServer.set(endpointName, logicalId);
  }

  const servers = [...groups.values()].map((server, index) => normalizeServer(server, index));
  const legacyDefault = String(parsed.default || "").trim();
  return {
    format: "legacy",
    servers,
    defaultServer: endpointToServer.get(legacyDefault) || legacyDefault || servers[0].id,
  };
}

export class ConnectionRegistry {
  constructor({ servers, defaultServer, sourcePath = null, format = "v3" } = {}) {
    this.sourcePath = sourcePath;
    this.format = format;
    this.servers = new Map();
    this.endpoints = new Map();
    for (const server of servers || []) {
      this.servers.set(server.id, server);
      for (const endpoint of server.endpoints) {
        if (this.endpoints.has(endpoint.id)) throw new Error(`Duplicate endpoint id '${endpoint.id}'`);
        this.endpoints.set(endpoint.id, { server, endpoint });
      }
    }
    if (this.servers.size === 0) throw new Error("Connection registry is empty");
    this.defaultServerId = this.servers.has(defaultServer) ? defaultServer : this.servers.keys().next().value;
    Object.freeze(this);
  }

  getServer(serverId = this.defaultServerId) {
    const value = String(serverId || this.defaultServerId).trim();
    const direct = this.servers.get(value);
    if (direct) return direct;
    const endpoint = this.endpoints.get(value);
    if (endpoint) return endpoint.server;
    const error = new Error(`Unknown server or endpoint '${value}'`);
    error.code = "ECONNECTION_NOT_FOUND";
    error.availableServers = [...this.servers.keys()];
    error.availableEndpoints = [...this.endpoints.keys()];
    throw error;
  }

  getEndpoint(endpointId) {
    const found = this.endpoints.get(String(endpointId || "").trim());
    if (!found) {
      const error = new Error(`Unknown endpoint '${endpointId}'`);
      error.code = "EENDPOINT_NOT_FOUND";
      throw error;
    }
    return found;
  }

  resolveTarget(value) {
    const name = String(value || this.defaultServerId).trim();
    if (this.servers.has(name)) return { server: this.servers.get(name), endpoint: null };
    if (this.endpoints.has(name)) return this.endpoints.get(name);
    return { server: this.getServer(name), endpoint: null };
  }

  list() {
    return [...this.servers.values()].map((server) => ({
      id: server.id,
      name: server.name,
      description: server.description,
      workspaceId: server.workspaceId,
      default: server.id === this.defaultServerId,
      endpoints: server.endpoints.map((endpoint) => ({
        id: endpoint.id,
        name: endpoint.name,
        type: endpoint.type,
        scope: endpoint.scope,
        priority: endpoint.priority,
        url: endpoint.url,
        host: endpoint.host,
        port: endpoint.port,
        username: endpoint.username,
        enabled: endpoint.enabled,
      })),
    }));
  }
}

export async function loadConnectionRegistry({ baseDir = process.cwd(), filePath, candidatePaths = [] } = {}) {
  const candidates = [
    filePath,
    process.env.MCP_REMOTE_V3_CONNECTIONS_PATH,
    process.env.AGENTPORT_CONNECTIONS_PATH,
    ...candidatePaths,
    path.join(baseDir, "local", "connections.v3.json"),
    path.join(baseDir, "local", "connections.json"),
  ]
    .map((item) => item ? path.resolve(expandHome(item)) : null)
    .filter(Boolean);

  for (const candidate of [...new Set(candidates)]) {
    const parsed = await readJsonIfPresent(candidate);
    if (!parsed) continue;
    const normalized = Array.isArray(parsed.servers)
      ? normalizeV3Config(parsed)
      : normalizeLegacyConfig(parsed);
    return new ConnectionRegistry({ ...normalized, sourcePath: candidate });
  }

  const error = new Error(`No AgentPort connection configuration found. Checked: ${candidates.join(", ")}`);
  error.code = "ECONFIG_NOT_FOUND";
  throw error;
}

export const connectionRegistryInternals = Object.freeze({
  normalizeEndpoint,
  normalizeLegacyConfig,
  normalizeServer,
  normalizeV3Config,
});
