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

const LOG_DIR = path.join(__dirname, "local", "logs");
const MAX_DAYS = 7;
const DEFAULT_DATA_MAX_BYTES = 4000;
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

function safeStringify(value) {
  if (typeof value === "string") return value;
  const seen = new WeakSet();
  return JSON.stringify(value, (key, item) => {
    if (item instanceof Error) {
      return {
        name: item.name,
        message: item.message,
        code: item.code,
        stack: item.stack,
      };
    }
    if (typeof item === "object" && item !== null) {
      if (seen.has(item)) return "[Circular]";
      seen.add(item);
    }
    return item;
  });
}

// Write log entry
function write(level, tool, message, data = null) {
  try {
    ensureLogDir();
    cleanupOldLogs();

    const timestamp = new Date().toISOString();
    let logLine = `[${timestamp}] [${level}] [${tool}] ${message}`;

    if (data) {
      // Truncate long data for readability
      const dataStr = safeStringify(data);
      if (dataStr.length > DATA_MAX_BYTES) {
        logLine += `\n  Data: ${dataStr.slice(0, DATA_MAX_BYTES)}... (truncated ${dataStr.length - DATA_MAX_BYTES} chars)`;
      } else {
        logLine += `\n  Data: ${dataStr}`;
      }
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
