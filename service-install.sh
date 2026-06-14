#!/bin/bash

# 系统服务安装脚本 - macOS launchd
# 功能：将项目和 Cloudflare Tunnel 安装为系统服务，开机自启 + 自动保活

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
TUNNEL_NAME="${PROJECT_NAME}-tunnel"
CONFIG_FILE="$PROJECT_DIR/.cloudflare/config.yml"

# launchd 配置
PLIST_DIR="$HOME/Library/LaunchAgents"
NODE_PLIST="com.${PROJECT_NAME}.node.plist"
TUNNEL_PLIST="com.${PROJECT_NAME}.tunnel.plist"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  系统服务安装向导${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}项目: $PROJECT_NAME${NC}"
echo -e "${GREEN}目录: $PROJECT_DIR${NC}\n"

# 1. 检查依赖
echo -e "${YELLOW}[1/7] 检查系统依赖...${NC}"

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

# 检查 cloudflared
if ! command -v cloudflared &> /dev/null; then
    echo -e "${YELLOW}cloudflared 未安装，正在安装...${NC}"
    if ! command -v brew &> /dev/null; then
        echo -e "${RED}错误: 未安装 Homebrew${NC}"
        echo -e "${YELLOW}请先访问 https://brew.sh 安装 Homebrew${NC}"
        exit 1
    fi
    brew install cloudflared
fi
echo -e "${GREEN}✓ cloudflared: $(cloudflared --version | head -1)${NC}"

# 2. 检查项目依赖
echo -e "\n${YELLOW}[2/7] 检查项目依赖...${NC}"
if [ ! -d "$PROJECT_DIR/node_modules" ]; then
    echo -e "${YELLOW}安装 npm 依赖...${NC}"
    cd "$PROJECT_DIR"
    npm install
    echo -e "${GREEN}✓ 依赖安装完成${NC}"
else
    echo -e "${GREEN}✓ 项目依赖已存在${NC}"
fi

# 3. 配置 Cloudflare Tunnel
echo -e "\n${YELLOW}[3/7] 配置 Cloudflare Tunnel...${NC}"

# 检查认证
if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
    echo -e "${YELLOW}需要登录 Cloudflare 账号${NC}"
    echo -e "${YELLOW}请在浏览器中完成授权...${NC}"
    cloudflared tunnel login
    echo -e "${GREEN}✓ 认证完成${NC}"
else
    echo -e "${GREEN}✓ Cloudflare 认证已存在${NC}"
fi

# 检查或创建 Tunnel
EXISTING_TUNNEL=$(cloudflared tunnel list 2>/dev/null | grep -w "$TUNNEL_NAME" || true)
if [ -z "$EXISTING_TUNNEL" ]; then
    echo -e "${YELLOW}创建 Tunnel: $TUNNEL_NAME${NC}"
    cloudflared tunnel create "$TUNNEL_NAME"
    echo -e "${GREEN}✓ Tunnel 创建完成${NC}"
else
    echo -e "${GREEN}✓ Tunnel '$TUNNEL_NAME' 已存在${NC}"
fi

# 获取 Tunnel ID
TUNNEL_ID=$(cloudflared tunnel list 2>/dev/null | grep -w "$TUNNEL_NAME" | awk '{print $1}')
if [ -z "$TUNNEL_ID" ]; then
    echo -e "${RED}错误: 无法获取 Tunnel ID${NC}"
    exit 1
fi
echo -e "${GREEN}Tunnel ID: $TUNNEL_ID${NC}"

# 4. 生成配置文件
echo -e "\n${YELLOW}[4/7] 生成配置文件...${NC}"
mkdir -p "$PROJECT_DIR/.cloudflare"

# 选择域名模式
echo -e "\n${YELLOW}域名配置:${NC}"
echo -e "  ${YELLOW}1) 自动域名 (*.trycloudflare.com) - 无需配置${NC}"
echo -e "  ${YELLOW}2) 自定义域名 - 需要 Cloudflare 托管的域名${NC}"
read -p "选择 [1/2] (默认: 1): " DNS_CHOICE
DNS_CHOICE=${DNS_CHOICE:-1}

if [ "$DNS_CHOICE" = "2" ]; then
    read -p "输入域名 (如 example.com): " DOMAIN
    read -p "输入子域名 (如 app): " SUBDOMAIN
    FULL_DOMAIN="${SUBDOMAIN}.${DOMAIN}"

    # 生成自定义域名配置
    cat > "$CONFIG_FILE" <<EOF
# Cloudflare Tunnel 配置
tunnel: $TUNNEL_ID
credentials-file: $HOME/.cloudflared/$TUNNEL_ID.json

ingress:
  - hostname: $FULL_DOMAIN
    service: http://localhost:$LOCAL_PORT
  - service: http_status:404
EOF

    # 配置 DNS
    echo -e "${YELLOW}配置 DNS 记录...${NC}"
    cloudflared tunnel route dns "$TUNNEL_NAME" "$FULL_DOMAIN" || true
    echo -e "${GREEN}✓ 域名配置完成: https://$FULL_DOMAIN${NC}"
    TUNNEL_URL="https://$FULL_DOMAIN"
else
    # 生成临时域名配置
    cat > "$CONFIG_FILE" <<EOF
