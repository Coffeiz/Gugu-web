# 设计令牌与 `/design` 页面重构方案

> 状态：实施中（Phase 0 已完成，Phase 1 进行中）
>
> 调查日期：2026-08-15
>
> 关联 PRD：`docs/product/PRD/PRD-UI-1-设计令牌与主题体系.md`
>
> 目标：建立可复用、可主题化、可观察的设计令牌体系，并提供 `/design` 作为运行时样式实验室。

## 1. 结论与设计原则

### 1.1 总体结论

咕咕当前已经有一套基础视觉变量，但颜色、透明度、字号、圆角、阴影和局部动效仍大量散落在页面组件中。下一步不适合直接全局替换，而应先建立令牌契约和 `/design` 页面，再按共享组件和页面族逐步迁移。

令牌系统参考本地 Mafuyu-web 项目的做法：

- 令牌独立于全局业务样式。
- 基础值与主题覆盖分离。
- 主题通过根节点属性切换。
- 主题状态集中管理。
- 通过专门页面展示真实令牌和组件状态。

但咕咕的页面和交互更复杂，因此需要额外区分 Admin、Mind/画布、普通 UI 动效和画布物理参数，不能直接复制 Mafuyu 的单文件结构。

当前盘点确认：Admin 在视觉上已经是一套独立的深色 Glassmorphism 体系，但代码层还没有真正形成独立主题层。整体背景由 `AdminLayout.vue` 维护，多个 Admin 页面仍直接写入暗色背景、文字、边框、阴影和圆角值；只有部分弹窗和基础样式复用了全局变量。因此 Admin 的迁移重点不是重新设计颜色，而是把现有暗色语义抽取到独立作用域，并消除页面间重复值。

### 1.2 硬性约束

1. 页面和组件优先使用语义令牌，不直接写品牌色和通用透明度。
2. 间距、圆角和字体大小各自只保留 4 个主档位。
3. 透明度、阴影和 blur 按语义收敛，不为单个组件无限增加新值。
4. 主应用支持 `light`、`dark`、`system`。
5. Admin 默认使用独立暗色主题，不与主应用 `dark` 主题混用，也不跟随主应用的 `light/dark/system` 切换。
6. 共享的是基础尺度和行为契约，不直接共享主应用的 surface/content/border/shadow 具体值。
7. Mind/画布的 camera、物理、landing 和 connection 行为由 Runtime/交互模块管理，不被普通令牌迁移改写。
8. `/design` 展示页直接读取运行时 CSS 变量，不重复维护一份实际数值。
9. 动态业务颜色可以通过受控的局部 CSS 变量传入，但必须明确例外原因。

### 1.3 滚动条契约

滚动条统一为低干扰的 CSS 滚动条，不采用全局隐藏。普通页面需要保留滚动可发现性；画布和笔记横向拖拽区等已有替代交互的区域，才允许隐藏滚动条。

滚动条只保留三档尺寸：

```css
--scrollbar-size-compact: 3px;
--scrollbar-size-default: 5px;
--scrollbar-size-editor: 8px;
```

语义映射：

| 类型 | 用途 |
|---|---|
| `compact` | 侧栏、看板列、抽屉、通知列表、弹窗内部 |
| `default` | 主页面、聊天、文件列表、普通内容面板 |
| `editor` | Agent prompt、代码块、长文本编辑器 |

统一滚动容器类：

```text
.scroll-surface
.scroll-surface--compact
.scroll-surface--editor
.scroll-surface--hidden
```

其中 `scroll-surface--hidden` 只用于有明确替代操作反馈的横向画布/笔记滚动区，不用于普通纵向列表。

滚动条的颜色和主题覆盖使用语义令牌：

```css
--scrollbar-track: transparent;
--scrollbar-thumb: rgba(123, 127, 178, 0.22);
--scrollbar-thumb-hover: rgba(123, 127, 178, 0.38);
--scrollbar-corner: transparent;
```

Admin 只覆盖颜色，不复制一套滚动行为：

