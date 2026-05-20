#!/bin/bash
# AgentPort 自启动配置脚本
# 用法: bash setup-autostart-agentport.sh [install|uninstall|status]

set -uo pipefail

DAEMON_DIR="$(cd "$(dirname "$0")" && pwd)"
MANAGER_SCRIPT="$DAEMON_DIR/agentport-manager.sh"
CRON_TAG="# agentport autostart"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

install() {
  info "安装 AgentPort 自启动配置..."

  if [ ! -f "$MANAGER_SCRIPT" ]; then
    error "agentport-manager.sh 不存在: $MANAGER_SCRIPT"
    exit 1
  fi

  chmod +x "$MANAGER_SCRIPT"

  if crontab -l 2>/dev/null | grep -q "$CRON_TAG"; then
    warn "AgentPort 自启动已配置，跳过安装"
    return 0
  fi

  (crontab -l 2>/dev/null; echo "@reboot $MANAGER_SCRIPT $CRON_TAG") | crontab -

  if [ $? -eq 0 ]; then
    info "AgentPort 自启动配置成功"
    crontab -l | grep "$CRON_TAG"
  else
    error "AgentPort 自启动配置失败"
    exit 1
  fi
}

uninstall() {
  info "卸载 AgentPort 自启动配置..."

  if ! crontab -l 2>/dev/null | grep -q "$CRON_TAG"; then
    warn "AgentPort 自启动未配置，跳过卸载"
    return 0
  fi

  crontab -l 2>/dev/null | grep -v "$CRON_TAG" | crontab -

  if [ $? -eq 0 ]; then
    info "AgentPort 自启动配置已移除"
  else
    error "AgentPort 自启动配置移除失败"
    exit 1
  fi
}

status() {
  echo "=== AgentPort 自启动状态 ==="
  echo ""

  if crontab -l 2>/dev/null | grep -q "$CRON_TAG"; then
    info "自启动: 已配置"
    crontab -l | grep "$CRON_TAG"
  else
    warn "自启动: 未配置"
  fi

  echo ""

  if pgrep -f "node server.js" > /dev/null; then
    info "服务状态: 运行中"
    ps aux | grep "node server.js" | grep -v grep
  else
    warn "服务状态: 未运行"
  fi

  echo ""

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
    exit 1
    ;;
esac

