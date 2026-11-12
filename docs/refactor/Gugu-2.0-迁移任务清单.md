# Gugu 2.0 迁移任务清单

> 更新：2026-11-13。本文维护实施顺序、当前状态、验收证据与未完成任务。目标架构和多端职责见[架构说明](Gugu-2.0-架构说明.md)；依赖替换盘点见[Python → Node 依赖迁移矩阵](Gugu-2.0-Python-to-Node-Dependency-Migration.md)。
>
> **当前路线：先完成 Node Web/NAS 后端迁移，再基于稳定的共享 Core 推进桌面产品化。** Web 使用 Node Host + PostgreSQL；桌面使用 Electron + Node Core + 本地 SQLite。两端共享 Core 契约，但拥有不同 Host 和数据生命周期。迁移期间未具备完整 Node 命令的 Web 写路径继续整体走 Python，不双写。

## 执行顺序

1. **N0–N1：共享 Core 基线。** 已确定边界并完成项目/联系人数据切片；补齐性能预算和业务 schema/升级交接。
2. **N2：Node Web/NAS 后端。** 优先建立 Node HTTP Host，保持现有 API/SSE 契约，先迁移完整业务命令与 PostgreSQL 写路径。
3. **N3：扩展数据域与 Agent。** 按完整事务边界迁移会话、消息、任务、Provider、工具、RAG 等业务，逐步退役旧 Python 生产调用方。
4. **N4：桌面产品化。** 复用已稳定的 Core 业务能力，完成 Electron + 本地 SQLite、端侧能力和发行验收。桌面 UI 可提前做不依赖未稳定 Core 的准备，不提前切换业务写路径。
5. **N5：兼容收敛与 2.0 发布。** 确认无生产 Python 调用方后删除对应兼容代码；独立计算服务可继续保留。

## 5. 迁移 checklist

`[x]` 表示该项已有代码或明确交付证据；`[ ]` 表示未完成，部分已有基础也不勾选。实现完成、PR 合并、正式发行分别记录。不得用 CI 总数或目录存在推断业务等价。

### N0——边界与基线

- [x] 确定顶层 Core、端侧 FS/沙箱、桌面单用户和服务端多用户边界。
- [x] 确定 TS/Node 方向；当前使用 Node 26 LTS、pnpm 10.15、Kysely、Zod、better-sqlite3 与 pg，版本由 lockfile 固定。
- [x] 桌面切换到 Electron + TS Host 验证实现；复用 Vue 入口、独立 Node Core 和原生 Broker 边界，完整产品与发行另行验收。
- [x] 建立可移植 Domain/Contracts、独立 Core 包和依赖边界检查。
- [x] 保留 Python 参考实现及首批共享合成语料。
- [x] 建立现有 Node Core 对应 Python 行为映射与有意差异登记，见测试专题。
- [ ] 冻结冷启动、内存、包体、IPC 等待、读写 P50/P95、取消/恢复的同口径性能预算。

### N1——数据统一底座，先覆盖项目/联系人

- [x] 项目/联系人领域校验、应用服务与共用 SQL 仓储。
- [x] SQLite/PG Adapter、UoW、跨域提交/回滚、owner 隔离和项目 CAS。
- [x] UUID、UTC 微秒、列别名、归档/墓碑过滤与旧库互读的首批契约。
- [x] SQLite 显式初始化、备份升级、坏库/部分唯一约束拒绝及失败恢复。
- [x] 原子操作收据、冲突检查、重启后查询及未知结果恢复提示。
- [x] 修复满队列/并发关闭、非法收据参数、时间/编号边界；仓储与事务职责拆分，启用未使用代码检查。
- [x] 补充现有项目/联系人同逻辑回归、共用双库契约、Python 序列对照及 pytest 语义分层；最终门禁结果以 PR 为准。
- [ ] 完整业务 schema/Alembic 历史、升级与跨版本回滚策略交接。

### N2——Node Web/NAS 后端迁移

**当前基线**：Node 26 WebUI Host 已提供健康检查、PostgreSQL readiness 和主站/Admin 静态资源；API 路由清单已映射 390 个 Python method/path，Node 当前接入 26 个。现有接口包括站点配置、密码登录/当前用户/登出/资料更新、项目读取与创建、工作区声明创建及会话绑定/解绑/查询、日历读取与创建/更新/删除、联系人读写、通知读写及埋点。项目/日历写路径具备对应事务、owner 隔离和事件回归；具体状态见 [Node WebUI API 迁移清单](Gugu-2.0-Node-WebUI-API迁移清单.md)。注册、找回、邮箱变更、头像 API、完整工作区列表与 directories CRUD、Admin Host 集成、SSE、Agent dispatcher 和 Python Worker 调用方仍未完成；登录限流仍是单进程内存实现。Node 尚不能承载完整 Web 流量，不能使用 Python 隐式回退。

- [ ] 建立独立 Node HTTP Host，接入 `gugu-core` 与 PostgreSQL，并承担 Web/NAS API 请求；不把桌面 Electron Host 当作服务端。
- [x] 盘点 Python 当前字面 HTTP/WebSocket 路由并映射 Node method/path 与已有回归；详见 [Node WebUI API 迁移清单](Gugu-2.0-Node-WebUI-API迁移清单.md)。此项不代表接口行为等价或覆盖完整。
- [ ] 盘点 API、Agent 工具、Worker/调度、撤销和迁移的所有写入口。
- [ ] 保持现有 HTTP/SSE、可信身份到 DataContext、错误与字段映射契约兼容。
- [ ] 完整命令中的幂等、撤销、版本、关联记录、文件联动与提交后事件一起迁移。
- [ ] 真实 PG 外键/锁/连接恢复、跨用户、并发和故障注入验收。
- [ ] 每个写域全部调用方切换后，再移除其旧 Python 写实现。
- [ ] Node 路径覆盖 Web 所需业务后，将 Web 默认运行切至 Node；保留明确识别的独立计算服务，不以 Python API 作为隐式回退。

### N2 第二块切片核查（初始 2026-11-12，续更 2026-11-13，未验收）

本轮将待迁移工作按 Agent Web API、Admin API、非 HTTP 写路径分开核查；没有把路由注册或 Node 空模块当作行为迁移。以下均未标完成。用户要求所有测试在 devserver 运行；本轮 Python 和 Node 验证均在 devserver 执行。

