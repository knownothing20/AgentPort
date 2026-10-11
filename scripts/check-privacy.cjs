#!/usr/bin/env node

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PRIVATE_USER = ["le", "on"].join("");
const PRIVATE_USER_ESCAPED = PRIVATE_USER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PRIVATE_USER_NAME = new RegExp(`\\b${PRIVATE_USER_ESCAPED}\\b`, "i");
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

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
    pattern: /-----BEGIN (?:ENCRYPTED PRIVATE KEY|OPENSSH PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY|DSA PRIVATE KEY|ED25519 PRIVATE KEY|PRIVATE KEY)-----/,
  },
  {
    id: "common-api-token-format",
    pattern: /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})/,
  },
  {
    id: "agentport-token",
    pattern: /\bagentport-[A-Za-z0-9._-]+-[0-9a-z]{8,12}-[a-f0-9]{32}\b/,
  },
  {
    id: "aws-access-key-id",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  },
  {
    id: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    id: "slack-token",
    pattern: /\bxox(?:[abprs])-[A-Za-z0-9-]{10,}\b/,
  },
  {
    id: "stripe-live-key",
    pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/,
  },
  {
    id: "discord-token",
    pattern: /\b[A-Za-z\d_-]{24}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27}\b/,
  },
];

function isForbiddenPath(file) {
  const normalized = String(file).replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  const base = path.posix.basename(normalized).toLowerCase();
  const envLike = /^\.env(?:rc)?(?:$|[._-])/i.test(base);
  const envExample = /\.(?:example|template|sample)$/i.test(base);

  if (envLike && !envExample) return true;
  if (/^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?:\.(?:enc|encrypted))?|.*\.(?:pem|key|p8|pkcs8|p12|pfx|jks|keystore)(?:\.(?:enc|encrypted))?)$/i.test(base)) {
    return true;
  }
  if (normalized.toLowerCase() === "connections.json") return true;
  if (/^local\/(?:agentport|connections(?:\.v3)?|projects|cli-state|runtime-mode)\.json$/i.test(normalized)) {
    return true;
  }
  if (/^local\/(?:runtime|logs?|backups?)(?:\/|$)/i.test(normalized)) return true;
  if (/^local\/(?:.*\/)?[^/]+\.(?:log(?:\.\d+)?|bak|backup|old|sqlite3?|db)(?:\.(?:gz|zip))?$/i.test(normalized)) {
    return true;
  }
  return false;
}

function scanContent(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  let text;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = bytes.subarray(2).toString("utf16le");
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const input = bytes.subarray(2, bytes.length - ((bytes.length - 2) % 2));
    const swapped = Buffer.allocUnsafe(input.length);
    for (let index = 0; index < input.length; index += 2) {
      swapped[index] = input[index + 1];
      swapped[index + 1] = input[index];
    }
    text = swapped.toString("utf16le");
  } else {
    if (bytes.includes(0)) return [];
    text = bytes.toString("utf8");
  }
  return CONTENT_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.id);
}

function gitBuffer(root, args, options = {}) {
  return childProcess.execFileSync("git", args, {
    cwd: root,
    encoding: "buffer",
    input: options.input,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function nulRecords(bytes) {
  const records = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0) {
      if (index > start) records.push(bytes.subarray(start, index));
      start = index + 1;
    }
  }
  if (start < bytes.length) records.push(bytes.subarray(start));
  return records;
}

function repoPath(root, file) {
  const normalized = String(file).replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || segments.includes("..")) {
    throw new Error("invalid repository path");
  }
  return segments.reduce((current, segment) => path.join(current, segment), root);
}

function addFinding(findings, file, rule) {
  if (!findings.some((item) => item.file === file && item.rule === rule)) {
    findings.push({ file, rule });
  }
}

function addContentFindings(findings, file, content) {
  for (const rule of scanContent(content)) addFinding(findings, file, rule);
}

