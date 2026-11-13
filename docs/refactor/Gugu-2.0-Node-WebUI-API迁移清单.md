# Gugu 2.0 Node WebUI API 迁移清单

> 更新：2026-11-13。以 `backend/app/api/v1/` 的 FastAPI 路由声明为来源，按运行时 `/api/v1` 挂载和 Agent 子路由前缀展开。`Node 已接入`只表示对应 HTTP method/path 已注册；显式不可用响应不代表业务行为已迁移，标注 devserver 行为与 PostgreSQL 验收的接口另有对应回归证据。

## 当前覆盖

- 源码静态盘点：**390** 个字面路由操作，分布在 **57** 个模块。
- Node 当前路由匹配：**45** 个 method/path（其中项目列表包含活动/归档/回收站查询变体）；其余 **345** 个待迁移。注册与注册码路径虽已注册，但当前返回明确的 503，按未迁移处理。
- `health` 与 `health/ready` 是 Node Host 自身端点，不属于 Python `/api/v1` 路由计数。
- Node Host 配置了 Fastify `routerOptions.ignoreTrailingSlash`，用于兼容 Python 路由常见的带/不带尾斜杠调用形式。
- **2026-11-13 devserver Node26 复核**：Admin auth 与 storage snapshots Host wiring 完成后，全量 `node --import tsx --test-concurrency=1 --test tests/*.test.ts` 304 项（256 通过、0 失败、48 跳过；跳过项因未配置隔离 PostgreSQL/Redis/迁移数据库环境），Core 与 WebUI strict TSC 通过。该历史套件仍只是较早工作树快照。Admin Redis version store 使用 fake RESP 行为测试，真实 Redis 多进程行为未验收。storage snapshots 的历史 Vite 代理烟测为首页 200、未认证 API 401；隔离 PG 查询曾执行但对应测试索引断言修正后未重跑，真实 PG API 行为仍未验收。更早 readiness smoke 对不可达合成数据库返回 503。
- **测试快照边界**：304 项全量结果是较早工作树快照，不覆盖之后新增/调整的 auth registration-code、workspace delete、clients signed ID 等行为测试与 Host 改动；不得用它代替当前切片的验收。用户当前允许在 devserver 原生运行串行 pytest 与 Node 测试，禁止 Docker；按切片运行对应基线/回归，并用 Vite→Node HTTP smoke 验证运行态。Vite smoke 不代替 PG/Redis 行为回归。
- **2026-11-13 Node Host 路由清点（Vite 代理）**：该次抽查中 `/api/v1/admin/analytics/summary`、`/api/v1/admin/debug/logs/tail`、LLM/Voice presets、Agent usage、security events、user risk、perception、prompts 和 Agent commands/ui-labels 均返回 404；site-config 返回 200，未认证 Admin auth/storage snapshots 返回 401。这些具体路径当时尚未注册；404 仅用于路由存在性清点，不是业务行为验收。
- **2026-11-13 当前 Vite 路由复核**：未认证 `/api/v1/admin/users/risk` 返回 401，确认该 Host 路由已挂载；未认证 `/api/v1/agent/interactions/1/session`、`/api/v1/admin/ops/summary`、`/api/v1/agent/pending-queues/session-3` 均返回 404。后面三者只有独立模块原型，须由会话 A 注册并注入依赖后才可进入行为验收，不计入当前45个匹配路由。
- **2026-11-13 本轮 Vite smoke**：`POST /api/v1/auth/register` `{}` 经 Vite 与直连 Node Host 均返回 503；Python Host 对同一请求返回 422 字段校验错误，证明 Vite 此时代理到 Node。`POST /api/v1/auth/registration-code` `{}` 返回 422 字段校验错误；未认证 `DELETE /api/v1/workspaces/41` 返回 401；Node `/health` 为 200、`/health/ready` 为 503。只读 PG 探针定位到运行进程使用不可达的合成测试数据库目标并得到 `ECONNREFUSED`；只确认路由、守卫和进程状态，不证明注册、验证码、邮件或 workspace 数据库行为。
- **Admin 用户列表接入**：`GET /api/v1/admin/users` 已接 Host Admin guard 与 PostgreSQL query adapter；devserver 定向 Node 测试 4/4 通过，Vite 未认证请求返回 401。Python 最近邻 9/9 通过但没有直接覆盖 list_users 的 endpoint 回归；真实 PG 结果和认证后的列表请求未验收。
- **Admin 冻结/解封接入**：`POST /api/v1/admin/users/{user_id}/suspend` 与 `/unsuspend` 已接 Host Admin guard、PG 状态事务、security_version 递增、提交后 auth-state 发布和审计写入。Python 最近邻 `tests/platform/admin/test_admin_risk_users.py` 3/3（service级，不直测 Admin HTTP）；Node module/Host 定向回归通过，Vite 未认证两路由均 401。PG 状态存储用 fake PoolClient 验证事务顺序，真实 PG 未验收。`ban`、`developer`、`quota`、删除用户仍待迁移。
- **Admin Debug Logs Host 接入**：`GET /api/v1/admin/debug/logs/tail` 与 `/stream` 已挂载；路径只由 `GUGU_LOG_FILE` 所在目录或仓库 `backend/logs` 固定推导，调用方不能提交文件路径。SSE 每轮复验 Admin JWT/role/auth-version。Python debug 最近邻与风险状态基线合计 8/8（debug 最近邻不覆盖 HTTP handler）；Node 定向集合 47/47、strict TSC 通过；Vite 未认证 tail 返回 401。Node WebUI 当前日志走 console，尚无写入 `gugu.log` 的 file sink，因此该接口的 Web 源仍依赖兼容日志文件；真实日志目录、长连接部署代理和跨进程日志轮转尚未验收。
- **Admin Perception 模块原型（未接 Host）**：`src/domains/admin/admin-perception.ts` 的 Node 专测 8/8、strict scoped TSC 通过；Python `tests/agent/test_perception_stats_api.py` 6/6。`int/float/bool` query 按 FastAPI 标量注解校验，但 422 detail 文案和多错误排序未逐项对齐。Host 需从可信配置注入 events、misreadCases、developerPrefixes、readMisread 等数据源，并使用 Admin guard；真实 Redis/DB/记忆数据与 Host/Vite 均未验收，不计入当前 45 个路由。
- **项目 PATCH/删除恢复数据库复核**：本地存储模式由 Local 目录适配器处理重命名与回收站路径；devserver 真实 PostgreSQL 随机 schema 回归 `project-update-postgres.test.ts`、`project-delete-restore-postgres.test.ts`、`project-trash-path-metadata-postgres.test.ts` 均通过。Node 项目 create/update/delete/restore 已接入 context revision、持久 RAG job 与 live event 提交后处理，项目/日历/定时任务来源及 best-effort 失败隔离由定向测试覆盖。Python 最近邻基线分别为 PATCH 3/3、删除恢复 17/5.09s；Vite 未认证请求 401。OSS 项目改名的对象物理搬移仍未接入，认证后 Vite 项目写入及 OSS 行为未验收。
- **Workspace signed path 整数兼容**：Python 最近邻 `tests/terminal/test_shell_workspaces.py::test_workspace_binding_is_owned_and_can_be_cleared` 1 passed；FastAPI 合成 `int` 路由探针确认 `%2B17`、`-17`、`0` 正常解析，非法字符串 422。Node TDD 修复前 `%2B17` 返回 422，修复后 devserver `workspace-bindings.test.ts` 2 passed；PG 集成项因隔离数据库未配置跳过。
- **2026-11-13 Vite→Node Host 烟测**：使用进程级临时数据库 URL（读取现有测试环境变量但未同步/写回配置）和一次性签名密钥启动 Node Host 9595，Vite 5174 显式代理到 Node。首页与 `/api/v1/site-config` 返回 200；未认证 `/api/v1/projects` 返回 401；经 Vite 的合成不存在用户登录返回 401「用户名或密码错误」，无连接错误，确认请求到达 Node 登录数据路径并数据库连接可用。此 smoke 不覆盖认证后的项目读写、真实项目事务或 PostgreSQL 隔离集成测试。
- **Vite 默认 API 代理切到 Node**：本地 `/api` 默认目标现为 Node WebUI `9595`，`VITE_API_PROXY_TARGET` 仍可覆盖；尚未迁移的终端 WebSocket 继续使用 Python `8000`。devserver 临时默认配置检查确认两个目标，Vite `/api/v1/projects` 返回 401，Node 26 runtime smoke 通过。
- **Track POST 行为对照**：仓库没有 Python `/track` 直接回归；devserver FastAPI 合成探针确认 200、认证 owner 绑定、Unicode codepoint 64 字符截断、properties 可省略并存 null，缺 event/非法 properties 为 422且不 commit。Node `track-route.test.ts` 4/4 通过并覆盖存储失败脱敏 500。已知差异：FastAPI 422 body 是结构化 `detail` 并含原始 `input`，Node 返回通用脱敏 detail；因此尚未判定完整等价。真实 PG 本轮未运行。
- **Admin 安全事件路由 Host 接入**：全局 `/api/v1/admin/audit-log/security-events` 与单用户 `/api/v1/admin/users/{user_id}/security-events` 已挂载同一可信 Admin guard，并由 main 注入 pool query。User ID HMAC 使用 Python 同一 `secret_key`/UTF-8/HMAC-SHA256；devserver Python 最近邻安全事件基线 3/3，Node 路由/Host 专测 20/20，Vite 未认证两路由均 401。Python 基线未直测 GET handler；真实 PG 查询/列/排序未验收。
- **日历整数解析对照**：Python `int` 路径/查询接受 `%2B`、负数和 0；Node calendar route/application 已按相同顺序解析并 owner 查询，缺失/越权负数与 0 为 404，已存在事件的负/0 version 为 409。Python最近邻 1 passed、只读 FastAPI 类型探针通过；devserver Node route+application专测 8/8。真实 PG 未验收；超出 JS safe integer 的极大 Python int 仍有边界差异。
- 本表仅盘点 HTTP/WebSocket 路由；Agent 工具、Worker/调度、撤销副作用和数据迁移写入口需要另建清单，不能由 HTTP 路由数推断覆盖。
- 路径从源码 `APIRouter(prefix=...)` 与 decorator literal 展开；若新增动态 `add_api_route`、运行时挂载或非字面路径，需同步本清单。

## 源路由

