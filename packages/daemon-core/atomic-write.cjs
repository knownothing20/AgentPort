const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function atomicWriteFile(targetPath, content, { encoding = "utf8", mode = 0o600 } = {}) {
  const directory = path.dirname(targetPath);
  await fs.mkdir(directory, { recursive: true });

  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), encoding);
  const tempName = `.${path.basename(targetPath)}.agentport-${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`;
  const tempPath = path.join(directory, tempName);
  let handle = null;

  try {
    handle = await fs.open(tempPath, "wx", mode);
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tempPath, targetPath);
    return {
      path: targetPath,
      bytes: buffer.byteLength,
      sha256: sha256(buffer),
    };
  } catch (error) {
    try { await handle?.close(); } catch {}
    try { await fs.rm(tempPath, { force: true }); } catch {}
    throw error;
  }
}

module.exports = {
  atomicWriteFile,
  sha256,
};
