# OPT：Memory prepare 与独立 BM25 复测

> 测试/排查日期：2026-10-31
> 测试/排查环境：devserver 授权账号只读 A/B；本地隔离测试环境
> 测试/排查对象：Cython RAG Memory prepare 与 BM25 查询内核
> 测试/排查目的：复测最近的 Memory 预处理优化，独立比较 BM25 查询性能，并验证可安全实施的额外优化

---

## 1. 结论

- 真实端到端探针发现并修复 daily 长记忆后续 chunk 漏注原记录摘要的问题。修复后 40 条分层真实 query 的完整响应一致率 **100%**，8 个来源的 lexical 次序/分数、Memory wire 对照和 IDF 指标全部一致；最大 rank 浮点差为 `4.55e-13`。
- 初始最新 devserver 复测：Cython Memory prepare **1.810 s**、TS **0.706 s**；Cython warm query P50/P95 **57.859/94.601 ms**，TS **116.479/191.149 ms**。TS Memory prepare 受运行环境波动明显，前后观测为 0.706–7.633 s，因此单次值不应解释成稳定冷/热缓存差异。
- Memory 向量映射改为单遍校验并保留有效 float 列表引用；全链路实际时延从先前 1.826 s 到本轮 1.810 s，变化在测量波动范围内，暂不能声称有显著端到端提速。采样 profile 中对应 helper 的成本很高，但 profiler 本身放大了 Python 循环开销。
- 后续端到端复测继续按已验证边界优化：已验证向量映射不重复扫描维度；内容寻址 revision 直接短路 transient 指纹计算。相同负载下 Memory prepare 从前次 1,809.53 ms 降至 1,279.88 ms（约 29.3%），TS 本轮为 782.51 ms；只代表本轮观测，仍需重复批次确认稳定收益。
- RAG 回归串行结果为 **357 passed**，2 个第三方弃用警告；额外聚焦测试 **69 passed**。
- 独立 BM25 基准中，命中集遍历优化将 Cython warm query 中位数从 **0.0717 ms** 降到 **0.0527 ms**（约 **26.5%**）；与 Python 字典基线相比快约 **2.04×**，但 TS 基准中位数 **0.0292 ms**，仍约快 Cython **1.81×**。
- 所有合成查询的 Python/Cython Top-K 次序一致，BM25 分数误差不超过 `1e-12`。这组 benchmark 的 TS 与 Cython 使用不同索引容器，仅用于该合成负载下的性能参考，不代表生产端到端结果。

## 2. Memory prepare 复测

### Snapshot 覆盖过滤微基准

| 文档数 | Snapshot 字符数 | 逐文档重复预处理中位数 | 共享预处理中位数 | 加速比 |
| ---: | ---: | ---: | ---: | ---: |
| 300 | 15,914 | 75.676 ms | 4.506 ms | 16.79× |

微基准固定同一批文档和 snapshot，重复 9 轮取中位数。旧路径对每篇文档都重新规范化并 UTF-16 编码 snapshot；新路径只预处理一次，再复用编码上下文。完整 Memory prepare 还包括数据库读取、分词、索引构建及安装，不能把上述加速比外推到全链路。

### 并发与回归

- 独立 owner/group/member scope 的 Memory 文档读取受并发上限约束，聚合结果仍按输入顺序输出；行为测试通过。
- Snapshot 覆盖判断继续保留空白归一、UTF-16 语义和空输入边界；行为测试通过。
- `PYTHONPATH=. .venv/bin/pytest -q tests/agent/rag`：**357 passed, 2 warnings, 35.91 s**。最终修改后串行执行。

### 真实 Memory/RAG 端到端探针

同一授权 owner 只读数据，TS 与 Cython 各自从数据库加载持久索引并准备 transient Memory。40 条 query 按 8 个 RAG 来源轮转，包含每来源 4–6 条，TS/Cython 各 3 轮；用相同确定性合成向量验证 Hybrid/RRF，不调用 embedding provider。持久索引 6,150 文档，transient Memory 2,458 文档；Memory 全部 wire projection 对照 960 个共享候选。

| 指标 | Cython | TS | 说明 |
| --- | ---: | ---: | --- |
| Memory prepare | 1,809.53 ms | 705.98 ms | 同一轮端到端探针；准备步骤本身 |
| 持久索引冷加载/重建 | 5,623.32 ms | 6,972.40 ms | 不含一次性 Cython extension 首编译 |
| Snapshot restore / 索引加载 | 1,404.08 ms | — | Cython 31.69 MB 快照；TS 本轮走自身索引加载 |
| Warm unified query P50 | 57.859 ms | 116.479 ms | 每 query 3 轮，TS 含 worker IPC |
| Warm unified query P95 | 94.601 ms | 191.149 ms | 同上 |
| Architecture peak RSS 比值 | 0.9491 | 1.0 | Cython 进程峰值 / Python 基线加 TS worker 峰值估算 |

