# 持久化检索索引与搜索加速

> 状态：Phase 4 已完成首版灰度接入；数据库 chunk 持久化、BM25 倒排索引与 Global Search 后端切换已落地。Global Search 默认仍使用 ILIKE；词法召回后端默认使用 Rust，Python BM25 可由 Admin 切换。
> 本文只描述索引存储、检索实现和性能优化，不替代 `PRD-RAG-1-统一知识召回与索引` 的 RAG 业务协议。

## 1. 背景与问题

当前统一知识索引已经把各类来源切分为稳定 chunk，并持久化到数据库表
`knowledge_index_entries`。但查询时仍然会：

1. 从数据库读取当前用户的全部 chunk；
2. 在 Python 中重新分词并构建 BM25；
3. 执行本次查询；
4. 丢弃本次构建的 BM25 结构。

这意味着目前持久化的是“可检索文档数据”，不是“可直接查询的 BM25 索引”。

当前 devserver 真实数据基线：

- 统一索引：4,063 个 chunk；
- `项目` 查询：ILIKE 中位数约 25ms，临时 BM25 中位数约 366ms；
- `画布` 查询：ILIKE 中位数约 24ms，临时 BM25 中位数约 391ms；
- `提醒` 查询：ILIKE 中位数约 23ms，临时 BM25 中位数约 333ms。

当前 BM25 方案不能直接替换 ILIKE。上述差异主要来自全量加载和重复构建，而不是 BM25 算法本身。

## 2. 目标

### 2.1 P0 目标

- BM25 的分词结果、倒排表、文档频率和必要统计信息不在每次查询时重建；
- 索引更新可增量执行，避免全量重建；
- 更新、删除、权限变更后不会召回旧文档；
- 索引查询始终先经过 owner 和 scope 隔离；
- 失败时可以回退到当前稳定的 ILIKE 或业务查询路径；
- 不把聊天正文、文件正文或用户标识写入可见诊断日志。

### 2.2 P1 目标

- 支持 Global Search 与 Knowledge RAG 复用同一份索引投影；
- 支持查询延迟、索引版本、命中数和更新延迟的脱敏诊断；
- 支持多进程 Web/Worker 并发读写；
- 支持中文、英文和中英文混合文本；
- 对索引重建、增量更新和故障恢复提供自动化测试。

### 2.3 非目标

- 本 PRD 不重新设计 RAG scope、history 注入或去重规则；
- 第一阶段不引入独立向量数据库；
- 不默认引入 LLM 摘要或 reranker；
- 不改变现有 Global Search API 的返回结构；
- 不为了性能删除业务数据库中的原始数据。

## 3. 术语与边界

| 名称 | 含义 |
| --- | --- |
| 主数据 | Project、File、MindNode、ConversationMessage 等业务表中的事实数据 |
| IndexDocument | RAG 内部的来源无关文档契约 |
| IndexEntry | 持久化后的单个 chunk 及其来源、scope、版本和 hash |
| 倒排索引 | token 到文档/频次的映射，用于快速候选召回 |
| 索引版本 | 当前索引结构和分词配置的版本，不等同于业务文档版本 |
| 业务版本 | 单个来源文档的内容版本，用于判断 chunk 是否需要更新 |

索引是主数据的可重建投影。任何时候都不能把索引当作业务事实来源，也不能跳过业务层 ownership 校验。

## 4. 目标架构

```text
业务数据变更
    ↓
SourceAdapter 生成 IndexDocument
    ↓
版本/hash 判断是否需要更新
    ↓
持久化 IndexEntry
    ↓
构建或增量更新倒排索引
    ↓
Global Search / Knowledge Retriever
    ↓
统一的 scope 过滤、去重、引用和预算
```

数据库中的 `knowledge_index_entries` 继续保存可恢复的规范 chunk。BM25 倒排结构可以：

- 存储在进程内并由版本变化触发重建；或
- 存储为本地可恢复索引文件；或
- 由 PostgreSQL/Rust 搜索引擎维护。

具体实现必须保持同一个 `IndexDocument` 和 `IndexEntry` 契约，避免不同搜索后端产生不同权限和结果语义。

## 5. 方案对比

### 5.1 方案 A：进程内持久复用 BM25

首选的低风险方案：

