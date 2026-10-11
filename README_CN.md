# AgentPort

3.1 版远程开发网关：支持 MCP、CLI、SSH 恢复、持久 Job、Git Worktree
开发会话，以及命名工作区隔离。

让 AI Agent 通过稳定通道操作远程 Linux 服务器：读写文件、执行命令、查看诊断，并在原生 MCP transport 不稳定时继续恢复工作。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-3.1.0-blue)](https://github.com/knownothing20/agentport)
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

## 命名工作区与安全边界

3.1 支持同时暴露多个互不重叠的远程目录，而不会因此向 daemon 开放整台
服务器。每个目录都有固定名称；重复或父子嵌套的目录会被拒绝。

```json
{
  "default": "projects",
  "roots": {
    "projects": "/home/YOUR_USER/workspace",
    "openclaw": "/home/YOUR_USER/.openclaw"
  }
}
```

将以上内容保存为 daemon 环境文件同目录的 `workspaces.json`，并在私有
`.env` 中设置：

```dotenv
WORKSPACE_ROOT=/home/YOUR_USER/workspace
DEFAULT_WORKSPACE=projects
WORKSPACE_ROOTS_FILE=./workspaces.json
```

| 输入形式 | 含义 |
| --- | --- |
| `projects:/app/README.md` | `projects` 工作区内的明确路径 |
| `openclaw:/software/app` | `openclaw` 工作区内的明确路径 |
| `workspace://openclaw/software/app` | 命名工作区的 URI 形式 |
| `relative/path` | 仅在默认工作区内解析 |

文件读写、搜索、命令、Job 和开发会话都会保留对应的工作区边界。跨根路径、
`..` 穿越以及借助软链接逃离根目录都会被拒绝并返回 `EWORKSPACE`。

这限制的是 AgentPort daemon/MCP 通道；直接 SSH 仍然遵循该 Linux 用户本身
拥有的系统权限。

---

## 远程搜索依赖

`remote_grep` 不依赖 ripgrep：Daemon 模式使用受限范围的 Node 搜索，SSH
恢复模式使用受限范围的 `grep`。如果 Agent 会直接执行 Shell 搜索，建议安装可选的
`ripgrep` 软件包以提供 `rg`：

```bash
sudo apt update
sudo apt install -y ripgrep
command -v rg
```

`node cli.js doctor` 会报告每个 SSH 连接是否可用 `rg`。缺失时不影响
AgentPort 的 `remote_grep`；Agent 应先探测并静默回退到项目范围内的 `grep`，
不要先执行一个确定不存在的命令。

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

1. 先确认目标服务器（例如 `192.0.2.10`），先测 SSH 可达。
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

### 6. 部署或升级远程 daemon

远程 daemon 只应由一台运维机器部署一次。普通客户端安装不能覆盖已有的
服务端。3.1 升级时必须一并部署完整 release：`daemon/`、
`packages/daemon-core/`、`server/` 和根目录包文件。只复制 `server/` 虽然
仍可运行旧兼容服务，但不会获得模块化文件服务、持久 Job 和开发会话能力。

在远程 release 目录中安装两套依赖并启动：

```bash
cd /opt/agentport
npm ci
npm --prefix server ci
npm run start:daemon
```

升级前应在独立测试目录验证；激活时保留旧 release 以便回滚。切换 service
指向后重启服务，并同时验证 `GET /healthz` 与带认证的
`node cli.js health --route daemon --json`。真实 `.env` 和 Token 只能保留在
远程私有配置目录，不能进入仓库。

### 7. 重启 AI 工具

配置生效后，重启你的 AI 工具使 MCP 注册生效。

### 8. 验证 CLI fallback

如果当前 AI 工具没有暴露原生 `remote_*` 工具，执行：

```bash
npm run doctor
node cli.js health
```

至少应有一个连接返回 `"ok": true`。

`safe-bash` 和 `safe-script` 默认输出 JSON；短脚本需要直接获取文本时，可加
`--plain`，分别输出远端 stdout/stderr，并保留远端失败退出码。成功但没有输出
是正常情况，不应因此重跑脚本。Windows Git Bash 的 MSYS 可能在 Node 启动前
改写 `read`、`write`、`safe-write` 的远端位置参数，以及 `--cwd` 和
`--remote-tmp-dir`；仅加引号并不可靠。优先使用 PowerShell。必须使用 Git Bash
时，设置 `MSYS2_ARG_CONV_EXCL='*'`，并传入 Windows 兼容的本地文件/脚本路径
（必要时用 `cygpath -w`）。不要尝试修复已经转换过的参数。CLI 会拒绝可识别的
Windows 远端文件目标和目录参数。

可选服务器配置 `READ_ONLY_RULE_FILES_JSON` 默认关闭。管理员在 modular daemon
上明确启用后，认证用户只能通过普通文件读取及 batch-read 读取已登记的精确文本
文件（每个最多 256 KiB）；不授予 stat、字节读取、搜索、写入、cwd 或任意命令
权限。健康检查中的 roots/boundary 是服务器报告值，不是独立安全验证；路径边界
也不是 OS sandbox。本文不代表任何服务器已经启用该设置。

本地 MCP broker 失效后不再无条件重放请求：确认未送达时可读取替代 broker，
写入、命令和任务提交结果不明时返回 `EOUTCOME_UNKNOWN`，先核对原句柄与目标
状态再重试。权限拒绝不会触发通道回退。执行失败使用 MCP `isError`；轻量结束
日志区分完成、失败和结果未知，密钥字段在日志截断前脱敏。此更新不改写旧日志。
定向回归入口：`npm run test:mcp:recovery`，仅使用隔离的本地模拟服务。

本地运行日志可以直接汇总，无需连接服务器：

```bash
node cli.js diagnostics --days 7
node cli.js diagnostics --log-dir <skill-dir>/local/logs --days 7 --max-mb 64 --json
```

报告只输出统计数量、错误类别和耗时。带关联 ID 的代理/主进程记录会去重；
旧日志缺失完整字段时单独计数，不猜测成功率。报告不输出原始参数、命令输出、
路径、客户端 ID 或 Token。默认最多读取 32 MiB、64 个文件，达到限制会明确标注
覆盖不完整。缺失结束记录不等于失败或仍在运行；此报告不能替代服务端可用性和
业务验收。`--days` 范围为 1-90，`--max-mb` 范围为 1-256。

新日志标题限制为 1024 UTF-8 字节；Data 在 `MCP_REMOTE_LOG_DATA_MAX_BYTES`
限制内保持合法 JSON（默认 4000 字节），需要裁剪时附带 `_truncated` 标记。
失败记录保留调用 ID、错误类别和状态，不重复保存整段 stdout/stderr 和历史快照；
工具返回给调用方的正常输出保留。健康的代理启动记为 INFO。报告回归入口为
`npm run test:diagnostics`。旧日志不会被此次更新改写。

Daemon 搜索会在发出请求前检查正则语法。使用 JavaScript 正则及
`caseSensitive: false` 代替 `(?i)`；CLI 默认不区分大小写，只有指定
`--case-sensitive` 时才区分。默认的字面搜索和 SSH 原生 grep 语法保持不变。

```bash
node cli.js safe-bash local-readonly-check.sh --cwd /path/to/workspace \
  --connection <ssh-connection> --route ssh --plain
```

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
| `remote_grep` | 在授权工作区内搜索文件内容 |
| `remote_bash` | 执行远程命令 |
| `remote_script` | 执行多行脚本 |
| `remote_script_async` | 将多行脚本提交为持久后台任务 |
| `remote_batch` | 批量操作 |
| `remote_exec_async` | 异步执行 |
| `remote_task` | 查询异步任务 |
| `remote_config` | 配置热重载 |
| `remote_status` | 连接诊断 |
| `remote_job_logs` | 使用 cursor 增量读取 Job 日志 |
| `remote_project_*` | 查看、检查和执行项目预设操作 |
| `remote_session_*` | 管理隔离的 Worktree 开发会话 |

详细使用说明见 [SKILL.md](./SKILL.md)

---

## 目录结构

```
agentport/
├── client/                         # 本地 MCP 与 CLI 入口
├── daemon/                         # 公共 gateway 与 daemon 配置加载器
├── packages/
│   ├── client-core/                # 连接、项目与会话客户端运行时
│   ├── client-transport/           # daemon HTTP 与按需 SSH transport
│   ├── daemon-core/                # 路径防护、文件、执行、Job、会话服务
│   └── shared/                     # 共享安全策略和请求上下文
├── server/                         # Dashboard 与管理兼容服务
├── local/                          # 被忽略的私有客户端配置与日志
├── docs/                           # 架构和开发会话文档
├── SKILL.md                        # Agent 的短运行约定
├── AGENT_GUIDE.md                  # 安装和使用说明
├── cli.js / index.js               # 兼容旧版本的 CLI 与 MCP 入口
├── sync.cjs                        # Skill 与 MCP 配置同步工具
├── test/                            # 跨平台回归测试和测试说明
└── CHANGELOG.md                    # 版本历史
```

## 配置文件说明

| 文件 | 位置 | 说明 |
|------|------|------|
| `local/connections.json` | 每个客户端 | 兼容模式的 SSH 与 daemon 连接数据 |
| `local/connections.v3.json` | 每个客户端 | 逻辑服务器、端点、身份和 Token 配置 |
| `local/projects.json` | 每个客户端 | 项目 profile 与标准命令 |
| daemon `.env` | 远程 daemon | 端口、Token、执行限制和默认工作区 |
| `workspaces.json` | 远程 daemon | 命名工作区根目录，参考 `daemon/workspaces.json.example` |

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

3.1 daemon 建议使用 user-level systemd。它会以工作区所属用户运行，并避免
多个 manager 脚本或多个 `node server.js` 争抢同一个端口。

创建 `~/.config/systemd/user/agentport.service`：

```ini
[Unit]
Description=AgentPort development gateway
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/agentport
Environment=AGENTPORT_ENV_PATH=/home/YOUR_USER/.agentport/daemon/.env
ExecStart=/usr/bin/node /opt/agentport/daemon/server-entry.cjs
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

加载、启用并检查：

```bash
systemctl --user daemon-reload
systemctl --user enable --now agentport.service
systemctl --user status agentport.service
curl -fsS http://127.0.0.1:3183/healthz
```

旧的 `server/agentport-manager.sh` 仅保留给历史的单进程部署兼容使用。

---

## 安全特性

- **命名工作区隔离**：文件、搜索、执行、Job 和会话都限制在明确配置且互不
  重叠的根目录内。
- **路径与软链接防护**：拒绝 `..` 穿越以及通过软链接离开授权根目录。
- **Token 隔离**：每台机器、每个 AI 软件使用独立 `clientId=token`；Token 只
  能保留在被忽略的本地配置或远程私有 `.env`。
- **命令策略**：统一处理 shell 元字符、解释器限制、超时、并发队列和进程树
  清理。
- **显式破坏性操作**：会话合并、回滚、清理和分支删除均要求明确的 Session ID
  确认。
- **审计与脱敏**：审计日志留在远程端，API 响应会隐藏 Token 与敏感命令内容。

---

## 版本历史

详见 [CHANGELOG.md](./CHANGELOG.md)

---

## 许可证

MIT License - 详见 [LICENSE](./LICENSE)

---

## 贡献

欢迎提交 Issue 和 Pull Request！

首次启用仓库本地隐私拦截：

```bash
git config core.hooksPath .githooks
npm run privacy:check
npm run test:privacy
```

提交身份使用本人已核实的 GitHub noreply 身份。提交前检查暂存区快照及身份；
推送前检查待推送提交，包括后来已被删除或修复的中间版本，不要绕过 hook。
Skill 同步只复制 Git 跟踪的源码，保留各软件独立的私有配置。
本地拦截不能清除已经公开的历史，也不能替代 GitHub 服务端规则。
