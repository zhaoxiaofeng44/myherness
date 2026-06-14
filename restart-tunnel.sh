#!/bin/bash

# 快速重启 Tunnel 使配置生效

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${YELLOW}重启 Cloudflare Tunnel...${NC}\n"

# 检查是否使用系统服务
if launchctl list | grep -q "com.myherness.tunnel"; then
    echo -e "${YELLOW}检测到系统服务模式${NC}"
    ./service-control.sh restart
else
    echo -e "${YELLOW}检测到临时启动模式${NC}"
    echo -e "${RED}请手动停止当前 Tunnel (Ctrl+C)${NC}"
    echo -e "${YELLOW}然后运行: ./start-tunnel.sh${NC}"
fi
