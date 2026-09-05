# 测试 Fixture 与构造器审查

> 由 `scripts/tests/audit-test-helpers.mjs` 扫描 `backend/tests` 生成。该报告只登记重复候选，不自动改写测试。

## 处置规则

- 只有在模拟对象的方法集合、状态语义和调用边界都一致时，才允许抽到 `conftest.py` 或共享 helper。
- 领域专用 fake 即使同名，也保留在原测试文件，避免公共 fake 通过额外方法掩盖生产契约。
- fixture 抽取必须先运行受影响领域专项、`test:fast` 和后端全量测试。

## 重复候选

### _FakeRedis

出现文件：8

- `backend/tests/test_attachment_gc.py`：__init__, lock
- `backend/tests/test_genstream_cancel.py`：__init__, set, get, delete
- `backend/tests/test_greeting_cache.py`：__init__, get, lock, set
- `backend/tests/test_im_owner_session.py`：__init__, get, set, delete
- `backend/tests/test_runtime_state_scope.py`：__init__, get, set, delete, sadd, srem, smembers, expire, eval
- `backend/tests/test_session_execution_gate.py`：__init__, lock
- `backend/tests/test_storage_snapshots.py`：__init__, lock
- `backend/tests/test_video_cache.py`：__init__, get, set, expire, lock

处置：方法集合覆盖缓存、锁、集合、过期或脚本执行等不同边界；同名不代表同一 Redis 契约，保留原地。

### _FakeLock

出现文件：5

- `backend/tests/test_attachment_gc.py`：__init__, acquire, release
- `backend/tests/test_greeting_cache.py`：acquire, release
- `backend/tests/test_session_execution_gate.py`：__init__, acquire, release
- `backend/tests/test_storage_snapshots.py`：__init__, acquire, release
- `backend/tests/test_video_cache.py`：__init__, acquire, release

处置：四处语义不同：附件清理/快照是可配置的非阻塞锁，session gate 记录 acquired 状态，视频缓存包装真实 asyncio.Lock；保留原地。

### FakeRedis

出现文件：3

- `backend/tests/test_migrate_qqbot_runtime_keys.py`：__init__, scan_iter, exists, get, set, delete, ttl, renamenx
- `backend/tests/test_qq_binding_code.py`：__init__, set, get, incr, expire, delete
- `backend/tests/test_qq_connect_scan_url.py`：__init__, set, get, publish

处置：分别模拟迁移扫描、一次性绑定码和 QQ 连接发布，状态模型及生产入口不同，保留原地。

### _FakeClient

出现文件：3

- `backend/tests/test_searxng_search_status.py`：__init__, __aenter__, __aexit__, get
- `backend/tests/test_send_file_url_streaming.py`：__init__, __aenter__, __aexit__, build_request, send
- `backend/tests/test_stream_round_retry.py`：__init__

处置：分别模拟搜索 HTTP、文件流式请求和 provider stream 客户端，响应协议与错误边界不同，保留原地。

### _FakeResponse

出现文件：2

- `backend/tests/test_im_media_ingress.py`：iter_chunked, __aenter__, __aexit__
- `backend/tests/test_searxng_search_status.py`：__init__, json

处置：分别服务媒体分块读取和搜索 JSON 响应，接口形状不同，保留原地。

### FakeAdapter

出现文件：1

- `backend/tests/test_context_cache_boundaries.py`：supports_active_cache, supports_explicit_cache, uses_single_history_cache_anchor, render_history

处置：单文件专用，保留原地。

### _FakeSession

出现文件：1

- `backend/tests/test_im_media_ingress.py`：__init__, __aenter__, __aexit__, get

处置：单文件专用，保留原地。

### _FakeOpenAIStream

出现文件：1

- `backend/tests/test_loop_driver_usage_semantics.py`：__init__, __aiter__, __anext__

处置：单文件专用，保留原地。

### _FakeOpenAIClient

出现文件：1

- `backend/tests/test_loop_driver_usage_semantics.py`：__init__, _create

处置：单文件专用，保留原地。

### _FakeResponsesStream

出现文件：1

