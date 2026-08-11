# 文件系统 Interaction Runtime Core 重构方案

## 1. 文档状态

| 项目 | 内容 |
| --- | --- |
| 状态 | 🟢 Phase 3D–5 已完成：文件库主页面与项目编辑卡的单卡、多选入口已接入 Runtime Group API；文件系统对象、Surface、Target 已统一走 Vue API；旧拖拽适配器、失效状态和临时探针已清理 |
| 重构分支 | `codex-filesystem-core-rebuild` |
| 基线 | `main` 合并 PR16 后的 `c1a2df52` |
| 关联仓库 | `gugu-interaction-runtime` |
| 目标 | 文件页和项目文件抽屉只通过 Runtime Core API 接入交互 |

本次从最新 `main` 重新开始。旧的 `codex-filesystem-interaction-runtime-after-cc610ae0` 只作为问题记录和行为参考，不整体迁移代码。

## 2. 重构动机

当前文件系统接入已经完成单卡与多卡 Runtime/Vue API 收口；Runtime Demo 与 Gugu-web 文件库、项目编辑卡已经完成 Group API 接入，旧拖拽生命周期适配器与目标反馈字段已在 Phase 5 清理，剩余仅为边界验收记录：

1. Interaction Runtime 负责单卡 pointer、命中、代理、FLIP 和 landing。
2. 文件库主页面和文件卡组件通过 Vue composable 管理对象、Surface、Target 生命周期和 Action 分流。
3. ProjectModal 的对象、Surface、Target 和 Action 已通过 Vue API 接入；`createVueRuntimeAdapter` 只保留布局事务能力，旧卡片拖拽适配器已删除，文件 API、选择、权限和回滚仍由业务侧负责。

`gugu-interaction-runtime` 已提供并验证：`GroupDragSession`、`startGroupObjectPointer()`、
`move-group` Action、同组 Object ownership、共享运动/landing/regrab 时间线，以及主卡 +
后置修饰卡的通用视觉上下文。Runtime Demo 的网格/列表多选 E2E 已通过；这只代表通用 Core
和 Demo 可用，不代表 Gugu-web 真实文件页已经迁移完成。

这会导致：

- 同一个对象可能被两套 session 同时接管；
- 目录切换时 DOM 被销毁，landing 目标和 FLIP 快照失效；
- 文件页和项目抽屉复制注册逻辑，修复容易只覆盖一处；
- 目标卡、面包屑和浏览区的语义目标在业务侧重复解析；
- 乐观更新、视觉动画和 API 提交的完成时机互相影响。

本次不继续在旧 adapter 上打补丁，而是让 Runtime 成为唯一的交互编排者。

**动画与手感基准**：单卡交互以 `gugu-interaction-runtime` 仓库 demo 的效果为准，不要求跟旧文件页/项目抽屉的单卡效果保持兼容。多选交互在迁移到 Group Session 时，必须保留当前
`startMultiPhysicsDrag` 的主卡 + 后置修饰卡表现、卡片偏移、玻璃底色、阴影、缩放、落地和
regrab 手感，不重新设计多选视觉。旧效果只作问题记录和行为参考；除多选兼容约束外，
不为了保留旧手感额外定制 Runtime 或 adapter。

## 3. 权责边界

### 3.1 Runtime Core 负责

- Object、Surface、Target 注册和生命周期；
- pointer 输入、抓取、移动、取消和 regrab；
- 命中测试与目标解析；
- detach/clone 视觉策略；
- 代理接管、本体隐藏和交接；
- landing、retarget、速度/旋转继承；
- 同一布局集合内的 FLIP；
- 多对象拖拽的 Group Session：由一张主卡驱动物理，附属卡共享运动轨迹；
- 运行时 ownership 和旧实例 generation 保护；
- 输出标准化 `MoveAction`。

### 3.2 Vue 业务适配层负责

