# Node Agent 工具行为迁移清单

盘点日期：2026-11-16。此清单是当前工作树源码盘点，未运行的测试不记为通过；并行会话的未提交文件也不视为发布或生产接入证据。

## 状态口径

- **已完成并接入**：完整工具经过真实 Harness → ToolPort → 业务实现/Executor，已被实际生产Host Run装配，并有对应Python、Node行为及后端验收；明确列出仍使用的替身。
- **已实现待接入**：有可调用实现或独立注册表，但缺实际 Host 调用方或完整行为验收。
- **可迁移**：依赖已存在，尚未实现工具切片；属于未完成项。
- **依赖阻塞**：共享服务、可信能力或领域适配/回归尚未就绪；HTTP API 存在不等于工具可直接迁移。
- **退役/重设计**：架构明确退出旧实现，保留数据迁移与恢复责任。

当前 AST 盘点：`backend/agent/tools/` 有 26 个直接继承 `BaseSkill` 的工具组和 109 个静态 `Tool(...)` 声明。此数字不包含动态 MCP 工具，也不是 pytest 数量。全 `apps/web-host/src` 查找未发现 `createAgentToolRegistry` 生产调用，不能据 Core 实现或工厂注册认定生产接入。

## 当前交付状态摘要

本表按**完整工具及实际生产Run装配**计数，不将Core合成Harness、注册器工厂或部分端口记为生产完成。当前109个静态工具：**已完成并接入0、已实现待接入49、部分实现5、依赖共享能力或平台54、退役/重设计1**。动态MCP另计；部分实现的工具同样仍有依赖阻塞，不重复计数。

| 状态 | 工具/范围 | 当前证据与缺口 |
| --- | --- | --- |
| 已实现待接入（49） | list_clients、create_client、update_client、list_projects、get_project、create_project、get_current_time、use_skill、list_scheduled_tasks、global_search、get_upcoming、list_trash、restore_file、restore_folder、read_conversation、search_memory、list_events、list_workspaces、get_workspace、get_dashboard_stats、update_project、set_color、archive_project、add_stage、remove_stage、rename_stage、set_stages、update_stage、note_search、note_get、get_tool_schema、update_workspace、canvas_list、canvas_get、canvas_search、canvas_focus_node、canvas_search_placeable、canvas_create、list_skills、canvas_update_node、canvas_remove_node、canvas_update_note、canvas_create_note、canvas_add_node、canvas_update_anchor、canvas_connect、note_delete、note_restore、note_undo | Core真实调用及行为回归已列；Node生产main尚未装配Agent runtime/registry，Skill可信loader/资源source与部分领域Host链仍缺验收。此状态不保证全部后端已经具备。 |
| 部分实现（5） | read_file、ask_user、search_conversations、http_get、canvas_batch | read_file 仅文本file_id子集；ask_user 的表单、沙盒授权与生产Host待接入；历史搜索已有 owner 限定的 TypeScript RAG/Jieba BM25 事实表适配器和 Web RAG 成组端口组合器，按 Python 行为覆盖 baseline 前仍保留的消息；真实生产 Agent Run 装配和 PostgreSQL 验收未完成；http_get 已有 Core 参数/批量/结果契约和条件注册，公网安全传输端口、HTML/PDF提取、headers安全与脱敏以及生产Run装配未完成；`canvas_batch` Core工具端口、SQLite行为回归已实现，但旧Python parity与生产Host持久确认接线未验收。 |
| 依赖共享能力或平台（55） | 见逐工具清单 | 依赖共享领域/文件/历史/渠道/MCP/RAG/确认与实际执行后端；对应能力由A/B或可信平台Host提供，不注册假成功工具。 |
| 退役/重设计（1） | shell | 工具用途保留；Docker生命周期实现退役，Linux MXC多用户隔离及真实平台后端未验收，当前不开放。 |

真实调用方复核：`main.ts`未装配Agent chat/runtime/reconstructor，`createAgentToolRegistry`只有工厂与测试引用，已由聊天会话再次确认；技能生产source同样未接入。上述判断与本文件后续历史分阶段测试记录分别看待；旧记录中的“Core完成/已接入Harness”只描述当时测试层级，不能覆盖当前生产状态。

### 三个只读工具的 Host Runtime 组合验收（2026-11-14）

`list_clients`、`list_projects`、`get_current_time` 已在独立测试中经过实际 `createAgentRuntime` → Host 工具注册器 → Core 仓储/隔离 PostgreSQL，并验证三个实际工具结果进入下一次 Provider 请求。双 owner 数据互不泄漏，模型传入的时区不能覆盖可信 Host 时区；发现后撤权和非法项目状态被拒绝，数据库前后保持不变。该测试使用合成 Provider transport、内存 RunStore/lease、授权与上下文替身；并未装配生产 main/Run 或验证真实 Redis、外部模型，因此三项仍为已实现待接入。

隔离 PG 回归 1/1、Python 时间/工具隔离/项目基准 59/59 通过，均 0 失败/跳过；Host 类型与 diff 检查通过，临时 PG 已停止清理。首跑失败是测试将合法的单个 ephemeral text 内容块误判为必须是字符串；修正后仍从实际续轮正文验证全部业务结果，最终重跑通过。没有修改生产 Runtime、Host 装配、共享业务或 Python 参考源码。

### get_project 真实文件概览端口（2026-11-14）

新增 Host 薄端口 `project-file-overview-port.ts`：接受可信 RunIdentity、已按owner解析的项目ID和取消信号，委托现有 `readProjectFileOverview`；查询前与查询结束后检查取消，不中断进行中的PG SQL。B负责后续将此端口注入生产Run工厂，本次没有修改main或生产装配，因此get_project仍是已实现待接入。

Node隔离PG 1/1通过，经过真实Host工具注册器→Core项目查询→Host实际计数SQL，保护owner/软删过滤、根目录和嵌套文件计数、权限撤销、缺表安全错误、真实锁等待取消后清理与连接复用；授权服务为测试替身，项目创建runtime是真实适配但本测试不调用。Python `tests/projects/test_project_agent_context.py` 7/7通过，覆盖项目详情及实时文件概览；两组均0失败/跳过。临时PG实例和schema已清理，未验收真实用户库/Redis或生产Agent Run。Host全量类型检查首次在并行调度目录迁移与Admin接线期间失败；路径与Admin接线完成后复验通过，原始失败保留记录。diff检查通过。

## 共同基准与接线责任

Python `tools/__init__.py` 导入各 `BaseSkill`，模块末尾调用 `.register()`；`Tool.input_schema` 与 metadata 是注册来源。`SkillRegistry.dispatch()` 先解析工具和 IM 权限/快照，处理显式兼容，再由 `normalize_and_validate_tool_input()` 校验顶层 object、类型与动作分支，之后才建立数据库会话/调用 handler。结果为模型 JSON 与可选 `_artifact` 分离；错误脱敏、确认载荷归一，并补 `tool/usage_hint/next_action`；非法参数使用 `tool_input_invalid/issues`。写入标记 `mutates` 和危险确认 `destructive/requires_confirmation` 不可混为一谈。批量危险操作必须绑定精确目标集合。

Node 保持现有 `Harness ToolPort.plan/dispatch/reconcile` 和 Executor 边界：身份来自可信 RunIdentity，逐调用重查授权，模型输入不能建立授权根、凭据、Host 能力或确认收据。写入提交未知必须返回 `unknown`、不可自动重放；原始异常、聊天正文和凭据不得进入可见错误。Node Host 初始三个工具注册表使用 Zod，但没有完整复刻 Python 全局错误增强/宽容适配，因此不能笼统声称错误结构等价；后续Core错误增强的实际覆盖见分阶段验收记录。

`packages/fs` 提供授权根内普通文件读取与暂存操作，拒绝路径越界/符号链接；并不提供 Agent 的 owner/session 文件定位、解析媒体、结果/附件投影或全部写操作。`packages/sandbox` 已有请求/授权策略、能力拒绝、MXC 注入、取消/输出限制；Core executor 为兼容入口，不能绕过它启动宿主 Shell。原生 spawn 由 Host 注入；Linux 多用户隔离尚未验收，Shell 不开放为已完成工具。

## 逐工具盘点

“必填”仅列顶层声明；`无` 不表示任何参数都合法，互斥/单批/action 条件仍以对应 Python `input_schema` 为准。“确认”仅记录静态 `Tool` 声明，否不代表任意输入无需业务级确认。每组的实际依赖与回归见后表。

| Python 文件（相对 backend/agent/tools） | 工具 | 顶层必填 | 静态确认声明 | 当前状态 |
| --- | --- | --- | --- | --- |
| `calendar.py` | `create_event` | title, date, all_day | 否 | 依赖阻塞 |
| `calendar.py` | `list_events` | 无 | 否 | 已实现待接入 |
| `calendar.py` | `update_event` | 无 | 否 | 依赖阻塞 |
| `calendar.py` | `delete_event` | 无 | 是 | 依赖阻塞 |
| `canvas.py` | `canvas_list` | 无 | 否 | 已实现待接入 |
| `canvas.py` | `canvas_get` | canvas_id | 否 | 已实现待接入 |
| `canvas.py` | `canvas_search` | canvas_id | 否 | 已实现待接入 |
| `canvas.py` | `canvas_focus_node` | canvas_id, item_id | 否 | 已实现待接入 |
| `canvas.py` | `canvas_search_placeable` | 无 | 否 | 已实现待接入 |
| `canvas.py` | `canvas_create` | title | 否 | 已实现待接入 |
| `canvas.py` | `canvas_delete` | 无 | 是 | 依赖阻塞 |
| `canvas.py` | `canvas_create_note` | canvas_id | 否 | 已实现待接入 |
| `canvas.py` | `canvas_add_node` | canvas_id | 否 | 已实现待接入 |
| `canvas.py` | `canvas_update_node` | 见源 Schema | 否 | 已实现待接入 |
| `canvas.py` | `canvas_remove_node` | canvas_id | 否 | 已实现待接入 |
| `canvas.py` | `canvas_update_note` | 无 | 否 | 已实现待接入 |
| `canvas.py` | `canvas_delete_note` | 无 | 是 | 依赖阻塞 |
| `canvas.py` | `canvas_connect` | canvas_id, source_node_id, target_node_id | 否 | 已实现待接入 |
| `canvas.py` | `canvas_update_anchor` | canvas_id, relation_id, source_side, target_side | 否 | 已实现待接入 |
| `canvas.py` | `canvas_disconnect` | canvas_id | 是 | 依赖阻塞 |
| `canvas.py` | `canvas_batch` | canvas_id, request_id, operations | 是 | 部分实现（Core端口和Node回归通过；Python parity/生产Host确认待验收） |

| `clients.py` | `list_clients` | 无 | 否 | 已实现待接入 |
| `clients.py` | `create_client` | client_name | 否 | 已实现待接入 |
| `clients.py` | `update_client` | 无 | 否 | 已实现待接入 |
| `clients.py` | `delete_client` | 无 | 是 | 依赖阻塞 |
| `conversations.py` | `search_conversations` | 无 | 否 | 部分实现（真实 TypeScript RAG/Jieba BM25 事实表适配器与 Web RAG 组合端口已实现；Host 会话/记忆/Run 绑定回归 12/12、旧 Python 搜索工具/迁移 pytest 10/10、RAG Cython/golden pytest 31/31；使用隔离 SQLite/临时 FS 与合成授权、snapshot、embedding；生产 Agent Run 装配与 PostgreSQL 验收待完成） |
| `conversations.py` | `read_conversation` | session_id | 否 | 已实现待接入（PostgreSQL/SQLite 共用 owner 限定正文读取；生产 Host 待装配） |
| `conversations.py` | `bind_web_session` | session_id | 否 | 依赖阻塞 |
| `email.py` | `send_email` | subject, body | 是 | 依赖阻塞 |
| `files/file_tools.py` | `list_dir` | 无 | 否 | 依赖阻塞 |
| `files/file_tools.py` | `read_file` | 无 | 否 | 部分实现（仅file_id文本子集，真实权限定位及其他类型待接入） |
| `files/file_tools.py` | `grep` | query | 否 | 依赖阻塞 |
| `files/file_tools.py` | `edit_file` | 无 | 否 | 依赖阻塞 |
| `files/file_tools.py` | `create_file` | files | 否 | 依赖阻塞 |
| `files/file_tools.py` | `rename_file` | 无 | 否 | 依赖阻塞 |
| `files/file_tools.py` | `copy_file` | 无 | 否 | 依赖阻塞 |
| `files/file_tools.py` | `delete_file` | 无 | 否 | 依赖阻塞 |
| `files/folder_tools.py` | `move_items` | target | 否 | 依赖阻塞 |
| `files/folder_tools.py` | `create_folder` | folder_name | 否 | 依赖阻塞 |
| `files/folder_tools.py` | `rename_folder` | new_folder_name | 否 | 依赖阻塞 |
| `files/folder_tools.py` | `delete_folder` | 无 | 否 | 依赖阻塞 |
| `files/transfer_tools.py` | `compress_files` | entries | 否 | 依赖阻塞 |
| `files/transfer_tools.py` | `extract_files` | file_id | 否 | 依赖阻塞 |
| `files/transfer_tools.py` | `send_file` | 无 | 否 | 依赖阻塞 |
| `files/transfer_tools.py` | `present_file` | 无 | 否 | 依赖阻塞 |
| `files/transfer_tools.py` | `list_recent_attachments` | 无 | 否 | 依赖阻塞 |
| `files/transfer_tools.py` | `save_uploaded_file` | 无 | 否 | 依赖阻塞 |
| `global_search.py` | `global_search` | 无 | 否 | 已实现待接入（Host 显式注入共享搜索来源，缺来源明确不可用） |
| `group_context.py` | `group_context_search` | 无 | 否 | 依赖阻塞 |
| `im.py` | `react` | mood | 否 | 依赖阻塞 |
| `knowledge.py` | `read_knowledge` | 无 | 否 | 依赖阻塞 |
| `knowledge.py` | `save_knowledge` | title, content | 否 | 依赖阻塞 |
| `knowledge.py` | `update_knowledge` | knowledge_id | 否 | 依赖阻塞 |
| `knowledge.py` | `delete_knowledge` | knowledge_id | 是 | 依赖阻塞 |
| `link_buttons.py` | `send_link_buttons` | message, buttons | 否 | 依赖阻塞 |
| `mcp.py` | `manage_mcp_servers` | action | 是 | 依赖阻塞 |
| `memory.py` | `remember` | 无 | 否 | 依赖阻塞 |
| `memory.py` | `search_memory` | query | 否 | 已实现待接入（Core 查询、Web owner/可信 IM scope resolver 和真实 dispatch 已实现；生产 Run/可信 IM context 未接） |
| `meta.py` | `call_tool` | tool_name, arguments | 否 | 依赖阻塞 |
| `meta.py` | `get_tool_schema` | tools | 否 | 已实现待接入 |
| `meta.py` | `use_skill` | id | 否 | 已实现待接入（可信技能loader与资源未装配） |
| `meta.py` | `ask_user` | kind, title, body | 否 | 部分实现（普通问题已接入注册器与交互协调器；表单、沙盒授权和生产 Host 装配待完成） |
| `note.py` | `note_search` | 无 | 否 | 已实现待接入 |
| `note.py` | `note_get` | node_id | 否 | 已实现待接入 |
| `note.py` | `note_create` | 无 | 否 | 依赖阻塞 |
| `note.py` | `note_update` | node_id | 否 | 依赖阻塞 |
| `note.py` | `note_delete` | node_id | 否 | 已实现待接入 |
| `note.py` | `note_restore` | node_id | 否 | 已实现待接入 |
| `note.py` | `note_undo` | 无 | 否 | 已实现待接入 |
| `overview.py` | `get_upcoming` | 无 | 否 | 已实现待接入（共享项目/日历读取与可信时钟） |
| `overview.py` | `get_dashboard_stats` | 无 | 否 | 已实现待接入 |
| `projects.py` | `list_projects` | 无 | 否 | 已实现待接入（Core Harness 已测） |
| `projects.py` | `update_project` | 无 | 否 | 已实现待接入 |
| `projects.py` | `create_project` | project_name, start_date, deadline | 否 | 已实现待接入 |
| `projects.py` | `set_color` | color | 否 | 已实现待接入 |
| `projects.py` | `archive_project` | 无 | 否 | 已实现待接入 |
| `projects.py` | `delete_project` | 无 | 是 | 依赖阻塞 |
| `projects.py` | `get_project` | 无 | 否 | 已实现待接入（独立Host与真实PG概览链已测，生产Run待装配） |
| `projects.py` | `add_stage` | label | 否 | 已实现待接入 |
| `projects.py` | `remove_stage` | stage | 否 | 已实现待接入 |
| `projects.py` | `rename_stage` | stage, new_label | 否 | 已实现待接入 |
| `projects.py` | `update_stage` | 无 | 否 | 已实现待接入 |
| `projects.py` | `set_stages` | stages | 否 | 已实现待接入 |
| `scheduled_tasks.py` | `list_scheduled_tasks` | 无 | 否 | 已实现待接入（共享只读查询及独立Host Runtime已测，可信平台能力和生产Run待装配） |
| `scheduled_tasks.py` | `create_scheduled_task` | schedule_name, instruction, schedule_kind | 是 | 依赖阻塞 |
| `scheduled_tasks.py` | `update_scheduled_task` | 无 | 是 | 依赖阻塞 |
| `scheduled_tasks.py` | `delete_scheduled_task` | 无 | 是 | 依赖阻塞 |
| `search.py` | `web_search` | 无 | 否 | 依赖阻塞 |
| `search.py` | `similar_image_search` | 无 | 否 | 依赖阻塞 |
| `search.py` | `deep_research` | query | 否 | 依赖阻塞 |
| `shell.py` | `shell` | command | 是 | 退役/重设计（工具保留，真实隔离后端待验收） |
| `skill_management.py` | `list_skills` | 无 | 否 | 已实现待接入 |
| `skill_management.py` | `create_skill` | skill_name, description_short, body, related_tools, managed_by | 否 | 依赖阻塞 |
| `skill_management.py` | `update_skill` | id | 否 | 依赖阻塞 |
| `skill_management.py` | `delete_skill` | id | 是 | 依赖阻塞 |
| `time.py` | `get_current_time` | 无 | 否 | 已实现待接入（Core Harness 已测） |
| `trash.py` | `list_trash` | 无 | 否 | 已实现待接入（共享回收站只读PG后端） |
| `trash.py` | `restore_file` | file_id | 否 | 已实现待接入（共享 Host 恢复服务与持久调用收据） |
| `trash.py` | `restore_folder` | folder_id | 否 | 已实现待接入（共享 Host 恢复服务与持久调用收据） |
| `trash.py` | `permanent_delete` | 无 | 是 | 依赖阻塞 |
| `undo.py` | `undo_last_action` | 无 | 否 | 依赖阻塞 |

### 日历与画布七项待迁移工具复核（2026-11-17）

本次 Goal 只处理以下七项；`canvas_delete_note`、`canvas_disconnect` 与 `canvas_delete` 已新增 Core ToolDefinition 和可选 Host registry 端口，但没有生产确认接线，不能将共享实现或合成回归计为生产迁移完成：

| 工具 | Python 行为基准 | Node 现有实现与具体缺口 | 状态 |
| --- | --- | --- | --- |
| `create_event` | `backend/tests/scheduling/calendar/test_calendar_tools.py::test_create_event_shapes_and_inline_reminders`、`backend/tests/api/test_create_idempotency.py` | `packages/core/src/agent/tools/calendar.ts` 注册 Core 创建端口；`event-create.ts`、`create-store.ts` 同事务保存事件、提醒、RAG job、Undo 和调用收据。可信 Host 注入提醒渠道/目标解析，按旧工具保留 `all_day` 归一、提醒顺序与结果形状，并用 session 作为 Undo 上下文。SQLite ToolRegistry dispatch 覆盖全天/定时、提醒/群目标、过去提醒拒绝、项目缺失错误、owner 授权、取消和同调用重放。devserver `calendar-create.test.ts` 3/3、Host registry 24/24；Core build/typecheck 通过。旧 Python pytest 未运行；生产 Host 未装配日历写端口，Agent Run 未接工具派发。 | Core/Node实现与回归通过；Host生产接线及Python parity待验收 |
| `update_event` | `backend/tests/scheduling/calendar/test_calendar_tools.py::test_update_event_validations_and_apply`、`backend/tests/scheduling/events/test_event_atomic_update.py`、`backend/tests/scheduling/events/test_event_update_reminders.py` | `packages/core/src/agent/tools/calendar.ts` 提供 ID/标题/日期定位、无字段与 `all_day` 校验、可信 owner 目标解析、当前版本 CAS、幂等收据和结果映射；`event-update.ts`、`mutation-store.ts` 复用同事务事件更新、提醒自动改期/整体替换、Undo、RAG job 与提交后通知。Node 行为回归覆盖标题候选、提醒 ID 保留/新建/清空、缺项目/过去时间拒绝、过期版本冲突、撤权、回滚和重放。devserver `calendar-update.test.ts` 3/3、跨 SQLite/PostgreSQL 的 `mutation-store.test.ts` SQLite 用例 2/2；Core build/typecheck 通过，Host registry 25/25。Python pytest 未运行；生产 Host 尚未注入日历读写与提醒目标解析，Agent Run 未消费注册器。 | Core/Node实现与回归通过；Host生产接线及Python parity待验收 |
| `delete_event` | `backend/tests/scheduling/calendar/test_calendar_tools.py::test_delete_event_single_blocked_then_confirmed`、`test_delete_event_batch_validation_and_confirmed`、`backend/tests/agent/test_agent_delete_undo.py` | `packages/core/src/agent/tools/calendar.ts` 提供事件 ID/标题/日期解析、目标快照确认与收据重放；`event-delete.ts` 复用软删服务，最多 50 项单事务、单条聚合 Undo、提醒停用与提交后通知。Host registry 只在可信确认 gate 和事务内 claim 同时注入时注册。devserver Core 删除行为回归 4/4、Core build/typecheck 通过，Host registry 23/23；Python pytest 未运行，生产 Agent Run 未装配。 | Core/Node 实现与定向回归通过；Python parity 及生产确认/Run 接入待验收 |
| `canvas_delete` | `backend/tests/mind/test_mind_canvas_gaps.py::test_canvas_delete_batch_and_single_with_confirmation` | 新增 `createCanvasDeletePort/Tool`，复用 Mind 级联删除服务，支持单项与最多 20 项批量；owner 过滤、级联目标/版本快照、可信确认、事务内 claim、同事务调用收据和批量回滚，单项/批量结果形状按 Python。Agent 旧实现不记录 Undo，迁移同样不额外创建 Undo。Core `canvas-edits.test.ts`/`confirmation.test.ts` 37/37、Host registry 22/22 通过；Python pytest 未运行，生产 Host 未装配确认端口。 | Core 实现与Node回归通过；Host/生产Run接入及Python parity待验收 |
| `canvas_delete_note` | `backend/tests/mind/test_mind_canvas_gaps.py::test_canvas_batch_guards_and_delete_note_confirmation`、`backend/tests/mind/test_mind_canvas_tools.py` 中便笺删除/恢复用例 | 新增 `createCanvasDeleteNotePort/Tool`，复用 `applyCanvasEdits` 和 Mind 便笺删除服务，按 owner 锁定目标版本与全部存活视图项；最多 20 项，保留 Python 单项/批量返回形状、事务 Undo/视图清理与收据重放。Host registry 仅在提供持久确认 gate 和事务内 claim 时注册。Core `canvas-edits.test.ts`、`confirmation.test.ts` 本轮套件 37/37 通过；Host registry 22/22 通过。生产 Host 未装配该端口。 | Core 实现与Node回归通过；Host/生产Run接入阻塞 |
| `canvas_disconnect` | `backend/tests/mind/test_mind_canvas_gaps.py::test_canvas_disconnect_batch_validation_and_confirmed` | 新增 `createCanvasDisconnectPort/Tool`，复用 Mind 关系删除服务，支持单项及最多 50 项有序批量；owner/画布过滤、目标快照确认、事务内 claim、操作收据和批量原子回滚。与旧 Agent 直接删除行为一致，不额外创建 Undo。Core `canvas-edits.test.ts`/`confirmation.test.ts` 37/37、Host registry 22/22 通过；Python pytest 未运行，生产 Host 未装配确认端口。 | Core 实现与Node回归通过；Host/生产Run接入及Python parity待验收 |
| `canvas_batch` | `backend/tests/mind/test_mind_canvas_gaps.py::test_canvas_batch_guards_and_delete_note_confirmation`、`backend/tests/mind/test_mind_canvas_tools.py` 中批量操作用例、`backend/app/services/canvas/batch.py` | `packages/core/src/mind/canvas-edits.ts` 与 `packages/core/src/agent/tools/canvas.ts` 已实现 20 项有序批操作、同事务复用既有 Mind 用例、owner/画布校验、request_id 收据重放与冲突、整批回滚及便签删除确认。可信Core端口先解析便签/视图集合和版本摘要，再绑定持久确认；claim 仍须由 Host 在业务事务内实现。当前生产 main/Run 未注入确认端口，且尚未按旧 pytest 做逐字段差异验收。 | Core 工具实现及 Node 行为回归通过；待生产 Host 确认能力与 Python parity 验收 |

本次 devserver Core 回归：先前 `canvas-edits.test.ts`、`canvas-placement.test.ts`、`note-lifecycle.test.ts`、`confirmation.test.ts` 共 **44/44 通过**；之前定向 `canvas-edits.test.ts` 与 `confirmation.test.ts` **34/34 通过**；本轮含 `canvas_delete_note`、`canvas_disconnect` 和 `canvas_delete` 的重跑 **37/37 通过**。新增 `calendar-delete.test.ts` 经临时 Vitest 配置 **4/4 通过**，验证标题/日期选择、候选歧义、二次确认前无副作用、SQLite 同事务批删、提醒停用、聚合Undo、owner隔离、并发版本变化拒绝、claim拒绝回滚、撤权和收据重放。Core build/typecheck 通过；合并日历/画布/确认/日历事务用例 **42/42 通过，另 1 个 PostgreSQL 子测试因未配置连接而跳过**；Host registry 测试 **23/23 通过**。确认门测试使用合成gate/claim，不代表生产Host确认已接入。日历 `create-store.test.ts`、`mutation-store.test.ts` 不在默认 Vitest 套件登记；之前通过 `/tmp` 临时 Vitest 配置运行后 **3 项通过、2 项 PostgreSQL 子测试跳过、0 项失败**，只验证 SQLite/shared store 能力，不是 Agent 工具行为回归。测试启动曾被并行工作新增的 `tests/mcp/server-config-sqlite.test.ts` 未登记拦截；未修改其文件或清单项，本次使用只含目标用例的临时 Vitest 配置。对应 Python `backend/.venv/bin/pytest` 不存在，因此本轮 Python pytest **未运行**。生产 Agent Run 目前也没有调用 `createAgentToolRegistry` 的聊天/dispatch 接线，`main.ts` 中使用宽授权的注册器仅用于技能目录发现，不是生产工具执行入口。

同轮 `@gugu/core` build 通过；Host 注册器 `agent-tool-registry.test.ts` **19/19 通过**，其中确认 gate 是合成端口，只验证“缺确认能力不注册、权限撤销后隐藏”；Core 类型检查通过。Web Host 全量 `tsc` 未通过，返回 **93 条既有工作区诊断**（含 MCP 客户端依赖解析失败和其他 Admin/Agent/MCP 测试类型不匹配）；诊断未涉及本轮修改的 Host 注册器及测试。完整 Python 基准仍未运行，不能标为旧 pytest parity 通过。

2026-11-17 `create_event` devserver 复验：Core build/typecheck 通过；临时 Vitest 配置下 `calendar-create.test.ts` 3/3、`calendar-delete.test.ts` 4/4、`canvas-edits.test.ts` 13/13、`confirmation.test.ts` 24/24、`builtin.test.ts` 8/8，合计 **52/52**；Host `agent-tool-registry.test.ts` **24/24**。测试数据使用临时 SQLite 和合成 owner；提醒目标 resolver 是测试替身，只证明 Core/ToolRegistry 契约，不是生产平台投递接入。Python pytest 未运行。

2026-11-17 `update_event` devserver 回归：Core build/typecheck 通过；包含创建、更新、删除、画布编辑、确认、Markdown Skill、Calendar Store 的临时 Vitest 配置共 **59 项通过、3 项跳过、0 失败**；跳过项为未配置隔离 PostgreSQL URL 的子测试。Host `agent-tool-registry.test.ts` **25/25**。新增测试数据均为临时 SQLite 与合成 owner。生产 Agent Run、Host 平台提醒目标解析及 Python pytest 未验收/未运行。

### Prompt Skill Markdown 资源目录约定（2026-11-17）

此项是 `backend/agent/skills/*.md` 的 Prompt Skill 资源加载，不属于 `backend/agent/tools/` 的 `BaseSkill` 工具组盘点。Core Markdown 放在 `packages/core/resources/skills/*.md`；`scripts/build-skills.mjs` 自动扫描该目录的 `.md` 文件，跳过 `README.md`，通过 frontmatter 的 `id` 和元数据生成 bundled 文档及注册项，不读取 `manifest.json`。源码与资源目录统一使用 `skills` 命名。devserver `builtin.test.ts` **8/8 通过**，覆盖无清单自动发现、头部注册、重复 ID 拒绝和正文按需重读。该回归不代表 Python BaseSkill 工具迁移或生产 Agent Run 接线完成。
| `web.py` | `http_get` | 无 | 否 | 部分实现（Core契约；安全网络端口、HTML/PDF提取及生产接入缺失；Python基准见 `agent/test_tool_schema_security_contract.py`、`agent/test_tool_schema_validation.py`、`platform/test_io_retry_contract.py`） |
| `web.py` | `web_download` | url | 否 | 依赖阻塞 |
| `workspaces.py` | `delete_workspace_directory` | directory_id | 是 | 依赖阻塞 |
| `workspaces.py` | `list_workspaces` | 无 | 否 | 已实现待接入 |
| `workspaces.py` | `get_workspace` | workspace_id | 否 | 已实现待接入 |
| `workspaces.py` | `create_workspace` | workspace_name, kind | 否 | 依赖阻塞 |
| `workspaces.py` | `update_workspace` | workspace_id | 否 | 已实现待接入 |
| `workspaces.py` | `unlink_workspace` | workspace_id | 是 | 依赖阻塞 |

## 领域依赖、既有实现与 Python 回归入口

以下为最相关入口而非全部传递依赖。pytest 路径相对 `backend/tests/`；本次盘点未执行任何 Node 或 Python 测试。父任务完成切片后应单列运行结果及替身范围。

| 工具领域 | 现有 Node 入口与剩余依赖 | Python 基准/重点回归 |
| --- | --- | --- |
| 时间 | 可直接注入时钟和可信请求时区；需真实 ToolPort 参数/权限/结果调用回归 | `agent/test_time_tool.py`：日期、星期、时分秒；补时区跨日/DST/非法时区行为 |
| 联系人 | `apps/web-host/src/domains/agent-sessions/tools/agent-client-tool.ts` 有 create/update；registry 仅接 list/create；复用 Core `data.clients`，删除需确认端口，更新需错误与候选解析验收 | `agent/test_tool_schema_validation.py`、`agent/test_tool_isolation.py`、`agent/test_agent_delete_undo.py`；Core/Data 相关项目桥接测试 |
| 项目/阶段 | `agent-project-tool.ts`、`agent-project-update-tool.ts` 有独立 adapter；create 已接独立 registry，update 未接；共享项目应用服务、幂等 toolCallId、Undo/事件和阶段规则需逐项接线 | `projects/test_project_tools.py`、`projects/test_projects_core.py`、`projects/test_undo_phase4.py`、`projects/test_project_trash.py`；防阶段/todo 丢失、模糊匹配错误、重放重复创建 |
| 日历/概览 | `domains/calendar`、项目共享服务存在；Agent 参数映射、用户时区、日历联系人/提醒、Undo 事务需复用，不能复制 SQL | `scheduling/calendar/test_calendar_tools.py`、`test_regressions_datetime_and_version.py`、`test_tz_dateattribution.py`、`test_calendar_reminders.py` |
| 文件读写/grep/目录 | `packages/fs`、`domains/files` 与授权服务；需 owner/session 可信定位端口、个人/项目/工作区范围、读媒体结果、安全写入、Undo 与冲突语义。单纯文件句柄不代表 read_file 全语义 | `platform/security/test_phase3_filesystem_policy.py`、`test_phase4_filesystem_authorization.py`、`agent/knowledge/test_grep_tool.py`、`storage/files/test_create_file_workspace_space.py`、`test_folder_workspace_write_access.py`、`test_undo_files.py` |
| 文件压缩/解压/发送/附件 | `domains/files` 有归档/下载服务，渠道发送与授权附件查询/媒体投影仍需端口；路径穿越、压缩炸弹/配额、取消及部分成功需验收 | `agent/test_tools_archive.py`、`agent/test_tool_video_media_dispatch.py`、`agent/context/test_tool_media_projection.py` |
| 工作区 | `domains/workspaces` 有业务 API，不等于 Agent 工具；需会话绑定、授权根与终端生命周期共享服务/可信上下文 | `storage/test_workspace_directory_tools.py`、`test_workspace_directories.py`、`test_workspace_canonical_mounts.py`、`terminal/test_shell_workspaces.py` |
| 回收站/Undo | `domains/undo` 与 `domains/files` 有服务；需按域共享恢复/硬删除/重做事务，危险目标集合确认与持久 job；不能只删 DB 行 | `agent/test_undo_domains.py`、`test_undo_claim.py`、`test_agent_delete_undo.py`、`storage/trash/test_trash_folders.py`、`test_trash_purge_jobs.py` |
| Mind/画布 | `domains/mind` 有服务，需 canvas/note 工具适配、owner、批量原子性、CAS/Undo 与事件；本盘点未改动画布 | `mind/test_mind_agent_tools.py`、`test_mind_canvas_tools.py`、`test_mind_canvas_gaps.py`、`test_undo_mind.py` |
| 定时任务 | `modules/scheduled-tasks` 有并行会话开发中的服务；需 Agent 适配与可信任务主体/授权、创建更新确认、调度/投递凭据和副作用 | `scheduling/tasks/test_scheduled_task_schedule_rules.py`、`test_scheduled_task_execution.py`、`test_scheduled_task_workspace.py`、`im/test_scheduled_group_imctx.py` |
| Web/图片/研究搜索 | Core Provider search adapter 存在，不能等同具体 Agent 搜索工具；需配置、可信凭据、URL/重定向/代理安全及结果归一 | `agent/knowledge/test_search_tools.py`、`agent/test_search_limits.py`、`agent/knowledge/test_similar_image_search.py`、`agent/providers/test_deep_research_providers.py` |
| http_get/web_download | `packages/core/src/agent/tools/web.ts` 实现 http_get 默认/硬上限、单/批URL、顺序、部分失败和取消；Host仅在显式提供端口时注册。端口契约要求固定公网DNS目标且不跟随重定向，但尚无生产实现；HTML/PDF提取、自定义headers校验与历史脱敏、web_download配额/本地FS落点仍待实现。Core定向Node回归 `tests/agent/tools/web.test.ts` devserver 6/6通过；Host注册回归 17/17、Core build通过；本轮未运行Python pytest，未验证真实网络或生产Run。 | `agent/test_tool_schema_security_contract.py`、`agent/test_tool_schema_validation.py`、`platform/test_io_retry_contract.py`；`storage/files/test_web_download.py` |
| 知识/记忆/全局搜索 | 目标复用 1.7.7 TypeScript RAG；需知识/长期记忆持久服务和 owner/IM scope、CAS、索引一致性，Cython 不迁 TS | `agent/knowledge/test_knowledge.py`、`test_read_knowledge_tool.py`、`test_knowledge_append_reuse.py`、`test_global_search.py`、`test_search_memory_boundary.py`、`agent/memory/test_remember_tool.py`、`im/test_im_memory_scopes.py` |
| 对话/群上下文 | Node Canonical 历史有持久适配，搜索/读取/绑定工具尚无 adapter；需 owner、群身份、访问范围与可信会话绑定 | `agent/test_tool_isolation.py`、`im/test_group_tool_permissions.py`、`agent/test_tool_history_request_boundary.py` |
| react/link buttons/email | 需可信渠道、地址/目标、邮件凭据与收件人安全策略；邮件 destructive 确认及附件 owner 校验不可省略 | `agent/test_send_link_buttons_tool.py`、`platform/email/test_email_tool.py`、`test_email_attachments.py`、`im/feishu/test_feishu_tool_summary.py` |
| MCP/Skill 管理 | Core 仅有 Harness 能力端口；需目录发现、不可变 Schema 快照、凭据存储、URL/stdio 安全后端、确认及配额 | `agent/mcp/test_mcp_manager_dispatch.py`、`test_mcp_credentials.py`、`test_mcp_schema_snapshot.py`、`test_mcp_stdio_quota.py`、`test_mcp_user_tools_e2e.py`、`agent/test_on_demand_tools.py` |
| meta/ask_user | Harness 有交互编排并不等于 `ask_user`/元工具实现；需 registry 递归安全、Schema 获取、Skill 可见性、持久交互及一次性回执 | `agent/test_on_demand_tools.py`、`agent/test_tool_schema_digest.py`、`agent/test_tool_schema_validation.py`、`agent/test_interaction_*.py` |
| shell | 仅 Executor/授权策略与注入的 MXC adapter 已实现；Shell 参数/输出映射、危险命令确认、授权撤销、取消清理和真实平台后端仍缺完整工具切片；Linux 隔离未验收 | `terminal/test_shell_concurrency.py`、`test_shell_sandbox.py`、`test_sandbox_compound_shell.py`、`storage/test_shell_policy.py`、`platform/security/test_phase4_filesystem_authorization.py` |

