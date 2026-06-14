# 服务部署与管理脚本

本项目提供了一套完整的脚本工具，用于将 Node.js 应用部署为后台服务，并通过 Cloudflare Tunnel 提供外网访问。

## 📂 脚本概览

```
├── setup-service.sh       # 1️⃣ 后台服务安装（本地保活）
├── setup-cloudflare.sh    # 2️⃣ Cloudflare Tunnel 配置（外网访问）
├── service-control.sh     # 🎮 服务管理工具
├── cleanup.sh             # 🧹 深度清理工具
├── setup-access.sh        # 🔐 Cloudflare Access 配置向导
└── service-uninstall.sh   # ❌ 服务卸载（已废弃，请使用 cleanup.sh）
```

---

## 🚀 快速开始

### 第一步：安装本地后台服务

```bash
./setup-service.sh
```

**功能：**
- 检查系统依赖（Node.js、npm）
- 安装项目依赖
- 配置 macOS launchd 系统服务
- 实现进程保活和开机自启

**验证：**
```bash
./service-control.sh status
curl http://localhost:4477/api/health
```

### 第二步：配置 Cloudflare Tunnel（可选）

```bash
./setup-cloudflare.sh
```

**功能：**
- 安装 cloudflared
- 创建 Cloudflare Tunnel
- 配置域名（临时域名或自定义域名）
- 将 Tunnel 配置为系统服务

**两种域名模式：**
1. **临时域名** - 自动生成 `*.trycloudflare.com`，无需配置
2. **自定义域名** - 使用你的域名（需要域名托管在 Cloudflare）

---

## 🎮 服务管理

### service-control.sh - 统一管理工具

```bash
# 查看服务状态
./service-control.sh status

# 启动服务
./service-control.sh start           # 启动所有服务
./service-control.sh start node      # 只启动 Node.js 服务
./service-control.sh start tunnel    # 只启动 Tunnel 服务

# 停止服务
./service-control.sh stop            # 停止所有服务
./service-control.sh stop node       # 只停止 Node.js 服务
./service-control.sh stop tunnel     # 只停止 Tunnel 服务

# 重启服务
./service-control.sh restart         # 重启所有服务
./service-control.sh restart node    # 只重启 Node.js 服务
./service-control.sh restart tunnel  # 只重启 Tunnel 服务

# 查看日志
./service-control.sh logs            # 查看所有日志
./service-control.sh logs node       # 只查看 Node.js 日志
./service-control.sh logs tunnel     # 只查看 Tunnel 日志

# 清理残留
./service-control.sh cleanup         # 清理孤立进程和临时文件
```

---

## 🧹 清理与卸载

### cleanup.sh - 深度清理工具

```bash
./cleanup.sh
```

**清理内容：**
1. ✅ 停止所有系统服务
2. ✅ 清理端口占用（先 TERM 再 KILL）
3. ✅ 清理孤立的 Node.js 和 cloudflared 进程
4. ✅ 清理临时文件和日志
5. ✅ （可选）删除 launchd 服务配置
6. ✅ （可选）删除 Cloudflare Tunnel

**优势：**
- 智能清理，避免遗漏
- 分步确认，防止误删
- 优雅停止 + 强制清理结合

---

## 📊 服务信息

### 系统服务标识

- **Node.js 服务**: `com.myherness.node`
- **Tunnel 服务**: `com.myherness.tunnel`

### 配置文件位置

```
~/Library/LaunchAgents/
├── com.myherness.node.plist      # Node.js 服务配置
└── com.myherness.tunnel.plist    # Tunnel 服务配置

~/.cloudflared/
├── cert.pem                       # Cloudflare 认证
└── <tunnel-id>.json              # Tunnel 凭证

项目目录/.cloudflare/
└── config.yml                     # Tunnel 配置
```

### 日志文件

```
项目目录/logs/
├── node-service.log              # Node.js 标准输出
├── node-service.error.log        # Node.js 错误输出
├── tunnel-service.log            # Tunnel 标准输出
└── tunnel-service.error.log      # Tunnel 错误输出
```

