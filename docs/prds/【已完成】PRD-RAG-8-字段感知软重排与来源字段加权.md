# PRD-RAG-8：全量 Token + IDF 非线性软重排

> 状态：Phase 1/2/3 已完成，待 Phase 4 评估
> 创建：2026-09-09
> 更新：2026-09-09
> 所属层：RAG / TypeScript Worker / Scorer & Ranker
> 前置 PRD：[`PRD-RAG-7-TS全链路检索分阶段迁移.md`](./PRD-RAG-7-TS全链路检索分阶段迁移.md)
> 关联 PRD：[`【已完成】PRD-RAG-6-TypeScript词法检索与评分过滤直接替换.md`](./【已完成】PRD-RAG-6-TypeScript词法检索与评分过滤直接替换.md)
> 关联代码：`backend/ts/workers/rag/src/ranking/`
> 离线验证脚本：`backend/ts/workers/rag/scripts/idf-rescore-from-report.ts`

## 0. 一句话目标

在不改变 BM25/hybrid 召回、权限边界和 `confidence-v1` 过滤契约的前提下，使用完整 TS 索引的 IDF 判断本次查询中各 token 的信息量，对每个 token 的 BM25 贡献进行相对 IDF 加权，再使用 `p=2` 非线性聚合突出高信息 token。

## 1. 背景与问题

### 1.1 当前现状

当前 RAG 已由 TypeScript Worker 承担词法索引、BM25、hybrid 融合、候选评分和统一排序。BM25 已经使用当前完整索引计算 IDF，但现有排序对 query 中多个 token 的贡献主要采用线性累加。

当前链路为：

```text
完整 TS 索引 → BM25 / hybrid 召回 → 来源归一化与融合
→ confidence-v1 → 统一排序、去重和字符预算
```

### 1.2 可复现问题

查询 `蒙扎的 T6 叫什么` 时，Knowledge 实际命中了 `t6`、`蒙`、`扎`、`的`，其中 `t6` 单项贡献最高；但 conversation 命中了 `蒙`、`扎`、`叫`、`什么`，多个贡献线性累加后反而超过 Knowledge。

问题不是召回缺失，而是线性聚合没有充分突出高信息 token，导致“命中更多口语 token”的候选可能压过“命中明确实体”的候选。

## 2. 目标与非目标

### 2.1 目标

1. 使用完整 TS 索引计算 query token 的 IDF，不使用候选子集重新计算 IDF。
2. 保留所有 query token，不使用固定 stopword 表，也不按语言拆分算法。
3. 让 token 的相对 IDF 决定额外权重，高信息 token 获得更高贡献。
4. 对逐 token 加权贡献使用有界非线性聚合，默认指数 `p=2`。
5. 适用于 conversation、knowledge、project、calendar、file、memory 等所有来源。
6. 保留原始融合分、逐 token 贡献和最终排序分，便于 LoopScope 解释排名变化。
7. 通过真实 run 报告和固定 fixture 验证高信息实体与泛词多命中之间的排序差异。

### 2.2 非目标

- 第一阶段不重写 tokenizer、倒排索引、BM25 召回或 hybrid 融合。
- 不按 `source_type`、title、项目名、活动名或 Knowledge 名称写专用加分分支。
- 不删除低 IDF token，不把任何 token 设为硬 MUST 条件。
- 不引入大型语言词典、按语言拆分的 stopword 表或 POS 词性系统。
- 不修改 owner、workspace、project、folder、group/member 等权限校验。
- 不把加权后的分数覆盖现有 `fused_score`，不破坏现有诊断字段含义。
- 不在第一阶段把 `rank_score` 直接用于 `confidence-v1`，也不改变其 `0.35/0.55` 阈值。

## 3. 设计原则

### 3.1 召回、评分、重排分层

现有流程保持不变：

```text
BM25 / hybrid 召回
        ↓
来源归一化与融合
        ↓
现有 confidence-v1 诊断
        ↓
全量 token + 相对 IDF soft-rescore
        ↓
非线性聚合得到 rank_score
        ↓
统一排序、去重、来源上限和字符预算
```

新算法只负责排序信号，不负责权限判断、候选召回或内容过滤。

### 3.2 完整索引 IDF

IDF 必须来自当前 scope/revision 对应的完整 TS 索引：

```text
idf(t) = log(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
```

其中 `N` 是完整索引文档数，`df(t)` 是包含 token `t` 的文档数。不使用当前 Top-K 或候选子集估算 IDF。

### 3.3 查询级相对权重

对 query 去重分词，但不删除 token。只对存在于完整索引中的 token 计算本次 query 的 IDF 基准：

```text
baseline = mean(idf(t))
query_weight(t) = clamp((idf(t) / baseline) ^ idf_exponent, 0.25, 4.0)
```

第一版 `idf_exponent=1`。这一步只决定 token 的相对权重，不重复计算或重复乘一遍 IDF。

## 4. 全量 Token 非线性重排算法

### 4.1 单 token BM25 贡献

