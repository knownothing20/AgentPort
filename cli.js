#!/usr/bin/env node

import axios from "axios";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";
import { scheduleForcedExit, startParentWatchdog } from "./cli-lifecycle.js";
import { SSHClient } from "./ssh-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONNECTIONS_PATH = process.env.AGENTPORT_LEGACY_CONNECTIONS_PATH
  || process.env.MCP_REMOTE_CONNECTIONS_PATH
  || path.join(__dirname, "local", "connections.json");
const STATE_PATH = path.join(__dirname, "local", "cli-state.json");
const TIMEOUT_MS = Number(process.env.MCP_REMOTE_TIMEOUT_MS || process.env.NIUMA_SSH_TIMEOUT_MS || 120000);
const SAFE_JOB_TIMEOUT_MS = Number(process.env.AGENTPORT_SAFE_JOB_TIMEOUT_MS || 1800000);
const HTTP_AGENT = new http.Agent({ keepAlive: false });
const HTTPS_AGENT = new https.Agent({ keepAlive: false });
const DEFAULT_TOKEN_ENV_PATH = "~/.agentport/daemon/.env";
const SESSION_ID = sanitizeStateSegment(process.env.AGENTPORT_SESSION_ID || process.env.CODEX_SESSION_ID || "");
const stopParentWatchdog = startParentWatchdog();

function print(text = "") {
  process.stdout.write(`${text}\n`);
}

function printJson(value) {
  print(JSON.stringify(value, null, 2));
}

function fail(message, code = 1, args = null) {
  if (args?.json) {
    const text = String(message || "Unknown error");
    const hint = /Transport closed|ECONNRESET|EPIPE|ETIMEDOUT|ECONNABORTED/i.test(text)
      ? "Native MCP or daemon transport is unstable. Retry with --route ssh or switch to an SSH connection."
      : "Run `node cli.js doctor --json` to inspect route health.";
    printJson({
      ok: false,
      error: text,
      fallback: hint,
    });
    process.exitCode = code;
    return;
  }
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
}

function operationExitCode(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const code = operationExitCode(item);
      if (code !== 0) return code;
    }
    return 0;
  }
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value.results)) {
    const code = operationExitCode(value.results);
    if (code !== 0) return code;
  }
  if (value.result && typeof value.result === "object") {
    const code = operationExitCode(value.result);
    if (code !== 0) return code;
  }
  const commandCode = Number(value.code);
  if (Number.isInteger(commandCode) && commandCode !== 0) {
    return commandCode > 0 && commandCode <= 255 ? commandCode : 1;
  }
  const status = Number(value.status);
  if (Number.isInteger(status) && status >= 400) return 1;
  if (value.ok === false || value.success === false) return 1;
  return 0;
}

function applyOperationExitCode(value) {
  const code = operationExitCode(value);
  if (code !== 0) process.exitCode = code;
}

function mask(value) {
  if (!value) return value;
  const text = String(value);
  if (text.length <= 8) return "***";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Failed to read ${filePath}: ${error.message}`);
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sanitizeStateSegment(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function statePath() {
  if (!SESSION_ID) return STATE_PATH;
  return path.join(__dirname, "local", "sessions", SESSION_ID, "cli-state.json");
}

function loadConnections() {
  const config = readJson(CONNECTIONS_PATH, { connections: [] });
  const connections = Array.isArray(config.connections) ? config.connections : [];
  const byName = new Map();
  for (const conn of connections) {
    if (conn?.name) byName.set(conn.name, conn);
  }
  return {
    config,
    connections,
    byName,
    defaultName: config.default || connections[0]?.name || "",
  };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function parseTimeoutMs(value, fallback, name) {
  const resolved = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new Error(`${name} must be an integer >= 0.`);
  }
  if (resolved > 0 && resolved < 1000) {
    throw new Error(`${name} must be 0 or at least 1000ms.`);
  }
  return resolved;
}

function cliExecTimeoutMs(args = {}, conn = {}) {
  const value = args.execTimeoutMs ?? args["exec-timeout-ms"] ?? conn.execTimeoutMs;
  return parseTimeoutMs(value, TIMEOUT_MS, "--exec-timeout-ms");
}

function jobTimeoutMs(args = {}, fallback) {
  const value = args.jobTimeoutMs ?? args["job-timeout-ms"] ?? args.timeoutMs ?? args["timeout-ms"];
  if (value === undefined && fallback === undefined) return undefined;
  return parseTimeoutMs(value, fallback, "--job-timeout-ms");
}

function cliSshConfig(conn, args = {}) {
  return { ...conn, execTimeoutMs: cliExecTimeoutMs(args, conn) };
}

function getState() {
  return readJson(statePath(), {});
}

function setCurrentConnection(name) {
  writeJson(statePath(), {
    current: name,
    sessionId: SESSION_ID || null,
    updatedAt: new Date().toISOString(),
  });
}

function explicitConnectionName(options = {}) {
  return String(options.connection || process.env.MCP_REMOTE_CONNECTION || process.env.NIUMA_SSH_CONNECTION || "").trim();
}

function failClosedConnectionError(connections) {
  const names = connections.map((conn) => conn.name).filter(Boolean).join(", ");
  return [
    "Multiple connections are configured; this command requires an explicit --connection <name>.",
    `Available connections: ${names || "(none)"}.`,
    "Do not rely on shared current connection for write, exec, script, batch, job, trace, token, or config operations.",
  ].join(" ");
}

function connectionTarget(conn, route) {
  const type = route || conn.type || "daemon";
  const base = {
    connection: conn.name || null,
    route: type,
    type,
  };
  if (type === "ssh") {
    return {
      ...base,
      host: conn.host || null,
      port: conn.port || 22,
      username: conn.username || null,
      target: `${conn.username || "unknown"}@${conn.host || "unknown"}:${conn.port || 22}`,
    };
  }
  return {
    ...base,
    url: conn.url || null,
    target: conn.url || null,
  };
}

function withTarget(payload, ctx) {
  return {
    ...payload,
    target: ctx.target,
    connection: ctx.target.connection,
    route: ctx.target.route,
    fallbackFrom: ctx.fallbackFrom || undefined,
    fallbackReason: ctx.fallbackReason || undefined,
  };
}

function selectConnection(options = {}) {
  const { connections, byName, defaultName } = loadConnections();
  const explicit = explicitConnectionName(options);
  if (options.requireExplicitConnection && connections.length > 1 && !explicit) {
    throw new Error(failClosedConnectionError(connections));
  }
  const stateCurrent = getState().current;
  const wanted = explicit || stateCurrent || defaultName;
  const route = String(options.route || "").toLowerCase();
  const wantsSsh = route === "ssh" || route === "openssh";
  const wantsDaemon = route === "daemon";

  if (explicit) {
    if (!byName.has(explicit)) {
      throw new Error(`Connection '${explicit}' not found in ${CONNECTIONS_PATH}.`);
    }
    const chosen = byName.get(explicit);
    const chosenType = chosen.type || "daemon";
    if ((wantsSsh && chosenType !== "ssh") || (wantsDaemon && chosenType !== "daemon")) {
      throw new Error(`Connection '${explicit}' is ${chosenType}, not ${wantsSsh ? "ssh" : "daemon"}.`);
    }
    return chosen;
  }

  if (wantsSsh || wantsDaemon) {
    if (wanted && byName.has(wanted)) {
      const chosen = byName.get(wanted);
      const chosenType = chosen.type || "daemon";
      if ((wantsSsh && chosenType === "ssh") || (wantsDaemon && chosenType === "daemon")) return chosen;
    }
    const fallback = connections.find((conn) => {
      const type = conn.type || "daemon";
      return wantsSsh ? type === "ssh" : type === "daemon";
    });
    if (fallback) return fallback;
    throw new Error(`No ${wantsSsh ? "SSH" : "daemon"} connection found in ${CONNECTIONS_PATH}.`);
  }

  if (wanted && byName.has(wanted)) return byName.get(wanted);
  if (connections.length === 0) {
    throw new Error(`No connections found. Create ${CONNECTIONS_PATH} first.`);
  }
  return connections[0];
}

function sanitizeContent(content) {
  return String(content).replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
}

function preserveUtf8Content(content) {
  return String(content).replace(/^\uFEFF/, "");
}

function sha256Text(content) {
  return crypto.createHash("sha256").update(String(content), "utf8").digest("hex");
}

function utf8Bytes(content) {
  return Buffer.byteLength(String(content), "utf8");
}

function shouldVerifyReadback(args) {
  if (args["no-verify"] || args.noVerify) return false;
  const value = String(args.verify ?? "readback").trim().toLowerCase();
  return !["0", "false", "no", "none", "off", "skip"].includes(value);
}

function readUtf8PayloadFile(file, { normalizeLf = false } = {}) {
  if (!file || typeof file !== "string") throw new Error("Missing --file <local-file>.");
  const content = fs.readFileSync(file, "utf8");
  return normalizeLf ? sanitizeContent(content) : preserveUtf8Content(content);
}

const SAFE_SCRIPT_INTERPRETERS = new Set(["bash", "sh", "dash", "zsh", "python", "python3", "node", "ruby", "perl"]);

function safeScriptInterpreter(value) {
  const interpreter = String(value || "bash").trim();
  if (!SAFE_SCRIPT_INTERPRETERS.has(interpreter)) {
    throw new Error(`Unsupported interpreter '${interpreter}'. Allowed: ${[...SAFE_SCRIPT_INTERPRETERS].join(", ")}`);
  }
  return interpreter;
}

function scriptExtension(interpreter) {
  if (interpreter === "python" || interpreter === "python3") return "py";
  if (interpreter === "node") return "js";
  if (interpreter === "ruby") return "rb";
  if (interpreter === "perl") return "pl";
  return "sh";
}

function remoteTempDirArg(args) {
  return args.remoteTmpDir || args["remote-tmp-dir"] || args.tmpDir || args["tmp-dir"] || "";
}

function joinRemotePath(dir, name) {
  return `${String(dir || "").replace(/\/+$/, "")}/${name}`;
}

function remoteScriptBaseDir(ssh, args) {
  const explicit = remoteTempDirArg(args);
  if (explicit) return explicit;
  if (ssh.workspaceRoot) {
    const cwd = ssh.resolveWorkspaceCwd(args.cwd);
    return joinRemotePath(cwd || ssh.workspaceRoot, ".agentport-tmp");
  }
  if (typeof args.cwd === "string" && args.cwd.trim()) {
    const cwd = args.cwd.trim();
    if (cwd.startsWith("/") || cwd.startsWith("~")) return joinRemotePath(cwd, ".agentport-tmp");
  }
  return "~/.agentport/tmp";
}

function remoteScriptPath(ssh, args, interpreter) {
  const name = `agentport-safe-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${scriptExtension(interpreter)}`;
  return joinRemotePath(remoteScriptBaseDir(ssh, args), name);
}

function remotePayloadPath(ssh, args, extension) {
  const ext = String(extension || "txt").replace(/[^a-zA-Z0-9]/g, "") || "txt";
  const name = `agentport-payload-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${ext}`;
  return joinRemotePath(remoteScriptBaseDir(ssh, args), name);
}

function remoteJobWrapperPath(ctx, args) {
  const explicit = remoteTempDirArg(args);
  let baseDir = explicit;
  if (!baseDir && ctx.type === "ssh") baseDir = remoteScriptBaseDir(ctx.ssh, args);
  if (!baseDir && typeof args.cwd === "string" && args.cwd.trim()) {
    baseDir = joinRemotePath(args.cwd.trim(), ".agentport-tmp");
  }
  if (!baseDir) throw new Error("safe-job requires --cwd <remote-cwd> or --remote-tmp-dir <path>.");
  const name = `agentport-safe-job-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.sh`;
  return joinRemotePath(baseDir, name);
}

function safeHeredocMarker(content) {
  let marker;
  do {
    marker = `AGENTPORT_JOB_${crypto.randomBytes(12).toString("hex").toUpperCase()}`;
  } while (String(content).split(/\r?\n/).includes(marker));
  return marker;
}

function buildSafeJobWrapper(content, interpreter, { keepRemote = false } = {}) {
  const marker = safeHeredocMarker(content);
  const lines = ["#!/usr/bin/env bash", "set +e"];
  if (!keepRemote) {
    lines.push(
      'cleanup() { rm -f -- "$0"; }',
      "trap 'code=$?; cleanup; exit \"$code\"' EXIT",
      "trap 'exit 143' HUP INT TERM",
    );
  }
  lines.push(`${shellSingleQuote(interpreter)} - <<'${marker}'`);
  lines.push(String(content).replace(/\n$/, ""));
  lines.push(marker, "");
  return lines.join("\n");
}

async function writeRemoteContent(ctx, targetPath, content) {
  if (ctx.type === "ssh") {
    await ctx.ssh.writeFile(targetPath, content);
    return { mode: "ssh" };
  }
  const data = await postWithFallback(ctx.http, ["/api/fs/write", "/write"], { path: targetPath, content });
  return { mode: "daemon", etag: data.etag };
}

async function cleanupRemoteContent(ctx, targetPath, cwd) {
  if (ctx.type === "ssh") {
    await ctx.ssh.rm(targetPath);
    return;
  }
  await postWithFallback(ctx.http, ["/api/exec/script"], {
    content: `rm -f -- ${shellSingleQuote(targetPath)}\n`,
    interpreter: "bash",
    cwd,
  });
}

async function verifyRemoteContent(ctx, targetPath, expectedSha256) {
  const { type, http, ssh } = ctx;
  let content = "";
  if (type === "ssh") {
    content = await ssh.readFile(targetPath);
  } else {
    const data = await postWithFallback(http, ["/api/fs/read", "/read"], { path: targetPath });
    content = data.content ?? "";
  }
  const actualSha256 = sha256Text(content);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Remote readback mismatch for '${targetPath}'. expected=${expectedSha256} actual=${actualSha256}`);
  }
  return { ok: true, sha256: actualSha256, bytes: utf8Bytes(content) };
}

