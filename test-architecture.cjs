#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const ROOT = __dirname;

async function importModule(relativePath) {
  return import(new URL(relativePath, `file://${ROOT.replace(/\\/g, "/")}/`).href);
}

async function testOperationPolicy() {
  const { getOperationPolicy, canRetryOperation, canFallbackOperation } = await importModule("./packages/shared/operation-policy.js");
  assert.equal(getOperationPolicy("remote_read").class, "read");
  assert.equal(getOperationPolicy("remote_write").class, "write");
  assert.equal(canRetryOperation({ operation: "remote_read", requestAccepted: true }), true);
  assert.equal(canRetryOperation({ operation: "remote_exec_async", requestAccepted: true }), false);
  assert.equal(canRetryOperation({ operation: "remote_exec_async", requestAccepted: true, idempotencyKey: "build:abc" }), true);
  assert.equal(canFallbackOperation({ operation: "remote_write", identityMatch: false }), false);
  assert.equal(canFallbackOperation({ operation: "remote_write", identityMatch: true }), true);
}

async function testRequestContext() {
  const { createRequestContext, bindRequestEndpoint } = await importModule("./packages/shared/request-context.js");
  const context = createRequestContext({ operation: "remote_write", serverId: "debian-main", workspaceId: "projects" });
  assert.equal(context.policy.class, "write");
  assert.ok(context.requestId);
  context.serverId = "other";
  assert.equal(context.serverId, "debian-main");
  const bound = bindRequestEndpoint(context, { id: "lan", type: "daemon", name: "daemon-lan" });
  assert.equal(bound.endpointId, "lan");
  assert.equal(bound.route, "daemon");
}

async function testEndpointSelection() {
  const { selectEndpoint } = await importModule("./packages/client-core/endpoint-selector.js");
  const server = {
    id: "debian-main",
    workspaceId: "projects",
    endpoints: [
      { id: "lan", type: "daemon", scope: "lan", priority: 10 },
      { id: "vpn", type: "daemon", scope: "virtual-lan", priority: 20 },
      { id: "ssh", type: "ssh", scope: "recovery", priority: 30 },
    ],
  };
  const identity = { ok: true, serverId: "debian-main", workspaceId: "projects" };
  const selected = selectEndpoint({
    server,
    operation: "remote_write",
    healthByEndpoint: {
      lan: { ...identity, latencyMs: 5 },
      vpn: { ...identity, latencyMs: 30 },
      ssh: { ...identity, latencyMs: 50 },
    },
  });
  assert.equal(selected.endpoint.id, "lan");

  const failover = selectEndpoint({
    server,
    operation: "remote_read",
    healthByEndpoint: {
      lan: { ...identity, ok: false },
      vpn: { ...identity, latencyMs: 30 },
      ssh: { ...identity, latencyMs: 50 },
    },
  });
  assert.equal(failover.endpoint.id, "vpn");

  assert.throws(() => selectEndpoint({
    server,
    operation: "remote_write",
    healthByEndpoint: {
      lan: { ok: true, serverId: "wrong", workspaceId: "projects", latencyMs: 5 },
    },
  }), (error) => error?.code === "ENOENDPOINT");
}

async function testProjectProfile() {
  const { validateProjectProfile, resolveProjectPath } = await importModule("./packages/client-core/project-profile.js");
  const profile = validateProjectProfile("demo", {
    server: "debian-main",
    root: "/home/leon/projects/demo",
  });
  assert.equal(resolveProjectPath(profile, "src/index.js"), "/home/leon/projects/demo/src/index.js");
  assert.throws(() => resolveProjectPath(profile, "../../.ssh"), (error) => error?.code === "EPROJECTPATH");
}

async function testDaemonFileServices() {
  const { createFileReadService, createFileWriteService } = require("./packages/daemon-core/index.cjs");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentport-core-"));
  try {
    const reader = createFileReadService({ workspaceRoot: tempRoot });
    const writer = createFileWriteService({ workspaceRoot: tempRoot });

    const first = await writer.writeText("src/demo.txt", "line-1\nline-2\nline-3\n");
    assert.equal(first.atomic, true);
    assert.equal(first.verified, true);

    const range = await reader.readText("src/demo.txt", { startLine: 2, endLine: 3 });
    assert.equal(range.content, "line-2\nline-3");
    assert.equal(range.ranged, true);

    await assert.rejects(
      () => writer.writeText("src/demo.txt", "changed", { expectedEtag: "wrong" }),
      (error) => error?.code === "EWRITE_CONFLICT" && error?.statusCode === 409,
    );

    if (process.platform !== "win32") await fs.chmod(path.join(tempRoot, "src", "demo.txt"), 0o755);
    const second = await writer.writeText("src/demo.txt", "changed", { expectedEtag: first.etag });
    assert.notEqual(second.etag, first.etag);
    if (process.platform !== "win32") {
      const mode = (await fs.stat(path.join(tempRoot, "src", "demo.txt"))).mode & 0o777;
      assert.equal(mode, 0o755);
    }

    const manifest = await reader.manifest(".");
    assert.ok(manifest.entries.some((entry) => entry.path.replace(/\\/g, "/") === "src/demo.txt"));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function testSymlinkEscapeGuard() {
  const { createFileReadService } = require("./packages/daemon-core/index.cjs");
  const tempBase = await fs.mkdtemp(path.join(os.tmpdir(), "agentport-symlink-"));
  const workspace = path.join(tempBase, "workspace");
  const outside = path.join(tempBase, "outside");
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.txt"), "secret", "utf8");

  try {
    await fs.symlink(outside, path.join(workspace, "escape"), "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
      await fs.rm(tempBase, { recursive: true, force: true });
      return;
    }
    throw error;
  }

  try {
    const reader = createFileReadService({ workspaceRoot: workspace });
    await assert.rejects(
      () => reader.readText("escape/secret.txt"),
      (error) => error?.code === "EWORKSPACE" && error?.statusCode === 403,
    );
  } finally {
    await fs.rm(tempBase, { recursive: true, force: true });
  }
}

async function main() {
  const tests = [
    ["operation policy", testOperationPolicy],
    ["request context", testRequestContext],
    ["endpoint selection", testEndpointSelection],
    ["project profile", testProjectProfile],
    ["daemon file services", testDaemonFileServices],
    ["symlink escape guard", testSymlinkEscapeGuard],
  ];

  for (const [name, test] of tests) {
    await test();
    console.log(`PASS ${name}`);
  }
  console.log(`PASS ${tests.length}/${tests.length}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