```css
.admin-theme {
  --scrollbar-thumb: rgba(255, 255, 255, 0.12);
  --scrollbar-thumb-hover: rgba(255, 255, 255, 0.22);
}
```

滚动容器默认使用 `scrollbar-gutter: stable`，需要双侧对齐的时间线或面板使用 `stable both-edges`。组件不再各自手写 `::-webkit-scrollbar`，只在编辑器和隐藏横向区保留明确特例。

## 2. 现状调查

### 2.1 页面与视觉表面

当前前端页面可以归纳为三套主要视觉表面：

| 视觉表面 | 页面/模块 | 主要特征 |
|---|---|---|
| 主应用浅色玻璃 | 项目、日历、文件、日程、聊天、个人资料、预览弹窗 | 冷灰紫背景、半透明白色面板、毛玻璃、轻阴影 |
| Mind 工作区 | 笔记、画布、抽屉、画布卡片、连接线 | 全屏、点阵、摄像机、自由布局、物理拖拽 |
| Admin 深色管理 | 配置、Agent、用户、日志、服务、运维等 | 深色面板、透明文字、表格和配置行密集布局 |

另有认证页面：登录、注册、找回密码、重置密码和隐私页。这些页面应共享字体、表单、按钮和状态令牌，但不必强行套用主应用全部玻璃结构。

主应用公共壳层目前包含顶栏、侧栏、聊天入口、通知、项目弹窗、活动弹窗、上传弹窗、文件预览、个人资料和浮动预览窗口。

### 2.2 当前令牌基础

当前基础文件：

```text
frontend/src/assets/styles/variables.css
```

已有变量覆盖：

- 页面背景渐变
- 玻璃背景、边框、blur 和 shadow
- 主色、次色、第三强调色
- 成功色、警告色
- 主文字、次文字
- 少量圆角、尺寸和字体变量

当前问题是覆盖范围不足，而不是完全没有令牌。业务样式仍会重复写相同或相近的值。

### 2.3 颜色问题

源码中重复出现大量直接颜色值，调查得到的高频值包括：

- `#7b7fb2`：约 164 次
- `#9590c4`：约 73 次
- `#1e2028`、`#8a8fa8`：多处重复
- 大量不同透明度的白色、黑色和主色

主色、次文字色、状态色和导航色之间没有始终通过语义变量表达。Admin、Calendar、Files、ProfileModal 和 GuguChat 的局部样式尤其密集。

### 2.4 玻璃层问题

当前基础变量包含 `--glass-bg` 和 `--glass-blur`，但日程面板、看板列、弹窗、拖拽代理和浮动窗口又各自覆盖透明度、blur 或 shadow。

这些差异可能是有意的，但目前缺少明确语义名称。后续至少需要区分：

- 页面玻璃
- 普通面板
- 密集列面板
- 普通卡片
- 弹窗
- 拖拽代理
- 浮动窗口

### 2.5 尺度问题

当前源码中 `6px`、`8px`、`10px`、`11px`、`12px`、`13px`、`14px`、`16px` 等值大量散落，部分位置还有 `10.5px`、`11.5px`、`12.5px` 等局部字号。

圆角从 4px 到 20px 以及多个胶囊值并存，与现有 `--radius-sm/md/lg` 不完全一致。

目标不是把每一个历史值都包装成变量，而是将其映射到有限的标准档位。

### 2.6 阴影与动效问题

普通卡片、玻璃面板、弹窗、拖拽代理、画布卡片和 Admin 面板各自存在相近但不完全一致的阴影。普通 hover、press、modal、drawer 动效也与画布物理动效混杂在不同组件中。

画布速度、阻尼、camera、landing 和 connection 参数必须保留在 Runtime/交互模块中。设计令牌只管理必要的视觉表面和普通 UI 动效，不替代物理模型。

### 2.7 现有规范问题

`docs/development/design.md` 已经记录了主应用玻璃、颜色、排版和交互规范，但具体数值和源码实际值存在偏差。后续应让 CSS 令牌成为运行时主数据，设计文档保留原则、命名和使用约束，具体值由 `/design` 直接展示。

