const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const fg = require('fast-glob');
const crypto = require('crypto');
const { exec } = require('child_process');
const { promisify } = require('util');
const os = require('os');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

const execAsync = promisify(exec);

// 脚本解释器白名单 (v2.3.1 安全修复)
const ALLOWED_INTERPRETERS = new Set([
  'bash', 'sh', 'dash',
  'python3', 'python', 'python2',
  'node', 'nodejs',
  'perl', 'ruby', 'php',
  'powershell', 'pwsh', 'cmd'
]);

const PORT = Number(process.env.PORT || 3183);
const HOST = process.env.BIND_HOST || '0.0.0.0';
let WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/home/user/workspace';
const ENABLE_DASHBOARD = /^true$/i.test(String(process.env.ENABLE_DASHBOARD || 'false'));
function parseRuntimeInt(value, fallback, min = 1) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

function loadRuntimeConfig() {
  return {
    execTimeoutMs: parseRuntimeInt(process.env.EXEC_TIMEOUT_MS, 120000, 1000),
    execMaxConcurrency: parseRuntimeInt(process.env.EXEC_MAX_CONCURRENCY, 2, 1),
    execQueueTimeoutMs: parseRuntimeInt(process.env.EXEC_QUEUE_TIMEOUT_MS, 15000, 0),
  };
}

let runtimeConfig = loadRuntimeConfig();
const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH || path.join(__dirname, 'audit.log');

