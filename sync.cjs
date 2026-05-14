#!/usr/bin/env node
/**
 * mcp-remote-agent Sync Script
 *
 * 从 local/mcp-remote-agent.json 读取变量，同步到：
 *   - package.json (version, name, description)
 *   - index.js (version 常量、启动日志)
 *   - <mcpConfigPath> (MCP server 配置，变量替换)
 *   - SKILL.md (版本号)
 *   - local/server/.env (从 variables 生成服务端配置)
 *
 * 用法：
 *   node sync.cjs              # 执行同步
 *   node sync.cjs --dry-run    # 只显示差异，不写文件
 *   node sync.cjs --check      # 检查一致性，不一致则 exit 1
 *   node sync.cjs --env-only   # 只同步 local/server/.env
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const DRY_RUN = process.argv.includes("--dry-run");
const CHECK = process.argv.includes("--check");
const ENV_ONLY = process.argv.includes("--env-only");

const SKILL_DIR = __dirname;
const CONFIG_JSON_PATH = path.join(SKILL_DIR, "local", "mcp-remote-agent.json");

// ─── Helpers ──────────────────────────────────────────────

function log(tag, msg) {
  const C = { sync: "\x1b[36m", ok: "\x1b[32m", warn: "\x1b[33m", err: "\x1b[31m", dim: "\x1b[2m", reset: "\x1b[0m" };
  const color = C[tag] || C.sync;
  console.log(`  ${color}${tag.toUpperCase().padEnd(5)}${C.reset} ${msg}`);
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const clean = raw.replace(/^\uFEFF/, "");
  return JSON.parse(clean);
}

function writeJson(filePath, data) {
  const content = JSON.stringify(data, null, 2) + "\n";
  if (DRY_RUN) {
    log("sync", `Would write: ${filePath}`);
    return;
  }
  fs.writeFileSync(filePath, content, "utf-8");
  log("ok", `Updated: ${path.basename(filePath)}`);
}

function writeFile(filePath, content) {
  if (DRY_RUN) {
    log("sync", `Would write: ${filePath}`);
    return;
  }
  fs.writeFileSync(filePath, content, "utf-8");
  log("ok", `Updated: ${path.basename(filePath)}`);
}

/**
 * Resolve ${varName} references in a string/value using variables map.
 */
function resolveTemplate(value, vars) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{(\w+)\}/g, (match, key) => {
    if (key in vars) return vars[key];
    log("warn", `Unresolved variable: ${match}`);
    return match;
  });
}

/**
 * Deep-clone and resolve all string values in an object.
 */
function resolveObject(obj, vars) {
  if (typeof obj === "string") return resolveTemplate(obj, vars);
  if (Array.isArray(obj)) return obj.map((v) => resolveObject(v, vars));
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = resolveObject(v, vars);
    }
    return out;
  }
  return obj;
}

// ─── Generate server/.env from mcp-remote-agent.json variables ──────

function generateServerEnv(vars) {
  // .env key → mcp-remote-agent.json variable key mapping
  const envMapping = [
    ["WORKSPACE_ROOT", "serverWorkspaceRoot"],
    ["PORT", "serverPort"],
    ["BIND_HOST", "serverBindHost"],
    ["ENABLE_DASHBOARD", "serverEnableDashboard"],
    ["EXEC_TIMEOUT_MS", "serverExecTimeoutMs"],
    ["EXEC_MAX_CONCURRENCY", "serverExecMaxConcurrency"],
    ["EXEC_QUEUE_TIMEOUT_MS", "serverExecQueueTimeoutMs"],
    ["AUDIT_LOG_PATH", "serverAuditLogPath"],
    ["AUTH_TOKENS", "serverAuthTokens"],
    ["ADMIN_TOKENS", "serverAdminTokens"],
  ];

  const lines = [];
  for (const [envKey, varKey] of envMapping) {
    const value = vars[varKey];
    if (value !== undefined && value !== "") {
      lines.push(`${envKey}=${value}`);
    }
  }
  return lines.join("\n") + "\n";
}

// ─── Main ─────────────────────────────────────────────────

