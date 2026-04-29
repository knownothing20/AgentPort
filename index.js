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
  return {
    content: [{ type: "text", text: message }],
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
    const msg = hint || "建议先调用 remote_health 检查远端服务是否可达。";
    throw Object.assign(new Error(`⚠️ 远程连接状态未知。${msg}`), { _isHealthError: true });
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
      description: "切换远程连接目标。可查看可用连接列表或切换到指定连接。",
      inputSchema: {
        type: "object",
        properties: {
          connection: {
            type: "string",
            description: "要切换的连接名称。留空则返回可用连接列表。",
          },
        },
      },
    },
    {
      name: "remote_health",
      description: "检查远程守护进程是否可达。首次操作前必须调用。",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "remote_read",
      description: "读取远程工作区文件内容，支持 ETag 缓存和条件读取。",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "远程文件路径，支持绝对路径或工作区相对路径。",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "remote_write",
      description: "写入文件到远程工作区，自动处理 CRLF→LF 和 BOM 清理，支持乐观并发锁（expectedEtag）。",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "远程文件路径，支持绝对路径或工作区相对路径。",
          },
          content: {
            type: "string",
            description: "要写入的 UTF-8 文本内容，自动清理 Windows 换行符和 BOM。",
          },
          expectedEtag: {
            type: "string",
            description: "可选，乐观并发锁 token，防止覆盖他人修改。",
          },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "remote_stat",
      description: "获取远程文件元信息（大小、修改时间、是否为文件/目录），不读取文件内容。",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "远程文件路径，支持绝对路径或工作区相对路径。",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "remote_glob",
      description: "按 glob 模式搜索远程工作区文件，例如 **/*.ts、src/**/*.py。",
      inputSchema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Glob 模式，例如 **/*.ts、src/**/*.py。",
          },
          cwd: {
            type: "string",
            description: "可选，搜索起始目录。",
          },
        },
        required: ["pattern"],
      },
    },
    {
      name: "remote_status",
      description: "获取远程连接综合诊断信息：连接状态、延迟、缓存命中率、操作统计。",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "remote_bash",
      description: "在远程 Linux 主机上执行 bash 命令。含特殊字符（$ ` \\ 等）的命令自动 base64 编码，避免转义问题。",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "要执行的 bash 命令。含 $ ` \\ ! \" # ; & | 等特殊字符时自动 base64 编码，无需手动处理。",
          },
          cwd: {
            type: "string",
            description: "可选，工作目录。",
          },
        },
        required: ["command"],
      },
    },
    {
      name: "remote_script",
      description: "在远程执行多行脚本，先将脚本写入临时文件再执行，彻底避免 bash 转义和编码问题。适合复杂脚本、含变量/模板字符串/中文的场景。",
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "脚本内容，原样写入远程临时文件执行，不会经过 bash -c 解析。",
          },
          interpreter: {
            type: "string",
            description: "脚本解释器，默认 bash。支持 bash、sh、python3、node 等。",
          },
          cwd: {
            type: "string",
            description: "可选，工作目录。",
          },
        },
        required: ["content"],
      },
    },
    {
      name: "remote_batch",
      description: "批量执行多个操作（read/stat/glob/bash），单次请求最多 20 个，比多次单独调用更高效。",
      inputSchema: {
        type: "object",
        properties: {
          operations: {
            type: "array",
            description: "操作数组，每项含 type（read|stat|glob|bash）及对应参数。",
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
      description: "异步执行长时间运行的 bash 命令，立即返回 taskId，用 remote_task 查询结果。",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "要异步执行的 bash 命令。",
          },
          cwd: {
            type: "string",
            description: "可选，工作目录。",
          },
        },
        required: ["command"],
      },
    },
    {
      name: "remote_task",
      description: "查询异步命令的状态和输出，taskId 由 remote_exec_async 返回。",
      inputSchema: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "remote_exec_async 返回的任务 ID。",
          },
        },
        required: ["taskId"],
      },
    },
    {
      name: "remote_config",
      description: "读取或修改远端守护进程配置（.env），修改后自动热重载，无需重启服务。支持 GET（读取）和 PUT（写入+重载）两种操作。",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["read", "write"],
            description: "read=读取当前配置，write=写入新配置并热重载。",
          },
          config: {
            type: "string",
            description: "write 操作时的新 .env 内容（完整替换）。",
          },
        },
        required: ["action"],
      },
    },
    {
      name: "remote_setup",
      description: "引导式服务器连接设置。收集服务器信息，测试连接，保存配置。支持密码和密钥两种认证方式。",
      inputSchema: {
        type: "object",
        properties: {
          host: {
            type: "string",
            description: "服务器地址（IP 或域名）。",
          },
          port: {
            type: "number",
            description: "SSH 端口，默认 22。",
          },
          username: {
            type: "string",
            description: "登录用户名。",
          },
          password: {
            type: "string",
            description: "登录密码（与 privateKey 二选一）。",
          },
          privateKey: {
            type: "string",
            description: "私钥文件路径（与 password 二选一）。",
          },
          passphrase: {
            type: "string",
            description: "私钥密码（如果私钥有密码保护）。",
          },
          name: {
            type: "string",
            description: "连接名称，用于后续引用。默认自动生成。",
          },
          description: {
            type: "string",
            description: "连接描述。",
          },
          testOnly: {
            type: "boolean",
            description: "仅测试连接，不保存配置。默认 false。",
          },
        },
        required: ["host", "username"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const args = getArguments(request);

    switch (request.params.name) {
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
              username: conn.username
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
            url: conn.url
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
                  message: 'Connected successfully'
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
        try { await ensureHealthy("建议先调用 remote_health 检查远端服务是否可达，再执行读取操作。"); } catch (e) { if (isHealthError(e)) return healthCheckError(e.message + "\n\n如确认服务正常，可忽略此提示直接重试。"); throw e; }

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
        try { await ensureHealthy("写入操作前必须确认远端服务可达，建议先调用 remote_health 检查。"); } catch (e) { if (isHealthError(e)) return healthCheckError(e.message + "\n\n如确认服务正常，可忽略此提示直接重试。"); throw e; }
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
            return toTextResult(JSON.stringify({
              path: statPath,
              ...stats,
            }, null, 2));
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
              return toTextResult(JSON.stringify({
                path: statPath,
                size: r.size,
                mtime: r.mtime,
                isFile: r.isFile,
                // Normalize: server may return isDir or isDirectory
                isDirectory: r.isDirectory !== undefined ? r.isDirectory : (r.isDir !== undefined ? r.isDir : !r.isFile),
              }, null, 2));
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
        try { await ensureHealthy("建议先调用 remote_health 检查远端服务是否可达，再执行搜索操作。"); } catch (e) { if (isHealthError(e)) return healthCheckError(e.message + "\n\n如确认服务正常，可忽略此提示直接重试。"); throw e; }
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
        try { await ensureHealthy("建议先调用 remote_health 检查远端服务是否可达，再执行远程命令。"); } catch (e) { if (isHealthError(e)) return healthCheckError(e.message + "\n\n如确认服务正常，可忽略此提示直接重试。"); throw e; }
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
            const lines = [`Batch completed: ${results.length} operations`];
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
          const lines = [`Batch completed: ${data.results.length} operations`];
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
          return toTextResult(JSON.stringify({
            error: "Async execution is not supported in SSH mode",
            message: "SSH connections do not support async execution. Use remote_bash for synchronous execution, or switch to daemon mode for async support.",
          }, null, 2));
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
          return toTextResult(JSON.stringify({
            taskId: data.taskId,
            status: data.status,
            createdAt: data.createdAt,
            message: `Task ${data.taskId} started. Use remote_task with this taskId to check progress.`,
          }, null, 2));
        } catch (error) {
          return toTextResult(`Async exec error: ${errorMessage(error)}`);
        }
      }

      case "remote_task": {
        recordOp("remote_task");
        
        // SSH mode - not supported
        if (isSSHConnection()) {
          return toTextResult(JSON.stringify({
            error: "Task query is not supported in SSH mode",
            message: "SSH connections do not support task queries. Use remote_bash for synchronous execution, or switch to daemon mode for task support.",
          }, null, 2));
        }

        // Daemon mode
        try { await ensureHealthy(); } catch (e) { if (isHealthError(e)) return healthCheckError(e.message); throw e; }
        const taskId = requireNonEmptyString(args, "taskId");
        try {
          const response = await getCurrentAxios().get(`/api/task/${taskId}`);
          const data = response.data;
          const result = {
            taskId: data.id,
            status: data.status,
            command: data.command,
          };
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
          return toTextResult(JSON.stringify({
            error: "Config management is not supported in SSH mode",
            message: "SSH connections do not support config management. Switch to daemon mode for config support.",
          }, null, 2));
        }

        // Daemon mode
        const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
        if (action === "read") {
          try {
            const response = await getCurrentAxios().get("/api/config");
            const data = response.data;
            if (data.success) {
              return toTextResult(
                `Config (${data.envPath}):\n${data.config}\n\nRuntime:\n${JSON.stringify(data.runtime, null, 2)}`
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
                `✅ Config updated and reloaded!\nClients: ${data.clients?.join(", ")}\nWorkspace: ${data.workspaceRoot}`
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
        if (!password && !privateKey) {
          return toTextResult(JSON.stringify({
            success: false,
            error: "需要提供 password 或 privateKey 之一。",
            hint: "如果用密码登录，请提供 password 参数。如果用密钥登录，请提供 privateKey 参数（密钥文件路径）。",
          }, null, 2));
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
              
              // Generate auth token
              const token = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
              const clientId = args.clientId || 'auto-deploy';
              
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
            return toTextResult(JSON.stringify({
              success: true,
              message: "连接测试成功！",
              server: result.stdout,
            }, null, 2));
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
          let message = '✅ 连接成功！';
          if (daemonInfo && !daemonInfo.error) {
            message = `✅ 开发环境就绪！\n- SSH 连接：${username}@${host}:${port}\n- Daemon 服务：${daemonInfo.url}\n- 工作区：${daemonInfo.workspaceRoot}\n\n可以开始远程开发了！`;
          } else if (daemonInfo && daemonInfo.error) {
            message = `⚠️ SSH 连接成功，但 daemon 部署失败：${daemonInfo.error}\n\n仍可通过 SSH 模式开发。`;
          } else {
            message = `✅ SSH 连接已保存！\n可以开始远程开发了。`;
          }

          return toTextResult(JSON.stringify({
            success: true,
            message: message,
            ssh: { connection: name, host: `${username}@${host}:${port}`, server: result.stdout },
            daemon: daemonInfo && !daemonInfo.error ? { url: daemonInfo.url, workspaceRoot: daemonInfo.workspaceRoot } : (daemonInfo || null),
            saved: configPath,
            defaultConnection: _currentConnection,
          }, null, 2));
        } catch (error) {
          try { testClient.disconnect(); } catch {}
          return toTextResult(JSON.stringify({
            success: false,
            error: error.message,
            hint: password 
              ? "请检查密码是否正确，以及服务器是否允许密码登录。"
              : "请检查密钥路径是否正确，密钥是否有密码保护（如有请提供 passphrase）。",
          }, null, 2));
        }
      }

      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
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
    `MCP Remote Agent v${PKG_VERSION} running on stdio (name=${PKG_NAME}, type=${connType}, remote=${connInfo}, auth=${AUTH_TOKEN ? "on" : "off"}, timeout=${REQUEST_TIMEOUT_MS}ms)`
  );
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
