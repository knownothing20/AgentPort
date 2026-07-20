export const RIPGREP_PROBE_PREFIX = "agentport-rg=";

export function parseSshDoctorOutput(stdout) {
  const lines = String(stdout || "").split(/\r?\n/);
  let probe = "";
  const identityLines = [];

  for (const line of lines) {
    if (line.startsWith(RIPGREP_PROBE_PREFIX)) {
      probe = line;
      continue;
    }
    identityLines.push(line);
  }

  return {
    ripgrepAvailable: probe === `${RIPGREP_PROBE_PREFIX}available`,
    data: identityLines.join("\n"),
  };
}