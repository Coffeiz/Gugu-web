# 文件系统 Interaction Runtime Core 重构方案

## 1. 文档状态

| 项目 | 内容 |
| --- | --- |
| 状态 | 规划中 |
| 重构分支 | `codex-filesystem-core-rebuild` |
| 基线 | `main` 合并 PR16 后的 `c1a2df52` |
| 关联仓库 | `gugu-interaction-runtime` |
| 目标 | 文件页和项目文件抽屉只通过 Runtime Core API 接入交互 |

本次从最新 `main` 重新开始。旧的 `codex-filesystem-interaction-runtime-after-cc610ae0` 只作为问题记录和行为参考，不整体迁移代码。

## 2. 重构动机

当前文件页同时存在三套职责：

1. Interaction Runtime 负责单卡 pointer、命中、代理、FLIP 和 landing。
2. 文件页 adapter 负责对象注册、Surface/Target 生命周期和 Action 分流。
3. `useFileDragDrop` 及项目文件拖拽逻辑继续维护另一套多选和 DOM 拖动生命周期。

这会导致：

- 同一个对象可能被两套 session 同时接管；
- 目录切换时 DOM 被销毁，landing 目标和 FLIP 快照失效；
- 文件页和项目抽屉复制注册逻辑，修复容易只覆盖一处；
- 目标卡、面包屑和浏览区的语义目标在业务侧重复解析；
- 乐观更新、视觉动画和 API 提交的完成时机互相影响。

本次不继续在旧 adapter 上打补丁，而是让 Runtime 成为唯一的交互编排者。

**动画与手感基准**：交互动画、手感和视觉细节以 `gugu-interaction-runtime` 仓库 demo 的效果为准，不要求跟旧文件页/项目抽屉的现有效果保持兼容。旧效果只作问题记录和行为参考（同 1 节），迁移后如果 demo 效果与旧效果不一致，以 demo 为准，不为了"保留旧手感"额外定制。

## 3. 权责边界

### 3.1 Runtime Core 负责

- Object、Surface、Target 注册和生命周期；
- pointer 输入、抓取、移动、取消和 regrab；
- 命中测试与目标解析；
- detach/clone 视觉策略；
- 代理接管、本体隐藏和交接；
- landing、retarget、速度/旋转继承；
- 同一布局集合内的 FLIP；
- 运行时 ownership 和旧实例 generation 保护；
- 输出标准化 `MoveAction`。

### 3.2 Vue 业务适配层负责

只负责把渲染节点注册到 Core API：

```ts
runtime.objects.register({ ... })
runtime.objects.setElement(id, element)
runtime.surfaces.register({ ... })
runtime.surfaces.setElement(id, element)
runtime.targets.register({ ... })
runtime.targets.setElement(id, element)
```

Vue 层可以处理 `ref` 的挂载和卸载，但不得实现 pointer、landing、FLIP、代理或目标几何计算。

### 3.3 文件业务层负责

- 文件/文件夹 API 调用；
- 乐观更新、提交、回滚和刷新；
- 文件夹循环引用校验；
- 权限判断；
- 选择状态和批量操作；
- 目录导航、面包屑数据和上传业务。

Runtime 不直接访问文件 store 或后端 API。

## 4. 目标接入形态

单对象接入的目标形态：

```ts
const objectGeneration = runtime.objects.register({
  id: fileObjectId(scope, 'file', file.id),
  type: 'file-item',
  visualMode: 'detach',
  surfaceId: browserSurfaceId,
  abilities: ['move'],
})

runtime.objects.setElement(fileObjectId(scope, 'file', file.id), element)

runtime.surfaces.register({
  id: browserSurfaceId,
  type: 'file-browser',
  accepts: ['file-item', 'folder-item'],
})

runtime.targets.register({
  id: folderTargetId,
  surfaceId: folderSurfaceId,
  accepts: ['file-item', 'folder-item'],
  priority: 2,
})
```

业务侧只订阅 Action 并提交业务变更：

```ts
const stop = runtime.onAction(action => {
  if (action.type !== 'move') return
  void moveFileByRuntimeAction(action)
})
```

`fileRuntimeAdapter` 不再隐藏 Core API，也不再维护另一份注册表。

## 5. 目录模型

### 5.1 浏览区

当前目录始终使用稳定的 browser Surface。目录切换只更新其内容，不销毁交互根节点。

### 5.2 文件夹卡

文件夹卡同时是：