// 命令执行限制配置 (v2.3.1)
const ALLOW_BASH_EXEC = !/^false$/i.test(String(process.env.ALLOW_BASH_EXEC || 'true'));
const ALLOWED_COMMANDS = new Set(
  (process.env.ALLOWED_COMMANDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

const writeLocks = new Map();
let runningExec = 0;
const execWaiters = [];

function nowIso() {
  return new Date().toISOString();
}

function parseTokenMap() {
  const rawJson = process.env.AUTH_TOKENS_JSON;
  if (rawJson) {
    try {
      const obj = JSON.parse(rawJson);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch (_) {}
  }

  const raw = process.env.AUTH_TOKENS || '';
  const out = {};
  for (const entry of raw.split(',').map((v) => v.trim()).filter(Boolean)) {
    const [clientId, token] = entry.split('=');
    if (clientId && token) out[clientId.trim()] = token.trim();
  }
  return out;
}

function parseAdminTokens() {
  return new Set(
    (process.env.ADMIN_TOKENS || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  );
}

let clientTokenMap = parseTokenMap();
let tokenClientMap = new Map();
for (const [clientId, token] of Object.entries(clientTokenMap)) {
  if (token) tokenClientMap.set(token, clientId);
}

// Support both new (MCP_REMOTE_*) and legacy (NIUMA_SSH_*) env var names
const legacyToken = (process.env.AUTH_TOKEN || process.env.MCP_REMOTE_AUTH_TOKEN || process.env.NIUMA_SSH_AUTH_TOKEN || '').trim();
if (legacyToken && tokenClientMap.size === 0) {
  tokenClientMap.set(legacyToken, 'legacy-client');
}

let adminTokens = parseAdminTokens();


// --- Hot config reload (v2.2.1) ---
const ENV_PATH = path.join(__dirname, '.env');

function rebuildTokenMaps() {
  clientTokenMap = parseTokenMap();
  tokenClientMap = new Map();
  for (const [clientId, token] of Object.entries(clientTokenMap)) {
    if (token) tokenClientMap.set(token, clientId);
  }
  // Re-check legacy token
  const lt = (process.env.AUTH_TOKEN || process.env.MCP_REMOTE_AUTH_TOKEN || process.env.NIUMA_SSH_AUTH_TOKEN || '').trim();
  if (lt && tokenClientMap.size === 0) {
    tokenClientMap.set(lt, 'legacy-client');
  }
  adminTokens = parseAdminTokens();
}

async function reloadConfig() {
  // Re-read .env and update process.env with override
  const dotenv = require('dotenv');
  const raw = await fs.readFile(ENV_PATH, 'utf-8');
  const parsed = dotenv.parse(raw);
  for (const [key, val] of Object.entries(parsed)) {
    process.env[key] = val;
  }
  // Update mutable runtime config
  WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || WORKSPACE_ROOT;
  runtimeConfig = loadRuntimeConfig();
  rebuildTokenMaps();
  await audit({ type: 'config.reload', clients: Object.keys(clientTokenMap), exec: getExecStats() });
  return { clients: Object.keys(clientTokenMap), workspaceRoot: WORKSPACE_ROOT, exec: getExecStats() };
}


function extractToken(req) {
  // Support URL query parameter ?token=xxx for browser dashboard access
  if (req.query && req.query.token) return req.query.token;
  const auth = req.headers['authorization'];
  const alt = req.headers['x-mcp-token'] || req.headers['x-niuma-token']; // Support both new and legacy headers
  const raw = (typeof auth === 'string' && auth.trim()) || (typeof alt === 'string' && alt.trim()) || '';
  if (!raw) return '';
  return raw.startsWith('Bearer ') ? raw.slice('Bearer '.length).trim() : raw;
}

function getRequestedClientId(req) {
  const clientId = req.headers['x-mcp-client-id'] || req.headers['x-niuma-client-id']; // Support both new and legacy headers
  return typeof clientId === 'string' ? clientId.trim() : '';
}

function isPathUnderRoot(fullPath, rootPath) {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedFull = path.resolve(fullPath);
  return normalizedFull === normalizedRoot || normalizedFull.startsWith(normalizedRoot + path.sep);
}

function safePath(inputPath) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) {
    throw new Error('Invalid path');
  }

  const raw = inputPath.trim().replace(/^[a-zA-Z]:/, '').replace(/\\/g, '/');
  const workspaceResolved = path.resolve(WORKSPACE_ROOT);

  if (path.isAbsolute(raw)) {
    const absolute = path.resolve(raw);
    if (!isPathUnderRoot(absolute, workspaceResolved)) {
      throw new Error('Access denied');
    }
    return absolute;
  }

  const cleaned = raw.replace(/^\/+/, '');
  const fullPath = path.resolve(workspaceResolved, cleaned);
  if (!isPathUnderRoot(fullPath, workspaceResolved)) {
    throw new Error('Access denied');
  }
  return fullPath;
}

function makeEtag(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

async function readIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function withFileLock(key, fn) {
  const previous = writeLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => current);
  writeLocks.set(key, chain);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (writeLocks.get(key) === chain) writeLocks.delete(key);
  }
}

function getExecStats() {
  return {
    running: runningExec,
    max: runtimeConfig.execMaxConcurrency,
    queued: execWaiters.length,
    timeoutMs: runtimeConfig.execTimeoutMs,
    queueTimeoutMs: runtimeConfig.execQueueTimeoutMs,
  };
}

function execQueueError() {
  const error = new Error('Too many concurrent exec operations');
  error.statusCode = 429;
  error.details = getExecStats();
  return error;
}

function execErrorPayload(error) {
  const payload = { error: error.message || 'Execution failed' };
  if (error.details) payload.exec = error.details;
  return payload;
}

async function acquireExecSlot() {
  if (runningExec < runtimeConfig.execMaxConcurrency) {
    runningExec += 1;
    return;
  }

  const timeoutMs = runtimeConfig.execQueueTimeoutMs;
  if (timeoutMs <= 0) throw execQueueError();

  await new Promise((resolve, reject) => {
    const waiter = { resolved: false, timer: null, resolve: null };
    waiter.resolve = () => {
      if (waiter.resolved) return;
      waiter.resolved = true;
      if (waiter.timer) clearTimeout(waiter.timer);
      runningExec += 1;
      resolve();
    };
    waiter.timer = setTimeout(() => {
      if (waiter.resolved) return;
      waiter.resolved = true;
      const index = execWaiters.indexOf(waiter);
      if (index >= 0) execWaiters.splice(index, 1);
      reject(execQueueError());
    }, timeoutMs);
    execWaiters.push(waiter);
  });
}

function releaseExecSlot() {
  runningExec = Math.max(0, runningExec - 1);
  while (runningExec < runtimeConfig.execMaxConcurrency && execWaiters.length > 0) {
    const next = execWaiters.shift();
    if (next && !next.resolved) {
      next.resolve();
      break;
    }
  }
}

async function audit(event) {
  const line = JSON.stringify({ ts: nowIso(), ...event }) + '\n';
  try {
    await fs.appendFile(AUDIT_LOG_PATH, line, 'utf-8');
  } catch (_) {}
}

function authApi(req, res, next) {
  if (tokenClientMap.size === 0) {
    return res.status(500).json({ error: 'Server auth not configured' });
  }
  const token = extractToken(req);
  const clientId = tokenClientMap.get(token);
  if (!clientId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const requestedClientId = getRequestedClientId(req);
  if (requestedClientId && requestedClientId !== clientId) {
    return res.status(403).json({ error: 'Client ID mismatch' });
  }
  req.mcpClientId = clientId;
  return next();
}

function authAdmin(req, res, next) {
  if (!ENABLE_DASHBOARD) {
    return res.status(404).send('Not Found');
  }
  const token = extractToken(req);
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

app.get('/healthz', async (_req, res) => {
  res.json({
    ok: true,
    time: nowIso(),
    workspaceRoot: WORKSPACE_ROOT,
    authClients: Object.keys(clientTokenMap),
    exec: getExecStats(),
  });
});

app.get('/', authAdmin, async (_req, res) => {
  try {
    const dashboardHtml = await fs.readFile(path.join(__dirname, 'dashboard.html'), 'utf-8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(dashboardHtml);
  } catch {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<html><body><h3>MCP Remote Agent daemon</h3><p>workspace: ${WORKSPACE_ROOT}</p></body></html>`);
  }
});

app.post('/update-workspace', authAdmin, async (req, res) => {
  const newWorkspace = typeof req.body.new_workspace === 'string' ? req.body.new_workspace.trim() : '';
  if (!newWorkspace) {
    return res.status(400).json({ error: 'new_workspace is required' });
  }

  WORKSPACE_ROOT = path.resolve(newWorkspace);
  await audit({ type: 'workspace.update', workspaceRoot: WORKSPACE_ROOT });
  return res.json({ success: true, workspaceRoot: WORKSPACE_ROOT });
});

const readRoutes = ['/read', '/api/fs/read'];
const writeRoutes = ['/write', '/api/fs/write'];
const globRoutes = ['/glob', '/api/fs/glob'];
const grepRoutes = ['/grep', '/api/fs/grep'];
const bashRoutes = ['/bash', '/api/exec', '/api/cmd/execute'];

const DEFAULT_GREP_EXCLUDE_DIRS = [
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  '.cache', '.venv', 'venv', '__pycache__',
];

function toStringArray(value, fallback) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return fallback;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildGrepMatcher(pattern, useRegex, caseSensitive) {
  if (!useRegex) {
    const needle = caseSensitive ? pattern : pattern.toLowerCase();
    return (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle);
  }
  const flags = caseSensitive ? '' : 'i';
  const regex = new RegExp(pattern, flags);
  return (line) => regex.test(line);
}

async function grepWorkspace(options) {
  const pattern = typeof options.pattern === 'string' ? options.pattern : '';
  if (!pattern) {
    const error = new Error('pattern is required');
    error.statusCode = 400;
    throw error;
  }

  const cwd = typeof options.cwd === 'string' && options.cwd.trim() ? safePath(options.cwd) : WORKSPACE_ROOT;
  const include = toStringArray(options.include, ['**/*']);
  const userExclude = toStringArray(options.exclude, []);
  const excludeDirs = toStringArray(options.excludeDirs, DEFAULT_GREP_EXCLUDE_DIRS);
  const maxResults = clampInt(options.maxResults, 200, 1, 5000);
  const maxFileBytes = clampInt(options.maxFileBytes, 1024 * 1024, 1024, 10 * 1024 * 1024);
  const caseSensitive = Boolean(options.caseSensitive);
  const useRegex = Boolean(options.regex);
  const matcher = buildGrepMatcher(pattern, useRegex, caseSensitive);
  const ignore = [
    ...excludeDirs.map((dir) => `**/${dir.replace(/^\/+|\/+$/g, '')}/**`),
    ...userExclude,
  ];

  const files = await fg.glob(include, {
    cwd,
    dot: true,
    absolute: true,
    onlyFiles: true,
    ignore,
  });

  const matches = [];
  let scannedFiles = 0;
  let skippedFiles = 0;
  let truncated = false;

  for (const file of files) {
    if (matches.length >= maxResults) {
      truncated = true;
      break;
    }
    try {
      if (!isPathUnderRoot(file, WORKSPACE_ROOT)) {
        skippedFiles += 1;
        continue;
      }
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > maxFileBytes) {
        skippedFiles += 1;
        continue;
      }
      const content = await fs.readFile(file, 'utf-8');
      if (content.includes('\u0000')) {
        skippedFiles += 1;
        continue;
      }
      scannedFiles += 1;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (matcher(lines[i])) {
          matches.push({
            path: path.relative(WORKSPACE_ROOT, file).replace(/\\/g, '/'),
            line: i + 1,
            text: lines[i],
          });
          if (matches.length >= maxResults) {
            truncated = true;
            break;
          }
        }
      }
    } catch (_) {
      skippedFiles += 1;
    }
  }

  return {
    success: true,
    engine: 'node',
    pattern,
    cwd: path.relative(WORKSPACE_ROOT, cwd).replace(/\\/g, '/') || '.',
    include,
    excludeDirs,
    maxResults,
    maxFileBytes,
    caseSensitive,
    regex: useRegex,
    matches,
    truncated,
    scannedFiles,
    skippedFiles,
  };
}

app.post(readRoutes, authApi, async (req, res) => {
  const start = Date.now();
  try {
    const targetPath = safePath(req.body.path);
    const content = await fs.readFile(targetPath, 'utf-8');
    const etag = makeEtag(content);
    // Support conditional read: If-None-Match header
    const ifNoneMatch = (req.headers['if-none-match'] || '').replace(/^"|"$/g, '').trim();
    if (ifNoneMatch && ifNoneMatch === etag) {
      await audit({ type: 'fs.read', clientId: req.mcpClientId, path: req.body.path, ms: Date.now() - start, ok: true, cached: true });
      return res.status(304).json({ success: true, etag, cached: true });
    }
    await audit({ type: 'fs.read', clientId: req.mcpClientId, path: req.body.path, ms: Date.now() - start, ok: true });
    return res.json({ success: true, content, etag });
  } catch (error) {
    await audit({ type: 'fs.read', clientId: req.mcpClientId, path: req.body.path, ms: Date.now() - start, ok: false, error: error.message });
    return res.status(500).json({ error: error.message });
  }
});

app.post(writeRoutes, authApi, async (req, res) => {
  const start = Date.now();
  try {
    const requestedPath = req.body.path;
    const content = req.body.content;
    const expectedEtag = typeof req.body.expectedEtag === 'string' ? req.body.expectedEtag.trim() : '';

    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content must be string' });
    }

    const targetPath = safePath(requestedPath);

    const result = await withFileLock(targetPath, async () => {
      const existing = await readIfExists(targetPath);
      const currentEtag = existing === null ? '' : makeEtag(existing);

      if (expectedEtag) {
        if (!currentEtag || expectedEtag !== currentEtag) {
          const err = new Error('Write conflict: expectedEtag mismatch');
          err.statusCode = 409;
          err.currentEtag = currentEtag || null;
          throw err;
        }
      }

      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, content, 'utf-8');
      return { etag: makeEtag(content) };
    });

    await audit({ type: 'fs.write', clientId: req.mcpClientId, path: requestedPath, ms: Date.now() - start, ok: true });
    return res.json({ success: true, message: 'File written successfully', etag: result.etag });
  } catch (error) {
    await audit({ type: 'fs.write', clientId: req.mcpClientId, path: req.body.path, ms: Date.now() - start, ok: false, error: error.message });
    const code = Number(error.statusCode) || 500;
    return res.status(code).json({ error: error.message, currentEtag: error.currentEtag || null });
  }
});

app.post(globRoutes, authApi, async (req, res) => {
  const start = Date.now();
  try {
    const pattern = typeof req.body.pattern === 'string' ? req.body.pattern : '';
    const basePath = typeof req.body.basePath === 'string' ? req.body.basePath : (typeof req.body.cwd === 'string' ? req.body.cwd : '');
    if (!pattern) return res.status(400).json({ error: 'pattern is required' });

    const searchRoot = basePath ? safePath(basePath) : WORKSPACE_ROOT;
    const files = await fg.glob(pattern, { cwd: searchRoot, dot: true, absolute: true });
    const normalized = files.map((f) => path.relative(WORKSPACE_ROOT, f).replace(/\\/g, '/'));

    await audit({ type: 'fs.glob', clientId: req.mcpClientId, pattern, basePath, ms: Date.now() - start, ok: true, count: normalized.length });
    return res.json({ success: true, files: normalized, entries: normalized });
  } catch (error) {
    await audit({ type: 'fs.glob', clientId: req.mcpClientId, pattern: req.body.pattern, ms: Date.now() - start, ok: false, error: error.message });
    return res.status(500).json({ error: error.message });
  }
});

app.post(grepRoutes, authApi, async (req, res) => {
  const start = Date.now();
  try {
    const result = await grepWorkspace(req.body || {});
    await audit({
      type: 'fs.grep',
      clientId: req.mcpClientId,
      pattern: result.pattern,
      cwd: result.cwd,
      ms: Date.now() - start,
      ok: true,
      count: result.matches.length,
      truncated: result.truncated,
    });
    return res.json(result);
  } catch (error) {
    await audit({
      type: 'fs.grep',
      clientId: req.mcpClientId,
      pattern: req.body && req.body.pattern,
      ms: Date.now() - start,
      ok: false,
      error: error.message,
    });
    const statusCode = Number(error.statusCode) || 500;
    return res.status(statusCode).json({ error: error.message });
  }
});

app.post(bashRoutes, authApi, async (req, res) => {
  const start = Date.now();
  const command = typeof req.body.command === 'string' ? req.body.command : '';
  if (!command.trim()) return res.status(400).json({ error: 'command is required' });

  // 安全校验：命令执行限制 (v2.3.1)
  if (!ALLOW_BASH_EXEC) {
    return res.status(403).json({ error: 'Bash execution is disabled. Set ALLOW_BASH_EXEC=true to enable.' });
  }
  if (ALLOWED_COMMANDS.size > 0) {
    const commandBase = command.split(/[\s|&;]/)[0];
    if (!ALLOWED_COMMANDS.has(commandBase)) {
      return res.status(403).json({ error: `Command not allowed: ${commandBase}. Allowed: ${[...ALLOWED_COMMANDS].join(', ')}` });
    }
  }

  let execSlotAcquired = false;
  try {
    await acquireExecSlot();
    execSlotAcquired = true;
    const cwd = typeof req.body.cwd === 'string' && req.body.cwd.trim() ? safePath(req.body.cwd) : WORKSPACE_ROOT;
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: runtimeConfig.execTimeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    await audit({ type: 'exec', clientId: req.mcpClientId, command: command.slice(0, 300), cwd, ms: Date.now() - start, ok: true });
    return res.json({ success: true, stdout, stderr, code: 0 });
  } catch (error) {
    await audit({ type: 'exec', clientId: req.mcpClientId, command: command.slice(0, 300), ms: Date.now() - start, ok: false, error: error.message, exec: error.details });
    const statusCode = Number(error.statusCode) || 500;
    return res.status(statusCode).json({
      ...execErrorPayload(error),
      stdout: error.stdout,
      stderr: error.stderr,
      code: typeof error.code === 'number' ? error.code : null,
    });
  } finally {
    if (execSlotAcquired) releaseExecSlot();
  }
});


// --- Batch API (v2.0-b) ---
app.post('/api/batch', authApi, async (req, res) => {
  const batchStart = Date.now();
  const operations = Array.isArray(req.body.operations) ? req.body.operations : [];
  if (operations.length === 0) {
    return res.status(400).json({ error: 'operations array is required' });
  }
  if (operations.length > 20) {
    return res.status(400).json({ error: 'Maximum 20 operations per batch' });
  }

  const results = [];
  for (const op of operations) {
    const opStart = Date.now();
    try {
      if (op.type === 'read') {
        const targetPath = safePath(op.path);
        const content = await fs.readFile(targetPath, 'utf-8');
        const etag = makeEtag(content);
        const ifNoneMatch = (op.ifNoneMatch || '').trim();
        if (ifNoneMatch && ifNoneMatch === etag) {
          results.push({ type: 'read', path: op.path, status: 304, etag, cached: true, ms: Date.now() - opStart });
        } else {
          results.push({ type: 'read', path: op.path, status: 200, content, etag, ms: Date.now() - opStart });
        }
      } else if (op.type === 'stat') {
        const targetPath = safePath(op.path);
        const stat = await fs.stat(targetPath);
        results.push({
          type: 'stat', path: op.path, status: 200,
          size: stat.size, mtime: stat.mtime.toISOString(),
          isFile: stat.isFile(), isDir: stat.isDirectory(),
          ms: Date.now() - opStart,
        });
      } else if (op.type === 'glob') {
        const cwd = op.cwd ? safePath(op.cwd) : WORKSPACE_ROOT;
        const entries = await fg([op.pattern || '**/*'], {
          cwd, absolute: true,
          ignore: ['**/node_modules/**', '**/.git/**'],
        });
        results.push({ type: 'glob', pattern: op.pattern, status: 200, entries, ms: Date.now() - opStart });
      } else if (op.type === 'grep') {
        const result = await grepWorkspace(op);
        results.push({ type: 'grep', pattern: op.pattern, status: 200, ...result, ms: Date.now() - opStart });
      } else if (op.type === 'bash') {
        let execSlotAcquired = false;
        try {
          await acquireExecSlot();
          execSlotAcquired = true;
          const cwd = op.cwd ? safePath(op.cwd) : WORKSPACE_ROOT;
          const { stdout, stderr } = await execAsync(op.command, {
            cwd, timeout: runtimeConfig.execTimeoutMs, maxBuffer: 10 * 1024 * 1024,
          });
          results.push({ type: 'bash', command: op.command, status: 200, stdout, stderr, code: 0, ms: Date.now() - opStart });
        } finally {
          if (execSlotAcquired) releaseExecSlot();
        }
      } else {
        results.push({ type: op.type, status: 400, error: 'Unknown operation type', ms: Date.now() - opStart });
      }
    } catch (error) {
      const statusCode = Number(error.statusCode) || 500;
      results.push({
        type: op.type, path: op.path, status: statusCode,
        error: error.message, exec: error.details,
        stdout: error.stdout, stderr: error.stderr,
        code: typeof error.code === 'number' ? error.code : null,
        ms: Date.now() - opStart,
      });
    }
  }
  await audit({ type: 'batch', clientId: req.mcpClientId, count: operations.length, ms: Date.now() - batchStart, ok: true });
  return res.json({ success: true, results });
});


