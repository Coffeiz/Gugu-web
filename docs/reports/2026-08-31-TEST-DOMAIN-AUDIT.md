# Phase 2 测试领域审查

> 本报告由 `scripts/tests/generate-domain-audit.mjs` 根据测试资产快照生成。
> 合并或删除必须同时确认生产入口、输入边界和结果断言一致；领域或层级不同的测试默认保留。

## 审查规则

- [x] 已确认文件职责和 owner。
- [x] 已确认测试覆盖的生产入口。
- [x] 已确认测试输入边界和结果断言。
- [x] 仅对三者完全相同的重复项提出合并/删除建议。
- [x] 合并或删除后补充替代覆盖位置，并运行受影响领域测试和后端全量测试。

## 上下文/会话（context）

资产数：43；源码声明数：228；待审查重复候选：0（未自动判定删除）。

### 初步审查

- 初步分组：缓存/前缀（诊断脚本与 `test_cross_run_cache_prefix.py`）、历史过滤/规范化、compaction、session 快照/续接。
- 当前不直接合并：`test_new_assembly.py`、`test_prefix_optimization.py` 是组装边界诊断，`test_real_cache_optimization.py` 和 20-run 脚本是 provider 观测；生产入口或执行层级不同。
- 重复候选：多个真实缓存脚本需要后续以同一 provider、同一 session、同一输出指标对拍；确认结果前全部保留。

| 文件 | 类型 | 层级 | owner | 声明数 | 外部依赖 | skip | 处置依据 |
|---|---|---|---|---:|---|---|---|
| backend/scripts/diagnostics/test_cache_mode_compare.py | 诊断脚本 | L2 | backend/diagnostics | 0 | 否 | 否 | 保留独立诊断入口；观测外部服务或长链路，不并入标准测试 |
| backend/scripts/diagnostics/test_cache_strategy_compare.py | 诊断脚本 | L2 | backend/diagnostics | 0 | 否 | 否 | 保留独立诊断入口；观测外部服务或长链路，不并入标准测试 |
| backend/scripts/diagnostics/test_cross_call_cache.py | 诊断脚本 | L2 | backend/diagnostics | 0 | 是 | 否 | 保留独立诊断入口；观测外部服务或长链路，不并入标准测试 |
| backend/scripts/diagnostics/test_locale_continuous.py | 诊断脚本 | L2 | backend/diagnostics | 0 | 是 | 否 | 保留独立诊断入口；观测外部服务或长链路，不并入标准测试 |
| backend/scripts/diagnostics/test_new_assembly.py | 诊断脚本 | L2 | backend/diagnostics | 0 | 否 | 否 | 保留独立诊断入口；观测外部服务或长链路，不并入标准测试 |
| backend/scripts/diagnostics/test_prefix_optimization.py | 诊断脚本 | L2 | backend/diagnostics | 0 | 否 | 否 | 保留独立诊断入口；观测外部服务或长链路，不并入标准测试 |
| backend/scripts/diagnostics/test_real_cache_optimization.py | 诊断脚本 | L2 | backend/diagnostics | 0 | 否 | 否 | 保留独立诊断入口；观测外部服务或长链路，不并入标准测试 |
| backend/scripts/diagnostics/test_real_session_20_run_cache_matrix.py | 诊断脚本 | L2 | backend/diagnostics | 0 | 否 | 否 | 保留独立诊断入口；观测外部服务或长链路，不并入标准测试 |
| backend/scripts/diagnostics/test_real_session_20_run_cache.py | 诊断脚本 | L2 | backend/diagnostics | 0 | 否 | 否 | 保留独立诊断入口；观测外部服务或长链路，不并入标准测试 |
| backend/scripts/diagnostics/test_session_incremental_cache.py | 诊断脚本 | L2 | backend/diagnostics | 0 | 否 | 否 | 保留独立诊断入口；观测外部服务或长链路，不并入标准测试 |
| backend/scripts/diagnostics/test_tool_cache_boundary.py | 诊断脚本 | L2 | backend/diagnostics | 0 | 否 | 否 | 保留独立诊断入口；观测外部服务或长链路，不并入标准测试 |
| backend/tests/test_agent_context_tz.py | pytest | L1 | backend/context | 7 | 否 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_canonical_context.py | pytest | L1 | backend/context | 5 | 否 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_canonical_tool_history.py | pytest | L1 | backend/context | 12 | 否 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_compaction.py | pytest | L1 | backend/context | 39 | 是 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_context_assembly.py | pytest | L1 | backend/context | 2 | 否 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_context_audit.py | pytest | L1 | backend/context | 1 | 否 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_context_branch.py | pytest | L1 | backend/context | 9 | 是 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_context_budget.py | pytest | L1 | backend/context | 8 | 否 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_context_cache_boundaries.py | pytest | L1 | backend/context | 8 | 否 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_context_history.py | pytest | L1 | backend/context | 22 | 否 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_context_revision.py | pytest | L1 | backend/context | 2 | 是 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_cross_run_cache_prefix.py | pytest | L1 | backend/context | 5 | 是 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_daily_compaction.py | pytest | L1 | backend/context | 2 | 否 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_history_attachment_refs.py | pytest | L1 | backend/context | 1 | 否 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_history_persist_filter.py | pytest | L1 | backend/context | 10 | 是 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_im_context_loader.py | pytest | L1 | backend/context | 2 | 否 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_im_owner_session.py | pytest | L1 | backend/context | 5 | 是 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_im_session_reuse.py | pytest | L1 | backend/context | 13 | 否 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_llm_cache_capability.py | pytest | L1 | backend/context | 6 | 否 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_memory_compaction_retrieval.py | pytest | L1 | backend/context | 2 | 否 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_message_compaction_boundary.py | pytest | L1 | backend/context | 11 | 否 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_modelctx.py | pytest | L1 | backend/context | 2 | 否 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_preferences_cache_contract.py | pytest | L1 | backend/context | 3 | 否 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_preferences_context_contract.py | pytest | L1 | backend/context | 4 | 否 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_provider_history_adapters.py | pytest | L1 | backend/context | 2 | 否 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_quoted_context.py | pytest | L1 | backend/context | 2 | 否 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_run_context_boundaries.py | pytest | L1 | backend/context | 1 | 否 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_session_execution_gate.py | pytest | L1 | backend/context | 2 | 是 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_session_history.py | pytest | L1 | backend/context | 3 | 否 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_session_snapshot.py | pytest | L1 | backend/context | 30 | 否 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_session_title_prompt.py | pytest | L1 | backend/context | 2 | 否 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_video_cache_snapshots_api.py | pytest | L1 | backend/context | 5 | 是 | 否 | 保留 backend/context 的 L1 契约；与 API、E2E 或其他领域入口分层 |

