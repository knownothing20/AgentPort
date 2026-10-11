const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

async function testLegacyApplyResults() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentport-apply-results-"));
  let result, submissions = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/healthz") return res.end(JSON.stringify({ ok: true, workspaceRoot: "/fixture" }));
      submissions++;
      res.end(JSON.stringify(result));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = path.join(root, "connections.json"), patch = path.join(root, "check.patch");
  fs.writeFileSync(config, JSON.stringify({ connections: [{ name: "fixture", type: "daemon", url: `http://127.0.0.1:${server.address().port}` }] }));
  fs.writeFileSync(patch, "fixture-only patch\n");
  try {
    for (const [response, expectedSuccess] of [[{ ok: true, code: 7 }, false], [{ success: false, code: 0 }, false], [{ ok: true, code: 0, stdout: "" }, true]]) {
      result = response;
      const observed = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.resolve(__dirname, "../cli.js"), "safe-apply", patch, "--check", "--cwd", "/fixture", "--connection", "fixture", "--route", "daemon", "--json"], {
          windowsHide: true, env: { ...process.env, AGENTPORT_LEGACY_CONNECTIONS_PATH: config, AGENTPORT_SESSION_ID: "apply-results-fixture", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "", NO_PROXY: "127.0.0.1,localhost" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "", stderr = "";
        child.stdout.on("data", (data) => { stdout += data; });
        child.stderr.on("data", (data) => { stderr += data; });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
      });
      const payload = JSON.parse(observed.stdout);
      assert.equal(observed.code === 0, expectedSuccess, observed.stderr || observed.stdout);
      assert.equal(payload.ok, expectedSuccess);
      assert.deepEqual(payload.result, response);
    }
    assert.equal(submissions, 3, "safe-apply must not replay failed commands");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const { executionExitCode } = await import("../packages/shared/execution-result.js");

  assert.equal(executionExitCode({ code: 7, stdout: "partial", stderr: "failed" }), 7);
  assert.equal(executionExitCode({ code: "ETIMEDOUT", error: "Command timed out" }), 1);
  assert.equal(executionExitCode({ status: "timeout", timedOut: true }), 1);
  assert.equal(executionExitCode({ data: { results: [{ type: "bash", status: 200, code: 9, success: false }] } }), 9);
  assert.equal(executionExitCode({ data: { job: { status: "error", exitCode: 7 } } }), 7);
  assert.equal(executionExitCode({ data: { job: { status: "running", exitCode: null } }, success: true }), 0);
  assert.equal(executionExitCode({ success: true, code: 0, stdout: "", stderr: "" }), 0);
  assert.equal(executionExitCode({ code: 300 }), 1);
  await testLegacyApplyResults();

  console.log("PASS shared execution result classification");
}

main().catch((error) => { console.error(error.stack || error); process.exit(1); });
