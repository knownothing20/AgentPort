export function createLazySshTransport(endpoint, options = {}) {
  let transportPromise = null;
  async function transport() {
    if (!transportPromise) {
      transportPromise = import("./ssh.js").then(({ createSshTransport }) => createSshTransport(endpoint, options));
    }
    return transportPromise;
  }
  return Object.freeze({
    endpoint,
    health: async (...args) => (await transport()).health(...args),
    invoke: async (...args) => (await transport()).invoke(...args),
  });
}
