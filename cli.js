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

function daemonClient(conn) {
  return axios.create({
    baseURL: conn.url,
    timeout: Number(conn.timeoutMs || TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${conn.authToken}`,
      "X-Client-ID": conn.clientId || "mcp-remote-agent-cli",
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
    nativeMcpPriority: "If remote_* MCP tools are visible, use them first. This CLI is the Bash/terminal fallback.",
    cli: { available: true, node: process.version, cwd: __dirname },
    config: { path: CONNECTIONS_PATH, default: defaultName || null, current: getState().current || null },
    recommendedOrder: ["native-mcp", "cli-daemon", "cli-ssh", "http-curl", "manual"],
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

async function commandScript(args) {
  const file = args._[1] || args.file;
  const interpreter = args.interpreter || "bash";
  if (!file) throw new Error("Usage: node cli.js script <local-script-file> [--interpreter bash] [--cwd path]");
  const content = fs.readFileSync(file, "utf8");
  await withConnection(args, async ({ type, http, ssh }) => {
    if (type === "ssh") {
      const remoteFile = `/tmp/mcp-remote-agent-cli-${Date.now()}.${interpreter === "python3" ? "py" : "sh"}`;
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
  print(`mcp-remote-agent CLI fallback

Priority for agents:
  1. Use native remote_* MCP tools when they are visible.
  2. If MCP is not visible but Bash/terminal is available, use this CLI.
  3. CLI prefers daemon connections for long-term development; SSH is the fallback.

Commands:
  node cli.js list
  node cli.js connect <name>
  node cli.js health [--connection name]
  node cli.js doctor
  node cli.js read <remote-path> [--connection name]
  node cli.js write <remote-path> --content "text"
  node cli.js write <remote-path> --file local.txt
  node cli.js stat <remote-path>
  node cli.js glob "**/*.js" [--cwd /path]
  node cli.js bash "pwd && ls -la" [--cwd /path]
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
    case "bash":
      await commandBash(args);
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