完整响应、Top-K、fallback 和来源命中完全一致；各来源 lexical 候选次序和分数一致，rank IDF term agreement 为 100%，最大 rank 浮点差为 `4.55e-13`。两端 relevant-source hit rate 均为 97.5%。当前样本不含真实 query embedding，Hybrid 向量为合成回放，不能代表真实 embedding 质量或 provider 延迟。

首次探针发现：daily 记录大于单 chunk 时，TS 会在不再以原文摘要开头的后续 chunk 中附加 summary；Cython 对 daily 一律省略，导致 39 条 `text` 不同、Memory lexical 排序统计漂移及 40/40 完整响应不一致。修复后同一负载重复探针为 40/40 完整响应一致、960/960 Memory wire 字段一致、lexical score delta=0。

端到端 profile 的下一个候选热点是 `rank_candidates`：一次采样累计约 54.6 ms，其中 `_merged_statistics` 约 23 ms、历史内容 hash/正则规范化约 16–17 ms、query match 约 9 ms。它们是 query 路径下一步优化候选；应继续保留同一真实 query 集做 A/B，不能从 profile 累计时间直接推断每次生产请求固定成本。

单独对 Cython `prepare_memory` 做 cProfile 时，`_worker_vector_map` 约 2.77 s、约 251.9 万次元素检查；`replace_transient` 约 0.86 s，Memory CSR 构建约 0.77 s，向量读取约 0.30 s。采样本身把该次 prepare wall time 放大到约 4.38 s（未采样约 1.81 s），所以这些是定位线索而非分段绝对成本。前次映射校验已合并为单遍，但未采样完整 prepare 的前后差异只有约 16 ms，尚未超过自然抖动。

### Memory prepare 后续优化复测

针对上述调用栈实施两项局部优化：

1. `_read_vectors` 通过 Cython 校验器已保证缓存向量每一维均为有限数值；之后 chunk-slot 映射显式标记为已验证，不再重复遍历 2,458 个向量的所有维度。未验证入口仍保留原有严格检查。
2. `prepare_memory` 的 transient revision 是对完整文档可见状态与 vector version 计算的 SHA-256 截断值。将它标记为内容寻址后，revision 变化才重建索引，且不再另算每文档 `_lexical_fingerprint`；通用调用默认仍走原指纹和文档比较。

同一真实 owner、相同 40 条分层 query、3 轮查询、合成向量回放复测：

| 指标 | 优化前最近一轮 | 优化后本轮 | 变化/对照 |
| --- | ---: | ---: | --- |
| Cython Memory prepare | 1,809.53 ms | 1,279.88 ms | 降低约 29.3% |
| TS Memory prepare | 705.98 ms | 782.51 ms | 本轮 TS 对照；此前观测波动大 |
| Cython warm query P50/P95 | 57.859/94.601 ms | 51.190/102.258 ms | P50 改善、P95 波动；不能据单轮判断变化 |
| 完整召回响应一致 | 40/40 | 40/40 | 保持 100% |
| Memory wire 候选一致 | 960/960 | 960/960 | 保持 100% |
| Lexical 次序/分数一致 | 100% / delta 0 | 100% / delta 0 | 保持完全一致 |

这次 prepare 降幅明显大于之前单遍向量校验改造，但仍是单轮真实数据 A/B，尚不能排除缓存/运行时抖动。与 TS 本轮相比仍慢约 1.64×；下一步应先为 Cython 与 TS 的 Memory prepare 获取同口径阶段计时（scope 文档读取、快照过滤、向量 Storage 读取/解析/匹配、transient revision、索引安装），再针对最大差异段优化。完整召回、lexical、IDF 和向量融合对照全部通过；未调用 embedding provider，未写业务数据。

### Memory prepare 阶段复测与不可变向量共享

继续拆分后发现：冷 prepare 中 Cython 的 transient 索引构建/安装是主要差距（约 609 ms，TS 约 258 ms）；向量 Storage 读取与匹配两端接近（Cython 466 ms，TS 411 ms）。进入已缓存的 warm prepare 后，transient revision 相同会跳过索引重建，剩余主要开销转为向量读取/匹配。

