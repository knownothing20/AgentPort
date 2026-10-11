const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { isForbiddenPath, scanContent, runPrivacyCheck, parsePrePushInput } = require("../scripts/check-privacy.cjs");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentport-privacy-"));
const privateAddress = ["10", "87", "65", "43"].join(".");
const privateUser = ["le", "on"].join("");
const safeIdentity = {
  GIT_AUTHOR_NAME: "Synthetic Public Author",
  GIT_AUTHOR_EMAIL: "12345+synthetic-test@users.noreply.github.com",
  GIT_COMMITTER_NAME: "Synthetic Public Committer",
  GIT_COMMITTER_EMAIL: "12345+synthetic-test@users.noreply.github.com",
};

function git(repo, args, env = {}) {
  const result = childProcess.spawnSync("git", args, {
    cwd: repo,
    env: { ...process.env, ...env },
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error("temporary Git fixture command failed");
  return result.stdout.toString("utf8").trim();
}

function makeRepo(name) {
  const repo = path.join(tempRoot, name);
  fs.mkdirSync(repo);
  git(repo, ["init", "--quiet"]);
  return repo;
}

function write(repo, file, content) {
  const fullPath = path.join(repo, file);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function commit(repo, message, env = safeIdentity) {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--quiet", "-m", message], env);
  return git(repo, ["rev-parse", "HEAD"]);
}

function run(repo, options) {
  const output = { stdout: "", stderr: "" };
  const sink = (key) => ({ write(value) { output[key] += String(value); } });
  output.code = runPrivacyCheck({
    root: repo,
    stdout: sink("stdout"),
    stderr: sink("stderr"),
    ...options,
  });
  return output;
}

function assertNoSecretOutput(result, secret) {
  if (`${result.stdout}${result.stderr}`.includes(secret)) {
    throw new Error("privacy check echoed scanned content");
  }
}

function expectRule(result, rule, secret) {
  assert.strictEqual(result.code, 1, "expected privacy check failure");
  assert.ok(result.stderr.includes(rule), "expected privacy rule was not reported");
  assertNoSecretOutput(result, secret);
}

function prePush(repo, localRef, localOid, remoteRef, remoteOid) {
  const input = Buffer.from(`${localRef} ${localOid} ${remoteRef} ${remoteOid}\n`, "ascii");
  return run(repo, { mode: "pre-push", remoteName: "origin", input });
}

function utf16be(value) {
  const littleEndian = Buffer.from(value, "utf16le");
  const bigEndian = Buffer.alloc(littleEndian.length + 2);
  bigEndian[0] = 0xfe;
  bigEndian[1] = 0xff;
  for (let index = 0; index < littleEndian.length; index += 2) {
    bigEndian[index + 2] = littleEndian[index + 1];
    bigEndian[index + 3] = littleEndian[index];
  }
  return bigEndian;
}

try {
  const pathCases = [
    [".env", true],
    ["config/.env.production.local", true],
    [".envrc", true],
    [".env.example", false],
    ["config/.env.local.template", false],
    [".envrc.sample", false],
    ["id_ed25519", true],
    ["id_rsa.pub", false],
    ["keys/server.key.enc", true],
    ["keys/private.pkcs8", true],
    ["docs/example.pem", true],
    ["connections.json", true],
    ["docs/connections.json", false],
    ["local/runtime/state.json", true],
    ["local/logs/agentport.log", true],
    ["local/backups/state.json", true],
    ["local/state.db", true],
  ];
  for (const [file, expected] of pathCases) {
    assert.strictEqual(isForbiddenPath(file), expected, "path guard mismatch");
  }

  assert.deepStrictEqual(scanContent(Buffer.from(`Server: ${privateAddress}`)), ["private-network-address"]);
  assert.deepStrictEqual(scanContent(Buffer.from(["Path: /home/", privateUser, "/project"].join(""))), [
    "machine-specific-linux-home",
  ]);
  assert.deepStrictEqual(
    scanContent(Buffer.from(["-----BEGIN ENCRYPTED", " PRIVATE KEY-----"].join(""))),
    ["private-key-header"],
  );
  assert.deepStrictEqual(scanContent(Buffer.from(`AWS: AKIA${"A".repeat(16)}`)), ["aws-access-key-id"]);
  const agentportToken = ["agentport", "cli.test", "m5abc123", "abcdef0123456789".repeat(2)].join("-");
  assert.deepStrictEqual(scanContent(Buffer.from(agentportToken)), ["agentport-token"]);
  assert.deepStrictEqual(scanContent(Buffer.from(["agentport", "example", "timestamp", "short"].join("-"))), []);
  assert.deepStrictEqual(scanContent(Buffer.from("Example: 192.0.2.10 and /home/YOUR_USER; sk-example-token")), []);
  assert.deepStrictEqual(scanContent(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(privateAddress, "utf16le")])), [
    "private-network-address",
  ]);
  assert.deepStrictEqual(scanContent(utf16be(privateAddress)), ["private-network-address"]);
  for (const file of ["../scripts/check-privacy.cjs", "test-privacy-check.cjs"]) {
    assert.deepStrictEqual(
      scanContent(fs.readFileSync(path.join(__dirname, file))),
      [],
      "guard implementation and synthetic fixtures should not flag themselves",
    );
  }

  const workingRepo = makeRepo("working-tree");
  write(workingRepo, ".gitignore", "ignored.txt\n");
  write(workingRepo, "tracked.txt", "safe\n");
  commit(workingRepo, "baseline");
  write(workingRepo, "visible.txt", privateAddress);
  write(workingRepo, "ignored.txt", privateAddress);
  expectRule(run(workingRepo, { mode: "working" }), "private-network-address", privateAddress);
  fs.writeFileSync(path.join(workingRepo, "visible.txt"), "safe\n");
  assert.strictEqual(run(workingRepo, { mode: "working" }).code, 0, "ignored files must stay outside the default scan");

  const stagedRepo = makeRepo("staged-index");
  write(stagedRepo, "tracked.txt", "safe\n");
  commit(stagedRepo, "baseline");
  write(stagedRepo, "staged.txt", privateAddress);
  git(stagedRepo, ["add", "staged.txt"]);
  write(stagedRepo, "staged.txt", "safe working tree\n");
  assert.strictEqual(run(stagedRepo, { mode: "working" }).code, 0, "working-tree view should be clean");
  expectRule(run(stagedRepo, { mode: "staged" }), "private-network-address", privateAddress);
  write(stagedRepo, "deleted.txt", privateAddress);
  git(stagedRepo, ["add", "deleted.txt"]);
  fs.unlinkSync(path.join(stagedRepo, "deleted.txt"));
  expectRule(run(stagedRepo, { mode: "staged" }), "private-network-address", privateAddress);
  expectRule(run(stagedRepo, { mode: "release", env: safeIdentity }), "private-network-address", privateAddress);

  const batchRepo = makeRepo("batch-content");
  const unusualFilename = process.platform === "win32" ? `space and ${String.fromCodePoint(0x4e2d)}.txt` : "space and\ttab\nnewline.txt";
  write(batchRepo, "binary.dat", Buffer.from([0, 10, 13, 255, 10, 0]));
  for (let index = 0; index < 20; index++) write(batchRepo, `duplicate ${index}.txt`, "safe shared blob\n");
  write(batchRepo, unusualFilename, privateAddress);
  git(batchRepo, ["add", "-A"]);
  expectRule(run(batchRepo, { mode: "staged" }), "private-network-address", privateAddress);
  write(batchRepo, unusualFilename, "safe\n");
  git(batchRepo, ["add", "-A"]);
  assert.strictEqual(run(batchRepo, { mode: "staged" }).code, 0, "batch parser must preserve binary sizes and unusual filenames");
  const secretFilename = ["ghp", "synthetic".repeat(4)].join("_") + ".txt";
  write(batchRepo, secretFilename, privateAddress);
  const filenameFinding = run(batchRepo, { mode: "working" });
  expectRule(filenameFinding, "common-api-token-format", secretFilename);
  assert.ok(filenameFinding.stderr.includes("[redacted filename]"));

  const identityRepo = makeRepo("identity");
  write(identityRepo, "tracked.txt", "safe\n");
  git(identityRepo, ["add", "tracked.txt"]);
  assert.strictEqual(run(identityRepo, { mode: "staged", checkIdentity: true, env: safeIdentity }).code, 0);
  const githubIdentity = {
    GIT_AUTHOR_NAME: "GitHub",
    GIT_AUTHOR_EMAIL: "noreply@github.com",
    GIT_COMMITTER_NAME: "GitHub",
    GIT_COMMITTER_EMAIL: "web-flow@github.com",
  };
  assert.strictEqual(
    run(identityRepo, { mode: "staged", checkIdentity: true, env: githubIdentity }).code,
    0,
    "official GitHub service identities should be allowed",
  );
  const spoofedGithubIdentity = { ...githubIdentity, GIT_AUTHOR_NAME: "Synthetic User" };
  assert.ok(
    run(identityRepo, { mode: "staged", checkIdentity: true, env: spoofedGithubIdentity }).stderr.includes(
      "non-public-commit-email",
    ),
    "GitHub service email should require the official identity name",
  );
  const privateNameIdentity = {
    ...safeIdentity,
    GIT_AUTHOR_NAME: privateUser,
  };
  expectRule(
    run(identityRepo, { mode: "staged", checkIdentity: true, env: privateNameIdentity }),
    "private-author-name",
    privateUser,
  );

  const pushRepo = makeRepo("push-history");
  write(pushRepo, "base.txt", "safe\n");
  const base = commit(pushRepo, "baseline");
  git(pushRepo, ["update-ref", "refs/remotes/origin/main", base]);
  write(pushRepo, "github-merge.txt", "safe automatic merge metadata\n");
  const githubMerge = commit(pushRepo, "GitHub merge", githubIdentity);
  assert.strictEqual(
    prePush(pushRepo, "refs/heads/main", githubMerge, "refs/heads/main", base).code,
    0,
    "official GitHub merge identities should pass outgoing metadata checks",
  );
  git(pushRepo, ["update-ref", "refs/remotes/origin/main", githubMerge]);
  write(pushRepo, "identity-check.txt", "safe\n");
  const personalEmail = "author@example.invalid";
  const personalAuthor = {
    ...safeIdentity,
    GIT_AUTHOR_NAME: "Synthetic Personal Author",
    GIT_AUTHOR_EMAIL: personalEmail,
  };
  const personalAuthorCommit = commit(pushRepo, "synthetic personal author", personalAuthor);
  expectRule(
    prePush(pushRepo, "refs/heads/main", personalAuthorCommit, "refs/heads/main", githubMerge),
    "non-public-commit-email",
    personalEmail,
  );
  git(pushRepo, ["update-ref", "refs/remotes/origin/main", personalAuthorCommit]);
  write(pushRepo, "history.txt", privateAddress);
  const leakedCommit = commit(pushRepo, "introduce content");
  write(pushRepo, "history.txt", "corrected\n");
  const correctedHead = commit(pushRepo, "correct content");
  git(pushRepo, ["update-ref", "refs/remotes/origin/main", correctedHead]);
  expectRule(
    prePush(pushRepo, "refs/heads/main", correctedHead, "refs/heads/main", personalAuthorCommit),
    "private-network-address",
    privateAddress,
  );
  git(pushRepo, ["update-ref", "refs/remotes/origin/main", leakedCommit]);
  assert.strictEqual(
    prePush(pushRepo, "refs/heads/main", correctedHead, "refs/heads/main", leakedCommit).code,
    0,
    "published history should not block a routine update",
  );

  write(pushRepo, "feature.txt", "safe feature\n");
  const featureHead = commit(pushRepo, "new branch safe content");
  const zero = "0".repeat(base.length);
  expectRule(
    prePush(pushRepo, "refs/heads/feature", featureHead, "refs/heads/feature", zero),
    "private-network-address",
    privateAddress,
  );
  write(pushRepo, "feature-leak.txt", privateAddress);
  const featureLeak = commit(pushRepo, "new branch leak");
  expectRule(
    prePush(pushRepo, "refs/heads/feature", featureLeak, "refs/heads/feature", zero),
    "private-network-address",
    privateAddress,
  );
  assert.strictEqual(
    prePush(pushRepo, "(delete)", zero, "refs/heads/feature", featureLeak).code,
    0,
    "deletion-only push should not scan old commits as outgoing",
  );

  write(pushRepo, "message-only.txt", "safe\n");
  const messageLeak = commit(pushRepo, `message ${privateAddress}`);
  expectRule(
    prePush(pushRepo, "refs/heads/main", messageLeak, "refs/heads/main", featureLeak),
    "private-network-address",
    privateAddress,
  );

  write(pushRepo, "coauthor.txt", "safe\n");
  const coauthorEmail = "coauthor@example.invalid";
  const coauthorLeak = commit(pushRepo, `collaboration\n\nCo-authored-by: Synthetic Contributor <${coauthorEmail}>`);
  expectRule(
    prePush(pushRepo, "HEAD", coauthorLeak, "refs/heads/main", messageLeak),
    "non-public-commit-email",
    coauthorEmail,
  );
  write(pushRepo, "coauthor.txt", "updated safe content\n");
  const goodCoauthor = commit(pushRepo, "allow public contributor\n\nCo-authored-by: Synthetic Contributor <12345+synthetic-test@users.noreply.github.com>");
  assert.strictEqual(prePush(pushRepo, "HEAD", goodCoauthor, "refs/heads/main", coauthorLeak).code, 0);

  const releaseRepo = makeRepo("release");
  write(releaseRepo, "source.txt", "safe\n");
  const releaseBase = commit(releaseRepo, "baseline");
  assert.strictEqual(prePush(releaseRepo, "HEAD", releaseBase, "refs/heads/new", zero).code, 0, "clean new branches and ref expressions must pass");
  assert.strictEqual(parsePrePushInput(`HEAD ${releaseBase} refs/heads/main ${zero}\n`)[0].localRef, "HEAD");
  assert.strictEqual(run(releaseRepo, { mode: "release", env: safeIdentity }).code, 0);
  git(releaseRepo, ["tag", "-a", "safe-release", "-m", "safe release notes"], safeIdentity);
  const safeTag = git(releaseRepo, ["rev-parse", "refs/tags/safe-release"]);
  assert.strictEqual(prePush(releaseRepo, "refs/tags/safe-release", safeTag, "refs/tags/safe-release", zero).code, 0);
  git(releaseRepo, ["tag", "-a", "private-release", "-m", `release notes ${privateAddress}`], safeIdentity);
  const privateTag = git(releaseRepo, ["rev-parse", "refs/tags/private-release"]);
  expectRule(prePush(releaseRepo, privateTag, privateTag, "refs/tags/private-release", zero), "private-network-address", privateAddress);
  expectRule(run(releaseRepo, { mode: "release", env: safeIdentity }), "private-network-address", privateAddress);

  const tagHistoryRepo = makeRepo("tag-history-release");
  write(tagHistoryRepo, "source.txt", "safe baseline\n");
  const tagHistoryBase = commit(tagHistoryRepo, "baseline");
  write(tagHistoryRepo, "source.txt", privateAddress);
  commit(tagHistoryRepo, "tagged private content");
  git(tagHistoryRepo, ["tag", "-a", "inner", "-m", "safe tag notes"], safeIdentity);
  git(tagHistoryRepo, ["tag", "-a", "outer", "inner", "-m", "nested safe tag notes"], safeIdentity);
  git(tagHistoryRepo, ["tag", "-d", "inner"]);
  git(tagHistoryRepo, ["checkout", "--detach", tagHistoryBase]);
  assert.strictEqual(run(tagHistoryRepo, { mode: "working" }).code, 0);
  expectRule(run(tagHistoryRepo, { mode: "release", env: safeIdentity }), "private-network-address", privateAddress);

  const replacedRepo = makeRepo("replace-ref");
  write(replacedRepo, "source.txt", "safe baseline\n");
  const replacementBase = commit(replacedRepo, "baseline");
  write(replacedRepo, "source.txt", privateAddress);
  const replacedCommit = commit(replacedRepo, "original private content");
  write(replacedRepo, "source.txt", "corrected\n");
  const replacementHead = commit(replacedRepo, "correct latest content");
  git(replacedRepo, ["replace", replacedCommit, replacementBase]);
  expectRule(prePush(replacedRepo, "HEAD", replacementHead, "refs/heads/main", replacementBase), "private-network-address", privateAddress);
  git(releaseRepo, ["tag", "-a", "private-tagger", "-m", "safe release notes"], { ...safeIdentity, GIT_COMMITTER_EMAIL: coauthorEmail });
  const privateTagger = git(releaseRepo, ["rev-parse", "refs/tags/private-tagger"]);
  expectRule(prePush(releaseRepo, "refs/tags/private-tagger", privateTagger, "refs/tags/private-tagger", zero), "non-public-commit-email", coauthorEmail);
  write(releaseRepo, "source.txt", privateAddress);
  commit(releaseRepo, "intermediate private content");
  write(releaseRepo, "source.txt", "safe after correction\n");
  commit(releaseRepo, "correct content");
  assert.strictEqual(run(releaseRepo, { mode: "working" }).code, 0);
  expectRule(run(releaseRepo, { mode: "release", env: safeIdentity }), "private-network-address", privateAddress);

  assert.strictEqual(
    run(pushRepo, { mode: "pre-push", input: Buffer.alloc(0) }).code,
    0,
    "manual pre-push invocation without stdin should pass as an empty update set",
  );

  const hooksDir = path.resolve(__dirname, "../.githooks");
  assert.ok(fs.readFileSync(path.join(hooksDir, "pre-commit"), "utf8").includes("--staged --check-identity"));
  assert.ok(fs.readFileSync(path.join(hooksDir, "pre-push"), "utf8").includes("--pre-push"));

  console.log("PASS privacy checks, release history, tags, coauthors, and batched Git reads");
} finally {
  const resolvedTempRoot = path.resolve(tempRoot);
  if (!resolvedTempRoot.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    throw new Error("temporary test cleanup path escaped the system temp directory");
  }
  fs.rmSync(resolvedTempRoot, { recursive: true, force: true });
}