## 架构退役与重设计

- Linux/NAS 2.0 OSS/S3 在线存储、直传/预签名及对象搬移实现退役；上述文件工具保留业务用途，但需改用 Local 与明确授权边界，不能把整类工具退役。旧 OSS 数据盘点、导出、迁移完整性与恢复验收仍必须保留。
- Docker 沙盒生命周期、Rootless/镜像/容器重建等管理实现退役；`shell` 本身是待重设计/依赖阻塞，Linux MXC 账号、工作区、进程、资源和网络隔离未验收前不启用。
- DB↔FS 双向对账不迁为常规能力；旧数据一次性诊断/恢复与配额账本核对另列，不混入普通 Agent 文件工具。
- RAG 改为复用 1.7.7 TypeScript 引擎；Python/Cython 仅作迁移行为基准，不另造 TS 算法副本。

## 初始接入证据与测试边界

`apps/web-host/tests/agent/agent-tool-registry.test.ts` 经过独立 registry 的能力过滤/dispatch，调用真实联系人/项目 adapter，但数据库事务、repository 与项目 runtime 是替身；它保护 owner 传递、撤权阻断、非法输入不执行、异常不泄漏和写入未知不重放，不证明真实数据库隔离或 Host/Harness 生产接通。本盘点未执行该文件。

没有把 Harness 测试中的 fake ToolPort、Provider 搜索测试、HTTP 路由存在或能力 Schema 暴露计为工具完成。后续每个切片必须记录真实调用入口、模拟依赖、Node/Python 通过/失败/跳过，以及 PG/Redis、平台后端和外部服务未验收范围。

优先顺序：时间 → 联系人更新/列表（现有 Core 契约）→ 项目读取/更新（共享服务）→ 文件读取授权切片；危险删除、跨系统发送、Shell 和 RAG 等依赖明确后再接。共享迁移清单由主会话与工作台/聊天会话协调后追加本专题链接，不在此盘点中直接修改并行编辑文件。


## 首批工具切片验收（2026-11-14）

- `get_current_time`：Core `createTimeTool` → `createToolRegistry` → 真实 Harness 工具轮已通过，保持 date/weekday/time/datetime/timezone 结果。时钟和用户时区由可信 Host 注入，忽略模型额外时区字段；跨日、午夜与 DST 已测。生产 Host 尚未装配，状态为已实现待生产接入。共享 `./tools` 包导出由聊天会话完成。
- `read_file`：已实现待接入，且仅 file_id 的 UTF-8 文本子集。真实临时文件通过 `packages/fs.openLocalFile` 读取，原始换行/绝对行号/空文件/非法UTF8/符号链接拒绝已测。文件归属与范围 resolver 使用替身，不证明真实 PG owner/session/群访问权限。URL、媒体、附件、批量、逻辑路径、system scope 未实现，不能将全工具标为完成。
- 注册边界：发现和每次派发重新判权，未知工具/非法参数/伪造 resolution 拒绝，读错误使用固定安全文案；写入异常返回 unknown，reconcile 不重放。危险工具目前全部拒绝开放，等待聊天会话提供持久确认意图与收据端口，不以此拒绝门代替完整确认迁移。

本轮验证：Node 26 的 `vitest run tests/agent/tools` 共 3 文件、20 通过、0 失败/跳过；其中真实 Harness 时间工具组合使用测试 Provider、内存 RunStore/lease/event adapter，工具实现与注册器为真实代码。文件测试使用临时磁盘和真实 FS，授权/元数据是替身。Python 串行 `tests/agent/test_time_tool.py` 1 通过，以及 `tests/storage/files/test_file_operations.py tests/agent/test_group_file_read_boundary.py` 27 通过，合计 28 通过、0 失败/跳过；2 条 pypinyin 弃用提示。文件基准涵盖比本次文本子集更多行为，不能将通过总数当作全量已映射证明。

Core 源码和测试类型检查通过，`git diff --check` 通过。新增测试已登记 suites 和测试元数据。quality_delta 无该新目录的历史基线；整树其他并行改动存在门限项，未据此修改无关文件，不宣称全仓质量门通过。

未验收：真实 PG/Redis、跨进程确认与重启收据、生产 Host、真实平台执行、外部网络服务与付费 Provider。本轮未运行 Docker/CI，未修改运行配置、Python 基准或真实用户数据，未 fetch/提交/推送。下一切片优先将现有联系人共享服务接入 Core 工具契约，并与聊天会话完成真实 Host 装配。


## 第二批工具切片验收（2026-11-14）

- `list_clients/create_client/update_client`：新增 Core `createClientTools(SqlDataRuntime)`，直接复用 owner-scoped `data.clients` 事务与领域校验，不另写 SQL。真实临时 SQLite 验证创建、空字段更新、重载、跨 owner 的 ID/名称拒绝、精确优先/模糊歧义、ILIKE 通配符与候选上限10、无修改不假成功、非法参数拒绝。Harness → registry → SQLite 创建/查询 → final 已验收；Provider、RunStore/lease/event 为替身。删除工具仍未开放，等待可信确认接线。
- `list_projects`：新增 `createListProjectsTool(SqlDataRuntime)`，复用 `data.projects.list`，投影恢复 Python 状态/归档/软删除过滤、更新时间排序、阶段计数和语义色；真实临时 SQLite 与 Harness 工具轮通过。生产 Host 正由聊天会话整合，不以包导出或独立注册器计生产完成。
- `read_file`：补齐普通文本替换解码、保留 BOM 与 200000 Unicode 字符截断；无后缀维持严格 UTF-8。真实 FS 验证穿越/绝对路径/NUL/根内外 symlink 拒绝、32 MiB 边界与 stat 后增长、取消先关闭句柄。当前 FS API 尚未证明目录并发替换 TOCTOU 安全，保留为剩余边界；owner/session/群 resolver 仍是替身。

第二批 Python 串行基准：`tests/agent/test_tool_schema_validation.py tests/agent/test_tool_isolation.py tests/projects/test_project_tools.py` 148 通过、0 失败/跳过；`tests/storage/files/test_file_readers.py` 23 通过、0 失败/跳过。Python 文件全量执行包含尚未迁移功能，不能据总数升级相应全部工具。全局工具错误增强与旧输入适配尚未完全迁移，当前注册器的固定安全错误不代表 Python `issues/usage_hint/next_action` 已等价。

新增/修改范围：`packages/core/src/agent/tools/{clients,projects,files,index}.ts` 与对应工具测试、suites/测试元数据及本清单。共享 Host 注册器和包导出由聊天会话串行处理；没有覆盖其工作。真实 PostgreSQL/Redis、持久确认、生产 Host 仍待验收。

第二批整合复跑：Node `vitest run tests/agent/tools` 5 文件、43 通过、0 失败/跳过；Core 测试源码类型检查与 `git diff --check` 通过。联系人6、项目列表5、文件21、时间4、注册器7项。Core quality_delta 的2项阻断均位于其他会话的 Provider values 文件，工具新增代码无旧符号恶化；新增工具复杂度仍需保持在业务切片范围。上述结果不覆盖真实 PostgreSQL或生产Host。

## 注册器统一方案（2026-11-14）

按用户决定，Tools 和 Skill 正文都使用显式注册器及配置入口；详见 [工具与技能注册机制](../refactor/Gugu-2.0-Agent工具与技能注册机制.md)。工具支持 register/registerGroup/configure，保持旧 tools 数组构造兼容；技能支持 register/configure/catalog/load。注册和启用分离，配置不能代替 Host 能力、用户授权或确认。配置未知名称/非法类型原子拒绝，等待授权时停用不能绕过，技能正文由可信 Host loader 提供。

本轮整合 Node 工具及技能 6 文件、67 通过、0 失败/跳过，测试源码类型检查通过；含工具注册器10项、Skill注册器18项。该结果含项目详情新增回归（概览端口仍使用替身），不等于 get_project 的真实文件计数已验收。Host已提供共享概览查询，但注册表端到端验收尚未完成。两种注册器的持久配置、管理UI和use_skill生产调用方均未据此标为完成。

Host受限工具注册表已复用Core联系人和项目列表、可选时间工具，聊天会话报告其定向5/5；生产Host未注入、真实PG未以该注册表验收，因此继续保持待接入。

本轮Python补验：能力注册、Skill ID迁移、项目详情上下文3文件共17通过、0失败/跳过。新配置API由Node行为测试保护，Python历史能力测试不替代新接口验收。


## 项目创建与技能加载工具（2026-11-14）

- `create_project`：新增 Core `createProjectTool(ProjectCreatePort)`，统一 Schema/参数校验/真实身份与调用ID传递/结果映射。Host 注入共享项目创建服务，Core不复制事务或存储业务；重放 successful 但 mutated=false，写入异常保留 unknown。10条回归使用明确领域端口替身，不证明真实事务、幂等键冲突或 PostgreSQL 已验收，仍为待接入。
- `use_skill`：新增 `createUseSkillTool(UseSkillPorts)`，经真实 ToolRegistry→SkillRegistry→可信 loader 返回正文与 `_capability_usage`；支持同摘要 already_loaded、内容摘要更新重新加载、停用/跨owner/取消/安全错误。元数据等待期间停用也不发布正文。Host注入当前上下文 loadedDigest 与来源 origin，用户来源必须有可信指纹，不能来自模型参数。真实Harness工具轮已验收正文/marker进入结果，但摘要读取及来源为替身，Harness尚未从历史/当前轮标记恢复和更新摘要，故完整去重生产链未完成。
- `get_project`：Core项目详情已实现且显式要求fileOverview，Host已加入可选端口；共享概览SQL由工作台会话提供。默认生产Host未注入、真实注册器→PG→计数链未验收，不能按已有字段Schema关闭迁移。

本轮Node工具与技能共8文件82通过、0失败/跳过；测试源码类型检查通过。Python串行 `tests/agent/test_user_skills.py tests/projects/test_project_tools.py` 44通过、0失败/跳过（6条弃用提示）。这些完整Python文件包含尚未迁移的删除等分支，不以总数声称全部等价。`git diff --check`通过；Core quality_delta的2项阻断仍位于并行Provider文件，没有修改该范围。

[日历查询端口](node-agent-calendar-port.md) 明确现有Web列表缺范围查询与提醒聚合，暂不构造另一套SQL；[确认端口设计](node-agent-confirmation-port.md) 明确可信目标解析、身份/轮次/输入摘要/资源版本绑定、交互与领域提交收据区分及未知结果恢复。危险工具保持拒绝，端口文档不代表确认实现完成。

## 可信确认核验边界（2026-11-14）

新增Core `createConfirmationGate`（confirmation.ts），只准备/核验受限持久意图，不claim、不执行业务、不开放destructive。绑定固定owner/session/run/round/call/tool/规范化输入摘要；意图和receipt必须v2，检查purpose/action、授权epoch、目标/版本摘要及两者时效。端口不能原地覆盖可信绑定；异步等待后取消传播，调用快照不受外部修改影响。旧Host弱意图缺字段时拒绝。

Node gate定向23通过；整合工具/技能9文件105通过、0失败/跳过。端口均为受控替身，仅验证可信核验契约，不代表真实PG/Redis、单次claim、跨进程恢复或mutation原子性完成。Python串行 `tests/agent/test_confirm_gate.py` 41通过、0失败/跳过，66条依赖弃用提示。测试源码类型检查当时被并行Harness `context-runtime.test.ts:74` TS2722阻断，已通知负责会话，不修改其文件；未将该检查报为通过。diff检查通过；Core质量门的2项阻断仍在并行Provider改动。

工作台会话确认当前共享领域入口没有同时满足operationId提交收据、目标CAS与mutation同事务的能力；项目update有owner/versionCAS和Undo，尚缺Agent操作收据；项目删除另有Local搬移恢复缺口。正式危险工具继续依赖阻塞，不能以该独立gate测试通过改状态。

聊天会话已将Host项目创建注册器替换为Core定义并注入现有共享创建服务，报告Host6/6及Host类型检查通过；默认生产Host尚未装配，不升级生产接入状态。

随后负责会话修复Harness测试可选方法调用，Core测试源码 `tsc -p tsconfig.tests.json --noEmit` 已重新执行通过；上述TS2722保留为本轮过程记录，当前类型检查阻断已解除。

## 项目变更与内置技能资源（2026-11-14）

Core新增 `createProjectMutationTools(ProjectMutationPort)`，映射 update_project/set_color/archive_project 的参数、字段、默认值与结果。共享apply端口承接owner解析、版本CAS、完成状态规则、Undo、目录协调和提交事件；Tools不直接更新数据库。当前14项回归只经过真实registry与明确领域端口替身，尚不证明真实领域副作用完成，三个工具均待接入。工作台会话正在提供独立Agent入口，避免Web DTO缺summary与必须显式version的差异；提交未知不自动重放。

Skill新增 `createBuiltinSkillDefinitions`，真实读取13份现有Markdown，经SkillRegistry加载正文和摘要；元数据完整保留且快照隔离，正文热读、ID漂移/重复拒绝、读取错误脱敏和取消均有行为回归。Host资源制品打包尚未完成，不把测试能读取仓库Python目录当生产Node可用。详情见注册机制文档。

修复create_project摘要按UTF16长度拒绝合法emoji的问题，复用Core Unicode长度规则，200个emoji接受、201个拒绝；公开Schema仍为maxLength200。全局输入契约仍有差异，见 [输入契约对照](node-agent-input-contract-parity.md)，后续逐项迁移，不以注册器校验存在认定Python兼容已完成。

本轮Python串行 capability_injection/skill_id_migration/project_tools 65通过、0失败/跳过，4条弃用提示；并非全部分支已映射到本轮Node。


本轮最终整合：Node工具/技能11文件126通过、0失败/跳过，测试源码类型检查和diff检查通过。独立Python/Node内置技能对照直接读取参考模块及编译后Core实现，13项全部元数据、完整正文和SHA256摘要一致（不涉及应用配置或真实用户数据）。该对照是本轮主动校验，常规6条builtin行为回归仍保留；资源打包仍待Host。

工作台随后提供createAgentProjectUpdater(runtime)，支持Agent summary/priority:null/stages与缺省version的事务读取/CAS，保留Web DTO契约。该共享入口尚未与本任务ProjectMutationPort及生产Host整合；提交未知和operationId收据缺口仍明确保留，不能升级为幂等完成。

## 输入归一与错误契约首批（2026-11-14）

统一registry在validator前执行已知名称别名与schema标量归一，在拒绝后投影Python安全issues及恢复提示，已完成业务错误的字符串/对象增强；unknown、列表和成功回执形状保留。真实临时SQLite覆盖旧name、数字contact、#字符串ID更新与文本archived筛选，归一后重复ID仍拒绝且无写入。详见输入契约对照文档的首批实现及剩余差异。

本轮最终Node工具/技能13文件163通过、0失败/跳过，测试源码类型检查通过；Python tool_schema_validation/tool_schema_security_contract 115通过、0失败/跳过，2条弃用提示。初次整合两条旧Node“数字字符串ID非法”预期与Python契约冲突，已保留非法ID边界并新增合法文本ID实际调用断言；严格业务错误断言明确增加统一提示字段，未放宽断言掩盖错误。公开schema完整注册校验、协议包装及复杂历史输入适配仍未完成。


## 现有公共工具契约收束（2026-11-14）

按最新协作优先级，先完成既有跨端公共能力与契约，不新增N2业务。补日期/固定色板/精确包装兼容，工具注册器仍按最终工具名授权、归一后校验，危险工具仍拒绝。Node14文件203通过、Python参数/项目111通过，均无失败/跳过，测试类型检查通过；详见输入契约对照。

项目创建端口补必需roundId，与identity.runId一同传给Host。旧Python与旧Host仅session+operation+toolCallId的幂等键不能区分不同run/round复用调用ID；Core已提供完整可信身份，Host正在串行修复键并补碰撞/重放回归。在真实Host事务测试前不把此风险标为已修复；不以同一次恢复重放为由跨运行复用旧键。

随后聊天会话完成Host幂等键修复：对session/run/round/toolCall元组JSON编码后SHA256，Core检查源代码确认v2路径不会回退旧键；聊天会话报告隔离PostgreSQL事务回归通过（同调用重放、不同run/round同call不重放）。旧直接调用兼容入口保留，正式生产Host整体装配仍待验收；本任务未将此局部证据扩大为全量工具完成。

## 注册器公共契约校验（2026-11-14）

注册期新增公开名称/参数根/读写属性/handler及当前常用Schema关键字形状检查，拒绝Python既有required字符串错误与循环声明；分组失败无残留。不宣称完整Draft元Schema或所有公开Schema与validator等价。全部现有工具工厂仅验证注册过程不调用后端。

本任务独立配置运行tools/skills15文件235通过、0失败/跳过（包括32项注册期回归），测试源码类型检查与diff检查通过；临时配置已自动删除。标准Node发现入口仍因其他会话新增测试未统一登记而未复验，不将定向运行作为全仓发现检查通过。Python相关注册/缓存/Schema4通过、86未选，0失败/跳过。当前公共领域用例尚未全部双库验收，因此继续按既有端口等待接入，不扩展新N2业务。

## 名称与可信年份依赖收束（2026-11-14）

联系人/项目名称lookup改用共享Python strip规则：C0包装可定位原名称，BOM保留为实际名称字符；创建名称仍原样存储，不擅自修剪。真实registry/临时SQLite分别回归查询/更新及BOM不误匹配普通名称。完整日期与完整但非法日期不再访问缺省年份服务，只有既有缺年份格式才读取可信Host年份，避免不必要的上下文依赖导致普通工具失败。

默认测试发现清单已由对应会话登记恢复。本轮标准入口工具/技能15文件239通过、0失败/跳过，测试源码类型检查与diff检查通过；Python tool_isolation/project_tools串行58通过、0失败/跳过，7条弃用提示。此前独立配置235通过不再作为当前标准入口的替代证据。

公共用例复核新增两项真实差异，尚未关闭：现有Agent创建适配固定默认色，Python优先未用色板，已交由领域会话在共享创建入口处理；工具clients的JS regex模糊匹配不严格等价PG ILIKE转义/locale及SQLite lower，后续须复用公共owner-scoped findByName仓储契约，不能以当前ASCII示例通过认定双库等价。项目/calendar/mind公共端口仍在各自双库验收中，当前不扩接未经验证的新业务。

## Agent 项目创建业务迁入 Core（2026-11-14）

新增 `project-create-port.ts`：createAgentProjectCreator(runtime) 共用原Host字段默认/阶段/结果投影，复用Core createProjectCreator及Kysely项目创建适配；createProjectCreationPort在正式工具路径强制完整run/round/call并注入可信keyForCall。Host旧直接入口可委托同一业务函数保留旧key/null及优先级大小写处理，不需要继续保存另一份业务映射。省略color时使用共享selectUnusedColor事务能力，幂等命中先于选色；显式颜色不改变。

真实ToolRegistry→Core应用→Kysely→临时SQLite已验证owner未用色池、阶段/todos/summary/priority持久化、同scope重放、run/round分离、相同键跨owner隔离、同键不同payload冲突。真实Harness工具轮创建成功后继续回复；Provider/RunStore/lease为测试替身，项目创建及SQL事务为真实实现。提交后抛异常返回unknown，reconcile不重复执行；预取消零写入，提交后取消保留成功。共享应用新增signal后，桥接显式传递，颜色读取期间取消在插入前回滚也有真实SQLite回归。

本轮标准工具/技能16文件251通过、0失败/跳过（新增事务内取消之前的整合运行）；随后创建桥接定向8/8通过，测试源码类型检查通过。Python项目工具21通过、0失败/跳过，4条弃用提示。过程中临时独立配置16文件251通过亦已执行并删除；新增并行测试登记后标准入口已恢复，不用独立配置冒充标准发现验收。

当前只验证SQLite共享链，新的Core桥接PG、正式Host旧wrapper/正式registry切换仍由相应会话串行验收；未将应用自身PG合同结果直接算作工具端到端PG通过。危险工具和领域operation收据仍未开放。输入兼容另补JSON容器字符串及最多4层item/block，真实registry验证stages/todos到达共享创建port；同型anyOf歧义、top-level hoisted和strict_array_fields扩展仍未完成。

## 联系人名称查询公共化（2026-11-14）

经领域会话明确交接，只在Core ClientRepository/ClientService新增findByName，ToolRegistry的联系人更新删除手写JS regex并调用该公共服务。owner内精确匹配优先，无结果再交原生PG参数化ILIKE或SQLite lower(name) LIKE lower(parameter)，不再用JS Unicode折叠模拟数据库。list原排序保留；查询共同复用私有owner限定读取入口。

标准工具/技能与SQLite查询17文件262通过、0失败/跳过；独立临时PostgreSQL随机schema回归1通过、0失败/跳过，包含真实ToolRegistry→Core服务→PG更新与跨owner拒绝，以及精确优先、%/_、反斜线、当前数据库Unicode行为和参数化安全。先前联合双库2文件7通过，随后加入PG工具实际调用并在owner读取收拢后重跑PG通过；数字不相加冒充新增。临时PG已停止，数据目录与随机schema全部清理，不连接真实用户库。测试源码类型检查及diff检查通过；Python tool_isolation37通过、0失败/跳过，5条弃用提示。

新增两个契约测试已登记元数据/suites；共享services/repositories文件已返还领域会话，未改共享schema、包依赖或数据迁移。质量检查仍有并行改动的门限项，本次私有ownedQuery亦被与不同表的projectRows判作结构克隆；保留具体表/owner查询边界，未为消除指标引入动态SQL通用层，不宣称全仓质量门通过。静态分析器未解析新方法的限定名称，类型检查与双库运行证据另列，不将该查询误报为静态审查零风险。

项目创建Host会话已确认正式端口/旧入口均委托Core共用业务，Host定向10/10及隔离PG作用域幂等通过。此为该会话运行证据，非本任务复跑；总体生产Run装配仍未因此全部验收。另本任务补旧直接color:null/数字保留默认色的真实SQLite回归，正式工具参数仍拒绝这些非字符串值。

## 注册器同轮并发行为（2026-11-14）

复用Harness现有ToolPlan，将注册器原先固定串行改为Python同轮并发语义：普通read/write都并行，默认上限5，可信Host可设置1–128；交互、未知/停用、解析失败或非对象调用串行。计划阶段不提前授权/校验，每项dispatch仍检查最新权限、配置和参数，坏参数仅拒绝自身。危险工具保持禁用并保守串行，不声明其并发/确认等价完成。

新parallel-plan行为回归经过真实ToolRegistry→Harness，用可控Promise验证读写同时启动、上限2时第三项等待、非法参数不阻断兄弟写入副作用，以及取消必须等待handler清理。Provider、RunStore、lease及工具内存副作用为受控替身，不证明数据库并行事务、平台执行、Redis或真实Provider已验收。Python `tests/agent/test_parallel_tool_policy.py`串行14通过、0失败/跳过，2条弃用提示。

仍未迁移Python的call_tool有限递归解析以及基于输入的动态交互分流谓词；当前Node未知call_tool拒绝，不能把声明requiresInteraction当作未来Shell/MCP完整交互后端。相关工具未开放，不能据注册器调度测试宣称完成迁移。

标准入口工具/技能与SQLite查询18文件275通过、0失败/跳过；其中新调度文件13项。作用域diff检查通过。随后整包测试类型检查因另一会话迁移中的当时迁移中的项目更新模块未解析导入及可选索引失败，已通知文件所有者，未修改或隐藏其错误。全树quality_delta仍包含并行变更及注册器本身的复杂度/体积提示，不宣称全仓质量门通过。

领域会话随后完成上述共享文件编辑，重跑`tsc -p tsconfig.tests.json`通过；此前失败保留为并行编辑期证据，不再作为当前类型检查阻断。

## 数组参数修复的工具安全边界（2026-11-14）

注册器接通可信strictArrayFields快照，严格数组不进行item/block或顶层拍平修复；默认字段补Python顶层flattened-items兼容。正常/非法输入都必须经过实际validator，模型不能改策略；缺失业务字段或未知额外键不会产生写副作用。具体判据与余留差异见[node-agent-input-contract-parity.md](node-agent-input-contract-parity.md)。标准Node18文件297通过、0失败/跳过，Python schema_validation90通过、0失败/跳过；源码与测试类型检查通过。此为通用边界补齐，不将尚未接真实后端的批量文件/笔记工具改成已完成。

## 项目修改公共用例接线准备（2026-11-14）

新增内部`project-mutation-port.ts`薄桥接草稿，复用共享`createAgentProjectUpdater`，不复制项目事务SQL：可信resolver返回owner内项目及版本快照，显式传版本以保护定位到写入间的CAS；update/set_color/archive只做字段和工具结果映射。普通项目修改没有跨调用幂等承诺，registry的unknown不可重放；不再把危险操作所需持久确认收据当作普通修改已实现的能力。

桥接区分已提交与事务前错误：提交后getFileCount失败即使是CoreError也仍返回unknown；目录补偿失败等busy也不伪装为已拒绝且无副作用。仅共享应用的invalid_request/not_found/conflict在未提交时映射公开业务失败。解析后、调用共享用例前再次检查signal；共享更新事务暂未提供中途取消能力，已提交结果必须保留。

当前未从公开tools入口导出，也未接生产Host。共享Agent用例的首次完成todos/progress/current_stage及空更新错误原有差异已交领域会话修复，其正式验收及SQLite事务适配尚待交接。名称定位服务仍无经双库验证的共享端口；旧get_project私有JS regex不能充当PG ILIKE等价证明。故update_project/set_color/archive_project仍为已实现待接入，不能因桥接存在修改完成状态。

审查补强：薄桥接验证定位快照id/version均为正safe integer，防止resolver漏列版本导致共享Agent用例回落到更新后的版本；事务callback进入及返回提交前检查取消，异常由可信事务适配器回滚，并由共享用例补偿目录。只有事务前校验或业务callback明确抛出的公开领域错误可作为拒绝，事务/COMMIT自身抛同名CoreError仍保留unknown，不能用transaction未resolve推断未提交。

项目修改组合回归现25/25，保留此前14项端口契约；新增11项实际registry→薄桥接→共享应用链，事务/存储/事件为明确的内存替身。覆盖summary/priority、set_color/archive、副作用/Undo/事件、版本CAS、首次完成待办、空更新、撤权与取消、等待事务取消及提交前回滚、COMMIT丢响应/提交后CoreError unknown、缺失版本快照拒绝。Node整合此前18文件304通过（在新增后四项取消/提交测试之前），最终整合另记；Python正确路径`tests/projects/test_project_tools.py`21通过、0失败/跳过、4条弃用提示。曾误选不存在的agent路径导致0收集，已更正，不计作通过或业务失败。源码/测试类型检查与作用域diff检查通过；质量扫描将嵌套apply与外部工厂标为克隆，不据此宣称整仓门通过。

## 项目名称查询公共化与接线验收边界（2026-11-14）

经领域会话授权，ProjectRepository/ProjectService新增findByName；SQL仓储owner内排除已删除项目，精确匹配优先，再使用PG参数化ILIKE或SQLite原生lower/LIKE，包含归档且不附加排序。工具定位移入`project-selector.ts`，不再用JS正则/大小写折叠模拟数据库；保留未归档候选优先、多候选及可用名称投影。公开`createProjectResolver(core)`供查询和未来修改共用，不接受模型owner。

SQLite共享查询7/7；get_project额外3项真实registry回归保护Unicode大小写、反斜线LIKE、归档精确优先及owner隔离。临时独立PG随机schema1/1通过，含共享查询及实际registry→get_project→PG、owner拒绝；文件概览为可信零计数替身，不证明文件后端。临时PG已停止并清理。标准工具/技能和SQLite查询19文件318通过、0失败/跳过；Python tool_isolation/project_tools串行58通过、0失败/跳过、7条弃用提示。源码/测试类型检查与作用域diff检查通过；qualified edit-check未发现调用参数不兼容。

共享Agent updater的done/no-op修正已由领域会话报告正式Host20/20（非本任务复跑）；本轮将`createProjectMutationPort`与类型公开为待接入边界。B审查要求正式生产写工具使用同事务的owner/session/run/round/call+输入摘要持久operation收据及事务内目标解析/目录补偿；现桥接仅有定位快照CAS和unknown，没有跨重启结果识别，**仍未装配生产Host**。不能把Python普通修改原本没有跨调用幂等当作满足更强Harness恢复契约，也不将公开导出视为完成。SQLite目录写事务亦未验收，工具状态不升级。

末次测试源码类型检查通过，作用域diff检查通过。整树quality_delta仍有并行变更门限；本切片还提示待Host使用的公开createProjectResolver无内部调用，以及mutation工厂/嵌套apply重复计数与复杂度，不据此宣称整仓质量门通过。桥接mutated=true的当前依据是共享Agent用例拒绝空fields，非空fields均执行CAS并递增版本，即使字段同值也有实际事务副作用；若公共用例未来新增成功noop，必须透传可信changed，而不能根据字段相等自行推断。

## 固定 Adapter 选择边界盘点（2026-11-14）

新增`schema-selection.ts`纯规则及真实registry授权快照回归，保留Python前缀/重复/12上限语义；未注册get_tool_schema占位工具。Core目前全量直接声明与Python固定入口不等价，Harness需独立Provider可见声明和授权目标集合、版本摘要、可信Canonical事件与原子历史恢复，并在call_tool最终目标重新鉴权确认。按当前公共化优先级，草稿保留且消费端暂停新增；两个固定Adapter仍依赖阻塞。契约与具体验收见[node-agent-tool-schema-port.md](node-agent-tool-schema-port.md)。Node整合20文件328通过、0失败/跳过，Python最近邻4通过39未选、0失败/跳过；测试类型检查通过。没有把纯选择规则记成已接通工具。

## 已迁工具的Unicode整数输入（2026-11-14）

复用现有日期Nd数字算法补齐integer参数对全角/阿拉伯/数学数字的Python兼容，保留safe integer、严格格式、`#`仅ID和owner限制。Node20文件329通过、0失败/跳过；Python schema_validation/project_tools111通过、0失败/跳过，源码/测试类型检查通过。具体旧断言变化及真实SQLite副作用证据见[node-agent-input-contract-parity.md](node-agent-input-contract-parity.md)。本轮只修复已迁工具契约，没有新增Node业务工具或开放未就绪能力。

## 文本read_file行号兼容（2026-11-14）

已迁UTF-8文本子集补齐Python Unicode Nd行号、C0空白与BOM差异，真实registry/FS回归同时保护原始物理换行/绝对编号和源文件不变；没有开放任意宿主路径、逻辑路径、媒体、URL或批量来源。Node整合20文件355通过、0失败/跳过，Python最近邻read_file2通过20未选、0失败/跳过；源码/测试类型检查通过。详细证据见[node-agent-input-contract-parity.md](node-agent-input-contract-parity.md)，read_file总体仍是文本子集，完整工具状态不升级。

## 联系人提交错误来源边界（2026-11-14）

修复clients.ts把事务层所有CoreError invalid_request误当“联系人字段无效”的问题。只有可信事务callback确实抛出的同一校验错误、并由事务回滚后传播，才能映射确定失败；事务入口/提交层自身的同名错误继续抛给registry，写工具返回unknown，不声称未写入或诱发重试。

新增5项真实临时SQLite故障注入回归：create/update真实提交后抛同码异常，持久数据已变且结果unknown；事务开始前同码异常不写，但不猜故障阶段；两类reconcile均不执行新事务或重复写；callback内真实非法字段仍拒绝且原记录不变。未修改旧断言。标准工具/技能与SQLite查询20文件360通过、0失败/跳过，源码/测试类型检查及diff检查通过。Python tool_isolation串行37通过、0失败/跳过、5条弃用提示，保护owner隔离、CRUD和确认门；新增Node提交不确定性故障注入为Harness边界，不冒充Python有同名恢复测试。未增加真实PG/Redis/平台执行验收。edit-check未发现参数不兼容；quality_delta仍提示联系人执行器复杂度/嵌套计数及整树并行门限，不宣称全仓质量门通过。

本轮重盘点没有另一项已具备完整共享端口的只读工具：日历列表提醒聚合、overview/trash公共查询及纯历史正文端口仍待领域公共化。Web send_link_buttons虽可复用现artifact链，但Node工具未实现，按当前公共化优先级仅记录差异，不新增该N2工具代码；工作区查询现HTTP投影缺Python工具的关联资源名称，不能以已注册路由宣称可直接接入。保持对应工具依赖阻塞状态。

## 当前清单与总览依赖复核（2026-11-14）

AST重新盘点backend/agent/tools的字面Tool声明109项、互异109，现清单未漏项；动态MCP/Host实际运行注册仍须单独验证，静态覆盖不等于完成。核对真实调用方后确认Node agent-overview-postgres只是上下文原型，formatAgentProjects仅测试使用，不能把搬格式函数算公共化。get_upcoming/get_dashboard_stats与该原型在项目筛选/限额、完整事件字段、文件空间及计数窗口上不同，仍需完整共享领域查询与双库验收；具体消费契约已写[node-agent-overview-port.md](node-agent-overview-port.md)。本轮未新增总览工具、SQL或占位实现。

