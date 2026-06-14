# 远端服务器部署指南

适用于 Ubuntu/Debian Linux 服务器的完整部署方案。

---

## 📋 前置要求

### 服务器要求
- **操作系统**: Ubuntu 18.04+ / Debian 10+
- **架构**: x86_64 (amd64) 或 ARM64
- **内存**: 最低 512MB，推荐 1GB+
- **磁盘**: 最低 2GB 可用空间
- **网络**: 稳定的互联网连接

### 软件依赖
- **Node.js**: v14.0.0+ (推荐使用 nvm 安装)
- **systemd**: 服务管理（Ubuntu/Debian 默认自带）
- **sudo 权限**: 安装系统服务需要

---

## 🚀 快速部署

### 步骤 1: 上传项目到服务器

```bash
# 方法 1: 使用 scp
scp -r /path/to/myherness user@server:/home/user/

# 方法 2: 使用 rsync
rsync -avz --exclude 'node_modules' --exclude '.git' \
  /path/to/myherness/ user@server:/home/user/myherness/

# 方法 3: 使用 Git
ssh user@server
git clone https://github.com/yourusername/myherness.git
cd myherness
```

### 步骤 2: 安装 Node.js (如果未安装)

```bash
# 使用 nvm (推荐)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
source ~/.bashrc
nvm install --lts
nvm use --lts

# 或使用 apt (Ubuntu/Debian)
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 步骤 3: 部署服务

```bash
cd /home/user/myherness

# 添加执行权限
chmod +x remote-*.sh

# 1. 安装本地服务
./remote-setup-service.sh

# 2. 配置 Cloudflare Tunnel
./remote-setup-cloudflare.sh

# 3. 验证部署
./remote-status.sh
```

---

## 📂 脚本说明

### 1. remote-setup-service.sh
**功能**: 安装 Node.js 应用为 systemd 服务

```bash
./remote-setup-service.sh
```

**执行内容**:
- ✅ 检查系统环境和依赖
- ✅ 安装 npm 依赖
- ✅ 清理旧服务和端口占用
- ✅ 创建 systemd 服务配置
- ✅ 启动服务并设置开机自启

**生成的文件**:
- `/etc/systemd/system/myherness.service` - 服务配置
- `logs/node-service.log` - 标准输出日志
- `logs/node-service.error.log` - 错误日志

---

### 2. remote-setup-cloudflare.sh
**功能**: 配置 Cloudflare Tunnel 为系统服务

```bash
./remote-setup-cloudflare.sh
```

**执行内容**:
- ✅ 安装 cloudflared
- ✅ Cloudflare 账号认证
- ✅ 创建/配置 Tunnel
- ✅ 配置域名（临时或自定义）
- ✅ 创建 systemd 服务

**域名选择**:
1. **临时域名** - 自动生成 `*.trycloudflare.com`
2. **自定义域名** - 需要域名托管在 Cloudflare

**生成的文件**:
- `/etc/systemd/system/myherness-tunnel.service` - 服务配置
- `.cloudflare/config.yml` - Tunnel 配置
- `logs/tunnel-service.log` - 标准输出日志

**特别注意**: 无桌面环境服务器的认证方式
```bash
# 方法 1: 本地认证后上传
# 在本地机器运行
cloudflared tunnel login
scp ~/.cloudflared/cert.pem user@server:~/.cloudflared/

# 方法 2: 使用 API Token (高级)
# 在 Cloudflare Dashboard 生成 API Token
# 配置环境变量后运行脚本
```

---

### 3. remote-status.sh
**功能**: 全面检查服务状态和系统健康

```bash
./remote-status.sh
```

**检查内容**:
- 📊 系统信息（CPU、内存、磁盘）
- 🔍 Node.js 服务状态
- 🌐 Cloudflare Tunnel 状态
- 🔌 端口监听状态
- 🌍 网络连通性测试
- 📈 资源使用统计
- 📁 日志文件状态
- ⚠️ 最近错误分析

**输出示例**:
```
========================================
  远端服务器状态检查
========================================

[1/8] 系统信息
主机名: my-server
操作系统: Ubuntu 22.04.3 LTS
系统负载:  0.15, 0.12, 0.08

[2/8] Node.js 服务状态
✓ 服务状态: 运行中
✓ 进程 PID: 1234
✓ 内存使用: 87.5MB
✓ CPU 使用: 2.3%

[3/8] Cloudflare Tunnel 状态
✓ Tunnel 状态: 运行中
✓ 进程 PID: 5678
✓ 活跃连接: 4
```

---

### 4. remote-logs.sh
**功能**: 强大的日志查看和分析工具

```bash
# 基本用法
./remote-logs.sh [选项] [服务类型]

