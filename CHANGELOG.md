# Changelog

## [3.1.0] - 2026-07-18 | Dual-end daemon, durable Jobs, and Worktree Sessions

### Added
- Added the modular V3 file, execution, persistent Job, connection-registry, and Git Worktree Session architecture while retaining compatibility entrypoints.
- Added owner/admin authorization boundaries for Session and Job resources, client-scoped idempotency, and adversarial two-client tests.
- Added bounded line-range reads with explicit output and scan limits, metadata cache ETags, and no unbounded full-file hashing.
- Added owner-aware project locks that cannot expire while the owning operation is alive.

### Fixed
- Fixed zero-delay Job completion, Worker readiness diagnostics, process-tree cancellation, Windows 8.3 path handling, and temporary-directory cleanup races.
- Fixed Session subprocess output races by waiting for stdout/stderr close before returning Git results.
- Fixed server lockfile reproducibility and patched dependency audit findings.
- Unified credential and command-response redaction across CLI, MCP, Runtime, Job, Session, and public daemon responses.

### Validated
- Passed Windows and Ubuntu Node.js 20/22 CI, clean server installation, moderate-level audits, repeated Windows Job tests, and physical Debian Session/Job gray validation.

---

## [2026-06-25] feat | Stable payload write and script channel

### Added
- Added CLI `safe-write` for UTF-8 file-backed remote writes with optional LF normalization and default readback SHA-256 verification.
- Added CLI `safe-script` for file-backed remote script execution with interpreter allow-listing, upload verification, workspace-aware temporary paths, and default cleanup.
- Added CLI `safe-bash` as a file-backed bash entrypoint for grep pipelines, nested quotes, and multiline diagnostics.
- Added CLI `safe-apply` for file-backed remote patch application with `git apply --check` before applying.
- Added CLI `safe-job` for verified file-backed scripts that start as persistent remote jobs and return immediately.
- Added MCP `remote_script_async` for windowless submission of multi-line scripts as persistent daemon jobs.
- Added a Windows hidden stdio launcher with `CREATE_NO_WINDOW`, parent-exit detection, and kill-on-close Job Object cleanup.
- Added focused lifecycle tests for parent-process loss, hidden-launcher cleanup, SSH execution timeout, and `safe-job` dry-run behavior.

### Changed
- Updated agent guidance to keep PowerShell as a short launcher and route large source, patches, Markdown, Chinese text, and complex scripts through `safe-write` or `safe-script`.
- Updated agent guidance to route complex read-only remote commands through `safe-bash` instead of inline `bash "..."` strings.
- Updated agent guidance to route multi-file changes through `safe-apply --check` before applying.
- Native MCP is now the preferred Windows path for short operations; builds, tests, installs, and other long commands are routed to daemon jobs.
- Synchronous CLI SSH execution now defaults to a 120-second timeout and supports `--exec-timeout-ms`.
- Daemon job commands accept `--job-timeout-ms`; `safe-job` defaults to 30 minutes.
- MCP `remote_exec_async` now accepts `timeoutMs` and uses explicit non-keepalive transport for single-attempt job submission.

### Fixed
- CLI invocations now exit when their launching parent disappears and force-release residual handles after command completion.
- SSH disconnect now force-destroys connections that do not close promptly, preventing canceled commands from leaving orphaned Node processes.
- Skill sync now ignores the template MCP config path instead of creating a file named `PATH_TO_YOUR_AI_TOOL_MCP_CONFIG`.
- SSH health checks now pass their timeout options through without referencing an undefined argument object.
- The hidden stdio launcher now builds as the v3 Windows GUI subsystem executable, preventing the launcher itself from allocating a console window.

---

## [2026-06-16] fix | Fail-closed connection targeting for multi-session safety

