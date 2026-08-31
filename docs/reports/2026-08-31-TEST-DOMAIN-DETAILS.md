# 测试领域详细内容

> 由 `scripts/tests/generate-domain-details.mjs` 根据测试源码生成。用于 Phase 2 逐文件核对职责和测试内容，不替代运行器实际收集结果。

## context

- 文件数：43
- 源码声明数：228

### backend/scripts/diagnostics/test_cache_mode_compare.py

- 类型/层级：diagnostic-script / L2
- owner：backend/diagnostics
- 源码声明数：0；无外部依赖；无 skip
- 测试内容：
  - test_cache_modes

### backend/scripts/diagnostics/test_cache_strategy_compare.py

- 类型/层级：diagnostic-script / L2
- owner：backend/diagnostics
- 源码声明数：0；无外部依赖；无 skip
- 测试内容：
  - 脚本入口或静态检查，无标准测试函数

### backend/scripts/diagnostics/test_cross_call_cache.py

- 类型/层级：diagnostic-script / L2
- owner：backend/diagnostics
- 源码声明数：0；外部依赖；无 skip
- 测试内容：
  - test_cross_call_cache

### backend/scripts/diagnostics/test_locale_continuous.py

- 类型/层级：diagnostic-script / L2
- owner：backend/diagnostics
- 源码声明数：0；外部依赖；无 skip
- 测试内容：
  - 脚本入口或静态检查，无标准测试函数

### backend/scripts/diagnostics/test_new_assembly.py

- 类型/层级：diagnostic-script / L2
- owner：backend/diagnostics
- 源码声明数：0；无外部依赖；无 skip
- 测试内容：
  - test_new_assembly

### backend/scripts/diagnostics/test_prefix_optimization.py

- 类型/层级：diagnostic-script / L2
- owner：backend/diagnostics
- 源码声明数：0；无外部依赖；无 skip
- 测试内容：
  - test_optimized_prefix

### backend/scripts/diagnostics/test_real_cache_optimization.py

- 类型/层级：diagnostic-script / L2
- owner：backend/diagnostics
- 源码声明数：0；无外部依赖；无 skip
- 测试内容：
  - test_cross_call_cache_with_optimization

### backend/scripts/diagnostics/test_real_session_20_run_cache_matrix.py

- 类型/层级：diagnostic-script / L2
- owner：backend/diagnostics
- 源码声明数：0；无外部依赖；无 skip
- 测试内容：
  - 脚本入口或静态检查，无标准测试函数

### backend/scripts/diagnostics/test_real_session_20_run_cache.py

- 类型/层级：diagnostic-script / L2
- owner：backend/diagnostics
- 源码声明数：0；无外部依赖；无 skip
- 测试内容：
  - 脚本入口或静态检查，无标准测试函数

### backend/scripts/diagnostics/test_session_incremental_cache.py

- 类型/层级：diagnostic-script / L2
- owner：backend/diagnostics
- 源码声明数：0；无外部依赖；无 skip
- 测试内容：
  - test_session_incremental

### backend/scripts/diagnostics/test_tool_cache_boundary.py

- 类型/层级：diagnostic-script / L2
- owner：backend/diagnostics
- 源码声明数：0；无外部依赖；无 skip
- 测试内容：
  - 脚本入口或静态检查，无标准测试函数

### backend/tests/test_agent_context_tz.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：7；无外部依赖；无 skip
- 测试内容：
  - test_build_today_uses_user_tz
  - test_build_default_falls_back_to_server_tz
  - test_build_split_includes_default_profile_policy_in_static_prompt
  - test_night_date_boundary_note_is_neutral
  - test_files_block_is_personal_library_only
  - test_project_root_folder_is_rendered
  - test_recent_notes_are_rendered_as_snapshot_context

### backend/tests/test_canonical_context.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：5；无外部依赖；无 skip
- 测试内容：
  - test_tool_call_and_result_are_one_history_unit
  - test_tool_unit_requires_matching_call_id
  - test_section_digest_changes_only_when_section_changes
  - test_history_envelope_keeps_quote_attachment_time_and_unknown_block_contract
  - test_canonical_turn_digest_is_content_based

### backend/tests/test_canonical_tool_history.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：12；无外部依赖；无 skip
- 测试内容：
  - test_schema_event_has_stable_digest_and_is_deduplicated
  - test_canonical_events_render_as_text_without_provider_wire_blocks
  - test_canonical_event_round_trips_through_persisted_history
  - test_time_reminders_round_trip_without_changing_provider_text
  - test_legacy_time_text_is_normalized_before_provider_boundary
  - test_time_context_wrapper_regression_guard_keeps_legacy_and_canonical_wire_equal
  - test_schema_event_never_shares_tool_result_message_boundary
  - test_sanitize_preserves_tool_result_and_schema_message_boundaries
  - test_canonical_event_stats_are_aggregated_without_exposing_payloads
  - test_tool_dataclasses_round_trip_provider_neutral_blocks
  - test_normalized_tool_call_reuses_canonical_tool_call_fields
  - test_canonical_tool_round_does_not_depend_on_provider_wire_shape

### backend/tests/test_compaction.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：39；外部依赖；无 skip
- 测试内容：
  - test_compaction_prompt_path_dependency_is_available
  - test_compaction_summary_loads_prompt_before_calling_llm
  - test_empty
  - test_system_only
  - test_messages_only
  - test_system_plus_messages
  - test_counts_tool_use_and_result_blocks
  - test_counts_openai_tool_calls_field
  - test_project
  - test_calendar
  - test_files
  - test_normal
  - test_summary_candidate_has_explicit_length_and_shape_contract
  - test_invalid_summary_candidate_does_not_change_messages
  - test_small_history_uses_single_branch_summary_request
  - test_oversized_history_uses_rolling_fallback
  - test_force_compaction_does_not_use_local_token_estimate
  - test_below_threshold_no_compact
  - test_compaction_result_exposes_return_reason
  - test_above_threshold_triggers_compact
  - test_preserves_system_injection
  - test_preserves_compact_summary
  - test_compaction_covers_all_messages_between_injection_and_kept
  - test_tool_turn_is_atomic_at_compaction_boundary
  - test_protected_current_run_is_not_sent_to_summary
  - test_post_run_baseline_is_coalesced_and_uses_provider_usage
  - test_session_run_lock_key_uses_canonical_session_id
  - test_baseline_cas_rejects_same_id_with_changed_hash
  - test_atomic_units_pair_anthropic_and_openai_tool_messages
  - test_atomic_units_pair_canonical_tool_messages
  - test_atomic_units_keep_all_parallel_tool_results
  - test_compaction_drops_orphan_result_before_selecting_recent_window
  - test_compaction_keeps_matching_openai_result
  - test_compaction_keeps_all_parallel_matching_results
  - test_valid_compacted
  - test_empty_messages
  - test_no_summary_marker
  - test_summary_at_wrong_position

### backend/tests/test_context_assembly.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - test_build_messages_preserves_existing_layout_and_attaches_canonical_context
  - test_assemble_is_the_shared_entry_and_keeps_compatibility_name

### backend/tests/test_context_audit.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - test_summary_audit_scope_does_not_duplicate_event_source

### backend/tests/test_context_branch.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：9；外部依赖；无 skip
- 测试内容：
  - test_context_branch_assembles_stable_order_and_json
  - test_context_branch_retries_empty_output
  - test_context_branch_classifies_provider_error
  - test_context_branch_classifies_invalid_json_shape
  - test_context_branch_classifies_blank_text_as_invalid
  - test_provider_runner_text_errors_reach_context_branch
  - test_json_branch_inherits_configured_thinking
  - test_text_branch_inherits_configured_thinking
  - test_scope_revision_is_audit_only_and_preserves_prefix

### backend/tests/test_context_budget.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：8；无外部依赖；无 skip
- 测试内容：
  - test_context_budget_uses_one_total_and_history_capacity_semantics
  - test_context_budget_from_messages_has_one_breakdown
  - test_over_budget_keeps_latest_tool_round_atomic
  - test_single_oversized_current_message_is_truncated_without_llm
  - test_valid_history_is_not_trimmed
  - test_over_budget_first_keeps_recent_twenty_messages
  - test_tool_schema_reservation_is_included_in_hard_budget
  - test_turn_batch_is_counted_during_truncation

### backend/tests/test_context_cache_boundaries.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：8；无外部依赖；无 skip
- 测试内容：
  - test_first_diff_is_structural_and_diagnostics_are_digest_only
  - test_diagnostics_reports_first_wire_difference_without_body
  - test_diagnostics_classifies_summary_wrapper_change_without_logging_body
  - test_ten_runs_keep_fixed_sections_stable_while_tail_changes
  - test_diagnostics_never_include_context_body_or_attachment_url
  - test_diagnostics_has_no_separate_tail_boundary
  - test_tool_continuation_promotes_tail_without_reordering_cache_prefix
  - test_history_cache_copy_preserves_dynamic_tail_boundary

### backend/tests/test_context_history.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：22；无外部依赖；无 skip
- 测试内容：
  - test_user_message_time_is_a_stable_separate_reminder_in_history
  - test_history_restores_quoted_text_without_rewriting_message_content
  - test_history_restores_quoted_text_for_all_im_sources_and_providers
  - test_user_message_time_stays_before_complete_tool_turn
  - test_canonical_events_do_not_split_user_turn_timestamp_boundary
  - test_anthropic_history_keeps_native_tool_blocks
  - test_anthropic_history_coerces_legacy_string_tool_arguments_to_object
  - test_openai_history_converts_anthropic_tool_turn
  - test_canonical_history_normalizes_openai_tool_turn
  - test_canonical_history_keeps_openai_tool_calls_when_content_is_null
  - test_chat_tool_events_restore_call_and_result_as_one_bubble
  - test_chat_tool_events_restore_name_when_result_is_scanned_before_call
  - test_chat_tool_events_use_tool_name_from_result_only_legacy_record
  - test_chat_tool_events_restore_registered_tool_label
  - test_chat_tool_events_unwrap_fixed_adapter_call_tool
  - test_chat_tool_events_unwrap_openai_adapter_arguments
  - test_chat_tool_events_restore_legacy_anthropic_tool_use
  - test_chat_tool_events_restores_legacy_error_result_as_error
  - test_canonical_history_marks_legacy_error_tool_result
  - test_canonical_tool_turn_is_rendered_for_both_wire_formats
  - test_history_recursively_replaces_nested_image_payloads
  - test_anthropic_history_accepts_legacy_tool_use_id_and_drops_missing_id_result

### backend/tests/test_context_revision.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：2；外部依赖；无 skip
- 测试内容：
  - test_snapshot_inputs_bump_revision_without_sse_resource
  - test_unknown_revision_source_is_ignored

### backend/tests/test_cross_run_cache_prefix.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：5；外部依赖；无 skip
- 测试内容：
  - test_provider_render_keeps_canonical_blocks_in_original_position
  - test_dynamic_tail_is_provider_only_and_always_stays_last
  - test_message_time_with_empty_canonical_projection_stays_provider_only_after_seal
  - test_legacy_persisted_time_context_rows_are_filtered
  - test_last_round_conversation_replays_as_next_run_prefix_without_dynamic_tail

### backend/tests/test_daily_compaction.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - test_split_batch_preserves_backlog_and_order
  - test_backlog_continues_after_first_batch

### backend/tests/test_history_attachment_refs.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - test_history_keeps_lightweight_image_attachment_reference

### backend/tests/test_history_persist_filter.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：10；外部依赖；无 skip
- 测试内容：
  - test_keeps_real_tool_rounds
  - test_drops_synthetic_control_user_prompts
  - test_drops_verify_round_inner_monologue
  - test_mixed_delta_keeps_only_tool_pairs_in_order
  - test_empty_and_stringonly_messages_dropped
  - test_canonical_and_openai_tool_messages_are_kept
  - test_sanitize_drops_tool_result_without_id_without_raising
  - test_sanitize_preserves_leading_system_snapshot
  - test_sanitize_keeps_user_reminder_boundary
  - test_sanitize_merges_current_time_with_same_user_message

### backend/tests/test_im_context_loader.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - test_restore_group_memory_snapshot_migrates_legacy_group_block
  - test_restore_group_memory_snapshot_does_not_duplicate_existing_block

### backend/tests/test_im_owner_session.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：5；外部依赖；无 skip
- 测试内容：
  - test_owner_session_binding_is_explicit_and_owned
  - test_owner_session_clear_removes_binding
  - test_persist_private_session_binds_the_existing_web_session
  - test_persist_private_session_accepts_the_platform_session
  - test_bind_web_session_tool_is_owner_private_only

### backend/tests/test_im_session_reuse.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：13；无外部依赖；无 skip
- 测试内容：
  - test_private_session_reused_for_same_peer
  - test_private_sessions_isolated_by_platform_user_id
  - test_private_sessions_isolated_by_bot_id
  - test_group_session_reused_for_same_chat
  - test_web_session_not_reused_by_scope
  - test_session_scope_filters_private_uses_platform_user_id
  - test_session_scope_filters_group_uses_chat_id
  - test_trim_session_messages_skips_below_threshold
  - test_trim_session_messages_trims_above_threshold
  - test_trim_session_messages_cleans_attachment_storage
  - test_session_eviction_cleans_attachment_storage
  - test_group_session_platform_user_id_is_null
  - test_private_does_not_reuse_group_session

### backend/tests/test_llm_cache_capability.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：6；无外部依赖；无 skip
- 测试内容：
  - test_minimax_m3_uses_anthropic_active_cache
  - test_minimax_m2_keeps_anthropic_active_cache
  - test_mimo_does_not_receive_anthropic_cache_control
  - test_anthropic_provider_keeps_existing_active_cache_behavior
  - test_openai_compatible_qwen_uses_active_cache
  - test_openai_mimo_skips_active_cache

### backend/tests/test_memory_compaction_retrieval.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - test_retrieve_event_references_caps_results_and_uses_owner_memory
  - test_compaction_keeps_working_when_event_recall_fails

### backend/tests/test_message_compaction_boundary.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：11；无外部依赖；无 skip
- 测试内容：
  - test_assembly_marks_snapshot_prefix
  - test_openai_provider_render_keeps_snapshot_prefix
  - test_rag_tail_is_stable_conversation_after_current_user
  - test_compaction_keeps_snapshot_prefix_out_of_summary
  - test_fixed_context_contains_only_snapshot
  - test_persisted_summary_is_first_history_message
  - test_submitted_batch_is_frozen_and_keeps_canonical_projection
  - test_prompt_messages_exposes_immutable_batch_records_for_finalize
  - test_canonical_batch_rejects_provider_wire_shape
  - test_canonical_batch_is_fixed_before_seal_and_append_updates_both_projections
  - test_inline_and_persisted_summary_keep_identical_provider_prefix

### backend/tests/test_modelctx.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - test_get_model_cfg_defaults_to_none
  - test_set_and_get_model_cfg_roundtrip

### backend/tests/test_preferences_cache_contract.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - test_personality_static_prefix_is_identical_across_all_channels
  - test_personality_stays_out_of_dynamic_tail_and_history_wrapping
  - test_disabled_personality_keeps_default_persona_and_does_not_change_security_prompt

### backend/tests/test_preferences_context_contract.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：4；无外部依赖；无 skip
- 测试内容：
  - test_style_preference_static_prefix_is_stable_across_channels
  - test_locale_rule_is_first_and_uses_the_selected_language
  - test_english_locale_reaches_the_session_prompt_used_for_reply
  - test_phase0_keeps_controlled_style_preferences_distinct_from_personality_text

### backend/tests/test_provider_history_adapters.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - test_rendering_does_not_mutate_canonical_messages_or_lose_context_metadata
  - test_openai_and_anthropic_render_same_canonical_history_without_changing_digest

### backend/tests/test_quoted_context.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - test_with_quoted_context_passthrough_when_no_quote
  - test_with_quoted_context_wraps_quoted_text_for_model

### backend/tests/test_run_context_boundaries.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - test_prepare_run_binds_rag_watermark_and_keeps_current_time_provider_only

### backend/tests/test_session_execution_gate.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：2；外部依赖；无 skip
- 测试内容：
  - test_session_gate_persists_pending_and_clears_active_state
  - test_session_gate_does_not_create_pending_without_existing_session

### backend/tests/test_session_history.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - test_load_session_history_returns_database_order
  - test_load_session_history_uses_baseline_watermark_and_keeps_summary
  - test_context_budget_reserves_fixed_context_and_turn_batch

### backend/tests/test_session_snapshot.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：30；无外部依赖；无 skip
- 测试内容：
  - test_current_time_tail_keeps_date_but_not_duplicate_clock_time
  - test_session_info_hash_is_stable_for_mapping_order
  - test_snapshot_hash_includes_each_prefix_component
  - test_memory_summary_hash_is_content_and_timestamp_based
  - test_message_hash_excludes_observability_metadata
  - test_idle_ttl_expires_only_after_deadline
  - test_snapshot_revision_is_pending_metadata_not_hit_gate
  - test_zero_snapshot_revision_is_a_valid_rag_version
  - test_legacy_snapshot_with_zero_context_revision_gets_rag_revision
  - test_ensure_snapshot_loads_once_until_ttl
  - test_ensure_snapshot_keeps_hit_when_pending_revision_changes
  - test_snapshot_serializes_zoneinfo_timezone_for_json
  - test_reminder_and_time_messages_have_stable_boundary
  - test_checkpoint_hash_chains_new_messages_without_copying_snapshot_text
  - test_snapshot_records_history_baseline_without_dropping_context_metadata
  - test_initialize_snapshot_preserves_goal_control_state
  - test_history_baseline_never_moves_back_from_session_watermark
  - test_prompt_messages_keep_turn_batch_contiguous_before_tool_round
  - test_stance_digest_only_appends_when_stance_changes
  - test_old_stance_message_is_never_removed_from_history
  - test_prompt_messages_commit_one_new_message_batch_atomically
  - test_snapshot_reminder_is_fixed_before_history_and_runtime_tail
  - test_turn_batch_keeps_stance_and_message_time_order_stable
  - test_prompt_messages_replace_conversation_preserves_batch_messages
  - test_history_cache_boundary_uses_batch_messages
  - test_history_cache_keeps_previous_checkpoint_across_round_append
  - test_history_cache_keeps_baseline_when_tool_continuation_appends
  - test_batch_messages_are_persisted_as_new_history
  - test_single_history_cache_keeps_cross_run_baseline_and_latest_anchor
  - test_snapshot_trace_events_are_redacted_and_distinguish_hit_rebuild

### backend/tests/test_session_title_prompt.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - test_session_title_prompt_follows_english_conversation_language
  - test_session_title_prompt_keeps_input_limits

### backend/tests/test_video_cache_snapshots_api.py

- 类型/层级：pytest / L1
- owner：backend/context
- 源码声明数：5；外部依赖；无 skip
- 测试内容：
  - test_storage_snapshots_groups_by_category
  - test_storage_snapshots_filters_by_days
  - test_storage_snapshots_empty_returns_empty_dict
  - test_disk_usage_none_when_oss_backend
  - test_disk_usage_returns_numbers_when_local_backend

## agent-provider

- 文件数：34
- 源码声明数：259

### backend/scripts/diagnostics/test_full_agent_flow.py

- 类型/层级：diagnostic-script / L2
- owner：backend/diagnostics
- 源码声明数：0；无外部依赖；无 skip
- 测试内容：
  - test_full_agent_canvas_creation

### backend/scripts/diagnostics/test_full_schema_compact_ab.py

- 类型/层级：diagnostic-script / L2
- owner：backend/diagnostics
- 源码声明数：0；外部依赖；无 skip
- 测试内容：
  - 脚本入口或静态检查，无标准测试函数

### backend/scripts/diagnostics/test_minimax_null_fields.py

- 类型/层级：diagnostic-script / L2
- owner：backend/diagnostics
- 源码声明数：0；无外部依赖；无 skip
- 测试内容：
  - test_minimax_with_null_fields

### backend/scripts/diagnostics/test_schema_accumulation_5tools.py

- 类型/层级：diagnostic-script / L2
- owner：backend/diagnostics
- 源码声明数：0；外部依赖；无 skip
- 测试内容：
  - 脚本入口或静态检查，无标准测试函数

### backend/tests/test_agent_prompt_language.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - test_operation_guards_use_neutral_internal_language
  - test_verification_prompt_keeps_user_facing_output_boundary

### backend/tests/test_behaviors.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - test_missing_stance_uses_baseline_only
  - test_valid_stance_replaces_baseline
  - test_expired_stance_falls_back_to_baseline

