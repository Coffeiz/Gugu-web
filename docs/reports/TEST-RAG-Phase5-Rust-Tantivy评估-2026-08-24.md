# RAG Phase 5：Rust/Tantivy 与 PostgreSQL 原生检索评估

> 日期：2026-08-24
> 环境：devserver
> 结论：Rust/Tantivy sidecar 已完成首版接入；Rust 为默认词法后端，Python BM25 保留为 Admin 可切换的兼容后端。两者共用 owner 级 TTL/LRU/预算缓存。
> 本文只记录聚合指标、架构判断和迁移边界，不记录账号、正文、文件名或查询原文。

## 1. 评估范围

本阶段评估三条路径：

1. 当前 Python 进程内 BM25 缓存；
2. PostgreSQL 原生检索（`pg_trgm` / FTS）；
3. Rust/Tantivy 独立索引或本地 sidecar。

评估标准：查询延迟、索引更新、中文分词质量、跨进程一致性、权限隔离、部署复杂度和故障恢复。

## 2. 当前真实数据基线

devserver 当前单个 owner 的统一索引为 4,063 个 chunk：

| 指标 | 结果 |
| --- | ---: |
| 已接入 Global Search 的索引来源 | project / file / note |
| 已接入来源 BM25 热查询 P50 | 14.24ms |
| 已接入来源 BM25 热查询 P95 | 19.56ms |
| 已接入来源 ILIKE P50 | 7.63ms |
| 已接入来源 ILIKE P95 | 12.78ms |
| 全量 Global Search 混合路径 P50 | 55.45ms |
| 全量 Global Search 混合路径 P95 | 74.97ms |
| 全量 Global Search ILIKE P50 | 49.55ms |
| 全量 Global Search ILIKE P95 | 70.57ms |
| BM25 与 ILIKE 结果重叠率 | 已接入来源平均 88.33%；全量平均 92.22% |
| owner 权限检查 | 71 条结果，越权 0 |
| BM25 构建额外 RSS | 约 29MB |

当前瓶颈不是倒排结构本身。索引路径仍需要：

- 按来源读取和校验 owner；
- 把 BM25 命中的 source id 回查业务表；
- 补齐文件展示字段和便签 `version`；
- 合并未接入索引的来源 ILIKE 结果。

因此，把 BM25 迁移到 Rust 并不会自动消除当前主要耗时。

## 3. 方案评估

### 3.1 Python 进程内 BM25

当前方案已经满足现阶段规模，并已与 Rust 统一缓存生命周期：

- 复用现有中文分词和结果语义；
- `knowledge_index_entries` 作为可重建 canonical chunk；
- 按 owner/backend/revision 缓存，查询时应用 source/scope 过滤；
- transient Memory/Project 文档按 owner + backend + 文档 fingerprint 缓存；
- 与 Rust 共用单 owner 32MB、全局 512MB、30 分钟空闲 TTL 和 LRU 淘汰；
- 不增加服务进程和部署依赖；
- 发生异常时可以切回 ILIKE。

当前问题是跨 worker 各自持有缓存、冷启动有构建成本，以及 Global Search 的业务表回查成本。它们仍可以在 Python/数据库层优化。

### 3.2 PostgreSQL 原生检索

`pg_trgm` 更接近现有 ILIKE 的包含匹配语义，适合先解决数据库扫描问题；PostgreSQL FTS 则需要额外确认中文分词和 BM25 结果质量。

优点：

- 索引和事务在同一数据库内；
- 不需要新增运行时；
- ownership 条件和业务字段可以在同一条 SQL 中完成；
- 更容易保持现有 API 返回结构。

风险：

- `pg_trgm` 不是 BM25，排序语义需要重新校准；
- FTS 中文分词质量不能直接假设与当前 Jieba/BM25 等价；
- 生产数据库需要扩展、migration 和索引空间评估。

判断：如果下一阶段目标是降低 ILIKE 的数据库扫描成本，PostgreSQL `pg_trgm` 应先于 Rust/Tantivy 做小范围实验。