联系人测试随后将恢复断言从transaction调用次数调整为真实领域mutation调用次数和持久数据不变，允许未来合法只读收据查询而仍禁止重放；复跑clients整文件14/14、测试类型检查通过。此前20文件360的整合证据保留，不将此次14项相加成新整合总量。Core/Host当前按协调冻结供其他会话隔离PG验收，本任务未改这些源码或测试。

## 项目创建提交错误来源边界（2026-11-14）

`createAgentProjectCreator`现在区分事务callback公开业务错误与transaction自身异常：COMMIT/事务入口即使抛CoreError invalid_request或conflict，也不代表未创建，交registry保留unknown。`createProjectCreationPort`只在计算可信幂等键时映射键配置错误，底层create调用移到该catch之外，避免再次吞掉提交未知。共享创建用例的字段校验和已知幂等内容冲突继续明确拒绝，不放宽旧断言。

新增6项真实临时SQLite回归，桥接16/16：两种CoreError均覆盖真实提交后unknown、reconcile不重放、显式同key重读原id且只有一条记录；事务开始前同码也unknown且零写入；callback业务错误和keyForCall错误仍明确拒绝。标准工具/技能与SQLite查询20文件366通过、0失败/跳过；Python project_tools21通过、0失败/跳过、4条弃用提示。源码/测试类型检查与diff检查通过，edit-check未发现调用不兼容；quality_delta仍报告嵌套工厂计数及整树并行门限，不能宣称全仓质量门通过。

Host旧wrapper也有同类宽泛catch，已由聊天会话拆开幂等键计算和异步创建并增加回归，待统一build后验证（非本任务已跑证据）。本轮未改Host文件；不把Core组合测试当Host生产验收。显式相同调用键的幂等重读测试不等于registry自动恢复重试，reconcile仍保持unknown；跨平台实际执行/PG未新增验收。

聊天会话随后完成统一Core build，报告Host旧wrapper/注册器11/11通过（含提交后同类CoreError保留未知）及隔离PG项目事务/幂等1/1通过；这是对方执行证据，未混入本任务SQLite/Node366总量。Host旧wrapper异常收敛已验收，但总体生产Run装配和其余工具依赖仍未因此完成。

## Skill正文交付前撤权边界（2026-11-14）

SkillRegistry.load在可信loader完成后再次判权与检查取消。此前use_skill外层catalog会复查，但直接调用公共注册器仍可能交付I/O期间已撤权的正文；现在两种调用都失败关闭。配置停用仍由相同allowed边界保护，原始判权异常不回显，等待期间取消不交付正文。

新增4项deferred行为回归，skills registry22/22；标准工具/技能与SQLite查询20文件370通过、0失败/跳过，源码/测试类型检查及diff检查通过。测试loader与授权服务为受控替身，验证正文不外泄、异常固定安全错误、等待取消和正常body/digest保持，不验证真实用户技能数据库。Python user_skills/skill_id_migration串行24通过、0失败/跳过、4条弃用提示，保护owner目录/加载隔离、技能管理与ID兼容；Node新增并发撤权时序另由行为测试覆盖，不冒充Python同名测试。edit-check未发现调用不兼容，quality_delta仍有SkillRegistry复杂度/体积及全树并行门限，不宣称全仓质量门通过。

Skills仍保持显式注册器方案，生产Host技能loader/资源打包/用户技能服务尚未接通；本次安全补强不改变其待接入状态。未修改Host/Harness、包依赖、共享schema或运行配置。

## 授权等待期间的身份与参数快照（2026-11-14）

ToolRegistry在发现入口冻结可信身份副本；dispatch首次await前固定scope、身份和调用坐标，并复用Harness portableSnapshot深拷贝/冻结JSON参数。外部修改原identity.ownerId/session/run、round、call名称/ID、嵌套参数或替换signal，不能改变本次授权后的实际执行。仅使用现有JSON快照边界，不另造序列化器；getter/函数/平台对象等非法输入不能进入工具，快照失败仍先检查原目标授权，再返回安全tool_input_invalid，未授权者不获得Schema校验信息。

新增6项deferred注册器回归及1项真实临时SQLite联系人回归；registry17/17、clients15/15，标准工具/技能与SQLite查询20文件377通过、0失败/跳过。SQLite中授权A后把原身份改成B，实际更新仍限定A且不能修改B记录；授权服务为受控替身，非真实Host认证验收。Python tool_isolation串行37通过、0失败/跳过、5条弃用提示。源码/测试类型检查及diff检查通过；默认发现清单已复核一致，不用早期临时定向配置替代此标准结果。

edit-check未发现调用参数不兼容；quality_delta仍报告注册器复杂度/体积及嵌套方法重复计数与整树并行门限，不宣称全仓质量门通过。本轮未改Harness/Host/共享schema、没有生产接入状态升级。

## 工作区管理列表公共化（2026-11-14）

A明确交接文件所有权后，既有生产Host管理列表已委托Core `createWorkspaceLister`；Host仅保留三条原owner SQL，main/路由及旧测试断言不变。Core12项真实临时SQLite读端口原型、Host4项和独立PG1项、Python工作区19项均通过，相关类型检查通过；Core整合21文件389通过、0失败/跳过。未接正式SQLite工作区schema，也未补Python工具所需关联资源owner名称与列表同时间ID排序，因此不注册新工具、不升级list_workspaces/get_workspace状态。详细共享端口、证据和剩余依赖见[node-agent-workspace-port.md](node-agent-workspace-port.md)。

## 工作区查询移除测试内适配器（2026-11-14）

新增Core可复用Kysely PG/SQLite工作区管理读取适配器，仍复用同一公共列表业务，不建表、不新增Agent工具。原SQLite12项现全部经实际适配器，旧业务断言未变；独立隔离PG1/1还对比新Core reader和原Host adapter在两个owner的完整结果一致。Host4/4、Python工作区19/19及Core整合21文件389均通过、无失败/跳过，Core源码/测试和Host类型检查通过。计数没有因替换同12项测试而虚增；临时PG/SQLite数据全部清理。

正式SQLite缺工作区schema、工具关联资源名称与实际Harness消费链仍未补；管理列表当前也未新增工具所需取消端口，不能直接声称完整工具已就绪。连接/schema/平台能力仍由可信Host注入，缺表不返回假空列表。详情见[node-agent-workspace-port.md](node-agent-workspace-port.md)。edit-check与diff通过；quality_delta对接口方法的未调用提示及整树并行门限仍在，不宣称全仓质量门通过。

## 工作区公共查询取消边界（2026-11-14）

A交接范围内给公共列表/runtime/读端口增加可选signal，旧Host一参接口不变；实际Kysely reader等待查询及结果处理完成后传播取消，预取消零读取，不用race假报清理完成。该适配不强制终止服务器SQL，Host的查询超时和HTTP断开signal尚需接线。

原SQLite12项断言保留，新增5项deferred/实际SQL结果plugin回归，现17/17；PG隔离1/1新增表锁+单连接池取消与复用验证，Host4/4、Python工作区19/19及Core整合21文件394通过，均0失败/跳过，相关类型检查通过。临时实例与数据已清理；SQL结果plugin屏障不被当作连接仍占用的证据，连接复用另由实际PG测试保护。细节见[node-agent-workspace-port.md](node-agent-workspace-port.md)。edit-check/diff通过；整树quality_delta仍有并行与小查询克隆门限，不宣称全仓质量门通过。

工作区工具仍缺正式SQLite schema、完整关联资源名称及生产Harness接入，不升级工具状态。本轮未新增ToolDefinition、改动共享schema/main、运行配置或workspace依赖。

## 正式工作区SQLite迁移门槛审计（2026-11-14）

只读核对schema10的session/task NULL限制和精确结构验证后，确认不能仅增加列表合成表或直接松CHECK。完整表/owner/唯一/软删、真实目录/ACL、独立任务授权及带备份版本迁移策略已交领域会话，见[node-workspace-sqlite-migration-boundary.md](node-workspace-sqlite-migration-boundary.md)。负责人先完成通知/Agent交互联合schema11，再串行决定工作区完整切片；本任务未改共享schema或版本。

本轮仅只读源码审计与文档更新，未重复运行既有Node/pytest或将其记为新增通过；另一次独立SQLite内存实验确认复合FK的SET NULL会同时触及owner，NOT NULL owner会导致删除失败，作为删除语义设计依据而非迁移验收。现有工作区工具仍依赖阻塞。

## 既有工作区会话绑定公共化（2026-11-14）

Core新增createWorkspaceBindings公共用例与Kysely PG/SQLite事务适配；原Web Host PG绑定实现已改为委托公共用例，保留owner限定SQL、会话行锁和原HTTP语义。没有新增ToolDefinition、共享schema或main接线；列表/详情工具仍依赖阻塞。端口、信号边界与正式SQLite限制见[node-agent-workspace-port.md](node-agent-workspace-port.md)。

真实临时SQLite12/12、独立临时PG环境Host路由与数据库3/3、Core工具/技能及相关查询选集23文件408、Python最近邻工作区19/19通过，均0失败/跳过。PG保留旧断言并新增公共适配器对照及取消回滚验证；SQLite不是正式schema。相关类型检查和diff通过；首次Host括号语法错误修复后重验通过。未验收真实用户库/Redis、平台执行或生产Agent消费链，不将这些测试计为工具已接入。未改运行配置、workspace依赖或共享schema，工作区其他会话修改保留。

## 既有工作区声明删除公共化（2026-11-14）

Core新增createWorkspaceDeleter及实际Kysely PG/SQLite事务端口，原Web Host删除实现已委托公共业务。保留owner声明锁、同owner会话解绑、普通任务停用、外键清引用和父/物理资源保留；没有新增Agent危险工具、共享schema或main装配。`unlink_workspace`仍依赖可信确认与生产Harness，不升级工具状态。外键/退役数据边界见[node-agent-workspace-port.md](node-agent-workspace-port.md)及[正式SQLite迁移门槛](node-workspace-sqlite-migration-boundary.md)。

SQLite合成FK真实事务14/14、隔离临时PG4/4、原Host脚本端口3/3和认证路由2/2、Core选集24文件422、对应Python2/2通过，均0失败/跳过，相关类型检查/diff通过。PG旧断言不变，新增实际Core适配和AFTER DELETE故障/取消回滚；五项Host端口/路由使用替身，不冒充真实PG或工具链。首次Python选择器错误修正后重跑，未改旧断言。未验收正式SQLite schema、真实用户库/Redis、平台执行或生产Agent链；整仓质量门未宣称通过，所有其他会话修改保留。

## 既有日历管理读取公共化（2026-11-14）

Core新增createCalendarEventReader和实际Kysely PG/SQLite读端口，Host保留原SQL并委托共享用例，现有main/routes消费不变。复用原DTO与year/month真值/前缀规则、owner和软删过滤，未修改事务内findOwnedActiveEvent。公共入口仅追加calendar导出；未改schema/main/package或运行配置。管理查询不包含Agent要求的范围/type/limit/提醒聚合，`list_events`仍依赖阻塞。详情及替身边界见[node-agent-calendar-port.md](node-agent-calendar-port.md)。

正式临时SQLite8/8、隔离临时PG经真实Fastify/两种SQL适配及表锁取消3/3、现有Host路由6/6、Core相关选集25文件430、新增Python管理基准3项与原Agent读基准2项（共5/5）通过，0失败/跳过，相关类型检查/diff通过。Python新基准直接验证原handler，不修改生产Python或放宽旧断言。PG观察真实pg_locks后才取消，并验证释放后单连接复用；认证为合成账号，不连接真实用户库。全仓测试元数据仍有大量其他文件缺登记，整树质量门仍有并行阻断，不将局部通过写成全仓完成；实际外部服务、Redis和Agent生产调用未验收。

## 既有项目管理读取公共化（2026-11-14）

Core共享项目list/get/file-count组合与DTO，复用原项目仓储及计数投影；Host保留PG SQL并委托，原main/routes消费有效。创建/更新私有重复DTO改复用同一投影，事务/Undo/文件操作未动；按Python标准JSON基准校正损坏阶段回[]、合法错误结构失败。管理fileCount不是Agent实时文件概览，不新增工具/生产Run。正式SQLite计数投影仍缺，旧Node时间空格分隔与Python T格式的差异仍明确未对齐，不能称完整API等价。见[项目读取端口与回归](node-project-read-port.md)。

SQLite正式项目仓储+显式合成count表7/7、隔离PG读取3+旧创建/更新2（共5/5）、原Host相关27、Core选集26文件437、Python新增管理基准4+原项目回归5（共9/9）均通过，0失败/跳过，相关类型检查/diff通过。PG无files表，不扫描文件；计数为合成投影且不验证维护触发器，认证/事件为受控依赖，真实用户库/Redis/文件后端及生产工具链未验收。未改共享schema/main/package或用户配置；整仓质量/元数据既有阻断仍在，未覆盖他人改动或提交。

## 项目公开时间兼容与完整消费者回归（2026-11-14）

原样提取utc至可移植domain模块，data/codec保留兼容出口及内部canonical/databaseTime编码；仅公共projectResponse对齐Python数据库路径的UTC ISO（T/+00:00、非零六位微秒、零省略），createdAt先归UTC再取日期。真实list/get、create/update/restore响应及事件共用投影；Undo/redo仍为ID-only事件，不改内部快照、SQL时间或其他域协议。关闭前一阶段记录的公开时间差异，不把这项修复当全部项目API/Agent工具完成。见[项目公共时间回归](node-project-read-port.md)。

三方冻结统一build后标准Core unit77文件1467、隔离PG标准19文件34、Host项目真实PG9、原Host36、定向时间/读取30及Python13均通过，0失败/跳过；相关类型检查/diff通过。真实PG非UTC会话和精确微秒、恢复事件、Undo后重读及内部存储未变均有断言。旧错误时间预期改为精确Python协议而非放宽；没有修改Python生产代码、共享schema、main、运行配置或包依赖。临时数据/实例已清理，冻结窗口归还；真实Redis、生产AgentRun及平台后端仍未验收，工具状态不升级，整仓质量/元数据其他阻断不宣称已解决。

## 现有Web全局搜索公共化（2026-11-14）

Core共享原Web解析、来源能力、查询快照、分组及实际查询；Host保留原接口薄装配，main和Mind引用建议调用继续消费。PG实际11来源迁入同一服务并保留B修复的消息查询42P18三参数回归；SQLite正式三域project/client/event实际接通，其余来源显式不可用。文件导航再次owner过滤、Skill/MCP不外发正文/凭据、会话标题优先/消息去重与候选8条、错误不返回部分成功，均有行为证据。详见[全局搜索公共服务](node-global-search-port.md)。

Core真实正式SQLite8/8、隔离PG认证Host搜索12/12（原7+全11来源/并发取消/缺表拒绝等新5）、Python23/23均通过，0失败/跳过，相关源码/测试/Host类型检查、diff和协调build通过。PG在真实锁等待中取消并验证排空/连接复用，测试实例已停止清理。原Node casefold/strip、拼音/罗马音与SQLite后端差异仍未对齐；SQLiteconversation独立端口由聊天会话继续实现，当前不开放。不新增Agent工具/生产Run，不把公共接口或Web真实查询等同Agent工具迁移完成。未改schema/main/app/package或用户配置，整仓质量其他阻断仍在。

## SQLite会话搜索独立来源的只读边界（2026-11-14）

聊天会话交接后，将独立来源的BEGIN IMMEDIATE事务改为单条只读SQL，在同一语句快照校验owner全部时间并查询有界候选。共享纯SQL时间谓词保护完整六位微秒、Gregorian日期、NUL及UTF8/UTF16编码；群昵称领域复用同一谓词。未增加Agent工具、公共SQLite来源、Worker命令或Host装配，工具状态计数保持不变。

正式临时SQLite会话10项及已接三来源8项共18/18、隔离真实PG/SQLite对照3/3、对应Python搜索23/23均通过，0失败/跳过；测试类型检查与diff检查通过。保护写保留锁期间可读、提交前后快照、取消等待真实处理清理、事务连接复用、owner约束、排序/角色/候选窗口及非法未命中时间拒绝。取消钩子是结果处理门，不证明同步SQLite查询可中途打断。测试实例/schema/目录已清理。

实际发现PG/SQLite反斜线匹配不同，仍缺语言规范化/拼音与Worker路径验收；全owner时间检查的规模成本未解决，所以conversation继续不开放，不能称双库全量等价。细节见[node-global-search-port.md](node-global-search-port.md)。edit-check未报告签名不兼容；全树quality_delta仍有19项门禁及新来源复杂度18提示，不宣称整仓质量通过。修改保留在脏工作区，没有提交或改用户运行配置。

## 搜索查询Unicode归一化（2026-11-14）

复用共享Python空白strip，并以生产Python3.14/Unicode16完整casefold表去重；保留strip→64码点截断→fold键去重顺序及原始关键词，response.query同步修正。生成器仅维护固定Unicode数据，不读运行配置；完整标量独立Python摘要、29空白集合及实际SQLite/认证HTTP-PG的AND结果保护迁移语义。共享strip经工作台会话交接改双端扫描，原领域语义不变。

当前Core标准unit80文件1491/1491、定向SQLite21/21、隔离Host搜索13/13、双库对照3/3、Python搜索30/30均通过，0失败/跳过，相关构建/类型/生成物/diff通过。数据库原生匹配、消息片段、拼音/罗马音及Worker路径仍有未完成项；不新增ToolDefinition或开放SQLite conversation，不升级生产工具状态。详见[node-global-search-port.md](node-global-search-port.md)。未改Harness/main/app/schema/package/运行配置，其他会话修改保留。

## 搜索消息片段与SQLite转义整合（2026-11-14）

Core消息片段保持Python先casefold选词、再lower定位、按码点切原文的顺序；复用Unicode16表并补lower差异和Final_Sigma上下文，不依赖Node新版Unicode。保留前60码点回退、24窗口、Python空白/LF及lower展开后的原文位置行为。22共享Python样例、全标量与两侧Sigma独立摘要保护兼容；真实认证HTTP-PG消息验证fold命中但lower未命中不能改选后词、BOM和控制空白不误处理。

同时整合聊天会话的独立SQLite conversation ESCAPE修复，真实双库覆盖转义%/_、尾/双反斜线、通配符和消息。最新Node定向44/44、Host搜索14/14、真实双库3/3、Python52/52通过，0失败/跳过，构建/类型/生成物/diff通过。工具状态不升级，公共SQLite仍三来源；非ASCII数据库匹配、其他来源反斜线、Python拼音/罗马音、Worker/规模与Host Run装配继续未完成。详见[node-global-search-port.md](node-global-search-port.md)。

## 固定数字版本保护既有工具写入（2026-11-14）

修复Node所带Unicode18比生产Python16多接受10个Nd字符的差异；原helper会将这些Python拒绝的字符串转成真实ID。工具整数、日期、文件行号及经工作台会话交接的项目编号现在共用domain固定规则：760个Nd/76组与888个isdigit分别判断，未知字符不转换，非十进制Digit按Python项目计数的失败语义报安全错误。旧工具helper路径兼容转出，不复制业务或数据访问。

真实registry→临时SQLite验证未知数字/前缀/混合形式不能写入目标联系人，重读备注不变；registry→packages/fs验证新数字不能选中物理第2行且不改文件。全标量Python摘要、实际日期与项目编号行为保护分类/转换的版本边界。最终Node工具/技能与domain20文件377/377、定向151/151、Python schema/project150/150通过，均0失败/跳过；Core build、顺序测试类型检查、生成物check与diff通过。临时授权与文件resolver、Python确认Redis为替身，没有新增真实PG/Redis、平台或生产Run验收。

细节及一次构建/类型检查调度重叠的纠正见[node-agent-input-contract-parity.md](node-agent-input-contract-parity.md)。新测试元数据已登记，全树质量门其他阻断仍在；工具状态与生产接入数不升级。未改Harness/main/app/schema/package或运行配置，所有其他会话修改保留。

## 既有工具的安全输入修复回执（2026-11-14）

注册器按每调用收集已发生的归一化事实，仅向成功普通对象输出input_adaptations；固定规则名与可信Schema路径不包含参数值或未知键。保持Python的legacy→type→项目阶段业务标签顺序；update_client声明顺序对齐其Python基准。普通arguments解包不造标签，未知字段名ignored_fields及任意wrapper键回显策略仍未迁移，不宣称完整输入协议等价。

新16项实际registry回归覆盖返回结构、冻结对象/并发隔离、伪造反馈、读取消/写提交后取消及unknown；真实SQLite联系人创建/修改同时断言修复回执和持久化重读。最终标准Node工具/技能与domain21文件393/393、Python schema/isolation/project158/158通过，0失败/跳过，Python7条既有弃用提示；构建通过。项目领域port、授权、Provider/RunStore与Python确认Redis有明确替身，未新增真实PG/Redis、平台或生产Host/Run验收。

实现位于tools/normalize-input.ts、registry.ts与clients.ts，测试及边界详见[node-agent-input-contract-parity.md](node-agent-input-contract-parity.md)。edit-check无签名不兼容，quality_delta仍有19项整树门禁及归一化/注册器复杂度与体积提示，不宣称全仓质量通过。未修改Harness/main/app/schema/package或用户配置，不升级工具状态；其他会话留下的Mind/共享事务桥原型未纳入本切片功能验收。

## Host 工具后端能力门与只读调用链（2026-11-14）

Host 工具工厂允许缺省项目创建 runtime；即使授权允许 `create_project`，缺少真实创建后端时也不注册该工具，已有授权的只读工具仍可使用。项目创建类型从共享 `@gugu/core/project-create` 引用。此能力门不改变生产 Run 装配或工具迁移状态。

工厂行为测试 7/7 通过，覆盖缺少后端时不开放写工具、权限与执行期撤权；Core 和授权依赖为测试替身。独立 Host runtime → 实际工具注册器 → 隔离 PostgreSQL → Provider 续轮 1/1 通过，覆盖联系人和项目列表、可信时区、跨 owner 隔离、撤权及缺少创建后端时不暴露写工具；Provider 传输、RunStore、租约及授权为测试替身。Python 时间、能力注册和项目工具基准 31/31 通过，0 失败/跳过；Host 类型检查和 diff 检查通过。临时 PostgreSQL 已停止清理；未验收真实 Redis、外部 Provider 或生产 Agent Run。

## use_skill 的 Host 可选注册（2026-11-14）

Host 工具工厂接受可信 `UseSkillPorts`（技能注册器及来源查询），仅注入时注册 `use_skill`，仍逐次由 Host 授权；未提供能力时即使授权也不开放。测试从临时 Markdown 文件头解析并注册技能，再经 Host 工具注册器读取正文，验证跨 owner 不泄漏、撤权后不可执行。来源、授权与其余业务依赖为测试替身；这不是生产技能资源装配。

Host 工厂 8/8、Core 技能解析/注册及工具行为 33/33、Python 技能 ID 与用户技能基准 24/24 通过，0 失败/跳过；Host 类型检查与 diff 检查通过。Node 行为保护 Markdown 注册、调用及权限；Python 基准另覆盖用户技能管理，不能替代真实用户技能存储验收。生产 Run 尚缺可信 Markdown 文档来源、Skill catalog/loadedSkills 和来源/授权装配；工具仍计入已实现待接入，未验收真实 Redis 或生产 Agent Run。

## use_skill 的独立 Runtime 续轮与授权依赖（2026-11-14）

新增实际 Host Runtime → 工具工厂 → 临时 Markdown 文件头注册 → 技能正文 → Provider 续轮回归，验证技能被模型实际收到，发现后撤权则不泄露正文；Node 1/1 通过。Provider 传输、RunStore、租约、授权、上下文源及未用的 Core 仓储为替身；不代表生产资源或 Run 已装配。技能基准 Python 24/24、Core 33/33 和 Host 工厂 8/8 见上一节，均 0 失败/跳过。

授权盘点：Python Web 聊天入口使用认证身份构建 `source=web` 的本轮请求，工具白名单与 IM 角色为默认空值；Web 可打开 owner 的既有 IM 会话，不能从会话来源推断本轮来源。Node 的请求认证检查账号状态和安全版本，但尚无跨恢复可信绑定本轮来源及逐调用重查账号/版本的工具授权总装；`accessScopeHash` 本身只绑定外部提供的版本，不能替代权限事实。已向聊天会话交接 Web 受限授权端口、运行中撤权、恢复校验与危险工具确认要求。生产 Run、真实 Redis 和外部 Provider 未验收，工具状态不升级。

项目创建另需验证跨版本恢复重试：Node 的幂等范围包含 run/round/call，Python 历史键使用 session/create_project/call；不能仅凭当前测试认为旧收据可重放。已交聊天会话协调恢复契约。

联系人写入真实 Runtime 回归正在补充：新增 `client-tools-runtime-postgres.test.ts`，拟经独立 Host Runtime、真实注册器和隔离 PG 跨 Provider 轮次创建/更新联系人并验证跨 owner 写入失败。首跑发现测试把错误 wire 值误当对象，修正后复跑因本机可用空间不足导致临时 PostgreSQL 初始化失败；修正版本尚未验收，撤权场景亦未加入。测试使用 Provider、RunStore、租约、授权和上下文替身，临时数据库已停止清理。并行 Undo 改动期间 Host 类型检查报错，需共享源码冻结后复验；不据此改变工具状态。

联系人写入回归后续复验：隔离 PG 空间窗口协调后，Host Runtime → 实际工具注册器 → Core 仓储 → PostgreSQL → Provider 多轮测试 1/1 通过；真实重读确认成功创建/更新，跨 owner 访问不改变对方数据，能力发现后撤销更新权限不改变本人或对方数据。Python 联系人相关 Core 桥与 schema 安全对照 28/28 通过，均 0 失败/跳过。Provider、授权、RunStore、租约和上下文源为替身；临时 PG 已停止清理。上次首次失败和磁盘不足记录保留，未以此升级生产状态。

## 工具权限纯规则（2026-11-14）

Core `filterToolNames`/`canUseTool` 对齐 Python 工具发现与派发的纯规则：区分无限制和空白名单、保留白名单顺序、时间及固定工具、群公共链接、技能管理角色、平台文件限制和群自动回复选择。规则输入必须由可信 Host 明确提供，缺失上下文报错；注册器、Host 能力、实际身份与危险确认仍各自生效，不在生产工厂默认开放。Node 规则和真实注册器撤权行为 5/5、Python IM 权限与群回复对照 57/57 通过，0 失败/跳过；Core 源码类型检查和 diff 检查通过。首次 Vitest 因新测试未登记分类而启动失败，串行登记后复跑通过。

Python Web 新聊天、续看和取消在请求时检查账号版本；尚未证明旧后台运行会因版本变化自动中断。持续撤权是未来安全加强，不能作为已验证的 Python 既有行为。生产 Web/IM 本轮来源及恢复可信绑定、授权端口、生产 Run 仍由聊天会话负责；此纯规则不升级任何工具的生产状态。

后续统一 Core build 与 Host 类型检查通过；Core 测试整体类型检查当时因并行 Undo 测试 TS2775/TS6133 失败，已交工作台会话修复，权限测试未报告类型错误。未运行真实 Redis、外部 Provider 或生产 Run。

`use_skill` 独立 Host Runtime 续轮回归追加真实上下文内的二次调用：第一次经 Markdown 注册器读取并发送正文，第二次通过 Harness 已加载摘要返回 `already_loaded` 且不再发送正文；发现后撤权仍拒绝。Node 1/1、Python 技能 ID 与用户技能对照 24/24 通过，0 失败/跳过；Host 类型检查及 diff 通过。Provider、RunStore、租约、授权、上下文源及未用 Core 仓储为替身，仍未接通生产 Skill catalog、可信文档来源或 Run，不升级工具状态。

## 项目创建真实 Runtime 与幂等边界（2026-11-14）

独立 Host Runtime → 工具工厂 → 共享项目创建 → 隔离 PostgreSQL → Provider 续轮回归 1/1 通过，分别以两个 owner 创建并核对实际持久记录；同测试另经过真实注册器和 PG 验证相同调用重放返回原项目、不同参数冲突不新增记录。Python 项目工具及上下文对照 28/28 通过，0 失败/跳过；Host 类型与 diff 检查通过。Provider、授权、RunStore、租约和上下文源为替身，临时 PG 已停止清理，生产 Run 未验收。

仍需核对的契约：Node 业务 CoreError 当前返回 `{success:false,error,error_code}`，Python 的幂等冲突 handler 返回 `{error}`，部分字段错误返回 JSON 字符串；须对照完整 dispatch 和 Provider 输出后处理，不能把本次正常路径测试视作错误结构等价。Node 新 run/round 幂等键也尚未证明能重放 Python 旧键记录。`create_project` 继续计为已实现待接入。

项目创建错误投影复核：Python dispatch 先对 handler 返回值补错误信息并脱敏；幂等冲突是对象，领域字段 ValueError 是 JSON 字符串。Node Harness 的 `context.afterTool` 先把 `result.value` 写入模型上下文，之后调用 `presentToolResult` 仅用于工具事件展示，故不能通过后者修复模型可见结果。当前 `error_code=invalid_request` 不能可信地区分领域校验与身份等错误；已向聊天会话交接在上下文写入前保留可信错误来源及持久化、分别投影内部结果和模型结果的需求，不按文案猜测，也未更改既有断言。Python 历史调用键能否跨版本恢复仍由 A/B 核实真实 checkpoint 和切换契约；未据猜测改键或声明兼容。

历史收据后续核实：当前 Python 运行状态没有导入 Node 加密 Harness checkpoint 的路径。普通 Node 新 run 若仅凭 session/call 尝试命中 Python 旧键，可能合并不同 run，不能盲目双查；将来若支持接管 Python 在途调用，须提供可信身份映射，并在同一事务内校验 owner、fingerprint 和未知副作用。A/B 已接手核实及跨版本恢复设计，旧数据恢复责任仍保留。

Meta 工具复核：`get_tool_schema` 除可信权限过滤外还须把声明放入后续模型上下文并持久恢复；`call_tool` 必须在 Harness 计划前有限层解包，以真实目标执行授权、schema、确认与派发，保留外层调用 ID、artifact 和 unknown。将其作为普通 handler 再嵌套 dispatch 会改变调度和确认边界，已交聊天会话处理，仍为依赖阻塞。

## 时间工具固定偏移与项目错误来源（2026-11-14）

时间工具现能消费可信 Host 提供的 Python `UTC±HH:MM` 固定偏移名：只转换供 Intl 使用的标识，结果保留原名称；模型参数不能更改时区，非法偏移仍安全失败。真实注册器行为回归覆盖正负偏移、跨日与非法值；Python 合成固定时钟两种偏移输出逐字段一致。Node 时间与项目创建端口 21/21、Python 时间 pytest 1/1 通过，0 失败/跳过；Core 源类型检查、diff 通过。秒/微秒偏移未验收，Host 的缺失/无效用户时区回退及生产 Run 尚未接通，不升级工具状态。

共享项目入口新增字段校验专用错误类型后，Agent 自有字段映射也使用相同可信分类；身份、幂等与事务/提交错误不按文案猜测。当前端口仍保留原内部错误结果，模型结果的独立投影和恢复持久化未接入；Python 的先查幂等后校验与 Node 当前顺序差异仍须核对，不能宣称错误协议已对齐。

时间固定偏移后续复验：串行统一 Core build 与 Host 类型检查通过；独立 Host Runtime → 注册器 → 隔离 PG → Provider 续轮 1/1 通过，新增可信 `UTC-03:30` 的实际 wire 日期、时间与时区断言，并重验 owner 数据。授权、Provider、RunStore、租约与上下文源为替身；Python 两组合成偏移对照见上一节。真实 Host 时区回退和生产 Run 未装配，秒/微秒偏移仍未验收，不改变工具状态。

项目错误模型编码进一步核对：Python 幂等冲突对象和字段校验 JSON 字符串经过 dispatch 后，最终送模型的都是 JSON 对象文本；当前 Node 上下文对模型值执行 JSON 序列化，若把预序列化字符串作为 `modelValue` 会发生二次编码。因此项目的这两类可信错误应投影为经安全处理和增强的对象，保留内部原值与错误码；该结论不泛化至任意字符串结果。聊天会话正在实现模型值的 checkpoint、引用和恢复契约，接口未冻结，工具尚未接入。

## 项目创建模型错误与幂等顺序（2026-11-14）

共享项目服务明确区分字段校验与同 owner/key 的 fingerprint 冲突；工具仅对这两种可信分类生成脱敏、增强后的模型对象，内部结果和错误码保留，身份/其他同码错误不冒充字段错误，事务提交未知仍为 unknown。Harness `modelValue` 的持久化、旧检查点与多模态引用由聊天会话单独验收；本工具模型值经 Host Runtime 进入 Provider 后只需一次 JSON 解析。跨版本 Python 在途 run 尚无可信映射，不盲查旧键。

工具改用共享 Agent 延迟字段入口：registry schema 与可信身份仍先检查；同一事务先查 owner/key 的原始 fingerprint，命中重放或冲突，未命中才执行字段映射与领域校验，Web 创建路径不改。真实 SQLite 注册器与隔离 PG 验证同键合法创建后改为非法日期或空阶段均先报冲突、不新增；无收据的非法日期仍报字段错误。Node 项目工具 31/31、Host Runtime/PG 1/1、Python 项目与 schema 安全对照 46/46 通过，0 失败/跳过；统一 Core build、Host 类型检查和 diff 通过。首次 Host 新测试误把 checkpoint 封套当原值读取而失败，改为检查封套载荷及 tool_done 后复验通过。Provider、授权、RunStore、租约和上下文源是替身；工具专属重启恢复、真实 Redis、外部 Provider 与生产 Run 尚未验收，状态不升级。

## 定时任务列表工具与项目结果恢复（2026-11-14）

新增 `list_scheduled_tasks` 工具及 Host 工厂可选 `scheduledTasks` 端口，复用共享 owner-scoped 只读 reader/Agent 投影；缺端口或授权时不开放，模型不能指定 owner 或平台能力。查询仅包含独立任务、不触发 Web 清理；workspace 与文件授权标志由可信 Host 能力决定。正式 SQLite 真实注册器回归 1/1、Host 工厂 9/9、隔离 PG Host Runtime → Provider 续轮及项目 Runtime 重建共 2/2、Python 定时规则/工作区/交互对照 68/68 通过，0 失败/跳过；统一 Core build、Host 类型检查、diff 通过。测试保护双 owner、提醒过滤、排序、能力开关、发现后撤权、预取消、缺表错误脱敏及查询前后数据不变。Python Redis 确认、Node Provider/授权/RunStore/租约和上下文为替身；真实 Host 平台能力、真实 Redis、生产 Run 和真实外部服务尚未验收，SQLite 正式 schema 不能保存非空 workspace/grant。共享 reader 的其他边界和 Web 验收由工作台会话维护。

项目冲突错误 checkpoint 后关闭首个 Runtime、同进程重建并恢复，模型续轮仍收到单层 JSON，内部错误码保留，真实 PG 项目不重复写入；RunStore/租约/Provider/上下文为替身，这不等于操作系统进程重启或生产恢复。先前模型错误测试首次误读 checkpoint 封套的失败记录仍保留。

