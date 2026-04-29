#!/bin/bash
# mcp-remote-agent 自启动配置脚本
# 用法: bash setup-autostart.sh [install|uninstall|status]

set -uo pipefail

DAEMON_DIR="$(cd "$(dirname "$0")" && pwd)"
MANAGER_SCRIPT="$DAEMON_DIR/mcp-remote-agent-manager.sh"
CRON_TAG="# mcp-remote-agent autostart"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

install() {
  info "安装自启动配置..."
  
  # 检查 mcp-remote-agent-manager.sh 是否存在
  if [ ! -f "$MANAGER_SCRIPT" ]; then
    error "mcp-remote-agent-manager.sh 不存在: $MANAGER_SCRIPT"
    exit 1
  fi
  
  # 确保 mcp-remote-agent-manager.sh 有执行权限
  chmod +x "$MANAGER_SCRIPT"
  
  # 检查是否已安装
  if crontab -l 2>/dev/null | grep -q "$CRON_TAG"; then
    warn "自启动已配置，跳过安装"
    return 0
  fi
  
  # 添加到 crontab
  (crontab -l 2>/dev/null; echo "@reboot $MANAGER_SCRIPT $CRON_TAG") | crontab -
  
  if [ $? -eq 0 ]; then
    info "自启动配置成功！"
    info "下次系统启动时将自动运行 mcp-remote-agent"
    info "当前 crontab:"
    crontab -l | grep "$CRON_TAG"
  else
    error "自启动配置失败"
    exit 1
  fi
}

uninstall() {
  info "卸载自启动配置..."
  
  if ! crontab -l 2>/dev/null | grep -q "$CRON_TAG"; then
    warn "自启动未配置，跳过卸载"
    return 0
  fi
  
  # 从 crontab 中移除
  crontab -l 2>/dev/null | grep -v "$CRON_TAG" | crontab -
  
  if [ $? -eq 0 ]; then
    info "自启动配置已移除"
  else
    error "自启动配置移除失败"
    exit 1
  fi
}

status() {
  echo "=== mcp-remote-agent 自启动状态 ==="
  echo ""
  
  # 检查 crontab
  if crontab -l 2>/dev/null | grep -q "$CRON_TAG"; then
    info "自启动: 已配置"
    echo "Crontab 条目:"
    crontab -l | grep "$CRON_TAG"
  else
    warn "自启动: 未配置"
  fi
  
  echo ""
  
  # 检查进程状态
  if pgrep -f "node server.js" > /dev/null; then
    info "服务状态: 运行中"
    echo "进程信息:"
    ps aux | grep "node server.js" | grep -v grep
  else
    warn "服务状态: 未运行"
  fi
  
  echo ""
  
  # 检查端口监听
  if ss -tlnp 2>/dev/null | grep -q ":3183 "; then
    info "端口 3183: 正在监听"
  else
    warn "端口 3183: 未监听"
  fi
}

case "${1:-status}" in
  install)
    install
    ;;
  uninstall)
    uninstall
    ;;
  status)
    status
    ;;
  *)
    echo "用法: $0 [install|uninstall|status]"
    echo ""
    echo "命令:"
    echo "  install   - 安装自启动配置"
    echo "  uninstall - 卸载自启动配置"
    echo "  status    - 查看状态（默认）"
    exit 1
    ;;
esac
