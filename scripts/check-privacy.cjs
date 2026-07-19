#!/usr/bin/env node

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PRIVATE_USER = ["le", "on"].join("");
const PRIVATE_USER_ESCAPED = PRIVATE_USER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const CONTENT_RULES = [
  {
    id: "private-network-address",
    pattern: /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/,
  },
  {
    id: "machine-specific-linux-home",
    pattern: new RegExp(String.raw`/home/${PRIVATE_USER_ESCAPED}(?:/|\b)`, "i"),
  },
  {
    id: "machine-specific-windows-home",
    pattern: new RegExp(String.raw`C:[\\/]Users[\\/]${PRIVATE_USER_ESCAPED}(?:[\\/]|\b)`, "i"),
  },
  {
    id: "machine-specific-ssh-user",
    pattern: new RegExp(`${PRIVATE_USER_ESCAPED}@`, "i"),
  },
  {
    id: "private-key-header",
    pattern: /-----BEGIN (?:OPENSSH|RSA|EC|DSA|PRIVATE) KEY-----/,
  },
  {
    id: "common-api-token-format",
    pattern: /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})/,
  },
];

function isForbiddenPath(file) {
  const normalized = file.replace(/\\/g, "/");
  const base = path.posix.basename(normalized).toLowerCase();

  if (base === ".env" || base === ".env.local") return true;
  if (/^(?:id_rsa|id_ed25519|.*\.(?:pem|key))$/i.test(base)) return true;
  return /^local\/(?:agentport|connections(?:\.v3)?|projects|cli-state|runtime-mode)\.json$/i.test(normalized);
}

function scanContent(content) {
  if (content.includes(0)) return [];
  const text = content.toString("utf8");
  return CONTENT_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.id);
}

function trackedFiles() {
  const output = childProcess.execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return output.split("\0").filter(Boolean);
}

function main() {
  const findings = [];
  for (const file of trackedFiles()) {
    if (isForbiddenPath(file)) {
      findings.push({ file, rule: "private-runtime-file" });
      continue;
    }

    const fullPath = path.join(ROOT, file);
    if (!fs.existsSync(fullPath)) continue;
    for (const rule of scanContent(fs.readFileSync(fullPath))) {
      findings.push({ file, rule });
    }
  }

  if (findings.length > 0) {
    console.error("Privacy check failed. Replace or remove the flagged value before committing:");
    for (const finding of findings) console.error(`- ${finding.file}: ${finding.rule}`);
    process.exitCode = 1;
    return;
  }

  console.log("PASS privacy check");
}

if (require.main === module) main();

module.exports = { isForbiddenPath, scanContent };
