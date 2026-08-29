# 文件预览与音频播放设计

> **状态**：✅ 全部格式已上线；预览呈现方式已从"单一侧边抽屉"演进为"浮动窗口 + 侧边抽屉"并存（见下方"核实说明"）
> **分类**：技术实现
> **更新时间**：2026-07-02（核实更新，原文档 2026-06-19）

---

## 易读概述

**这篇文档讲的是：点开一个文件，咕咕怎么把内容显示给你看。**

咕咕支持预览很多类型的文件——图片、PDF、视频、文本代码、Office 文档（Word/Excel/PPT）、音频。不同类型用不同的方式呈现：

- **图片 / 视频 / 文本代码**：像电脑里的窗口一样弹出来，**可以拖动、缩放、同时开好几个**，还能自由叠放，点哪个哪个到最上层。
- **PDF / Office 文档**：从屏幕右侧滑出一个大抽屉展示，同一时间只显示一个。
- **音频**：不单独弹窗，直接接管页面上的迷你播放器播放。
- **压缩包 / 安装包**等不支持预览的格式，点了直接下载。

因为所有文件都存在私有空间里，预览时都要带上登录令牌（token）证明"是你本人在看"，不会被外部直接访问到。视频比较特殊，用的是"流式播放"技术，边下边播、可以拖进度条，不用等整个视频下载完。

**核实说明**：原文档只描述了"右侧抽屉"这一种预览形态，但代码库现已同时存在**浮动窗口**（`FloatPreviewWindow.vue`）和**侧边抽屉**（`FilePreviewModal.vue`）两套机制，且图片/视频/文本已经改走浮动窗口，只有 PDF/Office/音频仍走抽屉或迷你播放器。这是本文档这次核实中发现的最大出入，已在"三、弹窗形态"一节改写反映实际情况。

---

## 专业细节

### 一、核心约束：私有文件认证

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

### 二、支持格式一览

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

> 以上格式清单已对照 `frontend/src/stores/preview.ts` 核实，与代码一致（该文件历史上是 `.js`，现已随 TS 迁移改为 `.ts`，扩展名集合内容未变）。

#### 不预览（直接下载）

ZIP / RAR / 7Z / EXE / DMG 等二进制/压缩包，点击文件卡片不触发预览。

---

### 三、弹窗形态：浮动窗口 + 右侧抽屉并存（**已核实变更**）

> 原文档只写了"右侧全高抽屉"一种形态。核对 `frontend/src/stores/preview.ts` 与 `frontend/src/layouts/DefaultLayout.vue` 后确认：现在按文件类型分流到两套不同的呈现机制，抽屉不再是唯一形态。

#### 3.1 分流逻辑（`stores/preview.ts` · `open(f)`）

```js
function open(f) {
  if (isImageExt(f.ext) || isVideoExt(f.ext) || isTextExt(f.ext)) {
    // → 浮动窗口（windows 数组，可多开）
  } else {
    // PDF / Office / 音频等 → 原侧边 singleFile（同一时间只有一个）
  }
}
```

- **图片 / 视频 / 文本代码**：走 `FloatPreviewWindow.vue`，可同时打开多个、可拖动/缩放/最大化，属于"窗口系统"的一部分（见下方 3.3）。
- **PDF / Office（转 PDF 后）/ 音频**：PDF、Office 仍走 `FilePreviewModal.vue` 侧边抽屉；音频被 `DefaultLayout.vue` 的 watcher 拦截，交给 `AiFloatBall` 迷你播放器，完全不进抽屉/窗口。

#### 3.2 侧边抽屉（`FilePreviewModal.vue`，用于 PDF / Office）

`width: 60vw`，从右侧滑入，左侧背景半透明可见。

