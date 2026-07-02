# 咕咕 · 前台设计规范

> 整理自产品讨论，最后更新：2026-06-22

---

## 一、产品定位

- **类型**：ToC 优先，未来扩展 ToB
- **核心用户**：想推进个人目标 / 做成长记录的个人用户（工作、创作、学习、生活；创作者是重点群体之一），未来扩展到团队/企业
- **一句话**：项目管理后台，统一管进度、排期、文件，支持自然语言交互

---

## 二、技术选型

| 层级 | 选型 | 说明 |
|------|------|------|
| 前端 | Vue 3 + Vite | `<script setup>` + Pinia |
| 图标库 | Phosphor Icons（`@phosphor-icons/vue`） | MIT，UI 操作图标统一 `weight="bold"` |
| 后端 | FastAPI (Python) | 异步，SQLAlchemy 2.0 async |
| 数据库 | PostgreSQL + Redis | 结构化数据 + 缓存/实时 |
| 文件存储 | 阿里云 OSS / 本地 | 可切换，Admin 配置 |
| 模型 | 可配置（Qwen / Anthropic / OpenAI 兼容） | Admin 后台热更新 |
| 实时通信 | SSE（Server-Sent Events） | Agent 对话流式输出 |

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
- **卡片**：`rgba(255,255,255,0.56)` 半透明 + `backdrop-filter: blur(20px)` 毛玻璃，边框高光 + 轻阴影构成层次感；hover 时背景/阴影以 `0.25s ease` 淡入淡出，不立即亮起
- **边缘高光**：`inset 0 1px 0 rgba(255,255,255,0.95)` 顶边亮线模拟玻璃切割倒角
- **阴影**：轻阴影 `0 4px 16px rgba(80,90,110,0.08)`，扁平化，不堆叠
- **圆角**：面板 `18px`，小元素 `10–12px`

**毛玻璃三档（全走 CSS 变量，改一处全站生效，别再写死 blur 值）：**

| 档 | 变量/落点 | 值 | 用途 |
|---|---|---|---|
| 大面板 | `--glass-blur`（variables.css） | `blur(20px)` | glass-card 面板、聊天窗、音乐播放器、BaseModal 卡片、Profile、通知气泡、编辑卡右栏 |
| 小弹窗 | `--popup-blur`（variables.css） | `blur(12px)` | `.popup-menu`（右键/排序/表单）、日期选择器、活动添加/编辑弹窗、文件信息、通知中心、全局搜索下拉、月份选择、溢出弹窗 |
| 拖拽克隆 | `.phys-drag-clone`（global.css） | `blur(12px)` + 白 42% 底 | 全站拖拽克隆体（文件卡/项目卡/多选叠）唯一定义，组件里别各自定义底色 |

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

**次要文字/图标统一走 `var(--text-secondary)`（不要硬编码 `#8a8fa8` 或另开近似色）**：顶栏日期、文件库/项目编辑卡路径面包屑的上层路径段、文件库工具栏纯图标按钮（`.nav-hist-btn`/`.select-mode-btn`/`.view-toggle button`）、顶栏「上传文件」按钮、日历工具栏「今天」按钮与「月/周」切换未选中态、日历周视图星期栏、定时任务卡片的时间行、日历活动提醒的渠道描述区（标签/chip/测试发送按钮）、通知弹窗「全部已读」按钮，均属此类。此前 `.reminder-lead`/`.reminder-add-btn`/`.reminder-test-bar`（渠道相关几处）、通知弹窗 `.notif-mark-all`、日历工具栏 `.view-toggle button` 各自硬编码了 `#65688f`/`#7b7fb2`/`#8a8fa8`，与其余次要文字不一致或没走变量，已统一改用 `var(--text-secondary)`。

注意：`.paste-btn`/`.sort-btn`/`.select-all-btn`/`.new-folder-btn` 这类**强调色小按钮**（默认态即 `var(--color-primary)`、非灰色）是另一种有意的视觉层级，不属于"次要文字"范畴，不要一并改灰。

