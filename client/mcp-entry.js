import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = String(process.env.AGENTPORT_CLIENT_MODE || "auto").trim().toLowerCase();
const v3ConfigPath = path.resolve(
  process.env.MCP_REMOTE_V3_CONNECTIONS_PATH
    || process.env.AGENTPORT_CONNECTIONS_PATH
    || path.join(ROOT, "local", "connections.v3.json"),
);

async function exists(filePath) {
  try { await fs.access(filePath); return true; }
  catch { return false; }
}

if (mode === "legacy") {
  await import("../index.js");
} else if (mode === "v3" || mode === "modular" || await exists(v3ConfigPath)) {
  process.env.MCP_REMOTE_V3_CONNECTIONS_PATH ||= v3ConfigPath;
  await import("./mcp-v3.js");
} else {
  await import("../index.js");
}