### 3.3 Rust/Tantivy

Tantivy 提供 Lucene 风格的 BM25、倒排索引和增量写入。文档说明文档在 `IndexWriter.commit()` 后才对新查询可见，更新通常表现为删除旧文档并重新索引；崩溃恢复回到上一次 commit。

优点：

- 更成熟的段式倒排索引和查询执行；
- 增量 commit、segment merge 和索引文件持久化；
- 可以把检索内存和 CPU 从 Python worker 中分离；
- 未来达到百万级 chunk 或多租户高并发时更有扩展空间。

新增成本：

- 需要 Rust 构建链、版本发布和 devserver 部署链路；
- 需要实现 Python ↔ Rust 协议、健康检查、超时和进程重启；
- 需要把 Jieba 产出的 token 或等价中文 tokenizer 固化到 Rust 侧，不能直接假设 Tantivy 默认 tokenizer 与当前结果一致；
- 需要维护 owner/scope 字段、删除版本、索引 revision 和数据库 canonical chunk 同步；
- 仍然需要业务表回查，除非索引存储完整展示字段，但这会引入字段同步和隐私边界风险；
- 独立服务故障时必须稳定回退 ILIKE，不能阻塞聊天和全局搜索。

## 4. 触发条件审查

原 PRD 的 Rust/Tantivy 触发条件逐项检查如下：

| 条件 | 当前状态 | 结论 |
| --- | --- | --- |
| 进程内索引 P95 无法满足目标 | 已接入来源 BM25 P95 19.56ms；全量混合路径 P95 74.97ms，但主要受业务回查和 ILIKE 混合影响 | 尚未证明 Rust 能解决，暂不触发 |
| 单用户索引超过 10 万 chunk | 当前 4,063 chunk | 未达到 |
| 多进程索引内存明显影响 Agent | 当前构建额外 RSS 约 29MB，缓存已有 32MB 单 owner 限额和 LRU | 未达到 |
| 增量提交或跨进程一致性成为主要瓶颈 | 当前通过数据库 revision 和事件失效，尚未成为故障主因 | 未达到 |

## 4.1 Rust BM25 原型基准

为了验证“Rust 是否只在 BM25 核心上有明显收益”，新增了一个不接入生产链路的独立基准：

- Rust 原型：`backend/tests/benchmarks/rust_bm25_bench.rs`；
- 对照脚本：`backend/tests/benchmarks/run_rust_bm25_bench.py`；
- 数据：devserver 当前索引量最多的单个 owner，4,063 个真实 chunk；
- 查询：沿用 Phase 4 的 5 个固定中文查询；
- Rust 与 Python 使用同一份 Python/Jieba 预分词 TSV，BM25 参数均为 `k1=1.2, b=0.75`；
- Python 测试的是当前生产 `BM25`：建索引时包含当前分词，查询时包含当前查询分词和逐文档扫描；
- Rust 测试的是预分词后的倒排表：建索引包含 TSV 解析和倒排表构建，热查询只走倒排 posting；
- devserver 没有 Rust 工具链，因此 Python 在 devserver 执行，Rust 使用本机 `rustc 1.97.1` 执行；该结果只用于算法级量级判断，不作为同机端到端 SLA。

### 4.1.1 结果

| 指标 | 当前 Python BM25 | Rust 倒排 BM25 原型 | Rust/Python |
| --- | ---: | ---: | ---: |
| 文档数 | 4,063 | 4,063 | — |
| 冷启动建索引均值 | 1,310.89ms | 72.41ms | 0.055x |
| 冷启动建索引 P50 | 1,301.86ms | 73.64ms | 0.057x |
| 冷启动建索引 P95 | 1,466.21ms | 76.26ms | 0.052x |
| 热查询均值（单 query） | 8.5578ms | 0.0905ms | 0.011x |
| 热查询 P50 | 7.9693ms | 0.0896ms | 0.011x |
| 热查询 P95 | 10.9826ms | 0.1043ms | 0.009x |
| 平均返回数 | 10.00 | 10.00 | — |

