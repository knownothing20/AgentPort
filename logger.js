/**
 * Local logging module for mcp-remote-agent
 * - Daily rotation (one file per day)
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
const rawDataMaxBytes = Number(process.env.MCP_REMOTE_LOG_DATA_MAX_BYTES || DEFAULT_DATA_MAX_BYTES);
const DATA_MAX_BYTES = Number.isFinite(rawDataMaxBytes) && rawDataMaxBytes > 200
  ? rawDataMaxBytes
  : DEFAULT_DATA_MAX_BYTES;

// Ensure log directory exists
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

// Get today's log file path
function getLogFilePath() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOG_DIR, `mcp-remote-agent-${today}.log`);
}

// Cleanup old log files (older than MAX_DAYS)
function cleanupOldLogs() {
  try {
    const files = fs.readdirSync(LOG_DIR);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    for (const file of files) {
      if (file.startsWith("mcp-remote-agent-") && file.endsWith(".log")) {
        const dateMatch = file.match(/mcp-remote-agent-(\d{4}-\d{2}-\d{2})\.log/);
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

    const logFile = getLogFilePath();
    fs.appendFileSync(logFile, logLine + "\n");
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
