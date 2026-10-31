# Cython RAG 全链路等价与性能 A/B

日期：2026-10-30
范围：devserver 单 owner、只读索引；只执行查询，不修改用户索引/Memory/向量文件，不调用 embedding provider。

## 方法

- 同一 owner-bound 持久索引与 transient Memory，由 TS worker 和 Cython facade 分别检索。
- 两组 query 各 40 条、每条每引擎 3 轮：真实索引中的 user message；真实索引标题派生任务。
- 标题任务的 Hybrid 回放使用确定性合成的持久/transient 文档向量和 query vectors；它只验证向量融合实现，不代表真实 embedding 效果。
- RSS 架构基线在导入扩展并预热生产会常驻的 Jieba Cython 词典后采集，避免把 Cython 专有 tokenizer 的常驻内存只计入分子。
- 真实正文、消息、标题和 query 只在进程内使用，报告不记录内容、ID、标题或 query。
- tokenizer 全量差分覆盖 8,436 条真实持久索引/Memory 文档，包含 8 类来源；token 序列与 TS 100% 相同，平均 token 数差为 0；按 wire `ranking_text` 对照也为 100%。真实文本和 token 序列不落报告。

## 结果

| 任务集 | TS P50/P95 | Cython P50/P95 | P50/P95 改善 | 结果一致 | RSS 比值 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 真实 user-message query（lexical-only） | 74.376 / 109.206 ms | 45.774 / 62.746 ms | 38.4% / 42.5% | 100% | 1.0399 |
| 真实标题任务 + synthetic document/query-vector Hybrid replay | 84.664 / 109.152 ms | 52.419 / 68.182 ms | 38.1% / 37.5% | 100% | 0.9535 |

分词器段缓存优化后的最新复测（同一任务定义、40 条 query、每引擎每条 3 轮）：

| 任务集 | TS P50/P95 | Cython P50/P95 | P50/P95 改善 | 结果一致 | RSS 比值 | 实际缓存向量 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 真实 user-message query（lexical-only） | 78.166 / 122.882 ms | 49.475 / 69.625 ms | 36.7% / 43.3% | 100% | 0.9424 | 0 |
| 真实 user-message query + synthetic vector replay | 74.094 / 123.467 ms | 48.220 / 74.487 ms | 34.9% / 39.7% | 100% | 1.2108 | 0 |

第二行虽然开启了 synthetic replay，但数据库读出的真实持久/transient 向量均为 0；报告中的 `persistent_cached_vectors` / `transient_cached_vectors` 保留 replay 前真实计数，`effective_*_vectors` 才包括进程内合成值。两轮所有响应、候选排序、分数与 fallback 仍完全一致，最大 score delta 为 0、mismatch 为 0。两次都未请求 embedding provider。

快照 v2 与相同真实任务集的最新复测：

| 任务集 | TS P50/P95 | Cython P50/P95 | P50/P95 改善 | 结果一致 | RSS 比值 | Cython snapshot restore / TS index load |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 真实 user-message query（lexical-only） | 74.325 / 110.425 ms | 49.606 / 65.077 ms | 33.3% / 41.1% | 100% | 1.0709 | 1.205 / 2.885 s |
| 真实 user-message query + synthetic vector replay | 75.346 / 116.735 ms | 50.161 / 73.547 ms | 33.4% / 37.0% | 100% | 1.0747 | 1.258 / 3.121 s |

快照包含 5,998 条持久索引文档及其 canonical token 序列，大小约 18.54 MB；生成快照额外耗时 2.69–2.82 秒。无有效快照时完整 Cython rebuild 为 6.98–7.09 秒，TS index load 为 2.88–3.12 秒。即快照命中重启已较快，但首次初始化或失效重建仍有性能缺口。

快照失效增量追平实现后的最新源码复测：