- **Python 基线**：命令 `cd backend && PYTHONPATH=.:../compat/core-python/src <devserver现有测试环境>/bin/pytest -q <上述九个测试文件>` 在 devserver 运行，`169 passed, 3 warnings in 42.27s`。该环境借用了现存 Gugu-web Python 3.12 pytest 环境，未在 gugu2.0 仓库创建/修改虚拟环境；测试工作树是 devserver 的 gugu2.0 同步副本。回归文件包含下列 Agent、Admin 感知与 Worker admission 测试。
- **Agent Web API**：chat、attachments、interactions、pending_queue 与 messages 完整行为仍未迁移；会话列表和持久消息页另有未接 Host 的独立原型。主要 Python 基准文件：`backend/tests/agent/test_agent_api_messages.py`、`test_interaction_protocol.py`、`test_interaction_phase5_7.py`、`chat/test_chat_pending_queue.py`、`chat/test_chat_attachments_ownership.py`、`platform/realtime/test_web_stream_contract.py`、`test_genstream_cancel.py`。Python 调用链还依赖 `agent.gateway.web`/`agent.llm.genstream`、会话与工作区存储、owner-scoped orphan recovery、Redis 取消标记、附件暂存/转码和 pending queue claim token。会话 A 需提供 Agent Store/Runtime 与 SSE/流恢复 Host 集成，才能完成跨边界行为验收。
- **Agent 会话列表原型（未接 Host、PG 未验收）**：新增 `gugu-webui/src/domains/agent-sessions/agent-sessions.ts` 与 `gugu-webui/tests/agent-sessions.test.ts`，Fastify `GET /api/v1/agent/sessions` route module 在认证 preHandler 后只从 Host 提供的可信 `userIdFromRequest` 取 owner，不读 query/header 中的 owner；列表按 Python 语义查询 owner 会话、Web/IM 分别取最近 50 条、投影运行态、可见助手回复、工作区和文件系统授权。Python 基线 `backend/tests/agent/test_session_badges.py::test_session_list_exposes_only_owned_web_reply_and_running_state` 在 devserver 串行 1/1 通过。Node route 行为测试 2/2 通过；随机 schema PostgreSQL 测试因未设置隔离 `GUGU_WEBUI_TEST_DATABASE_URL` 跳过，SQL 行为仍无 PG 验收证据。两个文件 strict TypeScript 检查通过。会话 A 仍需注册 route 并提供认证后的 userId accessor、Redis active-status、workspace 能力与授权开关 adapter。
- **Agent 消息历史原型（未接 Host、PG SQL 未验收，行为不完整）**：新增 `gugu-webui/src/domains/agent-sessions/persistence/agent-message-history.ts` 与 `gugu-webui/tests/agent-message-history.test.ts`，仅实现 owner-scoped 持久消息分页及基础投影。Python 基线在 devserver 串行 4/4 通过：`test_get_session_messages_404_for_foreign_or_missing_session`、`test_get_session_messages_window_filters_and_has_more`、`test_get_session_messages_before_id_page_is_oldest_first`、`test_get_session_messages_preserves_run_identity_for_plain_replies`。Node 26.13.1 只读容器执行 `node --import tsx --test tests/agent-message-history.test.ts` 得 3 passed、1 个 PG 集成用例因未设置 `GUGU_WEBUI_TEST_DATABASE_URL` 跳过；切片 strict TSC 通过。Node 现已对齐缺失 `through_id` 游标、JSONB literal null、1 MiB timeline 上限，并去除工具输入/结果与媒体载荷；真实 PG SQL 仍未验收。仍缺 orphan-run recovery、交互/队列、活动状态、工具详情、群聊提及、QQ 附件占位和 workspace 授权。Host 需提供认证后 owner、消息服务查询入口及 SSE/runtime 集成。此模块不计为 HTTP 路由已接入。
- **Admin API**：Provider/LLM/语音配置、Agent 管理、分析/感知、沙箱、更新和运维路由均仍待迁移。Analytics/Perception 基准 `backend/tests/agent/test_perception_stats_api.py` 六项覆盖空窗口、事件配对、活跃用户门槛、时间窗、开发者过滤和误判标记。行为依赖 Redis `perc:events`/`perc:misread_cases`、`users.is_developer` 和 `agent.memory.store.read_misread()`；Analytics 还依赖业务表及 `admin_analytics_metrics`。Node 注册仍需会话 A 集成 `gugu-webui/src/app.ts`。
- **Admin 安全事件只读原型（未接 Host、PG 未验收）**：新增 `gugu-webui/src/domains/admin/admin-audit-log.ts` 与 `gugu-webui/tests/admin-audit-log.test.ts`，只覆盖 `/api/v1/admin/audit-log/security-events`。Python 安全事件基线 `backend/tests/platform/security/test_ownership_security_events.py` 3/3 通过；Node 22 devserver route 测试 4/4 与独立 strict TSC 通过，但 `gugu-webui` 要求 Node `>=26.13.0 <27`，所以 Node 22 结果不作为目标运行时验收。随后使用 devserver 缓存的 Node 26.13.1 镜像，以断网/只读挂载/8 MB tmpfs 重跑，route 行为 4/4 与独立 strict TSC 通过。测试 query adapter 为 fake，真实 PostgreSQL SQL/索引/列兼容未验收。响应只映射 allowlist 字段，HMAC 指纹替代原始用户 UUID，不返回 metadata/raw IP。Host 需注入可信 Admin preHandler、PG adapter 和与 Python 相同密钥算法的 `fingerprintUserId`。普通 `/api/v1/admin/audit-log` 的 Python DTO 明文返回 username/description/IP，与“不回显敏感信息”目标冲突，继续留在 Python 并待契约决策；本原型未把任何 Admin HTTP 路由标成已接入。
- **非 HTTP 写路径**：Node 目前没有集成 Worker/scheduler/queue-consumer/Undo 执行路径；已有 admission、租约协调器和数据规范化迁移入口等独立模块，详见下列未集成原语。Worker admission Python 基准在 `backend/tests/platform/deployment/test_worker_admission.py`，包括 `test_run_once_keeps_unacked_backlog_out_of_process`、`test_run_once_does_not_redispatch_local_pending_claim_and_uses_free_slot`、`test_refresh_concurrency_releases_waiting_agent_slot`。Python Worker 以已 claim 未 ack 集合占用容量，buffered 任务仍占槽，ack 才释放；stale claim 会排除本进程已 pending 项。调度、Undo、其他队列消费者和写入方仍需完整盘点/迁移。
- **Worker admission Node 原语（未集成）**：新增 `gugu-webui/src/workers/admission.ts` 和 `gugu-webui/tests/worker-admission.test.ts`，只实现容量/pending/buffer/ack 状态原语，尚未连接 Redis Stream consumer、租约或 Worker lifecycle，因此不算 Worker 迁移完成。devserver Node 26.13.1 临时容器只读挂载下，`node --import tsx --test tests/worker-admission.test.ts` 3/3 通过；该文件独立严格 TypeScript 检查通过。
- **Worker 消息租约协调器（未集成）**：新增 `gugu-webui/src/workers/message-lease.ts` 和 `gugu-webui/tests/worker-message-lease.test.ts`。Python 基线 `backend/tests/platform/deployment/test_worker_admission.py::{test_processing_and_completed_claims_have_distinct_ack_behavior,test_message_lease_completion_and_expiry_allow_reclaim}` 在 devserver 通过（2/2）；Node26 实现前因模块不存在红灯，补实现后 Node 测试 2/2 通过，worker 两组测试合跑 5/5，独立严格 tsc 通过。当前只实现协调器和存储端口；Redis Lua 原子认领/完成、续租、重启恢复与真实 consumer 接入仍待迁移。
- **Worker Redis 租约原子适配器（未集成）**：新增 `gugu-webui/src/workers/redis-message-lease.ts` 和 `gugu-webui/tests/worker-redis-lease.test.ts`。Python 基线 `backend/tests/im/test_inbound_recovery.py::test_lost_lease_does_not_silently_keep_renewing` 在 devserver 通过（1/1）；Node26 模块缺失红灯后，实现测试 4/4 通过，与 message-lease 协调器合跑 6/6，相关源码及测试严格 tsc 通过。适配器复用 Python `imstate:{message_id}` Cluster hash-tag key、120 秒处理租约、30 秒心跳常量、3600 秒完成标记及 owner 校验。Node 测试用内存 eval 端口替身验证契约，未真实执行 Redis Lua；真实 Redis consumer、续租任务调度、过期重领/重启恢复仍未迁移。
- **Worker Redis Stream 消费编排（局部原语，未接业务/Host）**：新增 `gugu-webui/src/workers/{consumer,redis-stream-queue}.ts` 和 `gugu-webui/tests/worker-consumer.test.ts`。对照 Python `backend/worker.py` / `backend/app/core/redis.py`，读取 `data` JSON 字段、先重领 stale PEL、按 Python 并发两倍且最多 128 条做本地准入、按 conversation key 串行、每 30 秒续 120 秒租约，业务返回后持久标记完成再 `XACK`；处理失败/丢租约留 PEL，shutdown 等当前任务收尾。Python 基线在 devserver 串行运行 `tests/im/test_inbound_recovery.py tests/platform/deployment/test_worker_admission.py`：15/15 通过。Node26 对临时隔离 Redis 实跑 4/4 通过，覆盖失败重试/重复投递/租约被接管/完成后补 ACK/心跳/会话串行与跨会话并行/shutdown；未设置 `GUGU_WORKER_TEST_REDIS_URL` 时测试明确 skip 4/4。测试完成后临时容器和网络均无残留。该模块 strict TSC 通过；全项目 TSC 仍被并行 `src/domains/admin/admin-auth.ts` 参数数目错误及缺失的 event-update 模块/测试导入阻断。实际 IM handler、per-session 持久 checkpoint/started receipt、silent-batch recovery 和 Host 轮询/退出生命周期仍由 Python/Host 执行，故不是 Worker 切换完成。
- **一次性定时任务执行原型（未接 DB/Redis/APS/Host）**：新增 `gugu-webui/src/scheduled-task-runner.ts` 与 `gugu-webui/tests/scheduled-task-runner.test.ts`，以 Repository/Lease/execute 端口描述到期检查、先持久化 started、一次性任务失败重试、成功后删除及超时锁恢复。Python 执行状态与续租基线在 devserver 串行 5/5 通过；锁持有与宽限期基线另 3/3 通过。Node26 行为测试 5/5、worker admission/message-lease/Redis lease 合跑 9/9，相关文件 strict scoped TSC 通过；测试使用 devserver Node26.13.1 断网、只读挂载、8 MB tmpfs 临时容器，没有启动 PG/Redis。该原型没有真实 PG/Redis adapter、通知 outbox/提交后事件、APScheduler 生命周期或 Agent/渠道执行，不能算定时任务迁移。
- **群工具权限迁移原语（未集成）**：新增 `gugu-webui/src/migrations/group-tool-permissions.ts` 和 `gugu-webui/tests/group-tool-permission-migration.test.ts`。Python Alembic 基线 `backend/tests/agent/knowledge/test_group_tool_permission_migration.py::test_migration_preserves_provider_search_and_normalizes_legacy_group_tools` 在 devserver 通过（1/1）；Node 先红灯后实现测试 2/2 通过，独立严格 tsc 通过。原语事务内 `SELECT ... FOR UPDATE`、按 Python 规则规范化 `user_bots.group_allowed_tools`、仅更新变更行、失败回滚并释放连接；显式调用且不在启动时写库。另有随机 schema PG 测试；当前 devserver 未设置隔离 PG URL，故真实 PG 验收未完成。测试在缺少该 URL 时会明确跳过，避免全套测试误报失败。一次性 `postgres:17-alpine` 容器因 `No space left on device` 无法初始化，容器/网络已清理且未做磁盘清理。此入口不替代现有 Alembic revision；需要会话 A 提供显式运维入口和 Pool，不代表迁移数据写入方已切换。
- **Undo/撤销（未迁移）**：Python 基线 `backend/tests/storage/files/test_undo_files.py::test_file_create_undo_redo_and_version_conflict` 在 devserver 通过（1/1）。Node 缺少 `UndoOperation` 表、owner/context stack、`UndoService.apply`/`FileUndoAdapter` 和与 `LocalStorageBackend` 协同的删除/恢复及 copy-on-write artifact 生命周期；不可用相似孤立逻辑代替完整撤销语义。Python 调用方仍负责文件创建/Undo/Redo副作用，等待共享数据和存储契约后再迁移。
- **Admin Analytics/Perception 原型（未集成）**：新增 `gugu-webui/src/domains/admin/admin-perception.ts` 和 `gugu-webui/tests/admin-perception.test.ts`，6 项 Node 行为测试在 devserver Node 26.13.1 临时只读容器通过，覆盖活跃门槛、最近事件配对、用户宏平均、开发者过滤、时间窗、异常 flags、预览和脱敏导出；`gugu-webui` 全量 TypeScript 检查通过。路由尚未由 Host 注册，真实 Redis/DB/记忆读取与可信管理员 guard 仍需会话 A 注入，故不算 Admin API 迁移完成。
- **Admin Agent 用量原型（未接 Host、PG 未验收）**：新增 `gugu-webui/src/domains/admin/admin-agent-usage.ts` 和 `gugu-webui/tests/admin-agent-usage.test.ts`，复用 Python `/usage` 的历史 token cutoff、时区边界、BYOK/开发者过滤和聚合响应。Python `backend/tests/agent/test_agent_admin_usage.py` 在 devserver 串行 7/7 通过。Node26 行为测试 3 项通过、真实 PG 随机 schema 测试 1 项因无 `GUGU_WEBUI_TEST_DATABASE_URL` 跳过；可运行用例检查完整聚合映射、过滤和 cutoff SQL、时区回退/参数及未授权时不查询。TypeScript build 范围检查通过；全量检查被并行 `admin-auth` 和 `event-update` 改动阻断（见全量快照）。仍需 Host 注入 Admin guard 和 PostgreSQL query adapter，真实 PG 数据聚合尚未验收。
- **Admin Analytics summary 原型（未接 Host、SQL 未验收）**：新增 `gugu-webui/src/domains/admin/admin-analytics-summary.ts` 与 `gugu-webui/tests/admin-analytics-summary.test.ts`，覆盖 summary 响应形状、管理员拒绝、exclude_dev/include_byok 默认值、时区起点及错误脱敏。Python 对应 handler 为 `backend/app/api/v1/admin_analytics.py::get_summary`，仓库未找到该 handler/service 的直接回归测试，因此没有可报告的 Python 行为基线。Node26 devserver 定向测试 4/4、严格定向 TSC 通过；测试使用查询替身，未验证 CTE/JSONB 聚合与真实 schema，且无隔离 PG URL，不能据此判定 SQL 与 Python 等价。Host 需注册路由并注入可信 `requireAdmin` 和 PG query adapter。
- **Admin 风险用户列表原型（未接 Host、SQL 未验收）**：新增 `gugu-webui/src/domains/admin/admin-user-risk.ts` 与 `gugu-webui/tests/admin-user-risk.test.ts`。Python `backend/tests/platform/admin/test_admin_risk_users.py` 在 devserver 串行 3/3 通过；Node26 定向测试 3/3、严格 scoped TSC 通过。覆盖管理员拒绝、1 分钟至 30 天展示窗口、5 分钟策略阈值、冻结账户保留、按 `updated_at DESC` 排序和错误脱敏；SQL adapter 使用 query fixture，真实 PG 聚合尚未验收。Host 需注入可信 `requireAdmin` 与 `createPostgresAdminUserRiskQuery(pool)`。
- **Admin 单用户安全事件读取原型（未接 Host、SQL 未验收）**：新增 `gugu-webui/src/domains/admin/admin-user-security-events.ts` 与测试，投影只包含安全指纹/动作/原因及时间，不回显 `user_id`、原始 IP、metadata 或 user-agent；覆盖 Admin guard、用户不存在、UUID/limit 边界、倒序和错误脱敏。未找到 `list_user_security_events` 直连 Python 测试；相邻 Python `test_admin_risk_users.py` 与 `test_ownership_security_events.py` 在 devserver 串行共 6/6。Node26 定向 4/4、strict scoped TSC 通过；查询替身未验收真实 PG 列/排序/limit。Host 需注入可信 `requireAdmin` 与 `createPostgresAdminUserSecurityEventQuery(pool)`。
- **Agent interaction deep-link 原型（未接 Host、PG SQL 未验收）**：新增 `gugu-webui/src/domains/agent-sessions/persistence/agent-interaction-session.ts` 与 `gugu-webui/tests/agent-interaction-session.test.ts`，按 owner 查找凭据交互 prompt 并仅返回 `session_id`；过期 prompt 仍可解析深链，实际提交消费阶段另行校验。Python 基线 `backend/tests/agent/test_agent_api_messages.py::test_web_secret_link_and_submit_are_owner_scoped_for_group_session` 在 devserver 串行 1/1 通过。Node26 devserver 定向测试 1 passed、1 个随机 schema PG 用例因未设置 `GUGU_WEBUI_TEST_DATABASE_URL` 跳过；严格定向 TSC 通过。Host 需由可信 `RequestContext` 注入 owner，注册 `GET /api/v1/agent/interactions/{prompt_id}/session`，并将 `InteractionNotFoundError.statusCode=404` 映射为现有 404；查询真实 PG 语义仍待验证。
- **Agent interaction history 子服务（未接 Messages Host、PG 未验收）**：新增 `gugu-webui/src/domains/agent-sessions/application/agent-pending-interactions.ts` 与测试，覆盖活动 action token 重签/哈希更新、已消费选择恢复、仅变更时 commit、历史窗口与 owner/session 边界、凭据 prompt 不发可操作选项；旧 schema 无对应 option 时 label 回退为 action id，已对齐 Python。Python `backend/app/services/interactions.py::list_history` 对应基线两项在 devserver 串行 2/2 通过。Node26 定向用例 1 passed，隔离 PG 1 项因未配置 `GUGU_WEBUI_TEST_DATABASE_URL` 跳过；严格 scoped TSC 通过。该模块保留 token 轮换的持久副作用，但不是独立 HTTP endpoint。Host 需在认证后将 `history.list(ownerId, sessionId, options)` 结果拼入 Messages 响应 `interactions` 字段，并实现 owner/session scoped 查询、action 持久更新及变更后的事务提交。
- **Agent consume_action 子服务（未接 Host、PG/Redis 适配未验收）**：新增 `gugu-webui/src/domains/agent-sessions/application/agent-interaction-consume.ts` 与专属测试，覆盖 token 哈希校验、owner隔离、单次消费、仅同 event_id 且显式允许的重放、过期状态先提交、取消/自定义回答、secret prompt 专用入口、workspace_delete / filesystem_authorization_grant 副作用端口和 confirm_code Redis 兑换失败。Python `test_interaction_protocol.py` 与 `test_commands.py` 的指定基线在 devserver 串行共 7/7 通过；Node26 定向测试 17/17、strict scoped TSC 通过。没有真实 PG/Redis adapter 或隔离库，SQL 行锁、事务和 Redis confirm redeem 尚未验收。Host 必须认证后注入 owner、带锁事务 store、owner-scoped workspace delete/FS grant adapter 与一次性 confirmation redeemer；缺任一命令处理能力时 service 会拒绝消费，不能以确认成功回退。该 service 不是 HTTP route，也未集成 resume/唤醒 Agent Run。
- **Admin Voice Preset 管理原型（未集成）**：新增 `gugu-webui/src/domains/admin/admin-voice-presets.ts` 和 `gugu-webui/tests/admin-voice-presets.test.ts`。Python 基线 `backend/tests/agent/providers/test_admin_voice_presets.py` 全文件 8 项、模型预览相关两项 `test_models_preview_reuses_saved_key_only_for_its_destination` 与 `test_models_preview_post_route_matches_and_rejects_missing_key_before_network` 均在 devserver 串行通过。Node26 新增测试由 5 项扩至 7 项并通过，含密钥遮蔽、CRUD/激活、目的地保护、模型列表预览和上游错误脱敏；独立严格 tsc 通过。覆盖范围不含真实网络/BYOK runtime。Host 未注册，仍需会话 A 提供可信管理员钩子、原子配置 adapter 和审计 adapter，故不算 Voice 子域完成。
- **Admin LLM Preset CRUD/读取/激活/模型列表预览及能力覆盖原型（未集成）**：新增 `gugu-webui/src/domains/admin/admin-llm-presets.ts` 和 `gugu-webui/tests/admin-llm-presets.test.ts`。Python CRUD 基线在 devserver 串行 8 项通过：`test_saved_preset_model_list_uses_provider_model_contract`、`test_preview_model_list_does_not_pass_local_runtime`、`test_admin_preset_response_masks_api_key`、`test_legacy_invalid_preset_does_not_discard_whole_override`、`test_legacy_invalid_preset_is_kept_with_original_values`、`test_invalid_preset_does_not_block_valid_presets`、`test_invalid_preset_warning_names_preset_without_leaking_key`、`test_save_path_validation_is_unchanged`；能力覆盖对应 Python 基线 `test_capability_override_persists_and_invalidates_active_runtime` 在 devserver 1/1 通过。Node26 测试在 devserver 通过：原 CRUD/模型行为 7 项，新增能力覆盖后重跑整文件 8/8；同次同步工作树全量 TypeScript 检查通过。能力覆盖验证布尔白名单、探测元数据失效、活动运行段同步、密钥保留和失效钩子调用。未决行为差异：Node 更新接口在 Provider/API 格式/地址变化但未提交新 key 时返回 422；当前 Python CRUD 不强制此规则，虽属密钥目的地安全加固，尚无已验收的契约变更，故不能判定等价或切片完成。Host 仍需注册路由并注入可信 Admin、配置读写、模型抓取、能力快照、活动运行时失效与审计 adapter；当前 audit 在 mutate 后执行，原子审计仍需集成设计。
- **Admin Prompt 文件管理原型（未集成）**：新增 `gugu-webui/src/domains/admin/admin-prompts.ts` 和 `gugu-webui/tests/admin-prompts.test.ts`。Python 基线 `backend/tests/platform/admin/test_admin_prompt_files.py` 5/5 在 devserver 通过，覆盖 compress 文件名映射、其他 profile 文件名、未知 profile、压缩提示词读取和列表状态；该 Python 文件没有 Prompt PUT/审计行为测试，Node 对更新/审计的覆盖目前只依据生产 handler读码，尚无对应 Python回归基准。Node26 新增测试3/3通过、独立严格 tsc通过；覆盖路径白名单、文件读取/原子替换、正文不入审计和管理员拒绝。Host 尚未注册，需会话 A 注入可信管理员钩子、可信 prompts 根目录与审计 adapter；审计在文件写入后调用，未形成文件变更与审计的单事务。
- **非 HTTP 写入方初步清单（仍待逐域穷尽）**：入站 IM 消费在 `backend/worker.py`，依赖 `app/core/redis.py` 的 Stream 消费、`agent/im/inbound_recovery.py` 的数据库 checkpoint/静默批次恢复，以及 `agent/im`/Gateway 处理；成功路径先写租约完成状态再 `XACK`，忙碌/异常留在 PEL 等待恢复，副作用涉及会话/消息、交互和 IM 出站。定时任务由 `backend/app/api/v1/scheduled_tasks.py` 与 `backend/agent/tools/scheduled_tasks.py` 写 `scheduled_tasks`，`app/core/scheduler.py` 管单实例生命周期，`app/scheduled_tasks.py` 每约 30 秒 reconcile/执行；一次性任务清理、崩溃失败态、Redis 执行锁及提交后 `scheduled_tasks` 通知均需保留。其他 Python 写入方还包括 `agent/tools/{projects,clients,note,canvas,trash,skill_management,shell,web}.py`、`agent/tools/files/*`、`app/services/{filesync,data_portability,storage,conversation_cleanup,undo}/*`、`agent/rag/index_jobs.py` 和 `agent/memory/reflection_jobs.py`。当前 Node 没有这些工具调用和后台写副作用的完整替代；这份路径清单是初步分组，待继续检查每个 producer/consumer、事务、重试及撤销边界。
- **Agent Host 契约交接**：共享 `RequestContext` 已由认证身份和 owner-bound `DataContext` 构造，项目/日历写入 adapter 也已接收它；但 Agent 尚无 owner-bound `AgentStoreTransaction` 与 `AgentRuntime` start/resume/cancel 生命周期。会话 A 仍需接入持久化后提交的运行时、稳定事件 ID/游标和 Host SSE framing；存储接口需涵盖 owner-scoped session/message page、interaction token/event 消费、pending queue CAS/claim、附件草稿/引用生命周期。Python 真实调用方和表依赖包括 `agent_routes/{chat,sessions,attachments,interactions,pending_queue}.py`、`agent.gateway.web`/`agent.llm.genstream`、`conversation_sessions/messages/batches`、`interaction_prompts/actions`、`conversation_pending_queues`、`chat_attachments`、workspace/filesystem grants、Redis cancellation、`chat_attach`/transcode。Node readiness 当前未含这些表/服务；Agent 切片保持未完成。
- **会话 A 挂载契约（独立模块可用，尚未注册）**：Agent 列表用 `createAgentSessionLister(pool, runtime)`，将其 `list(ownerId)` 传给 `registerAgentSessionRoute(app, { requireUser, userIdFromRequest, list })`；`requireUser` 必须先完成认证，`userIdFromRequest` 只从认证后的 `RequestContext.identity.userId` 读取。`runtime` 提供 Redis 状态快照批读、文件授权开关、workspace shell 能力。Admin 用量用 `registerAdminAgentUsageRoute(app, { requireAdmin, query, now? })`，`query` 绑定 Host 的 PG pool；Admin LLM/Voice/Perception/Prompt 模块还各需配置读写、provider fetch、Redis/DB/memory、prompt 根目录与 audit adapter，不能绕过 Admin guard。Worker 暂不应接入生产消费：Host 未来需提供真实 Redis `sendCommand`/`eval` adapter、stream/group/consumer 参数、`conversationKey`、业务 `handle` 与持久恢复 callback，负责轮询启动、停止取新消息和 shutdown drain；当前 started receipt、数据库 checkpoint、silent-batch 恢复和真实 IM dispatch 仍未实现。