## IM（im）

资产数：32；源码声明数：310；待审查重复候选：0（未自动判定删除）。

### 初步审查

- 初步分组：平台协议/网关、身份与成员、私聊/群聊会话、媒体与去重、交互确认、通知与定时投递。
- 当前不直接合并：`test_im_protocol.py` 与 `test_interaction_protocol.py` 分别覆盖平台消息规范化和业务确认协议；QQ HTTP 发送与 WebSocket 接收也属于不同生产入口。
- 重复候选：Feishu/QQ 的 action 编解码测试结构相近但协议实现不同；先保留平台边界，后续只抽取通用断言构造器。

| 文件 | 类型 | 层级 | owner | 声明数 | 外部依赖 | skip | 处置依据 |
|---|---|---|---|---:|---|---|---|
| backend/tests/test_feedback_email.py | pytest | L1 | backend/im | 2 | 否 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_feishu_gateway_guards.py | pytest | L1 | backend/im | 5 | 是 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_feishu_interactions.py | pytest | L1 | backend/im | 4 | 否 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_feishu_media.py | pytest | L1 | backend/im | 9 | 是 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_im_conversation_key.py | pytest | L1 | backend/im | 6 | 否 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_im_dedup.py | pytest | L1 | backend/im | 13 | 是 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_im_identity.py | pytest | L1 | backend/im | 28 | 否 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_im_media_ingress.py | pytest | L1 | backend/im | 10 | 否 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_im_members.py | pytest | L1 | backend/im | 35 | 是 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_im_memory_admin.py | pytest | L1 | backend/im | 2 | 否 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_im_memory_scopes.py | pytest | L1 | backend/im | 23 | 是 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_im_permissions_types.py | pytest | L1 | backend/im | 2 | 否 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_im_protocol.py | pytest | L1 | backend/im | 14 | 否 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_im_replies.py | pytest | L1 | backend/im | 19 | 否 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_im_shortcut_fallback.py | pytest | L1 | backend/im | 3 | 是 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_interaction_events.py | pytest | L1 | backend/im | 2 | 否 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_interaction_phase5_7.py | pytest | L1 | backend/im | 5 | 否 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_interaction_protocol.py | pytest | L1 | backend/im | 14 | 否 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_message_format.py | pytest | L1 | backend/im | 6 | 否 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_notifications.py | pytest | L1 | backend/im | 2 | 否 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_qface.py | pytest | L1 | backend/im | 3 | 否 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_qq_binding_code.py | pytest | L1 | backend/im | 4 | 是 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_qq_connect_scan_url.py | pytest | L1 | backend/im | 3 | 是 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_qq_error_contract.py | pytest | L1 | backend/im | 12 | 否 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_qq_group_history.py | pytest | L1 | backend/im | 1 | 否 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_qq_raw_send.py | pytest | L1 | backend/im | 15 | 否 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_qq_raw_ws.py | pytest | L2 | backend/im | 33 | 是 | 否 | 保留 backend/im 的 L2 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_scheduled_group_imctx.py | pytest | L1 | backend/im | 11 | 否 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_similar_image_search.py | pytest | L1 | backend/im | 13 | 否 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_start_im_activity_order.py | pytest | L1 | backend/im | 2 | 是 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_wechat_quotes.py | pytest | L1 | backend/im | 8 | 是 | 否 | 保留 backend/im 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| frontend/src/interaction/runtime/canvas.test.ts | Vitest | L0 | frontend/im | 1 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |

