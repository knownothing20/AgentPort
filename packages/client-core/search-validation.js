export function validateDaemonSearch({ pattern, regex = false, caseSensitive = false }) {
  if (!regex) return;
  try {
    new RegExp(pattern, caseSensitive ? "" : "i");
  } catch {
    const error = new Error("Invalid regular expression for daemon search. Use JavaScript syntax; use caseSensitive:false (CLI: omit --case-sensitive) instead of (?i). For literal text, use regex:false (CLI: omit --regex).");
    error.code = "EREGEX";
    throw error;
  }
}
