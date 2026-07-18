const fs = require("node:fs/promises");
const path = require("node:path");

function comparisonPath(value) {
  let normalized = path.resolve(String(value || ""));
  if (process.platform === "win32") {
    normalized = normalized.replace(/^\\\\\?\\/, "").toLowerCase();
  }
  return normalized;
}

function isWithin(candidate, root) {
  const relative = path.relative(comparisonPath(root), comparisonPath(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function accessDenied(inputPath, workspaceRoot) {
  const error = new Error(`Access denied: '${inputPath}' is outside workspace root '${workspaceRoot}'`);
  error.code = "EWORKSPACE";
  error.statusCode = 403;
  return error;
}

function sameFileIdentity(left, right) {
  if (!left || !right) return false;
  if (typeof left.ino === "bigint" || typeof right.ino === "bigint") {
    return BigInt(left.dev) === BigInt(right.dev) && BigInt(left.ino) === BigInt(right.ino);
  }
  return Number(left.dev) === Number(right.dev) && Number(left.ino) === Number(right.ino);
}

async function isWithinByIdentity(candidateExisting, rootExisting) {
  if (isWithin(candidateExisting, rootExisting)) return true;
  if (process.platform !== "win32") return false;

  let rootStat;
  try { rootStat = await fs.stat(rootExisting, { bigint: true }); }
  catch { return false; }

  let current = path.resolve(candidateExisting);
  while (true) {
    try {
      const currentStat = await fs.stat(current, { bigint: true });
      if (sameFileIdentity(currentStat, rootStat)) return true;
    } catch {
      return false;
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function nearestExistingAncestor(candidate) {
  let current = candidate;
  while (true) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function resolveWorkspacePath(workspaceRoot, inputPath, { mustExist = false } = {}) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) {
    throw new TypeError("workspaceRoot is required");
  }
  if (typeof inputPath !== "string" || !inputPath.trim()) {
    const error = new Error("path is required");
    error.code = "EINVAL";
    error.statusCode = 400;
    throw error;
  }

  const rootLexical = path.resolve(workspaceRoot);
  const rootReal = await fs.realpath(rootLexical);
  const candidateLexical = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(rootLexical, inputPath);

  if (!isWithin(candidateLexical, rootLexical)) {
    throw accessDenied(inputPath, rootLexical);
  }

  if (mustExist) {
    const candidateReal = await fs.realpath(candidateLexical);
    if (!(await isWithinByIdentity(candidateReal, rootReal))) {
      throw accessDenied(inputPath, rootReal);
    }
    return { root: rootReal, path: candidateLexical, realPath: candidateReal };
  }

  const ancestorLexical = await nearestExistingAncestor(candidateLexical);
  const ancestorReal = await fs.realpath(ancestorLexical);
  if (!(await isWithinByIdentity(ancestorReal, rootReal))) {
    throw accessDenied(inputPath, rootReal);
  }

  const remainder = path.relative(ancestorLexical, candidateLexical);
  const projectedReal = path.resolve(ancestorReal, remainder);
  if (!isWithin(projectedReal, ancestorReal)) throw accessDenied(inputPath, rootReal);

  return { root: rootReal, path: candidateLexical, realPath: projectedReal };
}

module.exports = {
  isWithin,
  isWithinByIdentity,
  resolveWorkspacePath,
  sameFileIdentity,
};