## 3. 目标令牌架构

### 3.1 目录结构

建议将样式目录调整为：

```text
frontend/src/assets/styles/
├── global.css
├── variables.css              # 兼容入口，最终只负责导入 tokens/index.css
└── tokens/
    ├── primitives.css         # 色板、透明度、间距、字号、圆角、滚动条尺寸、基础阴影
    ├── semantic.css           # surface、content、border、action、status、layer
    ├── components.css         # 卡片、弹窗、侧栏、按钮、输入框
    ├── motion.css             # 普通 UI 动效
    ├── canvas.css             # 画布视觉扩展，不含物理算法
    ├── admin.css              # Admin 暗色语义
    ├── themes.css             # light/dark/system 主题覆盖
    └── index.css              # 统一导入入口
```

导入关系：

```css
/* variables.css */
@import './tokens/index.css';
```

```css
/* tokens/index.css */
@import './primitives.css';
@import './semantic.css';
@import './components.css';
@import './motion.css';
@import './canvas.css';
@import './admin.css';
@import './themes.css';
```

### 3.2 基础层：`primitives.css`

只放不表达业务用途的基础值：

```css
:root {
  --palette-purple-500: #7b7fb2;
  --palette-purple-400: #9590c4;
  --palette-gray-050: #f5f6fa;
  --palette-gray-900: #1e2028;

  --alpha-white-08: rgba(255, 255, 255, 0.08);
  --alpha-white-56: rgba(255, 255, 255, 0.56);
  --alpha-black-08: rgba(0, 0, 0, 0.08);

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 16px;
  --space-4: 24px;

  --font-size-xs: 11px;
  --font-size-sm: 12px;
  --font-size-md: 14px;
  --font-size-lg: 16px;

  --radius-xs: 6px;
  --radius-sm: 10px;
  --radius-md: 14px;
  --radius-lg: 18px;
  --radius-pill: 999px;
}
```

具体数值需要通过 `/design` 页面验证后确定，不能在迁移阶段直接替换所有历史值。

### 3.3 间距、圆角与字号约束

间距、圆角和字体大小是硬性收敛项：各自只保留 4 个主档位。`radius-pill` 是形状例外，不计入普通圆角档位。

推荐初始映射：

| 用途 | 圆角 | 字号 |
|---|---|---|
| 页面/大面板 | `radius-lg` | `font-size-lg` |
| 普通卡片 | `radius-md` | `font-size-md` / `font-size-lg` |
| 小控件、输入框、标签 | `radius-sm` | `font-size-sm` |
| 胶囊、状态徽标 | `radius-pill` | `font-size-xs` |

间距使用 `space-1` 到 `space-4` 四档，组件通过用途选择档位，不再为页面单独增加间距值。

历史上的 `4px`、`5px`、`7px`、`8px`、`9px`、`10.5px`、`11.5px`、`12.5px` 等值，迁移时映射到最近标准档位。只有图标像素对齐、画布几何、第三方组件固定要求或设计稿明确确认的值可以作为局部例外，并必须记录原因。

### 3.4 语义层：`semantic.css`

页面和业务组件主要消费语义层：

```css
:root {
  --surface-page: ...;
  --surface-glass: ...;
  --surface-glass-dense: ...;
  --surface-panel: ...;
  --surface-popup: ...;
  --surface-card: ...;
  --surface-drag-proxy: ...;

  --content-primary: ...;
  --content-secondary: ...;
  --content-muted: ...;
  --content-on-accent: ...;

  --border-subtle: ...;
  --border-strong: ...;
  --border-focus: ...;

  --action-primary: ...;
  --action-primary-hover: ...;
  --status-success: ...;
  --status-warning: ...;
  --status-danger: ...;

  --layer-sidebar: 10;
  --layer-topbar: 20;
  --layer-popup: 100;
  --layer-modal: 200;
  --layer-drag: 300;
}
```

### 3.5 组件层：`components.css`

只为跨页面重复的组件提供语义参数：