| 任务集 | TS P50/P95 | Cython P50/P95 | P50/P95 改善 | 结果一致 | RSS 比值 | 快照恢复 / TS index load | 无快照 rebuild |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 真实 user-message query（lexical-only） | 72.676 / 113.025 ms | 49.719 / 69.750 ms | 31.6% / 38.3% | 100% | 1.0903 | 1.158 / 2.934 s | 8.004 s |
| 真实 user-message query + synthetic vector replay | 73.272 / 118.423 ms | 49.508 / 72.430 ms | 32.4% / 38.8% | 100% | 1.1419 | 1.120 / 3.199 s | 7.510 s |
| 真实 index-title query（lexical-only） | 85.040 / 106.198 ms | 53.591 / 67.298 ms | 37.0% / 36.6% | 100% | 1.0451 | 1.210 / 3.090 s | 7.020 s |
| 真实 index-title query + synthetic vector replay | 83.957 / 109.117 ms | 54.282 / 71.738 ms | 35.3% / 34.3% | 100% | 0.9444 | 1.189 / 3.285 s | 7.218 s |

该复测读取到的真实持久向量数仍为 0；Hybrid 两行的文档与查询向量均为确定性合成值。四组最大 score delta 均为 0；每个来源的候选集合、顺序和 score sequence 全部一致。快照大小约 18.54 MB，生成耗时 2.73–2.89 秒。生命周期测试新增“旧快照按 revision 安全增量追平且不调用全量快照 reader”的行为验证；BM25 新增 256 文档、128 组过滤矩阵差分；本地完整 `tests/agent/rag` 串行回归为 299 passed。另新增非法 top-level candidates wire shape 与 TS worker 的错误行为差分，以及 source projection→Cython 索引安装→查询的端到端 TS 比对。该结果不代表真实向量语义等价，也不表示无快照冷构建已达标。

两组的最终响应、Top-K 顺序、各来源 lexical 候选顺序及 fallback 均完全一致；最大 score delta 为 0，mismatch 为 0。Lexical 顺序差异修复前来自 TS ICU `localeCompare` 与 Python 码点排序不同；现在两端固定 en-US ICU，差异归零。

RSS 是 benchmark 的 Cython 进程峰值与“已加载 RAG runtime 的 Python 基线 + TS worker 峰值”的架构估值比较，不是线上容器的独立压测。逐文档分词、紧凑数组 posting 和边展平边释放分组数组后，两组 RSS 比值分别为 1.0399 和 0.9535，低于 PRD 的 ≤1.25 门槛；这是单 owner、当前索引规模下的验收，不替代生产容器压测。

## 冷路径与边界

- v2 快照包含 canonical token 序列，命中时无需重读全部文档或重新分词/构建 posting；快照 revision 过期时，在 tokenizer/projection 版本兼容且水位完整的条件下会尝试安全增量追平，不满足条件仍全量重建。最新源码 A/B：快照恢复 1.120–1.158 秒，TS index load 2.934–3.199 秒；快照约 18.54 MB，生成耗时 2.81–2.89 秒；无有效快照完整 rebuild 7.510–8.004 秒。因此有效快照路径较快，但首次全量构建仍慢于 TS。
- 两轮当前快照分别包含 5,998 条持久文档、2,438 条 transient Memory 文档；真实持久/transient 向量均为 0。synthetic replay 只验证向量融合算法，不代表真实 embedding 效果或真实缓存命中。两轮都未请求 embedding provider。
- 已记录的 A/B 包含 40 条真实 user-message 与 40 条真实 index-title query，各 3 轮：消息 lexical-only TS P50/P95 72.676/113.025 ms、Cython 49.719/69.750 ms；消息 synthetic Hybrid TS 73.272/118.423 ms、Cython 49.508/72.430 ms；标题 lexical-only TS 85.040/106.198 ms、Cython 53.591/67.298 ms；标题 synthetic Hybrid TS 83.957/109.117 ms、Cython 54.282/71.738 ms。四组最终响应、候选顺序、分数与 fallback 均 100% 一致，最大 score delta 0；RSS 比值分别为 1.0903、1.1419、1.0451、0.9444。该 A/B 未覆盖随后补入的小数预算边界修复，也未覆盖真实向量缓存。
- 最新实际语料 tokenizer 复核从当前快照分来源采样 3,859 条（早先完整快照曾覆盖 8,436 条）；token 序列一致率及 wire `ranking_text` 一致率均为 100%，平均 token 数差为 0。当前样本随索引变化，不应与历史快照数相加。
- Cython 临时扩展首次编译/导入约 8.5 秒；生产验收需要在目标平台 build stage 预编译，不能把临时 `pyximport` 编译时间藏进服务热路径。快照 v2 生成会付出额外一次分词和约 2.7 秒写入成本；恢复快照省去分词与 posting 重建，需继续评估快照空间、写入频率与失效重建策略。
- 真实 user-message query 按 lexical-only 分支验证；Hybrid 排序/融合仅由合成文档向量与合成 query vectors 回放。没有请求 embedding provider，因此未验证真实 query embedding 的提供方延迟/失败行为、真实缓存向量匹配或语义质量。
- 本次数据包含 5,998 条持久文档与 2,438 条 transient Memory 文档；无重复持久 slot。
- 该次 devserver A/B 对应的本地 `tests/agent/rag` 串行回归为 299 passed、2 条 pypinyin 弃用警告；TS RAG worker tests 曾为 66 passed。Mutagen session 当时已有 1 个冲突，因此未执行 devserver 全套 pytest；devserver A/B 只执行授权 owner 的只读索引查询与临时快照操作，业务索引/Memory/向量文件不变。后续本地回归结果见下方补充。

