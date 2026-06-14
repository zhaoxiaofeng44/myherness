#!/bin/bash

# 系统清理脚本
# 功能：深度清理所有残留进程、文件和配置
# 用途：解决服务冲突、端口占用等问题

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="myherness"
LOCAL_PORT=4477
TUNNEL_NAME="${PROJECT_NAME}-tunnel"

PLIST_DIR="$HOME/Library/LaunchAgents"
NODE_PLIST="com.${PROJECT_NAME}.node.plist"
TUNNEL_PLIST="com.${PROJECT_NAME}.tunnel.plist"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  系统深度清理工具${NC}"
echo -e "${BLUE}========================================${NC}\n"

echo -e "${YELLOW}此工具将执行以下操作:${NC}"
echo -e "  1. 停止所有相关系统服务"
echo -e "  2. 清理端口占用和孤立进程"
echo -e "  3. 清理临时文件和日志"
echo -e "  4. (可选) 删除服务配置"
echo -e "  5. (可选) 删除 Cloudflare Tunnel\n"

read -p "确认执行清理? [y/N]: " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}已取消${NC}"
    exit 0
fi

# 1. 停止系统服务
echo -e "\n${YELLOW}[1/6] 停止系统服务...${NC}"

if launchctl list | grep -q "com.${PROJECT_NAME}.tunnel"; then
    echo -e "${YELLOW}停止 Tunnel 服务...${NC}"
    launchctl unload "$PLIST_DIR/$TUNNEL_PLIST" 2>/dev/null || true
    echo -e "${GREEN}✓ Tunnel 服务已停止${NC}"
else
    echo -e "${YELLOW}Tunnel 服务未运行${NC}"
fi

if launchctl list | grep -q "com.${PROJECT_NAME}.node"; then
    echo -e "${YELLOW}停止 Node.js 服务...${NC}"
    launchctl unload "$PLIST_DIR/$NODE_PLIST" 2>/dev/null || true
    echo -e "${GREEN}✓ Node.js 服务已停止${NC}"
else
    echo -e "${YELLOW}Node.js 服务未运行${NC}"
fi

sleep 2

# 2. 清理端口占用
echo -e "\n${YELLOW}[2/6] 清理端口占用...${NC}"

if lsof -ti:$LOCAL_PORT > /dev/null 2>&1; then
    echo -e "${YELLOW}端口 $LOCAL_PORT 被占用，正在清理...${NC}"
    local port_pids=$(lsof -ti:$LOCAL_PORT)
    echo -e "  占用进程 PID: $port_pids"

    # 先尝试优雅停止
    echo "$port_pids" | xargs kill -TERM 2>/dev/null || true
    sleep 2

    # 强制停止残留进程
    if lsof -ti:$LOCAL_PORT > /dev/null 2>&1; then
        lsof -ti:$LOCAL_PORT | xargs kill -9 2>/dev/null || true
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
local node_pids=$(ps aux | grep "[n]ode.*$PROJECT_DIR" | awk '{print $2}')
if [ -n "$node_pids" ]; then
    echo -e "${YELLOW}  发现孤立进程: $node_pids${NC}"
    echo "$node_pids" | xargs kill -9 2>/dev/null || true
    echo -e "${GREEN}  ✓ Node.js 孤立进程已清理${NC}"
else
    echo -e "${GREEN}  ✓ 无 Node.js 孤立进程${NC}"
fi

# 清理 cloudflared 进程
echo -e "  检查 cloudflared 进程..."
local cf_pids=$(ps aux | grep "[c]loudflared.*$PROJECT_NAME" | awk '{print $2}')
if [ -n "$cf_pids" ]; then
    echo -e "${YELLOW}  发现孤立进程: $cf_pids${NC}"
    echo "$cf_pids" | xargs kill -9 2>/dev/null || true
    echo -e "${GREEN}  ✓ cloudflared 孤立进程已清理${NC}"
else
    echo -e "${GREEN}  ✓ 无 cloudflared 孤立进程${NC}"
fi

# 4. 清理临时文件
echo -e "\n${YELLOW}[4/6] 清理临时文件...${NC}"