- 一个可移动 Object；
- 一个语义接收 Target；
- 一个可选的 folder Surface 语义节点。

Object 自带的目标配置由 Runtime 自动管理；只有面包屑等非 Object 目标才单独注册 Target。

### 5.3 面包屑

面包屑是语义 Target，不作为普通文件卡 Object，不参与对象列表 FLIP。

### 5.4 上传入口

上传入口属于浏览区布局集合，必须参与兄弟卡片 FLIP，但不是可拖动 Object。

## 6. 实施阶段

### Phase 0：冻结基线

- 从 `main` 开始，不迁移旧 after 分支的代码；
- 记录当前 Runtime SHA；
- 校验 `.runtime-version` 锁定的 commit 与本方案第 4 节示例所用的 Core API 版本一致——即业务侧计划调用的 API（`objects/surfaces/targets` 的具体字段和方法签名）在该 SHA 下确实存在，避免出现「前端已经按新 API 写好接入代码，`.runtime-version` 却还锁在没有该 API 的旧 commit」这类版本不匹配；后续阶段每次升级 `.runtime-version` 都需重复这一校验；
- 补齐单卡拖动、文件夹目标、面包屑目标、无效落点、regrab 和目录切换测试；
- 明确单卡和多选的验收截图及行为。

完成条件：基线测试稳定，失败可以归因到重构前行为；`.runtime-version` 与业务侧实际调用的 Core API 版本已核对一致。

#### Phase 0 执行记录（2026-08-10）

**`.runtime-version` 核对**：原锁定 `f4ea29617f4c9de1494ca22d86c7ab091a25f1d2`（"收敛 Runtime Core API 并移除 Vue 适配层"）。核对 `gugu-interaction-runtime` 最新 `52a88157bce72d03956778f552b31ee9fe1f87a7`（"撤回按落点控制目标可见性的修复"）后发现中间的 `d0a7dad`（"收敛框架适配器与文件 Demo 接入"）新增了：

- `createVueRuntimeAdapter`/`createReactRuntimeAdapter`：收敛 `bindObject`/`bindSurface`/`bindTarget` 的注册-同步-卸载样板，直接消灭掉本方案第 3.2 节要求业务侧手写的那部分 ref 接线；
- `runLayoutMutation`：目录切换时统一处理"先量旧卡片位置 → mutate 数据 → 等 DOM patch → 播放 FLIP"，正是第 5.1 节浏览区目录切换、Phase 4 布局收敛需要的原语，避免业务侧另起一套目录切换动画编排；
- `data-layout-collection`/`data-layout-role`/`data-layout-key` + Collection Presence：卡片跨目录移动时的进入/离场淡入淡出，缺了这个仍需业务侧自己写 enter/leave。

`gugu-interaction-runtime` 仓库当前工作区已在 `HEAD`（`52a8815`）无未提交改动，`.runtime-version` 已同步更新为该 commit（本仓库文件系统接入是源码直引，不经 npm 构建，`.runtime-version` 只是文档/CI 对齐标记，不是强制锁版本）。`docs/demo/FileSystemDemo.vue` 已是最新可用参照实现，Phase 1/4 直接照此模式接入，不用再自己设计目录切换的布局事务。

**乐观更新等既有优化清点**（Phase 2/5 必须原样保留，不随交互层重写变化）：

| 模块 | 位置 | 说明 |
| --- | --- | --- |
| `optimisticMutation` | `frontend/src/utils/optimisticMutation.ts` | 通用乐观提交工具：apply → work → onCommit / rollback + onError，Files 和 ProjectModal 两处都在用 |
| `moveFoldersInto`/`moveFilesInto` | `frontend/src/views/Files/index.vue:453-486` | 文件页移动业务：乐观改 `parentId`/`folderId`，`version` 冲突（后端 409）走 rollback + `loadContents` 拉真实状态 |
| `useProjectFileDragMoves` 的 `moveFolders`/`moveFiles` | `frontend/src/composables/files/useProjectFileDragMoves.ts` | 项目抽屉的等价业务，接入方式与文件页一致但刷新策略不同（落文件夹卡整体重拉，落面包屑轻量刷新，见旧 `fileDrag.ts` 头注释） |
| `filesCache` store | `frontend/src/stores/filesCache.ts` | `updateFile`/`updateFolder`/`removeFiles` 等乐观更新原语 + 跨标签页/IM 回声抑制（`origin === 本页 client-id` 时跳过重拉） |
| `fileActions.moveFolder`/`moveFile` API | 业务层 | 权限、循环引用校验、`version` 并发控制在后端 + 调用方双重保障 |

