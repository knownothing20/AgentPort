#!/usr/bin/env node

import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { SSHClient } from "./ssh-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONNECTIONS_PATH = path.join(__dirname, "local", "connections.json");
const STATE_PATH = path.join(__dirname, "local", "cli-state.json");
const TIMEOUT_MS = Number(process.env.MCP_REMOTE_TIMEOUT_MS || process.env.NIUMA_SSH_TIMEOUT_MS || 120000);

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

function getState() {
  return readJson(STATE_PATH, {});
}

function setCurrentConnection(name) {
  writeJson(STATE_PATH, { current: name, updatedAt: new Date().toISOString() });
}

function selectConnection(options = {}) {
  const { connections, byName, defaultName } = loadConnections();
  const explicit = options.connection || process.env.MCP_REMOTE_CONNECTION || process.env.NIUMA_SSH_CONNECTION;
  const stateCurrent = getState().current;
  const wanted = explicit || stateCurrent || defaultName;
  const route = String(options.route || "").toLowerCase();
  const wantsSsh = route === "ssh" || route === "openssh";
  const wantsDaemon = route === "daemon";

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
    headers: {
      Authorization: `Bearer ${conn.authToken}`,
      "X-Client-ID": conn.clientId || "agentport-cli",
      "Content-Type": "application/json",
    },
  });
}

