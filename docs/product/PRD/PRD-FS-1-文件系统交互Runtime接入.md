# PRD-FS-1：文件系统交互 Runtime 接入

## 0. 文档状态

| 项目 | 内容 |
| --- | --- |
| 状态 | 设计中，尚未实施 |
| 目标分支 | `codex-filesystem-interaction-runtime` |
| 关联 Runtime | `gugu-interaction-runtime` |
| 影响范围 | Files 文件库、项目文件面板、文件夹与面包屑拖放 |
| 本版结论 | 先迁移单对象拖拽，多选拖拽暂时保留旧适配器；最终业务侧只保留 Runtime 注册和业务移动回调 |

### 0.1 两侧协作边界

第一版先在 Gugu-web 侧暂存文件系统 adapter：

```text
frontend/src/views/Files/runtime/
├── fileRuntimeAdapter.ts
├── fileTargetResolver.ts
├── fileRuntimeTypes.ts
└── README.md
```

该目录是迁移过渡层，不是最终目录。它只通过 Runtime 的公共 API 接入，不自行维护第二套 Session、proxy、landing、FLIP 或清理流程。

最终目标是：文件业务组件只负责提供业务数据、注册对象/Surface/Target，以及响应 Runtime 输出的业务 Action；拖拽输入、命中测试、视觉代理、grabbing、FLIP、landing、取消、二次抓取和清理全部由 Runtime 负责。Vue 适配层只负责把组件 DOM 生命周期绑定到 Runtime，不重新实现文件拖拽逻辑。

Runtime 侧第一版不增加文件专属 API，也不把 `fileId`、`folderId` 等业务字段加入通用 Action。Runtime 只输出通用 `MoveAction`，文件 adapter 负责把 `objectId`、`fromSurfaceId` 和 `toSurfaceId` 翻译成现有文件移动业务。

待单对象接入稳定后，再将稳定的业务无关部分从暂存目录收敛到：

```text
frontend/src/interaction/runtime/adapters/file/
```

只有当文件交互能力需要被多个应用复用，或需要 Runtime 原生支持多对象文件事务时，才另行评估 `gugu-interaction-runtime/src/file/`。多选基础能力如果最终具有通用价值，应单独进入 Runtime 的 `group/`，不与文件业务模块混合。

### 0.2 最终接入形态

文件业务侧最终只需要完成以下三类声明：

```ts
runtime.objects.register(object)
runtime.surfaces.register(surface)
runtime.targets.register(target)
```

以及订阅通用业务动作：

```ts
runtime.onAction(action => moveFile(action))
```

业务侧不得再调用以下 Runtime 内部能力：

- `startPhysicsDrag`、`startThresholdDrag` 或其他拖拽启动函数。
- `elementFromPoint()` 进行目标判断。
- 单对象 clone、proxy、landing、FLIP 和 transition 清理。
- 直接修改 Runtime 管理的 transform、opacity、visibility 或 pointer-events。
- 为文件页面单独维护拖拽 Session、运动状态或视觉交接状态。

`useObject`、`useSurface` 等 Vue/React 适配 API 如果仍存在，只能作为 DOM 绑定适配层，不作为文件业务侧的第二套注册协议。Phase 6 将复查并删除不再需要的旧适配入口。

## 1. 背景

当前文件拖拽仍由 `useFileDragDrop()` 和旧物理拖拽适配器负责，包含：

- 单文件、文件夹和多选拖拽。
- 文件夹卡片与面包屑落点识别。
- 拖动中的落点高亮。
- 克隆、吸入、落地和取消动画。
- Files 页面与项目文件面板的业务移动和回滚。

项目卡片已经接入 `gugu-interaction-runtime`，由 Runtime 统一负责对象注册、Surface 命中、视觉代理、FLIP 和落地交接。文件系统接入的目标不是重写文件卡片，而是把文件拖拽的交互协调纳入同一套 Runtime，同时保留现有文件业务规则。

## 2. 目标

### 2.1 主要目标

