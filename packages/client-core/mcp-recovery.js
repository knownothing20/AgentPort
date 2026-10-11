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

export function toolResultError(result, name) {
  if (!result?.isError) return null;
  const message = (result.content || []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
  const error = new Error(message || "Tool returned an error result");
  error.code = result.structuredContent?.code || "ETOOL";
  if (error.code === "EOUTCOME_UNKNOWN") error.outcome = "unknown";
  // The caller already receives the full output. Diagnostics need the outcome,
  // not another copy of an arbitrarily large build log.
  if (name === "remote_task") {
    try {
      const data = JSON.parse(message);
      if (["error", "failed", "timeout", "cancelled", "orphaned"].includes(data.status)
        || (typeof data.exitCode === "number" && data.exitCode !== 0)) {
        error.failureCategory = "command-failed";
        error.message = "Remote job failed; inspect the task output and exit code.";
      }
    } catch {}
  } else if (["remote_bash", "remote_script"].includes(name) && /^(?:STDOUT:|STDERR:|EXIT_CODE:|SIGNAL:)/.test(message)) {
    error.failureCategory = "command-failed";
    error.message = "Remote command failed; inspect the returned output and exit code.";
  } else if (name === "remote_batch" && /Batch completed:/.test(message)) {
    error.message = "A batch operation failed; inspect the individual operation results.";
  }
  return error;
}

export function failureDetails(error) {
  const code = error?.code;
  const cause = error?.cause?.code;
  const status = error?.response?.status || error?.cause?.response?.status;
  const message = String(error?.message || "");
  let category = error?.failureCategory || "other";
  if (code === "EOUTCOME_UNKNOWN") category = "outcome-unknown";
  else if (category !== "command-failed") {
    if (code === "EWORKSPACE" || /outside configured workspace|workspace.*denied/i.test(message)) category = "workspace-denied";
    else if (code === "ENOSPC" || /\bENOSPC\b|no space left on device/i.test(message)) category = "disk-full";
    else if (code === "EREGEX" || /Invalid regular expression/i.test(message)) category = "invalid-regex";
    else if (status === 401 || status === 403 || /HTTP (?:401|403)\b/.test(message)) category = "auth-denied";
    else if (code === "ENOENT" || status === 404 || /Not found \(HTTP 404\)|No such file/i.test(message)) category = "missing-file";
    else if ([code, cause].some((value) => /^(?:ECONNRESET|ECONNABORTED|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)$/.test(value || ""))
      || /timeout|timed out|Transport closed/i.test(message)) category = "transport";
  }
  const descriptions = {
    "outcome-unknown": ["Execution outcome is unknown.", "Do not replay. Reconcile the original task handle and target state."],
    "command-failed": ["The remote command or job failed.", "Inspect its output and exit code; a failed command does not imply a connection failure."],
    "workspace-denied": ["The workspace boundary denied access.", "Check the authorized path; do not retry via another route to bypass the denial."],
    "auth-denied": ["Authentication or authorization was denied.", "Check the selected connection identity and permissions without printing credentials."],
    "missing-file": ["The requested resource was not found.", "Check the selected workspace and path before another request."],
    "invalid-regex": ["The search expression is invalid.", "Daemon regex uses JavaScript syntax. Use caseSensitive:false instead of (?i), or literal search."],
    "disk-full": ["The target reported insufficient disk space.", "Inspect free space and inodes. Do not replay writes or delete files automatically."],
    "transport": ["The transport did not complete normally.", "For writes or execution, reconcile the original outcome before any retry. Use jobs for long commands."],
    "other": ["The tool returned an error.", "Inspect the original tool response for details."],
  };
  const [summary, hint] = descriptions[category] || descriptions.other;
  return { failureCategory: Object.hasOwn(descriptions, category) ? category : "other", summary, hint };
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