向量文件解析缓存保存的是不可变 tuple，但安装 transient state 时此前仍将每个向量逐维复制成 list。现在保留 tuple 引用；对可变 list 输入仍复制，避免外部变更污染引擎状态。40 条分层真实索引查询、两端 3 次 warm prepare 的复测结果：

| 指标 | Cython | TS | 观察 |
| --- | ---: | ---: | --- |
| 首次 Memory prepare | 1,164.78 ms | 723.40 ms | Cython 首次构建索引，TS 也含首次安装 |
| transient 索引安装阶段 | 608.68 ms | 258 ms | Cython 冷建仍慢约 351 ms，是剩余明确热点 |
| warm prepare P50/P95 | 436.58/483.12 ms | 416.93/520.23 ms | P50 约慢 4.7%，P95 更快；本轮小样本，接近测量波动 |
| Warm unified query P50/P95 | 51.61/91.83 ms | 113.17/191.98 ms | Cython 约快 2.19×/2.09× |
| 完整响应 / Top-K 顺序一致 | 40/40 | 40/40 | 完全一致 |

本轮 960/960 Memory wire 候选一致；8 类来源的 lexical 候选集、次序和分数全部一致，IDF term agreement 100%，最大 rank 浮点差 `4.55e-13`。未请求 embedding provider。tuple 共享后 warm prepare P50 从上轮观测的 548 ms 降到 437 ms，但单轮对照会受 Storage/服务负载影响，不将约 112 ms 全数归因于该改动。最后尝试的 token 批量物化没有稳定收益，已撤回。

结论：当前持续运行情况下 Memory prepare 已接近 TS，warm P50 差约 5%；不建议为追求单轮差值继续增加高风险的 tokenizer/CSR 实现复杂度。若需要进一步压低首轮耗时，下一步应单独重构并基准化 Cython CSR 冷建，而不是再优化已接近持平的 warm 路径。完整 RAG 回归后续已在当前代码状态下串行复跑通过，详见下节。

### transient 索引安装内部阶段探针

为避免把 `replace_transient` 整段误认为 CSR，新增仅供显式基准使用的细分计时：文本投影、批量分词、CSR 构建，以及替换索引之外的状态安装。随后一次探针中远端 Storage/服务负载明显偏高（Cython 与 TS 的向量读取阶段均约 1.34 秒，warm P95 也异常抖动），因此只用该轮报告安装内部比例，不拿该轮端到端值与前轮做速度结论：

| Cython transient 首次安装子阶段 | 耗时 | 占 `replace_transient` 约 535 ms |
| --- | ---: | ---: |
| jieba-fast 分词（`tokenize_many`） | 429 ms | 80% |
| CSR 组装估算（posting/DF/offset/tie-rank） | 103 ms | 19% |
| 文本投影 | 1.5 ms | <1% |
| 向量 state 安装估算 | 1.8 ms | <1% |

因此实际热点主要是文档分词，而不是 CSR 扁平化或向量复制。`tokenize_many` 虽由 Cython 批处理循环驱动，但中文段仍逐词调用 `jieba-fast.lcut(..., HMM=False)`，并伴随 Python 正则、列表和 token 去重逻辑；“用了 Cython jieba”并不等于整个 tokenizer pipeline 都在 C 层。CSR 还有约 103 ms，可作为次级优化对象。若继续冲首轮冷建，优先评估降低 Jieba 调用/词项投影次数，需严格保持 tokenizer 规则与 90%+ 行为目标；当前 warm 路径不重建索引，不应承担这部分冷建成本。

该次 40 条查询仍为 40/40 完整结果一致、960/960 Memory wire 候选一致，lexical 候选集/顺序/分数一致；未调用 embedding provider。最终完整 RAG 回归在优化后的工作树上串行通过：**360 passed，2 个第三方弃用警告，34.68 秒**。

### 标准 Python jieba 与 jieba-fast 对比

在同一真实 Memory 样本（2,418 篇）上复用完全相同的 Cython `tokenize_many`、正则投影和 `HMM=False`，只替换中文分词器；每个分词实现重复 5 轮，分别统计分词缓存冷/热耗时。所有 2,418 篇 token 序列逐项完全一致。

| 实现 | LRU 分词缓存冷 P50 | LRU 分词缓存热 P50 | Token 序列一致率 |
| --- | ---: | ---: | ---: |
| jieba-fast（当前） | 433.70 ms | 453.27 ms | 基准 |
| 标准 Python jieba | 624.29 ms | 598.16 ms | 100% |