Phase 1 只替换"怎么触发这些函数"（从 `useFileDragDrop` 的 `dispatchDrop` 回调改成 `runtime.onAction()` 订阅），函数本身、乐观更新时序、回滚和 409 处理逻辑不变。

### Phase 1：单卡 Core API 接入

- 删除文件页的 `createFileRuntimeBindings`；
- 删除文件专用 Runtime 注册 watchEffect 和 prune 逻辑；
- 文件卡、文件夹卡、面包屑直接注册 Core API；
- 保留 generation 保护，但放到 Runtime 通用注册生命周期；
- 文件页和 ProjectModal 使用同一套注册约定；
- 单卡 Action 只进入业务移动函数。

完成条件：单文件、单文件夹拖动完全由 Runtime 处理，旧 adapter 不再参与单卡生命周期。

### Phase 2：业务提交边界收敛

- 将文件移动业务抽成明确的 `moveByRuntimeAction`；
- 统一文件页和项目抽屉的 optimistic mutation；
- 保留循环目录校验和权限校验在业务侧；
- 确认 Runtime 动画完成不等于 API 提交完成，两者不互相等待错误的生命周期。

完成条件：视觉交互和数据提交可以分别测试，失败时不会重复触发 landing。

#### Phase 2 执行记录（2026-08-10）

Phase 1 落地时已经顺带满足本阶段的实质要求，本阶段只做核对，不追加代码：

- **`moveByRuntimeAction`**：`Files/index.vue` 的 `handleRuntimeMoveAction` 与 `ProjectModal.vue`
  的同名函数就是这个收敛点——从 `runtime.onAction()` 的 `MoveAction` 解析 `objectId`/
  `toSurfaceId`，只做落点判定（面包屑 vs 文件夹 vs 浏览区本身/自身），不做乐观更新或 API
  调用，两侧结构完全对称。
- **optimistic mutation 是否要合并成一份**：核对后决定不合并。文件页的 `moveFoldersInto`/
  `moveFilesInto` 和项目抽屉的 `useProjectFileDragMoves`（`moveFolders`/`moveFiles`）在
  `afterMutate`/落点后刷新策略上本来就不同——文件页乐观更新后调用 `loadContents` 重投影，
  项目抽屉落文件夹卡整体重拉、落面包屑轻量刷新——这是旧 `fileDrag.ts` 头注释里明确记录的
  既有差异，不是这次重构引入的重复。"统一" 落实为两边使用同一套**调用形状**（`moveByRuntimeAction`
  的解析/分流逻辑一致），而不是合并成一个函数——合并会抹掉两边本就不同的刷新语义，属于过度
  抽象。
- **循环目录校验**：核对 `backend/app/services/storage/folder_tree.py:150-155`，
  `SqlAlchemyFolderTree.move()` 已经向上遍历目标链检测循环，命中即抛
  `Invalid("folder.cycle", "不能将文件夹移动到自身或其子文件夹中")`。这层校验在后端服务层，
  与前端用哪套拖拽编排（旧 pointer 系统还是 Runtime）无关，Phase 1/2 都不需要在前端重复实现，
  前端只做了"拖到自身"这一浅层短路（`targetFolderId === id` 时直接 return，避免无意义的
  网络往返），更深的祖先链校验完全交给后端。
- **动画完成 ≠ API 提交完成**：`runtime.onAction(action => { void handleRuntimeMoveAction(...) })`
  用 `void` 触发即不等待——Runtime 的 landing/reveal 动画按自己的时间线播放，不会被这个
  Promise 挂起；`handleRuntimeMoveAction` 内部的 `optimisticMutation` 失败走 rollback，不影响
  已经播放完的落地动画（视觉上"看起来移过去了"和"数据确实移过去了"是两条独立时间线，符合
  完成条件里"失败时不会重复触发 landing"——失败只会在数据层 rollback，不会让 Runtime 认为
  这次拖拽本身失败而重新触发一次 landing）。

完成条件：视觉交互和数据提交可以分别测试，失败时不会重复触发 landing。

### Phase 3：多选交互进入 Runtime（跨仓库，独立轨道）

当前 Runtime Core 主要覆盖单 Object。要删除旧多选拖拽，需先提供通用 group interaction：

- 多 Object 选择快照；
- 一个 group session 和一个视觉代理；
- 批量命中与统一目标；
- 批量 MoveAction；
- 取消、regrab 和失败恢复；
- 业务侧只接收对象 ID 列表并执行批量 API。