- **新增切片 Host 集成契约（均未注册/未切换）**：消息页 `createAgentMessageHistory(pool).list(ownerId, sessionId, options)` 只返回分页后的安全正文/时间线投影；Host 注册 `/api/v1/agent/sessions/{session_id}/messages` 时必须先经 `requireUser`，owner 只从认证后的 `RequestContext.identity.userId` 读取，并继续补齐会话状态、interaction/pending queue、workspace 与 orphan recovery。交互深链使用 `createInteractionSessionLookup(pool).get(ownerId, promptId)`，owner 仅从已认证 RequestContext 读取；将 `GET /api/v1/agent/interactions/{prompt_id}/session` 的 `InteractionNotFoundError.statusCode=404` 映射到现有 404。安全事件路由为 `registerAdminSecurityEventRoutes(app, { requireAdmin, query: createPostgresAdminSecurityEventQuery(pool), fingerprintUserId })`；`fingerprintUserId` 必须使用与 Python `security_fingerprint` 相同密钥算法，不能临时用不匹配密钥挂载。Analytics summary 由 `registerAdminAnalyticsSummaryRoute(app, { requireAdmin, query })` 注入可信管理员 guard 和绑定当前 PG pool 的 query。定时任务 runner 需由 Host 提供真实 PG `OnceTaskRepository`（状态/删除事务提交后 resolve）、Redis owner lease、`notifyTasksChanged`、APScheduler 生命周期以及 Agent/渠道投递回调；当前 runner 仅覆盖一次性任务编排，不得接入生产消费。

