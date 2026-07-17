function positiveInt(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function queueError(stats) {
  const error = new Error("Too many concurrent execution operations");
  error.code = "EEXEC_QUEUE";
  error.statusCode = 429;
  error.details = stats;
  return error;
}

function createExecutionQueue({ maxConcurrency = 2, queueTimeoutMs = 15_000 } = {}) {
  let max = positiveInt(maxConcurrency, 2, 1, 128);
  let timeout = positiveInt(queueTimeoutMs, 15_000, 0, 10 * 60_000);
  let running = 0;
  const waiters = [];

  function stats() {
    return Object.freeze({ running, max, queued: waiters.length, queueTimeoutMs: timeout });
  }

  function dispatch() {
    while (running < max && waiters.length > 0) {
      const waiter = waiters.shift();
      if (!waiter || waiter.done) continue;
      waiter.done = true;
      if (waiter.timer) clearTimeout(waiter.timer);
      running += 1;
      waiter.resolve(releaseFactory());
    }
  }

  function releaseFactory() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      running = Math.max(0, running - 1);
      dispatch();
    };
  }

  async function acquire(options = {}) {
    if (running < max) {
      running += 1;
      return releaseFactory();
    }
    const waitTimeout = positiveInt(options.timeoutMs, timeout, 0, 10 * 60_000);
    if (waitTimeout <= 0) throw queueError(stats());
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, done: false, timer: null };
      waiter.timer = setTimeout(() => {
        if (waiter.done) return;
        waiter.done = true;
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(queueError(stats()));
      }, waitTimeout);
      waiters.push(waiter);
    });
  }

  async function run(fn, options = {}) {
    const release = await acquire(options);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  function update(next = {}) {
    max = positiveInt(next.maxConcurrency, max, 1, 128);
    timeout = positiveInt(next.queueTimeoutMs, timeout, 0, 10 * 60_000);
    dispatch();
    return stats();
  }

  return Object.freeze({ acquire, run, stats, update });
}

module.exports = { createExecutionQueue, positiveInt, queueError };
