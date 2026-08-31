# RAG 召回评分、过滤与质量控制

> 状态：Phase 0–6 已完成；评分正常路径已迁移至 TypeScript worker
> 创建：2026-08-25
> 最近更新：2026-08-25
> 关联模块：`backend/agent/memory/`、`backend/agent/rag/`、`backend/agent/tools/search_memory.py`、`backend/agent/tools/global_search.py`
> 前置文档：[PRD-RAG-1-统一知识召回与索引.md](./PRD-RAG-1-统一知识召回与索引.md)、[PRD-MEM-1-记忆召回工具与混合检索.md](./PRD-MEM-1-记忆召回工具与混合检索.md)
> 测试参考：[2026-08-25-TEST-RAG-QUALITY-FULL-RETEST.md](../../development/2026-08-25-TEST-RAG-QUALITY-FULL-RETEST.md)

## 0. 实施 Todo

本表是本 PRD 唯一的执行状态来源。

| 阶段 | 状态 | 目标与交付物 |
|---|---|---|
| Phase 0：现状盘点与指标冻结 | ✅ 已完成 | 已盘点 BM25、Embedding、`normalized_score`、hybrid 现有计算；冻结 Recall@K、Precision@K、空结果率、重复率、误召回率、注入 token 和 P95 延迟指标 |
| Phase 1：统一候选与权限边界 | ✅ 已完成 | 已统一 `RecallCandidate`；来源结果进入融合前执行 scope/ownership 过滤；统一 source、版本、正文 fingerprint 和来源内 rank 字段 |
| Phase 2：归一化与 RRF 融合 | ✅ 已完成 | 来源内分数归一化；BM25/向量混合改用 rank-based RRF；跨来源排序使用统一 fused score，不直接比较原始分数 |
| Phase 3：置信度与过滤 | ✅ 已完成 | 实现 `confidence`、0.35 硬下限、0.55 优先阈值和低分空结果策略，不为凑数量注入低质量结果 |
| Phase 4：去重、多样性与预算 | ✅ 已完成 | source/fingerprint 去重、同源/父文档上限、Jaccard 多样性过滤、Top-K 和字符预算统一 |
| Phase 5：质量评估与灰度 | ✅ 已完成 | 质量复测脚本支持不过滤、原始分、`normalized_score` 和 `confidence` 四种对照；覆盖 owner、群聊、私聊语义和无 embedding BM25 回退；结果见质量复测报告 |
| Phase 6：旧逻辑清理 | ✅ 已完成 | 评分/阈值/融合诊断收口到统一模块，删除过时的质量报告生成器和调用方自定义规则，补齐质量诊断和回归测试，并同步 RAG-1、MEM-1 文档 |

## 1. 背景与目标

BM25 原始分、向量相似度和 `normalized_score` 的尺度不同，不能直接横向比较。现有固定阈值在索引规模、查询词和模型变化后容易失效，导致低质量内容进入上下文，或相关结果被过度过滤。

本 PRD 统一召回流程：

```
用户查询 → 权限过滤 → 多路召回 → 候选合并 → 去重 → 融合评分 → 质量过滤 → 预算裁剪 → 上下文注入
```

目标是让无 embedding 时稳定使用 BM25，有 embedding 时使用 BM25 + 向量混合召回，并由统一 `confidence` 决定是否注入。该方案不替换 `global_search` 的精确对象搜索，也不改变工具授权边界。

Phase 0–1 的历史结论：BM25/Rust sidecar、LegacyBM25、向量缓存和 hybrid
仍保留各自的来源内分数；因此 Phase 0–1 先只把候选身份和权限边界统一，不把原始分数直接
拿来跨来源比较；Phase 2–4 已在此基础上完成统一评分与质量控制。

