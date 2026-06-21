# PM Studio · 早期开发记录

> 更新：2026-06-21
> 状态：早期阶段记录，当前进度见 `docs/overview.md`

---

## 2026-06-21 · 缩略图根因排查：Pillow 未安装导致全量加载原图

### 背景

用户反馈总览页和文件库滚动卡顿、图片加载慢、渐进式效果失效。为此陆续做了大量前端优化（`shallowRef` 批量更新、`preDecodeBlobs`、`will-change`、`backdrop-filter` 移除、IntersectionObserver 懒加载等），体验有所改善但根本问题未解决。

### 根因

**`Pillow` 未写入 `requirements.txt`，venv 中从未安装。**

后端 `/files/{id}/thumb` 端点调用 `_generate_thumbs_sync()` 生成 WebP 缩略图，但所有调用都在 `except Exception: pass` 中静默失败。最终降级路径返回**原始大图**（几百KB～几MB JPEG/PNG）。

前端把这张大图当成 `tiny`（预期 20px WebP）缓存到 blob Map，渲染时浏览器需要解码全尺寸图片：
- `tiny` 不是 20px 小图，blur 占位失去意义
- `card` 返回原图，文件库加载几十张 MB 级图片
- 浏览器 HTTP Cache 缓存了这些大图响应（`max-age=86400`），强刷页面也不请求后端，旧 blob 持续命中

### 排查过程

1. 发现 blob cache 里存在 JPEG/PNG 类型，怀疑降级逻辑触发
2. 在后端端点加日志，发现浏览器根本没有发 thumb 请求到服务器（HTTP Cache 直接命中）
3. 清除 site data 后，强刷仍无 thumb 请求 → uvicorn 日志无任何 `/thumb` 条目
4. 直接在 venv 中测试 `from PIL import Image` → `ModuleNotFoundError`
5. 确认 Pillow 从未安装，`requirements.txt` 缺失该依赖

### 修复内容

| 位置 | 改动 |
|------|------|
| `requirements.txt` | 新增 `Pillow>=10.0.0` |
| `_generate_thumbs_sync` | 修复 RGBA/透明通道处理（PNG 保留 RGBA，其余转 RGB） |
| `get_thumb` 端点 | 降级改为输出缩小 JPEG，最后兜底才返回原图；移除静默 `except: pass`，改为打印 traceback |
| `useThumbCache.js` | fetch 加 `cache: 'no-cache'`，强制跳过浏览器 HTTP Cache，确保拿到最新 WebP |

### 反思

之前所有前端优化（`shallowRef`、`preDecodeBlobs`、懒加载、`backdrop-filter`）都是在治标，真正的性能瓶颈是后端返回了全尺寸原图。正确的 WebP 生效后（tiny 几百字节，card 几 KB），滚动卡顿和加载慢的问题基本消失，前端优化才能真正发挥作用。

**教训：依赖静默失败 + 降级兜底会掩盖真实问题，重要依赖必须写入 requirements.txt 并在 CI/部署时验证。**

---

## 核心愿景

通用项目管理 Web，通过自然语言管理进度、文件、排期，支持自然语言交互。适用于插画约稿、动画制作、工程项目等任何需要进度追踪的场景。

---

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Vue 3 + Vite + Pinia + Vue Router |
| UI 库 | Arco Design Vue |
| 后端 | FastAPI + PostgreSQL |
| 模型 | Qwen + LangChain（待接入） |

---

## 已完成功能（早期阶段）

### 布局 & 全局
- DefaultLayout：顶栏（glassmorphism，`position: absolute; z-index: 10`）+ 侧边栏 + 内容区
- 顶栏内容：页面标题、日期、搜索框、"导入文件"、"新建项目"按钮
- 侧边栏底部用户卡片（头像 + 姓名，无职业）+ 设置弹窗
- 自然语言悬浮球（`z-index: 1000`）+ 聊天弹窗（`z-index: 999`），点击外部自动收起
- 导航：总览 / 项目 / 日历 / 文件库 / 客户 / 通知
- 滚动条始终占位（`overflow-y: scroll; scrollbar-gutter: stable`）防止切页抖动

### 总览页（Dashboard）
- 项目列表（ProjectList）：状态徽章（待开始 / 进行中 / 已完成）、当前阶段、截稿倒计时
- 最近文件（FilePanel）：分 tab 展示 + 拖拽上传区
- 玻璃拟态卡片，hover 非线性上浮动画 `cubic-bezier(0.34, 1.2, 0.64, 1)`

### 项目页（Projects）
- 三列看板：待开始 / 进行中 / 已完成
- HTML5 拖拽换列（`@dragstart / @dragover / @drop`）
- ProjectCard：显示项目自定义当前阶段、阶段进度点、截稿倒计时、进度条
- ProjectModal（全屏）：阶段编辑器、项目重命名、看板状态选择、进度滑块、截稿日、客户
- NewProjectModal（全局挂载于 DefaultLayout）：表单 + 8色渐变预设 + 实时预览

### 数据层（Mock）
- `useProjectStore`（Pinia）：`kanbanColumns`、项目字段、Actions
- `useUiStore`：`openNewProject`、`notifCount`

---

## 待开发（早期规划）

| 优先级 | 功能 |
|---|---|
| 高 | 日历页完整实现 |
| 高 | 文件库页完整实现 |
| 高 | 数据库模型 + Alembic 迁移 |
| 高 | 后端 CRUD API（项目 / 文件） |
| 中 | 替换 Mock 数据为真实 API |
| 中 | 自然语言管理集成（Qwen + LangChain） |
| 低 | 客户管理页 |
| 低 | 通知系统 |

---

## 设计规范（早期版本）

- **色系**：紫蓝渐变主色 `#8b8fbe → #c4afc8`，成功绿 `#5a9e88`，警告橙 `#b07858`
- **玻璃拟态**：`backdrop-filter: blur(20px)`，`rgba(255,255,255,0.26~0.48)` 背景，白色内描边
- **圆角**：`--radius-sm: 10px`，`--radius-md: 14px`，`--radius-lg: 18px`
- **动画**：hover 弹性 `cubic-bezier(0.34,1.2,0.64,1)`，遮罩/阴影 `cubic-bezier(0.4,0,0.2,1)`，Modal 入场 `cubic-bezier(0.34,1.3,0.64,1)`
- **Z-index 层级**：内容(default) → 渐变遮罩(5) → 顶栏(10) → Modal(200~300) → 对话球(1000) / 聊天(999)