- 首次加载某个 owner/source 时构建 BM25；
- 后续查询复用内存中的倒排结构；
- 只在索引版本变化时增量或重建；
- 多进程之间通过数据库 `indexed_at`、索引版本或事件通知失效。

优点：改动小、无需新服务、容易保持现有 Python 分词和结果结构。

风险：每个进程各自占用内存；进程重启后需要恢复；增量更新逻辑需要严格测试。

### 5.2 方案 B：PostgreSQL 原生检索

可评估：

- `pg_trgm` 加速包含式匹配；
- PostgreSQL Full Text Search；
- 中文分词扩展或预分词字段。

优点：索引与数据库事务接近，跨进程一致性好，Global Search 接入成本低。

风险：默认 FTS 对中文分词和 BM25 语义不一定满足要求；扩展依赖需要纳入部署检查；与当前中文 BM25 的结果不可直接假设等价。

### 5.3 方案 C：Rust/Tantivy 独立索引

仅在数据规模或并发达到阈值后评估：

- Rust 负责 tokenizer、倒排索引、BM25 和增量提交；
- Gugu-web 通过本地库、进程协议或独立服务调用；
- 数据库仍作为可重建的 canonical chunk 来源。

优点：检索性能、索引持久化和并发能力更强。

风险：引入新运行时和部署链路；需要解决索引版本、跨进程失效、故障恢复和权限边界；不能只替换算法而忽略数据同步。

## 6. 实施阶段

### Phase 0：数据基线与持久化 chunk

状态：✅ 已完成

- 新增 `knowledge_index_entries` 数据库模型；
- 保存 source、scope、document version、chunk、content hash 和更新时间；
- 覆盖 memory、project、file、note、canvas、calendar、scheduled_task、conversation；
- 增加 owner 级重建脚本；
- 只输出聚合诊断，不输出正文。

### Phase 1：公平检索对照

状态：✅ 已完成

- 对同一 owner、同一 query、同一来源集合分别测试 ILIKE 和持久化 chunk + BM25；
- 记录命中数、P50/P95、候选数和越权结果数；
- 明确区分冷启动全量加载、索引构建和热查询耗时；
- 当前公平基线已拆分为索引冷加载、BM25 构建、热查询和 ILIKE 查询；
- 四类共同来源使用同一 owner 账号和同一 query 集合，输出不含正文；
- devserver 真实数据中共同来源为 3,056 个 chunk，索引冷加载约 288ms，首次构建约 211ms；
- 热 BM25 查询中位数约 2.1～3.1ms，ILIKE 查询中位数约 34.8～36.2ms；
- 三个测试 query 的 BM25 Top 10 与 ILIKE 命中集合重叠率均为 100%；
- 结论：BM25 结构复用后明显快于 ILIKE，但冷加载和构建成本不能计入热查询；Phase 2 仍需解决进程内缓存与跨 worker 失效。

### Phase 2：进程内索引复用

状态：✅ 已完成

- 按 owner/backend/index revision 缓存倒排结构；同一 owner 的 Rust 与 Python 后端不会复用彼此的缓存对象；
- 同一进程内查询不重复加载和构建；
- 已接入 `RagIndexUpdated` 的 source 事件触发对应缓存失效；
- 进程重启后从 `knowledge_index_entries` 恢复；
- Rust 与 Python 共享同一套缓存生命周期：单用户累计上限 `32MB`，全局缓存上限 `512MB`；缓存条目可以是统一 owner 索引，也可以是带 fingerprint 的 transient 来源索引；
- 空闲 `30 分钟`后卸载，超过上限按 LRU 淘汰；
- 通过 `indexed_at` revision 检查其他 worker 的索引变更；
- 已记录索引估算内存和热查询指标；
- 增加并发读取与更新测试。

### Phase 3：增量更新与故障恢复

状态：✅ 已完成首版

- 按 `(source_id, document_version, chunk_index)` 增量 upsert 单个文档或 chunk；
- 新版本写入后清理不在本次投影中的 stale chunk；
- 事务失败时数据库保留上一份完整投影；已接入事件的缓存会立即失效，其他 worker 通过 revision 检查后重新加载；
- 更新 `indexed_at` 作为跨 worker revision；
- 已补充用户隔离、缓存复用和版本变化失效测试；
- 独立异步物理清理任务和多进程压力验证后置到生产灰度阶段。