Phase 2–4 已完成：`scoring.py` 集中维护归一化、RRF、confidence、来源质量和
轻量多样性规则；UnifiedRecallService 只保留一条候选流水线，旧的公共
`RecallResult` 输出字段继续兼容。补充校准：数字不能单独构成有效语义命中；
单候选不再自动获得 `normalized_score = 1`；中英文实体短语会做紧凑匹配，避免
`GTA 6` 被正文中孤立的数字 `6` 误召回。

## 2. 功能需求

### FR-RAG-01：统一候选结构（✅ Phase 1）

每条候选至少包含：

```
{
  "source_id": "稳定来源 ID",
  "source_type": "memory|project|file|canvas|conversation",
  "scope": "owner|group|member",
  "content_fingerprint": "正文 hash",
  "raw_score": 0.0,
  "normalized_score": 0.0,
  "rank": 1,
  "fused_score": 0.0,
  "confidence": 0.0
}
```

`raw_score` 只用于诊断，不能用于跨检索器过滤。

实现位置：`backend/agent/rag/models.py` 的 `RecallCandidate`，由
`RetrievalBatch.candidates()` 按来源内返回顺序生成。旧的 `RecallResult` 公共输出
保持兼容；新增的 fingerprint、rank 和分数占位字段只用于后续统一流水线。

### FR-RAG-02：权限优先（✅ Phase 1）

处理顺序固定为：

```
scope / ownership 过滤 → BM25 / Embedding 召回 → 合并去重 → 评分 → 质量过滤
```

`member` 记忆默认只允许进入当前群和当前发言人的可见范围。禁止先召回再补权限判断。

实现位置：`backend/agent/rag/scope.py` 的 `filter_authorized_documents()` 和
`UnifiedRecallService.search()`。来源 adapter 先做 scope-first，统一服务在候选
进入排序前再做一次 owner/scope 边界校验，并返回 `permission_rejected` 诊断计数；
不把正文或用户身份写入日志。

### FR-RAG-03：归一化与混合融合（✅ Phase 2）

BM25 和 Embedding 各自在检索器内部归一化，保留算法版本。混合结果使用 RRF，不直接相加原始分数：

```
fused_score =
  weight_bm25 / (60 + bm25_rank)
+ weight_vector / (60 + vector_rank)
```

默认权重为 BM25 0.45、Embedding 0.55。明确实体、编号、文件名或版本号查询可提高 BM25 权重，但必须记录并可复现。

实现位置：`backend/ts/workers/rag/src/service.ts` 和 `backend/agent/rag/hybrid.py`。来源批次先独立归一化，
混合召回按 rank 计算 RRF；无向量或向量缓存失效时保留 TS worker 的 BM25 回退。

### FR-RAG-04：统一置信度（✅ Phase 3）

```
confidence =
  0.55 * fused_score
+ 0.25 * query_match
+ 0.20 * source_quality
```

`query_match` 表示关键词、实体、时间和版本命中；`source_quality` 表示来源类型、完整性、新鲜度和稳定性。权重集中配置并版本化。

首版实现使用统一 tokenizer 计算 query/content token overlap，并按来源类型提供
稳定质量先验；下一阶段离线评测后再校准来源质量权重。

### FR-RAG-05：硬下限与动态阈值（✅ Phase 3）

首版默认：

- `confidence < 0.35`：丢弃；
- `0.35 ≤ confidence < 0.55`：仅在没有更好候选且结果不足时补入；
- `confidence ≥ 0.55`：允许注入。

最高分过低时返回空结果；第一名明显领先时优先只保留第一名；分数接近时允许多条，但受 Top-K 和预算限制。不得为了凑数量放宽阈值。

策略实现位置：`backend/ts/workers/rag/src/index.ts`；Python `scoring.py` 仅保留兼容诊断与测试。当前首版动态策略为“有 0.55 以上候选
时只保留优先候选；否则在 0.35 以上候选中补位；低于 0.35 直接丢弃”。

### FR-RAG-06：去重、多样性与预算（✅ Phase 4）