联系人字段错误对照：使用临时 pytest、旧版真实 `registry.dispatch` 和隔离内存 SQLite 验证空白名称，模型收到增强后的对象，错误为 `工具 create_client 执行出错：ValueError: 联系人名称不能为空`；1/1 通过，测试替换诊断日志，不写用户数据或配置。Node 当前同一领域错误返回 JSON 字符串 `联系人字段无效`，尚未对齐。已交工作台会话在共享字段校验边界评估可信错误类型；身份、事务或提交未知不能按同一 code/文案冒充字段错误。此对照未增加生产接入数。

联系人字段错误补充基准：临时 Python pytest 经真实 registry 和隔离 SQLite 验证空白名称、名称201字符、邮箱301字符、电话51字符，共 4/4 通过且无新增记录。空白名称产生 `ValueError: 联系人名称不能为空`，三个超限场景产生 `ValueError: 联系人字段超过长度限制`；dispatch 添加工具出错前缀与统一提示。诊断日志为替身，临时目录已清理。该结果已交共享联系人会话用于可信字段分类；Node 模型结果尚未对齐，状态不升级。


## global_search 工具切片（2026-11-15）

工具实现在 `packages/core/src/agent/tools/global-search.ts`，复用 `search/` 的查询归一、来源能力编排与实际 SQL 仓储，没有新增领域查询。Host 工具工厂新增可选 `search: GlobalSearchOperations`；只有共享服务与逐调用授权均齐全时开放。保留 `query`、旧 `q`、`queries`、OR/AND、类型筛选、每类固定 20 条及无命中提示；模型不能设置 owner、来源能力或结果上限。空词和非法 schema 输入拒绝执行；缺少任何请求来源时明确返回不可用，不能把缺后端当作无命中。

Node 工具回归 **5/5**：真实 Agent 循环 → 注册器 → 正式临时 SQLite → Provider 续轮，覆盖双 owner、软删过滤、查询不写数据、固定条数、关键词去重、AND、旧 q、空结果提示、非法输入、缺来源、发现后撤权、查询前后取消与 SQL 错误脱敏。Agent 的 Provider、RunStore、租约和上下文投影是显式测试替身；SQLite 来源实际支持项目、联系人和日历三类，其他来源未以假数据补齐。

Host 注册器回归 **10/10**（含本轮新增的搜索开关/授权用例）：工厂缺服务不开放，可信身份与取消信号传至共享服务，撤权后不调用来源；该 Host 用例的来源为替身，真实 SQL 在 Core 用例验证。Python `tests/agent/knowledge/test_global_search.py` 与 `test_search_query.py` 串行 **30/30**，使用基座隔离 SQLite。首跑在收集前因缺 `gugu_core` 失败，显式加入仓库 `compat/core-python/src` 后通过，不修改 Python 基准或运行配置。所有完成组均 0 失败/跳过。Core 测试源码类型检查、Core build、Web Host 类型检查及 diff 检查通过。

当前生产 main 尚未装配该工具的搜索来源，仍为“已实现待接入”，不增加“已完成并接入”计数。真实 PG/Redis、全来源组合、平台执行及外部 Provider 未验收。本轮未联系其他会话。日历列表继续等待日期范围/type/limit/提醒聚合；工作区列表继续等待关联资源 owner 名称及排序契约，不用管理接口或假端口冒充工具完成。


## 连续只读工具切片与领域工具组（2026-11-15）

新增 `get_upcoming`（`tools/overview.ts`）和 `list_trash`（`tools/trash.ts`），连续实现后统一验收。前者组合现有 owner-scoped ProjectService 与 CalendarEventReadPort，使用与时间工具共用的可信时区和时钟，保持默认7天、含首尾日期、未归档未完成项目、未删除活动和跨类型日期稳定排序；不新增SQL。后者复用现有回收站读SQL和顶层资源过滤，通过Agent投影保留SQL返回的微秒时间，不沿用Web展示的秒级截断；合并两个领域结果后统一限额、排序和满额提示。旧额外limit字段保持Python整数转换与1–100夹取（包括Nd数字、下划线、布尔、浮点和超大整数），超过Python默认整数文本长度限制时安全失败。

Host工厂按服务能力开放：近期待办要求日历与时钟同时存在，回收站要求真实只读端口；发现和派发均重新授权。工厂使用 `registerGroup` 的领域分组，`configure` 可按组关闭。项目查询、创建和修改定义集中到 `projects.ts`；事务适配和目标解析归 `projects/`；Skill使用归 `meta.ts`。原单工具路径已删除，调用方、导出、测试和元数据直接更新，无兼容转发。开发规范见 `packages/core/src/agent/tools/README.md`、`skills/README.md`，总目录文档提供入口。

本轮devserver证据：

- 全量工具行为回归23文件、379项通过，0失败/跳过；包含新工具7项、原项目创建/修改与输入/权限/确认回归。关键词搜索及既有工具未因分组被删除或放宽断言。首轮测试发现失败，刷新同步并核对两端清单一致后完整复跑通过。
- Markdown与Skill注册器28项通过；回收站4项补验通过，包含过长整数文本拒绝。
- Host工具注册器11项、原Web回收站3项、真实临时PG工具链1项共15项通过，0失败/跳过。PG用随机schema，验证独立文件/顶层目录、跨owner隔离、微秒排序、组禁用、撤权、取消及查询前后数据不变；实例和临时目录已清理。
- Python既有并发/owner隔离、回收站与schema安全基准55项，以及新增实际registry.dispatch的只读迁移合同2项，共57项通过、0失败/跳过。新增基准使用隔离SQLite、固定时钟及测试DB工厂，禁用诊断轨迹写入；不修改旧断言。资源耗尽期间首组Python运行主动中断，最终独立串行重跑通过，不将中断记绿。
- Core源码/测试类型检查与Core构建通过；Host生产源码类型检查通过。Host全量测试类型检查首轮失败在本轮未修改的 `tests/host/admin-analytics-main.integration.test.ts:37`（TS7022）；随后该测试的类型标注已更新，复验全量Host类型检查通过。本会话未修改该文件，保留首轮失败记录。diff检查通过。

真实SQLite验证近期待办；真实PG验证回收站。Provider、RunStore、租约与上下文投影为明确替身，Host能力与授权为测试实现；未验收真实Redis、外部Provider或生产main装配，两项仍为“已实现待接入”，生产完成数不增加。当前下一批阻塞仍包括日历范围/提醒聚合、工作区关联资源名称、文件与Skill生命周期后端及持久确认门；不以Web管理查询或只读端口替身冒充完整业务。仅因devserver内存和交换耗尽做过一次必要资源协调，没有常规跨会话进度通信。


本轮追加复核未据Web读接口升级工具状态：`mind/canvas-read.ts` 的列表固定最多200项，未提供工具所需total/分页计数和view；`note-read.ts` 只返回普通note，缺 `note_get` 所需全节点类型、关系邻居、references与物理行号；日历管理读端口缺范围/type/limit及提醒聚合；总览文件库计数只含部分空间/层级，不能代表所有未删文件。上述依赖未闭合，不创建假成功工具或空领域模块。

### 四组七工具及共享用例闭合（2026-11-15）

本批交付 `list_events`、`list_workspaces/get_workspace`、`get_dashboard_stats` 和 `update_project/set_color/archive_project`，均经过真实 Host runtime → 工具注册器 → 共享领域服务 → 隔离 PG → 下一次 Provider 请求。工具按旧 Python 日历、工作区、总览、项目四组组织；不新建单工具模块，也不改变 calendar/application 的既有领域结构。

- 日历共享读服务补齐日期含首尾、类型、默认50条/历史limit及批量提醒聚合；只读不清理任务，保留停用项、显式提前分钟、QQ投递模式与旧提醒 half-even 微秒边界。PG读取原始微秒，旧提醒 UTC 转 Asia/Shanghai 后推导；Python SQLite naive 本地时间与 Node UTC 存储编码不同，测试比较同一业务时刻而非假称原始编码相同。
- 工作区共享查询含停用项，按更新时间/ID倒序，关联名称和绑定会话数均按owner校验。workspace_id不授予Shell或物理目录操作权限；正式 Core SQLite 尚禁止会话 workspace_id 绑定，SQLite验收使用独立合同表，不代表升级器已安装。生产PG部署也须先具备相应领域schema。
- 总览共享计数覆盖全部存活文件、联系人和当天以后无上界的事件；项目排除归档/软删，不使用上下文限额或文件库根层计数。用户时区由可信Host注入。缺表报安全错误，不返回假零。
- 项目修改复用项目领域更新、CAS、阶段完成、文件前缀和Undo；在Core持久调用收据的同一事务内定位并修改。收据按owner/session/run/round/call分区，相同调用重放不重复改名、写Undo或发布；改参冲突、跨owner与撤权拒绝。registry.reconcile只查收据，不重做业务；Host不开放仅apply原型。
- 文件系统不属于SQL原子事务。明确的事务内失败补偿已移动目录；COMMIT/收据写入结果无法证明时返回unknown，仅查持久收据，不盲目反向移动或重试。无收据的未知状态仍需可信Host恢复流程，不能宣称跨存储故障已完全自动恢复。提交后通知为best-effort，不承诺outbox；Redis/生产推送未验收。
- 共用参数归一补齐可选字段显式空串策略，不改变必填/无策略/union字段；成功对象回执补Python未知字段提示，只报告固定安全字段名，其他用户构造的未知键归并为“[未声明字段]”，不回显键或值；此处刻意比Python的任意键名回显更严格。额外owner/timezone输入不能扩大可信身份或改变时钟。
- Python当前项目适配器用另一ORM映射执行UPDATE，已有对象的成功回执可能保留旧priority；新对照用例同时验证旧priority回执与刷新后的实际写入。Node使用提交后的项目记录，回执反映实际状态。这是已知回执差异，不宣称逐字等价；持久化状态、完成规则与owner边界按Python验证。

真实依赖：临时SQLite、临时物理目录、独立临时PG实例及随机schema；Provider transport、RunStore、lease、上下文、授权与通知消费为明确替身。生产main仍未装配Agent runtime/registry，真实Redis、付费Provider、平台Shell和正式SQLite工作区升级均未验收；七项统一为已实现待接入，生产完成仍为0。

验收结果见下方最终记录。首跑失败保留：SQLite正式schema不接受工作区绑定，改为独立合同库而非放宽生产约束；提醒合成cron重复修正为每行唯一；空type触发真实归一化缺口，补实现；新Python断言最初遗漏未知字段提示和ORM旧回执，按查明的现行Python基准分别断言，并保留真实持久化断言。未修改或删除旧断言。

未知字段提示曾导致时间/项目旧回执精确断言失败：按Python既有成功提示契约补充expected字段，原日期、可信时区、写入结果及意图断言全部保留，未改为宽松匹配。安全回归另拦住任意未知键名回显，实现改为固定安全名/归并，其禁止泄露断言原样保留。

#### 本批最终验收结果

所有执行均在devserver串行完成，测试使用临时目录/数据库，未访问用户配置或真实业务数据。

| 检查 | 结果 | 防止的回归 |
| --- | --- | --- |
| Core工具、Skill、工作区共享查询、日历读取，29文件 | 445通过，0失败/跳过 | 真实注册调用、参数及错误契约、owner、提醒微秒、文件副作用、项目收据/CAS/取消与重建恢复；保留原工具和Markdown技能回归 |
| Host五文件，含独立临时PG实例 | 17通过，0失败/跳过 | 七工具和既有读取进入Provider续轮、真实目录改名、PG收据与并发去重、可信能力缺失/撤权、技能加载；临时实例/随机schema已清理 |
| Python七文件串行 | 61通过，0失败/跳过，4条既有Redis setex弃用提示 | 实际注册器正常/非法输入、工作区命名空间及owner、日历提醒、项目完成/优先级/归档、危险操作确认与并行读取 |
| Core生产源码构建 | 通过 | 公共导出及真实调用类型 |
| Core测试源码类型检查 | 失败，TS6059 | 其他并行文件读取测试从Core rootDir外直接导入packages/fs源码；未放宽tsconfig或改动该测试 |
| Host全量类型检查 | 失败 | 并行调度模块number/undefined、Admin测试TS7022、Core上下文/Provider源码在Host ES2022 lib下的findLast/findLastIndex；本批文件未报告类型错误，不将全量失败记绿 |
| diff与测试清单JSON | 通过 | 无空白错误；新增测试分类与元数据有效 |
| ripwire edit-check / quality_delta | 两个注册器入口无不兼容调用；quality_delta退出2 | 与HEAD比较的大量未提交迁移及跨域克隆组仍触发6项门限，未批量ack、未为指标合并owner查询；不能宣称全树质量门通过 |

Python执行文件：`tests/agent/test_readonly_tool_migration.py`、`tests/projects/test_project_tools.py`、`tests/terminal/test_shell_workspaces.py`、`tests/scheduling/calendar/test_calendar_reminders.py`、`test_calendar_tools.py`、`test_regressions_datetime_and_version.py`、`tests/agent/test_parallel_tool_policy.py`。

Host执行文件：`tests/agent/agent-tool-registry.test.ts`、`read-tools-runtime-postgres.test.ts`、`get-project-overview-postgres.test.ts`、`trash-tools-runtime-postgres.test.ts`、`use-skill-runtime.test.ts`。成功提示对齐后，旧Host时间回执精确断言也补入Python字段，其他日期/时区断言保留；最终重跑全绿，之前失败不计为通过。

#### 本批文件与Host交接契约

- 工具层：`packages/core/src/agent/tools/{calendar,workspaces,overview,projects,contracts,definition-schema,normalize-input,registry,index}.ts`、`projects/mutation-port.ts` 与 `README.md`。工具分组沿Python领域，技能仍按Markdown frontmatter注册，没有引入新技能注册方式。
- 共享领域：`packages/core/src/calendar/application/event-read.ts`、`calendar/read-store.ts`、`workspaces/workspace-list.ts`、`data/workspace-list.ts`、`overview.ts`、`projects/project-update.ts`、`projects/update-store.ts`；仅追加Core根入口和既有data入口导出，不变更共享schema/package/workspace/lockfile。
- Host工厂：`apps/web-host/src/domains/agent-sessions/tools/agent-tool-registry.ts` 新增可选calendar/workspaces/dashboard/projectMutations；前三项分别注入完整共享读取、owner关联读取、计数端口，统计另需可信time。项目端口须具备apply/reconcile；实际目录授权/后端、身份、元数据、时钟和授权服务由Host负责，不能从模型参数获得。
- 测试：Core `tests/agent/tools/{domain-reads,project-durable,normalize-input,project-mutations,time}.test.ts`；Host `tests/agent/{agent-tool-registry,read-tools-runtime-postgres}.test.ts`；Python `backend/tests/agent/test_readonly_tool_migration.py`；对应 `packages/core/tests/suites.json`、`docs/testing/test-metadata.json` 仅更新本批条目。
- 文档：本清单、三份Agent领域端口说明、迁移任务清单及tools README。未改main/app总装、Harness/Provider/SSE/Run、用户运行配置；保留工作区其他会话的大量未提交改动，未fetch/提交/推送/触发CI。本批未与其他会话通信。

生产Host后续需装配上述能力与真实Run持久化/恢复、验证正式schema与文件授权，并为没有收据的跨存储unknown提供人工或可信恢复路径。本批不新增DB↔FS对账，不迁入OSS/S3/Docker旧生命周期。


### 项目阶段、笔记读取与元工具连续迁移（2026-11-15）

本批八项：add_stage、remove_stage、rename_stage、set_stages、update_stage、note_search、note_get、get_tool_schema。状态为已实现待接入，生产完成仍为0；前批19项与本批8项合计27项，剩余部分实现1、依赖阻塞80、退役/重设计1。逐工具表已同步，历史分批数量不回写。

项目五工具仍在tools/projects.ts，沿现有持久收据适配，在事务内解析目标、计算阶段意图、CAS写入、Undo及收据一起提交；恢复只读收据。共享纯领域用例projects/stages.ts复用稳定key/todo编号和replaceProjectStages，不复制SQL或造新执行器。按key优先、重名须限定、删除最后阶段拒绝、删除当前阶段切首项、整体重排保留key与省略todos语义；批量待办先校验移动目标，失败项零副作用，成功项一次提交。只传stage才切指针；携带add/todos时stage只限范围。部分成功仍返回每项错误，所有项失败不写项目/Undo；被拒绝的业务调用可有持久失败收据。继承前批提交未知不盲重试、跨文件系统恢复限制。Node回执使用真实提交状态；Python旧ORM缓存回执差异沿前批说明，不制造旧缓存值。

笔记组在tools/note.ts，复用Mind共享读取扩展mind/note-read.ts。搜索只召回note/canvas_note，详情可读同owner存活来源节点；与Web note-only读取投影分开，原Web合同不变。查询词复用共享搜索的strip/码点截断/casefold去重，OR/AND和数据库LIKE/ILIKE保留Python语义（包括通配符，不擅自转字面匹配），按captured_at倒序而非全局搜索相关性排序。默认5、上限10、摘要240码点；详情原始物理行号支持CRLF及Python换行集合，时间保留微秒。正文引用按顺序去重，排除围栏、行内代码与奇数反斜线转义；项目/文件/活动名称按实时owner和软删过滤，不信任Markdown显示名。一跳关系和正文引用独立，失效/跨owner端点不泄漏；Python当前list_node_relations未按关系deleted_at或canvas可见性附加筛选，此行为保留，不能误称全部关系均为活动边。

get_tool_schema在tools/meta.ts调用当前注册器capabilities和既有selectToolSchemas，按当前授权/组开关发现；支持前缀、去重、12项上限及rejected，不执行目标、不扩大授权。沿Python返回tool_schemas名称选择回执，完整定义来自可信注册器；没有另造动态执行框架。Host不需要数据库后端即可开放此元工具，但其自身和目标均受现有授权检查，未装配笔记服务或持久修改能力时不能发现那些工具。

Host新增可选notes服务；阶段五工具和前批项目修改共用projectMutations完整apply/reconcile端口。元工具由同一注册器闭包读取最新capabilities。缺能力、撤权、整组关闭在实际调用中阻断；没有修改生产main、Run、Provider、SSE、共享schema/package或运行配置。Skill继续按Markdown frontmatter注册，本批未改技能注册制度。

真实验收使用临时SQLite、正式Core Mind/日历表、显式合成文件合同表、临时PG实例与随机schema；真实SQL、事务、CAS、Undo、收据和查询不是测试替身。Provider transport、RunStore、lease、上下文来源、授权判定和通知消费为明确替身，未用真实用户库、Redis、外部模型或平台执行。正式SQLite文件库schema、生产Run接线及发布通知可靠投递仍未验收。

首轮问题已定位：新用例最初误以为项目创建默认current_stage=s0，实际为空，改为在相关用例显式执行切换再验证“保持当前阶段”；七行正文的行号预期补全、Provider观察改为fixture实际stream调用，保留完整内容断言。真实PG暴露captured_at微秒投影别名与ORDER BY重名，已改为原表限定排序，保留微秒/顺序断言；未放宽原测试。Core测试类型检查发现新夹具错误使用不包含calendar_events的基础Database类型，改为参数化SQL插入相同合成行，没有修改共享schema或放宽类型。

最终验收和具体文件见下方记录。


#### 本批共享接口与修改文件

- 工具组：packages/core/src/agent/tools/projects.ts（新增阶段/待办五工具，执行与恢复共用处理器）、projects/mutation-port.ts（同事务计算及安全结果收据）、note.ts（笔记两工具）、meta.ts（Schema发现）、registry.ts（set_stages名称简写回执）、index.ts与README.md。
- 共享用例：packages/core/src/projects/stages.ts、mind/note-read.ts、Core根index.ts。阶段纯规则公开为prepareProjectStageChange；Host笔记端口为createAgentMindReader(db, backend)，提供search(owner, args, signal)/get(owner, id, signal)，模型不提供身份和后端。
- Host仅改domains/agent-sessions/tools/agent-tool-registry.ts工厂：可选notes，复用完整projectMutations，get_tool_schema回读自身最新capabilities；未动main/app/Run总装。项目组八种写工具共用同一收据域，不同意图复用调用标识会冲突。
- 测试：Core tests/agent/tools/project-durable.test.ts与note-reads.test.ts；Host tests/agent/agent-tool-registry.test.ts与read-tools-runtime-postgres.test.ts；Python backend/tests/agent/test_readonly_tool_migration.py。同步本批suites、测试元数据、工具README和迁移任务清单。
- 安全补充：部分成功的嵌套error在写调用收据前复用现有Core递归脱敏投影，正常正文保留；实际Agent续轮与直接查询收据同时断言无合成密钥/路径泄漏。旧待办缺done/text时，回执按Python空值投影，不把undefined带进可持久化结果。阶段名简写保留Python的stages:stage_names_to_objects回执。

剩余依赖未被掩盖：项目删除、任务危险操作仍缺完整确认/可信执行链；笔记写入仍需Agent块/行编辑协议、捕获日期和领域写入生命周期接线；Skill管理缺用户来源与统一持久注册管理；call_tool/ask_user需要现有交互和恢复语义闭合。正文关系/引用读取完成不代表这些写工具完成。

本批未与其他会话通信，未fetch、提交、推送、运行Docker或触发CI；用户运行配置未改变，保留共享工作区其他未提交改动。生产main未装配真实Agent调用方的盘点仍成立。

#### 本批最终统一验收

所有构建和行为测试均在devserver串行完成；临时PG实例、随机schema和测试目录已清理。

| 检查 | 最终结果 | 保护的业务与边界 |
| --- | --- | --- |
| Core工具/技能、工作区共享查询、日历读取30文件 | 457通过，0失败/跳过 | 原有工具与Markdown技能回归；本批阶段/待办、笔记关系/引用、Schema发现、owner、取消、持久收据及嵌套错误脱敏 |
| Host五文件，独立临时PG | 18通过，0失败/跳过 | 八个新工具真实进入Provider续轮；五种阶段操作按明确顺序分别运行，持久Undo/收据正确；重建恢复不重做；两个注册器并发同一阶段调用仅提交一次 |
| Python三文件串行 | 44通过，0失败/跳过，2条既有setex弃用提示 | 真实注册器与旧handler双层基准；阶段key/待办身份、重排、失败项零副作用、笔记与来源隔离、正文引用/关系、Schema选择 |
| Core生产源码构建 | 通过 | 本批公共导出、工具契约与共享调用类型 |
| Core测试源码类型检查 | 未通过 | 剩余其他文件读取测试直接导入packages/fs源码引发TS6059；本批夹具类型问题已修复，未放宽rootDir或改动其他测试 |
| Host全量类型检查 | 未通过 | 并行onboarding/filesync等新增导出与Core上下文/Provider在Host ES2022 lib下的findLast/findLastIndex错误；本批文件没有类型报错，未扩改其他会话入口或tsconfig |
| ripwire edit-check/quality_delta | 本批范围无不兼容调用；限定本批源码的delta gating=0 | 检查现有入口消费；未对整个共享工作区宣称质量门通过，未写入批量ack |
| diff/测试清单JSON/逐工具统计 | 通过 | 新测试登记有效；109项分别为待接入27、部分1、阻塞80、退役/重设计1 |

Node主回归命令选择tests/agent/tools、tests/agent/skills、tests/unit/data/workspace-list-query.test.ts、tests/calendar。Python选择tests/agent/test_readonly_tool_migration.py、tests/projects/test_project_tools.py、tests/mind/test_mind_agent_tools.py；旧断言均保留。Host选择tests/agent/agent-tool-registry.test.ts、read-tools-runtime-postgres.test.ts、get-project-overview-postgres.test.ts、trash-tools-runtime-postgres.test.ts、use-skill-runtime.test.ts。上述结果为最终复跑，不将前期失败、类型检查失败或曾打印的旧测试日志算作通过。

源码构建曾在安全投影的结果类型约束上失败，修正为保留已验证领域结构再合并安全投影；最终重新构建并复跑Node/Python/Host。收据脱敏新用例同时检查真实DB收据、Provider续轮和未修改的失败项，未通过放宽错误断言恢复绿色。

生产Host仍需注入notes读取服务、完整projectMutations、真实授权/身份/Run恢复及通知能力。正式用户数据库、Redis、真实外部Provider与平台执行没有验收；本批保持“已实现待生产接入”，不升级为“已完成并接入”。


### 工作区更新与画布列表实际交付（2026-11-15）

本批不是依赖盘点：新增update_workspace与canvas_list，均完成定义、注册、参数校验、真实共享服务、结果/错误、Host工厂接入及实际Agent续轮。状态为已实现待生产接入；累计29项，部分1、阻塞78、退役/重设计1，生产完成仍为0。canvas_get/canvas_search及画布写入仍按各自依赖保留阻塞，本批不声称画布全组完成。

update_workspace在tools/workspaces.ts领域组，复用createWorkspaceDeclarationUpdater；Kysely声明适配器支持借用外层Core事务，保留原独立事务调用。目录显示名及同owner绑定同步、enabled更新、完整workspace_payload关联名称/会话计数和调用收据在同一事务提交；物理directory_name不变。owner/session/run/round/call构成收据域，改参冲突，重放与重建恢复不重复执行；提交应答丢失只查收据，缺证明保持unknown。字段缺失、空白名称、跨owner、系统目录、重名与非法参数不产生写入副作用。共享更新沿Python strip规则，保留BOM并处理C0空白；不授予Shell或更改绑定目标。

canvas_list在tools/canvas.ts领域组，共享Mind canvas-read扩展专用Agent查询，不拿Web固定200条列表冒充。按owner/软删、updated_at及ID倒序分页，独立total；node_count仅计同owner未删除画布项，不通过节点存活状态额外筛选。保留Python视图camera/viewport的bool数值语义，默认20、限制1至20、负offset回0；project_id按实际绑定筛选。PG以UTC文本读取微秒，排序限定原表避免别名歧义；每条SQL结束后再检查取消，不race遗留查询。缺表返回安全错误，不伪造空计数。

Host工厂新增可选workspaceMutations和canvases能力；缺后端不开放，发现和执行均通过现有授权。没有修改main/app、Provider/Run/SSE、共享schema/package或锁文件。生产Host仍需可信装配完整能力、正式workspace schema及真实Run/授权服务；管理更新不代表Linux Shell隔离已完成。

真实依赖为Core正式临时SQLite、合成工作区/目录/文件夹合同表、隔离PG随机schema；SQL、收据和领域修改是真实实现。Provider transport、RunStore/lease、上下文与授权判定为明确替身。SQLite正式会话workspace绑定schema尚未升级：SQLite更新测试计数为0，PG通过同owner和跨owner会话验证真实计数为1；不能将合同表当作正式schema升级证据。真实Redis、外部Provider、平台Shell与生产Run未验收。

本批修改：tools/workspaces.ts、tools/canvas.ts、tools/index.ts、tools/README.md；data/workspace-declarations.ts、workspaces/workspace-declarations.ts、mind/canvas-read.ts；Host agent-tool-registry工厂；Core workspace-update/canvas-agent-read测试、Host read-tools-runtime-postgres与agent-tool-registry测试、Python只读迁移基准文件；对应suites/metadata和迁移任务清单。

Python新增基准首轮遇到错误分支rollback使共享Session ORM主键过期，引发MissingGreenlet；在测试进入错误路径前固定合成身份和ID，原越权、空名及数据库副作用断言保留。没有修改Python生产实现或放宽旧断言。最终结果另列如下。

#### 本批最终回归结果

| 检查 | 结果 | 防止的回归 |
| --- | --- | --- |
| Core工具/技能/相关共享查询33文件 | 465通过，0失败/跳过 | 注册器真实调用、工作区同事务显示名/完整结果、owner/空名/重名/系统目录、收据并发去重与提交应答恢复；画布205条分页、项计数、投影、取消和Agent续轮 |
| 共享工作区声明双库合同 | 1通过，0失败/跳过 | 原有独立事务调用在临时SQLite/PG仍保持归属、会话计数、目录同步、冲突回滚；新增借用事务没有破坏旧API调用方式 |
| Host五文件，隔离PG | 19通过，0失败/跳过 | 两工具真实结果进入下一Provider请求、workspace同owner会话计数、物理段不变、跨owner不改名、微秒视图、收据重建及组关闭；保留之前工具/Skill回归 |
| Python三文件串行 | 38通过，0失败/跳过，12条既有setex弃用提示 | 实际注册器更新、原工作区共享服务及画布工具业务基准，保留旧断言 |
| Core生产构建、Host全量类型检查 | 通过 | 公共导出和Host实际调用类型；仅代表此次检查时的工作树 |
| Core测试类型检查 | 未通过，既有TS6059 | tests/files/read.test.ts直接导入packages/fs源码跨rootDir；本批文件未报告类型错误，未放宽tsconfig |
| ripwire edit-check/quality_delta | 入口无不兼容调用；delta仍有4项跨域克隆门限 | 旧Mind节点/Undo投影、owner辅助函数的整树比较触发；不扩大范围合并不同投影或批量ack，未声称质量全绿 |
| diff、测试清单JSON和逐工具统计 | 通过 | 109项与分类数量一致；新增测试有效登记 |

Node选择tests/agent/tools、tests/agent/skills、tests/mind/canvas-agent-read.test.ts、tests/unit/data/workspace-declarations.test.ts、tests/unit/data/workspace-list-query.test.ts、tests/calendar；双库另选tests/integration/postgres/workspace-declarations-data.test.ts。Host选择agent-tool-registry、read-tools-runtime-postgres、get-project-overview-postgres、trash-tools-runtime-postgres、use-skill-runtime五文件。Python选择tests/agent/test_readonly_tool_migration.py、tests/terminal/test_shell_workspaces.py、tests/mind/test_mind_canvas_tools.py。

临时PG实例与schema已停止清理。未读写真实用户数据或运行配置，未调用付费Provider、Docker或CI；未fetch/提交/推送。保留共享工作区其他未提交内容。使用本任务内部子Agent分工后由主会话整合验收，未联系其他开发会话。生产Run、真实Redis和正式SQLite工作区升级仍未验收。


### 画布详情、搜索和定位连续交付（2026-11-15）

新增canvas_get、canvas_search及依赖就绪的canvas_focus_node，集中在tools/canvas.ts；没有单工具源文件或兼容转发。Mind共享createAgentCanvasQueries与既有createSqlMindCanvasReader组合使用，原Web读取不变。Host授权工具名同步，完整reader由可信Host注入。累计已实现待生产接入32、部分实现1、依赖阻塞75、退役/重设计1；生产完成0。

canvas_get补齐独立节点计数与分页、原始正文按需返回、布局默认/显式尺寸及安全间距；关系读取不受节点页限制，过滤owner/canvas/关系墓碑和detachedRelationIds。默认审计只用当前页，页外端点incomplete；include_nodes=false独立查询全部关系端点几何，不加载正文，审计scope为relation_endpoints。端点建议按水平投影而非ID排序计算，保留implicit/aligned/custom/incomplete及原有reason；custom只解释保存布局，不擅自改线。视图与created/updated时间保留微秒；非法关系端点容器报安全错误，不假造隐式布局。

canvas_search复用共享关键词strip、截断、casefold去重；OR/AND及后端LIKE/ILIKE保留旧语义，按z/id倒序。按canvas_note/project/file/event类型过滤，排除普通note与跨owner/已删节点；空关键词可列现有节点，空types沿旧默认。limit+1探测count保留原始命中数，matches只返回limit条，truncated独立。Python search_canvas_nodes当前没有过滤画布项deleted_at，本次刻意保持这一历史行为；get/focus过滤画布项墓碑。不能把这项迁移说成“已修复所有墓碑语义”。

定位工具复用共享精确item/node owner查询，不再为了定位加载整画布或活动来源；只允许可放置类型，返回同一gugu focus_link普通JSON。无效目标、非法身份扩展和取消不产生链接或写入，不修改节点、画布或视口；本批未修改客户端链接处理，不以返回URI声称浏览器交互已验收。

真实SQLite注册器覆盖节点分页与关系独立快照、几何和自定义端点、类型/关键词/截断、来源owner、软删、定位和取消；Host真实PG/运行链验证这三个结果进入Provider下一请求。PG/Core领域表是真实SQL，Provider transport、RunStore/lease、上下文来源和授权为明确替身；真实用户库、Redis、外部Provider与生产main未验收。写工具仍缺相应Agent写入/确认/恢复装配，不因读取共享用例存在而升级完成。

本批文件：mind/canvas-read.ts、tools/canvas.ts；Host agent-tool-registry.ts与read-tools-runtime-postgres.test.ts；Core tests/mind/canvas-detail.test.ts、tests/agent/tools/canvas-focus.test.ts；对应suites/metadata、工具README和迁移清单。最初分工产生的单工具源模块已合并回canvas工具组并删除，未留下旧路径转发。


#### 本批统一验收结果

- Core工具/技能及相关共享用例35文件：467通过，0失败/跳过；最终端点容器校验和精确定位查询调整后，另跑详情/定位2项通过。保护分页、独立关系快照、owner、搜索探测、墓碑语义、取消与无写入副作用。
- Host五文件隔离PG：最终19通过，0失败/跳过。首次17通过、2失败为并行构建删除Core dist造成ERR_MODULE_NOT_FOUND；复制已构建产物到临时目录后整组重跑通过，未修改产品加载逻辑或放宽断言。覆盖真实工具执行、PG结果及Provider续轮。
- Python四文件串行：63通过，0失败/跳过，20条既有setex弃用提示。选择test_mind_canvas_tools、test_mind_canvas_gaps、test_canvas_layout及test_tool_schema_security_contract；保留Python业务实现及原断言。
- Core生产构建通过。Core测试类型检查仍报既有tests/files/read.test.ts跨rootDir的TS6059；最终Host全量类型检查报tests/host/data-import-apply-main.integration.test.ts:29的TS7022，本批未修改该文件，不能声称整树类型检查通过。
- 入口edit-check未发现不兼容调用。整树quality_delta相对HEAD仍有169项门限，包含大量并行开发内容，不能将其归为本批或声称质量全绿；没有批量ack或扩大重构范围。子目录单独扫描因缺独立Git基准不可用。
- 测试清单JSON、diff空白检查通过。隔离PG与临时构建产物按脚本清理；真实Redis、外部Provider、客户端定位交互及生产装配未验收。未修改受保护运行配置，未fetch、提交、推送或触发CI；保留其他会话未提交内容。


### 画布候选与创建、技能目录连续交付（2026-11-15）

本批新增canvas_search_placeable、canvas_create、list_skills，前两项在tools/canvas.ts，技能管理集中在tools/skill-management.ts；没有按单工具建立源模块或兼容层。逐工具累计已实现待生产接入35、部分实现1、依赖阻塞72、退役/重设计1，合计109，生产完成仍为0。

canvas_search_placeable复用Mind共享createAgentPlaceableSearch，不以全局搜索相关度/每组截断替代旧契约。先规范化关键词，按项目→文件→活动检索，各来源分别按旧时间字段倒序；每来源使用offset+limit+1探测，累计达到探测量才停止下一来源。因此count为旧服务探测长度，跨来源时可能超过单个探测上限，不是全部匹配总数。返回分页、已有引用和画布项标记，不创建引用。空types沿旧默认，OR/AND、q别名、Unicode关键词归一共用已有规则。正式Node项目/日历列contact_name对应Python client属性；文件仍查display_name/ext/stage_name。缺表返回安全错误，不伪装空集合。指定画布须归属当前owner；引用和画布项也同时限定owner，防止畸形跨owner关联泄漏。旧版已放置标记包括项/引用墓碑的语义保留，不据此声称已修复历史墓碑问题。