| Python 模块 | 方法 | 运行时路径 | Handler | Node 状态 |
| --- | --- | --- | --- | --- |
| `backend/app/api/v1/admin_analytics.py` | `GET` | `/api/v1/admin/analytics/active-dimensions` | `get_active_dimensions` | 待迁移 |
| `backend/app/api/v1/admin_analytics.py` | `GET` | `/api/v1/admin/analytics/chat-funnel` | `get_chat_funnel` | 待迁移 |
| `backend/app/api/v1/admin_analytics.py` | `GET` | `/api/v1/admin/analytics/session-depth` | `get_session_depth` | 待迁移 |
| `backend/app/api/v1/admin_analytics.py` | `GET` | `/api/v1/admin/analytics/summary` | `get_summary` | 待迁移 |
| `backend/app/api/v1/admin_analytics.py` | `GET` | `/api/v1/admin/analytics/tool-distribution` | `get_tool_distribution` | 待迁移 |
| `backend/app/api/v1/admin_analytics.py` | `GET` | `/api/v1/admin/analytics/trends` | `get_trends` | 待迁移 |
| `backend/app/api/v1/admin_auth.py` | `GET` | `/api/v1/admin/auth/me` | `me` | Node Admin Host 已接入；Redis 版本存储与 Host allowlist 已适配，真实 Redis 尚未验收 |
| `backend/app/api/v1/admin_auth.py` | `POST` | `/api/v1/admin/auth/login` | `login` | Node Admin Host 已接入；配置 Admin 凭据时可用，Redis 版本/限流真实服务尚未验收 |
| `backend/app/api/v1/admin_auth.py` | `POST` | `/api/v1/admin/auth/logout` | `logout` | Node Admin Host 已接入；Redis 版本撤销真实服务尚未验收 |
| `backend/app/api/v1/admin_debug.py` | `GET` | `/api/v1/admin/debug/logs/stream` | `stream_logs` | Node Host 已挂载，Admin guard 与每轮 token/auth-version 复验；Python最近邻不覆盖HTTP handler，devserver Node/Vite路由验收通过 |
| `backend/app/api/v1/admin_debug.py` | `GET` | `/api/v1/admin/debug/logs/tail` | `tail_logs` | Node Host 已挂载固定可信日志路径及Admin guard；devserver Node行为测试通过，Vite未认证401 |
| `backend/app/api/v1/admin_update.py` | `GET` | `/api/v1/admin/update/status` | `update_status` | 待迁移 |
| `backend/app/api/v1/admin_update.py` | `POST` | `/api/v1/admin/update/check` | `check_update` | 待迁移 |
| `backend/app/api/v1/admin_update.py` | `POST` | `/api/v1/admin/update/preflight` | `update_preflight` | 待迁移 |
| `backend/app/api/v1/admin_update.py` | `POST` | `/api/v1/admin/update/rollback` | `rollback` | 待迁移 |
| `backend/app/api/v1/admin_update.py` | `POST` | `/api/v1/admin/update/rollback/preflight` | `rollback_preflight` | 待迁移 |
| `backend/app/api/v1/admin_update.py` | `POST` | `/api/v1/admin/update/start` | `start_update` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `DELETE` | `/api/v1/admin/agent/llm-presets/{preset_id}` | `delete_llm_preset` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `DELETE` | `/api/v1/admin/agent/voice-presets/{preset_id}` | `delete_voice_preset` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `GET` | `/api/v1/admin/agent/capabilities` | `list_capabilities` | 待迁移；Python 基线 `test_admin_capability_catalog_exposes_metadata_without_schema_or_body` 1/1；Node 缺少共享能力注册表，Host 需注入可信快照，不能用假数据替代 |
| `backend/app/api/v1/agent_admin.py` | `GET` | `/api/v1/admin/agent/llm-presets` | `list_llm_presets` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `GET` | `/api/v1/admin/agent/llm-presets/{preset_id}/models` | `list_llm_preset_models` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `GET` | `/api/v1/admin/agent/memory/im-scopes` | `list_im_memory_scopes` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `GET` | `/api/v1/admin/agent/memory/im-scopes/maintenance/model-preview/status` | `im_memory_model_preview_status` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `GET` | `/api/v1/admin/agent/prompts` | `list_prompts` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `GET` | `/api/v1/admin/agent/prompts/{profile}` | `get_prompt` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `GET` | `/api/v1/admin/agent/state-labels` | `get_state_labels` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `GET` | `/api/v1/admin/agent/usage` | `get_usage` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `GET` | `/api/v1/admin/agent/voice-presets` | `list_voice_presets` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `POST` | `/api/v1/admin/agent/llm-presets` | `create_llm_preset` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `POST` | `/api/v1/admin/agent/llm-presets/capabilities-preview` | `preview_llm_capabilities` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `POST` | `/api/v1/admin/agent/llm-presets/models-preview` | `preview_llm_preset_models` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `POST` | `/api/v1/admin/agent/llm-presets/probe-media-preview` | `probe_media_preview` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `POST` | `/api/v1/admin/agent/llm-presets/strategy` | `set_llm_strategy` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `POST` | `/api/v1/admin/agent/llm-presets/{preset_id}/activate` | `activate_llm_preset` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `POST` | `/api/v1/admin/agent/llm-presets/{preset_id}/capabilities` | `probe_llm_capabilities` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `POST` | `/api/v1/admin/agent/llm-presets/{preset_id}/probe-media` | `probe_media_preset` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `POST` | `/api/v1/admin/agent/llm-presets/{preset_id}/test` | `test_llm_preset` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `POST` | `/api/v1/admin/agent/memory/im-scopes/maintenance/apply` | `apply_im_memory_maintenance` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `POST` | `/api/v1/admin/agent/memory/im-scopes/maintenance/model-preview` | `start_im_memory_model_preview` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `POST` | `/api/v1/admin/agent/memory/im-scopes/maintenance/preview` | `preview_im_memory_maintenance` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `POST` | `/api/v1/admin/agent/voice-presets` | `create_voice_preset` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `POST` | `/api/v1/admin/agent/voice-presets/deactivate` | `deactivate_voice_preset` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `POST` | `/api/v1/admin/agent/voice-presets/models-preview` | `preview_voice_preset_models` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `POST` | `/api/v1/admin/agent/voice-presets/test` | `test_voice_preset` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `POST` | `/api/v1/admin/agent/voice-presets/{preset_id}/activate` | `activate_voice_preset` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `PUT` | `/api/v1/admin/agent/llm-presets/{preset_id}` | `update_llm_preset` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `PUT` | `/api/v1/admin/agent/llm-presets/{preset_id}/capability-overrides` | `update_capability_overrides` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `PUT` | `/api/v1/admin/agent/prompts/{profile}` | `update_prompt` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `PUT` | `/api/v1/admin/agent/state-labels` | `update_state_labels` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `PUT` | `/api/v1/admin/agent/voice-presets/{preset_id}` | `update_voice_preset` | 待迁移 |
| `backend/app/api/v1/agent_perception.py` | `GET` | `/api/v1/admin/perception/` | `perception_stats` | Node 模块原型8/8，Python最近邻6/6；Host guard/Redis/DB/记忆适配未接入，错误detail仍有差异 |
| `backend/app/api/v1/agent_perception.py` | `GET` | `/api/v1/admin/perception/export` | `export_events` | Node 模块原型8/8，Host未注册；数据源及真实运行态未验收 |
| `backend/app/api/v1/agent_perception.py` | `GET` | `/api/v1/admin/perception/misread/export` | `misread_export` | Node 模块原型8/8，Host未注册；需可信记忆读取与Admin guard |
| `backend/app/api/v1/agent_perception.py` | `GET` | `/api/v1/admin/perception/misread/recent` | `misread_recent` | Node 模块原型8/8，Host未注册；需可信记忆读取与Admin guard |
| `backend/app/api/v1/agent_routes/attachments.py` | `DELETE` | `/api/v1/agent/attachment/{attach_id}` | `delete_draft_attachment` | 待迁移 |
| `backend/app/api/v1/agent_routes/attachments.py` | `DELETE` | `/api/v1/agent/attachments` | `clear_attachments` | 待迁移 |
| `backend/app/api/v1/agent_routes/attachments.py` | `GET` | `/api/v1/agent/attachment/{attach_id}/download` | `attachment_download` | 待迁移 |
| `backend/app/api/v1/agent_routes/attachments.py` | `GET` | `/api/v1/agent/attachment/{attach_id}/thumb` | `attachment_thumb` | 待迁移 |
| `backend/app/api/v1/agent_routes/attachments.py` | `POST` | `/api/v1/agent/upload` | `upload_attachment` | 待迁移 |
| `backend/app/api/v1/agent_routes/chat.py` | `GET` | `/api/v1/agent/sessions/{session_id}/state` | `get_session_state` | 待迁移 |
| `backend/app/api/v1/agent_routes/chat.py` | `GET` | `/api/v1/agent/sessions/{session_id}/stream` | `resume_stream` | 待迁移 |
| `backend/app/api/v1/agent_routes/chat.py` | `POST` | `/api/v1/agent/chat` | `chat` | 待迁移 |
| `backend/app/api/v1/agent_routes/chat.py` | `POST` | `/api/v1/agent/sessions/{session_id}/cancel` | `cancel_stream` | 待迁移 |
| `backend/app/api/v1/agent_routes/interactions.py` | `GET` | `/api/v1/agent/interactions/{prompt_id}/session` | `get_interaction_session` | Node route 原型3/3；Python owner-scoped secret-link 基线1/1；Host 未挂载，真实 PG 查询未验收 |
| `backend/app/api/v1/agent_routes/interactions.py` | `POST` | `/api/v1/agent/interactions/{prompt_id}/respond` | `respond_interaction` | 待迁移 |
| `backend/app/api/v1/agent_routes/interactions.py` | `POST` | `/api/v1/agent/interactions/{prompt_id}/resume` | `resume_interaction` | 待迁移 |
| `backend/app/api/v1/agent_routes/interactions.py` | `POST` | `/api/v1/agent/interactions/{prompt_id}/resume-text` | `resume_text_interaction` | 待迁移 |
| `backend/app/api/v1/agent_routes/interactions.py` | `POST` | `/api/v1/agent/interactions/{prompt_id}/secrets` | `submit_secret_interaction` | 待迁移 |
| `backend/app/api/v1/agent_routes/interactions.py` | `POST` | `/api/v1/agent/interactions/{prompt_id}/secrets/cancel` | `cancel_secret_interaction` | 待迁移 |
| `backend/app/api/v1/agent_routes/misc.py` | `DELETE` | `/api/v1/agent/memory` | `clear_memory` | 待迁移 |
| `backend/app/api/v1/agent_routes/misc.py` | `GET` | `/api/v1/agent/commands` | `get_commands` | Node `agent-misc` 原型3/3；Python commands 最近邻65/65；Host 未挂载，不计路由覆盖 |
| `backend/app/api/v1/agent_routes/misc.py` | `GET` | `/api/v1/agent/greeting` | `get_greeting` | 待迁移 |
| `backend/app/api/v1/agent_routes/misc.py` | `GET` | `/api/v1/agent/ui-labels` | `get_ui_labels` | Node `agent-misc` 原型3/3；Python commands 最近邻65/65；Host 未挂载，不计路由覆盖 |
| `backend/app/api/v1/agent_routes/misc.py` | `GET` | `/api/v1/agent/voice-availability` | `get_voice_availability` | 待迁移；Python 依赖基线2/2；Node 缺 BYOK 凭据解密/密钥版本、Provider URL resolver 与 VoiceSettings，Host 契约待提供 |
| `backend/app/api/v1/agent_routes/pending_queue.py` | `GET` | `/api/v1/agent/pending-queues/imported-drafts` | `list_imported_draft_queues` | Node owner-scoped 原型4/4；Python 最近邻2/2；Host 未挂载，PG测试跳过 |
| `backend/app/api/v1/agent_routes/pending_queue.py` | `GET` | `/api/v1/agent/pending-queues/{queue_id}` | `get_pending_queue_by_id` | Node owner-scoped 原型4/4；Python 直接基线2/2；Host 未挂载，PG测试跳过 |
| `backend/app/api/v1/agent_routes/pending_queue.py` | `PATCH` | `/api/v1/agent/pending-queues/{queue_id}` | `patch_session_pending_queue` | Node PATCH 原型4路由测试+合并行为测试通过；Python 基线2/2；Host 未挂载，PG测试跳过 |
| `backend/app/api/v1/agent_routes/pending_queue.py` | `POST` | `/api/v1/agent/pending-queues/{queue_id}/items/{item_key}/claim` | `claim_session_pending_queue_item` | Node owner-scoped 原型3/3；Python 直接基线3/3；Host 未挂载，PG锁/并发未验收 |
| `backend/app/api/v1/agent_routes/pending_queue.py` | `POST` | `/api/v1/agent/pending-queues/{queue_id}/items/{item_key}/release` | `release_session_pending_queue_item` | Node owner-scoped 原型3/3；Python 直接基线3/3；Host 未挂载，PG锁/并发未验收 |
| `backend/app/api/v1/agent_routes/pending_queue.py` | `PUT` | `/api/v1/agent/pending-queues/{queue_id}` | `update_draft_pending_queue` | 待迁移 |
| `backend/app/api/v1/agent_routes/sandbox.py` | `POST` | `/api/v1/agent/sandbox/clear` | `clear_my_sandbox` | 待迁移 |
| `backend/app/api/v1/agent_routes/sandbox.py` | `POST` | `/api/v1/agent/sandbox/rebuild` | `rebuild_my_sandbox` | 待迁移 |
| `backend/app/api/v1/agent_routes/sandbox.py` | `POST` | `/api/v1/agent/sandbox/restart` | `restart_my_sandbox` | 待迁移 |
| `backend/app/api/v1/agent_routes/sessions.py` | `DELETE` | `/api/v1/agent/sessions/{session_id}` | `delete_session` | 待迁移 |
| `backend/app/api/v1/agent_routes/sessions.py` | `DELETE` | `/api/v1/agent/sessions/{session_id}/filesystem-authorization` | `revoke_session_filesystem_authorization` | 待迁移 |
| `backend/app/api/v1/agent_routes/sessions.py` | `GET` | `/api/v1/agent/messages/{message_id}` | `get_message_location` | Node owner-scoped 原型3/3；Python 最近邻2/2；Host 未挂载，PG测试跳过 |
| `backend/app/api/v1/agent_routes/sessions.py` | `GET` | `/api/v1/agent/sessions` | `list_sessions` | Node owner-scoped 原型2/2；Python 基线1/1；Host 未挂载，PG测试跳过 |
| `backend/app/api/v1/agent_routes/sessions.py` | `GET` | `/api/v1/agent/sessions/{session_id}/messages` | `get_session_messages` | Node 安全历史投影/分页原型已测；Python 消息历史基线4/4；Host 未挂载，PG行为未验收 |
| `backend/app/api/v1/agent_routes/sessions.py` | `GET` | `/api/v1/agent/sessions/{session_id}/tool-event-details` | `get_session_tool_event_details` | Node route wrapper 2/2，隔离 PG 用例跳过；Python owner/时间线/配对基线3/3；Vite 404，Host 未挂载 |
| `backend/app/api/v1/agent_routes/sessions.py` | `PATCH` | `/api/v1/agent/sessions/{session_id}` | `rename_session` | Node owner-scoped 原型4/4；Python 最近邻并发重命名基线3/3；Host 未挂载，PG并发未验收 |
| `backend/app/api/v1/agent_routes/sessions.py` | `POST` | `/api/v1/agent/sessions/{session_id}/filesystem-authorization` | `confirm_session_filesystem_authorization` | 待迁移 |
| `backend/app/api/v1/agent_routes/sessions.py` | `POST` | `/api/v1/agent/sessions/{session_id}/filesystem-authorization/request` | `request_session_filesystem_authorization` | 待迁移 |
| `backend/app/api/v1/agent_routes/sessions.py` | `POST` | `/api/v1/agent/sessions/{session_id}/refresh-context` | `refresh_session_context` | Node 失效化原型4/4；Python snapshot 最近邻1/1；Host 未挂载，PG行为未验收 |
| `backend/app/api/v1/audit_log.py` | `GET` | `/api/v1/admin/audit-log/` | `list_audit_logs` | 待迁移 |
| `backend/app/api/v1/audit_log.py` | `GET` | `/api/v1/admin/audit-log/security-events` | `list_security_events` | Node Host 已接可信 Admin guard、PG query 与 Python-compatible HMAC user fingerprint；Vite 未认证401；真实PG未验收 |
| `backend/app/api/v1/auth.py` | `DELETE` | `/api/v1/auth/me` | `delete_my_account` | 待迁移 |
| `backend/app/api/v1/auth.py` | `GET` | `/api/v1/auth/avatar/{user_id}` | `get_avatar` | 待迁移 |
| `backend/app/api/v1/auth.py` | `GET` | `/api/v1/auth/me` | `me` | Node 已接入 |
| `backend/app/api/v1/auth.py` | `GET` | `/api/v1/auth/quota` | `get_quota` | 待迁移 |
| `backend/app/api/v1/auth.py` | `GET` | `/api/v1/auth/usage/trends` | `get_usage_trends` | 待迁移 |
| `backend/app/api/v1/auth.py` | `PATCH` | `/api/v1/auth/profile` | `update_profile` | Node 已接入；devserver 行为与 PG 已验收 |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/avatar` | `upload_avatar` | 待迁移 |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/email-change/cancel` | `cancel_email_change` | 待迁移 |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/email-change/request` | `request_email_change` | 待迁移 |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/email-change/resend` | `resend_email_change` | 待迁移 |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/email-change/verify` | `verify_email_change` | 待迁移 |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/forgot-password` | `forgot_password` | 待迁移 |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/login` | `login` | Node 已接入 |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/logout` | `logout` | Node 已接入；devserver 行为与 PG 已验收 |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/register` | `register` | Host 显式 503 guard；路由/PG adapter 原型与单测存在，但限流、验证码 Redis/邮件、Local 根目录 ACL 和 onboarding 依赖未接入，业务仍待迁移 |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/registration-code` | `send_registration_code` | Host route、Redis code-store adapter 已接入；Vite smoke 返回 fail-closed 503（Redis 限流不可用/未配置，且 Node SMTP sender 未接入），业务仍待迁移 |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/reset-password` | `reset_password` | 待迁移 |
| `backend/app/api/v1/byok.py` | `DELETE` | `/api/v1/byok/{credential_id}` | `delete_credential` | 待迁移 |
| `backend/app/api/v1/byok.py` | `GET` | `/api/v1/byok/` | `get_credentials` | 待迁移 |
| `backend/app/api/v1/byok.py` | `GET` | `/api/v1/byok/embedding-rebuild/status` | `rebuild_my_vectors_status` | 待迁移 |
| `backend/app/api/v1/byok.py` | `PATCH` | `/api/v1/byok/{credential_id}` | `patch_credential` | 待迁移 |
| `backend/app/api/v1/byok.py` | `POST` | `/api/v1/byok/` | `create_credential` | 待迁移 |
| `backend/app/api/v1/byok.py` | `POST` | `/api/v1/byok/capabilities` | `preview_provider_capabilities` | 待迁移 |
| `backend/app/api/v1/byok.py` | `POST` | `/api/v1/byok/embedding-rebuild` | `rebuild_my_vectors` | 待迁移 |
| `backend/app/api/v1/byok.py` | `POST` | `/api/v1/byok/media-capability-probe` | `probe_media` | 待迁移 |
| `backend/app/api/v1/byok.py` | `POST` | `/api/v1/byok/models-preview` | `preview_models` | 待迁移 |
| `backend/app/api/v1/byok.py` | `POST` | `/api/v1/byok/test-preview` | `test_credential_preview` | 待迁移 |
| `backend/app/api/v1/byok.py` | `POST` | `/api/v1/byok/{credential_id}/test` | `test_credential` | 待迁移 |
| `backend/app/api/v1/clients.py` | `DELETE` | `/api/v1/clients/{cid}` | `delete_client` | Node 已接入 |
| `backend/app/api/v1/clients.py` | `GET` | `/api/v1/clients/` | `list_clients` | Node 已接入 |
| `backend/app/api/v1/clients.py` | `POST` | `/api/v1/clients/` | `create_client` | Node 已接入 |
| `backend/app/api/v1/config.py` | `GET` | `/api/v1/admin/config/` | `read_config` | 待迁移 |
| `backend/app/api/v1/config.py` | `GET` | `/api/v1/admin/config/embedding-rebuild/status` | `embedding_rebuild_status` | 待迁移 |
| `backend/app/api/v1/config.py` | `GET` | `/api/v1/admin/config/index-rebuild/status` | `index_rebuild_status` | 待迁移 |
| `backend/app/api/v1/config.py` | `GET` | `/api/v1/admin/config/memory-cleanup/status` | `memory_cleanup_status` | 待迁移 |
| `backend/app/api/v1/config.py` | `GET` | `/api/v1/admin/config/reconcile-storage` | `reconcile_storage` | 待迁移 |
| `backend/app/api/v1/config.py` | `GET` | `/api/v1/admin/config/reconcile-storage/path-migration` | `scan_path_migration` | 待迁移 |
| `backend/app/api/v1/config.py` | `GET` | `/api/v1/admin/config/reconcile-users` | `reconcile_users` | 待迁移 |
| `backend/app/api/v1/config.py` | `PATCH` | `/api/v1/admin/config/` | `update_config` | 待迁移 |
| `backend/app/api/v1/config.py` | `POST` | `/api/v1/admin/config/embedding-rebuild` | `embedding_rebuild` | 待迁移 |
| `backend/app/api/v1/config.py` | `POST` | `/api/v1/admin/config/index-rebuild` | `index_rebuild` | 待迁移 |
| `backend/app/api/v1/config.py` | `POST` | `/api/v1/admin/config/init-db` | `init_db` | 待迁移 |
| `backend/app/api/v1/config.py` | `POST` | `/api/v1/admin/config/memory-cleanup/apply` | `memory_cleanup_apply` | 待迁移 |
| `backend/app/api/v1/config.py` | `POST` | `/api/v1/admin/config/memory-cleanup/preview` | `memory_cleanup_preview` | 待迁移 |
| `backend/app/api/v1/config.py` | `POST` | `/api/v1/admin/config/reconcile-storage/ghosts/repair` | `repair_ghost_records` | 待迁移 |
| `backend/app/api/v1/config.py` | `POST` | `/api/v1/admin/config/reconcile-storage/path-migration/repair` | `repair_path_migration` | 待迁移 |
| `backend/app/api/v1/config.py` | `POST` | `/api/v1/admin/config/reconcile-storage/repair` | `reconcile_repair` | 待迁移 |
| `backend/app/api/v1/config.py` | `POST` | `/api/v1/admin/config/reconcile-users/repair` | `repair_users_without_storage` | 待迁移 |
| `backend/app/api/v1/config.py` | `POST` | `/api/v1/admin/config/test-connection` | `test_connection` | 待迁移 |
| `backend/app/api/v1/config.py` | `POST` | `/api/v1/admin/config/test-embedding` | `test_embedding` | 待迁移 |
| `backend/app/api/v1/config.py` | `POST` | `/api/v1/admin/config/test-search` | `test_search` | 待迁移 |
| `backend/app/api/v1/config.py` | `POST` | `/api/v1/admin/config/test-smtp` | `test_smtp` | 待迁移 |
| `backend/app/api/v1/config.py` | `POST` | `/api/v1/admin/config/test-voice` | `test_voice` | 待迁移 |
| `backend/app/api/v1/data_portability.py` | `DELETE` | `/api/v1/data-portability/exports/{job_id}` | `delete_export` | 待迁移 |
| `backend/app/api/v1/data_portability.py` | `DELETE` | `/api/v1/data-portability/imports/{job_id}` | `delete_import` | 待迁移 |
| `backend/app/api/v1/data_portability.py` | `GET` | `/api/v1/data-portability/export/preview` | `export_preview` | 待迁移 |
| `backend/app/api/v1/data_portability.py` | `GET` | `/api/v1/data-portability/exports` | `list_exports` | 待迁移 |
| `backend/app/api/v1/data_portability.py` | `GET` | `/api/v1/data-portability/exports/{job_id}` | `get_export` | 待迁移 |
| `backend/app/api/v1/data_portability.py` | `GET` | `/api/v1/data-portability/exports/{job_id}/download` | `download_export` | 待迁移 |
| `backend/app/api/v1/data_portability.py` | `GET` | `/api/v1/data-portability/exports/{job_id}/download/browser` | `download_export_browser` | 待迁移 |
| `backend/app/api/v1/data_portability.py` | `GET` | `/api/v1/data-portability/imports` | `list_imports` | 待迁移 |
| `backend/app/api/v1/data_portability.py` | `GET` | `/api/v1/data-portability/imports/{job_id}` | `get_import` | 待迁移 |
| `backend/app/api/v1/data_portability.py` | `POST` | `/api/v1/data-portability/exports` | `create_export` | 待迁移 |
| `backend/app/api/v1/data_portability.py` | `POST` | `/api/v1/data-portability/exports/{job_id}/cancel` | `cancel_export` | 待迁移 |
| `backend/app/api/v1/data_portability.py` | `POST` | `/api/v1/data-portability/exports/{job_id}/download-ticket` | `create_browser_download_ticket` | 待迁移 |
| `backend/app/api/v1/data_portability.py` | `POST` | `/api/v1/data-portability/imports/preflight` | `preflight_import` | 待迁移 |
| `backend/app/api/v1/data_portability.py` | `POST` | `/api/v1/data-portability/imports/{job_id}/apply` | `apply_import` | 待迁移 |
| `backend/app/api/v1/data_portability.py` | `POST` | `/api/v1/data-portability/imports/{job_id}/cancel` | `cancel_import` | 待迁移 |
| `backend/app/api/v1/data_portability.py` | `POST` | `/api/v1/data-portability/imports/{job_id}/recover` | `recover_import` | 待迁移 |
| `backend/app/api/v1/data_portability.py` | `POST` | `/api/v1/data-portability/imports/{job_id}/resume` | `resume_import` | 待迁移 |
| `backend/app/api/v1/data_portability.py` | `POST` | `/api/v1/data-portability/imports/{job_id}/rollback` | `rollback_import` | 待迁移 |
| `backend/app/api/v1/dev_attention.py` | `GET` | `/api/v1/dev/attention/defaults` | `attention_defaults` | 待迁移 |
| `backend/app/api/v1/dev_attention.py` | `POST` | `/api/v1/dev/attention/score` | `score_attention` | 待迁移 |
| `backend/app/api/v1/email_admin.py` | `GET` | `/api/v1/admin/email/recipient-count` | `recipient_count` | 待迁移 |
| `backend/app/api/v1/email_admin.py` | `POST` | `/api/v1/admin/email/preview` | `preview_email` | 待迁移 |
| `backend/app/api/v1/email_admin.py` | `POST` | `/api/v1/admin/email/publish` | `publish_email` | 待迁移 |
| `backend/app/api/v1/email_admin.py` | `POST` | `/api/v1/admin/email/test` | `test_email` | 待迁移 |
| `backend/app/api/v1/email_admin.py` | `POST` | `/api/v1/admin/email/translate` | `translate_email` | 待迁移 |
| `backend/app/api/v1/events.py` | `DELETE` | `/api/v1/events/{eid}` | `delete_event` | Node CRUD/PG adapter 已接入；signed-int route/application 语义专测 8/8；calendar mutation post-commit adapter 已接入 context revision、calendar/scheduled_task RAG 持久入队与一次 live event 委托；devserver 隔离 schema PostgreSQL 回归通过。RAG 消费与恢复仍由 Python worker 负责 |
| `backend/app/api/v1/events.py` | `GET` | `/api/v1/events/` | `list_events` | Node 已接入 |
| `backend/app/api/v1/events.py` | `GET` | `/api/v1/events/{eid}` | `get_event` | Node 已接入 |
| `backend/app/api/v1/events.py` | `PATCH` | `/api/v1/events/{eid}` | `update_event` | Node CRUD/PG adapter 已接入；signed-int route/application 语义专测 8/8；calendar mutation post-commit adapter 已接入 context revision、calendar/scheduled_task RAG 持久入队与一次 live event 委托；devserver 隔离 schema PostgreSQL 回归通过。RAG 消费与恢复仍由 Python worker 负责 |
| `backend/app/api/v1/events.py` | `POST` | `/api/v1/events/` | `create_event` | Node CRUD/PG adapter 与 create post-commit adapter 已接入 context revision、calendar RAG 持久入队与 live event；devserver 隔离 schema PostgreSQL 回归通过。RAG 消费与恢复仍由 Python worker 负责 |
| `backend/app/api/v1/feedback.py` | `POST` | `/api/v1/feedback/` | `submit_feedback` | 待迁移 |
| `backend/app/api/v1/feishu_connect.py` | `GET` | `/api/v1/me/feishu/connect/{poll_id}` | `poll` | 待迁移 |
| `backend/app/api/v1/feishu_connect.py` | `POST` | `/api/v1/me/feishu/connect/` | `start` | 待迁移 |
| `backend/app/api/v1/files.py` | `DELETE` | `/api/v1/files/{fid}` | `delete_file` | 待迁移 |
| `backend/app/api/v1/files.py` | `GET` | `/api/v1/files/` | `list_file_page` | 待迁移 |
| `backend/app/api/v1/files.py` | `GET` | `/api/v1/files/library-counts` | `file_library_counts` | 待迁移 |
| `backend/app/api/v1/files.py` | `GET` | `/api/v1/files/page` | `list_file_page` | 待迁移 |
| `backend/app/api/v1/files.py` | `GET` | `/api/v1/files/storage` | `files_storage` | 待迁移 |
| `backend/app/api/v1/files.py` | `GET` | `/api/v1/files/summary` | `file_summary` | 待迁移 |
| `backend/app/api/v1/files.py` | `GET` | `/api/v1/files/{fid}` | `get_file` | 待迁移 |
| `backend/app/api/v1/files.py` | `GET` | `/api/v1/files/{fid}/download` | `download_file` | 待迁移 |
| `backend/app/api/v1/files.py` | `GET` | `/api/v1/files/{fid}/location` | `get_file_location` | 待迁移 |
| `backend/app/api/v1/files.py` | `GET` | `/api/v1/files/{fid}/stream` | `stream_file` | 待迁移 |
| `backend/app/api/v1/files.py` | `GET` | `/api/v1/files/{fid}/stream-url` | `get_stream_url` | 待迁移 |
| `backend/app/api/v1/files.py` | `GET` | `/api/v1/files/{fid}/thumb` | `get_thumb` | 待迁移 |
| `backend/app/api/v1/files.py` | `GET` | `/api/v1/files/{fid}/xlsx-preview` | `xlsx_preview` | 待迁移 |
| `backend/app/api/v1/files.py` | `GET` | `/api/v1/files/{fid}/xlsx-preview-image/{image_id}` | `xlsx_preview_image` | 待迁移 |
| `backend/app/api/v1/files.py` | `PATCH` | `/api/v1/files/{fid}` | `update_file` | 待迁移 |
| `backend/app/api/v1/files.py` | `POST` | `/api/v1/files/` | `upload_file` | 待迁移 |
| `backend/app/api/v1/files.py` | `POST` | `/api/v1/files/archive` | `create_archive` | 待迁移 |
| `backend/app/api/v1/files.py` | `POST` | `/api/v1/files/batch-delete` | `batch_delete_files` | 待迁移 |
| `backend/app/api/v1/files.py` | `POST` | `/api/v1/files/batch-download` | `batch_download_files` | 待迁移 |
| `backend/app/api/v1/files.py` | `POST` | `/api/v1/files/check-conflicts` | `check_conflicts` | 待迁移 |
| `backend/app/api/v1/files.py` | `POST` | `/api/v1/files/confirm` | `confirm_upload` | 待迁移 |
| `backend/app/api/v1/files.py` | `POST` | `/api/v1/files/presign` | `presign_upload` | 待迁移 |
| `backend/app/api/v1/files.py` | `POST` | `/api/v1/files/unarchive` | `unarchive_file` | 待迁移 |
| `backend/app/api/v1/files.py` | `POST` | `/api/v1/files/{fid}/copy` | `copy_file` | 待迁移 |
| `backend/app/api/v1/files.py` | `POST` | `/api/v1/files/{fid}/resolve-paths` | `resolve_file_paths` | 待迁移 |
| `backend/app/api/v1/files.py` | `PUT` | `/api/v1/files/{fid}/content` | `update_file_content` | 待迁移 |
| `backend/app/api/v1/filesync_admin.py` | `GET` | `/api/v1/admin/filesync/events` | `filesync_admin_events` | 待迁移 |
| `backend/app/api/v1/filesync_admin.py` | `GET` | `/api/v1/admin/filesync/runs` | `runs` | 待迁移 |
| `backend/app/api/v1/filesync_admin.py` | `GET` | `/api/v1/admin/filesync/runs/{run_id}` | `run_status` | 待迁移 |
| `backend/app/api/v1/filesync_admin.py` | `GET` | `/api/v1/admin/filesync/status` | `sync_status` | 待迁移 |
| `backend/app/api/v1/filesync_admin.py` | `POST` | `/api/v1/admin/filesync/bindings/{binding_id}/dry-run` | `binding_dry_run` | 待迁移 |
| `backend/app/api/v1/filesync_admin.py` | `POST` | `/api/v1/admin/filesync/bindings/{binding_id}/initialize` | `binding_initialize` | 待迁移 |
| `backend/app/api/v1/filesync_admin.py` | `POST` | `/api/v1/admin/filesync/bindings/{binding_id}/missing-apply` | `missing_apply` | 待迁移 |
| `backend/app/api/v1/filesync_admin.py` | `POST` | `/api/v1/admin/filesync/bindings/{binding_id}/missing-preview` | `missing_preview` | 待迁移 |
| `backend/app/api/v1/filesync_admin.py` | `POST` | `/api/v1/admin/filesync/bindings/{binding_id}/reconcile` | `binding_reconcile` | 待迁移 |
| `backend/app/api/v1/filesync_admin.py` | `POST` | `/api/v1/admin/filesync/conflicts/{conflict_id}/resolve` | `conflict_resolve` | 待迁移 |
| `backend/app/api/v1/filesync_admin.py` | `POST` | `/api/v1/admin/filesync/reconcile-issues` | `reconcile_issue_bindings` | 待迁移 |
| `backend/app/api/v1/filesync_admin.py` | `POST` | `/api/v1/admin/filesync/runs/{run_id}/cancel` | `cancel_run` | 待迁移 |
| `backend/app/api/v1/filesync_admin.py` | `POST` | `/api/v1/admin/filesync/watcher-capacity/expand` | `expand_watcher_capacity` | 待迁移 |
| `backend/app/api/v1/folder_doctor_admin.py` | `GET` | `/api/v1/admin/folder-doctor/scan` | `scan_dirs` | 待迁移 |
| `backend/app/api/v1/folder_doctor_admin.py` | `POST` | `/api/v1/admin/folder-doctor/repair` | `repair_dirs` | 待迁移 |
| `backend/app/api/v1/folders.py` | `DELETE` | `/api/v1/folders/{fid}` | `delete_folder` | 待迁移 |
| `backend/app/api/v1/folders.py` | `GET` | `/api/v1/folders/` | `list_folder_page` | 待迁移 |
| `backend/app/api/v1/folders.py` | `GET` | `/api/v1/folders/page` | `list_folder_page` | 待迁移 |
| `backend/app/api/v1/folders.py` | `GET` | `/api/v1/folders/{fid}` | `get_folder` | 待迁移 |
| `backend/app/api/v1/folders.py` | `GET` | `/api/v1/folders/{fid}/download` | `download_folder` | 待迁移 |
| `backend/app/api/v1/folders.py` | `GET` | `/api/v1/folders/{fid}/location` | `get_folder_location` | 待迁移 |
| `backend/app/api/v1/folders.py` | `PATCH` | `/api/v1/folders/{fid}` | `rename_folder` | 待迁移 |
| `backend/app/api/v1/folders.py` | `PATCH` | `/api/v1/folders/{fid}/parent` | `move_folder` | 待迁移 |
| `backend/app/api/v1/folders.py` | `POST` | `/api/v1/folders/` | `create_folder` | 待迁移 |
| `backend/app/api/v1/folders.py` | `POST` | `/api/v1/folders/resolve-paths` | `resolve_folder_paths` | 待迁移 |
| `backend/app/api/v1/folders.py` | `POST` | `/api/v1/folders/{fid}/copy` | `copy_folder` | 待迁移 |
| `backend/app/api/v1/live.py` | `GET` | `/api/v1/live/stream` | `stream_live_events` | 待迁移 |
| `backend/app/api/v1/loopscope.py` | `GET` | `/api/v1/dev/loopscope/{path:path}` | `proxy_loopscope_read` | 待迁移 |
| `backend/app/api/v1/mcp_settings.py` | `DELETE` | `/api/v1/mcp/servers/{server_id}` | `delete_server` | 待迁移 |
| `backend/app/api/v1/mcp_settings.py` | `GET` | `/api/v1/mcp/servers` | `list_servers` | 待迁移 |
| `backend/app/api/v1/mcp_settings.py` | `GET` | `/api/v1/mcp/servers/{server_id}/tools` | `list_loaded_tools` | 待迁移 |
| `backend/app/api/v1/mcp_settings.py` | `GET` | `/api/v1/mcp/status` | `mcp_status` | 待迁移 |
| `backend/app/api/v1/mcp_settings.py` | `PATCH` | `/api/v1/mcp/servers/{server_id}` | `update_server` | 待迁移 |
| `backend/app/api/v1/mcp_settings.py` | `POST` | `/api/v1/mcp/servers` | `create_server` | 待迁移 |
| `backend/app/api/v1/mcp_settings.py` | `POST` | `/api/v1/mcp/servers/{server_id}/load_status` | `load_server_status` | 待迁移 |
| `backend/app/api/v1/mcp_settings.py` | `POST` | `/api/v1/mcp/servers/{server_id}/reconnect` | `reconnect_server` | 待迁移 |
| `backend/app/api/v1/mcp_settings.py` | `POST` | `/api/v1/mcp/servers/{server_id}/test_connection` | `test_connection` | 待迁移 |
| `backend/app/api/v1/mind.py` | `DELETE` | `/api/v1/mind/canvases/{cid}` | `delete_canvas` | 待迁移 |
| `backend/app/api/v1/mind.py` | `DELETE` | `/api/v1/mind/canvases/{cid}/items/{iid}` | `remove_canvas_item` | 待迁移 |
| `backend/app/api/v1/mind.py` | `DELETE` | `/api/v1/mind/canvases/{cid}/relations/{rid}` | `delete_canvas_relation` | 待迁移 |
| `backend/app/api/v1/mind.py` | `DELETE` | `/api/v1/mind/notes/{nid}` | `delete_note` | 待迁移 |
| `backend/app/api/v1/mind.py` | `DELETE` | `/api/v1/mind/relations/{rid}` | `delete_relation` | 待迁移 |
| `backend/app/api/v1/mind.py` | `GET` | `/api/v1/mind/canvases` | `list_canvases` | 待迁移 |
| `backend/app/api/v1/mind.py` | `GET` | `/api/v1/mind/canvases/{cid}/items` | `list_canvas_items` | 待迁移 |
| `backend/app/api/v1/mind.py` | `GET` | `/api/v1/mind/canvases/{cid}/relations` | `list_canvas_relations` | 待迁移 |
| `backend/app/api/v1/mind.py` | `GET` | `/api/v1/mind/nodes/{nid}/canvas-location` | `canvas_note_location` | 待迁移 |
| `backend/app/api/v1/mind.py` | `GET` | `/api/v1/mind/notes` | `list_notes` | 待迁移 |
| `backend/app/api/v1/mind.py` | `GET` | `/api/v1/mind/notes/{nid}` | `get_note` | 待迁移 |
| `backend/app/api/v1/mind.py` | `GET` | `/api/v1/mind/ref-suggest` | `ref_suggest` | 待迁移 |
| `backend/app/api/v1/mind.py` | `PATCH` | `/api/v1/mind/canvases/{cid}` | `update_canvas` | 待迁移 |
| `backend/app/api/v1/mind.py` | `PATCH` | `/api/v1/mind/canvases/{cid}/items/{iid}` | `update_canvas_item` | 待迁移 |
| `backend/app/api/v1/mind.py` | `PATCH` | `/api/v1/mind/nodes/{nid}` | `update_canvas_note` | 待迁移 |
| `backend/app/api/v1/mind.py` | `PATCH` | `/api/v1/mind/notes/{nid}` | `update_note` | 待迁移 |
| `backend/app/api/v1/mind.py` | `POST` | `/api/v1/mind/canvases` | `create_canvas` | 待迁移 |
| `backend/app/api/v1/mind.py` | `POST` | `/api/v1/mind/canvases/{cid}/items` | `add_canvas_item` | 待迁移 |
| `backend/app/api/v1/mind.py` | `POST` | `/api/v1/mind/canvases/{cid}/items/{iid}/bring-to-front` | `bring_canvas_item_to_front` | 待迁移 |
| `backend/app/api/v1/mind.py` | `POST` | `/api/v1/mind/canvases/{cid}/notes` | `create_canvas_note` | 待迁移 |
| `backend/app/api/v1/mind.py` | `POST` | `/api/v1/mind/nodes/ref` | `create_ref_node` | 待迁移 |
| `backend/app/api/v1/mind.py` | `POST` | `/api/v1/mind/notes` | `create_note` | 待迁移 |
| `backend/app/api/v1/mind.py` | `POST` | `/api/v1/mind/relations` | `create_relation` | 待迁移 |
| `backend/app/api/v1/notifications.py` | `DELETE` | `/api/v1/notifications/` | `clear_notifications` | Node 已接入 |
| `backend/app/api/v1/notifications.py` | `GET` | `/api/v1/notifications/` | `list_notifications` | Node 已接入 |
| `backend/app/api/v1/notifications.py` | `GET` | `/api/v1/notifications/bubble` | `latest_bubble` | Node 已接入 |
| `backend/app/api/v1/notifications.py` | `POST` | `/api/v1/notifications/read` | `mark_read` | Node 已接入 |
| `backend/app/api/v1/notifications_admin.py` | `DELETE` | `/api/v1/admin/notifications/history/{nid}` | `delete_record` | 待迁移 |
| `backend/app/api/v1/notifications_admin.py` | `GET` | `/api/v1/admin/notifications/history` | `history` | 待迁移 |
| `backend/app/api/v1/notifications_admin.py` | `POST` | `/api/v1/admin/notifications/broadcast` | `broadcast` | 待迁移 |
| `backend/app/api/v1/ops_admin.py` | `GET` | `/api/v1/admin/ops/storage-live-totals` | `storage_live_totals` | 待迁移 |
| `backend/app/api/v1/ops_admin.py` | `GET` | `/api/v1/admin/ops/storage-snapshots` | `storage_snapshots_history` | Node 已接入 Admin guard、PG query、Local statfs/OSS null；真实 PG 行为未验收 |
| `backend/app/api/v1/ops_admin.py` | `GET` | `/api/v1/admin/ops/summary` | `ops_summary` | Node 模块原型4/4；Python 最近邻 opsmetrics 基线3/3（无直接 handler 回归）；Host/Admin guard/Redis adapter 未挂载，不计路由覆盖 |
| `backend/app/api/v1/preferences.py` | `GET` | `/api/v1/preferences/` | `get_preferences` | 待迁移 |
| `backend/app/api/v1/preferences.py` | `GET` | `/api/v1/preferences/smtp` | `get_user_smtp` | 待迁移 |
| `backend/app/api/v1/preferences.py` | `PATCH` | `/api/v1/preferences/` | `update_preferences` | 待迁移 |
| `backend/app/api/v1/preferences.py` | `PATCH` | `/api/v1/preferences/reply-style` | `update_reply_style` | 待迁移 |
| `backend/app/api/v1/preferences.py` | `POST` | `/api/v1/preferences/group-personality/upload` | `upload_group_personality` | 待迁移 |
| `backend/app/api/v1/preferences.py` | `POST` | `/api/v1/preferences/personality/upload` | `upload_personality` | 待迁移 |
| `backend/app/api/v1/preferences.py` | `POST` | `/api/v1/preferences/reply-style/upload` | `upload_reply_style` | 待迁移 |
| `backend/app/api/v1/preferences.py` | `POST` | `/api/v1/preferences/smtp/preview` | `preview_user_email` | 待迁移 |
| `backend/app/api/v1/preferences.py` | `POST` | `/api/v1/preferences/smtp/test` | `test_user_smtp` | 待迁移 |
| `backend/app/api/v1/preferences.py` | `PUT` | `/api/v1/preferences/smtp` | `update_user_smtp` | 待迁移 |
| `backend/app/api/v1/projects.py` | `DELETE` | `/api/v1/projects/{pid}` | `delete_project` | Node Host 已接入；Python 4 项基线通过；Node 项目域定向回归通过；devserver 隔离 schema 项目创建/更新/删除恢复与路径元数据 PostgreSQL 集成 4/4 通过；Local mind/workspace key resolver 已接入，OSS 改名搬移仍缺 |
| `backend/app/api/v1/projects.py` | `GET` | `/api/v1/projects/` | `list_projects` | Node 已接入 |
| `backend/app/api/v1/projects.py` | `GET` | `/api/v1/projects/file-counts` | `list_project_file_counts` | Node 已接入 |
| `backend/app/api/v1/projects.py` | `GET` | `/api/v1/projects/{pid}` | `get_project` | Node 已接入 |
| `backend/app/api/v1/projects.py` | `PATCH` | `/api/v1/projects/{pid}` | `update_project` | Node Host 已接入用户认证与 Local 存储更新 adapter；create/update/trash 提交后 context revision、RAG job、live event 已接入；Python PATCH 基线 3/3，Node 定向回归通过，devserver 隔离 schema PostgreSQL 通过；OSS 改名对象搬移仍未接入 |
| `backend/app/api/v1/projects.py` | `POST` | `/api/v1/projects/` | `create_project` | Node 已接入；devserver 行为与 PG 已验收 |
| `backend/app/api/v1/projects.py` | `POST` | `/api/v1/projects/{pid}/restore` | `restore_project` | Node Host 已接入；Python 4 项基线通过；Local mind/workspace key resolver 已接入；`project-delete-restore-postgres.test.ts` 与 `project-trash-path-metadata-postgres.test.ts` 在 devserver 隔离 schema 实 PG 通过；OSS 物理对象搬移回调仍未接入 |
| `backend/app/api/v1/public_config.py` | `GET` | `/api/v1/site-config/` | `site_config` | Node 已接入 |
| `backend/app/api/v1/qq_connect.py` | `GET` | `/api/v1/me/qq/connect/{task_id}` | `poll` | 待迁移 |
| `backend/app/api/v1/qq_connect.py` | `POST` | `/api/v1/me/qq/connect/` | `start` | 待迁移 |
| `backend/app/api/v1/safe_egress_admin.py` | `GET` | `/api/v1/admin/safe-egress/` | `get_safe_egress_config` | Node 独立读取 route 原型4/4，Python secret 不回显基线1/1；Vite 404，Host 未挂载；PATCH/POST 仍待迁移 |
| `backend/app/api/v1/safe_egress_admin.py` | `PATCH` | `/api/v1/admin/safe-egress/` | `patch_safe_egress_config` | 待迁移 |
| `backend/app/api/v1/safe_egress_admin.py` | `POST` | `/api/v1/admin/safe-egress/test` | `test_safe_egress` | 待迁移 |
| `backend/app/api/v1/sandbox_admin.py` | `GET` | `/api/v1/admin/sandbox/status` | `sandbox_status` | 待迁移 |
| `backend/app/api/v1/sandbox_admin.py` | `POST` | `/api/v1/admin/sandbox/disable` | `disable_sandbox` | 待迁移 |
| `backend/app/api/v1/sandbox_admin.py` | `POST` | `/api/v1/admin/sandbox/egress/config` | `save_egress_proxy` | 待迁移 |
| `backend/app/api/v1/sandbox_admin.py` | `POST` | `/api/v1/admin/sandbox/egress/validate` | `validate_egress_proxy` | 待迁移 |
| `backend/app/api/v1/sandbox_admin.py` | `POST` | `/api/v1/admin/sandbox/enable` | `enable_sandbox` | 待迁移 |
| `backend/app/api/v1/sandbox_admin.py` | `POST` | `/api/v1/admin/sandbox/rebuild` | `rebuild_sandbox` | 待迁移 |
| `backend/app/api/v1/sandbox_admin.py` | `POST` | `/api/v1/admin/sandbox/restart` | `restart_sandbox` | 待迁移 |
| `backend/app/api/v1/sandbox_admin.py` | `POST` | `/api/v1/admin/sandbox/users/clear` | `clear_user_sandboxes` | 待迁移 |
| `backend/app/api/v1/sandbox_admin.py` | `POST` | `/api/v1/admin/sandbox/users/rebuild` | `rebuild_user_sandboxes` | 待迁移 |
| `backend/app/api/v1/sandbox_admin.py` | `POST` | `/api/v1/admin/sandbox/users/restart` | `restart_user_sandboxes` | 待迁移 |
| `backend/app/api/v1/scheduled_tasks.py` | `DELETE` | `/api/v1/scheduled-tasks/{task_id}` | `delete_task` | 待迁移 |
| `backend/app/api/v1/scheduled_tasks.py` | `DELETE` | `/api/v1/scheduled-tasks/{task_id}/filesystem-authorization` | `revoke_task_filesystem_authorization` | 待迁移 |
| `backend/app/api/v1/scheduled_tasks.py` | `GET` | `/api/v1/scheduled-tasks/` | `list_tasks` | 待迁移 |
| `backend/app/api/v1/scheduled_tasks.py` | `GET` | `/api/v1/scheduled-tasks/delivery-targets/{platform}` | `list_delivery_targets` | 待迁移 |
| `backend/app/api/v1/scheduled_tasks.py` | `GET` | `/api/v1/scheduled-tasks/qq-targets` | `list_qq_targets` | 待迁移 |
| `backend/app/api/v1/scheduled_tasks.py` | `PATCH` | `/api/v1/scheduled-tasks/{task_id}` | `update_task` | 待迁移 |
| `backend/app/api/v1/scheduled_tasks.py` | `POST` | `/api/v1/scheduled-tasks/` | `create_task` | 待迁移 |
| `backend/app/api/v1/scheduled_tasks.py` | `POST` | `/api/v1/scheduled-tasks/test-notify` | `test_notify` | 待迁移 |
| `backend/app/api/v1/scheduled_tasks.py` | `POST` | `/api/v1/scheduled-tasks/{task_id}/filesystem-authorization` | `confirm_task_filesystem_authorization` | 待迁移 |
| `backend/app/api/v1/scheduled_tasks.py` | `POST` | `/api/v1/scheduled-tasks/{task_id}/filesystem-authorization/request` | `request_task_filesystem_authorization` | 待迁移 |
| `backend/app/api/v1/scheduled_tasks.py` | `POST` | `/api/v1/scheduled-tasks/{task_id}/run` | `run_now` | 待迁移 |
| `backend/app/api/v1/search.py` | `GET` | `/api/v1/search/` | `search` | 待迁移 |
| `backend/app/api/v1/services_admin.py` | `GET` | `/api/v1/admin/services/` | `list_services` | 待迁移 |
| `backend/app/api/v1/services_admin.py` | `POST` | `/api/v1/admin/services/{name}/restart` | `restart_service` | 待迁移 |
| `backend/app/api/v1/storage_quota_admin.py` | `GET` | `/api/v1/admin/storage-quota/reconcile` | `get_full_reconcile_status` | 待迁移 |
| `backend/app/api/v1/storage_quota_admin.py` | `POST` | `/api/v1/admin/storage-quota/reconcile` | `start_full_reconcile` | 待迁移 |
| `backend/app/api/v1/system_logs.py` | `GET` | `/api/v1/admin/system-logs/` | `list_system_logs` | 待迁移 |
| `backend/app/api/v1/telegram_connect.py` | `POST` | `/api/v1/me/telegram/connect/` | `connect` | 待迁移 |
| `backend/app/api/v1/telegram_connect.py` | `POST` | `/api/v1/me/telegram/connect/{bot_id}/binding-code` | `create_binding_code` | 待迁移 |
| `backend/app/api/v1/telegram_connect.py` | `PUT` | `/api/v1/me/telegram/connect/{bot_id}` | `replace_token` | 待迁移 |
| `backend/app/api/v1/terminals.py` | `DELETE` | `/api/v1/terminals/{terminal_id}` | `delete_terminal_view` | 待迁移 |
| `backend/app/api/v1/terminals.py` | `GET` | `/api/v1/terminals/` | `get_terminals` | 待迁移 |
| `backend/app/api/v1/terminals.py` | `GET` | `/api/v1/terminals/metrics` | `get_terminal_metrics` | 待迁移 |
| `backend/app/api/v1/terminals.py` | `GET` | `/api/v1/terminals/{terminal_id}` | `get_terminal_detail` | 待迁移 |
| `backend/app/api/v1/terminals.py` | `GET` | `/api/v1/terminals/{terminal_id}/events` | `stream_terminal_events` | 待迁移 |
| `backend/app/api/v1/terminals.py` | `PATCH` | `/api/v1/terminals/{terminal_id}` | `rename_terminal_route` | 待迁移 |
| `backend/app/api/v1/terminals.py` | `POST` | `/api/v1/terminals/` | `add_terminal` | 待迁移 |
| `backend/app/api/v1/terminals.py` | `POST` | `/api/v1/terminals/{terminal_id}/cancel/{request_id}` | `cancel_terminal_command` | 待迁移 |
| `backend/app/api/v1/terminals.py` | `POST` | `/api/v1/terminals/{terminal_id}/input` | `terminal_input` | 待迁移 |
| `backend/app/api/v1/terminals.py` | `POST` | `/api/v1/terminals/{terminal_id}/reopen` | `reopen_terminal_view` | 待迁移 |
| `backend/app/api/v1/terminals.py` | `POST` | `/api/v1/terminals/{terminal_id}/reset` | `reset_terminal_view` | 待迁移 |
| `backend/app/api/v1/terminals.py` | `POST` | `/api/v1/terminals/{terminal_id}/terminate` | `terminate_terminal_view` | 待迁移 |
| `backend/app/api/v1/terminals.py` | `WEBSOCKET` | `/api/v1/terminals/{terminal_id}/ws` | `terminal_websocket` | 待迁移 |
| `backend/app/api/v1/track.py` | `POST` | `/api/v1/track/` | `track` | Node 已接入；FastAPI 合成行为探针与 Node route 4/4；422 body 不同（Python结构化且含input，Node通用脱敏），真实PG未验收 |
| `backend/app/api/v1/trash.py` | `DELETE` | `/api/v1/trash/` | `empty_trash` | 待迁移 |
| `backend/app/api/v1/trash.py` | `DELETE` | `/api/v1/trash/folders/{fid}` | `hard_delete_folder` | 待迁移 |
| `backend/app/api/v1/trash.py` | `DELETE` | `/api/v1/trash/{fid}` | `hard_delete_file` | 待迁移 |
| `backend/app/api/v1/trash.py` | `GET` | `/api/v1/trash/empty/active` | `active_empty_trash` | 待迁移 |
| `backend/app/api/v1/trash.py` | `GET` | `/api/v1/trash/empty/{job_id}` | `get_empty_trash_job` | 待迁移 |
| `backend/app/api/v1/trash.py` | `GET` | `/api/v1/trash/folders/page` | `list_trash_folders_page` | 待迁移 |
| `backend/app/api/v1/trash.py` | `GET` | `/api/v1/trash/folders/{fid}/contents/page` | `list_trash_folder_contents_page` | 待迁移 |
| `backend/app/api/v1/trash.py` | `GET` | `/api/v1/trash/page` | `list_trash_page` | 待迁移 |
| `backend/app/api/v1/trash.py` | `POST` | `/api/v1/trash/batch-restore` | `batch_restore` | 待迁移 |
| `backend/app/api/v1/trash.py` | `POST` | `/api/v1/trash/empty` | `start_empty_trash` | 待迁移 |
| `backend/app/api/v1/trash.py` | `POST` | `/api/v1/trash/folders/{fid}/restore` | `restore_folder` | 待迁移 |
| `backend/app/api/v1/trash.py` | `POST` | `/api/v1/trash/{fid}/restore` | `restore_file` | 待迁移 |
| `backend/app/api/v1/undo.py` | `GET` | `/api/v1/undo/preview` | `preview_undo` | 待迁移 |
| `backend/app/api/v1/undo.py` | `POST` | `/api/v1/undo/` | `undo` | 待迁移 |
| `backend/app/api/v1/undo.py` | `POST` | `/api/v1/undo/redo` | `redo` | 待迁移 |
| `backend/app/api/v1/user_bots.py` | `DELETE` | `/api/v1/me/bots/{bot_id}` | `delete_my_bot` | 待迁移 |
| `backend/app/api/v1/user_bots.py` | `DELETE` | `/api/v1/me/bots/{bot_id}/qq-binding` | `unbind_qq_identity` | 待迁移 |
| `backend/app/api/v1/user_bots.py` | `GET` | `/api/v1/me/bots/` | `list_my_bots` | 待迁移 |
| `backend/app/api/v1/user_bots.py` | `POST` | `/api/v1/me/bots/` | `create_my_bot` | 待迁移 |
| `backend/app/api/v1/user_bots.py` | `POST` | `/api/v1/me/bots/{bot_id}/qq-binding-code` | `create_qq_binding_code` | 待迁移 |
| `backend/app/api/v1/user_bots.py` | `PUT` | `/api/v1/me/bots/{bot_id}` | `update_my_bot` | 待迁移 |
| `backend/app/api/v1/user_skills.py` | `DELETE` | `/api/v1/skills/{skill_id}` | `delete_skill` | 待迁移 |
| `backend/app/api/v1/user_skills.py` | `GET` | `/api/v1/skills/` | `list_skills` | 待迁移 |
| `backend/app/api/v1/user_skills.py` | `GET` | `/api/v1/skills/tools` | `list_skill_tools` | 待迁移 |
| `backend/app/api/v1/user_skills.py` | `PATCH` | `/api/v1/skills/{skill_id}` | `update_skill` | 待迁移 |
| `backend/app/api/v1/user_skills.py` | `POST` | `/api/v1/skills/` | `create_skill` | 待迁移 |
| `backend/app/api/v1/users_admin.py` | `DELETE` | `/api/v1/admin/users/{user_id}` | `delete_user` | 待迁移 |
| `backend/app/api/v1/users_admin.py` | `GET` | `/api/v1/admin/users/` | `list_users` | Node Host 已接入并受 Admin guard 保护；devserver行为测试4/4、Vite未认证401；Python最近邻9/9（无直接列表回归），真实PG未验收 |
| `backend/app/api/v1/users_admin.py` | `GET` | `/api/v1/admin/users/risk` | `list_risk_users` | Node Host 已接 Admin guard + PostgreSQL query adapter；Python 最近邻 3/3、Node route/domain/Host 6/6、Vite 未认证 401；真实 PG 查询未验收 |
| `backend/app/api/v1/users_admin.py` | `GET` | `/api/v1/admin/users/{user_id}/security-events` | `list_user_security_events` | Node Host 已接可信 Admin guard 与 PG query；Vite 未认证401；真实PG未验收 |
| `backend/app/api/v1/users_admin.py` | `PATCH` | `/api/v1/admin/users/{user_id}/ban` | `toggle_ban` | 待迁移 |
| `backend/app/api/v1/users_admin.py` | `PATCH` | `/api/v1/admin/users/{user_id}/developer` | `toggle_developer` | 待迁移 |
| `backend/app/api/v1/users_admin.py` | `PATCH` | `/api/v1/admin/users/{user_id}/quota` | `update_quota` | 待迁移 |
| `backend/app/api/v1/users_admin.py` | `POST` | `/api/v1/admin/users/{user_id}/suspend` | `suspend_user` | Node Host已挂载Admin guard；事务更新状态/security_version，提交后发布auth-state并写审计；Python最近邻3/3为service级；真实PG未验收 |
| `backend/app/api/v1/users_admin.py` | `POST` | `/api/v1/admin/users/{user_id}/unsuspend` | `unsuspend_user` | Node Host已挂载Admin guard；事务清除冻结状态并递增security_version，提交后发布auth-state并写审计；真实PG未验收 |
| `backend/app/api/v1/wechat_connect.py` | `GET` | `/api/v1/me/wechat/connect/{task_id}` | `poll` | 待迁移 |
| `backend/app/api/v1/wechat_connect.py` | `POST` | `/api/v1/me/wechat/connect/` | `start` | 待迁移 |
| `backend/app/api/v1/workspace_migration_admin.py` | `POST` | `/api/v1/admin/workspace-migration/scan` | `scan_legacy_shell_directories_view` | 待迁移 |
| `backend/app/api/v1/workspaces.py` | `DELETE` | `/api/v1/workspace-directories/{directory_id}` | `delete_workspace_directory_view` | Node route、PostgreSQL adapter 与 Host 已接入；Host 从认证 RequestContext 取 owner，并注入 `prepareDirectoryAcl` 与共享 sandboxd PTY terminator；Python 模块 12/12；devserver Node workspace/Host 回归 30 passed；Workspace PostgreSQL 隔离 schema 集合 6/6 通过 |
| `backend/app/api/v1/workspaces.py` | `GET` | `/api/v1/workspace-directories` | `list_workspace_directory_view` | Node route、PostgreSQL adapter 与 Host 已接入；未认证在读 owner/数据前拒绝；本地 ACL adapter 已注入；Python 模块 12/12；devserver Node workspace/Host 回归 30 passed，Workspace PostgreSQL 隔离 schema 集合 6/6 通过 |
| `backend/app/api/v1/workspaces.py` | `GET` | `/api/v1/workspace-directories/{directory_id}/delete-preview` | `preview_workspace_directory_delete` | Node route、PostgreSQL adapter 与 Host 已接入；devserver route/Host 回归通过，Workspace PostgreSQL 隔离 schema 集合 6/6 通过 |
| `backend/app/api/v1/workspaces.py` | `PATCH` | `/api/v1/workspace-directories/{directory_id}` | `update_workspace_directory_view` | Node route、PostgreSQL adapter 与 Host 已接入；devserver route/Host 回归通过，Workspace PostgreSQL 隔离 schema 集合 6/6 通过 |
| `backend/app/api/v1/workspaces.py` | `POST` | `/api/v1/workspace-directories` | `create_workspace_directory_view` | Node route、PostgreSQL adapter 与 Host 已接入；本地 ACL adapter 已注入；devserver route/Host 回归通过，Workspace PostgreSQL 隔离 schema 集合 6/6 通过 |
| `backend/app/api/v1/workspaces.py` | `DELETE` | `/api/v1/workspaces/binding/{session_id}` | `unbind_workspace` | Node 已接入 Host；devserver 路由与 PG 行为回归通过 |
| `backend/app/api/v1/workspaces.py` | `DELETE` | `/api/v1/workspaces/{workspace_id}` | `remove_workspace` | Node Host 已接入 PostgreSQL adapter；devserver Vite 未认证请求返回 401，确认路由受认证保护；Python 基线 3/3，Node adapter/PG 专测已编写但未运行，外键级联与真实 PG 行为未验收 |
| `backend/app/api/v1/workspaces.py` | `GET` | `/api/v1/workspaces/` | `list_workspaces` | Node 已接入认证 Host 与 PostgreSQL lister；Node sandbox readiness 暂时 fail-closed；隔离 PostgreSQL 行为未验收 |
| `backend/app/api/v1/workspaces.py` | `GET` | `/api/v1/workspaces/session/{session_id}` | `current_workspace` | Node 已接入 Host；devserver 路由与 PG 行为回归通过 |
| `backend/app/api/v1/workspaces.py` | `PATCH` | `/api/v1/workspaces/{workspace_id}` | `edit_workspace` | Node 已接入认证 Host 与 PostgreSQL updater；本轮隔离 PostgreSQL 行为测试因未配置测试库跳过 |
| `backend/app/api/v1/workspaces.py` | `POST` | `/api/v1/workspaces/` | `add_workspace` | Node 已接入；devserver 行为与 PG 已验收 |
| `backend/app/api/v1/workspaces.py` | `POST` | `/api/v1/workspaces/{workspace_id}/bind/{session_id}` | `bind_workspace` | Node 已接入 Host；devserver 路由与 PG 行为回归通过 |


## Node 已接入路由的实现与回归位置

| method/path | 实现 | 主要回归 |
| --- | --- | --- |
| `GET /api/v1/site-config` | `gugu-webui/src/app.ts`, `src/domains/site/routes/site-config.ts`, `src/domains/site/site-config.ts` | `tests/site/site-config-route.test.ts`, `tests/host/config.test.ts` |
| `POST /api/v1/track` | `gugu-webui/src/app.ts`, `src/domains/site/persistence/track.ts` | `tests/site/track-route.test.ts`, isolated PostgreSQL integration |
| `GET /api/v1/notifications`, `GET /api/v1/notifications/bubble`, `POST /api/v1/notifications/read`, `DELETE /api/v1/notifications` | `gugu-webui/src/app.ts`, `src/domains/notifications/persistence/notifications.ts` | `tests/host/notifications-route.test.ts`, isolated PostgreSQL integration |
| `POST /api/v1/auth/login` | `gugu-webui/src/app.ts`, `src/domains/auth/routes/auth.ts`, `src/domains/auth/auth.ts`, `src/domains/auth/persistence/users.ts` | `tests/auth/auth-login.test.ts`, isolated PostgreSQL integration (bcrypt, activity event, token) |
| `POST /api/v1/auth/logout` | `gugu-webui/src/app.ts`, `src/domains/auth/routes/auth-logout.ts`, `src/domains/auth/persistence/auth-revocation.ts`, `src/adapters/redis-events.ts` | `tests/auth/auth-logout.test.ts`, `tests/auth/auth-revocation.test.ts` (isolated PostgreSQL; committed revocation before best-effort notification) |
| `PATCH /api/v1/auth/profile` | `gugu-webui/src/app.ts`, `src/domains/auth/routes/auth-profile.ts`, `src/adapters/redis-events.ts` | `tests/auth/auth-profile.test.ts`, `tests/host/write-routes.test.ts` (isolated PostgreSQL; timezone revision and password version/cookie renewal) |
| `GET /api/v1/auth/me` | `gugu-webui/src/app.ts`, `src/domains/auth/routes/auth.ts`, `src/domains/auth/auth.ts`, `src/domains/auth/persistence/users.ts` | `tests/auth/auth-route.test.ts`, PostgreSQL integration |
| `GET /api/v1/projects`, `GET /api/v1/projects/{pid}`, `GET /api/v1/projects/file-counts` | `gugu-webui/src/app.ts`, `src/domains/projects/persistence/projects.ts` | `tests/projects/projects-route.test.ts`, PostgreSQL integration |
| `POST /api/v1/projects` | `gugu-webui/src/app.ts`, `src/domains/projects/application/project-create.ts`, `src/domains/projects/persistence/project-create-postgres.ts`, `src/domains/projects/persistence/project-post-commit-postgres.ts` | `tests/host/write-routes.test.ts`, `tests/projects/project-create.test.ts`, `tests/projects/project-create-wire-fields.test.ts`, `tests/projects/project-post-commit.test.ts`, `tests/projects/project-create-postgres.test.ts`; Python recent-neighbor create idempotency baseline 1 passed; devserver project-domain suite 55 passed; isolated PostgreSQL project integrations 4/4 passed (including idempotency/Undo); context revision, durable RAG job enqueue and live notification are connected. |
| `GET /api/v1/clients`, `POST /api/v1/clients`, `DELETE /api/v1/clients/{cid}` | `gugu-webui/src/app.ts`, `src/domains/clients/routes/clients.ts`, `src/domains/clients/persistence/clients.ts` | `tests/clients/clients-route.test.ts`, PostgreSQL integration. Signed integer path compatibility was matched to a synthetic FastAPI probe and Python shared-storage/owner/rollback tests (2/2); the new Node route case remains unrun in this continuation, and values outside JS safe-integer range remain a known Python parity gap. |
| `GET /api/v1/events`, `GET /api/v1/events/{event_id}` | `gugu-webui/src/app.ts`, `src/domains/calendar/persistence/events.ts` | `tests/calendar/events-route.test.ts`, PostgreSQL integration |
| `POST /api/v1/events` | `gugu-webui/src/app.ts`, `src/domains/calendar/application/event-create.ts`, `src/domains/calendar/persistence/event-create-postgres.ts`, `calendar-create-post-commit-postgres.ts` | `tests/host/write-routes.test.ts`, `tests/calendar/event-create.test.ts`, `tests/calendar/event-create-postgres.test.ts`, `tests/calendar-create-post-commit*.test.ts` (事务、幂等、Undo、context revision、持久 RAG coalescing 和 live event；devserver 隔离 schema PostgreSQL 通过) |
| `DELETE /api/v1/events/{eid}` | `gugu-webui/src/app.ts`, `src/domains/calendar/application/event-delete.ts`, `src/domains/calendar/persistence/event-delete-postgres.ts`, `src/domains/calendar/persistence/calendar-mutation-post-commit-postgres.ts` | `tests/host/write-routes.test.ts`, `tests/calendar/event-delete-postgres.test.ts`, `tests/calendar/calendar-mutation-post-commit.test.ts`, `tests/calendar/calendar-mutation-post-commit-postgres.test.ts` (软删、停提醒、Undo、提交后 live event/context revision/RAG 入队；devserver 隔离 schema PostgreSQL 通过) |
| `POST /api/v1/workspaces` | `gugu-webui/src/app.ts`, `src/domains/workspaces/persistence/workspace-create.ts` | `tests/host/write-routes.test.ts`, `tests/workspaces/workspace-create-postgres.test.ts` (isolated PostgreSQL; kind relations and owner isolation) |
| `POST /api/v1/admin/auth/login`, `GET /api/v1/admin/auth/me`, `POST /api/v1/admin/auth/logout` | `gugu-webui/src/app.ts`, `src/domains/admin/admin-auth.ts`, `src/http/admin-host-guard.ts`, `src/adapters/redis-events.ts` | `tests/admin/admin-auth.test.ts`, `tests/admin/admin-host.test.ts`, `tests/workers/redis-events.test.ts` (version store uses fake RESP; real Redis not exercised) |
| `GET /api/v1/admin/ops/storage-snapshots` | `gugu-webui/src/app.ts`, `src/domains/admin/admin-storage-snapshots.ts`, `src/main.ts` | `tests/admin/admin-storage-snapshots.test.ts`, `tests/admin/admin-host.test.ts`, `tests/persistence/database.test.ts` (PG route integration skipped without isolated DB URL) |
| `PATCH /api/v1/events/{eid}` | `gugu-webui/src/domains/calendar/routes/events.ts`, `src/domains/calendar/application/event-update.ts`, `src/domains/calendar/persistence/event-update-postgres.ts`, `src/domains/calendar/persistence/calendar-mutation-post-commit-postgres.ts` | `tests/calendar/events-route.test.ts`, `tests/calendar/event-update-postgres.test.ts`, `tests/calendar/calendar-mutation-post-commit.test.ts`, `tests/calendar/calendar-mutation-post-commit-postgres.test.ts` (CAS、提醒、Undo、提交后 live event/context revision/RAG 入队；devserver 隔离 schema PostgreSQL 通过) |
| `POST /api/v1/workspaces/{workspace_id}/bind/{session_id}`, `DELETE /api/v1/workspaces/binding/{session_id}`, `GET /api/v1/workspaces/session/{session_id}` | `gugu-webui/src/domains/workspaces/routes/workspaces.ts`, `src/domains/workspaces/persistence/workspace-bindings.ts` | `tests/workspaces/workspace-bindings.test.ts` (owner isolation, OSS gate, disabled workspace and isolated PostgreSQL) |
| `GET /api/v1/workspaces` | `gugu-webui/src/app.ts`, `src/domains/workspaces/routes/workspaces.ts`, `src/domains/workspaces/persistence/workspace-list.ts` | `tests/workspaces/workspace-list-host.test.ts`, `tests/workspaces/workspace-list-route.test.ts`, `tests/workspaces/workspace-list-postgres.test.ts` (PG integration skipped without isolated DB URL) |
| `PATCH /api/v1/workspaces/{workspace_id}` | `gugu-webui/src/app.ts`, `src/domains/workspaces/routes/workspaces.ts`, `src/domains/workspaces/persistence/workspace-update.ts` | `tests/workspaces/workspace-update-host.test.ts`, `tests/workspaces/workspace-update-route.test.ts`, `tests/workspaces/workspace-update-postgres.test.ts` (PG integration skipped without isolated DB URL) |
| `DELETE /api/v1/workspaces/{workspace_id}` | `gugu-webui/src/app.ts`, `src/domains/workspaces/routes/workspaces.ts`, `src/domains/workspaces/persistence/workspace-delete.ts`, `src/main.ts` | `tests/workspaces/workspace-delete-route.test.ts`, `tests/workspaces/workspace-delete.test.ts`, `tests/workspaces/workspace-delete-postgres.test.ts`; Vite unauthenticated smoke returned 401. Python baseline 3/3; Node SQL/FK and real PostgreSQL behavior remain unverified. |

## 更新规则

- **2026-11-13 原生回归复核**：Python `backend/tests/platform/security/test_ownership_security_events.py` 在 devserver 串行 3/3；Node 26.13.1 原生运行 `tests/admin/admin-audit-log.test.ts tests/admin/admin-user-security-events.test.ts` 8/8。Python 基线只覆盖安全事件记录/HMAC，不覆盖两个 GET handler；Node 测试使用 query adapter 替身。Vite 上 `/api/v1/admin/audit-log/security-events` 与 `/api/v1/admin/users/{user_id}/security-events` 均为 404，Host 未注册；隔离 PG 环境变量未设置，SQL/列/排序真实行为未验收。模块不计入已接入路由数。
- 迁移接口时先补 route contract 与隔离 PostgreSQL 回归，并在 devserver 验收后再更新状态。
- 单独列出仍由 Python 完成的完整副作用（幂等、Undo、事件、存储、Worker）；不能把仅路由可访问标成行为等价。
- `/api/v1/auth/login` 的 Node 固定窗口限流已接 Redis command adapter，配置 `GUGU_WEBUI_REDIS_URL` 时可跨进程共享；未配置或 Redis 故障时兼容地 fail-open。登录限流与 Python 的共享能力仍需真实 Redis 环境验收。
- Node Admin 登录/注销/当前用户与存储快照路由已挂载 Host；Admin auth version store 要求 Redis，未配置时按 Python 语义返回 503。Admin 登录限流复用共享 Redis 固定窗口 adapter；快照 Local 磁盘统计只在进程内使用 storage path，不在响应或日志暴露路径。
- 只有所有 Web 必需 HTTP、SSE、静态资源和后台调用方均有等价实现与实机证据后，才推进默认 Node Web 切换。
