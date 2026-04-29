# 更新日志

所有显著更改都将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
本项目遵循 [语义化版本控制](https://semver.org/lang/zh-CN/)。

---

## [2.4.0] - 2026-04

### 新增
- **SSH 直连模式**：无需部署守护进程，直接通过 SSH 连接远程服务器
- **remote_setup 工具**：引导式设置向导，只需提供服务器地址、用户名和密码
- **自动部署守护进程**：SSH 连接后自动上传服务端文件、安装依赖、启动服务
- **密码和密钥认证**：支持密码和 SSH 密钥两种认证方式

### 变更
- `ssh-client.js` 模块重写，使用 ssh2 库支持密码和私钥认证
- 代码与配置分离 - `local/` 目录排除在 GitHub 之外

---

## [2.3.1] - 2026-04

### 更名
- **项目更名**：从 `niuma-ssh` 更名为 `mcp-remote-agent`，更准确反映定位（MCP Server for AI Agent Remote Development）

### 安全修复
- **脚本解释器白名单**：修复 `remote_script` 解释器未校验的安全漏洞，仅允许白名单内的解释器（bash, sh, python3, node 等）
- **命令执行可配置限制**：新增 `ALLOW_BASH_EXEC` 和 `ALLOWED_COMMANDS` 环境变量，支持禁用或限制 `remote_bash` 可执行命令

### 新增功能
- **Dashboard HTML UI**：新增 Web Dashboard，支持服务状态监控、审计统计、错误记录、配置管理
- **自启动配置脚本**：新增 `setup-autostart.sh`，支持一键安装/卸载 crontab 自启动配置
- **目录结构重构**：配置文件移至 `local/` 目录，敏感信息不上传 Git

### 文档
- 扩展安全建议，包含命令执行限制和 Admin Token 使用注意事项
- 更新 README.md，添加 Dashboard 和自启动配置说明
- 更新 SKILL.md，添加新功能文档

---

## [2.3.0] - 2026-04

### 新增
- **动态连接功能**：支持在多个远程服务器之间动态切换，无需重启 MCP 服务
- `connections.json` 配置文件管理多服务器连接

### 变更
- 优化 `remote_connect` 工具，支持查看可用连接列表和切换连接

---

## [2.2.1] - 2026-04

### 新增
- **配置热重载**：`remote_config` 工具支持读取/修改远端守护进程配置，修改后自动热重载，无需重启服务
- `mcp-remote-agent.json` 升级为变量中心，统一管理客户端和服务端配置
- `sync.cjs` 脚本自动同步变量到所有下游文件
- 服务端文件纳入 skill 包的 `server/` 目录

### 变更
- SKILL.md 全面重构，文档结构更清晰

---

## [2.2.0] - 2026-04

### 新增
- `remote_exec_async` 补全 base64 编码
- `remote_task` duration 支持 timestamp 和 ISO string
- `remote_script` interpreter 增加白名单安全校验
- `remote_health` 补全 `recordOp` 统计

### 变更
- 重构 `ensureHealthy()` 辅助函数，消除重复代码
- `remote_read` cacheMiss 统计修正

---

## [2.1.0] - 2026-04

### 新增
- **脚本执行**：`remote_script` 工具支持多行脚本写入临时文件再执行，彻底避免 bash 转义问题
- **文件元信息**：`remote_stat` 工具获取文件大小、修改时间、类型
- **Base64 编码**：`remote_bash` 对含特殊字符（`$` `` ` `` `\` 等）的命令自动 base64 编码
- **编码清理**：`remote_write` 自动清理 CRLF→LF 和 UTF-8 BOM
- 健康检查改用 `/healthz` 接口
- 工具 description 中文化

### 变更
- 健康检查失败时返回 `isError` 标志

---

## [2.0.0] - 2026-04

### 新增
- **批量操作**：`remote_batch` 工具支持一次请求最多 20 个 read/stat/glob/bash 操作
- **异步执行**：`remote_exec_async` + `remote_task` 支持长耗时任务
- **ETag 缓存**：文件读取支持 ETag 缓存，304 条件读取不重传
- **连接健康缓存**：减少不必要的健康检查

---

## [1.1.0] - 2026-04

### 新增
- **连接诊断**：`remote_status` 工具综合显示连接状态、延迟、缓存命中率、操作统计
- `NIUMA_SSH_CLIENT_ID` 环境变量支持，用于远端审计日志

---

## [1.0.0] - 2026-03

### 新增
- 初始版本
- 核心工具：`remote_read`、`remote_write`、`remote_glob`、`remote_bash`、`remote_health`
