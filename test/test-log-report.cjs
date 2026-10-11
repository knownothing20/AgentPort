const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const source = pathToFileURL(path.join(__dirname, "..", "packages", "client-core", "log-report.js")).href;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentport-log-report-"));

function row(when, level, tool, message, data) {
  return `[${when}] [${level}] [${tool}] ${message}${data === undefined ? "" : `\n  Data: ${data}`}\n`;
}

function write(dir, name, text) {
  fs.writeFileSync(path.join(dir, name), text, "utf8");
}

(async () => {
  const { analyzeLogs, formatLogReport } = await import(source);
  const dir = path.join(temp, "synthetic");
  fs.mkdirSync(dir);
  const now = new Date("2026-10-11T12:00:00.000Z");
  const d = (n) => `2026-10-${String(n).padStart(2, "0")}T10:00:00.000Z`;
  const entries = [
    row(d(11), "info", "remote_read", "Start call remote_read", JSON.stringify({ originCallId: "origin-one" })),
    row(d(11), "info", "remote_read", "Completed call remote_read in 12 ms", JSON.stringify({ originCallId: "origin-one", durationMs: 12 })),
    row(d(11), "info", "remote_read", "Completed call remote_read in 19 ms", JSON.stringify({ originCallId: "origin-one", durationMs: 19 })),
    row(d(11), "error", "remote_read", "Failed call remote_read", JSON.stringify({ originCallId: "origin-one", failureCategory: "transport" })),
    row(d(11), "info", "remote_stat", "Completed call remote_stat", JSON.stringify({ sessionId: "s-a", callId: "same", durationMs: 8 })),
    row(d(11), "info", "remote_stat", "Completed call remote_stat", JSON.stringify({ sessionId: "s-b", callId: "same", durationMs: 10 })),
    row(d(11), "error", "remote_write", "Failed call remote_write ENOSPC", "{truncated"),
    row(d(11), "error", "remote_exec", "Failed call remote_exec ENOENT", "{corrupt"),
    row(d(11), "error", "remote_read", "Failed call remote_read bearer TOP_SECRET_TOKEN at C:\\private\\secret", undefined),
    row(d(11), "info", "unknown_private_tool", "Completed call #44", JSON.stringify({ originCallId: "secret-origin", callOutcome: "succeeded", _truncated: true, _originalBytes: 9000, args: "SECRET_ARGUMENT", sessionId: "secret-session" })),
    row(d(11), "info", "remote_task", "Slow call remote_task", JSON.stringify({ originCallId: "slow-one", executionStatus: "pending" })),
    row(d(11), "info", "remote_task", "Start call remote_task", JSON.stringify({ originCallId: "never-terminal" })),
    row(d(11), "error", "remote_bash", "Failed call #10", JSON.stringify({ sessionId: "numeric-id", callId: 7, callOutcome: "failed", errorCode: "ECONNREFUSED" })),
    row(d(11), "error", "remote_bash", "Failed call #10", JSON.stringify({ sessionId: "numeric-id", callId: 7, callOutcome: "failed", errorCode: "ECONNREFUSED" })),
    row(d(11), "error", "remote_bash", "Failed call #11", JSON.stringify({ sessionId: "numeric-id", callId: 8, callOutcome: "failed", errorCode: "ECONNREFUSED", stdout: "business result: connection refused" })),
    row(d(11), "error", "remote_read", "Failed call #14", JSON.stringify({ originCallId: "cause-code", callOutcome: "failed", causeCode: "EHOSTUNREACH" })),
    row(d(11), "error", "remote_read", "Failed call #15", JSON.stringify({ originCallId: "error-code", callOutcome: "failed", error: "ECONNRESET" })),
    row(d(11), "info", "remote_task", "Completed call #12", JSON.stringify({ originCallId: "pending-job", outcome: "pending", executionStatus: "queued", errorCode: "ECONNREFUSED" })),
    row(d(11), "info", "remote_task", "Completed call #13", JSON.stringify({ originCallId: "running-job", outcome: "completed", executionStatus: "running" })),
    row(d(11), "error", "remote_write", "Failed call #16", JSON.stringify({ originCallId: "actual-unknown", callOutcome: "unknown", errorCode: "EOUTCOME_UNKNOWN" })),
    row(d(11), "info", "remote_task", "Completed call #17", JSON.stringify({ originCallId: "submitted-job", outcome: "submitted", executionStatus: "submitted" })),
    row(d(11), "info", "remote_task", "Completed call #17", JSON.stringify({ originCallId: "submitted-job", outcome: "submitted", executionStatus: "submitted" })),
  ];
  write(dir, "agentport-2026-10-11.log", entries.join(""));
  write(dir, "agentport-2026-10-11.1.log", row(d(11), "info", "remote_read", "Completed call remote_read", JSON.stringify({ originCallId: "rotation-newer" })));
  write(dir, "agentport-2026-10-10.log", row("2026-10-10T10:00:00.000Z", "info", "remote_exec", "Completed call remote_exec", JSON.stringify({ originCallId: "in-window" })));
  write(dir, "agentport-2026-10-01.log", row("2026-10-01T10:00:00.000Z", "info", "remote_read", "Failed call", JSON.stringify({ originCallId: "old" })));
  write(dir, "agentport-2026-10-11x.log", "ignore");
  write(dir, "other.log", "ignore");
  try { fs.symlinkSync(path.join(dir, "agentport-2026-10-11.log"), path.join(dir, "agentport-2026-10-11.2.log")); } catch {}

  const report = await analyzeLogs({ directory: dir, days: 2, now });
  assert.equal(report.scope, "observed-mcp-logs-only");
  assert.equal(report.coverage.candidateFiles, 3);
  assert.equal(report.coverage.selectedFiles, 3);
  assert.equal(report.totals.rawRecords, 22);
  assert.equal(report.totals.deduplicatedObservedCalls, 15);
  assert.equal(report.totals.callOutcome.unknown, 5, "incomplete observations and explicit unknown outcomes are not claimed successful");
  assert.equal(report.totals.callOutcome.success, 6);
  assert.equal(report.totals.callOutcome.failed, 4);
  assert.equal(report.totals.incompleteStarts, 1);
  assert.equal(report.totals.uncorrelatedTerminalRecords, 3);
  assert.equal(report.totals.executionStatus.pending, 2);
  assert.equal(report.totals.executionStatus.submitted, 1, "matching outcome/execution status and proxy records count once");
  assert.equal(report.totals.executionStatus.queued, 1);
  assert.equal(report.totals.executionStatus.running, 1);
  assert.equal(report.totals.conflictingCalls, 1);
  assert.equal(report.totals.failureCategories.transport, 3, "errorCode, causeCode, and data.error use stable code classification");
  assert.equal(report.totals.failureCategories["command-failed"], 1, "business stdout is not classified as transport");
  assert.equal(report.totals.failureCategories["outcome-unknown"], 1, "missing metadata and conflicting observations are not EOUTCOME_UNKNOWN failures");
  assert.equal(report.totals.uncorrelatedFailures["disk-full"], 1);
  assert.equal(report.totals.uncorrelatedFailures["missing-file"], 1);
  assert.equal(report.coverage.unavailableDataRecords, 3);
  assert.equal(report.coverage.clippedDetails, 1, "valid truncated Data retains available outcome and identity");
  assert.equal(report.totals.tools.other.success, 1);
  assert.equal(report.totals.tools.remote_bash.callCount, 2);
  assert.equal(report.totals.tools.remote_read.latencyMs.max, 19, "deduplicated proxy/owner duration uses maximum");
  assert.equal(report.coverage.uncertain, true);

  const rendered = formatLogReport(report);
  for (const secret of ["TOP_SECRET_TOKEN", "SECRET_ARGUMENT", "secret-origin", "secret-session", "private", "secret", "synthetic-log-report"]) {
    assert.equal(JSON.stringify(report).includes(secret), false, `aggregate must omit ${secret}`);
    assert.equal(rendered.includes(secret), false, `formatted report must omit ${secret}`);
  }
  assert.match(rendered, /not daemon\/business availability or success rate/);
  assert.match(rendered, /not evidence of failure/);
  assert.match(rendered, /command-failed=1/);
  assert.match(rendered, /remote_bash=2 calls\/p95 n\/a/);
  const hostileReport = {
    ...report,
    totals: {
      ...report.totals,
      failureCategories: { ...report.totals.failureCategories, "C:\\secret-category": 1 },
      tools: { ...report.totals.tools, "C:\\private\\secret.log": { callCount: 1, latencyMs: { p95: 1 } } },
    },
  };
  const hostileText = formatLogReport(hostileReport);
  assert.equal(hostileText.includes("secret-category"), false);
  assert.equal(hostileText.includes("secret.log"), false);

  const regexDir = path.join(temp, "regex-categories");
  fs.mkdirSync(regexDir);
  write(regexDir, "agentport-2026-10-11.log", [
    row(d(11), "error", "remote_grep", "Failed call #1: Invalid regular expression: /(?i)text/: Invalid group", JSON.stringify({ originCallId: "legacy-regex" })),
    row(d(11), "error", "remote_grep", "Failed call #2", JSON.stringify({ originCallId: "coded-regex", errorCode: "EREGEX" })),
  ].join(""));
  const regexReport = await analyzeLogs({ directory: regexDir, now });
  assert.equal(regexReport.totals.failureCategories["invalid-regex"], 2, "legacy regex text and EREGEX have the same category");

  const bounded = path.join(temp, "bounded");
  fs.mkdirSync(bounded);
  const huge = "界🙂".repeat(120000);
  write(bounded, "agentport-2026-10-11.log", row(d(11), "info", "remote_read", "Completed call before-oversize", JSON.stringify({ originCallId: "bounded" })) + `${huge}\n` + row(d(11), "info", "remote_read", "Completed call after-oversize", JSON.stringify({ originCallId: "after" })));
  const boundedReport = await analyzeLogs({ directory: bounded, days: 1, now, maxBytes: 1000, maxFiles: 1 });
  assert.equal(boundedReport.coverage.scannedBytes, 1000);
  assert.equal(boundedReport.coverage.partialFiles, 1);
  assert.equal(boundedReport.coverage.uncertain, true);
  assert.ok(boundedReport.totals.deduplicatedObservedCalls <= 1);
  assert.ok(JSON.stringify(boundedReport).length < 5000);

  const rotation = path.join(temp, "rotation");
  fs.mkdirSync(rotation);
  write(rotation, "agentport-2026-10-11.log", row(d(11), "info", "remote_read", "Completed call", JSON.stringify({ originCallId: "base" })));
  write(rotation, "agentport-2026-10-11.1.log", row(d(11), "info", "remote_read", "Completed call", JSON.stringify({ originCallId: "segment-one", durationMs: 11 })));
  write(rotation, "agentport-2026-10-11.2.log", row(d(11), "info", "remote_read", "Completed call", JSON.stringify({ originCallId: "segment-two", durationMs: 22 })));
  fs.utimesSync(path.join(rotation, "agentport-2026-10-11.log"), new Date("2026-10-11T09:30:00Z"), new Date("2026-10-11T09:30:00Z"));
  fs.utimesSync(path.join(rotation, "agentport-2026-10-11.1.log"), new Date("2026-10-11T11:30:00Z"), new Date("2026-10-11T11:30:00Z"));
  fs.utimesSync(path.join(rotation, "agentport-2026-10-11.2.log"), new Date("2026-10-11T10:30:00Z"), new Date("2026-10-11T10:30:00Z"));
  const firstOnly = await analyzeLogs({ directory: rotation, days: 1, now, maxFiles: 1 });
  assert.equal(firstOnly.totals.deduplicatedObservedCalls, 1);
  assert.equal(firstOnly.coverage.selectedFiles, 1);
  assert.equal(firstOnly.coverage.omittedFiles, 2);
  assert.equal(firstOnly.coverage.uncertain, true);
  assert.equal(firstOnly.totals.tools.remote_read.latencyMs.max, 11, "newest mtime wins over segment number ordering");

  const oversized = await analyzeLogs({ directory: bounded, days: 1, now });
  assert.equal(oversized.coverage.oversizedLines, 1, "large physical lines are discarded without buffering them whole");
  assert.equal(oversized.totals.deduplicatedObservedCalls, 2);

  const emptyWindow = await analyzeLogs({ directory: dir, days: 0, now: new Date("2026-10-11T09:00:00Z") });
  assert.equal(emptyWindow.totals.deduplicatedObservedCalls, 0);
  await assert.rejects(() => analyzeLogs({ directory: dir, maxBytes: -1 }), /Unable to analyze local logs/);

  console.log("log-report tests passed");
})().finally(() => fs.rmSync(temp, { recursive: true, force: true }));