## 后续本地差分补充

rank 配额数值转换补充后，在本地实时调用 TS `rankCandidates` 对照 Cython rank facade：覆盖 `limit`、`maxChars`、`maxPerSource`、`maxPerParent` 的无效数字、空字符串、小数、数组/嵌套数组、对象及 JavaScript 不识别为空白的 U+0085；30 个 rank differential 用例通过，并修复了小数字符预算截断为空时与 TS 原文回退的差异。完整 `tests/agent/rag` 串行回归为 322 passed、10 warnings（其中包含既有异步 SQLite worker 在线程关闭后的 event-loop 警告）。这轮仅验证边界契约，没有重跑 devserver A/B；此前 A/B 的真实向量缺失、Hybrid 使用合成向量、冷构建慢于 TS 等限制仍有效。

### 2026-10-30 后续复测与 query embedding 配置快照修复

Cython `unified_query_with_embedding` 现消费 Python 在本轮请求准备阶段已校验并冻结的 embedding 配置快照，不会在执行时重读可能已变化的全局配置；新增回归验证 endpoint、模型、维度与调用配置都来自该快照。Python RAG + embedding provider 回归串行结果为 **337 passed**，TS RAG worker 为 **66 passed**；仅有 2 个第三方 pypinyin 弃用警告。该改动仍未将 Cython 接入生产查询路径。

devserver 同步会话存在 1 个未解决冲突，但本次 A/B 所需的四个源码/脚本文件远端 SHA-256 与本地完全一致，因此没有 flush 或覆盖冲突文件，直接复跑只读 benchmark。运行前因 devserver venv 未安装 Cython 而中止；随后仅将与本地相同的 Cython 3.3.0 和 setuptools 安装到一次性 `/tmp` 目录，脚本退出时移除，未改写 devserver venv。

| 当前源码任务集 | TS P50/P95 | Cython P50/P95 | P95 改善 | 完整响应/候选/score | 峰值 RSS 比值 | 说明 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 真实 user-message query，lexical-only，40 条×3 轮 | 71.836 / 110.199 ms | 50.897 / 63.673 ms | 42.2% | 100%，最大 score delta 0 | 1.0752 | 无 query vector；不是 Hybrid |
| 真实 index-title query，synthetic Hybrid，40 条×3 轮 | 86.782 / 108.205 ms | 55.294 / 69.277 ms | 36.0% | 100%，最大 score delta 0 | 1.1357 | 合成 query/doc vectors；不代表真实向量语义 |

两组均覆盖 8 个 RAG 来源的 lexical 候选顺序、集合和分数，`mismatch_count=0`、fallback 一致；本轮 query-vector replay 只在标题任务实际发生 40 次。真实持久/transient vector cache 仍为 0，两个任务都未请求 embedding provider；因此仍不能宣称真实向量 Hybrid 或在线 query embedding 已验收。Cython snapshot restore 1.165–1.195 秒，TS index load 3.022–3.128 秒；无快照 rebuild 6.951–7.072 秒，仍慢于 TS 冷加载。Cython 扩展初次临时编译约 8.2–8.4 秒。