**导航项（三态：未选中/hover/选中）另有一套专用配色，不套用「次要文字」规则**：未选中 `#767980`（比 `--text-secondary` 更深、更低饱和度）、hover `var(--text-primary)`、选中 `#6b6fa0`（比 `--color-primary` 更深一档）+ `font-weight:700` + 白色玻璃背景 `rgba(255,255,255,0.38)` + 描边 `rgba(255,255,255,0.62)` + `inset 0 1px 0 rgba(255,255,255,0.85)`。已应用于 `AppSidebar.vue` 主导航（`NavItem.vue`）、`AppSidebar.vue` 通知按钮（`.notif-btn`）、`ProfileModal.vue` 设置弹窗左侧导航（`.pm-nav-item`/`.pm-logout`）——这三处结构相同（各自手写一份 CSS，非共用组件），新增同类导航项时按此配色抄一份，不要沿用旧的 `rgba(30,32,40,0.62/0.82)` 或直接用 `var(--color-primary)` 做选中色。

### 项目品牌色的文字用法

项目品牌色（`accent`）直接用于文字会因亮度不足导致可读性差（如 `#9590c4` 在白底上对比度不够）。规范如下：

| 用途 | 处理方式 |
|------|---------|
| 胶囊 / 条块 **背景**（无进度） | `hexAlpha(accent, 0.1)` — 10% 透明度 |
| 胶囊 / 条块 **背景**（有进度） | `linear-gradient(to right, hexAlpha(accent,0.32) 0%, hexAlpha(accent,0.32) {fill}%, hexAlpha(accent,0.1) {fill}%, hexAlpha(accent,0.1) 100%)`，硬切割，填充量 = 当前阶段进度 |
| 胶囊 / 条块 **边框** | `hexAlpha(accent, 0.3)` — 30% 透明度 |
| 胶囊 / 条块内**标题文字** | `darkenHex(accent)` — RGB 各通道乘以 0.60 压暗 |
| 侧栏条目标题（带彩色左边栏的样式） | `darkenHex(accent)` — 同上 |
| 状态点 / 小标签文字 | `accent` 原色（面积小，可读性要求低） |

```js
// 共用工具函数（在每个需要的 .vue 中本地定义），默认参数 0.60
function darkenHex(hex, amount = 0.60) {
  const r = Math.round(parseInt(hex.slice(1,3),16) * amount)
  const g = Math.round(parseInt(hex.slice(3,5),16) * amount)
  const b = Math.round(parseInt(hex.slice(5,7),16) * amount)
  return `rgb(${r},${g},${b})`
}
```

已应用场景：Dashboard 近期节点胶囊、总览项目列表百分比、日历项目条/chip/弹窗、日历侧栏卡片标题与近期节点胶囊。项目名称（Dashboard 项目列表 + 看板 ProjectCard）使用 `amount=0.40` 更深版本。

**进度渐变统一实现方式**：`.cap-capsule` 背景统一由 CSS 变量 `--cap-bg` 驱动（`global.css: .cap-capsule { background: var(--cap-bg) }`），各模板通过 `:style="{ '--cap-bg': capBg(color, progress) }"` 传入；`capBg()` 在有进度时返回渐变，无进度时返回纯色，活动事件 `progress=0` 走纯色分支。日历项目条同理，通过 `barSegFill(bar)` 将进度换算为当前段在项目总时间轴中的填充比，使多行条进度连贯（跨周段不重置为 0%）。

### 项目/活动条目的字重规范

| 元素 | 字重 |
|------|------|
| 类型标签（项目、活动、截止日等） | `font-weight: 600` |
| 名称文字（`.cap-name`，项目名、活动名） | `font-weight: 700`（global.css 统一定义） |
| 辅助按钮（更多） | `font-weight: 500` |
| 弹窗日期标题 | `font-weight: 700` |
| 日历格子日期数字 | `font-weight: 500`（今日日期 700） |

弹窗日期标题不使用 `text-transform: uppercase` 或 `letter-spacing`，这两个属性对中文无效且影响视觉效果。

**活动名称颜色**：近期节点胶囊中，活动 `cap-name` 颜色与日历格活动 chip 保持一致，均使用 `darkenHex(accent)`（TYPE_COLOR/TYPE_ACCENT 对应颜色 × 0.60 压暗），不使用 `var(--text-primary)`，确保彩色系一致。

### 文件操作按钮

全局共享两个类（定义在 `global.css`），覆盖三个页面（Dashboard FilePanel、文件库、ProjectModal 右栏）：

