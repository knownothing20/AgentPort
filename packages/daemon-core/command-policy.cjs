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
  if (value instanceof Set) return new Set([...value].map((item) => String(item).trim()).filter(Boolean));
  if (Array.isArray(value)) return new Set(value.map((item) => String(item).trim()).filter(Boolean));
  if (typeof value === "string") return new Set(value.split(",").map((item) => item.trim()).filter(Boolean));
  return new Set(fallback);
}

function policyError(message, statusCode = 403, code = "ECOMMAND_POLICY") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function commandBase(command) {
  const first = String(command || "").trim().split(/\s+/)[0] || "";
  return path.basename(first.replace(/^['"]|['"]$/g, ""));
}

function createCommandPolicy({
  allowExec = true,
  allowedCommands = [],
  allowedInterpreters = DEFAULT_INTERPRETERS,
} = {}) {
  const execEnabled = boolValue(allowExec, true);
  const commandAllowlist = stringSet(allowedCommands);
  const interpreterAllowlist = stringSet(allowedInterpreters, DEFAULT_INTERPRETERS);

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
    const base = path.basename(raw.replace(/\\/g, "/"));
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
  stringSet,
};
