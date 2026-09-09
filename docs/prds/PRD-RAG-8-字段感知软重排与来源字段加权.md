# PRD-RAG-8：字段感知软重排与来源字段加权

> 状态：待实施
> 创建：2026-09-09
> 所属层：RAG / TypeScript Worker / Scorer & Ranker
> 前置 PRD：[`PRD-RAG-7-TS全链路检索分阶段迁移.md`](./PRD-RAG-7-TS全链路检索分阶段迁移.md)
> 关联 PRD：[`【已完成】PRD-RAG-6-TypeScript词法检索与评分过滤直接替换.md`](./【已完成】PRD-RAG-6-TypeScript词法检索与评分过滤直接替换.md)
> 关联代码：`backend/ts/workers/rag/src/ranking/`

## 0. 一句话目标

在不替换现有 BM25/hybrid 召回、不改变权限边界和 `confidence-v1` 过滤契约的前提下，让项目名、活动标题、Knowledge 标题和 Knowledge 关键词等高信息字段获得可解释的软加权，同时让只命中正文、未命中这些字段的候选得到有限降权。

## 1. 背景与问题

### 1.1 当前现状

当前 RAG 已由 TypeScript Worker 承担词法索引、BM25、hybrid 融合、候选评分和统一排序。`RagDocument` 已经包含 `title`、`summary`、`text` 和 `metadata`，不同来源的业务字段在索引投影阶段已经落入这些字段：

| 来源 | 高信息字段 | 当前映射 |
|---|---|---|
| project | 项目名 | `document.title` |
| calendar | 活动标题 | `document.title` |
| scheduled_task | 定时任务名 | `document.title` |
| knowledge | Knowledge 标题 | `document.title` |
| knowledge | Knowledge 关键词 | `document.metadata.keywords` |
| file | 文件名 | `document.title` |

这些字段同时也可能被拼进统一检索文本，因此当前 BM25 会把它们当作普通正文的一部分处理。字段本身的“对象身份”价值没有被单独表达。

### 1.2 可复现问题

当用户查询一个具体项目或实体时，正文中包含泛化词的其他候选可能获得较高 BM25 分。例如查询 `speedream` 时，真正的项目名命中应该明显优先于只在正文中出现“设计”等泛化词的文件或 Knowledge。

但不能简单规定“没有命中标题就排除”：

- “今天有什么安排”可能只命中日程正文或日期字段；
- “之前讨论过缓存问题吗”可能只命中会话、Memory 或 Knowledge 正文；
- “帮我看看项目”本身缺少稳定实体，标题未命中不能成为硬过滤条件。

因此需要的是基于查询具体程度的软重排，而不是来源硬优先级或标题硬过滤。

## 2. 目标与非目标

### 2.1 目标

1. 为项目名、活动标题、Knowledge 标题和 Knowledge 关键词提供独立、可解释的匹配信号。
2. 对高辨识度查询提高名称/关键词命中的候选排序；对只命中正文的候选有限降权。
3. 保持当前 BM25、hybrid、权限、scope、去重、字符预算和 `confidence-v1` 的既有语义。
4. 将原始融合分、字段匹配分、字段调整因子和最终排序分分开记录，便于 LoopScope 解释排名变化。
5. 让中文、英文、数字、混合实体和 i18n 查询使用同一套字段匹配逻辑，不维护按语言分裂的算法分支。
6. 通过真实 run 报告和固定 fixture 调参，避免凭单个案例直接放大权重。

### 2.2 非目标

- 第一阶段不重写 BM25，也不把该方案做成完整 BM25F 索引重构。
- 不在 `source_type=project/calendar/knowledge` 时无条件整体加分；只有字段实际命中才加权。
- 不把标题未命中作为硬过滤，不把正文命中结果直接删除。
- 不在第一阶段引入大型语言词典、按语言拆分的 stopword 表或 POS 词性系统。
- 不修改 owner、workspace、project、folder、group/member 等权限校验。
- 不把加权后的分数覆盖现有 `fused_score`，不破坏现有诊断字段含义。
- 不在第一阶段改变 `confidence-v1` 的 `0.35/0.55` 阈值。

## 3. 设计原则

### 3.1 基础召回与字段重排分层

现有流程保持不变：

