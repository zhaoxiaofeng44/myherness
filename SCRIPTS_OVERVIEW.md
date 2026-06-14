# 脚本重构总览

## 🎯 重构目标

将混杂的部署脚本重构为：
1. **职责分离** - 本地服务和 Cloudflare 配置分开
2. **清理增强** - 完善的残留清理逻辑
3. **灵活控制** - 可分别管理不同服务

---

## 📊 脚本结构对比

### ❌ 旧结构（混乱）

```
service-install.sh         # 既装本地服务，又配 Cloudflare（耦合严重）
deploy.sh                  # 功能与 service-install.sh 重复
service-control.sh         # 功能较弱，不支持分别控制
service-uninstall.sh       # 清理不够彻底，可能有残留
setup-access.sh           # 只是配置向导（保留）
```

**问题：**
- `service-install.sh` 做了太多事情，难以维护
- `deploy.sh` 和 `service-install.sh` 功能重复
- 清理逻辑不完善，容易残留进程
- 无法灵活控制单个服务

---

## ✅ 新结构（清晰）

```
1️⃣ setup-service.sh       # 专注：本地后台服务安装
   ├─ 检查依赖
   ├─ 安装 npm 依赖
   ├─ 清理旧服务和端口
   └─ 创建 Node.js 系统服务

2️⃣ setup-cloudflare.sh    # 专注：Cloudflare Tunnel 配置
   ├─ 检查本地服务
   ├─ 安装 cloudflared
   ├─ 创建/配置 Tunnel
   ├─ 配置域名（临时/自定义）
   └─ 创建 Tunnel 系统服务

3️⃣ service-control.sh     # 增强：统一服务管理
   ├─ 支持分别管理 node/tunnel
   ├─ 智能清理残留进程
   └─ 优雅停止 + 强制清理

4️⃣ cleanup.sh             # 新增：深度清理工具
   ├─ 优雅停止（SIGTERM）
   ├─ 强制清理（SIGKILL）
   ├─ 清理孤立进程
   ├─ 清理临时文件
   └─ 可选删除配置

5️⃣ setup-access.sh        # 保留：配置向导
```

---

## 🔄 使用流程对比

### 旧流程

```bash
# 一次性安装所有
./service-install.sh      # 同时配置本地服务 + Cloudflare（耦合）

# 或
./deploy.sh               # 功能重复，容易混淆

# 卸载
./service-uninstall.sh    # 可能有残留
```

### 新流程

```bash
# 第一步：安装本地服务
./setup-service.sh

# 第二步（可选）：配置外网访问
./setup-cloudflare.sh

# 管理服务
./service-control.sh status
./service-control.sh start node
./service-control.sh restart tunnel

# 完全清理
./cleanup.sh
```

---

## ✨ 改进点

### 1. 职责分离

**旧方式：**
- `service-install.sh` 既装本地服务，又配 Cloudflare
- 如果只想装本地服务，没办法跳过 Cloudflare 配置

**新方式：**
- `setup-service.sh` - 只装本地服务
- `setup-cloudflare.sh` - 只配 Cloudflare
- 可以根据需求选择性运行

### 2. 清理增强

**旧方式：**
```bash
# service-uninstall.sh
launchctl unload plist
kill -9 $(lsof -ti:4477)  # 直接暴力清理
```

**新方式：**
```bash
# cleanup.sh
kill -TERM <pid>          # 先优雅停止
sleep 2
kill -9 <pid>             # 再强制清理
# + 清理孤立进程
# + 清理临时文件
# + 分步确认
```

### 3. 灵活控制

**旧方式：**
```bash
./service-control.sh restart  # 只能重启所有服务
```

**新方式：**
```bash
./service-control.sh restart node     # 只重启 Node.js
./service-control.sh restart tunnel   # 只重启 Tunnel
./service-control.sh restart all      # 重启所有
```

### 4. 错误处理