- `backend/tests/test_phase2_reasoning_drivers.py`：__init__, __aiter__, __anext__, close

处置：单文件专用，保留原地。

### _FakeResponsesClient

出现文件：1

- `backend/tests/test_phase2_reasoning_drivers.py`：__init__, create

处置：单文件专用，保留原地。

### FakeResponse

出现文件：1

- `backend/tests/test_qq_connect_scan_url.py`：__init__, raise_for_status, json

处置：单文件专用，保留原地。

### FakeAsyncClient

出现文件：1

- `backend/tests/test_qq_connect_scan_url.py`：__init__, __aenter__, __aexit__, post

处置：单文件专用，保留原地。

### FakeRetriever

出现文件：1

- `backend/tests/test_rag_retriever.py`：retrieve

处置：单文件专用，保留原地。

### _FakeStorage

出现文件：1

- `backend/tests/test_scoped_store.py`：__init__, get

处置：单文件专用，保留原地。

### _FakeResp

出现文件：1

- `backend/tests/test_send_file_url_streaming.py`：__init__, aiter_bytes, aclose

处置：单文件专用，保留原地。

### _FakeFinalMessage

出现文件：1

- `backend/tests/test_stream_round_retry.py`：__init__

处置：单文件专用，保留原地。

### _FakeStreamCtx

出现文件：1

- `backend/tests/test_stream_round_retry.py`：__init__, __aenter__, __aexit__, text_stream, _iter, get_final_message

处置：单文件专用，保留原地。

### _FakeMessages

出现文件：1

- `backend/tests/test_stream_round_retry.py`：__init__, stream

处置：单文件专用，保留原地。

### _FakeStream

出现文件：1

- `backend/tests/test_streaming_regressions.py`：__init__, push, finish, has_sent

处置：单文件专用，保留原地。

### FakePty

出现文件：1

- `backend/tests/test_terminal_pty_manager.py`：__init__, write, resize, signal, close, output

处置：单文件专用，保留原地。

### FakeBridge

出现文件：1

- `backend/tests/test_terminal_pty_manager.py`：__init__, open

处置：单文件专用，保留原地。

### _FakeGcLock

出现文件：1

- `backend/tests/test_video_cache.py`：__init__, acquire, release

处置：单文件专用，保留原地。

### _FakeGcRedis

出现文件：1

- `backend/tests/test_video_cache.py`：__init__, lock

处置：单文件专用，保留原地。

## 当前结论

- `_FakeRedis` 等同名模拟对象的方法集合不同，不能合并为万能 fixture。
- 后续优先抽取无行为的构造器参数和断言辅助函数；本轮不移动、不删除业务测试。

## 重复函数名（不等于重复实现）

> 仅列出跨文件出现的 helper 名称；同一文件内针对不同场景的局部 fake 不列入候选。

### fake_probe

- `backend/tests/test_chat_attach_video.py`：`fake_probe(raw):`
- `backend/tests/test_chat_attach_video.py`：`fake_probe(raw):`
- `backend/tests/test_chat_attach_video.py`：`fake_probe(raw):`
- `backend/tests/test_chat_attach_video.py`：`fake_probe(raw):`
- `backend/tests/test_chat_attach_video.py`：`fake_probe(raw):`
- `backend/tests/test_chat_attach_video.py`：`fake_probe(raw):`
- `backend/tests/test_chat_attach_video.py`：`fake_probe(raw):`
- `backend/tests/test_chat_attach_video.py`：`fake_probe(raw):`
- `backend/tests/test_chat_attach_video.py`：`fake_probe(raw):`
- `backend/tests/test_chat_attach_video.py`：`fake_probe(raw):`
- `backend/tests/test_chat_attach_video.py`：`fake_probe(raw):`
- `backend/tests/test_chat_attach_video.py`：`fake_probe(raw):`
- `backend/tests/test_chat_attach_video.py`：`fake_probe(raw):`
- `backend/tests/test_chat_attach_video.py`：`fake_probe(raw):`
- `backend/tests/test_chat_attach_video.py`：`fake_probe(raw):`
- `backend/tests/test_chat_attach_video.py`：`fake_probe(raw):`
- `backend/tests/test_chat_attach_video.py`：`fake_probe(raw):`
- `backend/tests/test_chat_attach_video.py`：`fake_probe(raw):`
- `backend/tests/test_chat_attach_video.py`：`fake_probe(raw):`
- `backend/tests/test_chat_attach_video.py`：`fake_probe(raw):`
- `backend/tests/test_llm7_p3.py`：`fake_probe(provider, api_key, base_url, model, api_format, *, dim):`
- `backend/tests/test_llm7_p3.py`：`fake_probe(provider, api_key, base_url, model, api_format, *, dim):`
- `backend/tests/test_video_cache.py`：`fake_probe(_raw):`
处置：仅名称重复，暂不抽取；需在后续对拍函数体和断言语义。

