# IMPLEMENT：PRD-RAG-9 Phase 5 收敛验收与实施报告

> 日期：2026-09-13
> 范围：PRD-RAG-9 Phase 5 测试缺口收敛、实现缺陷修复、性能测量
> 主提交：`0f443278c`（PRD-RAG-9 Phase 5）；PRD 修订 `25b8efa19`
> 验证：本地全量后端测试 **2795 passed**（4 分 29 秒）；受影响模块复跑 85 passed

## 1. 收敛结论

Phase 5 的定位是把行为承诺、实现责任和真实回归证据重新对齐。收敛结果：**写侧 doc-patch 主链与 PRD §4 一致，未发生架构偏离**；收敛过程发现并修复了 3 个实现缺陷（其中 1 个为索引正确性级别）。

## 2. 发现并修复的实现缺陷

### 2.1 [P1] 部分编辑误删未变化 chunk

`update_document` 只把 `delta.upserts` 传给 `apply_document_patch`，而该函数的语义是「父文档作用域 replace：不在键集的行打软删墓碑」。结果：**多 chunk 文档做部分编辑时，未变化的 chunk 被静默从索引删除**，召回从此丢失这部分内容。违反 PRD §6.3「保留未变化 chunk 的数据库 ID 和稳定字段」。

修复：DB 侧改传「当前全量 chunk 集」（父文档 replace 语义正确收敛），worker 侧仍只收 delta（变化 upserts + 消失 slot），保持增量语义。回归：`test_partial_edit_keeps_unchanged_chunks`。

该缺陷由文件夹移动测试意外暴露（移动后 chunk 计数对不上），是 Phase 5「测试揭示行为缺陷应先修实现」路径的典型案例。

### 2.2 [P1] 写路径诊断自上线起静默空转

`diagnostics.record_index_update` 引用了未定义的 `_log` 和 `json`，每次调用都在 `NameError` 中被 `except: pass` 吞掉——**PRD §9 的写路径诊断一条都没有实际落过日志**。修复后七态（document_patch / source_replace / revision_mismatch / worker_unavailable / projection_failed / event_replayed / no_change）真实落盘并有断言回归。

教训：`except Exception: pass` 包裹的可观测性代码，必须至少有一次「看到它真的输出了」的验证。

### 2.3 [P2] 单文档 patch 的 O(来源规模) 死代码

`update_document` 每次 patch 都全量 `load_index_documents` 且结果从未使用。删除后实测（1000 条 knowledge × 4 chunk 规模）：单文档修改 p50 **79ms → 7.5ms**。

## 3. 合并正确性定案（§5.2）

选择方案①修代码，摘掉「写侧正确性依赖查询侧兜底」的隐性耦合：

- **bus**：`_rag_pending` 从「每键最后一条」改为「按 source_id 保留各自最新事件」；无 source_id 的 refresh 事件升级为来源级重建并覆盖文档级 pending（§5.2 规则 3）。
- **outbox**：`rag_index_jobs` 增 `pending_source_ids` JSON 列（迁移 `20260914000001`）。persist 并集去重；`due_events` 逐 ID 展开为 upsert 重放事件（最终动作由主数据决定）；`mark_result` 成功后逐 ID 移除，失败保留集合。
- **实现中发现的次生缺陷**：逐 ID 移除后若集合非空仍置 `ready`，剩余 ID 会被 `due_events` 永久遗漏（ready 行不再到期）——改为集合非空时保持 `queued`。

## 4. 性能测量（`scripts/diagnostics/rag_phase5_perf.py`）

1000 条 knowledge × 4 chunk/条，内存 SQLite + fake worker（pipeline 层分段，不含真实 TS worker/embedding）：

| 场景 | 结果 |
|---|---|
| 单文档修改 ×20 | 端到端 p50 7.5ms / p95 92ms；projection_ms p50 0；patch_ms（fake）0 |
| 单文档删除 ×20 | 端到端 p50 5.2ms / p95 7.3ms |
| 连续 10 次同源多文档变更 ×5 轮 | 每轮 92–143ms（≈10–14ms/文档，线性、无来源级重建） |
| 来源级全量重建基线（4000 chunk） | 785ms |

对比：单文档增量 ≈ 7.5ms vs 全量重建 785ms，**约 100×**，且增量成本不随来源规模增长（修复死代码前的 79ms 是随规模线性增长的）。TS worker 内部段耗时见同日 [RAG 冷构建基准报告](./2026-09-13-INVEST-RAG冷构建超时基准.md)（20237 条全量重灌 0.78s）。「worker 重启恢复」段在 pipeline 层等价于 mismatch 回退的来源级 replace（即上表基线路径）；worker 侧快照恢复见基准报告。

## 5. 测试资产

- `tests/test_rag_phase5_convergence.py`（9 例）：bus 多 ID 保留/refresh 覆盖、outbox 逐 ID 重放收敛（端到端：DB projection + worker revision 一致）、七态诊断、脱敏、Conversation/Memory 例外。
- `tests/test_rag_phase5_boundaries.py`（7 例）：关键词/描述版本戳、删除后恢复、projection 事务失败、向量部分失败幂等、文件夹移动旧 scope 清理、owner 隔离、部分编辑回归。
- 既有覆盖复用：文件覆盖/重命名/移动/删除、项目增量、Calendar/Note/Canvas（test_rag_file_project_delta / test_rag_remaining_sources_delta）；scope ACL（test_rag_unified_query）。
- 全量后端套件 2795 passed；未新增 CI 范围外的运行负担（perf 脚本为手动诊断入口）。

## 6. 部署注意

- 迁移 `20260914000001`（rag_index_jobs 加 `pending_source_ids`）需随代码同步执行 `alembic upgrade head` 后再重启服务。
- Conversation/Memory 例外定案与七态诊断语义已同步进 PRD §2/§7/Phase 3/Phase 5。
