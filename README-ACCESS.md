# Cloudflare Access 配置文档

## 📋 概述

本文档说明如何为 Cloudflare Tunnel 配置邮箱访问认证，保护你的应用。

**配置信息：**
- 域名：`claude.oxllxo.cc.cd`
- 授权邮箱：`345480277@qq.com`
- 协议：HTTP/2
- 认证方式：One-time PIN（邮箱验证码）

---

## 🚀 快速配置

### 自动向导

```bash
./setup-access.sh
```

脚本会：
1. 显示详细配置步骤
2. 自动打开 Cloudflare Dashboard
3. 提供配置参数参考

---

## 🔧 手动配置步骤

### 步骤 1：登录 Cloudflare Dashboard

1. 访问 [Cloudflare Zero Trust](https://one.dash.cloudflare.com/)
2. 使用你的 Cloudflare 账号登录

### 步骤 2：创建 Zero Trust Team

**首次使用需要：**

1. 点击 **Zero Trust**
2. 创建一个 Team（团队名称随意）
3. 选择 **Free Plan**（免费计划，支持最多 50 个用户）

### 步骤 3：配置身份验证方法

1. 进入 `Settings > Authentication`
2. 点击 **Add new** 添加登录方法
3. 选择 **One-time PIN**
4. 保存配置

### 步骤 4：创建 Access 应用

1. 进入 `Access > Applications`
2. 点击 **Add an application**
3. 选择 **Self-hosted**
4. 填写应用信息：

```
Application name: MyHerness
Session Duration: 24 hours
```

5. 配置应用域名：

```
Application domain:
  - Domain: claude.oxllxo.cc.cd
  - Path: /
```

6. 点击 **Next**

### 步骤 5：配置访问策略

1. **Policy name**: `Email Authentication`
2. **Action**: `Allow`
3. **Configure rules**:
   - Click **Add a rule**
   - Selector: **Emails**
   - Value: `345480277@qq.com`

4. 点击 **Save** 保存策略
5. 点击 **Next** 继续
6. 点击 **Add application** 完成创建

---

## ✅ 验证配置

### 测试访问

1. 在浏览器访问：`https://claude.oxllxo.cc.cd`
2. 应该会看到 Cloudflare Access 登录页面
3. 输入邮箱：`345480277@qq.com`
4. 检查邮箱收到的验证码（6 位数字）
5. 输入验证码完成登录
6. 登录成功后会跳转到你的应用

### 验证 HTTP/2

1. 打开浏览器开发者工具（F12）
2. 切换到 **Network** 标签
3. 刷新页面
4. 查看请求的 **Protocol** 列
5. 应该显示 `h2`（HTTP/2）

---

## 🔄 重启服务使配置生效

### 如果使用临时启动

```bash
# 停止现有服务
./stop-tunnel.sh

# 重新启动
./start-tunnel.sh
```

### 如果使用系统服务

```bash
# 重启服务
./service-control.sh restart

# 查看日志确认
./service-control.sh logs-tunnel
```

---

## 🎯 配置说明

### HTTP/2 配置

已在 `.cloudflare/config.yml` 中启用：

```yaml
# 全局协议设置
protocol: http2

ingress:
  - hostname: claude.oxllxo.cc.cd
    service: http://localhost:4477
    originRequest:
      httpHostHeader: claude.oxllxo.cc.cd
      originServerName: claude.oxllxo.cc.cd
      noTLSVerify: false
      connectTimeout: 30s
      tlsTimeout: 10s
      tcpKeepAlive: 30s
      keepAliveConnections: 100
      keepAliveTimeout: 90s
```

**优势：**
- ✅ 性能提升（多路复用）
- ✅ 降低延迟
- ✅ 头部压缩
- ✅ 服务器推送支持

### Access 认证流程

```
用户访问 https://claude.oxllxo.cc.cd
        ↓
Cloudflare Access 拦截
        ↓
显示登录页面（要求输入邮箱）
        ↓
用户输入：345480277@qq.com
        ↓
Cloudflare 发送验证码到邮箱
        ↓
用户输入验证码
        ↓
验证通过 → 创建 Session（24小时）
        ↓
允许访问应用
```

---

## 🔐 安全特性

### 已启用

- ✅ 邮箱白名单（只允许 345480277@qq.com）
- ✅ One-time PIN（一次性验证码）
- ✅ Session 超时（24 小时）
- ✅ HTTPS 强制加密
- ✅ HTTP/2 协议

### 可选增强

1. **多因素认证（MFA）**
   - 配置 TOTP（Google Authenticator）
   - 配置 WebAuthn（硬件密钥）

2. **设备信任**
   - 启用设备认证
   - 限制设备数量

3. **地理位置限制**
   - 配置允许的国家/地区
   - IP 白名单

4. **审计日志**
   - 记录所有访问尝试
   - 监控异常行为

---

## 📊 管理用户访问

### 添加更多邮箱

1. 进入 `Access > Applications`
2. 找到 **MyHerness** 应用
3. 点击 **Edit**
4. 修改策略规则：

```
Emails: 345480277@qq.com, another@example.com
```

### 撤销访问

1. 进入 `Access > Applications`
2. 点击应用的 **Edit**
3. 修改或删除策略规则
4. 点击 **Save**

### 查看访问日志

1. 进入 `Logs > Access`
2. 查看所有登录记录
3. 筛选特定用户或时间段

---

## 🐛 故障排查

### 无法收到验证码

**原因：**
- 邮箱地址错误
- 邮件被归类为垃圾邮件
- Cloudflare 邮件服务延迟

**解决方案：**
1. 检查垃圾邮件文件夹
2. 将 `no-reply@cloudflareaccess.com` 添加到白名单
3. 等待 2-3 分钟重试

### Access 页面不显示

**原因：**
- 配置未生效
- DNS 解析问题
- Tunnel 未运行

**解决方案：**
```bash
# 检查 Tunnel 状态
./service-control.sh status

# 查看 Tunnel 日志
./service-control.sh logs-tunnel

# 测试 DNS 解析
nslookup claude.oxllxo.cc.cd

# 重启服务
./service-control.sh restart
```

### 验证码过期

**原因：**
- 验证码有效期 10 分钟

**解决方案：**
1. 点击 **Resend code**
2. 使用新的验证码

### Session 频繁过期

**原因：**
- 默认 24 小时过期
- Cookie 被清除

**解决方案：**
1. 进入应用配置
2. 修改 **Session Duration** 为更长时间（最长 1 个月）
3. 保存配置

---

## 🎨 自定义登录页面

### 品牌定制

1. 进入 `Settings > Authentication > Login Methods`
2. 点击 **Customize**
3. 配置：
   - Logo
   - 背景颜色
   - 文字内容

### 自定义域名

1. 使用自己的域名作为 Access 登录页
2. 配置 CNAME 记录
3. 上传 SSL 证书

---

## 📈 监控和分析

### 查看统计

1. 进入 `Analytics > Access`
2. 查看：
   - 总请求数
   - 登录成功率
   - 被拒绝的请求
   - 活跃用户

### 设置告警

1. 进入 `Notifications`
2. 配置告警规则：
   - 异常登录尝试
   - 新设备登录
   - 策略变更

---

## 💰 费用说明

### 免费计划（Free Plan）

- ✅ 最多 50 个用户
- ✅ One-time PIN 认证
- ✅ 基础访问策略
- ✅ 7 天日志保留

### 付费计划（如需升级）

- Pro: $7/user/month，支持更多用户和高级功能
- Business: 联系销售，企业级功能

---

## 📚 相关文档

- [Cloudflare Access 官方文档](https://developers.cloudflare.com/cloudflare-one/policies/access/)
- [One-time PIN 认证](https://developers.cloudflare.com/cloudflare-one/identity/one-time-pin/)
- [HTTP/2 配置](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/configuration/ingress/)
- [Zero Trust Dashboard](https://one.dash.cloudflare.com/)

---

## ✅ 配置清单

完成以下步骤确保配置正确：

- [ ] 已登录 Cloudflare Dashboard
- [ ] 已创建 Zero Trust Team
- [ ] 已启用 One-time PIN 认证方法
- [ ] 已创建 MyHerness Access 应用
- [ ] 已配置域名：claude.oxllxo.cc.cd
- [ ] 已添加邮箱策略：345480277@qq.com
- [ ] 已更新 Tunnel 配置为 HTTP/2
- [ ] 已重启 Tunnel 服务
- [ ] 已测试访问并验证邮箱登录
- [ ] 已验证 HTTP/2 协议生效

---

**配置完成后，你的应用将受到 Cloudflare Access 保护，只有授权的邮箱才能访问！**
