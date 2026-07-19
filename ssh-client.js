/**
 * SSH Client Module for agentport
 * 
 * Supports both password and key-based authentication via ssh2 library.
 * Also supports ssh.exe fallback for key-based auth (leverages OS SSH agent).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';

const require = createRequire(import.meta.url);
const nodeUtil = require('util');
if (typeof nodeUtil.isDate !== 'function' && typeof nodeUtil.types?.isDate === 'function') {
  nodeUtil.isDate = nodeUtil.types.isDate;
}
const { Client } = await import('ssh2');

const execFileAsync = promisify(execFile);
const IS_WINDOWS = os.platform() === 'win32';

/**
 * Resolve ~ in file paths
 */
function resolvePath(p) {
  if (p && p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\"'\"'")}'`;
}

/**
 * Normalize a path to POSIX form for remote boundary checks.
 * Strips Windows drive letters and backslashes so the same boundary
 * check works regardless of how the caller expressed the path.
 */
function toPosix(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^[a-zA-Z]:/, '').replace(/^\/+/, '/');
}

/**
 * Check whether a resolved remote path is the workspace root or lives under it.
 * Mirrors server.js isPathUnderRoot so SSH and daemon channels enforce the
 * same workspace boundary. POSIX semantics, since the remote host is Linux.
 *
 * Path traversal (..) is normalized away via path.posix.resolve BEFORE the
 * prefix comparison, so "/root/../../etc/passwd" cannot slip through by
 * matching the root prefix lexically.
 *
 * Returns true when no root is configured (unconstrained / legacy behavior),
 * so existing connections without a `workspaceRoot` keep working unchanged.
 */
function isPathUnderRoot(remotePath, rootPath) {
  if (!rootPath) return true;
  const root = String(rootPath).replace(/\/+$/, '');
  if (!root) return true;
  // Normalize the candidate: posix.resolve collapses ".." so a path that
  // lexically starts with root but escapes it via ".." is reduced first.
  const target = path.posix.resolve('/', toPosix(remotePath));
  if (target === root) return true;
  return target.startsWith(root + '/');
}

/**
 * SSH Client class - supports password and key auth
 *
 * config.workspaceRoot (optional): absolute POSIX path on the remote host that
 * bounds file operations (read/write/stat/mkdir/rm). When set, paths outside
 * the root are rejected with a clear error, matching daemon-channel isolation.
 * When unset, behavior is unchanged (legacy). `exec` cannot be path-bounded
 * because it runs arbitrary commands; isolation then depends on the SSH user.
 */
export class SSHClient {
  constructor(config) {
    this.config = config;
    this.workspaceRoot = config?.workspaceRoot
      ? toPosix(config.workspaceRoot).replace(/\/+$/, '')
      : '';
    this.client = null;
    this.sftp = null;
    this.connected = false;
    this.connectionPromise = null;
    this.remoteHome = null;
  }

  /**
   * Resolve a path against the workspace root and enforce the boundary.
   * Relative paths are joined to the root (matching daemon safePath);
   * absolute paths must already be under the root. ~ and ~/x are expanded
   * by resolveRemotePath upstream. No-op when workspaceRoot is empty.
   * Returns the normalized POSIX path to use.
   */
  enforceWorkspace(remotePath, op) {
    if (!this.workspaceRoot) return remotePath;
    const posix = toPosix(remotePath);
    let candidate;
    if (posix.startsWith('/')) {
      candidate = posix;
    } else {
      // Relative: join to root like server.js safePath
      candidate = `${this.workspaceRoot}/${posix}`.replace(/\/+/g, '/');
    }
    // Normalize away ".." before the boundary check; also return the cleaned
    // path so downstream SFTP/exec never see a traversal sequence.
    const normalized = path.posix.resolve('/', candidate);
    if (!isPathUnderRoot(normalized, this.workspaceRoot)) {
      const err = new Error(
        `Access denied: path '${remotePath}' is outside workspace root '${this.workspaceRoot}'` +
        (op ? ` (${op})` : '')
      );
      err.code = 'EWORKSPACE';
      throw err;
    }
    return normalized;
  }

