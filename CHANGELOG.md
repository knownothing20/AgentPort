# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

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
- **Project Renamed**: From `niuma-ssh` to `mcp-remote-agent`, better reflecting its positioning (MCP Server for AI Agent Remote Development)

### Security Fixes
- **Script Interpreter Whitelist**: Fixed security vulnerability in `remote_script` interpreter validation, only whitelisted interpreters allowed (bash, sh, python3, node, etc.)
- **Configurable Command Execution**: Added `ALLOW_BASH_EXEC` and `ALLOWED_COMMANDS` environment variables to disable or restrict `remote_bash` executable commands

### New Features
- **Dashboard HTML UI**: Added Web Dashboard for service status monitoring, audit statistics, error logging, and configuration management
- **Autostart Configuration Script**: Added `setup-autostart.sh` for one-click install/uninstall of crontab autostart configuration
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
- `mcp-remote-agent.json` upgraded to variable center, unified management of client and server configurations
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
