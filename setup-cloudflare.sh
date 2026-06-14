#!/bin/bash

# Cloudflare Tunnel 配置脚本
# 功能：配置 Cloudflare Tunnel 为系统服务，实现外网访问
# 前提：已通过 setup-service.sh 安装本地服务

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
TUNNEL_PLIST="com.${PROJECT_NAME}.tunnel.plist"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Cloudflare Tunnel 配置向导${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}项目: $PROJECT_NAME${NC}"
echo -e "${GREEN}Tunnel: $TUNNEL_NAME${NC}\n"

# 1. 检查 cloudflared
echo -e "${YELLOW}[1/6] 检查 cloudflared 安装状态...${NC}"
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

# 2. 检查本地服务
echo -e "\n${YELLOW}[2/6] 检查本地服务状态...${NC}"
if ! lsof -ti:$LOCAL_PORT > /dev/null 2>&1; then
    echo -e "${YELLOW}⚠ 警告: 端口 $LOCAL_PORT 未监听${NC}"
    echo -e "${YELLOW}请先运行: ./setup-service.sh${NC}"
    read -p "是否继续配置 Tunnel? [y/N]: " CONTINUE
    if [[ ! "$CONTINUE" =~ ^[Yy]$ ]]; then
        exit 1
    fi
else
    echo -e "${GREEN}✓ 本地服务运行正常 (端口 $LOCAL_PORT)${NC}"
fi

# 3. 配置 Cloudflare 认证
echo -e "\n${YELLOW}[3/6] 配置 Cloudflare 认证...${NC}"
if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
    echo -e "${YELLOW}需要登录 Cloudflare 账号${NC}"
    echo -e "${YELLOW}请在浏览器中完成授权...${NC}"
    cloudflared tunnel login
    echo -e "${GREEN}✓ 认证完成${NC}"
else
    echo -e "${GREEN}✓ Cloudflare 认证已存在${NC}"
fi

# 4. 创建或检查 Tunnel
echo -e "\n${YELLOW}[4/6] 配置 Cloudflare Tunnel...${NC}"
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

# 5. 生成配置文件
echo -e "\n${YELLOW}[5/6] 生成 Tunnel 配置...${NC}"
mkdir -p "$PROJECT_DIR/.cloudflare"

# 选择域名模式
echo -e "\n${YELLOW}域名配置:${NC}"
echo -e "  ${YELLOW}1) 自动域名 (*.trycloudflare.com) - 无需配置，即时可用${NC}"
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
    USE_CUSTOM_DOMAIN=true
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
    USE_CUSTOM_DOMAIN=false
fi

# 6. 创建 Tunnel 系统服务
echo -e "\n${YELLOW}[6/6] 创建 Tunnel 系统服务...${NC}"

mkdir -p "$PLIST_DIR"
mkdir -p "$PROJECT_DIR/logs"

# 清理旧服务
if launchctl list | grep -q "com.${PROJECT_NAME}.tunnel"; then
    echo -e "${YELLOW}停止旧的 Tunnel 服务...${NC}"
    launchctl unload "$PLIST_DIR/$TUNNEL_PLIST" 2>/dev/null || true
    sleep 2
fi

# 创建 Tunnel 服务 plist
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

# 启动 Tunnel 服务
echo -e "${YELLOW}启动 Cloudflare Tunnel 服务...${NC}"
launchctl load "$PLIST_DIR/$TUNNEL_PLIST"
echo -e "${GREEN}✓ Cloudflare Tunnel 服务已启动${NC}"

# 验证服务状态
sleep 3

if launchctl list | grep -q "com.${PROJECT_NAME}.tunnel"; then
    echo -e "${GREEN}✓ Tunnel 服务运行正常${NC}"
else
    echo -e "${RED}✗ Tunnel 服务启动失败${NC}"
    echo -e "${YELLOW}请检查日志: $PROJECT_DIR/logs/tunnel-service.error.log${NC}"
fi

# 完成信息
echo -e "\n${BLUE}========================================${NC}"
echo -e "${GREEN}✓ Cloudflare Tunnel 配置完成！${NC}"
echo -e "${BLUE}========================================${NC}"

echo -e "\n${GREEN}🌐 访问信息:${NC}"
echo -e "  • 本地访问: ${YELLOW}http://localhost:$LOCAL_PORT${NC}"
echo -e "  • 外网访问: ${YELLOW}$TUNNEL_URL${NC}"
echo -e "  • Tunnel 名称: ${YELLOW}$TUNNEL_NAME${NC}"

if [ "$USE_CUSTOM_DOMAIN" = "false" ]; then
    echo -e "\n${YELLOW}💡 获取临时域名:${NC}"
    echo -e "  查看日志获取自动生成的域名:"
    echo -e "  ${YELLOW}tail -f $PROJECT_DIR/logs/tunnel-service.log | grep trycloudflare.com${NC}"
fi

echo -e "\n${GREEN}📁 日志文件:${NC}"
echo -e "  • Tunnel: ${YELLOW}$PROJECT_DIR/logs/tunnel-service.log${NC}"
echo -e "  • 错误: ${YELLOW}$PROJECT_DIR/logs/tunnel-service.error.log${NC}"

echo -e "\n${GREEN}🎮 管理命令:${NC}"
echo -e "  • 查看状态: ${YELLOW}./service-control.sh status${NC}"
echo -e "  • 重启 Tunnel: ${YELLOW}./service-control.sh restart tunnel${NC}"
echo -e "  • 查看日志: ${YELLOW}./service-control.sh logs tunnel${NC}"

echo -e "\n${GREEN}✨ 特性:${NC}"
echo -e "  ✓ 自动 HTTPS 加密"
echo -e "  ✓ 无需端口转发"
echo -e "  ✓ 开机自动启动"
echo -e "  ✓ 断线自动重连"

echo -e "\n${YELLOW}⚙️  高级配置:${NC}"
echo -e "  • 配置访问认证: ${YELLOW}./setup-access.sh${NC}"
echo -e "  • 修改域名配置: 编辑 ${YELLOW}$CONFIG_FILE${NC} 后重启服务"
echo -e "\n"
