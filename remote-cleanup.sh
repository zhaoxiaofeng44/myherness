#!/bin/bash

# 远端服务器清理脚本
# 功能: 清理残留进程、日志、停止服务

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

PROJECT_NAME="myherness"
LOCAL_PORT=4477
TUNNEL_NAME="${PROJECT_NAME}-tunnel"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$SCRIPT_DIR}"
LOG_DIR="$PROJECT_DIR/logs"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  远端服务器清理工具${NC}"
echo -e "${BLUE}========================================${NC}\n"

echo -e "${YELLOW}此工具将执行以下操作:${NC}"
echo -e "  1. 停止所有相关系统服务"
echo -e "  2. 清理端口占用和孤立进程"
echo -e "  3. (可选) 清理日志文件"
echo -e "  4. (可选) 删除服务配置"
echo -e "  5. (可选) 删除 Cloudflare Tunnel\n"

read -p "确认执行清理? [y/N]: " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}已取消${NC}"
    exit 0
fi

# 1. 停止系统服务
echo -e "\n${YELLOW}[1/6] 停止系统服务...${NC}"

# 停止 Tunnel 服务
TUNNEL_SERVICE="${PROJECT_NAME}-tunnel"
if sudo systemctl is-active --quiet "$TUNNEL_SERVICE" 2>/dev/null; then
    echo -e "${YELLOW}停止 Tunnel 服务...${NC}"
    sudo systemctl stop "$TUNNEL_SERVICE"
    echo -e "${GREEN}✓ Tunnel 服务已停止${NC}"
else
    echo -e "${YELLOW}Tunnel 服务未运行${NC}"
fi

# 停止 Node.js 服务
if sudo systemctl is-active --quiet "$PROJECT_NAME" 2>/dev/null; then
    echo -e "${YELLOW}停止 Node.js 服务...${NC}"
    sudo systemctl stop "$PROJECT_NAME"
    echo -e "${GREEN}✓ Node.js 服务已停止${NC}"
else
    echo -e "${YELLOW}Node.js 服务未运行${NC}"
fi

sleep 2

# 2. 清理端口占用
echo -e "\n${YELLOW}[2/6] 清理端口占用...${NC}"

if lsof -ti:$LOCAL_PORT > /dev/null 2>&1; then
    echo -e "${YELLOW}端口 $LOCAL_PORT 被占用，正在清理...${NC}"
    PORT_PIDS=$(lsof -ti:$LOCAL_PORT)
    echo -e "  占用进程 PID: $PORT_PIDS"

    # 先尝试优雅停止
    for pid in $PORT_PIDS; do
        kill -TERM $pid 2>/dev/null || true
    done
    sleep 2

    # 强制清理残留
    if lsof -ti:$LOCAL_PORT > /dev/null 2>&1; then
        for pid in $(lsof -ti:$LOCAL_PORT); do
            kill -9 $pid 2>/dev/null || true
        done
    fi

    sleep 1
    if ! lsof -ti:$LOCAL_PORT > /dev/null 2>&1; then
        echo -e "${GREEN}✓ 端口 $LOCAL_PORT 已释放${NC}"
    else
        echo -e "${RED}✗ 端口清理失败，请手动检查${NC}"
    fi
else
    echo -e "${GREEN}✓ 端口 $LOCAL_PORT 无占用${NC}"
fi

# 3. 清理孤立进程
echo -e "\n${YELLOW}[3/6] 清理孤立进程...${NC}"

# 清理 Node 进程
echo -e "  检查 Node.js 进程..."
NODE_PIDS=$(ps aux | grep "[n]ode.*$PROJECT_DIR" | awk '{print $2}' || true)
if [ -n "$NODE_PIDS" ]; then
    echo -e "${YELLOW}  发现孤立进程: $NODE_PIDS${NC}"
    for pid in $NODE_PIDS; do
        kill -9 $pid 2>/dev/null || true
    done
    echo -e "${GREEN}  ✓ Node.js 孤立进程已清理${NC}"
else
    echo -e "${GREEN}  ✓ 无 Node.js 孤立进程${NC}"
fi

