# 咕咕 · Admin 后台设计规范

> 后台与前台是独立的两套视觉体系，前台浅色毛玻璃，后台深色暗玻璃。
> 最后更新：2026-07-02（`.icon-btn` 收编为 AdminApp.vue 全局唯一定义；`.popup-menu-dark` 模糊接 `--popup-blur` 变量）

## 概述

这是咕咕 Admin 后台（管理员侧）的设计规范手册，给写代码的人（含未来改代码的 AI）对照用。视觉体系与前台完全独立：前台是浅色毛玻璃，后台是**深色 Glassmorphism**——深紫黑渐变背景 + 低透明度白色面板 + 细描边高光，整体更沉稳、信息密度更高（大量表格、日志、配置表单）。当前 Admin 已经是默认暗色产品，但页面仍存在较多局部硬编码值；后续设计令牌迁移会保留这套深色定位，只抽取共享基础尺度和 Admin 专属语义变量。全文按「整体视觉风格 → 色彩系统 → 布局结构 → 侧边栏 → 全局组件（按钮/表单/下拉等）→ 弹窗规范 → 表格规范 → 分页 → 页面列表 → 图标 → z-index → 路由结构」组织，具体页面的样式规则集中在「全局组件」「表格规范」等章节，改代码时直接定位对应章节查数值即可。

---

## 一、整体视觉风格

- **主题**：深色 Glassmorphism，高饱和度低亮度暗背景 + 半透明面板叠加
- **背景**（主内容区）：`linear-gradient(150deg, #0f1117 0%, #121626 40%, #161b30 70%, #1a1e38 100%)`，`background-attachment: fixed`
- **侧边栏背景**：`linear-gradient(180deg, #0e101a 0%, #11131f 60%, #13152a 100%)`
- **卡片面板**：`rgba(255,255,255,0.05)` + `backdrop-filter: blur(24px)` + `border: 1px solid rgba(255,255,255,0.09)` + `border-radius: 16px`
- **卡片内高光**：`inset 0 1px 0 rgba(255,255,255,0.06)` 顶边微光
- **卡片阴影**：`0 4px 24px rgba(0,0,0,0.25)`

---

## 二、色彩系统

当前少量基础值来自前台 CSS 变量（`variables.css`），但 Admin 的实际语义值主要由 Admin 布局、全局样式和页面局部样式维护。后续迁移应改为共享基础尺度、独立 Admin 语义变量，而不是继续直接复用前台 surface：

| 用途 | 色值 |
|------|------|
| 主色（紫灰） | `#7b7fb2` / `#9590c4` |
| 渐变主色 | `linear-gradient(135deg, #7b7fb2, #9590c4)` |
| 激活态背景 | `rgba(123,127,178,0.18~0.20)` |
| 激活态边框 | `rgba(123,127,178,0.32~0.35)` |
| 激活态文字 | `rgba(255,255,255,0.88~0.92)` |
| 主文字 | `rgba(255,255,255,0.88)` |
| 次要文字 | `rgba(255,255,255,0.45~0.55)` |
| 辅助文字 | `rgba(255,255,255,0.28~0.35)` |
| 分割线 | `rgba(255,255,255,0.07~0.09)` |
| 成功 | `#5ab899` / `rgba(90,184,153,0.x)` |
| 错误 | `rgba(220,80,80,0.x)` / `#e07878` |
| 警告 | `rgba(210,160,60,0.x)` |

主题边界：Admin 默认保持暗色，不跟随主应用的 `light/dark/system` 切换。迁移目标是在布局入口增加 `.admin-theme` 作用域；字号、间距、圆角档位、状态语义、动效和滚动条行为可以共享，页面背景、面板、文字、边框、阴影和透明度使用 Admin 独立映射。

---

## 三、布局结构

```
┌──────────────┬──────────────────────────────────┐
│  侧边栏       │  主内容区                         │
│  220px        │  flex: 1，overflow-y: auto        │
│  固定高度     │  height: 100vh                    │
└──────────────┴──────────────────────────────────┘
```

页面内容区统一 padding（所有带标题 + 工具栏的页面均遵循）：

| 区域 | 样式 |
|------|------|
| 标题区（`.page-header`） | `padding: 32px 36px 0` |
| 筛选栏 / 工具栏 / Tab 栏 | `padding: 18px 36px 0` |
| 主体内容区 | `padding: 14px 36px 32px`（卡片式内容）或 `margin: 14px 36px 32px`（带边框的表格容器） |

**标题区子元素规范**（`.page-title-block`）：
- 页面标题（`.page-title`）：`font-size: 22px; font-weight: 700; color: rgba(255,255,255,0.92); line-height: 1`
- 页面描述（`.page-desc`）：`font-size: 12px; color: rgba(255,255,255,0.35); margin-top: 6px`