function main() {
  console.log(`\n\x1b[1m\x1b[36m mcp-remote-agent sync\x1b[0m ${DRY_RUN ? "(dry-run)" : CHECK ? "(check)" : ENV_ONLY ? "(env-only)" : ""}\n`);

  // 1. Read local/mcp-remote-agent.json
  if (!fs.existsSync(CONFIG_JSON_PATH)) {
    log("err", `local/mcp-remote-agent.json not found at ${CONFIG_JSON_PATH}`);
    log("err", `Please copy mcp-remote-agent.example.json to local/mcp-remote-agent.json and configure it`);
    process.exit(2);
  }

  const configData = readJson(CONFIG_JSON_PATH);
  const { version, name, description, variables: vars } = configData;

  log("sync", `Version: ${version}`);
  log("sync", `Client:  ${vars.clientId}`);
  log("sync", `Remote:  ${vars.remoteUrl}`);
  log("sync", `MCP:     ${vars.mcpConfigPath}`);
  log("sync", `Shared:  ${vars.sharedConnectionsPath || "(default ~/.mcp-remote-agent/connections.shared.json)"}`);
  log("sync", `Server:  ${vars.serverDaemonDir}`);

  let changes = 0;

  // ─── 2. Sync server/.env ──────────────────────────────
  const serverDir = path.join(SKILL_DIR, "local", "server");
  const serverEnvPath = path.join(serverDir, ".env");
  const generatedEnv = generateServerEnv(vars);

  if (!fs.existsSync(serverDir)) {
    fs.mkdirSync(serverDir, { recursive: true });
  }

  let envChanged = false;
  if (fs.existsSync(serverEnvPath)) {
    const currentEnv = fs.readFileSync(serverEnvPath, "utf-8");
    if (currentEnv !== generatedEnv) {
      envChanged = true;
    }
  } else {
    envChanged = true;
  }

  if (envChanged) {
    writeFile(serverEnvPath, generatedEnv);
    changes++;
  } else {
    log("ok", "local/server/.env up-to-date");
  }

  // If --env-only, skip the rest
  if (ENV_ONLY) {
    console.log("");
    if (changes > 0) {
      log("sync", `${changes} file(s) ${DRY_RUN ? "would be " : ""}updated`);
    } else {
      log("ok", "local/server/.env in sync ✓");
    }
    console.log("");
    return;
  }

  // ─── 3. Sync package.json ─────────────────────────────
  const pkgPath = path.join(SKILL_DIR, "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = readJson(pkgPath);
    let changed = false;
    if (pkg.version !== version) { pkg.version = version; changed = true; }
    if (pkg.name !== name) { pkg.name = name; changed = true; }
    if (pkg.description !== description) { pkg.description = description; changed = true; }
    if (changed) {
      writeJson(pkgPath, pkg);
      changes++;
    } else {
      log("ok", "package.json up-to-date");
    }
  }

  // ─── 4. Sync index.js version ────────────────────────
  const indexPath = path.join(SKILL_DIR, "index.js");
  if (fs.existsSync(indexPath)) {
    let content = fs.readFileSync(indexPath, "utf-8");
    let changed = false;

    // Update version in Server constructor: version: "x.y.z"
    const newContent1 = content.replace(
      /version:\s*"[\d.]+"/g,
      `version: "${version}"`
    );
    if (newContent1 !== content) {
      content = newContent1;
      changed = true;
    }

    // Update startup log version
    const newContent2 = content.replace(
      /v[\d.]+\s+running on stdio/g,
      `v${version} running on stdio`
    );
    if (newContent2 !== content) {
      content = newContent2;
      changed = true;
    }

    if (changed) {
      writeFile(indexPath, content);
      changes++;
    } else {
      log("ok", "index.js version up-to-date");
    }
  }

  // ─── 5. Sync SKILL.md version ────────────────────────
  const skillPath = path.join(SKILL_DIR, "SKILL.md");
  if (fs.existsSync(skillPath)) {
    let content = fs.readFileSync(skillPath, "utf-8");
    let changed = false;

    // Update **vX.Y.Z** patterns (like **v2.2.1**)
    const newContent = content.replace(
      /\*\*v[\d.]+\*\*/g,
      `**v${version}**`
    );
    if (newContent !== content) {
      content = newContent;
      changed = true;
    }

    // Also update version table entries like | v2.2.0 | 2026-04 |
    const versionRowRegex = /\|\s*v[\d.]+\s*\|\s*\d{4}-\d{2}\s*\|/;
    if (versionRowRegex.test(content)) {
      const today = new Date().toISOString().slice(0, 7);
      const match = content.match(versionRowRegex);
      if (match && !match[0].includes(`v${version}`)) {
        content = content.replace(versionRowRegex, `| v${version} | ${today} |`);
        changed = true;
      }
    }

    if (changed) {
      writeFile(skillPath, content);
      changes++;
    } else {
      log("ok", "SKILL.md version up-to-date");
    }
  }

  // ─── 6. Sync MCP config ────────────────────────────
  // Read MCP config path from mcp-remote-agent.json variables (supports any AI tool)
  const mcpConfigPath = vars.mcpConfigPath;
  const mcpServerName = vars.mcpServerName || name;

  if (mcpConfigPath) {
    const resolvedMcpPath = mcpConfigPath.replace(/^~/, os.homedir());
    const mcpDir = path.dirname(resolvedMcpPath);

    if (fs.existsSync(resolvedMcpPath)) {
      const mcp = readJson(resolvedMcpPath);
      const resolvedMcpServer = resolveObject(configData.mcp.server, vars);

      if (!mcp.mcpServers) mcp.mcpServers = {};

      const existing = mcp.mcpServers[mcpServerName];
      const needsUpdate = !existing
        || existing.command !== resolvedMcpServer.command
        || JSON.stringify(existing.args) !== JSON.stringify(resolvedMcpServer.args)
        || JSON.stringify(existing.env) !== JSON.stringify(resolvedMcpServer.env);

      if (needsUpdate) {
        mcp.mcpServers[mcpServerName] = resolvedMcpServer;
        writeJson(resolvedMcpPath, mcp);
        changes++;
      } else {
        log("ok", `${path.basename(resolvedMcpPath)} up-to-date`);
      }
    } else if (fs.existsSync(mcpDir)) {
      // Config file doesn't exist but directory does → create it
      const mcp = { mcpServers: {} };
      const resolvedMcpServer = resolveObject(configData.mcp.server, vars);
      mcp.mcpServers[mcpServerName] = resolvedMcpServer;
      writeJson(resolvedMcpPath, mcp);
      changes++;
    } else {
      log("warn", `MCP config directory not found: ${mcpDir}, skipping`);
    }
  } else {
    log("warn", `mcpConfigPath not set in mcp-remote-agent.json, skipping MCP registration`);
  }

  // ─── Summary ─────────────────────────────────────────
  console.log("");
  if (changes > 0) {
    log("sync", `${changes} file(s) ${DRY_RUN ? "would be " : ""}updated`);
    if (CHECK) {
      log("err", "Consistency check failed — files were out of sync");
      process.exit(1);
    }
  } else {
    log("ok", "All files in sync ✓");
    if (CHECK) process.exit(0);
  }

  console.log("");
}

main();