// --- Async Exec API (v2.0-c) ---
const asyncTasks = new Map();
let taskIdCounter = 0;

app.post('/api/exec/async', authApi, async (req, res) => {
  const command = typeof req.body.command === 'string' ? req.body.command : '';
  if (!command.trim()) return res.status(400).json({ error: 'command is required' });

  let cwd;
  try {
    cwd = typeof req.body.cwd === 'string' && req.body.cwd.trim() ? safePath(req.body.cwd) : WORKSPACE_ROOT;
    await acquireExecSlot();
  } catch (e) {
    const statusCode = Number(e.statusCode) || 500;
    return res.status(statusCode).json(execErrorPayload(e));
  }

  const taskId = 'task-' + (++taskIdCounter);
  const createdAt = Date.now();

  asyncTasks.set(taskId, { id: taskId, command, cwd, status: 'running', stdout: '', stderr: '', exitCode: null, createdAt, finishedAt: null });

  // Execute in background
  execAsync(command, { cwd, timeout: runtimeConfig.execTimeoutMs, maxBuffer: 10 * 1024 * 1024 })
    .then(({ stdout, stderr }) => {
      const task = asyncTasks.get(taskId);
      if (task) {
        task.status = 'completed';
        task.stdout = stdout;
        task.stderr = stderr;
        task.exitCode = 0;
        task.finishedAt = Date.now();
      }
    })
    .catch((error) => {
      const task = asyncTasks.get(taskId);
      if (task) {
        task.status = 'error';
        task.stdout = error.stdout || '';
        task.stderr = error.stderr || error.message || '';
        task.exitCode = typeof error.code === 'number' ? error.code : null;
        task.finishedAt = Date.now();
      }
    })
    .finally(() => {
      releaseExecSlot();
    });

  await audit({ type: 'exec.async', clientId: req.mcpClientId, command: command.slice(0, 300), taskId, ok: true });
  return res.json({ success: true, taskId, status: 'running', createdAt });
});