| 类名 | 场景 | 尺寸（默认） |
|------|------|------|
| `.file-card-btn` | 卡片/文件夹 hover 浮现的悬浮按钮 | 20×20px |
| `.file-list-btn` | 列表行 hover 浮现的行内操作按钮 | 24×24px |

**`.file-card-btn` 样式**：`rgba(255,255,255,0.78)` 白底 + `blur(4px)` + 轻阴影，hover 变纯白，`.del` modifier hover 变红 `#e05555`。

**`.file-list-btn` 样式**：无背景，默认 `opacity: 0`，父行 hover 触发（各页面 scoped：`.list-row:hover .file-list-btn { opacity: 1 }`），hover 浅紫背景，`.del` modifier hover 变红背景。

**尺寸覆盖**：ProjectModal 卡片较小，通过 scoped CSS 覆盖为 17×17px、`border-radius: 4px`、`::after` inset 缩至 `-1px`。

**重命名按钮交互**：进入重命名状态后，铅笔图标（`PhPencilSimple`）切换为勾图标（`PhCheck`），再次点击执行确认提交，`title` 同步变为"确认"。按钮加 `@mousedown.prevent` 阻止 input blur 先于 click 触发导致状态重置。点击后自动全选文件名（`startRename` 内 `el.focus(); el.select()`，以及 input 上 `@focus="$event.target.select()"`）。

**卡片重命名输入框**：使用 ghost sizer 技术（隐藏的 `rename-ghost` span 撑开布局空间，`rename-input` 绝对定位覆盖其上），确保输入时卡片高度不变。输入框样式：`rgba(255,255,255,0.9)` 白底 + `1px solid rgba(123,127,178,0.4)` 紫色边框，`border-radius: 4px`，字体完全继承父元素（`font: inherit`）。三处页面（Dashboard FilePanel、文件库、ProjectModal）统一该样式。

### 图标

- **统一使用 Phosphor Icons**（`@phosphor-icons/vue`，MIT）：UI 操作图标统一 `weight="bold"`
- 保留手写内联 SVG 的场景：viewer 内控件、装饰性插图、带旋转动画的方向箭头
- 内联 SVG 规范：`stroke-width: 1.5`，`stroke-linecap: round`，`fill="none"`，继承 `currentColor`
- 不使用 Emoji 或彩色图标
- 旋转动画的 SVG 需加 `transform-box: fill-box; transform-origin: center` 防止旋转时改变按钮宽度

### 排版

- 字体：`PingFang SC`，fallback `Segoe UI`
- 导航文字：`13px`，选中态 `font-weight: 600`
- 卡片标题：`16px / 700`
- 正文：`13–14px / 400`
- 辅助信息：`11–12px`，`color: #8a8fa8`

### 交互规范

- 导航项 hover：背景 `rgba(123,127,178,0.08)`，文字 `rgba(30,32,40,0.82)`（不变为纯黑，保持克制）
- 导航项 active：背景 `rgba(255,255,255,0.38)`，文字 `var(--color-primary)`，`font-weight: 600`
- 底层面板 hover：`background`、`box-shadow` 以 `0.25s ease` 过渡，淡入淡出不突兀；统一定义在 `.glass-card` 的 `transition`，所有面板自动继承
- 按钮/卡片 hover：轻微 `translateY(-2px)` + 阴影增强，`transition: 0.25s cubic-bezier(0.34,1.2,0.64,1)`
- 文件/文件夹卡片 active：`translateY(1px) + opacity 0.93`，通过 `:active:not(:has(.fc-hover-actions:active))` 排除操作按钮点击时的下沉效果；卡片行为（布局、过渡、hover lift、active sink）统一提取至 `global.css` 的 `.fc-card` / `.folder-card`，各组件只保留 scoped 的颜色、尺寸、圆角差异
- **文件/文件夹卡片 hover 白色高亮**：`::after` 伪元素叠加 `rgba(255,255,255,0.15)`，`opacity 0→1`，`0.25s ease`，`z-index: 1`，定义在 `global.css`；内容层（文件名 `.fc-label`、类型徽章 `.fc-ext-badge` z-index:2、操作按钮 z-index:3）均高于 `::after`，白色仅覆盖缩略图/图标
- **不可拖动的卡片禁止 hover 浮起**：全局 `.fc-card:hover` 默认 `translateY(-2px)`；若卡片不支持拖动（如 Dashboard 最近文件），需在 scoped CSS 覆盖 `transform: none`，保留阴影加深和白色高亮，不产生位移
- **彩色胶囊/条 hover**：统一使用 `box-shadow: inset 0 0 0 100px rgba(255,255,255,0.45), 0 2px 6px rgba(80,90,110,0.1)`，`0.25s ease` 过渡；inset 阴影天然在内容之下，无需 z-index 操控，可覆盖 inline background。适用场景：近期节点胶囊（`.cap-row:hover .cap-capsule`，global.css 统一定义）、日历事件 chip、项目条、更多按钮、更多弹窗条目

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
- 样式：半透明面板（`rgba(255,255,255,0.66)` + `blur(24px)`，浮层弹窗独立使用 backdrop-filter），月份导航 + 7列日期网格 + 快捷操作（今天 / 清除）
- 选中日：`linear-gradient(135deg, #7b7fb2, #9590c4)` 渐变背景；今日：`rgba(123,127,178,0.15)` 浅紫高亮
- 动画：`dp-pop`（scale + translateY，spring 曲线）
- 点击外部关闭：`document.addEventListener('click', handler, true)` capture 阶段

