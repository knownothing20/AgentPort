const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const fg = require('fast-glob');
const crypto = require('crypto');
const fsSync = require('fs');
const { exec, spawn } = require('child_process');
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
const MAX_JOB_TIMEOUT_MS = parseRuntimeInt(process.env.MAX_JOB_TIMEOUT_MS, 7 * 24 * 60 * 60 * 1000, 1000);
const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH || path.join(__dirname, 'audit.log');
const JOBS_DIR = process.env.JOBS_DIR || path.join(__dirname, 'jobs');
const JOB_LOG_TAIL_BYTES = parseRuntimeInt(process.env.JOB_LOG_TAIL_BYTES, 64 * 1024, 1024);
const MANAGER_LOG_PATH = path.join(__dirname, 'agentport.log');

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
const activeJobs = new Map();

function nowIso() {
  return new Date().toISOString();
}

function resolveJobTimeoutMs(inputTimeoutMs) {
  if (inputTimeoutMs === undefined || inputTimeoutMs === null || inputTimeoutMs === '') {
    return runtimeConfig.execTimeoutMs;
  }
  const parsed = Number.parseInt(inputTimeoutMs, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    const error = new Error('timeoutMs must be an integer >= 0');
    error.statusCode = 400;
    throw error;
  }
  if (parsed === 0) return 0; // 0 means no timeout
  if (parsed < 1000) {
    const error = new Error('timeoutMs must be 0 or >= 1000');
    error.statusCode = 400;
    throw error;
  }
  return Math.min(parsed, MAX_JOB_TIMEOUT_MS);
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

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function makeJobId() {
  return 'job-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
}

function safeJobId(jobId) {
  const id = String(jobId || '').trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    const error = new Error('Invalid job id');
    error.statusCode = 400;
    throw error;
  }
  return id;
}

function jobDir(jobId) {
  return path.join(JOBS_DIR, safeJobId(jobId));
}

function jobMetaPath(jobId) {
  return path.join(jobDir(jobId), 'meta.json');
}

function jobStdoutPath(jobId) {
  return path.join(jobDir(jobId), 'stdout.log');
}

function jobStderrPath(jobId) {
  return path.join(jobDir(jobId), 'stderr.log');
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function publicJob(job) {
  const { command, ...rest } = job;
  return {
    ...rest,
    commandPreview: typeof command === 'string' ? command.slice(0, 300) : '',
    processAlive: isPidAlive(job.pid),
  };
}

async function writeJobMeta(job) {
  await fs.mkdir(jobDir(job.id), { recursive: true });
  await fs.writeFile(jobMetaPath(job.id), JSON.stringify(job, null, 2) + '\n', 'utf-8');
}

async function readJobMeta(jobId) {
  const id = safeJobId(jobId);
  const raw = await fs.readFile(jobMetaPath(id), 'utf-8');
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

async function reconcileJobState(job) {
  const status = String(job.status || '');
  const alive = isPidAlive(job.pid);
  if ((status === 'running' || status === 'cancelling') && !alive) {
    return await updateJob(job.id, {
      status: 'orphaned',
      timedOut: false,
      finishedAt: job.finishedAt || nowIso(),
    });
  }
  if ((status === 'timeout' || status === 'cancelled' || status === 'error' || status === 'orphaned') && !job.finishedAt && !alive) {
    return await updateJob(job.id, {
      finishedAt: nowIso(),
    });
  }
  return job;
}

async function listJobs(limit = 50) {
  await fs.mkdir(JOBS_DIR, { recursive: true });
  const entries = await fs.readdir(JOBS_DIR, { withFileTypes: true });
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const rawJob = await readJobMeta(entry.name);
      jobs.push(await reconcileJobState(rawJob));
    } catch (_) {}
  }
  jobs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return jobs.slice(0, limit);
}

async function getJobStats() {
  let persisted = 0;
  try {
    const entries = await fs.readdir(JOBS_DIR, { withFileTypes: true });
    persisted = entries.filter((entry) => entry.isDirectory()).length;
  } catch (_) {}
  return {
    active: activeJobs.size,
    persisted,
    dir: JOBS_DIR,
  };
}