上述 Python 基线通过仅证明参考实现回归可运行，不代表 Node 迁移完成。Node 原型结果只覆盖独立服务模块，Host/真实存储集成仍待完成。各切片必须继续在 devserver 先写/跑 Node 行为测试再实现；不得双写或加入 Python 隐式回退。

- **历史 devserver 检查快照（首次全量检查，已被下方最新验收取代）**：Node 26.13.1 执行 `node --import tsx --test-concurrency=1 --test tests/*.test.ts` 共 153 项，121 passed、31 skipped、1 failed；Worker Redis 集成另以临时 Redis 定向实跑 4/4。该快照发生在 Admin Auth、Event Update 与 Host 插件接线修复前，保留于此作为迁移过程记录。命令均在 devserver 只读同步工作树容器内运行。

### N2 后续写路径切片（2026-11-13，局部完成）

- **WebUI 模块目录（已按 backend 分层落位，域内细化仍在进行）**：参照 `backend/app/api/v1/`、`backend/app/services/`、`backend/app/db/` 和 `backend/app/core/` 的职责，47 个认证、Admin、Agent、项目、工作区、日历、联系人、通知、站点和路由模块已从 `gugu-webui/src/` 根目录迁到 `src/domains/<domain>/`；路由在 `routes/`，应用用例在 `application/`，Core/SQL 数据访问在 `persistence/`。共享 Redis 事件 Adapter 位于 `src/adapters/`；`app.ts` 继续作为唯一 Host 组合根，`main.ts` 装配运行依赖；`http/`、workers、migrations 保持独立。Admin 和 Agent 部分原型仍混合 route/service/persistence，后续按业务切片继续拆分，不把目录迁移误计为行为迁移。
- **Vue API 客户端组织（目录方案已定，尚未实施）**：`frontend/src/api/` 按认证、文件、项目、思维、日历、定时任务、Agent、集成、偏好和 Admin 域拆分；`client.ts` 收口传输、CSRF、错误和请求去重，跨域共享类型单独放 `types/`，领域类型跟随 API 模块。保留 `frontend/src/services/api.ts` 作为分批迁移期间的兼容入口，逐域迁移调用方，避免一次性重写前端请求层；`index.ts` 仅在需要时提供兼容导出。
- **请求身份与写入边界**：Node 鉴权结果构造不可变 `RequestContext`（identity + owner-bound `DataContext`），项目/日历创建只从已验证上下文取 owner；HTTP adapter 透传 Idempotency-Key、Undo context 和 client origin。新增的写路径通过路由级回归验证 401、状态码和 metadata 传递。
- **登出**：`POST /api/v1/auth/logout` 在 PostgreSQL 事务内递增 `security_version` 并提交，再 best-effort 发布 auth state 通知，最后清除两枚 Cookie。Redis 地址由可选 `GUGU_WEBUI_REDIS_URL` 提供；未配置时通知为空操作，登出撤销仍生效。
- **项目创建**：Node Host 已接入 `POST /api/v1/projects`。项目、owner-scoped 幂等收据和 Undo 操作在同一 PostgreSQL 事务；并发唯一键败者重读胜者；事件仅在提交后发布。响应沿用项目字段映射和 `fileCount: 0`。
- **日历创建**：Node Host 已接入 `POST /api/v1/events`。关联项目必须归属当前用户且未软删除；事件、幂等和 Undo 同事务；只将日历幂等唯一约束转换为重放/冲突；通知失败不影响已提交创建。
- **认证资料**：`PATCH /api/v1/auth/profile` 已接入。支持显示名、IANA 时区、邮件订阅和密码变更；密码与 security version 在同一事务提交，通知后续签本设备 Cookie，时区提交后增加用户 context revision。
- **工作区创建与会话绑定**：`POST /api/v1/workspaces/`、`POST /api/v1/workspaces/{workspace_id}/bind/{session_id}`、`DELETE /api/v1/workspaces/binding/{session_id}`、`GET /api/v1/workspaces/session/{session_id}` 已接入 Host。创建和绑定均按当前用户校验归属；绑定限本地存储并要求工作区启用，解绑不受 OSS gate，当前会话保留 Python 对 disabled workspace 的读取语义。Node 只创建已有声明，不创建物理目录；工作区列表聚合、workspace directories CRUD 与删除副作用仍待迁移。
- **Admin 认证原型**：`src/domains/admin/admin-auth.ts` 提供 login/me/logout、cookie/CSRF、role、host guard 与 Redis auth-version 撤销，专属行为测试在 devserver 通过；还未注册到生产 Host，也未完成 Admin 用户管理。
- **工作区更新原型**：`src/domains/workspaces/persistence/workspace-update.ts` 的隔离 PostgreSQL 测试在 devserver 通过，覆盖 owner 约束、directory 展示名扇出且保留物理路径、默认目录限制、enabled 和 session count；PATCH 路由尚未接入 Host。
- **日历更新**：`PATCH /api/v1/events/{event_id}` 已接入 Host；从已认证 `RequestContext` 取 owner，PostgreSQL 事务覆盖版本 CAS、提醒重排与 Undo，提交后 best-effort 发布日历更新。路由回归检查 401、404、409、422 和写请求 metadata 透传。
- **此前容器辅助回归记录（历史）**：2026-11-13 曾记录 WebUI 234 项（233 passed、1 skipped）及临时 PostgreSQL/Redis 实例；该记录用于保留历史证据，不作为本轮按 Vite/原生 Node 运行方式完成的验收，也不代表生产数据库验收。
- **devserver 原生 Node/Vite 回归（2026-11-13）**：Python 基线 `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=. .venv/bin/pytest -q -p no:cacheprovider tests/scheduling/events/test_event_atomic_update.py`（在 Python 基线仓库 `backend/` 下串行执行）20 passed。Node 新增 PG 测试 `node --import tsx --test tests/event-update-postgres.test.ts` 8 skipped（未配置隔离测试库）；关联路由 `node --import tsx --test tests/events-route.test.ts` 4 passed。随后原生 Node 26.13.1 串行全量命令 `node --import tsx --test-concurrency=1 --test tests/*.test.ts` 241 项：203 passed、0 failed、38 skipped；跳过项由 PostgreSQL、Redis 及迁移专用数据库环境变量门控。`corepack pnpm --filter @gugu/webui typecheck` 通过，但真实 PostgreSQL 行为尚未由本轮验收。Vite 前端首页返回 200，Vite 代理的公开站点配置返回 200；Node Host `/health` 返回 200，使用不可达合成数据库启动时 `/health/ready` 返回预期 503。该 smoke 不证明登录、读写 API 或数据库行为已验收。
- **日历删除**：`DELETE /api/v1/events/{id}` 已接入，要求版本号，事务内软删除事件、关闭关联提醒并写入 Python Undo 兼容记录，提交后通知。Node `/api/v1/undo` 仍未迁移，Undo/Redo 的实际执行继续由 Python 提供。
- **devserver 容器辅助验收（历史记录）**：目录迁移时曾运行 `node --import tsx --test-concurrency=1 --test tests/*.test.ts`，记录为 **234 项：233 通过、0 失败、1 跳过**，临时 PostgreSQL/Redis 实例由容器提供；这不是当前用户要求的 Vite/原生 Node 验收方式。严格 TypeScript 检查使用临时 tsconfig 排除一个已有类型签名不一致的测试；当前原生 Node/Vite 验收和 PostgreSQL 缺口见上条。
- **Python 对照**：登出/认证、项目及日历先行基线 68 项通过，事件创建专项另 3 项通过；profile password/email change 对照 2 passed（4 项同文件其他用例 deselected）；工作区 service 用例 25 passed；日历更新/删除/提醒/Undo 相关用例 26 passed。所有 pytest 均在 devserver 串行运行。
- **一次性定时任务执行原型（未接 DB/Redis/APS/Host）**：新增 `gugu-webui/src/scheduled-task-runner.ts` 与 `gugu-webui/tests/scheduled-task-runner.test.ts`，以 Repository/Lease/execute 端口描述到期检查、先持久化 started、一次性任务失败重试、成功后删除及超时锁恢复。Python `test_scheduled_task_execution.py` 的执行状态/续租基线 5/5、锁持有与宽限期基线 3/3 在 devserver 串行通过。Node26 行为测试 5/5、worker admission/message-lease/Redis lease 合跑 9/9，相关文件 strict scoped TSC 通过；测试使用 devserver Node 26.13.1 断网、只读挂载、8 MB tmpfs 临时容器，没有启动 PG/Redis。该原型没有真实 PG/Redis adapter、通知 outbox/提交后事件、APScheduler 生命周期或 Agent/渠道执行，不能算定时任务迁移。
- **Agent create_project 工具原型（未接 Host、PG 未验收）**：新增 `gugu-webui/src/domains/agent-sessions/tools/agent-project-tool.ts` 与 `gugu-webui/tests/agent-project-tool.test.ts`，扩展共享 `project-create.ts`/PG adapter 支持 Agent `summary`、`priority` 和原始参数 fingerprint。Python 基线在 devserver 串行运行 `tests/projects/test_project_tools.py` 与 `tests/api/test_create_idempotency.py::test_agent_project_create_replay_uses_stable_tool_call_key`，22 passed。Node26 行为覆盖 dispatch 幂等重放、参数冲突、跨会话与 owner 隔离共 4/4；共享 Web create 回归 7/7，PG adapter 随机 schema 1 项因无 `GUGU_WEBUI_TEST_DATABASE_URL` 跳过；合计 11 passed、1 skipped，scoped strict TSC 通过。Agent 路径不写 Web Undo 且不发 Web 项目事件，Web 路径原有副作用保留。当前仍只是独立工具 wrapper，真实 PG/并发唯一键行为未验收，Host 需接入 Python tool dispatch 上下文并可信注入 owner、session/tool-call id 与 PG runtime。
- **Agent create_client 工具原型（未接 Host、无直接 Python 回归、PG 未验收）**：新增 `gugu-webui/src/domains/agent-sessions/tools/agent-client-tool.ts` 与测试，复用 Core-backed `createClientOperations`，映射创建参数和 Python 工具回执；不添加 Python 不具备的幂等、Undo、确认门或项目事件。相关 Python Core bridge、事务提交/回滚和 owner 查询基线在 devserver 串行 6/6 通过，但未找到直接覆盖 `_create_client` 的测试。Node26 Agent wrapper 5 项与联系人 route 3 项共 8/8，scoped strict TSC 通过；真实 PG 未配置隔离 URL。Host 需创建 `createAgentClientTool(core)` 并将 handler 接入 Agent dispatcher。
- **Agent update_client 工具原型（未接 Host、无直接 Python 回归、匹配语义待 PG 对照）**：在 `gugu-webui/src/domains/agent-sessions/tools/agent-client-tool.ts` 新增 `createAgentClientUpdateTool`，owner-scoped 按 ID/姓名解析、精确名优先、零/多匹配错误、拒绝空 patch，并只更新显式字段。Python 没有直接 `_update_client` 回归；相邻 Core bridge、owner 解析及事务基线在 devserver 串行 4/4 通过。Node26 Agent create/update 与联系人 route 定向测试共 13/13，strict scoped TSC 通过。Node 使用 Core owner-scoped 列表配 `toLocaleLowerCase().includes()` 做模糊匹配，Python 使用数据库 `ILIKE`，Unicode/排序边缘尚未证明等价；真实 PG 未配置隔离 URL。Host 需把 `createAgentClientUpdateTool(core)` 接入 Agent dispatcher。
- **Agent update_project 工具原型（未接 Host、PG 未验收）**：新增 `gugu-webui/src/domains/agent-sessions/tools/agent-project-update-tool.ts` 与测试，复用 Core owner-scoped version CAS；覆盖精确/模糊名称解析、owner 隔离、显式字段、拒绝空 patch、优先级归一化、`done` 自动勾选待办并持久化恢复标记，以及状态回退时仅清 `done_at`。Python 对照覆盖项目更新/完成语义、缺失/越权、CAS/版本和日期/字段校验共 8 项，在 devserver 串行通过。Node26 Agent create/update 定向共 11/11、含真实 SQLite Core 事务用例；Core 既有 owner/CAS/完成时间回归 1/1，strict scoped TSC 通过。无 PG 实测；姓名模糊匹配使用 Core 列表 + locale lower/includes，与 Python SQL `ILIKE` 的 Unicode/通配符行为仍有边缘差异。Python 更新没有 Undo、confirm 或 event，Node 保持同一边界。Host 需注入可信 owner 并接入 Agent dispatch；这不是 HTTP route。
- **Agent create_note 暂不实现（依赖 Mind 数据域迁移）**：Python 调用链 `backend/agent/tools/note.py::_create_note` → `serialize_mind_blocks`/`validate_mind_references` → `create_mind_note`，写 `mind_nodes`、派生纯文本/索引字段并校验颜色/标题/捕获时间及 owner-scoped project/file/event 引用；失败 rollback，成功显式 commit，不写幂等/事件/Undo receipt，但 `origin='gugu'` 供独立 note_undo 查询。Node Core 的 Database/schema/services 尚无 MindNode 域，缺内容块序列化与引用校验。Node 红灯/TSC 未运行，因为没有可合理实现并验收的持久化目标；不添加 fake wrapper。Python 基线在 devserver 4/4：`test_create_note_serializes_supported_blocks_and_references`、`test_create_note_rejects_invalid_color_and_other_users_reference`、`test_create_note_derives_plain_text_and_marks_pending_index`、`test_create_note_accepts_backfilled_captured_at`。待完整 Mind/Core schema/domain/repository 迁移后再接 Agent tool。
- **边界**：已迁移的认证/用户、项目/工作区、基础 API 仅覆盖上述细分 endpoint；N2 仍未完成。注册/找回/邮件变更、Admin 认证 Host 接入与用户管理、工作区管理视图和 directories CRUD、日历 SSE、Worker lifecycle、Agent、文件联动及其他 Python 调用方尚未切换。Node 默认承载 Web 流量的总门槛保持未完成。