**依赖说明**：这一阶段不在 Gugu-web / 本仓库内完成，前置工作在 `gugu-interaction-runtime` 仓库：

- 新增 `GroupDragSession`（不改造现有 `Session.objectId` 标量字段，避免牵连 `RuntimeMove.ts` 等既有单对象读取点）；
- `VisualProxyCoordinator` 从 1 session : 1 proxy 改为 1 session : N proxy；
- 复用现有 `Owner.takeObject`（循环获取多个 lease）、`GroupLayout` 的多元素 FLIP 原语、`Visual.createDragProxy`（调用 N 次），这几处已是 id-keyed/数组化实现，不需要改动；
- 发布新版本后，本仓库更新 `.runtime-version` 锁定并消费。

**与其他阶段的关系**：Phase 3 与 Phase 0/1/2/4 没有依赖关系，不阻塞后者合并上线。Phase 0/1/2/4 可以独立推进、独立验收、独立合并；Phase 3（以及依赖它的 Phase 5 多选清理部分）作为单独时间线，在 `gugu-interaction-runtime` 侧的 `GroupDragSession` 发布后再启动，不按线性阶段顺序卡住前面的工作。

完成条件：`useFileDragDrop` 和 `useProjectFileDrag` 不再负责拖拽生命周期。

### Phase 4：目录切换与布局收敛

- 浏览区保持稳定 Surface；
- 目录变化由 Runtime collection FLIP 捕获和播放；
- 上传入口、文件卡和文件夹卡使用同一布局集合；
- 移除业务侧额外的 `Transition mode="out-in"` 对交互节点的销毁影响；
- 验证 landing 进行中切换目录、快速拖动和连续 regrab。

完成条件：目录切换、卡片让位和 landing 不再出现瞬移、旧目标、重复 FLIP 或本体闪现。

### Phase 5：清理旧代码

候选删除内容：

- `frontend/src/interaction/runtime/adapters/file/fileRuntimeAdapter.ts`；
- 文件页和项目抽屉的 Runtime 注册 watchEffect；
- 单卡旧 pointer/drop 分流；
- 多选迁移完成后删除 `fileDrag.ts` 和 `useProjectFileDrag.ts` 的拖拽职责；
- 仅用于旧路径的测试、README 和兼容类型。

纯 ID 生成函数、业务移动函数、选择逻辑和上传逻辑继续保留。

## 7. 暂不做的事情

- 不把文件 API 或 optimistic mutation 放进 Runtime；
- 不为文件单独创建 Runtime 专属动画实现；
- 不同时维护 detach 和 clone 两套文件业务编排；
- 不整体 cherry-pick 旧 after 分支；
- 不为兼容文件页/项目抽屉的旧动画手感而定制 Runtime 或 adapter 行为，动画效果统一以 demo 为准；
- 不在没有 group interaction 前删除多选功能；
- Phase 3 的 Runtime 核心改动（`GroupDragSession`、`VisualProxyCoordinator` 1:N 化）不在本仓库内实现，不在本重构分支里直接修改 `gugu-interaction-runtime` 源码。

## 8. 验收标准

### 交互

- 文件卡拖动时兄弟卡实时 FLIP；
- 文件夹卡、面包屑和无效落点使用正确 landing 目标；
- landing 过程中再次抓取可以从当前视觉位置接管；
- 目标卡发生 FLIP 时，代理实时 retarget；
- 文件页和项目抽屉的单卡手感、速度、旋转和淡出与 `gugu-interaction-runtime` demo 一致（不要求与重构前的旧效果一致）；
- 上传入口参与布局 FLIP；
- 目录切换不导致本体闪现或代理变形。

### 数据

- 成功移动后立即看到乐观结果；
- API 失败时正确回滚；
- 文件夹循环引用被业务层拒绝；
- 多选移动不会重复提交或漏提交。

### 工程

- 文件业务侧不再实现 pointer、landing、FLIP 或代理生命周期；
- 单卡不再依赖旧 file adapter；
- Runtime Core API、Gugu-web 类型检查和测试均通过；
- 每个阶段可独立提交、验证和回退。

## 9. 预估收益

单卡收敛预计减少业务侧约 500～650 行交互接线；多选迁移完成后再减少约 500～700 行旧拖拽编排。Runtime 会增加通用 group interaction，但文件页不再复制这套逻辑，长期维护的交互实现只保留一份。
