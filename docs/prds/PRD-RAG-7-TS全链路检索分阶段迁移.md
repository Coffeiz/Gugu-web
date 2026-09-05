# PRD-RAG-7：RAG 全链路 TypeScript 化分阶段迁移

## 1. 状态

**状态：规划中，Phase 0 未开始。**

本 PRD 是 PRD-RAG-5、PRD-RAG-6 的后续迁移计划。目标是逐步让 RAG 的检索计算、批量召回、排序和索引生命周期收敛到 TypeScript Worker，同时保留 Python 对业务数据、权限和 Agent 上下文的责任边界，避免一次性重写 RAG 主链。

## 2. 背景

当前 RAG 已使用 TypeScript Worker 作为生产词法索引和评分实现，但一次统一召回仍可能执行多次 sidecar 查询：

```text
memory       → sidecar search
knowledge    → sidecar search
project      → sidecar search
file         → sidecar search
canvas       → sidecar search
conversation → sidecar search
```

Python 侧通过 `asyncio.gather()` 并发发起查询，但同一用户复用一个 `TsSidecarClient`，客户端内部仍使用单锁保护 JSONL 请求。因此后发查询会等待前一个请求完成，当前 `sidecar_search_ms` 可能同时包含排队等待和实际查询时间。

现有 TypeScript Worker 已经具备 `unified_search`、BM25、来源过滤、scope 过滤、候选排序、去重和字符预算能力，但直接切换到该接口会改变现有 Python 的 embedding/hybrid、权限复核、会话水位和结果注入语义。因此本项目采用分阶段迁移，每阶段都必须保留可回退路径和行为回归。

## 3. 目标

1. 将多个来源的 sidecar 查询合并为一次 TypeScript batch search，消除同一请求内的重复 tokenize、IPC 和排队等待。
2. 逐步把 BM25、候选归一化、去重、来源限制、字符预算和最终排序迁移到 TypeScript Worker。
3. 最终让 TypeScript 负责 RAG 检索计算和索引生命周期，Python 负责业务数据加载、权限事实、用户身份和 Agent 上下文注入。
4. 保持现有召回结果、权限边界、引用结构、会话消息水位和 embedding/hybrid 行为可验证、可回滚。
5. 建立统一的检索诊断：文档加载、sidecar 排队、实际查询、排序和注入耗时分别可观测。

## 4. 非目标与约束

- 不让 TypeScript Worker 直接连接业务数据库。
- 不把 TypeScript Worker 变成公网服务；继续使用本机 JSONL sidecar。
- 不在第一阶段迁移 embedding 服务、API Key 或向量存储。
- 不绕过 Python 的 owner、workspace、project、folder、canvas、group/member 权限校验。
- 不改变 `read_file`、`canvas_get`、`read_conversation` 等精确工具的权限和行为。
- 不删除 Python 回退路径，直到对应阶段的 shadow/对比测试和生产灰度完成。
- 不把用户正文、附件名、查询原文、密钥或内部路径写入诊断日志。

## 5. 目标架构

```text
Python
  ├─ 读取业务数据
  ├─ 构造 IndexDocument
  ├─ owner/scope 权限初筛
  ├─ embedding 生成
  └─ Agent 上下文注入
          │
          │  一次 batch_search / rank 请求
          ▼
TypeScript Worker
  ├─ tokenizer
  ├─ lexical index
  ├─ BM25 多来源召回
  ├─ 来源/Scope 过滤
  ├─ hybrid 分数融合（后续阶段）
  ├─ 去重、多样性、字符预算
  └─ 稳定排序与诊断
```

最终不要求 TypeScript 接管权限事实来源。Python 始终负责确认“哪些文档允许被查询”，TypeScript 负责“允许的文档如何高效检索和排序”。

## 6. 分阶段方案

### Phase 0：基线、协议和诊断冻结

目标：在改变查询形态前锁定当前行为。

- [ ] 记录同一 query、scope、revision 下各来源候选 ID、分数、排序和最终注入结果。
- [ ] 固定 `search_ms`、`sidecar_search_ms`、`sidecar_queue_wait_ms`、`sidecar_query_ms` 的定义。
- [ ] 将 `sidecar_reused=null` 明确定义为“本轮未执行复用检查”。
- [ ] 建立冷启动、索引重建、warm cache、worker 重启和查询失败基线。
- [ ] 确认当前 `unified_search` 与 Python `rank_candidates` 的语义差异，禁止直接替换。