### backend/tests/test_capability_injection.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：16；无外部依赖；无 skip
- 测试内容：
  - test_catalog_contains_short_descriptions_only
  - test_catalog_derives_compact_field_signature_from_tool_registry
  - test_catalog_routes_user_skill_creation_to_create_skill
  - test_catalog_rejects_long_description_instead_of_truncating
  - test_fixed_adapter_preserves_nested_and_flattened_business_arguments
  - test_tool_name_protocol_does_not_stringify_business_objects
  - test_capability_diagnostics_are_redacted_to_metrics
  - test_capability_diagnostics_expose_tool_and_skill_injection_without_schema
  - test_llm_runner_accepts_dynamic_capability_context_without_changing_default_api
  - test_loaded_skill_is_detected_from_history_and_can_be_reloaded_after_compaction
  - test_use_skill_result_contains_structured_usage_marker
  - test_skill_trace_metadata_does_not_copy_skill_body
  - test_loopscope_tool_schema_names_fall_back_to_provider_payload
  - test_fixed_adapter_context_only_exposes_stable_provider_tools
  - test_invalid_tool_input_requests_schema_recovery
  - test_scheduled_tasks_skill_documents_channel_array_shape

### backend/tests/test_capability_registry.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：5；无外部依赖；无 skip
- 测试内容：
  - test_tool_adapter_preserves_metadata_without_copying_schema
  - test_tool_short_description_is_validated
  - test_builtin_capability_snapshot_has_separate_tool_and_skill_maps
  - test_builtin_phase1_metadata_is_complete_and_relations_are_registered
  - test_admin_capability_catalog_exposes_metadata_without_schema_or_body

### backend/tests/test_capability_selector.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：5；无外部依赖；无 skip
- 测试内容：
  - test_selector_uses_rag_candidates_as_recommendation_order_only
  - test_selector_keeps_authorized_tools_when_rag_misses_them
  - test_selector_without_rag_keeps_compatibility_full_set
  - test_capability_rag_keeps_authorized_tools_when_recommendation_is_partial
  - test_capability_rag_failure_does_not_change_authorized_set

### backend/tests/test_commands.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：19；无外部依赖；无 skip
- 测试内容：
  - test_router_recognizes_compact_without_starting_agent
  - test_immediate_stream_emits_one_complete_token
  - test_help_lists_all_commands
  - test_router_supports_command_help
  - test_router_recognizes_group_command_after_bot_mention
  - test_router_does_not_treat_mention_in_normal_text_as_command
  - test_chinese_slash_command_names_are_not_supported
  - test_router_does_not_strip_mentions_without_group_context
  - test_command_handler_accepts_group_mention
  - test_compact_without_session_is_deterministic
  - test_each_command_supports_help
  - test_compact_forces_compression_instead_of_using_threshold
  - test_compact_reports_success
  - test_new_is_parsed_as_a_control_command
  - test_new_without_session_is_deterministic
  - test_workspace_delete_requires_explicit_confirmation
  - test_goal_is_parsed_as_a_control_command
  - test_goal_mode_is_persisted_and_can_be_disabled
  - test_unlimited_mode_does_not_enable_goal_loop

### backend/tests/test_core_continuation_recovery.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - test_runner_continuation_recovery_reuses_committed_messages_once
  - test_runner_continuation_recovery_emits_error_after_one_retry

### backend/tests/test_core_loop_characterization.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：24；外部依赖；无 skip
- 测试内容：
  - test_progress_only_round_is_retried_without_leaking_placeholder
  - test_final_reply_runs_provider_usage_compaction_check
  - test_verify_clean_pass
  - test_verify_summary_does_not_add_redundant_finalize_round
  - test_verify_fix_then_reverify
  - test_readonly_no_verify_triggered
  - test_note_get_counts_as_verify_observation
  - test_failed_write_does_not_trigger_verify
  - test_verify_capped_at_max_verify
  - test_openai_clean_pass_matches_anthropic
  - test_narration_guard_nudges_once_then_gives_up
  - test_narration_guard_does_not_treat_reported_fact_as_local_mutation
  - test_intent_announce_guard_nudges_once
  - test_intent_announce_guard_skips_questions
  - test_decision_dodge_guard_nudges_once
  - test_empty_reply_falls_back_after_one_retry
  - test_max_rounds_exhausted_reports_friendly_error
  - test_max_rounds_choice_resumes_same_run_after_unlimited_selected
  - test_eight_round_limit_emits_continue_prompt
  - test_tool_calls_exhausted_before_next_real_dispatch
  - test_tool_budget_prompt_resumes_same_run_after_continue
  - test_tool_budget_prompt_blocks_pending_batch_after_cancel
  - test_goal_mode_allows_more_than_normal_tool_limit
  - test_goal_completion_requires_explicit_marker

### backend/tests/test_deep_research_providers.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - test_tavily_is_normalized
  - test_you_uses_research_api
  - test_baidu_uses_ordinary_search

### backend/tests/test_genstream_cancel.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：1；外部依赖；无 skip
- 测试内容：
  - test_web_cancel_is_scoped_to_generation_lifecycle

### backend/tests/test_live_stream.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：5；外部依赖；无 skip
- 测试内容：
  - test_serialize_live_message_accepts_canonical_event_and_notification
  - test_serialize_live_message_rejects_non_business_payloads
  - test_event_stream_uses_user_and_broadcast_channels_and_closes_pubsub
  - test_event_stream_stops_after_account_is_suspended
  - test_publish_uses_resource_revision_not_global_revision

### backend/tests/test_llm15_preferences_api.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：6；无外部依赖；无 skip
- 测试内容：
  - test_tool_injection_mode_response_uses_only_canonical_values
  - test_update_preferences_persists_personality_and_invalidates_snapshot
  - test_update_preferences_can_disable_personality_and_expire_snapshots
  - test_update_preferences_rejects_personality_when_global_switch_is_off
  - test_upload_personality_rejects_invalid_input
  - test_upload_personality_is_user_scoped_and_invalidates_snapshot

### backend/tests/test_llm7_p3.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：7；无外部依赖；无 skip
- 测试内容：
  - test_ollama_native_stream_and_tool_roundtrip
  - test_local_capability_probe_classifies_tool_and_json_server_rejection
  - test_admin_preset_response_masks_api_key
  - test_model_list_auth_error_is_classified_without_returning_upstream_body
  - test_capability_fingerprint_changes_when_model_changes
  - test_vision_probe_preview_supports_unsaved_preset
  - test_vision_probe_persists_definitive_capabilities

### backend/tests/test_local_deployment_admin.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：4；无外部依赖；无 skip
- 测试内容：
  - test_capability_override_persists_and_invalidates_active_runtime
  - test_capability_probe_persists_fingerprint_and_results
  - test_local_runtime_model_defaults_and_override_precedence
  - test_local_without_tool_capability_does_not_send_tool_schemas

### backend/tests/test_loop_driver_vision.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：10；无外部依赖；无 skip
- 测试内容：
  - test_openai_tool_round_converts_anthropic_image_block
  - test_openai_tool_round_keeps_text_result_shape
  - test_openai_tool_round_drops_images_for_text_only_model
  - test_inline_image_stops_cache_checkpoint_before_image
  - test_anthropic_base64_image_is_volatile
  - test_initial_image_collapses_to_stable_text_after_first_round
  - test_cache_checkpoint_recovers_after_image_round
  - test_cache_checkpoint_rebuilds_previous_turn_for_new_request
  - test_cache_diagnostics_only_exposes_sizes_and_digests
  - test_cache_diagnostics_reports_effective_runtime_anchors

### backend/tests/test_mind_agent_tools.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：11；无外部依赖；无 skip
- 测试内容：
  - test_note_search_returns_matches_and_one_hop_neighbors
  - test_note_search_accepts_unified_query_alias
  - test_note_search_accepts_multiple_keywords
  - test_note_search_skips_deleted_and_other_users_nodes
  - test_note_get_returns_full_content_and_neighbor
  - test_note_get_hides_other_users_node
  - test_create_note_serializes_supported_blocks_and_references
  - test_create_note_rejects_invalid_color_and_other_users_reference
  - test_update_note_appends_and_uses_version
  - test_delete_requires_exact_version_and_restore_returns_note
  - test_undo_last_gugu_note_never_deletes_user_note

### backend/tests/test_preferences_api_contract.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：4；外部依赖；无 skip
- 测试内容：
  - test_personality_preference_is_bounded_and_normalized
  - test_personality_file_is_user_scoped_and_written_atomically
  - test_personality_is_in_static_prompt_only_when_enabled
  - test_empty_personality_keeps_default_persona

### backend/tests/test_provider_history.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：5；无外部依赖；无 skip
- 测试内容：
  - test_native_anthropic_renders_internal_system_reminder_as_user
  - test_strip_thinking_blocks_keeps_text_and_tools
  - test_prepare_session_only_marks_change_once
  - test_history_thinking_cleanup_is_send_boundary_only
  - test_clean_persisted_history_removes_old_blocks_once

### backend/tests/test_providers.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：37；无外部依赖；无 skip
- 测试内容：
  - test_adapter_for_minimax
  - test_adapter_for_minimax_m2_vs_m3_cache
  - test_adapter_for_qwen_keeps_known_openai_cache_capability
  - test_bailian_qwen3_capabilities_and_thinking_toggle
  - test_bailian_legacy_qwen_does_not_receive_qwen3_parameters
  - test_adapter_for_mimo_by_provider
  - test_adapter_for_mimo_by_base_url_fallback
  - test_adapter_for_mimo_auth_headers_uses_api_key
  - test_adapter_for_deepseek_by_provider
  - test_unknown_openai_compatible_provider_uses_explicit_history_cache
  - test_adapter_for_glm_uses_openai_compatible_endpoint
  - test_glm_thinking_parameters_are_model_scoped
  - test_adapter_for_glm_by_base_url_fallback
  - test_adapter_for_glm_coding_plan_uses_dedicated_endpoint
  - test_cache_capabilities_are_separate_by_provider
  - test_adapter_for_deepseek_by_base_url_fallback
  - test_deepseek_vision_capability_is_limited_to_vision_model
  - test_deepseek_thinking_uses_official_openai_parameter_split
  - test_adapter_for_ollama_local_and_cloud_defaults
  - test_ollama_openai_compatibility_keeps_v1_endpoint
  - test_ollama_native_request_builders
  - test_adapter_for_ollama_by_local_base_url
  - test_ollama_openai_compatibility_parameters
  - test_local_runtime_defaults_and_conservative_capabilities
  - test_local_base_url_rejects_embedded_credentials_and_non_http
  - test_local_capability_override_is_exposed_without_credentials
  - test_llama_cpp_enables_runtime_prompt_cache_without_active_provider_cache
  - test_adapter_for_unknown_provider_falls_back_to_default
  - test_adapter_for_truly_unknown_provider_also_falls_back_to_default
  - test_provider_capabilities_and_request_builders_are_model_scoped
  - test_provider_media_and_stream_capabilities_are_centralized
  - test_capability_matrix_for_supported_providers_is_explicit
  - test_capability_snapshot_keeps_probe_separate_and_contains_no_credentials
  - test_request_snapshots_do_not_add_unsupported_provider_parameters
  - test_diagnostic_request_builder_keeps_protocol_and_auth_provider_local
  - test_diagnostic_request_expands_openai_provider_extra_body
  - test_models_request_builder_uses_provider_protocol_path

### backend/tests/test_runner_collect.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：14；外部依赖；无 skip
- 测试内容：
  - test_collect_reads_core_error_detail
  - test_collect_does_not_finalize_after_interrupted_tool_continuation
  - test_collect_keeps_legacy_error_message
  - test_collect_initializes_context_usage_metadata
  - test_scheduled_collect_result_keeps_files_separate_from_meta
  - test_collect_marks_mutated_for_tools_missed_by_old_prefix_matching
  - test_collect_does_not_mark_mutated_for_read_only_tools
  - test_collect_marks_mutated_for_prefix_matched_write_tool
  - test_collect_preserves_and_emits_tool_events_in_order
  - test_collect_keeps_multiple_rounds_and_run_boundaries
  - test_collect_exposes_nonempty_round_texts_for_im_output
  - test_tool_event_text_does_not_expose_input_schema
  - test_tool_event_markdown_separates_input_and_output_blocks
  - test_tool_event_plain_qq_only_keeps_result_status

### backend/tests/test_schema_diagnostic_validation.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - test_note_create_validation_ignores_block_field_order
  - test_usage_aggregation_records_all_provider_requests_in_a_run
  - test_sequence_metrics_uses_latest_context_and_provider_totals

### backend/tests/test_stream_round_retry.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：4；无外部依赖；无 skip
- 测试内容：
  - test_minimax_attribute_error_retries_then_succeeds
  - test_minimax_attribute_error_exhausts_to_retryable
  - test_default_adapter_attribute_error_not_retried
  - test_no_adapter_attribute_error_not_retried

### backend/tests/test_stream_sanitize.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - test_minimax_truncates_confirmed_e_tilde_leak_across_token_boundaries
  - test_non_minimax_keeps_e_tilde_text_untouched
  - test_normal_reply_start_is_not_delayed_or_changed

### backend/tests/test_terminal_streaming.py

- 类型/层级：pytest / L2
- owner：backend/agent-provider
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - test_local_executor_reports_stdout_and_stderr_chunks
  - test_sandboxd_client_consumes_output_before_complete
  - test_sandboxd_client_cancel_sends_scoped_request

### backend/tests/test_tool_intent_guard.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：7；无外部依赖；无 skip
- 测试内容：
  - test_tool_progress_placeholder_is_guarded
  - test_normal_sentence_is_not_treated_as_tool_progress
  - test_requires_tools_is_runtime_only_round_metadata
  - test_narration_guard_ignores_normal_conversation_looked_at_phrase
  - test_narration_guard_keeps_object_context_for_read_claims
  - test_colon_ended_file_action_is_guarded_in_chinese_and_english
  - test_colon_ended_explanation_is_not_treated_as_action_intent

### backend/tests/test_tool_isolation.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：24；无外部依赖；无 skip
- 测试内容：
  - test_file_resolve_cross_user
  - test_file_resolve_owner_ok
  - test_resolve_key_cross_user_project
  - test_resolve_key_uses_nested_folder_path
  - test_resolve_key_rejects_folder_from_other_space
  - test_list_files_returns_full_folder_path
  - test_list_files_filters_by_folder_id
  - test_list_files_accepts_folder_name_without_integer_sql_error
  - test_resolve_target_cross_user_folder
  - test_project_resolve_cross_user
  - test_project_resolve_owner_ok
  - test_project_update_tool_persists_name
  - test_event_resolve_cross_user
  - test_event_resolve_owner_ok
  - test_remove_event_reminder_cross_user
  - test_client_resolve_cross_user
  - test_client_resolve_owner_ok
  - test_task_resolve_cross_user
  - test_task_resolve_owner_ok
  - test_read_conversation_cross_user
  - test_read_conversation_owner_ok
  - test_restore_cross_user
  - test_permanent_delete_cross_user
  - test_permanent_delete_folder_uses_folder_id_and_removes_folder

### backend/tests/test_tool_schema_digest.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - test_tool_schema_digest_is_order_stable

### backend/tests/test_tool_schema_validation.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：21；外部依赖；无 skip
- 测试内容：
  - test_dispatch_rejects_non_object_before_handler
  - test_dispatch_rejects_missing_required_before_handler
  - test_dispatch_rejects_type_enum_and_numeric_boundaries
  - test_type_error_includes_schema_shape_hint_without_echoing_input
  - test_boolean_type_error_explains_native_json_value
  - test_schema_normalization_converts_numeric_text_and_omits_optional_empty_values
  - test_schema_normalization_does_not_guess_required_empty_numbers_or_array_shapes
  - test_dispatch_applies_schema_normalization_before_handler
  - test_dispatch_keeps_required_empty_number_invalid
  - test_additional_properties_default_allowed
  - test_dispatch_commits_successful_task_transaction
  - test_dispatch_enriches_business_error_with_usage_contract
  - test_dispatch_rolls_back_failed_task_transaction
  - test_explicit_additional_properties_false_rejected
  - test_existing_integer_id_normalization_runs_before_schema
  - test_mutating_tool_invalid_input_never_runs_handler
  - test_invalid_json_schema_fails_fast_at_registration
  - test_validator_is_cached_without_changing_provider_schemas
  - test_provider_schema_parity_uses_one_tool_contract
  - test_provider_schema_serialization_does_not_run_compactor
  - test_all_registered_tools_have_cached_validators

### backend/tests/test_user_skills.py

- 类型/层级：pytest / L1
- owner：backend/agent-provider
- 源码声明数：8；无外部依赖；无 skip
- 测试内容：
  - test_user_skill_validator_normalizes_and_hashes
  - test_user_skill_validator_rejects_invalid_fields
  - test_user_skill_is_owned_and_only_enabled_metadata_is_exposed
  - test_user_skill_rejects_unknown_tool_and_duplicate_slug
  - test_user_skill_is_merged_into_user_capability_index
  - test_use_skill_loads_owned_body_and_refreshes_digest
  - test_create_skill_adapter_uses_registry_and_returns_structured_result
  - test_create_skill_adapter_rejects_unavailable_tool

### frontend/src/utils/byokCredentials.test.ts

- 类型/层级：vitest / L0
- owner：frontend/agent-provider
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - 优先选择已启用凭据，避免更新停用旧记录后运行时回退服务器配置
  - 没有启用项时仍返回历史记录，供专项面板更新并重新启用

## mind-project

- 文件数：23
- 源码声明数：201

### backend/scripts/diagnostics/test_reminder_role_cache.py

- 类型/层级：diagnostic-script / L2
- owner：backend/diagnostics
- 源码声明数：0；无外部依赖；无 skip
- 测试内容：
  - 脚本入口或静态检查，无标准测试函数

### backend/tests/test_canvas_layout.py

- 类型/层级：pytest / L1
- owner：backend/mind-project
- 源码声明数：4；无外部依赖；无 skip
- 测试内容：
  - test_effective_size_uses_explicit_dimensions_and_type_defaults
  - test_relation_sides_use_card_centers_not_node_ids
  - test_resolve_position_supports_viewport_and_auto_without_database_access
  - test_resolve_position_rejects_unknown_anchor

### backend/tests/test_mind_api.py

- 类型/层级：pytest / L1
- owner：backend/mind-project
- 源码声明数：32；外部依赖；无 skip
- 测试内容：
  - test_plain_text_strips_markdown_syntax
  - test_plain_text_keeps_object_reference_label
  - test_plain_text_keeps_link_text_drops_url
  - test_create_note_derives_plain_text_and_marks_pending_index
  - test_create_note_accepts_backfilled_captured_at
  - test_create_note_rejects_future_captured_at
  - test_timeline_orders_by_captured_at_not_created_at
  - test_timeline_hides_soft_deleted_and_other_users_notes
  - test_update_note_bumps_version_and_resets_index
  - test_update_note_with_stale_version_returns_409
  - test_update_note_of_other_user_is_404
  - test_update_soft_deleted_note_is_404
  - test_delete_note_is_soft_and_keeps_the_row
  - test_delete_note_of_other_user_is_404
  - test_note_mutations_publish_canonical_mind_events
  - test_canvas_mutations_publish_canonical_mind_events
  - test_ref_suggest_returns_stable_type_and_id
  - test_ref_suggest_only_covers_project_file_event
  - test_ref_suggest_empty_query_returns_nothing
  - test_global_search_finds_note_by_body_text
  - test_global_search_finds_note_by_referenced_object_name
  - test_global_search_skips_deleted_notes_and_ref_nodes
  - test_global_search_isolates_notes_by_user
  - test_canvas_item_keeps_note_global_and_duplicate_add_is_idempotent
  - test_event_canvas_item_embeds_display_snapshot
  - test_canvas_note_is_independent_from_record_timeline
  - test_canvas_rejects_other_users_node_and_keeps_canvas_private
  - test_delete_canvas_cascades_items_but_keeps_nodes
  - test_delete_canvas_rejects_other_users_canvas
  - test_canvas_relations_only_list_visible_nodes_and_are_idempotent
  - test_canvas_relations_are_isolated_between_canvases
  - test_ref_node_reuses_one_proxy_and_checks_target_ownership

### backend/tests/test_mind_canvas_tools.py

- 类型/层级：pytest / L1
- owner：backend/mind-project
- 源码声明数：21；外部依赖；无 skip
- 测试内容：
  - test_list_and_get_canvas_return_camera_and_nodes
  - test_search_canvas_excludes_timeline_note_and_returns_canvas_note
  - test_search_placeable_nodes_returns_owned_project_file_event_only
  - test_search_canvas_isolates_other_user_canvas
  - test_search_placeable_marks_existing_ref_and_item
  - test_create_canvas_and_canvas_note_use_viewport_anchor
  - test_add_canvas_node_creates_ref_reuses_it_and_rejects_note
  - test_update_and_remove_canvas_item_only_change_view
  - test_update_canvas_note_uses_version_and_rejects_timeline_note
  - test_connect_is_idempotent_and_requires_same_canvas
  - test_removing_canvas_item_detaches_relation_without_deleting_global_relation
  - test_relation_tools_read_and_update_canvas_connection_sides
  - test_delete_canvas_note_and_disconnect_require_confirmation
  - test_canvas_mutations_reject_self_cross_user_and_stale_versions
  - test_batch_canvas_is_atomic_and_reference_operations_are_idempotent
  - test_batch_idempotency_conflict_on_different_payload
  - test_batch_idempotent_replay_create_note_only_one_row
  - test_canvas_crud_arrays_and_batch_delete_are_limited_and_confirmed
  - test_empty_canvas_auto_placement_uses_world_coordinates
  - test_empty_canvas_auto_placement_with_scale
  - test_get_canvas_limit_1_keeps_full_relations_and_marks_incomplete_audit