1. 单文件和单文件夹拖拽使用 Runtime 的对象、Surface、Target 和完整视觉生命周期。
2. 文件夹卡片和面包屑成为明确的拖放目标，不再由业务层到处调用 `elementFromPoint()` 判断。
3. Files 页面和项目文件面板共享同一套 Runtime adapter。
4. 保留现有 optimistic update、API 移动、失败回滚和选择状态清理。
5. 避免同一文件在不同文件面板中发生 Runtime 对象 ID 冲突。
6. 原生上传拖拽继续独立工作，不被卡片拖拽 Runtime 拦截。
7. 迁移完成后，业务侧仅通过 Runtime 公共 API 注册对象、Surface、Target 并处理通用 Action，不再编排单对象拖拽生命周期。

### 2.2 非目标

本次不做：

- 不修改文件 API、Store、数据库模型和移动接口。
- 不修改 `FileCard.vue`、`FolderCard.vue` 的视觉样式和布局。
- 不立即迁移多选拖拽。
- 不把 Files 页面、项目文件面板强行合并成一个业务页面。
- 不让 Runtime 了解文件夹、项目或文件库业务。
- 不在 Runtime 核心中加入文件系统专属逻辑。

## 3. 当前实现基线

### 3.1 现有入口

```text
Files/index.vue
  └── useFileDragDrop()
        └── interaction/drag/adapters/fileDrag.ts
              ├── startPhysicsDrag
              ├── startMultiPhysicsDrag
              ├── startThresholdDrag
              ├── elementFromPoint 落点识别
              ├── 文件夹高亮
              └── 面包屑高亮与目录解析

ProjectModal.vue
  └── useProjectFileDrag()
        ├── useFileDragDrop()
        └── useProjectFileDragMoves()
```

### 3.2 现有业务边界

文件移动业务已经由以下模块承担，迁移时继续复用：

- `useProjectFileDragMoves.ts`：项目文件移动、optimistic cache、API 请求和回滚。
- Files 页面现有移动方法：文件库目录移动、选择状态清理和刷新。
- 原生上传逻辑：Files 页面和项目文件面板各自维护。

旧 `fileDrag.ts` 在迁移期间不是立即删除的死代码，而是多选和兼容路径的暂存适配器。

## 4. Runtime 接入模型

### 4.1 对象类型

Runtime 注册两个文件系统对象类型：

```text
file-item
folder-item
```

对象 ID 必须包含页面作用域，禁止直接使用数据库文件 ID：

```text
files:file:123
files:folder:45

project-files:19:file:123
project-files:19:folder:45
```

原因是同一个文件可能同时出现在 Files 页面和 ProjectModal 中。Runtime 对象注册是全局的，裸 ID 会导致注册覆盖、拖拽状态串线或错误的 Surface 归属。

### 4.2 Surface 类型

文件系统需要三类 Surface：

```text
文件浏览区域
files:view:<scope>

文件夹目标
files:folder-target:<scope>:<folderId>

面包屑目标
files:breadcrumb:<scope>:<folderId|null>
```

项目文件面板使用同样结构，但前缀必须包含项目作用域：

```text
project-files:<projectId>:view
project-files:<projectId>:folder-target:<folderId>
project-files:<projectId>:breadcrumb:<folderId|null>
```

文件夹和可放入的面包屑 Surface 接受：

```text
file-item
folder-item
```

目标 Surface ID 携带目标目录 ID，业务桥接层只负责解析目标并调用现有移动函数。

### 4.3 Runtime Action 到业务移动

Runtime 只产生通用移动动作：

```text
move(objectId, fromSurfaceId, toSurfaceId, toIndex?)
```

文件系统 adapter 负责：

1. 解析对象作用域和对象类型。
2. 解析目标 Surface 对应的目录 ID。
3. 校验当前作用域、权限和自拖拽规则。
4. 调用已有 `moveFiles()` 或 `moveFolders()`。
5. 处理 optimistic update、失败回滚和选择状态清理。

Runtime 不直接读文件 Store，也不调用文件 API。

## 5. 目标代码结构

第一版建议增加：

```text
frontend/src/interaction/runtime/
├── setup.ts
├── index.ts
└── adapters/
    ├── fileRuntime.ts
    └── fileTargets.ts

frontend/src/composables/files/
├── useFileRuntimeDrag.ts
├── useFileDragDrop.ts
├── useProjectFileDrag.ts
└── useProjectFileDragMoves.ts
```

职责：