标准 jieba 在本样本约慢 **44%（冷缓存）/32%（热缓存）**；因此替换为原版不会提速，且 token 一致说明差别主要是吞吐而非规则。这里“缓存冷”指 `_segment_chinese` 的 LRU 清空，Jieba 词典已初始化；标准 jieba 导入+词典初始化额外测得约 761 ms。jieba-fast 在 `prepare_memory` 建索引时已初始化，不能把本轮显示的近零初始化耗时当作冷启动对比。每实现 5 轮的 P95 对单次抖动较敏感，结论以 P50 为主。

探针仅在进程内读取授权 Memory 文本，不输出正文/词项，不请求 embedding provider，也不写业务数据。基于结果，保留 jieba-fast；优化应聚焦 Cython tokenizer 的 Python 正则/对象开销，或减少冷建时需要重新分词的文档量，而不是改用纯 Python jieba。

### jieba-rs / PyO3 复测与依赖替换（2026-10-31）

后续按相同语料重新验证 Rust Jieba。`rjieba==0.2.2` 是 jieba-rs 维护者发布的 PyO3 绑定；devserver 通过仅二进制 wheel 安装验证 Linux 运行环境，不需服务 venv 增装构建工具。探针只读同一 owner 的 8,597 条持久索引/Memory 文档，不调用 embedding provider、不写业务数据；真实正文与 token 均只在进程内使用。

修正基准口径后，TS 和 Cython 对相同 wire `ranking_text` 比较，token 序列逐文档 **100% 一致**，各来源 DF 一致、平均 token 数差为 0。另对 246,736 个真实中文 span 直接比较 `jieba-fast` 与 `rjieba`，逐段一致率 **100%**；分词阶段 P50 为 1,850.978ms → 314.869ms（**5.88×**）。完整 Cython tokenizer 在清空相同 LRU 分词缓存后重复三轮，P50 为 2,672.176ms → 1,695.350ms（**1.58×**），文档 token 序列一致率 100%。TS tokenizer 请求计时含 sidecar IPC（5,983.893ms），不拿它与 Cython 的进程内计时直接当作纯分词对比。

因此移除 `jieba-fast` 生产依赖，改用 `rjieba`；此前“保留 jieba-fast”的结论仅代表旧基准下与标准 Python jieba 的比较，已由本节的 jieba-rs 真实语料 A/B 更新。旧包仅在该次对照环境中作为临时基线，不保留为产品依赖或运行时回退。

## 3. 独立 BM25 查询 A/B

负载为确定性合成语料：6,000 文档、每文档 36 个词项、4,000 词表、120 条 5 词查询、Top-K=10、20 轮。报告 warm-query 延迟；Cython 首次编译单独列出，不混入查询延迟。

| 引擎/实现 | P50 (ms/query) | P95 (ms/query) | 备注 |
| --- | ---: | ---: | --- |
| Python map BM25 | 0.1069 | 0.1169 | 字典倒排实现 |
| Cython BM25（优化前） | 0.0717 | 0.0732 | 独立基准首次运行 |
| Cython BM25（优化后） | 0.0527 | 0.0541 | 仅遍历命中文档 |
| TS BM25 | 0.0292 | 0.0301 | 同一输入数据，索引容器不同 |

索引构建：Python map 约 **29.559 ms**；Cython CSR 转换约 **64.114 ms**。Cython 首次编译/导入约 **5.338 s**，属于首次构建成本，不应与 warm query 混算。该原型的 CSR 转换仍慢于 Python map 构建；这是另一阶段的冷构建成本，不是 warm-query 优化的结果。

### 变更与正确性

BM25 内核在扫描 posting 时记录首次命中的文档 ID，评分完成后只对命中文档执行资格过滤和排序，避免稀疏查询再线性遍历整个语料。分数数组仍按文档总数初始化，因此查询开销尚有 O(N) 成分。

所有基准查询均通过 Python map 与 Cython Top-K 顺序/分数对照；完整 RAG 测试套件通过。性能差异表明 Cython 对比 Python CSR 循环有明显收益，但 TS 对本基准仍更快。进一步优化方向是减少每次查询的全量 score-buffer 初始化，并评估对命中集合使用原生 Top-K 选择；需用真实索引分布复测后再决定是否采用，避免为极稀疏语料牺牲高命中场景。

## 4. 测试脚本与边界

### 独立 BM25 脚本

- 脚本：[`bench_cython_rag.py`](../../backend/scripts/benchmarks/bench_cython_rag.py)
- TS 对照：[`bench_rag_bm25.ts`](../../backend/scripts/benchmarks/bench_rag_bm25.ts)
- 命令：`PYTHONPATH=. .venv/bin/python scripts/benchmarks/bench_cython_rag.py`
- 语料与临时编译产物在系统临时目录中生成并随进程清理；没有保存原始用户数据。
- 未连接真实 provider、数据库或真实用户数据；无持久数据写入。

