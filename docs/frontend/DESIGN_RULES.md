# 前端设计规则

本文档是 Gugu 前端视觉实现的执行规范。设计稿、页面样式和公共组件发生冲突时，优先遵守 token 分层、组件 owner 和可访问性规则；不要通过增加一层临时 CSS 来掩盖冲突。

## 设计目标

- 让页面在 `Aero / Mono`、`Light / Dark` 和 `Mist / Cafe / Rose / Sky / Sage` 下保持同一信息层级。
- 让颜色、间距、圆角、阴影、字体和动效都能被命名、复用、检查和回归测试。
- 让公共组件拥有稳定的 DOM、状态和样式边界，页面只组合组件，不重写组件内部细节。
- 让设计页面成为可运行的 token/component catalog，而不是与真实产品脱节的静态样板。

## 样式入口与 Owner

全局样式只能从以下入口进入：

`text
frontend/src/assets/styles/global.css
└── variables.css
    ├── tokens/index.css
    │   ├── foundation/index.css
    │   ├── themes/index.css
    │   ├── palettes/index.css
    │   ├── semantic/index.css
    │   └── components/index.css
    ├── theme-refinements.css
    ├── design-overrides.css
    ├── components/index.css
    ├── design-theme-fixes.css
    ├── bridges/index.css
    └── adoption/index.css
`

具体职责以 `frontend/src/assets/styles/STYLE-OWNERS.md` 为准：

- `tokens/` 定义变量，不直接决定业务节点的具体 DOM 状态。
- `theme-refinements.css` 只做主题到语义角色的映射，不拥有业务组件 paint。
- `components/index.css` 及其子文件拥有组件的背景、边框、阴影、hover 和结构样式。
- `bridges/` 只处理 Teleport、浮层根节点和跨 DOM 边界，不承接组件几何。
- `adoption/`、旧 refinement 和 theme fix 是迁移兼容层；同一属性只能有一个最终 owner。
- Runtime 管理的 `transform`、`transition`、`opacity` 不得被业务主题层用 `!important` 或重复选择器接管。

修改样式前必须先查 owner。若一个状态在 scoped CSS、全局 CSS、组件样式和页面样式同时出现，应先删除重复 owner，再修改最终规则。

## Token 分层

Token 必须沿着“基础值 -> 主题/色板 -> 语义角色 -> 组件契约”单向引用。低层不能反向引用高层，业务组件不能直接依赖某个主题文件的原子颜色。

| 层级 | 目录/文件 | 负责什么 | 示例 |
|---|---|---|---|
| Foundation | `tokens/primitives.css`、`tokens/motion.css` | 不带产品语义的尺寸、字号、字体、圆角、阴影、层级和时长 | `--space-md`、`--font-size-sm`、`--radius-md` |
| Theme | `tokens/themes/*.css` | Aero/Mono 与亮暗模式的材质、实体表面和组合方式 | `glass-light.css`、`mono-dark.css` |
| Palette | `tokens/palettes/*.css` | Mist 等色板的色基和产品强调色 | `--project-sky`、palette color base |
| Semantic | `tokens/semantic.css`、`tokens/semantic/index.css` | 产品角色和信息层级，供页面及组件消费 | `--surface-page`、`--content-primary`、`--status-danger` |
| Component | `tokens/components.css`、`tokens/components/*.css` | 可复用组件契约和状态集合 | `--control-*`、`--card-*`、`--input-*`、`--project-card-*` |
| Canvas/product | `tokens/canvas.css`、`tokens/product.css` | 画布、便签、项目等领域的稳定视觉接口 | `--canvas-dot-color`、`--note-paper-*` |

### 命名规则

- 基础尺寸使用 `--space-*`、`--font-size-*`、`--radius-*`、`--font-family-*`、`--elevation-*`、`--motion-*`。
- 语义表面使用 `--surface-*`，文字使用 `--content-*`，边框使用 `--border-*`，动作使用 `--action-*`，状态使用 `--status-*`，焦点使用 `--focus-*` 或 `--border-focus`。
- 组件契约使用领域前缀，例如 `--control-*`、`--input-*`、`--choice-chip-*`、`--modal-card-*`、`--danger-button-*`、`--project-card-*`、`--gugu-*`。
- 状态必须成组命名：默认、hover、active/selected、focus-visible、disabled、danger 等不能只定义一个孤立颜色。
- 同一含义只保留一个公开 token。不要同时创造 `--text-main`、`--text-primary`、`--content-primary` 三个别名。
- token 名称表达角色，不表达某次页面实现。`--surface-raised` 比 `--projects-white-card` 更可复用。
- 颜色透明度原子值只放在 palette/foundation；组件优先消费语义透明表面，不在组件里散落 `rgba()`。