本次 A/B 后的剩余工作仍包括：所有协议操作的错误/特殊输入差分矩阵收口、真实 query embedding provider 的小样本路径验证，以及最终 21 操作/生产调用者映射审查。来源索引写入的 Cython 投影实现已具备并与真实语料逐字段对照，但正式调用仍保留在 TS；生产切换与 TS 清理不属于当前阶段。

### query embedding 同输入跨 runtime 错误差分

新增本机 loopback HTTP 行为测试，Python 与 TS `embedQuery` 请求同一个测试服务、同一配置和 query，并逐字段比较 outcome/vector/status。17 类有效/错误结果全部一致：成功、429、302 且不跟随重定向、非法 JSON、包含非数值向量、超过 2 MiB 响应、15ms 超时、连接失败、换行/非 ASCII API key 拒绝、gzip 压缩响应拒绝解析，以及空 query、空模型、非法 scheme、URL 凭据/查询参数和无效 pin 拒绝。响应体中的错误正文不会进入结果。测试不访问外网、不使用真实凭据或真实用户 query。为对齐 Node `http.request` 不自动解压的行为，Python 侧显式请求 `identity` 并按原始 wire bytes 计数；这既保持响应上限语义，也避免 HTTPX 透明解压造成行为分叉。

该差分回归加入后的完整串行结果：`backend/tests/agent/rag` 与 `backend/tests/agent/providers/test_rag_query_embedding.py` **354 passed**、2 个第三方 pypinyin 弃用警告；TS RAG worker **66 passed**。这证明了本地模拟 HTTP 条件下的请求/错误回退契约，不证明真实 provider 的延迟、兼容性或真实向量语义。真实 query embedding provider A/B 仍需另行授权数据传输与可能的 API 成本。

## 结论

在本次覆盖的真实消息/标题查询、synthetic Hybrid/RRF 回放、rank 与 owner-bound scope 矩阵上，TS/Cython 结果逐项一致；最新热 P95 改善约 34.3%–38.8%，RSS 比值为 0.94–1.14。有效快照恢复快于 TS index load，快照过期可在安全条件下增量追平；无快照首次全量构建仍较慢。真实缓存向量为 0，故这不是使用真实向量的 Hybrid A/B；真实 query embedding provider 场景也未验证。完整等价验收仍未完成：协议错误与特殊输入尚未形成全操作矩阵，来源索引写入 facade 尚未接线，生产入口保持不变。当前结论是“限定真实任务文本与 synthetic Hybrid 算法路径一致、热查询与快照恢复更快、RSS 达标”，TS 生产路径继续保持不变。

## 2026-10-30 当前代码复测

针对本轮 Hybrid 同分排序修复，以相同授权语料重新执行 40 条真实 conversation message query（lexical-only）与 40 条真实索引标题 query（synthetic Hybrid），每任务每引擎 3 轮。8 个来源的 lexical 候选顺序/集合/分数、Top-K 与最终响应均一致，`mismatch_count=0`，最大 score delta 为 0；真实持久/transient 向量均为 0，未请求 embedding provider。

| 任务 | TS P50/P95 | Cython P50/P95 | Top-K/响应一致 | RSS 比值 |
| --- | ---: | ---: | ---: | ---: |
| 真实 conversation message query（lexical-only） | 74.920 / 111.759 ms | 49.223 / 65.511 ms | 100% | 1.0937 |
| 真实 index-title query（synthetic Hybrid/RRF） | 84.224 / 109.073 ms | 54.996 / 75.557 ms | 100% | 1.2806 |

热 P95 分别改善 41.4% 与 30.7%；Cython 快照恢复 1.162 秒，TS index load 2.933 秒；无快照全量 Cython rebuild 7.880 秒。Synthetic Hybrid 本次 RSS 比值 1.2806，略超 PRD 1.25 门槛；此前同类合成向量运行低于门槛。由于真实向量缓存为空，且采样窗口为单次运行，RSS 需在统一冷/热状态下复测并说明峰值口径，当前不能标记资源门槛通过。Cython 首次临时编译约 8.3 秒，开发 benchmark 退出后仍有 asyncio 子进程管道回收警告；生产构建必须预编译，benchmark 关闭流程需独立收敛。