Vue 适配层是业务侧的唯一注册入口。文件卡、文件夹卡、浏览区 Surface 和面包屑目标优先使用
`frontend/src/interaction/runtime/vue.ts` 暴露的 composable，自动处理注册、DOM ref 同步、
generation 保护和卸载注销：

```ts
const { elementRef: objectRef } = useObject({ ... })
const { elementRef: surfaceRef } = useSurface({ ... })
const { elementRef: targetRef } = useTarget({ ... })
useRuntimeAction(action => { ... })
```

`useObject`、`useSurface`、`useTarget` 负责声明对象/Surface/Target；`useRuntimeAction` 负责
生命周期内订阅和自动注销 Action。Vue 层不得实现 pointer、landing、FLIP、代理或目标几何
计算。

`createVueRuntimeAdapter` 仅作为尚未完成迁移的项目编辑卡过渡桥接，不再作为新接入代码的
推荐形态。最终目标是项目编辑卡也改为独立的 Vue composable 接入，业务组件不直接调用
`register`、`setElement` 或手写 generation/prune 逻辑。

### 3.3 文件业务层负责

- 文件/文件夹 API 调用；
- 乐观更新、提交、回滚和刷新；
- 文件夹循环引用校验；
- 权限判断；
- 选择状态和批量操作；
- 目录导航、面包屑数据和上传业务。

Runtime 不直接访问文件 store 或后端 API。

## 4. 目标接入形态

单对象接入的目标形态（Vue 业务组件）：

```ts
const { elementRef: cardRef } = useObject({
  id: fileObjectId(scope, 'file', file.id),
  type: 'file-item',
  surface: () => browserSurfaceId,
  abilities: () => ['move'],
})

const { elementRef: browserRef } = useSurface({
  id: browserSurfaceId,
  type: 'file-browser',
  accepts: ['file-item', 'folder-item'],
})

const { elementRef: folderRef } = useTarget({
  id: folderTargetId,
  surfaceId: folderSurfaceId,
  accepts: ['file-item', 'folder-item'],
  priority: 2,
})
```

业务侧只订阅 Action 并提交业务变更，通常使用统一的 Vue composable：

```ts
useRuntimeAction(action => {
  if (action.type !== 'move') return
  void moveFileByRuntimeAction(action)
})
```

`fileRuntimeAdapter` 只保留 ID 生成和解析等纯函数，不隐藏 Core API，也不维护另一份注册表。

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
| `useProjectFileDragMoves` 的 `moveFolders`/`moveFiles` | `frontend/src/composables/files/useProjectFileDragMoves.ts` | 项目抽屉的业务移动边界，接入方式与文件页一致但刷新策略不同（落文件夹卡整体重拉，落面包屑轻量刷新） |
| `filesCache` store | `frontend/src/stores/filesCache.ts` | `updateFile`/`updateFolder`/`removeFiles` 等乐观更新原语 + 跨标签页/IM 回声抑制（`origin === 本页 client-id` 时跳过重拉） |
| `fileActions.moveFolder`/`moveFile` API | 业务层 | 权限、循环引用校验、`version` 并发控制在后端 + 调用方双重保障 |

Phase 1 只替换"怎么触发这些函数"（从 `useFileDragDrop` 的 `dispatchDrop` 回调改成
`useRuntimeAction()` 订阅），函数本身、乐观更新时序、回滚和 409 处理逻辑不变。

### Phase 1：单卡 Core API 与 Vue API 接入

- 删除文件页的 `createFileRuntimeBindings`；
- 删除文件专用 Runtime 注册 watchEffect 和 prune 逻辑；
- 文件卡、文件夹卡、面包屑和浏览区 Surface 通过 `useObject`、`useSurface`、`useTarget`
  接入 Runtime；
- 保留 generation 保护，由 Vue 适配层统一处理；
- 文件库主页面已完成该迁移；ProjectModal 仍有 `createVueRuntimeAdapter` 过渡接线，作为
  后续收口项单独迁移；
