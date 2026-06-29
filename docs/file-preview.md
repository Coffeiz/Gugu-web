# 文件预览与音频播放设计

> **状态**：✅ 全部格式已上线
> **分类**：技术实现
> **更新时间**：2026-06-19

---

## 一、核心约束：私有文件认证

咕咕的所有文件存储在私有空间，API 需要携带 `Authorization: Bearer <token>` 才能访问。

```
图片 / 文本 / PDF / Office / 音频：
  fetch('/files/{id}/download', { Authorization: Bearer token })
  → res.blob() → URL.createObjectURL(blob) → Viewer

视频：
  GET /files/{id}/stream-url  →  { url: "/api/v1/files/{id}/stream?token=xxx" }
  → <video src="url">  （浏览器原生流式播放，支持 Range / seeking）
```

---

## 二、支持格式一览

| 类型 | 格式 | 渲染方式 |
|------|------|---------|
| PDF | PDF | blob URL → PdfViewer（PDF.js） |
| 图片 | JPG、JPEG、PNG、GIF、WEBP、SVG、BMP | blob URL → ImageViewer（缩放拖拽） |
| 代码 | JS、TS、CSS、HTML、PY、YAML、XML、SH、JSON | blob URL → TextViewer + highlight.js |
| 纯文本 | TXT、CSV | blob URL → TextViewer 行号表格 |
| Markdown | MD | blob URL → TextViewer + marked HTML 渲染 |
| 视频 | MP4、WEBM、MOV、M4V、OGV | 后端签名 URL → VideoViewer 原生流式 |
| Office | DOC、DOCX、XLS、XLSX、PPT、PPTX | 后端 LibreOffice 转 PDF → PdfViewer |
| 音频 | MP3、WAV、OGG、FLAC、M4A、AAC、OPUS | 拦截至迷你播放器（不进预览抽屉） |

### 不预览（直接下载）

ZIP / RAR / 7Z / EXE / DMG 等二进制/压缩包，点击文件卡片不触发预览。

---

## 三、弹窗形态：右侧全高抽屉

**不使用居中弹窗**，预览面板从右侧滑入，`width: 60vw`，左侧背景半透明可见。

```
.fp-root      position:fixed; inset:0; z-index:1001
  .fp-overlay   遮罩，rgba(20,22,30,0.25) + blur(4px)，点击关闭
  .fp-panel     position:absolute; right:0; top:0; bottom:0; width:60vw
                border-radius:20px 0 0 20px; 玻璃质感
                display:flex; flex-direction:column
    .fp-header  顶栏（固定高度）
    .fp-body    flex:1; position:relative; overflow:hidden
      <Viewer>  position:absolute; inset:0
```

**动画**：Teleport to body + `<Transition :duration="{enter:420,leave:280}">`
- 入场：`cubic-bezier(0.16, 1, 0.3, 1)` 420ms（spring 感，末段减速）
- 退场：`cubic-bezier(0.4, 0, 0.8, 0.6)` 260ms（加速弹出）
- 遮罩纯 opacity，面板 translateX(100%) → 0

**z-index**：1001，高于咕咕悬浮球（1000）。

---

## 四、组件架构

```
FilePreviewModal.vue      右侧抽屉壳
  .fp-header              顶栏：ext徽章 / 文件名 / 下载 / 关闭
  .fp-body
    ├── PdfViewer.vue     ✅ PDF.js 自渲染（也处理 Office 转换结果）
    ├── ImageViewer.vue   ✅ 缩放拖拽
    ├── TextViewer.vue    ✅ 代码高亮 / MD渲染 / 纯文本
    └── VideoViewer.vue   ✅ 流式播放 + HDR

AiFloatBall.vue（迷你播放器）
    └── 音频由 DefaultLayout 拦截，不进预览抽屉
```

### 职责划分

| 层 | 负责 | 不负责 |
|----|------|--------|
| **FilePreviewModal** | 抽屉框架、顶栏、fetch blob / 获取签名URL、生命周期、加载/错误状态 | 具体渲染 |
| **PdfViewer** | PDF.js 渲染、工具栏、翻页、缩放、text layer | fetch、弹窗、顶栏 |
| **ImageViewer** | `<img>` 渲染、滚轮缩放、拖拽平移 | fetch、弹窗、顶栏 |
| **TextViewer** | 语法高亮 / MD渲染 / 纯文本行号 | fetch、弹窗、顶栏 |
| **VideoViewer** | `<video>` 流式播放、中心按钮、亮度采样反色 | fetch、弹窗、顶栏 |

### 格式分发

```js
// DefaultLayout.vue — 音频拦截，不进预览框
watch(() => previewStore.file, (f) => {
  if (f && isAudioExt(f.ext)) { audioStore.play(f); previewStore.close() }
})

// FilePreviewModal.vue — 其余格式
if (isPdf || isOffice) → fetchBlob() / fetchOfficePdf() → blobUrl → <PdfViewer>
else if (isImage)      → fetchBlob()    → blobUrl  → <ImageViewer>
else if (isText)       → fetchBlob()    → blobUrl  → <TextViewer :ext>
else if (isVideo)      → getStreamUrl() → videoSrc → <VideoViewer>
```

### isPreviewable（`src/stores/preview.js`）

