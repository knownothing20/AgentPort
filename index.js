import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import fs from "fs";
import path from "path";
import { SSHClient, SSHConnectionManager } from "./ssh-client.js";
import { scanLocalSSH, formatSSHScanSummary } from "./ssh-scanner.js";
import logger from "./logger.js";

// Read version from local/mcp-remote-agent.json (single source of truth)
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
let PKG_VERSION = "0.0.0";
let PKG_NAME = "mcp-remote-agent";
try {
  const configJson = JSON.parse(
    await import("fs").then((fs) =>
      fs.readFileSync(join(__dirname, "local", "mcp-remote-agent.json"), "utf-8").replace(/^\uFEFF/, "")
    )
  );
  PKG_VERSION = configJson.version || PKG_VERSION;
  PKG_NAME = configJson.name || PKG_NAME;
} catch (_) {}

// Support both new (MCP_REMOTE_*) and legacy (NIUMA_SSH_*) env var names
const REMOTE_URL = (process.env.MCP_REMOTE_URL || process.env.NIUMA_SSH_REMOTE_URL || "http://127.0.0.1:3183").replace(/\/+$/, "");
const AUTH_TOKEN = (process.env.MCP_REMOTE_AUTH_TOKEN || process.env.NIUMA_SSH_AUTH_TOKEN || "").trim();
const CLIENT_ID = (process.env.MCP_REMOTE_CLIENT_ID || process.env.NIUMA_SSH_CLIENT_ID || "").trim();
const rawTimeout = Number(process.env.MCP_REMOTE_TIMEOUT_MS || process.env.NIUMA_SSH_TIMEOUT_MS || 120000);
const REQUEST_TIMEOUT_MS = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 120000;

// --- Runtime mode (for compatibility signaling) ---
const RUNTIME_MODE_PATH = path.join(__dirname, "local", "runtime-mode.json");
const ALLOWED_RUNTIME_MODES = new Set(["auto", "native-mcp", "executable-skill"]);

function loadRuntimeMode() {
  try {
    if (!fs.existsSync(RUNTIME_MODE_PATH)) return { mode: "auto", source: "default" };
    const raw = fs.readFileSync(RUNTIME_MODE_PATH, "utf-8").replace(/^\uFEFF/, "");
    const data = JSON.parse(raw);
    const mode = ALLOWED_RUNTIME_MODES.has(data?.mode) ? data.mode : "auto";
    return {
      mode,
      requestedMode: data?.requestedMode || mode,
      detectedMode: data?.detectedMode || "unknown",
      lastProbeAt: data?.lastProbeAt || null,
      source: "runtime-mode.json",
    };
  } catch {
    return { mode: "auto", source: "default" };
  }
}

function resolveRuntimeMode() {
  const fromFile = loadRuntimeMode();
  const envMode = String(process.env.MCP_REMOTE_RUNTIME_MODE || process.env.NIUMA_SSH_RUNTIME_MODE || "").trim();
  if (envMode && ALLOWED_RUNTIME_MODES.has(envMode)) {
    return {
      ...fromFile,
      mode: envMode,
      source: "env",
    };
  }
  return fromFile;
}

function withRuntimeMeta(obj = {}) {
  return {
    ...obj,
    runtimeMode: _runtimeMode.mode,
    modeSource: _runtimeMode.source,
  };
}

function runtimeModeHint() {
  if (_runtimeMode.mode === "native-mcp") {
    return "建议先运行 node test.cjs --probe --mode=native-mcp 检查注入链路。";
  }
  if (_runtimeMode.mode === "executable-skill") {
    return "建议先运行 node test.cjs --probe --mode=executable-skill 检查技能直连链路。";
  }
  return "建议先运行 node test.cjs --probe --mode=auto 检查自动模式探测结果。";
}

const _runtimeMode = resolveRuntimeMode();

// --- Dynamic connection management ---
let _connections = {};
let _currentConnection = null;
let _connectionAxios = null;
let _sshManager = new SSHConnectionManager();

function loadConnections() {
  try {
    const configPath = path.join(__dirname, 'local', 'connections.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      _connections = {};
      for (const conn of config.connections || []) {
        _connections[conn.name] = conn;
        // Register SSH connections
        if (conn.type === 'ssh') {
          _sshManager.addConnection(conn.name, conn);
        }
      }
      return config.default || Object.keys(_connections)[0];
    }
  } catch (e) {
    console.error('Failed to load connections.json:', e.message);
  }
  return null;
}

function getAxiosInstance(connectionName) {
  if (connectionName && _connections[connectionName]) {
    const conn = _connections[connectionName];
    if (conn.type === 'ssh') {
      throw new Error('Cannot use axios for SSH connection. Use SSH client instead.');
    }
    return axios.create({
      baseURL: conn.url.replace(/\/+$/, ''),
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        ...(conn.authToken ? { authorization: `Bearer ${conn.authToken}` } : {}),
        ...(conn.clientId ? { "x-mcp-client-id": conn.clientId } : {}),
        "Content-Type": "application/json",
      },
    });
  }
  return axiosInstance;
}

function getCurrentAxios() {
  return _connectionAxios || axiosInstance;
}

function isSSHConnection(connectionName) {
  const name = connectionName || _currentConnection;
  return name && _connections[name]?.type === 'ssh';
}

function getSSHClient(connectionName) {
  const name = connectionName || _currentConnection;
  if (!name || !_connections[name] || _connections[name].type !== 'ssh') {
    throw new Error('Not an SSH connection');
  }
  return _sshManager.switchConnection(name);
}

// --- Connection health cache ---
const HEALTH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let _lastHealthTime = 0;
let _isHealthy = false;
let _workspaceRoot = ""; // Cached from healthz response

// --- Read content ETag cache (for 304 Not Modified support) ---
const _etagCache = new Map(); // path -> { etag, content, timestamp }
const ETAG_CACHE_MAX = 200;   // max cached files
const ETAG_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// --- Operation statistics ---
let _stats = {
  totalRequests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  retries: 0,
  errors: 0,
  startTime: Date.now(),
  lastOperation: null,
  lastOperationTime: null,
};

function isHealthCacheValid() {
  return _isHealthy && (Date.now() - _lastHealthTime) < HEALTH_CACHE_TTL_MS;
}

function markHealthy(workspaceRoot) {
  _isHealthy = true;
  _lastHealthTime = Date.now();
  if (typeof workspaceRoot === "string" && workspaceRoot) _workspaceRoot = workspaceRoot;
}

function markUnhealthy() {
  _isHealthy = false;
  _lastHealthTime = 0;
}

function recordOp(opName) {
  _stats.totalRequests++;
  _stats.lastOperation = opName;
  _stats.lastOperationTime = new Date().toISOString();
}

function getEtagCache(filePath) {
  const entry = _etagCache.get(filePath);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ETAG_CACHE_TTL_MS) {
    _etagCache.delete(filePath);
    return null;
  }
  return entry;
}

function setEtagCache(filePath, etag, content) {
  // Evict oldest entries if cache is full
  if (_etagCache.size >= ETAG_CACHE_MAX) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, v] of _etagCache) {
      if (v.timestamp < oldestTime) {
        oldestTime = v.timestamp;
        oldestKey = k;
      }
    }
    if (oldestKey) _etagCache.delete(oldestKey);
  }
  _etagCache.set(filePath, { etag, content, timestamp: Date.now() });
}

// --- Network error detection ---
const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE",
  "ENOTFOUND", "ENETUNREACH", "EAI_AGAIN",
]);

// --- Interpreter whitelist (for remote_script) ---
const ALLOWED_INTERPRETERS = new Set(["bash", "sh", "python3", "python", "node", "ruby", "perl", "dash", "zsh"]);