```
.fp-root      position:fixed; inset:0; z-index 走"窗口带"统一管理（见 3.3）
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

#### 3.3 浮动窗口（`FloatPreviewWindow.vue`，用于图片 / 视频 / 文本）

- 每个窗口独立 `{id, file, x, y, w, h, zIndex}` 状态，存进 `previewStore.windows` 数组，支持同时开多个。
- 标题栏可拖拽移动位置；支持最大化/还原（`toggleMaximize`）；文本预览支持独立调节字号。
- 顶栏按钮：文件信息、下载、最大化/还原、关闭。
- 初始位置屏幕居中，多开时依次错位 30px（`_idx * 30`），避免完全重叠。
- 首次估算窗口尺寸曾有"低分辨率图片先猜大窗口再骤缩"的问题，已修复为"顶到缩略图上限时不猜测，等真图加载完再按真实尺寸定窗"（见 `CHANGELOG.md` Unreleased 条目）。

**z-index 管理（窗口系统，`composables/windowz.ts`）**：曾经 BaseModal(200) / 通知气泡(9999) / GuguChat(10000) / 预览窗(11000) 四套 z 各自为政。现已统一成四条带：遮罩带 19000 固定 / **窗口带 20000+ 递增**（含 `FloatPreviewWindow`、`FilePreviewModal`、项目编辑卡、咕咕聊天窗，`mousedown` 时置顶）/ 咕咕悬浮球 99999 / 压顶带 100000（通知、拖拽克隆、tooltip）。点哪个窗口哪个到最上层，聊天窗与预览窗、编辑卡可自由叠放。

---

### 四、组件架构

```
FloatPreviewWindow.vue    浮动窗口壳（图片/视频/文本）
  .fpw-title              标题栏（拖拽区）：ext徽章 / 文件名 / 字号(仅文本) / 信息 / 下载 / 最大化 / 关闭
  .fpw-body
    ├── ImageViewer.vue   ✅ 缩放拖拽
    ├── VideoViewer.vue   ✅ 流式播放 + HDR
    └── TextViewer.vue    ✅ 代码高亮 / MD渲染 / 纯文本

FilePreviewModal.vue      右侧抽屉壳（PDF/Office）
  .fp-header              顶栏：ext徽章 / 文件名 / 下载 / 关闭
  .fp-body
    └── PdfViewer.vue     ✅ PDF.js 自渲染（也处理 Office 转换结果）

AiFloatBall.vue（迷你播放器）
    └── 音频由 DefaultLayout 拦截，不进预览抽屉/窗口
```

#### 职责划分

| 层 | 负责 | 不负责 |
|----|------|--------|
| **FloatPreviewWindow** | 浮动窗口框架、拖拽/缩放/最大化、标题栏、fetch blob / 获取签名 URL、生命周期 | 具体渲染 |
| **FilePreviewModal** | 抽屉框架、顶栏、fetch blob / 获取签名 URL、生命周期、加载/错误状态 | 具体渲染 |
| **PdfViewer** | PDF.js 渲染、工具栏、翻页、缩放、text layer | fetch、弹窗、顶栏 |
| **ImageViewer** | `<img>` 渲染、滚轮缩放、拖拽平移 | fetch、弹窗、顶栏 |
| **TextViewer** | 语法高亮 / MD渲染 / 纯文本行号 | fetch、弹窗、顶栏 |
| **VideoViewer** | `<video>` 流式播放、中心按钮、亮度采样反色 | fetch、弹窗、顶栏 |

#### 格式分发

```js
// DefaultLayout.vue — 音频拦截，不进预览框
watch(() => previewStore.file, (f) => {
  if (f && isAudioExt(f.ext)) { audioStore.play(f); previewStore.close() }
})

