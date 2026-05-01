#!/usr/bin/env node
// setup.js - Interactive CLI setup for mcp-remote-agent
// Shares SSH scanning logic with index.js via ssh-scanner.js

import readline from "readline";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { scanLocalSSH, formatSSHScanSummary } from "./ssh-scanner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================
// Helpers
// ============================================

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function colorize(color, text) {
  return `${color}${text}${RESET}`;
}

function printBanner() {
  console.log("");
  console.log(colorize(CYAN, "  ╔══════════════════════════════════════════╗"));
  console.log(colorize(CYAN, "  ║   mcp-remote-agent setup wizard v2.5.0   ║"));
  console.log(colorize(CYAN, "  ╚══════════════════════════════════════════╝"));
  console.log("");
}

function createRL() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

function askChoice(rl, question, options) {
  return new Promise(async (resolve) => {
    console.log(question);
    for (let i = 0; i < options.length; i++) {
      console.log(`  ${colorize(BOLD, (i + 1) + ".")} ${options[i].label}`);
    }
    const answer = await ask(rl, colorize(CYAN, "\n  选择 [1-" + options.length + "]: "));
    const idx = parseInt(answer) - 1;
    if (idx >= 0 && idx < options.length) {
      resolve({ index: idx, option: options[idx] });
    } else {
      console.log(colorize(RED, "  无效选择，请重试"));
      resolve(askChoice(rl, question, options));
    }
  });
}

// ============================================
// Step 1: Scan SSH environment
// ============================================

function stepScanSSH() {
  console.log(colorize(BOLD + CYAN, "━━━ Step 1: 扫描本地 SSH 环境 ━━━\n"));

  const sshInfo = scanLocalSSH();

  // Print scan results
  const summary = formatSSHScanSummary(sshInfo);
  for (const line of summary.split("\n")) {
    if (line.startsWith("Private Keys")) console.log(colorize(GREEN, "  " + line));
    else if (line.startsWith("Public Keys")) console.log(colorize(GREEN, "  " + line));
    else if (line.startsWith("SSH Config")) console.log(colorize(CYAN, "  " + line));
    else if (line.startsWith("Known Hosts")) console.log(colorize(DIM, "  " + line));
    else console.log("  " + line);
  }
  console.log("");

  return sshInfo;
}

// ============================================
// Step 2: Choose auth method
// ============================================

async function stepChooseAuth(rl, sshInfo) {
  console.log(colorize(BOLD + CYAN, "━━━ Step 2: 选择认证方式 ━━━\n"));

  const usableKeys = sshInfo.privateKeys.filter((k) => !k.encrypted);
  const encryptedKeys = sshInfo.privateKeys.filter((k) => k.encrypted);

  const options = [];

  // Add SSH config options
  if (sshInfo.configHosts.length > 0) {
    for (const h of sshInfo.configHosts) {
      let label = `SSH config: ${h.alias} -> ${h.host || "(default)"}:${h.port}`;
      if (h.user) label += ` user=${h.user}`;
      if (h.identityFile) label += ` key=${h.identityFile}`;
      options.push({ type: "config", label, host: h });
    }
  }

  // Add usable keys
  for (const k of usableKeys) {
    options.push({
      type: "key",
      label: `密钥: ${k.file} (${k.type}, 未加密)`,
      key: k,
    });
  }

  // Add encrypted keys
  for (const k of encryptedKeys) {
    options.push({
      type: "key_encrypted",
      label: `密钥: ${k.file} (${k.type}, 已加密 - 需要密码)`,
      key: k,
    });
  }

  // Password option
  options.push({ type: "password", label: "密码登录 (输入 SSH 密码)" });

  const choice = await askChoice(rl, "  选择连接方式:", options);

  return choice.option;
}

// ============================================
// Step 3: Collect connection details
// ============================================

async function stepCollectDetails(rl, authChoice, sshInfo) {
  console.log(colorize(BOLD + CYAN, "\n━━━ Step 3: 连接信息 ━━━\n"));

  let host, username, port, password, privateKey, passphrase;

  if (authChoice.type === "config") {
    // From SSH config
    const h = authChoice.host;
    host = h.host || await ask(rl, colorize(CYAN, "  服务器地址: "));
    username = h.user || await ask(rl, colorize(CYAN, "  SSH 用户名: "));
    port = h.port || 22;
    if (h.identityFile) {
      privateKey = h.identityFile.replace("~", process.env.HOME || process.env.USERPROFILE);
    }
  } else {
    // Manual input
    host = await ask(rl, colorize(CYAN, "  服务器地址 (IP 或域名): "));
    username = await ask(rl, colorize(CYAN, "  SSH 用户名 (如 root): "));
    const portStr = await ask(rl, colorize(CYAN, "  SSH 端口 [22]: "));
    port = portStr ? parseInt(portStr) : 22;

    if (authChoice.type === "key") {
      privateKey = authChoice.key.path;
    } else if (authChoice.type === "key_encrypted") {
      privateKey = authChoice.key.path;
      passphrase = await ask(rl, colorize(CYAN, "  密钥密码: "));
    } else {
      password = await ask(rl, colorize(CYAN, "  SSH 密码: "));
    }
  }

  return { host, username, port, password, privateKey, passphrase };
}

