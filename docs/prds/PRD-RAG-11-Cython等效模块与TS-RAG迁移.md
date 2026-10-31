# PRD-RAG-11：Cython 性能优先迁移与 TS RAG 收敛

> 状态：🟡 Cython kernel、查询链路和真实语料对照已建立；开发环境直接启用 Cython 观察，不做 shadow 双跑。热查询快于 TS，但完整冷建和 Memory prepare 仍需持续观测。验收不要求全量 TS 行为等价：Top-K 相似度 90%+、保留 IDF 核心算法、权限/隔离不退化，并以完整 RAG 性能至少达到 TS 为目标。生产环境继续保持 TS，生产切换需另行决策。

## 2026-10-31 用户补充：性能优先验收规则（覆盖下文旧版严格等价要求）

- 不要求逐字段、逐浮点或逐协议行为完整复刻 TS；迁移以 Cython 优化和端到端效率为中心，不为匹配 TS 的内部编码、revision、wire 中间态增加成本。
- 真实查询集按最终 Top-K 文档 ID 的宏平均 Jaccard 计算相似度，门槛为 **≥90%**；同时分来源报告召回，避免大来源掩盖小来源退化。调优不得绕过 owner/scope 授权、revision 新鲜度和数据隔离，这些安全边界仍要求 100% 保持。
- IDF 是必须保留的算法能力：保留 corpus/document-frequency 统计、查询词权重与非线性贡献重打分；以独立算法回归验证公式、边界和确定性，不要求所有 TS 浮点细节/诊断字段一致。
- 端到端性能目标至少达到 TS：分别测量 cold index load/build、快照恢复、Memory prepare、热 query/rank 和 RSS。核心准备/重建及热查询的代表性 P50/P95 不得慢于同条件 TS；若性能与非安全兼容细节冲突，优先简化后者。编译冷启动单列，不混入服务热路径。
- 旧版“完整等价”“Top-K 100%”“所有浮点 exact/1e-12”验收表述均由本补充覆盖。TS 保留为开发环境手动回滚基线；Cython 异常时不自动回退、不双跑。当前开发环境的观测结果不代表生产上线批准；生产切换与 TS 清理需单独评审。
> 创建：2026-10-29
> 最近更新：2026-10-31
> 关联模块：`backend/ts/workers/rag/`、`backend/ts/packages/contracts/src/rag.ts`、`backend/agent/rag/`
> 背景参考：PRD-RAG-3、PRD-RAG-6、PRD-RAG-7、PRD-RAG-9、PRD-RAG-10、PRD-TS-RAG-0.4.0

## 0. 实际状态

| 能力/结果 | 状态 | 说明 |
| --- | --- | --- |
| TS RAG 模块/协议/算法盘点 | ✅ 已完成 | 已覆盖 worker、contract、Data Runtime、来源适配、缓存、BM25/融合/重排与安全边界。 |
| Cython BM25 CSR 基础 | 🟢 行为核已完成 | `agent/rag/cython_backend.py` 与 `.pyx` 已建立并通过 BM25/property 与 TS 运行时差分；由 `search.rag_backend` 选择唯一运行时。 |
| 同任务 Python/Cython/TS 对照 | ✅ lexical 阶段完成 | 合成语料在 devserver 对比 Python map/CSR、Cython 与 TS；真实语料同任务比较 TS Worker 与 Cython BM25，见脱敏报告。 |
| 完整 RAG 行为等价 | 🟡 查询主路径已差分 | 新增不接生产的 Python source projection；8 类 source 已覆盖代表记录；projection chunker 已改为对齐 TS worker 的 1000/150 Unicode 码点预算、段落/句界聚合与长句重叠切分，版本 hash 的孤立代理项也对齐 Node UTF-8 替换行为；Cython patch 已覆盖 TS 的稳定 tie-break 顺序与词法 fingerprint no-op 规则；engine 已建立持久/瞬态向量分槽和模型版本状态；`hybrid_fuse` 操作级 facade 覆盖透传与无命中回退，并新增 64 组固定种子 TS/Cython 随机向量、空/零/错维、权重与 limit 差分；engine 分组融合覆盖持久向量版本门控、瞬态独立向量槽及不可用时保留词法分数。新增 owner-bound corpus 的 owner/project/folder/group/member 六类 scope TS 差分；真实 source projection 对 8 类、7,072 条记录/7,599 个文档逐字段和顺序差分为 0；另有 projection→Cython 索引安装→search 与 TS `build_and_index`/`search` 的组合差分。其余 operation 协议错误/property/fuzz 矩阵仍未完成。生产接线与 TS 清理未执行。Data Runtime 的 1400/120 持久 canonical chunk 与 worker source adapter 的 1000/150 投影是不同层，不能互相代替。
| devserver 真实场景 A/B | 🟡 lexical、synthetic-Hybrid 与 query provider smoke 通过；真实向量 Hybrid 待验 | 完整 synthetic-Hybrid：40 条真实 conversation query×3 轮，5,998 持久+2,438 transient 文档、8 来源，响应/Top-K/来源排序/分数/诊断/fallback 全一致，热 P95 改善 37.3%，RSS 架构估算比 1.0774；另 7,600 文档 lexical A/B Top-10 一致，平均热查询加速 2.90×。最新 5 条真实 query provider 请求均成功，TS/Cython 结果 100% 一致、P95 改善 42.7%；但持久/transient 文档向量缓存均为 0，该次仍是 lexical-only，不证明真实 Hybrid 向量排序。单用户 RSS 不是线上容器压测。|
| 查询 embedding 安全路径 | 🟡 本地契约差分完成 | Python 侧固定 IP、禁重定向、4 秒超时、2 MiB 响应上限、结果校验、5 分钟/64 项短缓存；Cython facade 消费本轮已校验配置快照。新增同一 loopback 服务下 TS/Python 9 类行为逐字段差分，成功、HTTP 错误、重定向、坏 JSON/向量、超限、超时、连接错误、非法凭据均一致；本地无外网差分通过。仍需真实 provider 小样本对照，不能推断真实服务兼容性。 |
| 开发环境 Cython 主路径 | 🟡 本地接线待验证 | 配置显式设为 `cython` 后统一召回和 Memory transient 查询只执行 Cython；不 shadow、不自动 fallback。TS 配置保留作为人工回滚；devserver 启用和观察需在同步/验证后进行。 |
| 生产切换与移除 TS RAG worker | 🔲 未授权/未执行 | 本次开发环境接入不包含生产切换或删除 TS 基线；待观察期结束后再单独评审。 |