对每个候选和每个 query token，使用现有 BM25 参数计算 token 的原始贡献：

```text
norm(t, d) = tf(t, d) + k1 × (1 - b + b × |d| / avgdl)

bm25_term(t, d) =
  idf(t) × tf(t, d) × (k1 + 1) / norm(t, d)
```

默认参数沿用现有 worker：`k1=1.2`、`b=0.75`。

再乘以 query 相对 IDF 权重：

```text
weighted_term(t, d) = bm25_term(t, d) × query_weight(t)
```

### 4.2 非线性贡献放大

对每个 token 的加权贡献做幂函数放大：

```text
nonlinear_term(t, d) = weighted_term(t, d) ^ p
rank_score(d) = Σ nonlinear_term(t, d)
```

第一版固定 `p=2`。这会放大高贡献 token 的差异，同时保留多个 token 的累积效果；不是取最大 token，也不是硬过滤其他 token。

### 4.3 示例

查询 `蒙扎的 T6 叫什么` 的离线结果：

```text
Knowledge：
t6 = 11.929 → 142.308
扎  =  6.361 →  40.468
蒙  =  6.361 →  40.468
的  =  0.155 →   0.024
总分 = 223.267

Curva Biassono：
扎   = 8.504 → 72.311
蒙   = 8.504 → 72.311
叫   = 8.040 → 64.640
什么 = 3.029 →  9.174
总分 = 218.436
```

非线性聚合后，Knowledge 从原来的第 3 位升到第 1 位。

### 4.4 分数语义

```text
fused_score             原始 BM25/hybrid 融合分
normalized_score        来源归一化分
confidence              现有 confidence-v1
weighted_term           非线性前的逐 token 贡献
nonlinear_term          非线性后的逐 token 贡献
rank_score              nonlinear_term 的总和
```

`rank_score` 仅用于排序，不覆盖 `fused_score`，也不直接进入 `confidence-v1`。

## 5. 典型案例

### 5.1 高信息实体查询

查询：

```text
蒙扎的 T6 叫什么
```

高信息 token `t6` 的单项贡献应通过 `p=2` 被显著放大；只命中 `蒙`、`扎`、`叫`、`什么` 的 conversation 不应仅凭命中数量压过明确包含 `t6` 的 Knowledge。

### 5.2 混合语言和标识符

查询：

```text
speedream frontend
```

`speedream`、`frontend`、版本号和其他字母数字标识符与中文 token 走同一 tokenizer、IDF 和非线性贡献路径，不增加语言分支。

### 5.3 泛查询

查询：

```text
最近有什么安排
```

所有 token 仍可参与计算。由于高频 token 的 IDF 相对较低，其贡献自然较小；日程正文、日期和任务内容仍可依靠原始 BM25/hybrid 排到前面，不因未命中某个标题被硬过滤。

## 6. 诊断与 LoopScope

重排诊断必须能够解释高 IDF token 的影响，但不得泄露用户正文：

```json
{
  "scoring_version": "idf-nonlinear-v1",
  "idf_source": "full_ts_index",
  "idf_exponent": 1,
  "contribution_exponent": 2,
  "fused_score": 0.42,
  "confidence": 0.61,
  "rank_score": 223.267,
  "matched_terms": ["t6", "蒙", "扎"],
  "term_contributions": [
    {"term": "t6", "weighted": 11.929, "nonlinear": 142.308}
  ]
}
```

约束：

- 不记录查询原文、候选正文、附件原名、用户昵称、内部路径、密钥或 token；
- 如果线上日志需要关联 token，使用现有 fingerprint/脱敏机制；
- `idf_source`、指数和 `scoring_version` 必须进入 LoopScope 诊断；
- 算法版本变化时，必须同步测试、回放报告和协议诊断。

## 7. 实施分期

### Phase 0：离线算法与基线

- [x] 使用完整 TS 索引计算 IDF。
- [x] 保留全部 query token，不做 token 过滤。
- [x] 增加逐 token BM25、相对 IDF 和非线性贡献的离线报告。
- [x] 增加 `--contribution-exponent` 参数，支持 `p=1` 与 `p=2` 对比。
- [x] 用 `蒙扎的 T6 叫什么` 验证 Knowledge 从第 3 位升至第 1 位。

### Phase 1：生产 scorer/ranker 接入

- [x] 在 `backend/ts/workers/rag/src/ranking/` 收敛 scorer 与 ranker 的非线性算法实现。
- [x] 保留完整索引 IDF 统计，禁止从 Top-K 候选重新估计 IDF。
- [x] 保持召回、权限、scope、去重、来源限制和字符预算不变。
- [x] 将 `rank_score` 接入排序，但保留 `fused_score`、`normalized_score` 和 `confidence-v1`。
- [x] 增加非线性排序 fixture；现有 BM25-only、hybrid、无向量和多来源协议测试继续覆盖边界。

### Phase 2：离线回放与 shadow

