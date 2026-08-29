# PRD-UI-5 CSS 样式职责收口与主题层统一

> 状态：🟡 部分完成，现有 token 体系已建立，主题桥接与旧组件样式仍待收口
> 创建：2026-08-30
> 最近更新：2026-08-30
> 关联模块：`frontend/src/assets/styles/`、`frontend/src/components/`、`frontend/src/views/`
> 背景参考：`docs/prds/【已完成】PRD-UI-1-设计令牌与主题体系.md`、`agentskills/design/SKILL.md`

## 0. 实际状态

| 能力/结果 | 状态 | 说明 |
| --- | --- | --- |
| 基础、主题、语义、组件 token 分层 | ✅ 已完成 | `tokens/` 已按 foundation、themes、semantic、components 分层 |
| 主题与组件的兼容覆盖 | 🟡 部分完成 | `theme-adoption.css`、`component-theme-refinements.css` 等存在职责交叉 |
| Teleport/跨组件样式桥接 | 🟡 部分完成 | 日历、弹层、文件工具栏、文件拖拽各有独立 bridge/refinement 文件 |
| 全局样式职责边界 | 🟡 部分完成 | `global.css` 仍包含多类业务组件样式 |
| 页面 scoped 样式收口 | 🟡 部分完成 | 部分大页面和非 scoped `<style>` 仍需要按组件职责拆分 |
| 主题回归验证 | ✅ 已完成 | 已有主题结构测试；后续整理必须保持亮/暗色与 Aero/Mono 覆盖验证 |

## 1. 背景与目标

当前前端已经具备完整的 token 基础，但样式来源同时分布在全局样式、主题修正层、组件 token 层、跨页面 bridge 和 Vue 文件内的 scoped/non-scoped 样式中。同一组件可能由多个文件共同决定背景、边框、高光和 hover，导致 Mono/Aero 切换时出现纯白高光、边框覆盖顺序不稳定等回归。

本 PRD 的目标是建立清晰且可追踪的 CSS 职责边界：

- 原始色值只由主题和调色板 token 提供。
- 组件的最终 paint contract 由组件 token 或组件自身样式负责。
- 全局样式只保留 reset、基础排版、真正跨组件的 utility 和必要的全局表面规则。
- 主题兼容规则集中管理，避免多个 refinement 文件互相覆盖。
- Teleport 样式保留跨 DOM 树的必要边界，但按 bridge 职责归档。
- 通过静态回归测试和浏览器验证锁定样式所有权与层叠顺序。

不在范围内：

- 不改变现有产品视觉设计、色板数值或交互行为。
- 不一次性替换所有业务数据驱动颜色，例如项目颜色、文件类型颜色和状态颜色。
- 不修改 Interaction Runtime 的拖拽、物理和生命周期控制。
- 不为了形式上的拆文件引入重复 token、额外全局状态或新的构建依赖。

## 2. 功能需求

### FR-UI5-001：建立单一主题组件覆盖层

主题对既有组件的兼容覆盖应有唯一事实来源。覆盖层可以按主题组件域拆分文件，但必须由一个明确的入口统一加载，并定义稳定的加载顺序。

### FR-UI5-002：收口全局样式职责

`global.css` 只保留 reset、基础页面结构、通用 utility 和确实被多个功能域共享的样式。日历、文件、项目、聊天等业务视觉规则应迁移到对应组件或 adoption 域。

### FR-UI5-003：统一跨 DOM 树样式桥接

Teleport、浮层和弹窗需要脱离组件 scoped 作用域时，应放入明确的 bridge 目录，并按功能域命名。bridge 只负责选择器作用域和 token 映射，不重复定义组件几何或业务状态。

### FR-UI5-004：明确 scoped 与 non-scoped 样式边界

默认使用 `<style scoped>`。普通 `<style>` 仅用于 Teleport、全局 class 或跨组件复用，并在文件中注明原因；同名 class 不得因普通 `<style>` 意外污染其他页面。

### FR-UI5-005：减少覆盖优先级竞争

新代码不得通过无必要的 `!important` 解决层叠问题。已有 `!important` 应按组件域逐步移除；Runtime 管理的 `transform`、`transition`、`opacity` 不得由主题层强制覆盖。

### FR-UI5-006：保留主题视觉契约

整理后必须保持 `light/dark` 与 `Aero/Mono/其他调色板` 的背景、边框、高光、hover 和 focus 行为。特别是 Mono 亮色不得被 Aero 的白色高光规则覆盖，暗色模式的现有行为不得被整理过程改变。

