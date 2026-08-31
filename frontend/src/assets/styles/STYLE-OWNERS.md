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
    │   ├── files.css                # 文件卡、列表操作按钮和行内重命名
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
- `components/files.css` 负责文件卡、文件夹卡、文件操作按钮和行内重命名控件的共享结构样式。
- `components/popups.css` 负责通用弹层结构、菜单项和过渡；Teleport 根节点由 `PopupMenu.vue` 负责，业务内容主题归属各自组件。
- `components/forms.css` 负责标题编辑和基础输入控件的跨页面结构样式。
- `bridges/index.css` 只负责 Teleport、浮层根节点和拖拽跨 DOM 边界，不承接组件几何或业务状态。
- `theme-refinements.css` 只提供主题/语义变量映射；具体组件的背景、边框、阴影和高光由组件文件消费。
- 非 Runtime 主题层不得通过 `[data-runtime-*]` 选择器强制覆盖 Runtime 管理的 `transform`、`transition` 或 `opacity`；确有必要的代理 paint 覆盖必须保留在 Runtime adoption 域并按 phase 限定。
- `adoption/` 和根目录旧 refinement 文件仍是迁移期兼容层，未完成域不得复制同名规则。
