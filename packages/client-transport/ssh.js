import { randomUUID } from "node:crypto";
import { SSHClient } from "../../ssh-client.js";

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function parseIdentity(text) {
  const values = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return values;
}

function grepCommand(args = {}) {
  const pattern = shellQuote(args.pattern || "");
  const maxResults = Math.min(Math.max(Number(args.maxResults || 200), 1), 5000);
  const includes = Array.isArray(args.include) ? args.include : args.include ? [args.include] : ["*"];
  const excludes = Array.isArray(args.excludeDirs) ? args.excludeDirs : ["node_modules", ".git", "dist", "build", ".next"];
  const flags = ["-RIn", "--binary-files=without-match", args.caseSensitive ? "" : "-i", args.regex ? "" : "-F"].filter(Boolean);
  const includeArgs = includes.map((item) => `--include=${shellQuote(item)}`).join(" ");
  const excludeArgs = excludes.map((item) => `--exclude-dir=${shellQuote(item)}`).join(" ");
  return `grep ${flags.join(" ")} ${includeArgs} ${excludeArgs} -- ${pattern} . 2>/dev/null | head -n ${maxResults} || true`;
}

function parseGrep(text) {
  return String(text || "").split(/\r?\n/).filter(Boolean).map((line) => {
    const first = line.indexOf(":");
    const second = first >= 0 ? line.indexOf(":", first + 1) : -1;
    return first >= 0 && second >= 0
      ? { path: line.slice(0, first).replace(/^\.\//, ""), line: Number(line.slice(first + 1, second)) || null, text: line.slice(second + 1) }
      : { path: line, line: null, text: "" };
  });
}

export function createSshTransport(endpoint, { timeoutMs = Number(endpoint?.timeoutMs || 120_000) } = {}) {
  if (!endpoint?.host) throw new TypeError("SSH endpoint host is required");

  function client() {
    return new SSHClient({ ...endpoint, execTimeoutMs: timeoutMs });
  }

  async function withClient(fn) {
    const ssh = client();
    try {
      await ssh.connect();
      if (endpoint.workspaceRoot && !ssh.workspaceRoot) ssh.workspaceRoot = endpoint.workspaceRoot;
      return await fn(ssh);
    } finally {
      ssh.disconnect();
    }
  }

  async function health() {
    const started = Date.now();
    return withClient(async (ssh) => {
      try { await ssh.detectWorkspaceRoot(); } catch {}
      const result = await ssh.exec([
        'ENV="$HOME/.agentport/daemon/.env"',
        'server_id=$(grep -E "^(AGENTPORT_SERVER_ID|SERVER_ID)=" "$ENV" 2>/dev/null | head -n1 | cut -d= -f2-)',
        'workspace_id=$(grep -E "^(AGENTPORT_WORKSPACE_ID|WORKSPACE_ID)=" "$ENV" 2>/dev/null | head -n1 | cut -d= -f2-)',
        'workspace_root=$(grep -E "^WORKSPACE_ROOT=" "$ENV" 2>/dev/null | head -n1 | cut -d= -f2-)',
        'printf "serverId=%s\\nworkspaceId=%s\\nworkspaceRoot=%s\\n" "$server_id" "$workspace_id" "$workspace_root"',
      ].join("; "));
      const identity = parseIdentity(result.stdout);
      return {
        ok: true,
        latencyMs: Date.now() - started,
        serverId: identity.serverId || endpoint.serverId || null,
        workspaceId: identity.workspaceId || endpoint.workspaceId || null,
        workspaceRoot: identity.workspaceRoot || ssh.workspaceRoot || endpoint.workspaceRoot || null,
        capabilities: { files: true, exec: true, persistentJobs: false },
        data: result,
      };
    });
  }

  async function invokeWithClient(ssh, operation, args = {}) {
    switch (operation) {
      case "remote_read": return { success: true, content: await ssh.readFile(args.path) };
      case "remote_write": {
        await ssh.writeFile(args.path, String(args.content ?? ""));
        return { success: true, message: "File written successfully", path: args.path };
      }
      case "remote_stat": return { success: true, path: args.path, ...(await ssh.stat(args.path)) };
      case "remote_glob": {
        const files = await ssh.glob(args.pattern, args.cwd);
        return { success: true, files, entries: files };
      }
      case "remote_grep": {
        const cwd = ssh.resolveWorkspaceCwd(args.cwd) || args.cwd;
        const result = await ssh.exec(grepCommand(args), { cwd });
        const matches = parseGrep(result.stdout);
        return { success: true, engine: "grep", pattern: args.pattern, cwd: cwd || ".", matches, truncated: matches.length >= Number(args.maxResults || 200) };
      }
      case "remote_bash": return { success: true, ...(await ssh.exec(args.command, { cwd: args.cwd, timeoutMs: args.timeoutMs })) };
      case "remote_script": {
        const interpreter = String(args.interpreter || "bash");
        const baseDir = ssh.workspaceRoot
          ? `${ssh.resolveWorkspaceCwd(args.cwd) || ssh.workspaceRoot}/.agentport-tmp`
          : "~/.agentport/tmp";
        const scriptPath = `${baseDir}/client-v3-${randomUUID()}.${interpreter.includes("python") ? "py" : interpreter === "node" ? "js" : "sh"}`;
        await ssh.mkdir(baseDir);
        await ssh.writeFile(scriptPath, String(args.content || ""));
        try {
          return { success: true, ...(await ssh.exec(`${shellQuote(interpreter)} ${shellQuote(scriptPath)}`, { cwd: args.cwd, timeoutMs: args.timeoutMs })) };
        } finally {
          ssh.rm(scriptPath).catch(() => {});
        }
      }
      case "remote_batch": {
        const results = [];
        const mapping = { read: "remote_read", write: "remote_write", stat: "remote_stat", glob: "remote_glob", grep: "remote_grep", bash: "remote_bash" };
        for (const item of args.operations || []) {
          const mapped = mapping[item.type];
          if (!mapped) results.push({ type: item.type, status: 400, error: "Unsupported operation" });
          else {
            try { results.push({ type: item.type, status: 200, ...(await invokeWithClient(ssh, mapped, item)) }); }
            catch (error) { results.push({ type: item.type, status: 500, error: error.message }); }
          }
        }
        return { success: true, results };
      }
      default: {
        const error = new Error(`Operation '${operation}' requires a daemon endpoint`);
        error.code = "EDAEMON_REQUIRED";
        throw error;
      }
    }
  }

  async function invoke(operation, args = {}) {
    if (operation === "remote_health") return health();
    return withClient((ssh) => invokeWithClient(ssh, operation, args));
  }

  return Object.freeze({ endpoint, health, invoke });
}

export const sshTransportInternals = Object.freeze({ grepCommand, parseGrep, parseIdentity, shellQuote });