> 状态表及下方 2026-10-30 以前的测试记录保留当时“等价迁移”阶段的历史事实；其中“完整等价”“逐字段一致”“精确分数”等名称/结果不再是当前验收门槛。当前唯一质量相似度门槛以本文顶部 2026-10-31 规则及 FR-RAG11-07/验收章节为准。

> 表中“完整 RAG 行为等价”是历史阶段名称，当前应理解为“完整链路能力与质量差异验证”；未完成 TS operation 错误/property/fuzz 矩阵不构成迁移阻塞。

### 2026-10-30 等价性与 A/B 更新

本轮修复了 TS `localeCompare` 与 Python 码点 tie-break 差异：RAG 字符串排序固定使用 en-US ICU，TS comparator 显式指定同一 locale。最新源码 devserver 只读复测使用 40 条真实用户消息 query 与 40 条真实索引标题 query，各运行 3 轮，分别执行 lexical-only 与确定性 synthetic-vector Hybrid replay。消息 lexical/Hybrid 的 TS→Cython P50/P95 分别为 72.676/113.025→49.719/69.750ms、73.272/118.423→49.508/72.430ms；标题 lexical/Hybrid 分别为 85.040/106.198→53.591/67.298ms、83.957/109.117→54.282/71.738ms。四组 tokenizer、各来源候选顺序、最终 Top-K、score 与 fallback 均 100% 一致，score delta 和 mismatch 均为 0；P95 改善 34.3%–38.8%，RSS 比值 0.944–1.142。真实缓存向量仍为 0，未请求 embedding provider。Cython v2 快照恢复为 1.12–1.21 秒；快照约 18.54 MB，生成耗时 2.73–2.89 秒；无快照完整 rebuild 为 7.02–8.00 秒。最新 `tests/agent/rag` 本地串行回归 330 项通过；TS RAG worker tests 曾为 66 项通过。owner-bound corpus scope、rank 边界、stale revision 与 64 组 hybrid_fuse 随机边界差分通过；其余 operation 协议错误/特殊输入矩阵仍待补齐。

性能方面，最新消息任务 warm P95 改善 38.3% / 38.8%，标题任务改善 36.6% / 34.3%；runtime-normalized RSS 比值分别为 1.0903 / 1.1419 / 1.0451 / 0.9444，均低于 1.25 门槛。Hybrid 使用确定性 synthetic 文档向量和 query vectors 回放；本次读取到的真实缓存向量数为 0，不请求真实 embedding provider。因此本轮证明了所覆盖任务的等价与热查询收益，但没有证明真实向量 Hybrid 语义等价；首次全量构建仍比 TS 慢，协议错误/property/fuzz 矩阵及真实 query embedding provider 场景尚未验收，生产入口接线仍保持关闭。

本轮更新后按最新代码重跑：真实 conversation message lexical-only 与真实 index-title synthetic Hybrid 各 40 条、每条 3 轮；最终响应、Top-K、8 个来源候选顺序/分数均 100% 一致，最大 score delta 0。消息 lexical P95 改善 41.4%；标题 synthetic Hybrid 在相邻两次运行的 P95 分别改善 30.7% 与 36.5%。Synthetic Hybrid 峰值 RSS 比值分别为 1.2806 与 0.9845，索引加载后驻留比为 0.8025；同日窗口的 base RSS/TS worker 峰值有明显变化，故峰值内存门槛暂不判通过，需固定资源窗口复测。冷 snapshot restore 1.162–1.205 秒，TS index load 2.933–3.161 秒；无快照 rebuild 7.108–7.880 秒。详细数据见 `docs/reports/2026-10-30-PERF-RAG-Cython-Full-AB.md`。

同条件 synthetic-Hybrid 连续三轮后续复测：P95 改善为 32.7%/37.0%/39.8%，峰值 RSS 比值为 1.0078/1.0646/1.0179，均低于 1.25；此前的 1.2806 单轮值仍保留为资源波动证据。另完成真实 source projection A/B，7,072 条真实 records 输出 7,599 个文档，TS/Cython 逐字段与顺序差异 0，详见 [projection 报告](../reports/2026-10-30-PERF-RAG-Cython-Projection-AB.md)。这两项均未改动生产接线；真实缓存向量、在线 embedding、协议错误矩阵和生产级资源负载仍是验收阻塞项。

## 1. 背景与目标

当前 RAG 主链已从 Python BM25/Rust sidecar 迁移为 TypeScript Worker。Worker 不止是 BM25：它承载分词、倒排索引、持久化恢复、增量同步、来源文档构建、Memory/向量准备、查询 embedding、BM25 与 Hybrid/RRF、IDF 重打分、confidence 评分、候选多样性筛选、预算裁剪、引用和诊断协议；部分路径还经 TS Data Runtime 读取 owner-bound 数据。

本 PRD 采用“逐步实现与验证，达标后切换”的策略：先建立可独立测试的 Cython 优化实现，再用固定真实任务对照 TS 测量召回相似度、IDF 行为、安全边界与分段/端到端性能；达到本 PRD 最新门槛后切换生产路径，并清除确认无调用者的 TS RAG 实现。迁移期间不允许新旧结果混合交付给用户，不让算法性能实验改变权限事实源。