### Added
- Added session-scoped CLI current state via `AGENTPORT_SESSION_ID` / `CODEX_SESSION_ID`.
- Added per-call `connection` support to MCP remote operation schemas.
- Added job connection metadata so SSH and daemon jobs can record the connection target used at start time.
- Added `client provision` for one-command machine/software token provisioning without printing raw tokens.
- Added `sync.cjs --skills --target <dir>` for syncing code into independent skill directories while preserving each target `local/`, `.git`, and `node_modules`.
- Added admin-only raw config reads behind `/api/config?raw=1` so CLI provisioning can update daemon tokens through hot reload.

### Changed
- Changed CLI connection resolution so explicit `--connection` wins and route/type mismatches fail instead of silently falling back.
- Changed high-risk CLI commands (`write`, `bash`, `script`, risky `batch`, `job`, `trace`, token mutation) to require explicit `--connection` when multiple connections are configured.
- Changed MCP high-risk tools (`remote_write`, `remote_bash`, `remote_script`, risky `remote_batch`, `remote_exec_async`, `remote_task`, config write) to fail closed without explicit `connection` in multi-connection setups.
- Added target metadata to key CLI JSON outputs so agents can see the actual connection, route, and host/url used.
- Changed onboarding docs to prefer `client provision` over manual `AUTH_TOKENS` copying.
- Condensed `SKILL.md` into a short runtime contract and moved install detail to `AGENT_GUIDE.md`.
- Changed fresh-install guidance to be SSH-first: create SSH-only `local/connections.json`, run `ssh-health`, provision this software's daemon token, then validate with authenticated `job list`.
- Changed `local/connections.json.example` to SSH-only so fresh installs do not start with fake daemon credentials.
- Fixed `sync.cjs --check` so it reports drift without writing files.

---

## [2026-05-23] feat | Built-in SSH trace maintenance tool

### Added
- Added CLI trace maintenance commands in `cli.js`:
  - `trace start [name] [--interval 5] [--restart]`
  - `trace status [name]`
  - `trace logs [name] [--tail 120]`
  - `trace stop [name]`
- Added SSH trace background runner that records periodic link metrics on remote host:
  - `estab_22`, `synrecv`, `timewait`, `users`, `load`
  - output path: `~/.agentport/trace/<name>.log`
- Added trace command examples in `README.md`, `SKILL.md`, and `AGENT_GUIDE.md`

### Changed
- Extended CLI usage output to include trace maintenance commands.

## [2026-05-20] feat | Multi-agent onboarding hardening and dashboard polish

### Added
- Added CLI token management commands in `cli.js`:
  - `token list`
  - `token add --client-id <id> [--admin] [--replace]`
  - `token revoke --client-id <id> [--admin]`
  - `token dashboard-url [--client-id <id>]`
- Added remote `.env` token parsing/serialization utilities for `AUTH_TOKENS` and `ADMIN_TOKENS`.
- Added setup wizard Step 3.5 in `setup.js` to confirm target host and whether dashboard access is needed on the current machine.

### Changed
- Updated setup guidance for both existing-daemon and first-bootstrap paths:
  - always create unique token per machine/software
  - provide explicit clientId naming hint (`machine-software`)
  - keep dashboard guidance conditional on user need
- Updated docs (`README.md`, `README_CN.md`, `INSTALL_OTHER_MACHINE.md`, `AGENT_GUIDE.md`) to standardize onboarding order:
  - local install first
  - remote read-only detection before deploy
  - existing daemon defaults to client-only mode
  - dashboard token url usage with `?token=<admin-token>`
  - fallback to `--route ssh` when native MCP transport is unstable
- Polished `server/dashboard.html` layout:
  - improved channel readability in connection status section
  - kept desktop one-row bottom layout for recent errors + service status (left wide, right narrow)
  - improved responsive behavior for medium/small screens

---

## [2026-05-20] fix | Safe remote_setup compatibility guard

### Added
- Added `remote_setup` input flags: `deploy`, `forceDeploy`, and `daemonPort`.
- Added explicit client-only behavior metadata in setup results (`deploySkipped`, daemon existence/running state).

