const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
let SshServer;
const { spawn, spawnSync } = require("node:child_process");
const ROOT = path.resolve(__dirname, "..");

function bashExecutable() {
  if (process.platform !== "win32") return spawnSync("bash", ["--version"]).status === 0 ? "bash" : null;
  const git = spawnSync("git", ["--exec-path"], { encoding: "utf8", windowsHide: true });
  if (git.status !== 0) return null;
  const install = path.resolve(git.stdout.trim(), "../../..");
  return ["bin", "usr/bin"].map((dir) => path.join(install, dir, "bash.exe")).find((file) => fs.existsSync(file)) || null;
}

function cli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "cli.js"), ...args], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const { SSHClient } = await import("../ssh-client.js");
  ({ Server: SshServer } = require("ssh2"));
  const { assertSshProtection, createSshTransport, sshTransportInternals } = await import("../packages/client-transport/ssh.js");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentport-ssh-stability-"));
  const prototype = SSHClient.prototype;
  const names = ["connect", "disconnect", "readFile", "writeFile", "mkdir", "rm", "exec", "resolveRemotePath"];
  const originals = Object.fromEntries(names.map((name) => [name, prototype[name]]));
  let connects = 0, writes = 0, reads = 0, removes = 0, execMode = "ok";
  prototype.connect = async () => { connects++; };
  prototype.disconnect = () => {};
  prototype.readFile = async () => { reads++; return "UTF-8 fixture " + String.fromCodePoint(0x4e2d); };
  prototype.writeFile = async () => { writes++; };
  prototype.mkdir = async () => {};
  prototype.rm = async () => { removes++; };
  prototype.resolveRemotePath = async (value) => String(value || "").replace(/^~(?=\/|$)/, "/fixture-home");
  prototype.exec = async () => {
    if (execMode === "unknown") throw Object.assign(new Error("synthetic stream loss"), { code: "EOUTCOME_UNKNOWN", outcome: "unknown" });
    if (execMode === "grep-error") return { code: 2, stdout: "", stderr: "permission denied" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const transport = createSshTransport({ host: "fixture.invalid", username: "fixture" });
  try {
    for (const [operation, args] of [
      ["remote_write", { path: "file", content: "x", expectedEtag: "tag" }],
      ["remote_write", { path: "file", content: "x", createOnly: true }],
      ["remote_write", { path: "file", content: "x", mode: 0 }],
      ["remote_read", { path: "file", startLine: 1 }],
      ["remote_read", { path: "file", endLine: 2 }],
      ["remote_read", { path: "file", maxBytes: 1 }],
      ["remote_grep", { pattern: "x", maxFileBytes: 1024 }],
      ["remote_batch", { operations: [{ type: "write", path: "file", content: "x" }, { type: "read", path: "file", maxBytes: 1 }] }],
    ]) await assert.rejects(() => transport.invoke(operation, args), { code: "EUNSUPPORTED" });
    assert.equal(connects, 0, "unsupported protections must fail before target access");
    assert.equal(writes, 0); assert.equal(reads, 0);
    assertSshProtection("remote_write", { createOnly: false, expectedEtag: "", mode: null });
    assert.equal((await transport.invoke("remote_read", { path: "file" })).success, true);
    assert.equal((await transport.invoke("remote_write", { path: "file", content: "fixture" })).success, true);
    execMode = "grep-error";
    await assert.rejects(() => transport.invoke("remote_grep", { pattern: "x" }), { code: "EGREP" });
    execMode = "unknown";
    const unknown = await transport.invoke("remote_script", { content: "fixture", interpreter: "bash" }).then(() => null, (error) => error);
    assert.equal(unknown.code, "EOUTCOME_UNKNOWN");
    assert.ok(unknown.recovery.remoteFile);
    assert.equal(removes, 0, "unknown script execution must preserve its payload");
    const beforeBatch = writes;
    const batch = await transport.invoke("remote_batch", { operations: [{ type: "bash", command: "fixture" }, { type: "write", path: "later", content: "never" }] });
    assert.equal(batch.code, "EOUTCOME_UNKNOWN");
    assert.equal(batch.results.length, 1);
    assert.equal(writes, beforeBatch, "unknown batch step must stop later side effects");
  } finally {
    for (const name of names) prototype[name] = originals[name];
  }

  const bash = bashExecutable();
  const tree = path.join(temp, "search ' $HOME");
  const outside = path.join(temp, "outside");
  fs.mkdirSync(tree); fs.mkdirSync(outside);
  try {
    if (bash) {
      const patterns = [String.fromCodePoint(0x4e2d, 0x6587) + " with spaces", `both ' and " quotes`, "$HOME", "`touch SHOULD_NOT_RUN`", "$(touch SHOULD_NOT_RUN)", "-leading-option"];
      const file = "sample $HOME.txt";
      fs.writeFileSync(path.join(tree, file), patterns.map((value) => `literal ${value}`).join("\n") + "\n");
      const execute = (args) => spawnSync(bash, ["-c", sshTransportInternals.grepCommand(args)], {
        cwd: tree, encoding: "utf8", windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: "1" },
      });
      for (const pattern of patterns) {
        const result = execute({ pattern, include: [file], excludeDirs: ["skip'$(touch SHOULD_NOT_RUN)"] });
        assert.equal(result.status, 0, result.stderr);
        assert.ok(result.stdout.includes(pattern), "pattern or include was expanded by the shell");
      }
      assert.equal(fs.existsSync(path.join(tree, "SHOULD_NOT_RUN")), false);
      fs.writeFileSync(path.join(outside, "secret.txt"), "OUTSIDE_FIXTURE_ONLY\n");
      fs.symlinkSync(outside, path.join(tree, "link"), process.platform === "win32" ? "junction" : "dir");
      const linked = execute({ pattern: "OUTSIDE_FIXTURE_ONLY" });
      assert.equal(linked.status, 0, linked.stderr); assert.equal(linked.stdout, "");
      const missing = execute({ pattern: "ABSENT_FIXTURE_ONLY" });
      assert.equal(missing.status, 0); assert.equal(missing.stdout, "");
      const invalid = execute({ pattern: "[", regex: true });
      assert.equal(invalid.status, 2); assert.ok(invalid.stderr);
      fs.writeFileSync(path.join(tree, "many.txt"), "many\n".repeat(2000));
      const limited = execute({ pattern: "many", maxResults: 2 });
      assert.equal(limited.status, 0, limited.stderr);
      assert.equal(limited.stdout.trim().split("\n").length, 2);
      const key = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
      const virtualRoot = spawnSync(bash, ["-c", "pwd"], { cwd: temp, encoding: "utf8", windowsHide: true }).stdout.trim();
      const { STATUS_CODE, flagsToString } = require("ssh2").utils.sftp;
      const attributes = (stat) => ({ mode: stat.mode, uid: 0, gid: 0, size: stat.size, atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000) });
      const localPath = (remotePath) => {
        const relative = path.posix.relative(virtualRoot, remotePath);
        if (relative.startsWith("../") || path.posix.isAbsolute(relative)) throw new Error("fixture path escape");
        return path.join(temp, relative);
      };
      const server = new SshServer({ hostKeys: [key] }, (client) => {
        client.on("authentication", (context) => context.accept());
        client.on("ready", () => client.on("session", (accept) => {
          const session = accept();
          session.on("sftp", (acceptSftp) => {
            const sftp = acceptSftp(), handles = new Map();
            let sequence = 0;
            const reply = (id, fn) => {
              try { fn(); }
              catch (error) { sftp.status(id, error.code === "ENOENT" ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE); }
            };
            sftp.on("OPEN", (id, name, flags) => reply(id, () => {
              const handle = Buffer.from(String(sequence++));
              handles.set(handle.toString(), fs.openSync(localPath(name), flagsToString(flags), 0o600));
              sftp.handle(id, handle);
            }));
            sftp.on("WRITE", (id, handle, offset, bytes) => reply(id, () => {
              fs.writeSync(handles.get(handle.toString()), bytes, 0, bytes.length, offset);
              sftp.status(id, STATUS_CODE.OK);
            }));
            sftp.on("READ", (id, handle, offset, length) => reply(id, () => {
              const bytes = Buffer.alloc(Math.min(length, 65536));
              const read = fs.readSync(handles.get(handle.toString()), bytes, 0, bytes.length, offset);
              if (read) sftp.data(id, bytes.subarray(0, read)); else sftp.status(id, STATUS_CODE.EOF);
            }));
            sftp.on("FSTAT", (id, handle) => reply(id, () => sftp.attrs(id, attributes(fs.fstatSync(handles.get(handle.toString()))))));
            for (const event of ["STAT", "LSTAT"]) sftp.on(event, (id, name) => reply(id, () => sftp.attrs(id, attributes(fs.statSync(localPath(name))))));
            sftp.on("CLOSE", (id, handle) => reply(id, () => {
              fs.closeSync(handles.get(handle.toString())); handles.delete(handle.toString()); sftp.status(id, STATUS_CODE.OK);
            }));
            sftp.on("close", () => { for (const descriptor of handles.values()) { try { fs.closeSync(descriptor); } catch {} } });
          });
          session.on("exec", (acceptExec, _reject, info) => {
            const channel = acceptExec();
            if (info.command === "fixture-uncertain-exec") {
              fs.appendFileSync(path.join(temp, "accepted-exec.count"), "once\n");
              channel.end(); return;
            }
            if (info.command === 'printf %s "$HOME"') {
              channel.exit(0); channel.end(virtualRoot); return;
            }
            const result = spawnSync(bash, ["-c", info.command], { cwd: tree, encoding: "utf8", windowsHide: true });
            if (result.stdout) channel.write(result.stdout);
            if (result.stderr) channel.stderr.write(result.stderr);
            channel.exit(result.status ?? 1); channel.end();
          });
        }));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const config = path.join(temp, "grep-connections.json");
        fs.writeFileSync(config, JSON.stringify({ connections: [{ name: "grep-fixture", type: "ssh", host: "127.0.0.1", port: server.address().port, username: "fixture", password: "fixture-password" }] }));
        const remoteCwd = spawnSync(bash, ["-c", "pwd"], { cwd: tree, encoding: "utf8", windowsHide: true }).stdout.trim();
        const env = { AGENTPORT_LEGACY_CONNECTIONS_PATH: config, AGENTPORT_SESSION_ID: "fixture-grep" };
        const common = ["--connection", "grep-fixture", "--route", "ssh", "--json", "--cwd", remoteCwd];
        const literal = await cli(["grep", "$(touch SHOULD_NOT_RUN)", "--include", file, ...common], env);
        assert.equal(literal.code, 0, literal.stderr || literal.stdout);
        assert.equal(JSON.parse(literal.stdout).matches.length, 1);
        assert.equal(fs.existsSync(path.join(tree, "SHOULD_NOT_RUN")), false);
        const rejected = await cli(["grep", "[", "--regex", ...common], env);
        assert.equal(rejected.code, 1);
        assert.equal(JSON.parse(rejected.stdout).code, "EGREP");
        const empty = await cli(["grep", "ABSENT_FIXTURE_ONLY", ...common], env);
        assert.equal(empty.code, 0); assert.deepEqual(JSON.parse(empty.stdout).matches, []);
        const actual = createSshTransport({ host: "127.0.0.1", port: server.address().port, username: "fixture", password: "fixture-password" });
        const v3Search = await actual.invoke("remote_grep", { pattern: "$HOME", cwd: remoteCwd, include: [file] });
        assert.equal(v3Search.matches.length, 1);
        const shortScript = await actual.invoke("remote_script", { content: "printf 'short-fixture'\n", interpreter: "bash" });
        assert.equal(shortScript.code, 0, shortScript.stderr);
        assert.equal(shortScript.stdout, "short-fixture");
        const utf8File = path.join(temp, "utf8-payload.txt");
        const utf8Content = "fixture " + String.fromCodePoint(0x4e2d, 0x6587) + "\n";
        fs.writeFileSync(utf8File, utf8Content);
        const safeWrite = await cli(["safe-write", `${virtualRoot}/uploaded.txt`, "--file", utf8File, "--connection", "grep-fixture", "--route", "ssh", "--json"], env);
        assert.equal(safeWrite.code, 0, safeWrite.stderr || safeWrite.stdout);
        assert.equal(JSON.parse(safeWrite.stdout).verified, true);
        assert.equal(fs.readFileSync(path.join(temp, "uploaded.txt"), "utf8"), utf8Content);
        const init = spawnSync("git", ["init", "-q"], { cwd: tree, encoding: "utf8", windowsHide: true });
        assert.equal(init.status, 0, init.stderr);
        const patchTarget = path.join(tree, "apply-target.txt");
        const patchFile = path.join(temp, "check-only.patch");
        fs.writeFileSync(patchTarget, "before\n");
        fs.writeFileSync(patchFile, "diff --git a/apply-target.txt b/apply-target.txt\n--- a/apply-target.txt\n+++ b/apply-target.txt\n@@ -1 +1 @@\n-before\n+after\n");
        const checked = await cli(["safe-apply", patchFile, "--check", "--remote-tmp-dir", virtualRoot, ...common], env);
        assert.equal(checked.code, 0, checked.stderr || checked.stdout);
        assert.equal(JSON.parse(checked.stdout).checked, true);
        assert.equal(JSON.parse(checked.stdout).applied, false);
        assert.equal(fs.readFileSync(patchTarget, "utf8"), "before\n");
        const partialBatch = path.join(temp, "partial-batch.json");
        fs.writeFileSync(partialBatch, JSON.stringify([
          { type: "write", path: `${virtualRoot}/before-unknown.txt`, content: "once" },
          { type: "bash", command: "fixture-uncertain-exec" },
          { type: "write", path: `${virtualRoot}/after-unknown.txt`, content: "never" },
        ]));
        const partial = await cli(["batch", partialBatch, "--connection", "grep-fixture", "--route", "ssh", "--json"], env);
        assert.equal(partial.code, 1);
        const partialData = JSON.parse(partial.stdout);
        assert.equal(partialData.code, "EOUTCOME_UNKNOWN");
        assert.equal(partialData.results.length, 2);
        assert.equal(fs.readFileSync(path.join(temp, "before-unknown.txt"), "utf8"), "once");
        assert.equal(fs.existsSync(path.join(temp, "after-unknown.txt")), false);
        assert.equal(fs.readFileSync(path.join(temp, "accepted-exec.count"), "utf8"), "once\n");
      } finally { await new Promise((resolve) => server.close(resolve)); }
      console.log(`PASS real ${process.platform === "win32" ? "Git Bash" : "Linux Bash"} grep literals, symlinks, errors, and truncation`);
    } else console.log("UNTESTED real shell grep: Bash not available");

    let connections = 0;
    const trap = net.createServer((socket) => { connections++; socket.destroy(); });
    await new Promise((resolve) => trap.listen(0, "127.0.0.1", resolve));
    try {
      const config = path.join(temp, "connections.json"), payload = path.join(temp, "payload.txt"), batchFile = path.join(temp, "batch.json");
      fs.writeFileSync(config, JSON.stringify({ connections: [{ name: "fixture", type: "ssh", host: "127.0.0.1", port: trap.address().port, username: "fixture", password: "fixture-password" }], default: "fixture" }));
      fs.writeFileSync(payload, "fixture\n");
      fs.writeFileSync(batchFile, JSON.stringify([{ type: "write", path: "/fixture/first", content: "x" }, { type: "read", path: "/fixture/second", maxBytes: 1 }]));
      const env = { AGENTPORT_LEGACY_CONNECTIONS_PATH: config, AGENTPORT_SESSION_ID: "fixture-protection" };
      const common = ["--connection", "fixture", "--route", "ssh", "--json"];
      for (const args of [
        ["write", "/fixture/file", "--file", payload, "--expected-etag", "tag"],
        ["safe-write", "/fixture/file", "--file", payload, "--create-only"],
        ["read", "/fixture/file", "--max-bytes", "1"],
        ["grep", "x", "--max-file-bytes", "1024"],
        ["batch", batchFile],
      ]) {
        const result = await cli([...args, ...common], env);
        assert.equal(result.code, 1, result.stdout || result.stderr);
        assert.equal(JSON.parse(result.stdout).code, "EUNSUPPORTED");
      }
      assert.equal(connections, 0, "legacy SSH guards must reject the entire request before connecting");
    } finally { await new Promise((resolve) => trap.close(resolve)); }
    console.log("PASS SSH protection preflight, unknown payload retention, and batch stop");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
