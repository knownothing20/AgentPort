import { redactSensitive } from "../packages/client-core/redaction.js";

function redactJsonText(text) {
  const source = String(text);
  const trailing = source.match(/\s*$/)?.[0] || "";
  const body = source.slice(0, source.length - trailing.length);
  if (!body.trim()) return source;

  try {
    const parsed = JSON.parse(body);
    const pretty = body.includes("\n") ? 2 : 0;
    return `${JSON.stringify(redactSensitive(parsed), null, pretty)}${trailing}`;
  } catch {}

  if (!source.includes("\n")) return source;
  const parts = source.split(/(\r?\n)/);
  return parts.map((part) => {
    if (/^\r?\n$/.test(part) || !part.trim()) return part;
    try { return JSON.stringify(redactSensitive(JSON.parse(part))); }
    catch { return part; }
  }).join("");
}

function guardStream(stream) {
  if (!stream || stream.__agentportOutputGuard) return;
  const originalWrite = stream.write.bind(stream);
  Object.defineProperty(stream, "__agentportOutputGuard", { value: true });
  stream.write = function guardedWrite(chunk, encoding, callback) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    const isBuffer = Buffer.isBuffer(chunk);
    const text = isBuffer ? chunk.toString(typeof encoding === "string" ? encoding : "utf8") : String(chunk);
    const safe = redactJsonText(text);
    const output = isBuffer ? Buffer.from(safe, typeof encoding === "string" ? encoding : "utf8") : safe;
    return originalWrite(output, encoding, callback);
  };
}

export function installOutputGuard({ stderr = true } = {}) {
  guardStream(process.stdout);
  if (stderr) guardStream(process.stderr);
}

export const outputGuardInternals = Object.freeze({ redactJsonText });