// --- Bash special character detection & base64 escape ---
const BASH_SPECIAL_CHARS = /[$`\\!"#;&|<>(){}~\r\n]/;

function needsBase64Escape(str) {
  return BASH_SPECIAL_CHARS.test(str) || str.includes("'");
}

function wrapBase64Command(command) {
  const b64 = Buffer.from(command, "utf-8").toString("base64");
  return `printf '%s' '${b64}' | base64 -d | bash`;
}

// --- Content sanitization for remote_write ---
const PRESERVE_CRLF = (process.env.MCP_REMOTE_PRESERVE_CRLF || process.env.NIUMA_SSH_PRESERVE_CRLF || "").trim() === "true";

function sanitizeContent(content) {
  if (!PRESERVE_CRLF) {
    content = content.replace(/\r\n/g, "\n");
  }
  if (content.startsWith("\uFEFF")) {
    content = content.slice(1);
  }
  return content;
}

// --- Health check error result ---
function healthCheckError(message) {
  const text = `${message}\n\n[Runtime] mode=${_runtimeMode.mode}, source=${_runtimeMode.source}. ${runtimeModeHint()}`;
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}

async function ensureHealthy(hint) {
  if (isHealthCacheValid()) return;
  try {
    const probe = await getCurrentAxios().get("/healthz", { validateStatus: () => true, timeout: 5000 });
    if (probe.status === 200) markHealthy(probe.data?.workspaceRoot);
  } catch (_) {}
  if (!isHealthCacheValid()) {
    const msg = hint || "Consider calling remote_health first to check if the remote service is reachable.";
    throw Object.assign(new Error(`⚠️ Remote connection status unknown. ${msg}`), { _isHealthError: true });
  }
}

function isHealthError(error) {
  return error?._isHealthError === true;
}

function isNetworkError(error) {
  const code = error?.code || error?.cause?.code;
  if (NETWORK_ERROR_CODES.has(code)) return true;
  // Axios wraps network errors with no response
  if (!error?.response && NETWORK_ERROR_CODES.has(error?.errno)) return true;
  return false;
}

// --- Retry with delay ---
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRY_DELAY_MS = 2000;
const MAX_RETRIES = 1;

const server = new Server(
  {
    name: PKG_NAME,
    version: PKG_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const axiosInstance = axios.create({
  baseURL: REMOTE_URL,
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    ...(AUTH_TOKEN ? { authorization: `Bearer ${AUTH_TOKEN}` } : {}),
    ...(CLIENT_ID ? { "x-mcp-client-id": CLIENT_ID } : {}),
    "Content-Type": "application/json",
  },
});

function getArguments(request) {
  const args = request?.params?.arguments;
  return args && typeof args === "object" ? args : {};
}

function requireNonEmptyString(args, key) {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid '${key}': expected a non-empty string.`);
  }
  return value;
}

async function postWithFallback(paths, payload, retryCount = 0) {
  let lastError;
  for (const path of paths) {
    try {
      const response = await getCurrentAxios().post(path, payload);
      return response.data ?? {};
    } catch (error) {
      const status = error?.response?.status;
      if (status === 404 || status === 405) {
        lastError = error;
        continue;
      }
      // Network error: retry once with delay
      if (isNetworkError(error) && retryCount < MAX_RETRIES) {
        _stats.retries++;
        console.error(`Network error on ${path}: ${error.code || error.message}. Retrying in ${RETRY_DELAY_MS}ms... (attempt ${retryCount + 1}/${MAX_RETRIES})`);
        await sleep(RETRY_DELAY_MS);
        return postWithFallback(paths, payload, retryCount + 1);
      }
      throw error;
    }
  }
  // Fallback paths all returned 404/405, retry once on network level
  if (isNetworkError(lastError) && retryCount < MAX_RETRIES) {
    _stats.retries++;
    console.error(`Network error on fallback. Retrying in ${RETRY_DELAY_MS}ms... (attempt ${retryCount + 1}/${MAX_RETRIES})`);
    await sleep(RETRY_DELAY_MS);
    return postWithFallback(paths, payload, retryCount + 1);
  }
  throw lastError || new Error("Remote request failed.");
}

function errorMessage(error) {
  const status = error?.response?.status;
  const remoteMessage = error?.response?.data?.error || error?.response?.data?.message;
  const base = remoteMessage || error?.message || "Unknown error";
  return status ? `${base} (HTTP ${status})` : base;
}

function toTextResult(text) {
  return {
    content: [
      {
        type: "text",
        text: String(text),
      },
    ],
  };
}

function normalizeGlobEntries(data) {
  if (Array.isArray(data?.entries)) return data.entries;
  if (Array.isArray(data?.files)) return data.files;
  if (Array.isArray(data)) return data;
  return [];
}