### N3——扩展数据域与 Agent 迁移

**RAG 目标**：复用 Gugu 1.7.8 TypeScript RAG 作为 Node/Core 唯一生产检索路径，不迁移 Cython 算法到 TS，也不保留双引擎线上选择。迁移时以当前 Python/Cython 行为回归和固定质量语料为基准，接入 Node/Core 授权来源读取、派生索引存储/重建及 ACL 过滤；具体验收见依赖迁移矩阵。RAG 来源文件正文按架构说明从授权 FS 直读，DB 不保存文件正文副本。

- [ ] 会话/消息/附件引用、Canonical 历史与顺序规则。
- [ ] Run/Job、确认授权、租约、持久调度、outbox 和重启恢复。
- [ ] 按 `agent/harness/`、`providers/`、`tools/` 拆分 Agent 实现，调用共用 Executor；保证测试和可移植入口不隐式装载平台后端。
- [ ] Provider/流式事件、工具、取消与背压；代码权限、confirm、URL 安全和脱敏边界。
- [ ] 原生 wire/thinking/signature、上下文压缩、反思及缓存/用量契约。
- [ ] 便签/画布/日历、长期记忆/RAG、媒体/Office 按依赖矩阵逐域迁移和验收。
- [ ] SaaS 数据同步、设备绑定/路由及受限任务转交。
- [ ] SaaS 旧 FS 的内容迁移、完整性与恢复验收，通过后退出兼容 FS。
- [ ] Mobile 可移植 Core 与独立 Host 的平台可行性验证。

