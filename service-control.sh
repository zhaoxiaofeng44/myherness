#!/bin/bash

# 系统服务控制脚本
# 用途：启动、停止、重启、查看服务状态和日志

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

# 显示使用说明
show_usage() {
    echo -e "${BLUE}系统服务控制脚本${NC}"
    echo -e "\n${GREEN}用法:${NC}"
    echo -e "  ./service-control.sh ${YELLOW}<command>${NC}"
    echo -e "\n${GREEN}命令:${NC}"
    echo -e "  ${YELLOW}status${NC}    - 查看服务状态"
    echo -e "  ${YELLOW}start${NC}     - 启动服务"
    echo -e "  ${YELLOW}stop${NC}      - 停止服务"
    echo -e "  ${YELLOW}restart${NC}   - 重启服务"
    echo -e "  ${YELLOW}logs${NC}      - 查看实时日志"
    echo -e "  ${YELLOW}logs-node${NC} - 只查看 Node.js 日志"
    echo -e "  ${YELLOW}logs-tunnel${NC} - 只查看 Tunnel 日志"
    echo -e "  ${YELLOW}help${NC}      - 显示此帮助信息"
    echo ""
}

# 检查服务状态
check_status() {
    echo -e "${BLUE}======================================${NC}"
    echo -e "${BLUE}  服务状态${NC}"
    echo -e "${BLUE}======================================${NC}\n"

    # 检查 Node.js 服务
    if launchctl list | grep -q "com.${PROJECT_NAME}.node"; then
        NODE_STATUS="${GREEN}✓ 运行中${NC}"
        NODE_PID=$(launchctl list | grep "com.${PROJECT_NAME}.node" | awk '{print $1}')
    else
        NODE_STATUS="${RED}✗ 未运行${NC}"
        NODE_PID="N/A"
    fi

    # 检查 Tunnel 服务
    if launchctl list | grep -q "com.${PROJECT_NAME}.tunnel"; then
        TUNNEL_STATUS="${GREEN}✓ 运行中${NC}"
        TUNNEL_PID=$(launchctl list | grep "com.${PROJECT_NAME}.tunnel" | awk '{print $1}')
    else
        TUNNEL_STATUS="${RED}✗ 未运行${NC}"
        TUNNEL_PID="N/A"
    fi

    # 检查端口
    if lsof -ti:$LOCAL_PORT > /dev/null 2>&1; then
        PORT_STATUS="${GREEN}✓ 监听中${NC}"
        PORT_PID=$(lsof -ti:$LOCAL_PORT)
    else
        PORT_STATUS="${RED}✗ 未监听${NC}"
        PORT_PID="N/A"
    fi

    echo -e "${GREEN}Node.js 服务:${NC}"
    echo -e "  状态: $NODE_STATUS"
    echo -e "  PID: $NODE_PID"
    echo -e "  端口: $LOCAL_PORT ($PORT_STATUS, PID: $PORT_PID)"

    echo -e "\n${GREEN}Cloudflare Tunnel:${NC}"
    echo -e "  状态: $TUNNEL_STATUS"
    echo -e "  PID: $TUNNEL_PID"

    echo -e "\n${GREEN}日志文件:${NC}"
    if [ -f "$PROJECT_DIR/logs/node-service.log" ]; then
        NODE_LOG_SIZE=$(du -h "$PROJECT_DIR/logs/node-service.log" | awk '{print $1}')
        echo -e "  Node.js: $PROJECT_DIR/logs/node-service.log (${YELLOW}$NODE_LOG_SIZE${NC})"
    else
        echo -e "  Node.js: ${YELLOW}日志文件不存在${NC}"
    fi

    if [ -f "$PROJECT_DIR/logs/tunnel-service.log" ]; then
        TUNNEL_LOG_SIZE=$(du -h "$PROJECT_DIR/logs/tunnel-service.log" | awk '{print $1}')
        echo -e "  Tunnel: $PROJECT_DIR/logs/tunnel-service.log (${YELLOW}$TUNNEL_LOG_SIZE${NC})"
    else
        echo -e "  Tunnel: ${YELLOW}日志文件不存在${NC}"
    fi

    echo ""
}