```css
:root {
  --card-radius: var(--radius-md);
  --card-shadow: var(--shadow-rest);
  --card-shadow-hover: var(--shadow-hover);
  --popup-radius: var(--radius-md);
  --popup-shadow: var(--shadow-popup);
  --control-height-sm: 32px;
  --control-height-md: 38px;
}
```

项目品牌色、文件类型色和数据驱动颜色继续使用局部变量，例如 `--project-accent`，不强行写入全局色板。

### 3.6 动效层：`motion.css`

只收敛普通 UI 动效：

- hover、press 和状态切换
- 弹窗进入和退出
- 抽屉展开和收起
- 普通列表过渡
- reduced-motion 降级

画布的速度、阻尼、landing、camera 和连接线行为仍由 Runtime/交互模块管理。

### 3.7 画布层：`canvas.css`

管理画布视觉扩展：

- 点阵颜色和密度
- 画布卡片基础表面
- node 连接点
- connection 颜色、宽度和虚线样式
- 抽屉宽度和层级
- 画布卡片抓取和 landing 的视觉变量

这里不承载对象注册、拖拽编排或 camera 算法。

## 4. 主题方案

### 4.1 主应用主题

主题通过根节点属性生效：

```html
<html data-theme="light">
```

主应用支持：

- `light`：浅色玻璃主题
- `dark`：主应用暗色主题
- `system`：跟随系统并监听系统主题变化

组件只能使用语义令牌，不根据主题自行复制一套选择器。主题文件负责覆盖 surface、content、border、shadow 和状态相关映射。

### 4.2 主题状态职责

新增 `useTheme` composable 或主题 store，负责：

- 读取和持久化用户选择
- 解析系统主题
- 设置 `document.documentElement.dataset.theme`
- 设置 `color-scheme`
- 监听系统主题变化
- 提供当前选择和实际生效主题

入口 HTML 只执行首屏初始化：读取主题偏好、解析系统主题、设置根节点属性，避免 Vue 挂载前出现明显闪烁；完整切换逻辑仍由主题状态模块负责。

### 4.3 Admin 主题

#### 当前状态

Admin 已经是默认暗色产品，但当前主要依赖 `.admin-layout`、Admin 全局样式和各页面 scoped 样式，尚未落地统一的 `.admin-theme` 语义容器。现有代码中仍有较多重复的暗色 literal，尤其是面板透明度、白色文字透明度、紫色强调色、边框和圆角。

#### 目标结构

Admin 不直接复用主应用的浅色 surface，也不跟随用户侧 `data-theme="dark"` 自动切换。迁移后使用独立主题作用域：

```html
<div class="admin-theme">
  <!-- Admin 页面 -->
</div>
```

Admin 可以共享字号、间距、圆角档位、状态语义、动效命名和滚动条行为，但 surface、content、border、shadow、玻璃透明度和背景渐变使用独立映射。

推荐分层：

```css
:root {
  --space-1: ...;
  --radius-sm: ...;
  --font-size-body: ...;
}

.admin-theme {
  --surface-page: ...;
  --surface-panel: ...;
  --content-primary: ...;
  --content-secondary: ...;
  --border-subtle: ...;
  --shadow-panel: ...;
}
```

迁移顺序固定为：先给布局入口和 Admin 全局组件加主题作用域，再迁移按钮、输入、弹窗、表格等共享 Admin 组件，最后处理 Analytics、Debug、Notifications 等页面的局部样式。不得把 Admin 的暗色值直接写入主应用主题，也不得为了复用而修改现有 Admin 的信息密度和深色产品定位。

## 5. `/design` 页面方案

### 5.1 页面职责

`/design` 是运行时样式实验室，不是营销页面，也不是第二套设计系统。它必须直接消费真实令牌和共享组件。

页面支持：

- 查看令牌名称、实际值和用途
- 颜色、透明度、表面、模糊和阴影预览
- 字体大小、字重、行高和间距预览
- 圆角档位预览
- 复制 CSS 变量名和值
- 切换主应用 `light/dark/system`
- 预览 Admin 主题
- 查看组件 default、hover、active、disabled、loading、error 状态
- 查看项目卡、文件卡、画布卡、弹窗、侧栏、聊天气泡、抽屉和连接线