当前实现数据简表：

| 指标 | 结果 |
| --- | ---: |
| 全量统一索引 | 4,063 chunks |
| ILIKE/BM25 公平对照集合 | 3,056 chunks |
| BM25 热查询中位数 | 约 2.1～3.1ms |
| ILIKE 查询中位数 | 约 34.8～36.2ms |
| 单用户 Rust/Python 词法缓存上限 | 32MB |
| 空闲卸载 TTL | 30 分钟 |
| 全局缓存上限 | 512MB |

详细数据见 [`TEST-RAG-索引持久化与BM25缓存-2026-08-24.md`](../../reports/TEST-RAG-索引持久化与BM25缓存-2026-08-24.md)。

### Phase 4：Global Search 灰度接入

状态：✅ 已完成首版灰度；Global Search 默认使用 ILIKE，Admin 可开启持久化索引进行灰度验证；持久化词法索引内部默认使用 Rust，Python 可切换。

实现范围：

- `run_global_search` 保持原有请求参数和返回结构，增加搜索后端选择，不让前端和 Agent 工具感知两套协议；
- 项目、文件、便签使用已完成的持久化 BM25 索引，并回查业务表补齐原有展示字段和便签版本号；
- 对话、日程、客户、文件夹等尚未纳入统一索引的来源继续使用原 ILIKE 查询；
- 某个已支持来源尚未建立任何索引行时，该来源自动保留 ILIKE 查询，避免索引未重建导致结果静默丢失；
- Admin「Agent → 搜索与图片 → 站内全局搜索后端」提供「持久化索引（BM25）」与「ILIKE 兼容模式」切换，默认 ILIKE，配置热生效；
- 索引路径沿用 owner 条件和业务表回查，返回结构、权限边界和便签乐观锁字段不变。

Phase 4 TODO / 验收：

- [x] 增加 Admin 搜索后端开关，默认 ILIKE、可开启持久化索引；
- [x] 仅接入明确已有索引投影的来源；
- [x] 保留未建索引来源的 ILIKE 路径；
- [x] 保持 Global Search API 返回结构和便签 `version` 字段；
- [x] 增加索引/兼容路径的单元测试覆盖；
- [x] 用真实数据对比召回覆盖率、排序和 P95；
- [ ] 在召回重叠率和 P95 达到质量门槛后再切换默认路径；
- [ ] 通过验收后再决定是否扩展文件夹、客户、日程和对话来源。

### Phase 5：Rust/Tantivy 检索引擎构建

状态：✅ Phase 5 Spike/sidecar 第一版完成，生产灰度待同机端到端验收。

> **运行时制品约束（2026-08-24）**：sidecar 不在业务环境自行构建。Docker/Linux 首期统一消费 release pipeline 生成并验收的 `x86_64-unknown-linux-musl` 稳定制品；业务代码只启动项目内固定路径或镜像内制品。ARM 作为未来独立制品维护。

评估报告：[`TEST-RAG-Phase5-Rust-Tantivy评估-2026-08-24.md`](../../reports/TEST-RAG-Phase5-Rust-Tantivy评估-2026-08-24.md)

结论：独立 Rust BM25 原型已完成算法级对照，Tantivy JSONL sidecar 第一版也已完成。在 4,063 个真实 chunk 上，Rust 倒排核心的建索引和热查询均明显快于 Python BM25。当前运行时已经让 Rust 与 Python 共用 owner 级 TTL/LRU/预算缓存，Admin 可按后端切换；Rust 继续作为默认词法后端，Python 保留为可验证的兼容路径。

实施边界：

1. Rust/Tantivy 只负责分词后的倒排索引、BM25、revision 和候选 ID/score；
2. Python 负责 owner/scope 权限、业务表回查、展示字段和最终 API 响应；
3. 数据库事务成功后再投影索引，按 revision 批量提交；
4. sidecar 不可用、revision 不一致、超时或协议错误时回退 ILIKE；
5. 首阶段保留 Admin 的 Rust/Python 词法后端开关；Rust sidecar 不可用时按既有错误边界回退兼容路径，不改变缓存预算和 TTL 语义。

已完成文件：

