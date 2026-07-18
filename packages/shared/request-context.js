import { randomUUID } from "node:crypto";
import { getOperationPolicy, normalizeOperationName } from "./operation-policy.js";

export function createRequestContext({
  operation,
  serverId = null,
  workspaceId = null,
  connection = null,
  endpointId = null,
  route = null,
  traceId = null,
  sessionId = null,
  clientId = null,
  idempotencyKey = null,
  startedAt = new Date().toISOString(),
} = {}) {
  const operationName = normalizeOperationName(operation) || "unknown";
  const context = {
    requestId: randomUUID(),
    traceId: traceId || randomUUID(),
    sessionId,
    clientId,
    operation: operationName,
    policy: getOperationPolicy(operationName),
    serverId,
    workspaceId,
    connection,
    endpointId,
    route,
    idempotencyKey,
    startedAt,
  };
  return Object.freeze(context);
}

export function bindRequestEndpoint(context, endpoint, identity = {}) {
  if (!context || typeof context !== "object") throw new TypeError("context is required");
  if (!endpoint || typeof endpoint !== "object") throw new TypeError("endpoint is required");

  return Object.freeze({
    ...context,
    connection: endpoint.connection || endpoint.name || context.connection,
    endpointId: endpoint.id || endpoint.name || context.endpointId,
    route: endpoint.route || endpoint.type || context.route,
    serverId: identity.serverId || context.serverId,
    workspaceId: identity.workspaceId || context.workspaceId,
  });
}