| 模块 | 职责 |
| --- | --- |
| `setup.ts` | 注册 `file-item`、`folder-item` 类型和统一运动参数 |
| `fileRuntime.ts` | 文件对象 ID、作用域、Runtime action 解析和业务桥接 |
| `fileTargets.ts` | 文件浏览区、文件夹、面包屑 Surface 的 ID 与目标解析 |
| `useFileRuntimeDrag.ts` | 页面级 Runtime 对象和目标绑定入口 |
| `useFileDragDrop.ts` | 迁移期间的兼容门面，暂保留旧多选路径 |
| `useProjectFileDrag.ts` | 项目文件面板的作用域和业务配置 |
| `useProjectFileDragMoves.ts` | 现有移动 API、optimistic update 和 rollback |

### 5.1 卡片改动边界

`FileCard.vue` 和 `FolderCard.vue` 只增加 Runtime 绑定所需的最小入口：

- 暴露根节点 ref，或提供统一的 element binding。
- 接收对象 ID/Runtime 绑定参数，或由父级绑定对象节点。
- 保留现有样式、插槽、选中态、重命名和按钮事件。

不在卡片组件内部实现：

- 目录命中。
- 文件移动 API。
- 多选策略。
- 页面作用域判断。
- optimistic update。

列表视图目前使用普通 `.list-row`，需要在列表行级别补 Runtime 对象绑定；这属于宿主接入，不是视觉卡片重构。

## 6. 分阶段执行计划

### Phase 0：行为基线与协议冻结

- [ ] 记录 Files 页面单文件、文件夹、面包屑和多选拖拽行为。
- [ ] 记录项目文件面板对应行为。
- [ ] 确认网格/列表同时存在时的对象作用域。
- [ ] 冻结对象 ID、Surface ID 和 Runtime Action 到业务移动的映射。
- [ ] 确认原生上传拖拽不接入 Runtime。

验收：不改业务行为，只完成基线记录和协议评审。

### Phase 1：单文件 Runtime 接入

- [ ] 注册 `file-item` 类型。
- [ ] 在 `frontend/src/views/Files/runtime/` 建立过渡 adapter，只调用 Runtime 公共 API。
- [ ] Files 网格视图接入单文件对象。
- [ ] Files 列表视图接入单文件对象。
- [ ] 注册文件夹目标 Surface。
- [ ] 完成单文件拖入文件夹。
- [ ] 保留旧多选路径。

验收：单文件拖拽的视觉、取消、二次抓取、落地和 API 结果与旧版一致；多选行为不受影响；Runtime 侧无需新增文件专属 API。

### Phase 2：面包屑与文件夹对象

- [ ] 注册 `folder-item` 类型。
- [ ] 支持文件夹拖入文件夹。
- [ ] 支持文件/文件夹拖入根目录和中间面包屑。
- [ ] 拦截拖到自身和非法目标。
- [ ] 保留现有目录权限和业务回滚。

验收：所有有效落点通过 Runtime 命中，非法落点不产生移动 Action。

### Phase 3：项目文件面板复用

- [ ] ProjectModal 使用独立 scope 注册对象和 Surface。
- [ ] 复用 `fileRuntime.ts` 与 `fileTargets.ts`。
- [ ] 接入 `useProjectFileDragMoves.ts`。
- [ ] 验证同一文件同时出现在 Files 和项目面板时互不影响。

验收：两个面板可以独立拖拽、取消、二次抓取和回滚。

### Phase 4：多选拖拽兼容与后续设计

- [ ] 确认旧多选 adapter 与 Runtime 单对象路径不会同时控制同一对象。
- [ ] 补充多选路径的 Runtime 视觉交接边界。
- [ ] 评估是否需要通用 `GroupDragSession`。
- [ ] 如果需要，先在文件 adapter 层验证，再决定是否扩展 Runtime 核心。

本阶段不预设一定把多选能力并入通用 Runtime。

### Phase 5：删除重复单对象逻辑

- [ ] 删除旧 adapter 中已由 Runtime 接管的单对象视觉逻辑。
- [ ] 删除重复的单对象 `elementFromPoint()` 落点判断。
- [ ] 保留多选、原生上传、业务移动和回滚逻辑。
- [ ] 清理兼容门面中的死代码。

前置条件：Phase 1～4 的行为验收全部通过。

### Phase 6：业务侧 API 收敛与 Runtime API 复评

