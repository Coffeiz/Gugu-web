# 测试清单详细测试项

> 由 `scripts/tests/generate-test-details.mjs` 根据测试源码生成。用于 Phase 0 人工复核职责、内容和潜在重复，不替代运行器实际收集结果。

- 清单来源：`docs/reports/2026-08-31-TEST-INVENTORY.json`
- 条目数：21

### backend/tests/test_anthropic_roundtrip.py

- 类型/层级：pytest / L1
- 自动领域/owner：other / 待确认
- 源码声明数：4；无外部依赖；无 skip
- 测试项：
- test_anthropic_tool_round_preserves_all_response_blocks_and_signature
- test_anthropic_tool_round_drops_unprocessed_parallel_tool_uses
- test_anthropic_structure_probe_contains_only_safe_structure_and_digest
- test_anthropic_structure_digest_detects_non_identical_roundtrip

### backend/tests/test_compose_bootstrap.py

- 类型/层级：pytest / L1
- 自动领域/owner：other / 待确认
- 源码声明数：3；无外部依赖；无 skip
- 测试项：
- test_validate_required_config_reports_actionable_missing_secret
- test_validate_required_config_reports_unwritable_data_dir
- test_ensure_admin_password_appends_once_and_preserves_existing_field

### backend/tests/test_email_admin.py

- 类型/层级：pytest / L1
- 自动领域/owner：other / 待确认
- 源码声明数：6；有外部依赖；无 skip
- 测试项：
- test_admin_email_preview_uses_shared_template_and_returns_plain_text
- test_admin_email_test_recipient_rejects_invalid_address
- test_translation_drops_model_added_blocks_and_buttons_when_source_is_empty
- test_translation_keeps_source_action_urls_and_discards_extra_items
- test_translation_payload_fills_optional_fields_and_source_action_urls
- test_translation_payload_falls_back_to_source_for_empty_required_fields

### backend/tests/test_email_capabilities.py

- 类型/层级：pytest / L1
- 自动领域/owner：other / 待确认
- 源码声明数：2；无外部依赖；无 skip
- 测试项：
- test_system_email_requires_complete_admin_smtp_configuration
- test_system_email_capability_is_available_only_when_admin_smtp_is_enabled

### backend/tests/test_email_change.py

- 类型/层级：pytest / L1
- 自动领域/owner：other / 待确认
- 源码声明数：2；无外部依赖；无 skip
- 测试项：
- test_normalize_email_rejects_display_names_and_invalid_addresses
- test_email_change_request_does_not_modify_user_and_replaces_old_request

### backend/tests/test_email_templates.py

- 类型/层级：pytest / L1
- 自动领域/owner：other / 待确认
- 源码声明数：6；无外部依赖；无 skip
- 测试项：
- test_notification_renders_standard_html_and_plain_fallback
- test_builtin_images_use_cid_inline_resources_for_mail_clients
- test_actions_use_email_compatible_standard_button_shell
- test_template_escapes_content_and_rejects_unsafe_action_url
- test_test_template_is_available
- test_phase2_templates_share_the_same_compatible_shell

### backend/tests/test_email_tool.py

- 类型/层级：pytest / L1
- 自动领域/owner：other / 待确认
- 源码声明数：16；无外部依赖；无 skip
- 测试项：
- test_send_email_defaults_to_registered_email_and_requires_confirmation
- test_send_email_uses_client_email_after_confirmation
- test_send_email_passes_optional_html_version
- test_send_email_passes_semantic_template_fields
- test_send_email_confirmation_binds_structured_payload
- test_send_email_accepts_every_standard_template
- test_send_email_passes_owned_custom_smtp
- test_send_email_returns_structured_smtp_failure
- test_send_email_has_a_total_delivery_timeout
- test_scheduled_email_uses_task_authorization_without_confirmation
- test_send_email_rejects_other_users_client
- test_send_email_rejects_ambiguous_recipient
- test_build_msg_creates_plain_text_and_sanitized_html_alternative
- test_email_sanitizer_keeps_safe_layout_attributes_and_drops_unsafe_values
- test_email_images_allow_only_controlled_cid
- test_build_msg_attaches_cid_images_as_inline_related_parts