### backend/tests/test_mind_p0_model.py

- 类型/层级：pytest / L1
- owner：backend/mind-project
- 源码声明数：24；外部依赖；无 skip
- 测试内容：
  - test_note_node_defaults
  - test_ref_node_points_at_business_object
  - test_captured_at_can_be_backfilled_into_the_past
  - test_ref_kind_requires_both_ref_columns
  - test_non_ref_kind_must_leave_ref_columns_empty
  - test_ref_node_is_deduped_per_business_object
  - test_many_notes_coexist_despite_null_ref_columns
  - test_relation_self_loop_blocked_at_db_level
  - test_update_node_atomic_succeeds_and_bumps_version
  - test_update_node_atomic_rejects_stale_version
  - test_update_node_atomic_cannot_touch_other_users_node
  - test_content_change_resets_index_watermark
  - test_non_content_change_keeps_index_watermark
  - test_content_md_only_update_keeps_hash_paired
  - test_update_node_atomic_refuses_soft_deleted_node
  - test_related_is_normalized_so_both_directions_are_one_edge
  - test_upsert_relation_is_idempotent
  - test_upsert_relation_allows_explicit_parallel_edge
  - test_upsert_relation_survives_concurrent_insert_race
  - test_directed_relation_keeps_its_direction
  - test_upsert_relation_refuses_self_loop
  - test_gugu_suggested_relation_is_distinguishable
  - test_get_owned_hides_other_users_node
  - test_soft_deleted_node_keeps_its_relations

### backend/tests/test_projects_core.py

- 类型/层级：pytest / L1
- owner：backend/mind-project
- 源码声明数：10；无外部依赖；无 skip
- 测试内容：
  - test_atomic_project_update_bumps_version
  - test_atomic_project_update_rejects_stale_version
  - test_atomic_project_update_cannot_cross_user_boundary
  - test_atomic_project_update_sets_and_clears_done_at
  - test_atomic_project_update_rejects_invalid_domain_values
  - test_project_fields_reject_invalid_dates_and_stage_structure
  - test_build_project_applies_shared_create_validation
  - test_normalize_project_stages_builds_stable_stage_and_todo_ids
  - test_normalize_project_stages_for_read_fills_legacy_missing_todos_without_mutating_stage_identity
  - test_replace_project_stages_preserves_implicit_same_name_todos

### backend/tests/test_projects_live_events.py

- 类型/层级：pytest / L1
- owner：backend/mind-project
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - test_project_update_publishes_projects_event_for_other_tabs

### frontend/e2e/mind-canvas-runtime.spec.ts

- 类型/层级：playwright / L3
- owner：frontend/e2e
- 源码声明数：2；外部依赖；无 skip
- 测试内容：
  - 画布首屏、项目抽屉和相机控制可用

### frontend/src/composables/useMindCanvas.test.ts

- 类型/层级：vitest / L0
- owner：frontend/mind-project
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - reuses the same camera pan math without pointer capture
  - keeps ordinary pan transient until commit while coordinate conversion follows the visual camera

### frontend/src/composables/useMindEditor.test.ts

- 类型/层级：vitest / L0
- owner：frontend/mind-project
- 源码声明数：41；外部依赖；无 skip
- 测试内容：
  - 两段之间多一条空行（2 条空行），往返保真
  - 三条连续空行（多空两行），往返保真
  - 单条空行（默认块间分隔）不受影响，不会平白多出空段落
  - 文档开头的空行不产生多余空段落
  - 结尾多打的空行也保留（不是只有中间的才算数）
  - 结尾只是个孤零零的换行符（1 个 \\n，不构成一条完整空行）不产生多余空段落
  - 结尾恰好一条空行（2 个 \\n，跟块间分隔同一套换算）会产生 1 个空段落
  - f(f(x)) === f(x)（多空行也幂等）
  - 只读预览里空段落渲染成 .np-blank 占位，data-line-unit 照常递增
  - *** 解析成同一个文本节点上的 bold+italic 两个 mark，不是半个 mark 加裸星号
  - snake_case 变量名不被当成斜体（不认下划线写法）
  - 乘法表达式里的星号不触发斜体（* 后紧跟空格不算开始定界符）
  - 多级标题 clamp 成单级
  - f(f(x)) === f(x)（幂等）
  - 空输入 → doc 至少一个空段落，序列化回空串
  - mindRef 的 type/id/label 往返保真
  - 翻转指定序号的待办
  - 序号越界返回原文
  - 只数待办、跳过普通列表行
  - 正文里的 HTML 被转义、不产生真实元素
  - mindRef 渲染成 span.mind-ref 并展示 label
  - 加粗/斜体/删除线/行内代码渲染成对应标签
  - 链接渲染成 <a> 且带 target=_blank/rel
  - 危险 scheme 的链接被挡成 #（javascript: 注入兜底）
  - 代码块内容原样保留，不当 mindRef/加粗解析（[[ ]] 和 ** 都是字面量）
  - 代码块空行是代码的一部分，不当成分段空行
  - 有序列表 orderedListItem 是独立节点名，不会被无序列表的圆点渲染吃掉
  - 分割线渲染成 <hr>，不认带空格的 
  - 空代码块（插入后什么都没打）不产生非法的空文本节点，能正常再解析回来
  - 未闭合的代码围栏结尾也不丢内容
  - 只读预览：代码块整块一个 data-line-unit，引用块每段一个
  - 只读预览：代码块按语言语法高亮，跟 GuguChat 聊天同一套 hljs token class
  - 只读预览：代码块显示语言名标签（写了语言直接显示，没写就显示 highlightAuto 猜的）
  - 没写语言时不报错，交给 highlightAuto 猜（用全量语言库，猜中什么算什么，不强求 plaintext）
  - 写了个不存在的语言名不报错，退化成自动猜
  - 引用块内不能再嵌套列表/待办（schema 收窄成 paragraph+，工具栏命令应失效）
  - 捕获 type / id / label
  - 只把首个非空的 Markdown 标题分离出来，并保留对象引用显示名
  - 普通正文不伪造标题

### frontend/src/utils/canvasRelationGeometry.test.ts

- 类型/层级：vitest / L0
- owner：frontend/mind-project
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - keeps the corridor between far-apart endpoint cards inside the relation envelope
  - uses the same bounded curve shape for preview and committed relations

### frontend/src/views/Mind/utils/canvasItemMeasurements.test.ts

- 类型/层级：vitest / L0
- owner：frontend/mind-project
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - 乐观项目换成真实 node 后仍保留自然高度，避免后续拖动回退到 120px 导致落点上移

### frontend/src/views/Mind/utils/relationRuntimeConnection.test.ts

- 类型/层级：vitest / L0
- owner：frontend/mind-project
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - 只注销当前 relation 的端点，不影响同一节点对的平行边
  - 缺少历史端点数据时返回 null，交给兼容清理路径处理

### frontend/src/views/Mind/utils/relationRuntimeRegistry.test.ts

- 类型/层级：vitest / L0
- owner：frontend/mind-project
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - 反向创建经服务端归一后删除，Runtime endpoint 可再次注册

### frontend/test/canvasViewport.test.ts

- 类型/层级：vitest / L0
- owner：frontend/mind-project
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - 将屏幕缓冲区正确换算为世界坐标
  - 保留与窗口边缘相交的卡片，裁掉完全在窗口外的卡片

### frontend/test/mindCanvasObjectId.test.ts

- 类型/层级：vitest / L0
- owner：frontend/mind-project
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - 乐观卡片和落库后的同一张卡保持相同 Runtime 身份
  - 历史卡没有 clientKey 时继续使用 nodeId
  - clientKey 为空字符串时不回退到临时 nodeId

### frontend/test/mindCanvasRace.test.ts

- 类型/层级：vitest / L0
- owner：frontend/mind-project
- 源码声明数：5；无外部依赖；无 skip
- 测试内容：
  - 删除 pending load 的画布后，旧响应不能重新激活已删除画布
  - 切换画布时只提交最后一次 load 的响应
  - 加载画布时去掉重复关系，避免连线 TransitionGroup 使用重复 key
  - 画布已不存在时吞掉可恢复的 404，不产生未处理 Promise 异常
  - 切换账号后，旧账号的画布响应不能回写到新账号

### frontend/test/projectDrop.test.ts

- 类型/层级：vitest / L0
- owner：frontend/mind-project
- 源码声明数：4；无外部依赖；无 skip
- 测试内容：
  - 忽略纵向位置：列底部空白仍归属该状态列
  - 落地途中重抓只认本次松手列，不继承上一段动画的速度
  - 普通抛出只沿鼠标运动方向前探，不会反向拉回已进入的列
  - 指针落在列外时不改变状态

### frontend/test/projectMapper.test.ts

- 类型/层级：vitest / L0
- owner：frontend/mind-project
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - 将合法 API 响应收紧为项目领域模型
  - 拒绝非法状态和不完整的阶段数据

### frontend/test/projectProgress.test.ts

- 类型/层级：vitest / L0
- owner：frontend/mind-project
- 源码声明数：6；无外部依赖；无 skip
- 测试内容：
  - 跨阶段汇总 已完成/总数
  - 四舍五入
  - 部分阶段没待办也只按总待办算（total>0 就不兜底）
  - 按 (当前阶段序号+1)/阶段数
  - currentStage 不存在 → 0
  - 无阶段 → 0

### frontend/test/projectStages.test.ts

- 类型/层级：vitest / L0
- owner：frontend/mind-project
- 源码声明数：31；无外部依赖；无 skip
- 测试内容：
  - 未完成的待办：勾上 + 标 autoCompleted + 快照原 done 到 _savedDone
  - 已完成的待办：原样保留，不动其真实状态
  - 返回新数组，不改原引用
  - 空/缺省输入返回空数组
  - autoCompleted 待办：恢复到快照 _savedDone、清掉标记
  - _savedDone 缺省按 false 还原
  - 非 autoCompleted 待办：原样保留（含用户手动勾的真完成）
  - 混合列表往返后各待办 done 与初始一致
  - 翻转目标待办的 done，其余不变
  - id 不存在则全数组原样（值相等）
  - pending → active → done → null
  - (idx+1)/total*100，四舍五入
  - 越界/空阶段返回 0
  - 有待办时按全部待办的完成比例计算
  - 无待办时按当前阶段位置计算
  - 字符串阶段 → {key:s{i}, label, todos:[]}
  - 松对象保留 key/label，todos 补 id/text/done
  - 保留已有 key 与瞬态字段（autoCompleted/_savedDone）
  - 阶段1、2完成，阶段3未完成 → 落在阶段3（跳过已完成的中间阶段）
  - 阶段1未完成、阶段2完成 → 落在阶段1（第一个未完成，在前面）
  - 全部完成 → 落在最后一个阶段
  - 空阶段（无待办）视为完成、被跳过
  - 单阶段未完成 → 0
  - 全部打勾 → true
  - 任一未打勾 → false（即便在最后阶段之外）
  - 空阶段 / 全无待办 → true（位置型项目仍可完成）
  - 移入已完成：收尾待办、定位末阶段并保留回退锚点
  - 从已完成回退：只还原自动勾选的待办
  - 前进阶段：自动完成经过的阶段，且不直接进入完成区
  - 最后阶段的全部待办完成后进入已完成

### frontend/test/projectStagesComposable.test.ts

- 类型/层级：vitest / L0
- owner：frontend/mind-project
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - 计算因手动完成待办而锁定的阶段位置

### frontend/test/projectTodos.test.ts

- 类型/层级：vitest / L0
- owner：frontend/mind-project
- 源码声明数：4；无外部依赖；无 skip
- 测试内容：
  - 新增和删除待办通过统一保存回调通知宿主
  - 完成当前阶段最后一项时推进阶段且只交给推进回调保存
  - 取消完成或普通勾选不会触发阶段推进
  - 编辑态由待办边界维护，删除当前编辑项时自动结束编辑

## security

- 文件数：24
- 源码声明数：168

### backend/tests/test_account_status.py

- 类型/层级：pytest / L1
- owner：backend/security
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - test_account_status_requires_active_compatibility_state

### backend/tests/test_admin_auth_defaults.py

- 类型/层级：pytest / L1
- owner：backend/security
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - test_admin_default_credentials_are_admin_and_guguadmin
  - test_admin_credentials_can_be_overridden_by_environment

### backend/tests/test_admin_risk_users.py

- 类型/层级：pytest / L1
- owner：backend/security
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - test_suspend_and_unsuspend_updates_compatibility_state
  - test_risk_user_query_includes_suspended_accounts
  - test_risk_user_visibility_uses_persistent_event_window

### backend/tests/test_agent_admin_models.py

- 类型/层级：pytest / L1
- owner：backend/security
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - test_saved_preset_model_list_uses_provider_model_contract
  - test_preview_model_list_does_not_pass_local_runtime

### backend/tests/test_agent_admin_usage.py

- 类型/层级：pytest / L1
- owner：backend/security
- 源码声明数：5；无外部依赖；无 skip
- 测试内容：
  - test_split_cache_provider_list_covers_anthropic_compatible_usage
  - test_effective_input_tokens_uses_full_input_for_split_cache_usage
  - test_effective_input_sql_uses_the_same_provider_contract
  - test_usage_timezone_is_validated_before_sql_is_built
  - test_usage_timezone_invalid_value_falls_back_to_server_timezone

### backend/tests/test_auth_cookies.py

- 类型/层级：pytest / L1
- owner：backend/security
- 源码声明数：4；无外部依赖；无 skip
- 测试内容：
  - test_auth_cookies_have_browser_safe_defaults
  - test_cookie_auth_requires_matching_csrf_for_write
  - test_bearer_auth_does_not_require_csrf
  - test_clear_auth_cookies_expires_both_values

### backend/tests/test_byok_config_override.py

- 类型/层级：pytest / L1
- owner：backend/security
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - test_byok_is_enabled_by_default
  - test_byok_override_is_parsed_as_settings_model

### backend/tests/test_byok_security_phase4.py

- 类型/层级：pytest / L1
- owner：backend/security
- 源码声明数：8；外部依赖；无 skip
- 测试内容：
  - test_envelope_never_stores_plaintext_and_round_trips
  - test_master_key_rotation_reads_previous_version
  - test_credentials_are_isolated_by_user
  - test_master_key_status_is_scoped_to_user_and_empty_users_are_ready
  - test_master_key_status_does_not_require_key_without_credentials
  - test_decrypt_failure_does_not_fall_back_to_platform_config
  - test_disabled_policy_blocks_all_byok_entry_points
  - test_credential_view_contains_metadata_but_not_encrypted_fields

### backend/tests/test_chat_attachments_ownership.py

- 类型/层级：pytest / L1
- owner：backend/security
- 源码声明数：25；外部依赖；无 skip
- 测试内容：
  - test_stage_creates_draft_row
  - test_reuse_attachment_creates_new_row_with_shared_storage_key
  - test_reuse_attachment_selects_the_requested_source_index
  - test_reuse_attachment_falls_back_when_source_object_is_missing
  - test_reuse_attachment_isolated_by_user
  - test_stage_rolls_back_storage_when_db_insert_fails
  - test_claim_attaches_all_on_success
  - test_claim_all_or_nothing_on_partial_failure
  - test_claim_ignores_empty_list
  - test_get_meta_reads_from_db
  - test_get_meta_idor_other_user_cannot_read
  - test_get_meta_falls_back_to_legacy_redis_when_db_misses
  - test_try_delete_skips_when_still_referenced
  - test_try_delete_deletes_when_unreferenced
  - test_delete_session_deletes_attachment_bytes
  - test_delete_session_shared_storage_key_isolation
  - test_delete_session_storage_failure_does_not_block
  - test_delete_draft_attachment_succeeds_on_draft
  - test_delete_draft_attachment_rejects_attached
  - test_delete_draft_attachment_404_for_unknown_or_other_user
  - test_gc_conditional_delete_loses_to_concurrent_claim
  - test_try_delete_check_logic_does_not_use_stale_result
  - test_stage_insert_failure_with_rollback_failure_still_raises_original
  - test_delete_session_db_failure_prevents_storage_delete
  - test_e2e_draft_upload_expires_but_attached_survives

### backend/tests/test_config_password_override.py

- 类型/层级：pytest / L1
- owner：backend/security
- 源码声明数：11；外部依赖；无 skip
- 测试内容：
  - test_default_db_password_is_empty_string
  - test_default_db_user_is_gugu
  - test_storage_defaults_to_migrated_user_data_root
  - test_apply_override_requires_effective_db_password
  - test_apply_override_rejects_placeholder_password
  - test_apply_override_rejects_empty_string_password
  - test_apply_override_accepts_real_password
  - test_apply_override_accepts_password_from_environment
  - test_apply_override_keeps_last_valid_password_during_hot_reload
  - test_write_override_json_is_atomic_and_private
  - test_write_override_json_falls_back_for_systemd_ebusy

### backend/tests/test_config_reconcile.py

- 类型/层级：pytest / L1
- owner：backend/security
- 源码声明数：4；无外部依赖；无 skip
- 测试内容：
  - test_import_orphan_uses_stat_and_rejects_unresolved_project
  - test_import_orphan_creates_owned_file_with_stat_size
  - test_path_migration_rechecks_identity_uniqueness
  - test_path_migration_reports_missing_file_ids

### backend/tests/test_confirm_gate.py

- 类型/层级：pytest / L1
- owner：backend/security
- 源码声明数：12；无外部依赖；无 skip
- 测试内容：
  - test_delete_project_requires_confirm
  - test_delete_event_requires_confirm
  - test_delete_client_requires_confirm
  - test_delete_scheduled_task_requires_confirm
  - test_permanent_delete_requires_confirm
  - test_delete_client_rejects_confirm_without_prior_token
  - test_delete_client_with_prior_token_executes
  - test_confirmation_lease_can_use_explicit_ttl
  - test_batch_delete_client_uses_one_target_bound_confirmation
  - test_dispatch_tripwire_fires_on_gate_bypass
  - test_dispatch_tripwire_silent_when_gated
  - test_static_confirm_gate_guard_passes

### backend/tests/test_error_redaction_contract.py

- 类型/层级：pytest / L1
- owner：backend/security
- 源码声明数：11；外部依赖；无 skip
- 测试内容：
  - test_expected_error_carries_code_and_public_message
  - test_retryable_error_carries_cause_and_attempt
  - test_expected_and_retryable_are_distinct_appError_subclasses
  - test_public_message_does_not_require_cause
  - test_redact_strips_sensitive_patterns
  - test_redact_strips_traceback_frames
  - test_redact_passes_through_normal_text
  - test_redact_handles_none_and_non_string
  - test_diag_logger_does_not_propagate_to_root
  - test_diag_log_writes_raw_exception_to_file_not_root_handlers
  - test_diag_log_raw_writes_string_not_exception

### backend/tests/test_onboarding_state.py

- 类型/层级：pytest / L1
- owner：backend/security
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - test_legacy_state_is_normalized_without_losing_seeded_fields
  - test_user_state_isolated_and_first_display_can_be_reopened
  - test_user_patch_rejects_seeded_fields_and_invalid_steps

### backend/tests/test_ownership_security_events.py

- 类型/层级：pytest / L1
- owner：backend/security
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - test_cross_user_ownership_creates_sanitized_event
  - test_ownership_event_fingerprints_request_source
  - test_security_fingerprint_is_stable_and_not_plaintext

### backend/tests/test_ownership.py

- 类型/层级：pytest / L1
- owner：backend/security
- 源码声明数：6；无外部依赖；无 skip
- 测试内容：
  - test_owner_gets_own_row
  - test_owner_id_as_str_still_matches
  - test_cross_user_denied
  - test_cross_user_denied_logs_warning
  - test_missing_row_is_none_without_denied_log
  - test_none_id_is_none

### backend/tests/test_security_alerts.py

- 类型/层级：pytest / L1
- owner：backend/security
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - test_alert_is_disabled_by_default
  - test_alert_sends_only_to_valid_configured_recipients

### backend/tests/test_security_retention.py

- 类型/层级：pytest / L1
- owner：backend/security
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - test_cleanup_removes_only_expired_security_events

### backend/tests/test_security_risk_policy.py

- 类型/层级：pytest / L1
- owner：backend/security
- 源码声明数：7；外部依赖；无 skip
- 测试内容：
  - test_policy_thresholds_and_first_write_ttl
  - test_policy_counts_client_and_ip_separately
  - test_policy_fails_open_when_redis_is_unavailable
  - test_policy_enforces_configured_throttle
  - test_policy_fails_open_when_throttle_check_redis_is_unavailable
  - test_policy_uses_runtime_security_configuration
  - test_auto_suspend_uses_configured_duration

### backend/tests/test_tool_schema_security_contract.py

