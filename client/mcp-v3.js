import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createClientRuntime } from "../packages/client-core/client-runtime.js";
import { createDevelopmentSessionClient } from "../packages/client-core/development-sessions.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetProperties = {
  server: { type: "string", description: "Logical server id. Defaults to the selected server." },
  connection: { type: "string", description: "Compatibility alias for server or endpoint id." },
  endpoint: { type: "string", description: "Optional explicit endpoint id." },
  project: { type: "string", description: "Optional project profile. Relative path/cwd values are resolved under the project root." },
};
const idempotencyProperties = { idempotencyKey: { type: "string", description: "Stable key for safe retry of a long-running task." } };
function objectSchema(properties = {}, required = []) { return { type: "object", properties: { ...targetProperties, ...properties }, required }; }
function textResult(value, isError = false) { const text = typeof value === "string" ? value : JSON.stringify(value, null, 2); return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) }; }
function tools() { return [
  { name: "remote_connect", description: "Select a logical server or one of its LAN, virtual-LAN, or SSH endpoints for this MCP client session.", inputSchema: objectSchema({ connection: { type: "string", description: "Logical server or endpoint id." } }) },
  { name: "remote_health", description: "Probe every endpoint of a logical server and report identity, latency, and capabilities.", inputSchema: objectSchema({ force: { type: "boolean" } }) },
  { name: "remote_status", description: "Show modular client configuration, selected server, endpoints, and project profiles.", inputSchema: objectSchema() },
  { name: "remote_read", description: "Read a remote text file, optionally by line range.", inputSchema: objectSchema({ path: { type: "string" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 }, maxBytes: { type: "integer", minimum: 1 } }, ["path"]) },
  { name: "remote_write", description: "Atomically write a remote text file with optional ETag conflict protection.", inputSchema: objectSchema({ path: { type: "string" }, content: { type: "string" }, expectedEtag: { type: "string" }, createOnly: { type: "boolean" }, mode: { type: "integer" } }, ["path", "content"]) },
  { name: "remote_stat", description: "Read metadata for a remote path.", inputSchema: objectSchema({ path: { type: "string" } }, ["path"]) },
  { name: "remote_glob", description: "Find remote files by glob pattern.", inputSchema: objectSchema({ pattern: { type: "string" }, cwd: { type: "string" }, maxResults: { type: "integer" }, maxDepth: { type: "integer" } }, ["pattern"]) },
  { name: "remote_grep", description: "Search remote file contents with workspace and scan limits.", inputSchema: objectSchema({ pattern: { type: "string" }, cwd: { type: "string" }, include: { type: ["string", "array"] }, excludeDirs: { type: "array", items: { type: "string" } }, maxResults: { type: "integer" }, maxFileBytes: { type: "integer" }, caseSensitive: { type: "boolean" }, regex: { type: "boolean" } }, ["pattern"]) },
  { name: "remote_bash", description: "Execute a synchronous command through the selected verified endpoint.", inputSchema: objectSchema({ command: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "integer", minimum: 0 } }, ["command"]) },
  { name: "remote_script", description: "Execute a synchronous multiline script without local shell escaping.", inputSchema: objectSchema({ content: { type: "string" }, interpreter: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "integer", minimum: 0 } }, ["content"]) },
  { name: "remote_exec_async", description: "Submit a persistent daemon Job with an idempotency key and return immediately.", inputSchema: objectSchema({ command: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "integer", minimum: 0 }, ...idempotencyProperties }, ["command"]) },
  { name: "remote_script_async", description: "Upload and submit a multiline script as a persistent daemon Job.", inputSchema: objectSchema({ content: { type: "string" }, interpreter: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "integer", minimum: 0 }, ...idempotencyProperties }, ["content"]) },
  { name: "remote_task", description: "Read persistent task status. Supply cursor/maxBytes to also receive only newly appended logs.", inputSchema: objectSchema({ taskId: { type: "string" }, cursor: { type: "string" }, maxBytes: { type: "integer", minimum: 1 } }, ["taskId"]) },
  { name: "remote_job_logs", description: "Read incremental stdout/stderr using a cursor returned by the previous call.", inputSchema: objectSchema({ jobId: { type: "string" }, cursor: { type: "string" }, maxBytes: { type: "integer", minimum: 1 }, tailBytes: { type: "integer", minimum: 1 } }, ["jobId"]) },
  { name: "remote_batch", description: "Execute up to 20 file/search/command operations through one selected endpoint.", inputSchema: objectSchema({ operations: { type: "array", maxItems: 20, items: { type: "object" } } }, ["operations"]) },
  { name: "remote_config", description: "Read or replace daemon configuration through a verified daemon endpoint.", inputSchema: objectSchema({ action: { type: "string", enum: ["read", "write"] }, config: { type: "string" } }, ["action"]) },
  { name: "remote_project_list", description: "List configured project profiles and their standard actions.", inputSchema: objectSchema() },
  { name: "remote_project_status", description: "Read Git branch, HEAD, dirty count, and short status for a project profile.", inputSchema: objectSchema({ project: { type: "string" } }, ["project"]) },
  { name: "remote_project_run", description: "Run a configured project install/lint/test/build action as an idempotent persistent Job.", inputSchema: objectSchema({ project: { type: "string" }, action: { type: "string" }, timeoutMs: { type: "integer", minimum: 0 }, ...idempotencyProperties }, ["project", "action"]) },
  { name: "remote_development_overview", description: "Show active Worktree sessions and persistent Jobs on a logical server.", inputSchema: objectSchema({ limit: { type: "integer", minimum: 1 } }) },
  { name: "remote_session_list", description: "List active and historical Agent development sessions.", inputSchema: objectSchema({ status: { type: "string" }, projectName: { type: "string" }, limit: { type: "integer", minimum: 1 } }) },
  { name: "remote_session_create", description: "Create an isolated Git Worktree session for a configured project.", inputSchema: objectSchema({ project: { type: "string" }, agentId: { type: "string" }, task: { type: "string" }, baseRef: { type: "string" }, targetBranch: { type: "string" }, branchName: { type: "string" }, leaseMs: { type: "integer", minimum: 60000 } }, ["project"]) },
  { name: "remote_session_status", description: "Read session lease, Worktree, Git, rule files, and attached Job status.", inputSchema: objectSchema({ sessionId: { type: "string" } }, ["sessionId"]) },
  { name: "remote_session_heartbeat", description: "Renew an active Agent session lease.", inputSchema: objectSchema({ sessionId: { type: "string" }, agentId: { type: "string" }, leaseMs: { type: "integer", minimum: 60000 } }, ["sessionId"]) },
  { name: "remote_session_run", description: "Run a configured project action or explicit command inside the session Worktree as a persistent Job.", inputSchema: objectSchema({ sessionId: { type: "string" }, action: { type: "string" }, command: { type: "string" }, timeoutMs: { type: "integer", minimum: 0 }, resourceClass: { type: "string" }, ...idempotencyProperties }, ["sessionId"]) },
  { name: "remote_session_diff", description: "Read Worktree status, diff stat, working diff, and staged diff.", inputSchema: objectSchema({ sessionId: { type: "string" }, maxBytes: { type: "integer", minimum: 1024 } }, ["sessionId"]) },
  { name: "remote_session_commit", description: "Commit all session Worktree changes without pushing.", inputSchema: objectSchema({ sessionId: { type: "string" }, message: { type: "string" }, authorName: { type: "string" }, authorEmail: { type: "string" }, addAll: { type: "boolean" } }, ["sessionId", "message"]) },
  { name: "remote_session_rollback", description: "Discard session Worktree changes. Requires confirm equal to sessionId.", inputSchema: objectSchema({ sessionId: { type: "string" }, confirm: { type: "string" }, mode: { type: "string", enum: ["working-tree", "base"] } }, ["sessionId", "confirm"]) },
  { name: "remote_session_merge", description: "Merge the committed session branch into the clean primary project Worktree. Requires confirm equal to sessionId.", inputSchema: objectSchema({ sessionId: { type: "string" }, confirm: { type: "string" }, targetBranch: { type: "string" }, strategy: { type: "string", enum: ["no-ff", "ff-only"] }, message: { type: "string" }, force: { type: "boolean" } }, ["sessionId", "confirm"]) },
  { name: "remote_session_cleanup", description: "Remove a session Worktree and optionally its branch. Force/delete requires confirm equal to sessionId.", inputSchema: objectSchema({ sessionId: { type: "string" }, confirm: { type: "string" }, deleteBranch: { type: "boolean" }, force: { type: "boolean" } }, ["sessionId"]) },
  { name: "remote_ssh_info", description: "List SSH recovery endpoints already configured in the modular connection registry.", inputSchema: objectSchema() },
  { name: "remote_setup", description: "Compatibility tool. V3 setup is file-based; use the returned paths or legacy client mode for the guided installer.", inputSchema: objectSchema() },
]; }

