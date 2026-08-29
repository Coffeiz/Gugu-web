# 统一弹层与模态交互架构 PRD

> 状态：Phase 0–6 已完成
> 创建：2026-08-29
> 所属层：Frontend / UI
> 关联目录：`frontend/src/components/common/`
> 核心组件：`PopupMenu.vue`、`BaseModal.vue`

---

## 1. 背景

项目中曾存在多套弹层实现：Provider 与模型列表、右键菜单、排序菜单、日历更多项、项目 Todo、日期选择器和活动编辑浮动窗分别处理 Teleport、定位、z-index、点击外部关闭与动画。

重复实现造成以下问题：

- 关闭动画时序不一致；
- 弹层与动态置顶面板发生层级竞争；
- 同类弹层毛玻璃和边框样式不一致；
- 业务组件重复维护窗口监听与边缘定位；
- Vue 事件透传到 Teleport 多根组件时产生 warning。

## 2. 目标

1. 统一所有轻量锚定式弹层的基础行为。
2. 统一所有完整模态框的遮罩、层级、焦点和生命周期。
3. 业务组件只维护内容和业务事件，不重复实现弹层基础设施。
4. 所有打开/关闭动画使用设计 token 和统一时序。
5. 弹层在动态窗口置顶、面板动画和 Teleport 场景下始终保持正确层级。
6. 迁移完成后删除重复定位、z-index、outside-click 和动画实现。

## 3. 组件边界

### 3.1 PopupMenu

用于锚定到按钮、输入框、日期格或列表项的轻量弹层：

- Provider 选择；
- 模型列表；
- 排序菜单、右键菜单；
- 日历更多活动与日历右键菜单；
- 项目阶段 Todo；
- 日期选择器；
- 活动添加/编辑的浮动表单模式。

PopupMenu 统一负责：

- Teleport 到 `body`；
- 锚点/坐标定位与视口边缘修正；
- `windowz` 注册和动态置顶；
- 点击外部、Escape 和滚动处理；
- `popup-surface-*` 毛玻璃 token；
- `menu-pop` enter/leave 动画。

### 3.2 BaseModal

用于需要遮罩、强制聚焦或独立流程的完整模态框：

- 项目详情与新建项目；
- 确认/反馈对话框；
- 文件预览；
- 活动编辑的非浮动模式。

BaseModal 统一负责遮罩、焦点、Escape、窗口层级和模态生命周期，不再被轻量菜单替代。

## 4. Phase 计划与状态

| Phase | 名称 | 状态 | 产物与验收 |
|---|---|---|---|
| Phase 0 | 基线与契约冻结 | ✅ 已完成 | 完成弹层盘点，冻结 PopupMenu/BaseModal 边界、层级和动画契约 |
| Phase 1 | PopupMenu 公共组件 | ✅ 已完成 | 新增 `PopupMenu.vue`，支持 Teleport、锚点/坐标、z-index、毛玻璃和 `menu-pop` 动画 |
| Phase 2 | 第一批业务迁移 | ✅ 已完成 | Provider、模型列表、ContextMenu、排序、日历右键/更多项、项目 Todo 接入并通过 typecheck |
| Phase 3 | 日期弹层迁移 | ✅ 已完成 | 三个日期选择器已接入 PopupMenu；保留月份/年份状态、现有边缘定位与日期业务行为 |
| Phase 4 | 活动与剩余气泡迁移 | ✅ 已完成 | 活动编辑浮动模式、IM 帮助气泡、画布对象选择和便签引用补全均接入 PopupMenu |
| Phase 5 | 清理、回归与验收 | ✅ 已完成 | 清理重复 Teleport/动画实现，完成类型检查、测试与构建验收 |
| Phase 6 | 关闭入口与生命周期统一 | ✅ 已完成 | 公共离场钩子、首帧层级提升、竞态监听隔离、活动内容延迟清理和结构回归契约已完成 |

## 5. 迁移清单

### 已完成

- `AdminSelect.vue` → `PopupMenu`；
- BYOK 模型列表 → `PopupMenu`；
- `ContextMenu.vue` → `PopupMenu`；
- 日历更多活动弹层 → `PopupMenu`；
- 日历右键菜单 → `PopupMenu`；
- 项目阶段 Todo 弹层 → `PopupMenu`；
- `SortMenu` 通过 `ContextMenu` 间接复用。
- `ProfileImPane.vue` 帮助气泡 → `PopupMenu`；
- `CanvasToolbar.vue` 画布对象选择气泡 → `PopupMenu`；
- `NoteEditor.vue` 便签引用补全下拉 → `PopupMenu`。

第一批迁移已完成并通过 `pnpm -C frontend typecheck`：

- 新增 `frontend/src/components/common/PopupMenu.vue`；
- Provider 与模型列表统一使用公共 PopupMenu；
- ContextMenu、日历右键/更多活动、项目阶段 Todo 统一使用公共 PopupMenu；
- 清理了相关临时诊断探针；
- 修复 Teleport 弹层在面板动态置顶时的关闭层级问题；
- 修复 PopupMenu 事件透传导致的 Vue warning。