# 清理 cloudflared 进程
echo -e "  检查 cloudflared 进程..."
CF_PIDS=$(ps aux | grep "[c]loudflared.*$PROJECT_NAME" | awk '{print $2}' || true)
if [ -n "$CF_PIDS" ]; then
    echo -e "${YELLOW}  发现孤立进程: $CF_PIDS${NC}"
    for pid in $CF_PIDS; do
        kill -9 $pid 2>/dev/null || true
    done
    echo -e "${GREEN}  ✓ cloudflared 孤立进程已清理${NC}"
else
    echo -e "${GREEN}  ✓ 无 cloudflared 孤立进程${NC}"
fi

# 4. 清理日志文件
echo -e "\n${YELLOW}[4/6] 清理日志文件...${NC}"

if [ -d "$LOG_DIR" ]; then
    LOG_SIZE=$(du -sh "$LOG_DIR" 2>/dev/null | awk '{print $1}')
    echo -e "  日志目录大小: ${YELLOW}$LOG_SIZE${NC}"
    read -p "  是否清空日志文件? [y/N]: " CLEAR_LOGS
    if [[ "$CLEAR_LOGS" =~ ^[Yy]$ ]]; then
        > "$LOG_DIR/node-service.log" 2>/dev/null || true
        > "$LOG_DIR/node-service.error.log" 2>/dev/null || true
        > "$LOG_DIR/tunnel-service.log" 2>/dev/null || true
        > "$LOG_DIR/tunnel-service.error.log" 2>/dev/null || true
        echo -e "${GREEN}  ✓ 日志已清空${NC}"
    else
        echo -e "${YELLOW}  保留日志文件${NC}"
    fi

    read -p "  是否删除整个日志目录? [y/N]: " DELETE_LOG_DIR
    if [[ "$DELETE_LOG_DIR" =~ ^[Yy]$ ]]; then
        rm -rf "$LOG_DIR"
        echo -e "${GREEN}  ✓ 日志目录已删除${NC}"
    fi
else
    echo -e "${GREEN}✓ 日志目录不存在${NC}"
fi

# 5. 删除服务配置
echo -e "\n${YELLOW}[5/6] 删除服务配置...${NC}"
read -p "是否删除 systemd 服务配置? [y/N]: " DELETE_SERVICE

if [[ "$DELETE_SERVICE" =~ ^[Yy]$ ]]; then
    # 禁用服务
    if sudo systemctl is-enabled --quiet "$PROJECT_NAME" 2>/dev/null; then
        sudo systemctl disable "$PROJECT_NAME" 2>/dev/null || true
    fi
    if sudo systemctl is-enabled --quiet "$TUNNEL_SERVICE" 2>/dev/null; then
        sudo systemctl disable "$TUNNEL_SERVICE" 2>/dev/null || true
    fi

    # 删除服务文件
    SERVICE_FILE="/etc/systemd/system/${PROJECT_NAME}.service"
    TUNNEL_SERVICE_FILE="/etc/systemd/system/${TUNNEL_SERVICE}.service"

    if [ -f "$SERVICE_FILE" ]; then
        sudo rm -f "$SERVICE_FILE"
        echo -e "${GREEN}✓ Node.js 服务配置已删除${NC}"
    fi

    if [ -f "$TUNNEL_SERVICE_FILE" ]; then
        sudo rm -f "$TUNNEL_SERVICE_FILE"
        echo -e "${GREEN}✓ Tunnel 服务配置已删除${NC}"
    fi

    # 重新加载 systemd
    sudo systemctl daemon-reload
    echo -e "${GREEN}✓ systemd 已重新加载${NC}"
else
    echo -e "${YELLOW}保留服务配置${NC}"
fi

# 6. 删除 Cloudflare Tunnel
echo -e "\n${YELLOW}[6/6] 清理 Cloudflare Tunnel...${NC}"
read -p "是否删除 Cloudflare Tunnel? [y/N]: " DELETE_TUNNEL

