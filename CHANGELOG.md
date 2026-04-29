# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