按均值粗略计算，Rust 原型的建索引约快 **18.1 倍**，热查询约快 **94.6 倍**。这个差异主要来自两点：

1. Rust 使用倒排表，只计算命中 posting 的文档；当前 Python `BM25.search()` 会遍历全部文档；
2. Rust 基准复用了预分词结果，不包含 Jieba 初始化和查询分词，不能直接解释成完整 Python 服务迁移后的收益。

本次基准只验证了 BM25 核心执行模型，没有覆盖数据库 owner/scope 过滤、索引 revision、业务表回查、结果排序兼容、进程间同步和故障回退。因此它支持“未来规模上升后值得做 Tantivy/Rust spike”的判断，但不足以改变当前生产决策。

### 4.1.2 复跑与限制

1. 在 devserver 的 backend 环境运行 `run_rust_bm25_bench.py`，生成 `/tmp/gugu-rag-bm25-corpus.tsv` 和 `/tmp/gugu-rag-bm25-queries.txt`；
2. 在安装 Rust 1.70+ 的同一台机器上编译并运行 `rust_bm25_bench.rs`；
3. 比较时必须把 Python 和 Rust 放到同一台机器，并分别增加 tokenizer、owner/scope 过滤和结果回查阶段，才能形成决策级端到端数据；
4. 当前算法原型不写入数据库、不启动 sidecar；线上词法后端由 Admin 的 Rust/Python 选择控制，Global Search 的 ILIKE/BM25 选择仍由独立开关控制。

## 4.2 Tantivy sidecar 协议对照

在同一份 4,063 chunk 预分词语料上，又对 Tantivy JSONL sidecar 做了真实协议基准。测试包含 JSON 序列化、stdin/stdout 往返和 sidecar 进程启动；Python 基线使用统一缓存层中的生产适配器，因此硬件不同，结果只作为量级参考。

| 指标 | Python BM25（devserver） | Tantivy sidecar（本机） |
| --- | ---: | ---: |
| 冷启动建索引均值 | 1,310.89ms | 110.41ms |
| 冷启动建索引 P50 | 1,301.86ms | 51.92ms |
| 冷启动建索引 P95 | 1,466.21ms | 628.29ms |
| 热查询均值（单 query） | 8.5578ms | 0.1174ms |
| 热查询 P50 | 7.9693ms | 0.1137ms |
| 热查询 P95 | 10.9826ms | 0.1201ms |
| 平均返回数 | 10.00 | 10.00 |

sidecar 热查询均值约为 Python 的 `1/72.9`，但冷启动 P95 仍受进程启动和首次 Tantivy 初始化影响。正式接入必须保持 sidecar 常驻，并把冷启动、投影 commit 和热查询分别计量；不能每轮搜索重新启动进程。

本轮还发现并修复了一个查询语义问题：初版 Tantivy QueryParser 默认使用 AND，导致结果数低于 Python 的 OR 召回；现在已移除该设置，协议基准平均返回数恢复为 10.00。后续仍需用标注集检查排序重叠率，不能只看返回数量。

### 4.2.1 devserver 同机速度复测

本轮在 devserver 同一台机器、同一份 `4,063` 个真实 chunk、同一组 5 个查询上复测 Python BM25、Tantivy sidecar 和 ILIKE。sidecar 测试使用已构建的 Linux x86_64 制品，包含 JSONL 往返和常驻进程查询；Python 使用当前临时回退实现；ILIKE 仅测数据库查询耗时，不作为召回结果对照。

| 指标 | Python BM25 | Tantivy sidecar | PostgreSQL ILIKE |
| --- | ---: | ---: | ---: |
| 冷启动/建索引均值 | 1431.61ms | 124.71ms | — |
| 冷启动/建索引 P50 | 1327.36ms | 124.29ms | — |
| 冷启动/建索引 P95 | 2209.40ms | 135.14ms | — |
| 热查询均值（单 query） | 9.1410ms | 0.2498ms | 17.8865ms |
| 热查询 P50 | 8.4279ms | 0.2586ms | 17.3542ms |
| 热查询 P95 | 9.6603ms | 0.3255ms | 19.3318ms |