// ============================================
// Step 4: Test connection
// ============================================

async function stepTestConnection(details) {
  console.log(colorize(BOLD + CYAN, "\n━━━ Step 4: 测试连接 ━━━\n"));

  // Dynamic import ssh-client.js to avoid loading it if not needed
  const { SSHClient } = await import("./ssh-client.js");

  const sshConfig = {
    host: details.host,
    port: details.port,
    username: details.username,
  };
  if (details.password) sshConfig.password = details.password;
  if (details.privateKey) sshConfig.privateKey = details.privateKey;
  if (details.passphrase) sshConfig.passphrase = details.passphrase;

  console.log(colorize(DIM, `  连接 ${details.username}@${details.host}:${details.port} ...`));

  const client = new SSHClient(sshConfig);
  try {
    await client.connect();
    const result = await client.exec('echo "connected" && uname -a && whoami');
    console.log(colorize(GREEN, "  ✅ 连接成功!"));
    console.log(colorize(DIM, `  ${result.stdout.trim()}`));
    client.disconnect();
    return true;
  } catch (err) {
    console.log(colorize(RED, `  ❌ 连接失败: ${err.message}`));
    try { client.disconnect(); } catch {}
    return false;
  }
}

// ============================================
// Step 5: Save configuration
// ============================================

function stepSaveConfig(details) {
  console.log(colorize(BOLD + CYAN, "\n━━━ Step 5: 保存配置 ━━━\n"));

  const localDir = join(__dirname, "local");
  if (!fs.existsSync(localDir)) {
    fs.mkdirSync(localDir, { recursive: true });
  }

  // Save connection to connections.json
  const connPath = join(localDir, "connections.json");
  let connConfig = { connections: [], default: "" };

  if (fs.existsSync(connPath)) {
    try {
      connConfig = JSON.parse(fs.readFileSync(connPath, "utf-8").replace(/^\uFEFF/, ""));
    } catch {}
  }

  const connName = `ssh-${details.host.replace(/\./g, "-")}`;
  const newConn = {
    name: connName,
    type: "ssh",
    description: `${details.username}@${details.host}:${details.port}`,
    host: details.host,
    port: details.port,
    username: details.username,
  };
  if (details.privateKey) newConn.privateKey = details.privateKey;

  // Update or add connection
  const existingIdx = connConfig.connections.findIndex((c) => c.name === connName);
  if (existingIdx >= 0) {
    connConfig.connections[existingIdx] = newConn;
  } else {
    connConfig.connections.push(newConn);
  }
  connConfig.default = connName;

  fs.writeFileSync(connPath, JSON.stringify(connConfig, null, 2) + "\n", "utf-8");
  console.log(colorize(GREEN, `  ✅ 连接配置已保存: ${connPath}`));
  console.log(colorize(DIM, `     连接名: ${connName}`));

  return { connName, connPath };
}

// ============================================
// Step 6: Show next steps
// ============================================

function stepShowNextSteps(details, connResult) {
  console.log(colorize(BOLD + CYAN, "\n━━━ 完成! ━━━\n"));
  console.log("  接下来你可以：\n");
  console.log(`  ${colorize(BOLD, "1. AI 工具中使用")}`);
  console.log(`     直接告诉 AI "连接 ${details.host}"，AI 会自动使用已保存的配置\n`);
  console.log(`  ${colorize(BOLD, "2. 手动连接测试")}`);
  console.log(`     在 AI 工具中调用 remote_connect(connection="${connResult.connName}")\n`);
  console.log(`  ${colorize(BOLD, "3. 部署守护进程（可选）")}`);
  console.log(`     在 AI 工具中调用 remote_setup(host="${details.host}", username="${details.username}")`);
  console.log(`     选择已保存的密钥即可自动部署\n`);
}

// ============================================
// Main
// ============================================

async function main() {
  printBanner();

  const sshInfo = stepScanSSH();
  const rl = createRL();

  try {
    const authChoice = await stepChooseAuth(rl, sshInfo);
    const details = await stepCollectDetails(rl, authChoice, sshInfo);

    const ok = await stepTestConnection(details);
    if (!ok) {
      console.log(colorize(YELLOW, "\n  连接失败，请检查服务器信息后重试。"));
      console.log(colorize(DIM, `  提示：确认服务器 IP、端口、用户名和认证信息是否正确。`));
      process.exit(1);
    }

    const connResult = stepSaveConfig(details);
    stepShowNextSteps(details, connResult);
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(colorize(RED, `\n  Setup 失败: ${err.message}`));
  process.exit(1);
});