canvas_create校验标题/项目，复用createMindCanvasCreation和真实SQL适配器；共享创建适配器新增借用外层事务能力，原独立事务方式仍由双库合同保护。画布、Undo和调用收据同事务提交；发布事件仅在外层提交后执行，失败不回滚已提交数据。调用键包含owner/session/run/round/call，重建、重放、并发同调用只执行一次，改参冲突；提交应答丢失只查收据，没有证明保持unknown。创建与Undo失败均回滚，不泄漏原始异常。标题采用Python strip保留BOM，不把默认Web未命名行为带入工具。通知是明确best-effort，提交成功但应答丢失时可能不发通知；生产可靠通知/outbox仍需Host生命周期验收，不声称事件必达。

list_skills使用共享createSkillMetadataReader，内置定义来自createBuiltinSkillDefinitions读取Markdown head的真实结果；用户查询只选当前owner、source=user的元数据，包含停用项，managed_by空值沿旧默认user，按Python casefold和码点顺序排序。不会读取body或content_digest，也不会用注册器可加载catalog冒充完整管理目录。此工具不授予related_tools权限，不代表用户Skill创建/更新/删除迁移或技能HTTP GET已经完成。

Host新增三个独立可选能力：canvasPlaceableSearch、canvasCreation、skillMetadata，分别承载可信owner查询、持久创建/恢复/提交后事件和完整元数据读取；缺少能力不开放工具。发现与执行均继续使用现有authorize；按canvas和skill_management领域组配置开关。没有修改main/app、Run/Provider或生产装配，也未联系其他开发会话。

#### 本批验收

| 检查 | 结果 | 防止的回归 |
| --- | --- | --- |
| Core工具/Skill/Mind/日历及工作区共享用例38文件 | 475通过，0失败/跳过 | 新增6项覆盖真实SQLite候选/owner/墓碑/无引用副作用、创建收据重放/并发/应答丢失/Undo回滚/取消/通知失败/Agent续轮，以及Markdown目录的停用项/正文隔离/排序；保留旧工具回归与共享Mind原独立事务 |
| Host五文件，隔离PG | 20通过，0失败/跳过 | 三工具真实结果进入Provider续轮，PG查询、创建Undo和恢复、能力缺失/撤权/组关闭；未用假业务成功 |
| Mind共享PG合同 | 1通过，0失败/跳过 | 原画布创建及其他Mind操作、Undo同事务和失败回滚不被借用事务改动破坏 |
| Python四文件串行 | 79通过，0失败/跳过，22条既有setex提示 | test_mind_canvas_tools、test_mind_canvas_gaps、test_user_skills、test_tool_schema_security_contract；保留原业务/安全断言及Python实现 |
| Core生产构建、Host全量类型检查 | 通过 | 公开导出、Host工厂和新增调用方类型；仅代表本轮工作树 |
| Core测试类型检查 | 仍有既有TS6059 | tests/files/read.test.ts跨rootDir导入fs源码；本批mock类型错误已修正；最终复查仅剩该TS6059 |
| edit-check/quality_delta | 共享创建入口无不兼容调用；整树169项门限 | 仍含既有投影克隆和大量并行修改；新增创建/搜索复杂度和收据坐标克隆已如实保留，不批量ack或声称整树质量全绿 |

初跑记录：新增文件尚未登记清单导致Vitest启动失败，登记后继续；SQLite夹具重复建已有日历表，改用正式表并纠正contact_name映射；新增非法参数测试曾误把旧规范允许归一化的数字字符串当作非法，改为真正非法的对象输入，原业务断言未删减。Core构建首次借用事务类型不匹配已修正。Host首次临时PG URL缺少authority被连接校验拒绝，改为合成localhost authority和Unix socket后20项通过。PG合同首次用默认套件未发现文件，显式postgres套件重跑通过；未把这些失败或未发现算为绿色。

真实部分：Core正式临时SQLite及Mind/项目/日历表、隔离PG随机schema、共享领域事务/Undo/收据及Host运行链；文件表与user_skills仅提供合成合同表，尚非正式SQLite schema升级证据。Provider transport、RunStore/lease、上下文、授权、提交后事件接收器与Markdown资源文件内容为明确测试替身。未验收真实用户库、Redis、外部Provider、生产main/Run、真实事件订阅、正式SQLite文件/Skill表；不升级为生产完成。临时PG和构建产物已清理。

本批修改：tools/canvas.ts、tools/skill-management.ts、tools/index.ts；skills/user-read.ts、skills/index.ts；mind/canvas-read.ts、canvas-create.ts、canvas-create-sql.ts；Host agent-tool-registry.ts、read-tools-runtime-postgres.test.ts；Core canvas-ready/skill-management测试；suites/metadata、tools/skills README、node-webui共享入口规范和迁移任务清单。受保护配置未改，其他并行工作区内容保留；未fetch、提交、推送、运行Docker或触发CI。


### 画布布局、视图移除与正文编辑连续交付（2026-11-15）

本批实际交付canvas_update_node、canvas_remove_node、canvas_update_note，均在tools/canvas.ts领域组；共享Mind canvas-edits.ts承担同事务批量用例，没有每工具单独模块。累计已实现待生产接入38、部分实现1、依赖阻塞69、退役/重设计1，合计109；生产完成仍为0。

canvas_update_node保留单项及updates批量返回形状，要求至少一个布局字段，单批最多20项，不允许混用单项和批量参数。字段使用width/height而非w/h，只允许画布便签改大小；范围180–520/100–420与旧公开Schema一致，共享写服务仍做最终裁剪。位置、层级和折叠通过原canvas-item-update-sql写入，结果复用共享节点几何/摘要投影，正文和业务来源不改动。

canvas_remove_node保留item_id/item_ids互斥、20项上限和node_preserved=true结果。原共享移除服务同事务软删画布项、将相关关系加入detachedRelationIds、记录Undo；节点正文、业务来源及关系记录保留。重复ID的后续项失败时整批回滚，不当作两次成功。

canvas_update_note只允许当前owner存活canvas_note，不修改普通note。单项/updates批量保持旧结构；增量字段保留未传内容，空白标题转新便签，Python strip保留BOM；内容/纯文本/hash/index失效及版本更新委托canvas-note-sql的共享CAS。目标读取与修改共用事务，PG加行锁，冲突错误映射为旧工具语义；工具参数不能提供或覆盖可信版本、owner和运行身份。

三个共享SQL适配器新增借用既有外层事务能力，原Web独立事务路径仍保留，并经过双库共享合同。条目布局/移除新增可信includeDeletedNodes选项，仅本组Agent适配明确开启：Python get_canvas_node默认不筛节点墓碑，旧工具能调整或移除仍存活的画布项，但不复活正文。Web默认继续要求存活节点，且双方owner始终受限；新增Python对照和Node实际SQL保护这一历史区别，没有把墓碑节点重新加入普通画布读取。

Host新增可选canvasEdits端口，必须具备持久收据与真实提交后事件接收器；缺能力不注册，仍由现有authorize逐次判权及canvas组配置控制。执行中画布/节点修改、Undo和调用收据共同提交；后项失败、取消或Undo失败整批回滚。owner/session/run/round/call绑定收据，重建、并发和重放不重复修改；改参冲突；提交应答丢失只查收据，未证明保持unknown。事件仅提交后best-effort发布，通知失败不回滚，事件必达/outbox不在本批完成范围。创建与编辑复用同组调用坐标函数，未另造执行器或通用工具框架。

#### 本批统一验收

- Core工具/技能/Mind/日历及工作区共享用例39文件：最终482通过，0失败/跳过；新增canvas-edits的7项经过真实SQLite注册器/领域写服务，覆盖单批Schema、几何结果、后项失败回滚、owner/类型/墓碑、正文/版本不丢、收据并发/重建/改参/应答丢失、取消、Undo失败、组关闭、事件失败及Agent续轮。整理共享函数后的针对性5文件17项通过。
- Host五文件隔离PG：最终21通过，0失败/跳过；三工具经真实Host runtime/registry/PG，结果进入Provider下一轮；核对布局、正文/版本、视图墓碑/关系脱离、正文保留、收据恢复、批量回滚、越权与缺能力。
- Mind共享PG合同：1通过，0失败/跳过，保护原创建、条目编辑/移除、正文更新及Undo事务；SQLite合同包含在Core选择内，保护新增借用事务没有破坏原独立调用方式。
- Python四文件串行：64通过，0失败/跳过，20条既有setex提示。选择test_mind_canvas_tools、test_mind_canvas_gaps、test_canvas_layout、test_tool_schema_security_contract。新增test_agent_layout_and_remove_preserve_deleted_node_body；未修改Python业务实现或删改旧断言。
- Core生产构建通过。Host全量类型检查通过；Core测试类型检查仍有tests/files/read.test.ts跨rootDir导入fs源码的既有TS6059，本批未放宽配置。
- edit-check检查三个共享SQL工厂，未发现不兼容调用。quality_delta相对HEAD整树仍有170项门限，包含并行工作树和已有投影克隆；新增批量主函数复杂度59已通过同模块按操作拆分消除，剩余相似查询/操作结构与六参数入口如实保留，不扩成通用框架或批量ack，不声称整树质量全绿。

初跑失败保留：整理legacy位置检查时同名局部变量导致测试编译失败，重命名后修复。新取消用例曾误期望写入开始后的dispatch抛错，核对注册器已有写工具契约后改为unknown，并保留SQL修改/Undo/收据全部回滚断言；没有放宽原有测试。首轮与最终PG整组均通过，最终整理后再次复验。

真实依赖为正式Core临时SQLite表、隔离PG随机schema及共享领域事务、CAS、Undo、收据；Provider transport、RunStore/lease、上下文、授权和提交后事件接收器是明确替身。未访问真实用户库/运行配置，未验收真实Redis、付费Provider、生产main/Run装配或真实事件总线。不因独立Host工厂验收而记生产完成；Shell隔离、RAG、危险确认工具状态未改。

本批文件：tools/canvas.ts、tools/index.ts和README；mind/canvas-edits.ts、canvas-read.ts、canvas-item-update-sql.ts、canvas-item-remove-sql.ts、canvas-note-sql.ts及index；Host agent-tool-registry.ts、read-tools-runtime-postgres.test.ts；Core canvas-edits测试及suites/metadata；Python test_mind_canvas_gaps.py；迁移任务清单与node-webui共享入口规范。未修改main/app、Provider/Run/SSE、共享schema、package或锁文件；未联系其他会话，保留其他未提交修改。临时PG/构建产物按脚本清理，未fetch/提交/推送、运行Docker或触发CI。


### 画布新增、引用放置与关系连接连续交付（2026-11-15）

本批新增canvas_create_note、canvas_add_node、canvas_update_anchor、canvas_connect，集中在tools/canvas.ts；新增共享Mind canvas-layout.ts纯几何和canvas-placement.ts放置事务用例，关系/端点继续在canvas-edits.ts同事务用例中整合。按领域/资源生命周期组织，不按工具各建模块。累计已实现待生产接入42、部分实现1、依赖阻塞65、退役/重设计1，共109；生产完成0。

canvas_create_note支持单项/notes批量、20项限制、字段互斥及旧默认：新便签、空正文、amber，width/height遵守旧范围，创建canvas_note而非时间流note。坐标复用共享resolveCanvasPosition：显式x/y必须成对且有效，偏移非法也报错；viewport按camera和scale换算世界坐标；near按指定画布项定位；auto按同owner画布存活项x/id取最后项并使用旧间距。新批量项逐项参与后续布局。缺视口或锚点不存在不回退成自动布局；auto沿旧规则忽略offset，near零宽回退220，不擅自把旧规则替换为新避让算法。

canvas_add_node支持node_id或ref_type/ref_id二选一及nodes批量；复用真实引用来源、唯一引用节点/快照与原画布项写服务。普通note不能放置。已放置目标保留原位置和尺寸，即便本次传了不存在的near_node也不重新定位；新的同坐标调用返回created=false且mutated=false。软删视图恢复沿原item_id，重设位置和默认布局；来源节点与视图一起提交。项目/活动来源墓碑沿Python旧共享服务仍可引用，文件墓碑不可引用；所有查询仍限定owner。引用节点墓碑导致的唯一键冲突仍返回安全未完成状态，不冒充成功或擅自复活原节点。

canvas_update_anchor校验owner/画布/关系及两端画布项，复用共享画布更新服务和Undo。只更新指定relationAnchors，保留camera、viewport、其他端点和视图状态，不修改MindRelation语义。旧端点更新按项存在判断，包含已移除项；不将这一历史语义扩展到普通读取或canvas_connect。非法JSON沿旧规则空对象处理，非法端点容器在显式端点更新中重建；连接读取到错误容器会返回安全错误并回滚。

canvas_connect默认related且不开放并行边；复用已有关系创建/恢复服务，保留标准化source/target顺序和默认边幂等。同画布两端须是当前owner存活canvas_note/ref且视图存活；自连、跨owner、缺端点、单侧参数被拒绝。默认端点由共享水平投影/中心规则计算，不按节点ID猜位置；返回verification、anchor_source、changed及原结果结构。显式端点与几何不符时必须allow_custom_anchor=true；保存端点随实际返回source/target方向翻转。已有相关边不重复创建，changed描述端点变化而非声称关系新建；历史detached标记不自动清除。

Host新增显式canvasPlacements和canvasRelations能力；前者要求真实引用/文件/项目/活动及放置后端，后者提供关系/画布视图事务。原canvasEdits不会因此自动开放新增四工具。沿既有canvas组、参数校验、逐调用authorize和持久收据执行；画布、节点、引用、关系、视图、Undo和收据共用外层事务。提交应答丢失仅查收据，不重做；取消、后项失败、Undo失败整批回滚，写入已开始时仍按注册器契约保留unknown。事件只在外层提交后best-effort发送；未提供可靠outbox或事件必达承诺。

四个SQL工厂（item-add、ref-node-create、relation-create、canvas-update）增加借用外层事务能力，原独立事务调用由Mind双库合同保护。共享几何同时被画布读取审计和连接写入使用，保持默认尺寸与方向规则一致。内置/用户技能注册方案不变，未引入新Agent框架或兼容转发。

#### 本批统一验收

- Core最终串行41文件493通过，0失败/跳过；新增canvas-placement通过真实SQLite注册器、来源查询、共享事务写服务及Agent续轮，覆盖定位、默认值/尺寸、引用复用/恢复、真实新增引用后项失败回滚、owner/来源墓碑、几何方向/自定义守卫、端点保留、收据并发/重建/改参/应答丢失、取消及Undo失败。canvas-layout补齐视口四角/中心、显式优先、偏移、auto/near及水平重叠端点规则。
- Host五文件最终22通过、0失败/跳过，共享Mind PG合同另1通过；四工具真实SQL结果进入Provider下一请求，验证视口世界坐标、引用来源、端点保留、反向连接幂等、收据恢复、撤权/组关闭和缺能力不注册。
- Python四文件串行64通过，0失败/跳过，20条既有setex提示：test_mind_canvas_tools、test_mind_canvas_gaps、test_canvas_layout、test_tool_schema_security_contract。未修改Python业务或断言。
- Core构建通过。Host全量类型检查通过；Core测试类型检查仍有tests/files/read.test.ts跨rootDir导入fs源码的既有TS6059，未放宽配置。
- edit-check四个SQL工厂没有不兼容调用。quality_delta整树169项门限，含大量并行改动/既有投影，仍有坐标函数复杂度及同组适配/查询结构克隆；不批量ack、不把整树扫描当本批全绿。

初跑构建曾因新增借用事务缺Transaction类型导入、JSON Schema条件数组类型与create事件联合类型不完整而失败；补齐显式类型后构建及专项通过，未放宽检查或修改旧断言。前三项先验收Host 22项、共享PG合同1项、Core 41文件490项通过；随后依赖闭合继续实现connect，最终整组另记，不将中途结果冒充最终状态。

真实部分为正式Core临时SQLite表、隔离PG随机schema、实际领域事务/引用/关系/Undo/收据；files使用合成合同表，尚不是正式SQLite文件schema升级。Provider transport、RunStore/lease、上下文、授权和提交后事件接收器为明确替身。真实Redis、外部Provider、生产main/Run、实际事件总线、客户端渲染与正式SQLite文件能力未验收，不升级生产完成。平台Shell隔离、RAG及危险确认工具状态未改。

本批文件：tools/canvas.ts、tools/index.ts、tools/README.md；mind/canvas-layout.ts、canvas-placement.ts、canvas-edits.ts、canvas-read.ts、index.ts及四个SQL适配器；Host agent-tool-registry.ts、read-tools-runtime-postgres.test.ts；Core canvas-placement/canvas-layout测试及suites/metadata；node-webui共享入口规范和迁移任务清单。未修改main/app、Provider/Run/SSE、共享schema、package或锁文件；未联系其他会话，保留其他未提交修改和受保护配置。临时PG和构建产物按脚本清理，未fetch、提交、推送、运行Docker或触发CI。


本批最终验收补记：首次最终Core整组492通过、1失败（既有SQLite子进程锁合同30秒超时），当时与Core构建同时运行，构建产物重建竞争为推断原因；在构建结束后独立复验该合同2项均通过，耗时约4秒。没有修改断言、增加skip或延长超时，随后完整串行重跑41文件493通过，0失败/跳过。PG/Host使用临时构建快照，最终22+1项通过，0失败/跳过；真实用户数据、配置、Redis/Provider和生产装配仍未验收。


### 普通笔记生命周期连续交付（2026-11-15）

新增note_delete、note_restore、note_undo，统一定义于tools/note.ts；共享Mind note-lifecycle.ts负责目标选择与生命周期协调，原note-mutations-sql扩展恢复能力和借用外层事务。没有为每工具另建源模块或创建第二套执行器。累计已实现待生产接入45、部分实现1、依赖阻塞62、退役/重设计1，合计109；生产完成仍为0。

note_delete只按精确node_id定位同owner存活普通note，读取当前版本后复用原CAS软删；note_restore只恢复同owner已软删普通note，保留正文、来源、色板、captured_at和索引字段，递增版本。画布便签/ref、跨owner、缺失目标和错误状态均拒绝，失败没有Undo/收据/通知。删除严格拒绝模型版本或模糊选择参数；恢复沿旧Schema容许额外字段，但不能覆盖可信owner或存储版本。这里保留Python原静态mutates=true、非destructive的可恢复软删契约，未开放永久删除或放宽危险确认门。

note_undo按created_at降序、id降序选择最近存活origin=gugu且kind=note的记录，不按captured_at或用户给定标题猜测，跳过用户创建/画布/跨owner/已删记录。目标在事务内定位并锁定；同一调用重建、重放、提交应答丢失均只读取原收据，不会再次选择并删除下一条记录。不同调用才能继续撤销前一条记录，没有目标返回旧错误。

三工具身份与owner来自可信Host noteLifecycle能力；缺后端不注册，仍按mind工具组配置和逐次authorize判权。修改、Undo和持久调用收据共用事务；同调用并发只执行一次，改参冲突，未知收据保留unknown，执行后取消与Undo失败回滚而不报告成功。通知仅外层提交后best-effort发送，失败不撤销已提交修改；提交应答丢失时通知可能未发送，不承诺可靠outbox或事件必达。

恢复回执复用agentMindNodeDetail，与note_get同一正文/摘要/来源投影；PG通过UTC文本保留captured_at微秒。复查同时发现旧共享mutator的Undo快照经Date截成毫秒，本批对读取/RETURNING增加精确时间别名，快照在非零微秒时保留6位；原整毫秒格式及既有断言保持。新增双库实际Undo验证：恢复后撤销只改变软删状态和版本，不截断原记录时间；非法Undo或外层失败不留下部分修改。普通Web更新/软删仍可使用原独立事务方式，新增借用事务由同一双库合同保护。

#### 本批验收

- Core工具/技能/Mind/日历及工作区共享回归：最终43文件500通过，0失败/跳过。新增note-lifecycle 6项经过真实SQLite工具调用及Agent续轮，覆盖owner/类型/状态/严格参数、正文不丢、版本递增、排序、同调用并发/重放/改参/应答丢失、取消、Undo失败、撤权/组关闭及通知失败；新增共享SQLite恢复合同保护原独立事务与借用事务。
- Host五文件隔离PG：初轮23通过、0失败/跳过；三个实际结果进入Provider下一请求，验证微秒回执、普通笔记/用户来源边界、数据库版本和正文、Undo/收据、恢复不重选下一条，以及缺能力/撤权/组关闭。最终微秒快照修复后重跑另记。
- PG共享合同：原Mind合同及新增note-lifecycle合同共2项初轮通过，0失败/跳过；新合同与SQLite复用同一断言，保护恢复状态、版本、owner、外层/Undo回滚及实际Undo时微秒不丢。
- Python四文件串行78通过，0失败/跳过：test_mind_agent_tools、test_mind_api、test_undo_mind、test_tool_schema_security_contract。未修改Python业务实现或断言；原普通笔记删除/恢复/撤销、Web/Undo和输入安全基准保持。
- Core生产构建和Host全量类型检查通过；Core测试类型检查最终只剩既有tests/files/read.test.ts的TS6059。edit-check共享mutator与读取入口没有不兼容调用；quality_delta整树169项门限，仍含并行工作和旧投影，新增端口的复杂度/嵌套和相似SQL结构如实保留，不批量ack或声称整树全绿。

初轮工具/旧读取专项12项、共享恢复专项7项和整组Core 43文件500项均通过。微秒问题是复查中发现并补齐实际Undo回归，未删除或放宽原有断言；原整毫秒快照仍按旧格式比较。最终串行复验避免与构建同时运行子进程SQLite合同。

真实依赖为正式Core临时SQLite表、隔离PG随机schema、实际领域CAS/事务/Undo/收据及Host运行链。Provider transport、RunStore/lease、上下文、授权与事件接收器是明确替身；没有连接真实用户库、Redis或外部Provider，生产main/Run和实际事件订阅未验收。此切片不代表note_create的blocks、note_update的追加/line_edits或全量RAG写入已经完成，剩余工具仍按各自依赖保留。

修改文件：tools/note.ts、tools/index.ts和README；mind/note-lifecycle.ts、note-mutations-sql.ts、note-read.ts及index；Host agent-tool-registry.ts、read-tools-runtime-postgres.test.ts；Core note-lifecycle工具测试、双库共享fixture/SQLite/PG测试及suites/metadata；迁移任务清单与node-webui共享入口规范。未修改main/app、Provider/Run/SSE、共享schema、package或锁文件。未联系其他会话，保留其他未提交修改与受保护配置；临时PG/构建产物按脚本清理，未fetch/提交/推送、运行Docker或触发CI。


本批Host复验失败记录：微秒快照补齐后两次出现22通过/1失败，恢复返回找不到可恢复便签。通过真实回执及注册器plan定位到新增测试夹具的错误：同一轮的删除和恢复被按现有并发契约执行，夹具误假定调用顺序。现改为三个独立用户Run按依赖依次执行，每项仍经过真实Host/PG/Provider续轮并分别用原Run坐标恢复收据；结果、版本、owner、正文与收据断言全部保留，未修改调度器/确认门/旧测试断言。同轮工具没有跨调用先后保证，有依赖的生命周期操作须在收到前一回执后发起；恢复抢先发生时返回不存在是正确状态边界。最终复验结果另记。


最终串行验收：Core 43文件500通过、Host五文件23通过、共享PG两文件2通过，均0失败/跳过。新增恢复合同包含真实Undo微秒保留验证；两个Host夹具失败记录保留，未据此修改生产调度或放宽业务断言。Python78项结果不变。Host全量类型检查通过；Core测试类型检查原有TS6059仍保留。新增共享fixture两处TS2532已用显式存在断言收窄类型，未放宽类型或业务断言，最终复查仅剩既有TS6059。临时PG和构建快照已按脚本清理。


### 链接按钮边界原型（2026-11-15）

新增tools/link-buttons.ts的导航URL危险Scheme、控制字符、凭据及整组按钮校验，并定义可信Host投递/恢复端口；未接入真实Web/IM投递或持久收据，因此send_link_buttons仍为依赖阻塞，不更新完成数。端口只有注入实际后端后才能发送；测试中的投递是明确替身。Python urlparse的畸形URL和空用户名细节尚需逐项对照，不能宣称完全等价。

后续补充：Web 投递端口根据可信会话身份生成链接按钮 artifact，利用运行结果及 `tool_done` 检查点重建展示卡；恢复只重建确定性结果，不调用外部发送。Host 工具注册器现在允许显式注入该端口，并在未注入或无权限时关闭工具。已补充畸形 IPv6、空凭据和危险 Scheme 行为测试，以及真实注册器进入运行链与恢复展示卡的测试。现有生产入口尚未装配此注册器和可信渠道判定；IM 平台真实投递、幂等回执及其恢复尚未实现，URL 解析与 Python 全部边界亦未完成差分验证，因此该工具仍为依赖阻塞，不计入完成数。测试使用合成身份、内存运行存储及模拟 Provider，未验收真实 PG、Redis、浏览器或外部平台。

本次补充拒绝主机部分经 NFKC 归一化后变成 URL 分隔符的字符，覆盖全角冒号、斜杠和用户名分隔符，避免浏览器与服务端对凭据或主机边界的解释不一致；同时覆盖空用户名但非空密码的多冒号输入。Node 工具及运行链 64 项通过。生产入口目前没有调用 Web Agent 重建器，Node IM 模块亦没有 QQ、飞书或微信出站实现；缺可信运行装配、真实发送和可靠回执时继续保持不可用，不能据现有注册器或模拟投递宣布完成。

后续实现：IM 投递复用 `core_operation_receipts`，按 owner、会话、运行、轮次和工具调用生成独立预留/结果收据；预留在出站之前提交，相同调用并发或恢复只查回执，未知结果、取消后状态未知或回执缺失均不重发。收据只保存输入和可信渠道绑定的摘要及脱敏投递事实，不保存正文、URL 或凭据。新增飞书固定 HTTPS 消息接口适配：可信 Host 解析 bot、目标和访问令牌；发送前重新检查绑定及 URL，原生卡片明确拒绝后才降级文本，网络或平台结果未知不降级重发，不跟随重定向。代码和测试尚未装入生产启动流程，可信身份/凭据解析器、QQ/微信网关和真实飞书验收仍缺失，不能将工具标记为完成。

验收：Core 工具与运行链 65 项、Host 注册器与飞书适配 16 项、Python 两个链接按钮基准文件 49 项通过，无跳过；Python 有一条上游弃用警告。Host 集成测试使用临时 SQLite、合成身份和拦截 HTTP 的替身，验证真实收据与发送调用链，不代表真实飞书投递。Core 构建通过；Host 全量类型检查因其他并行工作中缺失的管理员模型目录和 QQ 连接模块失败。尚未验证 PostgreSQL、Redis 或生产装配。

本次验证：Core构建通过；Node注册器专项1通过，投递/恢复为替身；Python两个基准文件49通过、0跳过，1条依赖弃用提示。真实Host、平台投递、持久收据和生产Run未验收。

### 普通澄清交互（2026-11-15）

`ask_user` 的 choice/question 进入 `meta.ts` 工具组，使用既有注册器授权、参数校验和交互协调器；调用 ID 由可信运行坐标确定，回答经协调器消费并续轮，不进入公开 tool_done 内容。Host 仅在明确提供普通问题能力时注册；空选项仍支持自定义回答，重复选项及保留的自定义回复 ID 被拒绝。沙盒授权和 form 当前明确返回不可用，不能借普通问题授予权限；生产 Host/平台交互尚未接入，工具仍属部分实现。

Core 交互协调器测试 18 项、Host 注册器与交互描述 16 项通过，覆盖真实注册器到等待/恢复、取消、撤权和伪造选项；Python 交互协议两个无需数据库的基准测试通过。运行存储、Provider 和 Host 授权为测试替身；未验收真实 PG、Redis、平台交互或生产 Run。Core 构建通过；此前 Host 全量类型检查受并行工作中缺失的模块阻塞，不能视为通过。

### 回收站恢复工具（2026-11-15）

`restore_file` 与 `restore_folder` 合并在 tools/trash.ts，Host 显式提供恢复端口时注册，逐次验证权限。端口复用现有 owner 限定的 PostgreSQL/本地文件恢复服务；发送恢复动作前先提交调用预留，结束后持久化真实结果。同一调用重放读取收据，改参、并发未结束或提交应答丢失保持 unknown，不能重做文件副作用或冒充失败/成功。已确认的不存在及父目录仍在回收站使用旧工具错误；不可识别错误不回传原异常。预留和实际恢复不能同事务，故异常中断后可能需要人工核对，不承诺自动判定已提交状态。

隔离 PostgreSQL 随机 schema 与临时目录的真实注册器/恢复服务测试，以及现有文件恢复测试共 8 项通过：覆盖 owner、父目录、文件夹子树、重名、撤权、并发防重放、提交应答丢失和恢复副作用；Core 回收站与注册器测试 21 项、Host 注册器测试 14 项通过；Python 对应文件、文件夹及跨用户测试 3 项通过。Core 构建和 Host 全量类型检查通过。Python 首次测试命令误写测试名，未执行测试；修正后通过。测试通知接收器及模拟提交应答丢失是替身，未验收生产 Agent 装配、真实 Redis、其他 Host 或用户文件。

### 历史对话正文读取（2026-11-15）

`read_conversation` 按旧版工具组放入 tools/conversations.ts，注册器仅在可信 Host 显式装配历史读取并授权时开放。共享会话历史数据适配器在同一 PostgreSQL 查询内限定 owner、排除 content_json 非 SQL NULL 的结构化记录，先取最近 N 条再按顺序输出；空正文在取数后过滤，单条截取 1200 个 Unicode 字符。不存在和跨 owner 使用相同错误，取消和撤权不返回正文。关键词搜索仍需 1.7.7 TypeScript RAG；不以站内搜索替代 BM25。生产 Host 和桌面 SQLite 历史读取能力仍待装配。

隔离 PostgreSQL 随机 schema 的工具调用测试 1 项通过，覆盖真实授权查询、空会话、最近顺序、JSON null、截断、跨用户、非法上限、撤权、组禁用与取消。Core Agent 运行测试 63 项通过，新增用例将工具结果送入模型下一轮（历史读取为明确替身）；Host 注册器 14 项通过；Python 对应 owner/跨用户测试 2 项通过。Core 构建和 Host 类型检查通过。第一次新增 PG 测试误将注册器追加的错误提示当成业务不一致，修正测试以检查原始错误字段后重跑通过，未放宽旧断言。真实 Redis、生产运行、桌面 SQLite 和 RAG 未验收。

历史正文读取共享用例补充：将 owner、最近条数、结构化记录过滤及 1200 码点截断收敛至 Core 会话领域的 PostgreSQL/SQLite 共用查询，Web Host 复用该服务。正式临时 SQLite 和隔离 PostgreSQL 均经真实工具注册器验证；Core 历史及 Agent 运行测试 74 项、PG 测试 1 项、Python owner/越权测试 2 项通过。Core 构建通过；SQLite 桌面 Host 与生产 Run 仍需显式装配，RAG 历史搜索未因此完成。

旧版行为补充对照：Python、正式 SQLite 和隔离 PostgreSQL 均验证先按最近普通消息限量、再过滤空正文，以及 1200 Unicode 码点截断；Python 与 Node 注册器另验证带 `#` 的全角数字 ID 和字符串 limit 按原契约归一。Python 行为/owner 测试 4 项、SQLite 测试 11 项、PG 工具测试 1 项通过。另一次 Core 默认 Vitest 启动因并行会话新增测试尚未登记而失败；在临时配置中仅运行本次已有测试文件后 11 项通过，没有修改对方测试或分类清单。该证据仅覆盖历史对话读取，不代表其余所有工具均已完成逐项等价验收。

### 历史搜索边界（2026-11-15）

`search_conversations` 的工具组已补输入互斥、分词去重、上限、命中会话去重、历史消息 ID 定位端口及未定位保护；搜索和定位端口均必须由可信 Host 按 owner 实现，缺失端口时不注册。无关键词走近期会话端口，关键词必须走注入的 RAG，未实现也未以站内搜索替代。时间投影覆盖常见 ISO 形式，Python `datetime.fromisoformat` 的全部宽松格式尚需差分核对。当前测试搜索和归属定位均为明确替身，不能证明真实 RAG、数据库归属或生产装配，工具仍属部分实现。

Core 历史查询测试 12 项、Host 注册器 15 项、Python 对照 6 项通过；Core 构建及最终 Host 类型检查通过。Core 测试因并行测试分类不一致使用临时配置运行既有测试文件。初次 Host 测试及类型检查碰到共享 Core 构建目录暂时不存在而失败，构建产物出现后复验通过；没有修改对方工作。真实 RAG、Redis 与生产 Agent 均未验收。

随后补齐共享会话领域的近期列表与旧索引定位：PostgreSQL/SQLite 均按 owner 读取，先验证显式 session_id，再按旧协议解析 message_id/source_id；近期列表按完整时间排序，不按展示到分钟的字符串排序。Host 通过共享查询与显式 RAG 端口组装，未注入真实 RAG 时不开放。正式临时 SQLite 测试 12 项、隔离 PostgreSQL 工具测试 1 项、Host 注册器 15 项与 Python 对照 6 项通过；RAG 命中为替身，数据库查询和归属验证为真实实现。Core 构建和 Host 类型检查通过；真实 RAG、生产装配和 Python 宽松 ISO 时间全部边界仍待验收，状态保持部分实现。

### TypeScript RAG 恢复进度（2026-11-15）

经用户确认，源码基线为旧仓库 Git tag `v1.7.7`（commit `14c544f1faf1193e8a073844af4a5d7a4872045c`）；本地 1.7.8 发布树已不含该实现。**本段只记录 2026-11-15 当时的迁移快照**：当时已迁入原协议类型、来源文档适配、缓存和部分排序辅助，尚未迁入词法分词、BM25、完整排序、索引构建/重建、授权、向量及生产 Host。后续完成项和当前阻塞见本文末尾 2026-11-16 记录及 `packages/core/src/agent/rag/README.md`。旧 Data Runtime 的 OSS/S3 和独立 Worker 启动流程不会机械作为 2.0 在线架构启用。

历史搜索补充 ISO 基本日期/时间、周日期、任意日期时间分隔符及偏移的旧行为测试；旧索引补充显式 session_id 优先、message_id 优先、source_id 回查和 owner 隔离测试。Core 定向 25 项、Python 对照 6 项通过；SQLite 使用临时数据库，RAG 索引与原生分词器尚未运行。全 Core 类型检查受并行 BYOK 模块的 `CreatedCredential.id` 类型错误阻塞，未修改对方代码。Jieba 依赖和锁文件正在与并行会话协调；真实 RAG、PG 最终复验、生产 Host 和完整 Python 差分均未验收，search_conversations 仍为部分实现。

继续迁入 1.7.7 原分词规则、BM25、confidence、IDF 重排和候选选择；保留原版算法，分词器实例改由可信 Host 一次性注入，未装配或尝试替换时拒绝运行。使用旧版 `@node-rs/jieba` 2.0.1 本机已存在的制品，执行旧版 tokenizer 与 confidence 原测试 8 项通过；该制品仅用于隔离验证，不是 2.0 的依赖装配或生产后端。RAG 源码专项严格类型检查通过，Core 定向测试 26 项与 Python 对照 6 项通过。RAG 完整索引、原生依赖的跨平台安装、来源授权、生命周期与生产 Host 均尚未完成；旧协议类型与缓存已迁入也不代表可开放生产。