### 5.2 页面文件结构

```text
frontend/src/views/Design/
├── index.vue
├── components/
│   ├── TokenSection.vue
│   ├── TokenRow.vue
│   ├── ColorTokenPreview.vue
│   ├── SurfaceTokenPreview.vue
│   ├── TypographyTokenPreview.vue
│   ├── ComponentStatesPreview.vue
│   ├── BusinessComponentsPreview.vue
│   └── ThemeSwitcher.vue
├── composables/
│   └── useDesignTokens.ts
└── data/
    └── tokenCatalog.ts
```

### 5.3 文件和函数职责

#### `Design/index.vue`

只负责页面布局、分组顺序、主题状态编排和预览组件组合，不维护具体令牌值。

#### `useDesignTokens.ts`

负责读取运行时 CSS 变量、解析 catalog、返回当前值、复制变量和值，以及设置预览主题。

```ts
interface DesignToken {
  name: string
  variable: string
  category: 'primitive' | 'semantic' | 'component' | 'motion' | 'canvas'
  type: 'color' | 'size' | 'shadow' | 'font' | 'duration' | 'other'
  description: string
}

function useDesignTokens(): {
  tokens: ComputedRef<DesignToken[]>
  valueOf: (token: DesignToken) => string
  copyToken: (token: DesignToken) => Promise<void>
}
```

#### `tokenCatalog.ts`

只保存展示元数据，不重复保存实际值：

```ts
export const tokenCatalog: DesignToken[] = [
  {
    name: '主应用玻璃表面',
    variable: '--surface-glass',
    category: 'semantic',
    type: 'color',
    description: '主应用大面积玻璃面板使用的表面色',
  },
]
```

实际值通过运行时读取：

```ts
const value = getComputedStyle(document.documentElement)
  .getPropertyValue(token.variable)
  .trim()
```

#### 预览组件

- `TokenSection`：分类和折叠布局
- `TokenRow`：名称、值、说明和复制操作
- `ColorTokenPreview`：颜色和透明度
- `SurfaceTokenPreview`：背景、边框、blur 和 shadow
- `TypographyTokenPreview`：字号、字重、行高和示例
- `ComponentStatesPreview`：共享组件状态矩阵
- `BusinessComponentsPreview`：项目、文件、画布和聊天业务组件
- `ThemeSwitcher`：主应用和 Admin 主题切换

### 5.4 路由与访问范围

增加：

```text
/design
```

第一阶段仅在开发环境和管理员账号显示入口，但保留直接访问能力，方便调试。生产环境入口是否隐藏通过权限或环境配置控制，不在页面组件中散落环境判断。

## 6. 页面迁移路线

### P0：基础与共享组件

- `frontend/src/assets/styles/variables.css`
- `frontend/src/assets/styles/global.css`
- `frontend/src/layouts/DefaultLayout.vue`
- `frontend/src/layouts/AdminLayout.vue`
- `frontend/src/components/common/AppSidebar.vue`
- `frontend/src/components/common/GlassBg.vue`
- BaseModal、Popup、通用按钮、输入框、标签和状态徽标

目标是先稳定基础令牌入口、主题入口和公共组件。

### P1：低风险页面

- 登录、注册、找回密码、重置密码
- 日程
- 通知和空状态

验证颜色、表单、按钮、弹窗、字号和圆角档位。

### P2：核心业务页面

- 项目看板
- 日历
- 文件系统
- 文件预览和上传弹窗

重点迁移项目卡、文件卡、状态色、列表/网格、工具栏和浮动操作。

### P3：复杂交互页面

- GuguChat
- ProfileModal
- Mind 笔记
- Mind 画布
- 连接线、抽屉、摄像机和拖拽代理

以视觉回归为前提，不为了替换普通令牌改变已稳定的交互参数。

### P4：Admin

