# Interaction Runtime 业务侧 Core API 迁移阶段 1

## 目标

Gugu-web 的业务组件直接使用 `runtime.objects`、`runtime.surfaces`、`runtime.targets` 和
`runtime.onAction()`；Vue 层只负责响应式 DOM 生命周期，不在组件中重复实现拖拽、FLIP、
landing、命中或 ownership。

## 迁移边界

- `useObject/useSurface/useTarget` 暂不删除，作为 3.x Vue 适配入口保留。
- 新迁移的业务组件直接注册 Core 语义对象，并用 generation 保护旧实例卸载。
- DOM element 绑定使用 Runtime 的 `createVueRuntimeAdapter()`；业务组件不直接维护第二套
  element 注册表。
- 新语义 key 使用 `data-layout-key`；旧 `data-card` 仅保留给未迁移页面。
- Action 仍由页面或 Store 消费，Runtime 不调用业务 API。

## 首个完整切片：项目看板（已完成）

覆盖：

- `KanbanColumn`：注册 pending/active Surface。
- `DoneColumn`：注册 done Surface。
- `ProjectCard`：注册 project Object，绑定 DOM 和 pointer input。
- `Projects/index`：消费 `move` Action，执行 optimistic Store/API 更新。

状态：

- [x] 项目卡直接注册 Object。
- [x] pending/active/done 直接注册 Surface。
- [x] `data-layout-key` 补齐。
- [x] 保留 generation、旧节点保护和 pointer 绑定。
- [x] typecheck、单测和构建通过。

验收：

1. 同列和跨列拖动行为不变，兄弟卡片仍由 Runtime FLIP 收位。
2. detach/clone、ownership、Teleport 交接不变。
3. 组件重挂载时旧 generation 不得注销新实例。
4. 页面组件没有手写 landing、命中和几何计算。
5. 前端 typecheck、单测、构建通过。

## 第二个切片：文件库网格（已完成）

- [x] 浏览区 Surface 直接注册。
- [x] 文件卡和文件夹卡直接注册 Object。
- [x] 文件夹 Object 的 Target 由 Runtime 自动同步。
- [x] 面包屑直接注册 Surface + Target。
- [x] 保留动态 props、generation 和旧节点保护。

## 第三个切片：文件库列表与项目文件面板（已完成）

- [x] 文件列表行直接注册 File/Folder Object。
- [x] 文件夹列表行和项目文件面板复用 Object Target 自动同步。
- [x] 保留列表视图的紧凑代理类型和拖放业务 Action。
- [x] 保留动态 Surface、selection 和旧节点保护。

## 第四个切片：项目编辑器文件 Surface（已完成）

- [x] 项目编辑器文件区直接注册 grid Surface。
- [x] 保留目录切换、拖拽 Action 和项目编辑器自己的 Store/API。
- [x] 保留单例弹窗切换项目时的 element 交接保护。

## 阶段 1 当前结论

阶段 1 的普通业务对象迁移已经完成并通过本地验证：

- 项目看板：Core Object/Surface 注册已完成。
- 文件库网格：浏览区、文件夹、文件、面包屑已完成 Core 注册。
- 文件库列表：文件行、文件夹行和项目文件面板已完成 Core 注册。
- 项目编辑器文件区：grid Surface 已完成 Core 注册。
- 前端验证：`npm run typecheck`、`npm run test:run`、`npm run build` 均通过。

画布抽屉的两个 floating Surface 已完成业务侧收口：

- `CanvasSidebar.vue` 不再直接调用通用 `useSurface`。
- 两个抽屉 Surface 统一经过 `useMindFloatingSurface` 明确声明 floating 语义。

它们不是普通的静态 Surface 注册，还承载自然高度测量、滚动区域、展开/收起动画和
floating resize 状态；这些职责由 Runtime 的现有 floating Surface 实现统一维护，Mind 业务侧
不复制布局编排。普通 Surface 直接使用 Core API，floating Surface 只保留一个命名清晰的适配边界。

## 后续阶段

1. **兼容层隔离**：将通用 Vue composable 与 Core API 的兼容入口继续限制在 Runtime adapter
   和 Mind floating adapter 内。
2. **全量扫描与清理**：确认剩余 `useObject/useSurface/useTarget` 调用只属于 adapter 或测试，
   再评估 3.x Vue 入口的删除时机。

## 阶段 1 复核记录

- 业务侧已不再通过 `useObject/useSurface/useTarget` 接入项目看板和文件系统。
- 画布卡片、画布主 Surface 和抽屉 floating Surface 已完成 Runtime 接入；抽屉仅保留
  `useMindFloatingSurface` 这一处业务适配边界。
- Object 的 Target 关系由 Runtime 根据注册描述自动同步，业务侧没有重复维护 TargetStore。
- 所有迁移组件仍保留 generation 检查、旧节点保护和 pointer 绑定，避免 Vue 重挂载时误注销新实例。
- 本次迁移未修改动画参数、拖拽命中规则、业务 Store/API 或持久化协议。

## 禁止事项

- 不在业务 CSS 中用 `!important` 覆盖 Runtime 的 `transform`、`transition`、`opacity`。
- 不为了迁移顺手修改动画参数、DOM 结构或业务持久化协议。
- 不直接删除 3.x 公开 Vue API；删除另开主版本任务。
