#!/bin/bash

# 远端服务器部署脚本 - Cloudflare Tunnel 配置
# 适用于: Ubuntu/Debian Linux 服务器
# 功能: 配置 Cloudflare Tunnel 为 systemd 服务

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# 项目配置
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$SCRIPT_DIR}"
PROJECT_NAME="myherness"
LOCAL_PORT=4477
TUNNEL_NAME="${PROJECT_NAME}-tunnel"
CONFIG_DIR="$PROJECT_DIR/.cloudflare"
CONFIG_FILE="$CONFIG_DIR/config.yml"
SERVICE_USER="${SERVICE_USER:-$(whoami)}"
LOG_DIR="$PROJECT_DIR/logs"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  远端服务器 - Cloudflare Tunnel 配置${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}项目: $PROJECT_NAME${NC}"
echo -e "${GREEN}Tunnel: $TUNNEL_NAME${NC}\n"

# 1. 检查 cloudflared
echo -e "${YELLOW}[1/7] 检查 cloudflared 安装...${NC}"

if ! command -v cloudflared &> /dev/null; then
    echo -e "${YELLOW}cloudflared 未安装，正在安装...${NC}"

    # 检测系统架构
    ARCH=$(uname -m)
    case $ARCH in
        x86_64)
            ARCH="amd64"
            ;;
        aarch64|arm64)
            ARCH="arm64"
            ;;
        *)
            echo -e "${RED}错误: 不支持的架构 $ARCH${NC}"
            exit 1
            ;;
    esac

    # 下载并安装
    echo -e "${YELLOW}下载 cloudflared ($ARCH)...${NC}"
    DOWNLOAD_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH"
    sudo curl -L "$DOWNLOAD_URL" -o /usr/local/bin/cloudflared
    sudo chmod +x /usr/local/bin/cloudflared

    echo -e "${GREEN}✓ cloudflared 安装完成${NC}"
fi

CLOUDFLARED_VERSION=$(cloudflared --version 2>&1 | head -1)
CLOUDFLARED_PATH=$(which cloudflared)
echo -e "${GREEN}✓ cloudflared: $CLOUDFLARED_VERSION${NC}"
echo -e "${GREEN}✓ 路径: $CLOUDFLARED_PATH${NC}"

# 2. 检查本地服务
echo -e "\n${YELLOW}[2/7] 检查本地服务状态...${NC}"

if ! lsof -ti:$LOCAL_PORT > /dev/null 2>&1; then
    echo -e "${YELLOW}⚠ 警告: 端口 $LOCAL_PORT 未监听${NC}"
    echo -e "${YELLOW}请先运行: ./remote-setup-service.sh${NC}\n"
    read -p "是否继续配置 Tunnel? [y/N]: " CONTINUE
    if [[ ! "$CONTINUE" =~ ^[Yy]$ ]]; then
        exit 1
    fi
else
    echo -e "${GREEN}✓ 本地服务运行正常 (端口 $LOCAL_PORT)${NC}"
fi

# 3. Cloudflare 认证
echo -e "\n${YELLOW}[3/7] 配置 Cloudflare 认证...${NC}"

# 检查是否已有认证
if [ -f "$HOME/.cloudflared/cert.pem" ]; then
    echo -e "${GREEN}✓ 认证文件已存在${NC}"
    read -p "是否重新认证? [y/N]: " REAUTH
    if [[ "$REAUTH" =~ ^[Yy]$ ]]; then
        cloudflared tunnel login
    fi
else
    echo -e "${YELLOW}首次使用需要登录 Cloudflare${NC}"
    echo -e "${YELLOW}将打开浏览器进行授权...${NC}\n"
    echo -e "${RED}注意: 如果是无桌面环境服务器，请使用以下方法之一:${NC}"
    echo -e "  1. 在本地机器运行 'cloudflared tunnel login'"
    echo -e "  2. 复制 ~/.cloudflared/cert.pem 到服务器"
    echo -e "  3. 使用 API Token 方式（高级）\n"

    read -p "是否在当前服务器上登录? [y/N]: " DO_LOGIN
    if [[ "$DO_LOGIN" =~ ^[Yy]$ ]]; then
        cloudflared tunnel login
        echo -e "${GREEN}✓ 认证完成${NC}"
    else
        echo -e "${YELLOW}请手动上传 cert.pem 到 ~/.cloudflared/ 目录${NC}"
        exit 1
    fi
