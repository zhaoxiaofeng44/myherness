#!/bin/bash

# 快速启动脚本 - 启动项目和 Cloudflare Tunnel
set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

PROJECT_NAME="myherness"
LOCAL_PORT=4477
TUNNEL_NAME="${PROJECT_NAME}-tunnel"
CONFIG_FILE=".cloudflare/config.yml"

echo -e "${GREEN}启动 $PROJECT_NAME 服务...${NC}"

# 检查配置文件是否存在
if [ ! -f "$CONFIG_FILE" ]; then
    echo -e "${RED}错误: 配置文件不存在${NC}"
    echo -e "${YELLOW}请先运行 ./deploy.sh 进行初始化配置${NC}"
    exit 1
fi

# 检查是否已经在运行
if lsof -ti:$LOCAL_PORT > /dev/null 2>&1; then
    echo -e "${YELLOW}警告: 端口 $LOCAL_PORT 已被占用${NC}"
    read -p "是否停止现有服务并重启? [y/N]: " RESTART
    if [[ "$RESTART" =~ ^[Yy]$ ]]; then
        echo -e "${YELLOW}停止现有服务...${NC}"
        lsof -ti:$LOCAL_PORT | xargs kill -9 2>/dev/null || true
        sleep 2
    else
        echo -e "${RED}已取消${NC}"
        exit 1
    fi
fi

# 启动 Node.js 服务
echo -e "${YELLOW}[1/2] 启动 Node.js 服务...${NC}"
npm start > server.log 2>&1 &
NODE_PID=$!
echo -e "${GREEN}✓ Node.js 服务已启动 (PID: $NODE_PID)${NC}"

# 等待服务启动
echo -e "${YELLOW}等待服务就绪...${NC}"
for i in {1..10}; do
    if curl -s http://localhost:$LOCAL_PORT/api/health > /dev/null 2>&1; then
        echo -e "${GREEN}✓ 服务健康检查通过${NC}"
        break
    fi
    if [ $i -eq 10 ]; then
        echo -e "${RED}错误: 服务启动超时${NC}"
        echo -e "${YELLOW}查看日志: tail -f server.log${NC}"
        exit 1
    fi
    sleep 1
done

# 启动 Cloudflare Tunnel
echo -e "\n${YELLOW}[2/2] 启动 Cloudflare Tunnel...${NC}"
echo -e "${GREEN}服务已准备就绪！${NC}"
echo -e "${YELLOW}按 Ctrl+C 停止服务${NC}\n"

# 前台运行 tunnel（这样可以看到 URL）
cloudflared tunnel --config "$CONFIG_FILE" run "$TUNNEL_NAME"
