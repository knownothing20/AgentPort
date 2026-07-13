const DEFAULT_PARENT_WATCHDOG_MS = 1000;
const DEFAULT_FORCED_EXIT_DELAY_MS = 500;

function positiveDelay(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function startParentWatchdog(options = {}) {
  const parentPid = Number(options.parentPid ?? process.ppid);
  const disabled = options.disabled ?? process.env.AGENTPORT_DISABLE_PARENT_WATCHDOG === "1";
  if (disabled || !Number.isInteger(parentPid) || parentPid <= 0) return () => {};

  const intervalMs = positiveDelay(
    options.intervalMs ?? process.env.AGENTPORT_PARENT_WATCHDOG_MS,
    DEFAULT_PARENT_WATCHDOG_MS,
  );
  const probe = options.probe || ((pid) => process.kill(pid, 0));
  const onParentExit = options.onParentExit || (() => process.exit(143));
  const timer = setInterval(() => {
    try {
      probe(parentPid);
    } catch (error) {
      if (error?.code !== "EPERM") onParentExit(parentPid, error);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function scheduleForcedExit(options = {}) {
  const delayMs = positiveDelay(options.delayMs, DEFAULT_FORCED_EXIT_DELAY_MS);
  const exitCode = Number.isInteger(options.exitCode) ? options.exitCode : (process.exitCode ?? 0);
  const exit = options.exit || process.exit;
  const timer = setTimeout(() => exit(exitCode), delayMs);
  timer.unref?.();
  return timer;
}