### DateSpanPicker 组件

`components/common/DateSpanPicker.vue`，项目周期选择器（开始日 + 截止日）。

- 日期展示格式：**始终显示完整年份** `YYYY/M/D`，不因当前年份而省略（避免跨年项目歧义）
  ```js
  function fmt(iso) {
    if (!iso) return ''
    const d = new Date(iso + 'T00:00:00')
    return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`
  }
  ```

### Dashboard 总览

- **4 张统计卡片**：年度项目数（`totalCount`）/ 进行中（`activeCount`）/ 即将到期（`upcomingCount`，7天内截稿）/ 文件总数
- **项目列表**：阶段流 + 全宽进度条 + 截稿日 + 状态标签；已完成项目最多显示最近 2 条（按截稿日排序）
  - 项目名颜色：`darkenHex(color, 0.40)`（比胶囊标题 0.60 更深），`font-weight: 500`，两处（Dashboard + 看板卡片）统一
  - 行间分割线：`::before` 伪元素，`top: -3px` 居中于 `gap: 5px` 间隙，`rgba(0,0,0,0.1)`，左右各缩进 8px
  - 行 hover：`rgba(255,255,255,0.65)` 白色背景 + 外描边 `box-shadow: 0 0 0 1px rgba(255,255,255,0.8)` + 阴影 `0 2px 8px rgba(80,90,110,0.05)` + 顶边高光 `inset 0 1px 0 rgba(255,255,255,0.6)`，`0.25s ease` 淡入淡出
- **日历面板（CalendarPanel）**：
  - 月视图小日历，截稿日标记，点击日期选中
  - 点击年月标签弹出快速选择器（`<Teleport to="body">`）
  - 6行月份（42天）时日期格 `aspect-ratio` 从 `1` 改为 `6/5`（格高缩减为原来的 5/6），保持面板整体高度不变，近期节点列表不受限制始终全部显示
- **最近文件（FilePanel）**：`repeat(auto-fill, minmax(130px, 1fr))` 多列网格，卡片显示文件类型标签（ext badge）、项目彩点、文件名、大小、日期。含拖拽上传区。文件数量通过 `ResizeObserver` 动态计算，始终填满**恰好一行**：`displayCount = colCount - 1`（上传按钮占最后一格），列数公式 `Math.floor((panelWidth - 32) / 138)`

### 项目页（看板）

- **3 列看板**：待开始 / 进行中 / 已完成
- 看板整体高度：`calc(100vh - 152px)`，各列 `overflow-y: auto` 内部滚动，卡片 `flex-shrink: 0` 防止压缩
- **ProjectCard**：卡片背景 `linear-gradient(to right, rgba(255,255,255,0.9) 0%, rgba(255,255,255,1) 40%), ${project.color}`，左侧透出项目色，右侧纯白；显示开始日期→截稿日期 range、阶段点进度、截稿倒计时
  - 项目名颜色：`darkenHex(color, 0.40)`，`font-weight: 500`
  - hover：`::after` 伪元素叠加 `linear-gradient(to top, rgba(255,255,255,0.25), rgba(255,255,255,0.05))`，`opacity 0→1`，`0.3s cubic-bezier(0.34,1.2,0.64,1)` 与上移动画同步
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

**阶段待办事项**：

- 每个阶段下方常驻待办列表，数据结构 `{ key, label, todos: [{ id, text, done }] }` 存入 `stages_json`，无需新增数据表
- 待办增删改走独立 `saveTodos()` 直接调 `projectsApi.update({ stages, progress })`，绕过 `updateStages()` 的 `currentStage` 重算逻辑，防止进度被意外重置
- 阶段间分割线（`border-bottom` on `.todo-list`），最后一个阶段不加线；待办间分割线用 `.todo-item + .todo-item { border-top }` 相邻选择器，最后一条与「添加待办」按钮之间无线
- 「添加待办」按钮：`1px dashed` 虚线外框，hover 变主色，样式与「新建文件夹」按钮一致
- 待办重命名输入框：`border: 1.5px solid transparent` 占位（防文字偏移）；focus 时显示白底 + 紫色描边 `rgba(123,127,178,0.45)` + 外发光，与项目名重命名风格一致

**进度细分规则**：

| 场景 | 进度计算 |
|------|---------|
| 当前阶段**无**待办 | `(idx + 1) / totalStages × 100`（整阶段计入） |
| 当前阶段**有**待办 | `idx / totalStages × 100 + completedTodos / totalTodos / totalStages × 100` |

- `calcProgress(stages, currentStageKey)` 函数同时在 ProjectModal 和 ProjectCard 中使用，确保编辑弹窗头部进度条与看板卡片进度条数值一致
- 切换阶段或勾选/取消待办后均实时更新 `stageProgress ref` 并持久化 `progress` 字段至后端

**响应式 ref**：`localName`、`localColor`、`localCurrentStage`、`activeStageIdx`、`stageProgress` 均为独立 ref，在 `watch(project.id)` 时初始化，点击立即更新不等 props 刷新。

**右栏**：文件区，见文件库章节（ProjectModal 使用缩小参数版本）。

### NewProjectModal（新建项目弹窗）

`700px` 宽，两栏布局：左栏（客户 / 项目周期 / 看板状态 / 配色 / 备注）+ 右栏（阶段 + 模板）。

- 默认截止日期：一周后（`weekLaterIso()`）
- 默认阶段：读取 store 中最近一个项目的阶段列表；若无历史项目则用 `['计划', '执行', '交付']`
- 阶段模板：`useStageTemplates` composable，内置三个默认模板，用户可保存/删除/重命名，持久化至后端用户偏好；模板存储完整 `{ label, todos }` 对象，保存时保留待办内容，模板预览仅展示阶段名称
- `form.stages` 为 `{ label, todos: [] }[]` 对象数组；新建/应用模板/拖拽重排均操作同一结构，`handleCreate` 传递完整对象给 store，store 写入 `stages_json` 时生成 `key` 字段
- 右栏阶段编辑器每个阶段下常驻待办区，样式与 ProjectModal 待办一致（分割线、虚线添加按钮、重命名白底描边）；「添加待办」按钮右侧对齐到输入框末尾（`margin-right: 29px`）
- 右栏无额外背景色（与左栏统一透明）

### 弹窗动画规范（BaseModal 统一管理）

所有弹窗基于 `BaseModal.vue`，**禁止**在子弹窗重复定义遮罩、动画、Esc 逻辑。

- Transition name `bm`，duration `{ enter: 340, leave: 220 }`
- `.bm-overlay` 和 `.bm-card` 各自**纯 opacity** 过渡（进入 `cubic-bezier(0.4,0,0.2,1)` / 退出 `cubic-bezier(0.4,0,1,1)`）
- **禁止 transform**：`scale` 或 `translateY` 会让含 `backdrop-filter` 的浮层元素在动画帧间产生像素跳位（GPU compositing 问题）；底层 `.glass-card` 面板含 backdrop-filter，弹窗使用纯 opacity 动画同样避免此问题

| 弹窗 | width | height | zIndex |
|------|-------|--------|--------|
| NewProjectModal | 700px | — | 300 |
| UploadModal | 520px | — | 300 |
| ProjectModal | 900px | 680px | 200 |
| FilePreviewModal | 860px | min(90vh,880px) | 400 |

### 日历页（Calendar）

- **布局**：工具栏（年月导航 + 今天按钮）+ 主区（月视图）+ 侧栏（当天日程 + 近期截稿）
- **月视图**：
  - 日期格：`padding: 7px 6px 4px`，日期数字 24px 圆圈，今日渐变高亮（平日 `#7b7fb2→#9590c4` 紫灰，周末 `#b85c5c→#c97070` 低饱和红），选中浅紫背景
  - 项目横跨条（`bars-layer`）：`position: absolute; inset: 0` 覆盖整行，条的 top 偏移从格顶 **36px** 开始（清开 31px 的日期圆圈区域），每行间距 22px，最多显示 3 条，超出显示 `+N 更多`（可点击弹出列表）
  - 事件 chip：通过 `padding-top` 推至条下方显示（不再使用 `v-if` 隐藏），每日最多显示 `3 - 当日条数` 个 chip
  - 周行动态最小高度：`min-height: max(92px, calc(38px + var(--bar-rows, 0) * 22px + 14px))`
  - 项目条圆角：默认 0，仅在起始端 `border-radius: 99px 0 0 99px`，终止端 `0 99px 99px 0`，单日满圆 `99px`
  - **日期格 hover**：用 `mousemove` 在 `.week-row` 级别计算当前列（`Math.floor((x / width) * 7)`），设 `hoveredDateIso`，通过 `.cell-hovered` class 触发背景高亮，替代 CSS `:hover`；原因：`.bars-layer` 是 `.month-cell` 的兄弟元素，鼠标移到项目条上时 `:hover` 会丢失导致闪烁，`mousemove` 方案不受 DOM 层级影响
  - **交互元素 hover 统一**：项目条、事件 chip、更多按钮、更多弹窗条目全部使用 `inset 0 0 0 100px rgba(255,255,255,0.45)` + `0 2px 6px rgba(80,90,110,0.1)` box-shadow，`0.25s ease` 淡入淡出；多行项目条用 `hoveredBarId` ref 联动，鼠标进入任意段即高亮全部段
  - **项目条进度可视化**：背景使用进度渐变（同胶囊规范），以项目实际日期计算每周段的填充比（`barSegFill`），跨行段进度连贯；已完成区域 `accent` 32% 不透明，未完成区域 10%
