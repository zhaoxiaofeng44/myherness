#!/bin/bash

# Cloudflare Tunnel 部署脚本
# 用途: 将本地项目通过 Cloudflare Tunnel 代理到外网

set -e

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}======================================${NC}"
echo -e "${GREEN}Cloudflare Tunnel 部署脚本${NC}"
echo -e "${GREEN}======================================${NC}"

# 项目配置
PROJECT_NAME="myherness"
LOCAL_PORT=4477
TUNNEL_NAME="${PROJECT_NAME}-tunnel"
CONFIG_FILE=".cloudflare/config.yml"

# 1. 检查并安装 cloudflared
echo -e "\n${YELLOW}[1/6] 检查 cloudflared 安装状态...${NC}"
if ! command -v cloudflared &> /dev/null; then
    echo -e "${YELLOW}cloudflared 未安装，正在通过 Homebrew 安装...${NC}"
    if ! command -v brew &> /dev/null; then
        echo -e "${RED}错误: 未找到 Homebrew，请先安装 Homebrew${NC}"
        echo -e "${YELLOW}访问 https://brew.sh 安装 Homebrew${NC}"
        exit 1
    fi
    brew install cloudflared
    echo -e "${GREEN}✓ cloudflared 安装完成${NC}"
else
    echo -e "${GREEN}✓ cloudflared 已安装 ($(cloudflared --version))${NC}"
fi

# 2. 检查 Cloudflare 认证
echo -e "\n${YELLOW}[2/6] 检查 Cloudflare 认证...${NC}"
if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
    echo -e "${YELLOW}首次使用需要登录 Cloudflare${NC}"
    echo -e "${YELLOW}请在浏览器中完成授权...${NC}"
    cloudflared tunnel login
    echo -e "${GREEN}✓ 认证完成${NC}"
else
    echo -e "${GREEN}✓ 已存在认证信息${NC}"
fi

# 3. 创建或检查 Tunnel
echo -e "\n${YELLOW}[3/6] 配置 Cloudflare Tunnel...${NC}"
EXISTING_TUNNEL=$(cloudflared tunnel list 2>/dev/null | grep -w "$TUNNEL_NAME" || true)

if [ -z "$EXISTING_TUNNEL" ]; then
    echo -e "${YELLOW}创建新 Tunnel: $TUNNEL_NAME${NC}"
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

# 4. 创建配置文件目录
echo -e "\n${YELLOW}[4/6] 创建配置文件...${NC}"
mkdir -p .cloudflare

# 生成配置文件
cat > "$CONFIG_FILE" <<EOF
# Cloudflare Tunnel 配置文件
# Tunnel: $TUNNEL_NAME
# Tunnel ID: $TUNNEL_ID

tunnel: $TUNNEL_ID
credentials-file: $HOME/.cloudflared/$TUNNEL_ID.json

ingress:
  - hostname: $TUNNEL_NAME.your-domain.com
    service: http://localhost:$LOCAL_PORT
  - service: http_status:404
EOF

echo -e "${GREEN}✓ 配置文件已创建: $CONFIG_FILE${NC}"

# 5. 配置 DNS (需要用户手动或通过命令完成)
echo -e "\n${YELLOW}[5/6] 配置 DNS 路由...${NC}"
echo -e "${YELLOW}请选择一个操作:${NC}"
echo -e "  ${YELLOW}1) 使用自动生成的 trycloudflare.com 域名 (无需配置)${NC}"
echo -e "  ${YELLOW}2) 配置自定义域名 (需要有 Cloudflare 管理的域名)${NC}"
read -p "选择 [1/2] (默认: 1): " DNS_CHOICE
DNS_CHOICE=${DNS_CHOICE:-1}

if [ "$DNS_CHOICE" = "2" ]; then
    read -p "请输入您的域名 (例如: example.com): " DOMAIN
    read -p "请输入子域名前缀 (例如: app, 用于 app.example.com): " SUBDOMAIN
    FULL_DOMAIN="${SUBDOMAIN}.${DOMAIN}"

    # 更新配置文件
    sed -i.bak "s/$TUNNEL_NAME.your-domain.com/$FULL_DOMAIN/g" "$CONFIG_FILE"
    rm -f "${CONFIG_FILE}.bak"

    # 配置 DNS
    echo -e "${YELLOW}配置 DNS CNAME 记录...${NC}"
    cloudflared tunnel route dns "$TUNNEL_NAME" "$FULL_DOMAIN"
    echo -e "${GREEN}✓ DNS 配置完成: https://$FULL_DOMAIN${NC}"
    USE_CUSTOM_DOMAIN=true
else
    echo -e "${GREEN}✓ 将使用临时域名 (trycloudflare.com)${NC}"
    USE_CUSTOM_DOMAIN=false
fi

# 6. 安装 npm 依赖并启动服务
echo -e "\n${YELLOW}[6/6] 准备启动服务...${NC}"

# 检查 node_modules
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}安装项目依赖...${NC}"
    npm install
fi

echo -e "\n${GREEN}======================================${NC}"
echo -e "${GREEN}配置完成！${NC}"
echo -e "${GREEN}======================================${NC}"
echo -e "\n${YELLOW}启动命令说明:${NC}"
echo -e "  ${GREEN}方式 1 - 前台运行 (推荐调试):${NC}"
echo -e "    npm start & cloudflared tunnel --config $CONFIG_FILE run $TUNNEL_NAME"
echo -e ""
echo -e "  ${GREEN}方式 2 - 后台运行:${NC}"
echo -e "    npm start > server.log 2>&1 &"
echo -e "    cloudflared tunnel --config $CONFIG_FILE run $TUNNEL_NAME &"
echo -e ""
if [ "$USE_CUSTOM_DOMAIN" = "false" ]; then
    echo -e "  ${GREEN}方式 3 - 快速测试 (临时域名):${NC}"
    echo -e "    npm start & cloudflared tunnel --url http://localhost:$LOCAL_PORT"
fi

echo -e "\n${YELLOW}现在启动服务? [y/N]:${NC} "
read -p "" START_NOW
START_NOW=${START_NOW:-N}

if [[ "$START_NOW" =~ ^[Yy]$ ]]; then
    echo -e "\n${GREEN}正在启动服务...${NC}"

    # 启动 Node.js 服务
    echo -e "${YELLOW}启动 Node.js 服务 (端口 $LOCAL_PORT)...${NC}"
    npm start > server.log 2>&1 &
    NODE_PID=$!
    echo -e "${GREEN}✓ Node.js 服务已启动 (PID: $NODE_PID)${NC}"

    # 等待服务启动
    sleep 3

    # 检查服务是否正常
    if curl -s http://localhost:$LOCAL_PORT/api/health > /dev/null 2>&1; then
        echo -e "${GREEN}✓ 服务健康检查通过${NC}"
    else
        echo -e "${YELLOW}⚠ 警告: 服务可能未正常启动，请检查 server.log${NC}"
    fi

    # 启动 Cloudflare Tunnel
    echo -e "\n${YELLOW}启动 Cloudflare Tunnel...${NC}"
    if [ "$USE_CUSTOM_DOMAIN" = "true" ]; then
        cloudflared tunnel --config "$CONFIG_FILE" run "$TUNNEL_NAME"
    else
        echo -e "${GREEN}使用临时域名模式...${NC}"
        cloudflared tunnel --url http://localhost:$LOCAL_PORT
    fi
else
    echo -e "\n${GREEN}配置已完成，您可以稍后手动启动服务${NC}"
    echo -e "${YELLOW}服务日志将保存在: server.log${NC}"
fi