## 存储/文件（storage）

资产数：44；源码声明数：392；待审查重复候选：0（未自动判定删除）。

### 初步审查

- 初步分组：字节存储后端契约、用户前缀清理、key/路径策略与迁移、文件/文件夹服务、回收站与目录对账、附件生命周期与视频缓存、前端文件状态投影、LoopScope 本地落盘。
- 已核对的相邻文件保持分层：`test_storage_contract.py` 验证后端字节读写与 trash hook，`test_storage_cleanup.py` 验证注销场景的用户前缀清理；`test_storage_keys.py`、`test_key_strategy.py`、`test_path_migration.py` 分别验证现行 key、PathMirror 策略和旧路径解析迁移，生产入口与断言不相同。
- `test_file_service.py`、`test_folder_tree.py`、`test_folders_api.py`、`test_trash_folders.py`、`test_folder_doctor.py` 分别覆盖服务门面、树操作、REST 映射、回收站语义和物理目录对账；不能因都包含“文件夹”而合并。
- `test_attachment_gc.py`、`test_storage_snapshots.py`、`test_video_cache.py` 关注附件生命周期、监控快照和视频缓存的定时/锁/幂等行为；`test_chat_attach_video.py` 与 `test_tool_video_media_dispatch.py` 还覆盖聊天或工具入口，暂不与缓存实现测试合并。
- 当前未发现同时满足同一生产入口、同一输入边界、同一结果断言的删除候选；优先抽取共享 fixture/构造器，不移动测试文件。

| 文件 | 类型 | 层级 | owner | 声明数 | 外部依赖 | skip | 处置依据 |
|---|---|---|---|---:|---|---|---|
| backend/tests/test_agent_file_folder_parity.py | pytest | L1 | backend/storage | 6 | 否 | 否 | 保留 backend/storage 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_attachment_gc.py | pytest | L1 | backend/storage | 11 | 是 | 否 | 保留 backend/storage 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_chat_attach_video.py | pytest | L1 | backend/storage | 51 | 否 | 否 | 保留 backend/storage 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_file_readers.py | pytest | L1 | backend/storage | 9 | 否 | 否 | 保留 backend/storage 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_file_service.py | pytest | L1 | backend/storage | 32 | 是 | 否 | 保留 backend/storage 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_file_upload_service.py | pytest | L1 | backend/storage | 1 | 否 | 否 | 保留 backend/storage 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_file_write_safety.py | pytest | L1 | backend/storage | 6 | 否 | 否 | 保留 backend/storage 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_files_api.py | pytest | L1 | backend/storage | 11 | 否 | 否 | 保留 backend/storage 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_folder_doctor.py | pytest | L1 | backend/storage | 16 | 是 | 否 | 保留 backend/storage 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_folder_storage_relocation.py | pytest | L1 | backend/storage | 1 | 否 | 否 | 保留 backend/storage 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_folder_tree.py | pytest | L1 | backend/storage | 22 | 否 | 否 | 保留 backend/storage 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_folders_api.py | pytest | L1 | backend/storage | 11 | 否 | 否 | 保留 backend/storage 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_io_retry_contract.py | pytest | L1 | backend/storage | 23 | 是 | 否 | 保留 backend/storage 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_key_strategy.py | pytest | L1 | backend/storage | 4 | 否 | 否 | 保留 backend/storage 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_path_migration.py | pytest | L1 | backend/storage | 3 | 否 | 否 | 保留 backend/storage 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_send_file_url_streaming.py | pytest | L1 | backend/storage | 7 | 否 | 否 | 保留 backend/storage 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_storage_cleanup.py | pytest | L1 | backend/storage | 5 | 是 | 否 | 保留 backend/storage 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_storage_contract.py | pytest | L1 | backend/storage | 15 | 是 | 否 | 保留 backend/storage 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_storage_keys.py | pytest | L1 | backend/storage | 8 | 否 | 否 | 保留 backend/storage 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_storage_quota_ledger.py | pytest | L1 | backend/storage | 3 | 否 | 否 | 保留 backend/storage 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_storage_snapshots.py | pytest | L1 | backend/storage | 5 | 是 | 否 | 保留 backend/storage 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_tool_video_media_dispatch.py | pytest | L1 | backend/storage | 2 | 否 | 否 | 保留 backend/storage 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_trash_folders.py | pytest | L1 | backend/storage | 13 | 是 | 否 | 保留 backend/storage 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_video_cache.py | pytest | L1 | backend/storage | 15 | 是 | 否 | 保留 backend/storage 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_web_download.py | pytest | L1 | backend/storage | 3 | 否 | 否 | 保留 backend/storage 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| frontend/e2e/file-drag-runtime.spec.ts | Playwright | L3 | frontend/e2e | 13 | 是 | 是 | 保留实验 E2E；含环境数据 skip，不进入稳定 CI |
| frontend/e2e/file-lifecycle.spec.ts | Playwright | L3 | frontend/e2e | 1 | 是 | 否 | 保留稳定 E2E；验证真实浏览器入口 |
| frontend/e2e/filesystem-phases.spec.ts | Playwright | L3 | frontend/e2e | 10 | 是 | 是 | 保留实验 E2E；含环境数据 skip，不进入稳定 CI |
| frontend/src/assets/styles/file-browser-visual-regression.test.ts | Vitest | L0 | frontend/storage | 20 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/src/utils/fileLinks.test.ts | Vitest | L0 | frontend/storage | 4 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/src/views/Admin/Ops/storageChart.test.ts | Vitest | L0 | frontend/storage | 1 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/test/fileActionsScope.test.ts | Vitest | L0 | frontend/storage | 3 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/test/fileParse.test.ts | Vitest | L0 | frontend/storage | 7 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/test/fileProjection.test.ts | Vitest | L0 | frontend/storage | 2 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/test/fileRuntimeMove.test.ts | Vitest | L0 | frontend/storage | 5 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/test/fileSelection.test.ts | Vitest | L0 | frontend/storage | 6 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/test/fileSize.test.ts | Vitest | L0 | frontend/storage | 5 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/test/filesNav.test.ts | Vitest | L0 | frontend/storage | 14 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/test/fileUploadController.test.ts | Vitest | L0 | frontend/storage | 3 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/test/folderKeys.test.ts | Vitest | L0 | frontend/storage | 5 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/test/projectFileSorting.test.ts | Vitest | L0 | frontend/storage | 2 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/test/projectFolderCards.test.ts | Vitest | L0 | frontend/storage | 5 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| loopscope/packages/storage/src/parity.test.ts | Node/TS | L1 | loopscope/runtime | 1 | 否 | 否 | 保留 TS/Node 独立运行时边界，不与 Python pytest 合并 |
| loopscope/packages/storage/src/store.test.ts | Node/TS | L1 | loopscope/runtime | 2 | 否 | 否 | 保留 TS/Node 独立运行时边界，不与 Python pytest 合并 |

