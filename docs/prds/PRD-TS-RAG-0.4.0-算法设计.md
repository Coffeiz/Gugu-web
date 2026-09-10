# PRD：TS RAG 0.4.0 算法设计

> 状态：已完成（v4 已于 2026-09-10 切换为生产评分，v1 保留为回滚开关 `search.ts_rank_scoring_version`）
> 版本：0.4.0
> 创建：2026-09-09
> 最近更新：2026-09-10
> 所属层：RAG / TypeScript Worker / Scorer & Ranker
> 前置文档：[`PRD-RAG-7-TS全链路检索分阶段迁移.md`](./PRD-RAG-7-TS全链路检索分阶段迁移.md)
> 关联文档：[`【已完成】PRD-RAG-8-字段感知软重排与来源字段加权.md`](./【已完成】PRD-RAG-8-字段感知软重排与来源字段加权.md)

## 1. 一句话目标

在 TypeScript 全链路检索的基础上，把经过完整索引 IDF 和非线性 token scorer（`p=1.5`）处理后的检索质量统一折算为 `confidence`，由 `confidence` 同时承担最终排序和质量过滤职责；首选过滤阈值维持 `0.55` 不变，低分硬下限保持 `0.35`。定稿公式为乘法形式：`confidence_v4 = (0.75 × retrieval_norm + 0.25 × query_match) × source_quality`，天然有界（上界 = 来源质量值），不再需要额外截断。

## 2. 背景与问题

当前链路已经能在 TypeScript 中完成 BM25、hybrid 融合、IDF 非线性重排和 `confidence` 计算，但排序和过滤仍存在两套语义：

```text
候选召回/重排：rank_score
质量过滤：confidence
```

这会产生几个问题：

1. 最终结果按 `rank_score` 排序时，排序依据与过滤依据不一致。
2. `confidence` 已经综合了词法相关度、query 命中和来源质量，但没有成为最终排序的唯一质量分数。
3. 诊断报告需要同时解释 `rank_score`、`fused` 和 `confidence`，使用方容易误把底层检索分数当作最终相关性。
4. 原首选阈值 `0.55` 偏宽，低质量但处于阈值附近的候选仍可能进入优先结果。

0.4.0 不改变权限、候选召回来源和索引结构，先收敛最终排序和过滤的分数语义。

## 3. 目标

1. 保留 BM25、embedding 和 RRF/hybrid 作为候选生成信号。
2. 继续使用完整 TS 索引的 IDF，按 query 内 token 的相对信息量进行非线性 scorer。
3. 将 `confidence` 升级为最终 ranker 的主分数：结果按 `confidence` 降序排列。
4. 首选过滤阈值保持 `0.55` 不变（v4 分数尺度下 `0.60` 偏紧，见 §7.2 回放观察）；阈值重标待上线数据后再定。
5. 保留 `0.35` 作为低质量硬下限；无有效 query 命中的候选不得凭来源质量进入首选集合。
6. 保持评分可解释：LoopScope 能看到各组成项、算法版本和过滤原因。
7. 让同一套算法适用于 conversation、knowledge、memory、project、file、calendar、canvas、journal 等来源，不为单一来源写专用排序分支。

## 4. 非目标

- 不在本 PRD 中重写 tokenizer、倒排索引或 TS 写路径。
- 不以候选子集重新计算 IDF；IDF 始终来自当前 scope/revision 的完整索引。
- 不引入按语言拆分的词库，也不依赖人工 stopword 表。
- 不因为来源类型本身直接把候选提升到可接受；`source_quality` 只是质量先验。
- 不把 `rank_score` 从候选召回内部删除。它仍可作为 BM25/混合召回的底层信号和诊断字段。
- 不在本阶段引入 reranker 模型或外部重排服务。

## 5. 目标链路

```text
业务数据 / 已授权 source records
        ↓
TS 完整索引
        ↓
BM25 / embedding / RRF-hybrid 候选召回
        ↓
完整索引 IDF + query token 非线性 scorer
        ↓
候选内归一化 lexical / semantic / fused
        ↓
confidence-v4
        ↓
按 confidence 排序
        ↓
confidence 阈值过滤、去重、来源上限、字符预算
        ↓
最终 RAG 结果
```

