#!/bin/bash

# 远端服务器部署脚本 - 服务安装
# 适用于: Ubuntu/Debian Linux 服务器
# 功能: 安装 Node.js 应用为 systemd 服务

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# 项目配置
PROJECT_NAME="myherness"
LOCAL_PORT=4477
SERVICE_USER="${SERVICE_USER:-$(whoami)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$SCRIPT_DIR}"
LOG_DIR="$PROJECT_DIR/logs"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  远端服务器部署 - 服务安装${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}项目: $PROJECT_NAME${NC}"
echo -e "${GREEN}目录: $PROJECT_DIR${NC}"
echo -e "${GREEN}端口: $LOCAL_PORT${NC}"
echo -e "${GREEN}用户: $SERVICE_USER${NC}\n"

# 检查是否为 root 或有 sudo 权限
if [ "$EUID" -ne 0 ]; then
    if ! sudo -n true 2>/dev/null; then
        echo -e "${YELLOW}注意: 需要 sudo 权限安装系统服务${NC}"
        echo -e "${YELLOW}请确保当前用户在 sudoers 中${NC}\n"
    fi
fi

# 1. 检查系统
echo -e "${YELLOW}[1/7] 检查系统环境...${NC}"

# 检测系统类型
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
    VERSION=$VERSION_ID
    echo -e "${GREEN}✓ 操作系统: $PRETTY_NAME${NC}"
else
    echo -e "${RED}错误: 无法识别操作系统${NC}"
    exit 1
fi

# 检查 systemd
if ! command -v systemctl &> /dev/null; then
    echo -e "${RED}错误: 系统不支持 systemd${NC}"
    exit 1
fi
echo -e "${GREEN}✓ systemd 可用${NC}"

# 2. 检查依赖
echo -e "\n${YELLOW}[2/7] 检查依赖...${NC}"

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}错误: 未安装 Node.js${NC}"
    echo -e "${YELLOW}请先安装 Node.js (推荐使用 nvm)${NC}"
    echo -e "${YELLOW}  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash${NC}"
    echo -e "${YELLOW}  nvm install --lts${NC}"
    exit 1
fi
NODE_VERSION=$(node --version)
NODE_PATH=$(which node)
echo -e "${GREEN}✓ Node.js: $NODE_VERSION${NC}"
echo -e "${GREEN}✓ Node 路径: $NODE_PATH${NC}"

# 检查 npm
if ! command -v npm &> /dev/null; then
    echo -e "${RED}错误: 未安装 npm${NC}"
    exit 1
fi
NPM_VERSION=$(npm --version)
NPM_PATH=$(which npm)
echo -e "${GREEN}✓ npm: $NPM_VERSION${NC}"

# 3. 安装项目依赖
echo -e "\n${YELLOW}[3/7] 安装项目依赖...${NC}"
cd "$PROJECT_DIR"

if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}安装 npm 依赖...${NC}"
    npm install --production
    echo -e "${GREEN}✓ 依赖安装完成${NC}"
else
    echo -e "${GREEN}✓ 依赖已存在${NC}"
    read -p "是否重新安装依赖? [y/N]: " REINSTALL
    if [[ "$REINSTALL" =~ ^[Yy]$ ]]; then
        npm install --production
    fi
fi

# 4. 创建日志目录
echo -e "\n${YELLOW}[4/7] 创建日志目录...${NC}"
mkdir -p "$LOG_DIR"
touch "$LOG_DIR/node-service.log"
touch "$LOG_DIR/node-service.error.log"

# 设置权限
if [ "$SERVICE_USER" != "$(whoami)" ]; then
    sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$LOG_DIR"
fi
echo -e "${GREEN}✓ 日志目录: $LOG_DIR${NC}"

# 5. 清理旧服务
echo -e "\n${YELLOW}[5/7] 清理旧服务...${NC}"

SERVICE_FILE="/etc/systemd/system/${PROJECT_NAME}.service"
if [ -f "$SERVICE_FILE" ]; then
    echo -e "${YELLOW}检测到旧服务，正在停止...${NC}"
    sudo systemctl stop "$PROJECT_NAME" 2>/dev/null || true
    sudo systemctl disable "$PROJECT_NAME" 2>/dev/null || true
    sleep 2
fi

# 清理端口占用
if lsof -ti:$LOCAL_PORT > /dev/null 2>&1; then
    echo -e "${YELLOW}端口 $LOCAL_PORT 被占用，正在清理...${NC}"
    PORT_PID=$(lsof -ti:$LOCAL_PORT)
    echo -e "  占用进程 PID: $PORT_PID"

    # 先尝试优雅停止
    kill -TERM $PORT_PID 2>/dev/null || true
    sleep 2

    # 强制清理残留
    if lsof -ti:$LOCAL_PORT > /dev/null 2>&1; then
        kill -9 $(lsof -ti:$LOCAL_PORT) 2>/dev/null || true
    fi

    sleep 1
    if ! lsof -ti:$LOCAL_PORT > /dev/null 2>&1; then
        echo -e "${GREEN}✓ 端口已释放${NC}"
    fi
