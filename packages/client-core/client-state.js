import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function safeSegment(value) {
  return String(value || "default").trim().replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "default";
}

export function defaultClientStatePath({ baseDir = process.cwd(), sessionId } = {}) {
  const explicit = process.env.AGENTPORT_CLIENT_STATE_PATH;
  if (explicit) return path.resolve(explicit.replace(/^~/, os.homedir()));
  const id = safeSegment(sessionId || process.env.AGENTPORT_SESSION_ID || process.env.CODEX_SESSION_ID || "default");
  return path.join(baseDir, "local", "sessions", id, "client-v3-state.json");
}

export function createClientState({ filePath = defaultClientStatePath(), initialServerId = null } = {}) {
  let memory = {
    selectedServerId: initialServerId,
    selectedEndpointId: null,
    updatedAt: null,
  };
  let loaded = false;

  async function load() {
    if (loaded) return { ...memory };
    loaded = true;
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
      memory = {
        selectedServerId: parsed.selectedServerId || initialServerId || null,
        selectedEndpointId: parsed.selectedEndpointId || null,
        updatedAt: parsed.updatedAt || null,
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return { ...memory };
  }

  async function save(next) {
    memory = {
      ...memory,
      ...next,
      updatedAt: new Date().toISOString(),
    };
    loaded = true;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(memory, null, 2)}\n`, "utf8");
    await fs.rename(temp, filePath);
    return { ...memory };
  }

  async function select({ serverId, endpointId = null } = {}) {
    if (!serverId) throw new Error("serverId is required");
    return save({ selectedServerId: serverId, selectedEndpointId: endpointId });
  }

  async function clearEndpoint() {
    return save({ selectedEndpointId: null });
  }

  return Object.freeze({
    filePath,
    load,
    save,
    select,
    clearEndpoint,
  });
}
