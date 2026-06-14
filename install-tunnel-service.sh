#!/bin/bash

# 快速安装 Cloudflare Tunnel 服务
# 用于已有配置的情况

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="myherness"
TUNNEL_NAME="${PROJECT_NAME}-tunnel"
CONFIG_FILE="$PROJECT_DIR/.cloudflare/config.yml"
PLIST_DIR="$HOME/Library/LaunchAgents"
TUNNEL_PLIST="com.${PROJECT_NAME}.tunnel.plist"

echo -e "${BLUE}快速安装 Cloudflare Tunnel 服务...${NC}\n"

# 检查配置文件
if [ ! -f "$CONFIG_FILE" ]; then
    echo -e "${YELLOW}错误: 配置文件不存在${NC}"
    exit 1
fi

# 清理旧服务
if launchctl list | grep -q "com.${PROJECT_NAME}.tunnel"; then
    echo -e "${YELLOW}停止旧服务...${NC}"
    launchctl unload "$PLIST_DIR/$TUNNEL_PLIST" 2>/dev/null || true
    sleep 2
fi

mkdir -p "$PLIST_DIR"
mkdir -p "$PROJECT_DIR/logs"

# 创建服务配置
cat > "$PLIST_DIR/$TUNNEL_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.${PROJECT_NAME}.tunnel</string>

    <key>ProgramArguments</key>
    <array>
        <string>$(which cloudflared)</string>
        <string>tunnel</string>
        <string>--config</string>
        <string>$CONFIG_FILE</string>
        <string>run</string>
        <string>$TUNNEL_NAME</string>
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
    <string>$PROJECT_DIR/logs/tunnel-service.log</string>

    <key>StandardErrorPath</key>
    <string>$PROJECT_DIR/logs/tunnel-service.error.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin</string>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
EOF

echo -e "${GREEN}✓ 服务配置已创建${NC}"

# 启动服务
launchctl load "$PLIST_DIR/$TUNNEL_PLIST"
echo -e "${GREEN}✓ Tunnel 服务已启动${NC}"

sleep 3

# 验证
if launchctl list | grep -q "com.${PROJECT_NAME}.tunnel"; then
    echo -e "${GREEN}✓ Tunnel 服务运行正常${NC}"
else
    echo -e "${YELLOW}⚠ Tunnel 服务可能启动失败，请检查日志${NC}"
fi

echo -e "\n${BLUE}完成！${NC}"
echo -e "查看日志: ${YELLOW}tail -f logs/tunnel-service.log${NC}\n"
