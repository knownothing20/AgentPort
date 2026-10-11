import fs from "node:fs/promises";
import fsNative from "node:fs";
import path from "node:path";

const CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const CATEGORIES = ["transport", "outcome-unknown", "command-failed", "workspace-denied", "auth-denied", "missing-file", "invalid-regex", "disk-full", "other"];
const TOOLS = new Set([
  "remote_connect", "remote_health", "remote_status", "remote_read", "remote_write", "remote_safe_write",
  "remote_stat", "remote_glob", "remote_grep", "remote_exec", "remote_script", "remote_batch",
  "remote_bash", "remote_exec_async", "remote_script_async", "remote_task", "remote_config", "remote_setup",
  "remote_ssh_info", "remote_ssh_health", "remote_client_provision", "other",
]);
const HEADER = /^\[(\d{4}-\d\d-\d\dT[^\]]+)\] \[([^\]]+)\] \[([^\]]+)\] (.*)$/;

function emptyCounts(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function safeError() {
  return new Error("Unable to analyze local logs");
}

function classify(text) {
  const s = String(text || "").toLowerCase();
  if (/eoutcome_unknown|outcome\s*(?:=|:)\s*unknown|outcome unknown/.test(s)) return "outcome-unknown";
  if (/workspace_denied|eworkspace|workspace (?:access )?denied|outside configured workspace/.test(s)) return "workspace-denied";
  if (/auth_denied|unauthori[sz]ed|\bforbidden\b|\b401\b|\b403\b|invalid token/.test(s)) return "auth-denied";
  if (/enoent|missing file|no such file|not found/.test(s)) return "missing-file";
  if (/\beregex\b|invalid regular expression|invalid.regex|regex.*(?:invalid|unsupported)|unsupported.*regex/.test(s)) return "invalid-regex";
  if (/enospc|no space left|disk full/.test(s)) return "disk-full";
  if (/econnrefused|econnreset|econnaborted|epipe|enetunreach|ehostunreach|enotfound|eai_again|enetworkunreachable|ehostunreachable|etimedout|transport|socket hang up/.test(s)) return "transport";
  if (/command failed|exit code|exitcode|\bsignal\b/.test(s)) return "command-failed";
  return "other";
}

function identity(data) {
  const valid = (value) => typeof value === "string" && value.length <= 256 && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
  const validCall = (value) => valid(value) || (Number.isSafeInteger(value) && value >= 0);
  if (valid(data?.originCallId)) return `origin:${data.originCallId}`;
  if (valid(data?.sessionId) && validCall(data?.callId)) {
    return `session:${data.sessionId}\0${data.callId}`;
  }
  return null;
}

function eventFrom(record) {
  const message = record.message;
  const match = /^(Start|Completed|Failed|Slow) call\b/i.exec(message);
  if (!match) return null;
  const kind = match[1].toLowerCase();
  const data = record.data;
  const explicit = data?.callOutcome === "succeeded" || data?.callOutcome === "success" ? "success"
    : ["failed", "unknown"].includes(data?.callOutcome) ? data.callOutcome : null;
  const logOutcome = data?.outcome === "completed" ? "success"
    : ["failed", "unknown"].includes(data?.outcome) ? data.outcome : null;
  const pendingOutcome = data?.outcome === "submitted" || data?.outcome === "pending";
  const outcome = explicit || logOutcome || (pendingOutcome ? "unknown" : kind === "completed" ? "success" : kind === "failed" ? "failed" : "unknown");
  let durationMs = Number.isFinite(data?.durationMs) && data.durationMs >= 0 ? data.durationMs : null;
  if (durationMs === null) {
    const d = /\b(?:in|duration(?:Ms)?[=: ]+)\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?)\b/i.exec(message);
    if (d) durationMs = Number(d[1]);
  }
  const executionStatus = typeof data?.executionStatus === "string" && /^(submitted|pending|queued|running)$/i.test(data.executionStatus)
    ? data.executionStatus.toLowerCase() : null;
  const outcomeStatus = ["submitted", "pending"].includes(data?.outcome) ? data.outcome : null;
  const validCategory = CATEGORIES.includes(data?.failureCategory) ? data.failureCategory : null;
  const error = data?.error;
  const businessText = `${message} ${data?.message || ""} ${typeof error === "string" ? error : error?.message || ""} ${data?.stdout || ""} ${data?.stderr || ""} ${error?.stdout || ""} ${error?.stderr || ""}`;
  const businessOutput = /\b(?:stdout|stderr)\s*:/i.test(businessText)
    || /json\s+task\s+status/i.test(businessText)
    || typeof data?.stdout === "string" || typeof data?.stderr === "string"
    || typeof error?.stdout === "string" || typeof error?.stderr === "string";
  const categoryText = `${message} ${data?.code || ""} ${data?.errorCode || ""} ${data?.causeCode || ""} ${data?.status || ""} ${data?.message || ""} ${typeof error === "string" ? error : error?.message || ""} ${error?.code || ""} ${error?.causeCode || ""}`;
  const explicitUnknown = explicit === "unknown" || logOutcome === "unknown" || classify(categoryText) === "outcome-unknown";
  const category = validCategory || (pendingOutcome ? null : outcome === "unknown" ? (explicitUnknown ? "outcome-unknown" : null)
    : outcome === "failed" ? (businessOutput ? "command-failed" : classify(categoryText)) : null);
  return {
    kind, identity: identity(data), tool: TOOLS.has(record.tool) ? record.tool : "other",
    outcome, durationMs, executionStatus, outcomeStatus, category,
  };
}