### Memory/RAG 真实端到端探针

- 脚本：[`benchmark_rag_cython_full_real.py`](../../backend/scripts/benchmarks/benchmark_rag_cython_full_real.py)
- 命令：`PYTHONPATH=. .venv/bin/python scripts/benchmarks/benchmark_rag_cython_full_real.py --owner-user-id '<已授权单用户 UUID>' --allow-real-data --queries 40 --iterations 3 --profile-one-query --stratified-content-queries --synthetic-vector-replay`
- 另外以 `--profile-memory-prepare` 单独采集 Memory prepare 调用栈；启用该选项的延迟不用于性能结论。
- 连接 devserver 数据库与 StorageReader，以 owner 隔离只读读取真实索引/Memory；不写业务数据库、持久索引或向量缓存。TS/Cython 索引、编译产物和快照使用系统临时目录，进程结束清理。
- 不请求真实 embedding provider；Hybrid/RRF 使用确定性合成向量。真实正文和 query 仅进程内读取，输出仅含统计/函数名，不包含用户正文、标题、ID 或 query。

### Memory 过滤微基准

用内联隔离 Python 片段调用 `cython_lifecycle` 的 snapshot 过滤函数，生成 300 条合成文档并重复 9 轮取中位数；不读取用户数据，不写仓库文件，也不连接外部服务。该微基准用于确认重复规范化成本，不是完整 Memory prepare A/B。

### 独立 BM25 的解释边界

合成 BM25 基准没有连接真实数据库/provider，不能替代上面的真实索引端到端 A/B。TS/Python/Cython 的容器与排序实现不同，表中结果只对固定合成语料有参考价值。devserver full RAG 使用真实文本与真实索引，但 Hybrid 向量使用合成回放，报告应同时保留这两个边界。

## 5. 真实语料 BM25-only 完整链路 A/B（2026-10-31）

在 devserver 对同一授权 owner 的真实索引执行 40 条按来源轮转的内容 query，每条 query、每个引擎各计时 3 轮。`--bm25-only` 强制 query vector 为空，因此实际查询只走 BM25 lexical + 现有 rank，不执行 Hybrid/RRF，也没有调用 embedding provider；准备索引时仍按生产加载路径读取已有缓存向量。语料为 6,182 条持久文档和 2,423 条 transient Memory 文档，覆盖 8 个来源。真实文本只在进程内处理，报告仅记录聚合值。

| 指标 | TS | Cython | 结果 |
| --- | ---: | ---: | --- |
| Unified BM25-only 查询 P50 / P95 | 117.245 / 180.935 ms | 54.704 / 93.334 ms | Cython 快 2.14× / 1.94× |
| Index 初始加载 | 5,961.89 ms（含 worker 启动） | 4,129.81 ms 全量构建；1,383.89 ms 快照恢复 | 生命周期口径不同，分项观察 |
| 初次 Memory prepare | 912.64 ms | 986.43 ms | TS 略快 |
| warm Memory prepare P50 / P95 | 695.591 / 807.52 ms | 457.921 / 480.35 ms | Cython 快 1.52× / 1.68× |
| Query token 序列 / IDF 项一致 | — | — | 均 100% |
| 各来源候选集合 / 最终 Top-K 顺序 | — | — | 均 100% |

BM25 源内候选排序在 calendar、canvas、conversation、knowledge、note、project、scheduled_task 七个来源均为 40/40 一致；Memory 为 32/40。Memory 候选集合仍 40/40 相同，但最大 BM25 分数差为 31.288；wire 对照发现 4 条 `daily.text` 差异。它们使完整 rank response 的逐字段一致率为 0%，尽管最终 Top-K 顺序与 Jaccard 均为 100%，且目标来源命中率两侧均为 95%。因此性能收益明确，但 Memory 文本/分数差异尚未解释，不能据此宣称完整响应等价；应单独追查这 4 条 daily projection，再评估是否需要调整验收口径。

TS 冷加载为 worker 启动 + DB/index/vector load + 持久化；Cython 同一轮报告全量构建 4.13 秒、生成快照 1.45 秒、随后快照恢复 1.38 秒，不能把快照恢复与 TS 冷启动直接当作同口径比较。Cython 扩展临时编译/加载约 18.02 秒，是首次构建成本，不计入查询 P50/P95。基准使用隔离临时目录并自动清理；未写业务数据、未改变服务配置。