# 实时查看 Node.js 日志
./remote-logs.sh node

# 查看 Tunnel 最近 100 行
./remote-logs.sh tunnel -n 100

# 只查看错误日志
./remote-logs.sh -e

# 过滤包含 ERROR 的日志
./remote-logs.sh -g "ERROR"

# 分析日志统计
./remote-logs.sh --analyze

# 使用 journalctl 查看系统日志
./remote-logs.sh -j node
```

**日志分析功能**:
```bash
./remote-logs.sh --analyze
```

输出:
- 总行数统计
- 错误统计
- 关键词统计（ERROR, WARN, INFO）
- API 请求统计
- Tunnel 连接位置分布
- 临时域名信息

---

### 5. remote-cleanup.sh
**功能**: 深度清理工具

```bash
./remote-cleanup.sh
```

**清理内容**:
- 🛑 停止所有系统服务
- 🔌 清理端口占用（优雅停止 + 强制清理）
- 🧹 清理孤立进程
- 📁 清理日志文件
- ⚙️ （可选）删除服务配置
- ☁️ （可选）删除 Cloudflare Tunnel

**交互式确认**:
每个关键步骤都会询问确认，防止误删。

---

## 🎮 服务管理命令

### 查看状态
```bash
# 快速查看
./remote-status.sh

# 查看 systemd 状态
sudo systemctl status myherness
sudo systemctl status myherness-tunnel

# 检查是否运行
sudo systemctl is-active myherness
sudo systemctl is-active myherness-tunnel
```

### 启动/停止/重启
```bash
# Node.js 服务
sudo systemctl start myherness
sudo systemctl stop myherness
sudo systemctl restart myherness

# Cloudflare Tunnel
sudo systemctl start myherness-tunnel
sudo systemctl stop myherness-tunnel
sudo systemctl restart myherness-tunnel

# 同时重启两个服务
sudo systemctl restart myherness myherness-tunnel
```

### 开机自启
```bash
# 启用开机自启
sudo systemctl enable myherness
sudo systemctl enable myherness-tunnel

# 禁用开机自启
sudo systemctl disable myherness
sudo systemctl disable myherness-tunnel

# 查看是否已启用
sudo systemctl is-enabled myherness
```

### 查看日志
```bash
# 使用脚本（推荐）
./remote-logs.sh node          # Node.js 日志
./remote-logs.sh tunnel        # Tunnel 日志
./remote-logs.sh               # 所有日志

# 使用 journalctl
journalctl -u myherness -f           # 实时跟踪
journalctl -u myherness -n 100       # 最近 100 行
journalctl -u myherness --since today # 今天的日志

# 使用 tail
tail -f logs/node-service.log
tail -f logs/tunnel-service.log
```

---

## 📊 日志管理

### 日志文件位置
```
项目目录/logs/
├── node-service.log          # Node.js 标准输出
├── node-service.error.log    # Node.js 错误输出
├── tunnel-service.log        # Tunnel 标准输出
└── tunnel-service.error.log  # Tunnel 错误输出
```

### 日志轮转配置
为防止日志文件过大，建议配置 logrotate：

```bash
sudo nano /etc/logrotate.d/myherness
```

添加内容：
```
/home/user/myherness/logs/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 0644 user user
    sharedscripts
    postrotate
        systemctl reload myherness >/dev/null 2>&1 || true
        systemctl reload myherness-tunnel >/dev/null 2>&1 || true
    endscript
}
```

### 手动清理日志
```bash
# 使用清理脚本
./remote-cleanup.sh  # 选择清理日志

# 手动清空
> logs/node-service.log
> logs/tunnel-service.log

# 删除日志
rm -rf logs/
mkdir logs
```

---

## 🔒 安全加固

### 1. 服务用户隔离
不要使用 root 运行服务，创建专用用户：

```bash
# 创建服务用户
sudo useradd -r -s /bin/false myherness

# 设置文件权限
sudo chown -R myherness:myherness /home/user/myherness

# 修改服务配置
sudo sed -i 's/User=.*/User=myherness/' /etc/systemd/system/myherness.service
sudo systemctl daemon-reload
sudo systemctl restart myherness
```

### 2. 防火墙配置
```bash
# 使用 ufw (Ubuntu)
sudo ufw allow ssh
sudo ufw allow 4477/tcp  # 如需本地访问
sudo ufw enable

# 使用 iptables
sudo iptables -A INPUT -p tcp --dport 4477 -j ACCEPT
```

### 3. 限制资源使用
编辑服务文件添加资源限制：

```bash
sudo nano /etc/systemd/system/myherness.service
```

添加：
```ini
[Service]
# 内存限制
MemoryLimit=512M
MemoryMax=1G

# CPU 限制
CPUQuota=50%

