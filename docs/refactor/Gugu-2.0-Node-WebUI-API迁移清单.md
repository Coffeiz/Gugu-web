# Gugu 2.0 Node WebUI API 迁移清单

> 更新：2026-11-14。以 `backend/app/api/v1/` 的 FastAPI 路由声明为来源，按运行时 `/api/v1` 挂载和 Agent 子路由前缀展开。`Node 已接入`只表示对应 HTTP method/path 已注册；显式不可用响应不代表业务行为已迁移，标注 devserver 行为与 PostgreSQL 验收的接口另有对应回归证据。

> **当前 2.0 范围**：Linux/NAS 自托管只支持 Local 文件存储。Node WebUI 不迁移 OSS/S3 在线存储路径；下文历史记录中“OSS callback/对象搬移待接入”等事项已被该决定取代，不再作为 Node 迁移缺口。Local 行为回归已完成；旧版 OSS 数据迁移/导出仍须单独实现与验收。SaaS 和独立备份目标不在此范围内。

> **项目/日历复验边界**：最新共享树在 devserver Node 26.13.1 下，项目/日历 Node、PG 和两条认证 Vite 集成路径 `105/105` 通过、0 失败、0 跳过，随机测试 schema 清理后残留 `0`；Python 对照 10 个项目、Undo、幂等和日历文件用例 `66/66` 通过，typecheck 通过。此前未注入测试连接变量的探测为 `76 passed / 29 skipped / 0 failed`，不计数据库验收；后续测试从只读运行配置在子进程内提供连接，没有修改配置。提交后 context/live 通知失败时，Node 保持 best-effort 成功响应，而 Python 部分路由可能在已提交后返回 500；该错误路径差异已记录，不据此宣称完全兼容。项目过期清理仍由 Python Worker 承担，Redis 跨进程广播与 Node durable RAG job 的 Python Worker 消费仍未验收。详见 `docs/devlog/2026-11-14-Node-WebUI项目日历当前树复验.md`。

## 当前状态

