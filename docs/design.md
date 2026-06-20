# PM Studio · 设计需求文档

> 整理自产品讨论，最后更新：2026-06-21

---

## 一、产品定位

- **类型**：ToC 优先，未来扩展 ToB
- **核心用户**：自由职业创作者（插画、动画 PM 等），未来扩展到团队/企业
- **一句话**：项目管理后台，统一管进度、排期、文件，支持自然语言交互

---

## 二、技术选型

| 层级 | 选型 | 说明 |
|------|------|------|
| 前端 | Vue 3 + Vite | 用户有 Vue 基础，上手快 |
| UI 组件库 | Arco Design | 飞书出品，适合项目管理风格，ToB 扩展友好 |
| 后端 | FastAPI (Python) | 异步，LangChain/LlamaIndex 直接用 |
| 数据库 | PostgreSQL + Redis | 结构化数据 + 缓存/实时 |
| 文件存储 | 阿里云 OSS | 国内访问稳定 |
| 模型 | 通义千问 (Qwen) | 国内合规 |
| 实时通信 | WebSocket | 项目状态实时推送 |

**ToB 扩展策略**：前端和数据库基本不动，后期加多租户逻辑和权限体系即可。

---

## 三、文件架构

### 前端（Vue 3）

```
frontend/
├── src/
│   ├── assets/          # 字体、图片、全局 CSS
│   ├── components/
│   │   ├── common/      # DatePicker、AppSidebar、NavItem、AiFloatBall 等通用组件
│   │   └── business/    # ProjectCard、CalendarCell 等业务组件
│   ├── views/
│   │   ├── Dashboard/
│   │   ├── Projects/
│   │   ├── Calendar/
│   │   ├── Files/
│   │   └── Chat/        # 自然语言对话入口（悬浮球展开）
│   ├── stores/          # Pinia 状态管理
│   ├── composables/     # useCalendar、useAgent 等可复用逻辑
│   ├── services/        # API 请求封装
│   ├── router/
│   └── utils/
```

### 后端（FastAPI）

```
backend/
├── app/
│   ├── api/v1/
│   │   ├── projects.py
│   │   ├── tasks.py
│   │   ├── files.py
│   │   └── agent.py     # 自然语言对话/指令入口
│   ├── services/
│   │   ├── agent/       # 自然语言对话逻辑、记忆管理（Markdown 文件作为记忆）
│   │   └── storage/     # OSS 文件操作
│   ├── models/          # SQLAlchemy 数据库模型
│   ├── schemas/         # Pydantic 请求/响应校验
│   ├── core/            # 配置、JWT、中间件
│   ├── db/              # 连接池、Alembic 迁移
│   └── main.py
```

---

## 四、UI 设计规范

### 视觉风格

参考：Glassmorphism + 冷淡灰色系

- **背景**：顶部浅灰（`#e8e9ee`）→ 底部冷灰蓝（`#9aa2b8`），`160deg` 线性渐变，固定不随内容滚动
- **卡片**：`rgba(255,255,255,0.56)` 半透明 + `backdrop-filter: blur(20px)`，亮度提升以增强可读性
- **边缘高光**：`inset 0 1px 0 rgba(255,255,255,0.95)` 顶边亮线模拟玻璃切割倒角
- **阴影**：轻阴影 `0 4px 16px rgba(80,90,110,0.08)`，扁平化，不堆叠
- **圆角**：面板 `18px`，小元素 `10–12px`

### 色彩

| 用途 | 色值 |
|------|------|
| 主强调（紫灰） | `#7b7fb2` |
| 次强调（粉灰） | `#c4afc8` |
| 第三强调（青灰） | `#7ab8c8` |
| 正文 | `#1e2028` |
| 次要文字 | `#8a8fa8` |
| 成功 | `#5a9e88` |
| 警告 | `#b07858` |

### 图标

- **优先使用 Phosphor Icons**（`@phosphor-icons/vue`，MIT）：UI 操作图标统一 `weight="bold"`
- 保留手写内联 SVG 的场景：viewer 内控件、装饰性插图、带旋转动画的方向箭头
- 内联 SVG 规范：`stroke-width: 1.5`，`stroke-linecap: round`，`fill="none"`，继承 `currentColor`
- 不使用 Emoji 或彩色图标

### 排版

- 字体：`PingFang SC`，fallback `Segoe UI`
- 导航文字：`13px`，选中态 `font-weight: 600`
- 卡片标题：`16px / 700`
- 正文：`13–14px / 400`
- 辅助信息：`11–12px`，`color: #8a8fa8`

