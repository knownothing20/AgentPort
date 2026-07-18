import fs from "node:fs/promises";
import path from "node:path";

function normalizeRemoteRoot(root) {
  const value = String(root || "").trim();
  if (!value || !value.startsWith("/")) throw new Error("project.root must be an absolute POSIX path");
  return path.posix.normalize(value).replace(/\/$/, "") || "/";
}

export function validateProjectProfile(name, profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error(`Project '${name}' must be an object`);
  }
  const normalized = {
    name,
    server: String(profile.server || "").trim(),
    root: normalizeRemoteRoot(profile.root),
    defaultBranch: String(profile.defaultBranch || "main").trim() || "main",
    packageManager: String(profile.packageManager || "").trim() || null,
    commands: profile.commands && typeof profile.commands === "object" ? { ...profile.commands } : {},
    agentRules: Array.isArray(profile.agentRules) ? profile.agentRules.map(String) : ["AGENTS.md"],
  };
  if (!normalized.server) throw new Error(`Project '${name}' is missing server`);
  return Object.freeze(normalized);
}

export function resolveProjectPath(profile, relativePath = ".") {
  const root = normalizeRemoteRoot(profile?.root);
  const candidate = path.posix.resolve(root, String(relativePath || "."));
  if (candidate !== root && !candidate.startsWith(`${root}/`)) {
    const error = new Error(`Path '${relativePath}' escapes project root '${root}'`);
    error.code = "EPROJECTPATH";
    throw error;
  }
  return candidate;
}

export async function loadProjectProfiles(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  const projects = parsed.projects && typeof parsed.projects === "object" ? parsed.projects : parsed;
  const result = new Map();
  for (const [name, profile] of Object.entries(projects || {})) {
    result.set(name, validateProjectProfile(name, profile));
  }
  return result;
}
