# mcp-remote-agent - AI Agent 远程开发 MCP 服务器

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-2.5.0-blue)](https://github.com/knownothing20/mcp-remote-agent)
[![MCP](https://img.shields.io/badge/MCP-兼容-green.svg)](https://modelcontextprotocol.io)

> **VS Code Remote SSH 是给人用的，mcp-remote-agent 是给 AI 用的。**

让 AI Agent（Claude、Cursor、WorkBuddy、Windsurf、Cline）通过 MCP 协议直接读写远程 Linux 服务器文件、执行命令。一键连接，自动部署守护进程，本地开发与远程服务器无缝衔接。

[English](./README.md) | [快速开始](#快速开始) | [核心功能](#核心功能)

---

## 为什么需要 mcp-remote-agent？

**问题**：AI Agent 只能操作本地文件。要在远程服务器上开发，需要手动复制文件、执行命令、管理连接。

**解决方案**：mcp-remote-agent 通过 MCP 协议赋予 AI Agent 完整的远程服务器访问能力 - 读取文件、编写代码、执行命令、管理配置，全部自动化。

**使用场景**：
- 🚀 **远程开发**：AI 直接在开发服务器上编写代码
- 🔧 **服务器管理**：AI 自动化运维任务
- 📦 **部署上线**：AI 处理部署流程
- 🧪 **测试验证**：AI 在远程环境运行测试
- 📊 **监控检查**：AI 检查服务器状态和日志

---

## 与其他工具对比

| 功能 | mcp-remote-agent | VS Code Remote SSH | SSH CLI | Ansible |
|------|------------------|-------------------|---------|---------|
| **AI Agent 支持** | ✅ 原生 MCP | ❌ 仅人工 | ❌ 仅人工 | ❌ 仅脚本 |
| **配置复杂度** | 1 条命令 | GUI 向导 | 手动 | 复杂 YAML |
| **文件操作** | ✅ 读/写/搜索 | ✅ 完整 IDE | ❌ 手动 | ✅ Playbook |
| **命令执行** | ✅ 同步/异步 | ✅ 终端 | ✅ 手动 | ✅ Tasks |
| **多服务器** | ✅ 动态切换 | ❌ 一次一个 | ❌ 手动 | ✅ Inventory |
| **配置管理** | ✅ 热重载 | ❌ 需重启 | ❌ 手动 | ✅ Handlers |
| **Dashboard** | ✅ Web UI | ❌ 无 | ❌ 无 | ❌ 无 |
| **审计日志** | ✅ 内置 | ❌ 无 | ❌ 无 | ✅ Callback |

**最适合**：AI 驱动开发、自动化服务器管理、多服务器工作流

---

## 核心功能

| 功能 | 说明 |
|------|------|
| SSH 直连 | 无需部署守护进程，直接 SSH 连接 (v2.4.0+) |
| 引导式连接 | `remote_setup` 一键连接 + 自动部署守护进程 (v2.5.0+) |
| 远程文件读写 | `remote_read` / `remote_write` / `remote_stat` |
| 远程搜索 | `remote_glob` 按 glob 模式搜索文件 |
| 命令执行 | `remote_bash` 执行简单命令，`remote_script` 执行多行脚本 |
| 批量操作 | `remote_batch` 一次请求最多 20 个操作 |
| 异步执行 | `remote_exec_async` + `remote_task` 处理长耗时任务 |
| 配置热重载 | `remote_config` 修改远端配置无需重启 |
| 动态连接 | 支持多服务器切换，无需重启 MCP |
| 健康检查 | 自动检测远端服务状态 |
| 编码处理 | 自动 base64 编码特殊字符，清理 CRLF/BOM |

---

## 快速开始

### 方式一：一键连接（推荐）

只需告诉 AI Agent：

> "连接到我的服务器 192.168.1.100，用户名 root，密码 xxx"

AI 会自动完成：
1. ✅ 测试 SSH 连接
2. ✅ 部署守护进程到远程服务器
3. ✅ 保存配置
4. ✅ 切换到守护进程模式
5. ✅ 返回 Dashboard 监控地址

**就这么简单！** 无需手动编辑文件，无需 SSH 命令，无需配置文件。

### 方式二：手动配置

<details>
<summary>点击展开手动配置步骤</summary>

#### 1. 克隆并安装

```bash
git clone https://github.com/knownothing20/mcp-remote-agent.git
cd mcp-remote-agent
npm install
```

#### 2. 配置

```bash
cp mcp-remote-agent.example.json local/mcp-remote-agent.json
# 编辑 local/mcp-remote-agent.json，填写所有变量
```

关键变量：

| 变量 | 说明 |
|------|------|
| `skillDir` | skill 安装目录的绝对路径 |
| `mcpConfigPath` | 目标 AI 工具的 MCP 配置文件路径 |
| `remoteUrl` | 远程守护进程地址 |
| `authToken` | 客户端认证 token |

#### 3. 同步并部署

```bash
# 同步配置
node sync.cjs

# 部署到远程服务器
ssh USER@SERVER "mkdir -p /path/to/daemon"
scp server/* USER@SERVER:/path/to/daemon/
ssh USER@SERVER "cd /path/to/daemon && npm install && nohup bash mcp-remote-agent-manager.sh >> boot.log 2>&1 &"
```

#### 4. 重启 AI 工具

配置生效后，重启 AI 工具以激活 MCP 注册。

</details>

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
| `remote_setup` | 引导式连接设置 + 自动部署守护进程 (v2.5.0+) |
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

详细配置说明见 [`local/README.md`](./local/README.md)。

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