```js
const IMAGE_EXTS  = new Set(['JPG','JPEG','PNG','GIF','WEBP','SVG','BMP'])
const TEXT_EXTS   = new Set(['TXT','MD','JSON','CSV','JS','TS','CSS','HTML','PY','YAML','XML','SH'])
const VIDEO_EXTS  = new Set(['MP4','WEBM','MOV','M4V','OGV'])
const OFFICE_EXTS = new Set(['DOC','DOCX','XLS','XLSX','PPT','PPTX'])
const AUDIO_EXTS  = new Set(['MP3','WAV','OGG','FLAC','M4A','AAC','OPUS'])
const PREVIEWABLE = new Set(['PDF', ...IMAGE_EXTS, ...TEXT_EXTS, ...VIDEO_EXTS, ...OFFICE_EXTS, ...AUDIO_EXTS])
```

新增格式只改这一处，再加 Viewer 组件和一行 `v-else-if`。

---

## 五、各 Viewer 实现要点

### PdfViewer.vue ✅

依赖：`pdfjs-dist`（动态 import 懒加载），静态资源 `public/pdf-assets/cmaps/` + `public/pdf-assets/standard_fonts/`。

**工具栏**：上一页 / 下一页、页码输入框、总页数、缩放 ±10%、适宽切换（再次点击恢复 100%，按钮有激活态）。

**渲染**：
- 每页独立 `<canvas>` + `<div class="pv-text-layer">`
- canvas 渲染分辨率 = `scale × CSS_UNITS(96/72) × dpr × 2`（2× 超采样，字体锐利度接近原生）
- text layer 走 `pdfjsLib.TextLayer`，spans 透明叠加，支持文字选中复制
- `getDocument` 时传 `cMapUrl` 和 `standardFontDataUrl` 保证字体正确加载

**页面圆角**：`border-radius: 10px` + `clip-path: inset(0 round 10px)`。

**翻页逻辑**：
- 点击上一页/下一页立即更新页码，`scrollLockTimer`（600ms）屏蔽 `onScroll` 期间的页码覆写
- 渲染窗口：当前页 ±2 页，滚动时动态扩展
- `pdfDoc.destroy()` 在 `onUnmounted` 释放

### ImageViewer.vue ✅

- `position: absolute; inset: 0`，`padding: 32px`
- 滚轮缩放：`scale` 范围 `[0.1, 8]`，步进按比例（`delta * scale`）
- 拖拽平移：mousedown + mousemove，边界 ±50% 图片尺寸
- 双击重置，图片加载失败显示占位

### TextViewer.vue ✅

| 扩展名 | 渲染方式 |
|--------|---------|
| MD | `marked.parse()` → `v-html`，GitHub 风格样式，最大宽度 860px |
| JS/TS/CSS/HTML/PY/YAML/XML/SH/JSON | `highlight.js` 语法高亮，atom-one-light 配色，行号表格 |
| TXT/CSV 及其他 | 纯文本，行号表格 |

- highlight.js 按需加载（`highlight.js/lib/core` + 各语言模块动态 import）
- `splitHtmlLines(html)`：按 `\n` 拆分时追踪未闭合 span 栈，每行补齐开闭标签
- 超过 500KB 截断并提示
- 行号列 `position: sticky; left: 0`，横向滚动时固定
- 字体栈：`'JetBrains Mono', 'Fira Code', monospace`，13px，行高 1.7

### VideoViewer.vue ✅

- `<video :src="src">` — src 为后端签名 URL，原生流式播放，支持 Range / seeking / HDR
- 视频背景 `#0e0f14`，`object-fit: contain`
- 中心播放/暂停按钮：静止 1 秒隐藏，采样中心 20% 区域（32×32 canvas）判断亮度决定按钮颜色
- 跨域 canvas 读取失败时降级为默认深色模式

### Office 转 PDF ✅

- 接口：`GET /files/{id}/preview-pdf`（Bearer 认证）
- 后端用 LibreOffice headless 转换，内存缓存 50 条（key = `{fid}:{updated_at}`）
- 转换失败返回 422，前端降级为直接下载
- 前端走 `fetchBlob('/files/{id}/preview-pdf')` → 同一个 PdfViewer

### 音频迷你播放器 ✅

音频文件不进预览抽屉，由 `DefaultLayout.vue` 的 watcher 拦截后交给 `AiFloatBall` 迷你播放器。

关键文件：`src/stores/audio.js`、`src/components/common/AiFloatBall.vue`

详见设计文档：`AiFloatBall 迷你播放器` 相关章节（memory 中记录）。

---

## 六、视频流式传输

### 接口

```
GET /files/{id}/stream-url    (需 Bearer 认证)
→ { url: "/api/v1/files/{id}/stream?token=xxx" }   本地存储
→ { url: "https://oss.../xxx?Expires=..." }          OSS presigned

GET /files/{id}/stream?token=xxx   (无需认证)
→ FastAPI FileResponse，自动处理 Range 请求 / HTTP 206
```

### 签名 Token

- JWT，payload: `{ sub: user_id, fid: file_id, role: "stream", exp }`
- 有效期 10 分钟，与主 auth token 隔离，只能访问对应文件
- `app/core/security.py`：`create_stream_token` / `verify_stream_token`

### HDR 支持

- 直接使用 `<video>` 元素，不经过 canvas，HDR 元数据完整保留
- HDR10 / HLG：Chrome 94+、Safari 15+ 原生支持
- Dolby Vision：仅 Safari 支持

---

## 七、暂不做的

- **Office Online**：文件在私有存储，微软无法拉取，不可行
- **mammoth.js**：只支持 docx、排版还原差，不作为通用方案

---

*更新时间：2026-06-19*
