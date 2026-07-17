import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

function queryPath(route, query = {}) {
  const url = new URL(route, "http://agentport.local");
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

function parseBody(buffer, headers) {
  const raw = buffer.toString("utf8");
  if (!raw) return null;
  const contentType = String(headers["content-type"] || "");
  if (contentType.includes("json")) {
    try { return JSON.parse(raw); } catch { return { raw }; }
  }
  try { return JSON.parse(raw); } catch { return raw; }
}

export class DaemonHttpError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "DaemonHttpError";
    Object.assign(this, details);
  }
}

export function isTransportError(error) {
  if (!error) return false;
  if (error.transport === true) return true;
  return new Set([
    "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ECONNABORTED",
    "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND",
  ]).has(error.code);
}

export function createDaemonHttpTransport(endpoint, {
  timeoutMs = Number(endpoint?.timeoutMs || process.env.MCP_REMOTE_TIMEOUT_MS || 120_000),
  maxResponseBytes = 50 * 1024 * 1024,
} = {}) {
  if (!endpoint?.url) throw new TypeError("daemon endpoint url is required");
  const baseUrl = new URL(String(endpoint.url).replace(/\/+$/, "") + "/");
  const transport = baseUrl.protocol === "https:" ? https : http;
  const httpAgent = baseUrl.protocol === "https:"
    ? new https.Agent({ keepAlive: true, maxSockets: 8 })
    : new http.Agent({ keepAlive: true, maxSockets: 8 });

  function contextHeaders(context = {}) {
    return {
      ...(endpoint.authToken ? { authorization: `Bearer ${endpoint.authToken}` } : {}),
      ...(endpoint.clientId ? { "x-mcp-client-id": endpoint.clientId } : {}),
      ...(context.traceId ? { "x-agentport-trace-id": context.traceId } : {}),
      ...(context.sessionId ? { "x-agentport-session-id": context.sessionId } : {}),
      ...(context.requestId ? { "x-agentport-call-id": context.requestId } : {}),
      ...(context.operation ? { "x-agentport-tool": context.operation } : {}),
      ...(context.idempotencyKey ? { "idempotency-key": context.idempotencyKey } : {}),
    };
  }

  async function request({
    method = "GET",
    route = "/",
    query,
    body,
    headers = {},
    context = {},
    requestTimeoutMs = timeoutMs,
    acceptStatuses = [],
  } = {}) {
    const target = new URL(queryPath(route, query), baseUrl);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    let requestAccepted = false;

    return new Promise((resolve, reject) => {
      const req = transport.request(target, {
        method,
        agent: httpAgent,
        headers: {
          accept: "application/json",
          ...contextHeaders(context),
          ...headers,
          ...(payload ? {
            "content-type": "application/json; charset=utf-8",
            "content-length": String(payload.length),
          } : {}),
        },
      }, (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxResponseBytes) {
            response.destroy(new DaemonHttpError(`Response exceeds ${maxResponseBytes} bytes`, {
              code: "ERESPONSE_TOO_LARGE",
              transport: false,
              requestAccepted: true,
            }));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", (error) => reject(new DaemonHttpError(error.message, {
          cause: error,
          code: error.code,
          transport: true,
          requestAccepted: true,
        })));
        response.on("end", () => {
          const buffer = Buffer.concat(chunks);
          const data = parseBody(buffer, response.headers);
          const status = response.statusCode || 500;
          if ((status >= 200 && status < 300) || acceptStatuses.includes(status)) {
            resolve({ status, headers: response.headers, data, raw: buffer });
            return;
          }
          const message = data?.error || data?.message || `Daemon request failed (${status})`;
          reject(new DaemonHttpError(message, {
            status,
            code: data?.code || null,
            currentEtag: data?.currentEtag || null,
            details: data,
            transport: false,
            requestAccepted: true,
          }));
        });
      });

      req.setTimeout(requestTimeoutMs, () => {
        req.destroy(Object.assign(new Error(`Daemon request timed out after ${requestTimeoutMs}ms`), { code: "ETIMEDOUT" }));
      });
      req.on("finish", () => { requestAccepted = true; });
      req.on("error", (error) => {
        reject(new DaemonHttpError(error.message, {
          cause: error,
          code: error.code,
          transport: true,
          requestAccepted,
          endpointId: endpoint.id,
        }));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  async function health(context) {
    const started = Date.now();
    const response = await request({ method: "GET", route: "/healthz", context, requestTimeoutMs: Math.min(timeoutMs, 10_000) });
    return {
      ok: response.status < 400 && response.data?.ok !== false,
      latencyMs: Date.now() - started,
      serverId: response.data?.serverId || null,
      workspaceId: response.data?.workspaceId || null,
      workspaceRoot: response.data?.workspaceRoot || response.data?.workspace?.root || null,
      capabilities: response.data?.capabilities || {},
      data: response.data,
    };
  }

  async function invoke(operation, args = {}, context = {}) {
    switch (operation) {
      case "remote_health": return health(context);
      case "remote_read": return (await request({ method: "POST", route: "/api/fs/read", body: args, context, acceptStatuses: [304] })).data;
      case "remote_write": return (await request({ method: "POST", route: "/api/fs/write", body: args, context })).data;
      case "remote_stat": return (await request({ method: "POST", route: "/api/fs/stat", body: args, context })).data;
      case "remote_glob": return (await request({ method: "POST", route: "/api/fs/glob", body: args, context })).data;
      case "remote_grep": return (await request({ method: "POST", route: "/api/fs/grep", body: args, context })).data;
      case "remote_bash": return (await request({ method: "POST", route: "/api/exec", body: args, context, requestTimeoutMs: args.timeoutMs || timeoutMs })).data;
      case "remote_script": return (await request({ method: "POST", route: "/api/exec/script", body: args, context, requestTimeoutMs: args.timeoutMs || timeoutMs })).data;
      case "remote_batch": return (await request({ method: "POST", route: "/api/batch", body: args, context })).data;
      case "remote_exec_async":
      case "remote_script_async": {
        return (await request({
          method: "POST",
          route: "/api/exec/async",
          body: args,
          context,
          headers: context.idempotencyKey ? { "idempotency-key": context.idempotencyKey } : {},
        })).data;
      }
      case "remote_task": {
        const taskId = encodeURIComponent(args.taskId || args.jobId || args.id || "");
        if (!taskId) throw new TypeError("taskId is required");
        return (await request({ method: "GET", route: `/api/task/${taskId}`, context })).data;
      }
      case "job_status": {
        const jobId = encodeURIComponent(args.jobId || args.taskId || args.id || "");
        return (await request({ method: "GET", route: `/api/jobs/${jobId}`, context })).data;
      }
      case "job_logs": {
        const jobId = encodeURIComponent(args.jobId || args.taskId || args.id || "");
        return (await request({
          method: "GET",
          route: `/api/jobs/${jobId}/logs`,
          query: {
            cursor: args.cursor,
            maxBytes: args.maxBytes,
            tailBytes: args.tailBytes,
          },
          context,
        })).data;
      }
      case "job_list": return (await request({ method: "GET", route: "/api/jobs", query: args, context })).data;
      case "job_cancel": {
        const jobId = encodeURIComponent(args.jobId || args.taskId || args.id || "");
        return (await request({ method: "POST", route: `/api/jobs/${jobId}/cancel`, body: {}, context })).data;
      }
      case "job_delete": {
        const jobId = encodeURIComponent(args.jobId || args.taskId || args.id || "");
        return (await request({ method: "DELETE", route: `/api/jobs/${jobId}`, context })).data;
      }
      case "remote_config_read": return (await request({ method: "GET", route: "/api/config", query: { raw: 1 }, context })).data;
      case "remote_config_write": return (await request({ method: "PUT", route: "/api/config", body: { config: args.config }, context })).data;
      default: throw new Error(`Unsupported daemon operation '${operation}'`);
    }
  }

  return Object.freeze({ endpoint, request, health, invoke, close: () => httpAgent.destroy() });
}