### fake_compress

- `backend/tests/test_chat_attach_video.py`：`fake_compress(raw, probe=None):`
- `backend/tests/test_chat_attach_video.py`：`fake_compress(raw, probe=None):`
- `backend/tests/test_chat_attach_video.py`：`fake_compress(raw, probe=None):`
- `backend/tests/test_chat_attach_video.py`：`fake_compress(raw, probe=None):`
- `backend/tests/test_compaction.py`：`fake_compress(session_id, user_id, settings, *, force=False):`
- `backend/tests/test_video_cache.py`：`fake_compress(raw, probe=None):`
- `backend/tests/test_video_cache.py`：`fake_compress(_raw, probe=None):`
- `backend/tests/test_video_cache.py`：`fake_compress(raw, probe=None):`
- `backend/tests/test_video_cache.py`：`fake_compress(raw, probe=None):`
- `backend/tests/test_video_cache.py`：`fake_compress(raw, probe=None):`
- `backend/tests/test_video_cache.py`：`fake_compress(raw, probe=None):`
- `backend/tests/test_video_cache.py`：`fake_compress(raw, probe=None):`
- `backend/tests/test_video_cache.py`：`fake_compress(raw, probe=None):`
- `backend/tests/test_video_cache.py`：`fake_compress(raw, probe=None):`
处置：仅名称重复，暂不抽取；需在后续对拍函数体和断言语义。

### fake_request

- `backend/tests/test_qq_raw_send.py`：`fake_request(channel_id, method, path, json_body=None, **kw):`
- `backend/tests/test_qq_raw_send.py`：`fake_request(channel_id, method, path, json_body=None, **kw):`
- `backend/tests/test_qq_raw_send.py`：`fake_request(channel_id, method, path, json_body=None, **kw):`
- `backend/tests/test_qq_raw_send.py`：`fake_request(channel_id, method, path, json_body=None, **kw):`
- `backend/tests/test_qq_raw_send.py`：`fake_request(channel_id, method, path, json_body=None, **kw):`
- `backend/tests/test_qq_raw_send.py`：`fake_request(channel_id, method, path, json_body=None, **kw):`
- `backend/tests/test_qq_raw_send.py`：`fake_request(channel_id, method, path, json_body=None, **kw):`
- `backend/tests/test_qq_raw_send.py`：`fake_request(channel_id, method, path, json_body=None, **kw):`
- `backend/tests/test_qq_raw_send.py`：`fake_request(channel_id, method, path, json_body=None, **kw):`
- `backend/tests/test_qq_raw_send.py`：`fake_request(channel_id, method, path, json_body=None, **kw):`
- `backend/tests/test_qq_raw_send.py`：`fake_request(channel_id, method, path, json_body=None, **kw):`
- `backend/tests/test_rag_ts_sidecar.py`：`fake_request(payload):`
处置：仅名称重复，暂不抽取；需在后续对拍函数体和断言语义。

### fake_search