app.get('/api/task/:taskId', authApi, async (req, res) => {
  const task = asyncTasks.get(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  return res.json({ success: true, ...task });
});

// Cleanup old tasks every 5 minutes
setInterval(() => {
  const now = Date.now();
  const MAX_TASK_AGE = 30 * 60 * 1000; // 30 minutes
  for (const [id, task] of asyncTasks) {
    if (task.status !== 'running' && task.finishedAt && (now - task.finishedAt > MAX_TASK_AGE)) {
      asyncTasks.delete(id);
    }
  }
}, 5 * 60 * 1000);


// --- Script Execution API (v2.1) ---
app.post("/api/exec/script", authApi, async (req, res) => {
  const content = typeof req.body.content === "string" ? req.body.content : "";
  if (!content.trim()) return res.status(400).json({ error: "content is required" });
  let interpreter = typeof req.body.interpreter === "string" && req.body.interpreter.trim() ? req.body.interpreter.trim() : "bash";

  // 安全校验：解释器白名单 (v2.3.1)
  // 支持两种格式：1. 纯命令名 (bash, python3)  2. 完整路径 (/usr/bin/bash)
  const interpreterBase = interpreter.split('/').pop().split('\\').pop();
  if (!ALLOWED_INTERPRETERS.has(interpreterBase)) {
    return res.status(400).json({ error: `Interpreter not allowed: ${interpreter}. Allowed: ${[...ALLOWED_INTERPRETERS].join(', ')}` });
  }

  const cwd = typeof req.body.cwd === "string" && req.body.cwd.trim() ? safePath(req.body.cwd) : WORKSPACE_ROOT;

  try {
    await acquireExecSlot();
  } catch (e) {
    const statusCode = Number(e.statusCode) || 500;
    return res.status(statusCode).json(execErrorPayload(e));
  }

  const tmpFile = path.join(os.tmpdir(), "mcp-remote-agent-script-" + Date.now() + ".sh");
  const scriptStart = Date.now();

  try {
    // Write script to temp file
    await fs.writeFile(tmpFile, content, "utf-8");

    // Execute the script
    const { stdout, stderr } = await execAsync(interpreter + " " + tmpFile, {
      cwd,
      timeout: runtimeConfig.execTimeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });

    await audit({ type: "exec.script", clientId: req.mcpClientId, interpreter, ms: Date.now() - scriptStart, ok: true });
    return res.json({ success: true, stdout, stderr, code: 0, ms: Date.now() - scriptStart });
  } catch (error) {
    await audit({ type: "exec.script", clientId: req.mcpClientId, interpreter, ms: Date.now() - scriptStart, ok: false });
    const statusCode = Number(error.statusCode) || 200;
    return res.status(statusCode).json({
      success: false,
      ...execErrorPayload(error),
      stdout: error.stdout || "",
      stderr: error.stderr || error.message || "",
      code: typeof error.code === "number" ? error.code : 1,
      ms: Date.now() - scriptStart,
    });
  } finally {
    releaseExecSlot();
    // Cleanup temp file (best effort)
    fs.unlink(tmpFile).catch(() => {});
  }
});

app.get('/api/stats', authAdmin, async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 1, 1), 365);
  const since = new Date(); since.setDate(since.getDate() - days); since.setHours(0,0,0,0);
  const sinceIso = since.toISOString();
  const lines = (await fs.readFile(AUDIT_LOG_PATH, 'utf-8')).trim().split('\n').filter(Boolean);
  let totalMs = 0, errors = 0, byType = {}, byClient = {}, clientLast = {}, filtered = 0;
  lines.forEach(line => {
    try {
      const e = JSON.parse(line);
      if (e.ts < sinceIso) return;
      filtered++;
      if (!e.ok) errors++;
      if (e.ms) totalMs += e.ms;
      if (!byType[e.type]) byType[e.type] = {count: 0, ok: 0, fail: 0};
      byType[e.type].count++;
      if (e.ok) byType[e.type].ok++; else byType[e.type].fail++;
      if (e.clientId) { byClient[e.clientId] = (byClient[e.clientId] || 0) + 1; clientLast[e.clientId] = e.ts; }
    } catch {}
  });
  const typeStats = Object.entries(byType).map(([t, c]) => ({type: t, count: c.count, ok: c.ok, fail: c.fail, successRate: c.count ? (c.ok / c.count * 100).toFixed(1) : '0.0'}));
  // Add clients that have tokens but no activity in the period
  const allClients = {};
  for (const id of Object.keys(clientTokenMap)) {
    allClients[id] = { count: byClient[id] || 0, lastSeen: clientLast[id] || null };
  }
  for (const id of Object.keys(byClient)) {
    if (!allClients[id]) allClients[id] = { count: byClient[id], lastSeen: clientLast[id] };
  }
  res.json({total: filtered, errors, avgMs: filtered ? totalMs/filtered : 0, byType: typeStats, byClient: allClients, execTimeout: runtimeConfig.execTimeoutMs, days});
});

