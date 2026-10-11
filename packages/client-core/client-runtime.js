import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { bindRequestEndpoint, createRequestContext } from "../shared/request-context.js";
import { canFallbackOperation, canRetryOperation } from "../shared/operation-policy.js";
import { createDaemonHttpTransport, createSshTransport, isTransportError } from "../client-transport/index.js";
import { selectEndpoint } from "./endpoint-selector.js";
import { createClientState } from "./client-state.js";
import { loadConnectionRegistry } from "./connection-registry.js";
import { loadProjectProfiles, resolveProjectPath } from "./project-profile.js";
import { definitelyNotSent, outcomeUnknown, replaySafeTool } from "./mcp-recovery.js";

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function endpointId(endpoint) {
  return endpoint?.id || endpoint?.name || "";
}

function operationNeedsDaemon(operation) {
  return new Set([
    "remote_exec_async", "remote_script_async", "remote_task",
    "job_status", "job_logs", "job_list", "job_cancel", "job_delete",
    "remote_config_read", "remote_config_write",
  ]).has(operation);
}

function enrichProjectArgs(operation, args, profile) {
  if (!profile) return { ...args };
  const next = { ...args };
  if (typeof next.path === "string") next.path = resolveProjectPath(profile, next.path);
  if (typeof next.cwd === "string" && next.cwd.trim()) next.cwd = resolveProjectPath(profile, next.cwd);
  else if (new Set([
    "remote_bash", "remote_script", "remote_exec_async", "remote_script_async",
    "remote_glob", "remote_grep",
  ]).has(operation)) next.cwd = profile.root;
  return next;
}

function stableScriptToken({ idempotencyKey, content, interpreter, cwd, clientId, serverId, workspaceId }) {
  return createHash("sha256")
    .update(JSON.stringify({
      idempotencyKey: String(idempotencyKey || ""),
      content: String(content || ""),
      interpreter: String(interpreter || "bash"),
      cwd: String(cwd || ""),
      clientId: String(clientId || ""),
      serverId: String(serverId || ""),
      workspaceId: String(workspaceId || ""),
    }))
    .digest("hex")
    .slice(0, 32);
}

function usesDaemonRegex(operation, args) {
  return (operation === "remote_grep" && Boolean(args.regex))
    || (operation === "remote_batch" && Array.isArray(args.operations) && args.operations.some((item) => item?.type === "grep" && item.regex));
}

function isAmbiguousHttpFailure(error) {
  if (![408, 502, 503, 504].includes(Number(error.status)) || error.code === "EWORKSPACE") return false;
  const details = error.details;
  const rejectionCode = details && typeof details.code === "string" ? details.code.trim() : "";
  const applicationRejection = rejectionCode && !isTransportError({ code: rejectionCode })
    && (typeof details.error === "string" || typeof details.message === "string");
  return !applicationRejection;
}

function asyncScriptWrapper(content, interpreter, marker) {
  return [
    "#!/usr/bin/env bash",
    "set +e",
    `${shellQuote(interpreter)} <<'${marker}'`,
    String(content || ""),
    marker,
    "code=$?",
    'rm -f -- "$0"',
    'exit "$code"',
    "",
  ].join("\n");
}

