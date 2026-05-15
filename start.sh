#!/bin/bash

# ===================== 项目配置（根据你的项目修改）=====================
# 项目根目录（你提供的路径）
PROJECT_DIR="/Users/xiaofeng.zhao/myherness"
# 启动命令（示例：npm/yarn/python/java，根据你的项目修改）
# 前端项目(React/Vue/Next)：START_CMD="npm run start"
# Python项目：START_CMD="python3 main.py"
# Java项目：START_CMD="java -jar target/app.jar"
START_CMD="npm run start"
# 日志输出文件
LOG_FILE="$PROJECT_DIR/start.log"
# =====================================================================

echo "=============================================="
echo "          项目启动脚本 - myherness"
echo "=============================================="
echo "项目目录：$PROJECT_DIR"
echo "启动命令：$START_CMD"
echo "日志文件：$LOG_FILE"
echo "=============================================="

# 1. 检查项目目录是否存在
if [ ! -d "$PROJECT_DIR" ]; then
    echo "❌ 错误：项目目录不存在！请检查路径是否正确"
    exit 1
fi

# 2. 进入项目目录
cd "$PROJECT_DIR" || {
    echo "❌ 错误：无法进入项目目录"
    exit 1
}

echo "✅ 已进入项目目录"

# 3. 后台启动项目，并输出日志
echo "🚀 正在启动项目，请稍候..."
nohup $START_CMD >> "$LOG_FILE" 2>&1 &

# 4. 获取进程PID
PID=$!
echo "✅ 项目启动成功！进程PID：$PID"
echo "📋 实时日志查看命令：tail -f $LOG_FILE"
echo "🛑 停止项目命令：kill $PID"
echo ""
