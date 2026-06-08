# 开发计划

## 主流 Agent UI 能力对标分析

| 能力 | ChatGPT | Claude.ai | Cursor | Cline/Continue | 本项目现状 |
|------|---------|-----------|--------|----------------|-----------|
| Markdown 渲染 | ✅ | ✅ | ✅ | ✅ | ❌ 纯文本 |
| 代码高亮 | ✅ highlight.js | ✅ Shiki | ✅ Monaco | ✅ highlight.js | ❌ |
| 代码块复制 | ✅ | ✅ | ✅ | ✅ | ❌ |
| 图片上传 | ✅ | ✅ | ✅ | ✅ | ❌ |
| 图片展示 | ✅ | ✅ | ✅ | ✅ | ❌ |
| 思考折叠 | ✅ | ✅ | - | - | ❌ 截断显示 |
| 表格渲染 | ✅ | ✅ | ✅ | ✅ | ❌ |
| LaTeX 公式 | ✅ KaTeX | ✅ | - | - | ❌ |
| 链接可点击 | ✅ | ✅ | ✅ | ✅ | ❌ |
| HTML 沙箱 | ❌ | ❌ | ❌ | ❌ | ❌ |

## 技术选型（遵循项目零构建工具原则）

- **Markdown 解析**: `marked` (CDN) — 轻量、无依赖、支持 GFM 表格
- **语法高亮**: `highlight.js` (CDN) — 最通用、自动语言检测
- **HTML 安全**: `DOMPurify` (CDN) — 防 XSS，允许安全标签子集
- **LaTeX（暂缓）**: `KaTeX` (CDN) — 体积小、渲染快；本次作为可选项

## 步骤

### Step 1: 引入 CDN 依赖

**文件**: `public/index.html`

- 添加 `marked` (marked.min.js)
- 添加 `highlight.js` (highlight.min.js + github-dark 主题 CSS)
- 添加 `DOMPurify` (purify.min.js)

### Step 2: 实现 Markdown 渲染函数

**文件**: `public/app.js`

- 新增 `renderMarkdown(raw)` 函数：
  - 使用 `marked.parse()` 将 Markdown 转 HTML
  - 配置 `marked` 的 renderer 让代码块走 highlight.js
  - 通过 `DOMPurify.sanitize()` 过滤不安全标签
  - 为每个 `<pre><code>` 包装添加语言标签和复制按钮
- 替换 `renderChatItem()` 中 assistant 消息的 `escapeHtml(it.text)` 为 `renderMarkdown(it.text)`
- tool-result 中如果内容包含代码也走 renderMarkdown

### Step 3: 代码块增强

**文件**: `public/app.js` + `public/style.css`

- 代码块包裹容器：顶部显示语言名、右上角复制按钮
- 复制按钮点击后显示 ✓ 反馈
- 行号（CSS counter）
- 深色主题代码块样式与整体 UI 融合

### Step 4: 图片上传能力

**文件**: `public/index.html` + `public/app.js` + `server.js`

- 输入区域增加图片上传按钮（📎 图标）
- 支持三种途径上传：点击按钮选文件 / 粘贴剪贴板 / 拖拽到输入区
- 图片转 base64 后存入 state，prompt 发送时附带 `images: [{ base64, mimeType }]`
- 预览：上传后在输入区域下方显示缩略图（可删除）
- 服务端：`POST /api/sessions/:id/prompt` 接收 `{ prompt, images }` 透传给 claude CLI

### Step 5: 消息中图片渲染

**文件**: `public/app.js` + `public/style.css`

- Markdown 中的 `![alt](url)` 正常渲染为 `<img>`
- base64 图片内容块渲染为 `<img src="data:...">`
- 图片点击弹出灯箱（lightbox）放大预览
- 图片最大宽度限制为消息区域 80%

### Step 6: 思考过程折叠

**文件**: `public/app.js` + `public/style.css`

- thinking 消息改为 `<details><summary>` 结构
- summary 显示前 80 字符 + "…（点击展开）"
- 展开后显示完整内容（不再截断 600 字）

### Step 7: 样式完善

**文件**: `public/style.css`

- Markdown 元素样式（h1-h6、blockquote、table、hr、ul/ol）
- 代码块容器样式
- 图片/灯箱样式
- 上传预览样式
- 确保与现有深色主题一致

### Step 8: HTML 内容安全展示

**文件**: `public/app.js`

- 如果 Claude 回复中包含 HTML 代码片段（作为代码展示而非执行），
  marked 的代码块渲染已能处理（`` ```html `` 围栏）
- 对于意图展示 HTML 效果的场景，提供「预览」按钮在 iframe sandbox 中渲染

## 风险与不确定点

1. **CDN 可用性** — 如在内网环境需改为本地文件；暂用 jsdelivr CDN
2. **图片体积** — base64 大图会让 JSON 体积膨胀；限制单张 5MB、总计 20MB
3. **claude CLI 图片支持** — `claude --print` 是否支持 image content block；需验证 `--input-format` 参数
4. **DOMPurify 白名单** — 需精心配置，既不过度屏蔽 Markdown 输出标签，又不放过 XSS
5. **性能** — 大量消息时批量 `marked.parse()` 可能卡顿；可用虚拟滚动或惰性渲染缓解（本期暂不做虚拟滚动）