function gitPaths(root, args) {
  return nulRecords(gitBuffer(root, args)).map((entry) => entry.toString("utf8"));
}

function scanWorkingTree(root, findings) {
  const tracked = gitPaths(root, ["ls-files", "-z"]);
  const untracked = gitPaths(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const trackedSet = new Set(tracked);
  const files = [...new Set([...tracked, ...untracked])];
  const realRoot = fs.realpathSync(root);

  for (const file of files) {
    if (isForbiddenPath(file)) {
      addFinding(findings, file, "private-runtime-file");
      continue;
    }

    const fullPath = repoPath(root, file);
    let stat;
    try {
      stat = fs.lstatSync(fullPath);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }

    if (stat.isSymbolicLink()) {
      if (trackedSet.has(file)) addContentFindings(findings, file, Buffer.from(fs.readlinkSync(fullPath)));
      continue;
    }
    if (!stat.isFile()) continue;

    const realFile = fs.realpathSync(fullPath);
    const relative = path.relative(realRoot, realFile);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      addFinding(findings, file, "worktree-path-escapes-root");
      continue;
    }
    addContentFindings(findings, file, fs.readFileSync(fullPath));
  }
}

function parseIndexEntry(entry) {
  const tab = entry.indexOf(9);
  if (tab < 0) throw new Error("invalid index record");
  const header = entry.subarray(0, tab).toString("ascii");
  const match = /^([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])$/i.exec(header);
  if (!match) throw new Error("invalid index entry");
  return {
    mode: match[1],
    oid: match[2],
    file: entry.subarray(tab + 1).toString("utf8"),
  };
}

function scanIndex(root, findings) {
  const entries = nulRecords(gitBuffer(root, ["ls-files", "--stage", "-z"])).map(parseIndexEntry);
  for (const entry of entries) {
    if (isForbiddenPath(entry.file)) {
      addFinding(findings, entry.file, "private-runtime-file");
      continue;
    }
    if (entry.mode === "160000") continue;
    if (!["100644", "100755", "120000"].includes(entry.mode)) {
      addFinding(findings, entry.file, "unsupported-index-entry-type");
      continue;
    }
    addContentFindings(findings, entry.file, gitBuffer(root, ["cat-file", "blob", entry.oid]));
  }
}

function parseIdentity(identity) {
  const end = identity.lastIndexOf("> ");
  const start = identity.lastIndexOf(" <", end);
  if (start < 0 || end < 0 || !/^\d+ [+-]\d{4}$/.test(identity.slice(end + 2))) return null;
  const name = identity.slice(0, start);
  const email = identity.slice(start + 2, end);
  if (!name || !email || /[<>]/.test(email)) return null;
  return { name, email };
}

function identityRules(identity) {
  const parsed = parseIdentity(identity);
  if (!parsed) return ["invalid-commit-identity"];
  const findings = [];
  if (PRIVATE_USER_NAME.test(parsed.name)) findings.push("private-author-name");
  for (const rule of scanContent(Buffer.from(`${parsed.name} <${parsed.email}>`, "utf8"))) {
    if (!findings.includes(rule)) findings.push(rule);
  }
  const email = parsed.email.toLowerCase();
  const githubServiceIdentity = parsed.name === "GitHub"
    && ["noreply@github.com", "web-flow@github.com"].includes(email);
  if (!/^[^\s<>@]+@users\.noreply\.github\.com$/i.test(parsed.email) && !githubServiceIdentity) {
    findings.push("non-public-commit-email");
  }
  return findings;
}

function scanCurrentIdentities(root, findings, env) {
  for (const variable of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
    const identity = gitBuffer(root, ["var", variable], { env }).toString("utf8").trimEnd();
    for (const rule of identityRules(identity)) addFinding(findings, variable, rule);
  }
}

function validOid(value) {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
}

function isZeroOid(value) {
  return validOid(value) && /^0+$/.test(value);
}

