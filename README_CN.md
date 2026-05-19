# mcp-remote-agent

## Agent 接入优先级

`mcp-remote-agent` 现在的定位不是单一 MCP Server，而是 AI 远程开发网关。它同时支持 CLI daemon 网关、原生 MCP、SSH 恢复和持久 Job，给不同 AI 软件接入时，不要写死某一个软件名，而是按稳定性自动选择：

1. **长期开发优先 CLI daemon 网关**：使用 `node cli.js status` 和 `node cli.js job ...`，适合测试、构建、轮询、长任务和原生 MCP transport 断开后的恢复。
2. **快速结构化操作使用原生 MCP**：如果当前会话能看到 `remote_*` 工具且稳定，使用 `remote_connect()` -> `remote_health()` -> 其他 `remote_*` 操作。
3. **CLI 内部 SSH 恢复**：daemon 不可用或需要重启/诊断时，再切 SSH。
4. **HTTP/人工兜底最后使用**：只有 MCP 和 CLI 都不可用时，才考虑直接 REST/curl 或输出人工命令。

CLI fallback 示例：

```bash
node cli.js doctor
node cli.js list
node cli.js connect <connection-name>
node cli.js health
node cli.js read /path/to/workspace/AGENTS.md
node cli.js bash "pwd && ls -la" --cwd /path/to/workspace
node cli.js write /path/to/workspace/tmp.txt --content "hello"
```

持久 Job 示例：

```bash
node cli.js status
node cli.js job start "npm test" --cwd /path/to/workspace
node cli.js job status <job-id>
node cli.js job logs <job-id> --tail 200
node cli.js job cancel <job-id>
node cli.js job list --limit 20
```

Job 会在远程 daemon 内继续运行；即使 AI 软件的原生 MCP stdio 链路断开，也可以重新通过 CLI 查看状态和日志。

完整 Agent 安装、检测和使用流程见 [AGENT_GUIDE.md](./AGENT_GUIDE.md)。

AI 远程开发网关：同时支持 MCP、CLI、SSH 恢复和持久 daemon Job

新电脑或其他 AI 软件安装迁移请先看 [INSTALL_OTHER_MACHINE.md](./INSTALL_OTHER_MACHINE.md)。长期开发优先走 CLI daemon 网关；如果目标软件稳定支持 **原生 MCP / native MCP**，可用于快速结构化操作；daemon 不可用时再用 CLI 内置 SSH 恢复。简版流程：

```bash
git clone https://github.com/knownothing20/mcp-remote-agent.git
cd mcp-remote-agent
npm install
cp local/connections.json.example local/connections.json
npm run doctor
```

然后通过安全方式复制旧电脑的 `local/connections.json`、按需复制 `local/mcp-remote-agent.json` 和 SSH 私钥，并按新电脑用户名修正私钥绝对路径。

