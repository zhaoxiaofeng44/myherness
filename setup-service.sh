#!/bin/bash

# 后台服务安装脚本 - macOS launchd
# 功能：将 Node.js 应用安装为系统服务，开机自启 + 自动保活
# 不包含 Cloudflare 配置，专注于本地服务管理

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# 项目配置
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="myherness"
LOCAL_PORT=4477

# launchd 配置
PLIST_DIR="$HOME/Library/LaunchAgents"
NODE_PLIST="com.${PROJECT_NAME}.node.plist"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  后台服务安装向导${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}项目: $PROJECT_NAME${NC}"
echo -e "${GREEN}目录: $PROJECT_DIR${NC}"
echo -e "${GREEN}端口: $LOCAL_PORT${NC}\n"

# 1. 检查依赖
echo -e "${YELLOW}[1/5] 检查系统依赖...${NC}"

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}错误: 未安装 Node.js${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Node.js: $(node --version)${NC}"

# 检查 npm
if ! command -v npm &> /dev/null; then
    echo -e "${RED}错误: 未安装 npm${NC}"
    exit 1
fi
echo -e "${GREEN}✓ npm: $(npm --version)${NC}"

# 2. 检查项目依赖
echo -e "\n${YELLOW}[2/5] 检查项目依赖...${NC}"
if [ ! -d "$PROJECT_DIR/node_modules" ]; then
    echo -e "${YELLOW}安装 npm 依赖...${NC}"
    cd "$PROJECT_DIR"
    npm install
    echo -e "${GREEN}✓ 依赖安装完成${NC}"
else
    echo -e "${GREEN}✓ 项目依赖已存在${NC}"
fi

# 3. 清理可能存在的旧服务
echo -e "\n${YELLOW}[3/5] 清理旧服务...${NC}"

if launchctl list | grep -q "com.${PROJECT_NAME}.node"; then
    echo -e "${YELLOW}检测到运行中的旧服务，正在停止...${NC}"
    launchctl unload "$PLIST_DIR/$NODE_PLIST" 2>/dev/null || true
    sleep 2
fi

# 清理端口占用
if lsof -ti:$LOCAL_PORT > /dev/null 2>&1; then
    echo -e "${YELLOW}清理端口 $LOCAL_PORT 占用...${NC}"
    lsof -ti:$LOCAL_PORT | xargs kill -9 2>/dev/null || true
    sleep 1
fi

echo -e "${GREEN}✓ 清理完成${NC}"

# 4. 创建 launchd plist 文件
echo -e "\n${YELLOW}[4/5] 创建系统服务配置...${NC}"

mkdir -p "$PLIST_DIR"
mkdir -p "$PROJECT_DIR/logs"

# 获取 Node 路径
NODE_PATH=$(which node)
NPM_PATH=$(which npm)

cat > "$PLIST_DIR/$NODE_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.${PROJECT_NAME}.node</string>

    <key>ProgramArguments</key>
    <array>
        <string>$NPM_PATH</string>
        <string>start</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>Crashed</key>
        <true/>
    </dict>

    <key>StandardOutPath</key>
    <string>$PROJECT_DIR/logs/node-service.log</string>

    <key>StandardErrorPath</key>
    <string>$PROJECT_DIR/logs/node-service.error.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname $NODE_PATH)</string>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
EOF

echo -e "${GREEN}✓ 服务配置文件创建完成${NC}"

# 5. 加载并启动服务
echo -e "\n${YELLOW}[5/5] 启动系统服务...${NC}"

launchctl load "$PLIST_DIR/$NODE_PLIST"
echo -e "${GREEN}✓ Node.js 服务已启动${NC}"

# 验证服务状态
sleep 3

if launchctl list | grep -q "com.${PROJECT_NAME}.node"; then
    echo -e "${GREEN}✓ 服务运行正常${NC}"
else
    echo -e "${RED}✗ 服务启动失败${NC}"
    echo -e "${YELLOW}请检查日志: $PROJECT_DIR/logs/node-service.error.log${NC}"
fi

# 检查端口
if lsof -ti:$LOCAL_PORT > /dev/null 2>&1; then
    echo -e "${GREEN}✓ 端口 $LOCAL_PORT 正常监听${NC}"
else
    echo -e "${YELLOW}⚠ 端口 $LOCAL_PORT 暂未监听，服务可能正在启动${NC}"
fi

# 完成信息
echo -e "\n${BLUE}========================================${NC}"
echo -e "${GREEN}✓ 后台服务安装完成！${NC}"
echo -e "${BLUE}========================================${NC}"

echo -e "\n${GREEN}📊 服务信息:${NC}"
echo -e "  • 项目目录: ${YELLOW}$PROJECT_DIR${NC}"
echo -e "  • 本地端口: ${YELLOW}http://localhost:$LOCAL_PORT${NC}"
echo -e "  • 服务标识: ${YELLOW}com.${PROJECT_NAME}.node${NC}"

echo -e "\n${GREEN}📁 日志文件:${NC}"
echo -e "  • 标准输出: ${YELLOW}$PROJECT_DIR/logs/node-service.log${NC}"
echo -e "  • 错误输出: ${YELLOW}$PROJECT_DIR/logs/node-service.error.log${NC}"

echo -e "\n${GREEN}🎮 管理命令:${NC}"
echo -e "  • 查看状态: ${YELLOW}./service-control.sh status${NC}"
echo -e "  • 停止服务: ${YELLOW}./service-control.sh stop${NC}"
echo -e "  • 启动服务: ${YELLOW}./service-control.sh start${NC}"
echo -e "  • 重启服务: ${YELLOW}./service-control.sh restart${NC}"
echo -e "  • 查看日志: ${YELLOW}./service-control.sh logs${NC}"

echo -e "\n${GREEN}✨ 特性:${NC}"
echo -e "  ✓ 开机自动启动"
echo -e "  ✓ 进程崩溃自动重启"
echo -e "  ✓ 后台静默运行"
echo -e "  ✓ 完整的日志记录"

echo -e "\n${YELLOW}💡 下一步:${NC}"
echo -e "  如需配置外网访问，请运行: ${YELLOW}./setup-cloudflare.sh${NC}"
echo -e "\n"