### Changed
- Changed `remote_setup` default from auto-deploy to client-only safe mode (`deploy=false` by default).
- Added overwrite guard: when `deploy=true` and remote daemon directory exists, deployment now skips by default.
- Added explicit override path requiring `forceDeploy=true` for intentional replacement.
- Updated install and agent usage docs with the new no-overwrite compatibility flow for new/old computers.
- Updated `setup.js` flow to include remote daemon read-only detection and explicit safe-mode guidance (existing server vs first bootstrap).
- Expanded first-time bootstrap instructions with explicit token lifecycle steps (generate once, read `AUTH_TOKENS`, reuse across client computers).
- Added explicit guidance that different computers/software must use different tokens (no cross-machine token reuse).
- Added dashboard token guidance: dashboard URLs should use `?token=<admin-token>` and dashboard access requires `ADMIN_TOKENS`.

---

## [2026-05-20] fix | Per-software single core + multi-session proxy

### Added
- Added a local singleton broker inside `index.js` for each software/client instance key. The lock owner now starts a localhost broker and publishes broker metadata in the lock file.
- Added duplicate-process proxy mode: when a second MCP stdio process starts for the same software, it no longer exits immediately; it attaches to the owner broker and forwards `tools/list` and `tools/call`.
- Added lock metadata field `broker` (`url`, `token`, `port`, `startedAt`) so sibling processes can discover and reuse the owner instance.

### Changed
- Changed singleton behavior from "hard block duplicate" to "single core + proxy fan-in", preserving multi-session usability while keeping one stateful core instance per software key.
- Kept strict duplicate block as fallback when an owner lock exists but no reachable broker is available.

---

## [2026-05-20] feat | Connection trace diagnostics for Transport closed

### Added
- Added end-to-end connection trace fields in daemon audit events: `traceId`, `sessionId`, `callId`, `toolName`, `method`, `statusCode`, `durationMs`, and `phase`.
- Added request lifecycle connection events (`conn.req.start`, `conn.req.end`, `conn.req.fail`) for key paths (`/healthz`, connection APIs, exec/job APIs).
- Added daemon API `GET /api/connection-diagnostics` to aggregate recent connection events with:
  - totals and by-type counters
  - top error signatures
  - recent trace groups (per traceId)
  - recent raw events snapshot