独立迁移 Admin 页面，统一配置行、表格、按钮、标签、弹窗、日志状态和错误状态，不强行改变其深色产品定位。

## 7. 实施 TODO

### Phase 0：基线与契约

- [x] 确认 `/design` 的访问范围：登录用户可直接访问，入口不污染业务导航
- [x] 确认主应用与 Admin 的主题边界
- [x] 确认基础色、字号、间距、圆角和阴影候选尺度
- [x] 将间距、圆角和字体大小各自控制在 4 档
- [x] 建立历史间距、字号和圆角值到标准档位的映射表
- [x] 记录动态业务色、画布物理参数和第三方组件变量的例外规则
- [x] 确认令牌命名规则和废弃变量规则
- [x] 盘点 AdminLayout、Admin 全局样式和各 Admin 页面中的暗色 literal、重复组件样式与局部滚动条
- [x] 确认 Admin 以默认暗色运行，不参与主应用 `light/dark/system` 切换
- [x] 确认 Admin 共享基础尺度、独立语义 surface/content/border/shadow 的边界

### Phase 1：令牌基础层

- [x] 建立 `tokens/` 目录和 `index.css`
- [x] 将 `variables.css` 改为兼容导入入口
- [x] 补齐 primitives、semantic、components、motion、canvas、admin、themes 文件
- [x] 为现有变量提供迁移映射，避免一次性破坏旧页面
- [x] 建立主应用 `light/dark/system` 主题映射
- [x] 建立入口 HTML 的首屏主题初始化
- [x] 增加层级、focus、disabled、error 和 reduced-motion 令牌
- [x] 增加滚动条尺寸、颜色、hover 和 corner 令牌
- [x] 建立 `scroll-surface`、`compact`、`editor`、`hidden` 容器样式

### Phase 2：`/design` 页面

- [x] 增加 `/design` 路由
- [x] 创建页面和预览组件
- [x] 创建只保存元数据和变量引用的 token catalog
- [x] 使用 `getComputedStyle` 显示真实运行时值
- [x] 支持复制变量名和值
- [x] 支持主应用 `light/dark/system` 切换
- [x] 支持 Admin 主题预览
- [x] 添加颜色、表面、字号、圆角、阴影和动效示例
- [x] 添加共享玻璃、状态控件和 Admin 语义预览
- [x] 增加 default/hover/active/disabled 状态

### Phase 3：共享组件迁移

- [x] 迁移全局玻璃面板
- [x] 迁移通用输入框与共享状态表面，复选框、按钮和弹窗继续复用既有全局契约
- [x] 迁移 AppSidebar 的通知列表与主页面共享滚动入口
- [x] 迁移 popup、modal、tooltip 的层级和阴影入口到语义层
- [x] 将看板列、阶段列表、通知、通知气泡和抽屉轨道的滚动条迁移到滚动容器语义类
- [x] 保留画布/笔记横向隐藏滚动条和编辑器滚动条作为明确特例
- [x] 共享组件本次新增样式不再增加裸色值

### Phase 4：业务页面迁移

- [ ] 迁移认证和日程页面
- [ ] 迁移项目和日历页面
- [ ] 迁移文件系统和文件预览
- [ ] 迁移 GuguChat 和 ProfileModal
- [ ] 迁移 Mind 笔记和画布视觉变量
- [ ] 为 AdminLayout 增加 `.admin-theme` 主题作用域
- [ ] 抽取 Admin 专属暗色语义 token，替换布局和全局组件中的重复 literal
- [ ] 迁移 Admin 暗色主题
- [ ] 验证主应用暗色下的玻璃层、卡片、弹窗、聊天和文件预览
- [ ] 验证 `system` 模式在系统主题变化时实时切换

### Phase 5：约束与收尾