- 单卡 Action 只进入业务移动函数。

完成条件：文件库主页面的单文件、单文件夹拖动完全由 Runtime 处理，单卡业务组件不再
手写注册生命周期；项目编辑卡完成 composable 迁移后，本阶段才算全仓收口。

#### Phase 1 执行记录（2026-08-10）

- `RuntimeFileCard.vue`、`RuntimeFolderCard.vue`、`RuntimeFileListRow.vue`、
  `RuntimeFolderListRow.vue` 使用 `useObject`；文件夹卡同时用 `useSurface` 注册可接收的
  文件夹 Surface。
- `RuntimeBreadcrumbTarget.vue` 使用 `useSurface` + `useTarget`，面包屑不再由业务页面手写
  Target 生命周期。
- `Files/index.vue` 使用 `useSurface` 注册浏览区，并使用 `useRuntimeAction` 订阅单卡移动
  Action；`fileRuntimeAdapter` 只保留 ID/Surface 纯函数。
- `ProjectModal.vue` 仍使用 `createVueRuntimeAdapter` 绑定项目文件卡、面包屑和浏览区，作为
  下一步 Vue composable 收口对象；本记录不将它误标成已完成。

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

Runtime Core 的通用 group interaction 已完成并在 Demo 验证。现在本阶段的重点从“设计并实现
Group Session”转为“将 Gugu-web 文件页迁移到已验证的 Group API”，仍需保证：

- 多 Object 选择快照；
- 一个 group session；
- 鼠标实际抓起的卡片作为主卡代理，其他选中卡作为 1～2 张后置修饰代理；
- 主卡负责跟随指针、速度采样、物理落点和目标命中，修饰代理共享主卡的运动向量；
- 所有选中对象参与 ownership、落地和最终业务动作，但不要求每个对象都单独创建一套物理 session；
- 批量命中与统一目标；
- 批量 MoveAction；
- 取消、regrab 和失败恢复；
- 业务侧只接收对象 ID 列表并执行批量 API。

**视觉基准与兼容约束**：多选迁移不重新设计文件拖拽样式。继续沿用当前
`startMultiPhysicsDrag` 的主卡 + 后置修饰卡表现、卡片间偏移、玻璃底色、阴影、缩放、
落地和 regrab 手感。单卡仍走现有 `useObject`/Runtime 单对象路径，不因 Group Session
引入新的单卡分支。列表模式继续使用 compact layout，网格模式保留原有卡片比例和视觉参数。

**动作契约**：单卡继续发出原有 `move` 动作；多选新增批量动作，至少携带：

```ts
{
  type: 'move-group'
  objectIds: string[]
  primaryObjectId: string
  fromSurfaceId: string
  toSurfaceId: string
}
```

`primaryObjectId` 只表示用户实际抓起的主卡，不代表只移动这一项。文件业务层收到列表后
仍分别调用现有的 `moveFilesInto` / `moveFoldersInto`，继续复用乐观更新、回滚、权限和
后端校验。

#### Phase 3 TODO

**A. Runtime Core（`gugu-interaction-runtime`）✅ 已完成（2026-08-11）**

- [x] 定义 `GroupDragSession` 的创建、更新、取消、regrab 和结束状态机；
- [x] 保存 `primaryObjectId`、完整 `objectIds`、来源 Surface 和附属卡相对主卡的初始偏移；
- [x] 为同一 group 获取和释放全部 Object ownership，避免旧实例或单卡 session 抢占；
- [x] 让主卡独占 pointer 跟随、速度采样、物理落点和目标命中；
- [x] 让附属卡共享主卡运动轨迹，并支持主卡/附属卡在 landing、取消和 regrab 中同步；
- [x] 通过 `VisualLifecycleContext.group` 提供主代理 + 附属代理的通用视觉上下文；当前 Demo
      使用单代理叠卡，暂不扩大为多个独立物理代理；