async function postWithFallback(client, paths, payload) {
  let lastError;
  for (const route of paths) {
    try {
      const response = await client.post(route, payload);
      return response.data;
    } catch (error) {
      lastError = error;
      if (!error?.response && ["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNABORTED"].includes(error?.code)) {
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
    const client = new SSHClient(conn);
    try {
      return await fn({ type: "ssh", conn, ssh: client });
    } finally {
      client.disconnect();
    }
  }
  const daemonCtx = { type: "daemon", conn, http: daemonClient(conn) };
  try {
    return await fn(daemonCtx);
  } catch (error) {
    const route = String(options.route || "auto").toLowerCase();
    const canFallback = route !== "daemon" && isTransportError(error);
    if (!canFallback) throw error;

    const sshConn = fallbackSshConnection(conn, options);
    if (!sshConn) throw error;

    const sshClient = new SSHClient(sshConn);
    try {
      return await fn({
        type: "ssh",
        conn: sshConn,
        ssh: sshClient,
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

async function checkSsh(conn) {
  const client = new SSHClient(conn);
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
  await withConnection(args, async ({ type, http, ssh }) => {
    if (type === "ssh") {
      const content = await ssh.readFile(targetPath);
      if (args.json) {
        printJson({ ok: true, mode: "ssh", path: targetPath, content });
        return;
      }
      print(content);
      return;
    }
    const data = await postWithFallback(http, ["/api/fs/read", "/read"], { path: targetPath });
    if (args.json) {
      printJson({ ok: true, mode: "daemon", path: targetPath, etag: data.etag, content: data.content ?? "" });
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
  await withConnection(args, async ({ type, http, ssh }) => {
    if (type === "ssh") {
      await ssh.writeFile(targetPath, content);
      printJson({ ok: true, path: targetPath, mode: "ssh" });
      return;
    }
    const data = await postWithFallback(http, ["/api/fs/write", "/write"], {
      path: targetPath,
      content,
      expectedEtag: typeof args.expectedEtag === "string" ? args.expectedEtag : undefined,
    });
    printJson({ ok: true, path: targetPath, mode: "daemon", etag: data.etag });
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
    printJson(data.results?.[0] || data);
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
      const { command, maxResults } = buildSshGrepCommand({ ...args, pattern });
      const result = await ssh.exec(command);
      const matches = parseGrepOutput(result.stdout);
      printJson({
        success: true,
        engine: "grep",
        pattern,
        cwd: args.cwd || ".",
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
  await withConnection(args, async ({ type, http, ssh }) => {
    const data = type === "ssh"
      ? await ssh.exec(command, { cwd: args.cwd })
      : await postWithFallback(http, ["/api/exec", "/bash", "/api/cmd/execute"], { command, cwd: args.cwd });
    if (args.json) {
      printJson({ ok: true, mode: type, command, cwd: args.cwd || null, ...data });
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

async function commandJobStart(args) {
  const command = args.command || args._.slice(2).join(" ");
  if (!command) throw new Error("Usage: node cli.js job start <command> [--cwd path]");
  await withConnection(args, async ({ type, http, ssh }) => {
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
            printJson({ ...existing, reused: true, key });
            return;
          }
        }
      }

      const jobId = randomJobId("ssh");
      const ctx = await buildSshJobContext(ssh, jobId);
      await ssh.exec(`mkdir -p ${JSON.stringify(ctx.jobDir)}`);

      const runCommand = args.cwd
        ? `cd ${JSON.stringify(args.cwd)} && ${command}`
        : command;

      const runnerPath = `${ctx.jobDir}/runner.sh`;
      const runnerScript = [
        "#!/usr/bin/env bash",
        "set +e",
        `bash -lc ${JSON.stringify(runCommand)} > ${JSON.stringify(`${ctx.jobDir}/stdout.log`)} 2> ${JSON.stringify(`${ctx.jobDir}/stderr.log`)}`,
        "code=$?",
        `printf '%s' \"$code\" > ${JSON.stringify(`${ctx.jobDir}/exit_code`)}`,
        `date -Is > ${JSON.stringify(`${ctx.jobDir}/finished_at`)}`,
      ].join("\n") + "\n";

      await ssh.writeFile(`${ctx.jobDir}/command.txt`, command.endsWith("\n") ? command : `${command}\n`);
      if (args.cwd) await ssh.writeFile(`${ctx.jobDir}/cwd.txt`, `${args.cwd}\n`);
      await ssh.writeFile(`${ctx.jobDir}/started_at`, `${new Date().toISOString()}\n`);
      await ssh.writeFile(runnerPath, runnerScript);
      await ssh.exec(`chmod +x ${JSON.stringify(runnerPath)}`);

      const launch = await ssh.exec(`nohup ${JSON.stringify(runnerPath)} >/dev/null 2>&1 & echo $!`);
      const pid = normalizeJobId(launch.stdout);
      if (pid) await ssh.writeFile(`${ctx.jobDir}/pid`, `${pid}\n`);
      if (key) {
        await ssh.writeFile(`${ctx.keysDir}/${key}.job`, `${jobId}\n`);
      }

      const created = await readSshJobStatus(ssh, jobId);
      printJson({ ...created, key: key || undefined });
      return;
    }
    const data = await postWithFallback(http, ["/api/jobs", "/api/jobs/start", "/api/exec/async"], {
      command,
      cwd: args.cwd,
    });
    printJson(data);
  });
}

async function commandJobStatus(args) {
  const jobId = args._[2] || args.jobId || args.id;
  if (!jobId) throw new Error("Usage: node cli.js job status <job-id>");
  await withConnection(args, async ({ type, http, ssh }) => {
    if (type === "ssh") {
      printJson(await readSshJobStatus(ssh, jobId));
      return;
    }
    const data = await getWithFallback(http, [`/api/jobs/${encodeURIComponent(jobId)}`, `/api/task/${encodeURIComponent(jobId)}`]);
    printJson(data);
  });
}

async function commandJobLogs(args) {
  const jobId = args._[2] || args.jobId || args.id;
  if (!jobId) throw new Error("Usage: node cli.js job logs <job-id> [--tail 200]");
  const tailLines = positiveInt(args.tail || args.lines, 200, 1, 10000);
  const tailBytes = positiveInt(args.tailBytes || args.bytes, 64 * 1024, 1024, 5 * 1024 * 1024);
  await withConnection(args, async ({ type, http, ssh }) => {
    if (type === "ssh") {
      const ctx = await buildSshJobContext(ssh, jobId);
      const stat = await readSshJobStatus(ssh, jobId);
      if (!stat.ok) {
        printJson(stat);
        process.exitCode = 2;
        return;
      }
      const stdout = (await readRemoteOptional(ssh, `${ctx.jobDir}/stdout.log`)) || "";
      const stderr = (await readRemoteOptional(ssh, `${ctx.jobDir}/stderr.log`)) || "";
      const trimLines = (text) => text.split(/\r?\n/).slice(-tailLines).join("\n");
      const payload = {
        ok: true,
        mode: "ssh",
        route: "ssh",
        jobId,
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
        printJson(data);
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
        printJson(data);
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
  await withConnection(args, async ({ type, http, ssh }) => {
    if (type === "ssh") {
      const ctx = await buildSshJobContext(ssh, jobId);
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
      await ssh.writeFile(`${ctx.jobDir}/finished_at`, `${new Date().toISOString()}\n`);
      await ssh.writeFile(`${ctx.jobDir}/canceled_at`, `${new Date().toISOString()}\n`);
      const updated = await readSshJobStatus(ssh, jobId);
      printJson({ ...updated, canceled: true });
      return;
    }
    const data = await postWithFallback(http, [`/api/jobs/${encodeURIComponent(jobId)}/cancel`], {});
    printJson(data);
  });
}

async function commandJobList(args) {
  await withConnection(args, async ({ type, http, ssh }) => {
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
        count: jobs.length,
        jobs,
      });
      return;
    }
    const data = await getWithFallback(http, ["/api/jobs"], {
      limit: args.limit || 20,
      status: args.status,
    });
    printJson(data);
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

async function commandScript(args) {
  const file = args._[1] || args.file;
  const interpreter = args.interpreter || "bash";
  if (!file) throw new Error("Usage: node cli.js script <local-script-file> [--interpreter bash] [--cwd path]");
  const content = fs.readFileSync(file, "utf8");
  await withConnection(args, async ({ type, http, ssh }) => {
    if (type === "ssh") {
      const remoteFile = `/tmp/agentport-cli-${Date.now()}.${interpreter === "python3" ? "py" : "sh"}`;
      await ssh.writeFile(remoteFile, content);
      const result = await ssh.exec(`${interpreter} ${JSON.stringify(remoteFile)}`, { cwd: args.cwd });
      await ssh.rm(remoteFile);
      printJson(result);
      return;
    }
    const data = await postWithFallback(http, ["/api/exec/script"], { content, interpreter, cwd: args.cwd });
    printJson(data);
  });
}

async function commandBatch(args) {
  const file = args._[1] || args.file;
  if (!file) throw new Error("Usage: node cli.js batch <batch.json>");
  const payload = readJson(file, null);
  const operations = Array.isArray(payload) ? payload : payload.operations;
  if (!Array.isArray(operations)) throw new Error("Batch file must be an array or { operations: [...] }");
  await withConnection(args, async ({ type, http, ssh }) => {
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
          const { command, maxResults } = buildSshGrepCommand(op);
          const result = await ssh.exec(command);
          const matches = parseGrepOutput(result.stdout);
          results.push({ ...op, status: 200, engine: "grep", matches, truncated: matches.length >= maxResults });
        }
        else if (op.type === "bash") results.push({ ...op, status: 200, ...(await ssh.exec(op.command, { cwd: op.cwd })) });
        else results.push({ ...op, status: 400, error: "Unsupported SSH batch operation" });
      }
      printJson({ success: true, results });
      return;
    }
    printJson(await postWithFallback(http, ["/api/batch"], { operations }));
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
  node cli.js stat <remote-path>
  node cli.js glob "**/*.js" [--cwd /path]
  node cli.js grep "text" [--cwd /path] [--include "*.js,*.ts"]
  node cli.js bash "pwd && ls -la" [--cwd /path]
  node cli.js job start "npm test" [--cwd /path]
  node cli.js job status <job-id>
  node cli.js job logs <job-id> [--tail 200]
  node cli.js job cancel <job-id>
  node cli.js job list [--limit 20]
  node cli.js script local-script.sh [--interpreter bash]
  node cli.js batch batch.json

Options:
  --connection <name>       choose connection
  --route <auto|ssh|daemon> prefer route for this command
  --json                    structured output for read/bash/logs/errors
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
    case "job":
      await commandJob(args);
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
    case "batch":
      await commandBatch(args);
      break;
    default:
      throw new Error(`Unknown command '${command}'. Run: node cli.js help`);
  }
}

const _args = parseArgs(process.argv.slice(2));
main(_args).catch((error) => fail(error.message, 1, _args));
