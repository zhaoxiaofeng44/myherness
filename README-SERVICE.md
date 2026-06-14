# 系统服务部署文档

## 📋 概述

本文档提供完整的系统服务部署方案，将项目和 Cloudflare Tunnel 配置为 macOS 系统服务，实现：

- ✅ **开机自启** - 系统重启后自动启动
- ✅ **进程保活** - 崩溃后自动重启
- ✅ **后台运行** - 静默运行，不占用终端
- ✅ **日志记录** - 完整的运行日志
- ✅ **外网访问** - 通过 Cloudflare Tunnel 代理

---

## 🚀 快速开始

### 一键安装

```bash
./service-install.sh
```

安装脚本会自动完成：
1. 检查系统依赖（Node.js, npm, cloudflared）
2. 配置 Cloudflare Tunnel
3. 创建系统服务配置
4. 启动服务并验证

### 服务管理

```bash
# 查看服务状态
./service-control.sh status

# 启动服务
./service-control.sh start

# 停止服务
./service-control.sh stop

# 重启服务
./service-control.sh restart

# 查看实时日志
./service-control.sh logs

# 查看 Node.js 日志
./service-control.sh logs-node

# 查看 Tunnel 日志
./service-control.sh logs-tunnel
```

### 卸载服务

```bash
./service-uninstall.sh
```

---

## 📦 文件说明

### 核心脚本

| 文件 | 用途 | 说明 |
|------|------|------|
| `service-install.sh` | 服务安装 | 一键安装并配置系统服务 |
| `service-control.sh` | 服务控制 | 启动/停止/重启/查看状态 |
| `service-uninstall.sh` | 服务卸载 | 完全卸载系统服务 |

### 配置文件

服务配置文件位于：`~/Library/LaunchAgents/`

- `com.myherness.node.plist` - Node.js 服务配置
- `com.myherness.tunnel.plist` - Cloudflare Tunnel 服务配置

### 日志文件

服务日志位于：`./logs/`

- `node-service.log` - Node.js 标准输出
- `node-service.error.log` - Node.js 错误输出
- `tunnel-service.log` - Tunnel 标准输出
- `tunnel-service.error.log` - Tunnel 错误输出

---

## 🔧 详细配置

### 安装过程详解

#### 1. 检查依赖

脚本会自动检查并安装：
- Node.js
- npm
- cloudflared（通过 Homebrew）

#### 2. Cloudflare 配置

**首次使用需要登录 Cloudflare：**

```bash
cloudflared tunnel login
```

**选择域名模式：**

- **选项 1：临时域名**（推荐测试）
  - 无需配置
  - 自动生成 `*.trycloudflare.com` 域名
  - 适合开发和测试

- **选项 2：自定义域名**
  - 需要 Cloudflare 托管的域名
  - 提供固定的访问地址
  - 适合生产环境

#### 3. 服务特性

**Node.js 服务：**
- 工作目录：项目根目录
- 启动命令：`npm start`
- 端口：4477
- 自动重启：崩溃后 10 秒重启

**Cloudflare Tunnel 服务：**
- 配置文件：`.cloudflare/config.yml`
- 自动重启：崩溃后 10 秒重启
- 日志记录：完整的连接日志

---

## 📊 服务状态监控

### 查看服务状态

```bash
./service-control.sh status
```

**输出示例：**

```
======================================
  服务状态
======================================

Node.js 服务:
  状态: ✓ 运行中
  PID: 12345
  端口: 4477 (✓ 监听中, PID: 12345)

Cloudflare Tunnel:
  状态: ✓ 运行中
  PID: 12346

日志文件:
  Node.js: ./logs/node-service.log (1.2M)
  Tunnel: ./logs/tunnel-service.log (856K)
```

### 使用 launchctl 命令

```bash
# 列出所有服务
launchctl list | grep myherness

# 查看服务详情
launchctl list com.myherness.node
launchctl list com.myherness.tunnel

# 手动启动服务
launchctl load ~/Library/LaunchAgents/com.myherness.node.plist
launchctl load ~/Library/LaunchAgents/com.myherness.tunnel.plist

# 手动停止服务
launchctl unload ~/Library/LaunchAgents/com.myherness.node.plist
launchctl unload ~/Library/LaunchAgents/com.myherness.tunnel.plist
```

---

## 🐛 故障排查

### 服务无法启动

**1. 检查日志文件**

```bash
# 查看 Node.js 错误
tail -f ./logs/node-service.error.log

# 查看 Tunnel 错误
tail -f ./logs/tunnel-service.error.log
```

**2. 检查端口占用**

```bash
# 查看端口状态
lsof -i:4477

# 杀死占用进程
lsof -ti:4477 | xargs kill -9
```

**3. 检查配置文件**