### 同日 synthetic-Hybrid RSS 复测

使用同一 40 条真实 index-title query、每引擎每条 3 轮再次运行，端到端响应、Top-K、8 个来源候选顺序与 score 仍 100% 一致，`mismatch_count=0`、最大 score delta 为 0。TS P50/P95 为 83.298/110.604 ms，Cython 为 54.303/70.194 ms，热 P95 改善 36.5%。TS index load 为 3.161 秒，Cython 有效快照恢复为 1.205 秒，无快照 rebuild 为 7.108 秒。

本次 `cython_to_ts_architecture_peak_rss_ratio=0.9845`，索引加载后驻留比 `cython_to_ts_architecture_index_loaded_rss_ratio=0.8025`；此前相同 synthetic-Hybrid 实验的一次峰值比为 1.2806。比例分母为同次 Python baseline + TS worker 峰值，受 devserver 当前进程/缓存状态影响较大；真实向量仍为 0，合成向量维度为 16。报告保留两次峰值观察，不挑选单次有利结果；资源门槛需在固定运行窗口和统一进程热身/缓存条件下复测。新驻留比字段只补充解释，不替代 PRD 的峰值 RSS 门槛。

本轮最新实现的本地 RAG 串行回归为 329 passed、2 个 pypinyin 第三方弃用警告。

### 同条件 synthetic-Hybrid 连续复测（三轮）

为复核此前一次 1.2806 的峰值 RSS 比值，在相同 devserver、owner 数据、40 条 index-title query、每条每引擎 3 轮条件下，连续执行三次。每轮端到端响应、8 个来源候选顺序/分数、Top-K 和 fallback 均 100% 一致，score delta 为 0，mismatch 为 0；真实缓存向量仍为 0，未调用 embedding provider。

| 连续轮次 | TS P50/P95 | Cython P50/P95 | P95 改善 | 峰值 RSS 比值 | 索引驻留 RSS 比值 | TS index load / Cython snapshot restore |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 83.804 / 107.992 ms | 53.744 / 72.686 ms | 32.7% | 1.0078 | 0.8200 | 3.128 / 1.224 s |
| 2 | 86.210 / 108.970 ms | 56.514 / 68.631 ms | 37.0% | 1.0646 | 0.8189 | 3.142 / 1.092 s |
| 3 | 84.312 / 117.586 ms | 54.178 / 70.804 ms | 39.8% | 1.0179 | 0.8279 | 3.084 / 1.193 s |

三轮 RSS 均低于 1.25 门槛，索引加载后驻留比约 0.82；此前同类型一次运行达到 1.2806，说明 RSS 峰值受 Python/TS worker 基线和进程启动状态影响。当前三轮支持“该稳定运行窗口内通过”，但不把单用户 benchmark 当作线上容器压测。无快照完整 Cython rebuild 分别为 7.302、6.832、6.899 秒，仍慢于 TS index load；snapshot restore 分别快于 TS。临时 Cython/setuptools 安装和编译物均置于单次实验临时目录，执行结束后删除，devserver venv 未持久安装 Cython。

### 后续操作差分与本地串行回归

新增 64 组固定种子 `hybrid_fuse` 运行时差分：候选数量/分数、向量缺失、空查询向量、零向量、维度不匹配、词法/向量权重、`rrf_k` 与 limit 边界均直接调用 TS worker 和 Cython facade 对照，结果与排序完全一致。该用例补强算法输入空间覆盖，不代表补齐其余 worker 操作的错误协议矩阵。

本轮后端 `tests/agent/rag` 串行完整回归为 **330 passed**，仅有 2 个第三方 pypinyin 弃用警告。没有重跑 devserver A/B：本轮只新增 Hybrid 算法差分测试和同步 PRD 状态，生产查询/投影代码未变；最近一次真实索引 A/B 与三轮 RSS 复测仍采用上一节所列结果。真实持久/transient 向量为 0，因此“真实缓存向量 Hybrid”及在线 embedding provider 延迟仍未验证。

### 2026-10-30 最新完整 synthetic-Hybrid 复测