- [ ] 将暂存目录中仍有复用价值的业务解析代码移至 `frontend/src/interaction/runtime/adapters/file/`，仅保留对象/目标 ID 映射和 Action 到业务移动的桥接。
- [ ] 删除 `views/Files/runtime/` 中已经迁移的重复实现。
- [ ] 将文件页和项目文件面板收敛为“注册对象/Surface/Target + 订阅 Action”的接入方式。
- [ ] 删除业务侧单对象拖拽入口、手动命中测试、单对象 proxy/landing/FLIP 和重复清理代码。
- [ ] 确认 Vue DOM 适配层只承担 element binding 和生命周期同步，不承担业务拖拽编排。
- [ ] 确认文件夹对象的内嵌 Target 与独立面包屑 Target 不会重复执行同一移动 Action。
- [ ] 复查是否仍需要通过 Surface ID 编码目标目录；如果确实脆弱，再提出通用 `Surface.metadata` 或目标快照 API。
- [ ] 不在没有实际复用场景前新增 `gugu-interaction-runtime/src/file/`。
- [ ] 若多选拖拽需要 Runtime 支持，单独设计 `GroupDragSession` 评审，不与本 PRD 的单对象迁移混做。

验收：Files 页面和项目文件面板只依赖 Runtime 公共 API 与最薄的业务 Action 适配；业务侧不再拥有单对象拖拽生命周期，Runtime 公共 API 没有文件业务字段，且没有遗留两套单对象生命周期。

## 7. 测试与验收

### 7.1 自动测试

- [ ] 对象 ID 作用域不会冲突。
- [ ] Surface ID 能正确解析目标目录。
- [ ] 文件对象只能移动到允许的目标 Surface。
- [ ] 文件夹不能拖到自身或子目录非法位置。
- [ ] Runtime move action 正确分流到 `moveFiles` / `moveFolders`。
- [ ] 移动 API 失败时保持现有 rollback 行为。
- [ ] 多选路径仍由旧 adapter 正确处理。

### 7.2 手动验收

1. Files 网格中拖动单文件到文件夹。
2. Files 列表中拖动单文件到文件夹。
3. 拖动文件夹到另一个文件夹。
4. 拖动文件到根目录面包屑。
5. 拖动文件到中间目录面包屑。
6. 拖到自身或非法目标时不发生移动。
7. 拖动过程中取消，源卡片恢复正常。
8. 落地动画未完成时再次抓起。
9. Files 页面和项目文件面板同时打开同一个文件。
10. 项目文件面板中执行文件和文件夹移动。
11. 多选文件和文件夹继续正常移动。
12. 原生外部文件上传拖入区域继续正常工作。
13. 移动接口失败时界面回滚且不残留 Runtime 状态。
14. 刷新页面后目录结构与数据库一致。

## 8. 风险与处理

| 风险 | 处理方式 |
| --- | --- |
| 同一文件在多个面板注册冲突 | 所有对象和 Surface ID 强制带 scope |
| Runtime 暂无多选 Session | 第一版保留旧多选 adapter，不提前修改核心 |
| 文件夹与面包屑命中重叠 | 使用注册 Surface 命中测试，确认最具体目标优先 |
| 旧物理拖拽和 Runtime 双重控制 | 单对象路径只能选择一个 owner |
| 原生上传被 Runtime 拦截 | 上传 drop zone 继续使用独立原生事件 |
| optimistic update 与落地动画时序冲突 | Runtime 只发 Action，业务桥接统一处理状态更新 |
| 项目面板和文件库规则不同 | adapter 共享通用解析，业务移动函数保持各自实现 |

## 9. 默认决策

- 先迁移单对象，再处理多选。
- 文件卡片只做最小 Runtime 绑定，不重写视觉组件。
- 网格、列表、文件夹和面包屑负责宿主与目标注册。
- Runtime 不包含文件系统业务逻辑。
- `fileDrag.ts` 在迁移完成前保留为多选/兼容适配器。
- 单对象迁移完成后的最终业务接入面固定为：对象注册、Surface 注册、Target 注册和通用 Action 订阅。
- Vue/React 适配层可以存在，但只能负责框架 DOM 生命周期绑定，不能形成第二套业务 API 或视觉运行时。
- 不修改文件 API、Store、数据库和原生上传流程。
- 每个阶段单独验证，行为出现差异时停止进入下一阶段。
