# Node Agent 工具行为迁移清单

盘点日期：2026-11-15。此清单是当前工作树源码盘点，未运行的测试不记为通过；并行会话的未提交文件也不视为发布或生产接入证据。

## 状态口径

- **已完成并接入**：完整工具经过真实 Harness → ToolPort → 业务实现/Executor，已被实际生产Host Run装配，并有对应Python、Node行为及后端验收；明确列出仍使用的替身。
- **已实现待接入**：有可调用实现或独立注册表，但缺实际 Host 调用方或完整行为验收。
- **可迁移**：依赖已存在，尚未实现工具切片；属于未完成项。
- **依赖阻塞**：共享服务、可信能力或领域适配/回归尚未就绪；HTTP API 存在不等于工具可直接迁移。
- **退役/重设计**：架构明确退出旧实现，保留数据迁移与恢复责任。

初始盘点：`backend/agent/tools/` 有 109 个静态 `Tool(...)` 声明。此数字不包含动态 MCP 工具，也不是 pytest 数量。初始 `packages/core/src/agent/tools/` 尚不存在。Host 独立注册表仅列 `list_clients`、`create_client`、`create_project`；全 `apps/web-host/src` 查找未发现 `createAgentToolRegistry` 生产调用，不能据名称注册认定接入。

## 当前交付状态摘要

本表按**完整工具及实际生产Run装配**计数，不将Core合成Harness、注册器工厂或部分端口记为生产完成。当前109个静态工具：**已完成并接入0、已实现待接入48、部分实现3、依赖共享能力或平台57、退役/重设计1**。动态MCP另计；部分实现的工具同样仍有依赖阻塞，不重复计数。

| 状态 | 工具/范围 | 当前证据与缺口 |
| --- | --- | --- |
| 已实现待接入（48） | list_clients、create_client、update_client、list_projects、get_project、create_project、get_current_time、use_skill、list_scheduled_tasks、global_search、get_upcoming、list_trash、restore_file、restore_folder、read_conversation、list_events、list_workspaces、get_workspace、get_dashboard_stats、update_project、set_color、archive_project、add_stage、remove_stage、rename_stage、set_stages、update_stage、note_search、note_get、get_tool_schema、update_workspace、canvas_list、canvas_get、canvas_search、canvas_focus_node、canvas_search_placeable、canvas_create、list_skills、canvas_update_node、canvas_remove_node、canvas_update_note、canvas_create_note、canvas_add_node、canvas_update_anchor、canvas_connect、note_delete、note_restore、note_undo | Core真实调用及行为回归已列；Node生产main尚未装配Agent runtime/registry，Skill可信loader/资源source与部分领域Host链仍缺验收。此状态不保证全部后端已经具备。 |
| 部分实现（3） | read_file、ask_user、search_conversations | read_file 仅文本file_id子集；ask_user 的表单、沙盒授权与生产Host待接入；历史搜索缺真实 RAG 和生产装配。 |
| 依赖共享能力或平台（57） | 见逐工具清单 | 依赖共享领域/文件/历史/渠道/MCP/RAG/确认与实际执行后端；对应能力由A/B或可信平台Host提供，不注册假成功工具。 |
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
| `canvas.py` | `canvas_batch` | canvas_id, request_id, operations | 是 | 依赖阻塞 |
| `clients.py` | `list_clients` | 无 | 否 | 已实现待接入 |
| `clients.py` | `create_client` | client_name | 否 | 已实现待接入 |
| `clients.py` | `update_client` | 无 | 否 | 已实现待接入 |
| `clients.py` | `delete_client` | 无 | 是 | 依赖阻塞 |
| `conversations.py` | `search_conversations` | 无 | 否 | 部分实现（工具边界、近期查询与 owner 会话解析；真实 RAG 待装配） |
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
| `memory.py` | `search_memory` | query | 否 | 依赖阻塞 |
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
| `web.py` | `http_get` | 无 | 否 | 依赖阻塞 |
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
| http_get/web_download | Core Provider 网络 transport 是 Provider 出站边界；工具仍需明确 URL/DNS/重定向安全、下载配额/文件落点/媒体提取端口，不能直接裸 fetch | `agent/test_tool_schema_security_contract.py`、`agent/test_tool_schema_validation.py`；沿 `tools/web.py` 的 URL 安全服务继续核对专门测试 |
| 知识/记忆/全局搜索 | 目标复用 1.7.8 TypeScript RAG；需知识/长期记忆持久服务和 owner/IM scope、CAS、索引一致性，Cython 不迁 TS | `agent/knowledge/test_knowledge.py`、`test_read_knowledge_tool.py`、`test_knowledge_append_reuse.py`、`test_global_search.py`、`test_search_memory_boundary.py`、`agent/memory/test_remember_tool.py`、`im/test_im_memory_scopes.py` |
| 对话/群上下文 | Node Canonical 历史有持久适配，搜索/读取/绑定工具尚无 adapter；需 owner、群身份、访问范围与可信会话绑定 | `agent/test_tool_isolation.py`、`im/test_group_tool_permissions.py`、`agent/test_tool_history_request_boundary.py` |
| react/link buttons/email | 需可信渠道、地址/目标、邮件凭据与收件人安全策略；邮件 destructive 确认及附件 owner 校验不可省略 | `agent/test_send_link_buttons_tool.py`、`platform/email/test_email_tool.py`、`test_email_attachments.py`、`im/feishu/test_feishu_tool_summary.py` |
| MCP/Skill 管理 | Core 仅有 Harness 能力端口；需目录发现、不可变 Schema 快照、凭据存储、URL/stdio 安全后端、确认及配额 | `agent/mcp/test_mcp_manager_dispatch.py`、`test_mcp_credentials.py`、`test_mcp_schema_snapshot.py`、`test_mcp_stdio_quota.py`、`test_mcp_user_tools_e2e.py`、`agent/test_on_demand_tools.py` |
| meta/ask_user | Harness 有交互编排并不等于 `ask_user`/元工具实现；需 registry 递归安全、Schema 获取、Skill 可见性、持久交互及一次性回执 | `agent/test_on_demand_tools.py`、`agent/test_tool_schema_digest.py`、`agent/test_tool_schema_validation.py`、`agent/test_interaction_*.py` |
| shell | 仅 Executor/授权策略与注入的 MXC adapter 已实现；Shell 参数/输出映射、危险命令确认、授权撤销、取消清理和真实平台后端仍缺完整工具切片；Linux 隔离未验收 | `terminal/test_shell_concurrency.py`、`test_shell_sandbox.py`、`test_sandbox_compound_shell.py`、`storage/test_shell_policy.py`、`platform/security/test_phase4_filesystem_authorization.py` |