# 文件描述符限制
LimitNOFILE=10000
```

---

## 🔧 故障排查

### 问题 1: 服务启动失败

**排查步骤**:
```bash
# 1. 查看服务状态
sudo systemctl status myherness

# 2. 查看详细日志
journalctl -u myherness -n 50 --no-pager

# 3. 查看错误日志
cat logs/node-service.error.log

# 4. 测试手动启动
cd /home/user/myherness
node server.js
```

**常见原因**:
- ❌ 端口被占用
- ❌ 依赖未安装
- ❌ 文件权限问题
- ❌ Node.js 版本不兼容

---

### 问题 2: Tunnel 连接失败 (Error 1033)

**排查步骤**:
```bash
# 1. 检查本地服务是否运行
curl http://localhost:4477/api/health

# 2. 查看 Tunnel 日志
tail -100 logs/tunnel-service.log

# 3. 检查 Tunnel 状态
sudo systemctl status myherness-tunnel

# 4. 测试 Tunnel 配置
cloudflared tunnel info myherness-tunnel
```

**常见原因**:
- ❌ 本地服务未运行
- ❌ Tunnel 服务未启动
- ❌ 配置文件错误
- ❌ 凭证文件缺失

**解决方案**:
```bash
# 重启所有服务
sudo systemctl restart myherness myherness-tunnel

# 等待几秒后验证
sleep 5
./remote-status.sh
```

---

### 问题 3: 端口占用

```bash
# 查看占用进程
lsof -ti:4477

# 使用清理脚本
./remote-cleanup.sh

# 手动清理
kill -9 $(lsof -ti:4477)
```

---

### 问题 4: 内存不足

```bash
# 查看内存使用
free -h
ps aux --sort=-%mem | head

# 重启服务释放内存
sudo systemctl restart myherness

# 添加 swap (如果需要)
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

---

## 📈 监控和告警

### 1. 使用 systemd 监控
systemd 自动监控服务，崩溃后会自动重启（配置了 `Restart=always`）

### 2. 健康检查脚本
创建定时任务：

```bash
crontab -e
```

添加：
```bash
# 每 5 分钟检查一次
*/5 * * * * cd /home/user/myherness && ./remote-status.sh > /dev/null

# 每小时生成状态报告
0 * * * * cd /home/user/myherness && ./remote-status.sh > /tmp/status-$(date +\%H).log
```

### 3. 日志监控
使用 `journalctl` 的告警功能：

```bash
# 监控错误日志
journalctl -u myherness -f | grep --line-buffered "ERROR" | \
  while read line; do
    echo "Alert: $line" | mail -s "Service Error" admin@example.com
  done
```

---

## 🔄 更新和维护

### 更新应用代码
```bash
# 1. 备份当前版本
cd /home/user
cp -r myherness myherness.backup

# 2. 拉取最新代码
cd myherness
git pull origin main

# 3. 安装新依赖
npm install --production

# 4. 重启服务
sudo systemctl restart myherness myherness-tunnel

# 5. 验证
./remote-status.sh
```

### 滚动回退
```bash
# 停止服务
sudo systemctl stop myherness myherness-tunnel

# 恢复备份
cd /home/user
rm -rf myherness
mv myherness.backup myherness

# 启动服务
cd myherness
sudo systemctl start myherness myherness-tunnel
```

---

## 📚 附录

### 环境变量配置
编辑服务文件添加环境变量：

```bash
sudo nano /etc/systemd/system/myherness.service
```

在 `[Service]` 部分添加：
```ini
Environment="NODE_ENV=production"
Environment="PORT=4477"
Environment="LOG_LEVEL=info"
Environment="DATABASE_URL=postgresql://..."
```

### 多实例部署
在同一服务器运行多个实例：

```bash
# 修改配置
export PROJECT_NAME="myherness-2"
export LOCAL_PORT=4478
export PROJECT_DIR="/home/user/myherness-2"

# 运行部署脚本
./remote-setup-service.sh
./remote-setup-cloudflare.sh
```

---

## 💡 最佳实践

1. **定期备份** - 备份配置文件和数据
2. **监控日志** - 定期检查错误日志
3. **资源限制** - 设置合理的资源限制
4. **安全更新** - 保持系统和依赖更新
5. **文档记录** - 记录配置变更和问题解决
6. **测试环境** - 先在测试环境验证
7. **回滚准备** - 保留可回滚的版本

---

## 🆘 获取帮助

- 查看脚本帮助: `./remote-logs.sh --help`
- 查看服务状态: `./remote-status.sh`
- 分析日志: `./remote-logs.sh --analyze`
- GitHub Issues: https://github.com/yourusername/myherness/issues

---

**文档版本**: v1.0  
**最后更新**: 2026-06-14
