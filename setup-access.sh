#!/bin/bash

# Cloudflare Access 配置脚本
# 用途：为 Tunnel 配置邮箱访问认证

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

DOMAIN="claude.oxllxo.cc.cd"
ALLOWED_EMAIL="345480277@qq.com"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Cloudflare Access 配置向导${NC}"
echo -e "${BLUE}========================================${NC}\n"

echo -e "${GREEN}域名: ${YELLOW}$DOMAIN${NC}"
echo -e "${GREEN}授权邮箱: ${YELLOW}$ALLOWED_EMAIL${NC}\n"

echo -e "${YELLOW}⚠️  注意事项:${NC}"
echo -e "  1. Cloudflare Access 需要在 Cloudflare Dashboard 中配置"
echo -e "  2. 免费版 Cloudflare 账号支持最多 50 个用户"
echo -e "  3. 配置后需要几分钟生效\n"

echo -e "${BLUE}配置步骤：${NC}\n"

echo -e "${GREEN}[步骤 1] 登录 Cloudflare Dashboard${NC}"
echo -e "  访问: ${YELLOW}https://one.dash.cloudflare.com/${NC}"
echo -e "  使用你的 Cloudflare 账号登录\n"

echo -e "${GREEN}[步骤 2] 进入 Zero Trust 设置${NC}"
echo -e "  1. 点击左侧菜单 ${YELLOW}Zero Trust${NC}"
echo -e "  2. 如果是首次使用，需要创建一个 Team（团队名称）"
echo -e "  3. 选择免费计划（Free plan）\n"

echo -e "${GREEN}[步骤 3] 配置身份验证方法${NC}"
echo -e "  1. 进入 ${YELLOW}Settings > Authentication${NC}"
echo -e "  2. 点击 ${YELLOW}Add new${NC} 添加登录方法"
echo -e "  3. 选择 ${YELLOW}One-time PIN${NC}（一次性验证码）"
echo -e "  4. 保存配置\n"

echo -e "${GREEN}[步骤 4] 创建 Access 应用${NC}"
echo -e "  1. 进入 ${YELLOW}Access > Applications${NC}"
echo -e "  2. 点击 ${YELLOW}Add an application${NC}"
echo -e "  3. 选择 ${YELLOW}Self-hosted${NC}"
echo -e "  4. 配置应用:\n"

cat <<EOF
     ${YELLOW}应用配置:${NC}
     ┌─────────────────────────────────────────┐
     │ Application name: MyHerness             │
     │ Session Duration: 24 hours              │
     │ Application domain:                     │
     │   - Domain: ${YELLOW}$DOMAIN${NC}                    │
     │   - Path: /                             │
     └─────────────────────────────────────────┘
EOF

echo -e "\n${GREEN}[步骤 5] 配置访问策略${NC}"
echo -e "  在同一页面继续配置:\n"

cat <<EOF
     ${YELLOW}策略配置:${NC}
     ┌─────────────────────────────────────────┐
     │ Policy name: Email Authentication      │
     │ Action: Allow                           │
     │ Configure rules:                        │
     │   - Selector: ${YELLOW}Emails${NC}                    │
     │   - Value: ${YELLOW}$ALLOWED_EMAIL${NC}        │
     └─────────────────────────────────────────┘
EOF

echo -e "\n  5.1 点击 ${YELLOW}Add a rule${NC}"
echo -e "  5.2 选择 ${YELLOW}Emails${NC} 作为 Selector"
echo -e "  5.3 输入邮箱: ${YELLOW}$ALLOWED_EMAIL${NC}"
echo -e "  5.4 点击 ${YELLOW}Save${NC} 保存策略"
echo -e "  5.5 点击 ${YELLOW}Next${NC} 继续"
echo -e "  5.6 点击 ${YELLOW}Add application${NC} 完成创建\n"

echo -e "${GREEN}[步骤 6] 验证配置${NC}"
echo -e "  1. 在浏览器中访问: ${YELLOW}https://$DOMAIN${NC}"
echo -e "  2. 应该会看到 Cloudflare Access 登录页面"
echo -e "  3. 输入邮箱: ${YELLOW}$ALLOWED_EMAIL${NC}"
echo -e "  4. 检查邮箱收到的验证码"
echo -e "  5. 输入验证码完成登录\n"

echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}✓ 配置说明已完成${NC}"
echo -e "${BLUE}========================================${NC}\n"

echo -e "${YELLOW}💡 提示:${NC}"
echo -e "  • 配置生效需要 2-5 分钟"
echo -e "  • 验证码有效期为 10 分钟"
echo -e "  • Session 持续 24 小时后需要重新登录"
echo -e "  • 可以添加多个邮箱地址（逗号分隔）\n"

echo -e "${YELLOW}🔧 高级配置（可选）:${NC}"
echo -e "  1. 配置 CORS 策略"
echo -e "  2. 启用设备认证"
echo -e "  3. 配置多因素认证 (MFA)"
echo -e "  4. 设置 IP 白名单\n"

echo -e "${YELLOW}📚 相关文档:${NC}"
echo -e "  • Cloudflare Access: ${BLUE}https://developers.cloudflare.com/cloudflare-one/policies/access/${NC}"
echo -e "  • Email Auth: ${BLUE}https://developers.cloudflare.com/cloudflare-one/identity/one-time-pin/${NC}\n"

read -p "按 Enter 打开 Cloudflare Dashboard..."
open "https://one.dash.cloudflare.com/"

echo -e "\n${GREEN}✨ Dashboard 已在浏览器中打开${NC}\n"