目标是降低长期维护两种后端的成本，并以性能优先完成 Cython RAG 迁移。这里不要求完整复刻 TS；在真实代表性任务集上，最终 Top-K 文档 ID 的宏平均 Jaccard ≥90% 即满足检索相似度目标。IDF 统计与重打分算法必须保留并有独立回归；owner/scope 授权、数据隔离与 revision 新鲜度必须 100% 不退化。完整 RAG 的代表性性能目标至少达到同条件 TS。Cython 负责适合编译优化的 CPU 密集路径；Python 继续承担编排、数据库/StorageReader、授权、缓存生命周期、网络请求和上下文注入。TS 的字段、wire 协议、内部排序和浮点值仅作为定位差异的参考，不构成默认迁移门槛。

本项目不改变业务数据库 schema、索引事实源、owner/scope 权限规则、RAG 来源范围、prompt 注入格式、embedding 凭据策略、会话水位或 Agent 消费结构；不把 Cython 扩展作为网络 sidecar，也不在生产运行时编译 `.pyx`。真实 A/B 只读现有业务数据，临时索引与构建文件必须放临时目录并在结束后删除。

## 2. 功能需求

### FR-RAG11-01：盘点调用者并保留必要业务契约

`backend/ts/packages/contracts/src/rag.ts` 的 `RagRequest` / `RagResponse`、worker 测试和现行业务调用用于识别现有职责与调用者。操作矩阵是迁移盘点清单，不是 21 项一对一实现要求。迁移只需实现已确认生产调用者所需能力及下游必需的数据/安全契约；可合并、重设计或删除无调用者的内部操作。仅 owner/scope 授权、数据隔离、revision 新鲜度、引用可追溯性和失败时不泄露数据属于不可削弱的硬契约，内部错误编码、revision 格式、wire 中间结构和诊断字段允许不同。

| 操作 | 当前职责 | 可能实现归属（非一对一要求） |
| --- | --- | --- |
| `ping` | Worker 版本、revision、索引/向量数量与恢复状态 | Python engine 健康状态/索引状态 |
| `tokenize` | canonical Jieba/ASCII/日期 token | 固定 tokenizer adapter 与 golden 测试 |
| `adapt` | 单一来源 record 转 RAG documents | Python 来源 adapters |
| `build_documents` | 多来源 batch 转 canonical chunks | Python projection facade |
| `build_and_index` | 构建文档并安装整索引 | Python orchestration + Cython index build |
| `replace` | 原子替换持久索引、向量表并落可重建缓存 | Python state/store + Cython index build |
| `patch` | 校验 `base_revision` 后增量 upsert/delete | Python revision/state + Cython posting 更新 |
| `replace_transient` | 安装本轮 Memory/transient corpus，不持久化 | Python snapshot cache + Cython index build |
| `search` | scope/source 过滤后的 BM25 Top-K | Cython lexical kernel + Python 过滤/文档映射 |
| `unified_search` | 词法候选、confidence 排序及预算筛选 | Cython ranking kernels + Python facade |
| `batch_search` | 一次分词/语料评分，多组 scope/source 查询 | Python 批调度 + Cython lexical kernel |
| `hybrid_fuse` | lexical/vector cosine 与加权 RRF、纯词法退化 | Cython cosine/RRF kernel + Python 规则层 |
| `rank_candidates` | 归一化、IDF 重打分、confidence、去重与输出统计 | Cython ranking kernel + Python 结果/引用组装 |
| `unified_query` | 多来源召回、来源聚合、水位、Memory/向量融合、重排 | Python orchestration + Cython compute kernels |
| `unified_query_with_embedding` | owner-bound query embedding 后执行统一查询 | Python 安全 HTTP/凭据层 + 上述 unified query |
| `database_revision` | 按 owner 查询 DB revision | Python repository/Data Runtime 等价能力 |
| `load_index_from_database` | 同一 DB 快照加载索引/revision 与向量元数据 | Python repository/query layer |
| `sync_index_from_database` | 水位增量同步；不完整时全量恢复 | Python repository + revision-safe index update |
| `load_vectors_from_storage` | 按 owner 与模型版本读向量缓存 | Python StorageReader |
| `prepare_memory` | owner/group/member Memory、tombstone、snapshot merge、向量缓存 | Python Memory adapter/cache；只把数值运算下沉 Cython |
| `set_vectors` | 更新当前索引版本的向量视图 | Python index state + Cython vector view |

上述操作全部用于完整职责盘点；不要求逐个建立同名 facade，也不要求每项都有等价契约测试。实施时审计关键生产调用者、数据来源、写入副作用和授权位置，针对迁移后实际保留的路径建立行为测试。无调用者的协议分支可在确认影响范围后随旧 worker 清理，不以补齐旧协议矩阵为前置条件。

### FR-RAG11-02：保证来源身份、安全边界与可用文本投影

继续使用 jieba Cython 词法路径；允许针对吞吐和内存调整字典、token 归一化、缓存及内部文本表示，不要求逐 token 复刻 TS 的 Jieba/wire 结果。必须通过真实任务集的 Top-K Jaccard 门槛，并保留 IDF 所需的词项/DF 统计语义。索引与查询应使用同版本 tokenizer，避免同一索引生命周期内的版本混用。

来源/文档构建覆盖实际启用的 `memory`、`knowledge`、`project`、`journal`、`canvas`、`conversation`、`note`、`calendar`、`scheduled_task`。分块长度/重叠、token 归一化和 projection 可以为性能或召回质量调整；但来源身份、owner/group scope、内容与引用的对应关系、conversation 水位和必要元数据必须正确。文件库不是自动 RAG 来源，除非单独产品需求启用。只有数据持久化格式或调用者确实依赖时才要求 hash/slot 精确兼容。