# 启动服务
start_service() {
    echo -e "${YELLOW}启动服务...${NC}\n"

    if [ ! -f "$PLIST_DIR/$NODE_PLIST" ] || [ ! -f "$PLIST_DIR/$TUNNEL_PLIST" ]; then
        echo -e "${RED}错误: 服务配置文件不存在${NC}"
        echo -e "${YELLOW}请先运行 ./service-install.sh 安装服务${NC}"
        exit 1
    fi

    # 启动 Node.js 服务
    if launchctl list | grep -q "com.${PROJECT_NAME}.node"; then
        echo -e "${YELLOW}Node.js 服务已在运行${NC}"
    else
        launchctl load "$PLIST_DIR/$NODE_PLIST"
        echo -e "${GREEN}✓ Node.js 服务已启动${NC}"
    fi

    # 启动 Tunnel 服务
    if launchctl list | grep -q "com.${PROJECT_NAME}.tunnel"; then
        echo -e "${YELLOW}Cloudflare Tunnel 服务已在运行${NC}"
    else
        launchctl load "$PLIST_DIR/$TUNNEL_PLIST"
        echo -e "${GREEN}✓ Cloudflare Tunnel 服务已启动${NC}"
    fi

    sleep 2
    echo ""
    check_status
}

# 停止服务
stop_service() {
    echo -e "${YELLOW}停止服务...${NC}\n"

    # 停止 Tunnel 服务
    if launchctl list | grep -q "com.${PROJECT_NAME}.tunnel"; then
        launchctl unload "$PLIST_DIR/$TUNNEL_PLIST"
        echo -e "${GREEN}✓ Cloudflare Tunnel 服务已停止${NC}"
    else
        echo -e "${YELLOW}Cloudflare Tunnel 服务未运行${NC}"
    fi

    # 停止 Node.js 服务
    if launchctl list | grep -q "com.${PROJECT_NAME}.node"; then
        launchctl unload "$PLIST_DIR/$NODE_PLIST"
        echo -e "${GREEN}✓ Node.js 服务已停止${NC}"
    else
        echo -e "${YELLOW}Node.js 服务未运行${NC}"
    fi

    # 清理可能残留的进程
    if lsof -ti:$LOCAL_PORT > /dev/null 2>&1; then
        echo -e "${YELLOW}清理残留进程...${NC}"
        lsof -ti:$LOCAL_PORT | xargs kill -9 2>/dev/null || true
    fi

    sleep 1
    echo -e "\n${GREEN}服务已停止${NC}\n"
}

# 重启服务
restart_service() {
    echo -e "${YELLOW}重启服务...${NC}\n"
    stop_service
    sleep 2
    start_service
}

# 查看日志
view_logs() {
    local log_type="$1"

    echo -e "${BLUE}======================================${NC}"
    echo -e "${BLUE}  实时日志 (Ctrl+C 退出)${NC}"
    echo -e "${BLUE}======================================${NC}\n"

    case "$log_type" in
        "node")
            if [ -f "$PROJECT_DIR/logs/node-service.log" ]; then
                tail -f "$PROJECT_DIR/logs/node-service.log"
            else
                echo -e "${RED}Node.js 日志文件不存在${NC}"
            fi
            ;;
        "tunnel")
            if [ -f "$PROJECT_DIR/logs/tunnel-service.log" ]; then
                tail -f "$PROJECT_DIR/logs/tunnel-service.log"
            else
                echo -e "${RED}Tunnel 日志文件不存在${NC}"
            fi
            ;;
        *)
            # 同时查看两个日志
            if [ -f "$PROJECT_DIR/logs/node-service.log" ] && [ -f "$PROJECT_DIR/logs/tunnel-service.log" ]; then
                tail -f "$PROJECT_DIR/logs/node-service.log" "$PROJECT_DIR/logs/tunnel-service.log"
            elif [ -f "$PROJECT_DIR/logs/node-service.log" ]; then
                tail -f "$PROJECT_DIR/logs/node-service.log"
            elif [ -f "$PROJECT_DIR/logs/tunnel-service.log" ]; then
                tail -f "$PROJECT_DIR/logs/tunnel-service.log"
            else
                echo -e "${RED}没有可用的日志文件${NC}"
            fi
            ;;
    esac
}

# 主逻辑
case "$1" in
    "status")
        check_status
        ;;
    "start")
        start_service
        ;;
    "stop")
        stop_service
        ;;
    "restart")
        restart_service
        ;;
    "logs")
        view_logs "all"
        ;;
    "logs-node")
        view_logs "node"
        ;;
    "logs-tunnel")
        view_logs "tunnel"
        ;;
    "help"|"")
        show_usage
        ;;
    *)
        echo -e "${RED}错误: 未知命令 '$1'${NC}\n"
        show_usage
        exit 1
        ;;
esac