// previewStore.open(f) — 图片/视频/文本 → 浮动窗口；其余（PDF/Office） → 抽屉 singleFile
```

#### isPreviewable（`src/stores/preview.ts`）

```ts
const IMAGE_EXTS  = new Set(['JPG','JPEG','PNG','GIF','WEBP','SVG','BMP'])
const TEXT_EXTS   = new Set(['TXT','MD','JSON','CSV','JS','TS','CSS','HTML','PY','YAML','XML','SH'])
const VIDEO_EXTS  = new Set(['MP4','WEBM','MOV','M4V','OGV'])
const OFFICE_EXTS = new Set(['DOC','DOCX','XLS','XLSX','PPT','PPTX'])
const AUDIO_EXTS  = new Set(['MP3','WAV','OGG','FLAC','M4A','AAC','OPUS'])
const PREVIEWABLE = new Set(['PDF', ...IMAGE_EXTS, ...TEXT_EXTS, ...VIDEO_EXTS, ...OFFICE_EXTS, ...AUDIO_EXTS])
```

新增格式只改这一处，再加 Viewer 组件和分流逻辑里的一个条件分支。

---

### 五、各 Viewer 实现要点

#### PdfViewer.vue ✅

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

> 核实：`PdfViewer.vue` 已随前端 TS 迁移改为 `<script setup lang="ts">`（属于"阶段 2 · 已转 8 个最简单叶子件"之一，见 `前端-JS转TS迁移指南.md`）。

#### ImageViewer.vue ✅

- `position: absolute; inset: 0`，`padding: 32px`
- 滚轮缩放：`scale` 范围 `[0.1, 8]`，步进按比例（`delta * scale`）
- 拖拽平移：mousedown + mousemove，边界 ±50% 图片尺寸
- 双击重置，图片加载失败显示占位

#### TextViewer.vue ✅

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
- 浮动窗口模式下支持独立调节字号（`FloatPreviewWindow.vue` 标题栏 +/- 按钮）

#### VideoViewer.vue ✅

- `<video :src="src">` — src 为后端签名 URL，原生流式播放，支持 Range / seeking / HDR
- 视频背景 `#0e0f14`，`object-fit: contain`
- 中心播放/暂停按钮：静止 1 秒隐藏，采样中心 20% 区域（32×32 canvas）判断亮度决定按钮颜色
- 跨域 canvas 读取失败时降级为默认深色模式

#### Office 转 PDF ✅

- 接口：`GET /files/{id}/preview-pdf`（Bearer 认证）
- 后端用 LibreOffice headless 转换，内存缓存 50 条（key = `{fid}:{updated_at}`）
- 转换失败返回 422，前端降级为直接下载
- 前端走 `fetchBlob('/files/{id}/preview-pdf')` → 同一个 PdfViewer，呈现在侧边抽屉里

#### 音频迷你播放器 ✅

音频文件不进预览抽屉/窗口，由 `DefaultLayout.vue` 的 watcher 拦截后交给 `AiFloatBall` 迷你播放器。

关键文件：`src/stores/audio.ts`、`src/components/common/AiFloatBall.vue`

详见设计文档：`AiFloatBall 迷你播放器` 相关章节（memory 中记录）。

---

### 六、视频流式传输

#### 接口

```
GET /files/{id}/stream-url    (需 Bearer 认证)
→ { url: "/api/v1/files/{id}/stream?token=xxx" }   本地存储
→ { url: "https://oss.../xxx?Expires=..." }          OSS presigned

GET /files/{id}/stream?token=xxx   (无需认证)
→ FastAPI FileResponse，自动处理 Range 请求 / HTTP 206
```

> 已对照 `backend/app/api/v1/files.py` 核实：`stream-url`、`preview-pdf`、`create_stream_token`/`verify_stream_token` 等接口与文档描述一致。

#### 签名 Token

- JWT，payload: `{ sub: user_id, fid: file_id, role: "stream", exp }`
- 有效期 10 分钟，与主 auth token 隔离，只能访问对应文件
- `app/core/security.py`：`create_stream_token` / `verify_stream_token`

#### HDR 支持

- 直接使用 `<video>` 元素，不经过 canvas，HDR 元数据完整保留
- HDR10 / HLG：Chrome 94+、Safari 15+ 原生支持
- Dolby Vision：仅 Safari 支持

---

### 七、暂不做的

- **Office Online**：文件在私有存储，微软无法拉取，不可行
- **mammoth.js**：只支持 docx、排版还原差，不作为通用方案

---

*更新时间：2026-07-02*