### N4——桌面产品化与发行准备

**旧 Rust Host 的历史验证基础（不能视为 Electron 验收）：**

- [x] Rust Host 启动随包 Node，使用私有 NDJSON v2；SQLite 在 Worker 执行用例。
- [x] 单实例、能力白名单、帧/队列/超时限制、制品版本/架构/摘要校验。
- [x] Windows x64、macOS arm64/x64 的独立制品冒烟、Rust IPC/故障回归、平台构建；macOS app 内资源再次校验。
- [x] 制品装配包含 Node、生产依赖和许可证，不要求终端用户现场安装 Python。
- [x] Windows MXC 固定任务及有限隔离验证，失败不回退宿主执行。

**Electron 验证切片（实现与最终 CI/发行分别验收）：**

- [x] 固定 Electron 45.3.1、electron-builder 26.18.0、electron-updater 6.8.11；区分内嵌 Node 与独立 Core Node 26 的 ABI。
- [x] 实现拆分的 TS Main/Preload、可信来源/能力白名单、受限 UI 协议，并替换 Vue 桌面 bridge。
- [x] stdio 移入 `runtime/transport/`；通用 IPC 与命令/收据契约共用，不依赖 Electron、不自动切换。
- [x] 迁入有界 Core Host、完整性/版本/ABI 校验、参数快照、未知结果与操作 ID 恢复、单实例及退出/暂停回收。
- [x] 保留数据位置/稳定 owner，以 SQLite 独占连接阻止其他连接并行使用；不自动升级或创建空库掩盖兼容错误。
- [x] 实现 Executor 契约/策略/平台适配和 Host 注入边界，Windows 合成资料完成六项原生验证；诊断不修改 ACL。
- [x] 实现更新状态机及确认、停写、取消和失败路径回归；生产签名/更新通道另行验收。
- [x] 实现 package/smoke，Windows 独立目录包已验证创建/重启/收据/Renderer 隔离；三平台检查已接入 Runtime integration。
- [x] 活动依赖、桌面壳层和桥接已切换到 Electron；旧 Rust Host 不作为源码或依赖保留。