---

## 四、侧边栏规范

**尺寸**：`width: 220px`，`padding: 24px 14px`

**品牌区**：
- Logo 图标：`34×34px`，`border-radius: 10px`，紫灰渐变背景，内含 SVG 图标
- 产品名：`16px / 700`，`rgba(255,255,255,0.92)`
- 副标签"管理后台"：`10px`，`rgba(255,255,255,0.3)`

**分割线（`.sidebar-rule`）**：
- `height: 1px`，两端透明渐变：`linear-gradient(90deg, transparent, rgba(255,255,255,0.07) 30%, rgba(255,255,255,0.07) 70%, transparent)`
- 配置与管理区之间加 `margin: 14px 4px`

**导航组标题（`.nav-group-label`）**：
- `10px / 600 / uppercase / letter-spacing: 0.08em`
- `rgba(255,255,255,0.2)`，`padding: 0 10px; margin-bottom: 4px`

**导航项（`.nav-item`）**：

| 状态 | 样式 |
|------|------|
| 默认 | `rgba(255,255,255,0.45)`，透明背景 |
| hover | `rgba(255,255,255,0.75)`，`rgba(255,255,255,0.06)` 背景 |
| 激活（`.router-link-active`） | `rgba(255,255,255,0.92)` + `rgba(255,255,255,0.1)` 背景 + `border: 1px solid rgba(255,255,255,0.12)` + `font-weight: 600` |
| 禁用（`.disabled`） | `rgba(255,255,255,0.18)`，不可点击 |

图标：`15×15px`，前台 SVG 内联（`stroke-width: 1.5`），后续可迁移至 Phosphor

**Soon 标签（`.nav-badge`）**：
- `9px / 600`，`rgba(255,255,255,0.2)` 文字 + `rgba(255,255,255,0.05)` 背景，胶囊形

**用户卡片（底部）**：
- `padding: 10px`，`border-radius: 14px`，`rgba(255,255,255,0.07)` 背景
- 头像：`32px` 圆，紫青渐变，首字母大写
- 用户名：`13px / 600`，`rgba(255,255,255,0.75)`
- 退出按钮：`24×24px`，`border-radius: 7px`，`rgba(255,255,255,0.28)` → hover `0.7`

---

## 五、全局组件

### `.config-card`（内容卡片）

```css
background: rgba(255,255,255,0.05);
backdrop-filter: blur(24px);
border: 1px solid rgba(255,255,255,0.09);
border-radius: 16px;
padding: 22px 24px;
box-shadow: 0 4px 24px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.06);
```

### 卡片头部（`.card-head`）

- `display: flex; align-items: center; gap: 13px; margin-bottom: 20px`
- 图标区：`38×38px`，`border-radius: 11px`，由 `--ic`（背景）和 `--stroke`（颜色）CSS 变量控制
- 标题：`14px / 700`，`rgba(255,255,255,0.88)`
- 描述：`12px`，`rgba(255,255,255,0.38)`

### 按钮规范

**主按钮（`.btn-primary`）**：
```css
padding: 6px 16px; border-radius: 9px; border: none;
background: linear-gradient(135deg, #7b7fb2, #9590c4);
color: white; font-size: 13px; font-weight: 600;
box-shadow: 0 2px 8px rgba(123,127,178,0.18);
```
hover：`opacity: 0.88`；disabled：`opacity: 0.5`

**幽灵按钮（`.btn-ghost`）**：
```css
padding: 6px 14px; border-radius: 9px;
border: 1px solid rgba(255,255,255,0.1);
background: rgba(255,255,255,0.06);
color: rgba(255,255,255,0.45); font-size: 13px;
```

**图标按钮（`.icon-btn`，Admin 全局唯一定义）**：样式在 **`AdminApp.vue` 非 scoped `<style>`**（只进 admin 打包、不影响前台同名类），**所有页面共用、别在页面里再定义**（历史上各页复制了 7 份 + `.btn-refresh`/`.svc-refresh` 变体，2026-07-02 已全部收编）：
```css
width: 34px; height: 34px; border-radius: 9px;
border: 1px solid rgba(255,255,255,0.1);
background: rgba(255,255,255,0.05);
color: rgba(255,255,255,0.5);
display: flex; align-items: center; justify-content: center;
```
旋转动画（点击转一圈，非持续转）：`.icon-btn.spinning svg { animation: admin-icon-spin 0.5s ease-out; }`；图标统一 `<PhArrowClockwise :size="15" weight="bold" />`。

**全局规则：刷新按钮只在手动点击时旋转**，初始加载不触发。实现方式：用独立的 `refreshing` ref 控制 `.spinning` class，不与 `loading` 绑定；`load(manual = false)` 中 `refreshing.value = manual`，`onMounted` 调用 `load()` 不传参。

