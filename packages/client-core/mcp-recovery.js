const UNSENT_CODES = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL",
]);
const READ_TOOLS = new Set([
  "tools/list", "remote_read", "remote_stat", "remote_glob", "remote_grep",
  "remote_health", "remote_status", "remote_task", "remote_ssh_info",
]);
const READ_POST_PATHS = new Set([
  "/api/fs/read", "/read", "/api/fs/stat", "/stat", "/api/fs/glob", "/glob",
  "/api/fs/grep", "/grep", "/api/fs/read-bytes", "/api/fs/manifest",
]);

export function definitelyNotSent(error) {
  return !error?.response && UNSENT_CODES.has(error?.code || error?.cause?.code);
}

export function replaySafeTool(name, args = {}) {
  if (READ_TOOLS.has(name)) return true;
  if (name === "remote_connect") return !args.connection;
  if (name === "remote_config") return args.action === "read";
  return name === "remote_batch" && Array.isArray(args.operations)
    && args.operations.length > 0
    && args.operations.every((op) => ["read", "stat", "glob", "grep"].includes(op?.type));
}

export function replaySafePost(paths) {
  return paths.length > 0 && paths.every((route) => READ_POST_PATHS.has(route));
}

export function outcomeUnknown(operation, cause) {
  const error = new Error(`${operation}: execution outcome is UNKNOWN; the original operation may have run. Do not resubmit; reconcile its handle and target state first.`, { cause });
  error.code = "EOUTCOME_UNKNOWN";
  error.outcome = "unknown";
  error.retryable = false;
  return error;
}

export async function recoverBrokerCall({ operation, args, broker, request, refresh, invalidate, fallback, warn }) {
  const safe = replaySafeTool(operation, args);
  async function attempt(target) {
    try {
      return { result: await request(target) };
    } catch (error) {
      const status = error?.response?.status;
      // A permission or validation response is not a transport outage.
      if (status && status < 500) throw error;
      if (!safe && !definitelyNotSent(error)) throw outcomeUnknown(operation, error);
      return { error };
    }
  }
  const first = await attempt(broker);
  if (!first.error) return first.result;
  invalidate(broker);
  warn(first.error, broker);
  const replacement = await refresh(broker);
  if (replacement && (replacement.url !== broker.url || replacement.token !== broker.token)) {
    const second = await attempt(replacement);
    if (!second.error) return second.result;
    invalidate(replacement);
  }
  return fallback();
}

export function toolResultError(result) {
  if (!result?.isError) return null;
  const message = (result.content || []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
  const error = new Error(message || "Tool returned an error result");
  error.code = result.structuredContent?.code || "ETOOL";
  if (error.code === "EOUTCOME_UNKNOWN") error.outcome = "unknown";
  return error;
}

export function normalizeToolResult(name, result) {
  if (result?.isError || ![
    "remote_connect", "remote_stat", "remote_script_async", "remote_exec_async",
    "remote_task", "remote_config", "remote_setup",
  ].includes(name)) return result;
  try {
    const text = result.content?.find((item) => item.type === "text")?.text;
    const data = JSON.parse(text);
    if (data?.error || data?.success === false || data?.ok === false) return { ...result, isError: true };
  } catch {}
  return result;
}

export function jobResultSummary(name, result) {
  if (!["remote_script_async", "remote_exec_async", "remote_task"].includes(name)) return {};
  try {
    const data = JSON.parse(result?.content?.find((item) => item.type === "text")?.text);
    return {
      ...(typeof data.taskId === "string" ? { taskId: data.taskId } : {}),
      ...(typeof data.status === "string" ? { executionStatus: data.status } : {}),
    };
  } catch {
    return {};
  }
}

export function batchItemFailed(item) {
  const code = item?.code ?? item?.exitCode;
  return item?.status >= 400 || Boolean(item?.error) || Boolean(item?.signal)
    || (typeof code === "number" && code !== 0);
}