function gitApplyFlags(args, { check = false } = {}) {
  const flags = [];
  if (check) flags.push("--check");
  if (args.reverse) flags.push("--reverse");
  if (args.index) flags.push("--index");
  if (args.cached) flags.push("--cached");
  if (args["3way"] || args.threeWay || args["three-way"]) flags.push("--3way");
  const whitespace = args.whitespace ? String(args.whitespace).trim() : "";
  if (whitespace) {
    const allowed = new Set(["nowarn", "warn", "fix", "error", "error-all"]);
    if (!allowed.has(whitespace)) {
      throw new Error(`Unsupported --whitespace value '${whitespace}'. Allowed: ${[...allowed].join(", ")}`);
    }
    flags.push(`--whitespace=${whitespace}`);
  }
  return flags;
}

function gitApplyCommand(remotePatchPath, args, options = {}) {
  const flags = gitApplyFlags(args, options).map(shellSingleQuote).join(" ");
  return `git apply${flags ? ` ${flags}` : ""} ${shellSingleQuote(remotePatchPath)}`;
}

function decodeEnvValue(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseAuthTokenMap(rawValue) {
  const out = new Map();
  for (const entry of parseCsv(rawValue)) {
    const idx = entry.indexOf("=");
    if (idx <= 0 || idx >= entry.length - 1) continue;
    const clientId = entry.slice(0, idx).trim();
    const token = entry.slice(idx + 1).trim();
    if (!clientId || !token) continue;
    out.set(clientId, token);
  }
  return out;
}

function serializeAuthTokenMap(tokenMap) {
  return [...tokenMap.entries()].map(([clientId, token]) => `${clientId}=${token}`).join(",");
}

function parseAdminTokenSet(rawValue) {
  return new Set(parseCsv(rawValue));
}

function serializeAdminTokenSet(adminSet) {
  return [...adminSet.values()].join(",");
}

function parseEnvDocument(content) {
  const normalized = sanitizeContent(content ?? "");
  const hadTrailingNewline = normalized.endsWith("\n");
  const rows = normalized.split("\n");
  if (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  const lines = rows.map((line) => {
    const match = line.match(/^(\s*(?:export\s+)?)(([A-Za-z_][A-Za-z0-9_]*))\s*=(.*)$/);
    if (!match) return { kind: "raw", raw: line };
    return {
      kind: "kv",
      prefix: match[1] || "",
      key: match[2],
      value: match[4] ?? "",
    };
  });
  return { lines, hadTrailingNewline };
}

function stringifyEnvDocument(doc) {
  const body = doc.lines
    .map((line) => (line.kind === "kv" ? `${line.prefix || ""}${line.key}=${line.value}` : line.raw))
    .join("\n");
  if (body.length === 0) return "\n";
  return doc.hadTrailingNewline ? `${body}\n` : body;
}

function getEnvValue(doc, key) {
  for (let i = doc.lines.length - 1; i >= 0; i--) {
    const line = doc.lines[i];
    if (line.kind === "kv" && line.key === key) return line.value;
  }
  return "";
}

function setEnvValue(doc, key, value) {
  let updated = false;
  const next = [];
  for (const line of doc.lines) {
    if (line.kind === "kv" && line.key === key) {
      if (!updated) {
        next.push({ ...line, value });
        updated = true;
      }
      continue;
    }
    next.push(line);
  }
  if (!updated) next.push({ kind: "kv", prefix: "", key, value });
  doc.lines = next;
}

function normalizeClientId(value) {
  const clientId = String(value || "").trim();
  if (!clientId) throw new Error("Missing clientId. Use --client-id <client-id>.");
  if (!/^[a-zA-Z0-9._-]+$/.test(clientId)) {
    throw new Error("Invalid clientId. Use only letters, numbers, dot, underscore, or dash.");
  }
  return clientId;
}

function generateAuthToken(clientId) {
  const scope = String(clientId || "client").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 48);
  const rand = crypto.randomBytes(16).toString("hex");
  return `agentport-${scope}-${Date.now().toString(36)}-${rand}`;
}

function redactSensitiveText(message, secrets = []) {
  let text = String(message || "");
  const unique = [...new Set(secrets.map((item) => String(item || "").trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  for (const secret of unique) {
    text = text.split(secret).join(mask(secret));
  }
  text = text.replace(/(AUTH_TOKENS\s*=\s*)([^\n]+)/gi, (_, p1) => `${p1}<redacted>`);
  text = text.replace(/(ADMIN_TOKENS\s*=\s*)([^\n]+)/gi, (_, p1) => `${p1}<redacted>`);
  return text;
}

function parseMaybeInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeBaseUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

function defaultTokenArgs(args) {
  if (args.route) return args;
  return { ...args, route: "ssh" };
}

function tokenEnvPathFromArgs(args) {
  return args["env-path"] || args.envPath || DEFAULT_TOKEN_ENV_PATH;
}

function expandTildeForDaemon(targetPath, conn) {
  const input = String(targetPath || "").trim();
  if (!input.startsWith("~")) return input;
  const user = String(conn?.username || "").trim();
  const home = user === "root" ? "/root" : user ? `/home/${user}` : "";
  if (!home) {
    throw new Error("Cannot resolve '~' on daemon route without username. Use --route ssh or --env-path /absolute/path.");
  }
  if (input === "~") return home;
  if (input.startsWith("~/")) return `${home}/${input.slice(2)}`;
  throw new Error("Unsupported '~' path format. Use ~/.agentport/daemon/.env or an absolute path.");
}

async function resolveTokenEnvPath(ctx, args) {
  const targetPath = tokenEnvPathFromArgs(args);
  if (ctx.type === "ssh") return await ctx.ssh.resolveRemotePath(targetPath);
  return expandTildeForDaemon(targetPath, ctx.conn);
}

async function readTokenEnv(ctx, args) {
  let envPath = "";
  let content = "";
  try {
    if (ctx.type === "ssh") {
      envPath = await resolveTokenEnvPath(ctx, args);
      content = await ctx.ssh.readFile(envPath);
    } else {
      try {
        const response = await ctx.http.get("/api/config", { params: { raw: "1" } });
        const data = response.data || {};
        if (data.raw !== true || typeof data.config !== "string") {
          throw new Error("Remote daemon does not support raw admin config reads.");
        }
        envPath = data.envPath || tokenEnvPathFromArgs(args);
        content = data.config;
      } catch (rawError) {
        try {
          envPath = await resolveTokenEnvPath(ctx, args);
          const data = await postWithFallback(ctx.http, ["/api/fs/read", "/read"], { path: envPath });
          content = data.content ?? "";
        } catch (fsError) {
          throw new Error(`${rawError.message} Fallback fs read failed: ${fsError.message}`);
        }
      }
    }
  } catch (error) {
    throw new Error(`Failed to read remote env file '${envPath}'. ${redactSensitiveText(error.message)}`);
  }
  const doc = parseEnvDocument(content);
  const authTokens = parseAuthTokenMap(decodeEnvValue(getEnvValue(doc, "AUTH_TOKENS")));
  const adminTokens = parseAdminTokenSet(decodeEnvValue(getEnvValue(doc, "ADMIN_TOKENS")));
  const port = parseMaybeInt(decodeEnvValue(getEnvValue(doc, "PORT")), 3183);
  return { envPath, doc, authTokens, adminTokens, port };
}

async function writeTokenEnv(ctx, envPath, doc, secrets = []) {
  const content = stringifyEnvDocument(doc);
  try {
    if (ctx.type === "ssh") {
      await ctx.ssh.writeFile(envPath, content);
      return { hotReloaded: false, method: "ssh-write" };
    }
    try {
      await ctx.http.put("/api/config", { config: content });
      return { hotReloaded: true, method: "daemon-config-api" };
    } catch (_) {
      await postWithFallback(ctx.http, ["/api/fs/write", "/write"], { path: envPath, content });
      return { hotReloaded: false, method: "daemon-fs-write" };
    }
  } catch (error) {
    throw new Error(redactSensitiveText(`Failed to write remote env file '${envPath}'. ${error.message}`, secrets));
  }
}

function tokenValueByClient(authTokens, clientId) {
  return authTokens.get(clientId) || "";
}

function addTokenUsage() {
  return "Usage: node cli.js token add --client-id <client-id> [--token value] [--admin] [--route ssh|daemon]";
}

function localDirFromArgs(args) {
  const dir = args["local-dir"] || args.localDir || args["skill-dir"] || args.skillDir || __dirname;
  return path.resolve(String(dir));
}

function localConnectionsPathFromArgs(args) {
  const explicit = args["connections-path"] || args.connectionsPath;
  if (explicit) return path.resolve(String(explicit));
  return path.join(localDirFromArgs(args), "local", "connections.json");
}

function readLocalConnections(filePath) {
  if (!fs.existsSync(filePath)) return { connections: [], default: "" };
  const config = readJson(filePath, { connections: [] });
  return {
    ...config,
    connections: Array.isArray(config.connections) ? config.connections : [],
  };
}

function upsertConnection(config, connection) {
  const connections = Array.isArray(config.connections) ? [...config.connections] : [];
  const index = connections.findIndex((item) => item?.name === connection.name);
  if (index >= 0) connections[index] = { ...connections[index], ...connection };
  else connections.push(connection);
  return { ...config, connections };
}

function inferDaemonName(clientId, args) {
  return args["daemon-name"] || args.daemonName || args.name || `${clientId}-daemon`;
}

function inferDaemonUrl(ctx, state, args) {
  const explicit = args["daemon-url"] || args.daemonUrl || args.url;
  if (explicit) return normalizeBaseUrl(explicit);
  if (ctx.conn?.url) return normalizeBaseUrl(ctx.conn.url);
  if (ctx.conn?.host) return `http://${ctx.conn.host}:${state.port || 3183}`;
  throw new Error("Cannot infer daemon URL. Pass --daemon-url http://host:port.");
}

async function verifyDaemonToken(url, clientId, token) {
  let lastError = null;
  try {
    const client = axios.create({
      baseURL: normalizeBaseUrl(url),
      timeout: 10000,
      httpAgent: HTTP_AGENT,
      httpsAgent: HTTPS_AGENT,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Client-ID": clientId,
        "Content-Type": "application/json",
      },
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await client.get("/api/jobs?limit=1");
        return { ok: true, status: response.status };
      } catch (error) {
        lastError = error;
        if (!["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNABORTED"].includes(error?.code) || attempt > 0) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  } catch (error) {
    lastError = error;
  }
  return {
    ok: false,
    status: lastError?.response?.status || null,
    error: lastError?.response?.data?.error || lastError?.message,
  };
}

async function commandClientProvision(args) {
  const clientId = normalizeClientId(args["client-id"] || args.clientId || args._[2]);
  const wantsAdmin = Boolean(args.admin);
  const replace = Boolean(args.replace || args.force);
  const setDefault = args.default !== false && args.default !== "false" && !args["no-default"];

  await withConnection({ ...defaultTokenArgs(args), requireExplicitConnection: true }, async (ctx) => {
    const state = await readTokenEnv(ctx, args);
    const existing = tokenValueByClient(state.authTokens, clientId);
    const token = existing && !replace ? existing : generateAuthToken(clientId);
    const needsAdminUpdate = Boolean(existing && wantsAdmin && !state.adminTokens.has(existing));

    let remoteWrite = { hotReloaded: false, method: "reused-existing-token" };
    if (!existing || replace || needsAdminUpdate) {
      state.authTokens.set(clientId, token);
      if (wantsAdmin) state.adminTokens.add(token);
      setEnvValue(state.doc, "AUTH_TOKENS", serializeAuthTokenMap(state.authTokens));
      setEnvValue(state.doc, "ADMIN_TOKENS", serializeAdminTokenSet(state.adminTokens));
      remoteWrite = await writeTokenEnv(ctx, state.envPath, state.doc, [token, existing]);
    }

    const daemonName = inferDaemonName(clientId, args);
    const daemonUrl = inferDaemonUrl(ctx, state, args);
    const connectionsPath = localConnectionsPathFromArgs(args);
    const localConfig = readLocalConnections(connectionsPath);
    const nextConfig = upsertConnection(localConfig, {
      name: daemonName,
      type: "daemon",
      description: `${clientId} daemon`,
      url: daemonUrl,
      clientId,
      authToken: token,
    });
    if (setDefault) nextConfig.default = daemonName;
    writeJson(connectionsPath, nextConfig);

    const verification = args["skip-verify"] ? { skipped: true } : await verifyDaemonToken(daemonUrl, clientId, token);
    const action = needsAdminUpdate
      ? "promoted-existing-token"
      : existing && !replace
        ? "reused-existing-token"
        : (existing ? "rotated-token" : "created-token");
    printJson(withTarget({
      ok: true,
      action,
      clientId,
      daemonName,
      daemonUrl,
      connectionsPath,
      default: nextConfig.default || null,
      tokenMasked: mask(token),
      tokenStoredLocally: true,
      remoteWrite,
      verification,
      reloadHint: verification.ok ? null : "If verification is unauthorized, reload the remote daemon config or run provision through an admin daemon route.",
    }, ctx));
  });
}

async function commandClient(args) {
  const subcommand = (args._[1] || "help").toLowerCase();
  switch (subcommand) {
    case "provision":
    case "setup":
      await commandClientProvision(args);
      break;
    default:
      throw new Error("Usage: node cli.js client provision --client-id <client-id> --connection <name> [--daemon-name name] [--daemon-url url] [--local-dir path]");
  }
}

async function commandTokenList(args) {
  await withConnection(defaultTokenArgs(args), async (ctx) => {
    const { envPath, authTokens, adminTokens } = await readTokenEnv(ctx, args);
    const tokens = [...authTokens.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([clientId, token]) => ({
        clientId,
        token: mask(token),
        admin: adminTokens.has(token),
      }));
    printJson(withTarget({
      ok: true,
      mode: ctx.type,
      route: ctx.type,
      envPath,
      count: tokens.length,
      adminTokenCount: adminTokens.size,
      tokens,
    }, ctx));
  });
}

async function commandTokenAdd(args) {
  const clientId = normalizeClientId(args["client-id"] || args.clientId || args._[2]);
  const wantsAdmin = Boolean(args.admin);
  const rawToken = typeof args.token === "string" ? args.token.trim() : "";
  const token = rawToken || generateAuthToken(clientId);
  if (!token) throw new Error(addTokenUsage());

  await withConnection({ ...defaultTokenArgs(args), requireExplicitConnection: true }, async (ctx) => {
    const state = await readTokenEnv(ctx, args);
    const existing = tokenValueByClient(state.authTokens, clientId);
    if (existing && !args.replace && !args.force) {
      throw new Error(`clientId '${clientId}' already exists. Use --replace to rotate token or run token revoke first.`);
    }
    state.authTokens.set(clientId, token);
    if (wantsAdmin) state.adminTokens.add(token);
    setEnvValue(state.doc, "AUTH_TOKENS", serializeAuthTokenMap(state.authTokens));
    setEnvValue(state.doc, "ADMIN_TOKENS", serializeAdminTokenSet(state.adminTokens));
    await writeTokenEnv(ctx, state.envPath, state.doc, [token, existing]);

    printJson(withTarget({
      ok: true,
      mode: ctx.type,
      route: ctx.type,
      envPath: state.envPath,
      clientId,
      token,
      tokenMasked: mask(token),
      admin: wantsAdmin,
      replaced: Boolean(existing),
      previousTokenMasked: existing ? mask(existing) : null,
    }, ctx));
  });
}

async function commandTokenRevoke(args) {
  const clientId = normalizeClientId(args["client-id"] || args.clientId || args._[2]);
  const removeAdmin = Boolean(args.admin || args["remove-admin"]);

  await withConnection({ ...defaultTokenArgs(args), requireExplicitConnection: true }, async (ctx) => {
    const state = await readTokenEnv(ctx, args);
    const removedToken = state.authTokens.get(clientId);
    if (!removedToken) {
      throw new Error(`clientId '${clientId}' was not found in AUTH_TOKENS.`);
    }
    state.authTokens.delete(clientId);
    const adminRemoved = removeAdmin ? state.adminTokens.delete(removedToken) : false;
    setEnvValue(state.doc, "AUTH_TOKENS", serializeAuthTokenMap(state.authTokens));
    setEnvValue(state.doc, "ADMIN_TOKENS", serializeAdminTokenSet(state.adminTokens));
    await writeTokenEnv(ctx, state.envPath, state.doc, [removedToken]);

    printJson(withTarget({
      ok: true,
      mode: ctx.type,
      route: ctx.type,
      envPath: state.envPath,
      clientId,
      removed: true,
      removedToken: mask(removedToken),
      adminRemoved,
    }, ctx));
  });
}

async function commandTokenDashboardUrl(args) {
  await withConnection(defaultTokenArgs(args), async (ctx) => {
    const state = await readTokenEnv(ctx, args);
    const clientId = args["client-id"] || args.clientId || args._[2];
    let adminToken = "";

    if (clientId) {
      const normalizedClientId = normalizeClientId(clientId);
      const token = state.authTokens.get(normalizedClientId);
      if (!token) throw new Error(`clientId '${normalizedClientId}' was not found in AUTH_TOKENS.`);
      if (!state.adminTokens.has(token)) {
        throw new Error(`Token for clientId '${normalizedClientId}' is not in ADMIN_TOKENS. Use 'token add --admin' or 'token revoke --admin' workflow.`);
      }
      adminToken = token;
    } else {
      adminToken = [...state.adminTokens.values()][0] || "";
      if (!adminToken) throw new Error("No ADMIN_TOKENS found in remote env.");
    }

    let baseUrl = args.url || args["base-url"] || "";
    if (!baseUrl) {
      if (ctx.conn.url) {
        baseUrl = normalizeBaseUrl(ctx.conn.url);
      } else if (ctx.conn.host) {
        baseUrl = `http://${ctx.conn.host}:${state.port || 3183}`;
      } else {
        throw new Error("Cannot infer daemon URL from current connection. Use --base-url http://host:port.");
      }
    }
    baseUrl = normalizeBaseUrl(baseUrl);
    const tokenParam = encodeURIComponent(adminToken);
    const rootUrl = `${baseUrl}/?token=${tokenParam}`;
    const dashboardUrl = `${baseUrl}/dashboard?token=${tokenParam}`;

    printJson(withTarget({
      ok: true,
      mode: ctx.type,
      route: ctx.type,
      envPath: state.envPath,
      baseUrl,
      tokenMasked: mask(adminToken),
      rootUrl,
      dashboardUrl,
    }, ctx));
  });
}

async function commandToken(args) {
  const subcommand = (args._[1] || "help").toLowerCase();
  switch (subcommand) {
    case "list":
    case "ls":
      await commandTokenList(args);
      break;
    case "add":
    case "create":
      await commandTokenAdd(args);
      break;
    case "revoke":
    case "rm":
    case "remove":
    case "delete":
      await commandTokenRevoke(args);
      break;
    case "dashboard-url":
    case "dashboard":
    case "url":
      await commandTokenDashboardUrl(args);
      break;
    default:
      throw new Error("Usage: node cli.js token <list|add|revoke|dashboard-url> [options]");
  }
}

function listArg(value, fallback) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return fallback;
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function isTransportError(error) {
  const text = String(error?.message || error || "");
  return /Transport closed|ECONNRESET|EPIPE|ETIMEDOUT|ECONNABORTED|socket hang up|connect ECONNREFUSED/i.test(text);
}

function sshJobRootPath() {
  return "~/.agentport/cli-jobs";
}

function normalizeJobId(text) {
  return String(text || "").trim();
}

function sanitizeKey(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9._-]/g, "_");
}

function randomJobId(prefix = "ssh") {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${rand}`;
}

function normalizeTraceName(value) {
  const raw = String(value || "ssh-link").trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
  return cleaned || "ssh-link";
}

function traceKey(name) {
  return `trace-${sanitizeKey(name)}`;
}

function buildTraceCommand(name, intervalInput) {
  const safeName = normalizeTraceName(name);
  const intervalSeconds = positiveInt(intervalInput, 5, 1, 300);
  const script = [
    "set +e",
    'TRACE_DIR="$HOME/.agentport/trace"',
    'mkdir -p "$TRACE_DIR"',
    `TRACE_FILE="$TRACE_DIR/${safeName}.log"`,
    `echo "=== trace start $(date -Is) host=$(hostname) interval=${intervalSeconds}s ===" >> "$TRACE_FILE"`,
    `while true; do`,
    "  TS=$(date -Is)",
    "  ESTAB=$(ss -tan state established '( sport = :22 )' 2>/dev/null | tail -n +2 | wc -l | tr -d ' ')",
    "  SYNRECV=$(ss -tan state syn-recv 2>/dev/null | tail -n +2 | wc -l | tr -d ' ')",
    "  TIMEWAIT=$(ss -tan state time-wait 2>/dev/null | tail -n +2 | wc -l | tr -d ' ')",
    "  USERS=$(who 2>/dev/null | wc -l | tr -d ' ')",
    "  LOAD=$(cut -d ' ' -f1-3 /proc/loadavg 2>/dev/null | xargs || echo na)",
    '  echo "$TS estab_22=$ESTAB synrecv=$SYNRECV timewait=$TIMEWAIT users=$USERS load=$LOAD" >> "$TRACE_FILE"',
    `  sleep ${intervalSeconds}`,
    "done",
    "",
  ].join("\n");
  return { safeName, intervalSeconds, script };
}

async function readTraceJobRef(ssh, traceName) {
  const name = normalizeTraceName(traceName);
  const keyName = traceKey(name);
  const keyPath = await ssh.resolveRemotePath(`${sshJobRootPath()}/keys/${keyName}.job`);
  const exists = await ssh.exists(keyPath);
  if (!exists) {
    return { name, keyName, keyPath, jobId: null };
  }
  const jobId = normalizeJobId(await ssh.readFile(keyPath));
  return { name, keyName, keyPath, jobId: jobId || null };
}

function positiveInt(value, fallback, min = 1, max = 5000) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function buildSshGrepCommand(args) {
  const pattern = args.pattern || args._[1];
  const include = listArg(args.include, ["*"]);
  const excludeDirs = listArg(args.excludeDirs || args["exclude-dir"], [
    "node_modules", ".git", "dist", "build", ".next", ".nuxt", ".cache", ".venv", "venv", "__pycache__",
  ]);
  const maxResults = positiveInt(args.maxResults || args["max-results"], 200, 1, 5000);
  const flags = ["-RIn", "--binary-files=without-match"];
  if (!args.caseSensitive && !args["case-sensitive"]) flags.push("-i");
  if (!args.regex) flags.push("-F");
  for (const item of include) flags.push(`--include=${JSON.stringify(item)}`);
  for (const dir of excludeDirs) flags.push(`--exclude-dir=${JSON.stringify(dir)}`);
  const command = `grep ${flags.join(" ")} -- ${JSON.stringify(pattern)} . 2>/dev/null | head -n ${maxResults} || true`;
  return {
    command: args.cwd ? `cd ${JSON.stringify(args.cwd)} && ${command}` : command,
    maxResults,
  };
}

function parseGrepOutput(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const first = line.indexOf(":");
      const second = first >= 0 ? line.indexOf(":", first + 1) : -1;
      if (first < 0 || second < 0) return { path: line, line: null, text: "" };
      return {
        path: line.slice(0, first).replace(/^\.\//, ""),
        line: Number.parseInt(line.slice(first + 1, second), 10) || null,
        text: line.slice(second + 1),
      };
    });
}

function daemonClient(conn) {
  return axios.create({
    baseURL: conn.url,
    timeout: Number(conn.timeoutMs || TIMEOUT_MS),
    httpAgent: HTTP_AGENT,
    httpsAgent: HTTPS_AGENT,
    headers: {
      Authorization: `Bearer ${conn.authToken}`,
      "X-Client-ID": conn.clientId || "agentport-cli",
      "Content-Type": "application/json",
    },
  });
}

async function postWithFallback(client, paths, payload, { retryNetwork = true } = {}) {
  let lastError;
  for (const route of paths) {
    try {
      const response = await client.post(route, payload);
      return response.data;
    } catch (error) {
      lastError = error;
      if (retryNetwork && !error?.response && ["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNABORTED"].includes(error?.code)) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        try {
          const response = await client.post(route, payload);
          return response.data;
        } catch (retryError) {
          lastError = retryError;
        }
      }
      if (![404, 405].includes(error?.response?.status)) break;
    }
  }
  const status = lastError?.response?.status;
  const remoteMessage = lastError?.response?.data?.error || lastError?.response?.data?.message;
  throw new Error(remoteMessage || lastError?.message || `Request failed${status ? ` (${status})` : ""}`);
}

function pathWithQuery(route, query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === false) continue;
    params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix ? `${route}?${suffix}` : route;
}

async function getWithFallback(client, paths, query = {}) {
  let lastError;
  for (const route of paths) {
    try {
      const response = await client.get(pathWithQuery(route, query));
      return response.data;
    } catch (error) {
      lastError = error;
      if (!error?.response && ["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNABORTED"].includes(error?.code)) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        try {
          const response = await client.get(pathWithQuery(route, query));
          return response.data;
        } catch (retryError) {
          lastError = retryError;
        }
      }
      if (![404, 405].includes(error?.response?.status)) break;
    }
  }
  const status = lastError?.response?.status;
  const remoteMessage = lastError?.response?.data?.error || lastError?.response?.data?.message;
  throw new Error(remoteMessage || lastError?.message || `Request failed${status ? ` (${status})` : ""}`);
}

async function withConnection(options, fn) {
  const conn = selectConnection(options);
  if ((conn.type || "daemon") === "ssh") {
    const client = new SSHClient(cliSshConfig(conn, options));
    const target = connectionTarget(conn, "ssh");
    try {
      return await fn({ type: "ssh", conn, ssh: client, target });
    } finally {
      client.disconnect();
    }
  }
  const daemonCtx = { type: "daemon", conn, http: daemonClient(conn), target: connectionTarget(conn, "daemon") };
  try {
    return await fn(daemonCtx);
  } catch (error) {
    const route = String(options.route || "auto").toLowerCase();
    const canFallback = route !== "daemon" && isTransportError(error);
    if (!canFallback) throw error;

    const sshConn = fallbackSshConnection(conn, options);
    if (!sshConn) throw error;

    const sshClient = new SSHClient(cliSshConfig(sshConn, options));
    const target = connectionTarget(sshConn, "ssh");
    try {
      return await fn({
        type: "ssh",
        conn: sshConn,
        ssh: sshClient,
        target,
        fallbackFrom: "daemon",
        fallbackReason: String(error?.message || error),
      });
    } finally {
      sshClient.disconnect();
    }
  }
}

async function checkDaemon(conn) {
  const client = daemonClient(conn);
  const started = Date.now();
  const response = await client.get("/healthz");
  return {
    ok: true,
    type: "daemon",
    name: conn.name,
    url: conn.url,
    latencyMs: Date.now() - started,
    data: response.data,
  };
}

async function checkSsh(conn, args = {}) {
  const client = new SSHClient(cliSshConfig(conn, args));
  const started = Date.now();
  try {
    const result = await client.exec("printf '%s' \"$USER@$HOSTNAME:$PWD\"");
    return {
      ok: true,
      type: "ssh",
      name: conn.name,
      host: conn.host,
      port: conn.port || 22,
      username: conn.username,
      latencyMs: Date.now() - started,
      data: result.stdout,
    };
  } finally {
    client.disconnect();
  }
}

async function commandList() {
  const { connections, defaultName } = loadConnections();
  printJson({
    default: defaultName || null,
    current: getState().current || null,
    connections: connections.map((conn) => ({
      name: conn.name,
      type: conn.type || "daemon",
      description: conn.description,
      url: conn.url,
      host: conn.host,
      port: conn.port,
      username: conn.username,
      clientId: conn.clientId,
      authToken: conn.authToken ? mask(conn.authToken) : undefined,
      password: conn.password ? "***" : undefined,
      privateKey: conn.privateKey,
    })),
  });
}

async function commandConnect(args) {
  const name = args._[1] || args.connection;
  const { byName } = loadConnections();
  if (!name) {
    await commandList();
    return;
  }
  if (!byName.has(name)) {
    throw new Error(`Connection '${name}' not found. Run: node cli.js list`);
  }
  setCurrentConnection(name);
  printJson({ ok: true, current: name, type: byName.get(name).type || "daemon" });
}

async function commandHealth(args) {
  const conn = selectConnection(args);
  const result = (conn.type || "daemon") === "ssh" ? await checkSsh(conn) : await checkDaemon(conn);
  result.route = (conn.type || "daemon") === "ssh" ? "ssh" : "daemon";
  printJson(result);
}

async function commandSshHealth(args) {
  const conn = selectConnection({ ...args, route: "ssh" });
  const result = await checkSsh(conn);
  result.route = "ssh";
  result.recommendedOrder = ["ssh-first", "daemon-job", "native-mcp"];
  printJson(result);
}

async function commandStatus(args) {
  const conn = selectConnection(args);
  const result = {
    connection: {
      name: conn.name,
      type: conn.type || "daemon",
      target: (conn.type || "daemon") === "ssh" ? `${conn.username}@${conn.host}:${conn.port || 22}` : conn.url,
    },
    nativeMcp: {
      role: "convenience entrypoint",
      fallback: "If native remote_* tools return Transport closed, keep working with this CLI.",
    },
    recommendedOrder: ["ssh-first", "daemon-job", "native-mcp"],
  };

  if ((conn.type || "daemon") === "ssh") {
    result.health = await checkSsh(conn);
    result.capabilities = {
      read: true,
      write: true,
      bash: true,
      jobs: true,
      jobLogs: true,
      jobCancel: true,
      config: false,
    };
    result.note = "SSH route now supports lightweight persistent jobs for transport recovery.";
    printJson(result);
    return;
  }

  const client = daemonClient(conn);
  result.health = await checkDaemon(conn);
  try {
    const jobs = await getWithFallback(client, ["/api/jobs"], { limit: 1 });
    result.capabilities = {
      read: true,
      write: true,
      bash: true,
      jobs: true,
      jobLogs: true,
      jobCancel: true,
      config: true,
    };
    result.jobsProbe = {
      ok: true,
      count: jobs.count ?? jobs.jobs?.length ?? 0,
    };
  } catch (error) {
    result.capabilities = {
      read: true,
      write: true,
      bash: true,
      jobs: false,
      legacyAsync: true,
      config: true,
    };
    result.jobsProbe = {
      ok: false,
      error: error.message,
    };
  }
  printJson(result);
}

async function commandDoctor() {
  const { connections, defaultName } = loadConnections();
  const results = [];
  for (const conn of connections) {
    try {
      results.push((conn.type || "daemon") === "ssh" ? await checkSsh(conn) : await checkDaemon(conn));
    } catch (error) {
      results.push({
        ok: false,
        type: conn.type || "daemon",
        name: conn.name,
        target: conn.url || `${conn.username || "root"}@${conn.host}:${conn.port || 22}`,
        error: error.message,
      });
    }
  }
  printJson({
    ok: results.some((item) => item.ok),
    nativeMcpPriority: "Native remote_* MCP tools are convenient, but this CLI is the stable fallback when stdio transport closes.",
    cli: { available: true, node: process.version, cwd: __dirname },
    config: { path: CONNECTIONS_PATH, default: defaultName || null, current: getState().current || null },
    recommendedOrder: ["ssh-first", "daemon-job", "native-mcp", "http-curl", "manual"],
    transportPolicy: "When native MCP returns Transport closed, switch to SSH route first. Use daemon jobs for persistent tasks.",
    results,
  });
}

function fallbackSshConnection(primaryConn, options = {}) {
  const { connections, byName } = loadConnections();
  const explicit = options.connection || process.env.MCP_REMOTE_CONNECTION || process.env.NIUMA_SSH_CONNECTION;
  const primaryName = primaryConn?.name || "";
  const baseName = primaryName.endsWith("-agentport-daemon")
    ? primaryName.slice(0, -"-agentport-daemon".length)
    : primaryName;

  if (explicit && byName.has(explicit)) {
    const selected = byName.get(explicit);
    if ((selected.type || "daemon") === "ssh") return selected;
  }

  if (baseName && byName.has(baseName)) {
    const paired = byName.get(baseName);
    if ((paired.type || "daemon") === "ssh") return paired;
  }

  return connections.find((conn) => (conn.type || "daemon") === "ssh") || null;
}

async function commandRead(args) {
  const targetPath = args._[1] || args.path;
  if (!targetPath) throw new Error("Usage: node cli.js read <remote-path> [--connection name]");
  await withConnection(args, async (ctx) => {
    const { type, http, ssh } = ctx;
    if (type === "ssh") {
      const content = await ssh.readFile(targetPath);
      if (args.json) {
        printJson(withTarget({ ok: true, mode: "ssh", path: targetPath, content }, ctx));
        return;
      }
      print(content);
      return;
    }
    const data = await postWithFallback(http, ["/api/fs/read", "/read"], { path: targetPath });
    if (args.json) {
      printJson(withTarget({ ok: true, mode: "daemon", path: targetPath, etag: data.etag, content: data.content ?? "" }, ctx));
      return;
    }
    print(data.content ?? "");
  });
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve, reject) => {
    let content = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { content += chunk; });
    process.stdin.on("end", () => resolve(content));
    process.stdin.on("error", reject);
  });
}

async function commandWrite(args) {
  const targetPath = args._[1] || args.path;
  if (!targetPath) throw new Error("Usage: node cli.js write <remote-path> (--content text | --file local-file | stdin)");
  let content = "";
  if (typeof args.content === "string") {
    content = args.content;
  } else if (typeof args.file === "string") {
    content = fs.readFileSync(args.file, "utf8");
  } else {
    content = await readStdin();
  }
  content = sanitizeContent(content);
  await withConnection({ ...args, requireExplicitConnection: true }, async (ctx) => {
    const { type, http, ssh } = ctx;
    if (type === "ssh") {
      await ssh.writeFile(targetPath, content);
      printJson(withTarget({ ok: true, path: targetPath, mode: "ssh" }, ctx));
      return;
    }
    const data = await postWithFallback(http, ["/api/fs/write", "/write"], {
      path: targetPath,
      content,
      expectedEtag: typeof args.expectedEtag === "string" ? args.expectedEtag : undefined,
    });
    printJson(withTarget({ ok: true, path: targetPath, mode: "daemon", etag: data.etag }, ctx));
  });
}

async function commandSafeWrite(args) {
  const targetPath = args._[1] || args.path;
  if (!targetPath) throw new Error("Usage: node cli.js safe-write <remote-path> --file <local-file> [--verify readback|none]");
  if (typeof args.content === "string") {
    throw new Error("safe-write does not accept --content. Put the payload in a UTF-8 file and pass --file <local-file>.");
  }

  const sourceFile = args.file || args.from || args._[2];
  const normalizeLf = Boolean(args.normalizeLf || args["normalize-lf"]);
  const content = readUtf8PayloadFile(sourceFile, { normalizeLf });
  const expectedSha256 = sha256Text(content);
  const payload = {
    ok: true,
    command: "safe-write",
    path: targetPath,
    sourceFile: path.resolve(sourceFile),
    bytes: utf8Bytes(content),
    sha256: expectedSha256,
    normalizeLf,
  };

  if (args.dryRun || args["dry-run"]) {
    printJson({ ...payload, dryRun: true, verified: false });
    return;
  }

  await withConnection({ ...args, requireExplicitConnection: true }, async (ctx) => {
    const { type, http, ssh } = ctx;
    let writeResult = {};
    if (type === "ssh") {
      await ssh.writeFile(targetPath, content);
      writeResult = { mode: "ssh" };
    } else {
      const data = await postWithFallback(http, ["/api/fs/write", "/write"], {
        path: targetPath,
        content,
        expectedEtag: typeof args.expectedEtag === "string" ? args.expectedEtag : undefined,
      });
      writeResult = { mode: "daemon", etag: data.etag };
    }

    const verification = shouldVerifyReadback(args)
      ? await verifyRemoteContent(ctx, targetPath, expectedSha256)
      : { skipped: true };

    printJson(withTarget({
      ...payload,
      ...writeResult,
      verified: !verification.skipped,
      verification,
    }, ctx));
  });
}

async function commandStat(args) {
  const targetPath = args._[1] || args.path;
  if (!targetPath) throw new Error("Usage: node cli.js stat <remote-path>");
  await withConnection(args, async ({ type, http, ssh }) => {
    if (type === "ssh") {
      printJson(await ssh.stat(targetPath));
      return;
    }
    const data = await postWithFallback(http, ["/api/batch"], { operations: [{ type: "stat", path: targetPath }] });
    const result = data.results?.[0] || data;
    printJson(result);
    applyOperationExitCode(result);
  });
}

async function commandGlob(args) {
  const pattern = args._[1] || args.pattern;
  if (!pattern) throw new Error("Usage: node cli.js glob <pattern> [--cwd path]");
  await withConnection(args, async ({ type, http, ssh }) => {
    if (type === "ssh") {
      printJson(await ssh.glob(pattern, args.cwd));
      return;
    }
    const data = await postWithFallback(http, ["/api/fs/glob", "/glob"], {
      pattern,
      cwd: args.cwd,
      basePath: args.cwd,
    });
    printJson(data.entries || data.files || data);
  });
}

async function commandGrep(args) {
  const pattern = args._[1] || args.pattern;
  if (!pattern) throw new Error("Usage: node cli.js grep <pattern> [--cwd path] [--include \"*.js,*.ts\"] [--regex] [--case-sensitive]");
  await withConnection(args, async ({ type, http, ssh }) => {
    if (type === "ssh") {
      const safeCwd = ssh.resolveWorkspaceCwd(args.cwd);
      const { command, maxResults } = buildSshGrepCommand({ ...args, pattern, cwd: safeCwd || args.cwd });
      const result = await ssh.exec(command);
      const matches = parseGrepOutput(result.stdout);
      printJson({
        success: true,
        engine: "grep",
        pattern,
        cwd: safeCwd || args.cwd || ".",
        maxResults,
        matches,
        truncated: matches.length >= maxResults,
        stderr: result.stderr || undefined,
      });
      return;
    }
    const data = await postWithFallback(http, ["/api/fs/grep", "/grep"], {
      pattern,
      cwd: args.cwd,
      include: listArg(args.include, undefined),
      excludeDirs: listArg(args.excludeDirs || args["exclude-dir"], undefined),
      maxResults: args.maxResults || args["max-results"],
      maxFileBytes: args.maxFileBytes || args["max-file-bytes"],
      caseSensitive: Boolean(args.caseSensitive || args["case-sensitive"]),
      regex: Boolean(args.regex),
    });
    printJson(data);
  });
}

async function commandBash(args) {
  const command = args._.slice(1).join(" ") || args.command;
  if (!command) throw new Error("Usage: node cli.js bash <command> [--cwd path]");
  await withConnection({ ...args, requireExplicitConnection: true }, async (ctx) => {
    const { type, http, ssh } = ctx;
    const data = type === "ssh"
      ? await ssh.exec(command, { cwd: args.cwd })
      : await postWithFallback(http, ["/api/exec", "/bash", "/api/cmd/execute"], { command, cwd: args.cwd });
    applyOperationExitCode(data);
    if (args.json) {
      printJson(withTarget({ mode: type, command, cwd: args.cwd || null, ...data, ok: operationExitCode(data) === 0 }, ctx));
      return;
    }
    if (data.stdout) print(data.stdout.replace(/\s+$/, ""));
    if (data.stderr) process.stderr.write(`${data.stderr.replace(/\s+$/, "")}\n`);
    if (typeof data.code === "number" && data.code !== 0) process.exitCode = data.code;
  });
}

async function buildSshJobContext(ssh, jobId) {
  const root = await ssh.resolveRemotePath(sshJobRootPath());
  return {
    root,
    jobId: normalizeJobId(jobId),
    jobDir: `${root}/${normalizeJobId(jobId)}`,
    keysDir: `${root}/keys`,
  };
}

async function readRemoteOptional(ssh, filePath) {
  try {
    return await ssh.readFile(filePath);
  } catch {
    return null;
  }
}

function parseJsonOptional(raw) {
  const text = String(raw || "").trim().replace(/^\uFEFF/, "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readSshJobStatus(ssh, jobId) {
  const ctx = await buildSshJobContext(ssh, jobId);
  const exists = await ssh.exists(ctx.jobDir);
  if (!exists) {
    return { ok: false, mode: "ssh", route: "ssh", jobId: ctx.jobId, status: "not_found", error: "job not found" };
  }

  const pidRaw = await readRemoteOptional(ssh, `${ctx.jobDir}/pid`);
  const exitRaw = await readRemoteOptional(ssh, `${ctx.jobDir}/exit_code`);
  const canceledAtRaw = await readRemoteOptional(ssh, `${ctx.jobDir}/canceled_at`);
  const startedAtRaw = await readRemoteOptional(ssh, `${ctx.jobDir}/started_at`);
  const finishedAtRaw = await readRemoteOptional(ssh, `${ctx.jobDir}/finished_at`);
  const commandRaw = await readRemoteOptional(ssh, `${ctx.jobDir}/command.txt`);
  const cwdRaw = await readRemoteOptional(ssh, `${ctx.jobDir}/cwd.txt`);
  const connectionRaw = await readRemoteOptional(ssh, `${ctx.jobDir}/connection.json`);

  const pid = normalizeJobId(pidRaw);
  const exitCodeText = normalizeJobId(exitRaw);
  let running = false;
  if (pid) {
    const probe = await ssh.exec(`if kill -0 ${shellSingleQuote(pid)} 2>/dev/null; then echo running; else echo stopped; fi`);
    running = probe.stdout.trim() === "running";
  }

  let status = "unknown";
  if (running) status = "running";
  else if (normalizeJobId(canceledAtRaw)) status = "canceled";
  else if (exitCodeText !== "") status = Number(exitCodeText) === 0 ? "completed" : "failed";

  return {
    ok: true,
    mode: "ssh",
    route: "ssh",
    jobId: ctx.jobId,
    status,
    pid: pid || null,
    target: parseJsonOptional(connectionRaw),
    exitCode: exitCodeText === "" ? null : Number(exitCodeText),
    canceledAt: normalizeJobId(canceledAtRaw) || null,
    startedAt: normalizeJobId(startedAtRaw) || null,
    finishedAt: normalizeJobId(finishedAtRaw) || null,
    cwd: normalizeJobId(cwdRaw) || null,
    command: commandRaw ? commandRaw.trimEnd() : null,
    paths: {
      jobDir: ctx.jobDir,
      stdout: `${ctx.jobDir}/stdout.log`,
      stderr: `${ctx.jobDir}/stderr.log`,
    },
  };
}

async function listSshJobIds(ssh, limit = 20) {
  const root = await ssh.resolveRemotePath(sshJobRootPath());
  await ssh.exec(`mkdir -p ${JSON.stringify(root)}`);
  const safeRoot = shellSingleQuote(root);
  const safeLimit = Math.max(1, Number(limit) || 20);
  const listCmd = `if [ -d ${safeRoot} ]; then for d in ${safeRoot}/*; do [ -d "$d" ] || continue; b=$(basename "$d"); [ "$b" = "keys" ] && continue; echo "$b"; done | sort | tail -n ${safeLimit}; fi`;
  const result = await ssh.exec(listCmd);
  return result.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

async function startJob(ctx, command, args = {}) {
  const { type, http, ssh } = ctx;
    if (type === "ssh") {
      const root = await ssh.resolveRemotePath(sshJobRootPath());
      const keysDir = `${root}/keys`;
      await ssh.exec(`mkdir -p ${JSON.stringify(root)} ${JSON.stringify(keysDir)}`);

      const key = args.key ? sanitizeKey(args.key) : "";
      if (key) {
        const keyFile = `${keysDir}/${key}.job`;
        if (await ssh.exists(keyFile)) {
          const existingJobId = normalizeJobId(await ssh.readFile(keyFile));
          if (existingJobId) {
            const existing = await readSshJobStatus(ssh, existingJobId);
            return { ...existing, reused: true, key };
          }
        }
      }

      const jobId = randomJobId("ssh");
      const jobCtx = await buildSshJobContext(ssh, jobId);
      await ssh.exec(`mkdir -p ${JSON.stringify(jobCtx.jobDir)}`);

      const runCommand = args.cwd
        ? `cd ${JSON.stringify(args.cwd)} && ${command}`
        : command;

      const runnerPath = `${jobCtx.jobDir}/runner.sh`;
      const runnerScript = [
        "#!/usr/bin/env bash",
        "set +e",
        `bash -lc ${JSON.stringify(runCommand)} > ${JSON.stringify(`${jobCtx.jobDir}/stdout.log`)} 2> ${JSON.stringify(`${jobCtx.jobDir}/stderr.log`)}`,
        "code=$?",
        `printf '%s' \"$code\" > ${JSON.stringify(`${jobCtx.jobDir}/exit_code`)}`,
        `date -Is > ${JSON.stringify(`${jobCtx.jobDir}/finished_at`)}`,
      ].join("\n") + "\n";

      await ssh.writeFile(`${jobCtx.jobDir}/command.txt`, command.endsWith("\n") ? command : `${command}\n`);
      if (args.cwd) await ssh.writeFile(`${jobCtx.jobDir}/cwd.txt`, `${args.cwd}\n`);
      await ssh.writeFile(`${jobCtx.jobDir}/started_at`, `${new Date().toISOString()}\n`);
      await ssh.writeFile(`${jobCtx.jobDir}/connection.json`, `${JSON.stringify(ctx.target, null, 2)}\n`);
      await ssh.writeFile(runnerPath, runnerScript);
      await ssh.exec(`chmod +x ${JSON.stringify(runnerPath)}`);

      const launch = await ssh.exec(`nohup ${JSON.stringify(runnerPath)} >/dev/null 2>&1 & echo $!`);
      const pid = normalizeJobId(launch.stdout);
      if (pid) await ssh.writeFile(`${jobCtx.jobDir}/pid`, `${pid}\n`);
      if (key) {
        await ssh.writeFile(`${jobCtx.keysDir}/${key}.job`, `${jobId}\n`);
      }

      const created = await readSshJobStatus(ssh, jobId);
      return { ...created, key: key || undefined };
    }
  const timeoutMs = jobTimeoutMs(args, args.defaultJobTimeoutMs);
  const body = {
    command,
    cwd: args.cwd,
    connection: ctx.target,
  };
  if (timeoutMs !== undefined) body.timeoutMs = timeoutMs;
  const data = await postWithFallback(
    http,
    ["/api/jobs", "/api/jobs/start", "/api/exec/async"],
    body,
    { retryNetwork: false },
  );
  return withTarget(data, ctx);
}

async function commandJobStart(args) {
  const command = args.command || args._.slice(2).join(" ");
  if (!command) throw new Error("Usage: node cli.js job start <command> [--cwd path]");
  await withConnection({ ...args, requireExplicitConnection: true }, async (ctx) => {
    printJson(await startJob(ctx, command, args));
  });
}

async function commandJobStatus(args) {
  const jobId = args._[2] || args.jobId || args.id;
  if (!jobId) throw new Error("Usage: node cli.js job status <job-id>");
  await withConnection({ ...args, requireExplicitConnection: true }, async (ctx) => {
    const { type, http, ssh } = ctx;
    if (type === "ssh") {
      printJson(await readSshJobStatus(ssh, jobId));
      return;
    }
    const data = await getWithFallback(http, [`/api/jobs/${encodeURIComponent(jobId)}`, `/api/task/${encodeURIComponent(jobId)}`]);
    printJson(withTarget(data, ctx));
  });
}

async function commandJobLogs(args) {
  const jobId = args._[2] || args.jobId || args.id;
  if (!jobId) throw new Error("Usage: node cli.js job logs <job-id> [--tail 200]");
  const tailLines = positiveInt(args.tail || args.lines, 200, 1, 10000);
  const tailBytes = positiveInt(args.tailBytes || args.bytes, 64 * 1024, 1024, 5 * 1024 * 1024);
  await withConnection({ ...args, requireExplicitConnection: true }, async (ctx) => {
    const { type, http, ssh } = ctx;
    if (type === "ssh") {
      const jobCtx = await buildSshJobContext(ssh, jobId);
      const stat = await readSshJobStatus(ssh, jobId);
      if (!stat.ok) {
        printJson(stat);
        process.exitCode = 2;
        return;
      }
      const stdout = (await readRemoteOptional(ssh, `${jobCtx.jobDir}/stdout.log`)) || "";
      const stderr = (await readRemoteOptional(ssh, `${jobCtx.jobDir}/stderr.log`)) || "";
      const trimLines = (text) => text.split(/\r?\n/).slice(-tailLines).join("\n");
      const payload = {
        ok: true,
        mode: "ssh",
        route: "ssh",
        jobId,
        target: stat.target || ctx.target,
        connection: (stat.target || ctx.target).connection,
        status: stat.status,
        stdout: { content: trimLines(stdout), bytes: Buffer.byteLength(stdout, "utf8") },
        stderr: { content: trimLines(stderr), bytes: Buffer.byteLength(stderr, "utf8") },
      };
      if (args.json) {
        printJson(payload);
      } else {
        const out = [
          payload.stdout.content ? `--- stdout ---\n${payload.stdout.content}` : "",
          payload.stderr.content ? `--- stderr ---\n${payload.stderr.content}` : "",
        ].filter(Boolean).join("\n");
        print(out);
      }
      return;
    }
    try {
      const data = await getWithFallback(http, [`/api/jobs/${encodeURIComponent(jobId)}/logs`], { tailBytes });
      if (args.json) {
        printJson(withTarget(data, ctx));
        return;
      }
      const stdout = data.stdout?.content || "";
      const stderr = data.stderr?.content || "";
      const combined = [
        stdout ? `--- stdout ---\n${stdout}` : "",
        stderr ? `--- stderr ---\n${stderr}` : "",
      ].filter(Boolean).join("\n");
      print(combined.split(/\r?\n/).slice(-tailLines).join("\n"));
    } catch (error) {
      const data = await getWithFallback(http, [`/api/task/${encodeURIComponent(jobId)}`]);
      if (args.json) {
        printJson(withTarget(data, ctx));
        return;
      }
      const combined = [
        data.stdout ? `--- stdout ---\n${data.stdout}` : "",
        data.stderr ? `--- stderr ---\n${data.stderr}` : "",
      ].filter(Boolean).join("\n");
      print(combined.split(/\r?\n/).slice(-tailLines).join("\n"));
    }
  });
}

async function commandJobCancel(args) {
  const jobId = args._[2] || args.jobId || args.id;
  if (!jobId) throw new Error("Usage: node cli.js job cancel <job-id>");
  await withConnection({ ...args, requireExplicitConnection: true }, async (ctx) => {
    const { type, http, ssh } = ctx;
    if (type === "ssh") {
      const jobCtx = await buildSshJobContext(ssh, jobId);
      const stat = await readSshJobStatus(ssh, jobId);
      if (!stat.ok) {
        printJson(stat);
        process.exitCode = 2;
        return;
      }
      if (!stat.pid) {
        printJson({ ok: false, mode: "ssh", route: "ssh", jobId, canceled: false, message: "Job has no active pid." });
        process.exitCode = 2;
        return;
      }
      await ssh.exec(`if kill -0 ${shellSingleQuote(stat.pid)} 2>/dev/null; then kill ${shellSingleQuote(stat.pid)} 2>/dev/null || true; fi`);
      await ssh.writeFile(`${jobCtx.jobDir}/finished_at`, `${new Date().toISOString()}\n`);
      await ssh.writeFile(`${jobCtx.jobDir}/canceled_at`, `${new Date().toISOString()}\n`);
      const updated = await readSshJobStatus(ssh, jobId);
      printJson({ ...updated, canceled: true });
      return;
    }
    const data = await postWithFallback(http, [`/api/jobs/${encodeURIComponent(jobId)}/cancel`], {});
    printJson(withTarget(data, ctx));
  });
}

async function commandJobList(args) {
  await withConnection({ ...args, requireExplicitConnection: true }, async (ctx) => {
    const { type, http, ssh } = ctx;
    if (type === "ssh") {
      const limit = positiveInt(args.limit || 20, 20, 1, 200);
      const ids = await listSshJobIds(ssh, limit);
      const jobs = [];
      for (const id of ids) {
        jobs.push(await readSshJobStatus(ssh, id));
      }
      printJson({
        ok: true,
        mode: "ssh",
        route: "ssh",
        target: ctx.target,
        connection: ctx.target.connection,
        count: jobs.length,
        jobs,
      });
      return;
    }
    const data = await getWithFallback(http, ["/api/jobs"], {
      limit: args.limit || 20,
      status: args.status,
    });
    printJson(withTarget(data, ctx));
  });
}

async function commandJob(args) {
  const subcommand = args._[1] || "help";
  switch (subcommand) {
    case "start":
    case "run":
      await commandJobStart(args);
      break;
    case "status":
    case "show":
      await commandJobStatus(args);
      break;
    case "logs":
    case "log":
      await commandJobLogs(args);
      break;
    case "cancel":
    case "stop":
      await commandJobCancel(args);
      break;
    case "list":
    case "ls":
      await commandJobList(args);
      break;
    default:
      if (subcommand && subcommand !== "help") {
        args.command = args._.slice(1).join(" ");
        await commandJobStart(args);
        return;
      }
      throw new Error("Usage: node cli.js job <start|status|logs|cancel|list> ...");
  }
}

async function commandTraceStart(args) {
  const requestedName = args.name || args._[2] || "ssh-link";
  const { safeName, intervalSeconds, script } = buildTraceCommand(requestedName, args.interval || args.every);
  const restart = Boolean(args.restart || args.force);

  await withConnection({ ...args, route: "ssh", requireExplicitConnection: true }, async ({ type, ssh }) => {
    if (type !== "ssh") throw new Error("trace command only supports SSH route. Use --route ssh.");

    const ref = await readTraceJobRef(ssh, safeName);
    if (ref.jobId) {
      const existing = await readSshJobStatus(ssh, ref.jobId);
      if (existing.ok && existing.status === "running" && !restart) {
        printJson({
          ok: true,
          mode: "ssh",
          route: "ssh",
          trace: safeName,
          reused: true,
          intervalSeconds,
          jobId: ref.jobId,
          status: existing.status,
          pid: existing.pid,
          hint: "Trace is already running. Use `trace stop` first or `trace start --restart`.",
        });
        return;
      }
      if (existing.ok && existing.pid) {
        await ssh.exec(`if kill -0 ${shellSingleQuote(existing.pid)} 2>/dev/null; then kill ${shellSingleQuote(existing.pid)} 2>/dev/null || true; fi`);
      }
      await ssh.rm(ref.keyPath);
    }

    const jobId = randomJobId("trace");
    const ctx = await buildSshJobContext(ssh, jobId);
    const traceRoot = await ssh.resolveRemotePath("~/.agentport/trace");
    const traceLogPath = `${traceRoot}/${safeName}.log`;
    await ssh.exec(`mkdir -p ${JSON.stringify(ctx.jobDir)} ${JSON.stringify(ctx.keysDir)} ${JSON.stringify(traceRoot)}`);

    const traceScriptPath = `${ctx.jobDir}/trace-loop.sh`;
    const runnerPath = `${ctx.jobDir}/runner.sh`;
    const runnerScript = [
      "#!/usr/bin/env bash",
      "set +e",
      `bash ${JSON.stringify(traceScriptPath)} > ${JSON.stringify(`${ctx.jobDir}/stdout.log`)} 2> ${JSON.stringify(`${ctx.jobDir}/stderr.log`)}`,
      "code=$?",
      `printf '%s' "$code" > ${JSON.stringify(`${ctx.jobDir}/exit_code`)}`,
      `date -Is > ${JSON.stringify(`${ctx.jobDir}/finished_at`)}`,
    ].join("\n") + "\n";

    await ssh.writeFile(traceScriptPath, script);
    await ssh.exec(`chmod +x ${JSON.stringify(traceScriptPath)}`);
    await ssh.writeFile(`${ctx.jobDir}/command.txt`, script);
    await ssh.writeFile(`${ctx.jobDir}/cwd.txt`, "~\n");
    await ssh.writeFile(`${ctx.jobDir}/started_at`, `${new Date().toISOString()}\n`);
    await ssh.writeFile(runnerPath, runnerScript);
    await ssh.exec(`chmod +x ${JSON.stringify(runnerPath)}`);

    const launch = await ssh.exec(`nohup ${JSON.stringify(runnerPath)} >/dev/null 2>&1 & echo $!`);
    const pid = normalizeJobId(launch.stdout);
    if (pid) await ssh.writeFile(`${ctx.jobDir}/pid`, `${pid}\n`);
    await ssh.writeFile(`${ctx.keysDir}/${ref.keyName}.job`, `${jobId}\n`);

    const status = await readSshJobStatus(ssh, jobId);
    printJson({
      ...status,
      trace: safeName,
      intervalSeconds,
      logPath: traceLogPath,
      key: ref.keyName,
    });
  });
}

async function commandTraceStatus(args) {
  const requestedName = args.name || args._[2] || "ssh-link";
  const safeName = normalizeTraceName(requestedName);
  await withConnection({ ...args, route: "ssh", requireExplicitConnection: true }, async ({ type, ssh }) => {
    if (type !== "ssh") throw new Error("trace command only supports SSH route. Use --route ssh.");
    const ref = await readTraceJobRef(ssh, safeName);
    const traceRoot = await ssh.resolveRemotePath("~/.agentport/trace");
    const traceLogPath = `${traceRoot}/${safeName}.log`;
    if (!ref.jobId) {
      printJson({
        ok: false,
        mode: "ssh",
        route: "ssh",
        trace: safeName,
        status: "not_found",
        logPath: traceLogPath,
        error: "trace job not found",
      });
      return;
    }
    const status = await readSshJobStatus(ssh, ref.jobId);
    printJson({
      ...status,
      trace: safeName,
      key: ref.keyName,
      logPath: traceLogPath,
    });
  });
}

async function commandTraceLogs(args) {
  const requestedName = args.name || args._[2] || "ssh-link";
  const safeName = normalizeTraceName(requestedName);
  const tailLines = positiveInt(args.tail || args.lines, 120, 1, 5000);
  await withConnection({ ...args, route: "ssh", requireExplicitConnection: true }, async ({ type, ssh }) => {
    if (type !== "ssh") throw new Error("trace command only supports SSH route. Use --route ssh.");
    const ref = await readTraceJobRef(ssh, safeName);
    const traceRoot = await ssh.resolveRemotePath("~/.agentport/trace");
    const traceLogPath = `${traceRoot}/${safeName}.log`;
    const logResult = await ssh.exec(`if [ -f ${shellSingleQuote(traceLogPath)} ]; then tail -n ${tailLines} ${shellSingleQuote(traceLogPath)}; fi`);

    const payload = {
      ok: true,
      mode: "ssh",
      route: "ssh",
      trace: safeName,
      jobId: ref.jobId,
      tail: tailLines,
      logPath: traceLogPath,
      content: logResult.stdout || "",
    };

    if (args.json) {
      printJson(payload);
      return;
    }
    print(payload.content || "");
  });
}

async function commandTraceStop(args) {
  const requestedName = args.name || args._[2] || "ssh-link";
  const safeName = normalizeTraceName(requestedName);
  await withConnection({ ...args, route: "ssh", requireExplicitConnection: true }, async ({ type, ssh }) => {
    if (type !== "ssh") throw new Error("trace command only supports SSH route. Use --route ssh.");
    const ref = await readTraceJobRef(ssh, safeName);
    if (!ref.jobId) {
      printJson({
        ok: false,
        mode: "ssh",
        route: "ssh",
        trace: safeName,
        stopped: false,
        error: "trace job not found",
      });
      return;
    }

    const status = await readSshJobStatus(ssh, ref.jobId);
    if (status.ok && status.pid) {
      await ssh.exec(`if kill -0 ${shellSingleQuote(status.pid)} 2>/dev/null; then kill ${shellSingleQuote(status.pid)} 2>/dev/null || true; fi`);
      const ctx = await buildSshJobContext(ssh, ref.jobId);
      await ssh.writeFile(`${ctx.jobDir}/finished_at`, `${new Date().toISOString()}\n`);
      await ssh.writeFile(`${ctx.jobDir}/canceled_at`, `${new Date().toISOString()}\n`);
    }
    await ssh.rm(ref.keyPath);
    const updated = await readSshJobStatus(ssh, ref.jobId);
    printJson({
      ...updated,
      trace: safeName,
      key: ref.keyName,
      stopped: true,
    });
  });
}

async function commandTrace(args) {
  const subcommand = (args._[1] || "status").toLowerCase();
  switch (subcommand) {
    case "start":
    case "run":
      await commandTraceStart(args);
      break;
    case "status":
    case "show":
      await commandTraceStatus(args);
      break;
    case "logs":
    case "log":
      await commandTraceLogs(args);
      break;
    case "stop":
    case "cancel":
      await commandTraceStop(args);
      break;
    default:
      throw new Error("Usage: node cli.js trace <start|status|logs|stop> [name] [--interval 5] [--tail 120] [--restart]");
  }
}

async function commandScript(args) {
  const file = args._[1] || args.file;
  const interpreter = args.interpreter || "bash";
  if (!file) throw new Error("Usage: node cli.js script <local-script-file> [--interpreter bash] [--cwd path]");
  const content = fs.readFileSync(file, "utf8");
  await withConnection({ ...args, requireExplicitConnection: true }, async (ctx) => {
    const { type, http, ssh } = ctx;
    if (type === "ssh") {
      const remoteFile = remoteScriptPath(ssh, args, interpreter);
      let result;
      await ssh.mkdir(remoteScriptBaseDir(ssh, args));
      try {
        await ssh.writeFile(remoteFile, content);
        result = await ssh.exec(`${interpreter} ${JSON.stringify(remoteFile)}`, { cwd: args.cwd });
      } finally {
        try { await ssh.rm(remoteFile); } catch {}
      }
      printJson(withTarget(result, ctx));
      applyOperationExitCode(result);
      return;
    }
    const data = await postWithFallback(http, ["/api/exec/script"], { content, interpreter, cwd: args.cwd });
    printJson(withTarget(data, ctx));
    applyOperationExitCode(data);
  });
}

async function commandSafeScript(args) {
  const file = args._[1] || args.file;
  if (!file) throw new Error("Usage: node cli.js safe-script <local-script-file> [--interpreter bash] [--cwd path]");

  const interpreter = safeScriptInterpreter(args.interpreter || "bash");
  const normalizeLf = !(args.preserveEol || args["preserve-eol"]);
  const keepRemote = Boolean(args.keepRemote || args["keep-remote"]);
  const content = readUtf8PayloadFile(file, { normalizeLf });
  const expectedSha256 = sha256Text(content);
  const payload = {
    ok: true,
    command: args.commandName || "safe-script",
    sourceFile: path.resolve(file),
    interpreter,
    cwd: args.cwd || null,
    bytes: utf8Bytes(content),
    sha256: expectedSha256,
    normalizeLf,
    keepRemote,
  };

  if (args.dryRun || args["dry-run"]) {
    printJson({
      ...payload,
      dryRun: true,
      remoteTmpDir: remoteTempDirArg(args) || "(auto)",
      verifiedUpload: false,
    });
    return;
  }

  await withConnection({ ...args, requireExplicitConnection: true }, async (ctx) => {
    const { type, http, ssh } = ctx;
    if (type === "ssh") {
      const remoteFile = remoteScriptPath(ssh, args, interpreter);
      let cleanup = { skipped: keepRemote };
      let uploadVerification;
      let result;
      await ssh.mkdir(remoteScriptBaseDir(ssh, args));
      try {
        await ssh.writeFile(remoteFile, content);
        uploadVerification = await verifyRemoteContent(ctx, remoteFile, expectedSha256);
        result = await ssh.exec(`${interpreter} ${JSON.stringify(remoteFile)}`, { cwd: args.cwd });
      } finally {
        if (!keepRemote) {
          try {
            await ssh.rm(remoteFile);
            cleanup = { ok: true };
          } catch (error) {
            cleanup = { ok: false, error: error.message };
          }
        }
      }
      printJson(withTarget({
        ...payload,
        mode: "ssh",
        remoteFile,
        verifiedUpload: true,
        uploadVerification,
        cleanup,
        result,
      }, ctx));
      applyOperationExitCode(result);
      return;
    }

    const data = await postWithFallback(http, ["/api/exec/script"], { content, interpreter, cwd: args.cwd });
    printJson(withTarget({
      ...payload,
      mode: "daemon",
      verifiedUpload: false,
      result: data,
    }, ctx));
    applyOperationExitCode(data);
  });
}

async function commandSafeJob(args) {
  const file = args._[1] || args.file;
  if (!file) throw new Error("Usage: node cli.js safe-job <local-script-file> --cwd <remote-cwd> [--interpreter bash]");
  if (args.key) throw new Error("safe-job does not support --key because every uploaded script is unique.");

  const interpreter = safeScriptInterpreter(args.interpreter || "bash");
  const normalizeLf = !(args.preserveEol || args["preserve-eol"]);
  const keepRemote = Boolean(args.keepRemote || args["keep-remote"]);
  const content = readUtf8PayloadFile(file, { normalizeLf });
  const wrapper = buildSafeJobWrapper(content, interpreter, { keepRemote });
  const payload = {
    command: "safe-job",
    sourceFile: path.resolve(file),
    interpreter,
    cwd: args.cwd || null,
    bytes: utf8Bytes(content),
    sha256: sha256Text(content),
    wrapperBytes: utf8Bytes(wrapper),
    wrapperSha256: sha256Text(wrapper),
    keepRemote,
    jobTimeoutMs: jobTimeoutMs(args, SAFE_JOB_TIMEOUT_MS),
  };

  if (args.dryRun || args["dry-run"]) {
    printJson({ ok: true, ...payload, dryRun: true, verifiedUpload: false });
    return;
  }

  await withConnection({ ...args, requireExplicitConnection: true }, async (ctx) => {
    const remoteWrapper = remoteJobWrapperPath(ctx, args);
    let uploaded = false;
    try {
      const writeResult = await writeRemoteContent(ctx, remoteWrapper, wrapper);
      uploaded = true;
      const uploadVerification = await verifyRemoteContent(ctx, remoteWrapper, payload.wrapperSha256);
      const submittedCommand = `bash ${shellSingleQuote(remoteWrapper)}`;
      const job = await startJob(ctx, submittedCommand, {
        ...args,
        defaultJobTimeoutMs: SAFE_JOB_TIMEOUT_MS,
      });
      printJson({
        ...job,
        safeJob: {
          ...payload,
          remoteWrapper,
          submittedCommand,
          verifiedUpload: true,
          uploadVerification,
          writeResult,
        },
      });
    } catch (error) {
      if (uploaded) {
        try { await cleanupRemoteContent(ctx, remoteWrapper, args.cwd); } catch {}
      }
      throw error;
    }
  });
}

async function commandSafeBash(args) {
  const file = args._[1] || args.file;
  if (!file) throw new Error("Usage: node cli.js safe-bash <local-bash-file> [--cwd path]");
  await commandSafeScript({
    ...args,
    interpreter: "bash",
    commandName: "safe-bash",
    _: ["safe-script", file, ...args._.slice(2)],
  });
}

async function commandSafeApply(args) {
  const file = args._[1] || args.file;
  if (!file) throw new Error("Usage: node cli.js safe-apply <local-patch-file> --cwd <remote-repo> [--check]");
  if (!args.cwd) throw new Error("safe-apply requires --cwd <remote-repo> so git apply runs in the intended repository.");

  const content = readUtf8PayloadFile(file, { normalizeLf: true });
  const expectedSha256 = sha256Text(content);
  const checkOnly = Boolean(args.check || args["check-only"]);
  const payload = {
    ok: true,
    command: "safe-apply",
    sourceFile: path.resolve(file),
    cwd: args.cwd,
    bytes: utf8Bytes(content),
    sha256: expectedSha256,
    checkOnly,
    flags: gitApplyFlags(args, { check: false }),
  };

  if (args.dryRun || args["dry-run"]) {
    printJson({ ...payload, dryRun: true, checked: false, applied: false });
    return;
  }

  await withConnection({ ...args, requireExplicitConnection: true }, async (ctx) => {
    const { type, http, ssh } = ctx;
    if (type === "ssh") {
      const remotePatch = remotePayloadPath(ssh, args, "patch");
      let cleanup = { skipped: Boolean(args.keepRemote || args["keep-remote"]) };
      await ssh.writeFile(remotePatch, content);
      const uploadVerification = await verifyRemoteContent(ctx, remotePatch, expectedSha256);
      const checkResult = await ssh.exec(gitApplyCommand(remotePatch, args, { check: true }), { cwd: args.cwd });
      if (checkResult.code !== 0) {
        if (!cleanup.skipped) {
          try {
            await ssh.rm(remotePatch);
            cleanup = { ok: true };
          } catch (error) {
            cleanup = { ok: false, error: error.message };
          }
        }
        printJson(withTarget({
          ...payload,
          ok: false,
          mode: "ssh",
          remotePatch,
          checked: false,
          applied: false,
          uploadVerification,
          checkResult,
          cleanup,
        }, ctx));
        process.exitCode = 2;
        return;
      }

      let applyResult = null;
      if (!checkOnly) {
        applyResult = await ssh.exec(gitApplyCommand(remotePatch, args), { cwd: args.cwd });
      }
      if (!cleanup.skipped) {
        try {
          await ssh.rm(remotePatch);
          cleanup = { ok: true };
        } catch (error) {
          cleanup = { ok: false, error: error.message };
        }
      }
      const applied = Boolean(!checkOnly && applyResult?.code === 0);
      printJson(withTarget({
        ...payload,
        ok: checkOnly || applied,
        mode: "ssh",
        remotePatch,
        checked: true,
        applied,
        uploadVerification,
        checkResult,
        applyResult,
        cleanup,
      }, ctx));
      if (!checkOnly && !applied) process.exitCode = 2;
      return;
    }

    const b64 = Buffer.from(content, "utf8").toString("base64").replace(/(.{1,76})/g, "$1\n").trim();
    const flags = gitApplyFlags(args, { check: false }).map(shellSingleQuote).join(" ");
    const script = [
      "set -eu",
      'patch_file="$(mktemp "${TMPDIR:-/tmp}/agentport-patch.XXXXXX.patch")"',
      'cleanup() { rm -f "$patch_file"; }',
      "trap cleanup EXIT",
      "base64 -d > \"$patch_file\" <<'AGENTPORT_PATCH_B64'",
      b64,
      "AGENTPORT_PATCH_B64",
      `git apply --check${flags ? ` ${flags}` : ""} "$patch_file"`,
      checkOnly ? "exit 0" : `git apply${flags ? ` ${flags}` : ""} "$patch_file"`,
      "",
    ].join("\n");
    const data = await postWithFallback(http, ["/api/exec/script"], { content: script, interpreter: "bash", cwd: args.cwd });
    const applied = Boolean(checkOnly ? data?.code === 0 || data?.ok : data?.code === 0 || data?.ok);
    printJson(withTarget({
      ...payload,
      ok: applied,
      mode: "daemon",
      checked: applied,
      applied: !checkOnly && applied,
      result: data,
    }, ctx));
    if (!applied) process.exitCode = 2;
  });
}

function batchHasRiskyOperations(operations) {
  return operations.some((op) => {
    const type = String(op?.type || "").toLowerCase();
    return type === "write" || type === "bash" || type === "script" || type === "exec";
  });
}

async function commandBatch(args) {
  const file = args._[1] || args.file;
  if (!file) throw new Error("Usage: node cli.js batch <batch.json>");
  const payload = readJson(file, null);
  const operations = Array.isArray(payload) ? payload : payload.operations;
  if (!Array.isArray(operations)) throw new Error("Batch file must be an array or { operations: [...] }");
  await withConnection({ ...args, requireExplicitConnection: batchHasRiskyOperations(operations) }, async (ctx) => {
    const { type, http, ssh } = ctx;
    if (type === "ssh") {
      const results = [];
      for (const op of operations) {
        if (op.type === "read") results.push({ ...op, status: 200, content: await ssh.readFile(op.path) });
        else if (op.type === "write") {
          await ssh.writeFile(op.path, sanitizeContent(op.content || ""));
          results.push({ ...op, status: 200 });
        } else if (op.type === "stat") results.push({ ...op, status: 200, ...(await ssh.stat(op.path)) });
        else if (op.type === "glob") results.push({ ...op, status: 200, entries: await ssh.glob(op.pattern, op.cwd) });
        else if (op.type === "grep") {
          const safeCwd = ssh.resolveWorkspaceCwd(op.cwd);
          const { command, maxResults } = buildSshGrepCommand({ ...op, cwd: safeCwd || op.cwd });
          const result = await ssh.exec(command);
          const matches = parseGrepOutput(result.stdout);
          results.push({ ...op, status: 200, engine: "grep", matches, truncated: matches.length >= maxResults });
        }
        else if (op.type === "bash") results.push({ ...op, status: 200, ...(await ssh.exec(op.command, { cwd: op.cwd })) });
        else results.push({ ...op, status: 400, error: "Unsupported SSH batch operation" });
      }
      const data = { success: operationExitCode(results) === 0, results };
      printJson(withTarget(data, ctx));
      applyOperationExitCode(data);
      return;
    }
    const data = await postWithFallback(http, ["/api/batch"], { operations });
    printJson(withTarget(data, ctx));
    applyOperationExitCode(data);
  });
}

function usage() {
  print(`agentport CLI fallback

Priority for agents:
  1. SSH-first for stable base operations.
  2. Use daemon jobs for persistent long-running tasks.
  3. Use native remote_* MCP tools when they are visible and stable.

Commands:
  node cli.js list
  node cli.js connect <name>
  node cli.js health [--connection name]
  node cli.js ssh-health [--connection name]
  node cli.js status [--connection name]
  node cli.js doctor
  node cli.js read <remote-path> [--connection name]
  node cli.js write <remote-path> --content "text"
  node cli.js write <remote-path> --file local.txt
  node cli.js safe-write <remote-path> --file payload.txt [--verify readback|none]
  node cli.js safe-apply patch.diff --cwd /path/to/repo [--check]
  node cli.js stat <remote-path>
  node cli.js glob "**/*.js" [--cwd /path]
  node cli.js grep "text" [--cwd /path] [--include "*.js,*.ts"]
  node cli.js bash "pwd && ls -la" [--cwd /path]
  node cli.js safe-bash local-readonly-check.sh [--cwd /path]
  node cli.js safe-job local-build.sh --cwd /path [--job-timeout-ms 1800000]
  node cli.js job start "npm test" [--cwd /path]
  node cli.js job status <job-id>
  node cli.js job logs <job-id> [--tail 200]
  node cli.js job cancel <job-id>
  node cli.js job list [--limit 20]
  node cli.js trace start [name] [--interval 5] [--restart]
  node cli.js trace status [name]
  node cli.js trace logs [name] [--tail 120]
  node cli.js trace stop [name]
  node cli.js token list [--route ssh]
  node cli.js token add --client-id <client-id> [--admin]
  node cli.js token revoke --client-id <client-id> [--admin]
  node cli.js token dashboard-url [--client-id <client-id>]
  node cli.js client provision --client-id <client-id> --connection <name>
  node cli.js script local-script.sh [--interpreter bash]
  node cli.js safe-script local-script.sh [--interpreter bash] [--cwd /path]
  node cli.js batch batch.json

Options:
  --connection <name>       choose connection
  --route <auto|ssh|daemon> prefer route for this command
  --exec-timeout-ms <ms>    synchronous SSH timeout; 0 disables it
  --job-timeout-ms <ms>     daemon job timeout; 0 disables it
  --json                    structured output for read/bash/logs/errors

Safety:
  When multiple connections are configured, write/exec/job/trace/token mutation commands
  require explicit --connection <name>. Set AGENTPORT_SESSION_ID to make \`connect\`
  maintain a session-scoped current connection instead of the shared fallback state.
  For large source, patches, Markdown, Chinese text, or complex scripts, keep
  PowerShell as a short launcher only and use safe-write/safe-script with a
  local UTF-8 payload file. Use safe-bash for grep pipelines and multiline
  diagnostics. Avoid passing code through --content or bash strings.
`);
}

async function main(args) {
  const command = args._[0] || "help";
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    case "list":
      await commandList(args);
      break;
    case "connect":
      await commandConnect(args);
      break;
    case "health":
      await commandHealth(args);
      break;
    case "ssh-health":
      await commandSshHealth(args);
      break;
    case "status":
      await commandStatus(args);
      break;
    case "doctor":
    case "probe":
      await commandDoctor(args);
      break;
    case "read":
      await commandRead(args);
      break;
    case "write":
      await commandWrite(args);
      break;
    case "safe-write":
    case "write-safe":
      await commandSafeWrite(args);
      break;
    case "safe-apply":
    case "apply-safe":
      await commandSafeApply(args);
      break;
    case "stat":
      await commandStat(args);
      break;
    case "glob":
      await commandGlob(args);
      break;
    case "grep":
      await commandGrep(args);
      break;
    case "bash":
      await commandBash(args);
      break;
    case "safe-bash":
    case "bash-safe":
      await commandSafeBash(args);
      break;
    case "safe-job":
    case "job-safe":
      await commandSafeJob(args);
      break;
    case "job":
      await commandJob(args);
      break;
    case "trace":
      await commandTrace(args);
      break;
    case "token":
      await commandToken(args);
      break;
    case "client":
      await commandClient(args);
      break;
    case "logs":
      args._ = ["job", "logs", ...args._.slice(1)];
      await commandJobLogs(args);
      break;
    case "cancel":
      args._ = ["job", "cancel", ...args._.slice(1)];
      await commandJobCancel(args);
      break;
    case "script":
      await commandScript(args);
      break;
    case "safe-script":
    case "script-safe":
      await commandSafeScript(args);
      break;
    case "batch":
      await commandBatch(args);
      break;
    default:
      throw new Error(`Unknown command '${command}'. Run: node cli.js help`);
  }
}

const _args = parseArgs(process.argv.slice(2));
main(_args)
  .catch((error) => fail(error.message, 1, _args))
  .finally(() => {
    stopParentWatchdog();
    scheduleForcedExit({ exitCode: process.exitCode ?? 0 });
  });