## Agent/Provider（agent-provider）

资产数：34；源码声明数：259；待审查重复候选：0（未自动判定删除）。

### 初步审查

- 初步分组：provider 适配与历史渲染、Agent loop/stream 生命周期、工具注册与 schema 校验、能力注入与 selector、模型偏好/管理 API、诊断脚本与终端流式入口。
- `test_providers.py` 与 `test_provider_history.py` 分别验证 provider 适配能力和历史消息渲染；`test_core_loop_characterization.py`、`test_stream_round_retry.py`、`test_stream_sanitize.py` 分别锁定 loop 特征、单轮重试和流输出清洗，不按“都涉及模型调用”合并。
- `test_tool_schema_validation.py`、`test_tool_schema_security_contract.py`、`test_tool_schema_digest.py` 分别覆盖通用 Schema 校验、高风险工具约束和稳定摘要；`test_tool_isolation.py`、`test_tool_intent_guard.py` 验证工具隔离与意图守卫，输入边界和安全责任不同。
- 真实 provider/长链路诊断脚本与 L1 单元测试保持独立；诊断脚本用于观测外部模型、缓存和 schema 累积，不作为 pytest 用例合并。当前没有满足同一生产入口、同一输入边界、同一结果断言的删除候选。

| 文件 | 类型 | 层级 | owner | 声明数 | 外部依赖 | skip | 处置依据 |
|---|---|---|---|---:|---|---|---|
| backend/scripts/diagnostics/test_full_agent_flow.py | 诊断脚本 | L2 | backend/diagnostics | 0 | 否 | 否 | 保留独立诊断入口；观测外部服务或长链路，不并入标准测试 |
| backend/scripts/diagnostics/test_full_schema_compact_ab.py | 诊断脚本 | L2 | backend/diagnostics | 0 | 是 | 否 | 保留独立诊断入口；观测外部服务或长链路，不并入标准测试 |
| backend/scripts/diagnostics/test_minimax_null_fields.py | 诊断脚本 | L2 | backend/diagnostics | 0 | 否 | 否 | 保留独立诊断入口；观测外部服务或长链路，不并入标准测试 |
| backend/scripts/diagnostics/test_schema_accumulation_5tools.py | 诊断脚本 | L2 | backend/diagnostics | 0 | 是 | 否 | 保留独立诊断入口；观测外部服务或长链路，不并入标准测试 |
| backend/tests/test_agent_prompt_language.py | pytest | L1 | backend/agent-provider | 2 | 否 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_behaviors.py | pytest | L1 | backend/agent-provider | 3 | 否 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_capability_injection.py | pytest | L1 | backend/agent-provider | 16 | 否 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_capability_registry.py | pytest | L1 | backend/agent-provider | 5 | 否 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_capability_selector.py | pytest | L1 | backend/agent-provider | 5 | 否 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_commands.py | pytest | L1 | backend/agent-provider | 19 | 否 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_core_continuation_recovery.py | pytest | L1 | backend/agent-provider | 2 | 否 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_core_loop_characterization.py | pytest | L1 | backend/agent-provider | 24 | 是 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_deep_research_providers.py | pytest | L1 | backend/agent-provider | 3 | 否 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_genstream_cancel.py | pytest | L1 | backend/agent-provider | 1 | 是 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_live_stream.py | pytest | L1 | backend/agent-provider | 5 | 是 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_llm15_preferences_api.py | pytest | L1 | backend/agent-provider | 6 | 否 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_llm7_p3.py | pytest | L1 | backend/agent-provider | 7 | 否 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_local_deployment_admin.py | pytest | L1 | backend/agent-provider | 4 | 否 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_loop_driver_vision.py | pytest | L1 | backend/agent-provider | 10 | 否 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_mind_agent_tools.py | pytest | L1 | backend/agent-provider | 11 | 否 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_preferences_api_contract.py | pytest | L1 | backend/agent-provider | 4 | 是 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_provider_history.py | pytest | L1 | backend/agent-provider | 5 | 否 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_providers.py | pytest | L1 | backend/agent-provider | 37 | 否 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_runner_collect.py | pytest | L1 | backend/agent-provider | 14 | 是 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_schema_diagnostic_validation.py | pytest | L1 | backend/agent-provider | 3 | 否 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_stream_round_retry.py | pytest | L1 | backend/agent-provider | 4 | 否 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_stream_sanitize.py | pytest | L1 | backend/agent-provider | 3 | 否 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_terminal_streaming.py | pytest | L2 | backend/agent-provider | 3 | 否 | 否 | 保留 backend/agent-provider 的 L2 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_tool_intent_guard.py | pytest | L1 | backend/agent-provider | 7 | 否 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_tool_isolation.py | pytest | L1 | backend/agent-provider | 24 | 否 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_tool_schema_digest.py | pytest | L1 | backend/agent-provider | 1 | 否 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_tool_schema_validation.py | pytest | L1 | backend/agent-provider | 21 | 是 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_user_skills.py | pytest | L1 | backend/agent-provider | 8 | 否 | 否 | 保留 backend/agent-provider 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| frontend/src/utils/byokCredentials.test.ts | Vitest | L0 | frontend/agent-provider | 2 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |

