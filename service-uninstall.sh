#!/bin/bash

# 系统服务卸载脚本
# 用途：完全卸载系统服务，清理配置文件

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="myherness"
LOCAL_PORT=4477

PLIST_DIR="$HOME/Library/LaunchAgents"
NODE_PLIST="com.${PROJECT_NAME}.node.plist"
TUNNEL_PLIST="com.${PROJECT_NAME}.tunnel.plist"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  系统服务卸载向导${NC}"
echo -e "${BLUE}========================================${NC}\n"

echo -e "${YELLOW}此操作将:${NC}"
echo -e "  1. 停止并卸载所有服务"
echo -e "  2. 删除 launchd 配置文件"
echo -e "  3. 清理服务日志文件"
echo -e "\n${RED}注意: Cloudflare Tunnel 配置将保留${NC}"
echo -e "${YELLOW}如需删除 Tunnel，请手动执行:${NC}"
echo -e "  cloudflared tunnel delete $PROJECT_NAME-tunnel\n"

read -p "确认卸载? [y/N]: " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}已取消${NC}"
    exit 0
fi

echo -e "\n${YELLOW}[1/4] 停止服务...${NC}"

# 停止 Tunnel 服务
if launchctl list | grep -q "com.${PROJECT_NAME}.tunnel"; then
    launchctl unload "$PLIST_DIR/$TUNNEL_PLIST" 2>/dev/null || true
    echo -e "${GREEN}✓ Cloudflare Tunnel 服务已停止${NC}"
else
    echo -e "${YELLOW}Cloudflare Tunnel 服务未运行${NC}"
fi

# 停止 Node.js 服务
if launchctl list | grep -q "com.${PROJECT_NAME}.node"; then
    launchctl unload "$PLIST_DIR/$NODE_PLIST" 2>/dev/null || true
    echo -e "${GREEN}✓ Node.js 服务已停止${NC}"
else
    echo -e "${YELLOW}Node.js 服务未运行${NC}"
fi

# 清理残留进程
if lsof -ti:$LOCAL_PORT > /dev/null 2>&1; then
    echo -e "${YELLOW}清理残留进程...${NC}"
    lsof -ti:$LOCAL_PORT | xargs kill -9 2>/dev/null || true
fi

echo -e "\n${YELLOW}[2/4] 删除服务配置文件...${NC}"

# 删除 plist 文件
if [ -f "$PLIST_DIR/$NODE_PLIST" ]; then
    rm -f "$PLIST_DIR/$NODE_PLIST"
    echo -e "${GREEN}✓ 已删除 $NODE_PLIST${NC}"
else
    echo -e "${YELLOW}$NODE_PLIST 不存在${NC}"
fi

if [ -f "$PLIST_DIR/$TUNNEL_PLIST" ]; then
    rm -f "$PLIST_DIR/$TUNNEL_PLIST"
    echo -e "${GREEN}✓ 已删除 $TUNNEL_PLIST${NC}"
else
    echo -e "${YELLOW}$TUNNEL_PLIST 不存在${NC}"
fi

echo -e "\n${YELLOW}[3/4] 清理日志文件...${NC}"
read -p "是否删除日志文件? [y/N]: " DELETE_LOGS
if [[ "$DELETE_LOGS" =~ ^[Yy]$ ]]; then
    if [ -d "$PROJECT_DIR/logs" ]; then
        rm -rf "$PROJECT_DIR/logs"
        echo -e "${GREEN}✓ 日志文件已删除${NC}"
    else
        echo -e "${YELLOW}日志目录不存在${NC}"
    fi
else
    echo -e "${YELLOW}保留日志文件${NC}"
fi

echo -e "\n${YELLOW}[4/4] 验证卸载结果...${NC}"

# 检查服务是否还在运行
if launchctl list | grep -q "com.${PROJECT_NAME}"; then
    echo -e "${RED}✗ 警告: 仍有服务在运行${NC}"
    launchctl list | grep "com.${PROJECT_NAME}"
else
    echo -e "${GREEN}✓ 所有服务已卸载${NC}"
fi

# 检查端口是否释放
if lsof -ti:$LOCAL_PORT > /dev/null 2>&1; then
    echo -e "${RED}✗ 警告: 端口 $LOCAL_PORT 仍被占用${NC}"
else
    echo -e "${GREEN}✓ 端口 $LOCAL_PORT 已释放${NC}"
fi

echo -e "\n${BLUE}========================================${NC}"
echo -e "${GREEN}✓ 服务卸载完成${NC}"
echo -e "${BLUE}========================================${NC}\n"

echo -e "${YELLOW}保留的文件:${NC}"
echo -e "  • Cloudflare 配置: $PROJECT_DIR/.cloudflare/"
echo -e "  • 项目代码: $PROJECT_DIR/"
echo -e "  • Cloudflare 凭证: ~/.cloudflared/"

echo -e "\n${YELLOW}如需完全清理 Cloudflare Tunnel:${NC}"
echo -e "  cloudflared tunnel list"
echo -e "  cloudflared tunnel delete $PROJECT_NAME-tunnel"
echo -e "  rm -rf ~/.cloudflared"
echo -e "\n${YELLOW}如需重新安装服务:${NC}"
echo -e "  ./service-install.sh"
echo ""