# 清理 PID 文件
if ls "$PROJECT_DIR"/*.pid > /dev/null 2>&1; then
    rm -f "$PROJECT_DIR"/*.pid
    echo -e "${GREEN}✓ PID 文件已清理${NC}"
fi

# 清理日志
if [ -d "$PROJECT_DIR/logs" ]; then
    local log_size=$(du -sh "$PROJECT_DIR/logs" 2>/dev/null | awk '{print $1}')
    echo -e "  日志目录大小: ${YELLOW}$log_size${NC}"
    read -p "  是否清空日志文件? [y/N]: " CLEAR_LOGS
    if [[ "$CLEAR_LOGS" =~ ^[Yy]$ ]]; then
        > "$PROJECT_DIR/logs/node-service.log" 2>/dev/null || true
        > "$PROJECT_DIR/logs/node-service.error.log" 2>/dev/null || true
        > "$PROJECT_DIR/logs/tunnel-service.log" 2>/dev/null || true
        > "$PROJECT_DIR/logs/tunnel-service.error.log" 2>/dev/null || true
        echo -e "${GREEN}  ✓ 日志已清空${NC}"
    else
        echo -e "${YELLOW}  保留日志文件${NC}"
    fi
fi

# 5. 删除服务配置（可选）
echo -e "\n${YELLOW}[5/6] 删除服务配置...${NC}"
read -p "是否删除 launchd 服务配置? [y/N]: " DELETE_PLIST
if [[ "$DELETE_PLIST" =~ ^[Yy]$ ]]; then
    if [ -f "$PLIST_DIR/$NODE_PLIST" ]; then
        rm -f "$PLIST_DIR/$NODE_PLIST"
        echo -e "${GREEN}✓ Node.js 服务配置已删除${NC}"
    fi

    if [ -f "$PLIST_DIR/$TUNNEL_PLIST" ]; then
        rm -f "$PLIST_DIR/$TUNNEL_PLIST"
        echo -e "${GREEN}✓ Tunnel 服务配置已删除${NC}"
    fi
else
    echo -e "${YELLOW}保留服务配置${NC}"
fi

# 6. 删除 Cloudflare Tunnel（可选）
echo -e "\n${YELLOW}[6/6] 清理 Cloudflare Tunnel...${NC}"
read -p "是否删除 Cloudflare Tunnel? [y/N]: " DELETE_TUNNEL
if [[ "$DELETE_TUNNEL" =~ ^[Yy]$ ]]; then
    if command -v cloudflared &> /dev/null; then
        if cloudflared tunnel list 2>/dev/null | grep -q "$TUNNEL_NAME"; then
            echo -e "${YELLOW}删除 Tunnel: $TUNNEL_NAME${NC}"
            cloudflared tunnel delete "$TUNNEL_NAME" 2>/dev/null || echo -e "${YELLOW}⚠ Tunnel 删除失败，可能需要手动删除${NC}"
            echo -e "${GREEN}✓ Tunnel 已删除${NC}"
        else
            echo -e "${YELLOW}Tunnel 不存在${NC}"
        fi

        read -p "是否删除 Cloudflare 配置文件? [y/N]: " DELETE_CF_CONFIG
        if [[ "$DELETE_CF_CONFIG" =~ ^[Yy]$ ]]; then
            [ -d "$PROJECT_DIR/.cloudflare" ] && rm -rf "$PROJECT_DIR/.cloudflare"
            [ -d "$HOME/.cloudflared" ] && rm -rf "$HOME/.cloudflared"
            echo -e "${GREEN}✓ Cloudflare 配置已删除${NC}"
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
if launchctl list | grep -q "com.${PROJECT_NAME}"; then
    echo -e "${RED}✗ 仍有服务在运行:${NC}"
    launchctl list | grep "com.${PROJECT_NAME}"
else
    echo -e "${GREEN}✓ 所有服务已清理${NC}"
fi

# 检查端口
if lsof -ti:$LOCAL_PORT > /dev/null 2>&1; then
    echo -e "${RED}✗ 端口 $LOCAL_PORT 仍被占用${NC}"
else
    echo -e "${GREEN}✓ 端口 $LOCAL_PORT 已释放${NC}"
fi

# 检查进程
local remaining_procs=$(ps aux | grep -E "[n]ode.*$PROJECT_DIR|[c]loudflared.*$PROJECT_NAME" | wc -l | tr -d ' ')
if [ "$remaining_procs" -gt 0 ]; then
    echo -e "${RED}✗ 仍有 $remaining_procs 个相关进程在运行${NC}"
else
    echo -e "${GREEN}✓ 所有相关进程已清理${NC}"
fi

# 完成
echo -e "\n${BLUE}========================================${NC}"
echo -e "${GREEN}✓ 清理完成${NC}"
echo -e "${BLUE}========================================${NC}\n"

echo -e "${YELLOW}保留的文件:${NC}"
[ -d "$PROJECT_DIR/.cloudflare" ] && echo -e "  • Cloudflare 配置: $PROJECT_DIR/.cloudflare/"
[ -d "$PROJECT_DIR/logs" ] && echo -e "  • 日志目录: $PROJECT_DIR/logs/"
[ -f "$PLIST_DIR/$NODE_PLIST" ] && echo -e "  • Node.js 服务配置: $PLIST_DIR/$NODE_PLIST"
[ -f "$PLIST_DIR/$TUNNEL_PLIST" ] && echo -e "  • Tunnel 服务配置: $PLIST_DIR/$TUNNEL_PLIST"

echo -e "\n${YELLOW}重新安装服务:${NC}"
echo -e "  ./setup-service.sh     # 安装本地服务"
echo -e "  ./setup-cloudflare.sh  # 配置 Cloudflare Tunnel"
echo ""