- 类型/层级：pytest / L1
- owner：backend/security
- 源码声明数：15；无外部依赖；无 skip
- 测试内容：
  - test_phase1_requires_a_single_source_or_event
  - test_send_file_rejects_multiple_sources_and_orphan_title
  - test_add_event_reminder_rejects_ambiguous_reminder_inputs
  - test_update_todo_action_has_conditional_fields_and_legacy_compatibility
  - test_search_conversations_keeps_recent_without_search_term
  - test_phase2_calendar_and_file_semantics
  - test_phase3_project_requires_explicit_date_range
  - test_phase8_migrated_tools_are_source_canonical_schema
  - test_phase8_compactor_keeps_reserved_parameter_names
  - test_phase8_date_and_time_constraints_are_structural
  - test_phase8_workspace_binding_is_structural
  - test_phase8_document_project_location_is_structural
  - test_phase8_edit_modes_are_structural
  - test_phase3_legacy_event_adapter_is_explicit_and_value_preserving
  - test_phase4_schema_errors_are_aggregated_without_argument_values

### backend/tests/test_upload_confirm.py

- 类型/层级：pytest / L1
- owner：backend/security
- 源码声明数：12；无外部依赖；无 skip
- 测试内容：
  - test_validate_oss_upload_uses_server_metadata
  - test_validate_oss_upload_rejects_missing_object
  - test_validate_oss_upload_rejects_non_staging_key
  - test_confirm_rejects_actual_size_over_single_file_limit
  - test_confirm_overwrite_rechecks_quota_with_actual_size
  - test_confirm_new_file_rechecks_quota_with_actual_size
  - test_confirm_locks_user_before_quota_read
  - test_presign_signs_staging_key_not_final_or_existing_key
  - test_confirm_overwrite_copies_to_new_key_and_returns_old_key
  - test_confirm_oss_upload_rejects_non_staging_key_without_calling_rename
  - test_confirm_oss_upload_overwrite_rejects_non_staging_key_without_calling_rename
  - test_validate_oss_upload_rejects_reused_staging_key_after_first_confirm

### backend/tests/test_url_security.py

- 类型/层级：pytest / L1
- owner：backend/security
- 源码声明数：13；无外部依赖；无 skip
- 测试内容：
  - test_url_security_rejects_local_and_metadata_addresses
  - test_url_security_rejects_non_http_schemes
  - test_url_security_rejects_ipv4_mapped_ipv6
  - test_url_security_rejects_cgnat_shared_address_space
  - test_url_security_rejects_ipv4_mapped_cgnat
  - test_url_security_allows_public_ip
  - test_url_security_rejects_mixed_dns_results
  - test_resolve_pinned_ip_returns_safe_ip
  - test_resolve_pinned_ip_rejects_blocked_address
  - test_resolve_pinned_ip_rejects_mixed_dns_results
  - test_web_pinned_backend_uses_resolved_ip
  - test_build_pinned_request_connects_to_resolved_ip_not_hostname
  - test_build_pinned_request_propagates_block_reason

### frontend/src/assets/styles/onboarding-focus-regression.test.ts

- 类型/层级：vitest / L0
- owner：frontend/security
- 源码声明数：15；无外部依赖；无 skip
- 测试内容：
  - 语言选中态使用公共卡片底色，并保留 focus glow
  - onboarding visual 通过媒体 mask 淡出到统一面板背景
  - 内容区和操作区使用随主题变化的明亮面板玻璃 token
  - panel-bg 保留主题 base 作为渐变底色，避免面板退化为纯半透明
  - 语言卡片与功能卡片复用相同的尺寸节奏，hover 只改变描边
  - 功能卡片使用亮色公共底色，语义色只负责图标和描边且不浮动
  - 主题设置面板使用更明确的公共卡片底色
  - 完成页摘要卡片复用 onboarding 公共卡片契约
  - onboarding 模型页只展示添加入口与工作区卡片
  - onboarding IM 使用独立平台卡片，不复用个人设置面板
  - 主题预览 topbar 使用独立公共卡片样式
  - 主题切换按钮统一使用 choice 与 segmented token
  - 导航按钮不把持久化状态展示成保存中
  - 文件和文件夹只在重命名态放开名称行裁切
  - rename input 恢复共享 input-focus-shadow，不再有专属降级覆盖

### frontend/test/accountBoundary.test.ts

- 类型/层级：vitest / L0
- owner：frontend/security
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - 登录新账号前清理旧账号的会话、媒体和导航状态

## storage

- 文件数：44
- 源码声明数：392

### backend/tests/test_agent_file_folder_parity.py

- 类型/层级：pytest / L1
- owner：backend/storage
- 源码声明数：6；无外部依赖；无 skip
- 测试内容：
  - test_agent_folder_create_rename_delete_matches_service
  - test_agent_folder_move_uses_service_physical_relocation
  - test_agent_restore_file_matches_file_service
  - test_agent_restore_folder_matches_file_service
  - test_agent_edit_file_updates_content_and_metadata
  - test_agent_delete_file_moves_file_to_trash

### backend/tests/test_attachment_gc.py

- 类型/层级：pytest / L1
- owner：backend/storage
- 源码声明数：11；外部依赖；无 skip
- 测试内容：
  - test_draft_gc_deletes_expired_draft
  - test_draft_gc_skips_fresh_draft
  - test_draft_gc_skips_attached_even_if_old
  - test_draft_gc_empty_returns_zero
  - test_draft_gc_noop_when_lock_held
  - test_safety_net_identifies_integrity_violation
  - test_safety_net_deletes_old_orphan_candidate
  - test_safety_net_skips_recent_orphan_candidate
  - test_safety_net_normal_case_no_findings
  - test_safety_net_noop_when_lock_held
  - test_safety_net_skips_orphan_candidate_with_missing_mtime

### backend/tests/test_chat_attach_video.py

- 类型/层级：pytest / L1
- owner：backend/storage
- 源码声明数：51；无外部依赖；无 skip
- 测试内容：
  - test_should_compress_4k_high_bitrate
  - test_should_compress_4k_low_bitrate
  - test_should_compress_1080p_high_bitrate
  - test_should_not_compress_1080p_low_bitrate
  - test_should_not_compress_none_probe
  - test_should_not_compress_zero_bitrate
  - test_build_user_content_mm_file_video
  - test_build_user_content_base64_video
  - test_build_user_content_mm_file_missing_fid_falls_back_base64
  - test_build_user_content_video_missing_all_data_skipped
  - test_build_user_content_openai_video_ignores_mm_file
  - test_build_user_content_openai_image_defaults_to_auto_detail
  - test_minimax_video_enabled_m3
  - test_minimax_video_enabled_non_m3
  - test_minimax_video_enabled_other_provider
  - test_text_only_provider_does_not_receive_audio_or_video_blocks
  - test_native_audio_model_does_not_fallback_to_transcription
  - test_text_only_model_falls_back_to_transcription
  - test_compress_video_uses_portrait_scale_filter
  - test_compress_video_uses_to_thread
  - test_probe_video_uses_to_thread
  - test_probe_video_falls_back_to_format_duration_when_stream_missing
  - test_probe_video_duration_takes_the_longer_of_stream_and_format
  - test_upload_video_mmfile_success
  - test_upload_video_mmfile_failure_status
  - test_resolve_mmfile_failure_does_not_fallback_base64
  - test_resolve_video_over_90mb_rejected
  - test_resolve_video_under_45mb_base64
  - test_resolve_for_message_calls_shared_prepare_video_media
  - test_resolve_video_45_to_90mb_uses_mmfile_on_success
  - test_prepare_video_media_minimax_small_uses_base64
  - test_prepare_video_media_minimax_between_45_and_90mb_uses_mmfile
  - test_prepare_video_media_minimax_mmfile_upload_failure_raises
  - test_prepare_video_media_transcode_failure_does_not_silently_use_original
  - test_prepare_video_media_source_limits_apply_to_non_minimax_too
  - test_prepare_video_media_over_mmfile_max_still_tries_transcode_first
  - test_prepare_video_media_transcode_still_over_limit_rejected
  - test_prepare_video_media_final_payload_boundaries
  - test_prepare_video_media_rejects_when_duration_cannot_be_determined
  - test_prepare_video_media_rejects_duration_over_120s_without_transcoding
  - test_prepare_video_media_allows_119_seconds
  - test_prepare_video_media_rejects_source_over_500mb_without_probing
  - test_prepare_video_media_allows_under_500mb
  - test_compress_video_720p_keeps_original_resolution_no_upscale
  - test_compress_video_2k_downscales_to_1080p
  - test_compress_video_no_probe_keeps_original_resolution
  - test_prepare_video_media_non_minimax_under_36mb_uses_base64
  - test_prepare_video_media_non_minimax_over_36mb_rejected
  - test_video_media_to_anthropic_block_mm_file
  - test_video_media_to_anthropic_block_base64
  - test_video_media_to_anthropic_block_missing_data_returns_none

### backend/tests/test_file_readers.py

- 类型/层级：pytest / L1
- owner：backend/storage
- 源码声明数：9；无外部依赖；无 skip
- 测试内容：
  - test_media_reader_uses_physical_size_before_get
  - test_media_reader_rejects_missing_physical_object
  - test_read_video_returns_native_video_block_for_minimax_m3
  - test_read_video_rejects_when_provider_not_minimax_m3
  - test_read_video_missing_file
  - test_read_video_rejects_over_500mb_without_reading_full_bytes
  - test_read_video_propagates_prepare_video_media_rejection
  - test_read_video_generic_failure_returns_generic_error
  - test_read_video_uses_running_model_cfg_not_static_settings

### backend/tests/test_file_service.py

- 类型/层级：pytest / L1
- owner：backend/storage
- 源码声明数：32；外部依赖；无 skip
- 测试内容：
  - test_create_folder_delegates
  - test_create_folder_duplicate_raises
  - test_copy_folder_copies_subtree_files_and_targets_project
  - test_rename_folder_pathmirror_relocates
  - test_move_folder_pathmirror_relocates
  - test_move_folder_across_projects_relocates_subtree
  - test_opaque_skips_relocate
  - test_create_file_personal
  - test_create_file_keep_both_conflict
  - test_create_file_overwrite
  - test_create_file_overwrite_target_missing
  - test_create_file_quota_full
  - test_create_file_project_not_found
  - test_create_file_project_requires_id
  - test_create_file_in_project
  - test_update_file_rename
  - test_update_file_not_found
  - test_update_file_other_user_denied
  - test_copy_file
  - test_copy_file_not_found
  - test_rename_folder_moves_dir_and_cleans_orphan
  - test_rename_empty_folder_moves_dir
  - test_move_folder_out_keeps_live_parent_dir
  - test_file_move_keeps_source_folder_dir
  - test_delete_folder_trashes_files_and_removes_empty_dir
  - test_delete_folder_hides_from_list_and_get
  - test_delete_folder_not_found
  - test_restore_folder_round_trip
  - test_restore_folder_conflict_renames
  - test_delete_folder_keeps_already_trashed_file_untouched
  - test_create_file_rejects_deleted_folder_target
  - test_update_file_rejects_moving_into_deleted_folder

### backend/tests/test_file_upload_service.py

- 类型/层级：pytest / L1
- owner：backend/storage
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - test_parse_upload_filename_uses_display_name_and_normalized_extension

### backend/tests/test_file_write_safety.py

- 类型/层级：pytest / L1
- owner：backend/storage
- 源码声明数：6；无外部依赖；无 skip
- 测试内容：
  - test_resolves_legacy_generic_mime_from_image_bytes
  - test_thumbnail_failure_returns_original_bytes
  - test_preview_failure_does_not_populate_cache
  - test_expected_error_returns_4xx
  - test_retryable_error_has_public_message
  - test_internal_error_is_redacted

### backend/tests/test_files_api.py

- 类型/层级：pytest / L1
- owner：backend/storage
- 源码声明数：11；无外部依赖；无 skip
- 测试内容：
  - test_upload_endpoint
  - test_upload_keep_both_conflict
  - test_check_conflicts_keeps_batch_response_shape
  - test_upload_overwrite
  - test_upload_project_shapes_response
  - test_upload_project_not_found
  - test_patch_rename_endpoint
  - test_patch_not_found
  - test_copy_endpoint
  - test_copy_not_found
  - test_download_endpoint_reads_owned_file

### backend/tests/test_folder_doctor.py

- 类型/层级：pytest / L1
- owner：backend/storage
- 源码声明数：16；外部依赖；无 skip
- 测试内容：
  - test_scan_detects_missing
  - test_scan_detects_orphan
  - test_scan_ignores_structural_dirs
  - test_scan_ignores_nonempty_orphan
  - test_repair_creates_missing
  - test_repair_removes_orphan_only_with_flag
  - test_scan_healthy_after_create
  - test_scan_endpoint
  - test_repair_endpoint
  - test_scan_detects_misplaced_file
  - test_repair_relocates_file_only_with_flag
  - test_misplaced_file_skips_missing_physical_object
  - test_misplaced_file_skips_mind_space
  - test_scan_marks_misplaced_report_truncated
  - test_repair_relocate_resolves_conflict
  - test_repair_endpoint_relocate_files

### backend/tests/test_folder_storage_relocation.py

- 类型/层级：pytest / L1
- owner：backend/storage
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - test_relocate_folder_tree_files_rebuilds_personal_and_project_keys

### backend/tests/test_folder_tree.py

- 类型/层级：pytest / L1
- owner：backend/storage
- 源码声明数：22；无外部依赖；无 skip
- 测试内容：
  - test_create_personal_and_get
  - test_create_duplicate_conflict
  - test_create_project_not_found
  - test_create_in_owned_project
  - test_get_other_user_none
  - test_resolve_folder_path_nested
  - test_descendants
  - test_get_children_root
  - test_rename
  - test_rename_not_found
  - test_rename_version_conflict
  - test_move_ok_and_cycle
  - test_move_cross_space_invalid
  - test_move_target_not_found
  - test_move_version_conflict
  - test_soft_delete_hides_from_live_view
  - test_soft_delete_cascades_to_live_descendants
  - test_soft_delete_not_found
  - test_create_allows_reusing_deleted_name
  - test_restore_brings_back_folder_and_live_descendants
  - test_restore_excludes_independently_earlier_deleted_descendant
  - test_restore_not_found_when_not_deleted

### backend/tests/test_folders_api.py

- 类型/层级：pytest / L1
- owner：backend/storage
- 源码声明数：11；无外部依赖；无 skip
- 测试内容：
  - test_create_endpoint
  - test_create_duplicate_conflict
  - test_create_project_not_found
  - test_rename_endpoint
  - test_rename_not_found
  - test_rename_version_conflict
  - test_move_endpoint_and_cycle
  - test_move_target_not_found
  - test_move_and_copy_folder_across_project_endpoint
  - test_move_version_conflict
  - test_folder_download_rejects_other_user_folder

### backend/tests/test_io_retry_contract.py

- 类型/层级：pytest / L1
- owner：backend/storage
- 源码声明数：23；外部依赖；无 skip
- 测试内容：
  - test_oss_put_retries_on_request_error_then_succeeds
  - test_oss_get_exhausts_retries_raises_retryable_with_cause
  - test_oss_delete_retries_on_5xx_server_error
  - test_oss_put_does_not_retry_on_4xx
  - test_oss_get_does_not_retry_on_unrelated_exception
  - test_oss_stat_uses_get_object_meta_not_full_download
  - test_oss_stat_returns_none_when_missing
  - test_voice_transcribe_retries_on_timeout_then_succeeds
  - test_voice_transcribe_exhausts_retries_returns_empty_not_raise
  - test_voice_transcribe_does_not_retry_on_permanent_error
  - test_voice_transcribe_qwen_audio_30_uses_dashscope_native_api
  - test_dashscope_transcript_reads_qwen_audio_output_text
  - test_voice_transcribe_qwen3_asr_uses_native_asr_payload
  - test_voice_transcribe_fun_asr_uses_dashscope_audio_payload
  - test_voice_transcribe_uses_explicit_dashscope_service_not_model_prefix
  - test_voice_transcribe_accepts_dict_settings
  - test_http_get_retries_on_timeout_then_succeeds
  - test_http_get_exhausts_retries_returns_error
  - test_http_get_does_not_retry_on_non_transient_exception
  - test_http_get_stops_reading_oversized_response
  - test_http_get_batch_preserves_order_and_allows_partial_failure
  - test_http_get_batch_rejects_more_than_five_urls
  - test_http_get_schema_accepts_only_single_or_batch_url

### backend/tests/test_key_strategy.py

- 类型/层级：pytest / L1
- owner：backend/storage
- 源码声明数：4；无外部依赖；无 skip
- 测试内容：
  - test_pathmirror_equals_build_key
  - test_move_semantics_is_relocate
  - test_resolve_conflict_returns_resolved_key
  - test_resolve_conflict_no_collision

### backend/tests/test_path_migration.py

- 类型/层级：pytest / L1
- owner：backend/storage
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - test_parse_personal_path_keeps_nested_folder_parts
  - test_parse_project_path_ignores_year_month_prefix
  - test_path_migration_request_limits_batch_size

### backend/tests/test_send_file_url_streaming.py

- 类型/层级：pytest / L1
- owner：backend/storage
- 源码声明数：7；无外部依赖；无 skip
- 测试内容：
  - test_streaming_aborts_near_limit_not_full_body
  - test_streaming_accepts_under_limit
  - test_content_length_over_limit_rejected_before_read
  - test_send_file_disables_keepalive_to_prevent_cross_hop_tls_reuse
  - test_build_pinned_request_host_header_keeps_non_default_port
  - test_build_pinned_request_wraps_literal_ipv6_host_in_brackets
  - test_build_pinned_request_wraps_literal_ipv6_host_with_port

### backend/tests/test_storage_cleanup.py

- 类型/层级：pytest / L1
- owner：backend/storage
- 源码声明数：5；外部依赖；无 skip
- 测试内容：
  - test_delete_prefix_removes_all_user_objects
  - test_delete_prefix_spares_other_users
  - test_delete_prefix_missing_is_zero
  - test_delete_prefix_rejects_empty_and_root
  - test_delete_prefix_rejects_traversal

### backend/tests/test_storage_contract.py

- 类型/层级：pytest / L1
- owner：backend/storage
- 源码声明数：15；外部依赖；无 skip
- 测试内容：
  - test_put_get_roundtrip
  - test_exists
  - test_delete
  - test_rename_file
  - test_local_trash_hooks_move_and_restore
  - test_trash_key_uses_display_name
  - test_list_keys
  - test_delete_prefix_scoped
  - test_delete_prefix_rejects_root
  - test_copy
  - test_stat
  - test_ensure_folder_materializes_empty_dir
  - test_remove_empty_ancestors_prunes
  - test_remove_folder_empty_only
  - test_move_folder

### backend/tests/test_storage_keys.py

- 类型/层级：pytest / L1
- owner：backend/storage
- 源码声明数：8；无外部依赖；无 skip
- 测试内容：
  - test_safe_name_replaces_invalid_chars
  - test_build_key_personal
  - test_build_key_project
  - test_build_key_mind_and_asset
  - test_build_key_lowercases_ext_and_sanitizes
  - test_resolve_conflict_no_collision
  - test_resolve_conflict_bumps_on_collision
  - test_resolve_conflict_non_local_backend_skips

### backend/tests/test_storage_quota_ledger.py

- 类型/层级：pytest / L1
- owner：backend/storage
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - test_user_space_initialization_is_idempotent
  - test_usage_event_is_idempotent_and_rejects_over_quota
  - test_reconcile_records_actual_file_and_shell_usage

### backend/tests/test_storage_snapshots.py

- 类型/层级：pytest / L1
- owner：backend/storage
- 源码声明数：5；外部依赖；无 skip
- 测试内容：
  - test_sql_snapshots_splits_draft_and_attached
  - test_sql_snapshots_user_files_total
  - test_sql_snapshots_noop_when_lock_held
  - test_compute_sql_totals_does_not_write_snapshot
  - test_storage_live_totals_endpoint

### backend/tests/test_tool_video_media_dispatch.py

- 类型/层级：pytest / L1
- owner：backend/storage
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - test_dispatch_converts_video_media_key_to_content_blocks
  - test_dispatch_flattens_multiple_inspected_images

### backend/tests/test_trash_folders.py

- 类型/层级：pytest / L1
- owner：backend/storage
- 源码声明数：13；外部依赖；无 skip
- 测试内容：
  - test_delete_folder_endpoint_soft_deletes
  - test_delete_folder_endpoint_not_found
  - test_delete_folder_hidden_from_list_endpoint
  - test_list_trash_folders_top_level_only
  - test_list_trash_folders_excludes_live
  - test_trash_folder_endpoints_isolate_other_users
  - test_list_trash_folder_contents_returns_children
  - test_folder_deleted_files_are_hidden_and_cannot_restore_individually
  - test_empty_trash_removes_deleted_folder_with_its_files
  - test_hard_delete_trash_folder_removes_its_subtree
  - test_restore_folder_endpoint_round_trip
  - test_restore_folder_endpoint_not_found_when_live
  - test_cleanup_expired_purges_old_folder_and_keeps_recent