职责边界：

| 分数 | 职责 | 是否作为最终排序分 |
| --- | --- | --- |
| `raw_score` | 单来源底层召回原始分 | 否 |
| `rank_score` | BM25/混合候选的底层重排分，包含 IDF 非线性 token 贡献 | 否，保留作候选和诊断信号 |
| `lexical_norm` | 候选池内归一化词法质量 | 作为 confidence 输入 |
| `semantic_norm` | 候选池内归一化向量质量 | 作为 confidence 输入（有向量时） |
| `fused` / `retrieval_norm` | 词法和语义召回质量的归一化组合 | 作为 confidence 输入 |
| `query_match` | query 与候选文本的命中覆盖度 | 作为 confidence 输入 |
| `source_quality` | 来源质量先验 | 作为 confidence 输入 |
| `confidence` | 综合质量分 | 是 |

## 6. 0.4.0 评分算法

### 6.1 完整索引 IDF

对 query 中的 token，使用当前 scope/revision 的完整索引统计：

```text
idf(t) = log(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
```

其中：

- `N`：当前完整索引中的文档数。
- `df(t)`：包含 token `t` 的文档数。
- 不使用当前候选 Top-K 或单一来源的局部文档数替代。

### 6.2 Query token 权重

不按语言拆分，也不先硬删除 token。对本次 query 的有效 token 计算相对 IDF 权重：

```text
baseline = mean(idf(t))
query_weight(t) = clamp((idf(t) / baseline)^1, 0.25, 4.0)
```

当 query 中没有可用 IDF 时，回退为现有 BM25/hybrid 结果，不伪造高信息权重。

### 6.3 非线性 token scorer

每个候选按 token 计算 BM25 贡献，再使用 query 权重和非线性指数 `p=1.5`：

```text
bm25_term(t, d) = idf(t) × tf_norm(t, d)
weighted_term(t, d) = bm25_term(t, d) × query_weight(t)
nonlinear_term(t, d) = weighted_term(t, d)^1.5
rank_score(d) = Σ nonlinear_term(t, d)
```

指数从初版 `p=2` 下调为 `p=1.5`（2026-09-10 定稿）：`p=2` 时头部项对池内归一化的挤压过强，长文档、笔记类候选的相对词法分被压到接近 0；`p=1.5` 保留非线性放大的同时让次头部项维持合理区分度。回放对比（06:48 run，12 case）：跨过首选线的候选从 13 行增至 16 行，低分带从 51 行收缩到 41 行，无劣化案例。

该分数的目标是让 `t6`、项目名、活动名或其他明确标识符等高信息 token，在排序中比多个低信息口语 token 更有影响力。它仍然允许多个 token 累积，不使用单 token 硬门槛。

### 6.4 候选池归一化

`rank_score` 不能直接与不同来源或不同候选池的分数比较。进入 confidence 前进行同一候选池内归一化：

```text
lexical_norm = normalize(rank_score)
```

有 embedding 时：

```text
retrieval_norm = 0.45 × lexical_norm + 0.55 × semantic_norm
```

无 embedding 时：

```text
retrieval_norm = lexical_norm
```

本公式中的权重是候选召回层权重，不代表最终 ranker 权重；最终 ranker 统一使用下面的 `confidence`。

### 6.5 Query match

`query_match` 表示 query 与候选文本的覆盖程度：

1. 去除纯标点、符号和数字噪声后得到 meaningful tokens。
2. query 紧凑文本完整出现在候选文本中时为 `1.0`。
3. 否则使用候选命中的 meaningful token 数除以 meaningful token 总数。
4. 结果限制在 `[0, 1]`。

它用于衡量“是否命中了用户本次提问”，不替代 IDF scorer。

### 6.6 Source quality

`source_quality` 是来源先验，不是事实置信度，也不能单独使零命中候选通过过滤。2026-09-10 定稿值（v4 实验口径，乘法公式中直接作为分数上界）：