fi

# 4. 创建或检查 Tunnel
echo -e "\n${YELLOW}[4/7] 配置 Cloudflare Tunnel...${NC}"

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

# 检查凭证文件
CREDENTIALS_FILE="$HOME/.cloudflared/$TUNNEL_ID.json"
if [ ! -f "$CREDENTIALS_FILE" ]; then
    echo -e "${RED}错误: 凭证文件不存在: $CREDENTIALS_FILE${NC}"
    exit 1
fi
echo -e "${GREEN}✓ 凭证文件存在${NC}"

# 5. 生成配置文件
echo -e "\n${YELLOW}[5/7] 生成 Tunnel 配置...${NC}"
mkdir -p "$CONFIG_DIR"

# 选择域名模式
echo -e "\n${YELLOW}域名配置:${NC}"
echo -e "  ${YELLOW}1) 自动域名 (*.trycloudflare.com) - 无需配置，即时可用${NC}"
echo -e "  ${YELLOW}2) 自定义域名 - 需要域名托管在 Cloudflare${NC}"
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
credentials-file: $CREDENTIALS_FILE

# 全局配置
protocol: http2

ingress:
  - hostname: $FULL_DOMAIN
    service: http://localhost:$LOCAL_PORT
    originRequest:
      httpHostHeader: $FULL_DOMAIN
      originServerName: $FULL_DOMAIN
      noTLSVerify: false
      connectTimeout: 30s
      tlsTimeout: 10s
      tcpKeepAlive: 30s
      keepAliveConnections: 100
      keepAliveTimeout: 90s
  - service: http_status:404
EOF

    # 配置 DNS
    echo -e "${YELLOW}配置 DNS 记录...${NC}"
    if cloudflared tunnel route dns "$TUNNEL_NAME" "$FULL_DOMAIN"; then
        echo -e "${GREEN}✓ DNS 配置完成: https://$FULL_DOMAIN${NC}"
        TUNNEL_URL="https://$FULL_DOMAIN"
    else
        echo -e "${RED}DNS 配置失败，请手动配置${NC}"
        TUNNEL_URL="https://$FULL_DOMAIN (需手动配置DNS)"
    fi
    USE_CUSTOM_DOMAIN=true
else
    # 生成临时域名配置
    cat > "$CONFIG_FILE" <<EOF
# Cloudflare Tunnel 配置 (临时域名模式)
tunnel: $TUNNEL_ID
credentials-file: $CREDENTIALS_FILE

# 全局配置
protocol: http2

ingress:
  - service: http://localhost:$LOCAL_PORT
EOF
    echo -e "${GREEN}✓ 将使用临时域名 (启动后显示)${NC}"
    TUNNEL_URL="临时域名 (启动后自动生成)"
    USE_CUSTOM_DOMAIN=false
fi

echo -e "${GREEN}✓ 配置文件已生成: $CONFIG_FILE${NC}"

# 6. 创建 systemd 服务
echo -e "\n${YELLOW}[6/7] 创建 systemd 服务...${NC}"

SERVICE_FILE="/etc/systemd/system/${PROJECT_NAME}-tunnel.service"

# 停止旧服务
if [ -f "$SERVICE_FILE" ]; then
    echo -e "${YELLOW}停止旧服务...${NC}"
    sudo systemctl stop "${PROJECT_NAME}-tunnel" 2>/dev/null || true
    sudo systemctl disable "${PROJECT_NAME}-tunnel" 2>/dev/null || true
    sleep 2
fi

# 创建日志文件
touch "$LOG_DIR/tunnel-service.log"
touch "$LOG_DIR/tunnel-service.error.log"

# 设置权限
if [ "$SERVICE_USER" != "$(whoami)" ]; then
    sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$CONFIG_DIR"
    sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$LOG_DIR"
fi