让 AI Agent 通过稳定的远程开发网关操作 Linux 服务器：支持原生 MCP、CLI fallback、daemon HTTP API、SSH 恢复和持久 Job。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-2.5.0-blue)](https://github.com/knownothing20/mcp-remote-agent)

---

## 一句话简介

让 AI Agent（如 WorkBuddy、Claude Desktop、Cursor）通过稳定远程开发网关读写远程 Linux 文件、执行命令、查看诊断、控制长任务，并在原生 MCP 链路不稳定时继续恢复工作。

**类比**：VS Code Remote SSH 是给人用的，mcp-remote-agent 是给 AI 用的。

---

## 核心功能

| 功能 | 说明 |
|------|------|
| 远程文件读写 | `remote_read` / `remote_write` / `remote_stat` |
| 远程搜索 | `remote_glob` 按 glob 模式搜索文件 |
| 命令执行 | `remote_bash` 执行简单命令，`remote_script` 执行多行脚本 |
| 批量操作 | `remote_batch` 一次请求最多 20 个操作 |
| 原生 MCP 工具 | 当前 AI 软件支持自定义 MCP 时使用结构化 `remote_*` 工具 |
| CLI daemon 网关 | `node cli.js status` 和 `node cli.js job ...` 支撑稳定开发流程 |
| 持久 Job | 远程 daemon 内运行测试、构建、长任务，支持状态、日志和取消 |
| 异步执行 | `remote_exec_async` + `remote_task` 作为长任务兼容接口 |
| 配置热重载 | `remote_config` 修改远端配置无需重启 |
| 动态连接 | 支持多服务器切换，无需重启 MCP |
| 健康检查 | 自动检测远端服务状态 |
| 编码处理 | 自动 base64 编码特殊字符，清理 CRLF/BOM |

---

## 快速开始

### 1. 复制 skill 到本地

```bash
git clone https://github.com/knownothing20/mcp-remote-agent.git
cd mcp-remote-agent
```

### 2. 安装依赖

```bash
npm install
```

### 3. CLI 引导式配置（推荐）

使用交互式向导自动扫描 SSH 环境，一步步引导配置：

```bash
npm run setup
```

该命令会：
1. 自动扫描本地 SSH 密钥、config 和 known_hosts
2. 展示扫描结果，让你选择合适的认证方式
3. 引导输入服务器地址和用户名
4. 测试 SSH 连接
5. 自动保存配置到 `local/connections.json`

### 4. 手动配置（备选）

如果不使用引导式向导，可以手动配置：

```bash
cp mcp-remote-agent.example.json local/mcp-remote-agent.json
# 编辑 local/mcp-remote-agent.json，填写 variables 区所有配置
```

关键变量说明：

| 变量 | 说明 |
|------|------|
| `skillDir` | skill 安装目录的绝对路径 |
| `mcpConfigPath` | 目标 AI 工具的 MCP 配置文件路径 |
| `remoteUrl` | 远端守护进程地址 |
| `authToken` | 客户端鉴权 token |

### 4. 同步配置

```bash
node sync.cjs
```

### 5. 部署远程守护进程

```bash
# 在远程服务器创建目录
ssh USER@SERVER "mkdir -p /path/to/daemon"

# 上传服务端文件到远程服务器
scp server/server.js server/mcp-remote-agent-manager.sh server/package.json USER@SERVER:/path/to/daemon/

# 上传生成的 .env 配置（步骤 4 由 sync.cjs 生成）
scp local/server/.env USER@SERVER:/path/to/daemon/

# SSH 到远程服务器
ssh USER@SERVER
cd /path/to/daemon
npm install
nohup bash mcp-remote-agent-manager.sh >> boot.log 2>&1 &
```

### 6. 重启 AI 工具

配置生效后，重启你的 AI 工具使 MCP 注册生效。

---

## 支持的 AI 工具

| AI 工具 | MCP 配置路径（Windows） | MCP 配置路径（macOS/Linux） |
|---------|--------------------------|------------------------------|
| WorkBuddy | `C:\Users\<用户>\.workbuddy\mcp.json` | `~/.workbuddy/mcp.json` |
| Claude Desktop | `C:\Users\<用户>\AppData\Roaming\Claude\claude_desktop_config.json` | `~/.config/Claude/claude_desktop_config.json` |
| Cursor | `<项目目录>\.cursor\mcp.json` | `<项目目录>/.cursor/mcp.json` |
| Windsurf | `C:\Users\<用户>\.codeium\windsurf\mcp_config.json` | `~/.codeium/windsurf/mcp_config.json` |

---

## 工具列表

| 工具 | 功能 |
|------|------|
| `remote_ssh_info` | 扫描本地 SSH 环境（密钥、config、已知主机） |
| `remote_health` | 检查远端服务可达性 |
| `remote_read` | 读取远程文件（ETag 缓存） |
| `remote_write` | 写入远程文件（自动清理 CRLF/BOM） |
| `remote_stat` | 获取文件元信息 |
| `remote_glob` | 按 glob 模式搜索 |
| `remote_bash` | 执行远程命令 |
| `remote_script` | 执行多行脚本 |
| `remote_batch` | 批量操作 |
| `remote_exec_async` | 异步执行 |
| `remote_task` | 查询异步任务 |
| `remote_config` | 配置热重载 |
| `remote_status` | 连接诊断 |

详细使用说明见 [SKILL.md](./SKILL.md)

---

## 目录结构

```
mcp-remote-agent/
├── SKILL.md                        # 完整说明文档
├── README.md                       # 英文说明
├── README_CN.md                    # 中文说明（本文件）
├── index.js                        # MCP server 主程序
├── package.json                    # 客户端依赖
├── mcp-remote-agent.example.json   # 配置模板
├── sync.cjs                        # 变量同步脚本
├── test.cjs                        # 测试脚本
├── .gitignore                      # Git 忽略配置
├── LICENSE                         # MIT 许可证
├── CHANGELOG.md                    # 版本变更日志
├── local/                          # 本地配置目录
│   ├── README.md                   # 配置说明文档
│   ├── mcp-remote-agent.json       # 主配置（从模板复制）
│   ├── connections.json.example    # 多服务器配置样例
│   └── server/
│       └── .env                    # 服务端配置（自动生成）
└── server/
    ├── server.js                   # 守护进程
    ├── mcp-remote-agent-manager.sh # 进程守护脚本
    ├── setup-autostart.sh          # 自启动配置脚本
    ├── dashboard.html              # Web Dashboard UI
    ├── .env.example                # 服务端配置模板
    └── package.json                # 服务端依赖
```

## 配置文件说明

| 文件 | 位置 | 说明 |
|------|------|------|
| `mcp-remote-agent.json` | `local/` | 主配置（从 `mcp-remote-agent.example.json` 复制） |
| `connections.json` | `local/` | 多服务器连接配置（可选，参考 `connections.json.example`） |
| `.env` | `server/` | 服务端配置（由 `sync.cjs` 自动生成） |

详细配置说明见 [`local/config-guide.md`](./local/config-guide.md)。

---

## Dashboard

mcp-remote-agent 提供 Web Dashboard 用于监控和管理：

### 启用 Dashboard

在 `local/mcp-remote-agent.json` 中设置：

```json
{
  "variables": {
    "serverEnableDashboard": "true"
  }
}
```

### 访问 Dashboard

启动服务后，访问：
- `http://your-server:3183/`
- `http://your-server:3183/dashboard`

### Dashboard 功能

| 功能 | 说明 |
|------|------|
| 服务状态 | 查看 Node.js、依赖、端口、磁盘等状态 |
| 审计统计 | 查看请求统计、成功率、按类型/客户端分析 |
| 错误记录 | 查看最近错误日志 |
| 配置管理 | 查看和修改服务端配置（需 Admin Token） |

---

## 自启动配置

### 方法 1：使用 setup-autostart.sh（推荐）

```bash
# SSH 到远程服务器
ssh USER@SERVER
cd /path/to/daemon

# 安装自启动
bash setup-autostart.sh install

# 查看状态
bash setup-autostart.sh status

# 卸载自启动
bash setup-autostart.sh uninstall
```

### 方法 2：手动配置 crontab

```bash
# 编辑 crontab
crontab -e

# 添加以下行
@reboot /path/to/daemon/mcp-remote-agent-manager.sh # mcp-remote-agent autostart
```

### 方法 3：使用 systemd（可选）

创建 `/etc/systemd/system/mcp-remote-agent.service`：

```ini
[Unit]
Description=mcp-remote-agent daemon
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/daemon
ExecStart=/bin/bash /path/to/daemon/mcp-remote-agent-manager.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

然后启用：

```bash
sudo systemctl enable mcp-remote-agent
sudo systemctl start mcp-remote-agent
```

---

## 安全特性

- **工作区隔离**：文件操作限制在 `WORKSPACE_ROOT` 内
- **Token 鉴权**：客户端 token + admin token
- **路径限制**：防止越权访问
- **脚本解释器白名单**：仅允许安全解释器
- **命令执行限制**：可配置 `ALLOW_BASH_EXEC` 和 `ALLOWED_COMMANDS`

---

## 版本历史

详见 [CHANGELOG.md](./CHANGELOG.md)

---

## 许可证

MIT License - 详见 [LICENSE](./LICENSE)

---

## 贡献

欢迎提交 Issue 和 Pull Request！
