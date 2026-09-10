# 2026-09-10 knowledge 向量接入 hybrid 融合与 conf-v4 定稿验证

## 背景

PRD-TS-RAG-0.4.0 conf-v4 算法定稿期间，用诊断探针重放真实 LoopScope run 做
embedding+hybrid 观察，发现 knowledge 来源候选的 embedding 列全部为空。
排查结论是三层叠加问题，全部修复并随 PR #53 提交（dbc3ff8d1 + f2b64bb00）。

## 三层问题与修复

### ① 向量缓存键写/召回失配

- 旧键 `rag:{source_id}:{content_hash}`：knowledge 召回侧的 IndexDocument.content
  是 TS 排名文本（title+summary+content 拼接），与写侧正文长度都不同（619 vs 603），
  hash 永远不一致 → 缓存键静默失配，knowledge 向量"只写不读"。
- **教训：不能把 content_hash 揉进缓存键**——写侧与召回侧的 content 构建路径不同，
  hash 天然不可比。改用 `rag:{chunk_id}`（`parent:version:chunk_index`），两侧构建
  路径一致（memory 语料 486/486 全部同键验证）；条目新增 `h` 字段存 content_hash，
  同版本改内容仍会触发重嵌，内容变更失效语义不回退。

### ② 生产查询链只有 memory 接入融合

- 原 `unified_query` 只对 memoryGroup 用瞬态槽向量做 RRF；`hybrid_fuse` op 是零调用
  脚手架；`_load_cached_vectors` 的 knowledge 分支无生产消费方。
- 修复为**持久向量通道**：`index_cache._persistent_vectors` 每次索引构建整表收集
  knowledge 等持久来源缓存向量（memory/pattern 除外，控制 IPC 体量），随 replace/patch
  搭载；worker 侧 `applyVectorMap` 整表替换 + `vector_version` 落盘 index.json；
  unified_query 融合循环从仅 memory 扩到全部来源组。
- **版本戳守卫**：Python 查询时带当前 `embedding.model_tag()`，与 worker 驻留表
  `vectorVersion` 不一致（换 embedding 模型窗口）时非 memory 组降级纯词法——宁缺勿错，
  不会用跨模型脏向量。旧 Python（不带 vector_version）自动走原行为，双向兼容。

### ③ v4 语义混合进排序器

- 语义混合此前只存在于探针；生产 v4 confidence 用纯词法 rank_score，融合分不进公式。
- worker `normalizeV4Lexical` 增加：候选池内 `semantic_norm = cosine / 池最大 cosine`
  （池最大 ≤ 0 整体退纯词法；归一为负的候选钳 0），有语义的候选把 v4 词法位替换为
  `0.45*lexical_norm + 0.55*semantic_norm`，与探针 `apply_confidence_v4` 逐位一致。
- 契约：`RagRankCandidate` 增可选 `semantic_score`（原始余弦），`RagRankResult` 增
  可选 `semantic_norm`（诊断可见）。

## 冻结契约发现（重要，别再踩）

实现时发现 `selectUnifiedRecall` 内部按 rank_score 降序重排交付顺序，会覆盖 v4
confidence 排序。尝试改为按 confidence 排序触发了"冻结契约"测试——**交付顺序
（fused 降序 + id 升序）是有意锁定的行为**：SOURCE_PRIORITY 只决定 confidence 入选
顺序，语义混合只通过 confidence 影响入选集合与 band，不改变交付顺序。改动已回退。

## 验证

- 本地：TS worker 49/49（新增持久向量协议测试：整表搭载、版本戳一致融合、版本戳
  不一致降级、patch 整表自清理、池级语义归一）；Python 全量 2394 passed。
- devserver：同步代码 + esbuild 重建 bundle + 向量缓存全量重嵌（换键全量重嵌
  memory 344 + knowledge 9）+ 重启 backend，重跑两个 run 的 hybrid/noemb A/B：
  - knowledge 候选语义命中：06:48 run 1 例、14:36 run 5 例（修复前两 run 均 0），
    验收案例（F1 赛道知识）emb-cos=0.667、sem-norm=0.857、conf-v4 +0.234、
    band fallback→preferred、v4 入选=是。
  - 端到端实证：直接调 `UnifiedQueryRetriever` 返回 `fusion: hybrid-rrf`、
    `fallback: None`，rank_rows 携带 semantic_norm——生产链路真实生效，不只是探针侧。
  - 生产 v1 链路两份对照完全相同（不回归）。
- 遗留风险：弱相关候选被语义分拉入 preferred 的过注入倾向（两 run 合计 21 例
  fallback→preferred），候选方案=hybrid 开启时提高 fallback band 下限或引入配额，
  待观察真实对话效果再定。

详细数据与非脱敏报告在 gitignored 的 `backend/scripts/diagnostics/local/`
（`hybrid-ab-摘要-修复验证-20260910.md` 及四份 `*-fix-20260910.md`）。

## 部署注意

- 换键后旧向量缓存条目由 sync 的 alive 集清理；生产发版后首次索引构建会自动
  重嵌（或提前跑 warm 脚本）。
- 旧版 index.json（无向量字段）可正常 restore；首次 replace/patch 自动搭载向量表。
- 测试桩同步：FakeSidecar.replace/patch 与 unified_query stub 需带
  `vectors`/`vector_version` 关键字参数。