### FR-RAG11-03：保留 IDF 核心并优化词法检索

词法索引应有效支持文档长度、平均长度、term frequency、document frequency、倒排 postings 与文档映射。必须保留 IDF 类核心算法：corpus/document-frequency 统计、查询词权重及非线性贡献重打分；允许调整 BM25 参数、缓存、posting 布局、tie-break、过滤顺序和增量/重建策略。空查询、坏索引、更新失败不能造成越权或返回已知过期数据；除此之外不要求 TS 的精确分数、并列顺序或错误 wire 一致。所有算法调优最终由真实代表任务集 Top-K Jaccard ≥90% 验收。

### FR-RAG11-04：实现高效 Hybrid、重排与候选选择

- Hybrid 应在可用时结合 lexical 与 vector 召回；融合权重、RRF 常数、零向量处理、fallback 表达允许优化，需保证失效时安全降级并在 A/B 中记录。
- IDF re-score 保留 corpus 统计、query weight 与非线性贡献机制；指数、clamp 和计算布局可调，算法测试覆盖公式不变量与边界，不锁定 TS 浮点输出。
- confidence、去重、多样性、来源/父项预算、字符裁剪和引用聚合可重构/调参；以最终 Top-K 相似度与引用正确性验收，不要求固定版本内部常数、诊断字段或逐项选择一致。

### FR-RAG11-05：保持索引生命周期、缓存与 owner 边界

持久索引是可重建缓存，不是业务事实源；允许重新设计冷恢复、原子持久化、快照、增量水位、Memory transient slot、vector version 与缓存策略。数据库读取需维持所需的一致性；owner/hash 隔离、授权后候选收窄和最终 owner/scope 复核必须保留。Cython 输入/输出不得泄露未授权正文或把索引命中当授权凭证。内部 revision/hash 格式仅在外部调用者或已持久化数据依赖时才要求兼容。

### FR-RAG11-06：保持 query embedding 的安全与失败行为

查询 embedding 继续在 Python 安全边界中解密并构造请求：目标 URL 安全校验与 pinned IP、凭据只进当前请求内存、重定向不自动跟随、请求超时/响应大小上限、provider 格式解析、短 TTL cache、错误类别脱敏及失败后按既有规则降级。不得把 key、URL、查询原文、provider 错误正文写入日志或 Cython state。

### FR-RAG11-07：输出可差分验证且不记录正文

测试/基准以最终 Top-K 文档 ID 的宏平均 Jaccard ≥90% 为主要质量门槛，并报告总体与分来源结果、IDF 统计/重打分回归、引用正确性及安全边界。exact 顺序、分数 delta、fallback/诊断字段用于定位差异，不作为完整一致性门槛。报告只保存合成 case ID、内容哈希、计数、阶段耗时、P50/P95、内存峰值和版本指纹；不保存真实查询、正文、文件名、用户昵称、token、凭据或可逆向定位到用户的 ID。

### FR-RAG11-08：验收后直接切换并清理 TS 实现

达到 Top-K ≥90%、IDF 核心回归、安全硬边界及性能门槛后，在明确变更中将生产调用指向 Python/Cython facade；生产环境不得运行双份查询或向用户交付 shadow 结果。保留上一已验收发布制品作为部署回退，不在新代码中长期保留双引擎开关。切换后删除已无调用者的 TS RAG worker、RAG-only JSONL contract/build 入口、TS sidecar lifecycle/client 和只服务旧实现的测试；共享依赖不得连带删除。无需先补齐 TS 所有历史协议分支或证明 100% 排序一致。

## 3. 技术方案

### 3.1 现有 TS 模块完整职责盘点

TS worker 当前由以下模块组成，迁移时按责任拆分到 Python facade、Cython kernel 或继续复用的共享 Python 能力：

| 模块/文件 | 当前责任与重要逻辑 | 迁移归属 |
| --- | --- | --- |
| `src/index.ts` | JSONL 主循环、worker state、scope、BM25 postings、replace/patch、恢复/持久化、vectors、所有 operation dispatcher、unified query stage probe | Python protocol/facade、Python state/store、Cython kernels |
| `packages/contracts/src/rag.ts` | 21 个 operation 的 request/response、document/source/rank 类型、错误、诊断契约 | 迁移期作为 golden contract；最终移除 RAG-only TS contract |
| `src/tokenizer.ts`、`src/ranking/bm25.ts` | Jieba + ASCII/date token；TF、语料统计、BM25 | 固定 tokenizer adapter + Cython BM25/index kernel |
| `src/ranking/idf-rescore.ts` | corpus IDF、query weighting、非线性 contribution score | Cython numeric kernel，Python 输入/输出 DTO |
| `src/ranking/confidence.ts`、`normalize.ts`、`rank-candidates.ts` | 来源质量、query match、v1/v4 confidence、source/lexical normalization、阈值、稳定排序 | Cython numeric kernel + Python constants/DTO facade |
| `src/ranking/select-recall.ts`、`helpers.ts` | hash/dedup、token-set similarity、source/parent 多样性、字符预算、citation | 优先纯 Python，profile 证明为热点后才下沉 Cython |
| `src/adapters/*`、`src/index-builder.ts` | 来源 records 到 canonical RAG documents、分块/版本/metadata | 现有 Python canonical projection/adapters |
| `src/memory-loader.ts` | owner/group/member profile/pattern/daily/scope Memory、tombstone、snapshot、vector map 读取准备 | Python Memory adapter + StorageReader；不复制一套 TS Data Runtime |
| `src/query-embedding.ts`、`src/ttl-cache.ts` | owner 临时凭据下的安全 HTTP embedding、错误 outcome、短 TTL cache | Python embedding adapter/cache |
| `src/index-cache-service.ts`、`src/snapshot-cache.ts` | 索引缓存与 snapshot cache 生命周期/统计 | 现有 Python index/snapshot cache |
| `src/rag-service.ts`、`src/service.ts` | service facade 与 operation 结果统一 | `agent/rag` facade |
| `packages/data-runtime/*` 调用 | owner-bound PostgreSQL revision/index/delta、StorageReader 向量/Memory 文件读取 | 现有 Python DB/repository/StorageReader；检查是否还有非 RAG 消费者 |
| Python `agent/rag/ts_sidecar.py` | 子进程/JSONL client、超时、锁、重启、sidecar host/socket、revision cache、结构映射 | 分步迁移到 Python engine facade，最后删除 TS 特有桥接 |