| 来源 | 值 |
| --- | ---: |
| `knowledge` | 1.0 |
| `memory` | 0.8 |
| `project` | 0.8 |
| `file` | 0.8 |
| `journal` | 0.8 |
| `note` | 0.8 |
| `calendar` | 0.8 |
| `canvas` | 0.6 |
| `conversation` | 0.6 |
| `scheduled_task` 等未知来源 | 0.6 |

相对初版的主要调整：`calendar` 0.5→0.8（回放中「全天呢」类日历 query 的日历候选以 0.66–0.69 刚过首选线，是正确形态）、`conversation`/`canvas` 0.5→0.6、`memory` 0.9→0.8、新增 `note=0.8`（时间流笔记，回放中「之前那个多肉叫什么」的两条便签在全来源池内以 0.70 登顶并入选）。`scheduled_task` 当前跟随未知来源 0.6，暂不单列。

Knowledge 仍可根据自身事实状态做额外折减；来源值的调整必须带版本并进入 LoopScope 诊断。**注意与线上 conf-v1 的 SOURCE_QUALITY 表（memory 0.9/project 0.9/calendar 无键走默认 0.7 等）是两套口径，v4 上线时必须同步替换。**

### 6.7 Confidence v4

0.4.0 的默认最终质量分（2026-09-10 定稿，乘法形式）：

```text
confidence_v4 = (0.75 × retrieval_norm + 0.25 × query_match) × source_quality
```

有 embedding 时 `retrieval_norm = 0.45 × lexical_norm + 0.55 × semantic_norm`，无 embedding 时就是 `lexical_norm`。结果天然有界：上界 = 该候选的 `source_quality`（最高 1.0），不需要额外 min/max 截断。

该公式由两轮权重迭代定案：初版加法式 `0.40×retrieval + 0.20×match + 0.40×quality` 在回放中来源先验占比过高、区分度不足；改为乘法后来源质量退化为分数上界而非加项，同来源内排序完全由检索质量与 query 命中决定。

**无命中保护（保留）**：`query_match = 0` 的候选 `value` 压到 `0.35 - 0.01` 以下，不进任何 band。实施期发现：单候选池的 `lexical_norm` 恒为 1，纯乘法下零命中候选可凭来源质量达到 `0.75 × quality` 越过首选线（违反 §3.5 目标），故生产实现保留 v1 同款硬保护（`rank-candidates.ts`）。

## 7. 最终排序与过滤

### 7.1 最终 ranker

未来正式 ranker 直接使用 `confidence_v4`：

```text
order by confidence_v4 desc
```

同分时使用稳定 tie-break，避免候选顺序随机变化：

```text
confidence_v4 DESC
→ rank_score DESC
→ fused DESC
→ source priority ASC
→ updated_at DESC
→ stable document id ASC
```

`rank_score`、`fused` 仅作为同分决胜和诊断，不得在正常情况下覆盖 `confidence_v4` 的主排序语义。

> 2026-09-10 实施注记：生产排序由 `rankCandidates` 按 `confidence_v4` 降序完成；由于 v4 的词法归一化依赖候选池与语料统计，跨管线比较分数必须使用同一份完整索引统计（`corpus_documents`），否则 IDF 基准不同导致分数不可比。

### 7.2 过滤阈值

```text
PREFERRED_THRESHOLD = 0.55
LOW_SCORE_THRESHOLD = 0.35
```

选择规则保持当前两段式行为，但提高首选线：

1. 如果存在 `confidence_v4 >= 0.55` 的候选，只从首选集合按 confidence 排序后取结果上限。
2. 如果没有首选候选，则允许 `0.35 <= confidence_v4 < 0.55` 的 fallback 候选填充结果，避免轻微相关的查询完全没有反馈。
3. `confidence_v4 < 0.35` 直接过滤。
4. `query_match <= 0` 的候选受无命中保护，不能进入首选集合。
5. `top_k` 调试模式可以跳过阈值观察完整排序，但必须在 LoopScope 标注 `selection_mode=top_k`，不能作为生产默认模式。