验收：同一 fixture 可以重复生成 Python 当前主链的候选和诊断基线。

### Phase 1：Batch Lexical Search

目标：一次 sidecar 请求完成多个来源的词法召回，但不改变 Python 的最终排序。

```text
Python 加载文档并完成权限初筛
        ↓
TS 一次 tokenize + 一次索引扫描
        ↓
按 source_type 返回候选和来源诊断
        ↓
Python 保留 embedding/hybrid、rank、权限复核和上下文注入
```

- [ ] 在 `backend/ts/packages/contracts/src/rag.ts` 新增 `batch_search` 请求/响应契约。
- [ ] Worker 一次计算 query tokens，并按来源返回候选结果。
- [ ] 保留每个来源的 `candidate_count`、`eligible_count`、`elapsed_ms`。
- [ ] Python `TsSidecarClient`、`TsLexicalIndex` 和 `index_cache` 增加 batch API。
- [ ] `UnifiedRetriever` 改为一次 batch 请求，不再对每个来源单独调用 sidecar。
- [ ] 保持 `UnifiedRecallService` 的 hybrid、权限、引用和最终排序不变。
- [ ] 增加 batch 与旧多请求路径的 shadow 对比，但不把 shadow 结果交付给用户。

验收：候选 ID 集合和 Python 最终排序与基线一致；同一请求的 sidecar IPC 次数由 N 次降为 1 次；不存在权限扩大。

### Phase 2：TS 统一候选排序

目标：将候选归一化、来源质量、去重、父节点限制、来源上限和字符预算迁移到 TS。

- [ ] 将当前 Python `rank_candidates` 的输入输出完整映射到 TS 协议。
- [ ] 固定 scoring version、来源质量、置信度阈值和 tie-break 规则。
- [ ] 支持 `exclude_content_hashes`、`max_per_source`、`max_per_parent` 和 `max_chars`。
- [ ] 保留 Python 结果回填和最终 scope 复核。
- [ ] 通过 shadow 对比记录结果差异，不允许直接以“分数接近”代替候选语义验证。
- [ ] 差异超过冻结阈值时停止推进，优先修正契约或算法，不新增隐式 fallback。

验收：TS 输出的候选身份、排序、来源上限、去重和字符预算达到冻结阈值；Python 不再执行正常路径的重复评分。

### Phase 3：TS 接管 hybrid 融合

目标：让 TS 统一处理 BM25 与 embedding 分数融合，Python 仍负责生成向量。

- [ ] 定义向量输入协议和向量版本字段。
- [ ] TS 实现与当前 Python 等价的 RRF/hybrid 计算。
- [ ] 明确 embedding 缺失、超时和禁用时的行为，不把异常伪装成零分。
- [ ] 保留 Python 侧 embedding provider、密钥和用户配置边界。
- [ ] 对 BM25-only、embedding-only、hybrid、空向量和部分向量失败补齐回归。

验收：三种策略下候选身份和排序达到冻结阈值；embedding 失败不会导致越权或无提示改变检索策略。

### Phase 4：TS 接管索引构建与更新

目标：将分块、source batch 投影、索引构建、patch、持久化和 revision 生命周期收口到 TS。

- [ ] Python 只提交带 `source_type`、`Scope`、版本和稳定 ID 的 source batch。
- [ ] TS 统一处理 source adapter、分块、replace、patch 和持久化索引。
- [ ] 保留 Python 的业务数据读取和权限初筛；Worker 不读取数据库。
- [ ] 覆盖文件、画布、项目、Knowledge、Memory 和 Conversation 的增删改同步。
- [ ] 验证 worker 重启、revision mismatch、索引损坏、并发 patch 和冷恢复。

验收：相同 source batch 产生稳定 revision 和可重建索引；增量更新不丢文档、不跨用户复用索引。

### Phase 5：统一 TS RAG 查询主链

目标：将生产 RAG 查询计算统一收口到 TS，Python 只保留业务边界和 Agent 注入。

```text
Python：user_id / query / scope / session watermark / 已授权 source batch
        ↓
TS：召回、融合、排序、过滤、引用和结构化诊断
        ↓
Python：最终授权复核、上下文注入和工具交付
```