### 交互规范

- 导航项 hover：背景 `rgba(123,127,178,0.08)`，文字 `rgba(30,32,40,0.82)`（不变为纯黑，保持克制）
- 导航项 active：背景 `rgba(255,255,255,0.38)`，文字 `var(--color-primary)`，`font-weight: 600`
- 按钮/卡片 hover：轻微 `translateY(-2px)` + 阴影增强，`transition: 0.25s cubic-bezier(0.34,1.2,0.64,1)`

---

## 五、核心页面与组件

### 导航结构

```
侧边栏（220px）
├── Logo
├── 工作台
│   ├── 总览（默认页）
│   ├── 项目
│   ├── 日历
│   └── 任务
├── 资源
│   ├── 文件库
│   ├── 客户
│   └── 报表
├── 通知（带角标，点击弹出 Teleport 小窗）
└── 用户卡片（点击展开：个人资料 / 偏好设置 / 退出）
```

**通知弹窗**：
- 触发：点击通知导航按钮（非 router-link），弹出 `position: fixed` 小窗位于侧边栏右侧
- 内容：最近通知列表（截稿提醒 / 阶段推进），彩点区分项目，支持单条点击已读 + 全部已读
- 关闭：click-outside（`document.addEventListener('click', closeAll)`）
- 动画：`notif-pop`（`translateX(-8px) scale(0.97)` → 展开，spring 曲线）

### 顶栏

- 左：页面标题 + 日期/星期（不含"你好"等问候语）
- 中：搜索框
- 右：上传文件按钮 + 新建项目按钮

### 自定义 DatePicker 组件

`components/common/DatePicker.vue`，全局复用于 NewProjectModal、ProjectModal、Calendar 添加事件弹窗。

- `v-model`：ISO 日期字符串（`YYYY-MM-DD`）
- 弹窗使用 `<Teleport to="body">`，通过 `getBoundingClientRect()` 定位
- 样式：玻璃态面板（`rgba(255,255,255,0.66)` + `blur(24px)`），月份导航 + 7列日期网格 + 快捷操作（今天 / 清除）
- 选中日：`linear-gradient(135deg, #7b7fb2, #9590c4)` 渐变背景；今日：`rgba(123,127,178,0.15)` 浅紫高亮
- 动画：`dp-pop`（scale + translateY，spring 曲线）
- 点击外部关闭：`document.addEventListener('click', handler, true)` capture 阶段

### Dashboard 总览

- **4 张统计卡片**：年度项目数（`totalCount`）/ 进行中（`activeCount`）/ 即将到期（`upcomingCount`，7天内截稿）/ 文件总数
- **项目列表**：阶段流 + 全宽进度条 + 截稿日 + 状态标签；已完成项目最多显示最近 2 条（按截稿日排序）
- **日历面板（CalendarPanel）**：
  - 月视图小日历，截稿日标记，点击日期选中
  - 点击年月标签弹出快速选择器（`<Teleport to="body">`）
  - 6行月份（42天）时日期格 `aspect-ratio` 从 `1` 改为 `6/5`（格高缩减为原来的 5/6），保持面板整体高度不变，近期节点列表不受限制始终全部显示
- **最近文件（FilePanel）**：`auto-fill minmax(110px)` 多列网格，卡片显示文件类型标签（ext badge）、项目彩点、文件名、大小、日期。含拖拽上传区

### 项目页（看板）

- **3 列看板**：待开始 / 进行中 / 已完成
- 看板整体高度：`calc(100vh - 152px)`，各列 `overflow-y: auto` 内部滚动，卡片 `flex-shrink: 0` 防止压缩
- **ProjectCard**：玻璃态卡片，显示开始日期→截稿日期 range（`M/D → M/D`）、阶段点进度、截稿倒计时
- 拖拽卡片可切换列（`emit('drop-project', { projectId, targetStatus })`）
- 点击卡片打开 ProjectModal

### ProjectModal（项目编辑弹窗）

`900×680px` 固定尺寸，`display: grid; grid-template-columns: 320px 1fr`。

**左栏结构**（从上到下）：

| 区块 | 说明 |
|------|------|
| `proj-header`（52px 固定） | 项目名（可内联点击编辑）+ 3px 进度条（底部）+ 右侧百分比绝对定位 |
| `left-content`（flex:1 可滚动） | section + col-divider 模式，依次：客户 / 日期 / 看板状态 / 配色 / 阶段 / 备注 |
| 删除按钮 | `position: absolute; bottom: 14px; right: 14px`，琥珀色 |

