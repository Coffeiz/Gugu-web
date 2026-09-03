# 样式入口与职责

Phase 1 固定主题覆盖的加载图，后续按组件域迁移时以这里为准：

```text
global.css
└── variables.css
    ├── tokens/index.css
    ├── theme-refinements.css       # 语义变量映射，不直接拥有业务组件 paint
    ├── design-overrides.css
    ├── components/index.css        # 组件覆盖与迁移期 adoption
    │   ├── theme-adoption.css      # 旧组件主题兼容，含日历工具栏和 GuguChat 过渡规则
    │   ├── component-theme-refinements.css
    │   ├── calendar.css             # 日历共享组件结构与 hover
    │   ├── files.css                # 文件卡和行内重命名
    │   ├── card-actions.css         # 卡片悬浮/行内操作按钮契约（文件卡与画布卡共用）
    │   ├── popups.css               # 通用弹层结构与交互
    │   ├── forms.css                # 跨页面基础输入控件
    │   └── file-toolbar-theme-refinements.css
    ├── design-theme-fixes.css
    ├── bridges/index.css           # Teleport / 浮层跨 DOM 树桥接
    │   ├── calendar-theme-bridge.css
    │   └── file-drop-theme-refinements.css
    └── adoption/index.css          # 迁移期按功能域的旧组件兼容样式
```

## Phase 1 约束

- `variables.css` 是全局唯一样式入口；组件覆盖和 bridge 不得被页面直接重复引入。
- `components/index.css` 负责最终组件 paint 的编排，日历工具栏、GuguChat 和文件工具栏的主题覆盖先保持原文件 owner。
- `components/calendar.css` 负责日历页与 Dashboard 共用的近期节点胶囊和条目 hover；日历 Teleport 内容主题归 `EventFormPanel.vue` 等业务组件。
- `components/files.css` 负责文件卡、文件夹卡和行内重命名控件的共享结构样式。
- `components/card-actions.css` 负责卡片悬浮/行内操作按钮的跨域契约（`.file-card-btn` /
  `.file-list-btn`，类名保留 file- 前缀仅为兼容）。文件库、Dashboard、ProjectModal 直接用类；
  画布卡片经 `CardAffordances.vue` 的 `:deep(button)` 复用同一 token/过渡口径，破坏性操作
  统一加 `del`（或 `danger`）类取红色 hover。新卡片类型一律消费这里，不得另画透明底按钮。
- `components/popups.css` 负责通用弹层结构、菜单项和过渡；Teleport 根节点由 `PopupMenu.vue` 负责，业务内容主题归属各自组件。
- `components/forms.css` 负责标题编辑和基础输入控件的跨页面结构样式。
- 多行输入框的可调整高度统一使用 `.control-resizable`；缩放柄只由 `adoption/forms.css` 的公共规则绘制，视觉值使用 `--control-resizer-bg`，页面组件不得自行添加 `::-webkit-resizer`、硬编码颜色或重复 `resize` 视觉规则。需要编辑器滚动行为时，再组合 `.scroll-surface scroll-surface--editor`。
- `bridges/index.css` 只负责 Teleport、浮层根节点和拖拽跨 DOM 边界，不承接组件几何或业务状态。
- `theme-refinements.css` 只提供主题/语义变量映射；具体组件的背景、边框、阴影和高光由组件文件消费。
- 非 Runtime 主题层不得通过 `[data-runtime-*]` 选择器强制覆盖 Runtime 管理的 `transform`、`transition` 或 `opacity`；确有必要的代理 paint 覆盖必须保留在 Runtime adoption 域并按 phase 限定。
- `adoption/` 和根目录旧 refinement 文件仍是迁移期兼容层，未完成域不得复制同名规则。

## 多行输入框 resize 契约

统一写法：

```html
<textarea class="control-resizable" />
```

需要编辑器级滚动条时：

```html
<textarea class="control-resizable scroll-surface scroll-surface--editor" />
```

约束：

- 只允许通过 `--control-resizer-bg` 调整缩放柄颜色/图案；主题差异放在 token 层，不在页面 scoped CSS 中覆盖。
- 不得在业务页面新增 `textarea::-webkit-resizer`、`::-webkit-scrollbar` 或另一套缩放柄背景。
- `resize: vertical` 由 `.control-resizable` 公共类负责；组件只组合语义 class，不重复声明视觉样式。
- 新增可缩放 textarea 后，同时在 `/design` 的 token catalog 中登记相关 token，并检查暗色主题下没有白色或黑色实心方块。