### backend/tests/test_video_cache.py

- 类型/层级：pytest / L1
- owner：backend/storage
- 源码声明数：15；外部依赖；无 skip
- 测试内容：
  - test_cache_hit_skips_transcode
  - test_prepare_video_cache_hit_reprobes_but_skips_transcode
  - test_cache_key_changes_with_storage_key
  - test_cache_key_changes_with_transcode_profile
  - test_no_cache_without_storage_key_or_user_id
  - test_cache_hit_refreshes_marker_with_set_not_expire
  - test_marker_missing_but_cache_file_present_self_heals
  - test_single_flight_dedupes_concurrent_transcode
  - test_video_cache_gc_skips_when_marker_alive
  - test_video_cache_gc_deletes_old_without_marker
  - test_video_cache_gc_skips_recent_without_marker
  - test_video_cache_gc_noop_when_lock_held
  - test_first_call_writes_cache_file_and_marker
  - test_alive_marker_present_but_cache_file_missing_retranscodes
  - test_video_cache_gc_records_snapshot

### backend/tests/test_web_download.py

- 类型/层级：pytest / L1
- owner：backend/storage
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - test_download_filename_prefers_explicit_name_and_infers_extension
  - test_web_download_saves_to_personal_root_by_default
  - test_web_download_rejects_conflicting_location

### frontend/e2e/file-drag-runtime.spec.ts

- 类型/层级：playwright / L3
- owner：frontend/e2e
- 源码声明数：13；外部依赖；含 skip
- 测试内容：
  - 单文件拖入文件夹
  - 单文件拖到面包屑返回上一层
  - 底部拖拽单卡不改变文件区滚动位置
  - 多选两个文件拖入文件夹，落地后能正常进入目标文件夹
  - 文件和文件夹混合多选后拖入文件夹
  - 单文件移动遇到 409 时回滚缓存和页面
  - 单文件移动被权限拒绝时回滚缓存和页面
  - 多文件移动部分失败时整体回滚

### frontend/e2e/file-lifecycle.spec.ts

- 类型/层级：playwright / L3
- owner：frontend/e2e
- 源码声明数：1；外部依赖；无 skip
- 测试内容：
  - 文件库：上传文件出现卡片，删除后卡片消失

### frontend/e2e/filesystem-phases.spec.ts

- 类型/层级：playwright / L3
- owner：frontend/e2e
- 源码声明数：10；外部依赖；含 skip
- 测试内容：
  - 阶段 1：共享展示层挂载文件库浏览壳
  - 阶段 2：目录进入后可以开启统一选择模式并退出
  - 阶段 2：连续 Shift 选择保持第一次点击的范围锚点
  - 阶段 2：批量选择工具栏统一暴露下载、剪切、复制和删除
  - 阶段 3：文件操作边界通过右键复制入口可达
  - 阶段 4：上传入口与空白区域右键菜单使用共享组件
  - 文件库回收站保留场景扩展且仍由通用面板承载工具栏
  - 项目文件区使用通用面板并保留项目工具栏适配层
  - 窄窗口下文件浏览面板不产生横向溢出

### frontend/src/assets/styles/file-browser-visual-regression.test.ts

- 类型/层级：vitest / L0
- owner：frontend/storage
- 源码声明数：20；无外部依赖；无 skip
- 测试内容：
  - 文件库直接宿主恢复 52px 工具栏高度，共享组件不重复拥有宿主高度
  - 网格/列表恢复 inset slider 几何并保留真实移动 pill
  - FolderCard 只拥有状态结构和动态 accent 混合，主题值统一由 component token 提供
  - 文件卡 hover/图片预框选不会覆盖 selected，亮色 full-card preview 由 FileCard 自己统一拥有
  - 20.4 selected ring 在 hover 时保持，generic hover utility 不再拥有 File/FolderCard shadow/transition
  - 框选 preview 与已选集合视觉互斥，同时保留完整 mouseup 命中集合
  - 网格与列表多选框共享 FolderCard 已验证的主题 token 和同一个勾形
  - 列表行状态只有共享 rows stylesheet 一个 paint/layout owner
  - 列表行布局不会再被 global reset 清零，并保留当前列排布而不是回退 20.4
  - 列表 compact proxy 只会收窄，窄项目文件区不会抓起一帧反向变宽
  - 暗色 File/FolderCard grabbing 修正只作用抓取阶段，landing 重新让组件目标底色参与渐变
  - 亮色咕咕卡片 grabbing 恢复卡片底色层和缩略图独立层
  - 亮色 Mono 画布卡片 grabbing 复用 Mono 描边，landing 不会被锁死
  - Mono 画布项目卡 landing 使用实色项目卡材质并移除抓取玻璃
  - 画布跨 Surface landing 保留目标内容交叉淡化，不关闭 target morph
  - 画布 landing 在指针下揭示时只抑制一次 hover，离开后恢复
  - 项目名输入框不再有 project 专属透明底，统一复用共享 input contract
  - 多选 checkbox 无高光阴影，最终主题层不再重复接管 checkbox/folder paint
  - 路径前进回退恢复 0.20.4 icon-first hover 样式
  - 项目 stage 亮色只重映射局部 option token，上传关闭按钮复用通用 control paint

### frontend/src/utils/fileLinks.test.ts

- 类型/层级：vitest / L0
- owner：frontend/storage
- 源码声明数：4；无外部依赖；无 skip
- 测试内容：
  - resolves a project-relative markdown file path
  - resolves a path relative to the current folder
  - resolves folders and keeps different projects isolated
  - does not take over external or unsafe links

### frontend/src/views/Admin/Ops/storageChart.test.ts

- 类型/层级：vitest / L0
- owner：frontend/storage
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - 按日期 union 对齐缺失快照，不按数组下标左移

### frontend/test/fileActionsScope.test.ts

- 类型/层级：vitest / L0
- owner：frontend/storage
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - 项目场景拒绝跨项目目标
  - 个人文件场景默认允许跨项目目标
  - 回收站场景默认拒绝普通写操作

### frontend/test/fileParse.test.ts

- 类型/层级：vitest / L0
- owner：frontend/storage
- 源码声明数：7；无外部依赖；无 skip
- 测试内容：
  - 优先 doneAt
  - doneAt 缺则退 startDate，再退 createdAt
  - 全空 → 未归类 / 00
  - 普通名拆 base + ext（ext 不含点、不改大小写）
  - 无扩展名 → ext 为空
  - 以点结尾 → ext 空、base 含名
  - 隐藏文件（点开头）→ base 空、ext 为其余

### frontend/test/fileProjection.test.ts

- 类型/层级：vitest / L0
- owner：frontend/storage
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - 按文本字段排序且不修改原数组
  - 按数字字段支持降序

### frontend/test/fileRuntimeMove.test.ts

- 类型/层级：vitest / L0
- owner：frontend/storage
- 源码声明数：5；无外部依赖；无 skip
- 测试内容：
  - 按对象类型把混合移动分发给文件夹和文件业务函数
  - 把面包屑目标交给页面解析，并忽略无效落点
  - 忽略浏览区、非法对象和文件夹拖到自身
  - 文件与文件夹分别获得自己的 optimistic intent，不互相清理 rollback chain
  - 同一卡片 regrab 后产生更高 revision，第二次 Action 成为最新意图

### frontend/test/fileSelection.test.ts

- 类型/层级：vitest / L0
- owner：frontend/storage
- 源码声明数：6；无外部依赖；无 skip
- 测试内容：
  - 按锚点和目标位置返回文件与文件夹集合
  - 锚点无效时不产生选择结果
  - 连续 Shift 选择保持第一次点击的锚点
  - 单选文件会清空文件夹选择，重复点击可取消
  - 单选文件夹与文件使用同一互斥规则
  - 替换混合文件和文件夹的范围选择

### frontend/test/fileSize.test.ts

- 类型/层级：vitest / L0
- owner：frontend/storage
- 源码声明数：5；无外部依赖；无 skip
- 测试内容：
  - 0 / 假值 → 0 B
  - B 档（<1024）原样拼接
  - KB 取整（四舍五入）
  - MB 保留 1 位
  - GB 保留 1 位

### frontend/test/filesNav.test.ts

- 类型/层级：vitest / L0
- owner：frontend/storage
- 源码声明数：14；无外部依赖；无 skip
- 测试内容：
  - personal
  - projects
  - trash
  - 未知 type → 原样返回当前路径
  - status → [项目, 状态]
  - year → [项目, 已完成, 年]
  - month → year 段取自当前路径的 year 段，month 段 year/month 取自卡片
  - month 但当前路径缺 year 段（异常/搜索跳转）→ 退用卡片自带 year，不崩
  - 已在 已完成/年/月 下点项目 → 保留三段再追加 project
  - 无上下文点项目 → [项目, project]
  - 个人文件下的文件夹 → [个人, folder(space:personal)]
  - 文件夹内嵌套子文件夹 → 追加，projectId/color 缺则回退当前段
  - 项目根下点文件夹 → 截到 project 段再追加
  - 无 project 段兜底 → 造 [项目, project(空名), folder]

### frontend/test/fileUploadController.test.ts

- 类型/层级：vitest / L0
- owner：frontend/storage
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - 按顶层目录聚合文件数量，不修改上传列表
  - 上传成功后移除文件 ghost，并完成顶层文件夹 ghost
  - 上传失败后标记文件 ghost，不会把失败吞成成功移除

### frontend/test/folderKeys.test.ts

- 类型/层级：vitest / L0
- owner：frontend/storage
- 源码声明数：5；无外部依赖；无 skip
- 测试内容：
  - key 列表 → 对应数字 folderId
  - 不在当前文件夹列表里的陈旧 key 被丢弃
  - 保持传入顺序
  - 接受 Set 作为入参（selectedFolderKeys 是 Set）
  - 空输入 → 空数组

### frontend/test/projectFileSorting.test.ts

- 类型/层级：vitest / L0
- owner：frontend/storage
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - 按当前排序字段返回文件夹和文件
  - 切换排序方向会同步更新派生结果

### frontend/test/projectFolderCards.test.ts

- 类型/层级：vitest / L0
- owner：frontend/storage
- 源码声明数：5；无外部依赖；无 skip
- 测试内容：
  - 按状态计数，空组不显示，顺序随 kanbanColumns
  - 全空 → 空数组
  - 只统计 done，按完成年份计数，年份降序
  - 某年 done 项目按完成月份计数，月份升序
  - 该年无 done → 空数组

### loopscope/packages/storage/src/parity.test.ts

- 类型/层级：node-test / L1
- owner：loopscope/runtime
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - 脱敏 parity fixture 的关键查询结构稳定

### loopscope/packages/storage/src/store.test.ts

- 类型/层级：node-test / L1
- owner：loopscope/runtime
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - TraceStore 对重复 run 上报保持幂等并可读回 spans
  - TraceStore 保留用户已有的会话标题并按 before 分页

## memory-rag

- 文件数：34
- 源码声明数：186

### backend/tests/test_compare_index_metrics.py

- 类型/层级：pytest / L1
- owner：backend/memory-rag
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - test_compare_metrics_are_aggregate_only_and_stable

### backend/tests/test_event_memory.py

- 类型/层级：pytest / L1
- owner：backend/memory-rag
- 源码声明数：7；无外部依赖；无 skip
- 测试内容：
  - test_normalize_event_memory_adds_event_prefix_to_headings
  - test_normalize_legacy_plain_memory_keeps_content_in_event_section
  - test_event_hash_is_stable_for_same_title_and_body
  - test_deduplicate_event_sections_merges_same_event_and_drops_exact_duplicate
  - test_merge_event_memory_keeps_existing_sections_and_deduplicates_increment
  - test_memory_vectors_reuse_unchanged_chunks_and_gc_removed_chunks
  - test_bailian_multimodal_embedding_uses_text_content

### backend/tests/test_global_search.py

- 类型/层级：pytest / L1
- owner：backend/memory-rag
- 源码声明数：13；无外部依赖；无 skip
- 测试内容：
  - test_run_global_search_matches_file_ext_case_insensitively
  - test_global_search_can_fall_back_to_ilike_backend
  - test_run_global_search_isolates_by_user
  - test_run_global_search_types_filter_narrows_result
  - test_run_global_search_per_type_limit_applies
  - test_global_search_ranks_exact_and_prefix_names_before_substrings
  - test_global_search_ranks_note_title_before_body_only_hit
  - test_global_search_tool_requires_query
  - test_global_search_tool_adds_note_when_nothing_found
  - test_global_search_tool_ignores_unknown_types
  - test_global_search_or_matches_any_keyword_in_one_call
  - test_global_search_tool_accepts_queries_without_legacy_q
  - test_global_search_and_requires_every_keyword

### backend/tests/test_knowledge_index_cache.py

- 类型/层级：pytest / L1
- owner：backend/memory-rag
- 源码声明数：6；无外部依赖；无 skip
- 测试内容：
  - test_index_cache_reuses_per_source_and_keeps_users_isolated
  - test_index_cache_revision_invalidates_after_incremental_replace
  - test_shared_snapshot_index_merges_sources_and_filters_by_source
  - test_shared_snapshot_index_merges_persistent_and_transient_documents
  - test_shared_snapshot_reuses_complete_persistent_index_without_loading_documents
  - test_cache_build_reuses_persistent_sidecar_revision

### backend/tests/test_knowledge.py

- 类型/层级：pytest / L1
- owner：backend/memory-rag
- 源码声明数：13；无外部依赖；无 skip
- 测试内容：
  - test_knowledge_store_upserts_same_topic_and_increments_version
  - test_knowledge_store_keeps_cross_source_conflict_visible
  - test_knowledge_store_does_not_cross_owner_or_group_scope
  - test_knowledge_adapter_exposes_source_and_confidence
  - test_search_memory_accepts_knowledge_source
  - test_knowledge_delete_is_tombstoned_and_removed_from_active_results
  - test_knowledge_store_uses_one_markdown_file_per_entry
  - test_knowledge_store_rejects_content_over_1000_characters
  - test_knowledge_reflection_limits_candidates_and_validates_operations
  - test_knowledge_capture_normalizes_mode_and_rejects_silent_truncation
  - test_knowledge_reflection_runs_after_candidate_and_downgrades_automatic
  - test_knowledge_reflection_explicit_save_can_be_confirmed
  - test_knowledge_reflection_conflict_keeps_parent_and_new_id

### backend/tests/test_memory_event_scopes.py

- 类型/层级：pytest / L1
- owner：backend/memory-rag
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - test_group_compaction_normalizes_and_deduplicates_memory
  - test_group_compaction_failure_does_not_write_or_trim_daily
  - test_member_batch_reflection_updates_each_real_member

### backend/tests/test_memory_injection_budget.py

- 类型/层级：pytest / L1
- owner：backend/memory-rag
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - test_memory_injection_budgets_are_two_thousand_chars
  - test_memory_fallback_respects_hard_budget_without_embedding
  - test_memory_fallback_respects_hard_budget_when_vector_coverage_is_insufficient

### backend/tests/test_memory_migration.py

- 类型/层级：pytest / L1
- owner：backend/memory-rag
- 源码声明数：25；外部依赖；无 skip
- 测试内容：
  - test_read_pattern_list_prefers_pattern_json
  - test_read_pattern_list_migrates_legacy_facts_json
  - test_read_pattern_list_migrates_ancient_facts_md
  - test_read_pattern_list_empty_when_nothing_exists
  - test_read_daily_lines_reads_grouped_daily
  - test_read_daily_lines_does_not_compat_legacy_daily
  - test_migrate_legacy_daily_rewrites_grouped_format
  - test_apply_profile_ops_add_and_dedupe
  - test_apply_profile_ops_remove
  - test_profile_schema_normalizes_legacy_id_and_type
  - test_render_profile_no_relevance_filtering
  - test_render_profile_caps_direct_injection_at_fifty
  - test_reflection_splits_temporal_profile_into_daily
  - test_apply_pattern_ops_add_observed_and_inferred
  - test_apply_pattern_ops_reinforce_upgrades_kind
  - test_apply_pattern_ops_remove
  - test_review_patterns_majority_vote_keeps_only_consensus
  - test_review_patterns_all_trials_fail_to_parse_skips_user
  - test_cleanup_legacy_removes_old_files_once_migrated
  - test_cleanup_legacy_noop_before_migration
  - test_cleanup_legacy_dry_run_does_not_delete
  - test_migrate_daily_reports_preview_lines
  - test_migrate_profile_events_moves_temporal_profile_to_memory
  - test_migrate_profile_events_dedupes_existing_memory
  - test_compress_includes_profile_and_pattern_context

### backend/tests/test_memory_periodic.py

- 类型/层级：pytest / L1
- owner：backend/memory-rag
- 源码声明数：4；无外部依赖；无 skip
- 测试内容：
  - test_below_threshold_does_not_schedule
  - test_threshold_schedules_once_for_active_user
  - test_cooldown_and_growth_gate
  - test_review_error_does_not_advance_watermark

### backend/tests/test_rag_daily_freshness.py

- 类型/层级：pytest / L1
- owner：backend/memory-rag
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - test_persistent_memory_refreshes_daily_and_matches_compact_entity
  - test_daily_projection_is_reused_until_snapshot_revision_changes

### backend/tests/test_rag_hybrid.py

- 类型/层级：pytest / L1
- owner：backend/memory-rag
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - test_hybrid_uses_cached_vectors_and_is_stable
  - test_hybrid_falls_back_without_cache

### backend/tests/test_rag_index_gc.py

- 类型/层级：pytest / L1
- owner：backend/memory-rag
- 源码声明数：1；外部依赖；无 skip
- 测试内容：
  - test_sweep_ts_index_cache_removes_only_stale_owner_indexes

### backend/tests/test_rag_index.py

- 类型/层级：pytest / L1
- owner：backend/memory-rag
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - test_index_invalidation_keeps_snapshot_baseline
  - test_persistent_memory_index_roundtrip
  - test_memory_index_worker_retries_three_times

### backend/tests/test_rag_injection.py

- 类型/层级：pytest / L1
- owner：backend/memory-rag
- 源码声明数：10；外部依赖；无 skip
- 测试内容：
  - test_memory_scope_adapter_renders_profile_dict_entries
  - test_memory_scope_adapter_includes_member_event_memory
  - test_rag_history_injection_hides_internal_identity_fields
  - test_empty_rag_results_do_not_create_history_message
  - test_passive_recall_only_targets_historical_questions
  - test_passive_recall_uses_same_knowledge_service
  - test_automatic_recall_uses_group_then_member_scope_and_deduplicates
  - test_automatic_recall_respects_global_rag_switch
  - test_automatic_recall_does_not_repeat_persisted_hash
  - test_automatic_recall_timeout_does_not_block_agent

### backend/tests/test_rag_memory_service.py

- 类型/层级：pytest / L1
- owner：backend/memory-rag
- 源码声明数：7；外部依赖；无 skip
- 测试内容：
  - test_memory_search_reads_only_owner_namespace
  - test_memory_search_accepts_current_group_scope
  - test_memory_query_scope_rejects_private_memory_for_member
  - test_memory_query_scope_rejects_private_memory_in_owner_group
  - test_memory_search_respects_total_output_budget
  - test_memory_search_truncates_first_oversized_chunk
  - test_memory_search_excludes_chunks_already_in_snapshot

### backend/tests/test_rag_models.py

- 类型/层级：pytest / L1
- owner：backend/memory-rag
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - test_index_document_identity_is_stable
  - test_sections_and_chunks_keep_order_and_bounds
  - test_recall_candidate_keeps_stable_identity_and_rank

### backend/tests/test_rag_retriever.py

- 类型/层级：pytest / L1
- owner：backend/memory-rag
- 源码声明数：13；无外部依赖；无 skip
- 测试内容：
  - test_unified_retriever_dispatches_registered_source
  - test_database_retrievers_use_independent_sessions_for_parallel_recall
  - test_unified_retriever_rejects_duplicate_source
  - test_recall_service_merges_same_content_citations
  - test_recall_service_applies_scope_filter_before_selection
  - test_project_adapter_is_owner_only_and_keeps_project_citation
  - test_project_adapter_accepts_db_factory
  - test_recall_service_limits_by_source_type_not_source_id
  - test_recall_diagnostics_creates_redacted_loopscope_span
  - test_recall_diagnostics_preserves_multiple_scope_identity
  - test_recall_scope_details_split_group_and_member_candidates
  - test_conversation_rag_excludes_current_message_watermark
  - test_conversation_watermark_reaches_ts_search_input

### backend/tests/test_rag_tokenizer_parity.py

- 类型/层级：pytest / L1
- owner：backend/memory-rag
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - test_ts_tokenizer_matches_golden_corpus

### backend/tests/test_rag_ts_sidecar.py

- 类型/层级：pytest / L1
- owner：backend/memory-rag
- 源码声明数：5；无外部依赖；无 skip
- 测试内容：
  - test_wire_document_keeps_business_fields_for_cold_restore
  - test_index_dir_for_owner_uses_hidden_user_storage
  - test_ts_worker_replace_search_and_persist
  - test_ts_worker_patch_updates_only_changed_chunks
  - test_sidecar_reaper_handles_owner_registry_and_shared_rank_client