**切换按钮组（`.toggle-btn`）**：
- 默认：`padding: 6px 16px; border-radius: 9px; font-size: 13px; font-weight: 500; color: rgba(255,255,255,0.38)`
- 激活：`background: rgba(123,127,178,0.2); border-color: rgba(123,127,178,0.35); color: rgba(255,255,255,0.88); font-weight: 600`
- **字重切换防位移**：按钮须设 `display: inline-flex; flex-direction: column; align-items: center`，加 `::after { content: attr(data-label); font-weight: 600; height: 0; overflow: hidden; visibility: hidden; }` 预留加粗宽度，模板同步加 `:data-label="label"`

**Tab 按钮（`.tab-btn`）**：同 toggle-btn，`padding: 7px 18px; border-radius: 10px`，同样需要字重防位移处理

**导出 CSV 按钮**：
```css
padding: 7px 14px; border-radius: 9px; font-size: 12px;
border: 1px solid rgba(255,255,255,0.1);
background: rgba(255,255,255,0.06);
color: rgba(255,255,255,0.5);
```

### 表单输入（Admin 版）

```css
/* 通用 filter-input */
padding: 7px 12px; border-radius: 9px;
border: 1px solid rgba(255,255,255,0.1);
background: rgba(255,255,255,0.06);
font-size: 13px; color: rgba(255,255,255,0.75);
```
focus：`border-color: rgba(123,127,178,0.4); box-shadow: 0 0 0 3px rgba(123,127,178,0.1)`

### `AdminSelect`（暗色下拉选择器）

- 触发器：filter-input 同款样式，`min-width: 120px`
- 弹窗：使用 `<Teleport to="body">` + `getBoundingClientRect()` 定位，宽度与触发器一致
- 弹窗样式：`.popup-menu-dark`（见下）
- 选项：`.popup-menu-item`，激活项加 `.active` class

### `AdminDatePicker`（暗色日期选择器）

- 触发器：`justify-content: center`，清除按钮绝对定位在右侧
- 弹窗：`width: 248px`，`.popup-menu-dark`，居中于触发器（`left = rect.left + rect.width/2 - 124`）
- 日历头：单个"YYYY年M月"按钮，点击展开年份选择器
- 年份选择器：独立 Teleport，`.popup-menu-dark`，3列×4行网格，上下翻页
- 今日标记：紫色圆圈；选中日：紫色实心填充
- 暗色日期原生 input：全局 `color-scheme: dark`

---

## 六、全局弹窗规范（`.popup-menu-dark`）

Admin 后台所有下拉/弹窗使用暗色版本，与前台 `.popup-menu` 结构相同但配色不同：

```css
.popup-menu-dark {
  background: rgba(20, 22, 38, 0.94);
  backdrop-filter: var(--popup-blur);   /* 小弹窗统一 12px，变量在 variables.css，与前台同一套 */
  border: 1px solid rgba(255,255,255,0.11);
  border-radius: 10px;
  box-shadow: 0 4px 24px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06);
  padding: 4px;
}
```

子类样式：

| 子类 | 样式 |
|------|------|
| `.popup-menu-item` | `rgba(255,255,255,0.72)`，hover `rgba(255,255,255,0.07)` 背景 + `rgba(255,255,255,0.92)` |
| `.popup-menu-item.active` | `rgba(160,150,235,0.95)` + `font-weight: 600` |
| `.popup-menu-item.danger` | `rgba(220,100,100,0.9)`，hover 红色背景 |
| `.popup-menu-sep` | `rgba(255,255,255,0.08)`，`margin: 3px 6px` |
| `.popup-close-btn` | `rgba(255,255,255,0.35)`，hover `rgba(255,255,255,0.08)` 背景 |
| `.popup-menu-shortcut` | `rgba(255,255,255,0.3)` |

所有弹窗通过 `<Teleport to="body">` 渲染，用 `getBoundingClientRect()` + `window.scrollY` 定位，避免被 `overflow: hidden` 裁剪。

---

## 七、表格规范

Admin 日志类页面（操作日志、系统日志）使用统一表格风格：

```css
/* 容器 */
background: rgba(255,255,255,0.04);
border: 1px solid rgba(255,255,255,0.08);
border-radius: 14px;
overflow: hidden;

/* 表头行 */
font-size: 11px; font-weight: 600; letter-spacing: 0.06em;
text-transform: uppercase;
color: rgba(255,255,255,0.25);
border-bottom: 1px solid rgba(255,255,255,0.07);
padding: 10px 16px;

/* 数据行 */
font-size: 12~13px;
border-bottom: 1px solid rgba(255,255,255,0.05);
padding: 10~12px 16px;
```

**IP 地址**：`font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; color: rgba(255,255,255,0.3)`