- `backend/tests/test_capability_selector.py`：`fake_search(owner_id, documents, query, **kwargs):`
- `backend/tests/test_knowledge.py`：`fake_search(*args, **kwargs):`
- `backend/tests/test_knowledge.py`：`fake_search(*args, **kwargs):`
- `backend/tests/test_knowledge.py`：`fake_search(*args, **kwargs):`
- `backend/tests/test_knowledge.py`：`fake_search(*args, **kwargs):`
- `backend/tests/test_memory_compaction_retrieval.py`：`fake_search(*args, **kwargs):`
- `backend/tests/test_rag_injection.py`：`fake_search(*args, **kwargs):`
- `backend/tests/test_rag_injection.py`：`fake_search(user_id, query, **kwargs):`
- `backend/tests/test_rag_injection.py`：`fake_search(*args, **kwargs):`
- `backend/tests/test_rag_retriever.py`：`fake_search(_owner, candidates, _query, **_kwargs):`
- `backend/tests/test_search_tools.py`：`fake_search(*args, **kwargs):`
处置：仅名称重复，暂不抽取；需在后续对拍函数体和断言语义。

### fake_produce

- `backend/tests/test_qq_binding_code.py`：`fake_produce(*args):`
- `backend/tests/test_qq_raw_ws.py`：`fake_produce(_stream, payload):`
- `backend/tests/test_qq_raw_ws.py`：`fake_produce(stream, payload):`
- `backend/tests/test_qq_raw_ws.py`：`fake_produce(_stream, payload):`
- `backend/tests/test_qq_raw_ws.py`：`fake_produce(stream, payload):`
- `backend/tests/test_qq_raw_ws.py`：`fake_produce(stream, payload):`
- `backend/tests/test_qq_raw_ws.py`：`fake_produce(stream, payload):`
- `backend/tests/test_qq_raw_ws.py`：`fake_produce(stream, payload):`
- `backend/tests/test_qq_raw_ws.py`：`fake_produce(stream, payload):`
- `backend/tests/test_wechat_quotes.py`：`fake_produce(stream, payload):`
处置：仅名称重复，暂不抽取；需在后续对拍函数体和断言语义。

### fake_complete_json

- `backend/tests/test_context_branch.py`：`fake_complete_json(system, user, settings, **kwargs):`
- `backend/tests/test_context_branch.py`：`fake_complete_json(*args, **kwargs):`
- `backend/tests/test_context_branch.py`：`fake_complete_json(*args, **kwargs):`
- `backend/tests/test_memory_event_scopes.py`：`fake_complete_json(*_args, **_kwargs):`
- `backend/tests/test_memory_event_scopes.py`：`fake_complete_json(*_args, **_kwargs):`
- `backend/tests/test_memory_maintenance_batches.py`：`fake_complete_json(*_args, **_kwargs):`
- `backend/tests/test_memory_migration.py`：`fake_complete_json(sys_prompt, user, settings, max_tokens=800, **kwargs):`
- `backend/tests/test_memory_migration.py`：`fake_complete_json(*a, **kw):`
- `backend/tests/test_memory_migration.py`：`fake_complete_json(sys_prompt, user, settings, max_tokens=1500, **kwargs):`
处置：仅名称重复，暂不抽取；需在后续对拍函数体和断言语义。

### fake_summary

- `backend/tests/test_compaction.py`：`fake_summary(_items, _previous=None, **_kwargs):`
- `backend/tests/test_compaction.py`：`fake_summary(items, previous=None, **_kwargs):`
- `backend/tests/test_compaction.py`：`fake_summary(items, previous=None, **_kwargs):`
- `backend/tests/test_compaction.py`：`fake_summary(items, previous=None, **_kwargs):`
- `backend/tests/test_message_compaction_boundary.py`：`fake_summary(content_list, prev_summary=None, **_kwargs):`
- `backend/tests/test_message_compaction_boundary.py`：`fake_summary(_items, _previous=None, **_kwargs):`
处置：仅名称重复，暂不抽取；需在后续对拍函数体和断言语义。

### fake_complete

- `backend/tests/test_knowledge.py`：`fake_complete(*args, **kwargs):`
- `backend/tests/test_knowledge.py`：`fake_complete(*args, **kwargs):`
- `backend/tests/test_knowledge.py`：`fake_complete(*args, **kwargs):`
- `backend/tests/test_memory_compaction_retrieval.py`：`fake_complete(_sys, user, _settings, **_kwargs):`
- `backend/tests/test_memory_compaction_retrieval.py`：`fake_complete(*_args, **_kwargs):`
- `backend/tests/test_memory_compaction_retrieval.py`：`fake_complete(*_args, **_kwargs):`
处置：仅名称重复，暂不抽取；需在后续对拍函数体和断言语义。

