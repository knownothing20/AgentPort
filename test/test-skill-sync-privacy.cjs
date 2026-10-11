const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentport-sync-privacy-"));
const source = path.join(temp, "source");
const target = path.join(temp, "target");
function write(name, content) {
  const file = path.join(source, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function git(...args) {
  const result = spawnSync("git", args, { cwd: source, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}
function sync(...args) {
  return spawnSync(process.execPath, [path.join(source, "sync.cjs"), "--skills", "--target", target, ...args], {
    cwd: source, encoding: "utf8", windowsHide: true,
  });
}
try {
  write("sync.cjs", fs.readFileSync(path.join(root, "sync.cjs")));
  write("package.json", JSON.stringify({ name: "fixture", version: "1.0.0" }));
  write("index.js", "// tracked source\n");
  write("local/connections.json.example", "{}\n");
  write(".gitignore", "*.log\n.env\nlocal/connections.json\nnode_modules/\n");
  git("init", "-q");
  git("add", ".");
  write("trace.log", "ignored diagnostic payload");
  write(".env", "PRIVATE_TEST_VALUE=fixture-only");
  write("scratch.txt", "untracked payload");
  write("local/connections.json", '{"authToken":"source-private-fixture"}');
  write("server/node_modules/dependency/index.js", "dependency fixture");
  fs.mkdirSync(path.join(target, "local"), { recursive: true });
  const privateTarget = path.join(target, "local/connections.json");
  fs.writeFileSync(privateTarget, '{"authToken":"target-private-fixture"}');
  const result = sync();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.readFileSync(privateTarget, "utf8"), '{"authToken":"target-private-fixture"}');
  assert.ok(fs.existsSync(path.join(target, "index.js")));
  assert.ok(fs.existsSync(path.join(target, "local/connections.json.example")));
  for (const excluded of [".git", ".env", "trace.log", "scratch.txt", "server/node_modules"]) {
    assert.equal(fs.existsSync(path.join(target, excluded)), false, `${excluded} was copied`);
  }
  assert.equal(sync("--check").status, 0);
  const outside = path.join(temp, "outside");
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(source, "client"));
  write("client/entry.js", "// client fixture\n");
  git("add", "client/entry.js");
  fs.symlinkSync(outside, path.join(target, "client"), process.platform === "win32" ? "junction" : "dir");
  assert.notEqual(sync().status, 0, "target junction must be rejected");
  assert.equal(fs.existsSync(path.join(outside, "entry.js")), false);
  console.log("PASS Skill sync excludes ignored/untracked files and preserves private target config");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