async function auditWritableStatus() {
  try {
    await fs.mkdir(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    await fs.appendFile(AUDIT_LOG_PATH, '', 'utf-8');
    return true;
  } catch {
    return false;
  }
}

async function readLogTail(filePath, maxBytes = JOB_LOG_TAIL_BYTES) {
  const stat = await fs.stat(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const handle = await fs.open(filePath, 'r');
  try {
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return {
      content: buffer.toString('utf-8'),
      size: stat.size,
      truncated: start > 0,
    };
  } finally {
    await handle.close();
  }
}

async function updateJob(jobId, updates) {
  const existing = await readJobMeta(jobId);
  const next = {
    ...existing,
    ...updates,
    updatedAt: nowIso(),
  };
  await writeJobMeta(next);
  return next;
}

async function startPersistentJob({ command, cwd, clientId, timeoutMs }) {
  if (!command.trim()) {
    const error = new Error('command is required');
    error.statusCode = 400;
    throw error;
  }
  if (!ALLOW_BASH_EXEC) {
    const error = new Error('Bash execution is disabled. Set ALLOW_BASH_EXEC=true to enable.');
    error.statusCode = 403;
    throw error;
  }
  if (ALLOWED_COMMANDS.size > 0) {
    const commandBase = command.split(/[\s|&;]/)[0];
    if (!ALLOWED_COMMANDS.has(commandBase)) {
      const error = new Error(`Command not allowed: ${commandBase}. Allowed: ${[...ALLOWED_COMMANDS].join(', ')}`);
      error.statusCode = 403;
      throw error;
    }
  }

  const jobCwd = typeof cwd === 'string' && cwd.trim() ? safePath(cwd) : WORKSPACE_ROOT;
  const resolvedTimeoutMs = resolveJobTimeoutMs(timeoutMs);
  await acquireExecSlot();

  const id = makeJobId();
  const createdAt = nowIso();
  const job = {
    id,
    command,
    cwd: jobCwd,
    clientId: clientId || 'unknown',
    status: 'running',
    exitCode: null,
    signal: null,
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    finishedAt: null,
    pid: null,
    timedOut: false,
    timeoutMs: resolvedTimeoutMs,
    stdoutPath: jobStdoutPath(id),
    stderrPath: jobStderrPath(id),
  };

  await fs.mkdir(jobDir(id), { recursive: true });
  await fs.writeFile(job.stdoutPath, '', 'utf-8');
  await fs.writeFile(job.stderrPath, '', 'utf-8');
  await writeJobMeta(job);

  let slotReleased = false;
  const releaseSlotOnce = () => {
    if (slotReleased) return;
    slotReleased = true;
    releaseExecSlot();
  };

  const stdoutStream = fsSync.createWriteStream(job.stdoutPath, { flags: 'a' });
  const stderrStream = fsSync.createWriteStream(job.stderrPath, { flags: 'a' });
  const child = spawn(command, {
    cwd: jobCwd,
    shell: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  job.pid = child.pid;
  await writeJobMeta(job);
  activeJobs.set(id, { child, stdoutStream, stderrStream, releaseSlotOnce });

  child.stdout.pipe(stdoutStream);
  child.stderr.pipe(stderrStream);

  const timeout = resolvedTimeoutMs > 0
    ? setTimeout(() => {
        const active = activeJobs.get(id);
        if (!active) return;
        try {
          if (process.platform !== 'win32') {
            process.kill(-child.pid, 'SIGTERM');
          } else {
            child.kill('SIGTERM');
          }
        } catch (_) {
          try { child.kill('SIGTERM'); } catch (_) {}
        }
        updateJob(id, { status: 'timeout', timedOut: true }).catch(() => {});
      }, resolvedTimeoutMs)
    : null;

  child.on('error', (error) => {
    stderrStream.write(`\n[spawn error] ${error.stack || error.message}\n`);
  });

  child.on('close', async (code, signal) => {
    if (timeout) clearTimeout(timeout);
    activeJobs.delete(id);
    releaseSlotOnce();
    let existing = job;
    try {
      existing = await readJobMeta(id);
    } catch (_) {}
    const wasCancelled = existing.status === 'cancelled' || existing.status === 'cancelling';
    const timedOut = existing.timedOut || (code === null && signal === 'SIGTERM' && !wasCancelled);
    const status = wasCancelled ? 'cancelled' : (timedOut ? 'timeout' : (code === 0 ? 'completed' : 'error'));
    await updateJob(id, {
      status,
      exitCode: typeof code === 'number' ? code : null,
      signal: signal || null,
      timedOut,
      finishedAt: nowIso(),
    }).catch(() => {});
    try { stdoutStream.end(); } catch (_) {}
    try { stderrStream.end(); } catch (_) {}
  });

  return job;
}

async function jobWithLogs(jobId, tailBytes) {
  const rawJob = await readJobMeta(jobId);
  const job = await reconcileJobState(rawJob);
  const stdout = await pathExists(job.stdoutPath) ? await readLogTail(job.stdoutPath, tailBytes) : { content: '', size: 0, truncated: false };
  const stderr = await pathExists(job.stderrPath) ? await readLogTail(job.stderrPath, tailBytes) : { content: '', size: 0, truncated: false };
  return {
    job: publicJob(job),
    stdout,
    stderr,
  };
}

async function cancelPersistentJob(jobId) {
  const id = safeJobId(jobId);
  const job = await readJobMeta(id);
  const active = activeJobs.get(id);
  if (!active) {
    if (job.status === 'running') {
      const orphaned = await updateJob(id, {
        status: 'orphaned',
        finishedAt: nowIso(),
      });
      return { cancelled: false, orphaned: true, job: publicJob(orphaned) };
    }
    return { cancelled: false, alreadyFinished: true, job: publicJob(job) };
  }

  await updateJob(id, { status: 'cancelling' });
  try {
    if (process.platform !== 'win32') {
      process.kill(-active.child.pid, 'SIGTERM');
    } else {
      active.child.kill('SIGTERM');
    }
  } catch (_) {
    try { active.child.kill('SIGTERM'); } catch (_) {}
  }

  setTimeout(() => {
    if (!activeJobs.has(id)) return;
    try {
      if (process.platform !== 'win32') {
        process.kill(-active.child.pid, 'SIGKILL');
      } else {
        active.child.kill('SIGKILL');
      }
    } catch (_) {}
  }, 5000).unref?.();

  const cancelled = await updateJob(id, {
    status: 'cancelled',
    finishedAt: nowIso(),
  });
  return { cancelled: true, job: publicJob(cancelled) };
}

async function deletePersistentJob(jobId) {
  const id = safeJobId(jobId);
  const job = await readJobMeta(id);
  const active = activeJobs.get(id);

  // Guard by real process liveness instead of only in-memory state.
  const processAlive = isPidAlive(job.pid) || (active?.child?.pid ? isPidAlive(active.child.pid) : false);
  if (processAlive) {
    const error = new Error('Job is running. Cancel it before delete.');
    error.statusCode = 409;
    throw error;
  }

  if (active) {
    try { active.releaseSlotOnce?.(); } catch (_) {}
    try { active.stdoutStream?.end?.(); } catch (_) {}
    try { active.stderrStream?.end?.(); } catch (_) {}
    activeJobs.delete(id);
  }

  await fs.rm(jobDir(id), { recursive: true, force: true });
  asyncTasks.delete(id);
  return {
    deleted: true,
    jobId: id,
    previousStatus: job.status || 'unknown',
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

function redactSensitive(text) {
  if (!text) return '';
  let out = String(text);
  out = out.replace(/(token|password|passphrase|authorization|x-mcp-token|x-auth-token)\s*[:=]\s*([^\s,;]+)/ig, '$1=***');
  out = out.replace(/(--data-urlencode\s+['"]?token=)([^'"\s]+)/ig, '$1***');
  out = out.replace(/(sshpass\s+-p\s+)(['"]?)([^'"\s]+)\2/ig, '$1$2***$2');
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._-]+/ig, '$1***');
  out = out.replace(/\b(sk|tok|key|secret)-[a-z0-9_\-]{12,}\b/ig, '$1-***');
  return out;
}

function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.ip || req.socket?.remoteAddress || '-';
}

function extractTraceContext(req) {
  const header = req.headers || {};
  const traceId = String(
    header['x-agentport-trace-id']
      || header['x-trace-id']
      || req.query?.traceId
      || ''
  ).trim();
  const sessionId = String(header['x-agentport-session-id'] || '').trim();
  const callId = String(header['x-agentport-call-id'] || '').trim();
  const toolName = String(header['x-agentport-tool'] || '').trim();
  return {
    traceId: traceId || null,
    sessionId: sessionId || null,
    callId: callId || null,
    toolName: toolName || null,
  };
}

function shouldObserveConnectionPath(pathname) {
  if (!pathname) return false;
  if (pathname === '/healthz' || pathname === '/') return true;
  if (pathname.startsWith('/api/connections')) return true;
  if (pathname.startsWith('/api/connection-errors')) return true;
  if (pathname.startsWith('/api/connection-diagnostics')) return true;
  if (pathname.startsWith('/api/jobs')) return true;
  if (pathname.startsWith('/api/task/')) return true;
  if (pathname === '/api/exec' || pathname === '/api/cmd/execute' || pathname === '/api/batch') return true;
  return false;
}

function normalizeErrorSignature(text) {
  if (!text) return 'unknown';
  let out = String(text).toLowerCase();
  out = out.replace(/[0-9]+/g, '#');
  out = out.replace(/\s+/g, ' ').trim();
  if (!out) return 'unknown';
  return out.slice(0, 140);
}

async function auditConnEvent(event) {
  try {
    await audit({
      type: event.type || 'conn.event',
      ok: event.ok !== false,
      clientId: event.clientId || null,
      path: event.path || null,
      ip: event.ip || null,
      error: event.error ? redactSensitive(event.error) : undefined,
      detail: event.detail ? redactSensitive(event.detail) : undefined,
      method: event.method || null,
      statusCode: (event.statusCode === null || event.statusCode === undefined || event.statusCode === '')
        ? null
        : (Number.isFinite(Number(event.statusCode)) ? Number(event.statusCode) : null),
      durationMs: (event.durationMs === null || event.durationMs === undefined || event.durationMs === '')
        ? null
        : (Number.isFinite(Number(event.durationMs)) ? Number(event.durationMs) : null),
      phase: event.phase || null,
      traceId: event.traceId || null,
      sessionId: event.sessionId || null,
      callId: event.callId || null,
      toolName: event.toolName || null,
    });
  } catch {}
}

function authApi(req, res, next) {
  if (tokenClientMap.size === 0) {
    auditConnEvent({
      type: 'conn.auth',
      ok: false,
      path: req.path,
      ip: clientIp(req),
      error: 'Server auth not configured',
    });
    return res.status(500).json({ error: 'Server auth not configured' });
  }
  const token = extractToken(req);
  const clientId = tokenClientMap.get(token);
  if (!clientId) {
    auditConnEvent({
      type: 'conn.auth',
      ok: false,
      path: req.path,
      ip: clientIp(req),
      error: 'Unauthorized',
    });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const requestedClientId = getRequestedClientId(req);
  if (requestedClientId && requestedClientId !== clientId) {
    auditConnEvent({
      type: 'conn.auth',
      ok: false,
      path: req.path,
      ip: clientIp(req),
      clientId,
      error: 'Client ID mismatch',
      detail: `requested=${requestedClientId}`,
    });
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
    auditConnEvent({
      type: 'conn.adminAuth',
      ok: false,
      path: req.path,
      ip: clientIp(req),
      error: 'Unauthorized',
    });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

app.use((req, res, next) => {
  const startedAt = Date.now();
  const trace = extractTraceContext(req);
  const watch = shouldObserveConnectionPath(req.path) || !!trace.traceId;
  if (watch) {
    auditConnEvent({
      type: 'conn.req.start',
      ok: true,
      path: req.path,
      method: req.method,
      ip: clientIp(req),
      phase: 'request_start',
      ...trace,
    });
  }

  res.on('finish', () => {
    if (!watch && res.statusCode < 400) return;
    const ok = res.statusCode < 400;
    auditConnEvent({
      type: ok ? 'conn.req.end' : 'conn.req.fail',
      ok,
      path: req.path,
      method: req.method,
      ip: clientIp(req),
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      phase: 'request_end',
      ...trace,
    });
  });
  next();
});

app.get('/healthz', async (_req, res) => {
  const workspaceExists = await pathExists(WORKSPACE_ROOT);
  const jobs = await getJobStats();
  res.json({
    ok: true,
    time: nowIso(),
    uptimeSec: Math.floor(process.uptime()),
    pid: process.pid,
    node: process.version,
    platform: process.platform,
    workspaceRoot: WORKSPACE_ROOT,
    daemonDir: __dirname,
    workspace: {
      root: WORKSPACE_ROOT,
      exists: workspaceExists,
    },
    authClients: Object.keys(clientTokenMap),
    auth: {
      configured: tokenClientMap.size > 0,
      clientsCount: Object.keys(clientTokenMap).length,
    },
    exec: getExecStats(),
    jobs,
    audit: {
      path: AUDIT_LOG_PATH,
      writable: await auditWritableStatus(),
    },
    memory: process.memoryUsage(),
  });
});

// root dashboard route is defined at bottom in ENABLE_DASHBOARD block

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

app.get('/api/jobs', authApi, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);
    const status = typeof req.query.status === 'string' && req.query.status.trim() ? req.query.status.trim() : '';
    let jobs = await listJobs(limit);
    if (status) jobs = jobs.filter((job) => job.status === status);
    return res.json({ success: true, jobs: jobs.map(publicJob), count: jobs.length });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post(['/api/jobs', '/api/jobs/start'], authApi, async (req, res) => {
  const start = Date.now();
  const command = typeof req.body.command === 'string' ? req.body.command : '';
  try {
    const job = await startPersistentJob({
      command,
      cwd: req.body.cwd,
      clientId: req.mcpClientId,
      timeoutMs: req.body.timeoutMs,
    });
    await audit({ type: 'job.start', clientId: req.mcpClientId, command: command.slice(0, 300), cwd: job.cwd, jobId: job.id, ms: Date.now() - start, ok: true });
    return res.json({ success: true, jobId: job.id, taskId: job.id, status: job.status, job: publicJob(job), createdAt: job.createdAt });
  } catch (error) {
    await audit({ type: 'job.start', clientId: req.mcpClientId, command: command.slice(0, 300), ms: Date.now() - start, ok: false, error: error.message, exec: error.details });
    const statusCode = Number(error.statusCode) || 500;
    return res.status(statusCode).json(execErrorPayload(error));
  }
});

app.get('/api/jobs/:jobId', authApi, async (req, res) => {
  try {
    const rawJob = await readJobMeta(req.params.jobId);
    const job = await reconcileJobState(rawJob);
    return res.json({ success: true, job: publicJob(job), ...publicJob(job) });
  } catch (error) {
    const statusCode = error.code === 'ENOENT' ? 404 : Number(error.statusCode) || 500;
    return res.status(statusCode).json({ error: statusCode === 404 ? 'Job not found' : error.message });
  }
});

app.get('/api/jobs/:jobId/logs', authApi, async (req, res) => {
  try {
    const tailBytes = Math.min(Math.max(Number.parseInt(req.query.tailBytes || req.query.bytes, 10) || JOB_LOG_TAIL_BYTES, 1024), 5 * 1024 * 1024);
    return res.json({ success: true, ...(await jobWithLogs(req.params.jobId, tailBytes)) });
  } catch (error) {
    const statusCode = error.code === 'ENOENT' ? 404 : Number(error.statusCode) || 500;
    return res.status(statusCode).json({ error: statusCode === 404 ? 'Job not found' : error.message });
  }
});

app.post('/api/jobs/:jobId/cancel', authApi, async (req, res) => {
  try {
    const result = await cancelPersistentJob(req.params.jobId);
    await audit({ type: 'job.cancel', clientId: req.mcpClientId, jobId: req.params.jobId, ok: true, cancelled: result.cancelled });
    return res.json({ success: true, ...result });
  } catch (error) {
    await audit({ type: 'job.cancel', clientId: req.mcpClientId, jobId: req.params.jobId, ok: false, error: error.message });
    const statusCode = error.code === 'ENOENT' ? 404 : Number(error.statusCode) || 500;
    return res.status(statusCode).json({ error: statusCode === 404 ? 'Job not found' : error.message });
  }
});

async function handleDeleteJob(req, res) {
  try {
    const result = await deletePersistentJob(req.params.jobId);
    await audit({ type: 'job.delete', clientId: req.mcpClientId, jobId: req.params.jobId, ok: true, previousStatus: result.previousStatus });
    return res.json({ success: true, ...result });
  } catch (error) {
    await audit({ type: 'job.delete', clientId: req.mcpClientId, jobId: req.params.jobId, ok: false, error: error.message });
    const statusCode = error.code === 'ENOENT' ? 404 : Number(error.statusCode) || 500;
    const message = statusCode === 404 ? 'Job not found' : error.message;
    return res.status(statusCode).json({ error: message });
  }
}

app.delete('/api/jobs/:jobId', authApi, handleDeleteJob);
app.post('/api/jobs/:jobId/delete', authApi, handleDeleteJob);

app.post('/api/exec/async', authApi, async (req, res) => {
  const command = typeof req.body.command === 'string' ? req.body.command : '';
  if (!command.trim()) return res.status(400).json({ error: 'command is required' });

  try {
    const job = await startPersistentJob({
      command,
      cwd: req.body.cwd,
      clientId: req.mcpClientId,
      timeoutMs: req.body.timeoutMs,
    });
    asyncTasks.set(job.id, { id: job.id, command, cwd: job.cwd, status: job.status, stdout: '', stderr: '', exitCode: null, createdAt: Date.parse(job.createdAt), finishedAt: null });
    await audit({ type: 'exec.async', clientId: req.mcpClientId, command: command.slice(0, 300), taskId: job.id, ok: true });
    return res.json({ success: true, taskId: job.id, jobId: job.id, status: job.status, createdAt: Date.parse(job.createdAt), job: publicJob(job) });
  } catch (e) {
    const statusCode = Number(e.statusCode) || 500;
    return res.status(statusCode).json(execErrorPayload(e));
  }
});

app.get('/api/task/:taskId', authApi, async (req, res) => {
  try {
    const job = await readJobMeta(req.params.taskId);
    const logs = await jobWithLogs(req.params.taskId, JOB_LOG_TAIL_BYTES);
    return res.json({
      success: true,
      ...publicJob(job),
      taskId: job.id,
      stdout: logs.stdout.content,
      stderr: logs.stderr.content,
    });
  } catch (_) {
    const task = asyncTasks.get(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    return res.json({ success: true, ...task });
  }
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

  const tmpFile = path.join(os.tmpdir(), "agentport-script-" + Date.now() + ".sh");
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

function clampMcpWindowMinutes(raw) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 5;
  return Math.min(Math.max(parsed, 1), 1440);
}

async function safeExecStdout(command, timeout = 5000) {
  try {
    const { stdout } = await execAsync(command, {
      timeout,
      maxBuffer: 1024 * 1024,
    });
    return stdout || '';
  } catch {
    return '';
  }
}

function parseWhoSessions(stdout) {
  const lines = String(stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const sessions = [];
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const fromMatch = line.match(/\(([^)]+)\)/);
    sessions.push({
      user: parts[0],
      tty: parts[1],
      loginAt: [parts[2], parts[3]].filter(Boolean).join(' ') || '-',
      from: fromMatch ? fromMatch[1] : '-',
    });
  }
  return sessions;
}

function parseTopProcesses(stdout) {
  const rows = String(stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (!rows.length) return [];
  const dataRows = rows.slice(1);
  const parsed = [];
  for (const row of dataRows) {
    const parts = row.split(/\s+/);
    if (parts.length < 5) continue;
    parsed.push({
      pid: Number.parseInt(parts[0], 10) || 0,
      command: parts[1] || '-',
      cpu: Number.parseFloat(parts[2]) || 0,
      mem: Number.parseFloat(parts[3]) || 0,
      threads: Number.parseInt(parts[4], 10) || 0,
    });
  }
  return parsed;
}

async function readAuditEntriesSince(sinceMs) {
  const raw = await readIfExists(AUDIT_LOG_PATH);
  if (!raw) return [];
  const lines = raw.split('\n').filter((line) => line.trim());
  const entries = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const tsMs = Date.parse(parsed.ts);
      if (!Number.isFinite(tsMs) || tsMs < sinceMs) continue;
      entries.push(parsed);
    } catch {}
  }
  return entries;
}

const CONNECTION_ERROR_REGEX = /(transport closed|econnreset|econnrefused|socket hang up|unauthorized|client id mismatch|timed out|timeout|connection refused|network is unreachable|ehostunreach|enotfound|broken pipe|epipe)/i;

function isConnectionErrorEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const type = String(entry.type || '');
  const err = String(entry.error || '');
  if (type.startsWith('conn.')) return true;
  if (entry.ok === false && CONNECTION_ERROR_REGEX.test(err)) return true;
  return false;
}

function parseManagerTsToIso(raw) {
  const m = String(raw || '').match(/\[(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\]/);
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

async function readDaemonRestartEvents(limit) {
  const raw = await readIfExists(MANAGER_LOG_PATH);
  if (!raw) return [];
  const lines = raw.split('\n').filter((line) => line.trim());
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i];
    if (!/exited with code|NotFoundError|EADDRINUSE|ECONNRESET|ECONNREFUSED|transport closed/i.test(line)) continue;
    out.push({
      ts: parseManagerTsToIso(line) || nowIso(),
      type: 'conn.daemon',
      ok: false,
      source: 'manager.log',
      error: redactSensitive(line.trim()),
    });
  }
  return out;
}

function summarizeConnectionDiagnostics(entries, limitTraces) {
  const byType = new Map();
  const bySignature = new Map();
  const traces = new Map();
  let errorCount = 0;

  for (const entry of entries) {
    const type = String(entry.type || 'conn.event');
    byType.set(type, (byType.get(type) || 0) + 1);

    const traceId = entry.traceId || null;
    if (traceId) {
      if (!traces.has(traceId)) {
        traces.set(traceId, {
          traceId,
          sessionId: entry.sessionId || null,
          callId: entry.callId || null,
          toolName: entry.toolName || null,
          clientId: entry.clientId || null,
          firstTs: entry.ts || null,
          lastTs: entry.ts || null,
          eventCount: 0,
          errorCount: 0,
          lastError: null,
          lastPath: entry.path || null,
          lastType: type,
          lastStatusCode: (entry.statusCode === null || entry.statusCode === undefined || entry.statusCode === '')
            ? null
            : (Number.isFinite(Number(entry.statusCode)) ? Number(entry.statusCode) : null),
        });
      }
      const t = traces.get(traceId);
      t.eventCount += 1;
      t.lastPath = entry.path || t.lastPath || null;
      t.lastType = type;
      if (entry.ts && (!t.firstTs || entry.ts < t.firstTs)) t.firstTs = entry.ts;
      if (entry.ts && (!t.lastTs || entry.ts > t.lastTs)) t.lastTs = entry.ts;
      const rawCode = entry.statusCode;
      const code = (rawCode === null || rawCode === undefined || rawCode === '') ? NaN : Number(rawCode);
      if (Number.isFinite(code)) t.lastStatusCode = code;
      if (entry.error) t.lastError = redactSensitive(entry.error);
      if (entry.ok === false || code >= 400) {
        t.errorCount += 1;
      }
    }

    const statusCode = Number(entry.statusCode);
    if (entry.ok === false || statusCode >= 400 || entry.error) {
      errorCount += 1;
      const sig = normalizeErrorSignature(entry.error || `${type} ${entry.path || ''}`.trim());
      const prev = bySignature.get(sig);
      if (!prev) {
        bySignature.set(sig, {
          signature: sig,
          count: 1,
          lastTs: entry.ts || null,
          sample: redactSensitive(entry.error || type),
          type,
        });
      } else {
        prev.count += 1;
        if (entry.ts && (!prev.lastTs || entry.ts > prev.lastTs)) prev.lastTs = entry.ts;
      }
    }
  }

  const traceRows = [...traces.values()]
    .map((row) => {
      const firstMs = Date.parse(row.firstTs || '');
      const lastMs = Date.parse(row.lastTs || '');
      return {
        ...row,
        durationMs: Number.isFinite(firstMs) && Number.isFinite(lastMs) ? Math.max(0, lastMs - firstMs) : null,
      };
    })
    .sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || '')))
    .slice(0, limitTraces);

  const topErrors = [...bySignature.values()]
    .sort((a, b) => b.count - a.count || String(b.lastTs || '').localeCompare(String(a.lastTs || '')))
    .slice(0, 8);

  const typeStats = [...byType.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  return {
    totals: {
      events: entries.length,
      errors: errorCount,
      traces: traceRows.length,
    },
    byType: typeStats,
    topErrors,
    recentTraces: traceRows,
  };
}

async function collectConnectionsSnapshot(windowMinutes) {
  const sinceMs = Date.now() - windowMinutes * 60 * 1000;
  const [whoOut, sshEstablishedOut, mcpEstablishedOut, topProcOut, auditEntries] = await Promise.all([
    safeExecStdout('who --ips 2>/dev/null'),
    safeExecStdout("ss -Htn state established '( dport = :22 or sport = :22 )' 2>/dev/null | wc -l"),
    safeExecStdout(`ss -Htn state established '( dport = :${PORT} or sport = :${PORT} )' 2>/dev/null | wc -l`),
    safeExecStdout("ps -eo pid,comm,pcpu,pmem,nlwp --sort=-pcpu 2>/dev/null | head -n 11"),
    readAuditEntriesSince(sinceMs),
  ]);

  const byClient = new Map();
  for (const entry of auditEntries) {
    const id = entry.clientId || 'unknown';
    if (!byClient.has(id)) {
      byClient.set(id, {
        clientId: id,
        requestWindow: 0,
        ok: 0,
        fail: 0,
        totalMs: 0,
        msCount: 0,
        lastSeen: null,
      });
    }
    const next = byClient.get(id);
    next.requestWindow += 1;
    if (entry.ok) next.ok += 1;
    else next.fail += 1;
    if (typeof entry.ms === 'number' && Number.isFinite(entry.ms)) {
      next.totalMs += entry.ms;
      next.msCount += 1;
    }
    if (entry.ts && (!next.lastSeen || entry.ts > next.lastSeen)) next.lastSeen = entry.ts;
  }

  const activeClients = [...byClient.values()]
    .map((c) => {
      const successRate = c.requestWindow ? (c.ok / c.requestWindow) * 100 : 0;
      return {
        clientId: c.clientId,
        requestWindow: c.requestWindow,
        ok: c.ok,
        fail: c.fail,
        successRate: Number(successRate.toFixed(1)),
        avgMs: c.msCount ? Math.round(c.totalMs / c.msCount) : null,
        lastSeen: c.lastSeen,
        online: !!c.lastSeen && (Date.now() - Date.parse(c.lastSeen) <= 5 * 60 * 1000),
      };
    })
    .sort((a, b) => b.requestWindow - a.requestWindow || String(a.clientId).localeCompare(String(b.clientId)));

  const tokenClients = Object.keys(clientTokenMap);
  const knownOnlineCount = tokenClients.filter((id) => {
    const match = activeClients.find((c) => c.clientId === id);
    return !!(match && match.online);
  }).length;

  return {
    ts: nowIso(),
    ssh: {
      sessionsCount: parseWhoSessions(whoOut).length,
      establishedCount: Number.parseInt(String(sshEstablishedOut).trim(), 10) || 0,
      sessions: parseWhoSessions(whoOut),
    },
    mcp: {
      windowMinutes,
      activeClientsCount: knownOnlineCount,
      requestWindow: activeClients.reduce((sum, c) => sum + c.requestWindow, 0),
      establishedCount: Number.parseInt(String(mcpEstablishedOut).trim(), 10) || 0,
      activeClients,
    },
    processes: {
      totalProcesses: Number.parseInt(String(await safeExecStdout('ps -e --no-headers 2>/dev/null | wc -l')).trim(), 10) || 0,
      totalThreads: Number.parseInt(String(await safeExecStdout("ps -eLo nlwp --no-headers 2>/dev/null | awk '{s+=$1} END{print s+0}'")).trim(), 10) || 0,
      topProcesses: parseTopProcesses(topProcOut),
    },
  };
}

app.get('/api/connections', authAdmin, async (req, res) => {
  try {
    const windowMinutes = clampMcpWindowMinutes(req.query.mcpWindowMin || req.query.windowMinutes);
    const snapshot = await collectConnectionsSnapshot(windowMinutes);
    res.json(snapshot);
  } catch (error) {
    await auditConnEvent({
      type: 'conn.collect',
      ok: false,
      path: req.path,
      ip: clientIp(req),
      error: error.message || 'failed to collect connections',
    });
    res.status(500).json({ error: error.message || 'failed to collect connections' });
  }
});

app.get('/api/connections/stream', authAdmin, async (req, res) => {
  const windowMinutes = clampMcpWindowMinutes(req.query.mcpWindowMin || req.query.windowMinutes);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let closed = false;
  await auditConnEvent({
    type: 'conn.stream.open',
    ok: true,
    path: req.path,
    ip: clientIp(req),
  });
  const send = async () => {
    if (closed) return;
    try {
      const snapshot = await collectConnectionsSnapshot(windowMinutes);
      res.write(`event: connections\n`);
      res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    } catch (error) {
      await auditConnEvent({
        type: 'conn.stream',
        ok: false,
        path: req.path,
        ip: clientIp(req),
        error: error.message || 'collect failed',
      });
      res.write(`event: connections\n`);
      res.write(`data: ${JSON.stringify({ error: error.message || 'collect failed' })}\n\n`);
    }
  };

  await send();
  const timer = setInterval(send, 5000);

  req.on('close', () => {
    closed = true;
    clearInterval(timer);
    auditConnEvent({
      type: 'conn.stream.close',
      ok: true,
      path: req.path,
      ip: clientIp(req),
    });
  });
});

app.get('/api/connection-errors', authAdmin, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 200);
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 1, 1), 365);
  const since = new Date();
  since.setDate(since.getDate() - days);
  since.setHours(0, 0, 0, 0);
  const sinceMs = since.getTime();

  const raw = await readIfExists(AUDIT_LOG_PATH);
  const lines = raw ? raw.split('\n').filter((line) => line.trim()) : [];
  const items = [];

  for (let i = lines.length - 1; i >= 0 && items.length < limit; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      const tsMs = Date.parse(entry.ts || '');
      if (!Number.isFinite(tsMs) || tsMs < sinceMs) continue;
      if (!isConnectionErrorEntry(entry)) continue;
      items.push({
        ts: entry.ts,
        type: entry.type || 'conn.event',
        clientId: entry.clientId || null,
        source: 'audit',
        error: redactSensitive(entry.error || entry.detail || 'connection event'),
      });
    } catch {}
  }

  if (items.length < limit) {
    const managerEvents = await readDaemonRestartEvents(limit - items.length);
    for (const event of managerEvents) {
      const tsMs = Date.parse(event.ts || '');
      if (!Number.isFinite(tsMs) || tsMs < sinceMs) continue;
      items.push(event);
      if (items.length >= limit) break;
    }
  }

  items.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  res.json({ errors: items.slice(0, limit) });
});

app.get('/api/connection-diagnostics', authAdmin, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 300, 1000);
  const traceLimit = Math.min(parseInt(req.query.traceLimit, 10) || 20, 100);
  const windowMinutes = Math.min(Math.max(parseInt(req.query.windowMinutes, 10) || 180, 5), 7 * 24 * 60);
  const sinceMs = Date.now() - windowMinutes * 60 * 1000;

  const raw = await readIfExists(AUDIT_LOG_PATH);
  const lines = raw ? raw.split('\n').filter((line) => line.trim()) : [];
  const events = [];

  for (let i = lines.length - 1; i >= 0 && events.length < limit; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      const tsMs = Date.parse(entry.ts || '');
      if (!Number.isFinite(tsMs) || tsMs < sinceMs) continue;
      if (!isConnectionErrorEntry(entry) && !String(entry.type || '').startsWith('conn.req.')) continue;
      events.push({
        ts: entry.ts,
        type: entry.type || 'conn.event',
        ok: entry.ok !== false,
        clientId: entry.clientId || null,
        path: entry.path || null,
        method: entry.method || null,
        statusCode: (entry.statusCode === null || entry.statusCode === undefined || entry.statusCode === '')
          ? null
          : (Number.isFinite(Number(entry.statusCode)) ? Number(entry.statusCode) : null),
        durationMs: (entry.durationMs === null || entry.durationMs === undefined || entry.durationMs === '')
          ? null
          : (Number.isFinite(Number(entry.durationMs)) ? Number(entry.durationMs) : null),
        phase: entry.phase || null,
        traceId: entry.traceId || null,
        sessionId: entry.sessionId || null,
        callId: entry.callId || null,
        toolName: entry.toolName || null,
        source: entry.source || 'audit',
        error: entry.error ? redactSensitive(entry.error) : null,
        detail: entry.detail ? redactSensitive(entry.detail) : null,
      });
    } catch {}
  }

  events.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  const diagnostics = summarizeConnectionDiagnostics(events, traceLimit);
  res.json({
    windowMinutes,
    generatedAt: nowIso(),
    totals: diagnostics.totals,
    byType: diagnostics.byType,
    topErrors: diagnostics.topErrors,
    recentTraces: diagnostics.recentTraces,
    recentEvents: events.slice(0, 40),
  });
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
    const hasAutostart = stdout.includes('agentport-manager');
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
  const setNoCache = (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  };
  
  app.get('/', authAdmin, async (_req, res) => {
    try {
      const dashboardHtml = await fs.readFile(dashboardPath, 'utf-8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      setNoCache(res);
      return res.send(dashboardHtml);
    } catch {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      setNoCache(res);
      return res.send(`<html><body><h3>AgentPort daemon</h3><p>workspace: ${WORKSPACE_ROOT}</p></body></html>`);
    }
  });
  
  app.get('/dashboard', authAdmin, async (_req, res) => {
    try {
      const dashboardHtml = await fs.readFile(dashboardPath, 'utf-8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      setNoCache(res);
      return res.send(dashboardHtml);
    } catch {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      setNoCache(res);
      return res.send(`<html><body><h3>AgentPort daemon</h3><p>workspace: ${WORKSPACE_ROOT}</p></body></html>`);
    }
  });
  
  console.log('Dashboard enabled at / and /dashboard');
}

app.listen(PORT, HOST, () => {
  console.log(`agentport daemon running on ${HOST}:${PORT}`);
  console.log(`workspace=${WORKSPACE_ROOT}`);
  console.log(`clients=${Object.keys(clientTokenMap).join(',')}`);
  console.log(`dashboard=${ENABLE_DASHBOARD ? 'enabled' : 'disabled'}`);
});