## RAG/Memory（memory-rag）

资产数：34；源码声明数：186；待审查重复候选：0（未自动判定删除）。

### 初步审查

- 初步分组：knowledge/event memory 写入与迁移、记忆作用域和注入预算、RAG 索引/缓存/GC、召回与混合排序、搜索 API/工具、TS sidecar 协议与前端日历拖拽。
- `test_knowledge.py`、`test_event_memory.py`、`test_memory_migration.py` 验证不同记忆来源和数据迁移；`test_memory_injection_budget.py`、`test_rag_injection.py` 验证注入边界与渲染，不与存储或召回实现测试合并。
- `test_rag_index.py`、`test_rag_index_gc.py`、`test_knowledge_index_cache.py`、`test_rag_vector_cache.py` 分别覆盖索引失效、过期清理、知识索引缓存和向量缓存；缓存对象与生命周期不同，暂不合并。
- `test_rag_retriever.py`、`test_rag_hybrid.py`、`test_search_query.py`、`test_global_search.py`、`test_search_tools.py` 分别锁定召回服务、排序合并、查询规范化、REST 搜索和工具入口；API/工具测试保留对外错误映射边界。
- 当前未发现同时满足同一生产入口、同一输入边界、同一结果断言的删除候选；Python memory/RAG 与 backend/ts sidecar 保持独立执行。