# 创建服务配置
sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=Cloudflare Tunnel for MyHerness
Documentation=https://developers.cloudflare.com/cloudflare-one/connections/connect-apps
After=network.target network-online.target
Wants=network-online.target
Requires=${PROJECT_NAME}.service

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$PROJECT_DIR
ExecStart=$CLOUDFLARED_PATH tunnel --config $CONFIG_FILE run $TUNNEL_NAME
Restart=always
RestartSec=10
StandardOutput=append:$LOG_DIR/tunnel-service.log
StandardError=append:$LOG_DIR/tunnel-service.error.log

# 资源限制
LimitNOFILE=65536

# 安全加固
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

echo -e "${GREEN}✓ systemd 服务配置已创建${NC}"

# 重新加载 systemd
sudo systemctl daemon-reload
echo -e "${GREEN}✓ systemd 已重新加载${NC}"

# 7. 启动服务
echo -e "\n${YELLOW}[7/7] 启动 Tunnel 服务...${NC}"

# 启用服务
sudo systemctl enable "${PROJECT_NAME}-tunnel"
echo -e "${GREEN}✓ 服务已设置为开机自启${NC}"

# 启动服务
sudo systemctl start "${PROJECT_NAME}-tunnel"
echo -e "${GREEN}✓ Tunnel 服务已启动${NC}"

# 等待服务启动
sleep 3

# 验证服务状态
if sudo systemctl is-active --quiet "${PROJECT_NAME}-tunnel"; then
    echo -e "${GREEN}✓ Tunnel 服务运行正常${NC}"
else
    echo -e "${RED}✗ Tunnel 服务启动失败${NC}"
    echo -e "${YELLOW}查看日志: journalctl -u ${PROJECT_NAME}-tunnel -n 50${NC}"
fi

# 完成信息
echo -e "\n${BLUE}========================================${NC}"
echo -e "${GREEN}✓ Cloudflare Tunnel 配置完成！${NC}"
echo -e "${BLUE}========================================${NC}"

echo -e "\n${GREEN}🌐 访问信息:${NC}"
echo -e "  • 本地访问: ${YELLOW}http://localhost:$LOCAL_PORT${NC}"
echo -e "  • 外网访问: ${YELLOW}$TUNNEL_URL${NC}"
echo -e "  • Tunnel 名称: ${YELLOW}$TUNNEL_NAME${NC}"
echo -e "  • Tunnel ID: ${YELLOW}$TUNNEL_ID${NC}"

if [ "$USE_CUSTOM_DOMAIN" = "false" ]; then
    echo -e "\n${YELLOW}💡 获取临时域名:${NC}"
    echo -e "  查看日志获取自动生成的域名:"
    echo -e "  ${YELLOW}tail -f $LOG_DIR/tunnel-service.log | grep trycloudflare.com${NC}"
    echo -e "  或: ${YELLOW}journalctl -u ${PROJECT_NAME}-tunnel -f | grep trycloudflare.com${NC}"
fi

echo -e "\n${GREEN}📁 重要文件:${NC}"
echo -e "  • 服务配置: ${YELLOW}$SERVICE_FILE${NC}"
echo -e "  • Tunnel 配置: ${YELLOW}$CONFIG_FILE${NC}"
echo -e "  • 凭证文件: ${YELLOW}$CREDENTIALS_FILE${NC}"

echo -e "\n${GREEN}🎮 管理命令:${NC}"
echo -e "  • 查看状态: ${YELLOW}sudo systemctl status ${PROJECT_NAME}-tunnel${NC}"
echo -e "  • 重启 Tunnel: ${YELLOW}sudo systemctl restart ${PROJECT_NAME}-tunnel${NC}"
echo -e "  • 查看日志: ${YELLOW}journalctl -u ${PROJECT_NAME}-tunnel -f${NC}"
echo -e "  • 查看文件日志: ${YELLOW}tail -f $LOG_DIR/tunnel-service.log${NC}"

echo -e "\n${GREEN}✨ 特性:${NC}"
echo -e "  ✓ 自动 HTTPS 加密"
echo -e "  ✓ 无需公网 IP"
echo -e "  ✓ 无需端口转发"
echo -e "  ✓ 开机自动启动"
echo -e "  ✓ 断线自动重连"

echo -e "\n${YELLOW}📊 验证部署:${NC}"
echo -e "  等待几秒后运行: ${YELLOW}./remote-status.sh${NC}"
echo -e "\n"
