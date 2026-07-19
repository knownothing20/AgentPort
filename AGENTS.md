# AgentPort Repository Rules

Before committing or pushing, run `npm run privacy:check`.

- Keep credentials, machine-specific connection data, and runtime configuration
  in ignored `local/` files or environment files only.
- Use documentation placeholders for hosts, users, paths, and tokens. Do not
  copy values from a live machine into source, tests, or examples.
- Do not bypass the repository hook with `--no-verify`.
- If the privacy check fails, remove or replace the value before committing.

## Remote Search

- Prefer AgentPort `remote_grep` for remote content search. It uses bounded
  Node search through the daemon and bounded `grep` through SSH fallback.
- Before directly using `rg` on a remote host, run `command -v rg >/dev/null
  2>&1`. If it is unavailable, silently use bounded `grep` or `find` instead.
- Scope any recursive search to the requested project or workspace. Exclude
  `.git`, dependency directories, and build output; never search the whole disk.
