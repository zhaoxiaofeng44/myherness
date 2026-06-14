#!/bin/bash

# 系统服务控制脚本
# 用途：启动、停止、重启、查看服务状态和日志
# 支持分别控制 Node.js 服务和 Cloudflare Tunnel

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
    echo -e "  ./service-control.sh ${YELLOW}<command> [service]${NC}"
    echo -e "\n${GREEN}命令:${NC}"
    echo -e "  ${YELLOW}status${NC}         - 查看服务状态"
    echo -e "  ${YELLOW}start [service]${NC}  - 启动服务 (node/tunnel/all)"
    echo -e "  ${YELLOW}stop [service]${NC}   - 停止服务 (node/tunnel/all)"
    echo -e "  ${YELLOW}restart [service]${NC} - 重启服务 (node/tunnel/all)"
    echo -e "  ${YELLOW}logs [service]${NC}   - 查看实时日志 (node/tunnel/all)"
    echo -e "  ${YELLOW}cleanup${NC}        - 清理残留进程和文件"
    echo -e "  ${YELLOW}help${NC}           - 显示此帮助信息"
    echo -e "\n${GREEN}示例:${NC}"
    echo -e "  ./service-control.sh start           # 启动所有服务"
    echo -e "  ./service-control.sh stop node       # 只停止 Node.js 服务"
    echo -e "  ./service-control.sh restart tunnel  # 只重启 Tunnel 服务"
    echo -e "  ./service-control.sh logs node       # 查看 Node.js 日志"
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
    local service_type="${1:-all}"
    echo -e "${YELLOW}启动服务 ($service_type)...${NC}\n"

    case "$service_type" in
        "node"|"all")
            if [ ! -f "$PLIST_DIR/$NODE_PLIST" ]; then
                echo -e "${RED}错误: Node.js 服务配置不存在${NC}"
                echo -e "${YELLOW}请先运行 ./setup-service.sh 安装服务${NC}"
                [ "$service_type" = "node" ] && exit 1
            else
                if launchctl list | grep -q "com.${PROJECT_NAME}.node"; then
                    echo -e "${YELLOW}Node.js 服务已在运行${NC}"
                else
                    launchctl load "$PLIST_DIR/$NODE_PLIST"
                    echo -e "${GREEN}✓ Node.js 服务已启动${NC}"
                fi
            fi
            ;;
    esac

    case "$service_type" in
        "tunnel"|"all")
            if [ ! -f "$PLIST_DIR/$TUNNEL_PLIST" ]; then
                echo -e "${YELLOW}⚠ Tunnel 服务配置不存在${NC}"
                echo -e "${YELLOW}运行 ./setup-cloudflare.sh 安装 Tunnel 服务${NC}"
                [ "$service_type" = "tunnel" ] && exit 1
            else
                if launchctl list | grep -q "com.${PROJECT_NAME}.tunnel"; then
                    echo -e "${YELLOW}Cloudflare Tunnel 服务已在运行${NC}"
                else
                    launchctl load "$PLIST_DIR/$TUNNEL_PLIST"
                    echo -e "${GREEN}✓ Cloudflare Tunnel 服务已启动${NC}"
                fi
            fi
            ;;
    esac

    sleep 2
    echo ""
    check_status
}

# 停止服务
stop_service() {
    local service_type="${1:-all}"
    echo -e "${YELLOW}停止服务 ($service_type)...${NC}\n"

    case "$service_type" in
        "tunnel"|"all")
            if launchctl list | grep -q "com.${PROJECT_NAME}.tunnel"; then
                launchctl unload "$PLIST_DIR/$TUNNEL_PLIST" 2>/dev/null || true
                echo -e "${GREEN}✓ Cloudflare Tunnel 服务已停止${NC}"
            else
                echo -e "${YELLOW}Cloudflare Tunnel 服务未运行${NC}"
            fi
            ;;
    esac

    case "$service_type" in
        "node"|"all")
            if launchctl list | grep -q "com.${PROJECT_NAME}.node"; then
                launchctl unload "$PLIST_DIR/$NODE_PLIST" 2>/dev/null || true
                echo -e "${GREEN}✓ Node.js 服务已停止${NC}"
            else
                echo -e "${YELLOW}Node.js 服务未运行${NC}"
            fi
            ;;
    esac

    # 清理可能残留的进程（仅当停止 node 或 all 时）
    if [[ "$service_type" == "node" || "$service_type" == "all" ]]; then
        sleep 1
        if lsof -ti:$LOCAL_PORT > /dev/null 2>&1; then
            echo -e "${YELLOW}清理端口 $LOCAL_PORT 残留进程...${NC}"
            lsof -ti:$LOCAL_PORT | xargs kill -9 2>/dev/null || true
            echo -e "${GREEN}✓ 残留进程已清理${NC}"
        fi
    fi

    sleep 1
    echo -e "\n${GREEN}服务已停止${NC}\n"
}

# 重启服务
restart_service() {
    local service_type="${1:-all}"
    echo -e "${YELLOW}重启服务 ($service_type)...${NC}\n"
    stop_service "$service_type"
    sleep 2
    start_service "$service_type"
}