- [x] 增加 `move-group` Action，保证对象顺序稳定且包含主卡 ID、来源和目标 Surface；
- [x] 补充 Group Session、Action、对象卸载、取消和文件系统 Demo 回归测试；

**B. Runtime Demo（先验证通用能力）✅ 已完成（2026-08-11）**

- [x] 以当前 `startMultiPhysicsDrag` 为视觉基线接入 Group Session，不改变主卡、修饰卡的布局、
  阴影、缩放、compact/list 和 landing 参数；
- [x] 验证网格和列表两种布局下主卡均为鼠标实际抓取卡，修饰卡保持后置偏移；
- [x] 验证抛出、回弹、落地、落点命中和落地前 regrab 全部由同一 group 时间线驱动；
- [x] 验证无论选中 2 张还是更多对象，视觉上只展示主卡和 1～2 张修饰卡，但业务对象不丢失；
- [x] 通过 Demo 拖动、取消、跨列移动、快速连续拖动和文件夹落地 E2E 验收。

**C. Gugu-web Vue 接入**

- [x] 更新 `.runtime-version` 并核对 Group Session API；
- [x] 将文件库多选入口从 `useFileDragDrop` 的拖拽生命周期改为 Runtime Group Session；
- [x] 将项目编辑卡多选入口从 `useProjectFileDrag` 的拖拽生命周期改为同一套 Group API；
- [x] 保留选择快照、目标配置和业务批量移动回调，不把文件 API、乐观更新或权限规则放进 Runtime；
- [x] 通过 `useRuntimeAction` 接收 `move-group`，按对象 ID 分流 `moveFilesInto` / `moveFoldersInto`；
- [x] 失败时沿用现有 optimistic mutation 和 rollback，不能重复触发 landing 或重复提交对象。

#### Phase 3 C 执行记录（2026-08-11）

- 文件库网格、列表的文件/文件夹卡已通过 Vue `useObject({ selected })` 声明选中状态；单卡和多卡统一保留 `move` 能力，不再由业务侧按选区切换 pointer 拖拽入口。
- 文件库订阅 `move` 与 `move-group` Action，并按对象 ID 分别复用现有文件/文件夹批量移动函数；Runtime 不持有文件 API、权限或 optimistic mutation。
- 项目编辑卡网格/列表已经移除旧的 `useProjectFileDrag` 卡片 pointerdown 入口；对象的 `selected` 状态与 `move-group` Action 统一由 Runtime 管理，业务侧仍保留原有选择框、工具栏和批量移动函数。
- 项目编辑卡的网格卡、列表行、浏览区 Surface 和面包屑 Target 已改用 `components/common/file-browser` 下的 Vue Runtime 包装组件；ProjectModal 不再手写对象/Surface 注册、generation、延迟注销或 DOM bind。

**D. Gugu-web 验收与清理**

- [x] 文件库网格完成多文件、文件夹和混合选择；文件库/项目文件区列表完成多文件选择；
  回收站完成选择工具栏和空状态冒烟，列表与回收站不启用 Runtime 拖放目标的路径保持不变；
- [x] Runtime Core 测试覆盖无效落点、取消和落地前 regrab；真实账号 E2E 覆盖主卡、修饰卡、
  跨目录移动和面包屑落点。
- [x] 真实账号 E2E 覆盖 API 成功、409、权限拒绝和批量部分失败，确认页面缓存回滚与目标
  目录状态一致。
- [x] 对比单卡路径，确认 Group Session 没有改变单卡动作、视觉和生命周期；文件拖拽 E2E
  当前 10/10 通过，Runtime Core 单测 97/97 通过。
- [x] 删除 `fileDrag.ts` / `useProjectFileDrag.ts` 中仅服务多选拖拽的生命周期代码；
- [x] 清理多选旧路径专用的探针、兼容类型和测试，保留选择、业务移动和上传逻辑；
- [x] 更新 Runtime 接入说明、changelog，并完成提交前 typecheck 与单测。