**操作类型标签**（色块）：

| 类型 | 背景 | 文字 |
|------|------|------|
| `login` | `rgba(90,184,153,0.15)` | `rgba(90,200,160,0.9)` |
| `config` | `rgba(123,127,178,0.15)` | `rgba(160,155,220,0.9)` |
| `invite` | `rgba(122,184,200,0.15)` | `rgba(122,184,200,0.9)` |
| `prompt` | `rgba(196,175,200,0.15)` | `rgba(196,175,200,0.9)` |

**系统日志级别标签**：

| 级别 | 背景 | 文字 |
|------|------|------|
| `ERROR` | `rgba(220,80,80,0.15)` | `rgba(240,120,120,0.95)` |
| `WARNING` | `rgba(210,160,60,0.15)` | `rgba(230,180,80,0.95)` |
| `INFO` | `rgba(80,180,140,0.12)` | `rgba(100,200,160,0.9)` |

系统日志行有 traceback 时可点击展开，展开区 `pre` 样式：
```css
background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.07);
font-family: 'SF Mono','Fira Code','Consolas',monospace;
font-size: 11px; color: rgba(240,120,120,0.85);
```

---

## 八、分页规范

```css
/* 翻页按钮 */
width: 30px; height: 30px; border-radius: 8px;
border: 1px solid rgba(255,255,255,0.09);
background: rgba(255,255,255,0.05);
color: rgba(255,255,255,0.5);
/* 页码信息 */
font-size: 12px; color: rgba(255,255,255,0.35); min-width: 60px; text-align: center;
```

页面内分页（前端分页）默认 20/50/100 条可选，日志页面默认 50 条。

---

## 九、页面列表

### 系统配置（Config）

- 选项卡：数据库 / Redis / OSS / 应用设置
- 每个 section 为一个 `.config-card`
- 表单控件：`ConfigField` 组件（label + input，密码字段用 password type）
- 底部操作栏：测试连接按钮 + 状态指示点（`.status-dot`）+ 保存按钮

### Agent 配置（Agent）

- 顶部 tab 切换：LLM 配置 / 系统提示词 / 行为配置 / 用量统计
- LLM：provider 切换（toggle-btn 组）+ API Key / Base URL / Model 字段
- 系统提示词：左侧 textarea（Monaco 风格等宽字体）+ 右侧占位符说明面板；profile 切换在卡片头部右侧
- 行为配置：toggle-switch + number input 列表
- 用量统计：汇总卡片组 + SVG 折线图 + 按模型分组表格

**用量统计交互**：
- 点击模型行筛选图表，激活行高亮（`rgba(123,127,178,0.12)` 背景），其余行 `opacity: 0.35`
- 图表 metric 旁显示选中模型名标签（`.model-filter-tag`）
- 切换模型时不隐藏图表（无全页 loading），只有折线图区 `opacity: 0.5` 过渡

### 操作日志（AuditLog）

- 筛选栏：`AdminSelect`（操作类型）+ 关键词 input + `AdminDatePicker`（开始/结束日期）+ 刷新 + 导出 CSV
- 表格：时间 / 操作者 / 操作类型（色标） / 描述 / IP（等宽字体）
- 前端分页

### 系统日志（SystemLogs）

- 筛选栏：`AdminSelect`（级别：全部/ERROR/WARNING/INFO）+ 刷新
- 表格：时间 / 级别（色标） / 模块（等宽字体）/ 消息
- 有 traceback 的行可点击展开，展开区显示红色等宽字体 pre

---

## 十、图标规范

- 刷新按钮：`<PhArrowClockwise :size="15" weight="bold" />`（Phosphor Icons），全页面统一
- 旋转动画：`.spinning svg { animation: spin 0.7s linear infinite; transform-box: fill-box; transform-origin: center; }`
- 侧边栏导航图标：手写内联 SVG，`stroke-width: 1.5; stroke-linecap: round; fill: none`，后续迁移至 Phosphor

---

## 十一、z-index 层级

| 层 | 值 | 用途 |
|----|----|------|
| 侧边栏 | — | 正常文档流 |
| 主内容 | — | 正常文档流 |
| Teleport 弹窗（AdminSelect / AdminDatePicker / 年份选择器） | 9000+ | 通过 `position: fixed` + Teleport 渲染 |

---

## 十二、路由结构

```
/login          → 独立登录页（无 AdminLayout）
/               → AdminLayout
  /config       → 系统配置（默认页）
  /agent        → Agent 配置
  /audit-log    → 操作日志
  /system-logs  → 系统日志
```

Dev 服务器：端口 `5174`，直接打开 `/login`（独立 `vite.admin.config.js`）
Build 输出：`dist/admin/`，可独立部署到任意 nginx 路径