- Added dashboard diagnostics panel `断链诊断摘要 that surfaces the aggregated diagnosis API directly in UI.

### Changed
- Updated dashboard connection troubleshooting flow to include machine-readable diagnosis output in addition to raw error lists.
- Updated MCP client transport requests to attach trace headers (`x-agentport-trace-id`, `x-agentport-session-id`, `x-agentport-call-id`, `x-agentport-tool`) so daemon and client logs can be correlated.

---

## [2026-05-20] feat | SSH-first CLI route and diagnostics

### Added
- Added `node cli.js ssh-health` to force an SSH path health probe even when the current default connection is daemon-based.
- Added `--route ssh|daemon|auto` route selection support so one-off commands can explicitly choose the transport channel.
- Added structured `--json` error output with fallback guidance for transport failures such as `Transport closed`, `ECONNRESET`, `ETIMEDOUT`, etc.
- Added SSH route job support in CLI: `job start/status/logs/cancel/list` now works through `--route ssh`, with remote job state persisted under `~/.agentport/cli-jobs`.
- Added SSH job idempotency key support: `node cli.js job start "<cmd>" --route ssh --key <stable-key>`.

### Changed
- Updated CLI status and doctor recommendations to prefer `ssh-first` as the baseline route, then daemon jobs, then native MCP convenience.
- Extended `read` and `bash` commands to return richer structured payloads in `--json` mode (`mode`, `path`, `command`, `cwd`).
- Updated README integration guidance and examples to match SSH-first operation.
- Added automatic daemon-to-SSH fallback in CLI for transport-level failures (`Transport closed`, `ECONNRESET`, `ETIMEDOUT`, etc.) when route is `auto`.

---

## [2026-05-19] docs | Repository rename and migration guidance

### Changed
- Updated README, install guide, agent guide, skill metadata, and changelog from `AgentPort` to `AgentPort`.
- Added compatibility guidance that existing machines and daemons can keep using old local directories, service names, and environment variables.
- Added new example commands using `agentport` while documenting the `niuma` compatibility alias for existing local scripts.

---

## [2026-05-19] feat | MCP sync and local-state isolation

### Added
- Added `sync.cjs` to sync the MCP project code to public GitHub targets while preserving local secrets and runtime state.
- Added `node sync.cjs --check` to preview sync deltas without writing.
- Added `node sync.cjs --dry-run` to print all file copy/delete/exclude decisions.
- Added `node sync.cjs --local-abort-on-extra` to require clean local-only state before sync when needed.
- Added `node sync.cjs --staged` to sync only Git-staged tracked files plus public additions/deletions.
- Added `test.cjs` to validate Sync's decision logic with temporary fixtures.
- Added Git hooks `scripts/hooks/pre-commis` and `scripts/hooks/pre-push` to block real local configs, tokens, keys, logs, and runtime files from being committed or pushed.
- Added `scripts/setup-git-hooks.cjs` for installing the local hook path.

### Changed
- Changed `sync.cjs` default mode to sync a fixed public-whitelist while preserving local `local/`, `logs/`, and `runtime/` data.
- Changed `sync.cjs` to skip target-side `.git`, `.cache`, `dist`, `build`, and `node_modules` content.
- Strengthened sync privacy scanning for tokens, private keys, passwords, local configurations, and sensitive filenames.
- Changed `.paiygnore` and `.gitignore` to ignore local configs, secrets, runtime state, generated outputs, and Sync manifests.
- Updated README documentation for sync, local state isolation, privacy scans, hooks, and public addition workflow.
- Updated SKILL instructions with a new `maintain_sync` operation and privacy guards.
- Updated `package.json` with `sync`, `sync:check`, and `sync:dry` scripts.

---

## [2026-05-19] docs | Fresh-clone install and migration guidance

- **Summary**: Added public GitHub repository content for fresh installs while keeping real local configs, tokens, keys, logs, and runtime state out of Git.
- **Impact Files**: `.gitignore`, `INSTALL_OTHER_MACHINE.md`, `local/README.md`, `local/config-guide.md`, `local/runtime-mode.json.example`, `README.md`, `README_CN.md`, `CHANGELOG.md`
- **Change Details**:
  1. Changed `.gitignore` to ignore only real local runtime secrets/state instead of hiding the entire `local/` directory from Git.
  2. Added an install/migration guide describing what to clone, what to copy privately, which SSH key paths must be adjusted, and which files must not be copied.
  3. Added `local/runtime-mode.json.example` and clarified local config docs so example files can be shipped safely.
  4. Updated README files with a short "install on another computer" path and explicit native MCP vs CLI fallback guidance.
- **Risk**: Users must still move real tokens and SSH private keys through a private channel. Absolute Windows key paths may need manual edits after migration.
- **Verification**: Fresh-clone install test identified the missing `local/` examples; follow-up verification should clone again after this documentation/config packaging fix is pushed.

## [2026-05-06 23:24] feat | operator: Codex | task: cli-fallback-adapter | scope: agent compatibility
- **Summary**: Added a general fallback path for AI tools that cannot inject native MCP tools, while keeping native MCP as the highest-priority integration mode.
- **Impact Files**: `cli.js`, `AGENT_GUIDE.md`, `SKILL.md`, `README.md`, `README_CN.md`, `package.json`, `package-lock.json`, `sync-to-github.ps1`, `CHANGELOG.md`
- **Change Details**:
  1. Added `cli.js` so agents with Bash/terminal access can run `doctor`, `list`, `connect`, `health`, `read`, `write`, `stat`, `glob`, `bash`, `script`, and `batch` without native MCP injection.
  2. Added `AGENT_GUIDE.md` with the agent-side install, probe, and usage workflow: native MCP first, CLI fallback second, daemon before SSH, HTTP/manual last.
  3. Updated `SKILL.md` and README files so future agents know how to choose the correct integration path automatically instead of hard-coding one AI desktop app.
  4. Added package entrypoints `npm run cli`, `npm run doctor`, and `bin.agentport`.
  5. Updated the sync whitelist so public repository sync includes the CLI, agent guide, and lockfile while excluding real local connection/token files.
- **Risk**: CLI fallback shares the same local `connections.json` source as the MCP server, so each target AI app still needs a valid local config. Daemon mode remains preferred for long-running coding; SSH lacks async/config-management features.
- **Verification**: Ran syntax checks, `node cli.js doctor`, daemon `health/read/bash/write`, SSH `bash`, privacy scans, repository sync, pre-commit privacy hook, and pushed commit `cb2c557`.

### Added
- **CLI fallback adapter**: added `cli.js` for AI tools that cannot inject native MCP tools but can run Bash/terminal commands
- **Agent install and usage guide**: added `AGENT_GUIDE.md` with the recommended priority order: native MCP first, CLI fallback second, HTTP/manual fallbacks only when needed
- **Package CLI entrypoints**: added `npm run cli`, `npm run doctor`, and a `agentport` bin entry

### Fixed
- **Node 22+ SSH compatibility**: `ssh-client.js` now restores the legacy `util.isDate` helper before loading `ssh2`, fixing `remote_read`, `remote_write`, and daemon auto-deploy flows that were failing with `isDate is not a function`
- **Connection switching reload**: `remote_connect` now refreshes `local/connections.json` before listing or switching connections, allowing newly added SSH/daemon targets to appear without changing chat sessions
- **Connection config BOM handling**: `loadConnections()` now strips a UTF-8 BOM before parsing `local/connections.json`, preventing an empty connection list after PowerShell rewrites

---

## [2.5.0] - 2026-05

### Added
- **remote_ssh_info Tool**: Scan local SSH environment (private keys, SSH config hosts, known_hosts, saved connections) — helps users discover available SSH resources before connecting
- **setup.js CLI Wizard**: Interactive command-line setup (`npm run setup`) that scans local SSH, guides user selection, tests connection, and auto-saves config
- **ssh-scanner.js Shared Module**: Extracted SSH scanning logic into reusable module, shared by both `index.js` (MCP tools) and `setup.js` (CLI wizard)
- **Smart Auth Recommendations**: `remote_setup` now auto-scans local SSH when no auth provided, returning smart recommendations (matching config hosts, usable keys) instead of a plain error
- **formatSSHScanSummary()**: Human-readable summary formatting for SSH scan results

### Changed
- **remote_setup Smart Scanning**: When called without `password`/`privateKey`, `remote_setup` auto-scans `~/.ssh/` and returns structured recommendations (config matches, usable keys, known_hosts status) instead of generic error
- **remote_ssh_info Refactored**: Now delegates scanning to `ssh-scanner.js` shared module, reducing code from 170 to 50 lines
- **index.js**: Removed `os` import (no longer needed), removed inline `scanLocalSSH()` and `formatSSHScanSummary()` functions
- **SKILL docs**: Updated guided installation flow to reflect `remote_setup` built-in scanning; removed outdated "must call remote_ssh_info first" rule
- **README**: Added CLI guided setup section (Step 3, recommended) with wizard capabilities overview
- **sync-to-github.ps1**: File list updated to include `ssh-scanner.js` and `setup.js`

---

## [2.4.0] - 2026-04

### Added
- **SSH Direct Connection Mode**: Connect to remote servers via SSH without deploying daemon process
- **remote_setup Tool**: Guided setup wizard - just provide server address, username, and password
- **Auto Deploy Daemon**: Automatically upload server files, install dependencies, and start service after SSH connection
- **Password & Key Authentication**: Support both password and SSH key authentication methods

### Changed
- `ssh-client.js` module rewritten to support password and privateKey authentication using ssh2 library
- Configuration and code separation - `local/` directory excluded from GitHub

---

## [2.3.1] - 2026-04

### Renamed
- **Project Renamed**: From `niuma-ssh` to `agentport`, better reflecting its positioning (MCP Server for AI Agent Remote Development)

### Security Fixes
- **Script Interpreter Whitelist**: Fixed security vulnerability in `remote_script` interpreter validation, only whitelisted interpreters allowed (bash, sh, python3, node, etc.)
- **Configurable Command Execution**: Added `ALLOW_BASH_EXEC` and `ALLOWED_COMMANDS` environment variables to disable or restrict `remote_bash` executable commands

### New Features
- **Dashboard HTML UI**: Added Web Dashboard for service status monitoring, audit statistics, error logging, and configuration management
- **Autostart Configuration Script**: Added `setup-autostart-agentport.sh` for one-click install/uninstall of crontab autostart configuration
- **Directory Structure Refactoring**: Configuration files moved to `local/` directory, sensitive information excluded from Git

### Documentation
- Expanded security recommendations including command execution restrictions and Admin Token usage notes
- Updated README.md with Dashboard and autostart configuration instructions
- Updated SKILL.md with new feature documentation

---

## [2.3.0] - 2026-04

### Added
- **Dynamic Connection**: Support dynamic switching between multiple remote servers without restarting MCP service
- `connections.json` configuration file for managing multi-server connections

### Changed
- Optimized `remote_connect` tool to support viewing available connections list and switching connections

---

## [2.2.1] - 2026-04

### Added
- **Configuration Hot Reload**: `remote_config` tool supports reading/modifying remote daemon configuration with automatic hot reload after changes
- `agentport.json` upgraded to variable center, unified management of client and server configurations
- `sync.cjs` script for automatic variable synchronization to all downstream files
- Server files included in skill package's `server/` directory

### Changed
- SKILL.md fully restructured with clearer documentation structure

---

## [2.2.0] - 2026-04

### Added
- `remote_exec_async` base64 encoding completion
- `remote_task` duration support for timestamp and ISO string
- `remote_script` interpreter whitelist security validation
- `remote_health` `recordOp` statistics completion

### Changed
- Refactored `ensureHealthy()` helper function to eliminate duplicate code
- `remote_read` cacheMiss statistics fix

---

## [2.1.0] - 2026-04

### Added
- **Script Execution**: `remote_script` tool supports writing multi-line scripts to temporary files for execution, completely avoiding bash escaping issues
- **File Metadata**: `remote_stat` tool for getting file size, modification time, and type
- **Base64 Encoding**: `remote_bash` automatically base64 encodes commands containing special characters (`$`, `` ` ``, `\`, etc.)
- **Encoding Cleanup**: `remote_write` automatically cleans CRLF→LF and UTF-8 BOM
- Health check changed to use `/healthz` endpoint
- Tool descriptions localized to Chinese

### Changed
- Health check failure now returns `isError` flag

---

## [2.0.0] - 2026-04

### Added
- **Batch Operations**: `remote_batch` tool supports up to 20 read/stat/glob/bash operations in a single request
- **Async Execution**: `remote_exec_async` + `remote_task` support long-running tasks
- **ETag Cache**: File reading supports ETag caching with 304 conditional reads to avoid retransmission
- **Connection Health Cache**: Reduces unnecessary health checks

---

## [1.1.0] - 2026-04

### Added
- **Connection Diagnostics**: `remote_status` tool displays comprehensive connection status, latency, cache hit rate, and operation statistics
- `NIUMA_SSH_CLIENT_ID` environment variable support for remote audit logging

---

## [1.0.0] - 2026-03

### Added
- Initial version
- Core tools: `remote_read`, `remote_write`, `remote_glob`, `remote_bash`, `remote_health`