在这组同机测试中，sidecar 热查询均值约为 Python BM25 的 `1/36.6`、ILIKE 的 `1/71.6`；建索引均值约为 Python 的 `1/11.5`。ILIKE 查询只匹配 `content` 字段，因此返回数不能与词法检索结果直接比较。

## 4.3 与 ILIKE 的同查询集对照

为了排除 Global Search 多来源编排和业务展示回查的影响，使用同一 owner、同一 4,063 个索引 chunk、同一组 5 个中文关键词，比较数据库 `content ILIKE '%q%' LIMIT 10` 与 Tantivy sidecar 热查询。

| 指标 | PostgreSQL ILIKE（devserver） | Tantivy sidecar（本机） |
| --- | ---: | ---: |
| 热查询均值（单 query） | 2.4296ms | 0.0704ms |
| 热查询 P50 | 2.3502ms | 0.0532ms |
| 热查询 P95 | 2.4983ms | 0.0850ms |
| 平均返回数 | 10.00 | 10.00 |

在这个“只看 chunk 检索核心”的对照中，Tantivy 热查询均值约为 ILIKE 的 `1/34.5`。但两侧不在同一台机器，且 ILIKE 可能命中 PostgreSQL 页缓存；这组数据不能直接替代生产端到端 P95。全量 Global Search 仍需把 owner/scope 权限、来源聚合、业务表回查和结果排序纳入同机测试。

## 4.4 Phase 4 回归结果（2026-08-24）

本轮补充了 sidecar 生产边界的回归测试：

| 场景 | 结果 |
| --- | --- |
| owner 过滤 | 通过；不同 owner 的同词文档不会互相返回 |
| source type 过滤 | 通过；查询只返回请求来源 |
| group scope 过滤 | 通过；同 owner 不同 group 不会串结果 |
| OR 词法语义 | 通过；保留当前 Python 召回的 OR 行为 |
| revision mismatch | 通过；旧 revision 返回明确错误 |
| 空索引 replace/search | 通过；清空后查询返回空结果 |
| 持久化索引重启 | 通过；重启后恢复 revision 和文档查询 |
| Python client 命令参数 | 通过；sidecar 参数使用 argv 传递，不经过 shell 拼接 |
| Python client scope 转发 | 通过；`RustLexicalIndex` 会同时传递 source 与 scope |
| Python client 协议错误 | 通过；sidecar error response 转为 `RustSidecarUnavailable` |

代码清理结果：

- 删除 `backend/agent/rag/lexical.py` 生产 BM25 实现；
- 生产调用方统一经过 lexical cache 接口，由 Admin 选择 Rust 或 Python 后端；
- `backend/agent/rag/legacy_lexical.py` 作为 Python BM25 的实现保留，Rust 不可用时业务层仍可按既有兼容边界回退；
- Python 分词独立到 `backend/agent/rag/tokenizer.py`，用于保持 Jieba 召回语义兼容；
- 新增 `rust/rag-sidecar/release-manifest.json`，规定 Docker/Linux 运行时只消费已验证的 `x86_64-unknown-linux-musl` 制品，业务环境不执行 Rust 构建；
- Rust sidecar 单元测试从 1 个增加到 3 个，全部通过。

Python RAG 定向回归已通过：`test_rag_lexical.py` + `test_rust_sidecar.py` 共 **7 passed**；Memory/Project/Injection/Global Search 组合回归共 **32 passed**。本地 backend 虚拟环境已补齐 requirements 中声明的 `jieba` 依赖。

## 5. 决策

### 当前决策：Rust/Tantivy sidecar 第一版完成，Python/Rust 共用缓存编排

Phase 5 的 Spike 和 sidecar 第一版已完成，统一缓存已落地；Global Search 仍以质量门槛作为 ILIKE/BM25 默认切换条件。当前继续：

