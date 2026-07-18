import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClientRuntime } from '../packages/client-core/client-runtime.js';
import { createDevelopmentSessionClient } from '../packages/client-core/development-sessions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parse(argv) {
  const positional = []; const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    if (['json', 'force', 'delete-branch', 'no-add-all'].includes(key)) { options[key] = true; continue; }
    options[key] = argv[++i];
  }
  return { positional, options };
}
function number(value) { return value === undefined ? undefined : Number(value); }
function show(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

export async function main(argv = process.argv.slice(2)) {
  const { positional, options } = parse(argv);
  const [, action, ...rest] = positional;
  const runtime = await createClientRuntime({
    baseDir: ROOT,
    connectionsPath: options.connections || process.env.AGENTPORT_CONNECTIONS_PATH,
    projectsPath: options.projects || process.env.AGENTPORT_PROJECTS_PATH,
  });
  const sessions = createDevelopmentSessionClient(runtime);
  try {
    let result;
    switch (action) {
      case 'overview':
        result = await sessions.overview({ server: options.server, limit: options.limit });
        break;
      case 'list':
        result = await sessions.list({ server: options.server, limit: options.limit, status: options.status, projectName: options.project });
        break;
      case 'create':
        if (!rest[0]) throw new Error('Usage: agentport session create <project>');
        result = await sessions.create(rest[0], {
          server: options.server,
          agentId: options.agent,
          task: options.task,
          baseRef: options.base,
          targetBranch: options.target,
          branchName: options.branch,
          leaseMs: number(options['lease-ms']),
        });
        break;
      case 'status':
        result = await sessions.status(rest[0], { server: options.server });
        break;
      case 'heartbeat':
        result = await sessions.heartbeat(rest[0], { server: options.server, agentId: options.agent, leaseMs: number(options['lease-ms']) });
        break;
      case 'run':
        if (!rest[0] || (!rest[1] && !options.command)) throw new Error('Usage: agentport session run <sessionId> <action> [--command cmd]');
        result = await sessions.run(rest[0], rest[1], {
          server: options.server,
          command: options.command,
          idempotencyKey: options['idempotency-key'],
          timeoutMs: number(options['timeout-ms']),
          queueTimeoutMs: number(options['queue-timeout-ms']),
          resourceClass: options['resource-class'],
        });
        break;
      case 'diff':
        result = await sessions.diff(rest[0], { server: options.server, maxBytes: number(options['max-bytes']) });
        break;
      case 'commit':
        if (!options.message) throw new Error('--message is required');
        result = await sessions.commit(rest[0], options.message, {
          server: options.server,
          addAll: !options['no-add-all'],
          authorName: options['author-name'],
          authorEmail: options['author-email'],
        });
        break;
      case 'rollback':
        result = await sessions.rollback(rest[0], { server: options.server, confirm: options.confirm, mode: options.mode });
        break;
      case 'merge':
        result = await sessions.merge(rest[0], {
          server: options.server,
          confirm: options.confirm,
          targetBranch: options.target,
          strategy: options.strategy,
          message: options.message,
          force: options.force,
        });
        break;
      case 'cleanup':
        result = await sessions.cleanup(rest[0], {
          server: options.server,
          confirm: options.confirm,
          deleteBranch: options['delete-branch'],
          force: options.force,
        });
        break;
      default:
        show({
          usage: [
            'agentport session overview',
            'agentport session list',
            'agentport session create <project> --agent codex --task "..."',
            'agentport session status <id>',
            'agentport session run <id> build --idempotency-key key',
            'agentport session diff <id>',
            'agentport session commit <id> --message "..."',
            'agentport session merge <id> --confirm <id> --target main',
            'agentport session rollback <id> --confirm <id>',
            'agentport session cleanup <id> --confirm <id> --delete-branch',
          ],
        });
        return;
    }
    show(result);
  } finally {
    sessions.close();
    runtime.close();
  }
}