### 消费顺序

`css
/* 推荐：组件契约 -> 语义角色 -> 主题/色板 -> 基础值 */
.app-card {
  background: var(--card-surface-bg);
  border: 1px solid var(--card-border);
  box-shadow: var(--card-shadow);
}
`

- 页面背景、面板、浮层分别使用 `surface-page`、`surface-base/raised`、`surface-floating/glass` 等语义角色。
- 正文、辅助信息、时间和禁用态分别使用 `content-primary/secondary/tertiary/disabled`。
- 主操作使用 `action-primary-*`；次要操作使用 `action-secondary-*`；选择态使用 `selection-*`；错误/删除使用 `danger-*` 或 `status-danger-*`。
- hover 要改变卡片/控件本体的 token，不要在文字或图标上盖一层遮罩。背景、边框、阴影和文字状态应属于同一个组件契约。
- 同一个属性只声明一条主 transition；默认使用 `--motion-hover-micro`、`--motion-hover-control`、`--motion-hover-card` 和标准 easing。
- `transform`、`opacity`、`visibility` 涉及 Runtime 或 landing 时，先确认视觉所有权，不能用普通 hover CSS 竞争。

### 新增或修改 Token 的流程

1. 先确认现有 token 是否已经表达同一语义；能复用就不新增。
2. 选择最低且正确的层级：尺寸/字体进 foundation，主题材质进 theme，色基进 palette，产品角色进 semantic，组件状态进 component。
3. 为所有主题组合检查值：Aero/Mono、Light/Dark、当前所有 palette；不能只在当前截图可见的主题中补值。
4. 建立完整状态组，并在组件 owner 中消费；删除旧别名和重复 CSS，不能通过选择器优先级压住旧规则。
5. 在 `frontend/src/views/Design/data/tokenCatalog.ts` 登记名称、变量、类别、类型和用途。目录只保存元数据，不复制 CSS 实际值。
6. 在 `/design` 增加真实样板或索引入口，展示默认态与关键交互态，并确认页面使用的是实际 token。
7. 更新受影响的组件测试、CSS 回归测试和必要的浏览器验证；运行 `npm run typecheck`、相关测试和构建检查。

## `/design` 设计系统页面

路由是受认证保护的 `/design`，入口为 `frontend/src/views/Design/index.vue`，主体为 `DesignSystemPage.vue`。它的定位是运行时查看器和可交互样板：

- 可以切换 `Aero / Mono`、`Light / Dark / System` 和五种 palette，检查同一 token 在不同主题组合下的结果。
- 可以查看基础 token：颜色、字号、字体族、间距、圆角、滚动条和动效时长。
- 可以查看语义 token：Surface、Content、Border、Action、Status 及其真实使用示例。
- 可以查看组件契约：侧栏、顶栏、项目卡、GuguChat、危险操作、ConfirmDialog、输入框、次要按钮、选择胶囊、便签和层级阴影。
- 可以查看真实产品样板、hover/active 状态、弹窗预览、滚动容器和画布/便签配色，而不是只看色块。
- `useDesignTokens()` 已提供读取当前 `getComputedStyle(document.documentElement)` 实际值和复制“变量名: 计算值”的基础能力；当前 `DesignSystemPage` 主要通过真实 `var(...)` 样板展示，复制操作尚未接入页面交互。

当前页面**不能直接新增或持久化 CSS token**。页面上的样板数据和 `tokenCatalog.ts` 是展示登记，不是运行时配置中心；不能把新增 token 写入 localStorage、用户偏好或后端来假装完成设计系统变更。

新增 token 的正确路径是：修改对应 token CSS -> 更新 `tokenCatalog.ts` -> 在 `DesignSystemPage.vue` 增加展示/使用样板 -> 补测试。未来如果要做“添加 token”交互，也必须生成受审查的代码变更或设计提案，不能让生产页面直接修改全局 CSS。

## 公共组件使用规则

公共组件完整目录和抽取条件见 `frontend/src/components/common/README.md`。选型规则如下：

