#!/bin/bash

# 远端服务器状态检查脚本
# 功能: 检查服务状态、连接性、资源使用、日志分析

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

PROJECT_NAME="myherness"
LOCAL_PORT=4477
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$SCRIPT_DIR}"
LOG_DIR="$PROJECT_DIR/logs"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  远端服务器状态检查${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "${CYAN}时间: $(date '+%Y-%m-%d %H:%M:%S')${NC}\n"

# 1. 系统信息
echo -e "${YELLOW}[1/8] 系统信息${NC}"
echo -e "${GREEN}主机名:${NC} $(hostname)"
echo -e "${GREEN}操作系统:${NC} $(cat /etc/os-release | grep PRETTY_NAME | cut -d'"' -f2)"
echo -e "${GREEN}内核版本:${NC} $(uname -r)"
echo -e "${GREEN}系统负载:${NC} $(uptime | awk -F'load average:' '{print $2}')"
echo -e "${GREEN}运行时间:${NC} $(uptime -p)"

# 2. Node.js 服务状态
echo -e "\n${YELLOW}[2/8] Node.js 服务状态${NC}"

if sudo systemctl is-active --quiet "$PROJECT_NAME"; then
    echo -e "${GREEN}✓ 服务状态: 运行中${NC}"

    # 获取 PID
    SERVICE_PID=$(sudo systemctl show -p MainPID --value "$PROJECT_NAME")
    echo -e "${GREEN}✓ 进程 PID: $SERVICE_PID${NC}"

    # 获取启动时间
    START_TIME=$(sudo systemctl show -p ActiveEnterTimestamp --value "$PROJECT_NAME")
    echo -e "${GREEN}✓ 启动时间: $START_TIME${NC}"

    # 内存使用
    if [ "$SERVICE_PID" != "0" ]; then
        MEM_USAGE=$(ps -p $SERVICE_PID -o rss= 2>/dev/null | awk '{print $1/1024 "MB"}')
        CPU_USAGE=$(ps -p $SERVICE_PID -o %cpu= 2>/dev/null)
        echo -e "${GREEN}✓ 内存使用: $MEM_USAGE${NC}"
        echo -e "${GREEN}✓ CPU 使用: $CPU_USAGE%${NC}"
    fi
else
    echo -e "${RED}✗ 服务未运行${NC}"
    echo -e "${YELLOW}启动命令: sudo systemctl start $PROJECT_NAME${NC}"
fi

# 检查服务是否开机自启
if sudo systemctl is-enabled --quiet "$PROJECT_NAME" 2>/dev/null; then
    echo -e "${GREEN}✓ 开机自启: 已启用${NC}"
else
    echo -e "${YELLOW}⚠ 开机自启: 未启用${NC}"
fi

# 3. Cloudflare Tunnel 状态
echo -e "\n${YELLOW}[3/8] Cloudflare Tunnel 状态${NC}"

TUNNEL_SERVICE="${PROJECT_NAME}-tunnel"
if sudo systemctl is-active --quiet "$TUNNEL_SERVICE"; then
    echo -e "${GREEN}✓ Tunnel 状态: 运行中${NC}"

    # 获取 PID
    TUNNEL_PID=$(sudo systemctl show -p MainPID --value "$TUNNEL_SERVICE")
    echo -e "${GREEN}✓ 进程 PID: $TUNNEL_PID${NC}"

    # 获取启动时间
    TUNNEL_START=$(sudo systemctl show -p ActiveEnterTimestamp --value "$TUNNEL_SERVICE")
    echo -e "${GREEN}✓ 启动时间: $TUNNEL_START${NC}"

    # 检查连接数
    if [ "$TUNNEL_PID" != "0" ]; then
        CONNECTIONS=$(sudo lsof -p $TUNNEL_PID -i -n | grep ESTABLISHED | wc -l)
        echo -e "${GREEN}✓ 活跃连接: $CONNECTIONS${NC}"
    fi
else
    echo -e "${RED}✗ Tunnel 未运行${NC}"
    echo -e "${YELLOW}启动命令: sudo systemctl start $TUNNEL_SERVICE${NC}"
fi

# 检查是否开机自启
if sudo systemctl is-enabled --quiet "$TUNNEL_SERVICE" 2>/dev/null; then
    echo -e "${GREEN}✓ 开机自启: 已启用${NC}"
else
    echo -e "${YELLOW}⚠ 开机自启: 未启用${NC}"
fi

# 4. 端口监听状态
echo -e "\n${YELLOW}[4/8] 端口监听状态${NC}"

if lsof -ti:$LOCAL_PORT > /dev/null 2>&1; then
    PORT_PID=$(lsof -ti:$LOCAL_PORT | head -1)
    PORT_PROCESS=$(ps -p $PORT_PID -o comm= 2>/dev/null || echo "unknown")
    echo -e "${GREEN}✓ 端口 $LOCAL_PORT: 监听中${NC}"
    echo -e "${GREEN}  进程: $PORT_PROCESS (PID: $PORT_PID)${NC}"
else
    echo -e "${RED}✗ 端口 $LOCAL_PORT: 未监听${NC}"
fi

# 5. 网络连通性测试
echo -e "\n${YELLOW}[5/8] 网络连通性测试${NC}"

# 测试本地服务
echo -e "${CYAN}测试本地服务...${NC}"
if curl -s --max-time 5 http://localhost:$LOCAL_PORT/api/health > /dev/null 2>&1; then
    echo -e "${GREEN}✓ 本地服务响应正常${NC}"
    RESPONSE=$(curl -s http://localhost:$LOCAL_PORT/api/health)
    echo -e "${GREEN}  响应: $RESPONSE${NC}"
else
    echo -e "${RED}✗ 本地服务无响应${NC}"
fi

# 测试 Cloudflare 连接
echo -e "\n${CYAN}测试 Cloudflare 连接...${NC}"
if curl -s --max-time 5 https://api.cloudflare.com > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Cloudflare API 可达${NC}"
else
    echo -e "${RED}✗ Cloudflare API 不可达${NC}"
fi

# 6. 资源使用统计
echo -e "\n${YELLOW}[6/8] 系统资源使用${NC}"

# CPU
CPU_USAGE=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | cut -d'%' -f1)
echo -e "${GREEN}CPU 使用率:${NC} $CPU_USAGE%"

# 内存
MEM_TOTAL=$(free -h | awk '/^Mem:/ {print $2}')
MEM_USED=$(free -h | awk '/^Mem:/ {print $3}')
MEM_PERCENT=$(free | awk '/^Mem:/ {printf "%.1f", $3/$2*100}')
echo -e "${GREEN}内存使用:${NC} $MEM_USED / $MEM_TOTAL ($MEM_PERCENT%)"

# 磁盘
DISK_USAGE=$(df -h "$PROJECT_DIR" | awk 'NR==2 {print $5}')
DISK_AVAIL=$(df -h "$PROJECT_DIR" | awk 'NR==2 {print $4}')
echo -e "${GREEN}磁盘使用:${NC} $DISK_USAGE (可用: $DISK_AVAIL)"

# 7. 日志文件状态
echo -e "\n${YELLOW}[7/8] 日志文件状态${NC}"

if [ -d "$LOG_DIR" ]; then
    echo -e "${GREEN}日志目录:${NC} $LOG_DIR"

    # Node.js 日志
    if [ -f "$LOG_DIR/node-service.log" ]; then
        NODE_LOG_SIZE=$(du -h "$LOG_DIR/node-service.log" | cut -f1)
        NODE_LOG_LINES=$(wc -l < "$LOG_DIR/node-service.log")
        echo -e "${GREEN}  • node-service.log:${NC} $NODE_LOG_SIZE ($NODE_LOG_LINES 行)"
    fi

    if [ -f "$LOG_DIR/node-service.error.log" ]; then
        NODE_ERR_SIZE=$(du -h "$LOG_DIR/node-service.error.log" | cut -f1)
        NODE_ERR_LINES=$(wc -l < "$LOG_DIR/node-service.error.log")
        echo -e "${GREEN}  • node-service.error.log:${NC} $NODE_ERR_SIZE ($NODE_ERR_LINES 行)"
    fi

    # Tunnel 日志
    if [ -f "$LOG_DIR/tunnel-service.log" ]; then
        TUNNEL_LOG_SIZE=$(du -h "$LOG_DIR/tunnel-service.log" | cut -f1)
        TUNNEL_LOG_LINES=$(wc -l < "$LOG_DIR/tunnel-service.log")
        echo -e "${GREEN}  • tunnel-service.log:${NC} $TUNNEL_LOG_SIZE ($TUNNEL_LOG_LINES 行)"
    fi

    if [ -f "$LOG_DIR/tunnel-service.error.log" ]; then
        TUNNEL_ERR_SIZE=$(du -h "$LOG_DIR/tunnel-service.error.log" | cut -f1)
        TUNNEL_ERR_LINES=$(wc -l < "$LOG_DIR/tunnel-service.error.log")
        echo -e "${GREEN}  • tunnel-service.error.log:${NC} $TUNNEL_ERR_SIZE ($TUNNEL_ERR_LINES 行)"
    fi
else
    echo -e "${YELLOW}⚠ 日志目录不存在${NC}"
fi

# 8. 最近错误分析
echo -e "\n${YELLOW}[8/8] 最近错误分析${NC}"

# Node.js 错误
if [ -f "$LOG_DIR/node-service.error.log" ] && [ -s "$LOG_DIR/node-service.error.log" ]; then
    ERROR_COUNT=$(wc -l < "$LOG_DIR/node-service.error.log")
    if [ "$ERROR_COUNT" -gt 0 ]; then
        echo -e "${YELLOW}⚠ Node.js 错误日志有 $ERROR_COUNT 行${NC}"
        echo -e "${CYAN}最近 5 条错误:${NC}"
        tail -5 "$LOG_DIR/node-service.error.log" | sed 's/^/  /'
    else
        echo -e "${GREEN}✓ Node.js 无错误日志${NC}"
    fi
else
    echo -e "${GREEN}✓ Node.js 无错误日志${NC}"
fi

# Tunnel 错误
echo ""
if [ -f "$LOG_DIR/tunnel-service.error.log" ] && [ -s "$LOG_DIR/tunnel-service.error.log" ]; then
    TUNNEL_ERROR_COUNT=$(wc -l < "$LOG_DIR/tunnel-service.error.log")
    if [ "$TUNNEL_ERROR_COUNT" -gt 0 ]; then
        echo -e "${YELLOW}⚠ Tunnel 错误日志有 $TUNNEL_ERROR_COUNT 行${NC}"
        echo -e "${CYAN}最近 5 条错误:${NC}"
        tail -5 "$LOG_DIR/tunnel-service.error.log" | sed 's/^/  /'
    else
        echo -e "${GREEN}✓ Tunnel 无错误日志${NC}"
    fi
else
    echo -e "${GREEN}✓ Tunnel 无错误日志${NC}"
fi

# 检查 Tunnel 连接状态
echo -e "\n${CYAN}Tunnel 连接状态:${NC}"
if [ -f "$LOG_DIR/tunnel-service.log" ]; then
    REGISTERED=$(grep -c "Registered tunnel connection" "$LOG_DIR/tunnel-service.log" 2>/dev/null || echo "0")
    if [ "$REGISTERED" -gt 0 ]; then
        echo -e "${GREEN}✓ 已建立 $REGISTERED 个 Tunnel 连接${NC}"

        # 显示最新的连接信息
        echo -e "${CYAN}最近的连接:${NC}"
        grep "Registered tunnel connection" "$LOG_DIR/tunnel-service.log" | tail -3 | while read line; do
            LOCATION=$(echo "$line" | grep -oP 'location=\K[^ ]+' || echo "unknown")
            PROTOCOL=$(echo "$line" | grep -oP 'protocol=\K[^ ]+' || echo "unknown")
            echo -e "  ${GREEN}• Location: $LOCATION, Protocol: $PROTOCOL${NC}"
        done

        # 检查临时域名
        TEMP_DOMAIN=$(grep -oP 'https://[^/]+\.trycloudflare\.com' "$LOG_DIR/tunnel-service.log" | tail -1)
        if [ -n "$TEMP_DOMAIN" ]; then
            echo -e "\n${GREEN}临时域名:${NC} $TEMP_DOMAIN"
        fi
    else
        echo -e "${YELLOW}⚠ 未找到 Tunnel 连接记录${NC}"
    fi
fi

# 总结
echo -e "\n${BLUE}========================================${NC}"
echo -e "${BLUE}  检查完成${NC}"
echo -e "${BLUE}========================================${NC}"

# 判断整体状态
NODE_OK=$(sudo systemctl is-active --quiet "$PROJECT_NAME" && echo "1" || echo "0")
TUNNEL_OK=$(sudo systemctl is-active --quiet "$TUNNEL_SERVICE" && echo "1" || echo "0")
PORT_OK=$(lsof -ti:$LOCAL_PORT > /dev/null 2>&1 && echo "1" || echo "0")

if [ "$NODE_OK" = "1" ] && [ "$TUNNEL_OK" = "1" ] && [ "$PORT_OK" = "1" ]; then
    echo -e "\n${GREEN}✓ 所有服务运行正常${NC}"
else
    echo -e "\n${YELLOW}⚠ 部分服务存在问题${NC}"
    [ "$NODE_OK" = "0" ] && echo -e "  ${RED}• Node.js 服务未运行${NC}"
    [ "$TUNNEL_OK" = "0" ] && echo -e "  ${RED}• Tunnel 服务未运行${NC}"
    [ "$PORT_OK" = "0" ] && echo -e "  ${RED}• 端口未监听${NC}"
fi

echo -e "\n${YELLOW}常用命令:${NC}"
echo -e "  • 查看实时日志: ${CYAN}./remote-logs.sh${NC}"
echo -e "  • 重启服务: ${CYAN}sudo systemctl restart $PROJECT_NAME${NC}"
echo -e "  • 重启 Tunnel: ${CYAN}sudo systemctl restart $TUNNEL_SERVICE${NC}"
echo -e "  • 清理服务: ${CYAN}./remote-cleanup.sh${NC}"
echo -e "\n"
