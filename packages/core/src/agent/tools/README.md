# Agent 工具开发规范

本目录对应旧 Python `agent/tools/`，只承载工具定义、输入契约和执行适配。按领域组织工具组，不按单个工具名称持续新增模块。注册表和 Schema 存在不代表业务或生产接入完成。

## 领域模块

| 模块 | 职责 |
| --- | --- |
| `projects.ts`、`projects/` | 项目查询、创建和修改工具集中定义；目录仅放创建/修改端口与共享目标解析；阶段和待办工具同属此组，共用CAS/Undo/持久收据。 |
| `clients.ts` | 联系人领域工具。 |
| `conversations.ts` | 历史对话工具组；正文由 owner 限定读取服务提供，搜索依赖可信 RAG 与会话定位端口。 |
| `knowledge.ts` | 知识读取工具组；ID 精确读取由 Host owner FS 端口提供，关键词查询只接受 Host 授权范围并查询持久 BM25 索引。 |
| `files.ts` | 文件读取、附件保存与列表、网页预览及文件和文件夹软删除。按 owner 文件 ID、已登记逻辑路径或附件 ID 限定访问。正文读取保留单项与批次上限，文档正文复用 Core 受限提取器。通用文件操作由已授权的 Shell 提供。 |
| `canvas.ts` | 画布工具组；列表、分页快照、已有节点/可放置资源搜索、卡片定位、创建/引用放置、有序批处理、确认后画布/便签/关系删除、连接/端点及布局/视图移除/便签正文编辑；计数/视图/独立关系审计委托共享Mind读取，不在读取时改线。 |
| `note.ts` | Mind笔记搜索、详情、软删、恢复与撤销工具组；来源节点、一跳关系和正文引用由共享Mind读取聚合。 |
| `calendar.ts` | 日历工具组，活动和提醒聚合委托共享日历服务；事件删除复用共享软删/Undo事务及可信确认门。 |
| `workspaces.ts` | 工作区声明查询/创建/更新、解绑及顶层目录删除工具组；创建复用 Host 的项目/文件夹声明和顶层目录服务（Agent 创建收据待补），更新借用同一事务完成显示名同步、完整owner结果与持久调用收据，不改变物理目录段；解绑保留父资源，顶层目录删除绑定全量影响快照、持久确认与删除结果收据。 |
| `undo.ts` | 撤销工具组；目标由 Host 按可信 `agent:{sessionId}:{runId}` 上下文选择，模型不能提交 operation ID；Host 固定目标并写持久选择/结果收据，恢复时只对同一操作调用现有 Node Undo 状态机。 |
| `overview.ts` | 近期待办、总览等跨领域只读聚合。 |
| `trash.ts` | 回收站查询、恢复和 `permanent_delete` 工具组；全清必须由用户确认，Host 按 owner 复核快照并创建持久 purge job，Node Worker 分批执行。 |
| `scheduled-tasks.ts` | 定时任务领域工具；群任务的 `group_context_search` 与 `search_memory` 由相邻调度装配按当前任务和已绑定群范围启用，私有记忆及跨群检索不向无当前 IM 发送者的后台 Run 开放。 |
| `global-search.ts` | 站内全局搜索工具组，委托共享搜索服务。 |
| `search.ts` | 外部搜索工具组。原生搜索使用可信模型绑定的厂商 Schema，深度研究及相似图依赖 Host 提供配置、用量及资源读取能力。 |
| `web.ts` | 公网正文读取与文件下载。省略落点时使用可信会话绑定或用户默认工作区，显式目标按文件库归属校验。Host 在打开公网流之前验证落点和容量，在导入事务中复核。 |
| `time.ts` | 时间工具组及共用可信时钟投影。 |
| `skill-management.ts` | 技能管理工具组。列表包含停用项，正文由独立加载链读取。创建和更新复用共享管理器，在当前 Run 的持久收据事务中校验授权。删除需要可信持久确认。 |
| `mcp-management.ts` | MCP 配置安全投影、连接检测、带持久收据的启停与更新，以及持久确认创建和删除。新增或更新 Header 凭据槽位时，Host 在同一事务建立私密表单意图。确认后清空槽位会清除已保存凭据。 |
| `link-buttons.ts` | 链接按钮校验、Web artifact 及 IM 持久投递收据；生产 Host 和具体渠道能力须显式装配。 |
| `meta.ts` | Skill正文加载、当前授权工具Schema发现及普通澄清交互；`ask_user` 只公布 Node 已实现的 choice/question，沙箱授权走可信 Host 端口；不实现通用表单、Skill持久化管理或第二套执行器。 |

迁移日历、笔记、画布、知识、记忆、工作区等工具时，对应建立一个领域模块；同组的定义和执行适配放在该模块。领域内部只有独立资源边界、事务/生命周期或多个调用方共用的稳定逻辑才拆辅助文件。未实现的领域不建立空模块占位。

