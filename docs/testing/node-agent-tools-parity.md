# Node Agent 工具行为迁移清单

> 当前数据库初始化统一使用 [Database 包的编号迁移](../../packages/database/README.md)。下文中的分模块命令、手工 SQL 和升级步骤为改造期间的历史记录。

盘点日期：2026-11-19。按当前 `backend/agent/tools/` AST 复核为 26 个直接继承 `BaseSkill` 的工具组、109 个静态 `Tool(name=...)` 声明，109 个名称唯一；数字不含动态 MCP。未运行的测试不记为通过；并行会话的未提交文件也不视为发布或生产接入证据。

## 状态口径

- **已完成并接入**：完整 Node 工具经过 Harness → ToolPort → 业务实现/Executor，已被实际生产 Host Run 装配，Node 行为和后端验收通过；历史行为契约只用于确认用户可见语义，不构成 Python 运行依赖；明确列出仍使用的替身。
- **已实现待接入**：有可调用实现或独立注册表，但缺实际 Host 调用方或完整行为验收。
- **部分实现**：生产 Run 已有部分调用链，但真实后端、平台能力或关键行为验收仍缺失。
- **可迁移**：依赖已存在，尚未实现工具切片；属于未完成项。
- **依赖阻塞**：共享服务、可信能力或领域适配/回归尚未就绪；HTTP API 存在不等于工具可直接迁移。
- **退役/重设计**：架构明确退出旧实现，保留数据迁移与恢复责任。

当前 AST 盘点：旧清单记录 26 个工具组和 109 个静态名称，用于迁移范围盘点；它不是 2.0 的运行时或兼容目标。动态 MCP 工具另计。当前 `main.ts` 已装配 Agent Chat/Run 与 per-lease 工具资源工厂；仍按逐工具状态区分生产调用链与未验收的真实存储、确认及平台能力。最终运行目标是 Node-only 并删除 Python 后端。

## 当前交付状态摘要

本表按**完整 Node 工具及实际生产Run装配**计数，不将Core合成Harness、注册器工厂或部分端口记为生产完成。旧工具清单仅用于盘点迁移范围：26 个工具组、109 个静态工具名；2.0 只运行 Node，不保留 Python 兼容、桥接或回退，最终目标是删除 Python 后端。109 项当前状态为：**已完成并接入71、已实现待接入0、部分实现35、依赖共享能力或平台2、退役/重设计1**。其中 `react`、`bind_web_session` 已有 Core 工具及可复用 Host 适配器，但当前树没有实时 Node IM Gateway 调用方，依赖该可信平台入口后才能启用。部分实现的工具同样仍有验收缺口，不重复计数。

| 状态 | 工具/范围 | 当前证据与缺口 |
| --- | --- | --- |
| 已完成并接入（71） | search_conversations、read_conversation、read_knowledge、remember、get_current_time、get_upcoming、list_events、list_clients、list_projects、get_dashboard_stats、list_workspaces、get_workspace、list_scheduled_tasks、create_scheduled_task、update_scheduled_task、delete_scheduled_task、list_trash、restore_file、restore_folder、update_workspace、create_client、update_client、delete_client、create_project、update_project、set_color、archive_project、delete_project、add_stage、remove_stage、rename_stage、update_stage、set_stages、get_project、get_tool_schema、call_tool、send_email、manage_mcp_servers、note_search、note_get、note_create、note_update、note_delete、note_restore、note_undo、list_skills、use_skill、create_skill、update_skill、delete_skill、canvas_list、canvas_get、canvas_search、canvas_focus_node、canvas_search_placeable、canvas_create、canvas_create_note、canvas_add_node、canvas_update_node、canvas_remove_node、canvas_update_note、canvas_connect、canvas_update_anchor、create_event、update_event、delete_event、global_search、web_search、web_download、grep、list_recent_attachments | Web 主链经真实隔离 PostgreSQL、Redis、注册器和 SSE 通过。历史、知识、日历、联系人、项目、总览、工作区、定时任务、回收站、恢复、邮件、MCP 配置、Mind 笔记、技能及画布工具均经实际调用链验证；`create_event` 验证带/不带提醒的 owner 日程 Node 写入；`update_event` 验证 PostgreSQL CAS 更新、提醒 ID/提前量/渠道/启用状态保留、启用提醒随活动时间改期、停用提醒计划不变以及标题投影更新；`global_search` 验证 PostgreSQL 来源、类型限制及忽略模型伪造的 owner_id；`read_knowledge` 经正式 Worker 写入的 PostgreSQL 索引执行 owner BM25 查询、经 owner FS 按 ID 返回完整正文，异主搜索隔离且异主 ID 安全 not-found；`remember` 在生产 Host Run 通过 ToolRegistry 写入 owner 档案、恢复持久收据并续入 Provider，实际 Node RAG Worker 消费索引任务；Core 日历创建/更新 **6/6**，生产 HTTP/SSE/隔离 PostgreSQL/Redis 主链 **1/1**；`list_scheduled_tasks` 验证 owner 过滤并排除日历提醒，`create_scheduled_task`/`update_scheduled_task` 验证正式 Node 写端口、停用一次性任务创建、owner 归属与更新时间指令；`delete_scheduled_task` 经 HTTP/SSE/持久确认 token 恢复同一 Run，确认前任务仍存在，确认后隔离 PostgreSQL 行删除且 Redis `scheduled_tasks` 资源版本递增；Host 写入/删除 PostgreSQL 回归 **4/4**，Core 删除回归 **1/1**；`list_trash` 验证 owner 软删除结果和微秒时间，`restore_file`/`restore_folder` 验证 PostgreSQL 墓碑与临时磁盘文件同步恢复、异主隔离及收据重建不重做，`update_workspace` 验证同事务同步工作区与目录显示名且保留物理目录键；`note_create`/`note_update` 经正式 Agent Run 创建 Markdown 笔记、追加正文并核对持久版本与纯文本投影；`note_delete`/`note_restore`/`note_undo` 验证 owner 普通笔记软删、恢复、最近咕咕笔记撤销及异主不变；`list_skills` 验证 Node Markdown frontmatter 目录只投影元数据，`use_skill` 验证技能正文通过生产 Run 续入 Provider；`create_skill`/`update_skill` 经生产 Run 持久创建、更新 owner 技能，回读验证管理来源、启用状态与正文，并确认更新正文进入后续 Provider 请求；`delete_skill` 经持久确认 token 恢复同一 Run，确认前技能仍存在，确认后删除 owner Skill 且 Redis `skills` 资源版本递增；Core `skill-management.test.ts` **2/2**，Host HTTP/删除测试 **1 通过、1 个隔离 PG 子测试跳过**，生产主链 **1/1**；`delete_client` 经 HTTP/SSE/ToolRegistry 创建 owner 确认 prompt，确认前无删除，消费确认 token 后恢复同一 Run 并删除目标，Core `clients.test.ts` **20/20**、Host RAG/lease 回归 **15/15**、隔离生产主链 **1/1**；`send_email` 覆盖持久确认/取消、SMTP 收据和定时预授权，测试 SMTP 使用环回端点；`call_tool` 验证嵌套读取/写入、目标授权与原调用 ID 续轮；`manage_mcp_servers` 覆盖持久确认/取消、凭据轮换与私密表单恢复，隔离 PostgreSQL/Redis Host 行为此前通过。`web_download` 的恢复清理只删除自身前缀、当前 UID 且超过 24 小时的暂存目录；测试在临时目录验证近期目录与符号链接目标不受影响。`web_search` 经 Host 搜索 factory、Core Registry 和 AgentRunner 实际分派，合成结果进入下一轮上下文；未调用付费或真实 Provider。`list_recent_attachments` 通过 Core ToolRegistry 和 Web per-lease Host adapter 列出草稿及当前会话附件元数据，Host 行为 **2/2**；使用合成 Pool，未另跑完整 HTTP/SSE/真实 PostgreSQL 主链。`grep` 的实际 Core/Host ToolRegistry dispatch 使用临时文件系统与合成 PostgreSQL 端口通过；真实 PostgreSQL/HTTP-SSE Run 验收留待统一回归。Provider 使用合成服务，桌面与 IM 不计入本行验收。`delete_project` Host Registry 核心调用回归通过，使用隔离 SQLite 与合成 lease/确认凭据；真实 PostgreSQL/Redis 恢复验收留待统一回归。真实外部 MCP 服务及生产部署未验收。 |
| 已实现待接入（0） | — | 当前无此状态工具。 |
| 部分实现（35） | list_dir、read_file、edit_file、rename_file、copy_file、create_file、create_folder、rename_folder、delete_folder、delete_file、move_items、compress_files、extract_files、create_workspace、unlink_workspace、delete_workspace_directory、undo_last_action、permanent_delete、ask_user、send_link_buttons、search_memory、group_context_search、save_knowledge、update_knowledge、delete_knowledge、http_get、canvas_delete、canvas_delete_note、canvas_disconnect、canvas_batch、similar_image_search、deep_research、send_file、present_file、save_uploaded_file | `list_dir` 已通过生产 ToolRegistry 组合调用既有 PostgreSQL 文件浏览服务，支持明确 space 或文件库登记逻辑路径、最多 8 个关键词 OR/AND 与准确文件总数；旧版 Shell scope=logical 用户根、system scope、偏移分页和全量文件夹语义尚未迁移，真实 PG/HTTP-SSE Run 尚未验收。`read_file` 支持 owner file_id 与已登记逻辑路径读取，以及最多 20 项/64 MiB 的批量文本；物理路径不直接进入 FS。`edit_file` 已接入生产 per-lease registry，支持 owner `file_id` 或登记逻辑路径、全文替换/追加/查找替换、带 expected 原文校验的按行替换/删除，以及最多 20 项逐项成功/失败批次；每项复用 Host owner 文件读取、版本 CAS 与 Undo。真实 PostgreSQL 与完整 HTTP/SSE Run 留待统一验收。`rename_file` 已接入生产 per-lease registry，支持稳定 file_id 与 owner 文件清单精确解析的登记逻辑路径，复用现有文件更新事务处理存储路径规划、版本 CAS、Undo 与变更发布；当前用合成 owner 查询/更新端口和临时文件验证，真实 PostgreSQL 与 HTTP/SSE Run 尚未验收。工具仍未迁移旧版按名称消歧及完整扩展名规则。`copy_file` 已注册为明确目标空间的保留两者复制，源文件可用 file_id 或 owner 文件清单唯一解析的登记逻辑路径定位；复用文件复制事务的 owner 校验、配额、文件系统/数据库写入和 Undo；覆盖路径不开放。`create_file` 已接入生产 per-lease registry，支持单文件和最多 20 项逐项创建，单文件 UTF-8 正文上限 256 KiB，拒绝 PDF/Office 等二进制扩展名；每项使用独立持久收据。工作区目标目录由 Host 从可信会话绑定解析，并在上传事务内复核；不接受模型提交 workspace_directory_id。Host Registry 使用临时文件和合成上传事务验证实际字节、owner/lease、部分失败与收据重放；真实 PostgreSQL 与完整 HTTP/SSE Run 留待统一验收。`create_folder` 已接入生产 per-lease registry，限定个人/项目/工作区目标并复用 `FolderWriteOperations.create` 的 owner 与父目录校验、Undo 和路径镜像；Host 持久 reservation/result 回执保护重复调用、崩溃恢复和未知提交不重放，Host Registry 经临时 SQLite 与真实临时文件域用例验证；Pool/lease/领域操作为合成依赖，真实 PostgreSQL 与 HTTP/SSE Run 尚未验收。`rename_folder` 已按稳定 folder ID 接入 per-lease Registry，复用 FolderWriteOperations 的版本 CAS、Undo 和 PathMirror；按名称定位和重名消歧未接入，当前 Host 测试使用合成端口。`move_items` 已按文件/文件夹 ID 接入生产 per-lease registry，文件也支持 owner 清单唯一解析的登记逻辑路径；逐项复用现有文件版本 CAS 与文件夹树移动事务，并返回成功和失败清单；仅支持显式 personal/project 目标，不支持名称猜测或会话绑定 workspace。核心与 Host 的 registry 回归使用合成存储端口，真实 PostgreSQL 和完整 HTTP/SSE Run 尚未验收。上述文件写工具均未验收完整 HTTP/SSE Run。`unlink_workspace` 已进入 Core 工具组、Web per-lease Registry、Host 确认门与 Main Agent 装配；确认前不写入，确认后在收据事务内复核 owner/名称/kind，再复用 Core 工作区删除用例解除声明、解绑会话并停用普通任务，保留目录、项目、文件和日历提醒；Core 临时 SQLite ToolRegistry 行为 **2/2**，Host RAG/lease 回归 **21/21**、配置白名单/Registry 回归 **29/29**，使用合成确认凭据，真实 PostgreSQL/Redis 确认恢复及完整 HTTP/SSE Run 尚未验收，故列为部分实现。`create_workspace` 已经 Core/Host per-lease Registry、Web 授权和 Main 接线；项目/文件夹绑定复用现有 PostgreSQL 声明创建服务，顶层目录复用 Workspace Directory 创建服务，并通过共享 reader 返回实体。Core ToolRegistry **3/3**、Host Registry→lease→SQLite receipt adapter **5/5**；reservation/result 持久回执覆盖成功重放、改参/未知结果不重做、并发去重、取消及 lease 失效拒绝。领域服务/Pool/lease 使用合成依赖，真实 PostgreSQL 与完整 HTTP/SSE Run 尚未验收。`send_file` 的 Host adapter 已经临时 SQLite/文件系统验证 owner 读取、路径越界拒绝和 lease freshness；真实 PG、IM 投递和完整 HTTP/SSE Run 未验收。`delete_file` 已经 Core/Host per-lease Registry，支持稳定 owner file_id、由当前 owner 文件清单精确解析的登记逻辑路径和 1-50 个 ID 的原子批量软删除，复用正式删除事务、30 天回收站、Undo 与资源变更；Agent 收据与删除事务原子提交，提交未知可按 owner 收据恢复原结果且不重复删除。进程异常后的硬链接清理恢复及完整 HTTP-SSE Run 尚未验收。`save_uploaded_file` 已进入 Core 文件组及生产 per-lease Registry，Host 复用 owner 附件下载和正式上传/配额/Undo/持久收据事务，Node 用例经真实临时附件文件及 Registry dispatch 验证字节、授权、收据重放和 lease 失效拒绝；支持 personal/project 与从可信会话绑定解析的 workspace 目标；上传事务复核绑定；PostgreSQL 写入仍用合成服务，完整 HTTP/SSE Run 未验收。`permanent_delete` 已接入 Core 回收站工具组、Web per-lease Registry/授权/持久确认和 Main，确认时复核 owner 回收站快照，并复用 Host 持久 purge job 与已运行的 Node Worker；Core 工具/真实 ToolRegistry **6/6**，Host purge adapter/既有持久任务 **5/5**，Web Host production typecheck 通过。测试使用临时 SQLite 收据与合成 lease/Pool/确认/任务端口；未验证隔离 PostgreSQL、Redis 唤醒及完整 HTTP/SSE Run，故列为部分实现。Web Run 已按 lease 提供共享领域端口；`http_get` 已接入生产 Run 的安全公网 GET 端口和 Core 注册/权限链，支持安全请求头及 HTML/PDF 正文提取（PDF 由 Core `pdfjs-dist` 提取并遵守 200,000 字符上限）；完整 HTTP/SSE Run 与真实外网验收仍缺。画布删除/断开及批量修改仍需确认与逐项持久恢复验收；`canvas_remove_node` 仅移除视图项且已验证保留来源便签。`send_link_buttons` 已接入 Web artifact 行为，IM 真实投递/持久回执未接入。危险写入只在确认密钥可用时注册，确认意图加密存于 PostgreSQL，owner/session/run、账号安全版本、Provider 访问版本和活动 dispatch lease 在准备与业务事务中复核。除逐项注明的用例外，尚缺真实存储、外部 Provider、提醒投递及恢复验收。 |
| 依赖共享能力或平台（2） | react、bind_web_session | 两项工具等待实时 Node IM Gateway 注入可信消息/owner 来源后才能开放。 |
| 退役/重设计（1） | shell | 工具用途保留；Docker 生命周期实现退役。Linux Web Host 已接入独立 Bubblewrap，真实命令与 PTY 的隔离回归通过，完整 Web Run 和部署验收进行中。 |

生产调用方复核：`main.ts`在 Redis 可用时装配 Agent Chat/Run、Web Reconstructor 与 Core RAG 工具 registry，并按 lease 注入共享领域端口。危险日历/画布写入只在当前凭据主密钥可用时注册；确认意图加密保存于 PostgreSQL，确认提示经现有确认凭证通道，确认恢复由 Core Chat 唤醒并由 Host PostgreSQL 收据、权限版本与事务 claim 复核。画布各工具使用独立 action gate，发布复用既有 Mind/日历 publisher；交互激活、投影和响应适配接入既有 route 入口，无新增 HTTP route。Core 持有 Chat/Run 生命周期、dispatch 与唤醒契约，Host 保留 PG/Redis、Fastify、Provider、FS 和事件投影组合适配。会话搜索已通过隔离 PostgreSQL、Redis、合成 Provider、工具续轮和强制退出后重启恢复。提醒投递与真实外部 Provider 另行验收。技能管理写工具已按可信租约接入。删除仅在确认能力可用时开放。当前 Web Agent 对两种管理来源的技能删除均使用持久确认。历史记录中的旧接线状态只作历史记录，不覆盖本次复核结果。

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
| `calendar.py` | `create_event` | title, date, all_day | 否 | 已完成并接入 Web：正式 Agent Run 经 HTTP/SSE/ToolRegistry 在隔离 PostgreSQL 创建 owner 日程与提醒；无 reminders 时不产生 scheduled task。真实主链 **1/1**、Core `calendar-create.test.ts` **3/3**；真实外部提醒投递未涉及。 |
| `calendar.py` | `list_events` | 无 | 否 | 已完成并接入 Web：真实生产 Run 经 Host per-lease 日历 reader 查询隔离 PostgreSQL，验证 owner 事件/提醒过滤、提醒投影与模型续轮；Provider 为环回合成服务。Python 历史基准覆盖范围、类型、limit、提醒字段及 owner 过滤（此前 2 项通过；本轮环境无 pytest，未重跑）。 |
| `calendar.py` | `update_event` | 无 | 否 | 已完成并接入 Web：真实主链验证隔离 PostgreSQL owner 活动 CAS 更新、提醒任务身份/设置保留、启用提醒自动改期、停用计划不变和标题更新；Core `calendar-update.test.ts` 覆盖替换/清除提醒、无字段、owner 与版本冲突。Provider 为环回合成服务，Python pytest 本轮未运行。 |
| `calendar.py` | `delete_event` | 无 | 是 | 已完成并接入 Web：正式 Run 经持久确认 token 恢复；确认前 owner 活动仍有效，确认后活动软删、关联启用及停用提醒均停用，Redis 日历资源版本递增。Core `calendar-delete.test.ts` **5/5**，隔离生产 HTTP/SSE/PG/Redis 主链 **1/1**；外部提醒投递与生产部署未验收。 |
| `canvas.py` | `canvas_list` | 无 | 否 | 已完成并接入 Web：真实 Run 读取 owner 画布分页结果、活动项计数及视图投影；隔离 PG 验证不返回异主画布。Core 画布定向 **12/12**，生产 HTTP/SSE/PG/Redis 集成 **1/1**；Python pytest 本轮未运行。 |
| `canvas.py` | `canvas_get` | canvas_id | 否 | 已完成并接入 Web：真实 Run 读取 owner 画布节点及正文，异主画布返回安全 not-found；详情、布局与关系投影经 Core 回归。Core 画布定向 **12/12**，生产 HTTP/SSE/PG/Redis 集成 **1/1**；Python pytest 本轮未运行。 |
| `canvas.py` | `canvas_search` | canvas_id | 否 | 已完成并接入 Web：真实 Run 搜索 owner 画布节点并返回真实命中；Core 回归覆盖过滤、旧式墓碑语义和 `limit+1` 计数。Core 画布定向 **12/12**，生产 HTTP/SSE/PG/Redis 集成 **1/1**；Python pytest 本轮未运行。 |
| `canvas.py` | `canvas_focus_node` | canvas_id, item_id | 否 | 已完成并接入 Web：真实 Run 从 owner 画布项生成 `gugu://focus-canvas/...` 定位链接，不写数据库；Host 集成验证生成目标 ID。Core 画布定向 **12/12**，生产 HTTP/SSE/PG/Redis 集成 **1/1**；Python pytest 本轮未运行。 |
| `canvas.py` | `canvas_search_placeable` | 无 | 否 | 已完成并接入 Web：生产 Run 通过 Core 搜索当前 owner 可放置项目/文件/活动；真实隔离 PG 工具调用命中己方项目并排除异主项目。Core 画布定向 **12/12**，生产 HTTP/SSE/PG/Redis 集成 **1/1**；Python pytest 本轮未运行。 |
| `canvas.py` | `canvas_create` | title | 否 | 已完成并接入 Web：生产 Run 创建画布，隔离 PostgreSQL 回读确认 owner、标题和默认项目字段；Core 画布组 **12/12**，生产 HTTP/SSE/PG/Redis 集成 **1/1**；Python pytest 本轮未运行。 |
| `canvas.py` | `canvas_delete` | 无 | 是 | 部分实现（Host per-lease action gate 与 publisher 已接线；真实 PG/Redis 确认恢复未验收） |
| `canvas.py` | `canvas_create_note` | canvas_id | 否 | 已完成并接入 Web：生产 Run 创建 owner 画布便签及画布项；隔离 PG 验证关联，Core 画布组 **12/12**、生产集成 **1/1**；Python pytest 本轮未运行。 |
| `canvas.py` | `canvas_add_node` | canvas_id | 否 | 已完成并接入 Web：生产 Run 将 owner 项目引用放入画布；隔离 PG 回读确认引用类型、项目 ID 与 owner，Core 画布组 **12/12**、生产集成 **1/1**；Python pytest 本轮未运行。 |
| `canvas.py` | `canvas_update_node` | 见源 Schema | 否 | 已完成并接入 Web：生产 Run 调整 owner 画布项位置，隔离 PG 回读确认坐标，Core 画布组 **12/12**、生产集成 **1/1**；Python pytest 本轮未运行。 |
| `canvas.py` | `canvas_remove_node` | canvas_id | 否 | 已完成并接入 Web：生产 Run 仅软删当前 owner 画布项，隔离 PG 回读确认便签节点及正文仍存在；Core 画布组 **12/12**、生产集成 **1/1**；Python pytest 本轮未运行。 |
| `canvas.py` | `canvas_update_note` | 无 | 否 | 已完成并接入 Web：生产 Run 对 owner 专属画布便签增量更新正文/标题；隔离 PG 回读确认内容投影与版本递增，Core 画布组 **12/12**、生产集成 **1/1**；Python pytest 本轮未运行。 |
| `canvas.py` | `canvas_delete_note` | 无 | 是 | 部分实现（Host per-lease action gate 与 publisher 已接线；真实 PG/Redis 确认恢复未验收） |
| `canvas.py` | `canvas_connect` | canvas_id, source_node_id, target_node_id | 否 | 已完成并接入 Web：生产 Run 连接同一 owner 画布内的便签与项目引用；隔离 PG 验证关系行，Core 画布组 **12/12**、生产集成 **1/1**；Python pytest 本轮未运行。 |
| `canvas.py` | `canvas_update_anchor` | canvas_id, relation_id, source_side, target_side | 否 | 已完成并接入 Web：生产 Run 按 owner 及画布更新关系端点，隔离 PG 回读确认 `relationAnchors` 持久化，Core 画布组 **12/12**、生产集成 **1/1**；Python pytest 本轮未运行。 |
| `canvas.py` | `canvas_disconnect` | canvas_id | 是 | 部分实现（Host per-lease action gate 与 publisher 已接线；真实 PG/Redis 确认恢复未验收） |
| `canvas.py` | `canvas_batch` | canvas_id, request_id, operations | 是 | 部分实现（含删除操作接入独立确认 gate；真实 PG/Redis 确认恢复及 Provider Run 未验收） |

| `clients.py` | `list_clients` | 无 | 否 | 已完成并接入 Web：实际生产 Run 经可信 lease 调用 Core owner-scoped 联系人服务，真实 PostgreSQL 结果续入 Provider 请求并验证异主联系人不泄漏。Node 联系人工具 20 项通过；Python 共享数据 owner 基准此前通过，本轮未重跑 pytest。 |
| `clients.py` | `create_client` | client_name | 否 | 已完成并接入 Web：真实生产 Run 执行创建，隔离 PostgreSQL 验证 owner、联系人、邮箱持久副作用；Core 联系人工具回归 20 项通过，Python 共享存储/owner 基准此前有通过记录，本轮未重跑 pytest。 |
| `clients.py` | `update_client` | 无 | 否 | 已完成并接入 Web：生产 Run 通过联系人名定位并持久更新 notes，隔离 PostgreSQL 回读确认副作用与 owner；Core 联系人工具回归 20 项通过，Python 共享存储/owner 基准此前有通过记录，本轮未重跑 pytest。 |
| `clients.py` | `delete_client` | 无 | 是 | 已完成并接入 Web：正式生产 Run 经持久确认 prompt 和 token 恢复，确认前无副作用、确认后删除 owner 目标；Core 覆盖单/批删除、目标变化、claim 拒绝、owner 隔离和历史 `client_id=0` 语义。 |
| `conversations.py` | `search_conversations` | 无 | 否 | 已完成并接入 Web。按 owner/lease 使用 Node 持久 RAG，已跑真实 PostgreSQL、Redis、HTTP/SSE、工具结果续轮、跨 owner 隔离与进程重启恢复；模型为环回合成 Provider。此前 Python RAG 118/118 与会话基准 4 通过、62 未选中。 |
| `conversations.py` | `read_conversation` | session_id | 否 | 已完成并接入 Web：生产 Run 通过可信 owner reader 从 PostgreSQL 读取最近普通消息；真实 HTTP/SSE 集成连续执行搜索→正文读取→Provider 续轮。覆盖异主拒绝、结构化消息过滤、最近窗口、空正文、工具文本及 Unicode 截断。Python 行为基准此前 4 项通过/62 deselected；本次 Node 验收使用隔离 PostgreSQL/Redis 和环回合成 Provider。 |
| `conversations.py` | `bind_web_session` | session_id | 否 | 依赖阻塞：Core `agent/tools/im.ts`、`agent/sessions/im-tools.ts` 提供 owner/Web 来源校验与 12 小时 Bot 隔离绑定；Host `tools/agent-im.ts` 有可复用 DB/Redis 工厂。当前树没有实时 Node IM Gateway 调用方；接入前必须由 Gateway 注入可信 owner 私聊身份，不能从模型参数推导。 |
| `email.py` | `send_email` | subject, body | 是 | 已完成并接入 Web：Core Run 按 owner 读取账号/联系人邮箱及附件，持久确认、取消与发送收据复用 Host 端口；定时发送按任务预授权和消费者租约复核。Python `test_email_tool.py`、`test_email_attachments.py` 本轮 **27/27**；Node Core **4/4**，Host SQLite **1 通过**，本轮 PG/Redis 条件测试 **2 跳过**（测试 URL 未配置）。同一源码历史隔离 PG/Redis 持久 Run 确认/取消 **8/8**、定时生产入口环回 SMTP **3/3** 通过。真实外部 SMTP 和部署未验收。 |
| `files/file_tools.py` | `list_dir` | 无 | 否 | 部分实现：Node Core/生产 ToolRegistry 支持明确空间或通过 `file_path` 指定文件库 `/personal`、`/project`、`/workspace` 登记路径，Host 按可信 owner 精确解析项目、工作区和目录；关键词支持最多 8 项 OR/AND，Host 文件分页 SQL 返回完整过滤总数。Core 文件组 **77/77**，Host Core Registry/owner SQL/分页 SQL **3/3**。这不等于旧版 Shell `scope=logical` 的本地目录读取；其可信用户根映射尚未装配。system scope、偏移分页和旧版全量文件夹列表语义未迁移，真实 PostgreSQL/HTTP-SSE Run 留待统一回归。|
| `files/file_tools.py` | `read_file` | 无 | 否 | 部分实现：Core 严格支持 file_id、Host 登记逻辑路径及 owner `attach_id`；聊天附件开放白名单文本和 PDF/Office 正文读取，单项/批量复用 owner 解析、`packages/fs` 授权根、UTF-8/大小/行范围校验。Core `files.test.ts` **75/75**；Host 文件工具 ToolRegistry/adapter 与临时 FS **1/1**，覆盖附件 owner 查询、行范围、批量和异主不查询。历史图片/音频/视频、URL、system scope 未装配；真实 PostgreSQL 与 HTTP/SSE Run 留待统一回归。 |
| `files/file_tools.py` | `grep` | query | 否 | 已完成并接入 Web：Core 逐行字面量搜索复用 Host owner 文件清单和 `packages/fs` 授权根读取，支持个人/项目/Workspace、逻辑路径范围、上下文、并发读取、Base64 省略和输出上限。生产 Main/Reconstructor/lease 授权与 ToolRegistry 已接通；Core 文件组 **66/66**、Host owner 文件 adapter/真实 ToolRegistry dispatch **2/2**、Host RAG授权/工具注册回归 **49/49**、Web Host production typecheck 通过。Node 用例用临时文件和合成 Pool；真实 PostgreSQL/HTTP-SSE 主链与完整 Python pytest 对照留待统一验收。
| `files/file_tools.py` | `edit_file` | 无 | 否 | 部分实现（Core 支持 replace/append/精确文本替换，Host 使用 per-lease owner 文件解析及现有文件正文事务服务的版本 CAS/Undo；工具通过生产 registry dispatch 验证。当前测试使用合成 PostgreSQL/文件内容更新端口和临时真实文件；未验收隔离 PostgreSQL 写入及 HTTP/SSE Run） |
| `files/file_tools.py` | `rename_file` | 无 | 否 | 部分实现：Core 在逻辑路径解析前检查 Host 持久回执，避免成功改名后因原路径失效而误判；`new_name` 含扩展名时按完整文件名改名，不含点时保留旧扩展名，`format` 支持自定义扩展名和 Markdown/Text/YAML 别名归一，并返回旧文件名。Host 在 owner/活动 lease 复核后，将存储路径规划、版本 CAS、Undo、变更记录和调用回执置于同一 PostgreSQL 事务，重放/Run 恢复只读回执，提交未知返回 unknown。Core/Host ToolRegistry 使用模拟更新/Pool/lease 测试首次改名、扩展名处理、旧名、重放和恢复；批量改名、真实 PostgreSQL/HTTP-SSE Run 尚未验收。 |
| `files/file_tools.py` | `copy_file` | 无 | 否 | 部分实现：仅开放显式 `space` 的 keep_both 副本写入；源可用 file_id 或登记逻辑路径精确解析。复制事务将 owner/Run/轮次/tool-call/参数指纹收据与副本、Undo 同一 PostgreSQL 事务提交；精确重放和 Run 恢复只读回执，不重复复制，提交结果未知返回 unknown。Core/Host ToolRegistry 使用模拟复制/Pool/lease 测试实际调用、重放与恢复；真实 PostgreSQL/HTTP/SSE Run 尚未验收。overwrite 不注册，也不绕过确认门。 |
| `files/file_tools.py` | `create_file` | files | 否 | 部分实现（Core/Host 复用正式上传服务，明确个人/项目/工作区目标，复用配额、临时暂存、owner/lease 事务校验、keep_both 与持久操作收据；Host 合成 registry dispatch 已测，真实 PostgreSQL 集成回归存在但因测试库未配置而跳过，完整 HTTP/SSE Run 尚未验收） |
| `files/file_tools.py` | `delete_file` | file_id/file/file_ids | 否 | 部分实现：Core/Web Host per-lease Registry 按稳定 owner ID 或 owner 登记逻辑路径单项删除，并支持 1-50 项原子批量软删除，复用正式文件回收站、Undo 与变更通知；Agent 调用收据与软删在同一 PostgreSQL 事务提交，提交结果未知时进入 unknown 并可恢复原结果、不重放删除。完整 HTTP/SSE 文件工具 Run 未验收。Core 文件组 77/77、Host adapter ToolRegistry 8/8、临时 PostgreSQL 删除领域回归 11/11；恢复只返 receipt 结果，提交断连后残留硬链接清理仍需后续恢复处理。 |
| `files/folder_tools.py` | `move_items` | target | 否 | 部分实现（Node Core 文件组支持 ID 列表和显式 personal/project 目标；Host 逐项按 owner 查询版本，再复用 FileUpdateOperations 与 FolderWriteOperations.move。名称解析、workspace 绑定目标和真实 PostgreSQL/HTTP-SSE Run 尚未验收） |
| `files/folder_tools.py` | `create_folder` | folder_name | 否 | 部分实现：Core 工具经 per-lease registry 调用共享 `FolderWriteOperations.create`；Host 持久 reservation/result 收据绑定 owner/session/run/round/call 和参数，lease 复核后才执行；成功重放/恢复只读结果，未知结果和改参不重做。Core 文件组定向回归 **77/77**、Host Registry→Host adapter/临时 SQLite 回执及文件域行为 **1/1**、Web Host production typecheck 通过。Pool/lease/领域操作为合成依赖；真实 PostgreSQL 与 HTTP/SSE Run 尚未验收。 |
| `files/folder_tools.py` | `rename_folder` | new_folder_name | 否 | 部分实现：Core 通过 folder_id 和新名称调用 per-lease Host 端口，复用 `FolderWriteOperations.rename` 的 owner/版本 CAS、Undo 和 PathMirror；Host 持久 reservation/result 收据绑定调用身份与参数，未知结果、并发重放和进程恢复不重复改名。Core 文件组 **77/77**、Host Registry→Host adapter/临时 SQLite 收据及文件域行为 **1/1**、Web Host production typecheck 通过。使用合成 Pool/lease/领域操作；按名称定位/重名消歧、真实 PostgreSQL 与 HTTP/SSE Run 尚未验收。 |
| `files/folder_tools.py` | `delete_folder` | 无 | 否 | 部分实现：Core 文件组与生产 Web per-lease Registry/授权已接入，稳定 `folder_id` 经 Host 复用现有 `FolderDeleteOperations`，执行级联软删、30 天回收站、Undo 与 PathMirror 回滚。Agent 调用收据与子树变更在同一 PostgreSQL 事务提交；提交结果未知时返回 unknown，由 owner 收据恢复原工具结果且不重放删除。Core ToolRegistry 3/3；Host ToolRegistry/lease/未知提交恢复与领域回归 11 通过、隔离 PG 用例 1 跳过；使用合成 Pool/操作端口。进程崩溃后的 PathMirror 清理恢复、按名称定位、批量原子删除及完整 HTTP/SSE 文件工具 Run 未验收。 |
| `files/transfer_tools.py` | `compress_files` | entries | 否 | 部分实现：Core 文件组已定义、校验并注册；Web per-lease Host adapter 调用正式 PostgreSQL/文件系统归档事务，owner 与活动 lease 在事务内复核，复用同空间检查、512MB 源限制、配额与资源发布。Core 文件工具 **70/70**、Host Registry/adapter **32/32**、Core build、Web Host production build 通过。Host 行为用合成 Pool/领域端口；隔离 PostgreSQL 归档集成测试因未配置测试 URL 跳过。完整 HTTP/SSE Run、Agent 持久调用收据及执行中取消尚未验收。 |
| `files/transfer_tools.py` | `extract_files` | file_id | 否 | 部分实现：与 `compress_files` 共用 Node 文件组、生产 per-lease Registry 和正式 Host 归档服务；输出保持旧业务字段并将 ID 样本限制为 100 项。Host 调用端口验证 owner、目标、格式及事务内活动 lease；归档服务校验 ZIP/TAR 路径穿越、最多 10,000 条目、2GB 解压上限和配额，不覆盖既有文件。隔离 PostgreSQL 领域集成测试因未配置测试 URL 跳过；持久 Agent 收据、执行中取消及 HTTP/SSE Run 尚未验收。 |
| `files/transfer_tools.py` | `send_file` | 无 | 否 | 部分实现（Core 工具已经由 Web Agent 生产 Registry 暴露；Host 按当前 lease owner 从正式文件库解析，并在 URL 图片暂存前复查 owner/session/run/token/fence。Host adapter 经临时 SQLite、真实临时文件及 Registry dispatch 验证 owner 文件读取、路径越界拒绝、失效 lease 无暂存副作用；图片响应和附件暂存使用合成依赖。真实 PostgreSQL、IM 投递及完整 HTTP/SSE Run 未验收） |
| `files/transfer_tools.py` | `present_file` | 无 | 否 | 部分实现：Core 文件工具组、生产 Web per-lease Registry/授权和 Main 装配已接通；只按当前 owner 的文件 ID、已登记逻辑路径或名称解析，并返回当前网页预览消费者需要的标识。Core `files.test.ts` **70/70**、Host owner/路径/参数/授权 dispatch **1/1**、生产授权端口发现/执行租约复验 **22/22**。使用合成 Pool 和文件清单；真实 PostgreSQL 与完整 HTTP/SSE Run 尚未验收。 |
| `files/transfer_tools.py` | `list_recent_attachments` | 无 | 否 | 已完成并接入 Web：Core 文件组工具经真实 ToolRegistry dispatch 调用 per-lease Host adapter；列出 owner 草稿和当前会话最近附件的展示元数据，不返回正文或存储路径。Host **2/2** 覆盖字段/年龄格式、owner/session/run 隔离、非 Web 来源和取消；生产授权配置另有定向回归。Pool 使用合成对象；没有重复执行完整 PostgreSQL/Redis/HTTP-SSE 主链。 |
| `files/transfer_tools.py` | `save_uploaded_file` | 无 | 否 | 部分实现（Core 文件组及 Web production Registry 已接入；Host 按当前 lease 读取附件并复用上传配额、事务、Undo 和持久收据，支持 latest、指定/批量 attach_id 与 personal/project 目标；workspace 目录由共享可信会话读取器解析，并在上传事务锁定会话后复核绑定。测试使用合成 Pool/上传服务和临时附件文件，真实 PostgreSQL 写入及完整 HTTP/SSE Run 未验收） |
| `global_search.py` | `global_search` | 无 | 否 | 已完成并接入 Web：正式 Agent Run 经共享 PostgreSQL 搜索服务按当前 lease owner 执行；即使 Provider 输入伪造 `owner_id`，隔离 PostgreSQL 仍只返回当前 owner 的指定来源结果。生产 HTTP/SSE 主链 **1/1**，Core `global-search.test.ts` **5/5**。 |
| `group_context.py` | `group_context_search` | 无 | 否 | 部分实现（Node 定时群任务已接入） |
| `im.py` | `react` | mood | 否 | 依赖阻塞：Core `agent/tools/im.ts` 固定目标为可信当前飞书消息，Host `tools/agent-im.ts` 校验当下消息、启用 Bot、取 token、发回应并回调标记。当前树没有实时 Node IM Gateway 调用方；接入前必须由 Gateway 注入当前消息和标记写入端口，不能从模型参数指定目标。 |
| `knowledge.py` | `read_knowledge` | 无 | 否 | 已完成并接入 Web：正式 Run 经 Node Worker 写入的 PostgreSQL 索引执行 owner BM25 搜索，按 ID 经 owner FS 返回完整 Markdown；异主检索与 ID 读取均隔离。主链 **1/1**、Core **8/8**、Host 知识/lease **16 通过、1 跳过**。 |
| `knowledge.py` | `save_knowledge` | title, content | 否 | 部分实现（main 按 lease 注入 owner-bound 原子 FS 写入及 freshness job；Host RAG resource factory 实际 dispatch 写入/更新/回读和 Python 知识/schema 基准已通过，生产 FS/PG/重启恢复未验收） |
| `knowledge.py` | `update_knowledge` | knowledge_id | 否 | 部分实现（main 按 lease 注入 owner-bound Markdown 更新及 freshness job；Host dispatch 与 Python 知识/schema 基准已通过，生产 FS/PG/重启恢复未验收） |
| `knowledge.py` | `delete_knowledge` | knowledge_id | 是 | 部分实现（生产 Linux Web Run 按持久确认开放，owner Markdown 软删除与 RAG 失效已进隔离 PostgreSQL 恢复用例；实际用户确认与 Provider 续轮待验收。本轮新增旧工具行为基线 `backend/tests/agent/knowledge/test_knowledge.py::test_delete_knowledge_tool_confirms_owner_target_before_tombstone_and_rag_event`，devserver **1/1**） |
| `link_buttons.py` | `send_link_buttons` | message, buttons | 否 | 部分实现（Web artifact 已接生产 Run；IM 平台投递/持久回执待接） |
| `mcp.py` | `manage_mcp_servers` | action | 是 | 部分实现 |
| `memory.py` | `remember` | 无 | 否 | 部分实现（Linux Node Web Run 按能力接入） |
| `memory.py` | `search_memory` | query | 否 | 部分实现（main RAG factory 按 lease 接入 owner scope、持久快照与可选 embedding；Host/Core dispatch 通过，IM group/member scope、真实 PG/Redis/Provider 与生产索引消费者未验收） |
| `meta.py` | `call_tool` | tool_name, arguments | 否 | 已完成并接入 Web：Core `tools/call-adapter.ts` 与 `run/tool-ports.ts` 在计划前有限解析目标，并于计划、分派和确认恢复时复核入口及目标的最新授权，目标沿正式 Schema/确认/注册路径执行，可信转发来源随检查点持久化，结果按原调用 ID 续轮。Node Core `tool-ports.test.ts`、`input-feedback.test.ts` 本轮 **21/21**，Python `test_tool_schema_security_contract.py -k call_tool` 本轮 **2/2**；正式 `startServer` HTTP/SSE 隔离 PostgreSQL/Redis 集成另已实际执行嵌套读取/写入并验证副作用和续轮（历史 **1/1**）。真实外部 Provider 与部署未验收。 |
| `meta.py` | `get_tool_schema` | tools | 否 | 已完成并接入 Web：生产 Run 按当前 lease registry 的授权 capabilities 执行 schema discovery；真实 HTTP/SSE discovery event 验证仅返回请求的授权工具 schema 名称。Core `note-reads.test.ts` **6/6**，真实生产 Host 集成 **1/1**；Python schema selection 近邻测试此前有通过记录，本轮未重跑 pytest。 |
| `meta.py` | `use_skill` | id | 否 | 已接入 Web；共享的单 Run 内置/用户 Skill 组合及 owner/来源复验位于 `packages/core/src/agent/skills/runtime.ts`，Node Host 仅注入租约 owner、owner-scoped 目录/正文读取和安全指纹。Web 与定时任务共用该 Core 入口；内置技能仍由 `packages/core/resources/skills/*.md` 的 Markdown head 自动发现注册。Core `builtin.test.ts` + 可移植边界 **10/10**，Web Skill 工具运行 **1/1**；Core build/typecheck 通过。Host 全量 typecheck 未通过，错误在并行的 `attachment-staging` / Admin / 测试契约改动及缺少 `silk-wasm`，非本次 Skill Runtime 文件。定时任务使用 Core 入口，但其依赖隔离 PostgreSQL 的 Host 专项回归本轮未运行。Python 基准 `backend/tests/agent/test_user_skills.py::test_use_skill_loads_owned_body_and_refreshes_digest` 本轮未运行。 |
| `meta.py` | `ask_user` | kind, title, body | 否 | 部分实现（Node Schema 只公开已实现的 choice/question；两者经生产 Web Run 持久恢复。user_sandbox 授权已接入可信 Host 提示、owner/session grant 查询及既有确认事务，但授权完整 HTTP/SSE + PG/Redis 调用链尚未验收；通用 form 不在 Node 契约中） |
| `note.py` | `note_search` | 无 | 否 | 已完成并接入 Web：生产 Run 真实调用 owner-scoped Mind reader；隔离 PG 中搜索命中己方笔记并排除异主正文。Core 笔记读取本轮 **6/6**，生产 HTTP/SSE/PG/Redis 集成 **1/1**；Python pytest 本轮未运行。 |
| `note.py` | `note_get` | node_id | 否 | 已完成并接入 Web：生产 Run 真实读取 owner 节点、逐行正文及物理行号；异主 node_id 返回安全 not-found 且不泄露标题/正文。Core 笔记读取本轮 **6/6**，生产 HTTP/SSE/PG/Redis 集成 **1/1**；Python pytest 本轮未运行。 |
| `note.py` | `note_create` | 无 | 否 | 已完成并接入 Web：正式 Node `startServer` Run 经 HTTP/SSE/ToolRegistry 创建 Markdown 笔记，隔离 PostgreSQL 回读 owner、Markdown、纯文本投影和初始版本。生产集成 **1/1**，Core `note-writes.test.ts` 与 `note-lifecycle.test.ts` 合计 **7/7**。 |
| `note.py` | `note_update` | node_id | 否 | 已完成并接入 Web：正式 Node `startServer` Run 追加 Markdown，隔离 PostgreSQL 回读正文及递增版本；Core 共享回归覆盖异主拒绝、收据重放、撤权、过期编辑和行编辑。生产集成 **1/1**，Core 两组 **7/7**。 |
| `note.py` | `note_delete` | node_id | 否 | 已完成并接入 Web：正式 Node Agent Run 对 owner 普通笔记执行软删，隔离 PostgreSQL 核对墓碑、递增版本和正文保留；Core 生命周期用例覆盖异主拒绝、收据重放、并发及取消。生产集成 **1/1**，Core 生命周期回归与写入组共 **7/7**。 |
| `note.py` | `note_restore` | node_id | 否 | 已完成并接入 Web：正式 Node Agent Run 按精确 node_id 恢复此前软删的 owner 普通笔记，核对墓碑清除、版本递增和正文不变；异主记录保持原状。生产集成 **1/1**，Core 生命周期回归与写入组共 **7/7**。 |
| `note.py` | `note_undo` | 无 | 否 | 已完成并接入 Web：正式 Node Agent Run 撤销 owner 最近创建的咕咕普通笔记，核对只软删该笔记、保留正文并递增版本；Core 生命周期用例覆盖最近目标选择、无目标错误与收据恢复。生产集成 **1/1**，Core 生命周期回归与写入组共 **7/7**。 |
| `overview.py` | `get_upcoming` | 无 | 否 | 已完成并接入 Web：真实生产 Run 从 Core owner 项目查询与 Host owner 日历 reader 读取，按可信账号时区计算日期范围并合并排序；隔离 PostgreSQL 回归验证 owner 事件可见、异主事件不可见。Python 旧行为测试此前 2/2 通过，本轮 Node 通过隔离 PostgreSQL/Redis 和环回合成 Provider 的真实 HTTP/SSE 调用链。 |
| `overview.py` | `get_dashboard_stats` | 无 | 否 | 已完成并接入 Web：生产 Run 使用可信时区和 Core owner-scoped PostgreSQL 聚合统计，真实结果续入 Provider 请求；覆盖项目/事件/文件/联系人计数和异主联系人隔离。 |
| `projects.py` | `list_projects` | 无 | 否 | 已完成并接入 Web：实际生产 Run 经可信 lease 调用 Core owner-scoped 项目服务，真实 PostgreSQL 结果续入 Provider 请求并验证异主项目不泄漏。Node 项目工具 12 项通过；Python 项目筛选与 owner 基准此前通过，本轮未重跑 pytest。 |
| `projects.py` | `update_project` | 无 | 否 | 已完成并接入 Web：真实生产 Run 按项目名称更新隔离 PostgreSQL 摘要并回读确认 owner 副作用；Core 持久修改回归此前通过，本轮 Host 主链已实测。Python 项目修改基准此前通过，本轮未重跑 pytest。 |
| `projects.py` | `create_project` | project_name, start_date, deadline | 否 | 已完成并接入 Web：生产 Run 实际创建项目并通过隔离 PostgreSQL 回读 owner、默认 pending 状态、高优先级和标准阶段；Core 项目工具回归 12 项通过，Python `test_project_tools.py` 创建/阶段/优先级等基准此前通过，本轮未重跑 pytest。 |
| `projects.py` | `set_color` | color | 否 | 已完成并接入 Web：真实生产 Run 传入语义色并在隔离 PostgreSQL 验证映射为既有渐变存储值；Core 项目修改回归此前通过，Python 色彩基准此前通过，本轮未重跑 pytest。 |

| `projects.py` | `archive_project` | 无 | 否 | 已完成并接入 Web：真实生产 Run 归档 owner 项目并在隔离 PostgreSQL 回读确认 archived 标记；Core Host 组合覆盖归档与取消归档，Python 归档行为此前通过，本轮未重跑 pytest。 |
| `projects.py` | `delete_project` | 无 | 是 | 已完成并接入 Web：生产 per-lease 工具端口将 Core 删除工具接入授权 Registry；Core 项目删除回归覆盖确认前无副作用、目标快照变化回滚、批量软删和调用收据重放。本轮 Host Run Registry 用隔离 SQLite 与合成 lease/确认凭据验证确认前保留项目、确认后软删及撤权拒绝。真实 PostgreSQL/Redis 交互恢复留待统一验收。 |
| `projects.py` | `get_project` | 无 | 否 | 已完成并接入 Web：生产 Run 经 Core owner reader 和 Host PostgreSQL 文件概览端口读取项目/文件数；异主 ID 返回不存在且不执行文件 reader。Host 隔离 PG **1/1**、主链集成 **1/1**；Python 项目详情此前 **7/7**，本轮未重跑 pytest。 |
| `projects.py` | `add_stage` | label | 否 | 已完成并接入 Web：生产 Run 创建项目后实际追加阶段，隔离 PostgreSQL 核对已提交阶段。Core durable stages/registry 回归此前通过，Python 默认 key 与插入顺序基准此前通过，本轮未重跑 pytest。 |
| `projects.py` | `remove_stage` | stage | 否 | 已完成并接入 Web：生产 Run 实际删除指定阶段并验证剩余阶段和待办仍在隔离 PostgreSQL；当前阶段回退语义由 Core/Python既有回归覆盖，本轮未重跑 pytest。 |
| `projects.py` | `rename_stage` | stage, new_label | 否 | 已完成并接入 Web：生产 Run 按唯一名称重命名阶段，随后按稳定 key 重排并保留阶段/待办；Node 与 Python 重名必须使用 key 的历史回归未在本轮重跑。 |
| `projects.py` | `update_stage` | 无 | 否 | 已完成并接入 Web：生产 Run 向指定阶段新增待办，之后 set_stages 保留其稳定 key 与待办身份；隔离 PostgreSQL 回读确认未完成状态，Node/Python 待办行为回归此前通过。 |
| `projects.py` | `set_stages` | stages | 否 | 已完成并接入 Web：生产 Run 以稳定 key 保留原阶段和待办身份、增加后再删除另一阶段；隔离 PostgreSQL 回读确认最后保留项及当前阶段回退，Node/Python重排和数据保留回归此前通过。 |
| `scheduled_tasks.py` | `list_scheduled_tasks` | 无 | 否 | 已完成并接入 Web：真实 Agent Run 经 owner-scoped PostgreSQL reader 和可信 workspace/filesystem 能力投影；结果只含 owner 的独立任务，不含日历提醒或异主任务。Core 定时任务/工具测试 **3 文件 7/7**，生产 HTTP/SSE/PG/Redis 集成 **1/1**；Python pytest 本轮未运行。 |
| `scheduled_tasks.py` | `create_scheduled_task` | schedule_name, instruction, schedule_kind | 是 | 已完成并接入 Web：正式 Node Agent Run 经 HTTP/SSE、ToolRegistry 和一次性 Worker 能力创建停用的一次性 owner 任务；隔离 PostgreSQL 回读名称、指令、渠道、时间和停用状态，避免测试任务被执行。生产主链 **1/1**，Host `task-writes-postgres.test.ts` **4/4**，Core 定时工具 **1/1**。 |
| `scheduled_tasks.py` | `update_scheduled_task` | 无 | 是 | 已完成并接入 Web：正式 Node Agent Run 按 owner task_id 更新名称和指令，并验证既有停用状态与投递渠道保持；Host 隔离 PostgreSQL 回归覆盖目标锁定、撤权、重放和 Worker 消费 **4/4**，Core 定时工具 **1/1**。生产主链 **1/1**。 |
| `scheduled_tasks.py` | `delete_scheduled_task` | 无 | 是 | 已完成并接入 Web：正式生产 Run 经持久确认 token 恢复，确认前无副作用，确认后删除 owner 独立任务；隔离 PG 回归覆盖回滚、收据重放及 RAG 索引清理，主链验证 Redis 资源版本通知。 |
| `search.py` | `web_search` | 无 | 否 | 已完成并接入 Web：`main.ts` 按 lease 调用 Host 搜索端口并交给生产工具 Registry；Node AgentRunner 回归验证合成搜索结果进入下一轮 Provider 上下文。Host `agent-search.test.ts` **5 通过、1 跳过**（跳过项需隔离 PostgreSQL，属于付费深度/图片搜索额度用例）；本工具测试使用合成 transport，不调用真实 Provider 或公网。 |
| `search.py` | `similar_image_search` | 无 | 否 | 部分实现：Core 与 Web production Registry/Run 端口可在账号凭据、附件存储和 Node `search-usage` 迁移具备时实际调用；迁移未应用、配置不可用或无凭据时不注册。Host 付费外呼/持久额度测试使用隔离 PostgreSQL、临时图片和合成 transport，真实 Provider/公网/部署留待统一验收。 |
| `search.py` | `deep_research` | query | 否 | 部分实现：Core 与 Web production Registry/Run 端口可在账号或平台凭据及 Node `search-usage` 迁移具备时实际调用；迁移未应用、配置不可用或无凭据时不注册。Host 配额、owner/run 授权、持久结果/未知结果不重发回归使用隔离 PostgreSQL 与合成 Provider transport；真实付费 Provider/公网/部署留待统一验收。 |
| `shell.py` | `shell` | command | 是 | 退役/重设计（工具保留，真实隔离后端待验收） |
| `skill_management.py` | `list_skills` | 无 | 否 | 已完成并接入 Web：Node owner metadata reader 将 Markdown head 的内置技能和当前 owner 用户技能目录返回模型；生产 Run 验证 S7 元数据、enabled/source 且不返回 body。Core Markdown 扫描/注册 **2/2**，Host 技能端口 **1/1**，生产 HTTP/SSE 主链 **1/1**。 |
| `skill_management.py` | `create_skill` | skill_name, description_short, body, related_tools, managed_by | 否 | 已完成并接入 Web：正式 `startServer` Run 经 HTTP/SSE、生产 ToolRegistry 与可信 lease 创建用户 Skill，隔离 PostgreSQL 回读 owner、稳定 ID、`managed_by`、enabled 和完整 Markdown 正文；`use_skill` 后续 Provider 请求已读到正文。生产主链 **1/1**，Core `skill-management.test.ts` 与 `user-management-sqlite.test.ts` **3/3**；Provider 为合成端点，真实部署未验收。 |
| `skill_management.py` | `update_skill` | id | 否 | 已完成并接入 Web：正式 `startServer` Run 经 HTTP/SSE、生产 ToolRegistry 与可信 lease 更新 owner Skill，隔离 PostgreSQL 回读稳定 ID、管理来源、enabled 和完整 Markdown 正文；后续 `use_skill` Provider 请求读取更新正文。生产主链 **1/1**，Core `skill-management.test.ts` 与 `user-management-sqlite.test.ts` **3/3**；Provider 为合成端点，真实部署未验收。 |
| `skill_management.py` | `delete_skill` | id | 是 | 已完成并接入 Web：生产 Run 经持久确认 token 恢复，确认前不删，确认后 owner Skill 删除与操作收据提交；Redis 技能资源版本更新。Core `skill-management.test.ts` **2/2**，隔离生产主链 **1/1**。 |
| `time.py` | `get_current_time` | 无 | 否 | 已完成并接入 Web：生产 Run 经 Core 注册器实际分派，时区从 PostgreSQL 的 owner 偏好读取；模型传入 `timezone=UTC` 仍返回可信账号的 Asia/Tokyo。结果日期、星期、时分秒结构经真实 Provider 续轮检查。历史 Python `test_time_tool.py` 1/1 已通过；本次 Node 验收为隔离 PostgreSQL/Redis 和环回合成 Provider。 |
| `trash.py` | `list_trash` | 无 | 否 | 已完成并接入 Web：真实 Agent Run 经 Host PostgreSQL 回收站 reader 返回 owner 的软删除文件；异主文件不进入 Provider 续轮，时间戳保留微秒。Core `trash.test.ts` **4/4**，生产 HTTP/SSE/PG/Redis 集成 **1/1**；Python 回收站 pytest 曾在隔离临时环境 **1/1** 通过，本轮未重跑。 |
| `trash.py` | `restore_file` | file_id | 否 | 已完成并接入 Web：真实 Agent Run 经 PostgreSQL 与临时存储恢复 owner 文件并清除软删除状态；Host PG/临时磁盘回归覆盖异主拒绝、目录回收站边界、重复/并发/未知结果不重做。生产 HTTP/SSE/PG/Redis **1/1**，Host 恢复事务测试 **1/1**；Python pytest 本轮未运行。 |
| `trash.py` | `restore_folder` | folder_id | 否 | 已完成并接入 Web：真实 Agent Run 恢复 owner 顶层文件夹及其子文件，隔离 PostgreSQL 回读墓碑并检查临时物理路径；Host PG/临时磁盘回归覆盖异主、墓碑时间与收据重建。生产 HTTP/SSE/PG/Redis **1/1**，Host 恢复事务测试 **1/1**；Python pytest 本轮未运行。 |
| `trash.py` | `permanent_delete` | 无 | 是 | 部分实现：Core 确认门、Web per-lease Registry/授权及 Main 的 Node Worker 接线已具备；确认预留保存目标快照，Host 用稳定操作 ID 在 PostgreSQL 同事务关联 purge job，恢复时可补建尚未提交的 job 或读取已提交 job；当前快照变化会拒绝新建任务。Core ToolRegistry/确认行为 **6/6**、Host adapter/恢复行为 **7 通过、2 个隔离 PostgreSQL 用例跳过**。测试使用临时 SQLite 收据与合成 lease/Pool/确认/job 端口；真实 PostgreSQL/Redis 唤醒和完整 HTTP/SSE Run 未验收。 |
| `undo.py` | `undo_last_action` | 无 | 否 | 部分实现：Core/Host Node 工具经生产 per-lease 注册和授权接入现有 Undo 状态机，固定本 Agent Run 的操作目标并写入持久选择/结果收据；Main 为 Agent 与 Web Undo 注入既有项目回收存储和安全目录移动端口，`projects` 资源已由 Agent 工具转入该状态机执行，不再被端口硬拒绝。Core 工具回归 **2/2**；本次 Host 工具路由与项目 Undo 定向回归 **4/4**。项目撤销状态机使用临时 SQLite/真实临时文件系统用例覆盖；真实 PostgreSQL/Redis 与完整 HTTP/SSE Run 未验收。 |
| `web.py` | `http_get` | 无 | 否 | 部分实现：生产 Web Run 经安全公网 GET 端口、Core 注册器与 lease 授权实际分派；Core 使用 `pdfjs-dist` 提取 PDF，并按旧结果形状返回正文、截断和总字符数，遵守旧文档提取 200,000 字符上限。devserver `packages/core/tests/agent/tools/web.test.ts` **17/17**、Core build 通过，覆盖 HTTP 请求契约、PDF 成功/损坏输入/字符上限、取消、HTML 与下载行为；旧 `backend/agent/tools/web.py` 的 PDF 提取实现作为行为参考，`test_io_retry_contract.py -k http_get` 本轮因 devserver 未安装 pytest 未运行，且现有 pytest 无专门 PDF 用例。真实外网/生产环境验收仍缺。 |
| `web.py` | `web_download` | url | 否 | 已完成并接入 Web：安全公网出站、租约复核、默认/显式工作区落点、容量限制、owner PostgreSQL/Local 文件写入与收据恢复已接入；进程异常遗留的暂存由首次下载时清理当前 Unix 用户拥有且超过 24 小时的工具目录。定向清理回归验证近期目录与符号链接目标保留；真实公网与生产部署留待统一验收。 |
| `workspaces.py` | `delete_workspace_directory` | directory_id | 是 | 部分实现：Core 确认门、持久收据恢复和 Web per-lease 注册/授权/Main 装配已接通；复用现有目录预览与物理删除服务，执行前复核计数快照。Core 工作区 ToolRegistry **9/9**，Host 授权/注册/目录删除回归 **51/51**，Web Host production typecheck 通过。测试使用临时 SQLite 收据、合成 lease/Pool、确认凭据和目录操作端口；真实 PG/Redis 与完整 HTTP/SSE Run 未验收。 |
| `workspaces.py` | `list_workspaces` | 无 | 否 | 已完成并接入 Web：生产 Run 经 Core owner-scoped PostgreSQL reader 返回账号默认工作区，结果进入 Provider 后续请求；Core/Host workspace owner 与停用项行为测试此前通过。 |
| `workspaces.py` | `get_workspace` | workspace_id | 否 | 已完成并接入 Web：生产 Run 使用数据库中账号自己的 workspace_id 读取详情并续入 Provider；Core/Host 测试覆盖异主资源“不存在”语义，本轮真实集成验证默认目录详情。 |
| `workspaces.py` | `create_workspace` | workspace_name, kind | 否 | 部分实现：Core 工具、Web Host per-lease 注册/授权和 Main 装配已接通；项目/文件夹声明复用 PostgreSQL workspace creator，顶层目录复用正式目录创建服务，完成后通过共享 workspace reader 返回结果。Core ToolRegistry **3/3**、Host Registry→lease→持久 SQLite 收据端口 **4/4**；结果重放只读回执，未知提交保留 reservation，不能重做创建，并发同调用最多执行一次。Host 领域服务、Pool/lease 使用合成依赖；真实 PostgreSQL 与完整 HTTP/SSE Run 尚未验收。 |
| `workspaces.py` | `update_workspace` | 无 | 否 | 已完成并接入 Web：生产 Agent Run 经 Core 声明更新事务同步工作区/目录显示名，保持物理目录键不变；隔离 PostgreSQL 回读确认持久副作用。Core 工作区工具行为在本轮对应批次通过，生产 HTTP/SSE/PG/Redis 集成 **1/1**；Python pytest 本轮未运行。 |
| `workspaces.py` | `unlink_workspace` | workspace_id | 是 | 部分实现：Core 持久收据与确认门、Web lease 授权及生产 Main 注册已接入；临时 SQLite 行为回归 2/2、Host 授权回归 21/21。未验收真实 PG/Redis 确认恢复与完整 HTTP/SSE Run。 |

### 日历与画布七项待迁移工具复核（2026-11-17）

生产接线复核：`createWebAgentRagRunAuthorization` 当前只配置并授权 `search_conversations`、`search_memory`；即使把七项端口传入 registry，Web Run 准备阶段也不会发现它们。须由可信 Run 配置与授权同时开放实际具备能力的工具，并在执行时重新验证 lease。现有 `createScheduledTaskDeliveryTargets` 只列出用户可选的群和私聊可用性，不生成日历提醒所需的可信投递目标；不能直接作为提醒 resolver。旧 Python 对 QQ 群的提醒要求明确选择群聊或私聊，选择当前群时从可信 IM 上下文取群标识，并按需补入 QQ 渠道；Web Run 没有该群上下文时须拒绝当前群投递。上述是源码核对，尚未构成生产接线或真实服务验收。

Web 提醒目标增量：`apps/web-host/src/modules/agent-sessions/tools/agent-calendar-reminder-targets.ts` 复用定时任务的 owner 私聊目标解析，在解析前后验证 Web dispatch lease，拒绝其他运行身份及缺少群上下文的当前群请求。devserver 测试前核对源码与用例哈希一致；`agent-calendar-reminder-targets.test.ts` **2/2 通过**，覆盖私聊、错身份、群目标、过期 lease、解析期间 lease 失效及取消传播。Mutagen 有冲突，未 flush。此端口尚未装配到生产 Agent Run；devserver Python Worker 的提醒消费行为已确认，但 Node Host 与 Worker 共用数据库以及真实 PostgreSQL/Redis 仍未验收。

`apps/web-host/src/modules/agent-sessions/tools/agent-calendar-write-ports.ts` 将提醒解析与 Core 事件读取、创建、更新端口组合，要求 Host 注入同一 lease、定时任务目标解析和提交后发布器。当前 `main.ts` 已在 per-lease resource factory 调用该组合并允许 `create_event`/`update_event` 进入生产 Web registry；真实 PostgreSQL、提醒投递消费者与 Provider 后续轮仍未验收。

新增 `apps/web-host/tests/agent/agent-calendar-write-ports.test.ts`，计划经 Host 组合入口和 registry dispatch 验证临时 SQLite 的事件与提醒创建、更新、通知及撤权；使用合成 lease 和投递端口。devserver 同步冲突尚未解除，测试未运行，不能作为通过证据。

确认接线契约增量：`ConfirmationGatePorts.prepare` 现在可接收领域解析的固定目标 ID；日历删除及四项画布操作提供对应目标和级联集合，确认门在异步授权前复制并冻结 ID。新增确认门回归尚未运行。Host 仍须持久保存目标及摘要，并按原目标重算当前版本、在业务事务内锁定和单次认领。既有 `agent_interaction_resumes` 的 receipt 是 prompt 恢复引用，不能充当业务事务 claim；现有危险工具继续保持未装配。

新增领域目标回归：日历批量删除检查排序后的事件及提醒 ID，画布批量便签删除检查便签和视图 ID。`agent_interaction_intents` 加密存储现可附带 Core 确认意图与固定目标，读写时验证运行、工具调用、交互、摘要、展示目标及有效期；相应隔离 PostgreSQL 回归已补充但未运行。该存储尚未接到确认门，业务事务内复核和单次认领也尚未实现；上述新回归因 devserver 同步冲突未运行。

确认恢复入口现复制目标快照及交互回答，避免等待授权或存储时调用方改变当前核验输入；新增异步变更回归尚未运行。该快照不替代事务内重新读取目标与 claim。

确认描述兼容空级联集合：完整目标快照仍保留空数组，生成旧确认身份时仅传非空目标，并将完整目标摘要和版本摘要加入确认上下文，避免无提醒的事件或无关联的画布因空集合被拒绝。新增回归尚未运行；该修复不代表确认门或事务 claim 已装配。

加密意图存储新增按完整 owner/session/run/round/tool call/规范化输入摘要恢复确认意图的入口；回归覆盖不同 owner、轮次和输入摘要的拒绝。该入口只恢复可信记录，仍须验证用户确认收据并在业务事务内复核目标及 claim；隔离 PostgreSQL 回归因同步冲突尚未运行。

确认收据读取增量：`loadApprovedOperation` 将加密意图与同一 owner/session/run 的持久 prompt 绑定、已消费确认动作和恢复收据关联，检查批准状态及有效期；补充成功、伪造收据和未消费动作回归，均尚未运行。此读取不认领业务操作，确认门与事务 claim 仍未接入。

收据读取还要求确认结果为真、动作包含与 prompt 一致的非空确认码及匹配的工具名称，防止未兑换确认码的普通确认状态被当作批准；新增缺失确认码回归尚未运行。

确认收据的有效期取意图、prompt 与确认动作三者的最早截止时间，并拒绝已过期动作；相应 PostgreSQL 回归已补充，未运行。

加密意图读取新增交互类型一致性检查；devserver 定向文件 **2 通过、1 跳过**。通过项使用合成数据库客户端验证加密往返、跨轮次拒绝和交互类型隔离，以及空目标集合确认描述；隔离 PostgreSQL 连接未配置且服务器工具不可用，真实 SQL 收据查询用例跳过，不代表 PostgreSQL 验收。

日历删除在事务内 claim 后按固定事件 ID 重新计算事件及提醒快照，变化则抛错回滚；新增 claim 期间提醒变更的回归尚未运行。旧 Python 和 Core schema 的 `scheduled_tasks.event_id` 均无事件外键，事件行锁不能阻止其他事务插入新提醒；仍需所有提醒写入者采用统一锁或其他经验证的并发协议，不能将此次检查当作完整 PostgreSQL 幻读防护。

独立画布便签删除及包含便签删除的批处理也在事务内 claim 后重新读取便签和视图快照；目标变化时回滚，新增两种调用路径回归尚未运行。该检查不替代对并发新增视图的数据库锁协议，也不代表确认 claim 已生产装配。

画布关系断开和画布级联删除现也在事务 claim 后复查固定目标及其快照；补充 claim 期间修改关系或画布后回滚的回归，尚未运行。这些检查仍须配合完整并发锁协议与真实持久 claim。

本轮 devserver 定向验证：确认、日历删除与画布编辑三个 Core 文件 **48/48 通过**；Host 日历目标、写端口和确认描述三个文件 **4 通过、1 跳过、0 失败**，跳过项需要显式配置隔离 PostgreSQL。测试使用临时 SQLite、合成 lease/确认/投递端口和临时 Vitest 配置；目标源码与测试哈希在运行前两端一致。Host 调用已有 Core dist，未重新构建或核对其与源码一致，因此不用于验证本轮 Core 修改。Mutagen 的三个冲突属于旧目录构建产物，未 flush 或覆盖。该结果不证明真实 PostgreSQL、Redis、提醒消费者或生产 Agent Run 已验收，事务并发锁协议和生产 claim 仍待完成。

确认门事务引用现在包含完整可信运行绑定、交互 ID 和收据 ID，供未来事务内重新核验批准记录；引用本身不授予权限。devserver 目标源码与用例哈希一致后，确认、日历删除和画布编辑回归重跑 **48/48 通过**，Core `typecheck` 通过；测试使用临时 SQLite 与合成确认端口，生产 claim 仍未装配。

本次 Goal 只处理以下七项；当前 `main.ts` 已按 lease 装配删除端口、可信确认及交互恢复，但真实 PostgreSQL/Redis/Provider 运行仍未验收，故按部分实现统计：

当前树定向复验：Core `calendar-create.test.ts`、`calendar-update.test.ts`、`calendar-delete.test.ts`、`canvas-edits.test.ts`、`confirmation.test.ts` 历史记录为 **54/54 通过**。本轮重新构建 Core 成功；Host 确认授权、画布端口、注册器、Core Chat wake、交互响应/消费六文件 **56 通过、2 个 PostgreSQL 用例跳过、0 失败**。其中确认授权测试验证 fence 递增后权限 epoch 稳定，而活动执行 lease 仍按新 token/fence 复核。旧 Python 行为基准日历/提醒/画布/删除撤销/创建幂等七文件 **66/66 通过**，fixtures 使用每测试内存 SQLite、fakeredis 与临时存储；测试及旧 Python 实现哈希与 devserver 一致。Host production `tsc -p tsconfig.build.json --noEmit` 当前仅报并行终端模块 `ws` 声明及其隐式参数错误；本轮 `main.ts`、确认、交互和画布接线文件无诊断。真实 PG/Redis/Provider、提醒消费者和跨进程恢复未验收。

| 工具 | Python 行为基准 | Node 现有实现与具体缺口 | 状态 |
| --- | --- | --- | --- |
| `create_event` | `backend/tests/scheduling/calendar/test_calendar_tools.py::test_create_event_shapes_and_inline_reminders`、`backend/tests/api/test_create_idempotency.py` | `packages/core/src/agent/tools/calendar.ts` 注册 Core 创建端口；`event-create.ts`、`create-store.ts` 同事务保存事件、提醒、RAG job、Undo 和调用收据。`main.ts` 为每个可信 lease 注入该端口和 owner 受限提醒目标解析，并允许该工具进入 Web registry。Node 与 Python 行为回归通过（见复验记录）；真实 PostgreSQL 写入、提醒消费者与外部 Provider 后续轮尚未验收。 | 生产 Run 代码路径已接入；真实存储/投递验收待完成 |
| `update_event` | `backend/tests/scheduling/calendar/test_calendar_tools.py::test_update_event_validations_and_apply`、`backend/tests/scheduling/events/test_event_atomic_update.py`、`backend/tests/scheduling/events/test_event_update_reminders.py` | `packages/core/src/agent/tools/calendar.ts` 提供 ID/标题/日期定位、无字段与 `all_day` 校验、可信 owner 目标解析、当前版本 CAS、幂等收据和结果映射；`event-update.ts`、`mutation-store.ts` 复用同事务事件更新、提醒自动改期/整体替换、Undo、RAG job 与提交后通知。`main.ts` 已为可信 lease 注入该端口并允许进入 Web registry。Node 与 Python 行为回归通过（见复验记录）；真实 PostgreSQL、提醒投递与 Provider 后续轮尚未验收。 | 生产 Run 代码路径已接入；真实存储/投递验收待完成 |
| `delete_event` | `backend/tests/scheduling/calendar/test_calendar_tools.py::test_delete_event_single_blocked_then_confirmed`、`test_delete_event_batch_validation_and_confirmed`、`backend/tests/agent/test_agent_delete_undo.py` | Core 事件目标快照、确认 gate、事务内 claim、软删/提醒停用、Undo 和收据已实现；`main.ts` 按 lease 注入日历删除端口、独立 action 确认和现有 publisher。交互激活/投影/响应已接入；Node 六文件组合回归 **56 通过、2 个 PG 用例跳过、0 失败**。确认恢复的真实 PG/Redis、提醒消费者和 Provider Run 未验收。 | 部分实现；生产存储与投递待验收 |
| `canvas_delete` | `backend/tests/mind/test_mind_canvas_gaps.py::test_canvas_delete_batch_and_single_with_confirmation` | Core 级联删除服务实现 owner 过滤、目标/版本快照、事务内 claim、操作收据和整批回滚；`main.ts` 仅在确认密钥可用时按 lease 注入独立 action gate 与 Mind publisher。真实 PG/Redis 确认恢复和 Provider Run 未验收。 | 部分实现；确认恢复待验收 |
| `canvas_delete_note` | `backend/tests/mind/test_mind_canvas_gaps.py::test_canvas_batch_guards_and_delete_note_confirmation`、`backend/tests/mind/test_mind_canvas_tools.py` 中便笺删除/恢复用例 | Core 复用 `applyCanvasEdits` 和 Mind 删除服务，固定 owner、目标版本及存活视图项；最多 20 项，保留事务 Undo、视图清理与收据重放。`main.ts` 注入独立 action gate 和 Mind publisher；真实 PG/Redis 确认恢复与 Provider Run 未验收。 | 部分实现；确认恢复待验收 |
| `canvas_disconnect` | `backend/tests/mind/test_mind_canvas_gaps.py::test_canvas_disconnect_batch_validation_and_confirmed` | Core 关系删除服务支持单项/最多 50 项有序批量、owner/画布过滤、目标快照、事务 claim、收据和原子回滚；Host 按 lease 注入独立 action gate 与 relation publisher。真实 PG/Redis 确认恢复和 Provider Run 未验收。 | 部分实现；确认恢复待验收 |
| `canvas_batch` | `backend/tests/mind/test_mind_canvas_gaps.py::test_canvas_batch_guards_and_delete_note_confirmation`、`backend/tests/mind/test_mind_canvas_tools.py` 中批量操作用例、`backend/app/services/canvas/batch.py` | Core 实现 20 项有序批操作、owner/画布校验、request_id 收据重放、整批回滚及删除便笺确认；Host 按 lease 注入独立 action gate 和 Mind publisher。真实 PG/Redis 确认恢复与 Provider Run 未验收。 | 部分实现；确认恢复待验收 |


2026-11-17 日历/画布七项当前树复验：旧 Python 基准在 devserver 的临时 Python 3.12 venv、隔离空环境/配置路径下串行运行日历工具、事件原子更新/提醒、Mind Canvas gaps 与画布工具 **60/60 通过**；另运行事件创建幂等和日历删除恢复用例 **3/3 通过**，合计 **63/63**。pytest fixtures 使用内存 SQLite、fakeredis 和临时存储，不读取运行配置或真实用户数据。Node Core build/typecheck 通过；目标 Core Vitest **8 文件、59 通过、3 跳过、0 失败**，跳过为未配置隔离 PostgreSQL URL 的子用例；Host `agent-tool-registry.test.ts` **25/25**。确认 gate、事务 claim 和提醒目标 resolver 使用合成端口，未连接真实 PG、平台投递或生产 Agent Run。生产 `main.ts` 仍无 Agent Run/reconstructor caller；破坏性工具仅在可信持久确认 gate 与事务 claim 同时提供时注册，生产端口未接入，不能开放调用。

本次 devserver Core 回归：先前 `canvas-edits.test.ts`、`canvas-placement.test.ts`、`note-lifecycle.test.ts`、`confirmation.test.ts` 共 **44/44 通过**；之前定向 `canvas-edits.test.ts` 与 `confirmation.test.ts` **34/34 通过**；本轮含 `canvas_delete_note`、`canvas_disconnect` 和 `canvas_delete` 的重跑 **37/37 通过**。新增 `calendar-delete.test.ts` 经临时 Vitest 配置 **4/4 通过**，验证标题/日期选择、候选歧义、二次确认前无副作用、SQLite 同事务批删、提醒停用、聚合Undo、owner隔离、并发版本变化拒绝、claim拒绝回滚、撤权和收据重放。Core build/typecheck 通过；合并日历/画布/确认/日历事务用例 **42/42 通过，另 1 个 PostgreSQL 子测试因未配置连接而跳过**；Host registry 测试 **23/23 通过**。确认门测试使用合成gate/claim，不代表生产Host确认已接入。日历 `create-store.test.ts`、`mutation-store.test.ts` 不在默认 Vitest 套件登记；之前通过 `/tmp` 临时 Vitest 配置运行后 **3 项通过、2 项 PostgreSQL 子测试跳过、0 项失败**，只验证 SQLite/shared store 能力，不是 Agent 工具行为回归。测试启动曾被并行工作新增的 `tests/mcp/server-config-sqlite.test.ts` 未登记拦截；未修改其文件或清单项，本次使用只含目标用例的临时 Vitest 配置。对应 Python `backend/.venv/bin/pytest` 不存在，因此本轮 Python pytest **未运行**。生产 Agent Run 目前也没有调用 `createAgentToolRegistry` 的聊天/dispatch 接线，`main.ts` 中使用宽授权的注册器仅用于技能目录发现，不是生产工具执行入口。

同轮 `@gugu/core` build 通过；Host 注册器 `agent-tool-registry.test.ts` **19/19 通过**，其中确认 gate 是合成端口，只验证“缺确认能力不注册、权限撤销后隐藏”；Core 类型检查通过。Web Host 全量 `tsc` 未通过，返回 **93 条既有工作区诊断**（含 MCP 客户端依赖解析失败和其他 Admin/Agent/MCP 测试类型不匹配）；诊断未涉及本轮修改的 Host 注册器及测试。完整 Python 基准仍未运行，不能标为旧 pytest parity 通过。

2026-11-17 `create_event` devserver 复验：Core build/typecheck 通过；临时 Vitest 配置下 `calendar-create.test.ts` 3/3、`calendar-delete.test.ts` 4/4、`canvas-edits.test.ts` 13/13、`confirmation.test.ts` 24/24、`builtin.test.ts` 8/8，合计 **52/52**；Host `agent-tool-registry.test.ts` **24/24**。测试数据使用临时 SQLite 和合成 owner；提醒目标 resolver 是测试替身，只证明 Core/ToolRegistry 契约，不是生产平台投递接入。Python pytest 未运行。

2026-11-17 `update_event` devserver 回归：Core build/typecheck 通过；包含创建、更新、删除、画布编辑、确认、Markdown Skill、Calendar Store 的临时 Vitest 配置共 **59 项通过、3 项跳过、0 失败**；跳过项为未配置隔离 PostgreSQL URL 的子测试。Host `agent-tool-registry.test.ts` **25/25**。新增测试数据均为临时 SQLite 与合成 owner。生产 Agent Run、Host 平台提醒目标解析及 Python pytest 未验收/未运行。

2026-11-17 生产接线复核及 Host 端口回归：当前 `apps/web-host/src/main.ts` 仍未创建 `AgentChatService`、`createWebAgentReconstructor` 或 dispatch worker/supervisor，也未向 `createApp` 提供 Agent Chat/interaction service；`createWebAgentRagRunAuthorization` 默认只授权 `search_conversations` 与 `search_memory`。本轮给它增加了一个仅接受七个目标工具名的 Host 显式开关，并继续在发现和每次执行时核验当前 owner/session/run 与有效 dispatch lease；该选项目前没有生产调用方，因此七项日历/画布写工具仍没有生产发现或执行调用链。Core `createConfirmationGate`、Host 加密意图存储和交互描述/激活零件分别存在，但当前没有 Host 组合器把它们接入工具执行；`createPostgresTrustedIntentStore.saveIntent` 没有生产调用方。工具授权、持久确认和事务内再授权不可由零件存在推定完成。`main.ts` 还没有启动一次性/重复定时任务 poller；已有 `createRepeatingPoller` 明确标记为实验实现，不可装配生产。Python `gugu-worker` 在 devserver 当前为 active/running；旧 `scheduled_tasks.reconcile()` 会将所有启用且未运行的一次性任务挂入 APScheduler，`execute_task()` 按任务渠道调用 Agent 和实际投递器，未按 `event_id` 排除事件提醒。Node `insertCalendarEventReminder()` 写入 `user_id/event_id/start_at/schedule_kind='once'/channels/delivery_targets` 对应字段。但 devserver 没有运行中的 Node Web Host service，Node Host 与 Python Worker 数据库实例是否相同未验证，所以不能据此认定 Node 创建的提醒已有生产消费者。目标 Host 源码与测试哈希和本地完全一致后，串行运行日历写端口、画布写端口、可信确认存储和 Reconstructor 回归：**6 项通过、3 项跳过、0 失败**；跳过项需隔离 PostgreSQL 与 Redis。通过项使用临时 SQLite、合成确认/lease；不证明真实事务 claim、跨端共享提醒消费者、Redis、PostgreSQL 或生产 Run 已验收。现有端口在 registry 未注入可信确认 gate 时隐藏删除/画布破坏工具；Host 确认和 Agent Run 生产装配仍待实现，因此保持未接入。

Web RAG/Run 端口回归在 devserver **7/7 通过**，包含新增“Host 显式启用日历/画布名称、按当前 lease 逐次授权、配置外工具/身份漂移/租约失效拒绝”用例；Web Host production `tsconfig.build.json --noEmit` 通过。用例使用合成 lease 和临时 SQLite，不验收真实 PostgreSQL、Redis、确认收据或生产调用方。

2026-11-17 当前树追加目标行为复验：先核对 Core/Host 实现、定向用例和确认存储文件的 devserver SHA-256 与工作区一致，再在 devserver 重建 Core。Core 日历创建/更新/删除、画布批量编辑和确认 **5 文件、54/54 通过**；Host 提醒目标、日历写端口、画布写端口与可信意图/提示 **6 通过、2 跳过、0 失败**，两项跳过均需隔离 PostgreSQL。覆盖实际日历注册器 dispatch 的事件/提醒创建更新、撤权拒绝，及无确认端口时危险画布工具不注册；合成 SQLite/lease/投递能力不证明 PostgreSQL claim。此前运行中失败的终态投影用例恢复真实 Host 投影后通过。Python 本轮未重跑；既有旧 Python 基准见上方记录。`main.ts` 仍无 Agent Chat/Reconstructor/dispatch caller，Node Web Host service 未部署运行，Node 与 Python 提醒消费者共享数据库也未验证，故七项仍不是生产 Run 已接入。

### Prompt Skill Markdown 资源目录约定（2026-11-17）

此项是 `backend/agent/skills/*.md` 的 Prompt Skill 资源加载，不属于 `backend/agent/tools/` 的 `BaseSkill` 工具组盘点。Core Markdown 放在 `packages/core/resources/skills/*.md`；`scripts/build-skills.mjs` 自动扫描该目录的 `.md` 文件，跳过 `README.md`，通过 frontmatter 的 `id` 和元数据生成 bundled 文档及注册项，不读取 `manifest.json`。源码与资源目录统一使用 `skills` 命名。devserver `builtin.test.ts` **8/8 通过**，覆盖无清单自动发现、头部注册、重复 ID 拒绝和正文按需重读。该回归不代表 Python BaseSkill 工具迁移或生产 Agent Run 接线完成。

2026-11-17 Host Skills 模块命名收口：Web Host 相关源码和测试统一放在 `modules/skills/`、`tests/skills/`；目录工厂统一为 `createSkillToolCatalog`，路由/API 行为不变。devserver Node 26.13 对 4 个相关行为测试文件运行，**3 项通过、1 个文件加载失败**；失败文件 `user-list.test.ts` 在导入 `app.ts` 时因 devserver 缺少 `@modelcontextprotocol/client` 依赖未执行，不计通过。其他并行 Mutagen 冲突未处理。

## 领域依赖、既有实现与 Python 回归入口

以下为最相关入口而非全部传递依赖。pytest 路径相对 `backend/tests/`；各工具的实际回归结果按对应切片记录，不由共享服务/端口存在推定通过。

| 工具领域 | 现有 Node 入口与剩余依赖 | Python 基准/重点回归 |
| --- | --- | --- |
| 时间 | 可直接注入时钟和可信请求时区；需真实 ToolPort 参数/权限/结果调用回归 | `agent/test_time_tool.py`：日期、星期、时分秒；补时区跨日/DST/非法时区行为 |
| 联系人 | `apps/web-host/src/domains/agent-sessions/tools/agent-client-tool.ts` 有 create/update；registry 仅接 list/create；复用 Core `data.clients`，删除需确认端口，更新需错误与候选解析验收 | `agent/test_tool_schema_validation.py`、`agent/test_tool_isolation.py`、`agent/test_agent_delete_undo.py`；Core/Data 相关项目桥接测试 |
| 项目/阶段 | Core `projects.ts`、`projects/creation-port.ts`、`projects/mutation-port.ts` 承载工具契约和共享项目规则；Web Host 注入可信 PG/Kysely、文件操作及持久收据。未注册、仅供测试调用的旧 `agent-project-update-tool.ts` 已退役，替代行为由 Core 项目与 mutation 回归覆盖；`agent-project-tool.ts` 只保留生产注册器仍调用的 dispatch 幂等键编码 | `projects/test_project_tools.py`、`projects/test_projects_core.py`、`projects/test_undo_phase4.py`、`projects/test_project_trash.py`；Node 替代回归 `packages/core/tests/agent/tools/projects.test.ts`、`project-mutations.test.ts`、`project-durable.test.ts`，验证 owner/歧义/阶段待办/CAS/取消/确认/持久收据 |
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
- Docker 沙盒生命周期、Rootless/镜像/容器重建等管理实现退役；`shell` 本身是待重设计/依赖阻塞，Linux Bubblewrap 以独立运行根、目录描述符、网络命名空间、资源 scope 和命令/PTY 探针判定可用。完整 Web Run 和部署继续验收。
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

Core新增createWorkspaceDeleter及实际Kysely PG/SQLite事务端口，原Web Host删除实现已委托公共业务。保留owner声明锁、同owner会话解绑、普通任务停用、外键清引用和父/物理资源保留。该段是当时尚未接入Agent工具的历史状态；当前 `unlink_workspace` 接线与验收见上方状态表。外键/退役数据边界见[node-agent-workspace-port.md](node-agent-workspace-port.md)及[正式SQLite迁移门槛](node-workspace-sqlite-migration-boundary.md)。

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
- Host工厂：`apps/web-host/src/modules/agent-sessions/tools/agent-tool-registry.ts` 新增可选calendar/workspaces/dashboard/projectMutations；前三项分别注入完整共享读取、owner关联读取、计数端口，统计另需可信time。项目端口须具备apply/reconcile；实际目录授权/后端、身份、元数据、时钟和授权服务由Host负责，不能从模型参数获得。
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

`ask_user` 的 choice/question 进入 `meta.ts` 工具组，使用既有注册器授权、参数校验和交互协调器；调用 ID 由可信运行坐标确定，回答经协调器消费并续轮，不进入公开 tool_done 内容。Node Schema 只公开这两种当前可执行的交互，空选项支持自定义回答，重复选项及保留的自定义回复 ID 被拒绝。沙盒授权走可信 Host 授权流程；通用 form 不属于 Node 契约，不能由旧实现名称或提示文案推断已迁移。

Core 交互协调器测试 18 项、Host 注册器与交互描述 16 项通过，覆盖真实注册器到等待/恢复、取消、撤权和伪造选项；Python 交互协议两个无需数据库的基准测试通过。运行存储、Provider 和 Host 授权为测试替身；未验收真实 PG、Redis、平台交互或生产 Run。Core 构建通过；此前 Host 全量类型检查受并行工作中缺失的模块阻塞，不能视为通过。

### 回收站恢复工具（2026-11-15）

`restore_file` 与 `restore_folder` 合并在 tools/trash.ts，Host 显式提供恢复端口时注册，逐次验证权限。端口复用现有 owner 限定的 PostgreSQL/本地文件恢复服务；发送恢复动作前先提交调用预留，结束后持久化真实结果。同一调用重放读取收据，改参、并发未结束或提交应答丢失保持 unknown，不能重做文件副作用或冒充失败/成功。已确认的不存在及父目录仍在回收站使用旧工具错误；不可识别错误不回传原异常。预留和实际恢复不能同事务，故异常中断后可能需要人工核对，不承诺自动判定已提交状态。

隔离 PostgreSQL 随机 schema 与临时目录的真实注册器/恢复服务测试，以及现有文件恢复测试共 8 项通过：覆盖 owner、父目录、文件夹子树、重名、撤权、并发防重放、提交应答丢失和恢复副作用；Core 回收站与注册器测试 21 项、Host 注册器测试 14 项通过；Python 对应文件、文件夹及跨用户测试 3 项通过。Core 构建和 Host 全量类型检查通过。Python 首次测试命令误写测试名，未执行测试；修正后通过。测试通知接收器及模拟提交应答丢失是替身，未验收生产 Agent 装配、真实 Redis、其他 Host 或用户文件。

### 历史对话正文读取（2026-11-15）

`read_conversation` 按旧版工具组放入 tools/conversations.ts，注册器仅在可信 Host 显式装配历史读取并授权时开放。共享会话历史数据适配器在同一 PostgreSQL 查询内限定 owner、排除 content_json 非 SQL NULL 的结构化记录，先取最近 N 条再按顺序输出；空正文在取数后过滤，单条截取 1200 个 Unicode 字符。不存在和跨 owner 使用相同错误，取消和撤权不返回正文。关键词搜索仍需 1.7.7 TypeScript RAG；不以站内搜索替代 BM25。生产 Host 和桌面 SQLite 历史读取能力仍待装配。

隔离 PostgreSQL 随机 schema 的工具调用测试 1 项通过，覆盖真实授权查询、空会话、最近顺序、JSON null、截断、跨用户、非法上限、撤权、组禁用与取消。Core Agent 运行测试 63 项通过，新增用例将工具结果送入模型下一轮（历史读取为明确替身）；Host 注册器 14 项通过；Python 对应 owner/跨用户测试 2 项通过。Core 构建和 Host 类型检查通过。第一次新增 PG 测试误将注册器追加的错误提示当成业务不一致，修正测试以检查原始错误字段后重跑通过，未放宽旧断言。真实 Redis、生产运行、桌面 SQLite 和 RAG 未验收。

历史正文读取共享用例补充：将 owner、最近条数、结构化记录过滤及 1200 码点截断收敛至 Core 会话领域的 PostgreSQL/SQLite 共用查询，Web Host 复用该服务。正式临时 SQLite 和隔离 PostgreSQL 均经真实工具注册器验证；Core 历史及 Agent 运行测试 74 项、PG 测试 1 项、Python owner/越权测试 2 项通过。Core 构建通过；Web Host 现已按 lease 装配正文读取端口，桌面 SQLite Host 尚未装配，RAG 历史搜索另按独立行为验收。

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

`backend/agent/tools/web.py::http_get` 对照 Core `packages/core/src/agent/tools/web.ts`，Host 边界在 `apps/web-host/src/modules/agent-sessions/tools/agent-tool-registry.ts`：Core 实现参数校验、默认/硬字符上限、URL 归一、单次最多 5 个 URL、顺序结果、单项错误隔离和取消传播；owner 仅从可信 RunIdentity 传给 Host port。Registry 仅在明确注入联网端口时注册此工具，当前 `main.ts` 没有生产 Run/联网端口装配，因此列为部分实现，不宣称生产可用。Host port 的生产实现仍须固定/校验公网 DNS 目标、拒绝重定向并解析正文；HTML/PDF 提取、自定义 headers 校验及历史脱敏、`web_download` 配额和本地 FS 落点仍未迁移。Python 回归基准为 `agent/test_tool_schema_security_contract.py`、`agent/test_tool_schema_validation.py`、`platform/test_io_retry_contract.py`；devserver `.venv/bin/pytest` 不存在，故本轮未运行这些 Python 用例。Node `tests/agent/tools/web.test.ts` **6/6**、Core `domain-reads.test.ts` **5/5**（共11/11）、Host `agent-tool-registry.test.ts` **17/17**，Core build通过；Host 全量 typecheck 被其他并行工作区错误阻断，未报告通过。测试使用合成网络端口和身份，不是生产接入。测试 manifest 同时登记了此前未登记的 scheduled-task 新测试，使标准 Vitest 配置可加载；该测试来自并行工作区变更。

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

2026-11-17 `search_conversations` 时间投影差分回归：Core 工具 `execute` 边界覆盖 Python `datetime.fromisoformat` 的 offset 归一化（允许 `+01:99`、`+01:02:99`，拒绝 `+24:00` 和总偏移越界）；devserver `conversation-tools-runtime-sqlite.test.ts` **5/5 通过**，实际调用覆盖 Host registry/dispatch、Jieba/BM25、owner 限定、去重及 Runner 续轮。Python pytest 因 devserver 未安装 pytest 未执行，仅用标准库确认时间解析语义。搜索仍按 Python `strategy="bm25"`，不调用 embedding；生产 `main.ts` Agent Run/重建器装配仍未完成，不能以 registry 或组件级 Runner 测试认定生产接通。

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

2026-11-17 Web 自动 RAG 准备切片：Core scoped search 现可显式选择 Python `mode="automatic"` 对应的 `confidence` 档并排除已注入正文 hash，默认 `top_k` 行为保持兼容；Host `createWebAgentRagContextBuilder` 将 dispatch lease、owner scope 授权、正式持久索引、八类 Web 来源、历史水位及 Canonical knowledge-context block 组合起来。真实 Core `buildRunRagContext` → builder → 临时 SQLite 正式索引的召回、历史 hash 去重和授权拒绝回归 **3/3**，另验证关闭开关不读索引及授权期间取消向上传播；Core scoped-search **6/6**。向量/BYOK 本测试使用未配置边界（只验证词法路径）。生产 `main.ts` 尚未创建 Agent Chat/Run/reconstructor caller，完整授权与向量注入仍需 Host composition，不能将该组件记作生产 Run 已接通。默认 Core Vitest 因共享 suite manifest 不一致无法启动，目标测试以 `/tmp` 临时配置运行；未改共享清单。

2026-11-17 Core RAG 整组当前树复验：Core RAG 源码和测试目录哈希与 devserver 一致后，Core build 成功，使用 `/tmp` 临时 Vitest 配置串行跑完整 RAG 目录，**9 文件、69/69 通过**；Host RAG 端口/自动上下文文件 **3/3**。Host production `tsconfig.build.json --noEmit` 唯一诊断为既有 `src/modules/mcp/sdk-client.ts` 无法解析 `@modelcontextprotocol/client`，本轮 RAG 源无诊断。Node 用例使用临时 SQLite、合成授权/lease，向量传输未在自动 RAG用例启用；Python pytest 本轮未运行（devserver 环境未安装）。真实 PG、Redis、BYOK 向量、Provider 与生产 Agent Run 仍未验收；`main.ts` 当前无 `agentChat`、dispatch worker 或 reconstructor 调用者。

2026-11-17 Web Reconstructor 自动 RAG 接线：资源契约现在要求每个可信 dispatch lease 明确提供 `ragContext`，重建器把它装入 Core `CanonicalContextPorts.preparation.buildRag`，由标准 Run preparation 调用；缺少资源不能默默退化成空 RAG。PG/Redis 重启集成测试新增 Provider 请求体断言，但因当前未配置隔离服务而 **1 项跳过，本轮未执行该断言**；独立自动 RAG 临时 SQLite 行为回归 **3/3 通过**。这只闭合 Reconstructor 到 Core Run preparation 的连接，尚无 `main.ts` caller，因此生产 Run 仍未接入，不能计为生产完成。

2026-11-17 Web Provider binding 的 Run selection：配置化 Provider adapter 新增 `bindRun`，从同一 recoverable snapshot 返回 Core 所需的可信 `ContextSourceSelection`（签名模型身份、上下文预算、请求 locale、owner policy 和 scope key），并在 release 时清理冻结策略。Host 合成配置回归验证 `context_tokens`、locale 和队列 scope key，**1/1 通过**。依赖为临时配置文件、合成 Pool、关闭 BYOK 的 Provider 配置；未连接真实 PG/Provider。这个边界可作为 Reconstructor `bind` 的实现，但当前 `main.ts` 仍未调用它或启动 Web Agent Run。

2026-11-17 自动 RAG 生产向量与授权增量：新增 `createWebAgentProductionRagContextBuilder`，将 lease 固定的自动检索、正式 Core 持久索引与 owner-bound 1.7.7 向量文件/embedding resolver 组合为一处 Host 工厂；Web owner scope 依赖可信 owner-context policy，并在每次检索时复查 PostgreSQL active run、dispatch token/fence 和租约有效期。与 Python 一致，独立的 `memoryEnabled` 上下文快照开关不会误关自动 RAG；embedding 未配置或检索失败仍按旧行为降级为词法召回。Core `buildRunRagContext` 经该生产工厂、临时 SQLite 索引、临时 owner FS、模拟 active-lease Pool 和模拟 embedding transport 的调用回归 **3/3**，包含跨 owner/session 拒绝和 `memoryEnabled=false` 时 Web RAG 仍开启。Host 全量 `tsconfig.json` 当前有多处测试类型诊断；production `tsconfig.build.json --noEmit` 仍被 `src/modules/mcp/sdk-client.ts` 缺少 `@modelcontextprotocol/client` 阻断，RAG 源码无类型诊断。该工厂尚未被 `main.ts` 的 Agent Run/reconstructor resources 调用；正式 PG/Redis 与真实 Provider 仍未验收，不计生产接通。

2026-11-17 自动 RAG 租约失效回归：先临时恢复错误的 `memoryEnabled` 门控，devserver 回归按预期 **2 通过、1 失败**，失败断言确认 Web 自动 RAG 被错误关闭；撤销门控后同组 **3/3 通过**。随后在同一真实 `buildRunRagContext` → 生产 builder → Core 持久索引调用中模拟数据库不再认可 active dispatch lease，断言检索不注入结果并返回 `no_eligible_scope`；仍使用合成 Pool、临时 SQLite/FS 和模拟 embedding。Host production typecheck 当前因共享工作区的 terminals Core 导出缺失及 MCP SDK 依赖缺失失败，RAG 文件未报错；Python pytest 在当前 devserver 环境不可用。生产 `main.ts` Run caller 和真实 PG/Redis/Provider 仍未接入或验收。

2026-11-17 Web 低频上下文格式器增量：新增 `createWebAgentContextBuilder`，把 `ContextSourcePorts` 的 owner 数据转成 Python `build_split` 对应的项目、日历、笔记、文件、记忆、知识及渠道快照；owner scope 关闭或 memory 策略关闭时不格式化/注入对应敏感数据。对照 `backend/agent/context/builder.py`，devserver 行为测试 **2/2 通过**，使用合成 `ContextData`。该 builder 尚未被生产 Run 资源组合调用，真实来源与 PG/Redis 没有在本测试中触达，不能据此声明生产 Chat 接通。

2026-11-17 Context Assembly 接入 Web snapshot builder：`createAgentContextAssembly` 现在固定使用 `createWebAgentContextBuilder`，移除要求调用方自行拼动态字段的接口，避免生产装配误传非 Web formatter。Devserver Context Assembly 与 builder 行为回归 **3/3**；production typecheck 没有本切片诊断，但被 terminals Core exports 和 MCP SDK 依赖缺失阻断。该 Assembly 尚无 `main.ts` 调用者，生产 RAG/Run 仍未接通。

2026-11-17 Web RAG 同 lease 资源组合：`createWebAgentProductionRagRunPorts` 将自动 RAG builder 与正式 `search_conversations`/`search_memory` registry 绑定到同一 dispatch lease 和可信工具配置。devserver `agent-rag-tool-ports.test.ts` **4/4 通过**，经实际 registry dispatch 与 Core `buildRunRagContext` 验证 owner memory 检索、正式自动索引注入及 active lease 失效后两条路径均拒绝。测试使用隔离 Core SQLite、临时 owner FS、合成 PostgreSQL/config/embedding 依赖；owner 文件索引与 Core 自动索引分别构造以保持 Python 两类行为。无真实 PG、Redis、BYOK Provider 或 Python pytest 证据。`main.ts` 仍无生产 `agentChat`/dispatch/reconstructor caller，因此此组合还不是生产 Web Run。

2026-11-17 Node RAG Worker 分词装配：生产 Worker 是独立索引入口，不能依赖 Agent 搜索先初始化 Core 的 Jieba。`startAgentRagIndexWorker` 在启用且 owner 为 Node 时装配与 1.7.7 相同的 `@node-rs/jieba`；保留 Python 默认 owner，避免未显式切换时双消费者。devserver `rag-index-worker.test.ts` **9/9 通过**，覆盖 Node Worker 实际消费隔离 SQLite 队列并将所有可用来源写入正式索引表。实现前的探索性分词断言因源码与 Host 包加载了不同 Core 模块实例而失败，未保留为测试；验收以既有 Worker 的真实索引写入行为为准。没有真实 PostgreSQL/Redis 验收，生产 Agent Run 仍未由 `main.ts` 调用。

2026-11-17 Web RAG 工具授权边界：新增 `createWebAgentRagRunAuthorization`，并由 `createAuthorizedWebAgentProductionRagRunPorts` 组合入口内部使用；Web Run 配置只列出已接入的只读 `search_conversations`/`search_memory`，并在配置发现和每次授权时查询 owner/session/run、active_run_id、dispatch token/fence 与 lease 有效期；身份不匹配、其他工具名或撤销/过期 lease 均拒绝。Host `agent-rag-tool-ports.test.ts` 在 devserver **5/5 通过**，包含通过安全组合工厂的真实 registry dispatch、额外工具与跨 owner 拒绝，以及租约撤销后的拒绝。测试使用合成 PostgreSQL Pool，不代表生产 DB 已接入；安全组合工厂尚未由 `main.ts` Reconstructor/Chat 调用，工具和 Run 仍未算生产接通。

2026-11-17 Web Provider 用量绑定收敛：recoverable snapshot 现在同时返回 Host 默认 6 小时额度、BYOK/local 标记、实际模型与 Provider、凭据是否为 BYOK；Web Reconstructor 默认按该次已验证 binding 创建 Canonical history writer，并在事务写入前复核 lease identity 与模型身份，避免从 checkpoint 模型 ID 推测记账字段。Provider/Reconstructor 定向测试 **9 通过、3 跳过、0 失败**；同批 RAG registry/自动上下文/Worker 回归 **14 通过、0 跳过、0 失败**，之后 RAG 授权/重建器重点子集 **7 通过、1 跳过、0 失败**；新增历史 writer 记账绑定与身份漂移用例 **1/1 通过**。用例使用临时配置、SQLite/FS、合成 Provider/授权/lease；PG/Redis 用例因隔离服务未配置跳过。Python pytest 环境不可用。Host production typecheck 当前仍失败：本切片发现并修复一个 RAG authorization Promise 类型错误；剩余诊断来自并行 terminal Core 导出尚未同步及 MCP SDK 缺包。此修复不改变状态：`main.ts` 仍无 Agent Chat/Reconstructor 调用者，真实 PostgreSQL、Redis、Provider/embedding 与 Python 本轮均未验收，不能称生产 Agent Run 已接通。

2026-11-17 Web Reconstructor 生产 RAG 回归加固：重启集成用例不再注入测试版 `ragContext` 和空工具注册器，而是以当前 dispatch lease/selection 组装 `createAuthorizedWebAgentProductionRagRunPorts`，预置临时 Core SQLite 持久历史索引，并让 Provider 发起 `search_conversations` 后续轮次。该用例运行条件要求隔离 PostgreSQL 与 Redis；本轮 devserver 缺少两者的测试 URL，**1 项跳过**，因此新的 Worker→Reconstructor→生产 RAG→工具→Provider 断言尚未执行。可运行的生产 RAG registry 行为回归 **5/5 通过**；Host 全量 TypeScript 检查仍有 **136 项**跨并行变更诊断，其中本次测试文件和 RAG production 文件无诊断。此改动加强生产调用链回归，但不代表 `main.ts` 已接 Agent Chat 或已验收真实 PG/Redis。

2026-11-17 Web 自动 RAG 配置绑定增量：生产自动 RAG builder 与工具端口现在要求已验证的模型身份，并核对 selection 的 `contextScopeKey` 与加密 dispatch `accessVersion` 一致后才创建 owner 授权端口，避免适配器在配置版本漂移时沿用旧授权。Host RAG 端口及 Web Reconstructor 定向回归 **8 通过、1 跳过、0 失败**；使用临时 Core SQLite/FS、合成 PG lease/授权/embedding。跳过项需隔离 PostgreSQL 与 Redis。该检查只加固已实现的生产边界，不代表 `main.ts` Agent Chat/Run 已接入；真实 PG、Redis、Provider 和生产来源装配仍未验收。

2026-11-17 共享 Core Agent 提示词与上下文格式：将 Web Host 中纯业务格式函数迁入 `packages/core/src/agent/context/prompt-format.ts` 并由 `@gugu/core/agent` 导出；Host 留下可信来源数据读取及策略注入，移除静态提示、动态快照和记忆格式三个散落模块，并把项目概览格式从 PostgreSQL 读取器分离。Core 行为回归 **5/5**、Web Host builder 消费与旧格式行为回归 **7 通过、1 跳过、0 失败**；跳过项需要隔离 PostgreSQL。Core build/typecheck 和 Web Host production `tsc --noEmit` 通过。覆盖时区日期/时间、语言和偏好、快照顺序/截断、记忆衰减与 Unicode 字符预算、项目阶段/文件摘要及非指令提示、IM 来源状态和损坏上下文拒绝。测试未连 Redis 或 Provider；生产 `main.ts` Agent Run 仍未装配。

### 日历与画布确认 claim 事务边界（2026-11-17）

Core 确认核验通过后返回包含完整运行绑定、交互/收据、操作、目标/版本摘要、授权版本和到期时间的受限引用。Host `createPostgresTrustedIntentStore.claimApprovedOperation` 新增 PostgreSQL 事务内一次性 claim：只在同一事务的可信授权复核通过后，按精确 owner/session/run/interaction/tool-call/receipt 与已消费确认动作及 Run 已消费收据删除加密意图；同时验证确认结果、确认码、工具名与到期时间。claim 与业务操作同事务提交，回滚会恢复意图，重复提交不能再次 claim。另新增 Web 日历/画布写端口组合器，日历删除和四项画布危险写端口只有注入确认能力后才注册。devserver Core 日历、画布与确认回归 **54/54 通过**；Host 日历/画布端口、注册器与可信意图回归 **31 通过、2 跳过、0 失败**。跳过项是撤权/回滚/成功 claim/重放 PostgreSQL 场景，隔离数据库未配置；Core build、Core TypeScript `--noEmit` 及 Web Host production `tsc -p tsconfig.build.json --noEmit` 均通过。

Host claim 服务和写端口组合器尚未接到七项工具的生产 `main.ts` Agent Run；同事务授权复核 callback、实际 PostgreSQL claim 测试、真实提醒消费者和生产运行权限源尚未验收。因此七项危险操作仍不得因这些适配器或合成 SQLite 测试而启用，且本节只记实现待接入，不记生产完成。Node/旧 Python 工具行为回归见后续复验记录。Mutagen 仍有同步冲突，本轮没有 flush。

### Agent Runtime 组合迁入 Core（2026-11-17）

将原 Web Host `agent-runtime.ts` 中 Provider 与 Canonical Runner 的可复用组合迁至 `packages/core/src/agent/runtime.ts`，由 `@gugu/core/agent` 公共出口提供 `createAgentRuntime` 和 `AgentRuntimeOptions`。Agent Run 循环、上下文准备、工具调度仍由 Core Runner 执行；Web Host 的 `agent-persistent-runtime.ts` 只组合 PostgreSQL Run Store/lease/启动状态、Redis 取消与事件订阅，并从 Core 引用通用 Runtime。原 Host Runtime 文件已删除，无兼容转发层。身份、权限、Provider binding、数据库、Redis 和 Node HTTP Provider transport 由 Host 端口提供；Core 不再隐式创建平台网络 transport，缺少 transport 时按不支持失败关闭。Core 导出及合成测试不代表 Web `main.ts` 已完成生产装配。

devserver Core build 通过；Node `agent-runtime.test.ts`、`conversation-tools-runtime-sqlite.test.ts`、`use-skill-runtime.test.ts` 共 **7/7 通过**，覆盖 Provider 输出与终态持久化、真实注册器下 owner 限定 `search_conversations` 工具结果续轮，以及按需 Markdown Skill 加载和发现后撤权拒绝。测试使用合成 Provider/Run Store 和隔离 SQLite，不连接 PostgreSQL、Redis 或生产模型。Host production TypeScript 检查首次运行时使用了过期 Core dist，并报 `formatAgentProjects` 未导出；重建 Core 后重新检查 **通过**。Agent Runtime 本身没有 Python 对照测试；日历/画布旧 Python 工具行为回归见同日 110/110 pytest 记录。PG/Redis 持久化、生产身份/权限来源及 `main.ts` Agent Chat/Run 接入仍待验收。

### 定时任务文件授权撤销（2026-11-18）

`update_scheduled_task` 支持单项撤销、批量撤销和停用时撤销。Core 先校验全部目标归属并按 ID 锁定独立任务，再复用现有授权撤销、审计和调用收据事务。批量结果返回排序后的 ID 和实际撤销数，重放只读原收据。Web Host 注入生产确认码清理与审计指纹，本轮撤权回归使用合成的确认码清理端口。发放文件授权仍需定时任务可信确认和工作区执行能力。

devserver Core 定时写入和依赖边界 **4/4**，旧 Python `tests/scheduling/tasks/test_scheduled_task_workspace.py` **10/10**。隔离 PostgreSQL/Redis Host 合批最终 **4 通过、1 失败、0 跳过**。撤权、一次性及周期任务投递、周期触发防重均通过。首轮发现周期测试夹具缺少 `event_id`，改用共享 schema 后通过。生产 Host 立即运行测试首轮通过，后两轮在微信附件断言失败，合成微信服务未收到预期的两次附件票据请求，文字送达断言通过。生产类型检查、Core 构建及 `git diff --check` 通过；外部渠道和实际部署仍未验收。

### 定时任务删除的持久确认（2026-11-18）

`agent-persistent-runtime.integration.test.ts` 使用隔离 PostgreSQL、Redis 和真正的 Web 交互响应服务签发、兑换并处理确认。批准批量删除前目标仍在，其他 owner 无法兑换，取消保留目标。批准后 Core 删除、RAG 墓碑入队和调用收据一起持久化，合成 Provider 下一轮收到原调用结果，重复兑换不会再次发布删除通知。真实外部模型、通知服务与部署未验收。

devserver Core **4/4**，旧 Python `tests/agent/test_confirm_gate.py` 与 `tests/scheduling/tasks/test_scheduled_task_workspace.py` **51/51**。Python 首轮隔离快照遗漏守卫脚本，补入脚本后全组通过。Web Host 合批最终 **6 通过、1 失败、0 跳过**，新增删除持久确认用例通过。前一快照的定时任务合批 **5/5**。最终快照的生产入口测试已通过微信附件对应断言，之后新增的远程图片邮件断言失败，合成 SMTP 收到的邮件缺少预期附件。Core 构建、Web Host 生产类型检查与 `git diff --check` 通过。

### Web 邮件持久确认（2026-11-18）

`agent-persistent-runtime.integration.test.ts` 经真实 Redis 签发与兑换确认码、PostgreSQL 持久交互响应及 Core 执行 `send_email`。确认前不调用发送端口，异主确认被拒，取消只结束等待。批准后合成 SMTP 端口仅调用一次，原工具结果进入合成 Provider 续轮。公开确认投影与持久邮件收据均不含收件人完整地址、正文或 SMTP 凭据。定时预授权邮件继续由另一个生产 Host 用例覆盖环回 SMTP。

旧 Python `tests/platform/email/test_email_tool.py`、`test_email_attachments.py` **27/27**。Core 邮件、远程图片和任务写入定向 **12/12**。当轮默认测试发现起初因新增图片用例尚未登记而拒绝启动，定向回归使用隔离快照内的临时配置，快照退出后清理。生产外部 SMTP、真实 Provider 和部署服务未验收。

Web Host 最终合批 **9/9**，Core 构建与 Host 生产类型检查通过。生产 Host 定时入口经安全出站合成代理获取远程图片并投递到环回 SMTP，也验证私网跳转及下载期间任务被停用时不暂存。夹具的合成 Provider 只依据本轮定时用户消息选择场景，支持纯文本和文本块，避免误匹配同账号其他任务的摘要。此前微信附件和远程邮件附件失败路径在最终同一快照中均已通过。

### 知识删除的持久确认（2026-11-18）

`agent-persistent-runtime.integration.test.ts` 经隔离 Redis 确认码、Web 响应服务和 PostgreSQL 持久恢复调用 `delete_knowledge`。批准前文件保持原样，跨 owner 确认被拒，取消保留文件和索引。批准后仅将当前 owner 的 Markdown 标为停用并移除对应索引，同名异主条目及同账号其他条目均保留。计划和结果各持久化一次，合成 Provider 续轮收到 `{ success: true, knowledge_id }`，重复兑换不再执行。

devserver Core **13/13**、Web Host **6/6**，Core 构建和 Host 生产类型检查通过。旧 Python `tests/agent/knowledge/test_knowledge.py`、`tests/agent/rag/test_rag_knowledge_delta_index.py` **42/42**，覆盖删除墓碑、历史保留和精确移除旧向量分块。Node 合批还包含文件发布后提交失败、索引恢复和旧索引 Worker 围栏用例。测试使用临时授权目录、隔离 PostgreSQL/Redis 和合成 Provider，实际部署与外部模型未验收。

### MCP 配置删除的持久确认（2026-11-18）

`manage_mcp_servers(remove)` 经隔离 Redis 确认码、Web 响应服务和 PostgreSQL 持久 Run 恢复。直接提交异主或系统配置 UUID 时不生成确认；取消保留目标；批准后只删除当前 owner 的目标及其工具快照。异主快照和同名系统配置均保留。删除不解密凭据，也不向远端连接；确认投影和收据不暴露合成密文。重复兑换没有再次删除或失效运行时，合成 Provider 的续轮收到目标 UUID 和成功结果。

devserver Core **6/6**、Web Host **5/5**、旧 Python `tests/agent/mcp/test_mcp_settings_api.py` 与 `tests/agent/mcp/test_mcp_user_tools_e2e.py` **42/42**。Node 合批包含真实 PostgreSQL 配置创建、修改和删除。Core 构建、Web Host 生产类型检查和 `git diff --check` 通过。运行时失效通知与 Provider 为合成端口；新增和修改的私密凭据交互全链、真实外部连接及部署仍待验收。

### MCP 新增的私密凭据与恢复（2026-11-18）

`manage_mcp_servers(add)` 带 Header 槽位时，经隔离 Redis 兑换确认、PostgreSQL 持久 Run 恢复，生成当前账号和配置版本限定的表单。认证提交端拒绝异主，配置有变返回 HTTP 409 且不写凭据。原版本提交成功后，实际信封加密写入 PostgreSQL，重复提交拒绝。公开表单、事件和 Run 检查点均不含明文，合成 Provider 只收到完成状态。此前 Web 路由错误地把这个已知的配置版本冲突映射成 500，本轮补齐受控错误映射。

devserver Core **6/6**、Web Host **9/9**、旧 Python `tests/agent/mcp/test_mcp_settings_api.py` 与 `tests/agent/mcp/test_mcp_user_tools_e2e.py` **42/42**。Core 构建、Web Host 生产类型检查及 `git diff --check` 通过。新用例使用真实加密、隔离 PostgreSQL/Redis 和合成 Provider，无外部 MCP 连接及部署验收。

### MCP 凭据轮换（2026-11-18）

扩展持久确认集成用例，新增账号有旧凭据时取消、批准轮换、用新表单提交及恢复 Run。用例检查取消保留原配置和密文，批准后旧密文清除且仅失效一次运行时缓存，版本变化返回 409，恢复匹配配置后新凭据加密写入。续轮与操作收据不得包含私密值。devserver Core MCP/可移植边界 **6/6**，Host 隔离 PostgreSQL/Redis、凭据路由和认证回归 **9/9**，旧 Python MCP 配置 API/用户工具基准 **42/42**；Core build 与 Web Host production typecheck 通过。Node 集成确认取消保留原密文、批准后单次失效缓存、新表单加密写入、版本漂移拒绝及续轮/收据不泄密。测试未连接外部 MCP 或生产部署。

### 定时任务邮件工具预授权（2026-11-18）

创建或更新时请求 `authorized_tools=[send_email]`，由当前 Web 租约的持久确认绑定输入及更新目标版本。事务内认领确认后才写任务和收据，无 SMTP 能力时拒绝写入。显式清除授权沿用普通写入，实际发送仍由定时消费者按当次任务、owner 和租约复核。新增测试覆盖确认前无写入、篡改参数、目标漂移、清除授权和提交重放；Redis 确认、PostgreSQL 恢复与消费者授权读取也有集成回归。devserver Core **7/7**、Host 隔离 PostgreSQL/Redis **8/8**、旧 Python 定时任务/邮件基准 **30/30**，Core build 与 Web Host production typecheck 通过。验证覆盖确认绑定、撤权、任务执行授权和重放；外部 SMTP 与生产部署仍待验收。

### Agent Runtime 固定请求前缀恢复（2026-11-18）

检查点恢复从 Web Reconstructor 移入 Core `agent/run/reconstruct.ts`，新运行和恢复共用 `agent/context/assemble.ts` 的固定前缀组装规则。Core 校验 Run 与会话快照归属、访问范围、消息数及请求指纹，检测正文变化后拒绝继续恢复。Web Host 传入已验证租约、会话快照、请求 builder 和摘要函数，并继续持有 PostgreSQL、Redis、模型配置及 HTTP 适配。现有 `main.ts` 的生产 Chat 组合入口通过这个 Web 适配器调用 Core。

devserver 定向回归：Core 重建、调度、上下文和可移植边界 **41/41**，Web Host 持久运行、重建、调度和 RAG 工厂 **7/7**，无跳过。隔离 PostgreSQL、Redis 与合成 Provider 验证了重启式重建、前缀变更拒绝、取消和事件重放。Core 构建与 Web Host production TypeScript 检查通过。旧 Python `tests/agent/test_run_lifecycle.py`、`tests/agent/test_run_finalize.py`、`tests/agent/test_tool_history_request_boundary.py` **26/26**，用于对照运行生命周期、收尾和工具历史请求边界。未改 Python 实现或断言。真实外部模型、已部署 Web 服务和 Desktop Agent 入口未验收，本切片不新增工具注册项。

### Agent Runtime 迁移边界复核（2026-11-18）

复核当前实现后，跨端运行逻辑位于 `packages/core/src/agent/`：`runtime.ts` 组合 Provider Harness 与 Canonical Runner；`chat-service.ts` 管理 start/resume/cancel/wake；`core.ts` 执行模型轮次、工具分派和 Run 推进；`run/` 与 `interactions/` 实现 dispatch、重建、事件流、取消、确认恢复及交互消费。`runner.ts`、`context/` 和 `providers/` 也属于 Core 可移植执行链。Core 通过显式端口接收身份关联上下文、Provider binding、授权、持久化、取消和执行能力，不隐式创建 Web、数据库或消息代理连接。

Web `agent-web-run-lifecycle.ts` 与 `agent-persistent-runtime.ts` 仅创建 PostgreSQL/Redis 端口并将其接到 Core；`agent-web-reconstructor.ts` 从可信 Web 会话与 lease 准备恢复所需数据；`main.ts` 负责生产装配。Fastify/SSE、可信身份及租约、PG/Redis、Host Provider transport、文件系统和 Web 事件投影仍属于 Host 能力边界。没有保留旧 `agent-runtime.ts` 业务实现或兼容转发层。现有 `portable-boundary.test.ts` 检查 Agent Runtime 依赖闭包不得装载平台/驱动/SDK，Core Runtime、dispatch、重建及上下文行为回归见上方各记录；其测试替身不代表 Host 生产资源或 Desktop 接入验收。

### Agent Runtime 的 Core/Host 边界复核（2026-11-17）

Core `createAgentRuntime` 只组合 Provider Harness、Canonical Runner 与可信 Host 端口；Node transport 的默认选择改由 Web Host 持久运行时注入。新增 Runtime 行为断言：Core 调用缺少 transport 时返回 `unsupported`，显式注入 transport 后 Provider Run 仍可完成；devserver Core build、Web Host production TypeScript 检查通过，Agent Runtime 测试 **1/1 通过**。测试前核对四个被测/记录文件 SHA-256 一致；Mutagen `gugu2-0` 有 3 项其他冲突，未 flush。生产 `main.ts` 是否装配 Agent Chat/Run、可信身份来源与真实 PostgreSQL/Redis 仍按上文单独验收，不能由此测试推定已接通。

同日把原 Host `agent-chat-service.ts` 中与平台无关的 start/resume/cancel、身份匹配、事件订阅和 dispatch 生命周期用例迁至 `packages/core/src/agent/chat-service.ts` 并从 `@gugu/core/agent` 导出。Core 仅依赖显式 Harness、持久事件、取消、dispatch 和事件投影端口；Web 事件投影、Fastify/SSE、PG/Redis 适配仍留 Host，旧 Host service 文件删除。devserver Core build 通过；Host Chat service 与持久 Runtime 定向测试 **8 通过、1 跳过、0 失败**，跳过项需显式隔离 PostgreSQL/Redis；Web Host production build 通过。首轮回归发现测试 callback 未保留失败终态 `error` 投影，恢复使用真实 Host `projectAgentRunEvent` 后重跑通过。生产 `main.ts` 仍未装配 Agent Chat/Run，本次测试不代表生产入口、真实 PostgreSQL/Redis 或 Provider 已验收。

后续边界修正：Agent 的稳定快照/请求拼装、内部上下文不可复述策略、Web context owner-scope 投影和时区提醒正文从 Host context builder 移入 `packages/core/src/agent/context/builder.ts`。Host 只保留数据源与配置端口装配；Core 行为回归迁入 `packages/core/tests/agent/context/context-builder.test.ts`，覆盖稳定前缀与动态时间分离、owner scope 收缩和 memory 开关下无字段泄露。当前树相关源码、测试、suites 与记录文件 SHA-256 和 devserver 一致后，devserver Core build 通过，迁入的 context builder **3/3 通过**，Web Host production build 通过。测试使用合成上下文，不连接 PostgreSQL、Redis 或模型；不代表 `main.ts` Agent Run 生产装配完成。

补充将通用 Agent 摘要 Provider 绑定从 Web Host `context/agent-compaction.ts` 移入 Core `agent/context/compaction-runtime.ts`，由 `@gugu/core/agent` 导出。Core 负责绑定当前 Run 的模型端口、摘要提示默认值、预算门控、投影惰性创建及可取消重试；Host 只读取 Web 的 `compress_conv.md` 并注入可信模型/Run 配置。Host 摘要实现文件及旧名称已删除，全仓搜索无剩余引用。Core 压缩/上下文回归 **68/68**，Web Host Runtime 与 Provider 配置回归 **2/2**，均在 devserver 通过；Core build 同步通过。测试使用合成 Provider 和配置，不连接真实 Provider、PostgreSQL/Redis；生产身份/权限来源及 `main.ts` Run 装配仍未验收。

随后将 Run 工具注册器绑定、配置快照过滤及发现/分派/收据恢复时的身份边界从 Web Reconstructor 移入 Core `agent/run/tool-ports.ts`。Core 固定可信 owner/session/run 并拒绝身份或配置主体漂移；Host 仅额外检查 `source=web`、session 主体和 MCP/dispatch lease 的平台授权。Core compaction/Run tool ports 定向行为回归 **69/69**，Web Run/RAG/MCP 授权与工具绑定回归 **17/17**，均在 devserver 通过；Web Host production `tsc -p tsconfig.build.json --noEmit` 通过。Core 因工作树内另有未登记测试文件触发分类扫描失败，本轮使用仅包含两个目标文件的临时 Vitest 配置执行；全量 Core `typecheck:tests` 仍被多个既有测试类型错误阻断，新增测试文件及本切片源码不在报错中。测试不连接真实 PostgreSQL/Redis/外部 Provider。生产 `main.ts` 未装配 Run，测试替身不代表生产可用。

补充将 Host `agent-dispatch-worker.ts` 中与平台无关的持久 Run 执行编排迁入 Core `agent/run/dispatch-worker.ts`，并将版本冲突错误作为 Core 契约导出。Core 负责持久队列端口调用顺序、重建版本拒绝、取消转发、Harness start/resume 选择、资源释放、失败启动收据委托和同会话唤醒合并；Host 保留 PostgreSQL dispatch/lease、Redis 取消与事件适配、Web 重建器。后续又将无平台依赖的 ready 扫描、并发限制、订阅故障重试和 supervisor 停止/排空编排迁入 Core `agent/run/dispatch-supervisor.ts`；Host 保留真实 Redis 订阅、PG ready 查询端口和进程生命周期。原 Host worker/supervisor 与无调用方的转发文件删除，Host 集成测试改从公开 Core 入口消费。devserver Core build 通过；dispatch-worker 与 dispatch-supervisor **8/8** 通过；Web Host production `tsc -p tsconfig.build.json --noEmit` 通过。测试使用合成 lease、Harness、订阅和持久端口，不连接 PostgreSQL 或 Redis；不代表生产 `main.ts` Agent Run 接入。

2026-11-17 交互恢复 worker 边界补齐：将 Host `agent-interaction-worker.ts` 内的平台无关认领恢复顺序、已消费收据防重放、终态处理、Run 身份校验及可停止轮询移入 Core `agent/interactions/recovery-worker.ts` 并由 `@gugu/core/agent` 导出；Host runtime wrapper 只提供 PostgreSQL 队列、Run Store、Harness、凭据失效与诊断端口。原 Host worker 单测迁入 Core，新增身份不匹配时拒绝完成且释放认领的回归。devserver Core build 通过，恢复 worker 单测 **4/4 通过**；dispatch worker/supervisor、交互恢复与上下文 builder 相关 Core 回归合跑 **4 文件、15/15 通过**；Web Host production TypeScript 检查通过。Host PostgreSQL interaction 测试因未设置隔离数据库 URL 跳过。未运行 Python pytest（此 Runtime 编排没有独立 Python pytest 对照）；实际恢复 Worker/Chat 仍未由 `main.ts` 装配，不能记为生产接入。

`main.ts` 中仅用于技能选择目录及 MCP 工具名去重的 `skillToolRegistry` 原先使用 `authorize: async () => true` 读取 `capabilities`。现改用只读 `catalog()`，该目录注册器的 dispatch 授权固定拒绝；`tool-catalog.test.ts` **1/1 通过**，覆盖停用项隐藏且目录查询不调用授权能力接口。Web Host production `tsconfig.build.json --noEmit` 通过，`apps/web-host/src` 中已无生产 `authorize: async () => true`。此目录能力不构成 Agent Chat/Run 接入。

`main.ts` 中仅用于技能选择目录及 MCP 工具名去重的 `skillToolRegistry` 原先使用 `authorize: async () => true` 读取 `capabilities`。现改用只读 `catalog()`，目录注册器的 dispatch 授权固定拒绝；`tool-catalog.test.ts` **1/1 通过**，覆盖停用项隐藏且目录查询不调用授权能力接口。`apps/web-host/src` 生产代码中已无 `authorize: async () => true`。该目录能力不构成 Agent Chat/Run 接入。

同日 Python 旧行为基准复验：在 devserver `/tmp` 独立 venv 安装项目及测试依赖后，串行运行日历工具/更新/提醒、画布缺口/工具/Undo、Agent 删除撤销、确认门和创建幂等 **9 个 pytest 文件，110/110 通过**。`conftest.py` 使用每测试全新内存 SQLite、临时配置和 storage、fakeredis；未设置真实 Redis 或 PostgreSQL URL，不访问用户运行数据。安装过程未修改 Python 源码、pytest 断言或仓库环境。该结果补足旧 Python 行为回归，不证明 Node PostgreSQL/生产 Host 接入。

2026-11-17 当前树复验：先确认目标源码、Node 行为测试和本清单在 devserver 的 SHA-256 与工作区一致，Mutagen `gugu2-0` 有 3 项冲突，因此未 flush。devserver Core build 通过；Core 日历创建/更新/删除、画布批量编辑和确认回归 **54/54 通过**；Host 日历提醒目标、日历写端口、画布危险端口、Core Runtime、RAG/Run 授权和可信意图集合 **14 通过、3 跳过、0 失败**；Web Host 生产 TypeScript build 通过。跳过为需显式隔离 PostgreSQL/Redis 的 Runtime 集成和可信确认 claim/目标测试。首次 Host 扩大运行遇到 `agent-run-store-postgres.ts` 解析错误；在该共享文件当前哈希与工作区一致后复跑，Host 集合通过。该共享文件由并行工作修改，本轮未改写。测试使用隔离 SQLite、合成 lease/Provider/授权和 fake Pool；未连接真实 PostgreSQL、Redis、Provider。旧 Python 基准见上方 110/110 记录，本轮未重跑。

该复验没有改变生产接入状态：`main.ts` 仍未组装 `createAgentChatService`、`createWebAgentReconstructor` 或 dispatch worker/supervisor；确认 store/write-port 也没有生产 caller。随后只读检查 devserver systemd 当前只有 `gugu-worker` 与 `gugu-gateway` 为 active/running，没有 Node Web Host 服务。日历写入后由哪一个已部署提醒消费者读取、Node/Python 是否共享同一生产数据库均未验证。七项日历/画布工具继续保持未接入生产 Agent Run；不能将本次合成端口回归或已运行的 Python worker 记成生产接通。

### Node IM 记忆维护的 RAG freshness（2026-11-17）

Admin IM 记忆维护 apply 现在通过 Host 注入的 RAG mutation 端口处理 group/member 文件变更：首次写入前先撤回 owner 的旧 memory 投影并 fence 旧 generation；文件写入后按 owner/platform/bot/scope type/scope ID 推进 `memory_reflection_cursors.scope_version`，再排入完整 `memory` 来源重建。这样使 Worker 的 scope 缓存随 revision 变化，并避免索引更新前继续返回旧文档。写入中途失败时仍为已触碰的文件刷新 revision/队列，旧投影保持隐藏。

devserver 本轮复验：定向 Node **14/14 通过**（IM maintenance apply **5/5**，RAG worker/source **9/9**），已包含“重建队列更新失败时 scope revision 回滚”及“已墓碑 scope 不推进 revision”断言；临时 SQLite/隔离 FS 经真实 mutation adapter 与持久 Worker 验证旧索引隐藏、revision/job 原子性和更新文档重建。Core 与 FS build、Web Host production `tsconfig.build.json --noEmit` 通过。全量 Web Host `pnpm typecheck` 失败，共 **96 个诊断，96 个在 `tests/`、0 个在 `src/`**；production 检查单独通过。对应 Python `tests/im/test_im_memory_admin.py` 未运行成功：devserver `python3` 无 pytest 模块。测试不连接真实 PostgreSQL、Redis 或 embedding Provider；Mutagen 仍有 3 处旧目录构建产物/依赖冲突，源码哈希与本轮验证文件一致。首次 freshness 用例的等待窗口短于隔离 Worker 的 1 秒轮询间隔，调整该用例间隔到 10ms 后复验通过。

此项只接通 Node Admin IM 记忆维护文件写入者，不代表普通 owner memory/reflection producer 已迁入 Node。Node RAG Worker 仍需显式配置为唯一消费者，生产 PostgreSQL/Redis 尚未验收；生产 `main.ts` Agent Chat/Run 仍未装配 RAG tool registry。

2026-11-17 Web RAG resources 工厂调用回归：`createWebAgentRagResources` 在 source 未显式提供 memory 向量搜索时，会从同一 Run RAG 的可信 embedding resolver/transport 创建 owner-bound prompt-memory 向量服务；显式 Host source 注入仍优先。`agent-web-rag-resources.test.ts` 用隔离 FS 写入 51 条 pattern 及版本匹配向量，再从工厂返回的真实 ContextData loader 验证超额相关条目依向量选择，并通过实际注册器 dispatch 查询 owner 会话。首次用例因 fixture 未超过 Python 的 50 条触发阈值而失败；修正 fixture 后 devserver 本组 **18 通过、1 跳过、0 失败**，跳过是需 PostgreSQL/Redis 的 Reconstructor 集成。测试使用合成 lease Pool 和 mock embedding transport；未调用真实 Provider、Redis 或 PostgreSQL。资源 factory 到工具边界已验证，生产 `main.ts` caller 仍缺失。

2026-11-17 Web RAG 压缩授权时序回归：重建器在 `Harness.start` 前绑定 Provider；有效预算下，压缩配置和工具 schema 延迟到压缩被调用后读取，避免 pre-start 阶段查询尚未激活的 dispatch lease；无效预算沿用本地回退且不查询工具授权。资源工厂行为测试覆盖绑定时零查询、有效预算延后到执行期查询、无效预算不查询，Node 本地定向测试 **1/1 通过**；Web Host production `tsconfig.build.json --noEmit` 通过。测试使用临时 SQLite/FS、合成 lease/Pool 和 Provider，不触达真实 PostgreSQL、Redis 或 Provider。当前 Mutagen `gugu2-0` 有 3 项冲突，未 flush；本机全量 `typecheck` 被其他测试文件类型诊断阻断，单独 production 检查无诊断。生产 `main.ts` Agent Chat/Run caller 仍未完成，此项只修正 Reconstructor 生命周期边界。

2026-11-17 Agent Run 接线继续：Core Web context builder 现在把 owner 数据源读取的 `userTimezone` 传给静态提示词构造器，并在 snapshot 重建时继续使用同一时区，避免生产 Host 只能捕获固定时区。Core builder 行为回归 **3/3**；Core build 通过。Web Host production TypeScript 检查通过；RAG 9 个 Core 测试文件 **69/69**，RAG resource/授权/Worker Host 测试 **17/17**，resource 调用仍经实际 `search_conversations` registry dispatch。另补齐 Web ToolPort MCP configured 回调的完整 Run 身份校验，并新增 `agent-web-run-lifecycle.ts` 组合 PG dispatch、Core worker/supervisor、Redis cancellation/outbox、Chat preparation 与 AgentChatService。上述行为使用合成上下文/SQLite/Pool/Provider；未连接真实 PG、Redis 或 Provider，也没有在 `main.ts` 创建该生命周期或生产 Reconstructor，因此不能计为生产 Agent Run 已接通。Python pytest 本轮未运行；本地缺少 `backend/.venv/bin/pytest`。

2026-11-17 当前工作区复验：Core RAG 目录与 mind RAG freshness 共 **10 文件、74/74 通过**（使用临时 Vitest 配置，默认配置仍被共享 `tests/suites.json` 漂移阻断）；Host RAG resources、tool ports 与持久索引 worker **17/17 通过**；Web Host production TypeScript `tsc --noEmit` 通过。Python pytest 在当前本地环境因缺少 pytest 模块未能启动。生命周期 helper 已存在，但生产 `main.ts` 仍未提供其真实 Reconstructor/Context resources，也未把 service 传入 `createApp(agentChat)`；所以这些通过只覆盖 RAG Host 端口、worker 与 Core 行为，不代表生产 Web Agent Run 已接通。真实 PG/Redis、BYOK embedding/Provider 与生产 Context 收尾仍未验收。

2026-11-17 Agent Runtime Core 边界补齐：Web Reconstructor 中通用摘要端口的惰性初始化、并发首次绑定复用及绑定失败重试已移入 Core `createLazyAgentCompactionPort`。Host 保留 Web 授权配置读取、按当前 Run 过滤工具 schema 和可信 Provider 绑定；无效预算不访问 RAG 授权，摘要执行失败不会错误地重复绑定。devserver Core build 与 compaction/context **69/69**、Web RAG resource/compaction **1/1** 通过。Web Host production TypeScript 检查本轮失败于共享 `main.ts:1188` 的类型错误（`networkProfile` 推断为 `string`，不符合 `'none' | 'egress'`）；本切片未改该文件。回归使用合成 Provider、临时 SQLite/FS 与隔离 owner，不访问真实 PostgreSQL、Redis 或模型。该迁移不代表生产 `main.ts` 已装配 Agent Run。

2026-11-17 七项日历/画布 Python 行为基准复跑：devserver 临时 venv 安装 pytest、pytest-asyncio、aiosqlite、fakeredis、uuid6、APScheduler，并 editable 安装仓库 `compat/core-python`；在 `PYTHONPATH=.:../compat/core-python/src` 下串行执行 `test_calendar_tools.py`、`test_create_idempotency.py`、`test_event_atomic_update.py`、`test_event_update_reminders.py`、`test_mind_canvas_gaps.py`、`test_mind_canvas_tools.py`、`test_agent_delete_undo.py`，**66 passed、0 failed**。首次 collection 所缺依赖在同一个 `/tmp` venv 补齐；临时环境由命令退出清理，未修改 Python 参考实现、仓库 venv 或运行数据。基准通过不改变生产接入状态：七项工具仍无 `main.ts` Agent Run caller，真实确认授权与提醒消费者仍未验收。

2026-11-17 日历/画布 Node 目标回归复验：devserver Core build 通过；Core `calendar-create.test.ts`、`calendar-update.test.ts`、`calendar-delete.test.ts`、`canvas-edits.test.ts`、`confirmation.test.ts` **54/54 通过**；Web Host `agent-calendar-write-ports.test.ts`、`agent-canvas-write-ports.test.ts` 与 `agent-tool-registry.test.ts` **27/27 通过**。这些测试覆盖 SQLite 事务端口、撤权拒绝及缺持久确认时危险画布/删除工具不注册；Host 删除确认使用合成 gate/claim，不证明真实 PostgreSQL 意图、交互恢复或事务 claim。Node 与 Python 合成行为回归通过仍不代表生产 Run 接线。

2026-11-17 Web Agent 反思队列桥接：新增 Node 收尾适配器，沿用 Python 消费端的 owner/session Redis key、owner 锁、idle ZSET、阈值调度和 trivial-turn 过滤；用户正文只写入既有私有 Redis 队列，读取反思输入时重新校验已持久化的当前用户消息归属，并使用 Host 用户显示名。受限上下文不入队；Redis 故障只产生无参数诊断，不回滚已完成 Run。定向行为回归 **5/5 通过**，覆盖队列 payload/阈值、idle/trivial 筛选、Python 持锁、持久 owner anchor 和失败隔离；同批 RAG tools/resources/Worker 行为回归 **22/22 通过**。测试用合成 Redis 命令与 Pool，不连接真实 Redis/PostgreSQL，也没有启动 Python reflection Worker。该桥接仍由资源工厂持有，`main.ts` 尚无 Agent Run/Reconstructor 调用点，不能算生产接入或 Node 反思算法迁移。当前 `python3 -m pytest --version` 因环境缺少 pytest 模块而未能运行 Python 基准。

2026-11-17 Web RAG Agent 主链装配：`main.ts` 现在在 Redis 可用时构造配置化 Provider binding、可信 owner Web context source、`createWebAgentRagResources`、持久 `createWebAgentReconstructor` 与 PG/Redis `createWebAgentRunLifecycle`，并将其 ChatService 交给 `createApp`；启动/关闭会启动并 drain dispatch supervisor。此 Host 切片只发现和注册真实 `search_conversations`、`search_memory`；Shell/Executor、交互和附件媒体没有授权实现时保持拒绝或报明确不支持，未回退宿主执行。RAG+反思队列定向 Node 行为 **22/22 通过**，Chat Host/route/Reconstructor **5 通过、1 跳过**（PG/Redis 集成需隔离连接），Web Host production TypeScript 检查通过。组件测试使用临时 SQLite/FS、合成 lease/Pool/Redis、mock embedding 和合成 Provider；未连接真实 PostgreSQL、Redis 或外部 Provider，旧 Python pytest 本轮因本机缺少 pytest 模块未运行。代码现已接线，但真实服务生产验收、dispatch schema/索引迁移、Python 旧工具回归和 Node Worker 唯一消费者切换仍未证明；不把合成调用测试计作真实 PG/Redis/Provider 验收。

2026-11-17 日历 Agent Run 接线增量：`createWebAgentRagResources` 接受按可信 lease 创建的 Host 写端口，并只把已提供端口对应的工具名加入 Web Run 配置；`main.ts` 为 `create_event`/`update_event` 注入 Core Kysely 写端口、现有日历变更发布器和 owner 受限提醒目标解析，configured-tool 过滤同步允许这两项。日历删除和画布危险工具未开放，确认/交互链保持独立门控。devserver Core build 通过；Host 日历端口、RAG resource factory、RAG lease 授权及工具 registry **34/34 通过**；Web Host production `tsc -p tsconfig.build.json --noEmit` 通过。Node 回归使用隔离 SQLite/FS、合成 lease/Pool 与端口，未连接真实 PostgreSQL、Redis 或 Provider；Python 对照本增量未重跑，最近一次七项相关基准 **66/66** 见上方记录。devserver 的后台 Worker systemd 单元只读状态为 active，尚未用合成事件验证提醒实际投递。故 `create_event`/`update_event` 有生产 Run 调用路径但仍列“已实现待接入”，真实 PG、提醒投递和 Provider 后续轮未验收。

2026-11-17 Web RAG Agent 主链当前树复验：production `tsconfig.build.json --noEmit` 通过；合并运行 RAG/反思队列、Host Chat/route、Reconstructor 与 RAG index Worker **28 项：27 通过、1 跳过、0 失败**。跳过项是需隔离 PostgreSQL/Redis 的 Reconstructor 重启恢复集成。行为覆盖包括实际 `search_conversations` registry dispatch、RAG 来源授权与活动 lease 复验、owner memory 向量端口、反思队列 Python 兼容语义、Host Chat SSE 认证/断连和持久索引 Worker；依赖为临时 SQLite/FS、合成 lease/Pool/Redis、模拟 embedding/Provider。Python pytest 在本机因缺少 pytest 模块未能启动；`gugu2-0` Mutagen 同步存在 3 项冲突，本轮未 flush。生产 Run 代码已通过 `main.ts → createApp(agentChat) → AgentChatService → dispatch worker → Reconstructor → RAG registry` 装配，但没有用真实 PostgreSQL、Redis、Provider 或 Python pytest 验收；因此生产部署恢复、dispatch schema、Python 基准及 Node RAG Worker 唯一消费者切换仍列为待验收。

2026-11-17 主链当前工具范围补记：生产 `main.ts` 的 lease-bound resources 除 `search_conversations`、`search_memory` 外，还通过共享 Core 日历服务提供 `create_event`、`update_event`。devserver 重跑 Host calendar ports、RAG resources、lease authorization 与 registry **34/34 通过**，覆盖创建/更新撤权、缺能力时不注册、危险操作确认门与生产注册器分组启停；使用隔离 SQLite/FS、合成 PG/lease/授权及端口，真实 PostgreSQL、提醒投递与外部 Provider 未验收。日历删除、画布危险操作、Shell、交互和不支持的附件/媒体输入仍不可用或被拒绝；此补记修正前一段“只发现两项 RAG 工具”的范围描述。

2026-11-17 Python RAG 行为基准复验：先确认 12 个相关 pytest 文件与当前工作区哈希一致，再于 devserver `/tmp` 临时 venv 串行运行 Cython rank/tokenizer、Tokenizer golden、固定相关性语料、旧 `search_conversations`、工具 schema 安全、memory service/unified query、group owner、向量缓存、retriever 与 hybrid，**118/118 通过**。环境使用仓库 requirements 和临时 editable `compat/core-python`，`GUGU_ENV_FILE`/override 指向不存在的临时路径，pytest cache 禁用、bytecode 关闭；Cython 临时构建与 venv 在退出时清理。唯一警告为既有 pytest-asyncio fixture loop scope 与 Sudachi 弃用提示；未访问真实数据库、Redis、用户文件或 Provider。它补回本机缺 pytest 的缺口，但不覆盖 PostgreSQL/Redis integration、production Agent Run 或消费者切换。

2026-11-17 RAG Run 工具范围更正：在既有 lease-bound Agent Run registry 中增加 `read_knowledge`，由 Host 按当前 lease 注入 owner-only FS/时区和持久知识索引读取端口；`read_knowledge` ID 查询读取完整 Markdown，关键词查询固定走 Python 一致的 BM25，不读取向量、不调用 embedding。Host 授权默认关闭该工具，仅在真实 knowledge port 存在时允许配置和注册；测试覆盖实际 registry dispatch、参数错误、撤权、异主/越权 scope 拒绝、BM25 结果及取消/结果边界。devserver Host RAG resources、授权、knowledge adapter 和工具 registry **34/34 通过**；生产 TypeScript 检查通过。当前 Run 已接入 `search_conversations`、`search_memory`、`read_knowledge`、`create_event`、`update_event`。使用临时 SQLite/FS、合成 lease/Pool/Redis、mock embedding/Provider；未验收真实 PostgreSQL、Redis、外部 Provider、提醒投递或进程恢复，RAG Worker 默认消费者仍为 Python。`save_knowledge`/`update_knowledge`、知识写入生产 Run、其他工具组仍待接入。

2026-11-17 知识写工具进入生产 Run：Web Host 按可信 lease 装配 owner-bound Markdown 写端口；`save_knowledge`/`update_knowledge` 仅当该端口存在时进入工具 schema 和授权集合，每次调用仍复验当前 dispatch lease。工具复用 Python 兼容字段/版本逻辑、旧时间戳迁移、owner FS 原子写以及先撤回索引并推进 generation、后写文件和排持久 freshness job 的既有端口；删除工具保持关闭。新增 `agent-web-rag-resources.test.ts` 实际工具 registry dispatch 写入、更新并回读文件，并扩展 authorization 测试检查写权限跟随 lease 撤销。此切片尚未在 devserver 执行（Mutagen 存在远端目录冲突，未 flush），所以回归与 production TypeScript 检查待验收；此前知识写工具 Core **7/7** 和 Host 写入→Worker→索引 **20/20** 只覆盖各自边界，不等同于新生产 Run 调用链通过。

2026-11-17 Agent Runtime 业务编排归属 Core 复核：跨端 Chat Run 生命周期、上下文 snapshot/request builder、dispatch worker/supervisor 与 interaction recovery 的实现位于 `packages/core/src/agent/{chat-service.ts,context/builder.ts,run/,interactions/recovery-worker.ts}`，由 `@gugu/core/agent` 显式导出；原 Host 重复实现及旧测试路径已删除，Host 只保留基于可信 owner/lease 的 PostgreSQL、Redis、HTTP、Provider/配置和生命周期组合适配。复核确认 Core 运行模块不导入 Host、Fastify、PG 或 Redis。devserver Core build 通过；四个 Core 行为测试文件 **15/15 通过**；Host Chat、Context Assembly、dispatch、Runtime 与 Reconstructor **13 通过、4 跳过、0 失败**，跳过均需显式隔离 PG/Redis；Host production `tsc -p tsconfig.build.json --noEmit` 通过。Core 默认 Vitest 入口仍被共享 suite 发现/分类清单不一致阻断，本轮使用 `/tmp` 范围内的临时 Vitest 配置仅运行上述目标文件，未改共享清单。组件回归使用合成端口；真实 PG/Redis claim/lease、跨进程重启恢复和部署服务未验收，Run/Job 总体仍未完成。

2026-11-17 七项日历/画布当前树复验与状态修正：Core build 后，日历 create/update/delete、画布编辑、确认及 Agent Runtime 行为测试 **9 文件、69/69 通过**；Host 日历/画布端口、registry、Reconstructor resources 与交互消费相关测试 **35 通过、5 跳过、0 失败**，跳过项均需隔离 PostgreSQL。Host production `tsc -p tsconfig.build.json --noEmit` 通过；初次检查因 devserver 未链接工作区 `@gugu/sandbox` 失败，按冻结锁文件对 Host 做离线筛选安装后复验通过，未改依赖清单。当前 `main.ts` 确实将 `create_event`/`update_event` 端口注入生产 Run 资源工厂，因此状态从“待接入”调整为“部分实现”；真实 PostgreSQL、提醒投递消费者及 Provider 后续轮未验收。`delete_event`、`canvas_delete`、`canvas_delete_note`、`canvas_disconnect` 与含删除的 `canvas_batch` 仍未注入确认端口；Host interaction activation/projector fail closed，PG dispatch worker 拒绝 `waiting` checkpoint，恢复队列尚未取得并续租可重建 Run 的 dispatch lease。Core/Host 合成回归与配置清单不能代替真实 PG/Redis claim、并发和恢复验收。本轮没有改 Python 代码，Python pytest沿用此前 **63/63** 记录，未重跑。

2026-11-17 Core dispatch 收据传递契约：`AgentDispatchRuntimeLease` 现在允许可信 Host 在完成持久 owner/单次消费校验后附带 `InteractionResolution`；Core dispatch worker 仅在 `mode='resume'` 时将其交给 Harness，Harness 继续核对 pending interaction ID 与收据绑定；`mode='start'` 租约附带 resolution 会被阻断并标为版本冲突。Core dispatch worker 行为回归 **9/9 通过**。这让跨端恢复编排留在 Core，但不表示 Host 已实现安全认领：当前 PostgreSQL dispatch `claim()` 仍拒绝 `waiting` checkpoint，Host interaction resume queue 也未与带 fencing 的 dispatch lease 合并。因此确认写工具仍保持关闭，需继续完成 Host 原子认领/续租/结算、跨进程恢复以及真实隔离 PG/Redis 验收后再开放。

2026-11-17 `use_skill` per-lease 接线复核：生产 `main.ts` 从 `packages/core/resources/skills/*.md` 的自动嵌入文档读取 frontmatter，由 Core `createBuiltinSkillDefinitions` 按 head 注册，并为每个 Web Run 装配 owner scoped 用户 Skill loader；`related_tools` 仍只是描述元数据。新 Host 回归经实际 Core ToolRegistry dispatch 验证 bundled Markdown 正文、用户 Skill owner 隔离和发现后的停用拒绝。devserver Core build 与 Skill production ports、RAG resources、`use_skill` ToolPort 三个 Node 文件 **3/3 通过**。Node 实测使用隔离 SQLite、真实打包 Markdown 和合成用户 Skill 数据/授权；PostgreSQL 与 Provider 使用真实生产组合的端到端 Run 未运行。对应 Python 基准 `backend/tests/agent/test_user_skills.py::test_use_skill_loads_owned_body_and_refreshes_digest` 本轮因 devserver 未安装 pytest 未运行。状态据 main 生产调用路径从“已实现待接入”改为“部分实现”，不计生产完成。

2026-11-17 `list_skills` per-lease 接线复核：生产 `main.ts` 将 Core `createSkillMetadataReader` 注入当次 Agent registry，Run 配置只开放只读 `list_skills`；`related_tools` 不影响授权。Python 基准为 `backend/tests/agent/test_user_skills.py::test_list_skills_returns_only_current_users_metadata_without_bodies` 与 `test_list_skills_requires_account_context`。RAG/resource/registry 组合回归覆盖实际 ToolPort dispatch，Skill 相关 Node Host 测试合计 **10/10 通过**。Node 端使用隔离 SQLite 和合成 owner/技能 metadata；生产 PostgreSQL 与 Provider Run 未验收，Python pytest 本轮未运行。`list_skills` 从“已实现待接入”改为“部分实现”；管理写工具保持未开放。

2026-11-17 Agent Runtime Core 当前树复验：先确认 Core Runtime 源码、对应测试与 devserver 哈希一致，再于 devserver 重建 Core；Core 上下文 builder、dispatch worker/supervisor、interaction recovery **4 个测试文件、17/17 通过**。Host Chat service、Context Assembly、Runtime、Reconstructor 与 dispatch Harness **15 项：13 通过、2 跳过、0 失败**，跳过需隔离 PostgreSQL/Redis。首次直接 Vitest 调用被共享 `tests/suites.json` 发现/分类不一致阻断，随后使用 `/tmp` 临时 Vitest 配置仅选择四个 Runtime Core 文件通过；临时配置已清理。没有改动 suite 清单。Core 与 devserver 源码哈希匹配；本轮未跑 Host production typecheck。验证覆盖合成端口与 `main.ts → createApp(agentChat) → Core AgentChatService → dispatch worker → Reconstructor` 装配，不代表真实 PostgreSQL/Redis claim、Provider、跨进程恢复或部署服务验收。

2026-11-17 Agent Runtime Core 唤醒契约：交互恢复后的 owner/session dispatch 唤醒现由 `packages/core/src/agent/chat-service.ts` 的 `AgentChatService.wake()` 统一校验活动 Run 并发出通知/Worker kick；Host 响应适配器只在持久交互提交后传递已认证 owner 和 session。Core build 通过；devserver `agent-chat-service.test.ts`、`agent-interaction-respond.test.ts` **11 通过、2 跳过、0 失败**，跳过为需隔离 PostgreSQL 的事务用例。相关源码与测试运行前哈希一致。Host production typecheck 首次因 main.ts 与 devserver 尚未同步的旧画布回调诊断失败；确认文件哈希一致后重跑通过。此接口尚未在 `main.ts` 创建/注入交互响应服务，因此危险工具仍保持禁用；不能视作生产交互接入或 PostgreSQL 恢复验收。

2026-11-18 Agent Runtime / 七项危险工具 Host 接线：Core 新增公开 `AgentChatService<I>` 跨端契约，Web HTTP route 复用该 Core 类型；Core 持有 Chat lifecycle 和 owner/session wake，Host 只组合 PostgreSQL、Redis、Fastify 与既有事件投影。`main.ts` 已注入 PostgreSQL 可信交互激活、事件投影、持久响应/恢复入队与 Core wake；无新增 HTTP route。七工具中 `delete_event`、`canvas_delete`、`canvas_delete_note`、`canvas_disconnect` 和含删除的 `canvas_batch` 仅在当前主密钥可用时进入 per-lease registry，各 action 使用独立确认 gate；owner/session/run、账号安全版本、Provider access version 与当期 lease 在准备及写事务中校验。发现 fence 会在确认恢复时递增，因此确认 epoch 只由权限版本构成，执行时仍要求当前 fence/token 有效，避免把旧 lease 权限误当长期确认。Core build 在 devserver 通过；Host 六文件 Node 回归 **56 通过、2 个需 PostgreSQL 的用例跳过、0 失败**；Python 日历/提醒/画布/删除撤销/幂等基准 **66/66 通过**。Web Host production tsc 仍被并行终端文件 `modules/terminals/websocket.ts` 的缺失 `ws` 类型声明及两个隐式 any 阻断，本轮改动文件无诊断。真实 PG/Redis 确认 claim、Provider Run、提醒消费者、跨进程恢复和部署 Host 未验收。Mutagen `gugu2-0` 仍有三处冲突，未 flush。

2026-11-17 知识写工具 Run 回归验收跟进：本地与 devserver 对本次 8 个 TS 源码/测试文件哈希一致，无需 flush 即运行 devserver。Core `knowledge.test.ts` **7/7**、Core typecheck 通过；Host `agent-rag-tool-ports.test.ts` 与 `agent-web-rag-resources.test.ts` **8/8**，后者经实际 resource factory registry dispatch 保存、更新并从 owner FS 回读。Web Host production `tsc -p tsconfig.build.json --noEmit` 有 **2 项诊断**，均在未改动的 `sandbox-egress.ts`，为推断配置类型缺少 `network_profile`；本切片文件未报诊断。Python `test_knowledge.py`、`test_read_knowledge_tool.py`、`test_tool_schema_validation.py` **142/142**；首次运行一项因临时 venv 未构建 Cython 扩展失败，随后将两个扩展编入 `/tmp` 并重跑全组通过。Python 源码和三项 pytest 哈希均与 devserver 一致。使用临时 SQLite/FS、合成 lease/PG authorization 与 Provider/embedding；Cython/venv/temp 配置退出时清理，未触及真实服务。

2026-11-17 `read_conversation` Web Run 接线：`main.ts` 现在按 dispatch lease 注入 `createAgentConversationReadPort(pool)`；Reconstructor 仅当存在该 owner-bound 端口时将 `read_conversation` 加入可信配置，配置过滤器同步允许它，发现及执行仍复验同一 lease。Node 回归经真实 Core production RAG 组合器、工具 registry 和 ToolPort dispatch 验证仅有端口时可发现并读取合成正文；旧隔离 PostgreSQL host adapter 测试本轮因未配置专用 PG 跳过。devserver Core build、Host RAG/历史读取测试 **9 通过、2 个 PG 用例跳过、0 失败**，Web Host production `tsc -p tsconfig.build.json --noEmit` 通过。Python 基准为 `backend/tests/agent/test_conversation_read_parity.py` 与 `backend/tests/agent/test_tool_isolation.py::test_read_conversation_cross_user/test_read_conversation_owner_ok`；本轮未运行 Python pytest。真实 PostgreSQL、Provider Run、桌面 SQLite Host 未验收，故工具仍为“部分实现”。

2026-11-17 `get_current_time` Web Run 接线：`main.ts` 按可信 lease 注入 Host 时钟和 Core ContextData 的 owner 时区读取端口，Reconstructor 只在时钟端口存在时开放授权；模型参数不能覆盖时区，tool result 保留旧字段和 registry 的忽略字段说明。与 `read_conversation` 合并后 devserver Core build、RAG/历史读取/时间 Node 测试 **9 通过、2 个隔离 PostgreSQL 用例跳过、0 失败**，Web Host production typecheck 通过。Node 新组合回归使用隔离 SQLite 和合成 owner/timezone/lease；Python `backend/tests/agent/test_time_tool.py` 本轮未重跑，先前单测通过记录不作为本轮结果。真实 Provider Run 和 PostgreSQL 时区读取未验收，状态为部分实现。

2026-11-17 RAG/会话工具当前树复验与历史记录更正：保持 `gugu2-0` 同步冲突未 flush；本轮所涉 Host/Core 源码和测试哈希与 devserver 一致。Core build 通过；`agent-rag-tool-ports.test.ts`、`agent-web-rag-resources.test.ts`、`conversation-tools-runtime-sqlite.test.ts` 经实际工具注册器、Core SQL reader 和隔离 SQLite 执行 **14/14 通过**；Web Host production `tsc -p tsconfig.build.json --noEmit` 通过。新增读取断言先因 fixture 的 `limit` 窗口预期错误而失败，核对 Python `list_messages` 后按“结构化消息先被 SQL 排除，再取最近 N 条普通消息”修正测试数据预期，未改变生产逻辑。Python 基准沿用本轮前已通过的 `test_conversation_read_parity.py`/`test_tool_isolation.py` 定向结果 **4 通过、62 deselected**；本次未重跑 pytest。工具表和本 README 已更新：`search_conversations`、`read_conversation`、`search_memory` 及知识读写现接入生产 Web Run。所有 Node 工具链验证使用临时 SQLite/FS、合成 lease/Provider/Redis 与 mock embedding；真实 PostgreSQL、Redis、Provider、桌面 Host 和进程恢复仍未验收。较早记录中的“主链尚未接线”“知识写端口尚未验收”保留作历史记录，不代表当前状态。

2026-11-17 `global_search` Web Run 接线：复用 Host 已有 `createGlobalSearchOperations(createPostgresGlobalSearchSources(pool))`，由每个 lease 的 RAG resource factory 注入现有 Core 工具注册器；只有端口存在才加入配置和授权，仍逐次重验同一个 dispatch lease。模型提交的 `owner_id`、`per_type` 不改变可信 owner/每类 20 条上限；工具缺少指定来源明确报不可用。Core 注册器/SQLite 工具回归 **5/5**、Host RAG/工具/历史调用链 **15/15**、Web Host production typecheck 通过；Python `test_global_search.py` 与 `test_search_scenarios.py` **27/27**。Python 通过临时 venv、fakeredis 与隔离 SQLite 执行；Node 使用隔离 SQLite/合成 lease，未连接真实 PG、Redis、Provider。首次 Core suite 入口因共享 `tests/suites.json` 漂移拒绝加载，未改清单，随后用自动清理的 `/tmp` Vitest 配置只选择目标测试通过。此次生产代码接线依赖 Host 已有 PostgreSQL 共享搜索来源，但没有真实 PostgreSQL 或 Provider Chat 端到端验收。

2026-11-17 RAG/知识工具当前 Run 回归复验：devserver Core build 后，`agent-rag-tool-ports.test.ts`、`agent-web-rag-resources.test.ts`、`conversation-tools-runtime-postgres.test.ts` 合并 **12 项：10 通过、2 个需隔离 PostgreSQL 的用例跳过、0 失败**；Web Host production `tsc -p tsconfig.build.json --noEmit` 通过。Node 行为覆盖 owner memory 检索、trusted lease 授权、read_knowledge、save/update knowledge 经实际 resource factory/registry 写入和回读、conversation owner port 条件暴露以及 Host 时区覆盖模型参数。使用隔离 SQLite/FS、合成 Pool/lease/Provider 与 owner 数据；未连接真实 PG、Redis、embedding Provider 或生产 Run 服务。Python RAG/knowledge 基准沿用此前 devserver 118/118、142/142 记录，本轮未重跑。`search_memory`、`read_knowledge`、`save_knowledge`、`update_knowledge` 状态从待接入/依赖阻塞归为部分实现；Worker 唯一消费者与真实后端仍待验收。

2026-11-17 `list_events` / `get_upcoming` Web Run 接线：Core 工具使用 owner-scoped 日历活动+提醒读端口、项目 Core 服务、可信 Host 时钟/时区；main per-lease 资源提供 Kysely 端口，Reconstructor 仅按端口存在条件启用，并由当前 dispatch lease 授权。Node `agent-calendar-write-ports.test.ts`、`agent-rag-tool-ports.test.ts` **10/10 通过**，Core build 与 Web Host production typecheck 通过；Python `test_readonly_tool_migration.py::test_registered_upcoming_uses_context_day_and_scoped_live_resources` 和 `::test_registered_calendar_preserves_reminders_filters_and_owner` **2/2 通过**。测试源码/用例哈希在运行前与 devserver 一致；Python 测试使用临时 venv 和合成 SQLite/owner 数据。真实 PostgreSQL、Provider Run 和部署服务未验收，故两工具保持部分实现。

2026-11-17 `list_clients` / `list_projects` Web Run 接线：两者复用总是随 Core SqlDataRuntime 注册的 owner-scoped 只读工具；Host 仅允许这两个只读名称进入配置，并按同一 dispatch lease 复核执行。Node `agent-rag-tool-ports.test.ts`、`agent-calendar-write-ports.test.ts` **11/11 通过**，覆盖当前 owner 结果、异主数据隔离、Schema/registry 发现和失效 lease 拒绝；Core build、Web Host production typecheck 通过。Python `test_project_tools.py::test_list_projects_filters_status_and_archived`、`test_core_data_bridge.py::test_web_contact_compatibility_uses_shared_storage_and_owner`、`test_parallel_tool_policy.py::test_phase2_project_and_calendar_reads_preserve_user_scope` **3/3 通过**。Python 联系人覆盖源于 Core 共享服务/owner 基准，仓库未发现独立 list_clients Agent dispatch pytest。使用临时 venv、隔离 SQLite 和合成 owner；真实 PostgreSQL/Provider Run 待验收。

2026-11-17 `get_dashboard_stats` Web Run 接线：main per-lease resources 注入 Core `createKyselyDashboardCounter` 和可信 Host 时钟，Reconstructor 仅在两个端口均存在时加入配置，执行授权仍绑定当前 dispatch lease；统计 owner、软删和未来活动筛选复用 Core 端口。Node `agent-rag-tool-ports.test.ts` 在临时 SQLite 上显式创建最小 Host `files` 表，验证真实 registry dispatch、异主客户端/项目/文件排除、软删排除、未来日历计数和忽略模型 `owner_id`；合并 Node **11/11** 通过，Core build、Host production typecheck 通过。Python `test_readonly_tool_migration.py::test_registered_dashboard_counts_all_live_files_and_unbounded_future` 与本组日历/项目/联系人相关 pytest 共 **6/6** 通过。生产 PostgreSQL 与 Provider Run 未验收，状态为部分实现。

2026-11-17 `list_workspaces` / `get_workspace` Web Run 接线：main per-lease 注入 Core `createAgentWorkspaceQueries(createKyselyAgentWorkspaceReader(...))`；只有工作区读端口存在时，Reconstructor 才配置和授权两个只读名称。Node 合并实际注册器/dispatch 回归 **11/11**，覆盖停用工作区、项目关联名、异主列表过滤、异主详情不存在语义；Core build 和 Web Host production typecheck 通过。Python `test_readonly_tool_migration.py::test_registered_workspaces_keep_disabled_order_and_safe_related_names` 与 dashboard/calendar/project/client owner 基准共 **7/7** 通过。临时 SQLite 为 Host 工作区/文件表创建显式最小契约表；真实 PostgreSQL/Provider Run 未验收。

2026-11-17 `get_project` Web Run 接线：main 按 lease 注入 owner-scoped 文件概览端口，Reconstructor 仅在端口存在时加入工具发现与授权；项目查询复用 Core 共享数据服务，文件计数委托 Host `readProjectFileOverview`。真实注册器 dispatch 回归通过，并验证 Host 端口拿到可信 owner、Core 返回当前 owner 项目及文件概览结果。Linux devserver `agent-rag-tool-ports.test.ts` 定向 **2/2**、`agent-web-rag-resources.test.ts` **1/1**；Core `domain-reads.test.ts` **5/5**。本机 macOS 的同一 Host FS 集成测试因 `packages/fs` 生产原子写明确拒绝非 Linux 平台而失败；代码/测试哈希一致后在 Linux 重跑通过。Python 项目详情基准既有 **7/7**，本轮因两端无 pytest 未重跑。Host production build typecheck 通过；全测试 tsc 尚被其它测试类型错误阻断。真实 PostgreSQL、Provider Run 未验收；逐工具状态更新为部分实现，静态工具分类更新为待接入35/部分实现24。

2026-11-17 `list_scheduled_tasks` Web Run 接线：main 按 lease 注入 Core `createScheduledTaskQueries.agent`，任务行先经 owner 与 `event_id IS NULL` 查询，再用 Host workspace/filesystem 授权能力投影；不包含日历提醒，不接受模型传入的 owner。Reconstructor 仅在真实端口存在时加入配置/授权，dispatch 重查当前 lease。隔离 SQLite 上实际 registry dispatch 覆盖自有独立任务、排除活动提醒和异主任务、返回指令并忽略伪造 owner；Core Host 定向回归 **2/2**。此前独立 Host Runtime/PG 契约用例已有覆盖；Python `_list_scheduled_tasks`/`_to_dict` 行为已逐项对照，但本轮两端均无 pytest，且本工具未发现专属旧 Python pytest。生产 PostgreSQL/Provider Run 未验收，状态为部分实现；分类更新为待接入32/部分实现27。

2026-11-17 `list_trash` Web Run 接线复核：Host `main.ts` per-lease 提供真实 PG 回收站查询 adapter；缺少端口时不注册，工具发现与执行都复验 lease。隔离 SQLite/合成只读端口的 Core registry dispatch 覆盖 owner 绑定、模型伪造 owner 被忽略、时间倒序、文件/目录合并限额和满额提示，工具不产生写副作用。Linux devserver RAG/lease Host 定向 **3/3** 通过，含此工具调用；另一个生产知识 FS 行为用例 **1/1** 通过。Host 的真实回收站 SQL PG 用例本轮未运行；Python list_trash 基准本轮未运行（本机和 devserver 均无 pytest）。Host production build typecheck 通过；真实 PostgreSQL/Provider Run 仍待验收。当前总数待接入31、部分实现28。

2026-11-17 `restore_file` / `restore_folder` Web Run 接线：`main.ts` 按可信 dispatch lease 装配现有 `createAgentTrashRestorePort(core, fileRestores)`，复用 PostgreSQL owner-scoped 文件恢复服务和 Core 持久调用收据；Reconstructor 只有在 Host 提供端口时才允许配置，并在每次发现/执行时校验同一 lease。Node 合成 Host 组合用例经授权器、生产 RAG registry 和真实工具 dispatch 验证两工具仅随端口出现、lease 撤销后权限关闭、文件恢复结果从专用端口返回；不触发真实磁盘写入。已有隔离 PG/临时 FS 端到端测试覆盖文件/文件夹副作用、父目录回收站边界、异主隔离、重复调用/并发/提交应答丢失，当前环境需配置专用 PG 才能执行，本轮未运行；Python pytest 当前不可用，基准未重跑。该切片状态调整为部分实现，不代表真实生产 PostgreSQL 或 Provider Run 已验收；总数待接入29/部分实现30。

同日当前树复验：与 devserver SHA-256 一致后先构建 Core，再运行 RAG 授权/资源、索引 Worker、知识 FS 和文件恢复相关 Host 回归，**26 通过、4 个需隔离 PostgreSQL 的用例跳过、0 失败**；Core RAG **9 文件、69/69**，Host production typecheck 通过。四个 PG 跳过项包括恢复提交收据/并发及文件恢复数据库集成；没有真实 DB 验收。Python pytest 在 devserver 不可用（`python3 -m pytest --version` 显示未安装），本轮未运行。Mutagen 三项冲突未 flush，临时 Vitest 配置已移除；工作区其他未提交修改保持原状。

同日 Local/Ollama embedding transport 复验：先确认 `agent-rag-transport.ts`、`query-embedding.ts`、Node Provider 网络限制实现和两个对应测试文件的 SHA-256 与 devserver 一致，再运行 Host 本机 transport 与 memory tools **7/7 通过**。用例通过合成 loopback HTTP 服务验证只有 trusted Local/Ollama query 能访问本机，云端 Provider 指向相同地址仍被拒绝；未调用真实 Provider。配置默认禁用，仅 BYOK resolver 为显式 Local/Ollama 返回 `allowLocal=true`，每请求再次由 `embedRagQuery` 限定标记。README 旧记录称生产 transport 固定关闭本地访问，已更正为 transport 能力上限与请求标记双门。

2026-11-17 `list_trash` 当前树复验：Core 工具通过生产 Web RAG resource factory、可信 lease 授权和实际 registry dispatch；Host `main.ts` per-lease 注入既有 PostgreSQL 回收站 reader。Node `agent-rag-tool-ports.test.ts` **10/10** 通过，验证伪造 owner 被忽略、Unicode 数字 limit 规范化、混合文件/顶层目录排序与限额、微秒时间保留、满额提示和无写副作用；Core build 与 Web Host production typecheck 通过。Python `test_readonly_tool_migration.py::test_registered_trash_keeps_top_level_microseconds_and_limit_warning` 在 devserver 临时 venv **1/1** 通过，配置文件路径与 pytest 缓存均隔离；旧参考实现未改。Mutagen 冲突未 flush，测试前对应文件 SHA-256 一致。当前详细表复核为已实现待接入 **29**、部分实现 **30**、依赖阻塞 **49**、退役/重设计 **1**，共 **109**；真实 PostgreSQL reader 与 Provider Run 未验收，故 `list_trash` 保持部分实现。

2026-11-18 `canvas_create_note` / `canvas_add_node` / `canvas_update_node` / `canvas_remove_node` / `canvas_update_note` / `canvas_update_anchor` / `canvas_connect` / `note_delete` / `note_restore` / `note_undo` Web Run 接线：新增工具组级 per-lease `createWebAgentCanvasMutationPorts`，复用 Core Mind 放置、布局/便签/关系编辑、普通笔记软删/恢复/Undo 服务、事务收据和发布适配；Reconstructor 仅在端口存在时注册，并通过同一 dispatch lease 授权。Host `agent-rag-tool-ports.test.ts` **11/11** 通过，真实 registry dispatch 覆盖画布便签创建/更新、引用放置、关系连接/端点更新、视图移除但保留来源节点、布局更新、note 删除/恢复/Undo、缺端口不可见、异主拒绝和 lease 撤销。Core 放置/编辑/笔记生命周期行为 **31/31**、devserver Core build 和 Web Host production typecheck 通过。首次测试使用旧 Core dist 缺模块，重建 Core 后通过；一次回归断言受新写入顺序影响，已调整为保留原分页行为后重跑通过。测试使用临时 SQLite、合成 lease/Pool、文件行和发布回调；Python mind/canvas pytest、真实 PostgreSQL、Redis、Provider Run 与生产发布未验收。当前 109 项：已实现待接入 **10**、部分实现 **49**、依赖阻塞 **49**、退役/重设计 **1**，没有工具记为完整生产验收。

2026-11-18 `create_project` / `update_project` / `set_color` / `archive_project` / 五个项目阶段工具及 `get_tool_schema` Web Run 接线：`main.ts` per-lease 暴露共享 Core PostgreSQL 项目创建事务和 `createDurableProjectMutationPort`；项目更新/阶段复用现有 Host `createPostgresProjectUpdateRuntime`，不另写 SQL 业务；授权配置仅在对应端口出现时增加项目写工具，`get_tool_schema` 仅读取当前租约注册器能力。Host `agent-rag-tool-ports.test.ts` **12/12** 通过，实际 dispatch 覆盖 Schema 查询、项目创建并回读、状态/优先级更新、颜色、归档/取消归档、阶段新增/重命名/待办更新/整体设置/删除及 lease 撤销。Core project create/durable mutation/stage/read/registry 五套测试 **100/100**。Host 项目工具测试使用临时 SQLite；项目更新 runtime 的目录重命名/file count/发布回调为合成端口，Core durable 行为测试另以临时目录验证持久回执、真实目录改名补偿、并发和重建重放。Python pytest 在 devserver 未安装；真实 PostgreSQL、Redis、Provider Run 与生产目录副作用未验收。Web Host production typecheck 本轮被 `main.ts:1720` 的 `AgentChatService.wake` 缺失，以及 terminals 子模块导出/`ws` 类型错误阻断；没有项目工具接线文件诊断。109 个静态工具当前：已实现待接入 **0**、部分实现 **59**、依赖阻塞 **49**、退役/重设计 **1**，完整验收 **0**。
2026-11-18 TS RAG 当前树验收：`main.ts → createApp(agentChat) → Web Run lifecycle → Reconstructor → createWebAgentRagResources → lease-bound RAG registry/context` 已形成生产装配；启动仍要求 Redis、正式 RAG schema migration，Node Worker 只有显式设为唯一消费者才运行。Core `tests/agent/rag` **9 文件、69/69**；Host RAG/Run/Worker/Jieba/向量/共享语料 **35 通过、1 跳过、0 失败**；Core `tsc --noEmit` 与 Web Host production `tsc --noEmit -p tsconfig.build.json` 通过。Core 当前 dist 的 RAG、knowledge、meta 产物与本轮 TypeScript 临时构建一致；Host 使用临时 SQLite/FS、合成 lease/Pool/Redis/授权及 mock embedding/Provider。唯一跳过是生产知识写入资源工厂集成，因 owner FS 原子写要求 Linux；同时修正了 `get_tool_schema` 加入后的工具目录期望。Python pytest 本机未安装，本轮未运行；最近一次隔离 Python/Cython RAG、旧工具与共享语料基准为 **118/118**（11-17）。真实 PostgreSQL/Redis、Provider、部署恢复与 Node Worker 唯一消费者切换尚未验收；普通 owner memory 文件更新与反思 producer 仍由 Python 生产，Node 侧提供持久索引投影、scope 授权状态、刷新队列与 Web owner `search_memory`。
补充 Reconstructor 集成回归：`agent-web-reconstructor.integration.test.ts` 与 `agent-persistent-runtime.integration.test.ts` **2 通过、2 个需隔离 PostgreSQL/Redis 的用例跳过、0 失败**；覆盖可信 Web owner/session memory 边界、取消、checkpoint scope 与恢复授权。需 PG/Redis 的生产 dispatch、重启恢复用例未在本机运行。

2026-11-18 Agent Runtime 2.0 边界复核：跨端的 Chat start/resume/cancel 编排、dispatch worker/supervisor、上下文 builder、交互恢复协调、prompt 描述规则和 Provider/Harness Runtime 均由 `packages/core/src/agent/` 提供；Web Host 保留 Fastify 路由适配、PG/Redis 持久队列与可信身份/权限/凭据/平台端口装配，没有重复的 Host Runtime 实现或 Core→Host 依赖。Core build 通过；Context/Provider Runtime 与 dispatch/recovery 六个 Core 测试文件 **96/96**，prompt-description **2/2**；Host Runtime、Chat 与 reconstructor 六个用例文件 **12 通过、4 个需隔离 PG/Redis 的用例跳过、0 失败**；Core prompt-description 加 Host wiring、权限/确认与 registry 合并七个文件 **41 通过、3 个需隔离 PostgreSQL 的用例跳过、0 失败**。Host production typecheck 仍被与本次 Agent Runtime 无关的 `terminals/websocket.ts` 缺少 `ws` 声明及其两个隐式 any 诊断阻断。真实 PostgreSQL、Redis、Provider Run、重启恢复与生产部署尚未验收；Host 测试端口不代表生产接入。

2026-11-18 七项日历/画布工具增量回归：devserver 源码哈希一致后，Host 提醒目标解析、日历/画布写端口、确认身份与 RAG 组合 registry **21/21**；Core `calendar-create`、`calendar-update`、`calendar-delete`、`canvas-edits`、`confirmation` **54/54**；旧 Python 日历/提醒、事件更新/删除、画布确认/批处理、Undo 与幂等 pytest **66/66**（串行，临时/合成数据）。Node Host 使用 Core SQLite 和合成 Pool/lease/投递 resolver；回归验证了当前 owner 与 lease、取消、提醒落库与撤权、确认缺失时危险工具不可发现、确认目标身份和实际 registry dispatch。旧 Python 实现未改。devserver 未配置隔离 PostgreSQL 测试 URL，且 PostgreSQL 服务未运行；真实 PG 确认 claim/并发/回滚、真实提醒投递消费者、Redis 持久恢复，以及生产 Provider 后续轮仍未验收。故七项均保留“部分实现”，不将本轮 SQLite/合成端口测试当作生产 Agent Run 验收。

2026-11-18 Agent Runtime 日历/画布续轮回归：Core build 通过；Core 日历创建/更新/删除、画布编辑和确认 **5 文件、54/54**；Host 日历/画布端口、确认、registry、Reconstructor 与 persistent runtime **6 文件、34 通过、2 个需隔离 PG/Redis 的用例跳过、0 失败**。devserver 运行前已比对相关 Core 与 Host 源码/测试哈希。Web Host production typecheck 未通过：出现并行改动 `agent-interaction-command-effects.ts` 的 14 个隐式 any，以及 `modules/terminals/websocket.ts` 缺少 `ws` 类型和 2 个隐式 any；本次触及的 Core/Host 工具文件无诊断。用例经 Core `createAgentRuntime`、Core ToolRegistry 和 Host 写端口依次调用七项工具：`create_event`、`update_event`、`delete_event`、`canvas_batch`、`canvas_delete_note`、`canvas_disconnect`、`canvas_delete`；Provider 后续请求读取前序结果并作用于同一活动、便签、关系和画布。五项危险操作都验证确认前无副作用、Runtime 进入 waiting、恢复确认后成功；校验日历提醒共享 Worker 任务契约、删除后停用，画布便签与视图同步软删、关系软删、级联删除保留来源节点，并检查适用操作的 Undo 收据。Provider transport、lease 状态查询、确认 gate/receipt/事务 claim 和提醒 resolver 为合成依赖；这些回归证明 Core Runtime→ToolPort→SQLite→Provider adapter 的续轮与确认恢复，不证明真实 PostgreSQL、Redis、持久确认、真实提醒投递或外部 Provider 已验收。devserver 临时目录已清理，未改动同步工作树；Python 参考实现未改，本轮未重跑 pytest：devserver 虚拟环境缺少 pytest，系统 Python 也未安装 pytest。当前 PG/Redis 服务未运行且隔离测试 URL 未配置。七项工具仍为“部分实现”，生产 PG 并发与 Redis 重启恢复仍未验收。

2026-11-18 `ask_user` 普通澄清工具接入：修复了工具实现与生产配置之间的断点。Main 的 per-lease 工厂显式开启 `askUser`，配置过滤允许其进入当前 Run；授权工厂只有收到该能力开关才发现，并在每次 dispatch 复验 owner/session/run 与选中 lease。普通 `choice`/`question` 仍通过 Core 交互协调器，Host 以现有 PostgreSQL prompt/action/binding、回答消费与 Run resume 队列持久化；没有新增执行器或旁路交互协议。Web Host `agent-rag-tool-ports.test.ts` **13/13** 通过，新增用例验证能力关闭时不可发现、打开时真实 registry dispatch 进入 waiting、lease 撤销后拒绝；Core prompt-description **2/2**、Core 与 Host production TypeScript 检查通过。Python pytest 本轮未运行；没有真实 PostgreSQL/Redis/Provider 或进程重启验收。按契约继续限制 `form` 与 `authorization=user_sandbox`，不开放半成品表单或沙盒授权；因此工具仍列“部分实现”。

2026-11-18 `read_file` 普通文本读取 Web Run 接入：新增 per-lease Host 文件端口，只接受模型给出的正整数 `file_id`，使用 PostgreSQL `files` 表同时限定当前 owner 和未删除记录，校验 storage key 属于该 owner 后调用 `packages/fs.openLocalFile(storageRoot, storage_key)`；无物理路径参数、无宿主路径回退。Core 已有工具保持原始物理行号、32 MiB 上限、UTF-8/无后缀差异与取消关闭句柄行为。Host `agent-file-read.test.ts` 的真实生产 registry dispatch **1/1** 通过，使用真实临时 FS、合成 Pool/lease；Core files 工具行为 **49/49**。本轮合并 Host RAG/file/registry **39/39**、Core files/registration **81/81**、Web Host production typecheck 与 `git diff --check` 通过。Python pytest 本轮不可用，真实 PostgreSQL 未验收；PDF/Office 提取、图片/音频/视频、历史附件、URL、批量、逻辑路径及 system scope 仍未实现，工具仍列“部分实现”。

2026-11-18 日历提醒消费者路径核验：Core `calendar` 创建器把提醒写入共享 `scheduled_tasks` 表，记录 `schedule_kind='once'`、`@once:` 触发时间、提醒 payload、lead、channels 与 Host 解析的 `delivery_targets`；Core Runtime 行为回归验证了这些共享行字段及删除后的停用状态。旧 Worker 的 `app.scheduled_tasks.reconcile()` 从该表重建启用任务，`execute_task()` 调用现有 Agent 执行及 `deliver_to_channels()`。本次只读检查观察到 devserver `gugu-worker` 处于 active，说明该环境存在既有消费者路径；未创建或投递合成提醒，也未验证其生产数据库连接/实际渠道投递。当前 devserver 缺少 `backend/.venv/bin/pytest` 且系统 Python 无 pytest，本次计划重跑的提醒/任务消费者 pytest 未启动；此前记录的日历/提醒与画布 Python 回归 **66/66** 仍是最近一次实际通过结果，不把本次未启动计为通过。

2026-11-18 `send_link_buttons` Web Run 接线：复用 Core 的 Python 对齐 URL/按钮校验和 Web artifact 投递端口；Main 每个 lease 注入仅匹配同一 owner/session/run 的 Web 端口，配置、发现及 dispatch 授权均要求该端口且复核活动 PostgreSQL dispatch lease。生产 RAG registry dispatch 回归覆盖安全按钮 artifact 进入结果，以及租约撤销后拒绝调用。该切片只覆盖 Python `_send_link_buttons` 的 Web `_artifact` 分支；QQ/飞书/微信真实网关、可信 IM 收件人/凭据和持久投递回执未接入，因此工具从依赖阻塞调整为部分实现，不能宣称全平台完成。测试使用临时 SQLite、合成 Pool/lease；真实 PostgreSQL、Redis、Provider 和浏览器渲染尚未验收。

2026-11-18 Web Run provider 工具白名单补齐：检查 Main 的静态过滤集合与 Web lease authorization 工具集合，修复联系人写入、项目创建/修改/阶段、工作区更新、`global_search` 以及此前遗漏的 Canvas/Note 工具在 provider binding 阶段被提前剔除的问题。`delete_client` 接入后 64 个 authorization 工具名均可通过配置过滤；最终工具发现和每次 dispatch 仍由当前 lease、授权及真实 Host 端口决定，白名单本身不会开放缺少后端的工具。Node `agent-tool-registry.test.ts` 行为用例覆盖各受影响工具组名称并拒绝未知名称；`agent-rag-tool-ports.test.ts` 保留真实 Mind/项目/联系人/搜索 registry 调用覆盖。真实 PostgreSQL、Provider Run 和 Python pytest 未验收。

2026-11-18 `delete_client` 调用链增量：Core 客户工具组新增 owner-scoped 单/批量删除，确认快照绑定目标行，业务事务内 claim、锁定并复核目标后删除且写操作收据；Host 没有持久确认与一次性 claim 能力时不注册。Core clients suite **20/20**、Host RAG/registry **41/41**；Host 新增真实 Core SQLite 注册器经 lease 授权→确认等待→恢复删除，以及租约撤销后拒绝调用的实际工具链。其他行为覆盖确认前无副作用、owner 隔离、目标并发变更回滚、批量结果与 claim 拒绝，并按 Python 边界验证批量缺失 ID 错误和 `client_id=0` 回退联系人名。旧 Python `test_confirm_gate.py -k "delete_client or batch_delete_grant"` **4 通过、37 deselected**；临时 site-packages、fake Redis、内存 SQLite、临时存储及不存在的 env 文件路径，未连接真实服务。Node 测试使用临时 SQLite、合成确认/claim 与合成 PostgreSQL lease 查询。production TypeScript 检查被工作区其他文件 `agent-interaction-command-effects.ts` 的隐式 any 和 `terminals/websocket.ts` 的 `ws` 类型缺失阻断；当前切片文件未报诊断。真实 PostgreSQL、Provider Run 和跨进程确认恢复未验收，故仍为部分实现。

2026-11-18 TS RAG 当前树复验：Core RAG **9 个文件、69/69**；Host RAG registry/资源、Reconstructor、持久 Worker/索引损坏恢复、owner memory store、Jieba 固定语料和 embedding transport 合批 **34 通过、2 跳过、0 失败**。跳过项分别依赖隔离 PostgreSQL/Redis 重启环境和 Linux 安全原子写。Web Host production TypeScript 检查通过。修复了生产 RAG 检索将可关闭 Node Provider transport 当作共享实例复用的问题：索引重建保留独立生命周期，检索每次 embedding 创建新 transport；新增 loopback HTTP 回归验证第一次查询关闭实例后第二次仍能取到真实向量（Host RAG 合批现为 34 通过）。Python pytest 本机不可用，最近隔离 Python/Cython RAG 基准为 **118/118**（11-17），本次未重跑。Node 用例用临时 SQLite/FS、合成 lease/Pool/Redis 与 mock embedding/Provider；真实 PostgreSQL、Redis、Provider、部署恢复和 Node Worker 唯一消费者切换未验收。普通 owner memory 更新与反思 producer 仍由 Python 执行。

2026-11-18 隔离服务复验补充。devserver 使用临时 PostgreSQL 和 Redis，持久调度、取消、outbox 重放和 Web Reconstructor 回归 **5/5**，其中 `search_conversations` 经生产注册器分派并进入合成 Provider 的下一轮。Reconstructor 的历史语料与索引位于独立 SQLite。RAG Worker 与会话工具组合使用临时 SQLite **15/15**，PostgreSQL 的持久队列与索引迁移 **6/6**。新增回归证明两笔 PostgreSQL 事务抢写同一 owner/来源时，首次扫描不会覆盖先提交的待处理任务，并能继续为其他来源入队。旧 Python 队列 pytest **3/3**，验证合并重试以及 Node 为消费者时 Python 仍可持久化事件。真实 Provider、部署切换与当前缺失的工具端口仍按清单验收。

2026-11-18 `search_conversations` 的 Reconstructor 恢复用例已使用正式 PostgreSQL 索引。两名用户的事实数据经 Host 入队，由 Core Worker 投影到迁移后的索引表。Registry 调用和自动 RAG 均使用同一 PostgreSQL 和可信 lease，验证正确历史进入 Provider 续轮且异主正文不进入任何请求。与 PostgreSQL 队列、迁移、Redis 持久调度及恢复合跑 **11/11**。Provider transport 为合成依赖，未在真实外部模型或部署服务运行。

同轮旧 Python 会话检索 pytest **4 通过、4 个非会话用例未选中**，覆盖压缩水位之前的历史、owner 隔离、多关键词和旧消息 ID 的会话归属。测试使用内存 SQLite 和 fake Redis。

2026-11-18 记忆向量重建与 Web Run 复验。Core **4/4** 覆盖分块、缓存清空及索引失败状态；Web Host **16/16** 覆盖生产 owner 锁、两种源档案的并发更新、损坏主档案不回填旧 facts、`remember` 收据恢复、会话持久索引和 Redis 重启恢复。实际使用临时 PostgreSQL、Redis 和 Local 文件，Provider、embedding 与部分索引通知使用合成依赖。旧 Python 的记忆存储、迁移、批量重建和 BYOK **55/55**，验证旧档案规则、分块与 owner 切换。最终无失败或跳过。Python 与 Node 的跨进程写入尚未共用同一锁，`remember` 保持未注册。

同日补齐查询向量隔离和 `remember` 增量向量回归。新增用例先复现两个用户同句查询命中同一缓存，修复后 Core **13/13** 验证 owner、端点、凭据变化以及拒绝覆盖较新向量缓存。Web Host **7/7**，其中回环 HTTP 验证同 owner 可复用、异主必须实际发送各自请求；隔离 PostgreSQL 和临时文件验证 `remember` 恢复后只生成缺失向量、重复调用不再生成、保留已有向量及正式索引入队。旧 Python `remember`、记忆存储与查询 embedding **55/55**。Node 查询缓存比旧 Python 的模型加查询缓存键更严格。Provider 和凭据使用合成数据，未调用外部服务。

2026-11-18 迁移方向收口到 Node。上轮 Python 共享写锁改动已撤回，当前回归使用 Node 独立的授权、共享 PostgreSQL 用户锁、档案任务状态和持久收据。 Node Host 最终合批 **43/43**，无失败或跳过。临时 PostgreSQL、Redis 和文件目录中的 Run 由合成 Provider 同轮调用 `search_conversations` 与 `remember`，实际 ToolRegistry 校验租约，档案与两阶段收据正确落地，下一轮收到工具结果。其余回归覆盖八类正式索引来源、队列补建与恢复、旧计划拒绝重放和档案任务期间的写入门禁。Core 构建与 Host 生产类型检查通过。

同轮 Node Core **14/14** 与 Web Host **10/10**，覆盖全量重建拒绝覆盖同源新缓存、记忆清理与索引墓碑、持久收据恢复及 Local 向量文件并发。使用临时 PostgreSQL、SQLite 与 Local 文件。Web Host 生产类型检查通过；Core 全量构建当前报 MCP 管理类型错误，定向测试使用本轮已生成的 Core 产物。无测试失败或跳过。

同轮索引队列回归 **Node 25 通过、0 跳过，Python 7 通过、9 未选中**。隔离 PostgreSQL 验证日历、笔记、项目在全量任务运行期间收到增量写入时会保留全量范围、撤销旧租约，重建完成后可以重新排入单实体任务。隔离 SQLite 验证日历和笔记的排队分支。Python 验证持久队列合并和配置读取失败时的消费者边界。提交后通知依赖使用合成回调。

2026-11-18 来源补建复验。隔离 PostgreSQL 的生产 Worker 消费两名用户的 16 条补建任务，八类来源全部写入正式索引。覆盖跨用户读取、群记忆墓碑、空知识目录以及非空旧目录缺标记时保留原索引。Host 合批 **23/23**，Core 知识来源定向 **1/1**，Python 知识时间迁移、owner 与增量基准 **7 通过、35 未选中**。Host 使用临时 PostgreSQL、Redis、SQLite、授权文件目录与合成 Provider。

## 指定 21 项迁移进度

按当前逐工具表统计，本范围有 **12 项已完成并接入、7 项部分实现、2 项依赖平台能力**。已完成项为 `send_email`、`call_tool`、`manage_mcp_servers`、`create_skill`、`update_skill`、`delete_skill`、`note_create`、`note_update`、`remember`、`create_scheduled_task`、`update_scheduled_task` 和 `delete_scheduled_task`。`react`、`bind_web_session` 的具体阻塞是当前树缺少实时 Node IM Gateway 调用方；其余部分实现项的逐项缺口见下表。

Web Run 通过 Main 每租约资源工厂、Web Reconstructor、Core Run ToolPort 与领域工具注册器装配。下表中生产接线表示源码调用链可达，实际注册仍取决于当前租约、配置、能力与确认端口。隔离 PostgreSQL/Redis 通过已有 Host 生命周期与部分领域链路回归。实际部署、真实渠道和付费 Provider 尚未验收。

本轮 devserver 的 `GUGU_WEBUI_TEST_DATABASE_URL`、`GUGU_WEBUI_TEST_REDIS_URL` 均未设置，默认本机 PostgreSQL/Redis 服务也不可用；需要隔离 PostgreSQL/Redis 的额外 `startServer` 验收当前无法运行。不得改用用户运行数据库或配置，因此这项测试基础设施缺口只影响尚缺 Host Run 证据的工具；下方已有的历史隔离集成结果不记作本轮复跑。

| 工具 | Node 位置及进度 | Python 基准与剩余验收 |
| --- | --- | --- |
| `web_search` | Core `tools/search.ts`，Web `main.ts` 按 lease 经 `agent-search.ts` 绑定 Provider 配置和安全出站端口后交给 Agent ToolRegistry | Python `test_provider_web_search.py` 本轮 **33/33**（此前与项目删除确认用例合批 **35/35**）；Core Provider/工具测试 **66/66**，Host `agent-search.test.ts` **4 通过、1 跳过**（隔离 PG URL 未配置）。本轮新增 Core Harness→Host 搜索端口→Provider 续轮行为测试；Node 传输替身覆盖原生 Provider 参数、结果限制、权限撤销与安全传输。`main.ts` 的 `startServer` 生产装配搜索续轮、PG/Redis 和部署仍未验收 |
| `similar_image_search` | `tools/search.ts` 与 Web 搜索端口；可信附件或受限 URL、图片检查、上传前租约复核、独立日额度与持久收据 | Python `test_similar_image_search.py`、`test_web_download.py` 合批 **15/15**，含旧版数字字符串 `max_results` 归一基准；Core `tests/agent/tools/web.test.ts` **13/13**，覆盖字符串数值归一后范围校验。既有隔离 PostgreSQL验证独立额度、撤权和已知/未知结果恢复；外部付费 Provider、代理和实际部署待验收 |
| `deep_research` | `tools/search.ts` 与 Web 搜索端口按用户或平台凭据接入同步 Provider；外呼前持久认领并预留额度，成功结果与用量同事务提交 | Python provider/搜索结果限额对照同上 **21/21**；隔离 PostgreSQL 验证并发配额和结果恢复。外部付费 Provider、代理和实际部署待验收 |
| `web_download` | Core `tools/web.ts` 在可信 Host 上传端口之前处理流、容量和重试；对可重试的 timeout/network 错误最多重试两次，沿用 1s/2s 退避，取消等待即停止；HTTP 状态、容量错误与未知提交结果不重发。生产 Web 按租约使用安全出站和共享 Local 上传。Core 解析个人、项目、绑定或默认工作区；Host 在写入事务中复核当前会话落点、容量及租约，并写入文件、配额事件和收据。提交断连后按收据、文件登记及硬链接归属核对。结果 URL 省略查询参数 | Python `storage/files/test_web_download.py` 与相似图基准合批 **15/15**；Core `tests/agent/tools/web.test.ts` **13/13**，覆盖中断流与瞬时网络失败重试、退避取消及 HTTP 503 不重发。隔离 PostgreSQL 和真实文件验证默认/显式工作区、跨目录拒绝、绑定变化、取消、失租、超限、已提交重放及确认回滚后的清理。公网正文使用替身。恢复数据库不可用或进程退出时保留待核对文件，跨进程自动清理、实际公网和生产部署待验收 |
| `react` | Core `tools/im.ts` 和 `im/feishu-bot-api.ts`，可复用 Host 在 `tools/agent-im.ts` 按可信消息和已启用 Bot 安装工具，发送成功后回调平台回应标记 | **平台依赖阻塞**：当前没有实时 Node Gateway 调用方；Gateway 需提供可信当前消息及标记写入端口。Python `test_feishu_gateway_guards.py`；已有隔离传输回归覆盖伪造消息字段、异主、撤权、取消、成功标记和未知响应。真实飞书送达未验收 |
| `group_context_search` | `tools/im.ts`、`sessions/im-tools.ts`，由 Web Host 定时群任务的可信任务与 Bot 归属装配，发现和执行复核当前范围 | 当前 Python agent 源码快照上的 `test_telegram_im_policy.py`、`test_scheduled_group_imctx.py`、`test_im_members.py`、`test_im_identity.py` **69/69**；隔离 PG/Redis 的生产定时入口验证工具结果续轮与撤权。实时 Node IM Gateway 尚未接入 |
| `send_email` | 已完成：Core `tools/email.ts` 接 Agent ToolPort；Host `main.ts` 按 Run 装配 `agent-email.ts` 与受控 SMTP 适配。Web 对话持久确认/取消，定时任务校验预授权与租约 | 本轮 devserver Python `test_email_tool.py`、`test_email_attachments.py` **27/27**；Node Core **4/4**，Host SQLite **1 通过**，PG/Redis 条件测试 **2 跳过**（URL 未配置）。同一源码历史隔离 PG/Redis 持久 Run 确认/取消 **8/8** 与定时生产入口环回 SMTP **3/3** 通过；真实外部 SMTP 和部署未验收 |
| `bind_web_session` | Core `tools/im.ts`、`sessions/im-tools.ts` 与可复用 Host `tools/agent-im.ts` 支持可信私聊绑定。与定时 IM 历史共用 Bot 隔离的 12 小时 Redis 键 | **平台依赖阻塞**：当前没有实时 Node Gateway 调用方；Gateway 需提供可信 owner 私聊身份。隔离 PostgreSQL/Redis 已验证目标归属、撤权、切换、重放及定时历史读取；旧 `test_im_owner_session.py` 通过。实时 Gateway 入站与真实投递未验收 |
| `delete_knowledge` | 生产 Host 按 lease 绑定知识 ID、owner 及文件字节版本；计划收据与加密意图认领及目标索引撤回同事务，恢复复核原文件或墓碑版本 | Node 隔离 PostgreSQL/真实授权文件目录回归覆盖确认失败恢复、文件发布后提交失败及重放、历史保留和精确索引撤回；另覆盖 Redis 确认、PostgreSQL 恢复、确认前无副作用、取消、异主和重放。旧 Python `knowledge.py::_delete_knowledge` 的工具级确认→墓碑→RAG 事件回归本轮新增并在 devserver **1/1**；真实 Provider 和部署待验收 |
| `remember` | 已完成并接入：Web Host 仅在 Linux、PostgreSQL 收据及 Node RAG Worker 就绪时注册；可信 owner Run 复用档案锁、文件版本、持久收据、向量增量刷新和正式索引队列 | 当前 Python `test_remember_tool.py` **6/6**；Node Host 通过生产 ToolRegistry/Run 写入 owner 档案并续入 Provider，历史隔离 PostgreSQL/Redis/Local 回归 **43/43**；Core **2/2**、当前 Host SQLite **6/6**。当前 Node Host 不会与 Python 进程共用档案锁；2.0 生产写入由 Node 独占。Provider 使用合成响应，实际部署未验收 |
| `call_tool` | Core `tools/call-adapter.ts`、`run/tool-ports.ts`；Host 只注入当前 Run 授权及目标执行端口。Harness 在计划前有限解析目标，在计划、分派及确认恢复时复核入口和目标，转发来源随新检查点保存 | Node Core `tool-ports.test.ts`、`input-feedback.test.ts` 本轮 **21/21**；正式 `startServer` HTTP/SSE 集成在隔离 PostgreSQL/Redis 上实际调用嵌套工具并验证持久副作用、拒绝和原调用 ID 续轮（历史 **1/1**）。Python `test_tool_schema_security_contract.py -k call_tool` 本轮 **2/2**。使用环回合成 Provider；真实外部 Provider 与部署待验收 |
| `manage_mcp_servers` | 已完成：Core `tools/mcp-management.ts`，Web 按可信 owner/lease 注册七类配置动作；删除使用持久确认，Header 凭据经私密表单加密存储 | Python `test_mcp_settings_api.py`、`test_mcp_user_tools_e2e.py` **42/42**；Node Core **6/6**、Host 隔离 PostgreSQL/Redis **9/9**。覆盖删除、新增、凭据轮换、确认取消/批准、认证私密表单、配置版本漂移拒绝、密文保存、缓存失效和持久 Run 续接；续轮与操作收据不含凭据。真实外部 MCP 连接及生产部署待验收 |
| `create_skill` / `update_skill` | `tools/skill-management.ts` 借用共享管理器事务，生产按可信租约接线。写入与当前 Run 收据共同提交 | `test_user_skills.py` 23/23。隔离 PostgreSQL 与 SQLite 覆盖并发创建、ID 和结果形状、重放、越权、撤权回滚及部分字段更新。实际部署、外部 MCP 和真实 Provider 续轮待验收 |
| `delete_skill` | 同一模块，Web 每租约持久确认、精确版本和事务 claim，所有管理来源均确认 | `test_user_skills.py` 23/23。隔离 PostgreSQL 和 Redis 从确认码兑换到 Core Run 恢复，验证取消、异主和防重放。实际部署与真实 Provider 待验收 |
| `note_create` / `note_update` | `tools/note.ts`，复用 Mind 事务、Undo、调用收据和 RAG，Web 注入可信时区及发布器 | `test_mind_agent_tools.py` 定向 6/6；SQLite 和隔离 PostgreSQL 行为通过，外部 Provider 未验收 |
| `delete_project` | 按可信租约注入共享软删、依赖确认、文件移动日志和后台恢复；项目、日历与提醒索引入队和调用收据共用删除事务 | Node 隔离 PostgreSQL/Local 文件覆盖注册器调用、回收站文件、回滚、索引入队和重放；Python `projects/test_project_tools.py::test_delete_project_requires_confirmation_before_trash` 与 `agent/test_confirm_gate.py::test_delete_project_requires_confirm` 已通过（与 `test_provider_web_search.py` 合批 **35/35**）。用户确认与 Provider 为未外呼的合成依赖 |
| `create_scheduled_task` / `update_scheduled_task` | Core 工具复用 PostgreSQL 共享写入，经 Web 每租约注册；仅在装配 Node 消费者时开放，按任务类型校验一次性或周期 Worker。支持 Web 通知、owner 邮箱和已验证归属的 QQ/飞书私聊目标 | Python `test_scheduled_task_schedule_rules.py` 定向 **3/3**；Core `tests/agent/tools/scheduled-tasks.test.ts` **2/2**，覆盖上海时区精确窗口、部分更新保留、原收据重放、owner/授权拒绝和缺少持久授权交互时不开放完整沙箱授权。生产 `startServer` Run 经隔离 PostgreSQL/Redis 创建停用的一次性任务并更新名称/指令；Host `task-writes-postgres.test.ts` **4/4**。另有实际授权端口、消费者禁用拒绝、私聊重绑、启停、RAG/收据回滚与重放回归；预授权邮件 Core **7/7**、Host **8/8**、Python **30/30**。实际外部 SMTP、生产部署、完整沙箱授权、群投递和工作区执行待验收 |
| `delete_scheduled_task` | `tools/scheduled-tasks.ts`，复用定时任务删除、索引与事务 claim，生产按确认端口接线 | 隔离 PostgreSQL 和 Redis 验证真实确认码、跨 owner 拒绝、取消、批量删除、索引入队、收据和结果续轮。旧 `test_confirm_gate.py` 与任务工作区回归合批 51/51。Provider 与通知回调为合成端口，实际部署待验收 |

Skill 关联 Schema 通过同一可信 Run 注册器按需发现。动态 MCP 名称须来自当前 owner 的目录，且同时通过当前租约的配置和授权。Skill 正文或 `related_tools` 不授予执行权限。

定时 `send_email` 生产入口复验 **Host 3/3、旧 Python 27/27**。临时 PostgreSQL 保存任务预授权和持久邮件尝试/结果，临时 Redis 提供任务租约。已授权任务将邮件投递至环回 SMTP 的合成收件人，撤权后模型续轮收到拒绝，异主运行返回 404。定时 Worker 和手动 Run 均由生产入口装配。Web 对话单测仍使用合成确认投影。公网未连接，运行入口夹具没有装配全量 Agent 扫描和 RAG 迁移。

`delete_skill` 回归使用真实 Redis 确认码、加密意图、PostgreSQL 提示/动作及 Core waiting checkpoint。经现有 Web 响应服务兑换确认后，恢复实际 Core 工具执行，删除与业务收据同事务，然后进入合成 Provider 续轮。确认前及异主动作不删，取消不再请求 Provider，也不产生删除收据，重复提交确认令牌不会二次执行。devserver **Core 4/4、Host 5/5、旧 Python 23/23**。Core 构建、Host 生产类型检查和 `git diff --check` 通过。夹具使用合成 Provider、可信摘要和隔离数据库，直接调用 Web 响应服务。HTTP 生产部署待验收。

`react` 与定时飞书投递共用 Core 固定端点、访问凭据请求和有界响应读取。Host 从可信 Run 获取入站消息，按 owner 和 Bot 查询启用状态，并在取得 Token 后复核消息、Bot 和凭据版本。仅飞书明确接受后调用回应标记端口。飞书明确拒绝返回失败，出站断连保留未知结果，恢复不重发。隔离 PostgreSQL 与合成飞书传输验证伪造消息字段、异主、取 Token 后撤权和取消、成功标记及响应未知。devserver **Core 5/5、Host 21/21、旧 Python IM 18/18**，Core 构建、Host 生产类型检查和 `git diff --check` 均通过。实时 Node Gateway 尚未接通，外部飞书送达和生产部署仍待验收。

`bind_web_session` 的可复用 Host 端口只为可信 owner 私聊生成工具。事务持有 Web 会话的共享行锁，复核当前 Run 和平台身份后覆盖对应 Redis 键。Core 路由读取会复核 Web 会话归属。旧 Python 工具使用无 Bot 后缀的键，实际私聊路由在已知 Bot 时使用带后缀的键。Node 让同一可信 Bot 的写入和读取一致，未指定 Bot 的调用沿用无后缀协议。定时 IM 历史写入复用相同键并经实际 PostgreSQL 和 Redis 测试将结果写入新绑定的 Web 会话。未验收实时 Gateway 入站和真实外部送达。devserver **Core 5/5、Host 11/11、旧 Python IM 18/18**，Core 构建、Web Host 生产类型检查和 `git diff --check` 通过。首轮可移植入口检查发现定时 IM 历史通过 Agent 根入口加载 Kysely，改由现有 sessions 子入口导出后通过。

`web_download` 与终端复用 Core 工作区目标查询。目标全省略时按会话绑定、用户默认目录顺序解析；显式 `workspace` 只使用当前可信目录，项目或文件夹绑定时返回旧版的目标提示。显式个人或项目目标仍由文件库 owner 校验。下载阶段不持有会话读锁，写入事务借用同一连接复核绑定。隔离 PostgreSQL 回归覆盖下载期间重新绑定后两个目录均无落盘且没有成功收据。旧 Python 回归运行 `storage/files/test_web_download.py`、`test_create_file_workspace_space.py` 和 `test_folder_workspace_write_access.py` 共 **12/12**。Node 最终 **Core 22/22、Host 16/16**，Core 构建、Host 生产类型检查和 `git diff --check` 通过。首次 Core 工作区用例的 SQLite 初始化超时，最终复跑为 devserver 临时提高测试钩子等待时间。未连接真实公网。

`web_download` 提交断连后由同一 Host 进程用新连接按相同顺序获取操作和 owner 上传锁。原文件已有收据或该路径已有文件记录时保留正文。确认无记录且目标仍与本次暂存文件指向同一 inode 时才清理正文。路径已被替换时保留替换文件，恢复查询错误时保留正文和暂存证据。工具继续通过原收据恢复已提交结果，回滚不写配额事件、成功收据或变更通知。devserver **Core 22/22、Host 18/18、旧 Python 12/12**，Core 构建、Host 生产类型检查和 `git diff --check` 通过。隔离 PostgreSQL、真实临时文件及合成 COMMIT 故障覆盖提交成功响应丢失、回滚、路径替换和恢复读失败。没有跨重启清理器，未连接真实公网。

Skill 创建和更新按 owner、会话、Run、轮次及工具调用 ID 生成收据，收据仅保存工具结果。同一调用并发只分配一次 ID，更新从事务锁定的当前记录合并，失去授权时正文、序列和收据一起回滚。重建只读收据，改变输入拒绝重放。devserver Core 构建及定向 **41/41**，Web Host **21 通过、1 项 Python 对照跳过**，显式注入隔离 Python 后补跑通过。旧 Python `test_user_skills.py` **23/23**。`git diff --check` 通过。Web Host 生产类型检查仍受并行新增的 `agent-owner-reflection-model.ts` 缺 `BranchPorts.nextId` 阻塞，未改动该文件。

`deep_research` 的 Tavily、You.com 和百度接口与旧 Python 一样在单次请求返回最终结果。Core 通过现有操作收据在外呼前认领该调用，Web 在同一事务复核 Run 权限及账号日额度。成功用量与受限报告共同提交；已知失败释放预留；结果未知的尝试在额度窗口内保留预留，恢复只读收据。隔离 PostgreSQL 验证同一账号并发仅一次外呼、已提交结果可重放、改变参数拒绝、断线防重发、真实租约撤权，以及已知失败后额度仍可用。合成上游覆盖截断后的报告继续带截断说明。devserver Core **493/493**、Web Host **31/31**、旧 Python **10/10**，Core 构建、Web Host 生产类型检查和 `git diff --check` 通过。首轮新集成比较了 JSON 记录的进程内原型，改用可观察的序列化结果后通过。真实付费 Provider、代理与部署尚未验收。

`similar_image_search` 与 `deep_research` 共用按账号持久认领，但相似图只统计相似图调用。深度研究沿用总搜索计数，纳入在途相似图预留。公网图片下载完毕后在付费上传前再复核租约。已知失败释放额度，未知结果不重新上传，重复调用读回持久结果。隔离 PostgreSQL 与合成上游回归覆盖计数、图片归属、下载后撤权、结果截断和断线恢复。devserver Core **494/494**、Web Host **31/31**、旧 Python **21/21**，Core 构建及 Web Host 生产类型检查通过。真实付费 Provider、代理及部署待验收。

`call_tool` 在预计划、分派和确认恢复时均复核入口及目标的最新授权。新检查点通过可信字段保存转发来源，回执解码器验证其与原调用匹配；旧检查点仍可读，只有携带转发来源的新调用执行入口级复核，旧调用仍由目标工具的既有授权处理。Web 隔离 PostgreSQL/Redis Run 经实际重建和注册器验证嵌套别名读取所属会话、写入 owner 记忆、拒绝配置隐藏工具，并按外层 ID 返回结果。Provider 使用合成传输。devserver Core **139/139**、Web Host **51/51**、旧 Python 定向 **35 通过、160 项未选中**，构建、Web Host 生产类型检查和 `git diff --check` 通过。首轮 Host 复跑发现回执编码器未接受新可信字段，修正后通过。

定时群任务的 `group_context_search` 复用共享群历史和成员读取。发现 Schema、直接工具调用及关联工具发现都复核任务的有效 Bot、owner、平台与群目标；查询前后再核对绑定。生产 `main.ts` 测试经隔离 PostgreSQL/Redis 和合成 HTTP Provider 验证只将当前群消息送入续轮，并覆盖模型首轮后 Bot 停用的拒绝。独立定时运行用例也验证停用 Bot 或移除投递渠道后隐藏 Schema。devserver Core **26/26**、Web Host **8/8**、旧 Python IM **102/102**，Core 构建、Web Host 生产类型检查和 `git diff --check` 通过。Python 首次收集缺少隔离副本的 `worker.py`，补齐后复跑通过。实时 `react` 和 `bind_web_session` 仍无 Node Gateway 调用方，分别需要飞书可信当前消息与对应 Bot 投递、可信 owner 私聊身份与 Redis 绑定写入装配。生产定时测试禁用 QQ 外部投递，实际 IM 渠道及部署未验收。

2026-11-18 Runtime 收敛：Web 主入口经过 `createWebAgentReconstructor` 使用 Core `agent/run/reconstruct.ts`，由 Core 校验检查点、授权版本与 Provider 作用域，并负责运行释放。`agent/run/event-stream.ts` 负责提交后事件重放与断线续读，`agent/interactions/consume-action.ts` 负责一次性动作、取消、过期及可信事件重放。Web Host 提供 owner 限定锚点、持久状态、PostgreSQL 事务、确认码兑换、Redis 唤醒和 Provider 绑定。共享上下文 builder 接受构建出的快照，定时任务可复用此契约而无需 Web 会话持久化记录。此改动覆盖共用运行链，工具可用性仍按上表的能力与授权确定。

2026-11-18 Runtime Core 行为复核：`runtime.ts`、`chat-service.ts`、`run/dispatch-{worker,supervisor}.ts`、`run/reconstruct.ts`、`run/event-stream.ts` 和 `interactions/` 承载共用 Harness/Chat/Run、队列恢复、身份/版本校验、事件重放及交互编排；Web Host 仅装配认证 owner、PG/Redis、Provider/工具资源、HTTP/SSE 和启停。新增 `packages/core/tests/agent/chat-service.test.ts` 覆盖启动投影、idle resume、异主拒绝和取消租约；`portable-boundary.test.ts` 现在直接把六个 Runtime 模块作为依赖闭包入口，防止共用编排回退到 Host 或引入平台依赖。devserver 标准 Core unit 配置下 Run、Interaction、Provider Runtime 与可移植依赖边界 **8 个文件 77/77**。生产 Web Chat/Run 与 HTTP Interaction Respond/Resume 已接入 dispatch 生命周期；真实 PG/Redis 重启、桌面持久端口、Provider 与部署未验收。

Runtime devserver 回归共通过 Core 43 文件 558 项、Host 31 项、Python 94 项。Host 使用隔离 PostgreSQL/Redis、合成 Provider 和合成用户，覆盖运行重建、交互单次消费、等待恢复、取消和事件重放。Python 执行 `test_run_cancellation.py`、`test_run_lifecycle.py`、`test_run_finalize.py`、`test_user_skills.py`、`test_skill_id_migration.py`、`test_interaction_protocol.py`、`test_interaction_phase5_7.py`、`test_interaction_retention.py`。Core 构建与 Web Host 生产源码类型检查通过。全量 Core 测试源码类型检查仍报告其他套件的类型错误。桌面 Host、真实 Provider 及实际部署待验收。

持久 Chat、dispatch Worker 与恢复扫描的组合现由 Core `agent/runtime.ts` 负责。Web 主入口仍以既有 Host 工厂装配 PostgreSQL、Redis、可信消息准备和 SSE 投影，并管理进程启停。Web 持久执行与 SSE 共用 Core `agent/run/event-stream.ts` 的 checkpoint 状态规则。devserver 冻结副本通过 Core **178/178**、Web Host **24/24**、Core 构建及 Web Host 生产类型检查。集成用例经共享调度入口，使用隔离 PostgreSQL、Redis 和合成 Provider 验证重启后扫描、取消首轮及执行后续 Run。Skill 回归同时验证 Core 的 `resources/skills/` 中 10 份 Markdown 通过文件头自动注册，查看正文及关联工具仍经过当前 Run 授权。本轮 Runtime 迁移未重复运行 Python。桌面接线、真实 Provider 和部署待验收。

Agent Runtime 入口依赖复核发现 `@gugu/core/agent` 会间接加载 Kysely、Node 加密与持久数据模块。RAG、知识、记忆写入和持久交互用例现由各自的 Core 子路径导出，Host 调用方同步切换。`call_tool` 继续沿用兼容 Python 的工具名去空白规则，共用参数辅助函数改为只加载错误契约。摘要预算和初始化由 Core 处理，无效预算不调用 Host 授权端口，并发首次摘要共享同一 Run 投影。Chat 和定时任务共用 Core 多轮工具用量汇总。Web 保留认证、当前 Run 授权、PostgreSQL/Redis、网络、凭据及 SSE 投影。移除了无调用方的 Web 交互 Worker 包装器，生产恢复仍经 Core dispatch。

devserver Core **65 文件、704/704**，含 Runtime 可移植入口的依赖闭包、摘要和 Skill 目录。Web Host **63/63**，含隔离 PostgreSQL/Redis 上的 Run 重建、取消、交互和事件重放，以及合成 Provider 续轮。Host 首轮 **62 通过、1 项重建超时**，相同源码复跑仅关闭临时 PostgreSQL 的 fsync，全部通过。旧 Python `context/test_compaction.py`、`test_run_lifecycle.py`、`test_run_finalize.py` **90/90**。Core 构建、Web Host 生产类型检查和 `git diff --check` 通过。桌面 Host、真实 Provider 和实际部署尚未验收。

MCP Agent 连接检测：可信 Run 只能以 UUID 或名称解析当前 owner 的已保存配置，再由生产 Host 刷新实际运行时。握手成功返回已通过 Schema 校验和白名单过滤的工具名，失败只投影类型化的安全诊断。查询动作不计为写入，取消后不发布成功回执。已开始的共享握手仍由运行时限时管理。全局或单项停用时不外连，Web Host 继续禁用 stdio 与 URL 凭据。devserver 定向 Core 28/28、Host 35/35、Python 6/6，Core 构建和 Web Host 生产源码类型检查通过。隔离 SQLite 与合成 SDK/传输覆盖归属、重新发现、取消和脱敏，外部 MCP 服务及实际部署待验收。

MCP Agent 启停：复用 `mcp/server-mutations.ts` 的 owner 限定配置写入，只更新启用标志及时间。事务内核对活动 Run、dispatch fencing、账号状态和访问版本，并原子清除该账号的持久工具快照及提交收据。提交后失效进程内连接，启用时尝试装载。装载失败保留已提交的启用状态并报告连接问题，取消和回执重放保留持久业务结果，无重复装载。devserver 最终 Core 29/29、Web Host 31/31、Python 5/5，Core 构建及 Web Host 生产类型检查通过。Node 覆盖隔离 SQLite 和 PostgreSQL，PostgreSQL 用例经过实际租约查询及工具注册器。握手和 Provider 版本读取使用合成依赖，实际部署和外部 MCP 服务待验收。

MCP Agent 非凭据更新已接入 Web Run，复用共享设置页写入事务。端点、工具白名单及自动确认变更需要可信持久确认，确认绑定具体配置版本和输入。已有凭据或凭据槽位的服务须通过设置页更新连接地址。Web Host 继续只支持受控 HTTP 执行，Agent 地址更新拒绝内嵌凭据、查询参数与片段，回执仅显示地址来源。配置、确认认领、快照失效与操作收据共同提交，失败回滚，提交后失效进程内目录。devserver 通过 Core 30/30、Web Host 31/31、旧 Python 8/8，Core 构建及 Web Host 生产类型检查通过。测试用隔离 PostgreSQL 验证实际租约授权、非凭据更新与重放，以 SQLite 和确认替身覆盖版本漂移、密封失败回滚及单次认领。真实 Redis 确认、外部 MCP 握手和部署待验收。

MCP Agent 添加无需凭据的 HTTP 服务已接入 Web Run。共享 `mcp/server-create.ts` 借用确认认领与操作收据事务，Node 设置页与工具创建按 owner 串行检查同名和配额。确认绑定服务名称、规范化配置及当前 Host 默认超时，回执仅显示端点来源。devserver 通过 Core 30/30、Web Host 35/35、旧 Python 8/8，Core 构建、Web Host 生产类型检查和 `git diff --check` 通过。隔离 PostgreSQL 使用真实租约查询、加密意图、确认认领和收据，验证确认前无业务行、伪造回执与默认值改变拒绝、加密失败回滚、重放及并发配额。测试使用合成 Web 确认投影与端点密封，无外部 MCP 请求。真实 Redis 确认及工具发起的凭据填写仍待验收。

MCP Agent 添加有 Header 凭据槽位的 HTTP 服务已接入 Web Run。配置、确认认领、加密填写意图和收据同事务提交；重放返回同一私密交互。既有私密提交入口在事务内重新核对 owner 和配置版本，凭据只进入密文存储，恢复队列只接收安全结果。devserver Core **34/34**、Web Host **43/43**、旧 Python 定向 **7 通过、29 项未选中**，Core 构建和 Web Host 生产类型检查通过。隔离 PostgreSQL 覆盖私密表单建立、回滚、跨 owner、配置改变和通过现有 HTTP 路由提交并恢复入队；确认投影和 Provider 使用测试替身。真实 Redis 确认、外部 MCP 和实际部署待验收。

MCP Agent 更新 Header 槽位复用共享设置写入、加密意图和现有私密提交入口。确认后清除旧凭据及旧工具目录，更换槽位返回新表单，空数组则清空槽位并完成。隔离 PostgreSQL 通过真实工具注册、租约、事务认领和操作收据验证确认前保留旧凭据、输入篡改拒绝、意图失败回滚、表单幂等重放和私密值重新提交。devserver Core **34/34**、Web Host **43/43**、旧 Python `test_mcp_settings_api.py` 定向 **10 通过、26 项未选中**，Core 构建和 Web Host 生产类型检查通过。确认投影与端点/凭据加密使用合成输入和测试端口，真实 Redis 确认和外部 MCP 未验收。

综合 devserver 回归：Core 14 文件 72 项通过。搜索/Provider 145 项及共享 Linux FS 8 项通过。Host registry/lease 等六文件 49 通过、1 个 PostgreSQL 条件用例跳过。随后临时 PostgreSQL/Redis 的 Host 组合独立通过 16 项，含该 Skill 管理用例；新增实际定时任务三项工具走 PostgreSQL 事务的用例另通过 1 项。Provider、平台投递、部分租约/确认端口使用合成数据或替身。Python 沿用未修改参考实现的临时副本，总计不同批次 **194、185、56、58** 项通过，批次有重叠。较早失败来自隔离副本漏拷入口或测试脚本和 MCP SDK 版本不匹配，已补齐隔离环境后复跑。

补充验收：Core build 与 Web Host production TypeScript 检查通过。devserver 的锁定 `@types/ws` 已缓存，本轮检查临时补上 Host 的依赖链接，结束后移除。最新 Host 邮件、搜索、租约注册及可信确认回归 **51 通过、2 个需 PostgreSQL 的确认用例跳过、0 失败**。Core 邮件回归 **2/2**，包括 SQLite 持久尝试收据及未知结果防重发。MCP UUID 批次 Core **28/28**，验证同名系统配置保留、版本变化拒绝、claim 回滚和重放。邮件 Hook 没有执行真实 SMTP。MCP 外部连接和剩余配置写入尚未验收。

`send_email` HTML 与持久确认复验：Core 构建、Web Host production TypeScript 检查与邮件 Core **3/3** 通过。devserver 临时 PostgreSQL 上，Web Agent 邮件与定时邮件共享端口 **8/8**，覆盖真实 PostgreSQL 加密意图、权限版本和事务内 claim，伪造回执与改变主题均拒绝，重建后读取持久结果且只调用一次 SMTP 替身。确认后的自定义 HTML 保留安全内容，删除事件属性、脚本与远程图片。旧 Python 邮件与附件 **27/27** 通过。新 PostgreSQL 实例仅监听临时 Unix socket，测试完成后清理。Web 交互提交和 SMTP 使用替身，实际部署及外部 SMTP 尚未验收。

定时任务消费者边界复核：现有 Python Worker 启动时和运行期间调用 `app.scheduled_tasks.reconcile()`，从共享表刷新启用任务，并由 `execute_task()` 执行及投递。Web Host 的 Node 周期定时器尚未接入进程生命周期。为接线补齐了 Node 定时器的分段等待、改期后的旧回调失效、快速停启期间的协调隔离，以及停止时等待已启动的协调和执行。devserver 虚拟时钟回归 **3/3**，旧 Python 调度规则与执行 **50/50**。首次 Python 副本缺迁移文件，补齐隔离副本后通过。定时任务创建和更新仍待选定生产消费者、装配真实执行与投递后再注册。未触发实际任务。

后续按实际 Node Worker 接线注册 `create_scheduled_task` 和 `update_scheduled_task`。Web Agent 与设置页共用 PostgreSQL 写入和投递解析；写入前和提交前检查账号、dispatch lease 与访问版本。启用状态的任务必须有对应消费者及可验证投递目标；更新私聊时拒绝旧绑定漂移，显式选择 owner 私聊可按当前绑定刷新。默认关闭的 Worker 开关与 Python 消费者切换沿用迁移任务清单。devserver 定向 Core **4/4**、Web Host **35/35**，包括真实 PostgreSQL/Redis 的生产 Host 启动、一次性和周期站内投递，Provider 为合成 HTTP 服务；旧 Python 计划、工作区、执行与群上下文 **71/71**。Core 构建与 Web Host 生产类型检查通过。扩大 Core 套件首轮发现定时运行的投递可选参数与既有测试断言不符（5 项）、RAG 测试固定时间早于入队墙钟（1 项），另有一个 `node:test` 文件被 Vitest 收集失败；该轮保留为失败记录。真实渠道、部署切换、群来源授权和工作区执行待验收。

补充验证了运行中的消费者。Agent 和 REST 的创建及更新事务提交后主动刷新本进程 Node Worker，避免任务在下一轮定期扫描前到期。新集成用例先启动 Worker，再经真实 Web 租约工具端口创建并更新一次性、周期任务，经隔离 PostgreSQL、Redis 和真实站内存储验证新正文只投递一次、一次性任务删除、周期收据结算；模型结果使用合成端口。生产 Host 启动另以合成 HTTP Provider 验证实际模型协议。全仓查证后删除四个无生产引用的旧 Node 文件，包括实验回看轮询、重复 PostgreSQL 计划与收据实现及 Core 转发。将实库行为测试改接共享仓储和收据，保留停用、版本冲突、竞态及未知结果防重放断言。先前 Core 扩跑的问题已修复，devserver 最终 Core **34/34**、Web Host **45/45**，构建、生产类型检查及 `git diff --check` 均通过。本轮未改 Python，仍引用前轮 **71/71** 对照结果。实际部署切换、跨进程近时通知、外部渠道和持久文件授权待验收。
2026-11-18 Web Host 资产迁移回归。Node 合批 **29/29**，无失败或跳过。对话和 IM 读取实际打包提示词；Admin 将更新原子写回同一根，后续上下文立即读取新内容。注册引导校验实际 MP3 格式；隔离 PostgreSQL 的播种及定时 Agent 使用临时文件和合成 Provider。Host 编译到独立临时目录后，在没有后端源码的发布布局中运行提示词和新手音频读取。部署镜像未执行。

同日 Web Host 运行路径回归 **46 通过、2 个历史跨语言用例跳过、0 失败**。Core 构建及 Host 编译通过，编译后的运行路径解析器在无 `backend/` 的独立目录读取临时配置，缺少显式 BYOK 密钥时明确拒绝凭据操作。Admin 日志回归验证显式文件优先、未授权拒绝、分页和 SSE。配置锁改成两个 Node 进程后复跑 **6/6**，覆盖并发原子保存、进程退出或崩溃释放以及损坏或缺失的配置拒绝写入。配置、日志与密钥使用临时文件和合成数据。

同日 Node 后台重启回归 **18/18**，无失败或跳过。调度生命周期覆盖停止失败抑制启动、并发重启合并和关机冲突。临时 PostgreSQL/Redis 的实际 Host 管理员路由验证重启后服务来自当前 Node 进程、旧心跳不参与控制、网关明确不可用。RAG 调度回归使用 SQLite 并覆盖任务领取、继续轮询及取消；实际定时 Run 使用合成 HTTP Provider。未向外部进程发信号，未调用真实 Provider。

同日 Node Web 反思队列与 Run **8/8**，无失败或跳过，Host 生产类型检查通过。隔离 Redis 行为回归覆盖同 Run 去重、阈值与闲置触发、按 owner 互斥、模型与访问作用域分批、稳定批次 ID、失租后的接管、过期回执和删除会话。隔离 PostgreSQL/Redis 的 Web Run 回归使用合成 Provider。该验证覆盖队列领取和回执，反思模型与入库消费者仍待接线。

同日 Node owner 反思档案发布与 `remember` 合批 **7/7**。使用隔离 PostgreSQL、Redis 和 Local 文件，并以合成结构化结果模拟反思模型。验证实际领取批次、异主和失租拒绝、文件已落盘但入队失败时的收据恢复、恢复不重新调用模型、状态并发变更后保留新值并重建当前索引，以及日记无重复、保留观察来源和向量失效。可信生产模型与调度在此轮验证范围之外。

接入生产 Host 生命周期后，devserver 反思队列、原模型恢复、档案发布和 `remember` **11 通过、0 失败、0 跳过**，Core 构建与 Host 生产类型检查通过。隔离 PostgreSQL、Redis 和临时文件覆盖回合定位、异主和群聊拒绝、繁忙会话延期、模型版本变化时无出站、实际 Provider 请求构造及用量、记忆发布、重建入队和收据恢复。Provider HTTP 传输使用合成响应，没有访问实际模型。未重跑 Python pytest，也未通过生产部署复验。

跨 Run 批次和恢复增量在 devserver 合批 **17 通过、0 失败、0 跳过**。隔离 PostgreSQL、Redis、临时文件及合成 Provider 验证同一签名范围内的两个 Run 只发一次反思请求，删去一个回合后剩余回合仍写入档案，超预算拆分保留队列顺序，正常停止后立即重新领取相同批次且旧回执失效。随后独立模型恢复 **5/5**，新增原预设删除拒绝及暂时配置故障仍可重试，另外四项与合批重叠。Host 生产类型检查通过，生产部署和真实 Provider 未验收。

单回合超预算恢复复验 **18 通过、0 失败、0 跳过**，Core 构建、Host 生产类型检查通过。隔离 PostgreSQL 与 Redis 的用例经实际 Node 分支请求和持久发布，验证包含换行、转义字符及补充平面字符的原文可按角色和顺序完整拼回、每次出站请求留出模型输出预算、最终只传摘要，且模型即使提议删除已有画像也不会写入删除。各阶段的模型用量均写入隔离 PostgreSQL。模型 HTTP 使用合成响应，生产部署和真实模型摘要质量尚未验收。

Web Agent 正式入口补验在 devserver **5 通过、0 失败、0 跳过**。新用例使用生产 `startServer`、真实 HTTP/SSE、隔离 PostgreSQL 与 Redis 及本地合成 OpenAI 协议对端。索引尚未迁移时普通聊天可完成，应用正式 RAG 迁移并重启后真实执行 `search_conversations`，检索结果进入模型工具续轮，异主会话不可订阅且异主标记不会出现在模型请求中，完成状态与回复已写入数据库。另覆盖持续调度取消后推进下一轮，以及可信重建器恢复。Core Provider 和 checkpoint **128/128**，Core 构建及 Host 生产类型检查通过。Node 测试的业务表为精简合成 schema，未验证全新生产数据库部署、真实外部模型或进程重启后的生产前缀恢复。本轮未改动 Python，未重跑旧 pytest。

Web Run 前缀恢复复验。隔离 PostgreSQL 与 Redis 中，首个 Harness 在持久工具结果提交后停止，另一个 Harness 从同一 Run 的加密 checkpoint 恢复。测试修改会话当前快照，验证模型续轮仍收到原前缀和已提交工具结果。模拟前缀格式漂移时，调度记录版本冲突且不发模型请求，恢复原格式后可继续。Core Provider、checkpoint 和重建 **133/133**，Host HTTP、重建和调度 **5/5**，Core 构建及 Host 生产类型检查通过。模型为合成，未做启动独立进程并强制退出的 HTTP/SSE 恢复验证，也未重跑 Python pytest。

独立 Node Host 强制退出复验 **1 通过、0 失败、0 跳过**。通过真实 HTTP 发起聊天，隔离 PostgreSQL 等到工具结果及空闲阶段提交，用仅存在于测试 schema 的触发器挡住下一次模型请求前的事务，随后强制退出首个 Node 进程。将合成旧租约推进到过期时间并改变会话当前快照，再启动第二个 Node 进程。已认证的 SSE 重连返回同一 Run 的完成事件与一次工具回执，第二次模型请求带有相同的系统前缀及已提交的工具结果。使用隔离 PostgreSQL、Redis 与本地合成 Provider，未连接真实模型，也未验收自然等待完整租约时长或生产部署。Core 构建、Host 生产类型检查通过。

Node Agent 调度正式迁移复验 **3 通过、0 失败、0 跳过**，Core 构建和 Host 生产类型检查通过。隔离 PostgreSQL 在已准备账号、会话、消息和交互提示表的空 schema 中，由 Node 事务创建九张运行表。并发申请只提交一份台账，结构漂移、异主或异会话锚点及异主交互提示会被拒绝。同一会话始终只有一条选中的调度记录，消息或交互提示删除会级联解除相关引用，建表失败不留下部分对象。生产 HTTP/SSE 用例改用正式运行表，覆盖真实工具续轮和独立 Host 进程强制退出恢复。原先的精简 text 字段掩盖了 PostgreSQL varchar 与 text 参数推断冲突，现显式统一阻塞原因参数类型。依赖为隔离 PostgreSQL、Redis 及本地合成 Provider，基础业务表全新部署、旧数据搬迁和生产部署仍待完成。

Node 独立初始化验收。隔离 PostgreSQL 从空 schema 运行 Agent 基础、Agent 调度和 RAG 索引命令，核对待迁移状态及退出码、应用后检查、重复应用与结构拒绝。基础表覆盖账号、偏好、会话、消息及批次、待发送队列、交互提示、附件元数据、用量与 RAG 重建任务。Node 从授权来源重建派生索引，原有未登记索引的数据保持原样。附件认领同时验证附件与目标消息的账号，通过真实 PostgreSQL 拒绝异主目标及已认领附件，并验证冲突时整笔回滚。生产 Host 测试使用正式 Agent 表，常规聊天在索引未应用时先持久化重建任务，应用后经 TypeScript RAG 执行会话搜索、模型续轮和 SSE。强制退出进程后按原 Run 恢复。隔离 PostgreSQL/Redis 的 Host 合批 **33 通过、0 失败、0 跳过**，Core 图片下载限流及重定向回归 **5 通过、0 失败、0 跳过**。迁移 CLI 实测、Core 构建与 Host 生产类型检查通过。合成模型和其他领域的少量表结构作为测试输入。HTTP 恢复用例此前出现一次超时，补充阶段诊断后连续两次通过。本轮使用 Node 验收，旧版 pytest 未重跑。运行环境、外部模型和向量 Provider、旧数据导入及整站空库部署仍待验收。

Node Web 业务初始化复验。新增 `migrate:web-domain:check/apply`，复用 Core 的项目、日历、Mind、定时、通知与 Undo 定义，在同一事务补齐 Web 所需的工作区、文件和配额，以及技能、Bot、记忆范围等表。项目根文件数由 PostgreSQL 在文件变更事务内更新，验证批量写入、移动、软删回滚、删除和同账号约束。迁移检查能发现触发器失效。生产 HTTP/SSE 与八类 RAG 来源用例由空 schema 执行正式 Node 迁移建立业务表，验证 `/health/ready`、普通聊天、会话搜索续轮及强制退出后的恢复。八类来源用例另覆盖文件授权、记忆墓碑与笔记工具写入后索引更新。devserver Host **30 通过、0 失败、0 跳过**，CLI、Core 构建和 Host 生产类型检查通过。使用隔离 PostgreSQL/Redis、临时文件及环回合成模型。本轮无需从 Python 安装数据库结构，未重跑旧 pytest。整站可选域、旧数据导入和真实外部部署单独验收。

首个账号 Node 调用链。空库生产用例改用真实注册签发的 Bearer 凭证，继续验证会话搜索、模型续轮及进程恢复。首次运行捕获了两个会让注册表面成功但引导回滚的契约错误：正式项目表曾拒绝空颜色，文件路径查询曾将项目日期字符串直接传给 PostgreSQL 日期格式化函数。现保留空颜色并在文件路径读取边界解析日期。注册事务独立建立基础配额及初始化事件，失败时与账号、偏好和工作区一起回滚。引导成功则同事务发布项目与日历重建任务，播种失败不会留下临时项目或伪造任务，账号仍可使用基础配额。Vite Cookie、真实 PostgreSQL 事务及合成写入失败用例覆盖上述行为。

本轮已运行的合批为 51 通过、1 失败、0 跳过，Core 构建、迁移 CLI、Host 类型检查通过。生产 HTTP 用例已执行到首个账号播种、普通聊天以及 Node Worker 落盘项目和日历索引，随后在共享工作区的 Admin 状态标签目录断言处失败。状态标签相关源文件同步确认后已启动包含五组文件操作的合批复验，结果仍待采集。旧版 pytest 本轮未重跑，未调用真实邮件或模型服务。

生产 HTTP 取消回归已补入正式迁移的 Web 用例。预期行为包括其他账号取消返回 404、当前账号取消只结束目标 Run、模型 HTTP 流关闭、已生成内容作为中断正文保存，以及同一会话能发起下一轮。该用例仍待隔离 devserver 执行。此前启动的完整复验进程仍在，独立 SSH 探针在握手阶段超时，目前没有新的退出状态或测试计数。

会话删除现在与 RAG 重建队列同事务提交。启用持久索引时同步撤下该账号、该会话的摘要和所有消息版本，并清空正文、标题、摘要、内容指纹和元数据。已领取旧代数的 Worker 提交时会失效。终端和派生索引由 Node Host 分别安装，空库部署可以在未装配这两项能力时删除会话，同时保留重建任务。PostgreSQL 回归已补充挂起旧 Worker、删除后的立即隔离、历史版本与内容指纹清空、队列失败时回滚和可选表缺席。devserver 原复验因磁盘 I/O 长时间无输出后已中断；随后只读哈希发现目标源码尚未同步，Mutagen 仍在扫描/暂存并报告生成目录冲突。本次新增回归尚未运行，不能用远端旧源码验收。

2026-11-18 `list_events` 生产工具调用补验。真实 `startServer` HTTP/SSE → 持久 Run → per-lease 工具 registry → Core 日历 reader → PostgreSQL → Provider 续轮 **1/1 通过**。随机隔离 schema 中验证本 owner 的活动和提醒进入结果、异主活动及异主提醒不泄漏；保留停用提醒、渠道数组、QQ 群投递模式，并确认提醒正文不会暴露。Core `domain-reads.test.ts` **5/5**，Host `agent-calendar-write-ports.test.ts` **2/2**。Python `test_readonly_tool_migration.py::test_registered_calendar_preserves_reminders_filters_and_owner` 此前有通过记录；本轮未运行 pytest（当前环境未安装），故历史结果不是本轮重验。Provider 使用环回合成端点，不涉及真实外部服务。Node 2.0 不引入 Python 桥接或回退。

同一生产调用回归继续验证 `list_clients` 和 `list_projects`：由合成 Provider 在真实 Run 中提出工具调用，可信 Host lease dispatch 到 Core owner-scoped 服务，联系人及项目列表进入模型后续请求，合成异主联系人与项目均被排除。真实隔离 PostgreSQL/Redis、`startServer` HTTP/SSE **1/1 通过**；Core `clients.test.ts` **20/20**、`projects.test.ts` **12/12**。Python `test_core_data_bridge.py::test_web_contact_compatibility_uses_shared_storage_and_owner`、`test_project_tools.py::test_list_projects_filters_status_and_archived` 及项目 owner 基准此前 **3/3**，本轮环境未安装 pytest，未重跑。由此两工具从“部分实现”更新为“已完成并接入 Web”；未因此推定其他项目/联系人写工具完成。合成 Provider 和隔离数据用于测试，生产部署及真实外部模型未验收。

同一真实生产 Run 随后调用 `get_dashboard_stats`、`list_workspaces`、`get_workspace`、`create_client` 和 `update_client`。Dashboard 的可信 owner 时区及 PG 计数进入续轮，联系人计数排除异主行；工作区列表与详情通过 owner workspace ID 读取默认目录；联系人创建和按名称更新均由真实工具调用执行并回读隔离 PostgreSQL 副作用。Host RAG/lease/工具组合 **15/15**，Core `domain-reads.test.ts` **5/5**，Core `clients.test.ts` **20/20**，生产 `startServer`/PG/Redis/合成 Provider 集成 **1/1**。Python 总览、工作区、联系人共享数据和 owner 基准此前有 **7/7** 通过记录，本轮 pytest 不可用而未重跑。上述五项更新为已完成并接入 Web；`delete_client`、`update_workspace` 仍需确认/写入边界及生产 PG/Redis 恢复验收，不随本次状态变化。Provider 为环回合成端点，生产部署未验收。

同一生产 Run 再调用 `create_project`，验证 Node ToolPort 以可信 Run 身份提交共享项目创建事务；隔离 PostgreSQL 回读到 owner 项目、默认 `pending`、`high` 优先级和三项标准阶段，Core 持久化阶段格式正常保留 key/todo 结构。真实 Host 集成 **1/1**、Core 项目工具 **12/12**；Python `test_project_tools.py` 创建默认阶段、优先级归一化、自定义待办及非法阶段回归此前在 **148 项合批**中通过，本轮 pytest 未重跑。该创建工具更新为已完成并接入 Web；同组更新、阶段、颜色、归档及删除仍逐项验收，不能因共享 Port 存在而标记完成。

真实生产 Run 随后在同一 owner 项目上调用 `update_project`、`set_color`、`archive_project`：摘要更新、语义色 `teal` 映射为既有渐变值、归档位变化均通过隔离 PostgreSQL 回读验证；项目更新和归档结果不触及异主项目。当前 Host 主链集成 **1/1**，其中项目工具实际执行覆盖 create/update/color/archive；Node Core 项目创建/修改/阶段测试历史合并 **100/100**，Python 项目工具业务基准此前合批通过，本轮未重跑。三项更新为已完成并接入 Web；待办/阶段独立工具与删除仍单独保留部分实现。已完成工具合计 16，部分实现 68。外部 Provider 未调用，生产部署未验收。

同一正式 Provider Run 继续连续分派项目阶段组五工具：`add_stage` 新增阶段、`rename_stage` 重命名、`update_stage` 新增待办、`set_stages` 按稳定 `s3` key 重排并保留待办、`remove_stage` 移除临时阶段。PostgreSQL 回读确认结果仅作用于 owner 项目、当前阶段随移除目标回退到剩余阶段，待办 id/text/done 保留。Agent Chat 生产集成 **1/1** 完整通过，Core 项目阶段/收据回归沿用历史 **100/100** 通过记录；Python `test_project_tools.py` 21 项项目/阶段基准已有记录，本轮未重跑（pytest 未安装）。五项阶段工具状态更新为已完成并接入 Web，静态清单现为完成 21、待接入 2、部分 63、依赖阻塞 22、退役/重设计 1。Node-only 运行；测试使用隔离 PG/Redis 和环回合成 Provider，无真实外部调用或生产部署。

`get_project` 随后在同一生产 Run 通过 Provider 工具协议读取真实 owner 项目，返回 Core 文件概览和实际文件数；异主 project ID 返回安全“不存在”，且不进入文件计数 reader。隔离 PostgreSQL 的 `get-project-overview-postgres.test.ts` **1/1**，生产 Run 集成 **1/1**。该 PG 合同另外验证软删项目、跨 owner 文件/目录、非 project 文件空间、预取消、撤权，以及查询等待取消时连接最终可复用；Python 项目详情基准此前 **7/7**，本轮未重跑。`get_project` 更新为已完成并接入 Web，静态状态计数为完成 22、待接入 2、部分 62、依赖阻塞 22、退役/重设计 1。真实部署与外部 Provider 未验收。

`get_tool_schema` 生产调用复验：合成模型请求仅查询当前 lease registry 允许的 `list_events`，工具经正式 registry 执行后将 discovery/schema 事件投影进生产 Run SSE。集成用例通过验证事件含目标 schema，且不假定该专用 canonical discovery 结果一定以普通工具消息形状进入 Provider 文本数组。Core `note-reads.test.ts` **6/6**，真实 Host HTTP/SSE **1/1**。Python `test_registered_schema_discovery_does_not_execute_requested_tool` 与此前 schema-selection 近邻回归有通过记录，本轮 pytest 未重跑（环境无 pytest）。因此更新为已完成并接入 Web；静态清单现为完成 23、待接入 2、部分 61、依赖阻塞 22、退役/重设计 1。Provider 为环回合成端点，Node-only，无 Python 回退。

2026-11-18 `note_search` / `note_get` 生产工具调用验收：在隔离 PostgreSQL schema、Redis 和环回合成 Provider 上启动正式 `startServer`，通过 HTTP/SSE 和生产 ToolRegistry 分别搜索/读取笔记。搜索返回己方 note id 与正文、不含异主内容；详情验证 JSON `numbered_content` 保留实际物理行号及换行；异主 node id 返回安全 not-found，不泄露异主标题或正文。Core `note-reads.test.ts` 本轮 **6/6**，生产 Host 集成 **1/1 通过、0 失败、0 跳过**。测试断言最初把 JSON 转义换行当作原始换行，已改为解析结果 JSON 后精确检查 `numbered_content` 并完整复跑。Python pytest 本轮未运行；对应旧 Python 行为以既有合同和共享用例对照，不能据此宣称 Python 基准本轮通过。两项从部分实现更新为已完成并接入 Web；当前109个静态工具：完成25、待接入2、部分59、依赖阻塞22、退役/重设计1。临时 PG/Redis 及合成 Provider，不涉及生产数据或真实外部服务；Node-only，无 Python 兼容层。


2026-11-18 Agent Runtime Core 边界与项目工具原型清理复核。Core 保留 Harness、Chat 生命周期、dispatch Worker/Supervisor、恢复校验、事件重放与共享交互编排；Web Host 只装配认证 owner、PG/Redis 持久端口、Provider/工具授权绑定及 HTTP/SSE。Core 定向回归此前在 devserver 隔离快照中 8 文件 77/77 通过；Web Host 的真实持久层、生产部署及桌面接线仍按迁移任务清单标为未完成。删除全仓生产零引用的 `agent-project-update-tool.ts` 与仅测试该适配器的 Host 测试；生产更新工具由 Core `ProjectMutationPort` 注册，完成待办、owner 隔离、名称歧义、空更新、CAS、确认、取消和未知提交行为已有 Core 项目回归覆盖。devserver 隔离快照中 `projects.test.ts`、`project-mutations.test.ts`、`project-durable.test.ts` 50/50 通过。标准 Vitest 配置因当前共享树的 `tests/suites.json` 与测试发现集合不一致未能启动；改用隔离快照里的临时显式文件配置，未修改该清单或触碰冲突同步。

2026-11-18 `note_create` / `note_update` Python 基线补验。devserver 源码隔离快照运行 `tests/mind/test_mind_agent_tools.py` 与 `tests/agent/test_tool_schema_validation.py -k note`，30 通过、84 未选；Core `note-writes.test.ts` 与 `note-lifecycle.test.ts` 7/7 通过。既有 Host 隔离 PostgreSQL 回归覆盖真实写入、Undo、收据、索引刷新、撤权和行编辑；本轮未运行该 Host 测试，因为 devserver shell 未提供 `GUGU_WEBUI_TEST_DATABASE_URL`。生产 `startServer` Provider 续轮尚无 note 写工具实跑证据，因此两项仍为部分实现，不因底层 Host dispatch/测试 Provider 覆盖而升级状态。

2026-11-18 搜索与下载 Core 回归复验。devserver 源码隔离快照运行 `providers/ollama.test.ts` 和 `tools/web.test.ts`，**66/66 通过**：覆盖 MiniMax、Qwen、GLM、DeepSeek、Mimo、Ollama 原生协议、凭据与目标主机限制、重试/重定向、输出预算、取消及 `web_search`、`deep_research`、图片结果和下载契约。Python `test_provider_web_search.py` 与项目删除确认基准此前 **35/35**、深度研究/相似图/限额此前 **21/21**；本轮未重跑 pytest。Host `agent-search.test.ts` 的持久配额与凭据接线需要独立 PostgreSQL URL，本轮未运行；未调用付费 Provider 或公网服务。搜索工具继续标记部分实现，Host DB 配额回归和生产 Run 续轮仍待验收。

2026-11-18 IM 工具与 Gateway 接线复核。Core `tests/agent/tools/im.test.ts` 在 devserver 隔离快照 **4/4 通过**；Python `tests/im/test_im_owner_session.py` 与 `tests/im/feishu/test_feishu_gateway_guards.py` **18/18 通过**。源码全仓调用检查确认 `createWebAgentImOwnerSessions` 和 `createWebAgentFeishuReaction` 目前只在 Host 工厂及测试出现，`main.ts` 无生产注册调用；前者缺 Gateway 当前 owner 私聊解析，后者缺 Gateway 当前飞书消息/回应标记回调。`apps/web-host/tests/agent/agent-im.test.ts` 要求隔离 PostgreSQL 与 Redis；devserver 当前 shell 两个测试 URL 均未配置，因此未运行该 Host 集成，也未将 Core 工厂或 fake 当作生产接入。两个工具继续标记为待实时 Gateway 接入。

2026-11-18 `canvas_list` / `canvas_get` / `canvas_search` / `canvas_focus_node` 生产工具调用验收。通过正式 `startServer` HTTP/SSE、ToolRegistry 和真实隔离 PostgreSQL/Redis 执行四个读工具。画布列表校验己方列表、活动项计数和视图投影且排除异主画布；详情返回 owner 节点正文；搜索返回真实匹配；焦点工具生成正确 `gugu://focus-canvas/...` 链接；异主画布详情返回 not-found 且不泄漏标题。Core 画布详情/布局/Agent 读取/焦点及工具用例 **5 文件 12/12 通过**，生产 Host 集成 **1/1 通过、0 失败、0 跳过**。一次夹具视图嵌套和一次测试对 content 字段的假设经失败输出修正，按真实共享投影 `view.camera.x`、`content_md/content_plain` 重跑通过。Python pytest 本轮未运行。四工具从部分实现更新为已完成并接入 Web；109 个静态工具：完成29、待接入2、部分55、依赖阻塞22、退役/重设计1。只使用临时隔离存储与环回合成 Provider，无真实外部调用；Node-only，无 Python 兼容层。

2026-11-18 `canvas_search_placeable` 生产调用补验。相同隔离 Host Run 经 ToolRegistry 实际检索项目，并确认当前 owner 的 `工具创建项目` 命中，而同词的异主 `异主合成项目` 未返回。生产集成 **1/1 通过、0 失败、0 跳过**；Core 画布组 **5 文件 12/12** 与同一生产用例一起通过。此项与前一批四个画布只读工具合并更新为已完成，当前109项：完成 **30**、待接入 **2**、部分 **54**、依赖阻塞 **22**、退役/重设计 **1**。Python pytest本轮未运行；真实生产外部服务未调用，Node-only。

2026-11-18 画布创建和编辑工具生产调用补验：正式 Web Run 实际调用 `canvas_create`、`canvas_create_note`、`canvas_add_node`、`canvas_update_node`、`canvas_update_note`、`canvas_connect`、`canvas_update_anchor`。隔离 PostgreSQL 回读确认画布/便签/业务引用 owner 与关联、节点坐标、便签正文及版本、同画布关系行与端点字段；Core 画布组定向 **5 文件 12/12**，生产 Host HTTP/SSE/PG/Redis 集成 **1/1 通过、0 失败、0 跳过**。Python pytest 本轮未运行。七工具由部分实现更新为已完成；静态工具状态：完成 **37**、待接入 **2**、部分 **47**、依赖阻塞 **22**、退役/重设计 **1**。临时隔离数据与合成 Provider；未调用真实外部服务，Node-only。

2026-11-18 `call_tool` 行为与生产接线补记。devserver 上 Python `test_tool_schema_security_contract.py -k call_tool` **2/2**、Core `tool-ports.test.ts` 与 `input-feedback.test.ts` **21/21** 通过；既有正式 `startServer` HTTP/SSE 隔离 PostgreSQL/Redis 集成经真实 ToolRegistry 调用嵌套工具，验证持久副作用、目标授权拒绝和原调用 ID 续轮。结合 Core 对计划前解析、计划/分派/确认恢复重新鉴权及可信来源检查点绑定的行为覆盖，`call_tool` 更新为已完成并接入 Web。当前109项：完成 **38**、待接入 **2**、部分 **46**、依赖阻塞 **22**、退役/重设计 **1**。Provider 为环回合成服务；真实外部 Provider 和部署未验收。

2026-11-18 搜索 Provider 与工具回归复跑：devserver 源码快照中 `providers/ollama.test.ts` + `tools/web.test.ts` **66/66 通过**；Host `agent-search.test.ts` 现 **4 通过、0 失败、1 跳过**，唯一跳过项要求未配置的隔离 PostgreSQL URL。新增行为用例由实际 Core Harness 发出 `web_search` 调用，经 Host 搜索 factory 和 ToolRegistry 执行合成出站请求，并断言结果进入下一轮 Provider 上下文。Python `test_provider_web_search.py` **33/33**；上述源码和测试哈希与当前工作树一致。`web_search` 仍为部分实现：`main.ts` 的 `startServer` 生产装配搜索续轮及隔离 PG/Redis 未验收；未调用真实 Provider 或公网服务。

2026-11-18 `send_email` 基线及 Host 回归复核。devserver 上 Python `test_email_tool.py`、`test_email_attachments.py` **27/27** 通过；Core `agent/tools/email.test.ts` **4/4**，Host `agent-email.test.ts` **1 通过、0 失败、1 跳过**，持久 Run 集成 **1 跳过**，两项均因当前 shell 未配置隔离 PostgreSQL/Redis URL。参考源码与 pytest 哈希、Node Core/Host 源码及测试哈希均与当前工作树一致；先前相同源码的隔离 PG/Redis 持久 Run 确认/取消 **8/8** 和定时生产入口环回 SMTP **3/3** 记录仍适用。持久确认、SMTP 认领和预授权定时发送均已接入，`send_email` 更新为已完成并接入 Web；真实外部 SMTP 和部署仍未验收。

2026-11-18 Skill 来源与关联 Schema 回归复跑。devserver 上 Python `test_user_skills.py` **23/23**、Core `use-skill.test.ts` **6/6**、Host `agent-skill-tool-runtime.test.ts` **1/1** 通过，参考源和测试哈希均与当前工作树一致。Core 行为测试确认 `related_tools` 只筛选当前 Run 注册器发现的已授权 Schema，撤权后不再注入；Host SQLite 测试确认 Markdown frontmatter 内置技能、owner 用户 Skill 读取、异主拒绝和停用撤权。该切片只验证 Prompt Skill 行为和关联 Schema 安全边界；指定的 `create_skill`/`update_skill` 生产 Run 与 PostgreSQL 持久接入仍未验收，不升级状态。

2026-11-18 `list_scheduled_tasks` 与 `update_workspace` 生产工具验收。正式 Node `startServer` 在随机 PostgreSQL schema、临时 Redis、临时文件存储和环回合成 Provider 下经 HTTP/SSE/dispatch/ToolRegistry 调用两项工具。定时任务结果只返回 owner 独立任务，排除日历提醒与异主任务；工作区更新同步声明名与目录显示名并保持物理目录键不变。生产集成 **1/1**，Core 定时任务/工具批次 **3 文件 7/7**；初始默认系统目录因安全规则不可重命名，夹具改用非系统 owner 目录后验收通过。Python pytest 本轮未运行。两工具更新为已完成并接入 Web；109 项状态：完成 **41**、待接入 **2**、部分 **43**、依赖阻塞 **22**、退役/重设计 **1**。无 Python bridge、回退或双运行时；无真实外部 Provider、平台投递或生产部署验收。

2026-11-18 `list_trash` 真实 Web Agent 调用验收。隔离 PostgreSQL schema 中写入 owner 与异主的软删除文件，经正式 Node `startServer`、HTTP/SSE、生产 dispatch/ToolRegistry 和环回合成 Provider 查询；结果只包含 owner 文件且保留 PostgreSQL 微秒时间戳。Core `trash.test.ts` **4/4**，生产 Host 集成 **1/1**。Python 回收站 pytest 曾在隔离临时环境 **1/1** 通过，本轮未重跑（当前环境未安装 pytest/后端依赖）。`list_trash` 更新为已完成并接入 Web；109 项状态：完成 **43**、待接入 **2**、部分 **41**、依赖阻塞 **22**、退役/重设计 **1**。只用临时隔离服务及合成 Provider，无 Python 执行桥或真实外部服务调用。

2026-11-18 `restore_file` / `restore_folder` 生产工具验收。正式 Node Agent Run 经 HTTP/SSE/ToolRegistry 调用 PostgreSQL owner-scoped 恢复端口，在临时文件存储中恢复独立文件及顶层文件夹子树；隔离 PG 回读确认 file/folder `deleted_at` 清除、原逻辑存储路径重建与文件正文可读，异主不会触达数据。生产主链 **1/1**，Host `trash-restore-runtime-postgres.test.ts` **1/1**，覆盖父目录仍在回收站、异主/缺失目标、并发、提交未知结果和重建收据不重复物理操作。Python pytest 本轮未运行；源码对照旧行为的物理文件缺失处理及父目录门，未接入 Python 执行。两工具更新为已完成并接入 Web；109 项状态：完成 **45**、待接入 **2**、部分 **39**、依赖阻塞 **22**、退役/重设计 **1**。所有持久与磁盘数据均位于临时隔离环境。

2026-11-18 `note_create` / `note_update` Node 生产 Run 验收：隔离 PostgreSQL schema、临时 Redis 和环回合成 Provider 下启动正式 `startServer`，经 HTTP/SSE、dispatch 与 ToolRegistry 创建 Markdown 笔记并追加正文；数据库回读核对 owner、Markdown、纯文本投影和递增版本。Core `note-writes.test.ts` + `note-lifecycle.test.ts` **7/7**，生产 Agent 主链集成 **1/1 通过、0 失败、0 跳过**。两工具由部分实现更新为已完成并接入 Web；当前静态工具状态：完成 **48**、待接入 **2**、部分 **36**、依赖阻塞 **22**、退役/重设计 **1**。本轮只运行 Node 工具与 Node Host，不添加或调用 Python 兼容层；生产部署与真实外部 Provider 未验收。

2026-11-18 `note_delete` / `note_restore` / `note_undo` Node 生产 Run 验收：在正式 `startServer` HTTP/SSE 与 ToolRegistry 调用链上，先软删 owner 普通笔记并核对墓碑、版本和正文，再按 ID 恢复并确认异主记录不变；随后通过 `note_undo` 只撤销当前 owner 最近创建的咕咕普通笔记。隔离 PostgreSQL 主链集成 **1/1 通过、0 失败、0 跳过**；Core 笔记写入/生命周期回归 **7/7**。三工具由部分实现更新为已完成并接入 Web；当前109项：完成 **51**、待接入 **2**、部分 **33**、依赖阻塞 **22**、退役/重设计 **1**。本轮仅使用 Node 实现及临时隔离数据，不含 Python 兼容路径；真实部署和外部 Provider 未验收。

2026-11-18 `similar_image_search` 参数兼容与 `web_download` 网络重试回归。旧 Python `test_similar_image_search.py`、`test_web_download.py` 在 devserver 临时隔离 Python 环境合批 **15/15**；Node Core `tests/agent/tools/web.test.ts` **13/13**，Core 构建通过。相似图搜索验证数字字符串先归一再校验范围；下载验证仅 timeout/network 错误最多重试两次并按 1s/2s 退避，已断流内容只在 Host 暂存阶段重试、HTTP 503 不重发、取消退避后不再请求。第一次 Node 运行中，取消测试误期望 Promise reject；按 registry 的既有取消结果 `{ kind: 'unknown' }` 修正测试，复跑通过。Python 源码未改；本轮未连接真实公网，也未验收生产部署或正式 Host 文件写入链，因此两项仍为部分实现。测试只使用 devserver 与临时环境，无仓库运行数据写入。

2026-11-18 `create_scheduled_task` / `update_scheduled_task` Node 生产 Run 验收：正式 Node `startServer` 通过 HTTP/SSE 和 ToolRegistry 创建一次性独立任务并更新其名称/指令，隔离 PostgreSQL 回读确认 owner、时间、渠道和停用状态；`enabled:false` 保证该合成任务不被 Worker 消费。生产主链 **1/1**；Host `task-writes-postgres.test.ts` **4/4**，覆盖 owner/事务、确认授权、一次性与周期 Worker；Core `scheduled-tasks.test.ts` **1/1**。只启动临时一次性 Worker 和隔离 PostgreSQL/Redis，不调用外部 Provider 或真实投递；两工具更新为已完成并接入 Web。静态工具状态：完成 **53**、待接入 **2**、部分 **31**、依赖阻塞 **22**、退役/重设计 **1**。Node-only，不存在 Python 兼容路径。

2026-11-18 定时任务 Core 写工具行为回归复验。在上述生产 Run 和 Host PostgreSQL 验收之外，Core `tests/agent/tools/scheduled-tasks.test.ts` 扩展到 **2/2**，真实注册器经临时 SQLite 验证旧 Python 精确 interval 时间窗、部分更新保留/清除、owner 与事务内撤权、原收据重放不重复发布，以及未就绪的完整沙箱授权保持不可用；Core build 通过。Python `tests/scheduling/tasks/test_scheduled_task_schedule_rules.py` 选中写工具精确窗口、一次性任务和 Schema 三项 **3/3**。Python 临时环境首轮缺 `aiosqlite` 导致两项 fixture setup error，安装到任务临时 venv 后复跑通过；未访问共享/用户数据库，参考实现未改。Core 全测试源码 `tsc -p tsconfig.tests.json --noEmit` 失败，错误分布于既有 Agent、RAG、Terminal 等其他测试；`scheduled-tasks.test.ts` 无类型错误。当前109项：已完成 **55**、待接入 **2**、部分 **29**、共享/平台依赖 **22**、退役/重设计 **1**；指定21项：已完成 **7**、部分 **12**、待接入 **2**。

2026-11-18 `list_skills` / `use_skill` Node 生产 Run 验收：正式 `startServer` 通过 HTTP/SSE、生产 registry 与环回合成 Provider 调用技能目录及正文工具。目录通过 Node `packages/core/resources/skills` Markdown frontmatter 提供 S7 元数据，确认不泄漏正文；`use_skill` 加载该 Markdown 正文并验证正文进入下一次 Provider 请求。Core Markdown 注册定向 **2/2**（其余6项按筛选未执行），Host `agent-skill-tool-runtime.test.ts` **1/1**，隔离 PG/Redis 的生产主链 **1/1**。两工具由部分实现更新为已完成并接入 Web；当前静态状态：完成 **55**、待接入 **2**、部分 **29**、依赖阻塞 **22**、退役/重设计 **1**。仅 Node 资源、Node 工具和临时隔离存储，无 Python 桥接或回退；真实部署未验收。

2026-11-18 `create_skill` / `update_skill` Node 生产 Run 验收。正式 `startServer` 经 HTTP/SSE、生产 ToolRegistry 与可信 lease，调用用户技能创建和更新；隔离 PostgreSQL 回读核对 owner、稳定技能 ID、`managed_by`、enabled 状态及完整 Markdown 正文，随后再由真实 `use_skill` 调用验证更新正文进入下一轮合成 Provider 请求。生产主链 **1/1 通过、0 失败、0 跳过**；Core `skill-management.test.ts` 与 `user-management-sqlite.test.ts` 定向回归 **3/3**。两工具由部分实现更新为已完成并接入 Web；109 项：完成 **57**、待接入 **2**、部分 **27**、依赖阻塞 **22**、退役/重设计 **1**。Node 是唯一运行时，未调用 Python；存储和 Provider 均为隔离临时 PostgreSQL/Redis 与环回合成服务，真实部署未验收。


2026-11-18 Node-only RAG 与技能管理续轮复验：Core RAG Vitest **9 文件、70/70**；Host RAG/Jieba/正式工具注册/来源 Worker/迁移回归 **36 通过、5 跳过、0 失败**。5 个跳过分别需要 Linux 安全原子写入（1）、隔离 PostgreSQL/Redis（1）和隔离 PostgreSQL（3）。另以临时 PostgreSQL/Redis、环回合成 Provider 运行正式 `startServer` HTTP/SSE 主链 **1/1**，覆盖工具注册器续轮，其中包括技能创建/更新、search_conversations、owner 隔离及 Run 恢复；技能 Core 写入/SQLite 回归 **3/3**。Core build、Web Host production typecheck 与 `git diff --check` 通过。测试和运行服务均为 Node，数据隔离在临时 schema/目录；未运行 Python pytest、未连接真实外部 Provider 或生产数据。

2026-11-18 Agent Runtime Core 边界、IM 阻塞与 Python 基线复核：Core `runtime.ts`、`chat-service.ts`、`runner.ts`、`core.ts` 持有共享 Chat/Run/dispatch/Provider 编排；Web Host 持有可信身份、PG/Redis、Provider transport、HTTP/SSE 和生命周期适配。devserver Core build 通过；Runtime 可移植依赖闭包及 21 项工具行为相关 Core 回归 **19 文件、148/148**。新增 Python 工具级 `delete_knowledge` 基线 **1/1**，仅改测试、未改 Python 参考实现。当前源码确认 `react`、`bind_web_session` 的 Core 与 Host 可复用实现存在，但仓库无实时 Node IM Gateway 调用方；已将二者归为平台依赖阻塞，并列出分别缺少的可信输入端口。当前 109 项：完成 **59**、待接入 **0**、部分 **25**、共享/平台依赖 **24**、退役/重设计 **1**；指定 21 项：完成 **9**、部分 **10**、平台依赖 **2**。`git diff --check` 通过；未刷新有三处冲突的 Mutagen 同步。

2026-11-18 Node-only RAG 与生产搜索/日历调用链复验：使用临时 PostgreSQL、隔离 Redis 和环回合成 Provider，正式 `startServer → HTTP/SSE → dispatch → Reconstructor → ToolRegistry` 回归 **1/1** 通过，实际调用 `search_conversations`、`read_knowledge`、`create_event`、`update_event` 和 `global_search`；验证新建 owner 日程可由更新工具修改，再由站内搜索命中，且模型提交异主 `owner_id` 不扩大搜索范围；`read_knowledge` 在真实 Run 中经 Node Worker 索引的 owner 与异主 Markdown，验证 BM25 只返回 owner 投影、按 ID 返回完整正文且异主 ID 安全 not-found。Core RAG **9 文件 70/70**，Core 知识行为 **8/8**，Host RAG/lease/正式来源 Worker/迁移/Jieba/检索 transport 批次 **53 通过、1 跳过、0 失败**，Host 知识/授权端口 **16 通过、1 跳过**；唯一跳过项为 Linux 安全原子写入。Web Host production typecheck 与 `git diff --check` 通过。该主链测试不传日历提醒；曾用禁用的 Web 提醒探测 Host 提醒分支，结果为提交状态未知，因此没有将提醒路径记为验收，`update_event` 继续列部分实现。静态工具状态更新为 109 项：完成 **60**、待接入 **0**、部分 **24**、共享/平台依赖 **24**、退役/重设计 **1**。本轮未运行 Python 后端或 pytest；Python 只作为历史业务语义参照，Node 是 2.0 唯一实现，不保留桥接、回退或双运行时。

2026-11-18 Agent 工具 Host 组件回归复验：devserver 对 21 个 Host 测试文件执行 Node test **63 项：52 通过、11 按条件跳过、0 失败**。通过项覆盖 Core Runtime 注入与持久终态、Chat 生命周期、Web 搜索端口结果续轮/网络校验、邮件前置校验、MCP lease/目录授权、Skill Markdown head 与按需读取、知识与记忆 owner FS/SQLite dispatch、项目删除/恢复事务与路由、定时删除 owner 规则。11 个跳过项需隔离 PostgreSQL 和/或 Redis；对应测试环境变量当前未配置，未记为通过。真实 Host PostgreSQL/Redis 工具调用和实时 IM Gateway 仍未验收。测试文件哈希与当前工作树一致；无 Python 变更、无 Mutagen flush；`git diff --check` 通过。

2026-11-18 定时 Agent Runtime 策略下沉到 Core：`reasoning_persistence: 'off'` 从 Web Host 的模型绑定包装移入 `packages/core/src/scheduled-tasks/agent-harness.ts`，由 Core 在每次可信 Provider 选择后执行；Host 仍持有 BYOK/凭据绑定、释放和用量写库。Core `run-now.test.ts` **21/21**，新增回归验证该策略生效且不修改 Host 选中的模型/凭据；Core build 通过。更新后的 Host PostgreSQL 集成回归同时检查最终 Provider transport 收到关闭续接的配置，但本轮隔离 PostgreSQL 环境变量未配置，未运行、未计通过。该策略属于 Core 共享运行时行为；Web 生产凭据、持久化和桌面接入边界仍按 Host 装配记录，不把 Core 合同测试视为生产接入。

2026-11-18 `web_download` 当前树复验：devserver Core `tests/agent/tools/web.test.ts` **13/13**；当前 Python pytest 不可用、隔离 PostgreSQL 环境变量未配置，因此本轮未重跑 Python 基线或 Host 写入/收据集成，不记为通过。源码及既有回归确认默认/显式工作区落点、Local 文件写入、配额、租约复核、提交后收据恢复、取消、回滚清理均已覆盖；旧 Python 与 Node 工具语义已对照。当前剩余实现风险是进程异常退出后临时下载暂存没有跨进程清理，不再把显式工作区或公网实测列为缺口；工具维持部分实现。

2026-11-18 `remember` 当前树基线复验：临时 Python venv 中旧版 `tests/agent/memory/test_remember_tool.py` **6/6**；Core `tests/agent/tools/remember.test.ts` **2/2**；Host `memory-tools-runtime-sqlite.test.ts` **6/6**。Python 首轮因临时环境缺 APScheduler 在收集阶段失败，补入临时 venv 后通过；Host 首次使用裸 `node --test` 未装载 TS，改用仓库规定的 `node --import tsx --test` 后通过。PG/Redis 当前未配置，因此本轮未重跑隔离生产 Run；基于同一生产 ToolRegistry/Run 的历史隔离 PG/Redis/Local 验收 **43/43** 与实际 Node Worker 索引消费证据，`remember` 更新为已完成并接入。测试没有改动 Python 实现或用户数据。

2026-11-18 知识写工具 Host 边界回归：macOS `startServer → HTTP/SSE → dispatch → Reconstructor → ToolRegistry` 首轮发现 `save_knowledge`/`update_knowledge` 虽有 owner Markdown 与持久索引端口，但被错误注册到不支持安全原子写入的 Host，调用后落入提交状态未知。Host 现只在 Linux 安全原子文件发布能力可用时注入写端口；macOS 主链 **1/1** 验证 Provider 工具声明不含知识写工具且 owner 文件版本不变。`read_knowledge` 仍由该主链实际调用。Node owner 向量文件、当前 owner embedding 配置与取消边界回归 **11/11**，使用临时 FS 和合成 embedding transport，不调用真实 Provider。Core RAG/知识 **11 文件 80/80**；Host RAG/知识/授权批次 **36 通过、6 跳过、0 失败**（Linux 安全写入及隔离 PostgreSQL 用例按条件跳过）；Core build、Host production typecheck、真实 Agent 主链 **1/1** 与 `git diff --check` 通过。Linux 写入、版本历史及正式 Worker 索引刷新按平台专项测试，本机本轮未验收，两个写工具继续列为平台相关部分实现。Node 唯一运行时；没有 Python 桥接、普通文件写入回退或双栈路径。

2026-11-18 Node-only RAG/工具真实主链续验：临时 PostgreSQL schema、临时 Redis、临时 owner 文件目录与环回合成 Provider 下，真实 `startServer → HTTP/SSE → dispatch → Reconstructor → ToolRegistry` **1/1 通过**，实际调用 `search_conversations`、`read_knowledge`、日历创建/更新、`global_search`、Markdown 技能读取/管理及 `ask_user`；RAG 验证覆盖 Node Worker 正式索引、owner BM25 投影、精确读取、异主拒绝与 Run 持久恢复。`ask_user` 生产调用发现 Agent Base migration 只有 prompt、没有动作 token 表；新增 Node `interaction-actions` schema migration/CLI 并在隔离集成里应用后，choice prompt、owner/session 绑定与三条只存 token 摘要的选项动作成功持久化。未启用 MCP 的 Host 不再无条件访问可选 `mcp_secret_inputs` 表；只有显式启用 MCP 的可信 Host 才在同一事务清理待处理密文。Core RAG + interaction Vitest **19 文件、131/131**；Host `agent-rag-tool-ports.test.ts` **15/15**；Host TypeScript production typecheck、Core build、隔离生产主链与 `git diff --check` 通过。此次主链只验收 `ask_user` 等待 prompt 的创建，不宣称 `/resume` 后续 Provider 续轮通过；`ask_user` 整体状态不升级。未运行 Python 后端/pytest、未连接真实 Provider 或生产数据。当前工具统计不变：109 项，完成 **60**、待接入 **0**、部分 **24**、共享/平台依赖 **24**、退役/重设计 **1**；Node 是唯一 2.0 运行实现，不设 Python 桥接或 fallback。

2026-11-18 `ask_user` 持久恢复闭环复验：扩展同一隔离生产 HTTP/SSE 主链，用真实动作 token 选择 `left`，确认 PostgreSQL prompt 解析、owner/session/run 绑定和恢复队列后，dispatch 恢复 waiting checkpoint；后续 Provider 请求包含已消费选项结果，Run checkpoint 到达 `completed`，助手回复写入数据库。正式 `startServer → HTTP/SSE → dispatch → Reconstructor → ToolRegistry` 集成 **1/1 通过**，使用临时 PostgreSQL/Redis/schema、临时 owner 文件目录与环回合成 Provider；不是实际付费 Provider。未改运行时或加入桥接。`ask_user` 仍列部分实现，因为 `form` 与 `authorization=user_sandbox` 尚无获授权的 Host 能力；choice/question 的 Web 持久续轮已验收。本轮未运行 Python pytest。Node 是 2.0 唯一执行路径，Python 后端是迁移完成后的删除目标。

2026-11-19 `ask_user` 完整用户沙箱授权路径接线：Core 授权工具执行时查询注入的 Host 端口；Host 先复验当前 Web lease，再按 owner/session 检查功能开关和现存授权。未授权时，可信交互描述器忽略模型提供的文案/选项，生成固定范围、仅确认/取消、禁用文本输入的授权提示；确认继续复用既有 PostgreSQL grant 与安全审计事务，撤销仍使用现有会话授权服务。Core 交互回归 **21/21**；Host 注册器、RAG/授权端口和可信提示定向组合 **56 通过、3 跳过**；授权副作用与生命周期定向组 **7 通过、4 跳过**；Web Host production build 通过。隔离 PostgreSQL 用例因未配置测试数据库跳过；未对本轮授权提示做新的完整 HTTP/SSE + PostgreSQL/Redis 集成验收。仓库级 Web Host typecheck 仍因既有多处测试类型错误失败，本轮修改的生产源码通过 production build。`ask_user` 仍列部分实现：通用 `form` 尚不可用，完整授权链未做本轮端到端服务验收。未运行 Python pytest；Python 仅为旧行为基准，Node 是 2.0 唯一执行路径，不设兼容桥接或 fallback。

2026-11-18 `update_event` 与日历提醒生产行为验收：Core `create-store.ts` 规范化 PostgreSQL `timestamptz` 的短 `+08` 后缀，避免在真实写库前把合法提醒时刻判为无效并返回 `remote_status_unknown`。正式 Agent Run 经 HTTP/SSE/dispatch/ToolRegistry 在随机 PostgreSQL schema 创建带一条启用与一条停用提醒的活动，再更新标题和开始时间；回读验证提醒 ID、提前分钟、渠道和启用状态保留，启用提醒重排、停用提醒计划不变，标题与 payload 同步。Core `calendar-create.test.ts` + `calendar-update.test.ts` **2 文件、6/6**；真实 Host 主链 **1/1**；Web Host production `tsc -p tsconfig.build.json --noEmit` 通过。`update_event` 更新为已完成并接入 Web，当前109项：完成 **62**、待接入 **0**、部分 **22**、共享/平台依赖 **24**、退役/重设计 **1**。测试只使用临时 PG/Redis/schema 和环回合成 Provider；旧 Python 相关用例本轮未运行，pytest 不可用，既有 Python 回归记录不作为本轮通过。无真实外部提醒投递或生产部署验收；Node 为唯一运行路径，无 Python bridge/fallback。

2026-11-18 联系人与定时任务删除确认生产续轮：正式 `startServer → HTTP/SSE → dispatch → Reconstructor → ToolRegistry` 在临时 PostgreSQL/Redis/schema 与环回合成 Provider 下分别请求删除 owner 联系人和停用的一次性定时任务。确认 prompt 绑定 owner/session/run；确认 token 之前目标仍存在，消费 token 后同一持久 Run 恢复并执行删除。定时任务删除另验证 Redis `live-revision:<owner>:scheduled_tasks` 递增。Host RAG/lease **15/15**、Core 联系人 **20/20**、Core 定时任务删除 **1/1**、生产主链 **1/1**、Web Host production typecheck、Core build 和 `git diff --check` 通过。首次尝试未设置测试主密钥时工具按安全规则不可见；隔离 Host 显式注入合成密钥后通过，生产配置门未放宽。本轮 Python pytest 未运行；真实 Provider、真实提醒投递和生产部署未验收。`delete_client` 与 `delete_scheduled_task` 更新为已完成并接入 Web；109 项现为完成 **64**、待接入 **0**、部分 **20**、共享/平台依赖 **24**、退役/重设计 **1**。Node 是 2.0 唯一运行时，不添加 Python 运行路径或兼容回退。

2026-11-18 `delete_skill` 持久确认生产续轮：正式 Web Agent Run 使用隔离 PostgreSQL/Redis 和环回合成 Provider 删除已更新的 owner Skill。确认 prompt 绑定 owner/session/run；确认 token 被消费前行仍存在，恢复原 Run 后删除收据和 Skill 行提交，Redis `skills` 资源版本递增。Core `skill-management.test.ts` **2/2**；Host `user-skill-delete.test.ts` **1 通过、1 跳过**（唯一跳过需独立 PG，已由同一生产主链临时 PG 覆盖）；正式 Agent 主链 **1/1**，Core build、Web Host production typecheck、`git diff --check` 通过。把该集成场景加进主链后将用例总时限从 60 秒调到 90 秒，最终用时约 62 秒并通过。本轮不运行 Python pytest、不调用外部 Provider；`delete_skill` 更新为已完成并接入 Web，109 项现为完成 **65**、待接入 **0**、部分 **19**、共享/平台依赖 **24**、退役/重设计 **1**。Node 是 2.0 唯一运行时，不添加 Python 运行路径或兼容回退。

2026-11-18 `delete_event` 持久确认生产续轮：隔离 PostgreSQL/Redis 与环回合成 Provider 下，正式 Agent Run 先搜索确认更新后的 owner 日程，再请求删除。确认 prompt 与动作 token 绑定当前 owner/session/run；消费前日程仍有效，确认后恢复同一 Run、软删日程、停用已启用及已停用的关联提醒并递增 Redis 日历资源版本。Core `calendar-delete.test.ts` **5/5**、正式生产主链 **1/1**、Core build、Web Host production typecheck 与 diff 检查通过。真实外部提醒投递、真实 Provider、生产数据和部署未验收；本轮 Python pytest 未运行。`delete_event` 更新为已完成并接入 Web；109 项当前完成 **66**、待接入 **0**、部分 **18**、共享/平台依赖 **24**、退役/重设计 **1**。Node-only，无 Python 运行路径或兼容回退。

2026-11-18 `http_get` Node 工具接入：Core 负责 URL 参数、HTTPS 自定义请求头、同源批量限制、HTML 正文提取及结果结构；Host 通过现有安全公网 egress 端口发 GET、限制正文 2 MiB、不跟随重定向并传递取消。生产 Run 沿用 `main.ts` per-lease 工具端口装配，Reconstructor 仅在 Host 注入端口时公开工具，执行时复验活动 owner/session/run lease。Core `web.test.ts` **14/14**；Host Agent Search、Tool Registry、RAG lease 回归 **47 通过、1 跳过**；Core build、Web Host production typecheck、`git diff --check` 通过。测试用合成 transport/响应，不调用真实公网；未运行 Python pytest。PDF 提取未装配，所以 `http_get` 仍列部分实现。Node 是唯一 2.0 运行时，不加 Python 桥接、回退或双轨实现。


2026-11-18 `delete_project` Node 生产 Run 注册回归：`createAuthorizedWebAgentProductionRagRunPorts` 将实际 Core 删除工具注册到当前 owner 的 lease Registry；测试用隔离 SQLite 项目数据与合成 PostgreSQL lease/确认凭据，验证确认前不产生副作用、有效确认后软删除、撤权后拒绝第二个待确认删除。Host 定向用例 **1/1**，Core `project-delete.test.ts` 已有确认快照、事务软删、回滚与收据重放行为覆盖。真实 PostgreSQL/Redis 持久交互与进程恢复仍留待统一验收；Node-only，无 Python 运行实现。


2026-11-18 `web_download` 暂存恢复补齐：Host 在首次下载前扫描系统临时目录，只清理自身前缀、当前 Unix 用户拥有且超过 24 小时的真实目录；符号链接、其他路径和近期暂存保留。Web Host `agent-web-download.test.ts` **1/1**，production typecheck 和 `git diff --check` 通过；测试只用临时目录，无真实文件库、用户数据或公网访问。本轮闭合了此前记录的进程崩溃残留清理缺口，`web_download` 更新为已完成并接入 Web。Node-only，无 Python 运行实现。


2026-11-18 `web_search` 生产工具端口复验：Node `agent-search.test.ts` **5 通过、1 跳过**；Host 搜索 factory 输出安全出站工具，Core AgentRunner 实际 dispatch 后将合成搜索结果续入下一轮 Provider context。唯一跳过项需要隔离 PostgreSQL，用于深度研究/相似图的持久额度测试，与 `web_search` 普通搜索无关。没有调用真实 Provider 或公网。`web_search` 更新为已完成并接入；`deep_research` 与 `similar_image_search` 仍待持久额度端口回归。

2026-11-18 `read_file` 批量文本切片进入 Node 生产 registry：Core 工具在真实 ToolRegistry dispatch 中按顺序读取最多 20 个 owner-resolved `file_id`，单项失败隔离，累计源数据限制 64 MiB；总量达到上限后不再打开后续文件。每项仍复用 `packages/fs` 受授权根和原有 UTF-8/行号规则，批次结果不暴露物理路径或单项隐藏字节字段。Core `files.test.ts` **54/54**，Web Host `agent-file-read.test.ts` **1/1**，Core build 通过。Host 数据库、授权和 lease 使用合成端口，磁盘为临时真实目录；媒体、历史附件、URL、逻辑路径、system scope 和真实 PostgreSQL 尚未接通/验收，故 `read_file` 整体仍属部分实现。Node 是 2.0 唯一运行时，不增加 Python 桥接或兼容执行路径。

2026-11-18 `list_dir` Node 工具接入：Core 文件组新增明确 `space` 的分页目录工具；Host per-lease 端口复用既有 `createPostgresFileBrowserOperations`，文件和目录使用独立游标，未开放宿主路径。通过真实 Core ToolRegistry/生产授权组合 dispatch 的 Host 用例验证 owner identity、文件/目录结果及分页游标；Core `files.test.ts` **54/54**、Host `agent-file-read.test.ts` **1/1**、Core build 与 Web Host production typecheck 通过。Host 测试使用合成文件浏览和 lease 依赖；真实 PostgreSQL/HTTP-SSE Run 未验收。逻辑路径、system scope 与内容检索尚未实现，`list_dir` 仍列部分实现；Node-only，不引入 Python 桥接或兼容执行路径。

2026-11-18 `edit_file` Node 工具切片：Core 文件组支持全文替换、追加和精确文本替换，可选 `expected_version` 防止基于旧版本覆盖；多处匹配时要求显式 `replace_all`，无变化内容不写入，非 UTF-8、超 1 MiB、越权 owner 和任意路径参数均拒绝。Web Host 按当前 lease 查询 owner 文件、通过 `packages/fs` 授权根读取，再调用既有 `FileContentOperations` 执行数据库版本 CAS、原子暂存替换、Undo 记录与变更发布。Core `files.test.ts` **58/58**，Host 生产 Registry/授权 dispatch **1/1**，Web Host production typecheck 与 `git diff --check` 通过。测试用临时真实文件、合成 lease/owner 查询和模拟内容事务；真实 PostgreSQL 写入、HTTP/SSE Run 与进程中断后的调用收据恢复尚未验收，因此列为部分实现。Node-only，2.0 不兼容或依赖 Python。

2026-11-18 `rename_file` Node 工具切片：Core 文件组只接受文件 ID、新显示名和可选版本；Host 将 owner 绑定到当前 lease，复用现有 `FileUpdateOperations` 执行命名校验、存储路径规划、版本 CAS、Undo 和文件变更发布。Core `files.test.ts` **58/58**、Host 生产 Registry/授权 dispatch **1/1**、Web Host production typecheck 与 diff 检查通过。测试使用合成 owner 查询/更新端口和临时文件；真实 PostgreSQL 写入及 HTTP/SSE Run 未验收，故列部分实现。Node-only，无 Python 运行路径。

2026-11-18 `copy_file` Node 工具切片：Core 只允许显式个人/项目/工作区目标和 keep_both；没有覆盖目标参数，不触发未确认覆盖。Host 按 lease 检查 owner 源文件并调用现有 `FileCopyOperations`，复用文件冲突命名、Owner/项目/工作区检查、配额、文件与 PostgreSQL 事务、Undo 和变更发布。Core `files.test.ts` **58/58**，Host Registry/授权 dispatch **1/1**，Web Host production typecheck 与 `git diff --check` 通过。测试使用合成 owner 查询/复制服务与临时真实文件；隔离 PostgreSQL 写入、HTTP/SSE Run 及恢复尚未验收，故列部分实现。Node-only。

2026-11-18 `create_file` Node 工具接线：Core 参数限定 UTF-8 文本、明确个人/项目/工作区目标与 keep_both。Host 复用正式上传暂存/配额/文件库事务，在事务内复核当前 dispatch lease，并用 `agent.file.create` 收据确保同一 owner/session/run/round/tool-call 不重复创建；同一收据重放返回 `mutated=false`。Core `files.test.ts` **58/58**、Host 生产 Registry/授权 dispatch **1/1**、Core build、Web Host production typecheck 与 diff 检查通过。Host Registry 测试以合成上传服务验证临时正文、租约授权和收据重放；`file-upload-postgres.test.ts` **1 跳过**（未配置隔离 PostgreSQL URL），真实 PG 上传事务本轮未验收。清单当前 109 项：完成 **69**、待接入 **0**、部分 **20**、共享/平台依赖 **19**、退役/重设计 **1**。Node-only。

2026-11-18 `create_folder` Node 工具接线：Core `files.ts` 限定个人/项目/工作区目标与可选父目录 ID；Host per-lease 端口复用 `FolderWriteOperations.create`，执行 owner/父目录权限检查及既有 Undo/路径镜像副作用。Core 文件组经 ToolRegistry dispatch **59/59**、Host `agent-file-read.test.ts` **1/1**、Core build、Web Host production typecheck 和 diff 检查通过。Host 测试使用临时文件系统与合成 lease/文件域操作，验证真实目录副作用和越权拒绝；隔离 PostgreSQL 文件夹写入、收据恢复及 HTTP/SSE Run 尚未验收，故仅列部分实现。当前 109 项状态：完成 **69**、待接入 **0**、部分 **21**、共享/平台依赖 **18**、退役/重设计 **1**。Node-only，不引入 Python 兼容层或双运行时。

2026-11-18 `move_items` Node 文件组切片：Core 参数只接受 ID 列表（文件与文件夹合计最多 50 项）及明确 personal/project 目标；Host 按当前 lease 和 owner 解析来源版本，逐项复用现有 FileUpdateOperations CAS 与 FolderWriteOperations.move，支持文件夹树移动和部分成功结果。Web production Host 配置、静态工具白名单、Core Registry schema/授权及 per-lease adapter 均已接线。Core `files.test.ts` **60/60**、Host `agent-file-read.test.ts` **1/1**、Core build、Web Host production typecheck 与 diff 检查通过。Host 回归由合成 PostgreSQL/文件服务验证实际 adapter 调用、目标参数、混合结果和撤权；未运行真实 PostgreSQL/HTTP-SSE Run。名称解析、Workspace 目标及当前会话绑定落点尚未接通，仍列部分实现。工具总计 109 项：完成 **69**、待接入 **0**、部分 **22**、共享/平台依赖 **17**、退役/重设计 **1**。Node-only，无 Python 兼容或运行路径。

2026-11-18 `rename_folder` Node 文件组接线：工具只接受 `folder_id`、新名称和可选 expected_version；Host 按当前 lease/owner 读取活动文件夹版本，复用 FolderWriteOperations.rename 的版本 CAS、Undo、重名冲突检查和 PathMirror。生产 per-lease Registry/静态授权接线完成；Core 文件组 **61/61**、Host `agent-file-read.test.ts` **1/1**、Core build、Web Host production typecheck 与 diff 检查通过。Host 测试使用合成 Pool/文件操作端口，验证实际改名调用和过期版本副作用前拒绝。名称定位及同名歧义消解、真实 PostgreSQL/HTTP-SSE Run 未验收，仍列部分实现。当前工具总数：完成 **69**、待接入 **0**、部分 **23**、共享/平台依赖 **16**、退役/重设计 **1**。Node-only，无 Python 兼容或运行路径。

2026-11-18 `send_file` Node Web Agent 接线：Core `send_file` 进入 Web Agent 文件组 Registry；production Host 为每个 lease 注入 owner 文件库/聊天附件解析及受控图片下载、附件暂存端口，URL 图片暂存前按 owner/session/run/token/fence 检查 lease 当前有效。Host adapter 用临时 SQLite 和真实临时文件经 Registry 实际调用，验证 owner 文件内容、路径越界拒绝、失效 lease 不暂存和有效 lease 暂存的字节/artifact；安全图片响应和附件暂存由合成端口提供。Host Registry/dispatch/lease 测试合计 **31 通过、6 跳过**（跳过项需要隔离 PostgreSQL），Core 图片/投递测试 **26/26**、Web Host production typecheck 与 `git diff --check` 通过。真实 PostgreSQL 文件查询、真实附件后端/IM 投递及完整 HTTP/SSE Run 尚未验收，故列部分实现。清单 109 项：完成 **69**、待接入 **0**、部分 **24**、共享/平台依赖 **15**、退役/重设计 **1**。Node-only，无 Python 运行时或桥接。

2026-11-18 `save_uploaded_file` Node 文件组迁移：Core `files.ts` 新增严格参数与 Registry 工具，Host per-lease 端口复用 owner 附件下载、文件上传配额/事务、Undo 和 `agent.file.save_uploaded_file` 持久收据；支持最新附件、精确单个/批量 `attach_id`，以及 personal/显式 project 目标。workspace 目标没有可信会话绑定，未开放。Core 文件行为 **62/62**；Host 附件保存 adapter 经临时真实文件与 Registry dispatch **1/1**，验证上传字节、owner、dispatch lease、同调用收据重放和失效 lease 拒绝；Host Registry/dispatch/lease 合批 **32 通过、6 跳过**（仅隔离 PostgreSQL 用例跳过），生产授权工具端口 **17/17**，Core build、Web Host production typecheck 和 diff 检查通过。Host 附件上传服务、Pool 与事务授权使用合成依赖；未验收真实 PostgreSQL 写入和完整 HTTP/SSE Run。Node-only，无 Python 兼容或桥接。当前 109 项：完成 **69**、待接入 **0**、部分 **25**、共享/平台依赖 **14**、退役/重设计 **1**。

2026-11-18 Node RAG 时间投影补齐：`createWebAgentRagResources` 将自动 RAG 中 conversation 来源的消息时间默认格式化为可信 owner 时区，复用与历史正文相同的 UTC 解释及分钟精度；不再因未注入可选 callback 而漏掉引用时间。Host 资源工厂经真实 Core 持久索引与实际 RAG builder 调用回归 **1/1**，固定 UTC 索引时间在 `Asia/Shanghai` 输出为 `2026-01-02 20:34`；Core RAG **9 文件、70/70**，Host RAG/工具/来源 Worker/Jieba **44 通过、7 跳过、0 失败**，Web Host production typecheck 通过。Host 行为测试使用临时 SQLite、合成 lease 与时区查询；7 项跳过包含需隔离 PostgreSQL 的生产来源/队列用例及 Linux 原子写入用例。`startServer` HTTP/SSE 主链当前因未配置隔离 PG/Redis URL 跳过 1 项；既有隔离服务主链验收记录仍有效，本轮未重复连接。未运行 Python pytest、未调用外部 Provider。Node-only，不增加 Python 兼容运行路径。

2026-11-18 `list_recent_attachments` Node 文件组切片：Core 严格空参数工具经 Core ToolRegistry 返回 owner 草稿与当前 Web 会话已挂载附件元数据；production Web Reconstructor/Main 按当前 lease 注入 PostgreSQL adapter，并只在端口存在时开放工具。Host adapter/真实注册器 dispatch **2/2**、RAG 工具/授权回归 **18/18**、Core 文件组 **64/64**、Web Host production typecheck 通过。Host 数据库与 lease 依赖为合成对象；已覆盖查询 owner/session、run 身份拒绝、取消和 lease 撤销、非 Web 来源拒绝、错误脱敏及旧版草稿年龄格式。附件媒体正文读取及完整 HTTP/SSE Run 尚未接入/验收，因此仍列部分实现；未运行 Python pytest。109 项状态：完成 **69**、待接入 **0**、部分 **26**、共享/平台依赖 **13**、退役/重设计 **1**。Node-only，Python 不在运行路径。

2026-11-18 `grep` Node 文件工具接线：Core 文件组按逐行字面量搜索、逻辑路径范围、上下文、Base64 省略、8 路有界读取及 128 KiB 结果预算输出命中；Host 查询只返回当前 owner 的活动 personal/project/workspace 登记文件，内容通过 `packages/fs` 授权根读取，路径不接受物理路径。生产 Main/Reconstructor、静态白名单、per-lease ToolRegistry 和复验授权已接通。Core `files.test.ts` **67/67**、Host adapter/dispatch **2/2**、Host 工具/授权/注册回归 **49/49**、Core build、Web Host production typecheck 和 `git diff --check` 通过。Node Host 用例用临时文件及合成 Pool；真实 PostgreSQL/HTTP-SSE Run 与全量 Python pytest 对照统一后续验收。当前工具总数 109：完成 **70**、待接入 **0**、部分 **28**、依赖共享能力或平台 **10**、退役/重设计 **1**。Node-only，无 Python bridge/fallback/双运行时。

2026-11-19 `create_workspace` Node 工具切片：Core 严格校验 directory/project/folder 互斥目标，经 Web per-lease Registry 和授权进入 Host；Host 复用现有 PostgreSQL 声明创建、Workspace 顶层目录创建和共享读取投影。Core ToolRegistry dispatch **2/2**、Host 真实 Registry→lease adapter 回归 **2/2**、RAG 权限/注册回归 **49/49**、Web Host production typecheck 通过。三类领域依赖用合成服务，未运行真实 PostgreSQL 或 HTTP/SSE Run；现有创建服务没有 Agent 持久操作收据，因此列为部分实现。Python pytest 未运行；2.0 只运行 Node，Python 是最终移除目标，不保留桥接/回退。工具状态：完成 **70**、待接入 **0**、部分 **27**、依赖共享能力或平台 **11**、退役/重设计 **1**。

2026-11-19 `create_workspace` 持久调用闭环补充：Core 将 owner/session/run/round/call 与参数传到 Host；Host 先持久预留，再调共享 workspace creator，成功后写完整结果回执。相同调用重放/重建恢复仅读回执，参数变化冲突或结果未知时不再次创建；lease 失效在领域副作用前拒绝。Core ToolRegistry **3/3**、Host Registry→lease→SQLite receipt adapter **4/4**，使用临时 SQLite、合成 Pool/lease 与领域服务。生产 PostgreSQL、完整 HTTP/SSE Run 未验收，故状态仍为部分实现；分类计数不变。Node-only，不接 Python 运行路径。

2026-11-19 `delete_folder` Node 文件工具切片：Core 注册稳定 ID 的软删除工具；Web Host per-lease adapter owner 查询后调用既有 PostgreSQL `FolderDeleteOperations`，复用级联软删、文件移入 30 天回收站、Undo 和 PathMirror rollback。Core ToolRegistry 行为 **2/2**、Host adapter dispatch/lease **2/2**、Host 授权/注册/RAG 回归 **52/52**、既有 `folder-delete-postgres.test.ts` 为 **2 通过、1 个隔离 PostgreSQL 用例跳过**、Core build 与 Web Host production typecheck 通过。Host adapter 用合成 Pool/领域端口；按名称定位、批量原子删除、Agent 持久调用收据及真实 PostgreSQL/HTTP-SSE Run 未接入/验收，故列部分实现。工具状态：完成 **70**、待接入 **0**、部分 **28**、共享/平台依赖 **10**、退役/重设计 **1**。

2026-11-19 `save_uploaded_file` workspace 目标补齐：Core Schema 接受 `space=workspace`，不接受模型提供 workspace directory ID；Host 使用共享 `createSessionWorkspaceTargetReader` 读取 owner 当前绑定或默认目录，并在正式上传事务锁住 session 后复核目录未变；绑定项目/文件夹等无可写目录时明确失败，不降级到个人空间。Core `files.test.ts` **67/67**；Host 附件工具真实 Registry dispatch **2/2**，覆盖临时附件字节、个人目标回执重放、workspace 绑定目标与写入前重绑定拒绝；工具注册/授权/生产端口合批 **50/50**；Web Host production build 通过。合成 Pool、Kysely 编译端口和上传服务用于隔离验证；全量 Web Host typecheck 仍有多个非本切片测试类型错误，未验收真实 PostgreSQL 写入或 HTTP/SSE Run。状态仍为部分实现；109 项计数不变：完成 **70**、待接入 **0**、部分 **28**、共享/平台依赖 **10**、退役/重设计 **1**。Node-only；Python 仅为历史行为参考，不保留兼容或运行桥接。

2026-11-19 `delete_file` Node 文件切片：Core 严格接受稳定 `file_id` 或 1-50 个唯一 `file_ids`，Web per-lease Registry/授权后通过正式 `FileDeleteOperations` 单项或原子批量软删除，写入回收站、Undo 和文件资源变更；不接受模型路径，也不触发宿主 Shell。Core `files.test.ts` **68/68**；Host 文件删除/文件夹删除工具组 **5/5**、附件保存 **2/2**、Registry/授权/生产端口合批 **56/56**；文件删除领域行为回归 **8 通过、2 个隔离 PostgreSQL 用例跳过**；Core build 与 Web Host production build 通过。Host 使用合成 Pool 和领域操作端口；真实 PostgreSQL/磁盘事务与 HTTP/SSE Run 未验收；按路径解析和 Agent 持久操作回执仍缺，故列部分实现。109 项当前：完成 **70**、待接入 **0**、部分 **29**、共享/平台依赖 **9**、退役/重设计 **1**。Node-only，Python 仅作为历史行为基准。

2026-11-19 `present_file` Node 文件工具切片：Core 文件组按 file_id、文件库逻辑路径或文件名解析；Web per-lease Host 端口复核 owner/lease，只返回当前网页预览消费所需的文件 ID 和元数据；拒绝本地 `file://` 路径与同时提供两种定位参数。Core `files.test.ts` **70/70**；Host `agent-file-present.test.ts` **1/1**、`agent-rag-tool-ports.test.ts` **21/21**。合成 Pool 和文件清单用于 Host 隔离验证；真实 PostgreSQL/HTTP-SSE Run 尚未验收，故列部分实现。Node-only，不要求 Python pytest 或兼容运行路径。109 项：完成 **70**、待接入 **0**、部分 **32**、共享/平台依赖 **6**、退役/重设计 **1**。

2026-11-19 `list_recent_attachments` 收口：该工具的 Node 契约是列出附件元数据，媒体正文读取不属于它的操作。生产 Web Main/Reconstructor 已按 lease 注入 adapter；实际 Core ToolRegistry dispatch **2/2** 覆盖 owner/当前会话、附件字段与草稿年龄、隐私字段裁剪、身份漂移、非 Web 来源及取消。与 `present_file` 同组 Core `files.test.ts` **70/70**、RAG/生产授权组合 **22/22**；没有重复启动完整 PG/Redis/SSE 环境。状态从部分实现调整为已完成并接入。当前 109 项：完成 **71**、待接入 **0**、部分 **31**、共享/平台依赖 **6**、退役/重设计 **1**。Node-only；不要求 Python pytest 或兼容运行路径。

2026-11-19 `read_file` 逻辑路径支持：单项及批量输入可用文件库 `/personal`、`/project`、`/workspace` 登记路径定位，Host 经当前 lease 的 owner 文件清单精确解析后再次按 owner/file_id 查询，并通过 `packages/fs` 打开；不把模型路径当宿主路径。Core 文件组 **71/71**，覆盖有效逻辑路径、宿主路径/越界路径拒绝及混合定位拒绝；Host `agent-file-read.test.ts` **1/1** 经真实 ToolRegistry、Host adapter、临时文件系统验证返回内容。Host/Core production TypeScript 检查通过；无真实 PG/HTTP-SSE 验收。状态仍部分实现，缺媒体/历史附件/URL及 system scope。Node-only，不要求 Python pytest。


2026-11-19 `unlink_workspace` Node 工具切片：Core 工具组使用持久操作收据，工具调用先建立 owner 绑定的确认意图，确认后在同一收据事务复核 owner、名称和 kind，再复用工作区删除用例解绑声明、会话及普通任务；项目、目录、文件夹、文件和日历提醒保留。Web per-lease Registry、活动 lease 授权、配置白名单和 Main 装配已接通。Core 临时 SQLite ToolRegistry 行为回归 **7/7**（含原 workspace update 5 项），Host RAG/lease 回归 **21/21**、配置白名单/Registry 回归 **29/29**，Core build/typecheck、Web Host production typecheck 与 diff 检查通过。确认依赖为合成凭据；真实 PG/Redis 确认恢复和完整 HTTP/SSE Run 未验收，因此 `unlink_workspace` 记录为部分实现。Node-only，不引入 Python 兼容、桥接或回退。当前109项：完成 **71**、待接入 **0**、部分 **32**、共享/平台依赖 **5**、退役/重设计 **1**。


2026-11-19 `delete_workspace_directory` Node 工作区工具切片：Core 对正整数 `directory_id` 做严格参数验证，确认摘要绑定目录身份、名称、物理路径键和文件/文件夹/会话/任务计数；确认后由 Web per-lease Host 在活动 lease 下预留持久操作收据，复用既有 PostgreSQL/Local 工作区目录删除服务并复核预览快照。Core 工作区 ToolRegistry **9/9**（含 workspace update、unlink 和物理目录删除），Host RAG/授权/注册/目录删除 **51/51**，Web Host production typecheck、`git diff --check` 通过。测试使用临时 SQLite 收据、合成 PostgreSQL lease 查询、确认凭据和目录服务端口；覆盖确认前无副作用、结果收据重放及未知结果不重复删除。真实 PostgreSQL/Redis、磁盘事务和完整 HTTP/SSE Run 尚未验收，故记为部分实现。2.0 仅使用 Node/TypeScript，不保留 Python 兼容、桥接或回退；本轮未运行 Python pytest。当前 109 项：完成 **71**、待接入 **0**、部分 **33**、依赖共享能力或平台 **4**、退役/重设计 **1**。

2026-11-19 `undo_last_action` Node 工具接入：Core 工具组只接受空参数；Host 以 owner/session/run 的 `agent:{sessionId}:{runId}` 上下文挑选最近活动 Undo 记录，并将 operation ID 固定在选择收据中，重试只调用同一现有 Node Undo 状态机，不会转而撤销下一条操作。工具经 Core/Host Registry、静态白名单、每次 dispatch lease 授权及生产 Main 端口装配；不开放模型自选目标 ID。Core 工具行为 **2/2**，Host adapter 临时 SQLite 收据行为 **1/1**，RAG/授权/注册/目录删除合批 **53/53**，Web Host production typecheck 与 `git diff --check` 通过。测试使用临时 SQLite、合成 lease/Pool 与 Undo 服务；项目操作对应的本地目录恢复能力尚未装入 Agent，因此显式返回不可用，工具列部分实现。真实 PG/Redis 和完整 HTTP/SSE Run 未验收；未运行 Python pytest。2.0 只运行 Node/TypeScript，最终目标删除 Python 后端。109 项：完成 **71**、待接入 **0**、部分 **34**、依赖共享能力或平台 **3**、退役/重设计 **1**。

2026-11-19 `undo_last_action` 项目存储补接：在 Agent 和 Web Undo 的 Main 装配中传入已有 `projectTrashStorage` 与受授权根约束的 `projectDirectoryRenamer`，项目撤销不再因 Agent 缺少项目文件存储而被禁用。Host Agent Undo 收据与项目 Undo/临时 SQLite/临时文件系统定向回归 **5/5**，Web Host production typecheck 通过。真实 PostgreSQL/Redis 与完整 HTTP/SSE Run 尚未验收，状态仍为部分实现；本轮仅使用 Node/TypeScript，工具总分类不变。

2026-11-19 `permanent_delete` Node 工具切片：Core `trash.ts` 严格接受 `all=true`，在读取 owner 回收站快照后触发持久用户确认；确认前无任务/磁盘副作用，确认后 Host 复核 lease 与快照，先写操作预留收据再调用既有 `startEmpty`，结果收据可重放且不会再次排队。正式 Node purge Worker 继续按 owner job 快照分批硬删除、续租并发布进度。Core 真实 ToolRegistry 行为 **6/6**，Host Agent adapter/既有 purge job 行为 **5/5**，Core build、Web Host production typecheck 与 diff 检查通过。测试使用临时 SQLite 收据和合成 lease/Pool/确认/job 端口；隔离 PostgreSQL/Redis、Worker 跨进程恢复和完整 HTTP/SSE Run 尚未验收，状态列部分实现。当前 109 项：完成 **71**、待接入 **0**、部分 **35**、共享/平台依赖 **2**、退役/重设计 **1**。本轮只使用 Node/TypeScript。

2026-11-19 定时群任务接入 Node `search_memory`：Core `createScheduledTaskGroupTools` 复用共享 `createMemorySearch`、`createMemorySearchTool` 和本地 owner-bound RAG 存储；当前群 scope 每次解析和检索完成前重验绑定。后台 Run 没有当前 IM 发送者身份，因此 `private_memory` 与 `all_my_groups` 显式拒绝，默认只用当前群 BM25；owner/run 不匹配、群绑定撤销后不返回正文，工具发现和 dispatch 均拒绝。Core Memory/群工具真实 ToolRegistry 回归 **13/13**，Web Host 定时任务 Runtime **3 通过、2 跳过**（隔离 PostgreSQL/Redis 未配置），Core build 与 Web Host production typecheck 通过。新增行为测试使用合成群身份、内存 storage reader 和 scope-state reader；生产定时群 PostgreSQL/Redis 主链未验收，`search_memory` 整体仍列部分实现。未运行 Python；2.0 仅 Node/TypeScript。

2026-11-19 `read_file` 增加 Node PDF/Office 正文提取：Owner 文件解析仍由 Web Host PostgreSQL adapter 完成，磁盘读取经 `packages/fs` 授权根；Core 复用 `files/office-text.ts`，限 PDF/DOCX/XLSX/XLS/ODS/PPTX/ODT/ODP/RTF，单文件不超过 30 MiB，批次继续受 64 MiB 上限约束，提取失败不暴露底层异常。Core 文件组/Office 提取 **92/92**，Host production Registry 临时 PDF 文件实际调用 **1/1**，Web Host production typecheck 通过。测试使用临时目录、合成 owner 文件行，Office 提取器为真实 Node 实现；真实 PostgreSQL/HTTP-SSE Run 未验收。未运行 Python。


2026-11-19 `edit_file` 补齐可调用编辑操作：Core `files.ts` 接受 owner 文件 ID 或文件库逻辑路径，支持全文替换、追加、查找替换、按行替换/删除及最多 20 项批次，修改后正文不超过 256 KiB；数字行修改要求 `expected` 校验原文，范围重叠拒绝，批次逐项报告失败，任一写入结果未知时不伪报普通失败。Web Host 在当前 lease 下复用 owner 文件清单解析路径，再经 owner 文件查询和现有文件内容 CAS/Undo 事务更新。Core 文件组 ToolRegistry **74/74**，覆盖行修改/删除、原文及重叠校验、批次部分失败、owner 隔离；Host per-lease Registry 真实临时文件行为 **1/1**；Core build 与 Web Host production typecheck 通过。测试使用临时目录、合成 Pool/文件清单/文件事务；真实 PostgreSQL 与完整 HTTP/SSE Run 留待集中验收。本轮未运行 Python pytest。


2026-11-19 `create_file` 批量与可信工作区目标补齐：Core 文件组支持最多 20 项创建并逐项返回成功/失败，每项派生稳定工具调用 ID 供 Host 收据去重；单文件 UTF-8 上限 256 KiB，按扩展名拒绝 PDF/Office 二进制伪写。Host workspace 目录从当前 owner/session 的可信绑定读取，上传事务锁定 session 后复核目录未变；不接受模型提供 workspace directory ID。Core files ToolRegistry **74/74**；Host create batch/文件字节/lease/独立收据/重放 **1/1**，既有 Host 单文件创建回归 **1/1**，Web Host production typecheck 通过。测试使用临时暂存目录、合成 Pool/上传事务；真实 PostgreSQL 与 HTTP/SSE Run 留待统一验收。Node-only，本轮未运行 Python pytest。

2026-11-19 RAG 生产 Node 主链验收复跑：Core RAG **70/70**；Host RAG 端口/资源/重建器/正式 PostgreSQL 索引 Worker/Jieba/向量/BYOK/共享语料及来源事务 **51 通过、5 跳过**（跳过项含 Linux 专用安全写入）。使用临时 PostgreSQL cluster/schema、Redis、owner 文件目录和本机合成 Provider，`startServer → HTTP/SSE → 持久 dispatch → Reconstructor → ToolRegistry` **1/1 通过**，覆盖八类 RAG 来源写入 PostgreSQL 索引、双 owner 隔离、Node Worker 调度和 `search_conversations` 返回当前 owner 命中后送入 Provider 续轮。不是生产数据或真实外部 Provider 验收。Web Host production build 通过；测试只使用 Node，不引入 Python bridge、fallback 或双运行时。

2026-11-19 `read_file(attach_id)` Node 文本附件切片：Core 参数支持单项/最多 20 项 attach_id，与文件 ID/逻辑路径严格互斥；只读 owner 附件记录，经 `packages/fs` 打开，支持白名单文本及 PDF/Office、行号选择、32 MiB 单项与 64 MiB 批次限制。Web per-lease reader 在当前 Run owner 不匹配时不查询附件表；图片/音频/视频明确拒绝，不返回假媒体结果。Core 文件组 **75/75**；Host 实际 Core ToolRegistry→Host adapter→临时附件文件 **1/1**，Web Host production typecheck 与 diff 检查通过。测试用合成 Pool 与临时文件；真实 PostgreSQL/HTTP-SSE Run 未验收。Node-only，本轮未运行 Python。

2026-11-19 `list_dir` Node 文件库路径与查询切片：Core Schema 接受 `file_path=/personal`、`/project/{项目名}`、`/workspace/{工作区名}` 文件库登记路径并拒绝宿主路径、越界片段和与 `space` 等过滤字段混用；Host per-lease 端口按 owner 精确解析项目/工作区与逐层文件夹，再调用既有文件浏览服务。Core 将最多 8 个关键词去空白、截断、去重，并传递 OR/AND；Host PostgreSQL 浏览服务安全绑定查询词、执行过滤计数并返回准确文件总数。生产 Main 注入 Host Pool。Core `files.test.ts` **77/77**，Host 实际 Core ToolRegistry→owner SQL/文件分页 SQL **3/3**，覆盖路径解析、异主拒绝、AND 参数化、去重及 total。Host SQL 用合成 Pool；真实 PostgreSQL/HTTP-SSE Run 留待统一回归。旧版 Shell `scope=logical` 用户目录根映射、system scope、偏移分页和全量文件夹语义仍未装配；Node-only。

2026-11-19 `delete_file` Agent 持久收据补齐：单项/批量工具以 owner、session、run、round、call ID 派生稳定收据，在正式删除事务内再次验证 lease，并与软删、30 天回收站和 Undo 一起提交。提交结果未知返回 `unknown`；reconcile/重放只读取 owner 收据，不重复删除，批量 Agent 调用在事务内验证完整 owner 集合。Core `files.test.ts` **77/77**；Host 实际 Core ToolRegistry/授权/回执恢复 **7/7**；临时 PostgreSQL 领域事务、收据重放、owner 缺项、Undo、PathMirror 与并发回归 **11/11**；Web Host production build 和 `git diff --check` 通过。Host adapter 使用合成 lease/Pool；PostgreSQL 与文件系统测试使用临时 schema/目录。进程在提交确认前崩溃后遗留硬链接的清理恢复、路径定位及完整 HTTP/SSE 文件工具 Run 未验收；Node-only，本轮不运行 Python。

2026-11-19 `delete_file` 登记逻辑路径补齐：Core 接受 `file_id`、`file` 或 `file_ids` 三种互斥形式；`file` 仅接受 `/personal`、`/project`、`/workspace` 的登记路径，拒绝宿主路径、`..` 和空路径片段。Web lease Host 复用当前 owner 的文件清单做精确唯一匹配，随后仍调用带持久收据、Undo 和回收站的正式删除事务；未匹配/重名时不产生删除副作用。Core 文件组 **77/77**，Host 实际 ToolRegistry/授权/路径解析/删除 **8/8**，Web Host production build 通过。Node 用例使用合成 FileGrep 列表、Pool 与删除事务端口；真实 PostgreSQL/完整 HTTP-SSE 路径删除未验收。`delete_file` 仍列部分实现，未解决的硬链接崩溃清理与 HTTP/SSE 验收不变；本轮未运行 Python pytest，2.0 只有 Node 执行路径。

2026-11-19 `rename_file` 登记逻辑路径补齐：Core 接受 `file_id` 或 `file` 两种互斥定位；`file` 只允许安全的 owner 文件库路径，通过同一 dispatch lease 的 owner 文件清单精确唯一解析，再调用既有文件更新/CAS/Undo 端口。宿主路径、`..`、空段与不唯一路径均无副作用。Core `files.test.ts` **77/77**；Host 文件工具生产 registry（含真实 ToolRegistry→路径解析→更新端口）**1/1**，Web Host production build 通过。用合成 owner 文件清单、Pool 和更新服务验证；真实 PostgreSQL/HTTP-SSE Run 未验收，旧版名称消歧及扩展名规则仍未迁移。Node-only，本轮未运行 Python pytest。

2026-11-19 `copy_file` 登记逻辑路径补齐：Core/Host 实际 ToolRegistry 接受 `file_id` 或 `file` 源文件，`file` 仅允许 owner 文件库 `/personal`、`/project`、`/workspace` 路径，并由当前 lease 的文件清单唯一解析；不唯一、越界或宿主路径不触发复制。复制仍复用既有 Host owner/目标空间/配额/文件系统事务、keep_both 与 Undo，不开放覆盖。Core `files.test.ts` **77/77**、Host 文件工具生产 registry **1/1**、Web Host production build 通过。测试使用合成 owner 文件清单、Pool 与复制端口；真实 PostgreSQL/HTTP-SSE Run 未验收，状态仍为部分实现。本轮未运行 Python pytest，Node-only。

2026-11-19 `copy_file` 持久调用回执补齐：Core 将 Run 轮次及 ToolCall ID 传至 Host；正式复制事务在再次校验当前 Web lease 后，通过 owner 范围 advisory lock 去重，并将副本、Undo、文件变更记录和调用回执一并提交。相同调用重放返回原结果且 `mutated=false`；Run 恢复只查收据；提交结果未知返回 `unknown`，不盲目再复制。Core 文件组 **77/77**，Host 实际 ToolRegistry/合成 Pool/lease 回归 **1/1**（首次副作用、精确重试、恢复读取），Core build 与 Web Host production typecheck 通过。依赖使用合成 Pool、lease、授权和文件复制端口；没有使用真实 PostgreSQL/磁盘或 HTTP/SSE Run。`copy_file` 仍为部分实现，真实 PostgreSQL 与 HTTP/SSE 验收未完成；本轮未运行 Python pytest，Node-only。

2026-11-19 `rename_file` 持久调用回执补齐：Core 在解析 `file` 逻辑路径前尝试恢复收据；Host 在 owner/活动 dispatch lease 复核后，将存储路径规划、版本 CAS、Undo、文件变更与调用回执放入同一 PostgreSQL 事务。重复调用及 Run 恢复只读原结果，提交未知保持 `unknown`；因此成功改名后源路径失效也能精确恢复。Core 文件组 **77/77**，Host 实际 ToolRegistry/合成 Pool/lease 回归 **1/1**，Core build 与 Web Host production typecheck 通过。隔离实际 PostgreSQL/文件系统与 HTTP/SSE Run 未验收，`rename_file` 仍为部分实现；本轮未运行 Python pytest，Node-only。

2026-11-19 `rename_file` 文件名规则对齐：Core 按 Python 基准接受完整文件名（如 `docker-compose.yml`），无扩展名时沿用原扩展名，支持显式 `format`、md/markdown、txt/text、yaml/yml 归一和最长 20 字符安全后缀；Host 仍通过共享文件更新事务拒绝文本/二进制类型跨界改后缀并保留原字节。ToolResult 带上旧文件名。Core 文件组 **77/77**（完整名拆分、别名和 Host 端口参数），Host 文件 ToolRegistry **1/1**（扩展名更新、旧名、收据恢复），Core build、Web Host production typecheck 通过。批量改名及真实 PostgreSQL/HTTP-SSE Run 尚未完成；没有运行 Python，Node-only。

2026-11-19 `move_items` 文件逻辑路径补齐：Core `files` 参数可为稳定 ID 或登记文件库逻辑路径；Web Host 在当前 lease 下读取 owner 文件清单并唯一解析每个路径，未找到或重名项按旧逐项结果语义报告失败，其余项目继续处理。`..`、宿主路径和文件名猜测在验证阶段拒绝；文件夹仍使用稳定 ID，目标仍限 personal/project。Core 文件组 **77/77**、Host 文件生产 registry（真实 ToolRegistry→owner 文件清单→CAS/文件夹领域端口）**1/1**、Web Host production build 通过。测试用合成 Pool、owner 清单和文件事务端口；真实 PostgreSQL/HTTP-SSE Run 未验收，工具仍部分实现。本轮未运行 Python pytest，Node-only。

2026-11-19 工作区工具 ID 参数收紧：`create_workspace` 的 project_id/folder_id，以及 get/update/unlink 的 workspace_id 现在统一要求正安全整数；零和负数在 Core ToolRegistry 参数验证阶段拒绝，不触发 Host/数据库调用。Core workspace create/update/unlink 行为回归 **11/11**，Core build 通过。此修正不改变生产能力分类；Node-only，本轮未运行 Python。

2026-11-19 `ask_user` Node 契约收敛：Schema 只声明当前 Host 提示层和 Core 协调器都能执行的 `choice`/`question`；`form` 不再作为可调用参数暴露。经实际 Core ToolRegistry 分派的 coordinator 回归 **18/18**，覆盖 unsupported form 在校验阶段拒绝且不创建交互，以及普通问题等待/恢复与回答脱敏；Core production build 与 `git diff --check` 通过。完整授权 HTTP/SSE + PostgreSQL/Redis 仍未验收，工具状态不升级。仅运行 Node，不增加 Python 兼容或回退路径。

2026-11-19 RAG 生产集成回归增加 `save_knowledge` Linux 分支：正式 Web Agent 经 HTTP/SSE 和 `call_tool` 写入 owner 知识，再由 Node RAG Worker 建立该 owner 的持久索引。当前在 macOS 用 Node 26、临时 PostgreSQL/Redis 和环回合成 Provider 实跑主链 **1/1 通过**，验证 `search_conversations` owner 隔离及会话索引 Worker；`save_knowledge` 分支遵循 `writeLocalFile` Linux 安全原子发布能力，本机不暴露该工具，故未执行，仍需 Linux 验收。测试未调用 Python 或真实外部 Provider。


2026-11-19 隔离生产 Agent RAG 主链复验：临时 PostgreSQL schema、临时 Redis、owner 文件目录及环回合成 Provider 下，正式 `startServer → HTTP/SSE → 持久 dispatch → Reconstructor → ToolRegistry` 测试 **1/1 通过**。证明当前 Node Web Run 的 `search_conversations` 端到端调用与双 owner 索引隔离。测试文件中的 `save_knowledge` 写入/索引断言限定 Linux；macOS 按安全原子文件发布能力不注册该工具，因此本次未执行该分支，不计其通过。显式使用 Node 26；从 Web Host 子目录裸调用的 Node 22 会被启动时 POSIX 锁版本门拒绝。临时 PG/Redis 与目录已停止并清理，未触碰用户配置或真实数据。

2026-11-19 `delete_folder` Node 回执补齐：Agent 工具调用用 owner/session/run/round/call 派生稳定回执键；Host 在既有文件夹软删事务中再次验证活动 lease，并将工具结果与子树软删、回收站、Undo 同事务提交。提交确认未知时返回 `unknown`，重建经 owner 回执恢复原结果，不重复删除。Core ToolRegistry **3/3**；Host 文件夹删除、lease 授权、实际 registry dispatch、未知提交恢复和领域行为 **11 通过、1 跳过**，跳过项需显式隔离 PostgreSQL URL。Node Host 使用合成 Pool/事务端口；未验收真实 PostgreSQL、进程崩溃后的 PathMirror 清理恢复和完整 HTTP/SSE 文件工具 Run。Core build 通过；本轮只验证 Node 2.0 路径，未运行 Python pytest。