### backend/tests/test_rag_vector_cache.py

- 类型/层级：pytest / L1
- owner：backend/memory-rag
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - test_rag_vector_cache_uses_document_keys_and_keeps_legacy_memory

### backend/tests/test_scoped_store.py

- 类型/层级：pytest / L1
- owner：backend/memory-rag
- 源码声明数：4；外部依赖；无 skip
- 测试内容：
  - test_read_scope_json_only_reads_requested_file
  - test_read_scope_json_returns_empty_dict_when_missing
  - test_read_scope_json_returns_empty_dict_on_malformed_json
  - test_read_scope_json_rejects_non_json_filename

### backend/tests/test_search_query.py

- 类型/层级：pytest / L1
- owner：backend/memory-rag
- 源码声明数：4；无外部依赖；无 skip
- 测试内容：
  - test_normalize_queries_keeps_legacy_phrase_and_deduplicates_array
  - test_normalize_queries_limits_count_and_length
  - test_normalize_mode_defaults_invalid_values_to_or
  - test_keyword_condition_builds_or_or_and_groups

### backend/tests/test_search_scenarios.py

- 类型/层级：pytest / L1
- owner：backend/memory-rag
- 源码声明数：8；外部依赖；无 skip
- 测试内容：
  - test_scenario_without_target_searches_all_relevant_types
  - test_scenario_global_search_accepts_unified_query_alias
  - test_scenario_explicit_target_does_not_expand_search_scope
  - test_scenario_and_requires_all_terms_in_one_record
  - test_scenario_history_search_uses_multiple_terms_once
  - test_scenario_note_search_uses_multiple_terms_once
  - test_scenario_group_search_stays_in_current_group
  - test_scenario_no_target_match_returns_explainable_empty_result

### backend/tests/test_search_settings.py

- 类型/层级：pytest / L1
- owner：backend/memory-rag
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - test_rag_auto_sources_are_enabled_by_default
  - test_rag_index_ttl_has_safe_default_and_bounds

### backend/tests/test_search_tools.py

- 类型/层级：pytest / L1
- owner：backend/memory-rag
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - test_search_conversations_accepts_multiple_keywords

### backend/tests/test_searxng_search_status.py

- 类型/层级：pytest / L1
- owner：backend/memory-rag
- 源码声明数：18；外部依赖；无 skip
- 测试内容：
  - test_parse_requested_engines_is_config_driven_and_deduplicated
  - test_searxng_search_url_encodes_unicode_query_as_utf8
  - test_normalize_engine_failures_maps_common_reasons_and_tolerates_shapes
  - test_search_status_ok_empty_degraded_and_unavailable
  - test_results_are_kept_when_failures_exist
  - test_unrequested_engine_failure_does_not_degrade_status
  - test_build_response_distinguishes_empty_degraded_and_unavailable_notes
  - test_search_health_log_does_not_log_query_text
  - test_web_search_surfaces_all_engine_failure_as_unavailable
  - test_web_search_timeout_switches_to_deep_research
  - test_image_search_reuses_status_and_keeps_results_when_degraded
  - test_image_search_only_returns_candidates_without_visual_inspection
  - test_inspect_images_reads_only_model_selected_results
  - test_similar_image_url_counts_toward_three_call_budget
  - test_inspect_images_accepts_similar_image_result_url
  - test_inspect_images_rejects_more_than_twenty_targets
  - test_inspect_images_can_read_historical_attachment
  - test_search_tool_schemas_expose_query_contract_and_max_results_bounds

### backend/tests/test_stance_history.py

- 类型/层级：pytest / L1
- owner：backend/memory-rag
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - test_persisted_stance_context_replays_as_internal_reminder
  - test_history_stance_digest_uses_persisted_event_before_session_state

### backend/ts/packages/data-runtime/test/rag-loader.test.ts

- 类型/层级：node-test / L1
- owner：backend/ts
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - Data Runtime RAG loader 按来源生成统一 batch
  - loadRagBatchCached 统一读取新增来源并保留 per-source cache 状态
  - loadMemoryCached 在同一 revision 下复用 StorageReader 结果

### backend/ts/workers/rag/test/index-cache-service.test.ts

- 类型/层级：node-test / L1
- owner：backend/ts
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - TS RAG index cache 按 revision 和 TTL 管理索引有效性

### backend/ts/workers/rag/test/rag-service.test.ts

- 类型/层级：node-test / L1
- owner：backend/ts
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - TS RAG service 在同一 scope/revision 复用索引并把召回交给 worker
  - TS RAG service 不接受缺少 scope 或 revision 的请求

### backend/ts/workers/rag/test/snapshot-cache.test.ts

- 类型/层级：node-test / L1
- owner：backend/ts
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - RAG snapshot cache 在相同 scope/revision 下复用并刷新访问 TTL
  - RAG snapshot cache 在 revision 改变时重建且不同 scope 不共享

### backend/ts/workers/rag/test/source-adapters.test.ts

- 类型/层级：node-test / L1
- owner：backend/ts
- 源码声明数：4；无外部依赖；无 skip
- 测试内容：
  - 文件适配器输出稳定 chunk，并且不写入内部存储路径
  - 来源适配器接受数值 0 作为合法标识
  - 画布适配器保留节点和关系引用，但不把普通时间流笔记混入
  - 对话适配器只接受有 scope 的稳定消息切片

### backend/ts/workers/rag/test/worker.protocol.test.ts

- 类型/层级：node-test / L1
- owner：backend/ts
- 源码声明数：9；无外部依赖；无 skip
- 测试内容：
  - RAG worker 遵守 JSONL ping 与 replace/search contract
  - RAG worker 的统一 builder 可构建所有通用 source record
  - RAG worker 可在一次协议请求内构建并更新索引
  - RAG worker 在截断前应用 source 与 scope 过滤
  - RAG worker 使用 metadata 过滤 project/folder scope
  - RAG worker unified_search 执行正文去重、来源上限和字符预算
  - TS 完整候选流水线与 Python 评分契约保持一致
  - rank_candidates 在评分前排除已注入的历史内容
  - rank_candidates 返回跨来源 citation 和按来源诊断

### frontend/src/views/Calendar/composables/useCalendarDrag.test.ts

- 类型/层级：vitest / L0
- owner：frontend/memory-rag
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - mouseup 使用释放位置更新吸附日期，而不是使用按下位置
  - 组件卸载后不会继续响应遗留的鼠标事件
  - 已完成项目不会启动移动或缩放预览

## terminal-runtime

- 文件数：27
- 源码声明数：176

### backend/tests/test_docker_runtime.py

- 类型/层级：pytest / L2
- owner：backend/terminal-runtime
- 源码声明数：40；外部依赖；无 skip
- 测试内容：
  - test_probe_reports_missing_docker
  - test_docker_environment_prefers_current_user_rootless_socket
  - test_docker_environment_respects_explicit_host
  - test_probe_reports_rootless_daemon
  - test_probe_does_not_treat_daemon_failure_as_ready
  - test_sandbox_readiness_requires_enabled_rootless_and_digest
  - test_image_available_uses_current_docker_daemon
  - test_image_available_rejects_invalid_digest
  - test_cleanup_running_sandboxes_only_removes_labeled_containers
  - test_cleanup_running_sandboxes_does_not_fail_without_containers
  - test_sandboxd_request_round_trips_as_json
  - test_sandboxd_egress_request_requires_future_expiry
  - test_sandboxd_rejects_non_finite_egress_expiry
  - test_docker_execution_uses_unique_container_name_for_cleanup
  - test_sandboxd_server_rejects_root_outside_allowed_root
  - test_cleanup_orphan_pty_containers_only_uses_fixed_namespace
  - test_sandbox_override_includes_sandboxd_socket
  - test_sandbox_readiness_rejects_disabled
  - test_sandbox_readiness_rejects_invalid_egress_configuration
  - test_egress_proxy_must_be_http_without_embedded_credentials
  - test_admin_egress_proxy_config_rejects_credentials_and_query
  - test_admin_sandbox_state_requires_loaded_image
  - test_admin_sandbox_state_ready_only_when_image_is_loaded
  - test_admin_executor_readiness_is_independent_of_enabled_switch
  - test_admin_sandbox_status_does_not_echo_invalid_proxy
  - test_docker_executor_builds_fixed_security_argv
  - test_docker_executor_uses_only_controlled_egress_network
  - test_docker_executor_builds_fixed_interactive_pty_argv
  - test_docker_executor_uses_one_image_reference_for_command_and_pty
  - test_docker_executor_rejects_unpinned_image
  - test_docker_executor_rejects_egress_with_invalid_network_name
  - test_docker_executor_applies_ephemeral_quota_to_tmpfs
  - test_parse_subordinate_ranges_ignores_other_users
  - test_permission_plan_maps_container_id_and_is_non_destructive
  - test_permission_plan_rejects_root_directory
  - test_discover_shell_roots_only_scans_user_directories
  - test_systemd_templates_pin_rootless_socket
  - test_quota_measurement_ignores_symlinks_and_checks_reservation
  - test_sandbox_root_initializer_only_creates_shell_directory
  - test_clear_sandbox_directory_keeps_root_and_removes_contents

### backend/tests/test_loopscope_tokenizer.py

- 类型/层级：pytest / L1
- owner：backend/terminal-runtime
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - test_tokenizer_path_uses_model_prefix
  - test_tokenizer_failure_falls_back_without_breaking

### backend/tests/test_loopscope_trace_restore.py

- 类型/层级：pytest / L1
- owner：backend/terminal-runtime
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - test_restore_trace_recreates_pending_run
  - test_tool_schema_error_span_keeps_schema_and_redacts_argument_values

### backend/tests/test_loopscope_usage.py

- 类型/层级：pytest / L1
- owner：backend/terminal-runtime
- 源码声明数：5；无外部依赖；无 skip
- 测试内容：
  - test_context_threshold_uses_cache_tokens_for_anthropic
  - test_context_threshold_does_not_double_count_openai_cache_tokens
  - test_usage_lands_before_done_break
  - test_loopscope_wrapper_without_active_run_accepts_session_id
  - test_mid_stream_abort_marks_span_cancelled

### backend/tests/test_migrate_qqbot_runtime_keys.py

- 类型/层级：pytest / L1
- owner：backend/terminal-runtime
- 源码声明数：6；外部依赖；无 skip
- 测试内容：
  - test_imreach_platform_suffixed_key_migrates_without_data_loss
  - test_imsession_key_migrates
  - test_bare_imreach_key_platform_field_rewritten_in_place
  - test_bare_imreach_key_untouched_when_not_qq
  - test_dry_run_does_not_modify_redis
  - test_move_key_skips_instead_of_deleting_when_old_equals_new

### backend/tests/test_process_logging.py

- 类型/层级：pytest / L1
- owner：backend/terminal-runtime
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - test_timestamped_stream_prefixes_split_print_line
  - test_timestamped_stream_does_not_double_prefix_existing_timestamp
  - test_timestamped_stream_flushes_partial_line

### backend/tests/test_run_finalize.py

- 类型/层级：pytest / L1
- owner：backend/terminal-runtime
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - test_finalize_run_uses_one_canonical_persistence_contract
  - test_finalize_run_does_not_record_byok_usage

### backend/tests/test_runtime_state_scope.py

- 类型/层级：pytest / L1
- owner：backend/terminal-runtime
- 源码声明数：10；外部依赖；无 skip
- 测试内容：
  - test_cancel_in_other_scope_does_not_cancel_this_scope
  - test_cancel_in_same_scope_cancels_this_scope
  - test_cancel_clear_cancel_isolated_per_scope
  - test_state_isolated_per_scope
  - test_mark_active_sets_ttl
  - test_set_state_refreshes_active_ttl
  - test_refresh_activity_refreshes_state_and_active_ttl
  - test_init_activity_performs_all_three_effects
  - test_init_activity_noop_when_scope_incomplete
  - test_init_activity_is_a_single_atomic_call

### backend/tests/test_shell_concurrency.py

- 类型/层级：pytest / L1
- owner：backend/terminal-runtime
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - test_same_session_shell_lock_serializes_operations

### backend/tests/test_shell_policy.py

- 类型/层级：pytest / L1
- owner：backend/terminal-runtime
- 源码声明数：19；外部依赖；无 skip
- 测试内容：
  - test_shell_risk_scans_the_whole_command
  - test_shell_schema_does_not_expose_session_identity
  - test_shell_lease_covers_non_destructive_operations
  - test_configured_shell_refuses_when_docker_sandbox_is_disabled
  - test_dangerous_shell_requires_admin_and_user_switches
  - test_dangerous_shell_requires_user_switch_even_when_confirmed
  - test_dangerous_shell_keeps_confirmation_gate
  - test_shell_autopilot_skips_confirmation_only_with_two_level_permission
  - test_unbound_session_does_not_become_global_shell
  - test_legacy_personal_scope_is_ignored
  - test_unbound_session_uses_system_scope
  - test_system_scope_uses_explicit_permissions_even_with_cloud_model
  - test_existing_session_object_avoids_stale_im_session_id
  - test_system_scope_off_uses_default_sandbox
  - test_system_permission_does_not_change_default_scope
  - test_workspace_cannot_opt_into_system_scope
  - test_shell_user_switch_off_blocks_default_sandbox
  - test_workspace_binding_only_changes_sandbox_mount
  - test_workspace_scope_requires_user_permission

### backend/tests/test_shell_sandbox.py

- 类型/层级：pytest / L1
- owner：backend/terminal-runtime
- 源码声明数：16；无外部依赖；含 skip
- 测试内容：
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

### backend/tests/test_shell_workspaces.py

- 类型/层级：pytest / L1
- owner：backend/terminal-runtime
- 源码声明数：5；无外部依赖；无 skip
- 测试内容：
  - test_shell_is_disabled_by_default
  - test_workspace_binding_is_owned_and_can_be_cleared
  - test_oss_storage_keeps_a_local_sandbox_root
  - test_workspace_can_be_renamed_disabled_and_deleted_without_deleting_project
  - test_bound_workspace_resolves_file_target_and_rejects_other_project

### backend/tests/test_start_systemd.py

- 类型/层级：pytest / L1
- owner：backend/terminal-runtime
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - test_systemd_start_fails_when_worker_is_not_active
  - test_systemd_start_succeeds_when_all_services_are_active
  - test_systemd_start_fails_when_worker_drops_after_first_active_check

### backend/tests/test_terminal_access.py

- 类型/层级：pytest / L1
- owner：backend/terminal-runtime
- 源码声明数：16；外部依赖；无 skip
- 测试内容：
  - test_terminal_contract_has_stable_source_and_status_values
  - test_terminal_page_hidden_when_admin_shell_is_disabled
  - test_terminal_page_can_show_without_workspace_when_shell_is_enabled
  - test_terminal_operations_reject_foreign_session
  - test_terminal_owner_can_terminate_or_close_after_permission_revoked
  - test_terminal_events_preserve_user_source_and_sequence
  - test_reset_terminal_keeps_history_but_clears_runtime_state
  - test_terminal_event_replay_is_ordered_and_respects_cursor
  - test_multiple_terminals_keep_event_streams_isolated
  - test_failed_terminal_command_persists_failure_feedback
  - test_reopen_preserves_command_and_status_history
  - test_terminal_sse_replays_closed_terminal_until_end_marker
  - test_terminal_lookup_is_owner_scoped
  - test_exited_terminal_can_reopen_without_losing_history
  - test_terminated_terminal_can_reopen
  - test_terminal_input_allows_user_terminal_without_session

### backend/tests/test_terminal_contracts.py

- 类型/层级：pytest / L1
- owner：backend/terminal-runtime
- 源码声明数：2；外部依赖；无 skip
- 测试内容：
  - test_terminal_modes_keep_agent_and_interactive_protocols_distinct
  - test_terminal_session_defaults_do_not_claim_a_live_pty

### backend/tests/test_terminal_protocol.py

- 类型/层级：pytest / L1
- owner：backend/terminal-runtime
- 源码声明数：4；外部依赖；无 skip
- 测试内容：
  - test_pty_client_protocol_validates_input_resize_and_signal
  - test_pty_client_protocol_rejects_unsafe_or_invalid_messages
  - test_pty_output_message_does_not_allow_empty_chunks
  - test_non_object_client_message_is_rejected

### backend/tests/test_terminal_pty_manager.py

- 类型/层级：pytest / L2
- owner：backend/terminal-runtime
- 源码声明数：8；外部依赖；无 skip
- 测试内容：
  - test_manager_forwards_input_resize_and_signal_only_when_attached
  - test_manager_subscribes_before_starting_output_pump
  - test_manager_reaps_detached_pty_and_forces_close
  - test_manager_closes_pty_when_output_exceeds_session_limit
  - test_manager_unsubscribes_disconnected_output_queue
  - test_manager_limits_attached_clients_and_stops_reaper
  - test_sandbox_policy_rejects_unsafe_pty_boundary
  - test_sandbox_bridge_delegates_only_sandbox_pty_to_transport

### backend/tests/test_trace_ops.py

- 类型/层级：pytest / L1
- owner：backend/terminal-runtime
- 源码声明数：12；外部依赖；无 skip
- 测试内容：
  - test_new_trace_sets_and_returns
  - test_set_trace_restores_upstream_id
  - test_set_trace_generates_when_empty
  - test_bind_im_run_assigns_session_metadata
  - test_record_context_compaction_creates_redacted_span
  - test_finish_run_closes_non_web_scope_run
  - test_finish_run_restores_final_response_from_last_llm_draft
  - test_discard_run_does_not_close_or_publish
  - test_bucket_edges
  - test_security_events_defined
  - test_record_security_no_loop_is_safe
  - test_log_traj_carries_trace

### backend/ts/packages/data-runtime/test/cache.test.ts

- 类型/层级：node-test / L1
- owner：backend/ts
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - Data Runtime cache 按 revision 和 TTL 复用并失效
  - Data Runtime cache 可以按 key 或整体失效
  - Data Runtime cache 支持按业务边界精确失效

### backend/ts/packages/data-runtime/test/contracts.test.ts

- 类型/层级：node-test / L1
- owner：backend/ts
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - Data Runtime 只接受与 owner 一致的 owner scope

### backend/ts/packages/data-runtime/test/documents.test.ts

- 类型/层级：node-test / L1
- owner：backend/ts
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - Data Runtime chunk 使用稳定 key 并输出 digest
  - Data Runtime diff 只返回变化 chunk 和删除 chunk

### backend/ts/packages/data-runtime/test/invalidation.test.ts

- 类型/层级：node-test / L1
- owner：backend/ts
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - Data Runtime 归一化 Python 业务来源事件
  - Data Runtime invalidation bridge 可挂载和解除订阅

### backend/ts/packages/data-runtime/test/runtime.test.ts

- 类型/层级：node-test / L1
- owner：backend/ts
- 源码声明数：6；无外部依赖；无 skip
- 测试内容：
  - Data Runtime 来源读取按 owner/scope/source/revision 命中缓存
  - Data Runtime 业务失效事件只清理对应 owner 和来源
  - Data Runtime 把数据库异常转换为结构化错误并拒绝关闭后的读取
  - Data Runtime 拒绝非法分页游标
  - Data Runtime 读取 Knowledge 和 Canvas 时保留 owner 边界
  - Data Runtime 的 Memory 读取只通过显式 StorageReader

### frontend/e2e/terminals.spec.ts

- 类型/层级：playwright / L3
- owner：frontend/e2e
- 源码声明数：1；外部依赖；无 skip
- 测试内容：
  - 交互式终端可以创建、连接、输入并删除

### frontend/src/views/Terminals/terminalEvents.test.ts

- 类型/层级：vitest / L0
- owner：frontend/terminal-runtime
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - 把状态占位、流式输出和最终事件合并为一条记录
  - 重复收到最终事件时不追加重复记录，并标记取消

### loopscope/apps/collector/src/server.test.ts

- 类型/层级：node-test / L1
- owner：loopscope/runtime
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - Collector HTTP API ingests and paginates traces

### loopscope/packages/db/src/index.test.ts

- 类型/层级：node-test / L1
- owner：loopscope/runtime
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - 新数据库会建立完整的 LoopScope schema
  - 旧数据库缺少新增列时会原地迁移并可重复打开

## im

- 文件数：32
- 源码声明数：310

### backend/tests/test_feedback_email.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - test_notify_feedback_sends_when_enabled
  - test_notify_feedback_skips_when_disabled

### backend/tests/test_feishu_gateway_guards.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：5；外部依赖；无 skip
- 测试内容：
  - test_feishu_drops_misrouted_app_id
  - test_feishu_drops_stale_retry
  - test_feishu_keeps_fresh_retry_window
  - test_feishu_gateway_deduplicates_message_id
  - test_feishu_message_still_reaches_stream_when_shortcut_redis_fails

### backend/tests/test_feishu_interactions.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：4；无外部依赖；无 skip
- 测试内容：
  - test_feishu_action_value_round_trip
  - test_feishu_action_value_rejects_untrusted_shapes
  - test_feishu_card_contains_only_action_tokens
  - test_feishu_completed_card_has_no_actions

