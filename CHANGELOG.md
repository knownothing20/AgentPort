# Changelog

## [2026-06-25] feat | Stable payload write and script channel

### Added
- Added CLI `safe-write` for UTF-8 file-backed remote writes with optional LF normalization and default readback SHA-256 verification.
- Added CLI `safe-script` for file-backed remote script execution with interpreter allow-listing, upload verification, workspace-aware temporary paths, and default cleanup.

### Changed
- Updated agent guidance to keep PowerShell as a short launcher and route large source, patches, Markdown, Chinese text, and complex scripts through `safe-write` or `safe-script`.

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
- Added trace command examples in `README.md`, `SKILL.md`, and `AGENT_GUIDE.md`.

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
  - dashboard token URL usage with `?token=<admin-token>`
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
  - recent trace groups (per traceId) for root-cause analysis
  - recent raw events snapshot
- Added dashboard diagnostics panel `断链诊断摘要` that surfaces the aggregated diagnosis API directly in UI.

### Changed
- Updated dashboard connection troubleshooting flow to include machine-readable diagnosis output in addition to raw error lists.
- Updated MCP client transport requests to attach trace headers (`x-agentport-trace-id`, `x-agentport-session-id`, `x-agentport-call-id`, `x-agentport-tool`) so daemon and client logs can be correlated.

---

## [2026-05-20] feat | SSH-first CLI route and diagnostics

### Added
- Added `node cli.js ssh-health` to force an SSH path health probe even when the current default connection is daemon-based.
- Added `--route ssh|daemon|auto` route selection support so one-off commands can explicitly choose the transport channel.
- Added structured `--json` error output with fallback guidance for transport failures such as `Transport closed`.
- Added SSH route job support in CLI: `job start/status/logs/cancel/list` now works through `--route ssh`, with remote job state persisted under `~/.agentport/cli-jobs`.
- Added SSH job idempotency key support: `node cli.js job start "<cmd>" --route ssh --key <stable-key>`.

### Changed
- Updated CLI status and doctor recommendations to prefer `ssh-first` as the baseline route, then daemon jobs, then native MCP convenience.
- Extended `read` and `bash` commands to return richer structured payloads in `--json` mode (`mode`, `path`, `command`, `cwd`).
- Updated README integration guidance and examples to match SSH-first operation.
- Added automatic daemon-to-SSH fallback in CLI for transport-level failures (`Transport closed`, `ECONNRESET`, `ETIMEDOUT`, etc.) when route is `auto`.

---

## [2026-05-19] docs | Reposition as remote development gateway

### Changed
- Updated README, README_CN, skill metadata, and package description from a single "MCP Server" positioning to an "AI Remote Development Gateway" positioning.
- Documented the preferred runtime order: CLI daemon gateway for long-running development, native MCP for quick structured operations, SSH recovery, then manual HTTP fallback.
- Added README examples for persistent daemon jobs: start, status, logs, cancel, and list.

---

## [2026-05-18] feat | Stable development gateway jobs

### Added
- Added persistent daemon job APIs for long-running development commands: start, list, status, logs, and cancel.
- Added CLI `status` plus `job start/status/logs/cancel/list` commands so agents can keep working through HTTP daemon jobs when native MCP stdio transport closes.

### Changed
- Expanded `/healthz` with daemon uptime, pid, node/platform, workspace status, job stats, audit writability, and memory usage.
- Updated CLI doctor guidance to prefer daemon jobs and SSH recovery over blocking on native MCP transport.

---

## [2026-05-16] fix | Deepen MCP transport failure diagnostics

### Changed
- Added per-process `sessionId`, uptime, stdio state, transport state, memory/resource usage, recent diagnostic events, last tool call, and active tool call snapshots to failure/close logs.
- Added a local process registry in `local/logs/agentport-processes.json` to flag recent sibling MCP client processes that may indicate repeated host restarts or duplicate stdio clients.
- Increased structured log payload retention from 500 characters to a configurable `MCP_REMOTE_LOG_DATA_MAX_BYTES` defaulting to 4000 characters, with circular object and `Error` serialization support.

---

## [2026-05-15] fix | MCP transport lifecycle diagnostics

### Changed
- Added local MCP process lifecycle logs for startup, exit, stdio close/error, stdin close/end/error, stdout errors, warnings, and termination signals.
- Added sanitized per-tool call diagnostics with call ids, duration, active connection, slow-call warnings, and timeout-specific hints.
- Added `MCP_REMOTE_SLOW_CALL_MS`, `MCP_REMOTE_LOG_TOOL_START`, and `MCP_REMOTE_LOG_TOOL_SUCCESS` controls for tuning local diagnostic verbosity.

---

## [2026-05-14] feat | Built-in remote content search

### Added
- Added `remote_grep` for structured remote content search without requiring `rg` on the remote host.
- Added daemon routes `/api/fs/grep` and `/grep`, using Node.js search inside `WORKSPACE_ROOT` with include patterns, excluded directories, result limits, literal/regex mode, and case sensitivity.
- Added CLI fallback `node cli.js grep` and batch `grep` support.

---

## [2026-05-14] fix | Keep MCP stdio transport alive on unexpected errors

### Changed
- Added top-level `unhandledRejection` and `uncaughtException` logging in the local MCP server so unexpected async errors are recorded instead of silently closing the stdio transport.

---

## [2026-05-14] docs | Whitepaper and README refresh

### Changed
- Added `WHITEPAPER.md` covering architecture, integration priority, config sync, execution backpressure, safety boundaries, deployment, and compatibility.
- Expanded `README.md` with architecture overview, execution backpressure behavior, updated config variables, and a clean ASCII directory tree.

---

## [2026-05-14] fix | Execution backpressure template sync

### Changed
- Synced the local daemon template with execution queue backpressure: `EXEC_QUEUE_TIMEOUT_MS`, hot-reloadable execution runtime settings, explicit 429 payloads, and batch bash slot accounting.
- Updated local generated config defaults to `EXEC_MAX_CONCURRENCY=4` and `EXEC_QUEUE_TIMEOUT_MS=15000`.
- Improved client error messages so HTTP 429 responses include remote `exec` state.

---
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Development Record

## [2026-05-07 00:00] docs | operator: Codex | task: other-machine-install | scope: install/migration
- **Summary**: Fixed the fresh GitHub install path so new machines receive safe `local/` examples and clear migration instructions without exposing private tokens.
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