function formatExecOutput(data) {
  const chunks = [];
  if (data?.stdout) chunks.push(`STDOUT:\n${data.stdout}`);
  if (data?.stderr) chunks.push(`STDERR:\n${data.stderr}`);
  if (data?.error) chunks.push(`ERROR:\n${data.error}`);
  // Normalize: server returns `code` for sync exec, `exitCode` for async task
  const exitCode = data?.code ?? data?.exitCode;
  if (typeof exitCode === "number") chunks.push(`EXIT_CODE: ${exitCode}`);
  return chunks.join("\n\n").trim() || "Command executed successfully with no output.";
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "remote_connect",
      description: "Switch remote connection target. View available connections or switch to a specific one.",
      inputSchema: {
        type: "object",
        properties: {
          connection: {
            type: "string",
            description: "Connection name to switch to. Leave empty to return available connections list.",
          },
        },
      },
    },
    {
      name: "remote_health",
      description: "Check if remote daemon is reachable. Must be called before first operation.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "remote_read",
      description: "Read remote workspace file content. Supports ETag cache and conditional read.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Remote file path. Supports absolute or workspace-relative path.",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "remote_write",
      description: "Write file to remote workspace. Auto CRLF→LF and BOM cleanup. Supports optimistic concurrency lock (expectedEtag).",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Remote file path. Supports absolute or workspace-relative path.",
          },
          content: {
            type: "string",
            description: "UTF-8 text content to write. Auto cleans Windows line endings and BOM.",
          },
          expectedEtag: {
            type: "string",
            description: "Optional. Optimistic concurrency lock token to prevent overwriting others' changes.",
          },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "remote_stat",
      description: "Get remote file metadata (size, modified time, is file/directory). Does not read file content.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Remote file path. Supports absolute or workspace-relative path.",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "remote_glob",
      description: "Search remote workspace files by glob pattern, e.g. **/*.ts, src/**/*.py.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Glob pattern, e.g. **/*.ts, src/**/*.py.",
          },
          cwd: {
            type: "string",
            description: "Optional. Search start directory.",
          },
        },
        required: ["pattern"],
      },
    },
    {
      name: "remote_status",
      description: "Get comprehensive connection diagnostics: status, latency, cache hit rate, operation stats.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "remote_bash",
      description: "Execute bash command on remote Linux host. Commands with special chars ($ ` \\ etc.) are auto base64 encoded to avoid escaping issues.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Bash command to execute. Commands with special chars ($ ` \\ ! \" # ; & |) are auto base64 encoded.",
          },
          cwd: {
            type: "string",
            description: "Optional. Working directory.",
          },
        },
        required: ["command"],
      },
    },
    {
      name: "remote_script",
      description: "Execute multi-line script on remote host. Script is written to temp file then executed, completely avoiding bash escaping and encoding issues. Ideal for complex scripts with variables/template strings/unicode.",
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "Script content. Written to remote temp file as-is, not parsed by bash -c.",
          },
          interpreter: {
            type: "string",
            description: "Script interpreter, default bash. Supports bash, sh, python3, node, etc.",
          },
          cwd: {
            type: "string",
            description: "Optional. Working directory.",
          },
        },
        required: ["content"],
      },
    },
    {
      name: "remote_batch",
      description: "Batch execute multiple operations (read/stat/glob/bash). Max 20 per request, more efficient than multiple individual calls.",
      inputSchema: {
        type: "object",
        properties: {
          operations: {
            type: "array",
            description: "Operations array. Each item contains type (read|stat|glob|bash) and corresponding parameters.",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["read", "stat", "glob", "bash"] },
                path: { type: "string" },
                pattern: { type: "string" },
                cwd: { type: "string" },
                command: { type: "string" },
              },
              required: ["type"],
            },
          },
        },
        required: ["operations"],
      },
    },
    {
      name: "remote_exec_async",
      description: "Async execute long-running bash command. Returns taskId immediately, use remote_task to query results.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Bash command to execute asynchronously.",
          },
          cwd: {
            type: "string",
            description: "Optional. Working directory.",
          },
        },
        required: ["command"],
      },
    },
    {
      name: "remote_task",
      description: "Query async command status and output. taskId is returned by remote_exec_async.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "Task ID returned by remote_exec_async.",
          },
        },
        required: ["taskId"],
      },
    },
    {
      name: "remote_config",
      description: "Read or modify remote daemon config (.env). Auto hot reload after modify, no restart needed. Supports GET (read) and PUT (write+reload).",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["read", "write"],
            description: "read=read current config, write=write new config and hot reload.",
          },
          config: {
            type: "string",
            description: "New .env content for write operation (full replacement).",
          },
        },
        required: ["action"],
      },
    },
    {
      name: "remote_setup",
      description: "Guided server connection setup. Collect server info, test connection, save config. Supports password and key authentication.",
      inputSchema: {
        type: "object",
        properties: {
          host: {
            type: "string",
            description: "Server address (IP or domain).",
          },
          port: {
            type: "number",
            description: "SSH port, default 22.",
          },
          username: {
            type: "string",
            description: "Login username.",
          },
          password: {
            type: "string",
            description: "Login password (either password or privateKey required).",
          },
          privateKey: {
            type: "string",
            description: "Private key file path (either password or privateKey required).",
          },
          passphrase: {
            type: "string",
            description: "Private key passphrase (if key is password-protected).",
          },
          name: {
            type: "string",
            description: "Connection name for future reference. Auto-generated if not provided.",
          },
          description: {
            type: "string",
            description: "Connection description.",
          },
          testOnly: {
            type: "boolean",
            description: "Test connection only, don't save config. Default false.",
          },
        },
        required: ["host", "username"],
      },
    },
    {
      name: "remote_ssh_info",
      description: "Scan local SSH environment: available private keys, SSH config hosts, known_hosts entries, and saved connections. Use this BEFORE remote_setup to discover what SSH resources are available on this machine.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const startTime = Date.now();
  
  try {
    const args = getArguments(request);
    
    // Only log errors (not normal calls for cleaner logs)

    switch (toolName) {
      case "remote_connect": {
        recordOp("remote_connect");
        const connectionName = args.connection;
        
        // Load connections if not loaded
        if (Object.keys(_connections).length === 0) {
          loadConnections();
        }
        
        // If no connection specified, return available connections
        if (!connectionName) {
          const connList = Object.entries(_connections).map(([name, conn]) => ({
            name,
            type: conn.type || 'daemon',
            description: conn.description,
            url: conn.type === 'ssh' ? `ssh://${conn.host}:${conn.port || 22}` : conn.url,
            current: name === _currentConnection
          }));
          return toTextResult(JSON.stringify({
            current: _currentConnection,
            connections: connList
          }, null, 2));
        }
        
        // Switch to specified connection
        if (!_connections[connectionName]) {
          return toTextResult(JSON.stringify({
            error: `Connection '${connectionName}' not found`,
            available: Object.keys(_connections)
          }));
        }
        
        _currentConnection = connectionName;
        const conn = _connections[connectionName];
        
        if (conn.type === 'ssh') {
          // SSH connection
          _connectionAxios = null;
          try {
            const sshClient = getSSHClient(connectionName);
            await sshClient.connect();
            return toTextResult(JSON.stringify({
              success: true,
              current: connectionName,
              type: 'ssh',
              host: conn.host,
              port: conn.port || 22,
              username: conn.username,
              runtimeMode: _runtimeMode.mode,
              modeSource: _runtimeMode.source,
            }));
          } catch (error) {
            return toTextResult(JSON.stringify({
              error: `SSH connection failed: ${error.message}`,
              current: connectionName
            }));
          }
        } else {
          // Daemon connection
          _connectionAxios = getAxiosInstance(connectionName);
          return toTextResult(JSON.stringify({
            success: true,
            current: connectionName,
            type: 'daemon',
            url: conn.url,
            runtimeMode: _runtimeMode.mode,
            modeSource: _runtimeMode.source,
          }));
        }
      }
      
      case "remote_health": {
        recordOp("remote_health");
        
        // Check if current connection is SSH
        if (isSSHConnection()) {
          try {
            const sshClient = getSSHClient();
            if (sshClient.isConnected()) {
              markHealthy();
              return toTextResult(
                JSON.stringify({
                  ok: true,
                  type: 'ssh',
                  connection: _currentConnection || 'default',
                  host: _connections[_currentConnection]?.host,
                  port: _connections[_currentConnection]?.port || 22,
                  username: _connections[_currentConnection]?.username,
                  runtimeMode: _runtimeMode.mode,
                  modeSource: _runtimeMode.source,
                }, null, 2)
              );
            } else {
              // Try to connect
              await sshClient.connect();
              markHealthy();
              return toTextResult(
                JSON.stringify({
                  ok: true,
                  type: 'ssh',
                  connection: _currentConnection || 'default',
                  host: _connections[_currentConnection]?.host,
                  port: _connections[_currentConnection]?.port || 22,
                  username: _connections[_currentConnection]?.username,
                  message: 'Connected successfully',
                  runtimeMode: _runtimeMode.mode,
                  modeSource: _runtimeMode.source,
                }, null, 2)
              );
            }
          } catch (error) {
            return toTextResult(
              JSON.stringify({
                ok: false,
                type: 'ssh',
                connection: _currentConnection || 'default',
                error: error.message,
              }, null, 2)
            );
          }
        }
        
        // Daemon mode
        const healthAxios = getCurrentAxios();
        const currentUrl = _currentConnection ? _connections[_currentConnection]?.url : REMOTE_URL;
        // Try lightweight GET /healthz first, fallback to POST echo
        try {
          const healthResp = await healthAxios.get("/healthz", { validateStatus: () => true, timeout: 5000 });
          if (healthResp.status === 200) {
            markHealthy(healthResp.data?.workspaceRoot);
            return toTextResult(
              JSON.stringify(
                {
                  ok: true,
                  type: 'daemon',
                  remoteUrl: currentUrl,
                  connection: _currentConnection || 'default',
                  authEnabled: Boolean(AUTH_TOKEN),
                  clientId: CLIENT_ID || null,
                  timeoutMs: REQUEST_TIMEOUT_MS,
                  healthCacheTTL: HEALTH_CACHE_TTL_MS,
                  cacheValidUntil: new Date(_lastHealthTime + HEALTH_CACHE_TTL_MS).toISOString(),
                  runtimeMode: _runtimeMode.mode,
                  modeSource: _runtimeMode.source,
                  remoteInfo: healthResp.data || null,
                },
                null,
                2
              )
            );
          }
        } catch (_) {
          // /healthz failed, fall through to POST echo probe
        }
        // Fallback: execute echo command to verify daemon is reachable
        await postWithFallback(["/api/exec", "/api/cmd/execute", "/bash"], { command: "echo mcp-remote-agent-ok" });
        markHealthy(); // No workspaceRoot from echo fallback
        return toTextResult(
          JSON.stringify(
            {
              ok: true,
              type: 'daemon',
              remoteUrl: currentUrl,
              connection: _currentConnection || 'default',
              authEnabled: Boolean(AUTH_TOKEN),
              clientId: CLIENT_ID || null,
              timeoutMs: REQUEST_TIMEOUT_MS,
              healthCacheTTL: HEALTH_CACHE_TTL_MS,
              cacheValidUntil: new Date(_lastHealthTime + HEALTH_CACHE_TTL_MS).toISOString(),
              runtimeMode: _runtimeMode.mode,
              modeSource: _runtimeMode.source,
              remoteInfo: null,
            },
            null,
            2
          )
        );
      }

      case "remote_status": {
        recordOp("remote_status");
        
        // SSH mode
        if (isSSHConnection()) {
          const sshClient = getSSHClient();
          const conn = _connections[_currentConnection];
          const uptimeSec = Math.floor((Date.now() - _stats.startTime) / 1000);
          const cacheHitRate = _stats.cacheHits + _stats.cacheMisses > 0
            ? `${Math.round((_stats.cacheHits / (_stats.cacheHits + _stats.cacheMisses)) * 100)}%`
            : "N/A";

          return toTextResult(
            JSON.stringify({
              connection: {
                type: 'ssh',
                host: conn.host,
                port: conn.port || 22,
                username: conn.username,
                connected: sshClient.isConnected(),
                connectionName: _currentConnection || 'default',
              },
              runtime: {
                mode: _runtimeMode.mode,
                source: _runtimeMode.source,
                requestedMode: _runtimeMode.requestedMode || _runtimeMode.mode,
                detectedMode: _runtimeMode.detectedMode || 'unknown',
              },
              localCache: {
                healthCacheValid: isHealthCacheValid(),
                healthCacheTTL: `${HEALTH_CACHE_TTL_MS / 1000}s`,
                etagCacheSize: _etagCache.size,
                etagCacheMax: ETAG_CACHE_MAX,
                etagCacheTTL: `${ETAG_CACHE_TTL_MS / 1000}s`,
              },
              stats: {
                uptimeSeconds: uptimeSec,
                totalRequests: _stats.totalRequests,
                etagCacheHitRate: cacheHitRate,
                etagCacheHits: _stats.cacheHits,
                etagCacheMisses: _stats.cacheMisses,
                retries: _stats.retries,
                errors: _stats.errors,
                lastOperation: _stats.lastOperation,
                lastOperationTime: _stats.lastOperationTime,
              },
            }, null, 2)
          );
        }

        // Daemon mode
        const healthOk = isHealthCacheValid();
        let remoteInfo = null;
        let latencyMs = null;
        const currentUrl = _currentConnection ? _connections[_currentConnection]?.url : REMOTE_URL;

        // Always try to fetch remote status
        const startMs = Date.now();
        try {
          const data = await getCurrentAxios().get("/healthz", { validateStatus: () => true, timeout: 5000 });
          latencyMs = Date.now() - startMs;
          if (data.status === 200) {
            remoteInfo = data.data;
            markHealthy(data.data?.workspaceRoot);
          }
        } catch (error) {
          latencyMs = Date.now() - startMs;
          if (isNetworkError(error)) markUnhealthy();
        }

        const uptimeSec = Math.floor((Date.now() - _stats.startTime) / 1000);
        const cacheHitRate = _stats.cacheHits + _stats.cacheMisses > 0
          ? `${Math.round((_stats.cacheHits / (_stats.cacheHits + _stats.cacheMisses)) * 100)}%`
          : "N/A";

        return toTextResult(
          JSON.stringify({
            connection: {
              type: 'daemon',
              remoteUrl: currentUrl,
              connected: healthOk || remoteInfo !== null,
              latencyMs,
              authEnabled: Boolean(AUTH_TOKEN),
              clientId: CLIENT_ID || null,
            },
            runtime: {
              mode: _runtimeMode.mode,
              source: _runtimeMode.source,
              requestedMode: _runtimeMode.requestedMode || _runtimeMode.mode,
              detectedMode: _runtimeMode.detectedMode || 'unknown',
            },
            remote: remoteInfo || "unreachable",
            localCache: {
              healthCacheValid: healthOk,
              healthCacheTTL: `${HEALTH_CACHE_TTL_MS / 1000}s`,
              etagCacheSize: _etagCache.size,
              etagCacheMax: ETAG_CACHE_MAX,
              etagCacheTTL: `${ETAG_CACHE_TTL_MS / 1000}s`,
            },
            stats: {
              uptimeSeconds: uptimeSec,
              totalRequests: _stats.totalRequests,
              etagCacheHitRate: cacheHitRate,
              etagCacheHits: _stats.cacheHits,
              etagCacheMisses: _stats.cacheMisses,
              retries: _stats.retries,
              errors: _stats.errors,
              lastOperation: _stats.lastOperation,
              lastOperationTime: _stats.lastOperationTime,
            },
          }, null, 2)
        );
      }

      case "remote_read": {
        recordOp("remote_read");
        const readPath = requireNonEmptyString(args, "path");

        // SSH mode
        if (isSSHConnection()) {
          try {
            const sshClient = getSSHClient();
            const content = await sshClient.readFile(readPath);
            return toTextResult(content);
          } catch (error) {
            return toTextResult(`Error reading file: ${error.message}`);
          }
        }

        // Daemon mode
        try { await ensureHealthy("Consider calling remote_health first to check if remote service is reachable before reading."); } catch (e) { if (isHealthError(e)) return healthCheckError(e.message + "\n\nIf you're sure the service is normal, you can ignore this提示 and retry directly."); throw e; }

        // Check local ETag cache first
        const cached = getEtagCache(readPath);
        if (cached) {
          // Send conditional read with If-None-Match
          try {
            const response = await getCurrentAxios().post("/api/fs/read", { path: readPath }, {
              headers: { "If-None-Match": cached.etag },
              validateStatus: (s) => s === 200 || s === 304,
            });
            if (response.status === 304) {
              _stats.cacheHits++;
              return toTextResult(cached.content);
            }
            // 200: content changed
            _stats.cacheMisses++;
            const newContent = response.data?.content ?? "";
            const newEtag = response.data?.etag;
            if (newEtag) setEtagCache(readPath, newEtag, newContent);
            return toTextResult(typeof newContent === "string" ? newContent : JSON.stringify(response.data, null, 2));
          } catch (error) {
            // Conditional read not supported by server, fall through to normal read
            if (isNetworkError(error)) throw error;
          }
        }

        // Normal read (no cache or conditional read not supported)
        const data = await postWithFallback(["/api/fs/read", "/read"], { path: readPath });
        const etag = data?.etag;
        const content = typeof data.content === "string" ? data.content : JSON.stringify(data, null, 2);
        _stats.cacheMisses++;
        if (etag && typeof data.content === "string") {
          setEtagCache(readPath, etag, data.content);
        }
        return toTextResult(content);
      }

      case "remote_write": {
        recordOp("remote_write");
        const writePath = requireNonEmptyString(args, "path");
        const content = sanitizeContent(requireNonEmptyString(args, "content"));

        // SSH mode
        if (isSSHConnection()) {
          try {
            const sshClient = getSSHClient();
            await sshClient.writeFile(writePath, content);
            return toTextResult("File written successfully.");
          } catch (error) {
            return toTextResult(`Error writing file: ${error.message}`);
          }
        }

        // Daemon mode
        try { await ensureHealthy("Must confirm remote service is reachable before write operation. Consider calling remote_health first."); } catch (e) { if (isHealthError(e)) return healthCheckError(e.message + "\n\nIf you're sure the service is normal, you can ignore this提示 and retry directly."); throw e; }
        let expectedEtag = typeof args.expectedEtag === "string" ? args.expectedEtag.trim() : "";

        if (!expectedEtag) {
          try {
            const current = await postWithFallback(["/api/fs/read", "/read"], { path: writePath });
            if (typeof current?.etag === "string" && current.etag) {
              expectedEtag = current.etag;
            }
          } catch (error) {
            const msg = errorMessage(error);
            if (!/ENOENT|no such file|not found/i.test(msg)) {
              // Ignore read-precheck errors and keep write best-effort for compatibility.
            }
          }
        }

        const data = await postWithFallback(["/api/fs/write", "/write"], {
          path: writePath,
          content,
          ...(expectedEtag ? { expectedEtag } : {}),
        });
        return toTextResult(data?.message || "File written successfully.");
      }

      case "remote_stat": {
        recordOp("remote_stat");
        const statPath = requireNonEmptyString(args, "path");

        // SSH mode
        if (isSSHConnection()) {
          try {
            const sshClient = getSSHClient();
            const stats = await sshClient.stat(statPath);
            return toTextResult(JSON.stringify(withRuntimeMeta({
              path: statPath,
              ...stats,
            }), null, 2));
          } catch (error) {
            return toTextResult(`Stat error: ${error.message}`);
          }
        }

        // Daemon mode
        try { await ensureHealthy(); } catch (e) { if (isHealthError(e)) return healthCheckError(e.message); throw e; }
        try {
          // Use batch with a single stat operation (server supports stat via batch)
          const response = await getCurrentAxios().post("/api/batch", {
            operations: [{ type: "stat", path: statPath }],
          });
          const data = response.data;
          if (data?.success && data.results?.length > 0) {
            const r = data.results[0];
            if (r.status === 200) {
              return toTextResult(JSON.stringify(withRuntimeMeta({
                path: statPath,
                size: r.size,
                mtime: r.mtime,
                isFile: r.isFile,
                // Normalize: server may return isDir or isDirectory
                isDirectory: r.isDirectory !== undefined ? r.isDirectory : (r.isDir !== undefined ? r.isDir : !r.isFile),
              }), null, 2));
            }
            return toTextResult(`Stat failed: ${r.error || "Unknown error"}`);
          }
          return toTextResult(`Stat failed: ${data?.error || "Unknown error"}`);
        } catch (error) {
          return toTextResult(`Stat error: ${errorMessage(error)}`);
        }
      }

      case "remote_glob": {
        recordOp("remote_glob");
        const pattern = requireNonEmptyString(args, "pattern");
        const cwd = typeof args.cwd === "string" ? args.cwd : undefined;

        // SSH mode
        if (isSSHConnection()) {
          try {
            const sshClient = getSSHClient();
            const files = await sshClient.glob(pattern, cwd);
            return toTextResult(JSON.stringify(files, null, 2));
          } catch (error) {
            return toTextResult(`Glob error: ${error.message}`);
          }
        }

        // Daemon mode
        try { await ensureHealthy("Consider calling remote_health first to check if remote service is reachable before searching."); } catch (e) { if (isHealthError(e)) return healthCheckError(e.message + "\n\nIf you're sure the service is normal, you can ignore this提示 and retry directly."); throw e; }
        const data = await postWithFallback(["/api/fs/glob", "/glob"], {
          pattern,
          cwd,
        });
        return toTextResult(JSON.stringify(normalizeGlobEntries(data), null, 2));
      }

      case "remote_bash": {
        recordOp("remote_bash");
        const command = requireNonEmptyString(args, "command");
        const cwd = typeof args.cwd === "string" ? args.cwd : undefined;

        // SSH mode
        if (isSSHConnection()) {
          try {
            const sshClient = getSSHClient();
            const result = await sshClient.exec(command, { cwd });
            return toTextResult(formatExecOutput(result));
          } catch (error) {
            return toTextResult(`Bash error: ${error.message}`);
          }
        }

        // Daemon mode
        try { await ensureHealthy("Consider calling remote_health first to check if remote service is reachable before executing commands."); } catch (e) { if (isHealthError(e)) return healthCheckError(e.message + "\n\nIf you're sure the service is normal, you can ignore this提示 and retry directly."); throw e; }
        // Auto base64 escape for commands containing bash special chars
        const effectiveCommand = needsBase64Escape(command) ? wrapBase64Command(command) : command;
        const data = await postWithFallback(["/api/exec", "/api/cmd/execute", "/bash"], { command: effectiveCommand, cwd });
        return toTextResult(formatExecOutput(data));
      }

      case "remote_script": {
        recordOp("remote_script");
        const scriptContent = sanitizeContent(requireNonEmptyString(args, "content"));
        let interpreter = typeof args.interpreter === "string" && args.interpreter.trim() ? args.interpreter.trim() : "bash";
        // Validate interpreter against whitelist to prevent command injection
        if (!ALLOWED_INTERPRETERS.has(interpreter)) {
          return toTextResult(`Error: Unsupported interpreter '${interpreter}'. Allowed: ${[...ALLOWED_INTERPRETERS].join(", ")}`);
        }
        const cwd = typeof args.cwd === "string" ? args.cwd : undefined;

        // SSH mode
        if (isSSHConnection()) {
          try {
            const sshClient = getSSHClient();
            const tmpFile = `/tmp/mcp-remote-agent-script-${Date.now()}.sh`;
            // Write script to temp file
            await sshClient.writeFile(tmpFile, scriptContent);
            // Execute the script
            const result = await sshClient.exec(`${interpreter} ${tmpFile}`, { cwd });
            // Cleanup temp file (best effort)
            sshClient.rm(tmpFile).catch(() => {});
            return toTextResult(formatExecOutput(result));
          } catch (error) {
            return toTextResult(`Script exec error: ${error.message}`);
          }
        }

        // Daemon mode
        try { await ensureHealthy(); } catch (e) { if (isHealthError(e)) return healthCheckError(e.message); throw e; }
        try {
          const response = await getCurrentAxios().post("/api/exec/script", {
            content: scriptContent,
            interpreter,
            cwd,
          });
          const data = response.data;
          return toTextResult(formatExecOutput(data));
        } catch (error) {
          // If server doesn't support /api/exec/script yet, fallback to write + bash
          if (error?.response?.status === 404 || error?.response?.status === 405) {
            const tmpFile = _workspaceRoot
              ? `${_workspaceRoot}/.mcp-remote-agent-tmp/script-${Date.now()}.sh`
              : `/tmp/mcp-remote-agent-script-${Date.now()}.sh`;
            try {
              // Ensure temp directory exists (workspace mode)
              if (_workspaceRoot) {
                await postWithFallback(["/api/exec", "/bash"], {
                  command: `mkdir -p ${_workspaceRoot}/.mcp-remote-agent-tmp`,
                }).catch(() => {});
              }
              // Write script to temp file
              await postWithFallback(["/api/fs/write", "/write"], {
                path: tmpFile,
                content: scriptContent,
              });
              // Execute the script
              const execData = await postWithFallback(["/api/exec", "/api/cmd/execute", "/bash"], {
                command: `${interpreter} ${tmpFile}`,
                cwd,
              });
              // Cleanup temp file (best effort)
              postWithFallback(["/api/exec", "/bash"], { command: `rm -f ${tmpFile}` }).catch(() => {});
              return toTextResult(formatExecOutput(execData));
            } catch (fallbackError) {
              return toTextResult(`Script exec error (fallback): ${errorMessage(fallbackError)}`);
            }
          }
          return toTextResult(`Script exec error: ${errorMessage(error)}`);
        }
      }

      case "remote_batch": {
        recordOp("remote_batch");
        const operations = args.operations;
        if (!Array.isArray(operations) || operations.length === 0) {
          return toTextResult("Error: operations must be a non-empty array.");
        }
        if (operations.length > 20) {
          return toTextResult("Error: Maximum 20 operations per batch.");
        }

        // SSH mode
        if (isSSHConnection()) {
          try {
            const sshClient = getSSHClient();
            const results = [];
            for (const op of operations) {
              try {
                if (op.type === "read") {
                  const content = await sshClient.readFile(op.path);
                  results.push({ type: "read", path: op.path, status: 200, content });
                } else if (op.type === "stat") {
                  const stats = await sshClient.stat(op.path);
                  results.push({ type: "stat", path: op.path, status: 200, ...stats });
                } else if (op.type === "glob") {
                  const files = await sshClient.glob(op.pattern, op.cwd);
                  results.push({ type: "glob", pattern: op.pattern, status: 200, entries: files });
                } else if (op.type === "bash") {
                  const result = await sshClient.exec(op.command, { cwd: op.cwd });
                  results.push({ type: "bash", command: op.command, status: 200, ...result });
                } else {
                  results.push({ type: op.type, status: 400, error: "Unknown operation type" });
                }
              } catch (error) {
                results.push({ type: op.type, status: 500, error: error.message });
              }
            }

            // Format results
            const lines = [
              `[Runtime] mode=${_runtimeMode.mode}, source=${_runtimeMode.source}`,
              `Batch completed: ${results.length} operations`
            ];
            for (const r of results) {
              if (r.status === 200) {
                if (r.type === "read") {
                  lines.push(`\n--- READ ${r.path} ---`);
                  lines.push(r.content || "");
                } else if (r.type === "stat") {
                  lines.push(`\n--- STAT ${r.path} ---`);
                  lines.push(`size=${r.size} mtime=${r.mtime} isFile=${r.isFile} isDirectory=${r.isDirectory}`);
                } else if (r.type === "glob") {
                  lines.push(`\n--- GLOB ${r.pattern} ---`);
                  lines.push(JSON.stringify(r.entries, null, 2));
                } else if (r.type === "bash") {
                  lines.push(`\n--- BASH ${r.command} ---`);
                  if (r.stdout) lines.push(r.stdout);
                  if (r.stderr) lines.push(`STDERR: ${r.stderr}`);
                }
              } else {
                lines.push(`\n--- ${r.type.toUpperCase()} FAILED (status=${r.status}) ---`);
                lines.push(r.error || "Unknown error");
              }
            }
            return toTextResult(lines.join("\n"));
          } catch (error) {
            return toTextResult(`Batch error: ${error.message}`);
          }
        }

        // Daemon mode
        try { await ensureHealthy(); } catch (e) { if (isHealthError(e)) return healthCheckError(e.message); throw e; }
        try {
          const response = await getCurrentAxios().post("/api/batch", { operations });
          const data = response.data;
          if (!data?.success) {
            return toTextResult(`Batch error: ${data?.error || "Unknown error"}`);
          }
          // Format results
          const lines = [
            `[Runtime] mode=${_runtimeMode.mode}, source=${_runtimeMode.source}`,
            `Batch completed: ${data.results.length} operations`
          ];
          for (const r of data.results) {
            if (r.status === 200) {
              if (r.type === "read") {
                lines.push(`\n--- READ ${r.path} (${r.ms}ms) ---`);
                lines.push(r.content || "");
              } else if (r.type === "stat") {
                lines.push(`\n--- STAT ${r.path} (${r.ms}ms) ---`);
                const isDir = r.isDirectory !== undefined ? r.isDirectory : (r.isDir !== undefined ? r.isDir : !r.isFile);
                lines.push(`size=${r.size} mtime=${r.mtime} isFile=${r.isFile} isDirectory=${isDir}`);
              } else if (r.type === "glob") {
                lines.push(`\n--- GLOB ${r.pattern} (${r.ms}ms) ---`);
                lines.push(JSON.stringify(r.entries, null, 2));
              } else if (r.type === "bash") {
                lines.push(`\n--- BASH ${r.command} (${r.ms}ms) ---`);
                if (r.stdout) lines.push(r.stdout);
                if (r.stderr) lines.push(`STDERR: ${r.stderr}`);
              }
            } else {
              lines.push(`\n--- ${r.type.toUpperCase()} FAILED (status=${r.status}) ---`);
              lines.push(r.error || "Unknown error");
            }
          }
          return toTextResult(lines.join("\n"));
        } catch (error) {
          return toTextResult(`Batch error: ${errorMessage(error)}`);
        }
      }

      case "remote_exec_async": {
        recordOp("remote_exec_async");
        
        // SSH mode - not supported
        if (isSSHConnection()) {
          return toTextResult(JSON.stringify(withRuntimeMeta({
            error: "Async execution is not supported in SSH mode",
            message: "SSH connections do not support async execution. Use remote_bash for synchronous execution, or switch to daemon mode for async support.",
          }), null, 2));
        }

        // Daemon mode
        try { await ensureHealthy(); } catch (e) { if (isHealthError(e)) return healthCheckError(e.message); throw e; }
        const command = requireNonEmptyString(args, "command");
        const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
        // Auto base64 escape for commands containing bash special chars (same as remote_bash)
        const effectiveCommand = needsBase64Escape(command) ? wrapBase64Command(command) : command;
        try {
          const response = await getCurrentAxios().post("/api/exec/async", { command: effectiveCommand, cwd });
          const data = response.data;
          return toTextResult(JSON.stringify(withRuntimeMeta({
            taskId: data.taskId,
            status: data.status,
            createdAt: data.createdAt,
            message: `Task ${data.taskId} started. Use remote_task with this taskId to check progress.`,
          }), null, 2));
        } catch (error) {
          return toTextResult(`Async exec error: ${errorMessage(error)}`);
        }
      }

      case "remote_task": {
        recordOp("remote_task");
        
        // SSH mode - not supported
        if (isSSHConnection()) {
          return toTextResult(JSON.stringify(withRuntimeMeta({
            error: "Task query is not supported in SSH mode",
            message: "SSH connections do not support task queries. Use remote_bash for synchronous execution, or switch to daemon mode for task support.",
          }), null, 2));
        }

        // Daemon mode
        try { await ensureHealthy(); } catch (e) { if (isHealthError(e)) return healthCheckError(e.message); throw e; }
        const taskId = requireNonEmptyString(args, "taskId");
        try {
          const response = await getCurrentAxios().get(`/api/task/${taskId}`);
          const data = response.data;
          const result = withRuntimeMeta({
            taskId: data.id,
            status: data.status,
            command: data.command,
          });
          if (data.status === "completed" || data.status === "error") {
            result.exitCode = data.exitCode;
            result.stdout = data.stdout;
            result.stderr = data.stderr;
            // Safely calculate duration — handle both timestamps (ms) and ISO strings
            if (data.finishedAt && data.createdAt) {
              const finished = typeof data.finishedAt === "number" ? data.finishedAt : new Date(data.finishedAt).getTime();
              const created = typeof data.createdAt === "number" ? data.createdAt : new Date(data.createdAt).getTime();
              const durationSec = (finished - created) / 1000;
              result.duration = Number.isFinite(durationSec) ? `${durationSec.toFixed(1)}s` : null;
            } else {
              result.duration = null;
            }
          }
          return toTextResult(JSON.stringify(result, null, 2));
        } catch (error) {
          return toTextResult(`Task error: ${errorMessage(error)}`);
        }
      }

      case "remote_config": {
        recordOp("remote_config");
        
        // SSH mode - not supported
        if (isSSHConnection()) {
          return toTextResult(JSON.stringify(withRuntimeMeta({
            error: "Config management is not supported in SSH mode",
            message: "SSH connections do not support config management. Switch to daemon mode for config support.",
          }), null, 2));
        }

        // Daemon mode
        const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
        if (action === "read") {
          try {
            const response = await getCurrentAxios().get("/api/config");
            const data = response.data;
            if (data.success) {
              return toTextResult(
                `[Runtime] mode=${_runtimeMode.mode}, source=${_runtimeMode.source}\nConfig (${data.envPath}):\n${data.config}\n\nRuntime:\n${JSON.stringify(data.runtime, null, 2)}`
              );
            }
            return toTextResult(`Config read failed: ${data.error || "Unknown error"}`);
          } catch (error) {
            return toTextResult(`Config read error: ${errorMessage(error)}`);
          }
        } else if (action === "write") {
          const newConfig = typeof args.config === "string" ? args.config : "";
          if (!newConfig.trim()) {
            return toTextResult("Error: config field is required for write action.");
          }
          try {
            const response = await getCurrentAxios().put("/api/config", { config: newConfig });
            const data = response.data;
            if (data.success) {
              return toTextResult(
                `[Runtime] mode=${_runtimeMode.mode}, source=${_runtimeMode.source}\n✅ Config updated and reloaded!\nClients: ${data.clients?.join(", ")}\nWorkspace: ${data.workspaceRoot}`
              );
            }
            return toTextResult(`Config write failed: ${data.error || "Unknown error"}`);
          } catch (error) {
            return toTextResult(`Config write error: ${errorMessage(error)}`);
          }
        } else {
          return toTextResult("Error: action must be 'read' or 'write'.");
        }
      }

      case "remote_setup": {
        recordOp("remote_setup");
        
        const host = requireNonEmptyString(args, "host");
        const username = requireNonEmptyString(args, "username");
        const port = typeof args.port === "number" ? args.port : 22;
        const password = typeof args.password === "string" ? args.password : "";
        const privateKey = typeof args.privateKey === "string" ? args.privateKey : "";
        const passphrase = typeof args.passphrase === "string" ? args.passphrase : "";
        const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : `ssh-${host.replace(/\./g, '-')}`;
        const description = typeof args.description === "string" ? args.description : `${username}@${host}:${port}`;
        const testOnly = args.testOnly === true;

        // Validate: need either password or privateKey
        // If neither provided, auto-scan SSH environment and return smart recommendations
        if (!password && !privateKey) {
          const sshInfo = scanLocalSSH();
          const recommendations = [];

          // Check SSH config for host match
          const configMatches = sshInfo.configHosts.filter(h =>
            h.host === host || h.alias === host
          );
          if (configMatches.length > 0) {
            for (const m of configMatches) {
              recommendations.push({
                type: "config",
                message: `SSH config 中发现匹配主机 '${m.alias}' → ${m.host || host}:${m.port} user=${m.user || username}`,
                alias: m.alias,
                user: m.user,
                port: m.port,
                identityFile: m.identityFile,
              });
            }
          }

          // List usable (unencrypted) private keys
          const usableKeys = sshInfo.privateKeys.filter(k => !k.encrypted);
          const encryptedKeys = sshInfo.privateKeys.filter(k => k.encrypted);
          if (usableKeys.length > 0) {
            for (const k of usableKeys) {
              recommendations.push({
                type: "key",
                message: `发现可用密钥 ${k.file}（${k.type}，未加密）`,
                file: k.file,
                path: k.path,
                keyType: k.type,
              });
            }
          }
          if (encryptedKeys.length > 0) {
            for (const k of encryptedKeys) {
              recommendations.push({
                type: "key_encrypted",
                message: `发现加密密钥 ${k.file}（${k.type}，需要密钥密码）`,
                file: k.file,
                path: k.path,
                keyType: k.type,
              });
            }
          }

          // Check known_hosts
          const knownHostMatch = sshInfo.knownHosts.includes(host);

          // Build human-readable summary
          const lines = [`## 🔍 SSH 环境扫描结果\n`];
          lines.push(formatSSHScanSummary(sshInfo));
          lines.push('');

          if (configMatches.length > 0) {
            lines.push(`### ✅ 推荐：使用 SSH config 配置`);
            lines.push(`检测到 config 中已有 ${host} 的配置，可直接连接。`);
            lines.push('');
          } else if (usableKeys.length > 0) {
            lines.push(`### 💡 推荐：使用密钥登录`);
            for (const k of usableKeys) {
              lines.push(`  - ${k.file} (${k.type}) → privateKey="${k.path}"`);
            }
            lines.push('');
          } else {
            lines.push(`### ❌ 未找到可用密钥`);
            lines.push(`建议选择以下方式之一：`);
            lines.push(`  1. 使用密码登录（提供 password 参数）`);
            lines.push(`  2. 使用加密密钥（提供 privateKey + passphrase 参数）`);
            lines.push('');
          }

          if (knownHostMatch) {
            lines.push(`ℹ️ 此主机已在 known_hosts 中，之前连接过。`);
          }

          return toTextResult(JSON.stringify(withRuntimeMeta({
            success: false,
            needsAuth: true,
            message: `未提供认证信息，已自动扫描本地 SSH 环境`,
            host,
            username,
            sshInfo,
            recommendations,
            knownHostMatch,
            summary: lines.join('\n'),
            hint: "请根据以上推荐信息，提供 privateKey 或 password 参数后重新调用 remote_setup",
          }), null, 2));
        }

        // Build SSH config
        const sshConfig = { host, port, username };
        if (password) sshConfig.password = password;
        if (privateKey) sshConfig.privateKey = privateKey;
        if (passphrase) sshConfig.passphrase = passphrase;

        // Test connection
        const testClient = new SSHClient(sshConfig);
        try {
          await testClient.connect();
          const result = await testClient.exec('echo "connected" && uname -a && whoami');
          
          // Auto-deploy daemon
          const autoDeploy = args.autoDeploy !== false; // default true
          let daemonInfo = null;
          
          if (autoDeploy) {
            try {
              // Check if daemon already exists
              const daemonCheck = await testClient.exec('test -d ~/.mcp-remote-agent/daemon && echo "exists" || echo "not exists"');
              const daemonExists = daemonCheck.stdout.includes('exists');
              
              if (!daemonExists) {
                // Upload server files
                const serverDir = path.join(__dirname, 'server');
                const files = ['server.js', 'package.json', 'mcp-remote-agent-manager.sh', 'setup-autostart.sh', 'dashboard.html'];
                
                await testClient.exec('mkdir -p ~/.mcp-remote-agent/daemon');
                // Clean up leftover temp files from previous deployments
                await testClient.exec('rm -f ~/.mcp-remote-agent/daemon/*.clobbered ~/.mcp-remote-agent/daemon/*.tmp ~/.mcp-remote-agent/daemon/*.bak 2>/dev/null; true');
                
                for (const file of files) {
                  const localPath = path.join(serverDir, file);
                  if (fs.existsSync(localPath)) {
                    const content = fs.readFileSync(localPath, 'utf-8');
                    await testClient.writeFile(`~/.mcp-remote-agent/daemon/${file}`, content);
                  }
                }
                
                // Install dependencies
                await testClient.exec('cd ~/.mcp-remote-agent/daemon && npm install --production 2>&1');
              }
              
              // Generate secure auth token (auto-generated, no user input needed)
              const token = `mcp-${host.replace(/\./g, '-')}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
              const clientId = args.clientId || `client-${username}-${host.replace(/\./g, '-')}`;
              
              // Create .env file
              const envContent = [
                `PORT=3183`,
                `BIND_HOST=0.0.0.0`,
                `WORKSPACE_ROOT=/home/${username}`,
                `AUTH_TOKEN=${token}`,
                `CLIENT_IDS=${clientId}`,
                `EXEC_TIMEOUT_MS=120000`,
                `EXEC_MAX_CONCURRENCY=2`,
              ].join('\n');
              await testClient.writeFile(`~/.mcp-remote-agent/daemon/.env`, envContent);
              
              // Start daemon (check if already running)
              const runningCheck = await testClient.exec('pgrep -f "node server.js" || echo "not running"');
              if (runningCheck.stdout.includes('not running')) {
                await testClient.exec('cd ~/.mcp-remote-agent/daemon && nohup node server.js > daemon.log 2>&1 &');
                await testClient.exec('sleep 2');
              }
              
              // Get daemon URL
              daemonInfo = {
                url: `http://${host}:3183`,
                authToken: token,
                clientId: clientId,
                workspaceRoot: `/home/${username}`,
              };
            } catch (deployError) {
              // Deployment failed, but SSH connection worked
              daemonInfo = { error: deployError.message };
            }
          }
          
          testClient.disconnect();

          if (testOnly) {
            return toTextResult(JSON.stringify(withRuntimeMeta({
              success: true,
              message: "Connection test successful!",
              server: result.stdout,
            }), null, 2));
          }

          // Save SSH connection config
          const connConfig = {
            name,
            type: "ssh",
            description,
            host,
            port,
            username,
          };
          if (password) connConfig.password = password;
          if (privateKey) connConfig.privateKey = privateKey;
          if (passphrase) connConfig.passphrase = passphrase;

          // Update connections.json
          const configPath = path.join(__dirname, 'local', 'connections.json');
          let config = { connections: [], default: name };
          try {
            if (fs.existsSync(configPath)) {
              config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            }
          } catch {}

          // Save daemon connection if deployed (after config is initialized)
          if (daemonInfo && !daemonInfo.error) {
            const daemonName = `${name}-daemon`;
            const daemonConn = {
              name: daemonName,
              type: "daemon",
              description: `${description} (daemon)`,
              url: daemonInfo.url,
              authToken: daemonInfo.authToken,
              clientId: daemonInfo.clientId,
            };
            
            // Add daemon connection
            const existingDaemonIdx = config.connections.findIndex(c => c.name === daemonName);
            if (existingDaemonIdx >= 0) {
              config.connections[existingDaemonIdx] = daemonConn;
            } else {
              config.connections.push(daemonConn);
            }
            config.default = daemonName; // Switch to daemon by default
          }

          // Add or update SSH connection
          const existingIdx = config.connections.findIndex(c => c.name === name);
          if (existingIdx >= 0) {
            config.connections[existingIdx] = connConfig;
          } else {
            config.connections.push(connConfig);
          }
          // Don't override default if daemon was deployed
          if (!daemonInfo || daemonInfo.error) {
            config.default = name;
          }

          // Ensure local directory exists
          const localDir = path.join(__dirname, 'local');
          if (!fs.existsSync(localDir)) {
            fs.mkdirSync(localDir, { recursive: true });
          }
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

          // Register daemon connection in memory if deployed
          if (daemonInfo && !daemonInfo.error) {
            const daemonName = `${name}-daemon`;
            _connections[daemonName] = {
              type: "daemon",
              url: daemonInfo.url,
              authToken: daemonInfo.authToken,
              clientId: daemonInfo.clientId,
            };
            _currentConnection = daemonName;
            _connectionAxios = axios.create({
              baseURL: daemonInfo.url,
              timeout: REQUEST_TIMEOUT_MS,
              headers: {
                authorization: `Bearer ${daemonInfo.authToken}`,
                "x-mcp-client-id": daemonInfo.clientId,
                "Content-Type": "application/json",
              },
            });
          } else {
            // Register SSH connection in memory
            _connections[name] = connConfig;
            _sshManager.addConnection(name, connConfig);
            _currentConnection = name;
            _connectionAxios = null;
          }

          // Build response message
          let message = '✅ Connection successful!';
          if (daemonInfo && !daemonInfo.error) {
            const dashboardUrl = `${daemonInfo.url}/?token=${daemonInfo.authToken}`;
            message = [
              '✅ Development environment ready!',
              '',
              '**Connection Info:**',
              `- SSH: ${username}@${host}:${port}`,
              `- Daemon: ${daemonInfo.url}`,
              `- Workspace: ${daemonInfo.workspaceRoot}`,
              '',
              '**📊 Monitor Status:**',
              `Open Dashboard to view real-time status: ${dashboardUrl}`,
              '(View connection status, client list, command execution logs, etc.)',
              '',
              'Ready for remote development!',
            ].join('\n');
          } else if (daemonInfo && daemonInfo.error) {
            message = `⚠️ SSH connection succeeded, but daemon deployment failed: ${daemonInfo.error}\n\nYou can still develop via SSH mode.`;
          } else {
            message = `✅ SSH connection saved!\nReady for remote development.`;
          }

          const resultData = withRuntimeMeta({
            success: true,
            message: message,
            ssh: { connection: name, host: `${username}@${host}:${port}`, server: result.stdout },
            saved: configPath,
            defaultConnection: _currentConnection,
          });
          
          if (daemonInfo && !daemonInfo.error) {
            resultData.daemon = {
              url: daemonInfo.url,
              dashboardUrl: `${daemonInfo.url}/?token=${daemonInfo.authToken}`,
              authToken: daemonInfo.authToken,
              workspaceRoot: daemonInfo.workspaceRoot,
            };
          } else if (daemonInfo) {
            resultData.daemon = daemonInfo;
          }
          
          return toTextResult(JSON.stringify(resultData, null, 2));
        } catch (error) {
          try { testClient.disconnect(); } catch {}
          return toTextResult(JSON.stringify(withRuntimeMeta({
            success: false,
            error: error.message,
            hint: password 
              ? "Please check if the password is correct and if the server allows password login."
              : "Please check if the key path is correct and if the key has a passphrase (if so, provide passphrase).",
          }), null, 2));
        }
      }

      case "remote_ssh_info": {
        recordOp("remote_ssh_info");
        const sshInfo = scanLocalSSH();

        // Add saved connections
        const connPath = path.join(__dirname, 'local', 'connections.json');
        if (fs.existsSync(connPath)) {
          try {
            const cfg = JSON.parse(fs.readFileSync(connPath, 'utf-8'));
            for (const c of cfg.connections || []) {
              const info = { name: c.name, type: c.type || "daemon" };
              if (c.type === 'ssh') {
                info.host = `${c.username}@${c.host}:${c.port || 22}`;
                if (c.identityFile) info.identityFile = c.identityFile;
              } else {
                info.url = c.url;
              }
              sshInfo.savedConnections.push(info);
            }
          } catch {}
        } else {
          sshInfo.savedConnections = [];
        }

        // Human-readable summary
        const summary = [];
        summary.push(`## Local SSH Environment\n`);
        summary.push(formatSSHScanSummary(sshInfo));
        summary.push('');
        if (sshInfo.savedConnections && sshInfo.savedConnections.length) {
          summary.push(`Saved Connections (${sshInfo.savedConnections.length}):`);
          for (const c of sshInfo.savedConnections) {
            const detail = c.type === 'ssh' ? c.host : c.url;
            summary.push(`  - ${c.name} [${c.type}] → ${detail}`);
          }
        } else {
          summary.push(`Saved Connections: None`);
        }
        summary.push('');
        summary.push('---');
        summary.push(`💡 Use \`remote_setup\` to connect. Pick a host from SSH Config Hosts above, or provide a new IP.`);
        summary.push(`   If a private key is listed, use \`privateKey\` param. Otherwise use \`password\`.`);

        sshInfo._summary = summary.join('\n');
        return toTextResult(JSON.stringify(withRuntimeMeta(sshInfo), null, 2));
      }

      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
    // Log error
    logger.error(toolName, "Failed: " + errorMessage(error));
    
    // Mark unhealthy on network errors so next call prompts health check
    if (isNetworkError(error)) {
      markUnhealthy();
      _stats.errors++;
    }
    return {
      content: [
        {
          type: "text",
          text: `Error: ${errorMessage(error)}`,
        },
      ],
      isError: true,
    };
  } finally {
    // Only log errors (not success calls)
  }
});

