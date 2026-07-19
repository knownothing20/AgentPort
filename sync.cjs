#!/usr/bin/env node
/**
 * AgentPort Sync Script
 *
 * Reads local/agentport.json and synchronizes generated files:
 *   - package.json (version, name, description)
 *   - index.js (version constants and startup log)
 *   - <mcpConfigPath> (MCP server registration)
 *   - SKILL.md (version references)
 *   - local/server/.env (daemon runtime config)
 *   - optional skill target directories with --skills
 *
 * Usage:
 *   node sync.cjs                              # synchronize generated files
 *   node sync.cjs --dry-run                    # show pending writes only
 *   node sync.cjs --check                      # verify consistency, never write
 *   node sync.cjs --env-only                   # only sync local/server/.env
 *   node sync.cjs --skills --target <skillDir> # copy repo code to skill dirs
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const DRY_RUN = process.argv.includes("--dry-run");
const CHECK = process.argv.includes("--check");
const ENV_ONLY = process.argv.includes("--env-only");
const SYNC_SKILLS = process.argv.includes("--skills");

const SKILL_DIR = __dirname;
const PRIMARY_CONFIG_JSON_PATH = path.join(SKILL_DIR, "local", "agentport.json");
const PACKAGE_JSON_PATH = path.join(SKILL_DIR, "package.json");
const SKILL_SYNC_EXCLUDES = new Set([".git", "node_modules"]);
const SKILL_SYNC_LOCAL_FILES = new Set([
  "local/README.md",
  "local/config-guide.md",
  "local/connections.json.example",
  "local/connections.v3.json.example",
  "local/projects.json.example",
  "local/runtime-mode.json.example",
]);

function repeatedArg(names) {
  const out = [];
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    const eq = arg.indexOf("=");
    if (eq > 0) {
      const key = arg.slice(0, eq);
      if (names.includes(key)) out.push(arg.slice(eq + 1));
      continue;
    }
    if (names.includes(arg) && process.argv[i + 1]) {
      out.push(process.argv[i + 1]);
      i += 1;
    }
  }
  return out;
}

function resolveConfigPath() {
  if (fs.existsSync(PRIMARY_CONFIG_JSON_PATH)) return PRIMARY_CONFIG_JSON_PATH;
  return PRIMARY_CONFIG_JSON_PATH;
}

function ensurePrivacyCheck() {
  const checker = path.join(SKILL_DIR, "scripts", "check-privacy.cjs");
  if (!fs.existsSync(checker)) return;

  const result = spawnSync(process.execPath, [checker], {
    cwd: SKILL_DIR,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    log("err", "Privacy check failed; refusing to sync files");
    process.exit(result.status || 1);
  }
}

// 鈹€鈹€鈹€ Helpers 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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
  if (DRY_RUN || CHECK) {
    log("sync", `${CHECK ? "Would need update" : "Would write"}: ${filePath}`);
    return;
  }
  fs.writeFileSync(filePath, content, "utf-8");
  log("ok", `Updated: ${path.basename(filePath)}`);
}

function writeFile(filePath, content) {
  if (DRY_RUN || CHECK) {
    log("sync", `${CHECK ? "Would need update" : "Would write"}: ${filePath}`);
    return;
  }
  fs.writeFileSync(filePath, content, "utf-8");
  log("ok", `Updated: ${path.basename(filePath)}`);
}

function normalizeTargetList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function resolveSkillTargets(vars) {
  const fromArgs = repeatedArg(["--target", "--skill-target"]);
  const fromConfig = normalizeTargetList(vars.skillTargets);
  return [...new Set([...fromArgs, ...fromConfig])]
    .map((item) => path.resolve(item.replace(/^~/, os.homedir())))
    .filter((item) => item && path.resolve(item) !== path.resolve(SKILL_DIR));
}

function shouldSyncSkillEntry(srcDir, entryName) {
  const sourcePath = path.join(srcDir, entryName);
  const relative = path.relative(SKILL_DIR, sourcePath).replace(/\\/g, "/");
  if (!relative || relative.startsWith("../")) return false;
  if (!relative.includes("/") && SKILL_SYNC_EXCLUDES.has(relative)) return false;
  if (relative === "local") return true;
  if (relative.startsWith("local/")) return SKILL_SYNC_LOCAL_FILES.has(relative);
  return true;
}

function countSkillDiffs(srcDir, dstDir) {
  let changed = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!shouldSyncSkillEntry(srcDir, entry.name)) continue;
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (!fs.existsSync(dst)) {
      changed += 1;
      log("sync", `${CHECK ? "Missing" : "Would copy"}: ${dst}`);
      continue;
    }
    if (entry.isDirectory()) {
      changed += countSkillDiffs(src, dst);
      continue;
    }
    if (entry.isFile()) {
      const srcContent = fs.readFileSync(src);
      const dstContent = fs.readFileSync(dst);
      if (!srcContent.equals(dstContent)) {
        changed += 1;
        log("sync", `${CHECK ? "Out of sync" : "Would update"}: ${dst}`);
      }
    }
  }
  return changed;
}

function copySkillTree(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!shouldSyncSkillEntry(srcDir, entry.name)) continue;
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copySkillTree(src, dst);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dst);
    }
  }
}

function syncSkillTarget(targetDir) {
  if (DRY_RUN || CHECK) {
    const changed = countSkillDiffs(SKILL_DIR, targetDir);
    if (changed === 0) log("ok", `Skill target up-to-date: ${targetDir}`);
    return changed;
  }
  copySkillTree(SKILL_DIR, targetDir);
  log("ok", `Skill target synced: ${targetDir}`);
  return 1;
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

// 鈹€鈹€鈹€ Generate server/.env from config variables 鈹€鈹€鈹€鈹€鈹€鈹€

function generateServerEnv(vars) {
  // .env key 鈫?config variable key mapping
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

// 鈹€鈹€鈹€ Main 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function main() {
  console.log(`\n\x1b[1m\x1b[36m agentport sync\x1b[0m ${DRY_RUN ? "(dry-run)" : CHECK ? "(check)" : ENV_ONLY ? "(env-only)" : ""}\n`);

  ensurePrivacyCheck();

  const configPath = resolveConfigPath();
  const packageData = readJson(PACKAGE_JSON_PATH);
  const hasLocalConfig = fs.existsSync(configPath);
  if (ENV_ONLY && !hasLocalConfig) {
    log("err", `Config not found at ${PRIMARY_CONFIG_JSON_PATH}`);
    log("err", "--env-only requires local runtime variables");
    process.exit(2);
  }

  // Release metadata is tracked in package.json. The ignored local config only
  // owns machine-specific paths, credentials, and daemon settings.
  const configData = hasLocalConfig ? readJson(configPath) : { variables: {}, mcp: {} };
  const vars = configData.variables || {};
  const { version, name, description } = packageData;

  log("sync", `Version: ${version}`);
  log("sync", `Client:  ${vars.clientId || "(local config not loaded)"}`);
  log("sync", `Remote:  ${vars.remoteUrl || "(local config not loaded)"}`);
  log("sync", `MCP:     ${vars.mcpConfigPath || "(local config not loaded)"}`);
  log("sync", `Shared:  ${vars.sharedConnectionsPath || "(default ~/.agentport/connections.shared.json)"}`);
  log("sync", `Server:  ${vars.serverDaemonDir}`);

  let changes = 0;

  // 鈹€鈹€鈹€ 2. Sync server/.env 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  if (hasLocalConfig) {
    const serverDir = path.join(SKILL_DIR, "local", "server");
    const serverEnvPath = path.join(serverDir, ".env");
    const generatedEnv = generateServerEnv(vars);
    if (!fs.existsSync(serverDir) && !CHECK && !DRY_RUN) {
      fs.mkdirSync(serverDir, { recursive: true });
    }
    const envChanged = !fs.existsSync(serverEnvPath)
      || fs.readFileSync(serverEnvPath, "utf-8") !== generatedEnv;
    if (envChanged) {
      writeFile(serverEnvPath, generatedEnv);
      changes++;
    } else {
      log("ok", "local/server/.env up-to-date");
    }
  } else {
    log("warn", "Local config not found; skipping private env and MCP registration");
  }

  // If --env-only, skip the rest
  if (ENV_ONLY) {
    console.log("");
    if (changes > 0) {
      log("sync", `${changes} file(s) ${DRY_RUN ? "would be " : ""}updated`);
    } else {
      log("ok", "local/server/.env in sync");
    }
    console.log("");
    return;
  }

  // 鈹€鈹€鈹€ 3. Sync package.json 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  log("ok", `package.json is the release metadata source (${name}@${version})`);

  // 鈹€鈹€鈹€ 4. Sync index.js version 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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

  // 鈹€鈹€鈹€ 5. Sync SKILL.md version 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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

  // 鈹€鈹€鈹€ 6. Sync MCP config 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // Read MCP config path from config variables (supports any AI tool)
  const mcpConfigPath = vars.mcpConfigPath;
  const mcpServerName = vars.mcpServerName || name;
  const mcpPathIsPlaceholder = /^(?:PATH_TO_|ABSOLUTE_PATH_TO_)/.test(String(mcpConfigPath || ""));

  if (hasLocalConfig && mcpConfigPath && !mcpPathIsPlaceholder && configData.mcp?.server) {
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
      // Config file doesn't exist but directory does 鈫?create it
      const mcp = { mcpServers: {} };
      const resolvedMcpServer = resolveObject(configData.mcp.server, vars);
      mcp.mcpServers[mcpServerName] = resolvedMcpServer;
      writeJson(resolvedMcpPath, mcp);
      changes++;
    } else {
      log("warn", `MCP config directory not found: ${mcpDir}, skipping`);
    }
  } else if (mcpPathIsPlaceholder) {
    log("warn", "mcpConfigPath is still a template placeholder, skipping MCP registration");
  } else {
    log("warn", `mcpConfigPath not set in config, skipping MCP registration`);
  }

  if (SYNC_SKILLS) {
    const targets = resolveSkillTargets(vars);
    if (targets.length === 0) {
      log("warn", "No skill targets configured. Pass --target <dir> or variables.skillTargets.");
    }
    for (const target of targets) {
      changes += syncSkillTarget(target);
    }
  }

  // Summary
  console.log("");
  if (changes > 0) {
    log("sync", `${changes} file(s) ${DRY_RUN ? "would be " : ""}updated`);
    if (CHECK) {
      log("err", "Consistency check failed: files were out of sync");
      process.exit(1);
    }
  } else {
    log("ok", "All files in sync");
    if (CHECK) process.exit(0);
  }

  console.log("");
}

main();
