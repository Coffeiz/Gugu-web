# PRD-UI-3：咕咕配色选项与 Aero/Mono 主题解耦

> 状态：Phase 0-1 已完成，Phase 2 部分完成，Phase 3 待实施
> 创建：2026-08-27
> 最近更新：2026-08-27
> 关联模块：`frontend/src/composables/useTheme.ts`、`frontend/src/components/common/ProfileModal/ProfilePreferencesPane.vue`、`frontend/src/assets/styles/tokens/themes/`、`frontend/src/assets/styles/tokens/semantic.css`
> 前置文档：`【已完成】PRD-UI-1-设计令牌与主题体系`

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 0：边界与 token 盘点 | ✅ 已完成 | 已确认三维模型、变量归属、硬编码迁移范围和验证矩阵 |
| Phase 1：配色状态与设置入口 | ✅ 已完成 | 新增配色持久化、根节点属性、个人设置入口和 Design 验收入口 |
| Phase 2：配色 token 化 | 🟡 部分完成 | 已建立语义配色层；完整页面色板仍需迁移 |
| Phase 3：组件迁移与视觉回归 | 🔲 待评估 | 清理硬编码颜色，覆盖聊天、文件、日历、Mind、Admin 等页面 |

### 0.1 Phase 0 结论

已完成对现有主题入口、token 文件、设置页、Runtime 和主要组件样式的盘点，结论如下：

| 范围 | 当前结论 | 后续处理 |
|---|---|---|
| 明暗模式 | `useTheme` 已支持 `light`、`dark`、`system`，持久化键为 `gugu-theme` | 保持现有行为，补充配色维度 |
| 视觉体系 | `family` 使用 `glass`/`v2`，对外文案为 Aero/Mono，持久化键为 `gugu-theme-family` | 保留兼容值，仅收敛到材质、模糊、圆角、阴影和密度职责 |
| 语义 token | `semantic.css` 已把页面、表面、内容、操作、状态和品牌变量统一映射到 `--theme-*` | 将 `--theme-*` 的颜色来源迁移到独立 palette 层 |
| 主题颜色 | `glass-light/dark.css`、`mono-light/dark.css` 同时维护完整颜色集合 | 拆为 palette × light/dark；family 不再复制颜色表 |
| 组件覆盖 | `product.css`、`component-theme-refinements.css`、各类 bridge 已大量使用语义 token，但仍存在高特异性和 `!important` | 迁移时按覆盖顺序清理，禁止继续堆叠特异性 |
| 硬编码颜色 | 公共侧栏、GuguChat、Admin 和部分 scoped CSS 仍有大量颜色字面量 | 区分主题颜色与业务颜色后分批迁移 |
| 业务颜色 | `projectColors.ts`、项目封面、日历项目色等属于内容/业务数据 | 保持原有颜色，不纳入全局 palette |
| Runtime | 当前只根据 `data-theme` 切换暗色拖拽视觉；配色若只改变 CSS token，不需要改动画逻辑 | 只有 Runtime 直接读取颜色时才增加 `data-palette` 同步 |

Phase 0 的架构结论：主题应采用 `theme × family × palette` 三维组合；其中 `theme` 负责明暗，`family` 负责材质/几何，`palette` 负责颜色。现有实现尚未达到该边界，因此 Phase 1 不能简单复制一套 Aero 或 Mono 主题文件。

## 1. 背景与目标

当前主题系统已经具备语义 token 层，但 `glass`（Aero）和 `v2`（Mono）仍分别维护完整的亮色/暗色颜色集合。两套文件同时包含背景、文字、边框、按钮、品牌渐变、状态色和阴影，导致：

- 用户只能在 Aero 和 Mono 两套完整视觉体系之间切换，不能独立选择咕咕的主色调。
- 新增一种配色需要复制并修改多套主题文件。
- 组件中的历史硬编码颜色会绕过全局主题，无法保证一键换色。
- 视觉体系和配色的职责混在一起，后续维护容易出现 Aero/Mono 分叉。

本 PRD 的目标是建立三个相互独立的主题维度：

```text
明暗模式：light / dark / system
视觉体系：Aero / Mono
配色方案：Lavender / Ocean / Rose / Mono 等
```

用户在设置中修改配色后，页面背景、表面、文字、边框、按钮、选中态、焦点态、品牌渐变、状态色和滚动条应整体切换为同一套色系，并在刷新后保持。

