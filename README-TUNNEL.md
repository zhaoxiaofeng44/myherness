# Cloudflare Tunnel 部署指南

本项目已配置 Cloudflare Tunnel，可以将本地服务安全地暴露到公网。

## 快速开始

### 方式 1：临时测试（推荐新手）

使用自动生成的临时域名，无需配置：

```bash
./start-tunnel-quick.sh
```

启动后会显示类似 `https://xxx.trycloudflare.com` 的临时域名，可直接访问。

**优点：**
- 无需配置，一键启动
- 适合快速测试和演示

**缺点：**
- 每次重启域名会变化
- 域名较长且不易记忆

### 方式 2：持久化域名（推荐生产）

使用固定的自定义域名（需要先在 Cloudflare 托管域名）：

```bash
# 首次运行：初始化配置
./deploy.sh

# 日常使用：快速启动
./start-tunnel.sh
```

**优点：**
- 固定域名，不会变化
- 可以自定义域名
- 支持 HTTPS

**缺点：**
- 需要有 Cloudflare 托管的域名
- 首次配置稍复杂

## 脚本说明

| 脚本 | 用途 | 使用场景 |
|------|------|----------|
| `deploy.sh` | 初始化配置 | 首次部署时运行一次 |
| `start-tunnel.sh` | 启动服务（持久域名） | 已配置自定义域名后使用 |
| `start-tunnel-quick.sh` | 快速启动（临时域名） | 测试、演示、快速分享 |
| `stop-tunnel.sh` | 停止所有服务 | 关闭服务时使用 |

## 详细步骤

### 首次部署

1. **运行部署脚本**
   ```bash
   ./deploy.sh
   ```

2. **选择域名模式**
   - 选项 1：使用临时域名（trycloudflare.com）- 无需配置
   - 选项 2：使用自定义域名 - 需要输入域名信息

3. **完成配置**
   - 脚本会自动安装 `cloudflared`（如果未安装）
   - 引导完成 Cloudflare 授权
   - 创建 Tunnel 并生成配置文件

### 日常使用

**启动服务：**
```bash
# 使用持久域名
./start-tunnel.sh

# 或使用临时域名
./start-tunnel-quick.sh
```

**停止服务：**
```bash
./stop-tunnel.sh

# 或按 Ctrl+C（如果在前台运行）
```

**查看日志：**
```bash
tail -f server.log
```

**检查服务状态：**
```bash
# 检查本地服务
curl http://localhost:4477/api/health

# 检查 Cloudflare Tunnel
cloudflared tunnel list
```

## 配置文件

- `.cloudflare/config.yml` - Tunnel 配置文件
- `~/.cloudflared/` - Cloudflare 凭证目录
- `server.log` - 服务运行日志

## 常见问题

### Q: cloudflared 安装失败？
A: 确保已安装 Homebrew：
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### Q: 端口被占用？
A: 停止现有服务或修改 `server.js` 中的 `PORT` 环境变量：
```bash
./stop-tunnel.sh
# 或
lsof -ti:4477 | xargs kill -9
```

### Q: 临时域名每次都变化？
A: 这是 trycloudflare.com 的特性。如需固定域名，请使用方式 2 配置自定义域名。

### Q: 如何更改域名？
A: 编辑 `.cloudflare/config.yml` 文件，修改 `hostname` 字段，然后运行：
```bash
cloudflared tunnel route dns <tunnel-name> <new-domain>
```

### Q: 服务启动失败？
A: 检查日志文件：
```bash
tail -f server.log
```

### Q: 如何删除 Tunnel？
A: 
```bash
cloudflared tunnel delete <tunnel-name>
rm -rf .cloudflare/
```

## 安全建议

1. **不要提交凭证文件**
   - `.cloudflare/` 目录已加入 `.gitignore`
   - `~/.cloudflared/` 包含敏感信息，请妥善保管

2. **使用环境变量**
   - 敏感配置建议通过环境变量传递
   - 避免硬编码 API 密钥等信息

3. **定期更新**
   ```bash
   brew upgrade cloudflared
   ```

4. **监控访问日志**
   - Cloudflare Dashboard 可查看访问统计
   - 异常流量及时告警

## 高级功能

### 后台运行

如果需要服务在后台持续运行：

```bash
# 启动
npm start > server.log 2>&1 &
cloudflared tunnel --config .cloudflare/config.yml run <tunnel-name> &

# 查看进程
ps aux | grep -E "node|cloudflared"
```

### 使用 PM2 管理进程

```bash
# 安装 PM2
npm install -g pm2

# 启动服务
pm2 start server.js --name myherness
pm2 save
pm2 startup

# 启动 Tunnel（需要单独管理）
cloudflared service install
```

### 多端口映射

编辑 `.cloudflare/config.yml`：

```yaml
ingress:
  - hostname: app.your-domain.com
    service: http://localhost:4477
  - hostname: api.your-domain.com
    service: http://localhost:3000
  - service: http_status:404
```

## 技术支持

- Cloudflare Tunnel 文档: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/
- Cloudflare Dashboard: https://dash.cloudflare.com/
- 项目问题反馈: [在此添加您的反馈渠道]

## 许可证

与主项目相同
