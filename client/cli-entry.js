#!/usr/bin/env node

const argv = process.argv.slice(2);
const first = String(argv[0] || "help").toLowerCase();
const mode = String(process.env.AGENTPORT_CLIENT_MODE || "auto").trim().toLowerCase();
const modular = new Set(["server", "project", "v3"]);
if ((mode === "v3" || mode === "modular") && first === "job") modular.add("job");

if (modular.has(first)) {
  const { main } = await import("./modular-cli.js");
  await main(argv).catch((error) => {
    if (argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, code: error.code || null, details: error.details || null }, null, 2)}\n`);
    } else {
      process.stderr.write(`AgentPort: ${error.message}\n`);
    }
    process.exitCode = 1;
  });
} else {
  await import("../cli.js");
}