继续迁入原版内存词法索引的 replace、patch、范围过滤和 BM25 查询；实例显式绑定可信 owner，调用时校验 owner 和 revision，但来源记录的授权及持久索引仍由 Host 负责，未生产接入。补充索引版本、跨 owner/群范围、增量更新及外部对象突变回归。Core 定向 27 项通过；原版 Jieba 分词/排序测试 8 项和 Python/TS 固定词元语料各 8 组中的 TypeScript 8 组通过。Python Cython 固定词元测试启动后远端连接未返回，尚不能记为通过。RAG 单独严格类型检查通过；全 Core 类型检查仍被并行 BYOK 类型错误阻塞。

补充旧 `knowledge_index_entries` 的只读快照与增量读取：按 owner 分区，排除退役文件来源，保留墓碑并以微秒时间和 ID 作为增量游标。正式临时 SQLite 的 Core 定向测试 29 项、隔离 PostgreSQL 历史工具和索引读取测试 2 项通过；覆盖跨 owner、墓碑、同时间戳分页和非法游标。RAG 源码严格类型检查通过。单个 RAG 服务实例禁止跨 scope 共用可变索引，避免 revision 相同时错误复用。读取器仍会返回 owner 下所有 scope，必须先由可信 Host 完成 scope 授权才能接入；尚无索引写入及重建、向量读取、原生依赖正式装配和生产 Agent 调用。此次本地 Python 虚拟环境不可用，未重新运行 Python 对照；之前的 6 项结果不代表本次索引变更经过 Python 差分验收。

随后补充向量来源端口及旧版来源、chunk、模型版本匹配规则，使用替身验证匹配、版本不符、取消和读取错误；Core 定向测试增至 30 项。端口仍未连接 Host 授权文件系统或真实向量文件；读取错误显式传播，不能计作完整向量读取验收。

继续补充 Web Host 的本地向量读取适配器：由 Host 绑定 owner 和存储根，仅允许旧版三个固定路径，复用受控文件打开并限制大小；临时目录测试实际读取和匹配向量，并验证其他 owner 的符号链接、非法来源及取消。该适配器尚未生产装配。词法索引重建和更新改为成功后才替换状态，同 ID 的增量条目以后者为准，不完整 scope 拒绝检索；同一服务的并发重建与搜索顺序执行，构建失败后旧缓存失效。Core 定向 32 项和隔离 PostgreSQL/文件测试 3 项通过，Python 串行对照 17 项通过（chunk diff、会话读取及墓碑）；Python 测试使用内存 SQLite 和隔离配置，不能替代 RAG 生产链路的端到端差分。

对照发现 Python 会话搜索直接覆盖数据库中压缩 baseline 之前的历史消息，仅查询持久 RAG 索引会遗漏这些消息。真实完整历史来源、索引写入和重建、可信 scope 授权、正式 Jieba 依赖及生产 Agent 装配仍未完成，`search_conversations` 不得标记为完成。

RAG 专项严格类型检查通过；Web Host 全量类型检查未通过，当前并行 BYOK 装配缺少 `CreateCredentialOptions.version` 且存在 SQL 参数类型不匹配，未修改其他会话的文件。

后续补充可重建旧索引表的事务写入端口：整来源或单父文档替换，保留软删墓碑、支持复活，按 owner 隔离；PostgreSQL 同 owner 写入串行并推进微秒水位，SQLite 使用事务推进水位。新增范围快照过滤，但范围仍必须来自 Host 验证的授权快照，不能从工具参数获取；授权源、表结构迁移、重建调度和过期墓碑清理尚未装配。完整会话历史候选来源对业务消息表做 owner、非群聊和角色过滤，保留压缩水位之前仍存在的消息，关键词按字面匹配；SQLite 与 PostgreSQL 经过工具注册器验证，但尚未连接统一 RAG 排序和生产 Agent。Core 定向 34 项、隔离 PostgreSQL 与文件 3 项、Python 对照 20 项通过。Python 的工具测试中搜索后端为替身，这些结果不证明完整排序等价。

额外以隔离内存 SQLite 直接调用当前 Python `ConversationAdapter.retrieve`，1 项失败：子查询没有选择 `created_at`，后续排序访问该列时抛出 `AttributeError`。Node 候选来源已选择消息创建时间，但在 Python 基准修复并重新对照前，不能宣称真实调用行为已一致。

随后修复 Python 子查询缺少 `created_at`，新增真实适配器及排序调用回归：验证 baseline 前消息、owner 与群聊隔离、字面通配符和结果文本；Python 排序测试使用固定词元替身，因为本机未构建 Cython 文本扩展。Node 会话来源现接入迁入的统一排序，并经 SQLite、隔离 PostgreSQL 的工具注册器调用；Node 该组测试同样使用明确的 Jieba 替身，不能代表真实分词器已完成生产装配。Core 定向测试 34 项、PostgreSQL 与文件测试 3 项、Python 定向测试 21 项通过。一次 Python 排序运行因原生 Cython 扩展缺失失败；另一次运行因本机磁盘空间不足导致临时目录创建失败，使用本次专属临时目录重跑通过。

另外使用旧版现有的 `@node-rs/jieba` 2.0.1 制品和内存 SQLite，实际执行会话候选与统一排序，合成用例通过；该本机制品仅供验证，不是 2.0 的依赖声明或生产装配。

重建补充持久任务处理器：只领取 Host 显式注入来源的任务；索引写入、generation/租约验证和任务结果在同一事务内提交，失败采用不含原始异常的错误码与退避。SQLite 定向测试覆盖多 ID、任务执行期间 generation 变化、失败和重试；隔离 PostgreSQL 测试从真实临时表读取来源并完成重建。Core 定向 35 项、PostgreSQL 与文件测试 3 项通过。正式索引表、领域来源与生产调度未装配，不能把处理器存在视为重建能力已上线。

项目重建来源现复用共享项目领域服务，读取同 owner 的未归档项目事实，并支持按单项目重建；归档后空投影产生墓碑。临时 SQLite 与隔离 PostgreSQL 均执行真实领域读取、队列消费和持久写入，Python 来源记录对照通过。其他领域来源、正式表、可信授权和生产调度仍未完成。Node 定向 35 项、PostgreSQL/文件 3 项、Python 定向 22 项通过；PostgreSQL 初次运行因夹具到期时间比毫秒时钟晚不足 1 毫秒而返回 idle，调整夹具为明确已到期后通过，未改断言。

日历重建来源也已复用共享日历读取端口，限定 owner、忽略已删除活动，删除后通过同一任务处理器生成墓碑。SQLite 和隔离 PostgreSQL 验证真实日历读取、队列及索引；Python 活动记录对照通过。Node 定向 35 项、PostgreSQL/文件 3 项、Python 定向 23 项通过。生产调度仍未装配，不能将项目或日历来源记为生产完成。

便签与定时任务来源继续复用共享领域查询：便签限定存活的 note/suggestion，读取内容、版本及索引摘要；定时任务包括活动提醒，并保留更新时间的微秒。两者经临时 SQLite 和隔离 PostgreSQL 读取真实业务表，再通过持久队列写入索引；覆盖跨 owner、删除和墓碑，Python 来源记录对照通过。Core 三个定向文件 38 项通过、1 项跳过（该文件的独立 PostgreSQL 用例未提供连接）；另行隔离 PostgreSQL 的 Host 测试 3 项通过，Python 定向 25 项通过。来源尚未装配生产调度；画布、记忆、知识和完整会话索引来源仍有未完成部分。

词法索引增加旧版余弦与 RRF 候选融合，并限定在已授权 scope 的词法结果内；模型版本不符或缺向量时继续走词法。使用 Node 原生 TypeScript 加载及临时 loader 验证融合规则和实际索引边界；另用旧版本地 Jieba 2.0.1 制品验证一组合成查询。工作区根 Node 依赖及本地 Python 虚拟环境在本轮期间不可用，新增 Vitest 与对应 Python pytest 未能运行，不能将这些手动验证当成完整回归或生产装配。

随后使用独立临时依赖重新运行 Core 定向测试，37 项通过，RAG 严格类型检查通过；临时 SQLite、真实向量文件、旧版 Jieba 和实际混合排序联动通过，并验证 embedding 期间撤权不返回结果。授权与 embedding 为明确替身，正式表、可信授权、embedding 后端和生产 Agent 装配仍未完成。另以真实 SQLite 和 Jieba 经工具注册器执行会话搜索，验证 baseline 前历史、跨用户及群聊隔离；该测试不是生产 Host 启动验收。Python 环境缺失，未重跑本轮 pytest。

相同范围检索组合再以隔离 PostgreSQL、真实临时向量文件和旧版 Jieba 运行，验证 owner/群隔离、向量命中及查询中撤权；授权与 embedding 依旧为替身。此测试不改变生产接入状态。

临时依赖环境下尝试完整 Core 类型检查时，因未安装可选 `@microsoft/mxc-sdk/v1` 而无法完成；RAG 子集严格类型检查通过。未为本次查询验证安装或运行沙盒后端。

### Core 正式 RAG 索引表（2026-11-15）

Core schema 17 增加 `knowledge_index_entries` 的 SQLite/PostgreSQL DDL 和范围/增量索引；SQLite v1-v16 显式备份升级。Web Host 现提供 `migrate:rag-index:check/apply`：检查列、唯一键、owner 外键，可认领兼容的 Python 索引表。迁移测试两项已实现，但因 devserver 未设置隔离变量 `GUGU_WEBUI_TEST_DATABASE_URL` 均跳过；新 CLI、迁移实现及测试的严格 TS 定向检查通过。该命令未在部署中运行，Node 生产重建消费者、可信授权/向量、全量来源以及 `search_conversations` 到 Agent Run 仍未接通，不代表生产迁移或工具完成。


### Core Canvas RAG 来源（2026-11-15）

新增 `canvas-source.ts`，并在 Mind 共享读取服务加入 `listForRag`：通过单个 owner 约束查询存活画布项/画布/节点，按稳定 item ID keyset 分页；保留旧版标题、纯文本优先、分组路径及 item 更新时间/节点版本投影，再经旧 canvas adapter 和持久 Worker 写入正式索引。临时依赖隔离配置运行 Core SQLite RAG/迁移回归：两个文件 **81/81 通过**（RAG 对话/索引/来源 40 项、schema/备份升级 41 项）；新增行为覆盖合成 SQLite 实际来源读取、跨 owner 隔离、非法 ID、取消、Worker/索引写入和软删除墓碑。`canvas-source.ts` 与 Mind 读取文件的 NodeNext 严格类型检查通过。此前 RAG 对应 Python pytest 为 32 项通过，本轮未因 canvas 来源新增回归重跑 Python；因此 Python canvas 投影差分仍未验收。Core Worker 生产调度及 Agent 生产装配、PG 正式迁移仍未完成。

`search_conversations` 新增真实 Host 工具边界回归：使用临时正式 SQLite schema，经 `createCoreAgentConversationSearchPort`、Node 工具注册器和真实 dispatch 查询事实表；覆盖模型伪传 owner 不生效、关键词检索排除群聊、OR/AND、空结果和 Python 一致的标题/摘要/正文 snippet。固定 Jieba 切词为测试替身，不代表真实 Jieba 依赖或向量召回验收。Core 定向 RAG/工具测试 **72/72 通过**（使用临时 Vitest 配置绕过并行会话中新测试未登记导致的 suites 清单不一致；未改清单）；Host SQLite dispatch 测试 **1/1 通过**；隔离 PG/文件工具测试 **1 通过、2 跳过**（未设置测试库）。对应 Python pytest 未能启动：2.0 后端没有项目 venv，系统 Python 无 pytest，借用 Gugu-web venv 时缺少 2.0 的 `gugu_core` 模块。Core 标准构建 **通过**。Host 全量类型检查仍失败于并行会话的 user-list 测试 fixture 元数据缺项及 BYOK 测试导入缺失，未修改对方文件。生产 PostgreSQL、真实 Jieba/向量、重建调度与 Agent Run 装配仍未完成。

本轮为上述 Host SQLite dispatch 用例补充 Python `test_conversation_adapter_searches_owned_history_before_baseline` 对照：baseline 之前仍保留在事实表的历史可搜索，LIKE `%`/`_` 是字面字符；同时排除其他 owner、群聊和工具角色，并验证 Host 拒绝工具权限时不泄露命中正文。测试尚待 devserver 重跑；该补充不改变上段已验证状态。真实 Agent Run、PostgreSQL、正式 Jieba、综合 RAG 向量接线仍未完成。

### 会话索引来源与持久 Worker 写入（2026-11-15）

新增 `conversation-index-source.ts`，对应 Python `build_source_records(conversation)`：按可信 owner 读取会话/消息，应用 baseline、user/assistant 和非空正文过滤，生成摘要与消息记录；消息上下文按历史序列取相邻合格记录并截断 600 个 Unicode 码点，群会话保留平台、bot、group 授权 scope。支持全量、单消息和单摘要重建；非法/越界 ID 被拒绝。新增临时正式 SQLite 行为测试，从持久任务队列实际 dispatch Worker 并写入 `knowledge_index_entries`，检查 baseline 排除、工具角色排除、上下文、群 scope 元数据和任务状态。Core 会话/RAG 测试文件 **41/41 通过**，包含上述行为；新增来源文件独立 NodeNext strict 类型检查及 Core build 通过。对应 Python `test_search_tools.py` / 来源基准 pytest 未能运行：devserver 2.0 工作区没有项目 pytest，系统 Python 也未安装 pytest。PG 来源行为、版本时间序列化差分、生产调度与 Agent 装配仍未验收，不改变生产状态。

### Host RAG 重建调度器（2026-11-15）

新增 Host 单消费者轮询器：启动即工作，按 Core Worker 返回的状态排空可用任务，空闲/重试后退避轮询；捕获错误并回调、取消停止且等待当前任务退出，禁用时不触发工作。临时 SQLite 回归经该调度器调用 Core 持久 Worker 消费 `rag_index_jobs` 并写入 `knowledge_index_entries`；另覆盖排空、无并发、失败重试、取消和禁用。后续已接入 `main.ts` 迁移门控及首次索引基线入队；当前回归状态以“首次 RAG 索引基线与持久会话工具”一节为准。多实例部署和真实 PG 环境仍未验收。

### RAG Host 来源组与会话搜索安全回归（2026-11-15）

新增 `rag-rebuild.ts` Host 工厂及 `startAgentRagIndexWorker` 生命周期入口，固定装配 project、calendar、note、scheduled_task、conversation、canvas 六个已具备真实 Core 读取端口的来源；memory/knowledge 仍未启用。Host 生命周期通过正式队列和 Core Worker 写入索引表；缺少来源时任务保持 queued，不报假成功。后续已由生产 `main.ts` 在 PG 迁移状态通过后启动，并为既无索引也无任务的来源补全基线队列。显式会话搜索新增持久索引/向量适配器，安全和调用回归以“首次 RAG 索引基线与持久会话工具”一节为当前结果。正式 PG、生产向量/embedding 凭据、memory/knowledge 授权来源和 Web Agent Run 真实装配仍未验收。

### RAG 主机启动门控与正式分词器（2026-11-15）

Web Host 锁定 `@node-rs/jieba@2.0.1`，使用包内词典与 HMM=false。`search_conversations` 有持久索引 BM25 适配器：真实注册器 dispatch 读取 owner scope 的正式 RAG 索引，并通过共享 owner 限定查询补齐会话元数据，符合 Python 的 `strategy="bm25"`，不调用 embedding。通用 RAG Host 向量 resolver 把 memory/knowledge/pattern 旧向量文件绑定到固定存储根和 owner，按 owner 动态解析 embedding 设置、模型版本及受控 Provider Transport；另有 PostgreSQL owner BYOK 配置读取器，通过 Host 解密端口获取启用的 embedding 凭据，默认不放行 local endpoint。无设置或无效 embedding 时 memory RAG 词法回退，不伪造向量。Host 向量链测试使用临时 SQLite/文件系统、合成向量文件及 mock Transport，没有调用真实 Provider。会话来源回归验证群记录不进入 owner 查询，缺少 `chat_id` 的群记录 fail-closed。生产 `main.ts` 在监听端口前校验正式 PG 索引迁移状态，只在 `applied` 时启动 Worker；首次 Worker 运行会为既无索引也无任务的 owner/source 幂等建立全量基线任务，不覆盖已有增量任务；关闭时停止并等待当前任务。近期 Host Agent/RAG 定向测试 **26/26 通过**，Core RAG/build 与 Host/Core 定向类型检查通过。正式 PG/隔离 PG、真实生产 embedding 凭据解析/端口装配及 Web Agent Run 对工具端口的生产装配仍未验收；Python pytest 当前环境缺少 pytest/venv，不能据此宣称 Python 全量等价或生产搜索已上线。

### 首次 RAG 索引基线与持久会话工具（2026-11-15）

首次启动队列只处理“无该来源索引行、无该来源任务行”的 owner/source；已有增量任务或索引不被覆盖，空 source ID 由 Core Worker 作为全量来源重建。通过临时 SQLite 验证重复启动幂等、已有 project 增量队列不变、已有 calendar 索引不重复入队，并验证 Host 生命周期实际消费任务、写入正式索引表。`search_conversations` 经真实工具注册/dispatch、正式 Jieba、持久会话来源与正式索引表验证，按 Python `strategy="bm25"` 固定词法检索；测试不再为历史会话调用 embedding。混合/向量召回在 memory RAG 切片另以合成向量及 transport 验证。授权拒绝不会返回命中正文。真实 PG、多实例启动、生产凭据/向量来源及 Web Run 资源装配仍未验收。

### Knowledge RAG 授权文件来源（2026-11-15）

Core 新增 `createKnowledgeRagSource`，从 Host 注入的 `AgentKnowledgeReadStore` 读取 owner 授权知识 Markdown；只将 Python `KnowledgeAdapter` 对应的 canonical 投影写入派生索引，保留 topic/keywords/description 摘要、元数据版本戳、owner/group 等来源 scope 与软删除过滤。Core 临时 SQLite 用例经持久任务 Worker 写入 `knowledge_index_entries`，覆盖 owner 目录边界、foreign owner、inactive 条目、非 Markdown 文件、全量/单条读取、取消、版本更新、删除墓碑及群 scope 投影；定向会话/RAG 文件 **42/42 通过**，Core build 执行成功。Python pytest 未能运行：devserver 无项目 pytest，系统 Python 也无 pytest。Host Worker 工厂现支持显式注入知识存储，但生产 `main.ts` 未提供授权 FS 端口，故生产仍不构建 knowledge 索引；memory scope 服务、PG、生产 Run、Python/固定语料差分继续未验收。此切片未调用真实外部服务；存储使用内存模拟，索引与队列使用隔离 SQLite。
Host 来源组集成测试另经真实 `startAgentRagIndexWorker` 把临时 owner 文件和隔离 SQLite 队列连到 Core Worker，确认 project 与 knowledge 均写入正式索引、knowledge 回执变为 ready，同时 memory 因来源未注入保持 queued；该 Host 测试文件 **7/7 通过**，Host 来源/Worker/测试定向严格类型检查通过。此为 Host 真实组装工厂的 SQLite 集成，不是 Web PostgreSQL 生产 Run 验收。

新增 Web Host `createLocalAgentKnowledgeReadStore`，固定到可信 Host storage root 和 Core Worker 提供的 owner；读取复用 `@gugu/fs/node` 的 symlink/越界防护，目录枚举仅返回普通 `.md` 文件并支持 keyset 分页，单文件读取限制 1 MiB。Node 临时目录安全测试 **1/1 通过**，Host reader/Worker 工厂定向严格类型检查通过；该 Host reader 尚未由生产 `main.ts` 注入，不构成线上索引接入。

### 1.7.7 Memory loader 迁入 Core（2026-11-15）

按 Git tag `v1.7.7` 的 `backend/ts/workers/rag/src/memory-loader.ts` 迁移完整 loader 到 `packages/core/src/agent/rag/memory-loader.ts`，删除旧 worker 的 `DataRuntime`/`StorageReader` 绑定，改由 Core 契约接收 trusted scope-state 与 Host storage reader；`@gugu/core/agent` 导出 `prepareMemory`、`loadDocumentVectors` 和必要端口。回归覆盖 owner index 外主记录过滤、daily、向量模型版本筛选、空 pattern tombstone 不回退旧 facts、owner 校验、群 scope tombstone/投影和 snapshot 去重。Core 定向回归 **4/4 通过**，Core `typecheck` 与 build 通过。Host 新增 `createLocalAgentMemoryRagStore` 和临时目录用例，固定 owner namespace、文件白名单、文件大小/字符上限并拒绝跨 owner key、路径穿越、`.env`、未允许的 owner memory 根文件及符号链接，Host 回归 **1/1 通过**、新增 Host 文件定向严格类型检查通过。

这些用例使用隔离临时 FS、内存 scope-state 替身，没有真实 scope 授权服务或 PG。全量 Host typecheck 仍被并行测试中的 user-list fixture 元数据缺项和 BYOK 测试类型错误阻断，未修改对应文件。memory loader 是查询时准备逻辑；scope 枚举/授权、PG scope-state 适配、生产 memory 调用方和持久 Worker 来源仍未接通，不能标记生产 memory/RAG 完成。

### RAG scope 状态查询与生产 knowledge 来源接线（2026-11-15）

Core 新增 `createSqlMemoryScopeStateReader`，沿用 1.7.7 Data Runtime 查询的完整 owner/platform/bot/scope key、group→`group`、member→`platform-user` 映射、`missing`/`version:updated_at` revision 和 tombstone 语义。新增隔离 SQLite 实际 SQL 回归，与原 loader 合并后 **5/5 通过**；覆盖 owner 不匹配、missing cursor、成员类型和删除屏障。Core typecheck/build 通过。该 reader 只查状态，不提供 scope 授权或枚举。

生产 `main.ts` 现仅在 RAG schema 检查为 `applied` 时，把 `createLocalAgentKnowledgeReadStore(config.storageLocalPath)` 注入已有 Worker。Host 临时目录 + SQLite 测试通过 `startAgentRagIndexWorker`、持久任务队列和正式索引表，验证 knowledge 文档真实入表并将任务置为 ready，未就绪 memory 任务保持 queued；Host Worker 文件 **7/7 通过**。Worker 的关闭/取消、串行排空和首次基线幂等仍由同文件回归覆盖。此接线未在正式 PostgreSQL/部署环境验收。

先前 Host 类型检查曾被并行新增模块的导出缺失阻断；本轮 Core build 后 Host 生产源码 typecheck 已通过。对应 Python pytest 未能运行：本机未安装 pytest，2.0 工作区没有项目虚拟环境。生产 Agent Run 仍没有 `createAgentToolRegistry` / `search_conversations` 资源装配 caller；memory scope 授权、真实 PG、真实生产 embedding 与 Python 全量行为对照仍未完成，不能据此宣称 Agent RAG/search 已经生产接通。

### search_memory Core 查询链（2026-11-15）

新增 `createMemorySearch`：scope 必须来自 Host `resolveScopes`，并在读文件前和返回前重验授权；Core 复用 1.7.7 `prepareMemory` 读取 owner/group/member 来源、tombstone/snapshot/source 过滤与版本匹配向量，然后使用共享 TS BM25/混合召回与 `rankCandidates`。`search_memory` 工具沿 Core 注册器校验 query/scope/source/strategy/1–25 limit；Web Host 只有显式注入 `memorySearch` 端口才注册，并按 `search_memory` 权限再次检查。未接受模型提供的 owner/group/member 身份。

Core 实际注册器 dispatch 测试原 **3/3**，新增版本匹配向量端到端召回后 **4/4 通过**：使用临时合成 owner memory index 和 scope-state/授权/snapshot/embedding 替身，验证词法与混合召回、来源、异主索引行隔离、模型伪传身份无效、权限撤销、空 query 和非法 limit。新增 Web owner-only Host adapter，复用 owner-bound FS reader 与 SQL scope-state reader；临时 SQLite + owner memory 文件经 Host `createAgentToolRegistry`→Core RAG→实际 dispatch **1/1 通过**，覆盖 BM25 与 Host 向量文件/受控 mock transport 的混合召回、凭据不泄漏、异主索引行过滤、非 IM `current_group` 按 Python 语义收敛到 owner scope、授权关闭不读取快照。Host registry 独立用例 **16/16 通过**，确认缺注入时隐藏、有注入时只传可信 RunIdentity。这里使用临时 DB/FS、合成授权/快照/Jieba/embedding 与向量文件，未连接真实向量 Provider。Core typecheck/build、Host typecheck 通过。Python `test_rag_memory_service.py` 和 `test_search_memory_boundary.py` 本环境未能运行：未安装 pytest。

剩余关键缺口：Web owner-only Host 适配器支持注入 BYOK resolver/受控 transport 并调用向量召回；Host 另有从可信 IM context + owner reflection cursor 按 Python 规则解析 scope 的 resolver，但尚未从生产 Agent Run 注入可信上下文、逐 scope 授权、凭据服务和向量能力。故 `search_memory` 仍是已实现待接入；真实 PostgreSQL、平台会话授权、生产 embedding 和 Agent Run 运行不能标为完成。详见 Core RAG README。

### IM memory scope dispatch 回归（2026-11-15）

Host `agent-memory-scopes.ts` 复刻 Python `resolve_memory_query_scopes`：IM 平台和角色来自 Host 注入上下文；跨群只查询当前 owner 的 `memory_reflection_cursors`；成员查询只匹配同一 platform-user scope；owner/member 的群数上限、排除当前群、私有 memory 拒绝规则与请求 scope 映射保持 Python 语义。Web Run 没有 IM 身份时仍只解析 owner scope。

新增临时 SQLite + 文件夹具经 `createAgentToolRegistry` → Core memory search → 工具 dispatch，验证 member 的 current_group 和 all_my_groups 只返回本人群记忆、owner 跨群不返回成员记忆、当前群之外的结果只在显式跨群请求时出现，且模型传入伪造 owner/group 字段不扩展授权。该回归还固定了同名 memory source key 在多个 scope 下必须都能参与排序，防止 transient index 的 ID map 覆盖合法文档。Host 定向 memory 组 4/4、Core memory loader/search 9/9 通过。授权上下文、cursor、scope 文件均为合成数据，未连接生产 IM、PostgreSQL 或 Agent Run。

### RAG 工具和来源回归复验（2026-11-15）

Web owner-only memory dispatch 回归补正快照读取次数：成功的 owner 查询与 Web 非 IM `current_group` 查询各读取一次快照；随后撤权的调用在 registry 权限门被拒绝，不再读快照。另经真实 Host dispatch 撤销检索中 scope 授权，验证第二次授权检查拒绝结果且不返回已读取的记忆正文。验证仍走临时 SQLite、owner memory 文件、合成授权/快照、合成向量文件及 mock embedding transport。Core RAG memory-loader/search **9/9**、含会话/知识/项目/日历/便签/画布来源与持久 Worker 的共享数据回归 **42/42** 通过；Host 工具注册、会话搜索、memory 搜索、持久 Worker、知识/记忆文件 reader、BYOK gate 与正式 Jieba **31/31** 通过；Core build 通过。首次 Host 定向运行因 devserver 缺少最新 Core dist 失败，先在同一已同步副本构建 Core 后重跑通过。

BYOK embedding resolver 必须先通过 Host BYOK gate 才查 owner credential，并在解密后及发送 query embedding 请求前再次确认 gate 仍开启；关闭时不查库，读取/解密期间或请求开始前关闭时不返回 API key、不发起网络请求。现在 Web memory 的真实注册器 dispatch 经该 resolver、合成 owner credential 行、mock 解密及 mock Transport 完成混合向量召回；更新后的 Host memory 测试文件 **3/3 通过**。这验证 Host→Core RAG→工具调用链，不代表真实 PostgreSQL 或生产密钥/Provider 服务。

Host 全量 typecheck 未通过，错误见并行新增的 user-list fixture、BYOK 测试与 folder-writes 测试，未改动这些文件；本次 RAG 实现和测试没有新增诊断。Python 基准测试未能启动：devserver 没有项目 pytest，系统 Python 也未安装 pytest。当前没有真实 PG、生产 embedding 或生产 Agent Run 验收；`createAgentToolRegistry` 尚无生产 Run caller，Web RAG 授权/快照和 IM scope 仍须由可信 Host 装配，所以这批回归不改变“已实现待生产接入”的状态。

### 1.7.7 RAG 排序与真实 Jieba golden 回归（2026-11-15）

Core 新增旧版排序行为回归，固定 confidence-v4 默认版本、首选/低分阈值、来源质量、confidence-v1 回滚、零匹配保护及 corpus IDF 重评分分数上界；可控 Jieba 词边界覆盖日期/月名别名、May/March 普通词排除和索引/查询一致性；迁入 1.7.7 的 note/calendar/scheduled_task/canvas/conversation 文本投影、版本哈希、相邻上下文、分块及退役 file 索引回归；还固定 memory cache 的滑动 TTL 与 LRU 行为。另以受控 `ProviderTransport` 覆盖 OpenAI/Bailian embedding 请求格式、非法 URL 拒绝、redirect 不跟随、超大响应取消和结果凭据脱敏，不调用真实 Provider。Web Host 的 Jieba 回归读取 Python tokenizer golden fixture，经 Host `getAgentRagJieba()` → Core `tokenizeRaw()` 实际验证固定词项。Core 排序/分词/来源/embedding/cache 定向测试 **26/26**、Host Jieba golden **2/2**、会话 dispatch/记忆 scope 与向量/索引 Worker **13/13** 通过，均 0 失败/跳过。相关 Python tokenizer 与会话历史 pytest 已尝试，但 devserver 的系统 Python 未安装 pytest（`No module named pytest`），因此本轮 Python 对照为未运行，不能记作通过。

Core tokenizer 用例中的 Jieba 是确定性替身；Host golden 用例使用锁定的 `@node-rs/jieba@2.0.1` 包内词典。这些用例补强历史分词/排序回归，不替代 Python pytest 差分，也不改变生产接入状态：生产 Agent Run 对 `createAgentToolRegistry` 的装配、正式 PostgreSQL 迁移/查询验收以及真实授权 scope 与 embedding Provider 仍未验收，`search_conversations` 仍属部分实现。

### `search_conversations` 经 AgentRuntime Runner 续轮（2026-11-15）

Host SQLite 会话回归新增一条完整的 Node Agent 调用路径：实际 `createAgentRuntime` / Core Runner 发现并暴露 `search_conversations` schema，mock Provider 返回工具调用，真实 Host registry dispatch 通过 `createCoreAgentConversationSearchPort` 查询 owner 限定的会话事实表，再由 Provider 续轮实际收到 Python 兼容结果字段（会话标题、摘要、来源、时间、角色和 snippet）。此路径匹配 Python `ConversationAdapter`：事实表产生 OR/AND 候选、排除群聊及非 user/assistant 消息，再交统一 ranker；不以持久索引 BM25 代替旧 SQL 来源。另一组工具回归单独验证持久索引适配器和 Worker。对应测试文件 **3/3 通过**，包括原有事实表/持久索引行为和 Runner 续轮用例。测试使用隔离 SQLite、合成 Provider transport、RunStore、上下文和授权；查询适配器、工具注册器及 Runner 为实际实现，不调用真实 Provider。

该用例证明 Harness/Runner → 工具注册 → Core RAG → Provider 续轮的 Node 行为链，不证明 `main.ts` 已生产装配 `createAgentToolRegistry`，也不覆盖真实 PostgreSQL、生产凭据/授权服务或 Python pytest。Host 全量 TypeScript 检查仍由并行 `user-list`、BYOK、文件夹写入及定时任务测试类型错误阻断；本次 RAG Runner 测试没有新增诊断。

### 2026-11-15 RAG/工具回归复验

在 devserver 对当前同步版本串行复验：Core `tests/agent/rag` **35/35 通过**；Host 会话搜索/Runner、memory scope 与向量/BYOK、RAG 持久 Worker、正式 Jieba **16/16 通过**。Host 使用正式临时 SQLite schema、临时目录及锁定 Jieba；Provider transport、RunStore、上下文、scope 授权和 BYOK 凭据/解密使用合成依赖，未连接真实 PostgreSQL 或外部 Provider。Python pytest 未运行：devserver 的 Python 环境提示 `No module named pytest`。这次复验只确认已有实现的 Node 行为，生产 `main.ts` 仍无 Agent Run 对工具注册器的调用者；不改变生产状态。

同批补充了 `search_conversations` 时间投影边界：实际注册器 dispatch 用例扩展到 **42/42 通过**；另在 pytest 缺失时直接对照 Python `datetime.fromisoformat` 的 6 种偏移输入。Python 会规范化偏移中超范围的分钟/秒分量，但拒绝归一化后达到 24 小时的偏移；Core 原实现已一致，未更改生产解析逻辑。

同日曾发现候选上限与会话去重顺序差异，并据此尝试了持久索引搜索。随后对照 Python `ConversationAdapter.retrieve` 确认：Python 在事实表查询中先按会话选出最新命中，再限制候选；因此不能把多个持久索引消息交给工具层去重。该临时 Indexed adapter 已删除，当前工具按事实表 SQL BM25 路径执行；修正与回归证据见本文末尾“`search_conversations` 恢复 Python 事实表召回语义”。

### 1.7.7 memory 持久来源接入 Core Worker（2026-11-15）

新增 Core `createMemoryRagSource`，复用 `prepareMemory` 把旧版 owner memory index/legacy 文件和 Host 提供的 group/member scope 投影为正式索引文档；Host `createPostgresAgentMemoryIndexScopeReader` 只按 job owner 枚举 reflection cursor，不将索引存在误作授权，随后由 Core scope-state 查询复核版本与 tombstone。Worker 在显式提供 `memoryStorageRoot` 时才启用 memory source，默认仍关闭。

Node 回归经真实 Host scheduler → 持久 Worker → Core source → 正式 `knowledge_index_entries` 写入临时 SQLite，覆盖 owner、群与成员记忆、异主数据过滤、tombstone 屏障和任务完成；新增两个群的原始 source/version/chunk 完全相同的情形，验证持久表仍写入两条按 scope 命名空间隔离的记录。Core `memory-loader.test.ts` **6/6**、Host `rag-index-worker.test.ts` **8/8** 通过，Core build 通过。使用临时 SQLite/FS 和合成 reflection cursor，不连接 PostgreSQL 或真实用户存储。生产 `main.ts` 尚未注入 `memoryStorageRoot`，也未发现 Node memory 写入路径生成 RAG job；这只补齐可接入的 rebuild source，不表示生产 memory 索引新鲜度、`search_memory` SQL 召回或 Agent Run 装配完成。

本轮复验（2026-11-15）：Core `tests/agent/rag` 全部 **36/36**、Host Worker **8/8**、Host 会话 Runner/Worker/Jieba 合并回归 **14/14**、Host memory scope/向量/BYOK/工具 dispatch **4/4** 通过，Web Host 生产包 build 通过。Host 正式索引迁移测试 **2 项因未配置隔离 PostgreSQL 而跳过**；Python pytest 未运行，devserver Python 环境缺少 pytest。Host 测试使用隔离 SQLite、临时文件、合成 Provider/授权/RunStore 与正式 Jieba；未连接真实 PG、Redis、真实 embedding Provider。生产来源更新生产者仍未完整覆盖，`main.ts` 尚未注入 memory 存储，生产 Agent Run 尚无 `createAgentToolRegistry` 调用者；本轮 Node 回归不能替代这些生产验收。

### Mind 写入到正式 RAG 索引的事务闭环（2026-11-16）

