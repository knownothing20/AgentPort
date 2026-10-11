/**
 * Local logging module for agentport
 * - Daily rotation with size-based segments to keep diagnostics visible without filling the disk
 * - Auto-cleanup: keep last 7 days
 * - Logs stored in local/logs/
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_DIR = process.env.MCP_REMOTE_LOG_DIR
  ? path.resolve(process.env.MCP_REMOTE_LOG_DIR)
  : path.join(__dirname, "local", "logs");
const MAX_DAYS = 7;
const DEFAULT_DATA_MAX_BYTES = 4000;
const MESSAGE_MAX_BYTES = 1024;
const DEFAULT_LOG_SEGMENT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_LOG_MAX_SEGMENTS_PER_DAY = 20;
const rawDataMaxBytes = Number(process.env.MCP_REMOTE_LOG_DATA_MAX_BYTES || DEFAULT_DATA_MAX_BYTES);
const DATA_MAX_BYTES = Number.isFinite(rawDataMaxBytes) && rawDataMaxBytes > 200
  ? rawDataMaxBytes
  : DEFAULT_DATA_MAX_BYTES;
const rawSegmentMaxBytes = Number(process.env.MCP_REMOTE_LOG_SEGMENT_MAX_BYTES || process.env.MCP_REMOTE_LOG_MAX_BYTES || DEFAULT_LOG_SEGMENT_MAX_BYTES);
const LOG_SEGMENT_MAX_BYTES = Number.isFinite(rawSegmentMaxBytes) && rawSegmentMaxBytes >= 1024 * 1024
  ? rawSegmentMaxBytes
  : DEFAULT_LOG_SEGMENT_MAX_BYTES;
const rawMaxSegmentsPerDay = Number(process.env.MCP_REMOTE_LOG_MAX_SEGMENTS_PER_DAY || DEFAULT_LOG_MAX_SEGMENTS_PER_DAY);
const LOG_MAX_SEGMENTS_PER_DAY = Number.isFinite(rawMaxSegmentsPerDay) && rawMaxSegmentsPerDay >= 2
  ? Math.floor(rawMaxSegmentsPerDay)
  : DEFAULT_LOG_MAX_SEGMENTS_PER_DAY;

// Ensure log directory exists
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function todayLogPrefix() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `agentport-${today}`;
}

function segmentPath(prefix, index) {
  return path.join(LOG_DIR, index === 0 ? `${prefix}.log` : `${prefix}.${index}.log`);
}

function segmentIndex(file, prefix) {
  if (file === `${prefix}.log`) return 0;
  const match = file.match(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(\\d+)\\.log$`));
  return match ? Number(match[1]) : null;
}

// Get a log file path that can accept this entry, rotating by size when needed.
function getLogFilePath(bytesToWrite) {
  const prefix = todayLogPrefix();
  const files = fs.readdirSync(LOG_DIR)
    .map((file) => {
      const index = segmentIndex(file, prefix);
      const filePath = index === null ? null : segmentPath(prefix, index);
      const stat = filePath ? fs.statSync(filePath) : null;
      return { file, index, mtimeMs: stat?.mtimeMs || 0, size: stat?.size || 0 };
    })
    .filter((entry) => Number.isInteger(entry.index))
    .sort((a, b) => a.index - b.index);

  for (const { index, size } of files) {
    if (size + bytesToWrite <= LOG_SEGMENT_MAX_BYTES) return segmentPath(prefix, index);
  }

  if (files.length < LOG_MAX_SEGMENTS_PER_DAY) {
    const nextIndex = files.length ? Math.max(...files.map((entry) => entry.index)) + 1 : 0;
    return segmentPath(prefix, nextIndex);
  }

  const oldest = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs)[0];
  try {
    fs.unlinkSync(segmentPath(prefix, oldest.index));
  } catch {}
  return segmentPath(prefix, oldest.index);
}

// Cleanup old log files (older than MAX_DAYS)
function cleanupOldLogs() {
  try {
    const files = fs.readdirSync(LOG_DIR);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    for (const file of files) {
      if (
        file.startsWith("agentport-")
        && file.endsWith(".log")
      ) {
        const dateMatch = file.match(/^agentport-(\d{4}-\d{2}-\d{2})(?:\.\d+)?\.log$/);
        if (dateMatch && dateMatch[1] < cutoffStr) {
          const filePath = path.join(LOG_DIR, file);
          fs.unlinkSync(filePath);
        }
      }
    }
  } catch (e) {
    // Ignore cleanup errors
  }
}

const REDACTED = "[REDACTED]";
const MAX_EMBEDDED_JSON_DEPTH = 8;
const MAX_EMBEDDED_JSON_FRAGMENTS = 256;
const MAX_EMBEDDED_JSON_SCAN_CHARS = 1024 * 1024;

function isSensitiveKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
  return /(?:token|password|passphrase|privatekey|apikey|secret|authorization)$/.test(normalized);
}

function findJsonFragmentEnd(value, start, state) {
  const closers = [value[start] === "{" ? "}" : "]"];
  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < value.length; index += 1) {
    if (state.scanRemaining <= 0) return { limitReached: true };
    state.scanRemaining -= 1;
    const character = value[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") {
      if (closers.length >= 128) return { invalid: true };
      closers.push(character === "{" ? "}" : "]");
    }
    else if (character === "}" || character === "]") {
      if (closers.pop() !== character) return { invalid: true };
      if (closers.length === 0) return { end: index + 1 };
    }
  }
  return { incomplete: true };
}

function redactString(value, seen = new WeakSet(), state = createRedactionState(), embeddedDepth = 0) {
  let result = value
    .replace(/\bBearer\s+[^\s,;"'<>]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b((?:x-agentport-broker-token|authorization|auth[\s_-]*token|access[\s_-]*token|refresh[\s_-]*token|api[\s_-]*key|private[\s_-]*key|passphrase|password|secret|token))\s*([=:])\s*(?:"([^"]*)"|'([^']*)'|([^\s,;&]+))/gi,
      (_match, key, separator) => `${key}${separator}${REDACTED}`);

  const trimmed = result.trim();
  if (trimmed.length <= MAX_EMBEDDED_JSON_SCAN_CHARS
    && ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]")))) {
    try {
      const parsed = JSON.parse(trimmed);
      if (embeddedDepth >= MAX_EMBEDDED_JSON_DEPTH) return REDACTED;
      const sanitized = sanitizeValue(parsed, "", seen, state, embeddedDepth + 1);
      return result.replace(trimmed, () => JSON.stringify(sanitized));
    } catch {}
  }

  let output = "";
  let copiedUntil = 0;
  let fragments = 0;
  for (let index = 0; index < result.length; index += 1) {
    if (result[index] !== "{" && result[index] !== "[") continue;
    const boundary = findJsonFragmentEnd(result, index, state);
    if (boundary.limitReached || boundary.incomplete) {
      return output + result.slice(copiedUntil, index) + REDACTED;
    }
    if (!boundary.end) continue;

    let parsed;
    try {
      parsed = JSON.parse(result.slice(index, boundary.end));
    } catch {
      continue;
    }
    if (embeddedDepth >= MAX_EMBEDDED_JSON_DEPTH || fragments >= MAX_EMBEDDED_JSON_FRAGMENTS) {
      return output + result.slice(copiedUntil, index) + REDACTED;
    }
    output += result.slice(copiedUntil, index);
    output += JSON.stringify(sanitizeValue(parsed, "", seen, state, embeddedDepth + 1));
    copiedUntil = boundary.end;
    index = boundary.end - 1;
    fragments += 1;
  }
  result = output + result.slice(copiedUntil);
  return result.replace(/(['"])((?:x-agentport-broker-token|authorization|auth[\s_-]*token|access[\s_-]*token|refresh[\s_-]*token|api[\s_-]*key|private[\s_-]*key|passphrase|password|secret|token))\1\s*:\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi,
    (_match, quote, key) => `${quote}${key}${quote}: ${quote}${REDACTED}${quote}`);
}

function createRedactionState() {
  return { scanRemaining: MAX_EMBEDDED_JSON_SCAN_CHARS };
}

function sanitizeValue(value, key, seen, state, embeddedDepth) {
  if (key && isSensitiveKey(key)) return REDACTED;
  if (typeof value === "string") return redactString(value, seen, state, embeddedDepth);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (value instanceof Error) {
    const result = {
      name: redactString(value.name, seen, state, embeddedDepth),
      message: redactString(value.message, seen, state, embeddedDepth),
      code: sanitizeValue(value.code, "code", seen, state, embeddedDepth),
      stack: value.stack ? redactString(value.stack, seen, state, embeddedDepth) : undefined,
    };
    for (const property of Object.keys(value)) {
      if (!(property in result)) result[property] = sanitizeValue(value[property], property, seen, state, embeddedDepth);
    }
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, "", seen, state, embeddedDepth));

  const result = {};
  for (const [property, item] of Object.entries(value)) {
    result[property] = sanitizeValue(item, property, seen, state, embeddedDepth);
  }
  return result;
}

function truncateUtf8(value, limit) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= limit) return value;
  const marker = "...[truncated]";
  let end = Math.max(0, limit - Buffer.byteLength(marker));
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8") + marker;
}

const CALL_FIELDS = [
  "callId", "originCallId", "sessionId", "durationMs", "outcome", "callOutcome",
  "failureCategory", "errorCode", "causeCode", "causeStatus", "taskId", "executionStatus", "role",
];

function compactValue(value, stringBytes, collectionLimit, depth = 0) {
  if (typeof value === "string") return truncateUtf8(value, stringBytes);
  if (!value || typeof value !== "object") return value;
  if (depth >= 5) return "[truncated depth]";
  if (Array.isArray(value)) {
    const items = value.slice(0, collectionLimit).map((item) => compactValue(item, stringBytes, collectionLimit, depth + 1));
    if (items.length < value.length) items.push(`[${value.length - items.length} omitted]`);
    return items;
  }
  const keys = depth === 0
    ? [...CALL_FIELDS.filter((key) => Object.hasOwn(value, key)), ...Object.keys(value).filter((key) => !CALL_FIELDS.includes(key))]
    : Object.keys(value);
  const result = {};
  for (const key of keys.slice(0, depth === 0 ? CALL_FIELDS.length + collectionLimit : collectionLimit)) {
    result[key] = depth === 0 && CALL_FIELDS.includes(key) && typeof value[key] !== "object"
      ? (typeof value[key] === "string" ? truncateUtf8(value[key], 160) : value[key])
      : compactValue(value[key], stringBytes, collectionLimit, depth + 1);
  }
  if (Object.keys(result).length < keys.length) result._omittedKeys = keys.length - Object.keys(result).length;
  return result;
}

function safeStringify(value) {
  const sanitized = sanitizeValue(value, "", new WeakSet(), createRedactionState(), 0);
  const serialized = JSON.stringify(sanitized) ?? "null";
  const originalBytes = Buffer.byteLength(serialized);
  if (originalBytes <= DATA_MAX_BYTES) return serialized;
  const source = sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized : { value: sanitized };
  const metadata = { _truncated: true, _originalBytes: originalBytes };
  // Shrink values before serializing, so even clipped records retain valid JSON.
  for (const budget of [1024, 512, 256, 128, 64]) {
    const result = JSON.stringify({ ...compactValue(source, budget, budget >= 512 ? 8 : 3), ...metadata });
    if (Buffer.byteLength(result) <= DATA_MAX_BYTES) return result;
  }
  const result = { ...metadata };
  const compact = compactValue(source, 64, 1);
  for (const key of [...CALL_FIELDS, "error", "hint", "value"]) {
    if (!Object.hasOwn(compact, key)) continue;
    const candidate = { ...result, [key]: compact[key] };
    if (Buffer.byteLength(JSON.stringify(candidate)) <= DATA_MAX_BYTES) result[key] = compact[key];
  }
  return JSON.stringify(result);
}

// Write log entry
function write(level, tool, message, data = null) {
  try {
    ensureLogDir();
    cleanupOldLogs();

    const timestamp = new Date().toISOString();
    const state = createRedactionState();
    const safeTool = truncateUtf8(redactString(String(tool), new WeakSet(), state).replace(/[\r\n\[\]]/g, "_"), 80);
    const safeMessage = truncateUtf8(redactString(String(message), new WeakSet(), state).replace(/[\r\n]/g, " "), MESSAGE_MAX_BYTES);
    let logLine = `[${timestamp}] [${level}] [${safeTool}] ${safeMessage}`;

    if (data) {
      const dataStr = safeStringify(data);
      logLine += `\n  Data: ${dataStr}`;
    }

    const encoded = Buffer.from(logLine + "\n", "utf8");
    const logFile = getLogFilePath(encoded.length);
    fs.appendFileSync(logFile, encoded);
  } catch (e) {
    // Silently fail - don't break main functionality
  }
}

// Public API
export const logger = {
  info: (tool, message, data) => write("INFO", tool, message, data),
  warn: (tool, message, data) => write("WARN", tool, message, data),
  error: (tool, message, data) => write("ERROR", tool, message, data),
  debug: (tool, message, data) => write("DEBUG", tool, message, data),
};

export default logger;
