# Gugu 2.0 Node WebUI API 迁移清单

> 更新：2026-11-12。以 `backend/app/api/v1/` 的 FastAPI 路由声明为来源，按运行时 `/api/v1` 挂载和 Agent 子路由前缀展开。Node 已接入状态只表示对应 HTTP method/path 已注册；行为等价仍以 N2 对应回归和 PostgreSQL 验收为准。

## 当前覆盖

- 源码静态盘点：**390** 个字面路由操作，分布在 **57** 个模块。
- Node 当前路由匹配：**14** 个 method/path（其中项目列表包含活动/归档/回收站查询变体）；其余 **376** 个待迁移。
- `health` 与 `health/ready` 是 Node Host 自身端点，不属于 Python `/api/v1` 路由计数。
- Node Host 配置了 Fastify `routerOptions.ignoreTrailingSlash`，用于兼容 Python 路由常见的带/不带尾斜杠调用形式。
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
| `backend/app/api/v1/admin_auth.py` | `GET` | `/api/v1/admin/auth/me` | `me` | 待迁移 |
| `backend/app/api/v1/admin_auth.py` | `POST` | `/api/v1/admin/auth/login` | `login` | 待迁移 |
| `backend/app/api/v1/admin_auth.py` | `POST` | `/api/v1/admin/auth/logout` | `logout` | 待迁移 |
| `backend/app/api/v1/admin_debug.py` | `GET` | `/api/v1/admin/debug/logs/stream` | `stream_logs` | 待迁移 |
| `backend/app/api/v1/admin_debug.py` | `GET` | `/api/v1/admin/debug/logs/tail` | `tail_logs` | 待迁移 |
| `backend/app/api/v1/admin_update.py` | `GET` | `/api/v1/admin/update/status` | `update_status` | 待迁移 |
| `backend/app/api/v1/admin_update.py` | `POST` | `/api/v1/admin/update/check` | `check_update` | 待迁移 |
| `backend/app/api/v1/admin_update.py` | `POST` | `/api/v1/admin/update/preflight` | `update_preflight` | 待迁移 |
| `backend/app/api/v1/admin_update.py` | `POST` | `/api/v1/admin/update/rollback` | `rollback` | 待迁移 |
| `backend/app/api/v1/admin_update.py` | `POST` | `/api/v1/admin/update/rollback/preflight` | `rollback_preflight` | 待迁移 |
| `backend/app/api/v1/admin_update.py` | `POST` | `/api/v1/admin/update/start` | `start_update` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `DELETE` | `/api/v1/admin/agent/llm-presets/{preset_id}` | `delete_llm_preset` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `DELETE` | `/api/v1/admin/agent/voice-presets/{preset_id}` | `delete_voice_preset` | 待迁移 |
| `backend/app/api/v1/agent_admin.py` | `GET` | `/api/v1/admin/agent/capabilities` | `list_capabilities` | 待迁移 |
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
| `backend/app/api/v1/agent_perception.py` | `GET` | `/api/v1/admin/perception/` | `perception_stats` | 待迁移 |
| `backend/app/api/v1/agent_perception.py` | `GET` | `/api/v1/admin/perception/export` | `export_events` | 待迁移 |
| `backend/app/api/v1/agent_perception.py` | `GET` | `/api/v1/admin/perception/misread/export` | `misread_export` | 待迁移 |
| `backend/app/api/v1/agent_perception.py` | `GET` | `/api/v1/admin/perception/misread/recent` | `misread_recent` | 待迁移 |
| `backend/app/api/v1/agent_routes/attachments.py` | `DELETE` | `/api/v1/agent/attachment/{attach_id}` | `delete_draft_attachment` | 待迁移 |
| `backend/app/api/v1/agent_routes/attachments.py` | `DELETE` | `/api/v1/agent/attachments` | `clear_attachments` | 待迁移 |
| `backend/app/api/v1/agent_routes/attachments.py` | `GET` | `/api/v1/agent/attachment/{attach_id}/download` | `attachment_download` | 待迁移 |
| `backend/app/api/v1/agent_routes/attachments.py` | `GET` | `/api/v1/agent/attachment/{attach_id}/thumb` | `attachment_thumb` | 待迁移 |
| `backend/app/api/v1/agent_routes/attachments.py` | `POST` | `/api/v1/agent/upload` | `upload_attachment` | 待迁移 |
| `backend/app/api/v1/agent_routes/chat.py` | `GET` | `/api/v1/agent/sessions/{session_id}/state` | `get_session_state` | 待迁移 |
| `backend/app/api/v1/agent_routes/chat.py` | `GET` | `/api/v1/agent/sessions/{session_id}/stream` | `resume_stream` | 待迁移 |
| `backend/app/api/v1/agent_routes/chat.py` | `POST` | `/api/v1/agent/chat` | `chat` | 待迁移 |
| `backend/app/api/v1/agent_routes/chat.py` | `POST` | `/api/v1/agent/sessions/{session_id}/cancel` | `cancel_stream` | 待迁移 |
| `backend/app/api/v1/agent_routes/interactions.py` | `GET` | `/api/v1/agent/interactions/{prompt_id}/session` | `get_interaction_session` | 待迁移 |
| `backend/app/api/v1/agent_routes/interactions.py` | `POST` | `/api/v1/agent/interactions/{prompt_id}/respond` | `respond_interaction` | 待迁移 |
| `backend/app/api/v1/agent_routes/interactions.py` | `POST` | `/api/v1/agent/interactions/{prompt_id}/resume` | `resume_interaction` | 待迁移 |
| `backend/app/api/v1/agent_routes/interactions.py` | `POST` | `/api/v1/agent/interactions/{prompt_id}/resume-text` | `resume_text_interaction` | 待迁移 |
| `backend/app/api/v1/agent_routes/interactions.py` | `POST` | `/api/v1/agent/interactions/{prompt_id}/secrets` | `submit_secret_interaction` | 待迁移 |
| `backend/app/api/v1/agent_routes/interactions.py` | `POST` | `/api/v1/agent/interactions/{prompt_id}/secrets/cancel` | `cancel_secret_interaction` | 待迁移 |
| `backend/app/api/v1/agent_routes/misc.py` | `DELETE` | `/api/v1/agent/memory` | `clear_memory` | 待迁移 |
| `backend/app/api/v1/agent_routes/misc.py` | `GET` | `/api/v1/agent/commands` | `get_commands` | 待迁移 |
| `backend/app/api/v1/agent_routes/misc.py` | `GET` | `/api/v1/agent/greeting` | `get_greeting` | 待迁移 |
| `backend/app/api/v1/agent_routes/misc.py` | `GET` | `/api/v1/agent/ui-labels` | `get_ui_labels` | 待迁移 |
| `backend/app/api/v1/agent_routes/misc.py` | `GET` | `/api/v1/agent/voice-availability` | `get_voice_availability` | 待迁移 |
| `backend/app/api/v1/agent_routes/pending_queue.py` | `GET` | `/api/v1/agent/pending-queues/imported-drafts` | `list_imported_draft_queues` | 待迁移 |
| `backend/app/api/v1/agent_routes/pending_queue.py` | `GET` | `/api/v1/agent/pending-queues/{queue_id}` | `get_pending_queue_by_id` | 待迁移 |
| `backend/app/api/v1/agent_routes/pending_queue.py` | `PATCH` | `/api/v1/agent/pending-queues/{queue_id}` | `patch_session_pending_queue` | 待迁移 |
| `backend/app/api/v1/agent_routes/pending_queue.py` | `POST` | `/api/v1/agent/pending-queues/{queue_id}/items/{item_key}/claim` | `claim_session_pending_queue_item` | 待迁移 |
| `backend/app/api/v1/agent_routes/pending_queue.py` | `POST` | `/api/v1/agent/pending-queues/{queue_id}/items/{item_key}/release` | `release_session_pending_queue_item` | 待迁移 |
| `backend/app/api/v1/agent_routes/pending_queue.py` | `PUT` | `/api/v1/agent/pending-queues/{queue_id}` | `update_draft_pending_queue` | 待迁移 |
| `backend/app/api/v1/agent_routes/sandbox.py` | `POST` | `/api/v1/agent/sandbox/clear` | `clear_my_sandbox` | 待迁移 |
| `backend/app/api/v1/agent_routes/sandbox.py` | `POST` | `/api/v1/agent/sandbox/rebuild` | `rebuild_my_sandbox` | 待迁移 |
| `backend/app/api/v1/agent_routes/sandbox.py` | `POST` | `/api/v1/agent/sandbox/restart` | `restart_my_sandbox` | 待迁移 |
| `backend/app/api/v1/agent_routes/sessions.py` | `DELETE` | `/api/v1/agent/sessions/{session_id}` | `delete_session` | 待迁移 |
| `backend/app/api/v1/agent_routes/sessions.py` | `DELETE` | `/api/v1/agent/sessions/{session_id}/filesystem-authorization` | `revoke_session_filesystem_authorization` | 待迁移 |
| `backend/app/api/v1/agent_routes/sessions.py` | `GET` | `/api/v1/agent/messages/{message_id}` | `get_message_location` | 待迁移 |
| `backend/app/api/v1/agent_routes/sessions.py` | `GET` | `/api/v1/agent/sessions` | `list_sessions` | 待迁移 |
| `backend/app/api/v1/agent_routes/sessions.py` | `GET` | `/api/v1/agent/sessions/{session_id}/messages` | `get_session_messages` | 待迁移 |
| `backend/app/api/v1/agent_routes/sessions.py` | `GET` | `/api/v1/agent/sessions/{session_id}/tool-event-details` | `get_session_tool_event_details` | 待迁移 |
| `backend/app/api/v1/agent_routes/sessions.py` | `PATCH` | `/api/v1/agent/sessions/{session_id}` | `rename_session` | 待迁移 |
| `backend/app/api/v1/agent_routes/sessions.py` | `POST` | `/api/v1/agent/sessions/{session_id}/filesystem-authorization` | `confirm_session_filesystem_authorization` | 待迁移 |
| `backend/app/api/v1/agent_routes/sessions.py` | `POST` | `/api/v1/agent/sessions/{session_id}/filesystem-authorization/request` | `request_session_filesystem_authorization` | 待迁移 |
| `backend/app/api/v1/agent_routes/sessions.py` | `POST` | `/api/v1/agent/sessions/{session_id}/refresh-context` | `refresh_session_context` | 待迁移 |
| `backend/app/api/v1/audit_log.py` | `GET` | `/api/v1/admin/audit-log/` | `list_audit_logs` | 待迁移 |
| `backend/app/api/v1/audit_log.py` | `GET` | `/api/v1/admin/audit-log/security-events` | `list_security_events` | 待迁移 |
| `backend/app/api/v1/auth.py` | `DELETE` | `/api/v1/auth/me` | `delete_my_account` | 待迁移 |
| `backend/app/api/v1/auth.py` | `GET` | `/api/v1/auth/avatar/{user_id}` | `get_avatar` | 待迁移 |
| `backend/app/api/v1/auth.py` | `GET` | `/api/v1/auth/me` | `me` | Node 已接入 |
| `backend/app/api/v1/auth.py` | `GET` | `/api/v1/auth/quota` | `get_quota` | 待迁移 |
| `backend/app/api/v1/auth.py` | `GET` | `/api/v1/auth/usage/trends` | `get_usage_trends` | 待迁移 |
| `backend/app/api/v1/auth.py` | `PATCH` | `/api/v1/auth/profile` | `update_profile` | 待迁移 |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/avatar` | `upload_avatar` | 待迁移 |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/email-change/cancel` | `cancel_email_change` | 待迁移 |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/email-change/request` | `request_email_change` | 待迁移 |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/email-change/resend` | `resend_email_change` | 待迁移 |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/email-change/verify` | `verify_email_change` | 待迁移 |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/forgot-password` | `forgot_password` | 待迁移 |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/login` | `login` | 待迁移 |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/logout` | `logout` | 待迁移 |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/register` | `register` | 待迁移 |
| `backend/app/api/v1/auth.py` | `POST` | `/api/v1/auth/registration-code` | `send_registration_code` | 待迁移 |
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
| `backend/app/api/v1/events.py` | `DELETE` | `/api/v1/events/{eid}` | `delete_event` | 待迁移 |
| `backend/app/api/v1/events.py` | `GET` | `/api/v1/events/` | `list_events` | Node 已接入 |
| `backend/app/api/v1/events.py` | `GET` | `/api/v1/events/{eid}` | `get_event` | Node 已接入 |
| `backend/app/api/v1/events.py` | `PATCH` | `/api/v1/events/{eid}` | `update_event` | 待迁移 |
| `backend/app/api/v1/events.py` | `POST` | `/api/v1/events/` | `create_event` | 待迁移 |
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
| `backend/app/api/v1/ops_admin.py` | `GET` | `/api/v1/admin/ops/storage-snapshots` | `storage_snapshots_history` | 待迁移 |
| `backend/app/api/v1/ops_admin.py` | `GET` | `/api/v1/admin/ops/summary` | `ops_summary` | 待迁移 |
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
| `backend/app/api/v1/projects.py` | `DELETE` | `/api/v1/projects/{pid}` | `delete_project` | 待迁移 |
| `backend/app/api/v1/projects.py` | `GET` | `/api/v1/projects/` | `list_projects` | Node 已接入 |
| `backend/app/api/v1/projects.py` | `GET` | `/api/v1/projects/file-counts` | `list_project_file_counts` | Node 已接入 |
| `backend/app/api/v1/projects.py` | `GET` | `/api/v1/projects/{pid}` | `get_project` | Node 已接入 |
| `backend/app/api/v1/projects.py` | `PATCH` | `/api/v1/projects/{pid}` | `update_project` | 待迁移 |
| `backend/app/api/v1/projects.py` | `POST` | `/api/v1/projects/` | `create_project` | 待迁移 |
| `backend/app/api/v1/projects.py` | `POST` | `/api/v1/projects/{pid}/restore` | `restore_project` | 待迁移 |
| `backend/app/api/v1/public_config.py` | `GET` | `/api/v1/site-config/` | `site_config` | 待迁移 |
| `backend/app/api/v1/qq_connect.py` | `GET` | `/api/v1/me/qq/connect/{task_id}` | `poll` | 待迁移 |
| `backend/app/api/v1/qq_connect.py` | `POST` | `/api/v1/me/qq/connect/` | `start` | 待迁移 |
| `backend/app/api/v1/safe_egress_admin.py` | `GET` | `/api/v1/admin/safe-egress/` | `get_safe_egress_config` | 待迁移 |
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
| `backend/app/api/v1/track.py` | `POST` | `/api/v1/track/` | `track` | Node 已接入 |
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
| `backend/app/api/v1/users_admin.py` | `GET` | `/api/v1/admin/users/` | `list_users` | 待迁移 |
| `backend/app/api/v1/users_admin.py` | `GET` | `/api/v1/admin/users/risk` | `list_risk_users` | 待迁移 |
| `backend/app/api/v1/users_admin.py` | `GET` | `/api/v1/admin/users/{user_id}/security-events` | `list_user_security_events` | 待迁移 |
| `backend/app/api/v1/users_admin.py` | `PATCH` | `/api/v1/admin/users/{user_id}/ban` | `toggle_ban` | 待迁移 |
| `backend/app/api/v1/users_admin.py` | `PATCH` | `/api/v1/admin/users/{user_id}/developer` | `toggle_developer` | 待迁移 |
| `backend/app/api/v1/users_admin.py` | `PATCH` | `/api/v1/admin/users/{user_id}/quota` | `update_quota` | 待迁移 |
| `backend/app/api/v1/users_admin.py` | `POST` | `/api/v1/admin/users/{user_id}/suspend` | `suspend_user` | 待迁移 |
| `backend/app/api/v1/users_admin.py` | `POST` | `/api/v1/admin/users/{user_id}/unsuspend` | `unsuspend_user` | 待迁移 |
| `backend/app/api/v1/wechat_connect.py` | `GET` | `/api/v1/me/wechat/connect/{task_id}` | `poll` | 待迁移 |
| `backend/app/api/v1/wechat_connect.py` | `POST` | `/api/v1/me/wechat/connect/` | `start` | 待迁移 |
| `backend/app/api/v1/workspace_migration_admin.py` | `POST` | `/api/v1/admin/workspace-migration/scan` | `scan_legacy_shell_directories_view` | 待迁移 |
| `backend/app/api/v1/workspaces.py` | `DELETE` | `/api/v1/workspaces/binding/{session_id}` | `unbind_workspace` | 待迁移 |
| `backend/app/api/v1/workspaces.py` | `DELETE` | `/api/v1/workspaces/{workspace_id}` | `remove_workspace` | 待迁移 |
| `backend/app/api/v1/workspaces.py` | `GET` | `/api/v1/workspaces/` | `list_workspaces` | 待迁移 |
| `backend/app/api/v1/workspaces.py` | `GET` | `/api/v1/workspaces/session/{session_id}` | `current_workspace` | 待迁移 |
| `backend/app/api/v1/workspaces.py` | `PATCH` | `/api/v1/workspaces/{workspace_id}` | `edit_workspace` | 待迁移 |
| `backend/app/api/v1/workspaces.py` | `POST` | `/api/v1/workspaces/` | `add_workspace` | 待迁移 |
| `backend/app/api/v1/workspaces.py` | `POST` | `/api/v1/workspaces/{workspace_id}/bind/{session_id}` | `bind_workspace` | 待迁移 |


## Node 已接入路由的实现与回归位置

| method/path | 实现 | 主要回归 |
| --- | --- | --- |
| `POST /api/v1/track` | `gugu-webui/src/app.ts`, `src/track.ts` | `tests/track-route.test.ts`, isolated PostgreSQL integration |
| `GET /api/v1/notifications`, `GET /api/v1/notifications/bubble`, `POST /api/v1/notifications/read`, `DELETE /api/v1/notifications` | `gugu-webui/src/app.ts`, `src/notifications.ts` | `tests/notifications-route.test.ts`, isolated PostgreSQL integration |
| `GET /api/v1/auth/me` | `gugu-webui/src/app.ts`, `src/auth.ts`, `src/users.ts` | `tests/auth-route.test.ts`, PostgreSQL integration |
| `GET /api/v1/projects`, `GET /api/v1/projects/{pid}`, `GET /api/v1/projects/file-counts` | `gugu-webui/src/app.ts`, `src/projects.ts` | `tests/projects-route.test.ts`, PostgreSQL integration |
| `GET /api/v1/clients`, `POST /api/v1/clients`, `DELETE /api/v1/clients/{cid}` | `gugu-webui/src/app.ts`, `src/clients.ts` | `tests/clients-route.test.ts`, PostgreSQL integration |
| `GET /api/v1/events`, `GET /api/v1/events/{event_id}` | `gugu-webui/src/app.ts`, `src/events.ts` | `tests/events-route.test.ts`, PostgreSQL integration |

## 更新规则

- 迁移接口时先补本地 route contract 与隔离 PostgreSQL 回归，再将状态改为 Node 已接入。
- 单独列出仍由 Python 完成的完整副作用（幂等、Undo、事件、存储、Worker）；不能把仅路由可访问标成行为等价。
- 只有所有 Web 必需 HTTP、SSE、静态资源和后台调用方均有等价实现与实机证据后，才推进默认 Node Web 切换。
