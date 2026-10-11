const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const loggerUrl = pathToFileURL(path.join(root, "logger.js")).href;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentport-local-logging-"));
const logDir = path.join(tempRoot, "logs");
const runner = `
  import logger from ${JSON.stringify(loggerUrl)};
  const mode = process.env.TEST_LOG_MODE;
  if (mode === "redaction") {
    const circular = { label: "keep this diagnostic" };
    circular.self = circular;
    const embeddedJson = '{"token":"synthetic-secret","x-agentport-broker-token":"other-secret","normal":"normal-field-retained"}';
    const nestedEncodedJson = JSON.stringify({ payload: JSON.stringify({ token: "message-embedded-secret", normal: "embedded-normal-retained" }) });
    const error = new Error("failed Bearer error-bearer-secret secret=error-secret");
    error.stack = "Error: Authorization: Bearer stack-secret\\n at test; request failed: " + embeddedJson + "; nested: " + nestedEncodedJson;
    error.privateKey = "error-property-secret";
    logger.info("test", "message Bearer message-secret secret=message-secret authToken=message-auth-secret api key=message-api-secret; request failed: " + embeddedJson + "; nested: " + nestedEncodedJson + " https://example.invalid/path?token=url-token-secret&status=keep-status", {
      nested: { token: "nested-token-secret", authToken: "auth-token-secret", passphrase: "passphrase-secret", privateKey: "private-key-secret", apiKey: "api-key-secret", "x-agentport-broker-token": "broker-token-secret", Authorization: "Bearer authorization-secret", ordinary: "diagnostic retained" },
      array: [{ password: "array-password-secret" }],
      error,
      circular,
      json: "{\\"token\\":\\"json-token-secret\\",\\"note\\":\\"JSON diagnostic\\"}",
    });
    const dataNestedEncodedJson = JSON.stringify({ payload: JSON.stringify({ token: "data-embedded-secret", normal: "data-normal-retained" }) });
    logger.info("test", "data string nested JSON", "data failure: " + dataNestedEncodedJson);
    logger.info("test", "normal Bearer explanation is not needed", { status: "healthy", detail: "ordinary diagnostic text remains" });
    for (const note of ["$&", "$'", "$$", String.fromCharCode(36, 96)]) {
      const replacementJson = JSON.stringify({ token: "replacement-secret", note });
      logger.info("test", replacementJson, { raw: replacementJson, error: new Error(replacementJson) });
    }
    const legacyQuoted = "request failed: {'token': 'legacy-quoted-secret', 'normal': 'legacy-normal-retained'}";
    const legacyError = new Error(legacyQuoted);
    legacyError.stack = legacyQuoted;
    logger.info("test", legacyQuoted, { raw: legacyQuoted, legacyError });
  } else if (mode === "boundary") {
    const boundaryJson = JSON.stringify({ payload: JSON.stringify({ token: "boundary-embedded-secret", normal: "boundary-normal-retained" }) });
    logger.info("test", "boundary check", "x".repeat(280) + " " + boundaryJson);
  } else if (mode === "rotation") {
    for (let index = 0; index < 1200; index++) logger.info("test", "rotation " + "a".repeat(1000));
  } else if (mode === "compact") {
    const multibyte = String.fromCodePoint(0x4e2d, 0x6587, 0x1f680).repeat(12000);
    logger.error("test", "bounded-message " + multibyte + "\\n[2020-01-01T00:00:00.000Z] [ERROR] [fake] forged", {
      callId: 7, originCallId: "fixture-origin", sessionId: "fixture-session", durationMs: 123,
      outcome: "failed", callOutcome: "failed", errorCode: "ETOOL", failureCategory: "command-failed",
      error: multibyte, diagnostic: { token: "compact-token-secret", huge: multibyte },
      entries: Array.from({ length: 100 }, (_, index) => ({ index, message: multibyte })),
    });
  }
`;

function run(mode, dataMaxBytes = "10000") {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", runner], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      MCP_REMOTE_LOG_DIR: logDir,
      MCP_REMOTE_LOG_DATA_MAX_BYTES: dataMaxBytes,
      MCP_REMOTE_LOG_SEGMENT_MAX_BYTES: "1048576",
      MCP_REMOTE_LOG_MAX_SEGMENTS_PER_DAY: "4",
      TEST_LOG_MODE: mode,
    },
  });
  assert.equal(result.status, 0, `${mode} subprocess failed: ${result.stderr || result.error || "unknown error"}`);
}