| 文件 | 类型 | 层级 | owner | 声明数 | 外部依赖 | skip | 处置依据 |
|---|---|---|---|---:|---|---|---|
| backend/tests/test_compare_index_metrics.py | pytest | L1 | backend/memory-rag | 1 | 否 | 否 | 保留 backend/memory-rag 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_event_memory.py | pytest | L1 | backend/memory-rag | 7 | 否 | 否 | 保留 backend/memory-rag 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_global_search.py | pytest | L1 | backend/memory-rag | 13 | 否 | 否 | 保留 backend/memory-rag 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_knowledge_index_cache.py | pytest | L1 | backend/memory-rag | 6 | 否 | 否 | 保留 backend/memory-rag 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_knowledge.py | pytest | L1 | backend/memory-rag | 13 | 否 | 否 | 保留 backend/memory-rag 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_memory_event_scopes.py | pytest | L1 | backend/memory-rag | 3 | 否 | 否 | 保留 backend/memory-rag 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_memory_injection_budget.py | pytest | L1 | backend/memory-rag | 3 | 否 | 否 | 保留 backend/memory-rag 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_memory_migration.py | pytest | L1 | backend/memory-rag | 25 | 是 | 否 | 保留 backend/memory-rag 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_memory_periodic.py | pytest | L1 | backend/memory-rag | 4 | 否 | 否 | 保留 backend/memory-rag 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_rag_daily_freshness.py | pytest | L1 | backend/memory-rag | 2 | 否 | 否 | 保留 backend/memory-rag 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_rag_hybrid.py | pytest | L1 | backend/memory-rag | 2 | 否 | 否 | 保留 backend/memory-rag 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_rag_index_gc.py | pytest | L1 | backend/memory-rag | 1 | 是 | 否 | 保留 backend/memory-rag 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_rag_index.py | pytest | L1 | backend/memory-rag | 3 | 否 | 否 | 保留 backend/memory-rag 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_rag_injection.py | pytest | L1 | backend/memory-rag | 10 | 是 | 否 | 保留 backend/memory-rag 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_rag_memory_service.py | pytest | L1 | backend/memory-rag | 7 | 是 | 否 | 保留 backend/memory-rag 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_rag_models.py | pytest | L1 | backend/memory-rag | 3 | 否 | 否 | 保留 backend/memory-rag 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_rag_retriever.py | pytest | L1 | backend/memory-rag | 13 | 否 | 否 | 保留 backend/memory-rag 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_rag_tokenizer_parity.py | pytest | L1 | backend/memory-rag | 1 | 否 | 否 | 保留 backend/memory-rag 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_rag_ts_sidecar.py | pytest | L1 | backend/memory-rag | 5 | 否 | 否 | 保留 backend/memory-rag 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_rag_vector_cache.py | pytest | L1 | backend/memory-rag | 1 | 否 | 否 | 保留 backend/memory-rag 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_scoped_store.py | pytest | L1 | backend/memory-rag | 4 | 是 | 否 | 保留 backend/memory-rag 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_search_query.py | pytest | L1 | backend/memory-rag | 4 | 否 | 否 | 保留 backend/memory-rag 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_search_scenarios.py | pytest | L1 | backend/memory-rag | 8 | 是 | 否 | 保留 backend/memory-rag 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_search_settings.py | pytest | L1 | backend/memory-rag | 2 | 否 | 否 | 保留 backend/memory-rag 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_search_tools.py | pytest | L1 | backend/memory-rag | 1 | 否 | 否 | 保留 backend/memory-rag 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_searxng_search_status.py | pytest | L1 | backend/memory-rag | 18 | 是 | 否 | 保留 backend/memory-rag 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_stance_history.py | pytest | L1 | backend/memory-rag | 2 | 否 | 否 | 保留 backend/memory-rag 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/ts/packages/data-runtime/test/rag-loader.test.ts | Node/TS | L1 | backend/ts | 3 | 否 | 否 | 保留 TS/Node 独立运行时边界，不与 Python pytest 合并 |
| backend/ts/workers/rag/test/index-cache-service.test.ts | Node/TS | L1 | backend/ts | 1 | 否 | 否 | 保留 TS/Node 独立运行时边界，不与 Python pytest 合并 |
| backend/ts/workers/rag/test/rag-service.test.ts | Node/TS | L1 | backend/ts | 2 | 否 | 否 | 保留 TS/Node 独立运行时边界，不与 Python pytest 合并 |
| backend/ts/workers/rag/test/snapshot-cache.test.ts | Node/TS | L1 | backend/ts | 2 | 否 | 否 | 保留 TS/Node 独立运行时边界，不与 Python pytest 合并 |
| backend/ts/workers/rag/test/source-adapters.test.ts | Node/TS | L1 | backend/ts | 4 | 否 | 否 | 保留 TS/Node 独立运行时边界，不与 Python pytest 合并 |
| backend/ts/workers/rag/test/worker.protocol.test.ts | Node/TS | L1 | backend/ts | 9 | 否 | 否 | 保留 TS/Node 独立运行时边界，不与 Python pytest 合并 |
| frontend/src/views/Calendar/composables/useCalendarDrag.test.ts | Vitest | L0 | frontend/memory-rag | 3 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |

## Mind/项目（mind-project）

资产数：23；源码声明数：201；待审查重复候选：0（未自动判定删除）。

### 初步审查

- 初步分组：项目核心服务与 live events、Mind API 与工具、画布领域模型/布局、前端画布几何与竞态、项目阶段/待办纯逻辑。
- `test_mind_api.py`、`test_mind_canvas_tools.py`、`test_mind_p0_model.py` 分别覆盖 REST、Agent 工具入口和核心模型契约；项目服务测试与前端 project mapper/stages/todos 测试不跨运行时合并。
- 前端 `useMindEditor`、画布几何/测量/连接注册表和 `mindCanvasRace` 分别锁定编辑器状态、几何计算、运行时连接与竞态；相邻实现不同，不以相似命名合并。
- 当前未发现满足同一生产入口、同一输入边界、同一结果断言的删除候选；Playwright 画布运行时继续独立于纯逻辑测试。