### backend/tests/test_greeting_cache.py

- 类型/层级：pytest / L1
- 自动领域/owner：other / 待确认
- 源码声明数：1；有外部依赖；无 skip
- 测试项：
- test_greeting_reuses_cached_text_for_ten_minutes

### backend/tests/test_line_edit.py

- 类型/层级：pytest / L1
- 自动领域/owner：other / 待确认
- 源码声明数：6；无外部依赖；无 skip
- 测试项：
- test_line_edit_accepts_single_dash_and_bash_comma_ranges
- test_line_edit_applies_multiple_ranges_from_bottom
- test_line_edit_rejects_invalid_ranges
- test_line_edit_rejects_overlapping_ranges
- test_line_edit_rejects_missing_or_stale_expected_text
- test_numbered_lines_describes_raw_physical_lines

### backend/tests/test_model_reasoning_policy.py

- 类型/层级：pytest / L1
- 自动领域/owner：other / 待确认
- 源码声明数：2；无外部依赖；无 skip
- 测试项：
- test_run_policy_comes_from_selected_model
- test_missing_model_policy_defaults_to_off

### backend/tests/test_phase2_reasoning_drivers.py

- 类型/层级：pytest / L1
- 自动领域/owner：other / 待确认
- 源码声明数：3；无外部依赖；无 skip
- 测试项：
- test_anthropic_state_extract_restore_is_exact_and_provider_only
- test_chat_completions_does_not_claim_responses_continuation
- test_responses_driver_uses_response_chain_and_function_call_items

### backend/tests/test_phase3_filesystem_policy.py

- 类型/层级：pytest / L1
- 自动领域/owner：storage / backend/storage
- 源码声明数：7；无外部依赖；含 skip，需人工确认触发条件
- 测试项：
- test_workspace_policy_allows_only_workspace_folder_subtree
- test_full_grant_allows_personal_and_project_file_writes
- test_agent_file_create_is_read_only_without_session_grant
- test_web_download_checks_write_policy_before_fetching
- test_scheduled_task_file_policy_uses_task_subject
- test_script_path_rejects_absolute_traversal_and_platform_separators
- test_script_file_rejects_symlink_and_hardlink

### backend/tests/test_public_config.py

- 类型/层级：pytest / L1
- 自动领域/owner：other / 待确认
- 源码声明数：2；无外部依赖；无 skip
- 测试项：
- test_site_config_hides_password_reset_without_smtp
- test_site_config_exposes_only_password_reset_capability

### backend/tests/test_reasoning_state.py

- 类型/层级：pytest / L1
- 自动领域/owner：other / 待确认
- 源码声明数：11；无外部依赖；无 skip
- 测试项：
- test_policy_has_single_safe_boundary
- test_coordinator_diagnostics_distinguish_state_lifecycle
- test_envelope_fingerprints_payload_but_metadata_excludes_it
- test_commit_load_encrypts_and_isolated_from_canonical_history
- test_stale_run_cannot_overwrite_newer_state
- test_owner_cannot_read_another_users_session_state
- test_expired_and_changed_state_is_invalidated_without_replay
- test_off_and_summary_never_replay_provider_payload
- test_summary_can_store_only_restricted_metrics
- test_expire_and_explicit_delete_contract
- test_delete_session_deletes_provider_state

### backend/tests/test_romaji.py

- 类型/层级：pytest / L1
- 自动领域/owner：other / 待确认
- 源码声明数：4；无外部依赖；无 skip
- 测试项：
- test_to_romaji_uses_sudachi_reading_and_normalizes_romkan_output
- test_to_romaji_keeps_chinese_pinyin_flow_without_japanese_converter
- test_romaji_match_accepts_japanese_reading_for_pure_kanji
- test_to_romaji_uses_japanese_dictionary_for_japanese_locale