# 查看日志
view_logs() {
    local log_type="${1:-all}"

    echo -e "${BLUE}======================================${NC}"
    echo -e "${BLUE}  实时日志 (Ctrl+C 退出)${NC}"
    echo -e "${BLUE}======================================${NC}\n"

    case "$log_type" in
        "node")
            if [ -f "$PROJECT_DIR/logs/node-service.log" ]; then
                echo -e "${GREEN}Node.js 服务日志:${NC}\n"
                tail -f "$PROJECT_DIR/logs/node-service.log"
            else
                echo -e "${RED}Node.js 日志文件不存在${NC}"
            fi
            ;;
        "tunnel")
            if [ -f "$PROJECT_DIR/logs/tunnel-service.log" ]; then
                echo -e "${GREEN}Cloudflare Tunnel 日志:${NC}\n"
                tail -f "$PROJECT_DIR/logs/tunnel-service.log"
            else
                echo -e "${RED}Tunnel 日志文件不存在${NC}"
            fi
            ;;
        "all"|*)
            # 同时查看两个日志
            local log_files=()
            [ -f "$PROJECT_DIR/logs/node-service.log" ] && log_files+=("$PROJECT_DIR/logs/node-service.log")
            [ -f "$PROJECT_DIR/logs/tunnel-service.log" ] && log_files+=("$PROJECT_DIR/logs/tunnel-service.log")

            if [ ${#log_files[@]} -eq 0 ]; then
                echo -e "${RED}没有可用的日志文件${NC}"
            else
                tail -f "${log_files[@]}"
            fi
            ;;
    esac
}

# 清理残留
cleanup_residuals() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}  清理残留进程和文件${NC}"
    echo -e "${BLUE}========================================${NC}\n"

    local cleaned=0

    # 1. 清理端口占用
    echo -e "${YELLOW}[1/4] 检查端口占用...${NC}"
    if lsof -ti:$LOCAL_PORT > /dev/null 2>&1; then
        echo -e "${YELLOW}发现端口 $LOCAL_PORT 被占用，正在清理...${NC}"
        lsof -ti:$LOCAL_PORT | xargs kill -9 2>/dev/null || true
        sleep 1
        if ! lsof -ti:$LOCAL_PORT > /dev/null 2>&1; then
            echo -e "${GREEN}✓ 端口已释放${NC}"
            cleaned=1
        else
            echo -e "${RED}✗ 端口清理失败${NC}"
        fi
    else
        echo -e "${GREEN}✓ 端口无占用${NC}"
    fi

    # 2. 清理孤立的 Node 进程
    echo -e "\n${YELLOW}[2/4] 检查孤立的 Node 进程...${NC}"
    local node_pids=$(ps aux | grep "[n]ode.*$PROJECT_DIR" | awk '{print $2}')
    if [ -n "$node_pids" ]; then
        echo -e "${YELLOW}发现孤立进程: $node_pids${NC}"
        echo "$node_pids" | xargs kill -9 2>/dev/null || true
        echo -e "${GREEN}✓ 孤立进程已清理${NC}"
        cleaned=1
    else
        echo -e "${GREEN}✓ 无孤立进程${NC}"
    fi

    # 3. 清理 cloudflared 进程
    echo -e "\n${YELLOW}[3/4] 检查孤立的 cloudflared 进程...${NC}"
    local cf_pids=$(ps aux | grep "[c]loudflared.*$PROJECT_NAME" | awk '{print $2}')
    if [ -n "$cf_pids" ]; then
        echo -e "${YELLOW}发现孤立进程: $cf_pids${NC}"
        echo "$cf_pids" | xargs kill -9 2>/dev/null || true
        echo -e "${GREEN}✓ 孤立进程已清理${NC}"
        cleaned=1
    else
        echo -e "${GREEN}✓ 无孤立进程${NC}"
    fi

    # 4. 清理临时文件
    echo -e "\n${YELLOW}[4/4] 检查临时文件...${NC}"
    local temp_files=0

    # 清理 PID 文件
    if [ -f "$PROJECT_DIR/*.pid" ]; then
        rm -f "$PROJECT_DIR"/*.pid
        temp_files=1
    fi

    # 清理旧日志（可选）
    if [ -d "$PROJECT_DIR/logs" ]; then
        local log_size=$(du -sh "$PROJECT_DIR/logs" 2>/dev/null | awk '{print $1}')
        echo -e "  日志目录大小: ${YELLOW}$log_size${NC}"
        read -p "是否清空日志文件? [y/N]: " CLEAR_LOGS
        if [[ "$CLEAR_LOGS" =~ ^[Yy]$ ]]; then
            > "$PROJECT_DIR/logs/node-service.log" 2>/dev/null || true
            > "$PROJECT_DIR/logs/node-service.error.log" 2>/dev/null || true
            > "$PROJECT_DIR/logs/tunnel-service.log" 2>/dev/null || true
            > "$PROJECT_DIR/logs/tunnel-service.error.log" 2>/dev/null || true
            echo -e "${GREEN}✓ 日志已清空${NC}"
            cleaned=1
        else
            echo -e "${YELLOW}保留日志文件${NC}"
        fi
    else
        echo -e "${GREEN}✓ 无临时文件${NC}"
    fi

    # 总结
    echo -e "\n${BLUE}========================================${NC}"
    if [ $cleaned -eq 1 ]; then
        echo -e "${GREEN}✓ 清理完成${NC}"
    else
        echo -e "${GREEN}✓ 系统干净，无需清理${NC}"
    fi
    echo -e "${BLUE}========================================${NC}\n"
}

# 主逻辑
COMMAND="${1:-help}"
SERVICE="${2:-all}"

case "$COMMAND" in
    "status")
        check_status
        ;;
    "start")
        start_service "$SERVICE"
        ;;
    "stop")
        stop_service "$SERVICE"
        ;;
    "restart")
        restart_service "$SERVICE"
        ;;
    "logs")
        view_logs "$SERVICE"
        ;;
    "cleanup")
        cleanup_residuals
        ;;
    "help"|"")
        show_usage
        ;;
    *)
        echo -e "${RED}错误: 未知命令 '$COMMAND'${NC}\n"
        show_usage
        exit 1
        ;;
esac