## 架构退役与重设计

- Linux/NAS 2.0 OSS/S3 在线存储、直传/预签名及对象搬移实现退役；上述文件工具保留业务用途，但需改用 Local 与明确授权边界，不能把整类工具退役。旧 OSS 数据盘点、导出、迁移完整性与恢复验收仍必须保留。
- Docker 沙盒生命周期、Rootless/镜像/容器重建等管理实现退役；`shell` 本身是待重设计/依赖阻塞，Linux MXC 账号、工作区、进程、资源和网络隔离未验收前不启用。
- DB↔FS 双向对账不迁为常规能力；旧数据一次性诊断/恢复与配额账本核对另列，不混入普通 Agent 文件工具。
- RAG 改为复用 1.7.8 TypeScript 引擎；Python/Cython 仅作迁移行为基准，不另造 TS 算法副本。

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

`read_conversation` 按旧版工具组放入 tools/conversations.ts，注册器仅在可信 Host 显式装配历史读取并授权时开放。共享会话历史数据适配器在同一 PostgreSQL 查询内限定 owner、排除 content_json 非 SQL NULL 的结构化记录，先取最近 N 条再按顺序输出；空正文在取数后过滤，单条截取 1200 个 Unicode 字符。不存在和跨 owner 使用相同错误，取消和撤权不返回正文。关键词搜索仍需 1.7.8 TypeScript RAG；不以站内搜索替代 BM25。生产 Host 和桌面 SQLite 历史读取能力仍待装配。

