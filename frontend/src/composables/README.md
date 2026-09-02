# Composables 目录规范

本目录存放 Vue 状态、生命周期和异步流程逻辑。组件负责展示与交互编排，composable 负责可复用的状态与行为；请求细节应继续放在 `api/` 或 service，纯函数应放在 `utils/`。

## 目录结构

```text
composables/
├── core/          # 全局基础能力，跨所有页面复用
├── shared/        # 跨页面复用，但不属于全局基础设施
├── files/         # 文件库、项目文件和文件上传相关
├── projects/      # 项目业务相关
├── calendar/      # 日历业务相关
├── schedules/     # 定时任务相关
├── mind/          # 笔记、画布和引用相关
└── onboarding/   # 新手引导相关
```

GuguChat 专属 composable 与组件强绑定时，继续放在 `components/common/gugu-chat/composables/`，不要为了形式统一搬到本目录。页面领域 composable 统一放在本目录对应领域下；只有明确只服务某个组件、且不具备领域复用价值的极小逻辑，才允许与组件共置。

## 归类规则

### `core/`

只放不带具体业务页面语义的基础能力，例如主题、全局提醒、确认弹窗、窗口层级和全局按钮反馈。

要求：

- 不依赖具体页面组件。
- 不读取某个页面的 DOM 或私有状态。
- 不在其中加入 Projects、Mind、Calendar 等业务判断。

### `shared/`

放两个及以上业务域确实复用的能力，例如缩略图缓存、通用排序、框选和上传队列。

如果一个 composable 只有一个页面使用，即使未来可能复用，也先放对应业务域，不提前放进 `shared/`。

### 业务目录

按业务域归类，而不是按单个 Vue 文件归类：

- `mind/`：笔记、画布、引用编辑和 Mind 对象选择。
- `projects/`：项目草稿、阶段、待办和项目弹窗流程。
- `files/`：文件库、项目文件、上传、删除、重命名和文件导航。
- `calendar/`：日历数据、事件编辑和日历拖拽。
- `schedules/`：定时任务加载、编辑和删除。
- `onboarding/`：引导状态、引导种子数据和引导流程。

一个 composable 被 GuguChat 和 Mind 同时使用时，应按能力归属放在 `mind/` 或 `shared/`，不能复制出两份。

## 命名与依赖方向

- 文件使用 `useXxx.ts` 命名；类型和纯计算可以使用领域名或明确的动词名。
- composable 不导入页面入口，不导入具体页面组件。
- 业务 composable 可以依赖 `core/`、`shared/`、对应 API/service 和 utils。
- `core/` 不得反向依赖业务目录。
- 领域之间需要共享行为时，优先提取到 `shared/`，不要互相深度引用。
- 不因为移动文件而保留重复 wrapper；迁移完成后统一 import 路径。

推荐依赖方向：

```text
views/components
        ↓
业务 composables
        ↓
shared composables / core composables
        ↓
api / services / utils
```

## 状态与副作用

- 页面状态由页面或页面领域 composable 持有，不在 `core/` 中隐式创建业务全局状态。
- 异步请求必须有加载、成功、失败和取消/卸载边界。
- 删除、重置、覆盖和停用等危险操作必须复用 `useConfirmDialog`。
- 组件卸载后不要依赖 `emit()` 完成异步收尾；需要收尾时传入函数引用或使用明确的生命周期清理。
- 不在 composable 中写可见原始日志；诊断数据遵循现有脱敏规范。

## 测试与迁移

- 复杂状态机、竞态、缓存和异步流程优先为 composable 添加同目录测试或对应领域测试。
- 移动文件时必须同步更新所有 import、测试引用和文档，不保留长期兼容转发文件。
- 迁移前先确认实际调用方；跨领域调用是保留在 `shared/` 的依据。
- 整理目录不改变运行时行为。完成后至少运行前端 typecheck 和受影响测试。
