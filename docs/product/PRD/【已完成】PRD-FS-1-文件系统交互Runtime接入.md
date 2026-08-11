# PRD-FS-1：文件系统交互 Runtime 接入

## 0. 文档状态

| 项目 | 内容 |
| --- | --- |
| 状态 | ✅ 已完成（2026-08-11） |
| 目标分支 | `codex-filesystem-core-rebuild-rebased-20260810` |
| 关联 Runtime | `gugu-interaction-runtime` |
| 影响范围 | Files 文件库、项目文件面板、文件夹与面包屑拖放 |
| 本版结论 | 单卡、多选、文件夹、面包屑、网格/列表和项目文件面板均已迁移到 Runtime Vue API；业务侧只保留声明、Action 适配和文件业务提交 |

> 本 PRD 的执行计划已完成。下方保留最初的目标、边界和阶段拆解作为设计决策记录；实际完成情况以本节和
> [文件系统 Interaction Runtime Core 重构方案](../../refactor/【已完成】文件系统Interaction%20Runtime%20Core重构方案.md)
> 的最终执行记录为准。

### 0.1 两侧协作边界

迁移期间曾在 Gugu-web 侧暂存文件系统 adapter；当前稳定代码已收敛到：

```text
frontend/src/interaction/runtime/adapters/file/
└── fileRuntimeAdapter.ts

frontend/src/composables/files/
└── useFileRuntimeMove.ts
```

`frontend/src/interaction/runtime/adapters/file/` 中保留纯 ID/Surface 辅助函数，文件业务 Action
分流由 `frontend/src/composables/files/useFileRuntimeMove.ts` 统一处理。它们只通过 Runtime
公共 API 接入，不维护第二套 Session、proxy、landing、FLIP 或清理流程。

最终目标是：文件业务组件只负责提供业务数据、注册对象/Surface/Target，以及响应 Runtime 输出的业务 Action；拖拽输入、命中测试、视觉代理、grabbing、FLIP、landing、取消、二次抓取和清理全部由 Runtime 负责。Vue 适配层只负责把组件 DOM 生命周期绑定到 Runtime，不重新实现文件拖拽逻辑。

Runtime 侧不增加文件专属 API，也不把 `fileId`、`folderId` 等业务字段加入通用 Action。Runtime 输出通用 `MoveAction`/`move-group`，文件业务适配层负责把对象和目标 Surface 翻译成现有文件移动业务。

稳定的业务无关部分已收敛到：

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

`useObject`、`useSurface`、`useTarget` 和 `useRuntimeAction` 作为 DOM/生命周期适配层使用，
不作为文件业务侧的第二套注册协议；旧拖拽入口和兼容适配器已经删除。

## 1. 背景

迁移前的文件拖拽由 `useFileDragDrop()` 和旧物理拖拽适配器负责，包含：

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
- 不把多选文件业务规则或 API 调用放进 Runtime Core；多选交互本身已由通用 Group API 提供。
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

旧 `fileDrag.ts`、`useFileDragDrop.ts` 和 `useProjectFileDrag.ts` 已删除；选择、上传、业务移动和回滚逻辑继续保留。

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
| `useFileRuntimeMove.ts` | 共享 Runtime Action 到文件业务移动的分流 |
| Vue Runtime 包装组件 | 文件卡、文件夹卡、列表行、浏览区和面包屑的生命周期绑定 |
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

- [x] 记录 Files 页面单文件、文件夹、面包屑和多选拖拽行为。
- [x] 记录项目文件面板对应行为。
- [x] 确认网格/列表同时存在时的对象作用域。
- [x] 冻结对象 ID、Surface ID 和 Runtime Action 到业务移动的映射。
- [x] 确认原生上传拖拽不接入 Runtime。

验收：不改业务行为，只完成基线记录和协议评审。

### Phase 1：单文件 Runtime 接入

- [x] 注册 `file-item` 类型。
- [x] 在迁移期间建立过渡 adapter，并在完成后收敛到稳定的 Runtime API 接入。
- [x] Files 网格视图接入单文件对象。
- [x] Files 列表视图接入单文件对象。
- [x] 注册文件夹目标 Surface。
- [x] 完成单文件拖入文件夹。
- [x] 多选路径已迁移到通用 Group API。

验收：单文件拖拽的视觉、取消、二次抓取、落地和 API 结果与旧版一致；多选行为不受影响；Runtime 侧无需新增文件专属 API。

