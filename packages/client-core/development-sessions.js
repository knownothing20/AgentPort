import { randomUUID } from 'node:crypto';
import { createRequestContext } from '../shared/request-context.js';
import { selectEndpoint } from './endpoint-selector.js';
import { createDaemonHttpTransport, isTransportError } from '../client-transport/daemon-http.js';

function value(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function encode(value) { return encodeURIComponent(String(value || '')); }

export function createDevelopmentSessionClient(runtime, { sessionId = process.env.AGENTPORT_SESSION_ID || null } = {}) {
  if (!runtime?.registry || !runtime?.probeServer) throw new TypeError('runtime is required');
  const transports = new Map();
  function transport(endpoint) {
    if (!transports.has(endpoint.id)) transports.set(endpoint.id, createDaemonHttpTransport(endpoint));
    return transports.get(endpoint.id);
  }
  async function selected(serverValue, operation = 'remote_config_read') {
    const target = runtime.registry.resolveTarget(serverValue || runtime.selectedServerId);
    const probe = await runtime.probeServer(target.server.id, { force: false });
    const server = { ...target.server, endpoints: target.server.endpoints.filter((endpoint) => endpoint.type === 'daemon') };
    if (!server.endpoints.length) {
      const error = new Error(`Logical server '${server.id}' has no daemon endpoint`);
      error.code = 'EDAEMON_REQUIRED'; throw error;
    }
    const choice = selectEndpoint({
      server,
      operation,
      healthByEndpoint: probe.healthByEndpoint,
      preferredEndpointId: target.endpoint?.type === 'daemon' ? target.endpoint.id : runtime.selectedEndpointId || '',
    });
    return { server, endpoint: choice.endpoint, health: choice.health, transport: transport(choice.endpoint) };
  }
  async function request({ server, operation = 'remote_config_read', method = 'GET', route, query, body, idempotencyKey, retry = false }) {
    const choice = await selected(server, operation);
    const context = createRequestContext({
      operation,
      serverId: choice.server.id,
      workspaceId: choice.server.workspaceId,
      endpointId: choice.endpoint.id,
      route: 'daemon',
      clientId: choice.endpoint.clientId || null,
      sessionId,
      idempotencyKey: idempotencyKey || null,
    });
    let attempts = 0;
    while (true) {
      attempts += 1;
      try {
        const response = await choice.transport.request({ method, route, query, body, context, headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {} });
        return { data: response.data, meta: { serverId: choice.server.id, workspaceId: choice.server.workspaceId, endpointId: choice.endpoint.id, attempts, requestId: context.requestId, traceId: context.traceId, idempotencyKey: idempotencyKey || null } };
      } catch (error) {
        if (!(retry && attempts === 1 && isTransportError(error))) throw error;
      }
    }
  }
  function profile(name) {
    const item = runtime.projects.get(String(name || ''));
    if (!item) { const error = new Error(`Unknown project '${name}'`); error.code = 'EPROJECT_NOT_FOUND'; throw error; }
    return item;
  }
  async function overview(options = {}) { return request({ server: options.server, route: '/api/dev/overview', query: { limit: options.limit } }); }
  async function list(options = {}) { return request({ server: options.server, route: '/api/dev/sessions', query: { limit: options.limit, status: options.status, projectName: options.projectName } }); }
  async function create(projectName, options = {}) {
    const item = profile(projectName);
    return request({
      server: options.server || item.server,
      operation: 'remote_config_write', method: 'POST', route: '/api/dev/sessions',
      body: {
        projectName: item.name,
        projectRoot: item.root,
        baseRef: options.baseRef || item.defaultBranch,
        targetBranch: options.targetBranch || item.defaultBranch,
        branchName: options.branchName,
        agentId: options.agentId || 'agent',
        task: options.task || '',
        leaseMs: options.leaseMs,
        commands: item.commands,
        agentRules: item.agentRules,
      },
    });
  }
  async function status(id, options = {}) { return request({ server: options.server, route: `/api/dev/sessions/${encode(id)}` }); }
  async function heartbeat(id, options = {}) { return request({ server: options.server, operation: 'remote_config_write', method: 'POST', route: `/api/dev/sessions/${encode(id)}/heartbeat`, body: { agentId: options.agentId, leaseMs: options.leaseMs } }); }
  async function run(id, action, options = {}) {
    const key = value(options.idempotencyKey) || `session:${id}:${action || 'command'}:${randomUUID()}`;
    return request({ server: options.server, operation: 'remote_exec_async', method: 'POST', route: `/api/dev/sessions/${encode(id)}/run`, idempotencyKey: key, retry: true, body: { action, command: options.command, timeoutMs: options.timeoutMs, queueTimeoutMs: options.queueTimeoutMs, resourceClass: options.resourceClass, idempotencyKey: key } });
  }
  async function diff(id, options = {}) { return request({ server: options.server, route: `/api/dev/sessions/${encode(id)}/diff`, query: { maxBytes: options.maxBytes } }); }
  async function commit(id, message, options = {}) { return request({ server: options.server, operation: 'remote_config_write', method: 'POST', route: `/api/dev/sessions/${encode(id)}/commit`, body: { message, addAll: options.addAll, authorName: options.authorName, authorEmail: options.authorEmail } }); }
  async function rollback(id, options = {}) { return request({ server: options.server, operation: 'remote_config_write', method: 'POST', route: `/api/dev/sessions/${encode(id)}/rollback`, body: { confirm: options.confirm, mode: options.mode } }); }
  async function merge(id, options = {}) { return request({ server: options.server, operation: 'remote_config_write', method: 'POST', route: `/api/dev/sessions/${encode(id)}/merge`, body: { confirm: options.confirm, targetBranch: options.targetBranch, strategy: options.strategy, message: options.message, force: options.force } }); }
  async function cleanup(id, options = {}) { return request({ server: options.server, operation: 'remote_config_write', method: 'POST', route: `/api/dev/sessions/${encode(id)}/cleanup`, body: { confirm: options.confirm, deleteBranch: options.deleteBranch, force: options.force } }); }
  function close() { for (const item of transports.values()) item.close(); transports.clear(); }
  return Object.freeze({ overview, list, create, status, heartbeat, run, diff, commit, rollback, merge, cleanup, close });
}