# Cloudflare Tunnel 配置 (临时域名模式)
tunnel: $TUNNEL_ID
credentials-file: $HOME/.cloudflared/$TUNNEL_ID.json

ingress:
  - service: http://localhost:$LOCAL_PORT
EOF
    echo -e "${GREEN}✓ 将使用临时域名 (启动后显示)${NC}"
    TUNNEL_URL="临时域名 (启动后自动生成)"
fi

# 5. 创建 launchd plist 文件
echo -e "\n${YELLOW}[5/7] 创建系统服务配置...${NC}"

mkdir -p "$PLIST_DIR"

# Node.js 服务 plist
cat > "$PLIST_DIR/$NODE_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.${PROJECT_NAME}.node</string>

    <key>ProgramArguments</key>
    <array>
        <string>$(which npm)</string>
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
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.nvm/versions/node/$(node --version)/bin</string>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
EOF

echo -e "${GREEN}✓ Node.js 服务配置创建完成${NC}"

# Cloudflare Tunnel 服务 plist
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
</dict>
</plist>
EOF

echo -e "${GREEN}✓ Cloudflare Tunnel 服务配置创建完成${NC}"

# 创建日志目录
mkdir -p "$PROJECT_DIR/logs"

# 6. 加载服务
echo -e "\n${YELLOW}[6/7] 启动系统服务...${NC}"

# 卸载旧服务（如果存在）
launchctl unload "$PLIST_DIR/$NODE_PLIST" 2>/dev/null || true
launchctl unload "$PLIST_DIR/$TUNNEL_PLIST" 2>/dev/null || true

sleep 2

# 加载新服务
echo -e "${YELLOW}启动 Node.js 服务...${NC}"
launchctl load "$PLIST_DIR/$NODE_PLIST"
echo -e "${GREEN}✓ Node.js 服务已启动${NC}"

echo -e "${YELLOW}启动 Cloudflare Tunnel 服务...${NC}"
launchctl load "$PLIST_DIR/$TUNNEL_PLIST"
echo -e "${GREEN}✓ Cloudflare Tunnel 服务已启动${NC}"

# 7. 验证服务状态
echo -e "\n${YELLOW}[7/7] 验证服务状态...${NC}"
sleep 3

# 检查 Node.js 服务
if launchctl list | grep -q "com.${PROJECT_NAME}.node"; then
    echo -e "${GREEN}✓ Node.js 服务运行中${NC}"
else
    echo -e "${RED}✗ Node.js 服务未运行${NC}"
fi

# 检查 Tunnel 服务
if launchctl list | grep -q "com.${PROJECT_NAME}.tunnel"; then
    echo -e "${GREEN}✓ Cloudflare Tunnel 服务运行中${NC}"
else
    echo -e "${RED}✗ Cloudflare Tunnel 服务未运行${NC}"
fi

# 检查端口
sleep 2
if lsof -ti:$LOCAL_PORT > /dev/null 2>&1; then
    echo -e "${GREEN}✓ 端口 $LOCAL_PORT 正常监听${NC}"
else
    echo -e "${YELLOW}⚠ 端口 $LOCAL_PORT 暂未监听，服务可能正在启动${NC}"
fi

# 完成信息
echo -e "\n${BLUE}========================================${NC}"
echo -e "${GREEN}✓ 系统服务安装完成！${NC}"
echo -e "${BLUE}========================================${NC}"

echo -e "\n${GREEN}📊 服务信息:${NC}"
echo -e "  • 项目目录: ${YELLOW}$PROJECT_DIR${NC}"
echo -e "  • 本地端口: ${YELLOW}$LOCAL_PORT${NC}"
echo -e "  • 外网访问: ${YELLOW}$TUNNEL_URL${NC}"
echo -e "  • Tunnel 名称: ${YELLOW}$TUNNEL_NAME${NC}"

echo -e "\n${GREEN}📁 日志文件:${NC}"
echo -e "  • Node.js: ${YELLOW}$PROJECT_DIR/logs/node-service.log${NC}"
echo -e "  • Tunnel: ${YELLOW}$PROJECT_DIR/logs/tunnel-service.log${NC}"

echo -e "\n${GREEN}🎮 管理命令:${NC}"
echo -e "  • 查看状态: ${YELLOW}./service-control.sh status${NC}"
echo -e "  • 停止服务: ${YELLOW}./service-control.sh stop${NC}"
echo -e "  • 启动服务: ${YELLOW}./service-control.sh start${NC}"
echo -e "  • 重启服务: ${YELLOW}./service-control.sh restart${NC}"
echo -e "  • 查看日志: ${YELLOW}./service-control.sh logs${NC}"
echo -e "  • 卸载服务: ${YELLOW}./service-uninstall.sh${NC}"

echo -e "\n${GREEN}✨ 特性:${NC}"
echo -e "  ✓ 开机自动启动"
echo -e "  ✓ 进程崩溃自动重启"
echo -e "  ✓ 后台静默运行"
echo -e "  ✓ 完整的日志记录"

echo -e "\n${YELLOW}💡 提示:${NC}"
echo -e "  服务将在系统重启后自动启动"
echo -e "  可以通过管理命令随时控制服务状态"
echo -e "\n"