- **侧栏**：
  - 当天日程：事件名 + 元信息（客户 + 类型标签）；无客户时省略分隔符 `·`；未知类型显示"事件"；卡片 hover 叠加 `rgba(255,255,255,0.2)` inset + `0 3px 10px rgba(0,0,0,0.10)` 外阴影，`0.25s ease` 淡入淡出
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
  - 工具栏 `position: relative; z-index: 20`，防止下拉菜单被文件卡片遮挡（`.glass-card` 含 `backdrop-filter` 会创建新层叠上下文，需显式 z-index 控制层序）
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

## 七、文案规范

### 产品称呼

- AI 助手统一称为**「咕咕」**，任何界面、提示文字、设置项中不使用「AI 助手」「机器人」「Bot」等词
- 产品名为**「咕咕」**，副品牌/域名为 gugugu.site

### 状态文案

- 功能尚未开放，统一显示**「咕了」**（胶囊标签形式），不使用「即将推出」「Coming Soon」「敬请期待」
- 占位说明文字应简洁自然，避免技术术语

### 禁用词汇

| 禁用 | 替代 |
|------|------|
| AI 助手 / 机器人 | 咕咕 |
| 控制 / 管理 | 设置 / 调整 |
| OpenClaw / 插件名 | 即时通讯工具 |
| 登录名 | 用户名 |

### 设置页分区逻辑

- **个人信息**：昵称（可改）在上，用户名/邮箱/UID/加入时间（只读）在下
- **账号设置**：密码修改
- **偏好设置**：外观、工作台、日历、通知
- **咕咕设置**：咕咕回复风格、即时通讯接入（OpenClaw，暂不开放）

---

## 八、设计文件

| 文件 | 说明 |
|------|------|
| `design/prototype.html` | 可交互 HTML 原型稿（Dashboard 总览） |
| `docs/design.md` | 本文档 |