## 注册与配置

`contracts.ts` 定义 `ToolDefinition`、`ToolGroupDefinition` 和可信调用范围；`registry.ts` 提供 `registerGroup`、`register`、`configure`，并实现现有运行循环的 `ToolPort.plan/dispatch/reconcile`。Host 工厂按 `clients`、`projects`、`overview` 等领域调用组注册，调用方可用 `configure({ groups: { overview: false } })` 禁用整组，也可单独禁用工具。

`permissions.ts`、`confirmation.ts` 处理权限投影与确认绑定；`definition-schema.ts`、`normalize-input.ts`、`input-errors.ts`、`search-tools.ts` 以及日期辅助处理共用输入契约。这些是基础设施，不包含领域查询。公共出口为 `index.ts`，不保留旧文件路径的转发层。

工具组对应 Python `BaseSkill` 的领域注册概念，和 `agent/skills/` 中按需加载 Markdown 正文的 Prompt Skill 相互独立。正文、description、前端参数不能建立权限。

## 执行边界

1. Schema 描述模型可见参数；注册期固定定义，dispatch 使用统一归一化与校验，再调用领域处理器。参数默认值、非法输入和结果结构由 Node 2.0 契约定义，不引入 Python 兼容执行路径。
2. owner、session、调用坐标、时区、平台能力、凭据及授权根来自可信 Host；发现和每次执行重新检查权限。缺领域服务或后端时不注册，缺子能力时明确不可用，不返回假空结果。
3. 业务读写复用共享领域服务或真实执行端口。文件复用授权和 `packages/fs`，执行复用 `packages/sandbox`；不在工具中复制数据库业务或回退到任意宿主执行。
4. `effect: 'write'` 不是危险确认。destructive 工具需精确目标、持久可信确认与现有执行链；当前注册器会拒绝未闭合的 destructive 工具。提交未知返回 `unknown`，不得伪装普通失败或自动重发。
5. 项目修改使用 `projects/mutation-port.ts` 的持久收据适配；同事务定位/CAS/Undo，恢复仅查收据。仅apply桥接是测试/底层原型，Host不得据此开放。目录与SQL跨存储未知状态保留unknown，由Host恢复，不自动重放。
6. 只读查询响应取消，等待底层释放资源后再结束；不让取消后的结果进入模型上下文。可见错误脱敏，不记录用户正文、原始异常或凭据。

## 回归与完成标准

测试放在 `packages/core/tests/agent/tools/` 并登记 suites 与测试元数据。优先经过真实注册器、领域服务和临时数据库，验证 owner、参数、结果、错误、副作用、取消、并发和确认边界；关键切片再经过 Agent 续轮验证模型接收的结果。Host 测试覆盖能力缺失、发现后撤权和真实装配边界。

以 Node 2.0 契约和 Node 行为回归作为交付标准；旧 Python 行为只用于识别需保留的业务语义与安全边界，不是运行、构建或验收依赖。测试替身和真实后端分别记录；工厂可调用、行为通过、实际生产 Run 接入是不同状态。未验收真实后端或生产装配时不计“已完成并接入”。

画布创建复用共享Mind服务，画布/Undo/调用收据共用事务；`canvasCreation`、`canvasPlaceableSearch`和`skillMetadata`由可信Host分别注入，缺后端不开放。提交未知只查收据；事件当前best-effort，不把通知当提交证明。

`canvasEdits`复用Mind批量用例，后项失败或取消整批回滚；布局和移除保留节点正文，正文编辑只允许canvas_note。调用收据与修改/Undo同事务，恢复只查收据。旧Agent允许操作仍存活但节点已有墓碑的条目，此能力由可信适配显式开启，普通Web查询不据此放宽。

`canvasBatch`复用同一事务中的Mind编辑用例，最多20项，按request_id绑定owner/画布收据；delete_note由Core先解析固定便签/视图集合与版本摘要再进入持久确认，并在业务事务内claim。Host未注入真实gate/claim时不注册；当前 Core 行为测试使用合成 gate，只证明适配边界，不代表生产确认接入或完整 Node 生产验收。

新增便签/引用放置由`canvasPlacements`显式启用；连接和端点由`canvasRelations`启用。原`canvasEdits`不自动扩大能力。放置复用Mind共享世界坐标用例，非法坐标不回落；连接复用同一几何端点规则，显式自定义端点须声明，不能按节点ID猜左右。

普通note生命周期由可信`noteLifecycle`能力启用，复用共享CAS、Undo和持久收据；`note_undo`按创建时间/ID选择最近gugu记录，同调用恢复只查原收据，不能重选下一条。画布便签不走此组删除/恢复，永久删除仍需独立危险确认链。
