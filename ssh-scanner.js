// ssh-scanner.js
// Shared SSH environment scanner used by index.js (remote_setup/remote_ssh_info) and setup.js
import fs from "fs";
import path from "path";
import os from "os";

/**
 * Scan local SSH environment: private keys, public keys, SSH config hosts, known_hosts.
 * @returns {{ privateKeys: Array, publicKeys: Array, configHosts: Array, knownHosts: Array, error?: string }}
 */
export function scanLocalSSH() {
  const sshDir = path.join(os.homedir(), ".ssh");
  const result = { privateKeys: [], publicKeys: [], configHosts: [], knownHosts: [] };

  try {
    if (!fs.existsSync(sshDir)) return result;

    const files = fs.readdirSync(sshDir);

    // 1. Scan private keys
    for (const f of files) {
      const fullPath = path.join(sshDir, f);
      if (/^id_|\.pem$/.test(f) && !f.endsWith('.pub')) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          let keyType = "unknown";
          if (/OPENSSH PRIVATE KEY/.test(content)) {
            const m = content.match(/\b(ed25519|rsa|dsa|ecdsa)\b/i);
            keyType = m ? m[1].toLowerCase() : "openssh";
          } else if (/RSA PRIVATE KEY/.test(content)) {
            keyType = "rsa";
          } else if (/EC PRIVATE KEY/.test(content)) {
            keyType = "ecdsa";
          } else if (/DSA PRIVATE KEY/.test(content)) {
            keyType = "dsa";
          }
          const encrypted = /ENCRYPTED/.test(content);
          result.privateKeys.push({ path: fullPath, file: f, type: keyType, encrypted });
        } catch {}
      }
      // Public keys
      if (f.endsWith('.pub')) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8').trim();
          const parts = content.split(/\s+/);
          result.publicKeys.push({ path: fullPath, file: f, type: parts[0] || "unknown", comment: parts[2] || "" });
        } catch {}
      }
    }

    // 2. Parse SSH config
    const configPath = path.join(sshDir, "config");
    if (fs.existsSync(configPath)) {
      const lines = fs.readFileSync(configPath, 'utf-8').split('\n');
      let current = null;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const hostMatch = trimmed.match(/^Host\s+(.+)$/i);
        if (hostMatch) {
          if (current) result.configHosts.push(current);
          current = { alias: hostMatch[1].trim(), host: "", user: "", port: 22 };
          continue;
        }
        if (current) {
          const kv = trimmed.match(/^(\S+)\s+(.+)$/);
          if (kv) {
            const [, key, val] = kv;
            const lk = key.toLowerCase();
            if (lk === 'hostname') current.host = val;
            else if (lk === 'user') current.user = val;
            else if (lk === 'port') current.port = parseInt(val) || 22;
            else if (lk === 'identityfile') current.identityFile = val;
            else if (lk === 'proxyjump') current.proxyJump = val;
            else if (lk === 'remoteforward') current.remoteForward = val;
          }
        }
      }
      if (current) result.configHosts.push(current);
    }

    // 3. Parse known_hosts
    const khPath = path.join(sshDir, "known_hosts");
    if (fs.existsSync(khPath)) {
      const hosts = new Set();
      const lines = fs.readFileSync(khPath, 'utf-8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('|')) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2) {
          const h = parts[0].replace(/^\[|\](:\d+)?$/g, '');
          if (h) hosts.add(h);
        }
      }
      result.knownHosts = [...hosts].sort();
    }
  } catch (e) {
    result.error = e.message;
  }

  return result;
}

/**
 * Generate a human-readable summary from SSH scan result.
 * @param {object} sshInfo - Result from scanLocalSSH()
 * @returns {string}
 */
export function formatSSHScanSummary(sshInfo) {
  const lines = [];
  if (sshInfo.privateKeys.length) {
    lines.push(`Private Keys (${sshInfo.privateKeys.length}):`);
    for (const k of sshInfo.privateKeys) {
      lines.push(`  - ${k.file} (${k.type}${k.encrypted ? ', encrypted' : ''})`);
    }
  } else {
    lines.push(`Private Keys: None found`);
  }
  if (sshInfo.publicKeys.length) {
    lines.push(`Public Keys (${sshInfo.publicKeys.length}):`);
    for (const k of sshInfo.publicKeys) {
      lines.push(`  - ${k.file} (${k.type})${k.comment ? ' # ' + k.comment : ''}`);
    }
  }
  if (sshInfo.configHosts.length) {
    lines.push(`SSH Config Hosts (${sshInfo.configHosts.length}):`);
    for (const h of sshInfo.configHosts) {
      let info = `  - ${h.alias} -> ${h.host || '(default)'}:${h.port}`;
      if (h.user) info += ` user=${h.user}`;
      if (h.identityFile) info += ` key=${h.identityFile}`;
      lines.push(info);
    }
  } else {
    lines.push(`SSH Config Hosts: None configured`);
  }
  if (sshInfo.knownHosts.length) {
    lines.push(`Known Hosts (${sshInfo.knownHosts.length}): ${sshInfo.knownHosts.slice(0, 10).join(', ')}${sshInfo.knownHosts.length > 10 ? '...' : ''}`);
  }
  return lines.join('\n');
}