#### Phase 3D 清理记录（2026-08-11）

- 删除 `interaction/drag/adapters/fileDrag.ts`、`useFileDragDrop.ts` 和
  `useProjectFileDrag.ts`；文件库与项目文件区不再保留旧 pointer/多选生命周期适配器。
- 移除由旧适配器供给的失效 `draggingFileIds`、`draggingFolderIds`、`dragOverFolderId` 和
  `bcDragOverIdx` 页面状态及对应 CSS；Runtime Object/Surface/Target 与 `move`/`move-group`
  Action 继续作为唯一卡片拖动入口，上传区域的原生 `dragging` 状态保留。
- 更新文件拖拽 E2E 的描述，明确单卡和多卡均走 Runtime；未把文件 API、权限、选择框、工具栏
  或 optimistic mutation 搬入 Runtime。
- Runtime 端的 Group Session 与 Gugu-web 端 typecheck、单测已通过；远程 devserver 真实账号
  已通过文件库网格/列表单卡、多选、面包屑落点、项目文件区网格单卡/多选，以及底部卡片抓取
  滚动位置回归。文件库与项目文件区 Runtime 拖拽 E2E 当前 9/9 通过（2026-08-11），其中
  包含 409、403 和批量部分失败的缓存回滚验证。
- 项目文件区列表视图已用真实账号补验：通过与网格相同的 Runtime Object/Surface/Target
  完成多选拖入文件夹，目标显示 2 项且源卡片正确消失；此前脚本失败仅因误用了文件库的
  `.folder-row` 选择器，已改用项目列表的 `.folder-list-row`。
- 文件系统阶段冒烟 E2E 通过 8/8（另 1 条因测试账号没有回收站入口而跳过），覆盖统一
  选择工具栏、连续 Shift 选择、右键文件操作、共享上传入口、回收站面板、项目文件区
  和窄窗口布局。
- 409、权限拒绝和批量部分失败已由真实 Runtime 拖拽 E2E 覆盖；回滚实现仍由业务层的
  optimistic mutation 负责，Runtime 不接管 API、权限或缓存。

**依赖说明**：Runtime 前置工作已经在 `gugu-interaction-runtime` 仓库完成；Gugu-web 接下来只消费
已验证的公共 API，不把文件业务规则搬进 Runtime：

- 已新增 `GroupDragSession`（保留现有 `Session.objectId` 标量字段，主卡兼容既有单对象路径）；
- `GroupDragSession` 保存 `primaryObjectId`、完整 `objectIds` 和各附属卡相对主卡的初始偏移；
- Runtime 通过 `VisualLifecycleContext.group` 支持 1 session : 主代理 + N 个附属对象视觉描述，Demo 默认只展示主卡和 1～2 张后置修饰卡；
- 主代理和附属对象共享同一套跟手、弹簧、落地、取消和 regrab 时间线，不启动多个独立物理 session；
- Runtime Demo 与 Gugu-web 文件库、项目编辑卡已通过 `GroupDragSession`、`MoveGroupAction` 和对应的类型校验；后续只需完成 UI 端到端验收和旧兼容代码清理。

**与其他阶段的关系**：Phase 3 与 Phase 0/1/2/4 没有依赖关系，不阻塞后者合并上线。Phase 0/1/2/4 可以独立推进、独立验收、独立合并；Phase 3（以及依赖它的 Phase 5 多选清理部分）作为单独时间线，在 `gugu-interaction-runtime` 侧的 `GroupDragSession` 发布后再启动，不按线性阶段顺序卡住前面的工作。

完成条件：旧 `useFileDragDrop` 和 `useProjectFileDrag` 已从文件系统入口删除；Runtime demo
与 Gugu 文件库的多选拖拽在视觉上保持主卡 + 后置修饰卡的现有表现，单卡行为不回归。

### Phase 4：目录切换与布局收敛