**旧方式：**
- 依赖检查不完善
- 端口占用直接报错退出

**新方式：**
- 完善的依赖检查
- 自动清理端口占用
- 更友好的错误提示

---

## 🗂 文件清单

### 保留的文件（修改）
- ✅ `service-control.sh` - 已增强

### 保留的文件（不变）
- ✅ `setup-access.sh` - 配置向导，保持不变

### 新增的文件
- 🆕 `setup-service.sh` - 本地服务安装
- 🆕 `setup-cloudflare.sh` - Cloudflare 配置
- 🆕 `cleanup.sh` - 深度清理工具
- 🆕 `SCRIPTS_README.md` - 脚本使用文档
- 🆕 `SCRIPTS_OVERVIEW.md` - 本文档

### 可以废弃的文件
- ❌ `service-install.sh` - 功能已拆分到 setup-*.sh
- ❌ `deploy.sh` - 功能重复，已废弃
- ❌ `service-uninstall.sh` - 由 cleanup.sh 替代

### 其他脚本（保持不变）
- `start-tunnel.sh`
- `stop-tunnel.sh`
- `restart-tunnel.sh`
- `start-tunnel-quick.sh`
- `restart.sh`

---

## 🚀 迁移步骤

### 如果已经使用旧脚本

```bash
# 1. 停止旧服务
./service-control.sh stop

# 2. 清理旧配置
./cleanup.sh

# 3. 重新安装
./setup-service.sh
./setup-cloudflare.sh

# 4. 验证
./service-control.sh status
```

### 如果是新项目

```bash
# 直接使用新脚本
./setup-service.sh
./setup-cloudflare.sh
```

---

## 📋 快速命令对照表

| 操作 | 旧命令 | 新命令 |
|------|--------|--------|
| 安装所有 | `./service-install.sh` | `./setup-service.sh && ./setup-cloudflare.sh` |
| 只装本地 | ❌ 无法单独安装 | `./setup-service.sh` |
| 只装 Tunnel | ❌ 无法单独安装 | `./setup-cloudflare.sh` |
| 查看状态 | `./service-control.sh status` | `./service-control.sh status` |
| 启动所有 | `./service-control.sh start` | `./service-control.sh start` |
| 启动单个 | ❌ 不支持 | `./service-control.sh start node` |
| 重启单个 | ❌ 不支持 | `./service-control.sh restart tunnel` |
| 查看日志 | `./service-control.sh logs-node` | `./service-control.sh logs node` |
| 清理残留 | ❌ 不支持 | `./service-control.sh cleanup` |
| 完全卸载 | `./service-uninstall.sh` | `./cleanup.sh` |

---

## 💡 使用建议

### 开发环境
```bash
./setup-service.sh           # 只需本地服务
./service-control.sh logs node
```

### 生产环境
```bash
./setup-service.sh           # 本地服务
./setup-cloudflare.sh        # 外网访问
./setup-access.sh            # 访问认证
```

### 问题排查
```bash
./service-control.sh status  # 1. 查看状态
./service-control.sh logs    # 2. 查看日志
./service-control.sh cleanup # 3. 清理残留
./cleanup.sh                 # 4. 深度清理
```

---

## ⚠️ 注意事项

1. **备份重要数据** - 运行 cleanup.sh 前确保重要数据已备份
2. **分步执行** - 新脚本设计为分步执行，不要一次性运行所有
3. **查看日志** - 遇到问题先查看日志，再尝试清理
4. **保留旧脚本** - 可以暂时保留旧脚本，等新脚本稳定后再删除

---

## 🎉 总结

新的脚本结构：
- ✅ **更清晰** - 职责分离，易于理解
- ✅ **更灵活** - 可以分别控制不同服务
- ✅ **更可靠** - 完善的清理逻辑，避免残留
- ✅ **更友好** - 更好的交互和错误提示

建议尽快迁移到新脚本！