- [ ] 将 `UnifiedRecallService` 的正常路径切换到统一 TS query。
- [ ] 保留 Python 最终权限复核和 conversation watermark 检查。
- [ ] 统一引用结构、来源标签、版本和内容指纹。
- [ ] 移除已被 TS 替代且没有诊断/回退价值的 Python 重复逻辑。
- [ ] 保留显式运维开关用于回退，不允许运行时静默切换实现。

验收：所有来源通过同一 TS 查询协议完成检索；结果、权限、引用和上下文预算通过完整回归；warm path P95 达到目标。

## 7. 诊断指标

每个来源和整次查询都应区分以下时间：

| 指标 | 含义 |
|---|---|
| `document_load_ms` | 业务文档从数据源加载并完成文档集合构造的耗时 |
| `index_lookup_ms` | Python 缓存/索引查找耗时 |
| `sidecar_queue_wait_ms` | 等待共享 sidecar client 锁的耗时 |
| `sidecar_query_ms` | 获得锁后实际发送并等待 Worker 响应的耗时 |
| `sidecar_search_ms` | sidecar 查询总耗时，约等于排队等待加实际查询 |
| `rank_candidates_ms` | TS 统一排序和过滤耗时 |
| `retrieve_ms` | 单一来源从开始到返回的总耗时 |

`sidecar_reused` 使用三态语义：

```text
true  = 本轮执行了复用检查且成功复用
false = 本轮执行了复用检查但未复用
null  = 本轮未执行复用检查，通常是 Python cache hit
```

## 8. 测试计划

- TypeScript Worker：协议、tokenize 一次性、来源分组、scope、revision、空结果和错误响应。
- Python client：batch 请求序列化、来源映射、队列耗时和 worker 重启。
- Retriever：batch 与旧多请求路径的候选身份、排序和诊断对比。
- 权限：owner、project、folder、canvas、group/member 和 conversation watermark。
- 排序：来源上限、父节点上限、重复内容、字符预算、低分补位和 tie-break。
- 生命周期：冷启动、warm cache、索引 patch、worker 崩溃、revision mismatch。
- 性能：单来源、多来源、并发查询、共享 client 排队和 batch 前后 P50/P95。

## 9. 灰度与回滚

迁移期间使用显式模式：

```text
rag_engine = legacy | batch_shadow | batch | ts_rank_shadow | ts_rank | ts_full
```

- `legacy`：当前生产路径。
- `batch_shadow`：执行 batch 但交付旧路径结果。
- `batch`：只切换批量词法召回。
- `ts_rank_shadow`：比较 TS 排序但交付旧结果。
- `ts_rank`：切换 TS 排序。
- `ts_full`：切换完成阶段的统一 TS 检索链路。

任一阶段出现结果差异、权限异常、引用缺失、索引 revision 错乱或 P95 回退，立即回到上一阶段模式。回滚必须保留 TS 诊断和失败原因，不能用空结果或静默 fallback 掩盖问题。

## 10. 责任边界

| 责任 | 归属 |
|---|---|
| 业务数据读取 | Python Adapter / Service |
| 用户和 workspace 权限事实 | Python |
| Scope 初筛与最终复核 | Python |
| tokenizer、词法索引、BM25 | TypeScript Worker |
| 候选归一化、去重、来源限制、预算 | Phase 2 起由 TypeScript Worker 负责 |
| embedding 生成 | Python，Phase 3 前保持不变 |
| embedding 融合 | Phase 3 起由 TypeScript Worker 负责 |
| revision、patch、持久化索引 | Phase 4 起由 TypeScript Worker 负责 |
| Agent history/context 注入 | Python |
| 诊断和灰度模式 | Python 编排 + TS 结构化返回 |

## 11. 交付标准

- 每个 Phase 有独立协议、实现、测试和性能基线。
- 不允许以“代码路径已调用 TS”作为完成标准，必须验证候选语义和权限边界。
- 生产切换前必须完成冷启动、warm cache、重启、失败和多用户隔离测试。
- 完成 Phase 5 后，Python 不再保留被替代的 BM25、评分、来源排序和重复 sidecar 调度逻辑。
- 所有迁移阶段的详细结果写入 `docs/devlog/`，PRD 只维护范围、状态和验收结论。
