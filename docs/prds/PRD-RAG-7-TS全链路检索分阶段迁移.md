# PRD-RAG-7：RAG 全链路 TypeScript 化分阶段迁移

## 1. 状态

**状态：实施中（2026-09-09）。Phase 0 已补召回生命周期观测；Phase 1 已实现持久化来源批量查询实验路径，尚未完成全部来源及端到端验收，不能标记阶段完成。**

本次实施记录见 [Phase 0/1 实施进度与验证](../devlog/2026-09-09-RAG批量召回实施进度.md)。Phase 0/1 已完成并通过 devserver 验收：`search.rag_query_mode` 默认仍为 `legacy`，可选 `batch`（一次批量词法查询，Memory 装入 worker 瞬态语料槽）与 `batch_shadow`（交付 legacy 结果并记录候选差异）。是否切换默认模式留待产品决策，切换前建议先在生产开启 `batch_shadow` 观察一段 shadow_equal 统计。

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
note         → sidecar search
```

Python 侧通过 `asyncio.gather()` 并发发起查询，但同一用户复用一个 `TsSidecarClient`，客户端内部仍使用单锁保护 JSONL 请求。因此后发查询会等待前一个请求完成，当前 `sidecar_search_ms` 可能同时包含排队等待和实际查询时间。

现有 TypeScript Worker 已经具备 `unified_search`、BM25、来源过滤、scope 过滤、候选排序、去重和字符预算能力，但直接切换到该接口会改变现有 Python 的 embedding/hybrid、权限复核、会话水位和结果注入语义。因此本项目采用分阶段迁移，每阶段都必须保留可回退路径和行为回归。

### 2.1 已有能力与本次问题

- 生产词法后端固定为 TypeScript；`rank_candidates_with_cache()` 已调用 TS 完成候选评分和过滤。Phase 2 是契约校准与统一接入，不重复实现评分器。
- TS client 已有 `build_documents`、`build_and_index`、`replace`、`patch` 和持久化恢复能力。Phase 4 仍需验证各来源更新事件覆盖和 revision 生命周期，不能只按接口存在判定完成。
- 自动召回受 `rag_auto_sources` 控制，并非每次都查询全部七个来源；启用来源通过 `asyncio.gather()` 汇合，同一用户的 sidecar 请求在客户端锁上排队。
- 自动召回当前总等待预算为 3 秒。超时后内部任务通过 `shield` 继续收尾，本轮不注入结果；TS 默认 500ms 是单次响应等待上限，不包含完整召回的 DB、排队和启动成本。
- LoopScope 当前在查询完成后才创建 RAG span；超时返回的 `scope_hits` 没有进入诊断链。后台完成晚于 run 结束时，完成记录也会被跳过。
- 当前存在每来源重复统计文档数量、部分路径重复读取 revision，以及 snapshot 缓存未命中时加载完整索引文档的开销。串行排队是已确认的结构问题，但本次超时的主要耗时来源尚未通过运行时 trace 确认。

本轮优先交付 Phase 0/1，性能修复不依赖 Phase 3–5 全部完成。旧版本热路径低于 500ms 的用户观察作为待复测目标，不作为已验证基线。

## 3. 目标

1. 将多个来源的 sidecar 查询合并为一次 TypeScript batch search，消除同一请求内的重复 tokenize、IPC 和排队等待。
2. 复用已有 TS BM25 与评分能力，收敛重复调度、来源过滤、字符预算和最终排序协议。
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

目标架构区分两个流程：业务变更事件驱动 Python 提交授权 source batch，由 TS 增量维护索引；用户查询提交 query、scope、来源、消息水位和预算，查询已构建索引。Phase 1 保留独立排序请求，Phase 5 再收敛为统一查询。索引不可用必须显式记录原因，重建属于更新流程，不能成为每轮隐式全量工作。

## 6. 分阶段方案

### Phase 0：基线、协议和诊断冻结

目标：在改变查询形态前锁定当前行为。

- [x] 记录同一 query、scope、revision 下各来源候选 ID、分数、排序和最终注入结果。
- [x] 固定 `search_ms`、`sidecar_search_ms`、`sidecar_queue_wait_ms`、`sidecar_query_ms` 的定义。
- [x] 将 `sidecar_reused=null` 明确定义为“本轮未执行复用检查”。
- [x] 建立冷启动、索引重建、warm cache、worker 重启和查询失败基线。
- [x] 确认当前 `unified_search` 与 Python 编排的 TS `rank_candidates` 链路的语义差异，禁止直接替换。
- [x] 自动召回开始时创建 span，在成功、异常、超时和取消出口结束；记录预算、实际耗时、未完成来源与当前阶段、`injected`、后台任务数量和明确原因。
- [x] 超时后的后台完成不得把本轮 `injected=false` 改成成功注入，不重复产生成功 span；收尾异常可诊断，关联已结束 run 的事件不依赖修改已提交快照。
- [x] 区分外层预算超时、sidecar 请求超时、任务数量上限、取消和内部异常；普通日志只记录安全关联 ID、阶段和错误类别。
- [x] 各来源进度在完成前可读取；补齐 `document_count`、`cache_miss_reason` 和 `source_diagnostics` 的完整传递，未知数量不得冒充零。

验收：同一 fixture 可以重复生成当前主链的候选和诊断基线；注入慢来源、worker 超时和取消时均能在 LoopScope 看到关联记录和原因。修正包含 DB 统计耗时的 sidecar 指标，确保耗时归属准确。

### Phase 1：Batch Lexical Search

目标：一次 sidecar 请求完成多个来源的词法召回，保留当前 Python 编排及 TS 最终排序契约。

```text
Python 加载文档并完成权限初筛
        ↓