const runtime = await createClientRuntime({ baseDir: ROOT, connectionsPath: process.env.MCP_REMOTE_V3_CONNECTIONS_PATH || process.env.AGENTPORT_CONNECTIONS_PATH, projectsPath: process.env.AGENTPORT_PROJECTS_PATH || undefined });
const sessions = createDevelopmentSessionClient(runtime);
const server = new Server({ name: "agentport", version: "3.1.0-development-sessions" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools() }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments && typeof request.params.arguments === "object" ? request.params.arguments : {};
  try {
    if (name === "remote_connect") { const target = args.connection || args.server || runtime.selectedServerId; const selected = await runtime.selectServer(target, args.endpoint); return textResult({ ok: true, server: selected.server.id, endpoint: selected.endpoint?.id || null, runtime: runtime.describe() }); }
    if (name === "remote_health") { const target = args.server || args.connection || runtime.selectedServerId; const result = await runtime.probeServer(target, { force: Boolean(args.force) }); return textResult({ server: result.server.id, workspaceId: result.server.workspaceId, endpoints: result.server.endpoints.map((endpoint) => ({ endpoint, health: result.healthByEndpoint[endpoint.id] })) }); }
    if (name === "remote_status") return textResult(runtime.describe());
    if (name === "remote_project_list") return textResult({ projects: runtime.listProjects() });
    if (name === "remote_project_status") return textResult(await runtime.projectStatus(args.project));
    if (name === "remote_project_run") return textResult(await runtime.projectRun(args.project, args.action, args));
    if (name === "remote_development_overview") return textResult(await sessions.overview(args));
    if (name === "remote_session_list") return textResult(await sessions.list(args));
    if (name === "remote_session_create") return textResult(await sessions.create(args.project, args));
    if (name === "remote_session_status") return textResult(await sessions.status(args.sessionId, args));
    if (name === "remote_session_heartbeat") return textResult(await sessions.heartbeat(args.sessionId, args));
    if (name === "remote_session_run") return textResult(await sessions.run(args.sessionId, args.action, args));
    if (name === "remote_session_diff") return textResult(await sessions.diff(args.sessionId, args));
    if (name === "remote_session_commit") return textResult(await sessions.commit(args.sessionId, args.message, args));
    if (name === "remote_session_rollback") return textResult(await sessions.rollback(args.sessionId, args));
    if (name === "remote_session_merge") return textResult(await sessions.merge(args.sessionId, args));
    if (name === "remote_session_cleanup") return textResult(await sessions.cleanup(args.sessionId, args));
    if (name === "remote_ssh_info") { const endpoints = runtime.registry.list().flatMap((item) => item.endpoints.filter((endpoint) => endpoint.type === "ssh").map((endpoint) => ({ server: item.id, ...endpoint }))); return textResult({ endpoints }); }
    if (name === "remote_setup") return textResult({ ok: false, mode: "v3", message: "Create local/connections.v3.json from local/connections.v3.json.example, or set AGENTPORT_CLIENT_MODE=legacy to use the guided legacy installer.", connectionsExample: path.join(ROOT, "local", "connections.v3.json.example"), projectsExample: path.join(ROOT, "local", "projects.json.example") }, true);
    if (name === "remote_config") { const operation = String(args.action || "").toLowerCase() === "write" ? "remote_config_write" : "remote_config_read"; return textResult(await runtime.invoke(operation, args)); }
    if (name === "remote_job_logs") return textResult(await runtime.invoke("job_logs", args));
    if (name === "remote_task") { const status = await runtime.invoke("remote_task", args); if (args.cursor !== undefined || args.maxBytes !== undefined) { const logs = await runtime.invoke("job_logs", { ...args, jobId: args.taskId }); return textResult({ status, logs }); } return textResult(status); }
    const supported = new Set(["remote_read", "remote_write", "remote_stat", "remote_glob", "remote_grep", "remote_bash", "remote_script", "remote_script_async", "remote_batch", "remote_exec_async"]);
    if (!supported.has(name)) throw new Error(`Unknown tool '${name}'`);
    return textResult(await runtime.invoke(name, args));
  } catch (error) { return textResult({ error: error.message, code: error.code || null, status: error.status || error.statusCode || null, details: error.details || null }, true); }
});
const transport = new StdioServerTransport();
await server.connect(transport);
async function shutdown() { sessions.close(); runtime.close(); try { await server.close(); } catch {} }
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => shutdown().finally(() => process.exit(0)));