- `rust/Cargo.toml`：Rust workspace；
- `rust/rag-sidecar/Cargo.toml`：Tantivy/Serde 依赖；
- `rust/rag-sidecar/src/main.rs`：JSONL stdin/stdout sidecar、持久化索引、过滤、revision 和单测；
- `rust/rag-sidecar/README.md`：构建、运行和协议说明。

后续优先级：

1. 优化索引结果回查与召回语义，保持 ILIKE 为默认路径；
2. 完成同机端到端基准、Python client、索引重建/增量投影和故障回退测试；
3. 完成权限回查、结果质量和更新延迟验收；
4. 验收通过后再灰度替换 ILIKE，不满足质量或一致性指标时继续保留 ILIKE。

触发条件：

- 进程内索引复用后 P95 仍无法满足目标；
- 单用户索引超过 10 万 chunk；
- 多进程索引内存占用明显影响 Agent；
- 增量提交或跨进程一致性已经成为主要瓶颈。

## 7. 一致性与权限要求

- 查询必须携带 owner_user_id，并在数据库查询阶段完成 owner 过滤；
- 群聊、群友、私聊和 owner 使用不同 scope，不能仅依赖搜索结果后过滤；
- source_id、document_id、chunk_id 不作为权限依据；
- 版本变化后旧 chunk 不得继续进入召回；
- 索引落后时允许暂时无命中或回退主数据查询，不允许返回其他用户结果；
- 索引和倒排文件不得进入 Git；
- 日志只能记录 source type、数量、耗时、revision 和脱敏 digest。

## 8. 验收指标

### 正确性

- 同一 query 在 ILIKE 和索引路径中能追踪来源差异；
- owner、group、member scope 越权结果为 0；
- 更新、删除和恢复后的索引结果符合版本状态；
- 结构化 tool history、附件和二进制文件不会被误写入正文索引。

### 性能

- 热查询必须单独统计，不把冷启动索引构建混入查询耗时；
- 记录 P50、P95、P99 和最大耗时；
- 记录索引构建耗时、更新延迟和内存占用；
- 在至少 1、10、100、1000、10000 个 chunk 的虚拟数据规模下测试；
- 真实数据测试只输出聚合指标，不输出正文、文件名或账号信息。

当前内存基线（devserver，3,056 个共同来源 chunk，单进程冷启动）：

- 数据库 chunk 加载约 313ms，RSS 增量约 20MB；
- BM25 构建约 189ms，额外 RSS 增量约 29MB；
- Python BM25 热查询中位数约 3.2ms，P95 约 5.6ms；
- 该结果说明进程内复用有明显收益，但接近 `32MB` 单用户上限；因此必须按来源拆分缓存，不能把所有来源合并成一个不可淘汰的大索引。

### 质量

- 维护不含敏感正文的标注集；
- 比较 Recall@K、Precision@K、结果稳定性和重复率；
- Global Search 不得因为切换索引改变权限语义；
- Knowledge RAG 继续使用统一去重、引用和 3000 字符预算。

## 9. 文件计划

已创建：

- `backend/app/models/__init__.py`：`KnowledgeIndexEntry`；
- `backend/agent/rag/persistent_store.py`：数据库索引 chunk 存取和查询；
- `backend/agent/rag/index_builder.py`：各来源投影和 owner 级重建；
- `backend/scripts/rebuild_knowledge_index.py`：重建入口；
- `backend/scripts/compare_ilike_index.py`：对照测试入口。

后续可能新增：

- `backend/agent/rag/index_cache.py`：进程内倒排索引缓存；
- `backend/agent/rag/index_revision.py`：跨进程 revision/失效协议；
- `backend/tests/test_persistent_knowledge_index.py`：索引更新、删除、scope 和恢复测试；
- PostgreSQL migration 或 Rust/Tantivy 独立索引目录，必须在方案评估后再创建。

## 10. 当前结论

数据库持久化 chunk 已经证明可行，但“持久化 chunk”不等于“持久化 BM25”。当前最合理的下一步是先做进程内倒排结构复用，并将冷启动、构建和热查询拆开测量。只有当这一层仍不能满足性能目标时，才引入 Rust/Tantivy 或 PostgreSQL 原生检索，避免用新语言掩盖查询链路中的全量读取问题。