async function readTail(file, start, size, { onLine, onDiscarded }) {
  const noFollow = fsNative.constants.O_NOFOLLOW || 0;
  const handle = await fs.open(file, fsNative.constants.O_RDONLY | noFollow);
  let pos = start;
  let carry = Buffer.alloc(0);
  let overlong = false;
  let oversizedLines = 0;
  let partialLines = 0;
  let bytesRead = 0;
  try {
    const chunk = Buffer.alloc(CHUNK_BYTES);
    let discardLeading = start > 0;
    while (pos < size) {
      const { bytesRead: got } = await handle.read(chunk, 0, Math.min(chunk.length, size - pos), pos);
      if (!got) break;
      bytesRead += got;
      pos += got;
      let readFrom = 0;
      if (discardLeading) {
        const newline = chunk.subarray(0, got).indexOf(10);
        if (newline < 0) continue;
        discardLeading = false;
        readFrom = newline + 1;
        partialLines += 1;
        onDiscarded("leading");
      }
      let from = readFrom;
      for (let i = readFrom; i < got; i += 1) {
        if (chunk[i] !== 10) continue;
        const piece = chunk.subarray(from, i);
        if (overlong || carry.length + piece.length > MAX_LINE_BYTES) {
          oversizedLines += 1;
          onDiscarded("oversized");
        }
        else {
          const line = Buffer.concat([carry, piece]).toString("utf8").replace(/\r$/, "");
          await onLine(line);
        }
        carry = Buffer.alloc(0);
        overlong = false;
        from = i + 1;
      }
      const rest = chunk.subarray(from, got);
      if (overlong || carry.length + rest.length > MAX_LINE_BYTES) {
        carry = Buffer.alloc(0);
        overlong = true;
      } else carry = Buffer.concat([carry, rest]);
    }
    if (overlong) {
      oversizedLines += 1;
      onDiscarded("oversized");
    }
    if ((carry.length && !overlong) || discardLeading) {
      partialLines += 1;
      onDiscarded(discardLeading ? "leading" : "partial");
    }
  } finally {
    await handle.close();
  }
  return { oversizedLines, partialLines, bytesRead };
}