本 PRD 不改变页面布局、交互流程、动画归属、项目自定义颜色和用户内容中的颜色；Aero/Mono 仍可以保留不同的玻璃、模糊、圆角、阴影和密度表现，但不能继续拥有独立的配色色板。

## 2. 功能需求

### FR-THEME-1：独立配色选项（🔲 待实施）

在个人偏好设置的“外观”区域新增“配色”选项。配色选项与 Aero/Mono、亮色/暗色独立，可任意组合。

首批至少提供：

| 配色 | 定位 |
|---|---|
| Lavender | 当前咕咕紫灰色调，作为默认兼容配色 |
| Ocean | 蓝青色调 |
| Rose | 玫瑰暖色调 |
| Mono | 低彩度中性色调 |

具体色值在视觉验收阶段确定，不能只通过改变一个主色变量生成对比度不足的配色。

### FR-THEME-2：三维主题状态（🔲 待实施）

主题状态必须分别表示：

- `theme`：用户偏好 `light`、`dark`、`system`；
- `family`：兼容现有值 `glass`、`v2`，对外文案为 Aero、Mono；
- `palette`：配色方案的稳定标识。

根节点建议使用：

```html
<html data-theme="dark" data-family="glass" data-palette="lavender">
```

浏览器本地存储建议使用：

```text
gugu-theme
gugu-theme-family
gugu-palette
```

旧用户没有 `gugu-palette` 时使用 Lavender，不改变已有的明暗模式和视觉体系选择。

### FR-THEME-3：一键即时切换（🔲 待实施）

切换配色时只更新主题状态和 CSS token，不刷新页面、不重建路由、不重置弹窗、聊天窗口、画布或当前表单状态。

切换后必须同步影响：

- 页面和侧栏背景；
- 主要按钮、悬停、按下、选中和焦点状态；
- 文本、边框、卡片和弹出层；
- GuguChat 发送按钮、消息气泡和输入区域；
- 文件、日历、Mind 画布及其工具栏；
- 公共页和 Admin 中仍纳入统一主题范围的组件。

项目封面、项目标签、日历项目色等业务数据颜色不被全局配色覆盖。

### FR-THEME-4：视觉体系与配色解耦（🔲 待实施）

Aero/Mono 主题文件只拥有视觉体系相关变量和规则：

- 玻璃透明度、模糊和材质；
- 圆角、阴影、边框表现；
- 卡片、侧栏和浮层的密度与几何差异。

配色文件拥有完整的界面颜色体系：

- 页面背景和表面颜色；
- 内容层级颜色；
- 边框、高光和遮罩颜色；
- 主操作、选中、焦点颜色；
- 成功、警告、危险、信息色；
- 品牌渐变和滚动条色。

不得继续为 Aero 和 Mono 各复制一套完整颜色表。特殊组件如聊天窗口可以拥有组件 token，但组件 token 必须引用配色语义变量。

### FR-THEME-5：设置入口与可访问性（🔲 待实施）

- 在现有外观设置中增加配色选择，不新增孤立的主题管理入口。
- 每个配色选项提供名称、色板预览和当前选中状态。
- 选择控件支持键盘操作、焦点态和 `aria-pressed`/等价语义。
- 配色必须满足正文、按钮文字、禁用态和焦点环的可读性要求。
- 设计系统页面的主题切换器同步支持配色，用于验收 token 组合。

## 3. 技术方案

### 3.1 状态管理

扩展 [useTheme.ts](/Users/coffeiz/Desktop/workspace/Gugu-web/frontend/src/composables/useTheme.ts)：

```ts
export type ThemePalette = 'lavender' | 'ocean' | 'rose' | 'mono'
```

新增 `palette`、`setPalette` 和初始化/强制主题时的配色处理。写入 localStorage 前只接受白名单值，未知值回退到 Lavender；不得把用户输入直接拼接到 CSS 选择器或样式值中。

配色的正式用户入口是**个人设置 → 偏好设置 → 外观**。用户可以在这里独立修改配色，不需要进入 Design 页面；Design 页面中的切换器只用于设计验收和开发调试，并复用同一套 `useTheme` 状态，不维护第二套设置逻辑。

### 3.1.1 文件目标目录与职责

本 PRD 涉及的新增和调整文件固定放在以下目录：