### Phase 2：面包屑与文件夹对象

- [x] 注册 `folder-item` 类型。
- [x] 支持文件夹拖入文件夹。
- [x] 支持文件/文件夹拖入根目录和中间面包屑。
- [x] 拦截拖到自身和非法目标。
- [x] 保留现有目录权限和业务回滚。

验收：所有有效落点通过 Runtime 命中，非法落点不产生移动 Action。

### Phase 3：项目文件面板复用

- [x] ProjectModal 使用独立 scope 注册对象和 Surface。
- [x] 复用文件 Runtime ID/Target 辅助函数和 Vue 包装组件。
- [x] 接入 `useProjectFileDragMoves.ts` 与共享 `useFileRuntimeMove`。
- [x] 验证同一文件同时出现在 Files 和项目面板时互不影响。

验收：两个面板可以独立拖拽、取消、二次抓取和回滚。

### Phase 4：多选拖拽兼容与后续设计（已完成）

- [x] 确认旧多选 adapter 与 Runtime 单对象路径不会同时控制同一对象。
- [x] 补充多选路径的 Runtime 视觉交接边界。
- [x] 评估并采用通用 `GroupDragSession`。
- [x] 在 Runtime Core 完成 Group API 后完成文件业务侧迁移。

多选能力已进入 Runtime Core 的通用 `GroupDragSession`，文件业务侧只接收
`move-group` Action 并调用既有批量移动函数。

### Phase 5：删除重复单对象逻辑（已完成）

- [x] 删除旧 adapter 中已由 Runtime 接管的单对象视觉逻辑。
- [x] 删除重复的单对象 `elementFromPoint()` 落点判断。
- [x] 保留多选、原生上传、业务移动和回滚逻辑。
- [x] 清理兼容门面中的死代码。

前置条件：Phase 1～4 的行为验收全部通过。

### Phase 6：业务侧 API 收敛与 Runtime API 复评（已完成）

- [x] 将稳定的业务解析代码收敛到 `frontend/src/interaction/runtime/adapters/file/`，Action 分流收敛到 `frontend/src/composables/files/useFileRuntimeMove.ts`。
- [x] 删除 `views/Files/runtime/` 中已迁移的重复实现。
- [x] 将文件页和项目文件面板收敛为“注册对象/Surface/Target + 订阅 Action”的接入方式。
- [x] 删除业务侧单对象拖拽入口、手动命中测试、单对象 proxy/landing/FLIP 和重复清理代码。
- [x] 确认 Vue DOM 适配层只承担 element binding 和生命周期同步，不承担业务拖拽编排。
- [x] 确认文件夹对象的内嵌 Target 与独立面包屑 Target 不会重复执行同一移动 Action。
- [x] 确认 Surface ID 足以表达文件目标，未增加文件专属 Runtime 字段。
- [x] Group Session 已进入 Runtime Core，文件业务侧只消费通用 `move-group` Action。

验收：Files 页面和项目文件面板只依赖 Runtime 公共 API 与最薄的业务 Action 适配；业务侧不再拥有单对象拖拽生命周期，Runtime 公共 API 没有文件业务字段，且没有遗留两套单对象生命周期。

### 6.1 最终完成记录（2026-08-11）

- Runtime Demo 与 Gugu-web 文件库、项目文件面板的网格/列表单卡和多选均已完成回归。
- 文件夹、面包屑、无效落点、取消、落地前 regrab、连续拖拽和失败回滚均已覆盖。
- Gugu-web 当前只保留 Vue Runtime 声明、`useFileRuntimeMove` 业务 Action 适配，以及文件 API、权限、选择和 optimistic mutation。
- 后续新增文件视图必须复用现有 Vue 包装组件和共享 Action 适配，不重新引入页面级拖拽生命周期。

## 7. 测试与验收

### 7.1 自动测试

- [x] 对象 ID 作用域不会冲突。
- [x] Surface ID 能正确解析目标目录。
- [x] 文件对象只能移动到允许的目标 Surface。
- [x] 文件夹不能拖到自身或子目录非法位置。
- [x] Runtime move action 正确分流到 `moveFiles` / `moveFolders`。
- [x] 移动 API 失败时保持现有 rollback 行为。
- [x] 多选路径由 Runtime Group API 正确处理。

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
| 多选视觉与业务边界 | Runtime 提供通用 Group Session；文件 API、权限和回滚仍由业务层处理 |
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
