# AgentPort Repository Rules

Before committing or pushing, run `npm run privacy:check`.

- Keep credentials, machine-specific connection data, and runtime configuration
  in ignored `local/` files or environment files only.
- Use documentation placeholders for hosts, users, paths, and tokens. Do not
  copy values from a live machine into source, tests, or examples.
- Do not bypass the repository hook with `--no-verify`.
- If the privacy check fails, remove or replace the value before committing.