function parsePrePushInput(input) {
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : String(input || "");
  if (!text.trim()) return [];
  const updates = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4) throw new Error("invalid pre-push record");
    const [localRef, localOid, remoteRef, remoteOid] = fields;
    if ((!validOid(localOid)) || (!validOid(remoteOid))) throw new Error("invalid pre-push object id");
    if (localOid.length !== remoteOid.length) throw new Error("inconsistent object format");
    if (localRef !== "(delete)" && !localRef.startsWith("refs/")) throw new Error("invalid local ref");
    if (!remoteRef.startsWith("refs/")) throw new Error("invalid remote ref");
    updates.push({ localRef, localOid, remoteRef, remoteOid });
  }
  return updates;
}

function resolveCommit(root, oid) {
  const resolved = gitBuffer(root, ["rev-parse", "--verify", `${oid}^{commit}`]).toString("ascii").trim();
  if (!validOid(resolved)) throw new Error("invalid resolved commit");
  return resolved;
}

function remoteTrackingRoots(root, remoteName) {
  if (!remoteName || /[\s\0]/.test(remoteName)) return [];
  const prefix = `refs/remotes/${remoteName}/`;
  const output = gitBuffer(root, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes"])
    .toString("utf8");
  const roots = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+) ([a-f0-9]{40,64})$/i.exec(line);
    if (match && match[1].startsWith(prefix)) roots.push(match[2]);
  }
  return roots;
}

function readCommit(root, commit) {
  const bytes = gitBuffer(root, ["cat-file", "commit", commit]);
  const separator = bytes.indexOf(Buffer.from("\n\n"));
  if (separator < 0) throw new Error("invalid commit object");
  const header = bytes.subarray(0, separator).toString("utf8");
  const parents = [];
  let author = null;
  let committer = null;
  for (const line of header.split("\n")) {
    if (line.startsWith("parent ")) parents.push(line.slice(7));
    else if (line.startsWith("author ")) author = line.slice(7);
    else if (line.startsWith("committer ")) committer = line.slice(10);
  }
  if (!author || !committer || parents.some((parent) => !validOid(parent))) throw new Error("invalid commit metadata");
  return { bytes, parents };
}

function treeEntries(root, commit) {
  const records = nulRecords(gitBuffer(root, ["ls-tree", "-r", "-z", "--full-tree", commit]));
  const entries = new Map();
  for (const record of records) {
    const tab = record.indexOf(9);
    if (tab < 0) throw new Error("invalid tree record");
    const fields = record.subarray(0, tab).toString("ascii").split(" ");
    if (fields.length !== 3 || !validOid(fields[2])) throw new Error("invalid tree entry");
    entries.set(record.subarray(tab + 1).toString("utf8"), {
      mode: fields[0],
      type: fields[1],
      oid: fields[2],
    });
  }
  return entries;
}

function changedPaths(root, commit, firstParent) {
  const args = ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames"];
  if (firstParent) args.push(firstParent, commit);
  else args.push("--root", commit);
  return gitPaths(root, args);
}

function scanOutgoingCommit(root, commit, findings) {
  const data = readCommit(root, commit);
  const source = `commit ${commit.slice(0, 12)}`;
  addContentFindings(findings, source, data.bytes);

  const header = data.bytes.subarray(0, data.bytes.indexOf(Buffer.from("\n\n"))).toString("utf8");
  for (const line of header.split("\n")) {
    if (!line.startsWith("author ") && !line.startsWith("committer ")) continue;
    for (const rule of identityRules(line.slice(line.indexOf(" ") + 1))) addFinding(findings, source, rule);
  }

  const entries = treeEntries(root, commit);
  for (const file of changedPaths(root, commit, data.parents[0])) {
    const entry = entries.get(file);
    if (!entry) continue;
    if (isForbiddenPath(file)) {
      addFinding(findings, file, "private-runtime-file");
      continue;
    }
    if (entry.type !== "blob") continue;
    addContentFindings(findings, file, gitBuffer(root, ["cat-file", "blob", entry.oid]));
  }
}

