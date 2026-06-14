#!/bin/bash

# 远端服务器日志查看脚本
# 功能: 实时查看、过滤、分析日志

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

PROJECT_NAME="myherness"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$SCRIPT_DIR}"
LOG_DIR="$PROJECT_DIR/logs"

show_usage() {
    echo -e "${BLUE}远端服务器日志查看工具${NC}"
    echo -e "\n${GREEN}用法:${NC}"
    echo -e "  ./remote-logs.sh [选项] [服务类型]"
    echo -e "\n${GREEN}服务类型:${NC}"
    echo -e "  ${YELLOW}node${NC}       - Node.js 服务日志"
    echo -e "  ${YELLOW}tunnel${NC}     - Cloudflare Tunnel 日志"
    echo -e "  ${YELLOW}all${NC}        - 所有日志 (默认)"
    echo -e "\n${GREEN}选项:${NC}"
    echo -e "  ${YELLOW}-f, --follow${NC}    实时跟踪日志 (默认)"
    echo -e "  ${YELLOW}-n N${NC}           显示最近 N 行 (默认: 50)"
    echo -e "  ${YELLOW}-e, --error${NC}     只显示错误日志"
    echo -e "  ${YELLOW}-j, --journal${NC}   使用 journalctl 查看系统日志"
    echo -e "  ${YELLOW}-g PATTERN${NC}      过滤包含 PATTERN 的行"
    echo -e "  ${YELLOW}--analyze${NC}       分析日志统计信息"
    echo -e "\n${GREEN}示例:${NC}"
    echo -e "  ./remote-logs.sh node              # 实时查看 Node.js 日志"
    echo -e "  ./remote-logs.sh tunnel -n 100     # 查看 Tunnel 最近 100 行"
    echo -e "  ./remote-logs.sh -e                # 查看所有错误日志"
    echo -e "  ./remote-logs.sh -g \"ERROR\"        # 过滤包含 ERROR 的日志"
    echo -e "  ./remote-logs.sh --analyze         # 分析日志统计"
    echo ""
}

# 分析日志统计
analyze_logs() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}  日志分析报告${NC}"
    echo -e "${BLUE}========================================${NC}\n"

    # Node.js 日志分析
    if [ -f "$LOG_DIR/node-service.log" ]; then
        echo -e "${YELLOW}Node.js 服务日志分析:${NC}"
        NODE_LOG="$LOG_DIR/node-service.log"

        TOTAL_LINES=$(wc -l < "$NODE_LOG")
        echo -e "  总行数: ${GREEN}$TOTAL_LINES${NC}"

        # 错误统计
        if [ -f "$LOG_DIR/node-service.error.log" ]; then
            ERROR_LINES=$(wc -l < "$LOG_DIR/node-service.error.log")
            echo -e "  错误行数: ${RED}$ERROR_LINES${NC}"
        fi

        # 常见关键词统计
        echo -e "\n  ${CYAN}关键词统计:${NC}"
        echo -n "    ERROR: "
        grep -c "ERROR" "$NODE_LOG" 2>/dev/null || echo "0"
        echo -n "    WARN: "
        grep -c "WARN" "$NODE_LOG" 2>/dev/null || echo "0"
        echo -n "    INFO: "
        grep -c "INFO" "$NODE_LOG" 2>/dev/null || echo "0"

        # API 请求统计
        if grep -q "GET\|POST\|PUT\|DELETE" "$NODE_LOG" 2>/dev/null; then
            echo -e "\n  ${CYAN}API 请求统计:${NC}"
            echo -n "    GET: "
            grep -c "GET" "$NODE_LOG" 2>/dev/null || echo "0"
            echo -n "    POST: "
            grep -c "POST" "$NODE_LOG" 2>/dev/null || echo "0"
        fi

        # 最近活跃时间
        if [ -f "$NODE_LOG" ]; then
            LAST_UPDATE=$(stat -c %y "$NODE_LOG" 2>/dev/null || stat -f "%Sm" "$NODE_LOG" 2>/dev/null)
            echo -e "\n  最后更新: ${GREEN}$LAST_UPDATE${NC}"
        fi
    fi

    # Tunnel 日志分析
    if [ -f "$LOG_DIR/tunnel-service.log" ]; then
        echo -e "\n${YELLOW}Cloudflare Tunnel 日志分析:${NC}"
        TUNNEL_LOG="$LOG_DIR/tunnel-service.log"

        TOTAL_LINES=$(wc -l < "$TUNNEL_LOG")
        echo -e "  总行数: ${GREEN}$TOTAL_LINES${NC}"

        # 连接统计
        CONNECTIONS=$(grep -c "Registered tunnel connection" "$TUNNEL_LOG" 2>/dev/null || echo "0")
        echo -e "  建立连接数: ${GREEN}$CONNECTIONS${NC}"

        # 错误统计
        if [ -f "$LOG_DIR/tunnel-service.error.log" ]; then
            ERROR_LINES=$(wc -l < "$LOG_DIR/tunnel-service.error.log")
            echo -e "  错误行数: ${RED}$ERROR_LINES${NC}"
        fi

        # 连接位置统计
        if grep -q "location=" "$TUNNEL_LOG" 2>/dev/null; then
            echo -e "\n  ${CYAN}连接位置:${NC}"
            grep "location=" "$TUNNEL_LOG" | grep -oP 'location=\K[^ ]+' | sort | uniq -c | while read count location; do
                echo -e "    $location: ${GREEN}$count${NC}"
            done
        fi

        # 临时域名
        TEMP_DOMAIN=$(grep -oP 'https://[^/]+\.trycloudflare\.com' "$TUNNEL_LOG" | tail -1)
        if [ -n "$TEMP_DOMAIN" ]; then
            echo -e "\n  ${CYAN}临时域名:${NC} ${GREEN}$TEMP_DOMAIN${NC}"
        fi

        # 最近活跃时间
        LAST_UPDATE=$(stat -c %y "$TUNNEL_LOG" 2>/dev/null || stat -f "%Sm" "$TUNNEL_LOG" 2>/dev/null)
        echo -e "\n  最后更新: ${GREEN}$LAST_UPDATE${NC}"
    fi

    echo -e "\n${BLUE}========================================${NC}\n"
}

