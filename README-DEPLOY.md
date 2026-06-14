# MyHerness 项目 - 快速部署指南

本项目支持两种部署方式：临时测试和系统服务。

---

## 📦 方案对比

| 特性 | 临时测试 | 系统服务 |
|------|---------|---------|
| 开机自启 | ❌ | ✅ |
| 进程保活 | ❌ | ✅ |
| 后台运行 | ❌ | ✅ |
| 固定域名 | 可选 | 可选 |
| 适用场景 | 开发/测试 | 生产/长期运行 |

---

## 🚀 快速开始

### 方式 1：临时测试（推荐新手）

最简单的方式，无需配置：

```bash
./start-tunnel-quick.sh
```

- 自动生成临时域名
- 按 Ctrl+C 停止
- 关闭终端后服务停止

### 方式 2：系统服务（推荐生产）

一次配置，永久运行：

```bash
# 安装服务（只需一次）
./service-install.sh

# 管理服务
./service-control.sh status    # 查看状态
./service-control.sh start     # 启动
./service-control.sh stop      # 停止
./service-control.sh restart   # 重启
./service-control.sh logs      # 查看日志
```

**特性：**
- ✅ 系统重启自动启动
- ✅ 崩溃自动重启
- ✅ 后台静默运行
- ✅ 完整日志记录

---

## 📖 详细文档

- **临时测试部署** → [README-TUNNEL.md](./README-TUNNEL.md)
- **系统服务部署** → [README-SERVICE.md](./README-SERVICE.md)

---

## 🔧 项目脚本

### 临时部署脚本

| 脚本 | 用途 |
|------|------|
| `deploy.sh` | 首次配置向导 |
| `start-tunnel.sh` | 启动服务（固定域名） |
| `start-tunnel-quick.sh` | 快速启动（临时域名） |
| `stop-tunnel.sh` | 停止服务 |

### 系统服务脚本

| 脚本 | 用途 |
|------|------|
| `service-install.sh` | 安装系统服务 |
| `service-control.sh` | 管理服务 |
| `service-uninstall.sh` | 卸载服务 |

---

## 🛠️ 系统要求

- macOS（Darwin）
- Node.js 18+
- npm
- Cloudflare 账号
- Homebrew（用于安装 cloudflared）

---

## 📊 端口配置

- **本地端口**: 4477
- **外网访问**: 通过 Cloudflare Tunnel

---

## 💡 使用建议

**开发阶段：**
```bash
./start-tunnel-quick.sh
```

**测试阶段：**
```bash
./deploy.sh  # 配置固定域名
./start-tunnel.sh
```

**生产环境：**
```bash
./service-install.sh
./service-control.sh status
```

---

## 🐛 故障排查

### 端口被占用

```bash
lsof -i:4477
lsof -ti:4477 | xargs kill -9
```

### 查看服务状态

```bash
# 临时部署
ps aux | grep node
ps aux | grep cloudflared

# 系统服务
./service-control.sh status
launchctl list | grep myherness
```

### 查看日志

```bash
# 临时部署
tail -f server.log

# 系统服务
./service-control.sh logs
tail -f logs/node-service.log
tail -f logs/tunnel-service.log
```

---

## 📞 获取帮助

查看详细文档：
- [临时部署完整指南](./README-TUNNEL.md)
- [系统服务完整指南](./README-SERVICE.md)

---

**推荐路径：**  
新用户 → 临时测试 → 系统服务 → 生产部署