- [ ] 统计剩余硬编码色值、字号、圆角、阴影和 blur
- [ ] 统计剩余局部滚动条规则和未分类的 `overflow` 容器
- [ ] 检查间距、圆角和字号主档位均为 4 个
- [ ] 建立允许例外清单
- [ ] 对新增样式增加 raw literal 检查
- [ ] 检查新增组件没有通过局部值绕过标准档位
- [ ] 更新 `docs/development/design.md`，移除与运行时令牌重复的具体数值
- [ ] 补充关键页面视觉回归检查
- [ ] 更新 `PRD-UI-1` 的实施状态和验收结果

## 8. 验收标准

### 令牌系统

- 页面通用颜色、表面、边框、文字、状态、圆角、阴影和动效都有语义变量。
- 普通滚动容器使用统一滚动条样式，并按 compact/default/editor 选择尺寸。
- 只有具有替代交互反馈的画布/笔记横向区域可以隐藏滚动条。
- 滚动条出现或消失不会导致主要内容发生布局跳动。
- 间距、圆角和字体大小主档位均为 4 个。
- 新增普通组件不需要直接写品牌色和通用透明度。
- 主应用支持 `light`、`dark`、`system`，且首屏不会出现明显主题闪烁。
- Admin 和主应用可以独立替换 surface/content/border 语义值。
- Admin 暗色主题不会被主应用主题切换误修改。
- 画布物理参数不会被普通令牌迁移意外改变。

### `/design` 页面

- 页面展示的值来自运行时 CSS 变量，而不是重复写死。
- 颜色、字号、圆角、阴影、模糊和组件状态都有可视化示例。
- 所有标准圆角和字号档位都有示例。
- 可以复制变量名和值。
- 可以切换主应用和 Admin 主题。
- 页面本身使用共享组件和令牌，不形成第三套样式。

### 页面迁移

- 主应用、Mind 和 Admin 的关键页面视觉没有明显回归。
- 弹窗、抽屉、拖拽代理、画布卡片和连接线的行为保持不变。
- 旧变量迁移完成后没有未解释的重复定义。
- 所有动态颜色和交互参数例外都有说明。

## 9. 风险与处理

| 风险 | 影响 | 处理方式 |
|---|---|---|
| 一次性全局替换裸值 | 视觉回归范围过大 | 按共享组件和页面族分阶段迁移 |
| 玻璃透明度差异被误合并 | 面板层级变平 | 为 dense、popup、drag 等变体建立语义令牌 |
| Admin 被强行套用浅色令牌 | 管理后台视觉失真 | Admin 使用独立主题语义值 |
| 用户侧 dark 与 Admin dark 混淆 | 修改一侧误伤另一侧 | 共享基础尺度，分离 surface/content/border/theme 映射 |
| 主题切换首屏闪烁 | 页面先亮后暗 | 入口 HTML 提前设置根节点主题属性 |
| 画布交互参数被普通迁移覆盖 | 拖拽、landing、camera 回归 | canvas 令牌与普通 motion 分离 |
| `/design` 维护第二套实际值 | 展示页和真实页面脱节 | catalog 只保存元数据，实际值运行时读取 |
| 动态业务颜色被错误令牌化 | 项目/文件类型失去数据表达 | 保留局部 CSS 变量作为受控例外 |
| 间距、圆角和字号档位重新膨胀 | 令牌系统失去收敛价值 | 在 CI/审查中检查四档约束，新增例外必须说明 |

## 10. 相关文档

- `docs/product/PRD/PRD-UI-1-设计令牌与主题体系.md`：产品范围、主题目标和阶段方向。
- `docs/development/design.md`：主应用视觉原则、交互规范和使用约束。
- `docs/development/design-admin.md`：Admin 视觉约束和暗色验收依据。
- 本文：工程目录、页面结构、函数职责、迁移顺序和验收标准。

## 11. 当前执行建议

先完成 Phase 0 和 Phase 1：冻结令牌契约、建立分层目录、落地主应用 `light/dark/system` 主题骨架和 Admin 隔离边界。随后优先完成 `/design`，用真实组件和两套主题验证命名是否足够，再开始迁移共享组件。

这样 `/design` 会成为后续所有视觉修改的基线，同时避免把已经稳定的画布和拖拽交互卷入一次没有观察窗口的大规模样式替换。