| 类别 | 组件 | 使用场景 |
|---|---|---|
| 认证 | `AuthBrand`、`AuthLanguageSwitcher`、`AuthPageFooter` | 登录、注册页品牌、语言和页脚 |
| 控件 | `ActionButton`、`Checkbox`、`ToggleSwitch`、`SegmentedControl`、`SearchInput` | 命令、二值选项、开关、互斥选择和搜索 |
| 日期/筛选 | `DatePicker`、`DateSpanPicker`、`TimeInput`、`SortMenu`、`RefreshButton` | 日历、时间、排序和刷新 |
| 布局 | `Brand`、`AppSidebar`、`NavItem`、`GlobalSearch`、`GlassBg`、`FloatPreviewWindow` | 产品框架、导航、全局搜索和浮层背景 |
| 弹层 | `BaseModal`、`ConfirmDialog`、`CloseButton`、`PopupMenu`、`ContextMenu`、`UploadConflictDialog` | 弹窗、危险确认、菜单和上传冲突 |
| 反馈 | `AppToast`、`FeedbackModal`、`NotificationBubble`、`SupportModal`、`KoFiIcon` | 成功/失败反馈、通知、反馈和支持入口 |
| 内容 | `MarkdownView`、`ReferenceSuggestMenu` | 安全 Markdown 渲染和引用建议 |
| 文件/查看器 | `FileBrowserPanel`、文件卡/文件夹卡、`ImageViewer`、`PdfViewer`、`TextViewer`、`VideoViewer` | 文件库、预览和媒体查看 |
| 聊天 | `GuguChat` 及 composer、message list、sidebar、tool bubble、mini player | 咕咕窗口、消息、工具结果和输入 |
| 个人设置 | `AvatarCropper`、`MessageFormatSettings`、Profile panes | 个人信息、偏好、格式和工作区设置 |
| Mind | `CardAffordances` | Mind 卡片公共 affordance；拖拽和 landing 所有权由 Runtime 约束 |
| 图标 | `Icon`、`iconRegistry`、`iconTypes` | 统一图标注册和类型安全 |

页面专属的事件表单、Admin 控件和单页业务卡片留在对应 `views/<Page>/components/`，不要为了少写几行就塞进 common。

### 控件状态契约

- `ActionButton` 用于明确命令；图标按钮必须有 `title` 或 aria-label。能用熟悉图标表达的撤销、关闭、保存、缩放等动作不再做成长文字按钮。
- `Checkbox` 表示可多选或带说明的二值选项；`ToggleSwitch` 表示即时开关。两者不能只因外观相似而互换。
- `SegmentedControl` 表示互斥模式；语言、主题、排序模式等不要手写三套按钮状态。
- 所有控件都要有默认、hover、focus-visible、active/checked、disabled 和失败/校验态；状态不能只靠颜色表达。
- 删除、重置、覆盖、停用和注销必须使用 `useConfirmDialog`/`ConfirmDialog`，禁止原生 `alert`、`confirm`、`prompt`。
- 不可信 Markdown/HTML 只能经过统一消毒流程；公共组件不直接渲染未经处理的 `v-html`。
- 组件卸载时清理事件监听、定时器、Observer、Portal 和异步任务。

## 主题、布局与动效

- 页面不写主题分支来改颜色；统一通过 token 解决亮暗色和 palette 差异。
- 卡片、按钮、输入框和弹层保持稳定尺寸，文字在中英文、日文和窄屏下不得溢出或遮挡。
- 页面章节使用无框架布局；卡片只用于重复条目、弹窗和真正需要边界的工具，不要卡片套卡片。
- 玻璃效果只用于有明确层级的面板/浮层；背景、边框和内容对比度必须在暗色模式下可读。
- hover/focus/pressed 必须淡入淡出且只有一个 owner。不要叠加 overlay、伪元素和组件状态来模拟同一个效果。
- 画布节点、拖拽代理和 landing 节点必须遵守 Runtime 的 transform/opacity/visibility 所有权；业务 CSS 不得根据 phase 猜测 hover。
- 使用 `prefers-reduced-motion` 时降低或关闭非必要动画，但不能破坏状态变化和拖拽反馈。

## 验证清单

- 亮色/暗色、Aero/Mono 和至少两种 palette 下检查背景、文字、边框和 hover 对比度。
- 键盘 Tab、Enter/Space、Escape 和 focus-visible 检查公共控件及弹层。
- 检查中英文、日文、长标题、空状态、错误状态和窄屏布局。
- 检查 hover 的背景、边框、阴影、文字和图标是否同步过渡，确认没有重复 CSS 或瞬间闪现。
- 修改 token 后运行 frontend 的 typecheck、相关 Vitest/CSS 测试和构建；涉及真实交互时补浏览器手测。
