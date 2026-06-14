#!/bin/bash

# 停止服务脚本

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

LOCAL_PORT=4477

echo -e "${YELLOW}停止服务...${NC}"

# 停止 Node.js 服务
if lsof -ti:$LOCAL_PORT > /dev/null 2>&1; then
    echo -e "${YELLOW}停止 Node.js 服务 (端口 $LOCAL_PORT)...${NC}"
    lsof -ti:$LOCAL_PORT | xargs kill -9 2>/dev/null || true
    echo -e "${GREEN}✓ Node.js 服务已停止${NC}"
else
    echo -e "${YELLOW}Node.js 服务未运行${NC}"
fi

# 停止 cloudflared 进程
if pgrep -f cloudflared > /dev/null 2>&1; then
    echo -e "${YELLOW}停止 Cloudflare Tunnel...${NC}"
    pkill -f cloudflared
    echo -e "${GREEN}✓ Cloudflare Tunnel 已停止${NC}"
else
    echo -e "${YELLOW}Cloudflare Tunnel 未运行${NC}"
fi

echo -e "\n${GREEN}所有服务已停止${NC}"