隔离 PostgreSQL 随机 schema 的工具调用测试 1 项通过，覆盖真实授权查询、空会话、最近顺序、JSON null、截断、跨用户、非法上限、撤权、组禁用与取消。Core Agent 运行测试 63 项通过，新增用例将工具结果送入模型下一轮（历史读取为明确替身）；Host 注册器 14 项通过；Python 对应 owner/跨用户测试 2 项通过。Core 构建和 Host 类型检查通过。第一次新增 PG 测试误将注册器追加的错误提示当成业务不一致，修正测试以检查原始错误字段后重跑通过，未放宽旧断言。真实 Redis、生产运行、桌面 SQLite 和 RAG 未验收。

历史正文读取共享用例补充：将 owner、最近条数、结构化记录过滤及 1200 码点截断收敛至 Core 会话领域的 PostgreSQL/SQLite 共用查询，Web Host 复用该服务。正式临时 SQLite 和隔离 PostgreSQL 均经真实工具注册器验证；Core 历史及 Agent 运行测试 74 项、PG 测试 1 项、Python owner/越权测试 2 项通过。Core 构建通过；SQLite 桌面 Host 与生产 Run 仍需显式装配，RAG 历史搜索未因此完成。

旧版行为补充对照：Python、正式 SQLite 和隔离 PostgreSQL 均验证先按最近普通消息限量、再过滤空正文，以及 1200 Unicode 码点截断；Python 与 Node 注册器另验证带 `#` 的全角数字 ID 和字符串 limit 按原契约归一。Python 行为/owner 测试 4 项、SQLite 测试 11 项、PG 工具测试 1 项通过。另一次 Core 默认 Vitest 启动因并行会话新增测试尚未登记而失败；在临时配置中仅运行本次已有测试文件后 11 项通过，没有修改对方测试或分类清单。该证据仅覆盖历史对话读取，不代表其余所有工具均已完成逐项等价验收。

### 历史搜索边界（2026-11-15）

`search_conversations` 的工具组已补输入互斥、分词去重、上限、命中会话去重、历史消息 ID 定位端口及未定位保护；搜索和定位端口均必须由可信 Host 按 owner 实现，缺失端口时不注册。无关键词走近期会话端口，关键词必须走注入的 RAG，未实现也未以站内搜索替代。时间投影覆盖常见 ISO 形式，Python `datetime.fromisoformat` 的全部宽松格式尚需差分核对。当前测试搜索和归属定位均为明确替身，不能证明真实 RAG、数据库归属或生产装配，工具仍属部分实现。

Core 历史查询测试 12 项、Host 注册器 15 项、Python 对照 6 项通过；Core 构建及最终 Host 类型检查通过。Core 测试因并行测试分类不一致使用临时配置运行既有测试文件。初次 Host 测试及类型检查碰到共享 Core 构建目录暂时不存在而失败，构建产物出现后复验通过；没有修改对方工作。真实 RAG、Redis 与生产 Agent 均未验收。

随后补齐共享会话领域的近期列表与旧索引定位：PostgreSQL/SQLite 均按 owner 读取，先验证显式 session_id，再按旧协议解析 message_id/source_id；近期列表按完整时间排序，不按展示到分钟的字符串排序。Host 通过共享查询与显式 RAG 端口组装，未注入真实 RAG 时不开放。正式临时 SQLite 测试 12 项、隔离 PostgreSQL 工具测试 1 项、Host 注册器 15 项与 Python 对照 6 项通过；RAG 命中为替身，数据库查询和归属验证为真实实现。Core 构建和 Host 类型检查通过；真实 RAG、生产装配和 Python 宽松 ISO 时间全部边界仍待验收，状态保持部分实现。

### TypeScript RAG 恢复进度（2026-11-15）

经用户确认，源码基线为旧仓库 `f0c0b391352ceb2dd0b26afc224f22ca2f10159a`：这是 Python/Cython 替换前最后完整 TypeScript RAG，版本为 1.7.7；本地 1.7.8 发布树已不含该实现。已迁入原协议类型、全部来源文档适配、缓存及部分不依赖分词的排序辅助，并保留原适配/缓存测试。尚未迁入词法分词、BM25、完整排序、索引构建和重建、授权来源、向量及生产 Host；当前代码没有注册为生产 RAG。旧 Data Runtime 的 OSS/S3 和独立 Worker 启动流程不会机械作为 2.0 在线架构启用。

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
