const path = require("node:path");

const DEFAULT_INTERPRETERS = Object.freeze([
  "bash", "sh", "dash", "zsh",
  "python3", "python", "node", "nodejs",
  "perl", "ruby", "php", "powershell", "pwsh", "cmd",
]);

const SHELL_METACHARS_RE = /[;&|`$><\n]|\$\(|\$\{/;

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
}

function stringSet(value, fallback = []) {
  let values = [];
  if (value instanceof Set) values = [...value];
  else if (Array.isArray(value)) values = value;
  else if (typeof value === "string") values = value.split(",");
  else values = fallback;
  const normalized = values.map((item) => String(item).trim()).filter(Boolean);
  return new Set(normalized.length > 0 ? normalized : fallback);
}

function policyError(message, statusCode = 403, code = "ECOMMAND_POLICY") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizeBinaryName(value) {
  return path.basename(String(value || "").replace(/\\/g, "/")).replace(/\.exe$/i, "");
}

function commandBase(command) {
  const first = String(command || "").trim().split(/\s+/)[0] || "";
  return normalizeBinaryName(first.replace(/^['"]|['"]$/g, ""));
}

function createCommandPolicy({
  allowExec = true,
  allowedCommands = [],
  allowedInterpreters = DEFAULT_INTERPRETERS,
} = {}) {
  const execEnabled = boolValue(allowExec, true);
  const commandAllowlist = new Set([...stringSet(allowedCommands)].map(normalizeBinaryName));
  const interpreterAllowlist = new Set(
    [...stringSet(allowedInterpreters, DEFAULT_INTERPRETERS)].map(normalizeBinaryName),
  );

  function validateCommand(command) {
    if (typeof command !== "string" || !command.trim()) {
      throw policyError("command is required", 400, "EINVAL");
    }
    if (!execEnabled) {
      throw policyError("Command execution is disabled. Set ALLOW_BASH_EXEC=true to enable.");
    }
    if (commandAllowlist.size > 0) {
      if (SHELL_METACHARS_RE.test(command)) {
        throw policyError(
          "Command rejected: shell metacharacters are not allowed when ALLOWED_COMMANDS is configured. Use the script endpoint for reviewed multiline scripts.",
        );
      }
      const base = commandBase(command);
      if (!commandAllowlist.has(base)) {
        throw policyError(`Command not allowed: ${base}. Allowed: ${[...commandAllowlist].join(", ")}`);
      }
    }
    return { command: command.trim(), base: commandBase(command) };
  }

  function validateInterpreter(interpreter) {
    const raw = String(interpreter || "bash").trim();
    const base = normalizeBinaryName(raw);
    if (!interpreterAllowlist.has(base)) {
      throw policyError(
        `Interpreter not allowed: ${raw}. Allowed: ${[...interpreterAllowlist].join(", ")}`,
        400,
        "EINTERPRETER",
      );
    }
    return { interpreter: raw, base };
  }

  return Object.freeze({
    allowExec: execEnabled,
    allowedCommands: Object.freeze([...commandAllowlist]),
    allowedInterpreters: Object.freeze([...interpreterAllowlist]),
    validateCommand,
    validateInterpreter,
  });
}

module.exports = {
  DEFAULT_INTERPRETERS,
  SHELL_METACHARS_RE,
  boolValue,
  commandBase,
  createCommandPolicy,
  normalizeBinaryName,
  stringSet,
};