回放观察（2026-09-10，两份 run 35 case）：v4 分数尺度整体低于 v1，`0.55` 首选线覆盖率偏低（约 11% 候选行跨线），存在个别 case 首选带为空、fallback 带接近全量放行的情况。决策（2026-09-10）：首选阈值先维持 `0.55` 不变，不提高到 `0.60`；是否重标（候选方案 `0.50/0.30`）作为开放项挂起，上线后按首选率/空结果率再定。

### 7.3 去重和预算

阈值和排序完成后，继续执行现有约束：

- `exclude_content_hashes` 跨轮去重。
- 内容 hash 去重和父节点去重。
- `max_per_source`、`max_per_parent` 来源/父节点上限。
- `max_chars` 总字符预算。
- 权限和 scope 复核仍由业务侧负责，TS 不得因排序迁移而扩大可见范围。

## 8. 可观测性与 LoopScope

每次统一召回至少记录以下安全诊断字段，不记录用户正文、附件原文、密钥或凭据：

```json
{
  "scoring_version": "ts-rag-0.4.0",
  "ranker_score": "confidence_v4",
  "selection_mode": "confidence",
  "preferred_threshold": 0.55,
  "low_score_threshold": 0.35,
  "rank_score": 0.0,
  "lexical_norm": 0.0,
  "semantic_norm": null,
  "retrieval_norm": 0.0,
  "query_match": 0.0,
  "source_quality": 0.5,
  "confidence": 0.0,
  "confidence_band": "rejected_low_score",
  "selected": false,
  "rejected_reason": "below_preferred_threshold"
}
```

LoopScope 报告应能回答：

1. 候选是否在召回阶段就缺失，还是在 confidence 过滤阶段被拒绝。
2. 当前排序是否由 confidence 主导，而不是被旧 `rank_score` 偷换。
3. `knowledge`、`calendar`、`conversation` 等来源是否因 source quality 或 query match 被系统性压低。
4. IDF、非线性指数、阈值和来源质量版本是否与本次 run 一致。

## 9. 迁移方案

### Phase 1：离线算法与报告

- [x] `RAG4-001` 将离线诊断脚本（`rag_confidence_probe.py`）输出统一为 `confidence_v4` 排名；验收：观察榜单按 v4 降序，含 conf-v1/v4 对照与过滤区间。
- [x] `RAG4-002` 使用历史 LoopScope run 回放，报告原始 query、候选内容摘要、各项分数和过滤原因；验收：非脱敏 full-report 落 `scripts/diagnostics/local/`（gitignored），两份 run（23 case + 12 case）均可复现。
- [x] `RAG4-003` 固定评分 fixture：`p=1.5`、v4 source quality 表、`(0.75/0.25)×quality` 公式；验收：探针常量与本文 §6 一致，报告头部口径说明同步。
- [x] `RAG4-004` 对 `蒙扎的 T6 叫什么`、天气、项目名、活动名、Knowledge 标题和混合语言 query 做回归；验收：目标候选（T6 弯道 knowledge、笔记便签、日历活动）在对应 case 进入入选集合且排名合理，无重复内容挤占分数（生产同款 hash + 相似度 ≥0.85 + 来源/父节点上限 + 字符预算去重已复刻进探针）。

### Phase 2：TS shadow ranker

- [x] `RAG4-005` 在 TS 统一查询入口（`rankCandidates`）同时计算 v1 排序和 `confidence_v4` 阴影排序；验收：`rankCandidates` 返回的 `diagnostics.shadow_v4` 含 v4 入选集合、top_confidence、阈值与 `p=1.5` 指数，单测覆盖（`test/rank-shadow-v4.test.ts`）。
- [x] `RAG4-006` 生产仍交付 v1 结果，两套排名差异经 `service.py` 透传进 LoopScope quality；验收：真实 `search_knowledge` 调用中 `scoring_version` 保持 `confidence-v1`（Python 冻结校验不报错），`shadow_v4` 记录 `v1/v4_selected_ids`、`overlap_count` 与 `first_divergence_rank`。
- [x] `RAG4-007` 分离「候选召回缺失」和「新 ranker 重排」：阴影与 v1 使用同一候选池（candidate_count 一致），`shadow_v4.v4_selected_ids` 只反映池内重排；验收：代码注释与诊断字段共同保证缺池内容不会出现在 v4 集合。
- [x] `RAG4-008` 验证跨轮去重、父节点去重、来源上限和字符预算不受影响；验收：阴影复用同一 `selectUnifiedRecall` 实例与同一 options，worker 全部 48 个测试（含去重/预算用例）通过。

