import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createClientRuntime } from "../packages/client-core/client-runtime.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const targetProperties = {
  server: { type: "string", description: "Logical server id. Defaults to the selected server." },
  connection: { type: "string", description: "Compatibility alias for server or endpoint id." },
  endpoint: { type: "string", description: "Optional explicit endpoint id." },
  project: { type: "string", description: "Optional project profile. Relative path/cwd values are resolved under the project root." },
};

const idempotencyProperties = {
  idempotencyKey: { type: "string", description: "Stable key for safe retry of a long-running task." },
};

function objectSchema(properties = {}, required = []) {
  return { type: "object", properties: { ...targetProperties, ...properties }, required };
}

function textResult(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function tools() {
  return [
    {
      name: "remote_connect",
      description: "Select a logical server or one of its LAN, virtual-LAN, or SSH endpoints for this MCP client session.",
      inputSchema: objectSchema({
        connection: { type: "string", description: "Logical server or endpoint id." },
      }),
    },
    {
      name: "remote_health",
      description: "Probe every endpoint of a logical server and report identity, latency, and capabilities.",
      inputSchema: objectSchema({ force: { type: "boolean" } }),
    },
    {
      name: "remote_status",
      description: "Show modular client configuration, selected server, endpoints, and project profiles.",
      inputSchema: objectSchema(),
    },
    {
      name: "remote_read",
      description: "Read a remote text file, optionally by line range.",
      inputSchema: objectSchema({
        path: { type: "string" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 }, maxBytes: { type: "integer", minimum: 1 },
      }, ["path"]),
    },
    {
      name: "remote_write",
      description: "Atomically write a remote text file with optional ETag conflict protection.",
      inputSchema: objectSchema({
        path: { type: "string" }, content: { type: "string" }, expectedEtag: { type: "string" }, createOnly: { type: "boolean" }, mode: { type: "integer" },
      }, ["path", "content"]),
    },
    {
      name: "remote_stat",
      description: "Read metadata for a remote path.",
      inputSchema: objectSchema({ path: { type: "string" } }, ["path"]),
    },
    {
      name: "remote_glob",
      description: "Find remote files by glob pattern.",
      inputSchema: objectSchema({ pattern: { type: "string" }, cwd: { type: "string" }, maxResults: { type: "integer" }, maxDepth: { type: "integer" } }, ["pattern"]),
    },
    {
      name: "remote_grep",
      description: "Search remote file contents with workspace and scan limits.",
      inputSchema: objectSchema({
        pattern: { type: "string" }, cwd: { type: "string" }, include: { type: ["string", "array"] }, excludeDirs: { type: "array", items: { type: "string" } }, maxResults: { type: "integer" }, maxFileBytes: { type: "integer" }, caseSensitive: { type: "boolean" }, regex: { type: "boolean" },
      }, ["pattern"]),
    },
    {
      name: "remote_bash",
      description: "Execute a synchronous command through the selected verified endpoint.",
      inputSchema: objectSchema({ command: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "integer", minimum: 0 } }, ["command"]),
    },
    {
      name: "remote_script",
      description: "Execute a synchronous multiline script without local shell escaping.",
      inputSchema: objectSchema({ content: { type: "string" }, interpreter: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "integer", minimum: 0 } }, ["content"]),
    },
    {
      name: "remote_exec_async",
      description: "Submit a persistent daemon Job with an idempotency key and return immediately.",
      inputSchema: objectSchema({ command: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "integer", minimum: 0 }, ...idempotencyProperties }, ["command"]),
    },
    {
      name: "remote_script_async",
      description: "Upload and submit a multiline script as a persistent daemon Job.",
      inputSchema: objectSchema({ content: { type: "string" }, interpreter: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "integer", minimum: 0 }, ...idempotencyProperties }, ["content"]),
    },
    {
      name: "remote_task",
      description: "Read persistent task status. Supply cursor/maxBytes to also receive only newly appended logs.",
      inputSchema: objectSchema({ taskId: { type: "string" }, cursor: { type: "string" }, maxBytes: { type: "integer", minimum: 1 } }, ["taskId"]),
    },
    {
      name: "remote_job_logs",
      description: "Read incremental stdout/stderr using a cursor returned by the previous call.",
      inputSchema: objectSchema({ jobId: { type: "string" }, cursor: { type: "string" }, maxBytes: { type: "integer", minimum: 1 }, tailBytes: { type: "integer", minimum: 1 } }, ["jobId"]),
    },
    {
      name: "remote_batch",
      description: "Execute up to 20 file/search/command operations through one selected endpoint.",
      inputSchema: objectSchema({ operations: { type: "array", maxItems: 20, items: { type: "object" } } }, ["operations"]),
    },
    {
      name: "remote_config",
      description: "Read or replace daemon configuration through a verified daemon endpoint.",
      inputSchema: objectSchema({ action: { type: "string", enum: ["read", "write"] }, config: { type: "string" } }, ["action"]),
    },
    {
      name: "remote_project_list",
      description: "List configured project profiles and their standard actions.",
      inputSchema: objectSchema(),
    },
    {
      name: "remote_project_status",
      description: "Read Git branch, HEAD, dirty count, and short status for a project profile.",
      inputSchema: objectSchema({ project: { type: "string" } }, ["project"]),
    },
    {
      name: "remote_project_run",
      description: "Run a configured project install/lint/test/build action as an idempotent persistent Job.",
      inputSchema: objectSchema({ project: { type: "string" }, action: { type: "string" }, timeoutMs: { type: "integer", minimum: 0 }, ...idempotencyProperties }, ["project", "action"]),
    },
    {
      name: "remote_ssh_info",
      description: "List SSH recovery endpoints already configured in the modular connection registry.",
      inputSchema: objectSchema(),
    },
    {
      name: "remote_setup",
      description: "Compatibility tool. V3 setup is file-based; use the returned paths or legacy client mode for the guided installer.",
      inputSchema: objectSchema(),
    },
  ];
}

