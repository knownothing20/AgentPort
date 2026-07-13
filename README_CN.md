# agentport

AI 远程开发网关：支持 MCP、CLI、SSH 恢复和持久 daemon Job。

让 AI Agent 通过稳定通道操作远程 Linux 服务器：读写文件、执行命令、查看诊断，并在原生 MCP transport 不稳定时继续恢复工作。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-2.5.0-blue)](https://github.com/knownothing20/agentport)
[English](./README.md)

---

## Agent 接入优先级

按任务类型选择最稳通道：

1. **快速结构化操作优先原生 MCP**：如果 `remote_*` 工具可见且稳定，使用 `remote_connect()` -> `remote_health()` -> 其他 `remote_*` 操作。
2. **长任务开发优先 CLI daemon**：使用 `node cli.js status` 和 `node cli.js job ...` 执行测试、构建、轮询与恢复。
3. **CLI 内 SSH 作为恢复通道**：daemon 不可用或需要诊断时切换 SSH。
4. **HTTP/手工命令最后兜底**：仅在 MCP 和 CLI 都不可用时使用。

完整安装与使用流程见 [AGENT_GUIDE.md](./AGENT_GUIDE.md)。  
新电脑迁移见 [INSTALL_OTHER_MACHINE.md](./INSTALL_OTHER_MACHINE.md)。

---

## 一句话简介

让 AI Agent（如 WorkBuddy、Claude Desktop、Cursor）通过稳定远程开发网关读写远程 Linux 文件、执行命令、查看诊断、控制长任务，并在原生 MCP 链路不稳定时继续恢复工作。

**类比**：VS Code Remote SSH 是给人用的，agentport 是给 AI 用的。

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
| 异步执行 | `remote_exec_async` / `remote_script_async` + `remote_task` 作为长任务接口 |
| 配置热重载 | `remote_config` 修改远端配置无需重启 |
| 动态连接 | 支持多服务器切换，无需重启 MCP |
| 健康检查 | 自动检测远端服务状态 |
| 编码处理 | 自动 base64 编码特殊字符，清理 CRLF/BOM |

---

## 快速开始

### 1. 复制 skill 到本地

```bash
git clone https://github.com/knownothing20/agentport.git
cd agentport
```

### 2. 安装依赖

```bash
npm install
```

### 2.1 首次接入顺序（本地 + 远端）

1. 先确认目标服务器（例如 `192.168.31.183`），先测 SSH 可达。
2. 先完成本地安装（`git clone` + `npm install`），再做远端动作。
3. 先只读检测远端状态：daemon 目录、`.env`、进程、`3183` 端口。
4. 若远端已存在 daemon：保持客户端模式（`deploy=false`），不要覆盖部署。
5. 若远端不存在 daemon：仅一次首装（`deploy=true`，由一台运维机执行）。
6. token 必须“每台机器 + 每个软件”唯一，不要跨机器复用同一个 token。
7. 若该机器需要监控面板权限，token 还要在 `ADMIN_TOKENS` 中，并使用：
   - `http://<host>:3183/?token=<admin-token>`
   - `http://<host>:3183/dashboard?token=<admin-token>`
8. 稳定性预期：原生 MCP 不稳定或出现 `Transport closed` 时，切到 `node cli.js ... --route ssh` 继续。

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
cp agentport.example.json local/agentport.json
# 编辑 local/agentport.json，填写 variables 区所有配置
```

关键变量说明：

| 变量 | 说明 |
|------|------|
| `skillDir` | skill 安装目录的绝对路径 |
| `mcpConfigPath` | 目标 AI 工具的 MCP 配置文件路径 |
| `remoteUrl` | 远端守护进程地址 |
| `authToken` | 客户端鉴权 token |

### 5. 同步配置

```bash
node sync.cjs
```

### 6. 部署远程守护进程

```bash
# 在远程服务器创建目录
ssh USER@SERVER "mkdir -p /path/to/daemon"

# 上传服务端文件到远程服务器
scp server/server.js server/agentport-manager.sh server/package.json USER@SERVER:/path/to/daemon/

# 上传生成的 .env 配置（步骤 4 由 sync.cjs 生成）
scp local/server/.env USER@SERVER:/path/to/daemon/

# SSH 到远程服务器
ssh USER@SERVER
cd /path/to/daemon
npm install
nohup bash agentport-manager.sh >> boot.log 2>&1 &
```

### 7. 重启 AI 工具

配置生效后，重启你的 AI 工具使 MCP 注册生效。

### 8. 验证 CLI fallback

如果当前 AI 工具没有暴露原生 `remote_*` 工具，执行：

```bash
npm run doctor
node cli.js health
```

至少应有一个连接返回 `"ok": true`。

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
| `remote_script_async` | 将多行脚本提交为持久后台任务 |
| `remote_batch` | 批量操作 |
| `remote_exec_async` | 异步执行 |
| `remote_task` | 查询异步任务 |
| `remote_config` | 配置热重载 |
| `remote_status` | 连接诊断 |

详细使用说明见 [SKILL.md](./SKILL.md)

---

## 目录结构

```
agentport/
├── SKILL.md                        # 完整说明文档
├── README.md                       # 英文说明
├── README_CN.md                    # 中文说明（本文件）
├── index.js                        # MCP server 主程序
├── package.json                    # 客户端依赖
├── agentport.example.json   # 配置模板
├── sync.cjs                        # 变量同步脚本
├── test.cjs                        # 测试脚本
├── .gitignore                      # Git 忽略配置
├── LICENSE                         # MIT 许可证
├── CHANGELOG.md                    # 版本变更日志
├── local/                          # 本地配置目录
│   ├── README.md                   # 配置说明文档
│   ├── agentport.json       # 主配置（从模板复制）
│   ├── connections.json.example    # 多服务器配置样例
│   └── server/
│       └── .env                    # 服务端配置（自动生成）
└── server/
    ├── server.js                   # 守护进程
    ├── agentport-manager.sh # 进程守护脚本
    ├── setup-autostart-agentport.sh          # 自启动配置脚本
    ├── dashboard.html              # Web Dashboard UI
    ├── .env.example                # 服务端配置模板
    └── package.json                # 服务端依赖
```

## 配置文件说明

| 文件 | 位置 | 说明 |
|------|------|------|
| `agentport.json` | `local/` | 主配置（从 `agentport.example.json` 复制） |
| `connections.json` | `local/` | 多服务器连接配置（可选，参考 `connections.json.example`） |
| `.env` | `server/` | 服务端配置（由 `sync.cjs` 自动生成） |

详细配置说明见 [`local/config-guide.md`](./local/config-guide.md)。

---

## Dashboard

agentport 提供 Web Dashboard 用于监控和管理：

### 启用 Dashboard

在 `local/agentport.json` 中设置：

```json
{
  "variables": {
    "serverEnableDashboard": "true"
  }
}
```

### 访问 Dashboard

启动服务后，访问：
- `http://your-server:3183/?token=<admin-token>`
- `http://your-server:3183/dashboard?token=<admin-token>`

### Dashboard 功能

| 功能 | 说明 |
|------|------|
| 服务状态 | 查看 Node.js、依赖、端口、磁盘等状态 |
| 审计统计 | 查看请求统计、成功率、按类型/客户端分析 |
| 错误记录 | 查看最近错误日志 |
| 配置管理 | 查看和修改服务端配置（需 Admin Token） |

---

## 自启动配置

### 方法 1：使用 setup-autostart-agentport.sh（推荐）

```bash
# SSH 到远程服务器
ssh USER@SERVER
cd /path/to/daemon

# 安装自启动
bash setup-autostart-agentport.sh install

# 查看状态
bash setup-autostart-agentport.sh status

# 卸载自启动
bash setup-autostart-agentport.sh uninstall
```

### 方法 2：手动配置 crontab

```bash
# 编辑 crontab
crontab -e

# 添加以下行
@reboot /path/to/daemon/agentport-manager.sh # agentport autostart
```

### 方法 3：使用 systemd（可选）

创建 `/etc/systemd/system/agentport.service`：

```ini
[Unit]
Description=agentport daemon
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/daemon
ExecStart=/bin/bash /path/to/daemon/agentport-manager.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

然后启用：

```bash
sudo systemctl enable agentport
sudo systemctl start agentport
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