```text
BM25 / hybrid 召回
        ↓
来源内归一化
        ↓
字段感知 scorer
        ↓
rank_score
        ↓
ranker 排序
        ↓
现有 confidence、去重、预算和输出选择
```

字段加权是候选重排信号，不是权限判断，也不是新的召回来源。

### 3.2 只对高信息字段加权

字段信号按“这个字段是否说明候选对象就是用户要找的对象”定义：

| 字段 | 初始权重 | 说明 |
|---|---:|---|
| project.name / `title` | 1.00 | 项目身份字段 |
| calendar.title / `title` | 1.00 | 活动身份字段 |
| knowledge.title / `title` | 1.00 | Knowledge 身份字段 |
| knowledge.keywords | 0.90 | 人工或系统维护的显式关键词 |
| scheduled_task.name / `title` | 0.90 | 任务身份字段 |
| file.name / `title` | 0.90 | 文件身份字段，作为同一机制接入 |

正文仍由现有 BM25 处理，不因为正文属于某种来源而额外加分。

### 3.3 软加权和软降权

字段匹配因子必须有明确上下界：

```text
没有明显字段信号       约 1.00
只命中正文             0.88 ~ 0.98
字段部分命中           1.05 ~ 1.18
字段高覆盖命中         1.25 ~ 1.35
完整查询命中身份字段   1.40 ~ 1.50
```

具体因子还要乘以查询具体程度。泛查询的调整幅度更小，避免“今天安排”被名称字段支配；实体查询的调整幅度更大，避免“speedream”被无关正文结果稀释。

## 4. 字段匹配算法

### 4.1 查询与高信息字段分别分词

当前 BM25 对组装后的 `document.text` 统一分词，标题、文件名和关键词只是作为正文的一部分参与检索。字段 scorer 不复用这个混合文本作为字段信号，而是先对查询和每个高信息字段独立分词：

```text
query
 ├─ query_tokens
 └─ normalized_query_phrase

title / project name / activity title
 ├─ title_tokens
 └─ normalized_title_phrase

file name
 ├─ filename_tokens
 └─ normalized_filename_phrase

knowledge keywords
 ├─ keyword_tokens
 └─ normalized_keyword_phrases
```

字段匹配至少支持：

1. 规范化后的完整短语命中；
2. 加权 token 覆盖率命中；
3. 单 token 部分命中。

所有字段复用当前统一 tokenizer，不为中文、英文、日文或混合查询增加独立算法分支。字段 scorer 不做词性分析，也不依赖按语言拆分的词库。

规范化只用于比较，不改变原始文档正文：

- Unicode 大小写归一化；
- 合并可忽略空白；
- 将 `-`、`_`、`.`、空格等文件名连接符作为 token 边界；
- 关键词字段额外按 `、`、逗号、分号和 `#` 等分隔符切分；
- 保留数字、版本号、项目标识符和中英文实体。

字段 scorer 的内部输入应能表达以下结构：

```ts
{
  queryTokens,
  titleTokens,
  filenameTokens,
  keywordTokens,
  exactTitleText,
  exactFilenameText,
}
```

文件名示例：

```text
F1蒙扎-排位赛-圈速差距图-本地-v5.png
```

应保留并分别识别类似以下 token：

```text
F1、蒙扎、排位赛、圈速、差距、图、本地、v5
```

文件扩展名默认不参与字段权重；只有用户明确查询 `.png`、`.svg` 等扩展名时，才允许作为普通 token 参与匹配。文件路径不得进入字段 scorer。

### 4.2 加权字段匹配分

对每个候选计算字段覆盖率：

```text
title_match   ∈ [0, 1]
keyword_match ∈ [0, 1]
```

字段匹配分不简单相加，避免标题和关键词重复表达同一信息时被双重放大：

```text
identity_match =
  1 - (1 - title_match) × (1 - 0.90 × keyword_match)
```

对于没有关键词字段的来源，使用 `title_match`；对于项目、日程、任务和文件，`title_match` 是主要身份信号。

完整查询短语命中标题时，`title_match` 直接接近 `1.0`；只有一个泛化 token 命中时，保持较低的部分覆盖分。

### 4.3 查询具体程度

查询具体程度用于控制字段加权幅度，不作为独立过滤器。优先使用当前 BM25 语料已有的 IDF 统计：