**共同产品与发行门槛：**

- [ ] 正式签名/公证、最低 OS 实机、干净离线安装、升级回滚、休眠/退出/多窗口验收。
- [ ] macOS 原生执行 Adapter 与 Windows 完整不可信负载矩阵。
- [ ] 端侧 FS、watcher、Secrets、PTY 和完整 Agent 的产品接入。

### N5——收敛与发行

- [ ] `backend/` 的现有业务与 Host 按稳定边界交接到目标布局，前端搬迁另行决策。
- [ ] 无生产调用方后移除对应 `compat/` 包、安装路径和重复依赖；保留仍需独立运行的计算服务。
- [ ] `gugu-saas` 独立构建、协议稳定，再评估闭源拆仓；Core 构建不依赖私有源码。
- [ ] 平台安全、可恢复升级和完整产品验收通过后发布 2.0。

<a id="core-test-parity"></a>

## 6. T1：Node Core 回归等价与测试分层

### 6.1 任务边界与交付

**目标**：为已经存在的 Node Core 行为补齐与当前 Python 后端同逻辑的回归，建立可独立运行的快速、集成和跨语言对照测试。先让这批 Core 的语义可验证，再覆盖 N2/N3 的 Web 与业务迁移。

**已落地**：显式分类清单、快速/集成/IPC/PG/parity/all 命令、共用 SQLite/PG 数据契约、42 组语料与 16 步维护序列、测试源码类型检查、根 fast/affected/分层和 CI 接入。覆盖仅针对已有 Node 切片，不代表全部 Python 领域已迁移。