### 3.2 算法与行为基线

差分测试可覆盖 tokenization、projection、BM25/IDF、Hybrid、Memory、水位、rank、引用和生命周期，用于发现差异与定位回归；不要求把所有历史 TS edge case 全部逐项冻结。必须覆盖 IDF 公式与边界、代表来源的检索质量、引用指向有效候选及 owner/scope 隔离。其余分数、顺序、diagnostic、revision 字符串和失败 response 逐字段比较仅作为诊断信息。

候选质量优先级：身份、权限边界和 owner/scope 隔离 100% 不退化；真实任务集的最终 Top-K ID 宏平均 Jaccard ≥90%，并分来源报告。保持 IDF 统计和重打分的算法意图与边界测试；允许 Cython 使用更适合编译实现的排序、缓存、revision 与内部 DTO，不要求逐项匹配 TS 的 token wire、revision 字符串、诊断字段或浮点尾数。对相似度未达标的来源/任务进行归因和调优，不以整体平均掩盖明显退化。

### 3.3 目标结构与文件范围

```text
backend/agent/rag/
├── cython_backend.py                 【新增】Cython 索引输入适配与显式调用入口
├── cython_kernel.pyx                 【新增】BM25/后续经 profile 证明的数值热点
├── engine.py                         【条件】完整 Python facade，替换旧 sidecar client
├── adapters/                         【不改】canonical source projection 与来源模型
├── index_cache.py                    【条件】切换到 Python/Cython engine
├── ts_sidecar.py                     【条件】迁移完成后删除 TS 专属实现/保留必要纯 DTO 再收敛
└── ...

backend/tests/agent/rag/
├── test_cython_backend.py             【新增】CSR、缺扩展显式失败等行为契约
├── test_cython_equivalence.py         【条件】编译扩展后的 kernel 与 frozen golden 等价
└── ...

backend/scripts/benchmarks/
├── bench_cython_rag.py                【修改】复用生产 Cython 源码，保留合成基准
├── benchmark_rag_cython_real.py      【新增】devserver 单用户真实语料 lexical A/B；显式授权且只输出聚合值
└── ...

docs/prds/PRD-RAG-11-Cython等效模块与TS-RAG迁移.md 【新增】本 PRD 与唯一实施 TODO
docs/reports/2026-10-29-PERF-RAG-Cython-BM25-AB.md   【新增】脱敏 lexical A/B 汇总与边界说明
```

`backend/agent/rag` 是唯一 Cython RAG 运行时代码归属；benchmark 不复制 `.pyx` 实现。开发环境通过 `search.rag_backend` 显式选择 Cython，默认仍为 TypeScript，避免开发配置隐式改变生产运行时。Cython/setuptools/编译器只进入 build stage，产物按目标平台构建，production 不在运行时下载依赖或编译。

### 3.4 初始化内核的边界

索引缓存按唯一后端配置运行：TypeScript 与 Cython 不并行查询。Cython 快照放在 owner 隔离的独立派生目录，与 TS worker 快照分开；冷启动优先恢复 Cython 快照，再按 revision 增量追平或从 owner-bound 数据重建。transient Memory 与 unified query 共用生命周期实例，确保 transient revision 和持久索引 revision 一致。扩展缺失、索引错误均明确失败，不自动切换 TS。

### 3.5 真实场景 A/B 方法

devserver A/B 使用同一只读业务快照/owner 和相同任务集，TS/Cython 分别在隔离临时索引运行，交替执行并控制预热条件。按冷加载、热 query、Hybrid 与完整 unified query 分层，报告准备/索引恢复/词法/融合/重排/总耗时、P50/P95、RSS peak、Top-K 宏平均 Jaccard（总体与按来源）和 IDF 回归结果。Top-K ≥90% 是质量阈值；exact match、分数漂移和逐字段差异保留为诊断，不作硬门槛。真实 queries/output 仅在进程内传递，不写 shell argv、日志或报告。

先用纯 lexical 同任务验证 Cython kernel；kernel benchmark 不冒充完整 RAG A/B。已完成的只读对照用于确认直接接线风险，不在在线查询中 shadow 双跑。开发环境启用 Cython 后，只记录既有脱敏 RAG 阶段诊断和用户可见运行结果；不得记录查询原文、候选正文或凭据。任何写侧投影/索引事务、embedding API 写入和用户 prompt 注入均不属于接入开关的副作用。

## 4. 验证与上线

验收必须包括：Cython 编译与 ABI/目标平台启动；真实任务集最终 Top-K 文档 ID 宏平均 Jaccard ≥90%（按来源报告）；IDF 核心算法回归；owner/scope 越权拒绝与数据隔离 100% 保持；必要的 Memory/会话水位与引用正确性；Embedding URL/pinned IP/凭据脱敏；关键并发与故障边界；devserver 真实只读数据 A/B；生产构建不含编译器与运行时编译路径。TS golden、token 序列、精确 BM25/Hybrid 排序、浮点分数和协议诊断差异仅用于解释结果，不是独立的一致性门槛。