用同一授权 owner 的真实索引和 40 条真实 conversation message query，每条 query、每个引擎 3 轮，运行完整 unified query；仅将 query/document 向量替换为进程内确定性向量，不请求 embedding provider。测试覆盖 5,998 个持久文档、2,438 个 transient Memory 文档、8 个来源。最终响应、Top-K、来源候选顺序/分数、rank/IDF 统计与 fallback 均一致，`mismatch_count=0`，score delta 为 0；真实持久向量仍为 0。

| 指标 | TS | Cython | 对照 |
| --- | ---: | ---: | ---: |
| 查询 P50 / P95 | 74.582 / 113.297 ms | 50.165 / 71.066 ms | P95 改善 37.3% |
| 峰值 RSS | 431.72 MiB（TS worker） | 744.50 MiB（Cython Python 进程） | 架构估算比 1.0774 |
| 索引加载后驻留比 | — | — | 0.8766 |
| TS index load / Cython snapshot restore | 3.057 s | 1.171 s | 快照恢复更快 |
| Cython 无快照全量重建 | — | 6.970 s | 仍慢于 TS 冷加载 |

初次扩展编译/导入约 8.59 秒；快照约 18.54 MB，生成约 2.78 秒。该结果验证当前完整 Hybrid/RRF/rank 编排在 synthetic vector replay 下的行为及热查询，不证明真实向量语义或在线 embedding provider 等价；单用户 RSS 是架构估算，不是线上压测。另以真实 canonical 文档派生的 40 条标题查询复跑 BM25 lexical A/B：7,600 个文档，Top-10 顺序/集合 100% 一致，最大 score delta `7.1e-15`，平均热查询 1.8068→0.6238 ms（2.90×）。lexical benchmark 结束时仍有 asyncio subprocess transport 的 event-loop 关闭警告，不影响结果数值，但基准清理路径需要收敛。

### 2026-10-30 用户授权的小样本 provider A/B 状态

用户授权最多 5 条真实 query 的 provider A/B 后，benchmark 绑定 owner 的 BYOK 配置并继承 Admin 平台 Embedding 设置，每条 query 最多请求 provider 一次；同一个 query vector 交给 TS/Cython 对照，不生成文档向量。首次检查曾因 devserver `.venv` 缺少 `requirements-dev.txt` 中的 Cython 测试依赖而在 import 阶段退出，未发出 provider 请求；只读核验确认 Admin 平台配置已启用且有效。随后将 Cython 临时安装在实验目录（未改动服务 venv），A/B 成功完成：

| 指标 | 结果 |
| --- | ---: |
| 真实 query / provider 请求 | 5 / 5，全部成功 |
| TS 与 Cython 最终响应、候选顺序、分数 | 100% 一致，最大差异 0 |
| TS 查询 P50 / P95 | 56.117 / 85.274 ms |
| Cython 查询 P50 / P95 | 39.257 / 48.864 ms |
| P95 变化 | 改善 42.7% |
| 持久文档 / transient Memory 文档 | 6,009 / 2,438 |
| 持久与 transient 缓存文档向量 | 0 / 0 |

因此这次证明真实 query embedding provider 路径可用，且同一 query vector 下两侧 lexical 检索结果一致；但由于没有真实文档向量，`vector_mode=lexical_only`，并未验证真实向量 Hybrid 排序等价，也不代表真实 embedding 对召回质量的影响。没有生成或写入文档向量，Admin 配置及服务运行环境保持不变。报告中的先前“账号缺少有效配置、需用户先启用”的判断已由本次证据纠正；当前未完成项是取得已有真实文档向量样本后的 Hybrid A/B，而不是 Admin 配置。

新增 `adapt` worker operation 差分覆盖 `file` 的 `unsupported_source`、未知来源/`journal` 空成功及有效来源 wire documents。当前本地 Python RAG + query embedding 回归 **355 passed**，TS RAG worker **66 passed**。该变化只补协议 facade/test，不接生产；真实 provider A/B 与完整协议矩阵仍未验收。

### 2026-10-30 devserver 完整串行复测（安装 Cython 后）

