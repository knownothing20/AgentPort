const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

function decodeEnvValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    const inner = value.slice(1, -1);
    if (value.startsWith('"')) {
      return inner
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    return inner;
  }
  const commentIndex = value.search(/\s+#/);
  return commentIndex >= 0 ? value.slice(0, commentIndex).trim() : value;
}

function parseEnvText(raw) {
  const values = {};
  for (const sourceLine of String(raw || "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = normalized.indexOf("=");
    if (separator <= 0) continue;
    const key = normalized.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values[key] = decodeEnvValue(normalized.slice(separator + 1));
  }
  return values;
}

function parseTokenMap(values) {
  const rawJson = values.AUTH_TOKENS_JSON;
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  const out = {};
  for (const entry of String(values.AUTH_TOKENS || "").split(",").map((item) => item.trim()).filter(Boolean)) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const clientId = entry.slice(0, separator).trim();
    const token = entry.slice(separator + 1).trim();
    if (clientId && token) out[clientId] = token;
  }
  return out;
}

function parseAdminTokens(values) {
  return new Set(String(values.ADMIN_TOKENS || "").split(",").map((item) => item.trim()).filter(Boolean));
}

async function firstExisting(paths) {
  for (const candidate of paths) {
    if (!candidate) continue;
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return path.resolve(candidate);
    } catch {}
  }
  return null;
}

function createDaemonConfigLoader({ baseDir = __dirname, envPath } = {}) {
  let selectedEnvPath = envPath ? path.resolve(envPath) : null;
  let cache = null;
  let runtimeWorkspaceRoot = "";

  async function resolveEnvPath() {
    if (selectedEnvPath) return selectedEnvPath;
    selectedEnvPath = await firstExisting([
      process.env.AGENTPORT_ENV_PATH,
      path.join(baseDir, ".env"),
      path.join(baseDir, "..", "server", ".env"),
      path.join(process.cwd(), ".env"),
    ]);
    return selectedEnvPath;
  }

  async function readFileValues() {
    const filePath = await resolveEnvPath();
    if (!filePath) return { filePath: null, values: {} };
    try {
      const stat = await fs.stat(filePath);
      if (cache && cache.filePath === filePath && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
        return { filePath, values: cache.values };
      }
      const raw = await fs.readFile(filePath, "utf8");
      const values = parseEnvText(raw);
      cache = { filePath, mtimeMs: stat.mtimeMs, size: stat.size, values };
      return { filePath, values };
    } catch (error) {
      if (error?.code === "ENOENT") return { filePath, values: {} };
      throw error;
    }
  }

  async function load() {
    const file = await readFileValues();
    const values = { ...file.values, ...process.env };
    const tokenMap = parseTokenMap(values);
    const tokenClientMap = new Map();
    for (const [clientId, token] of Object.entries(tokenMap)) {
      if (token) tokenClientMap.set(token, clientId);
    }
    const legacyToken = String(values.AUTH_TOKEN || values.MCP_REMOTE_AUTH_TOKEN || values.NIUMA_SSH_AUTH_TOKEN || "").trim();
    if (legacyToken && tokenClientMap.size === 0) tokenClientMap.set(legacyToken, "legacy-client");

    const workspaceRoot = path.resolve(runtimeWorkspaceRoot || values.WORKSPACE_ROOT || "/home/user/workspace");
    return {
      envPath: file.filePath,
      values,
      workspaceRoot,
      serverId: String(values.AGENTPORT_SERVER_ID || values.SERVER_ID || os.hostname()).trim(),
      workspaceId: String(values.AGENTPORT_WORKSPACE_ID || values.WORKSPACE_ID || workspaceRoot).trim(),
      auditLogPath: path.resolve(values.AUDIT_LOG_PATH || path.join(baseDir, "..", "server", "audit.log")),
      tokenClientMap,
      adminTokens: parseAdminTokens(values),
      dashboardEnabled: /^true$/i.test(String(values.ENABLE_DASHBOARD || "false")),
    };
  }

  function setWorkspaceRoot(value) {
    runtimeWorkspaceRoot = path.resolve(String(value || ""));
  }

  function clearWorkspaceRootOverride() {
    runtimeWorkspaceRoot = "";
  }

  return Object.freeze({
    load,
    resolveEnvPath,
    setWorkspaceRoot,
    clearWorkspaceRootOverride,
  });
}

module.exports = {
  createDaemonConfigLoader,
  decodeEnvValue,
  parseAdminTokens,
  parseEnvText,
  parseTokenMap,
};