Mind SQL 写入现与 `rag_index_jobs` 同事务提交：便签 create/update/delete/restore 使用文档级 source ID；canvas 由于来源适配器的 ID 表示 canvas item，创建/删除画布、便签及项变更和涉及 Mind 投影的 Undo/redo 使用全来源重建，避免将 canvas ID 误作 item ID。画布 layout 的直接和批量更新统一由 `canvas-item-update-sql` runtime 排队；确认无字段变化时不排任务，单次批量更新只增加一次 generation。Mind Undo 和恢复以主数据重投影清理墓碑或重新建档。

Core `tests/mind/rag-freshness.test.ts` **5/5**，与 Core `tests/agent/rag` **36/36** 合并定向运行 **41/41** 通过。真实工具边界是 Core SQL mutation→隔离 SQLite 持久队列→真实 `createSqlRagRebuildWorker`→`knowledge_index_entries`；测试覆盖 owner 隔离、回滚、无变化、删除/恢复及画布全来源重建。运行使用临时内存 SQLite，不使用真实用户数据或 PostgreSQL。同日 Host 对话事实表/持久索引与 AgentRuntime Runner、memory scope/向量/BYOK、RAG 调度/Worker/基线 **16/16** 通过，依赖使用临时 SQLite/FS、正式 Jieba 和合成 Provider/授权/凭据。本轮 Core 全量 `typecheck` 已通过。Python pytest 与隔离 PostgreSQL 迁移未运行。生产 scheduled-task/conversation/knowledge/memory 更新生产者、memory root 注入和 Agent Run 对工具注册器的装配仍待完成。

2026-11-16 后续 devserver 复验：Core 全量 `typecheck`、Core `build` 通过；Core RAG + Mind freshness 定向测试 **8 个文件、41/41** 通过。首次 Web Host 全量 TypeScript 检查因 `@gugu/fs/node` 旧生成产物未包含其已存在源码导出的 `removeLocalTree` 而失败；构建 `@gugu/fs` 后，Host `tsconfig.build.json` 检查通过。Host RAG 行为测试 **16/16**；devserver 未配置隔离 PostgreSQL URL，也未安装 pytest，因此 Python pytest、真实 PostgreSQL 和生产 Agent Run 未验收。

生产消费者盘点（2026-11-16）：Web Host 在 RAG 索引迁移已应用时启动 Node 持久 Worker；Python FastAPI lifespan 同时无条件启动 `start_rag_index_recovery()`，由 `agent.rag.pipeline` 使用 Cython 检索/索引 pipeline。两者连接同一 PostgreSQL `rag_index_jobs`；实现共享任务状态、租约与 generation fencing，设计上防止两端重复提交，但跨进程 PostgreSQL 竞争尚未验收，具体执行引擎由谁先领取决定。故当前 Node Worker 可消费队列不等于 Node/TS 已接管生产，也不满足 Node-only 生产检索目标。Node-only 切换需停用 Python 消费循环并确认写入/读取调用方切换，当前未做。

### Conversation 写入到 RAG 队列的事务闭环（2026-11-16）

Web 用户消息准备与 Canonical 历史终态写入现在调用 Host `enqueueConversationRagRebuild`，并与会话消息在同一 PostgreSQL 事务提交。该来源的索引覆盖 owner 的多个 session，因此任务使用空 `source_id` 和空 pending 列表触发全量来源重建；新增 generation 同时清除旧租约及细粒度 pending，避免遗漏新消息或把 message ID 误作文档 ID。caller 级 PG 测试验证消息事务回滚会一并撤销索引任务、失败不会额外推进 generation。

devserver 本轮复验：Host 会话准备/Canonical 写入、`search_conversations` Runner、RAG 调度与 Worker 定向集合 **22 通过、6 跳过、0 失败**；六项均需隔离 PostgreSQL，包含新加的全来源任务合并、generation/租约 fencing 和事务回滚用例，因 `GUGU_WEBUI_TEST_DATABASE_URL` 未配置而跳过。Web Host 生产源码 `tsconfig.build.json` 检查通过；包含测试的全量 `tsconfig.json` 有 16 项其他测试类型诊断，本次生产与测试文件均无诊断。devserver 上对应源码与测试 SHA-256 已和工作区逐文件相符；Mutagen 另外三处生成目录冲突未 flush、未覆盖。Python `test_rag_index_jobs.py` 与 `test_rag_phase5_convergence.py` 未运行：devserver 没有项目 `.venv/bin/pytest`。因此该切片的生产 PostgreSQL 与 Python 回归仍未验收；它补齐 Node conversation 更新生产者，但不改变 Python/Cython 与 Node Worker 共用队列、实际 Agent Run 尚未装配工具注册器的状态。

### 定时任务变更进入 RAG 队列（2026-11-16）

Node scheduled_task 的 create/update、显式删除、一次性完成删除、项目回收/过期、日历撤销/重做和工作区解绑现会在主数据事务中合并 `scheduled_task` 索引任务；待处理 source ID 去重保序，generation 增长并清理旧租约，删除通过来源读取为空文档形成索引墓碑。Core 与 Host task producer 都保留初始及先前 source ID，避免连续变更时仅重建最后一个任务。devserver 隔离 SQLite 有效子集 **4 个文件、17 项通过、2 项 PostgreSQL 子测试跳过、0 项失败**，覆盖 Core calendar mutation、一次性任务、工作区删除与 scheduled-task 删除新鲜度。不含 Host PG 回归。一次误将 PG-only 文件纳入命令的运行因未配置 `GUGU_CORE_TEST_POSTGRES_URL` 在套件加载时失败，随后 SQLite 子集重跑通过。Host PG、Python pytest 与生产部署均未验收；本轮没有重跑 typecheck/build。Mutagen 3 处生成目录冲突未 flush、未覆盖。knowledge 与 memory 仍缺 Node 写入端及 freshness producer。

### 日历提醒变更的事务内索引失效（2026-11-16）

补齐了 Core 定时任务来源失效入口：日历改期/删除导致的提醒更新、Core Calendar Undo/redo、一次性完成任务删除和 Core 工作区解绑，现在通过共享 `scheduled-tasks/rag-index-job.ts` 在同一个主数据事务内合并 `scheduled_task` RAG job。Core 日历参数化回归加入 source ID 合并、generation 递增、事务失败回滚和 Undo 断言；一次性任务测试断言已完成删除入队；工作区真实 SQLite 事务测试断言只为 owner 普通任务排队，并把队列纳入回滚快照。devserver 隔离 SQLite 有效子集 **4 个文件、17 项通过、2 项 PG 子测试跳过、0 项失败**。一次误将 PG-only 文件纳入命令时因缺少 `GUGU_CORE_TEST_POSTGRES_URL` 在套件加载阶段失败；随后排除该 PG-only 文件，SQLite 子集重跑通过，该失败不计为测试通过。Host PG 回归因缺少隔离库未运行；Python pytest 因无项目 `.venv/bin/pytest` 未运行；本轮未重跑 typecheck/build。Mutagen 3 处生成目录冲突未 flush 或覆盖。

### Python RAG rank 回归补齐到 Core（2026-11-16）

Core `tests/agent/rag/ranking.test.ts` 依据旧 Python `test_cython_rank.py` 补齐首选分数段和无关内容过滤、top-k 绕过多样性门控、历史正文 hash 排除、重复内容引用聚合、上下文 UTF-16 输出预算、未截断空白保留、0.55 精确阈值、低置信度后备段、confidence-v1 固定分数、父文档上限及相似度去重。devserver 定向 Vitest **15/15 通过**。测试对词项使用确定性 tokenizer 替身；预期分数、选择及诊断对照旧 Python pytest 中固定断言，本轮没有运行 Python pytest，因此这是移植的回归契约，不是本轮 Python/TS 在线差分或完整检索质量语料验收。

### 本地追加复验（2026-11-16）

Core RAG、conversation search 和 ranking 定向集合 **7 个文件、47/47 通过**。Host `search_conversations` direct-source/持久索引工具分派、Runner 续轮、持久 Worker/基线和正式 Jieba **14 通过、2 跳过、0 失败**；两个跳过项需要隔离 PostgreSQL。测试使用临时 SQLite/FS、正式 Jieba及合成 Provider、授权和 RunStore；未连接真实 PG、Redis 或 embedding Provider。Python 命令 `python3 -m pytest backend/tests/agent/rag/test_cython_rank.py backend/tests/agent/test_search_tools.py` 因本机没有 pytest 模块而未执行。Core 与 Host 的依赖包 build 通过。该复验确认工具注册/Runner 的可运行链，但不代表生产 Agent Run 已装配该注册器，也不代表 Node 已独占共享 RAG 队列。

本轮 Host 生产包构建结果：Core 和 `@gugu/fs` 依赖包构建通过；`@gugu/webui` build 被并行变更中的 `src/modules/admin/llm-capability-probe.ts` 阻断（Core 导出 `createLlmCapabilityProbe`、`LlmCapabilityProbeError` 缺失，并有随之产生的类型诊断）。错误文件不属于本轮 RAG 改动，未改写或规避；因此不能报告 Web Host build 通过。

### 1.7.7 RAG 生命周期缓存/服务回归补齐（2026-11-16）

旧 tag 的 `index-cache-service.test.ts`、`snapshot-cache.test.ts`、`rag-service.test.ts` 原先没有 Core 同名调用边界回归。本轮新增 `packages/core/tests/agent/rag/service-cache.test.ts`，覆盖索引滑动 TTL 与 revision invalidation、snapshot revision/TTL/scope隔离、同 scope/revision 复用与更新重建、拒绝跨 owner 复用、构建失败后再次加载以及查询错误不能转为空结果；用冻结时钟和受控 Core engine，不访问外部服务。devserver 新测试 **6/6**，严格 TypeScript 单文件检查通过；Core RAG/search/ranking 合计 **8 个文件、53/53**。本地到 devserver 的相关源码、测试、manifest 和文档 SHA-256 一致。Host 真实工具分派、Runner 续轮、持久 Worker、基线与正式 Jieba **14 通过、2 项隔离 PG 跳过、0 失败**；Core 与 Web Host build 在 devserver 通过。Python pytest 仍未运行：devserver 缺 `backend/.venv/bin/pytest`，系统 Python 也没有 pytest 模块。

`v1.7.7` 本地 Git tag 确认指向 commit `14c544f1faf1193e8a073844af4a5d7a4872045c`、许可证 Apache-2.0；旧 Worker 运行依赖 Jieba 2.0.1 与 ali-oss 6.23.0。2.0 将旧 JSONL/Data Runtime 协议替换为共享 Core RAG 服务和 Host 注入端口；Local-only 文件策略下不迁 Ali OSS，Jieba 由 Host 提供。旧 TS 算法模块均有 Core 映射；固定检索质量语料已由旧 Cython 与 Node Core 共跑：四个有效查询均 Recall@3=1、MRR=1，无关查询均为空。上述测试不改变生产 Agent Run 未装配 registry、memory 授权/embedding 未注入、knowledge/memory Node 写入 producer 缺失、Python/Cython 与 Node Worker 共享队列、PostgreSQL migration 未真实验收等状态。

### 统一向量检索降级（2026-11-16）

Core `createScopedRagSearch` 现在对 query embedding transport 错误执行 Python 兼容的 BM25 降级，并在返回结果前继续复核 scope 授权；调用信号取消仍传播取消错误。devserver 定向行为回归 **3/3 通过**，实际验证 owner-bound 向量版本读取和 hybrid 重排，使用合成索引、模拟 embedding 和确定性 tokenizer，不调用真实 Provider。此修复只覆盖共享检索服务的降级边界，不证明生产 Agent Run 已装配该服务或实际 embedding 凭据/授权端口。

此前 Host 对照曾用持久 TS RAG 验证 `search_conversations` dispatch；该用法在核对 Python 事实表召回后已移除。现在 Runner 续轮和工具搜索使用 TypeScript SQL BM25 来源；持久 Worker 的队列消费、generation fencing 与墓碑由独立 Worker 用例覆盖。当前验收以本文末尾的 Python 行为修正记录为准。

### RAG 基准与生产来源增量（2026-11-16）

在 devserver 的临时 Python venv 中安装项目 requirements 与 `compat/core-python` editable package 后，旧版 `backend/tests/agent/rag` 全集 **279/279 通过**，旧版 `search_conversations`、`search_memory` 与工具 schema 用例 **37/37 通过**。这保护 Cython 编译/运行、tokenizer、来源投影、索引任务生命周期、scope/owner 过滤、向量缓存及旧工具参数/结果行为；测试数据由仓库隔离 fixture 提供，Cython 产物写入测试临时目录。首次完整运行只有一个子进程因为临时 venv 未安装 `gugu_core` 失败；安装仓库 editable 包后该用例单独通过，整组复跑通过。

Node Core RAG 定向回归 **9 个文件、56/56 通过**；标准 Core Vitest 配置因并行会话加入但未登记 suite 的新测试无法加载，使用临时 RAG-only Vitest 配置运行，未修改共享测试清单。Host RAG/会话集合 **17 通过、6 跳过、0 失败**；6 项都需要隔离 PostgreSQL URL，SQLite/FS 为临时数据，Jieba 使用正式 1.7.7 同版包内词典，授权/IM context/凭据/embedding transport/Provider 为模拟依赖。Host production build 通过。Node 调用链验证了工具注册器 dispatch、AgentRuntime Runner 续轮、持久索引 Worker、memory 来源重建和 URL-independent owner 文件边界；没有连接真实 PG、Redis、外部 Provider 或真实 embedding 服务。

2026-11-16 当前源码复验：devserver 使用 Core 标准 Vitest 配置显式选择 `tests/agent/rag` 和 Mind RAG freshness 文件，Core RAG **9 个文件、57/57**、Mind freshness **1 个文件、5/5**，合计 **10 个文件、62/62** 通过；本次只验证 Core RAG 排序、tokenizer、scope/owner、向量降级、cache revision/TTL、来源适配及 Mind freshness，不连接 PG、Redis 或外部服务。该显式文件选择未要求 Vitest 加载未登记的其他 suite，因此不代表 Core 全量测试发现配置已解决。

生产 Worker 装配现通过 `main.ts` 将 `config.storageLocalPath` 注入 `memoryStorageRoot`，使 memory loader/source 成为迁移门控通过后的重建来源；memory 写入仍缺 Node job producer。生产 Agent Run 仍没有 `createAgentToolRegistry` caller，可信 IM scope、memory 授权和 embedding 尚未接入。Python FastAPI 现遵循 `AGENT__RAG_INDEX_WORKER_OWNER`：默认仍由 Python 消费；配置为 `node` 时只持久化 job，不启动 Python 内存 Worker 或恢复消费者。代码分支已有回归，但尚无两端统一配置及部署切换证据。正式 PostgreSQL migration 仍未验收，因此上述测试与入口接线不代表生产 RAG 全量迁移完成。

共享固定质量语料复验（2026-11-16）：Host 正式 `@node-rs/jieba` + Core lexical index **1/1**；旧版 Cython fixture pytest **1/1**。两端逐查询结果一致：部署、天气、GTA6 发售和 owner scope 查询均 Recall@3=1、MRR=1；无关查询为空；完全匹配 owner scope 查询词的 group 干扰文档不出现在结果中。Node 测试用例经过正式 Jieba 和 Core 索引实际查询；Python 测试通过临时副本执行，复用仓库固定语料和当前测试源码，只将 fixture 路径改为临时副本路径，Cython 扩展编译在独立临时目录。该项补齐词法相关性与 scope 裁剪基准，不涉及 PG/真实向量服务或生产 Agent Run；因 Mutagen 会话现有构建产物冲突，本轮没有全量 flush。

### 持久 RAG 索引损坏错误映射（2026-11-16）

Core 持久索引读取遇到无法解析的 `metadata_json` 时，原先把 `JSON.parse` 的 `SyntaxError` 直接传播。现在映射为固定的 `RAG 索引元数据无效`，避免错误携带索引内容；Host 临时 SQLite 测试先复现失败，再排入真实持久任务，由 Core rebuild worker 重写来源投影，验证 job 状态为 `ready` 且 snapshot 恢复，**1/1 通过**。测试在 devserver 临时副本运行，SQLite 和测试文件均隔离；不涉及 PG 或生产 Run。


### 清除记忆后失效持久 RAG 索引（2026-11-16）

旧顺序先删除 owner `.agent`，再排队墓碑；如果 FS 删除部分失败，尚未失效的旧 Worker 可能把已读到的正文重新写回索引。Core 现提供必需的 `invalidateAgentMemoryRag` 端口：先在一个 SQL 事务中墓碑化 owner 的全部 memory 投影，并把当前 generation 结算、清除租约以 fence 已领取的旧 Worker；只有源目录清理成功后，Host 才排入新的完整重建 generation。`main.ts` 已将该操作装配到生产 `clearAgentMemory` clearer。devserver 临时 SQLite/FS 的 Fastify 路由 → Core clearer → 持久索引/任务 → 延迟旧 Worker 实际写入边界回归 **5/5 通过**，并验证 owner 隔离、清理错误传播、删除失败后旧正文不可搜、旧 Worker 返回 `superseded`、成功清理后队列重建与墓碑事务回滚。测试使用合成 owner 与临时文件；因 Host 测试包没有直接链接 Core 的 `kysely` 开发依赖，运行时临时建立该包链接并在退出时删除。Core 构建、Web Host production-source TypeScript 检查通过。Python endpoint pytest、隔离 PostgreSQL、生产 Linux 目录删除和真实 `startServer` 数据库装配未验收；普通 memory 更新和 knowledge 写入仍缺 Node RAG 任务生产者。

### 从持久 Run 解析可信 IM memory 身份（2026-11-16）

新增 Host `createPostgresAgentImMemoryContextReader`：按 owner、session 和活动 run 读取当前入站 user 消息，并关联 owner 自己的 Bot 绑定来确定平台、channel 与 owner/member 身份；消息可处于当前 run 尚未完成归档的状态，session 的 `active_run_id` 必须匹配本次调用。非 IM 会话返回 owner-only 语义，IM 会话缺消息、Bot 绑定或必要身份字段时返回固定授权错误，不回退成 owner-only。新增 `createPostgresAgentMemorySearchPort`，把该可信上下文、owner reflection cursor scope、Host FS、Core RAG、授权与可选 embedding 组合为一个 Web PostgreSQL memory search port。memory 工具组合回归 **5/5 通过**，新增 reader 覆盖 owner/member 投影、owner/session/active-run 查询绑定、缺失上下文拒绝和取消时不查询数据库；IM 测试经该组合工厂与真实注册器 dispatch，底层 PG 行由合成 Pool 提供，索引与来源用临时 SQLite/FS；两个 Host RAG 模块严格 TypeScript 检查通过。该回归未连接 PostgreSQL，且生产 Agent Run 尚无 registry 调用方，因此工厂仍未装配进生产 Run。

### 1.7.7 memory 向量键与 scope 命名空间兼容（2026-11-16）

持久 memory 文档为区分同一 owner 的 owner/group/member 同源文档，会把 SQL `parent_document_id` 加 scope 命名空间；旧 `memory_vec.json` 的 key 仍使用 1.7.7 原始 parent ID。Core 向量读取器现优先用 Host/Core 来源投影保留的 `metadata.memory_parent_id` 查旧向量，同时仍以持久文档 ID 关联 hybrid 结果。devserver 临时副本中 `createScopedRagSearch` 定向用例 **4/4 通过**；新增用例经真实 `createMemoryRagSource` 读取合成的 1.7.7 owner index、生成 scope 命名空间文档，再读取旧向量文件完成 hybrid 查询，保护来源元数据到召回的整段映射；严格 TypeScript 检查通过，不调用 embedding Provider。此前完整 Python RAG 基准验证的是旧 key 投影，本轮未重跑 Python。生产 Agent Run 尚未注入可信 scope 与 embedding，真实 PostgreSQL 和外部 embedding 未验收。

### BaseSkill Web 工具切片：`http_get`（2026-11-16）

`backend/agent/tools/web.py::http_get` 对照 Core `packages/core/src/agent/tools/web.ts`，Host 边界在 `apps/web-host/src/domains/agent-sessions/tools/agent-tool-registry.ts`：Core 实现参数校验、默认/硬字符上限、URL 归一、单次最多 5 个 URL、顺序结果、单项错误隔离和取消传播；owner 仅从可信 RunIdentity 传给 Host port。Registry 仅在明确注入联网端口时注册此工具，当前 `main.ts` 没有生产 Run/联网端口装配，因此列为部分实现，不宣称生产可用。Host port 的生产实现仍须固定/校验公网 DNS 目标、拒绝重定向并解析正文；HTML/PDF 提取、自定义 headers 校验及历史脱敏、`web_download` 配额和本地 FS 落点仍未迁移。Python 回归基准为 `agent/test_tool_schema_security_contract.py`、`agent/test_tool_schema_validation.py`、`platform/test_io_retry_contract.py`；devserver `.venv/bin/pytest` 不存在，故本轮未运行这些 Python 用例。Node `tests/agent/tools/web.test.ts` **6/6**、Core `domain-reads.test.ts` **5/5**（共11/11）、Host `agent-tool-registry.test.ts` **17/17**，Core build通过；Host 全量 typecheck 被其他并行工作区错误阻断，未报告通过。测试使用合成网络端口和身份，不是生产接入。测试 manifest 同时登记了此前未登记的 scheduled-task 新测试，使标准 Vitest 配置可加载；该测试来自并行工作区变更。

### Node 工具层引用与重复实现核查（2026-11-16）

全仓引用核查未找到可安全删除的重复工具组、单工具转发模块或仍存在于 Node 的 `get_tool_schema` 占位实现；Core 工具领域模块被索引/注册器和行为测试使用。`createAgentToolRegistry` 目前没有生产调用方，但它是现有唯一 Host 工具装配边界，且由多组真实注册器行为测试覆盖；删除会移除待接入工具的唯一完整装配点，不是清理死代码。`agent-overview-postgres.ts` 与 `formatAgentProjects` 属上下文快照原型而非 BaseSkill 工具层；前者仍被上下文装配器引用并由查询测试覆盖，本轮不把它误判成重复工具或删除共享上下文服务。当前 Node 生产 Run 尚未接线已作为明确 Host 阻塞列出。

### Runner 持久索引端到端回归（2026-11-16）

此前 Runner 续轮用例曾先重建持久 conversation index，再经 `AgentRuntime → Core Runner → Host 工具注册器 → search_conversations` dispatch；本轮核对 Python `ConversationAdapter.retrieve` 后发现工具实际读取 owner 限定的事实表，而不是该压缩索引。现有调用链回归改为从 TypeScript RAG/Jieba 的事实表 BM25 适配器检索，结果不增加 Cython 索引投影的角色前缀；持久 Worker 的更新和墓碑仍由独立 RAG Worker 测试覆盖。devserver 临时 SQLite Host 文件 **4/4 通过**。Runner/Provider/RunStore/上下文/授权是合成依赖；没有连接真实 PostgreSQL、Redis 或外部 embedding。`main.ts` 仍无生产 `agentChat`/dispatch/reconstructor 调用方，因此这是 Node 真实 Runner 行为回归，不是生产 Host 部署验收。

### `search_conversations` 恢复 Python 事实表召回语义（2026-11-16）

逐项核对 `ConversationAdapter.retrieve` 后确认 Python 工具从 owner 会话事实表查询，不依赖压缩索引：它排除群聊与非 user/assistant 消息、按每个会话选最新命中，再应用 BM25 候选上限。因此 Host 工具搜索改用 TypeScript `createSqlRagConversationSearch` 和正式 Jieba；不会让 baseline 以前仍在事实表中的消息漏检，也不会让同一会话的多条索引记录占满候选窗口。devserver Host 工具/Runner 调用链 **4/4 通过**，Python `test_search_tools.py -k conversation` **4/4 通过**；Python RAG 与相邻搜索/schema 基准 **317 通过、1 项环境失败**（native-extension 子进程重置 `PYTHONPATH` 后找不到仓库内 `gugu_core`），RAG owner 配置 pytest **2/2 通过**。旧会话索引仍用于持久来源重建及其他 RAG 消费者；本工具本身遵循 Python 的事实表 BM25 路径。生产 Agent Run 尚未装配 registry，真实 PostgreSQL 未验收。

### devserver 追加验收（2026-11-16）

Core RAG 与 Mind freshness **10 个文件、63/63 通过**；Host memory scope/BYOK、conversation Runner、索引损坏恢复、持久 Worker、正式 Jieba 与共享相关性语料 **19/19 通过**；Python RAG、conversation parity/search limits 与 knowledge search 工具 **300/300 通过**。Node 测试使用临时 SQLite/FS，授权、凭据、Provider transport、RunStore 与 Provider 为模拟依赖。Python 使用临时 venv（Cython 3.3.1、rjieba 0.2.2、OpenAI/Anthropic SDK），只测试 SDK 导入，不发送 Provider 请求、不读取凭据。隔离 PostgreSQL 未配置。Core 标准 Vitest suite 受并行工作区未登记测试影响，本次使用 `/tmp` 临时配置运行 RAG 文件，未修改共享 suite 清单。生产 Agent Run 装配、knowledge/memory Node 写入 producer、Python/Cython 与 Node Worker 唯一归属及正式 PostgreSQL migration 仍是生产阻塞项。

### `read_knowledge` Core 工具与 Host 持久 RAG 适配（2026-11-16）

旧 Python `backend/agent/tools/knowledge.py::_read_knowledge` 的按 ID 完整读取与关键词 BM25 行为现有 Core 工具组 `tools/knowledge.ts`：默认 limit=5、业务范围 1–25；ID 与 keyword 同时提供时 ID 优先，空查询与越界 limit 返回 handler 业务错误；Core 合并同一知识记录的重复命中片段。Web Host `agent-knowledge.ts` 的 ID 路径通过受限 owner FS reader 解析完整 Markdown 正文、版本和按可信用户时区投影的时间；keyword 路径从 `knowledge_index_entries` 经 `createScopedRagSearch` 召回，只能使用 Host `resolveScope` 与 `authorize` 确认的 scope，并固定使用词法 BM25，不调用可选向量或 embedding Provider。关键词结果返回 ranker 的 `item.text` 投影（标题、摘要、正文，受共享字符预算限制），与 Python `as_public_result()` 一致；按 ID 才返回完整正文。工具端口已作为可选 `knowledge` 组加入现有 Host registry。

devserver Core 行为用例 **4/4**；Core 标准测试启动被并行新增但未登记的 `tests/agent/skills/user-management-sqlite.test.ts` 阻断，本次使用 `/tmp` 临时 Vitest 配置只选该用例运行，未改共享清单中其他会话的登记。Host 临时 SQLite/FS 经真实持久索引 reader、Host 适配器、实际 `createAgentToolRegistry` 注册与 dispatch **1/1**；回归提供了可用的向量/embedding spy，并验证 Python 固定 BM25 契约下二者均未被调用。Core typecheck/build、Host 本次文件的严格单文件 TypeScript 检查与当时的 Web Host production build 通过。回归保护 owner 隔离、正文/时间/版本、固定 BM25、不触发向量/Provider、Python 排序文本投影、重复 chunk 合并、非法参数无查询副作用、撤权和 Web 越权 scope 拒绝。`backend/tests/agent/knowledge/test_read_knowledge_tool.py` 当时未运行：devserver 没有项目 `.venv/bin/pytest`。测试使用临时 SQLite/FS、正式 `@node-rs/jieba` 内置词典、合成 scope/授权/时区，不调用外部 Provider。生产 Agent Run 仍未装配 registry/knowledge port，Node knowledge 写路径及 freshness producer、正式 PostgreSQL migration 未验收，因此该工具目前是已实现待生产接入。

同日追加真实 Runner 续轮回归：Core `knowledge.test.ts` **4/4**、`source-adapters.test.ts` **8/8**（临时 Vitest 配置只选目标文件，配置已移除）；Host `conversation-tools-runtime-sqlite.test.ts` 的 SQL 事实表搜索、隔离与 `AgentRuntime → Core Runner → 工具注册器 dispatch → Provider 续轮` **4/4**，与 `knowledge-tool.test.ts` 实际 Host registry 调用 **1/1**、owner knowledge store/持久 Worker/baseline/正式 Jieba **11/11** 合计 Host **16/16**。Core build、Web Host production build 通过。该 Runner 仍使用合成 Provider、RunStore、授权与上下文，不能替代 `main.ts` 的生产 Agent Run 装配或正式 PostgreSQL 验收。

### `read_knowledge` 强制 BM25 与 Python 一致（2026-11-16）

复核发现 Host knowledge adapter 虽然把工具结果标成 `bm25`，但实际将可选向量与 embedding 传给共享 hybrid 检索；单知识条目测试未能暴露这一差异。旧 Python `_read_knowledge` 显式调用 `search_knowledge(... strategy="bm25")`。已先将 Host dispatch 回归改为断言注入的向量读取和 embedding 均不发生，首轮在 devserver 以 `1 !== 0` 失败；随后移除 knowledge port 的向量依赖，保留 Core 持久索引、BM25 ranker、owner scope 及授权复核。修复后 knowledge、memory scope/BYOK、Worker 生命周期和 Web Run 工具绑定合计 **4 个文件、17/17 通过**；包含 `knowledge-tool.test.ts` 的实际 registry dispatch，其他用例保护 memory 向量召回、队列消费及注册器撤权行为。严格单文件 TypeScript 检查通过。Python pytest 因 devserver 没有 pytest 模块未运行；Web Host production build 被并行改动的 `packages/core/src/byok/vector-rebuild.ts` TS6133（未使用 `storedVectors`）挡在 Core prebuild 阶段，未改该共享文件。Host production-source 类型检查的其他诊断只落在并行 BYOK embedding 模块，本次文件没有诊断。此修复保持 Python 知识工具的 BM25 行为；memory 等明确支持 embedding 的 RAG 入口不受影响。真实 PostgreSQL 与生产 Agent Run 仍未验收。

### Node 消费者必须装配完整来源（2026-11-16）

`AGENT__RAG_INDEX_WORKER_OWNER=node` 选择的是共享 RAG 队列的全局消费者。Host 若缺少 knowledge 或 memory 来源仍启动 Node Worker，会让 Python 按配置停止消费后把对应任务留在队列中。`startAgentRagIndexWorker` 现对 Node 消费者 fail closed：缺任一来源时拒绝启动；两种不完整装配及完整的 project/knowledge/memory 持久任务生命周期由 Host `rag-index-worker.test.ts` **8/8** 覆盖。测试通过临时 SQLite、owner FS 和合成 memory 游标验证实际队列状态与索引副作用。devserver 只有 PostgreSQL 客户端，没有 `initdb`/`postgres` 服务端，因此本轮未运行迁移的隔离 PostgreSQL 集成用例；无生产数据库或配置被访问。

Host `startServer(env)` 现把同一个注入环境中的 `AGENT__RAG_INDEX_WORKER_OWNER` 传给生产 Worker 装配，避免读取进程全局环境而忽略显式 Host 配置。`resolveAgentRagIndexWorkerOwner` 行为回归覆盖默认 `python`、两个合法值与非法值拒绝。此项只修正 Worker 所有权配置的生产装配，不代表 Agent Run 已注册工具或 Node 消费者已在部署中切换。

devserver 同步哈希逐文件匹配后，`rag-index-worker.test.ts` **9/9 通过**。生产 Host Worker 用临时 SQLite 实际重建 project、calendar、note、canvas、scheduled_task、conversation、knowledge 的正文索引，并确认 memory 来源参与全量来源集合；同时覆盖 owner 配置解析、Worker 生命周期、正式索引写入和取消停机。测试使用临时 SQLite/FS，不连 PostgreSQL/Redis 或 embedding Provider。Web Host production build 通过。此前本地尝试构建因本地依赖目录缺少 package manifest 已声明的 `pinyin-pro`，在 MCP 两处 import 报 TS2307；本次变更文件未见构建诊断。

### Web 重建器绑定 RAG 工具注册器（2026-11-16）

`createWebAgentToolPorts` 把同一个 Host `createAgentToolRegistry` 同时接到 Web Run 的能力发现和 Harness `ToolPort`：Provider schema 只暴露运行身份已授权、且在可信配置白名单内的工具；每次 dispatch 仍由同一 registry 重新授权。发现阶段还校验准备身份与持久 lease 的 owner/session 一致并响应取消。devserver **2/2** 通过，其中一项使用临时 SQLite 会话事实表、正式 Jieba、真实 Host conversation adapter 和 registry dispatch，验证 `search_conversations` 返回实际 owner 会话结果、撤权后隐藏且不再查询。Web 重建器完整 PostgreSQL/Redis 生命周期测试因缺少隔离服务跳过；`main.ts` 仍没有生产 `createWebAgentReconstructor`/`agentChat` 调用方，因此该接线组件还未成为生产 Run。

### `search_memory` fallback reason 与 Python 对齐（2026-11-16）

旧版 `UnifiedQueryRetriever` 会把未启用 embedding 标为 `embedding_disabled`，显式 `strategy=bm25` 标为 `lexical_only`，embedding 已配置但本轮没有可用匹配向量时标为 `embedding_cache_unavailable`；混合召回成功时为 `null`。Node Core 曾在所有分支固定返回 `null`。修复后这些状态沿 `createAgentToolRegistry` 实际 dispatch 返回；`memory-search.test.ts` **6/6 通过**，其中回归先因 `fallback_reason` 不一致失败，再在实现后通过；向量 transport 失败仍返回已授权 BM25 结果且不暴露异常。测试使用临时合成 owner 索引和向量，不调用 Provider；生产 Agent Run、真实 PostgreSQL/Redis 与外部 embedding 尚未验收。

### 1.7.7 向量文件解析缓存迁入 Core（2026-11-16）

Core `vector-reader.ts` 补入 1.7.7 的向量文件解析缓存：owner、`memory`/`knowledge`/`pattern` 文件种类和 embedding 版本共同确定缓存键；每次仍从 owner-bound Host reader 读取当前文件，以内容 SHA-256 检测变更；缓存仅持有解析映射、无 TTL、LRU 上限 8。`scoped-search.test.ts` 通过实际 hybrid 搜索先后读取同一 owner 的两种向量文件内容，验证更新后的融合分数随之变化，定向回归 **5/5 通过**。测试使用合成授权 scope、模拟索引快照、向量文件和 embedding；未访问真实 FS、PostgreSQL 或 Provider。此项恢复旧缓存生命周期，不代表生产 Agent Run 已装配 RAG 查询端口。

### `search_memory` 独立装配正式 Jieba（2026-11-16）

`createWebOwnerMemorySearchPort` 与 conversation Host factory 一样，独立确保 1.7.7 的 `@node-rs/jieba` 包内词典已装配；memory 搜索不要求调用方先创建 conversation 端口。Host `memory-tools-runtime-sqlite.test.ts` 经临时 SQLite/FS、Core RAG 和实际工具 registry dispatch 用中文查询验证分词召回，**5/5 通过**。测试使用模拟授权、snapshot 和 embedding 依赖，不连接 PostgreSQL 或真实 Provider；Python memory pytest 本轮未运行。生产 Agent Run 尚未注入该 memory port。