**表单控件**：

- `field-input`：`padding: 9px 12px; border-radius: 8px; background: rgba(255,255,255,0.6); border: 1px solid rgba(0,0,0,0.1)`，focus 时蓝紫色光晕
- `section-label`：`10px / 600 / uppercase / letter-spacing: 0.07em`，小型大写标题
- `col-divider`：`border-top: 1px solid rgba(0,0,0,0.07)`，区块间水平线
- `color-chip`：`22px` 圆，渐变背景，选中 `border: 2px solid #fff + box-shadow: 0 0 0 2px rgba(0,0,0,0.18)`
- `status-btn`：`padding: 5px 12px; font-size: 12px; border-radius: 20px; gap: 6px`，三态（待开始红·进行中橙·已完成绿），选中态对应颜色加 `background + border-color`

**阶段编辑器**：

- 节点球平面化：`22px` 圆，`border: 1.5px solid rgba(0,0,0,0.12); background: rgba(0,0,0,0.08)`
- done（`i < activeStageIdx`）：绿色填充 `var(--color-success)`；active（`i === activeStageIdx`）：项目色通过 inline `:style` 注入，**不在 CSS class 里写 background**（否则与 inline style 单帧冲突产生闪烁）
- 状态由**位置索引**（v-for 的 `i`）决定，不跟随 key——拖动重排只移动标签名，球的 done/active 位置不变
- 拖动 ghost：仅标签文字 + 全宽背景条，无球，无旋转
- 拖动解耦：`stageDrag.active = false` 必须在 `commitStageDrag()` 前执行，防止 `displayStages` 对已提交数据二次重排

**响应式 ref**：`localName`、`localColor`、`localCurrentStage`、`activeStageIdx`、`stageProgress` 均为独立 ref，在 `watch(project.id)` 时初始化，点击立即更新不等 props 刷新。

**右栏**：文件区，见文件库章节（ProjectModal 使用缩小参数版本）。

### NewProjectModal（新建项目弹窗）

`700px` 宽，两栏布局：左栏（客户 / 项目周期 / 看板状态 / 配色 / 备注）+ 右栏（阶段 + 模板）。

- 默认截止日期：一周后（`weekLaterIso()`）
- 默认阶段：读取 store 中最近一个项目的阶段列表；若无历史项目则用 `['计划', '执行', '交付']`
- 阶段模板：`useStageTemplates` composable，内置三个默认模板，用户可保存/删除/重命名，持久化至 localStorage
- 右栏无额外背景色（与左栏统一透明）

### 弹窗动画规范（BaseModal 统一管理）

所有弹窗基于 `BaseModal.vue`，**禁止**在子弹窗重复定义遮罩、动画、Esc 逻辑。

- Transition name `bm`，duration `{ enter: 340, leave: 220 }`
- `.bm-overlay` 和 `.bm-card` 各自**纯 opacity** 过渡（进入 `cubic-bezier(0.4,0,0.2,1)` / 退出 `cubic-bezier(0.4,0,1,1)`）
- **禁止 transform**：`scale` 或 `translateY` 会让含 `backdrop-filter` 的元素在动画帧间产生像素跳位（GPU compositing 问题）

| 弹窗 | width | height | zIndex |
|------|-------|--------|--------|
| NewProjectModal | 700px | — | 300 |
| UploadModal | 520px | — | 300 |
| ProjectModal | 900px | 680px | 200 |
| FilePreviewModal | 860px | min(90vh,880px) | 400 |

### 日历页（Calendar）

- **布局**：工具栏（年月导航 + 今天按钮）+ 主区（月视图）+ 侧栏（当天日程 + 近期截稿）
- **月视图**：
  - 日期格：`padding: 7px 6px 4px`，日期数字 24px 圆圈，今日渐变高亮，选中浅紫背景
  - 项目横跨条（`bars-layer`）：`position: absolute; inset: 0` 覆盖整行，条的 top 偏移从格顶 **36px** 开始（清开 31px 的日期圆圈区域），每行间距 22px，最多显示 3 条，超出显示 `+N 更多`（可点击弹出列表）
  - 事件 chip：通过 `padding-top` 推至条下方显示（不再使用 `v-if` 隐藏），每日最多显示 `3 - 当日条数` 个 chip
  - 周行动态最小高度：`min-height: max(92px, calc(38px + var(--bar-rows, 0) * 22px + 14px))`
  - 项目条圆角：默认 0，仅在起始端 `border-radius: 99px 0 0 99px`，终止端 `0 99px 99px 0`，单日满圆 `99px`
