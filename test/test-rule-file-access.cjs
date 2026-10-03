const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createDaemonConfigLoader, parseReadOnlyRuleFiles } = require("../daemon/config-loader.cjs");
const { createAgentPortGateway } = require("../daemon/modular-gateway.cjs");
const { createDevelopmentFrontServer, installDevelopmentResponseSanitizer } = require("../daemon/development-gateway-safe.cjs");
const { authorizeContext } = require("../daemon/auth-context.cjs");
const { createRuleFileReader, MAX_RULE_FILE_BYTES } = require("../packages/daemon-core/rule-file-reader.cjs");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function request(port, route, body, authenticated = true, extraHeaders = {}, method = "POST") {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, path: route, method,
      headers: {
        ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
        ...(authenticated ? { authorization: "Bearer test-secret", "x-mcp-client-id": "test-client" } : {}),
        ...extraHeaders,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, data: raw ? JSON.parse(raw) : null });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

async function denied(port, route, body) {
  const result = await request(port, route, body);
  assert.equal(result.status, 403, `${route}: ${JSON.stringify(result.data)}`);
  assert.equal(result.data.code, "EWORKSPACE");
}

async function testOpenedIdentity(rulePath) {
  const reader = createRuleFileReader([rulePath]);
  const originalOpen = fs.open;
  const oldPath = `${rulePath}.old`;
  let intercepted = false;
  let closed = false;
  fs.open = async (file, ...args) => {
    if (file !== rulePath) return originalOpen(file, ...args);
    intercepted = true;
    await fs.rename(rulePath, oldPath);
    await fs.writeFile(rulePath, "replacement must not be returned\n");
    const handle = await originalOpen(file, ...args);
    const originalClose = handle.close.bind(handle);
    handle.close = async () => { closed = true; return originalClose(); };
    return handle;
  };
  try {
    await assert.rejects(reader.readText(rulePath), { code: "EWORKSPACE" });
    assert.equal(intercepted, true);
    assert.equal(closed, true, "rejected file handle must close");
  } finally {
    fs.open = originalOpen;
    await fs.rm(rulePath);
    await fs.rename(oldPath, rulePath);
  }
}

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "agentport-rule-files-"));
  const workspace = path.join(base, "projects");
  const secondWorkspace = path.join(base, "second");
  const rules = path.join(base, "AGENTS.md");
  const secret = path.join(base, "private.txt");
  const envPath = path.join(base, "daemon.env");
  const content = "# Rules\nUse the approved workspace.\n";
  await fs.mkdir(workspace);
  await fs.mkdir(secondWorkspace);
  await fs.writeFile(rules, content);
  await fs.writeFile(secret, "must not be exposed\n");
  await fs.writeFile(path.join(workspace, "inside.txt"), "inside\n");
  await fs.writeFile(path.join(secondWorkspace, "inside.txt"), "second\n");
  const envKeys = ["WORKSPACE_ROOT", "WORKSPACE_ROOTS_JSON", "WORKSPACE_ROOTS_FILE", "DEFAULT_WORKSPACE",
    "READ_ONLY_RULE_FILES_JSON", "AUTH_TOKENS", "AUTH_TOKENS_JSON", "AUTH_TOKEN", "ADMIN_TOKENS"];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  const servers = [];
  let symlinkChecks = 0;
  async function configure(files, roots = { projects: workspace, second: secondWorkspace }) {
    const lines = [
      `WORKSPACE_ROOT=${roots.projects}`,
      `WORKSPACE_ROOTS_JSON='${JSON.stringify({ default: "projects", roots })}'`,
      "AUTH_TOKENS=test-client=test-secret",
      `AGENTPORT_JOBS_DIR=${path.join(base, "jobs")}`,
      `AUDIT_LOG_PATH=${path.join(base, "audit.log")}`,
      `HOME=${base}`,
    ];
    if (files !== undefined) lines.push(`READ_ONLY_RULE_FILES_JSON='${JSON.stringify(files)}'`);
    await fs.writeFile(envPath, `${lines.join("\n")}\n`);
  }
  try {
    assert.deepEqual(parseReadOnlyRuleFiles(), []);
    for (const bad of ["{", "null", "{}", '"a"', '["relative.md"]', '["/rules/*.md"]', JSON.stringify(Array(33).fill(rules))]) {
      assert.throws(() => parseReadOnlyRuleFiles(bad), { code: "ERULE_FILES_CONFIG" });
    }
    await configure();
    const loader = createDaemonConfigLoader({ baseDir: base, envPath });
    assert.deepEqual((await loader.load()).readOnlyRuleFiles, []);
    const legacy = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/healthz") return res.end(JSON.stringify({ ok: true }));
      res.writeHead(500);
      res.end(JSON.stringify({ error: "File operations must not fall back to legacy" }));
    });
    servers.push(legacy);
    const legacyPort = await listen(legacy);
    const modular = createAgentPortGateway({ legacyOrigin: `http://127.0.0.1:${legacyPort}`, configLoader: loader });
    servers.push(modular);
    const modularPort = await listen(modular);
    const front = createDevelopmentFrontServer({ baseOrigin: `http://127.0.0.1:${modularPort}`, configLoader: loader, authorizeContext });
    installDevelopmentResponseSanitizer(front);
    servers.push(front);
    const port = await listen(front);

    const health = await request(port, "/healthz", undefined, true, {}, "GET");
    assert.deepEqual(health.data.workspaceRoots, { projects: workspace, second: secondWorkspace });
    assert.equal(health.data.workspaceBoundary.enforced, true);
    assert.equal(health.data.workspaceBoundary.osIsolation, false);
    assert.equal(health.data.capabilities.readOnlyRuleFiles, true);
    const publicHealth = await request(port, "/healthz", undefined, false, {}, "GET");
    assert.equal(publicHealth.data.workspaceRoots, undefined);
    assert.equal(publicHealth.data.workspaceBoundary, undefined);

    await denied(port, "/api/fs/read", { path: rules });
    await configure([rules]);
    assert.deepEqual((await loader.load()).readOnlyRuleFiles, [rules]);
    assert.equal((await request(port, "/api/fs/read", { path: rules }, false)).status, 401);
    const result = await request(port, "/api/fs/read", { path: rules });
    assert.equal(result.status, 200);
    assert.equal(result.data.content, content);
    assert.equal(result.data.accessScope, "read-only-rule-file");
    assert.equal(result.data.readOnly, true);
    assert.equal(result.data.writeEtag, null);
    const limit = await request(port, "/api/fs/read", { path: rules, maxBytes: 1 });
    assert.equal(limit.status, 413);
    const wrongClient = await request(port, "/api/fs/read", { path: rules }, true, { "x-mcp-client-id": "other-client" });
    assert.equal(wrongClient.status, 403);
    assert.equal(wrongClient.data.code, "ECLIENT_ID");
    assert.equal((await request(port, "/read", { path: rules })).data.content, content);
    const range = await request(port, "/api/fs/read", { path: rules, startLine: 2, endLine: 2 });
    assert.equal(range.data.content, "Use the approved workspace.");
    const cached = await request(port, "/api/fs/read", { path: rules }, true, { "if-none-match": result.data.etag });
    assert.equal(cached.status, 304);
    const batch = await request(port, "/api/batch", { operations: [
      { type: "read", path: rules }, { type: "read", path: secret },
      { type: "write", path: rules, content: "not allowed" }, { type: "stat", path: rules },
    ] });
    assert.deepEqual(batch.data.results.map((item) => item.status), [200, 403, 403, 403]);
    assert.equal(batch.data.results[0].accessScope, "read-only-rule-file");

    await configure([rules], { projects: base });
    const workspaceRead = await request(port, "/api/fs/read", { path: rules });
    assert.equal(workspaceRead.status, 200);
    assert.equal(workspaceRead.data.writeEtag, workspaceRead.data.etag);
    assert.notEqual(workspaceRead.data.etag, result.data.etag);
    await configure([rules]);
    const scopedRead = await request(port, "/api/fs/read", { path: rules }, true, { "if-none-match": workspaceRead.data.etag });
    assert.equal(scopedRead.status, 200, "workspace cache must not conceal read-only metadata");
    assert.equal(scopedRead.data.content, workspaceRead.data.content);
    assert.equal(scopedRead.data.readOnly, true);
    assert.equal(scopedRead.data.writeEtag, null);
    const scopedBatch = await request(port, "/api/batch", { operations: [
      { type: "read", path: rules, ifNoneMatch: workspaceRead.data.etag },
      { type: "read", path: rules, ifNoneMatch: scopedRead.data.etag },
    ] });
    assert.deepEqual(scopedBatch.data.results.map((item) => item.status), [200, 304]);
    assert.equal(scopedBatch.data.results[0].readOnly, true);
    assert.equal(scopedBatch.data.results[0].writeEtag, null);
    await configure([rules], { projects: base });
    const restoredRead = await request(port, "/api/fs/read", { path: rules }, true, { "if-none-match": scopedRead.data.etag });
    assert.equal(restoredRead.status, 200, "rule-only cache must not conceal restored workspace metadata");
    assert.equal(restoredRead.data.writeEtag, workspaceRead.data.etag);
    const restoredBatch = await request(port, "/api/batch", { operations: [
      { type: "read", path: rules, ifNoneMatch: scopedRead.data.etag },
    ] });
    assert.equal(restoredBatch.data.results[0].status, 200);
    assert.equal(restoredBatch.data.results[0].writeEtag, workspaceRead.data.etag);
    await configure([rules]);
    for (const candidate of [secret, base, "../AGENTS.md", `${base}${path.sep}projects${path.sep}..${path.sep}AGENTS.md`]) {
      await denied(port, "/api/fs/read", { path: candidate });
    }
    for (const route of ["/api/fs/stat", "/api/fs/read-bytes", "/api/fs/manifest"]) {
      await denied(port, route, { path: rules });
    }
    await denied(port, "/api/fs/write", { path: rules, content: "not allowed" });
    await denied(port, "/api/fs/remove", { path: rules });
    await denied(port, "/api/fs/glob", { cwd: base, pattern: "**/*" });
    await denied(port, "/api/fs/grep", { cwd: base, pattern: "Rules" });
    await denied(port, "/api/exec", { cwd: base, command: "echo must-not-execute" });
    assert.equal(await fs.readFile(rules, "utf8"), content);
    assert.equal((await request(port, "/api/fs/read", { path: "inside.txt" })).data.content, "inside\n");
    assert.equal((await request(port, "/api/fs/read", { path: "second:/inside.txt" })).data.content, "second\n");

    await testOpenedIdentity(rules);
    const audit = await fs.readFile(path.join(base, "audit.log"), "utf8");
    assert.match(audit, /"accessScope":"read-only-rule-file"/);
    assert.ok(!audit.includes("Use the approved workspace."), "audit must not log rule contents");
    const oversized = path.join(base, "large.md");
    await fs.writeFile(oversized, "a".repeat(MAX_RULE_FILE_BYTES + 1));
    const largeReader = createRuleFileReader([oversized]);
    await assert.rejects(largeReader.readText(oversized, { startLine: 1, maxBytes: 50 * 1024 * 1024 }), { code: "EFILESIZE" });
    await assert.rejects(createRuleFileReader([base]).readText(base), { code: "EWORKSPACE" });
    const invalidText = path.join(base, "invalid.md");
    await fs.writeFile(invalidText, Buffer.from([0xff, 0xfe]));
    await assert.rejects(createRuleFileReader([invalidText]).readText(invalidText), { code: "ERULE_FILE_ENCODING" });

    const linked = path.join(base, "linked-rules.md");
    try {
      await fs.symlink(secret, linked, "file");
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
    }
    if (await fs.lstat(linked).catch(() => null)) {
      await assert.rejects(createRuleFileReader([linked]).readText(linked), { code: "EWORKSPACE" });
      await configure([rules, linked]);
      await denied(port, "/api/fs/read", { path: linked });
      symlinkChecks += 2;
    }
    const linkedParent = path.join(base, "linked-parent");
    await fs.symlink(base, linkedParent, process.platform === "win32" ? "junction" : "dir");
    const alias = path.join(linkedParent, "AGENTS.md");
    await assert.rejects(createRuleFileReader([alias]).readText(alias), { code: "EWORKSPACE" });
    await configure([rules, alias]);
    await denied(port, "/api/fs/read", { path: alias });
    symlinkChecks += 1;

    await configure([]);
    await denied(port, "/api/fs/read", { path: rules });
  } finally {
    for (const server of servers.reverse()) await close(server);
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await fs.rm(base, { recursive: true, force: true });
  }
  console.log(`PASS rule-file config, authenticated public gateway, batch, scope-aware cache, revocation, unchanged workspace boundaries, FD identity and ${symlinkChecks} symlink checks`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