```bash
# 验证 Tunnel 配置
cat .cloudflare/config.yml

# 测试 Tunnel 连接
cloudflared tunnel --config .cloudflare/config.yml run myherness-tunnel
```

### Node.js 服务崩溃

**常见原因：**
- 端口被占用
- 依赖未安装
- 环境变量缺失

**解决方案：**

```bash
# 安装依赖
npm install

# 测试手动启动
npm start

# 检查环境变量
cat ~/Library/LaunchAgents/com.myherness.node.plist
```

### Tunnel 无法连接

**常见原因：**
- 认证过期
- Tunnel 配置错误
- 网络问题

**解决方案：**

```bash
# 重新登录
cloudflared tunnel login

# 列出 Tunnel
cloudflared tunnel list

# 删除并重建
cloudflared tunnel delete myherness-tunnel
./service-install.sh
```

---

## 🔄 更新服务

### 更新项目代码

```bash
# 拉取最新代码
git pull

# 安装新依赖
npm install

# 重启服务
./service-control.sh restart
```

### 更新服务配置

```bash
# 1. 停止服务
./service-control.sh stop

# 2. 修改 plist 文件
nano ~/Library/LaunchAgents/com.myherness.node.plist

# 3. 重新加载
./service-control.sh start
```

### 更新 Cloudflare 配置

```bash
# 1. 停止服务
./service-control.sh stop

# 2. 修改配置
nano .cloudflare/config.yml

# 3. 重启服务
./service-control.sh start
```

---

## 🔐 安全建议

### 1. 日志轮转

服务日志会持续增长，建议配置日志轮转：

```bash
# 创建日志轮转配置
cat > /usr/local/etc/logrotate.d/myherness <<EOF
/Users/$(whoami)/myherness/logs/*.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
}
EOF
```

### 2. 限制访问

如果使用自定义域名，建议配置：
- Cloudflare Access（访问控制）
- WAF 规则（防火墙）
- Rate Limiting（限流）

### 3. 监控告警

建议配置监控：
- 使用 Cloudflare Analytics
- 配置健康检查
- 设置告警通知

---

## 🌐 外网访问

### 临时域名模式

服务启动后，查看日志获取临时域名：

```bash
tail -f ./logs/tunnel-service.log | grep "trycloudflare.com"
```

输出示例：
```
https://abc-def-123.trycloudflare.com
```

### 自定义域名模式

如果配置了自定义域名，访问地址为：

```
https://your-subdomain.your-domain.com
```

### 获取当前 Tunnel URL

```bash
# 方法 1：查看日志
./service-control.sh logs-tunnel | grep -E "http|Registered"

# 方法 2：查看配置
cat .cloudflare/config.yml | grep hostname
```

---

## 💡 高级用法

### 环境变量配置

编辑服务 plist 文件添加环境变量：

```bash
nano ~/Library/LaunchAgents/com.myherness.node.plist
```

在 `<dict>` 中添加：

```xml
<key>EnvironmentVariables</key>
<dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PORT</key>
    <string>4477</string>
    <key>YOUR_VAR</key>
    <string>your_value</string>
</dict>
```

### 多实例部署

如需运行多个实例：

```bash
# 复制项目
cp -r myherness myherness-2

# 修改配置
cd myherness-2
# 修改 service-install.sh 中的 PROJECT_NAME 和 LOCAL_PORT

# 安装服务
./service-install.sh
```

### 性能优化

编辑 plist 文件优化性能：

```xml
<key>ProcessType</key>
<string>Background</string>

<key>Nice</key>
<integer>-10</integer>

<key>LowPriorityIO</key>
<false/>
```

---

## 📚 参考资料

- [Cloudflare Tunnel 文档](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/)
- [macOS launchd 文档](https://www.launchd.info/)
- [Node.js 进程管理](https://nodejs.org/api/process.html)

---

## ❓ 常见问题

**Q: 服务会在系统重启后自动启动吗？**  
A: 是的，配置了 `RunAtLoad` 参数，系统启动时会自动加载服务。

**Q: 如何查看服务是否正在运行？**  
A: 运行 `./service-control.sh status` 或 `launchctl list | grep myherness`

**Q: 临时域名会变化吗？**  
A: 是的，每次 Tunnel 重启时临时域名都会变化。建议使用自定义域名。

**Q: 如何更改服务端口？**  
A: 修改项目配置和 plist 文件中的 `LOCAL_PORT` 参数。

**Q: 服务占用多少资源？**  
A: Node.js 服务约 50-100MB 内存，cloudflared 约 20-30MB 内存。

**Q: 可以同时运行多个 Tunnel 吗？**  
A: 可以，创建不同的 Tunnel 名称和配置文件即可。

---

## 📞 支持

如遇到问题，请：
1. 查看日志文件
2. 运行 `./service-control.sh status` 检查状态
3. 参考故障排查章节
4. 查阅 Cloudflare 官方文档
