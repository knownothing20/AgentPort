function createKeyLock() {
  const tails = new Map();

  async function withLock(key, fn) {
    if (typeof fn !== "function") throw new TypeError("fn must be a function");
    const previous = tails.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const current = previous.then(() => gate);
    tails.set(key, current);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (tails.get(key) === current) tails.delete(key);
    }
  }

  return {
    withLock,
    size: () => tails.size,
  };
}

module.exports = { createKeyLock };