if [[ "$DELETE_TUNNEL" =~ ^[Yy]$ ]]; then
    if command -v cloudflared &> /dev/null; then
        if cloudflared tunnel list 2>/dev/null | grep -q "$TUNNEL_NAME"; then
            echo -e "${YELLOW}删除 Tunnel: $TUNNEL_NAME${NC}"

            # 删除 DNS 路由
            read -p "是否同时删除 DNS 路由? [y/N]: " DELETE_DNS
            if [[ "$DELETE_DNS" =~ ^[Yy]$ ]]; then
                cloudflared tunnel route dns --delete "$TUNNEL_NAME" 2>/dev/null || echo -e "${YELLOW}⚠ DNS 路由删除失败${NC}"
            fi

            # 删除 Tunnel
            cloudflared tunnel delete "$TUNNEL_NAME" 2>/dev/null || echo -e "${YELLOW}⚠ Tunnel 删除失败，可能需要手动删除${NC}"
            echo -e "${GREEN}✓ Tunnel 已删除${NC}"
        else
            echo -e "${YELLOW}Tunnel 不存在${NC}"
        fi

        read -p "是否删除 Cloudflare 配置文件? [y/N]: " DELETE_CF_CONFIG
        if [[ "$DELETE_CF_CONFIG" =~ ^[Yy]$ ]]; then
            [ -d "$PROJECT_DIR/.cloudflare" ] && rm -rf "$PROJECT_DIR/.cloudflare"
            read -p "是否删除 ~/.cloudflared 目录? [y/N]: " DELETE_CF_HOME
            if [[ "$DELETE_CF_HOME" =~ ^[Yy]$ ]]; then
                [ -d "$HOME/.cloudflared" ] && rm -rf "$HOME/.cloudflared"
                echo -e "${GREEN}✓ Cloudflare 配置已完全删除${NC}"
            else
                echo -e "${GREEN}✓ 项目配置已删除，保留 ~/.cloudflared${NC}"
            fi
        fi
    else
        echo -e "${YELLOW}cloudflared 未安装，跳过${NC}"
    fi
else
    echo -e "${YELLOW}保留 Cloudflare Tunnel${NC}"
fi

# 验证清理结果
echo -e "\n${BLUE}========================================${NC}"
echo -e "${BLUE}  验证清理结果${NC}"
echo -e "${BLUE}========================================${NC}\n"

# 检查服务
if sudo systemctl is-active --quiet "$PROJECT_NAME" 2>/dev/null || sudo systemctl is-active --quiet "$TUNNEL_SERVICE" 2>/dev/null; then
    echo -e "${RED}✗ 仍有服务在运行${NC}"
    sudo systemctl list-units --type=service | grep "$PROJECT_NAME"
else
    echo -e "${GREEN}✓ 所有服务已停止${NC}"
fi

# 检查端口
if lsof -ti:$LOCAL_PORT > /dev/null 2>&1; then
    echo -e "${RED}✗ 端口 $LOCAL_PORT 仍被占用${NC}"
    lsof -ti:$LOCAL_PORT
else
    echo -e "${GREEN}✓ 端口 $LOCAL_PORT 已释放${NC}"
fi

# 检查进程
REMAINING_PROCS=$(ps aux | grep -E "[n]ode.*$PROJECT_DIR|[c]loudflared.*$PROJECT_NAME" | wc -l)
if [ "$REMAINING_PROCS" -gt 0 ]; then
    echo -e "${RED}✗ 仍有 $REMAINING_PROCS 个相关进程在运行${NC}"
    ps aux | grep -E "[n]ode.*$PROJECT_DIR|[c]loudflared.*$PROJECT_NAME"
else
    echo -e "${GREEN}✓ 所有相关进程已清理${NC}"
fi

# 完成
echo -e "\n${BLUE}========================================${NC}"
echo -e "${GREEN}✓ 清理完成${NC}"
echo -e "${BLUE}========================================${NC}\n"

echo -e "${YELLOW}保留的文件:${NC}"
[ -d "$PROJECT_DIR/.cloudflare" ] && echo -e "  • Cloudflare 配置: $PROJECT_DIR/.cloudflare/"
[ -d "$LOG_DIR" ] && echo -e "  • 日志目录: $LOG_DIR/"
[ -f "/etc/systemd/system/${PROJECT_NAME}.service" ] && echo -e "  • Node.js 服务: /etc/systemd/system/${PROJECT_NAME}.service"
[ -f "/etc/systemd/system/${TUNNEL_SERVICE}.service" ] && echo -e "  • Tunnel 服务: /etc/systemd/system/${TUNNEL_SERVICE}.service"
[ -d "$HOME/.cloudflared" ] && echo -e "  • Cloudflare 凭证: ~/.cloudflared/"

echo -e "\n${YELLOW}重新部署:${NC}"
echo -e "  ./remote-setup-service.sh      # 安装本地服务"
echo -e "  ./remote-setup-cloudflare.sh   # 配置 Cloudflare Tunnel"
echo ""