```text
query_specificity =
  clamp(查询有效 token 的信息量聚合结果, 0, 1)
```

建议聚合方式：

- 稀有实体、项目标识符、版本号、混合字母数字词提高具体程度；
- 在语料中高频的泛词降低具体程度；
- 查询只有泛词时保持低具体程度；
- 查询中出现未知但稳定的实体 token 时，不因没有历史 df 而把它当作无信息词。

第一阶段可以先复用现有 IDF 和 token 特征生成稳定的 bounded 值；不要在 scorer 中重复计算或再次乘一遍 IDF。

### 4.4 初始字段因子

推荐的初始形式：

```text
field_adjustment =
    +0.35 × identity_match
    -0.12 × (1 - identity_match)

field_factor =
    1 + query_specificity × field_adjustment
```

边界示例：

| 查询具体程度 | 字段匹配 | 因子效果 |
|---:|---:|---:|
| 1.0 | 1.0 | 1.35 |
| 1.0 | 0.5 | 1.105 |
| 1.0 | 0.0 | 0.88 |
| 0.3 | 1.0 | 1.105 |
| 0.3 | 0.0 | 0.964 |

完整短语命中身份字段时，可在不超过 `1.50` 的总上限内增加一次 exact phrase bonus。所有因子最终必须经过 clamp，禁止由单个字段命中产生无限放大。

### 4.5 最终排序分

第一阶段不修改原始融合分：

```text
base_score = candidate.fused_score
rank_score = base_score × field_factor
```

排序和后续候选顺序使用 `rank_score`。以下字段保持原语义：

```text
fused_score       原始 BM25/hybrid 融合分
normalized_score  来源归一化分
rank_score        字段感知重排分
field_factor      本次字段调整因子
field_match       身份字段匹配分
field_hits        命中的字段名称
```

如果后续确认字段分也应参与置信度，再单独设计 `confidence-v2`；不得在第一阶段静默把 `rank_score` 塞进现有 `confidence-v1`。

## 5. 典型案例

### 5.1 具体项目查询

查询：

```text
我再看看 speedream 前端设计
```

候选 A：项目名 `speedream前端设计`

```text
正文 BM25       正常
项目名命中      高覆盖
field_factor    约 1.25 ~ 1.40
```

候选 B：文件名 `新手引导设计`

```text
正文 BM25       可能有分
身份字段命中    0 或很低
field_factor    约 0.88 ~ 0.98
```

候选 B 不会被删除，但在 BM25 接近时应自然落到候选 A 后面。

### 5.2 Knowledge 标题和关键词

查询：

```text
Monza corner
```

Knowledge 标题命中 `Monza`、关键词命中 `corner` 时，标题和关键词联合形成高 `identity_match`；只有正文中提到其中一个词的其他 Knowledge 不获得同等加权。

### 5.3 泛查询

查询：

```text
最近有什么安排
```

即使没有命中某个活动标题，也只产生轻微降权。日程正文、日期和任务内容仍可依靠原始 BM25 排到前面。

## 6. 诊断与 LoopScope

字段重排必须可解释，但诊断不得泄露用户正文。每个候选只记录必要的结构化信息：

```json
{
  "scoring_version": "field-v1",
  "base_score": 0.42,
  "field_match": 0.86,
  "query_specificity": 0.91,
  "field_factor": 1.29,
  "rank_score": 0.54,
  "field_hits": ["title", "keywords"]
}
```

约束：

- 不记录查询原文、正文、附件名、用户昵称、内部路径、密钥或 token；
- `field_hits` 只允许固定字段枚举，不写入字段值；
- 保留 `fused_score` 和 `rank_score`，方便定位是召回分问题还是重排问题；
- `scoring_version` 变更时必须同步测试和 LoopScope 诊断契约。

## 7. 实施分期

### Phase 0：离线基线与测试数据

- [ ] 固定当前 `speedream`、Knowledge 标题/关键词、日程、泛查询和正文误命中案例。
- [ ] 从已有 LoopScope 报告提取候选 ID、原始分、来源和当前排序，正文只保存在本地受控诊断目录。
- [ ] 增加 scorer 单测，覆盖完整命中、部分命中、只命中正文、空字段和混合语言。
- [ ] 明确 `field_factor` 的上下界和 `rank_score` 的排序契约。

### Phase 1：字段 scorer

