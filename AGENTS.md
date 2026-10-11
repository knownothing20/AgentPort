# AgentPort Repository Rules

Before committing or pushing, run `npm run privacy:check`.
Before a release, run `npm run privacy:release`. It checks working files,
the staged snapshot, the complete HEAD history, and all local release tags.

- Keep credentials, machine-specific connection data, and runtime configuration
  in ignored `local/` files or environment files only.
- Use documentation placeholders for hosts, users, paths, and tokens. Do not
  copy values from a live machine into source, tests, or examples.
- Do not bypass the repository hook with `--no-verify`.
- If the privacy check fails, remove or replace the value before committing.
- Use the owner's verified GitHub noreply identity, never a personal machine
  account name or personal email. Keep this setting repository-local.
- Enable the lightweight hooks with `git config core.hooksPath .githooks`.
  Pre-commit checks staged bytes and identity; pre-push checks outgoing history,
  including intermediate commits whose sensitive content was later removed.
  Annotated tags and Co-authored-by identities are also checked. Only remote
  commit IDs advertised for this push are treated as already published.
- Skill sync copies only Git-tracked source files. Review and stage intended new
  source files first; never force-add private configs, logs, or scratch scripts.

## Remote Search

- Prefer AgentPort `remote_grep` for remote content search. It uses bounded
  Node search through the daemon and bounded `grep` through SSH fallback.
- Before directly using `rg` on a remote host, run `command -v rg >/dev/null
  2>&1`. If it is unavailable, silently use bounded `grep` or `find` instead.
- Scope any recursive search to the requested project or workspace. Exclude
  `.git`, dependency directories, and build output; never search the whole disk.