---

## 🔐 配置访问认证

### setup-access.sh - Cloudflare Access 向导

```bash
./setup-access.sh
```

**功能：**
- 提供 Cloudflare Access 配置步骤
- 配置邮箱验证登录
- 保护你的应用不被公开访问

**配置后效果：**
- 访问你的域名时需要邮箱验证
- 只有授权邮箱才能登录

---

## 🛠 常见问题

### 1. 端口被占用

```bash
# 方法 1: 使用 cleanup 清理
./service-control.sh cleanup

# 方法 2: 手动清理
lsof -ti:4477 | xargs kill -9
```

### 2. 服务启动失败

```bash
# 查看错误日志
tail -f logs/node-service.error.log
tail -f logs/tunnel-service.error.log

# 重新安装服务
./cleanup.sh
./setup-service.sh
```

### 3. Tunnel 连接失败

```bash
# 检查 Tunnel 状态
cloudflared tunnel list
cloudflared tunnel info myherness-tunnel

# 重启 Tunnel
./service-control.sh restart tunnel

# 查看 Tunnel 日志
./service-control.sh logs tunnel
```

### 4. 获取临时域名

```bash
# 查看 Tunnel 日志获取自动生成的域名
tail -f logs/tunnel-service.log | grep trycloudflare.com
```

### 5. 完全重置

```bash
# 完全清理并重新安装
./cleanup.sh              # 选择删除所有配置
./setup-service.sh        # 重新安装本地服务
./setup-cloudflare.sh     # 重新配置 Tunnel
```

---

## ✨ 特性

### 后台服务保活
- ✅ 开机自动启动
- ✅ 进程崩溃自动重启
- ✅ 后台静默运行
- ✅ 完整的日志记录
- ✅ 资源限制（10秒重启间隔）

### Cloudflare Tunnel
- ✅ 自动 HTTPS 加密
- ✅ 无需公网 IP
- ✅ 无需端口转发
- ✅ 支持自定义域名
- ✅ 断线自动重连

### 清理逻辑
- ✅ 优雅停止（SIGTERM）
- ✅ 强制清理（SIGKILL）
- ✅ 端口占用检测
- ✅ 孤立进程清理
- ✅ 临时文件清理

---

## 📝 脚本对比

### 旧脚本 vs 新脚本

| 旧脚本 | 新脚本 | 说明 |
|--------|--------|------|
| `service-install.sh` | `setup-service.sh` | 只负责本地服务安装 |
| `service-install.sh` | `setup-cloudflare.sh` | 只负责 Cloudflare 配置 |
| `deploy.sh` | **已废弃** | 功能已合并到上述脚本 |
| `service-uninstall.sh` | `cleanup.sh` | 增强的清理逻辑 |
| - | `service-control.sh` | 增强的服务管理 |

### 改进点

1. **职责分离** - 本地服务和 Cloudflare 配置分开
2. **清理增强** - 优雅停止 + 强制清理，避免残留
3. **灵活控制** - 可以分别管理 Node.js 和 Tunnel 服务
4. **错误处理** - 更完善的错误检测和提示
5. **用户友好** - 更清晰的输出和交互

---

## 🔄 迁移指南

### 从旧脚本迁移

```bash
# 1. 卸载旧服务
./service-uninstall.sh

# 2. 使用新脚本
./setup-service.sh
./setup-cloudflare.sh

# 3. 验证
./service-control.sh status
```

---

## 📖 使用建议

1. **开发环境** - 只运行 `setup-service.sh`，不需要 Tunnel
2. **生产环境** - 两个脚本都运行，提供外网访问
3. **定期维护** - 定期运行 `cleanup.sh` 清理日志和临时文件
4. **问题排查** - 先查看 `status`，再查看 `logs`，最后尝试 `cleanup`

---

## 📄 许可

本脚本集为项目内部工具，仅供本项目使用。
