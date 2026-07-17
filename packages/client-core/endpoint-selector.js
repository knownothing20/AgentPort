import { getOperationPolicy } from "../shared/operation-policy.js";

function endpointId(endpoint) {
  return endpoint?.id || endpoint?.name || "";
}

function endpointIdentityState(server, observed = {}) {
  const hasServerIdentity = Boolean(observed.serverId);
  const hasWorkspaceIdentity = Boolean(observed.workspaceId);

  if (server?.id && hasServerIdentity && server.id !== observed.serverId) return "mismatch";
  if (server?.workspaceId && hasWorkspaceIdentity && server.workspaceId !== observed.workspaceId) return "mismatch";

  const serverKnown = !server?.id || hasServerIdentity;
  const workspaceKnown = !server?.workspaceId || hasWorkspaceIdentity;
  return serverKnown && workspaceKnown ? "match" : "unknown";
}

function endpointScore(endpoint, health, preferredEndpointId) {
  const priority = Number.isFinite(Number(endpoint.priority)) ? Number(endpoint.priority) : 100;
  const latency = Number.isFinite(Number(health?.latencyMs)) ? Number(health.latencyMs) : 10_000;
  const preferredBonus = endpointId(endpoint) === preferredEndpointId ? -1_000_000 : 0;
  const routePenalty = endpoint.type === "ssh" ? 20_000 : endpoint.scope === "virtual-lan" ? 5_000 : 0;
  return preferredBonus + priority * 1_000 + routePenalty + latency;
}

export function verifyEndpointIdentity(server, health) {
  return endpointIdentityState(server, health || {}) === "match";
}

export function selectEndpoint({
  server,
  operation,
  healthByEndpoint = {},
  preferredEndpointId = "",
  allowUnknownHealth = false,
} = {}) {
  if (!server || typeof server !== "object") throw new TypeError("server is required");
  const endpoints = Array.isArray(server.endpoints) ? server.endpoints : [];
  if (endpoints.length === 0) throw new Error(`Server '${server.id || "unknown"}' has no endpoints`);

  const policy = getOperationPolicy(operation);
  const candidates = [];
  const rejected = [];

  for (const endpoint of endpoints) {
    const id = endpointId(endpoint);
    if (!id || endpoint.enabled === false) {
      rejected.push({ id, reason: "disabled-or-missing-id" });
      continue;
    }

    const health = healthByEndpoint[id];
    if (!health && !allowUnknownHealth) {
      rejected.push({ id, reason: "health-unknown" });
      continue;
    }
    if (health && health.ok === false) {
      rejected.push({ id, reason: "unhealthy" });
      continue;
    }

    const identityState = health ? endpointIdentityState(server, health) : "unknown";
    if (identityState === "mismatch") {
      rejected.push({ id, reason: "identity-mismatch" });
      continue;
    }
    if (policy.requiresIdentityMatch && identityState !== "match") {
      rejected.push({ id, reason: "identity-unverified" });
      continue;
    }

    candidates.push({
      endpoint,
      health: health || null,
      identityMatch: identityState === "match",
      identityState,
      score: endpointScore(endpoint, health, preferredEndpointId),
    });
  }

  candidates.sort((a, b) => a.score - b.score || endpointId(a.endpoint).localeCompare(endpointId(b.endpoint)));
  const selected = candidates[0];
  if (!selected) {
    const error = new Error(`No compatible endpoint for '${operation || "unknown"}' on server '${server.id || "unknown"}'`);
    error.code = "ENOENDPOINT";
    error.details = { operation, policy, rejected };
    throw error;
  }

  return {
    endpoint: selected.endpoint,
    health: selected.health,
    identityMatch: selected.identityMatch,
    identityState: selected.identityState,
    policy,
    rejected,
    reason: preferredEndpointId && endpointId(selected.endpoint) === preferredEndpointId
      ? "preferred-endpoint"
      : "best-healthy-endpoint",
  };
}
