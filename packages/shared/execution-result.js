const FAILED_STATUSES = new Set([
  "error", "failed", "timeout", "timed_out", "cancelled", "canceled", "orphaned",
]);

function exitCode(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed === 0) return 0;
  return parsed > 0 && parsed <= 255 ? parsed : 1;
}

export function executionExitCode(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const code = executionExitCode(item);
      if (code !== 0) return code;
    }
    return 0;
  }
  if (!value || typeof value !== "object") return 0;

  for (const key of ["data", "results", "result", "job"]) {
    if (value[key] && typeof value[key] === "object") {
      const code = executionExitCode(value[key]);
      if (code !== 0) return code;
    }
  }

  const commandCode = exitCode(value.code);
  if (commandCode !== 0) return commandCode;
  const jobCode = exitCode(value.exitCode);
  if (jobCode !== 0) return jobCode;

  const numericStatus = Number(value.status);
  if (Number.isInteger(numericStatus) && numericStatus >= 400) return 1;
  if (FAILED_STATUSES.has(String(value.status || "").toLowerCase())) return 1;
  if (value.timedOut === true || value.timeout === true) return 1;
  if (value.error || value.signal || value.outcome === "unknown" || value.code === "EOUTCOME_UNKNOWN") return 1;
  if (["ETIMEDOUT", "ETIMEOUT"].includes(String(value.code || "").toUpperCase())) return 1;
  if (value.ok === false || value.success === false) return 1;
  return 0;
}