### fake_complete_text

- `backend/tests/test_compaction.py`：`fake_complete_text(sys, user, settings, max_tokens):`
- `backend/tests/test_compaction.py`：`fake_complete_text(_sys, _user, _settings, max_tokens):`
- `backend/tests/test_context_branch.py`：`fake_complete_text(*args, **kwargs):`
- `backend/tests/test_context_branch.py`：`fake_complete_text(*args, **kwargs):`
- `backend/tests/test_context_branch.py`：`fake_complete_text(system, user, settings, max_tokens):`
处置：仅名称重复，暂不抽取；需在后续对拍函数体和断言语义。

### fake_stream_round

- `backend/tests/test_core_loop_characterization.py`：`fake_stream_round(client, kwargs, adapter=None):`
- `backend/tests/test_loop_driver_usage_semantics.py`：`fake_stream_round(_client, _kwargs, _adapter):`
- `backend/tests/test_loopscope_usage.py`：`fake_stream_round(client, kwargs, adapter=None):`
- `backend/tests/test_loopscope_usage.py`：`fake_stream_round(client, kwargs, adapter=None):`
- `backend/tests/test_loopscope_usage.py`：`fake_stream_round(client, kwargs, adapter=None):`
处置：仅名称重复，暂不抽取；需在后续对拍函数体和断言语义。

### fake_download

- `backend/tests/test_feishu_media.py`：`fake_download(client, message_id, owner, key, rtype, fname, is_voice):`
- `backend/tests/test_feishu_media.py`：`fake_download(client, message_id, owner, key, rtype, fname, is_voice):`
- `backend/tests/test_feishu_media.py`：`fake_download(client, message_id, owner, key, rtype, fname, is_voice):`
- `backend/tests/test_similar_image_search.py`：`fake_download(*args, **kwargs):`
- `backend/tests/test_similar_image_search.py`：`fake_download(*args, **kwargs):`
处置：仅名称重复，暂不抽取；需在后续对拍函数体和断言语义。

### fake_stage

- `backend/tests/test_im_media_ingress.py`：`fake_stage(owner, name, ext, mime, data, **kwargs):`
- `backend/tests/test_im_media_ingress.py`：`fake_stage(owner, name, ext, mime, data, **kwargs):`
- `backend/tests/test_im_media_ingress.py`：`fake_stage(owner, name, ext, mime, data, **kwargs):`
- `backend/tests/test_im_media_ingress.py`：`fake_stage(*args, **kwargs):`
- `backend/tests/test_wechat_quotes.py`：`fake_stage(owner, name, ext, mime, data, **kwargs):`
处置：仅名称重复，暂不抽取；需在后续对拍函数体和断言语义。

### fake_post

- `backend/tests/test_qq_error_contract.py`：`fake_post(channel_id, openid, text, msg_id):`
- `backend/tests/test_qq_error_contract.py`：`fake_post(channel_id, openid, text, msg_id):`
- `backend/tests/test_qq_error_contract.py`：`fake_post(channel_id, openid, text, msg_id):`
- `backend/tests/test_qq_raw_send.py`：`fake_post(channel_id, openid, text, msg_id):`
- `backend/tests/test_tool_history_request_boundary.py`：`fake_post(channel_id, target_id, text, msg_id, message_format):`
处置：仅名称重复，暂不抽取；需在后续对拍函数体和断言语义。

### fake_exists

- `backend/tests/test_regressions_datetime_and_version.py`：`fake_exists(key):`
- `backend/tests/test_regressions_datetime_and_version.py`：`fake_exists(key):`
- `backend/tests/test_scheduled_task_execution.py`：`fake_exists(key):`
- `backend/tests/test_scheduled_task_execution.py`：`fake_exists(key):`
- `backend/tests/test_scheduled_task_execution.py`：`fake_exists(key):`
处置：仅名称重复，暂不抽取；需在后续对拍函数体和断言语义。