### Phase 3：confidence-v4 交付

- [x] `RAG4-009` 将 `confidence_v4` 作为生产最终排序分（`rankCandidates` 默认 `scoringVersion=confidence-v4`，按 v4 降序 + tie-break 排序）；验收：真实召回 `scoring_version=confidence-v4`，分数上界 = 来源质量（回归用例覆盖）。
- [x] `RAG4-010` 首选阈值保持 `0.55`，低分线保持 `0.35`；验收：诊断字段 `preferred_threshold/threshold` 断言通过。
- [x] `RAG4-011` 更新 Python/TS 协议与 LoopScope 字段：`rank_candidates` 协议带 `scoring_version`，Python guard 按配置校验（`RANK_SCORING_VERSION` 动态化），非线性指数切 `p=1.5`（`rescore_version=idf-nonlinear-v2`）；验收：全量 pytest 2379 通过、TS 48 通过，真实召回诊断字段正确。
- [x] `RAG4-012` 保留旧排序开关用于短期回滚：`search.ts_rank_scoring_version=confidence-v1` 时 Python 透传并由 TS 走 v1 评分路径（含 v1 无命中保护）；验收：回滚开关单测覆盖 v1 语义。

### Phase 4：清理旧实现

- [x] `RAG4-013` 清理旧排序分支：Phase 2 阴影通道（`shadow_v4` 诊断、契约字段与 Python 透传）已移除，v4 直接生产交付；验收：全仓无 `shadow_v4` 残留引用。
- [x] `RAG4-014` 阈值常量统一到 `SCORING_THRESHOLDS`（按版本一份），生产/回滚共用同一 band 逻辑；验收：v1/v4 阈值断言通过，无重复常量。
- [x] `RAG4-015` `rank_score` 保留为候选/诊断字段（`p=1.5` 非线性词法分），仍是 v4 词法归一化输入与同分决胜依据；验收：`rank_contributions` 诊断输出正常。
- [x] `RAG4-016` 更新测试与本文档：探针测试对齐定稿口径（0.55/0.35、乘法公式、p=1.5、note/calendar=0.8），PRD 状态行更新；验收：devserver 全量 pytest 2379 通过、TS worker 48 通过。

## 10. 测试与验收标准

### 10.1 单元测试

- `confidence_v4` 权重和边界值正确；乘法公式结果上界 = `source_quality`。
- `0.55` 恰好通过首选过滤，`0.549999` 不通过。
- `0.35` 恰好进入 fallback，`0.349999` 被拒绝。
- `query_match=0` 时 confidence 不超过 `0.75 × source_quality`（乘法公式的自然上界，无额外硬保护）。
- 来源质量表、未知来源默认值和 Knowledge 事实状态折减正确。
- 同 confidence 下 tie-break 稳定。
- 修改 `rank_score` 但保持 confidence 不变时，最终主排序不应改变；只有同分决胜时才使用 rank_score。

### 10.2 回放测试

- 使用固定 `before_message_id` 回放历史对话，防止当前会话后续内容污染结果。
- 同一 query、scope、revision 重跑结果稳定。
- 至少覆盖 conversation、knowledge、memory、project、file、calendar、canvas、journal。
- 验证 `蒙扎的 T6 叫什么` 能让包含 `t6` 的 Knowledge 获得合理排序，而不会被多个低信息 token 的 conversation 无故压过。
- 验证天气和时效 query 在已有 RAG 内容时可以正常返回，是否需要联网由 Agent 策略另行决定。