性能验收门槛：完整 RAG 的代表性 query/rank、Memory 准备、snapshot restore 与 cold index build P50/P95 均以至少达到同条件 TS 水平为目标；用户明确要求性能优先于非安全的 TS 内部兼容，因此如局部阶段暂未达标，须量化其对完整链路的影响、继续优化并记录，不因精确等价测试失败而阻塞。热查询不能掩盖完整用户等待时间。RSS peak 目标不超过同一进程/owner 的 TS 基线 1.25 倍。冷/热、编译、数据库读取、向量读取及索引构建分项报告。数据规模、query batch、并发度、worker warm/cold、硬件、版本及 embedding 使用情况必须在报告中声明。

本阶段验证命令：`cd backend && PYTHONPATH=. .venv/bin/pytest -q tests/agent/rag/test_cython_backend.py`；合成 benchmark `PYTHONPATH=. .venv/bin/python scripts/benchmarks/bench_cython_rag.py`；完整 RAG 接口迁移后再按 backend skill 运行串行后端相关测试及 TS worker 测试。devserver 真实数据脚本须显式传 `--allow-real-data`、使用临时工作目录并只打印脱敏统计；默认参数必须拒绝访问真实 DB/存储。

本次只切换开发环境运行配置：默认值仍为 TypeScript；在 devserver 显式启用 Cython 后观察 RAG 结果、延迟、恢复与异常。回退需人工把 `search.rag_backend` 改回 `typescript`，无自动 fallback。生产仍保持 TS，需经过单独的发布决策与构建/资源/真实向量验证后才可切换。观察期间不删除 TS worker、客户端、协议、测试或快照；删除须在独立变更中确认所有消费者与回滚窗口。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| tokenizer/dictionary 版本漂移 | 候选和下游分数变化，可能降低特定来源召回 | 记录版本并按来源监测 Top-K Jaccard；允许差异，但总体宏平均需达到 90% 门槛，并调优明显退化来源。 |
| Python→Cython 数据转换成本 | 核心循环加速但端到端无收益 | 同时报索引 packing 与热 query；优化 CSR 生命周期，避免每轮重新构建。 |
| NumPy/`array`/C ABI 和平台差异 | ARM/x86、macOS/Linux 构建结果不同 | 先采用标准 `array` + typed memoryview；按发布目标平台构建并测试，禁止运行时编译。 |
| owner/scope 或 revision 重构扩权 | 返回跨用户或过期结果 | 权限事实与最终复核留 Python；cross-owner、watermark、revision 行为测试为硬门槛。 |
| “部分 kernel AB”被误读为完整 RAG 胜负 | 错误据此切换或删除 worker | 报告区分 kernel 与 full RAG；只有完整链路质量、安全与性能门槛通过才进入切换。无需声称完整 TS 等价。 |
| 删除共享 TS dependency | Mermaid/FileSync/其他 worker 构建失败 | 清理前查 workspace package consumers 和 Docker/runtime copy，逐项确认引用。 |
| Mutagen 冲突阻止部署验证 | 本地和 devserver 内容不一致 | 当前已知 Mermaid 目录删除与远端未跟踪 `node_modules` 冲突；不 flush 整仓同步，采用隔离的临时实验，或待冲突由用户明确处理后再标准同步。 |

已完成真实数据 tokenizer 全量差分，以及 2026-10-30 限定范围的查询主路径 A/B，详见脱敏报告；A/B 覆盖当前可用查询准备/融合/重排任务，但 Hybrid 使用合成 query vector，且冷加载仍较慢，因此不等同于完整生产验收，也不足以移除 TS sidecar。

## 6. 唯一实施 TODO

### Phase 0：契约盘点与初始 Cython 地基

- [x] `RAG11-001` 盘点 TS RAG 模块、21 个协议操作、主要算法和 Python/TS 权限边界；验收：本 PRD 的职责矩阵可追溯至当前 contract/source。
- [x] `RAG11-002` 建立 Cython BM25 CSR 基础模块与 Python 输入 facade，不接生产路径；验收：CSR 构建次序稳定、空输入/未知词项明确、扩展缺失显式失败。
- [x] `RAG11-003` 将合成 benchmark 改为调用 `agent/rag` 的同一 `.pyx` 源码；验收：Python map、Python CSR、Cython 与 TS 同任务比对，Top-K 与分数满足冻结容差。

### Phase 1：devserver 同任务与真实 lexical A/B

- [x] `RAG11-004` 在隔离环境编译 Cython 扩展并运行合成差分测试；历史验收曾比较 Top-K/分数冻结容差，结果仅作为实现正确性的诊断基线，不构成当前 90%+ 质量门槛的替代或额外要求；构建和语料均使用临时目录。
- [x] `RAG11-005` 运行 devserver 真实 owner 数据的只读 lexical A/B；验收：同一份 canonical 文档快照和 tokenizer，输出聚合耗时、RSS 与 Top-K 差异；不写业务索引或真实正文，产生脱敏报告。限制见报告：TS 计时含 JSONL IPC，Cython 为进程内核；指标后另有 Python asyncio 子进程管道回收警告，需单独收敛。

### Phase 2：完整行为迁移与全链路对照

