# 统一弹层与模态交互架构 PRD

> 状态：实施中（第一批迁移已完成，第二批待执行）
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

## 4. 迁移清单

### 已完成

- `AdminSelect.vue` → `PopupMenu`；
- BYOK 模型列表 → `PopupMenu`；
- `ContextMenu.vue` → `PopupMenu`；
- 日历更多活动弹层 → `PopupMenu`；
- 日历右键菜单 → `PopupMenu`；
- 项目阶段 Todo 弹层 → `PopupMenu`；
- `SortMenu` 通过 `ContextMenu` 间接复用。

第一批迁移已完成并通过 `pnpm -C frontend typecheck`：

- 新增 `frontend/src/components/common/PopupMenu.vue`；
- Provider 与模型列表统一使用公共 PopupMenu；
- ContextMenu、日历右键/更多活动、项目阶段 Todo 统一使用公共 PopupMenu；
- 清理了相关临时诊断探针；
- 修复 Teleport 弹层在面板动态置顶时的关闭层级问题；
- 修复 PopupMenu 事件透传导致的 Vue warning。

### 待迁移

- `AdminDatePicker.vue`；
- `DatePicker.vue`；
- `DateSpanPicker.vue`；
- `EventEditModal.vue` 的浮动模式；
- `ProfileImPane.vue` 帮助气泡；
- 其他项目看板操作气泡。

以上项目仍未完成，不应标记为已统一；当前 PRD 不得标记为“已完成”。

### 保留专用组件但复用基础能力

- 文件信息浮窗（需拖动）；
- 图片、视频、PDF 预览（需独立查看器生命周期）；
- 全局搜索（独立搜索流程）；
- Toast、通知、聊天窗口（全局服务层）。

## 5. 交互与视觉契约

- 弹层背景使用 `--popup-surface-*` token；
- 打开/关闭统一使用 `menu-pop` 或其 token 化变体；
- leave 阶段不得因宿主面板置顶而降到面板下方；
- Teleport 弹层必须使用公共 z-index 注册，不得写固定业务层级；
- 点击选项与点击空白区域使用同一关闭时序；
- 不在业务组件重复声明 `backdrop-filter`、阴影和弹层动画；
- 禁止通过 `!important` 覆盖 Runtime 管理的 transform、opacity、transition。

## 6. 验收标准

- Provider、模型列表、右键、排序、日历更多项和 Todo 弹层的打开/关闭动画一致；
- 面板动态置顶时，弹层 leave 动画始终位于面板之上；
- 点击选项、点击空白、按 Escape 的关闭观感一致；
- 视口边缘不会出现弹层被裁切；
- 控制台无 `Extraneous non-emits event listeners` warning；
- 迁移组件不再维护重复的 z-index、Teleport 和 outside-click 逻辑；
- `pnpm -C frontend typecheck`、前端测试和构建通过。

## 7. 实施顺序

1. **第二批：完善 `PopupMenu`**：支持锚点上下翻转、坐标边缘修正、自定义面板尺寸和滚动跟随。
2. 迁移 `AdminDatePicker`、`DatePicker`、`DateSpanPicker`，保留月份/年份业务状态。
3. 将 `EventEditModal` 浮动模式迁移为 PopupMenu 大面板变体；非浮动模式继续使用 `BaseModal`。
4. 迁移 `ProfileImPane` 帮助气泡和剩余看板操作气泡。
5. 删除重复 CSS、Teleport、z-index 和 outside-click 监听。
6. 补充 PopupMenu 的打开、关闭、层级、边缘定位和事件透传回归测试。
7. 完成浏览器验证后，才可将 PRD 状态更新为“已完成”。

## 8. 非目标

- 不把完整模态框强行改造成菜单；
- 不改变日期、活动、项目和文件业务逻辑；
- 不改变弹层内的表单字段、权限和数据流；
- 不新增全局状态管理，仅统一弹层基础设施。