- 按稳定 `source_id`、版本和 `content_fingerprint` 去重；
- 设置同一父文档和同一 scope 的命中上限；
- 使用 MMR 或等价策略减少相似片段重复；
- 自动 RAG 默认最多注入 5 条，复杂查询最多 8 条；
- 单条内容和总 RAG 内容都受 token 预算限制；
- 注入前与固定 profile、pattern、daily 内容按正文 hash 去重。

实现位置：`UnifiedRecallService.search()`。除正文 fingerprint、同源和父文档上限
外，新增 token Jaccard 相似度过滤（相似度达到 0.85 时跳过后续片段），保持
默认最多 5 条、复杂查询由调用方传入更高上限但不超过全局 10 条和 3000 字符。

### FR-RAG-07：无 embedding 回退（✅ Phase 5）

未配置 embedding、向量缓存缺失或向量服务失败时只走 BM25。回退不阻塞主流程，并沿用同样的去重、阈值和预算规则。

### FR-RAG-08：诊断日志（✅ Phase 6）

只记录摘要和 fingerprint，不记录查询正文、附件名或用户输入：

```
{
  "strategy": "hybrid-rrf",
  "candidate_count": 20,
  "accepted_count": 4,
  "rejected_low_score": 8,
  "rejected_duplicate": 5,
  "top_confidence": 0.81,
  "threshold": 0.55
}
```

线上诊断在上述摘要字段外增加统一 `quality` 对象，包含 `accepted_count`、各类
过滤计数、`top_confidence`、阈值和 `scoring_version`。旧的分散阈值/排序诊断不再
由来源 adapter 或调用方自行记录；日志仍不包含查询正文、记忆正文、附件名或用户标识。

## 3. 技术方案

### 3.1 统一评分流水线

```
查询
  ↓
scope / ownership
  ↓
BM25 ─────────────┐
                  ├→ 合并去重 → rank / normalized / RRF
Embedding（可选）─┘                         ↓
                                  confidence 过滤
                                             ↓
                                  多样性、Top-K、预算
                                             ↓
                                  canonical knowledge-context
```

### 3.2 固定记忆与 RAG 边界

固定 profile、pattern、daily 负责稳定基础信息；RAG 负责按查询补充知识。二者不能各自维护独立阈值、排序和裁剪逻辑，最终由统一召回服务输出一份 canonical 结果。

### 3.3 配置版本

RRF 常数、两路权重、归一化算法、`confidence` 权重与阈值、Top-K、同源上限、token 预算和来源质量权重必须集中配置并带版本号。业务调用方不得临时维护另一套规则。

## 4. 验证与上线

使用同一批真实脱敏查询和固定索引，对比：

1. 不过滤；
2. 直接比较原始分数；
3. 使用 `normalized_score`；
4. 使用新 `confidence`。

记录 Recall@K、Precision@K、MRR、空结果率、重复率、误召回率、平均注入 token、P95 检索延迟和 BM25 回退比例。

自动化测试必须覆盖：三种召回路径、向量失败回退、权限过滤、去重、低分空结果、动态阈值、Top-K/预算、群聊/私聊/Web 统一协议。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 分数尺度不一致 | 混合排序失真 | 只允许内部归一化 + RRF |
| 阈值过严 | 相关结果为空 | 离线标注集校准，并保留诊断统计 |
| 阈值过松 | 噪声进入上下文 | 硬下限、同源上限和总预算 |
| 召回重复 | 浪费上下文 | source/fingerprint 去重和多样性 |
| 向量不稳定 | 延迟或召回下降 | BM25 稳定回退 |
| 旧逻辑残留 | 规则分叉 | Phase 6 清理重复阈值和排序 |

待确认：

- 🔲 第一轮真实标注集规模和标注规则；
- 🔲 `confidence` 是否按来源类型做小范围校准；
- 🔲 MMR 的额外延迟预算；
- 🔲 自动 RAG 默认 Top-K 固定为 5，还是按查询类型动态上限。