- [x] 对真实 run 执行 `p=1` 与 `p=2` 对比，统计 Top-1/Top-3 变化。
- [x] 通过逐项贡献和完整内容报告检查高 IDF 单 token、泛词多 token 与正文长度归一化的排序变化。
- [x] 复核泛查询样本，未发现仅凭单个偶然高 IDF token 把无关候选抬到 Top-1 的情况；保留 bounded 权重作为风险边界。
- [x] 生产链保留 `rescore_version`/`idf_source`/`contribution_exponent` 诊断；未完成 devserver 核验前不宣称最终启用。

### Phase 3：devserver 验证与启用

- [x] 使用固定账号、固定 scope 和固定 index revision 验证冷/热索引。
- [x] 验证 BM25-only、hybrid、embedding 不可用和索引重建场景。
- [x] 检查 LoopScope 同时展示原始分、confidence、逐 token 贡献和 rank_score。
- [x] 通过回放和人工核验后，默认启用 `p=2`。

### Phase 4：后续评估

- [ ] 评估 `p=1.5`、`p=2`、`p=2.5` 的稳定性，不直接扩大指数。
- [ ] 如果 rank_score 需要参与过滤，另立 confidence-v2 PRD，不在本 PRD 中静默改变阈值。
- [ ] 只有在单 token 信息仍不足时，才重新评估 BM25F 或字段索引，不提前引入字段专用分支。

## 8. 验收标准

### 8.1 正确性

- 完整索引 IDF 与 BM25 使用同一 scope/revision。
- 所有 query token 都可以参与评分；未索引 token 不产生异常或 NaN。
- 高 IDF token 的单项贡献在 `p=2` 下得到稳定放大。
- 多个低信息 token 的线性累加不能轻易压过明确实体 token 的合理匹配。
- 具体实体查询中，正确 Knowledge/项目/活动/文件可以因命中实体而升序，但不依赖 `source_type` 硬编码。
- 没有命中高信息 token 的候选仍由原始 BM25/hybrid 决定，不被硬删除。

### 8.2 稳定性

- 现有 BM25、hybrid、权限、scope、去重、来源上限和字符预算测试全部通过。
- `fused_score`、`normalized_score` 和 `confidence-v1` 含义不变。
- 同一 query、scope、revision、候选集和参数下排序确定性一致。
- 非线性计算失败时显式报告错误，不静默把候选变成零分或无限分。
- 分数过大时仍使用有限权重、有限指数和稳定浮点计算。

### 8.3 质量指标

至少记录：

- 具体实体查询的目标对象 Top-1/Top-3 命中率；
- 高 IDF 单 token 命中候选的平均排名变化；
- 泛词多 token 候选的误抬高率；
- 泛查询的排序变化率和误伤率；
- `p=1` 与 `p=2` 的首个差异位置；
- BM25-only 与 hybrid 两种模式下的排序稳定性。

## 9. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 非线性指数过大 | 单个偶然 token 过度支配排序 | 第一版固定 `p=2`，离线比较后再调参 |
| query 中存在 typo/随机串 | 罕见 token 获得过高 IDF | 记录高 IDF 命中案例，后续增加实体确认或上限，不先做硬过滤 |
| 泛词多 token 仍然累计较高 | 具体实体没有稳定上升 | 比较 `p=1`/`p=2`，必要时评估 top-contribution 聚合 |
| 文档长度归一化影响过强 | 长 Knowledge 被系统性压低 | 保持 BM25 参数不变，单独统计长度分布后再调参 |
| IDF 语料范围错误 | 分数不可解释、跨 scope 漂移 | 绑定 index revision 和完整语料统计，禁止候选池 IDF |
| rank_score 与 confidence 混用 | 过滤阈值行为变化 | 第一阶段明确分离，另立 confidence-v2 |
| 分数数值膨胀 | 诊断和序列化不稳定 | 指数和权重 bounded，使用有限浮点并记录版本 |

## 10. 当前结论

采用以下排序算法作为 RAG-8 第一版生产目标：

```text
完整 TS 索引 IDF
  ↓
BM25 单 token 贡献
  ↓
相对 query IDF 加权
  ↓
逐 token p=2 非线性放大
  ↓
求和得到 rank_score
  ↓
排序
```

离线真实索引验证表明，`蒙扎的 T6 叫什么` 中 Knowledge 文档能够从第 3 位升到第 1 位，说明该算法可以突出 `t6` 这类高信息实体，同时保留 `蒙`、`扎` 等辅助命中。

Phase 1 已接入生产 scorer/ranker，Phase 2 已完成 12 条真实查询的 p=1/p=2 shadow 回放；报告显示 Top-1 变化 4/12、Top-3 集合变化 11/12，`蒙扎的 T6 叫什么` 的 Knowledge 结果由第 3 位升至第 1 位。Phase 3 已在 devserver 完成固定 revision 的冷/热索引、BM25-only、hybrid、embedding 不可用与索引重建验证；LoopScope 受控 trace 同时记录 `fused_score`、`confidence`、`rank_score`、IDF 基线和逐 token 贡献，生产默认使用 `p=2`。后续仅保留 Phase 4 的参数稳定性和过滤策略评估。