# 查看文件日志
view_file_logs() {
    local service="$1"
    local lines="$2"
    local follow="$3"
    local error_only="$4"
    local pattern="$5"

    case "$service" in
        "node")
            if [ "$error_only" = "true" ]; then
                LOG_FILE="$LOG_DIR/node-service.error.log"
            else
                LOG_FILE="$LOG_DIR/node-service.log"
            fi
            ;;
        "tunnel")
            if [ "$error_only" = "true" ]; then
                LOG_FILE="$LOG_DIR/tunnel-service.error.log"
            else
                LOG_FILE="$LOG_DIR/tunnel-service.log"
            fi
            ;;
        "all")
            if [ "$error_only" = "true" ]; then
                LOG_FILES=("$LOG_DIR/node-service.error.log" "$LOG_DIR/tunnel-service.error.log")
            else
                LOG_FILES=("$LOG_DIR/node-service.log" "$LOG_DIR/tunnel-service.log")
            fi
            ;;
    esac

    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}  查看日志 - $service${NC}"
    echo -e "${BLUE}========================================${NC}\n"

    if [ "$service" = "all" ]; then
        # 检查文件是否存在
        for log in "${LOG_FILES[@]}"; do
            if [ ! -f "$log" ]; then
                echo -e "${YELLOW}⚠ 日志文件不存在: $log${NC}"
            fi
        done

        if [ "$follow" = "true" ]; then
            if [ -n "$pattern" ]; then
                tail -f -n "$lines" "${LOG_FILES[@]}" 2>/dev/null | grep --line-buffered "$pattern" || true
            else
                tail -f -n "$lines" "${LOG_FILES[@]}" 2>/dev/null
            fi
        else
            if [ -n "$pattern" ]; then
                tail -n "$lines" "${LOG_FILES[@]}" 2>/dev/null | grep "$pattern" || true
            else
                tail -n "$lines" "${LOG_FILES[@]}" 2>/dev/null
            fi
        fi
    else
        # 单个日志文件
        if [ ! -f "$LOG_FILE" ]; then
            echo -e "${RED}错误: 日志文件不存在: $LOG_FILE${NC}"
            exit 1
        fi

        if [ "$follow" = "true" ]; then
            if [ -n "$pattern" ]; then
                tail -f -n "$lines" "$LOG_FILE" | grep --line-buffered "$pattern" || true
            else
                tail -f -n "$lines" "$LOG_FILE"
            fi
        else
            if [ -n "$pattern" ]; then
                tail -n "$lines" "$LOG_FILE" | grep "$pattern" || true
            else
                tail -n "$lines" "$LOG_FILE"
            fi
        fi
    fi
}

# 查看 journalctl 日志
view_journal_logs() {
    local service="$1"
    local lines="$2"
    local follow="$3"

    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}  系统日志 - $service${NC}"
    echo -e "${BLUE}========================================${NC}\n"

    case "$service" in
        "node")
            SERVICE_NAME="$PROJECT_NAME"
            ;;
        "tunnel")
            SERVICE_NAME="${PROJECT_NAME}-tunnel"
            ;;
        "all")
            if [ "$follow" = "true" ]; then
                sudo journalctl -u "$PROJECT_NAME" -u "${PROJECT_NAME}-tunnel" -f
            else
                sudo journalctl -u "$PROJECT_NAME" -u "${PROJECT_NAME}-tunnel" -n "$lines"
            fi
            return
            ;;
    esac

    if [ "$follow" = "true" ]; then
        sudo journalctl -u "$SERVICE_NAME" -f
    else
        sudo journalctl -u "$SERVICE_NAME" -n "$lines"
    fi
}

# 解析参数
SERVICE="all"
LINES=50
FOLLOW=true
ERROR_ONLY=false
USE_JOURNAL=false
PATTERN=""
ANALYZE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_usage
            exit 0
            ;;
        -f|--follow)
            FOLLOW=true
            shift
            ;;
        -n)
            LINES="$2"
            shift 2
            ;;
        -e|--error)
            ERROR_ONLY=true
            shift
            ;;
        -j|--journal)
            USE_JOURNAL=true
            shift
            ;;
        -g)
            PATTERN="$2"
            shift 2
            ;;
        --analyze)
            ANALYZE=true
            shift
            ;;
        node|tunnel|all)
            SERVICE="$1"
            shift
            ;;
        *)
            echo -e "${RED}未知选项: $1${NC}"
            show_usage
            exit 1
            ;;
    esac
done

# 执行操作
if [ "$ANALYZE" = "true" ]; then
    analyze_logs
elif [ "$USE_JOURNAL" = "true" ]; then
    view_journal_logs "$SERVICE" "$LINES" "$FOLLOW"
else
    view_file_logs "$SERVICE" "$LINES" "$FOLLOW" "$ERROR_ONLY" "$PATTERN"
fi