app.get('/api/errors', authAdmin, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const days = Math.min(Math.max(parseInt(req.query.days) || 1, 1), 365);
  const since = new Date(); since.setDate(since.getDate() - days); since.setHours(0,0,0,0);
  const sinceIso = since.toISOString();
  const lines = (await fs.readFile(AUDIT_LOG_PATH, 'utf-8')).trim().split('\n').filter(Boolean);
  const errors = [];
  for (let i = lines.length - 1; i >= 0 && errors.length < limit; i--) {
    try { const e = JSON.parse(lines[i]); if (!e.ok && e.ts >= sinceIso) errors.push(e); } catch {}
  }
  res.json({errors});
});

app.get('/api/service-status', authAdmin, async (req, res) => {
  const results = {};
  // Node.js running
  results.node = { name: 'Node.js 服务', status: 'running' };
  // Dependencies
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(__dirname, 'package.json'), 'utf-8'));
    const deps = Object.keys(pkg.dependencies || {});
    const missing = [];
    for (const d of deps) {
      try { require.resolve(d, { paths: [__dirname] }); } catch { missing.push(d); }
    }
    results.deps = { name: 'NPM 依赖', status: missing.length === 0 ? 'ok' : 'warn', detail: missing.length === 0 ? deps.length + ' 个依赖已安装' : '缺少: ' + missing.join(', '), deps };
  } catch (e) {
    results.deps = { name: 'NPM 依赖', status: 'error', detail: e.message };
  }
  // Autostart (cron)
  try {
    const { stdout } = await execAsync('crontab -l 2>/dev/null', { timeout: 5000 });
    const hasAutostart = stdout.includes('mcp-remote-agent-manager');
    results.autostart = { name: '开机自启动', status: hasAutostart ? 'ok' : 'warn', detail: hasAutostart ? '已配置 (cron @reboot)' : '未配置' };
  } catch {
    results.autostart = { name: '开机自启动', status: 'warn', detail: '未配置' };
  }
  // Port
  results.port = { name: '端口监听', status: 'ok', detail: PORT + ' 端口正常' };
  // Uptime
  const uptimeSec = Math.floor(process.uptime());
  const d = Math.floor(uptimeSec / 86400), h = Math.floor(uptimeSec % 86400 / 3600), m = Math.floor(uptimeSec % 3600 / 60);
  results.uptime = { name: '运行时长', status: 'ok', detail: (d > 0 ? d + '天' : '') + (h > 0 ? h + '小时' : '') + m + '分钟' };
  // Disk usage of workspace
  try {
    const { stdout } = await execAsync('df -h ' + WORKSPACE_ROOT + ' 2>/dev/null | tail -1', { timeout: 5000 });
    const parts = stdout.trim().split(/\s+/);
    results.disk = { name: '磁盘空间', status: 'ok', detail: '已用 ' + parts[2] + ' / ' + parts[1] + ' (' + parts[4] + ')' };
  } catch {
    results.disk = { name: '磁盘空间', status: 'ok', detail: '-' };
  }
  res.json(results);
});