export async function createClientRuntime({
  baseDir = process.cwd(),
  connectionsPath,
  projectsPath = process.env.AGENTPORT_PROJECTS_PATH || path.join(baseDir, "local", "projects.json"),
  registry,
  projects,
  state,
  healthTtlMs = 15_000,
  sessionId = process.env.AGENTPORT_SESSION_ID || process.env.CODEX_SESSION_ID || null,
} = {}) {
  const connectionRegistry = registry || await loadConnectionRegistry({ baseDir, filePath: connectionsPath });
  let projectProfiles = projects;
  if (!projectProfiles) {
    try { projectProfiles = await loadProjectProfiles(projectsPath); }
    catch (error) {
      if (error?.code === "ENOENT") projectProfiles = new Map();
      else throw error;
    }
  }
  const clientState = state || createClientState({
    filePath: process.env.AGENTPORT_CLIENT_STATE_PATH || undefined,
    initialServerId: connectionRegistry.defaultServerId,
  });
  const loadedState = await clientState.load();
  let selectedServerId = loadedState.selectedServerId && connectionRegistry.servers.has(loadedState.selectedServerId)
    ? loadedState.selectedServerId
    : connectionRegistry.defaultServerId;
  let selectedEndpointId = loadedState.selectedEndpointId || null;
  const healthCache = new Map();
  const transportCache = new Map();

  function transportFor(endpoint) {
    const id = endpointId(endpoint);
    if (!transportCache.has(id)) {
      transportCache.set(id, endpoint.type === "ssh"
        ? createSshTransport(endpoint)
        : createDaemonHttpTransport(endpoint));
    }
    return transportCache.get(id);
  }

  async function selectServer(value, endpointValue = null) {
    const target = connectionRegistry.resolveTarget(value || selectedServerId);
    selectedServerId = target.server.id;
    selectedEndpointId = endpointValue || target.endpoint?.id || null;
    await clientState.select({ serverId: selectedServerId, endpointId: selectedEndpointId });
    return { server: target.server, endpoint: selectedEndpointId ? connectionRegistry.getEndpoint(selectedEndpointId).endpoint : target.endpoint };
  }

  function project(name) {
    if (!name) return null;
    const profile = projectProfiles.get(String(name));
    if (!profile) {
      const error = new Error(`Unknown project '${name}'. Available: ${[...projectProfiles.keys()].join(", ") || "(none)"}`);
      error.code = "EPROJECT_NOT_FOUND";
      throw error;
    }
    return profile;
  }

  async function probeEndpoint(server, endpoint, { force = false } = {}) {
    const id = endpointId(endpoint);
    const cached = healthCache.get(id);
    if (!force && cached && Date.now() - cached.checkedAt < healthTtlMs) return cached.health;
    const started = Date.now();
    try {
      const health = await transportFor(endpoint).health(createRequestContext({
        operation: "remote_health",
        serverId: server.id,
        workspaceId: server.workspaceId,
        endpointId: id,
        route: endpoint.type,
        sessionId,
        clientId: endpoint.clientId || null,
      }));
      const normalized = { ...health, ok: health.ok !== false, latencyMs: health.latencyMs ?? Date.now() - started };
      healthCache.set(id, { checkedAt: Date.now(), health: normalized });
      return normalized;
    } catch (error) {
      const health = { ok: false, latencyMs: Date.now() - started, error: error.message, code: error.code || null };
      healthCache.set(id, { checkedAt: Date.now(), health });
      return health;
    }
  }

  async function probeServer(serverValue = selectedServerId, { force = false } = {}) {
    const target = connectionRegistry.resolveTarget(serverValue || selectedServerId);
    const rows = await Promise.all(target.server.endpoints.map(async (endpoint) => [
      endpointId(endpoint),
      await probeEndpoint(target.server, endpoint, { force }),
    ]));
    return { server: target.server, healthByEndpoint: Object.fromEntries(rows) };
  }

  async function chooseEndpoint({ server, operation, explicitEndpointId = null, forceProbe = false, excluded = new Set(), daemonOnly = false, recoveryClientId } = {}) {
    const filteredServer = {
      ...server,
      endpoints: server.endpoints.filter((endpoint) => (
        (!(operationNeedsDaemon(operation) || daemonOnly) || endpoint.type === "daemon")
        && (recoveryClientId === undefined || (endpoint.type === "daemon" && endpoint.clientId === recoveryClientId))
      )),
    };
    const healthByEndpoint = {};
    await Promise.all(filteredServer.endpoints.map(async (endpoint) => {
      const id = endpointId(endpoint);
      if (excluded.has(id)) {
        healthByEndpoint[id] = { ok: false, error: "excluded" };
        return;
      }
      healthByEndpoint[id] = await probeEndpoint(server, endpoint, { force: forceProbe });
    }));

    const selected = selectEndpoint({
      server: filteredServer,
      operation,
      healthByEndpoint,
      preferredEndpointId: explicitEndpointId || selectedEndpointId || "",
    });
    return { ...selected, healthByEndpoint };
  }

  async function invokeOnSelection(operation, args, server, selection, context) {
    const endpoint = selection.endpoint;
    const bound = bindRequestEndpoint({ ...context, clientId: endpoint.clientId || context.clientId }, endpoint, selection.health || {});
    const transport = transportFor(endpoint);

    if (operation === "remote_script_async") {
      if (endpoint.type !== "daemon") {
        const error = new Error("Async script execution requires a daemon endpoint");
        error.code = "EDAEMON_REQUIRED";
        throw error;
      }
      const cwd = args.cwd || selection.health?.workspaceRoot;
      if (!cwd) throw new Error("remote_script_async requires cwd or a daemon workspaceRoot");
      const token = stableScriptToken({
        idempotencyKey: bound.idempotencyKey,
        content: args.content,
        interpreter: args.interpreter,
        cwd,
        // Unknown client identity gets a request-local filename, never a shared stable wrapper.
        clientId: bound.clientId || `request:${bound.requestId}`,
        serverId: bound.serverId,
        workspaceId: bound.workspaceId,
      });
      const marker = `AGENTPORT_${token.toUpperCase()}`;
      const wrapperPath = `${String(cwd).replace(/\/+$/, "")}/.agentport-tmp/client-v3-${token}.sh`;
      const wrapper = asyncScriptWrapper(args.content, args.interpreter || "bash", marker);
      const writeContext = createRequestContext({
        operation: "remote_write",
        serverId: server.id,
        workspaceId: server.workspaceId,
        sessionId,
        clientId: endpoint.clientId || null,
      });
      let phase = "upload";
      try {
        await transport.invoke("remote_write", { path: wrapperPath, content: wrapper }, bindRequestEndpoint(writeContext, endpoint, selection.health || {}));
        phase = "submit";
        return await transport.invoke("remote_exec_async", {
          command: `bash ${shellQuote(wrapperPath)}`,
          cwd,
          timeoutMs: args.timeoutMs,
          idempotencyKey: bound.idempotencyKey,
        }, bound);
      } catch (error) {
        const uncertain = error.code === "EOUTCOME_UNKNOWN" || isAmbiguousHttpFailure(error)
          || (error.transport !== false && !error.status && isTransportError(error) && !definitelyNotSent(error));
        const failure = uncertain && error.code !== "EOUTCOME_UNKNOWN" ? outcomeUnknown(operation, error) : error;
        // Even rejection cannot prove this stable path is unowned by an earlier accepted Job.
        failure.recovery = {
          ...failure.recovery, wrapperPath, idempotencyKey: bound.idempotencyKey,
          serverId: bound.serverId, workspaceId: bound.workspaceId, endpointId: endpointId(endpoint),
          clientId: bound.clientId, route: endpoint.type, cwd, phase, retained: true,
        };
        throw failure;
      }
    }

    return transport.invoke(operation, args, bound);
  }

  async function invoke(operation, rawArgs = {}, options = {}) {
    const profile = project(options.project || rawArgs.project);
    const targetName = options.server || rawArgs.server || rawArgs.connection || profile?.server || selectedServerId;
    const resolved = connectionRegistry.resolveTarget(targetName);
    const server = resolved.server;
    const explicitEndpointId = options.endpoint || rawArgs.endpoint || resolved.endpoint?.id || null;
    const args = enrichProjectArgs(operation, rawArgs, profile);
    delete args.project;
    delete args.server;
    delete args.connection;
    delete args.endpoint;

    let idempotencyKey = normalizeString(options.idempotencyKey || rawArgs.idempotencyKey || rawArgs.key);
    if (operation === "remote_exec_async" || operation === "remote_script_async") {
      idempotencyKey ||= randomUUID();
      args.idempotencyKey = idempotencyKey;
    }
    const context = createRequestContext({
      operation,
      serverId: server.id,
      workspaceId: server.workspaceId,
      sessionId,
      clientId: null,
      idempotencyKey,
      traceId: options.traceId || rawArgs.traceId || null,
    });

    const excluded = new Set();
    const preferred = explicitEndpointId || selectedEndpointId;
    const explicitSsh = server.endpoints.some((endpoint) => endpointId(endpoint) === preferred && endpoint.type === "ssh");
    const requestArgs = ["remote_exec_async", "remote_batch"].includes(operation) ? JSON.parse(JSON.stringify(args)) : args;
    const daemonRegex = usesDaemonRegex(operation, requestArgs) && !explicitSsh;
    // The default batch policy stays conservative; only this existing validator can mark the whole payload read-only.
    const readOnlyBatch = operation === "remote_batch" && replaySafeTool(operation, requestArgs);
    const mutating = context.policy.mutating && !readOnlyBatch;
    let selection = await chooseEndpoint({ server, operation, explicitEndpointId, excluded, daemonOnly: daemonRegex });
    let attempts = 0;
    while (true) {
      attempts += 1;
      try {
        const data = await invokeOnSelection(operation, requestArgs, server, selection, context);
        return {
          data,
          meta: {
            operation,
            serverId: server.id,
            workspaceId: server.workspaceId,
            endpointId: endpointId(selection.endpoint),
            route: selection.endpoint.type,
            identityState: selection.identityState,
            attempts,
            idempotencyKey,
            project: profile?.name || null,
            requestId: context.requestId,
            traceId: context.traceId,
          },
        };
      } catch (error) {
        if (error.code === "EOUTCOME_UNKNOWN" || error.outcome === "unknown" || error.code === "EWORKSPACE") throw error;
        const proxyUnknown = isAmbiguousHttpFailure(error);
        if (!proxyUnknown && (error.transport === false || error.status)) throw error;
        const recoverable = proxyUnknown || isTransportError(error);
        const unsent = !proxyUnknown && definitelyNotSent(error);
        const verifiedIdempotency = selection.endpoint.type === "daemon" && selection.identityMatch === true
          && Boolean(normalizeString(selection.endpoint.clientId))
          && selection.health?.capabilities?.idempotentJobs === true
          && selection.health?.capabilities?.clientScopedIdempotency === true;
        const retrySame = recoverable && attempts === 1 && !(proxyUnknown && mutating)
          && (readOnlyBatch || canRetryOperation({ operation, definitelyNotSent: unsent, idempotencyKey, verifiedIdempotency }));
        if (retrySame) continue;
        if (mutating && recoverable && !unsent) {
          const failure = outcomeUnknown(operation, error);
          failure.recovery = {
            serverId: server.id, workspaceId: server.workspaceId, endpointId: endpointId(selection.endpoint),
            route: selection.endpoint.type, clientId: selection.endpoint.clientId || null, idempotencyKey,
          };
          throw failure;
        }
        const fallbackAllowed = recoverable && (readOnlyBatch
          ? selection.identityMatch === true
          : canFallbackOperation({ operation, identityMatch: selection.identityMatch, definitelyNotSent: unsent }));
        if (!fallbackAllowed) throw error;
        excluded.add(endpointId(selection.endpoint));
        if (mutating && !normalizeString(selection.endpoint.clientId)) throw error;
        selection = await chooseEndpoint({
          server, operation, explicitEndpointId: null, forceProbe: true, excluded,
          daemonOnly: daemonRegex || (selection.endpoint.type === "daemon" && usesDaemonRegex(operation, requestArgs)),
          recoveryClientId: mutating ? selection.endpoint.clientId : undefined,
        });
      }
    }
  }

  async function projectStatus(name) {
    const profile = project(name);
    const content = [
      "set +e",
      'printf "project_root=%s\\n" "$PWD"',
      'printf "branch=%s\\n" "$(git branch --show-current 2>/dev/null)"',
      'printf "head=%s\\n" "$(git rev-parse --short HEAD 2>/dev/null)"',
      'printf "dirty_count=%s\\n" "$(git status --porcelain 2>/dev/null | wc -l | tr -d " ")"',
      'printf "status_begin\\n"',
      "git status --short --branch 2>/dev/null",
      'printf "status_end\\n"',
    ].join("\n");
    return invoke("remote_script", { project: name, cwd: profile.root, interpreter: "bash", content });
  }

  async function projectRun(name, action, options = {}) {
    const profile = project(name);
    const command = profile.commands?.[action];
    if (!command) {
      const error = new Error(`Project '${name}' has no '${action}' command. Available: ${Object.keys(profile.commands || {}).join(", ") || "(none)"}`);
      error.code = "EPROJECT_ACTION";
      throw error;
    }
    return invoke("remote_exec_async", {
      project: name,
      cwd: profile.root,
      command,
      timeoutMs: options.timeoutMs,
      idempotencyKey: options.idempotencyKey,
    });
  }

  function listProjects() {
    return [...projectProfiles.values()].map((profile) => ({
      name: profile.name,
      server: profile.server,
      root: profile.root,
      defaultBranch: profile.defaultBranch,
      packageManager: profile.packageManager,
      commands: Object.keys(profile.commands || {}),
      agentRules: profile.agentRules,
    }));
  }

  function describe() {
    return {
      sourcePath: connectionRegistry.sourcePath,
      format: connectionRegistry.format,
      selectedServerId,
      selectedEndpointId,
      servers: connectionRegistry.list(),
      projects: listProjects(),
      healthCacheTtlMs: healthTtlMs,
    };
  }

  function close() {
    for (const transport of transportCache.values()) transport.close?.();
    transportCache.clear();
  }

  return Object.freeze({
    registry: connectionRegistry,
    projects: projectProfiles,
    state: clientState,
    describe,
    invoke,
    listProjects,
    probeEndpoint,
    probeServer,
    projectRun,
    projectStatus,
    selectServer,
    close,
    get selectedServerId() { return selectedServerId; },
    get selectedEndpointId() { return selectedEndpointId; },
  });
}

export const clientRuntimeInternals = Object.freeze({
  asyncScriptWrapper,
  enrichProjectArgs,
  operationNeedsDaemon,
  shellQuote,
  stableScriptToken,
});