### 保留专用组件但复用基础能力

- 文件信息浮窗（需拖动）；
- 图片、视频、PDF 预览（需独立查看器生命周期）；
- 全局搜索（独立搜索流程）；
- Toast、通知、聊天窗口（全局服务层）。

## 6. 交互与视觉契约

- 弹层背景使用 `--popup-surface-*` token；
- 打开/关闭统一使用 `menu-pop` 或其 token 化变体；
- leave 阶段不得因宿主面板置顶而降到面板下方；
- Teleport 弹层必须使用公共 z-index 注册，不得写固定业务层级；
- 点击选项与点击空白区域使用同一关闭时序；
- 不在业务组件重复声明 `backdrop-filter`、阴影和弹层动画；
- 禁止通过 `!important` 覆盖 Runtime 管理的 transform、opacity、transition。

### 6.1 Phase 6 新增契约：关闭必须只有一个入口

- 业务组件只能发出关闭意图（`requestClose`），不得直接修改弹层 `show`、store id 或挂载数据；
- `PopupMenu`/`BaseModal` 负责 `open → leaving → closed` 生命周期，并在 `after-leave` 后通知业务清理内容；
- 原触发器再次点击、点击空白、关闭按钮、Escape、切换目标必须复用同一关闭时序；
- 离场期间保留内容和几何尺寸，禁止因 `v-if`、store 清理或动态层级变更导致宿主塌缩；
- 关闭过程中收到新的打开请求时，必须取消旧离场或明确排队，禁止出现“先关闭再重开”的双动画；
- outside-click 使用捕获阶段时，必须先判断触发器和同一弹层的交互范围，避免与 click 处理器重复判定。
- `PopupMenu` 宿主是唯一的弹层根节点；业务内容不得再创建同时绘制背景、边框、圆角、阴影或毛玻璃的第二视觉容器。
- 业务内部容器只负责布局和内容，不得重复声明弹层 surface；确有嵌套日期/年份选择时，必须使用独立的 `PopupMenu` 实例。

## 7. 验收标准

- Provider、模型列表、右键、排序、日历更多项和 Todo 弹层的打开/关闭动画一致；
- 面板动态置顶时，弹层 leave 动画始终位于面板之上；
- 点击选项、点击空白、按 Escape 的关闭观感一致；
- 视口边缘不会出现弹层被裁切；
- 控制台无 `Extraneous non-emits event listeners` warning；
- 迁移组件不再维护重复的 z-index、Teleport 和 outside-click 逻辑；
- 同一个弹层从任意关闭入口离场时，生命周期事件序列一致，宿主尺寸不会瞬间变为扁条；
- 连续点击原触发器、点击空白、Escape 和切换其他目标均不会产生重复 leave/enter 或关闭后重开；
- `pnpm -C frontend typecheck`、前端测试和构建通过。

## 8. Phase 执行 TODO

- [x] Phase 0：冻结边界、层级和动画契约。
- [x] Phase 1：建立 PopupMenu 公共组件。
- [x] Phase 2：迁移第一批 Provider、模型列表、ContextMenu、日历和项目 Todo。
- [x] Phase 3：三个日期选择器已迁移到 PopupMenu，保留月份/年份业务状态。
- [x] Phase 4：活动编辑浮动模式已迁移为 PopupMenu 大面板样式。
- [x] Phase 4：迁移帮助气泡和剩余看板气泡。
- [x] Phase 5：删除重复 CSS/监听，完成类型检查、测试和构建验收。
- [x] Phase 0–5 全部完成，PRD 状态更新为“已完成”。
- [x] Phase 6：盘点所有弹层的直接 store/状态关闭路径，统一改为公共 `PopupMenu` 离场→`after-leave` 清理；活动浮窗保留内容至离场结束。
- [x] Phase 6：为 PopupMenu/BaseModal 增加关闭生命周期契约和竞态回归测试，覆盖原触发器、空白、Escape、关闭按钮、切换目标。
- [x] Phase 6：验证活动编辑、Provider、模型列表、Todo、日历更多项、排序和右键菜单的关闭尺寸、层级与动画一致。
- [x] Phase 6：移除迁移期间遗留的重复 transition、延迟 outside-click 注册和临时诊断探针，完成浏览器回归。
- [x] Phase 6：完成双视觉层盘点与迁移：`DatePicker.vue`、`AdminDatePicker.vue`、`CanvasToolbar.vue`、`NoteEditor.vue`、`ProfileImPane.vue`。
- [x] Phase 6：弹层视觉 surface 由公共宿主或独立 PopupMenu 实例承载，清理已迁移组件的重复 surface CSS。
- [x] Phase 6：增加 DOM 结构回归检查，确保弹层只有一个 surface，嵌套日期/年份选择仅由独立 PopupMenu 表示。

## 9. 非目标

- 不把完整模态框强行改造成菜单；
- 不改变日期、活动、项目和文件业务逻辑；
- 不改变弹层内的表单字段、权限和数据流；
- 不新增全局状态管理，仅统一弹层基础设施。