```text
frontend/src/composables/useTheme.ts
  # theme / family / palette 状态、持久化、根节点 data 属性

frontend/src/components/common/ProfileModal/ProfilePreferencesPane.vue
  # 用户个人设置中的外观配置入口；配色名称、色板预览、选中态和键盘交互

frontend/src/views/Design/components/DesignSystemPage.vue
frontend/src/views/Design/components/ThemeSwitcher.vue
  # Design 页面验收入口，调用 useTheme，不单独保存配色状态

frontend/src/assets/styles/tokens/palettes/
  # 配色文件，按 palette × light/dark 拆分
  # 例如 lavender-light.css、lavender-dark.css、ocean-light.css

frontend/src/assets/styles/tokens/themes/
  # Aero/Mono 材质与几何文件；迁移后不再拥有完整语义颜色表

frontend/src/assets/styles/tokens/themes/index.css
  # 主题层统一导入入口，仅负责 family 相关 token

frontend/src/assets/styles/tokens/palettes/index.css
  # 配色层统一导入入口，负责 palette × resolved theme 的选择

frontend/src/assets/styles/tokens/semantic.css
frontend/src/assets/styles/tokens/semantic/index.css
  # 稳定语义 token 消费层，不直接绑定具体 palette 文件

frontend/src/assets/styles/tokens/components/
  # 按钮、表面、输入、Mind 等组件契约；只引用 semantic token

frontend/src/assets/styles/theme-regression.test.ts
frontend/src/assets/styles/tokens/*.test.ts
  # 配色白名单、token 合同和组合回归测试
```

目录约束：

- 不在 `useTheme.ts` 中写具体颜色值。
- 不在个人设置组件中直接修改 CSS 变量；设置组件只调用 `setPalette`。
- 不为每个 palette 新建一套页面或组件样式。
- 不在 `themes/` 目录继续新增完整的 `*-light.css` / `*-dark.css` 配色副本。
- 旧主题文件在迁移期间可以作为临时兼容来源，但最终颜色所有权必须移动到 `tokens/palettes/`。

### 3.2 CSS token 分层

保留现有 token 总入口，将职责调整为：

```text
tokens/foundation/       # 原始尺寸、字体、动效、基础色
tokens/palettes/          # palette × light/dark 的语义原始值
tokens/themes/            # Aero/Mono 的材质和几何差异
tokens/semantic.css       # 稳定的产品语义变量
tokens/components/        # 组件契约
```

兼容期可以保留 `--theme-*` 变量名，但其来源应由 `data-palette` 决定；`data-family` 不再覆盖同一批品牌/语义色变量。

### 3.3 组件迁移

按以下顺序迁移：

1. 公共按钮、表单、侧栏、顶部栏和弹窗；
2. GuguChat，包括发送按钮、消息气泡、文件消息、语音消息；
3. 文件、日历、Mind 画布及工具栏；
4. 登录/公共页和 Admin 页面；
5. 清理旧的 bridge/refinement 覆盖规则和重复硬编码颜色。

组件中代表业务内容的颜色（如项目色、事件色、用户头像图像）保留组件/数据所有权，不迁入全局配色。

### 3.4 运行时兼容

当前交互 Runtime 只根据 `data-theme` 控制暗色拖拽视觉。配色变更若只影响 CSS token，不需要改变拖拽算法；如果 Runtime 存在直接读取颜色值的路径，再单独监听 `data-palette`。不能为了换色修改拖拽、画布物理运动或动画时序。

### 3.5 依赖、数据和日志

- 不新增第三方依赖、后端接口或数据库字段。
- 配色偏好仅保存在浏览器 localStorage；后续若需要跨设备同步，再另立需求。
- 不记录用户选择以外的用户内容、聊天正文或附件名。
- 配色切换错误应使用现有前端错误处理，不在可见日志中输出用户数据。

## 4. 验证与上线

### 实施 TODO

#### Phase 1：配色状态与设置入口

- [x] 在 `useTheme` 中新增 `ThemePalette` 类型、默认值读取和白名单校验。
- [x] 新增 `palette`、`setPalette`，写入 `gugu-palette`，并设置 `data-palette`。
- [x] 保证旧用户没有 `gugu-palette` 时继续使用 Lavender，不影响已有 `theme/family`。
- [x] 在个人设置 `ProfilePreferencesPane.vue` 的“外观”区域增加配色选择、色板预览和选中态；这是用户正式配置入口。
- [x] 在设计系统 `ThemeSwitcher.vue` 增加配色切换，用于组合验收，并确保它与个人设置共享同一状态。
- [x] 明确个人设置修改后即时更新当前页面，不刷新路由、不重置聊天、画布、弹窗或表单状态。
- [x] 为状态初始化、非法值、刷新恢复和 system 模式补充单元测试。
- [ ] 风险等级：中；回滚方式：隐藏配色入口并忽略 `gugu-palette`，保留旧 `theme/family` 行为。