// --- Config API (v2.2.1) ---
app.get('/api/config', authAdmin, async (req, res) => {
  try {
    const raw = await fs.readFile(ENV_PATH, 'utf-8');
    // Parse and mask sensitive values
    const lines = raw.split('\n').map(line => {
      const idx = line.indexOf('=');
      if (idx === -1) return line;
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1);
      // Mask tokens: show first 8 chars + ***
      if (/TOKEN/i.test(key) && val.length > 12) {
        return key + '=' + val.slice(0, 8) + '***';
      }
      return line;
    });
    res.json({
      success: true,
      envPath: ENV_PATH,
      config: lines.join('\n'),
      runtime: {
        workspaceRoot: WORKSPACE_ROOT,
        clients: Object.keys(clientTokenMap),
        port: PORT,
        execMaxConcurrency: runtimeConfig.execMaxConcurrency,
        execTimeoutMs: runtimeConfig.execTimeoutMs,
        execQueueTimeoutMs: runtimeConfig.execQueueTimeoutMs,
        exec: getExecStats(),
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/config', authAdmin, async (req, res) => {
  try {
    const newConfig = typeof req.body.config === 'string' ? req.body.config : '';
    if (!newConfig.trim()) {
      return res.status(400).json({ error: 'config field is required' });
    }
    // Write new .env
    await fs.writeFile(ENV_PATH, newConfig, 'utf-8');
    // Hot reload
    const result = await reloadConfig();
    res.json({ success: true, message: 'Config updated and reloaded', ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Dashboard UI (v2.3.1) ---
if (ENABLE_DASHBOARD) {
  const dashboardPath = path.join(__dirname, 'dashboard.html');
  
  app.get('/', (req, res) => {
    res.sendFile(dashboardPath);
  });
  
  app.get('/dashboard', (req, res) => {
    res.sendFile(dashboardPath);
  });
  
  console.log('Dashboard enabled at / and /dashboard');
}

app.listen(PORT, HOST, () => {
  console.log(`mcp-remote-agent daemon running on ${HOST}:${PORT}`);
  console.log(`workspace=${WORKSPACE_ROOT}`);
  console.log(`clients=${Object.keys(clientTokenMap).join(',')}`);
  console.log(`dashboard=${ENABLE_DASHBOARD ? 'enabled' : 'disabled'}`);
});