else
    echo -e "${GREEN}✓ 端口无占用${NC}"
fi

# 6. 创建 systemd 服务
echo -e "\n${YELLOW}[6/7] 创建 systemd 服务...${NC}"

sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=MyHerness Node.js Application
Documentation=https://github.com/yourusername/myherness
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$PROJECT_DIR
Environment="NODE_ENV=production"
Environment="PORT=$LOCAL_PORT"
ExecStart=$NODE_PATH $PROJECT_DIR/server.js
Restart=always
RestartSec=10
StandardOutput=append:$LOG_DIR/node-service.log
StandardError=append:$LOG_DIR/node-service.error.log

# 资源限制
LimitNOFILE=65536
LimitNPROC=4096

# 安全加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$PROJECT_DIR/logs $PROJECT_DIR/data

[Install]
WantedBy=multi-user.target
EOF

echo -e "${GREEN}✓ systemd 服务配置已创建${NC}"

# 重新加载 systemd
sudo systemctl daemon-reload
echo -e "${GREEN}✓ systemd 已重新加载${NC}"

# 7. 启动服务
echo -e "\n${YELLOW}[7/7] 启动服务...${NC}"

# 启用服务（开机自启）
sudo systemctl enable "$PROJECT_NAME"
echo -e "${GREEN}✓ 服务已设置为开机自启${NC}"

# 启动服务
sudo systemctl start "$PROJECT_NAME"
echo -e "${GREEN}✓ 服务已启动${NC}"

# 等待服务启动
sleep 3

# 验证服务状态
echo -e "\n${YELLOW}验证服务状态...${NC}"
if sudo systemctl is-active --quiet "$PROJECT_NAME"; then
    echo -e "${GREEN}✓ 服务运行正常${NC}"
else
    echo -e "${RED}✗ 服务启动失败${NC}"
    echo -e "${YELLOW}查看日志: journalctl -u $PROJECT_NAME -n 50${NC}"
fi

# 检查端口
sleep 2
if lsof -ti:$LOCAL_PORT > /dev/null 2>&1; then
    echo -e "${GREEN}✓ 端口 $LOCAL_PORT 正常监听${NC}"
else
    echo -e "${YELLOW}⚠ 端口 $LOCAL_PORT 暂未监听${NC}"
fi

# 完成信息
echo -e "\n${BLUE}========================================${NC}"
echo -e "${GREEN}✓ 服务安装完成！${NC}"
echo -e "${BLUE}========================================${NC}"

echo -e "\n${GREEN}📊 服务信息:${NC}"
echo -e "  • 服务名称: ${YELLOW}$PROJECT_NAME${NC}"
echo -e "  • 项目目录: ${YELLOW}$PROJECT_DIR${NC}"
echo -e "  • 本地端口: ${YELLOW}http://localhost:$LOCAL_PORT${NC}"
echo -e "  • 运行用户: ${YELLOW}$SERVICE_USER${NC}"

echo -e "\n${GREEN}📁 重要文件:${NC}"
echo -e "  • 服务配置: ${YELLOW}$SERVICE_FILE${NC}"
echo -e "  • 日志目录: ${YELLOW}$LOG_DIR${NC}"

echo -e "\n${GREEN}🎮 管理命令:${NC}"
echo -e "  • 查看状态: ${YELLOW}sudo systemctl status $PROJECT_NAME${NC}"
echo -e "  • 停止服务: ${YELLOW}sudo systemctl stop $PROJECT_NAME${NC}"
echo -e "  • 启动服务: ${YELLOW}sudo systemctl start $PROJECT_NAME${NC}"
echo -e "  • 重启服务: ${YELLOW}sudo systemctl restart $PROJECT_NAME${NC}"
echo -e "  • 查看日志: ${YELLOW}journalctl -u $PROJECT_NAME -f${NC}"
echo -e "  • 查看文件日志: ${YELLOW}tail -f $LOG_DIR/node-service.log${NC}"

echo -e "\n${GREEN}✨ 特性:${NC}"
echo -e "  ✓ 开机自动启动"
echo -e "  ✓ 进程崩溃自动重启（10秒间隔）"
echo -e "  ✓ 后台静默运行"
echo -e "  ✓ 完整的日志记录"
echo -e "  ✓ 系统资源限制"

echo -e "\n${YELLOW}💡 下一步:${NC}"
echo -e "  配置 Cloudflare Tunnel: ${YELLOW}./remote-setup-cloudflare.sh${NC}"
echo -e "\n"