- 浏览区保持稳定 Surface；
- 目录变化由 Runtime collection FLIP 捕获和播放；
- 上传入口、文件卡和文件夹卡使用同一布局集合；
- 移除业务侧额外的 `Transition mode="out-in"` 对交互节点的销毁影响；
- 验证 landing 进行中切换目录、快速拖动和连续 regrab。

完成条件：目录切换、卡片让位和 landing 不再出现瞬移、旧目标、重复 FLIP 或本体闪现。

### Phase 5：清理旧代码

候选删除内容：

- ~~`frontend/src/interaction/runtime/adapters/file/fileRuntimeAdapter.ts`~~；
- ~~文件页和项目抽屉的 Runtime 注册 watchEffect~~；
- ~~单卡旧 pointer/drop 分流~~；
- 多选迁移完成后删除 `fileDrag.ts` 和 `useProjectFileDrag.ts` 的拖拽职责；
- 仅用于旧路径的测试、README 和兼容类型。

纯 ID 生成函数、业务移动函数、选择逻辑和上传逻辑继续保留。

#### Phase 5 执行记录（2026-08-10）

前三条候选在写这份方案时假设的是"整体迁移旧 `after` 分支的 adapter 代码"，但
Phase 0 已经决定不迁移（"旧的 `codex-filesystem-interaction-runtime-after-cc610ae0`
只作为问题记录和行为参考，不整体迁移代码"）——Phase 1 实际是照 Runtime demo 重新
写的一套全新代码：`fileRuntimeAdapter.ts` 是这次新建的纯 ID 辅助函数文件，不是旧
adapter，本身就是要长期保留的产物；两个入口的 Runtime 注册 `watchEffect` 和单卡
`onFolderPointerDown`/`onFilePointerDown` 分流同理，都是新架构的组成部分，不是待
清理的旧代码。这三条从候选列表划掉。

实际清理动作：删除了 `fileRuntimeAdapter.ts` 里未被任何调用点引用的
`parseFileObjectId`（此前标注"kept for completeness"——按项目约定不为假设的未来
用途保留死代码，直接删除，`vue-tsc --noEmit` 复核无影响）。全仓扫描
`browserSurfaceId`/`folderSurfaceId`/`parseFolderSurfaceId`/`breadcrumbSurfaceId`/
`parseBreadcrumbSurfaceId`/`fileObjectId` 均有实际调用点，未发现其余死代码。

#### Phase 5 当前执行记录（2026-08-11）

- 文件库网格/列表和项目文件区已经移除旧卡片 pointerdown 入口，以及按选区在旧 pointer 拖拽与 Runtime 之间切换的分流代码；选择框、工具栏、上传拖拽和业务移动函数继续保留。
- Phase 3D 已删除旧 `fileDrag.ts`、`useFileDragDrop.ts` 和 `useProjectFileDrag.ts`，并清理仅由这些适配器供给的失效拖拽态；`useProjectFileDragMoves.ts` 等业务移动边界不删除。
- 全仓引用、旧状态字段、临时探针和无效兼容入口已完成审计；仅保留业务移动、选择、上传、
  权限和 optimistic mutation 边界，不保留旧拖拽生命周期代码。
- `file-drag-runtime.spec.ts` 已改为验证 Runtime 单卡/多卡路径；Runtime Core 的无效落点、
  regrab、landing/reveal 幂等和失败清理由核心测试覆盖。
- Phase 5 的清理项已完成；项目文件区列表真实账号验收属于 Phase 3D 的补充测试，不再作为
  旧代码清理阻塞项。

## 7. 暂不做的事情

- 不把文件 API 或 optimistic mutation 放进 Runtime；
- 不为文件单独创建 Runtime 专属动画实现；
- 不同时维护 detach 和 clone 两套文件业务编排；
- 不整体 cherry-pick 旧 after 分支；
- 单卡动画效果以 demo 为准；多选迁移必须遵守 Phase 3 的 `startMultiPhysicsDrag` 视觉兼容约束；
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
