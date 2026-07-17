const OPERATION_ALIASES = new Map([
  ["remote_ssh_info", "read"],
  ["remote_health", "read"],
  ["remote_status", "read"],
  ["remote_read", "read"],
  ["remote_stat", "read"],
  ["remote_glob", "read"],
  ["remote_grep", "read"],
  ["health", "read"],
  ["status", "read"],
  ["doctor", "read"],
  ["read", "read"],
  ["stat", "read"],
  ["glob", "read"],
  ["grep", "read"],
  ["remote_task", "job-read"],
  ["job_status", "job-read"],
  ["job_logs", "job-read"],
  ["job_list", "job-read"],
  ["remote_write", "write"],
  ["write", "write"],
  ["safe_write", "write"],
  ["safe_apply", "write"],
  ["remote_bash", "exec"],
  ["remote_script", "exec"],
  ["bash", "exec"],
  ["safe_bash", "exec"],
  ["script", "exec"],
  ["safe_script", "exec"],
  ["remote_exec_async", "job-start"],
  ["remote_script_async", "job-start"],
  ["job_start", "job-start"],
  ["safe_job", "job-start"],
  ["job_cancel", "job-control"],
  ["job_delete", "job-control"],
  ["remote_config_read", "admin-read"],
  ["remote_config_write", "admin-write"],
  ["token_list", "admin-read"],
  ["token_add", "admin-write"],
  ["token_revoke", "admin-write"],
]);

const POLICIES = Object.freeze({
  read: Object.freeze({
    class: "read",
    mutating: false,
    requiresExplicitTarget: false,
    requiresIdentityMatch: false,
    retryMode: "safe",
    fallbackMode: "verified-endpoint",
  }),
  "job-read": Object.freeze({
    class: "job-read",
    mutating: false,
    requiresExplicitTarget: true,
    requiresIdentityMatch: true,
    retryMode: "safe",
    fallbackMode: "same-server",
  }),
  write: Object.freeze({
    class: "write",
    mutating: true,
    requiresExplicitTarget: true,
    requiresIdentityMatch: true,
    retryMode: "idempotency-key",
    fallbackMode: "same-server",
  }),
  exec: Object.freeze({
    class: "exec",
    mutating: true,
    requiresExplicitTarget: true,
    requiresIdentityMatch: true,
    retryMode: "never-after-send",
    fallbackMode: "same-server",
  }),
  "job-start": Object.freeze({
    class: "job-start",
    mutating: true,
    requiresExplicitTarget: true,
    requiresIdentityMatch: true,
    retryMode: "idempotency-key",
    fallbackMode: "same-server",
  }),
  "job-control": Object.freeze({
    class: "job-control",
    mutating: true,
    requiresExplicitTarget: true,
    requiresIdentityMatch: true,
    retryMode: "idempotency-key",
    fallbackMode: "same-server",
  }),
  "admin-read": Object.freeze({
    class: "admin-read",
    mutating: false,
    requiresExplicitTarget: true,
    requiresIdentityMatch: true,
    retryMode: "safe",
    fallbackMode: "same-server",
  }),
  "admin-write": Object.freeze({
    class: "admin-write",
    mutating: true,
    requiresExplicitTarget: true,
    requiresIdentityMatch: true,
    retryMode: "never-after-send",
    fallbackMode: "never",
  }),
  unknown: Object.freeze({
    class: "unknown",
    mutating: true,
    requiresExplicitTarget: true,
    requiresIdentityMatch: true,
    retryMode: "never-after-send",
    fallbackMode: "never",
  }),
});

export function normalizeOperationName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export function classifyOperation(operation) {
  const normalized = normalizeOperationName(operation);
  if (!normalized) return "unknown";
  if (OPERATION_ALIASES.has(normalized)) return OPERATION_ALIASES.get(normalized);

  if (/^(read|stat|glob|grep|health|status|doctor)/.test(normalized)) return "read";
  if (/^(write|apply|patch)/.test(normalized)) return "write";
  if (/^(bash|exec|script|command)/.test(normalized)) return "exec";
  if (/^job_(status|logs|list|show)/.test(normalized)) return "job-read";
  if (/^job_(start|run)/.test(normalized)) return "job-start";
  if (/^job_(cancel|stop|delete|remove)/.test(normalized)) return "job-control";
  if (/^(config|token)_/.test(normalized)) return normalized.endsWith("read") || normalized.endsWith("list") ? "admin-read" : "admin-write";
  return "unknown";
}

export function getOperationPolicy(operation) {
  return POLICIES[classifyOperation(operation)] || POLICIES.unknown;
}

export function canRetryOperation({ operation, requestAccepted = false, idempotencyKey = "" } = {}) {
  const policy = getOperationPolicy(operation);
  if (policy.retryMode === "safe") return true;
  if (requestAccepted && policy.retryMode === "never-after-send") return false;
  if (policy.retryMode === "idempotency-key") return Boolean(String(idempotencyKey || "").trim());
  return !requestAccepted && policy.retryMode !== "never-after-send";
}

export function canFallbackOperation({ operation, identityMatch = false } = {}) {
  const policy = getOperationPolicy(operation);
  if (policy.fallbackMode === "never") return false;
  if (policy.fallbackMode === "verified-endpoint") return identityMatch !== false;
  return identityMatch === true;
}

export const operationPolicies = POLICIES;
