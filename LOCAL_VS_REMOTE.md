# 本地 vs 远端部署对比

## 📊 脚本对比表

| 功能 | macOS (本地) | Linux (远端服务器) |
|------|--------------|-------------------|
| **服务安装** | `setup-service.sh` | `remote-setup-service.sh` |
| **服务管理** | launchd | systemd |
| **Tunnel 配置** | `setup-cloudflare.sh` | `remote-setup-cloudflare.sh` |
| **服务控制** | `service-control.sh` | systemctl 命令 |
| **状态检查** | `service-control.sh status` | `remote-status.sh` |
| **日志查看** | `service-control.sh logs` | `remote-logs.sh` |
| **清理工具** | `cleanup.sh` | `remote-cleanup.sh` |

---

## 🔧 服务管理对比

### macOS (launchd)
```bash
# 服务配置位置
~/Library/LaunchAgents/com.myherness.*.plist

# 管理命令
launchctl load ~/Library/LaunchAgents/com.myherness.node.plist
launchctl unload ~/Library/LaunchAgents/com.myherness.node.plist
launchctl list | grep myherness

# 使用脚本
./service-control.sh start
./service-control.sh stop
./service-control.sh status
```

### Linux (systemd)
```bash
# 服务配置位置
/etc/systemd/system/myherness.service

# 管理命令
sudo systemctl start myherness
sudo systemctl stop myherness
sudo systemctl status myherness
sudo systemctl enable myherness

# 使用脚本
./remote-status.sh
```

---

## 📁 文件结构对比

### 本地 (macOS)
```
myherness/
├── setup-service.sh              # 安装本地服务
├── setup-cloudflare.sh           # 配置 Cloudflare
├── service-control.sh            # 服务控制
├── cleanup.sh                    # 清理工具
├── logs/
│   ├── node-service.log
│   └── tunnel-service.log
└── .cloudflare/
    └── config.yml
```

### 远端 (Linux)
```
myherness/
├── remote-setup-service.sh       # 安装远端服务
├── remote-setup-cloudflare.sh    # 配置 Cloudflare
├── remote-status.sh              # 状态检查
├── remote-logs.sh                # 日志工具
├── remote-cleanup.sh             # 清理工具
├── logs/
│   ├── node-service.log
│   ├── node-service.error.log
│   ├── tunnel-service.log
│   └── tunnel-service.error.log
└── .cloudflare/
    └── config.yml
```

---

## 🚀 部署流程对比

### macOS 本地部署
```bash
# 1. 安装服务
./setup-service.sh

# 2. 配置 Cloudflare (可选)
./setup-cloudflare.sh

# 3. 管理服务
./service-control.sh status
./service-control.sh logs
```

### Linux 远端部署
```bash
# 0. 上传项目
scp -r myherness/ user@server:/home/user/

# 1. 安装服务
./remote-setup-service.sh

# 2. 配置 Cloudflare
./remote-setup-cloudflare.sh

# 3. 验证部署
./remote-status.sh
./remote-logs.sh
```

---

## 📝 日志管理对比

### macOS
```bash
# 文件日志
tail -f logs/node-service.log
tail -f logs/tunnel-service.log

# 系统日志
log stream --predicate 'process == "node"'

# 使用脚本
./service-control.sh logs node
./service-control.sh logs tunnel
```

### Linux
```bash
# 文件日志
tail -f logs/node-service.log
tail -f logs/tunnel-service.log

# 系统日志 (journalctl)
journalctl -u myherness -f
journalctl -u myherness-tunnel -f

# 使用脚本
./remote-logs.sh node
./remote-logs.sh tunnel
./remote-logs.sh --analyze
```

---

## 🔍 故障排查对比

### macOS
```bash
# 检查服务状态
./service-control.sh status

# 查看日志
./service-control.sh logs

# 清理残留
./service-control.sh cleanup

# 完全清理
./cleanup.sh
```

### Linux
```bash
# 检查服务状态
./remote-status.sh

# 查看日志
./remote-logs.sh -e              # 错误日志
./remote-logs.sh --analyze       # 日志分析

# 清理残留
sudo systemctl restart myherness

# 完全清理
./remote-cleanup.sh
```

---

## ⚙️ 配置文件对比

### macOS (launchd plist)
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.myherness.node</string>
    
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/npm</string>
        <string>start</string>
    </array>
    
    <key>RunAtLoad</key>
    <true/>
    
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
</dict>
</plist>
```

### Linux (systemd unit)
```ini
[Unit]
Description=MyHerness Node.js Application
After=network.target

