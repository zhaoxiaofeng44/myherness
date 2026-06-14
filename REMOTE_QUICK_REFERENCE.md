# 远端部署快速参考

## 🚀 快速开始

### 1. 上传项目到服务器
```bash
scp -r myherness/ user@server:/home/user/
# 或
rsync -avz --exclude 'node_modules' myherness/ user@server:/home/user/myherness/
```

### 2. 部署服务
```bash
ssh user@server
cd myherness
chmod +x remote-*.sh

./remote-setup-service.sh      # 安装 Node.js 服务
./remote-setup-cloudflare.sh   # 配置 Cloudflare Tunnel
./remote-status.sh              # 验证部署
```

---

## 📋 脚本速查表

| 脚本 | 用途 | 示例 |
|------|------|------|
| `remote-setup-service.sh` | 安装 Node.js 服务 | `./remote-setup-service.sh` |
| `remote-setup-cloudflare.sh` | 配置 Cloudflare Tunnel | `./remote-setup-cloudflare.sh` |
| `remote-status.sh` | 检查服务状态 | `./remote-status.sh` |
| `remote-logs.sh` | 查看日志 | `./remote-logs.sh node -f` |
| `remote-cleanup.sh` | 清理服务 | `./remote-cleanup.sh` |

---

## ⚡ 常用命令

### 服务管理
```bash
# 查看状态
sudo systemctl status myherness
sudo systemctl status myherness-tunnel

# 启动/停止/重启
sudo systemctl start myherness
sudo systemctl stop myherness
sudo systemctl restart myherness

# 开机自启
sudo systemctl enable myherness
sudo systemctl disable myherness
```

### 日志查看
```bash
# 使用脚本
./remote-logs.sh node           # Node.js 日志
./remote-logs.sh tunnel         # Tunnel 日志
./remote-logs.sh -e             # 只看错误
./remote-logs.sh -n 100         # 最近 100 行
./remote-logs.sh --analyze      # 日志分析

# 使用 journalctl
journalctl -u myherness -f      # 实时跟踪
journalctl -u myherness -n 50   # 最近 50 行
```

### 快速检查
```bash
# 一键检查所有状态
./remote-status.sh

# 检查端口
lsof -ti:4477

# 测试本地服务
curl http://localhost:4477/api/health

# 测试远程访问
curl https://your-domain.com/api/health
```

---

## 🔧 故障排查

### 服务启动失败
```bash
# 1. 查看详细日志
journalctl -u myherness -n 50

# 2. 查看错误日志
cat logs/node-service.error.log

# 3. 手动测试
node server.js
```

### Tunnel 连接失败 (Error 1033)
```bash
# 1. 检查本地服务
curl http://localhost:4477/api/health

# 2. 重启服务
sudo systemctl restart myherness myherness-tunnel

# 3. 查看 Tunnel 日志
tail -100 logs/tunnel-service.log

# 4. 验证状态
./remote-status.sh
```

### 端口被占用
```bash
# 查看占用进程
lsof -ti:4477

# 使用清理脚本
./remote-cleanup.sh

# 或手动清理
kill -9 $(lsof -ti:4477)
sudo systemctl restart myherness
```

---

## 📊 日志位置

```
项目目录/logs/
├── node-service.log          # Node.js 输出
├── node-service.error.log    # Node.js 错误
├── tunnel-service.log        # Tunnel 输出
└── tunnel-service.error.log  # Tunnel 错误
```

---

## 🔄 更新流程

```bash
# 1. 备份
cp -r myherness myherness.backup

# 2. 更新代码
cd myherness
git pull
npm install --production

# 3. 重启服务
sudo systemctl restart myherness myherness-tunnel

# 4. 验证
./remote-status.sh
```

---

## 🆘 紧急恢复

```bash
# 完全重启
sudo systemctl restart myherness myherness-tunnel

# 清理后重新部署
./remote-cleanup.sh
./remote-setup-service.sh
./remote-setup-cloudflare.sh

# 回滚到备份
sudo systemctl stop myherness myherness-tunnel
rm -rf myherness
mv myherness.backup myherness
cd myherness
sudo systemctl start myherness myherness-tunnel
```

---

## 📞 关键文件

| 文件 | 路径 |
|------|------|
| Node.js 服务 | `/etc/systemd/system/myherness.service` |
| Tunnel 服务 | `/etc/systemd/system/myherness-tunnel.service` |
| Tunnel 配置 | `项目目录/.cloudflare/config.yml` |
| Cloudflare 凭证 | `~/.cloudflared/*.json` |
| 日志目录 | `项目目录/logs/` |

---

## ✅ 部署检查清单

- [ ] Node.js 已安装
- [ ] 项目代码已上传
- [ ] `remote-setup-service.sh` 运行成功
- [ ] Node.js 服务运行中
- [ ] 端口 4477 监听正常
- [ ] `remote-setup-cloudflare.sh` 运行成功
- [ ] Tunnel 服务运行中
- [ ] Tunnel 已建立连接
- [ ] 远程访问测试通过
- [ ] 日志正常记录

---

## 🔗 获取域名

### 临时域名
```bash
# 从日志获取
tail -f logs/tunnel-service.log | grep trycloudflare.com

# 或查看分析
./remote-logs.sh --analyze
```

### 自定义域名
配置时选择选项 2，输入你的域名和子域名。

---

**完整文档**: 查看 `REMOTE_DEPLOYMENT.md`