### build_request

- `backend/tests/test_send_file_url_streaming.py`：`build_request(self, method, url):`
- `backend/tests/test_send_file_url_streaming.py`：`build_request(self, method, url, headers=None, extensions=None):`
- `backend/tests/test_send_file_url_streaming.py`：`build_request(self, method, url, headers=None, extensions=None):`
- `backend/tests/test_send_file_url_streaming.py`：`build_request(self, method, url, headers=None, extensions=None):`
- `backend/tests/test_url_security.py`：`build_request(self, method, url, headers=None, extensions=None):`
处置：仅名称重复，暂不抽取；需在后续对拍函数体和断言语义。

### fake_compact

- `backend/tests/test_commands.py`：`fake_compact(*_args, **_kwargs):`
- `backend/tests/test_commands.py`：`fake_compact(*_args, **_kwargs):`
- `backend/tests/test_core_loop_characterization.py`：`fake_compact(messages, *args, **kwargs):`
- `backend/tests/test_memory_periodic.py`：`fake_compact(user_id, _settings, count):`
处置：仅名称重复，暂不抽取；需在后续对拍函数体和断言语义。

### fake_sync

- `backend/tests/test_memory_compaction_retrieval.py`：`fake_sync(*_args, **_kwargs):`
- `backend/tests/test_memory_compaction_retrieval.py`：`fake_sync(*_args, **_kwargs):`
- `backend/tests/test_memory_compaction_retrieval.py`：`fake_sync(*_args, **_kwargs):`
- `backend/tests/test_memory_event_scopes.py`：`fake_sync(*_args, **_kwargs):`
处置：仅名称重复，暂不抽取；需在后续对拍函数体和断言语义。

### fake_write

- `backend/tests/test_memory_event_scopes.py`：`fake_write(scope, filename, text):`
- `backend/tests/test_memory_event_scopes.py`：`fake_write(*args, **_kwargs):`
- `backend/tests/test_memory_event_scopes.py`：`fake_write(*_args, **_kwargs):`
- `backend/tests/test_rag_vector_cache.py`：`fake_write(_uid, values):`
处置：仅名称重复，暂不抽取；需在后续对拍函数体和断言语义。

### fake_preview

- `backend/tests/test_rag_injection.py`：`fake_preview(_scope):`
- `backend/tests/test_rag_injection.py`：`fake_preview(_scope):`
- `backend/tests/test_scheduled_group_imctx.py`：`fake_preview(*a, **kw):`
处置：仅名称重复，暂不抽取；需在后续对拍函数体和断言语义。

### fake_dispatch

- `backend/tests/test_core_loop_characterization.py`：`fake_dispatch(uid, name, inp):`
- `backend/tests/test_im_identity.py`：`fake_dispatch(payload):`
处置：仅名称重复，暂不抽取；需在后续对拍函数体和断言语义。

### fake_embed

- `backend/tests/test_event_memory.py`：`fake_embed(text):`
- `backend/tests/test_rag_vector_cache.py`：`fake_embed(text):`
处置：仅名称重复，暂不抽取；需在后续对拍函数体和断言语义。

### fake_ack

- `backend/tests/test_qq_binding_code.py`：`fake_ack(*args):`
- `backend/tests/test_qq_raw_ws.py`：`fake_ack(*args, **kwargs):`
处置：仅名称重复，暂不抽取；需在后续对拍函数体和断言语义。

### fake_send_text

- `backend/tests/test_streaming_regressions.py`：`fake_send_text(_receive_id, text, _channel_id):`
- `backend/tests/test_wechat_quotes.py`：`fake_send_text(*args, **kwargs):`
处置：仅名称重复，暂不抽取；需在后续对拍函数体和断言语义。

## 跨文件完全重复函数体

> 仅列出函数体归一化后完全一致且跨文件出现的 helper；没有结果时表示本轮未找到可直接抽取的重复实现。

- 未发现跨文件完全重复函数体。