[Service]
Type=simple
User=user
WorkingDirectory=/home/user/myherness
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

---

## 🌐 使用场景

### 本地部署 (macOS)
**适用于:**
- ✅ 个人开发环境
- ✅ 测试和调试
- ✅ 小型个人项目
- ✅ 内网服务

**限制:**
- ❌ 需要 Mac 一直开机
- ❌ 网络环境限制
- ❌ 无法作为生产服务

### 远端部署 (Linux)
**适用于:**
- ✅ 生产环境
- ✅ 7x24 稳定服务
- ✅ 多用户访问
- ✅ 高可用性要求

**优势:**
- ✅ 专业服务器环境
- ✅ 更好的稳定性
- ✅ 更强的监控能力
- ✅ 更低的运维成本

---

## 💰 成本对比

### 本地部署
- **硬件**: 已有 Mac 电脑
- **电费**: ~$5-10/月 (24小时开机)
- **网络**: 家庭宽带
- **Cloudflare Tunnel**: 免费
- **总计**: ~$5-10/月

### 远端部署
- **VPS 服务器**: $5-20/月
  - DigitalOcean: $6/月起
  - Vultr: $5/月起
  - AWS Lightsail: $5/月起
  - 腾讯云/阿里云: ¥30/月起
- **Cloudflare Tunnel**: 免费
- **总计**: $5-20/月

---

## 🔒 安全性对比

### 本地部署
- 🔸 家庭网络环境
- 🔸 依赖路由器安全
- ✅ Cloudflare 加密传输
- ❌ 缺少专业防护

### 远端部署
- ✅ 专业数据中心
- ✅ 防火墙保护
- ✅ Cloudflare DDoS 防护
- ✅ 可配置安全策略
- ✅ 审计日志

---

## 📈 性能对比

### 本地部署
- **网络**: 依赖家庭宽带
  - 上行带宽: 通常 10-100 Mbps
  - 延迟: 取决于 ISP
- **计算**: Mac 硬件性能
- **稳定性**: 受电力、网络影响

### 远端部署
- **网络**: 数据中心专线
  - 带宽: 通常 1-10 Gbps
  - 延迟: 优化的路由
- **计算**: 可按需升级
- **稳定性**: SLA 保障 99.9%+

---

## 🛠 维护对比

### 本地部署
```bash
# 查看状态
./service-control.sh status

# 查看日志
./service-control.sh logs

# 重启服务
./service-control.sh restart

# 更新代码
git pull
npm install
./service-control.sh restart
```

### 远端部署
```bash
# SSH 登录
ssh user@server

# 查看状态
./remote-status.sh

# 查看日志
./remote-logs.sh

# 重启服务
sudo systemctl restart myherness

# 更新代码
git pull
npm install --production
sudo systemctl restart myherness
```

---

## ✅ 选择建议

### 选择本地部署 (macOS)
**如果你:**
- 只是个人使用或测试
- 不需要 7x24 运行
- 有稳定的网络环境
- 想节省服务器成本

### 选择远端部署 (Linux)
**如果你:**
- 需要生产级别服务
- 要求高可用性
- 需要多用户访问
- 想要更好的性能

### 混合部署
**最佳实践:**
- 🧪 **开发**: 本地 macOS
- 🧪 **测试**: 本地 macOS
- 🚀 **生产**: 远端 Linux

---

## 📚 文档索引

### 本地部署
- 完整指南: `SCRIPTS_README.md`
- 重构说明: `SCRIPTS_OVERVIEW.md`

### 远端部署
- 完整指南: `REMOTE_DEPLOYMENT.md`
- 快速参考: `REMOTE_QUICK_REFERENCE.md`

---

## 🔄 迁移指南

### 从本地迁移到远端

```bash
# 1. 在本地停止服务
./service-control.sh stop

# 2. 上传代码到服务器
scp -r myherness/ user@server:/home/user/

# 3. 在服务器部署
ssh user@server
cd myherness
./remote-setup-service.sh
./remote-setup-cloudflare.sh

# 4. 验证
./remote-status.sh
curl https://your-domain.com/api/health
```

### 从远端迁移到本地

```bash
# 1. 从服务器下载代码
scp -r user@server:/home/user/myherness/ ./

# 2. 在服务器停止服务
ssh user@server "cd myherness && ./remote-cleanup.sh"

# 3. 在本地部署
cd myherness
./setup-service.sh
./setup-cloudflare.sh

# 4. 验证
./service-control.sh status
```

---

**最后更新**: 2026-06-14