- [x] `RAG11-006a` 以 `rjieba==0.2.2`（jieba-rs 的 PyO3 绑定）提供中文分词，保留 TS `tokenizeRaw` 的 ASCII 紧邻压缩和月份词项规则，并以固定差分样例锁定行为。2026-10-31 devserver 真实语料全量覆盖 8,597 条持久索引/Memory 文档：相同 wire 文本的 TS/Cython token 序列、DF 与 token 数均 100% 一致；与 `jieba-fast` 相比，246,736 个中文 span 逐段 100% 一致，分词中位耗时 1,850.978ms → 314.869ms（5.88×），完整 Cython tokenizer 2,672.176ms → 1,695.350ms（1.58×）。据此将生产依赖从 `jieba-fast` 切到预编译 `rjieba` wheel；真实文本和词项不落报告。
- [x] `RAG11-006b` 建立不接生产入口的 Cython lexical facade，覆盖全语料 IDF、来源/scope 过滤、持久/transient revision、稳定 chunk-slot patch 与 conversation watermark；验收：边界契约测试通过。source projection、缓存生命周期及 owner 授权仍由现有 Python adapter 承担，完整生产调用链尚未迁入。
- [x] `RAG11-006c` 补齐 `adapt` operation 的协议级差分：`file` 精确返回 `unsupported_source`，未知 source（包括独立 `journal` 槽）按 TS 语义空成功，支持来源逐字段返回 wire documents；同时保留 scope 字段缺省与显式空值差异。TS worker 运行时差分覆盖拒绝、未知和支持来源，projection differential 测试通过。
- [x] `RAG11-007a` 增加 Cython cosine primitive 和 Python RRF facade；验收：Cython 编译基准核对余弦、零向量、维度不匹配、空向量规则，Python 测试核对 lexical/vector rank 融合与纯词法项。尚未覆盖 TS confidence、IDF rescore 与统一预算选择。
- [x] `RAG11-007b` 增加 Cython IDF baseline、query weight clamp 与非线性 term contribution 数值核，并加入 Python 输入适配；历史固定样例曾以 1e-12 比较 Python 参考公式，该精度只记录当时差分结果；当前必须保持 IDF 算法能力并覆盖公式/边界，不要求浮点输出或诊断字段逐项一致。
- [x] `RAG11-007c` 建立独立的 Python rank/selection facade，覆盖 confidence-v1/v4、语义归一、band 选择、历史 hash 排除、source/parent 配额、相似度门控、字符预算、引用聚合与来源诊断；固定合成输入与当前 TS `rankCandidates` golden 对照通过。此项只完成 facade/代表性 golden，不代表完整 differential 验收。
- [x] `RAG11-007d` 已建立 TS/Python rank differential goldens，历史覆盖阈值、并列、IDF diagnostics、字符/hash、配额/预算和 malformed input 等差异，固定样例曾逐字段比较且容差为 `1e-12`。这些结果用于定位差异，不要求迁移保持完全相同；当前质量门槛统一按真实任务 Top-K 宏平均 Jaccard ≥90% 判断。
- [x] `RAG11-006` 将统一 RAG cache/retriever 接到 Cython lifecycle，支持 owner revision、隔离快照、持久/瞬态索引、Memory prepare、unified query 与 transient capability search；TS/Cython 由配置择一执行，不做 shadow 或静默 fallback。接线后回归结果待更新。
- [x] `RAG11-007` BM25、Hybrid/RRF、IDF rescore、confidence-v1/v4 与输出选择算法均已由 Cython 数值核/Python facade 实现；固定/生成输入 TS differential goldens 全通过，精确阈值、分数与最终顺序无差异。查询协议其余边界继续由 `RAG11-006` 收口。
- 2026-10-30 追加验收：新增 `load_vectors_from_storage` 行为回归，验证模型版本刷新按当前索引文档整体替换缓存向量、丢弃未命中的旧模型向量；RAG 测试在专属 conftest 中使用开发依赖，将 `.pyx` 编译到临时目录而不要求生产镜像安装 Cython。新增 TS worker 对 Cython `hybrid_fuse` 的运行时差分，复现并修复大小写 ID 同分时的排序差异，按 TS UTF-16 code-unit 排序；补充 supplementary/BMP 字符边界。真实 lexical benchmark 发现并修正 conversation `context_current` 投影遗漏，最终 40/40 Top-10 精确匹配、分数差为 0，热查询均值约 2.635×。完整 `tests/agent/rag` 串行回归 329 passed、2 个第三方弃用警告。
- [ ] `RAG11-008` 在 devserver 固定真实任务集执行完整只读 A/B，并按当前规则验收：最终 Top-K 文档 ID 宏平均 Jaccard ≥90%，按来源列出差异；IDF 算法、安全/隔离边界通过；完整 RAG 代表性 P50/P95 性能达到 TS 水平（局部差异须说明其端到端影响与优化状态）。历史 exact response/order/score、协议矩阵和 synthetic-vector replay 均是诊断证据而非额外等价门槛。已有 40 条消息与 40 条标题的历史基线为 100% exact，但缓存真实向量为 0，不能替代当前完整验收；真实向量 Hybrid/query-embedding provider 及生产调用者覆盖仍需按实际启用链路验证。

真实来源 projection A/B 补充结果见 [报告](../reports/2026-10-30-PERF-RAG-Cython-Projection-AB.md)：7,072 条真实 source records、7,599 个投影文档、差异为 0。该报告仅证明 projection parity，不等于生产写入接线。其余 RAG 查询 A/B 的真实向量/provider、协议错误矩阵及资源复测门槛依然未完成。

2026-10-30 后续复测：Python `tests/agent/rag` + query embedding provider 回归 **354 passed**，TS RAG worker **66 passed**。本机 loopback 上 query embedding 的 17 类 TS/Python 输入/错误结果逐字段一致，新增非 ASCII 凭据拒绝、压缩 wire response、空 query、空模型、非法 scheme/URL 凭据/查询参数与无效 pin；Python 使用原始响应字节并请求 identity 编码，保持与 TS `http.request` 的大小上限和 JSON 解析语义一致。devserver 当前源码下，40 条真实 user-message lexical-only 与 40 条真实 index-title synthetic Hybrid（各 3 轮）均逐项一致，分别 P95 改善 42.2%/36.0%，峰值 RSS 比值 1.0752/1.1357；完整结果见 [A/B 报告](../reports/2026-10-30-PERF-RAG-Cython-Full-AB.md)。该 Hybrid 使用合成向量，真实缓存向量为 0，且没有调用 embedding provider。其余 operation 错误/特殊输入矩阵和真实 provider 路径仍未全部验收；`RAG11-006/007d/008` 继续保持未完成，不得据此切换生产或删除 TS。