- **侧栏**：
  - 当天日程：事件名 + 元信息（客户 + 类型标签）；无客户时省略分隔符 `·`；未知类型显示"事件"
  - 近期截稿：项目截稿日 + 独立事件合并排序
  - 项目条目显示"项目"标签以区分普通事件
- **侧栏活动删除**：每条用户活动右侧显示删除按钮，颜色 `#b07858`（`var(--color-warning)` 系），`background: rgba(176,120,88,0.08); border: 1px solid rgba(176,120,88,0.3)`
- **编辑活动弹窗**（`add-event-popup`，`<Teleport to="body">`）：
  - 头部 `popup-header`：左侧标题 + 右侧 `popup-close-btn`（22px 圆角按钮，`PhX`，点击关闭）
  - 底部 `popup-actions`：右对齐，左"保存"（紫渐变）→ 右"删除"（`#b07858` 边框色，与侧栏删除按钮统一）
  - 删除逻辑复用 `deleteEvent()`，关闭弹窗后执行
- **年月快速选择器**：`<Teleport to="body">`，弹窗宽 220px，居中对齐锚点
- **添加事件弹窗**：`<Teleport to="body">`，包含事件名输入框 + DatePicker
- **溢出弹窗**：点击 `+N 更多` 时，以点击位置为中心弹出悬浮列表（`position: fixed`）
- **图标**：全部使用 Phosphor（`PhCaretLeft/Right`、`PhCaretDown`、`PhPlus`、`PhAlignLeft`、`PhTrash`、`PhCalendarBlank`、`PhX`），无内联 SVG

### 文件库页（Files）

- **工具栏**：项目筛选下拉 / 类型筛选下拉 / 搜索框 / 网格视图 & 列表视图切换 / 上传按钮
  - 工具栏 `position: relative; z-index: 20`，防止下拉菜单被文件卡片遮挡（backdrop-filter 层叠上下文）
- **网格视图**：`auto-fill minmax(128px, 1fr)` 卡片
  - 顶部行：ext badge + 版本号（内联在 ext 后，`v-if versions.length > 1`）+ 项目彩点
  - 卡片内容：文件名（ellipsis）/ 阶段标签 / 大小·日期
- **列表视图**：`grid-template-columns: 2fr 1.4fr 90px 72px 72px 52px` 6列
- **版本历史面板**：
  - `position: absolute; right: 0; top: 0; bottom: 0; width: 284px`，叠加在文件区上方（不改变网格宽度）
  - `.files-body` 设置 `overflow: hidden` 裁掉 `translateX(100%)` 动画时的溢出
  - 内容：文件名 / 项目·阶段 / 版本列表（最新版 primary badge）/ 上传新版本按钮
- **上传弹窗**：支持选择所属项目，文件按用户隔离存储
- **拖拽上传**：全页面拖拽遮罩（`dragCounter` 计数防误触），松开执行上传
- **文件 input**：若选中了文件则上传为新版本，否则作为新文件添加

### 自然语言管理（悬浮球）

- 右下角固定圆形按钮（`52px`，渐变背景），z-index: 1000
- 点击弹出对话浮层（`320px` 宽），z-index: 999
- 点击悬浮球或浮层外部均可关闭（capture 阶段监听）

---

## 六、核心功能清单（MVP）

- [x] 项目 CRUD + 阶段管理
- [x] 可拖拽日历/排期视图
- [x] 文件上传 + 版本命名归档
- [x] 日历页面完整实现
- [x] 文件库页面完整实现
- [x] 数据库模型 + Alembic 迁移
- [x] 后端 CRUD API（项目/文件/事件/客户）
- [x] 前端接入真实 API
- [ ] 自然语言管理（进度查询、截稿提醒、排期建议）
- [ ] 对话记忆：用 Markdown 文件持久化项目状态
- [ ] 客户信息管理
- [ ] 通知系统后端（截稿前 48h 自动触发）

---

## 七、设计文件

| 文件 | 说明 |
|------|------|
| `design/prototype.html` | 可交互 HTML 原型稿（Dashboard 总览） |
| `docs/design.md` | 本文档 |