- 路由逐项状态以本页下方的源路由表为准；旧的 `390/49/341` 快照已过期，不用于计算当前完成率。
- Node 接入仅表示 method/path 已注册；行为兼容、真实 PostgreSQL/Redis、文件系统及后台 Worker 验收分别记录，不能用未认证 `401` 或 Python 基线通过代替。
- 2.0 Linux/NAS 仅支持 Local 文件存储。OSS/S3 在线 API 不迁入；旧 OSS 数据迁移/导出仍需在切换前完成。
- 当前树项目与日历验收见顶部边界说明及 devlog：两条认证 Vite→生产 Host→随机隔离 schema 集成验证项目 PATCH、DELETE/restore、Local 文件往返与日历创建。项目过期清理、提交后通知故障响应差异、Redis 跨进程广播和 Python Worker 消费仍未验收。
- 细节与历史结果放在对应 [devlog](../devlog/README.md)，本页不重复按日期记录。

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
| `backend/app/api/v1/agent_routes/chat.py` | `POST` | `/api/v1/agent/chat` | `chat` | 待迁移；2026-11-14 devserver Vite 空 JSON 探测仍为 404，当前 Node Host 无聊天生成路由。Python 聊天/stream/resume/queue/session events/cancel 基线本轮 257/257；RunStore 对照 `test_run_finalize.py` 与 `test_message_area.py` 另复跑 28/28。PostgreSQL RunStore adapter 与 lease/checkpoint/event/interaction receipt Alembic migration 已增加；当前 Node 行为测试 6/6，PG 集成 1 项因缺少测试 URL 跳过；history writer callback 现在可读取提交 checkpoint 中的 usage。定向 TypeScript 检查和当前全量 WebUI typecheck 通过；未应用 migration。Provider/Context、history writer 生产实现、实际生成、取消及 SSE 恢复和 Host 接线仍缺，不能以持久化 adapter 代替聊天迁移。详见 `docs/devlog/2026-11-14-Node-Agent-RunStore持久化基础.md` |
| `backend/app/api/v1/agent_routes/chat.py` | `POST` | `/api/v1/agent/sessions/{session_id}/cancel` | `cancel_stream` | Node Core Redis `CancellationPort` 适配器已实现 owner/session/run 精确隔离、300 秒持久标记及先写标记后发布通知；devserver Node Redis 命令/取消端口回归 13/13、0 跳过，WebUI typecheck 通过，Python `test_run_cancellation.py` 11/11。尚未接入生产 Host/取消路由；未验收真实 Redis 与 Vite→Host，详见 `docs/devlog/2026-11-14-Node-Agent-Runs取消Redis端口.md` |
| `backend/app/api/v1/agent_routes/interactions.py` | `GET` | `/api/v1/agent/interactions/{prompt_id}/session` | `get_interaction_session` | Node Host 已接认证上下文与 owner-scoped PostgreSQL lookup；devserver Node route/adapter/Host 合集 29 通过、0 失败、2 跳过（PG 因未配置隔离库）；Python secret-link 基线 1/1；Vite 未认证请求 401。真实 PG 查询未验收，详见 `docs/devlog/2026-11-14-Node-Agent凭据交互深链Host接入.md` |
| `backend/app/api/v1/agent_routes/interactions.py` | `POST` | `/api/v1/agent/interactions/{prompt_id}/respond` | `respond_interaction` | 待迁移 |
| `backend/app/api/v1/agent_routes/interactions.py` | `POST` | `/api/v1/agent/interactions/{prompt_id}/resume` | `resume_interaction` | 待迁移 |
| `backend/app/api/v1/agent_routes/interactions.py` | `POST` | `/api/v1/agent/interactions/{prompt_id}/resume-text` | `resume_text_interaction` | 待迁移 |
| `backend/app/api/v1/agent_routes/interactions.py` | `POST` | `/api/v1/agent/interactions/{prompt_id}/secrets` | `submit_secret_interaction` | 待迁移 |
| `backend/app/api/v1/agent_routes/interactions.py` | `POST` | `/api/v1/agent/interactions/{prompt_id}/secrets/cancel` | `cancel_secret_interaction` | 待迁移 |
| `backend/app/api/v1/agent_routes/misc.py` | `DELETE` | `/api/v1/agent/memory` | `clear_memory` | 待迁移 |
| `backend/app/api/v1/agent_routes/misc.py` | `GET` | `/api/v1/agent/commands` | `get_commands` | Node `agent-misc` 已接认证 Host；commands/ui-labels/tool-event-details 相关 Node 回归 21 通过、2 个隔离 PG 用例跳过；Python commands 基线 65/65；Vite 未认证 401 |
| `backend/app/api/v1/agent_routes/misc.py` | `GET` | `/api/v1/agent/greeting` | `get_greeting` | 待迁移 |
| `backend/app/api/v1/agent_routes/misc.py` | `GET` | `/api/v1/agent/ui-labels` | `get_ui_labels` | Node `agent-misc` 已接认证 Host，每次请求读取状态标签覆盖配置；Node/ Python/Vite 证据同 `/agent/commands` |
| `backend/app/api/v1/agent_routes/misc.py` | `GET` | `/api/v1/agent/voice-availability` | `get_voice_availability` | 待迁移；Python 依赖基线2/2；Node 缺 BYOK 凭据解密/密钥版本、Provider URL resolver 与 VoiceSettings，Host 契约待提供 |
| `backend/app/api/v1/agent_routes/pending_queue.py` | `GET` | `/api/v1/agent/pending-queues/imported-drafts` | `list_imported_draft_queues` | Node Host 已接认证与 owner-scoped PostgreSQL reader；pending queue/Host 回归合计 34 通过、0 失败、5 个隔离 PG 用例跳过；Python pending queue 基线 13/13。 |
| `backend/app/api/v1/agent_routes/pending_queue.py` | `GET` | `/api/v1/agent/pending-queues/{queue_id}` | `get_pending_queue_by_id` | Node Host 已接认证与 owner-scoped PostgreSQL reader；读取时隐藏 claim 凭据；pending queue/Host 回归合计 34 通过、0 失败、5 个隔离 PG 用例跳过；Python 基线 13/13。 |
| `backend/app/api/v1/agent_routes/pending_queue.py` | `PATCH` | `/api/v1/agent/pending-queues/{queue_id}` | `patch_session_pending_queue` | Node Host 已接 owner-scoped PostgreSQL 增量更新，保留并发 claim lease，仅发布队列元数据；pending queue/Host 回归合计 34 通过、0 失败、5 个隔离 PG 用例跳过；Python 基线 13/13。 |
| `backend/app/api/v1/agent_routes/pending_queue.py` | `POST` | `/api/v1/agent/pending-queues/{queue_id}/items/{item_key}/claim` | `claim_session_pending_queue_item` | Node Host 已接 owner-scoped PostgreSQL 行锁 claim 与活动会话检查；pending queue/Host 回归合计 34 通过、0 失败、5 个隔离 PG 用例跳过；Python 基线 13/13。 |
| `backend/app/api/v1/agent_routes/pending_queue.py` | `POST` | `/api/v1/agent/pending-queues/{queue_id}/items/{item_key}/release` | `release_session_pending_queue_item` | Node Host 已接 token 校验释放与提交后元数据事件；pending queue/Host 回归合计 34 通过、0 失败、5 个隔离 PG 用例跳过；Python 基线 13/13。 |
| `backend/app/api/v1/agent_routes/pending_queue.py` | `PUT` | `/api/v1/agent/pending-queues/{queue_id}` | `update_draft_pending_queue` | Node Host 已接 owner-scoped PostgreSQL 草稿全量替换，拒绝 session 队列并支持空列表删除；校验与 Host 回归覆盖；pending queue/Host 回归合计 34 通过、0 失败、5 个隔离 PG 用例跳过；Python 基线 13/13。 |
| `backend/app/api/v1/agent_routes/sandbox.py` | `POST` | `/api/v1/agent/sandbox/clear` | `clear_my_sandbox` | 待迁移 |
| `backend/app/api/v1/agent_routes/sandbox.py` | `POST` | `/api/v1/agent/sandbox/rebuild` | `rebuild_my_sandbox` | 待迁移 |
| `backend/app/api/v1/agent_routes/sandbox.py` | `POST` | `/api/v1/agent/sandbox/restart` | `restart_my_sandbox` | 待迁移 |
| `backend/app/api/v1/agent_routes/sessions.py` | `DELETE` | `/api/v1/agent/sessions/{session_id}` | `delete_session` | 待迁移 |
| `backend/app/api/v1/agent_routes/sessions.py` | `DELETE` | `/api/v1/agent/sessions/{session_id}/filesystem-authorization` | `revoke_session_filesystem_authorization` | Node 已接认证 Host、owner-scoped PostgreSQL 撤销、脱敏安全事件及交互 PTY 终止；session 授权 Node/Redis/Vite 集成 9/9、Python 基线 75/75、typecheck 通过，真实 Redis 与随机 PostgreSQL schema 已验收；详见 `docs/devlog/2026-11-14-Node-Agent会话文件系统授权.md` |
| `backend/app/api/v1/agent_routes/sessions.py` | `GET` | `/api/v1/agent/messages/{message_id}` | `get_message_location` | 当前树已挂 Node 认证 Host 与 owner-scoped PostgreSQL locator；devserver route 3/3、Host 会话域 suite 23 通过/0 失败/1 隔离 PG 跳过，Python Agent 消息基线 59/59（未直接覆盖该 endpoint），Vite 未认证请求 401；locator 的真实 PG 集成因无隔离库跳过，详见 `docs/devlog/2026-11-14-Node-Agent消息定位路由Host状态核验.md` |
| `backend/app/api/v1/agent_routes/sessions.py` | `GET` | `/api/v1/agent/sessions` | `list_sessions` | Node Host 已挂载认证与 owner-scoped PostgreSQL lister；Python `test_session_badges.py`/`test_session_display_order.py` 基线已跑，Node sessions/history/Host 回归 28/28（0 跳过）。Vite 未认证请求为 401；认证 Vite→Host→随机 PG schema 集成 1/1 验证伪造 owner 参数无效且仅返回当前用户会话。session 时间微秒边界仍需补测 |
| `backend/app/api/v1/agent_routes/sessions.py` | `GET` | `/api/v1/agent/sessions/{session_id}/messages` | `get_session_messages` | Node Host 已挂载认证、owner-scoped 历史 adapter 与孤儿 run 回收；群聊正文/引用中的已知 @ ID 按会话最新昵称、当前 Bot 名称或用户自有 Bot 配置名替换，未知 ID 保持原样。Python `test_agent_api_messages.py` 全文件 59/59（含群聊 mention 6 项）；本轮 Node 历史/mention/恢复/Host 定向套件 10 通过、0 失败、2 个隔离 PG 用例因缺测试库跳过，typecheck 通过。先前 Vite→Host→随机 PG 认证读取/恢复集成 1/1 不覆盖本次 mention；真实 Redis 未验收。legacy timeline 迁移与 chat/SSE 仍待迁移 |
| `backend/app/api/v1/agent_routes/sessions.py` | `GET` | `/api/v1/agent/sessions/{session_id}/tool-event-details` | `get_session_tool_event_details` | 已接 Node 认证 Host，按 owner/会话/消息定位并投影响应；与 Agent commands/ui-labels 合并回归 21 通过、2 个隔离 PG 用例跳过；Python 基线 3/3；Vite 未认证 401 |
| `backend/app/api/v1/agent_routes/sessions.py` | `PATCH` | `/api/v1/agent/sessions/{session_id}` | `rename_session` | Node 已接认证 Host 与 owner-scoped PostgreSQL updater；devserver Python `test_scheduled_task_execution.py` 20/20（改名相关用例 2/2），Node route+随机 schema PostgreSQL+Host 回归 21/21、0 跳过，typecheck 通过；Vite 未认证请求 401。尚未用认证请求通过 Vite 验收真实数据库写入；Agent `POST /chat`/SSE 执行链仍未迁移 |
| `backend/app/api/v1/agent_routes/sessions.py` | `POST` | `/api/v1/agent/sessions/{session_id}/filesystem-authorization` | `confirm_session_filesystem_authorization` | Node 已接认证 Host、一次性 Redis 确认码兑换、owner-scoped PostgreSQL 授权及脱敏安全事件；session 授权 Node/Redis/Vite 集成 9/9、Python 基线 75/75、typecheck 通过，详见 `docs/devlog/2026-11-14-Node-Agent会话文件系统授权.md` |
| `backend/app/api/v1/agent_routes/sessions.py` | `POST` | `/api/v1/agent/sessions/{session_id}/filesystem-authorization/request` | `request_session_filesystem_authorization` | Node 已接认证 Host、Python 兼容确认码请求协议、功能开关与 owner-scoped PostgreSQL 审计；session 授权 Node/Redis/Vite 集成 9/9、Python 基线 75/75、typecheck 通过，详见 `docs/devlog/2026-11-14-Node-Agent会话文件系统授权.md` |
| `backend/app/api/v1/agent_routes/sessions.py` | `POST` | `/api/v1/agent/sessions/{session_id}/refresh-context` | `refresh_session_context` | Node 已挂载认证 Host 与 owner-scoped PostgreSQL refresher；route 3/3 通过、1 个隔离 PG 用例因未配置测试库跳过，Host 注入回归通过；Python snapshot 基线 1/1，Vite 未认证请求 401，typecheck 通过。真实 PG 写入未验收，详见 `docs/devlog/2026-11-14-Node-Agent会话上下文刷新Host接入.md` |
| `backend/app/api/v1/audit_log.py` | `GET` | `/api/v1/admin/audit-log/` | `list_audit_logs` | 待迁移 |
| `backend/app/api/v1/audit_log.py` | `GET` | `/api/v1/admin/audit-log/security-events` | `list_security_events` | Node Host 已接可信 Admin guard、PG query 与 Python-compatible HMAC user fingerprint；Vite 未认证401；真实PG未验收 |
| `backend/app/api/v1/auth.py` | `DELETE` | `/api/v1/auth/me` | `delete_my_account` | 待迁移 |
| `backend/app/api/v1/auth.py` | `GET` | `/api/v1/auth/avatar/{user_id}` | `get_avatar` | Node 已接公共头像读取与 PostgreSQL owner 元数据校验，仅读取 Local `avatars/` 下的受限相对路径并拒绝符号链接；devserver Vite→Node Host→随机 schema PG 集成确认上传后的公开读取字节、MIME 与缓存头；Python 头像基线 5/5；见 `docs/devlog/2026-11-13-Node-WebUI头像VitePG闭环.md` |
| `backend/app/api/v1/auth.py` | `GET` | `/api/v1/auth/me` | `me` | Node Host cookie 会话读取；Vite→Host→随机 PG schema 登录/会话/退出集成 1/1（0 跳过），Node login/me/logout 行为 9/9、PG 撤销/Vite 集成 2/2、Python Cookie/账户状态/撤销 pytest 11/11；typecheck 通过；见 `docs/devlog/2026-11-13-Node-WebUI登录会话Vite隔离PG闭环.md` |
| `backend/app/api/v1/auth.py` | `GET` | `/api/v1/auth/quota` | `get_quota` | Node 认证 Host 与 PostgreSQL reader 已接入，按 owner 查询平台 6h/周用量、BYOK 用户时区今日/月统计及完整输入缓存率；Python `test_auth_quota_cache_rate.py` 1/1，quota/trends Node 行为 5/5、隔离 schema PostgreSQL 1/1；auth/Host 回归 68 项（60 通过、0 失败、8 个隔离 DB 用例跳过，quota/trends PG 用例另行通过），类型检查通过。Vite 与直连 Node 未认证均返回 401 |
| `backend/app/api/v1/auth.py` | `GET` | `/api/v1/auth/usage/trends` | `get_usage_trends` | Node 复用认证 Host 注册链和 PostgreSQL reader；BYOK 1–90 天序列按用户时区归日并累计 `cache_write`。Python `test_usage_trends_user_tz.py` 1/1，Node 行为覆盖时区/owner/窗口/缓存写入，隔离 schema PostgreSQL 断言通过；Vite 与直连 Node 未认证均返回 401 |
| `backend/app/api/v1/auth.py` | `PATCH` | `/api/v1/auth/profile` | `update_profile` | Node 已接入；devserver 行为与 PG 已验收 |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/avatar` | `upload_avatar` | Node 已接用户认证、Host owner、MIME allowlist、5 MiB 限额及 Local 唯一文件名落盘/PG 元数据更新；devserver Node route/PG/Vite 回归 5/5、Python 上传/读取基线 5/5，0 跳过，typecheck 通过；Vite multipart 验证认证、媒体类型拒绝、替换与公开读取；见 `docs/devlog/2026-11-13-Node-WebUI头像VitePG闭环.md` |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/email-change/cancel` | `cancel_email_change` | Node 认证 Host 已接取消活跃申请；与 request/resend/verify 共用 PostgreSQL store。Node 单测、Vite Host 与 Python 邮箱基线通过；PostgreSQL 集成因无隔离测试库跳过；见 `docs/devlog/2026-11-13-Node-WebUI邮箱变更切片.md` |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/email-change/request` | `request_email_change` | Node Host 已接身份密码校验、邮箱规范化/占用检查、事务创建、SMTP 验证信和旧邮箱安全通知；用户偏好能力开关随系统邮件能力显示。Node/Vite 定向回归 16/16 通过；Python email/auth 安全基线 23/23；PG 集成 1 项跳过，真实 SMTP/Redis 未验收；见 `docs/devlog/2026-11-13-Node-WebUI邮箱变更切片.md` |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/email-change/resend` | `resend_email_change` | Node 认证 Host 已接限流、有效期检查和事务 token 轮换；旧 token 失效，邮件失败返回 503；Node/Vite 定向回归通过，PostgreSQL 集成未验收；见 `docs/devlog/2026-11-13-Node-WebUI邮箱变更切片.md` |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/email-change/verify` | `verify_email_change` | Node Host 已接公开 token 验证、用户锁、邮箱冲突检查、邮箱与 security_version 同事务更新、其它申请撤销和提交后会话失效通知；Node/Vite 定向回归通过，PostgreSQL 集成未验收；见 `docs/devlog/2026-11-13-Node-WebUI邮箱变更切片.md` |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/forgot-password` | `forgot_password` | Node Host 已接 SMTP/Redis 密码找回路由；掩码邮箱、枚举隐私、冷却、发送失败清理已覆盖。devserver Node/Vite 定向回归通过；Python 相关基线 21/21。隔离 PostgreSQL 集成因无测试库且 devserver 未安装原生 PG 服务端而未验收；见 `docs/devlog/2026-11-13-Node-WebUI密码找回重置切片.md` |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/login` | `login` | Node Host cookie 登录与公共用户响应；Vite→Host→随机 PG schema 登录/会话/退出集成 1/1（0 跳过），Node login/me/logout 行为 9/9、PG 撤销/Vite 集成 2/2、Python Cookie/账户状态/撤销 pytest 11/11；验证 HttpOnly access、CSRF cookie、web_login 持久事件及退出后旧会话失效；见 `docs/devlog/2026-11-13-Node-WebUI登录会话Vite隔离PG闭环.md` |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/logout` | `logout` | Node Host CSRF cookie 会话退出，security version PG 撤销、广播并清理认证 cookie；Vite 隔离 PG 集成确认旧会话失效；Node route+PG 定向回归通过，Python token revocation 基线通过；详见登录会话闭环 devlog |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/register` | `register` | Node Host 已接 PostgreSQL 注册事务、Redis 限流/验证码校验、Local 默认 Workspace ACL 和 onboarding seed；播种事务会幂等初始化 `file_library` 配额账本并使用用户/Host 默认额度。devserver Node 定向 auth/seed/file 回归与 Vite→Node Host→随机隔离 PG schema 注册集成共 26/26、0 跳过；Vite 路径实际创建用户、Cookie 会话、默认工作区、引导项目/活动/两份 Local 文件与配额事件，账本用量与文件字节一致；TypeScript 检查通过。Python 配额账本及 onboarding 状态基线 28/28；暂无直接覆盖 `onboarding.seed_for_user` 的 Python 注册集成用例。生产 `startServer` 注册组合根、真实 SMTP 与 Redis 跨进程共享仍未验收，详见 `docs/devlog/2026-11-14-Node-WebUI注册当前树复验.md` |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/registration-code` | `send_registration_code` | Node Host 已接 Redis code-store adapter 与系统 SMTP sender；注册码路由、SMTP sender 和 Host 定向回归 43/43，Python 注册安全/邮件能力/SMTP 相邻 pytest 20/20。Vite 合成空体返回 422，验证路由与代理；未发真实邮件。Redis 实时预留、真实 SMTP 投递、认证注册及 PostgreSQL 写入未验收 |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/reset-password` | `reset_password` | Node Host 已接一次性 token 认领、凭据事务更新、security_version 递增、提交后通知及认证 cookie 清除；token 写入失败会释放冷却键。devserver Node/Vite 定向回归通过；Python 相关基线 21/21。隔离 PostgreSQL 集成未验收；见 `docs/devlog/2026-11-13-Node-WebUI密码找回重置切片.md` |
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
| `backend/app/api/v1/clients.py` | `DELETE` | `/api/v1/clients/{cid}` | `delete_client` | Node Host owner-scoped Core/PostgreSQL；联系人路由 4/4、隔离 schema Host/PG 集成 1/1、Python Core 数据桥 pytest 3/3；含越权删除 404 与通知模块同库集成，Vite 未认证 401；见 `docs/devlog/2026-11-13-Node-WebUI联系人当前树回归.md` |
| `backend/app/api/v1/clients.py` | `GET` | `/api/v1/clients/` | `list_clients` | Node Host owner-scoped Core/PostgreSQL；联系人路由 4/4、隔离 schema Host/PG 集成 1/1、Python Core 数据桥 pytest 3/3；列表隔离与响应字段在隔离 schema 实测，Vite 未认证 401；见 `docs/devlog/2026-11-13-Node-WebUI联系人当前树回归.md` |
| `backend/app/api/v1/clients.py` | `POST` | `/api/v1/clients/` | `create_client` | Node Host owner-scoped Core/PostgreSQL；联系人路由 4/4、隔离 schema Host/PG 集成 1/1、Python Core 数据桥 pytest 3/3；创建字段/响应及不同 owner 隔离在隔离 schema 实测，Vite 未认证 401；见 `docs/devlog/2026-11-13-Node-WebUI联系人当前树回归.md` |
| `backend/app/api/v1/config.py` | `GET` | `/api/v1/admin/config/` | `read_config` | Node 已接入：读取兼容 `config.override.json` 配置，敏感值脱敏 |
| `backend/app/api/v1/config.py` | `GET` | `/api/v1/admin/config/embedding-rebuild/status` | `embedding_rebuild_status` | 待迁移 |
| `backend/app/api/v1/config.py` | `GET` | `/api/v1/admin/config/index-rebuild/status` | `index_rebuild_status` | 待迁移 |
| `backend/app/api/v1/config.py` | `GET` | `/api/v1/admin/config/memory-cleanup/status` | `memory_cleanup_status` | 待迁移 |
| `backend/app/api/v1/config.py` | `GET` | `/api/v1/admin/config/reconcile-storage` | `reconcile_storage` | 计划退役：旧 DB↔FS 对账仅兼容迁移期保留，不迁入 Node |
| `backend/app/api/v1/config.py` | `GET` | `/api/v1/admin/config/reconcile-storage/path-migration` | `scan_path_migration` | 计划退役：旧路径镜像迁移仅兼容迁移期保留，不迁入 Node |
| `backend/app/api/v1/config.py` | `GET` | `/api/v1/admin/config/reconcile-users` | `reconcile_users` | 计划退役：去除按存储目录缺失推断账号异常的扫描，不迁入 Node |
| `backend/app/api/v1/config.py` | `PATCH` | `/api/v1/admin/config/` | `update_config` | Node 已接入：原子写回兼容配置文件，保留未修改配置段；运行时配置重启后生效 |
| `backend/app/api/v1/config.py` | `POST` | `/api/v1/admin/config/embedding-rebuild` | `embedding_rebuild` | 待迁移 |
| `backend/app/api/v1/config.py` | `POST` | `/api/v1/admin/config/index-rebuild` | `index_rebuild` | 待迁移 |
| `backend/app/api/v1/config.py` | `POST` | `/api/v1/admin/config/init-db` | `init_db` | 待迁移 |
| `backend/app/api/v1/config.py` | `POST` | `/api/v1/admin/config/memory-cleanup/apply` | `memory_cleanup_apply` | 待迁移 |
| `backend/app/api/v1/config.py` | `POST` | `/api/v1/admin/config/memory-cleanup/preview` | `memory_cleanup_preview` | 待迁移 |
| `backend/app/api/v1/config.py` | `POST` | `/api/v1/admin/config/reconcile-storage/ghosts/repair` | `repair_ghost_records` | 计划退役：幽灵记录修复仅兼容迁移期保留，不迁入 Node |
| `backend/app/api/v1/config.py` | `POST` | `/api/v1/admin/config/reconcile-storage/path-migration/repair` | `repair_path_migration` | 计划退役：旧路径镜像修复仅兼容迁移期保留，不迁入 Node |
| `backend/app/api/v1/config.py` | `POST` | `/api/v1/admin/config/reconcile-storage/repair` | `reconcile_repair` | 计划退役：孤儿对象导入/删除仅兼容迁移期保留，不迁入 Node |
| `backend/app/api/v1/config.py` | `POST` | `/api/v1/admin/config/reconcile-users/repair` | `repair_users_without_storage` | 计划退役：不得按存储目录缺失删除账号，不迁入 Node |
| `backend/app/api/v1/config.py` | `POST` | `/api/v1/admin/config/test-connection` | `test_connection` | 部分接入：PostgreSQL/Redis；OSS 明确不支持 |
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
| `backend/app/api/v1/events.py` | `DELETE` | `/api/v1/events/{eid}` | `delete_event` | Node Host/PG adapter 已接入；当前树项目/日历及两条 Vite 集成套件 105/105 通过，Python 对照 10 个文件 66/66、typecheck 通过。日历 post-commit adapter 与生产组合根在随机隔离 schema 验证；Redis 实时广播与 RAG Worker 消费仍待验收，详见项目日历当前树复验 devlog |
| `backend/app/api/v1/events.py` | `GET` | `/api/v1/events/` | `list_events` | Node 已接入 |
| `backend/app/api/v1/events.py` | `GET` | `/api/v1/events/{eid}` | `get_event` | Node 已接入 |
| `backend/app/api/v1/events.py` | `PATCH` | `/api/v1/events/{eid}` | `update_event` | Node Host/PG adapter 已接入；当前树项目/日历及两条 Vite 集成套件 105/105 通过，Python 对照 10 个文件 66/66、typecheck 通过。日历 post-commit adapter 与生产组合根在随机隔离 schema 验证；Redis 实时广播与 RAG Worker 消费仍待验收，详见项目日历当前树复验 devlog |
| `backend/app/api/v1/events.py` | `POST` | `/api/v1/events/` | `create_event` | Node Host/PG adapter 已接入；事件、Undo 与 durable RAG job 同事务提交，提交后 best-effort 执行 context revision/live event。当前树项目/日历及两条 Vite 集成套件 105/105 通过，Python 对照 10 个文件 66/66、typecheck 通过；随机隔离 schema 验证事务与生产组合根写入。Redis 跨进程广播与 Python RAG Worker 消费仍待验收，详见项目日历当前树复验 devlog |
| `backend/app/api/v1/feedback.py` | `POST` | `/api/v1/feedback/` | `submit_feedback` | Node 认证 Host/PostgreSQL 持久化已接；管理员分页读取亦接入 Node；devserver Node 路由与随机 schema PG 回归 5/5、Python 邮件开关基线 2/2，typecheck 通过。Node SMTP sender 尚未迁移，经 Node 提交时不会发送邮件；见 `docs/devlog/2026-11-13-Node-WebUI反馈提交与管理读取迁移.md` |
| `backend/app/api/v1/feishu_connect.py` | `GET` | `/api/v1/me/feishu/connect/{poll_id}` | `poll` | 待迁移 |
| `backend/app/api/v1/feishu_connect.py` | `POST` | `/api/v1/me/feishu/connect/` | `start` | 待迁移 |
| `backend/app/api/v1/files.py` | `DELETE` | `/api/v1/files/{fid}` | `delete_file` | Local Host/认证 owner、PostgreSQL 软删、版本递增、文件移入回收站、Undo 状态和提交后资源事件已接入；devserver Node Host/路由/隔离 PG 文件回归 23/23，Python 回收站/文件 API 基线 53/53，Node typecheck 通过；Vite 未认证请求 401。部分迁移：缺 filesync path advisory lock，认证后的 Vite 删除未验收 |
| `backend/app/api/v1/files.py` | `GET` | `/api/v1/files/` | `list_file_page` | Node Host PostgreSQL 文件分页已接 owner/scope、过滤、加密游标；隔离 PG Node测试通过，Python 分页/归属基线 11/11，Vite 未认证401 |
| `backend/app/api/v1/files.py` | `GET` | `/api/v1/files/library-counts` | `file_library_counts` | Node Host/owner-scoped PostgreSQL adapter 已接入；devserver Vite/Host 与隔离 PostgreSQL 行为测试验证个人/项目/回收站计数及越权隔离，和 summary/storage 同组通过 |
| `backend/app/api/v1/files.py` | `GET` | `/api/v1/files/page` | `list_file_page` | 与 `/files/` 共用分页 Host/PG adapter；Node 路由测试通过 |
| `backend/app/api/v1/files.py` | `GET` | `/api/v1/files/storage` | `files_storage` | Node Host/owner-scoped PostgreSQL adapter 已接入；devserver 隔离 PostgreSQL 验证账本用量和用户配额；与文件读取回归同组通过 |
| `backend/app/api/v1/files.py` | `GET` | `/api/v1/files/summary` | `file_summary` | Node Host/owner-scoped PostgreSQL adapter 已接入；recent_limit 限制、owner 隔离和 Python camelCase 数据映射由 route/PG 回归覆盖；devserver 隔离 PostgreSQL 验证通过 |
| `backend/app/api/v1/files.py` | `GET` | `/api/v1/files/{fid}` | `get_file` | Node Host/owner-scoped PostgreSQL adapter 已接入；项目/文件夹关联字段与权限边界经 devserver 隔离 PostgreSQL 验证 |
| `backend/app/api/v1/files.py` | `GET` | `/api/v1/files/{fid}/download` | `download_file` | Local Host 已接入 owner-scoped PostgreSQL 元数据与安全文件流；devserver Node 文件域回归 37 通过、0 失败、1 个隔离 PG 用例跳过；Python 下载/流预览基线 17/17；Vite 未认证返回 401。认证后的真实 SQL/文件下载仍未端到端验收 |
| `backend/app/api/v1/files.py` | `GET` | `/api/v1/files/{fid}/location` | `get_file_location` | Node Host/owner-scoped PostgreSQL adapter 已接入；祖先同 scope 校验和路径响应经 devserver 隔离 PostgreSQL 验证 |
| `backend/app/api/v1/files.py` | `GET` | `/api/v1/files/{fid}/stream` | `stream_file` | Local 文件流已接入 Node Host；owner/scope 检查、字节范围和越界 symlink 拒绝由 Node 回归覆盖；测试结果与 `/download` 同组，未认证 Vite 请求为 401 |
| `backend/app/api/v1/files.py` | `GET` | `/api/v1/files/{fid}/stream-url` | `get_stream_url` | 签名流 URL 已接入 Node Host 并要求用户认证；Node 文件域回归与 Vite 未认证 401 已验证；未做认证后的真实文件读取验收 |
| `backend/app/api/v1/files.py` | `GET` | `/api/v1/files/{fid}/thumb` | `get_thumb` | 待迁移 |
| `backend/app/api/v1/files.py` | `GET` | `/api/v1/files/{fid}/xlsx-preview` | `xlsx_preview` | 待迁移 |
| `backend/app/api/v1/files.py` | `GET` | `/api/v1/files/{fid}/xlsx-preview-image/{image_id}` | `xlsx_preview_image` | 待迁移 |
| `backend/app/api/v1/files.py` | `PATCH` | `/api/v1/files/{fid}` | `update_file` | Local Node Host/认证 owner 与 PostgreSQL 元数据更新、Local 文件事务搬移、version CAS、Undo 和资源事件已接入；devserver Node 文件域 67/67，typecheck 通过，Python 文件 API 邻近基线 47/47 |
| `backend/app/api/v1/files.py` | `POST` | `/api/v1/files/` | `upload_file` | Local Node Host/认证 owner 与 PostgreSQL 上传/覆盖、配额账本、冲突处理和文件事务已接入；前端 proxy 上传主路径已补齐 presign 接线；devserver Node upload/presign 行为 5/5，Python `test_files_api.py` + `test_file_upload_service.py` 39/39，typecheck 通过；Vite/Node 未认证 presign 均为 401。真实 PG 文件写入未复验，OSS 上传路径不属于 2.0 |
| `backend/app/api/v1/files.py` | `POST` | `/api/v1/files/archive` | `create_archive` | Local Node Host 认证与 owner 隔离已接入；devserver Vite→Host→隔离 PostgreSQL 验证真实 ZIP 写入、正文与解压往返、配额事件和资源事件；归档定向回归 11/11、Python 基准 33/33、typecheck 通过，详见 `docs/devlog/2026-11-14-Node-WebUI文件归档Host验收.md` |
| `backend/app/api/v1/files.py` | `POST` | `/api/v1/files/batch-delete` | `batch_delete_files` | Local Node Host/认证 owner 与 PostgreSQL 单事务批量软删除已接入；排序 filesync 锁、统一 Undo 收据、提交后事件和失败物理补偿均有覆盖；devserver Node 文件域 63/63，Python 文件/Undo/分页路径基线 101/101，typecheck 通过 |
| `backend/app/api/v1/files.py` | `POST` | `/api/v1/files/batch-download` | `batch_download_files` | Local Node Host/认证 owner 与 PostgreSQL ZIP adapter 已接入；覆盖 owner 隔离、目录层级、正文和状态码；devserver Node 文件域 65/65（隔离 PostgreSQL、0 跳过），Python 压缩/解压基线 33/33，typecheck 通过；OSS 不在 2.0 范围 |
| `backend/app/api/v1/files.py` | `POST` | `/api/v1/files/check-conflicts` | `check_conflicts` | Local Node Host/认证 owner 与只读 PostgreSQL 冲突查询已接入，范围按 owner/空间/项目/文件夹/Workspace 精确隔离；Python 文件基准 91/91，devserver Node 文件域回归 60/60，typecheck 通过 |
| `backend/app/api/v1/files.py` | `POST` | `/api/v1/files/confirm` | `confirm_upload` | OSS 直传完成后的对象校验与数据库确认；2.0 Linux/NAS 为 Local-only，前端收到 proxy 后直接 multipart 上传，不调用此路由，不属于当前迁移范围 |
| `backend/app/api/v1/files.py` | `POST` | `/api/v1/files/presign` | `presign_upload` | Local-only Node Host 接入 Pydantic 兼容请求校验并返回 `{ mode: 'proxy' }`，不扫描存储、不写数据库；前端随后调用 `/files` 完成真实配额/ownership 校验与事务上传。devserver Node行为 5/5、Python `test_files_api.py` + `test_file_upload_service.py` 39/39、typecheck 通过；Vite 和直连 Node 未认证均返回 401。认证后 PG 上传未验收 |
| `backend/app/api/v1/files.py` | `POST` | `/api/v1/files/unarchive` | `unarchive_file` | Local Node Host 认证与 owner 隔离已接入；devserver Vite→Host→隔离 PostgreSQL 验证真实 ZIP 解压写入、路径树和文件正文；覆盖未认证拒绝与跨 owner 文件夹隔离。Node 归档定向回归 11/11、Python 基准 33/33、typecheck 通过，详见 `docs/devlog/2026-11-14-Node-WebUI文件归档Host验收.md` |
| `backend/app/api/v1/files.py` | `POST` | `/api/v1/files/{fid}/copy` | `copy_file` | Local Node Host/认证 owner 与 PostgreSQL 文件复制、重名处理、覆盖、配额事件、Undo 和资源事件已接入；devserver Node 文件域回归 58/58，Python 文件 API/service/Undo 基线 91/91，typecheck 通过。复制到自身保留 Python 的 Undo 与 `create` 事件语义；OSS 不属于 2.0 范围 |
| `backend/app/api/v1/files.py` | `POST` | `/api/v1/files/{fid}/resolve-paths` | `resolve_file_paths` | Local Node Host/认证 owner 与 PostgreSQL 相对路径解析已接入；限制请求路径预算、保护来源 scope/owner 并支持 URL 编码；devserver Node 文件域回归 62/62，Python 分页/路径基准 10/10，typecheck 通过 |
| `backend/app/api/v1/files.py` | `PUT` | `/api/v1/files/{fid}/content` | `update_file_content` | Local Host/认证 owner 与 PostgreSQL CAS、正文替换、Undo 附件和资源事件已接入；devserver Node Host/路由/隔离 PG 定向测试 19/19，Python 文件/Undo/filesync 邻近基线 172/172，Node typecheck/build 通过；Vite 未认证请求 401。部分迁移：缺 filesync path advisory lock 与 canonical change journal，认证后的 Vite 正文写入未验收 |
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
| `backend/app/api/v1/folders.py` | `GET` | `/api/v1/folders/` | `list_folder_page` | Node Host PostgreSQL 文件夹分页已接 owner/scope、直属计数与加密游标；隔离 PG Node测试通过，Python 分页/归属基线 11/11，Vite 未认证401 |
| `backend/app/api/v1/folders.py` | `GET` | `/api/v1/folders/page` | `list_folder_page` | 与 `/folders/` 共用分页 Host/PG adapter；Node 路由测试通过 |
| `backend/app/api/v1/folders.py` | `GET` | `/api/v1/folders/{fid}` | `get_folder` | Node Host/owner-scoped PostgreSQL adapter 已接入；文件数与认证/越权行为由 route 和文件库隔离 PG 回归覆盖 |
| `backend/app/api/v1/folders.py` | `GET` | `/api/v1/folders/{fid}/download` | `download_folder` | Local Node Host、owner-scoped PostgreSQL ZIP adapter 已接入；devserver 隔离 PG 验证目录层级、正文、越权隐藏及空文件夹；Node 文件域 67/67，Python 文件夹 API 基线 14/14，typecheck 通过；OSS 不在 2.0 范围 |
| `backend/app/api/v1/folders.py` | `GET` | `/api/v1/folders/{fid}/location` | `get_folder_location` | Node Host/owner-scoped PostgreSQL adapter 已接入；devserver 隔离 PG 验证祖先顺序、同 scope 与越权隔离 |
| `backend/app/api/v1/folders.py` | `PATCH` | `/api/v1/folders/{fid}` | `rename_folder` | Node Host/owner-scoped PostgreSQL adapter 已实现：version CAS、路径镜像迁移、Undo 与提交后事件；Node mock 回归通过。真实隔离 PG 未验收 |
| `backend/app/api/v1/folders.py` | `PATCH` | `/api/v1/folders/{fid}/parent` | `move_folder` | Node Host/owner-scoped PostgreSQL adapter 已实现：子树 scope 更新、循环/同名拒绝、路径镜像搬移、Undo 与提交后事件；Node mock 回归覆盖跨 scope/循环拒绝。真实隔离 PG 未验收 |
| `backend/app/api/v1/folders.py` | `POST` | `/api/v1/folders/` | `create_folder` | Node Host/owner-scoped PostgreSQL adapter 已实现：scope 校验、路径镜像物化、Undo 与提交后事件；Node mock 回归通过。真实隔离 PG 未验收 |
| `backend/app/api/v1/folders.py` | `POST` | `/api/v1/folders/resolve-paths` | `resolve_folder_paths` | Node Host/owner-scoped PostgreSQL adapter 已接入；请求预算、相对路径/URL 编码、父级归属与 scope 隔离由 route/PG 回归覆盖；devserver 文件域 67/67，Python 文件夹 API 14/14，typecheck 通过 |
| `backend/app/api/v1/folders.py` | `POST` | `/api/v1/folders/{fid}/copy` | `copy_folder` | 待迁移 |
| `backend/app/api/v1/live.py` | `GET` | `/api/v1/live/stream` | `stream_live_events` | Node Host 已接认证用户/广播频道 SSE、事件 allowlist 与字段裁剪、逐消息账号与 security version 复核、断连清理；Python Live/session pytest 23/23，Node Live/auth 定向 23 通过、0 失败、1 个隔离 PostgreSQL 集成用例跳过，typecheck 通过；Vite 未认证请求 401；真实 PostgreSQL/Redis Pub/Sub 未验收，见 `docs/devlog/2026-11-14-Node-WebUI-LiveSSEHost切片.md` |
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
| `backend/app/api/v1/mind.py` | `DELETE` | `/api/v1/mind/canvases/{cid}` | `delete_canvas` | Node Host 已接入 owner-scoped 画布/画布项/活动关系软删，保留全局便签节点，并在同一事务写入完整 Undo 快照；devserver Mind Node/Vite/隔离 PG 回归 51/51、Python Mind/Undo 基线 68/68、typecheck 通过；随机 schema 残留 0，见 Mind 画布删除切片 |
| `backend/app/api/v1/mind.py` | `DELETE` | `/api/v1/mind/canvases/{cid}/items/{iid}` | `remove_canvas_item` | Node Host 已接入事务内软删、关系脱离、Undo 与提交后事件；生产 `startServer` 经 Vite/隔离 PG 验证，Mind Node/Vite 定向套件 25/25、Python Mind 基线 68/68、typecheck 通过；随机 schema 残留 0。Redis 跨进程广播未验收，见 Mind 画布条目操作切片 |
| `backend/app/api/v1/mind.py` | `DELETE` | `/api/v1/mind/canvases/{cid}/relations/{rid}` | `delete_canvas_relation` | Node Host 已接入 owner-scoped 删除、Undo 和事务提交后通知；生产 `startServer` 经 Vite/隔离 PG 验证关系查询、删除与重建；Node/Vite 25/25、Python Mind 基线 68/68、typecheck 通过；Redis 跨进程广播未验收，见 Mind 画布条目操作切片 |
| `backend/app/api/v1/mind.py` | `DELETE` | `/api/v1/mind/notes/{nid}` | `delete_note` | Node Host 已接入 owner-scoped 软删除、版本递增、事务内 Undo 与提交后 mind 事件；Python Mind API/Undo 基线 39/39，Node Mind 行为套件 24/24；模拟 PostgreSQL 事务覆盖 rollback，真实 PG 尚无隔离库验收。 |
| `backend/app/api/v1/mind.py` | `DELETE` | `/api/v1/mind/relations/{rid}` | `delete_relation` | Node Host 已接入仅匹配全局关系（canvas_id IS NULL）的 owner-scoped 软删、事务内 Undo 和提交后通知；devserver 关系行为与生产 Vite→Node Host→隔离 PG 回归 6/6、typecheck 通过；真实集成验证跨 owner 404、非法 ID 422 和 null-canvas Undo 快照，见 Mind 全局关系删除切片 |
| `backend/app/api/v1/mind.py` | `GET` | `/api/v1/mind/canvases` | `list_canvases` | Node Host 已接入 owner-scoped PostgreSQL 读取、`project_id` 过滤和 200 条上限；生产 `startServer` 经 Vite/隔离 PG 验证列表、owner 隔离；Mind Node/Vite 25/25、Python Mind 基线 68/68、typecheck 通过；随机 schema 残留 0，见 Mind 画布条目操作切片 |
| `backend/app/api/v1/mind.py` | `GET` | `/api/v1/mind/canvases/{cid}/items` | `list_canvas_items` | Node Host 已接入 owner-scoped 活动画布项/节点读取，并批量附带活动卡首屏快照；生产 `startServer` 经 Vite/隔离 PG 验证软删后列表与便签仍保留；Mind Node/Vite 25/25、Python Mind 基线 68/68、typecheck 通过；随机 schema 残留 0，见 Mind 画布条目操作切片 |
| `backend/app/api/v1/mind.py` | `GET` | `/api/v1/mind/canvases/{cid}/relations` | `list_canvas_relations` | Node Host 已接入 owner-scoped 活动关系读取与 `detachedRelationIds` 过滤；生产 `startServer` 经 Vite/隔离 PG 验证关系删除后的列表与重建；Mind Node/Vite 25/25、Python Mind 基线 68/68、typecheck 通过；Redis 跨进程广播未验收，见 Mind 画布条目操作切片 |
| `backend/app/api/v1/mind.py` | `GET` | `/api/v1/mind/nodes/{nid}/canvas-location` | `canvas_note_location` | Node Host 已接入 owner-scoped 画布便签定位；Mind Python 基线 36/36，Node 画布读取/Host 测试 6/6，隔离 PG 用例 1 项因测试 URL 未配置跳过；Vite 未认证请求 401。真实 PG 查询未验收 |
| `backend/app/api/v1/mind.py` | `GET` | `/api/v1/mind/notes` | `list_notes` | Node Host 已接入 owner-scoped PostgreSQL 读取；生产 `startServer` 经 Vite/隔离 PG 验证便签仍在普通记录流可读；Mind Node/Vite 25/25、Python Mind 基线 68/68、typecheck 通过，随机 schema 残留 0，见 Mind 画布条目操作切片 |
| `backend/app/api/v1/mind.py` | `GET` | `/api/v1/mind/notes/{nid}` | `get_note` | Node Host 已接入 owner-scoped PostgreSQL 读取；生产 `startServer` 经 Vite/隔离 PG 验证画布项软删后普通便签仍可读；Mind Node/Vite 25/25、Python Mind 基线 68/68、typecheck 通过，随机 schema 残留 0，见 Mind 画布条目操作切片 |
| `backend/app/api/v1/mind.py` | `GET` | `/api/v1/mind/ref-suggest` | `ref_suggest` | Node 已接入 owner-scoped 最近候选、复用全局搜索以及逐条聊天消息定位；devserver Node 行为/PG adapter/Vite 生产组合根回归 4/4、Python Mind/引用建议基线 39/39、typecheck 通过；覆盖最近项目/文件/活动、项目搜索、消息片段与 owner 隔离，见 Mind 引用建议切片 |
| `backend/app/api/v1/mind.py` | `PATCH` | `/api/v1/mind/canvases/{cid}` | `update_canvas` | Node Host 已接入 owner-scoped 字段校验、局部更新、事务内 Undo 与提交后事件；依赖注入 Host 经 Vite/隔离 PG 验证更新后重读、跨 owner 隐藏；Mind Node/Vite 25/25、Python Mind 基线 68/68、typecheck 通过，随机 schema 残留 0，见 Mind 画布条目操作切片 |
| `backend/app/api/v1/mind.py` | `PATCH` | `/api/v1/mind/canvases/{cid}/items/{iid}` | `update_canvas_item` | Node Host 已接入 owner-scoped 字段更新、事务内 Undo 与提交后事件；生产 `startServer` 经 Vite/隔离 PG 验证位置/数据更新，依赖注入 Host 经 Vite/隔离 PG 验证置顶坐标和 z 重排；Mind Node/Vite 25/25、Python Mind 基线 68/68、typecheck 通过，见 Mind 画布条目操作切片 |
| `backend/app/api/v1/mind.py` | `PATCH` | `/api/v1/mind/nodes/{nid}` | `update_canvas_note` | Node Host 已接入 owner-scoped 画布便签编辑、版本 CAS、Markdown 派生字段、Undo 与提交后事件；依赖注入 Host 经 Vite/隔离 PG 验证成功更新、过期版本 409 与跨 owner 隐藏；Mind Node/Vite 25/25、Python Mind 基线 68/68、typecheck 通过，见 Mind 画布条目操作切片 |
| `backend/app/api/v1/mind.py` | `PATCH` | `/api/v1/mind/notes/{nid}` | `update_note` | Node Host 已接入 owner-scoped 字段校验、CAS、Markdown 搜索字段重算、空 PATCH 兼容、事务内 Undo 与提交后 mind 事件；Python Mind API/Undo 基线 39/39，Node Mind 行为套件 24/24；真实 PG 尚无隔离库验收。 |
| `backend/app/api/v1/mind.py` | `POST` | `/api/v1/mind/canvases` | `create_canvas` | Node Host 已接入 owner-scoped PostgreSQL 创建与 Undo；生产 `startServer` 经 Vite/隔离 PG 验证创建和读取，依赖注入 Host 经 Vite/隔离 PG 验证返回默认值；Mind Node/Vite 25/25、Python Mind 基线 68/68、typecheck 通过，见 Mind 画布条目操作切片 |
| `backend/app/api/v1/mind.py` | `POST` | `/api/v1/mind/canvases/{cid}/items` | `add_canvas_item` | Node Host 已接入 owner-scoped 幂等加入、事务内 Undo 与提交后事件；生产 `startServer` 经 Vite/隔离 PG 验证加入和重复加入，依赖注入 Host 经 Vite/隔离 PG 验证重复加入不重复写入；Mind Node/Vite 25/25、Python Mind 基线 68/68、typecheck 通过，见 Mind 画布条目操作切片 |
| `backend/app/api/v1/mind.py` | `POST` | `/api/v1/mind/canvases/{cid}/items/{iid}/bring-to-front` | `bring_canvas_item_to_front` | Node Host 已接入事务内 z 重排与坐标更新、Undo 和提交后事件；依赖注入 Host 经 Vite/隔离 PG 验证坐标与 z 值；Mind Node/Vite 25/25、Python Mind 基线 68/68、typecheck 通过，见 Mind 画布条目操作切片 |
| `backend/app/api/v1/mind.py` | `POST` | `/api/v1/mind/canvases/{cid}/notes` | `create_canvas_note` | Node Host 已接入便签创建、Markdown 索引、尺寸边界、Undo 与提交后事件；依赖注入 Host 经 Vite/隔离 PG 验证正文/元数据和默认尺寸，后续编辑与重读通过；Mind Node/Vite 25/25、Python Mind 基线 68/68、typecheck 通过，见 Mind 画布条目操作切片 |
| `backend/app/api/v1/mind.py` | `POST` | `/api/v1/mind/nodes/ref` | `create_ref_node` | Node Host 已接入 project/file/event owner-scoped 快照、幂等复用、Undo 与提交后事件；生产 `startServer` 经 Vite/隔离 PG 验证三类引用、重复项目引用和跨 owner 拒绝；Mind Node/Vite 25/25、Python Mind 基线 68/68、typecheck 通过，见 Mind 画布条目操作切片 |
| `backend/app/api/v1/mind.py` | `POST` | `/api/v1/mind/notes` | `create_note` | Node Host 已接入 owner-scoped Markdown 创建、纯文本/hash 派生、事务内 Undo 与提交后 mind 事件；Python Mind API/Undo 基线 39/39，Node Mind 行为套件 24/24；真实 PG 尚无隔离库验收。 |
| `backend/app/api/v1/mind.py` | `POST` | `/api/v1/mind/relations` | `create_relation` | Node Host 已接入 owner-scoped 建立、幂等与并行边处理、Undo 和事务后通知；生产 `startServer` 经 Vite/隔离 PG 验证重复/并行关系、自连接拒绝、跨 owner 隔离与删除后重建；Mind Node/Vite 25/25、Python Mind 基线 68/68、typecheck 通过；Redis 跨进程广播未验收，见 Mind 画布条目操作切片 |
| `backend/app/api/v1/notifications.py` | `DELETE` | `/api/v1/notifications/` | `clear_notifications` | Node Host owner-scoped PostgreSQL；通知域路由回归 4/4、隔离 schema Host/PG 集成 1/1、Python pytest 4/4；清除仅写当前用户 dismissal，不删除通知本体；见 `docs/devlog/2026-11-13-Node-WebUI通知中心当前树回归.md` |
| `backend/app/api/v1/notifications.py` | `GET` | `/api/v1/notifications/` | `list_notifications` | Node Host owner-scoped PostgreSQL；通知域路由回归 4/4、隔离 schema Host/PG 集成 1/1、Python pytest 4/4；覆盖可见范围、注册时间边界、持久/临时通知、已读/清除状态和排序/limit；见 `docs/devlog/2026-11-13-Node-WebUI通知中心当前树回归.md` |
| `backend/app/api/v1/notifications.py` | `GET` | `/api/v1/notifications/bubble` | `latest_bubble` | Node Host owner-scoped PostgreSQL；通知域路由回归 4/4、隔离 schema Host/PG 集成 1/1、Python pytest 4/4；覆盖未读、过期、已清除时的气泡选择；见 `docs/devlog/2026-11-13-Node-WebUI通知中心当前树回归.md` |
| `backend/app/api/v1/notifications.py` | `POST` | `/api/v1/notifications/read` | `mark_read` | Node Host owner-scoped PostgreSQL；通知域路由回归 4/4、隔离 schema Host/PG 集成 1/1、Python pytest 4/4；覆盖重复 ID 幂等及空列表标记全部可见通知；见 `docs/devlog/2026-11-13-Node-WebUI通知中心当前树回归.md` |
| `backend/onboarding/routes.py` | `GET` | `/api/v1/onboarding/state` | `get_onboarding_state` | Node Host 认证 owner 隔离、PostgreSQL 状态读取已接入；Node Host 定向 1/1、Python onboarding 基线 3/3、typecheck 通过；Vite 未认证 401；隔离 PG 用例因无测试库跳过；注册 seed 与 dev 接口仍由 Python 承担 |
| `backend/onboarding/routes.py` | `PATCH` | `/api/v1/onboarding/state` | `update_onboarding_state` | Node Host 认证 owner 隔离与 guide 字段校验/增量保存已接入；保留 seed 状态、兼容历史扁平字段；同组验证见 `docs/devlog/2026-11-13-Node-WebUI新手引导状态切片.md` |
| `backend/onboarding/routes.py` | `POST` | `/api/v1/onboarding/state/reopen` | `reopen_onboarding` | Node Host 已接入；恢复当前 guide 版本并保留已完成步骤和 seed 状态；同组验证见 `docs/devlog/2026-11-13-Node-WebUI新手引导状态切片.md` |
| `backend/onboarding/routes.py` | `POST` | `/api/v1/onboarding/dev/reseed` | `dev_reseed` | 待迁移：仅用于开发账号重播种；需与 Local 项目/文件/日历播种事务一并处理 |
| `backend/onboarding/routes.py` | `POST` | `/api/v1/onboarding/dev/reset-guide` | `dev_reset_guide` | 待迁移：仅用于开发账号重置引导状态 |
| `backend/app/api/v1/notifications_admin.py` | `DELETE` | `/api/v1/admin/notifications/history/{nid}` | `delete_record` | 待迁移 |
| `backend/app/api/v1/notifications_admin.py` | `GET` | `/api/v1/admin/notifications/history` | `history` | 待迁移 |
| `backend/app/api/v1/notifications_admin.py` | `POST` | `/api/v1/admin/notifications/broadcast` | `broadcast` | 待迁移 |
| `backend/app/api/v1/ops_admin.py` | `GET` | `/api/v1/admin/ops/storage-live-totals` | `storage_live_totals` | 待迁移 |
| `backend/app/api/v1/ops_admin.py` | `GET` | `/api/v1/admin/ops/storage-snapshots` | `storage_snapshots_history` | Node 已接入 Admin guard、PG query 与 Local statfs；真实 PG 行为未验收 |
| `backend/app/api/v1/ops_admin.py` | `GET` | `/api/v1/admin/ops/summary` | `ops_summary` | Node 模块原型4/4；Python 最近邻 opsmetrics 基线3/3（无直接 handler 回归）；Host/Admin guard/Redis adapter 未挂载，不计路由覆盖 |
| `backend/app/api/v1/preferences.py` | `GET` | `/api/v1/preferences/` | `get_preferences` | Node Host 已接通通用偏好、Local 隐藏人格/回复风格文件读取与旧回复风格 JSON 迁移；owner-scoped PostgreSQL 元数据、默认值及历史值归一化已回归。SMTP 配置、测试发送和邮件样式预览已迁移 |
| `backend/app/api/v1/preferences.py` | `GET` | `/api/v1/preferences/smtp` | `get_user_smtp` | Node Host 已接入 owner-scoped PostgreSQL 读取，仅投影非密码字段；Python 兼容验证见用户 SMTP 配置切片 |
| `backend/app/api/v1/preferences.py` | `PATCH` | `/api/v1/preferences/` | `update_preferences` | Node Host 已接通通用偏好局部更新、人格正文与开关、回复风格开关及 owner-scoped PostgreSQL；文本文件变化失效会话快照并递增上下文版本。Python 最近邻回归、Node 行为与路径测试通过；隔离 PG 用例跳过，shell_autopilot_enabled 清理与 Python 一致 |
| `backend/app/api/v1/preferences.py` | `PATCH` | `/api/v1/preferences/reply-style` | `update_reply_style` | Node Host 已接入 Local 隐藏文件读写、规范化、快照失效与上下文版本更新；devserver 定向测试通过，真实 PG 失效 SQL未在隔离库执行 |
| `backend/app/api/v1/preferences.py` | `POST` | `/api/v1/preferences/group-personality/upload` | `upload_group_personality` | Node Host 已接入 Markdown/UTF-8/字节与字符限制及 Local 隐藏文件写入；路径和上传行为回归通过，真实 PG 未验收 |
| `backend/app/api/v1/preferences.py` | `POST` | `/api/v1/preferences/personality/upload` | `upload_personality` | Node Host 已接入 Markdown/UTF-8/字节与字符限制、人格功能开关和 Local 隐藏文件写入；路径和上传行为回归通过，真实 PG 未验收 |
| `backend/app/api/v1/preferences.py` | `POST` | `/api/v1/preferences/reply-style/upload` | `upload_reply_style` | Node Host 已接入 Markdown/TXT、UTF-8/字节与字符限制和 Local 隐藏文件写入；路径和上传行为回归通过，真实 PG 未验收 |
| `backend/app/api/v1/preferences.py` | `POST` | `/api/v1/preferences/smtp/preview` | `preview_user_email` | Node Host 已接认证与独立 HTML 预览渲染，不依赖 SMTP 配置或发送器；Node 偏好路由与 Vite→Node Host→静态 Logo 路径回归 14 通过、0 失败，Python 邮件模板/能力/SMTP 基线 13/13，typecheck 通过；未发真实邮件，也不访问 Redis/PostgreSQL |
| `backend/app/api/v1/preferences.py` | `POST` | `/api/v1/preferences/smtp/test` | `test_user_smtp` | Node Host 已接入认证、owner-scoped 密码回读、当前用户默认收件人及 SMTP 测试发送；Node/Python 定向回归通过，真实 SMTP 与隔离 PG 未验收 |
| `backend/app/api/v1/preferences.py` | `PUT` | `/api/v1/preferences/smtp` | `update_user_smtp` | Node Host 已接入字段校验、owner-scoped upsert、密码加密及省略密码保留旧值；Python 兼容验证见用户 SMTP 配置切片 |
| `backend/app/api/v1/projects.py` | `DELETE` | `/api/v1/projects/{pid}` | `delete_project` | Node Host/Local 回收站已接入，文件移动随事务失败反向补偿；当前树项目/日历及两条 Vite 集成套件 105/105 通过，Python 对照 10 个文件 66/66、typecheck 通过。生产组合根在随机隔离 schema 和 Local 临时目录验证项目删除/恢复与关联文件物理往返；Redis 实时广播与 RAG Worker 消费仍待验收，详见项目日历当前树复验 devlog |
| `backend/app/api/v1/projects.py` | `GET` | `/api/v1/projects/` | `list_projects` | Node 已接入 |
| `backend/app/api/v1/projects.py` | `GET` | `/api/v1/projects/file-counts` | `list_project_file_counts` | Node 已接入 |
| `backend/app/api/v1/projects.py` | `GET` | `/api/v1/projects/{pid}` | `get_project` | Node 已接入 |
| `backend/app/api/v1/projects.py` | `PATCH` | `/api/v1/projects/{pid}` | `update_project` | Node Host 已接入认证与 Local 目录更新；schema 预校验、version/CAS、Undo 与提交后 context revision/RAG job/live event 已接入。事务失败会反向移动已改名目录。当前树项目/日历及两条 Vite 集成套件 105/105 通过，Python 对照 10 个文件 66/66、typecheck 通过；生产组合根在随机隔离 schema 和 Local 临时目录验证 PATCH 与目录改名。Redis 实时广播与 RAG Worker 消费仍待验收，详见项目日历当前树复验 devlog |
| `backend/app/api/v1/projects.py` | `POST` | `/api/v1/projects/` | `create_project` | Node 已接入；devserver 行为与 PG 已验收 |
| `backend/app/api/v1/projects.py` | `POST` | `/api/v1/projects/{pid}/restore` | `restore_project` | Node Host/Local 回收站已接入，恢复移动随事务失败回退至回收站 key；当前树项目/日历及两条 Vite 集成套件 105/105 通过，Python 对照 10 个文件 66/66、typecheck 通过。生产组合根在随机隔离 schema 和 Local 临时目录验证项目删除/恢复与关联文件物理往返；Linux/NAS 2.0 为 Local-only。Redis 实时广播与 RAG Worker 消费仍待验收，详见项目日历当前树复验 devlog |
| `backend/app/api/v1/public_config.py` | `GET` | `/api/v1/site-config/` | `site_config` | Node 已接入 |
| `backend/app/api/v1/qq_connect.py` | `GET` | `/api/v1/me/qq/connect/{task_id}` | `poll` | 待迁移 |
| `backend/app/api/v1/qq_connect.py` | `POST` | `/api/v1/me/qq/connect/` | `start` | 待迁移 |
| `backend/app/api/v1/safe_egress_admin.py` | `GET` | `/api/v1/admin/safe-egress/` | `get_safe_egress_config` | Node 独立读取 route 原型4/4，Python secret 不回显基线1/1；Vite 404，Host 未挂载；PATCH/POST 仍待迁移 |
| `backend/app/api/v1/safe_egress_admin.py` | `PATCH` | `/api/v1/admin/safe-egress/` | `patch_safe_egress_config` | 待迁移 |
| `backend/app/api/v1/safe_egress_admin.py` | `POST` | `/api/v1/admin/safe-egress/test` | `test_safe_egress` | 待迁移 |
| `backend/app/api/v1/sandbox_admin.py` | `GET` | `/api/v1/admin/sandbox/status` | `sandbox_status` | 重设计：迁移为 MXC 执行环境健康/能力与策略状态，不保留 Docker 字段 |
| `backend/app/api/v1/sandbox_admin.py` | `POST` | `/api/v1/admin/sandbox/disable` | `disable_sandbox` | 保留语义并重设计：Linux/NAS Host 全局关闭执行能力及收紧相关权限 |
| `backend/app/api/v1/sandbox_admin.py` | `POST` | `/api/v1/admin/sandbox/egress/config` | `save_egress_proxy` | 重设计为 Host/MXC 网络策略配置；移除 Docker 网络专属配置，不照搬旧接口语义 |
| `backend/app/api/v1/sandbox_admin.py` | `POST` | `/api/v1/admin/sandbox/egress/validate` | `validate_egress_proxy` | 重设计为 MXC 网络能力检查；不检查 Docker 网络或 sandboxd 前置条件 |
| `backend/app/api/v1/sandbox_admin.py` | `POST` | `/api/v1/admin/sandbox/enable` | `enable_sandbox` | 保留语义并重设计：Linux/NAS Host 全局启用前检查 MXC 多用户隔离能力 |
| `backend/app/api/v1/sandbox_admin.py` | `POST` | `/api/v1/admin/sandbox/rebuild` | `rebuild_sandbox` | 退役：Docker 临时容器重建；需要时按 MXC 任务/进程能力提供明确操作 |
| `backend/app/api/v1/sandbox_admin.py` | `POST` | `/api/v1/admin/sandbox/restart` | `restart_sandbox` | 退役：Docker 容器回收语义；执行中断按 MXC 任务/进程生命周期重设计 |
| `backend/app/api/v1/sandbox_admin.py` | `POST` | `/api/v1/admin/sandbox/users/clear` | `clear_user_sandboxes` | 退役：容器状态清理语义；若需资源回收，按 owner-scoped MXC 资源操作设计 |
| `backend/app/api/v1/sandbox_admin.py` | `POST` | `/api/v1/admin/sandbox/users/rebuild` | `rebuild_user_sandboxes` | 退役：用户容器重建操作；不迁移 Docker 生命周期接口 |
| `backend/app/api/v1/sandbox_admin.py` | `POST` | `/api/v1/admin/sandbox/users/restart` | `restart_user_sandboxes` | 重设计：如需管理员中断用户执行，使用 owner-scoped MXC 任务/进程终止能力 |
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
| `backend/app/api/v1/search.py` | `GET` | `/api/v1/search/` | `search` | 迁移中：Node Host 与 PostgreSQL 查询已接入，基础关键词/owner 过滤/分组已实现；Node 覆盖与当前查询表字段的罗马音转换、隔离 PostgreSQL 集成验收仍待完成，不标记为完成。 |
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
| `backend/app/api/v1/trash.py` | `DELETE` | `/api/v1/trash/` | `empty_trash` | Node Host/Local PG route 已接入；后台 purge job 仍由 Python Worker 消费，真实 PG/Worker 验收见“回收站当前树 Host 接线”记录 |
| `backend/app/api/v1/trash.py` | `DELETE` | `/api/v1/trash/folders/{fid}` | `hard_delete_folder` | Node Host/Local PG route 已接入；真实 PG 未验收，见“回收站当前树 Host 接线”记录 |
| `backend/app/api/v1/trash.py` | `DELETE` | `/api/v1/trash/{fid}` | `hard_delete_file` | Node Host/Local PG route 已接入；真实 PG 未验收，见“回收站当前树 Host 接线”记录 |
| `backend/app/api/v1/trash.py` | `GET` | `/api/v1/trash/empty/active` | `active_empty_trash` | Node Host/Local PG route 已接入；任务状态来自 Python Worker 的持久 job，见“回收站当前树 Host 接线”记录 |
| `backend/app/api/v1/trash.py` | `GET` | `/api/v1/trash/empty/{job_id}` | `get_empty_trash_job` | Node Host/Local PG route 已接入；任务状态来自 Python Worker 的持久 job，见“回收站当前树 Host 接线”记录 |
| `backend/app/api/v1/trash.py` | `GET` | `/api/v1/trash/folders/page` | `list_trash_folders_page` | Node Host/Local PG route 已接入；真实 PG 未验收，见“回收站当前树 Host 接线”记录 |
| `backend/app/api/v1/trash.py` | `GET` | `/api/v1/trash/folders/{fid}/contents/page` | `list_trash_folder_contents_page` | Node Host/Local PG route 已接入；真实 PG 未验收，见“回收站当前树 Host 接线”记录 |
| `backend/app/api/v1/trash.py` | `GET` | `/api/v1/trash/page` | `list_trash_page` | Node Host/Local PG route 已接入；真实 PG 未验收，见“回收站当前树 Host 接线”记录 |
| `backend/app/api/v1/trash.py` | `POST` | `/api/v1/trash/batch-restore` | `batch_restore` | Node Host/Local PG route 已接入；真实 PG 未验收，见“回收站当前树 Host 接线”记录 |
| `backend/app/api/v1/trash.py` | `POST` | `/api/v1/trash/empty` | `start_empty_trash` | Node Host/Local PG route 已接入；持久 job 由 Python Worker 消费，真实 PG/Worker 验收见“回收站当前树 Host 接线”记录 |
| `backend/app/api/v1/trash.py` | `POST` | `/api/v1/trash/folders/{fid}/restore` | `restore_folder` | Node Host/Local PG route 已接入；真实 PG 未验收，见“回收站当前树 Host 接线”记录 |
| `backend/app/api/v1/trash.py` | `POST` | `/api/v1/trash/{fid}/restore` | `restore_file` | Node Host/Local PG route 已接入；真实 PG 未验收，见“回收站当前树 Host 接线”记录 |
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
| `backend/app/api/v1/workspaces.py` | `GET` | `/api/v1/workspace-directories` | `list_workspace_directory_view` | Node route、PostgreSQL adapter 与 Host 已接入；未认证在读 owner/数据前拒绝；本地 ACL adapter 已注入；devserver Vite→Node Host→随机 schema Local 目录 CRUD/owner 隔离/磁盘生命周期集成 1/1，workspace directory Node 套件 9/9、Python Local 基准 28/28；真实 sandboxd/PTy 与 ACL 权限未验收，详见 `docs/devlog/2026-11-13-Node-WebUI-Local工作区VitePG闭环.md` |
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


## 验收原则

- 源路由表记录每个 method/path 的当前状态和必要证据；详细实现过程、历史测试快照及已被后续结果替代的记录放在 devlog。
- 只有 Node 行为、真实依赖与调用方切换均验收后，才算对应迁移完成；显式不可用响应、路由挂载或 mock-only 回归不代表完成。
- 全部 Web 必需 HTTP、SSE、静态资源及后台调用方具备等价实现和实机证据后，才切换默认 Node Web 流量。

## 更新规则

- **2026-11-13 原生回归复核**：Python `backend/tests/platform/security/test_ownership_security_events.py` 在 devserver 串行 3/3；Node 26.13.1 原生运行 `tests/admin/admin-audit-log.test.ts tests/admin/admin-user-security-events.test.ts` 8/8。Python 基线只覆盖安全事件记录/HMAC，不覆盖两个 GET handler；Node 测试使用 query adapter 替身。Vite 上 `/api/v1/admin/audit-log/security-events` 与 `/api/v1/admin/users/{user_id}/security-events` 均为 404，Host 未注册；隔离 PG 环境变量未设置，SQL/列/排序真实行为未验收。模块不计入已接入路由数。
- 迁移接口时先补 route contract 与隔离 PostgreSQL 回归，并在 devserver 验收后再更新状态。
- 单独列出仍由 Python 完成的完整副作用（幂等、Undo、事件、存储、Worker）；不能把仅路由可访问标成行为等价。
- `/api/v1/auth/login` 的 Node 固定窗口限流已接 Redis command adapter，配置 `GUGU_WEBUI_REDIS_URL` 时可跨进程共享；未配置或 Redis 故障时兼容地 fail-open。登录限流与 Python 的共享能力仍需真实 Redis 环境验收。
- Node Admin 登录/注销/当前用户与存储快照路由已挂载 Host；Admin auth version store 要求 Redis，未配置时按 Python 语义返回 503。Admin 登录限流复用共享 Redis 固定窗口 adapter；快照 Local 磁盘统计只在进程内使用 storage path，不在响应或日志暴露路径。
- 只有所有 Web 必需 HTTP、SSE、静态资源和后台调用方均有等价实现与实机证据后，才推进默认 Node Web 切换。