### backend/tests/test_feishu_media.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：9；外部依赖；无 skip
- 测试内容：
  - test_extract_card_text_collects_markdown_and_text_nodes
  - test_extract_card_text_handles_streaming_card_schema
  - test_ingest_interactive_returns_card_text
  - test_ingest_interactive_falls_back_when_empty
  - test_ingest_post_falls_back_on_malformed_json
  - test_ingest_post_joins_text_and_downloads_media
  - test_ingest_post_appends_fallback_text_when_download_fails
  - test_ingest_media_handles_video_message
  - test_fetch_quoted_text_requests_user_card_content

### backend/tests/test_im_conversation_key.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：6；无外部依赖；无 skip
- 测试内容：
  - test_same_user_same_group_same_bot_shares_key
  - test_same_user_different_groups_do_not_share_key
  - test_same_user_group_and_private_do_not_share_key
  - test_same_user_different_bots_do_not_share_key
  - test_private_chat_uses_sender_as_scope_id
  - test_missing_routing_fields_still_produces_a_key_without_raising

### backend/tests/test_im_dedup.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：13；外部依赖；无 skip
- 测试内容：
  - test_dedup_first_sight_returns_true_and_calls_setnx
  - test_dedup_duplicate_returns_false
  - test_dedup_namespace_isolates_channels
  - test_dedup_no_message_id_skips_check
  - test_dedup_empty_string_treated_as_missing
  - test_dedup_strips_whitespace
  - test_dedup_redis_failure_falls_through
  - test_dedup_redis_wrong_type_falls_through
  - test_dedup_ttl_is_600_seconds
  - test_produce_returns_none_on_duplicate
  - test_produce_xadds_on_first_sight
  - test_produce_sync_returns_none_on_duplicate
  - test_produce_sync_xadds_on_first_sight

### backend/tests/test_im_identity.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：28；无外部依赖；无 skip
- 测试内容：
  - test_resolve_owner_account_returns_canonical_uuid
  - test_qq_group_owner_gets_full_tool_set
  - test_qq_group_member_only_gets_configured_allowlist
  - test_qq_group_unknown_uses_minimum_allowlist
  - test_group_context_search_only_reads_current_group
  - test_group_context_search_accepts_multiple_keywords
  - test_im_identity_context_is_not_injected_into_webchat
  - test_member_context_policy_does_not_load_owner_context
  - test_web_context_policy_keeps_full_context
  - test_tool_permission_filter_and_dispatch_gate_share_the_same_rule
  - test_member_display_name_does_not_use_owner_account_name
  - test_actor_context_keeps_owner_and_platform_identity_separate
  - test_im_loop_prepares_actor_and_agent_request
  - test_non_qq_group_defaults_to_unknown_minimal_access
  - test_feishu_group_uses_bound_owner_open_id
  - test_non_qq_private_message_keeps_owner_access
  - test_feishu_private_message_keeps_owner_access
  - test_group_history_keeps_sender_id_and_name_in_model_context
  - test_history_does_not_inject_persisted_message_time
  - test_current_group_message_has_priority_sender_anchor
  - test_session_route_uses_group_id_for_group_and_sender_id_for_private_chat
  - test_im_session_scope_filters_isolate_group_and_private_sessions
  - test_im_session_scope_filters_private_missing_puid_fails_closed
  - test_im_session_scope_filters_include_bot_id
  - test_im_sessions_are_isolated_by_bot_id
  - test_im_loop_selects_member_or_owner_facade_without_duplicate_runtime
  - test_worker_handle_delegates_business_dispatch_to_im_loop
  - test_im_identity_context_marks_group_and_compares_history

### backend/tests/test_im_media_ingress.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：10；无外部依赖；无 skip
- 测试内容：
  - test_worker_merges_qq_face_marker_into_image_without_placeholder_text
  - test_worker_merges_qq_emoji_refs_from_all_payloads
  - test_qq_media_ingress_stages_raw_attachment_with_source_message
  - test_qq_face_media_ingress_persists_face_marker
  - test_qq_quoted_media_reuses_source_without_download
  - test_qq_quoted_media_falls_back_to_download_when_not_reusable
  - test_qq_media_ingress_does_not_stage_without_owner
  - test_qq_media_ingress_rejects_attachment_over_limit
  - test_qq_media_ingress_rejects_stream_without_content_length
  - test_qq_media_ingress_enforces_message_total_limit

### backend/tests/test_im_members.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：35；外部依赖；无 skip
- 测试内容：
  - test_resolve_speaker_by_platform_user_id
  - test_resolve_speaker_by_stale_platform_user_id_from_members
  - test_resolve_speaker_by_name_live_unique
  - test_resolve_speaker_by_former_name_live
  - test_resolve_speaker_by_name_live_ambiguous
  - test_resolve_speaker_by_name_substring
  - test_resolve_speaker_by_name_substring_reverse_direction
  - test_resolve_speaker_alias_after_name_left_retention_window
  - test_resolve_speaker_alias_ambiguous_returns_candidates
  - test_resolve_speaker_nickname_unique
  - test_resolve_speaker_nickname_ambiguous_returns_candidates
  - test_resolve_speaker_not_found
  - test_resolve_speaker_empty
  - test_resolve_speaker_does_not_read_members_when_id_hit
  - test_resolve_speaker_reads_members_even_on_exact_live_name_hit
  - test_resolve_speaker_exact_alias_beats_fuzzy_live_name
  - test_resolve_speaker_multiple_exact_matches_are_ambiguous_not_silent
  - test_merge_members_first_appearance
  - test_merge_members_rename_appends_alias
  - test_merge_members_appends_intermediate_names_from_multi_rename_batch
  - test_merge_members_names_seen_missing_does_not_break
  - test_merge_members_preserves_existing_nicknames
  - test_merge_members_keeps_stale_member_out_of_aggregation_window
  - test_merge_members_stale_member_reappears_next_round_keeps_history
  - test_apply_nicknames_appends_for_known_member
  - test_apply_nicknames_ignores_unknown_member
  - test_apply_nicknames_dedup
  - test_merge_group_profile_merges_similar_duplicates
  - test_merge_group_profile_keeps_distinct_items
  - test_merge_group_profile_does_not_merge_low_similarity
  - test_merge_profile_merges_similar_duplicates
  - test_aggregate_members_counts_and_last_seen
  - test_aggregate_members_rename_within_window_does_not_split_count
  - test_aggregate_members_collects_all_distinct_names_seen
  - test_aggregate_members_ignores_bot_messages

### backend/tests/test_im_memory_admin.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - test_im_memory_summary_does_not_expose_scope_identifiers
  - test_im_memory_maintenance_requires_confirmation

### backend/tests/test_im_memory_scopes.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：23；外部依赖；无 skip
- 测试内容：
  - test_memory_scope_separates_bot_group_and_user
  - test_memory_scope_rejects_path_traversal
  - test_platform_user_scope_includes_event_memory_file
  - test_format_im_memory_keeps_member_scope_separate
  - test_format_im_memory_does_not_inject_platform_user_for_unknown
  - test_group_and_platform_user_memory_can_be_rendered_independently
  - test_format_im_memory_uses_owner_injection_budget
  - test_im_memory_caps_each_list_source_at_fifty_entries
  - test_group_daily_policy_and_markdown_roundtrip
  - test_group_memory_compaction_preserves_dates_and_has_large_budget
  - test_group_profile_accepts_public_types_and_rejects_member_identity
  - test_idle_scope_is_enqueued_once_and_settled
  - test_settled_scope_reopens_on_next_message
  - test_group_reflection_threshold_is_fifty
  - test_member_agent_activity_does_not_schedule_member_reflection
  - test_member_tool_message_does_not_reflect_immediately
  - test_idle_tombstoned_scope_is_not_marked_settled
  - test_reflection_snapshot_excludes_assistant_and_tool_messages
  - test_member_memory_merge_is_stable_and_deduplicated
  - test_reflection_prompts_are_separated_by_scope
  - test_deleted_scope_is_not_previewed
  - test_scope_deletion_uses_tombstone_and_cleans_storage
  - test_owner_group_reflection_excludes_assistant_reply_and_other_members

### backend/tests/test_im_permissions_types.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - test_non_numeric_platform_bot_id_fails_closed
  - test_non_numeric_bot_policy_defaults_to_disabled

### backend/tests/test_im_protocol.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：14；无外部依赖；无 skip
- 测试内容：
  - test_platform_message_normalizes_group_payload_without_losing_metadata
  - test_normalize_semantic_text_only_removes_confirmed_leading_bot_mention
  - test_payload_semantic_text_uses_canonical_bot_mention_flag
  - test_feishu_mention_normalization_only_accepts_current_bot
  - test_platform_message_preserves_bot_identity_for_session_messages
  - test_platform_message_uses_sender_as_private_chat_target
  - test_platform_message_normalizes_feishu_p2p_as_private_chat
  - test_platform_message_normalizes_wechat_group_id
  - test_extract_platform_user_id_supports_nested_platform_payloads
  - test_platform_reply_keeps_platform_neutral_parts
  - test_platform_reply_from_text_preserves_group_reply_route
  - test_record_only_group_policy_matches_all_qq_messages
  - test_reply_mentions_records_unmentioned_qq_messages_without_replying
  - test_passive_group_payload_can_bypass_active_agent_task

### backend/tests/test_im_replies.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：19；无外部依赖；无 skip
- 测试内容：
  - test_qq_expired_msg_id_is_treated_as_passive_reply_failure
  - test_qq_group_reply_uses_group_target
  - test_qq_private_reply_uses_sender_target
  - test_send_agent_response_sends_each_round_separately
  - test_send_agent_response_skips_rounds_already_sent_by_callback
  - test_send_agent_response_replays_only_unsent_round_indices
  - test_attachment_failure_is_not_hidden_by_sent_round_index
  - test_interaction_uses_qq_keyboard_and_keeps_text_fallback
  - test_qq_keyboard_failure_fallback_accepts_number
  - test_interaction_uses_plain_text_for_unadapted_platforms
  - test_tool_event_platform_fallbacks_keep_result_and_hide_input
  - test_unknown_reply_target_does_not_raise
  - test_platform_reply_declares_text_and_reply_capabilities
  - test_platform_reply_infers_keyboard_capability_from_parts
  - test_qq_group_file_result_is_returned_to_worker
  - test_qq_group_file_reads_local_storage_bytes
  - test_feishu_oversized_file_sends_limit_notice_without_gateway_call
  - test_unknown_platform_file_reply_does_not_open_storage
  - test_send_file_dispatches_by_platform

### backend/tests/test_im_shortcut_fallback.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：3；外部依赖；无 skip
- 测试内容：
  - test_shortcut_redis_failure_continues_to_worker
  - test_sync_shortcut_redis_failure_continues_to_worker
  - test_stop_uses_active_loop_when_state_ttl_expired

### backend/tests/test_interaction_events.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - test_stream_event_round_trip_preserves_payload
  - test_stream_event_supports_structured_tool_input

### backend/tests/test_interaction_phase5_7.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：5；无外部依赖；无 skip
- 测试内容：
  - test_qq_action_payload_only_contains_opaque_action_data
  - test_qq_action_data_round_trip_and_rejects_malformed_value
  - test_qq_interaction_parser_accepts_nested_event_without_logging_secrets
  - test_qq_interaction_parser_accepts_official_resolved_button_data
  - test_qq_interaction_parser_accepts_official_top_level_user_openid

### backend/tests/test_interaction_protocol.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：14；无外部依赖；无 skip
- 测试内容：
  - test_schema_dict_accepts_legacy_json_string_and_rejects_invalid_values
  - test_event_identity_survives_round_trip
  - test_action_tokens_are_stored_as_one_way_hashes
  - test_round_event_name_remains_stable
  - test_ask_user_tool_is_registered_with_bounded_schema
  - test_qq_ask_user_text_fallback_lists_options_without_exposing_tokens
  - test_ask_user_button_resolves_pending_tool_result
  - test_ask_user_tool_result_creates_waiting_prompt
  - test_round_limit_prompt_only_resumes_current_run_without_persisting_unlimited
  - test_tool_budget_prompt_enables_unlimited_without_goal_loop
  - test_confirmation_button_returns_token_for_resumed_destructive_tool
  - test_ask_user_text_requires_explicit_permission_and_resolves
  - test_wait_for_resolution_returns_same_interaction_result
  - test_wait_for_resolution_stops_and_closes_prompt_on_cancel

### backend/tests/test_message_format.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：6；无外部依赖；无 skip
- 测试内容：
  - test_default_message_format_keeps_groups_compatible_and_private_smart
  - test_compatibility_mode_always_uses_plain_text
  - test_markdown_mode_always_uses_markdown
  - test_smart_mode_only_uses_markdown_for_clear_signals
  - test_missing_mode_preserves_legacy_markdown_behavior
  - test_compatibility_prompt_forbids_markdown_without_changing_content_rules

### backend/tests/test_notifications.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - test_latest_bubble_excludes_notifications_marked_read
  - test_latest_bubble_skips_read_latest_and_returns_unread_older_bubble

### backend/tests/test_qface.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - test_qface_matches_emoji_id_and_prefers_apng_asset
  - test_qface_rejects_market_type_and_unsafe_asset_path
  - test_qface_prefers_exact_emoji_id_over_qzone_code_collision

### backend/tests/test_qq_binding_code.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：4；外部依赖；无 skip
- 测试内容：
  - test_qq_binding_code_is_hashed_and_consumed_once
  - test_qq_binding_code_rejects_wrong_sender_guesses
  - test_qq_binding_code_does_not_bind_another_users_bot
  - test_qq_binding_command_is_consumed_before_agent_enqueue

### backend/tests/test_qq_connect_scan_url.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：3；外部依赖；无 skip
- 测试内容：
  - test_qq_connect_scan_url_points_to_tencent_official_qqbot_path
  - test_qq_connect_platform_identifier_stays_qq
  - test_qq_connect_scan_url_contains_all_required_query_params

### backend/tests/test_qq_error_contract.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：12；无外部依赖；无 skip
- 测试内容：
  - test_transient_classifies_5xx_and_429_as_retryable
  - test_transient_classifies_401_as_retryable
  - test_transient_classifies_permanent_4xx_as_not_retryable
  - test_transient_classifies_network_errors_as_retryable
  - test_transient_classifies_generic_exception_as_not_retryable
  - test_msg_id_invalid_is_only_classified_for_qq_expiry_error
  - test_qq_api_error_str_does_not_leak_raw_body
  - test_send_c2c_does_not_retry_permanent_4xx
  - test_send_c2c_falls_back_to_active_message_when_msg_id_expired
  - test_send_c2c_retries_transient_5xx
  - test_send_group_does_not_retry_permanent_4xx
  - test_qq_request_raises_qq_api_error_without_raw_body_in_message

### backend/tests/test_qq_group_history.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - test_qq_group_session_keeps_only_latest_500_messages

### backend/tests/test_qq_raw_send.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：15；无外部依赖；无 skip
- 测试内容：
  - test_qq_identify_subscribes_to_interaction_events
  - test_ack_qq_interaction_uses_official_callback_endpoint
  - test_ack_qq_interaction_without_id_is_noop
  - test_post_sends_markdown
  - test_post_keyboard_builds_inline_keyboard_with_opaque_action
  - test_post_keyboard_uses_markdown_with_keyboard
  - test_post_compat_mode_sends_plain_text
  - test_post_removes_web_only_gugu_links_for_qq
  - test_post_smart_mode_only_uses_markdown_for_markdown_content
  - test_post_falls_back_to_plain_text_when_markdown_blocked
  - test_post_reraises_non_markdown_errors
  - test_send_c2c_clears_token_cache_and_retries_on_failure
  - test_send_token_uses_cache_until_expiry
  - test_send_file_base64_mode_uploads_then_sends_media
  - test_send_group_file_uses_group_media_endpoints

### backend/tests/test_qq_raw_ws.py

- 类型/层级：pytest / L2
- owner：backend/im
- 源码声明数：33；外部依赖；无 skip
- 测试内容：
  - test_qq_heartbeat_ack_timeout_after_two_and_a_half_intervals
  - test_qq_split_face_pending_is_fifo
  - test_qq_group_sender_prefers_user_openid_for_owner_binding
  - test_qq_message_mentions_bot_uses_at_event_and_payload_fallback
  - test_qq_face_marker_is_normalized_without_protocol_text
  - test_qq_face_probe_extracts_reusable_identity_without_decoding_payload
  - test_qq_face_probe_extracts_multiple_faces_in_protocol_order
  - test_qq_face_marker_is_normalized_without_leaking_protocol_text
  - test_qq_face_marker_uses_text_from_extension_when_available
  - test_qq_bot_mention_id_uses_explicit_bot_mention
  - test_qq_bot_mention_id_does_not_guess_unknown_mentions
  - test_qq_bot_mention_id_falls_back_only_for_at_event
  - test_qq_mention_display_uses_username_without_changing_identity_fields
  - test_platform_mention_display_keeps_unknown_ids
  - test_qq_group_reply_formats_current_member_mention
  - test_qq_group_at_event_without_mentions_reaches_agent
  - test_qq_extracts_quoted_text_by_ref_msg_idx
  - test_qq_extracts_direct_quoted_image_from_message_reference
  - test_qq_extracts_nested_quoted_media_url
  - test_qq_extracts_quoted_text_with_numeric_msg_idx
  - test_qq_extracts_quoted_text_with_dict_ext
  - test_qq_extracts_quoted_image_from_nested_element
  - test_qq_extract_quoted_returns_empty_without_ref_msg_idx
  - test_qq_ref_index_restores_quoted_attachments_after_reopen
  - test_qq_ref_index_isolated_by_chat_scope
  - test_qq_ref_index_uses_private_storage_permissions
  - test_qq_raw_c2c_event_to_payload
  - test_qq_message_still_reaches_stream_when_shortcut_redis_fails
  - test_qq_raw_group_event_to_payload
  - test_qq_raw_group_disabled_drops_event
  - test_qq_raw_group_message_create_respects_requires_at
  - test_qq_raw_group_message_create_is_received_when_at_is_required
  - test_qq_raw_quoted_attachment_is_ingested

### backend/tests/test_scheduled_group_imctx.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：11；无外部依赖；无 skip
- 测试内容：
  - test_detect_group_target_picks_group
  - test_detect_group_target_skips_private
  - test_detect_group_target_none
  - test_run_agent_group_target_sets_imctx
  - test_run_agent_private_target_no_imctx
  - test_run_agent_group_injects_group_memory
  - test_run_agent_group_message_id_none
  - test_run_agent_no_group_memory_when_no_target
  - test_run_agent_group_missing_bot_id_skips_memory
  - test_scheduled_group_context_search_recalls_group_history
  - test_scheduled_group_context_search_unavailable_without_channel_id

### backend/tests/test_similar_image_search.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：13；无外部依赖；无 skip
- 测试内容：
  - test_resolve_network_image_validates_and_returns_bytes
  - test_resolve_similar_image_rejects_unsupported_network_format
  - test_baidu_provider_sends_base64_and_normalizes_results
  - test_baidu_provider_rejects_non_ascii_api_key_before_request
  - test_baidu_provider_reads_official_result_wrapper
  - test_baidu_provider_classifies_auth_failure
  - test_image_search_is_the_only_registered_image_search_tool
  - test_image_search_dispatches_reverse_image_mode
  - test_image_search_infers_legacy_reverse_image_mode
  - test_image_search_rejects_mode_without_required_input
  - test_image_search_schema_uses_flat_compatible_input
  - test_image_search_accepts_numeric_string_result_count_after_normalization
  - test_similar_image_default_count_is_fifteen

### backend/tests/test_start_im_activity_order.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：2；外部依赖；无 skip
- 测试内容：
  - test_start_im_activity_delegates_to_atomic_init
  - test_stop_im_typing_is_idempotent_for_waiting_interaction

### backend/tests/test_wechat_quotes.py

- 类型/层级：pytest / L1
- owner：backend/im
- 源码声明数：8；外部依赖；无 skip
- 测试内容：
  - test_wechat_extracts_quoted_title_as_fallback_summary
  - test_wechat_extracts_quoted_message_as_unsupported_placeholder
  - test_wechat_extracts_quoted_image_item
  - test_wechat_media_url_prefers_full_url
  - test_wechat_media_url_falls_back_to_encrypt_query_param
  - test_wechat_media_url_empty_when_neither_present
  - test_wechat_ingest_media_uses_encrypt_query_param_download_url
  - test_wechat_quoted_image_is_ingested_and_enqueued

### frontend/src/interaction/runtime/canvas.test.ts

- 类型/层级：vitest / L0
- owner：frontend/im
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - 所有 landing 结束后才通知等待中的刷新

## schedule

- 文件数：10
- 源码声明数：73

### backend/tests/test_regressions_datetime_and_version.py