/** Read-only aggregate diagnostics over top-level AgentPort daily log files. */
export async function analyzeLogs({ directory, days = 7, now = new Date(), maxBytes = 32 * 1024 * 1024, maxFiles = 64 } = {}) {
  if (typeof directory !== "string" || !Number.isFinite(days) || days < 0
    || !(now instanceof Date) || !Number.isFinite(now.getTime())
    || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxFiles) || maxFiles < 0) throw safeError();
  const totals = {
    rawRecords: 0, deduplicatedObservedCalls: 0, uncorrelatedTerminalRecords: 0, uncorrelatedFailures: emptyCounts(CATEGORIES),
    incompleteStarts: 0, conflictingCalls: 0,
    callOutcome: emptyCounts(["success", "failed", "unknown"]), executionStatus: emptyCounts(["submitted", "pending", "queued", "running"]),
    failureCategories: emptyCounts(CATEGORIES), tools: {},
  };
  const coverage = { candidateFiles: 0, selectedFiles: 0, omittedFiles: 0, skippedFiles: 0, scannedBytes: 0, availableBytes: 0, partialFiles: 0, discardedLeadingRecords: 0, discardedPartialLines: 0, oversizedLines: 0, unavailableDataRecords: 0, clippedDetails: 0, uncertain: false };
  const calls = new Map();
  const starts = new Set();
  const cutoff = now.getTime() - days * 86400000;
  let current = null;
  const finish = () => {
    if (!current) return;
    if (current.dataSeen) {
      try { current.data = JSON.parse(current.dataText); } catch { current.dataUnavailable = true; }
      if (!current.data || typeof current.data !== "object" || Array.isArray(current.data)) current.dataUnavailable = true;
      if (current.data?._truncated === true) coverage.clippedDetails += 1;
    }
    const e = eventFrom(current);
    if (e && (current.dataUnavailable || !current.dataSeen)) coverage.unavailableDataRecords += 1;
    if (e?.kind === "start") {
      if (e.identity) starts.add(`${e.tool}\0${e.identity}`);
    } else if (e) {
      totals.rawRecords += 1;
      if (!e.identity) totals.uncorrelatedTerminalRecords += 1;
      if (!e.identity && e.category) totals.uncorrelatedFailures[e.category] += 1;
      if (e.identity) {
        const key = `${e.tool}\0${e.identity}`;
        const prev = calls.get(key);
        if (!prev) calls.set(key, { ...e, conflict: false, executionStatuses: new Set(), outcomeStatuses: new Set() });
        const call = calls.get(key);
        if (e.executionStatus) call.executionStatuses.add(e.executionStatus);
        if (e.outcomeStatus) call.outcomeStatuses.add(e.outcomeStatus);
        if (prev) {
          if (prev.outcome !== e.outcome) {
            prev.outcome = "unknown";
            prev.category = null;
            prev.conflict = true;
          }
          if (e.durationMs !== null) prev.durationMs = Math.max(prev.durationMs ?? 0, e.durationMs);
          if (e.category && !prev.conflict) prev.category = e.category;
        }
      }
    }
    current = null;
  };
  try {
    const dirStat = await fs.lstat(directory);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw safeError();
    const names = await fs.readdir(directory);
    const candidates = [];
    for (const name of names) {
      const m = /^agentport-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log$/.exec(name);
      if (!m) continue;
      const day = Date.parse(`${m[1]}T00:00:00Z`);
      if (!Number.isFinite(day) || day > now.getTime() || day < cutoff - 86400000) continue;
      const full = path.join(directory, name);
      let stat;
      try { stat = await fs.lstat(full); } catch { coverage.skippedFiles += 1; coverage.uncertain = true; continue; }
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      candidates.push({ full, day, segment: m[2] ? Number(m[2]) : 0, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    coverage.candidateFiles = candidates.length;
    candidates.sort((a, b) => b.day - a.day || b.mtimeMs - a.mtimeMs || b.segment - a.segment);
    coverage.availableBytes = candidates.reduce((sum, file) => sum + file.size, 0);
    let remaining = maxBytes;
    for (const file of candidates.slice(0, maxFiles)) {
      const take = Math.min(file.size, remaining);
      if (take < file.size) coverage.partialFiles += 1;
      remaining -= take;
      if (!take) continue;
      const start = file.size - take;
      if (start > 0) coverage.uncertain = true;
      const invalidateCurrent = () => {
        if (current) {
          current.dataUnavailable = true;
          finish();
        }
        current = null;
      };
      try {
        const read = await readTail(file.full, start, file.size, {
          onDiscarded: (kind) => {
            coverage.uncertain = true;
            if (kind === "leading") coverage.discardedLeadingRecords += 1;
            invalidateCurrent();
          },
          onLine: async (line) => {
            const h = HEADER.exec(line);
            if (h) {
              finish();
              const timestamp = Date.parse(h[1]);
              if (!Number.isFinite(timestamp) || timestamp < cutoff || timestamp > now.getTime()) { current = null; return; }
              current = { timestamp, level: h[2], tool: h[3], message: h[4], dataSeen: false, dataText: "", data: null };
              return;
            }
            if (!current) return;
            if (line.startsWith("  Data:")) {
              current.dataSeen = true;
              current.dataText = line.slice(7).trim();
            }
          },
        });
        coverage.scannedBytes += read.bytesRead;
        coverage.oversizedLines += read.oversizedLines;
        coverage.discardedPartialLines += read.partialLines;
        coverage.selectedFiles += 1;
        finish();
      } catch {
        coverage.skippedFiles += 1;
        coverage.uncertain = true;
        invalidateCurrent();
      }
      if (remaining <= 0) break;
    }
  } catch {
    throw safeError();
  }
  totals.deduplicatedObservedCalls = calls.size;
  coverage.omittedFiles = Math.max(0, coverage.candidateFiles - coverage.selectedFiles - coverage.skippedFiles);
  for (const key of starts) if (!calls.has(key)) totals.incompleteStarts += 1;
  for (const call of calls.values()) {
    if (call.conflict) totals.conflictingCalls += 1;
    totals.callOutcome[call.outcome] += 1;
    if (call.category) totals.failureCategories[call.category] += 1;
    for (const status of new Set([...call.executionStatuses, ...call.outcomeStatuses])) totals.executionStatus[status] += 1;
    totals.tools[call.tool] ||= { success: 0, failed: 0, unknown: 0, durationsMs: [], callCount: 0 };
    const tool = totals.tools[call.tool];
    tool.callCount += 1;
    tool[call.outcome] += 1;
    if (call.durationMs !== null) tool.durationsMs.push(call.durationMs);
  }
  for (const tool of Object.values(totals.tools)) {
    tool.durationsMs.sort((a, b) => a - b);
    const values = tool.durationsMs;
    const percentile = (p) => values.length ? values[Math.ceil(p * values.length) - 1] : null;
    tool.latencyMs = { p50: percentile(0.5), p95: percentile(0.95), max: values.length ? values.at(-1) : null };
    delete tool.durationsMs;
  }
  if (coverage.partialFiles || coverage.omittedFiles || coverage.skippedFiles || coverage.discardedPartialLines || coverage.oversizedLines || coverage.unavailableDataRecords || totals.incompleteStarts || totals.uncorrelatedTerminalRecords) coverage.uncertain = true;
  return { scope: "observed-mcp-logs-only", window: { from: new Date(cutoff).toISOString(), to: now.toISOString() }, coverage, totals };
}

/** Render only aggregate values; never include source text or file identities. */
export function formatLogReport(report) {
  const t = report?.totals;
  if (!t || !report.coverage) throw safeError();
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const categories = CATEGORIES.filter((name) => count(t.failureCategories?.[name]) > 0).map((name) => `${name}=${count(t.failureCategories[name])}`);
  const uncorrelated = CATEGORIES.filter((name) => count(t.uncorrelatedFailures?.[name]) > 0).map((name) => `${name}=${count(t.uncorrelatedFailures[name])}`);
  const tools = Object.entries(t.tools).filter(([name]) => TOOLS.has(name)).sort((a, b) => count(b[1].callCount) - count(a[1].callCount) || a[0].localeCompare(b[0]))
    .map(([name, stats]) => `${name}=${count(stats.callCount)} calls/p95 ${Number.isFinite(stats.latencyMs?.p95) && stats.latencyMs.p95 >= 0 ? `${stats.latencyMs.p95}ms` : "n/a"}`);
  return [
    "Observed MCP log diagnostics (not daemon/business availability or success rate).",
    "No terminal record is not evidence of failure.",
    `Terminal records: ${count(t.rawRecords)}; deduplicated calls: ${count(t.deduplicatedObservedCalls)} (succeeded ${count(t.callOutcome?.success)}, failed ${count(t.callOutcome?.failed)}, unknown ${count(t.callOutcome?.unknown)}); conflicts ${count(t.conflictingCalls)}.`,
    `Failure categories (deduplicated): ${categories.join(", ") || "none"}.`,
    `Uncorrelated terminal records: ${count(t.uncorrelatedTerminalRecords)}; uncorrelated failures: ${uncorrelated.join(", ") || "none"}.`,
    `Execution states (deduplicated): ${["submitted", "pending", "queued", "running"].filter((name) => count(t.executionStatus?.[name]) > 0).map((name) => `${name}=${count(t.executionStatus[name])}`).join(", ") || "none"}.`,
    `Tools (calls/p95): ${tools.join("; ") || "none"}.`,
    `Incomplete starts: ${count(t.incompleteStarts)}. Coverage: ${count(report.coverage.scannedBytes)}/${count(report.coverage.availableBytes)} bytes; partial files ${count(report.coverage.partialFiles)}; discarded lines ${count(report.coverage.discardedPartialLines)}; clipped details ${count(report.coverage.clippedDetails)}; unavailable metadata ${count(report.coverage.unavailableDataRecords)}; skipped files ${count(report.coverage.skippedFiles)}; uncertain ${report.coverage.uncertain === true ? "yes" : "no"}.`,
  ].join("\n");
}