  /**
   * Resolve a cwd-like path against the workspace boundary.
   * Returns a POSIX-safe path string, or '' when workspaceRoot is unset
   * (legacy: caller should pass cwd through unmodified).
   *
   * Rules mirror daemon safePath + grepWorkspace:
   *   - null / undefined / '' → workspaceRoot (search from root)
   *   - absolute path → enforceWorkspace (reject if outside root)
   *   - relative path  → join to workspaceRoot, then normalize
   */
  resolveWorkspaceCwd(rawCwd) {
    if (!this.workspaceRoot) return '';
    if (!rawCwd || typeof rawCwd !== 'string' || !rawCwd.trim()) {
      return this.workspaceRoot;
    }
    return this.enforceWorkspace(rawCwd.trim(), 'cwd');
  }

  /**
   * Connect to SSH server
   */
  async connect() {
    if (this.connected && this.client) return;
    if (this.connectionPromise) return this.connectionPromise;

    this.connectionPromise = new Promise((resolve, reject) => {
      const client = new Client();
      
      const sshConfig = {
        host: this.config.host,
        port: this.config.port || 22,
        username: this.config.username || 'root',
        readyTimeout: this.config.readyTimeout || 10000,
        keepaliveInterval: this.config.keepaliveInterval || 10000,
      };

      // Auth: password or key
      if (this.config.password) {
        sshConfig.password = this.config.password;
      } else if (this.config.privateKey) {
        const keyPath = resolvePath(this.config.privateKey);
        try {
          sshConfig.privateKey = fs.readFileSync(keyPath);
          if (this.config.passphrase) {
            sshConfig.passphrase = this.config.passphrase;
          }
        } catch (error) {
          reject(new Error(`无法读取密钥文件: ${error.message}`));
          return;
        }
      }

      client.on('ready', () => {
        this.client = client;
        this.connected = true;
        
        client.sftp((err, sftp) => {
          if (err) {
            reject(new Error(`SFTP 会话创建失败: ${err.message}`));
            return;
          }
          this.sftp = sftp;
          resolve();
        });
      });

      client.on('error', (err) => {
        this.connected = false;
        this.client = null;
        this.sftp = null;
        this.connectionPromise = null;
        
        const msg = err.message || '';
        if (msg.includes('Authentication') || msg.includes('auth')) {
          reject(new Error(`认证失败: ${msg}。请检查用户名和密码/密钥是否正确。`));
        } else if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
          reject(new Error(`连接失败: 无法连接到 ${this.config.host}:${this.config.port || 22}。请检查服务器地址和端口。`));
        } else if (msg.includes('ETIMEDOUT') || msg.includes('timeout')) {
          reject(new Error(`连接超时: ${this.config.host}:${this.config.port || 22}。请检查网络和防火墙设置。`));
        } else {
          reject(new Error(`SSH 连接错误: ${msg}`));
        }
      });

      client.on('close', () => {
        this.connected = false;
        this.client = null;
        this.sftp = null;
        this.connectionPromise = null;
      });

      client.connect(sshConfig);
    });