- 类型/层级：pytest / L1
- owner：backend/schedule
- 源码声明数：6；外部依赖；无 skip
- 测试内容：
  - test_once_expired_accepts_legacy_naive_and_aware_iso
  - test_list_tasks_does_not_delete_expired_but_failed_once_task
  - test_list_tasks_marks_crashed_once_task_as_failed_instead_of_deleting
  - test_list_tasks_keeps_in_flight_once_task_untouched
  - test_files_version_retries_deadlock_after_rollback
  - test_files_version_does_not_retry_non_deadlock

### backend/tests/test_scheduled_delivery_targets.py

- 类型/层级：pytest / L1
- owner：backend/schedule
- 源码声明数：23；外部依赖；无 skip
- 测试内容：
  - test_group_delivery_mode_captures_current_qq_group
  - test_group_delivery_mode_rejects_web_context
  - test_group_delivery_mode_requires_confirmation_when_omitted
  - test_delivery_uses_task_target_instead_of_recent_reach
  - test_delivery_with_all_attachments_sent_stays_success
  - test_delivery_with_failed_attachments_is_not_reported_success
  - test_web_only_delivery_with_files_reports_no_attachment_support
  - test_deliver_im_files_counts_missing_attach_id_and_metadata_as_failures
  - test_legacy_task_never_uses_recent_group_reach
  - test_legacy_task_uses_owner_private_target
  - test_execute_task_passes_structured_target_to_delivery
  - test_update_group_target_confirmation_does_not_mutate_task
  - test_trial_does_not_hold_request_db_session_during_agent
  - test_trial_timeout_does_not_cancel_delivery_task
  - test_trial_does_not_update_last_run_at
  - test_once_task_is_kept_when_execution_or_delivery_fails
  - test_once_task_is_deleted_only_after_successful_delivery
  - test_delivery_reports_gateway_false_as_failed
  - test_delivery_distinguishes_target_failure_from_missing_target
  - test_execute_task_rejects_concurrent_execution_of_same_task
  - test_persist_push_im_private_uses_owner_session_key
  - test_persist_push_im_group_uses_imsession_key
  - test_persist_push_im_private_missing_puid_returns_early

### backend/tests/test_scheduled_task_execution.py

- 类型/层级：pytest / L1
- owner：backend/schedule
- 源码声明数：21；外部依赖；无 skip
- 测试内容：
  - test_scheduled_messages_keep_snapshot_context_before_tail
  - test_scheduled_execution_always_uses_full_loop
  - test_scheduled_tools_run_schema_parse_without_reexecuting
  - test_scheduled_execution_failure_after_mutation_is_not_replayed
  - test_scheduled_schema_parse_failure_retries_execution
  - test_scheduled_schema_parse_failure_mutated_never_reruns
  - test_execute_task_marks_last_run_failed_on_exception
  - test_execute_task_allows_retry_after_previous_failure
  - test_execute_task_still_blocks_when_last_run_succeeded_state
  - test_once_task_in_flight_when_redis_lock_held
  - test_once_task_not_in_flight_after_lock_expires_and_grace_passes
  - test_once_task_in_flight_grace_window_after_lock_release
  - test_run_now_uses_formal_execution_to_retry_failed_once_task
  - test_run_now_uses_trial_for_normal_task
  - test_scheduled_schema_parse_failure_twice_falls_back_to_execution_text
  - test_execute_task_renews_lock_for_long_running_task
  - test_execute_task_stops_renewing_after_completion
  - test_auto_title_skipped_when_title_locked
  - test_auto_title_never_overwrites_manual_rename_concurrent
  - test_rename_session_api_sets_title_locked
  - test_rename_session_rejects_empty_and_overlong

### backend/tests/test_scheduler_shutdown.py

- 类型/层级：pytest / L1
- owner：backend/schedule
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - test_scheduler_shutdown_waits_for_running_jobs

### backend/tests/test_tz_dateattribution.py

- 类型/层级：pytest / L1
- owner：backend/schedule
- 源码声明数：8；无外部依赖；无 skip
- 测试内容：
  - test_resolve_tz
  - test_user_tz
  - test_day_key_crosses_midnight_by_tz
  - test_day_key_naive_treated_as_utc
  - test_is_today_tz_correctness
  - test_is_this_week_monday_start
  - test_today_str_runs
  - test_ctx_tz_contextvar

### backend/tests/test_worker_shutdown.py

- 类型/层级：pytest / L1
- owner：backend/schedule
- 源码声明数：1；外部依赖；无 skip
- 测试内容：
  - test_emergency_shutdown_cancels_tasks_before_disposing_db

### frontend/e2e/scheduled-task-run.spec.ts

- 类型/层级：playwright / L3
- owner：frontend/e2e
- 源码声明数：1；外部依赖；无 skip
- 测试内容：
  - 定时任务：创建后立即运行，展示确定的成功结果

### frontend/e2e/scheduled-task-ui.spec.ts

- 类型/层级：playwright / L3
- owner：frontend/e2e
- 源码声明数：2；外部依赖；无 skip
- 测试内容：
  - 定时任务页面：空状态、新建、编辑、启停、试运行和删除
  - 定时任务页面：自定义日期、间隔和渠道选项可切换

### frontend/src/views/Schedules/utils/scheduleCron.test.ts

- 类型/层级：vitest / L0
- owner：frontend/schedule
- 源码声明数：7；无外部依赖；无 skip
- 测试内容：
  - 生成并解析间隔任务
  - 生成每日、工作日和周末任务
  - 保留单次任务日期和补零时间
  - 单次任务没有日期时选择今天或明天
  - 限制间隔分钟并对非法 Cron 使用默认规则
  - 覆盖最小和最大间隔，并保持同一输入结果稳定
  - 对空值、不完整格式和未知日期规则使用稳定默认值

### frontend/test/scheduledTasks.test.ts

- 类型/层级：vitest / L0
- owner：frontend/schedule
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - 加载任务并通过实时刷新回调再次加载
  - 保存时区分创建和更新，并在完成后刷新列表
  - 支持启停、试运行和删除，并把失败转为提示

## frontend-ui

- 文件数：27
- 源码声明数：164

### frontend/e2e/calendar.spec.ts

- 类型/层级：playwright / L3
- owner：frontend/e2e
- 源码声明数：3；外部依赖；无 skip
- 测试内容：
  - 日历月视图与周视图可以切换
  - 框选日期后可以从侧栏创建带日期范围的项目
  - 浮动活动编辑窗内选择日期不会被 Teleport 弹层误关

### frontend/e2e/chat.spec.ts

- 类型/层级：playwright / L3
- owner：frontend/e2e
- 源码声明数：7；外部依赖；无 skip
- 测试内容：
  - 发消息收到回复，刷新页面后会话内容还在
  - 展开大窗后会话列表显示当前会话，新建会话清空消息区
  - 关闭按钮收起聊天窗，悬浮球恢复可点
  - 生成中发的消息进了排队，切到新会话后不会被发进新会话
  - 全新会话第一轮排队，session_id 到达后两条都进同一个会话
  - 点击侧栏会话标题区域能切换会话

### frontend/e2e/smoke.spec.ts

- 类型/层级：playwright / L3
- owner：frontend/e2e
- 源码声明数：1；外部依赖；无 skip
- 测试内容：
  - 登录态可以访问应用

### frontend/scripts/check-css-glass-regression.mjs

- 类型/层级：static-check / L0
- owner：工程质量
- 源码声明数：0；无外部依赖；无 skip
- 测试内容：
  - 脚本入口或静态检查，无标准测试函数

### frontend/scripts/check-i18n-static.mjs

- 类型/层级：static-check / L0
- owner：工程质量
- 源码声明数：4；无外部依赖；无 skip
- 测试内容：
  - 脚本入口或静态检查，无标准测试函数

### frontend/scripts/check-ui-dialog-regression.mjs

- 类型/层级：static-check / L0
- owner：工程质量
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - 脚本入口或静态检查，无标准测试函数

### frontend/src/assets/styles/theme-regression.test.ts

- 类型/层级：vitest / L0
- owner：frontend/frontend-ui
- 源码声明数：26；无外部依赖；无 skip
- 测试内容：
  - 字体资源层与字体族 token 保持单一契约
  - 每套配色提供完整的明暗语义色，family 不再重复持有配色变量
  - 面板颜色与视觉材质分层，palette 改色不吞掉 family 效果
  - 通知气泡使用统一浮层材质，暗色不继承亮色纯白高光
  - 项目卡不再拥有重复的伪元素内描边
  - 项目卡最终 paint 只由组件负责，主题层不重复接管根卡片
  - todo popup 由通用容器负责 surface，业务组件负责内容主题
  - 亮色调色板将导航选中面统一为实体亮面
  - 导航选中项直接复用调色板 surface，通知 active paint 不重复
  - Mono 导航不再被旧 chrome 边框覆盖，Admin 与前台复用同一组选中 token
  - 组件主题颜色只通过语义 token 注入，Admin 面板不保留重复 scoped 样式块
  - 暗色咕咕悬浮球以深色表面为主，避免亮色强调色过曝
  - 暗色 surface hover 只由主题 refinement 负责
  - DateSpan 区间内部不叠加普通 hover 背景
  - ImageViewer 暗色只重映射 toolbar 局部 token，不复制实体 paint
  - 文件工具栏只有一套尺寸和前景契约
  - 文件多选工具栏只由共享组件负责 paint，并锚定项目卡非滚动容器
  - 文件卡亮色保持 0.20.4 多选层级，暗色只重映射 token 且没有 adoption paint 竞争
  - Mono 内容卡关闭 blur、画布浮动 chrome 通过同一 glass-card token 恢复 blur
  - Mono 音乐播放器和暗色播放按钮复用主题 token，不回退到旧亮色渐变
  - 登录、注册、隐私页面只通过主题层接管 paint，亮色 scoped 样式不被覆盖
  - 页面 Mono 配色与便签 Amber 色卡保持独立
  - 真实项目页样板按主题族选择材质层
  - 日历工具栏和终端顶部不重复绘制玻璃边界
  - 咕咕聊天窗口不重复绘制外壳和输入区高光
  - 咕咕聊天窗口离场时保留玻璃材质，避免 blur 先于淡出消失

### frontend/src/assets/styles/ui-structure-regression.test.ts

- 类型/层级：vitest / L0
- owner：frontend/frontend-ui
- 源码声明数：18；外部依赖；无 skip
- 测试内容：
  - 画布列表使用与项目抽屉一致的 Runtime 布局契约
  - Shell 未授权时不允许直接进入终端页，也不让 PTY 403 自动重连
  - Shell 未启用时不显示文件库工作区按钮
  - 项目阶段待办循环不遮蔽 i18n 翻译函数
  - Admin field-input 使用完整实线边框，避免回落到浏览器原生双层描边
  - 日历活动输入框聚焦时保留 hover 光晕，确保 focus 光晕有淡入动画
  - 主题组件覆盖和跨 DOM bridge 保持明确的统一入口
  - 非 Runtime 主题层不接管 Runtime 的 motion 属性
  - 轻量弹层统一经过 PopupMenu，业务组件不再持有独立 Teleport 动画
  - 引用补全不脱离输入行布局，避免展开态菜单使用过期 fixed 坐标
  - 聊天引用允许跨引用边界拖拽选中文本
  - 弹层关闭入口共用单一离场生命周期，防止重复动画与内容塌缩
  - 文件库与项目编辑卡目录导航都直接切状态，不创建跨目录 Presence/FLIP 离场
  - 浮动预览拖动四边共用 125% 虚拟视口边界
  - settings-popup 保持原组件视觉，Mono/暗色只映射 token 且 danger hover 只有一层
  - GuguChat IM 与普通 session 共用 2px 节奏且没有树形左缩进
  - 项目已完成年组引导线与箭头中心严格对齐，并给月组保留安全间距
  - 内容 disclosure 统一为收起向右、展开向下

### frontend/src/components/common/CardAffordances.test.ts

- 类型/层级：vitest / L0
- owner：frontend/frontend-ui
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - 无 hover 时隐藏附加按钮，hover 后显示并保留连接点状态
  - dragging、landing、revealing 状态隐藏附加交互，防止 landing 期间残留按钮或连接点命中

### frontend/src/components/common/gugu-chat/markdown.test.ts

- 类型/层级：vitest / L0
- owner：frontend/frontend-ui
- 源码声明数：4；无外部依赖；无 skip
- 测试内容：
  - 还原模型转义的表格竖线并渲染为 GFM table
  - 流式渲染也使用相同的表格预处理
  - 标题与表头粘连时仍能识别表格
  - 普通文本中的转义竖线不被全局改写

### frontend/src/components/common/iconRegistry.test.ts

- 类型/层级：vitest / L0
- owner：frontend/frontend-ui
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - 保留首批跨页面通用语义映射
  - 未注册语义直接报错，避免静默显示错误图标

### frontend/src/composables/useTheme.test.ts

- 类型/层级：vitest / L0
- owner：frontend/frontend-ui
- 源码声明数：7；无外部依赖；无 skip
- 测试内容：
  - 切换主题会持久化偏好并更新根节点主题
  - system 偏好根据媒体查询解析，并注册变化监听
  - 主题状态在初始化时读取，避免入口版本门之后仍使用旧缓存
  - 切换主题家族会持久化并更新根节点属性
  - 旧 v2 偏好迁移为 Mono
  - 切换配色会持久化并更新根节点属性
  - 非法配色回退为 Mist

### frontend/src/i18n/index.test.ts

- 类型/层级：vitest / L0
- owner：frontend/frontend-ui
- 源码声明数：6；无外部依赖；无 skip
- 测试内容：
  - 语言选择器使用稳定的原生名称
  - 设置页的跟随系统选项不带状态提示括号
  - 所有语言包文案都能被 vue-i18n 正常解析
  - maps supported browser language families
  - uses the first supported language and falls back to Chinese
  - switches the runtime immediately and persists only when requested

### frontend/src/i18n/integrity.test.ts

- 类型/层级：vitest / L0
- owner：frontend/frontend-ui
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - keeps every locale on the same key set

### frontend/src/utils/formatters.test.ts

- 类型/层级：vitest / L0
- owner：frontend/frontend-ui
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - uses the active locale for display
  - formats shared numeric values and file sizes
  - formats relative time without component-level unit concatenation

### frontend/src/views/Calendar/composables/useCalendarUpcoming.test.ts

- 类型/层级：vitest / L0
- owner：frontend/frontend-ui
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - 按截止窗口、完成状态和优先级生成近期节点
  - 合并事件时按 id 去重并保持输入不变

### frontend/src/views/Calendar/domain/calendarDomain.test.ts

- 类型/层级：vitest / L0
- owner：frontend/frontend-ui
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - 分别归一化活动和项目时间线，并保留渲染适配所需字段
  - 规则只从领域类型和配置派生，不依赖派生布尔字段

### frontend/src/views/Calendar/utils/calendarColors.test.ts

- 类型/层级：vitest / L0
- owner：frontend/frontend-ui
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - 提取合法六位颜色并为非法值提供稳定默认色
  - 生成颜色透明度、进度背景和加深色

### frontend/src/views/Calendar/utils/calendarLayout.test.ts

- 类型/层级：vitest / L0
- owner：frontend/frontend-ui
- 源码声明数：4；无外部依赖；无 skip
- 测试内容：
  - 计算跨天项目分行并保持输入不变
  - 按最大行数截断项目条
  - 布局单日 chip 和隐藏项目时返回更多项
  - 按重叠聚簇计算周视图时间活动列

### frontend/src/views/Design/data/tokenCatalog.test.ts

- 类型/层级：vitest / L0
- owner：frontend/frontend-ui
- 源码声明数：2；无外部依赖；无 skip
- 测试内容：
  - 间距、字号、圆角各自只保留四个主档位
  - 目录只保存展示元数据，不复制令牌实际值

### frontend/test/cardOptimisticRegrab.test.ts

- 类型/层级：vitest / L0
- owner：frontend/frontend-ui
- 源码声明数：3；无外部依赖；无 skip
- 测试内容：
  - 项目写入用 queue-time revision 保护最新 move，旧响应只允许推进 version
  - 画布临时卡以 clientKey 保持 Runtime 身份，regrab 不把负 id 发给持久化 API
  - 抽屉临时卡落库后循环追平 placeholder 最新坐标，不假设只发生一次 regrab

### frontend/test/dateAttribution.test.ts

- 类型/层级：vitest / L0
- owner：frontend/frontend-ui
- 源码声明数：16；无外部依赖；无 skip
- 测试内容：
  - 无时区标记 → 当 UTC 解析
  - 带 Z → 原样
  - 带偏移 → 原样（换算成 UTC）
  - 纯日期 → UTC 零点
  - 空 → NaN
  - UTC 20:00 在东八区是次日
  - UTC 02:00 在纽约是前一日
  - UTC 下即 UTC 日
  - 东八区跨午夜 → 不同一天（naive UTC 会误判为同一天）
  - 同样两个时刻在 UTC 口径下算同一天
  - 同周内为 true（含周一与周六）
  - 上周日 / 下周一为 false
  - 格式 YYYY-MM-DD HH:MM
  - seconds 选项带 :SS
  - naive ISO 也当 UTC（与带 Z 同一时刻）
  - 空 / 无效 → 空串

### frontend/test/dateScrubberMath.test.ts

- 类型/层级：vitest / L0
- owner：frontend/frontend-ui
- 源码声明数：7；无外部依赖；无 skip
- 测试内容：
  - 限制逻辑位置并在两端施加有界橡皮筋
  - 无边界橡皮筋持续移动，但越往外增量越小
  - 中心间距大于两侧，且位置随连续焦点连续变化
  - 日期凹槽不越过相邻整数边界
  - 窗口边缘淡出与刻度视觉值都是连续的
  - 边缘橡皮筋只缩短刻度，不把当前日期和标签改成半透明
  - 标签保持选中态实色，跨中点才交给下一日期

### frontend/test/flipCoordinator.test.ts

- 类型/层级：vitest / L0
- owner：frontend/frontend-ui
- 源码声明数：14；无外部依赖；无 skip
- 测试内容：
  - 按稳定 key 对齐前后位置，不依赖数组顺序
  - cancel 只恢复本事务仍拥有的 inline 样式
  - 旧事务不会覆盖新事务接管的 transform
  - 正常完成后恢复事务开始前的 inline 样式
  - session 门禁失效时不会写入 inverse transform
  - 跳过 Vue 临时挂载产生的 0×0 元素
  - 协调器接管时移除 Vue move，并在取消后清理 ownership
  - 恢复事务接管前的外部 ownership 标记
  - 阶段顺序不完整时不会写入动画样式
  - transitionend 只接受本元素的 transform 事件并完成事务
  - 播放期间元素卸载时由 fallback 结束事务且不残留样式
  - 重定目标注册表只保留当前回调并按稳定元素分发
  - 重定目标连续更新时只调用同一元素的最新回调
  - 不同对象类型使用同值 id 时不会互相覆盖

### frontend/test/markdown.test.ts

- 类型/层级：vitest / L0
- owner：frontend/frontend-ui
- 源码声明数：18；无外部依赖；无 skip
- 测试内容：
  - 剥离 <img onerror>
  - 剥离 <script>
  - 剥离 <svg onload>
  - 剥离 javascript: 链接协议
  - 保留 hljs 代码高亮 span.class
  - 保留代码块复制按钮 + 内联 SVG
  - 保留链接新标签打开（target=_blank）
  - 空输入返回空串
  - 正文里的原始 HTML 载荷被中和
  - link renderer：javascript: 协议丢弃
  - link renderer：https 链接保留且新标签打开
  - link renderer：title 属性逃逸被挡（不产生真实 img / onerror 元素）
  - 正常 markdown 正常渲染
  - 保住 gugu:// 动作链接的 href
  - 通用 sanitizeHtml 仍剥掉 gugu://（least-privilege，只有聊天放行）
  - 聊天路径仍是 XSS 安全：script / on* / javascript: 照样剥
  - 复制按钮的内联 onclick 被剥（故走事件委托，不靠 onclick）
  - 通用 renderMarkdown（MarkdownView text 分支）连渲染时都剥 gugu://——故聊天必须由 GuguChat 自出 html

### frontend/test/optimisticMutation.test.ts

- 类型/层级：vitest / L0
- owner：frontend/frontend-ui
- 源码声明数：7；无外部依赖；无 skip
- 测试内容：
  - 成功：apply → afterMutate → work → onCommit，不回滚
  - 失败：apply → afterMutate → work(抛) → rollback → afterMutate → onError
  - onCommit 可选：不传也不报错
  - 成功时 rollback 绝不被调用；失败时 onCommit 绝不被调用
  - regrab 立即 apply 新状态，但同一对象的 persistence 必须等待旧请求结算后再启动
  - regrab 新意图已 apply 时，旧请求失败先完成 defer/onError 收尾，再放行新 persistence
  - 连续 regrab 的所有请求都失败时，rollback chain 回到最后确认状态而非中间乐观态

### scripts/licenses/check-licenses.mjs

- 类型/层级：static-check / L0
- owner：工程质量
- 源码声明数：1；无外部依赖；无 skip
- 测试内容：
  - 脚本入口或静态检查，无标准测试函数