| 文件 | 类型 | 层级 | owner | 声明数 | 外部依赖 | skip | 处置依据 |
|---|---|---|---|---:|---|---|---|
| backend/scripts/diagnostics/test_reminder_role_cache.py | 诊断脚本 | L2 | backend/diagnostics | 0 | 否 | 否 | 保留独立诊断入口；观测外部服务或长链路，不并入标准测试 |
| backend/tests/test_canvas_layout.py | pytest | L1 | backend/mind-project | 4 | 否 | 否 | 保留 backend/mind-project 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_mind_api.py | pytest | L1 | backend/mind-project | 32 | 是 | 否 | 保留 backend/mind-project 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_mind_canvas_tools.py | pytest | L1 | backend/mind-project | 21 | 是 | 否 | 保留 backend/mind-project 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_mind_p0_model.py | pytest | L1 | backend/mind-project | 24 | 是 | 否 | 保留 backend/mind-project 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_projects_core.py | pytest | L1 | backend/mind-project | 10 | 否 | 否 | 保留 backend/mind-project 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_projects_live_events.py | pytest | L1 | backend/mind-project | 1 | 否 | 否 | 保留 backend/mind-project 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| frontend/e2e/mind-canvas-runtime.spec.ts | Playwright | L3 | frontend/e2e | 2 | 是 | 否 | 保留稳定 E2E；验证真实浏览器入口 |
| frontend/src/composables/useMindCanvas.test.ts | Vitest | L0 | frontend/mind-project | 2 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/src/composables/useMindEditor.test.ts | Vitest | L0 | frontend/mind-project | 41 | 是 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/src/utils/canvasRelationGeometry.test.ts | Vitest | L0 | frontend/mind-project | 2 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/src/views/Mind/utils/canvasItemMeasurements.test.ts | Vitest | L0 | frontend/mind-project | 1 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/src/views/Mind/utils/relationRuntimeConnection.test.ts | Vitest | L0 | frontend/mind-project | 2 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/src/views/Mind/utils/relationRuntimeRegistry.test.ts | Vitest | L0 | frontend/mind-project | 1 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/test/canvasViewport.test.ts | Vitest | L0 | frontend/mind-project | 2 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/test/mindCanvasObjectId.test.ts | Vitest | L0 | frontend/mind-project | 3 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/test/mindCanvasRace.test.ts | Vitest | L0 | frontend/mind-project | 5 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/test/projectDrop.test.ts | Vitest | L0 | frontend/mind-project | 4 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/test/projectMapper.test.ts | Vitest | L0 | frontend/mind-project | 2 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/test/projectProgress.test.ts | Vitest | L0 | frontend/mind-project | 6 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/test/projectStages.test.ts | Vitest | L0 | frontend/mind-project | 31 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/test/projectStagesComposable.test.ts | Vitest | L0 | frontend/mind-project | 1 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/test/projectTodos.test.ts | Vitest | L0 | frontend/mind-project | 4 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |

## 系统安全（security）

资产数：24；源码声明数：168；待审查重复候选：0（未自动判定删除）。

### 初步审查

- 初步分组：认证/cookie、账户与 ownership、BYOK/配置密钥、确认门、上传与 URL 安全、错误脱敏、风险策略与保留策略、前端边界回归。
- `test_ownership.py` 与 `test_chat_attachments_ownership.py` 都涉及归属校验，但前者验证通用 ownership 边界，后者验证附件资源链路；`test_confirm_gate.py` 与 `test_upload_confirm.py` 分别是通用危险动作门和上传确认入口。
- `test_byok_config_override.py`、`test_byok_security_phase4.py`、`test_config_password_override.py`、`test_config_reconcile.py` 的配置来源、密钥保护和迁移责任不同；不因都读取配置而合并。
- 当前未发现满足同一生产入口、同一输入边界、同一结果断言的删除候选；安全测试维持独立断言，禁止用共享 fixture 隐藏越权或脱敏差异。