1. Rust 为词法后端默认值，Python BM25 通过 Admin 开关切换；Global Search 的 ILIKE 兼容模式仍由独立开关控制；
2. 保持 `IndexDocument`、`KnowledgeIndexEntry` 和 Global Search 返回结构稳定；
3. 补齐同机 tokenizer、Python client、权限、回查和回退测试；
4. 完成 Linux release binary 的部署与进程生命周期管理；Rust sidecar 生命周期由统一缓存淘汰/失效路径管理；
5. 原型基准显示 Rust 倒排核心有数量级潜力；sidecar 已补齐持久化、过滤、revision 和 JSONL 协议，再进入生产灰度。

### Rust 构建顺序

1. 建立 Rust/Tantivy workspace 和最小 sidecar 协议；
2. 实现索引文档投影、owner/scope 字段、revision 和批量 commit；
3. 实现查询、健康检查、超时、revision 不一致和 ILIKE 回退；
4. 用真实数据完成同机 P50/P95、Recall@K、更新延迟、RSS 和故障恢复验收；
5. 保持 Admin 开关，验收后再逐来源灰度启用。

### 生产化验收范围

- 输入：脱敏后的 `IndexDocument` 投影事件，带 owner/source/scope/version/chunk id；
- 输出：`source_type/source_id/chunk_id/score/index_revision`，不直接输出业务正文；
- 权限：Python 侧先做 owner/scope 条件，Rust 侧只作第二层字段过滤；
- 一致性：数据库 commit 成功后投影，按 revision 批量提交，reader reload 后才切换；
- 故障：健康检查失败、revision 不匹配或超时都回退 ILIKE；
- 验收：与当前标注集比较 Recall@K、结果重叠率、P50/P95、更新延迟和 RSS。

### Devserver 同步状态（2026-08-24）

- Mutagen `gugu-web` 已同步 `rust/` workspace、sidecar 源码和协议文档；
- devserver 宿主机已确认存在 Rust `1.98.0` / Cargo `1.98.0`，使用同步到临时目录的 Cargo 缓存离线完成 Linux `x86_64-unknown-linux-gnu` release 构建；
- 产物已生成到 `backend/bin/gugu-rag-sidecar`，大小约 `8.2MB`，通过 `--version` 返回 `gugu-rag-sidecar 0.1.0`；当前产物为 Linux GNU 动态链接 ELF，尚未签发 musl 制品；
- sidecar JSONL 协议 smoke test 已通过：`ping`、真实文档 `replace`、owner/source 过滤 `search` 均返回成功；
- 使用 devserver 真实数据库中索引量最多的 owner 做业务路径测试：索引包含 `4,063` 个 chunk，`project/file` 查询返回 `10` 条结果，来源过滤和结果 ID 完整性通过，首次构建并查询耗时约 `2.38s`；Global Search 真实入口返回 `5` 组结果且无错误；
- devserver 回归测试 `tests/test_rag_lexical.py tests/test_rust_sidecar.py tests/test_global_search.py` 全部通过：`20 passed in 4.30s`；
- 业务默认配置仍保持 ILIKE，以上 Rust 测试通过临时进程内开关和临时索引目录完成，未改变线上默认路径，也未重启后端服务；
- 构建物已保留：`backend/bin/gugu-rag-sidecar-linux-x86_64`（Linux GNU）和 `backend/bin/gugu-rag-sidecar-macos-arm64`（macOS arm64），默认运行入口仍为 `backend/bin/gugu-rag-sidecar`；
- 下一步由 release pipeline 在 Linux/Docker 中产出并签核固定的 `x86_64-unknown-linux-musl` 制品，再替换当前 GNU 验证产物。首期只维护 `linux/amd64`，ARM 以后以独立制品增加。

## 6. 参考资料

- [Tantivy 官方仓库](https://github.com/quickwit-oss/tantivy)
- [Tantivy 官方 API 文档](https://docs.rs/tantivy/latest/tantivy/)
- [Tantivy 架构说明](https://docs.rs/crate/tantivy/latest/source/ARCHITECTURE.md)