- [x] T1.1 生成行为对照清单，记录 Python 用例/生产入口、Node 对应入口、契约断言、差异、标记、CI 及验收状态。
- [x] T1.2 补齐当前 Domain/Application 的合法、非法和组合状态分支。
- [x] T1.3 在临时文件 SQLite 和隔离 PG 上运行相同数据契约；补联系人更新/删除、所有者隔离及错误终态等缺口。
- [x] T1.4 扩充同输入对照、旧库互读、升级备份与恢复；保留独立期望结果，不仅把 Python 输出当真源。
- [x] T1.5 按下表标注测试类型，整理发现范围，落地分层及定向运行命令。
- [x] T1.6 接入根调度、affected/fast 选择、元数据/清单和现有 CI；证明每层实际收集了预期测试。
- [x] T1.7 接入差异/故障回归及完整 CI 矩阵；精确提交、两项必需 CI 和合并门禁结果统一记录在 PR。

本任务不以复制整个 pytest 数量或重写所有后端领域为目标。Python 独有的 Web 事务、文件联动和 Agent 工具能力若尚未迁到 Node，必须标为“待功能迁移”，不得写成已有 Node 等价覆盖，也不为凑测试偷偷增加一套不完整实现。

### 6.2 Python 与 Node 对照来源

详细对应关系、入口、运行类型及有意差异集中维护在 [Node Core 回归对照清单](../testing/node-core-parity.md)，不再在主文档重复维护测试文件表。

差异分为“已等价”“待补覆盖”“待功能迁移”“有记录的有意差异”。名称长度、数字归档等既有差异分别断言两端结果；不通过抹去 owner、排序、微秒、版本或副作用来制造等价。

### 6.3 与 pytest 相同的类型和分层选择

当前事实源为 [pytest.ini](../../backend/pytest.ini)、[pytest 收集规则](../../backend/tests/conftest.py) 和 [根分层调度](../../scripts/tests/run-test-tier.mjs)。pytest 目前通过下列标记组合分层，并没有一个必须叫 `unit` 的 marker；Node 应对齐其含义。

| 标记/维度 | 现有 pytest 语义 | Node Core 对应规则（已接入显式清单） |
| --- | --- | --- |
| 无慢速/边界标记 | 默认快速、隔离测试 | 纯领域、应用用例、隔离临时 SQLite/编码/迁移测试；不因文件名含 DB 就自动归外部服务 |
| `slow` | 执行较慢 | 显式成本标记；不是业务正确性等级 |
| `external_service` | 真实外部服务或真实系统 I/O 边界 | 真实 PG/后续 Redis 等，必须提供显式隔离连接 |
| `process` | 子进程、PTY/终端等运行边界 | Node Worker 生命周期、子进程、stdio、CLI；Python Golden 因实际启动参考进程也带此标记 |
| `e2e_support` | 为浏览器 E2E 提供环境/支撑 | 只有确实支撑 E2E 的 fixture/桥接测试才标注；普通 IPC 测试不冒充浏览器 E2E |
| `layer` | 元数据中的 L0/L1/L2 等层级 | 沿用现有 `test-metadata.json`；与运行依赖标记分开，不用 L1/L2 代替 marker 选择 |
| 对照/契约用途 | 可另记录行为来源 | Golden/parity、双库 contract 属于用途，可与 `process`/`external_service` 同时存在 |

与 pytest 一致：`process` 或 `external_service` 自动归入 `slow`。默认快速层选取 `not slow and not external_service and not process and not e2e_support`；集成层选取四项的并集。分类以依赖与隔离方式为准，清单/显式标记驱动执行，不依靠测试标题或模糊文件名猜测。

**当前测试目录：**

```text
gugu-core/tests/
  unit/domain/                     # 规则、字段与阶段/待办
  fixtures/                        # 共享双库数据契约与独立合成维护序列
  unit/data/                       # 隔离 SQLite、编码、事务与显式迁移
  integration/postgres/            # external_service + slow
  integration/runtime/             # Worker/Node 进程/stdio，process + slow
  golden/                          # 现有 Python/TS 对照保留此目录，process + slow
```

原有断言随文件迁移保留；`tests/suites.json` 驱动发现和分类，元数据/清单与 CI 已更新。新增混合边界用例仍须拆分或显式分类，不能因标题或文件名误入快速层。

### 6.4 可执行命令

`test` 默认执行 unit 与 Node IPC；以下专用入口均已实现。`test:list` 输出去重后的文件/marker/layer 清单；`typecheck:tests` 检查测试源码。PG/Python 必须显式配置隔离连接/参考解释器，缺失即失败。

| 入口（`pnpm --filter @gugu/core`） | 选择集合 |
| --- | --- |
| `test:unit` | 与 pytest 快速表达式相同，不启动服务、Worker 或子进程 |
| `test:integration` | 四个边界 marker 并集，包含真实进程、PG 与 Python 对照 |
| `test:ipc` | Node Worker/进程/传输，不包含 Python/PG |
| `test:postgres` | 真实隔离 PG，共用数据契约；不以 skip 代替通过 |
| `test:parity` / `test:golden` | Python 对照、旧库互读与恢复 |
| `test:all` | 全部分类的去重并集，缺服务/空选择/未登记文件明确失败 |

根分层调度、`test:fast`、affected 和 CI 已同步接入。Linux 专用 Core job 承担完整双库/对照；桌面矩阵选择快速层及 Node IPC，并验证实际使用的 Host/制品。Electron Host/Preload/窗口/更新/故障回归和真实应用冒烟承担新壳验收；旧 Rust 源码保留归档。各 shard 的并集覆盖完整门禁，分类不替代权限、持久化和故障回归。

CI 若按 `unit`、`ipc`、`postgres`、`parity` 分片，不能再额外执行包含相同用例的 `integration`/`all` 后重复累加数量；按显式收集清单验证并集和交集。

### 6.5 T1 完成条件

- [x] 每个现有 Node Core 业务入口都有 Python 参考或独立契约；差异与未迁移项明确登记。
- [x] 同逻辑用例保护输入、结果及持久化副作用；正常、非法、权限、并发和恢复分支均有对应断言。
- [x] 类型分类、发现清单与元数据一致；每个分层命令报告收集结果并证明没有漏测/重复计数，空选择不能假绿。
- [x] 快速层不启动外部服务或子进程；显式 PG/对照命令不能因缺依赖而全部跳过后显示成功。
- [x] 同一契约已配置到临时 SQLite/真实隔离 PG 与必要 Python 对照；旧回归和安全断言保留，最终执行结果在 PR 按精确提交核验。
- [x] 根调度、CI、包 README、测试规范与实现状态同步；最终两 workflow 全绿是独立的 PR 合并门禁，不能用本清单代替。

## 7. 完成证据与维护规则

已完成项依据 [实现/复查 PR #118](https://github.com/Coffeiz/Gugu-web/pull/118) 及 `ca943c88` 的 [Runtime integration](https://github.com/Coffeiz/Gugu-web/actions/runs/42954592909)、[Docker release](https://github.com/Coffeiz/Gugu-web/actions/runs/42954595536)。该基线已通过 Core 22 条、对照 2 条、前端 982 条、后端 5526 条，以及旧 Rust Host + Node 的三平台数据制品验证；这是首批实现的证据，不是 Electron 已实现、全量迁移等价或正式发行的证明。

每次迁移只更新本文对应条目、测试映射与证据；新的详细排查过程写入 `docs/devlog/`。依赖矩阵只维护候选/采用与兼容门槛，历史归档不再维护实时状态。分支/PR 继续按 `v2.0` 路线推进；提交、推送、CI 触发和合并分别遵守仓库授权与发布规范。