| 文件 | 类型 | 层级 | owner | 声明数 | 外部依赖 | skip | 处置依据 |
|---|---|---|---|---:|---|---|---|
| backend/tests/test_account_status.py | pytest | L1 | backend/security | 1 | 否 | 否 | 保留 backend/security 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_admin_auth_defaults.py | pytest | L1 | backend/security | 2 | 否 | 否 | 保留 backend/security 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_admin_risk_users.py | pytest | L1 | backend/security | 3 | 否 | 否 | 保留 backend/security 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_agent_admin_models.py | pytest | L1 | backend/security | 2 | 否 | 否 | 保留 backend/security 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_agent_admin_usage.py | pytest | L1 | backend/security | 5 | 否 | 否 | 保留 backend/security 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_auth_cookies.py | pytest | L1 | backend/security | 4 | 否 | 否 | 保留 backend/security 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_byok_config_override.py | pytest | L1 | backend/security | 2 | 否 | 否 | 保留 backend/security 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_byok_security_phase4.py | pytest | L1 | backend/security | 8 | 是 | 否 | 保留 backend/security 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_chat_attachments_ownership.py | pytest | L1 | backend/security | 25 | 是 | 否 | 保留 backend/security 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_config_password_override.py | pytest | L1 | backend/security | 11 | 是 | 否 | 保留 backend/security 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_config_reconcile.py | pytest | L1 | backend/security | 4 | 否 | 否 | 保留 backend/security 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_confirm_gate.py | pytest | L1 | backend/security | 12 | 否 | 否 | 保留 backend/security 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_error_redaction_contract.py | pytest | L1 | backend/security | 11 | 是 | 否 | 保留 backend/security 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_onboarding_state.py | pytest | L1 | backend/security | 3 | 否 | 否 | 保留 backend/security 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_ownership_security_events.py | pytest | L1 | backend/security | 3 | 否 | 否 | 保留 backend/security 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_ownership.py | pytest | L1 | backend/security | 6 | 否 | 否 | 保留 backend/security 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_security_alerts.py | pytest | L1 | backend/security | 2 | 否 | 否 | 保留 backend/security 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_security_retention.py | pytest | L1 | backend/security | 1 | 否 | 否 | 保留 backend/security 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_security_risk_policy.py | pytest | L1 | backend/security | 7 | 是 | 否 | 保留 backend/security 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_tool_schema_security_contract.py | pytest | L1 | backend/security | 15 | 否 | 否 | 保留 backend/security 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_upload_confirm.py | pytest | L1 | backend/security | 12 | 否 | 否 | 保留 backend/security 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| backend/tests/test_url_security.py | pytest | L1 | backend/security | 13 | 否 | 否 | 保留 backend/security 的 L1 契约；与 API、E2E 或其他领域入口分层 |
| frontend/src/assets/styles/onboarding-focus-regression.test.ts | Vitest | L0 | frontend/security | 15 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |
| frontend/test/accountBoundary.test.ts | Vitest | L0 | frontend/security | 1 | 否 | 否 | 保留前端 L0；按纯逻辑/样式/组件契约独立执行 |

## 独立 TypeScript 测试

backend/ts 和 loopscope 保持独立执行与统计，不与 Python pytest 合并或移动。

| 文件 | owner | 层级 | 声明数 | 初步处理 |
|---|---|---|---:|---|
| backend/ts/packages/data-runtime/test/cache.test.ts | backend/ts | L1 | 3 | 保留独立边界，待审查重复契约 |
| backend/ts/packages/data-runtime/test/contracts.test.ts | backend/ts | L1 | 1 | 保留独立边界，待审查重复契约 |
| backend/ts/packages/data-runtime/test/documents.test.ts | backend/ts | L1 | 2 | 保留独立边界，待审查重复契约 |
| backend/ts/packages/data-runtime/test/invalidation.test.ts | backend/ts | L1 | 2 | 保留独立边界，待审查重复契约 |
| backend/ts/packages/data-runtime/test/rag-loader.test.ts | backend/ts | L1 | 3 | 保留独立边界，待审查重复契约 |
| backend/ts/packages/data-runtime/test/runtime.test.ts | backend/ts | L1 | 6 | 保留独立边界，待审查重复契约 |
| backend/ts/workers/rag/test/index-cache-service.test.ts | backend/ts | L1 | 1 | 保留独立边界，待审查重复契约 |
| backend/ts/workers/rag/test/rag-service.test.ts | backend/ts | L1 | 2 | 保留独立边界，待审查重复契约 |
| backend/ts/workers/rag/test/snapshot-cache.test.ts | backend/ts | L1 | 2 | 保留独立边界，待审查重复契约 |
| backend/ts/workers/rag/test/source-adapters.test.ts | backend/ts | L1 | 4 | 保留独立边界，待审查重复契约 |
| backend/ts/workers/rag/test/worker.protocol.test.ts | backend/ts | L1 | 9 | 保留独立边界，待审查重复契约 |
| loopscope/apps/collector/src/server.test.ts | loopscope/runtime | L1 | 1 | 保留独立边界，待审查重复契约 |
| loopscope/packages/db/src/index.test.ts | loopscope/runtime | L1 | 2 | 保留独立边界，待审查重复契约 |
| loopscope/packages/storage/src/parity.test.ts | loopscope/runtime | L1 | 1 | 保留独立边界，待审查重复契约 |
| loopscope/packages/storage/src/store.test.ts | loopscope/runtime | L1 | 2 | 保留独立边界，待审查重复契约 |

## 领域审查结论

- 复核人：
- 复核日期：
- 确认合并项：
- 确认删除项：
- 需要抽取的 fixture/构造器：
- 需要迁移的目录：