const runtime = await createClientRuntime({
  baseDir: ROOT,
  connectionsPath: process.env.MCP_REMOTE_V3_CONNECTIONS_PATH || process.env.AGENTPORT_CONNECTIONS_PATH,
  projectsPath: process.env.AGENTPORT_PROJECTS_PATH || undefined,
});

const server = new Server(
  { name: "agentport", version: "3.0.0-client-runtime" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools() }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments && typeof request.params.arguments === "object"
    ? request.params.arguments
    : {};
  try {
    if (name === "remote_connect") {
      const target = args.connection || args.server || runtime.selectedServerId;
      const selected = await runtime.selectServer(target, args.endpoint);
      return textResult({ ok: true, server: selected.server.id, endpoint: selected.endpoint?.id || null, runtime: runtime.describe() });
    }
    if (name === "remote_health") {
      const target = args.server || args.connection || runtime.selectedServerId;
      const result = await runtime.probeServer(target, { force: Boolean(args.force) });
      return textResult({
        server: result.server.id,
        workspaceId: result.server.workspaceId,
        endpoints: result.server.endpoints.map((endpoint) => ({ endpoint, health: result.healthByEndpoint[endpoint.id] })),
      });
    }
    if (name === "remote_status") return textResult(runtime.describe());
    if (name === "remote_project_list") return textResult({ projects: runtime.listProjects() });
    if (name === "remote_project_status") return textResult(await runtime.projectStatus(args.project));
    if (name === "remote_project_run") return textResult(await runtime.projectRun(args.project, args.action, args));
    if (name === "remote_ssh_info") {
      const endpoints = runtime.registry.list().flatMap((item) => item.endpoints.filter((endpoint) => endpoint.type === "ssh").map((endpoint) => ({ server: item.id, ...endpoint })));
      return textResult({ endpoints });
    }
    if (name === "remote_setup") {
      return textResult({
        ok: false,
        mode: "v3",
        message: "Create local/connections.v3.json from local/connections.v3.json.example, or set AGENTPORT_CLIENT_MODE=legacy to use the guided legacy installer.",
        connectionsExample: path.join(ROOT, "local", "connections.v3.json.example"),
        projectsExample: path.join(ROOT, "local", "projects.json.example"),
      }, true);
    }
    if (name === "remote_config") {
      const operation = String(args.action || "").toLowerCase() === "write" ? "remote_config_write" : "remote_config_read";
      return textResult(await runtime.invoke(operation, args));
    }
    if (name === "remote_job_logs") return textResult(await runtime.invoke("job_logs", args));
    if (name === "remote_task") {
      const status = await runtime.invoke("remote_task", args);
      if (args.cursor !== undefined || args.maxBytes !== undefined) {
        const logs = await runtime.invoke("job_logs", { ...args, jobId: args.taskId });
        return textResult({ status, logs });
      }
      return textResult(status);
    }

    const supported = new Set([
      "remote_read", "remote_write", "remote_stat", "remote_glob", "remote_grep",
      "remote_bash", "remote_script", "remote_script_async", "remote_batch", "remote_exec_async",
    ]);
    if (!supported.has(name)) throw new Error(`Unknown tool '${name}'`);
    return textResult(await runtime.invoke(name, args));
  } catch (error) {
    return textResult({
      error: error.message,
      code: error.code || null,
      status: error.status || error.statusCode || null,
      details: error.details || null,
    }, true);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

async function shutdown() {
  runtime.close();
  try { await server.close(); } catch {}
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => shutdown().finally(() => process.exit(0)));
}