try {
  run("redaction");
  const initialFiles = fs.readdirSync(logDir).filter((file) => file.endsWith(".log"));
  assert.equal(initialFiles.length, 1, "expected one initial log segment");
  let contents = fs.readFileSync(path.join(logDir, initialFiles[0]), "utf8");

  for (const secret of [
    "nested-token-secret", "auth-token-secret", "passphrase-secret", "private-key-secret",
    "api-key-secret", "broker-token-secret", "authorization-secret", "array-password-secret",
    "error-bearer-secret", "error-secret", "stack-secret", "error-property-secret", "json-token-secret",
    "message-secret", "message-auth-secret", "message-api-secret", "synthetic-secret", "other-secret", "url-token-secret",
    "message-embedded-secret", "data-embedded-secret",
  ]) {
    assert.equal(contents.includes(secret), false, `secret leaked: ${secret}`);
  }
  for (const diagnostic of ["diagnostic retained", "JSON diagnostic", "ordinary diagnostic text remains", "normal-field-retained", "embedded-normal-retained", "data-normal-retained", "status=keep-status", "[Circular]"]) {
    assert.ok(contents.includes(diagnostic), `diagnostic was not retained: ${diagnostic}`);
  }
  assert.ok(contents.includes("Bearer [REDACTED]"), "Bearer value was not redacted");
  for (const secret of ["replacement-secret", "legacy-quoted-secret"]) {
    assert.equal(contents.includes(secret), false, `secret leaked: ${secret}`);
  }
  for (const retained of ["legacy-normal-retained", "$&", "$$"]) {
    assert.ok(contents.includes(retained), `diagnostic was not retained: ${retained}`);
  }
  assert.ok(contents.includes("?token=[REDACTED]&status=keep-status"), "URL token parameter was not redacted or neighboring query data was lost");
  assert.ok(contents.includes("failed Bearer [REDACTED]"), "Error message diagnostic was not retained");

  run("boundary", "300");
  contents = fs.readdirSync(logDir)
    .filter((file) => file.endsWith(".log"))
    .map((file) => fs.readFileSync(path.join(logDir, file), "utf8"))
    .join("\n");
  assert.equal(contents.includes("boundary-embedded-secret"), false, "nested JSON secret near the truncation boundary leaked");

  run("compact", "4000");
  const compactLog = fs.readdirSync(logDir).filter((file) => file.endsWith(".log"))
    .map((file) => fs.readFileSync(path.join(logDir, file), "utf8")).join("\n");
  const rows = compactLog.split("\n");
  const index = rows.findIndex((line) => line.includes("bounded-message"));
  assert.ok(index >= 0);
  assert.ok(Buffer.byteLength(rows[index].split("] ").slice(3).join("] ")) <= 1024);
  assert.equal(rows.some((line) => line.startsWith("[2020-01-01")), false, "message must not inject another record");
  const dataLine = rows[index + 1].slice("  Data: ".length);
  assert.ok(Buffer.byteLength(dataLine) <= 4000, "structured data limit is UTF-8 bytes");
  const data = JSON.parse(dataLine);
  assert.equal(data._truncated, true);
  assert.equal(data.callId, 7);
  assert.equal(data.originCallId, "fixture-origin");
  assert.equal(data.callOutcome, "failed");
  assert.equal(data.failureCategory, "command-failed");
  assert.equal(data.errorCode, "ETOOL");
  assert.equal(compactLog.includes("compact-token-secret"), false);
  assert.equal(dataLine.includes("\ufffd"), false, "UTF-8 truncation must not split a code point");
  for (const line of rows.filter((line) => line.startsWith("  Data: "))) JSON.parse(line.slice(8));

  run("rotation");
  const segments = fs.readdirSync(logDir).filter((file) => file.endsWith(".log"));
  assert.ok(segments.length >= 2, "size-based rotation did not create another segment");
  console.log("PASS local logging redaction, bounded UTF-8 messages, parseable metadata, and rotation");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