async function main() {
  // Initialize connection manager
  const defaultConn = loadConnections();
  if (defaultConn && _connections[defaultConn]) {
    _currentConnection = defaultConn;
    const conn = _connections[defaultConn];
    
    if (conn.type === 'ssh') {
      // SSH connection - will connect on first use
      console.error(`Loaded ${Object.keys(_connections).length} connections, default: ${defaultConn} (SSH)`);
    } else {
      // Daemon connection
      _connectionAxios = getAxiosInstance(defaultConn);
      console.error(`Loaded ${Object.keys(_connections).length} connections, default: ${defaultConn} (daemon)`);
    }
  }
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  const connType = _currentConnection ? (_connections[_currentConnection]?.type || 'daemon') : 'daemon';
  const connInfo = connType === 'ssh' 
    ? `ssh://${_connections[_currentConnection]?.host}:${_connections[_currentConnection]?.port || 22}`
    : (_currentConnection ? _connections[_currentConnection]?.url : REMOTE_URL);
  
  console.error(
    `MCP Remote Agent v${PKG_VERSION} running on stdio (name=${PKG_NAME}, type=${connType}, remote=${connInfo}, auth=${AUTH_TOKEN ? "on" : "off"}, timeout=${REQUEST_TIMEOUT_MS}ms, runtimeMode=${_runtimeMode.mode}, modeSource=${_runtimeMode.source})`
  );
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