2026-10-30 当前源码追加完整 synthetic-Hybrid 复测：真实 owner 的 40 条 conversation message query、每引擎每条 3 轮，覆盖 5,998 个持久文档、2,438 个 transient Memory 文档和 8 个来源。TS/Cython 最终响应、Top-K、来源候选顺序/分数、rank/IDF 统计及 fallback 均一致，mismatch=0；热 P95 为 113.297→71.066ms（改善 37.3%），架构估算峰值 RSS 比 1.0774、加载后驻留比 0.8766，快照恢复 1.171s，冷重建 6.970s。另有 7,600 文档的 40 条标题 lexical A/B，Top-10 一致率 100%，最大 score delta `7.1e-15`，平均热查询加速 2.90×。向量仍为 synthetic，不调用 provider；真实 provider A/B 仍等待用户对数据外发/费用授权。完整指标与限制见 [A/B 报告](../reports/2026-10-30-PERF-RAG-Cython-Full-AB.md)。

本轮增加 `adapt` operation 对 `file`、未知 source、独立 `journal` 和有效来源的 TS/Python wire 差分；RAG + query embedding 回归串行 **355 passed**，TS RAG worker **66 passed**。初次真实 query provider A/B 在 import 阶段因 devserver venv 缺少开发依赖 Cython 退出，未调用 provider；只读核对确认 Admin 平台 Embedding 配置有效。随后将 Cython 安装到一次性临时目录重跑，真实 query provider **5/5 成功**，TS/Cython 最终响应与候选排序完全一致，P95 为 85.274→48.864ms（改善 42.7%）。缓存文档向量仍为 0，故该运行验证 provider/query-vector 路径，但 RAG 检索仍是 lexical-only，不宣称真实向量 Hybrid 等价；未生成文档向量或修改 Admin/服务配置。`RAG11-006` 的完整协议错误/特殊输入审计仍未完成，`RAG11-008` 的真实向量 Hybrid A/B 仍未验收。

### 2026-10-31 性能优先优化复测

新增 BM25 合并语料统计缓存：只以当前不可变持久/瞬态索引对象作为缓存身份，文档索引变更时失效，向量单独刷新不触发无关重算；IDF 统计和公式未删减。真实只读 synthetic-vector A/B：8,587 份索引文档、8 类来源、40 条分层真实内容查询、每条每端 3 轮；Top-K 顺序 40/40 一致（由此宏平均 Jaccard 为 1.0），来源命中率双方 0.975，IDF 项一致率 0.994996。热查询 Cython P50/P95 为 66.406/142.709ms，TS 为 144.503/287.052ms；Cython 快照恢复 1.491s，快于 TS 索引加载 5.243s；Cython 全量重建 6.064s，仍慢于 TS 加载。峰值 RSS 架构估算比 0.9648、加载后驻留比 0.8111。Cython 扩展编译 17.272s 单独计量，不计入热查询。

Memory prepare 仍是主要性能缺口：同次 A/B 为 Cython 2.466s、TS 0.693s；单独分段探针（冷 transient index）观测到缓存向量读取/解析约 0.530s、transient BM25 构建约 0.765s、索引替换总段约 0.837s（包含前述构建），owner Memory index 读取约 0.035s，daily source projection 约 0.002s。后续优化应优先验证跨 run transient 索引复用、向量缓存读取/映射和无变更路径，不应重复建立已经缓存的词项/DF。Memory lexical 候选目前与 TS 并非逐查询完全一致；此外测试侧同时观察到 persistent/transient Memory slot 冲突，需把搜索分数对比与持久优先响应投影分开审计，不能据 wire 文本差异直接推断投影错误。全量最终 Top-K 指标满足当前 90% 门槛，但这不等于 Memory 子链路已完成质量验收。

随后优化了 Cython Memory prepare：不同授权 scope 的 Memory 读取改为最多 4 路并发，保留 scope 输入顺序；snapshot 覆盖过滤将整段 snapshot 的空白归一与 UTF-16 编码从“每篇文档一次”改为“每次 prepare 一次”。合成 microbenchmark（300 篇文档、6,600 字符 snapshot）该过滤段中位数由 29.16ms 降至 2.30ms（12.7×）；此结果只代表过滤子步骤，不代表完整 Memory prepare 或真实语料端到端提速。生命周期与全部 RAG 串行回归为 357 passed。尝试进行 devserver A/B 前发现同步会话有两个与本次文件无关的既存冲突，因此没有 flush/改动远端，也未宣称真实端到端复测完成；需冲突处理后再测 2.466s vs 0.693s 的完整 prepare 路径。

为直接对应新版验收，本轮基准新增最终 Top-K 宏平均及按来源 Jaccard 字段；此前的 exact response/排序字段保留为诊断值，不再作为强制门槛。本地 `tests/agent/rag` 串行 **355 passed**。真实向量 Hybrid、完整 Memory 质量归因仍需观察；生产接线和旧 TS 清理不属于本阶段。

### Phase 3：开发环境直接接入与观察

- [ ] `RAG11-009` 在 devserver 显式设置 `search.rag_backend=cython` 并开始观察；验收：只有 Cython 查询、无双跑；快照恢复/增量、Memory prepare、来源和引用、安全隔离与端到端耗时可用，失败时能人工切回 TS。
- [ ] `RAG11-010` 观察期后独立评审是否迁移生产及清理 TS RAG；本 PRD 不授权生产切换，也不要求观察期内删除回滚基线。