在 backend 开发虚拟环境核验 Cython **3.3.0** 已安装；未改生产依赖或服务配置。重新检查本轮 RAG 测试/基准脚本：各自覆盖合成内核微基准、词法 A/B、来源 projection、完整 unified/RRF/rank A/B、读取路径，未找到语义重复且可安全删除的脚本；因此保留有独立诊断价值的脚本，不为“清理”而删覆盖。期间修正了完整 A/B 的 revision setup 竞态和来源命中率统计，并修复 Cython 读取持久/瞬态 memory 同 slot 时应遵循 TS 持久索引优先的行为。

devserver 串行回归结果：`tests/agent/rag` 加 query embedding provider 测试 **355 passed**；TS RAG worker **66 passed**。另执行 50 条真实索引内容派生 query（calendar 6、canvas 7、conversation 6、knowledge 7、memory 4、note 7、project 7、scheduled_task 6），每条每个引擎 3 轮，使用合成向量回放验证 Hybrid/RRF：

| 指标 | TS | Cython | 结果 |
| --- | ---: | ---: | --- |
| RAG 查询 P50 / P95 | 216.795 / 373.771 ms | 115.510 / 208.187 ms | P95 改善 44.3% |
| 完整响应、Top-K、候选顺序/分数、fallback | — | — | 100% 一致，最大 score delta 0 |
| 候选目标文档命中 | 100% | 100% | 两端一致 |
| 目标文档最终入选 | 98% | 98% | 同一条 conversation query 在两端均未入选 |
| 峰值 RSS | — | — | 架构比值 1.234（约 980 MiB Cython 进程峰值） |
| TS index load / Cython snapshot restore | 3.281 s | 1.925 s | 快照恢复更快 |
| 无快照 Cython 完整 rebuild | — | 11.328 s | 仍慢于 TS index load |

本轮索引约 6,039 条持久文档、2,444 条 transient Memory 文档；读取到 710 个持久与 2,444 个 transient 缓存向量。向量回放对全部文档/查询替换为确定性合成向量，故这 50 条只证明融合实现和检索排序等价，不代表 query 语义质量。

另按当前授权对 5 条跨来源真实内容查询各调用一次真实 embedding provider（canvas、knowledge、memory、note、project），复用已有真实文档向量；5/5 provider 成功，TS/Cython 完整响应、Top-K、候选排序和分数 100% 一致。该小样本 RAG P50/P95 为 TS 256.265/323.765 ms、Cython 145.965/172.971 ms；仅 5 条，不能当作稳定性能结论。该轮峰值 RSS 架构比值为 1.354，超过 1.25 目标，且绝对峰值约 1,052 MiB；因此资源门槛尚未通过，需要固定缓存/并发条件复测及降低峰值内存。没有生成或写入文档向量。

生产 `search_knowledge` 冒烟仍未通过：TS sidecar 返回 `revision_mismatch`，强制缓存失效并全量 resync 后重试仍相同失败；清空进程内 index cache 后再试也失败，RAG 查询耗时约 2.21 秒，未获得可供主模型注入的召回上下文。独立的正常 LLM 无工具调用请求已成功，但因 RAG 冒烟失败，它不是“带真实召回上下文”的端到端成功验证；未记录模型调用耗时。问题与 Cython A/B 无关，当前生产查询仍走 TS。最终结论：Cython 行为等价和热查询收益在本轮样本中成立，但真实生产 RAG 链路因 TS revision mismatch 阻断、真实 query 样本量较小且一轮 RSS 超标，不能标记完整 E2E 验收通过，也不能切换生产入口。

### 2026-10-30 Cython 增量快照写入合并

将 Cython 生命周期的增量索引变更改为 1.5 秒 debounce：窗口内多次增量合并为最新状态的一次原子完整快照写入；冷启动全量重建和向量版本刷新仍立即写入。增加显式 `flush_snapshot_persistence()`，并用串行写锁与 generation 防止旧快照覆盖新快照。另补锁竞争回归，验证后台写任务等待 mutation lock 时继续到来的增量不会丢失。Python RAG 与 query embedding 回归串行 **357 passed**；未执行 devserver 同步/验证，当前 Cython 生命周期仍未接入生产调用路径。注意这减少的是写入频率和请求路径阻塞，不改变 JSON 快照“每次仍全量重写”的成本。