### backend/tests/test_shell_sandbox.py

- 类型/层级：pytest / L1
- 自动领域/owner：terminal-runtime / backend/terminal-runtime
- 源码声明数：16；无外部依赖；含 skip，需人工确认触发条件
- 测试项：
- test_local_sandbox_rejects_shell_operators
- test_local_sandbox_rejects_workspace_files_as_interpreter_input
- test_local_sandbox_rejects_interpreter_eval_mode
- test_local_sandbox_still_allows_reading_workspace_files_without_interpreter
- test_system_executor_can_run_workspace_script_inputs_without_sandbox_restriction
- test_local_sandbox_runs_inside_workspace
- test_local_sandbox_returns_shell_error_for_missing_command
- test_local_sandbox_cleans_up_timeout
- test_local_sandbox_truncates_output_and_rejects_escape
- test_local_sandbox_rejects_symlink_argument_escape
- test_local_sandbox_rejects_windows_style_traversal
- test_local_sandbox_rechecks_authorization_during_execution
- test_local_sandbox_rejects_symlink_escape
- test_local_sandbox_rejects_hardlink_to_outside_file
- test_local_sandbox_rejects_direct_file_symlink_to_outside
- test_local_sandbox_allows_proc_word_but_not_proc_absolute_path

### backend/tests/test_usage_trends_user_tz.py

- 类型/层级：pytest / L1
- 自动领域/owner：other / 待确认
- 源码声明数：1；无外部依赖；无 skip
- 测试项：
- test_usage_trends_groups_days_by_user_timezone

### backend/tests/test_usage.py

- 类型/层级：pytest / L1
- 自动领域/owner：other / 待确认
- 源码声明数：2；无外部依赖；无 skip
- 测试项：
- test_record_current_usage_uses_user_context
- test_record_current_usage_without_context_is_ignored

### backend/tests/test_user_smtp_api.py

- 类型/层级：pytest / L1
- 自动领域/owner：other / 待确认
- 源码声明数：1；无外部依赖；无 skip
- 测试项：
- test_get_user_smtp_uses_service_query_without_handler_name_collision

### frontend/e2e/file-drag-runtime.spec.ts

- 类型/层级：playwright / L3
- 自动领域/owner：storage / frontend/e2e
- 源码声明数：13；有外部依赖；含 skip，需人工确认触发条件
- 测试项：
- 单文件拖入文件夹
- 单文件拖到面包屑返回上一层
- 底部拖拽单卡不改变文件区滚动位置
- 多选两个文件拖入文件夹，落地后能正常进入目标文件夹
- 文件和文件夹混合多选后拖入文件夹
- 单文件移动遇到 409 时回滚缓存和页面
- 单文件移动被权限拒绝时回滚缓存和页面
- 多文件移动部分失败时整体回滚

### frontend/e2e/filesystem-phases.spec.ts

- 类型/层级：playwright / L3
- 自动领域/owner：storage / frontend/e2e
- 源码声明数：10；有外部依赖；含 skip，需人工确认触发条件
- 测试项：
- 阶段 1：共享展示层挂载文件库浏览壳
- 阶段 2：目录进入后可以开启统一选择模式并退出
- 阶段 2：连续 Shift 选择保持第一次点击的范围锚点
- 阶段 2：批量选择工具栏统一暴露下载、剪切、复制和删除
- 阶段 3：文件操作边界通过右键复制入口可达
- 阶段 4：上传入口与空白区域右键菜单使用共享组件
- 文件库回收站保留场景扩展且仍由通用面板承载工具栏
- 项目文件区使用通用面板并保留项目工具栏适配层
- 窄窗口下文件浏览面板不产生横向溢出