2026-11-16 devserver 复验：`memory-tools-runtime-sqlite.test.ts` **5/5** 与 `conversation-tools-runtime-sqlite.test.ts` **4/4** 通过。后者覆盖 owner 限定事实表、正式 Jieba/BM25、每会话最新命中及 `AgentRuntime → Core Runner → search_conversations → Provider 续轮`；前者覆盖正式 Jieba 的独立 memory 装配、owner memory 实际 registry dispatch、可信 IM scope 与 BYOK gate。两组均用隔离 SQLite/临时 FS；授权、IM 上下文、凭据、embedding transport 和 Provider 为模拟依赖。Python pytest 因 devserver 项目 `.venv/bin/pytest` 缺失未运行；生产 Agent Run/真实 PG/Redis/外部 Provider 未验收。

### 跨端图表渲染共享包（2026-11-16，非 BaseSkill 静态工具组）

Mermaid/MathJax 到 PNG 的共享实现及前端 Mermaid 主题、源码和 SVG 修正规则已迁入 `packages/charts/`。Node Web Host 提供 `renderAgentCharts()` 可复用入口，不新增 HTTP 路由，也尚未接入生产 Agent registry/Run；worker 使用独立 Node 子进程、输入/输出上限、超时和 AbortSignal 取消。Python IM 调用的开发路径保留旧 worker 文件作为薄入口，生产镜像继续提供其固定 fallback worker 路径；Python 参考实现未改。

devserver 回归：charts worker/包行为 **13/13**、Node Host Mermaid/Math PNG/取消 **2/2**、Web Mermaid renderer **20/20**；Web Host production build 与 Web production build 通过。首轮 worker 用例失败原因为复制测试仍发送 `{sources}`，与 worker `charts` 协议不匹配；更新测试请求形状后整组重跑通过。依据旧 Python 侧调用与仓库 Python 基准，相关 pytest 入口为 `platform/deployment/test_embedded_deps_contract.py` 及 `platform/realtime/test_streaming_regressions.py::test_qq_tool_boundary_waits_for_chart_before_starting_new_stream`；devserver 没有项目 pytest 环境或系统 pytest，本轮未运行。测试没有连接生产数据或外部服务。生产 Agent 注册、真实 Node Host 装配、Docker 镜像构建和部署尚未验收；未运行 Docker 测试。此能力不计入 BaseSkill 静态工具组/工具数量。

### Node Knowledge 保存、更新与 RAG freshness producer（2026-11-16）

Core 现通过既有工具注册器开放 `save_knowledge`、`update_knowledge`。实现遵循 Python `normalize_capture`/`KnowledgeStore.save` 的字符限制、关键词规范化、owner scope、同主题保存与来源冲突、版本与历史、部分更新、同内容 no-version-change 及 32 MiB 序列化预算；`update_knowledge` 即使正文版本不变仍触发 `RagIndexUpdated` 等价的持久 freshness job。Markdown serializer 保留 Python 字段顺序、转义和六位微秒时间戳；Core 测试通过注册器 dispatch **7/7**，包括 owner 注入、拒绝副作用、错误语义和微秒 roundtrip。

Web Host 新增 `createLocalAgentKnowledgeWritePort`，只使用可信 Run identity、配置 storage root、owner-bound reader 与 `writeLocalFile`。首次写入按 Python 时间戳迁移协议逐条转换旧 Markdown、原子写入并创建相同 `.timestamps-iso-v1` 标记；保存/更新先在一个 SQL 事务墓碑化旧索引并 fence 在途 generation，再原子写入主文件并持久排入 knowledge 全来源重建；文件写失败仍尝试排入对当前主数据的恢复重建。Host 工具组仅在显式注入 `knowledgeWrites` 后注册写工具；delete 继续关闭，因为注册器尚无 destructive confirmation gate。

Host `agent-tool-registry.test.ts` **18/18**、`knowledge-tool.test.ts` 与 `rag-index-worker.test.ts` **10/10** 通过，Core 7/7、Core typecheck/build 通过。新增 Host `knowledge-write-runtime-sqlite.test.ts` 的旧知识索引墓碑和在途 Worker generation fence 回归 **1/1 通过**；完整的旧 epoch 文件迁移、owner FS 原子写、持久队列、Worker 与正式索引表及异主更新拒绝用例也已编写，但本机 macOS 不支持 `@gugu/fs/node` 的 Linux 安全原子写，故端到端项 **1 项跳过**；此 Host 写入调用链仍需在 Linux devserver 验收。对应 Python `test_knowledge.py` 因本机无 pytest 模块未运行。Web Host 全量 typecheck 仍被既有环境/源码问题挡住：缺 `pinyin-pro`、charts 子路径解析失败以及既有 admin TS 错误；本次变更的 Host 写入源文件未报告诊断。`main.ts` 仍没有生产 Agent Run caller，因此写工具、conversation/memory 查询端口没有进入真实生产 Run；真实 PostgreSQL、Redis、embedding Provider 也未验收。

### devserver 复验：知识写入、RAG 查询与来源 Worker（2026-11-16）

先逐文件比较本轮相关 Core/Host 源码、测试和 `packages/core/package.json` 的两端 SHA-256，全部一致后才在 devserver 执行。Core build 通过；Core `knowledge.test.ts` **7/7**，Host `knowledge-write-runtime-sqlite.test.ts` + `agent-tool-registry.test.ts` **20/20**，其中 Linux owner FS 原子写、旧时间戳迁移、持久队列、正式索引写入及异主拒绝现在均实跑通过。Host `memory-tools-runtime-sqlite.test.ts` + `conversation-tools-runtime-sqlite.test.ts` + `rag-index-worker.test.ts` **18/18**，覆盖实际 memory 向量/BYOK 与 scope dispatch、正式 Jieba 的 owner 会话 BM25、Core Runner→Provider 续轮，以及持久 Worker 对来源索引的建立/更新和取消。

Node 测试只使用每例隔离 SQLite、临时 owner FS、合成授权和 mock embedding/Provider/RunStore；未连 PostgreSQL、Redis 或真实外部 Provider。对应 Python `test_knowledge.py` 与 `test_tool_schema_validation.py` 在 devserver 均未运行：项目 venv 的 pytest 可执行文件不存在，系统 Python 也没有 pytest 模块。生产 `main.ts` 仍没有 `agentChat`/`createWebAgentReconstructor` 调用者；正式 PG migration 部署、Python/Node consumer 切换和真实 Provider/Redis 未验收。Mutagen 仍报告 3 处冲突，本轮没有 flush 或处理。

### 1.7.7 与 Python/Cython 的对照范围及已知差异（2026-11-16）

源码基线是 annotated tag `v1.7.7` 解引用后的 commit `14c544f1faf1193e8a073844af4a5d7a4872045c`，源码位于 `backend/ts/workers/rag/src`，许可证 Apache-2.0。Python tokenizer 使用 `rjieba`，Node Host 使用 `@node-rs/jieba@2.0.1`；两者均调用 Jieba `HMM=false`，并保留 ASCII token、字母数字与空格压缩和月份别名规则。两种 binding 不同，所以 tokenizer golden 和代表性语料通过不能证明所有 OOV/Unicode 输入逐 token 等价；尚未量化的分词边界应如实视为开放质量覆盖。

当前共享固定词法语料包含 5 个有效 query（含纯英文部署窗口查询），两边 Recall@3=1、MRR=1；无关 query 为空，owner scope 命中不泄露到同词 group 干扰结果。该语料不证明全库排序或向量质量等价。Core 已有 Python rank pytest 对照的 Node 回归，覆盖 BM25、confidence-v4、IDF 重排、top-k、置信区间和重复引用；历史旧版 RAG pytest **279/279**、search 工具/schema **37/37** 曾在 devserver 临时 venv 通过，但不替代本轮针对新增语料用例的单项重跑。

2026-11-16 共享语料增补纯英文 query：`deployment window Tuesday migration` 命中英文部署窗口文档。Node Host 使用正式 `@node-rs/jieba` + Core lexical index 用例 **1/1**，旧 Cython `test_rag_relevance_corpus.py` **1/1** 通过；两项均在 devserver 运行，Python 使用 `/tmp` 临时 venv 并把 Cython 编译产物放入测试临时目录。现有五个有效词法 query 均 Recall@3=1、MRR=1，无关结果为空，owner 同词 group 干扰被过滤。验证的是固定语料的英文切词/检索与 scope 行为，不是全库或向量质量等价。

需要保留的业务差异：`search_conversations` 与 Python `ConversationAdapter.retrieve` 一样从 owner 限定事实表作 BM25，不搜索压缩持久索引或向量；`read_knowledge` 固定 BM25；memory 才可选混合/向量召回。执行归属也尚不同于最终目标：Python 与 Node 共享持久队列，当前默认消费者仍是 Python，Node-only 部署未切换/验收。隔离 SQLite、mock embedding/Provider 和注册器调用不能替代生产 PostgreSQL、凭据、Redis 或 Run 验收。

### RAG 大小写归一化与 Python locale 语义（2026-11-16）

Python `str.lower()` 不受进程 locale 影响；Core tokenizer、日期词项归一化和 RAG confidence 原使用无显式 locale 的 `toLocaleLowerCase()`，在 Turkish locale 等环境可能把 `I` 变成 `ı`，导致索引词和查询词漂移。现统一使用 locale-independent `toLowerCase()`，共享 `rag_tokenizer_golden.json` 增加 `Istanbul 与 I 事件`，并让 Python Cython 编译路径、Python 参考路径和 Node Host 共用此 golden。devserver Core tokenizer/ranking/scope 回归 **30/30**，Host Jieba 与 `search_conversations` 调用链 **6/6** 通过；另批 Host knowledge/memory/vector/Worker 回归 **18/18**、Core source/rank/tokenizer/scope **37/37** 通过。旧 Cython tokenizer pytest 曾在临时 venv **18/18** 通过；本轮补了 `Istanbul` 与土耳其无点小写 `ıstanbul` 不应被 confidence matcher 当成 Python 兼容命中的边界，Core ranking **16/16**、Python Cython rank+tokenizer **30/30** 通过，Cython build 位于 pytest 临时目录。共享中文/英文/混合相关性语料本轮 Node Host 与 Python Cython 各 **1/1**，验证每个 query 的 Recall@3=1、MRR≥0.5、无关 query 为空且 owner 范围不泄漏。Core 与 Web Host production build 均通过。生产 `agentChat`/`createWebAgentReconstructor` 装配、隔离 PostgreSQL/Redis 和真实 embedding Provider 仍未验收。

2026-11-16 再次复验：Core `tests/agent/rag` **9 个文件、63/63 通过**；Host RAG 来源/Worker/Jieba/工具及 Runner 调用链 **20 项通过、2 项跳过**（需要隔离 PostgreSQL 的队列事务用例未设置 `GUGU_WEBUI_TEST_DATABASE_URL`）；Python Cython rank、tokenizer、相关性语料与知识搜索工具 **39/39 通过**。Python 测试使用 `/tmp` 临时 venv 与临时 Cython 编译产物。Node 行为测试使用隔离 SQLite/FS，授权、scope snapshot、embedding transport、RunStore 和 Provider 为合成依赖。该组验证 RAG 算法、来源 Worker 和 Core Runner 工具调用，不代表生产 `/agent/chat` 已装配；真实 PostgreSQL、Redis、BYOK embedding 服务及生产 Run 仍未验收。

### Web Run 的 RAG 授权与持久快照边界（2026-11-16）

新增 `createWebAgentProductionRagToolPorts`，把 RAG 查询端口绑定到已验证的 Web v2 dispatch lease。memory 授权每次检查 PostgreSQL 当前 `active_run_id`、Preparation 的 `source=web` 与配置工具名，并经同一 Host registry 的 `capabilities()` 重新确认授权；只接受 owner scope。检索前后都会复核 active Run 和工具授权。去重快照只读取 `user_id + session_id + active_run_id` 对应的 PostgreSQL `session_context`，并校验快照版本和正文。失效 Run、缺失/损坏快照或授权撤回均失败关闭，不回退为空快照。

Host `agent-rag-run-context.test.ts` 与 `agent-rag-tool-ports.test.ts` **4/4 通过**。组合用例经真实 Core memory 搜索与工具 registry dispatch，使用临时 SQLite/FS、合成 PostgreSQL snapshot、授权和配置依赖，验证当前快照内容会被排除、同一索引未注入内容仍可命中、Run 被替换时拒绝、配置关闭 `search_memory` 时拒绝；边界用例另外检查每次授权的 active-run 查询、owner/session/run SQL 绑定、损坏快照和取消。该工厂尚未由 `main.ts` 的生产 Run 资源装配调用；本用例不证明生产 PostgreSQL/Redis、生产权限源、Agent chat/stream/cancel 或真实 embedding Provider 已接通。此次没有修改 Python 代码，因此未重跑 Python pytest；既有 Python RAG 基准 **39/39** 不替代生产调用链验收。

### RAG 当前树 devserver 复验（2026-11-17）

Core RAG 定向 suite **9 个文件、63/63 通过**。Host `agent-rag-run-context`、production registry、conversation facts/Runner、knowledge freshness、memory scope/向量、持久 Worker、正式 Jieba 和共享语料 **9 个文件、28/28 通过**；Host 回归在 Core build 后重跑。Core build 与 Web Host 生产 tsconfig noEmit 检查通过。Node 用例通过 Host registry 的实际 `dispatch`，`search_conversations` Runner 用例继续走 Core Runner 并验证结果进入 Provider 续轮；Worker 与来源用例使用隔离 SQLite、临时 owner FS。授权、lease、session snapshot、BYOK credential 与 embedding/Provider transport 为合成依赖。相关 RAG Core/Host 源码、用例及 Python 基准文件的 SHA-256 与 devserver 相符。

本轮未重跑 Python pytest；最近一次同一当前树记录的 Cython rank/tokenizer、共享语料、旧 `search_conversations` 与 schema 安全用例为 **64/64 通过**。本轮没有真实 PostgreSQL、Redis、外部 embedding 或生产 Run 验收：`main.ts` 仍无 `agentChat`/`createWebAgentReconstructor` 调用者，RAG registry factory 仍待 Run resource composer 接入。Python 与 Node 共用索引队列的生产消费者仍默认为 Python，尚无 Node-only 切换证据。

2026-11-17 Run 注册器续轮回归：`conversation-tools-runtime-sqlite.test.ts` 中的 `AgentRuntime → Core Runner → Provider` 用例改为经 `createWebAgentProductionToolRegistry` 实际构建 registry，仍以生产工具 schema 发起 `search_conversations`、分派查询并把 owner 结果返回 Provider 续轮；同批 `agent-rag-tool-ports.test.ts` 另覆盖生产 registry 经 Web Run schema 发现过滤及绑定 lease dispatch。devserver Core build 后两文件 **6/6 通过**，两测试文件独立严格 TypeScript 检查通过。使用隔离 SQLite/FS 和合成 lease、配置、Provider；查询本身不调用 memory 的 PostgreSQL 授权/快照。补跑 Host PostgreSQL 来源、队列和 migration 文件共 **2 通过、6 跳过**，原因是未配置隔离 PG 测试库，故没有本轮真实 PG 证据。Python pytest 未重跑。该回归证明生产 registry 工厂到 Core Runner 的 Node 续轮，但 `main.ts` 生产 `agentChat` 装配和真实 PG/Redis/embedding 仍未验收。

同日扩大共享 tokenizer golden：补入带点大写 I、组合附加符、罕见汉字、全角拉丁/数字与 emoji、扩展区汉字等边界。Node `tokenizer.test.ts` **10/10 通过**；Python Cython `test_cython_tokenizer.py` 与 `test_rag_tokenizer_parity.py` **32/32 通过**，再与 Cython rank 和共享相关性语料组成的 Python RAG 子集 **45/45 通过**。Python 测试依赖和 Cython 临时构建位于临时 venv/pytest 临时目录。此组验证新增固定样本在两端输出相同 token，并覆盖 Python locale 无关小写和 Unicode 分词回归；不证明所有 OOV/Unicode 输入或整库排序完全等价。Node 用例在本机执行，Python 用隔离 Python 3.12 venv 执行；无失败或跳过，pytest-asyncio 报告 fixture loop scope 配置弃用提示。额外 Python 工具 schema 两文件尝试未进入测试，临时 venv 缺少 `greenlet` 与 `bcrypt`；该环境依赖问题不计入上述 RAG 测试。未访问真实数据库、Redis、凭据、用户文件或外部 Provider。

同日本机 Host 定向回归：按 `node --import tsx --test` 执行 RAG Run context、production registry、`search_conversations` Runner、knowledge freshness、memory scope/vector、持久 Worker、正式 Jieba 和共享语料 12 个文件，**29 通过、3 跳过、0 失败**。两个跳过为未配置隔离 PostgreSQL 的队列/事务场景；另一个是 Linux-only owner FS 原子写用例在 macOS 跳过。Core RAG suite **9 个文件、63/63 通过**。Host 用例使用临时 SQLite/FS 及合成 lease、授权、snapshot、凭据、embedding/Provider；生产 PostgreSQL、Redis、真实 embedding Provider 和 `main.ts` Agent Run 未由本机测试证明。首次误用 Vitest 启动 `node:test` 文件得到“无 Vitest suite”并未用于验收，随后已用项目原生测试 runner 重跑。

同日 devserver 复验新增 golden：运行前逐项比较本轮 18 个 RAG 源码/测试文件及 7 个 workspace/package 配置 SHA-256，全部一致；未 flush 或处理 Mutagen 的其他冲突。Core build 通过，Core RAG **9 文件、63/63**；Host RAG production registry/Runner、来源 Worker、memory scope/vector、knowledge freshness、正式 Jieba 和共享语料 **30 通过、2 跳过、0 失败**，跳过均为需要显式隔离 PostgreSQL 的队列/事务测试。Python 临时 Python 3.12 venv、pytest 缓存和 bytecode 均隔离在 `/tmp`，Cython rank、tokenizer、共享 tokenizer golden、相关性语料 **45/45 通过**。Node 使用隔离 SQLite/FS 和合成 lease、授权、快照、凭据、embedding/Provider transport；无真实 PG、Redis 或外部 Provider。`main.ts` 仍无生产 `agentChat`/`createWebAgentReconstructor` 调用；普通 memory 更新仍无 Node freshness producer，故此复验不能将生产 RAG 标记为完成。

同日 owner memory context 更新后的 devserver 复验：先核对 Core/Host memory context、RAG reader/registry 测试和依赖配置 **14/14 哈希一致**，Core build 后 `memory-context.test.ts` **2/2**；Host memory context、owner-bound RAG FS、Run scope/snapshot、生产 registry、`search_conversations` Runner 与 memory/vector 调用链 **16/16**；Host production `tsconfig.build.json --noEmit` 通过。Host typecheck 前另确认当前 71 个 Host 已修改/新增文件与配置都和 devserver 一致。用例使用隔离 SQLite/FS、合成授权/lease/snapshot/凭据/embedding/Provider；未连接 PostgreSQL/Redis/真实 Provider。这个切片补齐 Python `read_memory` prompt context 的 Node owner-bound 读取，不增加 RAG 索引来源，也不代表生产 `main.ts` 已装配 Agent Run。

同日 Core Agent context 当前树 devserver 复验：核对 9 个相关 Core context 源码/测试 SHA-256 后，Core build 通过；`sources`、`memory-context`、`loading-reflection`、`context-runtime` **64/64 通过**。用例覆盖重建时当前轮消息传入共享 memory loader，以及缓存命中时延迟读取保持快照一致；未连接真实 Host 服务、数据库、Redis 或 Provider，也不证明生产 Agent Run 装配。

同日强化固定 RAG 相关性门槛：共享合成语料的旧 Cython 与 Node Core/Host 用例，除 Recall@3 必须为 1 外，将相关结果的倒数排名从 `MRR >= 0.5` 收紧为 **MRR = 1**；同一索引重复查询须保持 hit 顺序；空结果仍要求没有无关命中，owner 查询仍要求不得返回 group scope 文档。devserver Node 正式 Jieba + Core lexical index **1/1 通过**，Python Cython **1/1 通过**。Python 使用隔离 `/tmp` venv，pytest 仅收集 RAG 子目录；没有真实数据库、向量 Provider 或生产 Agent Run 参与。该检查防止相关文档仍在 top-k 内但首位被干扰项取代，以及重复查询出现排序漂移；本语料只有代表性固定 query，不代表全库排序等价。

2026-11-17 Agent memory prompt 向量 Host adapter：`createAgentMemoryVectorSearchFactory` 把可信 owner 绑定到旧 memory/pattern vector 文件，复用 RAG 固定路径 reader、BYOK resolver、`embedRagQuery` 和 Host 注入的 Provider transport；Core memory context loader 将取消信号继续传到 owner 文件/向量读取和 embedding。Host 经真实 context loader + 临时 owner 文件调用验证模型 tag 匹配的 pattern 向量会影响召回、异主 owner 被拒绝、BYOK 缺失时保留词法结果、Provider 请求收到取消，**3/3**；原 memory context Host 测试 **2/2**，Core context **36/36**，相关 Host RAG/Agent registry **36/36**。Web Host 生产源码 `tsconfig.build.json --noEmit` 通过；全量 `tsconfig.json` 有 **89** 个并行工作区其他测试类型诊断，本切片源和测试文件无诊断。Python 旧 memory store/injection budget pytest **23/23**，覆盖向量快照、无 query 旧行为、低覆盖回退，以及按原始 pattern 数触发 embedding 后过滤退休项的旧行为。Provider transport、BYOK 配置和用户文件均为合成/临时依赖，未调用真实服务。该模块仍未接到生产 Run resources，不能记为生产接通；生产 Agent Run、真实 PG/Redis/embedding Provider 和 Worker 唯一归属仍未验收。

2026-11-17 查询 embedding 缓存行为补齐：Core `embedRagQuery` 按 Python 旧实现使用 `provider/model/dimensions/normalized query` 的 SHA-256 键，只缓存成功向量，TTL 5 分钟、上限 64，并在返回时复制向量；失败响应不缓存。Core `query-embedding.test.ts` **7/7**、Python `test_rag_query_embedding.py` **24/24** 在 devserver 通过。Node 用唯一合成查询和 mock transport 验证归一化 cache hit、避免第二次请求、调用方修改结果不污染缓存、不同模型/维度隔离以及失败后可重试；Python 用例覆盖旧请求/缓存基准。未调用真实 embedding Provider；缓存中的向量是可重建短期结果，不包含明文查询键。

2026-11-17 Local/Ollama embedding 边界及生产 transport 对齐：旧 Python 仅对明确的 `local`/`ollama` Provider 允许连接其配置并固定解析的本机 embedding 服务；Node BYOK resolver 只按上述 Provider 标识产生 `allowLocal`。生产 `main.ts` 的共享 embedding transport 经 Host helper 打开 Host 级开关，Core 仅为明确的 `local`/`ollama` 请求设置请求级开关，Node transport 同时校验两者并固定 DNS 目标，因此云 Provider 仍无法访问本机目标。Host resolver 回归 **2/2**、Host transport 实际 HTTP 调用 **1/1**、Core Provider `transport.test.ts` **38/38**、Python `test_rag_query_embedding.py` **24/24** 在 devserver 通过；Node 和 Python 使用本机合成服务，Host resolver 使用合成 DB/凭据，未访问外部服务。Host 及 Core 用例都验证云 Provider 在本地 transport 开关打开时仍不能请求 loopback。未运行真实 embedding Provider 或 Agent Run；Run/main composition 仍待接入。

2026-11-17 Provider snapshot binding 增量：新增 Host 工厂，将 flock 保护的有效模型配置、PG repeatable-read 凭据版本与明确解析的权限身份版本绑定到同一可恢复模型身份；配置/授权变化后拒绝恢复旧 checkpoint。临时配置文件和合成 Pool 用例经 Node 26 **1/1 通过**，不读取运行配置、不连接真实 PG/Provider。RAG Core Vitest **9 文件、66/66 通过**；Host RAG registry、Run 授权/快照和工具注册器 `node:test` **25/25 通过**。这验证了独立 Provider/RAG 边界，不证明生产配置解析器或 Agent Run 已接入：`main.ts` 仍没有 `agentChat`/`createWebAgentReconstructor` 调用，生产 PG/Redis、真实 Provider 与 Node Worker 唯一归属未验收。Host 子目录登录 shell 默认 Node 22；provider binding 必须使用项目支持的 Node 26 执行。

同轮 Web Host 生产源码 `tsc --noEmit -p tsconfig.build.json` 复验未通过，唯一诊断为 `src/modules/mcp/sdk-client.ts` 无法解析并行 SDK 迁移中引入的 `@modelcontextprotocol/client`；没有指向本轮修改的 RAG Provider 源文件。该依赖问题仍待 MCP 会话完成，不能记录为 Host 全量类型检查通过。

2026-11-17 RAG Worker 调度测试稳定化：将“立即排空 ready/superseded”断言改为等待第三次实际 Worker 调用进入后再检查，避免宽跑时短 `setImmediate` 与 10ms 定时轮询竞争；devserver 在 SHA-256 与本地目标测试文件一致后执行该文件 **9/9 通过**。之前合并运行曾出现一次恰好三次调用断言失败，单文件重复五轮均通过；稳定化后再次单跑通过。另一个扩大回归中的 `memory-clear.test.ts` 因 Host 测试运行环境无法解析 `kysely` 未加载，未修改共享依赖清单；该扩大回归未整体重跑。Python pytest 本轮因 devserver 对应 Python 环境未安装 pytest 而未运行。此回归验证 Worker 即时排空、定时重试、串行消费、取消/停止和 SQLite 持久索引写入，不证明生产 Agent Run 已装配。

2026-11-17 Web Agent Run 生产装配复核：当前 `main.ts` 未创建 `createAgentChatService`/`createWebAgentReconstructor`，也未启动持久 dispatch worker/supervisor；`app.ts` 已有可选 `agentChat` 参数及路由，但没有生产调用者。main 中 `createAgentToolRegistry({ authorize: async () => true })` 只供技能目录发现，不能作为 Run 授权或工具分派注册器。可复用的 Chat/Preparation、Reconstructor、Persistent Runtime、Context Assembly、Provider Binding、RAG registry 和 Dispatch 组件都仍需真实组合。尚缺可装配的聊天事务准备、lease 绑定配置/凭据/权限身份、完整上下文 builder 与 IM/知识来源、Harness executor、持久 dispatch/supervisor；不得用空上下文或宽松授权代替。生产 Run 接通前，RAG registry 经合成授权/快照与 SQLite 实际 dispatch 的测试只证明模块边界，不证明用户对话已消费工具。此复核未修改共享入口，未连接真实 PG/Redis/Provider。

2026-11-17 Python/Cython 对照补跑：先对 4 个 pytest 文件、相关 Cython/Python 实现和两份共享语料逐项核对 SHA-256，devserver 与工作区一致；随后在 devserver `/tmp` 临时 Python 3.12 venv 中运行 rank、tokenizer、共享 RAG 语料及 query embedding pytest，**55/55 通过**。Cython 扩展编译缓存、配置 override 路径和 bytecode 均隔离在 `/tmp`；embedding transport 为测试 mock，未读取真实配置、用户数据、数据库或 Provider。用例保护 confidence-v4/top-k/引用与输出预算、locale/tokenizer golden、固定语料排序与 scope、向量缓存/URL 安全边界。

2026-11-17 Web Chat 准备与平台模型设置增量：新增 PostgreSQL 聊天准备 adapter，把 Python Web 的消息事务、owner 限定附件读取/claim、引用解析、待发送队列和加密 dispatch 入队复用同一事务；附件 claim 失效时回滚消息和 dispatch。问候服务改用共享的平台模型设置解析器，覆盖默认值、环境变量、override、预设池与 local deployment 下的 BYOK 规则。引用回归发现 Python MCP UUID 被转成字符串、后续却按 UUID 对象读取的类型错误；修正后 user/platform MCP 引用都能按预期读取，不暴露 endpoint 或凭据。devserver Node Host 定向行为测试 **19/19**（RAG registry/Runner、6 个 Chat 准备、模型设置和 greeting），Core RAG Vitest **4 文件、39/39**；Python RAG/BYOK 基准 **17/17**，引用上下文 **12/12**，附件 claim/owner 基准 **8/8**。测试使用合成 Pool、隔离 SQLite/FS、mock Provider、合成 dispatch secret 和临时 Python 环境，不连接真实 PostgreSQL、Redis 或 Provider。Host 生产 `tsconfig.build.json --noEmit` 仍被并行 MCP 依赖 `@modelcontextprotocol/client` 缺失阻断；此次扩大附件 pytest 中 14 项也因临时环境缺少 FastAPI/Starlette/Pillow 而无法收集/执行，独立 claim 用例已通过。此增量没有接通 `main.ts` Agent Run：生产上下文、可信配置/权限、持久 dispatch worker/supervisor 和真实 PG/Redis 仍未验收，不能将 RAG 记为生产接入完成。

2026-11-17 RAG 与 Web Run 准备当前树复验：Core RAG loader/search/embedding/ranking/scoped search/tokenizer/source adapters **7 个文件、60/60 通过**；Node 26.13 下 Host RAG registry/Run scope、`search_conversations` Runner、memory 向量上下文取消、Web Chat 准备、全来源 Worker 和相关性语料 **27/27 通过**。扩大运行发现取消用例复用了前一测试的全局 embedding cache key，mock transport 被缓存命中跳过；改用唯一合成 query 后整组通过。Core build 与 Web Host production `tsconfig.build.json --noEmit` 通过。所有存储为临时 SQLite/FS，授权、PG lease/snapshot、凭据和 Provider transport 为合成依赖；未连接真实 PostgreSQL、Redis 或外部 Provider。本轮 Python pytest 环境不存在，未重跑 Python；最近 Python rank/tokenizer/语料/embedding **55/55** 见上方记录。真实生产 `main.ts` Agent Run、PG migration、Redis 和 Node 唯一 Worker 切换仍未验收。

2026-11-17 Web RAG owner 边界补强：`createWebAgentProductionRagToolPorts` 现在将 `search_conversations` 的 recent/search/resolve 都绑定到已验证 lease 的 owner，避免生产 RAG 端口被错误身份对象复用时查询其他 owner。独立调用边界测试在 devserver Node 26 **1/1 通过**，验证跨 owner 的三类调用均在源端口前拒绝、取消优先传播，同 owner 大小写归一仍继续委托；运行前确认目标源码、测试、Core dist 与测试运行器哈希一致，没有 flush 或改动现有 Mutagen 冲突。集成 Host RAG 测试暂未复验：Core dist 缺少当前源码导出；本机尝试重建 Core 时被并行编辑中的 canvas 源码 TypeScript 错误阻断，未改动这些共享文件。生产 `main.ts` Agent Run 装配仍未完成。

2026-11-17 Web Run ToolPort 身份绑定：`createWebAgentToolPorts` 现在在实际 Harness `plan`、`dispatch`、`reconcile` 边界再次核对 dispatch lease 的完整 owner/session/run 身份。错身份 dispatch 在触达 registry 前返回失败，恢复查询返回 `unknown`，plan 抛出脱敏身份错误；取消信号仍优先传播，正确 lease 继续委托。新增回归覆盖三种身份错配及正确委托，devserver Node **1/1 通过**。测试使用合成 registry/lease，不连数据库、Redis 或 Provider。此项加固既有 ToolPort 端口，不代表 `main.ts` 已有生产 Agent Run 调用者；真实生产 Run 组合仍待完成。

2026-11-17 `search_conversations` Runner 当前树复验：检查 Host 源码、测试、Core dist、Node 测试运行器及 workspace lockfile SHA-256 与 devserver 一致后，单独运行 `conversation-tools-runtime-sqlite.test.ts`，**4/4 通过**。实际链路覆盖 owner 限定事实表查询、正式 Jieba + TypeScript BM25、每会话最新命中，以及 `AgentRuntime → Core Runner → search_conversations → Provider 续轮`。使用隔离 SQLite、合成 Provider，无真实 PostgreSQL/Redis；该 Runner 回归仍没有生产 `main.ts` Agent Run caller，Python pytest 未因本次 Node 复验重跑。

同日 Python 基准当前树复验：相关 Cython/Python 源码、测试和共享语料 SHA-256 与 devserver 一致后，使用隔离 pytest venv 和 `PYTHONPATH=backend:compat/core-python/src` 串行运行 rank、Cython tokenizer、tokenizer parity、共享相关性语料及 query embedding **69/69 通过**。Cython 临时产物由 RAG 测试 conftest 建在系统临时目录；pytest cache 已禁用；Redis 用测试默认 fakeredis，embedding 测试使用 mock Provider 和本机合成 HTTP。测试防止旧排序边界、双路径分词漂移、Recall/MRR 下降、无关查询误命中及 embedding 重定向/错误/凭据边界回归；未访问真实数据库、Redis、配置文件或外部 Provider。此次只复验 Python 基准，不证明生产 Node Agent Run 已装配。

2026-11-17 Web Agent SSE 断连取消边界：聊天路由将 HTTP 请求断开信号传入 `AgentChatService.start/resume` 与 outbox event stream；客户端断开会关闭订阅迭代器，但不会取消已持久化的后台 dispatch Run。Node service/route 回归 **9/9 通过**，包含 Fastify loopback HTTP 实际断连、订阅清理及 dispatch 仍待执行断言。服务测试以合成事件流/lease/store 验证，未连接真实 PG、Redis 或 Provider；这是 SSE 资源清理边界，不证明 `main.ts` 已装配生产 Agent Run。devserver Core build 通过；Host `tsconfig.build.json --noEmit` 仍被并行 MCP SDK 文件缺少 `@modelcontextprotocol/client` 阻断，本批源码和测试文件无类型诊断。

2026-11-17 RAG 授权/快照与共享质量回归复验：当前生产 RAG 端口、Run context、registry、Core RAG 源码及相关测试与 devserver 哈希一致后，Core build 通过；Host 生产 RAG registry、Run scope/snapshot、`search_conversations` Runner **6/6**，Host 正式 Jieba/共享相关性语料 **3/3**，Core RAG **9 文件、68/68**。Core 默认 suite 因 `tests/suites.json` 与当前测试发现集合不一致无法启动；未改共享清单，使用 `/tmp` 临时 Vitest 配置单跑 tokenizer 及 Core RAG 目录。另有一组合并测试包含 `memory-clear.test.ts` 时因 Host 测试包无法解析 `kysely` 而加载失败；排除该独立文件后，RAG 索引生命周期、持久 Worker、owner memory/knowledge FS、向量查询和工具续轮 **34/34**。使用临时 SQLite/FS、合成 PG 查询/lease/授权/配置/Provider；没有真实 PG、Redis 或生产 Agent Run。Python Cython rank、tokenizer、共享 golden、相关语料和 query embedding **94/94**；旧 `search_conversations` pytest **8/8**，`read_knowledge` pytest **6/6**，memory service/unified query/group owner **23/23**，覆盖 owner 隔离、多关键词、旧消息 ID 会话归属、BM25 chunk 合并、知识 ID 直读、owner/group scope 及词法/向量回退边界。pytest/Cython 产物位于隔离 `/tmp`。生产 `main.ts` 仍无 Agent Run caller，以上不作为生产接入完成证据。

2026-11-17 Chat 准备与 RAG 当前树短回归：本地与 devserver 的 Chat preparation 源码/测试、RAG tool ports、Jieba 和 Core memory search 哈希一致。devserver Chat preparation **6/6**；RAG registry、`search_conversations` 实际工具调用、Jieba 与 Core Runner **8/8**。使用合成 Pool、临时 SQLite/FS 和模拟 embedding；未连真实 PostgreSQL、Redis 或 Provider。本次执行环境无 pytest，因此 Python MCP 引用和附件基准没有重跑；既有 Python 结果见上文。生产 `main.ts` 仍未装配 Agent Run。