#### Phase 2：配色 token 化

- [x] 建立 `tokens/palettes/`，定义首批 palette × light/dark 的颜色 token。
- [x] 将主操作、选中、焦点、状态、品牌渐变、Logo、分隔线和滚动条颜色迁入 palette 层。
- [ ] 将页面背景、表面、文字、边框、高光和遮罩迁入 palette 层，形成每套 palette 独立完整的 light/dark 色板。
- [x] 保留必要的 `--theme-*` 兼容别名，避免一次性改动全部组件。
- [ ] 从 `glass-*.css`、`mono-*.css` 移除剩余颜色所有权，仅保留材质、透明度、模糊、圆角、阴影、密度和几何差异。
- [x] 明确 `--gugu-chat-*`、`--file-card-*` 等组件 token 只引用语义变量或业务颜色。
- [x] 增加 CSS token 合同测试：每个 palette 提供必需变量，family 不覆盖 palette 变量。
- [x] 固定职责边界：palette 管完整界面色系，family 管材质和几何表现；新增 palette 不复制 family 文件。
- [ ] 只有完整色板和 family 无颜色覆盖通过合同测试后，才将 Phase 2 标记为完成。

#### Phase 3：组件迁移与视觉回归

- [ ] 迁移公共按钮、表单、侧栏、顶部栏和弹窗中的主题硬编码颜色。
- [ ] 迁移 GuguChat 的发送按钮、消息气泡、文件消息和语音消息颜色。
- [ ] 迁移文件、日历、Mind 画布及工具栏颜色。
- [ ] 评估并迁移登录页、公共页和 Admin；保留明确的第三方或独立后台视觉边界。
- [ ] 清理重复的 bridge/refinement 覆盖规则，优先降低 `!important` 和高特异性依赖。
- [ ] 保留项目色、事件色、项目封面和头像等业务数据颜色，不纳入 palette。
- [ ] 验证 Aero/Mono × light/dark × 首批 palette 组合，至少覆盖主站核心页面。
- [ ] 验证切换不刷新页面、不重建路由、不重置聊天、画布、弹窗和表单状态。
- [ ] 风险等级：中高；回滚方式：保留旧主题文件和兼容别名，按根节点属性切回旧组合。

### 验证项

- `useTheme` 单元测试：默认值、非法值、持久化、system 模式、独立组合和刷新恢复。
- CSS token 回归测试：每种配色都提供必需语义变量，Aero/Mono 不重新定义配色所有权变量。
- 浏览器端测试：切换不刷新页面，当前路由、输入内容、聊天状态和画布状态保持不变。
- 视觉回归：登录页、主布局、文件、日历、Mind、聊天、设置页和 Admin 至少检查亮/暗两种模式。
- 人工检查：正文对比度、按钮文字、焦点环、禁用态、悬停态、滚动条和弹层遮罩。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 现有组件仍有大量硬编码颜色 | 换色后出现局部不变或亮暗冲突 | 按页面分批迁移，并用静态扫描和视觉回归追踪剩余项 |
| `component-theme-refinements.css` 等文件存在高特异性和 `!important` | 新配色无法覆盖旧规则 | 先梳理覆盖顺序，再减少重复 bridge，不用继续堆叠特异性 |
| Aero/Mono 颜色与材质规则混在一起 | 解耦后可能改变现有视觉效果 | Phase 0 建立变量归属表，迁移时逐组合截图对比 |
| Admin 页面有独立深色硬编码样式 | 全局配色可能无法完整覆盖 Admin | 首批明确 Admin 是否纳入范围，纳入后按独立页面契约迁移 |
| `system` 模式与配色组合增加测试矩阵 | 回归成本上升 | 通过 token 合同测试覆盖组合，浏览器视觉测试选择代表性组合 |
| 配色会影响白色文字和状态色的对比度 | 可读性和无障碍风险 | 每套配色固定检查正文、按钮、焦点和状态色对比度 |

待确认：

- 🔲 首批配色是否采用 Lavender、Ocean、Rose、Mono 四套，还是先只上线 Lavender 与 Ocean。
- 🔲 配色是否只对主站生效，还是 Admin 也纳入统一切换。
- 🔲 配色偏好是否需要后续同步到用户账户；当前方案暂不增加后端字段。
- 🔲 Aero/Mono 是否继续作为用户可见选项，还是在完成解耦后将其改名为更明确的“材质/布局风格”。
