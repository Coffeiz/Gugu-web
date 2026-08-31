# Canonical Context Phase 0 基线审计

日期：2026-08-25
范围：Gugu-web 后端 Context Assembly、History、Provider Adapter、LoopScope

## 结构基线

当前入口均遵循以下请求顺序：

```text
static system / session snapshot
→ canonical history
→ current user turn
→ current-turn persistent tail（例如 RAG）
→ dynamic tail（时间、stance 等）
```

已确认的结构事实：

- Web、IM、定时任务都经过 `agent.context.context_assembly.build_messages()`；
- `PromptMessages.conversation` 不包含 dynamic tail，追加历史时会插入 dynamic tail 之前；
- 工具调用与工具结果在 Canonical Context 中以 `tool_turn` unit 归组；
- Provider wire 渲染通过 `ProviderAdapter.render_history()`，不修改原始历史；
- LoopScope 记录 canonical digest、wire digest、schema digest、dynamic tail digest、缓存能力和首个结构差异索引；
- 诊断只保存数量、长度、digest 和结构元数据，不保存正文、附件 URL、base64 或密钥。

## 基线检查

本地后端全量测试：

```text
1383 passed
```

本轮新增的 Canonical Context/Provider adapter/断点测试：

```text
37 passed
```

工作区已有 RAG 索引改动另有 6 个测试失败，失败集中在 BM25 召回结果与排序，不属于本轮 Context 改动；未修改这些测试来掩盖失败。

## Phase 0 结论

Phase 0 已冻结结构边界和诊断字段。真实 Provider 连续 run 的缓存基线仍保留在现有 DeepSeek/MiniMax 报告中，后续只使用脱敏的 provider usage、digest 和 first diff 追加记录。
