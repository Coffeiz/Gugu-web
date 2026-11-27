# Agent 工具开发规范

本目录对应旧 Python `agent/tools/`，只承载工具定义、输入契约和执行适配。按领域组织工具组，不按单个工具名称持续新增模块。注册表和 Schema 存在不代表业务或生产接入完成。

## 工具组

| 工具组 | 契约与字段 |
| --- | --- |
| 日历 | [calendar](./calendar/README.md) |
| 画布 | [canvas](./canvas/README.md) |
| 联系人 | [clients](./clients/README.md) |
| 历史对话 | [conversations](./conversations/README.md) |
| 邮件 | [email](./email/README.md) |
| 文件与附件 | [files](./files/README.md) |
| 站内搜索 | [global-search](./global-search/README.md) |
| 即时通讯 | [im](./im/README.md) |
| 知识 | [knowledge](./knowledge/README.md) |
| MCP 管理 | [mcp-management](./mcp-management/README.md) |
| 记忆 | [memory](./memory/README.md) |
| 元工具 | [meta](./meta/README.md) |
| 笔记 | [note](./note/README.md) |
| 总览 | [overview](./overview/README.md) |
| 项目 | [projects](./projects/README.md) |
| 定时任务 | [scheduled-tasks](./scheduled-tasks/README.md) |
| 联网搜索 | [search](./search/README.md) |
| Shell | [shell](./shell/README.md) |
| 技能管理 | [skill-management](./skill-management/README.md) |
| 子 Agent | [subagent](./subagent/README.md) |
| 时间 | [time](./time/README.md) |
| 撤销 | [undo](./undo/README.md) |
| 网页读取与下载 | [web](./web/README.md) |
| 工作区 | [workspaces](./workspaces/README.md) |

每组以 `index.ts` 为入口。小组可直接定义工具，涉及独立端口、事务或共享解析时再拆文件。每组 README 记录工具名、输入字段、返回形状、授权、确认、宿主依赖和失败语义。以注册器暴露的 Schema 和实际校验为准。

磁盘回收站由 Web Host 注入，包含 `list_trash`、`delete_item`、`restore_file`、`restore_folder` 和 `permanent_delete`，见 [回收站工具定义](../../../../../apps/web-host/src/modules/agent/tools/trash/disk.ts)。

## 注册与配置

`contracts.ts` 定义 `ToolDefinition`、`ToolGroupDefinition` 和可信调用范围；`registry.ts` 提供 `registerGroup`、`register`、`configure`，并实现现有运行循环的 `ToolPort.plan/dispatch/reconcile`。Host 工厂按 `clients`、`projects`、`overview` 等领域调用组注册，调用方可用 `configure({ groups: { overview: false } })` 禁用整组，也可单独禁用工具。

`registry.ts`、`confirmation.ts` 处理权限投影与确认绑定；`definition-schema.ts`、`normalize-input.ts`、`input-errors.ts`、`meta/search-tools.ts` 以及日期辅助处理共用输入契约。这些是基础设施，不包含领域查询。公共出口为 `index.ts`，不保留旧文件路径的转发层。

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
