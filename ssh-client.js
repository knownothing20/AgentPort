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

/**
 * SSH Client class - supports password and key auth
 */
export class SSHClient {
  constructor(config) {
    this.config = config;
    this.client = null;
    this.sftp = null;
    this.connected = false;
    this.connectionPromise = null;
    this.remoteHome = null;
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
  disconnect() {
    if (this.client) {
      this.client.end();
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

    return new Promise((resolve, reject) => {
      const execOptions = {};
      if (options.cwd) execOptions.cwd = options.cwd;

      this.client.exec(command, execOptions, (err, stream) => {
        if (err) {
          reject(new Error(`命令执行失败: ${err.message}`));
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (data) => { stdout += data.toString(); });
        stream.stderr.on('data', (data) => { stderr += data.toString(); });

        stream.on('close', (code) => {
          resolve({
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            code: code || 0,
          });
        });

        stream.on('error', (err) => {
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

    return new Promise((resolve, reject) => {
      this.sftp.readFile(resolvedPath, 'utf-8', (err, data) => {
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

    return new Promise((resolve, reject) => {
      const dir = path.posix.dirname(resolvedPath);
      this.exec(`mkdir -p ${JSON.stringify(dir)}`).then(() => {
        this.sftp.writeFile(resolvedPath, content, 'utf-8', (err) => {
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

    return new Promise((resolve, reject) => {
      this.sftp.stat(resolvedPath, (err, stats) => {
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

    const findCmd = cwd 
      ? `find ${JSON.stringify(cwd)} -type f -name ${JSON.stringify(pattern)} 2>/dev/null`
      : `find . -type f -name ${JSON.stringify(pattern)} 2>/dev/null`;

    const result = await this.exec(findCmd);
    if (result.code !== 0) {
      const lsCmd = cwd 
        ? `ls -1 ${JSON.stringify(cwd + '/' + pattern)} 2>/dev/null`
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
    } catch {
      return false;
    }
  }

  /**
   * Create directory
   */
  async mkdir(remotePath) {
    const resolvedPath = await this.resolveRemotePath(remotePath);
    await this.exec(`mkdir -p ${JSON.stringify(resolvedPath)}`);
  }

  /**
   * Remove file
   */
  async rm(remotePath) {
    const resolvedPath = await this.resolveRemotePath(remotePath);
    await this.exec(`rm -f ${JSON.stringify(resolvedPath)}`);
  }

  /**
   * Remove directory
   */
  async rmdir(remotePath) {
    const resolvedPath = await this.resolveRemotePath(remotePath);
    await this.exec(`rm -rf ${JSON.stringify(resolvedPath)}`);
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