TS 一次 tokenize + 一次索引扫描
        ↓
按 source_type 返回候选和来源诊断
        ↓
Python 保留 embedding/hybrid、TS rank 调度、权限复核和上下文注入
```

- [x] 在 `backend/ts/packages/contracts/src/rag.ts` 新增 `batch_search` 请求/响应契约。
- [x] Worker 一次计算 query tokens，并按来源返回候选结果。
- [x] 保留每个来源的 `candidate_count`、`eligible_count`、`elapsed_ms`。
- [x] Python `TsSidecarClient`、`TsLexicalIndex` 和 `index_cache` 增加 batch API。
- [x] `UnifiedRetriever` 改为一次 batch 请求，不再对每个来源单独调用 sidecar。
- [x] 保持 `UnifiedRecallService` 的 hybrid、权限、引用和最终排序不变。
- [x] 每次召回只准备一次所需索引和版本；去掉每来源重复的 revision 查询及全量文档数量读取，数量来自版本一致的索引元数据。
- [x] 批量查询保持各来源独立候选额度及 scope，不用全局 top-K 替代来源召回；保持 Memory snapshot 去重和 conversation 消息水位语义。
- [x] 检查 snapshot 缓存锁内二次命中，避免多个首次请求等待锁后重复读取索引正文；以调用计数回归验证。
- [x] 增加 batch 与旧多请求路径的 shadow 对比，但不把 shadow 结果交付给用户。

验收：候选 ID 集合、分数及最终排序与基线一致；词法查询 IPC 由 N 次降为 1 次，排序请求单独计数；不存在权限扩大。devserver 固定数据集、来源、revision 和并发度，分别测冷/热 P50、P95；热路径端到端 P95 目标 ≤500ms，包含准备、排队、检索、排序与注入，不通过提高 3 秒预算替代性能验收。

验证记录（2026-09-09，真实账号 4063 chunk / 7 来源）：持久化来源（canvas/conversation/file/knowledge/note/project）同帧 shadow 对比候选 ID 与分数 18/18 完全一致；batch 热路径 P50 38ms / P95 59ms（legacy 157/236ms），并发 P95 369ms（legacy 1636ms），冷 1384ms（legacy 2115ms）。Memory 来源的 legacy 基线受 replace-churn 影响（worker 唯一持久槽被各来源并发覆盖，BM25 语料不确定），shadow 显示不一致属于 legacy 侧缺陷；batch 侧 Memory 装入独立瞬态语料槽，协议测试证明其分数与独立 memory 索引完全一致。详见实施进度文档。

### Phase 2：TS 统一候选排序

目标：复用已有 TS 评分器，校准批量候选接入后的归一化、来源质量、去重、父节点限制、来源上限和字符预算契约。

- [ ] 审计已有 `rank_candidates_with_cache()` 与 TS 协议映射，补齐缺失契约，不新增第二套评分实现。
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
- [ ] 区分用户索引 revision 与会话 snapshot；保留已注入 canonical 上下文的稳定性，避免为每个 snapshot 复制完整检索索引。跨版本查询一致性必须有明确契约。
- [ ] 查询阶段只访问已构建索引；缺失或损坏的索引显式报告并调度重建，更新事件具备失败重试和可观测状态。

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
| `worker_start_ms` | worker 启动和探活耗时，与实际搜索分开记录 |
| `index_prepare_ms` | 本次统一索引准备总耗时，含版本读取、锁等待和恢复 |
| `injection_ms` | 最终结果转换并合并到上下文的耗时 |
| `total_ms` | 自动召回开始到成功、异常或超时返回的总耗时 |

失败诊断同时包含 `reason`、`stage`、`timeout_ms`、`pending_sources` 和 `injected`。来源统计包含 `document_count`、`cache_miss_reason`；未完成阶段记录进度及已用时间，不伪造完成耗时。索引计数不能混入 `sidecar_search_ms`。查询和锁排队、worker 启动的计时边界必须独立，避免重复累加。

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
- 观测：外层超时、worker 失败、取消、后台迟到完成及 run 已结束时，RAG span 的状态、原因和注入标记正确。
- 热路径：验证索引准备次数、词法 IPC 次数、DB 查询次数，防止诊断统计重新引入全量读取。

## 9. 灰度与回滚

迁移期间使用显式模式：

以下为迁移概念状态，不代表当前已实现配置。实施时根据现有 TS 排序能力精简为必要模式，不为已经落地的能力重复增加开关；shadow 对比独立统计额外成本，不计入正式热路径性能结果。

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
| 候选归一化、去重、来源限制、预算 | 已由 TS 评分器执行；Phase 2 校准统一契约 |
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