    return this.connectionPromise;
  }

  /**
   * Disconnect
   */
  disconnect({ force = false } = {}) {
    const client = this.client;
    if (client) {
      if (force) {
        client.destroy();
      } else {
        let forceTimer = null;
        const clearForceTimer = () => {
          if (forceTimer) clearTimeout(forceTimer);
          forceTimer = null;
        };
        client.once('close', clearForceTimer);
        forceTimer = setTimeout(() => client.destroy(), 500);
        forceTimer.unref?.();
        client.end();
      }
    }
    this.client = null;
    this.sftp = null;
    this.connected = false;
    this.connectionPromise = null;
    this.remoteHome = null;
  }

  /**
   * Check if connected
   */
  isConnected() {
    return this.connected && this.client && this.sftp;
  }

  async getRemoteHome() {
    await this.connect();
    if (this.remoteHome) return this.remoteHome;

    const result = await this.exec('printf %s "$HOME"');
    this.remoteHome = result.stdout.trim() || `/home/${this.config.username || 'root'}`;
    return this.remoteHome;
  }

  /**
   * Best-effort detection of the remote workspace root.
   * Reads WORKSPACE_ROOT from the agentport daemon .env if present.
   * Returns '' when the daemon config is absent or unreadable, so callers
   * can decide whether to leave the client unconstrained (legacy mode).
   * Never throws.
   */
  async detectWorkspaceRoot() {
    if (this.workspaceRoot) return this.workspaceRoot;
    try {
      await this.connect();
      const envPath = await this.getRemoteHome() + '/.agentport/daemon/.env';
      // Read via exec + grep to avoid touching SFTP boundary checks; this
      // runs before workspaceRoot is set, so SFTP reads would be unconstrained
      // anyway, but exec keeps it self-contained.
      const result = await this.exec(
        `grep -E '^WORKSPACE_ROOT=' ${JSON.stringify(envPath)} 2>/dev/null || true`
      );
      const match = /WORKSPACE_ROOT=(.*)/.exec(result.stdout || '');
      const root = match ? match[1].replace(/^["']|["']$/g, '').trim() : '';
      if (root) this.workspaceRoot = toPosix(root).replace(/\/+$/, '');
      return this.workspaceRoot || '';
    } catch {
      return '';
    }
  }

  async resolveRemotePath(remotePath) {
    if (typeof remotePath !== 'string') return remotePath;
    if (remotePath === '~') return this.getRemoteHome();
    if (remotePath.startsWith('~/')) {
      const home = await this.getRemoteHome();
      return path.posix.join(home, remotePath.slice(2));
    }
    return remotePath;
  }

  normalizeUnixTimestamp(value) {
    if (value instanceof Date) {
      return Math.floor(value.getTime() / 1000);
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
    }
    return null;
  }

  /**
   * Execute a command
   */
  async exec(command, options = {}) {
    await this.connect();
    const requestedCwd = await this.resolveRemotePath(options.cwd);
    const safeCwd = this.workspaceRoot
      ? this.resolveWorkspaceCwd(requestedCwd)
      : requestedCwd;
    const remoteCommand = safeCwd
      ? `cd -- ${shellSingleQuote(safeCwd)} && ${command}`
      : command;
    const timeoutMs = Number(options.timeoutMs ?? this.config?.execTimeoutMs ?? 0);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
      const error = new Error('SSH exec timeout must be an integer >= 0');
      error.code = 'EINVAL';
      throw error;
    }

    return new Promise((resolve, reject) => {
      this.client.exec(remoteCommand, {}, (err, stream) => {
        if (err) {
          reject(new Error(`命令执行失败: ${err.message}`));
          return;
        }

        let stdout = '';
        let stderr = '';
        const timer = timeoutMs > 0 ? setTimeout(() => {
          const error = new Error(`SSH command timed out after ${timeoutMs}ms`);
          error.code = 'ETIMEDOUT';
          error.timeoutMs = timeoutMs;
          error.stdout = stdout.trim();
          error.stderr = stderr.trim();
          reject(error);
          try { stream.close?.(); } catch {}
          try { stream.destroy?.(); } catch {}
          this.disconnect({ force: true });
        }, timeoutMs) : null;
        stream.on('data', (data) => { stdout += data.toString(); });
        stream.stderr.on('data', (data) => { stderr += data.toString(); });

        stream.on('close', (code) => {
          if (timer) clearTimeout(timer);
          resolve({
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            code: code || 0,
          });
        });

        stream.on('error', (err) => {
          if (timer) clearTimeout(timer);
          reject(new Error(`流错误: ${err.message}`));
        });
      });
    });
  }

  /**
   * Read a file
   */
  async readFile(remotePath) {
    await this.connect();
    const resolvedPath = await this.resolveRemotePath(remotePath);
    const safePath = this.enforceWorkspace(resolvedPath, 'read');

    return new Promise((resolve, reject) => {
      this.sftp.readFile(safePath, 'utf-8', (err, data) => {
        if (err) {
          reject(new Error(`读取文件失败: ${err.message}`));
          return;
        }
        resolve(data);
      });
    });
  }

  /**
   * Write a file
   */
  async writeFile(remotePath, content) {
    await this.connect();
    const resolvedPath = await this.resolveRemotePath(remotePath);
    const safePath = this.enforceWorkspace(resolvedPath, 'write');

    return new Promise((resolve, reject) => {
      const dir = path.posix.dirname(safePath);
      this.exec(`mkdir -p ${JSON.stringify(dir)}`).then(() => {
        this.sftp.writeFile(safePath, content, 'utf-8', (err) => {
          if (err) {
            reject(new Error(`写入文件失败: ${err.message}`));
            return;
          }
          resolve();
        });
      }).catch(reject);
    });
  }

  /**
   * Get file stats
   */
  async stat(remotePath) {
    await this.connect();
    const resolvedPath = await this.resolveRemotePath(remotePath);
    const safePath = this.enforceWorkspace(resolvedPath, 'stat');

    return new Promise((resolve, reject) => {
      this.sftp.stat(safePath, (err, stats) => {
        if (err) {
          reject(new Error(`获取文件信息失败: ${err.message}`));
          return;
        }
        resolve({
          size: stats.size,
          mtime: this.normalizeUnixTimestamp(stats.mtime),
          isFile: stats.isFile(),
          isDirectory: stats.isDirectory(),
        });
      });
    });
  }

  /**
   * List files matching a glob pattern
   */
  async glob(pattern, cwd) {
    await this.connect();

    // When a workspace root is configured, constrain the search base to it.
    // Relative cwd is joined to root (matching daemon safePath semantics);
    // absolute cwd must already live under root.
    let searchBase = cwd;
    if (cwd) {
      const resolved = await this.resolveRemotePath(cwd);
      searchBase = this.enforceWorkspace(resolved, 'glob.cwd');
    } else if (this.workspaceRoot) {
      searchBase = this.workspaceRoot;
    }

    const findCmd = searchBase
      ? `find ${JSON.stringify(searchBase)} -type f -name ${JSON.stringify(pattern)} 2>/dev/null`
      : `find . -type f -name ${JSON.stringify(pattern)} 2>/dev/null`;

    const result = await this.exec(findCmd);
    if (result.code !== 0) {
      const lsCmd = searchBase
        ? `ls -1 ${JSON.stringify(searchBase + '/' + pattern)} 2>/dev/null`
        : `ls -1 ${pattern} 2>/dev/null`;
      const lsResult = await this.exec(lsCmd);
      return lsResult.stdout.split('\n').filter(f => f.trim());
    }
    
    return result.stdout.split('\n').filter(f => f.trim());
  }

  /**
   * Check if file exists
   */
  async exists(remotePath) {
    try {
      await this.stat(remotePath);
      return true;
    } catch (err) {
      // A workspace-boundary rejection means "does not exist (in workspace)".
      if (err?.code === 'EWORKSPACE') return false;
      return false;
    }
  }

  /**
   * Create directory
   */
  async mkdir(remotePath) {
    const resolvedPath = await this.resolveRemotePath(remotePath);
    const safePath = this.enforceWorkspace(resolvedPath, 'mkdir');
    await this.exec(`mkdir -p ${JSON.stringify(safePath)}`);
  }

  /**
   * Remove file
   */
  async rm(remotePath) {
    const resolvedPath = await this.resolveRemotePath(remotePath);
    const safePath = this.enforceWorkspace(resolvedPath, 'rm');
    await this.exec(`rm -f ${JSON.stringify(safePath)}`);
  }

  /**
   * Remove directory
   */
  async rmdir(remotePath) {
    const resolvedPath = await this.resolveRemotePath(remotePath);
    const safePath = this.enforceWorkspace(resolvedPath, 'rmdir');
    await this.exec(`rm -rf ${JSON.stringify(safePath)}`);
  }
}

/**
 * Connection manager for SSH clients
 */
export class SSHConnectionManager {
  constructor() {
    this.connections = new Map();
    this.currentConnection = null;
  }

  addConnection(name, config) {
    this.connections.set(name, new SSHClient(config));
  }

  switchConnection(name) {
    if (!this.connections.has(name)) {
      throw new Error(`连接 '${name}' 不存在`);
    }
    this.currentConnection = name;
    return this.connections.get(name);
  }

  getCurrentClient() {
    if (!this.currentConnection) {
      throw new Error('未选择连接');
    }
    return this.connections.get(this.currentConnection);
  }

  getConnectionNames() {
    return Array.from(this.connections.keys());
  }

  hasConnection(name) {
    return this.connections.has(name);
  }

  disconnectAll() {
    for (const client of this.connections.values()) {
      client.disconnect();
    }
    this.connections.clear();
    this.currentConnection = null;
  }
}