function scanPrePush(root, remoteName, input, findings) {
  const updates = parsePrePushInput(input);
  if (updates.length === 0) return { empty: true };
  if (!remoteName || /[\s\0]/.test(remoteName)) throw new Error("missing remote name");

  const localRoots = [];
  const publishedRoots = remoteTrackingRoots(root, remoteName);
  for (const update of updates) {
    if (!isZeroOid(update.localOid)) localRoots.push(resolveCommit(root, update.localOid));
    if (!isZeroOid(update.remoteOid)) {
      try {
        publishedRoots.push(resolveCommit(root, update.remoteOid));
      } catch {
        // A remote object may not be present locally; known tracking refs remain usable.
      }
    }
  }

  const uniqueLocalRoots = [...new Set(localRoots)];
  if (uniqueLocalRoots.length === 0) return { empty: false };

  const published = [...new Set(publishedRoots.map((oid) => resolveCommit(root, oid)))];
  const revisions = [
    ...uniqueLocalRoots,
    ...published.map((oid) => `^${oid}`),
  ].join("\n") + "\n";
  const candidates = gitBuffer(root, ["rev-list", "--reverse", "--topo-order", "--stdin"], {
    input: Buffer.from(revisions, "ascii"),
  }).toString("ascii").split(/\r?\n/).filter(Boolean);

  for (const commit of candidates) {
    if (!validOid(commit)) throw new Error("invalid outgoing commit id");
    scanOutgoingCommit(root, commit, findings);
  }
  return { empty: false };
}

function formatFindings(findings) {
  const lines = ["Privacy check failed. Replace or remove the flagged value before continuing:"];
  for (const finding of findings) lines.push(`- ${finding.file}: ${finding.rule}`);
  return `${lines.join("\n")}\n`;
}

function runPrivacyCheck(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const mode = options.mode || "working";
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const findings = [];
  try {
    if (mode === "working") scanWorkingTree(root, findings);
    else if (mode === "staged") {
      scanIndex(root, findings);
      if (options.checkIdentity) scanCurrentIdentities(root, findings, options.env);
    } else if (mode === "pre-push") {
      const result = scanPrePush(root, options.remoteName, options.input, findings);
      if (result.empty) {
        stdout.write("PASS privacy check (no pre-push refs)\n");
        return 0;
      }
    } else {
      throw new Error("unknown privacy check mode");
    }
  } catch {
    stderr.write("Privacy check could not complete; refusing to continue.\n");
    return 2;
  }

  if (findings.length > 0) {
    stderr.write(formatFindings(findings));
    return 1;
  }
  stdout.write("PASS privacy check\n");
  return 0;
}

function readPrePushInput() {
  if (process.stdin.isTTY) return Buffer.alloc(0);
  try {
    return fs.readFileSync(0);
  } catch (error) {
    if (error.code === "EBADF" || error.code === "EINVAL") return Buffer.alloc(0);
    throw error;
  }
}

function main(args = process.argv.slice(2)) {
  if (args.length === 0) return runPrivacyCheck({ mode: "working" });
  if (args[0] === "--staged" && args.slice(1).every((arg) => arg === "--check-identity")) {
    return runPrivacyCheck({ mode: "staged", checkIdentity: args.includes("--check-identity") });
  }
  if (args[0] === "--pre-push" && args.length <= 2) {
    let input;
    try {
      input = readPrePushInput();
    } catch {
      process.stderr.write("Privacy check could not read pre-push refs; refusing to continue.\n");
      return 2;
    }
    return runPrivacyCheck({ mode: "pre-push", remoteName: args[1] || "", input });
  }
  process.stderr.write("Usage: check-privacy.cjs [--staged [--check-identity] | --pre-push <remote>]\n");
  return 2;
}

if (require.main === module) process.exitCode = main();

module.exports = { isForbiddenPath, scanContent, runPrivacyCheck, parsePrePushInput };
