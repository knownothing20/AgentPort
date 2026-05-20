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

function fail(message, code = 1) {
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
  return fn({ type: "daemon", conn, http: daemonClient(conn) });
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
    recommendedOrder: ["cli-daemon", "cli-job", "cli-ssh-recovery", "native-mcp"],
  };

  if ((conn.type || "daemon") === "ssh") {
    result.health = await checkSsh(conn);
    result.capabilities = {
      read: true,
      write: true,
      bash: true,
      jobs: false,
      jobLogs: false,
      jobCancel: false,
      config: false,
    };
    result.note = "SSH mode is the recovery channel. Persistent jobs require a daemon connection.";
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
    recommendedOrder: ["cli-daemon", "cli-job", "cli-ssh-recovery", "native-mcp", "http-curl", "manual"],
    transportPolicy: "When native MCP returns Transport closed, switch to CLI daemon jobs. Use SSH to recover the daemon or run one-off diagnostics.",
    results,
  });
}

async function commandRead(args) {
  const targetPath = args._[1] || args.path;
  if (!targetPath) throw new Error("Usage: node cli.js read <remote-path> [--connection name]");
  await withConnection(args, async ({ type, http, ssh }) => {
    if (type === "ssh") {
      print(await ssh.readFile(targetPath));
      return;
    }
    const data = await postWithFallback(http, ["/api/fs/read", "/read"], { path: targetPath });
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
      printJson(data);
      return;
    }
    if (data.stdout) print(data.stdout.replace(/\s+$/, ""));
    if (data.stderr) process.stderr.write(`${data.stderr.replace(/\s+$/, "")}\n`);
    if (typeof data.code === "number" && data.code !== 0) process.exitCode = data.code;
  });
}

function unsupportedSshJobs() {
  return {
    ok: false,
    mode: "ssh",
    unsupported: true,
    message: "SSH mode is for recovery and one-off commands. Persistent jobs require a daemon connection.",
  };
}

async function commandJobStart(args) {
  const command = args.command || args._.slice(2).join(" ");
  if (!command) throw new Error("Usage: node cli.js job start <command> [--cwd path]");
  await withConnection(args, async ({ type, http }) => {
    if (type === "ssh") {
      printJson(unsupportedSshJobs());
      process.exitCode = 2;
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
  await withConnection(args, async ({ type, http }) => {
    if (type === "ssh") {
      printJson(unsupportedSshJobs());
      process.exitCode = 2;
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
  await withConnection(args, async ({ type, http }) => {
    if (type === "ssh") {
      printJson(unsupportedSshJobs());
      process.exitCode = 2;
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
  await withConnection(args, async ({ type, http }) => {
    if (type === "ssh") {
      printJson(unsupportedSshJobs());
      process.exitCode = 2;
      return;
    }
    const data = await postWithFallback(http, [`/api/jobs/${encodeURIComponent(jobId)}/cancel`], {});
    printJson(data);
  });
}

async function commandJobList(args) {
  await withConnection(args, async ({ type, http }) => {
    if (type === "ssh") {
      printJson(unsupportedSshJobs());
      process.exitCode = 2;
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
  1. Use native remote_* MCP tools when they are visible.
  2. If MCP is not visible but Bash/terminal is available, use this CLI.
  3. CLI prefers daemon connections for long-term development; SSH is the fallback.

Commands:
  node cli.js list
  node cli.js connect <name>
  node cli.js health [--connection name]
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
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
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

main().catch((error) => fail(error.message));