2026-09-10 回放结论（探针 `rag_confidence_probe.py`，报告在 `backend/scripts/diagnostics/local/`，gitignored）：

- 「之前那个多肉叫什么」：全来源池内两条便签以 conf_v4 0.703/0.700 登顶入选（v4×note=0.8 生效）；此前搜不到笔记的根因是 devserver `rag_auto_sources` 未含 `note`，已改回九来源全开。
- 「全天呢」：日历候选包揽前 6 中的 5 席（0.66–0.69 刚过首选线），calendar=0.8 档位行为正确。
- 重复文件/同文档多 chunk：生产同款去重（hash + bigram 相似度 ≥0.85 + max_per_source/parent=3 + 3000 字符预算）复刻进探针后，观察榜保留全部候选供诊断，入选集合不再被重复内容挤占。

### 10.3 指标

- Candidate Recall@K：确认候选阶段没有因 ranker 改造丢失目标内容。
- Hit@1/3/5、MRR 或 NDCG：确认最终 confidence 排序质量。
- 首选率、fallback 率、低分拒绝率：观察 `0.55` 阈值影响。
- 新旧排序的 Top-K 交集、首个差异位置和来源分布。
- 线上 P50/P95 延迟、LoopScope 诊断完整率和 shadow 一致率。

验收要求：单元测试、历史 run 回放、TS 协议测试全部通过；没有未解释的权限扩大、跨轮重复或候选池污染；未达到验收前不得删除旧 ranker。

## 11. 风险与控制

### 11.1 候选池归一化导致分数依赖候选集合

`lexical_norm`、`semantic_norm` 和 confidence 具有候选池相对性。必须冻结候选来源、limit、scope、revision 和排序 tie-break；LoopScope 记录这些上下文，避免跨 run 直接比较绝对分数。

### 11.2 source quality 可能造成来源偏置

乘法公式下 `source_quality` 是分数上界而非加项（最高档 0.8 的来源无论检索多好都到不了 1.0），来源内排序不受先验影响；但跨来源的绝对分差仍由先验决定，且 knowledge（1.0）与 conversation（0.6）之间有 0.4 的天花板差。上线后按来源观察 Hit@K 和拒绝率，不能只看总体平均 conf。

### 11.3 提高阈值导致结果变少

保留 `0.35` fallback，并记录 `preferred_count`、`fallback_count` 和 `rejected_low_score`。如果某类 query 的首选率异常下降，先查召回、tokenizer 和归一化，不直接调低阈值。

### 11.4 把 confidence 当作事实可信度

`confidence` 只是检索相关性质量分，不是知识事实真实性。用户可见文案、Knowledge 事实状态和 LoopScope 字段必须区分两者。

## 12. 开放项

1. embedding 存在时，`semantic_norm` 的归一化方式是否需要单独校准，待 Phase 2 shadow 数据决定。
2. `source_quality` 是否需要按用户/索引类型做配置，暂不在 0.4.0 采用动态配置。
3. fallback 是否长期保留，待 v4 上线后的首选率和空结果率评估。
4. `confidence_v4` 稳定后，再决定是否将字段命中、来源质量和 query match 拆成可配置策略。
5. **阈值重标**：`0.55/0.35` 在 v4 尺度下首选覆盖率偏低（回放中存在首选带为空的 case）；2026-09-10 决策先维持 `0.55` 不变，候选重标方案 `0.50/0.30` 或 `0.45/0.30` 待上线后按首选率数据拍板。
6. ~~无命中硬保护~~ 已关闭（2026-09-10）：实施期确认单候选池 `lexical_norm` 恒为 1，纯乘法会让零命中候选越过首选线，生产实现保留 `match<=0 → value<0.35` 硬保护（见 §6.7）。

## 13. 当前变更边界

2026-09-10：Phase 1-4 已全部实施完毕，v4 为生产评分、v1 为回滚开关。后续变更（semantic_norm 校准、阈值重标、无命中保护去留）按 §12 开放项单独立项，不在本 PRD 内继续累积。