- [ ] 在 `src/ranking/` 实现字段匹配、查询具体程度和 bounded factor。
- [ ] 保留 `fused_score`、`normalized_score` 和 `confidence-v1` 原逻辑。
- [ ] 在 ranker 中接入 `rank_score` 排序，不改变权限、去重和字符预算。
- [ ] 更新 TypeScript contract、Python bridge 和 LoopScope 诊断字段。

### Phase 2：离线回放与 shadow

- [ ] 对真实脱敏 run 执行旧排序与新排序对比。
- [ ] 统计 Top-1/Top-3 变化、字段命中率、正文-only 候选降权比例和泛查询误伤率。
- [ ] 未达到验收标准前只记录 shadow 结果，不切生产排序。

### Phase 3：devserver 验证与小范围启用

- [ ] 使用 devserver 固定账号和固定索引 revision 验证冷/热索引、BM25-only、hybrid 和空关键词场景。
- [ ] 检查 LoopScope 能否同时看到 `fused_score` 与 `rank_score`。
- [ ] 通过后再决定是否启用默认字段重排。

### Phase 4：后续评估

- [ ] 根据回放结果决定是否把字段信号纳入 confidence。
- [ ] 若需要，另立 `confidence-v2` 变更，明确阈值迁移和兼容策略。
- [ ] 只有在 post-rescore 信号不足时，才评估真正的 BM25F 多字段索引；不提前引入索引重建成本。

## 8. 验收标准

### 8.1 正确性

- 具体项目名命中时，对应项目在同等基础分下优先于只命中正文的文件或 Knowledge。
- Knowledge 标题/关键词命中时，相关 Knowledge 获得加权；只有正文命中时不获得同等加权。
- 活动标题命中时，活动优先；查询日期、时间或安排等泛词时，不能因为标题未命中而过滤日程。
- 没有字段命中的候选仍可保留，只受到 bounded 软降权。
- 空标题、空关键词、未知来源和旧索引数据不会导致异常或 NaN 分数。

### 8.2 稳定性

- 现有 BM25、hybrid、权限、scope、去重、父级限制和字符预算测试全部通过。
- `fused_score` 的含义保持不变。
- `confidence-v1` 阈值和结果契约保持不变，除非另立版本迁移。
- 同一 query、revision、候选集和配置下排序结果确定性一致。
- 字段重排失败时必须显式记录错误类别，不得静默把所有候选变成高分或零分。

### 8.3 质量指标

第一阶段先使用离线回放和人工核验，不设未经基线验证的绝对线上指标。至少记录：

- 具体实体查询的目标对象 Top-1/Top-3 命中率；
- 正文-only 候选的平均降权幅度；
- 字段命中候选的平均提升幅度；
- 泛查询的排序变化率和误伤率；
- 新旧排序的首个差异位置及候选来源。

## 9. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 标题字段过度加权 | 泛查询被项目/Knowledge 名称霸榜 | 使用 query_specificity 控制幅度，保持因子上限 |
| 关键词重复计分 | Knowledge 被重复抬高 | 使用递减合并，不简单相加 |
| source normalization 掩盖字段效果 | 真实跨来源提升不明显 | 在现有归一化后的基础分上做 bounded rescore，并记录诊断 |
| hybrid 分数尺度差异 | 不同融合模式下因子效果不同 | 保留原分数，分别在 BM25-only/hybrid fixture 校准 |
| confidence 与 rank_score 混用 | 阈值行为不可解释 | 第一阶段只用 rank_score 排序，保留 confidence-v1 |
| 语言或 tokenizer 差异 | 中英文混合查询结果不稳定 | 复用统一 tokenizer，测试混合实体，不按语言复制算法 |
| 字段缺失或旧索引 | 重排结果异常 | 字段缺失按无字段信号处理，不伪造命中 |

## 10. 当前结论

采用“现有融合分 + 字段感知 bounded soft-rescore”的方案作为第一版。先验证项目名、活动标题、Knowledge 标题/关键词对具体查询的排序收益，再决定是否扩展到 confidence 或真正的 BM25F 多字段索引。

第一阶段的成功标准不是让所有标题命中结果都排第一，而是让高辨识度查询中的身份字段命中成为稳定、可解释的强信号，同时保留正文检索对泛查询和描述性问题的召回能力。