## 3. 技术方案

### 3.1 样式层级

保持现有 token 基础层级：

`foundation → themes/palettes → semantic → component contracts → component/adoption paint`

其中：

- `tokens/themes` 和 `tokens/palettes` 只提供原始主题值。
- `tokens/semantic` 将主题值映射为页面可消费的语义角色。
- `tokens/components` 定义组件背景、边框、阴影、高光和交互状态契约。
- 组件样式负责结构和局部状态。
- adoption/bridge 只处理旧组件兼容、Teleport 边界和无法立即迁移的历史样式。

### 3.2 入口与加载顺序

将现有主题修正和 bridge 入口整理为可枚举的单一入口。加载顺序必须满足：token 先于组件样式，组件样式先于兼容覆盖，Runtime 约束不能被主题覆盖。删除或迁移规则时同步更新主题回归测试，避免只依赖 CSS 文件顺序的隐式行为。

### 3.3 迁移策略

采用按组件域的渐进迁移：先处理日历、GuguChat、文件工具栏和项目弹窗等已有主题回归的高风险域，再处理全局卡片、按钮、Admin 和 Mind。每次只迁移一个职责域，迁移前后比较编译后的选择器、计算样式和浏览器截图。

### 3.4 安全与隐私边界

本 PRD 仅涉及前端静态样式，不新增日志、网络请求、用户数据或权限边界。不得把用户输入、凭据、token 或诊断内容写入 CSS、测试快照或提交记录。

## 4. 验证与上线

每个迁移批次至少执行：

- `cd frontend && npm run typecheck`
- `cd frontend && npm run test:run`
- `cd frontend && npm run build`
- `git diff --check`
- 浏览器验证 Aero/Mono 的亮色和暗色，以及日历工具栏、GuguChat、浮层、按钮和输入框的计算样式。

验收重点：不存在同一最终 paint 属性由两个无明确优先级的主题层同时负责；Mono 亮色不出现 Aero 纯白高光；Teleport 面板仍能正确显示；Runtime 拖拽和动画状态不被覆盖。

发布采用按域合并。若出现视觉回归，优先回滚对应域的迁移提交，不回滚 token 基础层；回滚后保留失败场景和计算样式作为回归测试输入。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 删除旧 bridge 后 scoped 样式无法覆盖 Teleport 内容 | 浮层样式丢失或回退 | 迁移前列出 Teleport 根节点，逐页做浏览器验证 |
| 合并 refinement 后选择器优先级变化 | Aero/Mono 或暗色回归 | 用 CSS 结构测试锁定关键 selector，并检查计算样式 |
| 大量移除 `!important` 造成历史样式复现 | 局部按钮、卡片 hover 变化 | 按功能域小批次迁移，保留截图和回归测试 |
| 全局规则迁移后页面缺少样式入口 | 特定路由首次加载样式不完整 | 保持统一入口加载，并执行完整构建和路由冒烟 |

待确认事项：

- 是否在完成高风险组件域后，再统一处理 Admin 大页面中的局部硬编码颜色。
- 是否引入 CSS `@layer` 作为后续优先级治理工具；当前阶段先依靠明确入口和选择器职责，避免增加迁移复杂度。

## 6. 唯一实施 TODO

### Phase 1：入口与高风险主题域

- [ ] `UI5-001` 盘点并标注现有 refinement、bridge、adoption 文件的唯一职责；验收：形成入口加载图，标出重复 selector 和保留原因。
- [ ] `UI5-002` 统一主题组件覆盖入口，并收口日历工具栏、GuguChat 的高光/边框规则；验收：Aero/Mono 亮色与暗色计算样式符合 FR-UI5-006。

### Phase 2：全局与跨 DOM 树样式

- [ ] `UI5-003` 将 `global.css` 中的业务组件规则按域迁移；验收：全局文件只保留约定职责，相关页面视觉回归通过。
- [ ] `UI5-004` 整理 Teleport bridge 并为保留的 non-scoped 样式补充边界说明；验收：日历、弹窗、文件工具栏和预览器浮层在所有主题下正常显示。

### Phase 3：组件样式与优先级治理

- [ ] `UI5-005` 按功能域减少硬编码颜色和无必要的 `!important`；验收：Runtime 管理属性无主题强制覆盖，主题规则通过静态检查。
- [ ] `UI5-006` 补齐 CSS ownership/主题回归测试并完成全量验证；验收：`typecheck`、`test:run`、`build` 和浏览器验收均通过。
