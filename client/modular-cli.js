#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClientRuntime } from "../packages/client-core/client-runtime.js";
import { redactSensitive } from "../packages/client-core/redaction.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const separator = arg.indexOf("=");
    if (separator > 2) {
      out[arg.slice(2, separator)] = arg.slice(separator + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      index += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function value(args, ...names) {
  for (const name of names) {
    if (args[name] !== undefined) return args[name];
  }
  return undefined;
}

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(redactSensitive(payload), null, 2)}\n`);
}

function printResult(result, args) {
  if (args.json || typeof result !== "string") printJson(result);
  else process.stdout.write(`${result}\n`);
}

function timeoutValue(args) {
  const raw = value(args, "timeout-ms", "timeoutMs", "job-timeout-ms", "jobTimeoutMs");
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error("timeout must be an integer >= 0");
  return parsed;
}

function usage() {
  process.stdout.write(`AgentPort modular client\n\n`);
  process.stdout.write(`Commands:\n`);
  process.stdout.write(`  agentport server list [--json]\n`);
  process.stdout.write(`  agentport server health [server] [--force] [--json]\n`);
  process.stdout.write(`  agentport server select <server-or-endpoint> [--endpoint id]\n`);
  process.stdout.write(`  agentport project list\n`);
  process.stdout.write(`  agentport project status <project>\n`);
  process.stdout.write(`  agentport project run <project> <install|lint|test|build|custom> [--idempotency-key key]\n`);
  process.stdout.write(`  agentport project logs <job-id> [--server id] [--cursor value] [--max-bytes n]\n`);
  process.stdout.write(`  agentport project follow <job-id> [--server id] [--interval-ms 1000]\n`);
  process.stdout.write(`  agentport project cancel <job-id> [--server id]\n`);
  process.stdout.write(`  agentport v3 job start <command> [--server id] [--cwd path] [--idempotency-key key]\n`);
  process.stdout.write(`  agentport v3 job <status|logs|follow|cancel|list> ...\n\n`);
  process.stdout.write(`Existing legacy commands remain available through client/cli-entry.js.\n`);
}

function terminalStatus(status) {
  return new Set(["completed", "error", "failed", "cancelled", "canceled", "timeout", "orphaned"]).has(String(status || "").toLowerCase());
}

async function followJob(runtime, jobId, args) {
  let cursor = value(args, "cursor") || "";
  const intervalMs = Math.min(Math.max(Number(value(args, "interval-ms", "intervalMs") || 1000), 200), 30_000);
  const server = value(args, "server", "connection");
  while (true) {
    const logs = await runtime.invoke("job_logs", {
      jobId,
      cursor,
      maxBytes: Number(value(args, "max-bytes", "maxBytes") || 64 * 1024),
      server,
    });
    const data = logs.data || {};
    const stdout = data.stdout?.content || "";
    const stderr = data.stderr?.content || "";
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    cursor = data.cursor || cursor;

    const statusResult = await runtime.invoke("job_status", { jobId, server });
    const status = statusResult.data?.job?.status || statusResult.data?.status;
    if (terminalStatus(status)) {
      process.stdout.write(`\n[agentport] job ${jobId}: ${status}\n`);
      return statusResult;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function handleServer(runtime, args) {
  const sub = String(args._[1] || "list").toLowerCase();
  if (sub === "list" || sub === "ls") {
    printJson(runtime.describe());
    return;
  }
  if (sub === "select" || sub === "connect") {
    const target = args._[2] || value(args, "server", "connection");
    if (!target) throw new Error("Usage: agentport server select <server-or-endpoint>");
    const selected = await runtime.selectServer(target, value(args, "endpoint"));
    printJson({ ok: true, server: selected.server.id, endpoint: selected.endpoint?.id || null });
    return;
  }
  if (sub === "health" || sub === "doctor") {
    const server = args._[2] || value(args, "server", "connection") || runtime.selectedServerId;
    const result = await runtime.probeServer(server, { force: Boolean(args.force) });
    printJson({
      server: result.server.id,
      workspaceId: result.server.workspaceId,
      endpoints: result.server.endpoints.map((endpoint) => ({ endpoint, health: result.healthByEndpoint[endpoint.id] })),
    });
    return;
  }
  throw new Error(`Unknown server command '${sub}'`);
}

async function handleProject(runtime, args) {
  const sub = String(args._[1] || "list").toLowerCase();
  if (sub === "list" || sub === "ls") {
    printJson({ projects: runtime.listProjects() });
    return;
  }
  if (sub === "status") {
    const name = args._[2];
    if (!name) throw new Error("Usage: agentport project status <project>");
    const result = await runtime.projectStatus(name);
    printResult({ ...result.data, _agentport: result.meta }, args);
    return;
  }
  if (sub === "run") {
    const name = args._[2];
    const action = args._[3];
    if (!name || !action) throw new Error("Usage: agentport project run <project> <action>");
    const result = await runtime.projectRun(name, action, {
      timeoutMs: timeoutValue(args),
      idempotencyKey: value(args, "idempotency-key", "idempotencyKey", "key"),
    });
    printJson({ ...result.data, _agentport: result.meta });
    if (args.follow && (result.data?.jobId || result.data?.taskId)) {
      await followJob(runtime, result.data.jobId || result.data.taskId, { ...args, server: result.meta.serverId });
    }
    return;
  }
  if (["logs", "follow", "cancel"].includes(sub)) {
    const jobId = args._[2];
    if (!jobId) throw new Error(`Usage: agentport project ${sub} <job-id>`);
    if (sub === "follow") return followJob(runtime, jobId, args);
    const operation = sub === "logs" ? "job_logs" : "job_cancel";
    const result = await runtime.invoke(operation, {
      jobId,
      server: value(args, "server", "connection"),
      cursor: value(args, "cursor"),
      maxBytes: value(args, "max-bytes", "maxBytes"),
      tailBytes: value(args, "tail-bytes", "tailBytes"),
    });
    printJson({ ...result.data, _agentport: result.meta });
    return;
  }
  throw new Error(`Unknown project command '${sub}'`);
}

async function handleJob(runtime, args, offset = 1) {
  const sub = String(args._[offset] || "list").toLowerCase();
  const server = value(args, "server", "connection");
  if (sub === "start" || sub === "run") {
    const command = value(args, "command") || args._.slice(offset + 1).join(" ");
    if (!command) throw new Error("Usage: agentport v3 job start <command>");
    const result = await runtime.invoke("remote_exec_async", {
      command,
      cwd: value(args, "cwd"),
      server,
      timeoutMs: timeoutValue(args),
      idempotencyKey: value(args, "idempotency-key", "idempotencyKey", "key"),
    });
    printJson({ ...result.data, _agentport: result.meta });
    if (args.follow) await followJob(runtime, result.data.jobId || result.data.taskId, { ...args, server: result.meta.serverId });
    return;
  }
  if (sub === "list" || sub === "ls") {
    const result = await runtime.invoke("job_list", { server, limit: value(args, "limit"), status: value(args, "status") });
    printJson({ ...result.data, _agentport: result.meta });
    return;
  }
  const jobId = args._[offset + 1];
  if (!jobId) throw new Error(`Usage: agentport v3 job ${sub} <job-id>`);
  if (sub === "follow") return followJob(runtime, jobId, args);
  const mapping = { status: "job_status", logs: "job_logs", cancel: "job_cancel", delete: "job_delete", remove: "job_delete" };
  const operation = mapping[sub];
  if (!operation) throw new Error(`Unknown job command '${sub}'`);
  const result = await runtime.invoke(operation, {
    jobId,
    server,
    cursor: value(args, "cursor"),
    maxBytes: value(args, "max-bytes", "maxBytes"),
    tailBytes: value(args, "tail-bytes", "tailBytes"),
  });
  printJson({ ...result.data, _agentport: result.meta });
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args._[0] === "v3") args._.shift();
  const command = String(args._[0] || "help").toLowerCase();
  if (["help", "--help", "-h"].includes(command)) {
    usage();
    return;
  }

  const runtime = await createClientRuntime({
    baseDir: ROOT,
    connectionsPath: value(args, "connections", "connections-path"),
    projectsPath: value(args, "projects", "projects-path") || undefined,
  });
  try {
    if (command === "server") await handleServer(runtime, args);
    else if (command === "project") await handleProject(runtime, args);
    else if (command === "job") await handleJob(runtime, args);
    else throw new Error(`Unknown modular command '${command}'`);
  } finally {
    runtime.close();
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]?.replace(/\\/g, "/")}`).href) {
  main().catch((error) => {
    const payload = { ok: false, error: error.message, code: error.code || null, details: error.details || null };
    if (process.argv.includes("--json")) printJson(payload);
    else process.stderr.write(`AgentPort: ${error.message}\n`);
    process.exitCode = 1;
  });
}
